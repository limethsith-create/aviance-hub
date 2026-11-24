-- =====================================================================================
-- 20261124_documents_v2.sql
--
-- The client-facing documents, after the dress rehearsal where a "customer" read them.
-- Every promise here matches aviance.online word for word in meaning:
--   - 5 / 10 / 15 qualified calls a month (Starter / Growth / Scale); Pilot: $300 once,
--     2 booked calls on your calendar within 30 days of going live.
--   - A qualified call = a prospect matching the ICP agreed at kickoff, who has accepted a
--     meeting at a confirmed time on your calendar. It counts once it actually happens.
--   - Guarantee: miss in month one -> refund 2x that month; miss later -> refund that month.
--     Money back, not a credit. 3-month terms: every month, on that month's share.
--   - Conditions: ICP signed off + copy approved at kickoff, time kept free for the calls.
--
-- Replaces (create or replace, same signatures, same return shapes):
--   agreement_terms(p_client)   -> {title, intro, parties, sections, placeholders, signatures}
--   mail_pack(...)              -> subject 'Agreement + invoice AV-2026-1004 · $3,000 due Dec 1'
--   mail_welcome(...)           -> same email, plus what happens in days 1-4
--   pretty_when(at, zone)       -> 'Fri, Nov 27 · 10:00 AM ET'   (only mail_subject / mail_text use it)
--   mail_subject(kind, at, zone)-> "You're booked in: Fri, Nov 27 · 10:00 AM ET"
--   mail_text(kind, name, at, zone) -> same bodies, the zone is now inside pretty_when
--   doc_get(p_token)            -> invoice: service, terms, status_word, pay.ready, from.phone;
--                                  agreement: terms.signatures (added to older snapshots too)
--
-- Anything the owner has NOT decided is still in [SQUARE BRACKETS] and listed again in
-- `placeholders` as one plain question per bracket. doc.html highlights brackets so an
-- owner previewing a document notices them.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- 1. The agreement
-- -------------------------------------------------------------------------------------
create or replace function public.agreement_terms(p_client uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $fn$
declare
  c        record;
  v_plan   text;
  v_calls  text;
  v_fee    text;
  v_qtr    text;
  v_legal  text := coalesce(nullif(public.biz('legal_name'),''),'[YOUR COMPANY LEGAL NAME]');
  v_addr   text := coalesce(nullif(public.biz('address'),''),'[YOUR COMPANY ADDRESS]');
  v_signer text := coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), '[YOUR NAME]');
  v_pilot  boolean;
  v_3mo    boolean;
  s1 jsonb; s2 jsonb; s3 jsonb; s4 jsonb; s5 jsonb; s6 jsonb; s7 jsonb; s8 jsonb;
  ph text[] := '{}';
