# Anyways Phase 2 Engineering Summary

## Scope and status

This document describes the implemented Phase 2 pipeline contracts, execution boundaries, persistence model, and the engineering lessons captured during isolated validation. Phase 2 is an additive, fail-closed path. It is not the default production path: `PIPELINE_V1_ENABLED` remains `false` unless explicitly enabled for an authorized isolated operation. No part of this summary authorizes a holdout rerun, production enablement, publication, or Phase 3.

The main source files are:

- `src/pipeline/phase2-orchestrator.mjs`: orchestration, provider ordering, packet freezing, reviews, and terminalization.
- `src/pipeline/phase2-state.mjs`: run, attempt, stage, identity, and terminal-state invariants.
- `src/pipeline/phase2-inventory.mjs`: canonical retained-source inventory serialization and hashing.
- `src/pipeline/phase1-schemas.mjs`, `src/pipeline/phase2-evidence.mjs`, and `src/pipeline/luna-support.mjs`: provider and evidence validation.
- `src/pipeline/evidence-packet.mjs`: bounded packet construction and stable evidence IDs.
- `src/pipeline/phase2-persistence.mjs`: additive persistence payloads and Supabase RPC integration.
- `src/pipeline/phase2-package-materialization.mjs`: offline canonical AI Review and blind-package materialization.
- `PIPELINE_V1_DESIGN.md`: approved architectural intent and phase boundaries.

## Architecture

Phase 2 is an article-first, source-first workflow with deterministic gates around every model boundary:

```text
approved assignment
  -> frozen retained-source inventory
  -> source gate and packet-size preflight
  -> assignment claim-readiness verification
  -> Terra High research and evidence references
  -> deterministic offset validation and excerpt extraction
  -> frozen evidence packet
  -> Luna High Draft
  -> deterministic draft review
  -> Luna High Revision
  -> deterministic final review
  -> isolated AI Review package
  -> identity-free blind package and human decision
```

The orchestration layer owns sequencing and fail-closed behavior. Inventory and packet modules own canonical representations. Schema and evidence modules validate model output. State and persistence modules retain the complete audit trail. Package materialization is deliberately offline and reconstructs the canonical retained-document representation from frozen source inventory and execution retention before the strict review-package validator runs.

The normal Phase 2 cloud-call budget is three calls per evidence-ready case: Terra High once, Luna High Draft once, and Luna High Revision once. A valid Terra publication blocker ends the case at `research_blocked` and consumes no Luna calls. There are no automatic retries, no fourth call, no source refetch after freeze, and no automatic publication.

The legacy active path remains separate. It is article-first and local-model based, with `qwen3:14b` as the current writer default. The legacy structured harness is retained for regression and controlled comparison; it is not an implicit fallback for Phase 2 and must not be conflated with an isolated holdout.

## State machine

The stage state and the run status are separate concerns.

```text
commissioned
    -> preparing_evidence
    -> researching
       |-> research_blocked       [terminal case outcome; no Luna]
       |-> evidence_ready
           -> drafting
           -> draft_ready
           -> revising
           -> ai_review_ready      [human review handoff]

Any active stage -> failed                 [terminal failure]
```

The run has `status: running` while work is active and terminalizes as `complete`, `blocked`, or `failed`. Each provider attempt independently terminalizes as `complete`, `failed`, or `skipped`. A run is not terminal merely because a provider returned; it must have `finished_at`, every started attempt must be terminal, and persisted provider-attempt counts must equal the run's provider-call count for Terra, Draft, and Revision.

Every state transition carries `holdout_run_id` and `case_run_id`. A holdout uses one shared parent ID; each canonical case has one stable child ID. A record that supplies only an ambiguous `run_id` is not sufficient for Phase 2 identity validation.

## Contracts

