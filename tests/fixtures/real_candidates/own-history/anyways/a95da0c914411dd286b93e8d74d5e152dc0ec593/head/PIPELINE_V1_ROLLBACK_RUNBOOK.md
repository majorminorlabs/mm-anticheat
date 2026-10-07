# Pipeline V1 Rollback Runbook

Rollback is designed to preserve the legacy fallback and retained artifacts.

1. Stop new V1 submissions at the Newsroom control plane.
2. Set `PIPELINE_V1_ENABLED=false` in both the Anyways and controller environments.
3. Allow or safely cancel active V1 jobs according to the existing queue procedure. Do not retry a completed provider stage.
4. Restart the controller using the existing service procedure if the environment change requires it.
5. Submit replacement work without `pipeline_version: "v1"` so it uses the committed legacy path.
6. Confirm `qwen3:14b` local-heavy routing and legacy tests remain available.
7. Keep Phase 2 artifacts, frozen packets, Sol artifacts, decisions, and checksums for audit and recovery.
8. Do not delete the legacy files, V1 artifacts, or migration records.

Rollback does not recover files from Git history and does not require a destructive database operation. Re-enable V1 only after the activation blockers are resolved and a new controlled smoke test is authorized.
