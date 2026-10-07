"""Reconstruct the pre-ledger pilot history without inventing unavailable metadata."""

from __future__ import annotations

import json
from pathlib import Path

from research_model.provenance.experiments import append_experiment_manifest, collect_environment, utc_now
from research_model.provenance.manifest import hash_file

ROOT = Path(__file__).resolve().parents[1]


def file_ref(path: str, dataset_hash: str | None = None) -> dict:
    full = ROOT / path
    value = {"path": path, "sha256": hash_file(full) if full.is_file() else None}
    if dataset_hash:
        value["dataset_content_hash"] = dataset_hash
    return value


def mlx_environment(mlx_version: str, mlx_lm_version: str) -> dict:
    return {
        "machine": {"hostname": None, "os": None, "architecture": "arm64", "cpu": "Apple M1 Max", "gpu": "Apple M1 Max integrated GPU", "gpu_count": 1, "vram_gb": 32, "ram_gb": 32, "hardware_probe_note": "Recorded in the initial build report; unified memory is shared."},
        "software": {"python": None, "platform": "macOS (exact release not recorded)", "packages": {"mlx": mlx_version, "mlx-lm": mlx_lm_version}, "cuda": None},
    }


def base_manifest(experiment_id: str, title: str, status: str, experiment_type: str, question: str | None, dataset_path: str | None, dataset_content_hash: str | None, benchmark_path: str | None, benchmark_content_hash: str | None, environment: dict, commands: list[str], missing: list[str]) -> dict:
    dataset = {"path": dataset_path, "sha256": hash_file(ROOT / dataset_path) if dataset_path and (ROOT / dataset_path).is_file() else None, "dataset_content_hash": dataset_content_hash}
    benchmark = {"path": benchmark_path, "sha256": hash_file(ROOT / benchmark_path) if benchmark_path and (ROOT / benchmark_path).is_file() else None, "benchmark_content_hash": benchmark_content_hash}
    return {
        "experiment_schema_version": "1.0",
        "experiment_id": experiment_id,
        "title": title,
        "status": status,
        "metadata_status": "reconstructed_after_fact",
        "manifest_created_at": utc_now(),
        "research_question": question,
        "hypothesis": None,
        "experiment_type": experiment_type,
        "git": {"commit": None, "dirty": True, "status_note": "Repository had no commit history when the pilot was run; this manifest is reconstructed after the fact."},
        "environment": environment,
        "dataset": dataset,
        "benchmark": benchmark,
        "model": {"name": None, "revision": None, "tokenizer_revision": None},
        "training": {},
        "execution": {"command": commands, "start_time": None, "end_time": None, "duration_seconds": None, "duration_note": None, "seed": None, "retries": [], "deviations": []},
        "artifacts": {},
        "results": {},
        "interpretation": None,
        "limitations": [],
        "conclusion": None,
        "missing_metadata": missing,
        "reconstruction_sources": ["docs/initial_build_report.md", "data/manifests/public_sources.json"],
    }


def add_artifact(manifest: dict, key: str, path: str) -> None:
    full = ROOT / path
    manifest["artifacts"][key] = path
    if full.is_file():
        manifest["artifacts"][f"{key}_sha256"] = hash_file(full)


