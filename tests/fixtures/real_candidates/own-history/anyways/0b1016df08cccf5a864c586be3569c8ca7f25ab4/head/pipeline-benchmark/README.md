# Anyways benchmark harness

This directory is an isolated article, revision, review, evidence-selection,
and research-planning benchmark. It does not import production pipeline code,
modify production routing, or share the production job lock.

Real model execution is disabled unless all official-run authorization flags
and production probes are supplied. The implementation tests and demo use stub
adapters only.

## Frozen Benchmark v1.0

Benchmark v1.0 is the canonical production-stable baseline. Every new model
must use it unchanged. Its definition and checksum are stored in
`config/benchmark-v1.0.json` and `config/benchmark-v1.0.sha256`.

Every run validates the frozen fixtures, prompts, doctrine, schemas,
evaluators, scoring contract, harness, lifecycle, dependency graph, generation
deadline, controller tree, and configuration before it creates a run
directory or starts generation. Any mismatch aborts with an exact artifact
diagnostic and no continuation.

Benchmark improvements belong in Benchmark v1.1 or later. Benchmark v1.0
results remain directly comparable forever. See
[`docs/BENCHMARK_V1.0.md`](docs/BENCHMARK_V1.0.md).

## Commands safe during implementation

```sh
npm run benchmark:validate
npm run benchmark:test
npm run benchmark:demo
npm run benchmark:safety-demo
npm run benchmark:dry-run
```

The demo uses two in-process stub models. It does not contact Ollama, Kimi,
Supabase, the controller, or launchd. Fixture packaging is a separate read-only
export:

```sh
node --env-file=.dev.vars pipeline-benchmark/src/cli.mjs fixtures package-apple
```

An already approved package is immutable. Re-export requires an explicit new
reviewed fixture version and `--replace`; generic approved-fixture re-freezing
requires `--replace-approved`.

## Prompt-size preflight

Validation compiles every approved fixture for Draft 1, Revision, Reviewer,
Evidence selector, and Research planner. Revision and Reviewer use a
deterministic prior-draft envelope equal to the configured maximum output
allowance. The report measures UTF-8 bytes, estimates tokens with the frozen
divisor, and shows each prompt block's contribution.

The compiler includes each evaluation constraint and source document once.
It preserves extracted source text exactly, while excluding repeated source
inventory rows, repeated schemas, duplicate canonical URLs, fetch/extraction
bookkeeping, retention scores, search-accounting records, and other fields
that are not factual evidence. Evidence-selection and research-planning probes
omit writing doctrine and article-only name and number ledgers because those
blocks are not used by their output schemas.

Every model has an explicit context-window setting. Planning and execution
refuse a prompt before an adapter is constructed when:

```text
estimated prompt tokens + configured output tokens + safety margin
> configured context window
```

The safety margin is 1,024 tokens. Ollama requests also set `num_predict` to
the configured 4,096-token output ceiling. A Qwen3 14B planning-only dry run
that performs no model load or generation is:

```sh
npm run benchmark:dry-run -- --models local-qwen3-14b
```

## Ollama transport deadlines

Benchmark Ollama requests use a fresh, request-scoped Undici dispatcher.
Undici headers and body inactivity timers are explicitly disabled for that
request, while a 10-second connect timeout remains in force. The benchmark
AbortController is therefore the authoritative whole-request deadline. The
configured 600-second generation limit still prevents an indefinite request.
Each dispatcher is destroyed after its response is consumed or after failure,
so transport state cannot leak into the next sequential request.

Transport failures retain the operation, safe loopback URL, configured and
elapsed time, timeout layer, abort source, response progress, nested cause,
cleanup result, post-failure Ollama reachability, and current residency. The
runner writes model-stage transport failures to the private raw stage artifact.
Harness and lifecycle transport failures remain in the private failure report.
It performs no automatic retry.

## Stage dependencies and outcomes

The runner encodes stage dependencies explicitly:

```text
Draft                 <- frozen fixture packet
Revision              <- Draft
Reviewer              <- Draft
Evidence Selector     <- frozen fixture packet
Research Planner      <- frozen fixture packet
```

Every planned model, fixture, and stage begins as `not_attempted`. A valid
model output becomes `completed`. A generation error, authoritative model
deadline, or schema-invalid model response becomes `failed` and is retained as
a benchmark result with one attempt and no retry. A stage whose declared input
did not complete becomes `skipped_dependency`. Independent later stages still
run.

A run that reaches normal lifecycle and restoration completion with one or
more model-stage failures is `completed_with_failures`. Fixture validation,
prompt compilation, evaluation exceptions, artifact writes, lock failures,
model load or unload failures, internal runner errors, and restoration failures
remain harness-level failures and abort the run.

Partial blind packages contain only completed outputs plus an identity-free
candidate summary listing completed, failed, dependency-skipped, and
not-attempted stages. They never insert substitute output or retry a failed
stage. Score sheets remain blank; no failure receives an automatic score.

## Discovery

The runner discovers each direct child of `pipeline-benchmark/fixtures/` that
contains `manifest.json`. It validates every frozen input hash, every reference
hash, and the combined manifest hash before loading model input.

