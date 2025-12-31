from __future__ import annotations

import asyncio
import os
import re
import threading
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Set, Tuple

from agno.tools import Function

from .data_types import (
    Asset,
    AssetType,
    ExecutedStep,
    PlannedTask,
    RunResult,
    StepOutput,
    StepStatus,
    TaskPlan,
    ToolName,
    ToolResult,
    ToolArtifactType,
)
from .memory import MemoryStore
from .tools.llm_text import iter_generate_text_deltas


EventEmitter = Callable[[Dict[str, Any]], Awaitable[None]]
ConfirmCallback = Callable[[PlannedTask, Dict[str, Any]], Awaitable[bool]]

CONFIRM_TASKS: Set[ToolName] = {ToolName.WRITE_FILE, ToolName.APPLY_PATCH, ToolName.REPLACE_LINES, ToolName.REPLACE_SNIPPET}

_REF_RE = re.compile(r"^\$step_(\d+)\.(.+)$")
_GEN_RE = re.compile(r"^<GENERATED>-(\d+)(?:-(.+))?$")
_GEN_TOKEN_RE = re.compile(r"<GENERATED>-(\d+)(?:-([a-zA-Z0-9_]+))?")


def _get_by_path(obj: Any, path: str) -> Any:
    current = obj
    for part in path.split("."):
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(part)
        else:
            current = getattr(current, part, None)
    return current


def _resolve_legacy_refs(value: Any, step_results: Dict[int, ExecutedStep]) -> Any:
    if isinstance(value, str):
        match = _REF_RE.match(value.strip())
        if not match:
            return value
        step_id = int(match.group(1))
        path = match.group(2)
        step = step_results.get(step_id)
        if step is None:
            return value
        resolved = _get_by_path(step, path)
        return resolved if resolved is not None else value

    if isinstance(value, list):
        return [_resolve_legacy_refs(item, step_results) for item in value]
    if isinstance(value, dict):
        return {k: _resolve_legacy_refs(v, step_results) for k, v in value.items()}
    return value


@dataclass
class ExecutorConfig:
    max_retries: int = 2
    retry_backoff_s: float = 0.5


