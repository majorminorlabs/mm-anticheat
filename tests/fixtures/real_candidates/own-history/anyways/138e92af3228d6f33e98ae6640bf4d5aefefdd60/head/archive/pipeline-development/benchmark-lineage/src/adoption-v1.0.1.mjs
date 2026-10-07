import fs from 'node:fs/promises';
import path from 'node:path';
import { fileHash, readJson } from './util.mjs';
import {
  PATCH_BENCHMARK_VERSION,
  PATCH_CLASSIFICATION,
  assertSemanticEquivalence
} from './freeze-v1.0.1.mjs';

function adoptionFailure(message) {
  const error = new Error(message);
  error.code = 'BENCHMARK_ADOPTION_REJECTED';
  return error;
}

export function assertHistoricalRunAdoptable({
  parentManifest,
  patchManifest,
  runManifest,
  sourceBenchmarkVersion = '1.0'
}) {
  assertSemanticEquivalence(parentManifest, patchManifest);
  if (sourceBenchmarkVersion !== patchManifest.parent_version) {
    throw adoptionFailure(`Historical run version ${sourceBenchmarkVersion} is not the patch parent.`);
  }
  if (patchManifest.benchmark_version !== PATCH_BENCHMARK_VERSION ||
      patchManifest.patch_classification !== PATCH_CLASSIFICATION) {
    throw adoptionFailure('Target benchmark is not the canonical adapter-correctness patch.');
  }
  const affectedAdapters = new Set(
    (patchManifest.changed_artifacts || []).map(item => item.affected_adapter).filter(Boolean)
  );
  const usedAdapters = new Set((runManifest.plan?.models || []).map(model => model.adapter).filter(Boolean));
  const overlap = [...usedAdapters].filter(adapter => affectedAdapters.has(adapter));
  if (overlap.length) {
    throw adoptionFailure(`Historical run used changed adapter: ${overlap.join(', ')}.`);
  }
  return true;
}

export async function validateAdoptionRecord({
  recordFile,
  benchmarkRoot,
  parentManifestFile,
  patchManifestFile,
  sourceRunManifestFile
}) {
  const record = await readJson(recordFile);
  const parentManifest = await readJson(parentManifestFile);
  const patchManifest = await readJson(patchManifestFile);
  const runManifest = await readJson(sourceRunManifestFile);
  assertHistoricalRunAdoptable({
    parentManifest,
    patchManifest,
    runManifest,
    sourceBenchmarkVersion: record.source_benchmark_version
  });
  const checks = [
    ['source manifest', parentManifestFile, record.source_manifest_hash],
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
      record.source_benchmark_version !== patchManifest.parent_version) {
    throw adoptionFailure('Adoption record benchmark versions do not match the patch lineage.');
  }
  return { valid: true, record };
}
