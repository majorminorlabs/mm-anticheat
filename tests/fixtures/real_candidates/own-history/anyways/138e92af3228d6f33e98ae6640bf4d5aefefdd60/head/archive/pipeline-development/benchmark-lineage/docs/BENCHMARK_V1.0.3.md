# Benchmark v1.0.3

Benchmark v1.0.3 is a frozen `provider_adapter_addition` patch over Benchmark
v1.0.2. It adds one generic Codex subscription adapter and five configured
model-plus-reasoning candidates. Benchmark v1.0, v1.0.1, and v1.0.2 remain
permanently immutable.

## Measurement semantics

Editorial measurement semantics are unchanged. v1.0.3 uses the exact v1.0
fixtures, prompts, schemas, evaluators, scoring doctrine, stage dependency
graph, 600,000 ms generation deadline, blind-review rules, lifecycle, and
restoration requirements. The new provider route does not change or coach any
benchmark prompt.

## Codex execution route

The versioned adapter validates `codex-cli 0.146.0` and active ChatGPT
subscription authentication before generation. Each request gets a mode-0700
temporary root, an isolated `CODEX_HOME`, a mode-0600 copy of `auth.json`, a
provider-neutral mode-0600 `AGENTS.md`, and a fresh working directory. Personal
configuration, history, rules, skills, plugins, repository context, and prior
sessions are not copied.

Codex is spawned directly without a shell. The complete frozen prompt is sent
over stdin. The adapter selects the configured model and reasoning effort,
disables browsing and agent/tool features, uses the read-only sandbox, emits
JSONL, and writes the final message to a private cross-check file. JSONL and
the final output are preserved exactly. The adapter rejects malformed output,
missing or contradictory final content, nonzero exits, and any unexpected
tool event. It never strips, normalizes, or repairs model output.

At the frozen 600-second deadline the adapter sends SIGTERM, waits a bounded
grace period, sends SIGKILL if necessary, records one attempt, and removes the
temporary root. Cleanup also runs after success and every failure.

## Initial candidates

- `cloud-luna-high`: `gpt-5.6-luna`, `high`
- `cloud-luna-xhigh`: `gpt-5.6-luna`, `xhigh`
- `cloud-sol-high`: `gpt-5.6-sol`, `high`
- `cloud-sol-medium`: `gpt-5.6-sol`, `medium`
- `cloud-terra-high`: `gpt-5.6-terra`, `high`

The candidates use one adapter. Model identifiers and reasoning levels are
data in the versioned registry, not model-specific behavior.

## Comparability and adoption

The Qwen3 14B, Kimi K3, and Kimi 2.7 results are recognized in the v1.0.3
cohort by checksum-bound references. Their original runs, score records, and
artifacts are not copied or rewritten. Adoption is valid because all frozen
editorial-semantic hashes match and none of those runs used the new Codex
subscription adapter.

The two historical failed Kimi adapter runs remain excluded from scoring and
reporting import. v1.0.3 carries that exclusion forward by checksum-bound
reference.

Any future semantic improvement belongs in a new benchmark version. Official
v1.0.3 execution must use `versions/v1.0.3/cli.mjs` and pass freeze validation
before a run is created.
