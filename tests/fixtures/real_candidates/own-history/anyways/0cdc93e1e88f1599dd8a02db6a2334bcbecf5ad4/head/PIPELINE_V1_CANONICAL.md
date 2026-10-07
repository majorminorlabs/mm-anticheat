# Anyways Pipeline V1 Canonical Operations

This is the operational source of truth for rebuilding, activating, operating,
and rolling back Anyways Pipeline V1. It describes the production path as it is
implemented, not the historical benchmark or holdout paths.

Pipeline V1 is currently released in code and database state, but remains
globally disabled:

```text
PIPELINE_V1_ENABLED=false
PIPELINE_V1_ALLOWED_JOB_ID=(unset in the normal environment)
```

The scoped allow-list is the canonical controlled-smoke mechanism. It permits
one exact queue job to use V1 while all other work remains on the legacy path.
Global enablement is a separate operational decision and is not part of a
normal build, migration, deploy, or restart.

Autonomous discovery is a separate pre-commission stage now owned by the
Source Graph Worker and the local Qwen controller:

```text
scheduled Source Graph ingestion
  -> deterministic score and threshold
  -> Qwen editorial pitch in Newsroom Pitches
  -> human commission
  -> Pipeline V1 below
```

Qwen discovery pitches do not create articles. The V1 contract below begins
only after an editor commissions a valid pitch.

## 1. Production contract

Pipeline V1 is a durable, human-gated editorial pipeline:

```text
deterministic sources
  -> Luna High discovery and pitch
  -> human pitch approval and research decision
  -> deterministic retained evidence or conditional Terra High research
  -> frozen evidence packet
  -> Luna High Draft
  -> deterministic validation and source-link materialization
  -> human AI Review
  -> optional human-authorized Sol Medium polish
  -> human approval to On Deck
  -> existing publication or scheduling workflow
```

The pipeline never publishes automatically. AI Review, On Deck approval, and
publication are separate human actions.

### Model policy

| Role | Provider/model | Reasoning | Invocation rule |
| --- | --- | --- | --- |
| Discovery and pitch | Codex / `gpt-5.6-luna` | `high` | Runs when discovery or pitch generation is explicitly commissioned. |
| Research and evidence selection | Codex / `gpt-5.6-terra` | `high` | Runs exactly once only when the approved pitch says `research_requirement: required`. |
| Draft | Codex / `gpt-5.6-luna` | `high` | Runs once after the packet is frozen and all pre-draft gates pass. |
| Copy polish | Codex / `gpt-5.6-sol` | `medium` | Runs only after an explicit human `Polish with Sol` authorization. |
| Legacy fallback writer | Ollama / `qwen3:14b` | local configuration | Used by unversioned legacy jobs and remains available for rollback. |

There is no automatic Luna Revision, automatic Sol pass, automatic research
again, or automatic fourth cloud call. Historical revision and benchmark code
may remain for compatibility, but it is not reachable from the normal V1
orchestrator.

## 2. Stages and gates

### Stage 0: deterministic source aggregation

The existing source system aggregates enabled sources and retains source
records. V1 consumes retained, checksum-identified records. V1 does not ask a
model to invent URLs or fetch an unconstrained source set during drafting.

Before commissioning, the editor-visible package must identify:

- assignment and story form;
- source IDs, titles, publishers, URLs, classifications, and independence keys;
- retained text and its checksum;
- the claim ledger and required claims;
- draft constraints and the source/claim evidence plan;
- the explicit research decision.

### Stage 1: Luna High discovery and pitch

Discovery and pitch generation use Luna High. The pitch schema requires an
accepted pitch to contain `research_requirement`, with exactly one of:

```json
{ "research_requirement": "none" }
```

or:

```json
{ "research_requirement": "required" }
```

The decision is made before commissioning and is visible to the editor. A
pitch is not a V1 commission merely because Luna generated it; a human editor
must approve it.

### Stage 2: human approval and commission

The canonical RPC is:

```text
public.commission_editorial_pitch_v1(
  p_candidate_external_id text,
  p_priority integer,
  p_requested_by uuid,
  p_research_requirement text
) returns uuid
```

