-- Candidate/run ownership is explicit. This repairs the one global-document
-- collision observed on 2026-07-28 without changing article text or publishing.
begin;

alter table public.discovered_documents add column if not exists pipeline_run_id uuid;
alter table public.discovered_documents add column if not exists retention jsonb not null default '{}'::jsonb;
alter table public.research_packets add column if not exists pipeline_run_id uuid;
alter table public.pipeline_drafts add column if not exists pipeline_run_id uuid;
alter table public.pipeline_claims add column if not exists candidate_id uuid;
alter table public.pipeline_claims add column if not exists pipeline_run_id uuid;
alter table public.image_candidates add column if not exists pipeline_run_id uuid;
alter table public.image_candidates add column if not exists source_document_id uuid;

-- Preserve historical artifacts by assigning each candidate's latest existing
-- pipeline run before making ownership mandatory.
insert into public.pipeline_runs (candidate_id, model, status, started_at, finished_at, artifact_path, error)
select owners.candidate_id, 'legacy-ownership-backfill', 'complete', now(), now(), 'legacy-ownership-backfill', null
from (
  select candidate_id from public.discovered_documents where candidate_id is not null
  union select candidate_id from public.research_packets
  union select candidate_id from public.pipeline_drafts
  union select candidate_id from public.image_candidates
) owners
where not exists (select 1 from public.pipeline_runs run where run.candidate_id = owners.candidate_id);

update public.discovered_documents document set pipeline_run_id = (select id from public.pipeline_runs run where run.candidate_id = document.candidate_id order by finished_at desc nulls last, started_at desc limit 1)
where document.pipeline_run_id is null and document.candidate_id is not null;
update public.research_packets packet set pipeline_run_id = (select id from public.pipeline_runs run where run.candidate_id = packet.candidate_id order by finished_at desc nulls last, started_at desc limit 1)
where packet.pipeline_run_id is null;
update public.pipeline_drafts draft set pipeline_run_id = (select id from public.pipeline_runs run where run.candidate_id = draft.candidate_id order by finished_at desc nulls last, started_at desc limit 1)
where draft.pipeline_run_id is null;
update public.pipeline_claims claim set candidate_id = draft.candidate_id, pipeline_run_id = draft.pipeline_run_id
from public.pipeline_drafts draft where claim.draft_id = draft.id and (claim.candidate_id is null or claim.pipeline_run_id is null);
update public.image_candidates image set pipeline_run_id = (select id from public.pipeline_runs run where run.candidate_id = image.candidate_id order by finished_at desc nulls last, started_at desc limit 1)
where image.pipeline_run_id is null;

-- Remove only demonstrably invalid historical source links. The target reviews
-- are re-synchronized by the repair script using their own isolated records.
delete from public.pipeline_claim_sources link
using public.pipeline_claims claim, public.pipeline_drafts draft, public.discovered_documents document
where link.claim_id = claim.id and claim.draft_id = draft.id and link.document_id = document.id
  and (draft.candidate_id <> document.candidate_id or draft.pipeline_run_id <> document.pipeline_run_id);

alter table public.discovered_documents drop constraint if exists discovered_documents_normalized_url_key;
alter table public.research_packets drop constraint if exists research_packets_candidate_id_iteration_key;
alter table public.pipeline_drafts drop constraint if exists pipeline_drafts_candidate_id_version_key;
alter table public.discovered_documents alter column candidate_id set not null;
alter table public.discovered_documents alter column pipeline_run_id set not null;
alter table public.research_packets alter column pipeline_run_id set not null;
alter table public.pipeline_drafts alter column pipeline_run_id set not null;
alter table public.pipeline_claims alter column candidate_id set not null;
alter table public.pipeline_claims alter column pipeline_run_id set not null;
alter table public.image_candidates alter column pipeline_run_id set not null;

alter table public.pipeline_runs add constraint pipeline_runs_id_candidate_key unique (id, candidate_id);
alter table public.discovered_documents add constraint discovered_documents_run_candidate_fkey foreign key (pipeline_run_id, candidate_id) references public.pipeline_runs(id, candidate_id) on delete cascade;
alter table public.research_packets add constraint research_packets_run_candidate_fkey foreign key (pipeline_run_id, candidate_id) references public.pipeline_runs(id, candidate_id) on delete cascade;
alter table public.pipeline_drafts add constraint pipeline_drafts_run_candidate_fkey foreign key (pipeline_run_id, candidate_id) references public.pipeline_runs(id, candidate_id) on delete restrict;
alter table public.pipeline_claims add constraint pipeline_claims_run_candidate_fkey foreign key (pipeline_run_id, candidate_id) references public.pipeline_runs(id, candidate_id) on delete restrict;
alter table public.image_candidates add constraint image_candidates_run_candidate_fkey foreign key (pipeline_run_id, candidate_id) references public.pipeline_runs(id, candidate_id) on delete restrict;
alter table public.image_candidates add constraint image_candidates_source_document_fkey foreign key (source_document_id) references public.discovered_documents(id) on delete set null;

create unique index if not exists discovered_documents_candidate_run_url_key on public.discovered_documents(candidate_id, pipeline_run_id, normalized_url);
create unique index if not exists research_packets_candidate_run_iteration_key on public.research_packets(candidate_id, pipeline_run_id, iteration);
create unique index if not exists pipeline_drafts_candidate_run_version_key on public.pipeline_drafts(candidate_id, pipeline_run_id, version);
create index if not exists discovered_documents_candidate_run_idx on public.discovered_documents(candidate_id, pipeline_run_id);
create index if not exists pipeline_drafts_candidate_run_idx on public.pipeline_drafts(candidate_id, pipeline_run_id, version desc);
create index if not exists pipeline_claims_candidate_run_idx on public.pipeline_claims(candidate_id, pipeline_run_id);
create index if not exists image_candidates_candidate_run_idx on public.image_candidates(candidate_id, pipeline_run_id);

create or replace function public.enforce_pipeline_claim_source_ownership()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare claim_candidate uuid; claim_run uuid; document_candidate uuid; document_run uuid;
begin
  select candidate_id, pipeline_run_id into claim_candidate, claim_run from public.pipeline_claims where id = new.claim_id;
  select candidate_id, pipeline_run_id into document_candidate, document_run from public.discovered_documents where id = new.document_id;
  if claim_candidate is null or document_candidate is null or claim_candidate <> document_candidate or claim_run <> document_run then
    raise exception using errcode = '23514', message = 'pipeline claim source must belong to the claim candidate and run';
  end if;
  return new;
end $$;
drop trigger if exists pipeline_claim_source_ownership on public.pipeline_claim_sources;
create trigger pipeline_claim_source_ownership before insert or update on public.pipeline_claim_sources for each row execute function public.enforce_pipeline_claim_source_ownership();
commit;
