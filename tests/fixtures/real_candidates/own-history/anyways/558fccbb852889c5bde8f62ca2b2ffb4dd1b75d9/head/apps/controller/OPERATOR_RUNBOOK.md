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

Source registration is local at `/Volumes/External/GitHub/IGNORED/anyways/pipeline-state/sources.json`. It must be an array of validated source objects with canonical `default_section` and `default_recurring_beats`. It is not a publishing taxonomy and does not override the pipeline classifier.

Start from `pipeline-state/sources.example.json`. To add a source, append one object with an `id`, `name`, supported `type`, HTTPS `url`, `enabled`, integer `priority`, controlled default section/beats, tags, polling interval, and optional `credential_env`. To disable it without deleting history, set `enabled` to `false`, then validate. Never put credential values in the file; name an environment variable instead.

```sh
cd /Volumes/External/GitHub/IGNORED/anyways
node --input-type=module -e "import('./src/pipeline/source-config.mjs').then(({loadSourceConfig}) => loadSourceConfig('pipeline-state/sources.json')).then(() => console.log('valid'))"
cd /Volumes/External/GitHub/IGNORED/anyways/apps/controller
npm run job:submit -- discover
```

Inspect the completed job for `sources_checked`, `items_fetched`, `items_rejected`, `candidates_created`, `duplicates_skipped`, and `clusters`.

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

Only one `process_candidate` job may hold the `heavy_model` lock. The controller requires at least 8 GB available memory and unloads `qwen3:14b` after ten idle minutes using Ollama `keep_alive: 0`. To force an unload during maintenance, stop or cancel active heavy work first, then run:

```sh
curl -fsS http://127.0.0.1:11434/api/generate \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3:14b","keep_alive":0}'
ollama ps
```

This unloads the model only. It must not be used to stop Ollama, Hermes, MLX, or another user workload.

## Troubleshooting

- `PIPELINE_STATE_NOT_CONFIGURED`: restore a valid local `sources.json` from the example and validate it.
- `SOURCE_FETCH_FAILED` or `research_blocked`: preserve the retained artifact/run evidence; source accessibility or extraction needs review.
- `MODEL_UNAVAILABLE`: verify local Ollama and `qwen3:14b`; do not install a model from the controller.
- `RESOURCE_BUSY` or `MEMORY_PRESSURE`: wait for the other heavy workload. Do not terminate it automatically.
- `failed` jobs: read the queue event trail and local `~/Library/Logs/AnywaysController/job-<id>.log`; retry only after the recorded cause is addressed.
# Queue ordering

The Supabase queue is authoritative. Editors can reorder only `queued` jobs in the Newsroom Pipeline page. `Move to next` assigns urgent rank; priority ranks are urgent `300`, high `200`, normal `100`, and low `0`. The controller claims eligible work atomically by `priority_rank DESC`, `queue_position ASC`, then `created_at ASC`. Claimed, running, completed, failed, and cancelled jobs cannot be reordered. Reordering never interrupts the current job.
