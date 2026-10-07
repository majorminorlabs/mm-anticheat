"""Execution-only MI300X/ROCm smoke test for the frozen E014 QLoRA path."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import random
import shutil
import subprocess
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "src", ROOT / "scripts"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from research_model.training.checkpoints import validate_checkpoint, write_checkpoint_complete_marker
from train_transformers import _example_text, _load_data, _tokenizer_lengths
from validate_e014_invariants import DEFAULT_INVARIANTS, validate as validate_invariants

DEFAULT_CONFIG = "configs/training/qwen3_8b_v0.1_qlora.toml"
QUALIFICATION_ROOT = ROOT / "outputs/hardware-qualification/E014/AMD_MI300X"
SAMPLE_COUNT = 96
FIRST_STAGE_STEP = 3
FINAL_STAGE_STEP = 6
CHECKPOINT_INTERVAL = 3
MINIMUM_FREE_DISK_BYTES = 40_000_000_000
MINIMUM_HOST_RAM_BYTES = 64 * 1024**3
MINIMUM_GPU_MEMORY_BYTES = 170 * 1024**3
PINNED_PACKAGES = {
    "transformers": "5.17.0",
    "peft": "0.21.0",
    "trl": "1.13.0",
    "bitsandbytes": "0.50.2",
    "accelerate": "1.15.0",
    "datasets": "5.0.1",
}


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


def _append_event(path: Path, event: str, **fields: Any) -> None:
    """Append one UTC event without making the qualification timeline mutable in place."""

    record = {"timestamp_utc": _now(), "event": event, **fields}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def _tree_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
        except OSError:
            continue
    return total


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_config(config_path: str) -> dict[str, Any]:
    import tomllib

    path = Path(config_path)
    if not path.is_absolute():
        path = ROOT / path
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _host_memory_bytes() -> int | None:
    try:
        return int(os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"))
    except (AttributeError, OSError, ValueError):
        return None


def _runtime_environment(torch: Any) -> dict[str, Any]:
    index = int(torch.cuda.current_device())
    props = torch.cuda.get_device_properties(index)
    free_bytes, total_bytes = torch.cuda.mem_get_info(index)
    package_names = ("torch", *PINNED_PACKAGES.keys())
    arch = getattr(props, "gcnArchName", None)
    return {
        "host": {
            "platform": platform.platform(),
            "architecture": platform.machine(),
            "python": platform.python_version(),
            "ram_bytes": _host_memory_bytes(),
            "disk_free_bytes": shutil.disk_usage(ROOT).free,
        },
        "gpu": {
            "name": str(props.name),
            "architecture": arch,
            "visible_gpu_count": int(torch.cuda.device_count()),
            "hbm_total_bytes": int(props.total_memory),
            "hbm_free_bytes_at_sample": int(free_bytes),
            "reported_total_bytes_at_sample": int(total_bytes),
            "bf16_supported": bool(torch.cuda.is_bf16_supported()),
        },
        "software": {
            "python": platform.python_version(),
            "torch_version": str(torch.__version__),
            "torch_hip_version": torch.version.hip,
            "torch_cuda_version": torch.version.cuda,
            "packages": {name: _package_version(name) for name in package_names},
        },
    }


def _host_preflight() -> tuple[Any, dict[str, Any]]:
    if platform.system() != "Linux" or platform.machine().lower() not in {"x86_64", "amd64"}:
        raise SystemExit("AMD qualification requires Linux x86_64; no output directory or model download was started")
    if platform.python_version_tuple()[:2] != ("3", "13"):
        raise SystemExit("E014 AMD qualification requires the frozen Python 3.13 environment")
    try:
        import torch
    except ImportError as exc:
        raise SystemExit("PyTorch is missing; prepare the pinned ROCm environment before qualification") from exc

    if not torch.version.hip:
        raise SystemExit("this PyTorch build is not ROCm/HIP-enabled; no model download was started")
    if not str(torch.__version__).split("+", 1)[0] == "2.14.0":
        raise SystemExit(f"expected PyTorch 2.14.0 ROCm wheel, found {torch.__version__}")
    if not str(torch.version.hip).startswith("7.14"):
        raise SystemExit(f"expected PyTorch ROCm 7.14 build, found HIP runtime {torch.version.hip}")
    for package, expected in PINNED_PACKAGES.items():
        actual = _package_version(package)
        if actual != expected:
            raise SystemExit(f"expected pinned {package} {expected}, found {actual}")
    if not torch.cuda.is_available():
        raise SystemExit("ROCm PyTorch cannot see a GPU; no model download was started")
    if int(torch.cuda.device_count()) != 1:
        raise SystemExit(f"MI300X smoke requires exactly one visible GPU, found {torch.cuda.device_count()}")
    torch.cuda.set_device(0)
    if not torch.cuda.is_bf16_supported():
        raise SystemExit("the frozen E014 recipe requires BF16 support")

    props = torch.cuda.get_device_properties(0)
    if "mi300x" not in str(props.name).casefold():
        raise SystemExit(f"expected one MI300X, found {props.name!r}")
    if int(props.total_memory) < MINIMUM_GPU_MEMORY_BYTES:
        raise SystemExit(
            f"expected at least {MINIMUM_GPU_MEMORY_BYTES / 1024**3:.0f} GiB visible HBM, "
            f"found {int(props.total_memory) / 1024**3:.1f} GiB"
        )
    ram_bytes = _host_memory_bytes()
    if ram_bytes is not None and ram_bytes < MINIMUM_HOST_RAM_BYTES:
        raise SystemExit("at least 64 GiB host RAM is required for the qualification workload")

    cache_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface")).expanduser()
    for label, target in (("Hugging Face cache", cache_home), ("qualification output", QUALIFICATION_ROOT)):
        probe = target
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        if shutil.disk_usage(probe).free < MINIMUM_FREE_DISK_BYTES:
            raise SystemExit(f"at least 40 GB free disk is required on the {label} filesystem")
    return torch, _runtime_environment(torch)


def _fixed_length_collator(tokenizer: Any, sequence_length: int):
    """Pad each smoke batch to E014's full sequence length and ignore padding in loss."""

    import torch

    def collate(features: list[dict[str, Any]]) -> dict[str, Any]:
        model_features = [
            {key: feature[key] for key in ("input_ids", "attention_mask") if key in feature}
            for feature in features
        ]
        if any(len(feature["input_ids"]) > sequence_length for feature in model_features):
            raise ValueError("qualification sample exceeds E014's frozen sequence-length cap")
        batch = tokenizer.pad(
            model_features,
            padding="max_length",
            max_length=sequence_length,
            return_tensors="pt",
        )
        if batch["input_ids"].shape[-1] != sequence_length:
            raise ValueError("qualification collator did not produce the exact frozen sequence length")
        labels = batch["input_ids"].clone()
        labels[batch["attention_mask"] == 0] = -100
        batch["labels"] = labels
        return batch

    return collate


