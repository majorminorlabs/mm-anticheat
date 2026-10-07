import crypto from 'node:crypto';
import { TERRA_EVIDENCE_CONTRACT_VERSION, TERRA_EVIDENCE_MAX_RANGE_CHARACTERS, TERRA_EVIDENCE_ROLES } from './phase1-schemas.mjs';

export { TERRA_EVIDENCE_CONTRACT_VERSION };

const hash = value => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
const sourceText = source => String(source?.content ?? source?.text ?? source?.retained_text ?? '');
const failure = (message, details = {}) => {
  const error = new Error(message);
  error.code = 'PHASE2_SCHEMA_INVALID';
  error.details = { ...details, errors: [message, ...(details.errors || [])] };
  return error;
};

function validSurrogateBoundary(value, offset) {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

function assertEvidenceRange({ evidence, claim, source, claimIds, maxExcerptCharacters }) {
  const sourceId = evidence?.source_id;
  if (!source || !sourceId) throw failure(`Terra evidence for ${claim.claim_id} selected an unknown source ID: ${sourceId || '(missing)'}.`, { stage: 'research', source_id: sourceId || null, claim_id: claim.claim_id });
  if (!Number.isInteger(evidence.start_offset)) throw failure(`Terra evidence for ${claim.claim_id} has a non-integer start_offset.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, field: 'start_offset' });
  if (!Number.isInteger(evidence.end_offset)) throw failure(`Terra evidence for ${claim.claim_id} has a non-integer end_offset.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, field: 'end_offset' });
  if (evidence.start_offset < 0) throw failure(`Terra evidence for ${claim.claim_id} has a negative start_offset.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, start_offset: evidence.start_offset });
  if (evidence.end_offset <= evidence.start_offset) throw failure(`Terra evidence for ${claim.claim_id} has a reversed or zero-length range.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, start_offset: evidence.start_offset, end_offset: evidence.end_offset });
  if (evidence.end_offset > sourceText(source).length) throw failure(`Terra evidence for ${claim.claim_id} ends beyond the frozen source text.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, end_offset: evidence.end_offset, source_length: sourceText(source).length });
  const retainedText = sourceText(source);
  if (!validSurrogateBoundary(retainedText, evidence.start_offset) || !validSurrogateBoundary(retainedText, evidence.end_offset)) throw failure(`Terra evidence for ${claim.claim_id} splits a Unicode surrogate pair.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, start_offset: evidence.start_offset, end_offset: evidence.end_offset });
  const excerpt = retainedText.slice(evidence.start_offset, evidence.end_offset);
  if (!excerpt.trim()) throw failure(`Terra evidence for ${claim.claim_id} selects a blank range.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId });
  if (excerpt.length > maxExcerptCharacters) throw failure(`Terra evidence for ${claim.claim_id} exceeds the ${maxExcerptCharacters}-character excerpt limit.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, excerpt_length: excerpt.length, max_excerpt_characters: maxExcerptCharacters });
  if (!Array.isArray(evidence.claim_ids) || evidence.claim_ids.length < 1 || evidence.claim_ids.length > 20 || evidence.claim_ids.some(id => typeof id !== 'string' || !id.trim())) throw failure(`Terra evidence for ${claim.claim_id} has invalid claim_ids.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId });
  if (evidence.claim_ids.some(id => !claimIds.has(id))) throw failure(`Terra evidence for ${claim.claim_id} references a nonexistent claim ID.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, claim_ids: evidence.claim_ids });
  if (!evidence.claim_ids.includes(claim.claim_id)) throw failure(`Terra evidence for ${claim.claim_id} does not reference its owning claim.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, claim_ids: evidence.claim_ids });
  if (!TERRA_EVIDENCE_ROLES.includes(evidence.evidence_role)) throw failure(`Terra evidence for ${claim.claim_id} has an invalid evidence_role.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId, evidence_role: evidence.evidence_role });
  if (typeof evidence.reason !== 'string' || !evidence.reason.trim() || evidence.reason.length > 500) throw failure(`Terra evidence for ${claim.claim_id} has an invalid reason.`, { stage: 'research', claim_id: claim.claim_id, source_id: sourceId });
  return {
    source_id: sourceId,
    start_offset: evidence.start_offset,
    end_offset: evidence.end_offset,
    range_length: evidence.end_offset - evidence.start_offset,
    excerpt,
    excerpt_sha256: hash(excerpt),
    source_text_sha256: hash(retainedText),
    claim_ids: [...evidence.claim_ids],
    evidence_role: evidence.evidence_role,
    reason: evidence.reason
  };
}

