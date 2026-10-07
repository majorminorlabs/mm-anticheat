# Anyways Controller operator runbook

## Safe operating boundary

The controller is a loopback-only LaunchAgent. It receives work from the Supabase queue, invokes a fixed local pipeline adapter, and writes queue state. It does not publish, alter the Obsidian vault, or expose an Internet-reachable endpoint.

`/Volumes/External/GitHub/IGNORED/anyways/apps/controller/.env` is mode `0600`; do not print or commit it. The service-role key is local-service-only.

## Routine commands

```sh
cd /Volumes/External/GitHub/IGNORED/anyways/apps/controller
npm run launchd -- status
curl -fsS http://127.0.0.1:4317/health
npm run job:list
npm run job:get -- <job-id>
npm run launchd -- tail
```

The health response should report `status: ok`, queue and Ollama connectivity, and no unexpected `current_job_id` when idle.

## Source configuration and discovery

The production Source Graph discovery path is Worker-scheduled. Cloudflare
dispatches once per minute; the Worker claims only sources whose Supabase
poll interval is due, writes `source_events`, applies the deterministic
threshold, and creates durable `generate_pitch` jobs. The controller does not
run source discovery and must not be started from a terminal for normal use.

The Mac Studio's normal services are Homebrew Ollama and the
`com.anyways.controller` LaunchAgent. The LaunchAgent starts at login, keeps
the controller alive after a crash, claims Qwen jobs, retries transient
failures, and writes its heartbeat to Supabase. Editors monitor the complete
handoff from `/newsroom/pitches`, which also contains `Run discovery now` and
the failed-pitch retry control.

Use the following only for diagnostics or a one-time service update:

```sh
cd /Volumes/External/GitHub/IGNORED/anyways/apps/controller
npm run launchd -- status
npm run launchd -- restart
```

Do not use the legacy `discover` job or the recurring editorial scoring/Luna
queue as a second scheduled discovery system. Those paths remain available
only for explicit compatibility and development work.

## X Browser normal profile and health

The controller uses a Chrome-managed `Anyways X` profile in the dedicated
non-default user-data directory `~/Library/Application Support/Anyways X
Chrome`, with profile directory `Default`. Chrome creates and owns it; the
controller never copies profile data, exports cookies, logs credentials, or
automates X sign-in.

```sh
cd /Volumes/External/GitHub/IGNORED/anyways/apps/controller
npm run x-browser:open-profile
```

Sign into X manually in that Chrome window. Close Chrome normally after the
login, then start the same profile with loopback CDP:

```sh
npm run x-browser:open-profile -- --debug
npm run x-browser:check-auth
npm run x-browser:health
```

Production X polling is deliberately single-account and single-page. The
default visit gap is randomized between 90 seconds and 6 minutes, the normal
ceiling is 8 visits per hour with a hard ceiling of 12, and every fourth visit
starts an 8-to-20-minute cooldown. Account cooldowns are 15 minutes for
priority 9-10, 30 minutes for priority 7-8, and 60 minutes otherwise. Empty
timelines double the account cooldown. Rate limits, challenges, login prompts,
and DOM failures stop polling; ordinary failures back off at 15 minutes,
30 minutes, then 2 hours. Login and challenge states require manual review.
These controls are durable in Supabase, so a controller restart cannot create a
catch-up burst.

Profile locks are a stop condition. Do not force-terminate Chrome, copy the
profile, extract session data, or use the disabled Playwright login path.

Production discovery reads the live Web3 Source Graph from Supabase. A record is eligible only when it is active, editor-reviewed, a feed-capable source (`rss`, `blog`, or `official_announcements`), and in `ready`, `healthy`, `degraded`, or `failed` ingestion state. Its primary sections become its Coverage Focus memberships. X accounts and unactivated feeds are excluded even if they are otherwise active.

The retired `pipeline-state/sources.json` fallback is not shipped. Production discovery requires the eligible Web3 Source Graph through Supabase. Credential-free legacy discovery fails closed; for an isolated local test only, set `ANYWAYS_PIPELINE_SOURCES_FILE` explicitly to a reviewed Web3-only fixture. Never use a local fixture to override, copy, or activate production Source Graph records. Never put credential values in the file; name an environment variable instead.

