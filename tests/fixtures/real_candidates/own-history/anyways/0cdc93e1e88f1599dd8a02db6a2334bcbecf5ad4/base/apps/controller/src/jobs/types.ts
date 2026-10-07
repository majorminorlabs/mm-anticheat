export const JOB_TYPES = ['commission_article', 'create_editorial_pitch', 'generate_idea_pitches', 'enrich_discovery_candidate', 'discover', 'run_editorial_batch', 'process_candidate', 'polish_candidate', 'retry_run', 'sync_candidate', 'score_editorial_events', 'luna_editorial_candidate', 'luna_evidence_enrichment', 'x_browser_ingestion', 'health_check'] as const;
export type JobType = typeof JOB_TYPES[number]; export type Job = { id: string; job_type: JobType; parameters: Record<string, unknown>; attempt_count: number; max_attempts: number; cancellation_requested_at: string | null; pipeline_candidate_id: string | null; requested_by?: string | null; };
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const candidateId = (value: unknown) => uuid(value) || (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value));
export function validateJob(type: string, parameters: unknown): asserts parameters is Record<string, unknown> {
  if (!JOB_TYPES.includes(type as JobType) || !parameters || Array.isArray(parameters) || typeof parameters !== 'object') throw new Error('INVALID_PARAMETERS');
  const p = parameters as Record<string, unknown>;
  if ((type === 'discover' || type === 'run_editorial_batch') && p.focus_id !== undefined && (typeof p.focus_id !== 'string' || !/^[a-z]+(?:-[a-z]+)*$/.test(p.focus_id))) throw new Error('INVALID_PARAMETERS');
  if (['process_candidate', 'polish_candidate', 'sync_candidate', 'enrich_discovery_candidate'].includes(type) && !candidateId(p.candidate_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'process_candidate' && p.pipeline_version !== undefined && !['v1', 'pipeline-v1'].includes(String(p.pipeline_version))) throw new Error('INVALID_PARAMETERS');
  if (type === 'process_candidate' && p.writer !== undefined && !['luna-high', 'sol-low', 'sol-medium'].includes(String(p.writer))) throw new Error('INVALID_PARAMETERS');
  if (type === 'process_candidate' && p.length !== undefined && !['brief', 'standard', 'feature'].includes(String(p.length))) throw new Error('INVALID_PARAMETERS');
  if (type === 'process_candidate' && p.writer_model !== undefined && !['gpt-5.6-luna', 'gpt-5.6-sol'].includes(String(p.writer_model))) throw new Error('INVALID_PARAMETERS');
  if (type === 'process_candidate' && p.writer_reasoning !== undefined && !['high', 'low', 'medium'].includes(String(p.writer_reasoning))) throw new Error('INVALID_PARAMETERS');
  if (type === 'process_candidate' && p.writer !== undefined && p.writer_model !== undefined) {
    const expectedModel = p.writer === 'luna-high' ? 'gpt-5.6-luna' : 'gpt-5.6-sol';
    if (String(p.writer_model) !== expectedModel) throw new Error('INVALID_PARAMETERS');
  }
  if (type === 'process_candidate' && p.writer !== undefined && p.writer_reasoning !== undefined) {
    const expectedReasoning = p.writer === 'luna-high' ? 'high' : p.writer === 'sol-low' ? 'low' : 'medium';
    if (String(p.writer_reasoning) !== expectedReasoning) throw new Error('INVALID_PARAMETERS');
  }
  if (type === 'process_candidate' && p.authorization !== undefined && (!['research_again', 'replay_from_stage'].includes(String(p.authorization)) || !['v1', 'pipeline-v1'].includes(String(p.pipeline_version)))) throw new Error('INVALID_PARAMETERS');
  if (type === 'process_candidate' && p.authorization === 'replay_from_stage' && (!['research', 'packet', 'writer', 'review'].includes(String(p.replay_from_stage)) || !uuid(p.parent_run_id))) throw new Error('INVALID_PARAMETERS');
  if (type === 'polish_candidate' && (p.pipeline_version !== 'v1' || p.authorization !== 'polish_with_sol')) throw new Error('INVALID_PARAMETERS');
  if (type === 'retry_run' && !uuid(p.run_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'run_editorial_batch' && !uuid(p.batch_run_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'generate_idea_pitches' && !uuid(p.idea_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'score_editorial_events' && (p.model !== undefined && (typeof p.model !== 'string' || !p.model.trim() || p.model.length > 160))) throw new Error('INVALID_PARAMETERS');
  if (type === 'score_editorial_events' && (p.batch_size !== undefined && (!Number.isInteger(p.batch_size) || Number(p.batch_size) < 1 || Number(p.batch_size) > 5))) throw new Error('INVALID_PARAMETERS');
  if (type === 'score_editorial_events' && (p.minimum_score !== undefined && (typeof p.minimum_score !== 'number' || !Number.isFinite(p.minimum_score) || p.minimum_score < 0 || p.minimum_score > 10))) throw new Error('INVALID_PARAMETERS');
  if (type === 'score_editorial_events' && p.target_event_id !== undefined && !uuid(p.target_event_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'luna_editorial_candidate' && !uuid(p.candidate_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'luna_editorial_candidate' && (p.model !== undefined && (typeof p.model !== 'string' || !p.model.trim() || p.model.length > 160))) throw new Error('INVALID_PARAMETERS');
  if (type === 'luna_editorial_candidate' && (p.reasoning !== undefined && !['low', 'medium', 'high'].includes(String(p.reasoning)))) throw new Error('INVALID_PARAMETERS');
  if (type === 'luna_evidence_enrichment' && !uuid(p.candidate_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'luna_evidence_enrichment' && (p.max_urls_per_attempt !== undefined && (!Number.isInteger(p.max_urls_per_attempt) || Number(p.max_urls_per_attempt) < 1 || Number(p.max_urls_per_attempt) > 5))) throw new Error('INVALID_PARAMETERS');
  if (type === 'x_browser_ingestion' && p.source_id !== undefined && !uuid(p.source_id)) throw new Error('INVALID_PARAMETERS');
  if (type === 'x_browser_ingestion' && p.max_accounts_per_run !== undefined && (!Number.isInteger(p.max_accounts_per_run) || Number(p.max_accounts_per_run) < 1 || Number(p.max_accounts_per_run) > 10)) throw new Error('INVALID_PARAMETERS');
  if (type === 'x_browser_ingestion' && p.max_posts_per_account !== undefined && (!Number.isInteger(p.max_posts_per_account) || Number(p.max_posts_per_account) < 1 || Number(p.max_posts_per_account) > 50)) throw new Error('INVALID_PARAMETERS');
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
