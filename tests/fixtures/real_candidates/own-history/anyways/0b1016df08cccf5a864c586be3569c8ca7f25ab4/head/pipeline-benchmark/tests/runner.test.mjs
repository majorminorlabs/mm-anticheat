import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StubBenchmarkAdapter } from '../src/adapters/stub.mjs';
import { BenchmarkLock } from '../src/lock.mjs';
import { OllamaTransportError } from '../src/ollama-transport.mjs';
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
  assert.deepEqual(result.manifest.plan.stage_dependencies, {
    draft: [],
    revision: ['draft'],
    reviewer: ['draft'],
    evidence_selector: [],
    research_planner: []
  });
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

test('run manifest records frozen benchmark and model metadata without leaking it into blind packages', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-metadata-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const modelPlan = {
    id: 'private-model-identifier',
    provider: 'private-provider',
    expected_digest_prefix: 'd'.repeat(64)
  };
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [modelPlan],
    adapterFactory: model => new StubBenchmarkAdapter({
      model: model.id,
      responses: validStubResponses()
    }),
    lock: new BenchmarkLock(path.join(generatedRoot, 'lock')),
    generatedRoot,
    configuration: await runnerConfiguration(),
    freezeValidator: async () => ({
      benchmark_version: '1.0',
      benchmark_manifest_hash: 'a'.repeat(64),
      benchmark_repository_commit: 'b'.repeat(40),
      benchmark_repository_dirty: false,
      controller_repository_commit: null,
      controller_repository_tree_hash: 'c'.repeat(64)
    })
  });
  const result = await runner.run();
  assert.equal(result.manifest.benchmark_metadata.benchmark_version, '1.0');
  assert.equal(result.manifest.benchmark_metadata.benchmark_manifest_hash, 'a'.repeat(64));
  assert.equal(result.manifest.benchmark_metadata.benchmark_repository_commit, 'b'.repeat(40));
  assert.equal(result.manifest.benchmark_metadata.controller_repository_commit, null);
  assert.deepEqual(result.manifest.benchmark_metadata.models, [{
    model_identifier: modelPlan.id,
    provider: modelPlan.provider,
    model_digest: modelPlan.expected_digest_prefix
  }]);
  assert.match(result.manifest.benchmark_metadata.execution_timestamp, /^\d{4}-\d{2}-\d{2}T/);

  const packageFile = path.join(
    result.runDirectory,
    'review',
    'packages',
    workspace.fixture.manifest.fixture_id,
    'candidate-a',
    'review-package.json'
  );
  const packageText = await fs.readFile(packageFile, 'utf8');
  assert.doesNotMatch(packageText, /benchmark_metadata|benchmark_manifest_hash|benchmark_repository_commit/);
  assert.doesNotMatch(packageText, /private-model-identifier|private-provider|dddddddd/);
});

test('model-stage failure is recorded, later models continue, and no retry occurs', async t => {
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
  const result = await runner.run();
  assert.equal(result.manifest.status, 'completed_with_failures');
  assert.ok(events.includes('unload:model-a'));
  assert.equal(events.includes('load:model-b'), true);
  assert.equal(events.filter(item => item === 'generate:model-a:reviewer:1').length, 1);
  assert.equal(events.includes('generate:model-a:research_planner:1'), true);
  assert.deepEqual(await new StubBenchmarkAdapter().residentModels(), []);
  const reviewer = result.manifest.stage_results.find(item => item.model_id === 'model-a' && item.stage === 'reviewer');
  assert.equal(reviewer.status, 'failed');
  assert.equal(reviewer.failure.classification, 'generation_failure');
  assert.equal(result.manifest.reports.stage_status_counts.failed, 1);
  assert.equal(result.manifest.reports.stage_status_counts.completed, 9);
  await assert.rejects(() => fs.access(path.join(result.runDirectory, 'private', 'failure-report.json')));
});

test('unload failure stops the run but still releases the benchmark lock', async t => {
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
  let caught;
  try { await runner.run(); } catch (error) { caught = error; }
  assert.match(caught?.message || '', /unload/);
  assert.equal(events.includes('load:model-b'), false);
  await assert.rejects(() => fs.access(path.join(lockPath, 'owner.json')));
  const failure = await readJson(path.join(caught.runDirectory, 'private', 'failure-report.json'));
  assert.equal(failure.status, 'failed');
  const manifest = await readJson(path.join(caught.runDirectory, 'private', 'run-manifest.json'));
  assert.ok(manifest.model_lifecycles[0].before_load);
  assert.ok(manifest.model_lifecycles[0].after_load);
});

