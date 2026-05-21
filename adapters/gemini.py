import os
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

        # Build few-shot history string for in-context RLHF training loops
        history_blocks = []
        if history:
            for entry in history:
                label = entry.get("userLabel") or entry.get("user_label") or "PENDING"
                # Map blank/pending cleanly
                if not label:
                    label = "PENDING"
                
                history_blocks.append(
                    f"- Metric Baseline Record:\n"
                    f"  HRV: {entry.get('hrv')} ms, RHR: {entry.get('rhr')} bpm, Respiration: {entry.get('respiration')} br/m\n"
                    f"  AI's Historical Classification: {entry.get('prediction', 'N/A')}\n"
                    f"  User's Confirmed Manual Feedback (TRUE LABEL): {label}"
                )
            history_prompt = "\n\n".join(history_blocks)
        else:
            history_prompt = "No prior user-labeled historical cycles records exist yet."

        # Structured Prompt combining core threshold heuristics with fine-grained human labels (RLHF)
        prompt = f"""You are the Bio-Sentinel RLHF Analysis Engine.
Your specialized medical-grade task is to evaluate a user's sleep clinical metrics (HRV, RHR, Respiration) and predict physiological status.
Specifically, you must distinguish incubation of "SICKNESS" from ordianary environmental lifestyle "NOISE" (such as alcohol, vigorous exercise late, sleep deprivation, or late food).

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
            # We request Gemini to return clean JSON structure matching our schema
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

            # Parse results
            result_json = json.loads(response.text)
            classification = result_json.get("classification", "PENDING").upper()
            confidence = int(result_json.get("confidence", 70))
            reasoning = result_json.get("reasoning", "Metrics fall within borderline bands.")

            # Map safety boundary
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
            )
