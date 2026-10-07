# Pipeline V1 Activation Runbook

This is the next operational task. Do not execute it as part of code reconciliation.

## Activation sequence

1. Review and approve the diff.
2. Apply the five migrations in [PIPELINE_V1_MIGRATION_RUNBOOK.md](./PIPELINE_V1_MIGRATION_RUNBOOK.md).
3. Build the controller from `/Volumes/External/GitHub/IGNORED/anyways-controller`.
4. Deploy `dist/src/index.js` using the existing service procedure.
5. Keep `PIPELINE_V1_ENABLED=false`. Set `PIPELINE_V1_ALLOWED_JOB_ID` only to the exact queued smoke-test job ID. With the global flag false, the controller and Worker route only that matching versioned job through V1; all other jobs remain on the legacy path. Clear the allowance immediately after the smoke test.
6. Restart the controller once using the existing launchd procedure.
7. Verify health and queue connectivity. A historical `last_recorded_error` alone is not an outage when current health and connectivity pass.
8. Submit exactly one already approved pitch as a V1 `process_candidate` job through the scoped procedure in `PIPELINE_V1_CONTROLLED_SMOKE_TEST.md`.
9. Verify stage and call-count invariants before any further job.
10. Complete the human AI Review gate. Optionally use the separate Sol action, then approve to On Deck. Publish or schedule separately.
11. Clear `PIPELINE_V1_ALLOWED_JOB_ID` immediately after the review and verify `PIPELINE_V1_ENABLED=false` remains unchanged.

## Stop conditions

Stop immediately on a duplicate provider call, missing checksum, missing source link, unexpected revision stage, fourth cloud call, stale replay, migration mismatch, or a job without both the flag and version. Leave V1 enabled only after the controlled story meets all checks.

## Required evidence

Record the feature flag state, pipeline version, current stage, provider call counts, models, research requirement, packet checksum, Draft checksum, optional polish checksum, credits, USD estimate or null, blockers, warnings, and the final human action audit records.
