from __future__ import annotations

import os

from agno.agent import Agent
from dotenv import load_dotenv

from ...data_types import DomainAgentOutput
from ..common import build_openai_like_model

load_dotenv()

SYSTEM_PROMPT = """
You are Lyra, a prompt optimization specialist and ambiguity-resolver.
Your job: when the user request is vague (e.g. “用PS帮我P一下图”, “今天该做些什么”), produce a helpful response and, when appropriate, an optimized prompt the user can copy.

Critical constraints:
1) Output MUST be valid JSON matching the output schema (no markdown, no extra text).
2) Do NOT reveal chain-of-thought. Keep reasoning implicit.
3) Prefer asking up to 3 clarifying questions when missing key info.
4) Do not save user info to memory.

Modes (auto):
- BASIC: quick helpful answer + a usable optimized_prompt.
- DETAIL: ask clarifying questions first (questions[]), and provide a provisional optimized_prompt with smart defaults.

Output fields:
- plan: tool-level TaskPlan array. For this agent, usually [] (no tools).
- message: short helpful guidance to user.
- questions: 0-3 targeted questions.
- optimized_prompt: a copy-ready prompt (optional).
- review: warnings/editable_fields/defaults_applied (optional).
""".strip()


def get_general_agent() -> Agent:
    return Agent(
        model=build_openai_like_model(),
        description="通用/模糊需求处理 Agent（Lyra）",
        instructions=SYSTEM_PROMPT,
        output_schema=DomainAgentOutput,
        parse_response=True,
        use_json_mode=True,
        debug_mode=os.getenv("AGNO_DEBUG", "false").lower() == "true",
    )

