-- Premium publication contract.
--
-- This migration narrows the anonymous story surface, records source review
-- state, and gives the public renderer a stable projection. It deliberately
-- does not change the image-rights workflow or author identity policy.

begin;

create extension if not exists pg_trgm;

alter table public.stories
  add column if not exists article_format text not null default 'News',
  add column if not exists materially_updated_at timestamptz,
  add column if not exists update_note text;

alter table public.stories drop constraint if exists stories_article_format_check;
alter table public.stories add constraint stories_article_format_check
  check (article_format in ('News', 'Analysis', 'Explainer', 'Feature', 'Investigation', 'Interview', 'Review', 'Opinion'));

comment on column public.stories.article_format is
  'Reader-facing editorial format. This is not an internal workflow state.';
comment on column public.stories.materially_updated_at is
  'Last reader-relevant editorial update, separate from administrative updated_at.';
comment on column public.stories.update_note is
  'Short editor-authored explanation for a material update.';

alter table public.sources
  add column if not exists canonical_url text,
  add column if not exists http_status integer,
  add column if not exists redirect_url text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists source_review_status text not null default 'pending',
  add column if not exists source_review_note text,
  add column if not exists reviewed_by uuid references public.profiles(id),
  add column if not exists reviewed_at timestamptz,
  add column if not exists primary_source boolean not null default false,
  add column if not exists claim_map jsonb not null default '{}'::jsonb;

alter table public.sources drop constraint if exists sources_review_status_check;
alter table public.sources add constraint sources_review_status_check
  check (source_review_status in ('pending', 'approved', 'rejected', 'legacy_unreviewed'));
alter table public.sources drop constraint if exists sources_claim_map_object_check;
alter table public.sources add constraint sources_claim_map_object_check
  check (jsonb_typeof(claim_map) in ('object', 'array'));

create index if not exists sources_story_review_idx
  on public.sources(story_id, source_review_status, primary_source, sort_order);
create index if not exists sources_health_check_idx
  on public.sources(last_checked_at, http_status);

-- Keep presentation useful to readers without leaking workflow or rights
-- bookkeeping that may be stored next to the selected display values.
create or replace function public.public_presentation(value jsonb)
returns jsonb
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $function$
declare
  result jsonb := '{}'::jsonb;
  hero jsonb;
  image jsonb;
  images jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(value) <> 'object' then return result; end if;
  result := jsonb_build_object(
    'composition', coalesce(value ->> 'composition', 'split'),
    'accent', coalesce(value ->> 'accent', 'auto'),
    'detour', coalesce(value -> 'detour', '{}'::jsonb),
    'detours', coalesce(value -> 'detours', '[]'::jsonb)
  );

  hero := value -> 'hero';
  if jsonb_typeof(hero) = 'object' then
    result := result || jsonb_build_object('hero', hero - array[
      'rights_status', 'rights_note', 'rights_basis', 'rights_details',
      'editorial_approved', 'rights_audit', 'internal_rights_notes',
      'verification_method', 'verification_timestamp', 'source_metadata'
    ]::text[]);
  else
    result := result || jsonb_build_object('hero', null);
  end if;

  if jsonb_typeof(value -> 'inlineImages') = 'array' then
    for image in select element from jsonb_array_elements(value -> 'inlineImages') as expanded(element) loop
      images := images || jsonb_build_array(image - array[
        'rights_status', 'rights_note', 'rights_basis', 'rights_details',
        'editorial_approved', 'rights_audit', 'internal_rights_notes',
        'verification_method', 'verification_timestamp', 'source_metadata'
      ]::text[]);
    end loop;
  end if;
  result := result || jsonb_build_object('inlineImages', images);
  return result;
end
$function$;

revoke all on function public.public_presentation(jsonb) from public, anon, authenticated;

