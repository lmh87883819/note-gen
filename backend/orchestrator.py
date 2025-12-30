from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncIterator, Dict, Optional

from agno.agent import Agent
from agno.tools import Function

from .data_types import DomainAgentOutput, DomainName, GuardDecision, RoutedPlan, RoutedTask, TaskPlan, ToolName
from .executor import ToolPlanExecutor
from .memory import MemoryStore


class Orchestrator:
    """
    三层架构 Orchestrator：
    - L0 Router Planner: 用户请求 -> RoutedPlan（领域级 DAG）
    - L1 Domain Agent: RoutedTask -> tool-level TaskPlan + review
    - L2 Executor: 执行 tool-level TaskPlan，产出 progress / run_completed 事件
    """

    def __init__(
        self,
        *,
        guard: Agent,
        guard_enabled: bool = True,
        router: Agent,
        domain_agents: Dict[DomainName, Agent],
        tools: Dict[ToolName, Function],
        memory: MemoryStore,
    ) -> None:
        self._guard = guard
        self._guard_enabled = guard_enabled
        self._router = router
        self._domain_agents = domain_agents
        self._tools = tools
        self._memory = memory

    async def guard_check(self, *, session_id: str, message: str) -> GuardDecision:
        if not self._guard_enabled:
            return GuardDecision(allow=True, category="ok", message="", suggested_design_prompts=[])
        payload = {
            "session_id": session_id,
            "message": message,
        }
        out = await asyncio.to_thread(self._guard.run, json.dumps(payload, ensure_ascii=False))
        content = getattr(out, "content", None)
        if isinstance(content, GuardDecision):
            return content
        if isinstance(content, dict):
            return GuardDecision.model_validate(content)
        raise RuntimeError(f"Invalid guard output: {content!r}")

    async def compile_plan(
        self,
        *,
        session_id: str,
        message: str,
    ) -> tuple[RoutedPlan, TaskPlan, list[dict[str, Any]]]:
        """
        规划阶段（不执行工具）：
        - 先路由，再让领域 agent 产出 tool-level plan
        - 返回：route、tool_plan（当前实现为单领域/单任务聚合）、review 列表
        """
        guard = await self.guard_check(session_id=session_id, message=message)
        if not guard.allow:
            raise PermissionError(guard.message or "Blocked by guard")

        router_out = await asyncio.to_thread(self._router.run, message)
        content = getattr(router_out, "content", None)
        if isinstance(content, RoutedPlan):
            route = content
        elif isinstance(content, list):
            route = RoutedPlan.model_validate(content)
        else:
            raise RuntimeError(f"Invalid router output: {content!r}")

        tool_steps: list[dict[str, Any]] = []
        reviews: list[dict[str, Any]] = []
        step_offset = 0
        route_last_step: dict[int, int] = {}

        for routed_task in route.root:
            agent = self._domain_agents.get(routed_task.agent)
            if agent is None:
                raise KeyError(f"Domain agent not registered: {routed_task.agent}")

            payload = {"session_id": session_id, "task": routed_task.model_dump(mode="json")}
            domain_out = await asyncio.to_thread(agent.run, json.dumps(payload, ensure_ascii=False))
            domain_content = getattr(domain_out, "content", None)
            if isinstance(domain_content, DomainAgentOutput):
                domain_output = domain_content
            elif isinstance(domain_content, dict) and "plan" in domain_content:
                domain_output = DomainAgentOutput.model_validate(domain_content)
            else:
                raise RuntimeError(f"Invalid domain output: {domain_content!r}")

            reviews.append(
                {
                    "task_id": routed_task.id,
                    "agent": routed_task.agent,
                    **domain_output.review.model_dump(mode="json"),
                    "message": domain_output.message,
                    "questions": domain_output.questions,
                    "optimized_prompt": domain_output.optimized_prompt,
                }
            )

            # 合并 tool plans（id/dep 进行偏移）
            domain_steps = list(domain_output.plan.root)
            upstream_deps_global = [route_last_step[d] for d in routed_task.dep if d in route_last_step]

            for idx, s in enumerate(domain_steps):
                deps_global = [d + step_offset for d in s.dep]
                if idx == 0 and upstream_deps_global:
                    deps_global = sorted(set(deps_global + upstream_deps_global))
                tool_steps.append(
                    {
                        "task": s.task,
                        "id": s.id + step_offset,
                        "dep": deps_global,
                        "args": s.args,
                    }
                )
            if tool_steps:
                route_last_step[routed_task.id] = tool_steps[-1]["id"]
                step_offset = tool_steps[-1]["id"]

        return route, TaskPlan.model_validate(tool_steps), reviews

    async def run_stream(
        self,
        *,
        session_id: str,
        message: str,
    ) -> AsyncIterator[Dict[str, Any]]:
        guard = await self.guard_check(session_id=session_id, message=message)
        if self._guard_enabled:
            yield {"type": "guard", "decision": guard.model_dump(mode="json")}
        if not guard.allow:
            if guard.message:
                yield {"type": "message", "message": guard.message, "agent": "guard"}
            if guard.suggested_design_prompts:
                yield {
                    "type": "suggestions",
                    "suggested_design_prompts": guard.suggested_design_prompts,
                    "agent": "guard",
                }
            empty = TaskPlan.model_validate([])
            yield {"type": "plan", "plan": []}
            executor = ToolPlanExecutor(tools=self._tools, memory=self._memory)
            async for event in executor.run_plan(session_id=session_id, plan=empty):
                yield event
            return

        route, tool_plan, reviews = await self.compile_plan(session_id=session_id, message=message)
        yield {"type": "route", "route": route.model_dump(mode="json")}
        if reviews:
            yield {"type": "review", "reviews": reviews}
            # 便于前端直接渲染“对话式输出”
            for r in reviews:
                msg = r.get("message")
                if msg:
                    yield {"type": "message", "message": msg, "agent": r.get("agent"), "task_id": r.get("task_id")}
                questions = r.get("questions") or []
                if questions:
                    yield {"type": "questions", "questions": questions, "agent": r.get("agent"), "task_id": r.get("task_id")}
                opt = r.get("optimized_prompt")
                if opt:
                    yield {"type": "optimized_prompt", "optimized_prompt": opt, "agent": r.get("agent"), "task_id": r.get("task_id")}
        yield {"type": "plan", "plan": tool_plan.model_dump(mode="json")}

        executor = ToolPlanExecutor(tools=self._tools, memory=self._memory)
        async for event in executor.run_plan(session_id=session_id, plan=tool_plan):
            yield event
