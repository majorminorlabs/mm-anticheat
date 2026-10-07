# Benchmark v1.0.3 Final Model Comparison

This report separates completed-stage editorial quality from completion and structured-output reliability. Missing stages are never treated as zero quality scores.

## Editorial quality and reliability

| Model | Apple | Logitech | Overall | Stage completion | Structured compliance | Timeouts | Publication readiness |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| cloud-luna-xhigh | 8.40 | 8.00 | 8.20 | 100.00% | 100.00% | 0 | moderate edit |
| cloud-terra-high | 8.40 | 8.00 | 8.20 | 100.00% | 100.00% | 0 | moderate edit |
| cloud-luna-high | 8.60 | 7.60 | 8.10 | 100.00% | 100.00% | 0 | moderate edit |
| cloud-sol-medium | 8.20 | 8.00 | 8.10 | 100.00% | 100.00% | 0 | moderate edit |
| cloud-kimi-k3 | 8.00 | Unavailable | 8.00 | 40.00% | 50.00% | 0 | unsuitable |
| cloud-kimi-2-7 | 8.00 | 6.00 | 7.50 | 40.00% | 50.00% | 0 | unsuitable |
| local-qwen3-14b | 4.40 | 3.75 | 4.11 | 90.00% | 90.00% | 1 | major rewrite |

## Runtime, token use, and quality per runtime minute

Quality per runtime minute is the completed-stage human average divided by benchmark wall-clock minutes. Completion remains visible because a fast partial run is not equivalent to a complete run.

| Model | Runtime | Input | Cached input | Output | Reasoning | Quality/minute | Completion |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cloud-luna-xhigh | 693.11s | 243835 | 9728 | 36323 | 27525 | 0.71 | 100.00% |
| cloud-terra-high | 231.96s | 243535 | 29184 | 10761 | 3699 | 2.12 | 100.00% |
| cloud-luna-high | 410.94s | 243701 | 9728 | 19841 | 11437 | 1.18 | 100.00% |
| cloud-sol-medium | 375.08s | 243971 | 15104 | 15125 | 4263 | 1.30 | 100.00% |
| cloud-kimi-k3 | 295.90s | Unavailable | Unavailable | Unavailable | Unavailable | 1.62 | 40.00% |
| cloud-kimi-2-7 | 1059.58s | Unavailable | Unavailable | Unavailable | Unavailable | 0.42 | 40.00% |
| local-qwen3-14b | 3524.06s | 173504 | Unavailable | 6109 | Unavailable | 0.07 | 90.00% |

## Stage-specific strengths

- Draft: cloud-kimi-2-7 (8.00)
- Revision: cloud-luna-xhigh, cloud-luna-high (7.50)
- Reviewer: cloud-luna-high, cloud-sol-medium, cloud-kimi-k3, cloud-kimi-2-7 (9.00)
- Evidence Selector: cloud-terra-high (9.00)
- Research Planner: cloud-luna-xhigh, cloud-terra-high, cloud-luna-high, cloud-sol-medium (9.00)

## Measured findings

- Overall quality leaders: cloud-luna-xhigh, cloud-terra-high (8.20)
- Complete structured-output leaders: cloud-luna-xhigh, cloud-terra-high, cloud-luna-high, cloud-sol-medium
- Best quality per runtime minute among complete runs: cloud-terra-high (2.12)
- No completed candidate achieved publish-with-no-edits readiness on either fixture.

## Recommendations for pipeline-design discussion

These recommendations interpret the measured results; they are not additional benchmark measurements.

- Discovery and triage: cloud-terra-high is the strongest provisional candidate because it combines the leading Evidence Selector score, a leading Research Planner score, full reliability, and the fastest complete runtime. Discovery itself was not directly benchmarked.
- Research planning: cloud-terra-high, cloud-luna-high, cloud-luna-xhigh, and cloud-sol-medium are tied on completed human scores; runtime favors cloud-terra-high.
- Evidence selection: cloud-terra-high leads. cloud-sol-medium and cloud-luna-xhigh are credible alternatives.
- Drafting: cloud-luna-xhigh and cloud-terra-high are the strongest fully complete candidates. cloud-kimi-2-7 has the highest completed Draft score but lacks production-grade completion reliability.
- Revision: cloud-luna-high and cloud-luna-xhigh lead. Human review remains necessary because no candidate produced publish-with-no-edits articles.
- Review: cloud-luna-high and cloud-sol-medium combine a leading Reviewer score with full completion. The Kimi candidates tie on completed Reviewer quality but not reliability.
- Exclude cloud-kimi-k3 and cloud-kimi-2-7 from unattended production because of low completion and structured compliance. Exclude local-qwen3-14b because of low editorial quality, a timeout, and major-rewrite readiness.
- The completed campaign is sufficient to begin human-supervised pipeline design. Further model benchmarking is not required before that design work, though production holdout validation remains appropriate before deployment.
