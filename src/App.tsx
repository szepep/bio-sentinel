import React, { useState, useEffect } from 'react';
import { 
  Heart, 
  Activity, 
  RotateCcw, 
  Send, 
  Settings, 
  Sliders, 
  Code, 
  Database, 
  Github, 
  CheckCircle2, 
  AlertCircle, 
  HelpCircle,
  FileText,
  Play,
  Lock,
  History,
  TrendingDown,
  Plus,
  Trash2,
  RefreshCw
} from 'lucide-react';

// Define the absolute content of the Python files for interactive code viewing
const PYTHON_CODES = {
  models: `from dataclasses import dataclass, asdict
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
        return d`,

  interfaces: `from abc import ABC, abstractmethod
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
        pass`,

  garmin: `import base64
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
            stats = self.client.get_stats(today_str)
            hrv_data = self.client.get_hrv_data(today_str)
        except Exception as e:
            logging.error(f"Error fetching raw Garmin data stream: {e}")
            raise RuntimeError(f"Garmin data fetch failure: {e}")

        # Extract metrics safely from deep payloads
        hrv_value = 50  # Default fallback if unavailable
        if hrv_data and 'hrvSummary' in hrv_data:
            hrv_value = hrv_data['hrvSummary'].get('weeklyDb', hrv_value)
            hrv_value = hrv_data['hrvSummary'].get('lastNightAvg', hrv_value)

        rhr_value = 60  # Default fallback if unavailable
        if stats:
            rhr_value = stats.get('restingHeartRate', rhr_value)

        resp_value = 14.5  # Default baseline sleep breathing rate
        if sleep_data:
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
        )`,

  sheets: `import logging
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
            
            history_rows = records[-n_days:]
            
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
            values = self.sheet.get_all_values()
            if not values:
                self.sheet.append_row(HEADERS)
                logging.info("New sheet initialized. Headers injected.")

            row_data = [
                metrics.timestamp.isoformat(),
                metrics.hrv,
                metrics.rhr,
                metrics.respiration,
                metrics.sleep_score if metrics.sleep_score is not None else "",
                prediction.classification,
                f"{prediction.confidence}%",
                prediction.reasoning,
                user_label
            ]
            
            self.sheet.append_row(row_data)
            logging.info(f"Successfully saved clinical row to Sheet database. Label set directly to: {user_label}")
        except Exception as e:
            logging.error(f"Failed to write current day metrics sequence to Sheet: {e}")
            raise e`,

  gemini: `import os
import logging
import json
from datetime import datetime
from typing import List, Dict, Any
from google import genai
from google.genai import types
from domain.models import HealthMetrics, PredictionResult
from ports.interfaces import IntelligencePort

class GeminiAdapter(IntelligencePort):
    """
    Adapter that connects to Google Gemini via the modern google-genai SDK
    to run few-shot cognitive analysis on homeostatic wearable metrics.
    """
    def __init__(self, api_key: str, model_name: str = "gemini-3.5-flash"):
        self.api_key = api_key
        self.model_name = model_name
        self.client = None

    def _init_client(self):
        if self.client:
            return
        logging.info("Initializing Google GenAI client...")
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY environment variable is blank or missing. Please set it.")
        self.client = genai.Client(api_key=self.api_key)

    def analyze_data(self, current: HealthMetrics, history: List[dict]) -> PredictionResult:
        self._init_client()

        history_blocks = []
        if history:
            for entry in history:
                label = entry.get("userLabel") or entry.get("user_label") or "PENDING"
                if not label:
                    label = "PENDING"
                
                history_blocks.append(
                    f"- Metric Baseline Record:\\n"
                    f"  HRV: {entry.get('hrv')} ms, RHR: {entry.get('rhr')} bpm, Respiration: {entry.get('respiration')} br/m\\n"
                    f"  AI's Historical Classification: {entry.get('prediction', 'N/A')}\\n"
                    f"  User's Confirmed Manual Feedback (TRUE LABEL): {label}"
                )
            history_prompt = "\\n\\n".join(history_blocks)
        else:
            history_prompt = "No prior user-labeled historical cycles records exist yet."

        prompt = f"""You are the Bio-Sentinel RLHF Analysis Engine.
Your specialized medical-grade task is to evaluate a user's sleep clinical metrics (HRV, RHR, Respiration) and predict physiological status.
Specifically, you must distinguish incubation of "SICKNESS" from ordianary lifestyle "NOISE" (such as alcohol, vigorous exercise late, sleep deprivation, or late food).

### COGNITIVE INSTRUCTIONS:
1. **Core Heuristics**:
   - Severe Drop in HRV (Parasympathetic strain) + Spike in RHR (sympathetic load) is indicative of physiological stress.
   - Respiration rate is highly stable. Any deviation of +1.5 to +3 breaths/min above baseline sleep rate strongly suggests incubation of a viral/bacterial sickness.
2. **Reinforcement Learning from Human Feedback (RLHF)**:
   - You must prioritize the historical user labels over raw heuristics. 
   - Analyze the "Confirmed Manual Feedback" labels in the history.
   - **Crucial Rule**: If the current metrics' relative deviation looks severe (which typically triggers "SICKNESS"), but the historical few-shot records demonstrate that this user has labeled extremely similar drops/spikes as "Noise (Late Food)" or "Noise (Alcohol)", you MUST respect the human's label and classify this as "NOISE".

### FEW-SHOT USER-LABELED HISTORICAL SAMPLES:
{history_prompt}

### CURRENT PHYSIOLOGICAL RAW DATA:
- Average Sleep HRV: {current.hrv} ms
- Sleeping Resting Heart Rate (RHR): {current.rhr} bpm
- Sleep Respiration: {current.respiration} breaths/min
- Sleep Score: {current.sleep_score or 'Unavailable'}

### RESPONSE FORMAT PREFERENCE:
Evaluate current raw values relative to history. Return a JSON object with this precise layout:
{{
  "classification": "SICKNESS" or "NOISE" or "PENDING",
  "confidence": <integer representing percentage from 0 to 100>,
  "reasoning": "<provide a concise explanation referencing the few-shot historical samples if they matched or helped distinguish this threshold>"
}}
"""

        logging.info("Requesting analysis classification decision from Gemini...")
        
        try:
            response = self.client.models.generate_content(
                model=self.model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=types.Schema(
                        type=types.Type.OBJECT,
                        required=["classification", "confidence", "reasoning"],
                        properties={
                            "classification": types.Schema(
                                type=types.Type.STRING,
                                description="Final classification decision. Must be SICKNESS, NOISE, or PENDING"
                            ),
                            "confidence": types.Schema(
                                type=types.Type.INTEGER,
                                description="Inference classification percentage confidence (0-100)"
                            ),
                            "reasoning": types.Schema(
                                type=types.Type.STRING,
                                description="Deep summary of how RLHF pattern logic resolved this case."
                            )
                        }
                    )
                )
            )

            result_json = json.loads(response.text)
            classification = result_json.get("classification", "PENDING").upper()
            confidence = int(result_json.get("confidence", 70))
            reasoning = result_json.get("reasoning", "Metrics fall within borderline bands.")

            if classification not in ["SICKNESS", "NOISE", "PENDING"]:
                classification = "PENDING"

            return PredictionResult(
                classification=classification,
                confidence=confidence,
                reasoning=reasoning,
                timestamp=datetime.now()
            )
            
        except Exception as e:
            logging.error(f"Gemini Inference Engine failure: {e}")
            return PredictionResult(
                classification="PENDING",
                confidence=50,
                reasoning=f"AI model inference failed or timed out: {str(e)}. Flagged as PENDING for safety safety analysis.",
                timestamp=datetime.now()
            )`,

  orchestrator: `import logging
from ports.interfaces import MetricsPort, StoragePort, IntelligencePort

class Orchestrator:
    """
    Service Orchestrator that coordinates the Bio-Sentinel RLHF pipeline.
    Ensures decoupled interfaces through Ports conforming to Hexagonal principles.
    """
    def __init__(self, metrics: MetricsPort, storage: StoragePort, intelligence: IntelligencePort):
        self.metrics = metrics
        self.storage = storage
        self.intelligence = intelligence

    def execute_pipeline(self, history_days: int = 30) -> dict:
        logging.info("=============================================")
        logging.info("Starting Bio-Sentinel RLHF Analysis Run...")
        logging.info("=============================================")

        try:
            current_metrics = self.metrics.fetch_latest_metrics()
        except Exception as e:
            logging.critical(f"Pipeline crashed during Metric Extraction: {e}")
            raise e

        try:
            history = self.storage.get_history(history_days)
            logging.info(f"Successfully loaded {len(history)} previous training matrices.")
        except Exception as e:
            logging.warning(f"Failed to fetch previous history: {e}. Proceeding with default parameters.")
            history = []

        try:
            prediction = self.intelligence.analyze_data(current_metrics, history)
            logging.info(f"AI Prediction: [{prediction.classification}] with confidence {prediction.confidence}%")
        except Exception as e:
            logging.error(f"Inference failed: {e}")
            raise e

        try:
            self.storage.save_entry(current_metrics, prediction, user_label="PENDING")
        except Exception as e:
            logging.critical(f"Pipeline failed during database commit: {e}")
            raise e

        logging.info("=============================================")
        logging.info("Sentinel Pipeline Execution Finished Cleanly!")
        logging.info("=============================================")
        
        return {
            "metrics": current_metrics.to_dict(),
            "prediction": prediction.to_dict(),
            "user_label_status": "PENDING"
        }`,

  main: `import os
import sys
import logging
from adapters.garmin import GarminAdapter
from adapters.google_sheets import GoogleSheetsAdapter
from adapters.gemini import GeminiAdapter
from services.orchestrator import Orchestrator

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)

def run():
    garmin_email = os.environ.get("GARMIN_EMAIL")
    garmin_password = os.environ.get("GARMIN_PASSWORD")
    garmin_session = os.environ.get("GARMIN_SESSION")
    google_creds = os.environ.get("GOOGLE_CREDS")
    gemini_key = os.environ.get("GEMINI_KEY") or os.environ.get("GEMINI_API_KEY")
    sheet_id = os.environ.get("SHEET_ID")

    missing_vars = []
    if not garmin_email and not garmin_session:
        missing_vars.append("GARMIN_EMAIL or GARMIN_SESSION")
    if not google_creds:
        missing_vars.append("GOOGLE_CREDS")
    if not gemini_key:
        missing_vars.append("GEMINI_KEY")
    if not sheet_id:
        missing_vars.append("SHEET_ID")

    if missing_vars:
        logging.error(f"Missing mandatory environment secrets: {', '.join(missing_vars)}")
        sys.exit(1)

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

    orchestrator = Orchestrator(
        metrics=garmin_adapter,
        storage=sheets_adapter,
        intelligence=gemini_adapter
    )

    try:
        results = orchestrator.execute_pipeline(history_days=30)
        print(f"STATUS_REPORT: Success. Prediction classified as {results['prediction']['classification']}.")
    except Exception as e:
        sys.exit(1)

if __name__ == "__main__":
    run()`,

  workflow: `name: Bio-Sentinel RLHF Engine Scheduled Pipeline

on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
    inputs:
      debug_mode:
        description: 'Enable verbose debug tracing'
        required: false
        default: 'false'

jobs:
  run-analyser:
    runs-on: ubuntu-latest

    steps:
    - name: Checkout Repository Code
      uses: actions/checkout@v3

    - name: Set up Python Environment 3.11
      uses: actions/setup-python@v4
      with:
        python-node: '3.11'
        cache: 'pip'

    - name: Install System Dependencies
      run: |
        python -m pip install --upgrade pip
        pip install -r requirements.txt

    - name: Execute Bio-Sentinel Core Pipeline
      env:
        GARMIN_EMAIL: \${{ secrets.GARMIN_EMAIL }}
        GARMIN_PASSWORD: \${{ secrets.GARMIN_PASSWORD }}
        GARMIN_SESSION: \${{ secrets.GARMIN_SESSION }}
        GOOGLE_CREDS: \${{ secrets.GOOGLE_CREDS }}
        GEMINI_KEY: \${{ secrets.GEMINI_KEY }}
        SHEET_ID: \${{ secrets.SHEET_ID }}
      run: |
        python main.py`
};


