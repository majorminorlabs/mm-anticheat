-- Refresh non-ready Qwen proposals from their retained source-event text so
-- an editor retry evaluates the same evidence that new proposals receive.
begin;

update public.hermes_story_proposals proposal
set summary = left(
      coalesce(
        nullif(concat_ws(E'\n\n', nullif(event.summary, ''), nullif(event.raw_text, '')), ''),
        ''
      ),
      4000
    ),
    updated_at = now()
from public.source_events event
where proposal.source_event_id = event.id
  and proposal.writer_backend = 'qwen'
  and proposal.status in ('queued', 'failed', 'rejected');

commit;
