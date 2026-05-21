import logging
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

        # 1. Fetch current health stream
        try:
            current_metrics = self.metrics.fetch_latest_metrics()
        except Exception as e:
            logging.critical(f"Pipeline crashed during Metric Extraction: {e}")
            raise e

        # 2. Fetch recent labelled history
        try:
            history = self.storage.get_history(history_days)
            logging.info(f"Successfully loaded {len(history)} previous training matrices.")
        except Exception as e:
            logging.warning(f"Failed to fetch previous history: {e}. Proceeding with default parameters.")
            history = []

        # 3. Request Gemini evaluation
        try:
            prediction = self.intelligence.analyze_data(current_metrics, history)
            logging.info(f"AI Prediction: [{prediction.classification}] with confidence {prediction.confidence}%")
        except Exception as e:
            logging.error(f"Inference failed: {e}")
            raise e

        # 4. Save results back into Sheets database
        try:
            # Save the metric with state "PENDING" to prompt user interaction or conditional color formatting
            user_label = "PENDING" if prediction.classification == "PENDING" else "PENDING"
            self.storage.save_entry(current_metrics, prediction, user_label=user_label)
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
        }
