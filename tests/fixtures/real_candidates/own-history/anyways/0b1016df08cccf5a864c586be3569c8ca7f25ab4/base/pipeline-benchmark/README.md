# Anyways benchmark harness

This directory is an isolated article, revision, review, evidence-selection,
and research-planning benchmark. It does not import production pipeline code,
modify production routing, or share the production job lock.

Real model execution is disabled unless all official-run authorization flags
and production probes are supplied. The implementation tests and demo use stub
adapters only.

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
- any adapter or lifecycle failure prevents the next model from starting
- restoration runs after failure when production coordination was active
- failed restoration leaves the lock in place

The benchmark lock is independent. It never creates or impersonates a
production pipeline job.

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
{"idle": true, "active_count": 0, "queued_count": 0}
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

It verifies the exact configured tag and digest, performs one bounded
non-empty-output check against the same loopback Ollama service used by
production, and leaves residency restoration to the coordinator. It does not
create a production job or write editorial data.

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
