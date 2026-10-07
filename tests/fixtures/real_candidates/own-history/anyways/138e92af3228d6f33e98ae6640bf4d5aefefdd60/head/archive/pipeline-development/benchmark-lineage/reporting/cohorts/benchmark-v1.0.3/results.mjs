import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { aggregateV102Results, stableStringify } from '../benchmark-v1.0.2/results.mjs';
import {
  validateAdoptionRecordV103,
  validateKimiFailureExclusionsV103
} from '../../../src/adoption-v1.0.3.mjs';

export const STAGES = ['draft', 'revision', 'reviewer', 'evidence_selector', 'research_planner'];
export const FIXTURES = ['apple-digital-repo', 'logitech'];
export const READINESS = ['unsuitable', 'major rewrite', 'moderate edit', 'light edit', 'publish with no edits'];

const EXPECTED_MANIFEST_HASH = 'cff42b1f55185d4f018de99fc3346e33f5d4f1edf7b93ddefadc36b6c8cab99c';
const NATIVE_IMPORTS = [
  {
    runId: '2026-07-31T18-46-59-459Z-0725b752',
    modelIdentifier: 'cloud-luna-high',
    provider: 'openai-codex-subscription',
    lockName: 'luna-high.json'
  },
  {
    runId: '2026-07-31T20-34-27-992Z-0bd68224',
    modelIdentifier: 'cloud-luna-xhigh',
    provider: 'openai-codex-subscription',
    lockName: 'luna-xhigh.json'
  },
  {
    runId: '2026-07-31T22-29-36-201Z-844f1791',
    modelIdentifier: 'cloud-terra-high',
    provider: 'openai-codex-subscription',
    lockName: 'terra-high.json'
  },
  {
    runId: '2026-07-31T22-45-11-765Z-e45fee4c',
    modelIdentifier: 'cloud-sol-medium',
    provider: 'openai-codex-subscription',
    lockName: 'sol-medium.json'
  }
];
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

function assertScoreRecord(record, runManifest) {
  if (record.run_id !== runManifest.run_id || !FIXTURES.includes(record.fixture) || record.candidate !== 'Candidate A') {
    throw new Error(`Native score identity mismatch: ${record.fixture}.`);
  }
  if (!READINESS.includes(record.publication_readiness)) throw new Error(`Invalid readiness: ${record.fixture}.`);
  if (record.incomplete_stages.length !== 0) throw new Error(`Completed native run cannot contain incomplete scores: ${record.fixture}.`);
  for (const stage of STAGES) {
    const result = runManifest.stage_results.find(item => item.fixture_id === record.fixture && item.stage === stage);
    const score = record.scores?.[stage];
    if (result?.status !== 'completed' || !Number.isInteger(score) || score < 1 || score > 10) {
      throw new Error(`Native completed-stage score mismatch: ${record.fixture}/${stage}.`);
    }
  }
}

async function validateNativeLock({ file, runManifest, modelIdentifier, provider }) {
  const bytes = await fs.readFile(file);
  const sidecarHash = (await fs.readFile(file.replace(/\.json$/, '.sha256'), 'utf8')).trim().split(/\s+/)[0];
  if (sha256(bytes) !== sidecarHash) throw new Error('Native score-lock checksum changed.');
  const lock = JSON.parse(bytes);
  if (lock.lock_status !== 'locked' || lock.benchmark_version !== '1.0.3' ||
      lock.benchmark_manifest_hash !== EXPECTED_MANIFEST_HASH || lock.run_id !== runManifest.run_id ||
      lock.model_identifier !== modelIdentifier || lock.provider !== provider) {
    throw new Error('Native score-lock identity mismatch.');
  }
  if (lock.records?.length !== 2) throw new Error('Native score lock must contain two fixtures.');
  const records = lock.records.map(item => {
    if (sha256(stableStringify(item.record)) !== item.canonical_sha256) {
      throw new Error(`Canonical native score hash mismatch: ${item.record.fixture}.`);
    }
    assertScoreRecord(item.record, runManifest);
    return { ...item.record, canonical_sha256: item.canonical_sha256 };
  });
  if (new Set(records.map(item => item.fixture)).size !== 2) throw new Error('Duplicate native score fixture.');
  return { lock, records };
}

