"""Grounded task families generated from source annotations, without invented facts."""

from __future__ import annotations

from typing import Any

from ..normalization.text import normalize_text, sentences
from ..schemas import stable_id


def infer_domain(title: str, abstract: str) -> str:
    """Conservative keyword routing used only for composition reporting.

    This is not a scientific field classifier.  Ambiguous records remain in
    the general bucket rather than being assigned a confident domain label.
    """

    text = f"{title} {abstract}".lower()
    if any(token in text for token in ("patient", "cancer", "tumor", "disease", "clinical", "gene", "protein", "infection", "hospital", "therapy", "mortality")):
        return "biomedical"
    if any(token in text for token in ("neural", "machine learning", "language model", "natural language", "semantic parser", "classification", "dataset", "embedding", "algorithm", "deep learning", "computer vision")):
        return "ai_ml"
    if any(token in text for token in ("software", "system", "network", "hardware", "server", "programming", "database", "compiler")):
        return "software_systems"
    if any(token in text for token in ("student", "classroom", "education", "learning", "school", "teaching")):
        return "education"
    if any(token in text for token in ("survey", "behavior", "psycholog", "cognitive", "self-report")):
        return "behavioral_science"
    return "general_scientific_research"


def _abstract(doc: dict[str, Any]) -> list[str]:
    raw = doc.get("abstract", [])
    if isinstance(raw, str):
        return sentences(raw)
    return [normalize_text(str(item)) for item in raw if normalize_text(str(item))]


def _protocol(state: str, action: str, source_ids: list[str], evidence: list[dict[str, str]], claims: list[dict[str, Any]], gaps: list[str], confidence: str, next_action: str | None, query: str | None = None) -> dict[str, Any]:
    return {"state": state, "action": action, "query": query, "source_ids": source_ids, "claims": claims, "evidence": evidence, "gaps": gaps, "confidence": confidence, "next_action": next_action}


def _base(example_id: str, task_type: str, claim: str, context: str, source_id: str, expected: dict[str, Any], label: str, evidence: list[dict[str, Any]], claims: list[dict[str, Any]], difficulty: str = "medium", domain: str = "general_scientific_research") -> dict[str, Any]:
    return {
        "example_id": example_id, "task_type": task_type, "domain": domain, "difficulty": difficulty,
        "question": claim, "context": context, "source_ids": [source_id],
        "source_metadata": [{"source_id": source_id, "source_type": "scientific_abstract", "title": context.split("\n", 1)[0]}],
        "search_state": {"initial_question": claim, "results_seen": 1, "retrieval_provider": "neutral_fixture"},
        "research_actions": [{"action": "READ", "source_ids": [source_id]}, {"action": "EXTRACT", "source_ids": [source_id]}],
        "evidence": evidence, "claims": claims, "contradictions": [],
        "gaps": [] if label != "NEI" else ["The supplied source does not provide evidence for the claim."],
        "uncertainty": "low" if label in {"SUPPORT", "CONTRADICT"} else "high", "expected_output": expected,
        "provenance": {"source_id": "scifact", "source_record_ids": [source_id], "generation_method": "annotation_grounded_deterministic", "annotation_label": label},
        "license": "CC BY-NC 2.0; see data/manifests/public_sources.json", "split": "unassigned", "generation_method": "grounded_scifact_v0.1",
        "license_class": "noncommercial",
    }


