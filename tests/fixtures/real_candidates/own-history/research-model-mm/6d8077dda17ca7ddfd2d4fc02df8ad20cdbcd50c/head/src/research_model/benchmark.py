"""Deterministic, independent controlled benchmark construction.

The benchmark uses hand-specified evidence fixtures rather than teacher
outputs.  It is intentionally separate from public training-source IDs so the
contamination checker can enforce that boundary.
"""

from __future__ import annotations

from typing import Any

from .schemas import stable_id


def _expected(state: str, action: str, sources: list[str], claims: list[dict[str, Any]], evidence: list[dict[str, Any]], gaps: list[str], confidence: str, next_action: str, query: str | None = None) -> dict[str, Any]:
    return {"state": state, "action": action, "query": query, "source_ids": sources, "claims": claims, "evidence": evidence, "gaps": gaps, "confidence": confidence, "next_action": next_action}


def _row(index: int, family: str, domain: str, difficulty: str, question: str, context: str, source_ids: list[str], expected: dict[str, Any]) -> dict[str, Any]:
    return {
        "example_id": f"bench-{index:04d}-{stable_id(family, question)[:8]}",
        "task_type": family,
        "domain": domain,
        "difficulty": difficulty,
        "question": question,
        "context": context,
        "source_ids": source_ids,
        "source_metadata": [{"source_id": source, "source_type": "controlled_fixture", "title": f"Controlled fixture {source}"} for source in source_ids],
        "search_state": {},
        "research_actions": [],
        "evidence": [],
        "claims": [],
        "contradictions": [],
        "gaps": expected.get("gaps", []),
        "uncertainty": "high" if expected.get("action") == "QUESTION" else "medium",
        "expected_output": expected,
        "provenance": {"source_id": "controlled_benchmark_v0.1", "source_record_ids": source_ids, "generation_method": "hand_authored_fixture"},
        "license": "Apache-2.0-controlled-fixture",
        "license_class": "controlled_fixture",
        "split": "test",
        "generation_method": "hand_authored_controlled_case_v0.1",
    }


def _topic_variants() -> list[dict[str, str]]:
    return [
        {"domain": "ai_ml", "subject": "a retrieval-augmented generation system", "outcome": "factual answer accuracy", "population": "public question-answering tasks"},
        {"domain": "software_systems", "subject": "a new inference server", "outcome": "p99 latency", "population": "concurrent production-like requests"},
        {"domain": "biomedical", "subject": "a digital intervention", "outcome": "six-month recovery", "population": "adults with the target condition"},
        {"domain": "behavioral_science", "subject": "a sleep education program", "outcome": "self-reported concentration", "population": "community volunteers"},
        {"domain": "education", "subject": "a classroom tutoring program", "outcome": "standardized test performance", "population": "first-year university students"},
        {"domain": "general_scientific_research", "subject": "a low-cost environmental sensor", "outcome": "measurement error", "population": "field deployments"},
        {"domain": "hardware", "subject": "an accelerator design", "outcome": "end-to-end throughput", "population": "a public serving trace"},
        {"domain": "ai_ml", "subject": "a model quantization method", "outcome": "accuracy retention", "population": "three public benchmarks"},
    ]


