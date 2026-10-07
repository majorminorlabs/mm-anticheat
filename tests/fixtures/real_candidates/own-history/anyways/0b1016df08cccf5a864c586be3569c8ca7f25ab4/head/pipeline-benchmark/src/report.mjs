import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, walkFiles, writeFileAtomic, writeJsonAtomic } from './util.mjs';

function csvCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function generateRunReports(runDirectory, { stageResults = [] } = {}) {
  const rawRoot = path.join(runDirectory, 'private', 'raw');
  let files = [];
  try {
    files = (await walkFiles(rawRoot)).filter(file => file.endsWith('.json'));
  } catch {}
  const findings = [];
  const metrics = [];
  for (const file of files) {
    const record = await readJson(file);
    metrics.push({
      model_id: record.model_id,
      fixture_id: record.fixture_id,
      stage: record.stage,
      status: record.status || 'completed',
      prompt_hash: record.prompt_hash,
      failure: record.failure || null,
      ...record.metrics
    });
    for (const item of record.evaluation?.findings || []) findings.push({
      model_id: record.model_id,
      fixture_id: record.fixture_id,
      stage: record.stage,
      code: item.code,
      severity: item.severity,
      message: item.message,
      location: item.location
    });
  }
  const reportRoot = path.join(runDirectory, 'private', 'reports');
  await writeJsonAtomic(path.join(reportRoot, 'deterministic-findings.json'), {
    disclaimer: 'These checks measure compliance with frozen fixtures. They do not score voice or truth beyond the frozen packet.',
    findings
  }, { mode: 0o600 });
  await writeJsonAtomic(path.join(reportRoot, 'runtime-metrics.json'), { requests: metrics }, { mode: 0o600 });
  const header = ['model_id', 'fixture_id', 'stage', 'code', 'severity', 'message', 'location'];
  const rows = findings.map(item => header.map(key => csvCell(item[key])).join(','));
  await writeFileAtomic(path.join(reportRoot, 'deterministic-findings.csv'), `${header.join(',')}\n${rows.join('\n')}${rows.length ? '\n' : ''}`, { mode: 0o600 });
  const stageStatusCounts = {};
  for (const result of stageResults) stageStatusCounts[result.status] = (stageStatusCounts[result.status] || 0) + 1;
  return {
    stage_artifact_count: files.length,
    raw_output_count: metrics.filter(item => item.status === 'completed').length,
    failed_stage_artifact_count: metrics.filter(item => item.status === 'failed').length,
    finding_count: findings.length,
    request_metric_count: metrics.length,
    stage_status_counts: stageStatusCounts
  };
}
