-- Rename the public NFT desk, add Memecoins, and make secondary story sections editable.
-- The stable digital-collectibles id is retained for existing records; the Worker
-- permanently redirects its former public URL to /sections/nfts.
begin;

alter table public.sections drop constraint if exists sections_web3_ids;
alter table public.sections drop constraint if exists sections_web3_slugs;

insert into public.sections (id, slug, name, template) values
  ('digital-collectibles', 'nfts', 'NFTs', E'## The collection\n\n## The market\n\n## The culture'),
  ('memecoins', 'memecoins', 'Memecoins', E'## The joke\n\n## The community\n\n## The market')
on conflict (id) do update set slug = excluded.slug, name = excluded.name, template = excluded.template;

update public.tags set name = 'NFTs' where slug = 'digital-collectibles' or lower(name) = 'digital collectibles';
update public.source_registry
set description = regexp_replace(description, 'digital[- ]collectibles', 'NFT', 'gi'),
    topic_tags = array(
      select case when lower(btrim(tag)) = 'digital collectibles' then 'nfts' else tag end
      from unnest(topic_tags) with ordinality as topic(tag, position)
      order by position
    );

create or replace function public.prepare_source_registry_record() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.identity_key is null or btrim(new.identity_key) = '' then
    new.identity_key = 'pending:' || regexp_replace(lower(btrim(new.name)), '[^a-z0-9]+', '-', 'g');
  end if;
  new.primary_sections = array(
    select case lower(btrim(item))
      when 'digital collectibles' then 'digital-collectibles'
      when 'digital-collectibles' then 'digital-collectibles'
      when 'nft' then 'digital-collectibles'
      when 'nfts' then 'digital-collectibles'
      when 'defi' then 'defi'
      when 'markets' then 'markets'
      when 'chains' then 'chains'
      when 'products' then 'products'
      when 'culture' then 'culture'
      when 'memecoins' then 'memecoins'
      when 'security' then null
      when 'investigations' then null
      else btrim(item)
    end
    from unnest(new.primary_sections) with ordinality as section(item, position)
    where lower(btrim(item)) not in ('security', 'investigations')
    order by position
  );
  new.topic_tags = array(
    select case when lower(btrim(item)) = 'digital collectibles' then 'nfts' else item end
    from unnest(new.topic_tags) with ordinality as topic(item, position)
    order by position
  );
  if new.name = 'ZachXBT' then
    new.topic_tags = array(select distinct item from unnest(new.topic_tags || array['security', 'investigations']) as tag(item));
  end if;
  if new.review_status = 'review_needed' then
    new.direct_publish_eligible = false;
    new.requires_primary_source_lookup = true;
  end if;
  return new;
end;
$$;

alter table public.sections add constraint sections_web3_ids
  check (id in ('digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture', 'memecoins'));
alter table public.sections add constraint sections_web3_slugs
  check (slug in ('nfts', 'defi', 'markets', 'chains', 'products', 'culture', 'memecoins'));

alter table public.editorial_candidates drop constraint if exists editorial_candidates_primary_section_check;
alter table public.editorial_candidates add constraint editorial_candidates_primary_section_check
  check (primary_section in ('digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture', 'memecoins'));

create or replace function public.can_publish_story(s public.stories) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select nullif(btrim(s.title), '') is not null
    and nullif(btrim(s.slug), '') is not null
    and nullif(btrim(s.dek), '') is not null
    and nullif(btrim(s.body), '') is not null
    and exists (select 1 from public.sections section where section.id = s.section_id)
    and s.author_id is not null
    and nullif(btrim(s.seo_title), '') is not null
    and nullif(btrim(s.seo_description), '') is not null
    and exists (select 1 from public.profiles editor where editor.id = s.editor_id and editor.role in ('admin', 'editor'))
    and exists (select 1 from public.sources source where source.story_id = s.id and btrim(source.url) ~* '^https?://')
$$;

drop policy if exists "newsroom manages story sections" on public.story_sections;
create policy "newsroom manages story sections" on public.story_sections for all to authenticated
using (
  public.is_editor() or exists (
    select 1 from public.stories story
    where story.id = story_sections.story_id
      and story.author_id = auth.uid()
      and story.status in ('idea', 'researching', 'draft', 'review')
  )
)
with check (
  public.is_editor() or exists (
    select 1 from public.stories story
    where story.id = story_sections.story_id
      and story.author_id = auth.uid()
      and story.status in ('idea', 'researching', 'draft', 'review')
  )
);

create or replace function public.save_story(
  p_story_id uuid,
  p_expected_revision integer,
  p_patch jsonb,
  p_beat_ids uuid[],
  p_tags text[],
  p_section_ids text[]
)
returns public.stories
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  saved_story public.stories%rowtype;
  invalid_section text;
