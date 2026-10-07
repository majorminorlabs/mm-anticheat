import fs from 'node:fs/promises';
import path from 'node:path';
import { BENCHMARK_ROOT, REPO_ROOT, fileHash, readJson, sha256, stableStringify } from './util.mjs';
import { DEFAULT_CONTROLLER_ROOT, repositoryCommit, repositoryDirty } from './freeze.mjs';
import { EDITORIAL_SEMANTIC_FIELDS } from './freeze-v1.0.1.mjs';
import {
  PATCH_MANIFEST_FILE_V102,
  PATCH_MANIFEST_HASH_FILE_V102,
  validateBenchmarkFreezeV102
} from './freeze-v1.0.2.mjs';

export const PATCH_BENCHMARK_VERSION_V103 = '1.0.3';
export const PATCH_PARENT_VERSION_V103 = '1.0.2';
export const PATCH_CLASSIFICATION_V103 = 'provider_adapter_addition';
export const PATCH_MANIFEST_FILE_V103 = path.join(BENCHMARK_ROOT, 'config', 'benchmark-v1.0.3.json');
export const PATCH_MANIFEST_HASH_FILE_V103 = path.join(BENCHMARK_ROOT, 'config', 'benchmark-v1.0.3.sha256');
export const CODEX_ADAPTER_LOGICAL_PATH_V103 = 'src/adapters/codex-subscription.mjs';
export const CODEX_ADAPTER_PATH_V103 = 'versions/v1.0.3/src/adapters/codex.mjs';
export const CODEX_REGISTRY_LOGICAL_PATH_V103 = 'config/codex-subscription-models.json';
export const CODEX_REGISTRY_PATH_V103 = 'versions/v1.0.3/models.json';

function patchFailure(changes) {
  const error = new Error([
    'Benchmark v1.0.3 freeze validation failed before generation.',
    ...changes.map(change => `- ${change}`)
  ].join('\n'));
  error.name = 'BenchmarkFreezeError';
  error.code = 'BENCHMARK_FREEZE_MISMATCH';
  error.changes = changes;
  return error;
}

function compare(changes, label, expected, actual) {
  if (stableStringify(expected) !== stableStringify(actual)) {
    changes.push(`${label} changed: expected ${stableStringify(expected)}, found ${stableStringify(actual)}`);
  }
}

