# Benchmark v1.0.2

Benchmark v1.0.2 is a narrowly scoped correctness patch to the Kimi Code CLI
adapter. Benchmark v1.0 and Benchmark v1.0.1 remain permanently immutable.

The canonical patch definition is:

- `pipeline-benchmark/config/benchmark-v1.0.2.json`
- `pipeline-benchmark/config/benchmark-v1.0.2.sha256`

The patch manifest records parent version `1.0.1`, its exact manifest hash,
patch classification `adapter_correctness`, the single logical adapter
replacement, and all inherited frozen hashes.

## Root cause

Kimi CLI 0.29.2 `text` mode intentionally renders transcript output with a
`• ` prefix. That human-oriented renderer is unsuitable for machine parsing.
The CLI's supported programmatic interface is `stream-json`, which emits JSONL
message envelopes.

Benchmark v1.0.1 correctly invoked the installed CLI, but selected `text`
output and passed the rendered transcript to the frozen JSON evaluator. Its
failures therefore occurred at the adapter output-decoding boundary, before
valid benchmark parsing could be evaluated.

Benchmark v1.0.2 changes only the Kimi adapter invocation and decoding:

```text
kimi --agent-file <agent> --skills-dir <dir> --model <model> --output-format stream-json --prompt <prompt>
```

The adapter parses every JSONL envelope, ignores lifecycle and status
envelopes, and concatenates string `content` from assistant envelopes in
emission order without adding separators. Whitespace, Markdown fences,
bullets, prose, and every other model-emitted character are preserved exactly.
The adapter does not repair, normalize, or reinterpret model output.

Malformed JSONL, missing assistant content, nonzero exit status, and timeout
remain adapter generation failures. Raw stdout and stderr are retained in
private adapter diagnostics. Direct argument-array spawning, no-shell
execution, model-agnostic aliases, temporary isolation, cancellation, and
cleanup remain in force.

## Version isolation

The frozen adapters and entrypoints for earlier versions remain in place:

- v1.0 adapter: `src/adapters/kimi-code.mjs`
- v1.0.1 adapter: `versions/v1.0.1/src/adapters/kimi-code.mjs`
- v1.0.1 entrypoint: `versions/v1.0.1/cli.mjs`

The v1.0.2 replacement and official entrypoint are:

- `versions/v1.0.2/src/adapters/kimi-code.mjs`
- `versions/v1.0.2/cli.mjs`

Validate v1.0.2 without generation:

```sh
node pipeline-benchmark/versions/v1.0.2/cli.mjs fixtures validate
```

## Editorial-semantic equivalence

Benchmark v1.0, v1.0.1, and v1.0.2 have identical editorial measurement
semantics. Fixtures, prompts, schemas, evaluators, scoring doctrine, blind
review rules, runner behavior, stage dependencies, lifecycle behavior,
generation deadline, and benchmark configuration are unchanged.

The v1.0 Qwen result may be recognized in the v1.0.2 comparison cohort by a
checksum-bound adoption record because its editorial-semantic artifacts match
and its historical run used Ollama, not either changed Kimi adapter. The
original run, packages, metadata, and scores remain in place and are referenced
without copying.

The two historical Kimi runs are excluded from scoring and reporting import:

- `2026-07-31T02-40-43-194Z-ee938a2b`: v1.0 CLI invocation compatibility failure
- `2026-07-31T13-24-46-531Z-5a93820a`: v1.0.1 text-renderer decoding failure

Both remain immutable historical evidence. Neither may be adopted, scored, or
imported. Kimi K3 requires a fresh official v1.0.2 run.
