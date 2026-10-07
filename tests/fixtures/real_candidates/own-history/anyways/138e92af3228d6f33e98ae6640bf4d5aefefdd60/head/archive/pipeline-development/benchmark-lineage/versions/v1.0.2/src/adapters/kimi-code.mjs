import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const NO_TOOL_AGENT = `---
name: anyways-benchmark
description: Produce one response from a frozen Anyways benchmark payload.
tools: []
subagents: []
---

Follow the supplied benchmark payload exactly. You have no tools, skills,
browsing, repository access, prior session, or outside research. Return only
the requested schema.
`;

export function kimiArguments({ model, agentFile, skillsDirectory, prompt }) {
  return [
    '--agent-file',
    agentFile,
    '--skills-dir',
    skillsDirectory,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--prompt',
    prompt
  ];
}

function adapterError(message, { code = 'KIMI_ADAPTER_FAILURE', stdout = '', stderr = '', exitCode = null } = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = {
    raw_stdout: stdout,
    raw_stderr: stderr,
    exit_code: exitCode
  };
  return error;
}

export function decodeKimiJsonl(stdout, { stderr = '', exitCode = 0 } = {}) {
  const raw = String(stdout);
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const assistantContent = [];

  for (let index = 0; index < lines.length; index += 1) {
    let envelope;
    try {
      envelope = JSON.parse(lines[index]);
    } catch (cause) {
      throw adapterError(`Kimi emitted malformed JSONL on line ${index + 1}: ${cause.message}`, {
        code: 'KIMI_MALFORMED_JSONL',
        stdout: raw,
        stderr,
        exitCode
      });
    }
    if (envelope?.role !== 'assistant') continue;
    if (typeof envelope.content !== 'string') continue;
    assistantContent.push(envelope.content);
  }

  if (assistantContent.length === 0) {
    throw adapterError('Kimi stream-json output contained no assistant content.', {
      code: 'KIMI_MISSING_ASSISTANT_CONTENT',
      stdout: raw,
      stderr,
      exitCode
    });
  }
  return assistantContent.join('');
}

export class KimiCodeBenchmarkAdapter {
  constructor({
    model,
    executable = '/Users/dippo/.kimi-code/bin/kimi',
    timeoutMs = 600000,
    spawnImpl = spawn,
    allowPaidGeneration = false
  } = {}) {
    if (!model) throw new Error('Kimi model alias is required.');
    this.kind = 'cloud';
    this.model = model;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.spawn = spawnImpl;
    this.allowPaidGeneration = allowPaidGeneration;
  }

  async generate({ prompt, stage }) {
    if (!this.allowPaidGeneration) throw new Error('Paid Kimi generation is disabled. Explicit official-run authorization is required.');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-benchmark-kimi-'));
    const agentFile = path.join(workspace, 'benchmark-agent.md');
    const skillsDirectory = path.join(workspace, 'empty-skills');
    await fs.mkdir(skillsDirectory);
    await fs.writeFile(agentFile, NO_TOOL_AGENT, { mode: 0o600 });
    const args = kimiArguments({ model: this.model, agentFile, skillsDirectory, prompt });
    const started = performance.now();
    try {
      const response = await new Promise((resolve, reject) => {
        const child = this.spawn(this.executable, args, {
          cwd: workspace,
          env: {
            ...process.env,
            KIMI_CODE_EXPERIMENTAL_FLAG: '1',
            KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '1',
            NO_COLOR: '1'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = callback => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback();
        };
        const timer = setTimeout(() => {
          const error = adapterError(`Kimi request timed out after ${this.timeoutMs}ms.`, {
            code: 'KIMI_ADAPTER_TIMEOUT',
            stdout,
            stderr
          });
          error.details.timeout_layer = 'adapter_deadline';
          error.details.configured_timeout_ms = this.timeoutMs;
          error.details.elapsed_ms = performance.now() - started;
          finish(() => {
            child.kill('SIGTERM');
            reject(error);
          });
        }, this.timeoutMs);
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', error => finish(() => reject(error)));
        child.on('close', code => finish(() => {
          const diagnostic = stderr.trim().slice(-1000);
          if (code !== 0) {
            reject(adapterError(`Kimi exited ${code}${diagnostic ? `: ${diagnostic}` : '.'}`, {
              code: 'KIMI_NONZERO_EXIT',
              stdout,
              stderr,
              exitCode: code
            }));
            return;
          }
          try {
            resolve({
              content: decodeKimiJsonl(stdout, { stderr, exitCode: code }),
              stdout,
              stderr,
              exitCode: code
            });
          } catch (error) {
            reject(error);
          }
        }));
      });
      return {
        raw: response.content,
        stage,
        metrics: {
          wall_ms: performance.now() - started,
          provider_prompt_tokens: null,
          provider_output_tokens: null,
          adapter_transport: {
            raw_stdout: response.stdout,
            raw_stderr: response.stderr,
            exit_code: response.exitCode,
            output_format: 'stream-json'
          }
        }
      };
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
}
