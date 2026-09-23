from __future__ import annotations

import hashlib
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from .models import (
    EvidenceQueryPlan,
    EvidenceSummary,
    ExternalActionResult,
    GoalSnapshot,
    SkillSnapshot,
    UserResume,
)
from .planner import PlannerDependencies, build_evidence_query_plan
from .settings import Settings


class WorkflowState(TypedDict, total=False):
    thread_id: str
    user_id: str
    goal_id: str
    require_sources: bool
    auto_web: bool
    lesson_level_gate: bool
    knowledge_advisory: bool
    web_attempted: bool
    web_message: str
    goal: dict[str, Any]
    skills: list[dict[str, Any]]
    program_id: str
    diagnostic_id: str
    query_plan: dict[str, Any]
    query_plan_mode: Literal["llm", "rules"]
    evidence: dict[str, Any]
    retrieval_attempt: int
    current_node: str
    waiting_for: str
    status: str
    progress: list[dict[str, Any]]


def _progress(state: WorkflowState, stage: str, percent: int, message: str) -> list[dict[str, Any]]:
    existing = list(state.get("progress", []))
    existing.append({"stage": stage, "percent": percent, "message": message})
    return existing[-24:]


def _idempotency_key(state: WorkflowState, action: str, attempt: int = 0) -> str:
    raw = f"{state['thread_id']}:{action}:{attempt}"
    suffix = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]
    return f"{state['thread_id']}:{action}:{attempt}:{suffix}"


def _external_action(
    state: WorkflowState,
    action: str,
    payload: dict[str, Any],
    *,
    attempt: int = 0,
) -> ExternalActionResult:
    idempotency_key = _idempotency_key(state, action, attempt)
    resumed = interrupt({
        "kind": "action",
        "action": action,
        "idempotency_key": idempotency_key,
        "payload": payload,
    })
    result = ExternalActionResult.model_validate(resumed)
    if result.action != action or result.idempotency_key != idempotency_key:
        raise ValueError("resume payload does not match the pending workflow action")
    return result


async def load_goal(state: WorkflowState) -> dict[str, Any]:
    result = _external_action(state, "load_goal", {"goal_id": state["goal_id"]})
    goal = GoalSnapshot.model_validate(result.data.get("goal"))
    program_id = str(result.data.get("program_id") or "")
    return {
        "goal": goal.model_dump(),
        "auto_web": bool(result.data.get("auto_web", state.get("auto_web", True))),
        "lesson_level_gate": bool(result.data.get("lesson_level_gate", False)),
        "program_id": program_id,
        "current_node": "load_goal",
        "waiting_for": "",
        "status": "running",
        "progress": _progress(state, "load_goal", 8, "目标和学习偏好已读取"),
    }


def route_after_goal(state: WorkflowState) -> str:
    return "finish" if state.get("program_id") else "ensure_skills"


async def ensure_skills(state: WorkflowState) -> dict[str, Any]:
    result = _external_action(state, "ensure_skills", {"goal_id": state["goal_id"]})
    skills = [SkillSnapshot.model_validate(value).model_dump() for value in result.data.get("skills", [])]
    if not skills:
        raise ValueError("skill map is empty")
    return {
        "skills": skills,
        "current_node": "ensure_skills",
        "progress": _progress(state, "skill_map", 28, f"能力地图已准备，共 {len(skills)} 项能力"),
    }


def route_after_skills(state: WorkflowState) -> str:
    goal = GoalSnapshot.model_validate(state["goal"])
    if goal.diagnostic_required and goal.diagnostic_status != "completed":
        return "prepare_diagnostic"
    return "generate_course" if state.get("lesson_level_gate") else "plan_retrieval"


async def prepare_diagnostic(state: WorkflowState) -> dict[str, Any]:
    result = _external_action(state, "prepare_diagnostic", {"goal_id": state["goal_id"]})
    diagnostic_id = str(result.data.get("diagnostic_id") or "")
    if not diagnostic_id:
        raise ValueError("diagnostic action did not return an assessment id")
    return {
        "diagnostic_id": diagnostic_id,
        "current_node": "prepare_diagnostic",
        "progress": _progress(state, "diagnostic", 42, "初始诊断已准备，等待用户逐题完成"),
    }


async def wait_diagnostic(state: WorkflowState) -> dict[str, Any]:
    resumed = UserResume.model_validate(interrupt({
        "kind": "user_input",
        "waiting_for": "diagnostic",
        "diagnostic_id": state.get("diagnostic_id", ""),
        "message": "请完成初始诊断后继续同一工作流。",
    }))
    if resumed.event != "diagnostic_completed":
        raise ValueError("workflow is waiting for diagnostic_completed")
    return {
        "current_node": "wait_diagnostic",
        "waiting_for": "",
        "status": "running",
        "progress": _progress(state, "diagnostic", 52, "诊断证据已确认，开始规划资料检索"),
    }


async def plan_retrieval(state: WorkflowState, *, settings: Settings) -> dict[str, Any]:
    goal = GoalSnapshot.model_validate(state["goal"])
    skills = [SkillSnapshot.model_validate(value) for value in state.get("skills", [])]
    plan, mode = await build_evidence_query_plan(settings, PlannerDependencies(goal=goal, skills=skills))
    return {
        "query_plan": plan.model_dump(),
        "query_plan_mode": mode,
        "current_node": "plan_retrieval",
        "progress": _progress(state, "retrieval_plan", 58, "课程资料检索计划已生成"),
    }


