-- Four gaps in how money moves, closed. Paste the whole file and run it once.
-- Safe to run twice: every step checks for itself first.
--
--   1. refund_due is readable on the standing view
--   2. part payments: an invoice can be half paid without lying about it
--   3. "next month free" actually happens, as a credit on the next invoice
--   4. a late invoice chases itself
--
-- Nothing here changes a price, a plan or the guarantee. Decisions taken, and
-- why, are at the top of each part.

-- ── 1. refund_due on the view ───────────────────────────────────────────────
-- at_risk already reads refund_due for a closed month but never showed the
-- number itself, so the hub could say what a month might cost and not what a
-- locked one did cost.
create or replace view public.v_month_standing as
 select m.id as month_id, c.id as client_id, c.company, c.plan, m.month_no,
        m.starts_on, m.ends_on, m.calls_promised, m.calls_delivered,
        greatest(m.calls_promised - m.calls_delivered, 0) as calls_short,
        m.ends_on - current_date as days_left,
        m.verdict, m.locked_at,
        m.refund_due,
        case when m.verdict <> 'open' then m.refund_due
             when m.calls_delivered >= m.calls_promised then 0
             when m.month_no = 1 then c.monthly_fee * 2
             else c.monthly_fee end as at_risk,
        m.verdict = 'open' and m.calls_delivered < m.calls_promised
          and (m.ends_on - current_date) <= 10 as warn_now
   from public.client_months m
   join public.clients c on c.id = m.client_id;

-- ── 2. part payments ────────────────────────────────────────────────────────
-- DECISION: a part-paid invoice keeps the status it had. Inventing a fourth
-- status would mean touching every place that reads one, for no new fact: how
-- much has arrived is a number, so it is kept as a number. The invoice is paid
-- the moment the number reaches the amount, and only then does anything
-- downstream happen.
alter table public.invoices
  add column if not exists amount_paid integer not null default 0;

comment on column public.invoices.amount_paid is
  'How much of this invoice has actually arrived. Equals amount once it is paid.';

