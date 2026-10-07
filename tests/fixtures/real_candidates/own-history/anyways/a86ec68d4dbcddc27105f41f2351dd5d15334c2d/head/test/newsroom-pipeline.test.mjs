import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { filterPipelineQueue, lineDiff, pipelineMetadata } from '../src/newsroom-pipeline.mjs';
import { imageMayMaterialize, materializationState } from '../src/pipeline/materialization.mjs';
const candidate = { id:'6b181e22964c3ab1b944e0fb68e03593ca1cd7ae58fc5ce12c9e45a55561d315', status:'ready_for_review', created_at:'2026-07-28T00:00:00Z', source_count:1, unresolved_claim_count:0, rights_warning_count:1, classification:{ primary_section:'internet', recurring_beats:['technology'], tags:['ai'] } };
test('pipeline candidate maps to existing taxonomy-shaped newsroom metadata', () => { const meta = pipelineMetadata(candidate); assert.equal(meta.section,'internet'); assert.deepEqual(meta.beats,['technology']); assert.deepEqual(meta.tags,['ai']); assert.equal(meta.status,'ready_for_review'); });
test('queue filters reuse section, beat, tag, and status', () => { assert.equal(filterPipelineQueue([candidate], {section:'internet',beat:'technology',tag:'ai',status:'ready_for_review'}).length,1); assert.equal(filterPipelineQueue([candidate], {section:'systems'}).length,0); });
test('review version diff preserves additions and removals', () => { assert.deepEqual(lineDiff('one\ntwo','one\nthree'), [{type:'same',text:'one'},{type:'removed',text:'two'},{type:'added',text:'three'}]); });
test('review package resolves external route IDs before querying UUID-backed child records', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /const databaseCandidateId = candidate\.id;/);
  for (const table of ['pipeline_drafts', 'research_packets', 'discovered_documents', 'image_candidates', 'pipeline_review_decisions']) {
    assert.match(app, new RegExp(`sb\\.from\\('${table}'\\)[\\s\\S]{0,120}\\.eq\\('candidate_id', databaseCandidateId\\)`));
  }
});
test('review package retains the claim ledger across editorial draft versions', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /const activeRunId = drafts\[0\]\?\.pipeline_run_id \|\| null; const activeDrafts = drafts\.filter/);
  assert.match(app, /const draftIds = activeDrafts\.map\(draft => draft\.id\);/);
  assert.match(app, /from\('pipeline_claims'\)[\s\S]{0,180}\.in\('draft_id', draftIds\)/);
});
test('review projection limits documents and images to the active processing run', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /const activeDocuments = documents\.filter\(document => !activeRunId \|\| document\.pipeline_run_id === activeRunId\)/);
  assert.match(app, /const activeImages = images\.filter\(image => !activeRunId \|\| image\.pipeline_run_id === activeRunId\)/);
});
test('eligible review candidates expose a materialization action and linked candidates open the existing story', () => {
  assert.deepEqual(materializationState({ status: 'ready_for_review' }), { action: 'create', eligible: true, storyId: null });
  assert.deepEqual(materializationState({ status: 'researching' }), { action: 'create', eligible: false, storyId: null });
  assert.deepEqual(materializationState({ status: 'ready_for_review' }, { story_id: 'story-1' }), { action: 'open', eligible: true, storyId: 'story-1' });
});
test('only selected verified assets can cross from pipeline review to an editorial story', () => {
  assert.equal(imageMayMaterialize({ selected: true, rights_status: 'verified_reusable' }), true);
  assert.equal(imageMayMaterialize({ selected: true, rights_status: 'official_press_asset' }), true);
  assert.equal(imageMayMaterialize({ selected: true, rights_status: 'unknown' }), false);
  assert.equal(imageMayMaterialize({ selected: false, rights_status: 'verified_reusable' }), false);
});
test('materialization uses one editor-only atomic RPC and preserves the normal story workflow', async () => {
  const [app, migration] = await Promise.all([
    readFile(new URL('../src/app.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260728120000_materialize_pipeline_story.sql', import.meta.url), 'utf8')
  ]);
  assert.match(app, /Create Editorial Draft/);
  assert.match(app, /sb\.rpc\('materialize_pipeline_story', \{ p_candidate_id: databaseCandidateId \}\)/);
  assert.match(migration, /security definer/);
  assert.match(migration, /not public\.is_editor\(\)/);
  assert.match(migration, /candidate\.status not in \('ready_for_review', 'approved'\)/);
  assert.match(migration, /'draft', null, null/);
  assert.match(migration, /insert into public\.pipeline_story_links/);
  assert.match(migration, /return query select existing_link\.story_id, false/);
  assert.match(migration, /No pipeline image is copied/);
});
test('the public slug route never resolves an unpublished editorial draft', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /select\(publicStorySelect\)\.eq\('slug', slug\)\.eq\('status', 'published'\)\.lte\('published_at', new Date\(\)\.toISOString\(\)\)\.maybeSingle\(\)/);
});
