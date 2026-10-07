-- Accept the Hermes review-package contract's section_id as a compatibility
-- alias for primary_section when materializing an unpublished newsroom draft.
-- New packages should continue to write primary_section. The fallback is
-- still checked against public.sections, so it cannot bypass taxonomy.
begin;

create or replace function public.materialize_pipeline_story(p_candidate_id uuid)
returns table(story_id uuid, created boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  candidate public.candidate_stories%rowtype;
  source_draft public.pipeline_drafts%rowtype;
  existing_link public.pipeline_story_links%rowtype;
  created_story public.stories%rowtype;
  requested_section text;
  requested_beat text;
  requested_tag text;
  beat_id uuid;
  tag_id uuid;
  safe_slug text;
begin
  if auth.uid() is null or not public.is_editor() then
    raise exception using errcode = '42501', message = 'an editor account is required to create an editorial draft';
  end if;

  select * into candidate
  from public.candidate_stories
  where id = p_candidate_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'pipeline candidate was not found';
  end if;

  select * into existing_link
  from public.pipeline_story_links
  where candidate_id = candidate.id;

  if found then
    return query select existing_link.story_id, false;
    return;
  end if;

  if candidate.status not in ('ready_for_review', 'approved') then
    raise exception using errcode = '22023', message = 'only reviewed pipeline candidates can create an editorial draft';
  end if;

  select * into source_draft
  from public.pipeline_drafts
  where candidate_id = candidate.id
  order by version desc
  limit 1;

  if not found or nullif(btrim(source_draft.headline), '') is null or nullif(btrim(source_draft.dek), '') is null or nullif(btrim(source_draft.body_markdown), '') is null then
    raise exception using errcode = '22023', message = 'the latest pipeline draft is incomplete';
  end if;

  requested_section := nullif(lower(btrim(coalesce(
    candidate.classification ->> 'primary_section',
    candidate.classification ->> 'section_id'
  ))), '');
  select section.id into requested_section
  from public.sections section
  where lower(section.id) = requested_section
     or lower(section.slug) = requested_section
     or lower(section.name) = requested_section
     or replace(replace(requested_section, '_', '-'), ' ', '-') = lower(section.id)
     or replace(replace(requested_section, '_', '-'), ' ', '-') = lower(section.slug)
  limit 1;
  if requested_section is null then
    requested_section := case replace(replace(lower(btrim(coalesce(
      candidate.classification ->> 'primary_section',
      candidate.classification ->> 'section_id'
    ))), '_', '-'), ' ', '-')
      when 'digital-collectibles' then 'digital-collectibles'
      when 'nft' then 'digital-collectibles'
      when 'nfts' then 'digital-collectibles'
      else null
    end;
  end if;
  if requested_section is null or not exists (select 1 from public.sections where id = requested_section) then
    raise exception using errcode = '22023', message = 'the pipeline candidate has no canonical primary section';
  end if;

  safe_slug := trim(both '-' from regexp_replace(lower(source_draft.headline), '[^a-z0-9]+', '-', 'g'));
  if safe_slug = '' then safe_slug := 'pipeline-story'; end if;
  safe_slug := left(safe_slug, 84) || '-' || left(candidate.id::text, 8);

  insert into public.stories (
    title, slug, dek, summary, body, section_id, author_id, editor_id,
    status, published_at, scheduled_for, reading_time_minutes,
    seo_title, seo_description, revision_number
  ) values (
    source_draft.headline, safe_slug, source_draft.dek, source_draft.dek,
    source_draft.body_markdown, requested_section, auth.uid(), auth.uid(),
    'draft', null, null,
    greatest(1, ceil(array_length(regexp_split_to_array(btrim(source_draft.body_markdown), '\\s+'), 1)::numeric / 220)::integer),
    source_draft.headline, source_draft.dek, 1
  ) returning * into created_story;

  if jsonb_typeof(coalesce(candidate.classification -> 'recurring_beats', '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'pipeline recurring beats must be an array';
  end if;
  for requested_beat in select jsonb_array_elements_text(coalesce(candidate.classification -> 'recurring_beats', '[]'::jsonb)) loop
    select id into beat_id from public.beats where slug = lower(btrim(requested_beat)) or lower(name) = lower(btrim(requested_beat));
    if not found then
      raise exception using errcode = '22023', message = format('pipeline beat is not canonical: %s', requested_beat);
    end if;
    insert into public.story_beats(story_id, beat_id) values(created_story.id, beat_id) on conflict do nothing;
  end loop;

  if jsonb_typeof(coalesce(candidate.classification -> 'tags', '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'pipeline tags must be an array';
  end if;
  for requested_tag in select jsonb_array_elements_text(coalesce(candidate.classification -> 'tags', '[]'::jsonb)) loop
    requested_tag := trim(both '-' from regexp_replace(lower(btrim(requested_tag)), '[^a-z0-9]+', '-', 'g'));
    if requested_tag <> '' then
      insert into public.tags(slug, name) values(requested_tag, initcap(replace(requested_tag, '-', ' '))) on conflict(slug) do nothing;
      select id into tag_id from public.tags where slug = requested_tag;
      insert into public.story_tags(story_id, tag_id) values(created_story.id, tag_id) on conflict do nothing;
    end if;
  end loop;

  insert into public.sources (story_id, title, url, normalized_url, source_type, author, published_at, accessed_at, note, sort_order, created_by)
  select created_story.id,
    coalesce(nullif(btrim(document.title), ''), 'Pipeline source'),
    coalesce(document.canonical_url, document.url),
    document.normalized_url,
    'article'::public.source_kind,
    nullif(btrim(document.author), ''),
    document.published_at,
    now(),
    'Retained from the linked pipeline research package.',
    row_number() over (order by document.created_at),
    auth.uid()
  from (
    select distinct on (normalized_url) *
    from public.discovered_documents
    where candidate_id = candidate.id
      and coalesce(canonical_url, url) ~* '^https?://'
    order by normalized_url, created_at
  ) as document;

  insert into public.pipeline_story_links (
    candidate_id, story_id, source_draft_id, source_draft_version, actor_id,
    prior_candidate_status, result
  ) values (
    candidate.id, created_story.id, source_draft.id, source_draft.version,
    auth.uid(), candidate.status, 'created'
  );

  insert into public.pipeline_review_decisions (
    candidate_id, actor_id, action, note, previous_state, new_state, metadata
  ) values (
    candidate.id, auth.uid(), 'materialize',
    'Created an unpublished editorial draft.', candidate.status, candidate.status,
    jsonb_build_object('story_id', created_story.id, 'pipeline_draft_id', source_draft.id, 'pipeline_draft_version', source_draft.version, 'result', 'created')
  );

  return query select created_story.id, true;
end
$function$;

revoke execute on function public.materialize_pipeline_story(uuid) from public, anon;
grant execute on function public.materialize_pipeline_story(uuid) to authenticated;

commit;
