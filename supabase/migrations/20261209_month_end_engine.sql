-- ============================================================================
-- THE MONTH-END ENGINE
--
-- *** NOT APPLIED. This file was written by an agent that cannot run DDL on the
-- *** project (apply_migration is refused). Nothing in here is live. Apply it
-- *** with the other 20261207/08/09 files, then check cron.job has
-- *** 'aviance-month-end' in it.
--
-- WHY THIS EXISTS
-- ---------------
-- Today nothing closes a month. lock_month() is correct, idempotent and tested,
-- but the only thing that calls it is a button a person has to remember to
-- press: the Month end screen (digest.js) or ending a client (wrapup.js). On
-- 2026-11-26 the live database had a month that ended on 9 October with 0 of 5
-- calls delivered, still `open`, refund_due 0, no refunds row and nobody told.
-- That is a month-one miss: twice the fee, $3,000. Forty-eight days late and
-- only visible to somebody who went looking.
--
-- The guarantee is the product. A guarantee honoured by a button is not a
-- guarantee. So: a view that answers "which months are over and still open",
-- a function that closes the ones it can close safely, an hourly schedule, and
-- a task on the owner's list for every one it will not close by itself.
--
-- WHAT MUST NOT HAPPEN, AND HOW EACH ONE IS STOPPED
-- -------------------------------------------------
-- 1. A month locked twice, or two refunds for one month.
--    lock_month() already takes `for update` on the row and returns early when
--    locked_at is set, and refunds_one_per_missed_month makes the second row
--    impossible. On top of that this sweep takes a transaction-level advisory
--    lock, so two overlapping runs (the cron firing while the owner's button is
--    mid-flight, or a retry) cannot interleave their reads. The second run
--    simply does nothing and says so.
--
-- 2. A month locked while a verdict is still outstanding.
--    This is the expensive one. An unverdicted call is counted as NOT
--    delivered, so locking a month with unanswered calls in it under-counts the
--    month and over-refunds: on Starter that is $1,500, in month one $3,000,
--    for a call that in fact happened. And it is permanent — recount_month()
--    returns early on a locked month, and the refunds row is already raised and
--    cannot be raised again. So: a month with any call inside its window that
--    has no verdict is HELD, not locked. Held costs a day. Locked costs money
--    that cannot be taken back.
--
-- 3. A month locked before late calls have been marked.
--    Same test, and it covers it: a call booked at 5pm on the last day of the
--    month is, by the time the month is over in the house US zone, a call in
--    the past with no verdict, so it holds the month. The sweep runs hourly, so
--    the month closes within the hour of the last verdict being given.
--    A hold is never silent and never forever: after MONTH_END_NAG_DAYS the
--    sweep raises a task naming the client, the month and the calls it is
--    waiting on. The blockage becomes loud instead of becoming a habit.
--
-- 4. A refund raised for a month we were never paid for.
--    Found live: BOTH months that had ended and were open on 2026-11-26 were
--    unpaid — one invoice still 'draft', one 'sent'. Locking them would have
--    raised $6,000 of 'owed' refunds against $3,000 of money that never
--    arrived, and refunds_one_per_missed_month means a corrected refund can
--    never be raised for that month afterwards. So a month that is SHORT and
--    unpaid is held with a task; a month that was HIT is locked whatever its
--    invoice says, because locking a hit raises no money and settles the
--    verdict. Holding is recoverable. Locking is not. That asymmetry decides it.
--    For a 3-month term, "paid" means the invoice that COVERS the month (months
--    1, 4, 7 … bill for three), not an invoice of its own — months 2 and 3 of a
--    prepay never have one and must not read as unpaid.
--
-- 5. A client who has left, paused, or cancelled mid-month.
--    If clients.ended_on is set, or the stage is 'ended'/'paused', the sweep
--    does not touch their months. Whether a month the CLIENT cut short is owed
--    back is a commercial decision, not an arithmetic one, and wrapup.js owns
--    that path. Held with a task.
--
-- 6. A month that was never set up properly.
--    No starts_on, no ends_on, a plan that is not on offer, or a monthly_fee of
--    zero or null: skipped, never guessed at. A missing ends_on means the month
--    never ends, so it would otherwise sit open forever with nobody told; it is
--    reported and nagged like any other hold.
--
-- 7. Two months ending the same night, and one of them broken.
--    Every month is locked inside its own BEGIN/EXCEPTION block. One month that
--    raises does not abort the others and does not abort the sweep; it is
--    reported in `failed` with the database's message, and retried next hour.
--
-- 8. Daylight saving, and a month that ends on a weekend.
--    "Has it ended?" is asked in the house US zone, read fresh from
--    calendar_settings on every run: (now() at time zone v_zone)::date >
--    ends_on. Postgres applies the right offset for that date, so the EST/EDT
--    change needs no code and cannot move the boundary by a day. The sweep runs
--    every hour of every day, so a Saturday month end closes on Saturday.
--    (Note for whoever touches v_month_standing next: its days_left is
--    `ends_on - CURRENT_DATE`, and CURRENT_DATE is UTC, so for the five hours
--    either side of midnight New York it is a day out. v_months_to_close below
--    does not use it.)
--
-- WHAT THIS JOB DOES, AND THE THREE STEPS IT DOES NOT DO
-- ------------------------------------------------------
-- Closing a month, as a business, is four steps: lock the verdict, raise the
-- refund, open the next month, invoice it. This job does the FIRST TWO ONLY —
-- and the second only because lock_month() does it in the same breath as the
-- first. It never opens a month and never raises an invoice.
--
-- That is deliberate, not an omission. Opening the next month needs two
-- decisions a clock cannot make, both of which round 2's money work
-- (finance.js fnCloseMonth) already refuses to make on its own:
--   * at a 3-month term boundary, whether the client renews at all;
--   * for a client who has left, nothing should be opened.
-- A cron job that opened month 4 of a 3-month term would be invoicing a
-- renewal nobody agreed to. So the verdict and the refund — which are facts,
-- and which are what the guarantee turns on — happen by themselves; opening
-- and invoicing the next month stay a decision somebody makes, on the Month
-- end screen, through fnCloseMonth.
--
-- The consequence to be aware of: after this job locks a month, a live client
-- can be left with no open month until somebody opens the next one. That is
-- the state the business is already in (nothing opened month two before
-- fnCloseMonth existed either); this job does not make it worse and does not
-- fix it.
--
-- APPLY THIS AFTER 20261208_guarantee_maths_fixes.sql. NOT BEFORE.
-- That file fixes recount_month to count a month by its date window instead of
-- by qualified_calls.month_id, which is only ever set and never released. With
-- the OLD recount_month, recounting a client's months oldest-first double-counts
-- a call that moved between months — and this job processes oldest-first on
-- purpose (below). Applied in the wrong order, the two combine into exactly the
-- under-count this engine exists to prevent.
--
-- WHAT WAS ACTUALLY RUN
-- ---------------------
-- Not on the project. Every statement in this file was applied to a throwaway
-- local Postgres 16 holding a stub of the live schema (the real column types, the
-- real `counts` generated column, the real refunds_one_per_missed_month index, and
-- recount_month/lock_month copied in verbatim), and the engine was exercised
-- against eleven months built to be each hazard above: ready, an unanswered call,
-- never paid, a HIT that was never paid, a stopped client, month 2 of a 3-month
-- prepay, a call whose meeting was cancelled, a month still running, a retired
-- plan, and two months that ended the same night. It locked the seven it should
-- have, held the four it should have, raised one task for each, and running it
-- four times in a row left exactly five refunds and nine tasks. The readiness
-- test's first version trusted client_months.calls_delivered and was caught by
-- that run doing the wrong thing; see delivered_counted below.
-- The LIVE database was only ever read.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- It does not change lock_month(), recount_month() or the guarantee basis. It
-- decides only WHICH months are safe to hand to lock_month() and WHEN, and it
-- tells somebody afterwards.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. WAS THIS MONTH PAID FOR?
-- ─────────────────────────────────────────────────────────────────────────────
-- A monthly client has one invoice per month. A 3-month client pays months 1,
-- 4, 7 … up front and months 2 and 3 have no invoice of their own, so "no
-- invoice" must NOT read as "not paid" for them: the covering month is
-- 1 + 3 * floor((month_no - 1) / 3).
--
-- A month whose client is on a term this function does not know is reported as
-- unpaid, which holds it for a person. Unknown must never read as paid.

