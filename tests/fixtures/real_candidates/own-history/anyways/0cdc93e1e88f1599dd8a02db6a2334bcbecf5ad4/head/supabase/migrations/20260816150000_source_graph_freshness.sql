-- Keep normal Source Graph discovery bounded to newly published source items.
-- The Worker still ingests normalized source_events for identity and audit; the
-- freshness boundary below prevents stale events from entering scoring or the
-- Qwen handoff. Backfill uses the same workflow and an explicit date range.
begin;

alter table public.source_graph_discovery_settings
  add column if not exists freshness_overlap_minutes integer not null default 10,
  add column if not exists freshness_minimum_window_minutes integer not null default 20,
  add column if not exists freshness_future_skew_minutes integer not null default 15;

alter table public.source_graph_discovery_settings
  add constraint source_graph_discovery_settings_freshness_overlap_check
    check (freshness_overlap_minutes between 5 and 15),
  add constraint source_graph_discovery_settings_freshness_minimum_check
    check (freshness_minimum_window_minutes >= 20),
  add constraint source_graph_discovery_settings_freshness_future_skew_check
    check (freshness_future_skew_minutes between 0 and 60);

comment on column public.source_graph_discovery_settings.freshness_overlap_minutes is
  'Minutes added to each source polling interval so feed delay and scheduler timing do not drop a new item.';
comment on column public.source_graph_discovery_settings.freshness_minimum_window_minutes is
  'Lower bound for normal source-event freshness windows.';
comment on column public.source_graph_discovery_settings.freshness_future_skew_minutes is
  'Small allowed clock skew for source timestamps; larger future timestamps are treated as invalid.';

-- A backfill may intentionally poll a source before its normal next-eligible
-- time. Scheduled and ordinary manual runs retain the source lease cadence.
drop function if exists public.claim_source_ingestion_batch(timestamptz, integer, integer);

create function public.claim_source_ingestion_batch(
  p_now timestamptz default now(),
  p_limit integer default 3,
  p_lease_seconds integer default 90,
  p_force boolean default false
) returns table (
  source_id uuid,
  run_id uuid,
  lease_token uuid,
  name text,
  handle_or_url text,
  source_type text,
  priority integer,
  poll_interval_seconds integer,
  ingestion_failure_count integer,
  ingestion_etag text,
  ingestion_last_modified text,
  primary_sections text[],
  topic_tags text[]
) language plpgsql security definer set search_path = pg_catalog, public as $$
declare row public.source_registry%rowtype; new_run uuid; new_token uuid;
begin
  for row in
    select registry.* from public.source_registry as registry
    where registry.active = true
      and registry.review_status = 'ready'
      and registry.source_type in ('rss', 'blog', 'official_announcements')
      and registry.ingestion_status in ('ready', 'healthy', 'degraded', 'failed')
      and (registry.ingestion_lease_until is null or registry.ingestion_lease_until <= p_now)
      and (coalesce(p_force, false) or registry.ingestion_next_eligible_at is null or registry.ingestion_next_eligible_at <= p_now)
    order by registry.priority desc, coalesce(registry.ingestion_next_eligible_at, '-infinity'::timestamptz), registry.name
    limit least(greatest(coalesce(p_limit, 0), 0), 5)
    for update skip locked
  loop
    new_run := gen_random_uuid();
    new_token := gen_random_uuid();
    insert into public.source_ingestion_runs(id, source_id, status) values (new_run, row.id, 'polling');
    update public.source_registry
    set ingestion_status = 'polling',
        ingestion_lease_token = new_token,
        ingestion_lease_until = p_now + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 90), 30), 300)),
        last_checked_at = p_now,
        updated_at = p_now
    where id = row.id;
    return query select row.id, new_run, new_token, row.name, row.handle_or_url, row.source_type,
      row.priority, row.poll_interval_seconds, row.ingestion_failure_count, row.ingestion_etag,
      row.ingestion_last_modified, row.primary_sections, row.topic_tags;
  end loop;
end;
$$;