It validates the editor, candidate, approved pitch, research decision, and
candidate status. It inserts one `process_candidate` job with:

```json
{
  "candidate_id": "<external id>",
  "pipeline_version": "v1",
  "research_requirement": "none|required"
}
```

and `max_attempts = 1` at creation time. It returns the queue job UUID
directly. It must not create a legacy job and relabel it after the fact.

An advisory lock and active-job check make the commission idempotent. A
legacy active job cannot be silently converted to V1.

### Stage 3: deterministic preflight and source gates

The controller claims the job only after normal queue and provider-readiness
checks. The V1 runner then validates the retained package and deterministic
identities. The gates include:

- story-form source minimum;
- independent-source minimum;
- primary-source requirement;
- accessible retained text for every required source;
- required-claim completeness;
- packet-size and per-source character limits;
- assignment, readiness, runtime, evidence-input, claim-ledger, and draft
  constraint checksums;
- taxonomy and source classifications;
- approved pitch validity and research decision consistency;
- Phase 1 schema and identity contracts.

Failure at this point is fail-closed. It does not call Terra or Luna. An
insufficient retained package becomes `research_blocked`; it is not silently
upgraded to a research call.

### Stage 4a: research requirement `none`

For `none`, the pipeline constructs the claim ledger and evidence packet
deterministically from the approved retained source set. It validates source
IDs, claim IDs, evidence ranges, source identity, packet limits, claims, and
checksums. No Terra process is started.

If the retained evidence cannot satisfy the gates, the run becomes
`research_blocked`. The deterministic work does not consume a Terra provider
call slot.

### Stage 4b: research requirement `required`

For `required`, V1 calls Terra High exactly once. Terra receives the frozen
inventory and research packet and must return the structured evidence contract.
The runtime validates:

- JSON parsing and schema;
- known source IDs;
- valid claim IDs;
- non-empty, ordered offset ranges;
- offsets within retained source text and valid Unicode boundaries;
- excerpt length limits;
- evidence roles, claims, contradictions, quotations, names, and numbers;
- packet identity and checksum inputs.

An invalid, missing, or insufficient Terra result becomes a terminal research
blocker. A second Terra call requires the existing explicit human
`research_again` action. There is no automatic research retry.

### Stage 5: frozen evidence packet

The packet is frozen only after the deterministic or Terra path passes. It is
persisted durably through `persist_pipeline_phase2_stage_v3`, together with
the source set, claims, claim/evidence relationships, checksums, provider
call records, usage, and cost object.

The frozen packet is the only evidence input Luna may use. After freeze, the
V1 path does not refetch or replace source text. The packet checksum is the
identity used by later review and polish validation.

### Stage 6: Luna High Draft

Luna High receives the frozen packet, assignment, constraints, and the strict
Draft schema. Luna must return the requested article fields and claim-support
mappings. The runtime validates every referenced claim, evidence ID, source
ID, treatment, section, and required claim.

The external call count changes only when the Codex provider process actually
starts. Deterministic preparation, prompt construction, preflight, and schema
setup do not count as provider calls. A started provider process counts as one
call even if it exits unsuccessfully or returns invalid output.

### Stage 7: deterministic review

The Draft is validated without another model call. Deterministic review checks:

- Draft schema and required fields;
- article length and story-form constraints;
- required claim coverage and permitted evidence;
- claim-support mappings and repeated anchors;
- quotation exactness;
- source-link identity and frozen packet membership;
- reader-visible numbers and proper names against the packet and linked evidence;
- Markdown structure and prohibited constructions;
- headline, dek, angle, and section constraints;
- checksum identities and persistence invariants.

Deterministic source links are rendered adjacent to paragraph or claim anchors
in AI Review. Each link shows the frozen source title, publisher, and URL. A
link is valid only when its source belongs to the frozen packet. Prose-level
URL invention is not part of this stage.

Advisory findings may proceed to human AI Review. Blocking findings fail
closed and do not trigger an automatic rewrite. A clean Draft proceeds
directly to AI Review.

### Stage 8: human AI Review