interface HistoricalItem {
  id: string;
  hrv: number;
  rhr: number;
  respiration: number;
  prediction: string;
  userLabel: string;
}

export default function App() {
  const [activeTab, setActiveTab ] = useState<'simulator' | 'code' | 'docs'>('simulator');
  const [selectedCodeTab, setSelectedCodeTab] = useState<keyof typeof PYTHON_CODES>('models');
  
  // Real-time API configuration status checks
  const [apiKeySet, setApiKeySet] = useState<boolean>(true);
  const [loadingHealth, setLoadingHealth] = useState<boolean>(true);

  // Homeostatic metrics values for active testing sandbox simulation
  const [currentHrv, setCurrentHrv] = useState<number>(75);
  const [currentRhr, setCurrentRhr] = useState<number>(44);
  const [currentRespiration, setCurrentRespiration] = useState<number>(14.2);

  // In-memory simulated training records list (RLHF Loop)
  const [historyList, setHistoryList] = useState<HistoricalItem[]>([
    { id: '1', hrv: 89, rhr: 40, respiration: 13.9, prediction: 'NOISE', userLabel: 'Alcohol' },
    { id: '2', hrv: 35, rhr: 78, respiration: 18.2, prediction: 'SICKNESS', userLabel: 'Sickness' },
    { id: '3', hrv: 44, rhr: 82, respiration: 14.1, prediction: 'PENDING', userLabel: 'Late Food' },
    { id: '4', hrv: 91, rhr: 38, respiration: 13.8, prediction: 'NOISE', userLabel: 'Alcohol' }
  ]);

  // Modifying active training list states
  const [newHrv, setNewHrv] = useState<number>(65);
  const [newRhr, setNewRhr] = useState<number>(55);
  const [newResp, setNewResp] = useState<number>(14.5);
  const [newPred, setNewPred] = useState<string>('SICKNESS');
  const [newLabel, setNewLabel] = useState<string>('Sickness');

  // Simulation run outcomes
  const [simulationRunning, setSimulationRunning] = useState<boolean>(false);
  const [simResponse, setSimResponse] = useState<{
    classification: string;
    confidence: number;
    reasoning: string;
  } | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(d => {
        setApiKeySet(d.apiKeyConfigured);
        setLoadingHealth(false);
      })
      .catch(() => {
        setLoadingHealth(false);
      });
  }, []);

  const addHistoryItem = () => {
    setHistoryList([
      ...historyList,
      {
        id: Date.now().toString(),
        hrv: newHrv,
        rhr: newRhr,
        respiration: newResp,
        prediction: newPred,
        userLabel: newLabel
      }
    ]);
  };

  const deleteHistoryItem = (id: string) => {
    setHistoryList(historyList.filter(item => item.id !== id));
  };

  const triggerSimulationInference = async () => {
    setSimulationRunning(true);
    setSimResponse(null);

    try {
      const resp = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          currentMetrics: {
            hrv: currentHrv,
            rhr: currentRhr,
            respiration: currentRespiration
          },
          history: historyList.map(h => ({
            hrv: h.hrv,
            rhr: h.rhr,
            respiration: h.respiration,
            prediction: h.prediction,
            userLabel: h.userLabel
          }))
        })
      });

      if (!resp.ok) {
        throw new Error('Analyses server returned unhealthy code');
      }

      const json = await resp.json();
      setSimResponse(json);
    } catch (e: any) {
      setSimResponse({
        classification: 'PENDING',
        confidence: 50,
        reasoning: `Sandbox Error: ${e.message || 'Check GEMINI_API_KEY in Secrets. Use values in .env.example'}`
      });
    } finally {
      setSimulationRunning(false);
    }
  };

  return (
    <div id="bio-sentinel-shell" className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased selection:bg-teal-500/30">
      {/* Top Main Status Bar & Brand Header */}
      <header id="main-header" className="border-b border-slate-900 bg-slate-950 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="bg-gradient-to-tr from-teal-500 to-emerald-500 p-2.5 rounded-xl text-slate-950 shadow-lg shadow-teal-500/10">
            <Activity id="pulse-logo" className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <span className="text-xs uppercase tracking-widest text-teal-400 font-semibold">Homeostatic Wearable Safeguard</span>
            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-teal-100 to-slate-200 bg-clip-text text-transparent">
              Bio-Sentinel RLHF Console
            </h1>
          </div>
        </div>

        {/* Global Secrets Status Badge */}
        <div className="flex items-center gap-3">
          <div className="bg-slate-900/80 px-4 py-2 rounded-xl flex items-center space-x-2 border border-slate-800">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping"></span>
            <span className="text-xs text-slate-400">GSheets UI Integrated</span>
          </div>

          <div className={`px-4 py-2 rounded-xl flex items-center space-x-2 border text-xs font-semibold ${
            apiKeySet ? 'bg-teal-500/5 border-teal-500/20 text-teal-300' : 'bg-red-500/5 border-red-500/20 text-red-300'
          }`}>
            {apiKeySet ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            <span>Gemini Key: {apiKeySet ? 'ACTIVE (AI Studio)' : 'MISSING'}</span>
          </div>
        </div>
      </header>

      {/* Main Grid Workspace */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Hand Navigation / Side Panel Control tabs */}
        <section className="lg:col-span-3 flex flex-col gap-4">
          <div className="bg-slate-900/60 p-2 rounded-2xl border border-slate-900 flex flex-row lg:flex-col gap-1 w-full">
            <button
              id="tab-simulator"
              onClick={() => setActiveTab('simulator')}
              className={`flex-1 flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                activeTab === 'simulator' 
                  ? 'bg-gradient-to-r from-teal-500/15 to-teal-500/5 text-teal-300 border border-teal-500/20 shadow-inner' 
                  : 'hover:bg-slate-900 text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              <Sliders className="w-4 h-4" />
              <span>RLHF Simulator</span>
            </button>

            <button
              id="tab-code"
              onClick={() => setActiveTab('code')}
              className={`flex-1 flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                activeTab === 'code' 
                  ? 'bg-gradient-to-r from-teal-500/15 to-teal-500/5 text-teal-300 border border-teal-500/20 shadow-inner' 
                  : 'hover:bg-slate-900 text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              <Code className="w-4 h-4" />
              <span>Python Source Code</span>
            </button>

            <button
              id="tab-docs"
              onClick={() => setActiveTab('docs')}
              className={`flex-1 flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                activeTab === 'docs' 
                  ? 'bg-gradient-to-r from-teal-500/15 to-teal-500/5 text-teal-300 border border-teal-500/20 shadow-inner' 
                  : 'hover:bg-slate-900 text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              <Database className="w-4 h-4" />
              <span>Deployment & Guide</span>
            </button>
          </div>

          {/* Prompt logic callout info box */}
          <div className="bg-slate-900/40 border border-slate-900 p-4 rounded-2xl flex flex-col gap-3">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
              <History className="w-3.5 h-3.5" />
              How RLHF Works Here
            </span>
            <p className="text-xs text-slate-400 leading-relaxed">
              Garmin logs nightly metrics into Google Sheets. You select values (e.g. <span className="text-slate-200">Alcohol</span>, <span className="text-slate-200">Late Food</span>) in your sheet column. 
            </p>
            <p className="text-xs text-slate-400 leading-relaxed">
              When Gemini updates, the Python script reads the last 30 rows of labels to contextualize borderline readings as <span className="text-teal-400">LIFESTYLE NOISE</span> instead of triggering a false alarm warning!
            </p>
          </div>
        </section>

        {/* Right Active Panel Content Workspace */}
        <section className="lg:col-span-9 flex flex-col gap-6">

          {/* TAB 1: RLHF COGNITIVE SIMULATOR SANDBOX */}
          {activeTab === 'simulator' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Simulator Sliders Panel */}
              <div className="bg-slate-900/30 rounded-2xl border border-slate-900/80 p-5 sm:p-6 flex flex-col justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2 mb-2">
                    <Sliders className="w-5 h-5 text-teal-400" />
                    Simulated Garmin Output
                  </h2>
                  <p className="text-xs text-slate-400 mb-6 font-medium">
                    Adjust current-day metrics to simulate biometric inputs sending over state channels.
                  </p>

                  <div className="space-y-6">
                    {/* HRV Slider */}
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                          <Heart className="w-4 h-4 text-rose-500" />
                          Heart Rate Variability (HRV)
                        </label>
                        <span className={`text-xs font-mono font-bold ${
                          currentHrv > 75 ? 'text-teal-400' : currentHrv > 50 ? 'text-amber-400' : 'text-red-400'
                        }`}>
                          {currentHrv} ms
                        </span>
                      </div>
                      <input 
                        type="range" 
                        min="15" 
                        max="140" 
                        value={currentHrv} 
                        onChange={(e) => setCurrentHrv(Number(e.target.value))}
                        className="w-full h-1.5 bg-slate-950 rounded-lg appearance-none cursor-pointer accent-teal-400"
                      />
                      <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                        <span>Low / Stressed (15ms)</span>
                        <span>High / Rested (140ms)</span>
                      </div>
                    </div>

                    {/* RHR Slider */}
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                          <Activity className="w-4 h-4 text-emerald-500 animate-pulse" />
                          Resting Heart Rate (RHR)
                        </label>
                        <span className={`text-xs font-mono font-bold ${
                          currentRhr < 45 ? 'text-teal-400' : currentRhr < 60 ? 'text-amber-400' : 'text-red-400'
                        }`}>
                          {currentRhr} bpm
                        </span>
                      </div>
                      <input 
                        type="range" 
                        min="35" 
                        max="110" 
                        value={currentRhr} 
                        onChange={(e) => setCurrentRhr(Number(e.target.value))}
                        className="w-full h-1.5 bg-slate-950 rounded-lg appearance-none cursor-pointer accent-teal-400"
                      />
                      <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                        <span>Athlete Rest (35 bpm)</span>
                        <span>Elevated Load (110 bpm)</span>
                      </div>
                    </div>

                    {/* Respiration Slider */}
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                          <HelpCircle className="w-4 h-4 text-sky-400" />
                          Sleep Respiration Rate
                        </label>
                        <span className={`text-xs font-mono font-bold ${
                          currentRespiration < 15 ? 'text-teal-400' : currentRespiration < 17 ? 'text-amber-400' : 'text-red-400'
                        }`}>
                          {currentRespiration.toFixed(1)} br/m
                        </span>
                      </div>
                      <input 
                        type="range" 
                        min="11.5" 
                        max="22.5" 
                        step="0.1"
                        value={currentRespiration} 
                        onChange={(e) => setCurrentRespiration(Number(e.target.value))}
                        className="w-full h-1.5 bg-slate-950 rounded-lg appearance-none cursor-pointer accent-teal-400"
                      />
                      <div className="flex justify-between text-[10px] text-slate-500 mt-1">
                        <span>Quiet Sleep (11.5)</span>
                        <span>Hyperventilating (22.5)</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-8 pt-4 border-t border-slate-900/60">
                  <button
                    id="btn-simulate"
                    disabled={simulationRunning}
                    onClick={triggerSimulationInference}
                    className="w-full bg-gradient-to-r from-teal-500 to-emerald-500 hover:from-teal-600 hover:to-emerald-600 disabled:from-slate-800 disabled:to-slate-800 disabled:cursor-not-allowed text-slate-950 font-bold py-3 px-4 rounded-xl flex items-center justify-center space-x-2 shadow-lg shadow-teal-500/10 active:scale-98 transition-all"
                  >
                    {simulationRunning ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin text-slate-950" />
                        <span>Querying Gemini RLHF Loop...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 text-slate-950 fill-slate-950" />
                        <span>Run Simulation Prediction</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Training logs (RLHF Dataset) Panel */}
              <div className="bg-slate-900/30 rounded-2xl border border-slate-900/80 p-5 sm:p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                      <Database className="w-4 h-4 text-teal-400" />
                      RLHF Training History Dataset
                    </h2>
                    <p className="text-[11px] text-slate-400 font-medium">
                      Simulates human labels Gemini pulls from the sheet on launch.
                    </p>
                  </div>
                </div>

                {/* History list box scrollable */}
                <div className="flex-1 overflow-y-auto max-h-[290px] space-y-2 pr-1 custom-scrollbar">
                  {historyList.map(item => (
                    <div 
                      key={item.id} 
                      className="bg-slate-950 p-3 rounded-xl border border-slate-900/80 flex items-center justify-between text-xs transition-colors hover:border-slate-800"
                    >
                      <div className="flex items-center space-x-3">
                        <span className={`w-2 h-2 rounded-full ${
                          item.userLabel === 'Alcohol' || item.userLabel === 'Late Food' ? 'bg-amber-400' : 'bg-red-500'
                        }`}></span>
                        <div className="space-y-0.5">
                          <p className="font-semibold text-slate-300">
                            HRV: {item.hrv}ms | RHR: {item.rhr}bpm | Resp: {item.respiration}br/m
                          </p>
                          <p className="text-[10px] text-slate-500">
                            AI Pred: <span className="text-slate-400">{item.prediction}</span> | Core Feedback Label: <span className={`font-semibold ${
                              item.userLabel === 'Sickness' ? 'text-red-400' : 'text-teal-400'
                            }`}>{item.userLabel}</span>
                          </p>
                        </div>
                      </div>
                      <button 
                        onClick={() => deleteHistoryItem(item.id)}
                        className="text-slate-600 hover:text-red-400 p-1.5 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Quick Add Custom Record to Training list */}
                <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-900/60 space-y-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-teal-400">
                    Add Simulated Label To Dataset
                  </span>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-500 font-semibold block mb-0.5">HRV ms</label>
                      <input 
                        type="number" 
                        value={newHrv} 
                        onChange={(e) => setNewHrv(Number(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-900 rounded px-2 py-1 text-xs text-slate-200 font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-semibold block mb-0.5">RHR bpm</label>
                      <input 
                        type="number" 
                        value={newRhr} 
                        onChange={(e) => setNewRhr(Number(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-900 rounded px-2 py-1 text-xs text-slate-200 font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-semibold block mb-0.5">Resp br/m</label>
                      <input 
                        type="number" 
                        value={newResp} 
                        step="0.1"
                        onChange={(e) => setNewResp(Number(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-900 rounded px-2 py-1 text-xs text-slate-200 font-mono"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-500 font-semibold block mb-0.5">Normal Prediction</label>
                      <select 
                        value={newPred} 
                        onChange={(e) => setNewPred(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-900 rounded px-1.5 py-1 text-xs text-slate-300"
                      >
                        <option value="SICKNESS">SICKNESS</option>
                        <option value="NOISE">NOISE</option>
                        <option value="PENDING">PENDING</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500 font-semibold block mb-0.5">Confirmed User Label</label>
                      <input 
                        type="text" 
                        value={newLabel} 
                        onChange={(e) => setNewLabel(e.target.value)}
                        placeholder="e.g. Alcohol"
                        className="w-full bg-slate-950 border border-slate-900 rounded px-2.5 py-1 text-xs text-slate-200"
                      />
                    </div>
                  </div>
                  <button
                    onClick={addHistoryItem}
                    className="w-full bg-slate-900 hover:bg-slate-800 text-teal-400 hover:text-teal-300 border border-slate-800 text-xs py-1.5 rounded font-bold transition-all flex items-center justify-center space-x-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Incorporate Into Dataset</span>
                  </button>
                </div>

              </div>

              {/* Dynamic Simulation Output Display (Full span of both columns) */}
              <div className="md:col-span-2">
                {simResponse ? (
                  <div className={`rounded-2xl border p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 transition-all animate-fadeIn ${
                    simResponse.classification === 'SICKNESS' 
                      ? 'bg-red-500/5 border-red-500/20' 
                      : simResponse.classification === 'NOISE' 
                      ? 'bg-teal-500/5 border-teal-500/20' 
                      : 'bg-amber-500/5 border-amber-500/20'
                  }`}>
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center space-x-3">
                        <span className={`text-xs uppercase font-extrabold tracking-widest px-3 py-1 rounded-full ${
                          simResponse.classification === 'SICKNESS' 
                            ? 'bg-red-500/10 text-red-400 border border-red-500/20' 
                            : simResponse.classification === 'NOISE' 
                            ? 'bg-teal-500/10 text-teal-400 border border-teal-500/20' 
                            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        }`}>
                          Prediction classification: {simResponse.classification}
                        </span>
                        <span className="text-xs text-slate-400 font-semibold font-mono">
                          Confidence: {simResponse.confidence}%
                        </span>
                      </div>
                      <h4 className="text-base font-bold text-slate-100 leading-tight">
                        Bio-Sentinel Analysis Reason:
                      </h4>
                      <p className="text-xs sm:text-sm text-slate-300 leading-relaxed max-w-2xl font-medium">
                        {simResponse.reasoning}
                      </p>
                    </div>

                    <div className={`p-4 rounded-xl border flex flex-col items-center justify-center text-center w-full md:w-32 h-24 ${
                      simResponse.classification === 'SICKNESS' 
                        ? 'bg-red-500/10 border-red-500/20 text-red-400' 
                        : simResponse.classification === 'NOISE' 
                        ? 'bg-teal-500/10 border-teal-500/20 text-teal-400' 
                        : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                    }`}>
                      <TrendingDown className={`w-8 h-8 mb-1 ${
                        simResponse.classification === 'SICKNESS' ? 'text-red-400 animate-bounce' : 'text-teal-400'
                      }`} />
                      <span className="text-[10px] font-bold uppercase tracking-wider">Status Alert</span>
                    </div>
                  </div>
                ) : (
                  <div className="bg-slate-900/10 border border-slate-900 border-dashed rounded-2xl p-6 text-center text-slate-500 text-xs">
                    No active simulation has been queried. Adjust the Garmin slider metrics and click "Run Simulation" to analyze metrics using the RLHF Gemini pattern model!
                  </div>
                )}
              </div>

            </div>
          )}


          {/* TAB 2: PYTHON HEXAGONAL CODE BROWSER */}
          {activeTab === 'code' && (
            <div className="bg-slate-900/30 rounded-2xl border border-slate-900/80 p-5 sm:p-6 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    <Code className="w-5 h-5 text-teal-400" />
                    Python Hexagonal Adapter Workspace
                  </h2>
                  <p className="text-xs text-slate-400 font-medium">
                    Fully production-coded, modular Python package constructed in your container files.
                  </p>
                </div>
              </div>

              {/* Internal Files Tabs selector */}
              <div className="flex flex-wrap gap-1 bg-slate-950 p-1 rounded-xl border border-slate-900">
                {(Object.keys(PYTHON_CODES) as Array<keyof typeof PYTHON_CODES>).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setSelectedCodeTab(tab)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                      selectedCodeTab === tab 
                        ? 'bg-slate-850 text-teal-400 border border-slate-800' 
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab === 'models' && '1. domain/models.py'}
                    {tab === 'interfaces' && '2. ports/interfaces.py'}
                    {tab === 'garmin' && '3. adapters/garmin.py'}
                    {tab === 'sheets' && '4. adapters/google_sheets.py'}
                    {tab === 'gemini' && '5. adapters/gemini.py'}
                    {tab === 'orchestrator' && '6. services/orchestrator.py'}
                    {tab === 'main' && '7. main.py'}
                    {tab === 'workflow' && '8. GHA Workflow (yml)'}
                  </button>
                ))}
              </div>

              {/* Code output display box */}
              <div className="bg-slate-950 rounded-xl p-4 border border-slate-900 overflow-x-auto relative">
                <div className="absolute right-4 top-4 bg-slate-900/85 text-xs text-slate-400 border border-slate-800 px-2 py-1 rounded font-mono select-none">
                  Python 3.11+
                </div>
                <pre className="text-[11.5px] text-slate-300 font-mono leading-relaxed select-text whitespace-pre text-left">
                  {PYTHON_CODES[selectedCodeTab]}
                </pre>
              </div>
            </div>
          )}


          {/* TAB 3: GUIDE AND DEPLOYMENT FLOWS */}
          {activeTab === 'docs' && (
            <div className="bg-slate-900/30 rounded-2xl border border-slate-900/80 p-5 sm:p-6 space-y-6">
              
              <div>
                <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2 mb-2">
                  <Database className="w-5 h-5 text-teal-400" />
                  Integration Setup Blueprint
                </h2>
                <p className="text-xs text-slate-400 font-medium">
                  Follow these standard steps to wire up the persistent spreadsheet database and active pipeline automation.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* Steps Left */}
                <div className="bg-slate-950 p-5 rounded-xl border border-slate-900 space-y-3">
                  <h3 className="text-sm font-bold text-teal-300 flex items-center gap-2">
                    <span className="bg-teal-500/10 text-teal-400 w-5 h-5 rounded-full flex items-center justify-center text-xs">1</span>
                    Google Sheets Setup
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed text-left">
                    Create a blank Google Sheet in your personal drive, and write the following headers in row 1:
                  </p>
                  <div className="bg-slate-900/60 p-2.5 rounded font-mono text-[10px] text-slate-300 select-all border border-slate-800/80">
                    Timestamp, HRV (ms), RHR (bpm), Respiration (br/m), Sleep Score, AI Prediction, Confidence, Reasoning, User Label
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed text-left">
                    Create a service account from the Google Cloud Console, download the JSON key file, and share your spreadsheet with the service account's client email.
                  </p>
                </div>

                {/* Steps Right */}
                <div className="bg-slate-950 p-5 rounded-xl border border-slate-900 space-y-3">
                  <h3 className="text-sm font-bold text-teal-300 flex items-center gap-2">
                    <span className="bg-teal-500/10 text-teal-400 w-5 h-5 rounded-full flex items-center justify-center text-xs">2</span>
                    GitHub Actions Secrets
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed text-left">
                    Push your Bio-Sentinel code repository to GitHub. Go to <span className="text-slate-300">Settings &gt; Secrets and Variables &gt; Actions</span>, and safe-keep the following:
                  </p>
                  <ul className="text-xs text-slate-400 space-y-1 text-left list-disc pl-4 font-mono select-none">
                    <li><span className="text-slate-300">GOOGLE_CREDS</span>: The entire Service Account JSON string contents</li>
                    <li><span className="text-slate-300">GEMINI_KEY</span>: Your Google Gemini API key</li>
                    <li><span className="text-slate-300">SHEET_ID</span>: The Google Sheet unique ID (extracted out of its URL string)</li>
                    <li><span className="text-slate-300">GARMIN_EMAIL</span>, <span className="text-slate-300">GARMIN_PASSWORD</span></li>
                    <li><span className="text-slate-300">GARMIN_SESSION</span>: (Bypasses email MFA validation)</li>
                  </ul>
                </div>
              </div>

              {/* Session bypass notice helper */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-900 flex items-start gap-3">
                <Lock className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h4 className="text-xs font-bold text-slate-200">Bypassing Garmin MFA (Base64 Token Persistence)</h4>
                  <p className="text-xs text-slate-400 leading-relaxed text-left">
                    Since Garmin uses Multi-Factor Authentication via email, standard programmatic login might block inside GitHub Actions. To bypass this, execute the Python code once locally to authenticate. The client automatically dumps a session payload. Base64-encode this dictionary string, save it as <span className="text-teal-400">GARMIN_SESSION</span>, and the cron pipeline will bypass MFA checks on subsequent ticks.
                  </p>
                </div>
              </div>

            </div>
          )}

        </section>

      </main>

      <footer id="main-footer" className="border-t border-slate-900 py-4 px-6 text-center text-xs text-slate-500">
        Bio-Sentinel RLHF System • Decoupled Hexagonal Python Architecture • Real-Time Gemini 3.5 Flash Sandbox
      </footer>
    </div>
  );
}
