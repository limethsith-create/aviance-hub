-- 20261209_commitment.sql
--
-- NOT APPLIED. Written as a file on purpose: this session could not run DDL
-- against the live project, so nothing below has touched the database. Apply it
-- yourself and read the notes first — the second half changes a column four
-- other screens read.
--
-- WHAT THIS IS FOR
-- The hub now has one screen that looks across the whole book instead of one
-- client at a time: the commitment board at the top of Today (guarantee.js). It
-- works today WITHOUT this file, by reading v_month_standing and adding up the
-- database's own per-month figures in the browser. That is honest — every figure
-- on a row is the view's — but the adding up is in the wrong place. This moves
-- it into the database, where the rest of the money already lives.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT WAS WRONG, AND WHY IT COST MONEY
--
-- 1. v_exposure.at_risk_total answers a question nobody asks.
--    It sums at_risk over EVERY month whose verdict is 'open'. On 2026-11-26
--    that was $69,300 over 22 months — and $36,000 of it was months that had
--    not begun (one client had ten of them, the last ending 2027-09-09) plus
--    two months that had ENDED weeks earlier and were never locked. It is a
--    true number under the name "everything this book could ever owe". It is
--    not "what this month costs me if nothing changes", which is the question
--    a person asks at the top of a Tuesday.
--
-- 2. v_month_standing.warn_now fires on the wrong months, in both directions.
--      open AND calls_delivered < calls_promised AND (ends_on - CURRENT_DATE) <= 10
--    It has no lower bound, so a month that ended 48 days ago and was never
--    locked is still "warning". Two of the three months it flagged on
--    2026-11-26 had already ended: there is nothing to warn about, they need
--    lock_month. And it flagged NONE of the three months that were actually in
--    trouble — including a $9,000 month-one Scale client at 0 of 15 with 15
--    days left, whose own portal was already telling them "Behind".
--    A count-and-days test cannot see that. 5 short with 10 days left is half a
--    call a day for a Starter and one and a half for a Scale.
--
-- 3. days_left is worked out in the database's zone, which is UTC, while
--    recount_month counts a month's calls in the US zone. For most of the day
--    those agree. Between 19:00 and 24:00 US Eastern they do not, and on the
--    last day of a month that is the difference between "today is the last day"
--    and "this month is over". Not changed here: it is one line
--    (CURRENT_DATE -> (now() AT TIME ZONE 'America/New_York')::date) but it
--    moves a figure every screen reads, so it is the owner's call. NEEDS-OWNER.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- ── PART 1 — ADDITIVE. Safe. Nothing reads these yet. ───────────────────────

-- Every open month, labelled by what KIND of problem it is. Three kinds, and
-- they are three different jobs:
--   'running'   started, not finished. The only money effort can still move.
--   'to_close'  ended, verdict still open. The money is spent; it needs
--               lock_month, not a push.
--   'not_begun' bought, not started. No pace to be behind yet.
-- ROUND 3: the three views below say security_invoker themselves. They were
-- safe only by inheritance — v_month_standing underneath is an invoker view —
-- and one careless `create or replace` of that view would have opened all
-- three to every signed-in client. Now each stands on its own.
create or replace view v_commitment_months
with (security_invoker = true) as
select
  s.*,
  case
    when s.starts_on > current_date then 'not_begun'
    when s.ends_on   < current_date then 'to_close'
    else 'running'
  end as phase,
  (s.ends_on - s.starts_on) + 1                       as days_total,
  greatest(1, (current_date - s.starts_on) + 1)       as days_elapsed,
  greatest(0, s.ends_on - current_date) + 1           as days_remaining,
  -- the three rates the board is built on. Numeric, not rounded: the screen
  -- decides how to print them.
  (s.calls_promised::numeric / nullif((s.ends_on - s.starts_on) + 1, 0))               as per_day_sold,
  (s.calls_short::numeric / nullif(greatest(0, s.ends_on - current_date) + 1, 0))      as per_day_needed,
  (s.calls_delivered::numeric / nullif(greatest(1, (current_date - s.starts_on) + 1), 0)) as per_day_done
from v_month_standing s
where s.verdict = 'open';

comment on view v_commitment_months is
  'Every open month with its phase (running / to_close / not_begun) and the three '
  'per-day rates the commitment board judges it on. Keep the band arithmetic itself '
  'in corePace (core.js) so the owner''s board and the client''s portal cannot drift.';

