#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { buildPitchPrompt, EDITORIAL_PITCH_SCHEMA, parseEditorialPitch, PITCH_PROMPT_VERSION } from '../src/pipeline/pitch.mjs';
import { OllamaAdapter } from '../src/pipeline/ollama.mjs';

const flag = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
};
const proposalId = flag('--proposal-id');
const jobId = flag('--job-id');
const attempt = Number(flag('--attempt') || 1);
const maxAttempts = Number(flag('--max-attempts') || 3);
const model = String(flag('--model') || process.env.OLLAMA_MODEL || 'qwen3.6:35b-a3b-nvfp4').trim();
const final = payload => console.log(JSON.stringify(payload));
const required = (name, value) => {
  if (!value) throw Object.assign(new Error(`${name} is required.`), { code: 'INVALID_PARAMETERS', retryable: false });
  return value;
};
const retryableError = error => {
  const message = error instanceof Error ? error.message : String(error);
  return Boolean(error?.retryable) || /abort|timeout|ollama|fetch|ECONN|EAI_AGAIN|HTTP 5\d\d|JSON|pitch gate|accepted pitches|rejected pitches/i.test(message);
};

let client;
let began = false;
let proposal;
try {
  required('SUPABASE_URL', process.env.SUPABASE_URL);
  required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);
  required('--proposal-id', proposalId);
  required('--job-id', jobId);
  client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.from('hermes_story_proposals').select('id,source_event_id,title,summary,source_url,source_name,primary_sections,topic_tags,writer_backend,pipeline_job_id,status').eq('id', proposalId).maybeSingle();
  if (error) throw Object.assign(new Error(`Qwen proposal lookup failed: ${error.message}`), { code: 'DISCOVERY_PERSISTENCE_FAILED', retryable: true });
  proposal = data;
  if (!proposal) throw Object.assign(new Error('Qwen proposal was not found.'), { code: 'NOT_FOUND', retryable: false });
  const started = await client.rpc('begin_generate_pitch', { p_job_id: jobId, p_proposal_id: proposalId, p_worker_id: process.env.CONTROLLER_ID || 'anyways-controller' });
  if (started.error) throw Object.assign(new Error(`Qwen proposal claim failed: ${started.error.message}`), { code: 'DISCOVERY_PERSISTENCE_FAILED', retryable: true });
  if (started.data?.duplicate) {
    final({ ok: true, result: started.data });
    process.exit(0);
  }
  began = true;
  const candidate = {
    title: proposal.title,
    description: proposal.summary,
    url: proposal.source_url || ''
  };
  const prompt = buildPitchPrompt({ candidate, section: null, requestedForm: null });
  const adapter = new OllamaAdapter({ model });
  const generated = await adapter.generate({ prompt, schema: EDITORIAL_PITCH_SCHEMA, timeoutMs: 12 * 60 * 1000, maxTokens: 1600 });
  const parsed = parseEditorialPitch(generated.raw, { sourceTitle: proposal.title, sourceDescription: proposal.summary });
  if (!parsed.accepted) {
    const rejected = await client.rpc('finish_generate_pitch', {
      p_job_id: jobId,
      p_proposal_id: proposalId,
      p_status: 'rejected',
      p_pitch: parsed,
      p_error: { code: 'PITCH_REJECTED', message: parsed.rejection_reason, retryable: false },
      p_model: model,
      p_prompt_version: PITCH_PROMPT_VERSION,
      p_retryable: false
    });
    if (rejected.error) throw Object.assign(new Error(`Rejected pitch could not be persisted: ${rejected.error.message}`), { code: 'DISCOVERY_PERSISTENCE_FAILED', retryable: true });
    final({ ok: true, result: { ...rejected.data, metrics: generated.metrics } });
    process.exit(0);
  }
  const pitch = { ...parsed, model, prompt_version: PITCH_PROMPT_VERSION, generation_metrics: generated.metrics };
  const completed = await client.rpc('finish_generate_pitch', {
    p_job_id: jobId,
    p_proposal_id: proposalId,
    p_status: 'succeeded',
    p_pitch: pitch,
    p_error: null,
    p_model: model,
    p_prompt_version: PITCH_PROMPT_VERSION,
    p_retryable: false
  });
  if (completed.error) throw Object.assign(new Error(`Qwen pitch could not be persisted: ${completed.error.message}`), { code: 'DISCOVERY_PERSISTENCE_FAILED', retryable: true });
  final({ ok: true, result: { ...completed.data, metrics: generated.metrics } });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const shouldRetry = retryableError(error) && attempt < maxAttempts;
  if (began && client) {
    try {
      await client.rpc('finish_generate_pitch', {
        p_job_id: jobId,
        p_proposal_id: proposalId,
        p_status: 'failed',
        p_pitch: null,
        p_error: { code: error?.code || 'QWEN_PITCH_FAILED', message, retryable: shouldRetry },
        p_model: model,
        p_prompt_version: PITCH_PROMPT_VERSION,
        p_retryable: shouldRetry
      });
    } catch (finishError) {
      console.error(`Qwen failure state could not be persisted: ${finishError instanceof Error ? finishError.message : String(finishError)}`);
    }
  }
  final({ ok: false, error: { code: error?.code || 'QWEN_PITCH_FAILED', message, retryable: shouldRetry } });
  process.exitCode = 1;
}