AI Review exposes the Draft, deterministic findings, frozen evidence, claims,
source links, usage, credits, USD estimate, checksums, blockers, warnings,
model, and stage history. The editor decides whether the article needs a
manual polish, can move to On Deck, or must be held.

### Stage 9: optional Sol Medium polish

`Polish with Sol` is a separate human-authorized action. Sol is a restrained
copy editor and may change only grammar, punctuation, awkward wording,
unnecessary repetition, sentence rhythm, small transitions, and clarity.

Sol must preserve the headline, dek, paragraph count/order, angle, factual
claims, quotations, links, Markdown structure, claim IDs, evidence IDs,
relationships, source relationships, and article length range. It must not
add claims, facts, examples, metaphors, sources, rhetorical contrast, em
dashes, a new conclusion, or structural rewriting.

Sol returns structured changes and warnings. Deterministic validation compares
the original and polished Draft, including claims, evidence, links, quotes,
names, numbers, paragraph structure, length, and prohibited style. The
original Draft remains recoverable. Accept, reject, and restore require an
explicit actor and timestamp.

Sol is never called automatically and never runs as part of the normal Draft
path.

### Stage 10: editorial approval and publication

After AI Review, and after any optional Sol decision, the existing newsroom
workflow handles human approval to On Deck. Publication and scheduling remain
separate actions. No V1 RPC or controller action publishes an article.

## 3. Calls, attempts, retries, and invariants

### Canonical accounting

The runtime distinguishes:

- **stage attempt**: an execution attempt for deterministic or provider-backed
  work;
- **provider call**: an actual external Codex/provider invocation.

Deterministic source processing, source and claim gates, packet construction,
checksum work, persistence, deterministic review, provider readiness, and
Draft setup have zero provider calls. Only `markProviderCallStarted` after
the external adapter invocation begins increments the canonical call record.

All usage, terminal invariants, maximum-call enforcement, and observability
read the same provider-call records. A duplicate call fails closed.

### V1 limits

| Operation | Automatic maximum |
| --- | ---: |
| Terra High | 0 for `none`; 1 for `required` |
| Luna High Draft | 1 |
| Luna Revision | 0 |
| Sol Medium | 0 automatically |
| Total automatic cloud calls | No fourth call; normal path is 1, or 2 when Terra is required |
| Queue attempts | 1 (`max_attempts = 1`) |

There is no automatic retry after a provider process starts. A provider
failure, invalid response, timeout, or persistence failure remains recorded
with its raw diagnostic and terminal state. Human-authorized research-again
and Sol are separate actions, not retries hidden inside the original job.

Legacy jobs retain their existing retry policy and local-heavy routing. That
policy must not be applied to a V1 job.

### Terminal behavior

Typical terminal states are:

- `research_blocked`: deterministic evidence or Terra contract cannot satisfy
  the research gate;
- `verification_failed`: a failed/aborted V1 processing attempt leaves the
  candidate in a terminal verification state;
- `failed`: an unrecoverable contract, provider, persistence, or integrity
  failure;
- `ready_for_review`: Draft and deterministic review artifacts are available;
- `completed`: the queue job completed its command; this does not mean the
  article was published.

Lease expiry, cancellation, or controller shutdown must terminalize the V1
  job/attempt/run/candidate consistently, release its lease and resource lock,
  retain diagnostics, and never make it automatically retryable.

## 4. Usage and cost

Every provider response records:

```json
{
  "provider": "codex",
  "model": "gpt-5.6-luna",
  "reasoning": "high",
  "stage": "draft",
  "attempt": 1,
  "input_tokens": 0,
  "cached_input_tokens": 0,
  "output_tokens": 0,
  "reasoning_output_tokens": 0,
  "credits": 0,
  "estimated_cost_usd": null,
  "wall_ms": 0
}
```

The actual values come from the provider adapter. Credit rates are defined in
`src/pipeline/config.mjs` and calculated by `src/pipeline/cost.mjs`. The
durable cost object is:

```json
{ "credits": 0.10627, "estimated_cost_usd": null }
```

