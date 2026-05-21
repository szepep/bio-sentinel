import os
import sys
import logging
from adapters.garmin import GarminAdapter
from adapters.google_sheets import GoogleSheetsAdapter
from adapters.gemini import GeminiAdapter
from services.orchestrator import Orchestrator

# Configure structured logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)

def run():
    # Load settings from environment variables (GHA Secrets)
    garmin_email = os.environ.get("GARMIN_EMAIL")
    garmin_password = os.environ.get("GARMIN_PASSWORD")
    garmin_session = os.environ.get("GARMIN_SESSION") # Base64 session string
    google_creds = os.environ.get("GOOGLE_CREDS") # Base64 or directly inline JSON
    gemini_key = os.environ.get("GEMINI_KEY") or os.environ.get("GEMINI_API_KEY")
    sheet_id = os.environ.get("SHEET_ID")

    # Fast validation checks
    missing_vars = []
    if not garmin_email and not garmin_session:
        missing_vars.append("GARMIN_EMAIL or GARMIN_SESSION")
    if not google_creds:
        missing_vars.append("GOOGLE_CREDS")
    if not gemini_key:
        missing_vars.append("GEMINI_KEY (or GEMINI_API_KEY)")
    if not sheet_id:
        missing_vars.append("SHEET_ID")

    if missing_vars:
        logging.error(f"Missing mandatory environment secrets: {', '.join(missing_vars)}")
        logging.error("Make sure to map all Secrets in your GitHub Actions settings panel!")
        sys.exit(1)

    # Initialize hexagonal concrete adapters (Dependency Injection)
    garmin_adapter = GarminAdapter(
        email=garmin_email or "",
        password=garmin_password or "",
        session_data_b64=garmin_session
    )

    sheets_adapter = GoogleSheetsAdapter(
        service_account_json_str=google_creds,
        sheet_id=sheet_id
    )

    gemini_adapter = GeminiAdapter(
        api_key=gemini_key,
        model_name="gemini-3.5-flash"
    )

    # Inject adapters into Orchestrator Service
    orchestrator = Orchestrator(
        metrics=garmin_adapter,
        storage=sheets_adapter,
        intelligence=gemini_adapter
    )

    # Trigger complete clinical analysis workflow
    try:
        results = orchestrator.execute_pipeline(history_days=30)
        logging.info("Bio-Sentinel cycle completed successfully!")
        print(f"STATUS_REPORT: Success. Prediction classified as {results['prediction']['classification']}.")
    except Exception as e:
        logging.error(f"Sentinal pipeline execution failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    run()
