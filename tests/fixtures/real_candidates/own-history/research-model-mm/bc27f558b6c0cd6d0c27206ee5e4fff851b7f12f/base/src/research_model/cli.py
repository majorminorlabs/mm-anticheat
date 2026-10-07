from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .benchmark import build_research_benchmark
from .datasets.jsonl import read_jsonl, write_jsonl
from .datasets.splits import assign_source_group_splits, dataset_hash
from .evaluation.control import CONTROL_CASES, score_control_example
from .evaluation.scorers import aggregate_scores, score_example
from .evaluation.statistics import paired_bootstrap
from .ingestion.public import acquire_scifact, read_scifact
from .ingestion.qasper import acquire_qasper, read_qasper
from .inference.engine import load_backend
from .provenance.experiments import experiment_manifests, load_experiment_index, validate_manifest
from .research_protocol.protocol import SYSTEM_INSTRUCTION
from .task_generation.generate import generate_scifact_examples
from .task_generation.qasper import generate_qasper_examples
from .training.config import load_toml
from .validation.validators import dataset_composition, validate_contamination, validate_dataset

ROOT = Path(__file__).resolve().parents[2]


def _path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def _write_new(path: Path, content: str, allow_overwrite: bool = False) -> None:
    if path.exists() and not allow_overwrite:
        raise SystemExit(f"refusing to overwrite existing evidence: {path}; choose a new versioned path")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def cmd_data_build(args: argparse.Namespace) -> int:
    root = _path(args.data_root)
    manifest = _path(args.manifest)
    acquisitions: dict[str, Any] = {}
    rows: list[dict[str, Any]] = []
    sources = [item.strip() for item in args.sources.split(",") if item.strip()]
    if "scifact" in sources:
        acquisition = acquire_scifact(root, manifest)
        acquisitions["scifact"] = acquisition
        dataset = read_scifact(acquisition["data_dir"])
        task_types = args.tasks.split(",") if args.tasks else None
        split_names = tuple(item.strip() for item in args.scifact_splits.split(",") if item.strip())
        rows.extend(generate_scifact_examples(dataset, max_claims=args.max_claims, task_types=task_types, seed=args.seed, split_names=split_names))
    if "qasper" in sources:
        acquisition = acquire_qasper(root, manifest)
        acquisitions["qasper"] = acquisition
        qasper = read_qasper(acquisition["data_dir"])
        qasper_tasks = [item.strip() for item in args.qasper_tasks.split(",") if item.strip()]
        rows.extend(generate_qasper_examples(qasper, max_questions=args.max_questions, task_types=qasper_tasks, seed=args.seed))
    if not rows:
        raise SystemExit("no rows generated; choose at least one source")

    rows = assign_source_group_splits(rows, seed=args.seed)
    report = validate_dataset(rows, strict=args.strict)
    output = _path(args.output)
    _write_new(output, "", allow_overwrite=args.allow_overwrite)
    write_jsonl(output, report["accepted"])
    mlx_dir = _path(args.mlx_dir)
    if mlx_dir.exists() and any(mlx_dir.glob("*.jsonl")) and not args.allow_overwrite:
        raise SystemExit(f"refusing to overwrite existing MLX data: {mlx_dir}; choose a new --mlx-dir")
    mlx_dir.mkdir(parents=True, exist_ok=True)
    for split in ("train", "validation", "test"):
        split_rows = [row for row in report["accepted"] if row.get("split") == split]
        split_name = "valid" if split == "validation" else split
        write_jsonl(mlx_dir / f"{split_name}.jsonl", ({"messages": [{"role": "system", "content": SYSTEM_INSTRUCTION}, {"role": "user", "content": row["question"] + "\n" + row.get("context", "")}, {"role": "assistant", "content": json.dumps(row["expected_output"], ensure_ascii=False)}]} for row in split_rows))

    report.update({
        "dataset_version": args.version,
        "dataset_hash": dataset_hash(report["accepted"]),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "acquisition": acquisitions,
        "split_policy": "source_grouped_sha256",
        "strict_validation": args.strict,
        "source_selection": sources,
        "split_counts": {split: sum(1 for row in report["accepted"] if row.get("split") == split) for split in ("train", "validation", "test")},
    })
    report_path = output.with_suffix(".validation.json")
    _write_new(report_path, json.dumps(report, indent=2, ensure_ascii=False) + "\n", allow_overwrite=args.allow_overwrite)
    print(json.dumps({"output": str(output), "validation_report": str(report_path), "accepted": report["accepted_count"], "rejected": report["rejected_count"], "rejection_rate": report["rejection_rate"], "dataset_hash": report["dataset_hash"], "composition": report["composition"]}, indent=2))
    return 0


