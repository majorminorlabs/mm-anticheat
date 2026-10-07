# Archived pipeline development

This directory contains historical benchmark lineage, model comparisons, discovery benchmark tooling, and superseded pipeline documentation. It is retained for provenance and historical review, not as active production code.

The active benchmark harness remains under `pipeline-benchmark/`. The versioned benchmark lineages are preserved together under `benchmark-lineage/` because their validators, manifests, reports, and tests are interdependent. Archived versions may not run from this location: exact replay can require the original relative layout, the external controller repository, provider access, and locally retained run material.

Raw provider output, sealed holdout mappings, captured source packets, generated runs, credentials, and operational state are intentionally outside normal Git retention. They must remain in restricted external or machine-local storage according to the benchmark retention policy in `docs/benchmark/RETENTION.md`.

Nothing in this archive is an active package script, newsroom route, controller command, database contract, or production runtime dependency.
