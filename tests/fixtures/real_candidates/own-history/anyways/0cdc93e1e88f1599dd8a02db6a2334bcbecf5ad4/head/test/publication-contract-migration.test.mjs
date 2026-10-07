import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PUBLIC_STORY_FIELDS } from '../src/public-contract.mjs';

const migration = await readFile(new URL('../supabase/migrations/20260819090000_premium_publication_contract.sql', import.meta.url), 'utf8');

test('publication migration exposes an explicit anonymous story view', () => {
  const start = migration.indexOf('create view public.published_stories as');
  const end = migration.indexOf('comment on view public.published_stories');
  assert.ok(start >= 0 && end > start);
  const view = migration.slice(start, end);
  assert.doesNotMatch(view, /select\s+\*/i);
  assert.match(view, /where story\.status = 'published'/);
  for (const field of ['id', 'title', 'slug', 'dek', 'body', 'section_id', 'published_at', 'materially_updated_at', 'update_note', 'reading_time_minutes', 'article_format', 'seo_title', 'seo_description', 'social_title', 'social_description']) {
    assert.match(view, new RegExp(`story\\.${field}\\b`), field);
  }
  assert.doesNotMatch(view, /editorial_score|luna_decision|promotion_override|editor_id|author_id/);
  assert.match(migration, /revoke select on public\.stories from public, anon/);
  assert.match(migration, /grant select on public\.published_stories to anon, authenticated/);
  assert.equal(PUBLIC_STORY_FIELDS.includes('editor_id'), false);
});

test('publication migration makes source review and schema version release gates explicit', () => {
  assert.match(migration, /source_review_status text not null default 'pending'/);
  assert.match(migration, /source_review_status <> 'approved'/);
  assert.match(migration, /primary_source boolean not null default false/);
  assert.match(migration, /create trigger guard_premium_publication_gate/);
  assert.match(migration, /tg_op = 'UPDATE'/);
  assert.match(migration, /create or replace function public\.review_story_source/);
  assert.match(migration, /create or replace function public\.search_published_stories/);
  assert.match(migration, /premium-publication-contract-v1/);
});
