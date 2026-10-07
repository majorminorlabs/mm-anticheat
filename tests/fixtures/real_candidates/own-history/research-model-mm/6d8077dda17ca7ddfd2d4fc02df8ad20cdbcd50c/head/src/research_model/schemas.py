"""Small dependency-free dataset schema and validation helpers."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .research_protocol.protocol import validate_protocol_output

TASK_TYPES = {
    "question_decomposition", "search_query_generation", "query_refinement", "source_ranking",
    "terminology_expansion", "source_relevance", "source_rejection", "primary_secondary_classification", "claim_extraction", "evidence_extraction",
    "claim_source_attribution", "contradiction_detection", "conflicting_study_comparison",
    "methodology_criticism", "study_design_recognition", "evidence_strength", "missing_evidence", "research_gap", "follow_up_question", "next_best_action",
    "evidence_synthesis", "insufficient_evidence", "stopping_criteria", "citation_integrity",
    "research_plan", "evidence_table", "systematic_review_reasoning", "correlation_causation",
    "overclaiming", "population_applicability", "temporal_applicability", "benchmark_claim_evaluation", "reproducibility_assessment", "evidence_verification",
}

DOMAINS = {"ai_ml", "software_systems", "biomedical", "behavioral_science", "education", "general_scientific_research", "hardware"}
DIFFICULTIES = {"easy", "medium", "hard", "very_hard"}


def stable_id(*parts: str) -> str:
    joined = "\x1f".join(parts).encode("utf-8")
    return hashlib.sha256(joined).hexdigest()[:20]


def validate_example(example: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(example, dict):
        return ["example is not an object"]
    required = {"example_id", "task_type", "domain", "difficulty", "question", "context", "source_ids", "source_metadata", "search_state", "research_actions", "evidence", "claims", "contradictions", "gaps", "uncertainty", "expected_output", "provenance", "license", "split", "generation_method"}
    missing = sorted(required - set(example))
    if missing:
        errors.append("missing fields: " + ", ".join(missing))
    if example.get("task_type") not in TASK_TYPES:
        errors.append("unknown task_type")
    if example.get("domain") not in DOMAINS:
        errors.append("unknown domain")
    if example.get("difficulty") not in DIFFICULTIES:
        errors.append("unknown difficulty")
    for field in ("source_ids", "source_metadata", "search_state", "research_actions", "evidence", "claims", "contradictions", "gaps"):
        if not isinstance(example.get(field), (list, dict)):
            errors.append(f"{field} must be list or object")
    if example.get("split") not in {"train", "validation", "test"}:
        errors.append("invalid split")
    if not isinstance(example.get("expected_output"), dict):
        errors.append("expected_output must be an object")
    else:
        errors.extend(validate_protocol_output(example["expected_output"]))
    if not isinstance(example.get("provenance"), dict):
        errors.append("provenance must be an object")
    return errors


def dumps(example: dict[str, Any]) -> str:
    return json.dumps(example, ensure_ascii=False, sort_keys=True)
