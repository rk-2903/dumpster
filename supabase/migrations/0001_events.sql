-- IvyNotes anonymous telemetry — events table + read views.
--
-- Rows are written ONLY by the `ingest` Edge Function, which runs with the
-- service role and validates every payload. Row-Level Security is enabled with
-- NO policies, and SELECT/INSERT are revoked from the API roles, so the public
-- anon key embedded in the extension cannot read or write this table (or the
-- views) directly through PostgREST. The service role bypasses RLS and grants.
--
-- Nothing here stores personal data: only a random client id, an event name, a
-- few whitelisted numeric/string props, the extension version, and a locale.

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  client_id   uuid        not null,
  event       text        not null,
  props       jsonb       not null default '{}'::jsonb,
  ext_version text,
  locale      text,
  created_at  timestamptz not null default now()
);

create index if not exists events_created_at_idx on public.events (created_at);
create index if not exists events_event_idx       on public.events (event);
create index if not exists events_client_idx      on public.events (client_id);

-- Lock the table down: RLS on, no policies, and no grants to the API roles.
alter table public.events enable row level security;
revoke all on public.events from anon, authenticated;

-- ---- Read views (query these from the SQL editor / service role) ----------

-- Weekly active users: distinct clients that sent an `active` ping in 7 days.
create or replace view public.weekly_active as
select count(distinct client_id) as weekly_active_users
from public.events
where event = 'active'
  and created_at >= now() - interval '7 days';

-- Active clients per ISO week — a simple trend line.
create or replace view public.active_by_week as
select date_trunc('week', created_at)::date as week,
       count(distinct client_id)            as active_users
from public.events
where event = 'active'
group by 1
order by 1;

-- Week-over-week retention: of the clients active in week W, how many were also
-- active in week W+1.
create or replace view public.retention as
with weekly as (
  select distinct client_id, date_trunc('week', created_at)::date as week
  from public.events
  where event = 'active'
)
select w.week                        as cohort_week,
       count(distinct w.client_id)   as active,
       count(distinct nxt.client_id) as retained_next_week,
       round(
         count(distinct nxt.client_id)::numeric
         / nullif(count(distinct w.client_id), 0) * 100, 1
       )                             as retention_pct
from weekly w
left join weekly nxt
  on nxt.client_id = w.client_id
 and nxt.week = w.week + 7
group by w.week
order by w.week;

-- Feature usage totals (counts only).
create or replace view public.feature_usage as
select props->>'name'   as feature,
       count(*)         as events,
       count(distinct client_id) as clients
from public.events
where event = 'feature' and props ? 'name'
group by 1
order by 2 desc;

-- Views default to the owner's privileges; keep the API roles out of them too.
revoke all on public.weekly_active, public.active_by_week,
              public.retention, public.feature_usage
  from anon, authenticated;
