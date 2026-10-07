-- Keep the source-to-Hermes handoff bounded while a writer is offline or
-- slower than discovery. Claimed and ready-for-review work counts as active;
-- completed/cancelled/rejected work does not.

begin;

create or replace function public.queue_hermes_story_proposals(
  p_now timestamptz default now(),
  p_limit integer default 25
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  queued_count integer := 0;
  bounded_limit integer;
  active_count integer := 0;
  max_active integer := 100;
begin
  perform public.assert_pipeline_controller();

  select count(*) into active_count
  from public.hermes_story_proposals
  where status in ('queued','claimed','writing','ready_for_review');

  bounded_limit := least(
    greatest(coalesce(p_limit, 0), 0),
    greatest(max_active - active_count, 0)
  );

  with eligible as (
    select
      event.id as source_event_id,
      event.title,
      left(coalesce(nullif(event.summary, ''), event.raw_text, ''), 4000) as summary,
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
      )) as proposal_priority
    from public.source_events event
    join public.source_registry source on source.id = event.source_id
    where event.status = 'ingested'
      and source.active
      and source.review_status = 'ready'
      and source.pipeline_role in ('discovery','both')
      and source.editorial_fit >= 3.5
      and source.source_type in ('rss','blog','official_announcements','x_account')
      and coalesce(event.published_at, event.discovered_at) >= coalesce(p_now, now()) - interval '72 hours'
      and public.hermes_proposal_text_matches_keywords(
        source.proposal_keywords, event.title, event.summary
      )
      and not exists (
        select 1 from public.hermes_story_proposals existing
        where existing.source_event_id = event.id
      )
      and not exists (
        select 1 from public.hermes_story_proposals existing
        where existing.proposal_fingerprint = md5(lower(regexp_replace(coalesce(event.title, ''), '[^a-z0-9]+', '', 'g')))
          and existing.status in ('queued','claimed','writing','ready_for_review')
      )
      and not exists (
        select 1
        from public.candidate_stories existing
        where nullif(btrim(event.canonical_url), '') is not null
          and nullif(btrim(existing.canonical_url), '') = nullif(btrim(event.canonical_url), '')
      )
    order by proposal_priority desc, event.discovered_at desc
    limit bounded_limit
  ), inserted as (
    insert into public.hermes_story_proposals (
      source_event_id, proposal_key, proposal_fingerprint, title, summary, source_url,
      source_name, source_type, source_priority, editorial_fit, pipeline_role,
      primary_sections, topic_tags, priority, published_at, discovered_at
    )
    select source_event_id, source_event_id::text, proposal_fingerprint,
      left(coalesce(nullif(btrim(title), ''), 'Untitled source lead'), 1000), summary, source_url,
      source_name, source_type, source_priority, editorial_fit, pipeline_role,
      coalesce(primary_sections, '{}'), coalesce(topic_tags, '{}'), proposal_priority,
      published_at, discovered_at
    from eligible
    on conflict (proposal_key) do nothing
    returning id
  ) select count(*) into queued_count from inserted;

  return jsonb_build_object(
    'queued', queued_count,
    'limit', bounded_limit,
    'active_before', active_count,
    'max_active', max_active,
    'window_hours', 72,
    'role', 'discovery_and_both',
    'minimum_editorial_fit', 3.5,
    'source_bridge_filters', true,
    'exact_keyword_matching', true,
    'candidate_url_dedupe', true
  );
end;
$$;

commit;
