# Bio-Sentinel RLHF: Hexagonal Garmin Health Monitor

Bio-Sentinel is a hexagonal-structured, automation-first Python telemetry pipeline designed to analyze sleep-derived clinical biometrics from your Garmin wearable. By integrating **Reinforcement Learning from Human Feedback (RLHF)** through Google Sheets, it continually trains Google Gemini to distinguish true illness incubation from daily lifestyle "noise" (like alcohol, late meals, high-intensity training, or stress).

The script runs on a regular scheduler via **GitHub Actions** (every 6 hours) and uses **Google Sheets** as both its historical persistence layer and its mobile-friendly user inputs dashboard.

---

## 🔑 Required API Keys & Secrets Configuration

To run Bio-Sentinel autonomously on GitHub Actions, you must configure **five secrets** in your GitHub Repository settings (**Settings** ➔ **Secrets and variables** ➔ **Actions** ➔ **New repository secret**).

Here is the step-by-step setup guide for each dependency:

### 1. Garmin Connect Authentication
To bypass Multi-Factor Authentication (MFA) on cold-start runner instances, Bio-Sentinel supports persistent session tokens.
* **Option A: Core Credentials (Regular Auth)**
  * `GARMIN_EMAIL`: Your Garmin Connect account email.
  * `GARMIN_PASSWORD`: Your Garmin Connect account password.
* **Option B: Persistent Session Token (Highly Recommended to bypass MFA limitations)**
  * To bypass MFA safely, you can use the interactive CLI helper script included in this repository. Run it locally once from your computer's terminal:
    ```bash
    pip install python-garminconnect garth
    python get_garmin_session.py
    ```
  * Follow the terminal prompts. It will ask for your email, password, and guide you through entering the MFA authentication code.
  * It will then generate a single, clean **Base64 encoded block string**. Copy that text block.
  * Save the copied string in GitHub Secrets as `GARMIN_SESSION`. 
  * If `GARMIN_SESSION` is detected, the workflow will use it directly to bypass any authentication steps and MFA queries on headless runner containers!

---

### 2. Google Sheets API (GSuite/Service Account)
Your script uses standard `gspread` to write data and read your manual labels.
1. Go to the **[Google Cloud Console](https://console.cloud.google.com/)**.
2. Create or select a project.
3. Enable the **Google Sheets API** and **Google Drive API** in your project's dashboard.
4. Go to **IAM & Admin** ➔ **Service Accounts** and click **Create Service Account**.
5. Give it a name, click **Done**, and select the service account you created.
6. Under the **Keys** tab, click **Add Key** ➔ **Create new key**, and choose **JSON**.
7. Download this JSON file. It contains the private keys used to access your sheets.
8. **Encode & Save Secrets:**
   * Open the JSON file in a text editor, copy the entire raw JSON text, and save it in GitHub Secrets as `GOOGLE_CREDS`.
9. **Share the Sheet with the Bot:**
   * Open the JSON key and look for the `"client_email"` key (e.g., `sentinel-bot@project.iam.gserviceaccount.com`).
   * Create a new Google Sheet on your drive, and click **Share** at the top right.
   * Paste that service account email address, give it **Editor** permissions, and save.
10. **Extract Spreadsheet ID:**
    * In your browser, copy the unique sheet identifier from the URL:
      `https://docs.google.com/spreadsheets/d/[THIS_LONG_ID_IS_YOUR_SHEET_ID]/edit#gid=0`
    * Store this ID in GitHub Secrets as `SHEET_ID`.

---

### 3. Google Gemini API Key (AI Studio)
1. Navigate to **[Google AI Studio](https://aistudio.google.com/)**.
2. Create and generate a free-tier API key.
3. Store this secret in GitHub Secrets as `GEMINI_KEY` (or `GEMINI_API_KEY`).

---

## 📋 Full Environment Secrets Matrix

Map these exactly into your GitHub secrets configuration:

| Secret Name | Description | Example / Format |
| :--- | :--- | :--- |
| `GARMIN_EMAIL` | Garmin login address | `user@example.com` |
| `GARMIN_PASSWORD` | Garmin account password | `YourGarminSecurePassword123` |
| `GARMIN_SESSION` | Base64-encoded session JSON token | `eyJhY2Nlc3NfdG9rZW4iOi...` |
| `GOOGLE_CREDS` | Full contents of Service Account JSON file | `{"type": "service_account", "project_id": ...}` |
| `GEMINI_KEY` | Gemini API connection key | `AIzaSyB-YourGeminiAPIKeyHere...` |
| `SHEET_ID` | Google Sheet string ID | `1aBCd_EfGhiJkl-MnOPrsTuvwxyz12345` |

---

## 🛠️ Step-by-Step GitHub Actions Deployment

Once the secrets are filled in:
1. Push this workspace code to your private/public GitHub repository.
2. The scheduler configuration is already defined in `.github/workflows/sentinel.yml`.
3. Go to the **Actions** tab inside your GitHub repository.
4. Select the **Bio-Sentinel RLHF Engine Scheduled Pipeline** list.
5. Click **Run workflow** to test-run the script manually. The runner will boot, load your credentials, fetch your health telemetry metrics, consult your in-sheet labeled training columns, query Gemini, and update your interactive dashboard instantly!

---

## ✨ Setting up Conditional Color Formatting in Google Sheets
To make the sheet function as your interactive user interface, configure a custom formatting alert:
1. In your sheet, select the entire **User Label** column (commonly Col I / Column 9).
2. Go to **Format** ➔ **Conditional formatting**.
3. Under *Format Rules*, set *Format cells if...* to **Text starts with / Text is exactly** ➔ **`PENDING`**.
4. Set the formatting style to have a **Soft Red Background** with **Dark Red Text**.
5. When Gemini predicts health deviations, or when the confidence is borderline alert, it writes `PENDING` to the column. 
6. This highlights the cell in red, signaling you to change the dropdown to a specific feedback label (e.g., `Sickness`, `Alcohol`, `Late Food`, or `Normal`) to retrain your private RLHF loop!
