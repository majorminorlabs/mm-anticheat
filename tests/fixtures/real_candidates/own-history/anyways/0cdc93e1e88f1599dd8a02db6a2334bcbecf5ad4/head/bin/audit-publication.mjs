import { validateStorySources } from '../src/source-integrity.mjs';

const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const limit = Math.min(100, Math.max(1, Number(process.env.PUBLICATION_AUDIT_LIMIT || 50)));

if (!baseUrl || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the read-only publication audit.');
  process.exit(2);
}

const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
const get = async path => {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}) for ${path}`);
  return Array.isArray(payload) ? payload : [];
};

const query = new URLSearchParams({
  select: 'id,title,slug,dek,summary,story_beats,story_tags',
  order: 'published_at.desc',
  limit: String(limit)
});
const stories = await get(`/rest/v1/published_stories?${query}`);
const sourceQuery = new URLSearchParams({
  select: 'id,story_id,title,publisher,url,canonical_url,source_type,accessed_at,reviewed_at,source_review_status,http_status,last_checked_at,primary_source,claim_map',
  story_id: `in.(${stories.map(story => story.id).join(',')})`
});
const sources = stories.length ? await get(`/rest/v1/sources?${sourceQuery}`) : [];
const byStory = new Map();
for (const source of sources) {
  const rows = byStory.get(source.story_id) || [];
  rows.push({ ...source, review_status: source.source_review_status });
  byStory.set(source.story_id, rows);
}
const failures = stories.map(story => ({ story, result: validateStorySources(story, byStory.get(story.id) || []) })).filter(item => !item.result.ok);
const report = {
  ok: failures.length === 0,
  checked: stories.length,
  failed: failures.length,
  failures: failures.map(item => ({ id: item.story.id, slug: item.story.slug, errors: item.result.errors }))
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
