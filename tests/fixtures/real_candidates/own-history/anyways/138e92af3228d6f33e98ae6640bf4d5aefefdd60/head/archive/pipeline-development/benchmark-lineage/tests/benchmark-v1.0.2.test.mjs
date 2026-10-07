import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertHistoricalRunAdoptableV102,
  validateAdoptionRecordV102,
  validateKimiFailureExclusions
} from '../src/adoption-v1.0.2.mjs';
import {
  FREEZE_MANIFEST_FILE,
  validateBenchmarkFreeze
} from '../src/freeze.mjs';
import {
  PATCH_MANIFEST_FILE as V101_MANIFEST_FILE,
  validateBenchmarkFreezeV101
} from '../src/freeze-v1.0.1.mjs';
import {
  PATCH_MANIFEST_FILE_V102,
  PATCH_MANIFEST_HASH_FILE_V102,
  assertSemanticEquivalenceV102,
  validateBenchmarkFreezeV102
} from '../src/freeze-v1.0.2.mjs';
import { BENCHMARK_ROOT, fileHash, readJson } from '../src/util.mjs';

const V100_MANIFEST_HASH = '8a9384f44fd26e2f2ff2bb279bec7460801b777a50c6c712bb8699929265b2ae';
const V101_MANIFEST_HASH = '7978cde119b43bb883d6d187aaa55f2b33ca8e3ff0f0b2f9ddde20315623c0b8';
const V102_MANIFEST_HASH = 'e71d61e2346adba199dc9a8397a721850c1defee12f4a7a9cff8b1d0c3ef7990';
const V100_KIMI_ADAPTER_HASH = 'ce3a113c5e1ebd21d1b11fae8cf19faf8449afd62c27912a31632c3b90e501ae';
const V101_KIMI_ADAPTER_HASH = '694307671fcda72151d52b6bd7f9acb7346360b74d3413cec4b4821b3ff2d5b5';
const PROTECTED_BASELINE_HASH = 'f4460dd65c0006ffb5ea605685a647896851839554781d7a377d1f89d740ea80';
const QWEN_RUN = '2026-07-31T00-46-02-939Z-ffa2dbd5';
const ADOPTION_RECORD = path.join(BENCHMARK_ROOT, 'reporting', 'cohorts', 'benchmark-v1.0.2', 'adoptions', 'qwen-v1.0.json');
const EXCLUSION_RECORD = path.join(BENCHMARK_ROOT, 'reporting', 'cohorts', 'benchmark-v1.0.2', 'exclusions', 'kimi-adapter-failures.json');

async function addFiles(files, target) {
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) {
    files.push(target);
    return;
  }
  for (const name of (await fs.readdir(target)).sort()) {
    await addFiles(files, path.join(target, name));
  }
}

async function protectedBaselineHash() {
  const roots = [
    'config/benchmark-v1.0.json',
    'config/benchmark-v1.0.sha256',
    'config/benchmark-v1.0.1.json',
    'config/benchmark-v1.0.1.sha256',
    'docs/BENCHMARK_V1.0.md',
    'docs/BENCHMARK_V1.0.1.md',
    'versions/v1.0.1',
    'reporting/cohorts/benchmark-v1.0.1',
    'generated/2026-07-31T00-46-02-939Z-ffa2dbd5',
    'generated/2026-07-31T02-40-43-194Z-ee938a2b',
    'generated/2026-07-31T13-24-46-531Z-5a93820a',
    'results/benchmark-v1.0'
  ];
  const files = [];
  for (const relative of roots) await addFiles(files, path.join(BENCHMARK_ROOT, relative));
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(path.dirname(BENCHMARK_ROOT), file));
    hash.update('\0');
    hash.update(await fs.readFile(file));
    hash.update('\0');
  }
  return { fileCount: files.length, sha256: hash.digest('hex') };
}

test('Benchmark v1.0 and v1.0.1 remain valid and byte-identical', async () => {
  const v100 = await validateBenchmarkFreeze({ verifyController: false });
  const v101 = await validateBenchmarkFreezeV101({ verifyController: false });
  assert.equal(v100.benchmark_manifest_hash, V100_MANIFEST_HASH);
  assert.equal(v101.benchmark_manifest_hash, V101_MANIFEST_HASH);
  assert.equal(await fileHash(path.join(BENCHMARK_ROOT, 'src', 'adapters', 'kimi-code.mjs')), V100_KIMI_ADAPTER_HASH);
  assert.equal(await fileHash(path.join(BENCHMARK_ROOT, 'versions', 'v1.0.1', 'src', 'adapters', 'kimi-code.mjs')), V101_KIMI_ADAPTER_HASH);
  assert.deepEqual(await protectedBaselineHash(), { fileCount: 66, sha256: PROTECTED_BASELINE_HASH });
});

