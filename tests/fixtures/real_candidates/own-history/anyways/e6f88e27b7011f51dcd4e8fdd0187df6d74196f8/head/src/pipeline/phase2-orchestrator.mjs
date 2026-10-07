import crypto from 'node:crypto';
import { fetchDocument, normalizeUrl } from './acquisition.mjs';
import { sourceRetention, validateReviewPackage } from './integrity.mjs';
import { buildEvidencePacket, preflightEvidencePacket, stableJson, EVIDENCE_PACKET_LIMITS } from './evidence-packet.mjs';
import { assertPhase1Schema } from './phase1-schemas.mjs';
import { TERRA_EVIDENCE_CONTRACT_VERSION, validateTerraEvidenceOffsets } from './phase2-evidence.mjs';
import { createProductionCodexAdapter } from './codex-adapter.mjs';
import { calculateCodexUsage } from './cost.mjs';
import { PRODUCTION_MODELS, RESEARCH_CONFIG } from './config.mjs';
import { STORY_FORM_BY_ID } from '../editorial.mjs';
import { parseArticleMarkdown } from './article-markdown.mjs';
import { transition } from './state.mjs';
import { deterministicReview } from './deterministic-review.mjs';
import { lunaDraftPrompt, lunaRevisionPrompt, parseStrictJson, terraPrompt } from './phase2-prompts.mjs';
import { PHASE2_VERSION, beginStage, caseRunIdFor, completeStage, createPhase2Run, ensurePhase2State, failStage, holdoutRunIdFor, markProviderCallStarted, phase2RunFor, phase2TerminalInvariant, recordStageParse, recordStageResponse, recordStageSchema, stageArtifact, transitionPhase2 } from './phase2-state.mjs';
import { phase2PersistencePayload, persistPhase2Stage } from './phase2-persistence.mjs';
import { PHASE2_SOURCE_REQUIREMENTS, sourceGateBlockers, sourceSufficiencyGate } from './phase2-source-gate.mjs';
import { PHASE2_INVENTORY_CONTRACT_VERSION, assertInventoryChecksum, hashPhase2Inventory } from './phase2-inventory.mjs';
import { deterministicClaimSupportContract } from './luna-support.mjs';
import { isLunaTreatment } from './luna-claim-contract.mjs';
import { ResearchRouter } from './research-router.mjs';
import { deriveResearchDecision } from './research-decision.mjs';
import { bindFrozenPacketDocuments } from './frozen-document-binder.mjs';

export const PHASE2_RETRIEVAL_LIMITS = Object.freeze({ maxSources: 12, maxSearchQueries: 3, sourceChars: 5_000, maxTotalExcerptCharacters: 48_000 });

const now = () => new Date().toISOString();
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const unique = values => [...new Set(values.filter(Boolean))];
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const formFor = candidate => STORY_FORM_BY_ID[candidate.commission?.story_form || candidate.classification?.story_form] || STORY_FORM_BY_ID.meanwhile;
const researchDecisionFor = candidate => deriveResearchDecision(candidate);
const researchRequirementFor = candidate => researchDecisionFor(candidate).research_requirement;

function deterministicRetainedClaims(candidate, documents) {
  const plan = candidate?.commission?.evidence_plan || candidate?.classification?.editorial_pitch?.evidence_plan || [];
  return documents.map((document, index) => {
    const claimId = `claim-retained-${String(index + 1).padStart(3, '0')}`;
    const excerpt = String(document.content || '').slice(0, 2_000);
    return {
      claim_id: claimId,
      claim: clean(plan[index] || `The approved retained source supports the commissioned angle: ${document.title || candidate.title}.`),
      source_ids: [document.id],
      evidence: excerpt ? [{ source_id: document.id, start_offset: 0, end_offset: excerpt.length, claim_ids: [claimId], evidence_role: 'must_use', reason: 'Deterministic retained-source evidence.' , excerpt }] : [],
      confidence: 'medium',
      qualification_note: 'Deterministic claim ledger from the editor-approved retained source set.'
    };
  }).filter(item => item.evidence.length);
}
const assignmentQuestions = candidate => [
  `What happened in ${candidate.title || 'this story'}?`,
  `What evidence proves the commissioned angle for ${candidate.commission?.section_id || candidate.classification?.primary_section || 'the assigned section'}?`,
  'What remains uncertain or requires qualification?'
];

function terraInputPacket({ candidate, inventory, researchQuestions = [] } = {}) {
  return {
    terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION,
    phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION,
    candidate_id: candidate?.id || null,
    assignment: {
      title: candidate?.title || null,
      brief: candidate?.commission?.brief || candidate?.description || null,
      section_id: candidate?.commission?.section_id || candidate?.classification?.primary_section || null,
      story_form: candidate?.commission?.story_form || candidate?.classification?.story_form || null,
      beats: candidate?.commission?.beats || candidate?.classification?.recurring_beats || []
    },
    research_questions: researchQuestions,
    source_inventory: inventory
  };
}

function phase2Error(message, code = 'PHASE2_FAILED', details = null) {
  const error = new Error(message); error.code = code; if (details) error.details = details; return error;
}

function approvedSnapshotFor(source) {
  const candidates = [
    source?.approved_snapshot,
    source?.approvedSnapshot,
    source?.approved_archived_document,
    source?.approvedArchivedDocument,
    source?.archived_document,
    source?.archivedDocument,
    source?.retained_primary_document,
    source?.retainedPrimaryDocument
  ];
  for (const snapshot of candidates) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    if (snapshot.approved !== true && snapshot.retained !== true) continue;
    const text = String(snapshot.text ?? snapshot.content ?? snapshot.extracted_text ?? '');
    if (text) return { ...snapshot, text };
  }
  return null;
}

function researchBlockerForError(error) {
  return {
    blocker_id: `research-failure-${hash(error?.code || error?.message || 'unknown').slice(0, 12)}`,
    question: 'Can the research stage produce a valid evidence result?',
    reason: error?.message || String(error),
    required_action: 'Review the retained attempt diagnostics and authorize a new research attempt only after the cause is addressed.'
  };
}

function assertPhase2Fields(value, fields, stage) {
  const missing = fields.filter(field => !(field in value));
  if (missing.length) throw phase2Error(`${stage} omitted required Phase 2 fields: ${missing.join(', ')}`, 'PHASE2_SCHEMA_INVALID', { stage, missing });
}

function usageFor(response, model, stage, attempt) {
  if (response?.metrics?.model_usage) return { ...response.metrics.model_usage, stage, attempt };
  return calculateCodexUsage({ model, reasoning: 'high', stage, attempt, usage: response?.usage || {}, wallMs: response?.metrics?.wall_ms || 0 });
}

