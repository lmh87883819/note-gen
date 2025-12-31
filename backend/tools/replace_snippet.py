from __future__ import annotations

import difflib
import re
from pathlib import Path
from typing import Any, Optional

from agno.tools import tool

from .editor_fs import _guard_workspace, _normalize_path, _resolve_in_workspace, _read_text, _write_with_verify
from ..data_types import ToolArtifactType, ToolResult


def _normalize_newlines(s: str) -> str:
    return (s or "").replace("\r\n", "\n").replace("\r", "\n")


def _normalize_for_match(s: str) -> str:
    """
    Normalize text for matching selected snippets against file content.

    Goals:
    - Treat CRLF/LF as equal
    - Ignore common invisible characters inserted by editors
    - Avoid mismatches from trailing spaces/tabs on each line
    """
    s = _normalize_newlines(s or "")
    s = s.replace("\ufeff", "").replace("\u200b", "")
    s = s.replace("\u00A0", " ")
    # Remove trailing spaces/tabs before newline
    s = re.sub(r"[ \t]+(?=\n)", "", s)
    return s


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


def _find_nth_regex(haystack: str, pattern: "re.Pattern[str]", n: int) -> tuple[int, int]:
    if n <= 0:
        raise ValueError("occurrence must be >= 1")
    matches = list(pattern.finditer(haystack))
    if len(matches) < n:
        return (-1, -1)
    m = matches[n - 1]
    return (m.start(), m.end())


def _build_trailing_ws_fuzzy_pattern(snippet: str) -> "re.Pattern[str]":
    # Match snippet lines exactly, but allow trailing spaces/tabs at each line end in the file.
    # This avoids common selection-vs-file mismatches on Windows editors.
    lines = snippet.split("\n")
    parts = [re.escape(line) + r"[ \t]*" for line in lines]
    pattern = r"\n".join(parts)
    return re.compile(pattern)


