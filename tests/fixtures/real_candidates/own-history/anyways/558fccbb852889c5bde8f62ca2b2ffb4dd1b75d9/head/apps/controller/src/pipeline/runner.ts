import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import type { Job } from '../jobs/types.js';

export const jobArguments = (job: Job) => {
  const p = job.parameters;
  if (job.job_type === 'commission_article') return ['commission_article', '--request', Buffer.from(JSON.stringify(p)).toString('base64url')];
  if (job.job_type === 'create_editorial_pitch') return ['create_editorial_pitch', '--request', Buffer.from(JSON.stringify(p)).toString('base64url')];
  if (job.job_type === 'discover') return ['discover'];
  if (job.job_type === 'run_editorial_batch') return ['run_editorial_batch'];
  if (job.job_type === 'process_candidate') return ['process_candidate', '--candidate-id', String(p.candidate_id), ...(p.pipeline_version === 'v1' || p.pipeline_version === 'pipeline-v1' ? ['--pipeline-version', 'v1'] : []), ...(p.authorization ? ['--action', String(p.authorization)] : []), ...(p.revision_instructions ? ['--revision-instructions', String(p.revision_instructions)] : []), '--job-id', String(job.id)];
  if (job.job_type === 'polish_candidate') return ['polish_candidate', '--candidate-id', String(p.candidate_id), '--pipeline-version', 'v1', '--job-id', String(job.id)];
  if (job.job_type === 'retry_run') return ['retry_run', '--run-id', String(p.run_id)];
  if (job.job_type === 'sync_candidate') return ['sync_candidate', '--candidate-id', String(p.candidate_id)];
  return null;
};

export type PipelineResult = { ok: boolean; result?: unknown; error?: { code: string; message: string; retryable: boolean }; log: string };

export function pipelineTimeoutMs(config: Config, job: Job) {
  const phase2 = ['process_candidate', 'polish_candidate'].includes(job.job_type) && ['v1', 'pipeline-v1'].includes(String(job.parameters.pipeline_version || ''));
  return phase2 ? config.phase2JobTimeoutMs : config.jobTimeoutMs;
}

export async function runPipeline(config: Config, job: Job, onLine: (line: string, stderr: boolean) => Promise<void>, cancelled: () => Promise<boolean>, signal?: AbortSignal): Promise<PipelineResult> {
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
