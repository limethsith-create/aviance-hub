-- ============================================================================
-- Closing the money loop: a refund that is OWED can be PAID, and the client
-- can see both without emailing anybody.
--
-- **NOT APPLIED.** DELETE and apply_migration are refused on this project, so
-- this file is delivered as a file. The owner runs it. Until he does, every
-- browser-side caller in finance.js / portal-client.js falls back to what the
-- database already has, and says so in plain words — nothing breaks.
--
-- WHAT IS MISSING TODAY (checked live on 2026-11-27)
--   lock_month() writes one `refunds` row with status = 'owed' and stops.
--   `fnMarkRefundPaid` in finance.js has existed since the money was built and
--   is called by NOTHING — no screen, no button. Four live refunds totalling
--   $16,500 have sat at 'owed' since 26 Nov with no way to close them.
--   The row records no amount actually sent, no reference, and the client is
--   told only "your refund is being worked out" for ever.
--
-- WHAT THIS ADDS
--   1. refunds.paid_amount    what was actually sent (may be less than owed)
--      refunds.paid_reference the bank / Wise / Payoneer reference
--      refunds.currency       so a refund can never silently be paid in the
--                             wrong money from an invoice that was not in USD
--   2. refund_pay()           the one write. Owner only. Idempotent-ish: it
--                             refuses a refund that is already paid rather
--                             than paying it twice.
--   3. refund_waive()         the client agreed to take it as credit / wrote
--                             it off. status 'waived' is already in the CHECK
--                             constraint and nothing has ever written it.
--   4. portal_refunds()       what the CLIENT may see: their own refunds, the
--                             amount, whether it is owed or paid, and when.
--                             Scoped the same way portal_journey() is.
--   5. v_money_back           per client: what they have PAID US against what
--                             we OWE THEM. Nothing reconciled these two piles
--                             before; see the note at the bottom.
-- ============================================================================

-- ---------------------------------------------------------------- 1. columns
alter table public.refunds add column if not exists paid_amount integer;
alter table public.refunds add column if not exists paid_reference text;
alter table public.refunds add column if not exists currency text not null default 'USD';

