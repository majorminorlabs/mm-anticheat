import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIdeaPitchesPrompt, mockIdeaPitches, parseIdeaPitches } from '../src/pipeline/idea-pitches.mjs';

const pitch = (position, headline) => ({
  position,
  headline,
  angle: 'A distinct angle that explains the change rather than repeating the announcement.',
  why_now: 'A current trigger makes this worth researching now.',
  audience: 'Readers following Web3 products and culture.',
  primary_section: 'products',
  topics: ['wallets'],
  recommended_length: 'standard',
  research_limitation: 'Verify the primary source and current user evidence.',
  primary_source: '',
  source_urls: [],
  confidence: 5,
  newness: 6,
  editorial_score: 7,
  ready_now: false,
  reasoning_summary: 'The angle tests a concrete change with an identifiable audience.',
  significance_tests: ['changes what people can do', 'explains why a person, company, movement, or object matters']
});

test('idea pitch prompt names the Web3 contract without exposing private reasoning', () => {
  const prompt = buildIdeaPitchesPrompt({ idea: 'Something interesting about RWAs.' });
  assert.match(prompt, /3 to 5 distinct/);
  assert.match(prompt, /digital-collectibles, defi, markets, chains, products, culture, memecoins/);
  assert.match(prompt, /never private chain-of-thought/);
});

test('idea pitch parser enforces the bounded distinct pitch set', () => {
  const parsed = parseIdeaPitches(JSON.stringify({ pitches: [1, 2, 3].map((position) => pitch(position, `Headline ${position}`)) }));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map(item => item.position), [1, 2, 3]);
  assert.throws(() => parseIdeaPitches(JSON.stringify({ pitches: [pitch(1, 'Same'), pitch(2, 'Same'), pitch(3, 'Third')] })));
});

test('local idea preview is explicit and never supplies fictional source URLs', () => {
  const previews = mockIdeaPitches('Something interesting about RWAs.');
  assert.equal(previews.length, 3);
  assert.ok(previews.every(item => item.source_urls.length === 0 && item.ready_now === false));
  assert.ok(previews.every(item => ['digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture', 'memecoins'].includes(item.primary_section)));
});
