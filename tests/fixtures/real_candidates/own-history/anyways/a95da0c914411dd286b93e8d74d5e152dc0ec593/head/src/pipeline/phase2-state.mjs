import crypto from 'node:crypto';
import { TERRA_EVIDENCE_CONTRACT_VERSION } from './phase1-schemas.mjs';
import { PHASE2_INVENTORY_CONTRACT_VERSION } from './phase2-inventory.mjs';

export const PHASE2_VERSION = 'pipeline-v1';
export const PHASE2_STAGES = Object.freeze([
  'commissioned',
  'preparing_evidence',
  'researching',
  'research_blocked',
  'evidence_ready',
  'drafting',
  'draft_ready',
  'revising',
  'ai_review_ready',
  'failed'
]);

const now = () => new Date().toISOString();
const TERMINAL_RUN_STATUSES = new Set(['blocked', 'failed', 'complete']);
const TERMINAL_ATTEMPT_STATUSES = new Set(['complete', 'failed', 'skipped']);

export const caseRunIdFor = value => value?.case_run_id || value?.id || value?.run_id || null;
export const holdoutRunIdFor = value => value?.holdout_run_id || null;

export function assertPhase2Identity({ holdoutRunId, caseRunId, records = [] } = {}) {
  const errors = [];
  if (!holdoutRunId) errors.push('holdout_run_id is missing.');
  if (!caseRunId) errors.push('case_run_id is missing.');
  for (const record of records) {
    if (record?.holdout_run_id !== holdoutRunId) errors.push(`Record ${record?.id || record?.stage || 'unknown'} has a holdout_run_id mismatch.`);
    if (record?.case_run_id !== caseRunId) errors.push(`Record ${record?.id || record?.stage || 'unknown'} has a case_run_id mismatch.`);
  }
  return { ok: errors.length === 0, errors };
}

function redactText(value) {
  return String(value ?? '')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|credential)["']?\s*:\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|credential)\s*[:=]\s*["']?)[^\s,"']+/gi, '$1[REDACTED]');
}

function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
}

function currentAttempt(state, run, stage) {
  return [...state.phase2_attempts].reverse().find(item => caseRunIdFor(item) === caseRunIdFor(run) && item.stage === stage && item.status === 'running');
}

function addUsage(run, usage) {
  if (!usage || run.model_usage.some(item => item.stage === usage.stage && item.attempt === usage.attempt)) return;
  run.model_usage.push(usage);
  if (Number.isFinite(usage.estimated_cost_usd)) run.estimated_cost_usd = (run.estimated_cost_usd ?? 0) + usage.estimated_cost_usd;
}

export function ensurePhase2State(state) {
  for (const key of ['phase2_runs', 'phase2_attempts', 'phase2_artifacts', 'phase2_reviews']) state[key] ||= [];
  return state;
}

export function phase2RunFor(state, candidateId) {
  ensurePhase2State(state);
  return [...state.phase2_runs].reverse().find(run => run.candidate_id === candidateId && run.pipeline_version === PHASE2_VERSION && run.terra_evidence_contract_version === TERRA_EVIDENCE_CONTRACT_VERSION) || null;
}

export function transitionPhase2(candidate, next, actor = 'pipeline', note = '') {
  if (!PHASE2_STAGES.includes(next)) throw new Error(`Invalid Phase 2 state: ${next}`);
  candidate.phase2_history ||= [];
  const last = candidate.phase2_history.at(-1);
  if (candidate.phase2_state === next && last?.state === next && last?.note === note) return candidate;
  candidate.phase2_state = next;
  candidate.phase2_history.push({ at: now(), actor, state: next, note });
  return candidate;
}

