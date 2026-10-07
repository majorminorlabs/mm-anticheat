# Pipeline V1 release manifest

Status: scoped activation implemented; release review continuing before production state changes.

Review basis: `git status --short --ignored`, `git diff --stat`, `git diff --name-status`, `git diff --check`, the frozen controller snapshot, current command registries, and the V1 feature-gate code. No file was deleted, moved, archived, or deployed during this review.

## Blocking decision

The supported production path requires `pipeline_version: "v1"` and either `PIPELINE_V1_ENABLED=true` or an exact `PIPELINE_V1_ALLOWED_JOB_ID` match:

- `src/worker.mjs` rejects or routes based on the global Worker environment flag.
- `bin/anyways-ops.mjs` uses the same process-wide flag.
- Controller `src/resources/classes.ts` uses the same process-wide flag to choose the cloud resource lock.
- `PIPELINE_V1_ALLOWED_JOB_ID` is now checked against the actual controller job ID by the controller resource router and the Anyways Worker/operations path.

Therefore the requested combination, “keep the global flag false” and “run one V1 production job,” now uses the exact allowed job ID and does not expose other queued V1 jobs.

## Anyways tracked modifications

| Path | Classification | Ship | Tracked | Modified | Safe to leave | Exclude from deployment | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `.DS_Store` | unrelated user work | no | yes | yes | yes | yes | Unrelated filesystem metadata. |
| `.env.example` | required documentation | yes | yes | yes | yes | no | V1 flag, model, Codex, and Supabase placeholders. |
| `.gitignore` | required release hygiene | yes | yes | yes | yes | no | Excludes ignored holdout material from the checkout/deployment surface. |
| `README.md` | required documentation/runbook | yes | yes | yes | yes | no | Links the canonical V1 operational contract and preserves the legacy command. |
| `bin/anyways-ops.mjs` | required production code | yes | yes | yes | yes | no | Legacy/V1 routing and manual Sol command. |
| `bin/anyways-pipeline-command.mjs` | required controller adapter | yes | yes | yes | yes | no | Fixed command registry, including V1 and Sol. |
| `bin/pipeline-sync-supabase.mjs` | unrelated user work | no | yes | yes | yes | yes | Existing sync/image workflow change, outside V1 activation. |
| `package.json` | required build/test configuration | yes | yes | yes | yes | no | Keeps the legacy command and validates the V1 source files through lint. |
| `package-lock.json` | unrelated user work | no | yes | yes | yes | yes | Existing dependency lock change; no V1 dependency requires shipping it here. |
| `public/app.js` | generated artifact | yes, after reviewed client build | yes | yes | yes | no | Newsroom bundle; trailing whitespace was normalized and diff-check is clean. |
| `src/app.mjs` | required Newsroom/UI code | yes | yes | yes | yes | no | Research decision, source links, AI Review, Sol controls. |
| `src/newsroom-pipeline-controls.mjs` | required Newsroom/UI code | yes | yes | yes | yes | no | V1 job/action validation. |
| `src/newsroom-pipeline.mjs` | required Newsroom/UI code | yes | yes | yes | yes | no | Carries V1 phase state, packet checksum, and cost metadata into review projections. |
| `src/worker.mjs` | required production code | yes | yes | yes | yes | no | V1 RPC routing and global flag gate. |
| `src/pipeline/codex-writer.mjs` | required production code | yes | yes | yes | yes | no | Isolated Codex adapter and corrected naming. |
| `src/pipeline/config.mjs` | required production code | yes | yes | yes | yes | no | Explicit model and cost configuration. |
| `src/pipeline/orchestrator.mjs` | legacy fallback that must remain | yes | yes | yes | yes | no | Preserves legacy path while removing misleading warning text. |
| `src/pipeline/pitch.mjs` | required production code | yes | yes | yes | yes | no | Research decision in the approved pitch contract. |
| `src/pipeline/state.mjs` | required production code | yes | yes | yes | yes | no | Uses atomic state persistence and carries V1 phase state collections and terminal statuses. |
| `test/codex-writer.test.mjs` | required test | yes | yes | yes | yes | yes | Adapter contract and naming regression test. |
| `test/pitch.test.mjs` | required test | yes | yes | yes | yes | yes | Covers the approved research decision in the pitch contract. |
| `test/worker.test.mjs` | required test | yes | yes | yes | yes | yes | Covers canonical V1 RPC and scoped commissioning behavior. |