class ToolPlanExecutor:
    """
    纯执行层：执行 tool-level TaskPlan，负责 DAG、<GENERATED>-id 引用、重试、事件流。
    """

    def __init__(
        self,
        *,
        tools: Dict[ToolName, Function],
        memory: MemoryStore,
        default_workspace_root: Optional[str] = None,
        config: Optional[ExecutorConfig] = None,
    ) -> None:
        self._tools = tools
        self._memory = memory
        self._default_workspace_root = default_workspace_root
        self._config = config or ExecutorConfig(
            max_retries=int(os.getenv("EXECUTOR_MAX_RETRIES", "2")),
            retry_backoff_s=float(os.getenv("EXECUTOR_RETRY_BACKOFF_S", "0.5")),
        )
        self.step_memory: Dict[int, StepOutput] = {}

    def _resolve_argument(self, arg_value: Any, *, allowed_dep_ids: Set[int]) -> Any:
        if not isinstance(arg_value, str):
            return arg_value
        raw = arg_value.strip()
        if "<GENERATED>-" not in raw:
            return raw

        def resolve_token(dep_id: int, field: Optional[str]) -> str:
            if dep_id not in allowed_dep_ids:
                raise ValueError(f"Reference <GENERATED>-{dep_id} requires dep_id in dep list: {sorted(allowed_dep_ids)}")
            output = self.step_memory.get(dep_id)
            if output is None:
                raise ValueError(f"Dependency task {dep_id} not found or not completed")
            content = None
            if isinstance(output.data, dict):
                content = output.data.get("content")

            if not field:
                return str(content or output.asset_uri or output.asset_id or f"<GENERATED>-{dep_id}")
            if field in {"asset_id", "id"}:
                return str(output.asset_id or f"<GENERATED>-{dep_id}-{field}")
            if field in {"asset_uri", "uri", "url"}:
                return str(output.asset_uri or f"<GENERATED>-{dep_id}-{field}")
            if field in {"content", "text"}:
                return str(content if content is not None else f"<GENERATED>-{dep_id}-{field}")
            return f"<GENERATED>-{dep_id}-{field}"

        # Entire-string placeholder
        gen = _GEN_RE.match(raw)
        if gen:
            return resolve_token(int(gen.group(1)), gen.group(2))

        # Embedded placeholders inside a larger string (common for prompts).
        def repl(match: re.Match[str]) -> str:
            dep_id = int(match.group(1))
            field = match.group(2)
            return resolve_token(dep_id, field)

        return _GEN_TOKEN_RE.sub(repl, raw)

    def _resolve_args(self, value: Any, *, allowed_dep_ids: Set[int], step_results: Dict[int, ExecutedStep]) -> Any:
        value = self._resolve_argument(value, allowed_dep_ids=allowed_dep_ids)
        value = _resolve_legacy_refs(value, step_results)
        if isinstance(value, list):
            return [self._resolve_args(v, allowed_dep_ids=allowed_dep_ids, step_results=step_results) for v in value]
        if isinstance(value, dict):
            return {
                k: self._resolve_args(v, allowed_dep_ids=allowed_dep_ids, step_results=step_results)
                for k, v in value.items()
            }
        return value

    def _register_asset(self, *, session_id: str, uri: str, meta: Dict[str, Any]) -> str:
        asset_prefix = "img"
        asset_type = AssetType.IMAGE
        artifact_type = meta.get("artifact_type")
        if artifact_type == ToolArtifactType.VIDEO:
            asset_prefix = "vid"
            asset_type = AssetType.VIDEO
        elif artifact_type == ToolArtifactType.FILE:
            asset_prefix = "file"
            asset_type = AssetType.FILE
        elif artifact_type == ToolArtifactType.TEXT:
            asset_prefix = "txt"
            asset_type = AssetType.TEXT

        asset_id = self._memory.next_asset_id(session_id, prefix=asset_prefix)
        self._memory.add_asset(session_id, Asset(id=asset_id, type=asset_type, uri=uri, meta=meta))
        return asset_id

    async def run_plan(
        self,
        *,
        session_id: str,
        plan: TaskPlan,
        emit: Optional[EventEmitter] = None,
        confirm: Optional[ConfirmCallback] = None,
    ) -> AsyncIterator[Dict[str, Any]]:
        q: "asyncio.Queue[Dict[str, Any] | None]" = asyncio.Queue()

        async def _noop(_event: Dict[str, Any]) -> None:
            return None

        emit = emit or _noop

        async def forward(event: Dict[str, Any]) -> None:
            await emit(event)
            await q.put(event)

        async def worker() -> None:
            try:
                result = await self.run_async(session_id=session_id, plan=plan, emit=forward, confirm=confirm)
                await q.put({"type": "run_completed", "result": result.model_dump(mode="json")})
            except Exception as error:  # noqa: BLE001
                await q.put({"type": "error", "error": str(error)})
            finally:
                await q.put(None)

        task = asyncio.create_task(worker())
        try:
            while True:
                item = await q.get()
                if item is None:
                    break
                yield item
        finally:
            await task

    async def run_async(
        self,
        *,
        session_id: str,
        plan: TaskPlan,
        emit: Optional[EventEmitter] = None,
        confirm: Optional[ConfirmCallback] = None,
    ) -> RunResult:
        async def _noop(_event: Dict[str, Any]) -> None:
            return None

        emit = emit or _noop
        emit_is_noop = emit is _noop

        tasks = list(plan.root)
        if len({t.id for t in tasks}) != len(tasks):
            raise ValueError("Duplicate task id found in plan")

        executed_steps: List[ExecutedStep] = []
        step_results: Dict[int, ExecutedStep] = {}
        pending: Dict[int, PlannedTask] = {t.id: t for t in tasks}
        completed: Set[int] = set()
        self.step_memory = {}

        while pending:
            ready = [t for t in pending.values() if all(d in completed for d in t.dep)]
            if not ready:
                for t in sorted(pending.values(), key=lambda x: x.id):
                    skipped = ExecutedStep(
                        id=t.id,
                        task=t.task,
                        status=StepStatus.SKIPPED,
                        args=t.args,
                        dep=t.dep,
                        error=f"Unmet dependencies: {sorted(set(t.dep) - completed)}",
                    )
                    executed_steps.append(skipped)
                    step_results[t.id] = skipped
                    await emit({"type": "progress", "task_id": t.id, "status": "skipped", "dep": t.dep})
                break

            for t in sorted(ready, key=lambda x: x.id):
                await emit({"type": "progress", "task_id": t.id, "status": "running", "task": t.task})
                running = ExecutedStep(
                    id=t.id,
                    task=t.task,
                    status=StepStatus.RUNNING,
                    args=t.args,
                    dep=t.dep,
                )
                executed_steps.append(running)
                step_results[t.id] = running

                tool = self._tools.get(t.task)
                if tool is None:
                    raise KeyError(f"Tool not registered: {t.task}")

                resolved_args = self._resolve_args(
                    t.args,
                    allowed_dep_ids=set(t.dep),
                    step_results=step_results,
                )

                # Ensure workspace_root is always available for filesystem tools to avoid resolving relative paths
                # against the server CWD (which may be the repo root or backend/).
                if self._default_workspace_root and isinstance(resolved_args, dict):
                    if t.task in {
                        ToolName.LIST_FILES,
                        ToolName.READ_FILE,
                        ToolName.WRITE_FILE,
                        ToolName.REPLACE_LINES,
                        ToolName.REPLACE_SNIPPET,
                        ToolName.APPLY_PATCH,
                    } and "workspace_root" not in resolved_args:
                        resolved_args = {**resolved_args, "workspace_root": self._default_workspace_root}

                # Human-in-the-loop confirmation for destructive steps
                if confirm is not None and t.task in CONFIRM_TASKS:
                    ok = await confirm(t, resolved_args)
                    if not ok:
                        running.status = StepStatus.FAILED
                        running.args = resolved_args
                        running.error = "Cancelled by user"
                        pending.pop(t.id, None)
                        await emit(
                            {
                                "type": "progress",
                                "task_id": t.id,
                                "status": "failed",
                                "task": t.task,
                                "error": running.error,
                            }
                        )
                        continue

                for attempt in range(self._config.max_retries + 1):
                    try:
                        if t.task == ToolName.GENERATE_TEXT and isinstance(resolved_args, dict) and not emit_is_noop:
                            loop = asyncio.get_running_loop()
                            q: "asyncio.Queue[str | None]" = asyncio.Queue()
                            worker_error: list[Exception] = []

                            def worker() -> None:
                                try:
                                    for delta in iter_generate_text_deltas(**resolved_args):
                                        loop.call_soon_threadsafe(q.put_nowait, delta)
                                except Exception as e:  # noqa: BLE001
                                    worker_error.append(e)
                                finally:
                                    loop.call_soon_threadsafe(q.put_nowait, None)

                            th = threading.Thread(target=worker, daemon=True)
                            th.start()

                            chunks: list[str] = []
                            while True:
                                delta = await q.get()
                                if delta is None:
                                    break
                                chunks.append(delta)
                                await emit(
                                    {
                                        "type": "content_delta",
                                        "task_id": t.id,
                                        "task": t.task,
                                        "delta": delta,
                                    }
                                )

                            if worker_error:
                                raise worker_error[0]

                            content_text = "".join(chunks).strip()
                            if not content_text:
                                raise ValueError("Model returned empty content")

                            model_id = (
                                resolved_args.get("model")
                                or os.getenv("TEXT_MODEL")
                                or os.getenv("PLANNER_MODEL")
                                or "gpt-4o-mini"
                            )
                            temp = float(resolved_args.get("temperature") or 0.2)

                            tool_result = ToolResult(
                                status="succeeded",
                                progress=100,
                                results=[
                                    {
                                        "type": ToolArtifactType.TEXT,
                                        "content": content_text,
                                        "mime": "text/plain; charset=utf-8",
                                        "meta": {"model": model_id, "temperature": temp},
                                    }
                                ],
                                meta={"model": model_id},
                            ).model_dump(mode="json")
                        else:
                            tool_result = await tool.entrypoint(**resolved_args)
                        parsed = ToolResult.model_validate(tool_result)
                        if not parsed.results:
                            raise ValueError(f"Tool {t.task} returned no results: {tool_result}")
                        artifact = parsed.results[0]
                        url = str(artifact.url or "")
                        content = str(artifact.content) if artifact.content is not None else None
                        if not url and not content:
                            raise ValueError(f"Tool {t.task} returned neither url nor content: {tool_result}")
                        uri = url or f"memory://generated/{t.id}"

                        asset_id = self._register_asset(
                            session_id=session_id,
                            uri=uri,
                            meta={
                                "tool": t.task,
                                "artifact_type": artifact.type,
                                "tool_result": parsed.model_dump(mode="json"),
                            },
                        )
                        output = StepOutput(
                            asset_id=asset_id,
                            asset_uri=uri,
                            data={
                                "tool_result": parsed.model_dump(mode="json"),
                                "content": content,
                                "url": uri,
                            },
                        )

                        running.status = StepStatus.COMPLETED
                        running.args = resolved_args
                        running.output = output
                        running.error = None
                        self.step_memory[t.id] = output
                        completed.add(t.id)
                        pending.pop(t.id, None)
                        await emit(
                            {
                                "type": "progress",
                                "task_id": t.id,
                                "status": "completed",
                                "task": t.task,
                                "output": output.model_dump(mode="json"),
                            }
                        )
                        break
                    except Exception as error:  # noqa: BLE001
                        if attempt < self._config.max_retries:
                            await emit(
                                {
                                    "type": "progress",
                                    "task_id": t.id,
                                    "status": "retrying",
                                    "attempt": attempt + 1,
                                    "error": str(error),
                                }
                            )
                            await asyncio.sleep(self._config.retry_backoff_s * (2**attempt))
                            continue

                        running.status = StepStatus.FAILED
                        running.args = resolved_args
                        running.error = str(error)
                        pending.pop(t.id, None)
                        await emit(
                            {
                                "type": "progress",
                                "task_id": t.id,
                                "status": "failed",
                                "task": t.task,
                                "error": str(error),
                            }
                        )
                        break

        memory_snapshot = self._memory.get(session_id)
        return RunResult(
            session_id=session_id,
            plan=plan,
            steps=executed_steps,
            assets=dict(memory_snapshot.assets),
        )
