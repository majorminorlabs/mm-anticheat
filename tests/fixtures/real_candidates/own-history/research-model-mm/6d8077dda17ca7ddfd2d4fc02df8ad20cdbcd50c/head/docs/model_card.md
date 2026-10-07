# Research Model model-card draft

## Intended use

Evidence-grounded research planning, source selection, claim/evidence attribution, contradiction detection, methodological critique, and structured synthesis over supplied documents or retrieval-tool results.

## Out of scope

The model is not a physician, lawyer, autonomous decision maker, or substitute for expert review. Medical and behavioral outputs require qualified human oversight.

## Base and training

Primary candidate: Qwen3-8B-Base. Intended adaptation: SFT/QLoRA on provenance-aware research tasks grounded in public evidence. The initial local artifact is an 8B-class MLX LoRA feasibility smoke based on `mlx-community/Qwen3-8B-4bit`; it is not the final Qwen3-8B-Base checkpoint. Dataset hash: `d894eaa8f60ac8272b6690cc662a1ace3ca52144d8c4a053b66114fb1da41ee4`.

## Limitations

The model cannot access sources that are not supplied or connected through tools. It can still misread evidence, overgeneralize populations, confuse correlation with causation, or produce invalid JSON. Citation validation and retrieval-tool safeguards remain necessary.

## Evaluation

See `docs/evaluation.md`. Do not claim improvement until an untouched-base comparison on unseen source combinations is complete.

Initial smoke results are recorded in `docs/initial_build_report.md`; they are not release-quality benchmark results.
