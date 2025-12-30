from __future__ import annotations

from agno.tools import Function

from ..data_types import ToolName
from .apply_patch import apply_patch
from .diff_preview import diff_preview
from .editor_fs import read_file, write_file
from .grsai_draw import generate_image
from .list_files import list_files
from .llm_text import generate_text
from .replace_lines import replace_lines
from .replace_snippet import replace_snippet
from .verify_contains import verify_contains


def build_tools() -> dict[ToolName, Function]:
    return {
        ToolName.GENERATE_IMAGE: generate_image,
        ToolName.LIST_FILES: list_files,
        ToolName.READ_FILE: read_file,
        ToolName.GENERATE_TEXT: generate_text,
        ToolName.DIFF_PREVIEW: diff_preview,
        ToolName.VERIFY_CONTAINS: verify_contains,
        ToolName.REPLACE_LINES: replace_lines,
        ToolName.REPLACE_SNIPPET: replace_snippet,
        ToolName.APPLY_PATCH: apply_patch,
        ToolName.WRITE_FILE: write_file,
    }
