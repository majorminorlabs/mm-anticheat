# Pipeline V1 Implementation Status

Status: scoped activation implemented; activation proceeding under the controlled runbook.

## Completed

- Restored the committed legacy orchestration, Ollama adapter, schemas, synthesis, workflow, and legacy tests.
- Added `PIPELINE_V1_ENABLED=false` and `PIPELINE_V1_ALLOWED_JOB_ID=` to the Anyways and controller environment examples.
- Added canonical scoped activation: when the global flag is false, only the exact matching controller job ID may execute V1.
- Enforced the version plus global-flag gate in local operations, Newsroom requests, and controller resource routing.
- Set explicit Luna High discovery, Terra High research, Luna High Draft, and Sol Medium polish configuration.
- Added the approved pitch `research_requirement` field and conditional Terra behavior.
- Removed automatic Luna Revision from the default V1 path. Historical revision code remains unreachable compatibility code.
- Added the manually authorized Sol polish job, validator, durable artifact migration, visual diff, and accept/reject/restore controls.
- Added deterministic source-link rendering from frozen claim-support mappings.
- Fixed confirmed deterministic-review false positives for names, numbers, missing deterministic links, and repeated claim anchors.
- Marked `bin/final-discovery-benchmark.mjs` benchmark-only. It is not in the controller command registry.
- Added the ordered Sol and research-decision migrations, plus two narrowly scoped commissioning compatibility migrations required after application.

## Activation result

- Migrations 1–5 and compatibility migrations `20260801131500` and `20260801133000` are applied and verified through linked migration history.
- The controller was built and restarted successfully. Final health was clean and idle.
- `PIPELINE_V1_ENABLED` remains false. The scoped allowance was used for one job and then cleared.
- One controlled V1 job ran exactly once and terminalized as `research_blocked` at the deterministic source gate because its approved Meanwhile pitch retained one accessible source where three were required. No provider call was made.
- No Draft, frozen packet, AI Review, Sol polish, On Deck approval, or publication was produced by that smoke job.
- The supplied `PIPELINE_V1_CURRENT_STATE_AUDIT.md` was not present in the checkout or attachment directory, so implementation used the approved architecture in the request and current-state reinspection.

## Exact migration set and order

1. `supabase/migrations/20260731130000_pipeline_phase2_artifacts.sql`
2. `supabase/migrations/20260731140000_pipeline_phase2_controls.sql`
3. `supabase/migrations/20260731150000_pipeline_phase2_terra_evidence_contract.sql`
4. `supabase/migrations/20260801120000_pipeline_phase2_checksum_namespace.sql`
5. `supabase/migrations/20260801130000_pipeline_v1_sol_polish.sql`
6. `supabase/migrations/20260801131500_pipeline_v1_commission_compatibility.sql`
7. `supabase/migrations/20260801133000_pipeline_v1_commission_wrapper_fix.sql`

Migrations 6 and 7 are compensating compatibility migrations. Migration 6 disambiguates the applied four-argument wrapper; migration 7 restores its V1 version and one-attempt side effects.

See [PIPELINE_V1_MIGRATION_RUNBOOK.md](./PIPELINE_V1_MIGRATION_RUNBOOK.md).

## Exact environment changes for activation

These are the exact values required for the controlled activation environment. Keep the ordinary production environment at `PIPELINE_V1_ENABLED=false`; set the allowance only to the one smoke-test queue job ID:

```text
PIPELINE_V1_ENABLED=false
PIPELINE_V1_ALLOWED_JOB_ID=<exact-smoke-test-job-id>
ANYWAYS_DISCOVERY_MODEL=gpt-5.6-luna
ANYWAYS_DISCOVERY_REASONING=high
ANYWAYS_RESEARCH_MODEL=gpt-5.6-terra
ANYWAYS_RESEARCH_REASONING=high
ANYWAYS_DRAFT_MODEL=gpt-5.6-luna
ANYWAYS_DRAFT_REASONING=high
ANYWAYS_POLISH_MODEL=gpt-5.6-sol
ANYWAYS_POLISH_REASONING=medium
PHASE2_JOB_TIMEOUT_SECONDS=2400
```

Until activation, keep `PIPELINE_V1_ENABLED=false`.

## Controller artifact and restart commands

The local controller build succeeded. The artifact that would need deployment is:

`/Volumes/External/GitHub/IGNORED/anyways-controller/dist/src/index.js`

The exact operational commands are environment-specific, but the controlled sequence is:

```sh
cd /Volumes/External/GitHub/IGNORED/anyways-controller
npm run build
# deploy the resulting dist/ bundle using the existing controller service procedure
# restart the existing controller service using its existing launchd procedure
```

No deployment or restart was performed in this task.

## Controlled smoke test after activation

1. Confirm migrations are present and all required RPCs exist.
2. Confirm health and queue connectivity are passing.
3. Confirm `PIPELINE_V1_ENABLED=false` and `PIPELINE_V1_ALLOWED_JOB_ID` equals only the selected smoke-test job ID in the controller and Anyways process environments.
4. Use one already approved pitch and choose `research_requirement: none` or `required` explicitly.
5. Submit exactly one `process_candidate` job with `pipeline_version: v1`.
6. Verify provider-call count: zero Terra for `none`, exactly one Terra for `required`, and exactly one Luna Draft.
7. Verify no revision stage and no fourth cloud call.
8. Inspect frozen packet, checksums, deterministic findings, and deterministic source links in AI Review.
9. If desired, authorize exactly one `polish_candidate` job and inspect the Sol diff.
10. Accept, reject, or restore explicitly, then approve to On Deck. Publish or schedule separately.
