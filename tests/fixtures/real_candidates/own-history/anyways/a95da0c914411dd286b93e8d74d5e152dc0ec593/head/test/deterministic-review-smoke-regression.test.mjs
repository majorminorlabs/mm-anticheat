import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicReview } from '../src/pipeline/deterministic-review.mjs';

const draft = {
  headline: 'Restaurant Recommendations Are Becoming Social Objects Again',
  dek: 'The most useful dining tip is often a note about who a restaurant suits, not another star rating.',
  section: 'taste',
  beats: ['food', 'cities'],
  source_ids: ['source-002', 'source-005', 'source-006', 'source-007'],
  claim_support: [
    { claim_id: 'claim-retained-002', evidence_ids: ['evidence-002'], article_anchor: 'paragraph-3', treatment: 'paraphrase' },
    { claim_id: 'claim-retained-005', evidence_ids: ['evidence-005'], article_anchor: 'paragraph-5', treatment: 'paraphrase' },
    { claim_id: 'claim-retained-006', evidence_ids: ['evidence-006'], article_anchor: 'paragraph-5', treatment: 'paraphrase' },
    { claim_id: 'claim-retained-007', evidence_ids: ['evidence-007'], article_anchor: 'paragraph-6', treatment: 'paraphrase' }
  ],
  warnings: [],
  claims: [],
  body_markdown: `# Restaurant Recommendations Are Becoming Social Objects Again

*The most useful dining tip is often a note about who a restaurant suits, not another star rating.*

When someone asks for a restaurant recommendation, the practical facts are easy to search. What is harder to find is the detail that makes a suggestion useful for a particular person, mood, or occasion.

That is the premise behind Eater’s new dining-notes feature. The app lets users exchange restaurant notes, while Eater’s own examples focus on details about what to order and whether a place suits a specific outing, such as taking visiting parents. The feature places those annotations alongside saved venues and other app tools.

Eater’s broader app redesign makes the same argument at community scale. The product invites users to build profiles, follow editors and chefs, create and share lists, see where those people are eating, and book a meal. Its App Store description similarly emphasizes editor curation, connections with chefs and friends, personalized search, and shared lists.

The useful contrast is between a restaurant listing that tells everyone the same thing and a dining map built from someone’s actual habits. Zest, a newer discovery app, says it uses transaction data and AI to recommend restaurants based on where people actually eat, drink, or get coffee; it also creates a personal dining map from imported visits that others can follow.

That pattern is spreading beyond Eater. Tavola is built around saving restaurants from Maps, Yelp, Google Maps, or any website, organizing them into lists for occasions such as date nights and work lunches, and sharing those lists. Taste Buds describes a similar social loop: users can discover nearby recommendations from friends, save lists for cravings, trips, and cities, add notes, and follow friends’ favorite places.

The appetite for personal recommendations predates these products. A SevenRooms report based on YouGov research found that 54 percent of Americans relied on friends and family when discovering new restaurants. The report described personal recommendations as especially influential and connected social-media posts with word-of-mouth discovery.

Research on recommendation behavior adds a wrinkle. A study of friend recommendations and general ratings found that an additional rating star had a larger effect on a choice between two options than an additional friend recommendation. It also found that negative opinions from friends were more influential than positive ones, while lower-cost, lower-risk decisions produced more random behavior.

Together, these examples suggest that a restaurant recommendation can do two jobs at once: identify a place and explain its fit. A rating compresses judgment into a score. A note can preserve the occasion, the audience, and the reason the recommender thought of that place at all.

That is why the valuable layer in restaurant discovery is increasingly the exchange around the listing. The place still matters, but so does the small piece of social intelligence that helps someone decide whether it is right for tonight.`
};

