# Stage 1 candidate amendment v1.3.0

Status: frozen pre-exposure four-candidate field. No Q01–Q07 content was exposed.

## Runtime compatibility

The frozen llama.cpp commit `972d2313bc0bf0a45f634f77d95c9fb03aeab12` already contains Granite 4.1 support. The exact introducing commit is `bb771cbd2bfd92cfc99263e75053f5eb9b936d84`, dated 2026-05-28, subject `chat : add Granite 4.1 chat template (#23518)`. It is an ancestor of the frozen commit. The frozen source includes `LLM_CHAT_TEMPLATE_GRANITE_4_1`, template detection, and the Granite 4.1 application path. No runtime upgrade or execution-config v2 is required.

## Granite 4.1 provenance and gate

- Upstream: `ibm-granite/granite-4.1-3b`, revision `c0650403e44e78ec0262dab1c90914c65b196c4e`.
- License: Apache-2.0.
- Architecture: `GraniteForCausalLM`, dense decoder-only Transformer, 3B class.
- Official GGUF: `ibm-granite/granite-4.1-3b-GGUF`, revision `ab4701481089b58a082ef63cc1cee738887293ff`.
- File: `granite-4.1-3b-Q4_K_M.gguf`.
- Size: 2,099,501,664 bytes.
- SHA-256: `662b0626cd58f443baea23559b469df6576a81d349649c59413b36a9fb32eb29`.
- ThinkPad path: `/home/dippo/research-inference/models/mm-agent/granite-4.1-3b-Q4_K_M.gguf`.
- Runtime: frozen llama.cpp, Vulkan/RADV, `mmagent-offline` namespace.

The embedded template supports tools, structured assistant tool calls, object arguments, tool-role messages, and continuation. The unchanged neutral two-turn gate passed: one structured `message.tool_calls` call was returned, the dummy tool result was supplied in a tool-role message, and the second assistant response completed successfully. No model-specific prompt, parser workaround, or textual-call acceptance was used.

## Final field

| Candidate | Status |
|---|---|
| Ministral 3 3B Instruct 2512 | PASS, prior evidence retained |
| Qwen3 4B | PASS, prior evidence retained; `enable_thinking=false` |
| Qwen2.5 3B Instruct | PASS, prior evidence retained |
| Granite 4.1 3B | PASS, neutral structured gate |

Historical interface exclusions remain preserved: Phi-4-mini, Gemma-3-4B, Granite-3.3-2B, and SmolLM3-3B. They are not capability scores. The final four-model field is ready for the separately authorized replacement 28-run first round.

Sources: [Granite 4.1 model page](https://huggingface.co/ibm-granite/granite-4.1-3b), [official Granite 4.1 GGUF repository](https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF), and [llama.cpp Granite 4.1 support commit](https://github.com/ggml-org/llama.cpp/commit/bb771cbd2bfd92cfc99263e75053f5eb9b936d84).
