-- =====================================================================================
-- 20261129  The $300 Pilot is gone, and the client agreement is rewritten (v3).
--
-- The offer is three plans only: Starter (5 calls), Growth (10), Scale (15), each either
-- month to month or on a 3-month term at 20% off, billed up front. After this file nothing
-- in the database produces, prices, credits or mentions the retired one-off plan.
--
-- Replaced, each with its FULL body (started from the live definition; signature, security
-- definer, search_path and grants are unchanged because `create or replace` keeps them):
--   close_won(p_booking, p_plan, p_term)   accepts starter / growth / scale only
--   raise_invoice(p_month, p_due_days)     no credit; same billing rhythm as before
--   agreement_terms(p_client)              the rewritten agreement, numbered clauses
--   mail_pack(p_client, urls)              the "Agreement + invoice" email, no credit line
--   doc_get_core(p_token)                  what doc.html reads; richer invoice line
--   documents_preview()                    six packs: each plan, monthly and 3-month
--
-- NOT changed here, on purpose (dropping or deleting needs the owner's say-so):
--   * columns clients.pilot_credit, clients.pilot_credit_used, invoices.pilot_credit stay,
--     at their defaults (0 / false). Nothing reads or writes them any more.
--   * the retired row in plan_prices and the old plan code in three CHECK constraints stay.
--     close_won refuses the code, so the row can never be sold.
--
-- Idempotent: safe to run twice.
-- =====================================================================================

-- ------------------------------------------------------------------------------------
-- 1. close_won: the owner marks a discovery call won
-- ------------------------------------------------------------------------------------
create or replace function public.close_won(p_booking uuid, p_plan text, p_term text default 'monthly'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  b public.discovery_bookings; pp public.plan_prices; c public.clients; per public.client_people;
  ch public.channels; ag public.client_agreements; inv public.invoices;
  v_plan text := lower(btrim(coalesce(p_plan,'')));
  v_term text := coalesce(nullif(btrim(p_term),''),'monthly'); v_fee integer; v_gross integer;
  v_site text := rtrim(public.biz('site'),'/'); v_label text; m jsonb;
begin
  if not public.is_admin() then raise exception 'Only the owner can mark a call won.'; end if;
  select * into b from public.discovery_bookings where id = p_booking for update;
  if not found then raise exception 'That call is not on the calendar any more.'; end if;
  if exists (select 1 from public.clients where booking_id = p_booking) then raise exception 'That call is already a client.'; end if;
  if v_plan = '' then raise exception 'Pick a plan first: Starter, Growth or Scale.'; end if;
  -- Three plans are on offer. Every other code is refused in plain words and never mapped to
  -- another plan; that includes the retired 'pilot' code, which is refused here like any other.
  if v_plan not in ('starter','growth','scale') then
    raise exception 'That plan is no longer offered. Choose Starter, Growth or Scale.';
  end if;
  select * into pp from public.plan_prices where plan = v_plan;
  if not found then raise exception 'That plan has no price yet. Add it in Settings first.'; end if;
  if v_term not in ('monthly','3month') then raise exception 'The term is either monthly or 3 months.'; end if;
  if coalesce(pp.three_month_fee,0) = 0 then v_term := 'monthly'; end if;
  if coalesce(btrim(b.email),'') !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'That booking has no email address to send the pack to.'; end if;
  v_fee := case when v_term = '3month' then pp.three_month_fee else pp.monthly_fee end;

  insert into public.clients(booking_id, company, contact_name, contact_email, website, plan, term, calls_promised, monthly_fee, stage, owner_id)
  values (b.id, left(b.company,200), left(b.name,160), left(b.email,200), left(b.website,300), pp.plan, v_term, pp.calls_promised, v_fee, 'won', auth.uid())
  returning * into c;

  insert into public.client_people(client_id, full_name, email, phone, role, is_primary, timezone)
  values (c.id, c.contact_name, c.contact_email, b.phone, b.role, true, b.timezone) returning * into per;

  insert into public.channels(name, purpose, kind, client_id, created_by)
  values (c.company, 'Your direct line to the Aviance team', 'client', c.id, auth.uid()) returning * into ch;
  insert into public.channel_members(channel_id, user_id, member_role) values (ch.id, auth.uid(), 'owner');
  insert into public.channel_members(channel_id, person_id) values (ch.id, per.id);

  v_gross := v_fee * (case when v_term = '3month' then 3 else 1 end);
  v_label := pp.label || ' · ' || pp.calls_promised || ' qualified calls a month'
             || case when v_term = '3month' then ' · 3-month term' else ' · month 1' end;

  insert into public.invoices(client_id, month_id, number, gross_amount, amount, issued_on, due_on, status, sent_at, notes, is_first)
  values (c.id, null, 'AV-' || to_char(now(),'YYYY') || '-' || nextval('public.invoice_no_seq'),
          v_gross, v_gross, current_date, current_date + 7, 'sent', now(), v_label, true)
  returning * into inv;

  insert into public.client_agreements(client_id, terms) values (c.id, public.agreement_terms(c.id)) returning * into ag;

  update public.discovery_bookings set status = 'won', plan = pp.plan where id = b.id;

  m := public.mail_pack(c.id, v_site || '/doc.html#' || public.doc_token('a', ag.id), v_site || '/doc.html#' || public.doc_token('i', inv.id));
  insert into public.mail_outbox(to_email, to_name, subject, body_text, body_html, kind, client_id, needs_meet_link)
  values (c.contact_email, c.contact_name, m->>'subject', m->>'text', m->>'html', 'agreement', c.id, false);

  -- the history: what just happened, in the words the client page shows
  insert into public.client_events(client_id, area, event, detail) values
    (c.id, 'client', 'won', jsonb_build_object(
       'words', 'Won on the discovery call: ' || initcap(pp.plan) || case when v_term = '3month' then ' · 3 months' else ' · monthly' end || '.',
       'plan', pp.plan, 'term', v_term, 'booking_id', b.id)),
    (c.id, 'agreement', 'sent', jsonb_build_object(
       'words', 'Agreement sent to ' || c.contact_email || '.', 'agreement_id', ag.id)),
    (c.id, 'invoice', 'sent', jsonb_build_object(
       'words', 'Invoice ' || inv.number || ' for $' || to_char(inv.amount, 'FM999,999,990') || ' sent, due ' || to_char(inv.due_on, 'FMDD Mon') || '.',
       'invoice_id', inv.id, 'number', inv.number, 'amount', inv.amount));

  return jsonb_build_object('client_id', c.id, 'invoice_id', inv.id, 'agreement_id', ag.id, 'invoice_number', inv.number,
                            'amount', inv.amount, 'due_on', inv.due_on, 'email', c.contact_email);
end $function$;

-- ------------------------------------------------------------------------------------
-- 2. raise_invoice: the invoice for a month (not security definer, as before)
--    Billing rhythm is unchanged: a 3-month term bills on months 1, 4, 7 and returns null
--    in between. See DECISIONS in the hand-over: agreement clause 7.1 says a 3-month term
--    carries on month to month once the 3 months are up, which this rhythm does not do yet.
-- ------------------------------------------------------------------------------------
create or replace function public.raise_invoice(p_month uuid, p_due_days integer default 0)
 returns invoices
 language plpgsql
as $function$
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
                               issued_on, due_on, status, notes)
  values (c.id, m.id,
          'AV-' || to_char(now(),'YYYY') || '-' || nextval('public.invoice_no_seq'),
          gross, gross,
          current_date, current_date + p_due_days, 'draft',
          case when covers = 3 then format('Months %s-%s, 3-month term.', m.month_no, m.month_no + 2)
               else format('Month %s.', m.month_no) end)
  returning * into inv;

  return inv;
end $function$;

-- ------------------------------------------------------------------------------------
-- 3. agreement_terms: the agreement a client reads and signs (v3)
--    Returns {title, intro, parties, sections, signatures, placeholders}.
--    A [bracketed] phrase is a default the owner may want to change: the client reads it as
--    plain text (doc.html drops the brackets) and `placeholders` asks the owner one plain
--    question per bracket, with its clause number. [ALL CAPS] brackets are true gaps.
-- ------------------------------------------------------------------------------------
create or replace function public.agreement_terms(p_client uuid)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  c        record;
  v_plan   text;
  v_calls  text;
  v_fee    text;      -- what one month costs this client, e.g. $2,400
  v_double text;      -- twice that
  v_qtr    text;      -- three times that
  v_list   integer;   -- the plan's month-to-month price, for "20% off the $3,000 monthly price"
  v_off    text := '';
  v_legal  text := coalesce(nullif(public.biz('legal_name'),''),'[YOUR COMPANY LEGAL NAME]');
  v_addr   text := coalesce(nullif(public.biz('address'),''),'[YOUR COMPANY ADDRESS]');
  v_signer text := coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()), '[YOUR NAME]');
  v_3mo    boolean;
  s1 jsonb; s2 jsonb; s3 jsonb; s4 jsonb; s5 jsonb; s6 jsonb; s7 jsonb; s8 jsonb; s9 jsonb;
  ph text[] := '{}';
