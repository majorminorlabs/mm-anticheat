#!/usr/bin/env node
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1] || null; };
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
const candidateId = value => uuid(value) || /^[a-f0-9]{64}$/i.test(value || '');
const map = {
  discover: ['discover'],
  process_candidate: value('--candidate-id') ? ['process', value('--candidate-id')] : null,
  retry_run: value('--run-id') ? ['retry', value('--run-id')] : null,
  sync_candidate: value('--candidate-id') ? ['--sync', value('--candidate-id')] : null
};
const identifier = command === 'retry_run' ? value('--run-id') : value('--candidate-id');
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
if (!map[command] || (command !== 'discover' && !(command === 'retry_run' ? uuid(identifier) : candidateId(identifier)))) {
  console.log(JSON.stringify({ ok: false, command: command || null, error: { code: 'INVALID_PARAMETERS', message: 'Supported commands are discover, process_candidate, retry_run, and sync_candidate with UUID arguments.', retryable: false } }));
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
    if ((command === 'process_candidate' || command === 'retry_run') && childResult?.result?.status === 'ready_for_review' && candidateId(syncCandidateId)) {
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
    if (process.exitCode !== 1) console.log(JSON.stringify({ ok: true, command, ...(command === 'process_candidate' || command === 'sync_candidate' ? { candidate_id: identifier } : command === 'retry_run' ? { run_id: identifier } : {}), result: childResult || {}, ...(sync ? { sync } : {}) }));
  } else {
    console.log(JSON.stringify({ ok: false, command, ...(command === 'process_candidate' || command === 'sync_candidate' ? { candidate_id: identifier } : command === 'retry_run' ? { run_id: identifier } : {}), error: childResult?.error || { code: 'PIPELINE_EXIT_NONZERO', message: `Pipeline command exited ${outcome.code ?? 'unknown'}.`, retryable: false } }));
    process.exitCode = 1;
  }
}