async def retrieve_evidence(state: WorkflowState) -> dict[str, Any]:
    attempt = int(state.get("retrieval_attempt", 0))
    plan = EvidenceQueryPlan.model_validate(state["query_plan"])
    result = _external_action(
        state,
        "retrieve_evidence",
        {
            "goal_id": state["goal_id"],
            "query": plan.query,
            "required_concepts": plan.required_concepts,
        },
        attempt=attempt,
    )
    evidence = EvidenceSummary.model_validate(result.data.get("evidence"))
    return {
        "evidence": evidence.model_dump(),
        "knowledge_advisory": bool(result.data.get("knowledge_advisory", False)),
        "current_node": "retrieve_evidence",
        "progress": _progress(
            state,
            "retrieval",
            68,
            f"资料检索完成，共固定 {evidence.result_count} 条证据快照",
        ),
    }


def route_after_retrieval(state: WorkflowState) -> str:
    if state.get("knowledge_advisory"):
        return "generate_course"
    evidence = EvidenceSummary.model_validate(state["evidence"])
    if evidence.status == "insufficient" and state.get("auto_web", True):
        return "wait_sources" if state.get("web_attempted") else "supplement_web"
    if evidence.status == "insufficient" and state.get("require_sources", False):
        return "wait_sources"
    return "generate_course"


async def supplement_web(state: WorkflowState) -> dict[str, Any]:
    result = _external_action(state, "supplement_web", {
        "query": state.get("query_plan", {}).get("query", state["goal"]["title"]),
        "reason": state["evidence"].get("insufficiency_reason", ""),
    })
    message = str(result.data.get("message", "联网补充已结束，重新检查资料是否足够。"))
    return {
        "web_attempted": True,
        "web_message": message,
        "retrieval_attempt": int(state.get("retrieval_attempt", 0)) + 1,
        "current_node": "supplement_web",
        "progress": _progress(state, "sources", 67, message),
    }


async def wait_sources(state: WorkflowState) -> dict[str, Any]:
    evidence = EvidenceSummary.model_validate(state["evidence"])
    resumed = UserResume.model_validate(interrupt({
        "kind": "user_input",
        "waiting_for": "sources",
        "retrieval_run_id": evidence.retrieval_run_id,
        "reason": evidence.insufficiency_reason,
        "message": (state.get("web_message", "") + " 资料仍不足，请补充资料或调整目标资料范围后继续。").strip(),
    }))
    if resumed.event != "sources_updated":
        raise ValueError("workflow is waiting for sources_updated")
    attempt = int(state.get("retrieval_attempt", 0)) + 1
    return {
        "retrieval_attempt": attempt,
        "current_node": "wait_sources",
        "waiting_for": "",
        "status": "running",
        "progress": _progress(state, "sources", 60, "资料范围已更新，重新执行检索"),
    }


async def generate_course(state: WorkflowState) -> dict[str, Any]:
    evidence = EvidenceSummary.model_validate(state.get("evidence") or {
        "retrieval_run_id": "", "status": "insufficient", "result_count": 0, "total_evidence_tokens": 0,
    })
    result = _external_action(state, "generate_course", {
        "goal_id": state["goal_id"],
        "retrieval_run_id": evidence.retrieval_run_id,
        "evidence_status": evidence.status,
    })
    program_id = str(result.data.get("program_id") or "")
    if not program_id:
        raise ValueError("course action did not return a program id")
    return {
        "program_id": program_id,
        "current_node": "generate_course",
        "progress": _progress(state, "course", 96, "课程骨架和首节内容已生成"),
    }


async def finish(state: WorkflowState) -> dict[str, Any]:
    return {
        "current_node": "complete",
        "waiting_for": "",
        "status": "completed",
        "progress": _progress(state, "complete", 100, "学习路径已准备完成"),
    }


def build_graph(checkpointer: Any, settings: Settings):
    builder = StateGraph(WorkflowState)
    builder.add_node("load_goal", load_goal)
    builder.add_node("ensure_skills", ensure_skills)
    builder.add_node("prepare_diagnostic", prepare_diagnostic)
    builder.add_node("wait_diagnostic", wait_diagnostic)

    async def configured_plan(state: WorkflowState) -> dict[str, Any]:
        return await plan_retrieval(state, settings=settings)

    builder.add_node("plan_retrieval", configured_plan)
    builder.add_node("retrieve_evidence", retrieve_evidence)
    builder.add_node("supplement_web", supplement_web)
    builder.add_node("wait_sources", wait_sources)
    builder.add_node("generate_course", generate_course)
    builder.add_node("finish", finish)
    builder.add_edge(START, "load_goal")
    builder.add_conditional_edges("load_goal", route_after_goal, {"finish": "finish", "ensure_skills": "ensure_skills"})
    builder.add_conditional_edges(
        "ensure_skills",
        route_after_skills,
        {"prepare_diagnostic": "prepare_diagnostic", "plan_retrieval": "plan_retrieval", "generate_course": "generate_course"},
    )
    builder.add_edge("prepare_diagnostic", "wait_diagnostic")
    builder.add_conditional_edges("wait_diagnostic", lambda state: "generate_course" if state.get("lesson_level_gate") else "plan_retrieval",
                                  {"generate_course": "generate_course", "plan_retrieval": "plan_retrieval"})
    builder.add_edge("plan_retrieval", "retrieve_evidence")
    builder.add_conditional_edges(
        "retrieve_evidence",
        route_after_retrieval,
        {"wait_sources": "wait_sources", "generate_course": "generate_course", "supplement_web": "supplement_web"},
    )
    builder.add_edge("supplement_web", "wait_sources")
    builder.add_edge("wait_sources", "plan_retrieval")
    builder.add_edge("generate_course", "finish")
    builder.add_edge("finish", END)
    return builder.compile(checkpointer=checkpointer)