export function createPhase2Run(candidateId, authorization = null, identity = {}) {
  const at = now();
  const caseRunId = identity.case_run_id || authorization?.case_run_id || crypto.randomUUID();
  const holdoutRunId = identity.holdout_run_id || authorization?.holdout_run_id || null;
  return {
    id: caseRunId,
    case_run_id: caseRunId,
    holdout_run_id: holdoutRunId,
    candidate_id: candidateId,
    pipeline_version: PHASE2_VERSION,
    terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION,
    phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION,
    resource_class: 'cloud-codex-generation',
    state: 'commissioned',
    status: 'running',
    started_at: at,
    finished_at: null,
    commission_job_id: authorization?.job_id || null,
    assignment_sha256: authorization?.assignment_checksum || null,
    readiness_inventory_sha256: authorization?.readiness_inventory_sha256 || null,
    runtime_inventory_sha256: authorization?.runtime_inventory_sha256 || null,
    terra_input_packet_sha256: authorization?.terra_input_packet_sha256 || null,
    frozen_evidence_packet_sha256: authorization?.frozen_evidence_packet_sha256 || null,
    draft_input_sha256: authorization?.draft_input_sha256 || null,
    revision_input_sha256: authorization?.revision_input_sha256 || null,
    research_requirement: authorization?.research_requirement || null,
    evidence_preflight: null,
    provider_call_count: 0,
    provider_calls: [],
    retry_count: 0,
    events: [],
    attempts: [],
    source_fetches: [],
    source_gate: null,
    stage_results: {},
    model_usage: [],
    estimated_cost_usd: null,
    error: null
  };
}

export function stageArtifact(state, runId, stage) {
  ensurePhase2State(state);
  return [...state.phase2_artifacts].reverse().find(item => caseRunIdFor(item) === runId && item.stage === stage && item.status === 'complete') || null;
}

export function beginStage(state, run, stage, { force = false, metadata = {} } = {}) {
  ensurePhase2State(state);
  const existing = stageArtifact(state, run.id, stage);
  if (existing && !force) return { artifact: existing, reused: true };
  const attempt = state.phase2_attempts.filter(item => caseRunIdFor(item) === caseRunIdFor(run) && item.stage === stage).length + 1;
  const record = {
    id: crypto.randomUUID(),
    holdout_run_id: run.holdout_run_id || null,
    case_run_id: run.case_run_id || run.id,
    candidate_id: run.candidate_id,
    pipeline_version: PHASE2_VERSION,
    terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION,
    phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION,
    stage,
    attempt,
    status: 'running',
    started_at: now(),
    response_received_at: null,
    finished_at: null,
    runtime_ms: null,
    raw_response: null,
    raw_provider_events: null,
    provider_stderr: null,
    provider_exit_status: null,
    adapter_diagnostics: null,
    provider_request_id: null,
    provider_call_started: false,
    provider_call_id: null,
    provider_started_at: null,
    usage: null,
    adapter_outcome: 'not_started',
    parse_outcome: 'not_attempted',
    schema_outcome: 'not_attempted',
    final_stage_classification: 'running',
    prompt_sha256: metadata.prompt_sha256 || null,
    readiness_inventory_sha256: metadata.readiness_inventory_sha256 || run.readiness_inventory_sha256 || null,
    runtime_inventory_sha256: metadata.runtime_inventory_sha256 || run.runtime_inventory_sha256 || null,
    terra_input_packet_sha256: metadata.terra_input_packet_sha256 || run.terra_input_packet_sha256 || null,
    frozen_evidence_packet_sha256: metadata.frozen_evidence_packet_sha256 || run.frozen_evidence_packet_sha256 || null,
    draft_input_sha256: metadata.draft_input_sha256 || run.draft_input_sha256 || null,
    revision_input_sha256: metadata.revision_input_sha256 || run.revision_input_sha256 || null,
    retention_status: 'memory_pending',
    validation_errors: [],
    error: null
  };
  state.phase2_attempts.push(record);
  run.attempts ||= [];
  run.attempts.push(record);
  run.events.push({ type: 'stage_started', stage, attempt, at: record.started_at });
  return { attempt: record, reused: false };
}