def generate_scifact_examples(dataset: dict[str, list[dict[str, Any]]], max_claims: int = 120, task_types: list[str] | None = None, seed: int = 17, split_names: tuple[str, ...] = ("train",)) -> list[dict[str, Any]]:
    del seed
    requested = set(task_types or ["evidence_verification", "citation_integrity", "insufficient_evidence", "research_plan"])
    corpus = {str(row["doc_id"]): row for row in dataset["corpus"]}
    output: list[dict[str, Any]] = []
    source_rows: list[dict[str, Any]] = []
    for split_name in split_names:
        source_rows.extend(dataset.get(split_name, []))
    for row in source_rows[:max_claims]:
        claim = normalize_text(row["claim"])
        evidence_map = row.get("evidence") or {}
        evidence_doc_key = next(iter(evidence_map), None) if isinstance(evidence_map, dict) and evidence_map else None
        doc_id = str(evidence_doc_key or row.get("evidence_doc_id") or (row.get("cited_doc_ids") or [""])[0])
        doc = corpus.get(doc_id, {})
        doc_sentences = _abstract(doc)
        annotation = (evidence_map.get(evidence_doc_key) or [{}])[0] if isinstance(evidence_map, dict) and evidence_doc_key else {}
        label = str(annotation.get("label", row.get("evidence_label", "NEI"))).upper()
        source_id = f"scifact:{doc_id}"
        title = normalize_text(str(doc.get("title", "Untitled source")))
        domain = infer_domain(title, " ".join(doc_sentences))
        context = title + "\n" + "\n".join(f"[{i}] {sent}" for i, sent in enumerate(doc_sentences))
        evidence_ids = [int(i) for i in annotation.get("sentences", row.get("evidence_sentences", [])) if isinstance(i, int) and 0 <= i < len(doc_sentences)]
        evidence = [{"source_id": source_id, "sentence_id": str(i), "text": doc_sentences[i]} for i in evidence_ids]
        status = {"SUPPORT": "SUPPORTED", "CONTRADICT": "CONTRADICTED", "NEI": "INSUFFICIENT_EVIDENCE"}.get(label, "INSUFFICIENT_EVIDENCE")
        factual_claim = {"text": claim, "status": status, "source_ids": [source_id] if status != "INSUFFICIENT_EVIDENCE" else []}
        if "evidence_verification" in requested:
            expected = _protocol("evidence_review", "EXTRACT" if evidence else "QUESTION", [source_id] if evidence else [source_id], evidence, [factual_claim], [] if evidence else ["No supporting sentence is supplied."], "high" if evidence else "unknown", "SYNTHESIZE" if evidence else "SEARCH")
            output.append(_base(stable_id("verification", str(row.get("id")), claim), "evidence_verification", claim, context, source_id, expected, label, evidence, [factual_claim], domain=domain))
        if "citation_integrity" in requested:
            citation_claim = {"text": claim, "status": status, "source_ids": [source_id] if evidence else []}
            expected = _protocol("evidence_review", "EXTRACT" if evidence else "QUESTION", [source_id], evidence, [citation_claim], [] if evidence else ["The cited abstract does not support the claim."], "high" if evidence else "unknown", "STOP" if evidence else "SEARCH")
            output.append(_base(stable_id("citation", str(row.get("id")), claim), "citation_integrity", claim, context, source_id, expected, label, evidence, [citation_claim], domain=domain))
        if "insufficient_evidence" in requested:
            expected = _protocol("evidence_review", "SYNTHESIZE" if evidence else "QUESTION", [source_id] if evidence else [], evidence, [factual_claim], [] if evidence else ["Evidence is missing or does not entail the claim."], "medium" if evidence else "high", "STOP" if evidence else "SEARCH")
            output.append(_base(stable_id("insufficient", str(row.get("id")), claim), "insufficient_evidence", claim, context, source_id, expected, label, evidence, [factual_claim], domain=domain))
        if "research_plan" in requested:
            query = " ".join(claim.split()[:12])
            expected = _protocol("planning", "SEARCH", [], [], [], ["Verify the claim in an independent primary source and check study design and population."], "unknown", "READ", query=query)
            plan = _base(stable_id("plan", str(row.get("id")), claim), "research_plan", claim, context, source_id, expected, "NEI", [], [], domain=domain)
            plan["research_actions"] = [{"action": "QUESTION", "source_ids": []}, {"action": "SEARCH", "query": query, "source_ids": []}]
            plan["gaps"] = ["Independent primary evidence has not yet been assessed."]
            plan["uncertainty"] = "unknown"
            output.append(plan)
        if "evidence_extraction" in requested:
            expected = _protocol("evidence_review", "EXTRACT" if evidence else "QUESTION", [source_id], evidence, [], [] if evidence else ["The annotation supplies no sentence-level evidence."], "high" if evidence else "unknown", "SYNTHESIZE" if evidence else "SEARCH")
            output.append(_base(stable_id("extract", str(row.get("id")), claim), "evidence_extraction", claim, context, source_id, expected, label, evidence, [], domain=domain))
        if "claim_extraction" in requested:
            expected = _protocol("evidence_review", "EXTRACT" if evidence else "QUESTION", [source_id], evidence, [factual_claim], [] if evidence else ["The claim cannot be supported from the supplied sentence annotations."], "high" if evidence else "unknown", "SYNTHESIZE" if evidence else "SEARCH")
            output.append(_base(stable_id("claim", str(row.get("id")), claim), "claim_extraction", claim, context, source_id, expected, label, evidence, [factual_claim], domain=domain))
        if "claim_source_attribution" in requested:
            attributed = dict(factual_claim)
            attributed["source_ids"] = [source_id] if evidence else []
            expected = _protocol("evidence_review", "EXTRACT" if evidence else "QUESTION", [source_id], evidence, [attributed], [] if evidence else ["No sentence-level attribution is available."], "high" if evidence else "unknown", "SYNTHESIZE" if evidence else "SEARCH")
            output.append(_base(stable_id("attribution", str(row.get("id")), claim), "claim_source_attribution", claim, context, source_id, expected, label, evidence, [attributed], domain=domain))
        if "contradiction_detection" in requested:
            contradiction = {"text": "The supplied evidence contradicts the claim." if label == "CONTRADICT" else "No contradiction is present in the annotated evidence.", "status": "CONFLICT" if label == "CONTRADICT" else "SUPPORTED", "source_ids": [source_id] if evidence else []}
            expected = _protocol("evidence_review", "COMPARE" if evidence else "QUESTION", [source_id] if evidence else [], evidence, [contradiction], [] if evidence else ["A contradiction decision requires annotated evidence."], "high" if evidence else "unknown", "SYNTHESIZE" if evidence else "SEARCH")
            output.append(_base(stable_id("contradiction", str(row.get("id")), claim), "contradiction_detection", claim, context, source_id, expected, label, evidence, [contradiction], domain=domain))
        if "missing_evidence" in requested:
            expected = _protocol("evidence_review", "QUESTION" if not evidence else "EXTRACT", [source_id] if evidence else [], evidence, [factual_claim], [] if evidence else ["The supplied context lacks an evidence span for this claim."], "high" if not evidence else "medium", "SEARCH" if not evidence else "SYNTHESIZE")
            output.append(_base(stable_id("missing", str(row.get("id")), claim), "missing_evidence", claim, context, source_id, expected, label, evidence, [factual_claim], domain=domain))
        if "evidence_table" in requested:
            expected = _protocol("synthesis", "SYNTHESIZE" if evidence else "QUESTION", [source_id] if evidence else [], evidence, [factual_claim], [] if evidence else ["An evidence table needs a source-grounded entry."], "high" if evidence else "unknown", "STOP" if evidence else "SEARCH")
            output.append(_base(stable_id("table", str(row.get("id")), claim), "evidence_table", claim, context, source_id, expected, label, evidence, [factual_claim], domain=domain))
        if "search_query_generation" in requested:
            query = " ".join(claim.split()[:12])
            expected = _protocol("planning", "SEARCH", [], [], [], ["Verify the claim in an independent primary source."], "unknown", "READ", query=query)
            output.append(_base(stable_id("query", str(row.get("id")), claim), "search_query_generation", claim, context, source_id, expected, "NEI", [], [], domain=domain))
        if "query_refinement" in requested:
            query = " ".join(claim.split()[:10]) + " study design population evidence"
            expected = _protocol("planning", "SEARCH", [], [], [], ["The initial query should be refined with design and population terms."], "unknown", "READ", query=query)
            output.append(_base(stable_id("refine", str(row.get("id")), claim), "query_refinement", claim, context, source_id, expected, "NEI", [], [], domain=domain))
        if "follow_up_question" in requested:
            expected = _protocol("planning", "QUESTION", [source_id], evidence, [], ["Check whether the finding replicates in an independent population and design."], "medium", "SEARCH")
            output.append(_base(stable_id("followup", str(row.get("id")), claim), "follow_up_question", claim, context, source_id, expected, "NEI", evidence, [], domain=domain))
    return output