begin
  select * into c from public.clients where id = p_client;
  if not found then
    raise exception 'That client does not exist.';
  end if;

  v_pilot := (c.plan = 'pilot');
  v_3mo   := (c.term = '3month' and not v_pilot);
  v_plan  := initcap(c.plan);
  v_calls := c.calls_promised::text;
  v_fee   := '$' || to_char(c.monthly_fee, 'FM999,999,990');
  v_qtr   := '$' || to_char(c.monthly_fee * 3, 'FM999,999,990');

  -- 1. What we deliver
  if v_pilot then
    s1 := jsonb_build_array(
      'You are buying the Pilot. We find the people who fit your ideal customer profile, email them, and book qualified sales calls on your calendar.',
      'We guarantee ' || v_calls || ' booked calls on your calendar within 30 days of your campaign going live.');
  else
    s1 := jsonb_build_array(
      'You are on the ' || v_plan || ' plan. We find the people who fit your ideal customer profile, email them, and book qualified sales calls on your calendar.',
      'We guarantee ' || v_calls || ' qualified calls every month. [Your first month starts on the day your first emails go out, not the day you sign.]');
  end if;
  s1 := s1 || jsonb_build_array(
    'Days 1–4: kickoff, your market sized, a first draft of your ideal customer profile, domains bought and inboxes warming. Weeks 1–2: we build the lists and emails and you approve them. Then we go live.',
    'Domains, inboxes, warmup, contact data and software are all included in the fee.');

  -- 2. What counts as a qualified call
  s2 := jsonb_build_array(
    'A qualified call is a prospect matching the ideal customer profile we agreed at kickoff, who has accepted a meeting at a confirmed time on your calendar.',
    'A call only counts once it actually happens. A no-show doesn''t count toward your number.',
    'If you think a call did not qualify, tell us within [5 business days] of the call. We will check it together, and if you are right it does not count.');

  -- 3. Fees and payment
  if v_pilot then
    s3 := jsonb_build_array('The Pilot costs ' || v_fee || ', paid once.');
  elsif v_3mo then
    s3 := jsonb_build_array(
      'The fee is ' || v_fee || ' a month for ' || v_calls || ' qualified calls a month, on a 3-month term. We invoice all 3 months (' || v_qtr || ') up front.');
  else
    s3 := jsonb_build_array(
      'The fee is ' || v_fee || ' a month for ' || v_calls || ' qualified calls a month. We invoice once a month.');
  end if;
  s3 := s3 || jsonb_build_array(
    case when v_pilot then 'It is payable' else 'Each invoice is payable' end
    || ' [in full, in advance, within 7 days of the invoice]. All fees are in US dollars. We start work when your '
    || case when v_pilot then 'invoice' else 'first invoice' end || ' is paid.');
  if not v_pilot and coalesce(c.pilot_credit, 0) > 0 then
    s3 := s3 || jsonb_build_array(
      'The $' || to_char(c.pilot_credit, 'FM999,999,990') || ' you paid for your Pilot is taken off your first invoice.');
  end if;

  -- 4. What we need from you (these are the guarantee's conditions)
  s4 := jsonb_build_array(
    'The guarantee depends on the things we need to do the work: you sign off your ideal customer profile and approve the copy at kickoff, and you keep time free on your calendar for the calls we book.',
    'We agree your ideal customer profile in writing before anything sends.',
    'After kickoff, approve or correct the lists and emails we send you within [2 business days].');

  -- 5. Our guarantee
  if v_pilot then
    s5 := jsonb_build_array(
      'If we book fewer than ' || v_calls || ' qualified calls within 30 days of your campaign going live, we [refund the ' || v_fee || ' in full].',
      'A refund is money back in your account, not a credit. We pay it within [10 business days] of the 30 days ending.');
  else
    s5 := jsonb_build_array(
      'If we book fewer than ' || v_calls || ' qualified calls in month one, we refund twice what you paid for that month. If we miss in any month after that, we refund that month in full.',
      'A refund is money back in your account, not a credit. We pay it within [10 business days] of the month ending.');
    if v_3mo then
      s5 := s5 || jsonb_build_array(
        'On your 3-month term the guarantee covers every month. Each month''s refund is worked out on that month''s share of what you paid.');
    end if;
  end if;
  s5 := s5 || jsonb_build_array('We guarantee qualified calls, not sales. What happens on the call is up to you.');

  -- 6. Ending the agreement
  if v_pilot then
    s6 := jsonb_build_array(
      'The Pilot is a one-off. It ends 30 days after your campaign goes live. It does not renew and you owe nothing more.',
      'If you move to a monthly plan within [30 days] of the Pilot ending, we take the ' || v_fee || ' off your first invoice.');
  elsif v_3mo then
    s6 := jsonb_build_array(
      'This agreement runs for 3 months from the day your first emails go out. After that it carries on month to month [at the same monthly price] until one of us ends it with [14 days''] notice by email.',
      'A month you have already paid for is not refunded, except under the guarantee.');
  else
    s6 := jsonb_build_array(
      'This agreement runs month to month. Either of us can end it with [14 days''] notice by email.',
      'A month you have already paid for is not refunded, except under the guarantee.');
  end if;

  -- 7. How we send
  s7 := jsonb_build_array(
    'We send from domains and inboxes we buy and run for you, never from your own domain.',
    'We follow US anti-spam law (CAN-SPAM): every email carries real sender details and a working opt-out.',
    'You tell us anyone who must never be contacted, and we keep them off every list.');

  -- 8. The small print
  s8 := jsonb_build_array(
    'We each keep the other''s private business information confidential. Your data and your lists stay yours; we use them only for this work.',
    '[Our total liability is limited to the fees you paid in the last 3 months.]',
    'This is the whole agreement. Changes must be agreed in writing; an email counts. Typing your name and pressing Sign is your signature.',
    'This agreement is governed by [the laws of Sri Lanka].');

  -- one plain question per bracket left in the text, each saying what the draft says
  if v_legal like '[%' then
    ph := ph || 'What is your company''s legal name? Draft just says "Aviance" until you add it in Settings.'::text;
  end if;
  if v_addr like '[%' then
    ph := ph || 'What is your company''s address? Draft leaves it out until you add it in Settings.'::text;
  end if;
  if v_signer like '[%' then
    ph := ph || 'Who signs for Aviance? The signature line says [YOUR NAME], Founder until a signer name is saved in the business settings.'::text;
  end if;
  if not v_pilot then
    ph := ph || 'When does a client''s month start? Draft says the day their first emails go out, not the day they sign.'::text;
  end if;
  ph := ph || array[
    'How long does a client have to dispute a call? Draft says 5 business days.',
    'What are your payment terms? Draft says in full, in advance, within 7 days of the invoice.',
    'How fast must the client approve lists and emails? Draft says 2 business days.',
    'How fast do you pay a refund? Draft says within 10 business days of the month ending.'
  ]::text[];
  if v_pilot then
    ph := ph || array[
      'What do you refund if the Pilot falls short? Draft says the ' || v_fee || ' in full.',
      'How long after the Pilot can a client still get the ' || v_fee || ' taken off their first invoice? Draft says 30 days.'
    ]::text[];
  else
    ph := ph || 'How much notice to end the agreement? Draft says 14 days, by email.'::text;
    if v_3mo then
      ph := ph || 'What price applies after the 3 months, when it goes month to month? Draft says the same monthly price.'::text;
    end if;
  end if;
  ph := ph || array[
    'How much can you be held liable for? Draft says the fees the client paid in the last 3 months.',
    'Which country''s law governs the agreement? Draft says Sri Lanka.'
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
      jsonb_build_object('h', '1. What we deliver',                 'body', s1),
      jsonb_build_object('h', '2. What counts as a qualified call', 'body', s2),
      jsonb_build_object('h', '3. Fees and payment',                'body', s3),
      jsonb_build_object('h', '4. What we need from you',           'body', s4),
      jsonb_build_object('h', '5. Our guarantee',                   'body', s5),
      jsonb_build_object('h', '6. Ending the agreement',            'body', s6),
      jsonb_build_object('h', '7. How we send',                     'body', s7),
      jsonb_build_object('h', '8. The small print',                 'body', s8)),
    'signatures', jsonb_build_array(
      jsonb_build_object('label', 'For Aviance', 'name', v_signer, 'role', 'Founder', 'org', 'Aviance')),
    'placeholders', to_jsonb(ph));