async function validateNativeMapping(benchmarkRoot, runId, modelIdentifier) {
  const mapping = await readJson(path.join(benchmarkRoot, 'generated', runId, 'private', 'mapping.json'));
  const valid = mapping.run_id === runId && mapping.entries?.length === 2 && FIXTURES.every(fixture =>
    mapping.entries.some(item => item.fixture_id === fixture && item.model_id === modelIdentifier && item.candidate === 'Candidate A')
  );
  if (!valid) throw new Error('Authorized native run-local candidate association mismatch.');
}

function buildNativeRow({ benchmarkRoot, runManifest, records, lockFile, modelIdentifier, provider }) {
  const stages = runManifest.stage_results.filter(item => item.model_id === modelIdentifier);
  if (stages.length !== 10 || stages.some(item => item.status !== 'completed')) {
    throw new Error('Official native run did not complete all ten frozen stages.');
  }
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
      review_package: posix(path.relative(benchmarkRoot, path.join(
        benchmarkRoot, 'generated', runManifest.run_id, 'review', 'packages', record.fixture, 'candidate-a', 'review-package.json'
      )))
    }];
  }));
  const allScores = records.flatMap(record => Object.values(record.scores)).filter(Number.isFinite);
  const distribution = Object.fromEntries(READINESS.map(value => [value, records.filter(item => item.publication_readiness === value).length]));
  return {
    model_identifier: modelIdentifier,
    provider,
    model_digest: runManifest.benchmark_metadata.models.find(item => item.model_identifier === modelIdentifier)?.model_digest ?? null,
    benchmark: { version: '1.0.3', manifest_hash: EXPECTED_MANIFEST_HASH, source_version: '1.0.3', adoption: false },
    run: {
      id: runManifest.run_id,
      execution_timestamp: runManifest.started_at,
      finished_at: runManifest.finished_at,
      completion_status: runManifest.status
    },
    fixture_scores: fixtureScores,
    stage_averages: Object.fromEntries(STAGES.map(stage => [stage, mean(records.map(record => record.scores[stage]))])),
    quality: { completed_stage_human_average: mean(allScores), scored_stage_count: allScores.length },
    coverage: { fixture_count: 2, planned_fixture_count: 2, fixture_rate: 1 },
    stage_completion: { completed_count: 10, planned_count: 10, rate: 1 },
    structured_output_compliance: { compliant_count: 10, attempted_count: 10, rate: 1 },
    timeout_statistics: { count: 0, attempted_count: 10, rate: 0 },
    publication_readiness: {
      summary: records.map(item => item.publication_readiness).sort((a, b) => readinessRank(a) - readinessRank(b))[0],
      distribution
    },
    review_confidence: 'high',
    incomplete_stages: [],
    reliability: { restoration_failures: 0, benchmark_failures: 0, dependency_skips: 0 },
    artifacts: {
      run_manifest: posix(path.relative(benchmarkRoot, path.join(benchmarkRoot, 'generated', runManifest.run_id, 'private', 'run-manifest.json'))),
      review_lock: posix(path.relative(benchmarkRoot, lockFile)),
      adoption_record: null,
      fixture_packages: Object.fromEntries(Object.entries(fixtureScores).map(([fixture, value]) => [fixture, value.review_package]))
    }
  };
}

function usageValue(request, key) {
  const usage = request.provider_metrics?.adapter_transport?.usage;
  if (Number.isFinite(usage?.[key])) return usage[key];
  if (key === 'input_tokens' && Number.isFinite(request.provider_metrics?.prompt_eval_count)) return request.provider_metrics.prompt_eval_count;
  if (key === 'output_tokens' && Number.isFinite(request.provider_metrics?.eval_count)) return request.provider_metrics.eval_count;
  return null;
}