const packet = {
  version: 'pipeline-v1-evidence-packet-v1',
  checksum: '406c5975e2416e78da22a737aa63d7d5484503b36dc602bd7cc1540872be8fac',
  frozen_evidence_packet_sha256: '406c5975e2416e78da22a737aa63d7d5484503b36dc602bd7cc1540872be8fac',
  sources: [
    { source_id: 'source-002', title: 'Eater', retained_text: 'Eater App - App Store Eater Restaurant recommendations Create and share: Browse Eater lists, make your own, and share your favorite spots with friends.' },
    { source_id: 'source-005', title: 'Tavola', retained_text: 'Tavola — Save restaurants you love. Save from anywhere Use the iOS Share Sheet to save a restaurant directly from Maps, Yelp, Google Maps, or any website.' },
    { source_id: 'source-006', title: 'Taste Buds', retained_text: 'Taste Buds — See where your friends love to eat. Follow your buds and see where they love to go.' },
    { source_id: 'source-007', title: 'Over Half of Americans Turn to Friends & Family to Find New Restaurants', retained_text: 'SevenRooms report found that over half of Americans (54%) rely on their friends and family to make a recommendation.', publisher: 'SevenRooms' }
  ],
  claims: [
    { claim_id: 'claim-retained-002', evidence: [{ evidence_id: 'evidence-002', source_id: 'source-002', start_offset: 0, end_offset: 141, excerpt: 'Eater App - App Store Eater Restaurant recommendations Create and share: Browse Eater lists, make your own, and share your favorite spots with friends.' }] },
    { claim_id: 'claim-retained-005', evidence: [{ evidence_id: 'evidence-005', source_id: 'source-005', start_offset: 0, end_offset: 154, excerpt: 'Tavola — Save restaurants you love. Save from anywhere Use the iOS Share Sheet to save a restaurant directly from Maps, Yelp, Google Maps, or any website.' }] },
    { claim_id: 'claim-retained-006', evidence: [{ evidence_id: 'evidence-006', source_id: 'source-006', start_offset: 0, end_offset: 77, excerpt: 'Taste Buds — See where your friends love to eat. Follow your buds and see where they love to go.' }] },
    { claim_id: 'claim-retained-007', evidence: [{ evidence_id: 'evidence-007', source_id: 'source-007', start_offset: 0, end_offset: 111, excerpt: 'SevenRooms report found that over half of Americans (54%) rely on their friends and family to make a recommendation.' }] }
  ],
  ledgers: { quotations: [], proper_names: [], numbers: [] },
  required_facts: [],
  prohibited_claims: [],
  draft_constraints: []
};

test('persisted smoke Draft clears only ledger omissions supported by linked frozen evidence', () => {
  const result = deterministicReview({ candidate: { commission: { story_form: 'meanwhile', section_id: 'taste', beats: ['food', 'cities'] } }, draft, packet });
  assert.equal(result.blocking_factual_errors.some(item => item.includes('54')), false);
  assert.equal(result.blocking_factual_errors.some(item => item.includes('Its App Store')), false);
  assert.equal(result.blocking_factual_errors.some(item => item.includes('Google Maps')), false);
  assert.equal(result.blocking_factual_errors.length, 0);
  assert.equal(packet.claims.find(claim => claim.claim_id === 'claim-retained-007').evidence[0].source_id, 'source-007');
  assert.equal(draft.claim_support.find(mapping => mapping.claim_id === 'claim-retained-007').article_anchor, 'paragraph-6');
  const persistedPacket = structuredClone(packet);
  persistedPacket.sources = persistedPacket.sources.map(({ source_id, title }) => ({ source_id, title }));
  for (const claim of persistedPacket.claims) for (const evidence of claim.evidence) evidence.end_offset = evidence.excerpt.length;
  const persistedShapeResult = deterministicReview({ candidate: { commission: { story_form: 'meanwhile', section_id: 'taste', beats: ['food', 'cities'] } }, draft, packet: persistedPacket });
  assert.equal(persistedShapeResult.blocking_factual_errors.length, 0);
});

test('number and proper-name allowances remain bounded to approved packet evidence', () => {
  const unsupportedNumber = deterministicReview({ candidate: { commission: { story_form: 'meanwhile' } }, draft: { ...draft, body_markdown: draft.body_markdown.replace('54 percent', '55 percent') }, packet });
  assert.ok(unsupportedNumber.blocking_factual_errors.some(item => item.includes('55')));
  const unsupportedName = deterministicReview({ candidate: { commission: { story_form: 'meanwhile' } }, draft: { ...draft, body_markdown: draft.body_markdown.replace('Google Maps', 'Unapproved Product') }, packet });
  assert.ok(unsupportedName.blocking_factual_errors.some(item => item.includes('Unapproved Product')));
});