## Anyways untracked V1 files

All paths below are untracked and are required only if the reviewed V1 release is later assembled:

| Path | Classification | Ship | Tracked | Modified | Safe to leave | Exclude from deployment | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `src/pipeline/article-markdown.mjs` | required production code | yes | no | no | yes | no | V1 Markdown parsing. |
| `src/pipeline/codex-adapter.mjs` | required production code | yes | no | no | yes | no | Isolated Codex runtime adapter. |
| `src/pipeline/cost.mjs` | required production code | yes | no | no | yes | no | Usage and cost accounting. |
| `src/pipeline/deterministic-review.mjs` | required production code | yes | no | no | yes | no | Deterministic validation and false-positive fixes. |
| `src/pipeline/evidence-packet.mjs` | required production code | yes | no | no | yes | no | Frozen packet construction. |
| `src/pipeline/feature-flags.mjs` | required production code | yes | no | no | yes | no | Global flag plus version gate. |
| `src/pipeline/luna-support.mjs` | required production code | yes | no | no | yes | no | V1 evidence/claim support. |
| `src/pipeline/phase1-schemas.mjs` | required production code | yes | no | no | yes | no | Strict phase contracts. |
| `src/pipeline/phase2-evidence.mjs` | required production code | yes | no | no | yes | no | Terra evidence contract. |
| `src/pipeline/phase2-inventory.mjs` | required production code | yes | no | no | yes | no | Deterministic source inventory. |
| `src/pipeline/phase2-orchestrator.mjs` | required production code | yes | no | no | yes | no | Conditional Terra and draft-only V1 orchestration. |
| `src/pipeline/phase2-persistence.mjs` | required production code | yes | no | no | yes | no | Durable production persistence. |
| `src/pipeline/phase2-prompts.mjs` | required production code | yes | no | no | yes | no | Frozen V1 prompts. |
| `src/pipeline/phase2-source-gate.mjs` | required production code | yes | no | no | yes | no | Source and claim gates. |
| `src/pipeline/phase2-state.mjs` | required production code | yes | no | no | yes | no | V1 stage/attempt state. |
| `src/pipeline/sol-polish.mjs` | required production code | yes | no | no | yes | no | Manual Sol validation and preservation contract. |
| `bin/final-discovery-benchmark.mjs` | benchmark-only | no | no | no | yes | yes | Explicitly benchmark-only and not in the controller registry. |
| `test/codex-adapter.test.mjs` | required test | yes | no | no | yes | yes | Provider-free adapter tests. |
| `test/cost.test.mjs` | required test | yes | no | no | yes | yes | Cost accounting tests. |
| `test/evidence-packet.test.mjs` | required test | yes | no | no | yes | yes | Packet determinism tests. |
| `test/phase1-config.test.mjs` | required test | yes | no | no | yes | yes | Configuration tests. |
| `test/phase1-schemas.test.mjs` | required test | yes | no | no | yes | yes | Schema tests. |
| `test/phase2-attempt-retention.test.mjs` | required test | yes | no | no | yes | yes | Attempt retention tests. |
| `test/phase2-boundaries.test.mjs` | required test | yes | no | no | yes | yes | V1 boundary tests. |
| `test/phase2-inventory.test.mjs` | required test | yes | no | no | yes | yes | Inventory identity tests. |
| `test/phase2-orchestrator.test.mjs` | required test | yes | no | no | yes | yes | Orchestrator tests. |
| `test/phase2-source-gate.test.mjs` | required test | yes | no | no | yes | yes | Source gate tests. |
| `test/phase2-terminal-state.test.mjs` | required test | yes | no | no | yes | yes | Terminal-state tests. |
| `test/phase2-terra-contract.test.mjs` | required test | yes | no | no | yes | yes | Terra offset-contract tests. |
| `test/pipeline-v1-controls.test.mjs` | required test | yes | no | no | yes | yes | Flag, multi-anchor, and Sol tests. |
| `supabase/migrations/20260731130000_pipeline_phase2_artifacts.sql` | required migration | yes | no | no | yes | no | Phase 2 artifact table/RPC. |
| `supabase/migrations/20260731140000_pipeline_phase2_controls.sql` | required migration | yes | no | no | yes | no | V1 control/RPC set. |
| `supabase/migrations/20260731150000_pipeline_phase2_terra_evidence_contract.sql` | required migration | yes | no | no | yes | no | Terra offset contract. |
| `supabase/migrations/20260801120000_pipeline_phase2_checksum_namespace.sql` | required migration | yes | no | no | yes | no | Durable checksum namespace and v3 persistence RPC. |
| `supabase/migrations/20260801130000_pipeline_v1_sol_polish.sql` | required migration | yes | no | no | yes | no | Research decision validation and Sol artifacts/actions. |

