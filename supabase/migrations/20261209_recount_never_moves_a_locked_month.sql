-- NEEDS THE OWNER. NOT APPLIED.
--
-- WHAT IS WRONG
-- recount_month() checks that a month is unlocked at the TOP and writes the new
-- count at the BOTTOM:
--
--   select * into m from client_months where id = p_month;      -- plain read
--   if m.locked_at is not null then return m.calls_delivered; end if;
--   ...
--   update client_months set calls_delivered = d where id = p_month;   -- no guard
--
-- Between those two lines another session can lock the month. lock_month() takes
-- `for update` on the row, so it is safe against a second lock_month() — but a plain
-- `select` does not wait on that lock and does not see the uncommitted value, so
-- recount_month() reads locked_at as null and carries on. Its final UPDATE then
-- blocks on lock_month()'s row lock, and when lock_month() commits, the UPDATE wakes
-- up, re-checks only `id = p_month`, and overwrites calls_delivered.
--
-- The month is left locked, with a verdict and a refund worked out from the OLD
-- count, and a calls_delivered that no longer matches either. On the client's own
-- Month tab that reads, for example, "5 of 5 calls" beside a refund for being short
-- — or "3 of 5" beside no refund at all. This is the one screen the guarantee is
-- argued over, so a self-contradicting month there is worse than a wrong number.
--
-- HOW TO HIT IT
-- The owner answers "they showed up" on a call (call_verdict -> recount_month) in
-- the same moment the month that call belongs to is locked. A month is locked the
-- day it ends, which is also the day the last calls of it get their verdicts — so
-- the two happen on the same day by design, and the window is one statement wide.
--
-- WHAT WAS CONFIRMED LIVE (2026-11-26, inside a rolled-back transaction)
-- Nothing in the database stops a locked month's count from moving. A locked month
-- with verdict 'missed' and refund_due 3000 accepted calls_delivered 0 -> 7 with no
-- error, no trigger and no check. The only thing that was ever keeping a locked
-- month still was the `if` at the top of this function.
--
-- WHAT COULD NOT BE TESTED
-- Two genuinely simultaneous sessions. This session has one database connection and
-- was refused permission to schedule the two pg_cron jobs that would have given it
-- two. The race above is read off the code and off the proven fact that the write
-- is unguarded; it was not reproduced.
--
-- THE FIX
-- Put the check in the WHERE of the write, where it is evaluated after the wait
-- instead of before it. If the month was locked while we were counting, the UPDATE
-- matches no row and the count stays as lock_month() left it — which is the count
-- the refund was worked out from. The same guard goes on the month_id re-pointing
-- above it, so a call cannot be moved into a month that has just been settled.
--
-- Everything else is unchanged: same signature, same return value, still idempotent,
-- still counts by the date window in calendar_settings.us_zone.

create or replace function public.recount_month(p_month uuid)
 returns integer
 language plpgsql
 set search_path to 'public'
as $function$
declare
  m public.client_months;
  d integer;
  n integer;
  v_zone text := coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York');
begin
  select * into m from public.client_months where id = p_month;
  if not found then raise exception 'no such month'; end if;
  if m.locked_at is not null then return m.calls_delivered; end if;

  -- a call belongs to the month its meeting happened in
  update public.qualified_calls q
     set month_id = m.id
   where q.client_id = m.client_id
     and q.counts
     and (q.happened_at at time zone v_zone)::date between m.starts_on and m.ends_on
     and (q.month_id is distinct from m.id)
     -- and only while that month is still open: a month settled since the read
     -- above must not have calls moved into it.
     and exists (select 1 from public.client_months lm
                  where lm.id = m.id and lm.locked_at is null);

  -- the number is the window, never the pointer: a call that has moved out of
  -- this month stops counting here the moment this month is recounted, whichever
  -- month is recounted first.
  select count(*) into d
    from public.qualified_calls q
   where q.client_id = m.client_id
     and q.counts
     and (q.happened_at at time zone v_zone)::date between m.starts_on and m.ends_on;

  -- `and locked_at is null` is the whole fix. This statement waits for any
  -- lock_month() holding the row, and THEN decides. If the month was locked while
  -- we counted, nothing is written and the settled number stands.
  update public.client_months set calls_delivered = d
   where id = p_month and locked_at is null;

  -- report what the month actually says now, not what we counted. A caller that
  -- was beaten to the lock gets the settled figure, so no screen can show a count
  -- the month does not hold.
  select calls_delivered into n from public.client_months where id = p_month;
  return coalesce(n, d);
end $function$;

comment on function public.recount_month(uuid) is
  'Recount a month from its own calls, by the date window in calendar_settings.us_zone. Does nothing to a locked month — including a month locked while this was counting, which is why the write carries its own locked_at is null.';
