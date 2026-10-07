import assert from 'node:assert/strict'; import test from 'node:test'; import { validateJob } from '../src/jobs/types.js'; import { redact } from '../src/logger.js';
import { jobArguments, pipelineTimeoutMs, runPipeline } from '../src/pipeline/runner.js';
import { canClaimNextJob } from '../src/queue/client.js';
import { canRunPipelineV1, resourceClassForJob, resourceLockName, RESOURCE_CLASSES } from '../src/resources/classes.js';
import { parseMemorySnapshot } from '../src/resources/memory.js';
import { canonicalXStatusUrl, dedupeXPosts, normalizeXPost, normalizeXHandle, shouldIngestXPost } from '../src/x-browser/extractor.js';
import { normalChromeProfileArgs, xBrowserConfig, XBrowserError } from '../src/x-browser/browser.js';
import {
  clearResolvedJobFailure,
  healthPayload,
  recordJobFailure,
  recordQueueFailure,
  recordQueueSuccess,
  startHealthServer,
  type HealthState
} from '../src/health.js';
import type { AddressInfo } from 'node:net';

function healthyState(): HealthState {
  return {
    controllerId: 'test-controller',
    startedAt: 0,
    queue: true,
    ollama: true,
    model: true,
    currentJobId: null,
    lastCompletedJobId: null,
    lastError: null,
    lastRecordedError: null,
    errorSource: null,
    codexVersion: 'codex-cli 0.147.0'
  };
}

