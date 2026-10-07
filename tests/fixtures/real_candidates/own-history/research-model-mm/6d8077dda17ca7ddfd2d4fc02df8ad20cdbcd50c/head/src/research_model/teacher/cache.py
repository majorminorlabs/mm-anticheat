from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from .base import Teacher, TeacherRequest, TeacherResponse


class CachedTeacher:
    """Cache expensive teacher calls by request content and settings."""

    def __init__(self, teacher: Teacher, cache_dir: str | Path = "teacher_cache") -> None:
        self.teacher = teacher; self.cache_dir = Path(cache_dir); self.cache_dir.mkdir(parents=True, exist_ok=True)

    def generate(self, request: TeacherRequest) -> TeacherResponse:
        payload = {"request": request.__dict__, "teacher": self.teacher.model_name}
        key = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        path = self.cache_dir / f"{key}.json"
        if path.exists():
            cached = json.loads(path.read_text(encoding="utf-8"))
            return TeacherResponse(**cached.get("response", cached))
        response = self.teacher.generate(request)
        if response.raw_output is None:
            response.raw_output = response.output
        cache_entry = {"cache_schema_version": "1.0", "request_hash": key, "cached_at": datetime.now(timezone.utc).isoformat(), "request": request.__dict__, "response": response.__dict__}
        path.write_text(json.dumps(cache_entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return response
