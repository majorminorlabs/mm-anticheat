


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."newsroom_role" AS ENUM (
    'admin',
    'editor',
    'contributor'
);


ALTER TYPE "public"."newsroom_role" OWNER TO "postgres";


CREATE TYPE "public"."pipeline_candidate_status" AS ENUM (
    'discovered',
    'watching',
    'rejected',
    'researching',
    'research_blocked',
    'ready_to_draft',
    'drafting',
    'verification_failed',
    'editing',
    'ready_for_review',
    'revision_requested',
    'approved',
    'rejected_by_editor',
    'archived'
);


ALTER TYPE "public"."pipeline_candidate_status" OWNER TO "postgres";


CREATE TYPE "public"."source_kind" AS ENUM (
    'article',
    'official_announcement',
    'filing',
    'research_paper',
    'court_document',
    'legislation',
    'earnings_report',
    'documentation',
    'video',
    'podcast',
    'social_post',
    'dataset',
    'repository',
    'other'
);


ALTER TYPE "public"."source_kind" OWNER TO "postgres";


CREATE TYPE "public"."story_status" AS ENUM (
    'idea',
    'researching',
    'draft',
    'review',
    'fact_check',
    'scheduled',
    'published',
    'archived'
);


ALTER TYPE "public"."story_status" OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."stories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" DEFAULT ''::"text" NOT NULL,
    "slug" "text" NOT NULL,
    "dek" "text" DEFAULT ''::"text" NOT NULL,
    "summary" "text" DEFAULT ''::"text" NOT NULL,
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "section_id" "text",
    "author_id" "uuid",
    "editor_id" "uuid",
    "status" "public"."story_status" DEFAULT 'idea'::"public"."story_status" NOT NULL,
    "published_at" timestamp with time zone,
    "scheduled_for" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reading_time_minutes" integer DEFAULT 1 NOT NULL,
    "hero_media_id" "uuid",
    "seo_title" "text" DEFAULT ''::"text" NOT NULL,
    "seo_description" "text" DEFAULT ''::"text" NOT NULL,
    "social_title" "text",
    "social_description" "text",
    "featured" boolean DEFAULT false NOT NULL,
    "homepage_priority" integer DEFAULT 0 NOT NULL,
    "homepage_hidden" boolean DEFAULT false NOT NULL,
    "canonical_url" "text",
    "revision_number" integer DEFAULT 1 NOT NULL
);


ALTER TABLE "public"."stories" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_publish_story"("s" "public"."stories") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  select nullif(btrim(s.title), '') is not null and nullif(btrim(s.slug), '') is not null and nullif(btrim(s.dek), '') is not null and nullif(btrim(s.body), '') is not null and s.section_id in ('internet','taste','systems','modern-life','builders','media') and s.author_id is not null and nullif(btrim(s.seo_title), '') is not null and nullif(btrim(s.seo_description), '') is not null and exists (select 1 from public.profiles editor where editor.id = s.editor_id and editor.role in ('admin','editor')) and exists (select 1 from public.sources source where source.story_id = s.id) and not exists (select 1 from public.sources source where source.story_id = s.id and btrim(source.url) !~* '^https?://')
$$;


ALTER FUNCTION "public"."can_publish_story"("s" "public"."stories") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_role"() RETURNS "public"."newsroom_role"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
$$;


ALTER FUNCTION "public"."current_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_published_story_sources"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."guard_published_story_sources"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_story_workflow"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if public.current_role() = 'contributor' then
    if new.author_id <> auth.uid() or new.status not in ('idea','researching','draft','review') then raise exception 'contributors may only edit their own work through review'; end if;
  end if;
  if new.status = 'published' and not public.can_publish_story(new) then raise exception 'story does not meet publishing requirements'; end if;
  if new.status = 'scheduled' and new.scheduled_for is null then raise exception 'scheduled stories require a publishing time'; end if;
  new.updated_at := now();
  if new.status = 'published' and new.published_at is null then new.published_at := now(); end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."guard_story_workflow"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_editor"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  select coalesce(public.current_role() in ('admin', 'editor'), false)
$$;


