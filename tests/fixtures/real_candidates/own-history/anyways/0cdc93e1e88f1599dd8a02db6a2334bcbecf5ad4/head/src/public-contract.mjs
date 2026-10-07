/*
 * The public contract is deliberately boring and explicit. Keep this list in
 * sync with the published_stories view migration; adding a column to stories
 * must never make it public by accident.
 */

export const PUBLIC_STORY_FIELDS = Object.freeze([
  'id',
  'title',
  'slug',
  'dek',
  'summary',
  'body',
  'section_id',
  'published_at',
  'materially_updated_at',
  'update_note',
  'reading_time_minutes',
  'article_format',
  'presentation',
  'seo_title',
  'seo_description',
  'social_title',
  'social_description',
  'sections',
  'story_sections',
  'story_beats',
  'story_tags',
  'hero_media'
]);

export const PUBLIC_STORY_SELECT = PUBLIC_STORY_FIELDS.join(',');
export const PUBLIC_STORY_LIST_SELECT = PUBLIC_STORY_FIELDS.filter(field => field !== 'body').join(',');

export const PUBLIC_PAGE_LIMIT = 20;
export const PUBLIC_HOME_LIMIT = 12;
export const PUBLIC_SEARCH_LIMIT = 20;
export const PUBLIC_CURSOR_MAX_LENGTH = 96;

export function clampPublicLimit(value, fallback = PUBLIC_PAGE_LIMIT, maximum = PUBLIC_PAGE_LIMIT) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, parsed);
}

export function cleanPublicQuery(value, max = 120) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizePublicJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function objectOrNull(value) {
  const parsed = normalizePublicJson(value, null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function arrayOrEmpty(value) {
  const parsed = normalizePublicJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function normalizePublicStory(row = {}) {
  const story = {};
  for (const field of PUBLIC_STORY_FIELDS) story[field] = row[field];
  story.sections = objectOrNull(row.sections);
  story.story_sections = arrayOrEmpty(row.story_sections);
  story.story_beats = arrayOrEmpty(row.story_beats);
  story.story_tags = arrayOrEmpty(row.story_tags);
  story.presentation = objectOrNull(row.presentation) || {};
  story.hero_media = objectOrNull(row.hero_media);
  story.status = 'published';
  return story;
}

export function normalizePublicStories(rows) {
  return Array.isArray(rows) ? rows.map(normalizePublicStory) : [];
}

export function encodePublicCursor(value) {
  const raw = cleanPublicQuery(value, PUBLIC_CURSOR_MAX_LENGTH);
  return raw ? encodeURIComponent(raw) : '';
}

export function decodePublicCursor(value) {
  const raw = cleanPublicQuery(value, PUBLIC_CURSOR_MAX_LENGTH);
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return ''; }
}

export function publicStoryPath(slug) {
  return `/stories/${encodeURIComponent(String(slug || ''))}`;
}

export function publicSectionPath(slug) {
  return `/sections/${encodeURIComponent(String(slug || ''))}`;
}

export function publicTopicPath(slug) {
  return `/topics/${encodeURIComponent(String(slug || ''))}`;
}
