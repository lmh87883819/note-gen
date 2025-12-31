from __future__ import annotations

from typing import Any, Dict, List

from ..data_types import ToolName


# Centralized, short tool docs for routing/planning (kept intentionally small).
# When tools grow to 30+, this is the single place to extend.
TOOL_SPECS: Dict[ToolName, Dict[str, Any]] = {
    ToolName.LIST_FILES: {
        "name": ToolName.LIST_FILES.value,
        "description": "列出工作区内文件（可按 query 过滤）。",
        "args": {"workspace_root": "string|null", "query": "string?", "limit": "number?"},
        "dangerous": False,
    },
    ToolName.READ_FILE: {
        "name": ToolName.READ_FILE.value,
        "description": "读取文本文件，返回 content。",
        "args": {"file_path": "string", "workspace_root": "string?", "max_chars": "number?", "allow_outside_workspace": "boolean?"},
        "dangerous": False,
    },
    ToolName.GENERATE_TEXT: {
        "name": ToolName.GENERATE_TEXT.value,
        "description": "调用 LLM 生成文本（用于新全文或新片段）。",
        "args": {"prompt": "string", "system": "string?", "model": "string?", "temperature": "number?", "max_tokens": "number?"},
        "dangerous": False,
    },
    ToolName.WEB_SEARCH: {
        "name": ToolName.WEB_SEARCH.value,
        "description": "联网搜索（Bing），返回 top 结果（title/url/snippet）JSON 文本。",
        "args": {"query": "string", "limit": "number?", "region": "string?"},
        "dangerous": False,
    },
    ToolName.DIFF_PREVIEW: {
        "name": ToolName.DIFF_PREVIEW.value,
        "description": "生成 unified diff 预览（old_content -> new_content）。",
        "args": {"old_content": "string", "new_content": "string", "fromfile": "string?", "tofile": "string?", "context_lines": "number?"},
        "dangerous": False,
    },
    ToolName.VERIFY_CONTAINS: {
        "name": ToolName.VERIFY_CONTAINS.value,
        "description": "断言文本必须包含/不得包含某些内容。",
        "args": {"content": "string", "must_include": "string|array", "must_not_include": "string|array?", "case_sensitive": "boolean?"},
        "dangerous": False,
    },
    ToolName.REPLACE_LINES: {
        "name": ToolName.REPLACE_LINES.value,
        "description": "按行号替换一段内容（精确编辑）。",
        "args": {"file_path": "string", "start_line": "number", "end_line": "number", "content": "string", "verify": "boolean?"},
        "dangerous": True,
    },
    ToolName.REPLACE_SNIPPET: {
        "name": ToolName.REPLACE_SNIPPET.value,
        "description": "按文本片段精确替换（用于改写选中段落，避免全文件重写）。",
        "args": {"file_path": "string", "old_text": "string", "new_text": "string", "workspace_root": "string?", "occurrence": "number?", "verify": "boolean?"},
        "dangerous": True,
    },
    ToolName.APPLY_PATCH: {
        "name": ToolName.APPLY_PATCH.value,
        "description": "应用 unified diff patch。",
        "args": {"file_path": "string", "patch": "string", "verify": "boolean?"},
        "dangerous": True,
    },
    ToolName.WRITE_FILE: {
        "name": ToolName.WRITE_FILE.value,
        "description": "写入（覆盖）文件内容（verify 默认 true）。",
        "args": {"file_path": "string", "content": "string", "workspace_root": "string?", "allow_empty": "boolean?", "verify": "boolean?"},
        "dangerous": True,
    },
}


def build_tool_docs(tools: List[ToolName]) -> List[Dict[str, Any]]:
    docs: List[Dict[str, Any]] = []
    for t in tools:
        spec = TOOL_SPECS.get(t)
        if spec:
            docs.append(spec)
        else:
            docs.append({"name": t.value, "description": "(no description)", "args": {}, "dangerous": True})
    return docs

