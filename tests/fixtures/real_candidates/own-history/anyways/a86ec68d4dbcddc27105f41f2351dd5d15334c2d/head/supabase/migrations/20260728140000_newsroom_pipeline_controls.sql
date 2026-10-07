-- Newsroom control surface for the existing controller queue. This migration
-- is additive: it creates no stories, publishing paths, or browser lease APIs.
begin;

alter table public.pipeline_sources add column if not exists external_id text;
alter table public.pipeline_sources add column if not exists default_section text references public.sections(id);
create unique index if not exists pipeline_sources_external_id_key
  on public.pipeline_sources(external_id) where external_id is not null;

-- The service creates at most one active discovery request and one active
-- candidate/run request for a particular target. Finished jobs stay retained.
create unique index if not exists pipeline_jobs_one_active_discovery
  on public.pipeline_jobs(job_type)
  where job_type = 'discover' and status in ('queued', 'claimed', 'running');
create unique index if not exists pipeline_jobs_one_active_candidate_action
  on public.pipeline_jobs(job_type, (parameters ->> 'candidate_id'))
  where job_type in ('process_candidate', 'sync_candidate')
    and status in ('queued', 'claimed', 'running');
create unique index if not exists pipeline_jobs_one_active_run_retry
  on public.pipeline_jobs(job_type, (parameters ->> 'run_id'))
  where job_type = 'retry_run' and status in ('queued', 'claimed', 'running');

create or replace function public.assert_pipeline_newsroom_service()
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'newsroom pipeline service role is required';
  end if;
end $$;

create or replace function public.submit_newsroom_pipeline_job(
  p_job_type public.pipeline_job_type,
  p_parameters jsonb default '{}'::jsonb,
  p_priority integer default 50,
  p_requested_by uuid default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  inserted public.pipeline_jobs%rowtype;
  active public.pipeline_jobs%rowtype;
  target text;
begin
  perform public.assert_pipeline_newsroom_service();
  if p_requested_by is null then raise exception using errcode = '22023', message = 'requester is required'; end if;
  if jsonb_typeof(p_parameters) <> 'object' then raise exception using errcode = '22023', message = 'job parameters must be an object'; end if;
  if p_priority not between 0 and 100 then raise exception using errcode = '22023', message = 'priority must be between 0 and 100'; end if;

  if p_job_type = 'discover' then
    if p_parameters <> '{}'::jsonb then raise exception using errcode = '22023', message = 'discovery does not accept parameters'; end if;
    target := 'discovery';
  elsif p_job_type = 'process_candidate' then
    target := nullif(btrim(p_parameters ->> 'candidate_id'), '');
    if target is null or (p_parameters - 'candidate_id') <> '{}'::jsonb
       or target !~* '^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$' then
      raise exception using errcode = '22023', message = 'a valid candidate identifier is required';
    end if;
  elsif p_job_type = 'retry_run' then
    target := nullif(btrim(p_parameters ->> 'run_id'), '');
    if target is null or (p_parameters - 'run_id') <> '{}'::jsonb
       or target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = 'a valid pipeline run identifier is required';
    end if;
  else
    raise exception using errcode = '22023', message = 'this job type is not available from the Newsroom';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_job_type::text || ':' || target, 0));
  select * into active from public.pipeline_jobs
  where job_type = p_job_type
    and status in ('queued', 'claimed', 'running')
    and ((p_job_type = 'discover') or parameters ->> case when p_job_type = 'retry_run' then 'run_id' else 'candidate_id' end = target)
  order by created_at asc limit 1;
  if found then return jsonb_build_object('job', to_jsonb(active), 'duplicate', true); end if;

  insert into public.pipeline_jobs(job_type, parameters, source, priority, max_attempts, requested_by)
  values (p_job_type, p_parameters, 'newsroom', p_priority, 3, p_requested_by)
  returning * into inserted;
  insert into public.pipeline_job_events(job_id, level, event_type, message, metadata)
  values (inserted.id, 'info', 'submitted', 'Newsroom job submitted to durable queue.', jsonb_build_object('requested_by', p_requested_by));
  return jsonb_build_object('job', to_jsonb(inserted), 'duplicate', false);
end $$;

create or replace function public.cancel_newsroom_pipeline_job(p_job_id uuid, p_requested_by uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare updated public.pipeline_jobs%rowtype;
begin
  perform public.assert_pipeline_newsroom_service();
  if p_requested_by is null then raise exception using errcode = '22023', message = 'requester is required'; end if;
  update public.pipeline_jobs set cancellation_requested_at = now(),
    status = case when status = 'queued' then 'cancelled'::public.pipeline_job_status else status end,
    finished_at = case when status = 'queued' then now() else finished_at end
  where id = p_job_id and status in ('queued', 'claimed', 'running')
  returning * into updated;
  if not found then raise exception using errcode = '22023', message = 'this job can no longer be cancelled'; end if;
  insert into public.pipeline_job_events(job_id, level, event_type, message, metadata)
  values (updated.id, 'warn', 'cancellation_requested', 'Cancellation requested from Newsroom.', jsonb_build_object('requested_by', p_requested_by));
  return to_jsonb(updated);
end $$;

create or replace function public.retry_newsroom_pipeline_job(p_job_id uuid, p_priority integer default 50, p_requested_by uuid default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare original public.pipeline_jobs%rowtype; submitted jsonb;
begin
  perform public.assert_pipeline_newsroom_service();
  select * into original from public.pipeline_jobs where id = p_job_id;
  if not found then raise exception using errcode = 'P0002', message = 'pipeline job was not found'; end if;
  if original.status <> 'failed' or original.job_type not in ('discover', 'process_candidate') then
    raise exception using errcode = '22023', message = 'this job is not eligible for retry';
  end if;
  submitted := public.submit_newsroom_pipeline_job(original.job_type, original.parameters, p_priority, p_requested_by);
  insert into public.pipeline_job_events(job_id, level, event_type, message, metadata)
  values (original.id, 'info', 'retry_submitted', 'A replacement Newsroom job was submitted.', jsonb_build_object('replacement_job_id', submitted -> 'job' ->> 'id', 'requested_by', p_requested_by));
  return submitted || jsonb_build_object('retry_of', original.id);
end $$;

revoke all on function public.assert_pipeline_newsroom_service() from public, anon, authenticated;
revoke all on function public.submit_newsroom_pipeline_job(public.pipeline_job_type, jsonb, integer, uuid) from public, anon, authenticated;
revoke all on function public.cancel_newsroom_pipeline_job(uuid, uuid) from public, anon, authenticated;
revoke all on function public.retry_newsroom_pipeline_job(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.submit_newsroom_pipeline_job(public.pipeline_job_type, jsonb, integer, uuid) to service_role;
grant execute on function public.cancel_newsroom_pipeline_job(uuid, uuid) to service_role;
grant execute on function public.retry_newsroom_pipeline_job(uuid, integer, uuid) to service_role;

commit;