| Contract | Version or rule | Purpose |
| --- | --- | --- |
| Pipeline | `pipeline-v1` | Separates Phase 2 infrastructure from the default pipeline. |
| Source inventory | `phase2-inventory-v2` | Defines the canonical retained-source representation and hash. |
| Terra evidence | `terra-evidence-offsets-v1` | Terra returns source IDs and character ranges, never copied excerpts. |
| Frozen packet | `pipeline-v1-evidence-packet-offsets-v1` | Defines the deterministic packet supplied to Draft and Revision. |
| Luna execution lifecycle | `phase2-luna-execution-v1` | Sealed nonce, exactly-once Draft/Revision harness for Luna-only validation. |
| Package materialization | `phase2-package-materialization-v1` | Offline construction of canonical review and blind artifacts. |
| Luna output | Evidence-reference schema | Luna returns claim/evidence mappings and article text, not model-authored evidence text. |

The contract rules are additive and explicit. Missing version fields are not interpreted as a compatible version. Raw provider responses, provider usage, parse outcomes, schema outcomes, validation diagnostics, and derived artifacts are retained separately. Historical holdout artifacts remain immutable.

## Packet format

The packet is built only after the source gate, packet-size preflight, claim-readiness gate, Terra schema validation, and offset validation pass. It contains the frozen assignment context, bounded canonical source records, claims and claim targets, required facts, prohibited claims, unresolved questions, contradictions, blockers, missing evidence, draft constraints, and deterministic evidence records.

The evidence record is the authoritative bridge from a source to an article claim:

```json
{
  "evidence_id": "evidence-001",
  "source_id": "source-001",
  "start_offset": 120,
  "end_offset": 284,
  "range_length": 164,
  "excerpt": "Exact substring derived from retained_text.",
  "excerpt_sha256": "...",
  "source_text_sha256": "...",
  "claim_ids": ["claim-001"],
  "evidence_role": "must_use",
  "reason": "Supports the claim."
}
```

`excerpt` and both checksums are deterministic derived fields. Terra supplies only `source_id`, `start_offset`, `end_offset`, `claim_ids`, `evidence_role`, and `reason`. Offsets are zero-based JavaScript string indices into the exact UTF-8-decoded `retained_text`, with an inclusive start and exclusive end. No trimming, entity decoding, whitespace collapsing, newline conversion, Unicode normalization, ellipsis insertion, or cross-span joining is allowed.

The packet bounds are 12 sources, 4,000 characters per source excerpt, 48,000 total excerpt characters, 64,000 serialized packet characters, and 16,000 estimated tokens. The packet serializer sorts object keys and uses deterministic source and evidence ordering. Draft and Revision receive the same frozen packet, claim ledger, draft constraints, and packet checksum.

## Checksum namespaces

Each checksum names one representation. No generic inventory or packet checksum may be reused for another representation.

| Field | Representation and lifecycle |
| --- | --- |
| `readiness_inventory_sha256` | Immutable checksum sealed in the approved readiness package. |
| `runtime_inventory_sha256` | Canonical inventory reconstructed for execution. It must equal the readiness checksum. |
| `terra_input_packet_sha256` | Fully serialized Terra input, including assignment and metadata. |
| `frozen_evidence_packet_sha256` | Deterministic evidence packet created after valid Terra offsets. |
| `draft_input_sha256` | Complete Luna Draft input. |
| `revision_input_sha256` | Complete Luna Revision input. |

The canonical inventory serializer uses deterministic key order and source order and includes only the approved source fields: source identity and metadata, exact retained text, retained-text hash and length, raw-content hashes, and capture mode. It excludes timestamps, paths, runtime IDs, provider metadata, packet metadata, and retrieval diagnostics. Before provider construction, Phase 2 recomputes the readiness inventory, reconstructs the runtime inventory, and aborts on either mismatch. Derived Terra, evidence, Draft, and Revision hashes are persisted alongside the inventory identity, never in place of it.

## Persistence model

Phase 2 maintains an in-memory state model for isolated execution and an additive persistence adapter for durable storage. The state contains phase2 runs, attempts, artifacts, research packets, and review packages. Persistence is idempotent by `case_run_id` and stage and preserves retained raw response and usage data even when later external persistence fails.

Relevant records include:

