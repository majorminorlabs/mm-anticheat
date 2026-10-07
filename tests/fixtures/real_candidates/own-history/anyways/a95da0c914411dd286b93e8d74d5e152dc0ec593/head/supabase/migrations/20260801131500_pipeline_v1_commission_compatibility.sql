-- Compatibility repair for the applied Sol-polish migration.
-- The four-argument commissioning wrapper must call the canonical base RPC
-- directly because the three- and four-argument V1 wrappers overlap through
-- their default arguments.
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

  if p_research_requirement is not null then
    update public.candidate_stories
    set classification = jsonb_set(classification, '{editorial_pitch,research_requirement}', to_jsonb(p_research_requirement), true),
        updated_at = now()
    where external_id = p_candidate_external_id;
  end if;
  return submitted;
end $$;

revoke all on function public.commission_pipeline_v1_editorial_pitch(text,integer,uuid,text) from public, anon, authenticated;
grant execute on function public.commission_pipeline_v1_editorial_pitch(text,integer,uuid,text) to service_role;
