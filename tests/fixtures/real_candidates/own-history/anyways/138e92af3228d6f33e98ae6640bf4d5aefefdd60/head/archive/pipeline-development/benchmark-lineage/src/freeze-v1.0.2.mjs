import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BENCHMARK_ROOT,
  REPO_ROOT,
  fileHash,
  readJson,
  sha256,
  stableStringify
} from './util.mjs';
import {
  DEFAULT_CONTROLLER_ROOT,
  FREEZE_MANIFEST_FILE,
  repositoryCommit,
  repositoryDirty
} from './freeze.mjs';
import {
  EDITORIAL_SEMANTIC_FIELDS,
  PATCH_MANIFEST_FILE as V101_MANIFEST_FILE,
  PATCH_MANIFEST_HASH_FILE as V101_MANIFEST_HASH_FILE,
  validateBenchmarkFreezeV101
} from './freeze-v1.0.1.mjs';

export const PATCH_BENCHMARK_VERSION_V102 = '1.0.2';
export const PATCH_PARENT_VERSION_V102 = '1.0.1';
export const PATCH_CLASSIFICATION_V102 = 'adapter_correctness';
export const PATCH_MANIFEST_FILE_V102 = path.join(BENCHMARK_ROOT, 'config', 'benchmark-v1.0.2.json');
export const PATCH_MANIFEST_HASH_FILE_V102 = path.join(BENCHMARK_ROOT, 'config', 'benchmark-v1.0.2.sha256');
export const REPLACED_ADAPTER_LOGICAL_PATH_V102 = 'src/adapters/kimi-code.mjs';
export const REPLACEMENT_ADAPTER_PATH_V102 = 'versions/v1.0.2/src/adapters/kimi-code.mjs';

function patchFailure(changes) {
  const error = new Error([
    `Benchmark v${PATCH_BENCHMARK_VERSION_V102} freeze validation failed before generation.`,
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
    if (actual !== expectedHash) {
      changes.push(`${label}.${logicalPath} changed: expected ${expectedHash}, found ${actual}`);
    }
  }
}

export function semanticEquivalenceChangesV102(parent, patch) {
  const changes = [];
  for (const field of EDITORIAL_SEMANTIC_FIELDS) {
    compare(changes, field, parent[field], patch[field]);
  }
  compare(changes, 'lifecycle version', parent.lifecycle?.version, patch.lifecycle?.version);
  const parentLifecycle = { ...(parent.lifecycle?.artifact_hashes || {}) };
  const patchLifecycle = { ...(patch.lifecycle?.artifact_hashes || {}) };
  delete parentLifecycle[REPLACED_ADAPTER_LOGICAL_PATH_V102];
  delete patchLifecycle[REPLACED_ADAPTER_LOGICAL_PATH_V102];
  compare(changes, 'unchanged lifecycle artifacts', parentLifecycle, patchLifecycle);
  return changes;
}

export function assertSemanticEquivalenceV102(parent, patch) {
  const changes = semanticEquivalenceChangesV102(parent, patch);
  if (changes.length) {
    const error = new Error(`Benchmark v1.0.2 editorial-semantic equivalence failed.\n${changes.map(item => `- ${item}`).join('\n')}`);
    error.code = 'BENCHMARK_SEMANTIC_MISMATCH';
    error.changes = changes;
    throw error;
  }
  return true;
}

export async function validateBenchmarkFreezeV102({
  manifestFile = PATCH_MANIFEST_FILE_V102,
  manifestHashFile = PATCH_MANIFEST_HASH_FILE_V102,
  parentManifestFile = V101_MANIFEST_FILE,
  parentManifestHashFile = V101_MANIFEST_HASH_FILE,
  benchmarkRoot = BENCHMARK_ROOT,
  repoRoot = REPO_ROOT,
  controllerRoot = DEFAULT_CONTROLLER_ROOT,
  verifyController = true
} = {}) {
  const parentValidation = await validateBenchmarkFreezeV101({
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
  compare(changes, 'benchmark version', PATCH_BENCHMARK_VERSION_V102, manifest.benchmark_version);
  compare(changes, 'parent version', PATCH_PARENT_VERSION_V102, manifest.parent_version);
  compare(changes, 'parent manifest hash', parentHash, manifest.parent_manifest_hash);
  compare(changes, 'patch classification', PATCH_CLASSIFICATION_V102, manifest.patch_classification);
  compare(changes, 'editorial semantics statement', 'unchanged', manifest.editorial_measurement_semantics);

  const replacement = manifest.changed_artifacts?.[0];
  compare(changes, 'changed artifact count', 1, manifest.changed_artifacts?.length);
  compare(changes, 'changed artifact logical path', REPLACED_ADAPTER_LOGICAL_PATH_V102, replacement?.path);
  compare(changes, 'changed artifact replacement path', REPLACEMENT_ADAPTER_PATH_V102, replacement?.replacement_path);
  compare(
    changes,
    'changed artifact previous hash',
    parent.lifecycle?.artifact_hashes?.[REPLACED_ADAPTER_LOGICAL_PATH_V102],
    replacement?.previous_sha256
  );
  compare(
    changes,
    'changed artifact replacement hash',
    manifest.lifecycle?.artifact_hashes?.[REPLACED_ADAPTER_LOGICAL_PATH_V102],
    replacement?.replacement_sha256
  );
  compare(changes, 'changed artifact affected adapter', 'kimi-code', replacement?.affected_adapter);

  try {
    assertSemanticEquivalenceV102(parent, manifest);
  } catch (error) {
    changes.push(...error.changes);
  }

  for (const group of [
    'prompt_hashes',
    'schema_hashes',
    'evaluator_hashes',
    'scoring_doctrine_hashes',
    'harness_hashes',
    'validation_hashes'
  ]) {
    await compareHashMap(changes, group, manifest[group], benchmarkRoot);
  }
  await compareHashMap(
    changes,
    'lifecycle hashes',
    manifest.lifecycle?.artifact_hashes,
    benchmarkRoot,
    new Map([[REPLACED_ADAPTER_LOGICAL_PATH_V102, REPLACEMENT_ADAPTER_PATH_V102]])
  );
  await compareHashMap(changes, 'patch harness hashes', manifest.patch_harness_hashes, benchmarkRoot);
  await compareHashMap(changes, 'patch validation hashes', manifest.patch_validation_hashes, benchmarkRoot);

  if (changes.length) throw patchFailure(changes);
  return Object.freeze({
    benchmark_version: PATCH_BENCHMARK_VERSION_V102,
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

export async function loadBenchmarkManifestsV102({
  baseManifestFile = FREEZE_MANIFEST_FILE,
  parentManifestFile = V101_MANIFEST_FILE,
  patchManifestFile = PATCH_MANIFEST_FILE_V102
} = {}) {
  return {
    base: await readJson(baseManifestFile),
    parent: await readJson(parentManifestFile),
    patch: await readJson(patchManifestFile)
  };
}
