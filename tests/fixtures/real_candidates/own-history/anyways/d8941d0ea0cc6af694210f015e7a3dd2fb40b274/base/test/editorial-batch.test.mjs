import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateSectionQuotas, deterministicNovelty, selectBatchCandidates } from '../src/editorial-batch.mjs';

test('rotating quota allocation preserves the batch target', () => {
  const weights = Object.fromEntries(['digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture'].map(section => [section, 1]));
  const first = allocateSectionQuotas(10, weights, 0), second = allocateSectionQuotas(10, weights, 1);
  assert.equal(Object.values(first).reduce((a, b) => a + b, 0), 10);
  assert.equal(Object.values(second).reduce((a, b) => a + b, 0), 10);
  assert.notDeepEqual(first, second);
});
test('novelty blocks identical canonical URLs and flags close topics', () => {
  assert.equal(deterministicNovelty({ title: 'A', url: 'https://example.test/a' }, [{ title: 'B', url: 'https://example.test/a?x=1' }]).decision, 'blocked');
  assert.equal(deterministicNovelty({ title: 'Chinese citizens use AI in daily life' }, [{ title: 'How Chinese citizens use AI in daily life', dek: '' }]).decision, 'review');
});
test('candidate selection observes quotas, beat caps, and novelty holds', () => {
  const result = selectBatchCandidates([{ title: 'one', section_id: 'products', beats: ['wallets'] }, { title: 'two', section_id: 'products', beats: ['wallets'] }, { title: 'three', section_id: 'products', beats: ['wallets'] }, { title: 'hold', section_id: 'culture', novelty: { decision: 'review' } }], { products: 3, culture: 1 }, 2);
  assert.equal(result.selected.length, 2); assert.equal(result.shortfalls.products, 1); assert.equal(result.shortfalls.culture, 1); assert.equal(result.excluded.length, 2);
});
