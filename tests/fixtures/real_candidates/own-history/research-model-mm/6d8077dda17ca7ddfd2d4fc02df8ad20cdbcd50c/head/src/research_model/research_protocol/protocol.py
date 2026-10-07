"""Neutral, provider-independent research action protocol."""

from __future__ import annotations

import json
from typing import Any

ACTIONS = {"SEARCH", "READ", "EXTRACT", "COMPARE", "QUESTION", "SYNTHESIZE", "STOP"}
STATES = {"question", "planning", "searching", "source_review", "evidence_review", "synthesis", "complete"}
CONFIDENCES = {"low", "medium", "high", "unknown"}

SYSTEM_INSTRUCTION = """You are a research-evidence assistant. Optimize for rigor, provenance, and calibrated uncertainty.
Return exactly one JSON object and no markdown. Do not invent a source, citation, quotation, DOI, result, or evidence span.
Every factual claim must name the source_ids that support it. If the supplied evidence is insufficient, say so and choose a useful next action.
Use only these action values: SEARCH, READ, EXTRACT, COMPARE, QUESTION, SYNTHESIZE, STOP.
Use only these confidence values: low, medium, high, unknown.
The observable research protocol is:
{"state":"...","action":"...","query":null,"source_ids":[],"claims":[],"evidence":[],"gaps":[],"confidence":"...","next_action":"..."}
"""


def build_prompt(question: str, context: str = "", task_type: str = "research_plan") -> str:
    payload = {
        "task_type": task_type,
        "question": question,
        "supplied_evidence": context,
        "required_fields": ["state", "action", "query", "source_ids", "claims", "evidence", "gaps", "confidence", "next_action"],
    }
    return SYSTEM_INSTRUCTION + "\nTASK\n" + json.dumps(payload, ensure_ascii=False, indent=2)


def validate_protocol_output(value: Any) -> list[str]:
    """Return deterministic validation errors; an empty list means valid."""
    errors: list[str] = []
    if not isinstance(value, dict):
        return ["output is not an object"]
    required = {"state", "action", "query", "source_ids", "claims", "evidence", "gaps", "confidence", "next_action"}
    missing = sorted(required - set(value))
    if missing:
        errors.append("missing fields: " + ", ".join(missing))
    if value.get("state") not in STATES:
        errors.append("invalid state")
    if value.get("action") not in ACTIONS:
        errors.append("invalid action")
    if value.get("confidence") not in CONFIDENCES:
        errors.append("invalid confidence")
    if value.get("query") is not None and not isinstance(value.get("query"), str):
        errors.append("query must be string or null")
    for field in ("source_ids", "claims", "evidence", "gaps"):
        if not isinstance(value.get(field), list):
            errors.append(f"{field} must be a list")
    if value.get("next_action") is not None and value.get("next_action") not in ACTIONS:
        errors.append("invalid next_action")
    if isinstance(value.get("claims"), list):
        for i, claim in enumerate(value["claims"]):
            if not isinstance(claim, dict):
                errors.append(f"claims[{i}] must be an object")
            elif not isinstance(claim.get("text"), str):
                errors.append(f"claims[{i}].text must be a string")
    if isinstance(value.get("evidence"), list):
        for i, evidence in enumerate(value["evidence"]):
            if not isinstance(evidence, dict):
                errors.append(f"evidence[{i}] must be an object")
            elif not isinstance(evidence.get("source_id"), str) or not isinstance(evidence.get("text"), str):
                errors.append(f"evidence[{i}] needs source_id and text")
    return errors
