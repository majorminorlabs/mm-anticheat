import assert from 'node:assert/strict';
import test from 'node:test';
import { smokeProductionModel } from '../ops/smoke-production-model.mjs';

const configuration = {
  ollama_url: 'http://127.0.0.1:11434',
  baseline_model: 'qwen3:14b',
  baseline_digest: 'a'.repeat(64)
};

test('production model smoke is authorization-gated and validates a completed visible response', async () => {
  let calls = 0;
  let requestBody;
  const fetchImpl = async (url, init) => {
    calls++;
    if (url.endsWith('/api/tags')) return {
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:14b', digest: 'a'.repeat(64) }] })
    };
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        model: 'qwen3:14b',
        response: 'OK',
        done: true,
        done_reason: 'stop',
        total_duration: 10,
        load_duration: 2,
        prompt_eval_count: 4,
        prompt_eval_duration: 3,
        eval_count: 1,
        eval_duration: 5
      })
    };
  };
  await assert.rejects(() => smokeProductionModel({ configuration, fetchImpl, authorized: false }), /disabled/);
  const result = await smokeProductionModel({ configuration, fetchImpl, authorized: true });
  assert.equal(calls, 3);
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.think, false);
  assert.equal(requestBody.options.num_predict, 32);
  assert.equal(result.model, 'qwen3:14b');
  assert.equal(result.digest, 'a'.repeat(64));
  assert.equal(result.output_text, 'OK');
  assert.equal(result.response_field, 'response');
  assert.equal(result.completion.done, true);
  assert.equal(result.metrics.eval_count, 1);
  assert.ok(result.metrics.wall_ms >= 0);
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

test('production model smoke rejects thinking-only output instead of treating it as visible content', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    if (url.endsWith('/api/tags')) {
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3:14b', digest: 'a'.repeat(64) }] }) };
    }
    return {
      ok: true,
      json: async () => ({ model: 'qwen3:14b', response: '', thinking: 'I should say OK.', done: true })
    };
  };
  await assert.rejects(
    () => smokeProductionModel({ configuration, fetchImpl, authorized: true }),
    error => {
      assert.equal(error.code, 'SMOKE_THINKING_ONLY');
      return true;
    }
  );
  assert.equal(calls, 2);
});

test('production model smoke rejects content in the wrong response field', async () => {
  const fetchImpl = async url => {
    if (url.endsWith('/api/tags')) {
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3:14b', digest: 'a'.repeat(64) }] }) };
    }
    return {
      ok: true,
      json: async () => ({ model: 'qwen3:14b', response: '', message: { content: 'OK' }, done: true })
    };
  };
  await assert.rejects(() => smokeProductionModel({ configuration, fetchImpl, authorized: true }), /no output/);
});

test('production model smoke rejects wrong model tags and incomplete generations', async () => {
  const tags = { ok: true, json: async () => ({ models: [{ name: 'qwen3:14b', digest: 'a'.repeat(64) }] }) };
  const wrongModelFetch = async url => url.endsWith('/api/tags')
    ? tags
    : { ok: true, json: async () => ({ model: 'qwen3:30b', response: 'OK', done: true }) };
  await assert.rejects(() => smokeProductionModel({ configuration, fetchImpl: wrongModelFetch, authorized: true }), /wrong model tag/);

  const incompleteFetch = async url => url.endsWith('/api/tags')
    ? tags
    : { ok: true, json: async () => ({ model: 'qwen3:14b', response: 'OK', done: false }) };
  await assert.rejects(() => smokeProductionModel({ configuration, fetchImpl: incompleteFetch, authorized: true }), /completed generation/);
});

test('production model smoke verifies the digest again after generation', async () => {
  let tagCalls = 0;
  const fetchImpl = async url => {
    if (url.endsWith('/api/tags')) {
      tagCalls++;
      return {
        ok: true,
        json: async () => ({
          models: [{ name: 'qwen3:14b', digest: (tagCalls === 1 ? 'a' : 'b').repeat(64) }]
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ model: 'qwen3:14b', response: 'OK', done: true, done_reason: 'stop' })
    };
  };
  await assert.rejects(() => smokeProductionModel({ configuration, fetchImpl, authorized: true }), /digest changed/);
  assert.equal(tagCalls, 2);
});