-- The only story rows visible to an anonymous reader. Internal editor IDs,
-- scores, model decisions, ranking state, overrides, origins, and notes are
-- intentionally absent from this view.
drop view if exists public.published_stories cascade;
create view public.published_stories as
select
  story.id,
  story.title,
  story.slug,
  story.dek,
  story.summary,
  story.body,
  story.section_id,
  story.published_at,
  story.materially_updated_at,
  story.update_note,
  story.reading_time_minutes,
  story.article_format,
  public.public_presentation(story.presentation) as presentation,
  story.seo_title,
  story.seo_description,
  story.social_title,
  story.social_description,
  case when section.id is null then null else jsonb_build_object('name', section.name, 'slug', section.slug) end as sections,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'section_id', story_section.section_id,
      'sections', jsonb_build_object('name', secondary.name, 'slug', secondary.slug)
    ) order by story_section.section_id)
    from public.story_sections story_section
    join public.sections secondary on secondary.id = story_section.section_id
    where story_section.story_id = story.id
  ), '[]'::jsonb) as story_sections,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'beats', jsonb_build_object('name', beat.name, 'slug', beat.slug)
    ) order by beat.slug)
    from public.story_beats story_beat
    join public.beats beat on beat.id = story_beat.beat_id
    where story_beat.story_id = story.id
  ), '[]'::jsonb) as story_beats,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'tags', jsonb_build_object('name', tag.name, 'slug', tag.slug)
    ) order by tag.slug)
    from public.story_tags story_tag
    join public.tags tag on tag.id = story_tag.tag_id
    where story_tag.story_id = story.id
  ), '[]'::jsonb) as story_tags,
  case when media.id is null then null else jsonb_build_object(
    'id', media.id,
    'public_url', media.public_url,
    'alt_text', media.alt_text,
    'caption', media.caption,
    'credit', media.credit,
    'width', media.width,
    'height', media.height,
    'mime_type', media.mime_type
  ) end as hero_media
from public.stories story
left join public.sections section on section.id = story.section_id
left join public.media media on media.id = story.hero_media_id
where story.status = 'published'
  and story.published_at is not null
  and story.published_at <= now();

comment on view public.published_stories is
  'Stable anonymous allowlist for published story content. Do not replace with select *.';

revoke all on public.published_stories from public, anon, authenticated;
grant select on public.published_stories to anon, authenticated;

drop policy if exists "public reads published stories" on public.stories;
revoke select on public.stories from public, anon;

drop view if exists public.published_story_sources cascade;
create view public.published_story_sources as
select
  source.id,
  source.story_id,
  source.title,
  coalesce(nullif(btrim(source.publisher), ''), 'Publisher not listed') as publisher,
  source.url,
  source.canonical_url,
  source.source_type,
  source.author,
  source.published_at,
  source.accessed_at,
  source.archive_url,
  source.sort_order
from public.sources source
join public.published_stories story on story.id = source.story_id;

revoke all on public.published_story_sources from public, anon, authenticated;
grant select on public.published_story_sources to anon, authenticated;

drop view if exists public.published_story_corrections cascade;
create view public.published_story_corrections as
select correction.id, correction.story_id, correction.corrected_at, correction.note
from public.story_corrections correction
join public.published_stories story on story.id = correction.story_id;

revoke all on public.published_story_corrections from public, anon, authenticated;
grant select on public.published_story_corrections to anon, authenticated;

create or replace function public.story_publication_gate(s public.stories)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  source_count integer;
  primary_count integer;
  errors jsonb := '[]'::jsonb;
begin
  select count(*)::integer, count(*) filter (where primary_source)::integer
  into source_count, primary_count
  from public.sources source
  where source.story_id = s.id;

  if source_count = 0 then
    errors := errors || jsonb_build_array('at least one source is required');
  end if;
  if primary_count = 0 then
    errors := errors || jsonb_build_array('at least one source must be marked primary');
  end if;
  if exists (
    select 1 from public.sources source
    where source.story_id = s.id
      and (
        btrim(source.url) !~* $url$^https?://[^[:space:]]+$url$
        or nullif(btrim(source.title), '') is null
        or nullif(btrim(source.publisher), '') is null
        or nullif(btrim(source.source_type::text), '') is null
        or source.accessed_at is null
        or source.reviewed_at is null
        or source.source_review_status <> 'approved'
        or (source.http_status is not null and (source.http_status < 200 or source.http_status >= 400))
      )
  ) then
    errors := errors || jsonb_build_array('one or more sources are incomplete, unhealthy, or not human-reviewed');
  end if;

  return jsonb_build_object(
    'ok', jsonb_array_length(errors) = 0,
    'source_count', source_count,
    'primary_count', primary_count,
    'errors', errors
  );
end
$function$;

revoke all on function public.story_publication_gate(public.stories) from public, anon, authenticated;
grant execute on function public.story_publication_gate(public.stories) to authenticated, service_role;

create or replace function public.can_publish_story(s public.stories)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    nullif(btrim(s.title), '') is not null
    and nullif(btrim(s.slug), '') is not null
    and nullif(btrim(s.dek), '') is not null
    and nullif(btrim(s.body), '') is not null
    and s.section_id is not null
    and s.author_id is not null
    and nullif(btrim(s.seo_title), '') is not null
    and nullif(btrim(s.seo_description), '') is not null
    and exists (
      select 1 from public.profiles editor
      where editor.id = s.editor_id and editor.role in ('admin', 'editor')
    )
    and coalesce((public.story_publication_gate(s) ->> 'ok')::boolean, false)
