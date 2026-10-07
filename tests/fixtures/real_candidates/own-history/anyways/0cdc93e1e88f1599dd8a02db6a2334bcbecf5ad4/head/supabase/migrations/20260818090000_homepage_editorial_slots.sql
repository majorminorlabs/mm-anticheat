-- Make homepage placement understandable: one lead, four Featured slots, and
-- automatic section shelves. Existing ranking data is used only to seed the
-- new durable arrangement once; future placement uses these exact slots.
begin;

alter table public.stories
  add column if not exists homepage_featured_requested boolean not null default false;

comment on column public.stories.homepage_featured_requested is
  'Whether this story should occupy a Featured slot when it is published.';

create table if not exists public.homepage_featured_slots (
  position smallint primary key check (position between 1 and 4),
  story_id uuid not null references public.stories(id) on delete cascade,
  featured_at timestamptz not null default now(),
  featured_by uuid references public.profiles(id)
);

create unique index if not exists homepage_featured_slots_story_idx
  on public.homepage_featured_slots(story_id);

create table if not exists public.homepage_featured_exclusions (
  story_id uuid primary key references public.stories(id) on delete cascade,
  excluded_at timestamptz not null default now(),
  excluded_by uuid references public.profiles(id)
);

alter table public.homepage_featured_slots enable row level security;
alter table public.homepage_featured_exclusions enable row level security;
revoke all on table public.homepage_featured_slots from public, anon, authenticated;
revoke all on table public.homepage_featured_exclusions from public, anon, authenticated;

drop policy if exists "editors manage homepage featured slots" on public.homepage_featured_slots;
create policy "editors manage homepage featured slots"
on public.homepage_featured_slots
for all to authenticated
using (public.is_editor())
with check (public.is_editor());

drop policy if exists "editors manage homepage featured exclusions" on public.homepage_featured_exclusions;
create policy "editors manage homepage featured exclusions"
on public.homepage_featured_exclusions
for all to authenticated
using (public.is_editor())
with check (public.is_editor());

create or replace function public.homepage_story_is_eligible(
  p_story_id uuid,
  p_now timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.stories story
    where story.id = p_story_id
      and story.status = 'published'
      and story.published_at is not null
      and story.published_at <= p_now
      and public.can_publish_story(story)
  );
$function$;

revoke all on function public.homepage_story_is_eligible(uuid, timestamptz) from public, anon, authenticated;

create or replace function public.homepage_lead_story_id(
  p_now timestamptz default now()
)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(
    (
      select settings.primary_story_id
      from public.homepage_settings settings
      where settings.id = true
        and settings.primary_story_id is not null
        and public.homepage_story_is_eligible(settings.primary_story_id, p_now)
      limit 1
    ),
    (
      select story.id
      from public.stories story
      where public.homepage_story_is_eligible(story.id, p_now)
      order by story.published_at desc, story.id
      limit 1
    )
  );
$function$;

revoke all on function public.homepage_lead_story_id(timestamptz) from public, anon, authenticated;

