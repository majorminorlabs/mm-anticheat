import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  assertHistoricalRunAdoptableV103,
  validateAdoptionRecordV103,
  validateKimiFailureExclusionsV103
} from '../src/adoption-v1.0.3.mjs';
import { FREEZE_MANIFEST_FILE, validateBenchmarkFreeze } from '../src/freeze.mjs';
import {
  PATCH_MANIFEST_FILE as V101_MANIFEST_FILE,
  validateBenchmarkFreezeV101
} from '../src/freeze-v1.0.1.mjs';
import {
  PATCH_MANIFEST_FILE_V102,
  validateBenchmarkFreezeV102
} from '../src/freeze-v1.0.2.mjs';
import {
  PATCH_MANIFEST_FILE_V103,
  PATCH_MANIFEST_HASH_FILE_V103,
  assertSemanticEquivalenceV103,
  validateBenchmarkFreezeV103
} from '../src/freeze-v1.0.3.mjs';
import { BENCHMARK_ROOT, fileHash, readJson } from '../src/util.mjs';

const HASHES = {
  '1.0': '8a9384f44fd26e2f2ff2bb279bec7460801b777a50c6c712bb8699929265b2ae',
  '1.0.1': '7978cde119b43bb883d6d187aaa55f2b33ca8e3ff0f0b2f9ddde20315623c0b8',
  '1.0.2': 'e71d61e2346adba199dc9a8397a721850c1defee12f4a7a9cff8b1d0c3ef7990',
  '1.0.3': 'cff42b1f55185d4f018de99fc3346e33f5d4f1edf7b93ddefadc36b6c8cab99c'
};
const MANIFEST_FILES = {
  '1.0': FREEZE_MANIFEST_FILE,
  '1.0.1': V101_MANIFEST_FILE,
  '1.0.2': PATCH_MANIFEST_FILE_V102,
  '1.0.3': PATCH_MANIFEST_FILE_V103
};
const ADOPTION_ROOT = path.join(BENCHMARK_ROOT, 'reporting', 'cohorts', 'benchmark-v1.0.3', 'adoptions');
const RUNS = {
  'qwen-v1.0.json': '2026-07-31T00-46-02-939Z-ffa2dbd5',
  'kimi-k3-v1.0.2.json': '2026-07-31T15-04-27-562Z-2ad383b2',
  'kimi-2.7-v1.0.2.json': '2026-07-31T15-45-50-838Z-66820993'
};

test('Benchmark v1.0 through v1.0.3 all validate against canonical checksums', async () => {
  const validations = await Promise.all([
    validateBenchmarkFreeze({ verifyController: false }),
    validateBenchmarkFreezeV101({ verifyController: false }),
    validateBenchmarkFreezeV102({ verifyController: false }),
    validateBenchmarkFreezeV103({ verifyController: false })
  ]);
  assert.deepEqual(validations.map(item => item.benchmark_manifest_hash), Object.values(HASHES));
  assert.equal(
    (await fs.readFile(PATCH_MANIFEST_HASH_FILE_V103, 'utf8')).trim().split(/\s+/)[0],
    HASHES['1.0.3']
  );
});

test('v1.0.3 is editorially equivalent to v1.0.2 and freezes only provider additions', async () => {
  const parent = await readJson(PATCH_MANIFEST_FILE_V102);
  const patch = await readJson(PATCH_MANIFEST_FILE_V103);
  assert.equal(assertSemanticEquivalenceV103(parent, patch), true);
  assert.equal(patch.patch_classification, 'provider_adapter_addition');
  assert.deepEqual(patch.changed_artifacts.map(item => [item.path, item.previous_sha256]), [
    ['src/adapters/codex-subscription.mjs', null],
    ['config/codex-subscription-models.json', null]
  ]);
});

test('v1.0.3 equivalence rejects editorial-semantic and lifecycle changes', async () => {
  const parent = await readJson(PATCH_MANIFEST_FILE_V102);
  const patch = structuredClone(await readJson(PATCH_MANIFEST_FILE_V103));
  patch.prompt_hashes[Object.keys(patch.prompt_hashes)[0]] = '0'.repeat(64);
  assert.throws(() => assertSemanticEquivalenceV103(parent, patch), error => error.code === 'BENCHMARK_SEMANTIC_MISMATCH');
  const lifecyclePatch = structuredClone(await readJson(PATCH_MANIFEST_FILE_V103));
  lifecyclePatch.lifecycle.version = 'changed';
  assert.throws(() => assertSemanticEquivalenceV103(parent, lifecyclePatch), error => error.code === 'BENCHMARK_SEMANTIC_MISMATCH');
});