do $$ begin
  alter table public.refunds add constraint refunds_paid_amount_check check (paid_amount is null or paid_amount >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.refunds add constraint refunds_paid_reference_check check (char_length(paid_reference) <= 120);
exception when duplicate_object then null; end $$;

comment on column public.refunds.paid_amount is
  'What was actually sent back, in refunds.currency. Null until it is paid. It can be LESS than amount (a part payment) and the difference is still owed — amount is the promise, paid_amount is the fact.';
comment on column public.refunds.paid_reference is
  'The bank / Wise / Payoneer reference for the transfer. What the owner quotes when a client says "we never got it".';

create index if not exists refunds_owed_idx on public.refunds (status, created_at) where status = 'owed';

-- ------------------------------------------------------------ 2. refund_pay()
create or replace function public.refund_pay(
  p_refund    uuid,
  p_amount    integer default null,
  p_via       text    default null,
  p_reference text    default null,
  p_on        date    default null
) returns public.refunds
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.refunds;
  c public.clients;
  v_amount integer;
  v_via text := left(btrim(coalesce(p_via,'')), 60);
  v_ref  text := left(btrim(coalesce(p_reference,'')), 120);
begin
  if not public.is_admin() then raise exception 'Only the owner can pay a refund.'; end if;

  select * into r from public.refunds where id = p_refund for update;
  if not found then raise exception 'That refund is not here any more.'; end if;
  if r.status = 'paid'  then raise exception 'That refund is already marked paid.'; end if;
  if r.status = 'waived' then raise exception 'That refund was set aside, so it cannot be paid. Reopen it first.'; end if;

  v_amount := coalesce(p_amount, r.amount);
  if v_amount <= 0 then raise exception 'Say how much was sent back.'; end if;
  if v_amount > r.amount then
    raise exception 'That is more than we owe. We owe $%, and you have entered $%.',
      to_char(r.amount, 'FM999,999,990'), to_char(v_amount, 'FM999,999,990');
  end if;
  if v_via = '' then raise exception 'Say how it was sent — bank transfer, Wise, Payoneer.'; end if;

  update public.refunds
     set status = 'paid',
         paid_at = coalesce(p_on::timestamptz, now()),
         paid_via = v_via,
         paid_amount = v_amount,
         paid_reference = nullif(v_ref, '')
   where id = r.id
  returning * into r;

  select * into c from public.clients where id = r.client_id;

  insert into public.client_events(client_id, area, event, detail)
  values (r.client_id, 'refund', 'paid', jsonb_build_object(
    'words', 'Refund of $' || to_char(r.paid_amount, 'FM999,999,990') || ' sent by ' || r.paid_via
             || case when r.paid_reference is null then '' else ' (ref ' || r.paid_reference || ')' end
             || case when r.paid_amount < r.amount
                     then '. $' || to_char(r.amount - r.paid_amount, 'FM999,999,990') || ' of it is still owed.'
                     else '.' end,
    'refund_id', r.id, 'amount', r.amount, 'paid_amount', r.paid_amount,
    'paid_via', r.paid_via, 'paid_reference', r.paid_reference));

  return r;
end $$;

comment on function public.refund_pay(uuid, integer, text, text, date) is
  'Record that a refund was actually sent: how much, how, the reference, and when. Refuses more than is owed, refuses a refund already paid, and writes the client_events line the client page shows.';

-- ---------------------------------------------------------- 3. refund_waive()
create or replace function public.refund_waive(p_refund uuid, p_why text)
returns public.refunds
language plpgsql
security definer
set search_path = public
as $$
declare r public.refunds; v_why text := left(btrim(coalesce(p_why,'')), 600);
begin
  if not public.is_admin() then raise exception 'Only the owner can set a refund aside.'; end if;
  if v_why = '' then raise exception 'Say why this refund is being set aside. A client will ask.'; end if;
  select * into r from public.refunds where id = p_refund for update;
  if not found then raise exception 'That refund is not here any more.'; end if;
  if r.status = 'paid' then raise exception 'That refund has already been paid, so it cannot be set aside.'; end if;

  update public.refunds
     set status = 'waived',
         notes = coalesce(notes || ' ', '') || 'Set aside: ' || v_why
   where id = r.id returning * into r;

  insert into public.client_events(client_id, area, event, detail)
  values (r.client_id, 'refund', 'waived', jsonb_build_object(
    'words', 'Refund of $' || to_char(r.amount, 'FM999,999,990') || ' set aside: ' || v_why,
    'refund_id', r.id, 'amount', r.amount));
  return r;
end $$;

-- -------------------------------------------------------- 4. portal_refunds()
-- What a CLIENT may see about money coming back to them. Scoped exactly the way
-- portal_journey() is, because portal_client_id() is not in this database yet.
-- The `refunds` table itself stays staff-only: the client never selects it.
create or replace function public.portal_refunds()
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare v_client uuid;
begin
  if public.portal_home() is null then raise exception 'This portal is not set up for you yet.'; end if;
  select client_id into v_client from public.client_people where user_id = auth.uid() limit 1;
  if v_client is null then raise exception 'This portal is not set up for you yet.'; end if;

  return coalesce((
    select jsonb_agg(x order by x->>'raised_at' desc) from (
      select jsonb_build_object(
        'id', r.id,
        'client_id', r.client_id,
        'month_no', m.month_no,
        'amount', r.amount,
        'currency', r.currency,
        'status', r.status,
        'paid_at', r.paid_at,
        'paid_via', r.paid_via,
        'paid_amount', r.paid_amount,
        'paid_reference', r.paid_reference,
        'raised_at', r.created_at
      ) as x
      from public.refunds r
      left join public.client_months m on m.id = r.month_id
      where r.client_id = v_client
    ) q
  ), '[]'::jsonb);
end $$;

comment on function public.portal_refunds() is
  'The signed-in client''s own refunds: what is owed, what was paid, when and how. A client owed $3,000 can see it without emailing anybody. The refunds table stays staff-only.';

revoke all on function public.portal_refunds() from public;
grant execute on function public.portal_refunds() to authenticated;

-- ------------------------------------------------------------ 5. v_money_back
-- NOTHING in the system reconciled a refund against what a client actually
-- PAID. They were two unrelated piles of numbers: invoices sum one way,
-- refunds sum another, and v_money shows both as separate totals that are never
-- compared per client.
--
-- THE ARITHMETIC THAT MATTERS (and it is not hypothetical):
--   A 3-month Growth prepay is $2,400 a month, billed once: gross $7,200 paid
--   up front. The guarantee refunds 2x the month's fee in month one and 1x in
--   every later month, so the worst case over that one prepaid term is
--       month 1 missed  2 x 2,400 = 4,800
--       month 2 missed  1 x 2,400 = 2,400
--       month 3 missed  1 x 2,400 = 2,400
--                       ---------   9,600
--   against $7,200 received. Aviance would owe $2,400 MORE than the client ever
--   paid, and no screen in the system would notice. (RH2 Scale 3month is the
--   same shape at $10,800 in and up to $14,400 out.)
--
-- This view does not change the guarantee — the owner settled it at 2x and it
-- stays. It makes the overrun VISIBLE, per client, the day it happens.
create or replace view public.v_money_back
with (security_invoker = true) as
select
  c.id as client_id,
  c.company,
  c.plan,
  c.term,
  c.monthly_fee,
  c.ended_on,
  coalesce(p.paid_in, 0)        as paid_in,
  coalesce(r.owed, 0)           as refunds_owed,
  coalesce(r.paid_out, 0)       as refunds_paid,
  coalesce(r.owed, 0) + coalesce(r.paid_out, 0) as refunds_total,
  coalesce(r.owed, 0) + coalesce(r.paid_out, 0) - coalesce(p.paid_in, 0) as over_by
from public.clients c
left join (
  select client_id, sum(amount) as paid_in
    from public.invoices where status = 'paid' group by client_id
) p on p.client_id = c.id
left join (
  select client_id,
         sum(case when status = 'owed' then amount else 0 end) as owed,
         sum(coalesce(paid_amount, case when status = 'paid' then amount else 0 end)) as paid_out
    from public.refunds group by client_id
) r on r.client_id = c.id;

comment on view public.v_money_back is
  'Per client: what they have paid us against what we owe them back. over_by above zero means we are promising back more than they ever paid — which a prepaid 3-month term can reach honestly, 2x+1x+1x against 3x.';
