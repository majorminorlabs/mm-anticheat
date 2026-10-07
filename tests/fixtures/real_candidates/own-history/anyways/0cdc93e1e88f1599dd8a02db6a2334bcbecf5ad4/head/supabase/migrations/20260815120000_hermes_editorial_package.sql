-- Persist the editor-facing social post separately from the public story body.
-- Hermes can prepare it, while publication remains a human newsroom action.
begin;

create table if not exists public.story_social_posts (
  story_id uuid primary key references public.stories(id) on delete cascade,
  body text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

alter table public.story_social_posts enable row level security;

drop policy if exists "editors read story social posts" on public.story_social_posts;
create policy "editors read story social posts"
on public.story_social_posts for select to authenticated
using (
  public.is_editor()
  or exists (
    select 1
    from public.stories story
    where story.id = story_social_posts.story_id
      and story.author_id = auth.uid()
      and story.status in ('idea', 'researching', 'draft', 'review')
  )
);

drop policy if exists "editors manage story social posts" on public.story_social_posts;
create policy "editors manage story social posts"
on public.story_social_posts for all to authenticated
using (
  public.is_editor()
  or exists (
    select 1
    from public.stories story
    where story.id = story_social_posts.story_id
      and story.author_id = auth.uid()
      and story.status in ('idea', 'researching', 'draft', 'review')
  )
)
with check (
  public.is_editor()
  or exists (
    select 1
    from public.stories story
    where story.id = story_social_posts.story_id
      and story.author_id = auth.uid()
      and story.status in ('idea', 'researching', 'draft', 'review')
  )
);

create or replace function public.save_story_social_post(
  p_story_id uuid,
  p_social_post text
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  story public.stories%rowtype;
  body text := nullif(left(btrim(coalesce(p_social_post, '')), 4000), '');
begin
  if auth.uid() is null or public.current_role() is null then
    raise exception using errcode = '42501', message = 'newsroom membership is required';
  end if;

  select * into story
  from public.stories
  where id = p_story_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'story was not found';
  end if;

  if not (
    public.is_editor()
    or (
      story.author_id = auth.uid()
      and story.status in ('idea', 'researching', 'draft', 'review')
    )
  ) then
    raise exception using errcode = '42501', message = 'this story social post cannot be edited by the current account';
  end if;

  if body is null then
    delete from public.story_social_posts where story_id = p_story_id;
  else
    insert into public.story_social_posts (story_id, body, updated_at, updated_by)
    values (p_story_id, body, now(), auth.uid())
    on conflict (story_id) do update
      set body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;

  return jsonb_build_object(
    'story_id', p_story_id,
    'body', coalesce(body, '')
  );
end
$function$;

revoke all on function public.save_story_social_post(uuid, text) from public, anon;
grant execute on function public.save_story_social_post(uuid, text) to authenticated;

-- Approval creates the story link after the pipeline draft exists. Copy the
-- prepared social post at that boundary so it remains available in the story
-- editor without exposing it through the public stories table.
create or replace function public.sync_pipeline_story_social_post()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  body text;
begin
  select nullif(left(btrim(coalesce(draft.social_post, '')), 4000), '')
  into body
  from public.pipeline_drafts draft
  where draft.id = new.source_draft_id;

  if body is null then
    return new;
  end if;

  insert into public.story_social_posts (story_id, body, updated_at, updated_by)
  values (new.story_id, body, now(), new.actor_id)
  on conflict (story_id) do update
    set body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  return new;
end
$function$;

drop trigger if exists pipeline_story_social_post_sync on public.pipeline_story_links;
create trigger pipeline_story_social_post_sync
after insert or update of story_id, source_draft_id
on public.pipeline_story_links
for each row execute function public.sync_pipeline_story_social_post();

comment on table public.story_social_posts is 'Editor-facing social copy prepared alongside an article. It is not part of the public story body.';

commit;
