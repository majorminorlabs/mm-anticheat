#!/usr/bin/env node
import { readJson } from '../src/util.mjs';

export async function smokeProductionModel({
  configuration,
  fetchImpl = globalThis.fetch,
  authorized = process.env.ANYWAYS_BENCHMARK_ALLOW_PRODUCTION_SMOKE === '1'
} = {}) {
  if (!authorized) throw new Error('Production model smoke is disabled without ANYWAYS_BENCHMARK_ALLOW_PRODUCTION_SMOKE=1.');
  const config = configuration || await readJson(new URL('../config/benchmark.json', import.meta.url));
  const tagsResponse = await fetchImpl(`${config.ollama_url.replace(/\/$/, '')}/api/tags`);
  if (!tagsResponse.ok) throw new Error(`Ollama tags returned ${tagsResponse.status}.`);
  const tags = await tagsResponse.json();
  const installed = (tags.models || []).find(item => (item.name || item.model) === config.baseline_model);
  if (!installed) throw new Error(`Production baseline model is not installed: ${config.baseline_model}`);
  if (installed.digest !== config.baseline_digest) throw new Error('Production baseline model digest does not match benchmark configuration.');
  const response = await fetchImpl(`${config.ollama_url.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.baseline_model,
      prompt: 'Return exactly OK.',
      stream: false,
      keep_alive: '10m',
      options: { num_ctx: 2048, temperature: 0, seed: 42, num_predict: 8 }
    })
  });
  if (!response.ok) throw new Error(`Production model smoke returned ${response.status}.`);
  const output = await response.json();
  if (!String(output.response || '').trim()) throw new Error('Production model smoke returned no output.');
  return {
    model: config.baseline_model,
    digest: installed.digest,
    generated: true,
    output_nonempty: true
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
