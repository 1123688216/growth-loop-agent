from __future__ import annotations

from dataclasses import dataclass
import os


def _integer(name: str, default: int, minimum: int) -> int:
    raw = os.getenv(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        value = default
    return max(minimum, value)


@dataclass(frozen=True)
class Settings:
    mineru_api_url: str
    mineru_backend: str
    mineru_effort: str
    mineru_poll_interval_ms: int
    mineru_timeout_seconds: int
    parent_chunk_tokens: int
    child_chunk_tokens: int
    chunk_overlap_tokens: int

    @classmethod
    def from_env(cls) -> "Settings":
        parent = _integer("RAG_PARENT_CHUNK_TOKENS", 2048, 256)
        child = min(parent, _integer("RAG_CHILD_CHUNK_TOKENS", 512, 64))
        overlap = min(child // 2, _integer("RAG_CHUNK_OVERLAP_TOKENS", 20, 0))
        return cls(
            mineru_api_url=os.getenv("MINERU_API_URL", "").strip().rstrip("/"),
            mineru_backend=os.getenv("MINERU_BACKEND", "pipeline").strip() or "pipeline",
            mineru_effort=os.getenv("MINERU_EFFORT", "medium").strip() or "medium",
            mineru_poll_interval_ms=_integer("MINERU_POLL_INTERVAL_MS", 1000, 100),
            mineru_timeout_seconds=_integer("MINERU_TIMEOUT_SECONDS", 900, 30),
            parent_chunk_tokens=parent,
            child_chunk_tokens=child,
            chunk_overlap_tokens=overlap,
        )
