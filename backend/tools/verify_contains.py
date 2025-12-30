from __future__ import annotations

from typing import Any, Iterable, List, Optional

from agno.tools import tool

from ..data_types import ToolArtifactType, ToolResult


@tool(
    name="verify_contains",
    description="Assert that content contains all required substrings. Raises error if not.",
)
async def verify_contains(
    *,
    content: str,
    must_include: List[str],
    must_not_include: Optional[List[str]] = None,
    case_sensitive: bool = True,
) -> dict[str, Any]:
    text = str(content or "")
    inc = [str(s) for s in (must_include or []) if str(s)]
    exc = [str(s) for s in (must_not_include or []) if str(s)]

    if not inc and not exc:
        raise ValueError("verify_contains: must_include or must_not_include is required")

    haystack = text if case_sensitive else text.lower()

    missing = []
    for s in inc:
        needle = s if case_sensitive else s.lower()
        if needle not in haystack:
            missing.append(s)

    present_forbidden = []
    for s in exc:
        needle = s if case_sensitive else s.lower()
        if needle in haystack:
            present_forbidden.append(s)

    if missing or present_forbidden:
        raise ValueError(f"verify_contains failed: missing={missing}, forbidden_present={present_forbidden}")

    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.TEXT,
                "content": "ok",
                "mime": "text/plain; charset=utf-8",
                "meta": {"missing": [], "forbidden_present": [], "case_sensitive": bool(case_sensitive)},
            }
        ],
    ).model_dump(mode="json")

