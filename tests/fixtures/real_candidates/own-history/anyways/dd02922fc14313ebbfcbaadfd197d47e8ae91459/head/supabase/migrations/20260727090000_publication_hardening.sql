-- Harden public data exposure and keep multi-row editorial saves atomic.

-- Auth accounts are not newsroom memberships. Profiles are now provisioned
-- deliberately by an administrator; existing profile rows remain unchanged.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

create or replace function public.current_role()
returns public.newsroom_role
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
$function$;

create or replace function public.is_editor()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(public.current_role() in ('admin', 'editor'), false)
$function$;

-- Every source attached to a publishable story must be an HTTP(S) URL, and
-- the assigned editor must still be an enrolled editor or administrator.
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
      select 1
      from public.profiles editor
      where editor.id = s.editor_id
        and editor.role in ('admin', 'editor')
    )
    and exists (
      select 1
      from public.story_topics st
      where st.story_id = s.id
    )
    and exists (
      select 1
      from public.sources source
      where source.story_id = s.id
    )
    and not exists (
      select 1
      from public.sources source
      where source.story_id = s.id
        and btrim(source.url) !~* $url$^https?://(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)(:[0-9]{1,5})?([/?#][^[:space:]]*)?$$url$
    )
$function$;

-- Replace the broad public relationship/media policies with policies whose
-- rows are reachable only through stories that are currently published.
drop policy if exists "public reads story relationships" on public.story_topics;
drop policy if exists "public reads sources" on public.sources;
drop policy if exists "public reads related" on public.story_related;
drop policy if exists "public reads media" on public.media;

create policy "public reads published story topics"
on public.story_topics
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.stories story
    where story.id = story_topics.story_id
      and story.status = 'published'
      and story.published_at <= now()
  )
);

create policy "public reads published story sources"
on public.sources
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.stories story
    where story.id = sources.story_id
      and story.status = 'published'
      and story.published_at <= now()
  )
);

create policy "public reads published story relations"
on public.story_related
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.stories story
    where story.id = story_related.story_id
      and story.status = 'published'
      and story.published_at <= now()
  )
  and exists (
    select 1
    from public.stories related
    where related.id = story_related.related_story_id
      and related.status = 'published'
      and related.published_at <= now()
  )
);

create policy "public reads published story media"
on public.media
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.stories story
    where story.hero_media_id = media.id
      and story.status = 'published'
      and story.published_at <= now()
  )
);

-- Newsroom reads remain available independently of the public policies.
create policy "newsroom reads story topics"
on public.story_topics
for select
to authenticated
using (
  public.is_editor()
  or exists (
    select 1
    from public.stories story
    where story.id = story_topics.story_id
      and story.author_id = auth.uid()
  )
);

create policy "newsroom reads story sources"
on public.sources
for select
to authenticated
using (
  public.is_editor()
  or exists (
    select 1
    from public.stories story
    where story.id = sources.story_id
      and story.author_id = auth.uid()
  )
);

create policy "newsroom reads story relations"
on public.story_related
for select
to authenticated
using (
  public.is_editor()
  or exists (
    select 1
    from public.stories story
    where story.id = story_related.story_id
      and story.author_id = auth.uid()
  )
);

create policy "newsroom reads media"
on public.media
for select
to authenticated
using (public.current_role() is not null);

-- Public source and media reads expose presentation data only. story_id is
-- included because PostgREST needs it for the public article's source filter.
revoke select on table public.sources from public, anon;
grant select (
  id,
  story_id,
  title,
  publisher,
  url,
  source_type,
  published_at,
  sort_order
) on table public.sources to anon;
grant select on table public.sources to authenticated;

revoke select on table public.media from public, anon;
grant select (
  id,
  public_url,
  alt_text,
  caption,
  credit
) on table public.media to anon;
grant select on table public.media to authenticated;

-- Anonymous readers need only the byline identity for authors of stories they
-- can read. Enrolled newsroom members retain the full profile directory.
drop policy if exists "authenticated reads profiles" on public.profiles;

create policy "public reads published authors"
on public.profiles
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.stories story
    where story.author_id = profiles.id
      and story.status = 'published'
      and story.published_at <= now()
  )
);

create policy "newsroom reads profiles"
on public.profiles
for select
to authenticated
using (public.current_role() is not null);

revoke select on table public.profiles from public, anon;
grant select (id, name, slug) on table public.profiles to anon;
grant select on table public.profiles to authenticated;

-- Constraint triggers run at transaction end so an editor can replace child
-- rows atomically without a transient "last row" failure.
create or replace function public.guard_published_story_topics()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  affected_story_ids uuid[];
  affected_story_id uuid;
