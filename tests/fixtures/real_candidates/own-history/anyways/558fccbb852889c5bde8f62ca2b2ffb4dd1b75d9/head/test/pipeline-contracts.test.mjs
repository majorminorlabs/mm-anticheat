import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { PIPELINE_V1_VERSION, isPipelineV1Job } from '../src/pipeline/feature-flags.mjs';
import { PHASE2_VERSION } from '../src/pipeline/phase2-state.mjs';
import { PIPELINE_CONFIG, PRODUCTION_MODELS } from '../src/pipeline/config.mjs';

const contracts = JSON.parse(await fs.readFile(new URL('../packages/pipeline-contracts/contracts.json', import.meta.url), 'utf8'));

test('shared Pipeline V1 contracts match the application runtime', () => {
  assert.equal(PIPELINE_V1_VERSION, contracts.pipeline_versions.request);
  assert.equal(PHASE2_VERSION, contracts.pipeline_versions.storage);
  assert.deepEqual(contracts.research_requirements, ['none', 'required']);
  assert.equal(PIPELINE_CONFIG.discoveryModel, contracts.models.discovery.model);
  assert.equal(PIPELINE_CONFIG.discoveryReasoning, contracts.models.discovery.reasoning);
  assert.equal(PIPELINE_CONFIG.researchModel, contracts.models.research.model);
  assert.equal(PIPELINE_CONFIG.researchReasoning, contracts.models.research.reasoning);
  assert.equal(PIPELINE_CONFIG.draftModel, contracts.models.draft.model);
  assert.equal(PIPELINE_CONFIG.draftReasoning, contracts.models.draft.reasoning);
  assert.equal(PRODUCTION_MODELS.polish.model, contracts.models.polish.model);
  assert.equal(PRODUCTION_MODELS.polish.reasoning, contracts.models.polish.reasoning);
  assert.equal(isPipelineV1Job({ pipeline_version: contracts.pipeline_versions.request }), true);
});

test('controller source is pinned to the same operational contract values', async () => {
  const [classes, config, jobTypes, queue, runner] = await Promise.all([
    fs.readFile(new URL('../apps/controller/src/resources/classes.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/controller/src/config.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/controller/src/jobs/types.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/controller/src/queue/client.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../apps/controller/src/pipeline/runner.ts', import.meta.url), 'utf8')
  ]);
  assert.match(classes, new RegExp(`cloudCodexGeneration: '${contracts.resource_classes.cloud_codex_generation}'`));
  assert.match(classes, new RegExp(`return '${contracts.resource_locks.cloud_codex_generation}'`));
  assert.match(config, new RegExp(`phase2JobTimeoutMs: integer\\('PHASE2_JOB_TIMEOUT_SECONDS', ${contracts.v1_limits.phase2_timeout_seconds}\\)`));
  for (const jobType of contracts.job_types) assert.match(jobTypes, new RegExp(`'${jobType}'`));
  assert.match(classes, /PIPELINE_V1_ALLOWED_JOB_ID/);
  assert.match(runner, /pipeline_version.*v1/);
});
