#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFeed, parseSitemap, extractLinks, fetchDocument, clusterCandidates } from '../src/pipeline/acquisition.mjs';
import { loadState, saveState, transition } from '../src/pipeline/state.mjs';
import { CandidateOrchestrator } from '../src/pipeline/orchestrator.mjs';
import { loadSourceConfig } from '../src/pipeline/source-config.mjs';
import { createClient } from '@supabase/supabase-js';

const [command, id] = process.argv.slice(2);
const root = process.env.ANYWAYS_PIPELINE_STATE_DIR || 'pipeline-state';
const stateFile = process.env.ANYWAYS_PIPELINE_STATE_FILE || path.join(root, 'state.json');
const registryFile = process.env.ANYWAYS_PIPELINE_SOURCES_FILE || path.join(root, 'sources.json');

const errorDetails = error => {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code?.startsWith?.('SOURCE_CONFIG_') || error?.code === 'PIPELINE_STATE_NOT_CONFIGURED') return { code: error.code, message, retryable: false };
  if (/ENOENT|sources\.json/i.test(message)) return { code: 'PIPELINE_STATE_NOT_CONFIGURED', message, retryable: false };
  if (/Candidate not found|Run not found/i.test(message)) return { code: 'NOT_FOUND', message, retryable: false };
  if (/Ollama|MODEL_TIMEOUT|abort|timeout/i.test(message)) return { code: 'MODEL_UNAVAILABLE', message, retryable: true };
  if (/fetch|ECONNRESET|EAI_AGAIN|HTTP 5\d\d/i.test(message)) return { code: 'SOURCE_FETCH_FAILED', message, retryable: true };
  return { code: 'PIPELINE_COMMAND_FAILED', message, retryable: false };
};

const final = payload => console.log(JSON.stringify(payload));
const requireId = name => { if (!id) throw new Error(`${name} requires an id argument`); };

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
    const result = await new CandidateOrchestrator().process({ state, candidateId: id });
    await saveState(stateFile, state);
    return { candidate_id: id, status: result.candidate.status, run_id: result.run?.id || null, review_id: result.review?.id || null };
  }
  if (command === 'retry') {
    requireId('retry');
    const run = state.runs.find(item => item.id === id);
    if (!run) throw new Error('Run not found');
    run.retry_requested_at = new Date().toISOString();
    if (!run.candidate_id) throw new Error('Only candidate processing runs can be retried.');
    const result = await new CandidateOrchestrator().process({ state, candidateId: run.candidate_id, resume: false });
    await saveState(stateFile, state);
    return { run_id: id, retry_requested_at: run.retry_requested_at, candidate_id: run.candidate_id, replacement_run_id: result.run?.id || null, status: result.candidate.status, review_id: result.review?.id || null };
  }
  throw new Error('Usage: anyways-ops.mjs <discover|status|research|process|retry> [id]');
}

try {
  const result = await main();
  final({ ok: true, command, ...(id ? { candidate_id: command === 'process' ? id : undefined, run_id: command === 'retry' ? id : undefined } : {}), result });
} catch (error) {
  final({ ok: false, command: command || null, ...(id ? { candidate_id: command === 'process' ? id : undefined, run_id: command === 'retry' ? id : undefined } : {}), error: errorDetails(error) });
  process.exitCode = 1;
}