test('Benchmark v1.0.2 freeze validates against its locked checksum', async () => {
  const validation = await validateBenchmarkFreezeV102({ verifyController: false });
  assert.equal(validation.benchmark_version, '1.0.2');
  assert.equal(validation.benchmark_manifest_hash, V102_MANIFEST_HASH);
  assert.equal(
    validation.benchmark_manifest_hash,
    (await fs.readFile(PATCH_MANIFEST_HASH_FILE_V102, 'utf8')).trim().split(/\s+/)[0]
  );
});

test('v1.0, v1.0.1, and v1.0.2 editorial semantics are equivalent', async () => {
  const base = await readJson(FREEZE_MANIFEST_FILE);
  const parent = await readJson(V101_MANIFEST_FILE);
  const patch = await readJson(PATCH_MANIFEST_FILE_V102);
  assert.equal(assertSemanticEquivalenceV102(base, parent), true);
  assert.equal(assertSemanticEquivalenceV102(parent, patch), true);
  assert.equal(assertSemanticEquivalenceV102(base, patch), true);
});

test('v1.0.2 semantic equivalence rejects any editorial-semantic change', async () => {
  const parent = await readJson(V101_MANIFEST_FILE);
  const patch = structuredClone(await readJson(PATCH_MANIFEST_FILE_V102));
  patch.schema_hashes['schemas/article-output.schema.json'] = 'f'.repeat(64);
  assert.throws(
    () => assertSemanticEquivalenceV102(parent, patch),
    error => error.code === 'BENCHMARK_SEMANTIC_MISMATCH'
  );
});

test('Qwen v1.0 is eligible for checksum-bound v1.0.2 adoption', async () => {
  const lockedRecordHash = (await fs.readFile(`${ADOPTION_RECORD.slice(0, -5)}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  assert.equal(await fileHash(ADOPTION_RECORD), lockedRecordHash);
  const result = await validateAdoptionRecordV102({
    recordFile: ADOPTION_RECORD,
    benchmarkRoot: BENCHMARK_ROOT,
    baseManifestFile: FREEZE_MANIFEST_FILE,
    parentManifestFile: V101_MANIFEST_FILE,
    patchManifestFile: PATCH_MANIFEST_FILE_V102,
    sourceRunManifestFile: path.join(BENCHMARK_ROOT, 'generated', QWEN_RUN, 'private', 'run-manifest.json')
  });
  assert.equal(result.valid, true);
  assert.equal(result.record.model_identifier, 'local-qwen3-14b');
});

test('v1.0.2 adoption rejects historical use of either changed Kimi adapter', async () => {
  const base = await readJson(FREEZE_MANIFEST_FILE);
  const parent = await readJson(V101_MANIFEST_FILE);
  const patch = await readJson(PATCH_MANIFEST_FILE_V102);
  assert.throws(
    () => assertHistoricalRunAdoptableV102({
      baseManifest: base,
      parentManifest: parent,
      patchManifest: patch,
      runManifest: { plan: { models: [{ adapter: 'kimi-code' }] } }
    }),
    error => error.code === 'BENCHMARK_ADOPTION_REJECTED' && /used changed adapter/.test(error.message)
  );
});

test('both failed Kimi runs are checksum-bound and excluded from scoring and import', async () => {
  const lockedRecordHash = (await fs.readFile(`${EXCLUSION_RECORD.slice(0, -5)}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  assert.equal(await fileHash(EXCLUSION_RECORD), lockedRecordHash);
  const result = await validateKimiFailureExclusions({ recordFile: EXCLUSION_RECORD, benchmarkRoot: BENCHMARK_ROOT });
  assert.equal(result.valid, true);
  assert.deepEqual(result.record.runs.map(run => run.run_id), [
    '2026-07-31T02-40-43-194Z-ee938a2b',
    '2026-07-31T13-24-46-531Z-5a93820a'
  ]);
});
