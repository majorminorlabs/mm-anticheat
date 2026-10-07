begin;

-- The two historical commission_pipeline_v1_editorial_pitch overloads returned
-- the pre-update legacy job JSON and were ambiguous to PostgREST. V1 callers
-- use this single, required-argument contract instead.
drop function if exists public.commission_pipeline_v1_editorial_pitch(text, integer, uuid);
drop function if exists public.commission_pipeline_v1_editorial_pitch(text, integer, uuid, text);

create or replace function public.commission_editorial_pitch_v1(
  p_candidate_external_id text,
  p_priority integer,
  p_requested_by uuid,
  p_research_requirement text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  candidate public.candidate_stories%rowtype;
  inserted public.pipeline_jobs%rowtype;
  active public.pipeline_jobs%rowtype;
  approved_requirement text;
begin
  perform public.assert_pipeline_newsroom_service();
  if p_requested_by is null or not exists (
    select 1 from public.profiles where id = p_requested_by and role in ('admin', 'editor')
  ) then
    raise exception using errcode = '42501', message = 'an editor account is required';
  end if;
  if p_priority not between 0 and 100 then
    raise exception using errcode = '22023', message = 'priority must be between 0 and 100';
  end if;
  if p_research_requirement is null or p_research_requirement not in ('none', 'required') then
    raise exception using errcode = '22023', message = 'research requirement must be none or required';
  end if;

  select * into candidate
  from public.candidate_stories
  where external_id = nullif(btrim(p_candidate_external_id), '')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'editorial pitch not found';
  end if;
  if candidate.status not in ('pitch_ready', 'researching', 'research_blocked', 'verification_failed')
     or not public.editorial_pitch_is_valid(candidate.classification) then
    raise exception using errcode = '23514', message = 'only a valid editor-approved pitch can begin reporting';
  end if;
  approved_requirement := nullif(candidate.classification -> 'editorial_pitch' ->> 'research_requirement', '');
  if approved_requirement is distinct from p_research_requirement then
    raise exception using errcode = '23514', message = 'research requirement must match the approved editorial pitch';
  end if;
  if candidate.status = 'researching' and not exists (
    select 1 from public.pipeline_jobs
    where id::text = candidate.classification -> 'editorial_pitch' ->> 'commissioned_job_id'
      and status in ('failed', 'cancelled')
  ) then
    raise exception using errcode = '23514', message = 'reporting is already active';
  end if;
  if candidate.status <> 'pitch_ready'
     and nullif(candidate.classification -> 'editorial_pitch' ->> 'commissioned_by', '') is null then
    raise exception using errcode = '23514', message = 'uncommissioned candidates cannot be retried';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('commission_editorial_pitch_v1:' || candidate.external_id, 0));
  select * into active
  from public.pipeline_jobs
  where job_type = 'process_candidate'
    and status in ('queued', 'claimed', 'running')
    and parameters ->> 'candidate_id' = candidate.external_id
  order by created_at asc
  limit 1;
  if found then
    if active.parameters ->> 'pipeline_version' <> 'v1' or active.max_attempts <> 1
       or active.parameters ->> 'research_requirement' <> p_research_requirement then
      raise exception using errcode = '23514', message = 'an existing legacy reporting job cannot be used for Pipeline V1';
    end if;
    return active.id;
  end if;

  insert into public.pipeline_jobs(
    job_type, parameters, source, priority, max_attempts, requested_by, pipeline_candidate_id
  ) values (
    'process_candidate',
    jsonb_build_object(
      'candidate_id', candidate.external_id,
      'pipeline_version', 'v1',
      'research_requirement', p_research_requirement
    ),
    'newsroom', p_priority, 1, p_requested_by, candidate.id
  ) returning * into inserted;

  update public.candidate_stories
  set classification = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(candidate.classification, '{editorial_pitch,commissioned_by}', to_jsonb(p_requested_by::text), true),
        '{editorial_pitch,commissioned_job_id}', to_jsonb(inserted.id::text), true
      ),
      '{editorial_pitch,processing_attempt}', '0'::jsonb, true
    ),
    '{pipeline_version}', '"pipeline-v1"'::jsonb, true
  ) || jsonb_build_object('phase2_state', 'commissioned'),
  updated_at = now()
  where id = candidate.id;

  insert into public.pipeline_review_decisions(
    candidate_id, actor_id, action, note, previous_state, new_state, metadata
  ) values (
    candidate.id, p_requested_by, 'edit',
    case when candidate.status = 'pitch_ready' then 'Pipeline V1 reporting commissioned from an approved pitch.' else 'Pipeline V1 reporting re-authorized for a previously failed commission.' end,
    candidate.status, candidate.status,
    jsonb_build_object('job_id', inserted.id, 'pipeline_version', 'v1', 'research_requirement', p_research_requirement)
  );
  insert into public.pipeline_job_events(job_id, level, event_type, message, metadata)
  values (
    inserted.id, 'info', 'submitted', 'Editor commissioned Pipeline V1 reporting.',
    jsonb_build_object('candidate_id', candidate.id, 'requested_by', p_requested_by, 'pipeline_version', 'v1')
  );
  return inserted.id;
end $$;

revoke all on function public.commission_editorial_pitch_v1(text, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.commission_editorial_pitch_v1(text, integer, uuid, text) to service_role;

commit;
