"""Annotation-grounded research behaviors from QASPER full-text QA."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from ..normalization.text import normalize_text
from ..schemas import stable_id


def _paragraphs(record: dict[str, Any]) -> list[dict[str, str]]:
    output: list[dict[str, str]] = []
    for section_index, section in enumerate(record.get("full_text", [])):
        section_name = normalize_text(str(section.get("section_name", ""))) or f"section-{section_index}"
        for paragraph_index, paragraph in enumerate(section.get("paragraphs", [])):
            text = normalize_text(str(paragraph))
            if text:
                output.append({"id": f"p{section_index}_{paragraph_index}", "section": section_name, "text": text})
    return output


def _first_answer(question: dict[str, Any]) -> dict[str, Any] | None:
    answers = question.get("answers") or []
    if not answers or not isinstance(answers[0], dict):
        return None
    answer = answers[0].get("answer")
    return answer if isinstance(answer, dict) else None


def _answer_text(answer: dict[str, Any]) -> str:
    spans = [normalize_text(str(item)) for item in answer.get("extractive_spans", []) if normalize_text(str(item))]
    if spans:
        return " ".join(dict.fromkeys(spans))
    yes_no = answer.get("yes_no")
    if isinstance(yes_no, bool):
        return "yes" if yes_no else "no"
    free_form = normalize_text(str(answer.get("free_form_answer", "")))
    return free_form


def _evidence_texts(answer: dict[str, Any]) -> list[str]:
    highlighted = [normalize_text(str(item)) for item in answer.get("highlighted_evidence", []) if normalize_text(str(item))]
    if highlighted:
        return list(dict.fromkeys(highlighted))
    evidence = [normalize_text(str(item)) for item in answer.get("evidence", []) if normalize_text(str(item))]
    return list(dict.fromkeys(evidence))


def _find_evidence(paragraphs: list[dict[str, str]], texts: Iterable[str]) -> list[dict[str, str]]:
    normalized = {normalize_text(text) for text in texts}
    found = [paragraph for paragraph in paragraphs if paragraph["text"] in normalized]
    found_texts = {paragraph["text"] for paragraph in found}
    for text in normalized - found_texts:
        if text:
            found.append({"id": f"evidence_{len(found)}", "section": "annotated evidence", "text": text})
    return found


def _context(record: dict[str, Any], paragraphs: list[dict[str, str]], evidence: list[dict[str, str]], max_paragraphs: int = 8) -> str:
    title = normalize_text(str(record.get("title", "Untitled paper")))
    abstract = normalize_text(str(record.get("abstract", "")))
    evidence_ids = {item["id"] for item in evidence}
    selected = [item for item in paragraphs if item["id"] in evidence_ids]
    for paragraph in paragraphs:
        if paragraph["id"] not in evidence_ids and len(selected) < max_paragraphs:
            selected.append(paragraph)
    lines = [title]
    if abstract:
        lines.append("ABSTRACT: " + abstract)
    lines.extend(f"[{item['id']}] ({item['section']}) {item['text']}" for item in selected)
    for item in evidence:
        if item["id"] not in {entry["id"] for entry in selected}:
            lines.append(f"[{item['id']}] ({item['section']}) {item['text']}")
    return "\n".join(lines)


def _domain(_: dict[str, Any]) -> str:
    return "ai_ml"


def _difficulty(record: dict[str, Any], answer: dict[str, Any], evidence: list[dict[str, str]]) -> str:
    paragraph_count = sum(len(section.get("paragraphs", [])) for section in record.get("full_text", []))
    if answer.get("unanswerable"):
        return "hard" if paragraph_count > 20 else "medium"
    if len(evidence) >= 2 or paragraph_count > 40:
        return "hard"
    if paragraph_count > 15:
        return "medium"
    return "easy"


def _base(
    record: dict[str, Any], question: dict[str, Any], task_type: str, context: str,
    source_id: str, evidence: list[dict[str, Any]], claims: list[dict[str, Any]],
    expected: dict[str, Any], difficulty: str,
) -> dict[str, Any]:
    paper_id = str(record["paper_id"])
    title = normalize_text(str(record.get("title", "Untitled paper")))
    return {
        "example_id": stable_id("qasper", paper_id, str(question.get("question_id", question.get("question", ""))), task_type),
        "task_type": task_type,
        "domain": _domain(record),
        "difficulty": difficulty,
        "question": normalize_text(str(question.get("question", ""))),
        "context": context,
        "source_ids": [source_id],
        "source_metadata": [{"source_id": source_id, "source_type": "research_paper_full_text", "title": title, "paper_id": paper_id, "section_count": len(record.get("full_text", []))}],
        "search_state": {"initial_question": normalize_text(str(question.get("question", ""))), "results_seen": 1, "retrieval_provider": "qasper_public_archive"},
        "research_actions": [{"action": "READ", "source_ids": [source_id]}, {"action": "EXTRACT", "source_ids": [source_id]}],
        "evidence": evidence,
        "claims": claims,
        "contradictions": [],
        "gaps": expected.get("gaps", []),
        "uncertainty": "high" if expected.get("action") == "QUESTION" else "medium",
        "expected_output": expected,
        "provenance": {"source_id": "qasper", "source_record_ids": [source_id], "paper_id": paper_id, "question_id": question.get("question_id"), "annotation_id": (question.get("answers") or [{}])[0].get("annotation_id"), "generation_method": "annotation_grounded_deterministic", "answer_annotation_index": 0},
        "license": "CC BY 4.0 dataset; underlying paper rights require separate review; see data/manifests/public_sources.json",
        "license_class": "attribution_required",
        "split": "unassigned",
        "generation_method": "grounded_qasper_v0.1",
    }


def generate_qasper_examples(
    dataset: dict[str, list[dict[str, Any]]],
    max_questions: int | None = None,
    task_types: list[str] | None = None,
    seed: int = 17,
) -> list[dict[str, Any]]:
    """Generate several distinct, evidence-grounded behaviors per QA.

    The default five views share an annotated evidence item but differ in the
    observable protocol target.  Exact duplicate detection remains enabled at
    the dataset level; provenance keeps the underlying paper/question link.
    """

    del seed
    requested = task_types or ["evidence_extraction", "claim_extraction", "citation_integrity", "insufficient_evidence", "evidence_table"]
    records = [*dataset.get("train", []), *dataset.get("dev", [])]
    records.sort(key=lambda row: str(row.get("paper_id", "")))
    output: list[dict[str, Any]] = []
    question_count = 0
    for record in records:
        paragraphs = _paragraphs(record)
        if not paragraphs:
            continue
        for question in record.get("qas", []):
            answer = _first_answer(question)
            if answer is None:
                continue
            evidence = _find_evidence(paragraphs, _evidence_texts(answer))
            context = _context(record, paragraphs, evidence)
            source_id = f"qasper:{record['paper_id']}"
            answer_text = _answer_text(answer)
            unanswerable = bool(answer.get("unanswerable")) or not answer_text
            status = "INSUFFICIENT_EVIDENCE" if unanswerable else "SUPPORTED"
            claim = {"text": answer_text or "The supplied paper does not contain enough information to answer the question.", "status": status, "source_ids": [source_id] if evidence else []}
            evidence_rows = [{"source_id": source_id, "sentence_id": item["id"], "text": item["text"]} for item in evidence]
            difficulty = _difficulty(record, answer, evidence)
            gaps = ["The supplied paper does not provide enough information to answer this question."] if unanswerable else []
            for task_type in requested:
                if task_type == "evidence_extraction":
                    expected = {"state": "evidence_review", "action": "EXTRACT" if evidence else "QUESTION", "query": None, "source_ids": [source_id], "claims": [claim], "evidence": evidence_rows, "gaps": gaps, "confidence": "high" if evidence and not unanswerable else "unknown", "next_action": "SYNTHESIZE" if evidence and not unanswerable else "SEARCH"}
                elif task_type == "claim_extraction":
                    expected = {"state": "evidence_review", "action": "EXTRACT" if evidence else "QUESTION", "query": None, "source_ids": [source_id], "claims": [claim], "evidence": evidence_rows, "gaps": gaps, "confidence": "high" if evidence and not unanswerable else "unknown", "next_action": "STOP" if evidence and not unanswerable else "SEARCH"}
                elif task_type == "citation_integrity":
                    expected = {"state": "evidence_review", "action": "EXTRACT" if evidence else "QUESTION", "query": None, "source_ids": [source_id], "claims": [claim], "evidence": evidence_rows, "gaps": gaps or ["Do not generalize beyond the supplied paper and cited evidence."], "confidence": "high" if evidence and not unanswerable else "unknown", "next_action": "SYNTHESIZE" if evidence and not unanswerable else "SEARCH"}
                elif task_type == "insufficient_evidence":
                    expected = {"state": "evidence_review", "action": "QUESTION" if unanswerable else "SYNTHESIZE", "query": None, "source_ids": [source_id], "claims": [claim], "evidence": evidence_rows, "gaps": gaps, "confidence": "high" if unanswerable else "medium", "next_action": "SEARCH" if unanswerable else "STOP"}
                elif task_type == "evidence_table":
                    expected = {"state": "synthesis", "action": "QUESTION" if unanswerable else "SYNTHESIZE", "query": None, "source_ids": [source_id], "claims": [claim], "evidence": evidence_rows, "gaps": gaps, "confidence": "unknown" if unanswerable else "medium", "next_action": "SEARCH" if unanswerable else "STOP"}
                else:
                    continue
                output.append(_base(record, question, task_type, context, source_id, evidence_rows, [claim], expected, difficulty))
            question_count += 1
            if max_questions is not None and question_count >= max_questions:
                return output
    return output
