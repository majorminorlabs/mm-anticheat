# Stage 1 candidate amendment v1.1.0

Status: frozen pre-exposure amendment. The parent frozen manifest and all benchmark semantics remain unchanged.

## Decision

The original Phi-4-mini and Gemma-3 candidates are removed before exposure with status `removed_pre_exposure_interface_incompatible`. Their artifacts, manifests, raw attempts, compatibility diagnosis, and history remain preserved. The original 28-run batch remains invalid infrastructure evidence and is not rewritten as capability evidence.

The amendment evaluates two replacements using the same frozen Q4_K_M rule, frozen llama.cpp commit, ThinkPad execution host, Vulkan/RADV backend, and unchanged neutral structured integration gate:

| Candidate | Exact artifact | Size | SHA-256 | Gate |
|---|---|---:|---|---|
| Qwen2.5-3B-Instruct | `Qwen/Qwen2.5-3B-Instruct-GGUF`, `qwen2.5-3b-instruct-q4_k_m.gguf` | 2,104,932,768 | `626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d` | PASS |
| Granite-3.3-2B-Instruct | `ibm-granite/granite-3.3-2b-instruct-GGUF`, `granite-3.3-2b-instruct-Q4_K_M.gguf` | 1,545,303,328 | `ac71e9e32c0bea9191b409c5918f69ca74339854b0319c5065e4e9fb6d95c4852` | FAIL |

Qwen2.5 produced one structured `message.tool_calls` call for the neutral `get_weather` probe and completed the tool-result continuation. Granite loaded successfully on Vulkan/RADV, but its response placed a JSON call in ordinary assistant `content`; `/props` reported `supports_tool_calls: false`, so it fails the frozen transport contract. No model-specific prompt or parser repair was introduced.

The amendment therefore leaves the field with three eligible candidates: Ministral-3-3B-Instruct-2512, Qwen3-4B, and Qwen2.5-3B-Instruct. The intended four-candidate field is not ready because Granite is interface-incompatible. No Q01-Q07 run was executed, and finalist repetitions remain out of scope.

Qwen3’s existing execution condition remains `enable_thinking: false`. No Qwen thinking mode was enabled or changed.

## Reproducibility

- Parent manifest: `models/manifest.json`, v1.0.0.
- Amendment manifest: `models/manifest-stage1-candidate-amendment-v1.1.0.json`.
- Runtime: llama.cpp `972d2313bc0bf0a45f634f77d95c9fb03aeab12`.
- Host: ThinkPad, entered with `sudo -n /usr/sbin/ip netns exec mmagent-offline`.
- Namespace verification: loopback only, no route/default route, direct IP and DNS access failed, host access remained available, localhost entry worked, and Vulkan exposed AMD Radeon Graphics (RADV RENOIR); llvmpipe was present as a secondary enumerated CPU device but was not selected.
- Evidence: `runs/raw/candidate-amendment-integration-gate/thinkpad/`.

Sources: [Qwen2.5 official model page](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct), [Qwen2.5 official GGUF repository](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF), [IBM Granite 3.3 model page](https://huggingface.co/ibm-granite/granite-3.3-2b-instruct), and [IBM Granite official GGUF repository](https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF).
