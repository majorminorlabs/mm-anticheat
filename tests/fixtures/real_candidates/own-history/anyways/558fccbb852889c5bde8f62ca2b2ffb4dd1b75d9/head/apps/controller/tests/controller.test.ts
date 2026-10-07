import assert from 'node:assert/strict'; import test from 'node:test'; import { validateJob } from '../src/jobs/types.js'; import { redact } from '../src/logger.js';
import { jobArguments, pipelineTimeoutMs, runPipeline } from '../src/pipeline/runner.js';
import { canClaimNextJob } from '../src/queue/client.js';
import { canRunPipelineV1, resourceClassForJob, resourceLockName, RESOURCE_CLASSES } from '../src/resources/classes.js';
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
    errorSource: null
  };
}

const closeServer = (server: import('node:http').Server) => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
});
test('accepts only verified job payloads', () => { assert.doesNotThrow(() => validateJob('discover', {})); assert.doesNotThrow(() => validateJob('run_editorial_batch', { batch_run_id: '73457200-fd06-483c-9ccc-ab71dc037601' })); assert.throws(() => validateJob('run_editorial_batch', {}), /INVALID_PARAMETERS/); assert.throws(() => validateJob('regenerate_draft', {}), /INVALID_PARAMETERS/); assert.throws(() => validateJob('process_candidate', {}), /INVALID_PARAMETERS/); });
test('accepts pipeline candidate hashes and requires UUID run identifiers', () => { assert.doesNotThrow(() => validateJob('process_candidate', { candidate_id: 'a'.repeat(64) })); assert.throws(() => validateJob('retry_run', { run_id: 'bad' }), /INVALID_PARAMETERS/); });
test('routes only the explicitly enabled commissioned path to the cloud Codex resource', () => {
  const job = { id: 'job-1', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1' } };
  assert.equal(resourceClassForJob(job, {}), RESOURCE_CLASSES.localHeavyModel);
  assert.equal(resourceLockName(RESOURCE_CLASSES.cloudCodexGeneration), 'cloud_codex_generation');
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
  assert.deepEqual(jobArguments({ id: 'job', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1' }, attempt_count: 0, max_attempts: 3, cancellation_requested_at: null, pipeline_candidate_id: null }), ['process_candidate', '--candidate-id', 'a'.repeat(64), '--pipeline-version', 'v1', '--job-id', 'job']);
  assert.deepEqual(jobArguments({ id: 'job-2', job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1', authorization: 'research_again' }, attempt_count: 0, max_attempts: 1, cancellation_requested_at: null, pipeline_candidate_id: null }), ['process_candidate', '--candidate-id', 'a'.repeat(64), '--pipeline-version', 'v1', '--action', 'research_again', '--job-id', 'job-2']);
  assert.deepEqual(jobArguments({ id: 'job-3', job_type: 'polish_candidate', parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1', authorization: 'polish_with_sol' }, attempt_count: 0, max_attempts: 1, cancellation_requested_at: null, pipeline_candidate_id: null }), ['polish_candidate', '--candidate-id', 'a'.repeat(64), '--pipeline-version', 'v1', '--job-id', 'job-3']);
  assert.deepEqual(JSON.parse(Buffer.from(args?.[2] || '', 'base64url').toString('utf8')), request);
  assert.deepEqual(jobArguments({ id: 'job', job_type: 'run_editorial_batch', parameters: { batch_run_id: '73457200-fd06-483c-9ccc-ab71dc037601' }, attempt_count: 0, max_attempts: 2, cancellation_requested_at: null, pipeline_candidate_id: null }), ['run_editorial_batch']);
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
