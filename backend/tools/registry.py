from __future__ import annotations

from agno.tools import Function

from ..data_types import ToolName
from .grsai_draw import generate_image


def build_tools() -> dict[ToolName, Function]:
    # 当前仅接入 grsai 绘画
    return {ToolName.GENERATE_IMAGE: generate_image}

