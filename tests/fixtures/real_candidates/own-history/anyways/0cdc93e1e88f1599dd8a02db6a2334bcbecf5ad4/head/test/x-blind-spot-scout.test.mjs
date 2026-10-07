import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  X_BLIND_SPOT_WATCHLIST,
  X_SCOUT_INTERVAL_MINUTES,
  buildXScoutRequest,
  buildXScoutPrompt,
  extractXScoutLeads,
  searchXBlindSpots,
  xScoutEventTitle
} from '../src/x-blind-spot-scout.mjs';
import { runXBlindSpotScout } from '../src/worker.mjs';

const now = new Date('2026-08-16T16:00:00Z');

test('blind-spot request is limited to the curated X watchlist and recent window', () => {
  const request = buildXScoutRequest({ now, windowHours: 5 });
  assert.equal(request.model, 'grok-4.6');
  assert.deepEqual(request.tools[0].allowed_x_handles, [
    'chooserich',
    'clementetv_',
    'ashleydcan',
    'zachxbt',
    'notthreadguy',
    'rasmr_eth',
    'OxSimpleFarmer',
    'clutchmarkets'
  ]);
  assert.equal(X_SCOUT_INTERVAL_MINUTES, 60);
  assert.equal(request.tools[0].from_date, '2026-08-16T11:00:00.000Z');
  assert.equal(request.tools[0].to_date, now.toISOString());
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.match(buildXScoutPrompt({ watchlist: X_BLIND_SPOT_WATCHLIST, from: new Date('2026-08-16T11:00:00Z'), to: now }), /not a newsroom researcher/i);
  assert.match(buildXScoutPrompt({ watchlist: X_BLIND_SPOT_WATCHLIST, from: new Date('2026-08-16T11:00:00Z'), to: now }), /Do not look for articles, websites, source accounts/i);
});

test('response extraction rejects stale, malformed, and uncurated leads', () => {
  const response = {
    citations: ['https://x.com/chooserich/status/123'],
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify({ leads: [
        {
          post_url: 'https://x.com/chooserich/status/123',
          handle: '@chooserich',
          posted_at: '2026-08-16T15:45:00Z',
          post_text: 'A balcony rant that became the timeline.',
          lead_type: 'creator_spectacle',
          why_it_matters: 'It is a visible event rather than routine commentary.',
          pipeline_miss_reason: 'The RSS path will never see this post.',
          confidence: 0.91,
          topic_tags: ['timeline', 'culture']
        },
        {
          post_url: 'https://x.com/unknown/status/456',
          handle: '@unknown',
          posted_at: '2026-08-16T15:40:00Z',
          post_text: 'Not on the watchlist.',
          lead_type: 'commentary',
          why_it_matters: 'No.',
          pipeline_miss_reason: 'No.',
          confidence: 0.9,
          topic_tags: []
        },
        {
          post_url: 'https://x.com/chooserich/status/789',
          handle: '@chooserich',
          posted_at: '2026-08-16T04:00:00Z',
          post_text: 'Too old.',
          lead_type: 'creator_spectacle',
          why_it_matters: 'No.',
          pipeline_miss_reason: 'No.',
          confidence: 0.9,
          topic_tags: []
        }
      ] }) }]
    }]
  };
  const leads = extractXScoutLeads(response, { now, windowHours: 5 });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].handle, '@chooserich');
  assert.equal(leads[0].confidence, 0.91);
  assert.equal(leads[0].citations[0], 'https://x.com/chooserich/status/123');
});

test('scout performs one structured xAI request and returns normalized leads', async () => {
  const calls = [];
  const result = await searchXBlindSpots('test-key', {
    now,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        citations: [],
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ leads: [] }) }] }]
      });
    }
  });
  assert.equal(result.skipped, false);
  assert.equal(result.leads.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.x.ai/v1/responses');
  assert.equal(JSON.parse(calls[0].init.body).tools[0].type, 'x_search');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
});

test('event title remains a deterministic label, not a generated story headline', () => {
  assert.equal(xScoutEventTitle({ handle: '@zachxbt', post_text: 'Receipts are here. Read this thread.' }), '@zachxbt: Receipts are here.');
});

test('scheduled scout waits for the hourly boundary', async () => {
  const result = await runXBlindSpotScout({
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    XAI_API_KEY: 'xai-test-key'
  }, {
    now: new Date('2026-08-16T16:15:00Z'),
    fetchImpl: async () => { throw new Error('Hourly skip should not make a request.'); }
  });
  assert.equal(result.skipped, true);
  assert.equal(result.interval_minutes, 60);
});

test('Worker scout writes only curated post events and then calls the separate scout proposal queue', async () => {
  const sourceId = '123e4567-e89b-42d3-a456-426614174000';
  const calls = [];
  const env = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    XAI_API_KEY: 'xai-test-key'
  };
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    if (href.includes('/rest/v1/x_scout_watchlist?')) return Response.json([{
      handle: '@chooserich',
      source_registry_id: sourceId,
      display_name: 'ChooseRich',
      lead_types: ['creator_spectacle'],
      prompt_hint: 'Public scenes.',
      primary_sections: ['culture'],
      topic_tags: ['timeline'],
      priority: 8,
      editorial_fit: 4
    }]);
    if (href === 'https://api.x.ai/v1/responses') return Response.json({
      citations: [],
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ leads: [{
        post_url: 'https://x.com/chooserich/status/123',
        handle: '@chooserich',
        posted_at: '2026-08-16T15:45:00Z',
        post_text: 'A balcony rant that became the timeline.',
        lead_type: 'creator_spectacle',
        why_it_matters: 'Visible timeline event.',
        pipeline_miss_reason: 'No feed sees this post.',
        confidence: 0.9,
        topic_tags: ['timeline']
      }] }) }]
    }]
    });
    if (href.includes(`/rest/v1/source_events?source_id=eq.${sourceId}`)) return Response.json([]);
    if (href.endsWith('/rest/v1/source_events')) return Response.json(JSON.parse(init.body));
    if (href.includes('/rpc/queue_x_scout_story_proposals')) return Response.json({ queued: 1, candidates_scored: 1, passed_threshold: 1 });
    throw new Error(`Unexpected request ${href}`);
  };
  const result = await runXBlindSpotScout(env, { fetchImpl, now, force: true });
  assert.equal(result.leads_found, 1);
  assert.equal(result.events_inserted, 1);
  assert.equal(result.proposals.queued, 1);
  assert.equal(calls.some(call => call.href === 'https://api.x.ai/v1/responses'), true);
  const inserted = JSON.parse(calls.find(call => call.href.endsWith('/rest/v1/source_events')).init.body);
  assert.equal(inserted[0].source_metadata.scout_lane, 'blind_spot');
  assert.equal(inserted[0].source_metadata.watch_handle, '@chooserich');
  assert.equal(calls.at(-1).href.includes('/rpc/queue_x_scout_story_proposals'), true);
});

test('X scout migration stays additive and separate from normal source ingestion', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260816160000_x_blind_spot_scout.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table if not exists public\.x_scout_watchlist/);
  assert.match(migration, /queue_x_scout_story_proposals/);
  assert.match(migration, /scout_lane.*blind_spot/);
  assert.match(migration, /primary_source_required/);
  for (const handle of ['@notthreadguy', '@rasmr_eth', '@OxSimpleFarmer', '@clutchmarkets']) {
    assert.match(migration, new RegExp(handle.replace('@', '\\@')));
  }
  assert.doesNotMatch(migration, /publish_due_stories|drop table|truncate|delete from public\.(stories|source_events)/i);
});
