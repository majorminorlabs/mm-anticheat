const HTTP_URL = /^https?:\/\/[^\s]+$/i;
const BAD_STATUS = new Set(['blocked', 'failed', 'rejected', 'mismatch', 'pending', 'unreviewed']);

export const SOURCE_REVIEW_STATES = Object.freeze(['pending', 'approved', 'rejected', 'legacy_unreviewed']);

export function normalizeSourceUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function sourceHost(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase(); } catch { return ''; }
}

function tokens(value) {
  return new Set(String(value || '').toLocaleLowerCase('en-US').split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 2));
}

export function sourceTopicOverlap(story, source) {
  const storyTokens = new Set([
    ...tokens(story?.title),
    ...tokens(story?.dek),
    ...tokens(story?.summary),
    ...((story?.story_beats || []).flatMap(item => [item?.beats?.name, item?.beats?.slug])),
    ...((story?.story_tags || []).flatMap(item => [item?.tags?.name, item?.tags?.slug]))
  ].flatMap(value => [...tokens(value)]));
  const sourceTokens = new Set([
    ...tokens(source?.title),
    ...tokens(source?.publisher),
    ...tokens(source?.url)
  ].flatMap(value => [...tokens(value)]));
  if (!storyTokens.size || !sourceTokens.size) return 0;
  let overlap = 0;
  for (const token of sourceTokens) if (storyTokens.has(token)) overlap += 1;
  return overlap / Math.max(1, Math.min(storyTokens.size, sourceTokens.size));
}

export function validateSourceRecord(source = {}, { now = new Date() } = {}) {
  const errors = [];
  const url = normalizeSourceUrl(source.url);
  if (!url || !HTTP_URL.test(url)) errors.push('source URL must be a complete HTTP(S) URL');
  if (!String(source.title || '').trim()) errors.push('source title is required');
  if (!String(source.publisher || '').trim()) errors.push('source publisher is required or must be explicitly marked not applicable');
  if (!String(source.source_type || '').trim()) errors.push('source class is required');
  if (!source.accessed_at) errors.push('source access date is required');
  if (!source.reviewed_at) errors.push('human source review is required');
  if (source.review_status && !SOURCE_REVIEW_STATES.includes(source.review_status)) errors.push('source review status is invalid');
  if (source.review_status !== 'approved') errors.push('source relevance review is not approved');
  if (source.http_status !== null && source.http_status !== undefined && (!Number.isInteger(Number(source.http_status)) || Number(source.http_status) < 200 || Number(source.http_status) >= 400)) {
    errors.push('source URL health is not successful');
  }
  if (source.last_checked_at && new Date(source.last_checked_at) > new Date(now)) errors.push('source last-checked time is in the future');
  if (source.claim_map !== undefined && source.claim_map !== null && !Array.isArray(source.claim_map) && typeof source.claim_map !== 'object') errors.push('claim-to-source mapping must be structured JSON');
  return { ok: errors.length === 0, errors, normalized_url: url, host: sourceHost(url) };
}

export function validateStorySources(story, sources = [], options = {}) {
  const rows = Array.isArray(sources) ? sources : [];
  const errors = [];
  const seen = new Set();
  let primaryCount = 0;
  for (const source of rows) {
    const result = validateSourceRecord(source, options);
    const overlap = sourceTopicOverlap(story, source);
    if (overlap < 0.04) errors.push({ source_id: source.id || null, code: 'topic_mismatch', message: 'source does not share a meaningful subject signal with the story', overlap });
    if (source.primary_source === true) primaryCount += 1;
    if (result.normalized_url && seen.has(result.normalized_url)) errors.push({ source_id: source.id || null, code: 'duplicate_url', message: 'duplicate source URL' });
    if (result.normalized_url) seen.add(result.normalized_url);
    for (const message of result.errors) errors.push({ source_id: source.id || null, code: 'source_incomplete', message });
  }
  if (!rows.length) errors.push({ code: 'no_sources', message: 'at least one source is required' });
  if (!primaryCount) errors.push({ code: 'no_primary_source', message: 'at least one source must be marked primary' });
  if (rows.some(source => BAD_STATUS.has(String(source.status || '').toLowerCase()))) errors.push({ code: 'source_blocked', message: 'a source has a blocked or failed health state' });
  return { ok: errors.length === 0, errors, source_count: rows.length, primary_count: primaryCount };
}