ALTER FUNCTION "public"."is_editor"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."materialize_pipeline_story"("p_candidate_id" "uuid") RETURNS TABLE("story_id" "uuid", "created" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
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

  -- Lock the candidate before looking for an existing link. Concurrent clicks
  -- serialize here, then the link primary key provides a second hard guard.
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

  requested_section := nullif(btrim(candidate.classification ->> 'primary_section'), '');
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

  -- No pipeline image is copied. A story can receive media only through the
  -- normal editor-controlled media workflow after rights are verified.
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
$$;


ALTER FUNCTION "public"."materialize_pipeline_story"("p_candidate_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_story"("p_story_id" "uuid", "p_expected_revision" integer, "p_patch" "jsonb", "p_beat_ids" "uuid"[], "p_tags" "text"[]) RETURNS "public"."stories"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
declare current_story public.stories%rowtype; saved_story public.stories%rowtype; clean_tag text;
begin
  if auth.uid() is null or public.current_role() is null then raise exception 'newsroom membership is required' using errcode = '42501'; end if;
  select * into current_story from public.stories where id = p_story_id for update;
  if not found then raise exception 'story was not found' using errcode = 'P0002'; end if;
  if current_story.revision_number <> p_expected_revision then raise exception 'story revision conflict' using errcode = '40001'; end if;
  if not (public.is_editor() or (current_story.author_id = auth.uid() and current_story.status in ('idea','researching','draft','review'))) then raise exception 'this story cannot be edited by the current account' using errcode = '42501'; end if;
  update public.stories set title=coalesce(p_patch->>'title',current_story.title), slug=coalesce(p_patch->>'slug',current_story.slug), dek=coalesce(p_patch->>'dek',current_story.dek), summary=coalesce(p_patch->>'summary',current_story.summary), body=coalesce(p_patch->>'body',current_story.body), section_id=coalesce(p_patch->>'section_id',current_story.section_id), author_id=coalesce(nullif(p_patch->>'author_id','')::uuid,current_story.author_id), editor_id=case when p_patch ? 'editor_id' then nullif(p_patch->>'editor_id','')::uuid else current_story.editor_id end, status=coalesce((p_patch->>'status')::public.story_status,current_story.status), published_at=coalesce((p_patch->>'published_at')::timestamptz,current_story.published_at), reading_time_minutes=coalesce((p_patch->>'reading_time_minutes')::integer,current_story.reading_time_minutes), seo_title=coalesce(p_patch->>'seo_title',current_story.seo_title), seo_description=coalesce(p_patch->>'seo_description',current_story.seo_description), revision_number=current_story.revision_number+1 where id=p_story_id returning * into saved_story;
  delete from public.story_beats where story_id=p_story_id; insert into public.story_beats(story_id,beat_id) select p_story_id, id from public.beats where id = any(coalesce(p_beat_ids,'{}'));
  delete from public.story_tags where story_id=p_story_id;
  foreach clean_tag in array coalesce(p_tags,'{}') loop clean_tag:=lower(regexp_replace(btrim(clean_tag),'[^a-z0-9]+','-','g')); clean_tag:=trim(both '-' from clean_tag); if clean_tag <> '' then insert into public.tags(slug,name) values(clean_tag, initcap(replace(clean_tag,'-',' '))) on conflict(slug) do nothing; insert into public.story_tags(story_id,tag_id) select p_story_id,id from public.tags where slug=clean_tag on conflict do nothing; end if; end loop;
  return saved_story;
end $$;


ALTER FUNCTION "public"."save_story"("p_story_id" "uuid", "p_expected_revision" integer, "p_patch" "jsonb", "p_beat_ids" "uuid"[], "p_tags" "text"[]) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."beats" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    CONSTRAINT "beats_slug_check" CHECK (("slug" = ANY (ARRAY['ai'::"text", 'music'::"text", 'brands'::"text", 'cities'::"text", 'fashion'::"text", 'subcultures'::"text", 'design'::"text", 'architecture'::"text", 'food'::"text", 'sports'::"text", 'automotive'::"text", 'gaming'::"text", 'film-tv'::"text", 'retail'::"text", 'travel'::"text", 'luxury'::"text"])))
);


ALTER TABLE "public"."beats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."candidate_stories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cluster_key" "text" NOT NULL,
    "title" "text",
    "canonical_url" "text",
    "status" "public"."pipeline_candidate_status" DEFAULT 'discovered'::"public"."pipeline_candidate_status" NOT NULL,
    "classification" "jsonb",
    "model" "text",
    "prompt_version" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "external_id" "text"
);


ALTER TABLE "public"."candidate_stories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."discovered_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_id" "uuid",
    "source_id" "uuid",
    "url" "text" NOT NULL,
    "normalized_url" "text" NOT NULL,
    "canonical_url" "text",
    "title" "text",
    "description" "text",
    "author" "text",
    "published_at" timestamp with time zone,
    "raw_discovery" "jsonb" NOT NULL,
    "fetched_at" timestamp with time zone,
    "extraction_method" "text",
    "extraction_status" "text",
    "raw_html" "text",
    "extracted_text" "text",
    "paywalled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."discovered_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."discovery_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "counts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error" "text"
);


ALTER TABLE "public"."discovery_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."editorial_taxonomy_review" (
    "story_id" "uuid" NOT NULL,
    "legacy_section_id" "text" NOT NULL,
    "mapped_section_id" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."editorial_taxonomy_review" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."homepage_settings" (
    "id" boolean DEFAULT true NOT NULL,
    "primary_story_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid",
    CONSTRAINT "homepage_settings_id_check" CHECK ("id")
);


ALTER TABLE "public"."homepage_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."image_candidates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_id" "uuid" NOT NULL,
    "original_url" "text" NOT NULL,
    "source_page" "text",
    "creator" "text",
    "caption" "text",
    "license" "text",
    "rights_status" "text" NOT NULL,
    "width" integer,
    "height" integer,
    "file_type" "text",
    "proposed_role" "text",
    "warning_flags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "selected" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "image_candidates_rights_status_check" CHECK (("rights_status" = ANY (ARRAY['verified_reusable'::"text", 'official_press_asset'::"text", 'permission_required'::"text", 'unknown'::"text", 'do_not_use'::"text"])))
);


