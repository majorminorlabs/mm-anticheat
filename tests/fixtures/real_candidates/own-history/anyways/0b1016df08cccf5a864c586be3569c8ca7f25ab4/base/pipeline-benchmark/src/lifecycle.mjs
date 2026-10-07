import { memorySnapshot, measured } from './metrics.mjs';

export async function runLocalModelLifecycle({
  adapter,
  lock,
  operation,
  unloadTimeoutMs = 60000,
  unloadPollMs = 250,
  events = []
}) {
  await lock.assertOwner();
  await adapter.assertNoUnexpectedResident({ allowed: [] });
  const beforeLoad = memorySnapshot('before_load', await adapter.residentModels());
  events.push({ event: 'model_load_started', model: adapter.model, at: new Date().toISOString() });
  const loaded = await measured(() => adapter.load());
  await lock.assertOwner();
  const residentsAfterLoad = await adapter.assertNoUnexpectedResident({ allowed: [adapter.model] });
  if (!residentsAfterLoad.some(item => item.model === adapter.model)) throw new Error(`Model load verification failed for ${adapter.model}.`);
  const afterLoad = memorySnapshot('after_load', residentsAfterLoad);
  events.push({ event: 'model_load_verified', model: adapter.model, at: new Date().toISOString() });
  let result;
  let operationError = null;
  let unloadResult = null;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await lock.assertOwner();
    events.push({ event: 'model_unload_started', model: adapter.model, at: new Date().toISOString() });
    unloadResult = await measured(() => adapter.unload({ timeoutMs: unloadTimeoutMs, pollMs: unloadPollMs }));
    const residents = await adapter.residentModels();
    if (residents.some(item => item.model === adapter.model)) throw new Error(`Model unload verification failed for ${adapter.model}.`);
    events.push({ event: 'model_unload_verified', model: adapter.model, at: new Date().toISOString() });
  } catch (unloadError) {
    const combined = new Error(`Local model lifecycle failed: ${operationError?.message || 'operation completed'}; unload: ${unloadError.message}`);
    combined.cause = { operationError, unloadError };
    combined.unloadFailed = true;
    throw combined;
  }
  const afterUnload = memorySnapshot('after_unload', await adapter.residentModels());
  if (operationError) throw operationError;
  return {
    result,
    lifecycle_metrics: {
      before_load: beforeLoad,
      load: loaded.timing,
      load_result: loaded.value,
      after_load: afterLoad,
      unload: unloadResult.timing,
      unload_result: unloadResult.value,
      after_unload: afterUnload
    }
  };
}
