from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from typing import Any, Iterable

from ..research_protocol.protocol import validate_protocol_output
from ..schemas import validate_example


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", str(text).lower()).strip()


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]{3,}", _norm(text)))


def _row_key(row: dict[str, Any]) -> str:
    payload = {
        "task_type": row.get("task_type"),
        "question": _norm(row.get("question", "")),
        "context": _norm(row.get("context", "")),
        "expected_output": row.get("expected_output"),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def validate_output_against_example(example: dict[str, Any], output: Any) -> list[str]:
    errors = validate_protocol_output(output)
    if errors:
        return errors
    known_sources = set(map(str, example.get("source_ids", [])))
    for source_id in output.get("source_ids", []):
        if str(source_id) not in known_sources:
            errors.append(f"unknown source id: {source_id}")
    context = _norm(example.get("context", ""))
    for evidence in output.get("evidence", []):
        if str(evidence.get("source_id", "")) not in known_sources:
            errors.append(f"evidence cites unknown source id: {evidence.get('source_id')}")
        if _norm(evidence.get("text", "")) not in context:
            errors.append("evidence text is not present in supplied context")
    for claim in output.get("claims", []):
        for source_id in claim.get("source_ids", []):
            if str(source_id) not in known_sources:
                errors.append(f"claim cites unknown source id: {source_id}")
    return sorted(set(errors))


def _validate_grounding(row: dict[str, Any], strict: bool) -> list[str]:
    errors: list[str] = []
    planning_tasks = {"research_plan", "question_decomposition", "search_query_generation", "query_refinement", "terminology_expansion"}
    if not isinstance(row.get("question"), str) or len(_norm(row.get("question", ""))) < 8:
        errors.append("low-information question")
    if row.get("task_type") not in planning_tasks and not _norm(row.get("context", "")):
        errors.append("missing context for evidence task")
    known_sources = set(map(str, row.get("source_ids", [])))
    if not known_sources and row.get("task_type") not in {"research_plan", "question_decomposition", "search_query_generation", "query_refinement", "terminology_expansion"}:
        errors.append("evidence task has no source id")
    metadata = row.get("source_metadata", [])
    if strict and known_sources and isinstance(metadata, list) and not metadata:
        errors.append("missing source metadata")
    if isinstance(metadata, list):
        metadata_ids = {str(item.get("source_id")) for item in metadata if isinstance(item, dict) and item.get("source_id") is not None}
        if not known_sources.issubset(metadata_ids) and metadata:
            errors.append("source metadata does not cover source_ids")
    context = _norm(row.get("context", ""))
    for evidence in row.get("evidence", []) if isinstance(row.get("evidence"), list) else []:
        if not isinstance(evidence, dict):
            continue
        if str(evidence.get("source_id")) not in known_sources:
            errors.append("evidence cites unknown source id")
        if not _norm(evidence.get("text", "")) or _norm(evidence.get("text", "")) not in context:
            errors.append("evidence text is not present in supplied context")
    expected = row.get("expected_output")
    if isinstance(expected, dict):
        expected_sources = set(map(str, expected.get("source_ids", [])))
        if not expected_sources.issubset(known_sources):
            errors.append("expected output cites unknown source id")
        for claim in expected.get("claims", []):
            if isinstance(claim, dict) and not set(map(str, claim.get("source_ids", []))).issubset(known_sources):
                errors.append("expected claim cites unknown source id")
        for evidence in expected.get("evidence", []):
            if isinstance(evidence, dict):
                if str(evidence.get("source_id")) not in known_sources:
                    errors.append("expected evidence cites unknown source id")
                if _norm(evidence.get("text", "")) not in context:
                    errors.append("expected evidence text is not present in supplied context")
    if strict:
        if not isinstance(row.get("license_class"), str) or not row.get("license_class"):
            errors.append("missing license_class")
        if row.get("task_type") not in planning_tasks and (not isinstance(row.get("provenance"), dict) or not row.get("provenance", {}).get("source_record_ids")):
            errors.append("missing provenance source_record_ids")
        if row.get("task_type") not in planning_tasks and len(_tokens(row.get("context", ""))) < 8:
            errors.append("low-information context")
    return sorted(set(errors))


def dataset_composition(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    rows = list(rows)

    def counts(field: str) -> dict[str, int]:
        return dict(sorted(Counter(str(row.get(field, "<missing>")) for row in rows).items()))

    matrix: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    source_types: Counter[str] = Counter()
    license_classes: Counter[str] = Counter()
    for row in rows:
        matrix[str(row.get("domain", "<missing>"))][str(row.get("task_type", "<missing>"))] += 1
        for metadata in row.get("source_metadata", []) if isinstance(row.get("source_metadata"), list) else []:
            if isinstance(metadata, dict) and metadata.get("source_type"):
                source_types[str(metadata["source_type"])] += 1
        license_classes[str(row.get("license_class", "<unspecified>"))] += 1
    task_types = sorted({task for row in matrix.values() for task in row})
    return {
        "count": len(rows),
        "by_domain": counts("domain"),
        "by_task_family": counts("task_type"),
        "by_difficulty": counts("difficulty"),
        "by_license_class": dict(sorted(license_classes.items())),
        "by_source_type": dict(sorted(source_types.items())),
        "domain_by_task_family": {domain: {task: row.get(task, 0) for task in task_types} for domain, row in sorted(matrix.items())},
    }


def validate_dataset(rows: list[dict[str, Any]], strict: bool = False) -> dict[str, Any]:
    """Validate structure, grounding, duplication, and source-group leakage.

    ``strict=True`` is used for new release candidates.  The default remains
    compatible with the historical pilot and controlled benchmark fixtures.
    """

    seen_ids: Counter[str] = Counter()
    seen_keys: dict[str, str] = {}
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for row in rows:
        errors = validate_example(row)
        example_id = row.get("example_id", "<missing>")
        seen_ids[str(example_id)] += 1
        if not row.get("example_id"):
            errors.append("missing example_id")
        errors.extend(_validate_grounding(row, strict))
        row_key = _row_key(row)
        if row_key in seen_keys:
            errors.append("duplicate normalized example")
        else:
            seen_keys[row_key] = str(example_id)
        if errors:
            rejected.append({"example_id": row.get("example_id"), "errors": sorted(set(errors))})
        else:
            accepted.append(row)

    duplicate_ids = sorted([key for key, value in seen_ids.items() if value > 1])
    if duplicate_ids:
        rejected.extend({"example_id": key, "errors": ["duplicate example_id"]} for key in duplicate_ids)
        accepted = [row for row in accepted if str(row.get("example_id")) not in duplicate_ids]

    by_group: dict[str, set[str]] = {}
    for row in accepted:
        group = "|".join(sorted(map(str, row.get("source_ids", []))))
        by_group.setdefault(group, set()).add(str(row.get("split")))
    leakage = sorted(group for group, splits in by_group.items() if group and len(splits) > 1)
    for group in leakage:
        rejected.append({"example_id": group, "errors": ["source group crosses splits"]})
    accepted = [row for row in accepted if "|".join(sorted(map(str, row.get("source_ids", [])))) not in leakage]
    causes: Counter[str] = Counter(error for item in rejected for error in item["errors"])
    return {
        "accepted": accepted,
        "rejected": rejected,
        "accepted_count": len(accepted),
        "rejected_count": len(rejected),
        "rejection_rate": len(rejected) / max(1, len(rows)),
        "rejection_causes": dict(sorted(causes.items())),
        "leakage_groups": leakage,
        "composition": dataset_composition(accepted),
    }


def validate_contamination(training_rows: list[dict[str, Any]], benchmark_rows: list[dict[str, Any]], near_duplicate_threshold: float = 0.9) -> dict[str, Any]:
    """Check exact, source-ID, and high-overlap question contamination."""

    train_exact = {_norm(row.get("question", "")) + "\x1f" + _norm(row.get("context", "")) for row in training_rows}
    benchmark_exact = {_norm(row.get("question", "")) + "\x1f" + _norm(row.get("context", "")) for row in benchmark_rows}
    exact = sorted(train_exact & benchmark_exact)
    train_sources = {str(source) for row in training_rows for source in row.get("source_ids", [])}
    benchmark_sources = {str(source) for row in benchmark_rows for source in row.get("source_ids", [])}
    source_overlap = sorted(train_sources & benchmark_sources)
    train_question_tokens = [(row.get("example_id"), _tokens(row.get("question", "")), _norm(row.get("question", ""))) for row in training_rows]
    similar_questions: list[dict[str, Any]] = []
    for benchmark in benchmark_rows:
        target = _tokens(benchmark.get("question", ""))
        if not target:
            continue
        for train_id, source, normalized in train_question_tokens:
            union = len(target | source)
            score = len(target & source) / union if union else 0.0
            if score >= near_duplicate_threshold and _norm(benchmark.get("question", "")) != normalized:
                similar_questions.append({"benchmark_example_id": benchmark.get("example_id"), "training_example_id": train_id, "jaccard": round(score, 4)})
    return {
        "training_count": len(training_rows),
        "benchmark_count": len(benchmark_rows),
        "exact_question_context_overlap": len(exact),
        "exact_examples": exact[:100],
        "source_id_overlap": len(source_overlap),
        "overlapping_source_ids": source_overlap[:100],
        "near_duplicate_question_pairs": similar_questions[:100],
        "contaminated": bool(exact or source_overlap or similar_questions),
    }
