from __future__ import annotations

from argparse import Namespace

from research_model import cli
from research_model.evaluation.scorers import aggregate_scores
from research_model.evaluation.statistics import paired_bootstrap


def test_evaluation_artifact_keeps_raw_prediction_and_domain_rollup(monkeypatch, tmp_path):
    prediction = {
        "state": "evidence_review",
        "action": "EXTRACT",
        "query": None,
        "source_ids": ["source-1"],
        "claims": [],
        "evidence": [],
        "gaps": [],
        "confidence": "medium",
        "next_action": "SYNTHESIZE",
    }

    class Backend:
        name = "test-backend"
        tokenizer_revision = "test-revision"

        @staticmethod
        def generate_with_raw(*_args, **_kwargs):
            return prediction, 'preface\n{"action":"EXTRACT"}\n'

    monkeypatch.setattr(cli, "load_backend", lambda *_args, **_kwargs: Backend())
    args = Namespace(
        backend="transformers",
        model="test-model",
        model_revision="test-revision",
        load_in_4bit=False,
        adapter_path=None,
        checkpoint_path=str(tmp_path / "partial.json"),
        resume=False,
        output="unused.json",
        max_examples=None,
        max_new_tokens=16,
        temperature=0.0,
        checkpoint_every=1,
    )
    row = {
        "example_id": "case-1",
        "task_type": "citation_integrity",
        "domain": "biomedical",
        "question": "Which source supports this claim?",
        "context": "A supplied evidence passage.",
        "source_ids": ["source-1"],
        "expected_output": {
            "action": "EXTRACT",
            "source_ids": ["source-1"],
            "claims": [],
            "evidence": [],
        },
    }

    result = cli._run_backend(args, [row])

    assert result["per_example"][0]["raw_output"] == 'preface\n{"action":"EXTRACT"}\n'
    assert result["per_example"][0]["parsed_prediction"] == prediction
    assert result["scores"]["by_domain"]["biomedical/medical"]["count"] == 1
    assert result["scores"]["by_task"]["citation_integrity"]["count"] == 1
    assert result["runtime"]["examples_completed"] == 1
    assert result["runtime"]["gpu"]["available"] is False

    cross_domain = aggregate_scores(
        [
            {"task_type": "source_selection", "domain_group": "software/systems/automation/hardware", "score": 1},
            {"task_type": "source_selection", "domain_group": "software/systems/automation/hardware", "score": 0},
        ],
        include_by_task=False,
    )
    assert cross_domain["by_domain"]["software/systems/automation/hardware"]["count"] == 2


def test_paired_bootstrap_uses_only_examples_with_the_metric():
    base = [
        {"example_id": "a", "accuracy": 0, "rare_metric": 0},
        {"example_id": "b", "accuracy": 1},
        {"example_id": "c", "accuracy": 0},
    ]
    tuned = [
        {"example_id": "a", "accuracy": 1, "rare_metric": 1},
        {"example_id": "b", "accuracy": 1},
        {"example_id": "c", "accuracy": 1},
    ]

    result = paired_bootstrap(base, tuned, samples=100, seed=17)

    assert result["n"] == 3
    assert result["metrics"]["rare_metric"]["n"] == 1
    assert result["metrics"]["rare_metric"]["mean_delta"] == 1.0
    assert result["metrics"]["rare_metric"]["base_mean"] == 0.0
    assert result["metrics"]["rare_metric"]["relative_delta"] is None

    control_result = paired_bootstrap(
        [{"control_id": "control-1", "nonempty": 1}],
        [{"control_id": "control-1", "nonempty": 1}],
        samples=100,
        id_key="control_id",
    )
    assert control_result["id_key"] == "control_id"
    assert control_result["metrics"]["nonempty"]["n"] == 1