ALTER TABLE "public"."image_candidates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."legacy_taxonomy_mappings" (
    "legacy_kind" "text" NOT NULL,
    "legacy_slug" "text" NOT NULL,
    "target_kind" "text" NOT NULL,
    "target_slug" "text" NOT NULL,
    "review_required" boolean DEFAULT false NOT NULL,
    "rationale" "text" NOT NULL,
    CONSTRAINT "legacy_taxonomy_mappings_legacy_kind_check" CHECK (("legacy_kind" = ANY (ARRAY['section'::"text", 'topic'::"text"]))),
    CONSTRAINT "legacy_taxonomy_mappings_target_kind_check" CHECK (("target_kind" = ANY (ARRAY['section'::"text", 'beat'::"text", 'tag'::"text"])))
);


ALTER TABLE "public"."legacy_taxonomy_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "storage_path" "text" NOT NULL,
    "public_url" "text" NOT NULL,
    "filename" "text" NOT NULL,
    "mime_type" "text" NOT NULL,
    "width" integer,
    "height" integer,
    "alt_text" "text" NOT NULL,
    "caption" "text",
    "credit" "text",
    "source_url" "text",
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."media" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_claim_sources" (
    "claim_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL
);


ALTER TABLE "public"."pipeline_claim_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "draft_id" "uuid" NOT NULL,
    "claim" "text" NOT NULL,
    "status" "text" NOT NULL,
    "note" "text",
    "resolved_at" timestamp with time zone,
    "resolved_by" "uuid"
);


ALTER TABLE "public"."pipeline_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_drafts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_id" "uuid" NOT NULL,
    "version" integer NOT NULL,
    "headline" "text",
    "dek" "text",
    "body_markdown" "text" NOT NULL,
    "prior_draft_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_drafts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_review_decisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "action" "text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "previous_state" "public"."pipeline_candidate_status",
    "new_state" "public"."pipeline_candidate_status",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "pipeline_review_decisions_action_check" CHECK (("action" = ANY (ARRAY['approve'::"text", 'reject'::"text", 'request_revision'::"text", 'archive'::"text", 'edit'::"text", 'resolve_claim'::"text", 'remove_source'::"text", 'select_image'::"text", 'reject_image'::"text", 'materialize'::"text"])))
);


ALTER TABLE "public"."pipeline_review_decisions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_id" "uuid",
    "model" "text" NOT NULL,
    "status" "text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "artifact_path" "text",
    "error" "text",
    "fingerprint" "text",
    "reused" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."pipeline_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "source_type" "text" NOT NULL,
    "locator" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "priority" integer DEFAULT 100 NOT NULL,
    "default_tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "default_beats" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "polling_frequency_minutes" integer,
    "last_checked_at" timestamp with time zone,
    "last_successful_check_at" timestamp with time zone,
    "failure_count" integer DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pipeline_sources_source_type_check" CHECK (("source_type" = ANY (ARRAY['rss'::"text", 'atom'::"text", 'sitemap'::"text", 'homepage'::"text", 'website'::"text", 'search_query'::"text", 'manual_url'::"text"])))
);


ALTER TABLE "public"."pipeline_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_stage_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pipeline_run_id" "uuid" NOT NULL,
    "stage" "text" NOT NULL,
    "attempt" integer NOT NULL,
    "raw_response" "text",
    "validation_errors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pipeline_stage_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_story_links" (
    "candidate_id" "uuid" NOT NULL,
    "story_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_draft_id" "uuid",
    "source_draft_version" integer,
    "actor_id" "uuid",
    "prior_candidate_status" "public"."pipeline_candidate_status",
    "result" "text" DEFAULT 'created'::"text" NOT NULL,
    CONSTRAINT "pipeline_story_links_result_check" CHECK (("result" = ANY (ARRAY['created'::"text", 'existing'::"text"])))
);


ALTER TABLE "public"."pipeline_story_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "role" "public"."newsroom_role" DEFAULT 'contributor'::"public"."newsroom_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."research_packets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "candidate_id" "uuid" NOT NULL,
    "iteration" integer NOT NULL,
    "packet" "jsonb" NOT NULL,
    "sufficiency" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."research_packets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."revisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "story_id" "uuid",
    "revision_number" integer NOT NULL,
    "snapshot" "jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "change_note" "text"
);


ALTER TABLE "public"."revisions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."search_logs" (
    "id" bigint NOT NULL,
    "query" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."search_logs" OWNER TO "postgres";


ALTER TABLE "public"."search_logs" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."search_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."sections" (
    "id" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "template" "text" DEFAULT ''::"text" NOT NULL,
    CONSTRAINT "sections_canonical_ids" CHECK (("id" = ANY (ARRAY['internet'::"text", 'taste'::"text", 'systems'::"text", 'modern-life'::"text", 'builders'::"text", 'media'::"text"]))),
    CONSTRAINT "sections_canonical_slugs" CHECK (("slug" = ANY (ARRAY['internet'::"text", 'taste'::"text", 'systems'::"text", 'modern-life'::"text", 'builders'::"text", 'media'::"text"])))
);


