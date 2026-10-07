-- Make overlap idempotent at the deterministic-scoring boundary as well as at
-- source ingestion. A source event can be retained without becoming a pitch;
-- scheduled discovery records that it was evaluated so a low-scoring event is
-- not scored again on every Worker tick. Backfill intentionally bypasses this
-- marker for its explicit range.
begin;

alter table public.source_events
  add column if not exists discovery_evaluated_at timestamptz,
  add column if not exists discovery_evaluation_mode text,
  add column if not exists discovery_score integer,
  add column if not exists discovery_passed_threshold boolean;

alter table public.source_events
  add constraint source_events_discovery_evaluation_mode_check
    check (discovery_evaluation_mode is null or discovery_evaluation_mode in ('scheduled', 'backfill')),
  add constraint source_events_discovery_score_check
    check (discovery_score is null or discovery_score between 0 and 100);

create index if not exists source_events_discovery_evaluation_idx
  on public.source_events(source_id, discovery_evaluated_at, published_at desc);

comment on column public.source_events.discovery_evaluated_at is
  'Time the deterministic Source Graph gate evaluated this event. Scheduled overlap ticks skip marked events.';
comment on column public.source_events.discovery_evaluation_mode is
  'The explicit discovery mode that last evaluated this event; backfill may intentionally replace a scheduled evaluation.';
comment on column public.source_events.discovery_score is
  'Bounded deterministic score retained for discovery operations auditability; no model score is stored here.';

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
      and (p_mode = 'backfill' or event.discovery_evaluated_at is null)
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
  ), evaluated as (
    update public.source_events event
    set discovery_evaluated_at = effective_now,
        discovery_evaluation_mode = p_mode,
        discovery_score = scored.proposal_score,
        discovery_passed_threshold = scored.passed_threshold
    from scored
    where event.id = scored.source_event_id
    returning event.id
  ), eligible as (
    select scored.*
    from scored
    join evaluated on evaluated.id = scored.source_event_id
    where scored.passed_threshold
    order by scored.proposal_score desc, coalesce(scored.published_at, scored.discovered_at) desc
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

commit;
