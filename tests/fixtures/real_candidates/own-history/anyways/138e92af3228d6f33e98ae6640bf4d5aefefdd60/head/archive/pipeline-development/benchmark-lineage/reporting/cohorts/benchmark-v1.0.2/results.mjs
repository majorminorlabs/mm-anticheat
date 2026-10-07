import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  validateAdoptionRecordV102,
  validateKimiFailureExclusions
} from '../../../src/adoption-v1.0.2.mjs';

export const STAGES = ['draft', 'revision', 'reviewer', 'evidence_selector', 'research_planner'];
export const FIXTURES = ['apple-digital-repo', 'logitech'];
export const READINESS = [
  'unsuitable',
  'major rewrite',
  'moderate edit',
  'light edit',
  'publish with no edits'
];

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_failures']);
const EXPECTED_MANIFEST_HASH = 'e71d61e2346adba199dc9a8397a721850c1defee12f4a7a9cff8b1d0c3ef7990';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const posix = value => value.split(path.sep).join('/');
const round = value => value == null ? null : Math.round(value * 100) / 100;
const mean = values => {
  const usable = values.filter(Number.isFinite);
  return usable.length ? round(usable.reduce((sum, value) => sum + value, 0) / usable.length) : null;
};
const rate = (count, total) => total ? round(count / total) : 0;
const readinessRank = value => READINESS.indexOf(value);

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertScoreRecord(record, expectedRunId, stageResults) {
  if (record.run_id !== expectedRunId) throw new Error(`Score run ID mismatch: ${record.fixture}.`);
  if (!FIXTURES.includes(record.fixture)) throw new Error(`Unknown score fixture: ${record.fixture}.`);
  if (record.candidate !== 'Candidate A') throw new Error(`Unexpected candidate label: ${record.fixture}.`);
  if (!READINESS.includes(record.publication_readiness)) {
    throw new Error(`Unknown publication readiness: ${record.fixture}.`);
  }
  const incomplete = new Set(record.incomplete_stages);
  for (const stage of STAGES) {
    const result = stageResults.find(item => item.fixture_id === record.fixture && item.stage === stage);
    if (!result) throw new Error(`Missing run stage state: ${record.fixture}/${stage}.`);
    const score = record.scores?.[stage];
    if (result.status === 'completed') {
      if (!Number.isInteger(score) || score < 1 || score > 10 || incomplete.has(stage)) {
        throw new Error(`Completed stage score mismatch: ${record.fixture}/${stage}.`);
      }
    } else if (score !== null || !incomplete.has(stage)) {
      throw new Error(`Incomplete stage must remain null: ${record.fixture}/${stage}.`);
    }
  }
  if (incomplete.size !== STAGES.filter(stage => record.scores[stage] === null).length) {
    throw new Error(`Incomplete stage list contains duplicates or unknown values: ${record.fixture}.`);
  }
}

async function validateNativeLock({ file, runManifest, manifestHash }) {
  const lockBytes = await fs.readFile(file);
  const sidecarFile = file.replace(/\.json$/, '.sha256');
  const lockedFileHash = (await fs.readFile(sidecarFile, 'utf8')).trim().split(/\s+/)[0];
  if (sha256(lockBytes) !== lockedFileHash) {
    throw new Error(`Native score lock file checksum changed: ${path.basename(file)}.`);
  }
  const lock = JSON.parse(lockBytes);
  if (lock.lock_status !== 'locked' || lock.benchmark_version !== '1.0.2' ||
      lock.benchmark_manifest_hash !== manifestHash || lock.run_id !== runManifest.run_id) {
    throw new Error(`Native score lock identity mismatch: ${path.basename(file)}.`);
  }
  const metadataModel = runManifest.benchmark_metadata?.models?.[0];
  const planModel = runManifest.plan?.models?.find(item => item.id === lock.model_identifier);
  if (!metadataModel || metadataModel.model_identifier !== lock.model_identifier ||
      metadataModel.provider !== lock.provider || !planModel) {
    throw new Error(`Run/model association mismatch: ${lock.run_id}.`);
  }
  if (!Array.isArray(lock.records) || lock.records.length !== FIXTURES.length) {
    throw new Error(`Score lock must contain both fixtures: ${lock.run_id}.`);
  }
  const records = lock.records.map(item => {
    const actualHash = sha256(stableStringify(item.record));
    if (actualHash !== item.canonical_sha256) {
      throw new Error(`Canonical score hash mismatch: ${lock.run_id}/${item.record.fixture}.`);
    }
    assertScoreRecord(item.record, lock.run_id, runManifest.stage_results);
    return { ...item.record, canonical_sha256: item.canonical_sha256 };
  });
  if (new Set(records.map(item => item.fixture)).size !== FIXTURES.length) {
    throw new Error(`Duplicate score fixture: ${lock.run_id}.`);
  }
  return { lock, records };
}

