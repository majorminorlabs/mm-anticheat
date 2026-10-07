#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CODEX_ADAPTER_LOGICAL_PATH_V103,
  CODEX_ADAPTER_PATH_V103,
  CODEX_REGISTRY_LOGICAL_PATH_V103,
  CODEX_REGISTRY_PATH_V103,
  PATCH_BENCHMARK_VERSION_V103,
  PATCH_CLASSIFICATION_V103,
  PATCH_MANIFEST_FILE_V103,
  PATCH_MANIFEST_HASH_FILE_V103,
  PATCH_PARENT_VERSION_V103
} from '../src/freeze-v1.0.3.mjs';
import {
  PATCH_MANIFEST_FILE_V102,
  PATCH_MANIFEST_HASH_FILE_V102,
  validateBenchmarkFreezeV102
} from '../src/freeze-v1.0.2.mjs';
import { repositoryCommit, repositoryDirty } from '../src/freeze.mjs';
import { BENCHMARK_ROOT, REPO_ROOT, fileHash, readJson, writeFileAtomic, writeJsonAtomic } from '../src/util.mjs';

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function hashes(paths) {
  return Object.fromEntries(await Promise.all(paths.sort().map(async relative => [
    relative,
    await fileHash(path.join(BENCHMARK_ROOT, relative))
  ])));
}

async function main() {
  if (await exists(PATCH_MANIFEST_FILE_V103) || await exists(PATCH_MANIFEST_HASH_FILE_V103)) {
    throw new Error('Benchmark v1.0.3 freeze already exists and cannot be overwritten.');
  }
  await validateBenchmarkFreezeV102({ verifyController: false });
  const parent = await readJson(PATCH_MANIFEST_FILE_V102);
  const parentHash = await fileHash(PATCH_MANIFEST_FILE_V102);
  const lockedParentHash = (await fs.readFile(PATCH_MANIFEST_HASH_FILE_V102, 'utf8')).trim().split(/\s+/)[0];
  if (parentHash !== lockedParentHash || parent.benchmark_version !== PATCH_PARENT_VERSION_V103) {
    throw new Error('Canonical Benchmark v1.0.2 parent identity is invalid.');
  }
  const adapterHash = await fileHash(path.join(BENCHMARK_ROOT, CODEX_ADAPTER_PATH_V103));
  const registryHash = await fileHash(path.join(BENCHMARK_ROOT, CODEX_REGISTRY_PATH_V103));
  const manifest = {
    schema_version: '1.0.0',
    benchmark_version: PATCH_BENCHMARK_VERSION_V103,
    parent_version: PATCH_PARENT_VERSION_V103,
    parent_manifest_hash: parentHash,
    patch_classification: PATCH_CLASSIFICATION_V103,
    created_at: new Date().toISOString(),
    editorial_measurement_semantics: 'unchanged',
    change_summary: 'Add one isolated, model-agnostic Codex subscription adapter and a configured candidate registry.',
    changed_artifacts: [
      {
        path: CODEX_ADAPTER_LOGICAL_PATH_V103,
        replacement_path: CODEX_ADAPTER_PATH_V103,
        previous_sha256: null,
        replacement_sha256: adapterHash,
        affected_adapter: 'codex-subscription'
      },
      {
        path: CODEX_REGISTRY_LOGICAL_PATH_V103,
        replacement_path: CODEX_REGISTRY_PATH_V103,
        previous_sha256: null,
        replacement_sha256: registryHash,
        affected_adapter: 'codex-subscription'
      }
    ],
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
        [CODEX_ADAPTER_LOGICAL_PATH_V103]: adapterHash
      }
    },
    patch_harness_hashes: await hashes(['versions/v1.0.3/cli.mjs']),
    patch_validation_hashes: await hashes([
      'ops/create-benchmark-freeze-v1.0.3.mjs',
      'src/adoption-v1.0.3.mjs',
      'src/freeze-v1.0.3.mjs'
    ]),
    patch_documentation_hashes: await hashes(['docs/BENCHMARK_V1.0.3.md']),
    stage_dependency_graph: structuredClone(parent.stage_dependency_graph),
    generation_deadline_ms: parent.generation_deadline_ms,
    environment_requirements: {
      ...structuredClone(parent.environment_requirements),
      codex_cli_version: 'codex-cli 0.146.0',
      codex_authentication: 'ChatGPT subscription auth copied into a per-invocation private CODEX_HOME',
      codex_output_format: 'jsonl',
      patch_execution_entrypoint: 'versions/v1.0.3/cli.mjs'
    },
    node_version: parent.node_version,
    ollama_version: parent.ollama_version,
    benchmark_configuration_hash: parent.benchmark_configuration_hash
  };
  await writeJsonAtomic(PATCH_MANIFEST_FILE_V103, manifest, { mode: 0o644 });
  const manifestHash = await fileHash(PATCH_MANIFEST_FILE_V103);
  await writeFileAtomic(PATCH_MANIFEST_HASH_FILE_V103, `${manifestHash}  ${path.basename(PATCH_MANIFEST_FILE_V103)}\n`, { mode: 0o644 });
  console.log(JSON.stringify({
    benchmark_version: PATCH_BENCHMARK_VERSION_V103,
    parent_version: PATCH_PARENT_VERSION_V103,
    manifest: PATCH_MANIFEST_FILE_V103,
    sha256: manifestHash,
    codex_adapter_sha256: adapterHash,
    candidate_registry_sha256: registryHash
  }, null, 2));
}

main().catch(error => {
  console.error(`Benchmark v1.0.3 freeze creation failed: ${error.message}`);
  process.exitCode = 1;
});
