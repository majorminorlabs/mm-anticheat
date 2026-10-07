-- PostgREST upserts require a unique constraint, not only a partial index.
begin;

drop index if exists public.pipeline_sources_external_id_key;
alter table public.pipeline_sources
  add constraint pipeline_sources_external_id_key unique(external_id);

commit;
