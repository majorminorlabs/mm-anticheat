# Benchmark v1.0.1

Benchmark v1.0.1 is a narrowly scoped correctness patch to the Kimi Code CLI
adapter. Benchmark v1.0 remains permanently immutable.

The canonical patch definition is:

- `pipeline-benchmark/config/benchmark-v1.0.1.json`
- `pipeline-benchmark/config/benchmark-v1.0.1.sha256`

The patch manifest records parent version `1.0`, the exact parent manifest
hash, patch classification `adapter_correctness`, the single logical artifact
replacement, and every inherited frozen hash.

## Reason for the patch

The v1.0 adapter constructed this invalid Kimi CLI command:

```text
kimi -p --agent-file <agent> --skills-dir <dir> --model <model> --output-format text <prompt>
```

Kimi CLI 0.29.2 requires the prompt as the value immediately following
`--prompt`. Because `-p` appeared before other options, the CLI interpreted the
temporary agent-file path as a command and exited before model generation.

The v1.0.1 adapter constructs:

```text
kimi --agent-file <agent> --skills-dir <dir> --model <model> --output-format text --prompt <prompt>
```

It also treats a zero exit with empty or whitespace-only stdout as a generation
failure. Direct argument-array spawning, no-shell execution, temporary
isolation, timeout behavior, cleanup, diagnostics, and benchmark interfaces are
unchanged.

## Version isolation

The original v1.0 adapter remains at `src/adapters/kimi-code.mjs` with its
original checksum. The replacement is versioned at
`versions/v1.0.1/src/adapters/kimi-code.mjs`. Official v1.0.1 runs use
`versions/v1.0.1/cli.mjs`.

The v1.0.1 validator first validates v1.0, then validates the patch manifest,
the replacement adapter, patch entrypoint, parent lineage, and editorial
semantic equivalence. Any mismatch aborts before a run directory is created.

Validate without generation:

```sh
node pipeline-benchmark/versions/v1.0.1/cli.mjs fixtures validate
```

## Editorial-semantic equivalence

The following are byte-for-byte or value-for-value identical to v1.0:

- fixtures and fixture hashes;
- prompts and doctrine;
- schemas;
- evaluators;
- scoring and blind-review rules;
- benchmark runner and stage dependencies;
- lifecycle behavior outside the corrected Kimi invocation;
- generation deadline and benchmark configuration.

No v1.0 output, run manifest, blind package, score lock, result index, or
adoption record was rewritten.

## Comparability and historical adoption

Native v1.0.1 results are directly comparable with a v1.0 result only when a
checksum-bound adoption record proves:

1. every editorial-semantic artifact matches;
2. the historical run did not use the changed Kimi adapter;
3. the original run and locked scores remain unchanged;
4. source and target versions and manifest hashes are explicit.

The completed v1.0 Qwen run used the Ollama adapter, so it satisfies these
conditions. Its v1.0.1 cohort record is:

`pipeline-benchmark/reporting/cohorts/benchmark-v1.0.1/adoptions/qwen-v1.0.json`

The record references the original artifacts in place. It does not duplicate
or modify them.

A historical run that used the v1.0 Kimi adapter cannot be adopted because the
transport defect prevented the intended model invocation. Such a model
requires a fresh v1.0.1 run. The failed Kimi K3 diagnostic run is preserved as
historical evidence and is not a comparison result.
