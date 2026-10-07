#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PATCH_BENCHMARK_VERSION,
  PATCH_CLASSIFICATION,
  PATCH_MANIFEST_FILE,
  PATCH_MANIFEST_HASH_FILE,
  PATCH_PARENT_VERSION,
  REPLACED_ADAPTER_LOGICAL_PATH,
  REPLACEMENT_ADAPTER_PATH
} from '../src/freeze-v1.0.1.mjs';
import {
  FREEZE_MANIFEST_FILE,
  FREEZE_MANIFEST_HASH_FILE,
  repositoryCommit,
  repositoryDirty
} from '../src/freeze.mjs';
import {
  BENCHMARK_ROOT,
  REPO_ROOT,
  fileHash,
  readJson,
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

async function hashes(paths) {
  return Object.fromEntries(await Promise.all(paths.sort().map(async relative => [
    relative,
    await fileHash(path.join(BENCHMARK_ROOT, relative))
  ])));
}

async function main() {
  if (await exists(PATCH_MANIFEST_FILE) || await exists(PATCH_MANIFEST_HASH_FILE)) {
    throw new Error('Benchmark v1.0.1 freeze already exists and cannot be overwritten.');
  }
  const parent = await readJson(FREEZE_MANIFEST_FILE);
  const parentHash = await fileHash(FREEZE_MANIFEST_FILE);
  const lockedParentHash = (await fs.readFile(FREEZE_MANIFEST_HASH_FILE, 'utf8')).trim().split(/\s+/)[0];
  if (parentHash !== lockedParentHash || parent.benchmark_version !== PATCH_PARENT_VERSION) {
    throw new Error('Canonical Benchmark v1.0 parent identity is invalid.');
  }
  const previousHash = parent.lifecycle.artifact_hashes[REPLACED_ADAPTER_LOGICAL_PATH];
  const replacementHash = await fileHash(path.join(BENCHMARK_ROOT, REPLACEMENT_ADAPTER_PATH));
  const patchHarnessPaths = ['versions/v1.0.1/cli.mjs'];
  const patchValidationPaths = [
    'ops/create-benchmark-freeze-v1.0.1.mjs',
    'src/adoption-v1.0.1.mjs',
    'src/freeze-v1.0.1.mjs'
  ];
  const manifest = {
    schema_version: '1.0.0',
    benchmark_version: PATCH_BENCHMARK_VERSION,
    parent_version: PATCH_PARENT_VERSION,
    parent_manifest_hash: parentHash,
    patch_classification: PATCH_CLASSIFICATION,
    created_at: new Date().toISOString(),
    editorial_measurement_semantics: 'unchanged',
    change_summary: 'Correct the model-agnostic Kimi CLI argument order and reject empty successful stdout.',
    changed_artifacts: [{
      path: REPLACED_ADAPTER_LOGICAL_PATH,
      replacement_path: REPLACEMENT_ADAPTER_PATH,
      previous_sha256: previousHash,
      replacement_sha256: replacementHash,
      affected_adapter: 'kimi-code'
    }],
    benchmark_repository: {
      commit: await repositoryCommit(REPO_ROOT),
      dirty_at_freeze: await repositoryDirty(REPO_ROOT)
    },
    controller_repository: structuredClone(parent.controller_repository),
    fixture_hashes: structuredClone(parent.fixture_hashes),
    prompt_hashes: structuredClone(parent.prompt_hashes),
    schema_hashes: structuredClone(parent.schema_hashes),
    evaluator_hashes: structuredClone(parent.evaluator_hashes),
    scoring_doctrine_hashes: structuredClone(parent.scoring_doctrine_hashes),
    harness_hashes: structuredClone(parent.harness_hashes),
    validation_hashes: structuredClone(parent.validation_hashes),
    lifecycle: {
      version: parent.lifecycle.version,
      artifact_hashes: {
        ...structuredClone(parent.lifecycle.artifact_hashes),
        [REPLACED_ADAPTER_LOGICAL_PATH]: replacementHash
      }
    },
    patch_harness_hashes: await hashes(patchHarnessPaths),
    patch_validation_hashes: await hashes(patchValidationPaths),
    stage_dependency_graph: structuredClone(parent.stage_dependency_graph),
    generation_deadline_ms: parent.generation_deadline_ms,
    environment_requirements: {
      ...structuredClone(parent.environment_requirements),
      kimi_cli_version: '0.29.2',
      patch_execution_entrypoint: 'versions/v1.0.1/cli.mjs'
    },
    node_version: parent.node_version,
    ollama_version: parent.ollama_version,
    benchmark_configuration_hash: parent.benchmark_configuration_hash
  };
  await writeJsonAtomic(PATCH_MANIFEST_FILE, manifest, { mode: 0o644 });
  const manifestHash = await fileHash(PATCH_MANIFEST_FILE);
  await writeFileAtomic(
    PATCH_MANIFEST_HASH_FILE,
    `${manifestHash}  ${path.basename(PATCH_MANIFEST_FILE)}\n`,
    { mode: 0o644 }
  );
  console.log(JSON.stringify({
    benchmark_version: PATCH_BENCHMARK_VERSION,
    parent_version: PATCH_PARENT_VERSION,
    manifest: PATCH_MANIFEST_FILE,
    sha256: manifestHash,
    previous_adapter_sha256: previousHash,
    replacement_adapter_sha256: replacementHash
  }, null, 2));
}

main().catch(error => {
  console.error(`Benchmark v1.0.1 freeze creation failed: ${error.message}`);
  process.exitCode = 1;
});
