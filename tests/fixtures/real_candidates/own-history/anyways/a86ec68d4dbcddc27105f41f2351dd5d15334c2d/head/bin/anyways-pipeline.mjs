#!/usr/bin/env node
import fs from 'node:fs/promises';
import { EditorialPipeline } from '../src/pipeline/workflow.mjs';
const file = process.argv[2];
try {
  if (!file) throw new Error('Usage: node bin/anyways-pipeline.mjs <input.json>');
  const input = JSON.parse(await fs.readFile(file, 'utf8'));
  const result = await new EditorialPipeline().run(input);
  if (result.status !== 'complete') {
    console.log(JSON.stringify({ ok: false, command: 'run_pipeline', error: { code: 'PIPELINE_BLOCKED', message: `Pipeline blocked at ${result.blocked_at || 'unknown stage'}`, retryable: false }, result: { run_id: result.run_id, status: result.status, blocked_at: result.blocked_at || null } }));
    process.exitCode = 2;
  } else console.log(JSON.stringify({ ok: true, command: 'run_pipeline', result: { run_id: result.run_id, status: result.status } }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, command: 'run_pipeline', error: { code: 'PIPELINE_INPUT_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false } }));
  process.exitCode = 1;
}
