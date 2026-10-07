-- Add coarse, first-party web-vital samples to the existing bounded analytics
-- table. Values are integer milliseconds, except CLS which is multiplied by
-- 1,000 before storage.

begin;

alter table public.analytics_events drop constraint if exists analytics_events_event_type_check;
alter table public.analytics_events add constraint analytics_events_event_type_check
  check (event_type in ('page_view', 'engaged', 'scroll', 'outbound', 'share', 'performance'));

commit;
