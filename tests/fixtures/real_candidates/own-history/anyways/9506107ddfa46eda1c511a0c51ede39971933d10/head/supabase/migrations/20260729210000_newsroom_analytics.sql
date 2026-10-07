-- First-party, aggregate-ready publication analytics. Events deliberately omit
-- IP addresses, user agents, full referrer URLs, and newsroom activity.
create table public.analytics_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  event_type text not null check (event_type in ('page_view', 'engaged', 'scroll', 'outbound')),
  session_id uuid not null,
  path text not null check (path ~ '^/[^[:space:]]*$' and length(path) <= 180),
  referrer_host text,
  event_value integer,
  detail text,
  check (referrer_host is null or (referrer_host !~ '[/:@?]' and length(referrer_host) <= 180)),
  check (detail is null or length(detail) <= 180),
  check (event_value is null or event_value between 0 and 86400)
);

create index analytics_events_occurred_at_idx on public.analytics_events (occurred_at desc);
create index analytics_events_session_idx on public.analytics_events (session_id, occurred_at desc);
create index analytics_events_path_idx on public.analytics_events (path, occurred_at desc);

alter table public.analytics_events enable row level security;

create or replace function public.newsroom_analytics_report(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  window_days integer := greatest(1, least(coalesce(p_days, 7), 365));
  starts_at timestamptz := date_trunc('day', now()) - make_interval(days => greatest(0, least(coalesce(p_days, 7), 365) - 1));
begin
  if auth.uid() is null or not coalesce(public.current_role() in ('admin', 'editor'), false) then
    raise exception 'an editor account is required for analytics' using errcode = '42501';
  end if;

  return (
    with scoped as (
      select * from public.analytics_events where occurred_at >= starts_at
    ),
    daily as (
      select day::date as day,
        count(page_view.id)::integer as pageviews,
        count(distinct page_view.session_id)::integer as visitors
      from generate_series(starts_at::date, current_date, interval '1 day') day
      left join scoped page_view on page_view.event_type = 'page_view' and page_view.occurred_at::date = day::date
      group by day
      order by day
    ),
    session_time as (
      select session_id, sum(event_value)::numeric as seconds
      from scoped where event_type = 'engaged' and event_value is not null
      group by session_id
    ),
    session_scroll as (
      select session_id, max(event_value)::numeric as depth
      from scoped where event_type = 'scroll' and event_value is not null
      group by session_id
    ),
    source_rows as (
      select coalesce(nullif(referrer_host, ''), 'Direct') as name, count(*)::integer as value
      from scoped where event_type = 'page_view'
      group by 1 order by 2 desc, 1 asc limit 6
    ),
    page_rows as (
      select path as name, count(*)::integer as value
      from scoped where event_type = 'page_view'
      group by path order by value desc, name asc limit 6
    ),
    action_rows as (
      select case event_type when 'outbound' then 'Outbound clicks' when 'scroll' then 'Scroll milestones' when 'engaged' then 'Engaged sessions' else 'Page views' end as name,
        count(*)::integer as value
      from scoped group by event_type order by value desc, name asc
    )
    select jsonb_build_object(
      'days', window_days,
      'from', starts_at::date,
      'to', current_date,
      'visitors', (select count(distinct session_id)::integer from scoped where event_type = 'page_view'),
      'pageviews', (select count(*)::integer from scoped where event_type = 'page_view'),
      'avg_engaged_seconds', coalesce((select round(avg(seconds))::integer from session_time), 0),
      'avg_scroll_depth', coalesce((select round(avg(depth))::integer from session_scroll), 0),
      'daily', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'pageviews', pageviews, 'visitors', visitors)) from daily), '[]'::jsonb),
      'sources', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'value', value)) from source_rows), '[]'::jsonb),
      'pages', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'value', value)) from page_rows), '[]'::jsonb),
      'actions', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'value', value)) from action_rows), '[]'::jsonb)
    )
  );
end;
$function$;

revoke all on table public.analytics_events from anon, authenticated;
revoke all on function public.newsroom_analytics_report(integer) from public, anon;
grant execute on function public.newsroom_analytics_report(integer) to authenticated;
