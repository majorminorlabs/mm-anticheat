import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertHistoricalRunAdoptable,
  validateAdoptionRecord
} from '../src/adoption-v1.0.1.mjs';
import {
  FREEZE_MANIFEST_FILE,
  validateBenchmarkFreeze
} from '../src/freeze.mjs';
import {
  PATCH_MANIFEST_FILE,
  PATCH_MANIFEST_HASH_FILE,
  assertSemanticEquivalence,
  validateBenchmarkFreezeV101
} from '../src/freeze-v1.0.1.mjs';
import { BENCHMARK_ROOT, fileHash, readJson } from '../src/util.mjs';

const V100_MANIFEST_HASH = '8a9384f44fd26e2f2ff2bb279bec7460801b777a50c6c712bb8699929265b2ae';
const V100_KIMI_ADAPTER_HASH = 'ce3a113c5e1ebd21d1b11fae8cf19faf8449afd62c27912a31632c3b90e501ae';
const QWEN_RUN = '2026-07-31T00-46-02-939Z-ffa2dbd5';
const ADOPTION_RECORD = path.join(
  BENCHMARK_ROOT,
  'reporting',
  'cohorts',
  'benchmark-v1.0.1',
  'adoptions',
  'qwen-v1.0.json'
);

test('Benchmark v1.0 remains valid and byte-identical after the patch release', async () => {
  const validation = await validateBenchmarkFreeze({ verifyController: false });
  assert.equal(validation.benchmark_manifest_hash, V100_MANIFEST_HASH);
  assert.equal(await fileHash(path.join(BENCHMARK_ROOT, 'src', 'adapters', 'kimi-code.mjs')), V100_KIMI_ADAPTER_HASH);
});

test('Benchmark v1.0.1 freeze validates against its locked checksum', async () => {
  const validation = await validateBenchmarkFreezeV101({ verifyController: false });
  assert.equal(validation.benchmark_version, '1.0.1');
  assert.equal(
    validation.benchmark_manifest_hash,
    (await fs.readFile(PATCH_MANIFEST_HASH_FILE, 'utf8')).trim().split(/\s+/)[0]
  );
});

test('Benchmark v1.0 and v1.0.1 editorial semantics are exactly equivalent', async () => {
  const parent = await readJson(FREEZE_MANIFEST_FILE);
  const patch = await readJson(PATCH_MANIFEST_FILE);
  assert.equal(assertSemanticEquivalence(parent, patch), true);
});

test('adoption rejects any editorial-semantic artifact change', async () => {
  const parent = await readJson(FREEZE_MANIFEST_FILE);
  const patch = structuredClone(await readJson(PATCH_MANIFEST_FILE));
  const runManifest = await readJson(path.join(
    BENCHMARK_ROOT,
    'generated',
    QWEN_RUN,
    'private',
    'run-manifest.json'
  ));
  patch.prompt_hashes['prompts/draft.md'] = 'f'.repeat(64);
  assert.throws(
    () => assertHistoricalRunAdoptable({ parentManifest: parent, patchManifest: patch, runManifest }),
    error => error.code === 'BENCHMARK_SEMANTIC_MISMATCH'
  );
});

test('adoption rejects a historical run that used the changed adapter', async () => {
  const parent = await readJson(FREEZE_MANIFEST_FILE);
  const patch = await readJson(PATCH_MANIFEST_FILE);
  const runManifest = {
    plan: {
      models: [{ id: 'historical-kimi', adapter: 'kimi-code' }]
    }
  };
  assert.throws(
    () => assertHistoricalRunAdoptable({ parentManifest: parent, patchManifest: patch, runManifest }),
    error => error.code === 'BENCHMARK_ADOPTION_REJECTED'
      && /used changed adapter/.test(error.message)
  );
});

test('checksum-bound Qwen v1.0 adoption into the v1.0.1 cohort validates', async () => {
  const lockedRecordHash = (await fs.readFile(
    path.join(path.dirname(ADOPTION_RECORD), 'qwen-v1.0.sha256'),
    'utf8'
  )).trim().split(/\s+/)[0];
  assert.equal(await fileHash(ADOPTION_RECORD), lockedRecordHash);
  const result = await validateAdoptionRecord({
    recordFile: ADOPTION_RECORD,
    benchmarkRoot: BENCHMARK_ROOT,
    parentManifestFile: FREEZE_MANIFEST_FILE,
    patchManifestFile: PATCH_MANIFEST_FILE,
    sourceRunManifestFile: path.join(
      BENCHMARK_ROOT,
      'generated',
      QWEN_RUN,
      'private',
      'run-manifest.json'
    )
  });
  assert.equal(result.valid, true);
  assert.equal(result.record.model_identifier, 'local-qwen3-14b');
});
