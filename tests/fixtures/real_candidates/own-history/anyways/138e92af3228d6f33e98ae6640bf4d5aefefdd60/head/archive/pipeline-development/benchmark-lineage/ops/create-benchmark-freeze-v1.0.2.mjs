#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PATCH_BENCHMARK_VERSION_V102,
  PATCH_CLASSIFICATION_V102,
  PATCH_MANIFEST_FILE_V102,
  PATCH_MANIFEST_HASH_FILE_V102,
  PATCH_PARENT_VERSION_V102,
  REPLACED_ADAPTER_LOGICAL_PATH_V102,
  REPLACEMENT_ADAPTER_PATH_V102
} from '../src/freeze-v1.0.2.mjs';
import {
  PATCH_MANIFEST_FILE as V101_MANIFEST_FILE,
  PATCH_MANIFEST_HASH_FILE as V101_MANIFEST_HASH_FILE,
  validateBenchmarkFreezeV101
} from '../src/freeze-v1.0.1.mjs';
import { repositoryCommit, repositoryDirty } from '../src/freeze.mjs';
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
  if (await exists(PATCH_MANIFEST_FILE_V102) || await exists(PATCH_MANIFEST_HASH_FILE_V102)) {
    throw new Error('Benchmark v1.0.2 freeze already exists and cannot be overwritten.');
  }
  await validateBenchmarkFreezeV101({ verifyController: false });
  const parent = await readJson(V101_MANIFEST_FILE);
  const parentHash = await fileHash(V101_MANIFEST_FILE);
  const lockedParentHash = (await fs.readFile(V101_MANIFEST_HASH_FILE, 'utf8')).trim().split(/\s+/)[0];
  if (parentHash !== lockedParentHash || parent.benchmark_version !== PATCH_PARENT_VERSION_V102) {
    throw new Error('Canonical Benchmark v1.0.1 parent identity is invalid.');
  }
  const previousHash = parent.lifecycle.artifact_hashes[REPLACED_ADAPTER_LOGICAL_PATH_V102];
  const replacementHash = await fileHash(path.join(BENCHMARK_ROOT, REPLACEMENT_ADAPTER_PATH_V102));
  const patchHarnessPaths = ['versions/v1.0.2/cli.mjs'];
  const patchValidationPaths = [
    'ops/create-benchmark-freeze-v1.0.2.mjs',
    'src/adoption-v1.0.2.mjs',
    'src/freeze-v1.0.2.mjs'
  ];
  const manifest = {
    schema_version: '1.0.0',
    benchmark_version: PATCH_BENCHMARK_VERSION_V102,
    parent_version: PATCH_PARENT_VERSION_V102,
    parent_manifest_hash: parentHash,
    patch_classification: PATCH_CLASSIFICATION_V102,
    created_at: new Date().toISOString(),
    editorial_measurement_semantics: 'unchanged',
    change_summary: 'Use Kimi CLI stream-json output and decode assistant message content without modifying model-emitted content.',
    changed_artifacts: [{
      path: REPLACED_ADAPTER_LOGICAL_PATH_V102,
      replacement_path: REPLACEMENT_ADAPTER_PATH_V102,
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
        [REPLACED_ADAPTER_LOGICAL_PATH_V102]: replacementHash
      }
    },
    patch_harness_hashes: await hashes(patchHarnessPaths),
    patch_validation_hashes: await hashes(patchValidationPaths),
    stage_dependency_graph: structuredClone(parent.stage_dependency_graph),
    generation_deadline_ms: parent.generation_deadline_ms,
    environment_requirements: {
      ...structuredClone(parent.environment_requirements),
      kimi_cli_version: '0.29.2',
      kimi_output_format: 'stream-json',
      patch_execution_entrypoint: 'versions/v1.0.2/cli.mjs'
    },
    node_version: parent.node_version,
    ollama_version: parent.ollama_version,
    benchmark_configuration_hash: parent.benchmark_configuration_hash
  };
  await writeJsonAtomic(PATCH_MANIFEST_FILE_V102, manifest, { mode: 0o644 });
  const manifestHash = await fileHash(PATCH_MANIFEST_FILE_V102);
  await writeFileAtomic(
    PATCH_MANIFEST_HASH_FILE_V102,
    `${manifestHash}  ${path.basename(PATCH_MANIFEST_FILE_V102)}\n`,
    { mode: 0o644 }
  );
  console.log(JSON.stringify({
    benchmark_version: PATCH_BENCHMARK_VERSION_V102,
    parent_version: PATCH_PARENT_VERSION_V102,
    manifest: PATCH_MANIFEST_FILE_V102,
    sha256: manifestHash,
    previous_adapter_sha256: previousHash,
    replacement_adapter_sha256: replacementHash
  }, null, 2));
}

main().catch(error => {
  console.error(`Benchmark v1.0.2 freeze creation failed: ${error.message}`);
  process.exitCode = 1;
});
