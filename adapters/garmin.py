import base64
import json
import logging
from datetime import datetime, date
from typing import Optional
from garminconnect import Garmin
from domain.models import HealthMetrics
from ports.interfaces import MetricsPort

class GarminAdapter(MetricsPort):
    """
    Adapter that connects to Garmin API to fetch wearable clinical-grade metrics.
    Implements Session-token persistence for MFA bypass.
    """
    def __init__(self, email: str, password: str, session_data_b64: Optional[str] = None):
        self.email = email
        self.password = password
        self.session_data_b64 = session_data_b64
        self.client = None

    def _login(self):
        logging.info("Initializing Garmin Connect Client...")
        
        # If we have a base64 encoded session token, we try to load/bypass MFA
        if self.session_data_b64:
            try:
                logging.info("Attempting to restore session from Base64 String...")
                session_json = base64.b64decode(self.session_data_b64).decode('utf-8')
                token_dict = json.loads(session_json)
                
                # Re-hydrate the Garmin client with existing session
                self.client = Garmin()
                self.client.login_data = token_dict
                self.client.is_logged_in = True
                logging.info("Garmin session restored successfully!")
                return
            except Exception as e:
                logging.warning(f"Failed to restore Garmin session from token: {e}. Falling back to standard credentials.")

        # Fallback to standard login
        try:
            self.client = Garmin(self.email, self.password)
            self.client.login()
            logging.info("Garmin client logged in using username and password.")
        except Exception as e:
            raise RuntimeError(f"Could not log in to Garmin Connect: {e}")

    def fetch_latest_metrics(self) -> HealthMetrics:
        if not self.client:
            self._login()
            
        today_str = date.today().isoformat()
        logging.info(f"Fetching Garmin metrics for date: {today_str}")

        # Fetch sleep metrics
        try:
            sleep_data = self.client.get_sleep_data(today_str)
            # Fetch resting heart rate or general body stats
            stats = self.client.get_stats(today_str)
            # Fetch HRV details
            hrv_data = self.client.get_hrv_data(today_str)
        except Exception as e:
            logging.error(f"Error fetching raw Garmin data stream: {e}")
            raise RuntimeError(f"Garmin data fetch failure: {e}")

        # Extract metrics safely from deep payloads
        hrv_value = 50  # Default fallback if unavailable
        if hrv_data and 'hrvSummary' in hrv_data:
            hrv_value = hrv_data['hrvSummary'].get('weeklyDb', hrv_value)
            # Try last night's average hrv
            hrv_value = hrv_data['hrvSummary'].get('lastNightAvg', hrv_value)

        rhr_value = 60  # Default fallback if unavailable
        if stats:
            # Stats lists stats by container list, look for restingHeartRate
            rhr_value = stats.get('restingHeartRate', rhr_value)

        resp_value = 14.5  # Default baseline sleep breathing rate
        if sleep_data:
            # Respiration is normally recorded within the sleepSummary
            summary = sleep_data.get('sleepSummary', {})
            resp_value = summary.get('averageRespiration', resp_value)

        sleep_score = None
        if sleep_data:
            sleep_score = sleep_data.get('dailySleepDTO', {}).get('sleepScore')

        logging.info(f"Garmin Metrics resolved: HRV={hrv_value}ms, RHR={rhr_value}bpm, Respiration={resp_value} breaths/min")
        
        return HealthMetrics(
            timestamp=datetime.now(),
            hrv=int(hrv_value),
            rhr=int(rhr_value),
            respiration=float(resp_value),
            sleep_score=sleep_score
        )
