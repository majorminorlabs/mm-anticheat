import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileHash, sleep } from './util.mjs';

const execFileAsync = promisify(execFile);

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
    authorized = false
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
    this.snapshot = null;
    this.paused = false;
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
    await this.controllerControl.pause();
    this.paused = true;
    const status = await this.controllerControl.status();
    if (status.running) throw new Error('Controller did not stop for the approved benchmark window.');
    return snapshot;
  }

  async restore() {
    if (!this.snapshot) throw new Error('Production state was not recorded.');
    const report = { started_at: new Date().toISOString(), steps: [] };
    const residents = await this.modelSystem.residentModels();
    for (const resident of residents) {
      if (resident.model !== this.baselineModel) {
        await this.modelSystem.unloadModel(resident.model);
        report.steps.push({ step: 'unload_benchmark_model', model: resident.model, verified: true });
      }
    }
    if (!this.productionSmoke) throw new Error('A production-path qwen3:14b smoke probe is required for restoration.');
    const smoke = await this.productionSmoke();
    const smokeDigest = String(smoke.digest || '');
    const digestMatches = this.baselineDigestPrefix.length === 64
      ? smokeDigest === this.baselineDigestPrefix
      : smokeDigest.startsWith(this.baselineDigestPrefix);
    if (smoke.model !== this.baselineModel || (this.baselineDigestPrefix && !digestMatches)) {
      throw new Error('Production smoke probe returned the wrong model tag or digest.');
    }
    report.steps.push({ step: 'production_model_smoke', model: smoke.model, digest: smoke.digest, verified: true });
    await this.modelSystem.restoreResidency(this.snapshot.resident_models);
    report.steps.push({ step: 'restore_residency', residents: await this.modelSystem.residentModels(), verified: true });
    if (this.snapshot.controller.running && this.paused) await this.controllerControl.resume();
    const controller = await this.controllerControl.status();
    if (controller.running !== this.snapshot.controller.running) throw new Error('Controller running state was not restored.');
    if (this.snapshot.controller.plist_sha256 && controller.plist_sha256 !== this.snapshot.controller.plist_sha256) {
      throw new Error('Controller LaunchAgent definition changed during the benchmark.');
    }
    const health = await this.healthProbe();
    const queue = await this.queueProbe();
    if (!this.acceptableHealth.includes(health.status) || !health.queue_connectivity || !queue.idle) {
      throw new Error('Controller health or queue connectivity failed after restoration.');
    }
    report.steps.push({ step: 'restore_controller', controller, health, queue, verified: true });
    report.finished_at = new Date().toISOString();
    report.status = 'restored';
    return report;
  }
}

export function launchctlControllerControl({ label, plist, uid = process.getuid?.() }) {
  if (!label || !plist || uid == null) throw new Error('LaunchAgent label, plist, and uid are required.');
  const domain = `gui/${uid}`;
  return {
    async status() {
      const plistSha256 = await fileHash(plist);
      try {
        await execFileAsync('launchctl', ['print', `${domain}/${label}`]);
        return { running: true, label, plist, plist_sha256: plistSha256 };
      } catch {
        return { running: false, label, plist, plist_sha256: plistSha256 };
      }
    },
    async pause() {
      await execFileAsync('launchctl', ['bootout', `${domain}/${label}`]);
    },
    async resume() {
      await execFileAsync('launchctl', ['bootstrap', domain, plist]);
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
