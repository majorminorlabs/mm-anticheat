import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { OllamaBenchmarkAdapter } from '../src/adapters/ollama.mjs';
import {
  OllamaJsonTransport,
  OllamaTransportError
} from '../src/ollama-transport.mjs';

function response(data = {}, statusCode = 200) {
  return {
    statusCode,
    body: Readable.from([Buffer.from(JSON.stringify(data))])
  };
}

function dispatcherSpy({ destroyFails = false } = {}) {
  const state = { destroy_calls: 0, options: null };
  return {
    state,
    factory(options) {
      state.options = options;
      return {
        async destroy() {
          state.destroy_calls++;
          if (destroyFails) throw new Error('Injected dispatcher cleanup failure');
        }
      };
    }
  };
}

test('Ollama transport completes before the configured deadline', async () => {
  const dispatcher = dispatcherSpy();
  const transport = new OllamaJsonTransport({
    dispatcherFactory: dispatcher.factory,
    requestImpl: async (_url, options) => {
      assert.equal(options.headersTimeout, 0);
      assert.equal(options.bodyTimeout, 0);
      return response({ ok: true });
    }
  });
  const result = await transport.request({
    url: 'http://127.0.0.1:11434/api/version',
    timeoutMs: 600000,
    operation: 'success'
  });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.transport.configured_timeout_ms, 600000);
  assert.equal(result.transport.cleanup.completed, true);
});

test('Ollama transport permits a conceptual response beyond five minutes but before its configured deadline', async () => {
  let clock = 0;
  let cleared = false;
  const dispatcher = dispatcherSpy();
  const transport = new OllamaJsonTransport({
    now: () => clock,
    setTimeoutImpl: () => ({ timer: true }),
    clearTimeoutImpl: () => { cleared = true; },
    dispatcherFactory: dispatcher.factory,
    requestImpl: async (_url, options) => {
      assert.equal(options.headersTimeout, 0);
      assert.equal(options.bodyTimeout, 0);
      clock = 301000;
      return response({ completed: true });
    }
  });
  const result = await transport.request({
    url: 'http://127.0.0.1:11434/api/generate',
    method: 'POST',
    body: { prompt: 'synthetic' },
    timeoutMs: 600000,
    operation: 'conceptual_long_request'
  });
  assert.equal(result.transport.elapsed_ms, 301000);
  assert.equal(result.data.completed, true);
  assert.equal(cleared, true);
});

test('Ollama transport aborts at the adapter-configured deadline', async () => {
  const dispatcher = dispatcherSpy();
  const transport = new OllamaJsonTransport({
    dispatcherFactory: dispatcher.factory,
    requestImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })
  });
  await assert.rejects(
    () => transport.request({
      url: 'http://127.0.0.1:11434/api/generate',
      timeoutMs: 20,
      operation: 'deadline'
    }),
    error => {
      assert.equal(error.details.timeout_layer, 'adapter_deadline');
      assert.equal(error.details.aborted_by_harness, true);
      assert.equal(error.details.configured_timeout_ms, 20);
      return true;
    }
  );
});

test('Ollama transport classifies an Undici headers timeout', async () => {
  const dispatcher = dispatcherSpy();
  const cause = Object.assign(new Error('Headers Timeout Error'), {
    name: 'HeadersTimeoutError',
    code: 'UND_ERR_HEADERS_TIMEOUT'
  });
  const transport = new OllamaJsonTransport({
    dispatcherFactory: dispatcher.factory,
    requestImpl: async () => { throw cause; }
  });
  await assert.rejects(
    () => transport.request({
      url: 'http://127.0.0.1:11434/api/generate',
      timeoutMs: 600000,
      operation: 'headers'
    }),
    error => {
      assert.equal(error.details.timeout_layer, 'headers_timeout');
      assert.equal(error.details.top_level_transport_error.code, 'UND_ERR_HEADERS_TIMEOUT');
      assert.equal(error.details.headers_received, false);
      return true;
    }
  );
});

test('Ollama transport classifies an Undici body timeout after headers', async () => {
  const dispatcher = dispatcherSpy();
  const cause = Object.assign(new Error('Body Timeout Error'), {
    name: 'BodyTimeoutError',
    code: 'UND_ERR_BODY_TIMEOUT'
  });
  const transport = new OllamaJsonTransport({
    dispatcherFactory: dispatcher.factory,
    requestImpl: async () => ({
      statusCode: 200,
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{');
          throw cause;
        }
      }
    })
  });
  await assert.rejects(
    () => transport.request({
      url: 'http://127.0.0.1:11434/api/generate',
      timeoutMs: 600000,
      operation: 'body'
    }),
    error => {
      assert.equal(error.details.timeout_layer, 'body_timeout');
      assert.equal(error.details.headers_received, true);
      assert.equal(error.details.response_body_began, true);
      return true;
    }
  );
});

