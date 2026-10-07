import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260815100000_source_graph_v3_breaking_sources.sql', import.meta.url), 'utf8');
const proposals = fs.readFileSync(new URL('../supabase/migrations/20260815110000_hermes_source_proposals.sql', import.meta.url), 'utf8');
const editorialPackage = fs.readFileSync(new URL('../supabase/migrations/20260815120000_hermes_editorial_package.sql', import.meta.url), 'utf8');
const qualityFilters = fs.readFileSync(new URL('../supabase/migrations/20260815130000_hermes_proposal_quality_filters.sql', import.meta.url), 'utf8');
const filterPrecision = fs.readFileSync(new URL('../supabase/migrations/20260815140000_hermes_proposal_filter_precision.sql', import.meta.url), 'utf8');
const backlogCap = fs.readFileSync(new URL('../supabase/migrations/20260815150000_hermes_proposal_backlog_cap.sql', import.meta.url), 'utf8');
const freshness = fs.readFileSync(new URL('../supabase/migrations/20260816150000_source_graph_freshness.sql', import.meta.url), 'utf8');
const evaluationState = fs.readFileSync(new URL('../supabase/migrations/20260816152000_source_graph_evaluation_state.sql', import.meta.url), 'utf8');
const evaluationHandoff = fs.readFileSync(new URL('../supabase/migrations/20260816153000_source_graph_evaluation_handoff.sql', import.meta.url), 'utf8');
const canonicalFeedUrls = fs.readFileSync(new URL('../supabase/migrations/20260816170000_source_graph_canonical_feed_urls.sql', import.meta.url), 'utf8');
const editorialGate = fs.readFileSync(new URL('../supabase/migrations/20260816180000_source_graph_editorial_gate.sql', import.meta.url), 'utf8');