create or replace function public.record_payment(
  p_invoice uuid, p_amount integer, p_via text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare inv public.invoices; v_left integer;
begin
  if not public.is_admin() then raise exception 'Only the owner can record a payment.'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment has to be more than zero.';
  end if;

  select * into inv from public.invoices where id = p_invoice for update;
  if not found then raise exception 'That invoice is not here any more.'; end if;
  if inv.status = 'void' then raise exception 'That invoice was cancelled, so it cannot be paid.'; end if;
  if inv.status = 'paid' then raise exception 'That invoice is already paid in full.'; end if;

  v_left := inv.amount - inv.amount_paid;
  if p_amount > v_left then
    raise exception 'That is more than is left on the invoice ($% still due).',
      to_char(v_left, 'FM999,999,990');
  end if;

  update public.invoices
     set amount_paid = amount_paid + p_amount
   where id = inv.id returning * into inv;

  insert into public.client_events(client_id, area, event, detail)
  values (inv.client_id, 'invoice', 'part_paid', jsonb_build_object(
    'words', '$' || to_char(p_amount, 'FM999,999,990') || ' received against invoice '
             || coalesce(inv.number,'') || '. $'
             || to_char(inv.amount - inv.amount_paid, 'FM999,999,990') || ' still due.',
    'invoice_id', inv.id, 'number', inv.number, 'amount', p_amount));

  -- the last instalment settles it, and everything that hangs off a paid
  -- invoice — the portal, the welcome email — happens exactly once, there.
  if inv.amount_paid >= inv.amount then
    return public.mark_paid(inv.id, p_via);
  end if;

  return jsonb_build_object('invoice_id', inv.id, 'client_id', inv.client_id,
                            'paid_so_far', inv.amount_paid,
                            'still_due', inv.amount - inv.amount_paid,
                            'welcome_sent', false);
end $fn$;

comment on function public.record_payment(uuid, integer, text) is
  'Records money arriving against an invoice. The invoice settles itself, and opens the portal, when the total reaches the amount.';

revoke execute on function public.record_payment(uuid, integer, text) from public, anon;
grant  execute on function public.record_payment(uuid, integer, text) to authenticated, service_role;

-- mark_paid is still the way to settle one in a single step. It is rewritten
-- from its own definition, so the only change is that the number agrees with
-- the status: a paid invoice has had all of its money arrive.
do $$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'mark_paid';
  if src is null then raise exception 'mark_paid is missing.'; end if;
  if position('amount_paid' in src) > 0 then
    raise notice 'mark_paid already settles the number — left alone';
    return;
  end if;
  src := replace(src,
    'update public.invoices set status = ''paid'', paid_at = now()',
    'update public.invoices set status = ''paid'', amount_paid = amount, paid_at = now()');
  execute src;
  raise notice 'mark_paid now settles amount_paid too';
end $$;

-- anything already settled is fully paid, by definition
update public.invoices set amount_paid = amount
 where status = 'paid' and amount_paid <> amount;

-- ── 3. "next month free" ────────────────────────────────────────────────────
-- DECISION: it is a credit of one month's fee against the client's next
-- invoice, and it means the same thing on both terms.
--   A monthly client's next invoice is one month's fee, so the credit makes
--   that month free — the promise, literally.
--   A 3-month client's next invoice covers three months; the credit takes one
--   month's fee off it. Same money, same month given away, without reshaping
--   the term or the dates — and adding a fourth month to a three-month block
--   would have broken every piece of arithmetic that counts in threes.
-- It is granted on purpose, by the owner, from the screen where he can see the
-- slip. Nothing grants it silently: a month of fee is too much money to move
-- on a date comparison alone.
alter table public.clients
  add column if not exists credit_owed integer not null default 0;
alter table public.invoices
  add column if not exists credit_applied integer not null default 0;

comment on column public.clients.credit_owed is
  'Money owed back to this client, applied to their next invoice. One month''s fee goes in here when the launch runs past day 14.';

create or replace function public.grant_free_month(p_client uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare c public.clients;
begin
  if not public.is_admin() then raise exception 'Only the owner can give a free month.'; end if;
  select * into c from public.clients where id = p_client for update;
  if not found then raise exception 'That client is not here any more.'; end if;
  if coalesce(c.monthly_fee, 0) <= 0 then
    raise exception 'That client has no monthly fee set, so there is nothing to credit.';
  end if;

  update public.clients set credit_owed = credit_owed + c.monthly_fee
   where id = c.id returning * into c;

  insert into public.client_events(client_id, area, event, detail)
  values (c.id, 'invoice', 'credit_given', jsonb_build_object(
    'words', 'One free month credited: $' || to_char(c.monthly_fee, 'FM999,999,990')
             || ' comes off their next invoice.'
             || case when coalesce(btrim(p_reason),'') <> '' then ' ' || btrim(p_reason) else '' end,
    'amount', c.monthly_fee));

  return jsonb_build_object('client_id', c.id, 'credit_owed', c.credit_owed);
end $fn$;

revoke execute on function public.grant_free_month(uuid, text) from public, anon;
grant  execute on function public.grant_free_month(uuid, text) to authenticated, service_role;

-- raise_invoice, rewritten from its own definition so nothing else can drift:
-- the only change is that a credit comes off before the invoice is written.
do $$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'raise_invoice';

  if src is null then raise exception 'raise_invoice is missing.'; end if;
  if position('credit_applied' in src) > 0 then
    raise notice 'raise_invoice already applies the credit — left alone';
    return;
  end if;

  src := replace(src,
    '  gross := c.monthly_fee * covers;',
    '  gross := c.monthly_fee * covers;' || E'\n' ||
    '  -- a free month owed comes off here, never more than the invoice itself' || E'\n' ||
    '  v_credit := least(greatest(coalesce(c.credit_owed, 0), 0), gross);' || E'\n' ||
    '  if v_credit > 0 then' || E'\n' ||
    '    update public.clients set credit_owed = credit_owed - v_credit where id = c.id;' || E'\n' ||
    '  end if;');

  src := replace(src,
    '  gross integer;',
    '  gross integer;' || E'\n' || '  v_credit integer := 0;');

  src := replace(src,
    '                               issued_on, due_on, status, notes, is_first)',
    '                               issued_on, due_on, status, notes, is_first, credit_applied)');

  src := replace(src,
    '          gross, gross,',
    '          gross, gross - v_credit,');

  src := replace(src,
    '          (m.month_no = 1))',
    '          (m.month_no = 1), v_credit)');

  src := replace(src,
    'format(''Month %s.'', m.month_no) end,',
    'format(''Month %s.'', m.month_no) end ||' || E'\n' ||
    '          case when v_credit > 0 then '' Less a free month credited: $''' || E'\n' ||
    '               || to_char(v_credit, ''FM999,999,990'') || ''.'' else '''' end,');

  execute src;
  raise notice 'raise_invoice now applies a credit';
end $$;

-- ── 4. a late invoice chases itself ─────────────────────────────────────────
-- DECISION: it raises a task, it does not email the client. An automatic
-- chasing email to somebody who has already paid by wire, or who is three days
-- late because of a bank, costs more goodwill than it collects. The owner sees
-- it on Today and decides.
create or replace function public.invoices_overdue_sweep()
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare r record; n integer := 0; v_today date;
begin
  v_today := (now() at time zone
    coalesce((select us_zone from public.calendar_settings where id = 1),
             'America/New_York'))::date;

  for r in
    select i.id, i.number, i.client_id, i.amount, i.amount_paid, i.due_on,
           v_today - i.due_on as days_late
      from public.invoices i
     where i.status = 'sent'
       and i.due_on is not null
       and i.due_on < v_today
       and coalesce(i.amount_paid, 0) < i.amount
     order by i.due_on
  loop
    perform public.month_task(
      r.client_id,
      'Invoice ' || coalesce(r.number, '') || ' is late',
      'It was due on ' || to_char(r.due_on, 'FMDay DD Mon') || ', ' || r.days_late
        || case when r.days_late = 1 then ' day ago. $' else ' days ago. $' end
        || to_char(r.amount - coalesce(r.amount_paid, 0), 'FM999,999,990')
        || ' is still due. Chase it, or write off what you have decided to write off.',
      v_today);
    n := n + 1;
  end loop;

  return jsonb_build_object('chased', n, 'as_of', v_today);
end $fn$;

comment on function public.invoices_overdue_sweep() is
  'Raises one task per invoice that is past its due date and not fully paid. month_task will not raise the same one twice.';

revoke execute on function public.invoices_overdue_sweep() from public, anon;
grant  execute on function public.invoices_overdue_sweep() to authenticated, service_role;

-- once an hour, twenty past, away from the month-end job at forty past
select cron.unschedule('aviance-invoice-chase')
 where exists (select 1 from cron.job where jobname = 'aviance-invoice-chase');
select cron.schedule('aviance-invoice-chase', '20 * * * *',
                     $$select public.invoices_overdue_sweep();$$);

-- ── proof ───────────────────────────────────────────────────────────────────
select 'amount_paid'    as part, count(*) from information_schema.columns
  where table_schema='public' and table_name='invoices' and column_name='amount_paid'
union all select 'credit_owed', count(*) from information_schema.columns
  where table_schema='public' and table_name='clients' and column_name='credit_owed'
union all select 'refund_due on view', count(*) from information_schema.columns
  where table_schema='public' and table_name='v_month_standing' and column_name='refund_due'
union all select 'raise_invoice credits', count(*) from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='raise_invoice'
    and pg_get_functiondef(p.oid) like '%credit_applied%'
union all select 'chase job', count(*) from cron.job where jobname='aviance-invoice-chase';
