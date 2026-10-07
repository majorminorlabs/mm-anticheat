import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('public analytics serializes the event value parameter explicitly', async () => {
  const source = await readFile(new URL('../src/public-app.mjs', import.meta.url), 'utf8');
  assert.match(source, /event_value:\s*eventValue/);
  assert.doesNotMatch(source, /\n\s*event_value,\n/);
});
