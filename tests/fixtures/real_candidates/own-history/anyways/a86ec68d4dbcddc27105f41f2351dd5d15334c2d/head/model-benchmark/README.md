# Anyways local-model benchmark

This directory is deliberately isolated from the production application. It sends
requests only to the local Ollama server at `http://127.0.0.1:11434` and writes
raw responses under `results/raw/`.

Run the repeatable benchmark:

```sh
node model-benchmark/run.mjs --models qwen3:14b,gemma3:12b,gpt-oss:20b,mistral-small3.2:24b,qwen3:30b,gemma3:27b
node model-benchmark/report.mjs
```

Use `--contexts 8192,16384,32768` to include the practical-context probe. The
runner is sequential by design; it never deletes models or touches application
files outside this directory.
