#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { OllamaBenchmarkAdapter } from './adapters/ollama.mjs';
import { KimiCodeBenchmarkAdapter } from './adapters/kimi-code.mjs';
import { StubBenchmarkAdapter } from './adapters/stub.mjs';
import { discoverFixtures, freezeFixture } from './fixture.mjs';
import { validateBenchmarkFreeze } from './freeze.mjs';
import { BenchmarkLock } from './lock.mjs';
import { packageAppleFixture } from './package-apple.mjs';
import {
  assertPromptSizeReport,
  buildPromptSizeReport,
  formatPromptSizeReport
} from './prompt-size.mjs';
import {
  OllamaProductionModelSystem,
  ProductionCoordinator,
  launchctlControllerControl
} from './production.mjs';
import { BenchmarkRunner } from './runner.mjs';
import { BENCHMARK_ROOT, REPO_ROOT, readJson } from './util.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const after = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const configuration = await readJson(path.join(BENCHMARK_ROOT, 'config', 'benchmark.json'));
const modelConfiguration = await readJson(path.join(BENCHMARK_ROOT, 'config', 'models.json'));
const fixtureRoot = path.resolve(REPO_ROOT, configuration.fixture_root);
const generatedRoot = path.resolve(REPO_ROOT, configuration.generated_root);
const lockPath = path.resolve(REPO_ROOT, configuration.lock_path);

function demoArticle(manifest) {
  const firstSource = manifest.source_inventory[0]?.source_id || 'synthetic-source-1';
  return {
    headline: manifest.headline,
    dek: 'A deterministic stub response used only to test benchmark plumbing.',
    editorial_section: manifest.taxonomy.editorial_section,
    lens: manifest.taxonomy.lens,
    beat: manifest.taxonomy.beat,
    body_markdown: [
      'Apple says Apple Upgrade customers who miss payments will not face Restricted Mode or limits on device functionality. The specific promise separates device access from the financial consequences of a lease.',
      'Reporting on iOS 27 found App Managed Features and financing restrictions in beta code. The packet does not establish that Apple built those controls for Upgrade, and their intended use remains unresolved.',
      'Klarna says three consecutive missed payments can terminate the lease and leave the full outstanding balance due. That contract consequence remains even though Apple says the device itself will not be restricted.',
      'The distinction matters because a phone connects people to work, money, health information, and daily communication. The stored packet lacks a clearly identified primary document, so conclusions about scale and future use require restraint.',
      'This stub paragraph adds neutral length for lifecycle testing. It is not a benchmark result and is never used to compare a model. The demonstration checks sequencing, hashing, evaluation, blinding, unloading, and failure behavior only.'
    ].join('\n\n'),
    source_ids_used: [firstSource]
  };
}

function stubResponses(manifest) {
  return {
    draft: demoArticle(manifest),
    revision: demoArticle(manifest),
    reviewer: { summary: 'Synthetic stub review.', findings: [] },
    evidence_selector: { selections: manifest.source_inventory.slice(0, 1).map(source => ({ source_id: source.source_id, claim_ids: [], classification: 'must-use', reason: 'Synthetic stub selection.' })) },
    research_planner: {
      missing_questions: ['Synthetic missing question.'],
      source_classes: ['Synthetic source class.'],
      verification_steps: ['Synthetic verification step.'],
      stop_conditions: ['Synthetic stop condition.']
    }
  };
}

