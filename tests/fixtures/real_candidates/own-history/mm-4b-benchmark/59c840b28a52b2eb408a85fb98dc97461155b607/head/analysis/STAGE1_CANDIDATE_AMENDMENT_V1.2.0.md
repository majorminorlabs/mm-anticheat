# Stage 1 candidate amendment v1.2.0

Status: frozen pre-exposure compatibility amendment. No benchmark task, scorer, resource rule, or runtime was changed.

## SmolLM3 result

The exact public `HuggingFaceTB/SmolLM3-3B` upstream revision `a07cc9a04f16550a088caea529712d1d335b0ac1` and official `ggml-org/SmolLM3-3B-GGUF` Q4_K_M artifact were downloaded to the ThinkPad and hashed successfully:

- File: `SmolLM3-Q4_K_M.gguf`
- Size: 1,915,305,312 bytes
- SHA-256: `8334b850b7bd46238c16b0c550df2138f0889bf433809008cc17a8b05761863e`
- License: Apache-2.0
- Local path: `/home/dippo/research-inference/models/mm-agent/SmolLM3-3B-Q4_K_M.gguf`

The upstream template documents XML/Python tool modes and `enable_thinking`. The exact GGUF template was inspected through `/props` under frozen llama.cpp commit `972d2313bc0bf0a45f634f77d95c9fb03aeab12`. The runtime classified it as `supports_tools: false` and `supports_tool_calls: false`. The neutral two-turn gate returned ordinary assistant content containing an empty `<think>` sentinel and no structured `message.tool_calls`. Therefore SmolLM3 fails the required frozen interface.

No template patch, parser workaround, model-specific semantic prompt, or runtime upgrade was used. SmolLM3 is recorded as `removed_pre_exposure_interface_incompatible`; this is an interface finding, not a capability score. No Q01–Q07 content was exposed.

## Final pre-exposure field

| Candidate | Status |
|---|---|
| Ministral-3-3B-Instruct-2512 | PASS, retained prior evidence |
| Qwen3-4B | PASS, retained prior evidence; `enable_thinking=false` |
| Qwen2.5-3B-Instruct | PASS, retained prior evidence |
| SmolLM3-3B | removed_pre_exposure_interface_incompatible |

Historical exclusions remain preserved: Phi-4-mini, Gemma-3-4B, and Granite-3.3-2B, all for structured interface incompatibility. The four-model replacement field is not ready for the 28-run first round.

Raw evidence: `runs/raw/candidate-amendment-integration-gate/thinkpad/SmolLM3-3B/`.

Sources: [SmolLM3-3B model card](https://huggingface.co/HuggingFaceTB/SmolLM3-3B) and [official SmolLM3 GGUF repository](https://huggingface.co/ggml-org/SmolLM3-3B-GGUF).
