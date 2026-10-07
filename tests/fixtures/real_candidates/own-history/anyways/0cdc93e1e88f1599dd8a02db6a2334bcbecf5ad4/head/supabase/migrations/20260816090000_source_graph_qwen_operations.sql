-- Canonical discovery operations. Source Graph ingestion remains Worker-owned;
-- this migration adds the durable Qwen handoff, operational metrics, and the
-- small amount of control state the Newsroom needs. It never creates an
-- article or publishes anything.

alter type public.pipeline_job_type add value if not exists 'generate_pitch';

begin;

alter table public.discovery_runs
  add column if not exists workflow text not null default 'legacy_local',
  add column if not exists trigger text not null default 'manual',
  add column if not exists requested_by uuid references public.profiles(id) on delete set null;

create index if not exists discovery_runs_workflow_started_idx
  on public.discovery_runs(workflow, started_at desc);

alter table public.hermes_story_proposals
  add column if not exists writer_backend text not null default 'hermes',
  add column if not exists pipeline_job_id uuid references public.pipeline_jobs(id) on delete set null,
  add column if not exists deterministic_score integer not null default 0,
  add column if not exists deterministic_threshold integer not null default 70,
  add column if not exists score_reason jsonb not null default '{}'::jsonb;

alter table public.hermes_story_proposals
  drop constraint if exists hermes_story_proposals_status_check;
alter table public.hermes_story_proposals
  add constraint hermes_story_proposals_status_check
  check (status in ('queued','claimed','writing','pitch_ready','ready_for_review','failed','rejected','cancelled'));

alter table public.hermes_story_proposals
  drop constraint if exists hermes_story_proposals_writer_backend_check;
alter table public.hermes_story_proposals
  add constraint hermes_story_proposals_writer_backend_check
  check (writer_backend in ('hermes', 'qwen'));

create index if not exists hermes_story_proposals_qwen_queue_idx
  on public.hermes_story_proposals(writer_backend, status, priority desc, discovered_at desc);
create index if not exists hermes_story_proposals_pipeline_job_idx
  on public.hermes_story_proposals(pipeline_job_id)
  where pipeline_job_id is not null;

-- Existing queued source leads are the canonical backlog. Hand them to the
-- local writer rather than leaving them attached to the retired Hermes-only
-- handoff.
update public.hermes_story_proposals
set writer_backend = 'qwen',
    updated_at = now()
where status = 'queued';

update public.hermes_story_proposals proposal
set deterministic_score = least(100, greatest(0,
      (source.priority * 10)
      + round(source.editorial_fit * 10)::integer
      + case
          when event.discovered_at >= now() - interval '15 minutes' then 20
          when event.discovered_at >= now() - interval '2 hours' then 10
          else 0
        end
    )),
    deterministic_threshold = 70,
    score_reason = jsonb_build_object('editorial_fit', source.editorial_fit, 'source_priority', source.priority, 'keyword_match', true, 'recency_window_hours', 72),
    updated_at = now()
from public.source_events event
join public.source_registry source on source.id = event.source_id
where proposal.source_event_id = event.id
  and proposal.writer_backend = 'qwen';

