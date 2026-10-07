-- Phase 2 authorization is additive. Apply only through the normal deployment
-- migration process; local pipeline commands intentionally do not apply SQL.

insert into public.pipeline_resource_locks(name)
values ('cloud_codex_generation')
on conflict (name) do nothing;

alter table public.pipeline_phase2_artifacts
  drop constraint if exists pipeline_phase2_artifacts_stage_check;
alter table public.pipeline_phase2_artifacts
  add constraint pipeline_phase2_artifacts_stage_check
  check (stage in ('source_inventory', 'research', 'evidence_packet', 'draft', 'draft_review', 'revision', 'revision_review', 'ai_review'));

create or replace function public.commission_pipeline_v1_editorial_pitch(
  p_candidate_external_id text,
  p_priority integer default 50,
  p_requested_by uuid default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare submitted jsonb; job_id uuid;
begin
  perform public.assert_pipeline_newsroom_service();
  submitted := public.commission_editorial_pitch(p_candidate_external_id, p_priority, p_requested_by);
  job_id := (submitted -> 'job' ->> 'id')::uuid;
  if coalesce((submitted ->> 'duplicate')::boolean, false) then
    if not exists(select 1 from public.pipeline_jobs where id = job_id and parameters ->> 'pipeline_version' in ('v1', 'pipeline-v1')) then
      raise exception using errcode = '23514', message = 'an existing legacy reporting job cannot be relabeled as Pipeline v1';
    end if;
    return submitted;
  end if;
  update public.pipeline_jobs
  set parameters = parameters || jsonb_build_object('pipeline_version', 'v1'), max_attempts = 1
  where id = job_id;
  update public.candidate_stories
  set classification = classification || jsonb_build_object('pipeline_version', 'pipeline-v1', 'phase2_state', 'commissioned'),
      updated_at = now()
  where external_id = p_candidate_external_id;
  return submitted;
end $$;

create or replace function public.research_again_pipeline_v1(
  p_candidate_external_id text,
  p_priority integer default 50,
  p_requested_by uuid default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare submitted jsonb; job_id uuid; current_status text;
begin
  perform public.assert_pipeline_newsroom_service();
  select status::text into current_status from public.candidate_stories where external_id = nullif(btrim(p_candidate_external_id), '');
  if current_status is distinct from 'research_blocked' then
    raise exception using errcode = '23514', message = 'research again requires a research-blocked candidate';
  end if;
  submitted := public.commission_editorial_pitch(p_candidate_external_id, p_priority, p_requested_by);
  job_id := (submitted -> 'job' ->> 'id')::uuid;
  if coalesce((submitted ->> 'duplicate')::boolean, false) then
    if not exists(select 1 from public.pipeline_jobs where id = job_id and parameters ->> 'pipeline_version' in ('v1', 'pipeline-v1') and parameters ->> 'authorization' = 'research_again') then
      raise exception using errcode = '23514', message = 'another reporting authorization is already active';
    end if;
    return submitted;
  end if;
  update public.pipeline_jobs
  set parameters = parameters || jsonb_build_object('pipeline_version', 'v1', 'authorization', 'research_again'), max_attempts = 1
  where id = job_id;
  update public.candidate_stories
  set classification = classification || jsonb_build_object('pipeline_version', 'pipeline-v1', 'phase2_state', 'commissioned'),
      updated_at = now()
  where external_id = p_candidate_external_id;
  insert into public.pipeline_review_decisions(candidate_id, actor_id, action, note, metadata)
  select id, p_requested_by, 'research_again', 'Editor authorized one new Phase 2 research attempt.', jsonb_build_object('job_id', job_id)
  from public.candidate_stories
  where external_id = p_candidate_external_id;
  return submitted;
end $$;

-- The historical revision authorization is retained only as a fail-closed
-- compatibility signature. Pipeline V1 ends after Draft and deterministic AI
-- Review; manual copy polish is the only approved post-Draft action.
drop function if exists public.authorize_pipeline_v1_revision(text, integer, uuid);

create or replace function public.authorize_pipeline_v1_revision(
  p_candidate_external_id text,
  p_priority integer default 50,
  p_requested_by uuid default null,
  p_revision_instructions text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  raise exception using errcode = '0A000', message = 'Pipeline V1 Luna Revision is retired; use manual Sol polish.';
end $$;

create or replace function public.retry_newsroom_pipeline_job(
  p_job_id uuid,
  p_priority integer default 50,
  p_requested_by uuid default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare original public.pipeline_jobs%rowtype; submitted jsonb;
begin
  perform public.assert_pipeline_newsroom_service();
  select * into original from public.pipeline_jobs where id = p_job_id;
  if not found then raise exception using errcode = 'P0002', message = 'pipeline job was not found'; end if;
  if original.status <> 'failed' or original.job_type not in ('discover','process_candidate') then
    raise exception using errcode = '22023', message = 'this job is not eligible for retry';
  end if;
  if original.job_type = 'process_candidate' and original.parameters ->> 'pipeline_version' in ('v1', 'pipeline-v1') then
    raise exception using errcode = '23514', message = 'Pipeline v1 jobs require an explicit research-again or revision authorization';
  end if;
  if original.job_type = 'process_candidate' then
    submitted := public.commission_editorial_pitch(original.parameters ->> 'candidate_id', p_priority, p_requested_by);
  else
    submitted := public.submit_newsroom_pipeline_job(original.job_type, original.parameters, p_priority, p_requested_by);
  end if;
  insert into public.pipeline_job_events(job_id, level, event_type, message, metadata)
  values(original.id, 'info', 'retry_submitted', 'A replacement Newsroom job was submitted.', jsonb_build_object('replacement_job_id', submitted -> 'job' ->> 'id', 'requested_by', p_requested_by));
  return submitted || jsonb_build_object('retry_of', original.id);
end $$;

revoke all on function public.commission_pipeline_v1_editorial_pitch(text, integer, uuid) from public, anon, authenticated;
revoke all on function public.research_again_pipeline_v1(text, integer, uuid) from public, anon, authenticated;
revoke all on function public.authorize_pipeline_v1_revision(text, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.commission_pipeline_v1_editorial_pitch(text, integer, uuid) to service_role;
grant execute on function public.research_again_pipeline_v1(text, integer, uuid) to service_role;
grant execute on function public.authorize_pipeline_v1_revision(text, integer, uuid, text) to service_role;
revoke all on function public.retry_newsroom_pipeline_job(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.retry_newsroom_pipeline_job(uuid, integer, uuid) to service_role;