def _select_examples(
    config: dict[str, Any],
    train_rows: list[dict[str, Any]],
    tokenizer: Any,
    dataset_report: dict[str, Any],
    run_dir: Path,
) -> dict[str, Any]:
    texts = [_example_text(row) for row in train_rows]
    lengths: list[int] = []
    for offset in range(0, len(texts), 32):
        lengths.extend(_tokenizer_lengths(tokenizer, texts[offset:offset + 32]))
    ranked = sorted(
        zip(train_rows, lengths),
        key=lambda pair: (-pair[1], str(pair[0].get("example_id", ""))),
    )[:SAMPLE_COUNT]
    if len(ranked) != SAMPLE_COUNT:
        raise RuntimeError(f"need {SAMPLE_COUNT} unique training rows, found {len(ranked)}")
    if len({str(row["example_id"]) for row, _ in ranked}) != SAMPLE_COUNT:
        raise RuntimeError("qualification sample contains duplicate example_id values")
    if max(length for _, length in ranked) > int(config["max_seq_length"]):
        raise RuntimeError("qualification sample exceeds E014's frozen context length")
    body = {
        "selection_policy": (
            "96 longest tokenized unique examples from frozen train split only; no validation/test rows"
        ),
        "dataset_file_sha256": dataset_report["file_sha256"],
        "model_revision": config["model_revision"],
        "max_sequence_length": config["max_seq_length"],
        "example_ids": [str(row["example_id"]) for row, _ in ranked],
        "token_lengths": [int(length) for _, length in ranked],
    }
    body["selection_sha256"] = hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _atomic_json(run_dir / "selected_training_examples.json", body)
    return body