create table if not exists public.source_graph_discovery_settings (
  id text primary key default 'default' check (id = 'default'),
  enabled boolean not null default true,
  dispatcher_cron text not null default '* * * * *',
  source_batch_size integer not null default 3 check (source_batch_size between 1 and 5),
  proposal_batch_size integer not null default 25 check (proposal_batch_size between 1 and 100),
  pitch_batch_size integer not null default 2 check (pitch_batch_size between 1 and 10),
  deterministic_threshold integer not null default 70 check (deterministic_threshold between 0 and 100),
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.source_graph_discovery_settings(id) values ('default') on conflict (id) do nothing;

create table if not exists public.pipeline_controller_health (
  controller_id text primary key,
  host text,
  pid integer,
  state text not null default 'starting',
  queue_connectivity boolean,
  ollama_connectivity boolean,
  model_available boolean,
  model text,
  current_job_id uuid references public.pipeline_jobs(id) on delete set null,
  last_completed_job_id uuid references public.pipeline_jobs(id) on delete set null,
  last_error text,
  memory_available_gb numeric(8,2),
  memory_pressure_percent numeric(6,2),
  swap_used_gb numeric(8,2),
  loaded_ollama_models jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.source_graph_discovery_settings enable row level security;
alter table public.pipeline_controller_health enable row level security;
drop policy if exists "editors read source graph discovery settings" on public.source_graph_discovery_settings;
create policy "editors read source graph discovery settings"
on public.source_graph_discovery_settings for select to authenticated
using (public.is_editor());
drop policy if exists "editors read pipeline controller health" on public.pipeline_controller_health;
create policy "editors read pipeline controller health"
on public.pipeline_controller_health for select to authenticated
using (public.is_editor());

-- The previous recurring scoring/Luna loop is not the canonical discovery
-- path. Pause its settings and queued automation work once, while leaving the
-- manual/editor-directed controls available for development and diagnostics.
update public.editorial_automation_settings
set enabled = false,
    scoring_enabled = false,
    enrichment_enabled = false,
    luna_enabled = false,
    last_error = 'Paused: canonical Source Graph -> deterministic score -> Qwen discovery is now the scheduled path.',
    updated_at = now()
where id = 'default';

update public.editorial_scoring_settings
set enabled = false,
    updated_at = now()
where id = 'default';

update public.pipeline_jobs
set status = 'cancelled',
    finished_at = now(),
    error = jsonb_build_object(
      'code', 'LEGACY_EDITORIAL_AUTOMATION_PAUSED',
      'message', 'Recurring model scoring and Luna automation were paused when canonical Source Graph discovery was enabled.'
    )
where status = 'queued'
  and parameters ->> 'automation_run' = 'true';

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
  if p_trigger not in ('scheduled', 'manual') then
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
  values ('source_graph_qwen', p_trigger, p_requested_by, 'running', jsonb_build_object('sources_scanned', 0, 'new_source_events', 0, 'candidates_scored', 0, 'passed_threshold', 0, 'generate_pitch_jobs_created', 0, 'pitches_generated', 0, 'failures', 0))
  returning * into run;
  return jsonb_build_object('started', true, 'skipped', false, 'run_id', run.id, 'settings', to_jsonb(settings_row));
end;
$$;

create or replace function public.finish_source_graph_discovery_run(
  p_run_id uuid,
  p_status text,
  p_counts jsonb default '{}'::jsonb,
  p_error text default null
) returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.assert_pipeline_controller();
  if p_status not in ('succeeded', 'failed', 'skipped') then
    raise exception using errcode = '22023', message = 'invalid discovery run status';
  end if;
  update public.discovery_runs
  set status = p_status,
      counts = coalesce(p_counts, '{}'::jsonb),
      error = nullif(left(coalesce(p_error, ''), 4000), ''),
      finished_at = now()
  where id = p_run_id
    and workflow = 'source_graph_qwen'
    and status = 'running';
  return found;
end;
$$;

create or replace function public.save_source_graph_discovery_settings(
  p_enabled boolean,
  p_requested_by uuid
) returns public.source_graph_discovery_settings language plpgsql security definer set search_path = pg_catalog, public as $$
declare saved public.source_graph_discovery_settings%rowtype;
begin
  perform public.assert_pipeline_controller();
  if p_requested_by is null or not exists (select 1 from public.profiles where id = p_requested_by and role in ('admin', 'editor')) then
    raise exception using errcode = '42501', message = 'an editor account is required';
  end if;
  update public.source_graph_discovery_settings
  set enabled = coalesce(p_enabled, false), updated_by = p_requested_by, updated_at = now()
  where id = 'default'
  returning * into saved;
  return saved;
end;
$$;

-- The deterministic bridge is deliberately the only place where a source
-- event becomes writing work. It keeps the existing Source Graph filters and
-- priority formula, then records the score and threshold for auditability.
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
    'candidate_url_dedupe', true
  );
end;
$$;

create or replace function public.queue_generate_pitch_jobs(
  p_now timestamptz default now(),
  p_limit integer default 2
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  proposal public.hermes_story_proposals%rowtype;
  candidate public.candidate_stories%rowtype;
  inserted_job public.pipeline_jobs%rowtype;
  active_job public.pipeline_jobs%rowtype;
  bounded_limit integer := least(greatest(coalesce(p_limit, 0), 0), 10);
  jobs_created integer := 0;
  candidate_external_id text;
  marker jsonb;
begin
  perform public.assert_pipeline_controller();
  for proposal in
    select p.*
    from public.hermes_story_proposals p
    where p.writer_backend = 'qwen'
      and p.status = 'queued'
      and not exists (
        select 1 from public.pipeline_jobs j
        where j.job_type = 'generate_pitch'
          and j.parameters ->> 'proposal_id' = p.id::text
          and j.status in ('queued','claimed','running')
      )
    order by p.priority desc, p.discovered_at desc
    limit bounded_limit
    for update of p skip locked
  loop
    candidate_external_id := 'qwen:source-proposal:' || proposal.id::text;
    marker := jsonb_build_object(
      'origin', 'source_graph_qwen',
      'source_proposal_id', proposal.id,
      'source_event_id', proposal.source_event_id,
      'source_name', proposal.source_name,
      'source_summary', proposal.summary,
      'deterministic_score', proposal.deterministic_score,
      'deterministic_threshold', proposal.deterministic_threshold,
      'discovery_enrichment', jsonb_build_object('status', 'queued', 'backend', 'qwen', 'updated_at', coalesce(p_now, now()))
    );
    insert into public.candidate_stories(external_id, cluster_key, title, canonical_url, status, classification, created_at, updated_at)
    values (candidate_external_id, candidate_external_id, proposal.title, proposal.source_url, 'discovered', marker, coalesce(proposal.discovered_at, p_now), coalesce(p_now, now()))
    on conflict (external_id) where external_id is not null do update
      set title = case when public.candidate_stories.status in ('discovered','watching','rejected','archived') then excluded.title else public.candidate_stories.title end,
          canonical_url = case when public.candidate_stories.status in ('discovered','watching','rejected','archived') then excluded.canonical_url else public.candidate_stories.canonical_url end,
          classification = case when public.candidate_stories.status in ('discovered','watching','rejected','archived') then excluded.classification else public.candidate_stories.classification end,
          status = case when public.candidate_stories.status in ('discovered','watching','rejected','archived') then 'discovered'::public.pipeline_candidate_status else public.candidate_stories.status end,
          updated_at = case when public.candidate_stories.status in ('discovered','watching','rejected','archived') then coalesce(p_now, now()) else public.candidate_stories.updated_at end
    returning * into candidate;
    if candidate.status = 'pitch_ready' then
      update public.hermes_story_proposals set candidate_id = candidate.id, status = 'pitch_ready', updated_at = coalesce(p_now, now()) where id = proposal.id;
      continue;
    end if;
    select * into active_job
    from public.pipeline_jobs
    where job_type = 'generate_pitch'
      and parameters ->> 'proposal_id' = proposal.id::text
      and status in ('queued','claimed','running')
    order by created_at desc limit 1;
    if found then
      update public.hermes_story_proposals set candidate_id = candidate.id, pipeline_job_id = active_job.id, updated_at = coalesce(p_now, now()) where id = proposal.id;
      continue;
    end if;
    insert into public.pipeline_jobs(job_type, parameters, source, priority, max_attempts, pipeline_candidate_id)
    values (
      'generate_pitch',
      jsonb_build_object('proposal_id', proposal.id, 'source_event_id', proposal.source_event_id, 'candidate_external_id', candidate_external_id, 'model', 'qwen3:14b', 'prompt_version', 'editorial-pitch-gate-v3'),
      'scheduled', 50 + least(50, greatest(0, proposal.priority / 2)), 3, candidate.id
    ) returning * into inserted_job;
    insert into public.pipeline_job_events(job_id, level, event_type, message, metadata)
    values (inserted_job.id, 'info', 'discovery_pitch_queued', 'Deterministic discovery passed the threshold; Qwen pitch job queued.', jsonb_build_object('proposal_id', proposal.id, 'source_event_id', proposal.source_event_id, 'deterministic_score', proposal.deterministic_score, 'deterministic_threshold', proposal.deterministic_threshold));
    update public.hermes_story_proposals
    set candidate_id = candidate.id,
        pipeline_job_id = inserted_job.id,
        result = coalesce(result, '{}'::jsonb) || jsonb_build_object('job_queued_at', coalesce(p_now, now()), 'pipeline_job_id', inserted_job.id),
        updated_at = coalesce(p_now, now())
    where id = proposal.id;
    jobs_created := jobs_created + 1;
  end loop;
  return jsonb_build_object('jobs_created', jobs_created, 'limit', bounded_limit, 'backend', 'qwen');
end;
$$;

create or replace function public.begin_generate_pitch(
  p_job_id uuid,
  p_proposal_id uuid,
  p_worker_id text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare proposal public.hermes_story_proposals%rowtype; candidate public.candidate_stories%rowtype;
begin
  perform public.assert_pipeline_controller();
  select * into proposal from public.hermes_story_proposals where id = p_proposal_id for update;
  if not found or proposal.writer_backend <> 'qwen' or proposal.pipeline_job_id is distinct from p_job_id then
    raise exception using errcode = '22023', message = 'Qwen proposal/job pairing is invalid';
  end if;
  if proposal.status in ('pitch_ready', 'rejected') then
    return jsonb_build_object('duplicate', true, 'status', proposal.status, 'proposal_id', proposal.id);
  end if;
  select * into candidate from public.candidate_stories where id = proposal.candidate_id for update;
  update public.hermes_story_proposals
  set status = 'writing', claimed_by = nullif(btrim(p_worker_id), ''), claimed_at = now(), lease_until = now() + interval '20 minutes', updated_at = now()
  where id = proposal.id;
  if found and candidate.id is not null then
    update public.candidate_stories
    set classification = coalesce(candidate.classification, '{}'::jsonb) || jsonb_build_object('discovery_enrichment', jsonb_build_object('status', 'writing', 'backend', 'qwen', 'job_id', p_job_id, 'updated_at', now())), updated_at = now()
    where id = candidate.id and status in ('discovered','watching','rejected');
  end if;
  return jsonb_build_object('duplicate', false, 'status', 'writing', 'proposal_id', proposal.id, 'candidate_id', proposal.candidate_id);
end;
$$;

create or replace function public.finish_generate_pitch(
  p_job_id uuid,
  p_proposal_id uuid,
  p_status text,
  p_pitch jsonb default null,
  p_error jsonb default null,
  p_model text default 'qwen3:14b',
  p_prompt_version text default 'editorial-pitch-gate-v3',
  p_retryable boolean default false
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  proposal public.hermes_story_proposals%rowtype;
  candidate public.candidate_stories%rowtype;
  classification jsonb;
  valid_pitch boolean;
  reason text;
begin
  perform public.assert_pipeline_controller();
  if p_status not in ('succeeded', 'rejected', 'failed') then
    raise exception using errcode = '22023', message = 'invalid Qwen pitch completion status';
  end if;
  select * into proposal from public.hermes_story_proposals where id = p_proposal_id for update;
  if not found or proposal.writer_backend <> 'qwen' or proposal.pipeline_job_id is distinct from p_job_id then
    raise exception using errcode = '22023', message = 'Qwen proposal/job pairing is invalid';
  end if;
  if proposal.status in ('pitch_ready', 'rejected') then
    return jsonb_build_object('duplicate', true, 'status', proposal.status, 'proposal_id', proposal.id, 'candidate_id', proposal.candidate_id);
  end if;
  select * into candidate from public.candidate_stories where id = proposal.candidate_id for update;
  if p_status = 'succeeded' then
    valid_pitch := public.editorial_pitch_is_valid(jsonb_build_object(
      'primary_section', p_pitch ->> 'primary_section',
      'story_form', p_pitch ->> 'story_form',
      'editorial_pitch', p_pitch
    ));
    if not valid_pitch then
      raise exception using errcode = '22023', message = 'Qwen returned a pitch that did not pass the editorial pitch gate';
    end if;
    classification := coalesce(candidate.classification, '{}'::jsonb)
      || jsonb_build_object(
        'origin', 'source_graph_qwen',
        'source_proposal_id', proposal.id,
        'source_event_id', proposal.source_event_id,
        'primary_section', p_pitch ->> 'primary_section',
        'story_form', p_pitch ->> 'story_form',
        'recurring_beats', coalesce(p_pitch -> 'beats', '[]'::jsonb),
        'editorial_pitch', p_pitch || jsonb_build_object('model', p_model, 'prompt_version', p_prompt_version),
        'commission', jsonb_build_object(
          'brief', concat_ws(E'\n\n', p_pitch ->> 'lens', p_pitch ->> 'section_answer', p_pitch ->> 'why_now', p_pitch ->> 'reader_takeaway'),
          'section_id', p_pitch ->> 'primary_section',
          'story_form', p_pitch ->> 'story_form',
          'beats', coalesce(p_pitch -> 'beats', '[]'::jsonb),
          'tags', '[]'::jsonb,
          'notes', 'Generated from a deterministic Source Graph lead. Editorial review is required before commission.',
          'source_urls', case when proposal.source_url is null then '[]'::jsonb else jsonb_build_array(proposal.source_url) end
        ),
        'discovery_enrichment', jsonb_build_object('status', 'succeeded', 'backend', 'qwen', 'job_id', p_job_id, 'model', p_model, 'prompt_version', p_prompt_version, 'updated_at', now())
      );
    update public.candidate_stories
    set title = left(coalesce(p_pitch ->> 'headline', proposal.title), 1000),
        status = 'pitch_ready'::public.pipeline_candidate_status,
        classification = classification,
        model = p_model,
        prompt_version = p_prompt_version,
        updated_at = now()
    where id = candidate.id;
    update public.hermes_story_proposals
    set status = 'pitch_ready',
        result = coalesce(result, '{}'::jsonb) || jsonb_build_object('pitch', p_pitch, 'model', p_model, 'prompt_version', p_prompt_version, 'completed_by_job', p_job_id),
        error = null,
        completed_at = now(),
        lease_until = null,
        updated_at = now()
    where id = proposal.id;
    return jsonb_build_object('duplicate', false, 'status', 'pitch_ready', 'proposal_id', proposal.id, 'candidate_id', candidate.id, 'headline', p_pitch ->> 'headline');
  end if;
  reason := coalesce(p_error ->> 'message', case when p_status = 'rejected' then p_pitch ->> 'rejection_reason' else 'Qwen pitch generation failed.' end, 'Qwen pitch generation failed.');
  if p_status = 'rejected' then
    update public.candidate_stories
    set status = 'rejected'::public.pipeline_candidate_status,
        classification = coalesce(candidate.classification, '{}'::jsonb) || jsonb_build_object('discovery_enrichment', jsonb_build_object('status', 'rejected', 'backend', 'qwen', 'reason', reason, 'updated_at', now())),
        updated_at = now()
    where id = candidate.id;
    update public.hermes_story_proposals set status = 'rejected', error = jsonb_build_object('code', 'PITCH_REJECTED', 'message', reason), completed_at = now(), lease_until = null, updated_at = now() where id = proposal.id;
  elsif p_retryable then
    update public.candidate_stories
    set status = 'discovered'::public.pipeline_candidate_status,
        classification = coalesce(candidate.classification, '{}'::jsonb) || jsonb_build_object('discovery_enrichment', jsonb_build_object('status', 'queued', 'backend', 'qwen', 'last_error', reason, 'updated_at', now())),
        updated_at = now()
    where id = candidate.id;
    update public.hermes_story_proposals set status = 'queued', error = p_error, completed_at = null, lease_until = null, updated_at = now() where id = proposal.id;
  else
    update public.candidate_stories
    set status = 'discovered'::public.pipeline_candidate_status,
        classification = coalesce(candidate.classification, '{}'::jsonb) || jsonb_build_object('discovery_enrichment', jsonb_build_object('status', 'failed', 'backend', 'qwen', 'reason', reason, 'retryable', false, 'updated_at', now())),
        updated_at = now()
    where id = candidate.id;
    update public.hermes_story_proposals set status = 'failed', error = coalesce(p_error, jsonb_build_object('code', 'QWEN_PITCH_FAILED', 'message', reason)), completed_at = now(), lease_until = null, updated_at = now() where id = proposal.id;
  end if;
  return jsonb_build_object('duplicate', false, 'status', case when p_status = 'rejected' then 'rejected' when p_retryable then 'queued' else 'failed' end, 'proposal_id', proposal.id, 'candidate_id', candidate.id, 'message', reason);
end;
$$;

create or replace function public.retry_generate_pitch(
  p_proposal_id uuid,
  p_requested_by uuid
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare proposal public.hermes_story_proposals%rowtype; candidate public.candidate_stories%rowtype; inserted_job public.pipeline_jobs%rowtype; active_job public.pipeline_jobs%rowtype;
begin
  perform public.assert_pipeline_controller();
  if p_requested_by is null or not exists (select 1 from public.profiles where id = p_requested_by and role in ('admin', 'editor')) then
    raise exception using errcode = '42501', message = 'an editor account is required';
  end if;
  select * into proposal from public.hermes_story_proposals where id = p_proposal_id for update;
  if not found or proposal.writer_backend <> 'qwen' then raise exception using errcode = 'P0002', message = 'Qwen proposal was not found'; end if;
  if proposal.status in ('queued','claimed','writing') then return jsonb_build_object('duplicate', true, 'status', proposal.status, 'proposal_id', proposal.id, 'pipeline_job_id', proposal.pipeline_job_id); end if;
  if proposal.status not in ('failed','rejected') then raise exception using errcode = '22023', message = 'only a failed Qwen pitch can be retried'; end if;
  select * into candidate from public.candidate_stories where id = proposal.candidate_id for update;
  select * into active_job from public.pipeline_jobs where job_type = 'generate_pitch' and parameters ->> 'proposal_id' = proposal.id::text and status in ('queued','claimed','running') order by created_at desc limit 1;
  if found then return jsonb_build_object('duplicate', true, 'status', proposal.status, 'proposal_id', proposal.id, 'pipeline_job_id', active_job.id); end if;
  insert into public.pipeline_jobs(job_type, parameters, source, priority, max_attempts, requested_by, pipeline_candidate_id)
  values ('generate_pitch', jsonb_build_object('proposal_id', proposal.id, 'source_event_id', proposal.source_event_id, 'candidate_external_id', candidate.external_id, 'model', 'qwen3:14b', 'prompt_version', 'editorial-pitch-gate-v3'), 'newsroom', 60, 3, p_requested_by, candidate.id)
  returning * into inserted_job;
  update public.hermes_story_proposals set status = 'queued', pipeline_job_id = inserted_job.id, error = null, completed_at = null, updated_at = now() where id = proposal.id;
  update public.candidate_stories set status = 'discovered'::public.pipeline_candidate_status, classification = coalesce(classification, '{}'::jsonb) || jsonb_build_object('discovery_enrichment', jsonb_build_object('status', 'queued', 'backend', 'qwen', 'retry_requested_by', p_requested_by, 'updated_at', now())), updated_at = now() where id = candidate.id;
  insert into public.pipeline_job_events(job_id, level, event_type, message, metadata) values (inserted_job.id, 'info', 'editor_retry', 'Editor retried a failed Qwen pitch.', jsonb_build_object('proposal_id', proposal.id, 'requested_by', p_requested_by));
  return jsonb_build_object('duplicate', false, 'status', 'queued', 'proposal_id', proposal.id, 'pipeline_job_id', inserted_job.id);
end;
$$;

create or replace function public.record_pipeline_controller_health(
  p_controller_id text,
  p_state jsonb
) returns public.pipeline_controller_health language plpgsql security definer set search_path = pg_catalog, public as $$
declare saved public.pipeline_controller_health%rowtype;
begin
  perform public.assert_pipeline_controller();
  if nullif(btrim(p_controller_id), '') is null or jsonb_typeof(p_state) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'controller health payload is invalid';
  end if;
  insert into public.pipeline_controller_health(controller_id, host, pid, state, queue_connectivity, ollama_connectivity, model_available, model, current_job_id, last_completed_job_id, last_error, memory_available_gb, memory_pressure_percent, swap_used_gb, loaded_ollama_models, started_at, updated_at)
  values (
    p_controller_id,
    nullif(p_state ->> 'host', ''),
    nullif(p_state ->> 'pid', '')::integer,
    coalesce(nullif(p_state ->> 'state', ''), 'running'),
    (p_state ->> 'queue_connectivity')::boolean,
    (p_state ->> 'ollama_connectivity')::boolean,
    (p_state ->> 'model_available')::boolean,
    nullif(p_state ->> 'model', ''),
    nullif(p_state ->> 'current_job_id', '')::uuid,
    nullif(p_state ->> 'last_completed_job_id', '')::uuid,
    nullif(left(p_state ->> 'last_error', 1000), ''),
    nullif(p_state ->> 'memory_available_gb', '')::numeric,
    nullif(p_state ->> 'memory_pressure_percent', '')::numeric,
    nullif(p_state ->> 'swap_used_gb', '')::numeric,
    coalesce(p_state -> 'loaded_ollama_models', '[]'::jsonb),
    coalesce(nullif(p_state ->> 'started_at', '')::timestamptz, now()),
    now()
  )
  on conflict (controller_id) do update set
    host = excluded.host, pid = excluded.pid, state = excluded.state,
    queue_connectivity = excluded.queue_connectivity, ollama_connectivity = excluded.ollama_connectivity,
    model_available = excluded.model_available, model = excluded.model,
    current_job_id = excluded.current_job_id, last_completed_job_id = excluded.last_completed_job_id,
    last_error = excluded.last_error, memory_available_gb = excluded.memory_available_gb,
    memory_pressure_percent = excluded.memory_pressure_percent, swap_used_gb = excluded.swap_used_gb,
    loaded_ollama_models = excluded.loaded_ollama_models, started_at = excluded.started_at, updated_at = now()
  returning * into saved;
  return saved;
end;
$$;

create or replace function public.get_source_graph_discovery_status()
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  settings_row public.source_graph_discovery_settings%rowtype;
  latest_run public.discovery_runs%rowtype;
  latest_success public.discovery_runs%rowtype;
  health_row public.pipeline_controller_health%rowtype;
  next_run timestamptz;
  queued_jobs integer := 0;
  generating_jobs integer := 0;
  ready_pitches integer := 0;
  failed_pitches integer := 0;
  generated_pitches integer := 0;
  recent_failures jsonb;
  active_sources integer := 0;
begin
  perform public.assert_pipeline_controller();
  select * into settings_row from public.source_graph_discovery_settings where id = 'default';
  select * into latest_run from public.discovery_runs where workflow = 'source_graph_qwen' order by started_at desc limit 1;
  select * into latest_success from public.discovery_runs where workflow = 'source_graph_qwen' and status = 'succeeded' order by finished_at desc limit 1;
  select * into health_row from public.pipeline_controller_health order by updated_at desc limit 1;
  select count(*) into active_sources from public.source_registry where active and review_status = 'ready' and source_type in ('rss','blog','official_announcements','x_account');
  select min(ingestion_next_eligible_at) into next_run from public.source_registry where active and review_status = 'ready' and ingestion_next_eligible_at is not null;
  if settings_row.enabled and next_run is null then next_run := date_trunc('minute', now()) + interval '1 minute'; end if;
  select count(*) filter (where status = 'queued'), count(*) filter (where status in ('claimed','running')) into queued_jobs, generating_jobs from public.pipeline_jobs where job_type = 'generate_pitch';
  select count(*) into ready_pitches from public.hermes_story_proposals where writer_backend = 'qwen' and status = 'pitch_ready';
  select count(*) into failed_pitches from public.hermes_story_proposals where writer_backend = 'qwen' and status = 'failed';
  generated_pitches := ready_pitches;
  with errors as (
    (select finished_at as at, 'discovery' as kind, error as message from public.discovery_runs where workflow = 'source_graph_qwen' and status = 'failed' and error is not null order by finished_at desc limit 5)
    union all
    (select updated_at, 'qwen_pitch', coalesce(error ->> 'message', error::text) from public.hermes_story_proposals where writer_backend = 'qwen' and status = 'failed' order by updated_at desc limit 5)
    union all
    (select finished_at, 'generate_pitch_job', coalesce(error ->> 'message', error::text) from public.pipeline_jobs where job_type = 'generate_pitch' and status = 'failed' order by finished_at desc limit 5)
  )
  select coalesce(jsonb_agg(jsonb_build_object('at', at, 'kind', kind, 'message', message) order by at desc), '[]'::jsonb) into recent_failures from errors;
  return jsonb_build_object(
    'settings', to_jsonb(settings_row),
    'enabled', coalesce(settings_row.enabled, false),
    'last_attempted_run', case when latest_run.id is null then null else to_jsonb(latest_run) end,
    'last_successful_run', case when latest_success.id is null then null else to_jsonb(latest_success) end,
    'next_scheduled_at', next_run,
    'sources_active', active_sources,
    'queued_pitch_jobs', queued_jobs,
    'generating_pitch_jobs', generating_jobs,
    'pitches_generated', generated_pitches,
    'pitches_failed', failed_pitches,
    'controller', case when health_row.controller_id is null then null else to_jsonb(health_row) || jsonb_build_object('stale', health_row.updated_at < now() - interval '3 minutes') end,
    'recent_failures', recent_failures
  );
end;
$$;

revoke all on function public.start_source_graph_discovery_run(text, uuid) from public, anon, authenticated;
revoke all on function public.finish_source_graph_discovery_run(uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.save_source_graph_discovery_settings(boolean, uuid) from public, anon, authenticated;
revoke all on function public.queue_hermes_story_proposals(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.queue_generate_pitch_jobs(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.begin_generate_pitch(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_generate_pitch(uuid, uuid, text, jsonb, jsonb, text, text, boolean) from public, anon, authenticated;
revoke all on function public.retry_generate_pitch(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_pipeline_controller_health(text, jsonb) from public, anon, authenticated;
revoke all on function public.get_source_graph_discovery_status() from public, anon, authenticated;
grant execute on function public.start_source_graph_discovery_run(text, uuid) to service_role;
grant execute on function public.finish_source_graph_discovery_run(uuid, text, jsonb, text) to service_role;
grant execute on function public.save_source_graph_discovery_settings(boolean, uuid) to service_role;
grant execute on function public.queue_hermes_story_proposals(timestamptz, integer) to service_role;
grant execute on function public.queue_generate_pitch_jobs(timestamptz, integer) to service_role;
grant execute on function public.begin_generate_pitch(uuid, uuid, text) to service_role;
grant execute on function public.finish_generate_pitch(uuid, uuid, text, jsonb, jsonb, text, text, boolean) to service_role;
grant execute on function public.retry_generate_pitch(uuid, uuid) to service_role;
grant execute on function public.record_pipeline_controller_health(text, jsonb) to service_role;
grant execute on function public.get_source_graph_discovery_status() to service_role;

comment on table public.source_graph_discovery_settings is 'Canonical scheduled Source Graph discovery controls. The Worker ingests and scores; the local controller only handles Qwen pitch jobs.';
comment on table public.pipeline_controller_health is 'Last durable heartbeat from the persistent local controller. A stale row is not a healthy worker.';
comment on column public.hermes_story_proposals.deterministic_score is 'Bounded Source Graph score computed without a model before a Qwen job is created.';

commit;
