# Stage 1 first-round report

Status: 28/28 scheduled observations completed on the ThinkPad; finalist
repetitions not started.

## Frozen controls

- Execution configuration commit: `d0262b31080b85a9daff282dff32cc47a9ed67c5`
- Qwen condition: `enable_thinking: false` and runtime `--reasoning off`
- llama.cpp: `972d2313bc0bf0a45f634f77d95c9fb03aeab12`
- Backend: Vulkan/RADV; context 16384; temperature 0; seed 0; no external tools
- Schedule commit: `c9ac0ad` (balanced/interleaved 28-run schedule)

## Host and isolation

Execution ran through `ssh thinkpad` using the restricted noninteractive rule
and `sudo -n /usr/sbin/ip netns exec mmagent-offline ...`. The namespace had
only `lo`, no address beyond loopback, and no route. Direct external IP and
HTTPS access failed; direct DNS packets failed (the observed `getent` result
was a resolver-cache result). Loopback communication succeeded. Host internet
outside the namespace succeeded. Vulkan exposed AMD Radeon Graphics (RADV
RENOIR) as GPU0; llvmpipe was present as GPU1 but was not selected by the
llama.cpp probes. Frozen model hashes and the llama.cpp revision matched the
manifest.

Raw isolation/post-run evidence is in
`runs/raw/stage1-first-round/namespace-postrun-preflight.txt`.

## Results

The frozen deterministic scorer produced the following raw totals. Every model
had seven runs and no catastrophic action was recorded.

| Model | Points | Max | Mean/run | Parse failures | Mean elapsed (s) |
|---|---:|---:|---:|---:|---:|
| Gemma-3-4B-IT | 8 | 80 | 1.143 | 7/7 | 66.94 |
| Ministral-3-3B-Instruct-2512 | 8 | 80 | 1.143 | 7/7 | 20.98 |
| Phi-4-mini-instruct | 8 | 80 | 1.143 | 7/7 | 15.36 |
| Qwen3-4B | 8 | 80 | 1.143 | 7/7 | 105.50 |

The complete per-run result is `runs/processed/stage1-first-round-results.json`;
all raw stdout, command metadata, and parsed artifacts are preserved under
`runs/raw/stage1-first-round/`.

## Eligibility and interpretation

The RAM floor remained satisfied in the captured pre-run snapshots and the
post-run host had about 10 GiB available. However, recorded swap increased
from the preflight baseline of about 0.9 GiB to about 2.1 GiB after the
qualification loop. Because per-run swap attribution was not captured, the
frozen rule cannot certify zero model-attributable inference swap. The first
round is therefore reported as executed raw evidence, but not as a valid
resource-eligible finalist selection. No model is selected and no finalist
repetitions are launched.

Performance evidence is retained in each llama.cpp stdout log, including load,
prompt-evaluation, generation, and total timings. Resource evidence includes
per-run pre-inference `/proc/meminfo` snapshots plus the namespace/post-run
resource check; continuous per-process RSS and swap attribution are not
available for these completed runs and are not inferred.
