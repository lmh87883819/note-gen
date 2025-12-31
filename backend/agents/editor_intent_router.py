from __future__ import annotations

import json
import os

from agno.agent import Agent
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field

from .common import build_openai_like_model

load_dotenv()


class EditorIntentDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent: str = Field(..., description="One of: edit_article | review_article | chat | clarify")
    rationale: str = Field(default="", description="Short rationale (for logs).")
    clarify_prompt: str = Field(
        default="",
        description="If intent=clarify: a user-facing message asking 1-3 targeted questions and giving 2-3 options.",
    )


SYSTEM_PROMPT = """
You are an Intent Router for a Markdown note editor assistant.

Decide the user's intent BEFORE running the editor planner.

You MUST output valid JSON matching the schema:
{ "intent": "edit_article|review_article|chat|clarify", "rationale": "...", "clarify_prompt": "..." }
No markdown, no extra text.

Input is a JSON object string with fields:
{
  "message": string,
  "context": {
    "active_file_path": string|null,
    "selected_snippets": [{"file_path": string, "snippet": string}]|null,
    "agent_context": string|null
  }
}

Guidelines:
- intent=edit_article when the user clearly wants to modify the current article/file (rewrite, polish, expand, delete, format, fix headings, etc),
  or when selected_snippets are provided for rewrite/polish/translate.
- intent=review_article when the user asks for feedback/evaluation/summary of how the current article is written,
  WITHOUT asking to modify the file.
- intent=chat when it's clearly general conversation (jokes, explanations, brainstorming) and does NOT ask to modify files.
- intent=clarify when it's ambiguous, especially short follow-ups like "长一点/再来一个/换个风格" while an article is open.

When intent=clarify:
- Provide clarify_prompt in Chinese.
- Include 2 quick options the user can copy, like:
  1) "只聊天：把上一个笑话写长一点"
  2) "改文章：把当前文章扩写到 800 字"
- Ask at most 3 questions, keep it concise, no greetings.
""".strip()


def get_editor_intent_router_agent() -> Agent:
    return Agent(
        model=build_openai_like_model(),
        description="Editor Intent Router (chat vs edit vs review vs clarify)",
        instructions=SYSTEM_PROMPT,
        output_schema=EditorIntentDecision,
        parse_response=True,
        use_json_mode=True,
        debug_mode=os.getenv("AGNO_DEBUG", "false").lower() == "true",
    )


def build_editor_intent_input(
    *,
    message: str,
    active_file_path: str | None,
    selected_snippets: list[dict] | None = None,
    agent_context: str | None = None,
) -> str:
    payload = {
        "message": message,
        "context": {
            "active_file_path": active_file_path,
            "selected_snippets": selected_snippets,
            "agent_context": agent_context,
        },
    }
    return json.dumps(payload, ensure_ascii=False)