ALTER TABLE "public"."sections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "story_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "publisher" "text",
    "url" "text" NOT NULL,
    "normalized_url" "text" NOT NULL,
    "source_type" "public"."source_kind" DEFAULT 'article'::"public"."source_kind" NOT NULL,
    "author" "text",
    "published_at" timestamp with time zone,
    "accessed_at" timestamp with time zone,
    "archive_url" "text",
    "note" "text",
    "sort_order" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid"
);


ALTER TABLE "public"."sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."story_beats" (
    "story_id" "uuid" NOT NULL,
    "beat_id" "uuid" NOT NULL
);


ALTER TABLE "public"."story_beats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."story_related" (
    "story_id" "uuid" NOT NULL,
    "related_story_id" "uuid" NOT NULL,
    CONSTRAINT "story_related_check" CHECK (("story_id" <> "related_story_id"))
);


ALTER TABLE "public"."story_related" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."story_tags" (
    "story_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL
);


ALTER TABLE "public"."story_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tags" OWNER TO "postgres";


ALTER TABLE ONLY "public"."beats"
    ADD CONSTRAINT "beats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."beats"
    ADD CONSTRAINT "beats_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."candidate_stories"
    ADD CONSTRAINT "candidate_stories_cluster_key_key" UNIQUE ("cluster_key");



ALTER TABLE ONLY "public"."candidate_stories"
    ADD CONSTRAINT "candidate_stories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discovered_documents"
    ADD CONSTRAINT "discovered_documents_normalized_url_key" UNIQUE ("normalized_url");



ALTER TABLE ONLY "public"."discovered_documents"
    ADD CONSTRAINT "discovered_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discovery_runs"
    ADD CONSTRAINT "discovery_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."editorial_taxonomy_review"
    ADD CONSTRAINT "editorial_taxonomy_review_pkey" PRIMARY KEY ("story_id");



ALTER TABLE ONLY "public"."homepage_settings"
    ADD CONSTRAINT "homepage_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."image_candidates"
    ADD CONSTRAINT "image_candidates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."legacy_taxonomy_mappings"
    ADD CONSTRAINT "legacy_taxonomy_mappings_pkey" PRIMARY KEY ("legacy_slug");



ALTER TABLE ONLY "public"."media"
    ADD CONSTRAINT "media_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_claim_sources"
    ADD CONSTRAINT "pipeline_claim_sources_pkey" PRIMARY KEY ("claim_id", "document_id");



ALTER TABLE ONLY "public"."pipeline_claims"
    ADD CONSTRAINT "pipeline_claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_drafts"
    ADD CONSTRAINT "pipeline_drafts_candidate_id_version_key" UNIQUE ("candidate_id", "version");



ALTER TABLE ONLY "public"."pipeline_drafts"
    ADD CONSTRAINT "pipeline_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_review_decisions"
    ADD CONSTRAINT "pipeline_review_decisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_runs"
    ADD CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_sources"
    ADD CONSTRAINT "pipeline_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_stage_attempts"
    ADD CONSTRAINT "pipeline_stage_attempts_pipeline_run_id_stage_attempt_key" UNIQUE ("pipeline_run_id", "stage", "attempt");



ALTER TABLE ONLY "public"."pipeline_stage_attempts"
    ADD CONSTRAINT "pipeline_stage_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_story_links"
    ADD CONSTRAINT "pipeline_story_links_pkey" PRIMARY KEY ("candidate_id");



