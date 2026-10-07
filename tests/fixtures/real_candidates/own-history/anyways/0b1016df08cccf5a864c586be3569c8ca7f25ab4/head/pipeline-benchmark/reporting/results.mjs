import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const STAGES = ['draft', 'revision', 'reviewer', 'evidence_selector', 'research_planner'];
export const READINESS = [
  'unsuitable',
  'major rewrite',
  'moderate edit',
  'light edit',
  'publish with no edits'
];
const TERMINAL_RUN_STATUSES = new Set(['completed', 'completed_with_failures']);

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const posix = value => value.split(path.sep).join('/');
const round = value => value == null ? null : Math.round(value * 100) / 100;
const mean = values => {
  const usable = values.filter(Number.isFinite);
  return usable.length ? round(usable.reduce((sum, value) => sum + value, 0) / usable.length) : null;
};
const readinessRank = value => READINESS.indexOf(value);

function reviewContent(fixture) {
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

function validateReviewLock(lock, modelIdentifier) {
  if (lock.lock_status !== 'locked') throw new Error(`Review lock for ${modelIdentifier} is not locked.`);
  if (lock.model_identifier !== modelIdentifier) {
    throw new Error(`Review lock model ${lock.model_identifier} does not match ${modelIdentifier}.`);
  }
  if (!Array.isArray(lock.fixtures) || lock.fixtures.length === 0) {
    throw new Error(`Review lock for ${modelIdentifier} has no fixture scores.`);
  }
  for (const fixture of lock.fixtures) {
    const actual = sha256(JSON.stringify(reviewContent(fixture)));
    if (actual !== fixture.content_sha256) {
      throw new Error(`Locked human score checksum changed for ${modelIdentifier}/${fixture.fixture}.`);
    }
    if (!READINESS.includes(fixture.publication_readiness)) {
      throw new Error(`Unknown publication readiness for ${modelIdentifier}/${fixture.fixture}.`);
    }
    for (const stage of STAGES) {
      const score = fixture.scores?.[stage];
      if (score !== null && (!Number.isInteger(score) || score < 1 || score > 10)) {
        throw new Error(`Invalid ${stage} score for ${modelIdentifier}/${fixture.fixture}.`);
      }
    }
  }
}

async function loadJsonFiles(directory) {
  try {
    const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort();
    return Promise.all(names.map(async name => ({
      file: path.join(directory, name),
      value: await readJson(path.join(directory, name))
    })));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function nativeMetadata(manifest) {
  const metadata = manifest.benchmark_metadata;
  if (!metadata) return null;
  return {
    benchmark_version: metadata.benchmark_version,
    benchmark_manifest_hash: metadata.benchmark_manifest_hash,
    model_identifier: metadata.model_identifier,
    provider: metadata.provider,
    model_digest: metadata.model_digest,
    review_lock: metadata.review_lock
  };
}

function modelFromPlan(manifest, modelIdentifier) {
  return manifest.plan?.models?.find(model => model.id === modelIdentifier) ?? null;
}

function buildModelRow({ benchmark, benchmarkManifestHash, runManifest, metadata, reviewLock, reviewLockPath, runPath, benchmarkRoot }) {
  validateReviewLock(reviewLock, metadata.model_identifier);
  const stageResults = runManifest.stage_results ?? [];
  const modelStages = stageResults.filter(result => result.model_id === metadata.model_identifier);
  const plannedCount = (runManifest.plan?.fixture_ids?.length ?? reviewLock.fixtures.length) *
    (runManifest.plan?.stages?.length ?? STAGES.length);
  const timeoutResults = modelStages.filter(result =>
    result.failure?.classification?.includes('timeout') ||
    result.failure?.reason?.toLowerCase().includes('timeout')
  );
  const incomplete = modelStages
    .filter(result => result.status !== 'completed')
    .map(result => ({ fixture: result.fixture_id, stage: result.stage, status: result.status }));
  for (const fixture of reviewLock.fixtures) {
    for (const stage of fixture.incomplete_stages ?? []) {
      if (!incomplete.some(item => item.fixture === fixture.fixture && item.stage === stage)) {
        incomplete.push({ fixture: fixture.fixture, stage, status: 'incomplete' });
      }
    }
  }

  const fixtureScores = {};
  for (const fixture of reviewLock.fixtures) {
    fixtureScores[fixture.fixture] = {
      scores: fixture.scores,
      average: mean(Object.values(fixture.scores)),
      publication_readiness: fixture.publication_readiness,
      confidence: fixture.confidence,
      incomplete_stages: fixture.incomplete_stages ?? [],
      review_package: posix(path.relative(
        benchmarkRoot,
        path.join(runPath, 'review', 'packages', fixture.fixture, fixture.candidate.toLowerCase().replaceAll(' ', '-'), 'review-package.json')
      ))
    };
  }

  const stageAverages = Object.fromEntries(STAGES.map(stage => [
    stage,
    mean(reviewLock.fixtures.map(fixture => fixture.scores[stage]))
  ]));
  const allScores = reviewLock.fixtures.flatMap(fixture => Object.values(fixture.scores));
  const readinessDistribution = Object.fromEntries(READINESS.map(value => [
    value,
    reviewLock.fixtures.filter(fixture => fixture.publication_readiness === value).length
  ]));
  const conservativeReadiness = reviewLock.fixtures
    .map(fixture => fixture.publication_readiness)
    .sort((a, b) => readinessRank(a) - readinessRank(b))[0];
  const confidenceValues = [...new Set(reviewLock.fixtures.map(fixture => fixture.confidence))];
  const planModel = modelFromPlan(runManifest, metadata.model_identifier);

  return {
    model_identifier: metadata.model_identifier,
    provider: metadata.provider ?? planModel?.provider ?? null,
    model_digest: metadata.model_digest ?? planModel?.expected_digest_prefix ?? null,
    benchmark: {
      version: benchmark.benchmark_version,
      manifest_hash: benchmarkManifestHash,
      repository_commit: benchmark.benchmark_repository?.commit ?? null,
      controller_repository_commit: benchmark.controller_repository?.commit ?? null
    },
    run: {
      id: runManifest.run_id,
      execution_timestamp: runManifest.started_at,
      finished_at: runManifest.finished_at,
      completion_status: runManifest.status
    },
    fixture_scores: fixtureScores,
    stage_averages: stageAverages,
    overall_average: mean(allScores),
    timeout_statistics: {
      count: timeoutResults.length,
      planned_stage_count: plannedCount,
      rate: plannedCount ? round(timeoutResults.length / plannedCount) : 0
    },
    stage_outcomes: Object.fromEntries(modelStages.map(result => [
      `${result.fixture_id}/${result.stage}`,
      {
        status: result.status,
        attempts: result.attempt_count ?? 1,
        failure_classification: result.failure?.classification ?? null
      }
    ])),
    stage_durations_ms: Object.fromEntries(modelStages.map(result => [
      `${result.fixture_id}/${result.stage}`,
      round(result.elapsed_ms)
    ])),
    publication_readiness: {
      summary: conservativeReadiness,
      distribution: readinessDistribution
    },
    review_confidence: confidenceValues.length === 1 ? confidenceValues[0] : confidenceValues.join(', '),
    incomplete_stages: incomplete,
    reliability: {
      restoration_failures: runManifest.production_restore?.failures?.length ?? 0,
      benchmark_failures: runManifest.status === 'completed_with_failures' ? incomplete.length : 0
    },
    artifacts: {
      run_manifest: posix(path.relative(benchmarkRoot, path.join(runPath, 'private', 'run-manifest.json'))),
      review_lock: posix(path.relative(benchmarkRoot, reviewLockPath)),
      fixture_packages: Object.fromEntries(Object.entries(fixtureScores).map(([fixture, value]) => [
        fixture,
        value.review_package
      ]))
    }
  };
}

export function compareLeaderboard(a, b) {
  return (b.overall_average - a.overall_average) ||
    (a.timeout_statistics.count - b.timeout_statistics.count) ||
    (readinessRank(b.publication_readiness.summary) - readinessRank(a.publication_readiness.summary)) ||
    a.run.execution_timestamp.localeCompare(b.run.execution_timestamp);
}

export async function aggregateBenchmarkResults({
  benchmarkRoot,
  generatedRoot = path.join(benchmarkRoot, 'generated'),
  manifestFile = path.join(benchmarkRoot, 'config', 'benchmark-v1.0.json'),
  manifestHashFile = path.join(benchmarkRoot, 'config', 'benchmark-v1.0.sha256'),
  adoptionsDir = path.join(benchmarkRoot, 'reporting', 'adoptions'),
  reviewLocksDir = path.join(benchmarkRoot, 'reporting', 'review-locks'),
  runIds: suppliedRunIds
}) {
  const benchmark = await readJson(manifestFile);
  const benchmarkManifestHash = sha256(await fs.readFile(manifestFile));
  const lockedHash = (await fs.readFile(manifestHashFile, 'utf8')).trim().split(/\s+/)[0];
  if (benchmark.benchmark_version !== '1.0' || benchmarkManifestHash !== lockedHash) {
    throw new Error('Benchmark v1.0 manifest identity validation failed.');
  }

  const adoptions = new Map((await loadJsonFiles(adoptionsDir)).map(item => [item.value.run_id, item]));
  const reviewLocks = await loadJsonFiles(reviewLocksDir);
  const locksByModel = new Map(reviewLocks.map(item => [item.value.model_identifier, item]));
  let runIds = suppliedRunIds;
  if (!runIds) {
    runIds = [];
    try {
      runIds = (await fs.readdir(generatedRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const included = [];
  const excluded = [];
  const seenRuns = new Set();
  const seenModels = new Set();
  for (const runId of runIds) {
    if (seenRuns.has(runId)) {
      excluded.push({ run_id: runId, reason: 'duplicate run' });
      continue;
    }
    seenRuns.add(runId);
    const runPath = path.join(generatedRoot, runId);
    const runManifestFile = path.join(runPath, 'private', 'run-manifest.json');
    let runManifest;
    try {
      runManifest = await readJson(runManifestFile);
    } catch {
      excluded.push({ run_id: runId, reason: 'missing or invalid run manifest' });
      continue;
    }
    if (!TERMINAL_RUN_STATUSES.has(runManifest.status) || !runManifest.finished_at) {
      excluded.push({ run_id: runId, reason: 'incomplete run' });
      continue;
    }
    if (runManifest.production_restore?.status && runManifest.production_restore.status !== 'restored') {
      excluded.push({ run_id: runId, reason: 'invalidated restoration' });
      continue;
    }

    let metadata = nativeMetadata(runManifest);
    let reviewLockPath;
    const adoption = adoptions.get(runId);
    if (!metadata && adoption) {
      if (sha256(await fs.readFile(runManifestFile)) !== adoption.value.run_manifest_sha256) {
        excluded.push({ run_id: runId, reason: 'historical artifact checksum mismatch' });
        continue;
      }
      metadata = adoption.value;
      reviewLockPath = path.join(benchmarkRoot, adoption.value.review_lock);
    }
    if (!metadata) {
      excluded.push({ run_id: runId, reason: 'pre-v1.0 run' });
      continue;
    }
    if (metadata.benchmark_version !== '1.0') {
      excluded.push({ run_id: runId, reason: 'benchmark version mismatch' });
      continue;
    }
    if (metadata.benchmark_manifest_hash !== benchmarkManifestHash) {
      excluded.push({ run_id: runId, reason: 'benchmark manifest mismatch' });
      continue;
    }

    const lockEntry = reviewLockPath
      ? { file: reviewLockPath, value: await readJson(reviewLockPath) }
      : locksByModel.get(metadata.model_identifier);
    if (!lockEntry) {
      excluded.push({ run_id: runId, reason: 'missing locked human scores' });
      continue;
    }
    if (seenModels.has(metadata.model_identifier)) {
      excluded.push({ run_id: runId, reason: 'duplicate model evaluation' });
      continue;
    }
    seenModels.add(metadata.model_identifier);
    included.push(buildModelRow({
      benchmark,
      benchmarkManifestHash,
      runManifest,
      metadata,
      reviewLock: lockEntry.value,
      reviewLockPath: lockEntry.file,
      runPath,
      benchmarkRoot
    }));
  }

  included.sort(compareLeaderboard);
  return {
    schema_version: '1.0.0',
    benchmark_version: '1.0',
    benchmark_manifest_hash: benchmarkManifestHash,
    indexed_model_count: included.length,
    models: included,
    historical_executions: [...included]
      .sort((a, b) => a.run.execution_timestamp.localeCompare(b.run.execution_timestamp))
      .map(row => ({
        run_id: row.run.id,
        execution_timestamp: row.run.execution_timestamp,
        finished_at: row.run.finished_at,
        model_identifier: row.model_identifier,
        provider: row.provider,
        completion_status: row.run.completion_status
      })),
    excluded_runs: excluded
  };
}

const display = value => value == null ? 'Incomplete' : Number(value).toFixed(2);
const stageLabel = stage => ({
  draft: 'Draft',
  revision: 'Revision',
  reviewer: 'Reviewer',
  evidence_selector: 'Evidence Selector',
  research_planner: 'Research Planner'
})[stage];

export function generateReports(index) {
  const rows = index.models;
  const leaderboardHeader = '| Rank | Model | Provider | Apple average | Logitech average | Overall average | Draft average | Revision average | Reviewer average | Evidence average | Research average | Timeouts | Publication readiness | Benchmark version |';
  const leaderboardRows = rows.map((row, i) =>
    `| ${i + 1} | ${row.model_identifier} | ${row.provider ?? 'Unknown'} | ${display(row.fixture_scores['apple-digital-repo']?.average)} | ${display(row.fixture_scores.logitech?.average)} | ${display(row.overall_average)} | ${display(row.stage_averages.draft)} | ${display(row.stage_averages.revision)} | ${display(row.stage_averages.reviewer)} | ${display(row.stage_averages.evidence_selector)} | ${display(row.stage_averages.research_planner)} | ${row.timeout_statistics.count} | ${row.publication_readiness.summary} | ${row.benchmark.version} |`
  );
  const leaderboard = `# Benchmark v1.0 Leaderboard\n\n${leaderboardHeader}\n| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |\n${leaderboardRows.join('\n') || '|  | No qualifying models |  |  |  |  |  |  |  |  |  |  |  |  |'}\n`;

  const executive = `# Executive Summary\n\n${rows.length
    ? rows.map((row, i) => `${i + 1}. ${row.model_identifier} (${row.provider}) — ${display(row.overall_average)} average, ${row.timeout_statistics.count} timeout${row.timeout_statistics.count === 1 ? '' : 's'}, ${row.publication_readiness.summary}.`).join('\n')
    : 'No qualifying Benchmark v1.0 models are indexed.'}\n`;

  const specialists = `# Stage Specialists\n\n${STAGES.map(stage => {
    const eligible = rows.filter(row => row.stage_averages[stage] != null)
      .sort((a, b) => (b.stage_averages[stage] - a.stage_averages[stage]) || compareLeaderboard(a, b));
    const best = eligible[0];
    return `- ${stageLabel(stage)}: ${best ? `${best.model_identifier} (${display(best.stage_averages[stage])})` : 'No completed scores'}`;
  }).join('\n')}\n`;

  const reliability = `# Reliability Report\n\n${rows.length ? rows.map(row =>
    `## ${row.model_identifier}\n\n- Timeout rate: ${(row.timeout_statistics.rate * 100).toFixed(2)}% (${row.timeout_statistics.count}/${row.timeout_statistics.planned_stage_count})\n- Incomplete stages: ${row.incomplete_stages.length ? row.incomplete_stages.map(item => `${item.fixture}/${item.stage}`).join(', ') : 'None'}\n- Restoration failures: ${row.reliability.restoration_failures}\n- Benchmark failures: ${row.reliability.benchmark_failures}`
  ).join('\n\n') : 'No qualifying models.'}\n`;

  const distribution = Object.fromEntries(READINESS.map(value => [
    value,
    rows.reduce((sum, row) => sum + (row.publication_readiness.distribution[value] ?? 0), 0)
  ]));
  const publication = `# Publication Report\n\n${READINESS.slice().reverse().map(value => `- ${value}: ${distribution[value]}`).join('\n')}\n`;
  const historical = `# Benchmark v1.0 History\n\n${index.historical_executions.length
    ? index.historical_executions.map(item => `- ${item.execution_timestamp}: ${item.run_id} — ${item.model_identifier} (${item.provider}), ${item.completion_status}`).join('\n')
    : 'No qualifying executions.'}\n`;

  return {
    'leaderboard.md': leaderboard,
    'executive-summary.md': executive,
    'stage-specialists.md': specialists,
    'reliability-report.md': reliability,
    'publication-report.md': publication,
    'historical-report.md': historical
  };
}

export async function writeReportingOutputs({ index, outputDir }) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'results-index.json'), `${JSON.stringify(index, null, 2)}\n`);
  const reports = generateReports(index);
  for (const [name, content] of Object.entries(reports)) {
    await fs.writeFile(path.join(outputDir, name), content);
  }
  return Object.keys(reports);
}
