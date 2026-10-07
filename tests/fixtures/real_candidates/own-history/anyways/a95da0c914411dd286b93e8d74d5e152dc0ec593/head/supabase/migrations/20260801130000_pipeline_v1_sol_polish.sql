-- Pipeline V1 additive controls. Apply only after the four existing Phase 2
-- migrations, in timestamp order. This migration is not applied in this task.
begin;

alter table public.pipeline_review_decisions
  drop constraint if exists pipeline_review_decisions_action_check;
alter table public.pipeline_review_decisions
  add constraint pipeline_review_decisions_action_check
  check (action in ('approve','reject','request_revision','archive','edit','resolve_claim','remove_source','select_image','reject_image','materialize','polish_with_sol','sol_polish_accept','sol_polish_reject','sol_polish_restore','research_again'));

create table if not exists public.pipeline_sol_polish_artifacts (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_stories(id) on delete cascade,
  pipeline_run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  pipeline_version text not null check (pipeline_version = 'pipeline-v1'),
  authorization_id uuid not null unique,
  original_headline text not null,
  original_dek text not null,
  original_body_markdown text not null,
  polished_headline text not null,
  polished_dek text not null,
  polished_body_markdown text not null,
  changes jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  packet_checksum text,
  draft_checksum text not null,
  polish_checksum text not null,
  model text not null,
  reasoning text not null,
  usage jsonb,
  cost numeric,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','restored')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  acted_by uuid references public.profiles(id),
  acted_at timestamptz,
  action_note text,
  updated_at timestamptz not null default now()
);

create index if not exists pipeline_sol_polish_candidate_idx
  on public.pipeline_sol_polish_artifacts(candidate_id, created_at desc);

alter table public.pipeline_sol_polish_artifacts enable row level security;
drop policy if exists "editors read Sol polish artifacts" on public.pipeline_sol_polish_artifacts;
create policy "editors read Sol polish artifacts"
  on public.pipeline_sol_polish_artifacts for select to authenticated using (public.is_editor());

