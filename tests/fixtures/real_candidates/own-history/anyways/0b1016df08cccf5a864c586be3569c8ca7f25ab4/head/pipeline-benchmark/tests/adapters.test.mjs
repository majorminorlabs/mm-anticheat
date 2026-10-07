import assert from 'node:assert/strict';
import test from 'node:test';
import { KimiCodeBenchmarkAdapter, NO_TOOL_AGENT, kimiArguments } from '../src/adapters/kimi-code.mjs';
import { OllamaBenchmarkAdapter } from '../src/adapters/ollama.mjs';

test('Kimi adapter uses explicit no-tool fresh-session arguments and is paid-disabled by default', async () => {
  assert.match(NO_TOOL_AGENT, /tools: \[\]/);
  assert.match(NO_TOOL_AGENT, /subagents: \[\]/);
  const args = kimiArguments({ model: 'kimi-code/k3-256k', agentFile: '/tmp/agent.md', skillsDirectory: '/tmp/empty', prompt: 'frozen prompt' });
  assert.deepEqual(args.slice(0, 7), ['-p', '--agent-file', '/tmp/agent.md', '--skills-dir', '/tmp/empty', '--model', 'kimi-code/k3-256k']);
  let spawned = false;
  const adapter = new KimiCodeBenchmarkAdapter({ model: 'kimi-code/k3-256k', spawnImpl: () => { spawned = true; } });
  await assert.rejects(() => adapter.generate({ prompt: 'never sent', stage: 'draft' }), /Paid Kimi generation is disabled/);
  assert.equal(spawned, false);
});

test('Ollama generation is real-run disabled by default', async () => {
  let requested = false;
  const adapter = new OllamaBenchmarkAdapter({
    model: 'qwen3:14b',
    transport: { request: async () => { requested = true; } }
  });
  await assert.rejects(() => adapter.generate({ prompt: 'never sent', schema: {}, stage: 'draft' }), /Real Ollama generation is disabled/);
  assert.equal(requested, false);
});

test('Ollama generation enforces configured context and output ceilings', async () => {
  const requests = [];
  const adapter = new OllamaBenchmarkAdapter({
    model: 'qwen3:14b',
    contextTokens: 32768,
    maximumOutputTokens: 4096,
    allowRealGeneration: true,
    transport: {
      async request({ url, body, operation, timeoutMs }) {
      const endpoint = new URL(url).pathname;
      requests.push({ endpoint, body, operation, timeoutMs });
      if (endpoint === '/api/ps') {
        return { data: { models: [{ name: 'qwen3:14b' }] }, transport: { elapsed_ms: 1 } };
      }
      return { data: { response: '{}' }, transport: { elapsed_ms: 1 } };
      }
    }
  });
  await adapter.generate({ prompt: 'synthetic prompt', schema: {}, stage: 'draft' });
  const generation = requests.find(request => request.endpoint === '/api/generate');
  assert.equal(generation.body.options.num_ctx, 32768);
  assert.equal(generation.body.options.num_predict, 4096);
});