test('production coordination restores fully after a model-stage failure', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-restore-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const productionEvents = [];
  const productionCoordinator = {
    snapshot: null,
    async preflightAndPause() {
      productionEvents.push('record');
      productionEvents.push('pause');
      this.snapshot = { controller: { running: true }, resident_models: [] };
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
  const result = await runner.run();
  assert.equal(result.manifest.status, 'completed_with_failures');
  assert.equal(
    result.manifest.stage_results.find(item => item.stage === 'research_planner').status,
    'completed'
  );
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

test('independent stage timeout preserves diagnostics and later independent stage continues', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-transport-failure-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const generationCalls = {};
  class TransportFailingAdapter extends StubBenchmarkAdapter {
    async generate(options) {
      generationCalls[options.stage] = (generationCalls[options.stage] || 0) + 1;
      if (options.stage !== 'evidence_selector') return super.generate(options);
      throw new OllamaTransportError('Ollama generation:evidence_selector request failed at adapter_deadline', {
        cause: new DOMException('Configured benchmark timeout of 600000ms exceeded.', 'TimeoutError'),
        details: {
          timeout_layer: 'adapter_deadline',
          configured_timeout_ms: 600000,
          elapsed_ms: 600005,
          request_url: 'http://127.0.0.1:11434/api/generate',
          headers_received: false,
          response_body_began: false,
          ollama_reachable_after_failure: true,
          current_ollama_residency: [{ model: 'qwen3:14b' }]
        }
      });
    }
  }
  const productionEvents = [];
  const productionCoordinator = {
    snapshot: null,
    async preflightAndPause() {
      this.snapshot = { controller: { running: true }, resident_models: [] };
      return this.snapshot;
    },
    async restore() {
      productionEvents.push('restore');
      return { status: 'restored', steps: [], failures: [] };
    }
  };
  const lockPath = path.join(generatedRoot, 'lock');
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'model-a' }],
    adapterFactory: model => new TransportFailingAdapter({ model: model.id }),
    lock: new BenchmarkLock(lockPath),
    generatedRoot,
    configuration: await runnerConfiguration(),
    coordinateProduction: true,
    productionCoordinator
  });
  const result = await runner.run();
  assert.equal(result.manifest.status, 'completed_with_failures');
  assert.equal(generationCalls.evidence_selector, 1);
  assert.equal(generationCalls.research_planner, 1);
  assert.deepEqual(productionEvents, ['restore']);
  await assert.rejects(() => fs.access(path.join(lockPath, 'owner.json')));
  const failedStage = result.manifest.stage_results.find(item => item.stage === 'evidence_selector');
  assert.equal(failedStage.status, 'failed');
  assert.equal(failedStage.failure.classification, 'model_generation_timeout');
  assert.equal(failedStage.failure.transport_diagnostics.timeout_layer, 'adapter_deadline');
  assert.equal(failedStage.failure.configured_deadline_ms, 600000);
  assert.equal(failedStage.failure.elapsed_ms, 600005);
  const rawFailure = await readJson(path.join(
    result.runDirectory,
    'private',
    'raw',
    'model-a',
    'synthetic-fixture',
    'evidence_selector.json'
  ));
  assert.equal(rawFailure.status, 'failed');
  assert.equal(rawFailure.raw_response, null);
  assert.equal(rawFailure.raw_error.name, 'OllamaTransportError');
  assert.equal(rawFailure.failure.transport_diagnostics.ollama_reachable_after_failure, true);
  assert.ok(rawFailure.failure.lifecycle_metrics_available.memory_at_failure.total_memory_bytes > 0);
  const lifecycle = result.manifest.model_lifecycles[0];
  assert.ok(lifecycle.before_load);
  assert.ok(lifecycle.after_load);
  assert.ok(lifecycle.after_unload);
});

