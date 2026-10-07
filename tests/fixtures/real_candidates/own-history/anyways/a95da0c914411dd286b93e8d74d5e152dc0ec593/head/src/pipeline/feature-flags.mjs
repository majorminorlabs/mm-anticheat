export const PIPELINE_V1_VERSION = 'v1';

export function pipelineV1Enabled(env = {}) {
  return /^(1|true|yes)$/i.test(String(env.PIPELINE_V1_ENABLED || '').trim());
}

export function pipelineV1AllowedJobId(env = {}) {
  const value = String(env.PIPELINE_V1_ALLOWED_JOB_ID || '').trim();
  return value || null;
}

export function isPipelineV1Job(parameters = {}) {
  return ['v1', 'pipeline-v1'].includes(String(parameters.pipeline_version || '').trim().toLowerCase());
}

export function canRunPipelineV1(parameters = {}, env = {}, jobId = parameters.job_id) {
  if (!isPipelineV1Job(parameters)) return false;
  if (pipelineV1Enabled(env)) return true;
  const allowedJobId = pipelineV1AllowedJobId(env);
  return Boolean(allowedJobId && String(jobId || '').trim() === allowedJobId);
}
