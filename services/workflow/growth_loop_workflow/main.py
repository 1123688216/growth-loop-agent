from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from .graph import WorkflowState, build_graph
from .models import AdvanceRequest, WorkflowInterruptView, WorkflowResponse
from .settings import Settings
from .web_research import build_web_graph
from pydantic import BaseModel, Field


settings = Settings.from_env()


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with AsyncSqliteSaver.from_conn_string(settings.database_path) as checkpointer:
        await checkpointer.setup()
        app.state.workflow_graph = build_graph(checkpointer, settings)
        app.state.web_graph = build_web_graph(checkpointer, settings)
        yield


app = FastAPI(title="Growth Loop Workflow", version="0.1.0", lifespan=lifespan)


class WebAdvance(BaseModel):
    thread_id: str = Field(pattern=r"^web-research:", max_length=200)
    user_id: str
    goal_id: str
    query: str = Field(default="", max_length=2000)
    resume: dict[str, Any] | None = None


def authorize(x_workflow_token: str | None = Header(default=None)) -> None:
    if settings.service_token and x_workflow_token != settings.service_token:
        raise HTTPException(status_code=401, detail="invalid workflow service token")


def _config(thread_id: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread_id}}


def _interrupt_view(result: dict[str, Any]) -> WorkflowInterruptView | None:
    interrupts = result.get("__interrupt__") or []
    if not interrupts:
        return None
    item = interrupts[0]
    value = item.value if hasattr(item, "value") else item.get("value", {})
    interrupt_id = getattr(item, "id", "")
    return WorkflowInterruptView(id=str(interrupt_id or ""), value=dict(value))


async def _response(graph: Any, thread_id: str, result: dict[str, Any] | None = None) -> WorkflowResponse:
    snapshot = await graph.aget_state(_config(thread_id))
    state = dict(snapshot.values or {})
    interrupt_view = _interrupt_view(result or {})
    if interrupt_view is None and snapshot.tasks:
        for task in snapshot.tasks:
            if task.interrupts:
                item = task.interrupts[0]
                interrupt_view = WorkflowInterruptView(id=str(getattr(item, "id", "") or ""), value=dict(item.value))
                break
    if interrupt_view:
        kind = interrupt_view.value.get("kind")
        status = "waiting_for_action" if kind == "action" else "waiting_for_user"
        waiting_for = str(interrupt_view.value.get("action") or interrupt_view.value.get("waiting_for") or "")
        current_node = snapshot.next[0] if snapshot.next else str(state.get("current_node") or "")
    elif not snapshot.next and state.get("status") == "completed":
        status = "completed"
        waiting_for = ""
        current_node = "complete"
    else:
        status = "running"
        waiting_for = str(state.get("waiting_for") or "")
        current_node = snapshot.next[0] if snapshot.next else str(state.get("current_node") or "")
    return WorkflowResponse(
        thread_id=thread_id,
        status=status,
        current_node=current_node,
        waiting_for=waiting_for,
        interrupt=interrupt_view,
        state=state,
    )


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "checkpoint": "sqlite",
        "query_planner": "pydantic_ai" if settings.llm_ready else "rules",
    }


@app.post("/v1/web-research/advance", response_model=WorkflowResponse, dependencies=[Depends(authorize)])
async def advance_web(body: WebAdvance, request: Request):
    graph = request.app.state.web_graph
    config = _config(body.thread_id)
    snapshot = await graph.aget_state(config)
    if snapshot.values:
        if snapshot.values.get("user_id") != body.user_id or snapshot.values.get("goal_id") != body.goal_id:
            raise HTTPException(status_code=409, detail="thread ownership mismatch")
        if not snapshot.next:
            return await _response(graph, body.thread_id)
        if body.resume is None:
            if any(task.interrupts for task in snapshot.tasks):
                return await _response(graph, body.thread_id)
            # An exception in plan/review is not a user interrupt: resume the failed node.
            invocation = None
        else:
            invocation = Command(resume=body.resume)
    else:
        if body.resume is not None or not body.query.strip():
            raise HTTPException(status_code=409, detail="start requires query")
        invocation = {"thread_id": body.thread_id, "user_id": body.user_id, "goal_id": body.goal_id,
                      "query": body.query, "attempt": 0, "status": "running"}
    try:
        result = await graph.ainvoke(invocation, config=config)
        return await _response(graph, body.thread_id, result)
    except Exception as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/goal-onboarding/advance", response_model=WorkflowResponse, dependencies=[Depends(authorize)])
async def advance(body: AdvanceRequest, request: Request) -> WorkflowResponse:
    graph = request.app.state.workflow_graph
    config = _config(body.thread_id)
    snapshot = await graph.aget_state(config)
    values = dict(snapshot.values or {})
    if values:
        if values.get("user_id") != body.user_id or values.get("goal_id") != body.goal_id:
            raise HTTPException(status_code=409, detail="thread is already bound to another user or goal")
        if body.resume is None:
            return await _response(graph, body.thread_id)
        invocation: WorkflowState | Command = Command(resume=body.resume)
    else:
        if body.resume is not None:
            raise HTTPException(status_code=409, detail="cannot resume a workflow before it starts")
        invocation = {
            "thread_id": body.thread_id,
            "user_id": body.user_id,
            "goal_id": body.goal_id,
            "require_sources": body.require_sources,
            "retrieval_attempt": 0,
            "current_node": "start",
            "waiting_for": "",
            "status": "running",
            "progress": [],
        }
    try:
        result = await graph.ainvoke(invocation, config=config)
        return await _response(graph, body.thread_id, result)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/v1/goal-onboarding/state/{thread_id}", response_model=WorkflowResponse, dependencies=[Depends(authorize)])
async def state(thread_id: str, request: Request) -> WorkflowResponse:
    graph = request.app.state.workflow_graph
    snapshot = await graph.aget_state(_config(thread_id))
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="workflow thread not found")
    return await _response(graph, thread_id)