end
$fn$;


-- -------------------------------------------------------------------------------------
-- 2. The "pack" email: sign the agreement, pay the invoice (sent when a call is won)
-- -------------------------------------------------------------------------------------
create or replace function public.mail_pack(p_client uuid, p_agreement_url text, p_invoice_url text)
returns jsonb
language plpgsql
stable
set search_path = public
as $fn$
declare
  c       record;
  inv     record;
  v_first text;
  v_plan  text;
  v_what  text;      -- '5 qualified calls a month' / '2 qualified calls within 30 days of going live'
  v_num   text; v_amt text; v_due text; v_short text; v_credit text := '';
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
  v_what  := c.calls_promised || ' qualified calls'
             || case when c.plan = 'pilot' then ' within 30 days of going live' else ' a month' end;
  v_num   := coalesce(inv.number, '');
  v_amt   := '$' || to_char(coalesce(inv.amount,
               c.monthly_fee * case when c.term = '3month' and c.plan <> 'pilot' then 3 else 1 end), 'FM999,999,990');
  v_due   := case when inv.due_on is null then 'Due on receipt' else 'Due ' || to_char(inv.due_on, 'FMMonth FMDD, YYYY') end;
  v_short := case when inv.due_on is null then 'due on receipt' else 'due ' || to_char(inv.due_on, 'Mon FMDD') end;
  if coalesce(inv.pilot_credit, 0) > 0 then
    v_credit := 'Your $' || to_char(inv.pilot_credit, 'FM999,999,990') || ' Pilot credit is already taken off.';
  end if;
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
<div style="font-size:20px;color:#BDBDBD;padding-bottom:28px">[[DUE]][[CREDIT]]</div>
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
  html := replace(html, '[[CREDIT]]', case when v_credit = '' then '' else '<br>' || v_credit end);
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
      || 'Invoice ' || v_num || ': ' || v_amt || '. ' || v_due || '.'
      || case when v_credit = '' then '' else ' ' || v_credit end || E'\n' || v_pay || E'\n\n'
      || E'Once both are done, we open your private channel and book your kickoff.\n\n'
      || E'Questions? Just reply.\n\nAviance';

  return jsonb_build_object('subject', v_subj, 'text', txt, 'html', html);
