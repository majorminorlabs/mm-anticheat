import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const EXPECTED_CODEX_CLI_VERSION = 'codex-cli 0.146.0';
export const CODEX_GENERATION_DEADLINE_MS = 600000;

export const GENERIC_CODEX_AGENT = `# Anyways benchmark execution

Execute the supplied benchmark request exactly as written. This environment is
provider-neutral and intentionally has no tools, browsing, skills, plugins,
repository context, prior session state, or outside research. Return only the
response requested by the benchmark payload.
`;

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

function codexError(message, {
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
    raw_stdout: stdout,
    raw_stderr: stderr,
    exit_code: exitCode,
    signal,
    offending_event: offendingEvent
  };
  return error;
}

function unexpectedToolEvent(event) {
  if (!event || typeof event !== 'object') return true;
  if (!ALLOWED_EVENT_TYPES.has(event.type)) return true;
  if ((event.type === 'item.started' || event.type === 'item.completed') &&
      !ALLOWED_ITEM_TYPES.has(event.item?.type)) return true;
  return false;
}

export function decodeCodexJsonl(stdout, {
  stderr = '',
  exitCode = 0,
  outputFileContent
} = {}) {
  const raw = String(stdout);
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) {
    throw codexError('Codex JSONL output was empty.', {
      code: 'CODEX_MISSING_ASSISTANT_CONTENT',
      boundary: 'output_decoding',
      stdout: raw,
      stderr,
      exitCode
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
      throw codexError(`Codex emitted malformed JSONL on line ${index + 1}: ${cause.message}`, {
        code: 'CODEX_MALFORMED_JSONL',
        boundary: 'output_decoding',
        stdout: raw,
        stderr,
        exitCode
      });
    }
    events.push(event);
    if (unexpectedToolEvent(event)) {
      throw codexError(`Codex emitted unexpected activity: ${event?.type || 'invalid event'}.`, {
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
        throw codexError('Codex completed an assistant message without text.', {
          code: 'CODEX_MISSING_ASSISTANT_CONTENT',
          boundary: 'output_decoding',
          stdout: raw,
          stderr,
          exitCode,
          offendingEvent: event
        });
      }
      completedMessages.push(event.item.text);
    }
    if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
      usage = structuredClone(event.usage);
    }
  }
  if (completedMessages.length === 0) {
    throw codexError('Codex JSONL contained no completed assistant message.', {
      code: 'CODEX_MISSING_ASSISTANT_CONTENT',
      boundary: 'output_decoding',
      stdout: raw,
      stderr,
      exitCode
    });
  }
  const content = completedMessages.at(-1);
  if (typeof outputFileContent !== 'string' || outputFileContent !== content) {
    throw codexError('Codex JSONL assistant content contradicted output-last-message.', {
      code: 'CODEX_OUTPUT_MISMATCH',
      boundary: 'output_decoding',
      stdout: raw,
      stderr,
      exitCode
    });
  }
  return { content, events, usage };
}

function collectChild(child, { stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ stdout, stderr, exitCode, signal }));
    if (stdin !== null) child.stdin.end(stdin);
  });
}

export class CodexSubscriptionBenchmarkAdapter {
  constructor({
    model,
    reasoning,
    executable = '/Users/dippo/.nvm/versions/node/v24.14.1/bin/codex',
    authFile = path.join(os.homedir(), '.codex', 'auth.json'),
    expectedVersion = EXPECTED_CODEX_CLI_VERSION,
    timeoutMs = CODEX_GENERATION_DEADLINE_MS,
    killGraceMs = 2000,
    spawnImpl = spawn,
    allowPaidGeneration = false,
    temporaryRoot = os.tmpdir()
  } = {}) {
    if (!model) throw new Error('Codex model identifier is required.');
    if (!reasoning) throw new Error('Codex reasoning effort is required.');
    this.kind = 'cloud';
    this.model = model;
    this.reasoning = reasoning;
    this.executable = executable;
    this.authFile = authFile;
    this.expectedVersion = expectedVersion;
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
    this.spawn = spawnImpl;
    this.allowPaidGeneration = allowPaidGeneration;
    this.temporaryRoot = temporaryRoot;
  }

