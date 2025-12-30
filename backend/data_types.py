from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, RootModel


# 1. 定义我们支持的工具 (Enum 防止 AI 瞎编工具名)
class ToolName(str, Enum):
    GENERATE_IMAGE = "generate_image"  # 生图
    REMOVE_BACKGROUND = "remove_background"  # 抠图
    IMAGE_TO_VIDEO = "image_to_video"  # 图生视频
    UPSCALE_IMAGE = "upscale_image"  # 放大图片
    MODIFY_IMAGE = "modify_image"  # 局部重绘
    # --- Editor / Filesystem ---
    READ_FILE = "read_file"  # 读文件
    WRITE_FILE = "write_file"  # 写文件（覆盖）
    LIST_FILES = "list_files"  # 列目录/文件
    GENERATE_TEXT = "generate_text"  # 文本生成（LLM）
    DIFF_PREVIEW = "diff_preview"  # 生成 diff 预览
    VERIFY_CONTAINS = "verify_contains"  # 验证内容包含（断言）
    REPLACE_LINES = "replace_lines"  # 按行替换（精确编辑）
    APPLY_PATCH = "apply_patch"  # 应用 unified diff patch


# 2. JARVIS 风格任务规划结构（parse_task 输出）
class PlannedTask(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    task: ToolName = Field(..., description="任务类型/工具名（必须来自 ToolName）")
    id: int = Field(..., ge=1, description="任务 id（从 1 开始）")
    dep: List[int] = Field(default_factory=list, description="依赖任务 id 列表")
    args: Dict[str, Any] = Field(default_factory=dict, description="任务参数字典")


class TaskPlan(RootModel[List[PlannedTask]]):
    """
    规划输出是一个 JSON 数组：
    [{"task": str, "id": int, "dep": [int], "args": { ... }}, ...]
    """

    root: List[PlannedTask]


class AssetType(str, Enum):
    IMAGE = "image"
    VIDEO = "video"
    FILE = "file"
    TEXT = "text"


class Asset(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    id: str
    type: AssetType
    uri: str = Field(..., description="本地路径或可访问的 URL")
    meta: Dict[str, Any] = Field(default_factory=dict)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str
    assets: List[str] = Field(default_factory=list, description="关联的 asset_id 列表")


class SessionMemory(BaseModel):
    session_id: str
    history: List[ChatMessage] = Field(default_factory=list)
    assets: Dict[str, Asset] = Field(default_factory=dict)


class StepStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class StepOutput(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    asset_id: Optional[str] = None
    asset_uri: Optional[str] = None
    data: Dict[str, Any] = Field(default_factory=dict)


class ExecutedStep(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    id: int
    task: ToolName
    status: StepStatus
    args: Dict[str, Any] = Field(default_factory=dict)
    dep: List[int] = Field(default_factory=list)
    output: StepOutput = Field(default_factory=StepOutput)
    error: Optional[str] = None


class RunResult(BaseModel):
    session_id: str
    plan: TaskPlan
    steps: List[ExecutedStep]
    assets: Dict[str, Asset] = Field(default_factory=dict)


class EnrichedArgs(BaseModel):
    """
    Specialist Agent 的结构化输出：返回可直接执行的 args。
    """

    args: Dict[str, Any] = Field(default_factory=dict)


class DomainName(str, Enum):
    IMAGE = "image"
    VIDEO = "video"
    SEARCH = "search"
    GENERAL = "general"


class RoutedTask(BaseModel):
    """
    Router(Planner) 的输出：领域级任务（分配给二层 Agent）。
    """

    id: int = Field(..., ge=1)
    agent: DomainName
    dep: List[int] = Field(default_factory=list)
    args: Dict[str, Any] = Field(default_factory=dict)


class RoutedPlan(RootModel[List[RoutedTask]]):
    root: List[RoutedTask]


class PlanReview(BaseModel):
    warnings: List[str] = Field(default_factory=list)
    editable_fields: List[str] = Field(default_factory=list)
    defaults_applied: Dict[str, Any] = Field(default_factory=dict)


class DomainAgentOutput(BaseModel):
    """
    二层领域 Agent 的输出：可执行 tool-level TaskPlan + review 元信息（不影响执行）。
    """

    plan: TaskPlan
    review: PlanReview = Field(default_factory=PlanReview)
    message: Optional[str] = None
    questions: List[str] = Field(default_factory=list)
    optimized_prompt: Optional[str] = None


class ToolArtifactType(str, Enum):
    IMAGE = "image"
    VIDEO = "video"
    TEXT = "text"
    FILE = "file"


class ToolArtifact(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    type: ToolArtifactType
    url: Optional[str] = None
    content: Optional[str] = None
    mime: Optional[str] = None
    meta: Dict[str, Any] = Field(default_factory=dict)


class ToolResult(BaseModel):
    """
    所有 Tools 的统一返回结构（强烈建议后续所有 API 适配都遵循它）。
    """

    id: Optional[str] = None
    status: Literal["running", "succeeded", "failed"] = "succeeded"
    progress: int = 100
    results: List[ToolArtifact] = Field(default_factory=list)
    failure_reason: str = ""
    error: str = ""
    meta: Dict[str, Any] = Field(default_factory=dict)
    raw: Dict[str, Any] = Field(default_factory=dict)


class GuardDecision(BaseModel):
    """
    Guard Agent 输出：在进入 Router Planner 前做边界判定。
    """

    allow: bool = True
    category: Literal["ok", "policy", "capability"] = "ok"
    message: str = ""
    suggested_design_prompts: List[str] = Field(default_factory=list)