when the provider reports that usage and no USD conversion is configured.
`null` means unavailable; it must not be replaced with a fake zero. A
configured `ANYWAYS_CODEX_CREDIT_USD` converts credits to an estimate.
Deterministic stages have no provider usage and persist a null USD estimate.

## 5. Controller contract

The controller is the single durable-queue consumer and owns the health
listener on `127.0.0.1:4317`.

### Startup and shutdown

1. LaunchAgent loads the controller with the protected `.env`.
2. The process validates its repository path and Codex executable.
3. The health listener is acquired and initialized.
4. Ollama and Codex readiness are recorded.
5. Only after initialization does queue polling start.
6. A restart stops the old LaunchAgent, waits for its PID to exit, verifies
   port 4317 is free, then starts the replacement.

The controller refuses ambiguous listener ownership. It must never start a
second consumer or claim work before listener ownership and provider readiness
are stable. On shutdown it stops new claims, drains or explicitly interrupts
the in-flight job, releases locks, and closes the listener.

### Routing and resources

V1 requires both:

```text
job.parameters.pipeline_version = "v1"
and
(PIPELINE_V1_ENABLED=true OR job.id = PIPELINE_V1_ALLOWED_JOB_ID)
```

When the global flag is false, a nonmatching V1 job is not eligible for the
cloud route. Unversioned jobs continue to the legacy local-heavy route. V1
uses the `cloud_codex_generation` resource lock. Legacy model work uses the
`heavy_model` lock.

V1 defaults to:

```text
PHASE2_JOB_TIMEOUT_SECONDS=2400
max_attempts=1 at job creation
heartbeat every 30 seconds
lease duration 120 seconds
```

The queue/database is operational truth. The browser never connects directly
to the Mac controller. Controller logs must not contain secrets.

### Provider readiness

`ANYWAYS_CODEX_BIN` must be an absolute executable path. The controller uses
that exact path with `shell: false` for version and login checks and for the
provider subprocess. Under the current LaunchAgent it is:

```text
/Users/dippo/.nvm/versions/node/v24.14.1/bin/codex
```

This is machine-specific. Rebuilds must resolve the installed executable,
write it into the protected controller environment, render the LaunchAgent
plist, and verify `codex --version` plus `codex login status` before allowing a
V1 claim. Missing provider readiness blocks V1 claims but does not remove the
legacy fallback.

## 6. Environment variables

### Anyways application

Use `.env.example` as the complete template. Secret values are never checked
into Git or printed.

```text
SUPABASE_URL=<project URL>
SUPABASE_ANON_KEY=<browser key>
SUPABASE_SERVICE_ROLE_KEY=<server key>

ANYWAYS_CODEX_BIN=/absolute/path/to/codex
ANYWAYS_CODEX_AUTH_FILE=<optional isolated auth file>
ANYWAYS_CODEX_CLI_VERSION=codex-cli 0.146.0
ANYWAYS_CODEX_GENERATION_DEADLINE_MS=600000
ANYWAYS_CODEX_KILL_GRACE_MS=2000
ANYWAYS_CODEX_CREDIT_USD=<optional conversion rate>

PIPELINE_V1_ENABLED=false
PIPELINE_V1_ALLOWED_JOB_ID=
ANYWAYS_DISCOVERY_MODEL=gpt-5.6-luna
ANYWAYS_DISCOVERY_REASONING=high
ANYWAYS_RESEARCH_MODEL=gpt-5.6-terra
ANYWAYS_RESEARCH_REASONING=high
ANYWAYS_DRAFT_MODEL=gpt-5.6-luna
ANYWAYS_DRAFT_REASONING=high
ANYWAYS_POLISH_MODEL=gpt-5.6-sol
ANYWAYS_POLISH_REASONING=medium

ANYWAYS_PITCH_MODEL=gpt-5.6-luna
ANYWAYS_PITCH_REASONING_EFFORT=high
ANYWAYS_PITCH_TIMEOUT_MS=600000
ANYWAYS_LOCAL_WRITER_MODEL=qwen3:14b
```

Research and local fallback settings in `.env.example` remain part of the
source aggregation and legacy compatibility surface. Do not place benchmark
candidate models or holdout adapters in production configuration.

