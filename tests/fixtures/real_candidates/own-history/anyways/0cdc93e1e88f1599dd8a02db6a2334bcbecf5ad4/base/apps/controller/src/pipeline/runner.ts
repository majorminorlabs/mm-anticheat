import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import type { Job } from '../jobs/types.js';
import { runXBrowserIngestion } from '../x-browser/run.js';

export const jobArguments = (job: Job) => {
  const p = job.parameters;
  if (job.job_type === 'x_browser_ingestion') return ['x_browser_ingestion', ...(p.source_id ? ['--source-id', String(p.source_id)] : [])];
  if (job.job_type === 'commission_article') return ['commission_article', '--request', Buffer.from(JSON.stringify(p)).toString('base64url')];
  if (job.job_type === 'create_editorial_pitch') return ['create_editorial_pitch', '--request', Buffer.from(JSON.stringify(p)).toString('base64url')];
  if (job.job_type === 'generate_idea_pitches') return ['generate_idea_pitches', '--idea-id', String(p.idea_id), '--job-id', String(job.id)];
  if (job.job_type === 'enrich_discovery_candidate') return ['enrich_discovery_candidate', '--candidate-id', String(p.candidate_id), '--job-id', String(job.id)];
  if (job.job_type === 'discover') return ['discover', ...(p.focus_id ? ['--focus-id', String(p.focus_id)] : [])];
  if (job.job_type === 'run_editorial_batch') return ['run_editorial_batch', '--batch-id', String(p.batch_run_id), ...(p.focus_id ? ['--focus-id', String(p.focus_id)] : [])];
  if (job.job_type === 'process_candidate') return ['process_candidate', '--candidate-id', String(p.candidate_id), ...(p.pipeline_version === 'v1' || p.pipeline_version === 'pipeline-v1' ? ['--pipeline-version', 'v1'] : []), ...(p.writer ? ['--writer', String(p.writer)] : []), ...(p.length ? ['--length', String(p.length)] : []), ...(p.writer_model ? ['--writer-model', String(p.writer_model)] : []), ...(p.writer_reasoning ? ['--writer-reasoning', String(p.writer_reasoning)] : []), ...(p.authorization ? ['--action', String(p.authorization)] : []), ...(p.replay_from_stage ? ['--replay-from-stage', String(p.replay_from_stage)] : []), ...(p.parent_run_id ? ['--parent-run-id', String(p.parent_run_id)] : []), ...(p.replay_attempt_id ? ['--replay-attempt-id', String(p.replay_attempt_id)] : []), ...(p.revision_instructions ? ['--revision-instructions', String(p.revision_instructions)] : []), '--job-id', String(job.id)];
  if (job.job_type === 'polish_candidate') return ['polish_candidate', '--candidate-id', String(p.candidate_id), '--pipeline-version', 'v1', '--job-id', String(job.id)];
  if (job.job_type === 'retry_run') return ['retry_run', '--run-id', String(p.run_id)];
  if (job.job_type === 'sync_candidate') return ['sync_candidate', '--candidate-id', String(p.candidate_id)];
  if (job.job_type === 'score_editorial_events') return ['score_editorial_events', '--request', Buffer.from(JSON.stringify({ job_id: job.id, model: p.model, batch_size: p.batch_size, hourly_budget: p.hourly_budget, minimum_score: p.minimum_score, prompt_version: p.prompt_version || 'discipline_direct_v1', ...(p.target_event_id ? { target_event_id: p.target_event_id } : {}) })).toString('base64url')];
  if (job.job_type === 'luna_editorial_candidate') return ['luna_editorial_candidate', '--request', Buffer.from(JSON.stringify({ job_id: job.id, candidate_id: p.candidate_id, model: p.model || 'gpt-5.6-luna', reasoning: p.reasoning || 'high', minimum_score: p.minimum_score ?? 4, prompt_version: p.prompt_version || 'luna-editorial-v1' })).toString('base64url')];
  if (job.job_type === 'luna_evidence_enrichment') return ['luna_evidence_enrichment', '--request', Buffer.from(JSON.stringify({ job_id: job.id, candidate_id: p.candidate_id, max_attempts: p.max_attempts ?? 1, max_urls_per_attempt: p.max_urls_per_attempt ?? 3, max_bytes_per_page: p.max_bytes_per_page ?? 524288, timeout_ms: p.timeout_ms ?? 8000, cooldown_minutes: p.cooldown_minutes ?? 60, automatic_retry: p.automatic_retry !== false, prompt_version: p.prompt_version || 'luna-evidence-enrichment-v1', ...(job.requested_by ? { requested_by: job.requested_by } : {}) })).toString('base64url')];
  return null;
};

