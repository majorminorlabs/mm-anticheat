import { accessSync, constants, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';

export type CodexReadiness = {
  ok: boolean;
  executable: string;
  version: string | null;
  error: string | null;
};

function executableFile(file: string) {
  try {
    return statSync(file).isFile() && (accessSync(file, constants.X_OK), true);
  } catch {
    return false;
  }
}

function run(file: string, args: string[], timeoutMs = 5_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      cwd: path.dirname(file),
      env: { ...process.env, HOME: process.env.HOME || os.homedir(), PATH: [path.dirname(file), process.env.PATH].filter(Boolean).join(':') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${args.join(' ')} timed out.`)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function checkCodexReadiness(config: Pick<Config, 'codexExecutable'>): Promise<CodexReadiness> {
  const executable = config.codexExecutable;
  if (!path.isAbsolute(executable)) return { ok: false, executable, version: null, error: 'ANYWAYS_CODEX_BIN must be absolute.' };
  if (!executableFile(executable)) return { ok: false, executable, version: null, error: 'Configured Codex executable is missing or not executable.' };
  try {
    const versionResult = await run(executable, ['--version']);
    const version = versionResult.stdout.trim();
    if (versionResult.code !== 0 || version !== 'codex-cli 0.146.0') return { ok: false, executable, version: version || null, error: `Codex version check failed: ${version || versionResult.stderr.trim() || `exit ${versionResult.code}`}.` };
    const loginResult = await run(executable, ['login', 'status']);
    const loginStatus = `${loginResult.stdout}${loginResult.stderr}`.trim().replace(/\s+/g, ' ');
    if (Number(loginResult.code) !== 0 || !loginStatus.includes('Logged in using ChatGPT')) {
      const detail = [loginResult.stdout.trim(), loginResult.stderr.trim(), `exit ${loginResult.code}`].filter(Boolean).join(' ').slice(0, 300);
      return { ok: false, executable, version, error: `Codex authentication status is unavailable${detail ? `: ${detail}` : ''}.` };
    }
    return { ok: true, executable, version, error: null };
  } catch (error) {
    return { ok: false, executable, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}
