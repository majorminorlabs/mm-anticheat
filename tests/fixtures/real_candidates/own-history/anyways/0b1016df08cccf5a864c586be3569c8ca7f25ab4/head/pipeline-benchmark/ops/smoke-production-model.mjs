#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { readJson } from '../src/util.mjs';

export async function smokeProductionModel({
  configuration,
  fetchImpl = globalThis.fetch,
  authorized = process.env.ANYWAYS_BENCHMARK_ALLOW_PRODUCTION_SMOKE === '1',
  timeoutMs = 120000
} = {}) {
  if (!authorized) throw new Error('Production model smoke is disabled without ANYWAYS_BENCHMARK_ALLOW_PRODUCTION_SMOKE=1.');
  const config = configuration || await readJson(new URL('../config/benchmark.json', import.meta.url));
  const baseUrl = config.ollama_url.replace(/\/$/, '');
  const request = async (endpoint, init = undefined) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${endpoint}`, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`Ollama ${endpoint} returned HTTP ${response.status}.`);
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const installedModels = async () => {
    const tags = await request('/api/tags');
    return (tags.models || []).find(item => (item.name || item.model) === config.baseline_model);
  };

  const installed = await installedModels();
  if (!installed) throw new Error(`Production baseline model is not installed: ${config.baseline_model}`);
  if (installed.digest !== config.baseline_digest) throw new Error('Production baseline model digest does not match benchmark configuration.');

  const requestBody = {
    model: config.baseline_model,
    prompt: 'Reply with only OK.',
    stream: false,
    think: false,
    keep_alive: '10m',
    options: {
      num_ctx: 2048,
      temperature: 0,
      seed: 42,
      num_predict: 32
    }
  };
  const started = performance.now();
  const output = await request('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  const wallMs = performance.now() - started;
  if ((output.model || '') !== config.baseline_model) throw new Error(`Production model smoke returned the wrong model tag: ${output.model || 'missing'}.`);
  if (output.done !== true) throw new Error('Production model smoke did not report a completed generation.');
  const generatedContent = String(output.response || '').trim();
  if (!generatedContent) {
    const thinkingOnly = Boolean(String(output.thinking || '').trim());
    const error = new Error(thinkingOnly
      ? 'Production model smoke returned reasoning but no visible response.'
      : 'Production model smoke returned no output.');
    error.code = thinkingOnly ? 'SMOKE_THINKING_ONLY' : 'SMOKE_EMPTY_OUTPUT';
    throw error;
  }

  const installedAfter = await installedModels();
  if (!installedAfter) throw new Error(`Production baseline model disappeared after smoke generation: ${config.baseline_model}`);
  if (installedAfter.digest !== config.baseline_digest) throw new Error('Production baseline model digest changed during smoke generation.');

  return {
    model: config.baseline_model,
    digest: installedAfter.digest,
    generated: true,
    output_nonempty: true,
    response_field: 'response',
    output_text: generatedContent,
    completion: {
      done: output.done,
      done_reason: output.done_reason || null
    },
    request: {
      stream: requestBody.stream,
      think: requestBody.think,
      num_ctx: requestBody.options.num_ctx,
      num_predict: requestBody.options.num_predict,
      temperature: requestBody.options.temperature,
      seed: requestBody.options.seed
    },
    metrics: {
      wall_ms: wallMs,
      total_duration_ns: Number(output.total_duration || 0),
      load_duration_ns: Number(output.load_duration || 0),
      prompt_eval_count: Number(output.prompt_eval_count || 0),
      prompt_eval_duration_ns: Number(output.prompt_eval_duration || 0),
      eval_count: Number(output.eval_count || 0),
      eval_duration_ns: Number(output.eval_duration || 0)
    }
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  smokeProductionModel()
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
