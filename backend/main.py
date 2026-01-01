from __future__ import annotations

import os
import sys
from pathlib import Path
import asyncio
import logging
import re

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# Minimal .env loader (no extra deps). Looks for `backend/.env` and repo-root `.env`.
def _maybe_load_dotenv() -> None:
    def load_file(path: Path) -> None:
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except Exception:
            return

        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("'").strip('"')
            if not key or not value:
                continue
            os.environ.setdefault(key, value)

    here = Path(__file__).resolve()
    load_file(here.parent / ".env")
    load_file(here.parent.parent / ".env")


_maybe_load_dotenv()

# 允许两种启动方式：
# 1) 推荐：在项目根目录执行 `python -m backend.main` 或 `uvicorn backend.main:app`
# 2) 兼容：在 backend 目录直接执行 `python .\\main.py`
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.agents import build_domain_agents, get_router_agent
from backend.agents import get_guard_agent
from backend.agents.editor_intent_router import build_editor_intent_input, get_editor_intent_router_agent
from backend.agents.editor_planner import build_editor_planner_input, get_editor_planner_agent
from backend.agents.editor_tool_router import build_editor_router_input, get_editor_tool_router_agent
from backend.data_types import RunResult, SessionMemory, TaskPlan
from backend.data_types import PlannedTask, ToolName
from backend.executor import ToolPlanExecutor
from backend.memory import MemoryStore
from backend.orchestrator import Orchestrator
from backend.tools import build_tools
from backend.tools.specs import build_tool_docs
app = FastAPI(title="My Designer Agent Backend", version="0.1.0")

logger = logging.getLogger("backend")
if not logger.handlers:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

# CORS (dev-friendly; override via env CORS_ALLOW_ORIGINS="http://localhost:3456,http://127.0.0.1:3456")
_cors_env = os.getenv("CORS_ALLOW_ORIGINS", "").strip()
if _cors_env:
    _origins = [o.strip().rstrip("/") for o in _cors_env.split(",") if o.strip()]
