#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFeed, parseSitemap, extractLinks, fetchDocument, clusterCandidates } from '../src/pipeline/acquisition.mjs';
import { loadState, saveState, transition } from '../src/pipeline/state.mjs';
import { CandidateOrchestrator } from '../src/pipeline/orchestrator.mjs';
import { loadSourceConfig } from '../src/pipeline/source-config.mjs';
import { createClient } from '@supabase/supabase-js';
import { commissionCandidate } from '../src/pipeline/commission.mjs';
import { allocateSectionQuotas, deterministicNovelty, selectBatchCandidates } from '../src/editorial-batch.mjs';

const [command, id] = process.argv.slice(2);
const root = process.env.ANYWAYS_PIPELINE_STATE_DIR || 'pipeline-state';
const stateFile = process.env.ANYWAYS_PIPELINE_STATE_FILE || path.join(root, 'state.json');
const registryFile = process.env.ANYWAYS_PIPELINE_SOURCES_FILE || path.join(root, 'sources.json');

const errorDetails = error => {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === 'INVALID_PARAMETERS') return { code: error.code, message, retryable: false };
  if (error?.code?.startsWith?.('SOURCE_CONFIG_') || error?.code === 'PIPELINE_STATE_NOT_CONFIGURED') return { code: error.code, message, retryable: false };
  if (/ENOENT|sources\.json/i.test(message)) return { code: 'PIPELINE_STATE_NOT_CONFIGURED', message, retryable: false };
  if (/Candidate not found|Run not found/i.test(message)) return { code: 'NOT_FOUND', message, retryable: false };
  if (/Ollama|MODEL_TIMEOUT|abort|timeout/i.test(message)) return { code: 'MODEL_UNAVAILABLE', message, retryable: true };
  if (/fetch|ECONNRESET|EAI_AGAIN|HTTP 5\d\d/i.test(message)) return { code: 'SOURCE_FETCH_FAILED', message, retryable: true };
  return { code: 'PIPELINE_COMMAND_FAILED', message, retryable: false };
};

const final = payload => console.log(JSON.stringify(payload));
const requireId = name => { if (!id) throw new Error(`${name} requires an id argument`); };

async function applySourceDefaults(candidate) {
  if (!candidate || candidate.commission || candidate.classification?.primary_section) return candidate;
  const registry = await loadSourceConfig(registryFile);
  const source = registry.find(item => item.id === candidate.source_id);
  if (!source?.default_section) return candidate;
  candidate.classification = {
    ...(candidate.classification || {}),
    primary_section: source.default_section,
    recurring_beats: source.default_recurring_beats || [],
    tags: source.default_tags || []
  };
  return candidate;
}

async function snapshotPipelineRegistry(registry, candidates) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { status: 'not_configured' };
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const rows = registry.map(source => ({
    external_id: source.id,
    name: source.name,
    source_type: source.type,
    locator: source.url,
    enabled: source.enabled,
    priority: source.priority,
    default_section: source.default_section || null,
    default_tags: source.default_tags,
    default_beats: source.default_recurring_beats,
    polling_frequency_minutes: source.polling_frequency_minutes,
    last_checked_at: source.last_checked_at || null,
    last_successful_check_at: source.last_successful_check_at || null,
    failure_count: source.failure_count || 0,
    notes: source.notes || null
  }));
  const { error } = await client.from('pipeline_sources').upsert(rows, { onConflict: 'external_id' });
  if (error) return { status: 'failed', message: error.message };
  const { data: candidateCount, error: candidateError } = await client.rpc('sync_pipeline_discovery_candidates', { p_candidates: candidates });
  if (candidateError) return { status: 'failed', message: candidateError.message, sources: rows.length };
  return { status: 'synced', sources: rows.length, candidates: Number(candidateCount || 0) };
}

