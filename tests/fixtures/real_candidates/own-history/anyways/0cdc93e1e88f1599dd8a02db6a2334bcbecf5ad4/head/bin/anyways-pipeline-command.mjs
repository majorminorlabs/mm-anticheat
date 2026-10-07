#!/usr/bin/env node
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1] || null; };
const candidateId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '') || /^[a-f0-9]{64}$/i.test(value || '');
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
const ideaId = value => uuid(value);
const proposalId = value => uuid(value);
const map = {
  discover: ['discover', ...(value('--focus-id') ? ['--focus-id', value('--focus-id')] : [])],
  create_editorial_pitch: value('--request') ? ['create_editorial_pitch', '--request', value('--request')] : null,
  generate_idea_pitches: value('--idea-id') ? ['generate_idea_pitches', value('--idea-id'), ...(value('--job-id') ? ['--job-id', value('--job-id')] : [])] : null,
  generate_pitch: value('--proposal-id') ? ['generate_pitch', '--proposal-id', value('--proposal-id'), ...(value('--job-id') ? ['--job-id', value('--job-id')] : []), ...(value('--attempt') ? ['--attempt', value('--attempt')] : []), ...(value('--max-attempts') ? ['--max-attempts', value('--max-attempts')] : []), ...(value('--model') ? ['--model', value('--model')] : [])] : null,
  enrich_discovery_candidate: value('--candidate-id') ? ['enrich', value('--candidate-id'), ...(value('--job-id') ? ['--job-id', value('--job-id')] : [])] : null,
  run_editorial_batch: ['batch', ...(value('--batch-id') ? ['--batch-id', value('--batch-id')] : []), ...(value('--focus-id') ? ['--focus-id', value('--focus-id')] : [])],
  process_candidate: value('--candidate-id') ? ['process', value('--candidate-id'), ...(value('--pipeline-version') ? ['--pipeline-version', value('--pipeline-version')] : []), ...(value('--writer') ? ['--writer', value('--writer')] : []), ...(value('--length') ? ['--length', value('--length')] : []), ...(value('--writer-model') ? ['--writer-model', value('--writer-model')] : []), ...(value('--writer-reasoning') ? ['--writer-reasoning', value('--writer-reasoning')] : []), ...(value('--action') ? ['--action', value('--action')] : []), ...(value('--replay-from-stage') ? ['--replay-from-stage', value('--replay-from-stage')] : []), ...(value('--parent-run-id') ? ['--parent-run-id', value('--parent-run-id')] : []), ...(value('--replay-attempt-id') ? ['--replay-attempt-id', value('--replay-attempt-id')] : []), ...(value('--job-id') ? ['--job-id', value('--job-id')] : []), ...(value('--revision-instructions') ? ['--revision-instructions', value('--revision-instructions')] : [])] : null,
  polish_candidate: value('--candidate-id') ? ['polish', value('--candidate-id'), '--pipeline-version', 'v1', ...(value('--job-id') ? ['--job-id', value('--job-id')] : [])] : null,
  sync_candidate: value('--candidate-id') ? ['--sync', value('--candidate-id')] : null,
  score_editorial_events: value('--request') ? ['score_editorial_events', '--request', value('--request')] : null,
  luna_editorial_candidate: value('--request') ? ['luna_editorial_candidate', '--request', value('--request')] : null,
  luna_evidence_enrichment: value('--request') ? ['luna_evidence_enrichment', '--request', value('--request')] : null
};
const identifier = value('--candidate-id');
const requestedProposalId = value('--proposal-id');
const requestedIdeaId = value('--idea-id');
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
const humanBlockedPhase2 = result => result?.status === 'research_blocked';
if (!map[command] || (!['discover', 'run_editorial_batch', 'create_editorial_pitch', 'score_editorial_events', 'luna_editorial_candidate', 'luna_evidence_enrichment', 'generate_idea_pitches', 'generate_pitch'].includes(command) && !candidateId(identifier)) || (command === 'generate_idea_pitches' && !ideaId(requestedIdeaId)) || (command === 'generate_pitch' && !proposalId(requestedProposalId)) || (value('--batch-id') && !uuid(value('--batch-id')))) {
  console.log(JSON.stringify({ ok: false, command: command || null, error: { code: 'INVALID_PARAMETERS', message: 'Supported commands are discover, create_editorial_pitch, generate_idea_pitches, generate_pitch, run_editorial_batch, process_candidate, polish_candidate, sync_candidate, score_editorial_events, luna_editorial_candidate, and luna_evidence_enrichment.', retryable: false } }));
  process.exitCode = 1;
} else {
  const childArgs = command === 'sync_candidate' ? ['bin/pipeline-sync-supabase.mjs', identifier] : command === 'score_editorial_events' ? ['bin/anyways-editorial-score.mjs', ...map[command].slice(1)] : command === 'luna_editorial_candidate' ? ['bin/anyways-luna-editorial.mjs', ...map[command].slice(1)] : command === 'luna_evidence_enrichment' ? ['bin/anyways-luna-enrich.mjs', ...map[command].slice(1)] : command === 'generate_pitch' ? ['bin/anyways-generate-pitch.mjs', ...map[command].slice(1)] : ['bin/anyways-ops.mjs', ...map[command]];
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
    if (requiresReview && !completedReview(pipelineResult) && !humanBlockedPhase2(pipelineResult)) {
      const status = pipelineResult?.status || 'unknown';
      const cause = pipelineResult?.error;
      console.log(JSON.stringify({ ok: false, command, candidate_id: identifier, error: { code: cause?.code || 'REVIEW_PACKAGE_NOT_CREATED', message: cause?.message || `Pipeline finished without a review package (status: ${status}).`, retryable: false, ...(cause?.details ? { details: cause.details } : {}) } }));
      process.exitCode = 1;
    } else if (process.exitCode !== 1) {
      console.log(JSON.stringify({ ok: true, command, ...(command === 'process_candidate' || command === 'sync_candidate' ? { candidate_id: identifier } : command === 'create_editorial_pitch' ? { candidate_id: childResult?.result?.candidate_id } : command === 'generate_idea_pitches' ? { idea_id: requestedIdeaId } : {}), result: childResult || {}, ...(sync ? { sync } : {}) }));
    }
  } else {
    console.log(JSON.stringify({ ok: false, command, ...(command === 'process_candidate' || command === 'sync_candidate' ? { candidate_id: identifier } : {}), error: childResult?.error || { code: 'PIPELINE_EXIT_NONZERO', message: `Pipeline command exited ${outcome.code ?? 'unknown'}.`, retryable: false } }));
    process.exitCode = 1;
  }
}