export function markProviderCallStarted(state, run, stage, { provider = 'codex', model = null } = {}) {
  const attempt = currentAttempt(state, run, stage);
  if (!attempt) throw new Error(`No running Phase 2 ${stage} attempt exists.`);
  if (attempt.provider_call_started) {
    const error = new Error(`Provider call already started for ${stage} attempt ${attempt.attempt}.`);
    error.code = 'PHASE2_DUPLICATE_PROVIDER_CALL';
    throw error;
  }
  run.provider_calls ||= [];
  const call = {
    id: crypto.randomUUID(),
    stage,
    attempt: attempt.attempt,
    provider,
    model,
    started_at: now()
  };
  attempt.provider_call_started = true;
  attempt.provider_call_id = call.id;
  attempt.provider_started_at = call.started_at;
  run.provider_calls.push(call);
  run.provider_call_count = run.provider_calls.length;
  run.events.push({ type: 'provider_call_started', ...call });
  return call;
}

export function recordStageResponse(state, run, stage, { response = null, usage = null } = {}) {
  const attempt = currentAttempt(state, run, stage);
  if (!attempt) throw new Error(`No running Phase 2 ${stage} attempt exists.`);
  const transport = response?.metrics?.adapter_transport || {};
  attempt.response_received_at = now();
  attempt.raw_response = typeof response?.raw === 'string' ? response.raw : null;
  attempt.raw_provider_events = redactValue(transport.raw_stdout || response?.raw_provider_events || response?.events || null);
  attempt.provider_stderr = redactText(transport.raw_stderr || response?.stderr || '');
  attempt.provider_exit_status = transport.exit_code ?? response?.exit_code ?? null;
  attempt.adapter_diagnostics = redactValue(response?.metrics || null);
  attempt.provider_request_id = response?.request_id || response?.metrics?.request_id || transport.request_id || null;
  attempt.usage = usage || null;
  attempt.adapter_outcome = 'completed';
  attempt.final_stage_classification = 'provider_completed_pending_validation';
  attempt.runtime_ms = usage?.wall_ms ?? response?.metrics?.wall_ms ?? Math.max(0, Date.parse(attempt.response_received_at) - Date.parse(attempt.started_at));
  addUsage(run, usage);
  return attempt;
}

export function recordStageParse(state, run, stage, outcome) {
  const attempt = currentAttempt(state, run, stage) || [...state.phase2_attempts].reverse().find(item => caseRunIdFor(item) === caseRunIdFor(run) && item.stage === stage);
  if (attempt) attempt.parse_outcome = outcome;
  return attempt;
}

export function recordStageSchema(state, run, stage, outcome, errors = []) {
  const attempt = currentAttempt(state, run, stage) || [...state.phase2_attempts].reverse().find(item => caseRunIdFor(item) === caseRunIdFor(run) && item.stage === stage);
  if (attempt) {
    attempt.schema_outcome = outcome;
    attempt.validation_errors = Array.isArray(errors) ? [...errors] : [];
  }
  return attempt;
}

export function completeStage(state, run, stage, payload, { rawResponse = null, usage = null } = {}) {
  const attempt = currentAttempt(state, run, stage);
  if (!attempt) throw new Error(`No running Phase 2 ${stage} attempt exists.`);
  attempt.status = 'complete';
  attempt.finished_at = now();
  if (rawResponse !== null) attempt.raw_response = rawResponse;
  if (usage) {
    attempt.usage ||= usage;
    addUsage(run, usage);
  }
  attempt.adapter_outcome = attempt.adapter_outcome === 'not_started' ? 'not_applicable' : attempt.adapter_outcome;
  attempt.final_stage_classification = 'completed';
  attempt.retention_status = 'memory_retained';
  const artifact = { id: crypto.randomUUID(), holdout_run_id: run.holdout_run_id || null, case_run_id: run.case_run_id || run.id, candidate_id: run.candidate_id, pipeline_version: PHASE2_VERSION, terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION, stage, status: 'complete', created_at: attempt.finished_at, payload };
  state.phase2_artifacts.push(artifact);
  run.stage_results[stage] = artifact.id;
  run.events.push({ type: 'stage_completed', stage, attempt: attempt.attempt, artifact_id: artifact.id, at: attempt.finished_at });
  return artifact;
}

