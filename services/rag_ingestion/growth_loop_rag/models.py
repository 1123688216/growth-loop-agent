from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


NodeType = Literal[
    "title",
    "heading",
    "paragraph",
    "list",
    "code",
    "table",
    "equation",
    "image",
    "caption",
]


class ExtractedPage(ApiModel):
    page: int
    text: str


class DocumentNodeDraft(ApiModel):
    position: int
    parent_position: int | None = None
    type: NodeType
    heading_level: int | None = None
    text: str
    section_path: list[str] = Field(default_factory=list)
    page_start: int | None = None
    page_end: int | None = None
    char_start: int
    char_end: int
    metadata: dict[str, Any] = Field(default_factory=dict)


class ExtractedDocument(ApiModel):
    status: Literal["ready", "ocr_required", "failed"]
    text: str
    normalized_markdown: str
    pages: list[ExtractedPage] = Field(default_factory=list)
    nodes: list[DocumentNodeDraft] = Field(default_factory=list)
    parser_name: str
    parser_version: str
    output_format: str = "markdown+nodes"
    warnings: list[str] = Field(default_factory=list)
    error_message: str = ""


class SourceParentChunkDraft(ApiModel):
    position: int
    heading: str
    section_path: list[str]
    content: str
    page_start: int | None
    page_end: int | None
    char_start: int
    char_end: int
    token_estimate: int


class SourceChunkDraft(ApiModel):
    position: int
    parent_position: int
    heading: str
    section_path: list[str]
    context_prefix: str
    content: str
    page_start: int | None
    page_end: int | None
    char_start: int
    char_end: int
    token_estimate: int
    node_start_position: int | None
    node_end_position: int | None
    boundary_reason: dict[str, Any]


class SourceChunkSetDraft(ApiModel):
    strategy: str
    strategy_version: str
    config: dict[str, Any]
    warnings: list[str] = Field(default_factory=list)
    parents: list[SourceParentChunkDraft]
    chunks: list[SourceChunkDraft]


class IngestionResponse(ApiModel):
    extracted: ExtractedDocument
    chunk_set: SourceChunkSetDraft | None
    engine: Literal["mineru+llamaindex", "markdown+llamaindex"]


class HealthResponse(ApiModel):
    status: Literal["ok"] = "ok"
    service_version: str
    llama_index_version: str
    mineru_configured: bool
    mineru_healthy: bool | None
    mineru_protocol_version: int | None
