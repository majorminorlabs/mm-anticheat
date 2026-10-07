# Autonomous discovery operations

The production discovery path is one workflow:

```text
Cloudflare Worker schedule
  -> due Source Graph ingestion
  -> source_events
  -> deterministic score and threshold
  -> candidate_stories plus generate_pitch job
  -> persistent Mac Studio controller
  -> local Ollama/Qwen pitch
  -> Newsroom Pitches
```

The Worker is a dispatcher, not a model worker. Cloudflare invokes its existing
cron trigger once per minute. Supabase decides which reviewed sources are due,
using each source's configured polling interval. The normal source cadence is
therefore about 15 to 30 minutes without requiring a separate timer for every
source. A run claims a bounded source batch, writes normalized `source_events`,
applies the existing Source Graph filters and deterministic score, and queues
only candidates at or above the configured threshold. No model is called in
this stage.

Supabase is the durable boundary. `discovery_runs` records attempts and counts,
`hermes_story_proposals` retains the scored source lead, `candidate_stories`
holds the Pitches projection, and `pipeline_jobs` holds the `generate_pitch`
lease and retry state. Low-scoring leads never become active Pitches records.
The workflow is idempotent across schedule ticks and manual runs. An active
run blocks a second run, source event identity and URL checks suppress
duplicates, and the proposal-to-job marker prevents duplicate Qwen jobs.

## Freshness and backfill

Normal scheduled discovery uses the event's normalized `discovered_at`, which
is the time the Worker first saw the item. The source item's `published_at` is
retained for editorial context and historical backfill, but it is not allowed
to make a newly discovered feed item look stale. Missing or invalid publication
timestamps therefore do not block a newly observed item; missing or invalid
discovery timestamps still do. Discovery timestamps more than 15 minutes in
the future are conservatively excluded from normal scoring. A valid publication
timestamp may be delayed, but it cannot be more than 72 hours old or more than
15 minutes in the future. For each source, the discovery window is:

```text
max(source poll interval + 10 minutes, 20 minutes)
```

The overlap protects against feed delay, clock drift, and a Worker tick close
to the source's polling boundary. A ten-minute source therefore has a
twenty-minute window, an hourly source has a seventy-minute window, and a
six-hour source has a six-hour-ten-minute window. Freshness is checked before
the deterministic proposal score. Existing source-event identity, content
hash, canonical URL, and candidate lineage checks still own deduplication, so
the overlap does not create a second candidate. The source event also records
its deterministic evaluation state, so a low-scoring item is not rescored on
every overlap tick. Historical publication time remains available for an
explicit backfill, while a newly seen item is evaluated once on its discovery
time.

`Run discovery now` uses the same freshness policy as the schedule, but forces
the normal bounded source claim so an operator does not have to wait for the
next source lease. Historical material is only intentional when an operator
calls the authenticated run endpoint with an explicit range, for example:

```json
{
  "mode": "backfill",
  "from": "2026-08-01T00:00:00Z",
  "to": "2026-08-02T00:00:00Z"
}
```

The range is limited to 90 days and is never supplied by the scheduled cron.
Backfill shares the same source-events, deterministic scoring, threshold, and
Qwen job path; it only changes the intentional timestamp range and source
poll eligibility.

The Mac Studio has two persistent local services:

- Homebrew Ollama serves the configured Qwen model on loopback.
- `com.anyways.controller` runs as a per-user LaunchAgent with `RunAtLoad`,
  `KeepAlive`, queue leases, retry handling, and a durable heartbeat in
  `pipeline_controller_health`.

The controller claims only `generate_pitch` jobs for this path. It validates
the structured pitch locally, records `queued`, `writing`, `pitch_ready`, or
`failed`, and never creates an article or publishes. A human editor commissions
the resulting pitch through the existing Pitches workflow before article work
can begin.

## X blind-spot scout

When the Worker has `XAI_API_KEY`, scheduled discovery also runs the separate
X blind-spot scout every hour. It uses the curated `x_scout_watchlist`
for accounts such as ChooseRich, Clemente, AshleyDCan, ZachXBT, Not Thread Guy,
Rasmr ETH, OxSimpleFarmer, and Clutch Markets. The scout
asks X Search for specific recent posts that the normal feed path is likely to
miss: public spectacle, creator self-owns, strong commentary, receipts,
exposes, community drama, and unusual launch or transaction moments.

This is not Source Graph source discovery. The scout does not ask Grok to find
articles, websites, accounts, background research, or publication-ready copy.
It stores the post as a lead event with the exact X URL, then uses a separate
blind-spot proposal queue to hand the lead to the existing Qwen pitch path.
The X post is a lead and must still be verified with primary evidence before
publication. It never publishes automatically.

## Normal operation

Open `/newsroom/pitches`. The Discovery operations panel shows schedule state,
run timestamps, fetched items, new source events, stale and duplicate skips,
fresh items entering scoring, threshold counts, Qwen queue state, controller
health, and recent failures. `Run discovery now` invokes the same Worker
workflow as the schedule. Pause and resume change the durable discovery
setting. A failed Qwen pitch can be retried from its pitch detail view.

Normal use does not require a terminal, `ollama serve`, a controller process,
`wrangler dev`, curl triggers, or manual polling. Those commands remain useful
for development and diagnostics only.

## One-time release setup

1. Back up the linked Supabase database and apply the pending migration with
   the normal Supabase CLI workflow.
2. Deploy the Worker so the cron dispatcher and Newsroom operations endpoints
   are live.
3. Build the controller and install or restart its LaunchAgent once. Confirm
   the configured Qwen model already exists in Ollama.
4. Sign in to the Newsroom and use Pitches for routine monitoring.

The old recurring editorial scoring and Luna queue is disabled by the
canonical migration. Its code and explicit diagnostic commands remain for
rollback and development, but it is not part of scheduled discovery.