- run identity, candidate, pipeline and contract versions, state, status, timestamps, assignments, all checksum namespaces, source gate, preflight, usage, cost, provider-call and retry counts, events, source fetches, attempts, and terminal errors;
- attempt identity, stage, attempt number, provider and model metadata, lifecycle timestamps, raw response, redacted provider events and diagnostics, usage, validation errors, outcomes, retention status, and checksum namespaces;
- research artifacts and frozen packets, including claims, source support, blockers, contradictions, missing evidence, constraints, offsets, exact derived excerpts, and packet checksum;
- review artifacts, including Draft and Revision outputs, claim-support mappings, cited evidence IDs, deterministic findings, quote-integrity findings, and the frozen packet checksum;
- holdout summaries, including operational validity, final acceptance status, per-case results, blockers, packet-reuse status, package paths, audit results, and cleanup state.

The Supabase migration and RPC additions are additive. Validation has used migration inspection and dry validation without applying production migrations. Production rollout therefore requires a separately approved migration, backup, RLS, and service-role verification.

## Provider contracts

### Terra High

Terra receives only the frozen source inventory, assignment, claim ledger, and required metadata. It must return strict JSON matching the Terra schema. Source IDs must come from the supplied inventory. Claims reference source IDs and offset records. Offsets must be valid, bounded, nonblank, within the excerpt limit, and tied to known claim IDs. Blockers are publication blockers only: unsupported required claims, unverifiable central assertions, material conflicts, unavailable mandatory evidence, unsatisfiable story-form requirements, speculation-dependent causal framing, or legal, safety, fairness, or attribution barriers. Optional enrichment belongs in `missing_evidence`.

`ready_to_draft: true` means a defensible article can be written from the frozen packet while obeying the nonempty `draft_constraints`; it does not mean the reporting is exhaustive. A valid blocker is persisted and propagated to the research artifact, terminal result, case summary, and holdout summary. No Luna call follows it.

### Luna High Draft and Revision

Luna receives the exact frozen packet and must return article prose plus a compact support matrix:

```json
{
  "headline": "Article headline",
  "dek": "Optional dek",
  "body_markdown": "Complete article",
  "claim_support": [
    {
      "claim_id": "claim-001",
      "evidence_ids": ["evidence-001"],
      "article_anchor": "paragraph-01",
      "treatment": "paraphrase"
    }
  ],
  "warnings": []
}
```

Valid treatments are `paraphrase`, `direct_quote`, `attributed_claim`, and `context`. Evidence IDs and claim IDs must exist in the frozen packet and claim ledger. Required claims need appropriate support mappings. The model may not return excerpts, source text, excerpt checksums, or copied evidence objects.

Direct quotations are checked deterministically against the exact frozen evidence excerpt or retained source text. Quotation marks may be excluded from comparison, but whitespace, Unicode, punctuation, HTML entities, and span boundaries are not normalized. Ellipsis-joined or transformed quotations fail closed. Paraphrases do not require word equality, but they must have valid claim/evidence mappings and remain within draft constraints. Revision receives the identical non-null frozen packet checksum and the same IDs, ledger, and constraints. Invalid Draft output retains raw response and usage, terminalizes the Draft attempt, and skips Revision without a retry.

### Review and materialization

Deterministic Draft review checks support mappings, direct quotes, claim scope, constraints, and article structure. Final review repeats these checks after Revision. The strict review-package validator requires the canonical retained documents, complete retention metadata, owned claims and source IDs, and the exact approved document set. The offline package materializer now uses the same canonical retained-document representation as evidence and deterministic review validation, verifies source and range checksums and Revision byte equality, then creates the AI Review package, identity-free blind package, blank score sheet, and sealed mapping.

## Lessons learned

