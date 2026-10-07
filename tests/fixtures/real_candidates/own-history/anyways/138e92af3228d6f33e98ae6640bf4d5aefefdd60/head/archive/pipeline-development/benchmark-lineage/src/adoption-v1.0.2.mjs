import path from 'node:path';
import { fileHash, readJson } from './util.mjs';
import { assertSemanticEquivalence } from './freeze-v1.0.1.mjs';
import {
  PATCH_BENCHMARK_VERSION_V102,
  PATCH_CLASSIFICATION_V102,
  assertSemanticEquivalenceV102
} from './freeze-v1.0.2.mjs';

function adoptionFailure(message) {
  const error = new Error(message);
  error.code = 'BENCHMARK_ADOPTION_REJECTED';
  return error;
}

export function assertHistoricalRunAdoptableV102({
  baseManifest,
  parentManifest,
  patchManifest,
  runManifest,
  sourceBenchmarkVersion = '1.0'
}) {
  assertSemanticEquivalence(baseManifest, parentManifest);
  assertSemanticEquivalenceV102(parentManifest, patchManifest);
  assertSemanticEquivalenceV102(baseManifest, patchManifest);
  if (sourceBenchmarkVersion !== baseManifest.benchmark_version) {
    throw adoptionFailure(`Historical run version ${sourceBenchmarkVersion} is not the semantic baseline.`);
  }
  if (patchManifest.benchmark_version !== PATCH_BENCHMARK_VERSION_V102 ||
      patchManifest.patch_classification !== PATCH_CLASSIFICATION_V102) {
    throw adoptionFailure('Target benchmark is not the canonical v1.0.2 adapter-correctness patch.');
  }
  const affectedAdapters = new Set([
    ...(parentManifest.changed_artifacts || []),
    ...(patchManifest.changed_artifacts || [])
  ].map(item => item.affected_adapter).filter(Boolean));
  const usedAdapters = new Set((runManifest.plan?.models || []).map(model => model.adapter).filter(Boolean));
  const overlap = [...usedAdapters].filter(adapter => affectedAdapters.has(adapter));
  if (overlap.length) {
    throw adoptionFailure(`Historical run used changed adapter: ${overlap.join(', ')}.`);
  }
  return true;
}

export async function validateAdoptionRecordV102({
  recordFile,
  benchmarkRoot,
  baseManifestFile,
  parentManifestFile,
  patchManifestFile,
  sourceRunManifestFile
}) {
  const record = await readJson(recordFile);
  const baseManifest = await readJson(baseManifestFile);
  const parentManifest = await readJson(parentManifestFile);
  const patchManifest = await readJson(patchManifestFile);
  const runManifest = await readJson(sourceRunManifestFile);
  assertHistoricalRunAdoptableV102({
    baseManifest,
    parentManifest,
    patchManifest,
    runManifest,
    sourceBenchmarkVersion: record.source_benchmark_version
  });
  const checks = [
    ['source manifest', baseManifestFile, record.source_manifest_hash],
    ['intermediate manifest', parentManifestFile, record.intermediate_manifest_hash],
    ['target manifest', patchManifestFile, record.target_manifest_hash],
    ['source run manifest', sourceRunManifestFile, record.source_run_manifest_sha256],
    ['source adoption record', path.join(benchmarkRoot, record.source_adoption_record), record.source_adoption_record_sha256],
    ['locked human scores', path.join(benchmarkRoot, record.review_lock), record.review_lock_sha256]
  ];
  for (const [label, file, expected] of checks) {
    if (await fileHash(file) !== expected) throw adoptionFailure(`${label} checksum changed.`);
  }
  for (const artifact of record.source_artifacts || []) {
    const file = path.join(benchmarkRoot, artifact.path);
    if (await fileHash(file) !== artifact.sha256) {
      throw adoptionFailure(`Historical artifact checksum changed: ${artifact.path}.`);
    }
  }
  if (record.target_benchmark_version !== patchManifest.benchmark_version ||
      record.intermediate_benchmark_version !== parentManifest.benchmark_version ||
      record.source_benchmark_version !== baseManifest.benchmark_version) {
    throw adoptionFailure('Adoption record benchmark versions do not match the patch lineage.');
  }
  return { valid: true, record };
}

export async function validateKimiFailureExclusions({ recordFile, benchmarkRoot }) {
  const record = await readJson(recordFile);
  if (record.exclusion_type !== 'adapter_compatibility_failure' ||
      record.target_benchmark_version !== PATCH_BENCHMARK_VERSION_V102 ||
      record.excluded_from_scoring !== true ||
      record.excluded_from_import !== true) {
    throw adoptionFailure('Kimi adapter failure exclusion policy is invalid.');
  }
  if (!Array.isArray(record.runs) || record.runs.length !== 2) {
    throw adoptionFailure('Exactly two frozen Kimi adapter failures must be excluded.');
  }
  for (const run of record.runs) {
    const manifestFile = path.join(benchmarkRoot, run.run_manifest);
    if (await fileHash(manifestFile) !== run.run_manifest_sha256) {
      throw adoptionFailure(`Excluded Kimi run checksum changed: ${run.run_id}.`);
    }
    const manifest = await readJson(manifestFile);
    if (manifest.run_id !== run.run_id ||
        manifest.benchmark_metadata?.benchmark_version !== run.benchmark_version ||
        manifest.benchmark_metadata?.benchmark_manifest_hash !== run.benchmark_manifest_hash ||
        !manifest.plan?.models?.some(model => model.adapter === 'kimi-code')) {
      throw adoptionFailure(`Excluded Kimi run identity is invalid: ${run.run_id}.`);
    }
  }
  return { valid: true, record };
}