def _similarity(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(a=a, b=b).ratio()


def _find_span_fuzzy(original_norm: str, old_norm: str, occurrence: int) -> tuple[int, int, str, float]:
    """
    Fuzzy fallback when exact match fails.

    Strategy:
    - Choose several line-anchors from the snippet (longer non-empty lines)
    - For each anchor occurrence in file, derive candidate start offsets
    - Locally search around each candidate start for best similarity score
    - Pick the Nth match by position among high-confidence candidates
    """
    snippet = old_norm
    file_text = original_norm
    snippet_len = len(snippet)
    if snippet_len == 0:
        return (-1, -1, "fuzzy", 0.0)

    # Build line anchors with their offsets in the snippet.
    anchors: list[tuple[int, str]] = []
    offset = 0
    for line in snippet.split("\n"):
        line_len = len(line)
        if line.strip() and line_len >= 6:
            anchors.append((offset, line))
        offset += line_len + 1  # + '\n'

    anchors.sort(key=lambda x: len(x[1]), reverse=True)
    anchors = anchors[:6]  # cap
    if not anchors:
        return (-1, -1, "fuzzy", 0.0)

    candidate_starts: set[int] = set()
    for line_offset, line in anchors:
        start = 0
        while True:
            pos = file_text.find(line, start)
            if pos < 0:
                break
            cand = pos - line_offset
            if cand >= 0:
                candidate_starts.add(cand)
            start = pos + max(1, len(line))

    if not candidate_starts:
        return (-1, -1, "fuzzy", 0.0)

    # Evaluate candidates: search a small neighborhood around each derived start.
    evaluated: list[tuple[int, int, float]] = []
    for base in sorted(candidate_starts):
        best_score = 0.0
        best_start = -1
        best_end = -1
        for delta in range(-80, 81, 10):
            s = base + delta
            if s < 0:
                continue
            window = file_text[s : s + snippet_len]
            score = _similarity(snippet, window)
            if score > best_score:
                best_score = score
                best_start = s
                best_end = s + len(window)
        if best_start >= 0:
            evaluated.append((best_start, best_end, best_score))

    # Keep only high-confidence matches and de-dup close starts.
    evaluated.sort(key=lambda x: (x[0], -x[2]))
    merged: list[tuple[int, int, float]] = []
    for s, e, score in evaluated:
        if score < 0.92:
            continue
        if merged and abs(merged[-1][0] - s) <= 5:
            # Keep the better score for near-duplicates
            if score > merged[-1][2]:
                merged[-1] = (s, e, score)
            continue
        merged.append((s, e, score))

    if len(merged) < occurrence:
        return (-1, -1, "fuzzy", 0.0)

    s, e, score = merged[occurrence - 1]
    return (s, e, "fuzzy", float(score))


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
    original_norm = _normalize_for_match(original)
    old_norm = _normalize_for_match(old_text)
    new_norm = _normalize_newlines(new_text)

    occ = int(occurrence)
    idx = _find_nth(original_norm, old_norm, occ)
    end_idx = idx + len(old_norm) if idx >= 0 else -1
    match_method = "exact"
    match_score = 1.0 if idx >= 0 else 0.0

    if idx < 0:
        # Fallback: tolerate trailing whitespace differences per line.
        # Also try with stripped final newline variants (selection often omits final newline).
        candidates = [old_norm]
        stripped_nl = old_norm.rstrip("\n")
        if stripped_nl and stripped_nl != old_norm:
            candidates.append(stripped_nl)
        stripped_all = old_norm.strip()
        if stripped_all and stripped_all not in candidates:
            candidates.append(stripped_all)

        for candidate in candidates:
            try:
                pattern = _build_trailing_ws_fuzzy_pattern(candidate)
                s, e = _find_nth_regex(original_norm, pattern, occ)
                if s >= 0:
                    idx, end_idx = s, e
                    match_method = "regex_trailing_ws"
                    match_score = 0.99
                    break
            except re.error:
                continue

    if idx < 0:
        s, e, method, score = _find_span_fuzzy(original_norm, old_norm, occ)
        if s >= 0:
            idx, end_idx = s, e
            match_method = method
            match_score = score

    if idx < 0 or end_idx < 0:
        target = Path(file_path).name
        raise ValueError(
            f"Snippet not found in file (occurrence={occurrence}): {target}. "
            "Tip: ensure selected snippet text matches the current file (including punctuation); "
            "the tool tolerates CRLF/LF, trailing spaces, and minor drift, but not arbitrary rewrites."
        )

    next_norm = original_norm[:idx] + new_norm + original_norm[end_idx:]
    next_text = _to_original_newlines(next_norm, original_had_crlf=original_had_crlf)

    verify_meta = _write_with_verify(file_path=file_path, content=next_text, verify=bool(verify))

    # Unified diff preview (git-like) for UI
    fromfile = f"{Path(file_path).name} (before)"
    tofile = f"{Path(file_path).name} (after)"
    old_lines = _normalize_newlines(original).splitlines(keepends=True)
    new_lines = _normalize_newlines(next_text).splitlines(keepends=True)
    diff_text = "".join(difflib.unified_diff(old_lines, new_lines, fromfile=fromfile, tofile=tofile, n=3))

    matched = original_norm[idx:end_idx]
    before_preview = matched[:200]
    after_preview = next_norm[max(0, idx - 200) : idx + min(len(new_norm), 200)]

    return ToolResult(
        status="succeeded",
        progress=100,
        results=[
            {
                "type": ToolArtifactType.TEXT,
                "content": diff_text or "",
                "mime": "text/x-diff; charset=utf-8",
                "meta": {"context_lines": 3, "fromfile": fromfile, "tofile": tofile},
            },
            {
                "type": ToolArtifactType.FILE,
                "url": file_path,
                "content": None,
                "mime": "text/plain; charset=utf-8",
                "meta": {
                    "occurrence": int(occurrence),
                    "match_method": match_method,
                    "match_score": float(match_score),
                    "replaced_chars": len(matched),
                    "inserted_chars": len(new_norm),
                    "before_preview": before_preview,
                    "after_preview": after_preview,
                    **verify_meta,
                },
            }
        ],
        meta={"file_path": file_path},
    ).model_dump(mode="json")
