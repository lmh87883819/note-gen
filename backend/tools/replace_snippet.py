from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from agno.tools import tool

from .editor_fs import _guard_workspace, _normalize_path, _resolve_in_workspace, _read_text, _write_with_verify
from ..data_types import ToolArtifactType, ToolResult


def _normalize_newlines(s: str) -> str:
    return (s or "").replace("\r\n", "\n")


def _to_original_newlines(s: str, *, original_had_crlf: bool) -> str:
    if not original_had_crlf:
        return s
    return s.replace("\n", "\r\n")


def _find_nth(haystack: str, needle: str, n: int) -> int:
    if n <= 0:
        raise ValueError("occurrence must be >= 1")
    start = 0
    for _ in range(n):
        idx = haystack.find(needle, start)
        if idx < 0:
            return -1
        start = idx + len(needle)
    return idx


@tool(
    name="replace_snippet",
    description="Replace a selected snippet in a text file with new text (safe: only replaces the matched snippet).",
)
async def replace_snippet(
    *,
    file_path: str,
    old_text: str,
    new_text: str,
    workspace_root: Optional[str] = None,
    allow_outside_workspace: bool = False,
    occurrence: int = 1,
    verify: bool = True,
) -> dict[str, Any]:
    file_path = _normalize_path(_resolve_in_workspace(str(file_path or ""), workspace_root))
    if not file_path:
        raise ValueError("file_path is required")
    _guard_workspace(file_path, workspace_root, bool(allow_outside_workspace))

    old_text = "" if old_text is None else str(old_text)
    new_text = "" if new_text is None else str(new_text)
    if old_text.strip() == "":
        raise ValueError("old_text is required and cannot be empty")

    original = _read_text(file_path)
    original_had_crlf = "\r\n" in original
    original_norm = _normalize_newlines(original)
    old_norm = _normalize_newlines(old_text)
    new_norm = _normalize_newlines(new_text)

    idx = _find_nth(original_norm, old_norm, int(occurrence))
    if idx < 0:
        target = Path(file_path).name
        raise ValueError(f"Snippet not found in file (occurrence={occurrence}): {target}")

    next_norm = original_norm[:idx] + new_norm + original_norm[idx + len(old_norm) :]
    next_text = _to_original_newlines(next_norm, original_had_crlf=original_had_crlf)

    verify_meta = _write_with_verify(file_path=file_path, content=next_text, verify=bool(verify))

    before_preview = original_norm[max(0, idx - 200) : idx + min(len(old_norm), 200)]
    after_preview = next_norm[max(0, idx - 200) : idx + min(len(new_norm), 200)]

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
                    "occurrence": int(occurrence),
                    "replaced_chars": len(old_norm),
                    "inserted_chars": len(new_norm),
                    "before_preview": before_preview,
                    "after_preview": after_preview,
                    **verify_meta,
                },
            }
        ],
        meta={"file_path": file_path},
    ).model_dump(mode="json")

