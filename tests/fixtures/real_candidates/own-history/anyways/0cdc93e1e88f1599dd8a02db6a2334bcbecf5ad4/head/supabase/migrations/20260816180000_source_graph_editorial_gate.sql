-- Keep the deterministic Source Graph gate from treating source metadata as
-- editorial judgment. Newly observed feed items are evaluated on discovery
-- time, while routine commodity leads are stopped before they consume Qwen.
begin;

create or replace function public.hermes_proposal_commodity_reason(
  p_title text,
  p_summary text
) returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  with normalized as (
    select regexp_replace(
      lower(concat_ws(' ', coalesce(p_title, ''), coalesce(p_summary, ''))),
      '[^a-z0-9$%]+', ' ', 'g'
    ) as value
  )
  select case
    when value ~ '\m(promo|promotion|discount|coupon|affiliate|buying guide|shopping guide|product roundup|what to buy)\M'
      then 'consumer_utility'
    when value ~ '\m(raises?|raised|funding|series [a-e]|seed round|valuation)\M'
      then 'funding_or_valuation'
    when value ~ '\m(earnings|quarterly results|stock price|shares)\M'
      then 'routine_financial'
    when value ~ '\m(review|reviews|benchmark|benchmarks|specification|specifications|specs?)\M'
      and value ~ '\m(ai|model|artificial intelligence|gpu)\M'
      and value !~ '\m(ban|banned|law|policy|privacy|mental health|labor|work|rights?|surveillance|culture|behavior)\M'
      then 'generic_ai_review'
    when value ~ '\m(launches?|unveils?|announces?|introduces?|releases?|debut|debuts?|rolls out|partners with|appoints?)\M'
      and value !~ '\m(law|ban|rule|policy|union|strike|rights?|court|regulat|security|hack|exploit|breach)\M'
      then 'routine_announcement'
    when value ~ '\m(sec|regulator|regulatory|policy)\M'
      and value ~ '\m(meeting|hearing|commentary|update|delay)\M'
      and value !~ '\m(rule|rules|ban|banned|enforce|enforcement|lawsuit|court|settlement|impact|changes?|requirement)\M'
      then 'routine_regulatory_commentary'
    when value ~ '\m(looking past|market cap rankings|back to fundamentals|tradfi giants embrace|embrace digital assets|stablecoin yield clash)\M'
      and value !~ '\m(lawsuit|ban|law|court|policy|rights?|privacy|scam|fraud|hack|exploit|breach|stolen)\M'
      then 'routine_market_commentary'
    else null
  end
  from normalized;
$$;

create or replace function public.hermes_proposal_editorial_signal(
  p_title text,
  p_summary text
) returns integer
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  with normalized as (
    select regexp_replace(
      lower(concat_ws(' ', coalesce(p_title, ''), coalesce(p_summary, ''))),
      '[^a-z0-9$%]+', ' ', 'g'
    ) as value
  )
  select least(40,
    case when value ~ '\m(people|person|users?|customers?|workers?|creators?|players?|collectors?|community|communities|fans?|patients?|families|public|ordinary)\M' then 10 else 0 end
    + case when value ~ '\m(power|control|rights?|privacy|surveillance|labor|work|culture|behavior|identity|inequality|policy|politic|regulat|law|court|ban|government|institution|system|infrastructure|security|vulnerab|flaw|financial|bank|capital|market)\M' then 10 else 0 end
    + case when value ~ '\m(exposes?|reveals?|sues?|bans?|blocks?|stolen|steal|theft|fraud|scam|hack(ed|ers?)?|exploit(ed)?|breach|approves?|rejects?|collapses?|withdraws?|changes?|shifts?|votes?|strikes?|investigat|settles?)\M' then 10 else 0 end
    + case when value ~ '(^| )[0-9][0-9,]*(%| (million|billion|thousand))?($| )' or value ~ '[$€£][0-9]' then 5 else 0 end
    + case when value ~ '\m(onchain|on chain|token|tokens|nft|nfts|blockchain|web3|crypto|cryptocurrency|bitcoin|ethereum|solana|stablecoin|prediction market|digital asset|digital assets)\M' then 5 else 0 end
  )
  from normalized;
$$;

comment on function public.hermes_proposal_commodity_reason(text, text) is
  'Returns the deterministic reason an event is routine commodity coverage before Qwen is asked to write a pitch.';
comment on function public.hermes_proposal_editorial_signal(text, text) is
  'Returns a bounded deterministic signal for human consequence, systems, concrete change, evidence, and Web3 relevance.';