test('candidate registry contains exactly the five frozen model-plus-reasoning candidates', async () => {
  const registry = await readJson(path.join(BENCHMARK_ROOT, 'versions', 'v1.0.3', 'models.json'));
  assert.deepEqual(registry.models.map(model => [model.id, model.model, model.reasoning]), [
    ['cloud-luna-high', 'gpt-5.6-luna', 'high'],
    ['cloud-luna-xhigh', 'gpt-5.6-luna', 'xhigh'],
    ['cloud-sol-high', 'gpt-5.6-sol', 'high'],
    ['cloud-sol-medium', 'gpt-5.6-sol', 'medium'],
    ['cloud-terra-high', 'gpt-5.6-terra', 'high']
  ]);
  assert.ok(registry.models.every(model => model.adapter === 'codex-subscription'));
});

test('Qwen3 14B, Kimi K3, and Kimi 2.7 adoption records are checksum-bound and valid', async () => {
  for (const [name, runId] of Object.entries(RUNS)) {
    const recordFile = path.join(ADOPTION_ROOT, name);
    const sidecar = path.join(ADOPTION_ROOT, name.replace(/\.json$/, '.sha256'));
    assert.equal(await fileHash(recordFile), (await fs.readFile(sidecar, 'utf8')).trim().split(/\s+/)[0]);
    const result = await validateAdoptionRecordV103({
      recordFile,
      benchmarkRoot: BENCHMARK_ROOT,
      manifestFiles: MANIFEST_FILES,
      sourceRunManifestFile: path.join(BENCHMARK_ROOT, 'generated', runId, 'private', 'run-manifest.json')
    });
    assert.equal(result.valid, true);
    assert.equal(result.record.run_id, runId);
  }
});

test('v1.0.3 adoption rejects a run that used the new Codex adapter', async () => {
  const manifests = Object.fromEntries(await Promise.all(
    Object.entries(MANIFEST_FILES).map(async ([version, file]) => [version, await readJson(file)])
  ));
  assert.throws(
    () => assertHistoricalRunAdoptableV103({
      baseManifest: manifests['1.0'],
      patch101Manifest: manifests['1.0.1'],
      patch102Manifest: manifests['1.0.2'],
      patch103Manifest: manifests['1.0.3'],
      runManifest: { plan: { models: [{ adapter: 'codex-subscription' }] } }
    }),
    error => error.code === 'BENCHMARK_ADOPTION_REJECTED' && /newly added/.test(error.message)
  );
});

test('both failed Kimi runs remain checksum-bound and excluded in v1.0.3', async () => {
  const recordFile = path.join(BENCHMARK_ROOT, 'reporting', 'cohorts', 'benchmark-v1.0.3', 'exclusions', 'kimi-adapter-failures.json');
  const sidecar = recordFile.replace(/\.json$/, '.sha256');
  assert.equal(await fileHash(recordFile), (await fs.readFile(sidecar, 'utf8')).trim().split(/\s+/)[0]);
  const result = await validateKimiFailureExclusionsV103({
    recordFile,
    benchmarkRoot: BENCHMARK_ROOT,
    targetManifestFile: PATCH_MANIFEST_FILE_V103
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.record.runs.map(run => run.run_id), [
    '2026-07-31T02-40-43-194Z-ee938a2b',
    '2026-07-31T13-24-46-531Z-5a93820a'
  ]);
});

test('historical manifests, run manifests, review packages, and score locks remain unchanged', async () => {
  const expected = {
    'config/benchmark-v1.0.json': HASHES['1.0'],
    'config/benchmark-v1.0.1.json': HASHES['1.0.1'],
    'config/benchmark-v1.0.2.json': HASHES['1.0.2'],
    'generated/2026-07-31T00-46-02-939Z-ffa2dbd5/private/run-manifest.json': '8eeb728a26f7ed8a5b2baaf687f24b16cf9487d0a08d9eb8b9fd561884620525',
    'generated/2026-07-31T15-04-27-562Z-2ad383b2/private/run-manifest.json': 'eccef3cc0979a66954c0d1f50876b70f98d32fdc8d6c0ff2e44e8ff4304338f9',
    'generated/2026-07-31T15-45-50-838Z-66820993/private/run-manifest.json': '55073551d806d49842a70b1a6947b326e36196bfe7d51f1f42539647189f4e13',
    'reporting/cohorts/benchmark-v1.0.2/review-locks/kimi-k3.json': 'f8423c38fd37b668cebfa31207989268e8db0f91958261db12779904c8af8dff',
    'reporting/cohorts/benchmark-v1.0.2/review-locks/kimi-2.7.json': '775fae0a8e799ce308f8fceb4c84c00c975c3d359737f856c26e802f3b0c197f'
  };
  for (const [relative, hash] of Object.entries(expected)) {
    assert.equal(await fileHash(path.join(BENCHMARK_ROOT, relative)), hash, relative);
  }
});
