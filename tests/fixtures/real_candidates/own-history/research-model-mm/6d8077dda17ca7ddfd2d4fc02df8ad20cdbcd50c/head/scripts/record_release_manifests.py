"""Record immutable manifests for release artifacts created after the pilot."""

from __future__ import annotations

import json
from pathlib import Path

from research_model.datasets.jsonl import read_jsonl
from research_model.datasets.splits import dataset_hash
from research_model.provenance.experiments import append_experiment_manifest, collect_environment, utc_now
from research_model.provenance.manifest import hash_file

ROOT = Path(__file__).resolve().parents[1]


def make_manifest(experiment_id: str, title: str, experiment_type: str, dataset_path: str | None, benchmark_path: str | None, command: str, results: dict, interpretation: str, conclusion: str, missing_metadata: list[str]) -> dict:
    dataset_rows = read_jsonl(ROOT / dataset_path) if dataset_path else []
    benchmark_rows = read_jsonl(ROOT / benchmark_path) if benchmark_path else []
    dataset = {"path": dataset_path, "sha256": hash_file(ROOT / dataset_path) if dataset_path else None, "dataset_content_hash": dataset_hash(dataset_rows) if dataset_path else None}
    benchmark = {"path": benchmark_path, "sha256": hash_file(ROOT / benchmark_path) if benchmark_path else None, "benchmark_content_hash": dataset_hash(benchmark_rows) if benchmark_path else None}
    return {
        "experiment_schema_version": "1.0", "experiment_id": experiment_id, "title": title, "status": "completed", "metadata_status": "reconstructed_after_fact", "manifest_created_at": utc_now(), "research_question": None, "hypothesis": None, "experiment_type": experiment_type,
        "git": {"commit": None, "dirty": True, "status_note": "Artifact was created before the provenance milestone commit; exact commit was unavailable at generation time."},
        "environment": collect_environment(), "dataset": dataset, "benchmark": benchmark, "model": {"name": None, "revision": None, "tokenizer_revision": None}, "training": {}, "execution": {"command": [command], "start_time": None, "end_time": None, "duration_seconds": None, "seed": 17, "retries": [], "deviations": []}, "artifacts": {}, "results": results, "interpretation": interpretation, "limitations": ["This manifest was recorded after the command completed; exact start/end timestamps are unavailable.", "No public release is authorized by this manifest."], "conclusion": conclusion, "missing_metadata": missing_metadata, "reconstruction_sources": ["data/generated", "benchmarks/releases", "docs/research_questions.md"],
    }


def add_path(manifest: dict, key: str, path: str) -> None:
    manifest["artifacts"][key] = path
    full = ROOT / path
    if full.is_file():
        manifest["artifacts"][f"{key}_sha256"] = hash_file(full)


def record(manifest: dict, summary: str) -> None:
    directory = ROOT / "experiments" / manifest["experiment_id"]
    directory.mkdir(parents=True, exist_ok=True)
    summary_path = directory / "summary.md"
    summary_path.write_text(summary + "\n\nThis manifest records the artifact after the command completed; unavailable metadata remains null rather than inferred.\n", encoding="utf-8")
    manifest["artifacts"]["summary_path"] = str(summary_path)
    append_experiment_manifest(manifest, ROOT)


