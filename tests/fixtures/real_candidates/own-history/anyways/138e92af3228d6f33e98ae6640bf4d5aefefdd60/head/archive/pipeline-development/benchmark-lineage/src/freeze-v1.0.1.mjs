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
  FREEZE_MANIFEST_HASH_FILE,
  validateBenchmarkFreeze,
  repositoryCommit,
  repositoryDirty
} from './freeze.mjs';

export const PATCH_BENCHMARK_VERSION = '1.0.1';
export const PATCH_PARENT_VERSION = '1.0';
export const PATCH_CLASSIFICATION = 'adapter_correctness';
export const PATCH_MANIFEST_FILE = path.join(BENCHMARK_ROOT, 'config', 'benchmark-v1.0.1.json');
export const PATCH_MANIFEST_HASH_FILE = path.join(BENCHMARK_ROOT, 'config', 'benchmark-v1.0.1.sha256');
export const REPLACED_ADAPTER_LOGICAL_PATH = 'src/adapters/kimi-code.mjs';
export const REPLACEMENT_ADAPTER_PATH = 'versions/v1.0.1/src/adapters/kimi-code.mjs';

export const EDITORIAL_SEMANTIC_FIELDS = Object.freeze([
  'fixture_hashes',
  'prompt_hashes',
  'schema_hashes',
  'evaluator_hashes',
  'scoring_doctrine_hashes',
  'harness_hashes',
  'stage_dependency_graph',
  'generation_deadline_ms',
  'benchmark_configuration_hash'
]);

function patchFailure(changes) {
  const error = new Error([
    `Benchmark v${PATCH_BENCHMARK_VERSION} freeze validation failed before generation.`,
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

export function semanticEquivalenceChanges(parent, patch) {
  const changes = [];
  for (const field of EDITORIAL_SEMANTIC_FIELDS) {
    compare(changes, field, parent[field], patch[field]);
  }
  compare(changes, 'lifecycle version', parent.lifecycle?.version, patch.lifecycle?.version);
  const parentLifecycle = { ...(parent.lifecycle?.artifact_hashes || {}) };
  const patchLifecycle = { ...(patch.lifecycle?.artifact_hashes || {}) };
  delete parentLifecycle[REPLACED_ADAPTER_LOGICAL_PATH];
  delete patchLifecycle[REPLACED_ADAPTER_LOGICAL_PATH];
  compare(changes, 'unchanged lifecycle artifacts', parentLifecycle, patchLifecycle);
  compare(
    changes,
    'blind-review scoring artifacts',
    parent.scoring_doctrine_hashes,
    patch.scoring_doctrine_hashes
  );
  return changes;
}

export function assertSemanticEquivalence(parent, patch) {
  const changes = semanticEquivalenceChanges(parent, patch);
  if (changes.length) {
    const error = new Error(`Benchmark v1.0.1 editorial-semantic equivalence failed.\n${changes.map(item => `- ${item}`).join('\n')}`);
    error.code = 'BENCHMARK_SEMANTIC_MISMATCH';
    error.changes = changes;
    throw error;
  }
  return true;
}

export async function validateBenchmarkFreezeV101({
  manifestFile = PATCH_MANIFEST_FILE,
  manifestHashFile = PATCH_MANIFEST_HASH_FILE,
  parentManifestFile = FREEZE_MANIFEST_FILE,
  parentManifestHashFile = FREEZE_MANIFEST_HASH_FILE,
  benchmarkRoot = BENCHMARK_ROOT,
  repoRoot = REPO_ROOT,
  controllerRoot = DEFAULT_CONTROLLER_ROOT,
  verifyController = true
} = {}) {
  const parentValidation = await validateBenchmarkFreeze({
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
  compare(changes, 'benchmark version', PATCH_BENCHMARK_VERSION, manifest.benchmark_version);
  compare(changes, 'parent version', PATCH_PARENT_VERSION, manifest.parent_version);
  compare(changes, 'parent manifest hash', parentHash, manifest.parent_manifest_hash);
  compare(changes, 'patch classification', PATCH_CLASSIFICATION, manifest.patch_classification);
  compare(changes, 'editorial semantics statement', 'unchanged', manifest.editorial_measurement_semantics);

  const replacement = manifest.changed_artifacts?.[0];
  compare(changes, 'changed artifact count', 1, manifest.changed_artifacts?.length);
  compare(changes, 'changed artifact logical path', REPLACED_ADAPTER_LOGICAL_PATH, replacement?.path);
  compare(changes, 'changed artifact replacement path', REPLACEMENT_ADAPTER_PATH, replacement?.replacement_path);
  compare(
    changes,
    'changed artifact previous hash',
    parent.lifecycle?.artifact_hashes?.[REPLACED_ADAPTER_LOGICAL_PATH],
    replacement?.previous_sha256
  );
  compare(
    changes,
    'changed artifact replacement hash',
    manifest.lifecycle?.artifact_hashes?.[REPLACED_ADAPTER_LOGICAL_PATH],
    replacement?.replacement_sha256
  );
  compare(changes, 'changed artifact affected adapter', 'kimi-code', replacement?.affected_adapter);

  try {
    assertSemanticEquivalence(parent, manifest);
  } catch (error) {
    changes.push(...error.changes);
  }

  const regularGroups = [
    'prompt_hashes',
    'schema_hashes',
    'evaluator_hashes',
    'scoring_doctrine_hashes',
    'harness_hashes',
    'validation_hashes'
  ];
  for (const group of regularGroups) {
    await compareHashMap(changes, group, manifest[group], benchmarkRoot);
  }
  await compareHashMap(
    changes,
    'lifecycle hashes',
    manifest.lifecycle?.artifact_hashes,
    benchmarkRoot,
    new Map([[REPLACED_ADAPTER_LOGICAL_PATH, REPLACEMENT_ADAPTER_PATH]])
  );
  await compareHashMap(changes, 'patch harness hashes', manifest.patch_harness_hashes, benchmarkRoot);
  await compareHashMap(changes, 'patch validation hashes', manifest.patch_validation_hashes, benchmarkRoot);

  if (changes.length) throw patchFailure(changes);
  return Object.freeze({
    benchmark_version: PATCH_BENCHMARK_VERSION,
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

export async function loadBenchmarkManifests({
  parentManifestFile = FREEZE_MANIFEST_FILE,
  patchManifestFile = PATCH_MANIFEST_FILE
} = {}) {
  return {
    parent: await readJson(parentManifestFile),
    patch: await readJson(patchManifestFile)
  };
}
