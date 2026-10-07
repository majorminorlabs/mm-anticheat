# Decisions and approval items

- The fixtures from commit `501a10857fb87d36a843a4d47f3520f3d6f01e13` were
  pre-execution proposals. They were reconciled to the authoritative designs
  supplied afterward, before any candidate model exposure.
- Resource eligibility is frozen at >=5.0 GiB available system memory, zero
  candidate-attributable swap, and no memory-related instability. Independent
  baseline swap is recorded and distinguished.
- The simulator accepts structured tool calls and records every request,
  response, state mutation, invalid call, prohibited call, and termination.
- Scoring is explicit and deterministic; no LLM judge is used.
- The mock dry run exercises valid success paths plus the required adversarial
  catastrophic and cap probes.