export type PipelineResult = { ok: boolean; result?: unknown; error?: { code: string; message: string; retryable: boolean }; log: string };

export function pipelineTimeoutMs(config: Config, job: Job) {
  const phase2 = ['process_candidate', 'polish_candidate', 'luna_editorial_candidate'].includes(job.job_type) && (job.job_type === 'luna_editorial_candidate' || ['v1', 'pipeline-v1'].includes(String(job.parameters.pipeline_version || '')));
  return phase2 ? config.phase2JobTimeoutMs : config.jobTimeoutMs;
}

export async function runPipeline(config: Config, job: Job, onLine: (line: string, stderr: boolean) => Promise<void>, cancelled: () => Promise<boolean>, signal?: AbortSignal): Promise<PipelineResult> {
  if (job.job_type === 'x_browser_ingestion') {
    try {
      return { ok: true, result: await runXBrowserIngestion(config, job, onLine, cancelled, signal), log: 'X Browser Ingestion completed.' };
    } catch (error) {
      const details = error as { code?: string };
      return { ok: false, error: { code: details?.code || 'X_BROWSER_INGESTION_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }, log: error instanceof Error ? error.message : String(error) };
    }
  }
  const args = jobArguments(job);
  if (!args) return { ok: true, result: { health: 'ok' }, log: 'Controller health check completed.' };
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['bin/anyways-pipeline-command.mjs', ...args], { cwd: config.anywaysRepoPath, env: { ...process.env, ANYWAYS_CODEX_BIN: config.codexExecutable }, stdio: ['ignore', 'pipe', 'pipe'] });
    let all = ''; let final: any; let terminated = false; let settled = false; let killTimer: NodeJS.Timeout | undefined;
    const consume = (chunk: Buffer, stderr: boolean) => { const text = chunk.toString(); all += text; for (const line of text.split(/\r?\n/).filter(Boolean)) { void onLine(line, stderr); try { final = JSON.parse(line); } catch {} } };
    const terminate = () => { if (terminated) return; terminated = true; child.kill('SIGTERM'); killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, config.childKillGraceMs); };
    child.stdout.on('data', chunk => consume(chunk, false)); child.stderr.on('data', chunk => consume(chunk, true));
    const onAbort = () => terminate();
    if (signal?.aborted) terminate(); else signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(terminate, pipelineTimeoutMs(config, job));
    const cancellation = setInterval(async () => { if (await cancelled()) terminate(); }, Math.min(config.heartbeatMs, 5000));
    const finish = (result: PipelineResult) => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(killTimer); clearInterval(cancellation); signal?.removeEventListener('abort', onAbort); resolve(result); };
    child.on('error', error => finish({ ok: false, error: { code: 'PIPELINE_SPAWN_FAILED', message: error.message, retryable: true }, log: all }));
    child.on('close', code => finish(final?.ok ? { ok: true, result: final.result, log: all } : { ok: false, error: final?.error || { code: terminated ? 'PIPELINE_TIMEOUT' : 'PIPELINE_EXIT_NONZERO', message: `Pipeline exited ${code ?? 'unknown'}.`, retryable: terminated }, log: all }));
  });
}