```sh
cd /Volumes/External/GitHub/IGNORED/anyways/apps/controller
npm run job:submit -- discover
```

Inspect the completed job for `focus_id`, `enabled_source_count`, `eligible_source_count`, `fetched_source_ids`, `excluded_source_ids`, `sources_checked`, `items_fetched`, `items_rejected`, `candidates_created`, `duplicates_skipped`, and `clusters`.

## Process, review, and sync

```sh
npm run job:submit -- process_candidate --candidate-id <candidate-id>
npm run job:get -- <job-id>
```

Only a candidate that reaches local `ready_for_review` can be synced:

```sh
npm run job:submit -- sync_candidate --candidate-id <candidate-id>
```

`sync_candidate` uses the existing Supabase importer and does not publish. A `research_blocked` or `verification_failed` candidate must not be force-synced as a review package. Review and approval remain in the existing Newsroom workflow.

## Cancellation, restart, and recovery

```sh
npm run job:cancel -- <job-id>
npm run launchd -- restart
npm run launchd -- status
npm run launchd -- install
npm run launchd -- stop
npm run launchd -- uninstall
```

Do not run `npm start` while the LaunchAgent is loaded. Before the first
LaunchAgent installation, verify that no manually started controller owns the
health port:

```sh
lsof -nP -iTCP:4317 -sTCP:LISTEN
```

The July 28 installation encountered `EADDRINUSE` because an earlier
controller process still owned port 4317 when launchd first started the
service. Once installed, use `npm run launchd -- restart`; it replaces the
single registered process instead of starting a second controller.

Cancellation is cooperative for a running pipeline stage. After a crash/restart, wait for the 120-second lease to expire or use the controller’s normal expired-lease recovery; inspect the job event trail before manually retrying. Do not delete local state or artifacts to clear a stuck job.

The current verified pipeline command only marks a local run as retry-requested:

```sh
npm run job:submit -- retry_run --run-id <pipeline-run-uuid>
```

Use it only after inspecting the retained artifacts and the queue event trail.

## Model and resource policy

```sh
ollama ps
```

Only one local-heavy job may hold the `heavy_model` lock. The controller requires at least 3 GB available memory for the validated A3B model and unloads `qwen3.6:35b-a3b-nvfp4` after two idle minutes using Ollama `keep_alive: 0`. To force an unload during maintenance, stop or cancel active heavy work first, then run:

```sh
curl -fsS http://127.0.0.1:11434/api/generate \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3.6:35b-a3b-nvfp4","keep_alive":0}'
ollama ps
```

This unloads the model only. It must not be used to stop Ollama, Hermes, MLX, or another user workload.

## Troubleshooting

- `SOURCE_REGISTRY_UNAVAILABLE` or `SOURCE_REGISTRY_EMPTY`: verify the controller service credential and inspect the current Source Graph state; do not fall back to or activate local sources in production.
- `PIPELINE_STATE_NOT_CONFIGURED`: expected when Supabase credentials are absent; use an explicit, reviewed Web3-only `ANYWAYS_PIPELINE_SOURCES_FILE` fixture only for isolated local development.
- `SOURCE_FETCH_FAILED` or `research_blocked`: preserve the retained artifact/run evidence; source accessibility or extraction needs review.
- `MODEL_UNAVAILABLE`: verify local Ollama and `qwen3.6:35b-a3b-nvfp4`; do not install a model from the controller.
- `RESOURCE_BUSY` or `MEMORY_PRESSURE`: wait for the other heavy workload. Do not terminate it automatically.
- `failed` jobs: read the queue event trail and local `~/Library/Logs/AnywaysController/job-<id>.log`; retry only after the recorded cause is addressed.
# Queue ordering

The Supabase queue is authoritative. Editors can reorder only `queued` jobs in the Newsroom Pipeline page. `Move to next` assigns urgent rank; priority ranks are urgent `300`, high `200`, normal `100`, and low `0`. The controller claims eligible work atomically by `priority_rank DESC`, `queue_position ASC`, then `created_at ASC`. Claimed, running, completed, failed, and cancelled jobs cannot be reordered. Reordering never interrupts the current job.
