import logging
import json
from typing import List, Dict, Any
import gspread
from oauth2client.service_account import ServiceAccountCredentials
from domain.models import HealthMetrics, PredictionResult
from ports.interfaces import StoragePort

# Define headers for Google Sheets mapping
HEADERS = [
    "Timestamp", 
    "HRV (ms)", 
    "RHR (bpm)", 
    "Respiration (br/m)", 
    "Sleep Score", 
    "AI Prediction", 
    "Confidence", 
    "Reasoning", 
    "User Label"
]

class GoogleSheetsAdapter(StoragePort):
    """
    Adapter that leverages Google Sheets (via gspread) as both a 
    persistent time-series schema database and interactive user feedback console.
    """
    def __init__(self, service_account_json_str: str, sheet_id: str):
        self.credentials_str = service_account_json_str
        self.sheet_id = sheet_id
        self.client = None
        self.sheet = None

    def _connect(self):
        if self.client:
            return

        logging.info("Connecting to Google Sheets using Service Account Credentials...")
        scope = ['https://spreadsheets.google.com/feeds', 'https://www.googleapis.com/auth/drive']
        try:
            creds_dict = json.loads(self.credentials_str)
            creds = ServiceAccountCredentials.from_json_keyfile_dict(creds_dict, scope)
            self.client = gspread.authorize(creds)
            # Open by ID or by name
            self.sheet = self.client.open_by_key(self.sheet_id).sheet1
            logging.info("Google Sheets connection established successfully!")
        except Exception as e:
            raise RuntimeError(f"Could not authenticate with Google Sheets: {e}")

    def get_history(self, n_days: int = 30) -> List[dict]:
        self._connect()
        try:
            records = self.sheet.get_all_records()
            if not records:
                return []
            
            # Grab the last N entries of recorded health rows
            history_rows = records[-n_days:]
            
            # Map gspread records format to a normalized structured dictionary for Gemini feeding
            mapped_history = []
            for row in history_rows:
                mapped_history.append({
                    "timestamp": row.get("Timestamp", ""),
                    "hrv": row.get("HRV (ms)", 0),
                    "rhr": row.get("RHR (bpm)", 0),
                    "respiration": row.get("Respiration (br/m)", 0.0),
                    "sleepScore": row.get("Sleep Score", None),
                    "prediction": row.get("AI Prediction", ""),
                    "confidence": row.get("Confidence", 0),
                    "reasoning": row.get("Reasoning", ""),
                    "userLabel": row.get("User Label", "PENDING")
                })
            return mapped_history
        except Exception as e:
            logging.error(f"Failed to fetch historical record logs out of Sheet: {e}")
            return []

    def save_entry(self, metrics: HealthMetrics, prediction: PredictionResult, user_label: str = "PENDING") -> None:
        self._connect()
        try:
            # Check if headers exist, if sheet is brand-new/empty write headers
            values = self.sheet.get_all_values()
            if not values:
                self.sheet.append_row(HEADERS)
                logging.info("New sheet initialized. Headers injected.")

            # Compose matching row values
            row_data = [
                metrics.timestamp.isoformat(),
                metrics.hrv,
                metrics.rhr,
                metrics.respiration,
                metrics.sleep_score if metrics.sleep_score is not None else "",
                prediction.classification,
                f"{prediction.confidence}%",
                prediction.reasoning,
                user_label # Set to "PENDING" to highlight in conditional formatting for manual feedback
            ]
            
            self.sheet.append_row(row_data)
            logging.info(f"Successfully saved clinical row to Sheet database. Label set directly to: {user_label}")
        except Exception as e:
            logging.error(f"Failed to write current day metrics sequence to Sheet: {e}")
            raise e
