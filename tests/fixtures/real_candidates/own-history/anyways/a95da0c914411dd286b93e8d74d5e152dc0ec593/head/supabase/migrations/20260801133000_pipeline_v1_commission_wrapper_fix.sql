-- Preserve the V1 commissioning side effects while disambiguating the
-- overloaded wrapper call introduced by the applied Sol-polish migration.
create or replace function public.commission_pipeline_v1_editorial_pitch(
  p_candidate_external_id text,
  p_priority integer default 50,
  p_requested_by uuid default null,
  p_research_requirement text default null
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare submitted jsonb; job_id uuid;
begin
  if p_research_requirement is not null and p_research_requirement not in ('none','required') then
    raise exception using errcode='22023', message='research requirement must be none or required';
  end if;

  submitted := public.commission_editorial_pitch(
    p_candidate_external_id::text,
    p_priority::integer,
    p_requested_by::uuid
  );
  job_id := (submitted -> 'job' ->> 'id')::uuid;

  if coalesce((submitted ->> 'duplicate')::boolean, false) then
    if not exists (
      select 1 from public.pipeline_jobs
      where id = job_id and parameters ->> 'pipeline_version' in ('v1', 'pipeline-v1')
    ) then
      raise exception using errcode = '23514', message = 'an existing legacy reporting job cannot be relabeled as Pipeline v1';
    end if;
    return submitted;
  end if;

  update public.pipeline_jobs
  set parameters = parameters || jsonb_build_object('pipeline_version', 'v1'), max_attempts = 1
  where id = job_id;

  update public.candidate_stories
  set classification = jsonb_set(
        classification || jsonb_build_object('pipeline_version', 'pipeline-v1', 'phase2_state', 'commissioned'),
        '{editorial_pitch,research_requirement}',
        to_jsonb(coalesce(p_research_requirement, classification -> 'editorial_pitch' ->> 'research_requirement')),
        true
      ),
      updated_at = now()
  where external_id = p_candidate_external_id;
  return submitted;
end $$;

revoke all on function public.commission_pipeline_v1_editorial_pitch(text,integer,uuid,text) from public, anon, authenticated;
grant execute on function public.commission_pipeline_v1_editorial_pitch(text,integer,uuid,text) to service_role;
