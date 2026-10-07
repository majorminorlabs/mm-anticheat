import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ProductionCoordinator,
  launchctlControllerControl,
  waitForControllerShutdown
} from '../src/production.mjs';

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async milliseconds => { value += milliseconds; }
  };
}

function sequence(values) {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)];
}

const absent = { running: false, service_loaded: false, service_state: 'absent', pid: null };
const running = pid => ({ running: true, service_loaded: true, service_state: 'running', pid });

test('controller shutdown polling accepts an immediate stop and records the observation', async () => {
  const result = await waitForControllerShutdown({
    recordedPid: 100,
    statusProbe: async () => absent,
    pidExists: async () => false,
    listenerProbe: async () => []
  });
  assert.equal(result.status, 'stopped_immediately');
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].recorded_pid_exists, false);
});

test('controller shutdown polling waits for a delayed stop', async () => {
  const clock = fakeClock();
  const result = await waitForControllerShutdown({
    recordedPid: 100,
    statusProbe: sequence([running(100), running(100), absent]),
    pidExists: sequence([true, true, false]),
    listenerProbe: sequence([[100], [100], []]),
    timeoutMs: 1000,
    pollMs: 100,
    now: clock.now,
    sleepImpl: clock.sleep
  });
  assert.equal(result.status, 'stopped_after_polling');
  assert.equal(result.elapsed_ms, 200);
  assert.equal(result.observations.length, 3);
});

test('controller shutdown polling reports a bounded timeout with all observations', async () => {
  const clock = fakeClock();
  await assert.rejects(
    () => waitForControllerShutdown({
      recordedPid: 100,
      statusProbe: async () => running(100),
      pidExists: async () => true,
      listenerProbe: async () => [100],
      timeoutMs: 200,
      pollMs: 100,
      now: clock.now,
      sleepImpl: clock.sleep
    }),
    error => {
      assert.equal(error.code, 'CONTROLLER_PAUSE_TIMEOUT');
      assert.equal(error.details.observations.length, 3);
      return true;
    }
  );
});

test('controller shutdown polling accepts a stale recorded PID once service and listener are absent', async () => {
  const result = await waitForControllerShutdown({
    recordedPid: 100,
    statusProbe: async () => absent,
    pidExists: async () => false,
    listenerProbe: async () => []
  });
  assert.equal(result.status, 'stopped_immediately');
  assert.equal(result.recorded_pid, 100);
});

test('controller shutdown polling rejects a replacement PID', async () => {
  await assert.rejects(
    () => waitForControllerShutdown({
      recordedPid: 100,
      statusProbe: async () => running(101),
      pidExists: async () => false,
      listenerProbe: async () => [101]
    }),
    error => {
      assert.equal(error.code, 'CONTROLLER_REPLACEMENT_APPEARED');
      assert.deepEqual(error.details.replacement_pids, [101]);
      return true;
    }
  );
});

test('controller shutdown polling waits for the listener after service state changes', async () => {
  const clock = fakeClock();
  const result = await waitForControllerShutdown({
    recordedPid: 100,
    statusProbe: async () => absent,
    pidExists: async () => false,
    listenerProbe: sequence([[100], []]),
    timeoutMs: 1000,
    pollMs: 100,
    now: clock.now,
    sleepImpl: clock.sleep
  });
  assert.equal(result.status, 'stopped_after_polling');
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.observations[0].listener_pids, [100]);
  assert.deepEqual(result.observations[1].listener_pids, []);
});

test('launchctl pause distinguishes a bootout command failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-controller-control-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plist = path.join(root, 'controller.plist');
  await fs.writeFile(plist, 'test plist');
  const control = launchctlControllerControl({
    label: 'com.anyways.controller',
    plist,
    uid: 501,
    execFileImpl: async (_command, args) => {
      if (args[0] === 'bootout') throw new Error('injected bootout failure');
      return { stdout: '' };
    },
    listenerProbe: async () => []
  });
  await assert.rejects(
    () => control.pause({ recordedPid: 100 }),
    error => {
      assert.equal(error.code, 'CONTROLLER_PAUSE_COMMAND_FAILED');
      assert.equal(error.command_succeeded, false);
      return true;
    }
  );
});