const closeServer = (server: import('node:http').Server) => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
});
test('accepts only verified job payloads', () => { assert.doesNotThrow(() => validateJob('discover', {})); assert.doesNotThrow(() => validateJob('discover', { focus_id: 'technology' })); assert.doesNotThrow(() => validateJob('run_editorial_batch', { batch_run_id: '73457200-fd06-483c-9ccc-ab71dc037601', focus_id: 'technology' })); assert.throws(() => validateJob('run_editorial_batch', {}), /INVALID_PARAMETERS/); assert.throws(() => validateJob('run_editorial_batch', { batch_run_id: '73457200-fd06-483c-9ccc-ab71dc037601', focus_id: 'not a focus' }), /INVALID_PARAMETERS/); assert.throws(() => validateJob('regenerate_draft', {}), /INVALID_PARAMETERS/); assert.throws(() => validateJob('process_candidate', {}), /INVALID_PARAMETERS/); });
test('scores editorial events through the bounded local-heavy job path', () => {
  const target = '73457200-fd06-483c-9ccc-ab71dc037601';
  const job = { id: 'score-job', job_type: 'score_editorial_events', parameters: { model: 'qwen3:8b', batch_size: 3, minimum_score: 4, prompt_version: 'discipline_direct_v1', target_event_id: target }, attempt_count: 0, max_attempts: 3, cancellation_requested_at: null, pipeline_candidate_id: null } as any;
  assert.doesNotThrow(() => validateJob(job.job_type, job.parameters));
  assert.throws(() => validateJob(job.job_type, { batch_size: 6 }), /INVALID_PARAMETERS/);
  assert.equal(resourceClassForJob(job, {}), RESOURCE_CLASSES.localHeavyModel);
  const args = jobArguments(job);
  assert.equal(args?.[0], 'score_editorial_events');
  assert.deepEqual(JSON.parse(Buffer.from(args?.[2] || '', 'base64url').toString('utf8')), { job_id: 'score-job', model: 'qwen3:8b', batch_size: 3, minimum_score: 4, prompt_version: 'discipline_direct_v1', target_event_id: target });
});
test('parses macOS memory, pressure, and swap telemetry without confusing total RAM for free percent', () => {
  const snapshot = parseMemorySnapshot(
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 200.\nPages speculative: 5.\nPages purgeable: 10.\n',
    '34359738368\ntotal = 3072.00M used = 1024.00M free = 2048.00M (encrypted)\n83\n'
  );
  assert.equal(snapshot.totalGb, 32);
  assert.equal(snapshot.freePercent, 83);
  assert.equal(snapshot.pressurePercent, 17);
  assert.equal(snapshot.swapUsedGb, 1);
  assert.equal(snapshot.swapFreeGb, 2);
  assert.equal(snapshot.availableGb, 315 * 16384 / 1024 ** 3);
});
test('routes targeted Luna editorial work through the cloud Codex adapter without recurring enablement', () => {
  const job = { id: 'luna-job', job_type: 'luna_editorial_candidate', parameters: { candidate_id: '73457200-fd06-483c-9ccc-ab71dc037601', model: 'gpt-5.6-luna', reasoning: 'high', minimum_score: 4, prompt_version: 'luna-editorial-v1' }, attempt_count: 0, max_attempts: 2, cancellation_requested_at: null, pipeline_candidate_id: null } as any;
  assert.doesNotThrow(() => validateJob(job.job_type, job.parameters));
  assert.equal(resourceClassForJob(job, {}), RESOURCE_CLASSES.cloudCodexGeneration);
  assert.equal(pipelineTimeoutMs({ phase2JobTimeoutMs: 2_400_000, jobTimeoutMs: 900_000 } as any, job), 2_400_000);
  const args = jobArguments(job);
  assert.equal(args?.[0], 'luna_editorial_candidate');
  assert.deepEqual(JSON.parse(Buffer.from(args?.[2] || '', 'base64url').toString('utf8')), { job_id: 'luna-job', candidate_id: job.parameters.candidate_id, model: 'gpt-5.6-luna', reasoning: 'high', minimum_score: 4, prompt_version: 'luna-editorial-v1' });
});
test('routes targeted Luna evidence enrichment with bounded fetch settings and actor lineage', () => {
  const job = { id: 'enrichment-job', job_type: 'luna_evidence_enrichment', parameters: { candidate_id: '73457200-fd06-483c-9ccc-ab71dc037601', max_attempts: 1, max_urls_per_attempt: 3, max_bytes_per_page: 524288, timeout_ms: 8000, cooldown_minutes: 60, prompt_version: 'luna-evidence-enrichment-v1' }, requested_by: '123e4567-e89b-12d3-a456-426614174000', attempt_count: 0, max_attempts: 1, cancellation_requested_at: null, pipeline_candidate_id: null } as any;
  assert.doesNotThrow(() => validateJob(job.job_type, job.parameters));
  const args = jobArguments(job);
  assert.equal(args?.[0], 'luna_evidence_enrichment');
  assert.deepEqual(JSON.parse(Buffer.from(args?.[2] || '', 'base64url').toString('utf8')), { job_id: 'enrichment-job', candidate_id: job.parameters.candidate_id, max_attempts: 1, max_urls_per_attempt: 3, max_bytes_per_page: 524288, timeout_ms: 8000, cooldown_minutes: 60, automatic_retry: true, prompt_version: 'luna-evidence-enrichment-v1', requested_by: job.requested_by });
});
test('normalizes X posts into stable source-event identities and preserves editorial context', () => {
  assert.equal(normalizeXHandle(' @Example_Account '), '@example_account');
  assert.equal(canonicalXStatusUrl('@Example_Account', '123456789'), 'https://x.com/example_account/status/123456789');
  const post = normalizeXPost({
    status_links: ['https://x.com/Example_Account/status/123456789'],
    account_handle: '@Example_Account', display_name: 'Example Account',
    text: 'A useful post with https://official.example/report', published_at: '2026-08-07T12:00:00Z',
    referenced_urls: ['https://official.example/report'], media: [{ url: 'https://pbs.twimg.com/media/image.jpg', type: 'image', width: 1200, height: 800 }],
    engagement: { like: '1.2K', reply: '20' }, selectors: ['tweetText'], social_context: ''
  }, { priority: 8 });
  assert.ok(post);
  assert.equal(post?.external_id, '123456789');
  assert.equal(post?.canonical_url, 'https://x.com/example_account/status/123456789');
  assert.equal(post?.media[0].attribution, '@example_account / X');
  assert.equal(post?.engagement.like, 1200);
  assert.equal(shouldIngestXPost(post!), true);
  assert.equal(dedupeXPosts([post!, post!]).length, 1);
  const shortReply = normalizeXPost({ status_links: ['https://x.com/example/status/123456790'], account_handle: '@example', text: 'same', parent_url: 'https://x.com/a/status/1', social_context: 'Replying to @a' }, { priority: 5 });
  assert.equal(shouldIngestXPost(shortReply!, { priority: 5 }), false);
  const priorityReply = normalizeXPost({ status_links: ['https://x.com/example/status/123456791'], account_handle: '@example', text: 'same', parent_url: 'https://x.com/a/status/1', social_context: 'Replying to @a' }, { priority: 9 });
  assert.equal(shouldIngestXPost(priorityReply!, { priority: 9 }), true);
});
test('routes X browser ingestion through deterministic work with bounded parameters', () => {
  const job = { id: 'x-job', job_type: 'x_browser_ingestion', parameters: { max_accounts_per_run: 2, max_posts_per_account: 20 }, attempt_count: 0, max_attempts: 1, cancellation_requested_at: null, pipeline_candidate_id: null } as any;
  assert.doesNotThrow(() => validateJob(job.job_type, job.parameters));
  assert.equal(resourceClassForJob(job, {}), RESOURCE_CLASSES.deterministicWork);
  assert.deepEqual(jobArguments(job), ['x_browser_ingestion']);
  assert.throws(() => validateJob(job.job_type, { max_accounts_per_run: 11 }), /INVALID_PARAMETERS/);
});
test('X browser uses a dedicated normal Chrome profile and loopback CDP', () => {
  const names = ['X_BROWSER_SESSION_MODE', 'X_BROWSER_CDP_URL', 'X_BROWSER_USER_DATA_DIR', 'X_BROWSER_PROFILE_NAME', 'X_BROWSER_PROFILE_DIRECTORY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.X_BROWSER_SESSION_MODE = 'cdp';
    process.env.X_BROWSER_CDP_URL = 'http://127.0.0.1:9222';
    process.env.X_BROWSER_USER_DATA_DIR = '/Users/test/Library/Application Support/Anyways X Chrome';
    process.env.X_BROWSER_PROFILE_NAME = 'Anyways X';
    process.env.X_BROWSER_PROFILE_DIRECTORY = 'Default';
    const config = xBrowserConfig({ anywaysRepoPath: '/tmp/anyways' } as any);
    assert.equal(config.sessionMode, 'cdp');
    assert.equal(config.cdpUrl, 'http://127.0.0.1:9222');
    assert.equal(config.profileName, 'Anyways X');
    assert.equal(config.profileDirectory, 'Default');
    assert.deepEqual(normalChromeProfileArgs(config, true), [
      '--user-data-dir=/Users/test/Library/Application Support/Anyways X Chrome',
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9222'
    ]);
    process.env.X_BROWSER_USER_DATA_DIR = `${process.env.HOME}/Library/Application Support/Google/Chrome`;
    assert.throws(() => normalChromeProfileArgs(xBrowserConfig({ anywaysRepoPath: '/tmp/anyways' } as any), true), /dedicated non-default/);
    process.env.X_BROWSER_CDP_URL = 'https://example.test:9222';
    assert.throws(() => xBrowserConfig({ anywaysRepoPath: '/tmp/anyways' } as any), (error: unknown) => error instanceof XBrowserError && error.code === 'X_BROWSER_CDP_UNAVAILABLE');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
test('accepts pipeline candidate hashes and requires UUID run identifiers', () => { assert.doesNotThrow(() => validateJob('process_candidate', { candidate_id: 'a'.repeat(64) })); assert.throws(() => validateJob('retry_run', { run_id: 'bad' }), /INVALID_PARAMETERS/); });
test('routes only the explicitly enabled commissioned path to the cloud Codex resource', () => {
  const job = { id: 'job-1', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1' } };
  assert.equal(resourceClassForJob(job, {}), RESOURCE_CLASSES.localHeavyModel);
  assert.equal(resourceLockName(RESOURCE_CLASSES.cloudCodexGeneration), 'heavy_model');
  assert.equal(resourceClassForJob({ job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64) } }, {}), RESOURCE_CLASSES.localHeavyModel);
  assert.equal(resourceClassForJob({ job_type: 'discover', parameters: {} }, {}), RESOURCE_CLASSES.deterministicWork);
  assert.equal(resourceClassForJob(job, { PIPELINE_V1_ENABLED: 'true' }), RESOURCE_CLASSES.cloudCodexGeneration);
  assert.equal(canRunPipelineV1(job, { PIPELINE_V1_ALLOWED_JOB_ID: 'job-1' }), true);
  assert.equal(resourceClassForJob(job, { PIPELINE_V1_ALLOWED_JOB_ID: 'job-1' }), RESOURCE_CLASSES.cloudCodexGeneration);
  assert.equal(canRunPipelineV1({ ...job, id: 'job-2' }, { PIPELINE_V1_ALLOWED_JOB_ID: 'job-1' }), false);
  assert.equal(resourceClassForJob({ ...job, id: 'job-2' }, { PIPELINE_V1_ALLOWED_JOB_ID: 'job-1' }), RESOURCE_CLASSES.localHeavyModel);
  assert.equal(resourceClassForJob({ job_type: 'run_editorial_batch', parameters: { batch_run_id: '73457200-fd06-483c-9ccc-ab71dc037601' } }, {}), RESOURCE_CLASSES.localHeavyModel);
  assert.equal(resourceClassForJob({ job_type: 'run_editorial_batch', parameters: { batch_run_id: '73457200-fd06-483c-9ccc-ab71dc037601', pipeline_version: 'v1' } }, { PIPELINE_V1_ENABLED: 'true' }), RESOURCE_CLASSES.cloudCodexGeneration);
});
test('accepts a structured newsroom article commission and rejects missing evidence', () => {
  const request = { brief: 'Explain how independent newsletters are changing local media economics.', section_id: 'media', story_form: 'receipts', beats: ['brands'], tags: ['newsletters'], source_urls: ['https://example.com/report'], notes: 'Follow the money.' };
  assert.doesNotThrow(() => validateJob('commission_article', request));
  assert.doesNotThrow(() => validateJob('commission_article', (({ story_form, ...legacy }) => legacy)(request)));
  assert.throws(() => validateJob('commission_article', { ...request, source_urls: [] }), /INVALID_PARAMETERS/);
  assert.doesNotThrow(() => validateJob('create_editorial_pitch', request));
  const args = jobArguments({ id: 'job', job_type: 'commission_article', parameters: request, attempt_count: 0, max_attempts: 3, cancellation_requested_at: null, pipeline_candidate_id: null });
  assert.equal(args?.[0], 'commission_article');
  const pitchArgs = jobArguments({ id: 'job', job_type: 'create_editorial_pitch', parameters: request, attempt_count: 0, max_attempts: 3, cancellation_requested_at: null, pipeline_candidate_id: null });
  assert.equal(pitchArgs?.[0], 'create_editorial_pitch');
  const ideaJob = { id: 'idea-job', job_type: 'generate_idea_pitches', parameters: { idea_id: '73457200-fd06-483c-9ccc-ab71dc037601' }, attempt_count: 0, max_attempts: 2, cancellation_requested_at: null, pipeline_candidate_id: null } as any;
  assert.doesNotThrow(() => validateJob(ideaJob.job_type, ideaJob.parameters));
  assert.deepEqual(jobArguments(ideaJob), ['generate_idea_pitches', '--idea-id', '73457200-fd06-483c-9ccc-ab71dc037601', '--job-id', 'idea-job']);
  assert.deepEqual(jobArguments({ id: 'job', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1' }, attempt_count: 0, max_attempts: 3, cancellation_requested_at: null, pipeline_candidate_id: null }), ['process_candidate', '--candidate-id', 'a'.repeat(64), '--pipeline-version', 'v1', '--job-id', 'job']);
  assert.deepEqual(jobArguments({ id: 'job-2', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1', authorization: 'research_again' }, attempt_count: 0, max_attempts: 1, cancellation_requested_at: null, pipeline_candidate_id: null }), ['process_candidate', '--candidate-id', 'a'.repeat(64), '--pipeline-version', 'v1', '--action', 'research_again', '--job-id', 'job-2']);
  const writerJob = { id: 'job-writer', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1', writer: 'sol-medium', length: 'feature', writer_model: 'gpt-5.6-sol', writer_reasoning: 'medium' }, attempt_count: 0, max_attempts: 1, cancellation_requested_at: null, pipeline_candidate_id: null } as any;
  assert.doesNotThrow(() => validateJob(writerJob.job_type, writerJob.parameters));
  assert.deepEqual(jobArguments(writerJob), ['process_candidate', '--candidate-id', 'a'.repeat(64), '--pipeline-version', 'v1', '--writer', 'sol-medium', '--length', 'feature', '--writer-model', 'gpt-5.6-sol', '--writer-reasoning', 'medium', '--job-id', 'job-writer']);
  const replayJob = { id: 'job-replay', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1', authorization: 'replay_from_stage', replay_from_stage: 'writer', parent_run_id: '73457200-fd06-483c-9ccc-ab71dc037601', replay_attempt_id: '73457200-fd06-483c-9ccc-ab71dc037602', writer: 'sol-low', length: 'standard' }, attempt_count: 0, max_attempts: 1, cancellation_requested_at: null, pipeline_candidate_id: null } as any;
  assert.doesNotThrow(() => validateJob(replayJob.job_type, replayJob.parameters));
  assert.deepEqual(jobArguments(replayJob), ['process_candidate', '--candidate-id', 'a'.repeat(64), '--pipeline-version', 'v1', '--writer', 'sol-low', '--length', 'standard', '--action', 'replay_from_stage', '--replay-from-stage', 'writer', '--parent-run-id', '73457200-fd06-483c-9ccc-ab71dc037601', '--replay-attempt-id', '73457200-fd06-483c-9ccc-ab71dc037602', '--job-id', 'job-replay']);
  assert.throws(() => validateJob('process_candidate', { ...writerJob.parameters, writer_reasoning: 'high' }), /INVALID_PARAMETERS/);
  assert.deepEqual(jobArguments({ id: 'job-3', job_type: 'polish_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1', authorization: 'polish_with_sol' }, attempt_count: 0, max_attempts: 1, cancellation_requested_at: null, pipeline_candidate_id: null }), ['polish_candidate', '--candidate-id', 'a'.repeat(64), '--pipeline-version', 'v1', '--job-id', 'job-3']);
  assert.deepEqual(JSON.parse(Buffer.from(args?.[2] || '', 'base64url').toString('utf8')), request);
  assert.deepEqual(jobArguments({ id: 'job', job_type: 'run_editorial_batch', parameters: { batch_run_id: '73457200-fd06-483c-9ccc-ab71dc037601' }, attempt_count: 0, max_attempts: 2, cancellation_requested_at: null, pipeline_candidate_id: null }), ['run_editorial_batch', '--batch-id', '73457200-fd06-483c-9ccc-ab71dc037601']);
  assert.deepEqual(jobArguments({ id: 'job-focus', job_type: 'run_editorial_batch', parameters: { batch_run_id: '73457200-fd06-483c-9ccc-ab71dc037601', focus_id: 'technology' }, attempt_count: 0, max_attempts: 2, cancellation_requested_at: null, pipeline_candidate_id: null }), ['run_editorial_batch', '--batch-id', '73457200-fd06-483c-9ccc-ab71dc037601', '--focus-id', 'technology']);
});
test('redacts credential-shaped log fragments', () => { assert.match(redact('SUPABASE_SERVICE_ROLE_KEY=super-secret'), /REDACTED/); });

test('queue failure causes degraded health', () => {
  const state = healthyState();
  recordQueueFailure(state, new Error('transient queue failure'));
  const payload = healthPayload(state, 1000);
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.queue_connectivity, false);
  assert.equal(payload.last_error, 'transient queue failure');
});

test('health exposes the detected Codex CLI version', () => {
  const payload = healthPayload(healthyState(), 1000);
  assert.equal(payload.codex_version, 'codex-cli 0.147.0');
});

test('successful queue polling clears a transient queue error and restores ok health', () => {
  const state = healthyState();
  recordQueueFailure(state, new Error('transient queue failure'));
  recordQueueSuccess(state);
  const payload = healthPayload(state, 1000);
  assert.equal(payload.status, 'ok');
  assert.equal(payload.last_error, null);
  assert.equal(payload.last_recorded_error, 'transient queue failure');
});

test('queue success does not hide a current active-job error', () => {
  const state = healthyState();
  state.currentJobId = 'active-job';
  recordJobFailure(state, new Error('active job failure'));
  recordQueueSuccess(state);
  assert.equal(healthPayload(state, 1000).status, 'degraded');
  assert.equal(healthPayload(state, 1000).last_error, 'active job failure');
  state.currentJobId = null;
  clearResolvedJobFailure(state);
  assert.equal(healthPayload(state, 1000).status, 'ok');
  assert.equal(healthPayload(state, 1000).last_recorded_error, 'active job failure');
});

test('current queue failures remain visible until a successful poll', () => {
  const state = healthyState();
  recordQueueFailure(state, new Error('first queue failure'));
  recordQueueFailure(state, new Error('current queue failure'));
  assert.equal(healthPayload(state, 1000).last_error, 'current queue failure');
  assert.equal(healthPayload(state, 1000).status, 'degraded');
});

test('health startup rejects a duplicate listener without replacing the live server', async t => {
  const first = await startHealthServer('127.0.0.1', 0, healthyState());
  t.after(() => first.listening ? closeServer(first) : undefined);
  const port = (first.address() as AddressInfo).port;
  await assert.rejects(
    () => startHealthServer('127.0.0.1', port, healthyState()),
    (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE'
  );
  assert.equal(first.listening, true);
});

test('health server can restart cleanly on the same port after shutdown', async () => {
  const first = await startHealthServer('127.0.0.1', 0, healthyState());
  const port = (first.address() as AddressInfo).port;
  await closeServer(first);
  const replacement = await startHealthServer('127.0.0.1', port, healthyState());
  assert.equal(replacement.listening, true);
  assert.equal((replacement.address() as AddressInfo).port, port);
  await closeServer(replacement);
});

test('V1 timeout and one-attempt behavior remain explicit', () => {
  const config = { phase2JobTimeoutMs: 2_400_000, jobTimeoutMs: 900_000 } as any;
  const job = { id: 'job', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1' }, max_attempts: 1 } as any;
  assert.equal(pipelineTimeoutMs(config, job), 2_400_000);
  assert.equal(job.max_attempts, 1);
});

test('provider readiness prevents claiming a V1 job while legacy jobs remain claimable', () => {
  const v1 = { id: 'v1-job', parameters: { pipeline_version: 'v1' } } as any;
  const legacy = { id: 'legacy-job', parameters: {} } as any;
  assert.equal(canClaimNextJob(v1, false), false);
  assert.equal(canClaimNextJob(v1, true), true);
  assert.equal(canClaimNextJob(legacy, false), true);
});

test('runner abort terminates an in-flight child without a second spawn', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-controller-runner-'));
  await fs.mkdir(path.join(repo, 'bin'));
  await fs.writeFile(path.join(repo, 'bin', 'anyways-pipeline-command.mjs'), 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const job = { id: 'job', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1' }, attempt_count: 1, max_attempts: 1, cancellation_requested_at: null, pipeline_candidate_id: null } as any;
  const promise = runPipeline({ ...({ phase2JobTimeoutMs: 30_000, jobTimeoutMs: 30_000 } as any), anywaysRepoPath: repo, childKillGraceMs: 50, heartbeatMs: 20 }, job, async () => {}, async () => false, controller.signal);
  setTimeout(() => controller.abort(), 20);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.match(result.error?.code || '', /PIPELINE_/);
  await fs.rm(repo, { recursive: true, force: true });
});

test('LaunchAgent restart drains the old instance before bootstrapping the replacement', async () => {
  const fs = await import('node:fs/promises');
  const script = await fs.readFile(new URL('../scripts/launchd.sh', import.meta.url), 'utf8');
  assert.match(script, /launchctl bootout/);
  assert.match(script, /wait_for_exit/);
  assert.match(script, /wait_for_listener_exit/);
  assert.match(script, /wait_for_started_listener/);
  assert.doesNotMatch(script, /kickstart -k/);
  assert.match(script, /unexpected process/);
});

test('controller lifecycle logs initialization, polling, interruption, and drain events', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  for (const event of ['Listener acquired.', 'Controller initialized.', 'Queue polling started.', 'Job interruption requested.', 'Job drain completed.']) assert.match(source, new RegExp(event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(source, /terminalizeInterruptedCandidate/);
  assert.match(source, /reconcileExpiredV1Jobs/);
});
