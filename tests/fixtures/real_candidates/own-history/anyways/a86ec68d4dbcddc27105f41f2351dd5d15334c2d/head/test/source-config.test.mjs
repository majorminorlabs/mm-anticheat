import assert from 'node:assert/strict'; import test from 'node:test';
import { validateSourceConfig } from '../src/pipeline/source-config.mjs';
const source = { id: 'source-a', name: 'Source A', type: 'rss', url: 'https://example.com/feed.xml', enabled: true, default_section: 'internet', default_recurring_beats: ['ai'], default_tags: ['news'] };
test('accepts a canonical enabled RSS source', () => assert.equal(validateSourceConfig([source])[0].id, 'source-a'));
test('rejects duplicate IDs, invalid type, URL, section, and beat', () => { assert.throws(() => validateSourceConfig([source, { ...source }]), /Duplicate/); assert.throws(() => validateSourceConfig([{ ...source, type: 'nope' }]), /unsupported/); assert.throws(() => validateSourceConfig([{ ...source, url: 'file:///tmp/x' }]), /Only http/); assert.throws(() => validateSourceConfig([{ ...source, default_section: 'nope' }]), /default_section/); assert.throws(() => validateSourceConfig([{ ...source, default_recurring_beats: ['nope'] }]), /canonical beat/); });
test('keeps disabled sources valid but excludes them at discovery time', () => assert.equal(validateSourceConfig([{ ...source, enabled: false }])[0].enabled, false));
