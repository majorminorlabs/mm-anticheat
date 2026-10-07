# Anyways Pipeline V1

Status: final approved architecture implemented in code, disabled pending controlled activation.

`PIPELINE_V1_ENABLED=false` is the default safety state. A production V1 job requires `pipeline_version: "v1"` and either the global flag or an exact job-ID match against `PIPELINE_V1_ALLOWED_JOB_ID`. Jobs without that version, and versioned jobs that do not match the scoped allowance, continue through the committed legacy fallback. When the global flag is true, all versioned V1 jobs are eligible.

## Approved flow

```text
deterministic source aggregation
  -> Luna High discovery and pitch
  -> human pitch approval
  -> research decision: none or required
  -> Terra High research and evidence selection, only when required
  -> deterministic frozen evidence packet
  -> Luna High Draft
  -> deterministic validation
  -> human AI Review
  -> optional manually authorized Sol Medium copy polish
  -> existing human-controlled On Deck and publication workflow
```

There is no automatic Luna Revision, automatic Sol pass, automatic fourth cloud call, or automatic publication. Qwen3 14B remains the legacy fallback. Qwen3.6 27B remains deferred.

## Model policy

| Role | Model | Reasoning | Invocation |
| --- | --- | --- | --- |
| Discovery and pitch | `gpt-5.6-luna` | high | production V1 default |
| Research and evidence selection | `gpt-5.6-terra` | high | exactly once only when `research_requirement` is `required` |
| Draft | `gpt-5.6-luna` | high | exactly once |
| Copy polish | `gpt-5.6-sol` | medium | manually authorized only |
| Legacy fallback | `qwen3:14b` | local | jobs without V1 version or disabled V1 |

All cloud calls use the isolated Codex adapter. Production V1 does not expose Luna Medium, Luna xHigh, Kimi, or Qwen routes.

## Research decision

The approved pitch stores `research_requirement` as `none` or `required` and exposes it to the editor before commissioning.

With `none`, Terra is not called. The packet is built deterministically from the approved retained source set and claim ledger. If that evidence is insufficient, the run transitions to `research_blocked`; it is never silently upgraded to Terra.

With `required`, Terra runs exactly once. Its structured output and offset evidence contract are validated before the packet is frozen. A second call requires the explicit human `research_again` action. The decision and provider-call count are persisted.

## Draft and review

The default V1 path is:

```text
Luna Draft -> deterministic validation -> AI Review
```

A clean Draft proceeds to AI Review. Blocking contract, evidence, or factual failures fail closed. Advisory findings remain visible to the editor. Historical revision artifacts and prompts remain readable for compatibility, but the default production path cannot reach them.

## Manual Sol polish

Sol is a restrained copy editor. It may adjust grammar, punctuation, awkward wording, repetition, rhythm, small transitions, and clarity. Deterministic validation preserves the headline, dek, paragraph order and count, angle, claims, quotations, links, Markdown, claim IDs, evidence IDs, mappings, sources, and length range. It rejects new facts, claims, quotations, examples, metaphors, sources, em dashes, canned contrast constructions, and structural rewrites.

The original Draft remains recoverable. Newsroom shows the original, polished version, structured changes, visual diff, and deterministic findings for both. `Accept Sol polish`, `Reject Sol polish`, and `Restore original Draft` are explicit recorded actions with actor and timestamp.

## Deterministic review and source links

Review validation ignores headline and Markdown-heading capitalization, sentence-initial capitalization, approved packet source and product names, URLs, evidence IDs, claim IDs, and internal metadata when checking names and numbers. Claim support can reference one claim from multiple article anchors when treatment and evidence remain consistent.

AI Review renders deterministic source links adjacent to claims and paragraphs from frozen claim-support mappings. Each link shows source title, publisher when available, and URL. It must belong to the frozen packet. Prose-level inline-link injection is not part of V1.

## Persistence and activation boundary

V1 stage artifacts use the existing durable `persist_pipeline_phase2_stage_v3` contract. The additional Sol migration adds research-decision validation, durable polish artifacts, explicit polish authorization, accept/reject/restore actions, and the V1 job type. Local state remains a test and explicitly local-development aid, not production truth.

The feature flag stays false until the migration set is reviewed and applied, the controller artifact is deployed, the controller is restarted under the activation runbook, and one controlled live story is completed.

## Human gates

1. Approve the pitch.
2. Select or confirm the research requirement.
3. Commission the V1 story.
4. Resolve any research blocker or explicitly authorize research again.
5. Review the frozen packet, Draft, findings, and source links.
6. Optionally authorize and decide on Sol polish.
7. Approve the final article to On Deck.
8. Publish or schedule separately.

No stage publishes automatically.
