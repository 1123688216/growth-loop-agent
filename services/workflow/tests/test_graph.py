from __future__ import annotations

from pathlib import Path

import pytest
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from growth_loop_workflow.graph import build_graph, route_after_retrieval
from growth_loop_workflow.settings import Settings


def settings(database_path: Path) -> Settings:
    return Settings(
        database_path=str(database_path),
        service_token="",
        llm_enabled=False,
        llm_base_url="",
        llm_api_key="",
        llm_model="",
    )


def test_advisory_legacy_retrieval_continues_without_claiming_evidence():
    assert route_after_retrieval({"knowledge_advisory": True, "auto_web": True, "require_sources": True}) == "generate_course"


def action(result):
    item = result["__interrupt__"][0]
    return item.value


def completed(pending, data):
    return {
        "event": "action_completed",
        "action": pending["action"],
        "idempotency_key": pending["idempotency_key"],
        "data": data,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("diagnostic", [False, True])
async def test_lesson_gate_skips_goal_retrieval_and_resumes(tmp_path: Path, diagnostic: bool):
    database = tmp_path / "lesson-gate.sqlite"
    config = {"configurable": {"thread_id": "lesson-gate-test"}}
    initial = {"thread_id": "lesson-gate-test", "user_id": "u", "goal_id": "g",
               "require_sources": True, "auto_web": True, "retrieval_attempt": 0,
               "status": "running", "progress": []}
    async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
        await saver.setup()
        graph = build_graph(saver, settings(database))
        result = await graph.ainvoke(initial, config=config)
        result = await graph.ainvoke(Command(resume=completed(action(result), {
            "lesson_level_gate": True, "program_id": "",
            "goal": {"id": "g", "title": "Java", "description": "learn", "background": "",
                     "self_level": "familiar" if diagnostic else "beginner",
                     "diagnostic_required": diagnostic,
                     "diagnostic_status": "pending" if diagnostic else "skipped",
                     "source_scope_mode": "auto"},
        })), config=config)
        result = await graph.ainvoke(Command(resume=completed(action(result), {
            "skills": [{"id": "s", "name": "types", "description": "reference types"}],
        })), config=config)
        if diagnostic:
            assert action(result)["action"] == "prepare_diagnostic"
            result = await graph.ainvoke(Command(resume=completed(action(result), {"diagnostic_id": "d"})), config=config)
            result = await graph.ainvoke(Command(resume={"event": "diagnostic_completed"}), config=config)
        pending = action(result)
        assert pending["action"] == "generate_course", "No separate whole-goal RAG before the lesson gate"
    async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
        await saver.setup()
        graph = build_graph(saver, settings(database))
        # Business service can wait for source selection without acknowledging this action.
        replay = await graph.ainvoke(None, config=config)
        assert action(replay) == pending
        result = await graph.ainvoke(Command(resume=completed(pending, {"program_id": "p"})), config=config)
        assert result["status"] == "completed"


@pytest.mark.asyncio
async def test_beginner_flow_survives_checkpoint_restart(tmp_path: Path):
    database = tmp_path / "workflow.sqlite"
    config = {"configurable": {"thread_id": "thread-beginner-001"}}
    initial = {
        "thread_id": "thread-beginner-001",
        "user_id": "user-1",
        "goal_id": "goal-1",
        "require_sources": False,
        "auto_web": False,
        "retrieval_attempt": 0,
        "status": "running",
        "progress": [],
    }
    async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
        await saver.setup()
        graph = build_graph(saver, settings(database))
        result = await graph.ainvoke(initial, config=config)
        pending = action(result)
        result = await graph.ainvoke(Command(resume=completed(pending, {
            "goal": {
                "id": "goal-1", "title": "学习状态机", "description": "能写出状态机",
                "background": "", "self_level": "beginner", "diagnostic_required": False,
                "diagnostic_status": "skipped", "source_scope_mode": "auto",
            },
            "program_id": "",
        })), config=config)
        pending = action(result)
        result = await graph.ainvoke(Command(resume=completed(pending, {
            "skills": [{"id": "skill-1", "name": "状态建模", "description": "定义状态与转换"}],
        })), config=config)
        pending = action(result)
        assert pending["action"] == "retrieve_evidence"

    async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
        await saver.setup()
        graph = build_graph(saver, settings(database))
        result = await graph.ainvoke(Command(resume=completed(pending, {
            "evidence": {
                "retrieval_run_id": "retrieval-1", "status": "insufficient", "result_count": 0,
                "total_evidence_tokens": 0, "insufficiency_reason": "no_source",
            },
        })), config=config)
        pending = action(result)
        assert pending["action"] == "generate_course"
        result = await graph.ainvoke(Command(resume=completed(pending, {"program_id": "program-1"})), config=config)
        assert result["status"] == "completed"
        assert result["program_id"] == "program-1"


@pytest.mark.asyncio
async def test_diagnostic_and_source_interrupts_resume_same_thread(tmp_path: Path):
    database = tmp_path / "workflow.sqlite"
    config = {"configurable": {"thread_id": "thread-diagnostic-001"}}
    initial = {
        "thread_id": "thread-diagnostic-001", "user_id": "user-1", "goal_id": "goal-1",
        "require_sources": True, "auto_web": False, "retrieval_attempt": 0, "status": "running", "progress": [],
    }
    async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
        await saver.setup()
        graph = build_graph(saver, settings(database))
        result = await graph.ainvoke(initial, config=config)
        pending = action(result)
        result = await graph.ainvoke(Command(resume=completed(pending, {
            "goal": {
                "id": "goal-1", "title": "学习 LangGraph", "description": "实现可恢复流程",
                "background": "", "self_level": "familiar", "diagnostic_required": True,
                "diagnostic_status": "pending", "source_scope_mode": "selected",
            }, "program_id": "",
        })), config=config)
        pending = action(result)
        result = await graph.ainvoke(Command(resume=completed(pending, {
            "skills": [{"id": "skill-1", "name": "中断恢复", "description": "正确使用 interrupt"}],
        })), config=config)
        pending = action(result)
        assert pending["action"] == "prepare_diagnostic"
        result = await graph.ainvoke(Command(resume=completed(pending, {"diagnostic_id": "diagnostic-1"})), config=config)
        assert action(result)["waiting_for"] == "diagnostic"
        result = await graph.ainvoke(Command(resume={"event": "diagnostic_completed"}), config=config)
        pending = action(result)
        assert pending["action"] == "retrieve_evidence"
        result = await graph.ainvoke(Command(resume=completed(pending, {
            "evidence": {
                "retrieval_run_id": "retrieval-1", "status": "insufficient", "result_count": 0,
                "total_evidence_tokens": 0, "insufficiency_reason": "no_matching_chunks",
            },
        })), config=config)
        assert action(result)["waiting_for"] == "sources"
        result = await graph.ainvoke(Command(resume={"event": "sources_updated"}), config=config)
        pending = action(result)
        assert pending["action"] == "retrieve_evidence"
        assert ":retrieve_evidence:1:" in pending["idempotency_key"]