function evidencePacketSha256(packet) {
  const { checksum: _checksum, frozen_evidence_packet_sha256: _frozenChecksum, ...payload } = packet;
  return hash(stableJson(payload));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function freezePacket(packet, terraSummary = null, terraUsage = null, terraCost = null) {
  const { checksum: _legacyChecksum, ...packetWithoutGenericChecksum } = packet;
  const frozen = { ...packetWithoutGenericChecksum, version: 'pipeline-v1-evidence-packet-offsets-v1', terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION, terra_summary: terraSummary, terra_usage: terraUsage, terra_cost: terraCost };
  frozen.frozen_evidence_packet_sha256 = evidencePacketSha256(frozen);
  return deepFreeze(frozen);
}

function sourceRecords(candidate, docs) {
  return docs.map(document => ({
    id: document.id,
    source_id: document.id,
    requested_url: document.requested_url || document.url,
    classification: document.source_type,
    source_type: document.source_type,
    text: document.content,
    title: document.title,
    publisher: document.publisher,
    independence_key: document.independence_key,
    primary_source: document.primary_source,
    accessible: document.accessible !== false,
    ok: document.ok !== false,
    url: document.url,
    canonical_url: document.canonical_url,
    published_at: document.published_at,
    author: document.author,
    raw_sha256: document.raw_sha256,
    retained_text_sha256: document.retained_text_sha256,
    retained_from_full_text_sha256: document.retained_from_full_text_sha256,
    retrieval_diagnostics: document.retrieval_diagnostics,
    capture_mode: document.capture_mode,
    record: document
  }));
}

function derivedClaimsFromSupport(packet, support) {
  const evidenceById = new Map((packet.claims || []).flatMap(claim => (claim.evidence || []).map(evidence => [evidence.evidence_id, evidence])));
  const claimsById = new Map((packet.claims || []).map(claim => [claim.claim_id, claim]));
  return support.map(mapping => {
    const packetClaim = claimsById.get(mapping.claim_id);
    const evidence = mapping.evidence_ids.map(id => evidenceById.get(id));
    return {
      claim_id: packetClaim.claim_id,
      claim: packetClaim.claim,
      source_ids: [...new Set(evidence.map(item => item.source_id))],
      evidence,
      evidence_ids: [...mapping.evidence_ids],
      treatment: mapping.treatment,
      article_anchor: mapping.article_anchor,
      confidence: packetClaim.confidence || 'high',
      qualification_note: packetClaim.qualification_note || ''
    };
  });
}

export function validateLunaEvidenceReferences(output, packet, candidate, stage = 'Luna output') {
  const validSources = new Set((packet.sources || []).map(source => source.source_id));
  const evidenceById = new Map((packet.claims || []).flatMap(claim => (claim.evidence || []).map(evidence => [evidence.evidence_id, evidence])));
  const validClaims = new Set((packet.claims || []).map(claim => claim.claim_id));
  const requiredClaims = unique(packet.claim_targets?.length ? packet.claim_targets : (packet.claims || []).map(claim => claim.claim_id));
  const supportContract = deterministicClaimSupportContract(packet);
  const mappings = output.claim_support || [];
  const seenClaims = new Map();
  const seenMappings = new Set();
  for (const mapping of mappings) {
    if (!validClaims.has(mapping.claim_id)) throw phase2Error(`${stage} selected unknown claim ID: ${mapping.claim_id}.`, 'PHASE2_SCHEMA_INVALID');
    const mappingKey = stableJson({ claim_id: mapping.claim_id, evidence_ids: [...(mapping.evidence_ids || [])].sort(), article_anchor: mapping.article_anchor, treatment: mapping.treatment });
    if (seenMappings.has(mappingKey)) throw phase2Error(`${stage} repeated an identical claim-support mapping for ${mapping.claim_id} at ${mapping.article_anchor}.`, 'PHASE2_SCHEMA_INVALID');
    seenMappings.add(mappingKey);
    if (seenClaims.has(mapping.claim_id) && seenClaims.get(mapping.claim_id) !== mapping.treatment) throw phase2Error(`${stage} contains contradictory treatment for ${mapping.claim_id}.`, 'PHASE2_SCHEMA_INVALID');
    seenClaims.set(mapping.claim_id, mapping.treatment);
    if (!isLunaTreatment(mapping.treatment)) throw phase2Error(`${stage} uses an invalid treatment for ${mapping.claim_id}.`, 'PHASE2_SCHEMA_INVALID');
    const contract = supportContract[mapping.claim_id];
    if (!contract || mapping.treatment !== contract.required_treatment) throw phase2Error(`${stage} uses treatment ${mapping.treatment} for ${mapping.claim_id}; the canonical treatment is ${contract?.required_treatment || '(none)'}.`, 'PHASE2_SCHEMA_INVALID');
    for (const evidenceId of mapping.evidence_ids || []) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        throw phase2Error(`${stage} selected unknown evidence ID: ${evidenceId} for claim ${mapping.claim_id}. Allowed evidence IDs: ${supportContract[mapping.claim_id]?.allowed_evidence_ids?.join(', ') || '(none)'}.`, 'PHASE2_SCHEMA_INVALID', {
          claim_id: mapping.claim_id,
          invalid_evidence_id: evidenceId,
          allowed_evidence_ids: supportContract[mapping.claim_id]?.allowed_evidence_ids || []
        });
      }
      if (!evidence.claim_ids?.includes(mapping.claim_id)) {
        throw phase2Error(`${stage} evidence ${evidenceId} does not support claim ${mapping.claim_id}. Allowed evidence IDs: ${supportContract[mapping.claim_id]?.allowed_evidence_ids?.join(', ') || '(none)'}.`, 'PHASE2_SCHEMA_INVALID', {
          claim_id: mapping.claim_id,
          invalid_evidence_id: evidenceId,
          allowed_evidence_ids: supportContract[mapping.claim_id]?.allowed_evidence_ids || []
        });
      }
      if (!validSources.has(evidence.source_id)) throw phase2Error(`${stage} evidence ${evidenceId} names an unknown source ID.`, 'PHASE2_SCHEMA_INVALID');
    }
  }
  const missing = requiredClaims.filter(claimId => !seenClaims.has(claimId));
  if (missing.length) throw phase2Error(`${stage} omitted required claim support: ${missing.join(', ')}.`, 'PHASE2_SCHEMA_INVALID', { missing_claim_ids: missing, support_contract: supportContract });
  const derivedSourceIds = unique(mappings.flatMap(mapping => mapping.evidence_ids.map(id => evidenceById.get(id)?.source_id)));
  if (output.source_ids && output.source_ids.some(sourceId => !validSources.has(sourceId))) throw phase2Error(`${stage} selected an unknown source ID.`, 'PHASE2_SCHEMA_INVALID');
  const expectedSection = candidate.commission?.section_id || candidate.classification?.primary_section;
  if (output.section && output.section !== expectedSection) throw phase2Error(`${stage} changed the commissioned primary section.`, 'PHASE2_SCHEMA_INVALID');
  Object.assign(output, {
    section: output.section || expectedSection,
    lens: output.lens || candidate.classification?.editorial_pitch?.lens || candidate.commission?.brief || candidate.title,
    beats: output.beats || candidate.commission?.beats || candidate.classification?.recurring_beats || [],
    source_ids: derivedSourceIds,
    claim_ids: mappings.map(mapping => mapping.claim_id),
    claims: derivedClaimsFromSupport(packet, mappings)
  });
  return output;
}

function validDraft(draft, packet, candidate) {
  assertPhase1Schema('luna_draft', draft);
  return validateLunaEvidenceReferences(draft, packet, candidate, 'Luna draft');
}

function validRevision(revision, draft, packet, candidate) {
  assertPhase1Schema('luna_revision', revision);
  return validateLunaEvidenceReferences(revision, packet, candidate, 'Luna revision');
}

function reviewClassification(candidate, form, review) {
  const classification = { ...(candidate.classification || {}), primary_section: review.section, story_form: form.id, delivery_mode: 'pipeline_v1', pipeline_version: PHASE2_VERSION, terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, phase2_state: 'ai_review_ready', frozen_evidence_packet_sha256: review.frozen_evidence_packet_sha256, estimated_cost_usd: review.estimated_cost_usd };
  classification.review_warnings = unique([...(review.deterministic_review?.required_editorial_fixes || []), ...(review.deterministic_review?.advisory_style_warnings || [])]);
  classification.revision_suggestions = [...(review.deterministic_review?.required_editorial_fixes || [])];
  return classification;
}

export class Phase2Orchestrator {
  constructor({ fetcher = fetchDocument, terraAdapter = null, draftAdapter = null, revisionAdapter = null, persistence = null, checkpoint = async () => {}, retrievalLimits = PHASE2_RETRIEVAL_LIMITS, researchRouter = null } = {}) {
    this.fetcher = fetcher;
    this.terraAdapter = terraAdapter;
    this.draftAdapter = draftAdapter;
    this.revisionAdapter = revisionAdapter;
    this.persistence = persistence;
    this.checkpoint = checkpoint;
    this.retrievalLimits = { ...PHASE2_RETRIEVAL_LIMITS, ...retrievalLimits };
    const testMode = process.argv.includes('--test') || process.env.NODE_ENV === 'test';
    this.researchRouter = researchRouter || new ResearchRouter({
      config: {
        ...RESEARCH_CONFIG,
        ...(testMode ? { browserSearchEnabled: false } : {}),
        maxSearchRequestsPerArticle: this.retrievalLimits.maxSearchQueries,
        maxSearchRequestsPerQuery: this.retrievalLimits.maxSearchQueries,
        maxSourcePagesPerArticle: this.retrievalLimits.maxSources
      }
    });
  }

  async checkpointState(state) { await this.checkpoint(state); }

  adapterFor(stage) {
    if (stage === 'research') return this.terraAdapter || createProductionCodexAdapter({ ...PRODUCTION_MODELS.terraHigh });
    return stage === 'draft' ? (this.draftAdapter || createProductionCodexAdapter({ ...PRODUCTION_MODELS.lunaHigh })) : (this.revisionAdapter || createProductionCodexAdapter({ ...PRODUCTION_MODELS.lunaHigh }));
  }

  async persistStageIfNeeded({ state, run, stage, payload, claims = [], blockers = [], usage = [], cost = null, force = false }) {
    if (!force && (state.phase2_persistence || []).some(item => item.case_run_id === caseRunIdFor(run) && item.stage === stage)) return;
    await persistPhase2Stage({ state, run, stage, payload, claims, blockers, usage, cost, persistence: this.persistence, force });
    await this.checkpointState(state);
  }

  async persistFailedStage({ state, run, stage, payload }) {
    try {
      await persistPhase2Stage({ state, run, stage, payload, persistence: this.persistence, force: true });
    } catch (error) {
      run.events.push({ type: 'stage_persistence_failed', stage, code: error.code || 'PHASE2_PERSISTENCE_FAILED', message: error.message, at: now() });
      await this.checkpointState(state);
    }
  }

  async finalizeUnexpectedFailure({ state, candidate, run, error, actor = 'pipeline_controller' }) {
    const preProviderLimit = error?.code === 'EVIDENCE_PACKET_LIMIT_EXCEEDED'
      || error?.classification === 'evidence_input_limit_exceeded';
    const classification = preProviderLimit ? 'evidence_input_limit_exceeded' : 'deterministic_integrity_failure';
    const terminalState = preProviderLimit ? 'research_blocked' : 'failed';
    const terminalStatus = preProviderLimit ? 'blocked' : 'failed';
    error.classification ||= classification;
    run.status = terminalStatus;
    run.state = terminalState;
    run.finished_at ||= now();
    run.provider_call_count ||= 0;
    run.retry_count ||= 0;
    if (error.details?.preflight) run.evidence_preflight = error.details.preflight;
    run.error = {
      code: error.code || 'PHASE2_DETERMINISTIC_FAILURE',
      message: error.message || String(error),
      classification,
      details: { stage: (run.attempts || []).find(item => item.status === 'running')?.stage || error.details?.stage || 'pre_provider', ...(error.details || {}) },
      blockers: [{
        blocker_id: `phase2-${classification}`,
        question: 'Can the evidence input be prepared within the configured deterministic limits?',
        reason: error.message || String(error),
        required_action: preProviderLimit
          ? 'Use a source-complete retained inventory that fits the configured evidence-input limits. Do not truncate retained source text or loosen validation.'
          : 'Review the retained deterministic diagnostics before authorizing another attempt.'
      }]
    };
    run.events.push({ type: 'run_terminalized', classification, stage: error.details?.stage || 'pre_provider', at: now() });
    for (const attempt of (run.attempts || []).filter(item => item.status === 'running')) {
      failStage(state, run, attempt.stage, error);
      await this.persistFailedStage({
        state,
        run,
        stage: attempt.stage,
        payload: phase2PersistencePayload({ run, stage: attempt.stage, blockers: run.error.blockers, usage: run.model_usage, cost: run.estimated_cost_usd })
      });
    }
    transitionPhase2(candidate, terminalState, actor, run.error.message);
    if (candidate.status !== terminalState) transition(candidate, terminalState, actor, run.error.message);
    try { await this.checkpointState(state); } catch (checkpointError) {
      run.events.push({ type: 'terminal_checkpoint_failed', code: checkpointError.code || 'PHASE2_CHECKPOINT_FAILED', message: checkpointError.message, at: now() });
    }
    return { candidate, run, error: run.error, review: null, ...(preProviderLimit ? { research_again_required: true } : {}) };
  }

