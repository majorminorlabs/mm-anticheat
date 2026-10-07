import { memorySnapshot, measured } from './metrics.mjs';

export async function runLocalModelLifecycle({
  adapter,
  lock,
  operation,
  unloadTimeoutMs = 60000,
  unloadPollMs = 250,
  events = [],
  onMetrics = async () => {}
}) {
  const lifecycleMetrics = {};
  const recordMetric = async (key, value) => {
    lifecycleMetrics[key] = value;
    await onMetrics(structuredClone(lifecycleMetrics));
  };
  const attachMetrics = error => {
    error.lifecycle_metrics = structuredClone(lifecycleMetrics);
    return error;
  };

  await lock.assertOwner();
  await adapter.assertNoUnexpectedResident({ allowed: [] });
  const beforeLoad = memorySnapshot('before_load', await adapter.residentModels());
  await recordMetric('before_load', beforeLoad);
  events.push({ event: 'model_load_started', model: adapter.model, at: new Date().toISOString() });
  let loaded;
  try {
    loaded = await measured(() => adapter.load());
    await recordMetric('load', loaded.timing);
    await recordMetric('load_result', loaded.value);
  } catch (error) {
    throw attachMetrics(error);
  }
  await lock.assertOwner();
  const residentsAfterLoad = await adapter.assertNoUnexpectedResident({ allowed: [adapter.model] });
  if (!residentsAfterLoad.some(item => item.model === adapter.model)) throw new Error(`Model load verification failed for ${adapter.model}.`);
  const afterLoad = memorySnapshot('after_load', residentsAfterLoad);
  await recordMetric('after_load', afterLoad);
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
    await recordMetric('unload', unloadResult.timing);
    await recordMetric('unload_result', unloadResult.value);
    const residents = await adapter.residentModels();
    if (residents.some(item => item.model === adapter.model)) throw new Error(`Model unload verification failed for ${adapter.model}.`);
    events.push({ event: 'model_unload_verified', model: adapter.model, at: new Date().toISOString() });
  } catch (unloadError) {
    const combined = new Error(`Local model lifecycle failed: ${operationError?.message || 'operation completed'}; unload: ${unloadError.message}`);
    combined.cause = { operationError, unloadError };
    combined.unloadFailed = true;
    throw attachMetrics(combined);
  }
  const afterUnload = memorySnapshot('after_unload', await adapter.residentModels());
  await recordMetric('after_unload', afterUnload);
  if (operationError) throw attachMetrics(operationError);
  return {
    result,
    lifecycle_metrics: lifecycleMetrics
  };
}
