from __future__ import annotations

from .base import TeacherRequest, TeacherResponse


class HeuristicTeacher:
    """Deterministic teacher for non-factual planning supervision.

    It deliberately refuses to invent source-grounded content. Factual tasks
    must use source annotations or an independently validated external teacher.
    """

    model_name = "deterministic-heuristic-v1"

    def generate(self, request: TeacherRequest) -> TeacherResponse:
        query = " ".join(request.question.replace("?", "").split()[:12])
        output = {"state": "planning", "action": "SEARCH", "query": query, "source_ids": [], "claims": [], "evidence": [], "gaps": ["Independent primary evidence, study design, population, and replication status must be checked."], "confidence": "unknown", "next_action": "READ"}
        return TeacherResponse(output=output, teacher_model=self.model_name, prompt_version=request.prompt_version, generation_settings=request.generation_settings, accepted=True, provider="local-deterministic", raw_output=output)
