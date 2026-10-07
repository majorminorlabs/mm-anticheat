import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { filterPipelineQueue, lineDiff, pipelineMetadata } from '../src/newsroom-pipeline.mjs';
import { imageMayMaterialize, materializationState } from '../src/pipeline/materialization.mjs';
const candidate = { id:'6b181e22964c3ab1b944e0fb68e03593ca1cd7ae58fc5ce12c9e45a55561d315', status:'ready_for_review', created_at:'2026-07-28T00:00:00Z', source_count:1, unresolved_claim_count:0, rights_warning_count:1, classification:{ primary_section:'internet', recurring_beats:['technology'], tags:['ai'], review_warnings:['Verify one claim.'], revision_suggestions:['Tighten the dek.'] } };
test('pipeline candidate maps taxonomy and advisory counts into newsroom metadata', () => { const meta = pipelineMetadata(candidate); assert.equal(meta.section,'internet'); assert.deepEqual(meta.beats,['technology']); assert.deepEqual(meta.tags,['ai']); assert.equal(meta.status,'ready_for_review'); assert.equal(meta.reviewWarnings,1); assert.equal(meta.revisionSuggestions,1); });
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
  assert.equal(imageMayMaterialize({ selected: true, rights_status: 'approved' }), true);
  assert.equal(imageMayMaterialize({ selected: true, rights_status: 'manual_review' }), false);
  assert.equal(imageMayMaterialize({ selected: true, rights_status: 'metadata_incomplete' }), false);
  assert.equal(imageMayMaterialize({ selected: false, rights_status: 'approved' }), false);
});
test('approval atomically materializes the article, moves it to Ready, and carries only a cleared selected photo', async () => {
  const [app, materializationMigration, workflowMigration] = await Promise.all([
    readFile(new URL('../src/app.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260728120000_materialize_pipeline_story.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260728160000_editorial_on_deck_workflow.sql', import.meta.url), 'utf8')
  ]);
  assert.match(app, /Approve for On Deck/);
  assert.match(app, /sb\.rpc\('approve_pipeline_story', \{ p_candidate_id: databaseCandidateId \}\)/);
  assert.match(app, /location\.href = `\/newsroom\/stories\?status=ready#candidate-\$\{saved\.id\}`/);
  assert.match(app, /editorDecision === 'approve'\) location\.href = `\/newsroom\/stories\?status=ready#candidate-\$\{saved\.id\}`/);
  assert.match(app, /sb\.rpc\('restore_pipeline_sources', \{ p_story_id: id \}\)/);
  assert.match(materializationMigration, /return query select existing_link\.story_id, false/);
  assert.match(workflowMigration, /security definer/);
  assert.match(workflowMigration, /not public\.is_editor\(\)/);
  assert.match(workflowMigration, /from public\.materialize_pipeline_story\(candidate\.id\)/);
  assert.match(workflowMigration, /set status = 'fact_check'/);
  assert.match(workflowMigration, /rights_status in \('verified_reusable', 'official_press_asset'\)/);
  const rightsMigration = await readFile(new URL('../supabase/migrations/20260730030000_deterministic_image_rights_gate.sql', import.meta.url), 'utf8');
  assert.match(rightsMigration, /candidate\.rights_status = 'approved'/);
  assert.match(rightsMigration, /newsroom_media\.rights_status = 'approved'/);
  assert.match(workflowMigration, /set hero_media_id = media_id/);
  assert.match(workflowMigration, /add column if not exists presentation jsonb/);
  assert.match(workflowMigration, /presentation_rights_are_publishable/);
  assert.match(workflowMigration, /then p_patch -> 'presentation'/);
  assert.match(workflowMigration, /scheduled_for = case when p_patch \? 'scheduled_for'/);
  assert.match(workflowMigration, /regexp_replace\(lower\(btrim\(clean_tag\)\)/);
});
test('pipeline approval enters the editor without requiring a primary section', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260814090000_allow_unsectioned_pipeline_editor_drafts.sql', import.meta.url), 'utf8');
  assert.match(migration, /section_id, author_id, editor_id/);
  assert.match(migration, /source_draft\.body_markdown, requested_section, auth\.uid\(\), auth\.uid\(\)/);
  assert.doesNotMatch(migration, /the pipeline candidate has no canonical primary section/);
  assert.match(migration, /set status = 'draft', scheduled_for = null/);
  assert.doesNotMatch(migration, /if not public\.can_publish_story\(editorial_story\)/);
  assert.match(migration, /Approved into the story editor/);
});
test('the story editor permits an unsectioned draft but keeps approval validation', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /<option value="">Choose before approval<\/option>/);
  assert.match(app, /payload\.section_id = String\(payload\.section_id \|\| ''\)\.trim\(\) \|\| null;/);
  assert.match(app, /!payload\.section_id/);
});
test('Stories keeps ready review packages and writer diagnostics on the unified screen', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /candidate=\$\{encodeURIComponent\(candidate\.external_id \|\| candidate\.id\)\}#review-package/);
  assert.match(app, /data-approve-review-candidate/);
  assert.match(app, /approve_pipeline_story/);
  assert.match(app, /job=\$\{encodeURIComponent\(job\.id\)\}#diagnostics/);
  assert.match(app, /pipeline_job_events/);
});
test('On Deck is the release destination for ready stories and saved On Deck edits', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /if \(status === 'ready'\) return story\?\.id \? `<a class="button" href="\/newsroom\/on-deck#story-\$\{esc\(story\.id\)\}">Publish now<\/a>`/);
  assert.match(app, /nextStatus === 'fact_check'\) location\.href = `\/newsroom\/on-deck#story-\$\{saved\.id\}`/);
  assert.match(app, /\['fact_check', 'scheduled'\]\.includes\(s\.status\).*href="\/newsroom\/on-deck#story-\$\{esc\(s\.id\)\}".*Open On Deck/);
  assert.match(app, /if \(pathname === '\/newsroom\/on-deck'\) return onDeck\(\);/);
});
test('On Deck supports confirmed bulk deletion and starts a manual article from a section template', async () => {
  const [app, migration] = await Promise.all([
    readFile(new URL('../src/app.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260809090000_on_deck_story_deletion.sql', import.meta.url), 'utf8')
  ]);
  assert.match(app, /href="\/newsroom\/new">Write an article/);
  assert.match(app, /data-apply-section-template/);
  assert.match(app, /data-queue-select-all/);
  assert.match(app, /data-queue-kind="candidate"/);
  assert.match(app, /sb\.rpc\('delete_newsroom_queue_items', \{ p_story_ids: storyIds, p_candidate_ids: candidateIds, p_confirmation: confirmation \}\)/);
  assert.match(migration, /status in \('fact_check', 'scheduled'\)/);
  assert.match(migration, /perform public\.purge_pipeline_candidate\(candidate_id, 'on_deck_story_deleted'\)/);
  assert.match(migration, /DELETE ON DECK ARTICLES/);
  const queueMigration = await readFile(new URL('../supabase/migrations/20260810110000_newsroom_deletion_workflows.sql', import.meta.url), 'utf8');
  assert.match(queueMigration, /perform public\.purge_pipeline_candidate\(candidate\.id, 'newsroom_queue_deleted'\)/);
  assert.match(queueMigration, /linked_story\.status in \('published', 'scheduled'\)/);
  assert.match(queueMigration, /'story_preserved'/);
  assert.match(queueMigration, /DELETE NEWSROOM ITEMS/);
});
test('a new manual story sends an empty editorial score as null instead of a numeric empty string', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /const editorialScore = String\(payload\.editorial_score \|\| ''\)\.trim\(\);/);
  assert.match(app, /payload\.editorial_score = editorialScore \? Number\(editorialScore\) : null;/);
});
test('the public slug route never resolves an unpublished editorial draft', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /select\(publicStorySelect\)\.eq\('slug', slug\)\.eq\('status', 'published'\)\.lte\('published_at', new Date\(\)\.toISOString\(\)\)\.maybeSingle\(\)/);
});
