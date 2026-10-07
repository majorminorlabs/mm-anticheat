import { readJsonFile, writeJsonFile } from './atomic-json.mjs';
export const CANDIDATE_STATUSES = new Set(['discovered','watching','rejected','pitch_ready','commissioned','researching','research_blocked','ready_to_draft','evidence_ready','drafting','draft_ready','revising','verification_failed','editing','ai_review_ready','ready_for_review','revision_requested','approved','rejected_by_editor','archived','failed']);
export function normalizePipelineOwnership(state) {
  for (const key of ['sources','candidates','clusters','documents','research_packets','reviews','review_actions','runs','fetched_content_cache','phase2_runs','phase2_attempts','phase2_artifacts','phase2_reviews','phase2_persistence']) state[key] ||= [];
  const candidates = new Set(state.candidates.map(item => item.id));
  for (const document of state.documents) {
    if (!document.candidate_id && candidates.has(document.discovery_id)) document.candidate_id = document.discovery_id;
    if (!document.processing_run_id && document.candidate_id) document.processing_run_id = [...state.runs].reverse().find(run => run.candidate_id === document.candidate_id)?.id || null;
  }
  for (const review of state.reviews) if (!review.processing_run_id) review.processing_run_id = state.runs.find(run => run.review_id === review.id)?.id || null;
  return state;
}
export async function loadState(file) { return normalizePipelineOwnership(await readJsonFile(file, { defaultValue: {}, label: 'pipeline state' })); }
export async function saveState(file, state) { await writeJsonFile(file, state); }
export function transition(candidate, next, actor, note = '') { if (!CANDIDATE_STATUSES.has(next)) throw new Error(`Invalid candidate status: ${next}`); if (candidate.status === 'approved' && next !== 'archived') throw new Error('Approved candidates may only be archived; approval never publishes.'); candidate.status = next; candidate.history ||= []; candidate.history.push({ at: new Date().toISOString(), actor, status: next, note }); return candidate; }
