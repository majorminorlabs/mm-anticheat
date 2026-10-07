import fs from 'node:fs/promises'; import path from 'node:path';
const secret = /(service_role|supabase.*key|authorization|bearer)\s*[=:]\s*[^\s]+/ig;
export const redact = (value: string) => value.replace(secret, '$1=[REDACTED]');
export class Logger { constructor(private dir: string, private jobId?: string) {} async write(level: string, message: string, meta: Record<string, unknown> = {}) { const line = JSON.stringify({ at: new Date().toISOString(), level, job_id: this.jobId || null, message: redact(message), ...meta }) + '\n'; await fs.mkdir(this.dir, { recursive: true }); await fs.appendFile(path.join(this.dir, this.jobId ? `job-${this.jobId}.log` : 'controller.log'), line); process.stdout.write(line); } }
