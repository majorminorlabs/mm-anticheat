import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  aggregateV103Results,
  generateV103Reports,
  writeV103Outputs
} from '../reporting/cohorts/benchmark-v1.0.3/results.mjs';
import { stableStringify } from '../reporting/cohorts/benchmark-v1.0.2/results.mjs';

const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cohortRoot = path.join(benchmarkRoot, 'reporting', 'cohorts', 'benchmark-v1.0.3');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

test('native Codex score locks preserve all supplied canonical hashes', async () => {
  const expectations = {
    'luna-high.json': {
      'apple-digital-repo': 'b17decf1ffaec86343ed2aad547845f5c6a8602efb0410b213b2119e0da2f6b1',
      logitech: '0210b9252e0aa853011fb67c834660fd6ef0d82848fbabdf6a507dfd93f0bcb9'
    },
    'luna-xhigh.json': {
      'apple-digital-repo': '3e7ba137f399ad1e4be1b1018b0069cf583e4c12718b63b05928ca77f336049a',
      logitech: 'd6284fcf8356d3f8fd5bc708d8a3c5eaaad28f989020337f5f4726abf3e27354'
    },
    'terra-high.json': {
      'apple-digital-repo': 'e578fa1aacd1bf52c2800d95f473eefc5e7dd9b1cda108bed136de0f9fe2e5fc',
      logitech: '1e206b70fb2373f08f346f30db3a036dae8422db476359906d77cdd75116e880'
    },
    'sol-medium.json': {
      'apple-digital-repo': 'df180f996c7742b834e468ce36e98601b35888a54d031cff3cb124b677087817',
      logitech: 'a8f852ea1f69d0b6cb8a2927358796e3af08e8ae73d674777b9cfedcd65dfa45'
    }
  };
  for (const [name, expected] of Object.entries(expectations)) {
    const lock = JSON.parse(await fs.readFile(path.join(cohortRoot, 'review-locks', name), 'utf8'));
    assert.equal(lock.lock_status, 'locked');
    for (const item of lock.records) {
      assert.equal(item.canonical_sha256, expected[item.record.fixture]);
      assert.equal(sha256(stableStringify(item.record)), expected[item.record.fixture]);
    }
  }
});

test('v1.0.3 cohort contains three adopted models and four native Codex runs only', async () => {
  const index = await aggregateV103Results({ benchmarkRoot });
  assert.equal(index.benchmark_manifest_hash, 'cff42b1f55185d4f018de99fc3346e33f5d4f1edf7b93ddefadc36b6c8cab99c');
  assert.deepEqual(index.models.map(item => item.model_identifier), [
    'cloud-luna-xhigh',
    'cloud-terra-high',
    'cloud-luna-high',
    'cloud-sol-medium',
    'cloud-kimi-k3',
    'cloud-kimi-2-7',
    'local-qwen3-14b'
  ]);
  assert.equal(index.models.filter(item => item.benchmark.adoption).length, 3);
  assert.deepEqual(index.excluded_runs.map(item => item.run_id), [
    '2026-07-31T02-40-43-194Z-ee938a2b',
    '2026-07-31T13-24-46-531Z-5a93820a'
  ]);
});

