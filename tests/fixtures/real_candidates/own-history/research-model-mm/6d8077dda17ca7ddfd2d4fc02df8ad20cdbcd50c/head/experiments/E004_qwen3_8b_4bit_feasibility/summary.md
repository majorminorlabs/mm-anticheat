# E004_qwen3_8b_4bit_feasibility: Qwen3-8B-class 4-bit MLX feasibility smoke

Status: **completed**
Metadata: **reconstructed_after_fact**

Research question: Can an approximately 8B quantized MLX checkpoint accept the research-behavior adapter on the local machine?

Interpretation: The local machine could run the 8B-class quantized adapter path, making a longer MLX feasibility run practical.

Known limitations:
- Instruct-derived quantized conversion rather than the primary base checkpoint.
- Five iterations are not a model-quality experiment.

This manifest was reconstructed from the listed reports and artifact metadata. Null fields are intentionally not guessed.
