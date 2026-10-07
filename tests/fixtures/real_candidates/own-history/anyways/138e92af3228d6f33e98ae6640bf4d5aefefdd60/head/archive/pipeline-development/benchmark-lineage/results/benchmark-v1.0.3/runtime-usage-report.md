# Benchmark v1.0.3 Runtime and Usage

Token fields remain unavailable where a provider did not report them. Cached input is included within input when reported by Codex.

| Model | Benchmark wall | Attempted-stage wall | Input tokens | Cached input | Output tokens | Reasoning tokens | Provider usage stages |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cloud-luna-xhigh | 693.11s | 686.15s | 243835 | 9728 | 36323 | 27525 | 10/10 |
| cloud-terra-high | 231.96s | 224.74s | 243535 | 29184 | 10761 | 3699 | 10/10 |
| cloud-luna-high | 410.94s | 387.27s | 243701 | 9728 | 19841 | 11437 | 10/10 |
| cloud-sol-medium | 375.08s | 368.09s | 243971 | 15104 | 15125 | 4263 | 10/10 |
| cloud-kimi-k3 | 295.90s | 290.55s | Unavailable | Unavailable | Unavailable | Unavailable | 0/8 |
| cloud-kimi-2-7 | 1059.58s | 1054.07s | Unavailable | Unavailable | Unavailable | Unavailable | 0/8 |
| local-qwen3-14b | 3524.06s | 3515.97s | 173504 | Unavailable | 6109 | Unavailable | 9/10 |
