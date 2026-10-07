import { TERRA_EVIDENCE_CONTRACT_VERSION } from './phase1-schemas.mjs';
import { PHASE2_INVENTORY_CONTRACT_VERSION } from './phase2-inventory.mjs';
import { PHASE2_VERSION, caseRunIdFor, ensurePhase2State } from './phase2-state.mjs';

export function phase2CostRecord({ usage = [], cost = null } = {}) {
  const credits = usage.length ? usage.reduce((total, item) => total + (Number.isFinite(item?.credits) ? item.credits : 0), 0) : null;
  const estimatedCostUsd = cost && typeof cost === 'object' ? cost.estimated_cost_usd ?? null : Number.isFinite(cost) && cost !== 0 ? cost : null;
  return { credits, estimated_cost_usd: estimatedCostUsd };
}

export function phase2PersistencePayload({ run, stage, packet = null, draft = null, revision = null, review = null, claims = [], blockers = [], contradictions = [], usage = [], cost = null, materialization = null } = {}) {
  return {
    pipeline_version: PHASE2_VERSION,
    terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION,
    phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION,
    holdout_run_id: run.holdout_run_id || null,
    case_run_id: caseRunIdFor(run),
    stage,
    packet_version: packet?.version || null,
    readiness_inventory_sha256: run.readiness_inventory_sha256 || null,
    runtime_inventory_sha256: run.runtime_inventory_sha256 || null,
    terra_input_packet_sha256: run.terra_input_packet_sha256 || null,
    frozen_evidence_packet_sha256: packet?.frozen_evidence_packet_sha256 || run.frozen_evidence_packet_sha256 || null,
    draft_input_sha256: run.draft_input_sha256 || null,
    revision_input_sha256: run.revision_input_sha256 || null,
    research_requirement: run.research_requirement || null,
    research_requirement_reason: run.research_requirement_reason || null,
    assignment_checksum: run.assignment_sha256 || null,
    evidence_preflight: run.evidence_preflight || null,
    evidence_packet: packet || null,
    claims,
    source_support: claims.map(claim => ({ claim_id: claim.claim_id, source_ids: claim.source_ids || [], evidence: claim.evidence || [] })),
    blockers,
    contradictions,
    draft_constraints: packet?.draft_constraints || run.error?.draft_constraints || [],
    draft: draft ? { headline: draft.headline, dek: draft.dek, body_markdown: draft.body_markdown, claim_support: draft.claim_support || [], warnings: draft.warnings || [], draft_input_sha256: run.draft_input_sha256 || null } : null,
    revision: revision ? { changed_claim_ids: revision.changed_claim_ids || [], revision_notes: revision.revision_notes || [], body_markdown: revision.body_markdown, claim_support: revision.claim_support || [], warnings: revision.warnings || [], revision_input_sha256: run.revision_input_sha256 || null } : null,
    review: review ? { status: review.status, terra_summary: review.terra_summary || null, contradictions: review.terra_summary?.contradictions || contradictions, deterministic_review: review.deterministic_review, revision_findings: review.revision_findings || null, revision_changes: { changed_claim_ids: revision?.changed_claim_ids || [], revision_notes: revision?.revision_notes || [] }, diff: review.diff || [], source_links: review.source_links || [], materialization_revision: review.package_materialization_revision || materialization || null } : null,
    usage,
    cost: phase2CostRecord({ usage, cost }),
    candidate_id: run.candidate_id,
    run_status: run.status,
    run_state: run.state,
    classification: run.error?.classification || null,
    provider_call_count: run.provider_call_count || 0,
    provider_calls: run.provider_calls || [],
    retry_count: run.retry_count || 0,
    run_events: run.events || [],
    source_fetches: run.source_fetches || [],
    source_searches: run.source_searches || [],
    source_acquisition: run.source_acquisition || null,
    source_gate: run.source_gate || null,
    phase2_attempts: run.attempts || [],
    package_materialization_revision: materialization || review?.package_materialization_revision || null
  };
}

export async function persistPhase2Stage({ state, run, stage, payload, claims = [], usage = [], cost = null, persistence = null, force = false } = {}) {
  ensurePhase2State(state);
  state.phase2_persistence ||= [];
  const existing = state.phase2_persistence.find(item => item.case_run_id === caseRunIdFor(run) && item.stage === stage);
  if (existing && !force) return { ...existing, reused: true };
  const record = { holdout_run_id: run.holdout_run_id || null, case_run_id: caseRunIdFor(run), candidate_id: run.candidate_id, pipeline_version: PHASE2_VERSION, terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION, stage, readiness_inventory_sha256: payload.readiness_inventory_sha256 || null, runtime_inventory_sha256: payload.runtime_inventory_sha256 || null, terra_input_packet_sha256: payload.terra_input_packet_sha256 || null, frozen_evidence_packet_sha256: payload.frozen_evidence_packet_sha256 || null, draft_input_sha256: payload.draft_input_sha256 || null, revision_input_sha256: payload.revision_input_sha256 || null, payload, claims, usage, cost: phase2CostRecord({ usage, cost }), persisted_at: new Date().toISOString() };
  if (persistence?.persistStage) {
    try {
      await persistence.persistStage(record);
      for (const attempt of run.attempts || []) if (attempt.stage === stage && attempt.retention_status === 'memory_retained') attempt.retention_status = 'persisted';
    } catch (error) {
      for (const attempt of run.attempts || []) {
        if (attempt.stage !== stage || attempt.retention_status === 'not_available') continue;
        attempt.retention_status = 'state_retained_persistence_failed';
        attempt.retention_error = { code: error.code || 'PHASE2_PERSISTENCE_FAILED', message: error.message };
      }
      throw error;
    }
  } else {
    for (const attempt of run.attempts || []) if (attempt.stage === stage && attempt.retention_status === 'memory_retained') attempt.retention_status = 'state_retained';
  }
  if (existing) Object.assign(existing, record);
  else state.phase2_persistence.push(record);
  return record;
}

export function createSupabasePhase2Persistence({ client } = {}) {
  if (!client?.rpc) throw new Error('A Supabase client with rpc() is required for Phase 2 persistence.');
  return {
    async persistStage(record) {
      const { data, error } = await client.rpc('persist_pipeline_phase2_stage_v3', {
        p_candidate_external_id: record.candidate_id,
        p_pipeline_run_id: record.case_run_id,
        p_pipeline_version: record.pipeline_version,
        p_terra_evidence_contract_version: record.terra_evidence_contract_version,
        p_phase2_inventory_contract_version: record.phase2_inventory_contract_version,
        p_stage: record.stage,
        p_holdout_run_id: record.holdout_run_id,
        p_case_run_id: record.case_run_id,
        p_readiness_inventory_sha256: record.readiness_inventory_sha256,
        p_runtime_inventory_sha256: record.runtime_inventory_sha256,
        p_terra_input_packet_sha256: record.terra_input_packet_sha256,
        p_frozen_evidence_packet_sha256: record.frozen_evidence_packet_sha256,
        p_draft_input_sha256: record.draft_input_sha256,
        p_revision_input_sha256: record.revision_input_sha256,
        p_payload: record.payload,
        p_claims: record.claims,
        p_usage: record.usage,
        p_cost: record.cost
      });
      if (error) {
        const failure = new Error(`Phase 2 persistence failed: ${error.message}`);
        failure.code = 'PHASE2_PERSISTENCE_FAILED';
        failure.cause = error;
        throw failure;
      }
      return data;
    }
  };
}
