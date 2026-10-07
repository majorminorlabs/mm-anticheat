# Anyways Controller

The Anyways Controller is a local Node 22 service for the Mac Studio. It polls the Supabase-backed `pipeline_jobs` queue, claims a lease atomically, runs a fixed existing Anyways pipeline command, writes redacted local logs, reports status/results, retries only retryable infrastructure failures, and releases its model lock. It does not contain editorial prompts, publish stories, change the vault, or expose a public endpoint.

## Supported jobs

| Job type | Existing command | Parameters | Retry safety |
| --- | --- | --- | --- |
| `commission_article` | `node bin/anyways-ops.mjs commission <encoded-request>` | Editor brief, fixed section, beats, tags, source URLs, and notes | Deterministic request fingerprint prevents duplicate local candidates; the result still stops at editorial review. |
| `discover` | `node bin/anyways-ops.mjs discover` | none | Safe to retry; it deduplicates URLs in local state. |
| `process_candidate` | `node bin/anyways-ops.mjs process <candidate-id>` | Existing candidate UUID or 64-character SHA-256 ID | Resumes a ready-for-review candidate; otherwise reruns retained stages where available. |
| `retry_run` | `node bin/anyways-ops.mjs retry <run-id>` | UUID `run_id` | Only marks an existing local run for retry. |
| `sync_candidate` | `node bin/pipeline-sync-supabase.mjs <candidate-id>` | Existing candidate UUID or 64-character SHA-256 ID | Idempotent sync of a retained ready-for-review candidate. |
| `health_check` | controller-native | none | No pipeline/model work. |

`regenerate_draft` is intentionally absent: no verified existing command supports it. The controller invokes `bin/anyways-pipeline-command.mjs`, a fixed adapter that emits one final JSON result line and never accepts arbitrary shell commands. Article commissions are validated structured data, not executable prompt strings.

## Install and configure

```sh
cd /Volumes/External/GitHub/IGNORED/anyways/apps/controller
npm install
cp .env.example .env
chmod 600 .env
npm run build
```

Set `SUPABASE_URL` and a dedicated `SUPABASE_SERVICE_ROLE_KEY` in `.env`. Do not place either in the Anyways browser app or commit `.env`. `ANYWAYS_REPO_PATH` must point to the parent Anyways checkout. The deployed artifact is `apps/controller/dist/src/index.js`. Apply the additive queue migration in the Anyways repository before starting:

```sh
cd /Volumes/External/GitHub/IGNORED/anyways
supabase db push --linked
```

Production discovery reads the eligible Web3 Source Graph through the controller service credential. `pipeline-state/sources.json` is only the credential-free local-development fallback; it is intentionally ignored because it can contain local source credentials through `credential_env`. Validate it without sending a job only when using that fallback:

```sh
cd /Volumes/External/GitHub/IGNORED/anyways
node --input-type=module -e "import('./src/pipeline/source-config.mjs').then(({loadSourceConfig}) => loadSourceConfig('pipeline-state/sources.json')).then(() => console.log('valid'))"
```

## Start, health, and logs

```sh
npm start
curl http://127.0.0.1:4317/health
```

Logs live in `~/Library/Logs/AnywaysController/`: `controller.log`, a per-job `job-<uuid>.log`, and LaunchAgent stdout/stderr logs. Supabase receives only a 12 KB summary and structured result/error, while detailed logs remain local.

The controller checks Ollama at `OLLAMA_BASE_URL`, confirms `OLLAMA_MODEL`, and keeps Ollama loopback-only. It uses `POST /api/generate` with `keep_alive: 0` after the final heavy job has been idle for two minutes, while protecting the timer from unloading a model during a newly started job. It never stops the Ollama server and never starts a second heavy job. At or below the configured `MINIMUM_AVAILABLE_MEMORY_GB` threshold, a managed job is recorded as `resource_deferred` and returned to the queue without consuming a retry. Health reports available memory, pressure, swap, loaded Ollama models, and resource deferrals.

## X Browser normal Chrome profile

X Browser uses a Chrome-managed profile in its own non-default user-data
directory. Chrome creates and owns this profile normally; Anyways never copies
the profile, exports cookies, logs credentials, or automates sign-in. The
default macOS location is:

`~/Library/Application Support/Anyways X Chrome`, profile directory `Default`,
visible profile name `Anyways X`.

Open the profile normally for the one-time human setup:

```sh
npm run x-browser:open-profile
```

In the Chrome window that opens, use Chrome's normal profile controls to name
the profile `Anyways X` if needed, then sign into X manually. Do not paste
credentials into a terminal or send them to the controller. After login, close
Chrome normally, then reopen the same Chrome-managed profile with loopback CDP:

```sh
npm run x-browser:open-profile -- --debug
```

Finally run the read-only auth check:

```sh
npm run x-browser:check-auth
npm run x-browser:health
```

The check opens `https://x.com/home` in a temporary tab, confirms
authentication and readable timeline DOM, then closes only that tab and the
CDP transport. Chrome remains open. If the profile is locked, stop and close
the profile normally before the `--debug` command. The previous Playwright
login path is disabled.

## Queue CLI

```sh
npm run job:submit -- discover
npm run job:submit -- process_candidate --candidate-id <candidate-id>
npm run job:list
npm run job:get -- <job-id>
npm run job:cancel -- <job-id>
```

The CLI validates types and existing candidate ID formats. It uses the service credential and is intended for the local operator only.

## Recovery, retries, and cancellation

Jobs have 120-second leases and 30-second heartbeats by default. Startup releases expired claims: retryable jobs with attempts remaining return to `queued`; exhausted jobs become `failed`. A cancellation request immediately cancels queued work and terminates a running child at the next check. Retry happens only for result-marked retryable errors or controller infrastructure failures. Invalid parameters, unsupported types, explicit cancellation, and pipeline schema/editorial failures do not retry.

## LaunchAgent

The installer is intentionally manual and reversible:

```sh
npm run build
npm run launchd -- install
npm run launchd -- status
npm run launchd -- restart
npm run launchd -- tail
npm run launchd -- stop
npm run launchd -- uninstall
```

It creates `~/Library/LaunchAgents/com.anyways.controller.plist`, starts at login, restarts after unexpected failure, and throttles rapid crash loops. It does not run automatically during installation of this repository.

## Troubleshooting and security

- `PIPELINE_STATE_NOT_CONFIGURED`: create/configure the existing pipeline state/source registry before submitting discovery or process work.
- `MODEL_UNAVAILABLE`: verify `ollama ps`, `ollama list`, and `qwen3:14b`; controller startup does not install or expose models.
- `RESOURCE_BUSY`, `MEMORY_PRESSURE`, or `RESOURCE_DEFERRED`: wait for the heavy lock or resource capacity. Deferred jobs return to the queue without consuming a retry. The controller never stops MLX, Hermes, or another user process.
- The controller listens only on `127.0.0.1`. Newsroom and Hermes integrations are intentionally not part of this phase. Supabase polling is the remote coordination path.
