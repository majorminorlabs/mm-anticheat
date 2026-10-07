import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createBlindMapping,
  writeBlindPackage,
  writePrivateMapping
} from './blind.mjs';
import { evaluateArticle, evaluateStructuredStage } from './evaluator.mjs';
import { loadFixtureInput } from './fixture.mjs';
import {
  STAGE_DEPENDENCIES,
  runBenchmarkMetadata,
  validateBenchmarkFreeze
} from './freeze.mjs';
import { runLocalModelLifecycle } from './lifecycle.mjs';
import { memorySnapshot, requestSizeMetrics } from './metrics.mjs';
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

export { STAGE_DEPENDENCIES };

function previousDraft(raw) {
  const parsed = parseModelJson(raw);
  return parsed.value || { invalid_draft_1_raw: parsed.raw };
}

function errorSummary(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    code: error.code || null,
    cause: error.cause && error.cause !== error
      ? {
          name: error.cause.name || 'Error',
          message: error.cause.message || String(error.cause),
          code: error.cause.code || null
        }
      : null
  };
}

function modelStageFailure(error, { elapsedMs, configuredDeadlineMs }) {
  const details = error?.details || null;
  const timeoutLayer = details?.timeout_layer || null;
  const classification = timeoutLayer === 'adapter_deadline'
    ? 'model_generation_timeout'
    : timeoutLayer
      ? 'transport_failure'
      : 'generation_failure';
  return {
    classification,
    reason: error?.message || String(error),
    elapsed_ms: details?.elapsed_ms ?? elapsedMs,
    configured_deadline_ms: details?.configured_timeout_ms ?? configuredDeadlineMs,
    no_retry: true,
    error: errorSummary(error),
    transport_diagnostics: details
  };
}

function invalidResponseFailure(evaluation, { elapsedMs, configuredDeadlineMs }) {
  return {
    classification: 'invalid_model_response',
    reason: evaluation.valid_json === false
      ? 'Model response was not valid JSON.'
      : 'Model response did not match the required output schema.',
    elapsed_ms: elapsedMs,
    configured_deadline_ms: configuredDeadlineMs,
    no_retry: true,
    error: null,
    transport_diagnostics: null,
    evaluation_findings: evaluation.findings || []
  };
}

