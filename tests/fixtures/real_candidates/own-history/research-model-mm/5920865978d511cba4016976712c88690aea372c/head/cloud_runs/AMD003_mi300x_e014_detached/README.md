# AMD003: detached E014 MI300X execution

AMD003 is the simplified, offline-prepared successor to the AMD001/AMD002
qualification attempts. AMD001 and AMD002 remain historical evidence; this
record does not erase or rewrite them.

The Mac performs only bootstrap/control work:

1. wait for three consecutive clean SSH sentinel probes;
2. upload and hash-verify the committed code bundle and frozen dataset;
3. start one detached remote runner; and
4. verify that the detached job exists before returning control.

The remote runner owns dependency setup, frozen-invariant validation, pinned
model loading, baseline evaluation, E014 training, checkpoint/resume,
tuned evaluation, paired bootstrap analysis, telemetry, cost accounting, and
result packaging. It does not depend on the Mac remaining connected.

No second six-step AMD qualification is required. AMD001 already demonstrated
MI300X/ROCm, NF4, double quantization, QLoRA initialization, optimizer steps,
and checkpoint writing. AMD003 records the real E014 run directly, with a
minimal host preflight before model work.

## Offline preparation

```sh
bash scripts/amd003_session.sh prepare
bash scripts/amd003_session.sh dry-run
```

## After manually creating the next MI300X droplet

```sh
bash scripts/amd003_session.sh start <PUBLIC_IP>
```

The command returns `AMD003 STARTED`, `REMOTE JOB IS DETACHED`, and
`SAFE TO DISCONNECT SSH` after the remote launcher verifies tmux or its
independent process. It does not keep a monitoring SSH session open.

Reconnect later with one status snapshot:

```sh
bash scripts/amd003_session.sh status <PUBLIC_IP>
```

If the runner reports `FAILED`, explicitly resume from the latest valid
checkpoint with:

```sh
bash scripts/amd003_session.sh resume <PUBLIC_IP>
```

After a terminal state, retrieve the single result archive with:

```sh
bash scripts/amd003_session.sh collect <PUBLIC_IP>
```

The remote result archive remains on the MI300X until explicitly collected.
Every failure preserves logs, checkpoints, status, and any partial outputs.

