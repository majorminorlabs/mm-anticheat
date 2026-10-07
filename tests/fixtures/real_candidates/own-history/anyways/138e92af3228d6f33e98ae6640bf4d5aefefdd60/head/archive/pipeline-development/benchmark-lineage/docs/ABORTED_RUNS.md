# Aborted benchmark runs

## 2026-07-30T20-32-44-841Z-c5ebe2d8

This official run was aborted during controller-pause verification before any
benchmark generation began. Its immutable diagnostic directory is:

`pipeline-benchmark/generated/2026-07-30T20-32-44-841Z-c5ebe2d8/`

The retained evidence is:

- `private/run-manifest.json` has no `generation_started` event and no runtime
  prompt entry;
- `private/reports/runtime-metrics.json` contains zero requests;
- `private/raw/` contains no model output;
- `private/failure-report.json` records the pause-verification failure and the
  subsequent restoration-smoke failure.

Do not reuse the run ID or modify its diagnostic directory.

## 2026-07-30T21-06-09-134Z-78a12720

This official run completed all five Apple stages and then failed during
Logitech Draft 1 because the default Undici headers timeout ended the
non-streaming Ollama request before the configured benchmark deadline. It is
an incomplete diagnostic run, not a resumable partial benchmark.

Its immutable diagnostic directory is:

`pipeline-benchmark/generated/2026-07-30T21-06-09-134Z-78a12720/`

Any later official run must use a new run ID, execute both fixtures from the
beginning, regenerate all ten stages, and must not reuse or append to the Apple
outputs retained here. This preserves consistent timing, lifecycle conditions,
prompt inputs, and run provenance.

## 2026-07-30T21-56-19-331Z-4fd2aedb

This official Qwen3 14B run completed all five Apple stages plus Logitech
Draft, Revision, and Reviewer. Logitech Evidence Selector then reached the
correctly enforced 600,000 ms model-generation deadline. Ollama remained
reachable, transport cleanup completed, and production restoration succeeded.

The Evidence Selector timeout is a legitimate benchmark observation, not a
transport or lifecycle defect. The runner version used for this immutable run
treated that model-stage outcome as a run-aborting error, so the independent
Logitech Research Planner stage was never attempted.

Its immutable diagnostic directory is:

`pipeline-benchmark/generated/2026-07-30T21-56-19-331Z-4fd2aedb/`

Do not resume, append to, or alter this run. A later official pass must use a
new run ID and execute both fixtures from the beginning.