async function addRuntimeAndUsage(benchmarkRoot, row) {
  const file = path.join(benchmarkRoot, 'generated', row.run.id, 'private', 'reports', 'runtime-metrics.json');
  const metrics = await readJson(file);
  const requests = metrics.requests.filter(item => item.model_id === row.model_identifier);
  const totals = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    const values = requests.map(item => usageValue(item, key)).filter(Number.isFinite);
    totals[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  const stageDurations = Object.fromEntries(requests.map(item => [`${item.fixture_id}/${item.stage}`, round(item.provider_metrics?.wall_ms ?? null)]));
  return {
    ...row,
    runtime: {
      benchmark_wall_ms: new Date(row.run.finished_at) - new Date(row.run.execution_timestamp),
      attempted_stage_wall_ms: round(requests.reduce((sum, item) => sum + (item.provider_metrics?.wall_ms ?? 0), 0)),
      stage_durations_ms: stageDurations,
      metrics_file: posix(path.relative(benchmarkRoot, file))
    },
    token_usage: {
      ...totals,
      stages_with_provider_usage: requests.filter(item => usageValue(item, 'input_tokens') != null && usageValue(item, 'output_tokens') != null).length,
      attempted_stages: requests.length
    }
  };
}

export function compareLeaderboard(a, b) {
  return (b.quality.completed_stage_human_average - a.quality.completed_stage_human_average) ||
    (a.timeout_statistics.count - b.timeout_statistics.count) ||
    (readinessRank(b.publication_readiness.summary) - readinessRank(a.publication_readiness.summary)) ||
    a.run.execution_timestamp.localeCompare(b.run.execution_timestamp);
}

export async function aggregateV103Results({ benchmarkRoot }) {
  const manifestFiles = Object.fromEntries(['1.0', '1.0.1', '1.0.2', '1.0.3'].map(version => [
    version, path.join(benchmarkRoot, 'config', `benchmark-v${version}.json`)
  ]));
  const manifestFile = manifestFiles['1.0.3'];
  const actualManifestHash = sha256(await fs.readFile(manifestFile));
  const sidecarHash = (await fs.readFile(manifestFile.replace(/\.json$/, '.sha256'), 'utf8')).trim().split(/\s+/)[0];
  const manifest = await readJson(manifestFile);
  if (manifest.benchmark_version !== '1.0.3' || actualManifestHash !== EXPECTED_MANIFEST_HASH || sidecarHash !== EXPECTED_MANIFEST_HASH) {
    throw new Error('Benchmark v1.0.3 manifest identity validation failed.');
  }

  const cohortRoot = path.join(benchmarkRoot, 'reporting', 'cohorts', 'benchmark-v1.0.3');
  const adoptionNames = ['qwen-v1.0.json', 'kimi-k3-v1.0.2.json', 'kimi-2.7-v1.0.2.json'];
  const adoptionRecords = new Map();
  for (const name of adoptionNames) {
    const recordFile = path.join(cohortRoot, 'adoptions', name);
    const record = await readJson(recordFile);
    const sourceRunManifestFile = path.join(benchmarkRoot, record.source_run_manifest);
    await validateAdoptionRecordV103({ recordFile, benchmarkRoot, manifestFiles, sourceRunManifestFile });
    adoptionRecords.set(record.model_identifier, { record, recordFile });
  }
  const exclusionFile = path.join(cohortRoot, 'exclusions', 'kimi-adapter-failures.json');
  const { record: exclusionRecord } = await validateKimiFailureExclusionsV103({
    recordFile: exclusionFile,
    benchmarkRoot,
    targetManifestFile: manifestFile
  });

  const sourceIndex = await aggregateV102Results({ benchmarkRoot });
  const models = [];
  for (const sourceRow of sourceIndex.models) {
    const adoption = adoptionRecords.get(sourceRow.model_identifier);
    if (!adoption || adoption.record.run_id !== sourceRow.run.id) throw new Error(`Missing v1.0.3 adoption: ${sourceRow.model_identifier}.`);
    models.push(await addRuntimeAndUsage(benchmarkRoot, {
      ...sourceRow,
      benchmark: {
        version: '1.0.3',
        manifest_hash: EXPECTED_MANIFEST_HASH,
        source_version: adoption.record.source_benchmark_version,
        adoption: true
      },
      artifacts: {
        ...sourceRow.artifacts,
        adoption_record: posix(path.relative(benchmarkRoot, adoption.recordFile))
      }
    }));
  }

  for (const nativeImport of NATIVE_IMPORTS) {
    const nativeRunFile = path.join(benchmarkRoot, 'generated', nativeImport.runId, 'private', 'run-manifest.json');
    const nativeRun = await readJson(nativeRunFile);
    if (nativeRun.run_id !== nativeImport.runId || nativeRun.status !== 'completed' ||
        nativeRun.benchmark_metadata?.benchmark_version !== '1.0.3' ||
        nativeRun.benchmark_metadata?.benchmark_manifest_hash !== EXPECTED_MANIFEST_HASH ||
        (nativeRun.production_restore ?? nativeRun.restore)?.status !== 'restored') {
      throw new Error(`Official native run identity, completion, or restoration validation failed: ${nativeImport.runId}.`);
    }
    await validateNativeMapping(benchmarkRoot, nativeImport.runId, nativeImport.modelIdentifier);
    const nativeLockFile = path.join(cohortRoot, 'review-locks', nativeImport.lockName);
    const { records } = await validateNativeLock({
      file: nativeLockFile,
      runManifest: nativeRun,
      modelIdentifier: nativeImport.modelIdentifier,
      provider: nativeImport.provider
    });
    models.push(await addRuntimeAndUsage(benchmarkRoot, buildNativeRow({
      benchmarkRoot,
      runManifest: nativeRun,
      records,
      lockFile: nativeLockFile,
      modelIdentifier: nativeImport.modelIdentifier,
      provider: nativeImport.provider
    })));
  }
  models.sort(compareLeaderboard);

  return {
    schema_version: '1.0.0',
    benchmark_version: '1.0.3',
    benchmark_manifest_hash: actualManifestHash,
    metric_doctrine: {
      quality: 'Mean of completed human-scored stages only. Missing stages are excluded, never scored as zero.',
      fixture_coverage: 'Fixtures containing at least one completed human-scored stage divided by two planned fixtures.',
      stage_completion: 'Completed stages divided by ten planned stages.',
      structured_output_compliance: 'Completed structured stages divided by attempted stages; dependency skips are excluded from attempts.',
      runtime_and_usage: 'Reported from immutable private runtime metrics; unavailable provider token fields remain null.'
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

const display = value => value == null ? 'Unavailable' : Number(value).toFixed(2);
const integer = value => value == null ? 'Unavailable' : String(value);
const percent = value => `${(value * 100).toFixed(2)}%`;
const duration = value => value == null ? 'Unavailable' : `${(value / 1000).toFixed(2)}s`;
const stageLabel = stage => ({ draft: 'Draft', revision: 'Revision', reviewer: 'Reviewer', evidence_selector: 'Evidence Selector', research_planner: 'Research Planner' })[stage];

export function generateV103Reports(index) {
  const rows = index.models;
  const leaderboard = `# Benchmark v1.0.3 Leaderboard\n\nQuality ranking uses completed human-scored stages only. Coverage and contract reliability are separate.\n\n| Rank | Model | Provider | Apple average | Logitech average | Overall average | Fixture coverage | Stage completion | Structured compliance | Timeouts | Publication readiness | Version |\n| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |\n${rows.map((row, i) => `| ${i + 1} | ${row.model_identifier} | ${row.provider} | ${display(row.fixture_scores['apple-digital-repo']?.completed_stage_average)} | ${display(row.fixture_scores.logitech?.completed_stage_average)} | ${display(row.quality.completed_stage_human_average)} | ${percent(row.coverage.fixture_rate)} | ${percent(row.stage_completion.rate)} | ${percent(row.structured_output_compliance.rate)} | ${row.timeout_statistics.count} | ${row.publication_readiness.summary} | 1.0.3 |`).join('\n')}\n`;
  const executive = `# Benchmark v1.0.3 Executive Summary\n\n${rows.map((row, i) => `${i + 1}. ${row.model_identifier} (${row.provider}): ${display(row.quality.completed_stage_human_average)} quality average over ${row.quality.scored_stage_count} scored stages; ${percent(row.stage_completion.rate)} completion; ${percent(row.structured_output_compliance.rate)} structured compliance; ${row.timeout_statistics.count} timeout${row.timeout_statistics.count === 1 ? '' : 's'}.`).join('\n')}\n\nMissing stages are excluded from editorial-quality averages. No final production-routing decision is made by this report.\n`;
  const specialistLines = STAGES.map(stage => {
    const eligible = rows.filter(row => row.stage_averages[stage] != null);
    const best = Math.max(...eligible.map(row => row.stage_averages[stage]));
    return `- ${stageLabel(stage)}: ${eligible.filter(row => row.stage_averages[stage] === best).map(row => row.model_identifier).join(', ')} (${display(best)})`;
  });
  const specialists = `# Benchmark v1.0.3 Stage Specialists\n\nCompleted human-scored stages only; ties are retained.\n\n${specialistLines.join('\n')}\n`;
  const reliability = `# Benchmark v1.0.3 Reliability Report\n\n${rows.map(row => `## ${row.model_identifier}\n\n- Fixture coverage: ${percent(row.coverage.fixture_rate)} (${row.coverage.fixture_count}/${row.coverage.planned_fixture_count})\n- Stage completion: ${percent(row.stage_completion.rate)} (${row.stage_completion.completed_count}/${row.stage_completion.planned_count})\n- Structured-output compliance: ${percent(row.structured_output_compliance.rate)} (${row.structured_output_compliance.compliant_count}/${row.structured_output_compliance.attempted_count} attempted)\n- Timeout rate: ${percent(row.timeout_statistics.rate)} (${row.timeout_statistics.count}/${row.timeout_statistics.attempted_count} attempted)\n- Incomplete stages: ${row.incomplete_stages.length ? row.incomplete_stages.map(item => `${item.fixture}/${item.stage} (${item.status}${item.failure_classification ? `, ${item.failure_classification}` : ''})`).join(', ') : 'None'}\n- Restoration failures: ${row.reliability.restoration_failures}\n- Benchmark failures: ${row.reliability.benchmark_failures}\n- Dependency skips: ${row.reliability.dependency_skips}`).join('\n\n')}\n\n## Excluded adapter failures\n\n${index.excluded_runs.map(item => `- ${item.run_id}: ${item.classification}; excluded from scoring and import`).join('\n')}\n`;
  const distribution = Object.fromEntries(READINESS.map(value => [value, rows.reduce((sum, row) => sum + row.publication_readiness.distribution[value], 0)]));
  const publication = `# Benchmark v1.0.3 Publication Readiness\n\n${READINESS.slice().reverse().map(value => `- ${value}: ${distribution[value]}`).join('\n')}\n\n| Model | Apple | Logitech | Conservative summary |\n| --- | --- | --- | --- |\n${rows.map(row => `| ${row.model_identifier} | ${row.fixture_scores['apple-digital-repo'].publication_readiness} | ${row.fixture_scores.logitech.publication_readiness} | ${row.publication_readiness.summary} |`).join('\n')}\n\nAn unsuitable fixture does not assign zero to missing stages.\n`;
  const runtime = `# Benchmark v1.0.3 Runtime and Usage\n\nToken fields remain unavailable where a provider did not report them. Cached input is included within input when reported by Codex.\n\n| Model | Benchmark wall | Attempted-stage wall | Input tokens | Cached input | Output tokens | Reasoning tokens | Provider usage stages |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.map(row => `| ${row.model_identifier} | ${duration(row.runtime.benchmark_wall_ms)} | ${duration(row.runtime.attempted_stage_wall_ms)} | ${integer(row.token_usage.input_tokens)} | ${integer(row.token_usage.cached_input_tokens)} | ${integer(row.token_usage.output_tokens)} | ${integer(row.token_usage.reasoning_output_tokens)} | ${row.token_usage.stages_with_provider_usage}/${row.token_usage.attempted_stages} |`).join('\n')}\n`;
  const historical = `# Benchmark v1.0.3 Historical Report\n\n${index.historical_executions.map(item => `- ${item.execution_timestamp}: ${item.run_id}, ${item.model_identifier} (${item.provider}), ${item.completion_status}${item.adopted ? `, adopted from v${item.source_benchmark_version}` : ''}`).join('\n')}\n\n## Excluded historical executions\n\n${index.excluded_runs.map(item => `- ${item.run_id}: ${item.classification}`).join('\n')}\n`;
  const qualityRuntime = rows.map(row => ({
    row,
    pointsPerMinute: row.runtime.benchmark_wall_ms
      ? row.quality.completed_stage_human_average / (row.runtime.benchmark_wall_ms / 60000)
      : null
  }));
  const comparison = `# Benchmark v1.0.3 Final Model Comparison\n\nThis report separates completed-stage editorial quality from completion and structured-output reliability. Missing stages are never treated as zero quality scores.\n\n## Editorial quality and reliability\n\n| Model | Apple | Logitech | Overall | Stage completion | Structured compliance | Timeouts | Publication readiness |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n${rows.map(row => `| ${row.model_identifier} | ${display(row.fixture_scores['apple-digital-repo']?.completed_stage_average)} | ${display(row.fixture_scores.logitech?.completed_stage_average)} | ${display(row.quality.completed_stage_human_average)} | ${percent(row.stage_completion.rate)} | ${percent(row.structured_output_compliance.rate)} | ${row.timeout_statistics.count} | ${row.publication_readiness.summary} |`).join('\n')}\n\n## Runtime, token use, and quality per runtime minute\n\nQuality per runtime minute is the completed-stage human average divided by benchmark wall-clock minutes. Completion remains visible because a fast partial run is not equivalent to a complete run.\n\n| Model | Runtime | Input | Cached input | Output | Reasoning | Quality/minute | Completion |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${qualityRuntime.map(({ row, pointsPerMinute }) => `| ${row.model_identifier} | ${duration(row.runtime.benchmark_wall_ms)} | ${integer(row.token_usage.input_tokens)} | ${integer(row.token_usage.cached_input_tokens)} | ${integer(row.token_usage.output_tokens)} | ${integer(row.token_usage.reasoning_output_tokens)} | ${display(pointsPerMinute)} | ${percent(row.stage_completion.rate)} |`).join('\n')}\n\n## Stage-specific strengths\n\n${specialistLines.join('\n')}\n\n## Measured findings\n\n- Overall quality leaders: ${rows.filter(row => row.quality.completed_stage_human_average === Math.max(...rows.map(item => item.quality.completed_stage_human_average))).map(row => row.model_identifier).join(', ')} (${display(Math.max(...rows.map(item => item.quality.completed_stage_human_average)))})\n- Complete structured-output leaders: ${rows.filter(row => row.stage_completion.rate === 1 && row.structured_output_compliance.rate === 1 && row.timeout_statistics.count === 0).map(row => row.model_identifier).join(', ')}\n- Best quality per runtime minute among complete runs: ${qualityRuntime.filter(item => item.row.stage_completion.rate === 1).sort((a, b) => b.pointsPerMinute - a.pointsPerMinute)[0].row.model_identifier} (${display(qualityRuntime.filter(item => item.row.stage_completion.rate === 1).sort((a, b) => b.pointsPerMinute - a.pointsPerMinute)[0].pointsPerMinute)})\n- No completed candidate achieved publish-with-no-edits readiness on either fixture.\n\n## Recommendations for pipeline-design discussion\n\nThese recommendations interpret the measured results; they are not additional benchmark measurements.\n\n- Discovery and triage: cloud-terra-high is the strongest provisional candidate because it combines the leading Evidence Selector score, a leading Research Planner score, full reliability, and the fastest complete runtime. Discovery itself was not directly benchmarked.\n- Research planning: cloud-terra-high, cloud-luna-high, cloud-luna-xhigh, and cloud-sol-medium are tied on completed human scores; runtime favors cloud-terra-high.\n- Evidence selection: cloud-terra-high leads. cloud-sol-medium and cloud-luna-xhigh are credible alternatives.\n- Drafting: cloud-luna-xhigh and cloud-terra-high are the strongest fully complete candidates. cloud-kimi-2-7 has the highest completed Draft score but lacks production-grade completion reliability.\n- Revision: cloud-luna-high and cloud-luna-xhigh lead. Human review remains necessary because no candidate produced publish-with-no-edits articles.\n- Review: cloud-luna-high and cloud-sol-medium combine a leading Reviewer score with full completion. The Kimi candidates tie on completed Reviewer quality but not reliability.\n- Exclude cloud-kimi-k3 and cloud-kimi-2-7 from unattended production because of low completion and structured compliance. Exclude local-qwen3-14b because of low editorial quality, a timeout, and major-rewrite readiness.\n- The completed campaign is sufficient to begin human-supervised pipeline design. Further model benchmarking is not required before that design work, though production holdout validation remains appropriate before deployment.\n`;
  return {
    'leaderboard.md': leaderboard,
    'executive-summary.md': executive,
    'stage-specialists.md': specialists,
    'reliability-report.md': reliability,
    'publication-report.md': publication,
    'runtime-usage-report.md': runtime,
    'historical-report.md': historical,
    'final-model-comparison.md': comparison
  };
}

export async function writeV103Outputs({ index, outputDir }) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'results-index.json'), `${JSON.stringify(index, null, 2)}\n`);
  const reports = generateV103Reports(index);
  for (const [name, content] of Object.entries(reports)) await fs.writeFile(path.join(outputDir, name), content);
  return Object.keys(reports);
}
