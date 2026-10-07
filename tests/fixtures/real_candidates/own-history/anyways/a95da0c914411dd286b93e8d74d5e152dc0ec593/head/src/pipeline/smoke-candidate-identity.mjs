import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EVIDENCE_PACKET_LIMITS, preflightEvidencePacket, stableJson } from './evidence-packet.mjs';
import { sourceSufficiencyGate } from './phase2-source-gate.mjs';
import { PHASE2_INVENTORY_CONTRACT_VERSION, hashPhase2Inventory, inventoryFromRuntime, verifyPhase2InventoryIdentity } from './phase2-inventory.mjs';

export const SMOKE_CANDIDATE_IDENTITY_CONTRACT_VERSION = 'pipeline-v1-smoke-candidate-identity-v1';

const sha256 = value => crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const requireObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is required.`);
  return value;
};
const requireArray = (value, label) => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
  return value;
};
const requiredChecksum = (value, label) => {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) throw new Error(`${label} must be a SHA-256 checksum.`);
  return value;
};

function canonicalAssignment(assignment, candidateId) {
  const value = clone(requireObject(assignment, 'retained assignment'));
  value.candidate_id = candidateId;
  return value;
}

function sourceForReadiness(source) {
  const retainedText = String(source.retained_text ?? source.text ?? source.content ?? '');
  if (!retainedText) throw new Error(`Retained source ${source.source_id || source.id || 'unknown'} has no retained text.`);
  return {
    source_id: String(source.source_id ?? source.id ?? ''),
    requested_url: source.requested_url ?? source.url ?? source.canonical_url ?? null,
    canonical_url: source.canonical_url ?? source.url ?? source.requested_url ?? null,
    title: source.title ?? null,
    publisher: source.publisher ?? null,
    published_at: source.published_at ?? null,
    classification: source.classification ?? source.source_type ?? null,
    source_type: source.source_type ?? source.classification ?? null,
    independence_key: source.independence_key ?? null,
    primary_source: source.primary_source === true,
    accessible: source.accessible !== false,
    ok: source.ok !== false,
    retained_text: retainedText,
    retained_text_sha256: source.retained_text_sha256 ?? null,
    raw_sha256: source.raw_sha256 ?? null,
    retained_from_full_text_sha256: source.retained_from_full_text_sha256 ?? null,
    capture_mode: source.capture_mode ?? 'approved_snapshot'
  };
}

function runtimeDocumentFor(source, candidateId) {
  const content = String(source.retained_text ?? '');
  return {
    id: source.source_id,
    source_id: source.source_id,
    candidate_id: candidateId,
    requested_url: source.requested_url || source.canonical_url,
    url: source.canonical_url || source.requested_url,
    canonical_url: source.canonical_url || source.requested_url,
    title: source.title || '',
    publisher: source.publisher || null,
    published_at: source.published_at || null,
    content,
    source_type: source.source_type || source.classification || 'original_reporting',
    classification: source.classification || source.source_type || null,
    independence_key: source.independence_key || null,
    primary_source: source.primary_source === true,
    accessible: source.accessible !== false,
    ok: source.ok !== false,
    raw_sha256: source.raw_sha256 || null,
    retained_text_sha256: source.retained_text_sha256 || null,
    retained_from_full_text_sha256: source.retained_from_full_text_sha256 || null,
    capture_mode: source.capture_mode || 'frozen_readiness_inventory'
  };
}

function sourceRecordForRuntime(document) {
  return {
    id: document.id,
    source_id: document.id,
    requested_url: document.requested_url || document.url,
    canonical_url: document.canonical_url || document.url,
    title: document.title,
    publisher: document.publisher,
    published_at: document.published_at,
    classification: document.source_type,
    source_type: document.source_type,
    text: document.content,
    independence_key: document.independence_key,
    primary_source: document.primary_source,
    accessible: document.accessible !== false,
    ok: document.ok !== false,
    url: document.url,
    raw_sha256: document.raw_sha256,
    retained_text_sha256: document.retained_text_sha256,
    retained_from_full_text_sha256: document.retained_from_full_text_sha256,
    capture_mode: document.capture_mode,
    record: document
  };
}

function taxonomyFor(assignment) {
  const classification = assignment.classification || {};
  const commission = assignment.commission || {};
  return {
    primary_section: commission.section_id || classification.primary_section || null,
    story_form: commission.story_form || classification.story_form || null,
    recurring_beats: commission.beats || classification.recurring_beats || [],
    tags: commission.tags || classification.tags || []
  };
}

function acceptedPitchFor(assignment, taxonomy, requiredClaims, constraints) {
  const original = clone(assignment.classification?.editorial_pitch || {});
  return {
    ...original,
    accepted: true,
    headline: original.headline || assignment.title,
    primary_section: original.primary_section || taxonomy.primary_section,
    story_form: original.story_form || taxonomy.story_form,
    research_requirement: 'none',
    required_claims: requiredClaims,
    draft_constraints: constraints
  };
}

function canonicalEvidenceInput({ evidenceInput, candidateId, assignmentChecksum, readinessInventorySha256, runtimeInventorySha256, sources, requiredClaims, optionalClaims, constraints }) {
  const input = clone(requireObject(evidenceInput, 'retained evidence input'));
  return {
    schema_version: input.schema_version || 'phase2-evidence-input-v4-research',
    candidate_id: candidateId,
    assignment_checksum: assignmentChecksum,
    sources: sources.map(source => ({
      source_id: source.source_id,
      url: source.canonical_url || source.requested_url || null,
      title: source.title,
      publisher: source.publisher,
      classification: source.classification,
      independence_key: source.independence_key,
      primary_source: source.primary_source === true,
      accessible: source.accessible !== false,
      retained_text: source.retained_text,
      retained_text_sha256: source.retained_text_sha256 || sha256(source.retained_text)
    })),
    required_claim_ledger: requiredClaims,
    optional_claim_ledger: optionalClaims,
    draft_constraints: constraints,
    readiness_inventory_sha256: readinessInventorySha256,
    runtime_inventory_sha256: runtimeInventorySha256
  };
}

export function assertSmokeCandidatePayload({ candidate, checksums } = {}) {
  const commission = requireObject(candidate?.commission, 'smoke candidate commission');
  const expected = requireObject(checksums, 'smoke candidate checksum namespace');
  const fields = ['retained_assignment_sha256', 'readiness_inventory_sha256', 'runtime_inventory_sha256', 'evidence_input_sha256', 'claim_ledger_sha256', 'draft_constraints_sha256'];
  for (const field of fields) {
    requiredChecksum(commission[field], `smoke candidate ${field}`);
    if (commission[field] !== expected[field]) throw new Error(`Smoke candidate ${field} does not match the verified runtime checksum.`);
  }
  if (commission.assignment_checksum !== expected.retained_assignment_sha256) throw new Error('Smoke candidate assignment_checksum is missing or does not match retained_assignment_sha256.');
  if (commission.identity_contract_version !== SMOKE_CANDIDATE_IDENTITY_CONTRACT_VERSION) throw new Error('Smoke candidate identity contract version is missing or unsupported.');
  if (commission.readiness_inventory?.assignment_sha256 !== expected.retained_assignment_sha256) throw new Error('Smoke candidate readiness inventory omitted the retained assignment checksum.');
  return true;
}

export function buildSmokeCandidateIdentity({ packageData, candidateId } = {}) {
  const pkg = requireObject(packageData, 'authoritative retained package');
  if (!candidateId || typeof candidateId !== 'string') throw new Error('A new candidate ID is required.');
  const assignment = canonicalAssignment(pkg.assignment, candidateId);
  const canonicalInventory = requireObject(pkg.canonicalInventory, 'canonical retained inventory');
  const evidenceInput = requireObject(pkg.evidenceInput, 'retained evidence input');
  const sources = requireArray(canonicalInventory.sources, 'retained source inventory').map(sourceForReadiness);
  const requiredClaims = requireArray(evidenceInput.required_claim_ledger, 'required claim ledger');
  const optionalClaims = Array.isArray(evidenceInput.optional_claim_ledger) ? clone(evidenceInput.optional_claim_ledger) : [];
  const constraints = requireArray(evidenceInput.draft_constraints, 'draft constraints');
  const taxonomy = taxonomyFor(assignment);
  if (!taxonomy.primary_section || !taxonomy.story_form) throw new Error('Assignment taxonomy and story form are required.');

  const assignmentChecksum = sha256(assignment);
  const readinessInventory = {
    schema_version: canonicalInventory.schema_version || 'phase2-canonical-inventory-v2',
    inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION,
    candidate_id: candidateId,
    assignment_sha256: assignmentChecksum,
    sources
  };
  const documents = sources.map(source => runtimeDocumentFor(source, candidateId));
  const runtimeSources = documents.map(sourceRecordForRuntime);
  const runtimeInventory = inventoryFromRuntime({ candidateId, assignmentSha256: assignmentChecksum, sources: runtimeSources });
  const inventoryIdentity = verifyPhase2InventoryIdentity({
    candidateId,
    assignmentSha256: assignmentChecksum,
    readinessInventory,
    runtimeInventory,
    expectedReadinessSha256: hashPhase2Inventory(readinessInventory)
  });
  const claimLedgerSha256 = sha256({ required_claim_ledger: requiredClaims, optional_claim_ledger: optionalClaims });
  const draftConstraintsSha256 = sha256(constraints);
  const taxonomySha256 = sha256(taxonomy);
  const sourceClassificationsSha256 = sha256(sources.map(source => ({ source_id: source.source_id, classification: source.classification, primary_source: source.primary_source === true, independence_key: source.independence_key })).sort((left, right) => left.source_id.localeCompare(right.source_id)));
  const evidencePayload = canonicalEvidenceInput({ evidenceInput, candidateId, assignmentChecksum, readinessInventorySha256: inventoryIdentity.readinessInventorySha256, runtimeInventorySha256: inventoryIdentity.runtimeInventorySha256, sources, requiredClaims, optionalClaims, constraints });
  const evidenceInputSha256 = sha256(evidencePayload);
  const candidateIdentity = {
    identity_contract_version: SMOKE_CANDIDATE_IDENTITY_CONTRACT_VERSION,
    assignment_sha256: assignmentChecksum,
    retained_assignment_sha256: assignmentChecksum,
    readiness_inventory_sha256: inventoryIdentity.readinessInventorySha256,
    runtime_inventory_sha256: inventoryIdentity.runtimeInventorySha256,
    evidence_input_sha256: evidenceInputSha256,
    claim_ledger_sha256: claimLedgerSha256,
    draft_constraints_sha256: draftConstraintsSha256,
    taxonomy_sha256: taxonomySha256,
    source_classifications_sha256: sourceClassificationsSha256
  };
  const commission = {
    ...clone(assignment.commission),
    candidate_id: candidateId,
    research_requirement: 'none',
    assignment_checksum: assignmentChecksum,
    retained_assignment_sha256: assignmentChecksum,
    readiness_inventory_sha256: inventoryIdentity.readinessInventorySha256,
    runtime_inventory_sha256: inventoryIdentity.runtimeInventorySha256,
    evidence_input_sha256: evidenceInputSha256,
    claim_ledger_sha256: claimLedgerSha256,
    draft_constraints_sha256: draftConstraintsSha256,
    taxonomy_sha256: taxonomySha256,
    source_classifications_sha256: sourceClassificationsSha256,
    identity_contract_version: SMOKE_CANDIDATE_IDENTITY_CONTRACT_VERSION,
    required_claims: requiredClaims,
    draft_constraints: constraints,
    readiness_inventory: readinessInventory
  };
  const classification = {
    ...clone(assignment.classification),
    primary_section: taxonomy.primary_section,
    story_form: taxonomy.story_form,
    recurring_beats: taxonomy.recurring_beats,
    tags: taxonomy.tags,
    editorial_pitch: acceptedPitchFor(assignment, taxonomy, requiredClaims, constraints),
    pipeline_v1_smoke_test: true,
    publication_ineligible: true,
    pipeline_version: 'pipeline-v1',
    identity: candidateIdentity
  };
  const candidate = {
    id: candidateId,
    source_id: assignment.source_id || 'pipeline-v1-smoke-test',
    url: assignment.commission?.source_urls?.[0] || sources[0].canonical_url || sources[0].requested_url,
    title: assignment.title,
    description: assignment.description || assignment.commission?.brief || assignment.title,
    published_at: assignment.published_at || null,
    author: null,
    status: 'pitch_ready',
    commission,
    known_sources: sources.map(source => ({ id: source.source_id, source_id: source.source_id, url: source.canonical_url || source.requested_url, title: source.title })),
    classification
  };

  const sourceGate = sourceSufficiencyGate({
    candidate,
    documents,
    requiredClaims
  });
  if (!sourceGate.ok) throw new Error(`Smoke candidate source/claim gates failed: ${JSON.stringify(sourceGate.missing)}`);
  const packetPreflight = preflightEvidencePacket({
    sources: runtimeSources,
    preserveSourceText: true,
    includeRetainedText: true,
    includeSourceExcerpts: false,
    limits: EVIDENCE_PACKET_LIMITS
  });
  const declared = {
    retained_assignment_sha256: commission.retained_assignment_sha256,
    readiness_inventory_sha256: commission.readiness_inventory_sha256,
    runtime_inventory_sha256: commission.runtime_inventory_sha256,
    evidence_input_sha256: commission.evidence_input_sha256,
    claim_ledger_sha256: commission.claim_ledger_sha256,
    draft_constraints_sha256: commission.draft_constraints_sha256
  };
  const runtime = {
    retained_assignment_sha256: assignmentChecksum,
    readiness_inventory_sha256: inventoryIdentity.readinessInventorySha256,
    runtime_inventory_sha256: inventoryIdentity.runtimeInventorySha256,
    evidence_input_sha256: evidenceInputSha256,
    claim_ledger_sha256: claimLedgerSha256,
    draft_constraints_sha256: draftConstraintsSha256
  };
  if (stableJson(declared) !== stableJson(runtime)) throw new Error('Smoke candidate declared/runtime checksum namespace mismatch.');
  assertSmokeCandidatePayload({ candidate, checksums: runtime });
  return {
    candidate,
    identity: candidateIdentity,
    checksums: { declared, runtime },
    readinessInventory,
    runtimeInventory: inventoryIdentity.runtime,
    sourceGate,
    packetPreflight: packetPreflight.preflight || packetPreflight,
    providerSetup: { constructed: false, terraCallsStarted: false, lunaCallsStarted: false, solCallsStarted: false }
  };
}

export async function loadSmokeCandidatePackage(packageRoot, caseLabel = 'case-01') {
  const root = path.resolve(packageRoot);
  const read = async relative => JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
  const [assignment, canonicalInventory, evidenceInput, readinessReport] = await Promise.all([
    read(`assignments/${caseLabel}.json`),
    read(`canonical-inventories/${caseLabel}.json`),
    read(`evidence-inputs/${caseLabel}.json`),
    read('readiness-report.json')
  ]);
  const reportCandidate = (readinessReport.candidates || []).find(item => item.canonical_case_label === caseLabel);
  if (!reportCandidate) throw new Error(`Readiness report has no ${caseLabel} candidate.`);
  return { packageRoot: root, caseLabel, assignment, canonicalInventory, evidenceInput, reportCandidate };
}

export async function verifySmokeCandidatePackage({ packageRoot, caseLabel = 'case-01', candidateId } = {}) {
  const packageData = await loadSmokeCandidatePackage(packageRoot, caseLabel);
  return buildSmokeCandidateIdentity({ packageData, candidateId });
}
