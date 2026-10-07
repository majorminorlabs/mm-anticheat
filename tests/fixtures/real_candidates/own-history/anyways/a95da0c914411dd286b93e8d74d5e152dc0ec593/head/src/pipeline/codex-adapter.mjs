import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PRODUCTION_CODEX_PROVIDER } from './config.mjs';
import { calculateCodexUsage } from './cost.mjs';

export const EXPECTED_CODEX_CLI_VERSION = PRODUCTION_CODEX_PROVIDER.expectedCliVersion;
export const CODEX_GENERATION_DEADLINE_MS = PRODUCTION_CODEX_PROVIDER.generationDeadlineMs;

export const GENERIC_CODEX_AGENT = `# Anyways production pipeline

Execute only the supplied pipeline request. This environment is provider-neutral
and intentionally has no repository context, personal instructions, prior
session state, outside research, tools, browsing, plugins, skills, computer use,
image generation, shell access, or multi-agent behavior. Return only the
response requested by the pipeline payload.
`;

const subprocessEnv = (executable, extra = {}) => {
  const executableDirectory = executable && path.isAbsolute(executable) ? path.dirname(executable) : null;
  const pathValue = process.env.PATH || '';
  const PATH = executableDirectory && !pathValue.split(path.delimiter).includes(executableDirectory)
    ? [executableDirectory, pathValue].filter(Boolean).join(path.delimiter)
    : pathValue;
  return { ...process.env, HOME: process.env.HOME || os.homedir(), PATH, ...extra };
};

export const DISABLED_CODEX_FEATURES = Object.freeze([
  'shell_tool',
  'unified_exec',
  'browser_use',
  'in_app_browser',
  'apps',
  'plugins',
  'skill_search',
  'computer_use',
  'image_generation',
  'goals',
  'workspace_dependencies',
  'multi_agent',
  'multi_agent_v2',
  'code_mode_host',
  'tool_suggest'
]);

const ALLOWED_ITEM_TYPES = new Set(['agent_message', 'reasoning']);
const ALLOWED_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'item.started',
  'item.completed'
]);

function adapterError(message, {
  code = 'CODEX_ADAPTER_FAILURE',
  boundary = 'adapter',
  stdout = '',
  stderr = '',
  exitCode = null,
  signal = null,
  offendingEvent = null
} = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = {
    failure_boundary: boundary,
    raw_stdout: String(stdout || ''),
    raw_stderr: String(stderr || ''),
    exit_code: exitCode,
    signal,
    offending_event: offendingEvent
  };
  return error;
}

function isUnexpectedEvent(event) {
  if (!event || typeof event !== 'object' || !ALLOWED_EVENT_TYPES.has(event.type)) return true;
  return (event.type === 'item.started' || event.type === 'item.completed')
    && !ALLOWED_ITEM_TYPES.has(event.item?.type);
}

export function codexArguments({ model, reasoning, outputFile }) {
  if (!model) throw new Error('Codex model identifier is required.');
  if (!reasoning) throw new Error('Codex reasoning effort is required.');
  if (!outputFile) throw new Error('Codex output-last-message path is required.');
  return [
    'exec',
    '--strict-config',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--model', model,
    '--config', `model_reasoning_effort=${JSON.stringify(reasoning)}`,
    '--config', 'web_search="disabled"',
    '--config', 'agents.enabled=false',
    '--config', 'approval_policy="never"',
    ...DISABLED_CODEX_FEATURES.flatMap(feature => ['--disable', feature]),
    '--sandbox', 'read-only',
    '--color', 'never',
    '--json',
    '--output-last-message', outputFile,
    '-'
  ];
}

