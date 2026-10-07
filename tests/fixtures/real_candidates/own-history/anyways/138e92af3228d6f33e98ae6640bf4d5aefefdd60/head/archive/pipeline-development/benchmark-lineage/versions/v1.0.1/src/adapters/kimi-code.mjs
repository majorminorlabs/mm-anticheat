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
    'text',
    '--prompt',
    prompt
  ];
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
      const raw = await new Promise((resolve, reject) => {
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
          child.kill('SIGTERM');
          finish(() => reject(new Error(`Kimi request timed out after ${this.timeoutMs}ms.`)));
        }, this.timeoutMs);
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', error => finish(() => reject(error)));
        child.on('close', code => finish(() => {
          const output = stdout.trim();
          const diagnostic = stderr.trim().slice(-1000);
          if (code !== 0) {
            reject(new Error(`Kimi exited ${code}${diagnostic ? `: ${diagnostic}` : '.'}`));
          } else if (!output) {
            reject(new Error(`Kimi exited 0 with empty stdout${diagnostic ? `: ${diagnostic}` : '.'}`));
          } else {
            resolve(output);
          }
        }));
      });
      return {
        raw,
        stage,
        metrics: {
          wall_ms: performance.now() - started,
          provider_prompt_tokens: null,
          provider_output_tokens: null
        }
      };
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
}