### Controller

The controller `.env.example` is authoritative for controller-only settings:

```text
SUPABASE_URL=<project URL>
SUPABASE_SERVICE_ROLE_KEY=<server key>
ANYWAYS_REPO_PATH=/Volumes/External/GitHub/IGNORED/anyways
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:14b
ANYWAYS_CODEX_BIN=/absolute/path/to/codex
PIPELINE_V1_ENABLED=false
PIPELINE_V1_ALLOWED_JOB_ID=
CONTROLLER_ID=<optional stable identifier>
POLL_INTERVAL_SECONDS=5
LEASE_DURATION_SECONDS=120
HEARTBEAT_INTERVAL_SECONDS=30
MODEL_IDLE_TIMEOUT_MINUTES=10
MINIMUM_AVAILABLE_MEMORY_GB=6
MAX_PARALLEL_HEAVY_JOBS=1
HEALTH_HOST=127.0.0.1
HEALTH_PORT=4317
LOG_DIRECTORY=<optional log directory>
JOB_TIMEOUT_SECONDS=900
PHASE2_JOB_TIMEOUT_SECONDS=2400
CHILD_KILL_GRACE_SECONDS=5
MAX_ATTEMPTS=3
BASE_RETRY_DELAY_SECONDS=60
```

`MAX_ATTEMPTS` is a legacy controller default. A V1 commissioning RPC writes
`max_attempts = 1` to the job and the controller preserves that job-level
limit.

## 7. Activation procedure

### Release preflight

Before changing production state:

1. Review `git status --short --ignored`, diff stat, name status, and diff
   check in both repositories.
2. Classify and exclude benchmark, holdout, raw provider output, generated,
   ignored secret, and unrelated user files.
3. Confirm the legacy orchestrator, Ollama adapter, schemas, workflow, and
   tests remain present.
4. Record current commits/branches, controller PID, listener owner, health,
   queue, leases, locks, and applied migration list.
5. Take the normal database backup and preserve schema/RPC definitions.
6. Confirm `PIPELINE_V1_ENABLED=false` and no allow-list is present in the
   ordinary environment.
7. Build the application, Worker dry run, and controller artifact.

### Database migration

The canonical ordered migration set is:

1. `20260731130000_pipeline_phase2_artifacts.sql`
2. `20260731140000_pipeline_phase2_controls.sql`
3. `20260731150000_pipeline_phase2_terra_evidence_contract.sql`
4. `20260801120000_pipeline_phase2_checksum_namespace.sql`
5. `20260801130000_pipeline_v1_sol_polish.sql`
6. `20260801131500_pipeline_v1_commission_compatibility.sql`
7. `20260801133000_pipeline_v1_commission_wrapper_fix.sql`
8. `20260802100000_pipeline_v1_commission_canonical.sql`

Apply only unapplied files, in order, with the controller stopped and the
normal backup in place. Never edit an applied migration. Verify the migration
ledger, tables, constraints, grants, and these live RPCs before starting the
controller:

- `commission_editorial_pitch_v1`;
- `persist_pipeline_phase2_stage_v3`;
- `research_again_pipeline_v1`;
- `authorize_pipeline_v1_sol_polish`;
- `persist_pipeline_sol_polish`;
- `apply_pipeline_sol_polish_action`.

Reload the PostgREST schema cache after a function contract change:

```sql
NOTIFY pgrst, 'reload schema';
```

The current linked database has all eight migrations applied. A future
operator should confirm that state before attempting any migration command.

### Controller build and restart

```sh
cd /Volumes/External/GitHub/IGNORED/anyways
npm run controller:test
npm run controller:build
test -f /Volumes/External/GitHub/IGNORED/anyways/apps/controller/dist/src/index.js
npm run controller:restart
curl -fsS http://127.0.0.1:4317/health
```

Verify exactly one LaunchAgent PID owns port 4317, health is `ok`, queue
connectivity is true, Codex readiness is true, the queue is idle, leases and
locks are zero, and the controller’s built V1 timeout is 2,400 seconds.

### Scoped smoke activation

Keep the controller stopped while creating the smoke job:

