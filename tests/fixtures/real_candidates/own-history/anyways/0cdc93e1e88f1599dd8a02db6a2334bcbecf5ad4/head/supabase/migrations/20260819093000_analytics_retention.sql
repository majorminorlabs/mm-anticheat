-- Reader analytics is intentionally short-lived. Keep the newsroom report
-- useful without turning a tiny first-party signal table into an archive.

begin;

create or replace function public.purge_analytics_events(p_before timestamptz default now() - interval '90 days')
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  removed integer;
begin
  if auth.uid() is not null and not coalesce(public.current_role() in ('admin', 'editor'), false) then
    raise exception 'admin or editor access is required' using errcode = '42501';
  end if;
  delete from public.analytics_events
  where occurred_at < least(coalesce(p_before, now() - interval '90 days'), now());
  get diagnostics removed = row_count;
  return removed;
end;
$function$;

revoke all on function public.purge_analytics_events(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_analytics_events(timestamptz) to service_role;

commit;
