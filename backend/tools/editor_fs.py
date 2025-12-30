from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

from agno.tools import tool

from ..data_types import ToolArtifactType, ToolResult


def _normalize_path(file_path: str) -> str:
    p = Path(file_path).expanduser()
    try:
        return str(p.resolve())
    except Exception:
        return str(p)


def _guard_workspace(file_path: str, workspace_root: Optional[str], allow_outside: bool) -> None:
    if allow_outside:
        return
    if not workspace_root:
        return
    root = Path(workspace_root).expanduser()
    try:
        root = root.resolve()
    except Exception:
        pass
    p = Path(file_path).expanduser()
    try:
        p = p.resolve()
    except Exception:
        pass

    # best-effort containment check
    try:
        p.relative_to(root)
    except Exception as e:
        raise PermissionError(f"File path is outside workspace_root: {p} (root={root})") from e


def _resolve_in_workspace(file_path: str, workspace_root: Optional[str]) -> str:
    """
    If workspace_root is provided and file_path is relative, treat it as relative to workspace_root.
    """
    raw = str(file_path or "").strip()
    if not raw:
        return raw
    if not workspace_root:
        return raw
    p = Path(raw)
    if p.is_absolute():
        return raw
    return str(Path(workspace_root) / raw)


def _read_text(file_path: str) -> str:
    return Path(file_path).read_text(encoding="utf-8", errors="replace")


def _write_text(file_path: str, content: str) -> None:
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    Path(file_path).write_text(content, encoding="utf-8")


def _write_with_verify(
    *,
    file_path: str,
    content: str,
    verify: bool,
) -> dict[str, Any]:
    _write_text(file_path, content)
    verify_matches: Optional[bool] = None
    verify_length: Optional[int] = None
    verify_preview: Optional[str] = None
    if verify:
        read_back = _read_text(file_path)
        verify_length = len(read_back)
        verify_preview = read_back[:2000]
        normalize = lambda s: (s or "").replace("\r\n", "\n")
        verify_matches = normalize(read_back) == normalize(content)
        if verify_matches is False:
            raise ValueError("Write verification failed: read-back content differs from written content.")
    return {
        "verify": bool(verify),
        "verify_matches": verify_matches,
        "verify_length": verify_length,
        "verify_preview": verify_preview,
    }


@tool(
    name="read_file",
    description="Read a text file and return its content (and file path).",
)
async def read_file(
    *,
    file_path: str,
    workspace_root: Optional[str] = None,
    allow_outside_workspace: bool = False,
    max_chars: int = 200000,
) -> dict[str, Any]:
    file_path = _normalize_path(_resolve_in_workspace(str(file_path or ""), workspace_root))
    if not file_path:
        raise ValueError("file_path is required")
    _guard_workspace(file_path, workspace_root, bool(allow_outside_workspace))

    max_chars = int(max_chars or 200000)
    max_chars = max(1000, min(2_000_000, max_chars))

    text = _read_text(file_path)
    truncated = text[:max_chars]

    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.FILE,
                "url": file_path,
                "content": truncated,
                "mime": "text/plain; charset=utf-8",
                "meta": {
                    "total_chars": len(text),
                    "returned_chars": len(truncated),
                    "truncated": len(truncated) != len(text),
                },
            }
        ],
        meta={"file_path": file_path},
    ).model_dump(mode="json")


@tool(
    name="write_file",
    description="Write (overwrite) a text file. Returns file path and read-back verification.",
)
async def write_file(
    *,
    file_path: str,
    content: str,
    workspace_root: Optional[str] = None,
    allow_outside_workspace: bool = False,
    allow_empty: bool = False,
    verify: bool = True,
) -> dict[str, Any]:
    file_path = _normalize_path(_resolve_in_workspace(str(file_path or ""), workspace_root))
    if not file_path:
        raise ValueError("file_path is required")
    _guard_workspace(file_path, workspace_root, bool(allow_outside_workspace))

    content = "" if content is None else str(content)
    if not allow_empty and content.strip() == "":
        raise ValueError("Refusing to write empty content. Set allow_empty=true to confirm clearing the file.")

    verify_meta = _write_with_verify(file_path=file_path, content=content, verify=bool(verify))

    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.FILE,
                "url": file_path,
                "content": None,
                "mime": "text/plain; charset=utf-8",
                "meta": {
                    **verify_meta,
                },
            }
        ],
        meta={"file_path": file_path},
    ).model_dump(mode="json")
