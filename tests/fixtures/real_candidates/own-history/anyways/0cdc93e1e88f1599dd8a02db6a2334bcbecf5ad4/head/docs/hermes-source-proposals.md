# Historical source-proposal handoff

This document describes the superseded Hermes writer bridge. It is retained as
an implementation record, not as a production operating instruction. The
canonical production handoff is Source Graph -> deterministic threshold ->
local Qwen `generate_pitch` -> Newsroom Pitches. Do not run the Hermes bridge
for normal discovery operations. The canonical migration reassigns queued
source proposals to the Qwen backend and pauses the old recurring editorial
automation loop.

The source graph now has a narrow handoff for breaking leads:

    Source RSS/page -> source_events -> hermes_story_proposals -> Hermes
                                                            -> ready_for_review

The Cloudflare Worker queues recent events from high-fit sources with
pipeline_role set to discovery or both and editorial_fit >= 3.5. This includes
X posts after the separate paced browser collector has normalized them into
source_events; it does not activate X ingestion. Verification-only, Telegram,
and API records remain out of writing work until they have a supported adapter.
Broad collectible, regulator, and DOJ feeds have source-specific bridge terms,
matched as exact normalized words or phrases against the event title and
summary. Generic card releases and unrelated government notices therefore do
not become writing work. Exact-title duplicates and canonical URLs already in
the editorial pipeline are suppressed while a proposal is active. The active
handoff backlog is capped at 100 proposals, so source polling remains bounded
while Hermes is offline or slower than discovery. A source event remains
available to Hermes as evidence and related source events can be fetched from
the normal editor-readable source tables.

Hermes should use a Supabase Auth account whose profile role is hermes_writer.
It should not receive the service-role key. The narrow RPC contract is:

1. claim_hermes_story_proposals(worker_id, limit, lease_seconds, now)
2. submit_hermes_story_package(proposal_id, worker_id, package)
3. update_hermes_story_proposal(proposal_id, worker_id, status, error) for a
   failed, rejected, cancelled, or in-progress handoff

For an authenticated Hermes account, the database binds the worker identity to
that account's auth.uid() even if a different worker ID is supplied. Pass the
account UUID, or omit it on the claim call. The service role is reserved for
the Worker queue and emergency operational recovery.

Hermes uses the same editorial package rules as the Anyways writing workspace.
Section headings are optional in the generated body. The editor can add
## headings while revising the article.

The package accepted by submit_hermes_story_package is:

    {
      "headline": "A defensible proposed headline",
      "dek": "What changed and why it matters.",
      "body_markdown": "The complete draft in Markdown with natural inline source links.",
      "social_post": "One accurate native social post.",
      "research_markdown": "The internal research packet and unresolved questions.",
      "primary_section": "digital-collectibles",
      "story_form": "meanwhile",
      "beats": ["nfts", "brands"],
      "tags": ["pokemon", "collectibles"],
      "sources": [
        {
          "url": "https://example.com/source",
          "title": "Source title",
          "published_at": "2026-08-15T12:00:00Z",
          "author": "Reporter",
          "used_for": "Confirms the launch date and product details.",
          "raw_text": "The bounded source text retained for review."
        }
      ],
      "claims": [
        {
          "claim": "A material claim in the draft.",
          "status": "needs_review",
          "note": "What the editor should verify.",
          "source_indexes": [1]
        }
      ]
    }

source_indexes are one-based. The RPC creates the candidate, owned pipeline
run, research packet, retained source documents, draft, social post, and claim
ledger, then stops at ready_for_review. It never creates a stories row,
approves a package, or publishes. The existing newsroom review and approval
flow remains the human handoff into the editor.

The body must use descriptive Markdown links such as
[the official announcement](https://example.com) rather than raw URLs. The
source list must contain only sources actually used, with primary evidence
first. Hermes should preserve allegations, inferences, and unresolved claims
as such. The server rejects packages without a social post, research packet,
and inline Markdown source link.

## Hermes bridge

The repository includes a narrow CLI bridge for the other machine. Configure
SUPABASE_URL, SUPABASE_ANON_KEY, HERMES_EMAIL, HERMES_PASSWORD, and the
optional HERMES_WORKER_ID as protected environment variables, then expose
these commands to Hermes:

    node bin/hermes-source-proposals.mjs claim --limit 1
    node bin/hermes-source-proposals.mjs update --proposal-id <uuid> --status writing
    node bin/hermes-source-proposals.mjs submit --proposal-id <uuid> --package-file ./package.json

The bridge signs in as the dedicated hermes_writer Auth account. It never
accepts or stores the Supabase service-role key. A claimed proposal is leased,
so a crashed writer can be reclaimed after the lease expires.

In Newsroom, editors can see the waiting source leads and completed Hermes
packages under /newsroom/review. A completed package opens through the normal
AI Review editor. Approval creates the ordinary unpublished story draft; it
does not publish.

The source registry migration intentionally activates only a bounded RSS
tranche. Paywalled, WAF-blocked, page-only, API, calendar, Telegram, and X
sources remain staged or require their own adapter. X ingestion is still
separate and currently depends on the authenticated browser session on the
controller machine.