  async process(args = {}) {
    const state = args.state;
    const candidateId = args.candidateId;
    const actor = args.actor || 'pipeline_controller';
    try {
      const result = await this.processInternal(args);
      const run = result?.run || (state && candidateId ? phase2RunFor(state, candidateId) : null);
      const candidate = result?.candidate || state?.candidates?.find(item => item.id === candidateId) || null;
      const invariant = run ? phase2TerminalInvariant({ state, run, candidate }) : { ok: true, errors: [] };
      if (!invariant.ok) {
        const integrityError = phase2Error(`Phase 2 terminal-state invariant failed: ${invariant.errors.join(' ')}`, 'PHASE2_INTEGRITY_INVARIANT', { invariant: invariant.errors });
        if (run && candidate) return this.finalizeUnexpectedFailure({ state, candidate, run, error: integrityError, actor });
        throw integrityError;
      }
      return result;
    } catch (error) {
      const candidate = state?.candidates?.find(item => item.id === candidateId) || null;
      const run = state && candidateId ? phase2RunFor(state, candidateId) : null;
      if (!run || !candidate) throw error;
      return this.finalizeUnexpectedFailure({ state, candidate, run, error, actor });
    }
  }

  async retrieveSources({ state, candidate, run }) {
    const requested = [
      ...(candidate.known_sources || []),
      ...(candidate.commission?.source_urls || []).map(url => ({ url, title: candidate.title, description: candidate.description || '' }))
    ];
    const seen = new Map(); const documents = []; const events = [];
    const mandatorySourceUrls = new Set([
      ...(Array.isArray(candidate.commission?.mandatory_source_urls) ? candidate.commission.mandatory_source_urls : []),
      ...(Array.isArray(candidate.commission?.required_source_urls) ? candidate.commission.required_source_urls : [])
    ].map(url => clean(url).toLowerCase()).filter(Boolean));
    run.source_fetches ||= [];
    const recordDiagnostic = diagnostic => {
      run.source_fetches.push(diagnostic);
      events.push({ type: 'source_fetch', ...diagnostic, at: now() });
    };
    for (const source of requested) {
      if (documents.length >= this.retrievalLimits.maxSources) break;
      if (!source?.url) continue;
      if (seen.has(source.url)) {
        recordDiagnostic({ url: source.url, source_id: null, ok: false, accessible: false, duplicate: true, duplicate_of: seen.get(source.url), status: null, error: 'duplicate_requested_source' });
        continue;
      }
      seen.set(source.url, source.id || source.url);
      let fetched = null;
      try {
        fetched = await this.fetcher(source.url);
      } catch (error) {
        fetched = { ok: false, status: error.status || error.statusCode || null, error: error.message || String(error), extraction_status: 'failed' };
      }
      const liveText = typeof fetched?.text === 'string' ? fetched.text : String(fetched?.text ?? '');
      const hasLiveText = liveText.trim().length > 0;
      const snapshot = (!fetched?.ok || !hasLiveText) ? approvedSnapshotFor(source) : null;
      const snapshotText = typeof snapshot?.text === 'string' ? snapshot.text : String(snapshot?.text ?? '');
      const hasSnapshotText = snapshotText.trim().length > 0;
      const content = hasLiveText ? liveText : hasSnapshotText ? snapshotText : '';
      const status = fetched?.status ?? fetched?.http_status ?? fetched?.statusCode ?? null;
      const accessMode = hasLiveText ? 'live_extracted_text' : hasSnapshotText ? 'approved_snapshot' : 'unavailable';
      const extractionStatus = hasLiveText ? 'extracted' : hasSnapshotText ? 'snapshot_extracted' : fetched?.extraction_status || (!fetched?.ok ? 'failed' : 'empty');
      const canonical = fetched?.canonical_url || snapshot?.canonical_url || source.url;
      const id = `source:${candidate.id}:${hash(canonical).slice(0, 24)}`;
      const baseDiagnostic = {
        source_id: id,
        url: source.url,
        canonical_url: canonical,
        ok: Boolean(fetched?.ok),
        accessible: Boolean(content),
        status,
        error: fetched?.error || (!content ? (extractionStatus === 'empty' ? 'empty_extracted_text' : 'source_inaccessible') : null),
        extraction_status: extractionStatus,
        access_mode: accessMode,
        snapshot_used: Boolean(snapshotText),
        source_classification: source.source_type || source.classification || snapshot?.source_type || null,
        mandatory: Boolean(source.mandatory === true || source.required === true || mandatorySourceUrls.has(clean(source.url).toLowerCase())),
        required_for_claim_ids: Array.isArray(source.required_for_claim_ids) ? source.required_for_claim_ids : []
      };
      recordDiagnostic(baseDiagnostic);
      if (!content) continue;
      const sourceType = snapshot?.source_type || source.source_type || source.classification || (/\.(gov|edu)(?:$|\/)/i.test(new URL(canonical).hostname) ? 'primary' : 'original_reporting');
      const document = {
        id,
        candidate_id: candidate.id,
        processing_run_id: run.id,
        discovery_id: source.id || null,
        url: canonical,
        canonical_url: canonical,
        title: source.title || snapshot?.title || candidate.title || '',
        description: source.description || snapshot?.description || '',
        author: source.author || snapshot?.author || null,
        published_at: source.published_at || snapshot?.published_at || null,
        content: content.slice(0, this.retrievalLimits.sourceChars),
        source_type: sourceType,
        independence_key: source.independence_key || snapshot?.independence_key || null,
        retrieval_timestamp: fetched?.fetched_at || snapshot?.captured_at || now(),
        provenance: {
          fetched_url: source.url,
          retrieval: hasSnapshotText ? 'approved_snapshot' : 'commission_source_only',
          ...(source.original_source_url || snapshot?.original_source_url ? { original_source_url: source.original_source_url || snapshot.original_source_url } : {}),
          ...(source.syndicated_from || snapshot?.syndicated_from ? { syndicated_from: source.syndicated_from || snapshot.syndicated_from } : {}),
          ...(hasSnapshotText ? { approved_snapshot_id: snapshot.id || null } : {})
        },
        extraction: hasSnapshotText ? { ...fetched, ok: true, text: snapshotText, source: 'approved_snapshot', live_fetch_ok: Boolean(fetched?.ok) } : fetched
      };
      document.retention = sourceRetention(candidate, document);
      if (document.retention.score <= 0) {
        const rejection = { source_id: id, url: source.url, canonical_url: canonical, ok: Boolean(fetched?.ok), accessible: false, status, error: `retention_rejected:${document.retention.reason}`, extraction_status: extractionStatus, access_mode: accessMode, snapshot_used: Boolean(snapshotText) };
        run.source_fetches[run.source_fetches.length - 1] = rejection;
        events.push({ type: 'source_rejected', source_id: id, reason: document.retention.reason, at: now() });
        continue;
      }
      documents.push(document);
    }
    // Commissioning starts with the pitch's seed URLs, then performs a bounded
    // search expansion before the deterministic source gate runs. Search and
    // fetch diagnostics remain separate from model-provider calls.
    run.source_searches ||= [];
    run.source_acquisition = {
      limits: { max_search_queries: this.retrievalLimits.maxSearchQueries, max_retained_sources: this.retrievalLimits.maxSources },
      started_at: run.source_acquisition?.started_at || now(),
      queries: run.source_searches,
      retained_seed_sources: documents.length,
      retained_search_sources: 0,
      inaccessible_sources: 0,
      completed_at: null
    };
    const requirements = PHASE2_SOURCE_REQUIREMENTS[formFor(candidate).id] || PHASE2_SOURCE_REQUIREMENTS.meanwhile;
    const knownCoverage = new Set(documents.map(document => document.independence_key || document.canonical_url || document.url).filter(Boolean));
    const needsExpansion = documents.length < requirements.minimumAccessibleSources || knownCoverage.size < requirements.minimumIndependentSources;
    let fetchedResearch = { pages: [], warnings: [] };
    if (needsExpansion) {
    const directResults = requested.filter(source => source?.url).map(source => ({
      title: source.title || candidate.title,
      url: source.url,
      snippet: source.description || '',
      provider: 'direct'
    }));
    const pitch = candidate.classification?.editorial_pitch || {};
    const queryTexts = unique([
      candidate.title,
      pitch.lens,
      ...(Array.isArray(pitch.evidence_plan) ? pitch.evidence_plan.slice(0, 2) : []),
      `${candidate.title} official record`
    ].map(clean)).slice(0, this.retrievalLimits.maxSearchQueries);
    const searched = [];
    for (const queryText of queryTexts) {
      if (documents.length >= this.retrievalLimits.maxSources) break;
      const searchResult = await this.researchRouter.search(
        { text: queryText, type: /official|record|data|filing/i.test(queryText) ? 'primary' : 'news', maxResults: this.retrievalLimits.maxSources },
        { storyId: candidate.id, runId: run.id, purpose: 'commission-source-acquisition', directResults }
      );
      run.source_searches.push({ query: searchResult.query, coverage: searchResult.coverage, warnings: searchResult.warnings, usage: searchResult.usage, at: now() });
      searched.push(...searchResult.results);
    }
    const unseenResults = searched.filter(result => {
      try { return !seen.has(normalizeUrl(result.url)); } catch { return false; }
    });
    fetchedResearch = await this.researchRouter.fetchPages(unseenResults, {
      runId: run.id,
      fetcher: this.fetcher,
      maxPages: Math.max(0, this.retrievalLimits.maxSources - documents.length)
    });
    const fetchedByUrl = new Map(fetchedResearch.pages.map(page => {
      try { return [normalizeUrl(page.canonical_url || page.url), page]; } catch { return [page.url, page]; }
    }));
    for (const result of unseenResults) {
      let normalized = null;
      try { normalized = normalizeUrl(result.url); } catch { continue; }
      const fetched = fetchedByUrl.get(normalized);
      const canonical = fetched?.canonical_url || fetched?.url || normalized;
      const content = String(fetched?.text || '');
      const sourceId = `source:${candidate.id}:${hash(canonical).slice(0, 24)}`;
      const diagnostic = {
        source_id: sourceId,
        url: result.url,
        canonical_url: canonical,
        ok: Boolean(fetched?.ok),
        accessible: Boolean(fetched?.ok && content.trim()),
        status: fetched?.status ?? null,
        error: fetched?.error || (fetched ? (!content.trim() ? 'empty_extracted_text' : null) : 'search_result_not_fetched'),
        extraction_status: fetched?.ok && content.trim() ? 'extracted' : 'failed',
        access_mode: fetched?.ok && content.trim() ? 'bounded_search_fetch' : 'unavailable',
        snapshot_used: false,
        source_classification: result.sourceType || null,
        acquisition: 'bounded_search',
        search_provider: result.provider || null,
        search_rank: result.rank || null,
        mandatory: false
      };
      run.source_fetches.push(diagnostic);
      run.events.push({ type: 'source_fetch', ...diagnostic, at: now() });
      if (!fetched?.ok || !content.trim() || documents.length >= this.retrievalLimits.maxSources) continue;
      if (seen.has(canonical)) continue;
      seen.set(canonical, sourceId);
      const sourceType = result.sourceType || (/\.(gov|edu)(?:$|\/)/i.test(new URL(canonical).hostname) ? 'primary' : 'original_reporting');
      const publisher = (() => { try { return new URL(canonical).hostname.replace(/^www\./, ''); } catch { return null; } })();
      const independenceKey = `content:${hash(content.replace(/\s+/g, ' ').trim().toLowerCase()).slice(0, 24)}`;
      const document = {
        id: sourceId,
        candidate_id: candidate.id,
        processing_run_id: run.id,
        discovery_id: null,
        url: canonical,
        canonical_url: canonical,
        title: fetched.title || result.title || candidate.title || '',
        publisher,
        description: result.snippet || '',
        author: fetched.author || null,
        published_at: fetched.published_at || result.publishedAt || null,
        content: content.slice(0, this.retrievalLimits.sourceChars),
        source_type: sourceType,
        independence_key: independenceKey,
        primary_source: sourceType === 'primary',
        accessible: true,
        ok: true,
        retrieval_timestamp: fetched.fetched_at || now(),
        provenance: { retrieval: 'bounded_search', fetched_url: result.url, search_provider: result.provider || null, search_query: run.source_searches.at(-1)?.query || null, independence_key: independenceKey },
        extraction: fetched
      };
      document.retention = sourceRetention(candidate, document);
      if (document.retention.score <= 0) {
        diagnostic.accessible = false;
        diagnostic.error = `retention_rejected:${document.retention.reason}`;
        continue;
      }
      documents.push(document);
      run.source_acquisition.retained_search_sources++;
    }
    }
    run.source_acquisition.inaccessible_sources = run.source_fetches.filter(item => item.accessible === false && item.acquisition === 'bounded_search').length;
    run.source_acquisition.search_warnings = fetchedResearch.warnings;
    run.source_acquisition.completed_at = now();
    run.events.push(...events);
    return documents;
  }

