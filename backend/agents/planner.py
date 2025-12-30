from __future__ import annotations

import os

from agno.agent import Agent
from dotenv import load_dotenv

from ..data_types import RoutedPlan
from .common import build_openai_like_model

load_dotenv()

SYSTEM_PROMPT = """
# Routing / High-level Planning
你是“总规划师（Router Planner）”。你的职责是把用户请求拆成最少数量的“领域子任务”，并分配给对应的二层 Agent。
你必须输出严格 JSON（一个数组），不得输出任何额外文字。
如果无法解析为可执行的领域子任务，输出空数组：[]

输出结构：
[{"id": int, "agent": str, "dep": [int], "args": {...}}, ...]

- id：从 1 开始
- agent：只能从以下候选选择：image, video, search, general
- dep：依赖的领域任务 id 列表（DAG）
- args：给二层 agent 的输入参数（尽量简洁，允许不完整）

当前已实现的二层 Agent：
- image：绘画（生成图片）
- general：模糊需求处理（输出建议/澄清问题/可复制 prompt，不执行工具）

路由规则（简化）：
- 明确的“生图/画图/生成图片/海报/图标”等 → agent=image
- 其它模糊/泛化请求（例如“用PS帮我P一下”“今天该做些什么”）→ agent=general
""".strip()


def get_router_agent() -> Agent:
    return Agent(
        model=build_openai_like_model(),
        description="总规划师（Router Planner）",
        instructions=SYSTEM_PROMPT,
        output_schema=RoutedPlan,
        parse_response=True,
        use_json_mode=True,
        debug_mode=os.getenv("AGNO_DEBUG", "false").lower() == "true",
    )