test('Source Graph V3 adds the consumer, collectible, incident, policy, and event source roles', () => {
  assert.match(migration, /add column if not exists pipeline_role/);
  assert.match(migration, /add column if not exists editorial_fit/);
  for (const locator of [
    'https://www.dlnews.com/arc/outboundfeeds/rss/category/articles/people-culture/',
    'https://nftnow.com/feed/',
    'https://toybook.com/category/product-launches/trading-cards/feed/',
    'https://www.pokebeach.com/forums/forum/-/index.rss',
    'https://blog.bubblemaps.io/rss/',
    'https://web3isgoinggreat.com/feed.xml',
    'https://www.cftc.gov/RSS/RSSENF/rssenf.xml',
    'https://www.justice.gov/news/rss?m=1'
  ]) assert.match(migration, new RegExp(locator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(migration, /ingestion_status = 'ready'/);
  assert.match(migration, /Source Graph V3/);
  assert.doesNotMatch(migration, /insert into public\.(stories|pipeline_jobs|luna_|editorial_scoring)/i);
});

test('canonical feed URL repair keeps strict host validation and preserves staging boundaries', () => {
  for (const locator of [
    'https://www.web3isgoinggreat.com/feed.xml',
    'https://coincenter.org/feed',
    'https://blockworks.com/feed'
  ]) assert.match(canonicalFeedUrls, new RegExp(locator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(canonicalFeedUrls, /CFTC Enforcement RSS/);
  assert.match(canonicalFeedUrls, /ingestion_status = 'ready'/);
  assert.match(canonicalFeedUrls, /and active = true/);
  assert.doesNotMatch(canonicalFeedUrls, /set\s+active\s*=/i);
  assert.doesNotMatch(canonicalFeedUrls, /insert into public\.source_registry/i);
});

test('Hermes proposal handoff is bounded and never publishes', () => {
  assert.match(proposals, /create table if not exists public\.hermes_story_proposals/);
  assert.match(proposals, /create or replace function public\.queue_hermes_story_proposals/);
  assert.match(proposals, /create or replace function public\.claim_hermes_story_proposals/);
  assert.match(proposals, /create or replace function public\.submit_hermes_story_package/);
  assert.match(proposals, /source\.source_type in \('rss','blog','official_announcements','x_account'\)/);
  assert.match(proposals, /worker := auth\.uid\(\)::text/);
  assert.match(proposals, /status = 'ready_for_review'/);
  assert.match(proposals, /human_review_required/);
  assert.doesNotMatch(proposals, /insert into public\.stories/i);
  assert.doesNotMatch(proposals, /publish_due_stories/i);
  assert.doesNotMatch(proposals, /controller\s+job\s+queue/i);
});

test('Hermes packages retain research, social copy, and editor-only story handoff', () => {
  assert.match(proposals, /add column if not exists social_post/);
  assert.match(proposals, /research_packets/);
  assert.match(proposals, /inline Markdown source link/);
  assert.match(proposals, /status = 'ready_for_review'/);
  assert.match(editorialPackage, /create table if not exists public\.story_social_posts/);
  assert.match(editorialPackage, /save_story_social_post/);
  assert.match(editorialPackage, /pipeline_story_social_post_sync/);
  assert.match(editorialPackage, /not part of the public story body/);
});

test('Hermes proposal quality filters keep broad collectible feeds on the Web3 side of the bridge', () => {
  assert.match(qualityFilters, /add column if not exists proposal_keywords/);
  assert.match(qualityFilters, /PokéBeach RSS/);
  assert.match(qualityFilters, /The Toy Book Trading Cards RSS/);
  assert.match(qualityFilters, /lower\(concat_ws\(' ', event\.title, event\.summary, event\.raw_text\)\)/);
  assert.match(qualityFilters, /source_specific_filter_added/);
  assert.match(qualityFilters, /candidate_stories existing/);
  assert.match(qualityFilters, /existing\.canonical_url/);
  assert.match(qualityFilters, /source_bridge_filters/);
});

test('Hermes bridge filters use exact phrases and narrow broad government feeds', () => {
  assert.match(filterPrecision, /hermes_proposal_text_matches_keywords/);
  assert.match(filterPrecision, /regexp_replace\(lower\(concat_ws\(' ', p_title, p_summary\)/);
  assert.match(filterPrecision, /U\.S\. DOJ News RSS/);
  assert.match(filterPrecision, /SEC Litigation Releases RSS/);
  assert.match(filterPrecision, /CFTC Enforcement RSS/);
  assert.match(filterPrecision, /exact_keyword_matching/);
  assert.doesNotMatch(filterPrecision, /event\.raw_text\)\n\s+like/);
});

test('Hermes proposal production stays bounded while the writer is offline', () => {
  assert.match(backlogCap, /max_active integer := 100/);
  assert.match(backlogCap, /status in \('queued','claimed','writing','ready_for_review'\)/);
  assert.match(backlogCap, /greatest\(max_active - active_count, 0\)/);
  assert.match(backlogCap, /active_before/);
});

test('canonical discovery freshness gates scoring, preserves deduplication, and keeps backfill explicit', () => {
  assert.match(freshness, /freshness_overlap_minutes integer not null default 10/);
  assert.match(freshness, /freshness_minimum_window_minutes integer not null default 20/);
  assert.match(freshness, /freshness_future_skew_minutes integer not null default 15/);
  assert.match(freshness, /p_force boolean default false/);
  assert.match(freshness, /p_mode text/);
  assert.match(freshness, /p_mode = 'backfill'/);
  assert.match(freshness, /event.published_at >= effective_now - make_interval/);
  assert.match(freshness, /event.published_at is not null/);
  assert.match(freshness, /items_entering_scoring/);
  assert.match(freshness, /queue_hermes_story_proposals_backfill/);
  assert.match(freshness, /fresh.content_hash is distinct from previous_event.content_hash/);
  assert.match(freshness, /candidate_stories existing/);
  assert.doesNotMatch(freshness, /queue_hermes_story_proposals_backfill[\s\S]*scheduled\(\)/i);
});

test('scheduled overlap skips already evaluated source events while backfill can intentionally revisit them', () => {
  assert.match(evaluationState, /discovery_evaluated_at timestamptz/);
  assert.match(evaluationState, /event\.discovery_evaluated_at is null/);
  assert.match(evaluationState, /update public\.source_events event/);
  assert.match(evaluationState, /discovery_passed_threshold = scored\.passed_threshold/);
  assert.match(evaluationState, /p_mode = 'backfill' or event\.discovery_evaluated_at is null/);
  assert.match(evaluationState, /join evaluated on evaluated\.id = scored\.source_event_id/);
});

test('threshold-passed events remain retryable until the canonical proposal handoff exists', () => {
  assert.match(evaluationHandoff, /discovery_handoff_created_at timestamptz/);
  assert.match(evaluationHandoff, /new\.discovery_handoff_created_at is null/);
  assert.match(evaluationHandoff, /new\.discovery_evaluated_at := null/);
  assert.match(evaluationHandoff, /after insert on public\.hermes_story_proposals/);
  assert.match(evaluationHandoff, /discovery_handoff_created_at = coalesce/);
});

test('editorial gate uses discovery time and content signal instead of saturating on source metadata', () => {
  assert.match(editorialGate, /hermes_proposal_commodity_reason/);
  assert.match(editorialGate, /hermes_proposal_editorial_signal/);
  assert.match(editorialGate, /routine_regulatory_commentary/);
  assert.match(editorialGate, /generic_ai_review/);
  assert.match(editorialGate, /classified\.editorial_signal >= 20/);
  assert.match(editorialGate, /event\.discovered_at >= effective_now - make_interval/);
  assert.match(editorialGate, /event\.published_at >= effective_now - interval '72 hours'/);
  assert.match(editorialGate, /freshness_timestamp/);
  assert.match(editorialGate, /metadata_score_max', 40/);
  assert.doesNotMatch(editorialGate, /\(\?:/);
  assert.doesNotMatch(editorialGate, /\(fresh\.source_priority \* 10\)/);
});
