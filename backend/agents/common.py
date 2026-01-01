from __future__ import annotations

import os

from agno.compression import CompressionManager
from agno.models.openai import OpenAIChat


def _build_openai_like_model(
    *,
    model_env: str,
    default_model: str,
    temperature_env: str,
    default_temperature: float,
) -> OpenAIChat:
    """
    统一构造 OpenAI 兼容模型。
    约定固定读取环境变量：OPENAI_BASE_URL + OPENAI_API_KEY。
    """

    model_id = os.getenv(model_env, default_model)
    temperature = float(os.getenv(temperature_env, str(default_temperature)))

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


def build_openai_like_model() -> OpenAIChat:
    """
    供 Planner / Router / Guard / Domain agents 复用。
    """

    return _build_openai_like_model(
        model_env="PLANNER_MODEL",
        default_model="gemini-2.5-flash",
        temperature_env="PLANNER_TEMPERATURE",
        default_temperature=0.2,
    )


def build_openai_like_text_model(*, model: str | None = None, temperature: float | None = None) -> OpenAIChat:
    """
    供 generate_text / 压缩 / token 计数使用（优先 TEXT_MODEL）。
    """

    m = _build_openai_like_model(
        model_env="TEXT_MODEL",
        default_model=os.getenv("PLANNER_MODEL", "gpt-4o-mini"),
        temperature_env="TEXT_TEMPERATURE",
        default_temperature=float(os.getenv("PLANNER_TEMPERATURE", "0.2")),
    )
    if model:
        m.id = model
    if temperature is not None:
        m.temperature = float(temperature)
    return m


def build_compression_manager() -> CompressionManager:
    """
    Agno Context Compression（默认开启，无需配置）：
    - 用于压缩“工具结果”（比如 read_file/web_search 的返回），避免上下文爆炸
    """

    return CompressionManager(model=build_openai_like_text_model(), compress_tool_results=True)

