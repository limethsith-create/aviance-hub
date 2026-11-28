-- Who is on aviance.online right now, and a message to your phone when
-- somebody arrives or starts booking. Paste the whole file and run it once.
-- Safe to run twice.
--
-- The site sends a small beacon every few seconds. Nothing identifying is
-- kept: no IP address, no name, no email until they actually book. A session
-- key is a random string the browser makes up and forgets when the tab closes.

create table if not exists public.site_visits (
  id            uuid primary key default extensions.gen_random_uuid(),
  session_key   text not null unique,
  first_path    text,
  path          text,
  referrer      text,
  country       text,
  city          text,
  device        text,
  stage         text not null default 'browsing'
                check (stage in ('browsing','booking','booked')),
  is_owner      boolean not null default false,
  alerted_at    timestamptz,          -- when we told him somebody arrived
  booking_alerted_at timestamptz,     -- and when they started booking
  page_views    integer not null default 1,
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

comment on table public.site_visits is
  'One row per browser session on aviance.online. Kept for a fortnight, then swept.';

create index if not exists site_visits_last_seen on public.site_visits (last_seen_at desc);
create index if not exists site_visits_stage     on public.site_visits (stage, last_seen_at desc);

alter table public.site_visits enable row level security;

-- Only the owner reads this. The beacon writes through an edge function with
-- the service key, so nothing on the public internet needs a policy here.
drop policy if exists site_visits_admin_read on public.site_visits;
create policy site_visits_admin_read on public.site_visits
  for select to authenticated using (public.is_admin());

-- Somebody counts as here if their browser checked in within two minutes.
create or replace view public.v_site_live as
  select id, session_key, path, first_path, referrer, country, city, device,
         stage, page_views, started_at, last_seen_at,
         extract(epoch from (now() - started_at))::int   as seconds_here,
         extract(epoch from (now() - last_seen_at))::int as seconds_quiet
    from public.site_visits
   where is_owner = false
     and last_seen_at > now() - interval '2 minutes'
   order by stage = 'booking' desc, started_at desc;

comment on view public.v_site_live is
  'Everybody on the website right now, you excluded. Booking first, then newest.';

-- A fortnight is plenty: this is a live view, not an analytics warehouse.
create or replace function public.site_visits_sweep()
returns integer language plpgsql security definer set search_path to 'public' as $fn$
declare n integer;
begin
  delete from public.site_visits where last_seen_at < now() - interval '14 days';
  get diagnostics n = row_count;
  return n;
end $fn$;

revoke execute on function public.site_visits_sweep() from public, anon;
grant  execute on function public.site_visits_sweep() to service_role;

select cron.unschedule('aviance-visits-sweep')
 where exists (select 1 from cron.job where jobname = 'aviance-visits-sweep');
select cron.schedule('aviance-visits-sweep', '50 3 * * *',
                     $$select public.site_visits_sweep();$$);

-- ── proof ───────────────────────────────────────────────────────────────────
select 'site_visits' as part, count(*) from information_schema.tables
  where table_schema='public' and table_name='site_visits'
union all select 'v_site_live', count(*) from information_schema.views
  where table_schema='public' and table_name='v_site_live'
union all select 'sweep job', count(*) from cron.job where jobname='aviance-visits-sweep';