function validateLegacyQwenLock(lock, runManifest) {
  if (lock.lock_status !== 'locked' || lock.model_identifier !== 'local-qwen3-14b') {
    throw new Error('Adopted Qwen score lock identity mismatch.');
  }
  return lock.fixtures.map(fixture => {
    const record = {
      candidate: fixture.candidate,
      confidence: fixture.confidence,
      fixture: fixture.fixture,
      incomplete_stages: fixture.incomplete_stages ?? [],
      publication_readiness: fixture.publication_readiness,
      run_id: runManifest.run_id,
      scores: fixture.scores
    };
    assertScoreRecord(record, runManifest.run_id, runManifest.stage_results);
    return { ...record, canonical_sha256: sha256(stableStringify(record)) };
  });
}

function modelMetadata(runManifest, modelIdentifier) {
  const native = runManifest.benchmark_metadata?.models?.find(item => item.model_identifier === modelIdentifier);
  const plan = runManifest.plan?.models?.find(item => item.id === modelIdentifier);
  return {
    provider: native?.provider ?? plan?.provider ?? null,
    model_digest: native?.model_digest ?? plan?.expected_digest_prefix ?? null,
    plan
  };
}

function buildModelRow({
  benchmarkRoot,
  runManifest,
  records,
  modelIdentifier,
  provider,
  modelDigest,
  reviewLockFile,
  sourceBenchmarkVersion,
  adoptionRecordFile = null
}) {
  const modelStages = runManifest.stage_results.filter(item => item.model_id === modelIdentifier);
  if (modelStages.length !== FIXTURES.length * STAGES.length) {
    throw new Error(`Run does not contain ten frozen stages: ${runManifest.run_id}.`);
  }
  const completed = modelStages.filter(item => item.status === 'completed');
  const attempted = modelStages.filter(item => item.status !== 'skipped_dependency');
  const timeouts = modelStages.filter(item =>
    item.failure?.classification?.includes('timeout') || item.failure?.reason?.toLowerCase().includes('timeout')
  );
  const fixtureScores = Object.fromEntries(records.map(record => {
    const scores = Object.values(record.scores).filter(Number.isFinite);
    return [record.fixture, {
      scores: record.scores,
      completed_stage_average: mean(scores),
      scored_stage_count: scores.length,
      publication_readiness: record.publication_readiness,
      confidence: record.confidence,
      incomplete_stages: record.incomplete_stages,
      canonical_score_sha256: record.canonical_sha256,
      review_package: posix(path.relative(
        benchmarkRoot,
        path.join(benchmarkRoot, 'generated', runManifest.run_id, 'review', 'packages', record.fixture, 'candidate-a', 'review-package.json')
      ))
    }];
  }));
  const allScores = records.flatMap(record => Object.values(record.scores)).filter(Number.isFinite);
  const stageAverages = Object.fromEntries(STAGES.map(stage => [stage, mean(records.map(record => record.scores[stage]))]));
  const fixtureCoveredCount = records.filter(record => Object.values(record.scores).some(Number.isFinite)).length;
  const readinessDistribution = Object.fromEntries(READINESS.map(value => [
    value,
    records.filter(record => record.publication_readiness === value).length
  ]));
  const conservativeReadiness = records.map(item => item.publication_readiness)
    .sort((a, b) => readinessRank(a) - readinessRank(b))[0];
  const restoration = runManifest.production_restore ?? runManifest.restore;
  const incompleteStages = modelStages.filter(item => item.status !== 'completed').map(item => ({
    fixture: item.fixture_id,
    stage: item.stage,
    status: item.status,
    failure_classification: item.failure?.classification ?? null
  }));

  return {
    model_identifier: modelIdentifier,
    provider,
    model_digest: modelDigest,
    benchmark: {
      version: '1.0.2',
      manifest_hash: EXPECTED_MANIFEST_HASH,
      source_version: sourceBenchmarkVersion,
      adoption: Boolean(adoptionRecordFile)
    },
    run: {
      id: runManifest.run_id,
      execution_timestamp: runManifest.started_at,
      finished_at: runManifest.finished_at,
      completion_status: runManifest.status
    },
    fixture_scores: fixtureScores,
    stage_averages: stageAverages,
    quality: {
      completed_stage_human_average: mean(allScores),
      scored_stage_count: allScores.length
    },
    coverage: {
      fixture_count: fixtureCoveredCount,
      planned_fixture_count: FIXTURES.length,
      fixture_rate: rate(fixtureCoveredCount, FIXTURES.length)
    },
    stage_completion: {
      completed_count: completed.length,
      planned_count: modelStages.length,
      rate: rate(completed.length, modelStages.length)
    },
    structured_output_compliance: {
      compliant_count: completed.length,
      attempted_count: attempted.length,
      rate: rate(completed.length, attempted.length)
    },
    timeout_statistics: {
      count: timeouts.length,
      attempted_count: attempted.length,
      rate: rate(timeouts.length, attempted.length)
    },
    publication_readiness: {
      summary: conservativeReadiness,
      distribution: readinessDistribution
    },
    review_confidence: [...new Set(records.map(item => item.confidence))].join(', '),
    incomplete_stages: incompleteStages,
    reliability: {
      restoration_failures: restoration?.failures?.length ?? 0,
      benchmark_failures: modelStages.filter(item => item.status === 'failed').length,
      dependency_skips: modelStages.filter(item => item.status === 'skipped_dependency').length
    },
    artifacts: {
      run_manifest: posix(path.relative(benchmarkRoot, path.join(benchmarkRoot, 'generated', runManifest.run_id, 'private', 'run-manifest.json'))),
      review_lock: posix(path.relative(benchmarkRoot, reviewLockFile)),
      adoption_record: adoptionRecordFile ? posix(path.relative(benchmarkRoot, adoptionRecordFile)) : null,
      fixture_packages: Object.fromEntries(Object.entries(fixtureScores).map(([fixture, value]) => [fixture, value.review_package]))
    }
  };
}

