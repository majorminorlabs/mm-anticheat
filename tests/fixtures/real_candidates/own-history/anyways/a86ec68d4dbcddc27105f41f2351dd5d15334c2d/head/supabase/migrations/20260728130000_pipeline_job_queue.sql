-- Durable, controller-only queue for the existing local content pipeline.
-- It is additive: it neither creates stories nor changes candidate/editorial workflow.
begin;

create type public.pipeline_job_type as enum (
  'discover',
  'process_candidate',
  'retry_run',
  'sync_candidate',
  'health_check'
);

create type public.pipeline_job_status as enum (
  'queued', 'claimed', 'running', 'completed', 'failed', 'cancelled'
);

create table public.pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type public.pipeline_job_type not null,
  parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
  source text not null default 'controller' check (source in ('controller', 'cli', 'scheduled', 'newsroom', 'hermes')),
  requested_by uuid references public.profiles(id) on delete set null,
  priority integer not null default 50 check (priority between 0 and 100),
  status public.pipeline_job_status not null default 'queued',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  lease_owner text,
  lease_expires_at timestamptz,
  cancellation_requested_at timestamptz,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_heartbeat_at timestamptz,
  not_before timestamptz not null default now(),
  result jsonb,
  error jsonb,
  summary_log text not null default '',
  pipeline_candidate_id uuid references public.candidate_stories(id) on delete set null,
  pipeline_run_id uuid references public.pipeline_runs(id) on delete set null,
  check ((job_type in ('process_candidate', 'sync_candidate') and (parameters ? 'candidate_id')) or job_type not in ('process_candidate', 'sync_candidate')),
  check ((job_type = 'retry_run' and (parameters ? 'run_id')) or job_type <> 'retry_run')
);

create table public.pipeline_job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.pipeline_jobs(id) on delete cascade,
  at timestamptz not null default now(),
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  event_type text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')
);

