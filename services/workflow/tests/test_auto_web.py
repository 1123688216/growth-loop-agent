from pathlib import Path

import pytest
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from growth_loop_workflow.graph import build_graph
from test_graph import settings, action, completed


@pytest.mark.asyncio
@pytest.mark.parametrize("local_ok,web_ok", [(True, False), (False, True), (False, False)])
async def test_auto_web_budget_and_restart(tmp_path: Path, local_ok: bool, web_ok: bool):
    database = tmp_path / "auto.sqlite"
    config = {"configurable": {"thread_id": "auto-test"}}
    initial = {"thread_id": "auto-test", "user_id": "u", "goal_id": "g", "progress": []}
    seen = []
    async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
        await saver.setup()
        graph = build_graph(saver, settings(database))
        result = await graph.ainvoke(initial, config=config)
        result = await graph.ainvoke(Command(resume=completed(action(result), {
            "auto_web": True,
            "goal": {"id": "g", "title": "学习状态机", "self_level": "beginner",
                     "diagnostic_required": False, "diagnostic_status": "skipped"},
        })), config=config)
        result = await graph.ainvoke(Command(resume=completed(action(result), {
            "skills": [{"id": "s", "name": "状态机", "description": "状态与转换"}],
        })), config=config)
        result = await graph.ainvoke(Command(resume=completed(action(result), {
            "evidence": {"retrieval_run_id": "r1", "status": "sufficient" if local_ok else "insufficient",
                         "result_count": 3 if local_ok else 0, "total_evidence_tokens": 600 if local_ok else 0,
                         "insufficiency_reason": "" if local_ok else "no_ready_sources"},
        })), config=config)
        pending = action(result)
        assert pending["action"] == ("generate_course" if local_ok else "supplement_web")

    # Resume the durable external action after a simulated service restart.
    async with AsyncSqliteSaver.from_conn_string(str(database)) as saver:
        await saver.setup()
        graph = build_graph(saver, settings(database))
        if not local_ok:
            seen.append(pending["action"])
            result = await graph.ainvoke(Command(resume=completed(pending, {"message": "已补充" if web_ok else "搜索失败"})), config=config)
            pending = action(result)
            assert pending['waiting_for'] == 'sources', 'Preview must pause before re-retrieval'
            result = await graph.ainvoke(Command(resume={'event': 'sources_updated'}), config=config)
            pending = action(result)
            assert pending["action"] == "retrieve_evidence"
            assert ":retrieve_evidence:2:" in pending["idempotency_key"]
            result = await graph.ainvoke(Command(resume=completed(pending, {
                "evidence": {"retrieval_run_id": "r2", "status": "sufficient" if web_ok else "insufficient",
                             "result_count": 3 if web_ok else 0, "total_evidence_tokens": 600 if web_ok else 0,
                             "insufficiency_reason": "" if web_ok else "no_matching_evidence"},
            })), config=config)
            pending = action(result)
        if local_ok or web_ok:
            assert pending["action"] == "generate_course"
            result = await graph.ainvoke(Command(resume=completed(pending, {"program_id": "p"})), config=config)
            assert result["status"] == "completed"
        else:
            assert pending["waiting_for"] == "sources"
            assert "搜索失败" in pending["message"]
            result = await graph.ainvoke(Command(resume={"event": "sources_updated"}), config=config)
            assert action(result)["action"] == "retrieve_evidence"
            assert result["web_attempted"] is True
        assert len(seen) == (0 if local_ok else 1)
