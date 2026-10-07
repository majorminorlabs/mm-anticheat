# Benchmark v1.0 reporting

This directory contains reporting-only metadata and code. It indexes existing
Benchmark v1.0 artifacts by path and never rewrites or duplicates benchmark
outputs.

Run:

```sh
node pipeline-benchmark/reporting/cli.mjs
```

The importer accepts terminal runs with native Benchmark v1.0 metadata, the
exact canonical manifest hash, and locked human scores. The founding Qwen run
has a checksum-bound adoption record because it supplied the artifacts used to
freeze v1.0 before informational run metadata was added. All other runs without
native v1.0 identity are treated as pre-v1.0 and excluded.

Results are rebuilt under `pipeline-benchmark/results/benchmark-v1.0`. Those
files are derived indexes and reports. Source artifacts remain immutable under
`pipeline-benchmark/generated`.
