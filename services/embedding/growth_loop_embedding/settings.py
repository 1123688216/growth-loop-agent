from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


BGE_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
QWEN_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"


@dataclass(frozen=True)
class ModelSpec:
    alias: str
    model: str
    revision: str
    path: Path
    pooling: str
    query_instruction: str


@dataclass(frozen=True)
class Settings:
    models: dict[str, ModelSpec]
    device: str
    max_length: int
    max_batch_texts: int
    max_text_chars: int

    @classmethod
    def from_env(cls) -> "Settings":
        bge_path = Path(os.getenv("EMBEDDING_BGE_M3_PATH", r"G:\Embedding\bge-m3"))
        qwen_path = Path(os.getenv("EMBEDDING_QWEN3_PATH", r"G:\Embedding\qwen3-embedding-0.6b"))
        models = {
            "bge-m3": ModelSpec(
                alias="bge-m3",
                model="BAAI/bge-m3",
                revision=BGE_REVISION,
                path=bge_path,
                pooling="cls",
                query_instruction="",
            ),
            "qwen3-embedding-0.6b": ModelSpec(
                alias="qwen3-embedding-0.6b",
                model="Qwen/Qwen3-Embedding-0.6B",
                revision=QWEN_REVISION,
                path=qwen_path,
                pooling="last_token",
                query_instruction=(
                    "Instruct: Given a learning question, retrieve passages that contain "
                    "evidence needed to answer it.\nQuery: "
                ),
            ),
        }
        return cls(
            models=models,
            device=os.getenv("EMBEDDING_DEVICE", "auto").strip().lower() or "auto",
            max_length=max(128, int(os.getenv("EMBEDDING_MAX_LENGTH", "2048"))),
            max_batch_texts=max(1, int(os.getenv("EMBEDDING_MAX_BATCH_TEXTS", "32"))),
            max_text_chars=max(1_000, int(os.getenv("EMBEDDING_MAX_TEXT_CHARS", "40000"))),
        )

