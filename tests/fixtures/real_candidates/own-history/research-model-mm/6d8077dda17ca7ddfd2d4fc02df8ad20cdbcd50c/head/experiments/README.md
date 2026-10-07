# Experiment evidence

Each experiment is a directory named by an immutable ID such as
`E007_dataset_expanded`. `manifest.json` is written once and records the
research question, data/model/config hashes, environment, commands, outputs,
metrics, limitations, and deviations. `summary.md` is the human-readable
companion. `experiments/index.json` is the machine-readable append-only index.

Historical manifests are explicitly marked `reconstructed_after_fact`; null
metadata means it was unavailable in the surviving records. A later correction
gets a new experiment ID or an explicit invalidation record. Run
`uv run research-model experiment validate --all` before relying on a bundle.

Raw downloads, model caches, and adapter binaries remain in ignored local
directories. Their paths and hashes are referenced from manifests without
silently copying them into a release.
