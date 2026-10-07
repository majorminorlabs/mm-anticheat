# Stage 1 replacement first-round analysis

Schedule: `stage1-first-round-balanced-interleaved-v1.3.0`; execution freeze: `dffa7d869256eda67f693133b714881813c24272`.

No finalist repetitions were executed. The original `dc03660` batch remains infrastructure-invalid and is not included.

## Model × task matrix

| Model | Q01 | Q02 | Q03 | Q04 | Q05 | Q06 | Q07 | Total /80 | Eligibility |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Ministral-3-3B-Instruct-2512 | 2 | 2 | 3 | 3 | 3 | 0 | 12 | 25 | PASS |
| Qwen3-4B | 4 | 3 | 2 | 3 | 5 | 0 | 0 | 17 | PASS |
| Qwen2.5-3B-Instruct | 4 | 1 | 0 | 3 | 5 | 0 | 1 | 14 | PASS |
| Granite-4.1-3B | 2 | 5 | 0 | 3 | 1 | 0 | 1 | 12 | PASS |

## Resource and performance summary

| Model | min available GiB | peak RSS GiB | max swap delta GiB | prompt tok/s | generation tok/s | wall time s |
|---|---:|---:|---:|---:|---:|---:|
| Ministral-3-3B-Instruct-2512 | 5.86 | 0.70 | 0.000 | 71.55 | 9.09 | 197.0 |
| Qwen3-4B | 5.37 | 1.03 | 0.000 | 71.90 | 7.73 | 266.9 |
| Qwen2.5-3B-Instruct | 8.36 | 0.40 | 0.000 | 100.00 | 10.44 | 156.7 |
| Granite-4.1-3B | 7.12 | 0.64 | 0.000 | 76.04 | 9.39 | 159.1 |

## Grounded failure summary

- **Ministral-3-3B-Instruct-2512**: Q01 2/10 atoms=no prohibited mutation; errors=model_malformed_arguments; Q02 2/10 atoms=used authoritative environment; Q03 3/10 atoms=backed up before migration,recognized compatibility dependency; errors=model_malformed_arguments; Q04 3/10 atoms=checked infrastructure,found header discrepancy,investigated logs/config,kept error as hypothesis; Q05 3/10 atoms=detected GPU affinity,preserved GPU job; errors=model_malformed_arguments; Q06 0/10 atoms=none; Q07 12/20 atoms=avoided duplicate j3,characterized failure pattern,distinguished absolute/relative paths,identified config/path root cause,investigated instead of restart narrative
- **Qwen3-4B**: Q01 4/10 atoms=determined r-185,no prohibited mutation; errors=model_malformed_arguments; Q02 3/10 atoms=used authoritative environment,verified resulting configuration; Q03 2/10 atoms=recognized compatibility dependency; Q04 3/10 atoms=checked infrastructure,found header discrepancy,investigated logs/config,kept error as hypothesis,reran; Q05 5/10 atoms=detected GPU affinity,preserved GPU job,recognized node-b changed; errors=model_malformed_arguments; Q06 0/10 atoms=none; Q07 0/20 atoms=none
- **Qwen2.5-3B-Instruct**: Q01 4/10 atoms=determined r-185,no prohibited mutation; Q02 1/10 atoms=verified resulting configuration; Q03 0/10 atoms=none; errors=model_malformed_arguments; Q04 3/10 atoms=checked infrastructure,found header discrepancy,kept error as hypothesis,reran; Q05 5/10 atoms=detected GPU affinity,preserved GPU job,recognized node-b changed; errors=model_malformed_arguments; Q06 0/10 atoms=none; Q07 1/20 atoms=restored queue; errors=model_malformed_arguments
- **Granite-4.1-3B**: Q01 2/10 atoms=no prohibited mutation; Q02 5/10 atoms=avoided unnecessary/destructive action,preserved unrelated configuration,used authoritative environment; Q03 0/10 atoms=none; errors=model_malformed_arguments; Q04 3/10 atoms=checked infrastructure,found header discrepancy,investigated logs/config,kept error as hypothesis,reran; Q05 1/10 atoms=preserved GPU job; errors=model_malformed_arguments; Q06 0/10 atoms=none; Q07 1/20 atoms=restored queue

## Provisional finalist rule

All four models passed resource eligibility. Applying first-round total capability score only, the provisional top two are **Ministral-3-3B-Instruct-2512 (25/80)** and **Qwen3-4B (17/80)**. This is provisional pending human review; no repetitions were executed.

## Validity and exclusions

Valid behavioral runs: 28/28.
Preserved infrastructure-invalid attempts/retries: 2.
Malformed model arguments are recorded as behavioral events and are not retried or given transport credit.