begin
  if tg_op = 'INSERT' then
    affected_story_ids := array[new.story_id];
  elsif tg_op = 'DELETE' then
    affected_story_ids := array[old.story_id];
  else
    affected_story_ids := array[old.story_id, new.story_id];
  end if;

  for affected_story_id in
    select distinct candidate.id
    from unnest(affected_story_ids) as candidate(id)
    where candidate.id is not null
  loop
    if exists (
      select 1
      from public.stories story
      where story.id = affected_story_id
        and story.status = 'published'
    )
    and not exists (
      select 1
      from public.story_topics st
      where st.story_id = affected_story_id
    ) then
      raise exception using
        errcode = '23514',
        message = format(
          'published story %s must retain at least one topic',
          affected_story_id
        );
    end if;
  end loop;

  return null;
end
$function$;

create or replace function public.guard_published_story_sources()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  affected_story_ids uuid[];
  affected_story_id uuid;
begin
  if tg_op = 'INSERT' then
    affected_story_ids := array[new.story_id];
  elsif tg_op = 'DELETE' then
    affected_story_ids := array[old.story_id];
  else
    affected_story_ids := array[old.story_id, new.story_id];
  end if;

  for affected_story_id in
    select distinct candidate.id
    from unnest(affected_story_ids) as candidate(id)
    where candidate.id is not null
  loop
    if exists (
      select 1
      from public.stories story
      where story.id = affected_story_id
        and story.status = 'published'
        and not public.can_publish_story(story)
    ) then
      raise exception using
        errcode = '23514',
        message = format(
          'published story %s must retain only valid HTTP(S) sources and all publishing requirements',
          affected_story_id
        );
    end if;
  end loop;

  return null;
end
$function$;

do $migration$
begin
  if exists (
    select 1
    from public.stories story
    where story.status = 'published'
      and not exists (
        select 1
        from public.story_topics st
        where st.story_id = story.id
      )
  ) then
    raise exception
      'cannot install published-story topic guard while a published story has no topics';
  end if;

  if exists (
    select 1
    from public.stories story
    where story.status = 'published'
      and not public.can_publish_story(story)
  ) then
    raise exception
      'cannot install published-story source guard while a published story fails publishing requirements';
  end if;
end
$migration$;

drop trigger if exists ensure_published_story_has_topic on public.story_topics;
create constraint trigger ensure_published_story_has_topic
after insert or update or delete
on public.story_topics
deferrable initially deferred
for each row
execute function public.guard_published_story_topics();

drop trigger if exists ensure_published_story_has_source on public.sources;
create constraint trigger ensure_published_story_has_source
after insert or update or delete
on public.sources
deferrable initially deferred
for each row
execute function public.guard_published_story_sources();

-- This RPC replaces the SPA's delete-then-insert sequence with one transaction.
-- It remains a security-invoker function, so the existing story/topic RLS
-- policies are still the authority for every affected row.
create or replace function public.replace_story_topics(
  p_story_id uuid,
  p_topic_ids uuid[]
)
returns setof public.story_topics
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  locked_story public.stories%rowtype;
begin
  if auth.uid() is null or public.current_role() is null then
    raise exception using
      errcode = '42501',
      message = 'newsroom membership is required';
  end if;

  select story.*
  into locked_story
  from public.stories story
  where story.id = p_story_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = format('story %s was not found', p_story_id);
  end if;

  if not (
    public.is_editor()
    or (
      locked_story.author_id = auth.uid()
      and locked_story.status in ('idea', 'researching', 'draft', 'review')
    )
  ) then
    raise exception using
      errcode = '42501',
      message = 'this story cannot be edited by the current account';
  end if;

  delete from public.story_topics st
  where st.story_id = p_story_id;

  insert into public.story_topics (story_id, topic_id)
  select p_story_id, requested.topic_id
  from (
    select distinct topic_id
    from unnest(coalesce(p_topic_ids, '{}'::uuid[])) as ids(topic_id)
    where topic_id is not null
  ) requested;

  return query
  select st.story_id, st.topic_id
  from public.story_topics st
  where st.story_id = p_story_id
  order by st.topic_id;
end
$function$;

-- Update and topic replacement share one transaction and one row lock. The
-- patch whitelist mirrors the existing story editor; workflow/RLS checks still
-- run on the final UPDATE, and revision_number is server controlled.
create or replace function public.save_story(
  p_story_id uuid,
  p_expected_revision integer,
  p_patch jsonb,
  p_topic_ids uuid[]
)
returns public.stories
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  current_story public.stories%rowtype;
  saved_story public.stories%rowtype;
  unknown_fields text[];