create or replace function public.fill_homepage_featured_slots(
  p_now timestamptz default now(),
  p_actor uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  lead_id uuid;
  candidate_id uuid;
  actor_id uuid := coalesce(p_actor, auth.uid());
  slot_position smallint;
begin
  insert into public.homepage_settings(id)
  values (true)
  on conflict (id) do nothing;

  -- Every placement mutation takes this lock first. It serializes publish-time
  -- fills and explicit editor choices without locking the whole stories table.
  perform 1
  from public.homepage_settings
  where id = true
  for update;

  lead_id := public.homepage_lead_story_id(p_now);

  delete from public.homepage_featured_slots slot
  where not public.homepage_story_is_eligible(slot.story_id, p_now)
     or (lead_id is not null and slot.story_id = lead_id);

  for slot_position in 1..4 loop
    if not exists (
      select 1
      from public.homepage_featured_slots slot
      where slot.position = slot_position
    ) then
      select story.id
      into candidate_id
      from public.stories story
      where public.homepage_story_is_eligible(story.id, p_now)
        and (lead_id is null or story.id <> lead_id)
        and not exists (
          select 1
          from public.homepage_featured_slots occupied
          where occupied.story_id = story.id
        )
        and not exists (
          select 1
          from public.homepage_featured_exclusions excluded
          where excluded.story_id = story.id
        )
      order by story.published_at desc, story.id
      limit 1;

      if candidate_id is not null then
        insert into public.homepage_featured_slots(position, story_id, featured_at, featured_by)
        values (slot_position, candidate_id, now(), actor_id)
        on conflict do nothing;
      end if;
      candidate_id := null;
    end if;
  end loop;
end
$function$;

revoke all on function public.fill_homepage_featured_slots(timestamptz, uuid) from public, anon, authenticated;

create or replace function public.place_homepage_featured_story(
  p_story_id uuid,
  p_actor uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  lead_id uuid;
  target_position smallint;
  oldest_position smallint;
  actor_id uuid := coalesce(p_actor, auth.uid());
begin
  if not public.homepage_story_is_eligible(p_story_id, now()) then
    raise exception using errcode = '22023', message = 'only eligible published stories can be Featured';
  end if;

  lead_id := public.homepage_lead_story_id(now());
  if lead_id = p_story_id then
    raise exception using errcode = '22023', message = 'the lead story cannot also be Featured';
  end if;

  insert into public.homepage_settings(id)
  values (true)
  on conflict (id) do nothing;
  perform 1
  from public.homepage_settings
  where id = true
  for update;

  delete from public.homepage_featured_exclusions
  where story_id = p_story_id;

  if exists (
    select 1
    from public.homepage_featured_slots
    where story_id = p_story_id
  ) then
    return;
  end if;

  -- Fill vacancies first. An explicit Featured request only rotates a story
  -- out when all four positions are already occupied.
  perform public.fill_homepage_featured_slots(now(), actor_id);

  select open_position.position::smallint
  into target_position
  from generate_series(1, 4) as open_position(position)
  where not exists (
    select 1
    from public.homepage_featured_slots occupied
    where occupied.position = open_position.position::smallint
  )
  order by open_position.position
  limit 1;

  if target_position is not null then
    insert into public.homepage_featured_slots(position, story_id, featured_at, featured_by)
    values (target_position, p_story_id, now(), actor_id);
    return;
  end if;

  select slot.position
  into oldest_position
  from public.homepage_featured_slots slot
  order by slot.featured_at asc, slot.position asc
  limit 1;

  update public.homepage_featured_slots
  set story_id = p_story_id,
      featured_at = now(),
      featured_by = actor_id
  where position = oldest_position;
end
$function$;

revoke all on function public.place_homepage_featured_story(uuid, uuid) from public, anon, authenticated;

create or replace function public.sync_homepage_story_publication()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.status <> 'published'
     or new.published_at is null
     or new.published_at > now()
     or not public.can_publish_story(new) then
    delete from public.homepage_featured_slots
    where story_id = new.id;
    perform public.fill_homepage_featured_slots(now(), auth.uid());
    return new;
  end if;

  if new.homepage_featured_requested then
    delete from public.homepage_featured_exclusions
    where story_id = new.id;
    perform public.place_homepage_featured_story(new.id, auth.uid());
  elsif tg_op = 'UPDATE' then
    if old.homepage_featured_requested then
      -- A checked Featured request being unchecked is an explicit demotion. The
      -- exclusion prevents the automatic fill from immediately adding it back.
      delete from public.homepage_featured_slots
      where story_id = new.id;
      insert into public.homepage_featured_exclusions(story_id, excluded_at, excluded_by)
      values (new.id, now(), auth.uid())
      on conflict (story_id) do update set excluded_at = excluded.excluded_at, excluded_by = excluded.excluded_by;
    end if;
  end if;

  perform public.fill_homepage_featured_slots(now(), auth.uid());
  return new;
end
$function$;

revoke all on function public.sync_homepage_story_publication() from public, anon, authenticated;

create or replace function public.set_homepage_featured_preference(
  p_story_id uuid,
  p_enabled boolean
)
returns public.stories
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  story_row public.stories;
  actor_id uuid := auth.uid();
begin
  select *
  into story_row
  from public.stories
  where id = p_story_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'story was not found';
  end if;
  if actor_id is null or not (
    public.current_role() in ('admin', 'editor')
    or (story_row.author_id = actor_id and story_row.status in ('idea', 'researching', 'draft', 'review'))
  ) then
    raise exception using errcode = '42501', message = 'this story cannot change its Featured preference';
  end if;

  update public.stories
  set homepage_featured_requested = coalesce(p_enabled, false),
      updated_at = now()
  where id = p_story_id
  returning * into story_row;

  if coalesce(p_enabled, false) then
    if public.homepage_story_is_eligible(p_story_id, now()) then
      delete from public.homepage_featured_exclusions
      where story_id = p_story_id;
      perform public.place_homepage_featured_story(p_story_id, actor_id);
    end if;
  else
    delete from public.homepage_featured_slots
    where story_id = p_story_id;
    if public.homepage_story_is_eligible(p_story_id, now()) then
      insert into public.homepage_featured_exclusions(story_id, excluded_at, excluded_by)
      values (p_story_id, now(), actor_id)
      on conflict (story_id) do update set excluded_at = excluded.excluded_at, excluded_by = excluded.excluded_by;
    end if;
    perform public.fill_homepage_featured_slots(now(), actor_id);
  end if;

  return story_row;
end
$function$;

revoke all on function public.set_homepage_featured_preference(uuid, boolean) from public, anon;
grant execute on function public.set_homepage_featured_preference(uuid, boolean) to authenticated;

create or replace function public.set_homepage_arrangement(
  p_story_id uuid,
  p_action text
)
returns public.stories
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  story_row public.stories;
  action text := lower(btrim(coalesce(p_action, '')));
  actor_id uuid := auth.uid();
  current_lead uuid;
begin
  if actor_id is null or public.current_role() not in ('admin', 'editor') then
    raise exception using errcode = '42501', message = 'editor access is required';
  end if;
  if action not in ('force_lead', 'force_homepage', 'demote', 'release') then
    raise exception using errcode = '22023', message = 'unknown homepage arrangement action';
  end if;

  select *
  into story_row
  from public.stories
  where id = p_story_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'story was not found';
  end if;

  current_lead := public.homepage_lead_story_id(now());

  if action in ('force_lead', 'force_homepage')
     and not public.homepage_story_is_eligible(p_story_id, now()) then
    raise exception using errcode = '22023', message = 'only eligible published stories can be arranged on the homepage';
  end if;

  if action = 'force_lead' then
    update public.homepage_settings
    set primary_story_id = p_story_id,
        updated_at = now(),
        updated_by = actor_id
    where id = true;
    delete from public.homepage_featured_slots
    where story_id = p_story_id;
    update public.stories
    set homepage_featured_requested = false,
        updated_at = now()
    where id = p_story_id;
    delete from public.homepage_featured_exclusions
    where story_id = p_story_id;
    perform public.fill_homepage_featured_slots(now(), actor_id);
  elsif action = 'force_homepage' then
    if current_lead = p_story_id then
      raise exception using errcode = '22023', message = 'the lead story cannot also be Featured';
    end if;
    delete from public.homepage_featured_exclusions
    where story_id = p_story_id;
    update public.stories
    set homepage_featured_requested = true,
        updated_at = now()
    where id = p_story_id;
    perform public.place_homepage_featured_story(p_story_id, actor_id);
    perform public.fill_homepage_featured_slots(now(), actor_id);
  elsif action = 'demote' then
    if current_lead = p_story_id then
      raise exception using errcode = '22023', message = 'release the lead before removing it from the homepage';
    end if;
    delete from public.homepage_featured_slots
    where story_id = p_story_id;
    update public.stories
    set homepage_featured_requested = false,
        updated_at = now()
    where id = p_story_id;
    insert into public.homepage_featured_exclusions(story_id, excluded_at, excluded_by)
    values (p_story_id, now(), actor_id)
    on conflict (story_id) do update set excluded_at = excluded.excluded_at, excluded_by = excluded.excluded_by;
    perform public.fill_homepage_featured_slots(now(), actor_id);
  else
    if current_lead = p_story_id then
      update public.homepage_settings
      set primary_story_id = null,
          updated_at = now(),
          updated_by = actor_id
      where id = true;
    end if;
    delete from public.homepage_featured_slots
    where story_id = p_story_id;
    update public.stories
    set homepage_featured_requested = false,
        updated_at = now()
    where id = p_story_id;
    -- Release means return to the automatic newest-story rule, so clear any
    -- exclusion that the publication trigger may have carried over.
    delete from public.homepage_featured_exclusions
    where story_id = p_story_id;
    perform public.fill_homepage_featured_slots(now(), actor_id);
  end if;

  select * into story_row from public.stories where id = p_story_id;
  return story_row;
end
$function$;

revoke all on function public.set_homepage_arrangement(uuid, text) from public, anon;
grant execute on function public.set_homepage_arrangement(uuid, text) to authenticated;

-- Seed the durable arrangement from the prior ranking result without
-- replacing an arrangement if this migration is replayed in a local branch.
insert into public.homepage_settings(id)
values (true)
on conflict (id) do nothing;

update public.homepage_settings settings
set primary_story_id = coalesce(
      settings.primary_story_id,
      (
        select ranked.story_id
        from public._homepage_ranking_rows(now()) ranked
        where ranked.placement = 'lead'
          and ranked.written_publishable
        order by ranked.rank_position nulls last, ranked.overall_rank, ranked.story_id
        limit 1
      ),
      (
        select story.id
        from public.stories story
        where public.homepage_story_is_eligible(story.id, now())
        order by story.published_at desc, story.id
        limit 1
      )
    ),
    updated_at = now()
where settings.id = true;

with old_featured as (
  select ranked.story_id,
         row_number() over (
           order by ranked.rank_position nulls last, ranked.overall_rank, ranked.story_id
         )::smallint as position
  from public._homepage_ranking_rows(now()) ranked
  where ranked.placement = 'homepage'
    and ranked.written_publishable
    and ranked.story_id <> public.homepage_lead_story_id(now())
), chosen as (
  select story_id, position
  from old_featured
  where position <= 4
)
insert into public.homepage_featured_slots(position, story_id, featured_at, featured_by)
select chosen.position, chosen.story_id, now(), null
from chosen
where not exists (select 1 from public.homepage_featured_slots)
on conflict do nothing;

update public.stories story
set homepage_featured_requested = true
where exists (
  select 1
  from public.homepage_featured_slots slot
  where slot.story_id = story.id
);

do $function$
begin
  perform public.fill_homepage_featured_slots(now(), null);
end
$function$;

drop trigger if exists sync_homepage_story_publication on public.stories;
create trigger sync_homepage_story_publication
after insert or update of status, published_at, homepage_featured_requested
on public.stories
for each row execute function public.sync_homepage_story_publication();

-- Replace the public selection contract with the durable lead and slots. The
-- section rows remain available for compatibility; the public renderer uses
-- the primary section chronology for its section shelves.
create or replace function public.get_homepage_story_ids(p_now timestamptz default now())
returns table(story_id uuid, placement text, "position" integer)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with eligible as (
    select story.id, story.section_id, story.published_at
    from public.stories story
    where public.homepage_story_is_eligible(story.id, p_now)
  ), lead as (
    select public.homepage_lead_story_id(p_now) as story_id
  ), slots as (
    select slot.position::integer, slot.story_id
    from public.homepage_featured_slots slot
    join eligible on eligible.id = slot.story_id
    where slot.story_id <> (select lead.story_id from lead)
  ), section_candidates as (
    select eligible.id as story_id,
           row_number() over (
             partition by eligible.section_id
             order by eligible.published_at desc, eligible.id
           )::integer as position
    from eligible
    where eligible.id <> (select lead.story_id from lead)
      and not exists (select 1 from slots where slots.story_id = eligible.id)
  ), selected as (
    select lead.story_id, 'lead'::text as placement, 1::integer as position
    from lead
    where lead.story_id is not null
    union all
    select slots.story_id, 'homepage'::text, slots.position
    from slots
    union all
    select section_candidates.story_id, 'section'::text, section_candidates.position
    from section_candidates
    where section_candidates.position <= 3
  )
  select selected.story_id, selected.placement, selected.position
  from selected
  order by case selected.placement when 'lead' then 0 when 'homepage' then 1 else 2 end,
           selected.position,
           selected.story_id;
$function$;

create or replace function public.get_homepage_arrangement_newsroom(p_now timestamptz default now())
returns table (
  story_id uuid,
  story_title text,
  story_slug text,
  story_dek text,
  section_id text,
  section_name text,
  published_at timestamptz,
  placement text,
  "position" integer,
  featured_at timestamptz,
  homepage_featured_requested boolean,
  ranking_state text,
  promotion_override text,
  written_publishable boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if auth.uid() is null or public.current_role() not in ('admin', 'editor') then
    raise exception using errcode = '42501', message = 'editor access is required';
  end if;

  return query
  with all_published as (
    select story.id,
           story.title,
           story.slug,
           story.dek,
           story.section_id,
           section.name as section_name,
           story.published_at,
           story.homepage_featured_requested,
           public.can_publish_story(story) as written_publishable
    from public.stories story
    left join public.sections section on section.id = story.section_id
    where story.status = 'published'
      and story.published_at is not null
      and story.published_at <= p_now
  ), eligible as (
    select all_published.*
    from all_published
    where all_published.written_publishable
  ), settings as (
    select primary_story_id
    from public.homepage_settings
    where id = true
  ), lead as (
    select public.homepage_lead_story_id(p_now) as story_id
  ), slots as (
    select slot.position::integer,
           slot.story_id,
           slot.featured_at
    from public.homepage_featured_slots slot
    join eligible on eligible.id = slot.story_id
    where slot.story_id <> (select lead.story_id from lead)
  ), section_candidates as (
    select eligible.id as story_id,
           row_number() over (
             partition by eligible.section_id
             order by eligible.published_at desc, eligible.id
           )::integer as position
    from eligible
    where eligible.id <> (select lead.story_id from lead)
      and not exists (select 1 from slots where slots.story_id = eligible.id)
  ), placed as (
    select lead.story_id, 'lead'::text as placement, 1::integer as position, null::timestamptz as featured_at
    from lead
    where lead.story_id is not null
    union all
    select slots.story_id, 'homepage'::text, slots.position, slots.featured_at
    from slots
    union all
    select section_candidates.story_id, 'section'::text, section_candidates.position, null::timestamptz
    from section_candidates
    where section_candidates.position <= 3
  )
  select published.id,
         published.title,
         published.slug,
         published.dek,
         published.section_id,
         published.section_name,
         published.published_at,
         coalesce(placed.placement, 'latest') as placement,
         placed.position,
         placed.featured_at,
         published.homepage_featured_requested,
         case
           when placed.placement = 'lead'
             and (select settings.primary_story_id from settings) = published.id then 'manual'
           when placed.placement = 'homepage' and published.homepage_featured_requested then 'manual'
           else 'automatic'
         end as ranking_state,
         case
           when placed.placement = 'lead'
             and (select settings.primary_story_id from settings) = published.id then 'lead'
           when placed.placement = 'homepage' and published.homepage_featured_requested then 'homepage'
           else null
         end as promotion_override,
         published.written_publishable
  from all_published published
  left join placed on placed.story_id = published.id
  order by case coalesce(placed.placement, 'latest')
             when 'lead' then 0
             when 'homepage' then 1
             when 'section' then 2
             else 3
           end,
           placed.position nulls last,
           published.published_at desc,
           published.id;
end
$function$;

revoke all on function public.get_homepage_arrangement_newsroom(timestamptz) from public, anon;
grant execute on function public.get_homepage_arrangement_newsroom(timestamptz) to authenticated;
grant execute on function public.get_homepage_story_ids(timestamptz) to anon, authenticated;

commit;