1. Confirm port 4317 is free, queue empty, leases zero, and locks free.
2. Create one publication-ineligible candidate from an approved, retained,
   checksum-valid source package.
3. Call `commission_editorial_pitch_v1` exactly once.
4. Capture the returned UUID and verify before starting the controller:
   `pipeline_version=v1`, `max_attempts=1`, the approved research decision,
   queued state, no lease, and no other queued V1 job.
5. Set `PIPELINE_V1_ALLOWED_JOB_ID` to that UUID while leaving the global flag
   false.
6. Start the controller once through LaunchAgent.
7. Verify one PID, one listener, Codex readiness, and exact allow-list routing.
8. Execute the job once. Do not restart during execution.
9. Verify the expected provider calls, frozen packet, Draft, deterministic
   review, AI Review, links, telemetry, and terminal state.
10. Stop before On Deck and publication.
11. Clear `PIPELINE_V1_ALLOWED_JOB_ID` immediately after terminalization and
    restart only if needed to reload the normal environment.

For `research_requirement: none`, expected calls are Terra 0, Luna Draft 1,
Luna Revision 0, Sol 0. For `required`, Terra is exactly 1 and Luna Draft is
at most 1 if Terra returns an evidence-ready result. A blocked result is a
valid operational outcome, but it is not evidence that the full Draft path
completed.

### Global activation

Global enablement is a separate change-control event. Only after the scoped
smoke, AI Review, rollback checkpoint, and editorial sign-off pass may an
operator set `PIPELINE_V1_ENABLED=true`. The change must be applied to both
the Worker environment and controller environment, followed by a controlled
restart/reload and health/queue verification. Do not combine global
enablement with migration application or an article publication action.

## 8. Rollback

Rollback preserves legacy behavior and V1 artifacts:

1. Stop new V1 submissions in the Newsroom.
2. Set `PIPELINE_V1_ENABLED=false` in both environments.
3. Clear `PIPELINE_V1_ALLOWED_JOB_ID`.
4. Stop or restart the controller through the LaunchAgent procedure as
   required; verify one listener and no active V1 lease.
5. Allow explicit terminalization of an active V1 job or cancel it using the
   normal queue action. Never retry a completed provider stage automatically.
6. Route replacement work without `pipeline_version: "v1"`.
7. Verify local `qwen3:14b` fallback and legacy tests.
8. Preserve Phase 2 artifacts, packets, checksums, review decisions, Sol
   artifacts, logs, and incident records for audit.

Migrations are forward-only in operations. Do not delete tables or edit
applied migration files during an incident. Use the database backup and the
compensating procedures in `PIPELINE_V1_ROLLBACK_RUNBOOK.md` if database
rollback is actually required.

## 9. Observability and incident handling

The operational record for every V1 job must expose:

- feature flag and scoped allow-list state;
- pipeline version and current stage;
- job, attempt, run, candidate, and controller IDs;
- provider call count and stage attempts separately;
- models and reasoning settings used;
- research requirement and Terra call count;
- assignment, inventory, packet, Draft, and polish checksums;
- claims, evidence mappings, and source links;
- blockers and warnings;
- input, cached-input, output, and reasoning tokens;
- credits and USD estimate or `null`;
- lease, resource-lock, retry, and terminal-state history;
- human review and Sol action actor/timestamp.

Controller logs must include the controller instance ID, PID, listener
acquisition, initialization, queue polling, shutdown, drain, interruption,
lease release, candidate terminalization, and restart completion. They must
not expose Supabase keys, Codex credentials, or raw authorization headers.

When JSON parsing fails, retain the exact incident copy and report the path,
size, checksum, and writer. Local state writes use atomic temporary-file plus
rename semantics. Production V1 truth is durable database state; ignored local
state is not a replacement for the queue, packet, or review records.

## 10. Rebuild checklist

Six months from now, a clean rebuild should follow this order:

1. Read this document and the repository `AGENTS.md` files.
2. Confirm the legacy fallback exists before touching V1 code.
3. Install dependencies and resolve an absolute, executable Codex path.
4. Copy `.env.example` to protected local configuration; leave V1 disabled.
5. Run the provider-free tests, full tests, lint, client build, Worker dry run,
   and controller build.
