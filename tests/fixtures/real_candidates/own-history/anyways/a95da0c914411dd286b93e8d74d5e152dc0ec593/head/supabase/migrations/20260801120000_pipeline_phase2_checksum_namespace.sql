-- Additive Phase 2 checksum namespace. This migration is validation-only in
-- this task and is not applied by local commands or the controller.
alter table public.pipeline_phase2_artifacts
  add column if not exists holdout_run_id text,
  add column if not exists case_run_id text,
  add column if not exists phase2_inventory_contract_version text,
  add column if not exists readiness_inventory_sha256 text,
  add column if not exists runtime_inventory_sha256 text,
  add column if not exists terra_input_packet_sha256 text,
  add column if not exists frozen_evidence_packet_sha256 text,
  add column if not exists draft_input_sha256 text,
  add column if not exists revision_input_sha256 text;

-- New callers use this additive RPC so the explicit identity and checksum
-- namespaces are persisted as columns. The v2 RPC remains for historical
-- compatibility and is not changed by this migration.
create or replace function public.persist_pipeline_phase2_stage_v3(
  p_candidate_external_id text,
  p_pipeline_run_id uuid,
  p_pipeline_version text,
  p_terra_evidence_contract_version text,
  p_phase2_inventory_contract_version text,
  p_stage text,
  p_holdout_run_id text,
  p_case_run_id text,
  p_readiness_inventory_sha256 text,
  p_runtime_inventory_sha256 text,
  p_terra_input_packet_sha256 text,
  p_frozen_evidence_packet_sha256 text,
  p_draft_input_sha256 text,
  p_revision_input_sha256 text,
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
  if p_case_run_id is null or p_case_run_id <> p_pipeline_run_id::text then
    raise exception 'Case run identity does not match pipeline run identity';
  end if;
  select id into candidate_ref from public.candidate_stories where external_id = p_candidate_external_id;
  if candidate_ref is null then raise exception 'Candidate external id was not found'; end if;
  insert into public.pipeline_runs(id, candidate_id, model, status, started_at)
  values (p_pipeline_run_id, candidate_ref, 'pipeline-v1', 'running', now())
  on conflict (id) do nothing;
  insert into public.pipeline_phase2_artifacts(
    candidate_id, pipeline_run_id, holdout_run_id, case_run_id,
    pipeline_version, terra_evidence_contract_version, phase2_inventory_contract_version, stage,
    readiness_inventory_sha256, runtime_inventory_sha256,
    terra_input_packet_sha256, frozen_evidence_packet_sha256,
    draft_input_sha256, revision_input_sha256,
    payload, claims, usage, cost
  )
  values (
    candidate_ref, p_pipeline_run_id, p_holdout_run_id, p_case_run_id,
    p_pipeline_version, p_terra_evidence_contract_version, p_phase2_inventory_contract_version, p_stage,
    p_readiness_inventory_sha256, p_runtime_inventory_sha256,
    p_terra_input_packet_sha256, p_frozen_evidence_packet_sha256,
    p_draft_input_sha256, p_revision_input_sha256,
    coalesce(p_payload, '{}'::jsonb), coalesce(p_claims, '[]'::jsonb),
    coalesce(p_usage, '[]'::jsonb), coalesce(p_cost, '{}'::jsonb)
  )
  on conflict (candidate_id, pipeline_run_id, stage) do update set
    holdout_run_id = excluded.holdout_run_id,
    case_run_id = excluded.case_run_id,
    pipeline_version = excluded.pipeline_version,
    terra_evidence_contract_version = excluded.terra_evidence_contract_version,
    phase2_inventory_contract_version = excluded.phase2_inventory_contract_version,
    readiness_inventory_sha256 = excluded.readiness_inventory_sha256,
    runtime_inventory_sha256 = excluded.runtime_inventory_sha256,
    terra_input_packet_sha256 = excluded.terra_input_packet_sha256,
    frozen_evidence_packet_sha256 = excluded.frozen_evidence_packet_sha256,
    draft_input_sha256 = excluded.draft_input_sha256,
    revision_input_sha256 = excluded.revision_input_sha256,
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
  return jsonb_build_object(
    'id', result_row.id,
    'candidate_id', result_row.candidate_id,
    'pipeline_run_id', result_row.pipeline_run_id,
    'holdout_run_id', result_row.holdout_run_id,
    'case_run_id', result_row.case_run_id,
    'stage', result_row.stage,
    'readiness_inventory_sha256', result_row.readiness_inventory_sha256,
    'runtime_inventory_sha256', result_row.runtime_inventory_sha256,
    'phase2_inventory_contract_version', result_row.phase2_inventory_contract_version,
    'terra_input_packet_sha256', result_row.terra_input_packet_sha256,
    'frozen_evidence_packet_sha256', result_row.frozen_evidence_packet_sha256,
    'draft_input_sha256', result_row.draft_input_sha256,
    'revision_input_sha256', result_row.revision_input_sha256,
    'updated_at', result_row.updated_at
  );
end;
$$;

revoke all on function public.persist_pipeline_phase2_stage_v3(text, uuid, text, text, text, text, text, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.persist_pipeline_phase2_stage_v3(text, uuid, text, text, text, text, text, text, text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb) to service_role;