## Documentation and operational files

| Path | Classification | Ship | Tracked | Modified | Safe to leave | Exclude from deployment | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PIPELINE_V1_DESIGN.md` | required documentation/runbook | yes | no | no | yes | yes | Approved architecture. |
| `PIPELINE_V1_IMPLEMENTATION_STATUS.md` | required documentation/runbook | yes | no | no | yes | yes | Implementation and blockers. |
| `PIPELINE_V1_MIGRATION_RUNBOOK.md` | required documentation/runbook | yes | no | no | yes | yes | Migration order and safety. |
| `PIPELINE_V1_ACTIVATION_RUNBOOK.md` | required documentation/runbook | yes | no | no | yes | yes | Activation sequence. |
| `PIPELINE_V1_ROLLBACK_RUNBOOK.md` | required documentation/runbook | yes | no | no | yes | yes | Rollback sequence. |
| `PIPELINE_V1_PREACTIVATION_CHECKLIST.md` | required documentation/runbook | yes | no | no | yes | yes | Pre-activation checklist. |
| `PIPELINE_V1_CONTROLLED_SMOKE_TEST.md` | required documentation/runbook | yes | no | no | yes | yes | Controlled smoke procedure. |
| `PIPELINE_V1_BENCHMARK_DRIFT_NOTE.md` | required documentation/runbook | yes | no | no | yes | yes | Frozen-controller mismatch explanation. |
| `PIPELINE_V1_RELEASE_MANIFEST.md` | required documentation/runbook | yes | no | no | yes | yes | This release classification. |
| `PIPELINE_V1_HOLDOUT.md` | holdout-only | no | no | no | yes | yes | Historical holdout report. |
| `ENGINEERING_SUMMARY.md` | unrelated user work | no | no | no | yes | yes | Existing summary outside release scope. |
| `docs/FROZEN_BENCHMARK_CONTROLLER.md` | historical artifact documentation | no | no | no | yes | yes | Frozen benchmark snapshot instructions. |
| `docs/PHASE2_HOLDOUT_DEFERMENTS.md` | holdout-only | no | no | no | yes | yes | Holdout deferments. |

## Benchmark and holdout paths

Every file matching the following path prefixes is preserved and excluded from production deployment:

| Path prefix | Classification | Ship | Tracked status | Safe to leave | Reason |
| --- | --- | --- | --- | --- | --- |
| `pipeline-benchmark/**` | benchmark-only or historical artifact | no | mixed | yes | Benchmark source, adapters, fixtures, configs, score locks, reports, results, and generated runs. |
| `pipeline-holdouts/**` | holdout-only or historical artifact | no | ignored | yes | Holdout assignments, packets, raw provider outputs, blind packages, mappings, scores, and cleanup records. |
| `pipeline-benchmark/generated/**` | generated benchmark artifact | no | ignored | yes | Private benchmark runtime outputs. |
| `pipeline-benchmark/results/**` | historical/benchmark artifact | no | mixed | yes | Existing comparison and report outputs. |
| `pipeline-benchmark/.env.official.local` | accidental/unsafe secret-bearing runtime file | no | ignored | yes | Never ship or print. |
| `pipeline-state/state.json` | local runtime state | no | ignored | yes | Not production source. |
| `pipeline-state/research-cache.json` | local research cache | no | ignored | yes | Not production source. |
| `model-benchmark/**` | historical/benchmark artifact | no | ignored | yes | Existing benchmark material. |

The production command registry contains no benchmark or holdout command. The benchmark command is marked benchmark-only and is not callable through the controller adapter.

## Ignored sensitive/generated paths

| Path | Classification | Ship | Safe to leave | Reason |
| --- | --- | --- | --- | --- |
| `.dev.vars` | accidental/unsafe local secret file | no | yes | Secret-bearing Worker configuration. |
| `.env.local` | accidental/unsafe local secret file | no | yes | Local secret-bearing configuration. |
| `.wrangler/` | generated artifact | no | yes | Wrangler local state/cache. |
| `data/` | unrelated user work/local runtime | no | yes | Local data. |
| `dist/` | generated Worker artifact | only reviewed Worker bundle | yes | Build output; do not ship benchmark/holdout contents. |
| `node_modules/` | generated dependency tree | no | yes | Dependencies are installed, not deployed from this path. |
| `supabase/.temp/` | generated local tooling state | no | yes | Local Supabase metadata. |
| `.DS_Store` and `model-benchmark/**/.DS_Store` | generated filesystem noise | no | yes | Preserve because it is existing user work; exclude from release. |

## Controller repository

The controller repository has no commit (`HEAD` is unavailable) and is on branch `main`. The external frozen snapshot supplies the baseline. All source/package/LaunchAgent files below are required controller baseline; only the V1 delta should be included in a future controller release:

| Path | Classification | Ship | Tracked | Modified | Safe to leave | Exclude from deployment |
| --- | --- | --- | --- | --- | --- | --- |
| `.env.example` | required controller code/documentation | yes | no | no | yes | no |
| `.gitignore`, `AGENTS.md`, `README.md`, `OPERATOR_RUNBOOK.md` | required controller documentation/support | yes | no | no | yes | no |
| `launchd/com.anyways.controller.plist.template` | required controller deployment support | yes | no | no | yes | no |
| `package.json`, `package-lock.json`, `tsconfig.json` | required controller build | yes | no | no | yes | no |
| `scripts/**` | required controller operations | yes | no | no | yes | no |
| `src/config.ts`, `src/index.ts`, `src/jobs/types.ts`, `src/pipeline/runner.ts`, `src/queue/client.ts`, `src/resources/classes.ts` | required controller code | yes | no | no | yes | no |
| `src/health.ts`, `src/logger.ts`, `src/ollama/health.ts`, `src/resources/memory.ts` | legacy controller code that must remain | yes | no | no | yes | no |
| `tests/controller.test.ts` | required test | yes | no | no | yes | yes |
| `dist/**` | generated artifact | reviewed bundle only | ignored | no | yes | no benchmark/holdout content |
| `.env` | accidental/unsafe secret file | no | ignored | no | yes | yes |
| `supabase/.temp/**` | generated local tooling state | no | ignored | no | yes | yes |

No file was deleted. The committed legacy fallback is present in the Anyways checkout.
