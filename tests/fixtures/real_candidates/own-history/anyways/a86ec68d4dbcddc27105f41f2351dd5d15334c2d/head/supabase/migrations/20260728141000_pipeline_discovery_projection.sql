-- Project local discovery state into the existing candidate table so editors
-- can request processing from the Newsroom. The local state file remains the
-- operational source; this is a read-only editorial projection until review.
begin;

create or replace function public.sync_pipeline_discovery_candidates(p_candidates jsonb)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare item jsonb; synced integer := 0;
begin
  perform public.assert_pipeline_controller();
  if jsonb_typeof(p_candidates) <> 'array' then raise exception using errcode = '22023', message = 'candidates must be an array'; end if;
  if jsonb_array_length(p_candidates) > 250 then raise exception using errcode = '22023', message = 'too many candidates in one projection'; end if;
  for item in select value from jsonb_array_elements(p_candidates) loop
    if nullif(btrim(item ->> 'id'), '') is null or nullif(btrim(item ->> 'url'), '') is null then
      raise exception using errcode = '22023', message = 'discovery candidates require id and url';
    end if;
    insert into public.candidate_stories(external_id, cluster_key, title, canonical_url, status, created_at, updated_at)
    values (
      item ->> 'id', item ->> 'id', nullif(btrim(item ->> 'title'), ''), item ->> 'url',
      'discovered'::public.pipeline_candidate_status,
      coalesce(nullif(item -> 'history' -> 0 ->> 'at', '')::timestamptz, now()), now()
    )
    on conflict (external_id) where external_id is not null do update
      set title = coalesce(excluded.title, public.candidate_stories.title),
          canonical_url = excluded.canonical_url,
          updated_at = now();
    synced := synced + 1;
  end loop;
  return synced;
end $$;

revoke all on function public.sync_pipeline_discovery_candidates(jsonb) from public, anon, authenticated;
grant execute on function public.sync_pipeline_discovery_candidates(jsonb) to service_role;

commit;
