import http, { type Server } from 'node:http';

export type HealthErrorSource = 'queue' | 'job' | null;

export type HealthState = {
  controllerId: string;
  startedAt: number;
  queue: boolean;
  ollama: boolean;
  model: boolean;
  currentJobId: string | null;
  lastCompletedJobId: string | null;
  lastError: string | null;
  lastRecordedError: string | null;
  errorSource: HealthErrorSource;
  codexProviderReady?: boolean;
  codexExecutable?: string | null;
  codexReadinessError?: string | null;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function recordQueueFailure(state: HealthState, error: unknown) {
  const message = errorMessage(error);
  state.queue = false;
  state.lastError = message;
  state.lastRecordedError = message;
  state.errorSource = 'queue';
  return message;
}

export function recordQueueSuccess(state: HealthState) {
  state.queue = true;
  if (state.errorSource === 'queue') {
    state.lastError = null;
    state.errorSource = null;
  }
}

export function recordJobFailure(state: HealthState, error: unknown) {
  const message = errorMessage(error);
  state.lastError = message;
  state.lastRecordedError = message;
  state.errorSource = 'job';
  return message;
}

export function clearResolvedJobFailure(state: HealthState) {
  if (state.errorSource === 'job' && state.currentJobId === null) {
    state.lastError = null;
    state.errorSource = null;
  }
}

export function healthPayload(state: HealthState, now = Date.now()) {
  return {
    status: state.queue && state.ollama && state.model && state.codexProviderReady !== false && !state.lastError ? 'ok' : 'degraded',
    controller_id: state.controllerId,
    uptime_seconds: Math.floor((now - state.startedAt) / 1000),
    queue_connectivity: state.queue,
    ollama_connectivity: state.ollama,
    model_available: state.model,
    current_job_id: state.currentJobId,
    last_completed_job_id: state.lastCompletedJobId,
    last_error: state.lastError,
    last_recorded_error: state.lastRecordedError,
    codex_provider_ready: state.codexProviderReady ?? null,
    codex_executable: state.codexExecutable ?? null,
    codex_readiness_error: state.codexReadinessError ?? null
  };
}

export async function startHealthServer(host: string, port: number, state: HealthState): Promise<Server> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(healthPayload(state)));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  return server;
}
