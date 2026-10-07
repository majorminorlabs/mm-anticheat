import crypto from 'node:crypto';
import { assertPhase1Schema } from './phase1-schemas.mjs';
import { deterministicReview } from './deterministic-review.mjs';
import { validateReviewPackage } from './integrity.mjs';
import { parseArticleMarkdown } from './article-markdown.mjs';
import { bindFrozenPacketDocuments, frozenPacketSourceLinks } from './frozen-document-binder.mjs';
import { validateLunaEvidenceReferences } from './phase2-orchestrator.mjs';
import { PHASE2_VERSION, caseRunIdFor } from './phase2-state.mjs';
import { TERRA_EVIDENCE_CONTRACT_VERSION } from './phase1-schemas.mjs';
import { PHASE2_INVENTORY_CONTRACT_VERSION } from './phase2-inventory.mjs';
import { STORY_FORM_BY_ID } from '../editorial.mjs';

const now = () => new Date().toISOString();

export const OFFLINE_PACKAGE_MATERIALIZATION_VERSION = 'pipeline-v1-ai-review-url-preservation-v1';

export function materializeOfflineReview({ candidate, run, packet, draft, retainedDocuments = [], existingDraftReview = null, previousFailure = null } = {}) {
  const draftCopy = structuredClone(draft);
  // Persistence wraps the raw model output with its input checksum. The
  // checksum is retained on the run, but is not part of Luna's output schema.
  delete draftCopy.draft_input_sha256;
  assertPhase1Schema('luna_draft', draftCopy);
  validateLunaEvidenceReferences(draftCopy, packet, candidate, 'Stored Luna draft');
  const bound = bindFrozenPacketDocuments({ candidate, run, packet, retainedDocuments, requireContent: true });
  const form = candidate.commission?.story_form || candidate.classification?.story_form || 'meanwhile';
  const draftReview = existingDraftReview || deterministicReview({ candidate, draft: draftCopy, packet, form: STORY_FORM_BY_ID[form] || STORY_FORM_BY_ID.meanwhile });
  const article = parseArticleMarkdown(draftCopy.body_markdown, candidate);
  const claims = (draftCopy.claims || []).map(claim => ({
    ...claim,
    holdout_run_id: run.holdout_run_id || null,
    case_run_id: caseRunIdFor(run),
    candidate_id: candidate.id,
    processing_run_id: run.id,
    status: draftReview.blocking_factual_errors?.length ? 'needs_review' : 'supported',
    note: claim.qualification_note || ''
  }));
  const finalReview = draftReview;
  const materialization = {
    version: OFFLINE_PACKAGE_MATERIALIZATION_VERSION,
    materialized_at: now(),
    linked_job_id: run.commission_job_id || null,
    linked_pipeline_run_id: run.id,
    previous_failure: previousFailure || null,
    source_binding: 'frozen_packet_url_authoritative',
    provider_calls_added: 0
  };
  const review = {
    id: crypto.randomUUID(),
    holdout_run_id: run.holdout_run_id || null,
    case_run_id: caseRunIdFor(run),
    candidate_id: candidate.id,
    processing_run_id: run.id,
    pipeline_version: PHASE2_VERSION,
    terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION,
    phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION,
    packet_version: packet.version,
    readiness_inventory_sha256: run.readiness_inventory_sha256 || null,
    runtime_inventory_sha256: run.runtime_inventory_sha256 || null,
    terra_input_packet_sha256: run.terra_input_packet_sha256 || null,
    frozen_evidence_packet_sha256: packet.frozen_evidence_packet_sha256,
    draft_input_sha256: run.draft_input_sha256 || draftCopy.draft_input_sha256 || null,
    document_ids: bound.documents.map(document => document.id),
    status: finalReview.blocking_factual_errors?.length ? 'blocked' : 'ready_for_review',
    created_at: now(),
    model: 'gpt-5.6-luna',
    prompt_version: 'pipeline-v1-luna-draft-deterministic-review-v1',
    headline: draftCopy.headline || article.headline,
    dek: draftCopy.dek || article.dek,
    article: draftCopy.body_markdown,
    previous_draft: null,
    section: draftCopy.section || candidate.commission?.section_id || candidate.classification?.primary_section,
    lens: draftCopy.lens || candidate.classification?.editorial_pitch?.lens || candidate.commission?.brief || candidate.title,
    beats: draftCopy.beats || candidate.commission?.beats || candidate.classification?.recurring_beats || [],
    source_ids: draftCopy.source_ids || [],
    classification: { ...(candidate.classification || {}), phase2_state: 'ai_review_ready', pipeline_version: PHASE2_VERSION, frozen_evidence_packet_sha256: packet.frozen_evidence_packet_sha256 },
    research: { pipeline_version: PHASE2_VERSION, terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION, packet, research_requirement: run.research_requirement, blockers: [], draft_constraints: packet.draft_constraints || [], frozen: true },
    evidence_packet: packet,
    terra_summary: { selected_source_ids: packet.sources.map(source => source.source_id), optional_source_ids: [], excluded_sources: packet.excluded_sources || [], contradictions: packet.terra_summary?.contradictions || [], freshness_risks: packet.terra_summary?.freshness_risks || [], missing_evidence: packet.terra_summary?.missing_evidence || [], blockers: [], draft_constraints: packet.draft_constraints || [] },
    draft: draftCopy,
    revision: null,
    claim_support: draftCopy.claim_support || [],
    cited_evidence_ids: [...new Set((draftCopy.claim_support || []).flatMap(mapping => mapping.evidence_ids || []))],
    deterministic_review: finalReview,
    draft_findings: draftReview,
    revision_findings: null,
    diff: [],
    claims,
    unresolved_claims: finalReview.blocking_factual_errors.map(message => ({ claim: message, status: 'needs_review' })),
    images: [],
    model_usage: run.model_usage || [],
    estimated_cost_usd: run.estimated_cost_usd ?? null,
    source_links: frozenPacketSourceLinks(packet, bound.documents),
    package_materialization_revision: materialization,
    logs: {},
    validation_history: { draft: draftReview }
  };
  const integrity = validateReviewPackage({ candidate, run, documents: bound.documents, review });
  if (!integrity.ok) {
    const error = new Error(integrity.errors.join('; '));
    error.code = 'REVIEW_PACKAGE_INTEGRITY_FAILED';
    error.details = integrity;
    throw error;
  }
  return { review, documents: bound.documents, source_links: review.source_links, materialization, draftReview };
}