ALTER TABLE ONLY "public"."pipeline_story_links"
    ADD CONSTRAINT "pipeline_story_links_story_id_key" UNIQUE ("story_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."research_packets"
    ADD CONSTRAINT "research_packets_candidate_id_iteration_key" UNIQUE ("candidate_id", "iteration");



ALTER TABLE ONLY "public"."research_packets"
    ADD CONSTRAINT "research_packets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."revisions"
    ADD CONSTRAINT "revisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."revisions"
    ADD CONSTRAINT "revisions_story_id_revision_number_key" UNIQUE ("story_id", "revision_number");



ALTER TABLE ONLY "public"."search_logs"
    ADD CONSTRAINT "search_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sections"
    ADD CONSTRAINT "sections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sections"
    ADD CONSTRAINT "sections_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."sources"
    ADD CONSTRAINT "sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sources"
    ADD CONSTRAINT "sources_story_id_normalized_url_key" UNIQUE ("story_id", "normalized_url");



ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."story_beats"
    ADD CONSTRAINT "story_beats_pkey" PRIMARY KEY ("story_id", "beat_id");



ALTER TABLE ONLY "public"."story_related"
    ADD CONSTRAINT "story_related_pkey" PRIMARY KEY ("story_id", "related_story_id");



ALTER TABLE ONLY "public"."story_tags"
    ADD CONSTRAINT "story_tags_pkey" PRIMARY KEY ("story_id", "tag_id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_slug_key" UNIQUE ("slug");



CREATE UNIQUE INDEX "candidate_stories_external_id_key" ON "public"."candidate_stories" USING "btree" ("external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "candidate_stories_status_updated_idx" ON "public"."candidate_stories" USING "btree" ("status", "updated_at" DESC);



CREATE INDEX "discovered_documents_candidate_idx" ON "public"."discovered_documents" USING "btree" ("candidate_id");



CREATE INDEX "image_candidates_candidate_idx" ON "public"."image_candidates" USING "btree" ("candidate_id");



CREATE INDEX "pipeline_claims_draft_idx" ON "public"."pipeline_claims" USING "btree" ("draft_id");



CREATE INDEX "pipeline_drafts_candidate_version_idx" ON "public"."pipeline_drafts" USING "btree" ("candidate_id", "version" DESC);



CREATE INDEX "pipeline_review_decisions_candidate_created_idx" ON "public"."pipeline_review_decisions" USING "btree" ("candidate_id", "created_at" DESC);



CREATE UNIQUE INDEX "pipeline_runs_candidate_fingerprint_key" ON "public"."pipeline_runs" USING "btree" ("candidate_id", "fingerprint") WHERE ("fingerprint" IS NOT NULL);



CREATE CONSTRAINT TRIGGER "ensure_published_story_has_source" AFTER INSERT OR DELETE OR UPDATE ON "public"."sources" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."guard_published_story_sources"();



CREATE OR REPLACE TRIGGER "guard_story_workflow" BEFORE INSERT OR UPDATE ON "public"."stories" FOR EACH ROW EXECUTE FUNCTION "public"."guard_story_workflow"();



ALTER TABLE ONLY "public"."discovered_documents"
    ADD CONSTRAINT "discovered_documents_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."discovered_documents"
    ADD CONSTRAINT "discovered_documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."pipeline_sources"("id");



ALTER TABLE ONLY "public"."editorial_taxonomy_review"
    ADD CONSTRAINT "editorial_taxonomy_review_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."homepage_settings"
    ADD CONSTRAINT "homepage_settings_primary_story_id_fkey" FOREIGN KEY ("primary_story_id") REFERENCES "public"."stories"("id");



ALTER TABLE ONLY "public"."homepage_settings"
    ADD CONSTRAINT "homepage_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."image_candidates"
    ADD CONSTRAINT "image_candidates_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."media"
    ADD CONSTRAINT "media_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pipeline_claim_sources"
    ADD CONSTRAINT "pipeline_claim_sources_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."pipeline_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_claim_sources"
    ADD CONSTRAINT "pipeline_claim_sources_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."discovered_documents"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."pipeline_claims"
    ADD CONSTRAINT "pipeline_claims_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "public"."pipeline_drafts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_claims"
    ADD CONSTRAINT "pipeline_claims_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pipeline_drafts"
    ADD CONSTRAINT "pipeline_drafts_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_drafts"
    ADD CONSTRAINT "pipeline_drafts_prior_draft_id_fkey" FOREIGN KEY ("prior_draft_id") REFERENCES "public"."pipeline_drafts"("id");



ALTER TABLE ONLY "public"."pipeline_review_decisions"
    ADD CONSTRAINT "pipeline_review_decisions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pipeline_review_decisions"
    ADD CONSTRAINT "pipeline_review_decisions_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_runs"
    ADD CONSTRAINT "pipeline_runs_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_stage_attempts"
    ADD CONSTRAINT "pipeline_stage_attempts_pipeline_run_id_fkey" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_story_links"
    ADD CONSTRAINT "pipeline_story_links_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pipeline_story_links"
    ADD CONSTRAINT "pipeline_story_links_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_story_links"
    ADD CONSTRAINT "pipeline_story_links_source_draft_id_fkey" FOREIGN KEY ("source_draft_id") REFERENCES "public"."pipeline_drafts"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."pipeline_story_links"
    ADD CONSTRAINT "pipeline_story_links_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."research_packets"
    ADD CONSTRAINT "research_packets_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."revisions"
    ADD CONSTRAINT "revisions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."revisions"
    ADD CONSTRAINT "revisions_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sources"
    ADD CONSTRAINT "sources_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."sources"
    ADD CONSTRAINT "sources_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_editor_id_fkey" FOREIGN KEY ("editor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_hero_media_id_fkey" FOREIGN KEY ("hero_media_id") REFERENCES "public"."media"("id");



ALTER TABLE ONLY "public"."stories"
    ADD CONSTRAINT "stories_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id");



ALTER TABLE ONLY "public"."story_beats"
    ADD CONSTRAINT "story_beats_beat_id_fkey" FOREIGN KEY ("beat_id") REFERENCES "public"."beats"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."story_beats"
    ADD CONSTRAINT "story_beats_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."story_related"
    ADD CONSTRAINT "story_related_related_story_id_fkey" FOREIGN KEY ("related_story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."story_related"
    ADD CONSTRAINT "story_related_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."story_tags"
    ADD CONSTRAINT "story_tags_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."story_tags"
    ADD CONSTRAINT "story_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE RESTRICT;



ALTER TABLE "public"."beats" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."candidate_stories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contributors create own stories" ON "public"."stories" FOR INSERT TO "authenticated" WITH CHECK (("author_id" = "auth"."uid"()));



CREATE POLICY "contributors edit own unfinished stories" ON "public"."stories" FOR UPDATE TO "authenticated" USING ((("author_id" = "auth"."uid"()) AND ("status" = ANY (ARRAY['idea'::"public"."story_status", 'researching'::"public"."story_status", 'draft'::"public"."story_status", 'review'::"public"."story_status"])))) WITH CHECK ((("author_id" = "auth"."uid"()) AND ("status" = ANY (ARRAY['idea'::"public"."story_status", 'researching'::"public"."story_status", 'draft'::"public"."story_status", 'review'::"public"."story_status"]))));



CREATE POLICY "contributors upload media" ON "public"."media" FOR INSERT TO "authenticated" WITH CHECK (("uploaded_by" = "auth"."uid"()));



ALTER TABLE "public"."discovered_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discovery_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."editorial_taxonomy_review" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "editors manage homepage" ON "public"."homepage_settings" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage local pipeline" ON "public"."pipeline_sources" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage local pipeline candidates" ON "public"."candidate_stories" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage local pipeline data" ON "public"."discovered_documents" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage local pipeline review" ON "public"."pipeline_review_decisions" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage pipeline claims" ON "public"."pipeline_claims" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage pipeline drafts" ON "public"."pipeline_drafts" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage pipeline images" ON "public"."image_candidates" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage pipeline story links" ON "public"."pipeline_story_links" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage related stories" ON "public"."story_related" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage stories" ON "public"."stories" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors manage tags" ON "public"."tags" TO "authenticated" USING ("public"."is_editor"()) WITH CHECK ("public"."is_editor"());



CREATE POLICY "editors read discovery runs" ON "public"."discovery_runs" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read legacy taxonomy mappings" ON "public"."legacy_taxonomy_mappings" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read local pipeline candidates" ON "public"."candidate_stories" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read local pipeline data" ON "public"."discovered_documents" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline attempts" ON "public"."pipeline_stage_attempts" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline claim sources" ON "public"."pipeline_claim_sources" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline claims" ON "public"."pipeline_claims" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline drafts" ON "public"."pipeline_drafts" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline images" ON "public"."image_candidates" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline research" ON "public"."research_packets" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline review decisions" ON "public"."pipeline_review_decisions" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline runs" ON "public"."pipeline_runs" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline sources" ON "public"."pipeline_sources" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read pipeline story links" ON "public"."pipeline_story_links" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors read revisions" ON "public"."revisions" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors review taxonomy mappings" ON "public"."editorial_taxonomy_review" FOR SELECT TO "authenticated" USING ("public"."is_editor"());



CREATE POLICY "editors write revisions" ON "public"."revisions" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_editor"());



ALTER TABLE "public"."homepage_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."image_candidates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."legacy_taxonomy_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "newsroom creates tags" ON "public"."tags" FOR INSERT TO "authenticated" WITH CHECK (("public"."current_role"() IS NOT NULL));



CREATE POLICY "newsroom manages sources" ON "public"."sources" TO "authenticated" USING (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "sources"."story_id") AND ("s"."author_id" = "auth"."uid"()) AND ("s"."status" = ANY (ARRAY['idea'::"public"."story_status", 'researching'::"public"."story_status", 'draft'::"public"."story_status", 'review'::"public"."story_status"]))))))) WITH CHECK (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "sources"."story_id") AND ("s"."author_id" = "auth"."uid"()) AND ("s"."status" = ANY (ARRAY['idea'::"public"."story_status", 'researching'::"public"."story_status", 'draft'::"public"."story_status", 'review'::"public"."story_status"])))))));



