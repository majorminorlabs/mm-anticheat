import { performance } from 'node:perf_hooks';
import { OllamaJsonTransport, OllamaTransportError } from '../ollama-transport.mjs';
import { sleep } from '../util.mjs';

function assertLoopback(url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('Benchmark Ollama adapter only permits a loopback endpoint.');
}

export class OllamaBenchmarkAdapter {
  constructor({
    model,
    baseUrl = 'http://127.0.0.1:11434',
    expectedDigestPrefix = '',
    contextTokens = 32768,
    maximumOutputTokens = 4096,
    temperature = 0,
    seed = 42,
    timeoutMs = 600000,
    connectTimeoutMs = 10000,
    diagnosticTimeoutMs = 5000,
    transport = null,
    allowRealGeneration = false
  } = {}) {
    if (!model) throw new Error('Ollama model tag is required.');
    assertLoopback(baseUrl);
    this.kind = 'local';
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.expectedDigestPrefix = expectedDigestPrefix;
    this.contextTokens = contextTokens;
    this.maximumOutputTokens = maximumOutputTokens;
    this.temperature = temperature;
    this.seed = seed;
    this.timeoutMs = timeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.diagnosticTimeoutMs = diagnosticTimeoutMs;
    this.transport = transport || new OllamaJsonTransport({ connectTimeoutMs });
    this.allowRealGeneration = allowRealGeneration;
  }

  async failureDiagnostics() {
    const diagnostics = {
      ollama_reachable_after_failure: false,
      current_ollama_residency: null,
      diagnostic_errors: []
    };
    try {
      const version = await this.transport.request({
        url: `${this.baseUrl}/api/version`,
        timeoutMs: this.diagnosticTimeoutMs,
        operation: 'post_failure_reachability'
      });
      diagnostics.ollama_reachable_after_failure = Boolean(version.data?.version);
    } catch (error) {
      diagnostics.diagnostic_errors.push({
        operation: 'post_failure_reachability',
        name: error.name,
        message: error.message,
        code: error.code || null
      });
    }
    try {
      const residency = await this.transport.request({
        url: `${this.baseUrl}/api/ps`,
        timeoutMs: this.diagnosticTimeoutMs,
        operation: 'post_failure_residency'
      });
      diagnostics.current_ollama_residency = (residency.data?.models || []).map(item => ({
        model: item.name || item.model,
        digest: item.digest || '',
        size: item.size || 0,
        size_vram: item.size_vram || 0,
        expires_at: item.expires_at || null
      }));
    } catch (error) {
      diagnostics.diagnostic_errors.push({
        operation: 'post_failure_residency',
        name: error.name,
        message: error.message,
        code: error.code || null
      });
    }
    return diagnostics;
  }

  async request(endpoint, body, timeoutMs = this.timeoutMs, {
    operation = endpoint,
    returnTransport = false,
    signal = null
  } = {}) {
    try {
      const result = await this.transport.request({
        url: `${this.baseUrl}${endpoint}`,
        method: body == null ? 'GET' : 'POST',
        body,
        timeoutMs,
        operation,
        signal
      });
      return returnTransport ? result : result.data;
    } catch (error) {
      if (error instanceof OllamaTransportError) {
        const diagnostics = await this.failureDiagnostics();
        error.details = {
          ...error.details,
          top_level_error: {
            name: error.name,
            message: error.message,
            code: error.code || null
          },
          ...diagnostics
        };
      }
      throw error;
    }
  }

  async installedModel() {
    const payload = await this.request('/api/tags', null, this.timeoutMs, { operation: 'installed_model_probe' });
    const row = (payload.models || []).find(item => item.name === this.model || item.model === this.model);
    if (!row) throw new Error(`Required Ollama model is not installed: ${this.model}`);
    const digest = String(row.digest || '');
    const digestMatches = this.expectedDigestPrefix.length === 64
      ? digest === this.expectedDigestPrefix
      : digest.startsWith(this.expectedDigestPrefix);
    if (this.expectedDigestPrefix && !digestMatches) {
      throw new Error(`Ollama digest mismatch for ${this.model}.`);
    }
    return row;
  }

