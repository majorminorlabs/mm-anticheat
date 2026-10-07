import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTrustPage, trustPage, trustPageSlugs } from '../src/trust-pages.mjs';

test('trust surface has reader-facing policy pages without author identity pages', () => {
  assert.ok(trustPageSlugs().includes('standards'));
  assert.ok(trustPageSlugs().includes('corrections'));
  assert.equal(trustPage('authors'), null);
  const html = renderTrustPage('standards');
  assert.match(html, /Editorial standards/);
  assert.match(html, /human verification/);
});
