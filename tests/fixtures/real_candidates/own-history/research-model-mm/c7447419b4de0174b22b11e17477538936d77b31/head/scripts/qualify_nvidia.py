"""Run an execution-only QLoRA hardware qualification in an isolated artifact tree."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import platform
import random
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from research_model.training.checkpoints import (
    validate_checkpoint,
    write_checkpoint_complete_marker,
)
from research_model.training.profiles import apply_hardware_profile, load_hardware_profile, validate_visible_gpus
from train_transformers import _example_text, _load_data, _tokenizer_lengths


DEFAULT_CONFIG = "configs/training/qwen3_8b_v0.1_qlora.toml"
PROFILE_PATH = ROOT / "configs" / "hardware" / "nvidia_profiles.toml"
QUALIFICATION_ROOT = ROOT / "outputs" / "hardware-qualification" / "E014"
FIRST_STAGE_STEP = 10
FINAL_STAGE_STEP = 20
CHECKPOINT_INTERVAL = 5
SAMPLE_COUNT = FIRST_STAGE_STEP * 16
MINIMUM_FREE_DISK_BYTES = 40_000_000_000


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_recipe(config_path: str, profile_name: str) -> tuple[dict[str, Any], dict[str, Any]]:
    import tomllib

    resolved = Path(config_path)
    if not resolved.is_absolute():
        resolved = ROOT / resolved
    with resolved.open("rb") as handle:
        raw_config = tomllib.load(handle)
    profile = load_hardware_profile(profile_name, PROFILE_PATH)
    config = apply_hardware_profile(raw_config, profile)
    config["_hardware_profile"] = profile
    return config, profile


def _host_preflight(profile: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        import torch
    except ImportError as exc:
        raise SystemExit("ML dependencies are missing; run `uv sync --extra ml --locked` first") from exc
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is unavailable on this host; no qualification artifacts or model downloads were started")
    if not torch.cuda.is_bf16_supported():
        raise SystemExit("the frozen QLoRA recipe requires a BF16-capable NVIDIA GPU")
    if shutil.which("nvidia-smi") is None:
        raise SystemExit("nvidia-smi is required for qualification telemetry")
    try:
        devices = validate_visible_gpus(torch, profile, int(profile["world_size"]))
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from exc

    cache_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")).expanduser()
    for label, target in (("model cache", cache_home), ("project output", ROOT / "outputs")):
        probe = target
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        if shutil.disk_usage(probe).free < MINIMUM_FREE_DISK_BYTES:
            raise SystemExit(
                f"at least {MINIMUM_FREE_DISK_BYTES / 1e9:.0f} GB free is required on the {label} filesystem"
            )
    return devices


def _nvidia_smi_rows() -> list[dict[str, Any]]:
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu",
            "--format=csv,noheader,nounits",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    rows = []
    for row in csv.reader(result.stdout.splitlines(), skipinitialspace=True):
        if len(row) != 5:
            continue
        rows.append({
            "name": row[0],
            "memory_used_mib": _parse_number(row[1]),
            "memory_total_mib": _parse_number(row[2]),
            "gpu_utilization_percent": _parse_number(row[3]),
            "temperature_celsius": _parse_number(row[4]),
        })
    return rows


def _parse_number(value: str) -> int | float | None:
    try:
        number = float(value.strip())
    except ValueError:
        return None
    return int(number) if number.is_integer() else number


def _fixed_length_collator(tokenizer: Any, sequence_length: int):
    """Pad every qualification batch to the exact memory-test length, masking pad loss."""

    import torch

    def collate(features: list[dict[str, Any]]) -> dict[str, Any]:
        model_features = [
            {key: feature[key] for key in ("input_ids", "attention_mask") if key in feature}
            for feature in features
        ]
        if any(len(feature["input_ids"]) > sequence_length for feature in model_features):
            raise ValueError("qualification sample exceeds the frozen sequence-length cap")
        batch = tokenizer.pad(
            model_features,
            padding="max_length",
            max_length=sequence_length,
            return_tensors="pt",
        )
        if batch["input_ids"].shape[-1] != sequence_length:
            raise ValueError("qualification collator did not produce the exact padded sequence length")
        labels = batch["input_ids"].clone()
        labels[batch["attention_mask"] == 0] = -100
        batch["labels"] = labels
        return batch

    return collate


def _monitor_child(command: list[str], run_dir: Path) -> None:
    log_path = run_dir / f"{command[command.index('--worker-phase') + 1]}_phase.log"
    telemetry_path = run_dir / "gpu_telemetry.jsonl"
    with log_path.open("w", encoding="utf-8") as log_handle:
        process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

        def consume_output() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                log_handle.write(line)
                log_handle.flush()
                print(line, end="", flush=True)

        output_thread = threading.Thread(target=consume_output, daemon=True)
        output_thread.start()
        with telemetry_path.open("a", encoding="utf-8") as telemetry:
            while process.poll() is None:
                try:
                    telemetry.write(json.dumps({"timestamp": _now(), "devices": _nvidia_smi_rows()}) + "\n")
                    telemetry.flush()
                except (OSError, subprocess.SubprocessError):
                    telemetry.write(json.dumps({"timestamp": _now(), "error": "nvidia-smi telemetry sample failed"}) + "\n")
                    telemetry.flush()
                time.sleep(2)
        return_code = process.wait()
        output_thread.join(timeout=10)
    if return_code:
        raise RuntimeError(f"qualification child exited with status {return_code}; inspect {log_path}")


def _run_worker(command: list[str], run_dir: Path) -> None:
    _monitor_child(command, run_dir)


def _qualification_command(profile: dict[str, Any], phase: str, run_dir: Path, config_path: str) -> list[str]:
    return [
        sys.executable,
        "-m",
        "torch.distributed.run",
        "--standalone",
        f"--nproc_per_node={profile['world_size']}",
        str(Path(__file__).resolve()),
        "--worker-phase",
        phase,
        "--profile",
        profile["name"],
        "--run-dir",
        str(run_dir),
        "--config",
        config_path,
    ]


def _qualification_parent(args: argparse.Namespace) -> int:
    config, profile = _load_recipe(args.config, args.profile)
    devices = _host_preflight(profile)
    splits, dataset_report = _load_data(config, int(profile["world_size"]))
    del splits
    if args.check_only:
        print(json.dumps({"status": "ready_for_qualification", "profile": profile["name"], "dataset": dataset_report}, indent=2))
        return 0

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
    run_dir = QUALIFICATION_ROOT / profile["name"] / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    try:
        git_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except (OSError, subprocess.SubprocessError):
        git_commit = None
    start_time = time.monotonic()
    start_record = {
        "status": "running",
        "started_at": _now(),
        "run_id": run_id,
        "git_commit": git_commit,
        "profile": profile,
        "devices": devices,
        "host": {
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "python": platform.python_version(),
            "system_memory_bytes": (
                os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
                if hasattr(os, "sysconf") and hasattr(os, "sysconf_names") and "SC_PHYS_PAGES" in os.sysconf_names
                else None
            ),
            "process_peak_rss_bytes_per_worker": "recorded in phase JSON",
        },
        "model": config["base_model"],
        "model_revision": config["model_revision"],
        "tokenizer_revision": config["tokenizer_revision"],
        "dataset": dataset_report,
        "output_scope": str(run_dir.relative_to(ROOT)),
        "model_quality_evaluation_performed": False,
        "test_split_used": False,
        "test_split_evaluated": False,
    }
    _atomic_json(run_dir / "qualification_started.json", start_record)
    try:
        _run_worker(_qualification_command(profile, "first", run_dir, args.config), run_dir)
        _run_worker(_qualification_command(profile, "resume", run_dir, args.config), run_dir)

        selection = json.loads((run_dir / "selected_training_examples.json").read_text(encoding="utf-8"))
        first = json.loads((run_dir / "first_phase.json").read_text(encoding="utf-8"))
        resumed = json.loads((run_dir / "resume_phase.json").read_text(encoding="utf-8"))
        checkpoint10 = run_dir / "checkpoint-10"
        checkpoint20 = run_dir / "checkpoint-20"
        if first["global_step"] != FIRST_STAGE_STEP or resumed["global_step"] != FINAL_STAGE_STEP:
            raise RuntimeError("qualification did not reach the required 10-step save and 20-step resumed state")
        if not validate_checkpoint(checkpoint10, int(profile["world_size"])):
            raise RuntimeError("step-10 checkpoint failed marker/files/optimizer/RNG validation")
        if not validate_checkpoint(checkpoint20, int(profile["world_size"])):
            raise RuntimeError("step-20 checkpoint failed marker/files/optimizer/RNG validation")

        checkpoint_weights = next(iter(sorted(checkpoint10.glob("adapter_model.*"))))
        final_weights = next(iter(sorted(run_dir.glob("adapter_model.*"))))
        checkpoint_hash = _sha256(checkpoint_weights)
        final_hash = _sha256(final_weights)
        if checkpoint_hash == final_hash:
            raise RuntimeError("adapter weights did not change after loading checkpoint-10 and resuming to step 20")

        telemetry = []
        telemetry_path = run_dir / "gpu_telemetry.jsonl"
        if telemetry_path.exists():
            telemetry = [json.loads(line) for line in telemetry_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        device_count = int(profile["world_size"])
        telemetry_peak_used = []
        telemetry_peak_util = []
        telemetry_peak_temp = []
        for index in range(device_count):
            samples = [sample["devices"][index] for sample in telemetry if isinstance(sample.get("devices"), list) and len(sample["devices"]) > index]
            telemetry_peak_used.append(max((row["memory_used_mib"] for row in samples if row.get("memory_used_mib") is not None), default=None))
            telemetry_peak_util.append(max((row["gpu_utilization_percent"] for row in samples if row.get("gpu_utilization_percent") is not None), default=None))
            telemetry_peak_temp.append(max((row["temperature_celsius"] for row in samples if row.get("temperature_celsius") is not None), default=None))

        optimizer_seconds = float(first.get("train_runtime_seconds", 0)) + float(resumed.get("train_runtime_seconds", 0))
        token_total = int(sum(selection["token_lengths"]))
        tokens_per_second = token_total / optimizer_seconds if optimizer_seconds > 0 else None
        report = {
            **start_record,
            "status": "passed",
            "finished_at": _now(),
            "qualification_wall_seconds": round(time.monotonic() - start_time, 3),
            "optimizer_runtime_seconds": round(optimizer_seconds, 3),
            "steps": {"before_restart": first["global_step"], "after_fresh_process_resume": resumed["global_step"]},
            "save_load_resume": {
                "checkpoint_10_valid": True,
                "checkpoint_20_valid": True,
                "resume_process_restarted": True,
                "optimizer_and_scheduler_state_required": True,
                "adapter_weights_changed_after_resume": True,
                "checkpoint_10_adapter_sha256": checkpoint_hash,
                "step_20_adapter_sha256": final_hash,
            },
            "workload": {
                "model_quality_evaluation_performed": False,
                "test_split_used": False,
                "test_split_evaluated": False,
                "unique_train_examples": len(selection["example_ids"]),
                "effective_global_batch_size": profile["effective_global_batch_size"],
                "max_sequence_length": profile["max_sequence_length"],
                "padded_forward_sequence_length": profile["max_sequence_length"],
                "selected_min_tokens": min(selection["token_lengths"]),
                "selected_max_tokens": max(selection["token_lengths"]),
                "selected_total_tokens": token_total,
                "selected_examples_sha256": selection["selection_sha256"],
            },
            "measured_optimization_tokens_per_second": round(tokens_per_second, 3) if tokens_per_second is not None else None,
            "per_rank_peak_memory": resumed["per_rank_peak_memory"],
            "nvidia_smi_peak_memory_used_mib_by_gpu": telemetry_peak_used,
            "nvidia_smi_peak_utilization_percent_by_gpu": telemetry_peak_util,
            "nvidia_smi_peak_temperature_celsius_by_gpu": telemetry_peak_temp,
            "artifacts": {
                "report": str((run_dir / "qualification_report.json").relative_to(ROOT)),
                "telemetry": str(telemetry_path.relative_to(ROOT)),
                "phase_logs": [str((run_dir / "first_phase.log").relative_to(ROOT)), str((run_dir / "resume_phase.log").relative_to(ROOT))],
                "final_adapter": str(final_weights.relative_to(ROOT)),
            },
        }
        _atomic_json(run_dir / "qualification_report.json", report)
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    except Exception as exc:
        failure = {
            **start_record,
            "status": "failed",
            "finished_at": _now(),
            "qualification_wall_seconds": round(time.monotonic() - start_time, 3),
            "error_type": type(exc).__name__,
            "error": str(exc),
            "model_quality_evaluation_performed": False,
        }
        _atomic_json(run_dir / "qualification_report.json", failure)
        print(json.dumps(failure, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1


def _rank_peak_memory(torch: Any) -> dict[str, Any]:
    device = torch.cuda.current_device()
    return {
        "rank": int(os.environ.get("RANK", "0")),
        "local_rank": device,
        "name": torch.cuda.get_device_name(device),
        "peak_allocated_bytes": int(torch.cuda.max_memory_allocated(device)),
        "peak_reserved_bytes": int(torch.cuda.max_memory_reserved(device)),
    }


def _process_peak_rss_bytes() -> int | None:
    try:
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(peak * (1024 if platform.system() != "Darwin" else 1))
    except (ImportError, OSError, ValueError):
        return None


def _worker(args: argparse.Namespace) -> int:
    import tomllib

    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainerCallback, set_seed
    from trl import SFTConfig, SFTTrainer

    config, profile = _load_recipe(args.config, args.profile)
    world_size = int(os.environ.get("WORLD_SIZE", "1"))
    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    rank = int(os.environ.get("RANK", "0"))
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise SystemExit("worker requires a BF16-capable CUDA device")
    torch.cuda.set_device(local_rank)
    validate_visible_gpus(torch, profile, world_size)

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = ROOT / config_path
    with config_path.open("rb") as handle:
        raw_config = tomllib.load(handle)
    splits, dataset_report = _load_data(config, world_size)
    train_rows = splits["train"]
    run_dir = Path(args.run_dir)
    selection_path = run_dir / "selected_training_examples.json"

    tokenizer = AutoTokenizer.from_pretrained(
        config["base_model"],
        revision=config["tokenizer_revision"],
    )
    if tokenizer.pad_token_id is None:
        if tokenizer.eos_token is None:
            raise SystemExit("qualification requires a tokenizer pad token or EOS token")
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    if args.worker_phase == "first":
        texts = [_example_text(row) for row in train_rows]
        all_lengths: list[int] = []
        for offset in range(0, len(texts), 32):
            all_lengths.extend(_tokenizer_lengths(tokenizer, texts[offset : offset + 32]))
        ranked = sorted(
            zip(train_rows, all_lengths),
            key=lambda pair: (-pair[1], str(pair[0].get("example_id", ""))),
        )[:SAMPLE_COUNT]
        if len(ranked) != SAMPLE_COUNT:
            raise SystemExit(f"qualification needs {SAMPLE_COUNT} unique training rows, found {len(ranked)}")
        if max(length for _, length in ranked) > config["max_seq_length"]:
            raise SystemExit("selected training example exceeds the preregistered 4608-token limit")
        if max(length for _, length in ranked) < 4000:
            raise SystemExit("qualification selection did not include a genuinely long sequence (>=4000 tokens)")
        example_ids = [str(row["example_id"]) for row, _ in ranked]
        if len(set(example_ids)) != SAMPLE_COUNT:
            raise SystemExit("training example_id values are not unique in the qualification selection")
        token_lengths = [int(length) for _, length in ranked]
        selection_body = {
            "selection_policy": "top 320 longest tokenized examples from frozen train split only; unique example_id; no validation/test rows",
            "dataset_file_sha256": dataset_report["file_sha256"],
            "model_revision": config["model_revision"],
            "max_sequence_length": config["max_seq_length"],
            "example_ids": example_ids,
            "token_lengths": token_lengths,
        }
        selection_body["selection_sha256"] = hashlib.sha256(
            json.dumps(selection_body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        if rank == 0:
            _atomic_json(selection_path, selection_body)
    else:
        selection_body = json.loads(selection_path.read_text(encoding="utf-8"))
        if selection_body["dataset_file_sha256"] != dataset_report["file_sha256"]:
            raise SystemExit("qualification selection is for a different frozen dataset file")
        if selection_body["model_revision"] != config["model_revision"]:
            raise SystemExit("qualification selection is for a different base model revision")

    rows_by_id = {str(row.get("example_id")): row for row in train_rows}
    try:
        selected_rows = [rows_by_id[example_id] for example_id in selection_body["example_ids"]]
    except KeyError as exc:
        raise SystemExit(f"qualification selection references an unknown train example id: {exc}") from exc
    train_ds = Dataset.from_list([{"text": _example_text(row)} for row in selected_rows])

    torch.manual_seed(config["seed"])
    random.seed(config["seed"])
    set_seed(config["seed"])
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        config["base_model"],
        revision=config["model_revision"],
        device_map={"": torch.cuda.current_device()},
        torch_dtype=torch.bfloat16,
        quantization_config=quantization,
    )
    model.config.use_cache = False
    lora = LoraConfig(
        r=config["lora_r"],
        lora_alpha=config["lora_alpha"],
        lora_dropout=config["lora_dropout"],
        target_modules=config["lora_target_modules"],
        task_type="CAUSAL_LM",
    )

    class AtomicCheckpointCallback(TrainerCallback):
        def on_save(self, callback_args: Any, state: Any, control: Any, **kwargs: Any) -> Any:
            del kwargs
            active_dist = torch.distributed.is_available() and torch.distributed.is_initialized()
            if active_dist:
                torch.distributed.barrier()
            result: list[str | None] = [None]
            if state.is_world_process_zero:
                checkpoint = Path(callback_args.output_dir) / f"checkpoint-{state.global_step}"
                try:
                    write_checkpoint_complete_marker(checkpoint, int(callback_args.world_size))
                except Exception as exc:
                    result[0] = f"checkpoint {checkpoint} completion failed: {type(exc).__name__}: {exc}"
            if active_dist:
                torch.distributed.broadcast_object_list(result, src=0)
            if result[0]:
                raise RuntimeError(result[0])
            return control

    target_step = FIRST_STAGE_STEP if args.worker_phase == "first" else FINAL_STAGE_STEP
    training_args = SFTConfig(
        output_dir=str(run_dir),
        seed=config["seed"],
        data_seed=config["seed"],
        num_train_epochs=1,
        max_steps=target_step,
        per_device_train_batch_size=config["per_device_train_batch_size"],
        gradient_accumulation_steps=config["gradient_accumulation_steps"],
        learning_rate=config["learning_rate"],
        warmup_steps=0,
        weight_decay=config["weight_decay"],
        lr_scheduler_type=config["lr_scheduler_type"],
        optim=config["optim"],
        logging_steps=1,
        eval_strategy="no",
        save_strategy="steps",
        save_steps=CHECKPOINT_INTERVAL,
        save_total_limit=10,
        bf16=True,
        gradient_checkpointing=True,
        include_num_input_tokens_seen=True,
        report_to="none",
        max_length=config["max_seq_length"],
        dataset_text_field="text",
    )
    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        peft_config=lora,
        processing_class=tokenizer,
        data_collator=_fixed_length_collator(tokenizer, int(config["max_seq_length"])),
        callbacks=[AtomicCheckpointCallback()],
    )

    resume_checkpoint: Path | None = None
    if args.worker_phase == "resume":
        resume_checkpoint = run_dir / f"checkpoint-{FIRST_STAGE_STEP}"
        if not validate_checkpoint(resume_checkpoint, world_size):
            raise SystemExit(f"step-{FIRST_STAGE_STEP} checkpoint is not complete and validated")
    started = time.monotonic()
    output = trainer.train(resume_from_checkpoint=str(resume_checkpoint) if resume_checkpoint else None)
    runtime_seconds = float(output.metrics.get("train_runtime", time.monotonic() - started))
    if int(trainer.state.global_step) != target_step:
        raise RuntimeError(f"expected global step {target_step}, received {trainer.state.global_step}")

    checkpoint_dir = run_dir / f"checkpoint-{target_step}"
    if not validate_checkpoint(checkpoint_dir, world_size):
        raise RuntimeError(f"step-{target_step} checkpoint is not complete after train()")
    if args.worker_phase == "resume":
        trainer.save_model(str(run_dir))
        if rank == 0:
            tokenizer.save_pretrained(str(run_dir))

    local_memory = _rank_peak_memory(torch)
    memory_by_rank: list[dict[str, Any] | None] = [local_memory]
    if torch.distributed.is_available() and torch.distributed.is_initialized():
        memory_by_rank = [None] * world_size
        torch.distributed.all_gather_object(memory_by_rank, local_memory)
    if rank == 0:
        phase_record = {
            "phase": args.worker_phase,
            "global_step": int(trainer.state.global_step),
            "train_runtime_seconds": runtime_seconds,
            "train_metrics": output.metrics,
            "log_history": trainer.state.log_history,
            "per_rank_peak_memory": memory_by_rank,
            "process_peak_rss_bytes": _process_peak_rss_bytes(),
            "checkpoint": str(checkpoint_dir.relative_to(ROOT)),
            "checkpoint_marker_valid": True,
            "optimizer_file_bytes": (checkpoint_dir / "optimizer.pt").stat().st_size,
            "scheduler_file_bytes": (checkpoint_dir / "scheduler.pt").stat().st_size,
            "dataset_sha256": dataset_report["file_sha256"],
            "raw_config": raw_config,
        }
        _atomic_json(run_dir / f"{args.worker_phase}_phase.json", phase_record)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, help="NVIDIA profile from configs/hardware/nvidia_profiles.toml")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--check-only", action="store_true", help="check target CUDA device and frozen data without downloading model weights")
    parser.add_argument("--worker-phase", choices=["first", "resume"], help=argparse.SUPPRESS)
    parser.add_argument("--run-dir", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker_phase:
        if not args.run_dir:
            parser.error("--run-dir is required for internal qualification worker phases")
        return _worker(args)
    return _qualification_parent(args)


if __name__ == "__main__":
    raise SystemExit(main())