function restorationHarness(failure = null) {
  const events = [];
  let residents = [{ model: 'benchmark-model', digest: 'benchmark-digest' }];
  let controllerRunning = false;
  let healthCalls = 0;
  const fail = step => {
    if (failure === step) throw new Error(`Injected ${step} failure`);
  };
  const modelSystem = {
    async residentModels() {
      events.push('resident-models');
      return structuredClone(residents);
    },
    async unloadModel(model) {
      events.push('unload');
      fail('unload');
      residents = residents.filter(item => item.model !== model);
    },
    async installedModel() {
      events.push('verify-tag-digest');
      fail('tag-digest');
      return { name: 'qwen3:14b', digest: 'a'.repeat(64) };
    },
    async restoreResidency(original) {
      events.push('restore-residency');
      fail('residency');
      residents = structuredClone(original);
    }
  };
  const controllerControl = {
    async status() {
      events.push('controller-status');
      return { running: controllerRunning, pid: controllerRunning ? 200 : null, plist_sha256: 'plist-hash' };
    },
    async resume() {
      events.push('controller-resume');
      fail('controller-resume');
      controllerRunning = true;
    },
    async pause() {
      events.push('controller-pause');
      controllerRunning = false;
    }
  };
  const coordinator = new ProductionCoordinator({
    authorized: true,
    acceptableHealth: ['ok'],
    baselineModel: 'qwen3:14b',
    baselineDigestPrefix: 'a'.repeat(64),
    restoreHealthTimeoutMs: 0,
    restoreHealthPollMs: 0,
    modelSystem,
    controllerControl,
    productionSmoke: async () => {
      events.push('smoke');
      if (failure === 'smoke') {
        residents = [{ model: 'qwen3:14b', digest: 'a'.repeat(64) }];
        throw new Error('Injected smoke failure');
      }
      return { model: 'qwen3:14b', digest: 'a'.repeat(64), generated: true, output_nonempty: true };
    },
    healthProbe: async () => {
      events.push('health');
      healthCalls++;
      if (failure === 'health') throw new Error('Injected health failure');
      return { status: 'ok', queue_connectivity: true, current_job_id: null };
    },
    queueProbe: async () => {
      events.push('queue');
      if (failure === 'active-work') return { idle: false, active_count: 1, queued_count: 0, active_lease_count: 1 };
      return { idle: true, active_count: 0, queued_count: 0, active_lease_count: 0 };
    }
  });
  coordinator.snapshot = {
    controller: { running: true, pid: 100, plist_sha256: 'plist-hash' },
    resident_models: []
  };
  coordinator.paused = true;
  return { coordinator, events, getResidents: () => residents, getHealthCalls: () => healthCalls };
}

for (const [failure, failedStep] of [
  ['unload', 'unload_benchmark_models'],
  ['smoke', 'production_model_smoke'],
  ['tag-digest', 'verify_production_model_tag_digest'],
  ['residency', 'restore_ollama_residency'],
  ['controller-resume', 'restore_controller_state'],
  ['health', 'verify_controller_health_and_queue'],
  ['active-work', 'verify_no_active_jobs_or_leases']
]) {
  test(`restoration aggregates ${failure} failure and still attempts later steps`, async () => {
    const harness = restorationHarness(failure);
    const report = await harness.coordinator.restore();
    assert.equal(report.status, 'RESTORE_FAILED');
    assert.ok(report.failures.some(item => item.step === failedStep));
    assert.ok(harness.events.includes('queue'), 'later queue verification must run');
    if (failure === 'smoke') assert.deepEqual(harness.getResidents(), [], 'residency restoration must unload a smoke-loaded model');
    if (failure === 'health') assert.equal(harness.getHealthCalls(), 1);
  });
}

test('restoration succeeds only when every required step passes', async () => {
  const harness = restorationHarness();
  const report = await harness.coordinator.restore();
  assert.equal(report.status, 'restored');
  assert.deepEqual(report.failures, []);
  assert.deepEqual(harness.getResidents(), []);
  assert.ok(report.steps.every(item => item.status === 'ok'));
});

test('controller restoration polls through delayed launch after bootstrap', async () => {
  let statusCalls = 0;
  let resumed = false;
  const controllerControl = {
    async status() {
      statusCalls++;
      const runningNow = resumed && statusCalls >= 4;
      return { running: runningNow, pid: runningNow ? 300 : null, plist_sha256: 'plist-hash' };
    },
    async resume() { resumed = true; },
    async pause() {}
  };
  const coordinator = new ProductionCoordinator({
    authorized: true,
    acceptableHealth: ['ok'],
    baselineModel: 'qwen3:14b',
    baselineDigestPrefix: 'a'.repeat(64),
    restoreHealthTimeoutMs: 100,
    restoreHealthPollMs: 1,
    controllerControl,
    modelSystem: {
      async residentModels() { return []; },
      async installedModel() { return { name: 'qwen3:14b', digest: 'a'.repeat(64) }; },
      async restoreResidency() {}
    },
    productionSmoke: async () => ({ generated: true, output_nonempty: true }),
    healthProbe: async () => ({ status: 'ok', queue_connectivity: true }),
    queueProbe: async () => ({ idle: true, active_count: 0, queued_count: 0, active_lease_count: 0 })
  });
  coordinator.snapshot = {
    controller: { running: true, pid: 100, plist_sha256: 'plist-hash' },
    resident_models: []
  };
  const report = await coordinator.restore();
  assert.equal(report.status, 'restored');
  const step = report.steps.find(item => item.step === 'restore_controller_state');
  assert.ok(step.observations.length >= 3);
  assert.equal(step.controller.pid, 300);
});
