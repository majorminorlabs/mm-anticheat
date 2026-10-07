import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeQueue } from '../ops/probe-queue.mjs';

test('read-only queue probe summary requires zero queued or active jobs', () => {
  assert.deepEqual(summarizeQueue([]), { idle: true, active_count: 0, queued_count: 0 });
  assert.deepEqual(
    summarizeQueue([{ status: 'queued' }, { status: 'claimed' }, { status: 'running' }, { status: 'completed' }]),
    { idle: false, active_count: 2, queued_count: 1 }
  );
});