end
$fn$;


-- -------------------------------------------------------------------------------------
-- 3. The "welcome" email: open your channel (sent when the invoice is marked paid)
--    The kickoff is booked INSIDE the portal (portal_book_kickoff), never on the public
--    sales booking page, so p_kickoff_url is accepted and ignored.
-- -------------------------------------------------------------------------------------
create or replace function public.mail_welcome(p_client uuid, p_join_url text, p_agreement_url text, p_receipt_url text, p_kickoff_url text)
returns jsonb
language plpgsql
stable
set search_path = public
as $fn$
declare
  c         record;
  inv       record;
  ag        record;
  v_first   text;
  v_join    text := coalesce(p_join_url, '');
  v_agree   text := coalesce(p_agreement_url, '');
  v_receipt text := coalesce(p_receipt_url, '');
  v_signer  text := coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), '[YOUR NAME]');
  v_paid    text := '';     -- 'Invoice AV-2026-1004, $3,000, paid.'
  v_agtxt   text;           -- 'Signed on November 25, 2026 — keep a copy.' / 'Sign it if you have not yet, and keep a copy.'
  mono text := $s$font-family:'JetBrains Mono','Courier New',Courier,monospace;$s$;
  lnk  text := 'color:#E0290F;font-weight:700;text-decoration:underline';
  body text; html text; txt text;
begin
  select * into c from public.clients where id = p_client;
  if not found then
    raise exception 'That client does not exist.';
  end if;
  select * into inv from public.invoices where client_id = p_client order by created_at desc limit 1;
  select * into ag from public.client_agreements where client_id = p_client and status <> 'void' order by created_at desc limit 1;

  v_first := coalesce(nullif(split_part(btrim(coalesce(c.contact_name, '')), ' ', 1), ''), 'there');
  if inv.number is not null then
    v_paid := 'Invoice ' || inv.number || ', $' || to_char(inv.amount, 'FM999,999,990')
           || case when inv.status = 'paid' then ', paid.' else '.' end;
  end if;
  if ag.status = 'signed' and ag.signed_at is not null then
    v_agtxt := 'Signed on ' || to_char(ag.signed_at at time zone 'America/New_York', 'FMMonth FMDD, YYYY') || ' — keep a copy.';
  else
    v_agtxt := 'Sign it if you have not yet, and keep a copy.';
  end if;

  body := $s$<tr><td class="pad" bgcolor="#000000" style="background:#000000;padding:52px 40px 48px">