CREATE POLICY "newsroom manages story beats" ON "public"."story_beats" TO "authenticated" USING (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_beats"."story_id") AND ("s"."author_id" = "auth"."uid"()) AND ("s"."status" = ANY (ARRAY['idea'::"public"."story_status", 'researching'::"public"."story_status", 'draft'::"public"."story_status", 'review'::"public"."story_status"]))))))) WITH CHECK (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_beats"."story_id") AND ("s"."author_id" = "auth"."uid"()) AND ("s"."status" = ANY (ARRAY['idea'::"public"."story_status", 'researching'::"public"."story_status", 'draft'::"public"."story_status", 'review'::"public"."story_status"])))))));



CREATE POLICY "newsroom manages story tags" ON "public"."story_tags" TO "authenticated" USING (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_tags"."story_id") AND ("s"."author_id" = "auth"."uid"()) AND ("s"."status" = ANY (ARRAY['idea'::"public"."story_status", 'researching'::"public"."story_status", 'draft'::"public"."story_status", 'review'::"public"."story_status"]))))))) WITH CHECK (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_tags"."story_id") AND ("s"."author_id" = "auth"."uid"()) AND ("s"."status" = ANY (ARRAY['idea'::"public"."story_status", 'researching'::"public"."story_status", 'draft'::"public"."story_status", 'review'::"public"."story_status"])))))));



CREATE POLICY "newsroom reads media" ON "public"."media" FOR SELECT TO "authenticated" USING (("public"."current_role"() IS NOT NULL));



CREATE POLICY "newsroom reads profiles" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("public"."current_role"() IS NOT NULL));



CREATE POLICY "newsroom reads stories" ON "public"."stories" FOR SELECT TO "authenticated" USING (("public"."is_editor"() OR ("author_id" = "auth"."uid"())));



