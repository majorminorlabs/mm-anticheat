# Model manifest

`manifest.json` is the frozen Stage 1 provenance record; `manifest.schema.json`
defines its required fields. GGUF weights are stored outside Git on the
ThinkPad at `/home/dippo/research-inference/models/mm-agent/`.

The four frozen IDs are:

- `mistralai/Ministral-3-3B-Instruct-2512`
- `Qwen/Qwen3-4B`
- `microsoft/Phi-4-mini-instruct`
- `google/gemma-3-4b-it`

Run `python3 models/validate_manifest.py` to validate exact filenames,
quantization, hashes, external paths, template status, runtime commit, and the
absence of tracked GGUF files. The manifest is frozen and must not be updated
to newer revisions after candidate exposure.
