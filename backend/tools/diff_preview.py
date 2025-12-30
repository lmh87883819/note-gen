from __future__ import annotations

import difflib
from typing import Any

from agno.tools import tool

from ..data_types import ToolArtifactType, ToolResult


@tool(
    name="diff_preview",
    description="Generate a unified diff preview from old_content to new_content (text).",
)
async def diff_preview(
    *,
    old_content: str,
    new_content: str,
    fromfile: str = "before",
    tofile: str = "after",
    context_lines: int = 3,
) -> dict[str, Any]:
    old_lines = (old_content or "").replace("\r\n", "\n").splitlines(keepends=True)
    new_lines = (new_content or "").replace("\r\n", "\n").splitlines(keepends=True)
    diff = "".join(
        difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile=str(fromfile),
            tofile=str(tofile),
            n=max(0, int(context_lines)),
        )
    )
    if not diff:
        diff = ""  # explicit

    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.TEXT,
                "content": diff,
                "mime": "text/x-diff; charset=utf-8",
                "meta": {"context_lines": int(context_lines)},
            }
        ],
    ).model_dump(mode="json")

