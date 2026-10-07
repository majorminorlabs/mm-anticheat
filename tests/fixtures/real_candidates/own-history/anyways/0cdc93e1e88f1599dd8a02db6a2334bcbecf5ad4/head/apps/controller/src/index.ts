import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { readConfig } from './config.js';
import { Logger } from './logger.js';
import { Queue } from './queue/client.js';
import { validateJob, type Job } from './jobs/types.js';
import { ollamaHealth, ollamaProcesses, unloadModel } from './ollama/health.js';
import { memorySnapshot } from './resources/memory.js';
import { runPipeline } from './pipeline/runner.js';
import { resourceClassForJob, resourceLockName, RESOURCE_CLASSES } from './resources/classes.js';
import { clearResolvedJobFailure, recordJobFailure, recordQueueFailure, recordQueueSuccess, startHealthServer, type HealthState } from './health.js';
import { checkCodexReadiness } from './codex-readiness.js';

const config = readConfig();
const logger = new Logger(config.logDirectory);
const queue = new Queue(config);
const state: HealthState = { controllerId: config.controllerId, startedAt: Date.now(), queue: false, ollama: false, model: false, currentJobId: null, lastCompletedJobId: null, lastError: null, lastRecordedError: null, errorSource: null, codexProviderReady: false, codexExecutable: config.codexExecutable, codexVersion: null, codexReadinessError: null, loadedOllamaModels: [], resourceDeferredJobs: 0, lastResourceDeferredJobId: null, lastResourceDeferredAt: null };
let stopping = false;
let stopPromise: Promise<void> | null = null;
let idleTimer: NodeJS.Timeout | undefined;
let loop: NodeJS.Timeout | undefined;
let healthServer: Server | undefined;
let activeResourceLock: { id: string; name: string } | null = null;
let currentExecutionPromise: Promise<void> | null = null;
let currentExecution: { job: Job; interrupt: (reason: { code: string; message: string }) => Promise<void> } | null = null;
let currentTickPromise: Promise<void> | null = null;
let activeModel: string | null = null;
let codexProviderReady = false;
let lastLunaRecurringCheck = 0;
let lastXBrowserCheck = 0;
let lastResourceRefresh = 0;
let lastControllerHeartbeat = 0;

