export const PROMOTION_LEVELS = Object.freeze(['none', 'latest', 'section', 'homepage', 'lead']);
export const HOMEPAGE_LIMITS = Object.freeze({ featured: 4, section: 3, topicCap: 2 });

const PROMOTION_POINTS = Object.freeze({ none: 0, latest: 2, section: 5, homepage: 8, lead: 10 });
const HOURS = 60 * 60 * 1000;

export function isPublishableStory(story, now = new Date()) {
  if (!story || story.status !== 'published' || !story.published_at) return false;
  const publishedAt = new Date(story.published_at);
  return !Number.isNaN(publishedAt.getTime()) && publishedAt <= now
    && Boolean(String(story.title || '').trim())
    && Boolean(String(story.dek || '').trim())
    && Boolean(String(story.body || '').trim())
    && Boolean(String(story.section_id || '').trim());
}

export function freshnessScore(publishedAt, now = new Date()) {
  const ageHours = Math.max(0, (now.getTime() - new Date(publishedAt).getTime()) / HOURS);
  return Math.max(0, Math.min(10, 10 * Math.exp(-ageHours / (24 * 7))));
}

function nestedSlugs(story, relation, key) {
  return (story?.[relation] || []).map(item => item?.[key]?.slug || item?.slug).filter(Boolean);
}

export function topicKey(story) {
  const topic = [...nestedSlugs(story, 'story_tags', 'tags'), ...nestedSlugs(story, 'story_beats', 'beats')][0];
  if (topic) return topic;
  return String(story?.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'untitled';
}

export function promotionLevel(story) {
  const level = story?.promotion_override || story?.promotion_level;
  return PROMOTION_LEVELS.includes(level) ? level : 'none';
}

export function scoreHomepageStory(story, now = new Date(), topicCount = 1) {
  const editorial = Math.max(0, Math.min(10, Number(story?.editorial_score ?? story?.local_editorial_score ?? 5) || 5));
  const freshness = freshnessScore(story.published_at, now);
  const tagCount = nestedSlugs(story, 'story_tags', 'tags').length;
  const beatCount = nestedSlugs(story, 'story_beats', 'beats').length;
  const broadInterest = Math.min(10, 3 + Math.min(4, tagCount) + Math.min(2, beatCount * 0.5) + (story.article_length === 'feature' ? 1 : 0));
  const readerInterest = Math.min(3, Math.log1p(Math.max(0, Number(story?.engagement_count) || 0)));
  const broadReaderInterest = Math.min(10, broadInterest + readerInterest);
  const sectionRelevance = story.section_id ? (['products', 'markets', 'chains', 'culture', 'defi', 'digital-collectibles', 'memecoins'].includes(story.section_id) ? 8 : 5) : 0;
  const promotion = PROMOTION_POINTS[promotionLevel(story)];
  const saturationPenalty = Math.min(12, Math.max(0, topicCount - 2) * 2);
  const score = editorial * 4.5 + freshness * 2 + broadReaderInterest * 1.5 + sectionRelevance + promotion * 0.5 - saturationPenalty;
  return {
    editorial,
    freshness,
    broadInterest: broadReaderInterest,
    sectionRelevance,
    promotion,
    saturationPenalty,
    score,
    topic: topicKey(story),
    manual: story?.ranking_state === 'manual' || Boolean(story?.promotion_override) || story?.is_pinned === true
  };
}

function compareCandidates(a, b) {
  return (Number(b.metrics.manual) - Number(a.metrics.manual))
    || (Number(b.metrics.score) - Number(a.metrics.score))
    || (new Date(b.story.published_at) - new Date(a.story.published_at))
    || String(a.story.id || a.story.slug).localeCompare(String(b.story.id || b.story.slug));
}

export function rankHomepageStories(stories, { now = new Date(), featuredLimit = HOMEPAGE_LIMITS.featured, sectionLimit = HOMEPAGE_LIMITS.section, topicCap = HOMEPAGE_LIMITS.topicCap } = {}) {
  const publishable = (stories || []).filter(story => isPublishableStory(story, now));
  const topicCounts = new Map();
  publishable.forEach(story => topicCounts.set(topicKey(story), (topicCounts.get(topicKey(story)) || 0) + 1));
  const candidates = publishable.map(story => ({ story, metrics: scoreHomepageStory(story, now, topicCounts.get(topicKey(story)) || 1) }));
  const ranked = candidates.slice().sort(compareCandidates);
  const forcedLead = ranked.filter(item => promotionLevel(item.story) === 'lead');
  const lead = (forcedLead[0] || ranked[0])?.story || null;
  const used = new Set(lead ? [lead.id] : []);
  const featuredTopicCounts = new Map();
  const featured = [];
  for (const candidate of ranked) {
    if (used.has(candidate.story.id) || featured.length >= featuredLimit) continue;
    const count = featuredTopicCounts.get(candidate.metrics.topic) || 0;
    if (!candidate.metrics.manual && count >= topicCap) continue;
    featured.push(candidate.story);
    used.add(candidate.story.id);
    featuredTopicCounts.set(candidate.metrics.topic, count + 1);
  }
  const sections = new Map();
  const sectionIds = [...new Set(publishable.map(story => story.section_id).filter(Boolean))];
  for (const sectionId of sectionIds) {
    const sectionStories = ranked.filter(candidate => candidate.story.section_id === sectionId && !used.has(candidate.story.id)).slice(0, sectionLimit).map(candidate => candidate.story);
    if (sectionStories.length) sections.set(sectionId, sectionStories);
  }
  const placements = new Map();
  if (lead) placements.set(lead.id, 'lead');
  featured.forEach(story => placements.set(story.id, 'homepage'));
  for (const storiesForSection of sections.values()) storiesForSection.forEach(story => placements.set(story.id, 'section'));
  return {
    lead,
    featured,
    latest: publishable.slice().sort((a, b) => new Date(b.published_at) - new Date(a.published_at)),
    sections,
    placements,
    diagnostics: ranked.map((candidate, index) => ({ ...candidate, overallRank: index + 1, placement: placements.get(candidate.story.id) || 'latest' }))
  };
}

// The edition's lead and Featured rail are editorial promotion. They must not
// make a filed story disappear from its own section on the homepage.
export function homepageSectionGroups(stories, sections) {
  return (sections || []).map(sec => ({
    sec,
    xs: (stories || [])
      .filter(story => story.section_id === sec.id || (story.story_sections || []).some(item => (item.section_id || item.sections?.slug) === sec.id))
      .slice()
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
  })).filter(group => group.xs.length);
}
