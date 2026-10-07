# Anyways Pipeline v1 Phase 2 Holdout Validation

Generated: 2026-08-01T01:24:36.976Z

## Result

**FAIL**

The holdout did not complete the commissioned vertical slice. Two Terra calls ran once each and failed closed on a schema-contract mismatch before evidence-packet freeze. The third story could not enter the model path because its frozen source returned HTTP 403. No Draft, Revision, AI Review, publication, image, discovery, or production persistence action occurred.

Final recommendation: **4. Return to implementation.**

## 1. Selected holdout stories

- case-01: How State Deepfake Laws Are Rewriting the Image Generators Everyone Uses — pitch_ready; internet / systems; source snapshot 9fea81be1aa8ca1001ea38c73b59fe416d9eb78ebd9621aea46ebacae432d55c.
- case-02: Restaurant Recommendations Are Becoming Social Objects Again — pitch_ready; taste / meanwhile; source snapshot ec503030b2b030c7abe6c876ca4948a1fc284c366ab358841a86b59f82debab2.
- case-03: AI Startups Are Turning Relationship Conflict Into a Product—and Backlash Into Distribution — pitch_ready; builders / builders; source snapshot e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.

## 2. Isolation method

- Assignments, source responses, extracted text, raw HTML, and evidence inputs were frozen under `/Volumes/External/GitHub/IGNORED/anyways/pipeline-holdouts/phase2-v1-20260731` before model execution.
- Phase 2 used a command-only `PIPELINE_V1_ENABLED=true` environment value, separate UUID run IDs, in-memory persistence, a frozen-source fetcher, and no Supabase or Newsroom writes.
- Brave discovery, Qwen3.6 triage, publication, image handling, deployment, commit, push, and controller restart were not used.
- Legacy comparison was skipped because exact isolation from the live controller and shared Ollama daemon could not be guaranteed. Mapping is sealed at `/Volumes/External/GitHub/IGNORED/anyways/pipeline-holdouts/phase2-v1-20260731/sealed/mapping.json`; do not open it before review.

## 3. Preflight results

- Phase 2 focused tests: passed before execution.
- Normal feature flag: false by default; holdout-only process override was used.
- Codex CLI/authentication: passed.
- Controller: current health `ok`; current job null; an old recorded lease-release fetch error remained in telemetry.
- Queue: idle, zero queued, zero active, zero active leases.
- `heavy_model` lock: free.
- Ollama: no resident model before execution.
- Persistence: in-memory only; Phase 2 migrations were not applied.
- Benchmark candidates: separate from Apple Digital Repo, Logitech, and Kansas City church fixtures.

## 4-8. Stage outcomes, blockers, packets, Drafts, Revisions

| Holdout | Terra | Source inventory | Evidence packet | Draft | Deterministic review | Revision | AI Review |
|---|---|---|---|---|---|---|---|
| case-01 | blocked (PHASE1_SCHEMA_INVALID) | 1 source(s) | not frozen; checksum null | not run | not run | not run | not materialized |
| case-02 | blocked (PHASE1_SCHEMA_INVALID) | 1 source(s) | not frozen; checksum null | not run | not run | not run | not materialized |
| case-03 | blocked_before_model (FROZEN_SOURCE_UNUSABLE) | 1 source(s) | not frozen; checksum null | not run | not run | not run | not materialized |

Terra’s raw research output is retained privately. Both eligible responses identified insufficient evidence, but both were rejected by the schema validator because `blockers` was returned as strings instead of the required blocker objects. No `research_again` action was authorized.

## 9. Runtime, token, and cost table

| Holdout | Stage | Runtime | Input | Cached | Output | Reasoning | Credits | USD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| case-01 | research | 45736 ms | 8818 | 0 | 1787 | 135 | 0.977 | — |
| case-02 | research | 26597 ms | 8858 | 0 | 1286 | 311 | 0.8287 | — |

Total Terra credits recorded: 1.8057. Dollar estimate was unavailable from the provider telemetry. The Phase 2 run record incorrectly retained zero usage after schema failure; this is defect D4.

## 10. Legacy comparison availability

Skipped. The legacy path requires the shared live Ollama daemon and qwen3:14b. Because the live controller could not be paused or restarted under the approved boundary and no separate legacy lock exists, exact isolation was not guaranteed.

## 11-12. Blind packages and blank score sheets

