export const RESOURCE_CLASSES = {
  deterministicWork: 'deterministic-work',
  cloudCodexGeneration: 'cloud-codex-generation',
  localHeavyModel: 'local-heavy-model'
} as const;
export type ResourceClass = typeof RESOURCE_CLASSES[keyof typeof RESOURCE_CLASSES];

export function canRunPipelineV1(job: { id?: string; parameters?: Record<string, unknown> }, env: NodeJS.ProcessEnv = process.env): boolean {
  const pipelineV1 = ['v1', 'pipeline-v1'].includes(String(job.parameters?.pipeline_version || '').trim());
  if (!pipelineV1) return false;
  if (/^(1|true|yes)$/i.test(env.PIPELINE_V1_ENABLED || '')) return true;
  const allowedJobId = String(env.PIPELINE_V1_ALLOWED_JOB_ID || '').trim();
  return Boolean(allowedJobId && String(job.id || '').trim() === allowedJobId);
}

export function resourceClassForJob(job: { id?: string; job_type: string; parameters?: Record<string, unknown> }, env: NodeJS.ProcessEnv = process.env): ResourceClass {
  const pipelineV1 = ['v1', 'pipeline-v1'].includes(String(job.parameters?.pipeline_version || '').trim());
  if (['process_candidate', 'polish_candidate'].includes(job.job_type) && pipelineV1 && canRunPipelineV1(job, env)) return RESOURCE_CLASSES.cloudCodexGeneration;
  if (job.job_type === 'run_editorial_batch' && pipelineV1 && canRunPipelineV1(job, env)) return RESOURCE_CLASSES.cloudCodexGeneration;
  if (job.job_type === 'luna_editorial_candidate') return RESOURCE_CLASSES.cloudCodexGeneration;
  if (['commission_article', 'create_editorial_pitch', 'enrich_discovery_candidate', 'process_candidate', 'run_editorial_batch', 'generate_idea_pitches', 'score_editorial_events'].includes(job.job_type)) return RESOURCE_CLASSES.localHeavyModel;
  return RESOURCE_CLASSES.deterministicWork;
}

export function resourceLockName(resourceClass: ResourceClass): string | null {
  if (resourceClass === RESOURCE_CLASSES.cloudCodexGeneration) return 'heavy_model';
  if (resourceClass === RESOURCE_CLASSES.localHeavyModel) return 'heavy_model';
  return null;
}