async function commandJson(command, label) {
  if (!command) throw new Error(`${label} command is required.`);
  const [executable, ...commandArgs] = JSON.parse(command);
  const { stdout } = await execFileAsync(executable, commandArgs, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

async function realRunner({ fixtures, selectedModels, official }) {
  if (!official || !has('--allow-real-models') || !has('--allow-production-pause')) {
    throw new Error('Real execution requires --official --allow-real-models --allow-production-pause.');
  }
  if (selectedModels.some(model => model.provider === 'kimi-code') && !has('--allow-paid-cloud')) {
    throw new Error('Kimi candidates require separate --allow-paid-cloud authorization.');
  }
  const plist = process.env.ANYWAYS_BENCHMARK_CONTROLLER_PLIST;
  const queueCommand = process.env.ANYWAYS_BENCHMARK_QUEUE_PROBE_COMMAND;
  const smokeCommand = process.env.ANYWAYS_BENCHMARK_SMOKE_COMMAND;
  if (!plist || !queueCommand || !smokeCommand) {
    throw new Error('Official execution requires controller plist, read-only queue probe command, and production-path smoke command configuration.');
  }
  const modelSystem = new OllamaProductionModelSystem({ baseUrl: configuration.ollama_url });
  const productionCoordinator = new ProductionCoordinator({
    authorized: true,
    acceptableHealth: configuration.acceptable_controller_health,
    baselineModel: configuration.baseline_model,
    baselineDigestPrefix: configuration.baseline_digest,
    restoreHealthTimeoutMs: configuration.production_coordination.restore_health_timeout_ms,
    restoreHealthPollMs: configuration.production_coordination.restore_health_poll_ms,
    healthProbe: async () => {
      const response = await fetch(configuration.controller_health_url);
      if (!response.ok) throw new Error(`Controller health returned ${response.status}.`);
      return response.json();
    },
    queueProbe: () => commandJson(queueCommand, 'Queue probe'),
    productionSmoke: () => commandJson(smokeCommand, 'Production smoke'),
    controllerControl: launchctlControllerControl({
      label: configuration.production_coordination.launch_agent_label,
      plist,
      port: configuration.production_coordination.controller_listener_port,
      pauseTimeoutMs: configuration.production_coordination.pause_timeout_ms,
      pausePollMs: configuration.production_coordination.pause_poll_ms
    }),
    modelSystem
  });
  return new BenchmarkRunner({
    fixtures,
    modelPlans: selectedModels,
    lock: new BenchmarkLock(lockPath),
    generatedRoot,
    configuration,
    official,
    coordinateProduction: true,
    productionCoordinator,
    adapterFactory: model => model.adapter === 'ollama'
      ? new OllamaBenchmarkAdapter({
        model: model.tag,
        baseUrl: configuration.ollama_url,
        expectedDigestPrefix: model.expected_digest_prefix,
        contextTokens: model.context_window_tokens,
        maximumOutputTokens: configuration.maximum_output_tokens,
        temperature: configuration.temperature,
        seed: configuration.seed,
        timeoutMs: configuration.request_timeout_ms,
        connectTimeoutMs: configuration.ollama_connect_timeout_ms,
        allowRealGeneration: true
      })
      : new KimiCodeBenchmarkAdapter({
        model: model.model,
        timeoutMs: configuration.request_timeout_ms,
        allowPaidGeneration: true
      })
  });
}

async function main() {
  const [area, action] = args;
  if (area === 'fixtures' && action === 'package-apple') {
    const manifest = await packageAppleFixture({ force: has('--replace') });
    console.log(JSON.stringify({ fixture_id: manifest.fixture_id, combined_fixture_hash: manifest.combined_fixture_hash, input_count: Object.keys(manifest.frozen_inputs).length }, null, 2));
    return;
  }
  if (area === 'fixtures' && action === 'freeze') {
    const directory = args[2];
    if (!directory) throw new Error('fixtures freeze requires a fixture directory.');
    const manifest = await freezeFixture(directory, { allowApprovedRewrite: has('--replace-approved') });
    console.log(JSON.stringify({ fixture_id: manifest.fixture_id, combined_fixture_hash: manifest.combined_fixture_hash }, null, 2));
    return;
  }
  if (area === 'fixtures' && action === 'validate') {
    const freeze = await validateBenchmarkFreeze();
    const fixtures = await discoverFixtures({ root: fixtureRoot, approvalStatus: null });
    console.log(JSON.stringify({
      benchmark_version: freeze.benchmark_version,
      benchmark_manifest_hash: freeze.benchmark_manifest_hash,
      freeze_validation: 'passed'
    }, null, 2));
    console.log(JSON.stringify(fixtures.map(item => ({
      fixture_id: item.manifest.fixture_id,
      fixture_kind: item.manifest.fixture_kind,
      approval_status: item.manifest.approval_status,
      combined_fixture_hash: item.manifest.combined_fixture_hash,
      source_count: item.manifest.source_inventory.length
    })), null, 2));
    const approved = fixtures.filter(item => item.manifest.approval_status === 'approved');
    const enabledModels = modelConfiguration.models.filter(model => model.enabled);
    const promptSizeReport = await buildPromptSizeReport({
      fixtures: approved,
      stages: configuration.stages,
      models: enabledModels,
      configuration
    });
    console.log(formatPromptSizeReport(promptSizeReport));
    assertPromptSizeReport(promptSizeReport);
    return;
  }
  if (area === 'demo' && has('--safety')) {
    StubBenchmarkAdapter.reset();
    const fixtures = await discoverFixtures({ root: fixtureRoot, approvalStatus: 'approved' });
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-benchmark-safety-demo-'));
    const lockDemoPath = path.join(temporary, 'lock-rejection');
    const firstLock = new BenchmarkLock(lockDemoPath);
    const secondLock = new BenchmarkLock(lockDemoPath);
    await firstLock.acquire({ runId: 'lock-owner-a', planHash: 'a'.repeat(64) });
    let lockRejection;
    try {
      await secondLock.acquire({ runId: 'lock-owner-b', planHash: 'b'.repeat(64) });
    } catch (error) {
      lockRejection = error.message;
    }
    await firstLock.release();
    const failureEvents = [];
    const failureRunner = new BenchmarkRunner({
      fixtures,
      modelPlans: [{ id: 'failure-model-a' }, { id: 'must-not-start-model-b' }],
      lock: new BenchmarkLock(path.join(temporary, 'failure-lock')),
      generatedRoot: path.join(temporary, 'failure-runs'),
      configuration,
      adapterFactory: model => new StubBenchmarkAdapter({
        model: model.id,
        events: failureEvents,
        responses: stubResponses(fixtures[0].manifest),
        unloadFails: model.id === 'failure-model-a'
      })
    });
    let injectedFailure;
    try { await failureRunner.run(); } catch (error) { injectedFailure = { message: error.message, report: error.failureReport }; }
    StubBenchmarkAdapter.reset();
    const restoreEvents = [];
    const restoreCoordinator = {
      async preflightAndPause() {
        restoreEvents.push('record-production-state', 'verify-idle-healthy', 'pause-controller-stub');
        return { controller: { running: true }, resident_models: [] };
      },
      async restore() {
        restoreEvents.push('unload-final-model-stub', 'smoke-qwen3:14b-stub', 'verify-digest-stub', 'restore-residency-stub', 'restore-controller-stub', 'verify-health-queue-stub');
        return { status: 'restored' };
      }
    };
    const restoreRunner = new BenchmarkRunner({
      fixtures,
      modelPlans: [{ id: 'restore-failure-model' }],
      lock: new BenchmarkLock(path.join(temporary, 'restore-lock')),
      generatedRoot: path.join(temporary, 'restore-runs'),
      configuration,
      coordinateProduction: true,
      productionCoordinator: restoreCoordinator,
      adapterFactory: model => new StubBenchmarkAdapter({
        model: model.id,
        responses: stubResponses(fixtures[0].manifest),
        failAt: 'evidence_selector'
      })
    });
    try { await restoreRunner.run(); } catch {}
    const report = {
      lock_rejection: {
        rejected: Boolean(lockRejection),
        message: lockRejection
      },
      injected_failure: {
        stopped: Boolean(injectedFailure),
        message: injectedFailure?.message,
        second_model_started: failureEvents.includes('load:must-not-start-model-b'),
        first_model_unloaded: failureEvents.includes('unload:failure-model-a'),
        report_status: injectedFailure?.report?.status
      },
      unload_restore_stub: {
        maximum_concurrent_generations: StubBenchmarkAdapter.maximumConcurrentGenerations,
        resident_models_after: await new StubBenchmarkAdapter().residentModels(),
        events: restoreEvents
      }
    };
    await fs.rm(temporary, { recursive: true, force: true });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (area === 'demo' && has('--stub')) {
    StubBenchmarkAdapter.reset();
    const fixtures = await discoverFixtures({ root: fixtureRoot, approvalStatus: 'approved' });
    const events = [];
    const modelPlans = [{ id: 'stub-local-a', adapter: 'stub', enabled: true }, { id: 'stub-local-b', adapter: 'stub', enabled: true }];
    const runner = new BenchmarkRunner({
      fixtures,
      modelPlans,
      lock: new BenchmarkLock(lockPath),
      generatedRoot,
      configuration,
      adapterFactory: model => new StubBenchmarkAdapter({
        model: model.id,
        events,
        responses: stubResponses(fixtures[0].manifest)
      })
    });
    const result = await runner.run();
    console.log(JSON.stringify({
      status: result.manifest.status,
      run_directory: result.runDirectory,
      fixture_count: fixtures.length,
      model_count: modelPlans.length,
      maximum_concurrent_generations: StubBenchmarkAdapter.maximumConcurrentGenerations,
      events
    }, null, 2));
    return;
  }
  if (area === 'run') {
    const official = has('--official');
    const freeze = has('--dry-run') ? await validateBenchmarkFreeze() : null;
    const fixtures = await discoverFixtures({ root: fixtureRoot, approvalStatus: 'approved', official });
    const requested = (after('--models') || '').split(',').filter(Boolean);
    const selectedModels = modelConfiguration.models.filter(model => model.enabled && (!requested.length || requested.includes(model.id)));
    if (has('--dry-run')) {
      const runner = new BenchmarkRunner({
        fixtures,
        modelPlans: selectedModels,
        lock: new BenchmarkLock(lockPath),
        generatedRoot,
        configuration,
        official: false,
        adapterFactory: () => { throw new Error('Dry-run planning never constructs an adapter.'); }
      });
      const promptSizeReport = await buildPromptSizeReport({
        fixtures,
        stages: configuration.stages,
        models: selectedModels,
        configuration
      });
      assertPromptSizeReport(promptSizeReport);
      console.log(JSON.stringify({
        benchmark: {
          version: freeze.benchmark_version,
          manifest_hash: freeze.benchmark_manifest_hash,
          freeze_validation: 'passed'
        },
        plan: runner.plan(),
        prompt_size_preflight: promptSizeReport
      }, null, 2));
      return;
    }
    const runner = await realRunner({ fixtures, selectedModels, official });
    const result = await runner.run();
    console.log(JSON.stringify({ run_id: result.runId, run_directory: result.runDirectory, status: result.manifest.status }, null, 2));
    return;
  }
  throw new Error('Unknown command. See pipeline-benchmark/README.md.');
}

main().catch(error => {
  console.error(`Benchmark command failed: ${error.message}`);
  process.exitCode = 1;
});
