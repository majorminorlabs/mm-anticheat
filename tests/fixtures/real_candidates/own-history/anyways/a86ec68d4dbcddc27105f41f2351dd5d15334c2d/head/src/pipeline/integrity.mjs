export const REVIEW_PACKAGE_INTEGRITY_FAILED = 'REVIEW_PACKAGE_INTEGRITY_FAILED';

export function documentsForCandidateRun(state, candidateId, runId) {
  return (state.documents || []).filter(document => document.candidate_id === candidateId && document.processing_run_id === runId);
}

const words = value => new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);

export function sourceRetention(candidate, document) {
  if (document.url === candidate.url || document.canonical_url === candidate.url) return { score: 100, reason: 'candidate_canonical_url' };
  const subject = words(`${candidate.title} ${candidate.description || ''}`);
  const source = words(`${document.title} ${document.content || ''}`);
  const shared = [...subject].filter(word => source.has(word));
  return { score: shared.length * 20, reason: shared.length ? `subject_overlap:${shared.slice(0, 4).join(',')}` : 'no_subject_overlap' };
}

export function validateReviewPackage({ candidate, run, documents = [], review }) {
  const errors = [];
  if (!candidate || !run || !review) return { ok: false, code: REVIEW_PACKAGE_INTEGRITY_FAILED, errors: ['candidate, run, and review are required'] };
  if (run.candidate_id !== candidate.id) errors.push('run candidate does not match package candidate');
  if (review.candidate_id !== candidate.id || review.processing_run_id !== run.id) errors.push('review ownership does not match candidate run');
  const ids = new Set(); const urls = new Set();
  for (const document of documents) {
    if (document.candidate_id !== candidate.id || document.processing_run_id !== run.id) errors.push(`document ${document.id} belongs to another candidate or run`);
    if (ids.has(document.id)) errors.push(`duplicate document id ${document.id}`); ids.add(document.id);
    const canonical = document.canonical_url || document.url;
    if (urls.has(canonical)) errors.push(`duplicate document URL ${canonical}`); urls.add(canonical);
    if (!document.retention?.reason || Number(document.retention.score) <= 0) errors.push(`document ${document.id} has no retained relevance`);
  }
  const listed = new Set(review.document_ids || []);
  if (listed.size !== ids.size || [...ids].some(id => !listed.has(id))) errors.push('review document set does not match candidate run documents');
  for (const claim of review.claims || []) {
    if (claim.candidate_id !== candidate.id || claim.processing_run_id !== run.id) errors.push(`claim ownership mismatch: ${claim.claim}`);
    if (!(claim.source_ids || []).length) errors.push(`orphan claim: ${claim.claim}`);
    for (const sourceId of claim.source_ids || []) if (!ids.has(sourceId)) errors.push(`claim references foreign or missing document ${sourceId}`);
  }
  for (const image of review.images || []) {
    if (image.candidate_id !== candidate.id || image.processing_run_id !== run.id) errors.push(`image ownership mismatch: ${image.original_url}`);
    if (image.source_document_id && !ids.has(image.source_document_id)) errors.push(`image references foreign document ${image.source_document_id}`);
  }
  return { ok: errors.length === 0, code: errors.length ? REVIEW_PACKAGE_INTEGRITY_FAILED : null, errors };
}