const isV1Job = (job: Job) => ['v1', 'pipeline-v1'].includes(String(job.parameters?.pipeline_version || ''));
const clearIdleTimer = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = undefined; };
const resetIdle = () => { clearIdleTimer(); idleTimer = setTimeout(async () => { if (currentExecution) { resetIdle(); return; } try { if (activeModel) await unloadModel(config, activeModel); activeModel = null; await logger.write('info', 'Ollama model unloaded after idle timeout.'); } catch (error) { await logger.write('warn', `Ollama model unload failed: ${error instanceof Error ? error.message : String(error)}`); } }, config.idleMs); };
async function refreshResourceState(force = false) {
  if (!force && Date.now() - lastResourceRefresh < 30_000) return;
  lastResourceRefresh = Date.now();
  const memory = await memorySnapshot();
  state.memoryTotalGb = memory.totalGb;
  state.memoryAvailableGb = memory.availableGb;
  state.memoryFreePercent = memory.freePercent;
  state.memoryPressurePercent = memory.pressurePercent;
  state.swapTotalGb = memory.swapTotalGb;
  state.swapUsedGb = memory.swapUsedGb;
  state.swapFreeGb = memory.swapFreeGb;
  state.loadedOllamaModels = await ollamaProcesses(config);
}
async function recordControllerHealth(controllerState = 'running') {
  try {
    await queue.recordControllerHealth({
      host: process.env.HOSTNAME || 'Mac Studio',
      pid: process.pid,
      state: controllerState,
      queue_connectivity: state.queue,
      ollama_connectivity: state.ollama,
      model_available: state.model,
      model: config.ollamaModel,
      current_job_id: state.currentJobId,
      last_completed_job_id: state.lastCompletedJobId,
      last_error: state.lastError,
      memory_available_gb: state.memoryAvailableGb,
      memory_pressure_percent: state.memoryPressurePercent,
      swap_used_gb: state.swapUsedGb,
      loaded_ollama_models: state.loadedOllamaModels || [],
      started_at: new Date(state.startedAt).toISOString()
    });
    lastControllerHeartbeat = Date.now();
  } catch (error) {
    await logger.write('warn', `Controller heartbeat could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const cancelled = async (id: string) => { const { data, error } = await queue.db.from('pipeline_jobs').select('cancellation_requested_at').eq('id', id).single(); if (error) return false; return Boolean(data?.cancellation_requested_at); };

async function execute(job: Job) {
  const jobLogger = new Logger(config.logDirectory, job.id);
  state.currentJobId = job.id;
  let lock = false;
  let lockName: string | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  let interrupted: { code: string; message: string } | null = null;
  let ranLocalHeavyModel = false;
  const abortController = new AbortController();
  const interrupt = async (reason: { code: string; message: string }) => {
    if (interrupted) return;
    interrupted = reason;
    await logger.write('warn', 'Job interruption requested.', { job_id: job.id, code: reason.code });
    if (job.job_type === 'generate_pitch') {
      try { await queue.recoverInterruptedGeneratePitch(job, reason); } catch (error) { await logger.write('error', 'Interrupted Qwen pitch could not be requeued.', { job_id: job.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    try { await queue.fail(job.id, { ...reason, retryable: false }, reason.message); } catch (error) { await logger.write('error', 'Interrupted job could not be terminalized through the queue RPC.', { job_id: job.id, error: error instanceof Error ? error.message : String(error) }); }
    try { await queue.terminalizeInterruptedCandidate(job, reason); } catch (error) { await logger.write('error', 'Interrupted candidate could not be terminalized.', { job_id: job.id, error: error instanceof Error ? error.message : String(error) }); }
    abortController.abort();
  };
  try {
    validateJob(job.job_type, job.parameters);
    if (stopping) { await interrupt({ code: 'CONTROLLER_SHUTDOWN', message: 'Controller shutdown began before execution.' }); return; }
    if (await cancelled(job.id)) { await queue.cancel(job.id, 'Cancellation observed before execution.'); return; }
    const resourceClass = resourceClassForJob(job);
    const managed = resourceClass !== RESOURCE_CLASSES.deterministicWork;
    const localHeavy = resourceClass === RESOURCE_CLASSES.localHeavyModel;
    lockName = resourceLockName(resourceClass);
    if (managed) {
      await refreshResourceState(true);
      const memory = state.memoryAvailableGb || 0;
      if (memory < config.minimumMemoryGb) {
        const details = { code: 'RESOURCE_DEFERRED', message: `Available memory ${memory.toFixed(1)} GB is below policy; job deferred without consuming a retry.`, retryable: true, available_memory_gb: memory, minimum_memory_gb: config.minimumMemoryGb, memory_pressure_percent: state.memoryPressurePercent, swap_used_gb: state.swapUsedGb };
        const deferred = await queue.deferResource(job.id, details, details.message);
        if (!deferred?.id) throw Object.assign(new Error('Resource deferral could not return the job to the queue.'), { code: 'RESOURCE_DEFER_FAILED', retryable: true });
        state.resourceDeferredJobs = (state.resourceDeferredJobs || 0) + 1;
        state.lastResourceDeferredJobId = job.id;
        state.lastResourceDeferredAt = new Date().toISOString();
        await jobLogger.write('warn', details.message, details);
        return;
      }
      lock = await queue.lock(job.id, lockName || 'heavy_model'); if (!lock) throw Object.assign(new Error(`${resourceClass} resource lock is unavailable.`), { code: 'RESOURCE_BUSY', retryable: true }); activeResourceLock = { id: job.id, name: lockName || 'heavy_model' };
    }
    if (localHeavy) {
      clearIdleTimer();
      const requestedModel = ['score_editorial_events', 'generate_pitch'].includes(job.job_type) && typeof job.parameters.model === 'string' ? job.parameters.model : config.ollamaModel;
      if (activeModel && activeModel !== requestedModel) { await unloadModel(config, activeModel); activeModel = null; }
      const ollama = await ollamaHealth(config, requestedModel); state.ollama = ollama.reachable; state.model = ollama.modelAvailable; state.loadedOllamaModels = ollama.loadedModels; if (!ollama.reachable || !ollama.modelAvailable) throw Object.assign(new Error(`Ollama or ${requestedModel} is unavailable.`), { code: 'MODEL_UNAVAILABLE', retryable: true });
      activeModel = requestedModel;
      ranLocalHeavyModel = true;
    }
    if (!await queue.start(job.id)) throw new Error('Job lease could not transition to running.');
    currentExecution = { job, interrupt };
    await logger.write('info', 'Job execution started.', { job_id: job.id, pid: process.pid, pipeline_version: isV1Job(job) ? 'v1' : 'legacy' });
    const heartbeatOnce = async () => {
      if (stopping || interrupted) return;
      try {
        const configuredLease = job.job_type === 'luna_editorial_candidate' && Number.isInteger(job.parameters?.processing_lease_minutes)
          ? Math.min(10_800, Math.max(30, Number(job.parameters.processing_lease_minutes) * 60))
          : config.leaseSeconds;
        const ok = await queue.heartbeat(job.id, configuredLease);
        if (!ok) await interrupt({ code: 'LEASE_HEARTBEAT_LOST', message: 'Controller could not renew the job lease.' });
      } catch (error) {
        await jobLogger.write('error', 'Lease heartbeat failed.', { code: 'LEASE_HEARTBEAT_ERROR', error: error instanceof Error ? error.message : String(error) });
      }
    };
    heartbeat = setInterval(() => { void heartbeatOnce(); if (lock) void queue.lock(job.id, lockName || 'heavy_model'); }, config.heartbeatMs);
    const result = await runPipeline(config, job, async (line, stderr) => { await jobLogger.write(stderr ? 'warn' : 'info', line); }, () => cancelled(job.id), abortController.signal);
    if (interrupted) { await queue.terminalizeInterruptedCandidate(job, interrupted); return; }
    if (await cancelled(job.id)) { await queue.cancel(job.id, result.log.slice(-12000)); await jobLogger.write('warn', 'Job cancelled.'); }
    else if (result.ok) { await queue.complete(job.id, result.result || {}, result.log.slice(-12000)); state.lastCompletedJobId = job.id; await jobLogger.write('info', 'Job completed.'); }
    else { await queue.fail(job.id, result.error || { code: 'PIPELINE_FAILED', message: 'Pipeline failed.', retryable: false }, result.log.slice(-12000)); await jobLogger.write('error', result.error?.message || 'Pipeline failed.'); }
  } catch (error) {
    const details = { code: (error as any)?.code || 'CONTROLLER_ERROR', message: error instanceof Error ? error.message : String(error), retryable: Boolean((error as any)?.retryable) };
    recordJobFailure(state, details.message); await queue.fail(job.id, details, details.message); if (isV1Job(job)) await queue.terminalizeInterruptedCandidate(job, details); await jobLogger.write('error', details.message, details);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (lock) await queue.unlock(job.id, lockName || 'heavy_model');
    if (activeResourceLock?.id === job.id) activeResourceLock = null;
    if (currentExecution?.job.id === job.id) currentExecution = null;
    state.currentJobId = null;
    clearResolvedJobFailure(state);
    if (ranLocalHeavyModel) resetIdle();
  }
}

async function tick() {
  if (stopping || currentExecutionPromise) return;
  try {
    await refreshResourceState();
    await queue.reconcileExpiredJobs();
    if (Date.now() - lastControllerHeartbeat >= 60_000) await recordControllerHealth();
    if (Date.now() - lastXBrowserCheck >= 60_000) {
      lastXBrowserCheck = Date.now();
      await queue.queueXBrowserIngestion();
    }
    if (stopping) return;
    const job = await queue.claim(codexProviderReady);
    recordQueueSuccess(state);
    if (!job) return;
    if (stopping) { await queue.fail(job.id, { code: 'CONTROLLER_SHUTDOWN', message: 'Controller shutdown began after job claim.', retryable: false }, 'Controller shutdown began after job claim.'); await queue.terminalizeInterruptedCandidate(job, { code: 'CONTROLLER_SHUTDOWN', message: 'Controller shutdown began after job claim.' }); return; }
    currentExecutionPromise = execute(job);
    await currentExecutionPromise;
  } catch (error) {
    const message = recordQueueFailure(state, error);
    await logger.write('error', message);
  } finally { currentExecutionPromise = null; }
}

async function closeHealthServer() {
  if (!healthServer) return;
  const server = healthServer;
  healthServer = undefined;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function stop(reason = 'SIGTERM') {
  if (stopPromise) return stopPromise;
  stopping = true;
  if (loop) clearInterval(loop);
  stopPromise = (async () => {
    await logger.write('info', 'Shutdown requested.', { controller_id: config.controllerId, pid: process.pid, reason });
    if (currentExecution) await currentExecution.interrupt({ code: 'CONTROLLER_SHUTDOWN', message: 'Controller shutdown interrupted the in-flight job.' });
    if (currentTickPromise) await currentTickPromise;
    if (currentExecutionPromise) await currentExecutionPromise;
    if (activeResourceLock) { await queue.unlock(activeResourceLock.id, activeResourceLock.name); activeResourceLock = null; }
    await logger.write('info', 'Job drain completed.', { controller_id: config.controllerId, pid: process.pid });
    await recordControllerHealth('stopping');
    await closeHealthServer();
    await logger.write('info', 'Controller stopping.', { controller_id: config.controllerId, pid: process.pid });
    process.exit(0);
  })();
  return stopPromise;
}

async function main() {
  await fs.access(path.join(config.anywaysRepoPath, 'bin', 'anyways-pipeline-command.mjs'));
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required.');
  await fs.mkdir(config.logDirectory, { recursive: true });
  const ollama = await ollamaHealth(config); state.ollama = ollama.reachable; state.model = ollama.modelAvailable; state.loadedOllamaModels = ollama.loadedModels; if (ollama.loadedModels.includes(config.ollamaModel)) resetIdle();
  const codex = await checkCodexReadiness(config);
  codexProviderReady = codex.ok;
  state.codexProviderReady = codex.ok;
  state.codexExecutable = codex.executable;
  state.codexVersion = codex.version;
  state.codexReadinessError = codex.error;
  healthServer = await startHealthServer(config.healthHost, config.healthPort, state);
  await recordControllerHealth('running');
  await logger.write('info', 'Listener acquired.', { controller_id: config.controllerId, pid: process.pid, host: config.healthHost, port: config.healthPort });
  await logger.write('info', 'Controller initialized.', { controller_id: config.controllerId, pid: process.pid, ollama: ollama.reachable, model: ollama.modelAvailable, codex_provider_ready: codex.ok, codex_executable: codex.executable, codex_readiness_error: codex.error });
  process.on('SIGINT', () => { void stop('SIGINT'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  currentTickPromise = tick();
  await currentTickPromise;
  currentTickPromise = null;
  await recordControllerHealth('running');
  if (stopping) return;
  loop = setInterval(() => { currentTickPromise = tick(); void currentTickPromise; }, config.pollIntervalMs);
  await logger.write('info', 'Queue polling started.', { controller_id: config.controllerId, pid: process.pid, poll_interval_ms: config.pollIntervalMs });
}

main().catch(async error => { await logger.write('error', error instanceof Error ? error.message : String(error), { controller_id: config.controllerId, pid: process.pid }); process.exit(1); });