def _fixture(family: str, topic: dict[str, str], variant: int) -> tuple[str, str, list[str], dict[str, Any], str]:
    subject, outcome, population, domain = topic["subject"], topic["outcome"], topic["population"], topic["domain"]
    s1, s2 = f"C{variant:02d}A", f"C{variant:02d}B"
    if family == "source_ranking":
        question = f"Which source is stronger evidence about {subject} and {outcome}?"
        context = f"{s1}: The vendor reports peak performance on a private workload with no code or uncertainty interval.\n{s2}: An independent study evaluates {subject} on {population}, reports multiple seeds, and releases its evaluation code."
        claim = {"text": f"{s2} is stronger evidence because its evaluation is independent, reproducible, and closer to the target population.", "status": "SUPPORTED", "source_ids": [s2]}
        return question, context, [s1, s2], _expected("source_review", "COMPARE", [s2], [claim], [], [f"{s1} may still support a narrow claim about its private workload."], "high", "SYNTHESIZE"), "hard"
    if family == "source_relevance":
        question = f"Which source is directly relevant to {outcome} in {population}?"
        context = f"{s1}: A review discusses a related outcome in laboratory animals.\n{s2}: A controlled study measures {outcome} in {population} using the stated {subject} protocol."
        claim = {"text": f"{s2} is directly relevant to the stated population and outcome; {s1} is indirect.", "status": "SUPPORTED", "source_ids": [s2]}
        return question, context, [s1, s2], _expected("source_review", "COMPARE", [s2], [claim], [], ["Check whether the study design matches the intended decision."], "high", "READ"), "medium"
    if family == "source_rejection":
        question = f"Should the headline claim about {subject} be accepted as established?"
        context = f"{s1}: A press release says {subject} is state of the art but gives no baseline details or reproducible evaluation.\n{s2}: The official evaluation protocol and current comparison baselines are publicly available."
        claim = {"text": f"The headline from {s1} should not be accepted without evaluation under the official protocol in {s2}.", "status": "SUPPORTED", "source_ids": [s1, s2]}
        return question, context, [s1, s2], _expected("source_review", "READ", [s2], [claim], [], ["Independent reproduction is still needed."], "high", "SEARCH"), "easy"
    if family == "primary_secondary_classification":
        question = f"Which source is the primary study of {subject}?"
        context = f"{s1}: The authors randomized {population} to receive or not receive {subject} and report the collected measurements.\n{s2}: A later review summarizes several studies, including {s1}."
        claim = {"text": f"{s1} is the primary study; {s2} is secondary synthesis.", "status": "SUPPORTED", "source_ids": [s1, s2]}
        return question, context, [s1, s2], _expected("source_review", "COMPARE", [s1, s2], [claim], [], [], "high", "READ"), "easy"
    if family == "evidence_extraction":
        question = f"What result does the study report for {subject}?"
        context = f"{s1}: In a preregistered study of {population}, the measured {outcome} difference was 0.20 standard deviations, with a confidence interval excluding zero."
        evidence = [{"source_id": s1, "sentence_id": "p0", "text": f"In a preregistered study of {population}, the measured {outcome} difference was 0.20 standard deviations, with a confidence interval excluding zero."}]
        claim = {"text": f"The study reports a 0.20 standard-deviation difference in {outcome} with a confidence interval excluding zero.", "status": "SUPPORTED", "source_ids": [s1]}
        return question, context, [s1], _expected("evidence_review", "EXTRACT", [s1], [claim], evidence, [], "high", "SYNTHESIZE"), "easy"
    if family == "claim_extraction":
        question = f"Extract the narrow empirical claim supported by the source about {outcome}."
        context = f"{s1}: The study observed lower {outcome} under the tested {subject} condition than under its prespecified comparator; it did not test long-term effects."
        evidence = [{"source_id": s1, "sentence_id": "p0", "text": f"The study observed lower {outcome} under the tested {subject} condition than under its prespecified comparator; it did not test long-term effects."}]
        claim = {"text": f"The study observed lower {outcome} under the tested condition than under its comparator, without establishing long-term effects.", "status": "SUPPORTED", "source_ids": [s1]}
        return question, context, [s1], _expected("evidence_review", "EXTRACT", [s1], [claim], evidence, ["Long-term effects were not measured."], "high", "SYNTHESIZE"), "medium"
    if family in {"citation_integrity", "correlation_causation", "overclaiming"}:
        question = f"Does the source support the causal claim that {subject} causes improved {outcome}?"
        context = f"{s1}: An observational cohort found that participants exposed to {subject} had better {outcome}. The study did not randomize exposure and notes baseline differences."
        evidence = [{"source_id": s1, "sentence_id": "p0", "text": f"An observational cohort found that participants exposed to {subject} had better {outcome}. The study did not randomize exposure and notes baseline differences."}]
        claim = {"text": f"The source supports an association between {subject} and {outcome}, not a causal conclusion.", "status": "SUPPORTED", "source_ids": [s1]}
        return question, context, [s1], _expected("evidence_review", "EXTRACT", [s1], [claim], evidence, ["A randomized or otherwise justified causal design is missing."], "high", "QUESTION"), "medium"
    if family in {"contradiction_detection", "conflicting_study_comparison"}:
        question = f"How should the evidence about {subject} and {outcome} be represented?"
        context = f"{s1}: A randomized trial in {population} estimated a 0.20 SD improvement.\n{s2}: A larger preregistered replication in a different sample estimated an effect near zero with an interval including zero."
        claim = {"text": "The studies report conflicting estimates; the larger replication is contrary evidence and consensus should not be claimed without examining differences.", "status": "CONFLICT", "source_ids": [s1, s2]}
        return question, context, [s1, s2], _expected("evidence_review", "COMPARE", [s1, s2], [claim], [], ["Investigate implementation fidelity, population differences, and prespecified outcomes."], "high", "SYNTHESIZE"), "hard"
    if family == "methodology_criticism":
        question = f"What is the key methodological limitation of this result about {subject}?"
        context = f"{s1}: A case report describes one person's improvement after {subject}. It has no control condition, blinded assessment, or comparative follow-up."
        claim = {"text": "The case report cannot establish efficacy because it has one participant and lacks a controlled comparative design.", "status": "SUPPORTED", "source_ids": [s1]}
        return question, context, [s1], _expected("evidence_review", "EXTRACT", [s1], [claim], [], ["Controlled comparative evidence is missing."], "high", "SEARCH"), "hard"
    if family == "study_design_recognition":
        question = f"What study design is described, and what does it identify about {outcome}?"
        context = f"{s1}: Researchers assigned {population} to two conditions using a random sequence, blinded outcome assessors, and measured {outcome} after eight weeks."
        claim = {"text": "This is a randomized controlled study with blinded outcome assessment; it estimates the between-condition outcome difference over eight weeks.", "status": "SUPPORTED", "source_ids": [s1]}
        return question, context, [s1], _expected("evidence_review", "EXTRACT", [s1], [claim], [], [], "high", "SYNTHESIZE"), "medium"
    if family == "evidence_strength":
        question = f"How strong is the evidence for a broad claim about {subject}?"
        context = f"{s1}: One small, single-site study reports an effect on {outcome}; the sample was not representative of {population}, and no replication is available."
        claim = {"text": "The evidence is preliminary and weak for a broad claim because it is small, single-site, non-replicated, and not clearly representative.", "status": "SUPPORTED", "source_ids": [s1]}
        return question, context, [s1], _expected("evidence_review", "SYNTHESIZE", [s1], [claim], [], ["Larger, independent, and better-targeted studies are needed."], "high", "SEARCH"), "hard"
    if family in {"missing_evidence", "insufficient_evidence", "population_applicability"}:
        question = f"Does the supplied evidence establish that {subject} improves {outcome} for {population}?"
        context = f"{s1}: A short study evaluated {subject} only in a different population and measured a proxy outcome rather than {outcome}."
        claim = {"text": f"The supplied study does not establish effectiveness for {population} on {outcome} because its population and outcome do not match.", "status": "INSUFFICIENT_EVIDENCE", "source_ids": [s1]}
        return question, context, [s1], _expected("evidence_review", "QUESTION", [s1], [claim], [], ["Evidence in the target population using the target outcome is missing."], "high", "SEARCH"), "hard"
    if family == "research_gap":
        question = f"What important research gap remains after this evidence about {subject}?"
        context = f"{s1}: Studies report short-term changes in {outcome}, but none measure durability beyond eight weeks or compare results across {population}."
        claim = {"text": "Durability and transportability across the target population remain untested.", "status": "SUPPORTED", "source_ids": [s1]}
        return question, context, [s1], _expected("planning", "QUESTION", [s1], [claim], [], ["Search for longer follow-up and population-diverse studies."], "high", "SEARCH"), "hard"
    if family == "follow_up_question":
        question = f"What should be investigated next after this finding about {subject}?"
        context = f"{s1}: The cross-sectional study found an association between exposure to {subject} and {outcome} using self-report at one time point."
        claim = {"text": "A useful next question is whether the association replicates with longitudinal or objective measures and whether confounders explain it.", "status": "SUPPORTED", "source_ids": [s1]}
        return question, context, [s1], _expected("planning", "QUESTION", [s1], [claim], [], ["Temporal ordering, objective measures, and confounder control are unresolved."], "high", "SEARCH"), "medium"
    if family == "next_best_action":
        question = f"What is the next best research action after finding this single weak study of {subject}?"
        context = f"{s1}: One small study reports an association with {outcome}; no independent replication or preregistered protocol is available."
        return question, context, [s1], _expected("planning", "SEARCH", [s1], [], [], ["Independent replication and preregistered measurement are needed."], "high", "READ"), "medium"
    if family == "stopping_criteria":
        question = f"Should searching stop for the question about {subject} and {outcome}?"
        context = f"{s1}: Two independent reviews, three randomized trials, and a recent guideline cover {population}. New searches across three databases return only duplicates or different endpoints."
        return question, context, [s1], _expected("synthesis", "STOP", [s1], [], [], ["Record the search strategy and remaining uncertainty before concluding."], "medium", "SYNTHESIZE"), "hard"
    if family in {"evidence_synthesis", "evidence_table"}:
        question = f"Synthesize the evidence about {subject} and {outcome} without overclaiming."
        context = f"{s1}: A randomized trial found a modest improvement.\n{s2}: An independent observational study found an association but had baseline imbalance."
        claims = [{"text": "The randomized trial provides stronger causal evidence of a modest effect; the observational study is consistent with association but cannot independently establish causation.", "status": "SUPPORTED", "source_ids": [s1, s2]}]
        return question, context, [s1, s2], _expected("synthesis", "SYNTHESIZE", [s1, s2], claims, [], ["Check whether the populations, outcomes, and follow-up periods are comparable."], "medium", "STOP"), "hard"
    if family == "temporal_applicability":
        question = f"Can the older result about {subject} be treated as current evidence for {outcome}?"
        context = f"{s1}: A study from 2012 used an obsolete implementation and an old comparator.\n{s2}: A 2025 replication uses current hardware and reports a different outcome estimate."
        claim = {"text": "The older result may not transfer unchanged because the implementation, comparator, and observed estimate differ; the newer replication needs priority for current claims.", "status": "SUPPORTED", "source_ids": [s1, s2]}
        return question, context, [s1, s2], _expected("evidence_review", "COMPARE", [s1, s2], [claim], [], ["Compare methods and target populations before treating the results as directly comparable."], "high", "SYNTHESIZE"), "hard"
    if family == "benchmark_claim_evaluation":
        question = f"How should the benchmark claim for {subject} be evaluated?"
        context = f"{s1}: The vendor reports best-ever {outcome} using a batch size and software stack not disclosed.\n{s2}: An independent reproduction publishes code, hardware, versions, seeds, and the complete evaluation trace."
        claim = {"text": f"The vendor claim is not independently established; {s2} supplies the reproducible evidence needed for comparison.", "status": "SUPPORTED", "source_ids": [s1, s2]}
        return question, context, [s1, s2], _expected("source_review", "COMPARE", [s1, s2], [claim], [], ["Re-run both systems under a matched public workload."], "high", "READ"), "hard"
    if family == "reproducibility_assessment":
        question = f"Is the study of {subject} reproducible from the supplied description?"
        context = f"{s1}: The paper gives a headline {outcome} number but omits data, code, random seeds, hardware, and version information."
        claim = {"text": "The study is not reproducible from the supplied description because essential data, code, and execution details are missing.", "status": "SUPPORTED", "source_ids": [s1]}
        return question, context, [s1], _expected("evidence_review", "QUESTION", [s1], [claim], [], ["Request the missing data, code, seeds, hardware, and version details."], "high", "SEARCH"), "hard"
    if family in {"question_decomposition", "search_query_generation", "query_refinement", "terminology_expansion", "research_plan"}:
        question = f"Plan research to determine whether {subject} improves {outcome} for {population}."
        context = ""
        query = f"{subject} {outcome} {population} randomized comparison replication"
        gaps = ["Define the outcome, target population, comparator, time horizon, and acceptable evidence design."]
        if family == "question_decomposition":
            gaps = ["What is the target population?", "What comparator and outcome are prespecified?", "What design and follow-up would identify the effect?"]
        elif family == "terminology_expansion":
            query = f"{subject} synonyms intervention exposure {outcome} endpoint {population}"
        elif family == "query_refinement":
            query = f"{subject} {outcome} randomized trial population replication measurement"
        return question, context, [], _expected("planning", "QUESTION" if family == "question_decomposition" else "SEARCH", [], [], [], gaps, "unknown", "READ", query=query), "medium"
    return "", "", [], {}, "medium"


def build_research_benchmark() -> list[dict[str, Any]]:
    families = [
        "source_ranking", "source_relevance", "source_rejection", "primary_secondary_classification",
        "evidence_extraction", "claim_extraction", "citation_integrity", "correlation_causation",
        "overclaiming", "contradiction_detection", "conflicting_study_comparison", "methodology_criticism",
        "study_design_recognition", "evidence_strength", "missing_evidence", "insufficient_evidence",
        "population_applicability", "research_gap", "follow_up_question", "next_best_action",
        "stopping_criteria", "evidence_synthesis", "evidence_table", "temporal_applicability",
        "benchmark_claim_evaluation", "reproducibility_assessment", "question_decomposition",
        "search_query_generation", "query_refinement", "terminology_expansion", "research_plan",
    ]
    rows: list[dict[str, Any]] = []
    index = 0
    for variant, topic in enumerate(_topic_variants(), start=1):
        for family in families:
            question, context, sources, expected, difficulty = _fixture(family, topic, variant)
            if not expected:
                continue
            rows.append(_row(index, family, topic["domain"], difficulty, question, context, sources, expected))
            index += 1
    return rows
