#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { CodexSubscriptionBenchmarkAdapter } from './src/adapters/codex.mjs';
import { KimiCodeBenchmarkAdapter } from '../v1.0.2/src/adapters/kimi-code.mjs';
import { OllamaBenchmarkAdapter } from '../../src/adapters/ollama.mjs';
import { discoverFixtures } from '../../src/fixture.mjs';
import { validateBenchmarkFreezeV103 } from '../../src/freeze-v1.0.3.mjs';
import { BenchmarkLock } from '../../src/lock.mjs';
import {
  assertPromptSizeReport,
  buildPromptSizeReport,
  formatPromptSizeReport
} from '../../src/prompt-size.mjs';
import {
  OllamaProductionModelSystem,
  ProductionCoordinator,
  launchctlControllerControl
} from '../../src/production.mjs';
import { BenchmarkRunner } from '../../src/runner.mjs';
import { BENCHMARK_ROOT, REPO_ROOT, readJson } from '../../src/util.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const after = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const configuration = await readJson(path.join(BENCHMARK_ROOT, 'config', 'benchmark.json'));
const baseModels = await readJson(path.join(BENCHMARK_ROOT, 'config', 'models.json'));
const codexCandidates = await readJson(path.join(BENCHMARK_ROOT, 'versions', 'v1.0.3', 'models.json'));
const modelConfiguration = { models: [...baseModels.models, ...codexCandidates.models] };
const fixtureRoot = path.resolve(REPO_ROOT, configuration.fixture_root);
const generatedRoot = path.resolve(REPO_ROOT, configuration.generated_root);
const lockPath = path.resolve(REPO_ROOT, configuration.lock_path);

async function commandJson(command, label) {
  if (!command) throw new Error(`${label} command is required.`);
  const [executable, ...commandArgs] = JSON.parse(command);
  const { stdout } = await execFileAsync(executable, commandArgs, {
    cwd: REPO_ROOT,
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout);
}

function productionCoordinator() {
  const plist = process.env.ANYWAYS_BENCHMARK_CONTROLLER_PLIST;
  const queueCommand = process.env.ANYWAYS_BENCHMARK_QUEUE_PROBE_COMMAND;
  const smokeCommand = process.env.ANYWAYS_BENCHMARK_SMOKE_COMMAND;
  if (!plist || !queueCommand || !smokeCommand) {
    throw new Error('Official execution requires controller plist, read-only queue probe command, and production-path smoke command configuration.');
  }
  const modelSystem = new OllamaProductionModelSystem({ baseUrl: configuration.ollama_url });
  return new ProductionCoordinator({
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
}

function adapterFor(model) {
  if (model.adapter === 'ollama') {
    return new OllamaBenchmarkAdapter({
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
    });
  }
  if (model.adapter === 'kimi-code') {
    return new KimiCodeBenchmarkAdapter({
      model: model.model,
      timeoutMs: configuration.request_timeout_ms,
      allowPaidGeneration: true
    });
  }
  if (model.adapter === 'codex-subscription') {
    return new CodexSubscriptionBenchmarkAdapter({
      model: model.model,
      reasoning: model.reasoning,
      timeoutMs: configuration.request_timeout_ms,
      allowPaidGeneration: true
    });
  }
  throw new Error(`Unsupported Benchmark v1.0.3 adapter: ${model.adapter}`);
}

async function main() {
  const [area, action] = args;
  if (area === 'fixtures' && action === 'validate') {
    const validation = await validateBenchmarkFreezeV103();
    console.log(JSON.stringify({
      benchmark_version: validation.benchmark_version,
      benchmark_manifest_hash: validation.benchmark_manifest_hash,
      parent_benchmark_version: validation.parent_benchmark_version,
      parent_manifest_hash: validation.parent_manifest_hash,
      freeze_validation: 'passed',
      semantic_equivalence: 'passed'
    }, null, 2));
    return;
  }
  if (area !== 'run') throw new Error('Expected `fixtures validate` or `run`.');
  const official = has('--official');
  const fixtures = await discoverFixtures({ root: fixtureRoot, approvalStatus: 'approved', official });
  const requested = (after('--models') || '').split(',').filter(Boolean);
  const selectedModels = modelConfiguration.models.filter(
    model => model.enabled && (!requested.length || requested.includes(model.id))
  );
  const unknown = requested.filter(id => !modelConfiguration.models.some(model => model.id === id));
  if (unknown.length) throw new Error(`Unknown Benchmark v1.0.3 model candidate(s): ${unknown.join(', ')}.`);
  if (has('--dry-run')) {
    const validation = await validateBenchmarkFreezeV103();
    const report = await buildPromptSizeReport({
      fixtures,
      stages: configuration.stages,
      models: selectedModels,
      configuration
    });
    assertPromptSizeReport(report);
    console.log(JSON.stringify({
      benchmark_version: validation.benchmark_version,
      benchmark_manifest_hash: validation.benchmark_manifest_hash,
      models: selectedModels.map(model => model.id),
      prompt_size_preflight: 'passed'
    }, null, 2));
    console.log(formatPromptSizeReport(report));
    return;
  }
  if (!official || !has('--allow-real-models') || !has('--allow-production-pause')) {
    throw new Error('Real execution requires --official --allow-real-models --allow-production-pause.');
  }
  if (selectedModels.some(model => model.paid_generation) && !has('--allow-paid-cloud')) {
    throw new Error('Paid cloud candidates require separate --allow-paid-cloud authorization.');
  }
  const runner = new BenchmarkRunner({
    fixtures,
    modelPlans: selectedModels,
    lock: new BenchmarkLock(lockPath),
    generatedRoot,
    configuration,
    official: true,
    coordinateProduction: true,
    productionCoordinator: productionCoordinator(),
    adapterFactory: adapterFor,
    freezeValidator: () => validateBenchmarkFreezeV103()
  });
  const result = await runner.run();
  console.log(JSON.stringify({
    run_id: result.runId,
    run_directory: result.runDirectory,
    status: result.manifest.status,
    benchmark_version: '1.0.3'
  }, null, 2));
}

main().catch(error => {
  console.error(`Benchmark v1.0.3 command failed: ${error.message}`);
  process.exitCode = 1;
});
