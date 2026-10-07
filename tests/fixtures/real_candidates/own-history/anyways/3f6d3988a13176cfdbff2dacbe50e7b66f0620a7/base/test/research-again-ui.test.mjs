import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('unified Stories owns the canonical Research Again action and keeps legacy routes redirected', async () => {
  const source = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(source, /function researchAgainActionMarkup/);
  assert.match(source, /data-research-again/);
  assert.match(source, /data-research-again="\$\{externalId\}"/);
  assert.match(source, /researchAgainRequest\(record\.candidate, record\.job\)/);
  assert.match(source, /pipeline_jobs'\)\.select\('id,pipeline_candidate_id,job_type,parameters,status,error,result,/);
  assert.match(source, /data-research-again-disabled disabled/);
  assert.match(source, /data-research-again-dialog/);
  assert.match(source, /data-research-again-confirm/);
  assert.match(source, /Preserved assignment/);
  assert.match(source, /More research is required before this story can be drafted/);
  assert.doesNotMatch(source, /data-phase2-action="research_again"/);
  assert.match(source, /pathname === '\/newsroom\/pipeline'|pathname === '\/newsroom\/review'/);
});
