export const PIPELINE_QUEUE_STATUSES = Object.freeze(['ready_for_review', 'revision_requested', 'approved', 'rejected_by_editor', 'archived']);
export function pipelineMetadata(candidate = {}) {
  const c = candidate.classification || {};
  return { section: c.primary_section || candidate.section_id || '', beats: c.recurring_beats || [], tags: c.tags || [], status: candidate.status, createdAt: candidate.created_at, unresolvedClaims: Number(candidate.unresolved_claim_count || 0), sourceCount: Number(candidate.source_count || 0), rightsWarnings: Number(candidate.rights_warning_count || 0) };
}
export function filterPipelineQueue(items, filters = {}) {
  return items.filter(item => { const meta = pipelineMetadata(item); return (!filters.section || meta.section === filters.section) && (!filters.beat || meta.beats.includes(filters.beat)) && (!filters.tag || meta.tags.includes(filters.tag)) && (!filters.status || meta.status === filters.status); });
}
export function lineDiff(previous = '', next = '') {
  const oldLines = String(previous).split('\n'), newLines = String(next).split('\n');
  const rows = []; const length = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < length; i++) { if (oldLines[i] === newLines[i]) rows.push({ type: 'same', text: oldLines[i] || '' }); else { if (oldLines[i] !== undefined) rows.push({ type: 'removed', text: oldLines[i] }); if (newLines[i] !== undefined) rows.push({ type: 'added', text: newLines[i] }); } }
  return rows;
}
