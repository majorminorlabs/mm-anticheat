# E014 unattended controller

scripts/e014_run.sh is a local, detached supervisor for the frozen E014
QLoRA run. It does not provision a provider or open an SSH connection. Run it
from the persistent project checkout on a GPU host.

The default durable locations are /workspace/e014-runs/E014 for controller
state, logs, metrics, and provenance, and
/workspace/research-model-mm/source for existing project outputs, checkpoints,
model cache, and evaluation artifacts. Both paths are under /workspace;
alternate paths are accepted only for explicitly marked local tests.

## Commands

    ./scripts/e014_run.sh start
    ./scripts/e014_run.sh status
    ./scripts/e014_run.sh logs
    ./scripts/e014_run.sh logs --follow
    ./scripts/e014_run.sh stop
    ./scripts/e014_run.sh resume

Budget-limited segments can request either limit:

    ./scripts/e014_run.sh start --max-runtime-hours 8 --max-cost-usd 8.72

At either limit the supervisor writes a stop request, lets the trainer save at
the next step boundary, and records STOPPED. A later host with the same
persistent volume runs resume; it selects the newest valid checkpoint and
passes --resume. Existing completed stages and evaluation files are skipped.

## Architecture and safety

The shell entry point launches a Python supervisor with start_new_session=True
and stdin disconnected, so terminal and laptop disconnects do not terminate
training. The supervisor owns the training child, appends status history, polls
NVIDIA telemetry, and writes separate stdout/stderr logs. A stop request is a
sentinel consumed by the trainer callback at on_step_end; that callback asks
the Trainer to save and stop at the boundary. It does not kill a process during
checkpoint serialization.

The existing atomic checkpoint marker remains authoritative. Resume requires a
complete checkpoint containing trainer state, optimizer, scheduler, RNG state,
adapter files, and matching hashes. Incomplete or corrupt checkpoint
directories are never selected, and existing output without a valid checkpoint
causes a loud refusal instead of a step-zero restart.

The controller classifies CUDA OOM, non-finite loss, disk exhaustion, invalid
checkpoint state, and non-zero training/evaluation exits in state.json.

## Scientific integrity

The controller does not change the frozen model, dataset/splits, NF4 QLoRA,
BF16, LoRA rank, sequence length, effective batch, optimizer, scheduler, seed,
epoch count, or evaluation commands. Checkpoint resume preserves the Trainer,
optimizer, scheduler, RNG, and callback state needed for continuation. An
interrupted run can still differ at the bit level because hardware/library
execution order and wall-clock scheduling are not guaranteed bitwise identical;
that is an execution limitation, not a change to the registered methodology.

Actual host preparation, CUDA validation, disk checks, and any full E014 run
remain to be performed on an L40S. This local task intentionally does not run
training.
