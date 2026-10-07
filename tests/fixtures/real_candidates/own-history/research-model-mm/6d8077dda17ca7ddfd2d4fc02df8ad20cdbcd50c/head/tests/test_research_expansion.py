import json

from research_model.benchmark import build_research_benchmark
from research_model.datasets.splits import assign_source_group_splits
from research_model.task_generation.qasper import generate_qasper_examples
from research_model.validation.validators import validate_contamination, validate_dataset


def test_qasper_generation_is_annotation_grounded():
    dataset = {"train": [{"paper_id": "1234.5678", "title": "A paper", "abstract": "An abstract.", "full_text": [{"section_name": "Results", "paragraphs": ["The measured result was positive.", "A distractor paragraph."]}], "qas": [{"question": "What was measured?", "question_id": "q1", "answers": [{"answer": {"unanswerable": False, "extractive_spans": ["The measured result was positive."], "yes_no": None, "free_form_answer": "", "evidence": ["The measured result was positive."], "highlighted_evidence": ["The measured result was positive."]}}]}]}], "dev": []}
    rows = generate_qasper_examples(dataset)
    assert len(rows) == 5
    assert all(row["license_class"] == "attribution_required" for row in rows)
    assert all(row["evidence"][0]["text"] in row["context"] for row in rows)
    assert validate_dataset(assign_source_group_splits(rows), strict=True)["rejected_count"] == 0


def test_frozen_benchmark_is_diverse_and_disjoint():
    benchmark = build_research_benchmark()
    report = validate_dataset(benchmark, strict=True)
    assert len(benchmark) >= 200
    assert report["rejected_count"] == 0
    assert len(report["composition"]["by_task_family"]) >= 25
    assert not validate_contamination([{"example_id": "train-1", "question": "unrelated training question", "context": "unrelated training context", "source_ids": ["qasper:paper"]}], benchmark)["contaminated"]


def test_contamination_catches_source_overlap():
    training = [{"example_id": "train-1", "question": "same question", "context": "same context", "source_ids": ["S1"]}]
    benchmark = [{"example_id": "bench-1", "question": "other question", "context": "other context", "source_ids": ["S1"]}]
    report = validate_contamination(training, benchmark)
    assert report["contaminated"]
    assert report["source_id_overlap"] == 1