test('Codex quality, reliability, runtime, and token usage remain separate', async () => {
  const index = await aggregateV103Results({ benchmarkRoot });
  const luna = index.models.find(item => item.model_identifier === 'cloud-luna-high');
  const xhigh = index.models.find(item => item.model_identifier === 'cloud-luna-xhigh');
  const terra = index.models.find(item => item.model_identifier === 'cloud-terra-high');
  const sol = index.models.find(item => item.model_identifier === 'cloud-sol-medium');
  assert.equal(luna.fixture_scores['apple-digital-repo'].completed_stage_average, 8.6);
  assert.equal(luna.fixture_scores.logitech.completed_stage_average, 7.6);
  assert.deepEqual(luna.quality, { completed_stage_human_average: 8.1, scored_stage_count: 10 });
  assert.deepEqual(luna.stage_completion, { completed_count: 10, planned_count: 10, rate: 1 });
  assert.deepEqual(luna.structured_output_compliance, { compliant_count: 10, attempted_count: 10, rate: 1 });
  assert.equal(luna.token_usage.stages_with_provider_usage, 10);
  assert.ok(luna.token_usage.input_tokens > 0);
  assert.ok(luna.token_usage.output_tokens > 0);
  assert.ok(luna.runtime.benchmark_wall_ms > luna.runtime.attempted_stage_wall_ms);
  assert.equal(xhigh.fixture_scores['apple-digital-repo'].completed_stage_average, 8.4);
  assert.equal(xhigh.fixture_scores.logitech.completed_stage_average, 8);
  assert.deepEqual(xhigh.quality, { completed_stage_human_average: 8.2, scored_stage_count: 10 });
  assert.deepEqual(xhigh.stage_completion, { completed_count: 10, planned_count: 10, rate: 1 });
  assert.deepEqual(xhigh.structured_output_compliance, { compliant_count: 10, attempted_count: 10, rate: 1 });
  assert.equal(xhigh.token_usage.input_tokens, 243835);
  assert.equal(xhigh.token_usage.cached_input_tokens, 9728);
  assert.equal(xhigh.token_usage.output_tokens, 36323);
  assert.equal(xhigh.token_usage.reasoning_output_tokens, 27525);
  assert.equal(terra.fixture_scores['apple-digital-repo'].completed_stage_average, 8.4);
  assert.equal(terra.fixture_scores.logitech.completed_stage_average, 8);
  assert.deepEqual(terra.quality, { completed_stage_human_average: 8.2, scored_stage_count: 10 });
  assert.deepEqual(terra.stage_completion, { completed_count: 10, planned_count: 10, rate: 1 });
  assert.deepEqual(terra.structured_output_compliance, { compliant_count: 10, attempted_count: 10, rate: 1 });
  assert.equal(terra.runtime.benchmark_wall_ms, 231956);
  assert.equal(terra.runtime.attempted_stage_wall_ms, 224744.48);
  assert.equal(terra.token_usage.input_tokens, 243535);
  assert.equal(terra.token_usage.cached_input_tokens, 29184);
  assert.equal(terra.token_usage.output_tokens, 10761);
  assert.equal(terra.token_usage.reasoning_output_tokens, 3699);
  assert.equal(sol.fixture_scores['apple-digital-repo'].completed_stage_average, 8.2);
  assert.equal(sol.fixture_scores.logitech.completed_stage_average, 8);
  assert.deepEqual(sol.quality, { completed_stage_human_average: 8.1, scored_stage_count: 10 });
  assert.deepEqual(sol.stage_completion, { completed_count: 10, planned_count: 10, rate: 1 });
  assert.deepEqual(sol.structured_output_compliance, { compliant_count: 10, attempted_count: 10, rate: 1 });
  assert.equal(sol.runtime.benchmark_wall_ms, 375077);
  assert.equal(sol.runtime.attempted_stage_wall_ms, 368086.73);
  assert.equal(sol.token_usage.input_tokens, 243971);
  assert.equal(sol.token_usage.cached_input_tokens, 15104);
  assert.equal(sol.token_usage.output_tokens, 15125);
  assert.equal(sol.token_usage.reasoning_output_tokens, 4263);
});

test('v1.0.3 reports include runtime and retain stage ties', async () => {
  const reports = generateV103Reports(await aggregateV103Results({ benchmarkRoot }));
  assert.deepEqual(Object.keys(reports).sort(), [
    'executive-summary.md',
    'final-model-comparison.md',
    'historical-report.md',
    'leaderboard.md',
    'publication-report.md',
    'reliability-report.md',
    'runtime-usage-report.md',
    'stage-specialists.md'
  ]);
  assert.match(reports['stage-specialists.md'], /Reviewer: cloud-luna-high, cloud-sol-medium, cloud-kimi-k3, cloud-kimi-2-7 \(9\.00\)/);
  assert.match(reports['stage-specialists.md'], /Evidence Selector: cloud-terra-high \(9\.00\)/);
  assert.match(reports['stage-specialists.md'], /Research Planner: cloud-luna-xhigh, cloud-terra-high, cloud-luna-high, cloud-sol-medium \(9\.00\)/);
  assert.match(reports['leaderboard.md'], /cloud-luna-xhigh[^\n]+8\.40[^\n]+8\.00[^\n]+8\.20[^\n]+100\.00%/);
  assert.match(reports['leaderboard.md'], /cloud-luna-high[^\n]+8\.60[^\n]+7\.60[^\n]+8\.10[^\n]+100\.00%/);
  assert.match(reports['leaderboard.md'], /cloud-terra-high[^\n]+8\.40[^\n]+8\.00[^\n]+8\.20[^\n]+100\.00%/);
  assert.match(reports['leaderboard.md'], /cloud-sol-medium[^\n]+8\.20[^\n]+8\.00[^\n]+8\.10[^\n]+100\.00%/);
  assert.match(reports['runtime-usage-report.md'], /cloud-luna-xhigh[^\n]+10\/10/);
  assert.match(reports['runtime-usage-report.md'], /cloud-luna-high[^\n]+10\/10/);
  assert.match(reports['runtime-usage-report.md'], /cloud-terra-high[^\n]+243535[^\n]+29184[^\n]+10761[^\n]+3699[^\n]+10\/10/);
  assert.match(reports['runtime-usage-report.md'], /cloud-sol-medium[^\n]+243971[^\n]+15104[^\n]+15125[^\n]+4263[^\n]+10\/10/);
  assert.match(reports['final-model-comparison.md'], /Best quality per runtime minute among complete runs: cloud-terra-high \(2\.12\)/);
  assert.match(reports['final-model-comparison.md'], /The completed campaign is sufficient to begin human-supervised pipeline design/);
});

test('v1.0.3 writer emits only the requested derived outputs', async t => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-v103-reporting-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const index = await aggregateV103Results({ benchmarkRoot });
  const names = await writeV103Outputs({ index, outputDir });
  assert.deepEqual((await fs.readdir(outputDir)).sort(), [...names, 'results-index.json'].sort());
});
