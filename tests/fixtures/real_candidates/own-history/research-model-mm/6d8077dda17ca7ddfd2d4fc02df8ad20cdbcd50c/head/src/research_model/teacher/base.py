from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol


@dataclass(frozen=True)
class TeacherRequest:
    task_type: str
    question: str
    context: str
    source_ids: tuple[str, ...] = ()
    prompt_version: str = "teacher-prompt-v1"
    generation_settings: dict[str, Any] = field(default_factory=dict)


@dataclass
class TeacherResponse:
    output: dict[str, Any]
    teacher_model: str
    prompt_version: str
    generation_settings: dict[str, Any]
    validator_result: dict[str, Any] = field(default_factory=dict)
    accepted: bool = False
    rejection_reason: str | None = None
    provider: str = "unknown"
    raw_output: Any = None
    usage: dict[str, Any] = field(default_factory=dict)
    estimated_cost_usd: float | None = None
    generated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class Teacher(Protocol):
    model_name: str

    def generate(self, request: TeacherRequest) -> TeacherResponse:
        ...
