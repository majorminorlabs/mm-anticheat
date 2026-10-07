-- X Blind-Spot Scout. This is a curated lead radar, not Source Graph source
-- discovery and not a replacement for primary-source verification.
begin;

-- Keep the account in the registry for evidence lineage, but leave it out of
-- normal source ingestion until the newsroom separately verifies it.
insert into public.source_registry (
  name, handle_or_url, platform, source_type, primary_class, description, active,
  priority, trust_level, direct_publish_eligible, requires_primary_source_lookup,
  primary_sections, topic_tags, chain_tags, project_tags, public_display_name,
  x_handle, reveal_identity_policy, recurring_character, internal_notes,
  recurring_formats, internal_queue, review_status, identity_key,
  ingestion_status, poll_interval_seconds, pipeline_role, editorial_fit
) values (
  'AshleyDCan', '@ashleydcan', 'x', 'x_account', 'curator',
  'Curated X blind-spot lead account. Treat posts as leads and verify material claims.',
  false, 7, 'useful_signal', false, true,
  array['Culture','Markets'], array['commentary','web3'], '{}', '{}', 'AshleyDCan',
  '@ashleydcan', 'always', false, 'Added for the separate X blind-spot scout; not normal source ingestion.',
  '{}', null, 'review_needed', 'x:ashleydcan', 'unsupported', 3600, 'discovery', 4.0
)
on conflict (identity_key) where identity_key is not null and identity_key <> '' do update
set name = excluded.name,
    handle_or_url = excluded.handle_or_url,
    x_handle = excluded.x_handle,
    description = excluded.description,
    primary_sections = excluded.primary_sections,
    topic_tags = excluded.topic_tags,
    internal_notes = excluded.internal_notes,
    pipeline_role = excluded.pipeline_role,
    editorial_fit = excluded.editorial_fit,
    updated_at = now();

insert into public.source_registry (
  name, handle_or_url, platform, source_type, primary_class, description, active,
  priority, trust_level, direct_publish_eligible, requires_primary_source_lookup,
  primary_sections, topic_tags, chain_tags, project_tags, public_display_name,
  x_handle, reveal_identity_policy, recurring_character, internal_notes,
  recurring_formats, internal_queue, review_status, identity_key,
  ingestion_status, poll_interval_seconds, pipeline_role, editorial_fit
) values
  (
    'Not Thread Guy', '@notthreadguy', 'x', 'x_account', 'curator',
    'Curated X blind-spot lead account. Treat posts as leads and verify material claims.',
    false, 7, 'useful_signal', false, true,
    array['Culture','Markets'], array['commentary','community'], '{}', '{}', 'Not Thread Guy',
    '@notthreadguy', 'always', false, 'Added for the separate X blind-spot scout; not normal source ingestion.',
    '{}', null, 'review_needed', 'x:notthreadguy', 'unsupported', 3600, 'discovery', 4.0
  ),
  (
    'Rasmr ETH', '@rasmr_eth', 'x', 'x_account', 'market_intelligence',
    'Curated X blind-spot lead account. Treat posts as leads and verify material claims.',
    false, 7, 'useful_signal', false, true,
    array['Markets','DeFi'], array['ethereum','commentary'], array['ethereum'], '{}', 'Rasmr ETH',
    '@rasmr_eth', 'always', false, 'Added for the separate X blind-spot scout; not normal source ingestion.',
    '{}', null, 'review_needed', 'x:rasmr_eth', 'unsupported', 3600, 'discovery', 4.0
  ),
  (
    'OxSimpleFarmer', '@OxSimpleFarmer', 'x', 'x_account', 'curator',
    'Curated X blind-spot lead account. Treat posts as leads and verify material claims.',
    false, 7, 'useful_signal', false, true,
    array['Culture','Markets'], array['commentary','timeline'], '{}', '{}', 'OxSimpleFarmer',
    '@OxSimpleFarmer', 'always', false, 'Added for the separate X blind-spot scout; not normal source ingestion.',
    '{}', null, 'review_needed', 'x:OxSimpleFarmer', 'unsupported', 3600, 'discovery', 4.0
  ),
  (
    'Clutch Markets', '@clutchmarkets', 'x', 'x_account', 'market_intelligence',
    'Curated X blind-spot lead account. Treat posts as leads and verify material claims.',
    false, 8, 'useful_signal', false, true,
    array['Markets','Culture'], array['markets','commentary'], '{}', '{}', 'Clutch Markets',
    '@clutchmarkets', 'always', false, 'Added for the separate X blind-spot scout; not normal source ingestion.',
    '{}', null, 'review_needed', 'x:clutchmarkets', 'unsupported', 3600, 'discovery', 4.0
  )