  async verifyCli() {
    const child = this.spawn(this.executable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await collectChild(child);
    if (result.exitCode !== 0) {
      throw codexError(`Codex version check exited ${result.exitCode}.`, {
        code: 'CODEX_VERSION_CHECK_FAILED',
        boundary: 'environment',
        ...result
      });
    }
    if (result.stdout.trim() !== this.expectedVersion) {
      throw codexError(`Codex CLI version mismatch: expected ${this.expectedVersion}, found ${result.stdout.trim() || 'empty output'}.`, {
        code: 'CODEX_VERSION_MISMATCH',
        boundary: 'environment',
        ...result
      });
    }
    return result.stdout.trim();
  }

  async verifyAuthentication() {
    let stat;
    try {
      stat = await fs.stat(this.authFile);
    } catch {
      throw codexError('Codex authentication is unavailable.', {
        code: 'CODEX_AUTH_UNAVAILABLE',
        boundary: 'provider_auth'
      });
    }
    if (!stat.isFile()) {
      throw codexError('Codex authentication path is not a regular file.', {
        code: 'CODEX_AUTH_UNAVAILABLE',
        boundary: 'provider_auth'
      });
    }
    const child = this.spawn(this.executable, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await collectChild(child);
    const status = `${result.stdout}${result.stderr}`.trim();
    if (result.exitCode !== 0 || status !== 'Logged in using ChatGPT') {
      throw codexError('Codex ChatGPT subscription authentication is not active.', {
        code: 'CODEX_AUTH_UNAVAILABLE',
        boundary: 'provider_auth',
        ...result
      });
    }
    return status;
  }

  async createPrivateWorkspace() {
    const root = await fs.mkdtemp(path.join(this.temporaryRoot, 'anyways-benchmark-codex-'));
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
        if (mode !== expectedMode) {
          throw codexError(`Insecure ${label} permissions: expected ${expectedMode.toString(8)}, found ${mode.toString(8)}.`, {
            code: 'CODEX_PRIVATE_HOME_INSECURE',
            boundary: 'environment'
          });
        }
      }
      return {
        root,
        codexHome,
        workspace,
        outputFile: path.join(root, 'last-message.txt')
      };
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async generate({ prompt, stage }) {
    if (!this.allowPaidGeneration) {
      throw new Error('Paid Codex generation is disabled. Explicit official-run authorization is required.');
    }
    await this.verifyCli();
    await this.verifyAuthentication();
    let privateWorkspace;
    const started = performance.now();
    try {
      privateWorkspace = await this.createPrivateWorkspace();
      const args = codexArguments({
        model: this.model,
        reasoning: this.reasoning,
        outputFile: privateWorkspace.outputFile
      });
      const response = await new Promise((resolve, reject) => {
        const child = this.spawn(this.executable, args, {
          cwd: privateWorkspace.workspace,
          env: {
            ...process.env,
            CODEX_HOME: privateWorkspace.codexHome,
            NO_COLOR: '1'
          },
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let closed = false;
        let timedOut = false;
        let graceTimer = null;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          graceTimer = setTimeout(() => {
            if (!closed) child.kill('SIGKILL');
          }, this.killGraceMs);
        }, this.timeoutMs);
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('error', cause => {
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          reject(codexError(`Codex process failed to start: ${cause.message}`, {
            code: 'CODEX_TRANSPORT_FAILURE',
            boundary: 'transport',
            stdout,
            stderr
          }));
        });
        child.once('close', (exitCode, signal) => {
          closed = true;
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          if (timedOut) {
            const error = codexError(`Codex request timed out after ${this.timeoutMs}ms.`, {
              code: 'CODEX_ADAPTER_TIMEOUT',
              boundary: 'timeout',
              stdout,
              stderr,
              exitCode,
              signal
            });
            error.details.timeout_layer = 'adapter_deadline';
            error.details.configured_timeout_ms = this.timeoutMs;
            error.details.elapsed_ms = performance.now() - started;
            error.details.no_retry = true;
            reject(error);
            return;
          }
          if (exitCode !== 0) {
            reject(codexError(`Codex exited ${exitCode ?? 'without an exit code'}${signal ? ` (${signal})` : ''}.`, {
              code: exitCode === null ? 'CODEX_CANCELLATION_FAILURE' : 'CODEX_NONZERO_EXIT',
              boundary: exitCode === null ? 'cancellation' : 'provider',
              stdout,
              stderr,
              exitCode,
              signal
            }));
            return;
          }
          resolve({ stdout, stderr, exitCode, signal });
        });
        child.stdin.end(prompt);
      });
      let outputFileContent;
      try {
        outputFileContent = await fs.readFile(privateWorkspace.outputFile, 'utf8');
      } catch (cause) {
        throw codexError(`Codex output-last-message file is unavailable: ${cause.message}`, {
          code: 'CODEX_OUTPUT_FILE_MISSING',
          boundary: 'output_decoding',
          stdout: response.stdout,
          stderr: response.stderr,
          exitCode: response.exitCode
        });
      }
      const decoded = decodeCodexJsonl(response.stdout, {
        stderr: response.stderr,
        exitCode: response.exitCode,
        outputFileContent
      });
      return {
        raw: decoded.content,
        stage,
        metrics: {
          wall_ms: performance.now() - started,
          provider_prompt_tokens: decoded.usage?.input_tokens ?? null,
          provider_output_tokens: decoded.usage?.output_tokens ?? null,
          adapter_transport: {
            raw_stdout: response.stdout,
            raw_stderr: response.stderr,
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
    } finally {
      if (privateWorkspace?.root) {
        await fs.rm(privateWorkspace.root, { recursive: true, force: true });
      }
    }
  }
}