test('failed Draft skips Revision and Reviewer while independent probes run and partial package stays blind', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-draft-dependency-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const events = [];
  const secretModelId = 'secret-model-qwen3-14b';
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: secretModelId, provider: 'secret-provider', adapter: 'secret-adapter' }],
    adapterFactory: model => new StubBenchmarkAdapter({
      model: model.id,
      events,
      responses: validStubResponses(),
      failAt: 'draft'
    }),
    lock: new BenchmarkLock(path.join(generatedRoot, 'lock')),
    generatedRoot,
    configuration: await runnerConfiguration()
  });
  const result = await runner.run();
  assert.equal(result.manifest.status, 'completed_with_failures');
  const statuses = Object.fromEntries(result.manifest.stage_results.map(item => [item.stage, item.status]));
  assert.deepEqual(statuses, {
    draft: 'failed',
    revision: 'skipped_dependency',
    reviewer: 'skipped_dependency',
    evidence_selector: 'completed',
    research_planner: 'completed'
  });
  assert.equal(events.filter(item => item === `generate:${secretModelId}:draft:1`).length, 1);
  assert.equal(events.some(item => item.includes(':revision:')), false);
  assert.equal(events.some(item => item.includes(':reviewer:')), false);
  assert.equal(events.includes(`generate:${secretModelId}:evidence_selector:1`), true);
  assert.equal(events.includes(`generate:${secretModelId}:research_planner:1`), true);

  const packageFile = path.join(
    result.runDirectory,
    'review',
    'packages',
    'synthetic-fixture',
    'candidate-a',
    'review-package.json'
  );
  const packageText = await fs.readFile(packageFile, 'utf8');
  assert.doesNotMatch(packageText, /secret-model|qwen3|secret-provider|secret-adapter|model_id/i);
  const reviewPackage = JSON.parse(packageText);
  assert.deepEqual(reviewPackage.candidate_summary.completed_stages, ['evidence_selector', 'research_planner']);
  assert.equal(reviewPackage.candidate_summary.failed_stages[0].stage, 'draft');
  assert.equal(reviewPackage.candidate_summary.failed_stages[0].no_retry, true);
  assert.deepEqual(
    reviewPackage.candidate_summary.dependency_skipped_stages.map(item => item.stage),
    ['revision', 'reviewer']
  );
  assert.equal(reviewPackage.candidate_summary.no_substitute_output, true);
  assert.equal('draft' in reviewPackage.outputs, false);
  assert.equal('revision' in reviewPackage.outputs, false);
  assert.equal('reviewer' in reviewPackage.outputs, false);
  assert.ok(reviewPackage.outputs.evidence_selector);
  assert.ok(reviewPackage.outputs.research_planner);
  assert.ok(result.manifest.model_lifecycles[0].before_load);
  assert.ok(result.manifest.model_lifecycles[0].after_load);
  assert.ok(result.manifest.model_lifecycles[0].after_unload);
});

test('invalid model response is a failed stage result and its dependent stages skip', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-invalid-response-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const responses = validStubResponses();
  responses.draft = { definitely_not: 'the article schema' };
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'model-a' }],
    adapterFactory: model => new StubBenchmarkAdapter({ model: model.id, responses }),
    lock: new BenchmarkLock(path.join(generatedRoot, 'lock')),
    generatedRoot,
    configuration: await runnerConfiguration()
  });
  const result = await runner.run();
  const draft = result.manifest.stage_results.find(item => item.stage === 'draft');
  assert.equal(result.manifest.status, 'completed_with_failures');
  assert.equal(draft.status, 'failed');
  assert.equal(draft.failure.classification, 'invalid_model_response');
  assert.equal(result.manifest.stage_results.find(item => item.stage === 'revision').status, 'skipped_dependency');
  assert.equal(result.manifest.stage_results.find(item => item.stage === 'reviewer').status, 'skipped_dependency');
  assert.equal(result.manifest.stage_results.find(item => item.stage === 'evidence_selector').status, 'completed');
  assert.equal(result.manifest.stage_results.find(item => item.stage === 'research_planner').status, 'completed');
  const raw = await readJson(path.join(
    result.runDirectory,
    'private',
    'raw',
    'model-a',
    'synthetic-fixture',
    'draft.json'
  ));
  assert.equal(raw.status, 'failed');
  assert.equal(raw.failure.classification, 'invalid_model_response');
  assert.ok(raw.raw_response);
  assert.equal(raw.evaluation.schema_valid, false);
});

