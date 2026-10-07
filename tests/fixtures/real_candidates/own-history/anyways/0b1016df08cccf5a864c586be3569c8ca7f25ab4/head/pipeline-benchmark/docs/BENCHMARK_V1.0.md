# Benchmark v1.0

Benchmark v1.0 is the canonical, production-stable baseline for Anyways model
comparisons.

The canonical definition is:

- `pipeline-benchmark/config/benchmark-v1.0.json`
- `pipeline-benchmark/config/benchmark-v1.0.sha256`

The JSON manifest records the frozen fixtures, prompts, doctrine, schemas,
evaluators, human scoring contract, harness semantics, lifecycle artifacts,
stage dependency graph, generation deadline, environment, repository identity,
and benchmark configuration. The adjacent SHA-256 file locks the manifest
itself.

Every benchmark run validates this definition before it creates a run
directory, acquires the heavy-model lock, pauses the controller, constructs an
adapter, loads a model, or starts generation. Validation reports each changed
artifact and exits with `BENCHMARK_FREEZE_MISMATCH`. It never attempts to
continue after drift.

Run the complete non-generating validation with:

```sh
npm run benchmark:validate
```

## Version policy

- Every new model must use Benchmark v1.0 unchanged.
- Do not optimize a v1.0 prompt, schema, evaluator, score, timeout, lifecycle,
  stage dependency, or other semantic rule for a particular model.
- A genuine correctness bug requires an explicit benchmark-version decision
  and a documented replacement baseline.
- Benchmark improvements belong in Benchmark v1.1 or later.
- Benchmark v1.0 results remain directly comparable forever because v1.0
  artifacts cannot change in place.
- Existing v1.0 manifests and model outputs are immutable evidence. Never
  regenerate or rewrite them to conform to a later benchmark version.

## Run metadata and blindness

Private run manifests record the benchmark version, canonical manifest hash,
benchmark repository commit, controller repository commit or explicit unborn
state, controller tree hash, model identifier, provider, model digest when
applicable, and execution timestamp.

This metadata is informational. It does not affect prompts, evaluation, or
scoring, and it is never copied into blind review packages.

## Controller repository identity

At the v1.0 freeze, the active controller checkout was an unborn Git
repository and therefore had no commit to record. The canonical manifest
records a null commit, the explicit `unborn` repository state, per-file hashes,
and a combined controller tree hash. Validation requires that exact controller
state rather than inventing a commit identifier.