else:
    _origins = [
        "http://localhost:3456",
        "http://127.0.0.1:3456",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class UserRequest(BaseModel):
    message: str


class RunRequest(BaseModel):
    session_id: str = "default"
    message: str | None = None
    plan: TaskPlan | None = None


class EditorRunRequest(BaseModel):
    session_id: str = "default"
    message: str
    workspace_root: str | None = None
    active_file_path: str | None = None
    active_content: str | None = None
    agent_context: str | None = None
    selected_snippets: list[dict] | None = None
    enable_search: bool = False
    thinking_mode: bool = False
    plan: TaskPlan | None = None


class ConfirmRequest(BaseModel):
    session_id: str = "default"
    run_id: str
    task_id: int
    confirmed: bool


planner = None
memory_store = MemoryStore()
orchestrator = None
editor_planner = None
editor_tool_router = None
editor_intent_router = None
pending_confirms: dict[tuple[str, str, int], asyncio.Future[bool]] = {}

_GEN_TOKEN_RE = re.compile(r"<GENERATED>-(\d+)(?:-([a-zA-Z0-9_]+))?")
_STEP_REF_RE = re.compile(r"\$step_(\d+)\.")


def _collect_step_refs(value) -> set[int]:
    refs: set[int] = set()
    if isinstance(value, str):
        for m in _GEN_TOKEN_RE.finditer(value):
            try:
                refs.add(int(m.group(1)))
            except Exception:
                pass
        for m in _STEP_REF_RE.finditer(value):
            try:
                refs.add(int(m.group(1)))
            except Exception:
                pass
        return refs
    if isinstance(value, list):
        for v in value:
            refs |= _collect_step_refs(v)
        return refs
    if isinstance(value, dict):
        for v in value.values():
            refs |= _collect_step_refs(v)
        return refs
    return refs


def _normalize_plan_deps(plan: TaskPlan) -> TaskPlan:
    # Ensure any referenced step id is listed in dep so executor can resolve <GENERATED>-N reliably.
    for t in plan.root:
        refs = _collect_step_refs(t.args)
        if not refs:
            continue
        # Remove self and future refs (best-effort; plan ids are 1..n)
        refs = {r for r in refs if isinstance(r, int) and r > 0 and r != t.id}
        if not refs:
            continue
        existing = set(t.dep or [])
        missing = sorted(refs - existing)
        if missing:
            t.dep = sorted(existing | set(missing))
    return plan


def get_planner():
    global planner
    if planner is None:
        planner = get_router_agent()
    return planner


def get_editor_planner():
    global editor_planner
    if editor_planner is None:
        editor_planner = get_editor_planner_agent()
    return editor_planner


def get_editor_tool_router():
    global editor_tool_router
    if editor_tool_router is None:
        editor_tool_router = get_editor_tool_router_agent()
    return editor_tool_router


def get_editor_intent_router():
    global editor_intent_router
    if editor_intent_router is None:
        editor_intent_router = get_editor_intent_router_agent()
    return editor_intent_router

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


@app.get("/api/editor/ping")
def editor_ping() -> dict:
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


@app.post("/api/editor/confirm")
async def editor_confirm(request: ConfirmRequest) -> dict:
    key = (request.session_id, request.run_id, request.task_id)
    fut = pending_confirms.get(key)
    if fut is None:
        raise HTTPException(status_code=404, detail="No pending confirmation for this run/task")
    if fut.done():
        return {"ok": True, "already": True}
    fut.set_result(bool(request.confirmed))
    return {"ok": True}


@app.post("/api/editor/run_stream")
async def editor_run_stream(request: EditorRunRequest) -> StreamingResponse:
    import json
    import time
    from pathlib import Path
    from agno.models.metrics import Metrics

    async def event_stream():
        run_id = f"run-{int(time.time() * 1000)}"
        try:
            logger.info(
                "editor_run_stream called: session_id=%s workspace_root=%s active_file_path=%s msg_len=%s",
                request.session_id,
                request.workspace_root,
                request.active_file_path,
                len(request.message or ""),
            )
            yield f"data: {json.dumps({'type': 'run_started', 'run_id': run_id}, ensure_ascii=False)}\n\n"

            # Token usage accumulator (best-effort).
            token_usage_total = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost": 0.0}

            def add_usage(m: Metrics | dict | None) -> None:
                if m is None:
                    return
                d = m.to_dict() if isinstance(m, Metrics) else (m if isinstance(m, dict) else None)
                if not isinstance(d, dict):
                    return
                token_usage_total["input_tokens"] += int(d.get("input_tokens") or 0)
                token_usage_total["output_tokens"] += int(d.get("output_tokens") or 0)
                token_usage_total["total_tokens"] += int(d.get("total_tokens") or 0)
                token_usage_total["cost"] += float(d.get("cost") or 0.0)

            plan = request.plan
            if plan is None:
                # Normalize active_file_path: if relative and workspace_root provided, treat as relative to workspace_root.
                active_file_path = request.active_file_path
                if active_file_path and request.workspace_root:
                    try:
                        p = Path(active_file_path)
                        if not p.is_absolute():
                            active_file_path = str(Path(request.workspace_root) / active_file_path)
                    except Exception:
                        pass
                logger.info("editor planner input: active_file_path=%s", active_file_path)

                # Stage 0: intent routing BEFORE planner/tool-router.
                # Note: intent routing does NOT need active_content; only edit intent should use full article content.
                intent = ""
                clarify_prompt = ""
                try:
                    intent_input = build_editor_intent_input(
                        message=request.message,
                        active_file_path=active_file_path,
                        selected_snippets=request.selected_snippets,
                        agent_context=request.agent_context,
                    )
                    intent_out = await asyncio.to_thread(get_editor_intent_router().run, intent_input)
                    add_usage(getattr(intent_out, "metrics", None))
                    intent_content = getattr(intent_out, "content", None)
                    if isinstance(intent_content, dict):
                        intent = str(intent_content.get("intent") or "").strip()
                        clarify_prompt = str(intent_content.get("clarify_prompt") or "").strip()
                    else:
                        intent = str(getattr(intent_content, "intent", "") or "").strip()
                        clarify_prompt = str(getattr(intent_content, "clarify_prompt", "") or "").strip()
                except Exception:
                    intent = ""
                    clarify_prompt = ""

                if intent in {"chat", "clarify"}:
                    prompt = clarify_prompt if (intent == "clarify" and clarify_prompt) else request.message
                    model_override = os.getenv("THINKING_MODEL") if bool(request.thinking_mode) else None
                    max_tokens = int(os.getenv("THINKING_MAX_TOKENS", "2048")) if bool(request.thinking_mode) else None

                    if intent == "chat" and bool(request.enable_search):
                        plan = TaskPlan.model_validate(
                            [
                                PlannedTask(
                                    task=ToolName.WEB_SEARCH,
                                    id=1,
                                    dep=[],
                                    args={"query": request.message, "limit": 5},
                                    label="联网搜索",
                                ).model_dump(mode="json"),
                                PlannedTask(
                                    task=ToolName.GENERATE_TEXT,
                                    id=2,
                                    dep=[1],
                                    args={
                                        "prompt": (
                                            "你可以参考联网搜索结果回答用户问题。若搜索结果不足以支撑结论，请说明不确定并建议下一步查询。\n\n"
                                            "搜索结果（JSON）：\n"
                                            "<GENERATED>-1-content\n\n"
                                            "用户问题：\n"
                                            f"{request.message}\n"
                                        ),
                                        **({"model": model_override} if model_override else {}),
                                        **({"max_tokens": max_tokens} if max_tokens is not None else {}),
                                    },
                                    label="生成回复",
                                ).model_dump(mode="json"),
                            ]
                        )
                    else:
                        plan = TaskPlan.model_validate(
                            [
                                PlannedTask(
                                    task=ToolName.GENERATE_TEXT,
                                    id=1,
                                    dep=[],
                                    args={
                                        "prompt": prompt,
                                        **({"model": model_override} if model_override else {}),
                                        **({"max_tokens": max_tokens} if max_tokens is not None else {}),
                                    },
                                    label="生成回复" if intent == "chat" else "引导澄清",
                                ).model_dump(mode="json")
                            ]
                        )
                elif intent == "review_article":
                    if not active_file_path:
                        plan = TaskPlan.model_validate(
                            [
                                PlannedTask(
                                    task=ToolName.GENERATE_TEXT,
                                    id=1,
                                    dep=[],
                                    args={"prompt": "请先打开要点评的文章（或粘贴全文/选中段落），我才能基于具体内容评价写作质量。"},
                                    label="引导补充信息",
                                ).model_dump(mode="json")
                            ]
                        )
                    else:
                        model_override = os.getenv("THINKING_MODEL") if bool(request.thinking_mode) else None
                        max_tokens = int(os.getenv("THINKING_MAX_TOKENS", "2048")) if bool(request.thinking_mode) else None
                        plan = TaskPlan.model_validate(
                            [
                                PlannedTask(
                                    task=ToolName.READ_FILE,
                                    id=1,
                                    dep=[],
                                    args={
                                        "file_path": active_file_path,
                                        "workspace_root": request.workspace_root,
                                        "max_chars": 200000,
                                    },
                                    label="读取当前文章",
                                ).model_dump(mode="json"),
                                PlannedTask(
                                    task=ToolName.GENERATE_TEXT,
                                    id=2,
                                    dep=[1],
                                    args={
                                        "prompt": (
                                            "请评价这篇文章写得怎么样（中文回答），并给出可执行的改进建议。\n"
                                            "要求：\n"
                                            "1) 一句话总评（优点+问题）\n"
                                            "2) 分项：结构逻辑、论证深度、语言风格、可读性/排版\n"
                                            "3) 给 5 条具体修改建议（可直接照做）\n"
                                            "4) 不要修改文件，只做点评\n\n"
                                            "文章内容如下：\n"
                                            "<GENERATED>-1-content"
                                        ),
                                        **({"model": model_override} if model_override else {}),
                                        **({"max_tokens": max_tokens} if max_tokens is not None else {}),
                                    },
                                    label="生成点评",
                                ).model_dump(mode="json"),
                            ]
                        )
                else:
                    # Stage 1: tool routing (shrink tool set for stability when tools grow).
                    allowed_tool_names = None
                    try:
                        router_input = build_editor_router_input(
                            message=request.message,
                            workspace_root=request.workspace_root,
                            active_file_path=active_file_path,
                            active_content=request.active_content,
                            selected_snippets=request.selected_snippets,
                        )
                        router_out = await asyncio.to_thread(get_editor_tool_router().run, router_input)
                        add_usage(getattr(router_out, "metrics", None))
                        route = getattr(router_out, "content", None)
                        if hasattr(route, "tools"):
                            allowed_tool_names = list(route.tools)  # ToolName values
                    except Exception:
                        allowed_tool_names = None

                    if not allowed_tool_names:
                        # Fallback: allow all registered tools.
                        allowed_tool_names = list(build_tools().keys())

                    planner_input = build_editor_planner_input(
                        session_id=request.session_id,
                        message=request.message,
                        workspace_root=request.workspace_root,
                        active_file_path=active_file_path,
                        active_content=request.active_content,
                        agent_context=request.agent_context,
                        selected_snippets=request.selected_snippets,
                        allowed_tools=[t.value if hasattr(t, "value") else str(t) for t in allowed_tool_names],
                        tool_docs=build_tool_docs(allowed_tool_names),
                    )
                    planner_out = await asyncio.to_thread(get_editor_planner().run, planner_input)
                    add_usage(getattr(planner_out, "metrics", None))
                    content = getattr(planner_out, "content", None)
                    if isinstance(content, TaskPlan):
                        plan = content
                    elif isinstance(content, list):
                        plan = TaskPlan.model_validate(content)
                    elif isinstance(content, str):
                        # Be tolerant: some models wrap plan as {"tasks":[...]} or return JSON as a string.
                        try:
                            parsed = json.loads(content)
                        except Exception as e:  # noqa: BLE001
                            raise RuntimeError(f"Invalid editor planner output (not JSON): {content!r}") from e

                        if isinstance(parsed, dict):
                            candidate = parsed.get("tasks") or parsed.get("plan") or parsed.get("root")
                            if isinstance(candidate, list):
                                plan = TaskPlan.model_validate(candidate)
                            elif isinstance(candidate, TaskPlan):
                                plan = candidate
                            else:
                                raise RuntimeError(f"Invalid editor planner output dict: {parsed!r}")
                        elif isinstance(parsed, list):
                            plan = TaskPlan.model_validate(parsed)
                        else:
                            raise RuntimeError(f"Invalid editor planner output JSON type: {type(parsed).__name__}")
                    else:
                        raise RuntimeError(f"Invalid editor planner output: {content!r}")

            # Normalize deps (models may forget to include dep ids even though they reference <GENERATED>-N).
            plan = _normalize_plan_deps(plan)

            yield f"data: {json.dumps({'type': 'plan', 'run_id': run_id, 'plan': plan.model_dump(mode='json')}, ensure_ascii=False)}\n\n"
            logger.info("editor plan steps=%s", len(plan.root))

            executor = ToolPlanExecutor(tools=build_tools(), memory=memory_store, default_workspace_root=request.workspace_root)

            q: "asyncio.Queue[str | None]" = asyncio.Queue()

            async def push_event(event: dict) -> None:
                event = {**event, "run_id": run_id}
                await q.put(f"data: {json.dumps(event, ensure_ascii=False)}\n\n")

            async def confirm_cb(task, resolved_args):
                key = (request.session_id, run_id, int(task.id))
                fut = asyncio.get_running_loop().create_future()
                pending_confirms[key] = fut
                try:
                    await push_event(
                        {
                            "type": "awaiting_confirmation",
                            "task_id": int(task.id),
                            "task": task.task,
                            "args": resolved_args,
                        }
                    )
                    return await fut
                finally:
                    pending_confirms.pop(key, None)

            async def worker():
                try:
                    result = await executor.run_async(
                        session_id=request.session_id,
                        plan=plan,
                        emit=push_event,
                        confirm=confirm_cb,
                    )
                    # Merge planning token usage + execution token usage.
                    merged = dict(token_usage_total)
                    exec_metrics = getattr(result, "metrics", None)
                    if isinstance(exec_metrics, dict):
                        merged["input_tokens"] += int(exec_metrics.get("input_tokens") or 0)
                        merged["output_tokens"] += int(exec_metrics.get("output_tokens") or 0)
                        merged["total_tokens"] += int(exec_metrics.get("total_tokens") or 0)
                        merged["cost"] += float(exec_metrics.get("cost") or 0.0)

                    result_dict = result.model_dump(mode="json")
                    result_dict["metrics"] = merged
                    await push_event({"type": "run_completed", "result": result_dict})
                except Exception as e:  # noqa: BLE001
                    logger.exception("editor_run_stream worker error")
                    await q.put(
                        "event: error\n"
                        f"data: {json.dumps({'type': 'error', 'error': str(e), 'run_id': run_id}, ensure_ascii=False)}\n\n"
                    )
                finally:
                    await q.put(None)

            worker_task = asyncio.create_task(worker())
            try:
                while True:
                    item = await q.get()
                    if item is None:
                        break
                    yield item
            finally:
                await worker_task

            yield "event: done\ndata: {\"type\":\"done\"}\n\n"
        except Exception as error:
            yield (
                "event: error\n"
                f"data: {json.dumps({'type': 'error', 'error': str(error), 'run_id': run_id}, ensure_ascii=False)}\n\n"
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/session/{session_id}", response_model=SessionMemory)
def get_session(session_id: str) -> SessionMemory:
    return memory_store.get(session_id)


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8060"))
    uvicorn.run(app, host=host, port=port)
