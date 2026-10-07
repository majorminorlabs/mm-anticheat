# Qwen3-8B smoke test

Date: 2026-09-19

Host: ThinkPad T14 Gen 2a, Vulkan/RADV

Runtime: llama.cpp commit `972d2313bc0bf0a45f634f77d95c9fb03aeab12`

Model artifact: `Qwen3-8B-Q4_K_M.gguf`, staged under the separate remote
`mm-8b-scaling` model directory.

Configuration: context 16,384; temperature 0; seed 0; max tokens 32 for this
neutral probe; reasoning off; no benchmark fixture was supplied.

Result: PASS. The model loaded successfully and returned a valid structured
`get_weather` tool call with `{"city":"Chicago"}`. The raw server log and
JSON response are preserved under `logs/smoke/`.

This is a runtime/interface smoke test only and is not benchmark evidence.