export function compareLeaderboard(a, b) {
  return (b.quality.completed_stage_human_average - a.quality.completed_stage_human_average) ||
    (a.timeout_statistics.count - b.timeout_statistics.count) ||
    (readinessRank(b.publication_readiness.summary) - readinessRank(a.publication_readiness.summary)) ||
    a.run.execution_timestamp.localeCompare(b.run.execution_timestamp);
}

export async function aggregateV102Results({ benchmarkRoot }) {
  const manifestFile = path.join(benchmarkRoot, 'config', 'benchmark-v1.0.2.json');
  const manifestHashFile = path.join(benchmarkRoot, 'config', 'benchmark-v1.0.2.sha256');
  const actualManifestHash = sha256(await fs.readFile(manifestFile));
  const lockedManifestHash = (await fs.readFile(manifestHashFile, 'utf8')).trim().split(/\s+/)[0];
  const manifest = await readJson(manifestFile);
  if (manifest.benchmark_version !== '1.0.2' || actualManifestHash !== EXPECTED_MANIFEST_HASH ||
      lockedManifestHash !== EXPECTED_MANIFEST_HASH) {
    throw new Error('Benchmark v1.0.2 manifest identity validation failed.');
  }

  const cohortRoot = path.join(benchmarkRoot, 'reporting', 'cohorts', 'benchmark-v1.0.2');
  const adoptionFile = path.join(cohortRoot, 'adoptions', 'qwen-v1.0.json');
  const qwenRunFile = path.join(benchmarkRoot, 'generated', '2026-07-31T00-46-02-939Z-ffa2dbd5', 'private', 'run-manifest.json');
  await validateAdoptionRecordV102({
    recordFile: adoptionFile,
    benchmarkRoot,
    baseManifestFile: path.join(benchmarkRoot, 'config', 'benchmark-v1.0.json'),
    parentManifestFile: path.join(benchmarkRoot, 'config', 'benchmark-v1.0.1.json'),
    patchManifestFile: manifestFile,
    sourceRunManifestFile: qwenRunFile
  });
  const exclusionFile = path.join(cohortRoot, 'exclusions', 'kimi-adapter-failures.json');
  const { record: exclusionRecord } = await validateKimiFailureExclusions({ recordFile: exclusionFile, benchmarkRoot });
  const excludedIds = new Set(exclusionRecord.runs.map(item => item.run_id));

  const qwenRun = await readJson(qwenRunFile);
  const qwenLockFile = path.join(benchmarkRoot, 'reporting', 'review-locks', 'qwen-candidate-a.json');
  const qwenLock = await readJson(qwenLockFile);
  const qwenRecords = validateLegacyQwenLock(qwenLock, qwenRun);
  const qwenMetadata = modelMetadata(qwenRun, 'local-qwen3-14b');

  const nativeImports = [
    ['2026-07-31T15-04-27-562Z-2ad383b2', 'kimi-k3.json'],
    ['2026-07-31T15-45-50-838Z-66820993', 'kimi-2.7.json']
  ];
  const models = [buildModelRow({
    benchmarkRoot,
    runManifest: qwenRun,
    records: qwenRecords,
    modelIdentifier: 'local-qwen3-14b',
    provider: qwenMetadata.provider,
    modelDigest: qwenMetadata.model_digest,
    reviewLockFile: qwenLockFile,
    sourceBenchmarkVersion: '1.0',
    adoptionRecordFile: adoptionFile
  })];

  for (const [runId, lockName] of nativeImports) {
    if (excludedIds.has(runId)) throw new Error(`Official run is incorrectly marked excluded: ${runId}.`);
    const runFile = path.join(benchmarkRoot, 'generated', runId, 'private', 'run-manifest.json');
    const runManifest = await readJson(runFile);
    if (runManifest.run_id !== runId || !TERMINAL_STATUSES.has(runManifest.status) || !runManifest.finished_at ||
        runManifest.benchmark_metadata?.benchmark_version !== '1.0.2' ||
        runManifest.benchmark_metadata?.benchmark_manifest_hash !== EXPECTED_MANIFEST_HASH) {
      throw new Error(`Official v1.0.2 run identity validation failed: ${runId}.`);
    }
    const restoration = runManifest.production_restore ?? runManifest.restore;
    if (restoration?.status !== 'restored') throw new Error(`Official run restoration is invalid: ${runId}.`);
    const lockFile = path.join(cohortRoot, 'review-locks', lockName);
    const { lock, records } = await validateNativeLock({ file: lockFile, runManifest, manifestHash: actualManifestHash });
    const metadata = modelMetadata(runManifest, lock.model_identifier);
    models.push(buildModelRow({
      benchmarkRoot,
      runManifest,
      records,
      modelIdentifier: lock.model_identifier,
      provider: lock.provider,
      modelDigest: metadata.model_digest,
      reviewLockFile: lockFile,
      sourceBenchmarkVersion: '1.0.2'
    }));
  }

  models.sort(compareLeaderboard);
  return {
    schema_version: '1.0.0',
    benchmark_version: '1.0.2',
    benchmark_manifest_hash: actualManifestHash,
    metric_doctrine: {
      quality: 'Mean of completed human-scored stages only. Missing stages are excluded, never scored as zero.',
      fixture_coverage: 'Fixtures containing at least one completed human-scored stage divided by two planned fixtures.',
      stage_completion: 'Completed stages divided by ten planned stages.',
      structured_output_compliance: 'Completed structured stages divided by attempted stages; dependency skips are excluded from attempts.'
    },
    indexed_model_count: models.length,
    models,
    excluded_runs: exclusionRecord.runs.map(item => ({
      run_id: item.run_id,
      classification: item.classification,
      excluded_from_scoring: true,
      excluded_from_import: true
    })),
    historical_executions: [...models].sort((a, b) => a.run.execution_timestamp.localeCompare(b.run.execution_timestamp)).map(row => ({
      run_id: row.run.id,
      execution_timestamp: row.run.execution_timestamp,
      finished_at: row.run.finished_at,
      model_identifier: row.model_identifier,
      provider: row.provider,
      source_benchmark_version: row.benchmark.source_version,
      adopted: row.benchmark.adoption,
      completion_status: row.run.completion_status
    }))
  };
}

