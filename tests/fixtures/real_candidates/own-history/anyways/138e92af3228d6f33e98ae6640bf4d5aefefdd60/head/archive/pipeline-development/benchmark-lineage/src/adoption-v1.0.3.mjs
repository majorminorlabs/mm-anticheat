import path from 'node:path';
import { fileHash, readJson } from './util.mjs';
import { assertSemanticEquivalence } from './freeze-v1.0.1.mjs';
import { assertSemanticEquivalenceV102 } from './freeze-v1.0.2.mjs';
import {
  PATCH_BENCHMARK_VERSION_V103,
  PATCH_CLASSIFICATION_V103,
  assertSemanticEquivalenceV103
} from './freeze-v1.0.3.mjs';
import { validateKimiFailureExclusions } from './adoption-v1.0.2.mjs';

function adoptionFailure(message) {
  const error = new Error(message);
  error.code = 'BENCHMARK_ADOPTION_REJECTED';
  return error;
}

export function assertHistoricalRunAdoptableV103({
  baseManifest,
  patch101Manifest,
  patch102Manifest,
  patch103Manifest,
  runManifest
}) {
  assertSemanticEquivalence(baseManifest, patch101Manifest);
  assertSemanticEquivalenceV102(patch101Manifest, patch102Manifest);
  assertSemanticEquivalenceV102(baseManifest, patch102Manifest);
  assertSemanticEquivalenceV103(patch102Manifest, patch103Manifest);
  if (patch103Manifest.benchmark_version !== PATCH_BENCHMARK_VERSION_V103 ||
      patch103Manifest.patch_classification !== PATCH_CLASSIFICATION_V103) {
    throw adoptionFailure('Target benchmark is not the canonical v1.0.3 provider-adapter addition.');
  }
  const usedAdapters = new Set((runManifest.plan?.models || []).map(model => model.adapter).filter(Boolean));
  if (usedAdapters.has('codex-subscription')) {
    throw adoptionFailure('Historical run used the newly added Codex subscription adapter.');
  }
  return true;
}

export async function validateAdoptionRecordV103({
  recordFile,
  benchmarkRoot,
  manifestFiles,
  sourceRunManifestFile
}) {
  const record = await readJson(recordFile);
  const manifests = {};
  for (const [version, file] of Object.entries(manifestFiles)) manifests[version] = await readJson(file);
  const runManifest = await readJson(sourceRunManifestFile);
  assertHistoricalRunAdoptableV103({
    baseManifest: manifests['1.0'],
    patch101Manifest: manifests['1.0.1'],
    patch102Manifest: manifests['1.0.2'],
    patch103Manifest: manifests['1.0.3'],
    runManifest
  });
  for (const version of ['1.0', '1.0.1', '1.0.2', '1.0.3']) {
    const expected = record.manifest_hashes?.[version];
    if (!expected || await fileHash(manifestFiles[version]) !== expected) {
      throw adoptionFailure(`Benchmark v${version} manifest checksum changed.`);
    }
  }
  const checks = [
    ['source run manifest', sourceRunManifestFile, record.source_run_manifest_sha256],
    ['source cohort record', path.join(benchmarkRoot, record.source_cohort_record), record.source_cohort_record_sha256]
  ];
  for (const [label, file, expected] of checks) {
    if (await fileHash(file) !== expected) throw adoptionFailure(`${label} checksum changed.`);
  }
  for (const artifact of record.source_artifacts || []) {
    if (await fileHash(path.join(benchmarkRoot, artifact.path)) !== artifact.sha256) {
      throw adoptionFailure(`Historical artifact checksum changed: ${artifact.path}.`);
    }
  }
  if (record.target_benchmark_version !== '1.0.3' ||
      record.target_manifest_hash !== record.manifest_hashes['1.0.3'] ||
      record.run_id !== runManifest.run_id ||
      record.eligibility?.changed_adapter_used_by_historical_run !== false ||
      record.eligibility?.source_artifacts_rewritten !== false) {
    throw adoptionFailure('Adoption record identity or immutability attestation is invalid.');
  }
  return { valid: true, record };
}

export async function validateKimiFailureExclusionsV103({ recordFile, benchmarkRoot, targetManifestFile }) {
  const record = await readJson(recordFile);
  if (record.target_benchmark_version !== '1.0.3' ||
      record.target_manifest_hash !== await fileHash(targetManifestFile) ||
      record.excluded_from_scoring !== true ||
      record.excluded_from_import !== true ||
      record.runs?.length !== 2) {
    throw adoptionFailure('Benchmark v1.0.3 Kimi exclusion policy is invalid.');
  }
  const sourceFile = path.join(benchmarkRoot, record.source_exclusion_record);
  if (await fileHash(sourceFile) !== record.source_exclusion_record_sha256) {
    throw adoptionFailure('Source Kimi exclusion record checksum changed.');
  }
  const source = await validateKimiFailureExclusions({ recordFile: sourceFile, benchmarkRoot });
  if (JSON.stringify(record.runs) !== JSON.stringify(source.record.runs)) {
    throw adoptionFailure('Excluded Kimi run identities changed in v1.0.3.');
  }
  return { valid: true, record };
}
