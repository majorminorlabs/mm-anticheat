#!/usr/bin/env node
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1] || null; };
const candidateId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '') || /^[a-f0-9]{64}$/i.test(value || '');
const map = {
  discover: ['discover'],
  create_editorial_pitch: value('--request') ? ['create_editorial_pitch', '--request', value('--request')] : null,
  run_editorial_batch: ['batch'],
  process_candidate: value('--candidate-id') ? ['process', value('--candidate-id')] : null,
  sync_candidate: value('--candidate-id') ? ['--sync', value('--candidate-id')] : null
};
const identifier = value('--candidate-id');
const runChild = (args, output) => new Promise(resolve => {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { const text = chunk.toString(); output.value += text; process.stdout.write(text); });
  child.on('error', error => resolve({ code: 1, error }));
  child.on('close', code => resolve({ code, error: null }));
});
const lastJson = output => {
  for (const line of output.trim().split(/\r?\n/).reverse()) { try { return JSON.parse(line); } catch {} }
  return null;
};
const completedReview = result => result?.status === 'ready_for_review' && result?.review_id;
if (!map[command] || (command !== 'discover' && command !== 'run_editorial_batch' && command !== 'create_editorial_pitch' && !candidateId(identifier))) {
  console.log(JSON.stringify({ ok: false, command: command || null, error: { code: 'INVALID_PARAMETERS', message: 'Supported commands are discover, create_editorial_pitch, run_editorial_batch, process_candidate, and sync_candidate.', retryable: false } }));
  process.exitCode = 1;
} else {
  const childArgs = command === 'sync_candidate' ? ['bin/pipeline-sync-supabase.mjs', identifier] : ['bin/anyways-ops.mjs', ...map[command]];
  const output = { value: '' };
  const outcome = await runChild(childArgs, output);
  const childResult = lastJson(output.value);
  if (outcome.error) {
    console.log(JSON.stringify({ ok: false, command, error: { code: 'PIPELINE_SPAWN_FAILED', message: outcome.error.message, retryable: true } }));
    process.exitCode = 1;
  } else if (outcome.code === 0) {
    let sync = null;
    const syncCandidateId = command === 'process_candidate' ? identifier : childResult?.result?.candidate_id;
    if (command === 'process_candidate' && completedReview(childResult?.result) && candidateId(syncCandidateId)) {
      const syncOutput = { value: '' };
      const syncOutcome = await runChild(['bin/pipeline-sync-supabase.mjs', syncCandidateId], syncOutput);
      const syncResult = lastJson(syncOutput.value);
      if (syncOutcome.code !== 0 || syncOutcome.error) {
        console.log(JSON.stringify({ ok: false, command, candidate_id: identifier, error: syncResult?.error || { code: 'PIPELINE_SYNC_FAILED', message: 'Review package could not be synchronized to Newsroom.', retryable: true } }));
        process.exitCode = 1;
      } else {
        sync = syncResult;
      }
    }
    const requiresReview = command === 'process_candidate';
    const pipelineResult = childResult?.result;
    if (requiresReview && !completedReview(pipelineResult)) {
      const status = pipelineResult?.status || 'unknown';
      const cause = pipelineResult?.error;
      console.log(JSON.stringify({ ok: false, command, candidate_id: identifier, error: { code: cause?.code || 'REVIEW_PACKAGE_NOT_CREATED', message: cause?.message || `Pipeline finished without a review package (status: ${status}).`, retryable: status === 'research_blocked' || status === 'verification_failed', ...(cause?.details ? { details: cause.details } : {}) } }));
      process.exitCode = 1;
    } else if (process.exitCode !== 1) {
      console.log(JSON.stringify({ ok: true, command, ...(command === 'process_candidate' || command === 'sync_candidate' ? { candidate_id: identifier } : command === 'create_editorial_pitch' ? { candidate_id: childResult?.result?.candidate_id } : {}), result: childResult || {}, ...(sync ? { sync } : {}) }));
    }
  } else {
    console.log(JSON.stringify({ ok: false, command, ...(command === 'process_candidate' || command === 'sync_candidate' ? { candidate_id: identifier } : {}), error: childResult?.error || { code: 'PIPELINE_EXIT_NONZERO', message: `Pipeline command exited ${outcome.code ?? 'unknown'}.`, retryable: false } }));
    process.exitCode = 1;
  }
}