test('runner releases the lock after an aggregated production restoration failure', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-restore-failure-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const lockPath = path.join(generatedRoot, 'lock');
  const events = [];
  const productionCoordinator = {
    snapshot: null,
    async preflightAndPause() {
      this.snapshot = { controller: { running: true }, resident_models: [] };
      return this.snapshot;
    },
    async restore() {
      events.push('smoke-failed', 'residency-attempted', 'controller-attempted', 'health-attempted');
      return {
        status: 'RESTORE_FAILED',
        steps: [
          { step: 'production_model_smoke', status: 'failed' },
          { step: 'restore_ollama_residency', status: 'ok' },
          { step: 'restore_controller_state', status: 'ok' }
        ],
        failures: [{ step: 'production_model_smoke', error: 'Injected smoke failure' }]
      };
    }
  };
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'model-a' }],
    adapterFactory: model => new StubBenchmarkAdapter({
      model: model.id,
      responses: validStubResponses(),
      failAt: 'draft'
    }),
    lock: new BenchmarkLock(lockPath),
    generatedRoot,
    configuration: await runnerConfiguration(),
    coordinateProduction: true,
    productionCoordinator
  });
  let caught;
  try { await runner.run(); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.deepEqual(events, ['smoke-failed', 'residency-attempted', 'controller-attempted', 'health-attempted']);
  await assert.rejects(() => fs.access(path.join(lockPath, 'owner.json')));
  const failure = await readJson(path.join(caught.runDirectory, 'private', 'failure-report.json'));
  assert.equal(failure.status, 'RESTORE_FAILED');
  assert.equal(failure.restoration_failures[0].step, 'production_model_smoke');
});

test('runner reports lock-release failure after attempting production restoration', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-lock-release-failure-'));
  const realLock = new BenchmarkLock(path.join(generatedRoot, 'lock'));
  let releaseCalls = 0;
  const lock = {
    acquire: options => realLock.acquire(options),
    assertOwner: () => realLock.assertOwner(),
    async release() {
      releaseCalls++;
      throw new Error('Injected lock release failure');
    }
  };
  t.after(async () => {
    if (realLock.ownerToken) await realLock.release();
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const productionEvents = [];
  const productionCoordinator = {
    snapshot: null,
    async preflightAndPause() {
      this.snapshot = { controller: { running: true }, resident_models: [] };
      return this.snapshot;
    },
    async restore() {
      productionEvents.push('restoration-attempted');
      return { status: 'restored', steps: [], failures: [] };
    }
  };
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'model-a' }],
    adapterFactory: model => new StubBenchmarkAdapter({
      model: model.id,
      responses: validStubResponses(),
      failAt: 'draft'
    }),
    lock,
    generatedRoot,
    configuration: await runnerConfiguration(),
    coordinateProduction: true,
    productionCoordinator
  });
  let caught;
  try { await runner.run(); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(productionEvents, ['restoration-attempted']);
  const failure = await readJson(path.join(caught.runDirectory, 'private', 'failure-report.json'));
  assert.equal(failure.status, 'RESTORE_FAILED');
  assert.ok(failure.restoration_failures.some(item => item.step === 'release_benchmark_lock'));
});

test('preflight failure before production state is recorded releases the lock without running restoration', async t => {
  StubBenchmarkAdapter.reset();
  const workspace = await syntheticWorkspace();
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-runner-preflight-record-failure-'));
  t.after(async () => {
    await workspace.cleanup();
    await fs.rm(generatedRoot, { recursive: true, force: true });
  });
  const lockPath = path.join(generatedRoot, 'lock');
  let restoreCalls = 0;
  const productionCoordinator = {
    snapshot: null,
    async preflightAndPause() {
      throw new Error('Injected production state probe failure');
    },
    async restore() {
      restoreCalls++;
      return { status: 'restored', steps: [], failures: [] };
    }
  };
  const runner = new BenchmarkRunner({
    fixtures: [workspace.fixture],
    modelPlans: [{ id: 'model-a' }],
    adapterFactory: model => new StubBenchmarkAdapter({ model: model.id, responses: validStubResponses() }),
    lock: new BenchmarkLock(lockPath),
    generatedRoot,
    configuration: await runnerConfiguration(),
    coordinateProduction: true,
    productionCoordinator
  });
  await assert.rejects(() => runner.run(), /production state probe failure/);
  assert.equal(restoreCalls, 0);
  await assert.rejects(() => fs.access(path.join(lockPath, 'owner.json')));
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
  const manifest = await readJson(path.join(caught.runDirectory, 'private', 'run-manifest.json'));
  assert.ok(manifest.stage_results.every(item => item.status === 'not_attempted'));
});
