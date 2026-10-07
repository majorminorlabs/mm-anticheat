-- Hermes Source Proposals V1. This is a narrow cross-machine handoff from
-- normalized source events to an authenticated Hermes writer. It never
-- publishes, materializes a story, invokes Luna, or touches the controller
-- job queue.

begin;

-- Keep the writer package aligned with the canonical Anyways handoff. Legacy
-- pipeline drafts may remain null, while Hermes packages must supply a post.
alter table public.pipeline_drafts
  add column if not exists social_post text;

alter table public.source_registry
  add column if not exists pipeline_role text not null default 'discovery',
  add column if not exists editorial_fit numeric(2,1) not null default 3.0;

create table if not exists public.hermes_story_proposals (
  id uuid primary key default gen_random_uuid(),
  source_event_id uuid not null references public.source_events(id) on delete cascade,
  proposal_key text not null unique,
  proposal_fingerprint text not null,
  title text not null,
  summary text not null default '',
  source_url text,
  source_name text not null,
  source_type text not null,
  source_priority integer not null default 0,
  editorial_fit numeric(2,1) not null default 3.0,
  pipeline_role text not null,
  primary_sections text[] not null default '{}',
  topic_tags text[] not null default '{}',
  priority integer not null default 0 check (priority between 0 and 100),
  published_at timestamptz,
  discovered_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','claimed','writing','ready_for_review','failed','rejected','cancelled')),
  claimed_by text,
  claimed_at timestamptz,
  lease_until timestamptz,
  candidate_id uuid references public.candidate_stories(id) on delete set null,
  result jsonb not null default '{}',
  error jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hermes_story_proposals_claim_idx
  on public.hermes_story_proposals(status, priority desc, discovered_at desc);
create index if not exists hermes_story_proposals_fingerprint_idx
  on public.hermes_story_proposals(proposal_fingerprint, status);
create index if not exists hermes_story_proposals_candidate_idx
  on public.hermes_story_proposals(candidate_id)
  where candidate_id is not null;

create or replace function public.touch_hermes_story_proposal_updated_at()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists hermes_story_proposals_updated_at on public.hermes_story_proposals;
create trigger hermes_story_proposals_updated_at
before update on public.hermes_story_proposals
for each row execute function public.touch_hermes_story_proposal_updated_at();

alter table public.hermes_story_proposals enable row level security;
drop policy if exists "editors read Hermes story proposals" on public.hermes_story_proposals;
create policy "editors read Hermes story proposals"
on public.hermes_story_proposals for select to authenticated
using (public.is_editor());
drop policy if exists "Hermes writers read assigned proposals" on public.hermes_story_proposals;
create policy "Hermes writers read assigned proposals"
on public.hermes_story_proposals for select to authenticated
using (public.current_role() in ('hermes_writer','admin','editor'));

drop policy if exists "Hermes writers read source events" on public.source_events;
create policy "Hermes writers read source events"
on public.source_events for select to authenticated
using (public.current_role() in ('hermes_writer','admin','editor'));
drop policy if exists "Hermes writers read source registry" on public.source_registry;
create policy "Hermes writers read source registry"
on public.source_registry for select to authenticated
using (public.current_role() in ('hermes_writer','admin','editor'));

create or replace function public.assert_hermes_writer()
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then return; end if;
  if auth.uid() is null or public.current_role() not in ('hermes_writer','admin','editor') then
    raise exception using errcode = '42501', message = 'an authorized Hermes writer is required';
  end if;
end;
$$;

-- Queue only recent, high-fit discovery/both sources. Verification-only
-- sources remain available to Hermes as context but do not create writing work.
-- X is included only after the separate paced browser collector has already
-- normalized a post into source_events.
create or replace function public.queue_hermes_story_proposals(
  p_now timestamptz default now(),
  p_limit integer default 25
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare queued_count integer := 0; bounded_limit integer;
begin
  perform public.assert_pipeline_controller();
  bounded_limit := least(greatest(coalesce(p_limit, 0), 0), 100);

  with eligible as (
    select
      event.id as source_event_id,
      event.title,
      left(coalesce(nullif(event.summary, ''), event.raw_text, ''), 4000) as summary,
      nullif(btrim(event.canonical_url), '') as source_url,
      source.name as source_name,
      event.source_type,
      source.priority as source_priority,
      source.editorial_fit,
      source.pipeline_role,
      source.primary_sections,
      source.topic_tags,
      event.published_at,
      event.discovered_at,
      md5(lower(regexp_replace(coalesce(event.title, ''), '[^a-z0-9]+', '', 'g'))) as proposal_fingerprint,
      least(100, greatest(0,
        (source.priority * 10)
        + round(source.editorial_fit * 10)::integer
        + case
            when event.discovered_at >= coalesce(p_now, now()) - interval '15 minutes' then 20
            when event.discovered_at >= coalesce(p_now, now()) - interval '2 hours' then 10
            else 0
          end
      )) as proposal_priority
    from public.source_events event
    join public.source_registry source on source.id = event.source_id
    where event.status = 'ingested'
      and source.active
      and source.review_status = 'ready'
      and source.pipeline_role in ('discovery','both')
      and source.editorial_fit >= 3.5
      and source.source_type in ('rss','blog','official_announcements','x_account')
      and coalesce(event.published_at, event.discovered_at) >= coalesce(p_now, now()) - interval '72 hours'
      and not exists (
        select 1 from public.hermes_story_proposals existing
        where existing.source_event_id = event.id
      )
      and not exists (
        select 1 from public.hermes_story_proposals existing
        where existing.proposal_fingerprint = md5(lower(regexp_replace(coalesce(event.title, ''), '[^a-z0-9]+', '', 'g')))
          and existing.status in ('queued','claimed','writing','ready_for_review')
      )
    order by proposal_priority desc, event.discovered_at desc
    limit bounded_limit
  ), inserted as (
    insert into public.hermes_story_proposals (
      source_event_id, proposal_key, proposal_fingerprint, title, summary, source_url,
      source_name, source_type, source_priority, editorial_fit, pipeline_role,
      primary_sections, topic_tags, priority, published_at, discovered_at
    )
    select source_event_id, source_event_id::text, proposal_fingerprint,
      left(coalesce(nullif(btrim(title), ''), 'Untitled source lead'), 1000), summary, source_url,
      source_name, source_type, source_priority, editorial_fit, pipeline_role,
      coalesce(primary_sections, '{}'), coalesce(topic_tags, '{}'), proposal_priority,
      published_at, discovered_at
    from eligible
    on conflict (proposal_key) do nothing
    returning id
  ) select count(*) into queued_count from inserted;

  return jsonb_build_object(
    'queued', queued_count,
    'limit', bounded_limit,
    'window_hours', 72,
    'role', 'discovery_and_both',
    'minimum_editorial_fit', 3.5
  );
end;
$$;

create or replace function public.claim_hermes_story_proposals(
  p_worker_id text default null,
  p_limit integer default 1,
  p_lease_seconds integer default 1800,
  p_now timestamptz default now()
) returns setof public.hermes_story_proposals
language plpgsql security definer set search_path = pg_catalog, public as $$
declare worker text := nullif(btrim(coalesce(p_worker_id, '')), '');
begin
  perform public.assert_hermes_writer();
  if coalesce(auth.role(), '') = 'service_role' then
    worker := coalesce(worker, 'service-role');
  else
    worker := auth.uid()::text;
  end if;
  if worker is null then raise exception using errcode = '22023', message = 'Hermes worker identity is required'; end if;
  if p_lease_seconds not between 60 and 7200 then raise exception using errcode = '22023', message = 'Hermes proposal lease must be between 60 and 7200 seconds'; end if;

  return query
  with next_proposals as (
    select id
    from public.hermes_story_proposals
    where status = 'queued'
       or (status in ('claimed','writing') and lease_until is not null and lease_until <= coalesce(p_now, now()))
    order by priority desc, discovered_at desc
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 5)
  )
  update public.hermes_story_proposals proposal
  set status = 'claimed', claimed_by = worker, claimed_at = now(),
      lease_until = coalesce(p_now, now()) + make_interval(secs => p_lease_seconds),
      error = null, updated_at = now()
  from next_proposals
  where proposal.id = next_proposals.id
  returning proposal.*;
end;
$$;

create or replace function public.update_hermes_story_proposal(
  p_proposal_id uuid,
  p_worker_id text,
  p_status text,
  p_error jsonb default null
) returns public.hermes_story_proposals
language plpgsql security definer set search_path = pg_catalog, public as $$
declare updated public.hermes_story_proposals%rowtype; worker text := nullif(btrim(coalesce(p_worker_id, '')), '');
begin
  perform public.assert_hermes_writer();
  if coalesce(auth.role(), '') = 'service_role' then
    worker := coalesce(worker, 'service-role');
  else
    worker := auth.uid()::text;
  end if;
  if p_status not in ('writing','failed','rejected','cancelled') then
    raise exception using errcode = '22023', message = 'invalid Hermes proposal status';
  end if;
  update public.hermes_story_proposals
  set status = p_status,
      error = case when p_error is null then error else p_error end,
      completed_at = case when p_status in ('failed','rejected','cancelled') then now() else completed_at end,
      lease_until = case when p_status in ('failed','rejected','cancelled') then null else lease_until end,
      updated_at = now()
  where id = p_proposal_id
    and claimed_by = worker
    and status in ('claimed','writing')
  returning * into updated;
  if not found then raise exception using errcode = '40901', message = 'Hermes proposal is not claimed by this worker'; end if;
  return updated;
end;
$$;

create or replace function public.submit_hermes_story_package(
  p_proposal_id uuid,
  p_worker_id text,
  p_package jsonb
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  proposal public.hermes_story_proposals%rowtype;
  candidate public.candidate_stories%rowtype;
  prior_draft public.pipeline_drafts%rowtype;
  run_id uuid := gen_random_uuid();
  new_draft_id uuid := gen_random_uuid();
  document_id uuid;
  candidate_external_id text := 'hermes:source-proposal:' || p_proposal_id::text;
  worker text := nullif(btrim(coalesce(p_worker_id, '')), '');
  headline text;
  dek text;
  body_markdown text;
  social_post text;
  research_markdown text;
  primary_section text;
  story_form text;
  beats jsonb;
  tags jsonb;
  source_item jsonb;
  claim_item jsonb;
  source_url text;
  source_title text;
  source_text text;
  source_author text;
  source_published_at timestamptz;
  claim_text text;
  claim_status text;
  claim_note text;
  source_index integer;
  claim_id uuid;
  source_count integer := 0;
  next_version integer;
  document_ids uuid[] := '{}'::uuid[];
  package_document_ids uuid[] := '{}'::uuid[];
  classification_payload jsonb;
  candidate_exists boolean := false;
begin
  perform public.assert_hermes_writer();
  if coalesce(auth.role(), '') = 'service_role' then
    worker := coalesce(worker, 'service-role');
  else
    worker := auth.uid()::text;
  end if;
  if jsonb_typeof(p_package) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Hermes story package must be an object';
  end if;
  if jsonb_typeof(coalesce(p_package -> 'sources', '[]'::jsonb)) is distinct from 'array'
     or jsonb_array_length(coalesce(p_package -> 'sources', '[]'::jsonb)) not between 1 and 20 then
    raise exception using errcode = '22023', message = 'Hermes story package needs 1 to 20 source records';
  end if;

  select * into proposal
  from public.hermes_story_proposals
  where id = p_proposal_id
    and claimed_by = worker
    and status in ('claimed','writing')
  for update;
  if not found then raise exception using errcode = '40901', message = 'Hermes proposal is not claimed by this worker'; end if;

  headline := nullif(btrim(p_package ->> 'headline'), '');
  dek := nullif(btrim(p_package ->> 'dek'), '');
  body_markdown := nullif(btrim(p_package ->> 'body_markdown'), '');
  social_post := nullif(btrim(p_package ->> 'social_post'), '');
  research_markdown := nullif(btrim(p_package ->> 'research_markdown'), '');
  primary_section := lower(nullif(btrim(p_package ->> 'primary_section'), ''));
  story_form := lower(coalesce(nullif(btrim(p_package ->> 'story_form'), ''), 'meanwhile'));
  beats := case when jsonb_typeof(coalesce(p_package -> 'beats', '[]'::jsonb)) = 'array' then p_package -> 'beats' else '[]'::jsonb end;
  tags := case when jsonb_typeof(coalesce(p_package -> 'tags', '[]'::jsonb)) = 'array' then p_package -> 'tags' else '[]'::jsonb end;

  if headline is null or length(headline) > 160 then raise exception using errcode = '22023', message = 'Hermes headline must be 1 to 160 characters'; end if;
  if dek is null or length(dek) > 600 then raise exception using errcode = '22023', message = 'Hermes dek must be 1 to 600 characters'; end if;
  if body_markdown is null or length(body_markdown) < 200 or length(body_markdown) > 200000 then raise exception using errcode = '22023', message = 'Hermes body must be between 200 and 200000 characters'; end if;
  if social_post is null or length(social_post) > 4000 then raise exception using errcode = '22023', message = 'Hermes social post must be 1 to 4000 characters'; end if;
  if research_markdown is null or length(research_markdown) < 80 or length(research_markdown) > 200000 then raise exception using errcode = '22023', message = 'Hermes research packet must be between 80 and 200000 characters'; end if;
  if body_markdown !~ '\[[^\]]+\]\(https?://[^)]+\)' then raise exception using errcode = '22023', message = 'Hermes body must contain at least one inline Markdown source link'; end if;
  if regexp_replace(body_markdown, '\[[^\]]+\]\(https?://[^)]+\)', '', 'g') ~* 'https?://' then raise exception using errcode = '22023', message = 'Hermes body must use inline Markdown links instead of raw URLs'; end if;
  if primary_section not in ('digital-collectibles','defi','markets','chains','products','culture','memecoins') then
    raise exception using errcode = '22023', message = 'Hermes package selected an unknown primary section';
  end if;
  if story_form not in ('meanwhile','while-youre-here','worth-your-time','receipts','anyways','we-read-it') then
    raise exception using errcode = '22023', message = 'Hermes package selected an unknown story form';
  end if;
  if jsonb_array_length(beats) > 4 or exists (
    select 1 from jsonb_array_elements_text(beats) beat
    where beat not in ('ethereum','bitcoin','solana','base','hyperliquid','robinhood-chain','nfts','digital-art','gaming-assets','wallets','stablecoins','rwas','memecoins','founders','communities','brands','infrastructure','prediction-markets','security')
  ) then
    raise exception using errcode = '22023', message = 'Hermes package contains an invalid recurring beat';
  end if;

  select * into candidate from public.candidate_stories
  where external_id = candidate_external_id
  for update;
  candidate_exists := found;
  if candidate_exists and exists (select 1 from public.pipeline_story_links where candidate_id = candidate.id) then
    raise exception using errcode = '40902', message = 'Hermes proposal is already linked to a newsroom story';
  end if;

  classification_payload := jsonb_build_object(
    'origin', 'hermes_source_proposal',
    'handoff', 'on_deck',
    'human_review_required', true,
    'no_publish', true,
    'source_proposal_id', p_proposal_id,
    'source_event_id', proposal.source_event_id,
    'primary_section', primary_section,
    'story_form', story_form,
    'recurring_beats', beats,
    'tags', tags,
    'source_count', jsonb_array_length(p_package -> 'sources')
  );

  if not candidate_exists then
    insert into public.candidate_stories (
      external_id, cluster_key, title, canonical_url, status, classification,
      model, prompt_version
    ) values (
      candidate_external_id, candidate_external_id, headline, proposal.source_url,
      'drafting', classification_payload, 'hermes', 'hermes-source-proposal-v1'
    ) returning * into candidate;
  else
    update public.candidate_stories
    set title = headline,
        canonical_url = coalesce(proposal.source_url, canonical_url),
        status = 'drafting',
        classification = classification_payload,
        model = 'hermes',
        prompt_version = 'hermes-source-proposal-v1',
        updated_at = now()
    where id = candidate.id
    returning * into candidate;
  end if;

  insert into public.pipeline_runs (
    id, candidate_id, model, status, started_at, finished_at, artifact_path, error,
    fingerprint, reused
  ) values (
    run_id, candidate.id, 'hermes', 'complete', now(), now(),
    'hermes-source-proposal:' || p_proposal_id::text, null,
    'hermes-source-proposal:' || p_proposal_id::text || ':' || run_id::text, false
  );

  insert into public.research_packets (
    candidate_id, pipeline_run_id, iteration, packet, sufficiency
  ) values (
    candidate.id, run_id, 1,
    jsonb_build_object(
      'origin', 'hermes_source_proposal',
      'contract_version', 'hermes-editorial-v1',
      'research_markdown', research_markdown,
      'source_proposal_id', p_proposal_id,
      'source_event_id', proposal.source_event_id
    ),
    jsonb_build_object('status', 'submitted_for_editorial_review', 'human_review_required', true)
  );

  -- Retain the triggering source event as evidence when it has a usable URL.
  if proposal.source_url is not null and proposal.source_url ~* '^https?://' then
    insert into public.discovered_documents (
      candidate_id, pipeline_run_id, url, normalized_url, canonical_url, title,
      raw_discovery, retention, published_at, fetched_at, extraction_method,
      extraction_status, extracted_text, paywalled, author
    )
    select candidate.id, run_id, proposal.source_url, proposal.source_url, proposal.source_url,
      proposal.title,
      jsonb_build_object('origin','source_event','source_event_id', event.id,'source_name', proposal.source_name),
      jsonb_build_object('score', 100, 'reason', 'triggering_source_event'),
      event.published_at, now(), 'source_event', 'ok', left(coalesce(event.raw_text, event.summary, ''), 100000), false, event.author_name
    from public.source_events event
    where event.id = proposal.source_event_id
    on conflict (candidate_id, pipeline_run_id, normalized_url) do update
      set title = excluded.title, extracted_text = excluded.extracted_text, published_at = excluded.published_at;
    select id into document_id from public.discovered_documents
    where candidate_id = candidate.id and pipeline_run_id = run_id and normalized_url = proposal.source_url
    limit 1;
    if document_id is not null then document_ids := array_append(document_ids, document_id); end if;
  end if;

  for source_item in select value from jsonb_array_elements(p_package -> 'sources') loop
    source_url := nullif(btrim(coalesce(source_item ->> 'url', source_item ->> 'canonical_url')), '');
    if source_url is null or source_url !~* '^https?://' then
      raise exception using errcode = '22023', message = 'Every Hermes source must contain an HTTP(S) URL';
    end if;
    source_title := left(coalesce(nullif(btrim(source_item ->> 'title'), ''), 'Hermes source'), 1000);
    source_text := left(coalesce(source_item ->> 'raw_text', source_item ->> 'text', source_item ->> 'summary', ''), 100000);
    source_author := nullif(left(btrim(source_item ->> 'author'), 500), '');
    source_published_at := null;
    if nullif(btrim(source_item ->> 'published_at'), '') is not null then
      begin
        source_published_at := (source_item ->> 'published_at')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Hermes source published_at must be a valid timestamp';
      end;
    end if;
    insert into public.discovered_documents (
      candidate_id, pipeline_run_id, url, normalized_url, canonical_url, title,
      raw_discovery, retention, published_at, fetched_at, extraction_method,
      extraction_status, extracted_text, paywalled, author
    ) values (
      candidate.id, run_id, source_url, source_url, source_url, source_title,
      jsonb_build_object('origin','hermes_package','source',source_item),
      jsonb_build_object('score', 100, 'reason', 'hermes_retained_source'),
      source_published_at, now(), 'hermes_package', 'ok', source_text, false, source_author
    ) on conflict (candidate_id, pipeline_run_id, normalized_url) do update
      set title = excluded.title, raw_discovery = excluded.raw_discovery,
          extracted_text = excluded.extracted_text, published_at = excluded.published_at,
          author = excluded.author;
    select id into document_id from public.discovered_documents
    where candidate_id = candidate.id and pipeline_run_id = run_id and normalized_url = source_url
    limit 1;
    if document_id is not null and not document_id = any(document_ids) then document_ids := array_append(document_ids, document_id); end if;
    if document_id is not null then package_document_ids := array_append(package_document_ids, document_id); end if;
  end loop;
  source_count := coalesce(cardinality(package_document_ids), 0);
  if source_count = 0 then raise exception using errcode = '22023', message = 'Hermes package did not retain a usable source'; end if;

  select * into prior_draft from public.pipeline_drafts
  where candidate_id = candidate.id
  order by version desc, created_at desc
  limit 1;
  next_version := coalesce(prior_draft.version, 0) + 1;
  insert into public.pipeline_drafts (
    id, candidate_id, pipeline_run_id, version, headline, dek, body_markdown, social_post, prior_draft_id
  ) values (
    new_draft_id, candidate.id, run_id, next_version, headline, dek, body_markdown, social_post,
    prior_draft.id
  );

  if jsonb_typeof(coalesce(p_package -> 'claims', '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_package -> 'claims', '[]'::jsonb)) > 0 then
    for claim_item in select value from jsonb_array_elements(p_package -> 'claims') loop
      claim_text := nullif(btrim(claim_item ->> 'claim'), '');
      if claim_text is null then continue; end if;
      claim_status := case when claim_item ->> 'status' in ('supported','needs_review','disputed','inferred') then claim_item ->> 'status' else 'needs_review' end;
      claim_note := nullif(left(btrim(claim_item ->> 'note'), 1000), '');
      claim_id := gen_random_uuid();
      insert into public.pipeline_claims (
        id, draft_id, candidate_id, pipeline_run_id, claim, status, note
      ) values (claim_id, new_draft_id, candidate.id, run_id, left(claim_text, 4000), claim_status, claim_note);
      if jsonb_typeof(coalesce(claim_item -> 'source_indexes', '[]'::jsonb)) = 'array' then
        for source_index in select (value #>> '{}')::integer from jsonb_array_elements(claim_item -> 'source_indexes') value loop
          if source_index between 1 and source_count then
            insert into public.pipeline_claim_sources(claim_id, document_id)
            values (claim_id, document_ids[source_index]) on conflict do nothing;
          end if;
        end loop;
      end if;
    end loop;
  end if;
  if not exists (select 1 from public.pipeline_claims where pipeline_claims.draft_id = new_draft_id) then
    insert into public.pipeline_claims (
      draft_id, candidate_id, pipeline_run_id, claim, status, note
    ) values (
      new_draft_id, candidate.id, run_id,
      'The Hermes draft requires editor verification against the retained source package.',
      'needs_review', 'No claim ledger was supplied by the writer.'
    );
  end if;

  update public.candidate_stories
  set status = 'ready_for_review', updated_at = now()
  where id = candidate.id;

  update public.hermes_story_proposals
  set status = 'ready_for_review', candidate_id = candidate.id,
      result = jsonb_build_object('candidate_id', candidate.id, 'external_id', candidate_external_id, 'pipeline_run_id', run_id, 'pipeline_draft_id', new_draft_id, 'source_count', source_count),
      error = null, completed_at = now(), lease_until = null, updated_at = now()
  where id = proposal.id and claimed_by = worker and status in ('claimed','writing');
  if not found then raise exception using errcode = '40901', message = 'Hermes proposal lease was lost before completion'; end if;

  return jsonb_build_object(
    'proposal_id', proposal.id,
    'candidate_id', candidate.id,
    'external_id', candidate_external_id,
    'status', 'ready_for_review',
    'pipeline_run_id', run_id,
    'pipeline_draft_id', new_draft_id,
    'source_count', source_count,
    'human_review_required', true,
    'publishing', false
  );
end;
$$;

revoke all on table public.hermes_story_proposals from public, anon, authenticated;
grant select on table public.hermes_story_proposals to authenticated;
revoke all on function public.assert_hermes_writer() from public, anon, authenticated;
revoke all on function public.queue_hermes_story_proposals(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.claim_hermes_story_proposals(text, integer, integer, timestamptz) from public, anon;
revoke all on function public.update_hermes_story_proposal(uuid, text, text, jsonb) from public, anon;
revoke all on function public.submit_hermes_story_package(uuid, text, jsonb) from public, anon;
grant execute on function public.queue_hermes_story_proposals(timestamptz, integer) to service_role;
grant execute on function public.claim_hermes_story_proposals(text, integer, integer, timestamptz) to authenticated, service_role;
grant execute on function public.update_hermes_story_proposal(uuid, text, text, jsonb) to authenticated, service_role;
grant execute on function public.submit_hermes_story_package(uuid, text, jsonb) to authenticated, service_role;

comment on table public.hermes_story_proposals is 'Recent high-fit source leads handed to the Hermes writer. Completion creates an unpublished ready-for-review pipeline package; it never publishes.';
comment on column public.hermes_story_proposals.pipeline_role is 'Copied from the source registry at queue time for auditability.';
comment on function public.submit_hermes_story_package(uuid, text, jsonb) is 'Authenticated Hermes-only writer handoff. Creates a candidate, evidence documents, draft, and claim ledger in ready_for_review state without creating a newsroom story.';

commit;
