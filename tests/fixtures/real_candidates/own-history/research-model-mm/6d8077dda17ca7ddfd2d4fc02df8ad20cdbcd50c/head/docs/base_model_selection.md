# Base-model selection record

Selection date: 2026-09-15. This is a short practical screen, not a claim of exhaustive benchmarking.

| Candidate | License | Context | Decision |
| --- | --- | --- | --- |
| `Qwen/Qwen3-8B-Base` | Apache-2.0 | 32,768 native tokens | Primary |
| `allenai/OLMo-2-1124-7B` | Apache-2.0 | 4,096 tokens | Open-science comparison |
| `meta-llama/Llama-3.1-8B` | Llama 3.1 Community License | 128K tokens | Licensing comparison |

Qwen3-8B-Base is the primary target because it is in the requested size class, has an Apache-2.0 model card, 8.2B parameters, GQA, a 32K native context, and an active ecosystem for Transformers, vLLM, SGLang, MLX-LM, and local inference. The base checkpoint is the correct starting point for research-behavior SFT; an instruct checkpoint remains a useful later comparison.

OLMo-2-1124-7B is attractive for fully open research reproducibility and Apache-2.0 terms, but its model card reports a 4K context and older pretraining cutoff. Llama 3.1-8B has a strong 128K context claim but uses a custom community license with additional use and redistribution obligations, so it is not the default for a clean open release.

The next empirical screen should run the same held-out micro-benchmark plus ordinary-capability sanity checks on these three candidates when checkpoints are available. This file records the decision rationale; it does not substitute for that run.

## Primary references

- Qwen model card: <https://huggingface.co/Qwen/Qwen3-8B-Base>
- OLMo model card: <https://huggingface.co/allenai/OLMo-2-1124-7B>
- Llama model card: <https://huggingface.co/meta-llama/Llama-3.1-8B>

