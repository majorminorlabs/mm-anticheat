from __future__ import annotations

from typing import Any

from ..validation.validators import validate_output_against_example


def _set(value: Any) -> set[str]:
    return {str(item) for item in value} if isinstance(value, list) else set()


def _f1(predicted: set[str], expected: set[str]) -> float:
    if not predicted and not expected:
        return 1.0
    if not predicted or not expected:
        return 0.0
    precision = len(predicted & expected) / len(predicted); recall = len(predicted & expected) / len(expected)
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def score_example(example: dict[str, Any], predicted: Any) -> dict[str, Any]:
    expected = example["expected_output"]; validity_errors = validate_output_against_example(example, predicted)
    expected_sources = _set(expected.get("source_ids")); predicted_sources = _set(predicted.get("source_ids")) if isinstance(predicted, dict) else set()
    expected_status = {str(c.get("status")) for c in expected.get("claims", []) if isinstance(c, dict)}
    predicted_status = {str(c.get("status")) for c in predicted.get("claims", []) if isinstance(c, dict)} if isinstance(predicted, dict) else set()
    expected_evidence = {str(e.get("text")) for e in expected.get("evidence", []) if isinstance(e, dict)}
    predicted_evidence = {str(e.get("text")) for e in predicted.get("evidence", []) if isinstance(e, dict)} if isinstance(predicted, dict) else set()
    score = {"example_id": example["example_id"], "task_type": example["task_type"], "structured_valid": not validity_errors, "validation_errors": validity_errors, "action_accuracy": int(isinstance(predicted, dict) and predicted.get("action") == expected.get("action")), "citation_precision": len(predicted_sources & expected_sources) / len(predicted_sources) if predicted_sources else (1.0 if not expected_sources else 0.0), "citation_recall": len(predicted_sources & expected_sources) / len(expected_sources) if expected_sources else (1.0 if not predicted_sources else 0.0), "claim_status_f1": _f1(predicted_status, expected_status), "evidence_recall": len(predicted_evidence & expected_evidence) / len(expected_evidence) if expected_evidence else (1.0 if not predicted_evidence else 0.0), "unsupported_claim_rate": 1.0 if validity_errors and any("evidence" in error or "unknown source" in error for error in validity_errors) else 0.0}
    if example.get("task_type") == "insufficient_evidence":
        expected_insufficient = "INSUFFICIENT_EVIDENCE" in expected_status or expected.get("action") == "QUESTION"
        predicted_insufficient = "INSUFFICIENT_EVIDENCE" in predicted_status or (isinstance(predicted, dict) and predicted.get("action") == "QUESTION")
        score["insufficient_evidence_accuracy"] = int(expected_insufficient == predicted_insufficient)
    return score


def aggregate_scores(scores: list[dict[str, Any]], include_by_task: bool = True) -> dict[str, Any]:
    if not scores:
        return {"count": 0}
    numeric = sorted({key for row in scores for key, value in row.items() if isinstance(value, (int, float))})
    result: dict[str, Any] = {"count": len(scores)}
    for key in numeric:
        values = [float(row[key]) for row in scores if isinstance(row.get(key), (int, float))]
        result[key] = sum(values) / len(values) if values else None
        if len(values) != len(scores):
            result[f"{key}_count"] = len(values)
    by_task: dict[str, list[dict[str, Any]]] = {}
    for score in scores:
        by_task.setdefault(score["task_type"], []).append(score)
    if include_by_task:
        result["by_task"] = {task: aggregate_scores(rows, include_by_task=False) for task, rows in by_task.items()}
    return result