create table public.pipeline_resource_locks (
  name text primary key,
  lease_owner text,
  job_id uuid references public.pipeline_jobs(id) on delete set null,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.pipeline_resource_locks(name) values ('heavy_model') on conflict do nothing;

create index pipeline_jobs_claim_idx on public.pipeline_jobs(status, not_before, priority desc, created_at);
create index pipeline_jobs_lease_idx on public.pipeline_jobs(lease_expires_at) where status in ('claimed', 'running');
create index pipeline_jobs_candidate_idx on public.pipeline_jobs(pipeline_candidate_id, created_at desc) where pipeline_candidate_id is not null;
create index pipeline_job_events_job_idx on public.pipeline_job_events(job_id, at);

alter table public.pipeline_jobs enable row level security;
alter table public.pipeline_job_events enable row level security;
alter table public.pipeline_resource_locks enable row level security;
create policy "editors read pipeline jobs" on public.pipeline_jobs for select to authenticated using(public.is_editor());
create policy "editors read pipeline job events" on public.pipeline_job_events for select to authenticated using(public.is_editor());

create or replace function public.assert_pipeline_controller()
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'pipeline controller service role is required';
  end if;
end $$;

create or replace function public.submit_pipeline_job(
  p_job_type public.pipeline_job_type,
  p_parameters jsonb default '{}'::jsonb,
  p_source text default 'cli',
  p_priority integer default 50,
  p_max_attempts integer default 3,
  p_requested_by uuid default null
) returns public.pipeline_jobs language plpgsql security definer set search_path = pg_catalog, public as $$
declare inserted public.pipeline_jobs%rowtype;
begin
  perform public.assert_pipeline_controller();
  if jsonb_typeof(p_parameters) <> 'object' then raise exception using errcode = '22023', message = 'job parameters must be a JSON object'; end if;
  insert into public.pipeline_jobs(job_type, parameters, source, priority, max_attempts, requested_by)
  values (p_job_type, p_parameters, p_source, p_priority, p_max_attempts, p_requested_by)
  returning * into inserted;
  insert into public.pipeline_job_events(job_id, level, event_type, message) values (inserted.id, 'info', 'submitted', 'Job submitted to durable queue.');
  return inserted;
end $$;

create or replace function public.claim_next_pipeline_job(p_lease_owner text, p_lease_seconds integer default 120)
returns public.pipeline_jobs language plpgsql security definer set search_path = pg_catalog, public as $$
declare claimed public.pipeline_jobs%rowtype;
begin
  perform public.assert_pipeline_controller();
  if nullif(btrim(p_lease_owner), '') is null then raise exception using errcode = '22023', message = 'lease owner is required'; end if;
  if p_lease_seconds not between 30 and 900 then raise exception using errcode = '22023', message = 'lease duration must be 30 to 900 seconds'; end if;
  with next_job as (
    select id from public.pipeline_jobs
    where status = 'queued' and not_before <= now() and cancellation_requested_at is null
    order by priority desc, created_at asc
    for update skip locked limit 1
  )
  update public.pipeline_jobs job set status = 'claimed', attempt_count = job.attempt_count + 1,
    lease_owner = p_lease_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    claimed_at = now(), last_heartbeat_at = now(), error = null
  from next_job where job.id = next_job.id returning job.* into claimed;
  if found then insert into public.pipeline_job_events(job_id, level, event_type, message, metadata) values (claimed.id, 'info', 'claimed', 'Job claimed by controller.', jsonb_build_object('lease_owner', p_lease_owner, 'attempt', claimed.attempt_count)); end if;
  return claimed;
end $$;

create or replace function public.heartbeat_pipeline_job(p_job_id uuid, p_lease_owner text, p_lease_seconds integer default 120)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.assert_pipeline_controller();
  update public.pipeline_jobs set lease_expires_at = now() + make_interval(secs => p_lease_seconds), last_heartbeat_at = now()
  where id = p_job_id and lease_owner = p_lease_owner and status in ('claimed', 'running') and cancellation_requested_at is null;
  return found;
end $$;

create or replace function public.start_pipeline_job(p_job_id uuid, p_lease_owner text)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.assert_pipeline_controller();
  update public.pipeline_jobs set status = 'running', started_at = coalesce(started_at, now())
  where id = p_job_id and lease_owner = p_lease_owner and status = 'claimed' and cancellation_requested_at is null;
  if found then insert into public.pipeline_job_events(job_id, level, event_type, message) values (p_job_id, 'info', 'started', 'Pipeline child process started.'); end if;
  return found;
end $$;

create or replace function public.complete_pipeline_job(p_job_id uuid, p_lease_owner text, p_result jsonb, p_summary_log text default '')
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.assert_pipeline_controller();
  update public.pipeline_jobs set status = 'completed', result = p_result, error = null, summary_log = left(coalesce(p_summary_log, ''), 12000),
    finished_at = now(), lease_owner = null, lease_expires_at = null
  where id = p_job_id and lease_owner = p_lease_owner and status in ('claimed', 'running') and cancellation_requested_at is null;
  if found then insert into public.pipeline_job_events(job_id, level, event_type, message) values (p_job_id, 'info', 'completed', 'Job completed.'); end if;
  return found;
end $$;

create or replace function public.fail_pipeline_job(p_job_id uuid, p_lease_owner text, p_error jsonb, p_summary_log text default '', p_retry_delay_seconds integer default 60)
returns public.pipeline_jobs language plpgsql security definer set search_path = pg_catalog, public as $$
declare updated public.pipeline_jobs%rowtype; should_retry boolean;
begin
  perform public.assert_pipeline_controller();
  select coalesce((p_error ->> 'retryable')::boolean, false) into should_retry;
  update public.pipeline_jobs job set
    status = case when should_retry and job.attempt_count < job.max_attempts and job.cancellation_requested_at is null then 'queued'::public.pipeline_job_status else 'failed'::public.pipeline_job_status end,
    error = p_error, summary_log = left(coalesce(p_summary_log, ''), 12000),
    not_before = case when should_retry and job.attempt_count < job.max_attempts and job.cancellation_requested_at is null then now() + make_interval(secs => greatest(1, p_retry_delay_seconds)) else job.not_before end,
    finished_at = case when should_retry and job.attempt_count < job.max_attempts and job.cancellation_requested_at is null then null else now() end,
    lease_owner = null, lease_expires_at = null
  where job.id = p_job_id and job.lease_owner = p_lease_owner and job.status in ('claimed', 'running') returning job.* into updated;
  if found then insert into public.pipeline_job_events(job_id, level, event_type, message, metadata) values (p_job_id, 'error', case when updated.status = 'queued' then 'retry_scheduled' else 'failed' end, coalesce(p_error ->> 'message', 'Job failed.'), p_error); end if;
  return updated;
end $$;

create or replace function public.request_pipeline_job_cancellation(p_job_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.assert_pipeline_controller();
  update public.pipeline_jobs set cancellation_requested_at = now(),
    status = case when status = 'queued' then 'cancelled'::public.pipeline_job_status else status end,
    finished_at = case when status = 'queued' then now() else finished_at end
  where id = p_job_id and status in ('queued', 'claimed', 'running');
  if found then insert into public.pipeline_job_events(job_id, level, event_type, message) values (p_job_id, 'warn', 'cancellation_requested', 'Cancellation requested.'); end if;
  return found;
end $$;

create or replace function public.cancel_pipeline_job(p_job_id uuid, p_lease_owner text, p_summary_log text default '')
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.assert_pipeline_controller();
  update public.pipeline_jobs set status = 'cancelled', summary_log = left(coalesce(p_summary_log, ''), 12000), finished_at = now(), lease_owner = null, lease_expires_at = null
  where id = p_job_id and lease_owner = p_lease_owner and status in ('claimed', 'running') and cancellation_requested_at is not null;
  if found then insert into public.pipeline_job_events(job_id, level, event_type, message) values (p_job_id, 'warn', 'cancelled', 'Job cancelled by controller.'); end if;
  return found;
end $$;

create or replace function public.release_expired_pipeline_job_leases()
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare released integer;
begin
  perform public.assert_pipeline_controller();
  with stale as (
    update public.pipeline_jobs set status = case when attempt_count < max_attempts and cancellation_requested_at is null then 'queued'::public.pipeline_job_status else case when cancellation_requested_at is not null then 'cancelled'::public.pipeline_job_status else 'failed'::public.pipeline_job_status end end,
      finished_at = case when attempt_count < max_attempts and cancellation_requested_at is null then null else now() end,
      lease_owner = null, lease_expires_at = null, not_before = now(), error = jsonb_build_object('code', 'LEASE_EXPIRED', 'message', 'Controller lease expired before completion.', 'retryable', true)
    where status in ('claimed', 'running') and lease_expires_at < now()
    returning id
  ) select count(*) into released from stale;
  return released;
end $$;

create or replace function public.append_pipeline_job_event(p_job_id uuid, p_level text, p_event_type text, p_message text, p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.assert_pipeline_controller();
  insert into public.pipeline_job_events(job_id, level, event_type, message, metadata)
  values (p_job_id, p_level, p_event_type, left(p_message, 4000), p_metadata);
end $$;

create or replace function public.acquire_pipeline_resource_lock(p_name text, p_lease_owner text, p_job_id uuid, p_lease_seconds integer default 120)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.assert_pipeline_controller();
  update public.pipeline_resource_locks set lease_owner = p_lease_owner, job_id = p_job_id, lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where name = p_name and (lease_expires_at is null or lease_expires_at < now() or lease_owner = p_lease_owner);
  return found;
end $$;

create or replace function public.release_pipeline_resource_lock(p_name text, p_lease_owner text, p_job_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.assert_pipeline_controller();
  update public.pipeline_resource_locks set lease_owner = null, job_id = null, lease_expires_at = null, updated_at = now()
  where name = p_name and lease_owner = p_lease_owner and job_id = p_job_id;
  return found;
end $$;

revoke all on function public.assert_pipeline_controller() from public, anon, authenticated;
revoke all on function public.submit_pipeline_job(public.pipeline_job_type, jsonb, text, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.claim_next_pipeline_job(text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_pipeline_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.start_pipeline_job(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_pipeline_job(uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.fail_pipeline_job(uuid, text, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.request_pipeline_job_cancellation(uuid) from public, anon, authenticated;
revoke all on function public.cancel_pipeline_job(uuid, text, text) from public, anon, authenticated;
revoke all on function public.release_expired_pipeline_job_leases() from public, anon, authenticated;
revoke all on function public.append_pipeline_job_event(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.acquire_pipeline_resource_lock(text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_pipeline_resource_lock(text, text, uuid) from public, anon, authenticated;
grant execute on function public.submit_pipeline_job(public.pipeline_job_type, jsonb, text, integer, integer, uuid) to service_role;
grant execute on function public.claim_next_pipeline_job(text, integer) to service_role;
grant execute on function public.heartbeat_pipeline_job(uuid, text, integer) to service_role;
grant execute on function public.start_pipeline_job(uuid, text) to service_role;
grant execute on function public.complete_pipeline_job(uuid, text, jsonb, text) to service_role;
grant execute on function public.fail_pipeline_job(uuid, text, jsonb, text, integer) to service_role;
grant execute on function public.request_pipeline_job_cancellation(uuid) to service_role;
grant execute on function public.cancel_pipeline_job(uuid, text, text) to service_role;
grant execute on function public.release_expired_pipeline_job_leases() to service_role;
grant execute on function public.append_pipeline_job_event(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.acquire_pipeline_resource_lock(text, text, uuid, integer) to service_role;
grant execute on function public.release_pipeline_resource_lock(text, text, uuid) to service_role;

commit;
