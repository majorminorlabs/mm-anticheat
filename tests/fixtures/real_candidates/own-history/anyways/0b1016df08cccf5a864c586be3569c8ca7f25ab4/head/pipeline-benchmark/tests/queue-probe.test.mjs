import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeQueue } from '../ops/probe-queue.mjs';

test('read-only queue probe summary requires zero queued or active jobs', () => {
  const now = new Date('2026-07-30T20:00:00Z');
  assert.deepEqual(summarizeQueue([], now), {
    idle: true,
    active_count: 0,
    queued_count: 0,
    active_lease_count: 0
  });
  assert.deepEqual(
    summarizeQueue([
      { status: 'queued' },
      { status: 'claimed', lease_owner: 'controller-a', lease_expires_at: '2026-07-30T20:05:00Z' },
      { status: 'running' },
      { status: 'completed', lease_owner: 'old-controller', lease_expires_at: '2026-07-30T19:00:00Z' }
    ], now),
    { idle: false, active_count: 2, queued_count: 1, active_lease_count: 1 }
  );
});

test('read-only queue probe treats a live lease as active even outside an active status', () => {
  assert.deepEqual(
    summarizeQueue([{
      status: 'failed',
      lease_owner: 'controller-a',
      lease_expires_at: '2026-07-30T20:05:00Z'
    }], new Date('2026-07-30T20:00:00Z')),
    { idle: false, active_count: 0, queued_count: 0, active_lease_count: 1 }
  );
});
