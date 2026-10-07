export const NEWSROOM_SUBMITTABLE_JOB_TYPES = Object.freeze(['discover', 'process_candidate']);
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
  if (!candidateId(value.candidate_id)) throw new Error('Select a valid retained candidate before processing.');
  return { job_type: type, parameters: { candidate_id: value.candidate_id }, priority };
}

export function activeCandidateJob(jobs = [], candidateId) {
  return jobs.find(job => ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status) && job.parameters?.candidate_id === candidateId) || null;
}

export function candidatePipelineAction(candidate = {}, jobs = [], linkedStory = null) {
  if (linkedStory?.story_id) return { type: 'story_linked', label: 'Open Editorial Draft', href: `/newsroom/${linkedStory.story_id}` };
  const externalId = candidate.external_id || candidate.id;
  const active = activeCandidateJob(jobs, externalId);
  if (active) return { type: 'active', label: active.status === 'running' ? 'View running job' : 'View pipeline job', href: `/newsroom/pipeline/jobs/${active.id}`, job: active };
  if (candidate.status === 'ready_for_review') return { type: 'review', label: 'Open review', href: `/newsroom/review/${externalId}` };
  if (candidate.status === 'research_blocked' || candidate.status === 'verification_failed') return { type: 'process', label: 'Retry processing', candidate_id: externalId };
  if (candidate.status === 'discovered' || candidate.status === 'watching' || candidate.status === 'rejected') return { type: 'process', label: 'Process candidate', candidate_id: externalId };
  return null;
}

export function pipelineReviewHref(candidate = {}) {
  const externalId = candidate.external_id || candidate.id;
  return candidate.status === 'ready_for_review' && externalId ? `/newsroom/review/${externalId}` : null;
}

export function concisePipelineError(error = {}) {
  const code = error?.code || '';
  if (code === 'MODEL_UNAVAILABLE' || code === 'PIPELINE_TIMEOUT') return 'The local model did not complete in time. You can retry after checking the controller.';
  if (code === 'PIPELINE_STATE_NOT_CONFIGURED' || code.startsWith('SOURCE_CONFIG_')) return 'Discovery source configuration needs attention before this job can run.';
  if (code === 'RESOURCE_BUSY' || code === 'MEMORY_PRESSURE') return 'The Mac Studio is busy. The job can be retried when capacity is available.';
  if (code === 'NOT_FOUND') return 'The retained candidate or pipeline run is no longer available.';
  return error?.message || 'The pipeline job failed without a retryable detail.';
}
