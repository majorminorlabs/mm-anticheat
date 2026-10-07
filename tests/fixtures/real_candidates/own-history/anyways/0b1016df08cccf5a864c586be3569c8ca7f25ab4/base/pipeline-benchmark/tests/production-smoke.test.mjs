import assert from 'node:assert/strict';
import test from 'node:test';
import { smokeProductionModel } from '../ops/smoke-production-model.mjs';

const configuration = {
  ollama_url: 'http://127.0.0.1:11434',
  baseline_model: 'qwen3:14b',
  baseline_digest: 'a'.repeat(64)
};

test('production model smoke is authorization-gated and verifies exact digest with a stub', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    if (url.endsWith('/api/tags')) return {
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:14b', digest: 'a'.repeat(64) }] })
    };
    return { ok: true, json: async () => ({ response: 'OK' }) };
  };
  await assert.rejects(() => smokeProductionModel({ configuration, fetchImpl, authorized: false }), /disabled/);
  const result = await smokeProductionModel({ configuration, fetchImpl, authorized: true });
  assert.equal(calls, 2);
  assert.deepEqual(result, { model: 'qwen3:14b', digest: 'a'.repeat(64), generated: true, output_nonempty: true });
});

test('production model smoke rejects a digest mismatch before generation', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => ({ models: [{ name: 'qwen3:14b', digest: 'b'.repeat(64) }] }) };
  };
  await assert.rejects(() => smokeProductionModel({ configuration, fetchImpl, authorized: true }), /digest/);
  assert.equal(calls, 1);
});
