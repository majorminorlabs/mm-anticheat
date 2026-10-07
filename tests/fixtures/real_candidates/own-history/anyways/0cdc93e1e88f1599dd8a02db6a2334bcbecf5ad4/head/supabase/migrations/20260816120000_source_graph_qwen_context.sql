-- Give the local Qwen gate the retained source context, not only an RSS
-- summary. Source Graph scoring and eligibility remain unchanged.
begin;

update public.hermes_story_proposals proposal
set summary = left(
      coalesce(
        nullif(concat_ws(E'\n\n', nullif(event.summary, ''), nullif(event.raw_text, '')), ''),
        ''
      ),
      4000
    ),
    updated_at = now()
from public.source_events event
where proposal.source_event_id = event.id
  and proposal.writer_backend = 'qwen'
  and proposal.status = 'queued';

create or replace function public.queue_hermes_story_proposals(
  p_now timestamptz default now(),
  p_limit integer default 25
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  queued_count integer := 0;
  scored_count integer := 0;
  passed_count integer := 0;
  bounded_limit integer;
  active_count integer := 0;
  max_active integer := 100;
  threshold integer := 70;
begin
  perform public.assert_pipeline_controller();
  select deterministic_threshold into threshold
  from public.source_graph_discovery_settings
  where id = 'default';
  threshold := coalesce(threshold, 70);
  select count(*) into active_count
  from public.hermes_story_proposals
  where status in ('queued','claimed','writing','pitch_ready','ready_for_review');
  bounded_limit := least(greatest(coalesce(p_limit, 0), 0), greatest(max_active - active_count, 0));

  with ranked as (
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
      event.published_at,
      event.discovered_at,
      md5(lower(regexp_replace(coalesce(event.title, ''), '[^a-z0-9]+', '', 'g'))) as proposal_fingerprint,
      least(100, greatest(0,
        (source.priority * 10)
        + round(source.editorial_fit * 10)::integer
        + case
            when event.discovered_at >= coalesce(p_now, now()) - interval '15 minutes' then 20
            when event.discovered_at >= coalesce(p_now, now()) - interval '2 hours' then 10
            else 0
          end
      )) as proposal_score
    from public.source_events event
    join public.source_registry source on source.id = event.source_id
    where event.status = 'ingested'
      and source.active
      and source.review_status = 'ready'
      and source.pipeline_role in ('discovery','both')
      and source.editorial_fit >= 3.5
      and source.source_type in ('rss','blog','official_announcements','x_account')
      and coalesce(event.published_at, event.discovered_at) >= coalesce(p_now, now()) - interval '72 hours'
      and public.hermes_proposal_text_matches_keywords(source.proposal_keywords, event.title, event.summary)
      and not exists (select 1 from public.hermes_story_proposals existing where existing.source_event_id = event.id)
      and not exists (
        select 1 from public.hermes_story_proposals existing
        where existing.proposal_fingerprint = md5(lower(regexp_replace(coalesce(event.title, ''), '[^a-z0-9]+', '', 'g')))
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
    select source_event_id, source_event_id::text, proposal_fingerprint,
      left(coalesce(nullif(btrim(title), ''), 'Untitled source lead'), 1000), summary, source_url,
      source_name, source_type, source_priority, editorial_fit, pipeline_role,
      coalesce(primary_sections, '{}'), coalesce(topic_tags, '{}'), proposal_score,
      proposal_score, threshold,
      jsonb_build_object('editorial_fit', editorial_fit, 'source_priority', source_priority, 'keyword_match', true, 'recency_window_hours', 72),
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
    'passed_threshold', passed_count,
    'limit', bounded_limit,
    'active_before', active_count,
    'max_active', max_active,
    'threshold', threshold,
    'window_hours', 72,
    'role', 'discovery_and_both',
    'minimum_editorial_fit', 3.5,
    'source_bridge_filters', true,
    'exact_keyword_matching', true,
    'candidate_url_dedupe', true,
    'source_context', 'summary_and_raw_text'
  );
end;
$$;

grant execute on function public.queue_hermes_story_proposals(timestamptz, integer) to service_role;

commit;
