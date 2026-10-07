import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StubBenchmarkAdapter } from '../src/adapters/stub.mjs';
import { BenchmarkLock } from '../src/lock.mjs';
import { BenchmarkRunner } from '../src/runner.mjs';
import { readJson } from '../src/util.mjs';
import { syntheticWorkspace, validStubResponses } from './helpers.mjs';

async function runnerConfiguration() {
  return readJson(new URL('../config/benchmark.json', import.meta.url));
}

test('runner executes every stage and model sequentially, then unloads', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-success-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const events = [];
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'model-a' }, { id: 'model-b' }],
    adapterFactory: model => new StubBenchmarkAdapter({ model: model.id, events, responses: validStubResponses() }),
    lock: new BenchmarkLock(path.join(generatedRoot, 'lock')),
    generatedRoot,
    configuration: await runnerConfiguration()
  });
  const result = await runner.run();
  assert.equal(result.manifest.status, 'completed');
  assert.equal(StubBenchmarkAdapter.maximumConcurrentGenerations, 1);
  assert.deepEqual(await new StubBenchmarkAdapter().residentModels(), []);
  const stringEvents = events.filter(item => typeof item === 'string');
  assert.ok(stringEvents.indexOf('unload:model-a') < stringEvents.indexOf('load:model-b'));
  for (const stage of ['draft', 'revision', 'reviewer', 'evidence_selector', 'research_planner']) {
    assert.ok(stringEvents.some(item => item === `generate:model-a:${stage}:1`));
    assert.ok(stringEvents.some(item => item === `generate:model-b:${stage}:1`));
  }
  assert.equal(result.manifest.prompts.length, 10);
  assert.equal(result.manifest.reports.request_metric_count, 10);
  assert.ok(result.manifest.reports.raw_output_count === 10);
  assert.ok(result.manifest.prompts.every(item => /^[a-f0-9]{64}$/.test(item.compiled_prompt_hash)));
});

test('injected generation failure stops before the next model and still unloads', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-failure-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const events = [];
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'model-a' }, { id: 'model-b' }],
    adapterFactory: model => new StubBenchmarkAdapter({
      model: model.id,
      events,
      responses: validStubResponses(),
      failAt: model.id === 'model-a' ? 'reviewer' : null
    }),
    lock: new BenchmarkLock(path.join(generatedRoot, 'lock')),
    generatedRoot,
    configuration: await runnerConfiguration()
  });
  let caught;
  try { await runner.run(); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.match(caught.message, /Injected reviewer failure/);
  assert.ok(events.includes('unload:model-a'));
  assert.equal(events.includes('load:model-b'), false);
  assert.deepEqual(await new StubBenchmarkAdapter().residentModels(), []);
  const failure = await readJson(path.join(caught.runDirectory, 'private', 'failure-report.json'));
  assert.equal(failure.status, 'failed');
  assert.equal(failure.next_model_started, false);
});

test('unload failure stops the run and deliberately retains the lock', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-unload-failure-'));
  t.after(async () => {
    StubBenchmarkAdapter.reset();
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const lockPath = path.join(generatedRoot, 'lock');
  const events = [];
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'model-a' }, { id: 'model-b' }],
    adapterFactory: model => new StubBenchmarkAdapter({
      model: model.id,
      events,
      responses: validStubResponses(),
      unloadFails: model.id === 'model-a'
    }),
    lock: new BenchmarkLock(lockPath),
    generatedRoot,
    configuration: await runnerConfiguration()
  });
  await assert.rejects(() => runner.run(), /unload/);
  assert.equal(events.includes('load:model-b'), false);
  await assert.doesNotReject(() => fs.access(path.join(lockPath, 'owner.json')));
});

test('production coordination stub restores after a failed model', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-restore-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const productionEvents = [];
  const productionCoordinator = {
    async preflightAndPause() {
      productionEvents.push('record');
      productionEvents.push('pause');
      return { controller: { running: true }, resident_models: [] };
    },
    async restore() {
      productionEvents.push('unload-final');
      productionEvents.push('smoke-qwen3:14b');
      productionEvents.push('restore-residency');
      productionEvents.push('restore-controller');
      productionEvents.push('verify-health-queue');
      return { status: 'restored' };
    }
  };
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'model-a' }],
    adapterFactory: model => new StubBenchmarkAdapter({
      model: model.id,
      responses: validStubResponses(),
      failAt: 'evidence_selector'
    }),
    lock: new BenchmarkLock(path.join(generatedRoot, 'lock')),
    generatedRoot,
    configuration: await runnerConfiguration(),
    coordinateProduction: true,
    productionCoordinator
  });
  await assert.rejects(() => runner.run(), /Injected evidence_selector failure/);
  assert.deepEqual(productionEvents, [
    'record',
    'pause',
    'unload-final',
    'smoke-qwen3:14b',
    'restore-residency',
    'restore-controller',
    'verify-health-queue'
  ]);
});

test('prompt-size preflight rejects before lock acquisition or adapter construction', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-context-rejection-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  let adapterConstructed = false;
  const configuration = await runnerConfiguration();
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'too-small-context', context_window_tokens: 5000 }],
    adapterFactory: () => {
      adapterConstructed = true;
      return new StubBenchmarkAdapter();
    },
    lock: new BenchmarkLock(path.join(generatedRoot, 'lock')),
    generatedRoot,
    configuration
  });
  let caught;
  try { await runner.run(); } catch (error) { caught = error; }
  assert.equal(caught?.code, 'PROMPT_CONTEXT_BUDGET_EXCEEDED');
  assert.equal(adapterConstructed, false);
  await assert.rejects(() => fs.access(path.join(generatedRoot, 'lock', 'owner.json')));
  const failure = await readJson(path.join(caught.runDirectory, 'private', 'failure-report.json'));
  assert.equal(failure.error_code, 'PROMPT_CONTEXT_BUDGET_EXCEEDED');
  assert.equal(failure.next_model_started, false);
});