-- The headline. One row. Deliberately NOT the same question as v_exposure, and
-- named so nobody confuses them again.
create or replace view v_commitment_now
with (security_invoker = true) as
select
  count(*)                                                     as running_months,
  count(distinct client_id)                                    as running_clients,
  coalesce(sum(calls_promised), 0)                             as calls_promised,
  coalesce(sum(calls_delivered), 0)                            as calls_delivered,
  coalesce(sum(calls_short), 0)                                as calls_owed,
  min(ends_on - current_date)                                  as days_to_first_end,
  -- what it costs if nothing changes: the refund the database itself would
  -- raise, on the months that are running now and short
  coalesce(sum(at_risk) filter (where calls_short > 0), 0)     as cost_if_nothing_changes,
  coalesce(sum(at_risk) filter (where calls_short > 0 and month_no = 1), 0) as cost_month_one
from v_commitment_months
where phase = 'running';

comment on view v_commitment_now is
  'What the whole book owes THIS MONTH and what it costs if nothing changes. '
  'Months that have not started and months that ended and were never closed are '
  'excluded on purpose — see v_exposure for the all-months figure, which answers '
  '"everything this book could ever owe" and is much larger.';

-- The money that is already gone and only needs settling. Kept apart from the
-- headline so the owner never confuses a loss with a risk.
create or replace view v_commitment_to_close
with (security_invoker = true) as
select
  count(*)                       as months,
  coalesce(sum(at_risk), 0)      as refunds_due,
  min(ends_on)                   as oldest_end
from v_commitment_months
where phase = 'to_close' and calls_short > 0;

grant select on v_commitment_months, v_commitment_now, v_commitment_to_close to authenticated;

-- ── PART 2 — OPTIONAL, AND IT CHANGES SOMETHING THAT IS READ. ──────────────
--
-- This replaces warn_now. fnBehind() in finance.js, clientbook.js and two
-- other screens filter on it, so applying this changes what they show — for
-- the better, in our reading, but read it before you run it.
--
-- New meaning: "this month is RUNNING, it is short, and finishing on the number
-- now needs more than half again the pace it was sold at". That is the same
-- test corePace uses for its 'behind' band, so the owner's list and the
-- client's portal stop disagreeing.
--
-- Uncomment to apply.
--
-- ROUND 3 — READ THIS BEFORE YOU UNCOMMENT ANYTHING. The first line below used
-- to re-make v_month_standing with no `with (...)` clause. The live view carries
-- security_invoker = true, and `create or replace view` WITHOUT that clause
-- silently takes it off. Tried on a local copy of the live schema: after the
-- block as it was written, a client signed in to the portal read every other
-- client's company, plan and refund at risk from v_month_standing. The clause
-- is now in the block. Do not remove it.
--
-- create or replace view v_month_standing
-- with (security_invoker = true) as
--  select m.id as month_id, c.id as client_id, c.company, c.plan, m.month_no,
--         m.starts_on, m.ends_on, m.calls_promised, m.calls_delivered,
--         greatest(m.calls_promised - m.calls_delivered, 0) as calls_short,
--         m.ends_on - current_date as days_left,
--         m.verdict, m.locked_at,
--         case when m.verdict <> 'open' then m.refund_due
--              when m.calls_delivered >= m.calls_promised then 0
--              when m.month_no = 1 then c.monthly_fee * 2
--              else c.monthly_fee end as at_risk,
--         (m.verdict = 'open'
--          and m.calls_delivered < m.calls_promised
--          and m.starts_on <= current_date          -- running, not bought-and-waiting
--          and m.ends_on   >= current_date          -- running, not ended-and-unlocked
--          and (greatest(m.calls_promised - m.calls_delivered, 0)::numeric
--                 / nullif(greatest(0, m.ends_on - current_date) + 1, 0))
--              > 1.5 * (m.calls_promised::numeric / nullif((m.ends_on - m.starts_on) + 1, 0))
--         ) as warn_now
--    from client_months m join clients c on c.id = m.client_id;
--
-- If you apply that, the months warn_now stops reporting do not disappear —
-- they move to v_commitment_to_close, which is where they belong, and the
-- commitment board already shows them on their own line.