def _verify_selection(selection: dict[str, Any], dataset_report: dict[str, Any], config: dict[str, Any]) -> None:
    payload = {key: value for key, value in selection.items() if key != "selection_sha256"}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    if digest != selection.get("selection_sha256"):
        raise RuntimeError("qualification selection record hash is invalid")
    if selection.get("dataset_file_sha256") != dataset_report["file_sha256"]:
        raise RuntimeError("qualification selection references a different dataset file")
    if selection.get("model_revision") != config["model_revision"]:
        raise RuntimeError("qualification selection references a different model revision")


def _worker(args: argparse.Namespace) -> int:
    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainerCallback, set_seed
    from trl import SFTConfig, SFTTrainer

    invariant_result = validate_invariants(args.invariants)
    if invariant_result["status"] != "passed":
        raise SystemExit("frozen E014 invariant check failed in worker; see parent log")
    torch, environment = _host_preflight()
    config = _load_config(args.config)
    splits, dataset_report = _load_data(config, world_size=1)
    run_dir = Path(args.run_dir)
    selection_path = run_dir / "selected_training_examples.json"
    timeline_path = run_dir / "timeline.jsonl"

    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always")
        cache_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache/huggingface")).expanduser()
        model_load_started = time.monotonic()
        model_load_started_at_utc = _now()
        cache_bytes_before = _tree_size(cache_home)
        _append_event(
            timeline_path,
            "MODEL_DOWNLOAD_STARTED",
            phase=args.worker_phase,
            model=config["base_model"],
            revision=config["model_revision"],
            cache_path=str(cache_home),
            cache_bytes_before=cache_bytes_before,
        )
        tokenizer = AutoTokenizer.from_pretrained(config["base_model"], revision=config["tokenizer_revision"])
        if tokenizer.pad_token_id is None:
            if tokenizer.eos_token is None:
                raise RuntimeError("qualification requires a tokenizer pad token or EOS token")
            tokenizer.pad_token = tokenizer.eos_token
        tokenizer.padding_side = "right"

        if args.worker_phase == "first":
            selection = _select_examples(config, splits["train"], tokenizer, dataset_report, run_dir)
        else:
            selection = json.loads(selection_path.read_text(encoding="utf-8"))
            _verify_selection(selection, dataset_report, config)

        rows_by_id = {str(row["example_id"]): row for row in splits["train"]}
        selected_rows = [rows_by_id[example_id] for example_id in selection["example_ids"]]
        train_dataset = Dataset.from_list([{"text": _example_text(row)} for row in selected_rows])

        random.seed(int(config["seed"]))
        torch.manual_seed(int(config["seed"]))
        set_seed(int(config["seed"]))
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
        model_load_seconds = time.monotonic() - model_load_started
        cache_bytes_after = _tree_size(cache_home)
        _append_event(
            timeline_path,
            "MODEL_DOWNLOAD_COMPLETED",
            phase=args.worker_phase,
            elapsed_seconds=round(model_load_seconds, 3),
            cache_path=str(cache_home),
            cache_bytes_before=cache_bytes_before,
            cache_bytes_after=cache_bytes_after,
            cache_bytes_delta=cache_bytes_after - cache_bytes_before,
        )
        model.config.use_cache = False

        import bitsandbytes as bnb

        four_bit_modules = [module for module in model.modules() if isinstance(module, bnb.nn.Linear4bit)]
        if not four_bit_modules:
            raise RuntimeError("the model loaded without any bitsandbytes Linear4bit modules")
        quant_states = [getattr(module.weight, "quant_state", None) for module in four_bit_modules]
        if any(state is None for state in quant_states):
            raise RuntimeError("one or more 4-bit modules has no initialized bitsandbytes quantization state")
        quant_types = sorted({str(getattr(state, "quant_type", None)) for state in quant_states})
        if quant_types != ["nf4"]:
            raise RuntimeError(f"expected NF4 quantization state on all 4-bit modules, found {quant_types}")
        nested_values = [getattr(state, "nested", None) for state in quant_states]
        if not all(value is True for value in nested_values):
            raise RuntimeError("double-quantized nested NF4 state was not confirmed on every 4-bit module")

        lora_config = LoraConfig(
            r=int(config["lora_r"]),
            lora_alpha=int(config["lora_alpha"]),
            lora_dropout=float(config["lora_dropout"]),
            target_modules=list(config["lora_target_modules"]),
            task_type="CAUSAL_LM",
        )

        step_durations: list[float] = []

        class StepTimingCallback(TrainerCallback):
            current_step_started: float | None = None

            def on_step_begin(self, callback_args: Any, state: Any, control: Any, **kwargs: Any) -> Any:
                del callback_args, state, control, kwargs
                torch.cuda.synchronize()
                self.current_step_started = time.monotonic()
                return None

            def on_step_end(self, callback_args: Any, state: Any, control: Any, **kwargs: Any) -> Any:
                del callback_args, control, kwargs
                if self.current_step_started is not None:
                    torch.cuda.synchronize()
                    duration = time.monotonic() - self.current_step_started
                    step_durations.append(duration)
                    _append_event(
                        timeline_path,
                        "SMOKE_STEP",
                        phase=args.worker_phase,
                        step=int(state.global_step),
                        duration_seconds=round(duration, 4),
                    )
                return None

        class AtomicCheckpointCallback(TrainerCallback):
            def on_save(self, callback_args: Any, state: Any, control: Any, **kwargs: Any) -> Any:
                del kwargs
                if state.is_world_process_zero:
                    checkpoint = Path(callback_args.output_dir) / f"checkpoint-{state.global_step}"
                    write_checkpoint_complete_marker(checkpoint, world_size=1)
                    _append_event(
                        timeline_path,
                        "CHECKPOINT_SAVED",
                        phase=args.worker_phase,
                        step=int(state.global_step),
                        path=str(checkpoint),
                    )
                return control

        target_step = FIRST_STAGE_STEP if args.worker_phase == "first" else FINAL_STAGE_STEP
        training_args = SFTConfig(
            output_dir=str(run_dir),
            seed=int(config["seed"]),
            data_seed=int(config["seed"]),
            num_train_epochs=1,
            max_steps=target_step,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=int(config["gradient_accumulation_steps"]),
            learning_rate=float(config["learning_rate"]),
            warmup_steps=0,
            weight_decay=float(config["weight_decay"]),
            lr_scheduler_type=config["lr_scheduler_type"],
            optim=config["optim"],
            logging_steps=1,
            eval_strategy="no",
            save_strategy="steps",
            save_steps=CHECKPOINT_INTERVAL,
            save_total_limit=5,
            load_best_model_at_end=False,
            bf16=True,
            gradient_checkpointing=True,
            include_num_input_tokens_seen=True,
            report_to="none",
            max_length=int(config["max_seq_length"]),
            dataset_text_field="text",
        )
        trainer = SFTTrainer(
            model=model,
            args=training_args,
            train_dataset=train_dataset,
            peft_config=lora_config,
            processing_class=tokenizer,
            data_collator=_fixed_length_collator(tokenizer, int(config["max_seq_length"])),
            callbacks=[StepTimingCallback(), AtomicCheckpointCallback()],
        )
        expected_targets = set(config["lora_target_modules"])
        observed_targets = {
            name.rsplit(".", 1)[-1]
            for name, module in trainer.model.named_modules()
            if getattr(module, "lora_A", None) is not None and getattr(module, "lora_B", None) is not None
        }
        if observed_targets != expected_targets:
            raise RuntimeError(
                "LoRA target module mismatch: "
                f"expected {sorted(expected_targets)}, observed {sorted(observed_targets)}"
            )

        resume_checkpoint: Path | None = None
        if args.worker_phase == "resume":
            resume_checkpoint = run_dir / f"checkpoint-{FIRST_STAGE_STEP}"
            if not validate_checkpoint(resume_checkpoint, expected_world_size=1):
                raise RuntimeError("step-3 checkpoint failed marker/files/optimizer/RNG validation")

        torch.cuda.reset_peak_memory_stats()
        started = time.monotonic()
        train_output = trainer.train(resume_from_checkpoint=str(resume_checkpoint) if resume_checkpoint else None)
        runtime_seconds = float(train_output.metrics.get("train_runtime", time.monotonic() - started))
        if int(trainer.state.global_step) != target_step:
            raise RuntimeError(f"expected global step {target_step}, received {trainer.state.global_step}")

        checkpoint = run_dir / f"checkpoint-{target_step}"
        if not validate_checkpoint(checkpoint, expected_world_size=1):
            raise RuntimeError(f"step-{target_step} checkpoint failed completion validation")
        if args.worker_phase == "resume":
            trainer.save_model(str(run_dir))
            tokenizer.save_pretrained(str(run_dir))

        adapter_parameters = [param for param in trainer.model.parameters() if param.requires_grad]
        if not adapter_parameters:
            raise RuntimeError("PEFT installed no trainable LoRA parameters")
        if any(not bool(torch.isfinite(param.detach()).all().item()) for param in adapter_parameters):
            raise RuntimeError("non-finite LoRA adapter parameter detected after optimizer updates")
        optimizer_state_tensors = [
            value
            for state in trainer.optimizer.state.values()
            for value in state.values()
            if torch.is_tensor(value) and value.is_floating_point()
        ]
        if not optimizer_state_tensors:
            raise RuntimeError("optimizer has no floating-point state after the real update steps")
        if any(not bool(torch.isfinite(value).all().item()) for value in optimizer_state_tensors):
            raise RuntimeError("non-finite floating-point optimizer state detected")

        free_hbm, total_hbm = torch.cuda.mem_get_info(0)
        phase_record = {
            "phase": args.worker_phase,
            "global_step": int(trainer.state.global_step),
            "train_runtime_seconds": runtime_seconds,
            "optimizer_step_durations_seconds": [round(value, 4) for value in step_durations],
            "train_metrics": train_output.metrics,
            "model_load": {
                "started_at_utc": model_load_started_at_utc,
                "finished_at_utc": _now(),
                "elapsed_seconds": round(model_load_seconds, 3),
                "cache_path": str(cache_home),
                "cache_bytes_before": cache_bytes_before,
                "cache_bytes_after": cache_bytes_after,
                "cache_bytes_delta": cache_bytes_after - cache_bytes_before,
            },
            "log_history": trainer.state.log_history,
            "environment": environment,
            "hbm_after_phase": {"free_bytes": int(free_hbm), "total_bytes": int(total_hbm)},
            "peak_hbm": {
                "allocated_bytes": int(torch.cuda.max_memory_allocated(0)),
                "reserved_bytes": int(torch.cuda.max_memory_reserved(0)),
            },
            "process_peak_rss_bytes": _process_peak_rss_bytes(),
            "quantization": {
                "requested_type": "nf4",
                "double_quantization_requested": True,
                "compute_dtype": "bfloat16",
                "linear4bit_module_count": len(four_bit_modules),
                "quant_types_observed": quant_types,
                "nested_quantization_modules_confirmed": sum(value is True for value in nested_values),
                "all_modules_confirmed_double_quantized": all(value is True for value in nested_values),
            },
            "attention_implementation": getattr(model.config, "_attn_implementation", "unknown"),
            "optimizer_class": f"{type(trainer.optimizer).__module__}.{type(trainer.optimizer).__qualname__}",
            "lora_trainable_parameter_count": sum(param.numel() for param in adapter_parameters),
            "lora_target_modules_observed": sorted(observed_targets),
            "optimizer_state_finite": True,
            "adapter_parameters_finite": True,
            "warnings": [
                {"category": warning.category.__name__, "message": str(warning.message)}
                for warning in caught_warnings
            ],
            "checkpoint": str(checkpoint.relative_to(ROOT)),
            "checkpoint_marker_valid": True,
            "optimizer_file_bytes": (checkpoint / "optimizer.pt").stat().st_size,
            "scheduler_file_bytes": (checkpoint / "scheduler.pt").stat().st_size,
            "dataset_sha256": dataset_report["file_sha256"],
        }
        _atomic_json(run_dir / f"{args.worker_phase}_phase.json", phase_record)
    return 0