-- Allow the explicit backfill trigger without making it a second pipeline.
create or replace function public.start_source_graph_discovery_run(
  p_trigger text default 'scheduled',
  p_requested_by uuid default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  settings_row public.source_graph_discovery_settings%rowtype;
  active_run public.discovery_runs%rowtype;
  run public.discovery_runs%rowtype;
begin
  perform public.assert_pipeline_controller();
  if p_trigger not in ('scheduled', 'manual', 'backfill') then
    raise exception using errcode = '22023', message = 'invalid discovery trigger';
  end if;
  select * into settings_row
  from public.source_graph_discovery_settings
  where id = 'default'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'source graph discovery settings are missing';
  end if;
  if not settings_row.enabled then
    return jsonb_build_object('started', false, 'skipped', true, 'reason', 'disabled', 'settings', to_jsonb(settings_row));
  end if;
  select * into active_run
  from public.discovery_runs
  where workflow = 'source_graph_qwen'
    and status = 'running'
    and started_at > now() - interval '20 minutes'
  order by started_at desc
  limit 1;
  if found then
    return jsonb_build_object('started', false, 'skipped', true, 'reason', 'already_running', 'run_id', active_run.id);
  end if;
  insert into public.discovery_runs(workflow, trigger, requested_by, status, counts)
  values (
    'source_graph_qwen', p_trigger, p_requested_by, 'running',
    jsonb_build_object(
      'sources_scanned', 0,
      'items_fetched', 0,
      'new_source_events', 0,
      'stale_items_skipped', 0,
      'duplicate_items_skipped', 0,
      'items_entering_scoring', 0,
      'candidates_scored', 0,
      'passed_threshold', 0,
      'generate_pitch_jobs_created', 0,
      'pitches_generated', 0,
      'failures', 0
    )
  )
  returning * into run;
  return jsonb_build_object('started', true, 'skipped', false, 'run_id', run.id, 'settings', to_jsonb(settings_row));
end;
$$;

-- One scoring core serves scheduled discovery and explicit historical
-- backfill. The public normal wrapper keeps the existing RPC contract.
create or replace function public.queue_hermes_story_proposals_core(
  p_now timestamptz,
  p_limit integer,
  p_mode text,
  p_backfill_from timestamptz default null,
  p_backfill_to timestamptz default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  settings_row public.source_graph_discovery_settings%rowtype;
  queued_count integer := 0;
  scored_count integer := 0;
  passed_count integer := 0;
  bounded_limit integer;
  active_count integer := 0;
  max_active integer := 100;
  threshold integer := 70;
  effective_now timestamptz := coalesce(p_now, now());
begin
  perform public.assert_pipeline_controller();
  if p_mode not in ('scheduled', 'backfill') then
    raise exception using errcode = '22023', message = 'invalid discovery mode';
  end if;
  if p_mode = 'backfill' and (p_backfill_from is null or p_backfill_to is null or p_backfill_from >= p_backfill_to) then
    raise exception using errcode = '22023', message = 'backfill requires a valid range';
  end if;
  select * into settings_row
  from public.source_graph_discovery_settings
  where id = 'default';
  threshold := coalesce(settings_row.deterministic_threshold, 70);
  select count(*) into active_count
  from public.hermes_story_proposals
  where status in ('queued','claimed','writing','pitch_ready','ready_for_review');
  bounded_limit := least(greatest(coalesce(p_limit, 0), 0), greatest(max_active - active_count, 0));

  with fresh as (
    select
      event.id as source_event_id,
      event.title,
      left(
        coalesce(
          nullif(concat_ws(E'\n\n', nullif(event.summary, ''), nullif(event.raw_text, '')), ''),
          ''
        ),
        4000
      ) as summary,
      nullif(btrim(event.canonical_url), '') as source_url,
      source.name as source_name,
      event.source_type,
      source.priority as source_priority,
      source.editorial_fit,
      source.pipeline_role,
      source.primary_sections,
      source.topic_tags,
      source.proposal_keywords,
      event.external_id,
      event.content_hash,
      event.canonical_url,
      event.published_at,
      event.discovered_at,
      case
        when p_mode = 'scheduled' then greatest(
          greatest(coalesce(source.poll_interval_seconds, 3600), 60) + coalesce(settings_row.freshness_overlap_minutes, 10) * 60,
          coalesce(settings_row.freshness_minimum_window_minutes, 20) * 60
        )
        else null
      end as freshness_window_seconds
    from public.source_events event
    join public.source_registry source on source.id = event.source_id
    where event.status = 'ingested'
      and source.active
      and source.review_status = 'ready'
      and source.pipeline_role in ('discovery','both')
      and source.editorial_fit >= 3.5
      and source.source_type in ('rss','blog','official_announcements','x_account')
      and event.published_at is not null
      and (
        (
          p_mode = 'backfill'
          and event.published_at >= p_backfill_from
          and event.published_at < p_backfill_to
        )
        or (
          p_mode = 'scheduled'
          and event.published_at <= effective_now + make_interval(mins => greatest(coalesce(settings_row.freshness_future_skew_minutes, 15), 0))
          and event.published_at >= effective_now - make_interval(secs => greatest(
            greatest(coalesce(source.poll_interval_seconds, 3600), 60) + coalesce(settings_row.freshness_overlap_minutes, 10) * 60,
            coalesce(settings_row.freshness_minimum_window_minutes, 20) * 60
          ))
        )
      )
  ), ranked as (
    select
      fresh.*,
      md5(lower(regexp_replace(coalesce(fresh.title, ''), '[^a-z0-9]+', '', 'g'))) as proposal_fingerprint,
      least(100, greatest(0,
        (fresh.source_priority * 10)
        + round(fresh.editorial_fit * 10)::integer
        + case
            when coalesce(fresh.published_at, fresh.discovered_at) >= effective_now - interval '15 minutes' then 20
            when coalesce(fresh.published_at, fresh.discovered_at) >= effective_now - interval '2 hours' then 10
            else 0
          end
      )) as proposal_score
    from fresh
    where public.hermes_proposal_text_matches_keywords(fresh.proposal_keywords, fresh.title, fresh.summary)
      and not exists (
        select 1 from public.hermes_story_proposals existing
        where existing.source_event_id = fresh.source_event_id
      )
      and not exists (
        select 1
        from public.hermes_story_proposals existing
        left join public.source_events previous_event on previous_event.id = existing.source_event_id
        where existing.proposal_fingerprint = md5(lower(regexp_replace(coalesce(fresh.title, ''), '[^a-z0-9]+', '', 'g')))
          and existing.status in ('queued','claimed','writing','pitch_ready','ready_for_review')
          and not (
            previous_event.id is not null
            and fresh.content_hash is distinct from previous_event.content_hash
            and fresh.published_at is not null
            and previous_event.published_at is not null
            and fresh.published_at > previous_event.published_at
            and (
              fresh.external_id is not distinct from previous_event.external_id
              or (
                fresh.canonical_url is not null
                and previous_event.canonical_url is not null
                and fresh.canonical_url = previous_event.canonical_url
              )
            )
          )
      )
      and not exists (
        select 1
        from public.candidate_stories existing
        left join public.hermes_story_proposals existing_proposal on existing_proposal.candidate_id = existing.id
        left join public.source_events previous_event on previous_event.id = existing_proposal.source_event_id
        where fresh.source_url is not null
          and nullif(btrim(existing.canonical_url), '') = fresh.source_url
          and not (
            previous_event.id is not null
            and fresh.content_hash is distinct from previous_event.content_hash
            and fresh.published_at is not null
            and previous_event.published_at is not null
            and fresh.published_at > previous_event.published_at
            and (
              fresh.external_id is not distinct from previous_event.external_id
              or (
                fresh.canonical_url is not null
                and previous_event.canonical_url is not null
                and fresh.canonical_url = previous_event.canonical_url
              )
            )
          )
      )
  ), scored as (
    select *, proposal_score >= threshold as passed_threshold
    from ranked
  ), eligible as (
    select * from scored where passed_threshold
    order by proposal_score desc, coalesce(published_at, discovered_at) desc
    limit bounded_limit
  ), inserted as (
    insert into public.hermes_story_proposals (
      source_event_id, proposal_key, proposal_fingerprint, title, summary, source_url,
      source_name, source_type, source_priority, editorial_fit, pipeline_role,
      primary_sections, topic_tags, priority, deterministic_score, deterministic_threshold,
      score_reason, published_at, discovered_at, writer_backend
    )
    select source_event_id, source_event_id::text, proposal_fingerprint,
      left(coalesce(nullif(btrim(title), ''), 'Untitled source lead'), 1000), summary, source_url,
      source_name, source_type, source_priority, editorial_fit, pipeline_role,
      coalesce(primary_sections, '{}'), coalesce(topic_tags, '{}'), proposal_score,
      proposal_score, threshold,
      jsonb_build_object(
        'editorial_fit', editorial_fit,
        'source_priority', source_priority,
        'keyword_match', true,
        'freshness_mode', p_mode,
        'freshness_window_seconds', freshness_window_seconds
      ),
      published_at, discovered_at, 'qwen'
    from eligible
    on conflict (proposal_key) do nothing
    returning id
  ), stats as (
    select count(*)::integer as candidates_scored,
           count(*) filter (where passed_threshold)::integer as passed_threshold
    from scored
  )
  select (select count(*) from inserted), stats.candidates_scored, stats.passed_threshold
  into queued_count, scored_count, passed_count
  from stats;

  return jsonb_build_object(
    'queued', queued_count,
    'candidates_scored', scored_count,
    'items_entering_scoring', scored_count,
    'passed_threshold', passed_count,
    'limit', bounded_limit,
    'active_before', active_count,
    'max_active', max_active,
    'threshold', threshold,
    'mode', p_mode,
    'backfill_from', p_backfill_from,
    'backfill_to', p_backfill_to,
    'freshness_policy', jsonb_build_object(
      'overlap_minutes', coalesce(settings_row.freshness_overlap_minutes, 10),
      'minimum_window_minutes', coalesce(settings_row.freshness_minimum_window_minutes, 20),
      'future_skew_minutes', coalesce(settings_row.freshness_future_skew_minutes, 15)
    ),
    'role', 'discovery_and_both',
    'minimum_editorial_fit', 3.5,
    'source_bridge_filters', true,
    'exact_keyword_matching', true,
    'candidate_url_dedupe', true,
    'source_context', 'summary_and_raw_text'
  );
end;
$$;

create or replace function public.queue_hermes_story_proposals(
  p_now timestamptz default now(),
  p_limit integer default 25
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  return public.queue_hermes_story_proposals_core(p_now, p_limit, 'scheduled', null, null);
end;
$$;

create or replace function public.queue_hermes_story_proposals_backfill(
  p_now timestamptz default now(),
  p_limit integer default 25,
  p_from timestamptz default null,
  p_to timestamptz default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  return public.queue_hermes_story_proposals_core(p_now, p_limit, 'backfill', p_from, p_to);
end;
$$;

revoke all on function public.claim_source_ingestion_batch(timestamptz, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.claim_source_ingestion_batch(timestamptz, integer, integer, boolean) to service_role;
revoke all on function public.queue_hermes_story_proposals_core(timestamptz, integer, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.queue_hermes_story_proposals_core(timestamptz, integer, text, timestamptz, timestamptz) to service_role;
revoke all on function public.queue_hermes_story_proposals(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.queue_hermes_story_proposals(timestamptz, integer) to service_role;
revoke all on function public.queue_hermes_story_proposals_backfill(timestamptz, integer, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.queue_hermes_story_proposals_backfill(timestamptz, integer, timestamptz, timestamptz) to service_role;

comment on function public.queue_hermes_story_proposals_backfill(timestamptz, integer, timestamptz, timestamptz) is
  'Explicit historical Source Graph scan. It shares the canonical scoring and Qwen handoff but is never called by the scheduled trigger.';

commit;
