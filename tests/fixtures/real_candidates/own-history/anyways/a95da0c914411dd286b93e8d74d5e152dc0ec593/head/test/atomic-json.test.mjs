import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJsonFile, writeJsonFile } from '../src/pipeline/atomic-json.mjs';

test('atomic JSON writes preserve a valid file under concurrent writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-atomic-json-'));
  const file = path.join(dir, 'state.json');
  try {
    await writeJsonFile(file, { version: 1, valid: true });
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeJsonFile(file, { version: index, valid: true })));
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(value.valid, true);
    assert.ok(Number.isInteger(value.version));
    assert.equal((await fs.readdir(dir)).filter(name => name.includes('.tmp-')).length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('malformed JSON reports path, size, checksum, and preserves an incident copy', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-malformed-json-'));
  const file = path.join(dir, 'research-cache.json');
  const incident = path.join(dir, 'incident');
  const bytes = Buffer.from('{"broken":"unterminated');
  try {
    await fs.writeFile(file, bytes);
    await assert.rejects(readJsonFile(file, { label: 'research cache', incidentDir: incident }), error => {
      assert.equal(error.code, 'MALFORMED_JSON_STATE');
      assert.equal(error.bytes, bytes.length);
      assert.equal(error.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
      assert.equal(error.path, path.resolve(file));
      return true;
    });
    const copies = await fs.readdir(incident);
    assert.equal(copies.length, 1);
    assert.deepEqual(await fs.readFile(path.join(incident, copies[0])), bytes);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
