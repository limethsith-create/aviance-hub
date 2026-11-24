-- =====================================================================================
-- 20261124_close_pack_templates.sql
--
-- The WORDS of the close-to-onboarded flow: the one-page service agreement and the two
-- emails a new client receives. Three functions, each reads the client row itself:
--
--   agreement_terms(p_client)                         -> jsonb {title, intro, parties, sections, placeholders}
--       The plain-English agreement, filled from the client's plan / term / fee / calls.
--       close_won snapshots it into the agreement at close time; doc.html prints it.
--       Anything the owner has NOT decided yet is written in [SQUARE BRACKETS] in the text
--       and listed again in `placeholders` as a plain question. Edit the bracketed text
--       here once decided, and drop the matching question.
--
--   mail_pack(p_client, p_agreement_url, p_invoice_url)                      -> jsonb {subject, text, html}
--       Sent the moment a call is marked won: 01 sign the agreement, 02 pay the invoice.
--
--   mail_welcome(p_client, p_join_url, p_agreement_url, p_receipt_url, p_kickoff_url) -> jsonb {subject, text, html}
--       Sent the moment the invoice is marked paid: open your channel, book kickoff.
--
-- Both emails are built exactly like mail_html (the four call emails): the same 600px
-- shell, logo header with the mono tag, black footer, table layout, inline styles, the
-- same @media block and class names. Every value that comes from the client row or from
-- a caller is HTML-escaped. Neither email contains the meeting-link token that the
-- outbox trigger refuses to send.
--
-- Money rules used here:
--   clients.monthly_fee is the PER-MONTH price that applies to this client (for a 3-month
--   term it is already the discounted three_month_fee; the quarter is billed up front).
--   Per-call rate = monthly_fee / calls_promised.
--
-- Needs: public.biz(text) (business settings), clients, invoices. Replaces the lead's stubs.
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
  v_plan   text;      -- 'Starter'
  v_calls  text;      -- '5'
  v_fee    text;      -- '$1,500'
  v_qtr    text;      -- '$3,600' (3 x the monthly price)
  v_rate   text;      -- '$300' per call
  v_legal  text := coalesce(nullif(public.biz('legal_name'),''),'[YOUR COMPANY LEGAL NAME]');
  v_addr   text := coalesce(nullif(public.biz('address'),''),'[YOUR COMPANY ADDRESS]');
  v_pilot  boolean;
  v_3mo    boolean;
  s1 jsonb; s2 jsonb; s3 jsonb; s4 jsonb; s5 jsonb; s6 jsonb; s7 jsonb;
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
  v_rate  := '$' || case
               when c.calls_promised > 0 and c.monthly_fee % c.calls_promised = 0
                 then to_char(c.monthly_fee / c.calls_promised, 'FM999,999,990')
               else to_char(c.monthly_fee::numeric / greatest(c.calls_promised, 1), 'FM999,999,990.00')
             end;

  -- 1 What we deliver ---------------------------------------------------------------
  if v_pilot then
    s1 := jsonb_build_array(
      'You are buying the Pilot. We run cold email outreach for you and book qualified sales calls into your calendar.',
      'We promise ' || v_calls || ' qualified calls [within 30 days of your first emails going out].');
  else
    s1 := jsonb_build_array(
      'You are on the ' || v_plan || ' plan. We run cold email outreach for you and book qualified sales calls into your calendar.',
      'We promise ' || v_calls || ' qualified calls every month. [Your first month starts on the day your first emails go out, not the day you sign.]');
  end if;

  -- 2 What counts as a qualified call -----------------------------------------------
  s2 := jsonb_build_array(
    '[A qualified call is a booked call that takes place with a decision-maker (owner, founder, director or head of department) at a company that matches the target profile we agree in writing at kickoff, who has agreed to talk about your service. A no-show that we cannot rebook within 14 days does not count.]',
    'If you think a call did not qualify, tell us within [5 business days] of the call. We will check it together and replace it if you are right.');

  -- 3 Fees and payment --------------------------------------------------------------
  if v_pilot then
    s3 := jsonb_build_array(
      'The Pilot costs ' || v_fee || ', paid once, for ' || v_calls || ' qualified calls.');
  elsif v_3mo then
    s3 := jsonb_build_array(
      'The fee is ' || v_fee || ' per month for ' || v_calls || ' qualified calls a month, on a 3-month term. We invoice all 3 months (' || v_qtr || ') up front.');
  else
    s3 := jsonb_build_array(
      'The fee is ' || v_fee || ' per month for ' || v_calls || ' qualified calls a month. We invoice once a month.');
  end if;
  s3 := s3 || jsonb_build_array(
    case when v_pilot then 'It is payable' else 'Each invoice is payable' end
    || ' [in full, in advance, within 7 days of the invoice]. All fees are in US dollars. We start work when your '
    || case when v_pilot then 'invoice' else 'first invoice' end || ' is paid.');
  if not v_pilot and coalesce(c.pilot_credit, 0) > 0 then
    s3 := s3 || jsonb_build_array(
      'The $' || to_char(c.pilot_credit, 'FM999,999,990') || ' you paid for your Pilot is taken off your first invoice.');
  end if;

  -- 4 What we need from you ---------------------------------------------------------
  s4 := jsonb_build_array(
    'Fill in the kickoff form. It asks for the access and answers we need to start.',
    'Approve or correct what we send you (target lists, email copy) within [2 business days].',
    'Turn up to the calls we book, and tell us how each one went.',
    '[If we are held up waiting for you, your calls may arrive later. That delay does not count as a shortfall.]');

  -- 5 Our guarantee -----------------------------------------------------------------
  if v_pilot then
    s5 := jsonb_build_array(
      '[If we deliver fewer qualified calls than promised, we refund the shortfall at your per-call rate (fee ÷ calls promised) — or credit it against your first month if you carry on with us.]');
  else
    s5 := jsonb_build_array(
      '[If we deliver fewer qualified calls than promised in a month, we credit the shortfall at your per-call rate (monthly fee ÷ calls promised) against your next invoice — or refund it if you are leaving.]');
  end if;
  s5 := s5 || jsonb_build_array(
    'Your per-call rate is ' || v_rate || '.',
    'We guarantee qualified calls, not sales. What happens on the call is up to you.');

  -- 6 Ending the agreement ----------------------------------------------------------
  if v_pilot then
    s6 := jsonb_build_array(
      'The Pilot is a one-off. It ends when we have delivered your ' || v_calls || ' calls or settled any shortfall. It does not renew and you owe nothing more.',
      'If you move to a monthly plan within [30 days] of the Pilot ending, we take the ' || v_fee || ' off your first month.');
  elsif v_3mo then
    s6 := jsonb_build_array(
      'This agreement runs for 3 months from the day your first emails go out. After that it carries on month to month [at the same monthly price] until one of us ends it.',
      'Once the 3 months are up, either of us can end it with [14 days''] written notice. An email counts.',
      '[The 3-month fee is not refunded if you stop early, except for anything we owe you under our guarantee.]');
  else
    s6 := jsonb_build_array(
      'This agreement runs month to month. Either of us can end it with [14 days''] written notice. An email counts.',
      'A month you have already paid for is not refunded, but we still deliver the calls we owe you for it, or settle the shortfall under our guarantee.');
  end if;

  -- 7 The small print ---------------------------------------------------------------
  s7 := jsonb_build_array(
    'We each keep the other''s private business information confidential.',
    'Your data and your lists stay yours. We use them only to do this work.',
    'This page is the whole agreement. Changes must be agreed in writing; an email counts. Typing your name and pressing Sign is your signature.',
    'This agreement is governed by [the laws of Sri Lanka].');

  -- Questions for the owner (one per bracket above) -----------------------------------
  if v_legal like '[%' then
    ph := ph || 'What is your company''s legal name? Add it in Settings and it fills in here.'::text;
  end if;
  if v_addr like '[%' then
    ph := ph || 'What is your company''s address? Add it in Settings and it fills in here.'::text;
  end if;
  if v_pilot then
    ph := ph || 'How long do you give yourself to deliver the Pilot calls? Draft says within 30 days of the first emails going out.'::text;
  else
    ph := ph || 'When does a client''s month start? Draft says the day their first emails go out, not the day they sign.'::text;
  end if;
  ph := ph || array[
    'What counts as a qualified call? Draft says a call that takes place with a decision-maker at a company matching the agreed target profile, and a no-show you cannot rebook within 14 days does not count.',
    'How long does a client have to dispute a call? Draft says 5 business days.',
    'What are your payment terms? Draft says in full, in advance, within 7 days of the invoice.',
    'How fast must the client approve lists and copy? Draft says 2 business days.',
    'If the client holds you up, does that delay count against your guarantee? Draft says it does not.'
  ]::text[];
  if v_pilot then
    ph := ph || array[
      'What do you do if the Pilot falls short? Draft says refund the missing calls at the per-call rate (' || v_rate || '), or credit them against the first month if they continue.',
      'How long after the Pilot can a client still get the ' || v_fee || ' credited against their first month? Draft says 30 days.'
    ]::text[];
  else
    ph := ph || array[
      'What do you do if a month falls short? Draft says credit the missing calls at the per-call rate (' || v_rate || ') against the next invoice, or refund them if the client is leaving.',
      'How much notice to end the agreement? Draft says 14 days, in writing.'
    ]::text[];
    if v_3mo then
      ph := ph || array[
        'What price applies after the 3 months, when it goes month to month? Draft says the same monthly price.',
        'If a 3-month client stops early, do they get anything back? Draft says no, apart from what the guarantee owes them.'
      ]::text[];
    end if;
  end if;
  ph := ph || 'Which country''s law governs the agreement? Draft says Sri Lanka.'::text;

  return jsonb_build_object(
    'title', 'Service Agreement',
    'intro', 'This is the whole agreement between Aviance ("we") and ' || c.company
             || ' ("you"). It is one page, in plain English, and it starts the day you sign it.',
    'parties', jsonb_build_array(
      jsonb_build_object('label', 'Aviance (we)',  'value', v_legal),
      jsonb_build_object('label', 'Our address',   'value', v_addr),
      jsonb_build_object('label', 'Client (you)',  'value', c.company),
      jsonb_build_object('label', 'Your contact',  'value', c.contact_name || ', ' || c.contact_email)),
    'sections', jsonb_build_array(
      jsonb_build_object('h', '1. What we deliver',                 'body', s1),
      jsonb_build_object('h', '2. What counts as a qualified call', 'body', s2),
      jsonb_build_object('h', '3. Fees and payment',                'body', s3),
      jsonb_build_object('h', '4. What we need from you',           'body', s4),
      jsonb_build_object('h', '5. Our guarantee',                   'body', s5),
      jsonb_build_object('h', '6. Ending the agreement',            'body', s6),
      jsonb_build_object('h', '7. The small print',                 'body', s7)),
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
  v_what  text;      -- '5 qualified calls a month' / '2 qualified calls'
  v_num   text; v_amt text; v_due text; v_credit text := '';
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
  v_what  := c.calls_promised || ' qualified calls' || case when c.plan = 'pilot' then '' else ' a month' end;
  v_num   := coalesce(inv.number, '');
  v_amt   := '$' || to_char(coalesce(inv.amount,
               c.monthly_fee * case when c.term = '3month' and c.plan <> 'pilot' then 3 else 1 end), 'FM999,999,990');
  v_due   := case when inv.due_on is null then 'Due on receipt' else 'Due ' || to_char(inv.due_on, 'FMDD FMMonth YYYY') end;
  if coalesce(inv.pilot_credit, 0) > 0 then
    v_credit := 'Your $' || to_char(inv.pilot_credit, 'FM999,999,990') || ' Pilot credit is already taken off.';
  end if;

  body := $s$<tr><td class="pad" style="padding:52px 40px 40px">
<div style="font-size:20px;color:#5C5C5C;padding-bottom:18px">Hi [[NAME]],</div>
<div class="h1" style="font-size:72px;line-height:1.08;font-weight:800;letter-spacing:-0.04em">Let&rsquo;s get you<br><span style="background:#E0290F;color:#FFFFFF;padding:0 10px">booked calls.</span></div>
<div style="font-size:18px;line-height:1.5;color:#000000;padding-top:28px">Great to be working with [[COMPANY]]. You are on the <b>[[PLAN]]</b> plan: <b>[[WHAT]]</b>, guaranteed. Two quick steps and we get to work.</div></td></tr>
<tr><td class="pad" style="padding:28px 40px 0;border-top:2px solid #000000">
<div style="[[MONO]]font-size:12px;font-weight:700;letter-spacing:0.16em;color:#5C5C5C;padding-bottom:16px">TWO STEPS TO START</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:18px;line-height:1.45">
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 0 0">01</td><td><b>Sign the agreement.</b> One page, plain English. Type your name and you are done.</td></tr>
</table></td></tr>
<tr><td class="pad" style="padding:20px 40px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#E0290F" style="background:#E0290F"><a class="btn" href="[[AGREE_URL]]" style="display:block;padding:26px 20px;font-size:26px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Read and sign &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 20px">
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:18px;line-height:1.45">
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 0 0">02</td><td><b>Pay the invoice.</b> The payment details are on it.</td></tr>
</table></td></tr>
<tr><td class="pad" bgcolor="#000000" style="background:#000000;padding:36px 40px 40px;color:#FFFFFF">
<div style="[[MONO]]font-size:12px;font-weight:700;letter-spacing:0.16em;color:#BDBDBD">INVOICE [[INV_NUM]]</div>
<div style="[[MONO]]font-weight:700;letter-spacing:-0.05em;padding:8px 0"><span class="big" style="font-size:96px;line-height:1">[[AMOUNT]]</span></div>
<div style="font-size:20px;color:#BDBDBD;padding-bottom:28px">[[DUE]][[CREDIT]]</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#FFFFFF" style="background:#FFFFFF"><a class="btn" href="[[PAY_URL]]" style="display:block;padding:26px 20px;font-size:26px;font-weight:800;letter-spacing:-0.01em;color:#000000;text-decoration:none">View invoice and pay &rarr;</a></td></tr></table></td></tr>
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
      || E'1. Sign the agreement. One page, plain English. Type your name and you are done.\n' || v_agree || E'\n\n'
      || E'2. Pay the invoice. The payment details are on it.\n'
      || 'Invoice ' || v_num || ': ' || v_amt || '. ' || v_due || '.'
      || case when v_credit = '' then '' else ' ' || v_credit end || E'\n' || v_pay || E'\n\n'
      || E'Once both are done, we open your private channel and book your kickoff.\n\n'
      || E'Questions? Just reply.\n\nAviance';

  return jsonb_build_object('subject', 'Your Aviance agreement and invoice', 'text', txt, 'html', html);
end
$fn$;


-- -------------------------------------------------------------------------------------
-- 3. The "welcome" email: open your channel (sent when the invoice is marked paid)
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
  v_first   text;
  v_join    text := coalesce(p_join_url, '');
  v_agree   text := coalesce(p_agreement_url, '');
  v_receipt text := coalesce(p_receipt_url, '');
  v_kick    text := coalesce(nullif(p_kickoff_url, ''), public.biz('kickoff_link'), '');
  v_paid    text := '';     -- 'Invoice AV-0007, $1,500, paid.'
  mono text := $s$font-family:'JetBrains Mono','Courier New',Courier,monospace;$s$;
  lnk  text := 'color:#E0290F;font-weight:700;text-decoration:underline';
  body text; html text; txt text;
begin
  select * into c from public.clients where id = p_client;
  if not found then
    raise exception 'That client does not exist.';
  end if;
  select * into inv from public.invoices where client_id = p_client order by created_at desc limit 1;

  v_first := coalesce(nullif(split_part(btrim(coalesce(c.contact_name, '')), ' ', 1), ''), 'there');
  if inv.number is not null then
    v_paid := 'Invoice ' || inv.number || ', $' || to_char(inv.amount, 'FM999,999,990')
           || case when inv.status = 'paid' then ', paid.' else '.' end;
  end if;

  body := $s$<tr><td class="pad" bgcolor="#000000" style="background:#000000;padding:52px 40px 48px">
<div style="font-size:20px;color:#BDBDBD;padding-bottom:18px">Hi [[NAME]],</div>
<div class="h1" style="font-size:84px;line-height:0.96;font-weight:800;letter-spacing:-0.04em;color:#FFFFFF">Payment<br>received.<br>You&rsquo;re in<span style="color:#E0290F">.</span></div></td></tr>
<tr><td class="pad" style="padding:32px 40px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#E0290F" style="background:#E0290F"><a class="btn" href="[[JOIN_URL]]" style="display:block;padding:26px 20px;font-size:26px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Open your channel &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:10px 40px 28px;font-size:16px;line-height:1.5;color:#5C5C5C">Set a password and you are in. This link is yours alone and works once.</td></tr>
<tr><td class="pad" style="padding:28px 40px 36px;border-top:2px solid #000000">
<div style="font-size:18px;line-height:1.5;padding-bottom:24px">Your private channel is where [[COMPANY]] and our team talk. Updates and questions go there.</div>
<div style="[[MONO]]font-size:12px;font-weight:700;letter-spacing:0.16em;color:#5C5C5C;padding-bottom:16px">ONCE YOU ARE IN</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:18px;line-height:1.45">
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 14px 0">01</td><td style="padding-bottom:14px"><b>Book your kickoff call.</b> Pick a time that suits you. <br><a href="[[KICK_URL]]" style="[[LNK]]">Choose a time&nbsp;&rarr;</a></td></tr>
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 14px 0">02</td><td style="padding-bottom:14px"><b>Your agreement.</b> Sign it if you have not yet, and keep a copy. <br><a href="[[AGREE_URL]]" style="[[LNK]]">Open the agreement&nbsp;&rarr;</a></td></tr>
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 0 0">03</td><td><b>Your receipt.</b> [[PAID]] <br><a href="[[RECEIPT_URL]]" style="[[LNK]]">View your receipt&nbsp;&rarr;</a></td></tr>
</table></td></tr>$s$;

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
  html := replace(html, '[[FOOT]]', 'Glad to have you.');
  -- everything below came from the client row, the invoice or the caller, so it is escaped
  html := replace(html, '[[PAID]]', replace(replace(replace(v_paid, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[JOIN_URL]]', replace(replace(replace(replace(v_join, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[KICK_URL]]', replace(replace(replace(replace(v_kick, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[AGREE_URL]]', replace(replace(replace(replace(v_agree, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[RECEIPT_URL]]', replace(replace(replace(replace(v_receipt, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[NAME]]', replace(replace(replace(v_first, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[COMPANY]]', replace(replace(replace(c.company, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));

  txt := 'Hi ' || v_first || E',\n\n'
      || E'Payment received. You''re in.\n\n'
      || E'Open your channel:\n' || v_join || E'\n'
      || E'Set a password and you are in. This link is yours alone and works once.\n\n'
      || 'Your private channel is where ' || c.company || E' and our team talk. Updates and questions go there.\n\n'
      || E'Once you are in:\n\n'
      || E'1. Book your kickoff call. Pick a time that suits you.\n' || v_kick || E'\n\n'
      || E'2. Your agreement. Sign it if you have not yet, and keep a copy.\n' || v_agree || E'\n\n'
      || '3. Your receipt.' || case when v_paid = '' then '' else ' ' || v_paid end || E'\n' || v_receipt || E'\n\n'
      || E'Glad to have you.\n\nAviance';

  return jsonb_build_object('subject', 'You''re in: open your Aviance channel', 'text', txt, 'html', html);
end
$fn$;
