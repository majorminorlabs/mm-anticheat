import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  aggregateBenchmarkResults,
  compareLeaderboard,
  generateReports
} from '../reporting/results.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function scoreContent(fixture) {
  const content = {
    fixture: fixture.fixture,
    candidate: fixture.candidate,
    scores: fixture.scores
  };
  if (fixture.incomplete_stages) content.incomplete_stages = fixture.incomplete_stages;
  content.publication_readiness = fixture.publication_readiness;
  content.confidence = fixture.confidence;
  return content;
}

async function reportingWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-reporting-test-'));
  const benchmarkRoot = path.join(root, 'pipeline-benchmark');
  const manifestFile = path.join(benchmarkRoot, 'config', 'benchmark-v1.0.json');
  const manifest = {
    benchmark_version: '1.0',
    benchmark_repository: { commit: 'benchmark-commit' },
    controller_repository: { commit: 'controller-commit' }
  };
  await writeJson(manifestFile, manifest);
  const manifestHash = sha256(await fs.readFile(manifestFile));
  await fs.writeFile(
    path.join(benchmarkRoot, 'config', 'benchmark-v1.0.sha256'),
    `${manifestHash}  benchmark-v1.0.json\n`
  );

  const addRun = async ({
    runId,
    model = runId,
    version = '1.0',
    hash = manifestHash,
    timestamp = '2026-08-01T00:00:00.000Z',
    timeout = false,
    overallScores = [8, 8],
    readiness = 'light edit'
  }) => {
    const fixtures = ['apple-digital-repo', 'logitech'].map((fixture, fixtureIndex) => {
      const value = overallScores[fixtureIndex];
      const item = {
        fixture,
        candidate: 'Candidate A',
        scores: {
          draft: value,
          revision: value,
          reviewer: value,
          evidence_selector: value,
          research_planner: value
        },
        publication_readiness: readiness,
        confidence: 'high'
      };
      item.content_sha256 = sha256(JSON.stringify(scoreContent(item)));
      return item;
    });
    const lockFile = path.join(benchmarkRoot, 'reporting', 'review-locks', `${model}.json`);
    await writeJson(lockFile, {
      schema_version: '1.0.0',
      lock_status: 'locked',
      candidate: 'Candidate A',
      model_identifier: model,
      fixtures
    });
    const stages = ['draft', 'revision', 'reviewer', 'evidence_selector', 'research_planner'];
    const stageResults = [];
    for (const fixture of fixtures) {
      for (const stage of stages) {
        const failed = timeout && fixture.fixture === 'logitech' && stage === 'evidence_selector';
        stageResults.push({
          model_id: model,
          fixture_id: fixture.fixture,
          stage,
          status: failed ? 'failed' : 'completed',
          elapsed_ms: failed ? 600000 : 1000,
          ...(failed ? { failure: { classification: 'model_generation_timeout', reason: 'timeout' } } : {})
        });
      }
    }
    await writeJson(path.join(benchmarkRoot, 'generated', runId, 'private', 'run-manifest.json'), {
      run_id: runId,
      status: timeout ? 'completed_with_failures' : 'completed',
      started_at: timestamp,
      finished_at: new Date(Date.parse(timestamp) + 1000).toISOString(),
      benchmark_metadata: {
        benchmark_version: version,
        benchmark_manifest_hash: hash,
        model_identifier: model,
        provider: 'test-provider',
        model_digest: `${model}-digest`
      },
      plan: {
        fixture_ids: fixtures.map(item => item.fixture),
        stages,
        models: [{ id: model, provider: 'test-provider' }]
      },
      stage_results: stageResults,
      production_restore: { status: 'restored', failures: [] }
    });
    return runId;
  };

  return {
    root,
    benchmarkRoot,
    manifestHash,
    addRun,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

test('reporting imports a newly completed Benchmark v1.0 run', async t => {
  const workspace = await reportingWorkspace();
  t.after(workspace.cleanup);
  await workspace.addRun({ runId: 'run-new', model: 'model-new', timeout: true });
  const index = await aggregateBenchmarkResults({ benchmarkRoot: workspace.benchmarkRoot });
  assert.equal(index.indexed_model_count, 1);
  assert.equal(index.models[0].model_identifier, 'model-new');
  assert.equal(index.models[0].timeout_statistics.count, 1);
  assert.equal(index.models[0].stage_durations_ms['logitech/evidence_selector'], 600000);
});

test('reporting prevents duplicate run IDs', async t => {
  const workspace = await reportingWorkspace();
  t.after(workspace.cleanup);
  const runId = await workspace.addRun({ runId: 'run-once', model: 'model-once' });
  const index = await aggregateBenchmarkResults({
    benchmarkRoot: workspace.benchmarkRoot,
    runIds: [runId, runId]
  });
  assert.equal(index.indexed_model_count, 1);
  assert.deepEqual(index.excluded_runs, [{ run_id: runId, reason: 'duplicate run' }]);
});

test('reporting filters non-v1.0 benchmark versions', async t => {
  const workspace = await reportingWorkspace();
  t.after(workspace.cleanup);
  await workspace.addRun({ runId: 'run-old', model: 'model-old', version: '0.9' });
  const index = await aggregateBenchmarkResults({ benchmarkRoot: workspace.benchmarkRoot });
  assert.equal(index.indexed_model_count, 0);
  assert.equal(index.excluded_runs[0].reason, 'benchmark version mismatch');
});

test('reporting filters mismatched benchmark manifest hashes', async t => {
  const workspace = await reportingWorkspace();
  t.after(workspace.cleanup);
  await workspace.addRun({ runId: 'run-drift', model: 'model-drift', hash: 'f'.repeat(64) });
  const index = await aggregateBenchmarkResults({ benchmarkRoot: workspace.benchmarkRoot });
  assert.equal(index.indexed_model_count, 0);
  assert.equal(index.excluded_runs[0].reason, 'benchmark manifest mismatch');
});

test('leaderboard ordering uses score, timeouts, readiness, then timestamp', () => {
  const row = (id, score, timeouts, readiness, timestamp) => ({
    model_identifier: id,
    overall_average: score,
    timeout_statistics: { count: timeouts },
    publication_readiness: { summary: readiness },
    run: { execution_timestamp: timestamp }
  });
  const rows = [
    row('late', 8, 0, 'light edit', '2026-08-02T00:00:00.000Z'),
    row('timeout', 8, 1, 'publish with no edits', '2026-08-01T00:00:00.000Z'),
    row('readiness', 8, 0, 'moderate edit', '2026-07-31T00:00:00.000Z'),
    row('best', 9, 5, 'unsuitable', '2026-08-03T00:00:00.000Z'),
    row('early', 8, 0, 'light edit', '2026-08-01T00:00:00.000Z')
  ].sort(compareLeaderboard);
  assert.deepEqual(rows.map(item => item.model_identifier), [
    'best',
    'early',
    'late',
    'readiness',
    'timeout'
  ]);
});

test('report generation emits every canonical report', async t => {
  const workspace = await reportingWorkspace();
  t.after(workspace.cleanup);
  await workspace.addRun({ runId: 'run-report', model: 'model-report' });
  const index = await aggregateBenchmarkResults({ benchmarkRoot: workspace.benchmarkRoot });
  const reports = generateReports(index);
  assert.deepEqual(Object.keys(reports).sort(), [
    'executive-summary.md',
    'historical-report.md',
    'leaderboard.md',
    'publication-report.md',
    'reliability-report.md',
    'stage-specialists.md'
  ]);
  assert.match(reports['leaderboard.md'], /model-report/);
  assert.match(reports['stage-specialists.md'], /Evidence Selector/);
  assert.match(reports['reliability-report.md'], /Timeout rate/);
  assert.match(reports['publication-report.md'], /light edit: 2/);
  assert.match(reports['historical-report.md'], /run-report/);
});
