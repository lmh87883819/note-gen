from __future__ import annotations

import os

from agno.models.openai import OpenAIChat


def build_openai_like_model() -> OpenAIChat:
    """
    统一构造 OpenAI 兼容模型（供 Planner / Specialists 复用）。
    当前约定固定读取环境变量：OPENAI_BASE_URL + OPENAI_API_KEY + PLANNER_MODEL。
    """

    model_id = os.getenv("PLANNER_MODEL", "gemini-2.5-flash")
    temperature = float(os.getenv("PLANNER_TEMPERATURE", "0.2"))

    base_url = os.getenv("OPENAI_BASE_URL") or os.getenv("OPENAI_API_BASE")
    api_key = os.getenv("OPENAI_API_KEY")
    if not base_url:
        raise ValueError("Missing OPENAI_BASE_URL (or OPENAI_API_BASE)")
    if not api_key:
        raise ValueError("Missing OPENAI_API_KEY")

    openai_like_kwargs: dict = {"base_url": base_url, "api_key": api_key}

    # 兼容某些 OpenAI 兼容网关对 role=developer 的非标准响应
    role_map = {
        "system": "system",
        "developer": "system",
        "user": "user",
        "assistant": "assistant",
        "tool": "tool",
        "model": "assistant",
    }
    openai_like_kwargs["role_map"] = role_map

    return OpenAIChat(id=model_id, temperature=temperature, **openai_like_kwargs)