  async residentModels() {
    const payload = await this.request('/api/ps', null, this.timeoutMs, { operation: 'residency_probe' });
    return (payload.models || []).map(item => ({
      model: item.name || item.model,
      digest: item.digest || '',
      size: item.size || 0,
      size_vram: item.size_vram || 0,
      expires_at: item.expires_at || null
    }));
  }

  async assertNoUnexpectedResident({ allowed = [] } = {}) {
    const residents = await this.residentModels();
    const unexpected = residents.filter(item => !allowed.includes(item.model));
    if (unexpected.length) throw new Error(`Unexpected resident Ollama model: ${unexpected.map(item => item.model).join(', ')}`);
    if (residents.length > 1) throw new Error('More than one local model is resident.');
    return residents;
  }

  async load() {
    if (!this.allowRealGeneration) throw new Error('Real Ollama lifecycle is disabled. Pass explicit official-run authorization.');
    const installed = await this.installedModel();
    await this.assertNoUnexpectedResident({ allowed: [this.model] });
    const started = performance.now();
    const request = await this.request('/api/generate', {
      model: this.model,
      prompt: '',
      stream: false,
      keep_alive: '30m',
      options: {
        num_ctx: this.contextTokens,
        num_predict: 1,
        temperature: this.temperature,
        seed: this.seed
      }
    }, this.timeoutMs, { operation: 'model_load', returnTransport: true });
    const result = request.data;
    const residents = await this.assertNoUnexpectedResident({ allowed: [this.model] });
    if (!residents.some(item => item.model === this.model)) throw new Error(`Ollama did not load ${this.model}.`);
    return {
      installed_digest: installed.digest,
      wall_ms: performance.now() - started,
      load_duration_ns: result.load_duration || 0,
      transport: request.transport,
      residents
    };
  }

  async generate({ prompt, schema, stage }) {
    if (!this.allowRealGeneration) throw new Error('Real Ollama generation is disabled. Pass explicit official-run authorization.');
    await this.assertNoUnexpectedResident({ allowed: [this.model] });
    const started = performance.now();
    const request = await this.request('/api/generate', {
      model: this.model,
      prompt,
      stream: false,
      keep_alive: '30m',
      format: schema,
      options: {
        num_ctx: this.contextTokens,
        num_predict: this.maximumOutputTokens,
        temperature: this.temperature,
        seed: this.seed
      }
    }, this.timeoutMs, { operation: `generation:${stage}`, returnTransport: true });
    const result = request.data;
    await this.assertNoUnexpectedResident({ allowed: [this.model] });
    return {
      raw: String(result.response || ''),
      stage,
      metrics: {
        wall_ms: performance.now() - started,
        total_duration_ns: result.total_duration || 0,
        load_duration_ns: result.load_duration || 0,
        prompt_eval_count: result.prompt_eval_count || 0,
        prompt_eval_duration_ns: result.prompt_eval_duration || 0,
        eval_count: result.eval_count || 0,
        eval_duration_ns: result.eval_duration || 0,
        transport: request.transport
      }
    };
  }

  async unload({ timeoutMs = 60000, pollMs = 250 } = {}) {
    if (!this.allowRealGeneration) throw new Error('Real Ollama lifecycle is disabled. Pass explicit official-run authorization.');
    await this.request(
      '/api/generate',
      { model: this.model, prompt: '', stream: false, keep_alive: 0 },
      timeoutMs,
      { operation: 'model_unload' }
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const residents = await this.residentModels();
      if (!residents.some(item => item.model === this.model)) return { verified: true, residents };
      await sleep(pollMs);
    }
    throw new Error(`Ollama failed to unload ${this.model} within ${timeoutMs}ms.`);
  }
}
