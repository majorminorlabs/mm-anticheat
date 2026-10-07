import { PIPELINE_CONFIG } from './config.mjs';

// llama.cpp's JSON grammar accepts the structural subset but rejects maxLength.
// Keep those limits in the pipeline validator while preserving JSON-mode schema enforcement.
function ollamaFormat(schema) {
  if (Array.isArray(schema)) return schema.map(ollamaFormat);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'maxLength').map(([key, value]) => [key, ollamaFormat(value)]));
}

export class OllamaAdapter {
  constructor({ model = PIPELINE_CONFIG.defaultModel, baseUrl = PIPELINE_CONFIG.ollamaUrl, fetchImpl = fetch } = {}) { this.model = model; this.baseUrl = baseUrl.replace(/\/$/, ''); this.fetch = fetchImpl; }
  async generate({ prompt, schema, timeoutMs = PIPELINE_CONFIG.requestTimeoutMs, maxTokens = 800 }) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ model: this.model, prompt, format: ollamaFormat(schema), stream: false, think: false, options: { temperature: 0.05, seed: 42, num_ctx: 8192, num_predict: maxTokens } }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Ollama returned HTTP ${response.status}`);
      return { raw: payload.response || '', metrics: { eval_count: payload.eval_count, eval_duration_ns: payload.eval_duration, prompt_eval_count: payload.prompt_eval_count, prompt_eval_duration_ns: payload.prompt_eval_duration, max_tokens: maxTokens, truncated: Number(payload.eval_count) >= maxTokens } };
    } finally { clearTimeout(timeout); }
  }
}
