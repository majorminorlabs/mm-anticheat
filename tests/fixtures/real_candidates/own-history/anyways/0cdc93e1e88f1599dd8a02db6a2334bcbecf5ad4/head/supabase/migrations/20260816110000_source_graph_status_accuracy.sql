-- Keep the compact Newsroom operations surface truthful when a source is
-- already due or the controller has just completed its first queue poll.
begin;

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
  select min(ingestion_next_eligible_at) into next_run from public.source_registry where active and review_status = 'ready' and ingestion_next_eligible_at > now();
  if settings_row.enabled and (next_run is null or next_run <= now()) then next_run := date_trunc('minute', now()) + interval '1 minute'; end if;
  if not coalesce(settings_row.enabled, false) then next_run := null; end if;
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

grant execute on function public.get_source_graph_discovery_status() to service_role;

commit;
