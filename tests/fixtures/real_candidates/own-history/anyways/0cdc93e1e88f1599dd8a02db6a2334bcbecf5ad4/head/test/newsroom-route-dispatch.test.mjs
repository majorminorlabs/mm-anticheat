import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
const router = app.slice(app.indexOf('async function route()'), app.indexOf('chrome();'));

test('pipeline overview and job details dispatch to separate renderers', () => {
  assert.match(router, /if \(pathname === '\/newsroom\/pipeline'\) return pipelineControls\(\);/);
  assert.match(router, /if \(\/\^\\\/newsroom\\\/pipeline\\\/jobs\\\/\[0-9a-f-\]\{36\}\$\/i\.test\(pathname\)\) \{\s*return pipelineJobDetail\(pathname\.split\('\/'\)\[4\]\);\s*\}/);
  assert.doesNotMatch(router, /pathname === '\/newsroom\/pipeline' \|\|/);
});

test('review packages accept Hermes external IDs as well as UUID-like IDs', () => {
  assert.match(router, /if \(\/\^\\\/newsroom\\\/review\\\/\[\^\/\]\+\$\/i\.test\(pathname\)\) return reviewPackage\(decodeURIComponent\(pathname\.split\('\/'\)\[3\]\)\);/);
});