revoke all on function public.hermes_proposal_commodity_reason(text, text) from public, anon, authenticated;
grant execute on function public.hermes_proposal_commodity_reason(text, text) to service_role;
revoke all on function public.hermes_proposal_editorial_signal(text, text) from public, anon, authenticated;
grant execute on function public.hermes_proposal_editorial_signal(text, text) to service_role;

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
        when p_mode = 'scheduled' then event.discovered_at
        else coalesce(event.published_at, event.discovered_at)
      end as freshness_timestamp,
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
      and (
        (
          p_mode = 'backfill'
          and event.published_at is not null
          and event.published_at >= p_backfill_from
          and event.published_at < p_backfill_to
        )
        or (
          p_mode = 'scheduled'
          and event.discovered_at <= effective_now + make_interval(mins => greatest(coalesce(settings_row.freshness_future_skew_minutes, 15), 0))
          and event.discovered_at >= effective_now - make_interval(secs => greatest(
            greatest(coalesce(source.poll_interval_seconds, 3600), 60) + coalesce(settings_row.freshness_overlap_minutes, 10) * 60,
            coalesce(settings_row.freshness_minimum_window_minutes, 20) * 60
          ))
          and (
            event.published_at is null
            or (
              event.published_at <= effective_now + make_interval(mins => greatest(coalesce(settings_row.freshness_future_skew_minutes, 15), 0))
              and event.published_at >= effective_now - interval '72 hours'
            )
          )
        )
      )
  ), classified as (
    select
      fresh.*,
      public.hermes_proposal_commodity_reason(fresh.title, fresh.summary) as commodity_reason,
      public.hermes_proposal_editorial_signal(fresh.title, fresh.summary) as editorial_signal
    from fresh
  ), ranked as (
    select
      classified.*,
      md5(lower(regexp_replace(coalesce(classified.title, ''), '[^a-z0-9]+', '', 'g'))) as proposal_fingerprint,
      least(100, greatest(0,
        least(25, greatest(0, round(classified.source_priority::numeric * 2.5)::integer))
        + least(15, greatest(0, round(classified.editorial_fit * 3)::integer))
        + least(40, greatest(0, classified.editorial_signal))
        + case
            when classified.freshness_timestamp >= effective_now - interval '15 minutes' then 20
            when classified.freshness_timestamp >= effective_now - interval '2 hours' then 10
            else 0
          end
      )) as proposal_score
    from classified
    where classified.commodity_reason is null
      and classified.editorial_signal >= 20
      and public.hermes_proposal_text_matches_keywords(classified.proposal_keywords, classified.title, classified.summary)
      and not exists (
        select 1 from public.hermes_story_proposals existing
        where existing.source_event_id = classified.source_event_id
      )
      and not exists (
        select 1
        from public.hermes_story_proposals existing
        left join public.source_events previous_event on previous_event.id = existing.source_event_id
        where existing.proposal_fingerprint = md5(lower(regexp_replace(coalesce(classified.title, ''), '[^a-z0-9]+', '', 'g')))
          and existing.status in ('queued','claimed','writing','pitch_ready','ready_for_review')
          and not (
            previous_event.id is not null
            and classified.content_hash is distinct from previous_event.content_hash
            and classified.published_at is not null
            and previous_event.published_at is not null
            and classified.published_at > previous_event.published_at
            and (
              classified.external_id is not distinct from previous_event.external_id
              or (
                classified.canonical_url is not null
                and previous_event.canonical_url is not null
                and classified.canonical_url = previous_event.canonical_url
              )
            )
          )
      )
      and not exists (
        select 1
        from public.candidate_stories existing
        left join public.hermes_story_proposals existing_proposal on existing_proposal.candidate_id = existing.id
        left join public.source_events previous_event on previous_event.id = existing_proposal.source_event_id
        where classified.source_url is not null
          and nullif(btrim(existing.canonical_url), '') = classified.source_url
          and not (
            previous_event.id is not null
            and classified.content_hash is distinct from previous_event.content_hash
            and classified.published_at is not null
            and previous_event.published_at is not null
            and classified.published_at > previous_event.published_at
            and (
              classified.external_id is not distinct from previous_event.external_id
              or (
                classified.canonical_url is not null
                and previous_event.canonical_url is not null
                and classified.canonical_url = previous_event.canonical_url
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
    order by scored.proposal_score desc, scored.freshness_timestamp desc
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
        'editorial_signal', editorial_signal,
        'commodity_reason', commodity_reason,
        'editorial_fit', editorial_fit,
        'source_priority', source_priority,
        'keyword_match', true,
        'freshness_mode', p_mode,
        'freshness_timestamp', freshness_timestamp,
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
      'basis', case when p_mode = 'scheduled' then 'discovered_at' else 'published_at' end,
      'overlap_minutes', coalesce(settings_row.freshness_overlap_minutes, 10),
      'minimum_window_minutes', coalesce(settings_row.freshness_minimum_window_minutes, 20),
      'future_skew_minutes', coalesce(settings_row.freshness_future_skew_minutes, 15),
      'maximum_publication_age_hours', 72
    ),
    'editorial_gate', jsonb_build_object(
      'minimum_editorial_signal', 20,
      'commodity_filter', true,
      'metadata_score_max', 40
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

revoke all on function public.queue_hermes_story_proposals_core(timestamptz, integer, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.queue_hermes_story_proposals_core(timestamptz, integer, text, timestamptz, timestamptz) to service_role;

commit;