<div style="font-size:20px;color:#BDBDBD;padding-bottom:18px">Hi [[NAME]],</div>
<div class="h1" style="font-size:84px;line-height:0.96;font-weight:800;letter-spacing:-0.04em;color:#FFFFFF">Payment<br>received.<br>You&rsquo;re in<span style="color:#E0290F">.</span></div></td></tr>
<tr><td class="pad" style="padding:32px 40px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#E0290F" style="background:#E0290F"><a class="btn" href="[[JOIN_URL]]" style="display:block;padding:26px 20px;font-size:26px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Open your channel &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:10px 40px 28px;font-size:16px;line-height:1.5;color:#5C5C5C">Set a password and you are in. This link is yours alone and works once.</td></tr>
<tr><td class="pad" style="padding:28px 40px 36px;border-top:2px solid #000000">
<div style="font-size:18px;line-height:1.5;padding-bottom:24px">Your private channel is where [[COMPANY]] and our team talk. Updates, approvals and questions go there.</div>
<div style="[[MONO]]font-size:12px;font-weight:700;letter-spacing:0.16em;color:#5C5C5C;padding-bottom:16px">ONCE YOU ARE IN</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:18px;line-height:1.45">
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 14px 0">01</td><td style="padding-bottom:14px"><b>Book your kickoff</b> &mdash; right after you open your channel. Pick a time on the first screen you see.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 14px 0">02</td><td style="padding-bottom:14px"><b>Your agreement.</b> [[AGTXT]] <br><a href="[[AGREE_URL]]" style="[[LNK]]">Open the agreement&nbsp;&rarr;</a></td></tr>
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 0 0">03</td><td><b>Your receipt.</b> [[PAID]] <br><a href="[[RECEIPT_URL]]" style="[[LNK]]">View your receipt&nbsp;&rarr;</a></td></tr>
</table></td></tr>
<tr><td class="pad" style="padding:28px 40px 36px;border-top:2px solid #000000">
<div style="[[MONO]]font-size:12px;font-weight:700;letter-spacing:0.16em;color:#5C5C5C;padding-bottom:16px">YOUR NEXT 14 DAYS</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:17px;line-height:1.45">
<tr><td valign="top" style="[[MONO]]font-size:13px;font-weight:700;letter-spacing:0.08em;color:#E0290F;padding:2px 16px 14px 0;white-space:nowrap">DAYS 1&ndash;4</td><td style="padding-bottom:14px">Kickoff, your market mapped, your ideal customer profile drafted, domains bought, inboxes warming.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:13px;font-weight:700;letter-spacing:0.08em;color:#E0290F;padding:2px 16px 14px 0;white-space:nowrap">WEEKS 1&ndash;2</td><td style="padding-bottom:14px">We build your list and copy. You approve them.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:13px;font-weight:700;letter-spacing:0.08em;color:#E0290F;padding:2px 16px 0 0;white-space:nowrap">THEN</td><td>We go live, and your month starts.</td></tr>
</table>
<div style="font-size:18px;line-height:1.5;padding-top:32px">Glad to have you.<br><b>[[SIGNER]], Founder</b><br><span style="color:#5C5C5C">Aviance</span></div></td></tr>$s$;

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
  html := replace(html, '[[LNK]]', lnk);
  html := replace(html, '[[TAG]]', 'YOU&rsquo;RE IN');
  html := replace(html, '[[TAGBG]]', '#E0290F');
  html := replace(html, '[[FOOT]]', 'Questions? Just reply.');
  html := replace(html, '[[AGTXT]]', v_agtxt);
  -- everything below came from the client row, the invoice, the settings or the caller, so it is escaped
  html := replace(html, '[[SIGNER]]', replace(replace(replace(v_signer, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[PAID]]', replace(replace(replace(v_paid, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[JOIN_URL]]', replace(replace(replace(replace(v_join, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[AGREE_URL]]', replace(replace(replace(replace(v_agree, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[RECEIPT_URL]]', replace(replace(replace(replace(v_receipt, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[NAME]]', replace(replace(replace(v_first, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[COMPANY]]', replace(replace(replace(c.company, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));

  txt := 'Hi ' || v_first || E',\n\n'
      || E'Payment received. You''re in.\n\n'
      || E'Open your channel:\n' || v_join || E'\n'
      || E'Set a password and you are in. This link is yours alone and works once.\n\n'
      || 'Your private channel is where ' || c.company || E' and our team talk. Updates, approvals and questions go there.\n\n'
      || E'Once you are in:\n\n'
      || E'1. Book your kickoff — right after you open your channel. Pick a time on the first screen you see.\n\n'
      || '2. Your agreement. ' || v_agtxt || E'\n' || v_agree || E'\n\n'
      || '3. Your receipt.' || case when v_paid = '' then '' else ' ' || v_paid end || E'\n' || v_receipt || E'\n\n'
      || E'Your next 14 days:\n'
      || E'Days 1–4: kickoff, your market mapped, your ideal customer profile drafted, domains bought, inboxes warming.\n'
      || E'Weeks 1–2: we build your list and copy. You approve them.\n'
      || E'Then: we go live, and your month starts.\n\n'
      || E'Glad to have you.\n\n' || v_signer || E', Founder\nAviance';

  return jsonb_build_object('subject', 'You''re in: open your Aviance channel', 'text', txt, 'html', html);
end
$fn$;


-- -------------------------------------------------------------------------------------
-- 4. Call emails: US-style date and time with the zone, 'Fri, Nov 27 · 10:00 AM ET'.
--    pretty_when is used only by mail_subject and mail_text (the client's call emails).
-- -------------------------------------------------------------------------------------
create or replace function public.pretty_when(p_at timestamp with time zone, p_zone text)
returns text
language sql
stable
as $fn$
  with z as (select coalesce(nullif(btrim(p_zone), ''), 'UTC') as zone)
  select to_char(p_at at time zone z.zone, 'Dy, Mon FMDD · FMHH12:MI AM') || ' ' ||
    case
      when z.zone in ('America/New_York','America/Detroit','America/Indiana/Indianapolis','America/Kentucky/Louisville',
                      'America/Indianapolis','America/Louisville','US/Eastern','US/Michigan','EST','EST5EDT')
        or z.zone like 'America/Indiana/%' and z.zone not in ('America/Indiana/Knox','America/Indiana/Tell_City')
        or z.zone like 'America/Kentucky/%'                                         then 'ET'
      when z.zone in ('America/Chicago','America/Indiana/Knox','America/Indiana/Tell_City','America/Menominee',
                      'America/North_Dakota/Center','America/North_Dakota/New_Salem','America/North_Dakota/Beulah',
                      'US/Central','CST6CDT')                                       then 'CT'
      when z.zone in ('America/Denver','America/Boise','America/Phoenix','US/Mountain','US/Arizona','MST','MST7MDT') then 'MT'
      when z.zone in ('America/Los_Angeles','US/Pacific','PST8PDT')                then 'PT'
      when z.zone in ('America/Anchorage','America/Juneau','America/Sitka','America/Nome','America/Yakutat',
                      'America/Metlakatla','US/Alaska')                             then 'AKT'
      when z.zone in ('Pacific/Honolulu','US/Hawaii','HST')                        then 'HT'
      when z.zone in ('UTC','Etc/UTC','GMT','Etc/GMT','Z')                          then 'UTC'
      else replace(regexp_replace(z.zone, '^.*/', ''), '_', ' ') || ' time'
    end
  from z;
$fn$;

create or replace function public.mail_subject(p_kind text, p_at timestamp with time zone, p_zone text)
returns text
language sql
stable
as $fn$
  select case p_kind
    when 'booking_confirmation' then 'You''re booked in: ' || public.pretty_when(p_at,p_zone)
    when 'reminder_24h' then 'Tomorrow: your Aviance call'
    when 'reminder_1h'  then 'In about an hour: your Aviance call'
    else 'We''re on in five' end;
$fn$;

-- Same bodies as before; the zone now rides inside pretty_when, so the '(America/New_York)'
-- after the time is gone.
create or replace function public.mail_text(p_kind text, p_name text, p_at timestamp with time zone, p_zone text)
returns text
language sql
stable
as $fn$
  select case p_kind
    when 'booking_confirmation' then
      'Hi ' || coalesce(nullif(split_part(coalesce(p_name,''),' ',1),''),'there') || E',\n\nYou''re booked in.\n\n'
      || public.pretty_when(p_at,p_zone) || E', 30 minutes.\n\nJoin the call: {{MEET_LINK}}\n\n'
      || E'Before we speak:\n1. Press Yes on the calendar invite. It saves the link for you.\n2. Think about who your best customers are.\n3. Know what one new customer is worth to you.\n\nNeed to move it? Just reply.\n\nAviance'
    when 'reminder_24h' then
      'Hi ' || coalesce(nullif(split_part(coalesce(p_name,''),' ',1),''),'there') || E',\n\nWe speak tomorrow.\n\n'
      || public.pretty_when(p_at,p_zone) || E'.\n\nJoin the call: {{MEET_LINK}}\n\nTime no longer works? Reply to this and we''ll move it.\n\nAviance'
    when 'reminder_1h' then
      E'In about an hour.\n\n' || public.pretty_when(p_at,p_zone) || E'.\n\nJoin the call: {{MEET_LINK}}\n\nRunning late? Reply and we''ll sort it.\n\nAviance'
    else E'We''re on in five.\n\nJoin now: {{MEET_LINK}}\n\nAviance'
  end;
$fn$;


-- -------------------------------------------------------------------------------------
-- 5. doc_get: what a client's link opens
-- -------------------------------------------------------------------------------------
create or replace function public.doc_get(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v uuid; ag public.client_agreements; inv public.invoices; c public.clients; m public.client_months;
  lines jsonb; v_terms jsonb; v_signer text; v_from jsonb; v_pay jsonb;
  v_wise text; v_payo text; v_phone text; v_label text; v_service text; v_net text; v_word text;
begin
  v := public.doc_id(p_token, 'a');
  if v is not null then
    select * into ag from public.client_agreements where id = v;
    if found then
      select * into c from public.clients where id = ag.client_id;
      v_terms := coalesce(ag.terms, '{}'::jsonb);
      -- the Aviance signer: older snapshots have none, and a [YOUR NAME] fills in once it is set
      v_signer := nullif(btrim(coalesce(public.biz('signer_name'), '')), '');
      if not (v_terms ? 'signatures') then
        v_terms := v_terms || jsonb_build_object('signatures', jsonb_build_array(
          jsonb_build_object('label', 'For Aviance', 'name', coalesce(v_signer, '[YOUR NAME]'), 'role', 'Founder', 'org', 'Aviance')));
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
      lines := jsonb_build_array(jsonb_build_object('label', coalesce(nullif(inv.notes,''), 'Aviance services'), 'amount', inv.gross_amount));
      if inv.pilot_credit > 0 then
        lines := lines || jsonb_build_array(jsonb_build_object('label', 'Pilot credit', 'amount', -inv.pilot_credit));
      end if;

      -- what this invoice pays for, and when that period starts
      select label into v_label from public.plan_prices where plan = c.plan;
      v_label := coalesce(v_label, initcap(c.plan));
      if inv.month_id is not null then
        select * into m from public.client_months where id = inv.month_id;
      end if;
      if c.plan = 'pilot' then
        v_service := v_label || ' · ' || c.calls_promised || ' qualified calls within 30 days of going live';
      elsif m.id is not null then
        v_service := v_label || ' · ' || c.calls_promised || ' qualified calls · month ' || m.month_no
          || case when m.starts_on is not null and m.ends_on is not null
                  then ' (' || to_char(m.starts_on, 'Mon FMDD') || ' – ' || to_char(m.ends_on, 'Mon FMDD, YYYY') || ')' else '' end;
      elsif coalesce(inv.is_first, false) then
        v_service := v_label || ' · ' || c.calls_promised || ' qualified calls'
          || case when c.term = '3month' then ' a month · months 1–3' else ' · month 1' end
          || ' — starts the day your first emails go out';
      else
        v_service := coalesce(nullif(inv.notes,''), v_label);
      end if;

      v_net := case when inv.due_on is null then 'Due on receipt'
                    else 'Net ' || greatest(inv.due_on - coalesce(inv.issued_on, inv.due_on), 0)
                         || ' — due ' || to_char(inv.due_on, 'Mon FMDD, YYYY') end;
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
        'service', v_service, 'terms', v_net,
        'lines', lines, 'gross', inv.gross_amount, 'pilot_credit', inv.pilot_credit, 'amount', inv.amount,
        'bill_to', jsonb_build_object('company', c.company, 'contact_name', c.contact_name, 'contact_email', c.contact_email),
        'from', v_from,
        'pay', v_pay);
    end if;
  end if;
  raise exception 'This link is not valid.';
end $fn$;

revoke execute on function public.doc_get(text) from public;
grant  execute on function public.doc_get(text) to anon, authenticated;


-- -------------------------------------------------------------------------------------
-- 6. Kickoff, booked inside the client's portal (never on the public sales page)
--
--   portal_kickoff_slots(p_days) -> {booked: {id, starts_at, minutes, meet_link, status} | null,
--                                    zone: 'America/New_York', minutes: 45,
--                                    slots: [{starts_at, minutes}]}
--   portal_book_kickoff(p_start) -> {starts_at, meet_link, minutes}
--
-- Both are for a signed-in client person only (the same test as portal_home: a
-- client_people row whose user_id is the caller). The slots are the website's own free
-- 30-minute slots (free_slots); a 45-minute kickoff needs the slot after it free too.
-- -------------------------------------------------------------------------------------
create or replace function public.portal_kickoff_slots(p_days integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare per public.client_people; m public.meetings; v_zone text; v_slots jsonb;
begin
  select * into per from public.client_people where user_id = auth.uid() and auth.uid() is not null limit 1;
  if not found or public.portal_home() is null then
    raise exception 'Only a signed-in client can book a kickoff.';
  end if;
  select coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York') into v_zone;

  select * into m from public.meetings
   where client_id = per.client_id and kind = 'onboarding' and status <> 'cancelled'
   order by starts_at desc limit 1;
  if m.id is not null then
    return jsonb_build_object('zone', v_zone, 'minutes', 45, 'slots', '[]'::jsonb,
      'booked', jsonb_build_object('id', m.id, 'starts_at', m.starts_at, 'minutes', m.minutes, 'meet_link', m.meet_link, 'status', m.status));
  end if;

  with f as (select fs.starts_at, fs.minutes from public.free_slots(least(greatest(coalesce(p_days, 10), 1), 21)) fs)
  select coalesce(jsonb_agg(jsonb_build_object('starts_at', a.starts_at, 'minutes', 45) order by a.starts_at), '[]'::jsonb)
    into v_slots
    from f a
   where exists (select 1 from f b where b.starts_at = a.starts_at + make_interval(mins => a.minutes));

  return jsonb_build_object('zone', v_zone, 'minutes', 45, 'booked', null, 'slots', v_slots);
end $fn$;

create or replace function public.portal_book_kickoff(p_start timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare per public.client_people; c public.clients; m public.meetings; v_zone text;
begin
  select * into per from public.client_people where user_id = auth.uid() and auth.uid() is not null limit 1;
  if not found or public.portal_home() is null then
    raise exception 'Only a signed-in client can book a kickoff.';
  end if;
  select * into c from public.clients where id = per.client_id;
  select coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York') into v_zone;

  -- one booking at a time, so two clicks (or two clients) cannot take the same time
  perform pg_advisory_xact_lock(hashtext('aviance-calendar'));

  if exists (select 1 from public.meetings where client_id = c.id and kind = 'onboarding' and status <> 'cancelled') then
    raise exception 'Your kickoff is already booked.';
  end if;
  if p_start is null then raise exception 'Pick a time first.'; end if;
  -- the slot and the half hour after it must both still be free (a kickoff is 45 minutes)
  if not exists (select 1 from public.free_slots(21) f where f.starts_at = p_start)
     or not exists (select 1 from public.free_slots(21) f where f.starts_at = p_start + interval '30 minutes') then
    raise exception 'That time has just gone. Please pick another.';
  end if;

  insert into public.meetings(client_id, kind, starts_at, minutes, time_zone, status, title, guest_name, guest_email, plan)
  values (c.id, 'onboarding', p_start, 45, coalesce(nullif(per.timezone, ''), v_zone), 'booked',
          left('Kickoff — ' || c.company, 160), left(per.full_name, 120),
          case when coalesce(per.email, '') ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then left(per.email, 200) end, c.plan)
  returning * into m;

  insert into public.client_events(client_id, area, event, detail)
  values (c.id, 'client', 'kickoff_booked', jsonb_build_object(
    'words', 'Kickoff booked by ' || coalesce(per.full_name, 'the client') || ' for ' || public.pretty_when(m.starts_at, v_zone) || '.',
    'meeting_id', m.id));

  return jsonb_build_object('starts_at', m.starts_at, 'minutes', m.minutes, 'meet_link', m.meet_link);
end $fn$;

revoke all on function public.portal_kickoff_slots(integer) from public, anon;
revoke all on function public.portal_book_kickoff(timestamptz) from public, anon;
grant execute on function public.portal_kickoff_slots(integer) to authenticated;
grant execute on function public.portal_book_kickoff(timestamptz) to authenticated;