export function decodeCodexJsonl(stdout, {
  stderr = '',
  exitCode = 0,
  outputFileContent
} = {}) {
  const raw = String(stdout || '');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) {
    throw adapterError('Codex JSONL output was empty.', {
      code: 'CODEX_MISSING_ASSISTANT_CONTENT', boundary: 'output_decoding', stdout: raw, stderr, exitCode
    });
  }

  const events = [];
  const completedMessages = [];
  let usage = null;
  for (let index = 0; index < lines.length; index += 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch (cause) {
      throw adapterError(`Codex emitted malformed JSONL on line ${index + 1}: ${cause.message}`, {
        code: 'CODEX_MALFORMED_JSONL', boundary: 'output_decoding', stdout: raw, stderr, exitCode
      });
    }
    events.push(event);
    if (isUnexpectedEvent(event)) {
      throw adapterError(`Codex emitted unexpected activity: ${event?.type || 'invalid event'}.`, {
        code: 'CODEX_UNEXPECTED_TOOL_EVENT',
        boundary: 'tool_policy',
        stdout: raw,
        stderr,
        exitCode,
        offendingEvent: event
      });
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (typeof event.item.text !== 'string') {
        throw adapterError('Codex completed an assistant message without text.', {
          code: 'CODEX_MISSING_ASSISTANT_CONTENT', boundary: 'output_decoding', stdout: raw, stderr, exitCode, offendingEvent: event
        });
      }
      completedMessages.push(event.item.text);
    }
    if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
      usage = structuredClone(event.usage);
    }
  }
  if (!completedMessages.length) {
    throw adapterError('Codex JSONL contained no completed assistant message.', {
      code: 'CODEX_MISSING_ASSISTANT_CONTENT', boundary: 'output_decoding', stdout: raw, stderr, exitCode
    });
  }
  const content = completedMessages.at(-1);
  if (typeof outputFileContent !== 'string' || outputFileContent !== content) {
    throw adapterError('Codex JSONL assistant content contradicted output-last-message.', {
      code: 'CODEX_OUTPUT_MISMATCH', boundary: 'output_decoding', stdout: raw, stderr, exitCode
    });
  }
  return { content, events, usage };
}

function collectChild(child, { stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ stdout, stderr, exitCode, signal }));
    if (stdin !== null) child.stdin.end(stdin);
  });
}

function credentialSecrets(raw) {
  const secrets = new Set([String(raw || '')]);
  try {
    const parsed = JSON.parse(String(raw || ''));
    const visit = value => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => {
        if (/(?:token|secret|password|credential|api[_-]?key)/i.test(key) && typeof child === 'string' && child.length >= 4) secrets.add(child);
        else visit(child);
      });
    };
    visit(parsed);
  } catch {
    // The credential file is copied as opaque content. Exact-content
    // redaction above still protects non-JSON credential formats.
  }
  return [...secrets].filter(Boolean).sort((left, right) => right.length - left.length);
}

function replaceSecret(text, secret) {
  let value = String(text || '');
  for (const candidate of credentialSecrets(secret)) value = value.split(candidate).join('[REDACTED]');
  return value;
}

export class ProductionCodexAdapter {
  constructor({
    model,
    reasoning,
    executable = PRODUCTION_CODEX_PROVIDER.executable,
    authFile = PRODUCTION_CODEX_PROVIDER.authFile,
    expectedVersion = EXPECTED_CODEX_CLI_VERSION,
    timeoutMs = CODEX_GENERATION_DEADLINE_MS,
    killGraceMs = PRODUCTION_CODEX_PROVIDER.killGraceMs,
    spawnImpl = spawn,
    temporaryRoot = os.tmpdir()
  } = {}) {
    if (!model) throw new Error('Codex model identifier is required.');
    if (!reasoning) throw new Error('Codex reasoning effort is required.');
    this.kind = 'cloud-codex-generation';
    this.model = model;
    this.reasoning = reasoning;
    this.executable = executable;
    this.authFile = authFile;
    this.expectedVersion = expectedVersion;
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
    this.spawn = spawnImpl;
    this.temporaryRoot = temporaryRoot;
  }

