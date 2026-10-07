import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchDocument, normalizeUrl } from './acquisition.mjs';
import { transition } from './state.mjs';
import { EditorialPipeline } from './workflow.mjs';
import { SourceFirstSynthesis } from './synthesis.mjs';
import { sourceRetention, validateReviewPackage } from './integrity.mjs';

export const RESEARCH_LIMITS = Object.freeze({ rounds: 2, queriesPerRound: 3, documents: 8, sourceChars: 5_000, failedFetches: 3, runtimeMs: 480_000 });
const now = () => new Date().toISOString();
function imagesFromHtml(html, sourcePage, ownership) { const property = name => (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)`, 'i')) || [,''])[1]; const url = property('og:image') || property('twitter:image'); return url ? [{ id: crypto.randomUUID(), ...ownership, original_url: new URL(url, sourcePage).href, source_page: sourcePage, creator: null, caption: property('og:image:alt') || null, license: null, rights_status: 'unknown', width: null, height: null, file_type: null, proposed_role: 'hero', warning_flags: ['rights_not_verified'] }] : []; }
export class CandidateOrchestrator {
  constructor({ pipeline = new EditorialPipeline(), fetcher = fetchDocument, limits = RESEARCH_LIMITS, artifactDir = 'pipeline-artifacts', synthesis } = {}) { this.pipeline = pipeline; this.fetcher = fetcher; this.limits = limits; this.artifactDir = artifactDir; this.synthesis = synthesis || new SourceFirstSynthesis({ adapter: pipeline.adapter, artifactDir }); }
  async process({ state, candidateId, actor = 'operator', resume = true }) {
    for (const key of ['documents','research_packets','reviews','review_actions','runs','fetched_content_cache']) state[key] ||= [];
    const candidate = state.candidates.find(item => item.id === candidateId); if (!candidate) throw new Error('Candidate not found');
    if (candidate.status === 'ready_for_review' && resume) return { candidate, resumed: true };
    const run = { id: crypto.randomUUID(), candidate_id: candidateId, type: 'process', started_at: now(), status: 'running', events: [] }; state.runs.push(run);
    transition(candidate, 'researching', actor, 'source retrieval started');
    const cluster = { candidates: [candidate] };
    const documents = [];
    for (const source of cluster.candidates.slice(0, this.limits.documents)) {
      try { const fetched = await this.fetcher(source.url); run.events.push({ type: 'fetch', url: source.url, ok: fetched.ok, at: now(), error: fetched.error || null }); if (!fetched.ok || !fetched.text?.trim()) continue; const doc = { id: `source:${candidateId}:${run.id}:${documents.length + 1}`, candidate_id: candidateId, processing_run_id: run.id, discovery_id: source.id, url: fetched.canonical_url || source.url, canonical_url: fetched.canonical_url || source.url, title: source.title, content: fetched.text.slice(0, this.limits.sourceChars), source_type: 'candidate_primary', retrieval_timestamp: fetched.fetched_at || now(), provenance: { discovery_id: source.id, fetched_url: source.url }, extraction: fetched }; doc.retention = sourceRetention(candidate, doc); if (doc.retention.score <= 0) { run.events.push({ type: 'source_rejected', url: doc.url, reason: doc.retention.reason, at: now() }); continue; } documents.push(doc); state.fetched_content_cache.push({ canonical_url: doc.canonical_url, content_hash: crypto.createHash('sha256').update(doc.content).digest('hex'), fetched_at: doc.retrieval_timestamp }); } catch (error) { run.events.push({ type: 'fetch', url: source.url, ok: false, error: error.message, at: now() }); }
    }
    if (!documents.length) { transition(candidate, 'research_blocked', actor, 'No usable source extraction'); run.status = 'blocked'; run.finished_at = now(); return { candidate, run }; }
    const packet = { id: crypto.randomUUID(), candidate_id: candidateId, processing_run_id: run.id, iteration: 1, sources: documents.map(({ id,url,title,retention }) => ({ id,url,title,retention })), created_at: now(), stop_reason: 'research expansion adapter is not configured' };
    state.documents.push(...documents); state.research_packets.push(packet); transition(candidate, 'ready_to_draft', actor, 'Research packet persisted'); transition(candidate, 'drafting', actor, 'Qwen drafting started');
    const runId = `candidate-${candidateId}-${run.id}`;
    const brief = `${candidate.title}\n${candidate.description || ''}`;
    let cachedPlan;
    for (const priorRun of [...state.runs].reverse()) {
      if (priorRun.id === run.id || priorRun.candidate_id !== candidateId || !priorRun.pipeline_run_id) continue;
      try { const attempt = JSON.parse(await fs.readFile(path.join(this.artifactDir, priorRun.pipeline_run_id, 'research_plan.attempt-1.json'), 'utf8')); if (!attempt.validation_errors?.length) { cachedPlan = JSON.parse(attempt.raw_response); run.events.push({ type: 'research_plan_reused', from_run: priorRun.id, at: now() }); break; } } catch {}
    }
    const planning = cachedPlan ? { run_id: runId, model: this.pipeline.adapter?.model || 'qwen3:14b', status: 'complete', stages: { research_plan: { status: 'passed', output: cachedPlan, attempts: [] } } } : await this.pipeline.run({ runId, brief, candidates: cluster.candidates, sources: documents, stages: ['classification', 'research_plan'] });
    if (planning.status !== 'complete') { run.pipeline_run_id = planning.run_id; run.finished_at = now(); run.status = planning.status; transition(candidate, 'research_blocked', actor, 'Pipeline blocked at research_plan'); return { candidate, run, result: planning }; }
    if (planning.stages.classification?.output) candidate.classification = planning.stages.classification.output;
    const synthesis = await this.synthesis.run({ runId, brief, sources: documents, researchPlan: planning.stages.research_plan.output });
    if (synthesis.status !== 'passed') { run.pipeline_run_id = runId; run.finished_at = now(); run.status = 'blocked'; transition(candidate, 'research_blocked', actor, `Pipeline blocked at ${synthesis.blocked_at}`); return { candidate, run, result: synthesis }; }
    // Drafts, verification, and proofreading contain run-scoped source IDs. Never
    // reuse them across a replacement run, even when the fetched URL is unchanged.
    const initialStages = { research_plan: planning.stages.research_plan, synthesis: { status: 'passed', output: synthesis.output, attempts: [] } };
    const downstream = ['draft','verification','proofreading','slop'].filter(stage => !initialStages[stage]);
    const result = await this.pipeline.run({ runId, brief, candidates: cluster.candidates, sources: documents, stages: downstream, initialStages });
    run.pipeline_run_id = result.run_id; run.finished_at = now(); run.status = result.status;
    if (result.status !== 'complete') { transition(candidate, result.blocked_at === 'verification' ? 'verification_failed' : 'research_blocked', actor, `Pipeline blocked at ${result.blocked_at}`); return { candidate, run, result }; }
    transition(candidate, 'editing', actor, 'Draft and verification completed');
    const claims = result.stages.verification.output.claims.map(claim => ({ ...claim, candidate_id: candidateId, processing_run_id: run.id }));
    const images = documents.flatMap(doc => imagesFromHtml(doc.extraction.raw || '', doc.url, { candidate_id: candidateId, processing_run_id: run.id, source_document_id: doc.id }));
    const review = { id: crypto.randomUUID(), candidate_id: candidateId, processing_run_id: run.id, document_ids: documents.map(doc => doc.id), status: 'ready_for_review', created_at: now(), model: result.model, prompt_version: 'editorial-doctrine-v1', headline: result.stages.draft.output.headline, dek: result.stages.draft.output.dek, article: result.stages.slop.output.revised_body, previous_draft: result.stages.draft.output.body_markdown, classification: candidate.classification || null, research: result.stages.research_plan.output, synthesis: result.stages.synthesis.output, claims, unresolved_claims: claims.filter(claim => claim.status !== 'supported'), images, logs: result.stages, validation_history: Object.fromEntries(Object.entries(result.stages).map(([stage, value]) => [stage, value.attempts])) };
    const integrity = validateReviewPackage({ candidate, run, documents, review });
    if (!integrity.ok) { run.status = 'failed_closed'; run.error = integrity; transition(candidate, 'verification_failed', actor, integrity.code); return { candidate, run, result, integrity }; }
    state.reviews.push(review); transition(candidate, 'ready_for_review', actor, 'Complete review package created'); run.review_id = review.id; return { candidate, run, review, result };
  }
  requestRevision({ state, candidateId, actor, instructions }) { if (!instructions?.trim()) throw new Error('Revision instructions are required'); const candidate = state.candidates.find(item => item.id === candidateId); if (!candidate) throw new Error('Candidate not found'); transition(candidate, 'revision_requested', actor, instructions); state.review_actions.push({ id: crypto.randomUUID(), candidate_id: candidateId, actor, action: 'request_revision', previous_state: 'ready_for_review', new_state: 'revision_requested', notes: instructions, at: now() }); return candidate; }
  reviewAction({ state, candidateId, actor, action, notes = '' }) { const allowed = new Map([['approve','approved'],['reject','rejected_by_editor'],['archive','archived']]); if (!allowed.has(action)) throw new Error('Unsupported review action'); const candidate = state.candidates.find(item => item.id === candidateId); if (!candidate) throw new Error('Candidate not found'); const previous = candidate.status; transition(candidate, allowed.get(action), actor, notes); state.review_actions.push({ id: crypto.randomUUID(), candidate_id: candidateId, actor, action, previous_state: previous, new_state: candidate.status, notes, at: now() }); return candidate; }
}
