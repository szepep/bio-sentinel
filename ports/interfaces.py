from abc import ABC, abstractmethod
from typing import List, Optional
from domain.models import HealthMetrics, PredictionResult

class MetricsPort(ABC):
    """
    Port interface to fetch homeostatic metrics from Garmin Connect.
    """
    @abstractmethod
    def fetch_latest_metrics(self) -> HealthMetrics:
        """
        Retrieves clinical grade metrics (HRV, RHR, Respiration) for the current day.
        """
        pass

class StoragePort(ABC):
    """
    Port interface to communicate with Google Sheets persistent storage.
    """
    @abstractmethod
    def get_history(self, n_days: int = 30) -> List[dict]:
        """
        Loads the last N rows/days of record history.
        This includes previous metrics, predictions, and manual user labels for RLHF.
        """
        pass

    @abstractmethod
    def save_entry(self, metrics: HealthMetrics, prediction: PredictionResult, user_label: str = "PENDING") -> None:
        """
        Appends a new metrics entry + AI prediction to the Google Sheet database.
        """
        pass

class IntelligencePort(ABC):
    """
    Port interface to run AI inference using Gemini 1.5/3.5 models.
    """
    @abstractmethod
    def analyze_data(self, current: HealthMetrics, history: List[dict]) -> PredictionResult:
        """
        Prompt the AI to classify metrics as SICKNESS or NOISE, conditioning on history.
        """
        pass