  async verifyCli() {
    const child = this.spawn(this.executable, ['--version'], { env: subprocessEnv(this.executable), stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await collectChild(child);
    if (result.exitCode !== 0) {
      throw adapterError(`Codex version check exited ${result.exitCode}.`, { code: 'CODEX_VERSION_CHECK_FAILED', boundary: 'environment', ...result });
    }
    if (result.stdout.trim() !== this.expectedVersion) {
      throw adapterError(`Codex CLI version mismatch: expected ${this.expectedVersion}, found ${result.stdout.trim() || 'empty output'}.`, {
        code: 'CODEX_VERSION_MISMATCH', boundary: 'environment', ...result
      });
    }
    return result.stdout.trim();
  }

  async verifyAuthentication() {
    let stat;
    try {
      stat = await fs.stat(this.authFile);
    } catch {
      throw adapterError('Codex authentication is unavailable.', { code: 'CODEX_AUTH_UNAVAILABLE', boundary: 'provider_auth' });
    }
    if (!stat.isFile()) throw adapterError('Codex authentication path is not a regular file.', { code: 'CODEX_AUTH_UNAVAILABLE', boundary: 'provider_auth' });
    const child = this.spawn(this.executable, ['login', 'status'], { env: subprocessEnv(this.executable), stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await collectChild(child);
    const status = `${result.stdout}${result.stderr}`.trim().replace(/\s+/g, ' ');
    if (result.exitCode !== 0 || status !== 'Logged in using ChatGPT') {
      throw adapterError('Codex ChatGPT subscription authentication is not active.', { code: 'CODEX_AUTH_UNAVAILABLE', boundary: 'provider_auth', ...result });
    }
    return status;
  }

  async createPrivateWorkspace() {
    const root = await fs.mkdtemp(path.join(this.temporaryRoot, 'anyways-production-codex-'));
    try {
      await fs.chmod(root, 0o700);
      const codexHome = path.join(root, 'codex-home');
      const workspace = path.join(root, 'workspace');
      await fs.mkdir(codexHome, { mode: 0o700 });
      await fs.mkdir(workspace, { mode: 0o700 });
      const privateAuth = path.join(codexHome, 'auth.json');
      await fs.copyFile(this.authFile, privateAuth);
      await fs.chmod(privateAuth, 0o600);
      const privateAgent = path.join(codexHome, 'AGENTS.md');
      await fs.writeFile(privateAgent, GENERIC_CODEX_AGENT, { mode: 0o600 });
      for (const [label, file, expectedMode] of [
        ['temporary root', root, 0o700],
        ['private CODEX_HOME', codexHome, 0o700],
        ['private credential', privateAuth, 0o600],
        ['generic AGENTS.md', privateAgent, 0o600]
      ]) {
        const mode = (await fs.stat(file)).mode & 0o777;
        if (mode !== expectedMode) throw adapterError(`Insecure ${label} permissions.`, { code: 'CODEX_PRIVATE_HOME_INSECURE', boundary: 'environment' });
      }
      return { root, codexHome, workspace, outputFile: path.join(root, 'last-message.txt') };
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async generate({ prompt, stage = 'generation', signal, onProviderStart = null } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Codex generation requires a prompt.');
    if (signal?.aborted) {
      const error = new Error('Codex generation was cancelled before start.');
      error.code = 'CODEX_CANCELLED';
      throw error;
    }
    await this.verifyCli();
    await this.verifyAuthentication();
    let privateWorkspace;
    const started = performance.now();
    let credentialText = '';
    try {
      credentialText = await fs.readFile(this.authFile, 'utf8');
      privateWorkspace = await this.createPrivateWorkspace();
      const args = codexArguments({ model: this.model, reasoning: this.reasoning, outputFile: privateWorkspace.outputFile });
      const response = await new Promise((resolve, reject) => {
        const child = this.spawn(this.executable, args, {
          cwd: privateWorkspace.workspace,
          env: subprocessEnv(this.executable, { CODEX_HOME: privateWorkspace.codexHome, NO_COLOR: '1' }),
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let closed = false;
        let terminating = false;
        let timeoutTimer;
        let killTimer;
        child.once('spawn', () => {
          try {
            onProviderStart?.({ executable: this.executable, stage, model: this.model });
          } catch (error) {
            terminating = true;
            child.kill('SIGTERM');
            reject(error);
          }
        });
        const stopTimers = () => { clearTimeout(timeoutTimer); clearTimeout(killTimer); };
        const terminate = (reason, code, boundary) => {
          if (terminating || closed) return;
          terminating = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, this.killGraceMs);
          const error = adapterError(reason, { code, boundary, stdout: replaceSecret(stdout, credentialText), stderr: replaceSecret(stderr, credentialText) });
          error.details.timeout_layer = code === 'CODEX_ADAPTER_TIMEOUT' ? 'adapter_deadline' : 'cancellation';
          error.details.configured_timeout_ms = this.timeoutMs;
          error.details.elapsed_ms = performance.now() - started;
          error.details.no_retry = true;
          // The close event completes process cleanup; this rejection is held
          // until then so callers never outlive the child process.
          child.once('close', () => reject(error));
        };
        timeoutTimer = setTimeout(() => terminate(`Codex request timed out after ${this.timeoutMs}ms.`, 'CODEX_ADAPTER_TIMEOUT', 'timeout'), this.timeoutMs);
        const onAbort = () => terminate('Codex request was cancelled.', 'CODEX_CANCELLED', 'cancellation');
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('error', cause => {
          stopTimers();
          signal?.removeEventListener('abort', onAbort);
          reject(adapterError(`Codex process failed to start: ${cause.message}`, { code: 'CODEX_TRANSPORT_FAILURE', boundary: 'transport', stdout, stderr }));
        });
        child.once('close', (exitCode, signalName) => {
          closed = true;
          stopTimers();
          signal?.removeEventListener('abort', onAbort);
          if (terminating) return;
          if (exitCode !== 0) {
            reject(adapterError(`Codex exited ${exitCode ?? 'without an exit code'}${signalName ? ` (${signalName})` : ''}.`, {
              code: exitCode === null ? 'CODEX_CANCELLATION_FAILURE' : 'CODEX_NONZERO_EXIT',
              boundary: exitCode === null ? 'cancellation' : 'provider', stdout, stderr, exitCode, signal: signalName
            }));
            return;
          }
          resolve({ stdout, stderr, exitCode, signal: signalName });
        });
        child.stdin.end(prompt);
      });
      let outputFileContent;
      try {
        outputFileContent = await fs.readFile(privateWorkspace.outputFile, 'utf8');
      } catch (cause) {
        throw adapterError(`Codex output-last-message file is unavailable: ${cause.message}`, {
          code: 'CODEX_OUTPUT_FILE_MISSING', boundary: 'output_decoding', stdout: response.stdout, stderr: response.stderr, exitCode: response.exitCode
        });
      }
      const decoded = decodeCodexJsonl(response.stdout, { stderr: response.stderr, exitCode: response.exitCode, outputFileContent });
      const wallMs = performance.now() - started;
      return {
        raw: decoded.content,
        stage,
        metrics: {
          wall_ms: wallMs,
          provider_prompt_tokens: decoded.usage?.input_tokens ?? null,
          provider_output_tokens: decoded.usage?.output_tokens ?? null,
          model_usage: calculateCodexUsage({ model: this.model, reasoning: this.reasoning, stage, usage: decoded.usage || {}, wallMs }),
          adapter_transport: {
            raw_stdout: replaceSecret(response.stdout, credentialText),
            raw_stderr: replaceSecret(response.stderr, credentialText),
            exit_code: response.exitCode,
            signal: response.signal,
            output_format: 'jsonl',
            output_file_match: true,
            tool_event_count: 0,
            usage: decoded.usage,
            codex_cli_version: this.expectedVersion,
            model: this.model,
            reasoning_effort: this.reasoning,
            attempts: 1
          }
        }
      };
    } catch (error) {
      if (error?.details) {
        error.details.raw_stdout = replaceSecret(error.details.raw_stdout, credentialText);
        error.details.raw_stderr = replaceSecret(error.details.raw_stderr, credentialText);
      }
      throw error;
    } finally {
      if (privateWorkspace?.root) await fs.rm(privateWorkspace.root, { recursive: true, force: true });
    }
  }
}

export function createProductionCodexAdapter(options = {}) {
  return new ProductionCodexAdapter(options);
}