on conflict (identity_key) where identity_key is not null and identity_key <> '' do update
set name = excluded.name,
    handle_or_url = excluded.handle_or_url,
    x_handle = excluded.x_handle,
    description = excluded.description,
    primary_sections = excluded.primary_sections,
    topic_tags = excluded.topic_tags,
    chain_tags = excluded.chain_tags,
    public_display_name = excluded.public_display_name,
    internal_notes = excluded.internal_notes,
    pipeline_role = excluded.pipeline_role,
    editorial_fit = excluded.editorial_fit,
    updated_at = now();

create table if not exists public.x_scout_watchlist (
  handle text primary key,
  source_registry_id uuid not null references public.source_registry(id) on delete restrict,
  display_name text not null,
  lead_types text[] not null default '{}',
  prompt_hint text not null default '',
  primary_sections text[] not null default '{}',
  topic_tags text[] not null default '{}',
  priority integer not null default 5 check (priority between 1 and 10),
  editorial_fit numeric(2,1) not null default 4.0 check (editorial_fit between 1.0 and 5.0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint x_scout_watchlist_handle_check check (handle ~ '^@[A-Za-z0-9_]{1,15}$')
);

create index if not exists x_scout_watchlist_active_priority_idx
  on public.x_scout_watchlist(active, priority desc, handle);

create or replace function public.touch_x_scout_watchlist_updated_at() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists x_scout_watchlist_updated_at on public.x_scout_watchlist;
create trigger x_scout_watchlist_updated_at
before update on public.x_scout_watchlist
for each row execute function public.touch_x_scout_watchlist_updated_at();

insert into public.x_scout_watchlist (
  handle, source_registry_id, display_name, lead_types, prompt_hint,
  primary_sections, topic_tags, priority, editorial_fit
)
select '@chooserich', id, 'ChooseRich', array['creator_spectacle'],
  'Public scenes, balcony rants, strange interactions, and personal spectacle that is visibly happening on the timeline.',
  array['culture'], array['entertainment','timeline'], 8, 4.0
from public.source_registry where identity_key = 'x:chooserich'
on conflict (handle) do update set
  source_registry_id = excluded.source_registry_id,
  display_name = excluded.display_name,
  lead_types = excluded.lead_types,
  prompt_hint = excluded.prompt_hint,
  primary_sections = excluded.primary_sections,
  topic_tags = excluded.topic_tags,
  priority = excluded.priority,
  editorial_fit = excluded.editorial_fit,
  active = true,
  updated_at = now();

insert into public.x_scout_watchlist (
  handle, source_registry_id, display_name, lead_types, prompt_hint,
  primary_sections, topic_tags, priority, editorial_fit
)
select '@clementetv_', id, 'Clemente', array['creator_self_own'],
  'Comedic or chaotic crypto behavior, a public self-own, an unusually dumb move, or a video that becomes a timeline event.',
  array['culture'], array['entertainment','timeline'], 8, 4.0
from public.source_registry where identity_key = 'x:clementetv_'
on conflict (handle) do update set
  source_registry_id = excluded.source_registry_id,
  display_name = excluded.display_name,
  lead_types = excluded.lead_types,
  prompt_hint = excluded.prompt_hint,
  primary_sections = excluded.primary_sections,
  topic_tags = excluded.topic_tags,
  priority = excluded.priority,
  editorial_fit = excluded.editorial_fit,
  active = true,
  updated_at = now();

insert into public.x_scout_watchlist (
  handle, source_registry_id, display_name, lead_types, prompt_hint,
  primary_sections, topic_tags, priority, editorial_fit
)
select '@ashleydcan', id, 'AshleyDCan', array['commentary'],
  'High-signal commentary that points at a real shift, conflict, product failure, community moment, or unexpectedly important detail.',
  array['culture','markets'], array['commentary','web3'], 7, 4.0
from public.source_registry where identity_key = 'x:ashleydcan'
on conflict (handle) do update set
  source_registry_id = excluded.source_registry_id,
  display_name = excluded.display_name,
  lead_types = excluded.lead_types,
  prompt_hint = excluded.prompt_hint,
  primary_sections = excluded.primary_sections,
  topic_tags = excluded.topic_tags,
  priority = excluded.priority,
  editorial_fit = excluded.editorial_fit,
  active = true,
  updated_at = now();

insert into public.x_scout_watchlist (
  handle, source_registry_id, display_name, lead_types, prompt_hint,
  primary_sections, topic_tags, priority, editorial_fit
)
select '@zachxbt', id, 'ZachXBT', array['investigation','receipt'],
  'Exposes, receipts, wallet trails, fraud or theft allegations, and other posts that need primary verification before publication.',
  array['markets','defi','chains','culture'], array['investigations','security','onchain'], 10, 5.0
from public.source_registry where identity_key = 'x:zachxbt'
on conflict (handle) do update set
  source_registry_id = excluded.source_registry_id,
  display_name = excluded.display_name,
  lead_types = excluded.lead_types,
  prompt_hint = excluded.prompt_hint,
  primary_sections = excluded.primary_sections,
  topic_tags = excluded.topic_tags,
  priority = excluded.priority,
  editorial_fit = excluded.editorial_fit,
  active = true,
  updated_at = now();

insert into public.x_scout_watchlist (
  handle, source_registry_id, display_name, lead_types, prompt_hint,
  primary_sections, topic_tags, priority, editorial_fit
)
select '@notthreadguy', id, 'Not Thread Guy', array['commentary','community_drama'],
  'Specific crypto timeline moments, sharp commentary, unusual claims, and community drama that become a real event rather than routine posting.',
  array['culture','markets'], array['commentary','community'], 7, 4.0
from public.source_registry where identity_key = 'x:notthreadguy'
on conflict (handle) do update set
  source_registry_id = excluded.source_registry_id,
  display_name = excluded.display_name,
  lead_types = excluded.lead_types,
  prompt_hint = excluded.prompt_hint,
  primary_sections = excluded.primary_sections,
  topic_tags = excluded.topic_tags,
  priority = excluded.priority,
  editorial_fit = excluded.editorial_fit,
  active = true,
  updated_at = now();

insert into public.x_scout_watchlist (
  handle, source_registry_id, display_name, lead_types, prompt_hint,
  primary_sections, topic_tags, priority, editorial_fit
)
select '@rasmr_eth', id, 'Rasmr ETH', array['commentary','trade_or_transaction'],
  'Specific Ethereum or crypto behavior, market moments, unusual transactions, and commentary with a concrete post-level hook.',
  array['markets','defi'], array['ethereum','commentary'], 7, 4.0
from public.source_registry where identity_key = 'x:rasmr_eth'
on conflict (handle) do update set
  source_registry_id = excluded.source_registry_id,
  display_name = excluded.display_name,
  lead_types = excluded.lead_types,
  prompt_hint = excluded.prompt_hint,
  primary_sections = excluded.primary_sections,
  topic_tags = excluded.topic_tags,
  priority = excluded.priority,
  editorial_fit = excluded.editorial_fit,
  active = true,
  updated_at = now();

insert into public.x_scout_watchlist (
  handle, source_registry_id, display_name, lead_types, prompt_hint,
  primary_sections, topic_tags, priority, editorial_fit
)
select '@OxSimpleFarmer', id, 'OxSimpleFarmer', array['commentary','creator_spectacle'],
  'Odd, funny, revealing, or unusually specific crypto posts and public moments that the normal news feed is unlikely to classify as a story.',
  array['culture','markets'], array['commentary','timeline'], 7, 4.0
from public.source_registry where identity_key = 'x:OxSimpleFarmer'
on conflict (handle) do update set
  source_registry_id = excluded.source_registry_id,
  display_name = excluded.display_name,
  lead_types = excluded.lead_types,
  prompt_hint = excluded.prompt_hint,
  primary_sections = excluded.primary_sections,
  topic_tags = excluded.topic_tags,
  priority = excluded.priority,
  editorial_fit = excluded.editorial_fit,
  active = true,
  updated_at = now();

insert into public.x_scout_watchlist (
  handle, source_registry_id, display_name, lead_types, prompt_hint,
  primary_sections, topic_tags, priority, editorial_fit
)
select '@clutchmarkets', id, 'Clutch Markets', array['commentary','trade_or_transaction','launch_or_tournament'],
  'Concrete market, trading, launch, tournament, or transaction moments with enough specificity to become an editorial lead.',
  array['markets','culture'], array['markets','commentary'], 8, 4.0
from public.source_registry where identity_key = 'x:clutchmarkets'
on conflict (handle) do update set
  source_registry_id = excluded.source_registry_id,
  display_name = excluded.display_name,
  lead_types = excluded.lead_types,
  prompt_hint = excluded.prompt_hint,
  primary_sections = excluded.primary_sections,
  topic_tags = excluded.topic_tags,
  priority = excluded.priority,
  editorial_fit = excluded.editorial_fit,
  active = true,
  updated_at = now();

alter table public.x_scout_watchlist enable row level security;
drop policy if exists "editors read X scout watchlist" on public.x_scout_watchlist;
create policy "editors read X scout watchlist"
on public.x_scout_watchlist for select to authenticated using (public.is_editor());
grant select on table public.x_scout_watchlist to authenticated;

-- This queue is intentionally separate from queue_hermes_story_proposals. It
-- consumes only events explicitly marked by the blind-spot adapter and does
-- not require a source to be active in ordinary Source Graph ingestion.
create or replace function public.queue_x_scout_story_proposals(
  p_now timestamptz default now(),
  p_limit integer default 10
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  queued_count integer := 0;
  scored_count integer := 0;
  passed_count integer := 0;
  bounded_limit integer;
  active_count integer := 0;
  threshold integer := 70;
  effective_now timestamptz := coalesce(p_now, now());
begin
  perform public.assert_pipeline_controller();
  bounded_limit := least(greatest(coalesce(p_limit, 0), 0), 25);

  select deterministic_threshold into threshold
  from public.source_graph_discovery_settings
  where id = 'default';
  threshold := coalesce(threshold, 70);

  select count(*) into active_count
  from public.hermes_story_proposals
  where writer_backend = 'qwen'
    and status in ('queued','claimed','writing','pitch_ready','ready_for_review');
  bounded_limit := least(bounded_limit, greatest(100 - active_count, 0));

  with ranked as (
    select
      event.id as source_event_id,
      event.title,
      left(coalesce(nullif(concat_ws(E'\n\n', nullif(event.summary, ''), nullif(event.raw_text, '')), ''), ''), 4000) as summary,
      nullif(btrim(event.canonical_url), '') as source_url,
      watch.display_name as source_name,
      event.source_type,
      watch.priority as source_priority,
      watch.editorial_fit,
      'discovery'::text as pipeline_role,
      watch.primary_sections,
      watch.topic_tags,
      event.published_at,
      event.discovered_at,
      event.source_metadata,
      md5(lower(regexp_replace(coalesce(event.canonical_url, event.external_id, event.title), '[^a-z0-9]+', '', 'g'))) as proposal_fingerprint,
      least(100, greatest(0,
        (watch.priority * 4)
        + round(coalesce((event.source_metadata ->> 'scout_confidence')::numeric, 0) * 20)::integer
        + case
            when event.published_at >= effective_now - interval '30 minutes' then 20
            when event.published_at >= effective_now - interval '2 hours' then 12
            else 4
          end
        + case event.source_metadata ->> 'lead_type'
            when 'investigation' then 15
            when 'receipt' then 15
            when 'creator_spectacle' then 12
            when 'creator_self_own' then 12
            when 'launch_or_tournament' then 12
            when 'trade_or_transaction' then 10
            when 'community_drama' then 10
            else 8
          end
      )) as proposal_score
    from public.source_events event
    join public.x_scout_watchlist watch
      on lower(watch.handle) = lower(event.source_metadata ->> 'watch_handle')
    where watch.active
      and event.status = 'ingested'
      and event.source_metadata ->> 'scout_lane' = 'blind_spot'
      and event.published_at is not null
      and event.published_at >= effective_now - interval '6 hours'
      and event.published_at <= effective_now + interval '15 minutes'
      and not exists (
        select 1 from public.hermes_story_proposals existing
        where existing.source_event_id = event.id
      )
      and not exists (
        select 1 from public.hermes_story_proposals existing
        where existing.proposal_fingerprint = md5(lower(regexp_replace(coalesce(event.canonical_url, event.external_id, event.title), '[^a-z0-9]+', '', 'g')))
          and existing.status in ('queued','claimed','writing','pitch_ready','ready_for_review')
      )
      and not exists (
        select 1 from public.candidate_stories existing
        where nullif(btrim(event.canonical_url), '') is not null
          and nullif(btrim(existing.canonical_url), '') = nullif(btrim(event.canonical_url), '')
      )
  ), scored as (
    select *, proposal_score >= threshold as passed_threshold
    from ranked
  ), eligible as (
    select * from scored where passed_threshold
    order by proposal_score desc, discovered_at desc
    limit bounded_limit
  ), inserted as (
    insert into public.hermes_story_proposals (
      source_event_id, proposal_key, proposal_fingerprint, title, summary, source_url,
      source_name, source_type, source_priority, editorial_fit, pipeline_role,
      primary_sections, topic_tags, priority, deterministic_score, deterministic_threshold,
      score_reason, published_at, discovered_at, writer_backend
    )
    select source_event_id, 'x-scout:' || source_event_id::text, proposal_fingerprint,
      left(coalesce(nullif(btrim(title), ''), 'Untitled X blind-spot lead'), 1000), summary, source_url,
      source_name, source_type, source_priority, editorial_fit, pipeline_role,
      coalesce(primary_sections, '{}'), coalesce(topic_tags, '{}'), proposal_score,
      proposal_score, threshold,
      jsonb_build_object(
        'scout_lane', 'blind_spot',
        'lead_type', source_metadata ->> 'lead_type',
        'confidence', source_metadata ->> 'scout_confidence',
        'pipeline_miss_reason', source_metadata ->> 'pipeline_miss_reason',
        'watch_handle', source_metadata ->> 'watch_handle'
      ),
      published_at, discovered_at, 'qwen'
    from eligible
    on conflict (proposal_key) do nothing
    returning id
  )
  select
    coalesce((select count(*) from inserted), 0)::integer,
    coalesce((select count(*) from scored), 0)::integer,
    coalesce((select count(*) from scored where passed_threshold), 0)::integer
  into queued_count, scored_count, passed_count;

  return jsonb_build_object(
    'queued', queued_count,
    'candidates_scored', scored_count,
    'passed_threshold', passed_count,
    'limit', bounded_limit,
    'threshold', threshold,
    'window_hours', 6,
    'lane', 'x_blind_spot_scout',
    'primary_source_required', true
  );
end;
$$;

grant execute on function public.queue_x_scout_story_proposals(timestamptz, integer) to service_role;

comment on table public.x_scout_watchlist is
  'Curated X accounts for blind-spot lead discovery. This table does not activate normal source ingestion.';
comment on function public.queue_x_scout_story_proposals(timestamptz, integer) is
  'Queues only explicit blind-spot scout events into the existing Qwen pitch handoff; it does not publish or verify claims.';

commit;
