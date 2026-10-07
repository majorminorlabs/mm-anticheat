# Evaluation

`benchmarks/tasks/research_microbench.jsonl` is the retained 10-case engineering
check. `benchmarks/releases/research-bench-v0.1.jsonl` is the frozen 248-case
controlled benchmark for the next primary comparison; its metadata records the
content hash and composition across 31 research-behavior families. It includes
adversarial fixtures for unsupported claims, source authority/relevance
conflicts, contradictions, population and temporal mismatch, observational
causality, benchmark/vendor claims, reproducibility, and stopping.

Metrics include structured-output validity, action accuracy, citation precision/recall, evidence recall, claim-status F1, unsupported-claim rate, and per-task aggregates. The real research benchmark should expand with unseen source combinations and held-out topics before release claims are made.

`benchmarks/control/general-capability-v0.1.jsonl` is a separate 12-case
regression guard for instruction following, basic reasoning, summarization, and
technical explanation. Its keyword score is deliberately modest and is not a
universal capability measure.

The heuristic backend is a protocol sanity baseline, not a language-model
result. A real untouched-base baseline must be run with
`--backend transformers --model Qwen/Qwen3-8B-Base` or a documented MLX
equivalent on hardware that can load it. Raw per-example predictions are
retained by the evaluation command, and `research-model stats compare` computes
paired bootstrap intervals without discarding the underlying rows.
