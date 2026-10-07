import test from 'node:test';
import assert from 'node:assert/strict';
import { BEAT_ORDER, EDITORIAL_PROMPT_DOCTRINE, SECTION_ORDER, SECTION_PROMISES, SECTIONS, STORY_FORMS } from '../src/editorial.mjs';

test('editorial doctrine has exactly the approved primary sections', () => {
  assert.deepEqual(SECTION_ORDER, ['digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture', 'memecoins']);
  assert.equal(SECTIONS.find(section => section.slug === 'digital-collectibles')?.name, 'NFTs');
  assert.deepEqual(Object.keys(SECTION_PROMISES), SECTION_ORDER);
});

test('recurring beats remain controlled while Memecoins is also a full section', () => {
  assert.deepEqual(BEAT_ORDER, ['ethereum', 'bitcoin', 'solana', 'base', 'hyperliquid', 'robinhood-chain', 'nfts', 'digital-art', 'gaming-assets', 'wallets', 'stablecoins', 'rwas', 'memecoins', 'founders', 'communities', 'brands', 'infrastructure', 'prediction-markets', 'security']);
  assert.ok(BEAT_ORDER.includes('memecoins'));
});

test('story forms preserve their distinct word ranges and source floors', () => {
  assert.deepEqual(STORY_FORMS.map(form => form.id), ['meanwhile', 'while-youre-here', 'worth-your-time', 'receipts', 'anyways', 'we-read-it']);
  for (const form of STORY_FORMS) {
    assert.ok(form.minimum < form.target && form.target < form.maximum);
    assert.ok(form.minimumSources >= 3);
    assert.match(EDITORIAL_PROMPT_DOCTRINE, new RegExp(form.name.replace(/[.]/g, '\\.')));
  }
});

test('shared prompt doctrine preserves the lens, subject, and significance rules', () => {
  for (const section of SECTIONS) assert.match(EDITORIAL_PROMPT_DOCTRINE, new RegExp(section.name));
  for (const beat of BEAT_ORDER) assert.match(EDITORIAL_PROMPT_DOCTRINE, new RegExp(beat));
  assert.match(EDITORIAL_PROMPT_DOCTRINE, /exactly one primary section/);
  assert.match(EDITORIAL_PROMPT_DOCTRINE, /at least two tests/);
  assert.match(EDITORIAL_PROMPT_DOCTRINE, /significanceRationale/);
  assert.match(EDITORIAL_PROMPT_DOCTRINE, /coreQuestion/);
});

test('representative pitches classify to one lens and one or more subjects', () => {
  const examples = [
    { primarySection: 'digital-collectibles', beats: ['nfts', 'digital-art'] },
    { primarySection: 'defi', beats: ['stablecoins', 'infrastructure'] },
    { primarySection: 'markets', beats: ['bitcoin', 'prediction-markets'] },
    { primarySection: 'chains', beats: ['ethereum', 'base'] },
    { primarySection: 'products', beats: ['wallets', 'brands'] },
    { primarySection: 'culture', beats: ['communities', 'brands'] },
    { primarySection: 'memecoins', beats: ['memecoins', 'communities'] }
  ];
  assert.equal(new Set(examples.map(example => example.primarySection)).size, SECTION_ORDER.length);
  for (const example of examples) {
    assert.ok(SECTION_ORDER.includes(example.primarySection));
    assert.ok(example.beats.length > 0);
    assert.ok(example.beats.every(beat => BEAT_ORDER.includes(beat)));
  }
  assert.ok(examples.some(example => example.beats.length > 1));
});
