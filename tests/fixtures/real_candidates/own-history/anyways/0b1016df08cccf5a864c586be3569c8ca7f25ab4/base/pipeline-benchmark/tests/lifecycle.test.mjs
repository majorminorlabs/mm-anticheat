import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StubBenchmarkAdapter } from '../src/adapters/stub.mjs';
import { runLocalModelLifecycle } from '../src/lifecycle.mjs';
import { BenchmarkLock } from '../src/lock.mjs';

test('local lifecycle loads, executes, unloads, and verifies sequentially', async t => {
  StubBenchmarkAdapter.reset();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-lifecycle-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = new BenchmarkLock(path.join(root, 'lock'));
  await lock.acquire({ runId: 'lifecycle-success', planHash: 'a'.repeat(64) });
  const events = [];
  const adapter = new StubBenchmarkAdapter({ model: 'stub-a', events });
  const result = await runLocalModelLifecycle({
    adapter,
    lock,
    events,
    operation: async () => {
      await adapter.generate({ stage: 'draft' });
      await adapter.generate({ stage: 'revision' });
      return 'done';
    }
  });
  assert.equal(result.result, 'done');
  assert.deepEqual(await adapter.residentModels(), []);
  assert.equal(StubBenchmarkAdapter.maximumConcurrentGenerations, 1);
  assert.deepEqual(events.slice(0, 2).map(item => typeof item === 'string' ? item : item.event), ['model_load_started', 'load:stub-a']);
  assert.ok(events.some(item => item === 'unload:stub-a'));
  await lock.release();
});

test('local lifecycle rejects an unexpected resident model before load', async t => {
  StubBenchmarkAdapter.reset();
  StubBenchmarkAdapter.resident.add('unexpected-model');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-lifecycle-test-'));
  t.after(async () => {
    StubBenchmarkAdapter.reset();
    await fs.rm(root, { recursive: true, force: true });
  });
  const lock = new BenchmarkLock(path.join(root, 'lock'));
  await lock.acquire({ runId: 'unexpected-resident', planHash: 'b'.repeat(64) });
  const adapter = new StubBenchmarkAdapter({ model: 'expected-model' });
  await assert.rejects(
    () => runLocalModelLifecycle({ adapter, lock, operation: async () => {} }),
    /Unexpected resident Ollama model/
  );
  await lock.release();
});
