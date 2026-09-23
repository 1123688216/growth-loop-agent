from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AdvanceRequest(StrictModel):
    thread_id: str = Field(min_length=8, max_length=180)
    user_id: str = Field(min_length=1, max_length=180)
    goal_id: str = Field(min_length=1, max_length=180)
    require_sources: bool = False
    resume: dict[str, Any] | None = None

    @field_validator("thread_id", "user_id", "goal_id")
    @classmethod
    def clean_identifier(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned or any(character in cleaned for character in "\r\n\0"):
            raise ValueError("identifier is invalid")
        return cleaned


class ExternalActionResult(StrictModel):
    event: Literal["action_completed"]
    action: str = Field(min_length=1, max_length=80)
    idempotency_key: str = Field(min_length=8, max_length=240)
    data: dict[str, Any]


class UserResume(StrictModel):
    event: Literal["diagnostic_completed", "sources_updated"]


class GoalSnapshot(StrictModel):
    id: str
    title: str
    description: str = ""
    background: str = ""
    self_level: Literal["beginner", "familiar", "intermediate"]
    diagnostic_required: bool
    diagnostic_status: str
    source_scope_mode: Literal["auto", "selected"] = "auto"


class SkillSnapshot(StrictModel):
    id: str
    name: str
    description: str = ""


class EvidenceQueryPlan(StrictModel):
    query: str = Field(min_length=2, max_length=1000)
    required_concepts: list[str] = Field(min_length=1, max_length=8)

    @field_validator("query")
    @classmethod
    def clean_query(cls, value: str) -> str:
        return " ".join(value.split())

    @field_validator("required_concepts")
    @classmethod
    def clean_concepts(cls, values: list[str]) -> list[str]:
        cleaned: list[str] = []
        for value in values:
            concept = " ".join(value.split())[:80]
            if concept and concept not in cleaned:
                cleaned.append(concept)
        if not cleaned:
            raise ValueError("at least one concept is required")
        return cleaned


class EvidenceSummary(StrictModel):
    retrieval_run_id: str
    status: Literal["sufficient", "insufficient"]
    result_count: int = Field(ge=0)
    total_evidence_tokens: int = Field(ge=0)
    insufficiency_reason: str = ""


class WorkflowInterruptView(StrictModel):
    id: str = ""
    value: dict[str, Any]


class WorkflowResponse(StrictModel):
    thread_id: str
    status: Literal["running", "waiting_for_action", "waiting_for_user", "completed", "failed"]
    current_node: str
    waiting_for: str
    interrupt: WorkflowInterruptView | None = None
    state: dict[str, Any]

