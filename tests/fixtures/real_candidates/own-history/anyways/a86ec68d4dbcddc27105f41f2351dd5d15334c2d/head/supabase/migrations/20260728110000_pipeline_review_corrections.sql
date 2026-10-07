-- Additive corrections for the local pipeline bridge. No existing newsroom
-- object is modified or removed, and this migration never creates a story.
begin;

alter table public.candidate_stories add column if not exists external_id text;
alter table public.pipeline_review_decisions add column if not exists previous_state public.pipeline_candidate_status;
alter table public.pipeline_review_decisions add column if not exists new_state public.pipeline_candidate_status;
alter table public.pipeline_review_decisions add column if not exists metadata jsonb not null default '{}';
alter table public.pipeline_runs add column if not exists fingerprint text;
alter table public.pipeline_runs add column if not exists reused boolean not null default false;

create unique index if not exists candidate_stories_external_id_key on public.candidate_stories(external_id) where external_id is not null;
create unique index if not exists pipeline_runs_candidate_fingerprint_key on public.pipeline_runs(candidate_id, fingerprint) where fingerprint is not null;
create index if not exists candidate_stories_status_updated_idx on public.candidate_stories(status, updated_at desc);
create index if not exists discovered_documents_candidate_idx on public.discovered_documents(candidate_id);
create index if not exists pipeline_drafts_candidate_version_idx on public.pipeline_drafts(candidate_id, version desc);
create index if not exists pipeline_claims_draft_idx on public.pipeline_claims(draft_id);
create index if not exists image_candidates_candidate_idx on public.image_candidates(candidate_id);
create index if not exists pipeline_review_decisions_candidate_created_idx on public.pipeline_review_decisions(candidate_id, created_at desc);

create policy "editors read pipeline sources" on public.pipeline_sources for select to authenticated using(public.is_editor());
create policy "editors read discovery runs" on public.discovery_runs for select to authenticated using(public.is_editor());
create policy "editors read pipeline research" on public.research_packets for select to authenticated using(public.is_editor());
create policy "editors read pipeline runs" on public.pipeline_runs for select to authenticated using(public.is_editor());
create policy "editors read pipeline attempts" on public.pipeline_stage_attempts for select to authenticated using(public.is_editor());
create policy "editors read pipeline drafts" on public.pipeline_drafts for select to authenticated using(public.is_editor());
create policy "editors manage pipeline drafts" on public.pipeline_drafts for all to authenticated using(public.is_editor()) with check(public.is_editor());
create policy "editors read pipeline claims" on public.pipeline_claims for select to authenticated using(public.is_editor());
create policy "editors manage pipeline claims" on public.pipeline_claims for all to authenticated using(public.is_editor()) with check(public.is_editor());
create policy "editors read pipeline claim sources" on public.pipeline_claim_sources for select to authenticated using(public.is_editor());
create policy "editors read pipeline images" on public.image_candidates for select to authenticated using(public.is_editor());
create policy "editors manage pipeline images" on public.image_candidates for all to authenticated using(public.is_editor()) with check(public.is_editor());
create policy "editors read pipeline review decisions" on public.pipeline_review_decisions for select to authenticated using(public.is_editor());
create policy "editors read pipeline story links" on public.pipeline_story_links for select to authenticated using(public.is_editor());

commit;