$function$;

revoke all on function public.can_publish_story(public.stories) from public, anon, authenticated;
grant execute on function public.can_publish_story(public.stories) to authenticated, service_role;

create or replace function public.guard_premium_publication_gate()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.status in ('fact_check', 'scheduled', 'published')
     and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.status <> 'published'))
     and not public.can_publish_story(new) then
    raise exception using
      errcode = '23514',
      message = 'publication evidence review is incomplete; every source needs human approval, health, metadata, and a primary-source designation';
  end if;
  return new;
end
$function$;

drop trigger if exists guard_premium_publication_gate on public.stories;
create trigger guard_premium_publication_gate
before insert or update of status, published_at, section_id, title, dek, body, seo_title, seo_description
on public.stories
for each row execute function public.guard_premium_publication_gate();

create or replace function public.review_story_source(
  p_source_id uuid,
  p_status text,
  p_note text default null,
  p_http_status integer default null,
  p_canonical_url text default null,
  p_claim_map jsonb default '{}'::jsonb
)
returns public.sources
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  saved public.sources;
begin
  if public.current_role() not in ('admin', 'editor') then
    raise exception using errcode = '42501', message = 'editor access is required';
  end if;
  if p_status not in ('pending', 'approved', 'rejected', 'legacy_unreviewed') then
    raise exception using errcode = '22023', message = 'invalid source review status';
  end if;
  update public.sources
  set source_review_status = p_status,
      source_review_note = nullif(left(btrim(coalesce(p_note, '')), 2000), ''),
      http_status = p_http_status,
      canonical_url = nullif(left(btrim(coalesce(p_canonical_url, '')), 2048), ''),
      last_checked_at = case when p_http_status is null then last_checked_at else now() end,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      claim_map = coalesce(p_claim_map, '{}'::jsonb)
  where id = p_source_id
  returning * into saved;
  if not found then raise exception using errcode = 'P0002', message = 'source was not found'; end if;
  return saved;
end
$function$;

revoke all on function public.review_story_source(uuid, text, text, integer, text, jsonb) from public, anon;
grant execute on function public.review_story_source(uuid, text, text, integer, text, jsonb) to authenticated;

create or replace function public.search_published_stories(
  p_query text,
  p_section_id text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  slug text,
  dek text,
  summary text,
  section_id text,
  sections jsonb,
  published_at timestamptz,
  article_format text,
  snippet text,
  rank real
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with query as (
    select websearch_to_tsquery('simple', nullif(btrim(left(coalesce(p_query, ''), 120)), '')) as tsquery
  )
  select story.id,
         story.title,
         story.slug,
         story.dek,
         story.summary,
         story.section_id,
         story.sections,
         story.published_at,
         story.article_format,
         ts_headline('simple', coalesce(story.body, story.dek, story.title), query.tsquery, 'StartSel=<mark>,StopSel=</mark>,MaxWords=32,MinWords=12') as snippet,
         ts_rank_cd(
           to_tsvector('simple', concat_ws(' ', story.title, story.dek, story.summary, story.body)),
           query.tsquery
         ) as rank
  from public.published_stories story
  cross join query
  where query.tsquery is not null
    and (p_section_id is null or story.section_id = p_section_id)
    and to_tsvector('simple', concat_ws(' ', story.title, story.dek, story.summary, story.body)) @@ query.tsquery
  order by rank desc, story.published_at desc, story.id
  limit greatest(1, least(coalesce(p_limit, 20), 20))
  offset greatest(0, least(coalesce(p_offset, 0), 1000));
$function$;

revoke all on function public.search_published_stories(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_published_stories(text, text, integer, integer) to anon, authenticated;

create table if not exists public.publication_schema_version (
  id boolean primary key default true check (id),
  version text not null,
  applied_at timestamptz not null default now()
);
insert into public.publication_schema_version(id, version)
values (true, 'premium-publication-contract-v1')
on conflict (id) do update set version = excluded.version, applied_at = now();
revoke all on public.publication_schema_version from public, anon, authenticated;
grant select on public.publication_schema_version to service_role;

create or replace function public.get_publication_schema_version()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select version from public.publication_schema_version where id = true
$function$;

revoke all on function public.get_publication_schema_version() from public, anon, authenticated;
grant execute on function public.get_publication_schema_version() to service_role;

commit;
