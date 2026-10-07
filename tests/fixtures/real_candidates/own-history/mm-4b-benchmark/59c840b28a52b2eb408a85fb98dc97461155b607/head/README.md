# ~4B Agent Model Benchmark

Evaluating approximately 3B–4B local models as autonomous-agent reasoning engines.

This standalone benchmark asks: how capable are small local language models at the reasoning, planning, tool-use, restraint, and verification behaviors required for autonomous agent work?

## Status

The model-comparison study is complete and locally reproducible. It is not yet published. The benchmark contains four valid scored candidates and a separately documented admission history for candidates that failed the structured interface gate before scored exposure.

## Results

| Model | First round | Finalist repetitions | Resource eligibility |
|---|---:|---:|---|
| Ministral 3 3B | 25/80 | 25, 25, 25 | Pass; selected reference |
| Qwen3 4B | 17/80 | 17, 17, 17 | Finalist set failed the 5.0 GiB minimum-available-RAM floor |
| Qwen2.5 3B | 14/80 | — | Pass in first round |
| Granite 4.1 3B | 12/80 | — | Pass in first round |

Scores are deterministic benchmark results, not general intelligence estimates. Absolute autonomous-agent readiness was weak even for the selected reference model.

## Method

The frozen `qualification-v1.0.0` protocol evaluates seven deterministic behavioral tasks, Q01–Q07, using a fixed simulator and deterministic scorer. A candidate must first pass a neutral structured tool-interface and runtime compatibility gate. The scorer uses explicit observable atoms and catastrophic-action rules; it does not use an LLM judge. Model runs use Q4_K_M GGUF weights, temperature 0, fixed seed 0, llama.cpp Vulkan/RADV execution, a 16,384-token ceiling, and no external network access.

The execution host was a ThinkPad T14 Gen 2a with Ryzen 7 PRO 5850U and approximately 16 GiB consumer-local hardware. Model weights remain external to this repository; their exact upstream identities, revisions, filenames, hashes, licenses, and paths are recorded in `models/`.

## Findings and limitations

- Q06 restraint failed catastrophically for both finalists in all three observations.
- Q07 separated the finalists consistently: Ministral scored 12/20 in every observation; Qwen3 scored 0/20.
- Verified completion was low: Ministral 0/21 and Qwen3 3/21.
- Malformed model arguments were preserved as model behavior, never repaired or retried.
- Repetitions measure stability under this frozen setting; they do not establish broad stochastic uncertainty.
- The seven-task fixture set is narrow, and the resource floor affected finalist eligibility.

## Evidence and reproduction

Raw attempts are under `runs/raw/`; processed results are under `runs/processed/`. The deterministic simulator, scoring code, runner utilities, tests, frozen schedules, execution configuration, model manifests, and analyses are retained in their corresponding directories. Start with `analysis/STAGE1_CLOSURE.md`, `protocol/`, `models/`, and `provenance/`.

This repository contains only the completed small-model comparison. The separate MM-Agent harness study remains paused in its source repository and is not part of this benchmark.

## License and publication

This is a research extraction prepared for review, not a published release. See `LICENSE` and `docs/PUBLIC_RELEASE_CHECKLIST.md` before any public distribution.
