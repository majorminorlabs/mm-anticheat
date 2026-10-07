import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createBlindMapping,
  writeBlindPackage,
  writePrivateMapping
} from './blind.mjs';
import { evaluateArticle, evaluateStructuredStage } from './evaluator.mjs';
import { loadFixtureInput } from './fixture.mjs';
import { runLocalModelLifecycle } from './lifecycle.mjs';
import { requestSizeMetrics } from './metrics.mjs';
import { compilePrompt } from './prompt-builder.mjs';
import {
  assertPromptContextBudget,
  assertPromptSizeReport,
  buildPromptSizeReport,
  contextWindowForModel
} from './prompt-size.mjs';
import { generateRunReports } from './report.mjs';
import {
  parseModelJson,
  sha256,
  stableStringify,
  writeJsonAtomic
} from './util.mjs';

function safeFile(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function previousDraft(raw) {
  const parsed = parseModelJson(raw);
  return parsed.value || { invalid_draft_1_raw: parsed.raw };
}

export class BenchmarkRunner {
  constructor({
    fixtures,
    modelPlans,
    adapterFactory,
    lock,
    generatedRoot,
    configuration,
    productionCoordinator = null,
    coordinateProduction = false,
    official = false
  }) {
    this.fixtures = fixtures;
    this.modelPlans = modelPlans;
    this.adapterFactory = adapterFactory;
    this.lock = lock;
    this.generatedRoot = generatedRoot;
    this.configuration = configuration;
    this.productionCoordinator = productionCoordinator;
    this.coordinateProduction = coordinateProduction;
    this.official = official;
  }

  validatePlan() {
    if (!this.fixtures.length) throw new Error('No approved fixtures were discovered.');
    if (!this.modelPlans.length) throw new Error('No benchmark models are enabled.');
    if (this.official) {
      const real = this.fixtures.filter(item => item.manifest.fixture_kind === 'real' && item.manifest.approval_status === 'approved');
      if (real.length < this.configuration.official_minimum_approved_real_fixtures) {
        throw new Error(`Official benchmark requires at least ${this.configuration.official_minimum_approved_real_fixtures} approved real fixtures; found ${real.length}.`);
      }
      if (!this.coordinateProduction || !this.productionCoordinator) throw new Error('Official benchmark requires explicitly authorized production coordination.');
    }
    if (this.configuration.local_workers !== 1 || this.configuration.cloud_workers !== 1 || this.configuration.automatic_retries !== 0) {
      throw new Error('Benchmark concurrency and retry safety configuration is invalid.');
    }
    if (!Number.isInteger(this.configuration.prompt_context_safety_margin_tokens) || this.configuration.prompt_context_safety_margin_tokens < 1024) {
      throw new Error('Benchmark prompt context safety margin must be at least 1024 tokens.');
    }
    for (const model of this.modelPlans) contextWindowForModel(model, this.configuration);
  }

  plan() {
    this.validatePlan();
    return {
      official: this.official,
      fixture_ids: this.fixtures.map(item => item.manifest.fixture_id),
      fixture_hashes: Object.fromEntries(this.fixtures.map(item => [item.manifest.fixture_id, item.manifest.combined_fixture_hash])),
      models: this.modelPlans.map(model => structuredClone(model)),
      stages: this.configuration.stages,
      sequential: true,
      automatic_retries: 0,
      production_coordination: this.coordinateProduction
    };
  }

  async run() {
    const plan = this.plan();
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
    const runDirectory = path.join(this.generatedRoot, runId);
    await fs.mkdir(path.join(runDirectory, 'private', 'raw'), { recursive: true, mode: 0o700 });
    const planHash = sha256(stableStringify(plan));
    const mapping = createBlindMapping({
      runId,
      fixtureIds: this.fixtures.map(item => item.manifest.fixture_id),
      modelIds: this.modelPlans.map(item => item.id)
    });
    await writePrivateMapping(runDirectory, mapping);
    const runManifest = {
      schema_version: '1.0.0',
      run_id: runId,
      status: 'running',
      started_at: new Date().toISOString(),
      plan,
      plan_hash: planHash,
      prompts: [],
      model_lifecycles: [],
      events: []
    };
    await writeJsonAtomic(path.join(runDirectory, 'private', 'run-manifest.json'), runManifest, { mode: 0o600 });
    let lockAcquired = false;
    let productionRestored = !this.coordinateProduction;
    try {
      runManifest.prompt_size_preflight = await buildPromptSizeReport({
        fixtures: this.fixtures,
        stages: this.configuration.stages,
        models: this.modelPlans,
        configuration: this.configuration
      });
      assertPromptSizeReport(runManifest.prompt_size_preflight);
      await writeJsonAtomic(path.join(runDirectory, 'private', 'run-manifest.json'), runManifest, { mode: 0o600 });
      await this.lock.acquire({ runId, planHash });
      lockAcquired = true;
      if (this.coordinateProduction) {
        const production = await this.productionCoordinator.preflightAndPause();
        runManifest.production_before = production;
      }
      for (const modelPlan of this.modelPlans) {
        await this.lock.assertOwner();
        const adapter = this.adapterFactory(modelPlan);
        if (adapter.kind === 'local') {
          const lifecycle = await runLocalModelLifecycle({
            adapter,
            lock: this.lock,
            events: runManifest.events,
            unloadTimeoutMs: this.configuration.unload_timeout_ms,
            unloadPollMs: this.configuration.unload_poll_ms,
            operation: () => this.runModel({ adapter, modelPlan, runDirectory, mapping, runManifest })
          });
          runManifest.model_lifecycles.push({ model_id: modelPlan.id, ...lifecycle.lifecycle_metrics });
        } else {
          await this.runModel({ adapter, modelPlan, runDirectory, mapping, runManifest });
        }
      }
      if (this.coordinateProduction) {
        runManifest.production_restore = await this.productionCoordinator.restore();
        productionRestored = true;
      }
      runManifest.reports = await generateRunReports(runDirectory);
      runManifest.status = 'completed';
      runManifest.finished_at = new Date().toISOString();
      await writeJsonAtomic(path.join(runDirectory, 'private', 'run-manifest.json'), runManifest, { mode: 0o600 });
      await this.lock.release();
      lockAcquired = false;
      return { runId, runDirectory, manifest: runManifest };
    } catch (error) {
      let restoreError = null;
      if (this.coordinateProduction && !productionRestored) {
        try {
          runManifest.production_restore = await this.productionCoordinator.restore();
          productionRestored = true;
        } catch (caught) {
          restoreError = caught;
        }
      }
      const failure = {
        schema_version: '1.0.0',
        run_id: runId,
        status: restoreError ? 'RESTORE_FAILED' : 'failed',
        failed_at: new Date().toISOString(),
        error: error.message,
        restore_error: restoreError?.message || null,
        error_code: error.code || null,
        error_details: error.details || null,
        events: runManifest.events,
        next_model_started: false
      };
      try {
        runManifest.reports = await generateRunReports(runDirectory);
      } catch {}
      await writeJsonAtomic(path.join(runDirectory, 'private', 'failure-report.json'), failure, { mode: 0o600 });
      runManifest.status = failure.status;
      runManifest.finished_at = new Date().toISOString();
      await writeJsonAtomic(path.join(runDirectory, 'private', 'run-manifest.json'), runManifest, { mode: 0o600 });
      if (lockAcquired && productionRestored && !error.unloadFailed) {
        try {
          await this.lock.release();
          lockAcquired = false;
        } catch {}
      }
      error.runDirectory = runDirectory;
      error.failureReport = failure;
      throw error;
    }
  }

  async runModel({ adapter, modelPlan, runDirectory, mapping, runManifest }) {
    for (const fixtureRecord of this.fixtures) {
      await this.lock.assertOwner();
      const input = await loadFixtureInput(fixtureRecord);
      const stageOutputs = {};
      const evaluations = {};
      const requestMetrics = {};
      for (const stage of this.configuration.stages) {
        await this.lock.assertOwner();
        const priorDraft = ['revision', 'reviewer'].includes(stage) ? previousDraft(stageOutputs.draft.raw) : null;
        const prompt = await compilePrompt({
          stage,
          input,
          priorDraft,
          estimateDivisor: this.configuration.prompt_size_estimate_divisor
        });
        const contextBudget = assertPromptContextBudget({
          promptBytes: prompt.compiled_bytes,
          configuredOutputTokens: this.configuration.maximum_output_tokens,
          safetyMarginTokens: this.configuration.prompt_context_safety_margin_tokens,
          contextWindowTokens: contextWindowForModel(modelPlan, this.configuration),
          estimateDivisor: this.configuration.prompt_size_estimate_divisor
        });
        runManifest.prompts.push({
          model_id: modelPlan.id,
          fixture_id: fixtureRecord.manifest.fixture_id,
          stage,
          compiled_prompt_hash: prompt.compiled_hash,
          compiled_prompt_bytes: prompt.compiled_bytes,
          estimated_prompt_tokens: prompt.estimated_prompt_tokens,
          context_budget: contextBudget,
          contributions: prompt.contributions,
          template_hash: prompt.template_hash,
          publication_doctrine_hash: prompt.publication_doctrine_hash,
          lens_doctrine_hash: prompt.lens_doctrine_hash,
          output_schema_hash: prompt.output_schema_hash
        });
        runManifest.events.push({ event: 'generation_started', model_id: modelPlan.id, fixture_id: fixtureRecord.manifest.fixture_id, stage, at: new Date().toISOString() });
        const response = await adapter.generate({ prompt: prompt.compiled, schema: prompt.output_schema, stage });
        runManifest.events.push({ event: 'generation_completed', model_id: modelPlan.id, fixture_id: fixtureRecord.manifest.fixture_id, stage, at: new Date().toISOString() });
        stageOutputs[stage] = { raw: response.raw };
        requestMetrics[stage] = {
          ...requestSizeMetrics(prompt.compiled, response.raw, this.configuration.prompt_size_estimate_divisor),
          provider_metrics: response.metrics || {}
        };
        if (['draft', 'revision'].includes(stage)) {
          evaluations[stage] = evaluateArticle({
            raw: response.raw,
            manifest: fixtureRecord.manifest,
            schema: prompt.output_schema,
            stage,
            priorDraft: stage === 'revision' ? previousDraft(stageOutputs.draft.raw) : null
          });
          stageOutputs[stage].output = evaluations[stage].article || null;
        } else {
          evaluations[stage] = evaluateStructuredStage({ raw: response.raw, schema: prompt.output_schema, stage });
          stageOutputs[stage].output = evaluations[stage].output;
        }
        await writeJsonAtomic(
          path.join(runDirectory, 'private', 'raw', safeFile(modelPlan.id), fixtureRecord.manifest.fixture_id, `${stage}.json`),
          {
            model_id: modelPlan.id,
            fixture_id: fixtureRecord.manifest.fixture_id,
            stage,
            prompt_hash: prompt.compiled_hash,
            raw_response: response.raw,
            evaluation: evaluations[stage],
            metrics: requestMetrics[stage]
          },
          { mode: 0o600 }
        );
      }
      await writeBlindPackage({
        runDirectory,
        mapping,
        fixture: input,
        modelId: modelPlan.id,
        identityValues: [
          modelPlan.provider,
          modelPlan.adapter,
          modelPlan.tag,
          modelPlan.model,
          adapter.model
        ].filter(value => typeof value === 'string' && value.length > 2),
        outputs: Object.fromEntries(Object.entries(stageOutputs).map(([stage, value]) => [stage, value.output])),
        evaluations
      });
    }
  }
}
