from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class EmbeddingRequest(BaseModel):
    """Accept both the existing Growth Loop payload and OpenAI-compatible payloads.

    Existing/internal payload:
        {"model": "bge-m3", "texts": ["..."], "input_type": "document"}

    OpenAI-compatible payload:
        {"model": "bge-m3", "input": ["..."]}
    """

    model_config = ConfigDict(extra="ignore")

    model: str = "bge-m3"
    input: str | list[str] | None = None
    texts: list[str] | None = None
    input_type: Literal["document", "query"] = "document"
    normalize: bool = True

    # OpenAI-compatible optional fields. RAGFlow normally uses float embeddings.
    encoding_format: Literal["float", "base64"] = "float"
    dimensions: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_payload(self) -> "EmbeddingRequest":
        if self.input is None and self.texts is None:
            raise ValueError("either input or texts is required")
        if self.input is not None and self.texts is not None:
            raise ValueError("provide either input or texts, not both")

        values = self.resolved_texts()
        if not values:
            raise ValueError("embedding input must not be empty")
        if len(values) > 32:
            raise ValueError("embedding input may contain at most 32 texts")
        if any(not isinstance(value, str) or not value.strip() for value in values):
            raise ValueError("embedding input must contain non-empty strings")
        return self

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("model must not be empty")
        return value

    def resolved_texts(self) -> list[str]:
        if self.input is not None:
            return [self.input] if isinstance(self.input, str) else self.input
        return self.texts or []

    @property
    def is_openai_request(self) -> bool:
        return self.input is not None


class TimingResponse(BaseModel):
    model_load_ms: float
    tokenize_ms: float
    encode_ms: float


class EmbeddingResponse(BaseModel):
    """Existing Growth Loop response format. Kept for backward compatibility."""

    model_alias: str
    model: str
    revision: str
    dimension: int
    device: str
    dtype: str
    normalized: bool
    input_tokens: int
    vectors: list[list[float]]
    timing: TimingResponse


class OpenAIModelCard(BaseModel):
    id: str
    object: Literal["model"] = "model"
    owned_by: str = "local"


class OpenAIModelList(BaseModel):
    object: Literal["list"] = "list"
    data: list[OpenAIModelCard]


class OpenAIEmbeddingItem(BaseModel):
    object: Literal["embedding"] = "embedding"
    index: int
    embedding: list[float]


class OpenAIEmbeddingUsage(BaseModel):
    prompt_tokens: int
    total_tokens: int


class OpenAIEmbeddingResponse(BaseModel):
    object: Literal["list"] = "list"
    data: list[OpenAIEmbeddingItem]
    model: str
    usage: OpenAIEmbeddingUsage


class ModelHealth(BaseModel):
    alias: str
    model: str
    revision: str
    path: str
    available: bool


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service_version: str
    device: str
    loaded_model: str | None
    models: list[ModelHealth]
