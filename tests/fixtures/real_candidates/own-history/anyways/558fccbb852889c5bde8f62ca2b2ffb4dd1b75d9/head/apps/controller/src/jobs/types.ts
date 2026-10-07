export const JOB_TYPES = ['commission_article', 'create_editorial_pitch', 'discover', 'run_editorial_batch', 'process_candidate', 'polish_candidate', 'retry_run', 'sync_candidate', 'health_check'] as const;
export type JobType = typeof JOB_TYPES[number]; export type Job = { id: string; job_type: JobType; parameters: Record<string, unknown>; attempt_count: number; max_attempts: number; cancellation_requested_at: string | null; pipeline_candidate_id: string | null; };
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const candidateId = (value: unknown) => uuid(value) || (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value));
export function validateJob(type: string, parameters: unknown): asserts parameters is Record<string, unknown> {
  if (!JOB_TYPES.includes(type as JobType) || !parameters || Array.isArray(parameters) || typeof parameters !== 'object') throw new Error('INVALID_PARAMETERS');
  const p = parameters as Record<string, unknown>;
  if (['process_candidate', 'polish_candidate', 'sync_candidate'].includes(type) && !candidateId(p.candidate_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'process_candidate' && p.pipeline_version !== undefined && !['v1', 'pipeline-v1'].includes(String(p.pipeline_version))) throw new Error('INVALID_PARAMETERS');
  if (type === 'process_candidate' && p.authorization !== undefined && (!['research_again'].includes(String(p.authorization)) || !['v1', 'pipeline-v1'].includes(String(p.pipeline_version)))) throw new Error('INVALID_PARAMETERS');
  if (type === 'polish_candidate' && (p.pipeline_version !== 'v1' || p.authorization !== 'polish_with_sol')) throw new Error('INVALID_PARAMETERS');
  if (type === 'retry_run' && !uuid(p.run_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'run_editorial_batch' && !uuid(p.batch_run_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'commission_article' || type === 'create_editorial_pitch') {
    const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
    if (typeof p.brief !== 'string' || p.brief.length < 20 || p.brief.length > 3000
      || typeof p.section_id !== 'string' || (p.story_form !== undefined && typeof p.story_form !== 'string') || !strings(p.beats) || !strings(p.tags)
      || !strings(p.source_urls) || !(p.source_urls as string[]).length
      || (p.source_urls as string[]).length > 20 || (p.source_urls as string[]).some(value => {
        try { return !['http:', 'https:'].includes(new URL(value).protocol); } catch { return true; }
      })
      || typeof p.notes !== 'string' || p.notes.length > 4000) throw new Error('INVALID_PARAMETERS');
  }
}
