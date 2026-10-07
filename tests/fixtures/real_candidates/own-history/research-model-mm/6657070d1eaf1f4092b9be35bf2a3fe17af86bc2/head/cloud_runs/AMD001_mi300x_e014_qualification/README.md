# AMD001: E014 MI300X qualification

This is a compute-qualification session record, not a model-quality
experiment. The committed manifest records the pre-instance intent and frozen
provenance. Runtime evidence is written under `runtime/` and is intentionally
ignored by Git so raw logs, telemetry, checkpoints, and collected archives do
not become part of the source release.

The workflow does not call a provider API and never destroys an instance. After
the user deliberately creates the selected AMD Developer Cloud droplet and
receives its public IP, the one-command entry point is:

```sh
bash scripts/amd_session.sh qualify <PUBLIC_IP>
```

That command performs the SSH check, transfers the committed Git bundle and
frozen dataset archive, verifies hashes, checks out the exact source commit,
installs the pinned environment, snapshots the host, validates E014, runs the
six-step save/resume smoke, collects remote evidence, and prints whether the
instance is safe to destroy. It never issues a destroy command.

Use `bash scripts/amd_session.sh prepare` for local-only staging and
`bash scripts/amd_session.sh dry-run` to inspect the remote plan without
network access. The runtime transfer manifest is generated at
`runtime/transfer_manifest.json`; append-only timeline and command records are
`runtime/timeline.jsonl` and `runtime/commands.jsonl`.

The selected ROCm Software 10.0 image and the E014 PyTorch 2.14.0 ROCm 7.14
wheel are deliberately recorded as separate layers. The remote preflight must
prove that this combination works on the actual MI300X before any model
weights are used. A mismatch fails fast and still collects logs/telemetry.