  frozenReadinessDocuments({ candidate, run, inventory, metadataOnly = false }) {
    if (metadataOnly) {
      const bound = bindFrozenPacketDocuments({ candidate, run, packet: { sources: inventory.sources || [] }, retainedDocuments: [], requireContent: false });
      run.events.push(...bound.documents.map(document => ({ type: 'frozen_source_bound', source_id: document.id, url: document.url, canonical_url: document.canonical_url, ok: true, accessible: true, access_mode: 'approved_frozen_readiness_inventory', snapshot_used: true, at: now() })));
      run.source_fetches.push(...bound.documents.map(document => ({ source_id: document.id, url: document.url, canonical_url: document.canonical_url, ok: true, accessible: true, error: null, extraction_status: 'frozen_retained_text', access_mode: 'approved_frozen_readiness_inventory', snapshot_used: true, source_classification: document.classification })));
      return bound.documents;
    }
    const documents = [];
    const events = [];
    for (const source of inventory.sources || []) {
      const content = String(source.text ?? source.retained_text ?? '');
      const accessible = metadataOnly
        ? source.accessible !== false && source.ok !== false
        : source.accessible !== false && source.ok !== false && Boolean(content.trim());
      const diagnostic = { source_id: source.source_id, url: source.requested_url || source.canonical_url, canonical_url: source.canonical_url || source.requested_url, ok: source.ok !== false, accessible, status: source.retrieval_diagnostics?.status ?? null, error: accessible ? null : 'frozen_source_inaccessible', extraction_status: accessible ? 'frozen_retained_text' : 'unavailable', access_mode: 'approved_frozen_readiness_inventory', snapshot_used: true, source_classification: source.source_type || source.classification || null };
      run.source_fetches.push(diagnostic); events.push({ type: 'frozen_source_bound', ...diagnostic, at: now() });
      if (!accessible) continue;
      const document = {
        id: source.source_id,
        candidate_id: candidate.id,
        processing_run_id: run.id,
        discovery_id: source.source_id,
        requested_url: source.requested_url || source.canonical_url,
        url: source.canonical_url || source.requested_url,
        canonical_url: source.canonical_url || source.requested_url,
        title: source.title || candidate.title || '',
        description: source.description || '',
        author: source.author || null,
        publisher: source.publisher || null,
        published_at: source.published_at || null,
        content,
        source_type: source.source_type || source.classification || 'original_reporting',
        classification: source.classification || source.source_type || null,
        independence_key: source.independence_key || null,
        primary_source: source.primary_source === true,
        accessible: true,
        ok: true,
        raw_sha256: source.raw_sha256 || null,
        retained_text_sha256: source.retained_text_sha256 || null,
        retained_from_full_text_sha256: source.retained_from_full_text_sha256 || null,
        retrieval_diagnostics: source.retrieval_diagnostics || null,
        capture_mode: source.capture_mode || 'frozen_readiness_inventory',
        retrieval_timestamp: source.retrieval_diagnostics?.captured_at || null,
        provenance: { retrieval: 'approved_frozen_readiness_inventory', source_id: source.source_id },
        extraction: { ok: true, text: content, source: 'approved_frozen_readiness_inventory' }
      };
      document.retention = metadataOnly
        ? { score: 1, reason: 'frozen_packet_source_identity' }
        : sourceRetention(candidate, document);
      if (metadataOnly || document.retention.score > 0) documents.push(document);
    }
    run.events.push(...events);
    return documents;
  }

