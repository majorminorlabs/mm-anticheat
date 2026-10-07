-- Phase 2 is additive. This migration is intentionally not applied by the
-- controller or local pipeline commands; deployment owns migration execution.
create table if not exists public.pipeline_phase2_artifacts (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_stories(id) on delete cascade,
  pipeline_run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  pipeline_version text not null check (pipeline_version = 'pipeline-v1'),
  stage text not null check (stage in ('source_inventory', 'research', 'evidence_packet', 'draft', 'revision', 'ai_review')),
  packet_checksum text,
  payload jsonb not null default '{}'::jsonb,
  claims jsonb not null default '[]'::jsonb,
  usage jsonb not null default '[]'::jsonb,
  cost jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(candidate_id, pipeline_run_id, stage)
);

create index if not exists pipeline_phase2_artifacts_candidate_run_idx
  on public.pipeline_phase2_artifacts(candidate_id, pipeline_run_id, stage);

alter table public.pipeline_phase2_artifacts enable row level security;
drop policy if exists "editors read phase2 pipeline artifacts" on public.pipeline_phase2_artifacts;
create policy "editors read phase2 pipeline artifacts"
  on public.pipeline_phase2_artifacts for select to authenticated using(public.is_editor());

create or replace function public.persist_pipeline_phase2_stage(
  p_candidate_external_id text,
  p_pipeline_run_id uuid,
  p_pipeline_version text,
  p_stage text,
  p_packet_checksum text,
  p_payload jsonb,
  p_claims jsonb,
  p_usage jsonb,
  p_cost jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result_row public.pipeline_phase2_artifacts;
declare candidate_ref uuid;
begin
  if p_pipeline_version <> 'pipeline-v1' then
    raise exception 'Unsupported Phase 2 pipeline version';
  end if;
  select id into candidate_ref from public.candidate_stories where external_id = p_candidate_external_id;
  if candidate_ref is null then raise exception 'Candidate external id was not found'; end if;
  insert into public.pipeline_runs(id, candidate_id, model, status, started_at)
  values (p_pipeline_run_id, candidate_ref, 'pipeline-v1', 'running', now())
  on conflict (id) do nothing;
  insert into public.pipeline_phase2_artifacts(candidate_id, pipeline_run_id, pipeline_version, stage, packet_checksum, payload, claims, usage, cost)
  values (candidate_ref, p_pipeline_run_id, p_pipeline_version, p_stage, p_packet_checksum, coalesce(p_payload, '{}'::jsonb), coalesce(p_claims, '[]'::jsonb), coalesce(p_usage, '[]'::jsonb), coalesce(p_cost, '{}'::jsonb))
  on conflict (candidate_id, pipeline_run_id, stage) do update set
    packet_checksum = excluded.packet_checksum,
    payload = excluded.payload,
    claims = excluded.claims,
    usage = excluded.usage,
    cost = excluded.cost,
    updated_at = now()
  returning * into result_row;
  update public.pipeline_runs
  set status = coalesce(nullif(p_payload ->> 'run_status', ''), status),
      finished_at = case when p_payload ->> 'run_status' in ('complete', 'blocked', 'failed') then now() else finished_at end
  where id = p_pipeline_run_id;
  return jsonb_build_object('id', result_row.id, 'candidate_id', result_row.candidate_id, 'pipeline_run_id', result_row.pipeline_run_id, 'pipeline_version', result_row.pipeline_version, 'stage', result_row.stage, 'packet_checksum', result_row.packet_checksum, 'updated_at', result_row.updated_at);
end;
$$;

revoke all on function public.persist_pipeline_phase2_stage(text, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.persist_pipeline_phase2_stage(text, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb) to service_role;
