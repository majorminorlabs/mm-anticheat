# E003_qwen3_0_6b_aligned_smoke: Qwen3-0.6B aligned MLX research-behavior smoke

Status: **completed**
Metadata: **reconstructed_after_fact**

Research question: Can the aligned protocol data change targeted structured behavior in a small local model?

Interpretation: The corrected aligned run changed structured protocol behavior and reduced unsupported outputs on the held-out SciFact-derived test, but the sample, model size, and training budget are not sufficient for broad capability claims.

Known limitations:
- 20 iterations and 0.6B model.
- The test set is derived from the same source family as training, with source-grouped split but limited domain diversity.

This manifest was reconstructed from the listed reports and artifact metadata. Null fields are intentionally not guessed.
