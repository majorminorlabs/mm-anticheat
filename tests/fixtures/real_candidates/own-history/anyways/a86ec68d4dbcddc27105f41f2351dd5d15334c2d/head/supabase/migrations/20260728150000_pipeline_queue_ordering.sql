-- Editor-controlled ordering for queued work. Running and claimed jobs remain immutable.
begin;

alter table public.pipeline_jobs add column if not exists priority_rank integer not null default 100 check (priority_rank in (0, 100, 200, 300));
alter table public.pipeline_jobs add column if not exists queue_position bigint not null default 0 check (queue_position >= 0);

update public.pipeline_jobs
set priority_rank = case when priority >= 90 then 300 when priority >= 70 then 200 when priority <= 25 then 0 else 100 end
where priority_rank = 100;

with ordered as (
  select id, row_number() over (partition by priority_rank order by created_at, id) * 1024 as position
  from public.pipeline_jobs where status = 'queued'
)
update public.pipeline_jobs job set queue_position = ordered.position from ordered where job.id = ordered.id;

create index if not exists pipeline_jobs_ordered_claim_idx
  on public.pipeline_jobs(status, not_before, priority_rank desc, queue_position asc, created_at asc)
  where status = 'queued';

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
    order by priority_rank desc, queue_position asc, created_at asc
    for update skip locked limit 1
  )
  update public.pipeline_jobs job set status = 'claimed', attempt_count = job.attempt_count + 1,
    lease_owner = p_lease_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    claimed_at = now(), last_heartbeat_at = now(), error = null
  from next_job where job.id = next_job.id returning job.* into claimed;
  if found then insert into public.pipeline_job_events(job_id, level, event_type, message, metadata) values (claimed.id, 'info', 'claimed', 'Job claimed by controller.', jsonb_build_object('lease_owner', p_lease_owner, 'attempt', claimed.attempt_count)); end if;
  return claimed;
end $$;

create or replace function public.reorder_newsroom_pipeline_job(p_job_id uuid, p_action text, p_priority text default null, p_requested_by uuid default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare target public.pipeline_jobs%rowtype; prior bigint; following bigint; rank_value integer; updated jsonb;
begin
  perform public.assert_pipeline_newsroom_service();
  if p_requested_by is null then raise exception using errcode = '22023', message = 'requester is required'; end if;
  if p_action not in ('next', 'up', 'down', 'bottom', 'priority') then raise exception using errcode = '22023', message = 'invalid queue action'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pipeline-queue-order', 0));
  select * into target from public.pipeline_jobs where id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'pipeline job was not found'; end if;
  if target.status <> 'queued' or target.cancellation_requested_at is not null then raise exception using errcode = '22023', message = 'only queued jobs can be reordered'; end if;
  if p_action = 'priority' then
    rank_value := case p_priority when 'urgent' then 300 when 'high' then 200 when 'normal' then 100 when 'low' then 0 else null end;
    if rank_value is null then raise exception using errcode = '22023', message = 'invalid priority'; end if;
    update public.pipeline_jobs set priority_rank = rank_value, priority = case rank_value when 300 then 100 when 200 then 75 when 100 then 50 else 0 end,
      queue_position = coalesce((select max(queue_position) + 1024 from public.pipeline_jobs where status = 'queued' and priority_rank = rank_value), 1024)
      where id = target.id;
  elsif p_action = 'next' then
    update public.pipeline_jobs set priority_rank = 300, priority = 100, queue_position = 0 where id = target.id;
  elsif p_action = 'bottom' then
    update public.pipeline_jobs set queue_position = coalesce((select max(queue_position) + 1024 from public.pipeline_jobs where status = 'queued' and priority_rank = target.priority_rank), 1024) where id = target.id;
  elsif p_action = 'up' then
    select queue_position into prior from public.pipeline_jobs where status = 'queued' and priority_rank = target.priority_rank and queue_position < target.queue_position order by queue_position desc limit 1;
    if prior is not null then update public.pipeline_jobs set queue_position = prior - 1 where id = target.id; end if;
  elsif p_action = 'down' then
    select queue_position into following from public.pipeline_jobs where status = 'queued' and priority_rank = target.priority_rank and queue_position > target.queue_position order by queue_position asc limit 1;
    if following is not null then update public.pipeline_jobs set queue_position = following + 1 where id = target.id; end if;
  end if;
  with ordered as (select id, row_number() over (partition by priority_rank order by queue_position, created_at, id) * 1024 as position from public.pipeline_jobs where status = 'queued')
  update public.pipeline_jobs job set queue_position = ordered.position from ordered where job.id = ordered.id;
  select to_jsonb(job) into updated from public.pipeline_jobs job where id = p_job_id;
  insert into public.pipeline_job_events(job_id, level, event_type, message, metadata) values (p_job_id, 'info', 'queue_reordered', 'Queue order changed from Newsroom.', jsonb_build_object('action', p_action, 'priority', p_priority, 'requested_by', p_requested_by));
  return updated;
end $$;

revoke all on function public.reorder_newsroom_pipeline_job(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.reorder_newsroom_pipeline_job(uuid, text, text, uuid) to service_role;

commit;