Blind packages: `/Volumes/External/GitHub/IGNORED/anyways/pipeline-holdouts/phase2-v1-20260731/blind-packages/`. Blank score sheets: `/Volumes/External/GitHub/IGNORED/anyways/pipeline-holdouts/phase2-v1-20260731/score-sheets/`. They are identity-free, hide pipeline/model/provider/runtime/cost metadata, and remain unscored.

The packages are not ready for substantive blind article scoring because no final article was materialized. The blank records are prepared for a future rerun.

## 13. Production-state and cleanup confirmation

- No Supabase writes, Newsroom mutations, queue submissions, publication actions, image actions, discovery actions, migrations, deployment, commit, push, or controller restart.
- The normal flag remains false; the true value existed only in the holdout process environment.
- No duplicate provider calls and no automatic fourth call.
- Raw provider streams and failure artifacts are retained under the ignored holdout directory.

## 14. Tests and validation

- Focused Phase 2 tests passed before the holdout.
- Immutable frozen benchmark validator passed before and after the holdout.
- The repository benchmark validator remains unable to validate the current controller tree because the working controller contains the Phase 2 changes captured outside frozen v1.0.3; this is recorded as a benchmark-oracle limitation, not a holdout mutation.
- Post-holdout `npm test`: 289 passed.
- Post-holdout `npm run lint`: passed.
- Post-holdout `npm run build`: passed; Wrangler ran in dry-run mode only.
- Post-holdout controller `npm test`: 11 passed.
- Post-holdout controller `npm run build`: passed.
- Post-holdout `git diff --check`: passed after normalizing generated bundle whitespace.

## 15. Defects

| ID | Severity | Category | Blocking | Root cause / recommended fix |
|---|---|---|---|---|
| D1 | P1 | schema-contract | yes | Terra returned blockers as strings, while the Phase 1 schema requires blocker objects. The prompt output example only showed an empty blockers array and did not show the required object shape. Recommended fix: Make the prompt show the complete blocker object schema, align the schema and prompt contract, and add a model-shaped integration test. Preserve fail-closed behavior and do not use a repair call during this holdout. |
| D2 | P1 | evidence-input-sufficiency | yes | Each approved commission froze only one direct source URL although the assigned Meanwhile and Systems contracts require multiple independent or primary sources. Terra correctly identified the missing evidence, but the schema defect prevented the intended research_blocked result from being retained cleanly. Recommended fix: Require the commissioning boundary to freeze enough accessible direct source URLs for the selected form, or explicitly authorize a bounded research provider in a later approved phase. Do not substitute sources into this run. |
| D3 | P1 | source-availability | yes | The commissioned Fast Company URL for case-03 returned HTTP 403 during the one-time source freeze. Recommended fix: At commissioning time, require an accessible approved source snapshot or an explicitly approved alternate direct URL. Do not add automatic source substitution or refetch after packet freeze. |
| D4 | P1 | failure-telemetry | yes | A Terra provider call can succeed and return usage, but validation failure occurs before completeStage records usage. The run summary therefore reports zero model usage and zero cost even though adapter telemetry records 0.977 and 0.8287 credits. Recommended fix: Persist provider usage and raw response metadata on every attempted stage before schema validation can fail, while retaining the failed status and no retry. |
| D5 | P1 | failure-retention | yes | When assertPhase1Schema throws after parsing Terra output, the error does not carry the raw response, so failStage cannot retain it in the Phase 2 attempt artifact. This holdout runner separately retained the raw adapter stream, but the production state path would not. Recommended fix: Attach the parsed-stage raw response to validation errors or pass rawResponse explicitly into failStage for every failed provider attempt. |
| D6 | P2 | legacy-isolation | no | The legacy path requires the shared live Ollama daemon and qwen3:14b. The live controller remained running by instruction, and no separate legacy worker or resource lock could guarantee exact isolation. Recommended fix: Provide a dedicated isolated Ollama instance or an explicitly approved maintenance mode with an enforceable resource lock before attempting a legacy comparison. |

Affected file paths for every defect are in `failures/defects.json`.

## 16. Blind human scoring readiness

**Not ready for substantive scoring.** The packages and blank sheets exist, but this run produced no final articles. Human scoring must remain unperformed.

## 17. Report path

- `/Volumes/External/GitHub/IGNORED/anyways/PIPELINE_V1_HOLDOUT.md`
- Ignored artifacts: `/Volumes/External/GitHub/IGNORED/anyways/pipeline-holdouts/phase2-v1-20260731`

No production enablement or Phase 3 work was started.
