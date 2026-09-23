from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse
from pydantic_ai.settings import ModelSettings


def _flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    database_path: str
    service_token: str
    llm_enabled: bool
    llm_base_url: str
    llm_api_key: str
    llm_model: str

    @classmethod
    def from_env(cls) -> "Settings":
        default_database = Path(__file__).resolve().parents[1] / "data" / "workflow-checkpoints.sqlite"
        database_path = Path(os.getenv("WORKFLOW_CHECKPOINT_PATH", str(default_database))).expanduser().resolve()
        database_path.parent.mkdir(parents=True, exist_ok=True)
        return cls(
            database_path=str(database_path),
            service_token=os.getenv("WORKFLOW_SERVICE_TOKEN", "").strip(),
            llm_enabled=_flag("WORKFLOW_LLM_ENABLED"),
            llm_base_url=os.getenv("WORKFLOW_LLM_BASE_URL", "").strip(),
            llm_api_key=os.getenv("WORKFLOW_LLM_API_KEY", "").strip(),
            llm_model=os.getenv("WORKFLOW_LLM_MODEL", "").strip(),
        )

    @property
    def llm_ready(self) -> bool:
        return self.llm_enabled and bool(self.llm_base_url and self.llm_api_key and self.llm_model)

    @property
    def structured_model_settings(self) -> ModelSettings:
        # DeepSeek thinking mode rejects the forced output tool used for structured responses.
        if urlparse(self.llm_base_url).hostname == "api.deepseek.com":
            return {"extra_body": {"thinking": {"type": "disabled"}}, "timeout": 60}
        return {"timeout": 60}