export function validateTerraEvidenceOffsets(terra, inventorySources, { maxExcerptCharacters = TERRA_EVIDENCE_MAX_RANGE_CHARACTERS } = {}) {
  const sources = Array.isArray(inventorySources) ? inventorySources : [];
  const byId = new Map(sources.map(source => [source.id || source.source_id, source]));
  const selected = [...new Set([...(terra.selected_source_ids || []), ...(terra.optional_source_ids || [])])];
  const unknownSelected = selected.filter(id => !byId.has(id));
  if (unknownSelected.length) throw failure(`Terra selected unknown source IDs: ${unknownSelected.join(', ')}`, { stage: 'research', unknownSelected });
  const claims = Array.isArray(terra.claims) ? terra.claims : [];
  const claimIds = new Set(claims.map(claim => claim?.claim_id).filter(Boolean));
  for (const claimTarget of terra.claim_targets || []) if (!claimIds.has(claimTarget)) throw failure(`Terra claim_targets references a nonexistent claim ID: ${claimTarget}.`, { stage: 'research', claim_id: claimTarget });
  const derivedClaims = claims.map(claim => {
    if (!Array.isArray(claim.evidence) || claim.evidence.length < 1 || claim.evidence.length > 8) throw failure(`Terra claim ${claim.claim_id} must contain one to eight offset evidence records.`, { stage: 'research', claim_id: claim.claim_id });
    return { ...claim, evidence: claim.evidence.map(evidence => assertEvidenceRange({ evidence, claim, source: byId.get(evidence?.source_id), claimIds, maxExcerptCharacters })) };
  });
  const validateSourceIds = (items, label) => items.forEach(item => (item.source_ids || []).forEach(sourceId => { if (!byId.has(sourceId)) throw failure(`Terra ${label} ${item[`${label}_id`] || item.claim_id || ''} selected unknown source ${sourceId}.`, { stage: 'research', source_id: sourceId, label }); }));
  validateSourceIds(derivedClaims, 'claim');
  validateSourceIds(terra.required_facts || [], 'fact');
  for (const contradiction of terra.contradictions || []) {
    if (!claimIds.has(contradiction.claim_id)) throw failure(`Terra contradiction ${contradiction.contradiction_id || ''} references a nonexistent claim ID: ${contradiction.claim_id}.`, { stage: 'research', claim_id: contradiction.claim_id, contradiction_id: contradiction.contradiction_id || null });
    for (const sourceId of contradiction.source_ids || []) if (!byId.has(sourceId)) throw failure(`Terra contradiction ${contradiction.contradiction_id || ''} selected unknown source ${sourceId}.`, { stage: 'research', source_id: sourceId, contradiction_id: contradiction.contradiction_id || null });
  }
  for (const item of terra.ledgers?.quotations || []) if (!byId.has(item.source_id)) throw failure(`Terra quote selected unknown source ${item.source_id}.`, { stage: 'research', source_id: item.source_id });
  for (const item of terra.ledgers?.proper_names || []) if (!byId.has(item.source_id)) throw failure(`Terra proper name selected unknown source ${item.source_id}.`, { stage: 'research', source_id: item.source_id });
  for (const item of terra.ledgers?.numbers || []) if (!byId.has(item.source_id)) throw failure(`Terra number selected unknown source ${item.source_id}.`, { stage: 'research', source_id: item.source_id });
  if (!selected.length) {
    const error = failure('Terra selected no usable source IDs.', { stage: 'research' });
    error.code = 'PHASE2_RESEARCH_BLOCKED';
    throw error;
  }
  return { ...terra, claims: derivedClaims, terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION };
}
