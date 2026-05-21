from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Optional, Dict, Any

@dataclass
class HealthMetrics:
    timestamp: datetime
    hrv: int               # Heart Rate Variability in ms
    rhr: int               # Resting Heart Rate in bpm
    respiration: float     # Respiration Rate in breaths/min
    sleep_score: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d['timestamp'] = self.timestamp.isoformat()
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "HealthMetrics":
        ts = datetime.fromisoformat(data['timestamp']) if isinstance(data['timestamp'], str) else data['timestamp']
        return cls(
            timestamp=ts,
            hrv=int(data['hrv']),
            rhr=int(data['rhr']),
            respiration=float(data['respiration']),
            sleep_score=data.get('sleep_score')
        )

@dataclass
class PredictionResult:
    classification: str     # "SICKNESS", "NOISE", or "PENDING"
    confidence: int         # Percentage 0-100
    reasoning: str          # Contextual feedback explanation
    timestamp: datetime

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d['timestamp'] = self.timestamp.isoformat()
        return d
