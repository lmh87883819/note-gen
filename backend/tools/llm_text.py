from __future__ import annotations

import os
from typing import Any, Optional

from agno.tools import tool
from openai import OpenAI

from ..data_types import ToolArtifactType, ToolResult


def _client() -> OpenAI:
    base_url = os.getenv("OPENAI_BASE_URL") or os.getenv("OPENAI_API_BASE")
    api_key = os.getenv("OPENAI_API_KEY")
    if not base_url:
        raise ValueError("Missing OPENAI_BASE_URL (or OPENAI_API_BASE)")
    if not api_key:
        raise ValueError("Missing OPENAI_API_KEY")
    return OpenAI(base_url=base_url, api_key=api_key)


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

    messages = []
    if system:
        messages.append({"role": "system", "content": str(system)})
    messages.append({"role": "user", "content": prompt})

    c = _client()
    resp = c.chat.completions.create(
        model=model_id,
        messages=messages,
        temperature=float(temperature or 0.2),
        max_tokens=int(max_tokens) if max_tokens is not None else None,
    )

    content = (resp.choices[0].message.content or "").strip()
    if not content:
        raise ValueError("Model returned empty content")

    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.TEXT,
                "content": content,
                "mime": "text/plain; charset=utf-8",
                "meta": {"model": model_id, "temperature": float(temperature or 0.2)},
            }
        ],
        meta={"model": model_id},
    ).model_dump(mode="json")

