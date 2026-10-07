import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileHash, sleep } from './util.mjs';

const execFileAsync = promisify(execFile);

function errorRecord(step, error) {
  return {
    step,
    error: error?.message || String(error),
    error_code: error?.code || null,
    error_details: error?.details || null
  };
}

function digestMatches(actual, expected) {
  const value = String(actual || '');
  if (!expected) return true;
  return expected.length === 64 ? value === expected : value.startsWith(expected);
}

function parseLaunchctlPrint(stdout) {
  const text = String(stdout || '');
  const state = text.match(/^\s*state = (.+)$/m)?.[1]?.trim() || 'loaded';
  const pidText = text.match(/^\s*pid = (\d+)$/m)?.[1];
  const pid = pidText ? Number(pidText) : null;
  return {
    service_loaded: true,
    service_state: state,
    pid,
    running: state === 'running' || Number.isInteger(pid)
  };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export async function waitForControllerShutdown({
  recordedPid,
  statusProbe,
  pidExists = processExists,
  listenerProbe,
  timeoutMs = 15000,
  pollMs = 250,
  now = Date.now,
  sleepImpl = sleep
}) {
  const startedAtMs = now();
  const observations = [];
  while (true) {
    const status = await statusProbe();
    const recordedPidExists = Number.isInteger(recordedPid) ? await pidExists(recordedPid) : false;
    const listenerPids = [...new Set((await listenerProbe()).filter(Number.isInteger))].sort((a, b) => a - b);
    const elapsedMs = Math.max(0, now() - startedAtMs);
    const observation = {
      observed_at: new Date().toISOString(),
      elapsed_ms: elapsedMs,
      service_loaded: Boolean(status.service_loaded),
      service_state: status.service_state || (status.service_loaded ? 'unknown' : 'absent'),
      service_pid: Number.isInteger(status.pid) ? status.pid : null,
      recorded_pid: Number.isInteger(recordedPid) ? recordedPid : null,
      recorded_pid_exists: recordedPidExists,
      listener_pids: listenerPids
    };
    observations.push(observation);

    const replacementPids = new Set();
    if (Number.isInteger(status.pid) && status.pid !== recordedPid) replacementPids.add(status.pid);
    for (const pid of listenerPids) if (pid !== recordedPid) replacementPids.add(pid);
    if (replacementPids.size) {
      const error = new Error(`A replacement controller process appeared during shutdown: ${[...replacementPids].join(', ')}.`);
      error.code = 'CONTROLLER_REPLACEMENT_APPEARED';
      error.details = { recorded_pid: recordedPid || null, replacement_pids: [...replacementPids], observations };
      throw error;
    }

    const serviceStopped = !status.service_loaded || (!status.running && status.service_state !== 'running');
    if (serviceStopped && !recordedPidExists && listenerPids.length === 0) {
      return {
        status: observations.length === 1 ? 'stopped_immediately' : 'stopped_after_polling',
        recorded_pid: recordedPid || null,
        elapsed_ms: elapsedMs,
        observations
      };
    }
    if (elapsedMs >= timeoutMs) {
      const error = new Error(`Controller shutdown timed out after ${timeoutMs}ms.`);
      error.code = 'CONTROLLER_PAUSE_TIMEOUT';
      error.details = { recorded_pid: recordedPid || null, timeout_ms: timeoutMs, poll_ms: pollMs, observations };
      throw error;
    }
    await sleepImpl(pollMs);
  }
}

export class ProductionCoordinator {
  constructor({
    healthProbe,
    queueProbe,
    controllerControl,
    modelSystem,
    productionSmoke,
    acceptableHealth = ['healthy'],
    baselineModel = 'qwen3:14b',
    baselineDigestPrefix = '',
    authorized = false,
    restoreHealthTimeoutMs = 30000,
    restoreHealthPollMs = 500
  } = {}) {
    this.healthProbe = healthProbe;
    this.queueProbe = queueProbe;
    this.controllerControl = controllerControl;
    this.modelSystem = modelSystem;
    this.productionSmoke = productionSmoke;
    this.acceptableHealth = acceptableHealth;
    this.baselineModel = baselineModel;
    this.baselineDigestPrefix = baselineDigestPrefix;
    this.authorized = authorized;
    this.restoreHealthTimeoutMs = restoreHealthTimeoutMs;
    this.restoreHealthPollMs = restoreHealthPollMs;
    this.snapshot = null;
    this.paused = false;
    this.pauseReport = null;
  }

  async recordState() {
    if (!this.healthProbe || !this.queueProbe || !this.controllerControl || !this.modelSystem) {
      throw new Error('Production coordination requires health, queue, controller, and model probes.');
    }
    this.snapshot = {
      recorded_at: new Date().toISOString(),
      health: await this.healthProbe(),
      queue: await this.queueProbe(),
      controller: await this.controllerControl.status(),
      resident_models: await this.modelSystem.residentModels()
    };
    return this.snapshot;
  }

  async preflightAndPause() {
    if (!this.authorized) throw new Error('Production pause is disabled without explicit official-run authorization.');
    const snapshot = await this.recordState();
    if (!this.acceptableHealth.includes(snapshot.health.status)) throw new Error(`Controller health is not acceptable: ${snapshot.health.status}`);
    if (!snapshot.health.queue_connectivity) throw new Error('Controller queue connectivity is unavailable.');
    if (!snapshot.queue.idle || snapshot.queue.active_count !== 0 || snapshot.queue.queued_count !== 0) throw new Error('Production queue is not idle.');
    if (snapshot.health.current_job_id) throw new Error('Controller reports an active job.');
    if (!snapshot.controller.running) throw new Error('Controller is not running before the benchmark.');
    const unexpected = snapshot.resident_models.filter(item => item.model !== this.baselineModel);
    if (unexpected.length) throw new Error(`Unexpected production-resident model: ${unexpected.map(item => item.model).join(', ')}`);
    try {
      this.pauseReport = await this.controllerControl.pause({ recordedPid: snapshot.controller.pid });
      this.paused = true;
      snapshot.controller_pause = this.pauseReport;
    } catch (error) {
      this.paused = Boolean(error.command_succeeded);
      this.pauseReport = error.details || null;
      snapshot.controller_pause = this.pauseReport;
      throw error;
    }
    return snapshot;
  }

  async restore() {
    if (!this.snapshot) throw new Error('Production state was not recorded.');
    const report = { started_at: new Date().toISOString(), steps: [], failures: [] };
    const attempt = async (step, operation) => {
      const startedAt = new Date().toISOString();
      try {
        const details = await operation();
        report.steps.push({ step, status: 'ok', started_at: startedAt, finished_at: new Date().toISOString(), ...details });
        return details;
      } catch (error) {
        const failure = errorRecord(step, error);
        report.failures.push(failure);
        report.steps.push({ step, status: 'failed', started_at: startedAt, finished_at: new Date().toISOString(), ...failure });
        return null;
      }
    };

    await attempt('unload_benchmark_models', async () => {
      const original = new Set(this.snapshot.resident_models.map(item => item.model));
      const residents = await this.modelSystem.residentModels();
      const unloaded = [];
      const failures = [];
      for (const resident of residents) {
        if (original.has(resident.model)) continue;
        try {
          await this.modelSystem.unloadModel(resident.model);
          unloaded.push(resident.model);
        } catch (error) {
          failures.push({ model: resident.model, error: error.message });
        }
      }
      if (failures.length) {
        const error = new Error(`Could not unload benchmark model(s): ${failures.map(item => `${item.model}: ${item.error}`).join('; ')}`);
        error.details = { unloaded, failures };
        throw error;
      }
      return { unloaded, residents: await this.modelSystem.residentModels(), verified: true };
    });

    await attempt('production_model_smoke', async () => {
      if (!this.productionSmoke) throw new Error('A production-path qwen3:14b smoke probe is required for restoration.');
      const smoke = await this.productionSmoke();
      if (!smoke?.generated || !smoke?.output_nonempty) throw new Error('Production smoke did not verify non-empty generation output.');
      return { smoke, verified: true };
    });

    await attempt('verify_production_model_tag_digest', async () => {
      const installed = await this.modelSystem.installedModel(this.baselineModel);
      if ((installed.name || installed.model) !== this.baselineModel || !digestMatches(installed.digest, this.baselineDigestPrefix)) {
        throw new Error('Installed production model tag or digest does not match benchmark configuration.');
      }
      return { model: this.baselineModel, digest: installed.digest, verified: true };
    });

    await attempt('restore_ollama_residency', async () => {
      await this.modelSystem.restoreResidency(this.snapshot.resident_models);
      const residents = await this.modelSystem.residentModels();
      const expected = this.snapshot.resident_models.map(item => item.model).sort();
      const actual = residents.map(item => item.model).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Ollama residency does not match the recorded state: expected ${expected.join(', ') || 'none'}, found ${actual.join(', ') || 'none'}.`);
      }
      return { residents, verified: true };
    });

    await attempt('restore_controller_state', async () => {
      let controller = await this.controllerControl.status();
      if (this.snapshot.controller.running && !controller.running) {
        await this.controllerControl.resume();
      } else if (!this.snapshot.controller.running && controller.running) {
        await this.controllerControl.pause({ recordedPid: controller.pid });
      }
      const deadline = Date.now() + this.restoreHealthTimeoutMs;
      const observations = [];
      while (true) {
        controller = await this.controllerControl.status();
        observations.push({ observed_at: new Date().toISOString(), controller });
        if (controller.running === this.snapshot.controller.running) break;
        if (Date.now() >= deadline) {
          const error = new Error('Controller running state was not restored.');
          error.details = { observations };
          throw error;
        }
        await sleep(this.restoreHealthPollMs);
      }
      if (this.snapshot.controller.plist_sha256 && controller.plist_sha256 !== this.snapshot.controller.plist_sha256) {
        throw new Error('Controller LaunchAgent definition changed during the benchmark.');
      }
      this.paused = false;
      return { controller, observations, verified: true };
    });

    await attempt('verify_controller_health_and_queue', async () => {
      const deadline = Date.now() + this.restoreHealthTimeoutMs;
      const observations = [];
      while (true) {
        try {
          const health = await this.healthProbe();
          const queue = await this.queueProbe();
          observations.push({ observed_at: new Date().toISOString(), health, queue });
          if (this.acceptableHealth.includes(health.status) && health.queue_connectivity && queue.idle) {
            return { health, queue, observations, verified: true };
          }
        } catch (error) {
          observations.push({ observed_at: new Date().toISOString(), error: error.message });
        }
        if (Date.now() >= deadline) {
          const error = new Error('Controller health or queue connectivity failed after restoration.');
          error.details = { observations };
          throw error;
        }
        await sleep(this.restoreHealthPollMs);
      }
    });

    await attempt('verify_no_active_jobs_or_leases', async () => {
      const queue = await this.queueProbe();
      const activeLeases = Number(queue.active_lease_count || 0);
      if (!queue.idle || Number(queue.active_count || 0) !== 0 || Number(queue.queued_count || 0) !== 0 || activeLeases !== 0) {
        throw new Error('Production queue still has queued jobs, active jobs, or active leases.');
      }
      return { queue, verified: true };
    });

    report.finished_at = new Date().toISOString();
    report.status = report.failures.length ? 'RESTORE_FAILED' : 'restored';
    return report;
  }
}

export function launchctlControllerControl({
  label,
  plist,
  uid = process.getuid?.(),
  port = 4317,
  pauseTimeoutMs = 15000,
  pausePollMs = 250,
  execFileImpl = execFileAsync,
  pidExists = processExists,
  sleepImpl = sleep,
  now = Date.now,
  listenerProbe: injectedListenerProbe = null
}) {
  if (!label || !plist || uid == null) throw new Error('LaunchAgent label, plist, and uid are required.');
  const domain = `gui/${uid}`;
  const status = async () => {
    const plistSha256 = await fileHash(plist);
    try {
      const { stdout } = await execFileImpl('launchctl', ['print', `${domain}/${label}`]);
      return { ...parseLaunchctlPrint(stdout), label, plist, plist_sha256: plistSha256 };
    } catch (error) {
      if (typeof error.code === 'number') {
        return {
          running: false,
          service_loaded: false,
          service_state: 'absent',
          pid: null,
          label,
          plist,
          plist_sha256: plistSha256
        };
      }
      throw error;
    }
  };
  const listenerProbe = injectedListenerProbe || (async () => {
    try {
      const { stdout } = await execFileImpl('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
      return String(stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
    } catch (error) {
      if (error.code === 1) return [];
      throw error;
    }
  });
  return {
    status,
    async pause({ recordedPid = null } = {}) {
      try {
        await execFileImpl('launchctl', ['bootout', `${domain}/${label}`]);
      } catch (error) {
        const wrapped = new Error(`Controller bootout command failed: ${error.message}`);
        wrapped.code = 'CONTROLLER_PAUSE_COMMAND_FAILED';
        wrapped.command_succeeded = false;
        wrapped.details = { label, domain, recorded_pid: recordedPid };
        throw wrapped;
      }
      try {
        const result = await waitForControllerShutdown({
          recordedPid,
          statusProbe: status,
          pidExists,
          listenerProbe,
          timeoutMs: pauseTimeoutMs,
          pollMs: pausePollMs,
          now,
          sleepImpl
        });
        return { command: 'bootout', command_succeeded: true, ...result };
      } catch (error) {
        error.command_succeeded = true;
        throw error;
      }
    },
    async resume() {
      await execFileImpl('launchctl', ['bootstrap', domain, plist]);
    }
  };
}

export class OllamaProductionModelSystem {
  constructor({ baseUrl = 'http://127.0.0.1:11434', fetchImpl = globalThis.fetch } = {}) {
    const parsed = new URL(baseUrl);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('Production model probe must use loopback Ollama.');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async request(endpoint, body = null) {
    const response = await this.fetch(`${this.baseUrl}${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new Error(`Ollama production probe ${endpoint} returned ${response.status}.`);
    return response.json();
  }

  async residentModels() {
    const payload = await this.request('/api/ps');
    return (payload.models || []).map(item => ({ model: item.name || item.model, digest: item.digest || '' }));
  }

  async installedModel(model) {
    const payload = await this.request('/api/tags');
    const installed = (payload.models || []).find(item => (item.name || item.model) === model);
    if (!installed) throw new Error(`Required Ollama model is not installed: ${model}`);
    return installed;
  }

  async unloadModel(model) {
    await this.request('/api/generate', { model, prompt: '', stream: false, keep_alive: 0 });
    for (let attempt = 0; attempt < 240; attempt++) {
      if (!(await this.residentModels()).some(item => item.model === model)) return;
      await sleep(250);
    }
    throw new Error(`Could not verify unload of ${model}.`);
  }

  async loadModel(model) {
    await this.request('/api/generate', { model, prompt: '', stream: false, keep_alive: '10m' });
    if (!(await this.residentModels()).some(item => item.model === model)) throw new Error(`Could not verify load of ${model}.`);
  }

  async restoreResidency(original) {
    const current = await this.residentModels();
    for (const resident of current) if (!original.some(item => item.model === resident.model)) await this.unloadModel(resident.model);
    for (const resident of original) if (!(await this.residentModels()).some(item => item.model === resident.model)) await this.loadModel(resident.model);
  }
}