CREATE POLICY "newsroom reads story beats" ON "public"."story_beats" FOR SELECT TO "authenticated" USING (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_beats"."story_id") AND ("s"."author_id" = "auth"."uid"()))))));



CREATE POLICY "newsroom reads story relations" ON "public"."story_related" FOR SELECT TO "authenticated" USING (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "story"
  WHERE (("story"."id" = "story_related"."story_id") AND ("story"."author_id" = "auth"."uid"()))))));



CREATE POLICY "newsroom reads story sources" ON "public"."sources" FOR SELECT TO "authenticated" USING (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "story"
  WHERE (("story"."id" = "sources"."story_id") AND ("story"."author_id" = "auth"."uid"()))))));



CREATE POLICY "newsroom reads story tags" ON "public"."story_tags" FOR SELECT TO "authenticated" USING (("public"."is_editor"() OR (EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_tags"."story_id") AND ("s"."author_id" = "auth"."uid"()))))));



CREATE POLICY "people update their own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK ((("id" = "auth"."uid"()) AND ("role" = "public"."current_role"())));



ALTER TABLE "public"."pipeline_claim_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_claims" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_drafts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_review_decisions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_stage_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_story_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public reads beats" ON "public"."beats" FOR SELECT USING (true);



CREATE POLICY "public reads published authors" ON "public"."profiles" FOR SELECT TO "authenticated", "anon" USING ((EXISTS ( SELECT 1
   FROM "public"."stories" "story"
  WHERE (("story"."author_id" = "profiles"."id") AND ("story"."status" = 'published'::"public"."story_status") AND ("story"."published_at" <= "now"())))));



CREATE POLICY "public reads published stories" ON "public"."stories" FOR SELECT USING ((("status" = 'published'::"public"."story_status") AND ("published_at" <= "now"())));



CREATE POLICY "public reads published story beats" ON "public"."story_beats" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_beats"."story_id") AND ("s"."status" = 'published'::"public"."story_status") AND ("s"."published_at" <= "now"())))));



CREATE POLICY "public reads published story media" ON "public"."media" FOR SELECT TO "authenticated", "anon" USING ((EXISTS ( SELECT 1
   FROM "public"."stories" "story"
  WHERE (("story"."hero_media_id" = "media"."id") AND ("story"."status" = 'published'::"public"."story_status") AND ("story"."published_at" <= "now"())))));



CREATE POLICY "public reads published story relations" ON "public"."story_related" FOR SELECT TO "authenticated", "anon" USING (((EXISTS ( SELECT 1
   FROM "public"."stories" "story"
  WHERE (("story"."id" = "story_related"."story_id") AND ("story"."status" = 'published'::"public"."story_status") AND ("story"."published_at" <= "now"())))) AND (EXISTS ( SELECT 1
   FROM "public"."stories" "related"
  WHERE (("related"."id" = "story_related"."related_story_id") AND ("related"."status" = 'published'::"public"."story_status") AND ("related"."published_at" <= "now"()))))));



CREATE POLICY "public reads published story sources" ON "public"."sources" FOR SELECT TO "authenticated", "anon" USING ((EXISTS ( SELECT 1
   FROM "public"."stories" "story"
  WHERE (("story"."id" = "sources"."story_id") AND ("story"."status" = 'published'::"public"."story_status") AND ("story"."published_at" <= "now"())))));



CREATE POLICY "public reads published story tags" ON "public"."story_tags" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."stories" "s"
  WHERE (("s"."id" = "story_tags"."story_id") AND ("s"."status" = 'published'::"public"."story_status") AND ("s"."published_at" <= "now"())))));



CREATE POLICY "public reads reference data" ON "public"."sections" FOR SELECT USING (true);



CREATE POLICY "public reads tags" ON "public"."tags" FOR SELECT USING (true);



ALTER TABLE "public"."research_packets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."revisions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."search_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."story_beats" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."story_related" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."story_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON TABLE "public"."stories" TO "anon";
GRANT ALL ON TABLE "public"."stories" TO "authenticated";
GRANT ALL ON TABLE "public"."stories" TO "service_role";



