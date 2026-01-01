from __future__ import annotations

import os
from typing import Any, Iterator, Optional, Tuple

from agno.tools import tool
from agno.models.message import Message
from agno.models.metrics import Metrics

from ..agents.common import build_openai_like_text_model
from ..data_types import ToolArtifactType, ToolResult


def iter_generate_text_deltas(
    *,
    prompt: str,
    system: Optional[str] = None,
    model: Optional[str] = None,
    temperature: float = 0.2,
    max_tokens: Optional[int] = None,
) -> Iterator[str]:
    """
    Synchronous streaming helper.

    Returns a list of text deltas in order (so caller can join them).
    """
    for delta, _usage in iter_generate_text_stream(prompt=prompt, system=system, model=model, temperature=temperature, max_tokens=max_tokens):
        if delta:
            yield delta


def iter_generate_text_stream(
    *,
    prompt: str,
    system: Optional[str] = None,
    model: Optional[str] = None,
    temperature: float = 0.2,
    max_tokens: Optional[int] = None,
) -> Iterator[Tuple[str, Optional[dict]]]:
    """
    Synchronous streaming helper using Agno's model wrapper.

    Yields (delta, usage_dict_or_none). Usage is only available on the final chunk.
    """
    prompt = str(prompt or "")
    if not prompt.strip():
        raise ValueError("prompt is required")

    model_id = model or os.getenv("TEXT_MODEL") or os.getenv("PLANNER_MODEL") or "gpt-4o-mini"

    messages: list[Message] = []
    if system:
        messages.append(Message(role="system", content=str(system)))
    messages.append(Message(role="user", content=prompt))

    m = build_openai_like_text_model(model=model_id, temperature=float(temperature or 0.2))
    assistant = Message(role="assistant", content="")

    for resp in m.invoke_stream(
        messages=messages,
        assistant_message=assistant,
        response_format=None,
        tools=None,
        tool_choice=None,
        run_response=None,
        compress_tool_results=False,
    ):
        delta = str(resp.content or "")
        usage = None
        if isinstance(getattr(resp, "response_usage", None), Metrics):
            usage = resp.response_usage.to_dict()
        yield delta, usage


@tool(
    name="generate_text",
    description="Generate text with an OpenAI-compatible chat model. Returns generated content.",
)
async def generate_text(
    *,
    prompt: str,
    system: Optional[str] = None,
    model: Optional[str] = None,
    temperature: float = 0.2,
    max_tokens: Optional[int] = None,
) -> dict[str, Any]:
    prompt = str(prompt or "")
    if not prompt.strip():
        raise ValueError("prompt is required")

    model_id = model or os.getenv("TEXT_MODEL") or os.getenv("PLANNER_MODEL") or "gpt-4o-mini"

    messages: list[Message] = []
    if system:
        messages.append(Message(role="system", content=str(system)))
    messages.append(Message(role="user", content=prompt))

    m = build_openai_like_text_model(model=model_id, temperature=float(temperature or 0.2))
    resp = m.response(messages=messages, response_format=None, tools=None, tool_choice=None, tool_call_limit=None)
    content = (str(resp.content or "")).strip()
    if not content:
        raise ValueError("Model returned empty content")

    usage = None
    if isinstance(getattr(resp, "response_usage", None), Metrics):
        usage = resp.response_usage.to_dict()

    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.TEXT,
                "content": content,
                "mime": "text/plain; charset=utf-8",
                "meta": {"model": model_id, "temperature": float(temperature or 0.2), "usage": usage},
            }
        ],
        meta={"model": model_id, "usage": usage},
    ).model_dump(mode="json")

