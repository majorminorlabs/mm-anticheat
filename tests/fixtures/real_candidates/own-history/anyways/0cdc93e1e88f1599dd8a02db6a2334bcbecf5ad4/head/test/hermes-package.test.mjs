import assert from 'node:assert/strict';
import test from 'node:test';
import { validateHermesStoryPackage } from '../src/pipeline/hermes-package.mjs';

const basePackage = () => ({
  headline: 'A collectible brand just found a stranger way to sell ownership',
  dek: 'The launch connects a familiar physical product to an on-chain market, giving readers a concrete reason to care.',
  body_markdown: Array.from({ length: 620 }, (_, index) => `reported detail ${index + 1}`).join(' ') + ' The [official announcement](https://example.com/announcement) confirms the launch.',
  social_post: 'A familiar collectible just got a new on-chain sales channel. The interesting part is who it is for, and what the market does next.',
  research_markdown: 'The source event was checked against the official announcement and a second independent report. The launch date is confirmed; market size and buyer behavior remain unresolved.',
  primary_section: 'digital-collectibles',
  story_form: 'meanwhile',
  beats: ['nfts', 'brands'],
  tags: ['collectibles'],
  sources: [{
    url: 'https://example.com/announcement',
    title: 'Official announcement',
    used_for: 'Confirms the launch and product details.'
  }],
  claims: [{
    claim: 'The product launched on the announced date.',
    status: 'supported',
    source_indexes: [1]
  }]
});
test('Hermes accepts a complete package without requiring section headings', () => {
  const result = validateHermesStoryPackage(basePackage());
  assert.equal(result.valid, true);
  assert.equal(result.metrics.contract_version, 'hermes-editorial-v1');
  assert.equal(result.metrics.inline_source_link_count, 1);
  assert.match(result.warnings.join(' '), /No section heading was supplied/);
});

test('Hermes rejects raw URLs and incomplete handoff fields', () => {
  const rawUrl = basePackage();
  rawUrl.body_markdown += ' More evidence: https://example.com/raw';
  const invalid = validateHermesStoryPackage({ ...rawUrl, social_post: '', research_markdown: '' });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' '), /Social post is required/);
  assert.match(invalid.errors.join(' '), /Research packet is required/);
  assert.match(invalid.errors.join(' '), /raw URLs/);
});
