-- Phase 2 Terra evidence offsets are a versioned contract boundary. This
-- migration is additive and is intentionally not applied by local commands.
alter table public.pipeline_phase2_artifacts
  add column if not exists terra_evidence_contract_version text;

create or replace function public.persist_pipeline_phase2_stage_v2(
  p_candidate_external_id text,
  p_pipeline_run_id uuid,
  p_pipeline_version text,
  p_terra_evidence_contract_version text,
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
  if p_terra_evidence_contract_version <> 'terra-evidence-offsets-v1' then
    raise exception 'Unsupported Terra evidence contract version';
  end if;
  select id into candidate_ref from public.candidate_stories where external_id = p_candidate_external_id;
  if candidate_ref is null then raise exception 'Candidate external id was not found'; end if;
  insert into public.pipeline_runs(id, candidate_id, model, status, started_at)
  values (p_pipeline_run_id, candidate_ref, 'pipeline-v1', 'running', now())
  on conflict (id) do nothing;
  insert into public.pipeline_phase2_artifacts(candidate_id, pipeline_run_id, pipeline_version, terra_evidence_contract_version, stage, packet_checksum, payload, claims, usage, cost)
  values (candidate_ref, p_pipeline_run_id, p_pipeline_version, p_terra_evidence_contract_version, p_stage, p_packet_checksum, coalesce(p_payload, '{}'::jsonb), coalesce(p_claims, '[]'::jsonb), coalesce(p_usage, '[]'::jsonb), coalesce(p_cost, '{}'::jsonb))
  on conflict (candidate_id, pipeline_run_id, stage) do update set
    pipeline_version = excluded.pipeline_version,
    terra_evidence_contract_version = excluded.terra_evidence_contract_version,
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
  return jsonb_build_object('id', result_row.id, 'candidate_id', result_row.candidate_id, 'pipeline_run_id', result_row.pipeline_run_id, 'pipeline_version', result_row.pipeline_version, 'terra_evidence_contract_version', result_row.terra_evidence_contract_version, 'stage', result_row.stage, 'packet_checksum', result_row.packet_checksum, 'updated_at', result_row.updated_at);
end;
$$;

revoke all on function public.persist_pipeline_phase2_stage_v2(text, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.persist_pipeline_phase2_stage_v2(text, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb) to service_role;