  async processInternal({ state, candidateId, actor = 'pipeline_controller', commissionAuthorization = null, signal, revisionInstructions = '' } = {}) {
    ensurePhase2State(state);
    const candidate = state.candidates.find(item => item.id === candidateId);
    if (!candidate) throw phase2Error('Candidate not found.', 'NOT_FOUND');
    if (candidate.classification?.editorial_pitch?.accepted !== true || !candidate.commission || !commissionAuthorization?.job_id) throw phase2Error('Only an editor-approved pitch can begin Phase 2 reporting.', 'PITCH_NOT_COMMISSIONABLE');
    const authorizedAction = commissionAuthorization.action || commissionAuthorization.authorized_action || null;
    revisionInstructions ||= commissionAuthorization.revision_instructions || '';
    const researchAgain = authorizedAction === 'research_again';
    const runRevision = authorizedAction === 'run_revision';
    const reuseFrozenPacket = commissionAuthorization.reuse_frozen_evidence_packet === true;
    const frozenPacketForReuse = commissionAuthorization.frozen_evidence_packet || null;
    const researchDecision = researchDecisionFor(candidate);
    const researchRequirement = researchDecision.research_requirement;
    if (runRevision) throw phase2Error('Automatic Luna Revision is disabled in the approved V1 production path. Use the manual Sol polish action.', 'PHASE2_REVISION_DISABLED');
    if (researchAgain && researchRequirement !== 'required') throw phase2Error('Research again is not authorized for a commission whose research requirement is none.', 'PHASE2_RESEARCH_NOT_AUTHORIZED');
    let run = phase2RunFor(state, candidateId);
    if (run?.status === 'complete' && candidate.phase2_state === 'ai_review_ready') {
      const review = [...state.reviews].reverse().find(item => item.candidate_id === candidateId && item.pipeline_version === PHASE2_VERSION);
      if (review) await this.persistStageIfNeeded({ state, run, stage: 'ai_review', payload: phase2PersistencePayload({ run, stage: 'ai_review', packet: review.evidence_packet, draft: review.draft, revision: review.revision, review, claims: review.claims, blockers: review.deterministic_review?.blocking_factual_errors || [], usage: review.model_usage || run.model_usage, cost: review.estimated_cost_usd || run.estimated_cost_usd }), claims: review.claims, blockers: review.deterministic_review?.blocking_factual_errors || [], usage: review.model_usage || run.model_usage, cost: review.estimated_cost_usd || run.estimated_cost_usd });
      return { candidate, run, review, resumed: true };
    }
    if (runRevision && (!run || !stageArtifact(state, run.id, 'evidence_packet')?.payload || !stageArtifact(state, run.id, 'draft')?.payload)) {
      throw phase2Error('A revision authorization requires the retained frozen packet and draft.', 'PHASE2_REVISION_NOT_RESUMABLE');
    }
    if (run?.status === 'blocked' && !researchAgain && !runRevision) {
      const review = [...state.reviews].reverse().find(item => item.candidate_id === candidateId && item.pipeline_version === PHASE2_VERSION);
      return { candidate, run, review: review || null, error: run.error || null, research_again_required: run.state === 'research_blocked', action_required: run.state === 'research_blocked' ? 'research_again' : null, resumed: true };
    }
    if (run?.status === 'failed' && !researchAgain && !runRevision && !reuseFrozenPacket) {
      return { candidate, run, review: null, error: run.error || null, resumed: true };
    }
    if (!run || (researchAgain && ['failed', 'blocked'].includes(run.status)) || reuseFrozenPacket) {
      const previousRun = run;
      run = createPhase2Run(candidateId, commissionAuthorization, {
        holdout_run_id: commissionAuthorization?.holdout_run_id,
        case_run_id: commissionAuthorization?.case_run_id || (reuseFrozenPacket ? crypto.randomUUID() : null)
      });
      if (reuseFrozenPacket) {
        if (!frozenPacketForReuse || frozenPacketForReuse.frozen_evidence_packet_sha256 !== commissionAuthorization.frozen_evidence_packet_sha256 || evidencePacketSha256(frozenPacketForReuse) !== commissionAuthorization.frozen_evidence_packet_sha256) {
          throw phase2Error('The supplied frozen evidence packet failed its identity check.', 'PHASE2_FROZEN_PACKET_IDENTITY_MISMATCH');
        }
        run.reused_frozen_evidence_packet = true;
        run.previous_run_id = previousRun?.id || null;
        run.frozen_evidence_packet_sha256 = commissionAuthorization.frozen_evidence_packet_sha256;
        run.readiness_inventory_sha256 = commissionAuthorization.readiness_inventory_sha256 || previousRun?.readiness_inventory_sha256 || null;
        run.runtime_inventory_sha256 = commissionAuthorization.runtime_inventory_sha256 || previousRun?.runtime_inventory_sha256 || null;
        run.terra_input_packet_sha256 = commissionAuthorization.terra_input_packet_sha256 || previousRun?.terra_input_packet_sha256 || null;
        // A frozen-packet rerun is a new Draft attempt, not a new acquisition.
        // Preserve the already-passed deterministic source gate and never
        // re-count the packet's intentionally metadata-only source records.
        run.source_gate = commissionAuthorization.corrected_source_gate || previousRun?.source_gate || null;
        run.parent_frozen_evidence_packet_sha256 = commissionAuthorization.parent_frozen_evidence_packet_sha256 || null;
        run.classification_changes = commissionAuthorization.classification_changes || [];
      }
      run.research_requirement = researchRequirement;
      run.research_requirement_reason = commissionAuthorization.research_requirement_reason || researchDecision.reason;
      state.phase2_runs.push(run);
      state.runs.push(run);
      transitionPhase2(candidate, 'commissioned', actor, 'Editor commission accepted for pipeline-v1.');
      await this.checkpointState(state);
    }
    run.research_requirement ||= researchRequirement;
    run.research_requirement_reason ||= commissionAuthorization.research_requirement_reason || researchDecision.reason;
    const forceRevision = runRevision;
    if (forceRevision) run.events.push({ type: 'revision_authorized', instructions: revisionInstructions, at: now() });
    const form = formFor(candidate);
    let documents = state.documents.filter(document => document.candidate_id === candidateId && document.processing_run_id === run.id);
    if (!forceRevision && !documents.length) {
      transitionPhase2(candidate, 'acquiring_sources', actor, 'Bounded source acquisition started from the approved pitch and seed URLs.');
      documents = reuseFrozenPacket
        ? this.frozenReadinessDocuments({ candidate, run, inventory: { sources: frozenPacketForReuse.sources || [] }, metadataOnly: true })
        : commissionAuthorization.readiness_inventory?.sources
        ? this.frozenReadinessDocuments({ candidate, run, inventory: commissionAuthorization.readiness_inventory })
        : await this.retrieveSources({ state, candidate, run });
      if (reuseFrozenPacket) {
        run.source_acquisition = {
          limits: { max_search_queries: 0, max_retained_sources: frozenPacketForReuse.sources?.length || 0 },
          started_at: now(),
          queries: [],
          retained_seed_sources: (frozenPacketForReuse.sources || []).length,
          retained_search_sources: 0,
          inaccessible_sources: 0,
          reused_frozen_packet: true,
          completed_at: now()
        };
        run.events.push({ type: 'frozen_packet_reused', frozen_evidence_packet_sha256: frozenPacketForReuse.frozen_evidence_packet_sha256, source_searches: 0, source_refetches: 0, at: now() });
      }
      if (documents.length) state.documents.push(...documents);
      await this.checkpointState(state);
    }
    if (forceRevision && !documents.length) throw phase2Error('A revision authorization requires retained source documents.', 'PHASE2_REVISION_NOT_RESUMABLE');

    if (!forceRevision) transitionPhase2(candidate, 'research_ready', actor, `${documents.length} retained source document(s) are ready for deterministic evidence gates.`);

    if (!forceRevision && !run.source_gate) {
      const sourceGate = sourceSufficiencyGate({
        candidate,
        documents,
        fetchDiagnostics: run.source_fetches,
        override: commissionAuthorization.source_sufficiency_override || commissionAuthorization.sourceSufficiencyOverride || null,
        mandatorySourceUrls: commissionAuthorization.mandatory_source_urls || commissionAuthorization.mandatorySourceUrls || [],
        requiredClaims: commissionAuthorization.required_claims || commissionAuthorization.requiredClaims || []
      });
      run.source_gate = sourceGate;
      if (sourceGate.overridden) run.events.push({ type: 'source_gate_override', ...sourceGate.override, at: now() });
      if (!sourceGate.ok) {
        const blockers = sourceGateBlockers(sourceGate);
        const error = phase2Error(blockers.map(item => item.reason).join('; ') || 'Commissioned sources did not meet the deterministic sufficiency gate.', sourceGate.code || 'PHASE2_SOURCE_INSUFFICIENT', { source_gate: sourceGate, blockers });
        run.status = 'blocked'; run.state = 'research_blocked'; run.error = { code: error.code, message: error.message, blockers, source_gate: sourceGate }; run.finished_at = now();
        run.events.push({ type: 'source_gate_blocked', code: error.code, blockers, at: now() });
        transitionPhase2(candidate, 'research_blocked', actor, error.message);
        if (candidate.status !== 'research_blocked') transition(candidate, 'research_blocked', actor, error.message);
        await persistPhase2Stage({ state, run, stage: 'research', payload: phase2PersistencePayload({ run, stage: 'research', blockers, usage: run.model_usage, cost: run.estimated_cost_usd }), persistence: this.persistence });
        await this.checkpointState(state);
        return { candidate, run, error: run.error, review: null, research_again_required: true };
      }
    }

    let inventory = stageArtifact(state, run.id, 'source_inventory')?.payload;
    if (reuseFrozenPacket && !inventory) {
      inventory = {
        version: 'pipeline-v1-source-inventory-offsets-v1',
        sources: frozenPacketForReuse.sources || [],
        claims: frozenPacketForReuse.claims || [],
        claim_targets: frozenPacketForReuse.claim_targets || [],
        readiness_inventory_sha256: run.readiness_inventory_sha256,
        runtime_inventory_sha256: run.runtime_inventory_sha256
      };
      beginStage(state, run, 'source_inventory');
      completeStage(state, run, 'source_inventory', inventory);
      await persistPhase2Stage({ state, run, stage: 'source_inventory', payload: phase2PersistencePayload({ run, stage: 'source_inventory', packet: inventory, claims: [], usage: [], cost: null }), persistence: this.persistence });
      await this.checkpointState(state);
    }
    if (!inventory) {
      transitionPhase2(candidate, 'preparing_evidence', actor, 'Deterministic evidence-input preflight started.');
      beginStage(state, run, 'source_inventory');
      const { checksum: _legacyInventoryChecksum, ...inventoryPacket } = preflightEvidencePacket({ sources: sourceRecords(candidate, documents), preserveSourceText: true, includeRetainedText: true, includeSourceExcerpts: false, limits: { ...EVIDENCE_PACKET_LIMITS, maxSources: this.retrievalLimits.maxSources, maxSourceExcerptCharacters: this.retrievalLimits.sourceChars, maxTotalExcerptCharacters: this.retrievalLimits.maxTotalExcerptCharacters } }).packet;
      inventory = { ...inventoryPacket, version: 'pipeline-v1-source-inventory-offsets-v1', terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION };
      run.evidence_preflight = inventory.diagnostics?.preflight || null;
      const runtimeInventorySha256 = hashPhase2Inventory({ candidateId, assignmentSha256: run.assignment_sha256, sources: sourceRecords(candidate, documents) });
      const readinessInventory = commissionAuthorization.readiness_inventory || commissionAuthorization.readinessInventory || null;
      const declaredReadinessSha256 = commissionAuthorization.readiness_inventory_sha256 || null;
      if (readinessInventory && declaredReadinessSha256) {
        const readinessSha256 = hashPhase2Inventory({ candidateId, assignmentSha256: run.assignment_sha256, sources: readinessInventory.sources || [] });
        assertInventoryChecksum({ expected: declaredReadinessSha256, actual: readinessSha256, label: 'readiness inventory' });
      }
      run.readiness_inventory_sha256 = declaredReadinessSha256 || runtimeInventorySha256;
      run.runtime_inventory_sha256 = runtimeInventorySha256;
      assertInventoryChecksum({ expected: run.readiness_inventory_sha256, actual: run.runtime_inventory_sha256, label: 'runtime inventory' });
      const inputPacket = terraInputPacket({ candidate, inventory, researchQuestions: assignmentQuestions(candidate) });
      run.terra_input_packet_sha256 = hash(stableJson(inputPacket));
      inventory.readiness_inventory_sha256 = run.readiness_inventory_sha256;
      inventory.runtime_inventory_sha256 = run.runtime_inventory_sha256;
      completeStage(state, run, 'source_inventory', inventory);
      await persistPhase2Stage({ state, run, stage: 'source_inventory', payload: phase2PersistencePayload({ run, stage: 'source_inventory', packet: inventory, claims: [], usage: run.model_usage, cost: run.estimated_cost_usd }), persistence: this.persistence });
      await this.checkpointState(state);
    }
    if (inventory.readiness_inventory_sha256 && inventory.runtime_inventory_sha256) {
      run.readiness_inventory_sha256 ||= inventory.readiness_inventory_sha256;
      run.runtime_inventory_sha256 ||= inventory.runtime_inventory_sha256;
      assertInventoryChecksum({ expected: run.readiness_inventory_sha256, actual: run.runtime_inventory_sha256, label: 'runtime inventory' });
    }

    let terra = stageArtifact(state, run.id, 'research')?.payload;
    if (reuseFrozenPacket && !terra) {
      terra = {
        research_requirement: 'none',
        research_questions: frozenPacketForReuse.terra_summary?.research_questions || [],
        selected_source_ids: frozenPacketForReuse.terra_summary?.selected_source_ids || (frozenPacketForReuse.sources || []).map(source => source.source_id),
        optional_source_ids: frozenPacketForReuse.terra_summary?.optional_source_ids || [],
        excluded_sources: frozenPacketForReuse.terra_summary?.excluded_sources || [],
        claims: frozenPacketForReuse.claims || [],
        required_facts: frozenPacketForReuse.required_facts || [],
        prohibited_claims: frozenPacketForReuse.prohibited_claims || [],
        ledgers: frozenPacketForReuse.ledgers || { quotations: [], proper_names: [], numbers: [] },
        claim_targets: frozenPacketForReuse.claim_targets || [],
        unresolved_research_questions: frozenPacketForReuse.unresolved_research_questions || [],
        contradictions: frozenPacketForReuse.terra_summary?.contradictions || [],
        freshness_risks: frozenPacketForReuse.terra_summary?.freshness_risks || [],
        missing_evidence: frozenPacketForReuse.terra_summary?.missing_evidence || [],
        blockers: frozenPacketForReuse.blockers || [],
        draft_constraints: frozenPacketForReuse.draft_constraints || [],
        ready_to_draft: true,
        deterministic: true,
        reused_frozen_packet: true
      };
      beginStage(state, run, 'research', { metadata: { research_requirement: 'none' } });
      completeStage(state, run, 'research', terra);
      run.events.push({ type: 'research_reused_frozen_packet', research_requirement: 'none', provider_call_count: run.provider_call_count, at: now() });
      await persistPhase2Stage({ state, run, stage: 'research', payload: phase2PersistencePayload({ run, stage: 'research', packet: inventory, claims: terra.claims, blockers: [], usage: [], cost: null }), claims: terra.claims, blockers: [], usage: [], cost: null, persistence: this.persistence });
      await this.checkpointState(state);
    }
    if (researchRequirement === 'required' && !terra) {
      transitionPhase2(candidate, 'researching', actor, 'Terra High evidence selection started.');
      const prompt = terraPrompt({ candidate, sourceInventory: inventory, researchQuestions: assignmentQuestions(candidate) });
      const stage = beginStage(state, run, 'research', { metadata: { prompt_sha256: hash(prompt), readiness_inventory_sha256: run.readiness_inventory_sha256, runtime_inventory_sha256: run.runtime_inventory_sha256, terra_input_packet_sha256: run.terra_input_packet_sha256 } });
      let response = null;
      let usage = null;
      try {
        response = await this.adapterFor('research').generate({ prompt, stage: 'research', signal, onProviderStart: () => markProviderCallStarted(state, run, 'research', { model: PRODUCTION_MODELS.terraHigh.model }) });
        usage = usageFor(response, PRODUCTION_MODELS.terraHigh.model, 'research', stage.attempt.attempt);
        recordStageResponse(state, run, 'research', { response, usage });
        terra = parseStrictJson(response.raw, 'Terra');
        recordStageParse(state, run, 'research', 'valid');
        assertPhase1Schema('terra_research_evidence', terra);
        recordStageSchema(state, run, 'research', 'valid');
        assertPhase2Fields(terra, ['required_facts', 'prohibited_claims', 'ledgers', 'claim_targets', 'unresolved_research_questions'], 'Terra');
        terra = validateTerraEvidenceOffsets(terra, documents);
        completeStage(state, run, 'research', terra, { rawResponse: response.raw, usage });
        await persistPhase2Stage({ state, run, stage: 'research', payload: phase2PersistencePayload({ run, stage: 'research', packet: inventory, claims: terra.claims, blockers: terra.blockers, contradictions: terra.contradictions, usage: [usage], cost: usage.estimated_cost_usd }), persistence: this.persistence });
        await this.checkpointState(state);
      } catch (error) {
        if (error.code === 'PHASE2_INVALID_JSON' || error.code === 'PHASE2_EMPTY_RESPONSE') recordStageParse(state, run, 'research', 'invalid');
        if (error.code === 'PHASE1_SCHEMA_INVALID' || error.code === 'PHASE2_SCHEMA_INVALID') recordStageSchema(state, run, 'research', 'invalid', error.details?.errors || [error.message]);
        failStage(state, run, 'research', error, { rawResponse: response?.raw ?? error.details?.raw_response ?? null, usage });
        const contractFailure = ['PHASE2_INVALID_JSON', 'PHASE2_EMPTY_RESPONSE', 'PHASE1_SCHEMA_INVALID', 'PHASE2_SCHEMA_INVALID'].includes(error.code);
        const persistenceFailure = error.code === 'PHASE2_PERSISTENCE_FAILED';
        const failureState = contractFailure || persistenceFailure ? 'failed' : 'research_blocked';
        run.status = contractFailure || persistenceFailure ? 'failed' : 'blocked'; run.state = failureState; run.error = { code: error.code || 'PHASE2_RESEARCH_FAILED', message: error.message, details: error.details || null, blockers: [researchBlockerForError(error)] }; run.finished_at = now();
        transitionPhase2(candidate, failureState, actor, error.message);
        if (candidate.status !== failureState) transition(candidate, failureState, actor, error.message);
        await this.persistFailedStage({ state, run, stage: 'research', payload: phase2PersistencePayload({ run, stage: 'research', packet: inventory, claims: [], blockers: run.error.blockers, usage: run.model_usage, cost: run.estimated_cost_usd }) });
        await this.checkpointState(state);
        return { candidate, run, error: run.error, review: null, ...(contractFailure || persistenceFailure ? {} : { research_again_required: true }) };
      }
    }

    if (researchRequirement === 'required') {
      await this.persistStageIfNeeded({ state, run, stage: 'research', payload: phase2PersistencePayload({ run, stage: 'research', packet: inventory, claims: terra.claims, blockers: terra.blockers, contradictions: terra.contradictions, usage: run.model_usage, cost: run.estimated_cost_usd }), claims: terra.claims, blockers: terra.blockers, usage: run.model_usage, cost: run.estimated_cost_usd });
    }
    if (researchRequirement === 'none' && !terra) {
      const claims = deterministicRetainedClaims(candidate, documents);
      terra = {
        research_requirement: 'none', research_questions: [], selected_source_ids: documents.map(document => document.id), optional_source_ids: [], excluded_sources: [], claims,
        required_facts: [], prohibited_claims: [], ledgers: { quotations: [], proper_names: [], numbers: [] }, claim_targets: claims.map(claim => claim.claim_id), unresolved_research_questions: [], contradictions: [], freshness_risks: [], missing_evidence: [], blockers: [], draft_constraints: [], ready_to_draft: claims.length > 0, deterministic: true
      };
      beginStage(state, run, 'research', { metadata: { research_requirement: 'none' } });
      completeStage(state, run, 'research', terra);
      run.events.push({ type: 'research_skipped', research_requirement: 'none', provider_call_count: run.provider_call_count, at: now() });
      await persistPhase2Stage({ state, run, stage: 'research', payload: phase2PersistencePayload({ run, stage: 'research', claims, blockers: [], usage: [], cost: null }), claims, blockers: [], usage: [], cost: null, persistence: this.persistence });
      await this.checkpointState(state);
    }
    const blockers = [...(terra.blockers || [])];
    if (!terra.ready_to_draft || blockers.length) {
      run.status = 'blocked'; run.state = 'research_blocked'; run.error = { code: 'PHASE2_RESEARCH_BLOCKED', message: blockers.map(item => item.reason || item.question || item).join('; ') || 'Terra did not clear the evidence packet.', blockers, contradictions: terra.contradictions || [], missing_evidence: terra.missing_evidence || [], draft_constraints: terra.draft_constraints || [] }; run.finished_at = now();
      transitionPhase2(candidate, 'research_blocked', actor, run.error.message);
      if (candidate.status !== 'research_blocked') transition(candidate, 'research_blocked', actor, run.error.message);
      run.events.push({ type: 'research_blocked', human_action: 'research_again', at: now() });
      await this.persistStageIfNeeded({ state, run, stage: 'research', payload: phase2PersistencePayload({ run, stage: 'research', packet: inventory, claims: terra.claims, blockers, contradictions: terra.contradictions, usage: run.model_usage, cost: run.estimated_cost_usd }), claims: terra.claims, blockers, usage: run.model_usage, cost: run.estimated_cost_usd, force: true });
      await this.checkpointState(state);
      return { candidate, run, error: run.error, review: null, research_again_required: true };
    }

    let packet = stageArtifact(state, run.id, 'evidence_packet')?.payload;
    if (reuseFrozenPacket && !packet) {
      packet = deepFreeze(frozenPacketForReuse);
      beginStage(state, run, 'evidence_packet');
      completeStage(state, run, 'evidence_packet', packet);
      state.research_packets.push({ id: crypto.randomUUID(), holdout_run_id: holdoutRunIdFor(run), case_run_id: caseRunIdFor(run), candidate_id: candidateId, processing_run_id: run.id, iteration: 1, pipeline_version: PHASE2_VERSION, terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, packet, frozen_evidence_packet_sha256: packet.frozen_evidence_packet_sha256, created_at: now(), terra_summary: { selected_source_ids: terra.selected_source_ids, optional_source_ids: terra.optional_source_ids, contradictions: terra.contradictions, freshness_risks: terra.freshness_risks, missing_evidence: terra.missing_evidence, blockers: terra.blockers || [], draft_constraints: terra.draft_constraints || [] } });
      await persistPhase2Stage({ state, run, stage: 'evidence_packet', payload: phase2PersistencePayload({ run, stage: 'evidence_packet', packet, claims: terra.claims, blockers: [], contradictions: terra.contradictions, usage: [], cost: null }), persistence: this.persistence });
      await this.checkpointState(state);
    }
    if (!packet) {
      const selectedIds = unique([...(terra.selected_source_ids || []), ...(terra.optional_source_ids || [])]);
      const selected = sourceRecords(candidate, documents).filter(source => selectedIds.includes(source.id));
      const terraUsage = run.model_usage.find(item => item.stage === 'research') || null;
      packet = freezePacket(buildEvidencePacket({ sources: selected, claims: terra.claims, requiredFacts: terra.required_facts, prohibitedClaims: terra.prohibited_claims, ledgers: terra.ledgers, unresolvedResearchQuestions: terra.unresolved_research_questions, blockers: blockers.map(item => item.reason || item), draftConstraints: terra.draft_constraints, preserveSourceText: true, includeSourceExcerpts: false, preserveDerivedEvidence: true, limits: { ...EVIDENCE_PACKET_LIMITS, maxSources: this.retrievalLimits.maxSources, maxSourceExcerptCharacters: this.retrievalLimits.sourceChars, maxTotalExcerptCharacters: this.retrievalLimits.maxTotalExcerptCharacters } }), { research_questions: terra.research_questions, claim_targets: terra.claim_targets, contradictions: terra.contradictions, freshness_risks: terra.freshness_risks, missing_evidence: terra.missing_evidence, selected_source_ids: terra.selected_source_ids, optional_source_ids: terra.optional_source_ids, excluded_sources: terra.excluded_sources, blockers, draft_constraints: terra.draft_constraints }, terraUsage, terraUsage?.estimated_cost_usd ?? null);
      beginStage(state, run, 'evidence_packet');
      completeStage(state, run, 'evidence_packet', packet);
      state.research_packets.push({ id: crypto.randomUUID(), holdout_run_id: holdoutRunIdFor(run), case_run_id: caseRunIdFor(run), candidate_id: candidateId, processing_run_id: run.id, iteration: 1, pipeline_version: PHASE2_VERSION, terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION, packet, frozen_evidence_packet_sha256: packet.frozen_evidence_packet_sha256, created_at: now(), terra_summary: { selected_source_ids: terra.selected_source_ids, optional_source_ids: terra.optional_source_ids, contradictions: terra.contradictions, freshness_risks: terra.freshness_risks, missing_evidence: terra.missing_evidence, blockers: terra.blockers || [], draft_constraints: terra.draft_constraints || [] } });
      await persistPhase2Stage({ state, run, stage: 'evidence_packet', payload: phase2PersistencePayload({ run, stage: 'evidence_packet', packet, claims: terra.claims, blockers, contradictions: terra.contradictions, usage: run.model_usage, cost: run.estimated_cost_usd }), persistence: this.persistence });
      await this.checkpointState(state);
    }
    await this.persistStageIfNeeded({ state, run, stage: 'evidence_packet', payload: phase2PersistencePayload({ run, stage: 'evidence_packet', packet, claims: terra.claims, blockers, contradictions: terra.contradictions, usage: run.model_usage, cost: run.estimated_cost_usd }), claims: terra.claims, blockers, usage: run.model_usage, cost: run.estimated_cost_usd });
      transitionPhase2(candidate, 'evidence_ready', actor, `Frozen evidence packet ${packet.frozen_evidence_packet_sha256} is ready.`);

    let draft = stageArtifact(state, run.id, 'draft')?.payload;
    if (!draft) {
      transitionPhase2(candidate, 'drafting', actor, 'Luna High draft started from the frozen packet.');
      const prompt = lunaDraftPrompt({ candidate, packet });
      run.frozen_evidence_packet_sha256 = packet.frozen_evidence_packet_sha256;
      run.draft_input_sha256 = hash(prompt);
      const stage = beginStage(state, run, 'draft', { metadata: { prompt_sha256: hash(prompt), readiness_inventory_sha256: run.readiness_inventory_sha256, runtime_inventory_sha256: run.runtime_inventory_sha256, terra_input_packet_sha256: run.terra_input_packet_sha256, frozen_evidence_packet_sha256: run.frozen_evidence_packet_sha256, draft_input_sha256: run.draft_input_sha256 } });
      let response = null;
      let usage = null;
      try {
        response = await this.adapterFor('draft').generate({ prompt, stage: 'draft', signal, onProviderStart: () => markProviderCallStarted(state, run, 'draft', { model: PRODUCTION_MODELS.lunaHigh.model }) });
        usage = usageFor(response, PRODUCTION_MODELS.lunaHigh.model, 'draft', stage.attempt.attempt);
        recordStageResponse(state, run, 'draft', { response, usage });
        draft = parseStrictJson(response.raw, 'Luna draft');
        recordStageParse(state, run, 'draft', 'valid');
        validDraft(draft, packet, candidate);
        recordStageSchema(state, run, 'draft', 'valid');
        completeStage(state, run, 'draft', draft, { rawResponse: response.raw, usage });
        await persistPhase2Stage({ state, run, stage: 'draft', payload: phase2PersistencePayload({ run, stage: 'draft', packet, draft, claims: draft.claims, usage: [usage], cost: usage.estimated_cost_usd }), persistence: this.persistence });
        await this.checkpointState(state);
      } catch (error) {
        if (error.code === 'PHASE2_INVALID_JSON' || error.code === 'PHASE2_EMPTY_RESPONSE') recordStageParse(state, run, 'draft', 'invalid');
        if (error.code === 'PHASE1_SCHEMA_INVALID' || error.code === 'PHASE2_SCHEMA_INVALID') recordStageSchema(state, run, 'draft', 'invalid', error.details?.errors || [error.message]);
        failStage(state, run, 'draft', error, { rawResponse: response?.raw ?? error.details?.raw_response ?? null, usage });
        run.status = 'failed'; run.state = 'failed'; run.error = { code: error.code || 'PHASE2_DRAFT_FAILED', message: error.message, blockers: [researchBlockerForError(error)] }; run.finished_at = now(); transitionPhase2(candidate, 'failed', actor, error.message); if (candidate.status !== 'failed') transition(candidate, 'failed', actor, error.message); await this.persistFailedStage({ state, run, stage: 'draft', payload: phase2PersistencePayload({ run, stage: 'draft', packet, claims: [], blockers: run.error.blockers, usage: run.model_usage, cost: run.estimated_cost_usd }) }); return { candidate, run, error: run.error, review: null };
      }
    }
    await this.persistStageIfNeeded({ state, run, stage: 'draft', payload: phase2PersistencePayload({ run, stage: 'draft', packet, draft, claims: draft.claims, usage: run.model_usage, cost: run.estimated_cost_usd }), claims: draft.claims, usage: run.model_usage, cost: run.estimated_cost_usd });
    transitionPhase2(candidate, 'draft_ready', actor, 'Draft validated before deterministic review.');
    const draftReview = stageArtifact(state, run.id, 'draft_review')?.payload || deterministicReview({ candidate, draft, packet, form });
    if (!stageArtifact(state, run.id, 'draft_review')) {
      beginStage(state, run, 'draft_review');
      completeStage(state, run, 'draft_review', draftReview);
      await persistPhase2Stage({ state, run, stage: 'draft_review', payload: phase2PersistencePayload({ run, stage: 'draft_review', packet, draft, review: { status: draftReview.status, deterministic_review: draftReview }, claims: draft.claims, usage: run.model_usage, cost: run.estimated_cost_usd }), persistence: this.persistence });
      await this.checkpointState(state);
    }

    // V1 ends after the single Luna Draft and deterministic AI Review.
    // Keep the historical revision implementation below unreachable for
    // compatibility with old artifacts and holdout data.
    let revision = draft;
    if (false) {
      transitionPhase2(candidate, 'revising', actor, 'Luna High revision started from the same frozen packet.');
      const prompt = lunaRevisionPrompt({ candidate, packet, draft, findings: draftReview, instructions: revisionInstructions });
      run.revision_input_sha256 = hash(prompt);
      const stage = beginStage(state, run, 'revision', { force: forceRevision, metadata: { prompt_sha256: hash(prompt), readiness_inventory_sha256: run.readiness_inventory_sha256, runtime_inventory_sha256: run.runtime_inventory_sha256, terra_input_packet_sha256: run.terra_input_packet_sha256, frozen_evidence_packet_sha256: run.frozen_evidence_packet_sha256, draft_input_sha256: run.draft_input_sha256, revision_input_sha256: run.revision_input_sha256 } });
      let response = null;
      let usage = null;
      try {
        response = await this.adapterFor('revision').generate({ prompt, stage: 'revision', signal, onProviderStart: () => markProviderCallStarted(state, run, 'revision', { model: PRODUCTION_MODELS.lunaHigh.model }) });
        usage = usageFor(response, PRODUCTION_MODELS.lunaHigh.model, 'revision', stage.attempt.attempt);
        recordStageResponse(state, run, 'revision', { response, usage });
        revision = parseStrictJson(response.raw, 'Luna revision');
        recordStageParse(state, run, 'revision', 'valid');
        validRevision(revision, draft, packet, candidate);
        recordStageSchema(state, run, 'revision', 'valid');
        completeStage(state, run, 'revision', revision, { rawResponse: response.raw, usage });
        await persistPhase2Stage({ state, run, stage: 'revision', payload: phase2PersistencePayload({ run, stage: 'revision', packet, draft, revision, claims: revision.claims, usage: [usage], cost: usage.estimated_cost_usd }), persistence: this.persistence, force: forceRevision });
        await this.checkpointState(state);
      } catch (error) {
        if (error.code === 'PHASE2_INVALID_JSON' || error.code === 'PHASE2_EMPTY_RESPONSE') recordStageParse(state, run, 'revision', 'invalid');
        if (error.code === 'PHASE1_SCHEMA_INVALID' || error.code === 'PHASE2_SCHEMA_INVALID') recordStageSchema(state, run, 'revision', 'invalid', error.details?.errors || [error.message]);
        failStage(state, run, 'revision', error, { rawResponse: response?.raw ?? error.details?.raw_response ?? null, usage });
        run.status = 'failed'; run.state = 'failed'; run.error = { code: error.code || 'PHASE2_REVISION_FAILED', message: error.message, blockers: [researchBlockerForError(error)] }; run.finished_at = now(); transitionPhase2(candidate, 'failed', actor, error.message); if (candidate.status !== 'failed') transition(candidate, 'failed', actor, error.message); await this.persistFailedStage({ state, run, stage: 'revision', payload: phase2PersistencePayload({ run, stage: 'revision', packet, draft, claims: [], blockers: run.error.blockers, usage: run.model_usage, cost: run.estimated_cost_usd }) }); return { candidate, run, error: run.error, review: null };
      }
    }
    const finalReview = draftReview;
    if (false) {
      beginStage(state, run, 'revision_review', { force: forceRevision });
      completeStage(state, run, 'revision_review', finalReview);
      await persistPhase2Stage({ state, run, stage: 'revision_review', payload: phase2PersistencePayload({ run, stage: 'revision_review', packet, draft, revision, review: { status: finalReview.status, deterministic_review: finalReview, revision_findings: finalReview }, claims: revision.claims, usage: run.model_usage, cost: run.estimated_cost_usd }), persistence: this.persistence, force: forceRevision });
      await this.checkpointState(state);
    }
    const article = parseArticleMarkdown(draft.body_markdown, candidate);
    const claims = (draft.claims || []).map(claim => ({ ...claim, holdout_run_id: holdoutRunIdFor(run), case_run_id: caseRunIdFor(run), candidate_id: candidate.id, processing_run_id: run.id, status: finalReview.blocking_factual_errors.length ? 'needs_review' : 'supported', note: claim.qualification_note || '' }));
    const review = {
      id: crypto.randomUUID(), holdout_run_id: holdoutRunIdFor(run), case_run_id: caseRunIdFor(run), candidate_id: candidate.id, processing_run_id: run.id, pipeline_version: PHASE2_VERSION, terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION, packet_version: packet.version, readiness_inventory_sha256: run.readiness_inventory_sha256, runtime_inventory_sha256: run.runtime_inventory_sha256, terra_input_packet_sha256: run.terra_input_packet_sha256, frozen_evidence_packet_sha256: run.frozen_evidence_packet_sha256 || packet.frozen_evidence_packet_sha256, draft_input_sha256: run.draft_input_sha256, document_ids: documents.map(document => document.id), status: finalReview.blocking_factual_errors.length ? 'blocked' : 'ready_for_review', created_at: now(), model: PRODUCTION_MODELS.draft.model, prompt_version: 'pipeline-v1-luna-draft-deterministic-review-v1', headline: draft.headline || article.headline, dek: draft.dek || article.dek, article: draft.body_markdown, previous_draft: null, section: draft.section, lens: draft.lens, beats: draft.beats || [], source_ids: draft.source_ids || [], classification: null, research: { pipeline_version: PHASE2_VERSION, terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, phase2_inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION, packet, terra, research_requirement: run.research_requirement, blockers: terra.blockers || [], draft_constraints: terra.draft_constraints || [], frozen: true }, evidence_packet: packet, terra_summary: { selected_source_ids: terra.selected_source_ids, optional_source_ids: terra.optional_source_ids, excluded_sources: terra.excluded_sources, contradictions: terra.contradictions, freshness_risks: terra.freshness_risks, missing_evidence: terra.missing_evidence, blockers: terra.blockers || [], draft_constraints: terra.draft_constraints || [] }, draft: { ...draft, body_markdown: draft.body_markdown }, revision: null, claim_support: draft.claim_support || [], cited_evidence_ids: unique((draft.claim_support || []).flatMap(mapping => mapping.evidence_ids || [])), deterministic_review: finalReview, draft_findings: draftReview, revision_findings: null, diff: null, claims, unresolved_claims: finalReview.blocking_factual_errors.map(message => ({ claim: message, status: 'needs_review' })), images: [], model_usage: run.model_usage, estimated_cost_usd: run.estimated_cost_usd, logs: {}, validation_history: { draft: draftReview }
    };
    review.classification = reviewClassification(candidate, form, review);
    const integrity = validateReviewPackage({ candidate, run, documents, review });
    if (!integrity.ok) { run.status = 'failed'; run.state = 'failed'; run.error = { code: integrity.code, message: integrity.errors.join('; ') }; run.finished_at = now(); transitionPhase2(candidate, 'failed', actor, run.error.message); if (candidate.status !== 'research_blocked') transition(candidate, 'research_blocked', actor, run.error.message); return { candidate, run, error: run.error, review: null }; }
    state.reviews.push(review);
    run.review_id = review.id; run.status = finalReview.blocking_factual_errors.length ? 'blocked' : 'complete'; run.state = 'ai_review_ready'; run.finished_at = now();
    transitionPhase2(candidate, 'ai_review_ready', actor, finalReview.blocking_factual_errors.length ? 'AI Review package retained with blocking findings.' : 'AI Review package ready for human review.');
    candidate.classification = review.classification;
    candidate.phase2_review_id = review.id;
      candidate.phase2_frozen_evidence_packet_sha256 = run.frozen_evidence_packet_sha256 || packet.frozen_evidence_packet_sha256;
    candidate.phase2_state = 'ai_review_ready';
    candidate.status = 'ready_for_review';
    state.phase2_reviews.push(review);
    await this.persistStageIfNeeded({ state, run, stage: 'ai_review', payload: phase2PersistencePayload({ run, stage: 'ai_review', packet, draft, review, claims, blockers: finalReview.blocking_factual_errors, contradictions: terra.contradictions, usage: run.model_usage, cost: run.estimated_cost_usd }), claims, blockers: finalReview.blocking_factual_errors, usage: run.model_usage, cost: run.estimated_cost_usd });
      return { candidate, run, review, result: { status: 'ready_for_review', pipeline_version: PHASE2_VERSION, frozen_evidence_packet_sha256: run.frozen_evidence_packet_sha256 || packet.frozen_evidence_packet_sha256, deterministic_review: finalReview, model_usage: run.model_usage, estimated_cost_usd: run.estimated_cost_usd } };
  }
}
