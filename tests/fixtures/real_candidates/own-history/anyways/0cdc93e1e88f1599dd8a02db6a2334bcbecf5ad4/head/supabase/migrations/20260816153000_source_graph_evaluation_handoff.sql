-- Do not mark a threshold-passed event complete until the proposal insert has
-- succeeded. This preserves eventual queueing when the active proposal cap is
-- full and the current run can only take the highest-ranked eligible items.
begin;

alter table public.source_events
  add column if not exists discovery_handoff_created_at timestamptz;

comment on column public.source_events.discovery_handoff_created_at is
  'Time a deterministic threshold-passed event actually entered the canonical Qwen proposal handoff.';

create or replace function public.defer_thresholded_source_event_evaluation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.discovery_evaluation_mode = 'scheduled'
     and new.discovery_passed_threshold is true
     and new.discovery_handoff_created_at is null then
    new.discovery_evaluated_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists source_events_defer_thresholded_evaluation on public.source_events;
create trigger source_events_defer_thresholded_evaluation
before update of discovery_evaluated_at, discovery_passed_threshold on public.source_events
for each row execute function public.defer_thresholded_source_event_evaluation();

create or replace function public.mark_source_event_discovery_handoff()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.writer_backend = 'qwen' then
    update public.source_events
    set discovery_evaluated_at = coalesce(discovery_evaluated_at, now()),
        discovery_handoff_created_at = coalesce(discovery_handoff_created_at, now())
    where id = new.source_event_id
      and discovery_evaluation_mode = 'scheduled'
      and discovery_passed_threshold is true
      and discovery_evaluated_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists hermes_story_proposals_mark_source_event_handoff on public.hermes_story_proposals;
create trigger hermes_story_proposals_mark_source_event_handoff
after insert on public.hermes_story_proposals
for each row execute function public.mark_source_event_discovery_handoff();

commit;
