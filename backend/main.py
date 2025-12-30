from __future__ import annotations

import os
import sys
from pathlib import Path
import asyncio

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# 允许两种启动方式：
# 1) 推荐：在项目根目录执行 `python -m backend.main` 或 `uvicorn backend.main:app`
# 2) 兼容：在 backend 目录直接执行 `python .\\main.py`
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.agents import build_domain_agents, get_router_agent
from backend.agents import get_guard_agent
from backend.data_types import RunResult, SessionMemory, TaskPlan
from backend.executor import ToolPlanExecutor
from backend.memory import MemoryStore
from backend.orchestrator import Orchestrator
from backend.tools import build_tools
app = FastAPI(title="My Designer Agent Backend", version="0.1.0")


class UserRequest(BaseModel):
    message: str


class RunRequest(BaseModel):
    session_id: str = "default"
    message: str | None = None
    plan: TaskPlan | None = None


planner = None
memory_store = MemoryStore()
orchestrator = None


def get_planner():
    global planner
    if planner is None:
        planner = get_router_agent()
    return planner


def get_orchestrator() -> Orchestrator:
    global orchestrator
    if orchestrator is None:
        guard_enabled = os.getenv("ENABLE_GUARD", "true").strip().lower() in {"1", "true", "yes", "on"}
        orchestrator = Orchestrator(
            guard=get_guard_agent(),
            guard_enabled=guard_enabled,
            router=get_planner(),
            domain_agents=build_domain_agents(),
            tools=build_tools(),
            memory=memory_store,
        )
    return orchestrator


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/plan", response_model=TaskPlan)
def create_plan(request: UserRequest) -> TaskPlan:
    try:
        # tool-level plan（由 Router + DomainAgent 编译得到）
        route, tool_plan, _reviews = asyncio.run(
            get_orchestrator().compile_plan(session_id="default", message=request.message)
        )
        return tool_plan
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/api/plan_stream")
def create_plan_stream(request: UserRequest) -> StreamingResponse:
    """
    SSE 流式输出：把 agno 的 RunOutputEvent / RunOutput 逐条推给前端。

    前端按 SSE 解析，每条消息的 data 都是 JSON：
    - RunStartedEvent / RunContentEvent / RunCompletedEvent / RunErrorEvent ...
    """

    import json

    def event_stream():
        try:
            # Guard：在进入 Router Planner 前做边界判定
            guard_enabled = os.getenv("ENABLE_GUARD", "true").strip().lower() in {"1", "true", "yes", "on"}
            if guard_enabled:
                guard = get_guard_agent().run(
                    json.dumps({"session_id": "default", "message": request.message}, ensure_ascii=False)
                )
                guard_content = getattr(guard, "content", None)
                if isinstance(guard_content, dict):
                    allow = bool(guard_content.get("allow", True))
                    if not allow:
                        yield f"event: blocked\ndata: {json.dumps(guard_content, ensure_ascii=False)}\n\n"
                        yield "event: done\ndata: {}\n\n"
                        return

            # stream=True 让底层模型返回增量；stream_events=True 让 agno 产出事件流。
            for item in get_planner().run(request.message, stream=True, stream_events=True):
                payload = item.to_dict() if hasattr(item, "to_dict") else item
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

            yield "event: done\ndata: {}\n\n"
        except Exception as error:
            yield f"event: error\ndata: {json.dumps({'error': str(error)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/run", response_model=RunResult)
def run(request: RunRequest) -> RunResult:
    try:
        plan = request.plan
        if plan is None:
            if not request.message:
                raise ValueError("Either 'message' or 'plan' is required")
            try:
                _route, plan, _reviews = asyncio.run(
                    get_orchestrator().compile_plan(session_id=request.session_id, message=request.message)
                )
            except PermissionError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error

        executor = ToolPlanExecutor(tools=build_tools(), memory=memory_store)
        return asyncio.run(executor.run_async(session_id=request.session_id, plan=plan))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/api/run_stream")
async def run_stream(request: RunRequest) -> StreamingResponse:
    import json
    import asyncio

    async def event_stream():
        try:
            yield f"data: {json.dumps({'type': 'status', 'message': '正在拆解设计需求...'}, ensure_ascii=False)}\n\n"

            if request.plan is not None:
                plan = request.plan
                yield f"data: {json.dumps({'type': 'plan', 'plan': plan.model_dump(mode='json')}, ensure_ascii=False)}\n\n"
                executor = ToolPlanExecutor(tools=build_tools(), memory=memory_store)
                async for event in executor.run_plan(session_id=request.session_id, plan=plan):
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            else:
                if not request.message:
                    raise ValueError("Either 'message' or 'plan' is required")
                async for event in get_orchestrator().run_stream(
                    session_id=request.session_id,
                    message=request.message,
                ):
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

            yield "event: done\ndata: {}\n\n"
        except Exception as error:
            yield f"event: error\ndata: {json.dumps({'error': str(error)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/session/{session_id}", response_model=SessionMemory)
def get_session(session_id: str) -> SessionMemory:
    return memory_store.get(session_id)


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8060"))
    uvicorn.run(app, host=host, port=port)
