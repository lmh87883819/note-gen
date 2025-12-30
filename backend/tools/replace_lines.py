from __future__ import annotations

from typing import Any, Optional

from agno.tools import tool

from ..data_types import ToolArtifactType, ToolResult
from .editor_fs import _guard_workspace, _normalize_path, _read_text, _resolve_in_workspace, _write_with_verify


@tool(
    name="replace_lines",
    description="Replace a line range (1-based, inclusive) in a text file, then write back with verification.",
)
async def replace_lines(
    *,
    file_path: str,
    start_line: int,
    end_line: int,
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

    start_line = int(start_line)
    end_line = int(end_line)
    if start_line < 1 or end_line < 1:
        raise ValueError("start_line/end_line must be >= 1")
    if end_line < start_line:
        raise ValueError("end_line must be >= start_line")

    new_block = "" if content is None else str(content)
    if not allow_empty and new_block.strip() == "":
        raise ValueError("Refusing to write empty content. Set allow_empty=true to confirm clearing the range.")

    original = _read_text(file_path).replace("\r\n", "\n")
    lines = original.split("\n")

    # Allow replacing "append" if start_line is one past EOF (end_line will be clamped).
    max_line = max(1, len(lines))
    if start_line > len(lines) + 1:
        raise ValueError(f"start_line out of range: {start_line} (max allowed {len(lines)+1})")

    s = min(start_line, len(lines) + 1)
    e = min(end_line, len(lines)) if start_line <= len(lines) else len(lines)

    replacement_lines = new_block.replace("\r\n", "\n").split("\n")
    next_lines = lines[: s - 1] + replacement_lines + (lines[e:] if e >= 1 else lines)
    next_content = "\n".join(next_lines)

    verify_meta = _write_with_verify(file_path=file_path, content=next_content, verify=bool(verify))

    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.FILE,
                "url": file_path,
                "mime": "text/plain; charset=utf-8",
                "meta": {
                    "start_line": int(start_line),
                    "end_line": int(end_line),
                    "applied_start": int(s),
                    "applied_end": int(e),
                    **verify_meta,
                },
            }
        ],
        meta={"file_path": file_path},
    ).model_dump(mode="json")