begin
  if auth.uid() is null or public.current_role() is null then
    raise exception using
      errcode = '42501',
      message = 'newsroom membership is required';
  end if;

  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception using
      errcode = '22023',
      message = 'expected revision must be a positive integer';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'story patch must be a JSON object';
  end if;

  select array_agg(field order by field)
  into unknown_fields
  from jsonb_object_keys(p_patch) as fields(field)
  where field <> all (array[
    'title',
    'slug',
    'dek',
    'summary',
    'body',
    'section_id',
    'author_id',
    'editor_id',
    'status',
    'published_at',
    'scheduled_for',
    'reading_time_minutes',
    'seo_title',
    'seo_description'
  ]::text[]);

  if unknown_fields is not null then
    raise exception using
      errcode = '22023',
      message = format(
        'story patch contains unsupported fields: %s',
        array_to_string(unknown_fields, ', ')
      );
  end if;

  select story.*
  into current_story
  from public.stories story
  where story.id = p_story_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = format('story %s was not found', p_story_id);
  end if;

  if current_story.revision_number <> p_expected_revision then
    raise exception using
      errcode = '40001',
      message = format(
        'story revision conflict: expected %s but found %s',
        p_expected_revision,
        current_story.revision_number
      );
  end if;

  perform public.replace_story_topics(p_story_id, p_topic_ids);

  update public.stories story
  set
    title = case when p_patch ? 'title' then p_patch ->> 'title' else current_story.title end,
    slug = case when p_patch ? 'slug' then p_patch ->> 'slug' else current_story.slug end,
    dek = case when p_patch ? 'dek' then p_patch ->> 'dek' else current_story.dek end,
    summary = case when p_patch ? 'summary' then p_patch ->> 'summary' else current_story.summary end,
    body = case when p_patch ? 'body' then p_patch ->> 'body' else current_story.body end,
    section_id = case when p_patch ? 'section_id' then p_patch ->> 'section_id' else current_story.section_id end,
    author_id = case
      when p_patch ? 'author_id' then nullif(p_patch ->> 'author_id', '')::uuid
      else current_story.author_id
    end,
    editor_id = case
      when p_patch ? 'editor_id' then nullif(p_patch ->> 'editor_id', '')::uuid
      else current_story.editor_id
    end,
    status = case
      when p_patch ? 'status' then (p_patch ->> 'status')::public.story_status
      else current_story.status
    end,
    published_at = case
      when p_patch ? 'published_at' then (p_patch ->> 'published_at')::timestamptz
      else current_story.published_at
    end,
    scheduled_for = case
      when p_patch ? 'scheduled_for' then (p_patch ->> 'scheduled_for')::timestamptz
      else current_story.scheduled_for
    end,
    reading_time_minutes = case
      when p_patch ? 'reading_time_minutes' then (p_patch ->> 'reading_time_minutes')::integer
      else current_story.reading_time_minutes
    end,
    seo_title = case
      when p_patch ? 'seo_title' then p_patch ->> 'seo_title'
      else current_story.seo_title
    end,
    seo_description = case
      when p_patch ? 'seo_description' then p_patch ->> 'seo_description'
      else current_story.seo_description
    end,
    revision_number = current_story.revision_number + 1
  where story.id = p_story_id
    and story.revision_number = p_expected_revision
  returning story.* into saved_story;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'story changed while it was being saved';
  end if;

  if saved_story.reading_time_minutes < 1 then
    raise exception using
      errcode = '23514',
      message = 'reading time must be at least one minute';
  end if;

  return saved_story;
end
$function$;

-- PostgreSQL grants function execution to PUBLIC by default. Only the two
-- intentional newsroom RPCs and the RLS role helpers are callable by clients.
revoke execute on function public.current_role() from public, anon, authenticated;
revoke execute on function public.is_editor() from public, anon, authenticated;
revoke execute on function public.can_publish_story(public.stories) from public, anon, authenticated;
revoke execute on function public.guard_story_workflow() from public, anon, authenticated;
revoke execute on function public.guard_published_story_topics() from public, anon, authenticated;
revoke execute on function public.guard_published_story_sources() from public, anon, authenticated;
revoke execute on function public.replace_story_topics(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.save_story(uuid, integer, jsonb, uuid[]) from public, anon, authenticated;

grant execute on function public.current_role() to authenticated;
grant execute on function public.is_editor() to authenticated;
grant execute on function public.replace_story_topics(uuid, uuid[]) to authenticated;
grant execute on function public.save_story(uuid, integer, jsonb, uuid[]) to authenticated;