def main() -> int:
    alpha = "data/generated/research-data-v0.1-alpha.jsonl"
    expanded = "data/generated/research-data-v0.1-expanded.jsonl"
    benchmark = "benchmarks/releases/research-bench-v0.1.jsonl"
    control = "benchmarks/control/general-capability-v0.1.jsonl"
    items = []
    manifest = make_manifest("E006_dataset_alpha", "research-data-v0.1-alpha release candidate", "dataset_release", alpha, benchmark, "uv run research-model data build --sources scifact,qasper --max-claims 120 --max-questions 400 --strict", {"dataset_version": "research-data-v0.1-alpha", "accepted": 3547, "rejected": 13, "rejection_rate": 0.003651685393258427, "dataset_content_hash": "8249bdf28ff2d34e64adbffd39dfed5aee0d7e40fa237179268700f829dc026c", "validation_report": "data/generated/research-data-v0.1-alpha.validation.json"}, "The alpha release demonstrates a staged multi-source pipeline with non-zero strict rejection and explicit license classes.", "Alpha release candidate; not a public release.", ["git_commit", "exact_start_time", "exact_end_time", "source-document rights review"])
    add_path(manifest, "validation_report", "data/generated/research-data-v0.1-alpha.validation.json"); record(manifest, "# E006_dataset_alpha\n\nThe staged alpha contains 3,547 strict-validated rows from SciFact and QASPER, with 13 rejected rows."); items.append(manifest["experiment_id"])

    manifest = make_manifest("E007_dataset_expanded", "research-data-v0.1-expanded serious release candidate", "dataset_release", expanded, benchmark, "uv run research-model data build --sources scifact,qasper --max-claims 1409 --scifact-splits train,dev,test --max-questions 2000 --strict", {"dataset_version": "research-data-v0.1-expanded", "accepted": 25269, "rejected": 3048, "rejection_rate": 0.1076385210297701, "dataset_content_hash": "75283e511cb120bbb29fb95e13b7a26fa5f6b4f887ddf41079c50c4a96505cf1", "validation_report": "data/generated/research-data-v0.1-expanded.validation.json", "license_classes": {"attribution_required": 10000, "noncommercial": 15269}}, "The serious candidate is substantially larger and behaviorally broader than the SciFact pilot, while its rejection report exposes source-quality and duplicate failures.", "Serious local release candidate; not a public release.", ["git_commit", "exact_start_time", "exact_end_time", "source-document rights review", "domain-classifier audit by expert annotator"])
    add_path(manifest, "validation_report", "data/generated/research-data-v0.1-expanded.validation.json"); add_path(manifest, "contamination_report", "data/generated/contamination-research-bench-v0.1.json"); record(manifest, "# E007_dataset_expanded\n\nThe expanded candidate contains 25,269 strict-validated rows and rejects 3,048 rows (10.76%). It combines QASPER full-text annotations with SciFact evidence annotations."); items.append(manifest["experiment_id"])

    manifest = make_manifest("E008_benchmark_frozen", "research-bench-v0.1 controlled benchmark freeze", "benchmark_freeze", expanded, benchmark, "uv run research-model benchmark build --version research-bench-v0.1", {"benchmark_version": "research-bench-v0.1", "count": 248, "benchmark_content_hash": "d44b8226ed8d5122ffedcb353761a9624917fb0bd6f6be60e5595799a0a5eb3e", "metadata_path": "benchmarks/releases/research-bench-v0.1.metadata.json"}, "The benchmark is an independent, hand-authored controlled fixture set spanning 31 research-behavior families across 248 cases.", "Benchmark version frozen for the next primary comparison; defects require a new version.", ["git_commit", "exact_freeze_timestamp_before_model_evaluation", "expert inter-rater review"])
    add_path(manifest, "benchmark_metadata", "benchmarks/releases/research-bench-v0.1.metadata.json"); record(manifest, "# E008_benchmark_frozen\n\nThe controlled research benchmark is frozen at 248 cases. Public training-source IDs and controlled benchmark IDs are disjoint."); items.append(manifest["experiment_id"])

    manifest = make_manifest("E009_control_frozen", "general-capability control benchmark freeze", "control_freeze", expanded, control, "uv run research-model control build --version general-control-v0.1", {"control_version": "general-control-v0.1", "count": 12, "control_content_hash": "1be2dc5298066bb645ec49f48157de81c09a05579bab8679d87fa86723efbad5", "metadata_path": "benchmarks/control/general-capability-v0.1.metadata.json"}, "The control is a small frozen regression guard for ordinary instruction following, arithmetic/reasoning, summarization, and technical explanation.", "Control benchmark frozen for before/after retention checks; keyword scores are deliberately modest and not a universal capability measure.", ["git_commit", "exact_freeze_timestamp_before_model_evaluation", "expert scoring review"])
    add_path(manifest, "control_metadata", "benchmarks/control/general-capability-v0.1.metadata.json"); record(manifest, "# E009_control_frozen\n\nThe general-capability control contains 12 frozen prompts across instruction following, basic reasoning, summarization, and technical explanation."); items.append(manifest["experiment_id"])
    print(json.dumps({"created": items}, indent=2)); return 0


if __name__ == "__main__":
    raise SystemExit(main())
