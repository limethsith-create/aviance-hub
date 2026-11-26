-- The guarantee maths: two bugs found by exercising the live functions inside a
-- rolled-back transaction. Both cost money or trust, both are one clause each.
--
-- NOT YET APPLIED to the project. Apply with the other 20261207/08 files.
--
-- 1. recount_month counted a month from qualified_calls.month_id, and month_id
--    was only ever SET, never released. So a call that counted in month 1 and
--    then moved into month 2 (rescheduled, or its happened_at corrected) was
--    counted in BOTH:
--
--      recount_month(month 1)  -- call still points at month 1 -> month 1 = 1
--      recount_month(month 2)  -- claims the call           -> month 2 = 1
--
--    One delivered call satisfying two guarantees, and month 1's refund never
--    raised. The order matters, which is why it is quiet: recounting the newer
--    month first gives the right answer, the older month first does not.
--    wrapup.js ends a client with `.order('month_no')` — oldest first, the
--    wrong order — and call_verdict() in 20261207_showup.sql recounts the
--    call's current month before the month its day falls in, also the wrong
--    order. Proven on the live functions:
--      month 1 delivered = 1, month 2 delivered = 1, one call.
--
--    The fix: a month's delivered count is the calls that COUNT and whose day
--    falls inside that month's window. month_id stays as the pointer the call
--    lists read, and no row is detached, so a no-show still shows under the
--    month it was booked in.
--
-- 2. raise_invoice created a month-one invoice without is_first, so it defaulted
--    to false — and mark_paid() opens the portal and sends the welcome email only
--    `if inv.is_first`. A client whose month one was invoiced this way pays and
--    nothing happens: no portal, no welcome, no stage change. Today close_won()
--    always makes the is_first invoice first and raise_invoice adopts it, so no
--    live row is wrong; the moment that invoice is voided, or a client is set up
--    by hand, the first payment goes silent.
--
--    Also pins search_path. raise_invoice had none, and it is called from
--    client_first_month(), which is SECURITY DEFINER.

create or replace function public.recount_month(p_month uuid)
returns integer
language plpgsql
set search_path = public
as $$
declare
  m public.client_months;
  d integer;
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
     and (q.month_id is distinct from m.id);

  -- the number is the window, never the pointer: a call that has moved out of
  -- this month stops counting here the moment this month is recounted, whichever
  -- month is recounted first.
  select count(*) into d
    from public.qualified_calls q
   where q.client_id = m.client_id
     and q.counts
     and (q.happened_at at time zone v_zone)::date between m.starts_on and m.ends_on;

  update public.client_months set calls_delivered = d where id = p_month;
  return d;
end $$;

comment on function public.recount_month(uuid) is
  'What a month delivered: the calls that count (happened and matched the profile and no upheld dispute) whose day, in the house US zone, falls inside the month. A locked month never moves.';

create or replace function public.raise_invoice(p_month uuid, p_due_days integer default 0)
returns public.invoices
language plpgsql
set search_path = public
as $$
declare
  m public.client_months;
  c public.clients;
  inv public.invoices;
  covers integer := 1;
  gross integer;
begin
  select * into m from public.client_months where id = p_month;
  if not found then raise exception 'That month does not exist.'; end if;
  select * into c from public.clients where id = m.client_id;

  select * into inv from public.invoices where month_id = p_month limit 1;
  if found then return inv; end if;

  if m.month_no = 1 then
    select * into inv from public.invoices
      where client_id = c.id and is_first and month_id is null and status <> 'void' limit 1;
    if found then
      update public.invoices set month_id = m.id where id = inv.id returning * into inv;
      return inv;
    end if;
  end if;

  -- a client left on a plan that is not on offer is never invoiced as if it were another plan
  if c.plan not in ('starter','growth','scale') then
    raise exception 'That plan is no longer offered. Choose Starter, Growth or Scale.';
  end if;

  if c.term = '3month' then
    if (m.month_no - 1) % 3 <> 0 then
      return null;
    end if;
    covers := 3;
  end if;

  gross := c.monthly_fee * covers;

  insert into public.invoices (client_id, month_id, number, gross_amount, amount,
                               issued_on, due_on, status, notes, is_first)
  values (c.id, m.id,
          'AV-' || to_char(now(),'YYYY') || '-' || nextval('public.invoice_no_seq'),
          gross, gross,
          current_date, current_date + p_due_days, 'draft',
          case when covers = 3 then format('Months %s-%s, 3-month term.', m.month_no, m.month_no + 2)
               else format('Month %s.', m.month_no) end,
          -- month one is the first invoice. mark_paid() opens the portal and
          -- sends the welcome off this flag, so it must be right here too.
          (m.month_no = 1))
  returning * into inv;

  return inv;
end $$;

comment on function public.raise_invoice(uuid, integer) is
  'The invoice for a month. Returns the existing one if there is one; a 3-month term bills months 1, 4, 7 and returns null in between. A month-one invoice is marked is_first, which is what opens the portal when it is paid.';
