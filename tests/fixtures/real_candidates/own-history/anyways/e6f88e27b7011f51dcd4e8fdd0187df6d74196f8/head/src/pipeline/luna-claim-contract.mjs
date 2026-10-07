export const LUNA_TREATMENT_TYPES = Object.freeze(['paraphrase', 'direct_quote', 'context']);

const treatmentSet = new Set(LUNA_TREATMENT_TYPES);

/**
 * Older frozen packets do not carry treatment assignments. Their deterministic
 * production default is paraphrase. A packet may explicitly assign another
 * treatment without changing model output at validation time.
 */
export function requiredTreatmentForClaim(packet = {}, claimId) {
  const declared = packet.claim_treatments?.[claimId] || packet.claims?.find(claim => claim.claim_id === claimId)?.required_treatment;
  return declared || 'paraphrase';
}

export function isLunaTreatment(value) {
  return treatmentSet.has(value);
}

export function lunaTreatmentContract(packet = {}, supportMatrix = {}) {
  return Object.fromEntries(Object.keys(supportMatrix).sort().map(claimId => [claimId, {
    allowed_evidence_ids: [...(supportMatrix[claimId] || [])],
    required_treatment: requiredTreatmentForClaim(packet, claimId)
  }]));
}
