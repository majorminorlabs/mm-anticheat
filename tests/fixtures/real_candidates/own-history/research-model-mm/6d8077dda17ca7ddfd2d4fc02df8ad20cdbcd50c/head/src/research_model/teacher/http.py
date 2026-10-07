"""Generic OpenAI-compatible HTTP teacher; no provider is hard-coded."""

from __future__ import annotations

import json
import os
import urllib.request

from .base import TeacherRequest, TeacherResponse


class HTTPJSONTeacher:
    def __init__(self, endpoint: str | None = None, api_key_env: str = "TEACHER_API_KEY", model_name: str = "external-json-teacher", timeout: int = 120) -> None:
        self.endpoint = endpoint or os.environ.get("TEACHER_ENDPOINT", ""); self.api_key = os.environ.get(api_key_env); self.model_name = model_name; self.timeout = timeout
        if not self.endpoint:
            raise ValueError("TEACHER_ENDPOINT or endpoint is required")

    def generate(self, request: TeacherRequest) -> TeacherResponse:
        payload = {"model": self.model_name, "task_type": request.task_type, "question": request.question, "context": request.context, "source_ids": request.source_ids, "prompt_version": request.prompt_version, "generation_settings": request.generation_settings}
        headers = {"Content-Type": "application/json", "User-Agent": "research-model/0.1"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(self.endpoint, data=json.dumps(payload).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
        output = body.get("output", body)
        usage = body.get("usage", {}) if isinstance(body, dict) else {}
        return TeacherResponse(output=output, teacher_model=self.model_name, prompt_version=request.prompt_version, generation_settings=request.generation_settings, provider="http-json", raw_output=body, usage=usage)