1. Source-count readiness is not claim readiness. Each assignment needs a required-claim ledger with direct support, primary-source checks, independent corroboration, and explicit constraints.
2. Evidence must be selected by reference, not reproduced by a model. Offsets make omitted text, ellipsis joining, and HTML-entity transformation structurally impossible at the Terra boundary.
3. Luna should cite stable evidence IDs. Requiring article prose to reproduce evidence text confused paraphrase with quotation and caused valid drafting to fail.
4. A blocker is a publication blocker, not a list of desirable reporting. Optional context belongs in `missing_evidence`, while constraints bound a defensible article and never replace missing required evidence.
5. Null equality is not packet reuse. Reuse is an explicit enum: `verified`, `mismatch`, `missing`, or `not_applicable`.
6. Identity has two levels. The holdout parent and case child must travel through every attempt, artifact, metric, package, persistence payload, and audit record.
7. Checksum names must follow representation boundaries. A derived packet checksum must never overwrite the frozen inventory checksum.
8. Raw output and usage must be retained before parsing. This preserves forensic evidence for schema, offset, quotation, persistence, and provider-accounting failures.
9. Strict package validation exposed a representation drift bug. Evidence validation, deterministic review, and package materialization must share one canonical retained-document model.
10. Terminality alone is not success. Operational validity, editorial outcome, package-count thresholds, packet reuse, isolation, and cleanup all contribute to final holdout status.

## Known limitations

- Phase 2 remains disabled globally and has been validated in isolated or in-memory workflows, not as a production enablement.
- The additive Supabase schema changes have not been applied as part of these validations. Durable production persistence, RLS behavior, backup, and migration rollback remain rollout gates.
- Some full controller, PostgreSQL, `tsx`, and `tsc` checks have been unavailable in the local environment. Where applicable, Node tests and immutable benchmark validation were used, and the tooling limitation was recorded rather than hidden.
- The benchmark has a distinction between the approved immutable snapshot and mutable controller-tree drift. Snapshot validation can pass while the live tree still has unrelated drift; this must remain a separately reported condition.
- The current production path still uses the legacy article-first workflow and `qwen3:14b`. Qwen3.6 27B is not a Phase 2 prerequisite and must not be installed or inferred as ready from configuration alone.
- USD estimates may be unavailable. Reporting must use `null` or an explicit unavailable value, not `$0`, when no price snapshot exists. Search-cost placeholders also require an approved production price snapshot.
- Human editorial review and scoring remain mandatory. AI Review packaging does not imply approval or publication, and there is no automatic publish path.
- Evidence packets are intentionally bounded. A candidate whose defensible retained evidence exceeds the packet limits must fail preflight or be rejected during readiness preparation, not be silently truncated.
- Controller queue, lease, lock, timeout, resident-model, temporary-workspace, and credential-copy behavior require live production verification before enablement. A healthy process check alone is insufficient.
- The package materializer still depends on a sealed execution retention marker. Future harnesses should create and seal canonical retained-document metadata at freeze instead of reconstructing it late.

## Phase 3 assumptions

These are prerequisites and design assumptions, not an authorization to begin Phase 3:

1. Phase 3 starts only after human review of Phase 2 outputs, a fresh approved plan, and an explicit production-enablement decision. There is no automatic phase transition.
2. Qwen3.6 27B, if selected for Phase 3 triage, is installed, digest-pinned, isolated from production workloads, and measured against the routine-role throughput gate. A single resident local model and safe lifecycle are assumed unless a separately approved routing design exists.
3. Phase 3 preserves the Phase 2 identity, checksum, source-retention, evidence-reference, packet, and fail-closed principles. Any schema change receives an explicit new contract version; missing fields do not imply compatibility.
4. The production persistence path has additive migrations, backup and rollback procedures, RLS checks, and service-role authorization validated before any live run.
5. Controller resource classes, deadlines, queue behavior, leases, locks, cleanup, temporary workspaces, credential handling, and resident-model checks have been verified under the intended production load.
6. Discovery and triage may use local Qwen for clustering or prioritization, but provider browsing, claim invention, source substitution, automatic publication, and bypassing human assignment approval remain out of scope.
7. Paid provider and search costs have an approved price snapshot, budget limits, and attribution model. Model fallback or automatic multi-model routing is not assumed without a new approved design.
8. Human gates remain explicit: pitch approval, evidence readiness, AI Review, blind scoring where required, and a separate editorial publication decision.
9. Historical holdout artifacts and benchmark fixtures remain immutable. Any new run, package, or migration is additive and independently identified.