def main() -> int:
    pilot_dataset = "data/generated/research-data-v0.1.jsonl"
    pilot_hash = "d894eaa8f60ac8272b6690cc662a1ace3ca52144d8c4a053b66114fb1da41ee4"
    microbench = "benchmarks/tasks/research_microbench.jsonl"
    microbench_hash = "912ee3aa1e33bf7908bffa446bd01f0a01e8abee6878084f1b910e34112b34fe"
    experiments = []

    manifest = base_manifest("E001_initial_pilot", "Initial standalone SciFact research-protocol pilot", "completed", "engineering_validation", "Can a standalone public-data pipeline construct, validate, and score evidence-grounded research protocol examples?", pilot_dataset, pilot_hash, microbench, None, mlx_environment("0.32.2", "0.31.3"), ["uv run research-model data build --max-claims 120", "uv run pytest -q"], ["git_commit", "exact_start_time", "exact_end_time", "exact_python_version", "benchmark_content_hash_at_run"])
    manifest["results"] = {"validation": {"accepted": 480, "rejected": 0, "rejection_rate": 0.0, "note": "The later strict validator demonstrated that this zero-rejection result was not a sufficient quality screen."}, "metrics_scope": "engineering validation, not general research capability"}
    manifest["interpretation"] = "The pipeline was operational and deterministic on a small SciFact-derived pilot; the result does not establish research competence."
    manifest["limitations"] = ["480 examples from one source and one coarse domain label.", "The contemporaneous validator did not perform the later strict low-information and normalized-duplicate checks."]
    manifest["conclusion"] = "Engineering milestone only."
    add_artifact(manifest, "dataset_path", pilot_dataset); add_artifact(manifest, "validation_report", "data/generated/research-data-v0.1.validation.json")
    experiments.append(manifest)

    manifest = base_manifest("E002_qwen3_0_6b_masked_invalid", "Qwen3-0.6B masked 512-token smoke (invalidated)", "invalidated", "training_smoke", None, pilot_dataset, pilot_hash, microbench, microbench_hash, mlx_environment("0.32.2", "0.31.3"), ["uv run mlx_lm lora --model Qwen/Qwen3-0.6B --data data/generated/mlx --train --mask-prompt --max-seq-length 512 --iters 20"], ["git_commit", "exact_start_time", "exact_end_time", "model_revision", "tokenizer_revision", "peak_memory_measurement_method"])
    manifest["model"] = {"name": "Qwen/Qwen3-0.6B", "revision": None, "tokenizer_revision": None}
    manifest["training"] = {"backend": "mlx", "method": "lora", "iters": 20, "num_layers": 4, "rank": 8, "learning_rate": 0.0002, "max_seq_length": 512, "mask_prompt": True, "seed": 0, "adapter_path": "outputs/qwen3-0.6b-research-smoke", "duration_note": "not recorded"}
    manifest["execution"]["seed"] = 0; manifest["execution"]["deviations"] = ["The run produced non-finite/NaN loss because masking and truncation removed assistant targets."]
    manifest["invalidation"] = {"reason": "Invalidated after observing NaN loss caused by truncation removing assistant targets under --mask-prompt.", "recorded_at": utc_now(), "replacement_experiment": "E003_qwen3_0_6b_aligned_smoke"}
    manifest["interpretation"] = "This is retained as a negative engineering result and is excluded from model-quality comparisons."
    manifest["limitations"] = ["No exact start/end time or loss trace was preserved in the available metadata."]
    add_artifact(manifest, "adapter_config", "outputs/qwen3-0.6b-research-smoke/adapter_config.json"); add_artifact(manifest, "adapter_path", "outputs/qwen3-0.6b-research-smoke/adapters.safetensors")
    experiments.append(manifest)

    manifest = base_manifest("E003_qwen3_0_6b_aligned_smoke", "Qwen3-0.6B aligned MLX research-behavior smoke", "completed", "training_smoke", "Can the aligned protocol data change targeted structured behavior in a small local model?", pilot_dataset, pilot_hash, microbench, microbench_hash, mlx_environment("0.32.2", "0.31.3"), ["uv run mlx_lm lora --model Qwen/Qwen3-0.6B --data data/generated/mlx --train --fine-tune-type lora --adapter-path outputs/qwen3-0.6b-research-smoke-v3 --iters 20 --batch-size 1 --learning-rate 0.0001 --max-seq-length 1024 --num-layers 4 --seed 0 --steps-per-report 1 --steps-per-eval 10 --test"], ["git_commit", "exact_start_time", "exact_end_time", "model_revision", "tokenizer_revision", "peak_memory_measurement_method"])
    manifest["model"] = {"name": "Qwen/Qwen3-0.6B", "revision": None, "tokenizer_revision": None}
    manifest["training"] = {"backend": "mlx", "method": "lora", "iters": 20, "num_layers": 4, "rank": 8, "learning_rate": 0.0001, "max_seq_length": 1024, "mask_prompt": False, "seed": 0, "adapter_path": "outputs/qwen3-0.6b-research-smoke-v3", "validation_loss": 1.355, "test_loss": 1.326, "peak_memory_gb": 3.13, "duration_note": "approximately 2 minutes including cached model load and test"}
    manifest["execution"]["seed"] = 0; manifest["results"] = {"public_test": "data/generated/qwen3-0.6b-smoke-public-test.json", "metrics": {"structured_valid": 0.75, "action_accuracy": 0.375, "citation_precision": 0.3958333333, "citation_recall": 0.3958333333, "claim_status_f1": 0.25, "evidence_recall": 0.6875, "unsupported_claim_rate": 0.25}, "comparison_baseline": "data/generated/qwen3-0.6b-untuned-public-test.json", "scope_note": "targeted behavior smoke, not general researcher evidence"}
    manifest["interpretation"] = "The corrected aligned run changed structured protocol behavior and reduced unsupported outputs on the held-out SciFact-derived test, but the sample, model size, and training budget are not sufficient for broad capability claims."
    manifest["limitations"] = ["20 iterations and 0.6B model.", "The test set is derived from the same source family as training, with source-grouped split but limited domain diversity."]
    add_artifact(manifest, "adapter_config", "outputs/qwen3-0.6b-research-smoke-v3/adapter_config.json"); add_artifact(manifest, "adapter_path", "outputs/qwen3-0.6b-research-smoke-v3/adapters.safetensors"); add_artifact(manifest, "prediction_path", "data/generated/qwen3-0.6b-smoke-public-test.json")
    experiments.append(manifest)

    manifest = base_manifest("E004_qwen3_8b_4bit_feasibility", "Qwen3-8B-class 4-bit MLX feasibility smoke", "completed", "feasibility_smoke", "Can an approximately 8B quantized MLX checkpoint accept the research-behavior adapter on the local machine?", pilot_dataset, pilot_hash, microbench, microbench_hash, mlx_environment("0.32.2", "0.31.3"), ["uv run mlx_lm lora --model mlx-community/Qwen3-8B-4bit --data data/generated/mlx --train --adapter-path outputs/qwen3-8b-4bit-research-feasibility-smoke --iters 5 --num-layers 2 --seed 0 --test"], ["git_commit", "exact_start_time", "exact_end_time", "model_revision", "tokenizer_revision", "peak_memory_measurement_method"])
    manifest["model"] = {"name": "mlx-community/Qwen3-8B-4bit", "revision": None, "tokenizer_revision": None, "lineage_note": "Public MLX conversion; not identical to the primary Qwen/Qwen3-8B-Base SFT target."}
    manifest["training"] = {"backend": "mlx", "method": "lora", "iters": 5, "num_layers": 2, "rank": 8, "learning_rate": 0.00005, "max_seq_length": 1024, "mask_prompt": False, "seed": 0, "adapter_path": "outputs/qwen3-8b-4bit-research-feasibility-smoke", "validation_loss": 1.712, "test_loss": 1.852, "peak_memory_gb": 6.104, "duration_note": "not precisely recorded"}
    manifest["execution"]["seed"] = 0; manifest["results"] = {"scope_note": "memory and adapter mechanics only"}
    manifest["interpretation"] = "The local machine could run the 8B-class quantized adapter path, making a longer MLX feasibility run practical."
    manifest["limitations"] = ["Instruct-derived quantized conversion rather than the primary base checkpoint.", "Five iterations are not a model-quality experiment."]
    add_artifact(manifest, "adapter_config", "outputs/qwen3-8b-4bit-research-feasibility-smoke/adapter_config.json"); add_artifact(manifest, "adapter_path", "outputs/qwen3-8b-4bit-research-feasibility-smoke/adapters.safetensors")
    experiments.append(manifest)

    manifest = base_manifest("E005_qwen3_8b_4bit_research_smoke", "Qwen3-8B-class 4-bit MLX 20-iteration research smoke", "completed", "training_smoke", "Does a short 8B-class research-behavior adapter run alter protocol outputs on controlled cases?", pilot_dataset, pilot_hash, microbench, microbench_hash, mlx_environment("0.32.2", "0.31.3"), ["uv run mlx_lm lora --model mlx-community/Qwen3-8B-4bit --data data/generated/mlx --train --adapter-path outputs/qwen3-8b-4bit-research-smoke-v2 --iters 20 --num-layers 8 --learning-rate 0.00005 --max-seq-length 1024 --seed 0 --test"], ["git_commit", "exact_start_time", "exact_end_time", "model_revision", "tokenizer_revision", "peak_memory_measurement_method"])
    manifest["model"] = {"name": "mlx-community/Qwen3-8B-4bit", "revision": None, "tokenizer_revision": None, "lineage_note": "Public MLX conversion; not the primary Qwen/Qwen3-8B-Base SFT result."}
    manifest["training"] = {"backend": "mlx", "method": "lora", "iters": 20, "num_layers": 8, "rank": 8, "learning_rate": 0.00005, "max_seq_length": 1024, "mask_prompt": False, "seed": 0, "adapter_path": "outputs/qwen3-8b-4bit-research-smoke-v2", "validation_loss": 0.958, "test_loss": 0.984, "perplexity": 2.675, "peak_memory_gb": 8.823, "duration_note": "approximately 9 minutes including model fetch and test"}
    manifest["execution"]["seed"] = 0; manifest["execution"]["deviations"] = ["Manual run used seed=0; the versioned pilot configuration defaulted to seed=17."]
    manifest["results"] = {"microbench": "data/generated/qwen3-8b-4bit-smoke-microbench-v2.json", "comparison_baseline": "data/generated/qwen3-8b-4bit-untuned-microbench-v2.json", "metrics": {"structured_valid": 1.0, "action_accuracy": 0.3, "citation_precision": 0.1, "citation_recall": 0.1, "claim_status_f1": 0.2, "evidence_recall": 0.9, "unsupported_claim_rate": 0.0}, "baseline_metrics": {"structured_valid": 0.0, "action_accuracy": 0.5, "citation_precision": 0.45, "citation_recall": 0.5, "claim_status_f1": 0.2, "evidence_recall": 0.8, "unsupported_claim_rate": 0.3}}
    manifest["interpretation"] = "The short smoke improved structured validity and reduced unsupported outputs while degrading citation metrics; this mixed result is feasibility evidence, not evidence that specialization is generally beneficial."
    manifest["limitations"] = ["20 iterations on the 10-case controlled benchmark.", "Instruct-derived quantized conversion rather than the primary base checkpoint.", "No general-capability control was run."]
    add_artifact(manifest, "adapter_config", "outputs/qwen3-8b-4bit-research-smoke-v2/adapter_config.json"); add_artifact(manifest, "adapter_path", "outputs/qwen3-8b-4bit-research-smoke-v2/adapters.safetensors"); add_artifact(manifest, "prediction_path", "data/generated/qwen3-8b-4bit-smoke-microbench-v2.json")
    experiments.append(manifest)

    for manifest in experiments:
        directory = ROOT / "experiments" / manifest["experiment_id"]
        directory.mkdir(parents=True, exist_ok=True)
        summary = [f"# {manifest['experiment_id']}: {manifest['title']}", "", f"Status: **{manifest['status']}**", f"Metadata: **{manifest['metadata_status']}**", "", f"Research question: {manifest['research_question']}", "", f"Interpretation: {manifest['interpretation']}", "", "Known limitations:"]
        summary.extend(f"- {item}" for item in manifest["limitations"])
        summary.extend(["", "This manifest was reconstructed from the listed reports and artifact metadata. Null fields are intentionally not guessed."])
        (directory / "summary.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
        manifest["artifacts"]["summary_path"] = str(directory / "summary.md")
        append_experiment_manifest(manifest, ROOT)
    print(json.dumps({"created": [manifest["experiment_id"] for manifest in experiments], "index": str(ROOT / "experiments/index.json")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