6. Review the exact migration ledger and apply only missing migrations in the
   canonical order.
7. Verify live RPC definitions and PostgREST cache state.
8. Install/render the LaunchAgent and verify one PID/listener plus provider
   readiness.
9. Perform one scoped smoke with the controller-off -> commission -> allow-list
   -> controller-start order.
10. Verify AI Review and source links without approving or publishing.
11. Clear the allow-list and confirm legacy routing.
12. Only then request a separate global activation decision.

Required validation commands:

```sh
cd /Volumes/External/GitHub/IGNORED/anyways
npm test
npm run lint
npm run build
git diff --check
supabase migration list --linked

cd /Volumes/External/GitHub/IGNORED/anyways
npm run controller:test
npm run controller:build
```

The client bundle is generated output. A generated minified bundle may report
trailing whitespace under `git diff --check`; inspect it separately from
source/test failures and do not manually rewrite bundled vendor code.

## 11. Boundaries and exclusions

The following are not production runtime inputs or commands:

- `pipeline-benchmark/**`;
- `pipeline-holdouts/**`;
- `model-benchmark/**`;
- `bin/final-discovery-benchmark.mjs`;
- raw provider outputs, blind mappings, score files, generated holdout
  directories, and benchmark adapters;
- `.env`, `.env.local`, `.dev.vars`, `.wrangler/`, `node_modules/`, local
  `data/`, and ignored pipeline state.

Preserve historical benchmark and holdout artifacts. Exclude them from
deployment and controller command registries. Do not use a benchmark or
holdout candidate as a production story.

## 12. Source documents and implementation anchors

- Architecture: `PIPELINE_V1_DESIGN.md`
- Release classification: `PIPELINE_V1_RELEASE_MANIFEST.md`
- Implementation state: `PIPELINE_V1_IMPLEMENTATION_STATUS.md`
- Migration order and checks: `PIPELINE_V1_MIGRATION_RUNBOOK.md`
- Activation procedure: `PIPELINE_V1_ACTIVATION_RUNBOOK.md`
- Scoped smoke procedure: `PIPELINE_V1_CONTROLLED_SMOKE_TEST.md`
- Rollback: `PIPELINE_V1_ROLLBACK_RUNBOOK.md`
- Application configuration: `.env.example`, `src/pipeline/config.mjs`
- V1 orchestration: `src/pipeline/phase2-orchestrator.mjs`
- Durable state and accounting: `src/pipeline/phase2-state.mjs`,
  `src/pipeline/phase2-persistence.mjs`, `src/pipeline/cost.mjs`
- Deterministic review: `src/pipeline/deterministic-review.mjs`
- Newsroom/Worker API: `src/app.mjs`, `src/worker.mjs`,
  `src/newsroom-pipeline-controls.mjs`
- Controller routing and lifecycle:
  `/Volumes/External/GitHub/IGNORED/anyways/apps/controller/src/index.ts`,
  `/Volumes/External/GitHub/IGNORED/anyways/apps/controller/src/queue/client.ts`,
  `/Volumes/External/GitHub/IGNORED/anyways/apps/controller/src/resources/classes.ts`,
  `/Volumes/External/GitHub/IGNORED/anyways/apps/controller/scripts/launchd.sh`

## 13. Current release evidence

At the time this document was finalized:

- migrations through `20260802100000_pipeline_v1_commission_canonical` were
  present in the linked migration ledger;
- the controller was healthy with one PID and one listener on 4317;
- Codex readiness passed using the configured absolute executable;
- the queue was empty, leases were zero, and resource locks were free;
- `PIPELINE_V1_ENABLED` was false and the scoped allow-list was unset;
- the retained successful V1 smoke artifacts reached AI Review with no blocking
  deterministic findings;
- no article was approved to On Deck or published by this validation;
- no benchmark, holdout, or raw provider artifact is part of the production
  runtime path.

This evidence is a release checkpoint, not a substitute for rechecking live
health, queue, migrations, flags, and deployment state during the next
activation.
