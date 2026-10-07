# Anyways local model benchmark

## Executive summary

- Best measured one-model balance: **qwen3:14b**
- Fastest acceptable model (speed gate: 8 generated tokens/s): **gpt-oss:20b**
- Best classification score: **qwen3:14b**
- Image reviewer: **not recommended until an image-input run is recorded**.

The speed gate is intentional: a higher-quality model that cannot sustain routine newsroom throughput is not a practical default.

## Scorecard

| Model | Pass | tok/s | JSON | Schema | Classification | Claims | Composite | Practical |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| qwen3:14b | 12/12 | 15.44 | 75% | 75% | 100 | 71 | 84 | yes |
| mistral-small3.2:24b | 12/12 | 11.79 | 58.3% | 58.3% | 65 | 71 | 65.1 | yes |
| gemma3:12b | 12/12 | 15.84 | 66.7% | 58.3% | 0 | 71 | 53.8 | yes |
| gemma3:27b | 11/12 | 9.46 | 72.7% | 72.7% | 0 | 43 | 44 | no |
| qwen3:30b | 12/12 | 41.86 | 0% | 0% | 0 | 0 | 34.9 | yes |
| gpt-oss:20b | 12/12 | 44.32 | 16.7% | 16.7% | 0 | 0 | 24.3 | yes |

## Scope and limits

This is a local-only, sequential Ollama run. JSON, taxonomy, and claim labels are deterministic checks. Draft quality needs editorial review of the raw outputs before a production routing decision. 20 classification candidates use the canonical Anyways doctrine.

## Exact run settings

```json
{
  "models": [
    "qwen3:14b",
    "mistral-small3.2:24b",
    "gemma3:12b",
    "gemma3:27b",
    "qwen3:30b",
    "gpt-oss:20b"
  ],
  "context": "8192",
  "temperature": 0.1,
  "top_p": 0.9,
  "num_predict": 700,
  "seed": 42
}
```

Raw response records are in `results/raw/`.
