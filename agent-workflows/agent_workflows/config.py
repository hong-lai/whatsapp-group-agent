from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgres://whatsapp:whatsapp@localhost:5433/whatsapp"
    redis_url: str = "redis://localhost:6380"
    message_events_queue: str = "message-events"

    # Comma-separated workflow names. Empty = none. Example: daily_site_report
    enabled_workflows: str = "daily_site_report"

    llm_base_url: str = "http://localhost:1234/v1"
    llm_api_key: str = "1234"
    llm_model: str = "google/gemma-4-e2b"
    llm_temperature: float = 0.0
    llm_enable_thinking: bool = True

    # Directory with confidential prompt files (not committed).
    # Expected: classifier_prompt.txt, extractor_prompt.txt
    daily_site_report_prompts_dir: str = "./private/daily_site_report"

    concurrency: int = 1

    def enabled_workflow_names(self) -> set[str]:
        return {
            name.strip()
            for name in self.enabled_workflows.split(",")
            if name.strip()
        }


settings = Settings()
