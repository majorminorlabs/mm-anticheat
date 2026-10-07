import { performance } from 'node:perf_hooks';
import { Agent, request as undiciRequest } from 'undici';

function errorSummary(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    code: error.code || null
  };
}

function nestedTransportError(error) {
  let current = error;
  while (current?.cause && current.cause !== current) current = current.cause;
  return current || error;
}

export function classifyTimeoutLayer(error, {
  deadlineFired = false,
  externalAborted = false
} = {}) {
  if (deadlineFired) return 'adapter_deadline';
  if (externalAborted) return 'abort_controller';
  const nested = nestedTransportError(error);
  if (nested?.code === 'UND_ERR_HEADERS_TIMEOUT') return 'headers_timeout';
  if (nested?.code === 'UND_ERR_BODY_TIMEOUT') return 'body_timeout';
  if (nested?.code === 'UND_ERR_CONNECT_TIMEOUT') return 'connect_timeout';
  if (nested?.name === 'AbortError' || nested?.code === 'ABORT_ERR') return 'abort_controller';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'].includes(nested?.code)) return 'connection';
  return 'transport';
}

export class OllamaTransportError extends Error {
  constructor(message, { cause = null, details = {}, code = 'OLLAMA_TRANSPORT_ERROR' } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OllamaTransportError';
    this.code = code;
    this.details = details;
  }
}

export class OllamaJsonTransport {
  constructor({
    connectTimeoutMs = 10000,
    requestImpl = undiciRequest,
    dispatcherFactory = options => new Agent(options),
    now = () => performance.now(),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  } = {}) {
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestImpl = requestImpl;
    this.dispatcherFactory = dispatcherFactory;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
  }

  async request({
    url,
    method = 'GET',
    body = null,
    timeoutMs,
    operation,
    signal = null
  }) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('A positive configured request timeout is required.');
    const started = this.now();
    const controller = new AbortController();
    let deadlineFired = false;
    let externalAborted = Boolean(signal?.aborted);
    let headersReceived = false;
    let bodyBegan = false;
    let cleanupCompleted = false;
    let cleanupError = null;
    let responseStatus = null;
    const dispatcher = this.dispatcherFactory({
      connect: { timeout: this.connectTimeoutMs },
      headersTimeout: 0,
      bodyTimeout: 0
    });
    const abortFromExternal = () => {
      externalAborted = true;
      controller.abort(signal?.reason || new DOMException('Request aborted.', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) abortFromExternal();
      else signal.addEventListener('abort', abortFromExternal, { once: true });
    }
    const deadlineTimer = this.setTimeoutImpl(() => {
      deadlineFired = true;
      controller.abort(new DOMException(`Configured benchmark timeout of ${timeoutMs}ms exceeded.`, 'TimeoutError'));
    }, timeoutMs);
    let payload;
    let requestError = null;
    try {
      const response = await this.requestImpl(url, {
        dispatcher,
        method,
        headers: body == null ? undefined : { 'content-type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
        headersTimeout: 0,
        bodyTimeout: 0
      });
      headersReceived = true;
      responseStatus = response.statusCode;
      const chunks = [];
      for await (const chunk of response.body) {
        bodyBegan = true;
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(`Ollama returned HTTP ${response.statusCode}.`);
        error.code = 'OLLAMA_HTTP_ERROR';
        throw error;
      }
      try {
        payload = JSON.parse(text);
      } catch (error) {
        error.code = 'OLLAMA_INVALID_JSON';
        throw error;
      }
    } catch (error) {
      requestError = error;
    } finally {
      this.clearTimeoutImpl(deadlineTimer);
      if (signal) signal.removeEventListener('abort', abortFromExternal);
      try {
        await dispatcher.destroy();
        cleanupCompleted = true;
      } catch (error) {
        cleanupError = error;
      }
    }

    const elapsedMs = Math.max(0, this.now() - started);
    if (requestError || cleanupError) {
      const original = requestError || cleanupError;
      const nested = nestedTransportError(original);
      const timeoutLayer = cleanupError && !requestError
        ? 'transport_cleanup'
        : classifyTimeoutLayer(original, { deadlineFired, externalAborted });
      const details = {
        operation,
        request_url: new URL(url).origin + new URL(url).pathname,
        configured_timeout_ms: timeoutMs,
        elapsed_ms: elapsedMs,
        timeout_layer: timeoutLayer,
        aborted_by_harness: deadlineFired,
        externally_aborted: externalAborted,
        headers_received: headersReceived,
        response_body_began: bodyBegan,
        response_status: responseStatus,
        connect_timeout_ms: this.connectTimeoutMs,
        headers_timeout_ms: 0,
        body_timeout_ms: 0,
        transport: 'undici.request',
        top_level_transport_error: errorSummary(original),
        nested_transport_cause: nested === original ? null : errorSummary(nested),
        cleanup: {
          attempted: true,
          completed: cleanupCompleted,
          method: 'dispatcher.destroy',
          error: errorSummary(cleanupError)
        }
      };
      throw new OllamaTransportError(
        `Ollama ${operation} request failed at ${timeoutLayer}: ${original.message || String(original)}`,
        { cause: original, details }
      );
    }
    return {
      data: payload,
      transport: {
        operation,
        elapsed_ms: elapsedMs,
        configured_timeout_ms: timeoutMs,
        headers_received: headersReceived,
        response_body_began: bodyBegan,
        response_status: responseStatus,
        connect_timeout_ms: this.connectTimeoutMs,
        headers_timeout_ms: 0,
        body_timeout_ms: 0,
        cleanup: {
          attempted: true,
          completed: cleanupCompleted,
          method: 'dispatcher.destroy',
          error: null
        }
      }
    };
  }
}
