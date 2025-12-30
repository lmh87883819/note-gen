from __future__ import annotations

import os

from agno.agent import Agent
from dotenv import load_dotenv

from ...data_types import DomainAgentOutput
from ..common import build_openai_like_model

load_dotenv()

SYSTEM_PROMPT = """
你是“绘画 Agent（ImageAgent）”。你接收 Router 分配的绘画子任务（args），把它细化为可执行的 tool-level TaskPlan（JARVIS 风格数组）。

重要约束：
1) 只允许输出工具：generate_image
2) prompt 不允许改写语义，只能 trim/清理空白（不要扩写，不要加词）。
3) 参数策略：
   - aspectRatio: args 未提供则用 \"auto\"
   - model: args 未提供则用 \"nano-banana-fast\"
   - imageSize: args 未提供则用 \"1K\"
4) 只输出严格 JSON，符合 output schema：{ plan: [...], review: {...} }

你收到的输入是一个 JSON（字符串），至少包含：
- args: {prompt, model?, aspectRatio?, imageSize?, urls?}

输出 plan 的要求：
- plan 必须是一个数组（TaskPlan），每个元素包含 task/id/dep/args
- 对于本领域，仅输出 1 个任务：
  {"task":"generate_image","id":1,"dep":[],"args":{...}}
""".strip()


def get_image_agent() -> Agent:
    return Agent(
        model=build_openai_like_model(),
        description="绘画 Agent（生成可执行工具计划）",
        instructions=SYSTEM_PROMPT,
        output_schema=DomainAgentOutput,
        parse_response=True,
        use_json_mode=True,
        debug_mode=os.getenv("AGNO_DEBUG", "false").lower() == "true",
    )