begin
  select * into c from public.clients where id = p_client;
  if not found then
    raise exception 'That client does not exist.';
  end if;
  if c.plan not in ('starter','growth','scale') then
    raise exception 'That plan is no longer offered. Choose Starter, Growth or Scale.';
  end if;

  v_3mo    := (c.term = '3month');
  v_plan   := initcap(c.plan);
  v_calls  := c.calls_promised::text;
  v_fee    := '$' || to_char(c.monthly_fee, 'FM999,999,990');
  v_double := '$' || to_char(c.monthly_fee * 2, 'FM999,999,990');
  v_qtr    := '$' || to_char(c.monthly_fee * 3, 'FM999,999,990');
  if v_3mo then
    select pp.monthly_fee into v_list from public.plan_prices pp where pp.plan = c.plan;
    if coalesce(v_list, 0) > c.monthly_fee then
      v_off := ' (' || round(100.0 * (v_list - c.monthly_fee) / v_list)::text || '% off the $'
               || to_char(v_list, 'FM999,999,990') || ' monthly price)';
    end if;
  end if;

  -- 1. What you are buying
  s1 := jsonb_build_array(
    '1.1 You are on the ' || v_plan || ' plan: ' || v_calls || ' booked calls a month. We find people who match your target profile, email them, and book sales calls on your calendar.',
    '1.2 Domains, inboxes, warm-up, contact data and software are all included in the fee. There is no setup fee.',
    '1.3 [Your first month starts on the day your first emails go out (your launch day), not the day you sign. Each later month starts on the same date of the next calendar month.]');

  -- 2. What counts as a booked call
  s2 := jsonb_build_array(
    '2.1 A booked call is a prospect who matches the target profile we agreed with you and who has accepted a meeting at a confirmed time. Our invoices and emails call this a "qualified call". It means the same thing.',
    '2.2 A call counts only if it happens. A no-show does not count toward your number.',
    '2.3 If you think a call did not match the target profile, tell us within [5 business days] of the call. We check it together, and if you are right it does not count.');

  -- 3. Fees and payment
  if v_3mo then
    s3 := jsonb_build_array(
      '3.1 The fee is ' || v_fee || ' a month on a 3-month term' || v_off || '. We invoice all 3 months (' || v_qtr || ') up front.');
  else
    s3 := jsonb_build_array(
      '3.1 The fee is ' || v_fee || ' a month, month to month. We invoice once a month, in advance.');
  end if;
  s3 := s3 || jsonb_build_array(
    '3.2 Each invoice is payable [in full within 7 days of the invoice date]. All fees are in US dollars. We start work when your first invoice is paid.');

  -- 4. What we need from you (the guarantee's conditions, with a fair mechanism)
  s4 := jsonb_build_array(
    '4.1 We need three things from you: (a) sign off your target profile in writing, (b) approve the email copy before anything sends, and (c) keep time free on your calendar for the calls we book.',
    '4.2 Nothing sends until you have signed off the target profile and approved the copy. Answer each approval request within [2 business days].',
    '4.3 The guarantee depends on these three things. If we are waiting on you, the clock pauses: [each day an approval is overdue, or your calendar has no free time for a prospect who is ready to book, is added to the 14 days in 5.3 and to the month we are in]. We tell you in writing the day the clock pauses and the day it starts again.',
    '4.4 [If a prospect turns up to a booked call and you do not, the call counts.]');

  -- 5. Our guarantee
  s5 := jsonb_build_array(
    '5.1 Month one: if we deliver fewer than ' || v_calls || ' booked calls in your first month, we refund twice that month''s fee: ' || v_double || ' back.',
    '5.2 Later months: if we deliver fewer than ' || v_calls || ' booked calls in any later month, we refund that month''s fee in full.',
    '5.3 Late launch: if your campaign is not live within 14 days of your kickoff call, your next month is free. '
      || case when v_3mo then '[We add one free month to the end of your 3-month term.]'
              else '[We do not invoice your second month.]' end,
    '5.4 A refund is money back, not a credit. We pay it [by bank transfer to the account you paid from] within [10 business days] of the end of the month we missed.');
  if v_3mo then
    s5 := s5 || jsonb_build_array(
      '5.5 On your 3-month term the guarantee covers every month. [Each month''s refund is worked out on that month''s share of what you paid: ' || v_fee || '.]',
      '5.6 We guarantee booked calls, not sales. What happens on the call is up to you.');
  else
    s5 := s5 || jsonb_build_array(
      '5.5 We guarantee booked calls, not sales. What happens on the call is up to you.');
  end if;

  -- 6. How we send
  s6 := jsonb_build_array(
    '6.1 We send from domains and inboxes that we buy and run for this work. Nothing sends from your own domain.',
    '6.2 We follow US anti-spam law (CAN-SPAM): every email carries real sender details and a working opt-out.',
    '6.3 Tell us anyone who must never be contacted and we keep them off every list.');

  -- 7. Term and ending
  if v_3mo then
    s7 := jsonb_build_array(
      '7.1 This agreement runs for 3 months from your launch day. After that it carries on month to month [at the same price of ' || v_fee || ' a month, invoiced monthly] until either of us ends it with 14 days'' notice by email.');
  else
    s7 := jsonb_build_array(
      '7.1 This agreement runs month to month. Either of us can end it with 14 days'' notice by email.');
  end if;
  s7 := s7 || jsonb_build_array(
    '7.2 [Notice given at least 14 days before your next month starts means that month is not invoiced. Notice given later than that means the next month is your last.]',
    '7.3 A month you have already paid for is not refunded, except under the guarantee in clause 5.');

  -- 8. Confidentiality and your data
  s8 := jsonb_build_array(
    '8.1 We each keep the other''s private business information confidential, during this agreement and after it ends.',
    '8.2 Your data and your lists stay yours. We use them only to do this work, and when the agreement ends we delete them or hand them back [within 30 days] if you ask.');

  -- 9. The small print
  s9 := jsonb_build_array(
    '9.1 [Our total liability under this agreement is limited to the fees you paid us in the 3 months before the claim. This limit does not reduce a refund owed under clause 5.]',
    '9.2 This is the whole agreement. Changes must be agreed in writing, and an email counts. Typing your name and pressing Sign is your signature.',
    '9.3 This agreement is governed by [the laws of Sri Lanka].');

  -- one plain question per bracket left in the text, each saying where it is and what the draft says
  if v_legal like '[%' then
    ph := ph || 'What is your company''s legal name? Draft just says "Aviance" until you add it in Settings.'::text;
  end if;
  if v_addr like '[%' then
    ph := ph || 'What is your company''s address? Draft leaves it out until you add it in Settings.'::text;
  end if;
  if v_signer like '[%' then
    ph := ph || 'Who signs for Aviance? The signature line says [YOUR NAME], Founder until a signer name is saved in the business settings.'::text;
  end if;
  ph := ph || array[
    'Clause 1.3: when does a client''s month start and end? Draft says it starts the day their first emails go out and runs to the same date next month, not the calendar month.',
    'Clause 2.3: how long does a client have to dispute a call? Draft says 5 business days.',
    'Clause 3.2: what are your payment terms? Draft says in full within 7 days of the invoice date.',
    'Clause 4.2: how fast must the client answer an approval request? Draft says 2 business days.',
    'Clause 4.3: what happens while you wait on the client (a late approval, or no free time on their calendar)? Draft says the clock pauses: those days are added to the 14-day launch deadline and to the month.',
    'Clause 4.4: does a call count if the prospect turns up and the client does not? Draft says yes.',
    'Clause 5.3: what does "next month free" mean in practice? Draft says '
      || case when v_3mo then 'one free month is added to the end of the 3-month term.' else 'the second month is not invoiced.' end,
    'Clause 5.4: how and how fast do you pay a refund? Draft says by bank transfer to the account they paid from, within 10 business days of the end of the month you missed.'
  ]::text[];
  if v_3mo then
    ph := ph || array[
      'Clause 5.5: on a 3-month term, what is "that month''s fee" for a refund? Draft says that month''s share of what they paid (' || v_fee || ').',
      'Clause 7.1: what happens after the 3 months? Draft says it carries on month to month at the same monthly price, invoiced monthly.'
    ]::text[];
  end if;
  ph := ph || array[
    'Clause 7.2: when does 14 days'' notice take effect? Draft says notice at least 14 days before the next month starts stops that month being invoiced; later notice makes the next month the last.',
    'Clause 8.2: how soon do you delete or return a client''s data when asked? Draft says within 30 days.',
    'Clause 9.1: how much can you be held liable for? Draft says the fees the client paid in the 3 months before the claim, and that the cap never reduces a guarantee refund.',
    'Clause 9.3: which country''s law governs the agreement, and where are disputes heard? Draft says the laws of Sri Lanka and names no court or city.'
  ]::text[];

  return jsonb_build_object(
    'title', 'Service Agreement',
    'intro', 'This is the whole agreement between Aviance ("we") and ' || c.company
             || ' ("you"). It is short, in plain English, and it starts the day you sign it.',
    -- an unset legal name reads plain 'Aviance' and an unset address is left out;
    -- the owner is asked for both in `placeholders`
    'parties', jsonb_build_array(
      jsonb_build_object('label', 'Aviance (we)',  'value', case when v_legal like '[%' then 'Aviance' else v_legal end))
      || case when v_addr like '[%' then '[]'::jsonb
              else jsonb_build_array(jsonb_build_object('label', 'Our address', 'value', v_addr)) end
      || jsonb_build_array(
      jsonb_build_object('label', 'Client (you)',  'value', c.company),
      jsonb_build_object('label', 'Your contact',  'value', c.contact_name || ', ' || c.contact_email)),
    'sections', jsonb_build_array(
      jsonb_build_object('h', '1. What you are buying',            'body', s1),
      jsonb_build_object('h', '2. What counts as a booked call',   'body', s2),
      jsonb_build_object('h', '3. Fees and payment',               'body', s3),
      jsonb_build_object('h', '4. What we need from you',          'body', s4),
      jsonb_build_object('h', '5. Our guarantee',                  'body', s5),
      jsonb_build_object('h', '6. How we send',                    'body', s6),
      jsonb_build_object('h', '7. Term and ending',                'body', s7),
      jsonb_build_object('h', '8. Confidentiality and your data',  'body', s8),
      jsonb_build_object('h', '9. The small print',                'body', s9)),
    'signatures', jsonb_build_array(
      jsonb_build_object('label', 'For Aviance', 'name', v_signer, 'role', 'Founder', 'org', 'Aviance')),
    'placeholders', to_jsonb(ph));
end
$function$;

-- ------------------------------------------------------------------------------------
-- 4. mail_pack: the "Agreement + invoice" email
-- ------------------------------------------------------------------------------------
create or replace function public.mail_pack(p_client uuid, p_agreement_url text, p_invoice_url text)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  c       record;
  inv     record;
  v_first text;
  v_plan  text;
  v_what  text;      -- '5 qualified calls a month' (+ the 3-month price when that is the term)
  v_num   text; v_amt text; v_due text; v_short text;
  v_howpay text;     -- step 02: where the payment details are
  v_subj  text;
  v_agree text := coalesce(p_agreement_url, '');
  v_pay   text := coalesce(p_invoice_url, '');
  mono text := $s$font-family:'JetBrains Mono','Courier New',Courier,monospace;$s$;
  body text; html text; txt text;
begin
  select * into c from public.clients where id = p_client;
  if not found then
    raise exception 'That client does not exist.';
  end if;
  select * into inv from public.invoices where client_id = p_client order by created_at desc limit 1;

  v_first := coalesce(nullif(split_part(btrim(coalesce(c.contact_name, '')), ' ', 1), ''), 'there');
  v_plan  := initcap(c.plan);
  v_what  := c.calls_promised || ' qualified calls a month'
             || case when c.term = '3month'
                     then ', $' || to_char(c.monthly_fee, 'FM999,999,990') || ' a month for 3 months, paid up front' else '' end;
  v_num   := coalesce(inv.number, '');
  v_amt   := '$' || to_char(coalesce(inv.amount,
               c.monthly_fee * case when c.term = '3month' then 3 else 1 end), 'FM999,999,990');
  v_due   := case when inv.due_on is null then 'Due on receipt' else 'Due ' || to_char(inv.due_on, 'FMMonth FMDD, YYYY') end;
  v_short := case when inv.due_on is null then 'due on receipt' else 'due ' || to_char(inv.due_on, 'Mon FMDD') end;
  -- the invoice page only shows bank details once they are really filled in
  if coalesce(public.biz('wise_details'), '') ~ '^\s*(\[|$)' and coalesce(public.biz('payoneer_link'), '') = '' then
    v_howpay := 'We will send you the payment details directly.';
  else
    v_howpay := 'The payment details are on it.';
  end if;
  v_subj := case when v_num = '' then 'Your Aviance agreement and invoice'
                 else 'Agreement + invoice ' || v_num || ' · ' || v_amt || ' ' || v_short end;

  body := $s$<tr><td class="pad" style="padding:52px 40px 40px">
<div style="font-size:20px;color:#5C5C5C;padding-bottom:18px">Hi [[NAME]],</div>
<div class="h1" style="font-size:72px;line-height:1.08;font-weight:800;letter-spacing:-0.04em">Let&rsquo;s get you<br><span style="background:#E0290F;color:#FFFFFF;padding:0 10px">booked calls.</span></div>
<div style="font-size:18px;line-height:1.5;color:#000000;padding-top:28px">Great to be working with [[COMPANY]]. You are on the <b>[[PLAN]]</b> plan: <b>[[WHAT]]</b>, guaranteed. Two quick steps and we get to work.</div></td></tr>
<tr><td class="pad" style="padding:28px 40px 0;border-top:2px solid #000000">
<div style="[[MONO]]font-size:12px;font-weight:700;letter-spacing:0.16em;color:#5C5C5C;padding-bottom:16px">TWO STEPS TO START</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:18px;line-height:1.45">
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 0 0">01</td><td><b>Sign the agreement.</b> Short, in plain English. Type your name and you are done.</td></tr>
</table></td></tr>
<tr><td class="pad" style="padding:20px 40px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#E0290F" style="background:#E0290F"><a class="btn" href="[[AGREE_URL]]" style="display:block;padding:26px 20px;font-size:26px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Read and sign &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 20px">
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:18px;line-height:1.45">
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 0 0">02</td><td><b>Pay the invoice.</b> [[HOWPAY]]</td></tr>
</table></td></tr>
<tr><td class="pad" bgcolor="#000000" style="background:#000000;padding:36px 40px 40px;color:#FFFFFF">
<div style="[[MONO]]font-size:12px;font-weight:700;letter-spacing:0.16em;color:#BDBDBD">INVOICE [[INV_NUM]]</div>
<div style="[[MONO]]font-weight:700;letter-spacing:-0.05em;padding:8px 0"><span class="big" style="font-size:96px;line-height:1">[[AMOUNT]]</span></div>
<div style="font-size:20px;color:#BDBDBD;padding-bottom:28px">[[DUE]]</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#FFFFFF" style="background:#FFFFFF"><a class="btn" href="[[PAY_URL]]" style="display:block;padding:26px 20px;font-size:26px;font-weight:800;letter-spacing:-0.01em;color:#000000;text-decoration:none">View invoice &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" style="padding:28px 40px 36px;font-size:18px;line-height:1.5;color:#5C5C5C">Once both are done, we open your private channel and book your kickoff.</td></tr>$s$;

  html := $s$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviance</title>
<style>@media (max-width:480px){.h1{font-size:52px!important}.big{font-size:60px!important}.num{font-size:60px!important}.pad{padding-left:22px!important;padding-right:22px!important}.btn{font-size:22px!important}.datebox{width:118px!important}}</style></head>
<body style="margin:0;padding:0;background:#F2F2F2"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F2F2"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:'Inter Tight',Arial,Helvetica,sans-serif;color:#000000">
<tr><td class="pad" style="padding:18px 40px;border-bottom:2px solid #000000"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td><img src="https://www.aviance.online/logo-180.png" width="44" height="44" alt="" style="vertical-align:middle;border:0"><span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;vertical-align:middle;padding-left:10px">Aviance</span></td>
<td align="right"><span style="[[MONO]]font-size:13px;font-weight:700;letter-spacing:0.12em;background:[[TAGBG]];color:#FFFFFF;padding:8px 12px">[[TAG]]</span></td></tr></table></td></tr>
[[BODY]]
<tr><td class="pad" bgcolor="#000000" style="background:#000000;padding:26px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:15px;color:#FFFFFF">[[FOOT]]</td>
<td align="right"><a href="https://www.aviance.online" style="[[MONO]]font-size:12px;letter-spacing:0.1em;color:#BDBDBD;text-decoration:none">AVIANCE.ONLINE</a></td></tr></table></td></tr>
</table></td></tr></table></body></html>$s$;

  html := replace(html, '[[BODY]]', body);
  html := replace(html, '[[MONO]]', mono);
  html := replace(html, '[[TAG]]', 'WELCOME ABOARD');
  html := replace(html, '[[TAGBG]]', '#000000');
  html := replace(html, '[[FOOT]]', 'Questions? Just reply.');
  html := replace(html, '[[HOWPAY]]', v_howpay);
  html := replace(html, '[[PLAN]]', replace(replace(replace(v_plan, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[WHAT]]', v_what);
  html := replace(html, '[[AMOUNT]]', v_amt);
  html := replace(html, '[[DUE]]', v_due);
  -- everything below came from the client row or from the caller, so it is escaped
  html := replace(html, '[[INV_NUM]]', replace(replace(replace(v_num, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[AGREE_URL]]', replace(replace(replace(replace(v_agree, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[PAY_URL]]', replace(replace(replace(replace(v_pay, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[NAME]]', replace(replace(replace(v_first, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[COMPANY]]', replace(replace(replace(c.company, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));

  txt := 'Hi ' || v_first || E',\n\n'
      || 'Great to be working with ' || c.company || '. You are on the ' || v_plan || ' plan: ' || v_what
      || E', guaranteed. Two quick steps and we get to work.\n\n'
      || E'1. Sign the agreement. Short, in plain English. Type your name and you are done.\n' || v_agree || E'\n\n'
      || '2. Pay the invoice. ' || v_howpay || E'\n'
      || 'Invoice ' || v_num || ': ' || v_amt || '. ' || v_due || '.' || E'\n' || v_pay || E'\n\n'
      || E'Once both are done, we open your private channel and book your kickoff.\n\n'
      || E'Questions? Just reply.\n\nAviance';

  return jsonb_build_object('subject', v_subj, 'text', txt, 'html', html);
end
$function$;

-- ------------------------------------------------------------------------------------
-- 5. doc_get_core: what doc.html reads for an agreement or an invoice
--    Invoice payload, new or changed keys:
--      service   'Starter · 5 qualified calls a month · 3-month term'
--      period    'Months 1–3 · starts the day your first emails go out'
--      terms     'Net 7' (the due date is its own key, so it is not repeated here)
--      lines[0]  {label, amount, months, unit, list_unit?}: months × unit = amount, and
--                list_unit is the month-to-month price when the client pays less than it
-- ------------------------------------------------------------------------------------
create or replace function public.doc_get_core(p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v uuid; ag public.client_agreements; inv public.invoices; c public.clients; m public.client_months;
  lines jsonb; v_line jsonb; v_terms jsonb; v_signer text; v_from jsonb; v_pay jsonb;
  v_wise text; v_payo text; v_phone text; v_label text; v_service text; v_period text; v_net text; v_word text;
  v_list integer; v_months integer; v_unit integer; v_known boolean;
begin
  v := public.doc_id(p_token, 'a');
  if v is not null then
    select * into ag from public.client_agreements where id = v;
    if found then
      select * into c from public.clients where id = ag.client_id;
      v_terms := coalesce(ag.terms, '{}'::jsonb) - 'placeholders';
      -- the Aviance signer: older snapshots have none, and a [YOUR NAME] fills in once it is set
      v_signer := coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()));
      if not (v_terms ? 'signatures') then
        v_terms := v_terms || jsonb_build_object('signatures', jsonb_build_array(
          jsonb_build_object('label', 'For Aviance', 'name', coalesce(v_signer, (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()), '[YOUR NAME]'), 'role', 'Founder', 'org', 'Aviance')));
      elsif v_signer is not null and coalesce(v_terms #>> '{signatures,0,name}', '') like '[%' then
        v_terms := jsonb_set(v_terms, '{signatures,0,name}', to_jsonb(v_signer));
      end if;
      return jsonb_build_object('kind','agreement','company', c.company, 'contact_name', c.contact_name,
        'status', ag.status, 'signed_name', ag.signed_name, 'signed_at', ag.signed_at, 'terms', v_terms);
    end if;
  end if;
  v := public.doc_id(p_token, 'i');
  if v is not null then
    select * into inv from public.invoices where id = v;
    if found then
      select * into c from public.clients where id = inv.client_id;

      -- what this invoice pays for: the plan, how many months, and what one month costs
      select pp.label, pp.monthly_fee into v_label, v_list from public.plan_prices pp where pp.plan = c.plan;
      v_label := coalesce(v_label, initcap(c.plan));
      if inv.month_id is not null then
        select * into m from public.client_months where id = inv.month_id;
      end if;
      v_known  := (m.id is not null or coalesce(inv.is_first, false));
      v_months := case when c.term = '3month' and c.monthly_fee > 0 and inv.gross_amount = c.monthly_fee * 3 then 3 else 1 end;
      v_unit   := case when v_months = 3 then c.monthly_fee else inv.gross_amount end;

      if v_known then
        v_service := v_label || ' · ' || c.calls_promised || ' qualified calls a month'
          || case when c.term = '3month' then ' · 3-month term' else '' end;
      else
        v_service := coalesce(nullif(inv.notes,''), v_label);
      end if;

      -- and when that period runs
      if m.id is not null then
        v_period := case when v_months = 3 then 'Months ' || m.month_no || '–' || (m.month_no + 2) else 'Month ' || m.month_no end
          || case when m.starts_on is null then ''
                  when v_months = 3 then ' · ' || to_char(m.starts_on, 'Mon FMDD') || ' – '
                       || to_char((m.starts_on + interval '3 months' - interval '1 day')::date, 'Mon FMDD, YYYY')
                  when m.ends_on is not null then ' · ' || to_char(m.starts_on, 'Mon FMDD') || ' – ' || to_char(m.ends_on, 'Mon FMDD, YYYY')
                  else '' end;
      elsif coalesce(inv.is_first, false) then
        v_period := case when v_months = 3 then 'Months 1–3' else 'Month 1' end || ' · starts the day your first emails go out';
      else
        v_period := null;
      end if;

      v_line := jsonb_build_object('label', v_service, 'amount', inv.gross_amount);
      if v_known then
        v_line := v_line || jsonb_build_object('months', v_months, 'unit', v_unit);
        if coalesce(v_list, 0) > v_unit then
          v_line := v_line || jsonb_build_object('list_unit', v_list);
        end if;
      end if;
      lines := jsonb_build_array(v_line);
      -- the lines always add up to the amount owed
      if inv.amount <> inv.gross_amount then
        lines := lines || jsonb_build_array(jsonb_build_object('label', 'Adjustment', 'amount', inv.amount - inv.gross_amount));
      end if;

      v_net := case when inv.due_on is null then 'Due on receipt'
                    else 'Net ' || greatest(inv.due_on - coalesce(inv.issued_on, inv.due_on), 0) end;
      v_word := case
        when inv.status = 'paid' then 'Paid'
        when inv.status = 'void' then 'Void'
        when inv.status = 'draft' then 'Draft'
        when inv.status = 'overdue' or (inv.due_on is not null and inv.due_on < current_date) then 'Overdue'
        else 'Unpaid' end;

      -- never hand a client an admin reminder such as '[WISE BANK DETAILS — add in Settings]'
      v_wise := btrim(coalesce(public.biz('wise_details'), ''));
      if v_wise = '' or left(v_wise, 1) = '[' then v_wise := null; end if;
      v_payo := nullif(btrim(coalesce(public.biz('payoneer_link'), '')), '');
      v_pay := jsonb_build_object('ready', (v_wise is not null or v_payo is not null),
                                  'wise_details', v_wise, 'payoneer_link', coalesce(v_payo, ''));

      -- a client never sees '[YOUR COMPANY LEGAL NAME]': until both are set it reads plain 'Aviance'
      if coalesce(public.biz('legal_name'), '[') like '[%' or coalesce(public.biz('address'), '[') like '[%' then
        v_from := jsonb_build_object('ready', false, 'legal_name', 'Aviance', 'email', public.biz('email'));
      else
        v_from := jsonb_build_object('ready', true, 'legal_name', public.biz('legal_name'), 'address', public.biz('address'), 'email', public.biz('email'));
      end if;
      v_phone := nullif(btrim(coalesce(public.biz('phone'), '')), '');
      if v_phone is not null then v_from := v_from || jsonb_build_object('phone', v_phone); end if;

      return jsonb_build_object('kind','invoice','number', inv.number, 'status', inv.status, 'status_word', v_word,
        'issued_on', inv.issued_on, 'due_on', inv.due_on, 'paid_at', inv.paid_at, 'currency', inv.currency,
        'service', v_service, 'period', v_period, 'terms', v_net,
        'lines', lines, 'gross', inv.gross_amount, 'amount', inv.amount,
        'bill_to', jsonb_build_object('company', c.company, 'contact_name', c.contact_name, 'contact_email', c.contact_email),
        'from', v_from,
        'pay', v_pay);
    end if;
  end if;
  raise exception 'This link is not valid.';
end $function$;

-- ------------------------------------------------------------------------------------
-- 6. documents_preview: the owner's Documents screen
--    Runs the real flow for a sample client on each plan and each term, inside a
--    sub-transaction that is rolled back, then puts the invoice-number sequence back
--    where it was. Six packs: Starter, Starter (3 months), Growth, Growth (3 months),
--    Scale, Scale (3 months). The chat messages are built once, on the Growth pack.
-- ------------------------------------------------------------------------------------
create or replace function public.documents_preview()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  out jsonb := '[]'::jsonb;
  v_seq bigint; v_called boolean;
  v_plan text; v_base text; v_term text; v_label text; v_i int := 0;
  b uuid; r jsonb; cid uuid; inv uuid; ag uuid; d uuid; ap uuid;
  v_at timestamptz := (date_trunc('day', now() at time zone 'America/Chicago') + interval '2 days 10 hours') at time zone 'America/Chicago';
  v_zone text := 'America/Chicago';
  k text;
begin
  if not public.is_admin() then raise exception 'Only the owner can see this.'; end if;
  select last_value, is_called into v_seq, v_called from public.invoice_no_seq;
  foreach k in array array['booking_confirmation','reminder_24h','reminder_1h','reminder_5min'] loop
    out := out || jsonb_build_object('group', 'Discovery call', 'key', k, 'type', 'email',
      'title', case k when 'booking_confirmation' then 'Booking confirmation'
                      when 'reminder_24h' then 'Reminder: the day before'
                      when 'reminder_1h' then 'Reminder: 1 hour before'
                      else 'Reminder: 5 minutes before' end,
      'subject', public.mail_subject(k, v_at, v_zone),
      'text', replace(public.mail_text(k, 'Sam Lee', v_at, v_zone), '{{MEET_LINK}}', 'https://meet.google.com/abc-defg-hij'));
  end loop;
  foreach v_plan in array array['starter','starter3','growth','growth3','scale','scale3'] loop
    v_i := v_i + 1;
    v_base := replace(v_plan, '3', '');
    v_term := case when v_plan like '%3' then '3month' else 'monthly' end;
    v_label := initcap(v_base) || case when v_term = '3month' then ' (3 months)' else '' end;
    begin
      insert into public.discovery_bookings(name, email, company, plan, call_at, minutes, timezone, source, status)
      values ('Sam Lee', 'preview@example.com', 'Sample Co', v_base,
              v_at + make_interval(days => 300 + v_i), 30, v_zone, 'documents preview', 'booked')
      returning id into b;
      r := public.close_won(b, v_base, v_term);
      cid := (r->>'client_id')::uuid; inv := (r->>'invoice_id')::uuid; ag := (r->>'agreement_id')::uuid;
      if ag is not null then
        out := out || jsonb_build_object('group', 'Agreements', 'key', 'agreement_' || v_plan, 'type', 'agreement',
          'title', 'Agreement — ' || v_label, 'doc', public.doc_get(public.doc_token('a', ag)));
      end if;
      out := out || jsonb_build_object('group', 'Invoices', 'key', 'invoice_' || v_plan, 'type', 'invoice',
        'title', 'Invoice — ' || v_label, 'doc', public.doc_get(public.doc_token('i', inv)));
      perform public.mark_paid(inv, 'preview');
      out := out || jsonb_build_object('group', 'Receipts', 'key', 'receipt_' || v_plan, 'type', 'invoice',
        'title', 'Receipt — ' || v_label, 'doc', public.doc_get(public.doc_token('i', inv)));
      if v_plan = 'growth' then
        begin
          set constraints all immediate;
          update public.client_people set user_id = auth.uid() where client_id = cid and user_id is null
            and id = (select id from public.client_people where client_id = cid order by created_at limit 1);
        exception when others then null; end;
        d := public.offer_times(cid, 'kickoff');
        perform public.precall_request(cid);
        perform public.journey_set(cid, 'kickoff', 'done', null);
        ap := public.approval_request(cid, 'icp', 'ICP + angles', 'Owners of 10–50 truck HVAC shops in TX. Angles: after-hours, speed, maintenance plans.');
        perform public.journey_set(cid, 'testing', 'doing', null);
        perform public.testing_day(cid, 240, 7, 'after-hours', null);
        perform public.journey_set(cid, 'testing', 'done', null);
        ap := public.approval_request(cid, 'copy', 'Campaign copy', 'Subject: after-hours calls — hey {first}, quick one…');
        perform public.journey_set(cid, 'build', 'done', null);
        d := public.offer_times(cid, 'onboarding');
        perform public.journey_set(cid, 'onboarding', 'done', null);
        perform public.journey_set(cid, 'launch', 'done', null);
        out := out || coalesce((select jsonb_agg(jsonb_build_object('group', 'Chat messages', 'key', 'chat_' || x.kind || '_' || x.n,
                 'type', 'chat', 'title', x.title, 'text', x.body, 'meta', x.meta) order by x.n)
          from (select bd.kind, bd.body, bd.meta, row_number() over (order by bd.created_at, bd.id) n,
                       case bd.kind when 'welcome' then 'Welcome (first login)'
                                    when 'offer' then case when bd.body ilike '%onboarding%' then 'Onboarding call: pick a time' else 'Kickoff: pick a time' end
                                    when 'form' then 'Pre-call form'
                                    when 'approval' then 'Approval request: ' || coalesce(bd.meta->>'title', '')
                                    when 'update' then 'Daily testing update'
                                    when 'step' then 'Step: ' || coalesce(bd.meta->>'step', '') || ' ' || coalesce(bd.meta->>'status', '')
                                    else initcap(bd.kind) end title
                  from public.bot_drafts bd where bd.client_id = cid) x), '[]'::jsonb);
      end if;
      out := out || coalesce((select jsonb_agg(jsonb_build_object('group', 'Emails — ' || v_label, 'key', 'mail_' || v_plan || '_' || mo.kind || '_' || mo.id,
               'type', 'email', 'title', initcap(replace(mo.kind, '_', ' ')), 'subject', mo.subject,
               'text', mo.body_text, 'html', mo.body_html) order by mo.created_at)
        from public.mail_outbox mo where mo.client_id = cid or mo.booking_id = b), '[]'::jsonb);
      raise exception using errcode = 'P0V01', message = 'preview rollback';
    exception
      when sqlstate 'P0V01' then null;
      when others then
        out := out || jsonb_build_object('group', 'Problems', 'key', 'err_' || v_plan, 'type', 'error',
          'title', 'Could not build the ' || v_label || ' preview', 'text', sqlerrm);
    end;
  end loop;
  select greatest(v_seq, coalesce(max(nullif(regexp_replace(number, '^.*-', ''), '')::bigint), 0)) into v_seq
    from public.invoices where number ~ '-[0-9]+$';
  perform setval('public.invoice_no_seq', v_seq, true);
  return out;
end $function$;

-- ------------------------------------------------------------------------------------
-- 7. Self-check: no function in schema public may still mention the retired plan.
--    The ONE allowance, kept narrow on purpose: a line that refuses the old plan code.
--    That is either
--      (a) a comment line (starts with --) that contains the word "refused", or
--      (b) a line that contains `raise exception` (the refusal message itself).
--    Such lines are taken out before the search. Anything left that still says the word,
--    in any letter case, fails the migration and names the functions.
-- ------------------------------------------------------------------------------------
do $check$
declare
  v_bad text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname)
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and regexp_replace(p.prosrc, '^[^\n]*(--[^\n]*refused|raise exception)[^\n]*$', '', 'gin') ~* 'pilot';
  if v_bad is not null then
    raise exception 'The retired plan is still mentioned in: %. Remove it there, then run this file again.', v_bad;
  end if;
end
$check$;
