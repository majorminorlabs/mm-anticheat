import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  aggregateV102Results,
  generateV102Reports,
  stableStringify,
  writeV102Outputs
} from '../reporting/cohorts/benchmark-v1.0.2/results.mjs';

const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cohortRoot = path.join(benchmarkRoot, 'reporting', 'cohorts', 'benchmark-v1.0.2');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const EXPECTED_RECORD_HASHES = {
  '2026-07-31T15-04-27-562Z-2ad383b2/apple-digital-repo': '03534f96af2ed0763863b7e8c6adaa1f346240db09569ed99ab68f2a35381419',
  '2026-07-31T15-04-27-562Z-2ad383b2/logitech': 'd37a43b2cc99002ce86d2ac7e43d4e94a5ebd3cb62a7841ef56ce9bbed5746db',
  '2026-07-31T15-45-50-838Z-66820993/apple-digital-repo': 'e94f5863fb8a1a81ff5b5c8092eca037bbf2ffba325452db5af910e94ce2e855',
  '2026-07-31T15-45-50-838Z-66820993/logitech': 'f0dc261069b5d628e5de09ea14196d8a38db21e313abbe50f7dffdc1cdd8fd64'
};

test('v1.0.2 native score locks preserve the four supplied canonical hashes', async () => {
  for (const name of ['kimi-k3.json', 'kimi-2.7.json']) {
    const lock = JSON.parse(await fs.readFile(path.join(cohortRoot, 'review-locks', name), 'utf8'));
    assert.equal(lock.lock_status, 'locked');
    for (const item of lock.records) {
      const key = `${item.record.run_id}/${item.record.fixture}`;
      assert.equal(item.canonical_sha256, EXPECTED_RECORD_HASHES[key]);
      assert.equal(sha256(stableStringify(item.record)), EXPECTED_RECORD_HASHES[key]);
    }
  }
});

test('v1.0.2 aggregation imports adopted Qwen and both official Kimi runs only', async () => {
  const index = await aggregateV102Results({ benchmarkRoot });
  assert.equal(index.benchmark_version, '1.0.2');
  assert.equal(index.benchmark_manifest_hash, 'e71d61e2346adba199dc9a8397a721850c1defee12f4a7a9cff8b1d0c3ef7990');
  assert.deepEqual(index.models.map(item => item.model_identifier), [
    'cloud-kimi-k3',
    'cloud-kimi-2-7',
    'local-qwen3-14b'
  ]);
  assert.deepEqual(index.excluded_runs.map(item => item.run_id), [
    '2026-07-31T02-40-43-194Z-ee938a2b',
    '2026-07-31T13-24-46-531Z-5a93820a'
  ]);
});

test('quality excludes missing scores while reliability retains failures', async () => {
  const index = await aggregateV102Results({ benchmarkRoot });
  const k3 = index.models.find(item => item.model_identifier === 'cloud-kimi-k3');
  const k27 = index.models.find(item => item.model_identifier === 'cloud-kimi-2-7');
  const qwen = index.models.find(item => item.model_identifier === 'local-qwen3-14b');
  assert.deepEqual(k3.quality, { completed_stage_human_average: 8, scored_stage_count: 4 });
  assert.deepEqual(k3.stage_completion, { completed_count: 4, planned_count: 10, rate: 0.4 });
  assert.deepEqual(k3.structured_output_compliance, { compliant_count: 4, attempted_count: 8, rate: 0.5 });
  assert.equal(k3.fixture_scores.logitech.completed_stage_average, null);
  assert.deepEqual(k27.quality, { completed_stage_human_average: 7.5, scored_stage_count: 4 });
  assert.equal(k27.coverage.fixture_rate, 1);
  assert.deepEqual(qwen.quality, { completed_stage_human_average: 4.11, scored_stage_count: 9 });
  assert.equal(qwen.stage_completion.rate, 0.9);
  assert.equal(qwen.timeout_statistics.count, 1);
});

test('v1.0.2 reports retain ties and all reliability measures', async () => {
  const index = await aggregateV102Results({ benchmarkRoot });
  const reports = generateV102Reports(index);
  assert.deepEqual(Object.keys(reports).sort(), [
    'executive-summary.md',
    'historical-report.md',
    'leaderboard.md',
    'publication-report.md',
    'reliability-report.md',
    'stage-specialists.md'
  ]);
  assert.match(reports['stage-specialists.md'], /Reviewer: cloud-kimi-k3, cloud-kimi-2-7 \(9\.00\)/);
  assert.match(reports['leaderboard.md'], /cloud-kimi-k3[^\n]+8\.00[^\n]+50\.00%[^\n]+40\.00%[^\n]+50\.00%/);
  assert.match(reports['publication-report.md'], /light edit: 1/);
  assert.match(reports['publication-report.md'], /unsuitable: 2/);
});

test('v1.0.2 report writer creates only the canonical derived outputs', async t => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-v102-reporting-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const index = await aggregateV102Results({ benchmarkRoot });
  const names = await writeV102Outputs({ index, outputDir });
  const written = (await fs.readdir(outputDir)).sort();
  assert.deepEqual(written, [...names, 'results-index.json'].sort());
});
