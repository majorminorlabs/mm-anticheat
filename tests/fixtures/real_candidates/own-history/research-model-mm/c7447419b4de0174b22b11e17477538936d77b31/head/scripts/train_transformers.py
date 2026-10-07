"""Reproducible NVIDIA QLoRA SFT runner with a tokenizer-only dry run."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import os
import platform
import random
import shutil
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from research_model.datasets.jsonl import read_jsonl
from research_model.datasets.splits import dataset_hash
from research_model.provenance.manifest import hash_file
from research_model.research_protocol.protocol import build_prompt
from research_model.training.checkpoints import (
    latest_complete_checkpoint,
    quarantine_incomplete_checkpoints,
    write_checkpoint_complete_marker,
)
from research_model.training.profiles import (
    apply_hardware_profile,
    load_hardware_profile,
    validate_visible_gpus,
)
from research_model.validation.validators import validate_dataset


def _project_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _example_text(row: dict[str, Any]) -> str:
    return build_prompt(row["question"], row.get("context", ""), row["task_type"]) + "\n" + json.dumps(
        row["expected_output"], ensure_ascii=False
    )


def _load_data(config: dict[str, Any], world_size: int = 1) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    dataset_path = _project_path(config["dataset_path"])
    if not dataset_path.is_file():
        raise SystemExit(f"training dataset is missing: {dataset_path}")
    file_sha256 = hash_file(dataset_path)
    expected_file_sha256 = config.get("dataset_file_sha256")
    if expected_file_sha256 and file_sha256 != expected_file_sha256:
        raise SystemExit(
            "training dataset file hash mismatch: "
            f"expected {expected_file_sha256}, found {file_sha256}"
        )

    rows = read_jsonl(dataset_path)
    content_hash = dataset_hash(rows)
    expected_content_hash = config.get("dataset_content_hash")
    if expected_content_hash and content_hash != expected_content_hash:
        raise SystemExit(
            "training dataset content hash mismatch: "
            f"expected {expected_content_hash}, found {content_hash}"
        )
    validation = validate_dataset(rows, strict=True)
    if validation["rejected_count"] or validation["accepted_count"] != len(rows):
        raise SystemExit(
            "strict dataset validation failed: "
            f"accepted={validation['accepted_count']} rejected={validation['rejected_count']}"
        )

    splits = {
        name: [row for row in rows if row.get("split") == name]
        for name in ("train", "validation", "test")
    }
    if not splits["train"] or not splits["validation"] or not splits["test"]:
        raise SystemExit("training dataset must contain non-empty train, validation, and test splits")
    updates_per_epoch = math.ceil(
        len(splits["train"])
        / config["per_device_train_batch_size"]
        / config["gradient_accumulation_steps"]
        / world_size
    )
    split_report = {
        "path": str(dataset_path.relative_to(ROOT)),
        "file_sha256": file_sha256,
        "content_hash": content_hash,
        "row_count": len(rows),
        "split_counts": {name: len(values) for name, values in splits.items()},
        "split_hashes": {name: dataset_hash(values) for name, values in splits.items()},
        "estimated_optimizer_steps": math.ceil(updates_per_epoch * config["num_train_epochs"]),
        "strict_validation": {
            "accepted_count": validation["accepted_count"],
            "rejected_count": validation["rejected_count"],
        },
    }
    return splits, split_report


def _tokenizer_lengths(tokenizer: Any, texts: list[str]) -> list[int]:
    encoded = tokenizer(texts, add_special_tokens=True, truncation=False, padding=False)
    eos_addition = int(tokenizer.eos_token_id is not None)
    return [len(item) + eos_addition for item in encoded["input_ids"]]


def _full_token_statistics(tokenizer: Any, splits: dict[str, list[dict[str, Any]]], max_length: int) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for split_name, rows in splits.items():
        lengths: list[int] = []
        target_tokens = retained_target_tokens = 0
        truncated_examples = zero_target_examples = 0
        for offset in range(0, len(rows), 32):
            batch = rows[offset : offset + 32]
            prompts = [build_prompt(row["question"], row.get("context", ""), row["task_type"]) for row in batch]
            answers = [json.dumps(row["expected_output"], ensure_ascii=False) for row in batch]
            texts = [prompt + "\n" + answer for prompt, answer in zip(prompts, answers)]
            encoded = tokenizer(
                texts,
                add_special_tokens=True,
                truncation=False,
                padding=False,
                return_offsets_mapping=True,
            )
            for prompt, token_ids, token_offsets in zip(prompts, encoded["input_ids"], encoded["offset_mapping"]):
                answer_start = len(prompt) + 1
                total_answer = sum(end > answer_start for _, end in token_offsets)
                retained_answer = sum(end > answer_start for _, end in token_offsets[:max_length])
                # TRL appends one EOS token to each plain-text SFT sample.
                lengths.append(len(token_ids) + int(tokenizer.eos_token_id is not None))
                target_tokens += total_answer
                retained_target_tokens += retained_answer
                truncated_examples += int(retained_answer < total_answer)
                zero_target_examples += int(total_answer > 0 and retained_answer == 0)
        ordered = sorted(lengths)
        percentile = lambda fraction: ordered[math.ceil(fraction * len(ordered)) - 1]
        result[split_name] = {
            "examples": len(ordered),
            "total_unpadded_tokens_per_epoch": sum(ordered),
            "automatic_eos_tokens_per_epoch": len(ordered) if tokenizer.eos_token_id is not None else 0,
            "mean_tokens": round(sum(ordered) / len(ordered), 2),
            "median_tokens": statistics.median(ordered),
            "p95_tokens": percentile(0.95),
            "p99_tokens": percentile(0.99),
            "max_tokens": ordered[-1],
            "examples_over_max_length": sum(length > max_length for length in ordered),
            "target_tokens": target_tokens,
            "retained_target_tokens": retained_target_tokens,
            "target_token_retention_rate": retained_target_tokens / target_tokens if target_tokens else None,
            "examples_with_any_target_truncation": truncated_examples,
            "examples_with_zero_target_retained": zero_target_examples,
        }
    return result


def _dry_run(
    config: dict[str, Any],
    splits: dict[str, list[dict[str, Any]]],
    dataset_report: dict[str, Any],
    sample_count: int,
    skip_tokenizer: bool,
    full_token_stats: bool,
) -> int:
    samples = {
        name: values[:sample_count]
        for name, values in splits.items()
        if name in {"train", "validation"}
    }
    texts = {name: [_example_text(row) for row in rows] for name, rows in samples.items()}
    report: dict[str, Any] = {
        "dry_run": True,
        "model": config["base_model"],
        "model_revision": config.get("model_revision"),
        "tokenizer_revision": config.get("tokenizer_revision", config.get("model_revision")),
        "max_sequence_length": config["max_seq_length"],
        "hardware_profile": config.get("hardware_profile"),
        "effective_global_batch_size": config.get("effective_global_batch_size"),
        "dataset": dataset_report,
        "sample_count_per_split": sample_count,
        "sample_character_lengths": {
            name: [len(text) for text in values] for name, values in texts.items()
        },
    }
    if not skip_tokenizer:
        try:
            from transformers import AutoTokenizer
        except ImportError as exc:
            raise SystemExit("Install the locked ml extra to run the tokenizer dry run: uv sync --extra ml --locked") from exc
        tokenizer = AutoTokenizer.from_pretrained(
            config["base_model"],
            revision=config.get("tokenizer_revision", config.get("model_revision")),
        )
        lengths = {name: _tokenizer_lengths(tokenizer, values) for name, values in texts.items()}
        report["sample_token_lengths"] = lengths
        report["sample_over_max_length"] = {
            name: sum(length > config["max_seq_length"] for length in values)
            for name, values in lengths.items()
        }
        if full_token_stats:
            report["full_token_statistics"] = _full_token_statistics(tokenizer, splits, config["max_seq_length"])
    else:
        report["tokenizer_check"] = "skipped by request; only prompt/data path validated"
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


def _append_event(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"timestamp": _utc_now(), **event}, ensure_ascii=False) + "\n")


def _package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _runtime_environment(torch: Any) -> dict[str, Any]:
    ram_bytes = None
    try:
        ram_bytes = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, OSError, ValueError):
        pass
    driver_versions = None
    try:
        driver_versions = sorted(set(subprocess.check_output(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=5,
        ).strip().splitlines()))
    except (FileNotFoundError, subprocess.SubprocessError):
        pass
    gpu = torch.cuda.get_device_properties(torch.cuda.current_device())
    packages = {
        dist: _package_version(dist)
        for dist in ("torch", "transformers", "peft", "bitsandbytes", "accelerate", "datasets", "trl", "flash-attn")
    }
    return {
        "machine": {
            "os": platform.platform(),
            "architecture": platform.machine(),
            "cpu": platform.processor() or platform.uname().processor or None,
            "system_ram_bytes": ram_bytes,
            "disk_free_bytes_at_training_start": shutil.disk_usage(ROOT).free,
        },
        "gpu": {
            "name": torch.cuda.get_device_name(torch.cuda.current_device()),
            "visible_count": torch.cuda.device_count(),
            "vram_bytes": gpu.total_memory,
            "compute_capability": list(torch.cuda.get_device_capability(torch.cuda.current_device())),
            "cuda_runtime_version": torch.version.cuda,
            "driver_versions": driver_versions,
        },
        "software": {
            "python": sys.version.split()[0],
            "packages": {name: version for name, version in packages.items() if version is not None},
        },
    }


def _run_training(config: dict[str, Any], splits: dict[str, list[dict[str, Any]]], dataset_report: dict[str, Any], resume: bool) -> int:
    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainerCallback, set_seed
        from trl import SFTConfig, SFTTrainer
    except ImportError as exc:
        raise SystemExit("Install the locked ML dependencies before NVIDIA QLoRA training: uv sync --extra ml --locked") from exc

    if not torch.cuda.is_available():
        raise SystemExit("NVIDIA CUDA is unavailable; refusing to start the primary QLoRA run on CPU/Apple GPU")
    if not torch.cuda.is_bf16_supported():
        raise SystemExit("the configured BF16 QLoRA recipe requires an NVIDIA GPU with BF16 support")

    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    world_size = int(os.environ.get("WORLD_SIZE", "1"))
    if local_rank < 0 or local_rank >= torch.cuda.device_count():
        raise SystemExit(f"LOCAL_RANK={local_rank} is outside the visible CUDA device set")
    torch.cuda.set_device(local_rank)
    try:
        gpu_devices = validate_visible_gpus(torch, config["_hardware_profile"], world_size)
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from exc

    output_dir = _project_path(config["output_dir"])
    last_checkpoint = latest_complete_checkpoint(output_dir, world_size) if output_dir.exists() else None
    if resume and not last_checkpoint:
        raise SystemExit(
            f"--resume requested but no atomically committed, complete Trainer checkpoint exists under {output_dir}; "
            "checkpoint files without a completion marker are not resumable"
        )
    if not resume and output_dir.exists() and any(output_dir.iterdir()):
        raise SystemExit(f"refusing to overwrite existing training artifacts: {output_dir}; use --resume or a new output_dir")

    if config.get("eval_strategy") == "steps" and config["save_strategy"] == "steps":
        if config["save_steps"] % config["eval_steps"]:
            raise SystemExit("save_steps must be a multiple of eval_steps when selecting the best checkpoint")

    random.seed(config["seed"])
    set_seed(config["seed"])
    tokenizer_revision = config.get("tokenizer_revision", config.get("model_revision"))
    tokenizer = AutoTokenizer.from_pretrained(config["base_model"], revision=tokenizer_revision)
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        config["base_model"],
        revision=config.get("model_revision"),
        device_map={"": torch.cuda.current_device()},
        torch_dtype=torch.bfloat16,
        quantization_config=quantization,
    )
    model.config.use_cache = False

    train_ds = Dataset.from_list([{"text": _example_text(row)} for row in splits["train"]])
    validation_ds = Dataset.from_list([{"text": _example_text(row)} for row in splits["validation"]])
    test_ds = Dataset.from_list([{"text": _example_text(row)} for row in splits["test"]])
    lora = LoraConfig(
        r=config["lora_r"],
        lora_alpha=config["lora_alpha"],
        lora_dropout=config["lora_dropout"],
        target_modules=config["lora_target_modules"],
        task_type="CAUSAL_LM",
    )
    training_args = SFTConfig(
        output_dir=str(output_dir),
        seed=config["seed"],
        data_seed=config["seed"],
        num_train_epochs=config["num_train_epochs"],
        per_device_train_batch_size=config["per_device_train_batch_size"],
        per_device_eval_batch_size=config.get("per_device_eval_batch_size", 1),
        gradient_accumulation_steps=config["gradient_accumulation_steps"],
        learning_rate=config["learning_rate"],
        warmup_steps=math.ceil(dataset_report["estimated_optimizer_steps"] * config["warmup_ratio"]),
        weight_decay=config["weight_decay"],
        lr_scheduler_type=config["lr_scheduler_type"],
        optim=config["optim"],
        logging_steps=config["logging_steps"],
        eval_strategy=config["eval_strategy"],
        eval_steps=config["eval_steps"],
        save_strategy=config["save_strategy"],
        save_steps=config["save_steps"],
        save_total_limit=config["save_total_limit"],
        load_best_model_at_end=config["load_best_model_at_end"],
        metric_for_best_model=config["metric_for_best_model"],
        greater_is_better=config["greater_is_better"],
        bf16=config["bf16"],
        gradient_checkpointing=config["gradient_checkpointing"],
        include_num_input_tokens_seen=config.get("include_num_input_tokens_seen", True),
        report_to="none",
        max_length=config["max_seq_length"],
        dataset_text_field="text",
    )

    class AtomicCheckpointCallback(TrainerCallback):
        def on_save(self, args: Any, state: Any, control: Any, **kwargs: Any) -> Any:
            del kwargs
            active_dist = torch.distributed.is_available() and torch.distributed.is_initialized()
            if active_dist:
                torch.distributed.barrier()
            outcome: list[str | None] = [None]
            if state.is_world_process_zero:
                checkpoint = Path(args.output_dir) / f"checkpoint-{state.global_step}"
                try:
                    write_checkpoint_complete_marker(checkpoint, int(args.world_size))
                except Exception as exc:
                    outcome[0] = f"checkpoint {checkpoint} failed completion validation: {type(exc).__name__}: {exc}"
            if active_dist:
                torch.distributed.broadcast_object_list(outcome, src=0)
            if outcome[0]:
                raise RuntimeError(outcome[0])
            return control

    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=validation_ds,
        peft_config=lora,
        processing_class=tokenizer,
        callbacks=[AtomicCheckpointCallback()],
    )

    distributed = torch.distributed.is_available() and torch.distributed.is_initialized()
    if resume:
        quarantine_error: list[str | None] = [None]
        if not distributed or torch.distributed.get_rank() == 0:
            try:
                moved = quarantine_incomplete_checkpoints(output_dir, world_size)
                if moved:
                    print("quarantined incomplete checkpoints:", ", ".join(str(path) for path in moved), flush=True)
            except Exception as exc:
                quarantine_error[0] = f"could not preserve incomplete checkpoints before resume: {exc}"
        if distributed:
            torch.distributed.broadcast_object_list(quarantine_error, src=0)
        if quarantine_error[0]:
            raise SystemExit(quarantine_error[0])
        if distributed:
            torch.distributed.barrier()

    output_dir.mkdir(parents=True, exist_ok=True)
    event_path = output_dir / "training_events.jsonl"
    start_time = _utc_now()
    started_at = time.monotonic()
    hardware = {"visible_devices": gpu_devices}
    if not distributed or torch.distributed.get_rank() == 0:
        hardware["runtime"] = _runtime_environment(torch)
    torch.cuda.reset_peak_memory_stats()
    if not distributed or torch.distributed.get_rank() == 0:
        _append_event(event_path, {"event": "resumed" if resume else "started", "checkpoint": str(last_checkpoint) if last_checkpoint else None, "git_commit": config.get("git_commit"), "hardware_profile": config["hardware_profile"]})
    try:
        train_output = trainer.train(resume_from_checkpoint=str(last_checkpoint) if resume else None)
        test_metrics = trainer.evaluate(eval_dataset=test_ds, metric_key_prefix="test")
        observed_losses = {
            "train_loss": train_output.metrics.get("train_loss"),
            "test_loss": test_metrics.get("test_loss"),
            "eval_loss": trainer.state.best_metric,
        }
        for name, value in observed_losses.items():
            if value is not None and not math.isfinite(float(value)):
                raise ValueError(f"non-finite {name}: {value}")
        trainer.save_model(str(output_dir))
        if not distributed or torch.distributed.get_rank() == 0:
            tokenizer.save_pretrained(str(output_dir))
    except KeyboardInterrupt:
        if not distributed or torch.distributed.get_rank() == 0:
            _append_event(event_path, {"event": "interrupted", "global_step": trainer.state.global_step})
        raise
    except Exception as exc:
        if not distributed or torch.distributed.get_rank() == 0:
            _append_event(event_path, {"event": "failed", "error_type": type(exc).__name__, "error": str(exc), "global_step": trainer.state.global_step})
        raise

    elapsed = time.monotonic() - started_at
    end_time = _utc_now()
    train_metrics = dict(train_output.metrics)
    train_metrics.update(test_metrics)
    run_report = {
        "status": "completed",
        "start_time": start_time,
        "end_time": end_time,
        "duration_seconds": round(elapsed, 3),
        "global_step": trainer.state.global_step,
        "best_model_checkpoint": trainer.state.best_model_checkpoint,
        "best_metric": trainer.state.best_metric,
        "train_and_test_metrics": train_metrics,
        "log_history": trainer.state.log_history,
        "hardware": hardware,
        "hardware_profile": config["hardware_profile"],
        "effective_global_batch_size": config["effective_global_batch_size"],
        "peak_gpu_memory_allocated_bytes": torch.cuda.max_memory_allocated(),
        "peak_gpu_memory_reserved_bytes": torch.cuda.max_memory_reserved(),
        "adapter_size_bytes": sum(path.stat().st_size for path in output_dir.glob("adapter_model.*") if path.is_file()),
        "dataset": dataset_report,
        "model": {
            "name": config["base_model"],
            "revision": config.get("model_revision"),
            "tokenizer_revision": tokenizer_revision,
        },
        "training_config": config,
    }
    if not distributed or torch.distributed.get_rank() == 0:
        run_path = output_dir / "training_run.json"
        run_path.write_text(json.dumps(run_report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        (output_dir / "training_config.json").write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        _append_event(event_path, {"event": "completed", "global_step": trainer.state.global_step, "duration_seconds": round(elapsed, 3), "best_model_checkpoint": trainer.state.best_model_checkpoint})
        print(json.dumps({"training_run": str(run_path), "status": "completed", "global_step": trainer.state.global_step, "best_model_checkpoint": trainer.state.best_model_checkpoint, "train_and_test_metrics": train_metrics, "peak_gpu_memory_allocated_bytes": run_report["peak_gpu_memory_allocated_bytes"]}, indent=2, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--dry-run", action="store_true", help="validate frozen data and tokenize a tiny sample without loading model weights")
    parser.add_argument("--dry-run-examples", type=int, default=2, help="number of examples from each training/validation split to inspect")
    parser.add_argument("--skip-tokenizer", action="store_true", help="skip tokenizer loading during --dry-run")
    parser.add_argument("--token-stats", action="store_true", help="measure token lengths and target retention for every split")
    parser.add_argument("--hardware-profile", default="RTX3090_SINGLE", help="execution-only profile from configs/hardware/nvidia_profiles.toml")
    parser.add_argument("--resume", action="store_true", help="resume from the latest valid Trainer checkpoint in output_dir")
    args = parser.parse_args()
    if args.dry_run_examples < 1:
        parser.error("--dry-run-examples must be positive")
    if args.token_stats and args.skip_tokenizer:
        parser.error("--token-stats requires the tokenizer; remove --skip-tokenizer")

    import tomllib

    config_path = _project_path(args.config)
    with config_path.open("rb") as handle:
        config = tomllib.load(handle)
    try:
        profile = load_hardware_profile(args.hardware_profile, ROOT / "configs" / "hardware" / "nvidia_profiles.toml")
        config = apply_hardware_profile(config, profile)
    except (OSError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc
    config["_hardware_profile"] = profile
    splits, dataset_report = _load_data(config, int(profile["world_size"]))
    if args.dry_run:
        return _dry_run(config, splits, dataset_report, args.dry_run_examples, args.skip_tokenizer, args.token_stats)
    return _run_training(config, splits, dataset_report, args.resume)


if __name__ == "__main__":
    raise SystemExit(main())
