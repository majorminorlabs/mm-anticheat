import { SECTION_ORDER, STORY_FORMS } from './editorial.mjs';
import { validateArticleCommission } from './article-commission.mjs';

export const NEWSROOM_SUBMITTABLE_JOB_TYPES = Object.freeze(['discover', 'create_editorial_pitch', 'process_candidate', 'polish_candidate', 'run_editorial_batch']);
export const ACTIVE_PIPELINE_JOB_STATUSES = Object.freeze(['queued', 'claimed', 'running']);
export const PIPELINE_JOB_STATUSES = Object.freeze(['queued', 'claimed', 'running', 'completed', 'failed', 'cancelled']);

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const candidateId = value => uuid(value) || (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value));

export function validateNewsroomJobRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A valid job request is required.');
  const type = value.job_type;
  const priority = Number(value.priority ?? 50);
  if (!NEWSROOM_SUBMITTABLE_JOB_TYPES.includes(type)) throw new Error('That pipeline action is not available from the Newsroom.');
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new Error('Priority must be a whole number from 0 to 100.');
  if (type === 'discover') return { job_type: type, parameters: {}, priority };
  if (type === 'create_editorial_pitch') {
    return { job_type: type, parameters: validateArticleCommission(value), priority };
  }
  if (type === 'run_editorial_batch') {
    const section_id = String(value.section_id || '').trim();
    const story_form = String(value.story_form || '').trim();
    const target_count = Number(value.target_count ?? (section_id || story_form ? 5 : 10));
    if (section_id && !SECTION_ORDER.includes(section_id)) throw new Error('Choose a valid primary section.');
    if (story_form && !STORY_FORMS.some(form => form.id === story_form)) throw new Error('Choose a valid article form.');
    if (!Number.isInteger(target_count) || target_count < 1 || target_count > 10) throw new Error('Choose between 1 and 10 ideas.');
    return { job_type: type, parameters: { section_id: section_id || null, story_form: story_form || null, target_count }, priority };
  }
  if (!candidateId(value.candidate_id)) throw new Error('Select a valid retained candidate before processing.');
  if (type === 'polish_candidate') {
    if (value.pipeline_version !== 'v1' || value.authorization !== 'polish_with_sol') throw new Error('Sol polish requires an explicit V1 polish authorization.');
    return { job_type: type, parameters: { candidate_id: value.candidate_id, pipeline_version: 'v1', authorization: 'polish_with_sol' }, priority };
  }
  const authorization = value.authorization === undefined ? null : String(value.authorization);
  if (authorization && authorization !== 'research_again') throw new Error('Unsupported Phase 2 authorization.');
  const researchRequirement = value.research_requirement === undefined ? null : String(value.research_requirement);
  if (researchRequirement !== null && !['none', 'required'].includes(researchRequirement)) throw new Error('Research requirement must be none or required.');
  return { job_type: type, parameters: { candidate_id: value.candidate_id, ...(value.pipeline_version === 'v1' ? { pipeline_version: 'v1' } : {}), ...(authorization ? { authorization } : {}), ...(researchRequirement ? { research_requirement: researchRequirement } : {}) }, priority };
}

export function activeCandidateJob(jobs = [], candidateId) {
  return jobs.find(job => ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status) && job.parameters?.candidate_id === candidateId) || null;
}

export function candidatePipelineAction(candidate = {}, jobs = [], linkedStory = null) {
  if (linkedStory?.story_id) return { type: 'story_linked', label: 'Open Editorial Draft', href: `/newsroom/${linkedStory.story_id}` };
  const externalId = candidate.external_id || candidate.id;
  const active = activeCandidateJob(jobs, externalId);
  if (active) return { type: 'active', label: active.status === 'running' ? 'View running job' : 'View pipeline job', href: `/newsroom/pipeline/jobs/${active.id}`, job: active };
  if (candidate.status === 'ready_for_review' || candidate.status === 'ai_review_ready') return { type: 'review', label: 'Open review', href: `/newsroom/review/${externalId}` };
  if (candidate.status === 'research_blocked') return { type: 'process', label: 'Research again', action: 'research_again', candidate_id: externalId };
  if (candidate.status === 'verification_failed') return { type: 'process', label: 'Retry processing', candidate_id: externalId };
  if (candidate.status === 'pitch_ready' && candidate.classification?.editorial_pitch?.accepted === true) return { type: 'process', label: 'Commission reporting', candidate_id: externalId };
  return null;
}

export function pipelineReviewHref(candidate = {}) {
  const externalId = candidate.external_id || candidate.id;
  return ['ready_for_review', 'ai_review_ready'].includes(candidate.status) && externalId ? `/newsroom/review/${externalId}` : null;
}

export function concisePipelineError(error = {}) {
  const code = error?.code || '';
  if (code === 'MODEL_UNAVAILABLE' || code === 'PIPELINE_TIMEOUT') return 'The production model did not complete in time. You can retry after checking the controller.';
  if (code === 'PIPELINE_STATE_NOT_CONFIGURED' || code.startsWith('SOURCE_CONFIG_')) return 'Discovery source configuration needs attention before this job can run.';
  if (code === 'RESOURCE_BUSY' || code === 'MEMORY_PRESSURE') return 'The Mac Studio is busy. The job can be retried when capacity is available.';
  if (code === 'NOT_FOUND') return 'The retained candidate or pipeline run is no longer available.';
  return error?.message || 'The pipeline job failed without a retryable detail.';
}