create or replace function public.month_is_paid(p_month uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  with m as (
    select cm.id, cm.client_id, cm.month_no, c.term
      from public.client_months cm
      join public.clients c on c.id = cm.client_id
     where cm.id = p_month
  ), covers as (
    select m.client_id,
           case when m.term = '3month'
                then 1 + 3 * ((m.month_no - 1) / 3)
                else m.month_no end as month_no
      from m
  )
  select exists (
    select 1
      from public.invoices i
      join public.client_months cm on cm.id = i.month_id
      join covers v on v.client_id = cm.client_id and v.month_no = cm.month_no
     where (i.paid_at is not null or i.status = 'paid')
       and i.status <> 'void'
  );
$$;

comment on function public.month_is_paid(uuid) is
  'Has the money for this month arrived? For a 3-month term that is the invoice covering months n, n+1, n+2 — months 2 and 3 of a prepay have no invoice of their own and are paid when month 1 is.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE LIST: which months are over and still open
-- ─────────────────────────────────────────────────────────────────────────────
-- There was no view, no screen and no query anywhere that answered this. The
-- Month end screen worked it out in the browser from v_month_standing, which
-- meant the screen and any future automatic run could disagree about what had
-- ended. One view, one answer, read by both.
--
-- `ready` is the whole decision in one boolean, and `why_not` is the sentence
-- the owner reads when it is false. Every figure here is read off a row; the
-- refund is v_month_standing's at_risk, which is the finance side's number.

create or replace view public.v_months_to_close as
with cfg as (
  select coalesce((select us_zone from public.calendar_settings where id = 1),
                  'America/New_York') as zone
), today as (
  select (now() at time zone (select zone from cfg))::date as us_today
)
select
  m.id                                   as month_id,
  m.client_id,
  c.company,
  c.plan,
  c.term,
  c.monthly_fee,
  m.month_no,
  m.starts_on,
  m.ends_on,
  m.calls_promised,
  m.calls_delivered,
  /* THE STORED COUNT IS NOT THE DECIDING COUNT.
     client_months.calls_delivered is a cached number: nothing in the database
     recounts it on its own (there is no trigger on qualified_calls), so a
     direct write to a call leaves it stale. lock_month() runs recount_month()
     FIRST and then judges, so the verdict it reaches is based on this count,
     not on the stored one. Every decision below that turns on "did it hit?" —
     and in particular the one that lets an unpaid month lock because it hit —
     must therefore use the same count lock_month will use, or a month with a
     stale 5-of-5 could be waved through as a hit and come back as a $3,000
     refund on money that never arrived. Counted exactly as recount_month
     counts: calls that COUNT whose day, in the house zone, falls in the
     window. */
  (select count(*) from public.qualified_calls q
    where q.client_id = m.client_id
      and q.counts
      and (q.happened_at at time zone (select zone from cfg))::date
          between m.starts_on and m.ends_on)        as delivered_counted,
  greatest(m.calls_promised - m.calls_delivered, 0) as calls_short,
  (select us_today from today) - m.ends_on          as days_over,
  case when m.month_no = 1 then 2.0 else 1.0 end    as multiplier,
  /* what lock_month would raise if it ran now, off the count it would use */
  case when (select count(*) from public.qualified_calls q
              where q.client_id = m.client_id and q.counts
                and (q.happened_at at time zone (select zone from cfg))::date
                    between m.starts_on and m.ends_on) >= m.calls_promised then 0
       when m.month_no = 1 then c.monthly_fee * 2
       else c.monthly_fee end                       as refund_if_locked,
  /* calls inside this month's window that nobody has judged yet */
  /* The same question v_calls_awaiting_verdict asks, by this month's window
     rather than by qualified_calls.month_id (the pointer can be stale; the
     window is what recount_month counts by). A call whose meeting was
     CANCELLED will never be given a verdict, so it is not waiting on one —
     without that clause a cancelled call would hold its month forever. */
  (select count(*) from public.qualified_calls q
    where q.client_id = m.client_id
      and q.verdict_at is null
      and coalesce(q.dispute_status, '') <> 'upheld'
      and coalesce((select mt.status from public.meetings mt where mt.id = q.meeting_id), '') <> 'cancelled'
      and (q.booked_for at time zone (select zone from cfg))::date
          between m.starts_on and m.ends_on)        as awaiting_verdict,
  /* a dispute still being decided can still change the count */
  (select count(*) from public.qualified_calls q
    where q.client_id = m.client_id
      and q.dispute_status = 'raised'
      and (q.booked_for at time zone (select zone from cfg))::date
          between m.starts_on and m.ends_on)        as disputes_open,
  public.month_is_paid(m.id)                        as month_paid,
  (c.ended_on is not null or coalesce(c.stage, '') in ('ended', 'paused')) as client_gone,
  /* the whole decision */
  (    m.starts_on is not null
   and m.ends_on   is not null
   and c.plan in ('starter', 'growth', 'scale')
   and coalesce(c.monthly_fee, 0) > 0
   and c.ended_on is null
   and coalesce(c.stage, '') not in ('ended', 'paused')
   and not exists (select 1 from public.qualified_calls q
                    where q.client_id = m.client_id
                      and (q.verdict_at is null or q.dispute_status = 'raised')
                      and coalesce(q.dispute_status, '') <> 'upheld'
                      and coalesce((select mt.status from public.meetings mt where mt.id = q.meeting_id), '') <> 'cancelled'
                      and (q.booked_for at time zone (select zone from cfg))::date
                          between m.starts_on and m.ends_on)
   and ((select count(*) from public.qualified_calls q
          where q.client_id = m.client_id and q.counts
            and (q.happened_at at time zone (select zone from cfg))::date
                between m.starts_on and m.ends_on) >= m.calls_promised
        or public.month_is_paid(m.id))
  ) as ready,
  case
    when m.starts_on is null or m.ends_on is null
      then 'This month has no start or end date, so there is nothing to count. Set its dates.'
    when c.plan not in ('starter', 'growth', 'scale')
      then 'They are on a plan that is no longer offered, so the fee to refund is not known. Move them to Starter, Growth or Scale.'
    when coalesce(c.monthly_fee, 0) <= 0
      then 'Their monthly fee is not set, so a refund cannot be worked out.'
    when c.ended_on is not null or coalesce(c.stage, '') in ('ended', 'paused')
      then 'This client has stopped, so whether this month is owed back is your decision, not the clock''s. Close it from the Ending screen.'
    when exists (select 1 from public.qualified_calls q
                  where q.client_id = m.client_id and q.verdict_at is null
                    and coalesce(q.dispute_status, '') <> 'upheld'
                    and coalesce((select mt.status from public.meetings mt where mt.id = q.meeting_id), '') <> 'cancelled'
                    and (q.booked_for at time zone (select zone from cfg))::date
                        between m.starts_on and m.ends_on)
      then 'Some calls in this month have not been marked as held or missed yet. Mark them and it closes by itself within the hour.'
    when exists (select 1 from public.qualified_calls q
                  where q.client_id = m.client_id and q.dispute_status = 'raised'
                    and (q.booked_for at time zone (select zone from cfg))::date
                        between m.starts_on and m.ends_on)
      then 'A dispute on a call in this month is still open, and settling it could change the count. Settle it first.'
    /* a HIT is locked whatever the invoice says — locking it raises no money —
       so the unpaid sentence belongs only to a month that came up short */
    when (select count(*) from public.qualified_calls q
           where q.client_id = m.client_id and q.counts
             and (q.happened_at at time zone (select zone from cfg))::date
                 between m.starts_on and m.ends_on) < m.calls_promised
         and not public.month_is_paid(m.id)
      then 'This month was never paid for, so locking it short would raise a refund for money that never arrived. Chase the invoice, or lock it by hand once you have decided.'
    else ''
  end as why_not
from public.client_months m
join public.clients c on c.id = m.client_id, today
where m.locked_at is null
  and m.verdict = 'open'
  and m.ends_on is not null
  and m.ends_on < today.us_today;

comment on view public.v_months_to_close is
  'Months whose end date has passed in the house US zone and that are still open. `ready` says the month can be locked with no judgement call; `why_not` is the sentence to show the owner when it cannot. The month-end sweep and the Month end screen both read this, so they cannot disagree.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. TELLING SOMEBODY
-- ─────────────────────────────────────────────────────────────────────────────
-- No notification system is invented here. Two things that already exist and
-- that the owner already looks at:
--
--   tasks         the Team screen lists them, and Today counts the overdue ones
--                 in "Needs a person" and in the sidebar badge. A finance task
--                 due today is overdue tomorrow, so it cannot be missed quietly.
--   client_events the trail on the client's own page, which every other money
--                 event already writes to.
--
-- NOT channel_messages: a client channel is read by the CLIENT. "We owe you
-- $3,000" must not reach them before the owner has seen it.
--
-- Deduplicated on (client_id, title). The title carries the month number and
-- the amount, so it is stable for a month and distinct between months, and the
-- sweep running every hour for a week raises one task, not 168.

create or replace function public.month_task(
  p_client uuid, p_title text, p_detail text, p_due date default null)
returns uuid
language plpgsql
set search_path = public
as $$
declare v_id uuid;
begin
  select id into v_id from public.tasks
   where client_id = p_client and title = p_title
     and status not in ('done', 'cancelled')
   limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.tasks (title, detail, department, client_id, status, priority, due_on)
  values (p_title, p_detail, 'finance', p_client, 'todo', 1,
          coalesce(p_due, (now() at time zone
            coalesce((select us_zone from public.calendar_settings where id = 1),
                     'America/New_York'))::date))
  returning id into v_id;
  return v_id;
end $$;

comment on function public.month_task(uuid, text, text, date) is
  'One finance task for the owner, at priority 1 and due today, raised once: an open task with the same client and title is reused rather than repeated. Used by the month-end sweep.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE SWEEP
-- ─────────────────────────────────────────────────────────────────────────────
-- Returns what it did, so the cron log and a hand-run read the same. It takes
-- no arguments and decides nothing about money: every lock goes through
-- lock_month(), which is the one place the guarantee basis lives.

create or replace function public.month_end_close()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  MONTH_END_NAG_DAYS constant integer := 2;   -- days a hold is quiet before it becomes a task
  v_zone   text := coalesce((select us_zone from public.calendar_settings where id = 1),
                            'America/New_York');
  v_today  date := (now() at time zone v_zone)::date;
  r        record;
  m        public.client_months;
  v_locked jsonb := '[]'::jsonb;
  v_held   jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_owed   integer := 0;
  v_title  text;
begin
  -- Two sweeps must never read the same month at once. The owner's own button
  -- goes straight to lock_month(), which takes the row lock, so this guards the
  -- cron against itself and against a retry.
  if not pg_try_advisory_xact_lock(hashtext('aviance.month_end_close')) then
    return jsonb_build_object('ok', true, 'skipped', 'another month-end run is in progress',
                              'at', now());
  end if;

  /* OLDEST FIRST, PER CLIENT. Month 1 refunds at twice the fee and every month
     after at one, so month 1's verdict must be settled before month 2's — in
     the live database months had been locked out of order (a client's month 2
     locked on 26 November while its month 1, which ended on 9 October, was
     still open). Ordering by client and then by month_no makes the sequence the
     guarantee assumes. It is also why this file must be applied after
     20261208_guarantee_maths_fixes.sql; see the header. */
  for r in select * from public.v_months_to_close order by client_id, month_no loop
    if not r.ready then
      v_held := v_held || jsonb_build_array(jsonb_build_object(
        'month_id', r.month_id, 'company', r.company, 'month_no', r.month_no,
        'ends_on', r.ends_on, 'days_over', r.days_over, 'why_not', r.why_not));
      -- quiet for a day or two (a verdict given on Monday morning closes Friday's
      -- month with nobody bothered), then loud and it stays loud.
      if r.days_over >= MONTH_END_NAG_DAYS then
        v_title := format('Month %s for %s cannot close', r.month_no, r.company);
        perform public.month_task(r.client_id, v_title,
          format('Month %s ended on %s, %s day%s ago, with %s of %s calls delivered. %s%s',
                 r.month_no, to_char(r.ends_on, 'FMDD Mon YYYY'), r.days_over,
                 case when r.days_over = 1 then '' else 's' end,
                 r.calls_delivered, r.calls_promised,
                 r.why_not,
                 case when r.refund_if_locked > 0
                      then format(' Locking it as it stands would refund $%s.',
                                  to_char(r.refund_if_locked, 'FM999,999,999'))
                      else '' end));
      end if;
      continue;
    end if;

    -- One month per block: a month that raises must not take the others with it.
    begin
      m := public.lock_month(r.month_id);

      v_locked := v_locked || jsonb_build_array(jsonb_build_object(
        'month_id', m.id, 'company', r.company, 'month_no', m.month_no,
        'ends_on', m.ends_on, 'verdict', m.verdict,
        'calls_delivered', m.calls_delivered, 'calls_promised', m.calls_promised,
        'refund_due', m.refund_due));

      insert into public.client_events (client_id, area, event, detail)
      values (m.client_id, 'guarantee', 'month_closed',
              jsonb_build_object('month_id', m.id, 'month_no', m.month_no,
                                 'ends_on', m.ends_on, 'verdict', m.verdict,
                                 'calls_delivered', m.calls_delivered,
                                 'calls_promised', m.calls_promised,
                                 'refund_due', m.refund_due,
                                 'days_over', r.days_over, 'by', 'month_end_close'));

      -- Money owed does not stay a database row nobody is looking at.
      if coalesce(m.refund_due, 0) > 0 then
        v_owed := v_owed + m.refund_due;
        perform public.month_task(m.client_id,
          format('Refund owed: %s month %s', r.company, m.month_no),
          format('Month %s ended on %s with %s of %s calls delivered, %s short. The guarantee owes $%s (%s the month''s fee%s). The refund is raised and sits as owed until you pay it.',
                 m.month_no, to_char(m.ends_on, 'FMDD Mon YYYY'),
                 m.calls_delivered, m.calls_promised,
                 greatest(m.calls_promised - m.calls_delivered, 0),
                 to_char(m.refund_due, 'FM999,999,999'),
                 case when m.month_no = 1 then 'twice' else 'all of' end,
                 case when m.month_no = 1 then ', because it is month one' else '' end));
      end if;

    exception when others then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object(
        'month_id', r.month_id, 'company', r.company, 'month_no', r.month_no,
        'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'ok', true, 'at', now(), 'us_today', v_today, 'zone', v_zone,
    'locked_count', jsonb_array_length(v_locked),
    'refund_raised', v_owed,
    'locked', v_locked, 'held', v_held, 'failed', v_failed);
end $$;

comment on function public.month_end_close() is
  'Closes every month that has ended in the house US zone and is safe to close: recount, verdict and refund through lock_month(), a client_events row, and a finance task for the owner when money is owed. A month with an unanswered call, an open dispute, a stopped client, missing dates or an unpaid fee is HELD and becomes a task instead — never locked on a guess. Safe to run as often as you like.';

revoke execute on function public.month_end_close()  from public, anon;
revoke execute on function public.month_is_paid(uuid) from public, anon;
revoke execute on function public.month_task(uuid, text, text, date) from public, anon, authenticated;
grant  execute on function public.month_end_close()  to authenticated, service_role;
grant  execute on function public.month_is_paid(uuid) to authenticated, service_role;
grant  execute on function public.month_task(uuid, text, text, date) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE SCHEDULE
-- ─────────────────────────────────────────────────────────────────────────────
-- Hourly, not daily. Three reasons:
--   * a month ending on a Friday or a Saturday closes on that day, not on
--     Monday when somebody logs in;
--   * a month held for an unanswered call closes within the hour of the verdict
--     being given, so the hold costs nothing;
--   * the sweep is idempotent and cheap (one view, usually no rows), so the
--     cost of running it 24 times a day is nothing.
-- At :40, clear of aviance-day-before (:05) and aviance-journey-hourly (:17).
--
-- pg_cron 1.6.4 is already installed on this project (checked 2026-11-26), and
-- cron.schedule on an existing jobname replaces it, so this is safe to re-run.

select cron.schedule('aviance-month-end', '40 * * * *', $cron$select public.month_end_close();$cron$);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. THE AUDIT GAP: a locked month's calls can still be edited
-- ─────────────────────────────────────────────────────────────────────────────
-- Round 1 found it and it is real. recount_month() returns early on a locked
-- month, so the month's number is frozen — but the CALLS behind it are not:
--
--   finance.js fnCallHappened()  -> update qualified_calls set happened = true
--   finance.js fnDisputeCall()   -> update qualified_calls set dispute_status
--   finance.js fnSettleDispute() -> update qualified_calls set dispute_status
--
-- all write straight to the row, all then call recount_month(), which does
-- nothing, and none of them records anything. So a month can say "3 of 5
-- delivered, $1,500 refunded" while the calls behind it now add up to 4, and
-- there is no row anywhere that says the number stopped matching. The refund
-- has already been raised, and refunds_one_per_missed_month means it cannot be
-- corrected and re-raised.
--
-- REFUSE OR RECORD? Record.
--   * Refusing would break legitimate corrections. A client can raise a dispute
--     on a call weeks after the month closed, and they are entitled to; an
--     owner may need to fix a verdict typed in wrong. A refusal at the database
--     level would surface as a failed button in the portal, which is the one
--     thing the house style forbids.
--   * call_verdict() ALREADY allows the edit deliberately and tells the person
--     in words ("One of its months is already locked, so that month's number
--     and any refund did not move"). Refusing here would contradict the
--     function the owner is told to trust.
--   * What was actually missing was not the refusal. It was the record. An edit
--     that quietly unsupports a locked number is the bug; an edit the owner is
--     told about is a correction.
-- So: the edit stands, and the trigger writes the trail and raises a task. The
-- month is not re-opened and the refund is not touched — automatically undoing
-- a settled refund would be worse than the gap.

create or replace function public.trg_locked_month_touched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone  text := coalesce((select us_zone from public.calendar_settings where id = 1),
                           'America/New_York');
  m       public.client_months;
  v_day   date;
begin
  -- only the three things that can change whether a call counts
  if new.happened is not distinct from old.happened
     and new.matched_icp is not distinct from old.matched_icp
     and coalesce(new.dispute_status, '') = coalesce(old.dispute_status, '')
  then return new; end if;

  v_day := (coalesce(new.happened_at, new.booked_for) at time zone v_zone)::date;

  -- the month its day falls in: the same window recount_month() counts by, so
  -- this asks about the month the edit would have moved
  select * into m from public.client_months
   where client_id = new.client_id and v_day between starts_on and ends_on
   order by month_no limit 1;
  if m.id is null or m.locked_at is null then return new; end if;

  insert into public.client_events (client_id, area, event, detail)
  values (new.client_id, 'guarantee', 'locked_month_touched',
          jsonb_build_object(
            'month_id', m.id, 'month_no', m.month_no,
            'locked_at', m.locked_at, 'month_verdict', m.verdict,
            'month_says_delivered', m.calls_delivered,
            'month_says_promised', m.calls_promised,
            'month_refund_due', m.refund_due,
            'call_id', new.id, 'prospect', new.prospect_name,
            'booked_for', new.booked_for,
            'was', jsonb_build_object('happened', old.happened,
                                      'matched_icp', old.matched_icp,
                                      'dispute_status', old.dispute_status,
                                      'counts', old.counts),
            'now', jsonb_build_object('happened', new.happened,
                                       'matched_icp', new.matched_icp,
                                       'dispute_status', new.dispute_status,
                                       'counts', new.counts),
            'by', auth.uid()));

  -- Only a change that moves whether the call COUNTS can unsupport the number.
  -- A dispute merely raised has not changed anything yet, so it is recorded
  -- above but does not raise a task.
  if new.counts is distinct from old.counts then
    perform public.month_task(new.client_id,
      format('Locked month %s no longer matches its calls', m.month_no),
      format('Month %s was locked on %s saying %s of %s calls delivered, with $%s refunded. A call in that month has changed since (%s, %s): it %s now. The locked number and the refund have NOT moved. Check the refund before it is paid.',
             m.month_no, to_char(m.locked_at, 'FMDD Mon YYYY'),
             m.calls_delivered, m.calls_promised,
             to_char(coalesce(m.refund_due, 0), 'FM999,999,999'),
             coalesce(new.prospect_name, 'a prospect'),
             to_char(new.booked_for, 'FMDD Mon YYYY'),
             case when new.counts then 'counts' else 'does not count' end));
  end if;

  return new;
end $$;

drop trigger if exists qualified_calls_locked_month on public.qualified_calls;
create trigger qualified_calls_locked_month
  after update on public.qualified_calls
  for each row
  execute function public.trg_locked_month_touched();

comment on function public.trg_locked_month_touched() is
  'An edit to a call inside a LOCKED month is allowed, recorded and raised. Writes a client_events row with the before and after, and a finance task when the change moves whether the call counts — because then the locked number and the refund behind it no longer match the calls. Nothing is re-opened and no refund is changed.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. THE INDEX THE SWEEP READS BY
-- ─────────────────────────────────────────────────────────────────────────────
-- v_months_to_close filters on locked_at is null and ends_on, every hour.

create index if not exists client_months_open_ends_on
  on public.client_months (ends_on)
  where locked_at is null;

create index if not exists qualified_calls_no_verdict
  on public.qualified_calls (client_id, booked_for)
  where verdict_at is null;