async function main() {
  const state = await loadState(stateFile);
  if (command === 'discover') {
    const registry = await loadSourceConfig(registryFile);
    const discovered = []; let rejected = 0; let sourcesChecked = 0;
    for (const source of registry.filter(item => item.enabled)) {
      sourcesChecked++;
      let doc;
      try { doc = await fetchDocument(source.url); }
      catch (error) { source.failure_count = (source.failure_count || 0) + 1; rejected++; continue; }
      if (!doc.ok) { source.failure_count = (source.failure_count || 0) + 1; rejected++; continue; }
      const entries = source.type === 'rss' || source.type === 'atom' ? parseFeed(doc.raw, source.id) : source.type === 'sitemap' ? parseSitemap(doc.raw, source.id) : extractLinks(doc.raw, doc.url, source.id);
      discovered.push(...entries);
      source.last_checked_at = new Date().toISOString();
      source.last_successful_check_at = source.last_checked_at;
      source.failure_count = 0;
    }
    const known = new Set(state.candidates.map(item => item.url)); let created = 0; let duplicates = 0;
    for (const item of discovered) { if (!known.has(item.url)) { state.candidates.push({ ...item, status: 'discovered', history: [{ at: new Date().toISOString(), actor: 'discovery', status: 'discovered', note: 'deterministic discovery' }] }); created++; } else duplicates++; }
    state.clusters = clusterCandidates(state.candidates);
    state.runs.push({ type: 'discovery', at: new Date().toISOString(), discovered: discovered.length, clusters: state.clusters.length });
    await fs.writeFile(registryFile, JSON.stringify(registry, null, 2));
    await saveState(stateFile, state);
    const sourceRegistry = await snapshotPipelineRegistry(registry, state.candidates);
    return { sources_checked: sourcesChecked, items_fetched: discovered.length, items_rejected: rejected, candidates_created: created, duplicates_skipped: duplicates, clusters: state.clusters.length, source_registry: sourceRegistry };
  }
  if (command === 'status') return { candidates: Object.groupBy(state.candidates, item => item.status), runs: state.runs.slice(-10) };
  if (command === 'batch') {
    const registry = await loadSourceConfig(registryFile);
    const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw Object.assign(new Error('Editorial batches require Supabase service credentials.'), { code: 'PIPELINE_STATE_NOT_CONFIGURED' });
    const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: batch, error: batchError } = await client.from('pipeline_batch_runs').select('id,preset_id,target_count,section_quotas,pipeline_presets(rotation,beat_cap)').in('status', ['queued','discovering']).order('requested_at').limit(1).maybeSingle();
    if (batchError) throw batchError;
    if (!batch) return { status: 'no_queued_batch' };
    await client.from('pipeline_batch_runs').update({ status: 'discovering', started_at: new Date().toISOString() }).eq('id', batch.id);
    const discovered = []; for (const source of registry.filter(item => item.enabled)) {
      try { const doc = await fetchDocument(source.url); if (!doc.ok) continue; const entries = source.type === 'rss' || source.type === 'atom' ? parseFeed(doc.raw, source.id) : source.type === 'sitemap' ? parseSitemap(doc.raw, source.id) : extractLinks(doc.raw, doc.url, source.id); discovered.push(...entries); source.last_checked_at = new Date().toISOString(); source.last_successful_check_at = source.last_checked_at; source.failure_count = 0; }
      catch { source.failure_count = (source.failure_count || 0) + 1; }
    }
    const known = new Set(state.candidates.map(item => item.url));
    for (const item of discovered) if (!known.has(item.url)) state.candidates.push({ ...item, status: 'discovered', history: [{ at: new Date().toISOString(), actor: 'editorial_batch', status: 'discovered', note: 'batch discovery' }] });
    state.clusters = clusterCandidates(state.candidates); await fs.writeFile(registryFile, JSON.stringify(registry, null, 2)); await saveState(stateFile, state);
    await snapshotPipelineRegistry(registry, state.candidates);
    const [{ data: existing = [] }, { data: databaseCandidates = [] }] = await Promise.all([
      client.from('stories').select('id,title,dek,status').in('status', ['published','fact_check','scheduled','hidden','draft','review']),
      client.from('candidate_stories').select('id,external_id,title,status,canonical_url').in('status', ['discovered','watching','rejected'])
    ]);
    const sourceById = new Map(registry.map(source => [source.id, source]));
    const dbByExternal = new Map(databaseCandidates.map(candidate => [candidate.external_id, candidate]));
    const pool = state.candidates.filter(candidate => ['discovered','watching','rejected'].includes(candidate.status)).map(candidate => {
      const source = sourceById.get(candidate.source_id || candidate.sourceId || candidate.source || '');
      const row = dbByExternal.get(candidate.id);
      return { ...candidate, database_id: row?.id, section_id: source?.default_section, beats: source?.default_recurring_beats || [], novelty: deterministicNovelty(candidate, existing) };
    }).filter(candidate => candidate.database_id && candidate.section_id).sort((a, b) => (sourceById.get(b.source_id || b.sourceId)?.priority || 0) - (sourceById.get(a.source_id || a.sourceId)?.priority || 0));
    const quotas = allocateSectionQuotas(batch.target_count, batch.section_quotas, batch.pipeline_presets?.rotation || 0);
    const selection = selectBatchCandidates(pool, quotas, batch.pipeline_presets?.beat_cap || 2);
    await client.from('pipeline_batch_runs').update({ status: 'processing', shortfalls: selection.shortfalls, summary: { discovered: discovered.length, selected: selection.selected.length, excluded: selection.excluded.length } }).eq('id', batch.id);
    for (const excluded of selection.excluded) await client.from('pipeline_batch_items').insert({ batch_run_id: batch.id, candidate_id: excluded.candidate.database_id, section_id: excluded.candidate.section_id, beats: excluded.candidate.beats, selection_status: excluded.reason === 'review' ? 'needs_review' : excluded.reason === 'blocked' ? 'excluded_duplicate' : 'excluded_beat_cap', selection_reason: { reason: excluded.reason }, novelty: excluded.candidate.novelty, source_provenance: { source_id: excluded.candidate.source_id || excluded.candidate.sourceId } });
    for (const candidate of selection.selected) {
      const { data: job, error } = await client.rpc('submit_pipeline_job', { p_job_type: 'process_candidate', p_parameters: { candidate_id: candidate.id }, p_source: 'controller', p_priority: 50, p_max_attempts: 3, p_requested_by: null });
      if (error) throw error;
      await client.from('pipeline_batch_items').insert({ batch_run_id: batch.id, candidate_id: candidate.database_id, section_id: candidate.section_id, beats: candidate.beats, selection_status: 'selected', selection_reason: { reason: 'quota_and_novelty_passed' }, novelty: candidate.novelty, source_provenance: { source_id: candidate.source_id || candidate.sourceId }, job_id: job.id });
    }
    if (!selection.selected.length) await client.from('pipeline_batch_runs').update({ status: 'complete_with_shortfall', finished_at: new Date().toISOString(), summary: { discovered: discovered.length, selected: 0, excluded: selection.excluded.length, review_ready: 0, processing_failed: 0 } }).eq('id', batch.id);
    return { batch_id: batch.id, discovered: discovered.length, selected: selection.selected.length, shortfalls: selection.shortfalls, needs_review: selection.excluded.filter(item => item.reason === 'review').length };
  }
  if (command === 'research') {
    requireId('research');
    const item = state.candidates.find(candidate => candidate.id === id);
    if (!item) throw new Error('Candidate not found');
    transition(item, 'researching', 'operator');
    await saveState(stateFile, state);
    return item;
  }
  if (command === 'process') {
    requireId('process');
    await applySourceDefaults(state.candidates.find(candidate => candidate.id === id));
    const result = await new CandidateOrchestrator().process({ state, candidateId: id });
    await saveState(stateFile, state);
    return { candidate_id: id, status: result.candidate.status, run_id: result.run?.id || null, review_id: result.review?.id || null };
  }
  if (command === 'commission') {
    requireId('commission');
    let request;
    try { request = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); }
    catch { throw Object.assign(new Error('Commission request is not valid encoded JSON.'), { code: 'INVALID_PARAMETERS' }); }
    const candidate = commissionCandidate(request);
    const existing = state.candidates.find(item => item.id === candidate.id);
    if (!existing) state.candidates.push(candidate);
    const result = await new CandidateOrchestrator().process({ state, candidateId: candidate.id });
    await saveState(stateFile, state);
    return { candidate_id: candidate.id, status: result.candidate.status, run_id: result.run?.id || null, review_id: result.review?.id || null };
  }
  if (command === 'retry') {
    requireId('retry');
    const run = state.runs.find(item => item.id === id);
    if (!run) throw new Error('Run not found');
    run.retry_requested_at = new Date().toISOString();
    if (!run.candidate_id) throw new Error('Only candidate processing runs can be retried.');
    await applySourceDefaults(state.candidates.find(candidate => candidate.id === run.candidate_id));
    const result = await new CandidateOrchestrator().process({ state, candidateId: run.candidate_id, resume: false });
    await saveState(stateFile, state);
    return { run_id: id, retry_requested_at: run.retry_requested_at, candidate_id: run.candidate_id, replacement_run_id: result.run?.id || null, status: result.candidate.status, review_id: result.review?.id || null };
  }
  throw new Error('Usage: anyways-ops.mjs <discover|status|research|process|commission|retry> [id]');
}

try {
  const result = await main();
  final({ ok: true, command, ...(id ? { candidate_id: command === 'process' ? id : undefined, run_id: command === 'retry' ? id : undefined } : {}), result });
} catch (error) {
  final({ ok: false, command: command || null, ...(id ? { candidate_id: command === 'process' ? id : undefined, run_id: command === 'retry' ? id : undefined } : {}), error: errorDetails(error) });
  process.exitCode = 1;
}