An official run requires at least two approved real fixtures. Tests create
synthetic packages under temporary directories, so implementation works before
the Kansas City church package arrives.

## Reference isolation

The fixture loader returns only:

- the public manifest fields needed for evaluation
- `input/fixture.json`
- `input/assignment.md`
- `input/evidence.json`
- JSON snapshots named in `input/sources/`

Adapters receive one compiled prompt string and no fixture paths. The Kimi
adapter starts in a fresh operating-system temporary directory with an explicit
agent file containing `tools: []`, `subagents: []`, an empty skills directory,
and no resumed session. Its prompt contains no reference content.

Reference hashes are verified by the harness, but `reference/` content is not
loaded by the runner and does not enter blind packages. The private mapping and
raw outputs are created with owner-only file permissions.

## Safety

- one process-wide atomic benchmark lock
- one model lifecycle at a time
- one request at a time
- zero retries
- unexpected resident model aborts the run
- unload is verified before the next model
- model-stage failures are recorded and independent stages continue
- lifecycle, lock, prompt, evaluator, and artifact failures abort the run
- restoration runs after failure when production coordination was active
- every restoration step is attempted even when an earlier step fails
- controller restoration and benchmark-lock release are always attempted
- restoration failures are retained together and produce `RESTORE_FAILED`

The benchmark lock is independent. It never creates or impersonates a
production pipeline job.

Controller pause is verified by bounded polling rather than an immediate
post-`bootout` check. The poll succeeds only after launchd reports the service
absent or stopped, the recorded controller PID is gone, and port 4317 has no
listener. Each observation is retained. Timeout, `bootout` failure, and a
replacement PID are reported as distinct failures.

Restoration independently attempts benchmark-model unload, the production
smoke, exact installed tag and digest verification, original Ollama residency,
original controller state, controller health and queue connectivity, active
job and lease clearance, and benchmark-lock release. A failed smoke cannot
prevent controller resume, residency restoration, or lock release.

## Production coordination

Official execution additionally requires:

- `--official`
- `--allow-real-models`
- `--allow-production-pause`
- `--allow-paid-cloud` when Kimi candidates are included
- `ANYWAYS_BENCHMARK_CONTROLLER_PLIST`
- `ANYWAYS_BENCHMARK_QUEUE_PROBE_COMMAND`
- `ANYWAYS_BENCHMARK_SMOKE_COMMAND`

The local operator configuration is stored in the ignored, owner-only
`pipeline-benchmark/.env.official.local` file. Load it together with
`.dev.vars` so the queue probe inherits the existing Supabase credentials:

```sh
node --env-file=.dev.vars \
  --env-file=pipeline-benchmark/.env.official.local \
  pipeline-benchmark/src/cli.mjs run \
  --official \
  --models local-qwen3-14b \
  --allow-real-models \
  --allow-production-pause
```

Loading this file does not run the smoke check. The smoke command remains
generation-capable and executes only during an explicitly authorized official
run restoration.

The queue and smoke variables contain JSON arrays describing commands. The
queue command must be read-only and return:

```json
{"idle": true, "active_count": 0, "queued_count": 0, "active_lease_count": 0}
```

The included queue probe is read-only:

```sh
node --env-file=.dev.vars pipeline-benchmark/ops/probe-queue.mjs
```

The production-path smoke command must return:

```json
{"model": "qwen3:14b", "digest": "bdbd181c33f2ed1b31c972991882db3cf4d192569092138a7d29e973cd9debe8"}
```

The included smoke command is generation-capable and remains disabled unless
the official-run environment explicitly enables it:

```sh
ANYWAYS_BENCHMARK_ALLOW_PRODUCTION_SMOKE=1 \
  node pipeline-benchmark/ops/smoke-production-model.mjs
```

It verifies the exact configured tag and digest before and after generation,
uses non-streaming output with thinking explicitly disabled, and requires a
completed non-empty `response`. The output ceiling is 32 tokens. Duration and
token metrics are retained when Ollama returns them. Residency restoration is
left to the coordinator. The smoke does not create a production job or write
editorial data.

These commands are intentionally not guessed. The current controller health
endpoint does not prove that the durable queue has zero queued rows, and the
repository does not expose a dedicated production-path generation smoke
endpoint. Those probes must be reviewed before the first official run.

## Blind scoring

Candidate labels are randomized independently for each fixture. Review
packages remove model, provider, tag, digest, adapter, timing, memory, and path
fields. `revealMapping()` refuses to reveal identities until every score sheet
is complete, its checksum is frozen, and the checksums still match.

Human scores cover voice, editorial-section fit, lens fit, structure,
specificity, narrative movement, evidence use, revision quality, editing
required, publishability, reviewer usefulness, evidence-selection quality, and
research-plan usefulness.

## Deterministic evaluation

The evaluator reports schema, taxonomy, word-range, fact, prohibited-claim,
formatting, source-ID, quote, name, number, repetition, paragraph, and revision
change findings with JSON pointers or text line, column, offset, and excerpt.
It does not score voice and does not claim truth beyond the frozen packet.
