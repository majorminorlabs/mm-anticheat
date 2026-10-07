#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { normalizePipelineOwnership } from '../src/pipeline/state.mjs';
import { phase2PersistencePayload, createSupabasePhase2Persistence } from '../src/pipeline/phase2-persistence.mjs';
import { materializeOfflineReview } from '../src/pipeline/offline-review-materialization.mjs';
import { ensurePhase2State } from '../src/pipeline/phase2-state.mjs';

const candidateId = process.argv[2];
const stateFile = process.env.ANYWAYS_PIPELINE_STATE_FILE || path.join(process.env.ANYWAYS_PIPELINE_STATE_DIR || 'pipeline-state', 'state.json');
if (!candidateId) throw new Error('Usage: node bin/complete-offline-ai-review.mjs <candidate-external-id>');
const state = normalizePipelineOwnership(JSON.parse(await fs.readFile(stateFile, 'utf8')));
ensurePhase2State(state);
const candidate = state.candidates.find(item => item.id === candidateId);
const run = [...state.runs].reverse().find(item => item.candidate_id === candidateId && item.commission_job_id === 'fb25e44d-51f7-4105-bfaa-665b2862b649');
if (!candidate || !run) throw new Error('The existing failed Draft run was not found.');
const packetRecord = [...(state.research_packets || [])].reverse().find(item => item.processing_run_id === run.id && item.packet?.frozen_evidence_packet_sha256 === '85c43bcc0fdc7b90820ac47ffb0063b0601917122be39607dad5e90b5762adaa');
const draftArtifact = state.phase2_persistence.find(item => item.case_run_id === run.id && item.stage === 'draft');
const draftReviewArtifact = state.phase2_persistence.find(item => item.case_run_id === run.id && item.stage === 'draft_review');
if (!packetRecord?.packet || !draftArtifact?.payload?.draft) throw new Error('Existing frozen packet or Draft artifact is missing.');
const packet = packetRecord.packet;
const oldDocuments = state.documents.filter(document => document.candidate_id === candidateId && document.processing_run_id !== run.id && packet.sources.some(source => source.source_id === document.id));
const previousFailure = { code: run.error?.code || 'REVIEW_PACKAGE_INTEGRITY_FAILED', message: run.error?.message || 'Prior package materialization failed.' };
const materialized = materializeOfflineReview({ candidate, run, packet, draft: draftArtifact.payload.draft, retainedDocuments: oldDocuments, existingDraftReview: draftReviewArtifact?.payload?.review?.deterministic_review || null, previousFailure });

// Replace only the failed run's local review projection. The frozen packet,
// Draft, claims, constraints, and usage are copied unchanged.
state.documents = state.documents.filter(document => !(document.candidate_id === candidateId && document.processing_run_id === run.id));
state.documents.push(...materialized.documents);
state.reviews ||= [];
state.reviews = state.reviews.filter(review => !(review.candidate_id === candidateId && review.processing_run_id === run.id));
state.reviews.push(materialized.review);
state.phase2_reviews = state.phase2_reviews.filter(review => !(review.candidate_id === candidateId && review.processing_run_id === run.id));
state.phase2_reviews.push(materialized.review);
run.previous_terminal_error = previousFailure;
run.error = null;
run.status = 'complete';
run.state = 'ai_review_ready';
run.finished_at = new Date().toISOString();
run.review_id = materialized.review.id;
run.events.push({ type: 'offline_ai_review_materialized', materialization_revision: materialized.materialization, preserved_failure: previousFailure, at: run.finished_at });
candidate.status = 'ready_for_review';
candidate.phase2_state = 'ai_review_ready';
candidate.phase2_review_id = materialized.review.id;
candidate.phase2_frozen_evidence_packet_sha256 = packet.frozen_evidence_packet_sha256;
candidate.classification = { ...(candidate.classification || {}), phase2_state: 'ai_review_ready', pipeline_version: 'pipeline-v1', frozen_evidence_packet_sha256: packet.frozen_evidence_packet_sha256 };
candidate.history ||= [];
candidate.history.push({ at: run.finished_at, actor: 'offline_package_materializer', status: 'ready_for_review', note: 'AI Review materialized from the existing validated Draft after frozen URL binding repair.' });

const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('Supabase service credentials are required for durable offline package completion.');
const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const persistence = createSupabasePhase2Persistence({ client });
const payload = phase2PersistencePayload({ run, stage: 'ai_review', packet, draft: materialized.review.draft, review: materialized.review, claims: materialized.review.claims, blockers: materialized.review.deterministic_review.blocking_factual_errors, usage: run.model_usage, cost: run.estimated_cost_usd, materialization: materialized.materialization });
const phase2Record = { holdout_run_id: run.holdout_run_id || null, case_run_id: run.id, candidate_id: candidateId, pipeline_version: 'pipeline-v1', terra_evidence_contract_version: materialized.review.terra_evidence_contract_version, phase2_inventory_contract_version: materialized.review.phase2_inventory_contract_version, stage: 'ai_review', readiness_inventory_sha256: run.readiness_inventory_sha256, runtime_inventory_sha256: run.runtime_inventory_sha256, terra_input_packet_sha256: run.terra_input_packet_sha256, frozen_evidence_packet_sha256: packet.frozen_evidence_packet_sha256, draft_input_sha256: run.draft_input_sha256, revision_input_sha256: null, payload, claims: materialized.review.claims, usage: run.model_usage, cost: { credits: run.model_usage.reduce((sum, item) => sum + (Number.isFinite(item.credits) ? item.credits : 0), 0), estimated_cost_usd: null } };
await persistence.persistStage(phase2Record);

const { data: job, error: jobError } = await client.from('pipeline_jobs').select('id,result').eq('id', run.commission_job_id).maybeSingle();
if (jobError) throw jobError;
if (!job) throw new Error(`Commission job ${run.commission_job_id} was not found.`);
const jobResult = { ...(job?.result || {}), offline_ai_review_materialized: materialized.materialization, review_id: materialized.review.id, frozen_evidence_packet_sha256: packet.frozen_evidence_packet_sha256, draft_input_sha256: run.draft_input_sha256, source_links: materialized.source_links.length };
const { error: updateJobError } = await client.from('pipeline_jobs').update({ result: jobResult }).eq('id', run.commission_job_id);
if (updateJobError) throw updateJobError;

state.phase2_persistence = state.phase2_persistence.filter(item => !(item.case_run_id === run.id && item.stage === 'ai_review'));
state.phase2_persistence.push({ ...phase2Record, persisted_at: new Date().toISOString() });
await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
const sync = spawnSync(process.execPath, ['bin/pipeline-sync-supabase.mjs', candidateId], { encoding: 'utf8', maxBuffer: 20_000_000, env: process.env });
if (sync.status !== 0) throw new Error(`Offline AI Review legacy projection sync failed: ${(sync.stderr || '').trim()} ${(sync.stdout || '').trim()}`.trim());

console.log(JSON.stringify({ ok: true, candidate_id: candidateId, job_id: run.commission_job_id, run_id: run.id, review_id: materialized.review.id, review_status: materialized.review.status, deterministic_review: materialized.review.deterministic_review, source_links: materialized.source_links.length, provider_calls_added: 0, packet_checksum: packet.frozen_evidence_packet_sha256, draft_input_sha256: run.draft_input_sha256, materialization: materialized.materialization, legacy_projection_sync: JSON.parse(sync.stdout || '{}') }, null, 2));
