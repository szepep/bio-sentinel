import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = 3000;

// Lazy initialization of Gemini client
let aiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY environment variable is not configured. Please add it to your Secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Check api health and check if GEMINI_API_KEY is available
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    apiKeyConfigured: !!process.env.GEMINI_API_KEY,
  });
});

// Primary RLHF inference endpoint
app.post("/api/analyze", async (req, res) => {
  try {
    const { currentMetrics, history } = req.body;
    if (!currentMetrics) {
      return res.status(400).json({ error: "Missing currentMetrics parameter." });
    }

    const ai = getGemini();

    // Construct few-shot training history prompt
    const historyPrompt = Array.isArray(history) && history.length > 0
      ? history.map((item: any) => {
          return `- Metrics (HRV: ${item.hrv}ms, RHR: ${item.rhr}bpm, Resp: ${item.respiration} br/m).
  Original AI Prediction: "${item.prediction || 'N/A'}"
  True Manual Feedback Label: "${item.userLabel || 'PENDING'}"`;
        }).join("\n\n")
      : "No historic training labels exist yet.";

    const prompt = `You are the Bio-Sentinel RLHF expert analysis engine. Your goal is to analyze current day homeostatic wearable metrics relative to past user labels, and predict whether physiological strain indicates "SICKNESS" or ordinary "lifestyle noise" (e.g., alcohol, exercise, late meals).

### SYSTEM ANALYSIS CONTEXT & GROUND RULES:
- Heart Rate Variability (HRV): Reflects parasympathetic tone. A sharp drop compared to historical baselines indicates physiological stress.
- Resting Heart Rate (RHR): Reflects cardiovascular load. A substantial spike indicates systemic strain.
- Respiration Rate (Resp): Normal sleep breathing is 12-20. Small elevations can signal incubation of sickness.
- RLHF Adaptation: You must learn from the user's manual labels. For example:
  - If a user historically marks a severe drop in HRV and spike in RHR as "Alcohol", and the current metrics match that exact profile, you should classify it as "NOISE" due to "Alcohol" instead of "SICKNESS".
  - If they mark a moderate HRV drop but high baseline RHR as "Sickness", adapt to that threshold.

### USER-LABELED HISTORICAL TRAINING SAMPLES (RLHF LOOP):
${historyPrompt}

### CURRENT RECORD TO EVALUATE:
- HRV: ${currentMetrics.hrv} ms
- RHR: ${currentMetrics.rhr} bpm
- Respiration: ${currentMetrics.respiration} breaths/min

### TASK:
Analyze the current metrics. Compare them with the patterns in the user-labeled training history.
Predict whether this is "SICKNESS", ordinary lifestyle "NOISE", or "PENDING" (meaning highly ambiguous/extreme spike that requires the user to review it carefully).

Return a JSON object that strictly adheres to the following JSON schema:
{
  "classification": "SICKNESS" | "NOISE" | "PENDING",
  "confidence": <integer percentage between 0 and 100>,
  "reasoning": "<concise explanation detailing why matching the training history led to this conclusion, noting specifically if user history patterns like alcohol or sickness matches the current pattern>"
}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          required: ["classification", "confidence", "reasoning"],
          properties: {
            classification: {
              type: Type.STRING,
              description: "The predicted category. Must be 'SICKNESS', 'NOISE', or 'PENDING'.",
            },
            confidence: {
              type: Type.INTEGER,
              description: "Confidence percentage (0 to 100).",
            },
            reasoning: {
              type: Type.STRING,
              description: "Reasoning and contextual feedback.",
            },
          },
        },
      },
    });

    const parsedResponse = JSON.parse(response.text || "{}");
    res.json(parsedResponse);
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    res.status(500).json({
      error: error.message || "Failed to communicate with Gemini API.",
    });
  }
});

// Configure static asset serving and Vite client bundle
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Bio-Sentinel Server running on http://localhost:${PORT}`);
  });
}

startServer();