export function failStage(state, run, stage, error, { rawResponse = null, usage = null } = {}) {
  const attempt = currentAttempt(state, run, stage);
  if (attempt) {
    attempt.status = 'failed';
    attempt.finished_at = now();
    if (rawResponse !== null) attempt.raw_response = rawResponse;
    if (usage) {
      attempt.usage ||= usage;
      addUsage(run, usage);
    }
    if (attempt.adapter_outcome === 'not_started') attempt.adapter_outcome = 'failed';
    if (error?.code === 'PHASE2_INVALID_JSON' || error?.code === 'PHASE2_EMPTY_RESPONSE') attempt.parse_outcome = 'invalid';
    if (error?.code === 'PHASE1_SCHEMA_INVALID' || error?.code === 'PHASE2_SCHEMA_INVALID') attempt.schema_outcome = 'invalid';
    attempt.validation_errors = [...new Set([...(attempt.validation_errors || []), ...(error?.details?.errors || []), error?.message].filter(Boolean))];
    attempt.final_stage_classification = error?.code === 'EVIDENCE_PACKET_LIMIT_EXCEEDED' || error?.classification === 'evidence_input_limit_exceeded'
      ? 'evidence_input_limit_exceeded'
      : error?.code === 'PHASE1_SCHEMA_INVALID' || error?.code === 'PHASE2_SCHEMA_INVALID'
      ? 'schema_validation_failed'
      : error?.code === 'PHASE2_INVALID_JSON' || error?.code === 'PHASE2_EMPTY_RESPONSE'
        ? 'parse_failed'
        : error?.code === 'PHASE2_RESEARCH_BLOCKED'
          ? 'research_validation_blocked'
        : 'adapter_failed';
    attempt.retention_status = attempt.raw_response || attempt.raw_provider_events ? 'memory_retained' : 'not_available';
    attempt.runtime_ms ||= Math.max(0, Date.parse(attempt.finished_at) - Date.parse(attempt.started_at));
    attempt.error = { code: error?.code || 'PHASE2_STAGE_FAILED', message: error?.message || String(error) };
  }
  run.events.push({ type: 'stage_failed', stage, code: error?.code || 'PHASE2_STAGE_FAILED', at: now() });
}

export function phase2TerminalInvariant({ state, run, candidate = null } = {}) {
  const errors = [];
  if (!run) errors.push('Phase 2 run is missing.');
  else {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) errors.push(`Run status is nonterminal: ${run.status || 'missing'}.`);
    if (!run.finished_at) errors.push('Run finished_at is missing.');
    const attempts = (state?.phase2_attempts || []).filter(item => caseRunIdFor(item) === caseRunIdFor(run));
    for (const attempt of attempts) {
      if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) errors.push(`Attempt ${attempt.id || attempt.stage} is nonterminal: ${attempt.status || 'missing'}.`);
      if (!attempt.finished_at) errors.push(`Attempt ${attempt.id || attempt.stage} finished_at is missing.`);
    }
    const providerAttempts = attempts.filter(item => item.provider_call_started === true);
    const providerCalls = Array.isArray(run.provider_calls) ? run.provider_calls : [];
    const providerCount = Number(run.provider_call_count || 0);
    if (providerCount !== providerCalls.length) errors.push(`Provider call count ${providerCount} does not match canonical provider call records ${providerCalls.length}.`);
    if (providerCount !== providerAttempts.length) errors.push(`Provider call count ${providerCount} does not match started provider attempts ${providerAttempts.length}.`);
    const callIds = new Set(providerCalls.map(call => call.id).filter(Boolean));
    for (const attempt of providerAttempts) if (!attempt.provider_call_id || !callIds.has(attempt.provider_call_id)) errors.push(`Provider attempt ${attempt.id || attempt.stage} is missing its canonical provider call record.`);
  }
  if (candidate && ['running', 'researching', 'preparing_evidence', 'commissioned', 'drafting', 'revising'].includes(candidate.phase2_state)) errors.push(`Candidate phase2_state is nonterminal: ${candidate.phase2_state}.`);
  return { ok: errors.length === 0, errors };
}