test('Ollama transport classifies connection failure', async () => {
  const dispatcher = dispatcherSpy();
  const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const transport = new OllamaJsonTransport({
    dispatcherFactory: dispatcher.factory,
    requestImpl: async () => { throw cause; }
  });
  await assert.rejects(
    () => transport.request({
      url: 'http://127.0.0.1:11434/api/version',
      timeoutMs: 600000,
      operation: 'connect'
    }),
    error => {
      assert.equal(error.details.timeout_layer, 'connection');
      assert.equal(error.details.nested_transport_cause, null);
      return true;
    }
  );
});

test('Ollama transport honors external AbortController cancellation', async () => {
  const dispatcher = dispatcherSpy();
  const external = new AbortController();
  const transport = new OllamaJsonTransport({
    dispatcherFactory: dispatcher.factory,
    requestImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      external.abort(new DOMException('Operator cancelled.', 'AbortError'));
    })
  });
  await assert.rejects(
    () => transport.request({
      url: 'http://127.0.0.1:11434/api/generate',
      timeoutMs: 600000,
      operation: 'external_abort',
      signal: external.signal
    }),
    error => {
      assert.equal(error.details.timeout_layer, 'abort_controller');
      assert.equal(error.details.externally_aborted, true);
      assert.equal(error.details.aborted_by_harness, false);
      return true;
    }
  );
});

test('Ollama transport preserves nested fetch and Undici causes', async () => {
  const dispatcher = dispatcherSpy();
  const nested = Object.assign(new Error('Headers Timeout Error'), {
    name: 'HeadersTimeoutError',
    code: 'UND_ERR_HEADERS_TIMEOUT'
  });
  const top = new TypeError('fetch failed', { cause: nested });
  const transport = new OllamaJsonTransport({
    dispatcherFactory: dispatcher.factory,
    requestImpl: async () => { throw top; }
  });
  await assert.rejects(
    () => transport.request({
      url: 'http://127.0.0.1:11434/api/generate',
      timeoutMs: 600000,
      operation: 'nested'
    }),
    error => {
      assert.equal(error.details.top_level_transport_error.name, 'TypeError');
      assert.equal(error.details.top_level_transport_error.message, 'fetch failed');
      assert.equal(error.details.nested_transport_cause.name, 'HeadersTimeoutError');
      assert.equal(error.details.nested_transport_cause.code, 'UND_ERR_HEADERS_TIMEOUT');
      return true;
    }
  );
});

test('Ollama transport destroys its dispatcher after success', async () => {
  const dispatcher = dispatcherSpy();
  const transport = new OllamaJsonTransport({
    dispatcherFactory: dispatcher.factory,
    requestImpl: async () => response({ ok: true })
  });
  await transport.request({
    url: 'http://127.0.0.1:11434/api/version',
    timeoutMs: 1000,
    operation: 'cleanup_success'
  });
  assert.equal(dispatcher.state.destroy_calls, 1);
  assert.equal(dispatcher.state.options.connect.timeout, 10000);
});

test('Ollama transport destroys its dispatcher after failure', async () => {
  const dispatcher = dispatcherSpy();
  const transport = new OllamaJsonTransport({
    dispatcherFactory: dispatcher.factory,
    requestImpl: async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }
  });
  await assert.rejects(() => transport.request({
    url: 'http://127.0.0.1:11434/api/version',
    timeoutMs: 1000,
    operation: 'cleanup_failure'
  }));
  assert.equal(dispatcher.state.destroy_calls, 1);
});

test('Ollama adapter records post-failure reachability and does not retry generation', async () => {
  let generationCalls = 0;
  const transport = {
    async request({ operation }) {
      if (operation === 'residency_probe') {
        return { data: { models: [{ name: 'qwen3:14b' }] }, transport: {} };
      }
      if (operation === 'generation:draft') {
        generationCalls++;
        throw new OllamaTransportError('Injected generation transport failure', {
          details: {
            operation,
            configured_timeout_ms: 600000,
            elapsed_ms: 301000,
            timeout_layer: 'headers_timeout',
            request_url: 'http://127.0.0.1:11434/api/generate'
          }
        });
      }
      if (operation === 'post_failure_reachability') {
        return { data: { version: 'test' }, transport: {} };
      }
      if (operation === 'post_failure_residency') {
        return { data: { models: [{ name: 'qwen3:14b', digest: 'digest' }] }, transport: {} };
      }
      throw new Error(`Unexpected operation ${operation}`);
    }
  };
  const adapter = new OllamaBenchmarkAdapter({
    model: 'qwen3:14b',
    allowRealGeneration: true,
    transport
  });
  await assert.rejects(
    () => adapter.generate({ prompt: 'synthetic', schema: {}, stage: 'draft' }),
    error => {
      assert.equal(error.details.ollama_reachable_after_failure, true);
      assert.equal(error.details.current_ollama_residency[0].model, 'qwen3:14b');
      assert.equal(error.details.top_level_error.name, 'OllamaTransportError');
      return true;
    }
  );
  assert.equal(generationCalls, 1);
});
