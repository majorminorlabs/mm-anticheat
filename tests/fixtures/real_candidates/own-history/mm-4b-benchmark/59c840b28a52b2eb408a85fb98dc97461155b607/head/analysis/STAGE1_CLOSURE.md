# Stage 1 closure

Status: **COMPLETE**. Reference-model selection: **FROZEN**.

## Research question

Which small local model provides the strongest agent-relevant capability while remaining practical on approximately 16 GiB consumer hardware?

## Frozen identity

- Protocol: `qualification-v1.0.0`.
- Execution host: ThinkPad T14 Gen 2a, Ryzen 7 PRO 5850U, Pop!_OS 24.04.
- Runtime: llama.cpp `972d2313bc0bf0a45f634f77d95c9fb03aeab12`, Vulkan/RADV, AMD Radeon Graphics.
- Quantization: Q4_K_M.
- Context ceiling: 16,384 tokens; temperature 0; fixed seed 0; deterministic simulator; no external network during model runs.
- Qwen3 execution condition: `enable_thinking=false`.

## Candidate history

The original field was amended before valid exposure. Phi-4-mini, Gemma-3-4B, Granite-3.3-2B, and SmolLM3-3B remain preserved as `removed_pre_exposure_interface_incompatible`. Their exclusions are structured-interface findings, not capability scores. Granite 4.1 passed the same neutral structured integration gate and entered the final field.

The original 28-run batch from `dc03660` remains permanently classified as `INVALID — SHARED RUNNER/ADAPTER FAILURE`. It contributes to no score, repetition, finalist selection, or aggregate model statistic.

## Valid observations

The replacement first round contained 28 valid behavioral observations: four models × seven tasks. The finalist stage added 28 valid observations: two finalists × seven tasks × two repetitions. Two early corrected-runner defects were preserved as infrastructure-invalid attempts and excluded from scoring. No Qwen2.5 or Granite finalist runs were performed.

## Finalist results

| Model | Observation scores | Mean | Resource eligibility |
|---|---|---:|---|
| Ministral-3-3B-Instruct-2512 | 25, 25, 25 /80 | 25.00 | PASS |
| Qwen3-4B | 17, 17, 17 /80 | 17.00 | FAIL; minimum available RAM 4.95 GiB vs frozen 5.0 GiB floor |

The frozen selection rule therefore selects **mistralai/Ministral-3-3B-Instruct-2512** as the Stage 1 reference model. Selection is unambiguous before tie-breaking. Model selection is not reopened by later harness experiments; changing it would require a new experiment/version.

## Major behavioral findings

- Q06 epistemic restraint: both finalists made catastrophic actions in 3/3 observations; neither demonstrated the required restraint under insufficient evidence.
- Q07 integrated investigation: Ministral scored 12/20 in all three observations; Qwen3 scored 0/20 in all three. The separation replicated perfectly.
- Q03 dependency planning: Qwen3 repeated the incompatible deployment in 3/3 observations.
- Verified completion: Ministral 0/21; Qwen3 3/21, all on Q02.
- Malformed model arguments: Ministral 9/21 observations; Qwen3 6/21. These remain model behavior and were not repaired or retried.
- Absolute capability was low relative to 80 despite the clear reference-model selection.

## Limitations

Stage 1 uses seven deterministic fixtures and a deterministic simulator. Repeated identical observations were exactly stable, so the repetitions estimate stability under the frozen setting rather than broad stochastic uncertainty. The resource floor excluded Qwen3 in the combined finalist set. The benchmark does not establish general real-world agent capability, and the selected model is a reference engine for the next controlled experiment, not a universal winner.

## Relevant commits and evidence

- Candidate amendment v1.3.0: `ca863952cad78c39b6ab4570435177e8f2199f02`.
- First-round execution freeze: `dffa7d869256eda67f693133b714881813c24272`.
- First-round results: `82b7ef1b854e80bc95dd04122929c0e373285b00`.
- Finalist repetition freeze: `1526ebd7f0fd6ee0c94b2fc8a5018070ffdcaa44`.
- Finalist results and selection: `069163e18f40635e1d650039b464da0bb903dc45`.
- Finalist raw evidence: `runs/raw/stage1-finalist-repetitions/thinkpad/`.
- Combined analysis: `analysis/STAGE1_FINALIST_REPETITIONS.md`.
- Combined processed results: `runs/processed/stage1-finalist-repetition-results.json`.

Stage 1 is closed. Future work must treat the selected reference model and this conclusion as frozen inputs unless a separately versioned experiment is authorized.
