#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { parseFeed, parseSitemap, extractLinks, fetchDocument, clusterCandidates } from '../src/pipeline/acquisition.mjs';
import { loadState, saveState, transition } from '../src/pipeline/state.mjs';
import { loadSourceConfig } from '../src/pipeline/source-config.mjs';
import { createClient } from '@supabase/supabase-js';
import { allocateSectionQuotas, deterministicNovelty } from '../src/editorial-batch.mjs';
import { syncDiscoveryProjection } from '../src/pipeline/discovery-projection.mjs';
import { CodexWriterAdapter } from '../src/pipeline/codex-writer.mjs';
import { commodityLeadReason } from '../src/pipeline/pitch.mjs';
import { commissionCandidate } from '../src/pipeline/commission.mjs';
import { Phase2Orchestrator } from '../src/pipeline/phase2-orchestrator.mjs';
import { createSupabasePhase2Persistence } from '../src/pipeline/phase2-persistence.mjs';
import { CandidateOrchestrator } from '../src/pipeline/orchestrator.mjs';
import { canRunPipelineV1, isPipelineV1Job, pipelineV1Enabled } from '../src/pipeline/feature-flags.mjs';
import { runSolPolish } from '../src/pipeline/sol-polish.mjs';
import { STORY_FORM_BY_ID } from '../src/editorial.mjs';

const [command, id] = process.argv.slice(2);
const flagValue = flag => { const index = process.argv.indexOf(flag); return index < 0 ? null : process.argv[index + 1] || null; };
const root = process.env.ANYWAYS_PIPELINE_STATE_DIR || 'pipeline-state';
const stateFile = process.env.ANYWAYS_PIPELINE_STATE_FILE || path.join(root, 'state.json');
const registryFile = process.env.ANYWAYS_PIPELINE_SOURCES_FILE || path.join(root, 'sources.json');
let activeEditorialBatch = null;

const errorDetails = error => {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === 'INVALID_PARAMETERS') return { code: error.code, message, retryable: false };
  if (error?.code?.startsWith?.('SOURCE_CONFIG_') || error?.code === 'PIPELINE_STATE_NOT_CONFIGURED') return { code: error.code, message, retryable: false };
  if (/ENOENT|sources\.json/i.test(message)) return { code: 'PIPELINE_STATE_NOT_CONFIGURED', message, retryable: false };
  if (/Candidate not found|Run not found/i.test(message)) return { code: 'NOT_FOUND', message, retryable: false };
  if (error?.code?.startsWith?.('PHASE2_')) return { code: error.code, message, retryable: false };
  if (/MODEL_TIMEOUT|abort|timeout/i.test(message)) return { code: 'MODEL_UNAVAILABLE', message, retryable: true };
  if (error?.code === 'DISCOVERY_PERSISTENCE_FAILED') return { code: error.code, message, retryable: true };
  if (error?.code === 'PHASE2_PERSISTENCE_FAILED') return { code: error.code, message, retryable: true };
  if (/fetch|ECONNRESET|EAI_AGAIN|HTTP 5\d\d/i.test(message)) return { code: 'SOURCE_FETCH_FAILED', message, retryable: true };
  return { code: 'PIPELINE_COMMAND_FAILED', message, retryable: false };
};

const final = payload => console.log(JSON.stringify(payload));
const requireId = name => { if (!id) throw new Error(`${name} requires an id argument`); };
const requestValue = () => {
  const index = process.argv.indexOf('--request');
  const encoded = index < 0 ? null : process.argv[index + 1];
  if (!encoded) throw Object.assign(new Error('create_editorial_pitch requires a request payload.'), { code: 'INVALID_PARAMETERS' });
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be an object.');
    return value;
  } catch (error) {
    throw Object.assign(new Error(`Invalid editorial pitch request: ${error.message}`), { code: 'INVALID_PARAMETERS' });
  }
};

