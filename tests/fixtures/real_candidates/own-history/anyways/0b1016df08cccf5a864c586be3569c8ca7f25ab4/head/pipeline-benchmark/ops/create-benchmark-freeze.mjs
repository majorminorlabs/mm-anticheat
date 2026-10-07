#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BENCHMARK_VERSION,
  DEFAULT_CONTROLLER_ROOT,
  FREEZE_MANIFEST_FILE,
  FREEZE_MANIFEST_HASH_FILE,
  FROZEN_ARTIFACT_PATHS,
  LIFECYCLE_ARTIFACT_PATHS,
  LIFECYCLE_VERSION,
  STAGE_DEPENDENCIES,
  commandVersion,
  controllerArtifactHashes,
  hashRelativeFiles,
  repositoryCommit,
  repositoryDirty
} from '../src/freeze.mjs';
import {
  BENCHMARK_ROOT,
  REPO_ROOT,
  fileHash,
  readJson,
  sha256,
  stableStringify,
  writeFileAtomic,
  writeJsonAtomic
} from '../src/util.mjs';

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function approvedFixtureHashes() {
  const root = path.join(BENCHMARK_ROOT, 'fixtures');
  const entries = await fs.readdir(root, { withFileTypes: true });
  const fixtures = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const manifestFile = path.join(root, entry.name, 'manifest.json');
    if (!(await exists(manifestFile))) continue;
    const manifest = await readJson(manifestFile);
    if (manifest.approval_status !== 'approved') continue;
    fixtures[manifest.fixture_id] = {
      fixture_version: manifest.fixture_version,
      combined_fixture_hash: manifest.combined_fixture_hash
    };
  }
  return fixtures;
}

async function main() {
  if (await exists(FREEZE_MANIFEST_FILE) || await exists(FREEZE_MANIFEST_HASH_FILE)) {
    throw new Error('Benchmark v1.0 freeze already exists and cannot be overwritten.');
  }

  const configurationFile = path.join(BENCHMARK_ROOT, 'config', 'benchmark.json');
  const configuration = await readJson(configurationFile);
  const controllerHashes = await controllerArtifactHashes(DEFAULT_CONTROLLER_ROOT);
  const ollamaVersionOutput = await commandVersion('ollama');
  const ollamaVersion = ollamaVersionOutput.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || ollamaVersionOutput;
  const manifest = {
    schema_version: '1.0.0',
    benchmark_version: BENCHMARK_VERSION,
    created_at: new Date().toISOString(),
    benchmark_repository: {
      commit: await repositoryCommit(REPO_ROOT),
      dirty_at_freeze: await repositoryDirty(REPO_ROOT)
    },
    controller_repository: {
      commit: await repositoryCommit(DEFAULT_CONTROLLER_ROOT),
      repository_state: await repositoryCommit(DEFAULT_CONTROLLER_ROOT) ? 'committed' : 'unborn',
      tree_hash: sha256(stableStringify(controllerHashes)),
      artifact_hashes: controllerHashes
    },
    fixture_hashes: await approvedFixtureHashes(),
    prompt_hashes: await hashRelativeFiles(BENCHMARK_ROOT, FROZEN_ARTIFACT_PATHS.prompt_hashes),
    schema_hashes: await hashRelativeFiles(BENCHMARK_ROOT, FROZEN_ARTIFACT_PATHS.schema_hashes),
    evaluator_hashes: await hashRelativeFiles(BENCHMARK_ROOT, FROZEN_ARTIFACT_PATHS.evaluator_hashes),
    scoring_doctrine_hashes: await hashRelativeFiles(BENCHMARK_ROOT, FROZEN_ARTIFACT_PATHS.scoring_doctrine_hashes),
    harness_hashes: await hashRelativeFiles(BENCHMARK_ROOT, FROZEN_ARTIFACT_PATHS.harness_hashes),
    validation_hashes: await hashRelativeFiles(BENCHMARK_ROOT, FROZEN_ARTIFACT_PATHS.validation_hashes),
    lifecycle: {
      version: LIFECYCLE_VERSION,
      artifact_hashes: await hashRelativeFiles(BENCHMARK_ROOT, LIFECYCLE_ARTIFACT_PATHS)
    },
    stage_dependency_graph: STAGE_DEPENDENCIES,
    generation_deadline_ms: configuration.request_timeout_ms,
    environment_requirements: {
      platform: 'darwin-arm64',
      node_version: process.version,
      ollama_version: ollamaVersion,
      ollama_endpoint: configuration.ollama_url,
      controller_health_endpoint: configuration.controller_health_url,
      required_environment_variables: [
        'ANYWAYS_BENCHMARK_CONTROLLER_PLIST',
        'ANYWAYS_BENCHMARK_QUEUE_PROBE_COMMAND',
        'ANYWAYS_BENCHMARK_SMOKE_COMMAND'
      ],
      official_run_flags: [
        '--official',
        '--allow-real-models',
        '--allow-production-pause'
      ],
      concurrency: {
        local_workers: configuration.local_workers,
        cloud_workers: configuration.cloud_workers,
        maximum_loaded_local_models: configuration.maximum_loaded_local_models
      },
      automatic_retries: configuration.automatic_retries
    },
    node_version: process.version,
    ollama_version: ollamaVersion,
    benchmark_configuration_hash: await fileHash(configurationFile)
  };

  await writeJsonAtomic(FREEZE_MANIFEST_FILE, manifest, { mode: 0o644 });
  const manifestHash = await fileHash(FREEZE_MANIFEST_FILE);
  await writeFileAtomic(
    FREEZE_MANIFEST_HASH_FILE,
    `${manifestHash}  ${path.basename(FREEZE_MANIFEST_FILE)}\n`,
    { mode: 0o644 }
  );
  console.log(JSON.stringify({
    benchmark_version: BENCHMARK_VERSION,
    manifest: FREEZE_MANIFEST_FILE,
    sha256: manifestHash
  }, null, 2));
}

main().catch(error => {
  console.error(`Benchmark freeze creation failed: ${error.message}`);
  process.exitCode = 1;
});
