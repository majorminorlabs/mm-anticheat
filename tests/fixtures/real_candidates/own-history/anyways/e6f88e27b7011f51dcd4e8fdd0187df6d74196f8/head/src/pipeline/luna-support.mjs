import { stableJson } from './evidence-packet.mjs';
import { lunaTreatmentContract } from './luna-claim-contract.mjs';

const clean = value => String(value ?? '').trim();

/**
 * Build the only claim-to-evidence allow-list Luna may use. The matrix is
 * derived from the frozen packet, contains required claims only, and is
 * stable across prompt construction, validation, and audit artifacts.
 */
export function deterministicClaimEvidenceSupportMatrix(packet = {}) {
  const claims = Array.isArray(packet.claims) ? packet.claims : [];
  const claimById = new Map(claims.map(claim => [clean(claim.claim_id), claim]).filter(([id]) => id));
  const requiredClaimIds = [...new Set(
    (Array.isArray(packet.claim_targets) && packet.claim_targets.length
      ? packet.claim_targets
      : claims.filter(claim => claim.required !== false).map(claim => claim.claim_id))
      .map(clean)
      .filter(claimById.has.bind(claimById))
  )].sort();
  const evidenceByClaim = new Map(requiredClaimIds.map(claimId => [claimId, new Set()]));
  for (const claim of claims) {
    for (const evidence of Array.isArray(claim.evidence) ? claim.evidence : []) {
      const evidenceId = clean(evidence?.evidence_id);
      if (!evidenceId) continue;
      for (const claimId of Array.isArray(evidence?.claim_ids) ? evidence.claim_ids.map(clean) : []) {
        if (evidenceByClaim.has(claimId)) evidenceByClaim.get(claimId).add(evidenceId);
      }
    }
  }
  return Object.fromEntries(requiredClaimIds.map(claimId => [claimId, [...evidenceByClaim.get(claimId)].sort()]));
}

export function serializedClaimEvidenceSupportMatrix(packet = {}) {
  return stableJson(deterministicClaimEvidenceSupportMatrix(packet));
}

export function deterministicClaimSupportContract(packet = {}) {
  return lunaTreatmentContract(packet, deterministicClaimEvidenceSupportMatrix(packet));
}

export function supportMatrixExamples(matrix = {}) {
  const claimIds = Object.keys(matrix).sort();
  const validClaimId = claimIds.find(claimId => (matrix[claimId]?.allowed_evidence_ids || matrix[claimId] || []).length) || claimIds[0] || 'claim-001';
  const validEvidenceId = (matrix[validClaimId]?.allowed_evidence_ids || matrix[validClaimId] || [])[0] || 'evidence-001';
  const requiredTreatment = matrix[validClaimId]?.required_treatment || 'paraphrase';
  return {
    valid: [
      { claim_id: validClaimId, evidence_ids: [validEvidenceId], article_anchor: 'paragraph-1', treatment: requiredTreatment },
      { claim_id: validClaimId, evidence_ids: [validEvidenceId], article_anchor: 'paragraph-2', treatment: requiredTreatment }
    ],
    invalid: [
      { claim_id: validClaimId, evidence_ids: [validEvidenceId], article_anchor: 'paragraph-1', treatment: requiredTreatment },
      { claim_id: validClaimId, evidence_ids: [validEvidenceId], article_anchor: 'paragraph-2', treatment: requiredTreatment === 'paraphrase' ? 'context' : 'paraphrase' }
    ]
  };
}
