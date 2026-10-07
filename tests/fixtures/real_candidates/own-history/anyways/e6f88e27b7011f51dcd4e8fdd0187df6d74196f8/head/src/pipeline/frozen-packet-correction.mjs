import crypto from 'node:crypto';
import { EVIDENCE_PACKET_LIMITS, stableJson } from './evidence-packet.mjs';
import { sourceSufficiencyGate } from './phase2-source-gate.mjs';
import { hashPhase2Inventory } from './phase2-inventory.mjs';

export const FROZEN_PACKET_CORRECTION_VERSION = 'source-classification-correction-v1';
export const CORRECTED_PACKET_VERSION = 'pipeline-v1-evidence-packet-offsets-v2';

const sha256 = value => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
const clean = value => String(value ?? '').trim();

function sourceClassification(source = {}) {
  const url = clean(source.url || source.canonical_url).toLowerCase();
  const title = clean(source.title).toLowerCase();
  if (url.includes('reddit.com/')) return { classification: 'commentary', primary_source: false, reason: 'Reddit community discussion is user-generated commentary.' };
  if (url.includes('facebook.com/')) return { classification: 'commentary', primary_source: false, reason: 'Facebook post is social-platform material, not reported journalism.' };
  if (url.includes('discussions.apple.com/')) return { classification: 'commentary', primary_source: false, reason: 'Apple Community thread is community/support discussion.' };
  if (url.includes('tenorshare.com/')) return { classification: 'commentary', primary_source: false, reason: 'Tenorshare page is commercial/vendor guidance.' };
  if (url.includes('protectyoungeyes.com/')) return { classification: 'commentary', primary_source: false, reason: 'Protect Young Eyes page is advocacy/advice commentary.' };
  if (url.includes('mindgems.com/products/boss-key/')) return { classification: 'primary', primary_source: true, reason: 'Boss Key page is the official product documentation identified by the product URL.' };
  if (url.includes('password-locker.com/')) return { classification: 'commentary', primary_source: false, reason: 'Password Locker page is vendor/consumer guidance rather than independent reporting.' };
  if (url.includes('techcrunch.com/')) return { classification: 'original_reporting', primary_source: false, reason: 'TechCrunch URL is retained editorial reporting.' };
  return { classification: source.classification || 'commentary', primary_source: source.primary_source === true, reason: 'Existing classification preserved because no deterministic correction rule applies.' };
}

function evidenceClaims(packet, sourceId) {
  return (packet.claims || []).filter(claim => (claim.evidence || []).some(evidence => evidence.source_id === sourceId)).map(claim => claim.claim_id).filter(Boolean);
}

function packetChecksum(packet) {
  const { checksum: _checksum, frozen_evidence_packet_sha256: _frozenChecksum, ...payload } = packet;
  return sha256(stableJson(payload));
}

function correctedDocument(document, correction) {
  return {
    ...document,
    classification: correction.classification,
    source_type: correction.classification,
    primary_source: correction.primary_source
  };
}

export function refreezeCorrectedFrozenPacket({ packet, candidate, documents = [], fetchDiagnostics = [], assignmentSha256 = null } = {}) {
  if (!packet?.frozen_evidence_packet_sha256) throw new Error('A frozen packet checksum is required.');
  const documentById = new Map(documents.map(document => [document.id || document.source_id, document]));
  const changes = [];
  const correctedSources = (packet.sources || []).map(source => {
    const document = documentById.get(source.source_id) || {};
    const correction = sourceClassification({ ...source, ...document });
    const previous = source.classification || source.source_type || null;
    const previousPrimary = source.primary_source === true;
    if (previous !== correction.classification || previousPrimary !== correction.primary_source) {
      changes.push({
        source_id: source.source_id,
        url: source.url || source.canonical_url || null,
        previous_classification: previous,
        corrected_classification: correction.classification,
        primary_source: correction.primary_source,
        independence_key: document.independence_key || source.independence_key || null,
        counts_toward_independent_minimum: Boolean(document.independence_key || source.independence_key),
        supported_claim_ids: evidenceClaims(packet, source.source_id),
        reason: correction.reason
      });
    }
    return { ...source, classification: correction.classification, primary_source: correction.primary_source };
  });
  const correctedById = new Map(correctedSources.map(source => [source.source_id, source]));
  const correctedDocuments = documents.map(document => correctedDocument(document, correctedById.get(document.id || document.source_id) || sourceClassification(document)));
  const sourceGate = sourceSufficiencyGate({ candidate, documents: correctedDocuments, fetchDiagnostics });
  const requiredClaimIds = packet.claim_targets?.length ? packet.claim_targets : (packet.claims || []).map(claim => claim.claim_id);
  const coveredClaimIds = new Set((packet.claims || []).filter(claim => (claim.evidence || []).length).map(claim => claim.claim_id));
  const missingClaims = requiredClaimIds.filter(claimId => !coveredClaimIds.has(claimId));
  const evidenceErrors = [];
  for (const claim of packet.claims || []) for (const evidence of claim.evidence || []) {
    const document = documentById.get(evidence.source_id);
    const start = evidence.start ?? evidence.start_offset;
    const end = evidence.end ?? evidence.end_offset;
    if (!document) evidenceErrors.push(`${claim.claim_id}:${evidence.evidence_id || 'evidence'} references an unknown source.`);
    else if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > String(document.content || '').length) evidenceErrors.push(`${claim.claim_id}:${evidence.evidence_id || 'evidence'} has an invalid retained-text range.`);
  }
  const assignmentChecksum = assignmentSha256 || sha256(stableJson(candidate?.commission || {}));
  const correctedInventorySha256 = hashPhase2Inventory({ candidateId: candidate?.id, assignmentSha256: assignmentChecksum, sources: correctedDocuments });
  const classificationChanges = changes.sort((left, right) => left.source_id.localeCompare(right.source_id));
  const correctedPacket = {
    ...packet,
    sources: correctedSources,
    version: CORRECTED_PACKET_VERSION,
    packet_revision: 2,
    supersedes_frozen_evidence_packet_sha256: packet.frozen_evidence_packet_sha256,
    classification_correction_version: FROZEN_PACKET_CORRECTION_VERSION,
    classification_changes: classificationChanges,
    corrected_inventory_sha256: correctedInventorySha256
  };
  correctedPacket.frozen_evidence_packet_sha256 = packetChecksum(correctedPacket);
  const packetCharacters = stableJson(correctedPacket).length;
  const gateErrors = [
    ...(sourceGate.ok ? [] : ['corrected source inventory failed the deterministic source gate']),
    ...(missingClaims.length ? [`missing required claims: ${missingClaims.join(', ')}`] : []),
    ...evidenceErrors,
    ...(packetCharacters > EVIDENCE_PACKET_LIMITS.maxPacketCharacters ? [`packet size ${packetCharacters} exceeds ${EVIDENCE_PACKET_LIMITS.maxPacketCharacters}`] : [])
  ];
  return {
    packet: correctedPacket,
    correctedDocuments,
    classificationChanges,
    correctedInventorySha256,
    sourceGate,
    missingClaims,
    evidenceErrors,
    packetCharacters,
    ok: gateErrors.length === 0,
    errors: gateErrors
  };
}
