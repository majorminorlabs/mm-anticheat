#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { normalizePipelineOwnership } from '../src/pipeline/state.mjs';
import { REVIEW_PACKAGE_INTEGRITY_FAILED, documentsForCandidateRun, validateReviewPackage } from '../src/pipeline/integrity.mjs';
import { generatedCreditLine, validateImageRights } from '../src/image-rights-policy.mjs';

const candidateId = process.argv[2];
const stateFile = process.env.ANYWAYS_PIPELINE_STATE_FILE || path.join(process.env.ANYWAYS_PIPELINE_STATE_DIR || 'pipeline-state', 'state.json');
if (!candidateId) throw new Error('Usage: node bin/pipeline-sync-supabase.mjs <candidate-id>');
const state = normalizePipelineOwnership(JSON.parse(await fs.readFile(stateFile, 'utf8')));
const candidate = state.candidates.find(item => item.id === candidateId);
const review = [...state.reviews].reverse().find(item => item.candidate_id === candidateId);
if (!candidate || !review || candidate.status !== 'ready_for_review') throw new Error('A retained ready_for_review candidate and complete review package are required.');
const quote = value => `'${String(value ?? '').replaceAll("'", "''")}'`;
const json = value => `${quote(JSON.stringify(value ?? {}))}::jsonb`;
const textArray = values => `array[${(values || []).map(quote).join(',')}]::text[]`;
const boundedRawHtml = document => String(document.extraction?.raw || '').slice(0, 10_000);
const discoveryMetadata = document => ({
  discovery_id: document.discovery_id || null,
  provenance: document.provenance || {},
  retrieval_timestamp: document.retrieval_timestamp || null,
  raw_html_truncated: String(document.extraction?.raw || '').length > 10_000
});
const uuid = seed => { const hex = crypto.createHash('sha256').update(seed).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const cid = uuid(`candidate:${candidate.id}`);
// Discovery projection may have created the candidate with the database default UUID.
// Always resolve the durable candidate row by its external id before attaching
// documents, runs, drafts, and review decisions.
const candidateRef = `(select id from public.candidate_stories where external_id = ${quote(candidate.id)})`;
const run = [...state.runs].reverse().find(item => item.review_id === review.id && item.candidate_id === candidate.id) || {};
const docs = documentsForCandidateRun(state, candidate.id, run.id);
for (const doc of docs) doc.retention ||= { score: 100, reason: 'legacy_candidate_document' };
review.processing_run_id ||= run.id;
review.document_ids ||= docs.map(doc => doc.id);
review.claims = (review.claims || []).map(claim => ({ ...claim, candidate_id: candidate.id, processing_run_id: run.id }));
review.images = (review.images || []).map(image => ({ ...image, candidate_id: candidate.id, processing_run_id: run.id, source_document_id: docs.find(doc => doc.url === image.source_page || doc.canonical_url === image.source_page)?.id || null }));
const integrity = validateReviewPackage({ candidate, run, documents: docs, review });
if (!integrity.ok) throw Object.assign(new Error(integrity.errors.join('; ')), { code: REVIEW_PACKAGE_INTEGRITY_FAILED, details: integrity });
const docBySource = new Map(docs.map(doc => [doc.id, uuid(`document:${candidate.id}:${run.id}:${doc.id}`)]));
const prior = uuid(`draft:${candidate.id}:${run.id}:1`), current = uuid(`draft:${candidate.id}:${run.id}:2`), runId = run.id;
const statements = [];
// Keep the candidate out of AI Review until every required artifact has
// synchronized. If a later batch fails, a retry can resume idempotently
// without leaving a visible card that has no draft body.
statements.push(`insert into public.candidate_stories(id,external_id,cluster_key,title,canonical_url,status,classification,model,prompt_version,created_at,updated_at) values (${quote(cid)}::uuid,${quote(candidate.id)},${quote(candidate.id)},${quote(review.headline || candidate.title)},${quote(candidate.url)},'drafting',${json(review.classification || candidate.classification)},${quote(review.model || 'qwen3:14b')},${quote(review.prompt_version || 'editorial-doctrine-v1')},${quote(candidate.history?.[0]?.at || new Date().toISOString())},now()) on conflict (external_id) where external_id is not null do update set title=excluded.title,canonical_url=excluded.canonical_url,status='drafting',classification=excluded.classification,model=excluded.model,prompt_version=excluded.prompt_version,updated_at=now();`);
statements.push(`insert into public.pipeline_runs(id,candidate_id,model,status,started_at,finished_at,artifact_path,error,fingerprint,reused) values (${quote(runId)}::uuid,${candidateRef},${quote(review.model || 'qwen3:14b')},'running',${quote(run.started_at || review.created_at)},null,${quote(run.pipeline_run_id || '')},null,${quote(`${run.pipeline_run_id || review.id}:owned-v1`)},true) on conflict (id) do update set status='running',finished_at=null,artifact_path=excluded.artifact_path,reused=true;`);
statements.push(`insert into public.research_packets(candidate_id,pipeline_run_id,iteration,packet,sufficiency) values (${candidateRef},${quote(runId)}::uuid,1,${json(review.research)},${json({ status: review.synthesis?.research_sufficiency || 'sufficient' })}) on conflict (candidate_id,pipeline_run_id,iteration) do update set packet=excluded.packet,sufficiency=excluded.sufficiency;`);
for (const [stage, detail] of Object.entries(review.logs || {})) for (const attempt of detail.attempts || []) statements.push(`insert into public.pipeline_stage_attempts(pipeline_run_id,stage,attempt,raw_response,validation_errors,metrics) values (${quote(runId)}::uuid,${quote(stage)},${Number(attempt.attempt || 1)},${quote(attempt.raw_response || '')},${json(attempt.validation_errors || [])},${json(attempt.metrics || {})}) on conflict (pipeline_run_id,stage,attempt) do update set raw_response=excluded.raw_response,validation_errors=excluded.validation_errors,metrics=excluded.metrics;`);
statements.push(`insert into public.pipeline_drafts(id,candidate_id,pipeline_run_id,version,headline,dek,body_markdown,prior_draft_id,created_at) values (${quote(prior)}::uuid,${candidateRef},${quote(runId)}::uuid,1,${quote(review.headline)},${quote(review.dek)},${quote(review.previous_draft)},null,now()) on conflict (candidate_id,pipeline_run_id,version) do update set body_markdown=excluded.body_markdown;`);
statements.push(`insert into public.pipeline_drafts(id,candidate_id,pipeline_run_id,version,headline,dek,body_markdown,prior_draft_id,created_at) values (${quote(current)}::uuid,${candidateRef},${quote(runId)}::uuid,2,${quote(review.headline)},${quote(review.dek)},${quote(review.article)},${quote(prior)}::uuid,now()) on conflict (candidate_id,pipeline_run_id,version) do update set headline=excluded.headline,dek=excluded.dek,body_markdown=excluded.body_markdown,prior_draft_id=excluded.prior_draft_id;`);
for (const doc of docs) statements.push(`insert into public.discovered_documents(id,candidate_id,pipeline_run_id,url,normalized_url,canonical_url,title,raw_discovery,retention,fetched_at,extraction_method,extraction_status,raw_html,extracted_text,paywalled) values (${quote(docBySource.get(doc.id))}::uuid,${candidateRef},${quote(runId)}::uuid,${quote(doc.url)},${quote(doc.url)},${quote(doc.canonical_url || doc.url)},${quote(doc.title)},${json(discoveryMetadata(doc))},${json(doc.retention)},${quote(doc.extraction?.fetched_at || doc.retrieval_timestamp || new Date().toISOString())},${quote(doc.extraction?.method || 'readable_text')},${quote(doc.extraction?.status || 'ok')},${quote(boundedRawHtml(doc))},${quote(doc.content)},false) on conflict (candidate_id,pipeline_run_id,normalized_url) do update set title=excluded.title,raw_discovery=excluded.raw_discovery,retention=excluded.retention,raw_html=excluded.raw_html,extracted_text=excluded.extracted_text,extraction_status=excluded.extraction_status;`);
for (const [index, claim] of (review.claims || []).entries()) { const claimId = uuid(`claim:${candidate.id}:${runId}:${index}`); statements.push(`insert into public.pipeline_claims(id,draft_id,candidate_id,pipeline_run_id,claim,status,note) values (${quote(claimId)}::uuid,${quote(current)}::uuid,${candidateRef},${quote(runId)}::uuid,${quote(claim.claim)},${quote(claim.status)},${quote(claim.note || '')}) on conflict (id) do update set claim=excluded.claim,status=excluded.status,note=excluded.note;`); for (const sourceId of claim.source_ids || []) { const documentId = docBySource.get(sourceId); if (documentId) statements.push(`insert into public.pipeline_claim_sources(claim_id,document_id) values (${quote(claimId)}::uuid,${quote(documentId)}::uuid) on conflict do nothing;`); } }
for (const image of review.images || []) {
  const decision = validateImageRights(image, { now: review.created_at || new Date().toISOString() });
  const imageId = uuid(`image:${candidate.id}:${runId}:${image.original_file_url || image.original_url}`);
  statements.push(`insert into public.image_candidates(id,candidate_id,pipeline_run_id,source_document_id,original_url,source_page,creator,caption,license,provider,source_page_url,original_file_url,license_code,license_url,credit_line,commercial_use_allowed,modification_allowed,verification_method,verification_timestamp,source_metadata,rights_status,rights_audit,width,height,file_type,proposed_role,warning_flags,selected,created_at) values (${quote(imageId)}::uuid,${candidateRef},${quote(runId)}::uuid,${image.source_document_id ? `${quote(docBySource.get(image.source_document_id))}::uuid` : 'null'},${quote(image.original_file_url || image.original_url)},${quote(image.source_page_url || image.source_page || '')},${quote(image.creator || '')},${quote(image.caption || '')},${quote(image.license_code || image.license || '')},${quote(image.provider || '')},${quote(image.source_page_url || image.source_page || '')},${quote(image.original_file_url || image.original_url)},${quote(image.license_code || image.license || '')},${quote(image.license_url || '')},${quote(generatedCreditLine(image))},${image.commercial_use_allowed === true},${image.modification_allowed === true},${quote(image.verification_method || '')},${image.verification_timestamp ? quote(image.verification_timestamp) : 'null'},${json(image.source_metadata || {})},${quote(decision.status)},${json(decision.audit)},${image.width || 'null'},${image.height || 'null'},${quote(image.file_type || '')},${quote(image.proposed_role || '')},${textArray([...new Set([...(image.warning_flags || []), decision.audit.rule])])},false,${quote(review.created_at)}) on conflict (id) do update set caption=excluded.caption,provider=excluded.provider,source_page_url=excluded.source_page_url,original_file_url=excluded.original_file_url,creator=excluded.creator,license_code=excluded.license_code,license_url=excluded.license_url,credit_line=excluded.credit_line,commercial_use_allowed=excluded.commercial_use_allowed,modification_allowed=excluded.modification_allowed,verification_method=excluded.verification_method,verification_timestamp=excluded.verification_timestamp,source_metadata=excluded.source_metadata,rights_status=excluded.rights_status,rights_audit=excluded.rights_audit,warning_flags=excluded.warning_flags;`);
}
for (const action of state.review_actions.filter(item => item.candidate_id === candidate.id && item.action !== 'approve')) statements.push(`insert into public.pipeline_review_decisions(id,candidate_id,actor_id,action,note,created_at,previous_state,new_state,metadata) values (${quote(uuid(`action:${candidate.id}:${action.id}`))}::uuid,${candidateRef},null,${quote(action.action)},${quote(action.notes || '')},${quote(action.at || new Date().toISOString())},${quote(action.previous_state || 'ready_for_review')}::public.pipeline_candidate_status,${quote(action.new_state || 'ready_for_review')}::public.pipeline_candidate_status,${json({ actor: action.actor || 'operator' })}) on conflict (id) do nothing;`);
statements.push(`update public.pipeline_runs set status='complete',finished_at=${quote(run.finished_at || review.created_at)},error=null where id=${quote(runId)}::uuid; update public.candidate_stories set status='ready_for_review',updated_at=now() where external_id=${quote(candidate.id)};`);
const batches = []; let batch = [] ; let size = 0;
for (const statement of statements) { if (batch.length && size + statement.length > 75_000) { batches.push(batch); batch = []; size = 0; } batch.push(statement); size += statement.length; }
if (batch.length) batches.push(batch);
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-supabase-sync-'));
try {
  for (const [index, statementsInBatch] of batches.entries()) { const sqlFile = path.join(tempDir, `sync-${index}.sql`); await fs.writeFile(sqlFile, `begin;\n${statementsInBatch.join('\n')}\ncommit;`); const result = spawnSync('supabase', ['db', 'query', '--linked', '--file', sqlFile], { encoding: 'utf8', maxBuffer: 20_000_000 }); if (result.status !== 0) throw new Error(`Supabase synchronization batch ${index + 1}/${batches.length} failed (exit ${result.status}): ${(result.stderr || '')}\n${(result.stdout || '')}\n${result.error?.message || ''}`); }
} finally { await fs.rm(tempDir, { recursive: true, force: true }); }
console.log(JSON.stringify({ external_candidate_id: candidate.id, documents: docs.length, claims: review.claims?.length || 0, images: review.images?.length || 0, run_id: runId, result: 'synchronized_idempotently' }, null, 2));
