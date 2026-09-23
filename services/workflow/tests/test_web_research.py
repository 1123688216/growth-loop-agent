import pytest
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from growth_loop_workflow.settings import Settings
from growth_loop_workflow.web_research import build_web_graph


def test_structured_model_settings_are_provider_scoped():
    deepseek = Settings("test.sqlite", "", True, "https://api.deepseek.com/v1", "test", "deepseek-v4-flash")
    assert deepseek.structured_model_settings["extra_body"] == {"thinking": {"type": "disabled"}}
    other = Settings("test.sqlite", "", True, "https://other.example.com/v1", "test", "other")
    assert "extra_body" not in other.structured_model_settings


@pytest.mark.asyncio
async def test_preview_skips_model_ranking_and_preserves_feedback(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from growth_loop_workflow import web_research
    calls = []

    class FakeAgent:
        def __init__(self, *args, **kwargs):
            assert kwargs["output_type"] is web_research.QueryPlan

        async def run(self, prompt):
            calls.append(prompt)
            return SimpleNamespace(output=web_research.QueryPlan(query="Java 中文入门实例"))

    monkeypatch.setattr(web_research, "Agent", FakeAgent)
    settings = Settings(str(tmp_path / "preview.sqlite"), "", True, "https://api.deepseek.com", "test", "deepseek-v4-flash")
    async with AsyncSqliteSaver.from_conn_string(settings.database_path) as saver:
        await saver.setup()
        graph = build_web_graph(saver, settings)
        config = {"configurable": {"thread_id": "web-research:preview"}}
        result = await graph.ainvoke({"thread_id": "web-research:preview", "user_id": "u", "goal_id": "g",
                                     "query": "Java；上一批偏面试，要中文入门实例", "status": "running"}, config)
        result = await graph.ainvoke(reply(result, {"candidates": [{"id": "c", "title": "教程"}]}), config)
        assert len(calls) == 1
        assert "上一批偏面试" in calls[0]
        assert result["__interrupt__"][0].value["waiting_for"] == "web_selection"
        assert "result" not in result


def reply(result, data):
    value = result["__interrupt__"][0].value
    return Command(resume={"action": value["action"], "idempotency_key": value["idempotency_key"], "data": data})


@pytest.mark.asyncio
async def test_web_budget_and_restart_selection(tmp_path):
    path = str(tmp_path / "web.sqlite")
    settings = Settings(path, "", False, "", "", "")
    config = {"configurable": {"thread_id": "web-research:test"}}
    async with AsyncSqliteSaver.from_conn_string(path) as saver:
        await saver.setup()
        graph = build_web_graph(saver, settings)
        result = await graph.ainvoke({"thread_id": "web-research:test", "user_id": "u", "goal_id": "g", "query": "事务", "status": "running"}, config)
        result = await graph.ainvoke(reply(result, {"candidates": [{"id": "c", "title": "事务"}]}), config)
        assert result["attempt"] == 1
        assert result["__interrupt__"][0].value["waiting_for"] == "web_selection"
    async with AsyncSqliteSaver.from_conn_string(path) as saver:
        graph = build_web_graph(saver, settings)
        rejected = await graph.ainvoke(Command(resume={"candidate_id": "foreign"}), config)
        assert rejected["__interrupt__"][0].value["waiting_for"] == "web_selection"
        result = await graph.ainvoke(Command(resume={"candidate_id": "c", "description": "学习事务"}), config)
        assert result["__interrupt__"][0].value["action"] == "web_import"
        result = await graph.ainvoke(reply(result, {"sourceId": "s"}), config)
        assert result["status"] == "completed"
        assert result["attempt"] == 1


@pytest.mark.asyncio
async def test_empty_search_stops_after_one_call(tmp_path):
    path = str(tmp_path / "empty.sqlite")
    async with AsyncSqliteSaver.from_conn_string(path) as saver:
        await saver.setup()
        graph = build_web_graph(saver, Settings(path, "", False, "", "", ""))
        config = {"configurable": {"thread_id": "web-research:empty"}}
        result = await graph.ainvoke({"thread_id": "web-research:empty", "user_id": "u", "goal_id": "g", "query": "x", "status": "running"}, config)
        for _ in range(1):
            result = await graph.ainvoke(reply(result, {"candidates": []}), config)
        assert result["__interrupt__"][0].value["waiting_for"] == "web_selection"
        result = await graph.ainvoke(Command(resume={"candidate_id": ""}), config)
        assert result["status"] == "completed"
