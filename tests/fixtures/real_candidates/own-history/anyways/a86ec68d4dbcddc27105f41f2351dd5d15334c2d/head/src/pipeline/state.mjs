import fs from 'node:fs/promises';
import path from 'node:path';
export const CANDIDATE_STATUSES = new Set(['discovered','watching','rejected','researching','research_blocked','ready_to_draft','drafting','verification_failed','editing','ready_for_review','revision_requested','approved','rejected_by_editor','archived']);
export function normalizePipelineOwnership(state) {
  for (const key of ['sources','candidates','clusters','documents','research_packets','reviews','review_actions','runs','fetched_content_cache']) state[key] ||= [];
  const candidates = new Set(state.candidates.map(item => item.id));
  for (const document of state.documents) {
    if (!document.candidate_id && candidates.has(document.discovery_id)) document.candidate_id = document.discovery_id;
    if (!document.processing_run_id && document.candidate_id) document.processing_run_id = [...state.runs].reverse().find(run => run.candidate_id === document.candidate_id)?.id || null;
  }
  for (const review of state.reviews) if (!review.processing_run_id) review.processing_run_id = state.runs.find(run => run.review_id === review.id)?.id || null;
  return state;
}
export async function loadState(file) { try { return normalizePipelineOwnership(JSON.parse(await fs.readFile(file, 'utf8'))); } catch (error) { if (error.code === 'ENOENT') return normalizePipelineOwnership({}); throw error; } }
export async function saveState(file, state) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(state, null, 2)); }
export function transition(candidate, next, actor, note = '') { if (!CANDIDATE_STATUSES.has(next)) throw new Error(`Invalid candidate status: ${next}`); if (candidate.status === 'approved' && next !== 'archived') throw new Error('Approved candidates may only be archived; approval never publishes.'); candidate.status = next; candidate.history ||= []; candidate.history.push({ at: new Date().toISOString(), actor, status: next, note }); return candidate; }