def _process_peak_rss_bytes() -> int | None:
    try:
        import resource

        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024)
    except (ImportError, OSError, ValueError):
        return None


def _run_phase(phase: str, run_dir: Path, config_path: str, invariants_path: Path) -> None:
    log_path = run_dir / f"{phase}_phase.log"
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker-phase", phase,
        "--run",
        "--run-dir", str(run_dir),
        "--config", config_path,
        "--invariants", str(invariants_path),
    ]
    with log_path.open("w", encoding="utf-8") as log_handle:
        result = subprocess.run(command, cwd=ROOT, stdout=log_handle, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        raise RuntimeError(f"{phase} worker exited {result.returncode}; inspect {log_path}")


def _parent(args: argparse.Namespace) -> int:
    invariant_result = validate_invariants(args.invariants)
    if invariant_result["status"] != "passed":
        print(json.dumps(invariant_result, indent=2, ensure_ascii=False), file=sys.stderr)
        raise SystemExit("E014 frozen invariants failed; stopped before model download or output creation")
    config = _load_config(args.config)
    splits, dataset_report = _load_data(config, world_size=1)
    del splits
    torch, environment = _host_preflight()
    del torch
    if args.check_only:
        print(json.dumps({
            "status": "ready_for_qualification",
            "qualification_status": "READY_FOR_AMD_QUALIFICATION",
            "profile": "AMD_MI300X_SINGLE",
            "environment": environment,
            "dataset": dataset_report,
            "invariants": invariant_result,
            "model_weights_downloaded": False,
            "output_directory_created": False,
        }, indent=2, ensure_ascii=False))
        return 0

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
    run_dir = QUALIFICATION_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    try:
        git_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except (OSError, subprocess.SubprocessError):
        git_commit = None
    started_at = time.monotonic()
    start_record = {
        "status": "running",
        "started_at": _now(),
        "run_id": run_id,
        "git_commit": git_commit,
        "profile": "AMD_MI300X_SINGLE",
        "environment": environment,
        "model": config["base_model"],
        "model_revision": config["model_revision"],
        "tokenizer_revision": config["tokenizer_revision"],
        "training_config_path": args.config,
        "training_config_sha256": _sha256(ROOT / args.config),
        "invariants_path": str(args.invariants),
        "invariants_validation": invariant_result,
        "dataset": dataset_report,
        "output_scope": str(run_dir.relative_to(ROOT)),
        "model_quality_evaluation_performed": False,
        "test_split_used": False,
        "benchmark_loaded": False,
        "full_training_started": False,
        "smoke_only_deviations": {
            "optimizer_steps": 6,
            "sample_count": SAMPLE_COUNT,
            "warmup_steps": 0,
            "validation_and_test": "not loaded or evaluated",
            "checkpoint_stages": [FIRST_STAGE_STEP, FINAL_STAGE_STEP],
            "rationale": (
                "exercise real pinned-stack forward/backward/updates and fresh-process resume "
                "without constituting a model-quality run"
            ),
        },
    }
    _atomic_json(run_dir / "qualification_started.json", start_record)
    _append_event(
        run_dir / "timeline.jsonl",
        "SMOKE_STARTED",
        run_id=run_id,
        optimizer_steps=FINAL_STAGE_STEP,
        sample_count=SAMPLE_COUNT,
    )
    try:
        _run_phase("first", run_dir, args.config, args.invariants)
        _run_phase("resume", run_dir, args.config, args.invariants)
        selection = json.loads((run_dir / "selected_training_examples.json").read_text(encoding="utf-8"))
        first = json.loads((run_dir / "first_phase.json").read_text(encoding="utf-8"))
        resumed = json.loads((run_dir / "resume_phase.json").read_text(encoding="utf-8"))
        checkpoint_first = run_dir / f"checkpoint-{FIRST_STAGE_STEP}"
        checkpoint_final = run_dir / f"checkpoint-{FINAL_STAGE_STEP}"
        if first["global_step"] != FIRST_STAGE_STEP or resumed["global_step"] != FINAL_STAGE_STEP:
            raise RuntimeError("smoke did not reach the expected first and resumed optimizer steps")
        if not validate_checkpoint(checkpoint_first, expected_world_size=1):
            raise RuntimeError("step-3 checkpoint failed marker/files/optimizer/RNG validation")
        if not validate_checkpoint(checkpoint_final, expected_world_size=1):
            raise RuntimeError("step-6 checkpoint failed marker/files/optimizer/RNG validation")
        checkpoint_adapter = next(iter(sorted(checkpoint_first.glob("adapter_model.*"))))
        final_adapter = next(iter(sorted(run_dir.glob("adapter_model.*"))))
        checkpoint_hash = _sha256(checkpoint_adapter)
        final_hash = _sha256(final_adapter)
        if checkpoint_hash == final_hash:
            raise RuntimeError("LoRA adapter did not change after loading step 3 and resuming to step 6")
        _append_event(
            run_dir / "timeline.jsonl",
            "RESUME_VERIFIED",
            checkpoint_step=FIRST_STAGE_STEP,
            final_step=FINAL_STAGE_STEP,
            fresh_process=True,
        )

        durations = first["optimizer_step_durations_seconds"] + resumed["optimizer_step_durations_seconds"]
        if len(durations) != FINAL_STAGE_STEP:
            raise RuntimeError(
                f"expected {FINAL_STAGE_STEP} measured optimizer step durations, found {len(durations)}"
            )
        total_step_seconds = sum(float(value) for value in durations)
        nonpadding_tokens = sum(int(value) for value in selection["token_lengths"])
        padded_token_positions = FINAL_STAGE_STEP * 16 * int(config["max_seq_length"])
        median_step_seconds = median(durations)
        report = {
            **start_record,
            "status": "passed",
            "finished_at": _now(),
            "qualification_wall_seconds": round(time.monotonic() - started_at, 3),
            "optimizer_step_seconds": [round(float(value), 4) for value in durations],
            "median_optimizer_step_seconds": round(median_step_seconds, 4),
            "measured_nonpadding_tokens_per_second": (
                round(nonpadding_tokens / total_step_seconds, 3) if total_step_seconds else None
            ),
            "measured_padded_token_positions_per_second": (
                round(padded_token_positions / total_step_seconds, 3) if total_step_seconds else None
            ),
            "steps": {
                "before_process_restart": first["global_step"],
                "after_fresh_process_resume": resumed["global_step"],
            },
            "save_load_resume": {
                "checkpoint_3_valid": True,
                "checkpoint_6_valid": True,
                "resume_used_fresh_process": True,
                "optimizer_scheduler_and_rng_files_validated": True,
                "adapter_weights_changed_after_resume": True,
                "checkpoint_3_adapter_sha256": checkpoint_hash,
                "step_6_adapter_sha256": final_hash,
            },
            "quantization": resumed["quantization"],
            "model_load": {
                "first": first["model_load"],
                "resume": resumed["model_load"],
            },
            "optimizer_class": resumed["optimizer_class"],
            "lora_trainable_parameter_count": resumed["lora_trainable_parameter_count"],
            "lora_target_modules_observed": resumed["lora_target_modules_observed"],
            "numerical_checks": {
                "adapter_parameters_finite": (
                    first["adapter_parameters_finite"] and resumed["adapter_parameters_finite"]
                ),
                "optimizer_state_finite": first["optimizer_state_finite"] and resumed["optimizer_state_finite"],
                "warnings": first["warnings"] + resumed["warnings"],
            },
            "workload": {
                "model_quality_evaluation_performed": False,
                "test_split_used": False,
                "benchmark_loaded": False,
                "unique_train_examples": len(selection["example_ids"]),
                "optimizer_steps": FINAL_STAGE_STEP,
                "gradient_accumulation_steps": 16,
                "effective_global_batch_size": 16,
                "max_sequence_length": int(config["max_seq_length"]),
                "padded_forward_sequence_length": int(config["max_seq_length"]),
                "selected_min_tokens": min(selection["token_lengths"]),
                "selected_max_tokens": max(selection["token_lengths"]),
                "selected_total_nonpadding_tokens": nonpadding_tokens,
                "total_padded_token_positions": padded_token_positions,
                "selected_examples_sha256": selection["selection_sha256"],
            },
            "peak_hbm": {
                "allocated_bytes": max(first["peak_hbm"]["allocated_bytes"], resumed["peak_hbm"]["allocated_bytes"]),
                "reserved_bytes": max(first["peak_hbm"]["reserved_bytes"], resumed["peak_hbm"]["reserved_bytes"]),
                "end_of_phase_device_hbm_used_bytes": environment["gpu"]["hbm_total_bytes"] - min(
                    first["hbm_after_phase"]["free_bytes"], resumed["hbm_after_phase"]["free_bytes"]
                ),
            },
            "process_peak_rss_bytes_by_phase": {
                "first": first["process_peak_rss_bytes"],
                "resume": resumed["process_peak_rss_bytes"],
            },
            "attention_implementation": resumed["attention_implementation"],
            "artifacts": {
                "report": str((run_dir / "qualification_report.json").relative_to(ROOT)),
                "selected_examples": str((run_dir / "selected_training_examples.json").relative_to(ROOT)),
                "phase_logs": [
                    str((run_dir / "first_phase.log").relative_to(ROOT)),
                    str((run_dir / "resume_phase.log").relative_to(ROOT)),
                ],
                "timeline": str((run_dir / "timeline.jsonl").relative_to(ROOT)),
                "telemetry": str((run_dir / "qualification_report.json").relative_to(ROOT)),
                "final_adapter": str(final_adapter.relative_to(ROOT)),
            },
        }
        _atomic_json(run_dir / "qualification_report.json", report)
        _append_event(run_dir / "timeline.jsonl", "SMOKE_COMPLETED", status="passed")
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    except Exception as exc:
        failure = {
            **start_record,
            "status": "failed",
            "finished_at": _now(),
            "qualification_wall_seconds": round(time.monotonic() - started_at, 3),
            "error_type": type(exc).__name__,
            "error": str(exc),
            "model_quality_evaluation_performed": False,
            "full_training_started": False,
        }
        _atomic_json(run_dir / "qualification_report.json", failure)
        _append_event(
            run_dir / "timeline.jsonl",
            "SMOKE_FAILED",
            status="failed",
            error_type=type(exc).__name__,
            error=str(exc),
        )
        print(json.dumps(failure, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check-only",
        action="store_true",
        help="validate the ROCm host and frozen artifacts without model weights or output creation",
    )
    mode.add_argument(
        "--run",
        action="store_true",
        help="run six isolated QLoRA optimizer steps and a fresh-process resume",
    )
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--invariants", type=Path, default=DEFAULT_INVARIANTS)
    parser.add_argument("--worker-phase", choices=("first", "resume"), help=argparse.SUPPRESS)
    parser.add_argument("--run-dir", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker_phase:
        if not args.run_dir:
            parser.error("--run-dir is required for an internal qualification worker")
        return _worker(args)
    return _parent(args)


if __name__ == "__main__":
    raise SystemExit(main())