async function compareHashMap(changes, label, expected, benchmarkRoot, replacements = new Map()) {
  for (const [logicalPath, expectedHash] of Object.entries(expected || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const relative = replacements.get(logicalPath) || logicalPath;
    let actual;
    try {
      actual = await fileHash(path.join(benchmarkRoot, relative));
    } catch (error) {
      actual = `unreadable:${error.code || error.message}`;
    }
    if (actual !== expectedHash) changes.push(`${label}.${logicalPath} changed: expected ${expectedHash}, found ${actual}`);
  }
}

export function semanticEquivalenceChangesV103(parent, patch) {
  const changes = [];
  for (const field of EDITORIAL_SEMANTIC_FIELDS) compare(changes, field, parent[field], patch[field]);
  compare(changes, 'lifecycle version', parent.lifecycle?.version, patch.lifecycle?.version);
  const parentLifecycle = { ...(parent.lifecycle?.artifact_hashes || {}) };
  const patchLifecycle = { ...(patch.lifecycle?.artifact_hashes || {}) };
  delete patchLifecycle[CODEX_ADAPTER_LOGICAL_PATH_V103];
  compare(changes, 'pre-existing lifecycle artifacts', parentLifecycle, patchLifecycle);
  return changes;
}

export function assertSemanticEquivalenceV103(parent, patch) {
  const changes = semanticEquivalenceChangesV103(parent, patch);
  if (changes.length) {
    const error = new Error(`Benchmark v1.0.3 editorial-semantic equivalence failed.\n${changes.map(item => `- ${item}`).join('\n')}`);
    error.code = 'BENCHMARK_SEMANTIC_MISMATCH';
    error.changes = changes;
    throw error;
  }
  return true;
}

export async function validateBenchmarkFreezeV103({
  manifestFile = PATCH_MANIFEST_FILE_V103,
  manifestHashFile = PATCH_MANIFEST_HASH_FILE_V103,
  parentManifestFile = PATCH_MANIFEST_FILE_V102,
  parentManifestHashFile = PATCH_MANIFEST_HASH_FILE_V102,
  benchmarkRoot = BENCHMARK_ROOT,
  repoRoot = REPO_ROOT,
  controllerRoot = DEFAULT_CONTROLLER_ROOT,
  verifyController = true
} = {}) {
  const parentValidation = await validateBenchmarkFreezeV102({
    manifestFile: parentManifestFile,
    manifestHashFile: parentManifestHashFile,
    benchmarkRoot,
    repoRoot,
    controllerRoot,
    verifyController
  });
  const changes = [];
  const parentBytes = await fs.readFile(parentManifestFile);
  const parentHash = sha256(parentBytes);
  const parent = JSON.parse(parentBytes);
  const manifestBytes = await fs.readFile(manifestFile);
  const manifestHash = sha256(manifestBytes);
  const lockedHash = (await fs.readFile(manifestHashFile, 'utf8')).trim().split(/\s+/)[0];
  const manifest = JSON.parse(manifestBytes);

  compare(changes, 'canonical manifest checksum', lockedHash, manifestHash);
  compare(changes, 'benchmark version', PATCH_BENCHMARK_VERSION_V103, manifest.benchmark_version);
  compare(changes, 'parent version', PATCH_PARENT_VERSION_V103, manifest.parent_version);
  compare(changes, 'parent manifest hash', parentHash, manifest.parent_manifest_hash);
  compare(changes, 'patch classification', PATCH_CLASSIFICATION_V103, manifest.patch_classification);
  compare(changes, 'editorial semantics statement', 'unchanged', manifest.editorial_measurement_semantics);

  const expectedChanges = [
    { path: CODEX_ADAPTER_LOGICAL_PATH_V103, replacement_path: CODEX_ADAPTER_PATH_V103, affected_adapter: 'codex-subscription' },
    { path: CODEX_REGISTRY_LOGICAL_PATH_V103, replacement_path: CODEX_REGISTRY_PATH_V103, affected_adapter: 'codex-subscription' }
  ];
  compare(changes, 'changed artifact count', expectedChanges.length, manifest.changed_artifacts?.length);
  for (const expected of expectedChanges) {
    const artifact = manifest.changed_artifacts?.find(item => item.path === expected.path);
    compare(changes, `${expected.path} replacement path`, expected.replacement_path, artifact?.replacement_path);
    compare(changes, `${expected.path} previous hash`, null, artifact?.previous_sha256);
    compare(changes, `${expected.path} affected adapter`, expected.affected_adapter, artifact?.affected_adapter);
    let actualHash;
    try {
      actualHash = await fileHash(path.join(benchmarkRoot, expected.replacement_path));
    } catch (error) {
      actualHash = `unreadable:${error.code || error.message}`;
    }
    compare(changes, `${expected.path} replacement hash`, actualHash, artifact?.replacement_sha256);
  }

  try {
    assertSemanticEquivalenceV103(parent, manifest);
  } catch (error) {
    changes.push(...error.changes);
  }
  for (const group of [
    'prompt_hashes', 'schema_hashes', 'evaluator_hashes', 'scoring_doctrine_hashes',
    'harness_hashes', 'validation_hashes'
  ]) {
    await compareHashMap(changes, group, manifest[group], benchmarkRoot);
  }
  await compareHashMap(changes, 'lifecycle hashes', manifest.lifecycle?.artifact_hashes, benchmarkRoot, new Map([
    ['src/adapters/kimi-code.mjs', 'versions/v1.0.2/src/adapters/kimi-code.mjs'],
    [CODEX_ADAPTER_LOGICAL_PATH_V103, CODEX_ADAPTER_PATH_V103]
  ]));
  await compareHashMap(changes, 'patch harness hashes', manifest.patch_harness_hashes, benchmarkRoot);
  await compareHashMap(changes, 'patch validation hashes', manifest.patch_validation_hashes, benchmarkRoot);
  await compareHashMap(changes, 'patch documentation hashes', manifest.patch_documentation_hashes, benchmarkRoot);

  if (changes.length) throw patchFailure(changes);
  return Object.freeze({
    benchmark_version: PATCH_BENCHMARK_VERSION_V103,
    benchmark_manifest_hash: manifestHash,
    canonical_manifest: manifest,
    parent_benchmark_version: parentValidation.benchmark_version,
    parent_manifest_hash: parentHash,
    benchmark_repository_commit: await repositoryCommit(repoRoot),
    benchmark_repository_dirty: await repositoryDirty(repoRoot),
    controller_repository_commit: parentValidation.controller_repository_commit,
    controller_repository_tree_hash: parentValidation.controller_repository_tree_hash
  });
}

export async function loadBenchmarkManifestsV103({ patchManifestFile = PATCH_MANIFEST_FILE_V103 } = {}) {
  return { patch: await readJson(patchManifestFile) };
}
