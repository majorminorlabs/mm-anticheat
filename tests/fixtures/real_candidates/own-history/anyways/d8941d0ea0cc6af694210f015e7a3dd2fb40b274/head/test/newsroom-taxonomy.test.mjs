import test from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR_STATUS_LABELS, NEWSROOM_LENSES, NEWSROOM_SECTIONS, editorStatusLabel, lensLabel, modelLabel, sectionLabel } from '../src/newsroom-taxonomy.mjs';

test('Newsroom exposes only canonical lenses and optional sections', () => {
  assert.deepEqual(NEWSROOM_LENSES.map(item => item.id), ['digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture', 'memecoins']);
  assert.equal(NEWSROOM_LENSES[0].name, 'NFTs');
  assert.deepEqual(NEWSROOM_SECTIONS.map(item => item.id), ['meanwhile', 'while-youre-here', 'worth-your-time', 'receipts', 'anyways', 'we-read-it']);
  assert.equal(NEWSROOM_SECTIONS.some(item => /builder|systems/i.test(item.name)), false);
});

test('current taxonomy values render as editor labels', () => {
  assert.equal(lensLabel('products'), 'Products');
  assert.equal(lensLabel('culture'), 'Culture');
  assert.equal(sectionLabel('worth-your-time'), 'Worth Your Time');
  assert.equal(sectionLabel('anyways'), 'Anyways...');
});

test('editor status and model labels hide implementation vocabulary', () => {
  assert.equal(editorStatusLabel('verification_failed'), 'Needs Attention');
  assert.equal(editorStatusLabel('ai_review_ready'), 'AI Review');
  assert.equal(modelLabel('gpt-5.6-luna', 'draft'), 'Luna High');
  assert.equal(modelLabel('gpt-5.6-terra', 'research'), 'Terra High');
  assert.equal(modelLabel('gpt-5.6-sol', 'polish'), 'Sol Medium');
  assert.equal(Object.values(EDITOR_STATUS_LABELS).some(value => /pipeline_version|provider|benchmark|holdout/i.test(value)), false);
});
