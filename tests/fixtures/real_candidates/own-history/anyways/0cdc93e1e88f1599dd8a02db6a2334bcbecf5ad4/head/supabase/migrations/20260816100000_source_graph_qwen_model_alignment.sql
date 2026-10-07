-- Align the durable Source Graph handoff with the model already configured
-- on the persistent Mac Studio controller. The controller still validates
-- model availability before claiming a heavy job.
begin;

alter table public.source_graph_discovery_settings
  add column if not exists qwen_model text not null default 'qwen3:30b'
    check (length(btrim(qwen_model)) between 1 and 160);

update public.source_graph_discovery_settings
set qwen_model = 'qwen3:30b', updated_at = now()
where id = 'default';

update public.pipeline_jobs
set parameters = jsonb_set(parameters, '{model}', to_jsonb('qwen3:30b'::text))
where job_type = 'generate_pitch'
  and parameters ->> 'model' = 'qwen3:14b';

create or replace function public.queue_generate_pitch_jobs(
  p_now timestamptz default now(),
  p_limit integer default 2
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  proposal public.hermes_story_proposals%rowtype;
  candidate public.candidate_stories%rowtype;
  inserted_job public.pipeline_jobs%rowtype;
  active_job public.pipeline_jobs%rowtype;
  settings_row public.source_graph_discovery_settings%rowtype;
  bounded_limit integer := least(greatest(coalesce(p_limit, 0), 0), 10);
  jobs_created integer := 0;
  candidate_external_id text;
  marker jsonb;
begin
  perform public.assert_pipeline_controller();
  select * into settings_row from public.source_graph_discovery_settings where id = 'default';
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
      jsonb_build_object('proposal_id', proposal.id, 'source_event_id', proposal.source_event_id, 'candidate_external_id', candidate_external_id, 'model', coalesce(settings_row.qwen_model, 'qwen3:30b'), 'prompt_version', 'editorial-pitch-gate-v3'),
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
  return jsonb_build_object('jobs_created', jobs_created, 'limit', bounded_limit, 'backend', 'qwen', 'model', coalesce(settings_row.qwen_model, 'qwen3:30b'));
end;
$$;

create or replace function public.retry_generate_pitch(
  p_proposal_id uuid,
  p_requested_by uuid
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  proposal public.hermes_story_proposals%rowtype;
  candidate public.candidate_stories%rowtype;
  inserted_job public.pipeline_jobs%rowtype;
  active_job public.pipeline_jobs%rowtype;
  settings_row public.source_graph_discovery_settings%rowtype;
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
  select * into settings_row from public.source_graph_discovery_settings where id = 'default';
  insert into public.pipeline_jobs(job_type, parameters, source, priority, max_attempts, requested_by, pipeline_candidate_id)
  values ('generate_pitch', jsonb_build_object('proposal_id', proposal.id, 'source_event_id', proposal.source_event_id, 'candidate_external_id', candidate.external_id, 'model', coalesce(settings_row.qwen_model, 'qwen3:30b'), 'prompt_version', 'editorial-pitch-gate-v3'), 'newsroom', 60, 3, p_requested_by, candidate.id)
  returning * into inserted_job;
  update public.hermes_story_proposals set status = 'queued', pipeline_job_id = inserted_job.id, error = null, completed_at = null, updated_at = now() where id = proposal.id;
  update public.candidate_stories set status = 'discovered'::public.pipeline_candidate_status, classification = coalesce(classification, '{}'::jsonb) || jsonb_build_object('discovery_enrichment', jsonb_build_object('status', 'queued', 'backend', 'qwen', 'retry_requested_by', p_requested_by, 'updated_at', now())), updated_at = now() where id = candidate.id;
  insert into public.pipeline_job_events(job_id, level, event_type, message, metadata) values (inserted_job.id, 'info', 'editor_retry', 'Editor retried a failed Qwen pitch.', jsonb_build_object('proposal_id', proposal.id, 'requested_by', p_requested_by));
  return jsonb_build_object('duplicate', false, 'status', 'queued', 'proposal_id', proposal.id, 'pipeline_job_id', inserted_job.id, 'model', coalesce(settings_row.qwen_model, 'qwen3:30b'));
end;
$$;

grant execute on function public.queue_generate_pitch_jobs(timestamptz, integer) to service_role;
grant execute on function public.retry_generate_pitch(uuid, uuid) to service_role;

comment on column public.source_graph_discovery_settings.qwen_model is 'Local model name used by generate_pitch jobs. It must match the persistent controller Ollama installation.';

commit;
