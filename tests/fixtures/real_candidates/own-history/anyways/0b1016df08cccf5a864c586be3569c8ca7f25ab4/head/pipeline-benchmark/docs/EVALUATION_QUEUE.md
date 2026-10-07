# Benchmark v1.0 model evaluation plan

Benchmark v1.0 is locked. This plan schedules measurements using the existing
instrument. It does not authorize changes to fixtures, prompts, schemas,
scoring, lifecycle behavior, validation, reporting, metrics, or other frozen
benchmark semantics.

Evidence for readiness was checked on July 30, 2026. Availability must be
verified again immediately before each paid or remote execution.

## Evaluation queue

| Order | Model | Model identifier | Provider | Execution method | Expected availability | Status |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Kimi K3 | `cloud-kimi-k3` (`kimi-code/k3-256k`) | Kimi Code | Existing Kimi Code CLI adapter, remote OAuth provider | Configured locally; live entitlement and token validity require the standard pre-run check | ready |
| 2 | Kimi 2.7 | `cloud-kimi-2-7` (`kimi-code/kimi-for-coding`) | Kimi Code | Existing Kimi Code CLI adapter, remote OAuth provider | Configured locally; live entitlement and token validity require the standard pre-run check | ready |
| 3 | Sol High | proposed `cloud-sol-high` (`gpt-5.6-sol`, high reasoning) | OpenAI Codex | No benchmark-compatible execution method is configured | Unknown until a compatible authenticated route is configured and validated | blocked |
| 4 | Sol Medium | proposed `cloud-sol-medium` (`gpt-5.6-sol`, medium reasoning) | OpenAI Codex | No benchmark-compatible execution method is configured | Unknown; expected to share the Sol High route if that route can preserve frozen conditions | blocked |
| 5 | Terra | proposed `cloud-terra` (`gpt-5.6-terra`) | OpenAI Codex | No benchmark-compatible execution method is configured | Unknown until provider access and a compatible authenticated route are confirmed | blocked |
| 6 | Luna (optional) | proposed `cloud-luna` (`gpt-5.6-luna`) | OpenAI Codex | Hermes currently references the model, but the benchmark has no Hermes or Codex execution integration | Optional and unconfirmed for benchmark use | blocked |

No model is currently running. A status moves to `running` only after freeze,
environment, availability, authorization, and production-coordination checks
pass. A status moves to `completed` only after the run terminates, artifacts
are preserved, blind human scores are locked, and the existing results importer
accepts the run.

## Readiness matrix

| Model | Missing credentials | Missing adapter | Missing CLI integration | Missing local model | Missing configuration | Estimated work before benchmarking |
| --- | --- | --- | --- | --- | --- | --- |
| Kimi K3 | None detected. An OAuth provider and credential storage exist; validity is not proven without a pre-run access check. | No | No | Not applicable | No | 15–30 minutes for freeze, environment, alias, OAuth-validity, queue-idle, and paid-run authorization checks |
| Kimi 2.7 | None detected. An OAuth provider and credential storage exist; validity is not proven without a pre-run access check. | No | No | Not applicable | No | 15–30 minutes for the same pre-run checks after K3 restoration is verified |
| Sol High | Yes. The standalone Codex CLI reports `Not logged in`, and no API credential is present in the benchmark environment. | Yes. No frozen benchmark adapter currently routes OpenAI Codex models. | Yes | Not applicable | Yes. No Benchmark v1.0 model entry or approved execution route exists. | 4–8 engineering hours to establish credentials and determine whether a route can satisfy v1.0 without changing frozen artifacts; remains blocked if it cannot |
| Sol Medium | Same missing credential path as Sol High | Same as Sol High | Same as Sol High | Not applicable | Yes. The medium reasoning variant is not configured. | 30–60 minutes after a compliant Sol High route exists; otherwise the same 4–8 hour blocker |
| Terra | Yes. No benchmark-accessible credential or entitlement has been verified. | Yes | Yes | Not applicable | Yes. No model entry or execution route exists. | 2–4 engineering hours after a compliant OpenAI route exists; otherwise blocked pending route design |
| Luna (optional) | Unresolved. Hermes has an OpenAI Codex OAuth configuration, but reuse by the benchmark is neither configured nor assumed. | Yes | Yes | Not applicable | Yes. No model entry or benchmark execution route exists. | 2–4 engineering hours after a compliant route exists, plus entitlement verification; defer while optional |

The Kimi CLI is installed at version 0.29.2. Its configuration validates
successfully and lists the managed Kimi OAuth provider with four model aliases.
The existing benchmark model configuration already enables both Kimi
candidates. The official production-coordination variables are present in the
existing local environment file, although they are intentionally not loaded
into every shell.

Sol High is named in the local Codex configuration, and Luna is named in the
local Hermes configuration. Those facts are evidence of use in other tools,
not evidence of benchmark availability. They do not remove the credential,
adapter, CLI-integration, or Benchmark v1.0 configuration blockers above.

## Canonical evaluation workflow

1. Verify the Benchmark v1.0 freeze and canonical manifest hash.
2. Verify the execution environment, production controller state, idle queue,
   credentials, provider entitlement, exact model identifier, and required
   authorization.
3. Execute exactly one model through the unchanged official benchmark path.
4. Generate and seal the blind review packages without exposing model identity.
5. Complete the blind human review and lock every completed-stage score,
   readiness classification, confidence assessment, and incomplete-stage note.
6. Import the locked scores through the existing results index.
7. Rebuild the existing canonical leaderboard and reports.
8. Preserve run manifests, raw outputs, blind packages, score locks, checksums,
   and restoration evidence without rewriting historical artifacts.
9. Confirm production restoration, then repeat the process for the next ready
   model.

Any freeze mismatch, active production work, unavailable model, invalid
credential, missing authorization, failed restoration, or incompatible
execution route stops the workflow. It does not justify changing Benchmark
v1.0.

## Recommended execution schedule

1. **Kimi K3.** It is the Kimi CLI default, already enabled in the benchmark
   model configuration, and uses the existing frozen adapter.
2. **Kimi 2.7.** It uses the same configured provider and frozen adapter. Run it
   only after K3 artifacts are preserved and production restoration is verified.
3. **Sol High.** This is the first blocked candidate because there is current
   local evidence for the model name and high reasoning setting. Do not schedule
   execution until a compatible route exists without frozen benchmark changes.
4. **Sol Medium.** Reuse the Sol route only after the high variant proves that
   the route preserves identical Benchmark v1.0 conditions.
5. **Terra.** Provider access, credentials, model configuration, and execution
   integration all remain unverified.
6. **Luna.** Keep optional and last. Existing Hermes configuration is
   insufficient evidence of benchmark compatibility.

This order reflects implementation readiness only. It makes no claim about
expected model quality or leaderboard performance.