create or replace function public.editorial_pitch_is_valid(p_classification jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog, public as $$
declare
  pitch jsonb := p_classification -> 'editorial_pitch';
  tests jsonb;
  rationales jsonb;
  evidence jsonb;
begin
  if jsonb_typeof(p_classification) is distinct from 'object'
     or jsonb_typeof(pitch) is distinct from 'object'
     or jsonb_typeof(pitch -> 'accepted') is distinct from 'boolean'
     or (pitch ->> 'accepted')::boolean is not true
     or coalesce(p_classification ->> 'primary_section', '') not in ('internet','taste','systems','modern-life','builders','media')
     or coalesce(p_classification ->> 'story_form', '') not in ('meanwhile','while-youre-here','worth-your-time','receipts','anyways','we-read-it','builders','systems')
     or pitch ->> 'primary_section' is distinct from p_classification ->> 'primary_section'
     or pitch ->> 'story_form' is distinct from p_classification ->> 'story_form'
     or (p_classification ->> 'pipeline_version' = 'pipeline-v1' and coalesce(pitch ->> 'research_requirement', '') not in ('none','required'))
     or jsonb_typeof(pitch -> 'headline') is distinct from 'string' or length(btrim(pitch ->> 'headline')) not between 1 and 140
     or jsonb_typeof(pitch -> 'lens') is distinct from 'string' or length(btrim(pitch ->> 'lens')) not between 45 and 420
     or jsonb_typeof(pitch -> 'section_answer') is distinct from 'string' or length(btrim(pitch ->> 'section_answer')) not between 35 and 420
     or jsonb_typeof(pitch -> 'why_now') is distinct from 'string' or length(btrim(pitch ->> 'why_now')) not between 35 and 420
     or jsonb_typeof(pitch -> 'reader_takeaway') is distinct from 'string' or length(btrim(pitch ->> 'reader_takeaway')) not between 25 and 320
     or jsonb_typeof(pitch -> 'significance_tests') is distinct from 'array'
     or jsonb_typeof(pitch -> 'significance_rationales') is distinct from 'object'
     or jsonb_typeof(pitch -> 'evidence_plan') is distinct from 'array'
     or nullif(btrim(pitch ->> 'prompt_version'), '') is null then
    return false;
  end if;
  tests := pitch -> 'significance_tests';
  rationales := pitch -> 'significance_rationales';
  evidence := pitch -> 'evidence_plan';
  if jsonb_array_length(tests) < 2
     or jsonb_array_length(tests) <> (select count(distinct value) from jsonb_array_elements_text(tests))
     or (select count(*) from jsonb_object_keys(rationales)) <> jsonb_array_length(tests)
     or exists (
       select 1 from jsonb_array_elements_text(tests) test
       where test not in ('changes what people can do','changes what people want','changes who has power','reveals a hidden system','explains how attention moves','shows how online culture affects reality','reveals a new way to build something','explains why a person, company, movement, or object matters','reflects a broader cultural change','helps readers understand the modern world differently')
          or jsonb_typeof(rationales -> test) is distinct from 'string'
          or length(btrim(rationales ->> test)) < 24
     )
     or exists (select 1 from jsonb_object_keys(rationales) key where not tests ? key)
     or jsonb_array_length(evidence) not between 2 and 5
     or exists (select 1 from jsonb_array_elements(evidence) item where jsonb_typeof(item) is distinct from 'string' or length(btrim(item #>> '{}')) < 20 or btrim(item #>> '{}') ~* '^(look for|find|research|sources?|evidence|examples?)\M')
     or jsonb_array_length(evidence) <> (select count(distinct lower(btrim(value))) from jsonb_array_elements_text(evidence)) then
    return false;
  end if;
  if (pitch ->> 'story_form') in ('receipts','anyways','systems','we-read-it')
     and not exists (select 1 from jsonb_array_elements_text(evidence) item where item ~* '\m(document|filing|law|regulation|dataset|report|record|transcript|court|policy|official|primary source)\M') then
    return false;
  end if;
  return true;
exception when others then
  return false;
end $$;

create or replace function public.persist_pipeline_sol_polish(
  p_candidate_external_id text,
  p_pipeline_run_id uuid,
  p_pipeline_version text,
  p_authorization_id uuid,
  p_original_headline text,
  p_original_dek text,
  p_original_body_markdown text,
  p_polished_headline text,
  p_polished_dek text,
  p_polished_body_markdown text,
  p_changes jsonb,
  p_warnings jsonb,
  p_packet_checksum text,
  p_draft_checksum text,
  p_polish_checksum text,
  p_model text,
  p_reasoning text,
  p_usage jsonb,
  p_cost numeric,
  p_actor uuid default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare candidate_ref uuid; artifact public.pipeline_sol_polish_artifacts;
begin
  perform public.assert_pipeline_newsroom_service();
  if p_pipeline_version <> 'pipeline-v1' or p_authorization_id is null then raise exception using errcode = '23514', message = 'Sol polish requires a versioned authorization'; end if;
  select id into candidate_ref from public.candidate_stories where external_id = nullif(btrim(p_candidate_external_id), '');
  if candidate_ref is null then raise exception using errcode = 'P0002', message = 'Candidate external id was not found'; end if;
  insert into public.pipeline_sol_polish_artifacts(candidate_id,pipeline_run_id,pipeline_version,authorization_id,original_headline,original_dek,original_body_markdown,polished_headline,polished_dek,polished_body_markdown,changes,warnings,packet_checksum,draft_checksum,polish_checksum,model,reasoning,usage,cost,created_by)
  values(candidate_ref,p_pipeline_run_id,p_pipeline_version,p_authorization_id,p_original_headline,p_original_dek,p_original_body_markdown,p_polished_headline,p_polished_dek,p_polished_body_markdown,coalesce(p_changes,'[]'::jsonb),coalesce(p_warnings,'[]'::jsonb),p_packet_checksum,p_draft_checksum,p_polish_checksum,p_model,p_reasoning,p_usage,p_cost,p_actor)
  on conflict (authorization_id) do update set updated_at = now()
  returning * into artifact;
  return jsonb_build_object('id',artifact.id,'candidate_id',artifact.candidate_id,'pipeline_run_id',artifact.pipeline_run_id,'status',artifact.status,'packet_checksum',artifact.packet_checksum,'draft_checksum',artifact.draft_checksum,'polish_checksum',artifact.polish_checksum,'created_at',artifact.created_at);
end $$;

create or replace function public.commission_pipeline_v1_editorial_pitch(
  p_candidate_external_id text,
  p_priority integer default 50,
  p_requested_by uuid default null,
  p_research_requirement text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare submitted jsonb; job_id uuid;
begin
  if p_research_requirement is not null and p_research_requirement not in ('none','required') then raise exception using errcode='22023',message='research requirement must be none or required'; end if;
  submitted := public.commission_pipeline_v1_editorial_pitch(p_candidate_external_id,p_priority,p_requested_by);
  job_id := (submitted -> 'job' ->> 'id')::uuid;
  if p_research_requirement is not null then
    update public.candidate_stories
    set classification = jsonb_set(classification,'{editorial_pitch,research_requirement}',to_jsonb(p_research_requirement),true), updated_at=now()
    where external_id=p_candidate_external_id;
  end if;
  return submitted;
end $$;

create or replace function public.authorize_pipeline_v1_sol_polish(
  p_candidate_external_id text,
  p_priority integer default 50,
  p_requested_by uuid default null,
  p_pipeline_v1_enabled boolean default false
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare candidate public.candidate_stories%rowtype; active public.pipeline_jobs%rowtype; inserted public.pipeline_jobs%rowtype;
begin
  perform public.assert_pipeline_newsroom_service();
  if p_pipeline_v1_enabled is not true then raise exception using errcode = '23514', message = 'Pipeline V1 is disabled'; end if;
  if p_requested_by is null or not exists(select 1 from public.profiles where id = p_requested_by and role in ('admin','editor')) then raise exception using errcode = '42501', message = 'an editor account is required'; end if;
  select * into candidate from public.candidate_stories where external_id = nullif(btrim(p_candidate_external_id), '') for update;
  if not found or candidate.status <> 'ready_for_review' or candidate.classification ->> 'pipeline_version' <> 'pipeline-v1' or not public.editorial_pitch_is_valid(candidate.classification) then raise exception using errcode = '23514', message = 'only a retained V1 review package can be polished'; end if;
  select * into active from public.pipeline_jobs where job_type = 'polish_candidate' and status in ('queued','claimed','running') and parameters ->> 'candidate_id' = candidate.external_id limit 1;
  if found then return jsonb_build_object('job',to_jsonb(active),'duplicate',true); end if;
  insert into public.pipeline_jobs(job_type,parameters,source,priority,max_attempts,requested_by,pipeline_candidate_id)
  values('polish_candidate',jsonb_build_object('candidate_id',candidate.external_id,'pipeline_version','v1','authorization','polish_with_sol'),'newsroom',p_priority,1,p_requested_by,candidate.id)
  returning * into inserted;
  insert into public.pipeline_review_decisions(candidate_id,actor_id,action,note,previous_state,new_state,metadata)
  values(candidate.id,p_requested_by,'polish_with_sol','Editor authorized one manual Sol polish attempt.',candidate.status,candidate.status,jsonb_build_object('job_id',inserted.id));
  return jsonb_build_object('job',to_jsonb(inserted),'duplicate',false);
end $$;

create or replace function public.apply_pipeline_sol_polish_action(p_artifact_id uuid, p_action text, p_actor uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare artifact public.pipeline_sol_polish_artifacts; candidate public.candidate_stories%rowtype; current_draft public.pipeline_drafts%rowtype;
begin
  perform public.assert_pipeline_newsroom_service();
  if p_actor is null or not exists(select 1 from public.profiles where id=p_actor and role in ('admin','editor')) then raise exception using errcode='42501',message='an editor account is required'; end if;
  if p_action not in ('accept','reject','restore') then raise exception using errcode='22023',message='unsupported Sol polish action'; end if;
  select * into artifact from public.pipeline_sol_polish_artifacts where id=p_artifact_id for update;
  if not found then raise exception using errcode='P0002',message='Sol polish artifact was not found'; end if;
  select * into candidate from public.candidate_stories where id=artifact.candidate_id for update;
  if artifact.status <> 'pending' and p_action <> 'restore' then raise exception using errcode='23514',message='Sol polish artifact is no longer pending'; end if;
  if p_action in ('accept','restore') then
    select * into current_draft from public.pipeline_drafts where candidate_id=artifact.candidate_id and pipeline_run_id=artifact.pipeline_run_id order by version desc limit 1 for update;
    if not found then raise exception using errcode='P0002',message='The original Draft was not found'; end if;
    update public.pipeline_drafts
    set headline=case when p_action='accept' then artifact.polished_headline else artifact.original_headline end,
        dek=case when p_action='accept' then artifact.polished_dek else artifact.original_dek end,
        body_markdown=case when p_action='accept' then artifact.polished_body_markdown else artifact.original_body_markdown end
    where id=current_draft.id;
  end if;
  update public.pipeline_sol_polish_artifacts set status=case p_action when 'accept' then 'accepted' when 'reject' then 'rejected' else 'restored' end,acted_by=p_actor,acted_at=now(),action_note=p_note where id=artifact.id;
  insert into public.pipeline_review_decisions(candidate_id,actor_id,action,note,previous_state,new_state,metadata)
  values(candidate.id,p_actor,case p_action when 'accept' then 'sol_polish_accept' when 'reject' then 'sol_polish_reject' else 'sol_polish_restore' end,coalesce(p_note,'Sol polish action recorded.'),candidate.status,candidate.status,jsonb_build_object('artifact_id',artifact.id,'draft_id',current_draft.id));
  return jsonb_build_object('artifact_id',artifact.id,'status',case p_action when 'accept' then 'accepted' when 'reject' then 'rejected' else 'restored' end,'draft_id',current_draft.id);
end $$;

revoke all on function public.persist_pipeline_sol_polish(text,uuid,text,uuid,text,text,text,text,text,text,jsonb,jsonb,text,text,text,text,text,jsonb,numeric,uuid) from public, anon, authenticated;
grant execute on function public.persist_pipeline_sol_polish(text,uuid,text,uuid,text,text,text,text,text,text,jsonb,jsonb,text,text,text,text,text,jsonb,numeric,uuid) to service_role;
revoke all on function public.authorize_pipeline_v1_sol_polish(text,integer,uuid,boolean) from public, anon, authenticated;
grant execute on function public.authorize_pipeline_v1_sol_polish(text,integer,uuid,boolean) to service_role;
revoke all on function public.commission_pipeline_v1_editorial_pitch(text,integer,uuid,text) from public, anon, authenticated;
grant execute on function public.commission_pipeline_v1_editorial_pitch(text,integer,uuid,text) to service_role;
revoke all on function public.apply_pipeline_sol_polish_action(uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.apply_pipeline_sol_polish_action(uuid,text,uuid,text) to service_role;

commit;
