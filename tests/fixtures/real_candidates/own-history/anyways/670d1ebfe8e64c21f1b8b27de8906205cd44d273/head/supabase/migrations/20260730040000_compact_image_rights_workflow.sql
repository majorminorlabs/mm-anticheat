-- Editor-facing rights workflow metadata. Deterministic rights_status remains
-- the sole publication decision and is never replaced with these labels.
begin;

alter table public.media
  add column if not exists rights_basis text,
  add column if not exists rights_details jsonb not null default '{}'::jsonb,
  add column if not exists editorial_approved boolean not null default false,
  add column if not exists rights_override_approved_at timestamptz,
  add column if not exists rights_override_reason text;

alter table public.image_candidates
  add column if not exists rights_basis text,
  add column if not exists rights_details jsonb not null default '{}'::jsonb,
  add column if not exists editorial_approved boolean not null default false,
  add column if not exists rights_override_approved_at timestamptz,
  add column if not exists rights_override_reason text;

alter table public.media drop constraint if exists media_rights_basis_check;
alter table public.media add constraint media_rights_basis_check check (
  rights_basis is null or rights_basis in ('staff_owned', 'licensed', 'permission_granted', 'public_domain', 'creative_commons', 'not_verified')
);
alter table public.image_candidates drop constraint if exists image_candidates_rights_basis_check;
alter table public.image_candidates add constraint image_candidates_rights_basis_check check (
  rights_basis is null or rights_basis in ('staff_owned', 'licensed', 'permission_granted', 'public_domain', 'creative_commons', 'not_verified')
);

-- This trigger is deliberately after the deterministic decision trigger.
-- It rechecks the editor workflow on the server so a client cannot claim a
-- complete clearance merely by hiding fields. Editors can still save an
-- incomplete record for layout work, but it fails closed before publication.
-- An override can only be written by a trusted back-office path, not this form.
create or replace function public.enforce_editorial_image_rights_workflow()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $function$
declare
  details jsonb := coalesce(new.rights_details, '{}'::jsonb);
  missing text := null;
begin
  if new.rights_basis = 'licensed' then
    if coalesce(nullif(btrim(details ->> 'rights_holder'), ''), '') = '' then missing := 'rights holder';
    elsif coalesce(nullif(btrim(new.license_code), ''), '') = '' then missing := 'license type';
    elsif coalesce(nullif(btrim(details ->> 'usage_restrictions'), ''), '') = '' then missing := 'usage restrictions';
    elsif coalesce(nullif(btrim(details ->> 'proof_url'), ''), '') !~ '^https?://' then missing := 'proof of license URL'; end if;
  elsif new.rights_basis = 'permission_granted' then
    if coalesce(nullif(btrim(details ->> 'rights_holder'), ''), '') = '' then missing := 'rights holder';
    elsif coalesce(nullif(btrim(details ->> 'permission_contact'), ''), '') = '' then missing := 'permission contact';
    elsif coalesce(nullif(btrim(details ->> 'permission_date'), ''), '') = '' then missing := 'permission date';
    elsif coalesce(nullif(btrim(details ->> 'usage_restrictions'), ''), '') = '' then missing := 'usage restrictions';
    elsif coalesce(nullif(btrim(details ->> 'proof_url'), ''), '') !~ '^https?://' then missing := 'proof of permission URL'; end if;
  elsif new.rights_basis = 'public_domain' then
    if coalesce(nullif(btrim(new.source_page_url), ''), '') !~ '^https?://' then missing := 'source page URL';
    elsif coalesce(nullif(btrim(details ->> 'public_domain_basis'), ''), '') = '' then missing := 'public-domain basis'; end if;
  elsif new.rights_basis = 'creative_commons' then
    if coalesce(nullif(btrim(new.creator), ''), '') = '' then missing := 'creator';
    elsif coalesce(nullif(btrim(new.license_code), ''), '') = '' then missing := 'license type';
    elsif coalesce(nullif(btrim(new.license_url), ''), '') !~ '^https?://' then missing := 'license URL';
    elsif coalesce(nullif(btrim(details ->> 'required_attribution'), ''), '') = '' then missing := 'required attribution'; end if;
  elsif new.rights_basis = 'not_verified' and new.rights_override_approved_at is null then
    missing := 'editor marked this image as not verified';
  end if;

  if missing is not null and new.rights_override_approved_at is null then
    new.rights_status := 'metadata_incomplete';
    new.rights_audit := jsonb_build_object(
      'policy_version', '2026-07-30',
      'status', 'metadata_incomplete',
      'rule', case when new.rights_basis = 'not_verified' then 'editorial_rights_not_verified' else 'editorial_rights_workflow_incomplete' end,
      'detail', case when new.rights_basis = 'not_verified'
        then 'The editor marked this image as not verified. It cannot be published until a trusted rights override is present.'
        else format('The selected rights status is missing %s. It cannot be published until the rights record is complete and the deterministic gate approves it.', missing)
      end,
      'checked_at', now(),
      'metadata_snapshot', coalesce(new.rights_audit -> 'metadata_snapshot', '{}'::jsonb) || jsonb_build_object('rights_basis', new.rights_basis)
    );
  end if;
  return new;
end $function$;

drop trigger if exists zzz_enforce_media_rights_workflow on public.media;
create trigger zzz_enforce_media_rights_workflow
before insert or update on public.media
for each row execute function public.enforce_editorial_image_rights_workflow();
drop trigger if exists zzz_enforce_image_candidate_rights_workflow on public.image_candidates;
create trigger zzz_enforce_image_candidate_rights_workflow
before insert or update on public.image_candidates
for each row execute function public.enforce_editorial_image_rights_workflow();

grant update (rights_basis, rights_details, editorial_approved, rights_note) on public.media to authenticated;

-- Defense in depth: publication checks the editor-facing block explicitly,
-- even if a record predates the workflow trigger.
create or replace function public.presentation_rights_are_publishable(value jsonb)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $function$
  select not exists (
    select 1 from (
      select coalesce(value -> 'hero', '{}'::jsonb) as image
      union all select inline_image from jsonb_array_elements(coalesce(value -> 'inlineImages', '[]'::jsonb)) inline_image
    ) used
    where (used.image ? 'candidateImageId' and not exists (
      select 1 from public.image_candidates candidate
      where candidate.id = (used.image ->> 'candidateImageId')::uuid
        and candidate.rights_status = 'approved'
        and (candidate.rights_basis is distinct from 'not_verified' or candidate.rights_override_approved_at is not null)
    )) or (used.image ? 'mediaId' and not exists (
      select 1 from public.media newsroom_media
      where newsroom_media.id = (used.image ->> 'mediaId')::uuid
        and newsroom_media.rights_status = 'approved'
        and (newsroom_media.rights_basis is distinct from 'not_verified' or newsroom_media.rights_override_approved_at is not null)
    ))
  )
$function$;

commit;
