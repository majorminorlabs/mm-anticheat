import test from 'node:test';
import assert from 'node:assert/strict';
import { homepageSectionGroups, rankHomepageStories, scoreHomepageStory, topicKey } from '../src/homepage-ranking.mjs';

const now = new Date('2026-08-07T12:00:00.000Z');
const story = (id, overrides = {}) => ({
  id,
  title: `Story ${id}`,
  dek: 'A useful dek.',
  body: 'A written story with evidence and a point.',
  section_id: 'products',
  status: 'published',
  published_at: '2026-08-07T10:00:00.000Z',
  editorial_score: 7,
  story_tags: [{ tags: { slug: 'shared-topic' } }],
  story_beats: [],
  ...overrides
});

test('homepage score combines editorial quality, freshness, interest, section relevance, promotion, and saturation', () => {
  const metrics = scoreHomepageStory(story('one'), now, 4);
  assert.equal(metrics.editorial, 7);
  assert.ok(metrics.freshness > 9);
  assert.equal(metrics.broadInterest, 4);
  assert.equal(metrics.sectionRelevance, 8);
  assert.equal(metrics.promotion, 0);
  assert.equal(metrics.saturationPenalty, 4);
  assert.ok(metrics.score > 50);
});

test('forced lead wins, while automatic featured selection caps a saturated topic', () => {
  const stories = [
    story('lead', { editorial_score: 2, promotion_override: 'lead', ranking_state: 'manual' }),
    ...['a', 'b', 'c', 'd'].map((id, index) => story(id, { editorial_score: 10 - index })),
    story('different', { editorial_score: 6, story_tags: [{ tags: { slug: 'different-topic' } }] })
  ];
  const result = rankHomepageStories(stories, { now });
  assert.equal(result.lead.id, 'lead');
  assert.deepEqual(result.featured.map(item => item.id), ['a', 'b', 'different']);
});

test('manual homepage choices can override saturation, and weak stories stay in latest', () => {
  const stories = [
    story('lead', { promotion_level: 'lead' }),
    story('manual-a', { editorial_score: 3, promotion_override: 'homepage', ranking_state: 'manual' }),
    story('manual-b', { editorial_score: 2, promotion_override: 'homepage', ranking_state: 'manual' }),
    story('weak', { editorial_score: 1 })
  ];
  const result = rankHomepageStories(stories, { now });
  assert.deepEqual(result.featured.map(item => item.id), ['manual-a', 'manual-b']);
  assert.ok(result.latest.some(item => item.id === 'weak'));
  assert.equal(topicKey(story('x')), 'shared-topic');
});

test('unwritten and unpublished stories never occupy premium slots', () => {
  const result = rankHomepageStories([
    story('draft', { status: 'draft', promotion_override: 'lead' }),
    story('empty', { body: '', promotion_override: 'lead' }),
    story('valid', { story_tags: [] })
  ], { now });
  assert.equal(result.lead.id, 'valid');
});

test('homepage sections retain every filed story and lead with the most recent', () => {
  const groups = homepageSectionGroups([
    story('older', { section_id: 'digital-collectibles', published_at: '2026-08-07T08:00:00.000Z' }),
    story('newest', { section_id: 'digital-collectibles', published_at: '2026-08-07T11:00:00.000Z' }),
    story('middle', { section_id: 'digital-collectibles', published_at: '2026-08-07T10:00:00.000Z' }),
    story('defi', { section_id: 'defi' })
  ], [{ id: 'digital-collectibles' }, { id: 'defi' }]);
  assert.deepEqual(groups[0].xs.map(item => item.id), ['newest', 'middle', 'older']);
  assert.deepEqual(groups[1].xs.map(item => item.id), ['defi']);
});
