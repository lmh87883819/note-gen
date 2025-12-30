from __future__ import annotations

import re
from typing import Any, Optional

from agno.tools import tool

from ..data_types import ToolArtifactType, ToolResult
from .editor_fs import _guard_workspace, _normalize_path, _read_text, _resolve_in_workspace, _write_with_verify


_HUNK_RE = re.compile(r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@")


def _apply_unified_diff(original: str, diff_text: str) -> str:
    """
    Minimal unified-diff applier for a single file.
    Requirements:
    - Diff uses @@ hunks.
    - Context lines must match; otherwise raises.
    """
    orig_lines = original.replace("\r\n", "\n").splitlines(keepends=False)
    out_lines = []

    i = 0  # index in orig_lines
    lines = diff_text.replace("\r\n", "\n").splitlines(keepends=False)
    p = 0
    while p < len(lines):
        line = lines[p]
        if line.startswith("---") or line.startswith("+++"):
            p += 1
            continue
        if not line.startswith("@@"):
            p += 1
            continue

        m = _HUNK_RE.match(line)
        if not m:
            raise ValueError(f"Invalid hunk header: {line}")
        old_start = int(m.group(1))
        # old_count = int(m.group(2) or "1")
        # new_start = int(m.group(3))
        # new_count = int(m.group(4) or "1")

        # Copy unchanged lines before hunk
        target_index = max(0, old_start - 1)
        if target_index < i:
            raise ValueError("Overlapping hunks are not supported")
        out_lines.extend(orig_lines[i:target_index])
        i = target_index

        p += 1
        # Apply hunk body
        while p < len(lines):
            h = lines[p]
            if h.startswith("@@"):
                break
            if h.startswith("\\"):
                p += 1
                continue

            if not h:
                prefix = " "
                content = ""
            else:
                prefix = h[0]
                content = h[1:] if len(h) > 1 else ""

            if prefix == " ":
                if i >= len(orig_lines) or orig_lines[i] != content:
                    got = orig_lines[i] if i < len(orig_lines) else "<EOF>"
                    raise ValueError(f"Context mismatch at line {i+1}: expected {content!r}, got {got!r}")
                out_lines.append(content)
                i += 1
            elif prefix == "-":
                if i >= len(orig_lines) or orig_lines[i] != content:
                    got = orig_lines[i] if i < len(orig_lines) else "<EOF>"
                    raise ValueError(f"Delete mismatch at line {i+1}: expected {content!r}, got {got!r}")
                i += 1
            elif prefix == "+":
                out_lines.append(content)
            else:
                raise ValueError(f"Unexpected diff line prefix: {prefix!r}")
            p += 1

    # Copy remaining
    out_lines.extend(orig_lines[i:])
    return "\n".join(out_lines)


@tool(
    name="apply_patch",
    description="Apply a unified diff patch to a text file and write back with verification.",
)
async def apply_patch(
    *,
    file_path: str,
    patch: str,
    workspace_root: Optional[str] = None,
    allow_outside_workspace: bool = False,
    verify: bool = True,
) -> dict[str, Any]:
    file_path = _normalize_path(_resolve_in_workspace(str(file_path or ""), workspace_root))
    if not file_path:
        raise ValueError("file_path is required")
    _guard_workspace(file_path, workspace_root, bool(allow_outside_workspace))

    original = _read_text(file_path)
    next_content = _apply_unified_diff(original, str(patch or ""))
    verify_meta = _write_with_verify(file_path=file_path, content=next_content, verify=bool(verify))

    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.FILE,
                "url": file_path,
                "mime": "text/plain; charset=utf-8",
                "meta": {**verify_meta},
            }
        ],
        meta={"file_path": file_path},
    ).model_dump(mode="json")