begin
  select requested.section_id into invalid_section
  from unnest(coalesce(p_section_ids, '{}'::text[])) as requested(section_id)
  where not exists (select 1 from public.sections section where section.id = requested.section_id)
  limit 1;
  if invalid_section is not null then
    raise exception using errcode = '23503', message = 'an additional section is not valid';
  end if;

  saved_story := public.save_story(p_story_id, p_expected_revision, p_patch, p_beat_ids, p_tags);

  delete from public.story_sections where story_id = p_story_id;
  insert into public.story_sections(story_id, section_id)
  select p_story_id, requested.section_id
  from (select distinct section_id from unnest(coalesce(p_section_ids, '{}'::text[])) as item(section_id)) requested
  where requested.section_id <> saved_story.section_id;

  return saved_story;
end
$function$;

grant execute on function public.save_story(uuid, integer, jsonb, uuid[], text[], text[]) to authenticated;

create or replace function public.editorial_pitch_is_valid(p_classification jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog, public as $$
declare
  pitch jsonb := p_classification -> 'editorial_pitch';
  tests jsonb;
  rationales jsonb;
  evidence jsonb;
begin
  if jsonb_typeof(p_classification) is distinct from 'object'
     or jsonb_typeof(pitch) is distinct from 'object'
     or jsonb_typeof(pitch -> 'accepted') is distinct from 'boolean'
     or (pitch ->> 'accepted')::boolean is not true
     or coalesce(p_classification ->> 'primary_section', '') not in (
       'digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture', 'memecoins',
       'internet', 'taste', 'systems', 'modern-life', 'builders', 'media'
     )
     or coalesce(p_classification ->> 'story_form', '') not in ('meanwhile','while-youre-here','worth-your-time','receipts','anyways','we-read-it','builders','systems')
     or pitch ->> 'primary_section' is distinct from p_classification ->> 'primary_section'
     or pitch ->> 'story_form' is distinct from p_classification ->> 'story_form'
     or (p_classification ->> 'pipeline_version' = 'pipeline-v1' and coalesce(pitch ->> 'research_requirement', '') not in ('none','required'))
     or jsonb_typeof(pitch -> 'headline') is distinct from 'string' or length(btrim(pitch ->> 'headline')) not between 1 and 140
     or jsonb_typeof(pitch -> 'lens') is distinct from 'string' or length(btrim(pitch ->> 'lens')) not between 45 and 420
     or jsonb_typeof(pitch -> 'section_answer') is distinct from 'string' or length(btrim(pitch ->> 'section_answer')) not between 35 and 420
     or jsonb_typeof(pitch -> 'why_now') is distinct from 'string' or length(btrim(pitch ->> 'why_now')) not between 35 and 420
     or jsonb_typeof(pitch -> 'reader_takeaway') is distinct from 'string' or length(btrim(pitch ->> 'reader_takeaway')) not between 25 and 320
     or jsonb_typeof(pitch -> 'significance_tests') is distinct from 'array'
     or jsonb_typeof(pitch -> 'significance_rationales') is distinct from 'object'
     or jsonb_typeof(pitch -> 'evidence_plan') is distinct from 'array'
     or nullif(btrim(pitch ->> 'prompt_version'), '') is null then
    return false;
  end if;
  tests := pitch -> 'significance_tests';
  rationales := pitch -> 'significance_rationales';
  evidence := pitch -> 'evidence_plan';
  if jsonb_array_length(tests) < 2
     or jsonb_array_length(tests) <> (select count(distinct value) from jsonb_array_elements_text(tests))
     or (select count(*) from jsonb_object_keys(rationales)) <> jsonb_array_length(tests)
     or exists (
       select 1 from jsonb_array_elements_text(tests) test
       where test not in ('changes what people can do','changes what people want','changes who has power','reveals a hidden system','explains how attention moves','shows how online culture affects reality','reveals a new way to build something','explains why a person, company, movement, or object matters','reflects a broader cultural change','helps readers understand the modern world differently')
          or jsonb_typeof(rationales -> test) is distinct from 'string'
          or length(btrim(rationales ->> test)) < 24
     )
     or exists (select 1 from jsonb_object_keys(rationales) key where not tests ? key)
     or jsonb_array_length(evidence) not between 2 and 5
     or exists (select 1 from jsonb_array_elements(evidence) item where jsonb_typeof(item) is distinct from 'string' or length(btrim(item #>> '{}')) < 20 or btrim(item #>> '{}') ~* '^(look for|find|research|sources?|evidence|examples?)\M')
     or jsonb_array_length(evidence) <> (select count(distinct lower(btrim(value))) from jsonb_array_elements_text(evidence)) then
    return false;
  end if;
  if (pitch ->> 'story_form') in ('receipts','anyways','systems','we-read-it')
     and not exists (select 1 from jsonb_array_elements_text(evidence) item where item ~* '\m(document|filing|law|regulation|dataset|report|record|transcript|court|policy|official|primary source)\M') then
    return false;
  end if;
  return true;
exception when others then
  return false;
end $$;

revoke all on function public.editorial_pitch_is_valid(jsonb) from public, anon, authenticated;
grant execute on function public.editorial_pitch_is_valid(jsonb) to service_role;

commit;