def _run_backend(args: argparse.Namespace, rows: list[dict[str, Any]]) -> dict[str, Any]:
    backend = load_backend(args.backend, args.model, load_in_4bit=args.load_in_4bit, adapter_path=args.adapter_path)
    checkpoint_path = _path(args.checkpoint_path) if args.checkpoint_path else _path(str(args.output) + ".partial.json")
    scores: list[dict[str, Any]] = []
    if args.resume and checkpoint_path.exists():
        scores = json.loads(checkpoint_path.read_text(encoding="utf-8")).get("per_example", [])
    completed = {row.get("example_id") for row in scores}
    selected = rows[:args.max_examples] if args.max_examples else rows
    for row in selected:
        if row.get("example_id") in completed:
            continue
        try:
            predicted = backend.generate(row["question"], row.get("context", ""), row["task_type"], max_new_tokens=args.max_new_tokens, temperature=args.temperature)
        except Exception as exc:  # keep long evaluation resumable and diagnosable
            predicted = {"error": str(exc)}
        scores.append(score_example(row, predicted))
        if len(scores) % max(1, args.checkpoint_every) == 0:
            checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
            checkpoint_path.write_text(json.dumps({"checkpoint": True, "backend": getattr(backend, "name", args.backend), "model": args.model, "per_example": scores}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"backend": getattr(backend, "name", args.backend), "model": args.model, "scores": aggregate_scores(scores), "per_example": scores}


def cmd_eval(args: argparse.Namespace, label: str) -> int:
    output = _path(args.output)
    if output.exists() and not args.allow_overwrite:
        raise SystemExit(f"refusing to overwrite existing evaluation evidence: {output}; choose a new output")
    rows = read_jsonl(_path(args.dataset))
    if args.split:
        rows = [row for row in rows if row.get("split") == args.split]
    result = _run_backend(args, rows)
    result.update({"label": label, "timestamp": datetime.now(timezone.utc).isoformat(), "dataset": args.dataset, "split": args.split})
    _write_new(output, json.dumps(result, indent=2, ensure_ascii=False) + "\n", allow_overwrite=args.allow_overwrite)
    print(json.dumps(result["scores"], indent=2))
    print(f"wrote {output}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    report = validate_dataset(read_jsonl(_path(args.dataset)), strict=args.strict)
    print(json.dumps({key: value for key, value in report.items() if key != "accepted"}, indent=2, ensure_ascii=False))
    return 1 if report["rejected_count"] else 0


def cmd_infer(args: argparse.Namespace) -> int:
    backend = load_backend(args.backend, args.model, load_in_4bit=args.load_in_4bit, adapter_path=args.adapter_path)
    output = backend.generate(args.question, args.context, args.task_type, max_new_tokens=args.max_new_tokens, temperature=args.temperature)
    print(json.dumps(output, indent=2, ensure_ascii=False))
    return 0


def cmd_train(args: argparse.Namespace) -> int:
    config = load_toml(_path(args.config))
    if args.backend == "mlx":
        output_dir = _path(config["output_dir"])
        if output_dir.exists() and any(output_dir.iterdir()) and not args.allow_existing_output:
            raise SystemExit(f"refusing to overwrite existing training artifact: {output_dir}; choose a new output_dir")
        command = [sys.executable, "-m", "mlx_lm", "lora", "--model", config["base_model"], "--data", str(_path(config.get("mlx_data_dir", "data/generated/mlx"))), "--train", "--fine-tune-type", "lora", "--adapter-path", str(output_dir), "--iters", str(args.iters or config.get("iters", 200)), "--batch-size", str(config.get("batch_size", 1)), "--learning-rate", str(config["learning_rate"]), "--max-seq-length", str(config["max_seq_length"]), "--num-layers", str(config.get("num_layers", 8)), "--seed", str(config.get("seed", 17)), "--steps-per-report", str(config.get("steps_per_report", 5)), "--steps-per-eval", str(config.get("steps_per_eval", 50)), "--save-every", str(config.get("save_every", 100)), "--test"]
        if config.get("grad_checkpoint"):
            command.append("--grad-checkpoint")
        if config.get("mask_prompt"):
            command.append("--mask-prompt")
        print("running:", " ".join(command))
        return subprocess.call(command, cwd=ROOT)
    command = [sys.executable, "scripts/train_transformers.py", "--config", args.config]
    print("running:", " ".join(command))
    return subprocess.call(command, cwd=ROOT)


def cmd_compare(args: argparse.Namespace) -> int:
    base = json.loads(_path(args.base).read_text(encoding="utf-8"))
    tuned = json.loads(_path(args.tuned).read_text(encoding="utf-8"))
    base_scores = base.get("scores", {})
    tuned_scores = tuned.get("scores", {})
    keys = sorted(set(base_scores) & set(tuned_scores) - {"by_task", "count"})
    print(json.dumps({"base": args.base, "tuned": args.tuned, "delta_tuned_minus_base": {key: tuned_scores[key] - base_scores[key] for key in keys}}, indent=2))
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    del args
    files = ["data/generated/research-data-v0.1.validation.json", "data/generated/baseline.json", "data/generated/evaluation.json"]
    result: dict[str, Any] = {"project": "research-model", "files": {}, "experiments": load_experiment_index(ROOT)}
    for name in files:
        path = _path(name)
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
            result["files"][name] = {key: payload[key] for key in ("dataset_version", "dataset_hash", "accepted_count", "rejected_count", "rejection_rate", "composition", "label", "backend", "model", "scores") if key in payload}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


def cmd_benchmark_build(args: argparse.Namespace) -> int:
    output = _path(args.output)
    if output.exists() and not args.allow_overwrite:
        raise SystemExit(f"refusing to overwrite frozen benchmark: {output}; choose a new version")
    rows = build_research_benchmark()
    report = validate_dataset(rows, strict=True)
    if report["rejected_count"]:
        raise SystemExit(json.dumps({"rejected_count": report["rejected_count"], "causes": report["rejection_causes"]}, indent=2))
    write_jsonl(output, rows)
    metadata = {"benchmark_version": args.version, "frozen_at": datetime.now(timezone.utc).isoformat(), "hash": dataset_hash(rows), "count": len(rows), "composition": dataset_composition(rows), "validation": {key: value for key, value in report.items() if key != "accepted"}, "source_boundary": "controlled fixture source IDs are disjoint from public training-source IDs"}
    metadata_path = output.with_suffix(".metadata.json")
    if metadata_path.exists() and not args.allow_overwrite:
        raise SystemExit(f"refusing to overwrite frozen benchmark metadata: {metadata_path}")
    metadata_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "metadata": str(metadata_path), "count": len(rows), "hash": metadata["hash"]}, indent=2))
    return 0