const display = value => value == null ? 'Incomplete' : Number(value).toFixed(2);
const percent = value => `${(value * 100).toFixed(2)}%`;
const stageLabel = stage => ({
  draft: 'Draft',
  revision: 'Revision',
  reviewer: 'Reviewer',
  evidence_selector: 'Evidence Selector',
  research_planner: 'Research Planner'
})[stage];

export function generateV102Reports(index) {
  const rows = index.models;
  const leaderboard = `# Benchmark v1.0.2 Leaderboard\n\nQuality ranking uses completed human-scored stages only. Coverage and contract reliability are reported separately.\n\n| Rank | Model | Provider | Apple average | Logitech average | Completed-stage average | Fixture coverage | Stage completion | Structured-output compliance | Timeouts | Publication readiness | Benchmark version |\n| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |\n${rows.map((row, indexValue) => `| ${indexValue + 1} | ${row.model_identifier} | ${row.provider} | ${display(row.fixture_scores['apple-digital-repo']?.completed_stage_average)} | ${display(row.fixture_scores.logitech?.completed_stage_average)} | ${display(row.quality.completed_stage_human_average)} | ${percent(row.coverage.fixture_rate)} | ${percent(row.stage_completion.rate)} | ${percent(row.structured_output_compliance.rate)} | ${row.timeout_statistics.count} | ${row.publication_readiness.summary} | 1.0.2 |`).join('\n')}\n`;

  const executive = `# Benchmark v1.0.2 Executive Summary\n\n${rows.map((row, indexValue) => `${indexValue + 1}. ${row.model_identifier} (${row.provider}): ${display(row.quality.completed_stage_human_average)} completed-stage human average across ${row.quality.scored_stage_count} scored stages; ${percent(row.stage_completion.rate)} stage completion; ${percent(row.structured_output_compliance.rate)} structured-output compliance; ${row.timeout_statistics.count} timeout${row.timeout_statistics.count === 1 ? '' : 's'}.`).join('\n')}\n\nMissing stages are excluded from editorial-quality averages and remain visible in reliability metrics.\n`;

  const specialistLines = STAGES.map(stage => {
    const eligible = rows.filter(row => row.stage_averages[stage] != null);
    if (!eligible.length) return `- ${stageLabel(stage)}: No completed human-scored stages`;
    const best = Math.max(...eligible.map(row => row.stage_averages[stage]));
    const leaders = eligible.filter(row => row.stage_averages[stage] === best).map(row => row.model_identifier).join(', ');
    return `- ${stageLabel(stage)}: ${leaders} (${display(best)})`;
  });
  const specialists = `# Benchmark v1.0.2 Stage Specialists\n\nScores use completed human-scored stages only; ties are retained.\n\n${specialistLines.join('\n')}\n`;

  const reliability = `# Benchmark v1.0.2 Reliability Report\n\n${rows.map(row => `## ${row.model_identifier}\n\n- Fixture coverage: ${percent(row.coverage.fixture_rate)} (${row.coverage.fixture_count}/${row.coverage.planned_fixture_count})\n- Stage completion: ${percent(row.stage_completion.rate)} (${row.stage_completion.completed_count}/${row.stage_completion.planned_count})\n- Structured-output compliance: ${percent(row.structured_output_compliance.rate)} (${row.structured_output_compliance.compliant_count}/${row.structured_output_compliance.attempted_count} attempted)\n- Timeout rate: ${percent(row.timeout_statistics.rate)} (${row.timeout_statistics.count}/${row.timeout_statistics.attempted_count} attempted)\n- Incomplete stages: ${row.incomplete_stages.length ? row.incomplete_stages.map(item => `${item.fixture}/${item.stage} (${item.status}${item.failure_classification ? `, ${item.failure_classification}` : ''})`).join(', ') : 'None'}\n- Restoration failures: ${row.reliability.restoration_failures}\n- Benchmark failures: ${row.reliability.benchmark_failures}\n- Dependency skips: ${row.reliability.dependency_skips}`).join('\n\n')}\n\n## Excluded adapter failures\n\n${index.excluded_runs.map(item => `- ${item.run_id}: ${item.classification}; excluded from scoring and import`).join('\n')}\n`;

  const distribution = Object.fromEntries(READINESS.map(value => [value, rows.reduce((sum, row) => sum + row.publication_readiness.distribution[value], 0)]));
  const publication = `# Benchmark v1.0.2 Publication Readiness\n\n${READINESS.slice().reverse().map(value => `- ${value}: ${distribution[value]}`).join('\n')}\n\nReadiness is fixture-level. An unsuitable fixture does not assign a zero to missing editorial stages.\n`;
  const historical = `# Benchmark v1.0.2 Historical Report\n\n${index.historical_executions.map(item => `- ${item.execution_timestamp}: ${item.run_id}, ${item.model_identifier} (${item.provider}), ${item.completion_status}${item.adopted ? `, adopted from v${item.source_benchmark_version}` : ''}`).join('\n')}\n\n## Excluded historical executions\n\n${index.excluded_runs.map(item => `- ${item.run_id}: ${item.classification}`).join('\n')}\n`;

  return {
    'leaderboard.md': leaderboard,
    'executive-summary.md': executive,
    'stage-specialists.md': specialists,
    'reliability-report.md': reliability,
    'publication-report.md': publication,
    'historical-report.md': historical
  };
}

export async function writeV102Outputs({ index, outputDir }) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'results-index.json'), `${JSON.stringify(index, null, 2)}\n`);
  const reports = generateV102Reports(index);
  for (const [name, content] of Object.entries(reports)) await fs.writeFile(path.join(outputDir, name), content);
  return Object.keys(reports);
}
