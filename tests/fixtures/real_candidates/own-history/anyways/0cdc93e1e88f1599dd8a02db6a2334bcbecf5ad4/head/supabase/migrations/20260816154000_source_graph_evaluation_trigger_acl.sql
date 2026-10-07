-- Evaluation trigger helpers are database internals, not public RPCs.
begin;

revoke all on function public.defer_thresholded_source_event_evaluation() from public, anon, authenticated;
grant execute on function public.defer_thresholded_source_event_evaluation() to service_role;
revoke all on function public.mark_source_event_discovery_handoff() from public, anon, authenticated;
grant execute on function public.mark_source_event_discovery_handoff() to service_role;

commit;