REVOKE ALL ON FUNCTION "public"."can_publish_story"("s" "public"."stories") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_publish_story"("s" "public"."stories") TO "service_role";
GRANT ALL ON FUNCTION "public"."can_publish_story"("s" "public"."stories") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."current_role"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_role"() TO "service_role";
GRANT ALL ON FUNCTION "public"."current_role"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."guard_published_story_sources"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_published_story_sources"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_story_workflow"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_story_workflow"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_editor"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_editor"() TO "service_role";
GRANT ALL ON FUNCTION "public"."is_editor"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."materialize_pipeline_story"("p_candidate_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."materialize_pipeline_story"("p_candidate_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."materialize_pipeline_story"("p_candidate_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."save_story"("p_story_id" "uuid", "p_expected_revision" integer, "p_patch" "jsonb", "p_beat_ids" "uuid"[], "p_tags" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_story"("p_story_id" "uuid", "p_expected_revision" integer, "p_patch" "jsonb", "p_beat_ids" "uuid"[], "p_tags" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_story"("p_story_id" "uuid", "p_expected_revision" integer, "p_patch" "jsonb", "p_beat_ids" "uuid"[], "p_tags" "text"[]) TO "service_role";



GRANT ALL ON TABLE "public"."beats" TO "anon";
GRANT ALL ON TABLE "public"."beats" TO "authenticated";
GRANT ALL ON TABLE "public"."beats" TO "service_role";



GRANT ALL ON TABLE "public"."candidate_stories" TO "anon";
GRANT ALL ON TABLE "public"."candidate_stories" TO "authenticated";
GRANT ALL ON TABLE "public"."candidate_stories" TO "service_role";



GRANT ALL ON TABLE "public"."discovered_documents" TO "anon";
GRANT ALL ON TABLE "public"."discovered_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."discovered_documents" TO "service_role";



GRANT ALL ON TABLE "public"."discovery_runs" TO "anon";
GRANT ALL ON TABLE "public"."discovery_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."discovery_runs" TO "service_role";



GRANT ALL ON TABLE "public"."editorial_taxonomy_review" TO "anon";
GRANT ALL ON TABLE "public"."editorial_taxonomy_review" TO "authenticated";
GRANT ALL ON TABLE "public"."editorial_taxonomy_review" TO "service_role";



GRANT ALL ON TABLE "public"."homepage_settings" TO "anon";
GRANT ALL ON TABLE "public"."homepage_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."homepage_settings" TO "service_role";



GRANT ALL ON TABLE "public"."image_candidates" TO "anon";
GRANT ALL ON TABLE "public"."image_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."image_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."legacy_taxonomy_mappings" TO "anon";
GRANT ALL ON TABLE "public"."legacy_taxonomy_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."legacy_taxonomy_mappings" TO "service_role";



GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."media" TO "anon";
GRANT ALL ON TABLE "public"."media" TO "authenticated";
GRANT ALL ON TABLE "public"."media" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."media" TO "anon";



GRANT SELECT("public_url") ON TABLE "public"."media" TO "anon";



GRANT SELECT("alt_text") ON TABLE "public"."media" TO "anon";



GRANT SELECT("caption") ON TABLE "public"."media" TO "anon";



GRANT SELECT("credit") ON TABLE "public"."media" TO "anon";



GRANT ALL ON TABLE "public"."pipeline_claim_sources" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_claim_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_claim_sources" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_claims" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_claims" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_drafts" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_drafts" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_review_decisions" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_review_decisions" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_review_decisions" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_runs" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_runs" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_sources" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_sources" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_stage_attempts" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_stage_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_stage_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_story_links" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_story_links" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_story_links" TO "service_role";



GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."profiles" TO "anon";



GRANT SELECT("name") ON TABLE "public"."profiles" TO "anon";



GRANT SELECT("slug") ON TABLE "public"."profiles" TO "anon";



GRANT ALL ON TABLE "public"."research_packets" TO "anon";
GRANT ALL ON TABLE "public"."research_packets" TO "authenticated";
GRANT ALL ON TABLE "public"."research_packets" TO "service_role";



GRANT ALL ON TABLE "public"."revisions" TO "anon";
GRANT ALL ON TABLE "public"."revisions" TO "authenticated";
GRANT ALL ON TABLE "public"."revisions" TO "service_role";



GRANT ALL ON TABLE "public"."search_logs" TO "anon";
GRANT ALL ON TABLE "public"."search_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."search_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."search_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."search_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."search_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sections" TO "anon";
GRANT ALL ON TABLE "public"."sections" TO "authenticated";
GRANT ALL ON TABLE "public"."sections" TO "service_role";



GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."sources" TO "anon";
GRANT ALL ON TABLE "public"."sources" TO "authenticated";
GRANT ALL ON TABLE "public"."sources" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."sources" TO "anon";



GRANT SELECT("story_id") ON TABLE "public"."sources" TO "anon";



GRANT SELECT("title") ON TABLE "public"."sources" TO "anon";



GRANT SELECT("publisher") ON TABLE "public"."sources" TO "anon";



GRANT SELECT("url") ON TABLE "public"."sources" TO "anon";



GRANT SELECT("source_type") ON TABLE "public"."sources" TO "anon";



GRANT SELECT("published_at") ON TABLE "public"."sources" TO "anon";



GRANT SELECT("sort_order") ON TABLE "public"."sources" TO "anon";



GRANT ALL ON TABLE "public"."story_beats" TO "anon";
GRANT ALL ON TABLE "public"."story_beats" TO "authenticated";
GRANT ALL ON TABLE "public"."story_beats" TO "service_role";



GRANT ALL ON TABLE "public"."story_related" TO "anon";
GRANT ALL ON TABLE "public"."story_related" TO "authenticated";
GRANT ALL ON TABLE "public"."story_related" TO "service_role";



GRANT ALL ON TABLE "public"."story_tags" TO "anon";
GRANT ALL ON TABLE "public"."story_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."story_tags" TO "service_role";



GRANT ALL ON TABLE "public"."tags" TO "anon";
GRANT ALL ON TABLE "public"."tags" TO "authenticated";
GRANT ALL ON TABLE "public"."tags" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







