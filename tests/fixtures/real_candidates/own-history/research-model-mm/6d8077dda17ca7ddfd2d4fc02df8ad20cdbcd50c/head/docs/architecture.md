# Architecture

The system is deliberately a small pipeline rather than an agent framework:

1. `ingestion` downloads public sources and records hashes.
2. `normalization` produces stable sentence units.
3. `task_generation` turns source-grounded labels into observable research tasks.
4. `teacher` can add planning or critique supervision through a cached, provider-neutral interface. It is never trusted as the sole factual authority.
5. `validation` rejects malformed, unsupported, duplicated, or leakage-prone examples.
6. `training` consumes JSONL examples using SFT/QLoRA.
7. `evaluation` scores structured behavior rather than prose quality.
8. `inference` exposes the neutral protocol to any future retrieval system.

The source-grouped split keeps all examples derived from one source document in one split. This is stricter than a random example split and prevents sentence-level evidence leakage.