async function snapshotPipelineRegistry(registry, candidates) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { status: 'not_configured' };
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return syncDiscoveryProjection({ client, registry, candidates });
}

async function claimPitchForProcessing(client, candidateId) {
  const { data, error } = await client.rpc('claim_editorial_pitch_processing', { p_candidate_external_id: candidateId });
  if (error) throw error;
  if (!data?.job_id) throw Object.assign(new Error('An active editor commission is required before reporting.'), { code: 'PITCH_NOT_COMMISSIONABLE' });
  return data;
}

async function requiredSupabase(operation, label) {
  const { data, error } = await operation;
  if (error) throw Object.assign(new Error(`${label}: ${error.message}`), { code: 'DISCOVERY_PERSISTENCE_FAILED', cause: error });
  return data;
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
  if (command === 'create_editorial_pitch') {
    const request = requestValue();
    const candidate = commissionCandidate(request);
    const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw Object.assign(new Error('Focused editorial pitches require Supabase service credentials.'), { code: 'PIPELINE_STATE_NOT_CONFIGURED' });
    const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const existing = state.candidates.find(item => item.id === candidate.id);
    const local = existing || candidate;
    if (!existing) state.candidates.push(local);
    const commodityReason = commodityLeadReason(local);
    let pitch;
    if (commodityReason) {
      transition(local, 'rejected', 'editorial_pitch_gate', commodityReason);
      await saveState(stateFile, state);
      const { error } = await client.rpc('sync_pipeline_discovery_candidates', { p_candidates: [local] });
      if (error) throw Object.assign(new Error(`Could not retain rejected pitch: ${error.message}`), { code: 'DISCOVERY_PERSISTENCE_FAILED', cause: error });
      return { candidate_id: local.id, status: 'rejected', rejection_reason: commodityReason };
    }
    pitch = await new CodexWriterAdapter().pitch({ candidate: local, section: request.section_id, requestedForm: request.story_form });
    if (!pitch.accepted) {
      transition(local, 'rejected', 'editorial_pitch_gate', pitch.rejection_reason);
      await saveState(stateFile, state);
      const { error } = await client.rpc('sync_pipeline_discovery_candidates', { p_candidates: [local] });
      if (error) throw Object.assign(new Error(`Could not retain rejected pitch: ${error.message}`), { code: 'DISCOVERY_PERSISTENCE_FAILED', cause: error });
      return { candidate_id: local.id, status: 'rejected', rejection_reason: pitch.rejection_reason };
    }
    local.title = pitch.headline;
    local.commission = {
      ...local.commission,
      brief: `${request.brief}\n\nEDITORIAL LENS\n${pitch.lens}\n\nSECTION ANSWER\n${pitch.section_answer}\n\nWHY NOW\n${pitch.why_now}\n\nREADER TAKEAWAY\n${pitch.reader_takeaway}\n\nEVIDENCE TO PROVE\n${pitch.evidence_plan.map(item => `- ${item}`).join('\n')}`,
      section_id: pitch.primary_section,
      story_form: pitch.story_form
    };
    local.classification = { ...(local.classification || {}), primary_section: pitch.primary_section, story_form: pitch.story_form, editorial_pitch: pitch };
    transition(local, 'pitch_ready', 'editorial_pitch_gate', `Focused assignment accepted: ${pitch.lens}`);
    await saveState(stateFile, state);
    const { error } = await client.rpc('sync_pipeline_discovery_candidates', { p_candidates: [local] });
    if (error) throw Object.assign(new Error(`Could not retain editorial pitch: ${error.message}`), { code: 'DISCOVERY_PERSISTENCE_FAILED', cause: error });
    return { candidate_id: local.id, status: 'pitch_ready', headline: pitch.headline, accepted: true };
  }
  if (command === 'batch') {
    const registry = await loadSourceConfig(registryFile);
    const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw Object.assign(new Error('Editorial batches require Supabase service credentials.'), { code: 'PIPELINE_STATE_NOT_CONFIGURED' });
    const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: batch, error: batchError } = await client.from('pipeline_batch_runs').select('id,preset_id,target_count,section_quotas,requested_section_id,requested_story_form,pipeline_presets(rotation,beat_cap)').in('status', ['queued','discovering']).order('requested_at').limit(1).maybeSingle();
    if (batchError) throw batchError;
    if (!batch) return { status: 'no_queued_batch' };
    activeEditorialBatch = { id: batch.id, client };
    await requiredSupabase(client.from('pipeline_batch_runs').update({ status: 'discovering', started_at: new Date().toISOString() }).eq('id', batch.id), 'Could not start editorial batch');
    const discovered = []; for (const source of registry.filter(item => item.enabled)) {
      try { const doc = await fetchDocument(source.url); if (!doc.ok) continue; const entries = source.type === 'rss' || source.type === 'atom' ? parseFeed(doc.raw, source.id) : source.type === 'sitemap' ? parseSitemap(doc.raw, source.id) : extractLinks(doc.raw, doc.url, source.id); discovered.push(...entries); source.last_checked_at = new Date().toISOString(); source.last_successful_check_at = source.last_checked_at; source.failure_count = 0; }
      catch { source.failure_count = (source.failure_count || 0) + 1; }
    }
    const known = new Set(state.candidates.map(item => item.url));
    for (const item of discovered) {
      if (known.has(item.url)) continue;
      known.add(item.url);
      state.candidates.push({ ...item, status: 'discovered', history: [{ at: new Date().toISOString(), actor: 'editorial_batch', status: 'discovered', note: 'batch discovery' }] });
    }
    state.clusters = clusterCandidates(state.candidates); await fs.writeFile(registryFile, JSON.stringify(registry, null, 2)); await saveState(stateFile, state);
    await snapshotPipelineRegistry(registry, state.candidates);
    const [existing, databaseCandidates] = await Promise.all([
      requiredSupabase(client.from('stories').select('id,title,dek,status').in('status', ['published','fact_check','scheduled','hidden','draft','review']), 'Could not load existing stories for novelty checks'),
      requiredSupabase(client.from('candidate_stories').select('id,external_id,title,status,canonical_url').in('status', ['discovered','watching']), 'Could not load discovery candidates')
    ]);
    const sourceById = new Map(registry.map(source => [source.id, source]));
    const dbByExternal = new Map(databaseCandidates.map(candidate => [candidate.external_id, candidate]));
    const pool = state.candidates.filter(candidate => ['discovered','watching'].includes(candidate.status)).map(candidate => {
      const source = sourceById.get(candidate.source_id || candidate.sourceId || candidate.source || '');
      const row = dbByExternal.get(candidate.id);
      return { ...candidate, database_id: row?.id, section_id: batch.requested_section_id || source?.default_section, beats: source?.default_recurring_beats || [], novelty: deterministicNovelty(candidate, existing) };
    }).filter(candidate => candidate.database_id && candidate.section_id).sort((a, b) => (sourceById.get(b.source_id || b.sourceId)?.priority || 0) - (sourceById.get(a.source_id || a.sourceId)?.priority || 0));
    const quotas = allocateSectionQuotas(batch.target_count, batch.section_quotas, batch.pipeline_presets?.rotation || 0);
    const shortfalls = { ...quotas }, beats = new Map(), selected = [], excluded = [];
    const pitchWriter = new CodexWriterAdapter();
    await requiredSupabase(client.from('pipeline_batch_runs').update({ status: 'screening', shortfalls, summary: { discovered: discovered.length, screened: 0, pitch_ready: 0 } }).eq('id', batch.id), 'Could not mark editorial batch as screening');
    for (const candidate of pool) {
      if (selected.length >= batch.target_count) break;
      const sectionId = batch.requested_section_id || candidate.section_id;
      if (!shortfalls[sectionId]) continue;
      const candidateBeats = candidate.beats || [];
      const novelty = deterministicNovelty(candidate, [...existing, ...selected.map(item => ({ id: item.database_id, title: item.title, dek: item.pitch?.lens || '', status: 'pitch_ready' }))]);
      candidate.novelty = novelty;
      if (novelty?.decision && novelty.decision !== 'clear') { excluded.push({ candidate, reason: novelty.decision }); continue; }
      if (candidateBeats.some(beat => (beats.get(beat) || 0) >= (batch.pipeline_presets?.beat_cap || 2))) { excluded.push({ candidate, reason: 'beat_cap' }); continue; }
      const local = state.candidates.find(item => item.id === candidate.id);
      const commodityReason = commodityLeadReason(candidate);
      if (commodityReason) {
        if (local) transition(local, 'rejected', 'editorial_pitch_gate', commodityReason);
        excluded.push({ candidate, reason: 'editorial_rejection', detail: commodityReason });
        continue;
      }
      let pitch;
      try { pitch = await pitchWriter.pitch({ candidate, section: sectionId, requestedForm: batch.requested_story_form || null }); }
      catch (error) { excluded.push({ candidate, reason: 'pitch_gate_failed', detail: error.message }); continue; }
      if (!pitch.accepted) {
        if (local) transition(local, 'rejected', 'editorial_pitch_gate', pitch.rejection_reason);
        excluded.push({ candidate, reason: 'editorial_rejection', detail: pitch.rejection_reason });
        continue;
      }
      if (local) {
        local.title = pitch.headline;
        local.commission = {
          brief: `${pitch.lens}\n\nSECTION ANSWER\n${pitch.section_answer}\n\nWHY NOW\n${pitch.why_now}\n\nREADER TAKEAWAY\n${pitch.reader_takeaway}\n\nEVIDENCE TO PROVE\n${pitch.evidence_plan.map(item => `- ${item}`).join('\n')}`,
          section_id: pitch.primary_section,
          story_form: pitch.story_form,
          beats: candidateBeats,
          tags: local.classification?.tags || [],
          notes: 'This article was commissioned from an editor-approved discovery pitch.',
          source_urls: [local.url]
        };
        local.classification = { ...(local.classification || {}), primary_section: pitch.primary_section, story_form: pitch.story_form, recurring_beats: candidateBeats, editorial_pitch: pitch };
        transition(local, 'pitch_ready', 'editorial_pitch_gate', `Pitch accepted: ${pitch.lens}`);
      }
      selected.push({ ...candidate, title: pitch.headline, section_id: pitch.primary_section, pitch });
      shortfalls[sectionId]--;
      candidateBeats.forEach(beat => beats.set(beat, (beats.get(beat) || 0) + 1));
    }
    if (selected.length > batch.target_count || Object.values(shortfalls).some(value => !Number.isInteger(value) || value < 0)) throw new Error('Editorial pitch quota accounting failed.');
    await saveState(stateFile, state);
    await snapshotPipelineRegistry(registry, state.candidates);
    await requiredSupabase(client.from('pipeline_batch_runs').update({ status: 'processing', shortfalls, summary: { discovered: discovered.length, screened: selected.length + excluded.length, pitch_ready: selected.length, rejected: excluded.length } }).eq('id', batch.id), 'Could not persist editorial batch screening results');
    for (const excludedCandidate of excluded) await requiredSupabase(client.from('pipeline_batch_items').insert({ batch_run_id: batch.id, candidate_id: excludedCandidate.candidate.database_id, section_id: excludedCandidate.candidate.section_id, beats: excludedCandidate.candidate.beats, selection_status: excludedCandidate.reason === 'review' ? 'needs_review' : ['blocked','duplicate'].includes(excludedCandidate.reason) ? 'excluded_duplicate' : excludedCandidate.reason === 'beat_cap' ? 'excluded_beat_cap' : 'excluded_quota', selection_reason: { reason: excludedCandidate.reason, detail: excludedCandidate.detail || null }, novelty: excludedCandidate.candidate.novelty, source_provenance: { source_id: excludedCandidate.candidate.source_id || excludedCandidate.candidate.sourceId } }), 'Could not persist excluded pitch candidate');
    for (const candidate of selected) {
      await requiredSupabase(client.from('pipeline_batch_items').insert({ batch_run_id: batch.id, candidate_id: candidate.database_id, section_id: candidate.section_id, beats: candidate.beats, selection_status: 'pitch_ready', selection_reason: { reason: 'editorial_pitch_passed', pitch: candidate.pitch }, novelty: candidate.novelty, source_provenance: { source_id: candidate.source_id || candidate.sourceId } }), 'Could not persist accepted editorial pitch');
    }
    const status = selected.length === batch.target_count ? 'complete' : 'complete_with_shortfall';
    await requiredSupabase(client.from('pipeline_batch_runs').update({ status, finished_at: new Date().toISOString(), shortfalls, summary: { discovered: discovered.length, screened: selected.length + excluded.length, pitch_ready: selected.length, rejected: excluded.length } }).eq('id', batch.id), 'Could not finalize editorial batch');
    return { batch_id: batch.id, discovered: discovered.length, pitch_ready: selected.length, rejected: excluded.length, shortfalls, needs_review: excluded.filter(item => item.reason === 'review').length };
  }
  if (command === 'process') {
    requireId('process');
    const local = state.candidates.find(candidate => candidate.id === id);
    const authorizationAction = flagValue('--action');
    const controllerJobId = flagValue('--job-id');
    const researchAuthorization = authorizationAction === 'research_again';
    const pipelineVersion = flagValue('--pipeline-version');
    const v1Job = isPipelineV1Job({ pipeline_version: pipelineVersion });
    const v1Active = canRunPipelineV1({ pipeline_version: pipelineVersion }, process.env, controllerJobId);
    if (researchAuthorization && !v1Active) throw Object.assign(new Error('Pipeline V1 is disabled; research again is unavailable.'), { code: 'PIPELINE_V1_DISABLED' });
    if (!v1Active) {
      if (!local || local.classification?.editorial_pitch?.accepted !== true || !local.commission) throw Object.assign(new Error('Only an editor-approved pitch can begin reporting.'), { code: 'PITCH_NOT_COMMISSIONABLE' });
      const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !serviceKey) throw Object.assign(new Error('Editorial pitch processing requires Supabase service credentials.'), { code: 'PIPELINE_STATE_NOT_CONFIGURED' });
      const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const authorization = await claimPitchForProcessing(client, id);
      const result = await new CandidateOrchestrator().process({ state, candidateId: id, actor: 'pipeline_controller', resume: true, commissionAuthorization: authorization });
      await saveState(stateFile, state);
      return { candidate_id: id, status: result.candidate?.status || 'unknown', pipeline_version: 'legacy', run_id: result.run?.id || null, review_id: result.review?.id || null, error: result.error || null, v1_requested: v1Job, v1_enabled: pipelineV1Enabled(process.env) };
    }
    const hasPreparedFrozenPacket = local && (state.research_packets || []).some(item => item.candidate_id === id && item.packet?.supersedes_frozen_evidence_packet_sha256);
    const resumable = local && (['research_blocked','verification_failed'].includes(local.status) || (local.status === 'failed' && hasPreparedFrozenPacket));
    const eligible = resumable || local?.status === 'pitch_ready';
    if (!local || !eligible || local.classification?.editorial_pitch?.accepted !== true || !local.commission) throw Object.assign(new Error('Only an editor-approved pitch can begin reporting.'), { code: 'PITCH_NOT_COMMISSIONABLE' });
    if (researchAuthorization && local.status !== 'research_blocked') throw Object.assign(new Error('Research again requires a research-blocked Phase 2 candidate.'), { code: 'PHASE2_ACTION_NOT_ALLOWED' });
    const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw Object.assign(new Error('Editorial pitch processing requires Supabase service credentials.'), { code: 'PIPELINE_STATE_NOT_CONFIGURED' });
    const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const authorization = {
      ...(await claimPitchForProcessing(client, id)),
      ...(researchAuthorization ? { action: 'research_again' } : {}),
      pipeline_version: 'v1',
      research_requirement: local.classification?.editorial_pitch?.research_requirement || local.commission?.research_requirement || null,
      ...(local.commission?.readiness_inventory ? { readiness_inventory: local.commission.readiness_inventory } : {}),
      ...(local.commission?.readiness_inventory_sha256 ? { readiness_inventory_sha256: local.commission.readiness_inventory_sha256 } : {}),
      ...(local.commission?.assignment_checksum || local.commission?.readiness_inventory?.assignment_checksum ? { assignment_checksum: local.commission.assignment_checksum || local.commission.readiness_inventory.assignment_checksum } : {}),
      ...(local.commission?.required_claims ? { required_claims: local.commission.required_claims } : {})
    };
    const previousRun = [...(state.phase2_runs || [])].reverse().find(item => item.candidate_id === id && item.status === 'failed');
    const previousPacketRecord = previousRun
      ? [...(state.research_packets || [])].reverse().find(item => item.processing_run_id === previousRun.id && item.frozen_evidence_packet_sha256 === previousRun.frozen_evidence_packet_sha256)
      : null;
    const correctedPacketRecord = previousRun
      ? [...(state.research_packets || [])].reverse().find(item => item.candidate_id === id && item.packet?.supersedes_frozen_evidence_packet_sha256 === previousRun.frozen_evidence_packet_sha256)
      : null;
    const frozenPacketRecord = correctedPacketRecord || previousPacketRecord;
    const frozenPacket = frozenPacketRecord?.packet || null;
    if (['verification_failed', 'failed'].includes(local.status) && frozenPacket?.frozen_evidence_packet_sha256) {
      authorization.reuse_frozen_evidence_packet = true;
      authorization.frozen_evidence_packet = frozenPacket;
      authorization.frozen_evidence_packet_sha256 = frozenPacket.frozen_evidence_packet_sha256;
      authorization.case_run_id = crypto.randomUUID();
      authorization.readiness_inventory_sha256 = frozenPacketRecord.corrected_inventory_sha256 || previousRun.readiness_inventory_sha256 || null;
      authorization.runtime_inventory_sha256 = frozenPacketRecord.corrected_inventory_sha256 || previousRun.runtime_inventory_sha256 || null;
      authorization.terra_input_packet_sha256 = previousRun.terra_input_packet_sha256 || null;
      authorization.corrected_source_gate = frozenPacketRecord.source_gate || null;
      authorization.parent_frozen_evidence_packet_sha256 = frozenPacket.supersedes_frozen_evidence_packet_sha256 || null;
      authorization.classification_changes = frozenPacket.classification_changes || [];
    }
    if (!authorization.job_id) throw Object.assign(new Error('A controller job ID is required for this Phase 2 action.'), { code: 'PHASE2_ACTION_NOT_ALLOWED' });
    try {
      const orchestrator = new Phase2Orchestrator({ persistence: createSupabasePhase2Persistence({ client }), checkpoint: nextState => saveState(stateFile, nextState) });
      const result = await orchestrator.process({ state, candidateId: id, actor: 'pipeline_controller', commissionAuthorization: authorization, revisionInstructions: '' });
      await saveState(stateFile, state);
      if (['research_blocked','verification_failed'].includes(result.candidate.status)) {
        await requiredSupabase(client.from('candidate_stories').update({ status: result.candidate.status, updated_at: new Date().toISOString() }).eq('external_id', id).eq('status', 'researching'), 'Could not persist blocked reporting state');
      }
      return { candidate_id: id, status: result.candidate.status, pipeline_version: 'pipeline-v1', run_id: result.run?.id || null, review_id: result.review?.id || null, error: result.error || null, ...(result.research_again_required ? { research_again_required: true } : {}) };
    } catch (error) {
      if (!['research_blocked','verification_failed'].includes(local.status)) transition(local, 'research_blocked', 'pipeline_controller', `Processing failed: ${error.message}`);
      await saveState(stateFile, state);
      await requiredSupabase(client.from('candidate_stories').update({ status: 'research_blocked', updated_at: new Date().toISOString() }).eq('external_id', id).eq('status', 'researching'), 'Could not persist failed reporting state');
      throw error;
    }
  }
  if (command === 'polish') {
    requireId('polish');
    if (!canRunPipelineV1({ pipeline_version: flagValue('--pipeline-version') }, process.env, flagValue('--job-id'))) throw Object.assign(new Error('Pipeline V1 is disabled, the job is not versioned v1, or the job is not the scoped allowed job.'), { code: 'PIPELINE_V1_DISABLED' });
    const local = state.candidates.find(candidate => candidate.id === id);
    const review = [...(state.reviews || [])].reverse().find(item => item.candidate_id === id && item.pipeline_version === 'pipeline-v1');
    const draft = review?.draft;
    if (!local || !review || !draft?.body_markdown) throw Object.assign(new Error('A retained Luna Draft is required before Sol polish.'), { code: 'SOL_POLISH_DRAFT_MISSING' });
    const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) throw Object.assign(new Error('Sol polish requires Supabase service credentials.'), { code: 'PIPELINE_STATE_NOT_CONFIGURED' });
    const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const polished = await runSolPolish({ draft, packet: review.evidence_packet, findings: review.deterministic_review?.advisory_findings || [], form: STORY_FORM_BY_ID[local.commission?.story_form || local.classification?.story_form] });
    const persisted = await requiredSupabase(client.rpc('persist_pipeline_sol_polish', { p_candidate_external_id: id, p_pipeline_run_id: review.processing_run_id, p_pipeline_version: 'v1', p_authorization_id: flagValue('--job-id'), p_original_headline: draft.headline, p_original_dek: draft.dek, p_original_body_markdown: draft.body_markdown, p_polished_headline: polished.headline, p_polished_dek: polished.dek, p_polished_body_markdown: polished.body_markdown, p_changes: polished.changes, p_warnings: polished.warnings, p_packet_checksum: review.frozen_evidence_packet_sha256, p_draft_checksum: polished.original_draft_sha256, p_polish_checksum: polished.polished_draft_sha256, p_model: polished.model, p_reasoning: polished.reasoning, p_usage: polished.usage, p_cost: polished.usage?.estimated_cost_usd ?? null, p_actor: null }), 'Could not persist Sol polish');
    return { candidate_id: id, status: 'polish_ready', pipeline_version: 'v1', artifact: persisted };
  }
  throw new Error('Usage: anyways-ops.mjs <discover|status|create_editorial_pitch|batch|process|polish> [id]');
}

try {
  const result = await main();
  final({ ok: true, command, ...((id && command === 'process') || command === 'create_editorial_pitch' ? { candidate_id: result?.candidate_id || id } : {}), result });
} catch (error) {
  if (command === 'batch' && activeEditorialBatch) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await activeEditorialBatch.client.from('pipeline_batch_runs').update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        summary: { error: { code: error?.code || 'PIPELINE_COMMAND_FAILED', message } }
      }).eq('id', activeEditorialBatch.id).in('status', ['queued', 'discovering', 'screening', 'processing']);
    } catch {}
  }
  final({ ok: false, command: command || null, ...(id && command === 'process' ? { candidate_id: id } : {}), error: errorDetails(error) });
  process.exitCode = 1;
}