async function failureMemorySnapshot(adapter) {
  let residents = [];
  let residencyProbeError = null;
  try {
    residents = await adapter.residentModels();
  } catch (error) {
    residencyProbeError = errorSummary(error);
  }
  return {
    ...memorySnapshot('stage_failure', residents),
    residency_probe_error: residencyProbeError
  };
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
    official = false,
    freezeValidator = null
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
    this.freezeValidator = freezeValidator || (() => validateBenchmarkFreeze({
      verifyController: this.official
    }));
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
    for (const [index, stage] of this.configuration.stages.entries()) {
      const dependencies = STAGE_DEPENDENCIES[stage];
      if (!dependencies) throw new Error(`Benchmark stage dependency graph is missing stage: ${stage}`);
      for (const dependency of dependencies) {
        const dependencyIndex = this.configuration.stages.indexOf(dependency);
        if (dependencyIndex < 0 || dependencyIndex >= index) {
          throw new Error(`Benchmark stage dependency order is invalid: ${stage} requires ${dependency}.`);
        }
      }
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
      stage_dependencies: Object.fromEntries(this.configuration.stages.map(stage => [stage, [...STAGE_DEPENDENCIES[stage]]])),
      sequential: true,
      automatic_retries: 0,
      production_coordination: this.coordinateProduction
    };
  }

  async run() {
    const freezeValidation = await this.freezeValidator();
    const plan = this.plan();
    const executionTimestamp = new Date().toISOString();
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
      started_at: executionTimestamp,
      benchmark_metadata: runBenchmarkMetadata({
        validation: freezeValidation,
        modelPlans: this.modelPlans,
        executionTimestamp
      }),
      plan,
      plan_hash: planHash,
      prompts: [],
      model_lifecycles: [],
      events: [],
      stage_results: this.modelPlans.flatMap(model => this.fixtures.flatMap(fixture =>
        this.configuration.stages.map(stage => ({
          model_id: model.id,
          fixture_id: fixture.manifest.fixture_id,
          stage,
          dependencies: [...STAGE_DEPENDENCIES[stage]],
          status: 'not_attempted',
          attempt_count: 0,
          automatic_retries: 0
        }))
      ))
    };
    const manifestFile = path.join(runDirectory, 'private', 'run-manifest.json');
    const persistManifest = () => writeJsonAtomic(manifestFile, runManifest, { mode: 0o600 });
    await persistManifest();
    let lockAcquired = false;
    let primaryError = null;
    let restorationReport = null;
    let productionCoordinationStarted = false;
    try {
      runManifest.prompt_size_preflight = await buildPromptSizeReport({
        fixtures: this.fixtures,
        stages: this.configuration.stages,
        models: this.modelPlans,
        configuration: this.configuration
      });
      assertPromptSizeReport(runManifest.prompt_size_preflight);
      await persistManifest();
      await this.lock.acquire({ runId, planHash });
      lockAcquired = true;
      if (this.coordinateProduction) {
        productionCoordinationStarted = true;
        const production = await this.productionCoordinator.preflightAndPause();
        runManifest.production_before = production;
      }
      for (const modelPlan of this.modelPlans) {
        await this.lock.assertOwner();
        const adapter = this.adapterFactory(modelPlan);
        if (adapter.kind === 'local') {
          const lifecycleEntry = { model_id: modelPlan.id };
          runManifest.model_lifecycles.push(lifecycleEntry);
          try {
            const lifecycle = await runLocalModelLifecycle({
              adapter,
              lock: this.lock,
              events: runManifest.events,
              unloadTimeoutMs: this.configuration.unload_timeout_ms,
              unloadPollMs: this.configuration.unload_poll_ms,
              onMetrics: async metrics => {
                Object.assign(lifecycleEntry, metrics);
                await persistManifest();
              },
              operation: () => this.runModel({
                adapter,
                modelPlan,
                runDirectory,
                mapping,
                runManifest,
                lifecycleMetrics: lifecycleEntry,
                persistManifest
              })
            });
            Object.assign(lifecycleEntry, lifecycle.lifecycle_metrics);
          } catch (error) {
            if (error.lifecycle_metrics) Object.assign(lifecycleEntry, error.lifecycle_metrics);
            throw error;
          }
        } else {
          await this.runModel({ adapter, modelPlan, runDirectory, mapping, runManifest, persistManifest });
        }
      }
    } catch (error) {
      primaryError = error;
    } finally {
      const coordinatorHasSnapshot = this.productionCoordinator
        && (!Object.hasOwn(this.productionCoordinator, 'snapshot') || this.productionCoordinator.snapshot);
      if (this.coordinateProduction && productionCoordinationStarted && coordinatorHasSnapshot) {
        runManifest.production_before ||= this.productionCoordinator.snapshot;
        try {
          restorationReport = await this.productionCoordinator.restore();
          restorationReport.steps ||= [];
          restorationReport.failures ||= [];
        } catch (caught) {
          restorationReport = {
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            status: 'RESTORE_FAILED',
            steps: [],
            failures: [{
              step: 'production_restoration_internal',
              error: caught.message,
              error_code: caught.code || null,
              error_details: caught.details || null
            }]
          };
        }
      }

      if (!restorationReport && lockAcquired) {
        restorationReport = {
          started_at: new Date().toISOString(),
          steps: [],
          failures: []
        };
      }
      if (lockAcquired) {
        const startedAt = new Date().toISOString();
        try {
          await this.lock.release();
          lockAcquired = false;
          restorationReport.steps.push({
            step: 'release_benchmark_lock',
            status: 'ok',
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            verified: true
          });
        } catch (error) {
          restorationReport.failures.push({
            step: 'release_benchmark_lock',
            error: error.message,
            error_code: error.code || null,
            error_details: error.details || null
          });
          restorationReport.steps.push({
            step: 'release_benchmark_lock',
            status: 'failed',
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            error: error.message,
            error_code: error.code || null,
            error_details: error.details || null
          });
        }
      }
      if (restorationReport) {
        restorationReport.finished_at = new Date().toISOString();
        restorationReport.status = restorationReport.failures.length ? 'RESTORE_FAILED' : 'restored';
        runManifest.production_restore = restorationReport;
      }
    }

    const restorationFailures = restorationReport?.failures || [];
    if (!primaryError && restorationFailures.length === 0) {
      try {
        runManifest.reports = await generateRunReports(runDirectory, { stageResults: runManifest.stage_results });
        runManifest.status = runManifest.stage_results.some(item => item.status === 'failed')
          ? 'completed_with_failures'
          : 'completed';
        runManifest.finished_at = new Date().toISOString();
        await persistManifest();
        return { runId, runDirectory, manifest: runManifest };
      } catch (error) {
        primaryError = error;
      }
    }

    const failure = {
      schema_version: '1.0.0',
      run_id: runId,
      status: restorationFailures.length ? 'RESTORE_FAILED' : 'failed',
      failed_at: new Date().toISOString(),
      error: primaryError?.message || 'Benchmark restoration failed.',
      error_name: primaryError?.name || null,
      error_cause: errorSummary(primaryError?.cause),
      restore_error: restorationFailures.length
        ? restorationFailures.map(item => `${item.step}: ${item.error}`).join('; ')
        : null,
      restoration_failures: restorationFailures,
      error_code: primaryError?.code || null,
      error_details: primaryError?.details || null,
      events: runManifest.events,
      aborted_before_generation: !runManifest.events.some(item => item.event === 'generation_started'),
      next_model_started: false
    };
    try {
      runManifest.reports = await generateRunReports(runDirectory, { stageResults: runManifest.stage_results });
    } catch {}
    await writeJsonAtomic(path.join(runDirectory, 'private', 'failure-report.json'), failure, { mode: 0o600 });
    runManifest.status = failure.status;
    runManifest.aborted_before_generation = failure.aborted_before_generation;
    runManifest.finished_at = new Date().toISOString();
    await persistManifest();
    const outputError = primaryError || new Error(failure.restore_error || failure.error);
    outputError.runDirectory = runDirectory;
    outputError.failureReport = failure;
    throw outputError;
  }

  async runModel({
    adapter,
    modelPlan,
    runDirectory,
    mapping,
    runManifest,
    lifecycleMetrics = null,
    persistManifest = async () => {}
  }) {
    for (const fixtureRecord of this.fixtures) {
      await this.lock.assertOwner();
      const input = await loadFixtureInput(fixtureRecord);
      const stageOutputs = {};
      const evaluations = {};
      const fixtureStageResults = runManifest.stage_results.filter(item =>
        item.model_id === modelPlan.id && item.fixture_id === fixtureRecord.manifest.fixture_id
      );
      for (const stage of this.configuration.stages) {
        await this.lock.assertOwner();
        const stageResult = fixtureStageResults.find(item => item.stage === stage);
        if (!stageResult) throw new Error(`Stage result record is missing for ${modelPlan.id}/${fixtureRecord.manifest.fixture_id}/${stage}.`);
        const unavailableDependencies = STAGE_DEPENDENCIES[stage].filter(dependency => {
          const dependencyResult = fixtureStageResults.find(item => item.stage === dependency);
          return dependencyResult?.status !== 'completed';
        });
        if (unavailableDependencies.length) {
          Object.assign(stageResult, {
            status: 'skipped_dependency',
            unavailable_dependencies: unavailableDependencies,
            reason: `Required stage output unavailable: ${unavailableDependencies.join(', ')}.`,
            finished_at: new Date().toISOString()
          });
          runManifest.events.push({
            event: 'generation_skipped_dependency',
            model_id: modelPlan.id,
            fixture_id: fixtureRecord.manifest.fixture_id,
            stage,
            unavailable_dependencies: unavailableDependencies,
            at: stageResult.finished_at
          });
          await persistManifest();
          continue;
        }

        const priorDraft = STAGE_DEPENDENCIES[stage].includes('draft')
          ? previousDraft(stageOutputs.draft.raw)
          : null;
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
        const startedAt = new Date().toISOString();
        const generationStarted = performance.now();
        Object.assign(stageResult, {
          status: 'not_attempted',
          attempt_count: 1,
          prompt_hash: prompt.compiled_hash,
          started_at: startedAt
        });
        runManifest.events.push({
          event: 'generation_started',
          model_id: modelPlan.id,
          fixture_id: fixtureRecord.manifest.fixture_id,
          stage,
          attempt: 1,
          at: startedAt
        });
        await persistManifest();

        let response;
        try {
          response = await adapter.generate({ prompt: prompt.compiled, schema: prompt.output_schema, stage });
        } catch (error) {
          const observedElapsedMs = performance.now() - generationStarted;
          const failure = modelStageFailure(error, {
            elapsedMs: observedElapsedMs,
            configuredDeadlineMs: this.configuration.request_timeout_ms
          });
          const memoryAtFailure = await failureMemorySnapshot(adapter);
          failure.lifecycle_metrics_available = {
            model_lifecycle: lifecycleMetrics ? structuredClone(lifecycleMetrics) : null,
            memory_at_failure: memoryAtFailure
          };
          const metrics = {
            ...requestSizeMetrics(prompt.compiled, '', this.configuration.prompt_size_estimate_divisor),
            provider_metrics: {
              wall_ms: failure.elapsed_ms,
              failure: {
                classification: failure.classification,
                configured_deadline_ms: failure.configured_deadline_ms,
                transport_diagnostics: failure.transport_diagnostics
              }
            }
          };
          const finishedAt = new Date().toISOString();
          Object.assign(stageResult, {
            status: 'failed',
            failure,
            elapsed_ms: failure.elapsed_ms,
            configured_deadline_ms: failure.configured_deadline_ms,
            finished_at: finishedAt
          });
          await writeJsonAtomic(
            path.join(runDirectory, 'private', 'raw', safeFile(modelPlan.id), fixtureRecord.manifest.fixture_id, `${stage}.json`),
            {
              model_id: modelPlan.id,
              fixture_id: fixtureRecord.manifest.fixture_id,
              stage,
              status: 'failed',
              prompt_hash: prompt.compiled_hash,
              raw_response: null,
              raw_error: failure.error,
              failure,
              evaluation: null,
              metrics
            },
            { mode: 0o600 }
          );
          runManifest.events.push({
            event: 'generation_failed',
            model_id: modelPlan.id,
            fixture_id: fixtureRecord.manifest.fixture_id,
            stage,
            classification: failure.classification,
            attempt: 1,
            at: finishedAt
          });
          await persistManifest();
          continue;
        }

        const observedElapsedMs = performance.now() - generationStarted;
        const requestMetrics = {
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
        } else {
          evaluations[stage] = evaluateStructuredStage({ raw: response.raw, schema: prompt.output_schema, stage });
        }
        const modelResponseValid = evaluations[stage].valid_json !== false && evaluations[stage].schema_valid !== false;
        const finishedAt = new Date().toISOString();
        let failure = null;
        if (modelResponseValid) {
          stageOutputs[stage] = {
            raw: response.raw,
            output: ['draft', 'revision'].includes(stage)
              ? evaluations[stage].article
              : evaluations[stage].output
          };
          Object.assign(stageResult, {
            status: 'completed',
            elapsed_ms: response.metrics?.wall_ms ?? observedElapsedMs,
            finished_at: finishedAt
          });
          runManifest.events.push({
            event: 'generation_completed',
            model_id: modelPlan.id,
            fixture_id: fixtureRecord.manifest.fixture_id,
            stage,
            attempt: 1,
            at: finishedAt
          });
        } else {
          failure = invalidResponseFailure(evaluations[stage], {
            elapsedMs: response.metrics?.wall_ms ?? observedElapsedMs,
            configuredDeadlineMs: this.configuration.request_timeout_ms
          });
          Object.assign(stageResult, {
            status: 'failed',
            failure,
            elapsed_ms: failure.elapsed_ms,
            configured_deadline_ms: failure.configured_deadline_ms,
            finished_at: finishedAt
          });
          runManifest.events.push({
            event: 'generation_failed',
            model_id: modelPlan.id,
            fixture_id: fixtureRecord.manifest.fixture_id,
            stage,
            classification: failure.classification,
            attempt: 1,
            at: finishedAt
          });
        }
        await writeJsonAtomic(
          path.join(runDirectory, 'private', 'raw', safeFile(modelPlan.id), fixtureRecord.manifest.fixture_id, `${stage}.json`),
          {
            model_id: modelPlan.id,
            fixture_id: fixtureRecord.manifest.fixture_id,
            stage,
            status: modelResponseValid ? 'completed' : 'failed',
            prompt_hash: prompt.compiled_hash,
            raw_response: response.raw,
            failure,
            evaluation: evaluations[stage],
            metrics: requestMetrics
          },
          { mode: 0o600 }
        );
        await persistManifest();
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
        evaluations,
        stageResults: fixtureStageResults
      });
      await persistManifest();
    }
  }
}
