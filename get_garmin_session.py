#!/usr/bin/env python3
import os
import sys
import json
import base64
import tempfile
import getpass
import shutil

print("=================================================================")
print("  Bio-Sentinel Garmin Connect Session Extractor Tool")
print("=================================================================")
print("Use this local script to log in once to your Garmin Connect account,")
print("solve MFA checks securely, serialize your active tokens, and convert")
print("them to a Base64 string to bypass MFA on headless GitHub runners.")
print("=================================================================\n")

try:
    from garminconnect import Garmin
    import garth
except ImportError:
    print("Error: Missing required packages.")
    print("Please install them using: pip install python-garminconnect garth")
    sys.exit(1)

# Prompt for credentials safely
email = input("Garmin Connect Email: ").strip()
if not email:
    print("Error: Email cannot be empty.")
    sys.exit(1)

password = getpass.getpass("Garmin Connect Password: ").strip()
if not password:
    print("Error: Password cannot be empty.")
    sys.exit(1)

# Create a clean temporary directory to save the authentication state files
temp_dir = tempfile.mkdtemp()

try:
    print("\nAttempting first-time authentication...")
    print("Note: If multi-factor authentication (MFA) is active on your account,")
    print("you will see a terminal prompt shortly asking you to enter the SMS or Email code.")
    
    # Configure garth state directory
    garth.configure(state_dir=temp_dir)
    
    # Initialize Garmin-Connect client
    client = Garmin(email, password)
    client.login()
    
    # Force saving the garth tokens manually, just in case
    client.garth.save(temp_dir)
    print("\n✔ Authentication successful! Authorized tokens fetched.")
    
    # Map and load files recorded into dictionary payload
    payload = {}
    for filename in os.listdir(temp_dir):
        file_path = os.path.join(temp_dir, filename)
        if os.path.isfile(file_path) and filename.endswith('.json'):
            with open(file_path, 'r', encoding='utf-8') as f:
                try:
                    payload[filename] = json.load(f)
                except json.JSONDecodeError:
                    f.seek(0)
                    payload[filename] = f.read()

    if not payload:
        raise RuntimeError("No Garth authentication token files were logged. Try again.")

    # Base64 serialize dict
    json_bytes = json.dumps(payload).encode('utf-8')
    b64_string = base64.b64encode(json_bytes).decode('utf-8')
    
    print("\n" + "="*80)
    print("🔑 YOUR GARMIN_SESSION BASE64 TOKEN (COPY EVERYTHING BELOW THIS LINE):")
    print("="*80)
    print(b64_string)
    print("="*80)
    print("\nInstructions:")
    print("1. Go to your GitHub repository Settings -> Secrets and variables -> Actions.")
    print("2. Create a new repository secret with Name: GARMIN_SESSION")
    print("3. Paste the entire bulk string printed above into the secret Value field.")
    print("This will bypass MFA completely of your subsequent scheduled pipelines!")
    print("=================================================================\n")

except Exception as e:
    print(f"\n❌ Login process failed: {e}")
    sys.exit(1)
finally:
    # Clean up temporary storage directories
    shutil.rmtree(temp_dir)
