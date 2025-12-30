from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from agno.tools import tool

from ..data_types import ToolArtifactType, ToolResult
from .editor_fs import _guard_workspace, _normalize_path


@tool(
    name="list_files",
    description="List files under workspace_root (recursive). Returns a JSON array of file paths in content.",
)
async def list_files(
    *,
    workspace_root: str,
    query: str | None = None,
    limit: int = 500,
    allow_outside_workspace: bool = False,
) -> dict[str, Any]:
    workspace_root = _normalize_path(str(workspace_root or ""))
    if not workspace_root:
        raise ValueError("workspace_root is required")

    _guard_workspace(workspace_root, workspace_root, bool(allow_outside_workspace))

    limit = int(limit or 500)
    limit = max(1, min(5000, limit))
    q = (query or "").strip().lower()

    root = Path(workspace_root)
    if not root.exists():
        raise FileNotFoundError(f"workspace_root not found: {workspace_root}")

    results: list[str] = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = str(p.relative_to(root)).replace("\\", "/")
        if q and q not in rel.lower():
            continue
        results.append(rel)
        if len(results) >= limit:
            break

    content = __import__("json").dumps(results, ensure_ascii=False)
    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.TEXT,
                "content": content,
                "mime": "application/json; charset=utf-8",
                "meta": {"count": len(results), "limit": limit, "query": q},
            }
        ],
        meta={"workspace_root": workspace_root},
    ).model_dump(mode="json")

