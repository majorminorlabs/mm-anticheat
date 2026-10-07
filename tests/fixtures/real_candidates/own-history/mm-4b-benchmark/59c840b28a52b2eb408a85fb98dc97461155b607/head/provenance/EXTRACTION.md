# Extraction provenance

## Repositories

- Source repository: `/Volumes/Research/tests/mm-agent/`
- Standalone destination: `/Volumes/Research/tests/mm-4b-benchmark/`
- Source extraction commit: `f47beac3cf988d90265d85042b82dc4ad929fb46`
- Extraction date: 2026-09-18
- Destination history begins with this extraction commit; historical source commits are recorded, not fabricated into destination history.

## Included scope

The extraction includes the Stage 1 protocol and execution configurations, model manifests and validation, Q01–Q07 fixtures, deterministic simulator, Stage 1 runner/resource utilities, scorer, tests, all Stage 1 analyses, model compatibility-gate evidence, invalid original batch evidence, corrected first-round evidence, finalist repetitions, processed results, and raw evidence under `runs/`.

Relevant source lineage:

- `501a108` — initialize Stage 1 qualification protocol
- `33eb4a3` — reconcile authoritative qualification fixtures
- `e2c3a26` — freeze Stage 1 model provenance and artifacts
- `d0262b3` — freeze Stage 1 first-round execution configuration
- `c9ac0ad` — freeze balanced first-round schedule and runner
- `dc03660` — record original invalid first-round execution
- `5e28d69` — diagnose adapter/resource failures
- `692891d` — diagnose structured tool compatibility limits
- `f22a1bb` — qualify structured llama server tool transport
- `cbac693` — record candidate compatibility amendment
- `939b9f8` — record SmolLM3 compatibility amendment
- `ca86395` — record Granite 4.1 candidate amendment
- `dffa7d8` — freeze replacement first-round execution
- `82b7ef1` — record replacement first-round results
- `1526ebd` — freeze finalist repetition schedule
- `069163d` — record finalist results and selection
- `12197a3` — close and freeze Stage 1

## Exclusions

Stage 2 protocol, calibration, task set, direct baseline, Hermes/OpenClaw/Pi qualification, compatibility-remediation analysis, harness-specific infrastructure, and Stage 2 raw evidence are excluded. The original source repository remains authoritative for that paused work. No source evidence was deleted or rewritten.

The destination was populated from a Git archive of the source commit. Scientific artifacts retained here are byte-identical to their archived source versions unless explicitly replaced for standalone presentation (`README.md`, `PROJECT.md`, `LICENSE`, and this provenance/documentation layer). The extraction commit records the resulting file set; source hashes can be reproduced with `git archive f47beac` and file hashing.

## Scientific preservation

No model was run during extraction. No score, prompt, task, resource rule, model identity, or result was changed. Historical interface exclusions remain separate from the scored leaderboard. The original 28-run batch remains `INVALID — SHARED RUNNER/ADAPTER FAILURE` and contributes no capability result.