def cmd_contamination(args: argparse.Namespace) -> int:
    train = read_jsonl(_path(args.training))
    benchmark = read_jsonl(_path(args.benchmark))
    report = validate_contamination(train, benchmark, args.near_duplicate_threshold)
    output = _path(args.output)
    _write_new(output, json.dumps(report, indent=2, ensure_ascii=False) + "\n", allow_overwrite=args.allow_overwrite)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if report["contaminated"] else 0


def cmd_experiment_validate(args: argparse.Namespace) -> int:
    paths = experiment_manifests(ROOT) if args.all else [_path(args.manifest)]
    reports = []
    for path in paths:
        reports.append({"manifest": str(path), **validate_manifest(json.loads(path.read_text(encoding="utf-8")), ROOT)})
    result = {"count": len(reports), "valid": all(item["valid"] for item in reports), "experiments": reports}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["valid"] else 1


def cmd_control_build(args: argparse.Namespace) -> int:
    output = _path(args.output)
    rows = CONTROL_CASES
    _write_new(output, "", allow_overwrite=args.allow_overwrite)
    write_jsonl(output, rows)
    metadata = {"control_version": args.version, "frozen_at": datetime.now(timezone.utc).isoformat(), "count": len(rows), "hash": dataset_hash(rows), "composition": dataset_composition(rows), "scoring": "keyword checks are a small regression guard, not a general intelligence measure"}
    metadata_path = output.with_suffix(".metadata.json")
    _write_new(metadata_path, json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", allow_overwrite=args.allow_overwrite)
    print(json.dumps({"output": str(output), "metadata": str(metadata_path), "count": len(rows), "hash": metadata["hash"]}, indent=2))
    return 0


def cmd_control_eval(args: argparse.Namespace) -> int:
    backend = load_backend(args.backend, args.model, load_in_4bit=args.load_in_4bit, adapter_path=args.adapter_path)
    scores: list[dict[str, Any]] = []
    for row in CONTROL_CASES:
        prompt = row["question"] + ("\n" + row["context"] if row.get("context") else "")
        try:
            generate_freeform = getattr(backend, "generate_freeform_text", backend.generate_text)
            raw = generate_freeform(prompt, max_new_tokens=args.max_new_tokens, temperature=args.temperature)
        except Exception as exc:
            raw = f"ERROR: {exc}"
        scores.append(score_control_example(row, raw))
    result = {"label": args.label, "backend": getattr(backend, "name", args.backend), "model": args.model, "timestamp": datetime.now(timezone.utc).isoformat(), "scores": {"count": len(scores), "keyword_recall": sum(row["keyword_recall"] for row in scores) / len(scores), "forbidden_violation_rate": sum(row["forbidden_violation"] for row in scores) / len(scores), "nonempty_rate": sum(row["nonempty"] for row in scores) / len(scores)}, "per_example": scores}
    output = _path(args.output)
    _write_new(output, json.dumps(result, indent=2, ensure_ascii=False) + "\n", allow_overwrite=args.allow_overwrite)
    print(json.dumps(result["scores"], indent=2)); return 0


def cmd_stats_compare(args: argparse.Namespace) -> int:
    base = json.loads(_path(args.base).read_text(encoding="utf-8")); tuned = json.loads(_path(args.tuned).read_text(encoding="utf-8"))
    result = {"base": args.base, "tuned": args.tuned, "analysis": paired_bootstrap(base.get("per_example", []), tuned.get("per_example", []), samples=args.samples, seed=args.seed), "created_at": datetime.now(timezone.utc).isoformat()}
    output = _path(args.output)
    _write_new(output, json.dumps(result, indent=2, ensure_ascii=False) + "\n", allow_overwrite=args.allow_overwrite)
    print(json.dumps(result, indent=2, ensure_ascii=False)); return 0


def _common_eval(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--backend", choices=["heuristic", "transformers", "mlx"], default="heuristic")
    parser.add_argument("--model")
    parser.add_argument("--adapter-path")
    parser.add_argument("--dataset", default="benchmarks/tasks/research_microbench.jsonl")
    parser.add_argument("--split", choices=["train", "validation", "test"])
    parser.add_argument("--output", default="data/generated/evaluation.json")
    parser.add_argument("--max-examples", type=int)
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--load-in-4bit", action="store_true")
    parser.add_argument("--allow-overwrite", action="store_true")
    parser.add_argument("--checkpoint-path")
    parser.add_argument("--checkpoint-every", type=int, default=1)
    parser.add_argument("--resume", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="research-model")
    sub = parser.add_subparsers(dest="command", required=True)
    data = sub.add_parser("data")
    data_sub = data.add_subparsers(dest="data_command", required=True)
    build = data_sub.add_parser("build")
    build.add_argument("--sources", default="scifact")
    build.add_argument("--max-claims", type=int, default=120)
    build.add_argument("--max-questions", type=int)
    build.add_argument("--scifact-splits", default="train")
    build.add_argument("--seed", type=int, default=17)
    build.add_argument("--version", default="research-data-v0.1")
    build.add_argument("--tasks")
    build.add_argument("--qasper-tasks", default="evidence_extraction,claim_extraction,citation_integrity,insufficient_evidence,evidence_table")
    build.add_argument("--data-root", default="data")
    build.add_argument("--manifest", default="data/manifests/public_sources.json")
    build.add_argument("--output", default="data/generated/research-data-v0.1.jsonl")
    build.add_argument("--mlx-dir", default="data/generated/mlx")
    build.add_argument("--strict", action="store_true")
    build.add_argument("--allow-overwrite", action="store_true")
    build.set_defaults(func=cmd_data_build)

    baseline = sub.add_parser("baseline")
    baseline_sub = baseline.add_subparsers(dest="baseline_command", required=True)
    run = baseline_sub.add_parser("run")
    _common_eval(run)
    run.set_defaults(output="data/generated/baseline.json", func=lambda a: cmd_eval(a, "untouched-base-or-protocol-baseline"))
    evaluate = sub.add_parser("evaluate")
    _common_eval(evaluate)
    evaluate.set_defaults(func=lambda a: cmd_eval(a, "research-model-evaluation"))
    validate = sub.add_parser("validate")
    validate.add_argument("--dataset", default="data/generated/research-data-v0.1.jsonl")
    validate.add_argument("--strict", action="store_true")
    validate.set_defaults(func=cmd_validate)
    infer = sub.add_parser("infer")
    infer.add_argument("--backend", choices=["heuristic", "transformers", "mlx"], default="heuristic")
    infer.add_argument("--model")
    infer.add_argument("--adapter-path")
    infer.add_argument("--question", required=True)
    infer.add_argument("--context", default="")
    infer.add_argument("--task-type", default="research_plan")
    infer.add_argument("--max-new-tokens", type=int, default=512)
    infer.add_argument("--temperature", type=float, default=0.0)
    infer.add_argument("--load-in-4bit", action="store_true")
    infer.set_defaults(func=cmd_infer)
    train = sub.add_parser("train")
    train.add_argument("--config", default="configs/training/qwen3_8b_qlora.toml")
    train.add_argument("--backend", choices=["transformers", "mlx"], default="transformers")
    train.add_argument("--iters", type=int)
    train.add_argument("--allow-existing-output", action="store_true")
    train.set_defaults(func=cmd_train)
    compare = sub.add_parser("compare")
    compare.add_argument("--base", default="data/generated/baseline.json")
    compare.add_argument("--tuned", default="data/generated/evaluation.json")
    compare.set_defaults(func=cmd_compare)
    report = sub.add_parser("report")
    report.set_defaults(func=cmd_report)

    benchmark = sub.add_parser("benchmark")
    benchmark_sub = benchmark.add_subparsers(dest="benchmark_command", required=True)
    benchmark_build = benchmark_sub.add_parser("build")
    benchmark_build.add_argument("--version", default="research-bench-v0.1")
    benchmark_build.add_argument("--output", default="benchmarks/releases/research-bench-v0.1.jsonl")
    benchmark_build.add_argument("--allow-overwrite", action="store_true")
    benchmark_build.set_defaults(func=cmd_benchmark_build)
    contamination = sub.add_parser("contamination")
    contamination.add_argument("--training", required=True)
    contamination.add_argument("--benchmark", default="benchmarks/releases/research-bench-v0.1.jsonl")
    contamination.add_argument("--output", default="data/generated/contamination-research-bench-v0.1.json")
    contamination.add_argument("--near-duplicate-threshold", type=float, default=0.9)
    contamination.add_argument("--allow-overwrite", action="store_true")
    contamination.set_defaults(func=cmd_contamination)
    experiment = sub.add_parser("experiment")
    experiment_sub = experiment.add_subparsers(dest="experiment_command", required=True)
    experiment_validate = experiment_sub.add_parser("validate")
    experiment_validate.add_argument("--manifest", default="experiments/E001_initial_pilot/manifest.json")
    experiment_validate.add_argument("--all", action="store_true")
    experiment_validate.set_defaults(func=cmd_experiment_validate)
    control = sub.add_parser("control")
    control_sub = control.add_subparsers(dest="control_command", required=True)
    control_build = control_sub.add_parser("build")
    control_build.add_argument("--version", default="general-control-v0.1")
    control_build.add_argument("--output", default="benchmarks/control/general-capability-v0.1.jsonl")
    control_build.add_argument("--allow-overwrite", action="store_true")
    control_build.set_defaults(func=cmd_control_build)
    control_eval = control_sub.add_parser("evaluate")
    control_eval.add_argument("--backend", choices=["heuristic", "transformers", "mlx"], default="heuristic")
    control_eval.add_argument("--model")
    control_eval.add_argument("--adapter-path")
    control_eval.add_argument("--label", default="control-evaluation")
    control_eval.add_argument("--max-new-tokens", type=int, default=256)
    control_eval.add_argument("--temperature", type=float, default=0.0)
    control_eval.add_argument("--load-in-4bit", action="store_true")
    control_eval.add_argument("--output", default="data/generated/control-evaluation.json")
    control_eval.add_argument("--allow-overwrite", action="store_true")
    control_eval.set_defaults(func=cmd_control_eval)
    stats = sub.add_parser("stats")
    stats_sub = stats.add_subparsers(dest="stats_command", required=True)
    stats_compare = stats_sub.add_parser("compare")
    stats_compare.add_argument("--base", required=True)
    stats_compare.add_argument("--tuned", required=True)
    stats_compare.add_argument("--output", required=True)
    stats_compare.add_argument("--samples", type=int, default=2000)
    stats_compare.add_argument("--seed", type=int, default=17)
    stats_compare.add_argument("--allow-overwrite", action="store_true")
    stats_compare.set_defaults(func=cmd_stats_compare)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))
