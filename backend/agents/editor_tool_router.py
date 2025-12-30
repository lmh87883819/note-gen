from __future__ import annotations

import json
import os

from agno.agent import Agent
from pydantic import BaseModel, ConfigDict, Field

from ..data_types import ToolName
from .common import build_openai_like_model


class ToolRoute(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    tools: list[ToolName] = Field(default_factory=list, description="Tools allowed for this run (subset).")
    rationale: str = Field(default="", description="Short rationale for the selection.")


SYSTEM_PROMPT = """
You are a Tool Router for a Markdown editor agent.

Goal: choose a SMALL subset of tools (3-8) needed to accomplish the user's request safely.

CRITICAL:
- Output MUST be valid JSON matching the ToolRoute schema. No markdown, no extra text.
- Prefer safe, minimal-edit tools over full overwrite:
  - If context.selected_snippets exists and user asks to rewrite/polish/translate "this paragraph/snippet",
    choose generate_text + replace_snippet (+ read_file, diff_preview).
  - If user asks to "format to Markdown" or "make it easier to read", prefer minimal transforms and avoid adding chatty prefaces.
- Always include diff_preview when a write/replace is likely.
- Include read_file unless you are certain active_content is provided and sufficient.
- Avoid dangerous tools unless necessary (write_file / apply_patch / replace_lines / replace_snippet).

Available tools:
- list_files
- read_file
- generate_text
- diff_preview
- verify_contains
- replace_lines
- replace_snippet
- apply_patch
- write_file

Input: a JSON object string with:
{
  "message": string,
  "context": {
    "workspace_root": string|null,
    "active_file_path": string|null,
    "active_content": string|null,
    "selected_snippets": [{"file_path": string, "snippet": string}]|null
  }
}
""".strip()


def get_editor_tool_router_agent() -> Agent:
    return Agent(
        model=build_openai_like_model(),
        description="Editor Tool Router (select subset of tools)",
        instructions=SYSTEM_PROMPT,
        output_schema=ToolRoute,
        parse_response=True,
        use_json_mode=True,
        debug_mode=os.getenv("AGNO_DEBUG", "false").lower() == "true",
    )


def build_editor_router_input(
    *,
    message: str,
    workspace_root: str | None,
    active_file_path: str | None,
    active_content: str | None,
    selected_snippets: list[dict] | None = None,
) -> str:
    payload = {
        "message": message,
        "context": {
            "workspace_root": workspace_root,
            "active_file_path": active_file_path,
            "active_content": active_content,
            "selected_snippets": selected_snippets,
        },
    }
    return json.dumps(payload, ensure_ascii=False)

