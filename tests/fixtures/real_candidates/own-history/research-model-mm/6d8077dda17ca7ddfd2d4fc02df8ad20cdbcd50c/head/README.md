# Research Model

A standalone, provenance-aware research-behavior model project. The initial target is an approximately 8B open-weight language model specialized for evidence-grounded research workflows while retaining ordinary instruction-following ability.

The project trains observable research actions, not hidden chain-of-thought and not raw-paper memorization. The model learns a neutral protocol that a future application can map to any retrieval provider:

```json
{
  "state": "evidence_review",
  "action": "EXTRACT",
  "query": null,
  "source_ids": ["scifact:14717500"],
  "claims": [{"text": "...", "status": "SUPPORTED", "source_ids": ["scifact:14717500"]}],
  "evidence": [{"source_id": "scifact:14717500", "text": "..."}],
  "gaps": [],
  "confidence": "medium",
  "next_action": "SYNTHESIZE"
}
```

## Status

This repository is an initial reproducible build. It contains:

- a short base-model selection screen and a recorded Qwen3-8B-Base decision;
- public-data acquisition with a machine-readable provenance manifest;
- structured task generation from SciFact and QASPER evidence annotations;
- strict schema, evidence, citation, duplicate, low-information, and leakage validators;
- a frozen 248-case research benchmark plus a general-capability control;
- append-only experiment manifests, a machine-readable index, and a research ledger;
- cached, provider-neutral teacher interfaces;
- MLX and NVIDIA Transformers/PEFT training recipes;
- a runnable CLI, tests, documentation, and generated pilot artifacts.

The target 8B run is intentionally not launched on this 32 GB local machine by default. Use the exact cloud recipe in `configs/training/qwen3_8b_qlora.toml` on an appropriately sized NVIDIA GPU, or use the MLX path for an Apple Silicon pilot after reviewing memory requirements.

## Quickstart

```bash
uv sync --extra dev
uv run research-model data build --max-claims 120 --output data/generated/pilot-new.jsonl --mlx-dir data/generated/mlx/pilot-new
uv run research-model baseline run --backend heuristic
uv run research-model validate
uv run research-model evaluate --backend heuristic
uv run research-model infer --question "Does this intervention improve retention?"
uv run research-model benchmark build
uv run research-model experiment validate --all
```

The data command downloads public sources into `data/raw/` (ignored by git),
extracts only documented files, and writes a versioned processed release and
report. Existing evidence is not overwritten by default. To create the serious
candidate locally:

```bash
uv run research-model data build --sources scifact,qasper \
  --max-claims 1409 --scifact-splits train,dev,test --max-questions 2000 \
  --tasks evidence_verification,citation_integrity,insufficient_evidence,research_plan,evidence_extraction,claim_extraction,claim_source_attribution,contradiction_detection,missing_evidence,evidence_table,search_query_generation,query_refinement,follow_up_question \
  --version research-data-v0.1-expanded --strict \
  --output data/generated/research-data-v0.1-expanded.jsonl \
  --mlx-dir data/generated/mlx/research-data-v0.1-expanded
```

Raw source text and model caches are not bundled into a public code release.

To use an actual model backend after installing the ML extras:

```bash
uv sync --extra ml
uv run research-model baseline run --model Qwen/Qwen3-8B-Base --backend transformers --max-examples 64
uv run research-model train --config configs/training/qwen3_8b_qlora.toml --backend transformers
uv run research-model evaluate --model /path/to/adapter-or-model --backend transformers
```

## Repository layout

```text
configs/                 versioned data, evaluation, and training settings
data/manifests/          provenance and release metadata
  data/generated/          derived JSONL, validation, and evaluation artifacts
experiments/              immutable experiment manifests and summaries
paper/                    publication-evidence staging directories
prompts/                  versioned optional teacher prompts
data/raw/                downloaded public sources; ignored by git
src/research_model/
  datasets/              schema-aware JSONL loading and deterministic splits
  evaluation/            research-behavior scorers and benchmark runner
  inference/             protocol prompts and local model adapters
  normalization/         text normalization and sentence handling
  provenance/            hashes and provenance records
  research_protocol/     action/state contract
  task_generation/       grounded task families and curriculum labels
  teacher/                cached provider-neutral teacher interface
  training/              reproducible training configuration helpers
  validation/            deterministic dataset and output checks
benchmarks/tasks/         hand-authored controlled research cases
docs/                     architecture, data, training, evaluation, licenses, model card
scripts/                  thin command wrappers
tests/                    unit and integration tests
```

## License and data boundary

Code is Apache-2.0. Data has independent terms and is never silently relicensed. See `data/manifests/public_sources.json` and `docs/licenses.md`. The pilot uses SciFact, whose dataset card states CC BY-NC 2.0; generated artifacts must preserve attribution and non-commercial restrictions. No private or workspace-specific research data is used.

## Research protocol

The protocol is documented in `docs/architecture.md` and implemented in `src/research_model/research_protocol/protocol.py`. It supports `SEARCH`, `READ`, `EXTRACT`, `COMPARE`, `QUESTION`, `SYNTHESIZE`, and `STOP`, with explicit provenance and uncertainty fields.

## Reproducibility

All generated datasets carry a version, seed, source hashes, license class,
composition report, and split policy. Run `uv run research-model report` for a
compact project report. Never publish generated data or model weights without
an independent licensing review.
