import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260818090000_homepage_editorial_slots.sql', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/design/design.css', import.meta.url), 'utf8');

test('homepage arrangement persists one lead and exactly four bounded Featured positions', () => {
  assert.match(migration, /create table if not exists public\.homepage_featured_slots/);
  assert.match(migration, /position smallint primary key check \(position between 1 and 4\)/);
  assert.match(migration, /featured_at timestamptz not null default now\(\)/);
  assert.match(migration, /create unique index if not exists homepage_featured_slots_story_idx/);
  assert.match(migration, /create table if not exists public\.homepage_featured_exclusions/);
  assert.match(migration, /homepage_featured_requested boolean not null default false/);
});

test('empty slots use newest eligible stories and explicit Featured requests replace the oldest slot', () => {
  assert.match(migration, /create or replace function public\.fill_homepage_featured_slots/);
  assert.match(migration, /order by story\.published_at desc, story\.id\s+limit 1/);
  assert.match(migration, /create or replace function public\.place_homepage_featured_story/);
  assert.match(migration, /order by slot\.featured_at asc, slot\.position asc/);
  assert.match(migration, /perform public\.fill_homepage_featured_slots\(now\(\), actor_id\)/);
});

test('publication and newsroom actions use the same durable arrangement contract', () => {
  assert.match(migration, /create trigger sync_homepage_story_publication/);
  assert.match(migration, /after insert or update of status, published_at, homepage_featured_requested/);
  assert.match(migration, /create or replace function public\.set_homepage_featured_preference/);
  assert.match(migration, /create or replace function public\.set_homepage_arrangement/);
  assert.match(migration, /grant execute on function public\.set_homepage_arrangement\(uuid, text\) to authenticated/);
  assert.match(migration, /create or replace function public\.get_homepage_arrangement_newsroom/);
  assert.match(migration, /grant execute on function public\.get_homepage_story_ids\(timestamptz\) to anon, authenticated/);
});

test('migration preserves existing data and does not perform broad destructive cleanup', () => {
  assert.doesNotMatch(migration, /drop table public\.stories|drop column .*stories|truncate\s+public\.|delete from public\.stories/i);
  assert.match(migration, /from public\._homepage_ranking_rows\(now\(\)/);
});

test('newsroom exposes lead, Featured preference, and automatic replacement language', () => {
  assert.match(app, /get_homepage_arrangement_newsroom/);
  assert.match(app, /homepage_featured_requested/);
  assert.match(app, /Add to Featured when published/);
  assert.match(app, /Featured stays full by filling empty slots with the newest eligible stories/);
  assert.match(app, /set_homepage_arrangement/);
  assert.match(css, /homepage-slot-grid/);
  assert.match(css, /homepage-story-picker/);
});
