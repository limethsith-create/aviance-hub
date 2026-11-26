-- 20261206_email_design.sql
-- Aviance email templates, redesigned to DESIGN.md.
-- Each mail keeps the same house (600px table, Ink header rule, mono labels, Ink footer)
-- and gets its own shape: the confirmation is a ticket, the pack is a statement, the
-- welcome is an opening, the reminders are short and light.
-- Palette: Ink #0A0A0C  Paper #FFFFFF  Mist #F6F7F9  Line #DCDCE0  Muted #63636A
--          Red #C42408  Red-bright #E0290F (on Ink only)  Sand #F4EFE9
-- Tables and inline styles only. The one <style> block carries media queries only.
-- create or replace throughout; nothing is dropped or deleted.

-- 1. mail_slot: replace the contents of a marked slot in a stored mail body.
--    The confirmation HTML carries <!--HEAD-->..<!--/HEAD--> style markers so that
--    queue_meeting_confirmation can retitle a kickoff/onboarding mail without
--    depending on the exact wording or HTML entities of the headline. The old
--    literal replace on "You''re booked in." never matched the HTML (which renders
--    the apostrophe as &rsquo;), so the kickoff headline silently stayed wrong.
create or replace function public.mail_slot(p_html text, p_slot text, p_value text)
returns text
language sql
immutable
as $fn$
  select case
    when p_html is null or p_value is null then p_html
    else regexp_replace(
           p_html,
           '<!--' || p_slot || '-->.*?<!--/' || p_slot || '-->',
           '<!--' || p_slot || '-->' || replace(p_value, E'\\', E'\\\\') || '<!--/' || p_slot || '-->')
  end;
$fn$;


-- 2. mail_html: the booking confirmation and the three reminders.
create or replace function public.mail_html(p_kind text, p_name text, p_at timestamp with time zone, p_zone text)
returns text
language plpgsql
stable
as $fn$
declare
  z       text := coalesce(nullif(p_zone,''),'America/New_York');
  loc     timestamp;
  v_first text := coalesce(nullif(split_part(coalesce(p_name,''),' ',1),''),'there');
  v_day text; v_day3 text; v_date text; v_month text; v_month3 text; v_year text;
  v_time text; v_ampm text; v_zone text;
  mono text := $s$font-family:'JetBrains Mono','Courier New',Courier,monospace;$s$;
  tag text; tagstyle text; foot text; body text; btn text; html text;
  s_ink     text := 'background:#0A0A0C;color:#FFFFFF';
  s_outline text := 'border:2px solid #0A0A0C;color:#0A0A0C';
begin
  begin
    loc := p_at at time zone z;
  exception when others then
    z := 'America/New_York'; loc := p_at at time zone z;
  end;
  v_day   := upper(to_char(loc,'FMDay'));
  v_day3  := to_char(loc,'Dy');
  v_date  := to_char(loc,'FMDD');
  v_month := to_char(loc,'FMMonth');
  v_month3:= to_char(loc,'Mon');
  v_year  := to_char(loc,'YYYY');
  v_time  := to_char(loc,'FMHH12:MI');
  v_ampm  := to_char(loc,'AM');
  v_zone  := replace(split_part(z,'/',greatest(array_length(string_to_array(z,'/'),1),1)),'_',' ') || ' time';

  btn := $s$<tr><td class="pad" style="padding:0 40px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#C42408" style="background:#C42408"><a class="btn" href="{{MEET_LINK}}" style="display:block;padding:19px 18px;font-size:20px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Join the call &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:0 40px 28px"><a href="{{MEET_LINK}}" style="[[MONO]]font-size:12px;color:#63636A;text-decoration:none;word-break:break-all">{{MEET_LINK}}</a></td></tr>$s$;

  if p_kind = 'booking_confirmation' then
    tag := 'CONFIRMED'; tagstyle := s_outline; foot := 'Need to move it? Just reply.';
    body := $s$<tr><td class="pad" style="padding:38px 40px 26px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A"><!--EYE-->YOUR CALL IS CONFIRMED<!--/EYE--></div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:11px"><tr><td width="24" height="3" bgcolor="#C42408" style="background:#C42408;font-size:0;line-height:0">&nbsp;</td></tr></table>
<div style="font-size:17px;line-height:1.55;color:#63636A;padding:20px 0 4px">Hi [[NAME]],</div>
<div class="h1" style="font-size:46px;line-height:1.02;font-weight:800;letter-spacing:-0.04em"><!--HEAD-->You&rsquo;re booked in.<!--/HEAD--></div></td></tr>
<tr><td class="pad" style="padding:0 40px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C;border-bottom:2px solid #0A0A0C"><tr>
<td class="datebox" width="166" align="center" bgcolor="#F4EFE9" style="background:#F4EFE9;padding:20px 10px;border-right:2px dashed #DCDCE0">
<div style="[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A">[[DAY]]</div>
<div class="num" style="[[MONO]]font-size:62px;line-height:1.1;font-weight:700;letter-spacing:-0.05em;color:#0A0A0C">[[DATE]]</div>
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.14em;color:#0A0A0C">[[MONTH3]] [[YEAR]]</div></td>
<td valign="top" style="padding:19px 22px 17px">
<div style="[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:4px">STARTS</div>
<div style="[[MONO]]font-weight:700;letter-spacing:-0.03em;color:#0A0A0C"><span class="big" style="font-size:38px;line-height:1.15">[[TIME]]</span> <span style="font-size:17px">[[AMPM]]</span></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px">
<tr><td style="border-top:1px solid #DCDCE0;padding:7px 0 0;font-size:13px;line-height:1.5;color:#63636A">[[ZONE]]</td></tr>
<tr><td style="border-top:1px solid #DCDCE0;padding:7px 0 0;font-size:13px;line-height:1.5;color:#63636A"><!--MINS-->30 minutes<!--/MINS--> &middot; Google Meet</td></tr>
</table></td></tr></table></td></tr>
[[BTN]]
<tr><td class="pad" style="padding:4px 40px 34px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C"><tr><td style="padding-top:22px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:14px">BEFORE WE SPEAK</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:16px;line-height:1.55">
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 11px 0">01</td><td style="padding-bottom:11px">Press <b>Yes</b> on the calendar invite. It saves the link for you.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 11px 0">02</td><td style="padding-bottom:11px"><!--P2-->Think about who your best customers are.<!--/P2--></td></tr>
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 0 0">03</td><td><!--P3-->Know what one new customer is worth to you.<!--/P3--></td></tr>
</table></td></tr></table></td></tr>$s$;

  elsif p_kind = 'reminder_24h' then
    tag := 'TOMORROW'; tagstyle := s_outline; foot := 'See you tomorrow.';
    body := $s$<tr><td class="pad" style="padding:38px 40px 24px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A">REMINDER &middot; 24 HOURS OUT</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:11px"><tr><td width="24" height="3" bgcolor="#C42408" style="background:#C42408;font-size:0;line-height:0">&nbsp;</td></tr></table>
<div style="font-size:17px;line-height:1.55;color:#63636A;padding:20px 0 4px">Hi [[NAME]],</div>
<div class="h1" style="font-size:46px;line-height:1.02;font-weight:800;letter-spacing:-0.04em">We speak tomorrow.</div></td></tr>
<tr><td class="pad" style="padding:0 40px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C">
<tr><td style="padding:13px 0 11px;border-bottom:1px solid #DCDCE0;[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A">DATE</td>
<td align="right" style="padding:13px 0 11px;border-bottom:1px solid #DCDCE0;[[MONO]]font-size:15px;font-weight:700;color:#0A0A0C">[[DAY3]] [[DATE]] [[MONTH3]] [[YEAR]]</td></tr>
<tr><td style="padding:13px 0 11px;border-bottom:1px solid #DCDCE0;[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A">TIME</td>
<td align="right" style="padding:11px 0 9px;border-bottom:1px solid #DCDCE0;[[MONO]]font-size:22px;font-weight:700;letter-spacing:-0.02em;color:#0A0A0C">[[TIME]] [[AMPM]]</td></tr>
<tr><td style="padding:13px 0 11px;border-bottom:2px solid #0A0A0C;[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A">WHERE</td>
<td align="right" style="padding:13px 0 11px;border-bottom:2px solid #0A0A0C;font-size:14px;color:#63636A">Google Meet &middot; 30 minutes &middot; [[ZONE]]</td></tr>
</table></td></tr>
[[BTN]]
<tr><td class="pad" style="padding:0 40px 32px;font-size:16px;line-height:1.55;color:#63636A">Time no longer works? Reply to this and we&rsquo;ll move it.</td></tr>$s$;

  elsif p_kind = 'reminder_1h' then
    tag := 'IN 1 HOUR'; tagstyle := s_ink; foot := 'Speak shortly.';
    body := $s$<tr><td class="pad" style="padding:40px 40px 10px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A">TODAY &middot; STARTING SOON</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:11px"><tr><td width="24" height="3" bgcolor="#C42408" style="background:#C42408;font-size:0;line-height:0">&nbsp;</td></tr></table>
<div class="h1" style="font-size:42px;line-height:1.04;font-weight:800;letter-spacing:-0.04em;padding:20px 0 0">In about an hour.</div></td></tr>
<tr><td class="pad" style="padding:22px 40px 26px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C;border-bottom:2px solid #0A0A0C"><tr><td style="padding:20px 0 18px">
<div style="[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:6px">YOUR CALL BEGINS AT</div>
<div style="[[MONO]]font-weight:700;letter-spacing:-0.04em;color:#C42408"><span class="fig" style="font-size:62px;line-height:1.08">[[TIME]]</span> <span style="font-size:26px">[[AMPM]]</span></div>
<div style="font-size:13px;line-height:1.5;color:#63636A;padding-top:8px">[[ZONE]] &middot; 30 minutes &middot; Google Meet</div>
</td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#0A0A0C" style="background:#0A0A0C"><a class="btn" href="{{MEET_LINK}}" style="display:block;padding:19px 18px;font-size:20px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Join the call &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:0 40px 26px"><a href="{{MEET_LINK}}" style="[[MONO]]font-size:12px;color:#63636A;text-decoration:none;word-break:break-all">{{MEET_LINK}}</a></td></tr>
<tr><td class="pad" style="padding:0 40px 32px;font-size:16px;line-height:1.55;color:#63636A">Running late? Reply and we&rsquo;ll sort it.</td></tr>$s$;

  else  -- reminder_5min
    tag := 'NOW'; tagstyle := s_ink; foot := 'See you in there.';
    body := $s$<tr><td class="pad" style="padding:42px 40px 24px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A">STARTING IN FIVE MINUTES</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:11px"><tr><td width="24" height="3" bgcolor="#C42408" style="background:#C42408;font-size:0;line-height:0">&nbsp;</td></tr></table>
<div class="h1" style="font-size:48px;line-height:1.02;font-weight:800;letter-spacing:-0.04em;padding:20px 0 0">We&rsquo;re on in five.</div></td></tr>
<tr><td class="pad" style="padding:0 40px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#C42408" style="background:#C42408"><a class="btn" href="{{MEET_LINK}}" style="display:block;padding:26px 18px;font-size:26px;font-weight:800;letter-spacing:-0.015em;color:#FFFFFF;text-decoration:none">Join now &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:0 40px 34px"><a href="{{MEET_LINK}}" style="[[MONO]]font-size:12px;color:#63636A;text-decoration:none;word-break:break-all">{{MEET_LINK}}</a></td></tr>$s$;
  end if;

  html := $s$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviance</title>
<style>@media (max-width:480px){.h1{font-size:34px!important}.big{font-size:40px!important}.num{font-size:52px!important}.fig{font-size:44px!important}.pad{padding-left:22px!important;padding-right:22px!important}.btn{font-size:18px!important}.datebox{width:112px!important}}</style></head>
<body style="margin:0;padding:0;background:#F6F7F9"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F9"><tr><td align="center" style="padding:22px 0 26px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:'Inter Tight',Arial,Helvetica,sans-serif;color:#0A0A0C">
<tr><td class="pad" style="padding:16px 40px;border-bottom:2px solid #0A0A0C"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td><img src="https://www.aviance.online/logo-180.png" width="44" height="44" alt="Aviance" style="vertical-align:middle;border:0"><span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;vertical-align:middle;padding-left:10px">Aviance</span></td>
<td align="right"><span style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;[[TAGSTYLE]];padding:7px 10px;white-space:nowrap">[[TAG]]</span></td></tr></table></td></tr>
[[BODY]]
<tr><td class="pad" bgcolor="#0A0A0C" style="background:#0A0A0C;padding:22px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:14px;line-height:1.5;color:#FFFFFF">[[FOOT]]</td>
<td align="right" valign="middle"><a href="https://www.aviance.online" style="[[MONO]]font-size:11px;letter-spacing:0.16em;color:#DCDCE0;text-decoration:none">AVIANCE.ONLINE</a></td></tr></table></td></tr>
</table></td></tr></table></body></html>$s$;

  html := replace(html,'[[BODY]]',body);
  html := replace(html,'[[BTN]]',btn);
  html := replace(html,'[[MONO]]',mono);
  html := replace(html,'[[TAG]]',tag);
  html := replace(html,'[[TAGSTYLE]]',tagstyle);
  html := replace(html,'[[FOOT]]',foot);
  -- a person's name is the only thing here that did not come from us
  html := replace(html,'[[NAME]]',replace(replace(replace(v_first,'&','&amp;'),'<','&lt;'),'>','&gt;'));
  html := replace(html,'[[DAY3]]',v_day3);     html := replace(html,'[[DAY]]',v_day);
  html := replace(html,'[[DATE]]',v_date);
  html := replace(html,'[[MONTH3]]',v_month3); html := replace(html,'[[MONTH]]',v_month);
  html := replace(html,'[[YEAR]]',v_year);
  html := replace(html,'[[TIME]]',v_time);     html := replace(html,'[[AMPM]]',v_ampm);
  html := replace(html,'[[ZONE]]',v_zone);
  return html;
end
$fn$;

-- 3. mail_text: the plain-text twin of mail_html. The booking_confirmation body is
--    left word for word as it was, because queue_meeting_confirmation still edits it
--    by literal replace.
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
      || 'DATE  ' || public.pretty_when(p_at,p_zone) || E'\n'
      || E'WHERE Google Meet - 30 minutes\n\n'
      || E'Join the call: {{MEET_LINK}}\n\nTime no longer works? Reply to this and we''ll move it.\n\nAviance'
    when 'reminder_1h' then
      E'In about an hour.\n\n' || 'Your call begins at ' || public.pretty_when(p_at,p_zone) || E'.\n'
      || E'Google Meet - 30 minutes\n\nJoin the call: {{MEET_LINK}}\n\nRunning late? Reply and we''ll sort it.\n\nAviance'
    else E'We''re on in five.\n\nJoin now: {{MEET_LINK}}\n\nAviance'
  end;
$fn$;


-- 4. mail_pack: the agreement + invoice mail. Shaped like a statement -- an engagement
--    rule stack, the amount as the figure block with an UNPAID stamp beside it, then the
--    two numbered steps each with its own button (sign = Ink, pay = Red), then the
--    guarantee in the Sand block where it earns the sale.
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
  v_what  text;      -- '5 qualified calls a month' (+ the 3-month price when that is the term)
  v_calls text; v_term text;
  v_num   text; v_numd text; v_amt text; v_due text; v_short text; v_stamp text;
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
  v_calls := c.calls_promised || ' qualified calls a month';
  v_term  := case when c.term = '3month'
                  then '3 months &middot; $' || to_char(c.monthly_fee, 'FM999,999,990') || ' a month, paid up front'
                  else 'Monthly &middot; $' || to_char(c.monthly_fee, 'FM999,999,990') || ' a month' end;
  v_what  := v_calls
             || case when c.term = '3month'
                     then ', $' || to_char(c.monthly_fee, 'FM999,999,990') || ' a month for 3 months, paid up front' else '' end;
  v_num   := coalesce(inv.number, '');
  v_numd  := case when v_num = '' then 'to follow' else v_num end;
  v_amt   := '$' || to_char(coalesce(inv.amount,
               c.monthly_fee * case when c.term = '3month' then 3 else 1 end), 'FM999,999,990');
  v_due   := case when inv.due_on is null then 'Due on receipt' else 'Due ' || to_char(inv.due_on, 'FMMonth FMDD, YYYY') end;
  v_short := case when inv.due_on is null then 'due on receipt' else 'due ' || to_char(inv.due_on, 'Mon FMDD') end;
  v_stamp := case when coalesce(inv.status, '') = 'paid' then 'PAID' else 'UNPAID' end;
  -- the invoice page only shows payment details once a method is really filled in
  if public.pay_ready() then
    v_howpay := 'The payment details are on it.';
  else
    v_howpay := 'We will send you the payment details directly.';
  end if;
  v_subj := case when v_num = '' then 'Your Aviance agreement and invoice'
                 else 'Agreement + invoice ' || v_num || ' · ' || v_amt || ' ' || v_short end;

  body := $s$<tr><td class="pad" style="padding:38px 40px 26px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A">NEW ENGAGEMENT</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:11px"><tr><td width="24" height="3" bgcolor="#C42408" style="background:#C42408;font-size:0;line-height:0">&nbsp;</td></tr></table>
<div style="font-size:17px;line-height:1.55;color:#63636A;padding:20px 0 4px">Hi [[NAME]],</div>
<div class="h1" style="font-size:44px;line-height:1.04;font-weight:800;letter-spacing:-0.04em">Let&rsquo;s get you<br>booked calls.</div>
<div style="font-size:17px;line-height:1.55;color:#0A0A0C;padding-top:22px">Great to be working with [[COMPANY]]. Everything you need is below: the agreement to sign, and the invoice to settle. Two steps, then we get to work.</div></td></tr>
<tr><td class="pad" style="padding:0 40px 22px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C">
<tr><td style="padding:12px 0 10px;border-bottom:1px solid #DCDCE0;[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A">PLAN</td>
<td align="right" style="padding:12px 0 10px;border-bottom:1px solid #DCDCE0;[[MONO]]font-size:14px;font-weight:700;color:#0A0A0C">[[PLAN]]</td></tr>
<tr><td style="padding:12px 0 10px;border-bottom:1px solid #DCDCE0;[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A">VOLUME</td>
<td align="right" style="padding:12px 0 10px;border-bottom:1px solid #DCDCE0;font-size:14px;color:#0A0A0C">[[CALLS]]</td></tr>
<tr><td style="padding:12px 0 2px;[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A">TERM</td>
<td align="right" style="padding:12px 0 2px;font-size:14px;color:#0A0A0C">[[TERM]]</td></tr>
</table></td></tr>
<tr><td class="pad" style="padding:0 40px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C;border-bottom:2px solid #0A0A0C"><tr><td style="padding:20px 0 18px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td valign="top"><div style="[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:6px">AMOUNT DUE</div>
<div class="fig" style="[[MONO]]font-size:58px;line-height:1.08;font-weight:700;letter-spacing:-0.05em;color:#0A0A0C">[[AMOUNT]]</div></td>
<td valign="top" align="right"><span style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.18em;color:#C42408;border:2px solid #C42408;padding:6px 10px;white-space:nowrap">[[STAMP]]</span></td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
<tr><td style="border-top:1px solid #DCDCE0;padding:8px 0 0;[[MONO]]font-size:13px;color:#63636A">INVOICE [[INV_NUM]]</td>
<td align="right" style="border-top:1px solid #DCDCE0;padding:8px 0 0;[[MONO]]font-size:13px;color:#63636A">[[DUE]]</td></tr></table>
</td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 8px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:16px">TWO STEPS TO START</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:16px;line-height:1.55">
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 0 0">01</td><td><b>Sign the agreement.</b> Short, in plain English. Type your name and you are done.</td></tr>
</table></td></tr>
<tr><td class="pad" style="padding:16px 40px 26px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#0A0A0C" style="background:#0A0A0C"><a class="btn" href="[[AGREE_URL]]" style="display:block;padding:18px 18px;font-size:19px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Read and sign &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 8px">
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:16px;line-height:1.55">
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 0 0">02</td><td><b>Pay the invoice.</b> [[HOWPAY]]</td></tr>
</table></td></tr>
<tr><td class="pad" style="padding:16px 40px 30px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#C42408" style="background:#C42408"><a class="btn" href="[[PAY_URL]]" style="display:block;padding:18px 18px;font-size:19px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">View the invoice &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F4EFE9" style="background:#F4EFE9"><tr>
<td width="3" bgcolor="#C42408" style="background:#C42408;font-size:0;line-height:0">&nbsp;</td>
<td style="padding:22px 24px 24px">
<div style="[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:10px">YOUR GUARANTEE</div>
<div style="font-size:16px;line-height:1.55;color:#0A0A0C">Miss your number in month one and we refund <b>twice</b> that month&rsquo;s fee. Miss it in any later month and that month is refunded in full. Not live within 14 days of kickoff and your next month is free.</div>
<div style="font-size:13px;line-height:1.5;color:#63636A;padding-top:12px">A booked call matches the target profile we agree together and has accepted a confirmed time. No-shows do not count against you.</div>
</td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 34px;font-size:16px;line-height:1.55;color:#63636A">Once both are done, we open your private channel and book your kickoff.</td></tr>$s$;

  html := $s$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviance</title>
<style>@media (max-width:480px){.h1{font-size:34px!important}.big{font-size:40px!important}.num{font-size:52px!important}.fig{font-size:44px!important}.pad{padding-left:22px!important;padding-right:22px!important}.btn{font-size:18px!important}.datebox{width:112px!important}}</style></head>
<body style="margin:0;padding:0;background:#F6F7F9"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F9"><tr><td align="center" style="padding:22px 0 26px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:'Inter Tight',Arial,Helvetica,sans-serif;color:#0A0A0C">
<tr><td class="pad" style="padding:16px 40px;border-bottom:2px solid #0A0A0C"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td><img src="https://www.aviance.online/logo-180.png" width="44" height="44" alt="Aviance" style="vertical-align:middle;border:0"><span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;vertical-align:middle;padding-left:10px">Aviance</span></td>
<td align="right"><span style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;[[TAGSTYLE]];padding:7px 10px;white-space:nowrap">[[TAG]]</span></td></tr></table></td></tr>
[[BODY]]
<tr><td class="pad" bgcolor="#0A0A0C" style="background:#0A0A0C;padding:22px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:14px;line-height:1.5;color:#FFFFFF">[[FOOT]]</td>
<td align="right" valign="middle"><a href="https://www.aviance.online" style="[[MONO]]font-size:11px;letter-spacing:0.16em;color:#DCDCE0;text-decoration:none">AVIANCE.ONLINE</a></td></tr></table></td></tr>
</table></td></tr></table></body></html>$s$;

  html := replace(html, '[[BODY]]', body);
  html := replace(html, '[[MONO]]', mono);
  html := replace(html, '[[TAG]]', 'AGREEMENT &amp; INVOICE');
  html := replace(html, '[[TAGSTYLE]]', 'border:2px solid #0A0A0C;color:#0A0A0C');
  html := replace(html, '[[FOOT]]', 'Questions? Just reply.');
  html := replace(html, '[[HOWPAY]]', v_howpay);
  html := replace(html, '[[PLAN]]', replace(replace(replace(v_plan, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[CALLS]]', v_calls);
  html := replace(html, '[[TERM]]', v_term);
  html := replace(html, '[[AMOUNT]]', v_amt);
  html := replace(html, '[[STAMP]]', v_stamp);
  html := replace(html, '[[DUE]]', v_due);
  -- everything below came from the client row or from the caller, so it is escaped
  html := replace(html, '[[INV_NUM]]', replace(replace(replace(v_numd, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[AGREE_URL]]', replace(replace(replace(replace(v_agree, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[PAY_URL]]', replace(replace(replace(replace(v_pay, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[NAME]]', replace(replace(replace(v_first, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[COMPANY]]', replace(replace(replace(c.company, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));

  txt := 'Hi ' || v_first || E',\n\n'
      || 'Great to be working with ' || c.company || E'. Everything you need is below: the agreement to sign, and the invoice to settle.\n\n'
      || 'PLAN    ' || v_plan || E'\n'
      || 'VOLUME  ' || v_calls || E'\n'
      || 'TERM    ' || replace(v_term, '&middot;', '-') || E'\n\n'
      || 'AMOUNT DUE  ' || v_amt || ' (' || v_stamp || ')' || E'\n'
      || 'INVOICE     ' || v_numd || E'\n'
      || v_due || E'\n\n'
      || E'Two steps to start:\n\n'
      || E'1. Sign the agreement. Short, in plain English. Type your name and you are done.\n' || v_agree || E'\n\n'
      || '2. Pay the invoice. ' || v_howpay || E'\n' || v_pay || E'\n\n'
      || E'Your guarantee: miss your number in month one and we refund twice that month''s fee.\n'
      || E'Miss it in any later month and that month is refunded in full. Not live within 14 days\n'
      || E'of kickoff and your next month is free. A booked call matches the target profile we agree\n'
      || E'together and has accepted a confirmed time. No-shows do not count against you.\n\n'
      || E'Once both are done, we open your private channel and book your kickoff.\n\n'
      || E'Questions? Just reply.\n\nAviance';

  return jsonb_build_object('subject', v_subj, 'text', txt, 'html', html);
end
$fn$;

-- 5. mail_welcome: payment received, your channel is open. The longest mail, so it is
--    given a rhythm: Ink opening, the one Red button, a rule-stack of the client's file
--    with a PAID stamp, two numbered steps, the first fortnight in the Sand block, a
--    signed-off close.
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
  v_signer  text := coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''), (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()), '[YOUR NAME]');
  v_paid    text := 'Not yet issued';   -- 'AV-2026-1004 &middot; $3,000'
  v_stamp   text := 'PENDING';          -- PAID / UNPAID / PENDING
  v_paidtxt text := '';                 -- the same line for the plain-text body
  v_agtxt   text;                       -- 'Signed November 25, 2026' / 'Not signed yet'
  mono text := $s$font-family:'JetBrains Mono','Courier New',Courier,monospace;$s$;
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
    v_paid    := inv.number || ' &middot; $' || to_char(inv.amount, 'FM999,999,990');
    v_paidtxt := inv.number || ' - $' || to_char(inv.amount, 'FM999,999,990');
    v_stamp   := case when inv.status = 'paid' then 'PAID' else 'UNPAID' end;
  else
    v_paidtxt := 'Not yet issued';
  end if;
  if ag.status = 'signed' and ag.signed_at is not null then
    v_agtxt := 'Signed ' || to_char(ag.signed_at at time zone 'America/New_York', 'FMMonth FMDD, YYYY');
  else
    v_agtxt := 'Not signed yet';
  end if;

  body := $s$<tr><td class="pad" bgcolor="#0A0A0C" style="background:#0A0A0C;padding:40px 40px 38px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#DCDCE0">PAYMENT RECEIVED</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:11px"><tr><td width="24" height="3" bgcolor="#E0290F" style="background:#E0290F;font-size:0;line-height:0">&nbsp;</td></tr></table>
<div class="h1" style="font-size:46px;line-height:1.02;font-weight:800;letter-spacing:-0.04em;color:#FFFFFF;padding-top:20px">Your channel<br>is open.</div>
<div style="font-size:17px;line-height:1.55;color:#DCDCE0;padding-top:18px">Thank you, [[NAME]]. From here everything to do with [[COMPANY]] happens in one place.</div></td></tr>
<tr><td class="pad" style="padding:30px 40px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#C42408" style="background:#C42408"><a class="btn" href="[[JOIN_URL]]" style="display:block;padding:19px 18px;font-size:20px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Open your channel &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:0 40px 30px;font-size:14px;line-height:1.55;color:#63636A">Set a password and you are in. This link is yours alone and works once.</td></tr>
<tr><td class="pad" style="padding:0 40px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C">
<tr><td colspan="2" style="padding:14px 0 12px"><div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A">YOUR FILE</div></td></tr>
<tr><td valign="top" style="padding:12px 0 11px;border-top:1px solid #DCDCE0;[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A">AGREEMENT</td>
<td valign="top" align="right" style="padding:12px 0 11px;border-top:1px solid #DCDCE0;font-size:14px;line-height:1.5;color:#0A0A0C">[[AGTXT]]<br><a href="[[AGREE_URL]]" style="[[MONO]]font-size:12px;color:#0A0A0C;text-decoration:underline">Open the agreement &rarr;</a></td></tr>
<tr><td valign="top" style="padding:12px 0 11px;border-top:1px solid #DCDCE0;border-bottom:2px solid #0A0A0C;[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A">INVOICE</td>
<td valign="top" align="right" style="padding:12px 0 11px;border-top:1px solid #DCDCE0;border-bottom:2px solid #0A0A0C;font-size:14px;line-height:1.5;color:#0A0A0C"><span style="[[MONO]]font-size:13px">[[PAID]]</span> <span style="[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.18em;color:#C42408;border:2px solid #C42408;padding:3px 7px;white-space:nowrap">[[STAMP]]</span><br><a href="[[RECEIPT_URL]]" style="[[MONO]]font-size:12px;color:#0A0A0C;text-decoration:underline">View your receipt &rarr;</a></td></tr>
</table></td></tr>
<tr><td class="pad" style="padding:0 40px 30px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:14px">ONCE YOU ARE IN</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:16px;line-height:1.55">
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 11px 0">01</td><td style="padding-bottom:11px"><b>Set your password.</b> One minute, and the channel is yours on any device.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 0 0">02</td><td><b>Book your kickoff.</b> We will post a few times in your channel. Reply with the one that suits you and it is booked.</td></tr>
</table></td></tr>
<tr><td class="pad" style="padding:0 40px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F4EFE9" style="background:#F4EFE9"><tr>
<td width="3" bgcolor="#C42408" style="background:#C42408;font-size:0;line-height:0">&nbsp;</td>
<td style="padding:22px 24px 24px">
<div style="[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:14px">YOUR NEXT 14 DAYS</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.55">
<tr><td valign="top" width="96" style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.12em;color:#0A0A0C;padding:2px 14px 11px 0;white-space:nowrap">DAYS 1&ndash;4</td><td style="padding-bottom:11px;color:#0A0A0C">Kickoff, your market mapped, your ideal customer profile drafted, domains bought, inboxes warming.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.12em;color:#0A0A0C;padding:2px 14px 11px 0;white-space:nowrap">WEEKS 1&ndash;2</td><td style="padding-bottom:11px;color:#0A0A0C">We build your list and your copy. You approve both.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.12em;color:#0A0A0C;padding:2px 14px 0 0;white-space:nowrap">THEN</td><td style="color:#0A0A0C">We go live, and your month starts.</td></tr>
</table></td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 34px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C"><tr><td style="padding-top:20px;font-size:17px;line-height:1.55">Glad to have you.<br><b>[[SIGNER]]</b><br><span style="[[MONO]]font-size:12px;letter-spacing:0.12em;color:#63636A">FOUNDER &middot; AVIANCE</span></td></tr></table></td></tr>$s$;

  html := $s$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviance</title>
<style>@media (max-width:480px){.h1{font-size:34px!important}.big{font-size:40px!important}.num{font-size:52px!important}.fig{font-size:44px!important}.pad{padding-left:22px!important;padding-right:22px!important}.btn{font-size:18px!important}.datebox{width:112px!important}}</style></head>
<body style="margin:0;padding:0;background:#F6F7F9"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F9"><tr><td align="center" style="padding:22px 0 26px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:'Inter Tight',Arial,Helvetica,sans-serif;color:#0A0A0C">
<tr><td class="pad" style="padding:16px 40px;border-bottom:2px solid #0A0A0C"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td><img src="https://www.aviance.online/logo-180.png" width="44" height="44" alt="Aviance" style="vertical-align:middle;border:0"><span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;vertical-align:middle;padding-left:10px">Aviance</span></td>
<td align="right"><span style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;[[TAGSTYLE]];padding:7px 10px;white-space:nowrap">[[TAG]]</span></td></tr></table></td></tr>
[[BODY]]
<tr><td class="pad" bgcolor="#0A0A0C" style="background:#0A0A0C;padding:22px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:14px;line-height:1.5;color:#FFFFFF">[[FOOT]]</td>
<td align="right" valign="middle"><a href="https://www.aviance.online" style="[[MONO]]font-size:11px;letter-spacing:0.16em;color:#DCDCE0;text-decoration:none">AVIANCE.ONLINE</a></td></tr></table></td></tr>
</table></td></tr></table></body></html>$s$;

  html := replace(html, '[[BODY]]', body);
  html := replace(html, '[[MONO]]', mono);
  html := replace(html, '[[TAG]]', 'YOU&rsquo;RE IN');
  html := replace(html, '[[TAGSTYLE]]', 'background:#0A0A0C;color:#FFFFFF');
  html := replace(html, '[[FOOT]]', 'Questions? Just reply.');
  html := replace(html, '[[AGTXT]]', v_agtxt);
  html := replace(html, '[[STAMP]]', v_stamp);
  -- everything below came from the client row, the invoice, the settings or the caller, so it is escaped
  html := replace(html, '[[SIGNER]]', replace(replace(replace(v_signer, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[PAID]]', v_paid);
  html := replace(html, '[[JOIN_URL]]', replace(replace(replace(replace(v_join, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[AGREE_URL]]', replace(replace(replace(replace(v_agree, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[RECEIPT_URL]]', replace(replace(replace(replace(v_receipt, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));
  html := replace(html, '[[NAME]]', replace(replace(replace(v_first, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[COMPANY]]', replace(replace(replace(c.company, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));

  txt := 'Hi ' || v_first || E',\n\n'
      || E'Payment received. Your channel is open.\n\n'
      || 'From here everything to do with ' || c.company || E' happens in one place.\n\n'
      || E'Open your channel:\n' || v_join || E'\n'
      || E'Set a password and you are in. This link is yours alone and works once.\n\n'
      || E'YOUR FILE\n'
      || 'AGREEMENT  ' || v_agtxt || E'\n' || v_agree || E'\n'
      || 'INVOICE    ' || v_paidtxt || ' (' || v_stamp || ')' || E'\n' || v_receipt || E'\n\n'
      || E'Once you are in:\n\n'
      || E'1. Set your password. One minute, and the channel is yours on any device.\n'
      || E'2. Book your kickoff. We will post a few times in your channel. Reply with the one that suits you and it is booked.\n\n'
      || E'Your next 14 days:\n'
      || E'Days 1-4:   kickoff, your market mapped, your ideal customer profile drafted, domains bought, inboxes warming.\n'
      || E'Weeks 1-2:  we build your list and your copy. You approve both.\n'
      || E'Then:       we go live, and your month starts.\n\n'
      || E'Glad to have you.\n\n' || v_signer || E'\nFounder, Aviance';

  return jsonb_build_object('subject', 'You''re in: open your Aviance channel', 'text', txt, 'html', html);
end
$fn$;


-- 6. staff_invite_mail: the caller's 'your calling list is ready'. Brought into the house
--    shell; the access code is the centrepiece, set in the Sand credential block.
create or replace function public.staff_invite_mail(p_staff uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  s        public.staff;
  v_code   text := btrim(coalesce(p_code, ''));
  v_first  text;
  v_signer text := coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''),
                            (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()),
                            'Limethsith');
  v_site   text := coalesce(nullif(btrim(public.biz('site')), ''), 'https://aviance.store');
  v_url    text; txt text; body text; html text; v_mail uuid;
  mono text := $s$font-family:'JetBrains Mono','Courier New',Courier,monospace;$s$;
begin
  if not (public.is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'Only Aviance can send an invite.';
  end if;
  select * into s from public.staff where id = p_staff;
  if not found then raise exception 'That employee is not here any more.'; end if;
  if s.kind <> 'caller' then return public.staff_invite_mail_core(p_staff, p_code); end if;
  if v_code = '' then raise exception 'The access code is missing.'; end if;
  v_url   := rtrim(v_site, '/') || '/callers';
  v_first := coalesce(nullif(split_part(btrim(s.name), ' ', 1), ''), 'there');

  body := $s$<tr><td class="pad" style="padding:38px 40px 26px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A">WELCOME ABOARD</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:11px"><tr><td width="24" height="3" bgcolor="#C42408" style="background:#C42408;font-size:0;line-height:0">&nbsp;</td></tr></table>
<div style="font-size:17px;line-height:1.55;color:#63636A;padding:20px 0 4px">Hi [[NAME]],</div>
<div class="h1" style="font-size:44px;line-height:1.04;font-weight:800;letter-spacing:-0.04em">Your calling list<br>is ready.</div></td></tr>
<tr><td class="pad" style="padding:0 40px 26px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F4EFE9" style="background:#F4EFE9;border-top:2px solid #0A0A0C;border-bottom:2px solid #0A0A0C"><tr><td align="center" style="padding:26px 20px 24px">
<div style="[[MONO]]font-size:10px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:10px">YOUR ACCESS CODE</div>
<div class="num" style="[[MONO]]font-size:36px;line-height:1.15;font-weight:700;letter-spacing:0.08em;color:#0A0A0C">[[CODE]]</div>
<div style="font-size:13px;line-height:1.5;color:#63636A;padding-top:12px">Sign in with <span style="[[MONO]]font-size:12px;color:#0A0A0C">[[EMAIL]]</span></div>
</td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#C42408" style="background:#C42408"><a class="btn" href="[[LIST_URL]]" style="display:block;padding:19px 18px;font-size:20px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Open your list &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:0 40px 30px;font-size:14px;line-height:1.55;color:#63636A">Keep the code to yourself. Once you are in, the page remembers you on that device, and it works on your phone.</td></tr>
<tr><td class="pad" style="padding:0 40px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C"><tr><td style="padding-top:22px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A;padding-bottom:14px">HOW THE PAGE WORKS</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:16px;line-height:1.55">
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 11px 0">01</td><td style="padding-bottom:11px">One lead at a time, with the number to ring and the script beside it.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 11px 0">02</td><td style="padding-bottom:11px">One button for what happened on the call. Nothing else to fill in.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:15px;font-weight:700;color:#C42408;padding:3px 14px 0 0">03</td><td>If the prospect says yes, book the discovery call right there, while you still have them on the phone.</td></tr>
</table></td></tr></table></td></tr>
<tr><td class="pad" style="padding:0 40px 34px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C"><tr><td style="padding-top:20px;font-size:17px;line-height:1.55">Glad to have you.<br><b>[[SIGNER]]</b><br><span style="[[MONO]]font-size:12px;letter-spacing:0.12em;color:#63636A">FOUNDER &middot; AVIANCE</span></td></tr></table></td></tr>$s$;

  html := $s$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviance</title>
<style>@media (max-width:480px){.h1{font-size:34px!important}.big{font-size:40px!important}.num{font-size:52px!important}.fig{font-size:44px!important}.pad{padding-left:22px!important;padding-right:22px!important}.btn{font-size:18px!important}.datebox{width:112px!important}}</style></head>
<body style="margin:0;padding:0;background:#F6F7F9"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F9"><tr><td align="center" style="padding:22px 0 26px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:'Inter Tight',Arial,Helvetica,sans-serif;color:#0A0A0C">
<tr><td class="pad" style="padding:16px 40px;border-bottom:2px solid #0A0A0C"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td><img src="https://www.aviance.online/logo-180.png" width="44" height="44" alt="Aviance" style="vertical-align:middle;border:0"><span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;vertical-align:middle;padding-left:10px">Aviance</span></td>
<td align="right"><span style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;[[TAGSTYLE]];padding:7px 10px;white-space:nowrap">[[TAG]]</span></td></tr></table></td></tr>
[[BODY]]
<tr><td class="pad" bgcolor="#0A0A0C" style="background:#0A0A0C;padding:22px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:14px;line-height:1.5;color:#FFFFFF">[[FOOT]]</td>
<td align="right" valign="middle"><a href="https://www.aviance.online" style="[[MONO]]font-size:11px;letter-spacing:0.16em;color:#DCDCE0;text-decoration:none">AVIANCE.ONLINE</a></td></tr></table></td></tr>
</table></td></tr></table></body></html>$s$;

  html := replace(html, '[[BODY]]', body);
  html := replace(html, '[[MONO]]', mono);
  html := replace(html, '[[TAG]]', 'CALLER ACCESS');
  html := replace(html, '[[TAGSTYLE]]', 'border:2px solid #0A0A0C;color:#0A0A0C');
  html := replace(html, '[[FOOT]]', 'Any trouble getting in? Just reply.');
  html := replace(html, '[[NAME]]',     public.esc_html(v_first));
  html := replace(html, '[[SIGNER]]',   public.esc_html(v_signer));
  html := replace(html, '[[EMAIL]]',    public.esc_html(s.email));
  html := replace(html, '[[CODE]]',     public.esc_html(v_code));
  html := replace(html, '[[LIST_URL]]', public.esc_html(v_url));

  txt := 'Hi ' || v_first || E',\n\n'
      || E'Welcome aboard. Your calling list is ready.\n\n'
      || E'Open it here:\n' || v_url || E'\n\n'
      || 'Sign in with ' || s.email || E' and this access code:\n\n'
      || '    ' || v_code || E'\n\n'
      || E'Keep the code to yourself. Once you are in, the page remembers you on that device, and it works on your phone.\n\n'
      || E'How the page works:\n'
      || E'1. One lead at a time, with the number to ring and the script beside it.\n'
      || E'2. One button for what happened on the call. Nothing else to fill in.\n'
      || E'3. If the prospect says yes, book the discovery call right there, while you still have them on the phone.\n\n'
      || E'Any trouble getting in? Just reply to this email.\n\n'
      || 'Glad to have you.' || E'\n' || v_signer || E'\nFounder, Aviance\n';

  insert into public.mail_outbox (to_email, to_name, subject, body_text, body_html, kind)
  values (s.email, s.name, 'Welcome to Aviance — your calling list is ready', txt, html, 'staff_invite')
  returning id into v_mail;
  return jsonb_build_object('mail_id', v_mail, 'to', s.email);
end
$fn$;


-- 7. staff_invite_mail_core: the employee's 'open your channel'. Same house as the
--    caller's mail but a different shape -- the channel leads, and the sign-in details
--    sit in a numbered rule stack rather than a credential block.
create or replace function public.staff_invite_mail_core(p_staff uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  s        public.staff;
  v_code   text := btrim(coalesce(p_code, ''));
  v_first  text;
  v_signer text := coalesce(nullif(btrim(coalesce(public.biz('signer_name'), '')), ''),
                            (select nullif(btrim(p.name), '') from public.profiles p where p.id = public.aviance_owner()),
                            'Limethsith');
  v_site   text := coalesce(nullif(btrim(public.biz('site')), ''), 'https://aviance.store');
  v_team   text;
  mono text := $s$font-family:'JetBrains Mono','Courier New',Courier,monospace;$s$;
  body text; html text; txt text; v_mail uuid;
begin
  if not (public.is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'Only Aviance can send an invite.';
  end if;
  select * into s from public.staff where id = p_staff;
  if not found then raise exception 'That employee is not here any more.'; end if;
  if v_code = '' then raise exception 'The access code is missing.'; end if;
  v_team  := rtrim(v_site, '/') || '/team';
  v_first := coalesce(nullif(split_part(btrim(s.name), ' ', 1), ''), 'there');

  body := $s$<tr><td class="pad" style="padding:38px 40px 26px">
<div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A">WELCOME TO THE TEAM</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:11px"><tr><td width="24" height="3" bgcolor="#C42408" style="background:#C42408;font-size:0;line-height:0">&nbsp;</td></tr></table>
<div style="font-size:17px;line-height:1.55;color:#63636A;padding:20px 0 4px">Hi [[NAME]],</div>
<div class="h1" style="font-size:44px;line-height:1.04;font-weight:800;letter-spacing:-0.04em">Open your<br>channel.</div>
<div style="font-size:17px;line-height:1.55;color:#0A0A0C;padding-top:22px">It is your direct line to [[SIGNER]]. Ask anything, send files, and anything you need from me will be waiting for you there.</div></td></tr>
<tr><td class="pad" style="padding:0 40px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#C42408" style="background:#C42408"><a class="btn" href="[[TEAM_URL]]" style="display:block;padding:19px 18px;font-size:20px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Open your channel &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:0 40px 30px;font-size:14px;line-height:1.55;color:#63636A">Nothing to install, and it works on your phone.</td></tr>
<tr><td class="pad" style="padding:0 40px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C">
<tr><td colspan="2" style="padding:14px 0 12px"><div style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;color:#63636A">HOW TO GET IN</div></td></tr>
<tr><td valign="top" width="42" style="padding:12px 0 11px;border-top:1px solid #DCDCE0;[[MONO]]font-size:15px;font-weight:700;color:#C42408">01</td>
<td valign="top" style="padding:12px 0 11px;border-top:1px solid #DCDCE0;font-size:16px;line-height:1.55">Sign in with this email address<br><span style="[[MONO]]font-size:14px;font-weight:700;color:#0A0A0C">[[EMAIL]]</span></td></tr>
<tr><td valign="top" style="padding:12px 0 11px;border-top:1px solid #DCDCE0;border-bottom:2px solid #0A0A0C;[[MONO]]font-size:15px;font-weight:700;color:#C42408">02</td>
<td valign="top" style="padding:12px 0 11px;border-top:1px solid #DCDCE0;border-bottom:2px solid #0A0A0C;font-size:16px;line-height:1.55">Paste this access code<br><span style="[[MONO]]font-size:26px;font-weight:700;letter-spacing:0.08em;color:#0A0A0C">[[CODE]]</span></td></tr>
</table></td></tr>
<tr><td class="pad" style="padding:0 40px 30px;font-size:14px;line-height:1.55;color:#63636A">Keep the code to yourself. Once you are in, the page remembers you on that device.</td></tr>
<tr><td class="pad" style="padding:0 40px 34px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #0A0A0C"><tr><td style="padding-top:20px;font-size:17px;line-height:1.55">Glad to have you.<br><b>[[SIGNER]]</b><br><span style="[[MONO]]font-size:12px;letter-spacing:0.12em;color:#63636A">FOUNDER &middot; AVIANCE</span></td></tr></table></td></tr>$s$;

  html := $s$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviance</title>
<style>@media (max-width:480px){.h1{font-size:34px!important}.big{font-size:40px!important}.num{font-size:52px!important}.fig{font-size:44px!important}.pad{padding-left:22px!important;padding-right:22px!important}.btn{font-size:18px!important}.datebox{width:112px!important}}</style></head>
<body style="margin:0;padding:0;background:#F6F7F9"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F9"><tr><td align="center" style="padding:22px 0 26px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:'Inter Tight',Arial,Helvetica,sans-serif;color:#0A0A0C">
<tr><td class="pad" style="padding:16px 40px;border-bottom:2px solid #0A0A0C"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td><img src="https://www.aviance.online/logo-180.png" width="44" height="44" alt="Aviance" style="vertical-align:middle;border:0"><span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;vertical-align:middle;padding-left:10px">Aviance</span></td>
<td align="right"><span style="[[MONO]]font-size:11px;font-weight:700;letter-spacing:0.16em;[[TAGSTYLE]];padding:7px 10px;white-space:nowrap">[[TAG]]</span></td></tr></table></td></tr>
[[BODY]]
<tr><td class="pad" bgcolor="#0A0A0C" style="background:#0A0A0C;padding:22px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:14px;line-height:1.5;color:#FFFFFF">[[FOOT]]</td>
<td align="right" valign="middle"><a href="https://www.aviance.online" style="[[MONO]]font-size:11px;letter-spacing:0.16em;color:#DCDCE0;text-decoration:none">AVIANCE.ONLINE</a></td></tr></table></td></tr>
</table></td></tr></table></body></html>$s$;

  html := replace(html, '[[BODY]]', body);
  html := replace(html, '[[MONO]]', mono);
  html := replace(html, '[[TAG]]', 'TEAM ACCESS');
  html := replace(html, '[[TAGSTYLE]]', 'border:2px solid #0A0A0C;color:#0A0A0C');
  html := replace(html, '[[FOOT]]', 'Any trouble getting in? Just reply.');
  html := replace(html, '[[NAME]]',     public.esc_html(v_first));
  html := replace(html, '[[SIGNER]]',   public.esc_html(v_signer));
  html := replace(html, '[[EMAIL]]',    public.esc_html(s.email));
  html := replace(html, '[[CODE]]',     public.esc_html(v_code));
  html := replace(html, '[[TEAM_URL]]', public.esc_html(v_team));

  txt := 'Hi ' || v_first || E',\n\n'
      || E'Welcome to the team. Open your channel.\n\n'
      || 'It is your direct line to ' || v_signer
      || E'. Ask anything, send files, and anything you need from me will be waiting for you there.\n\n'
      || E'Open your channel:\n' || v_team || E'\n\n'
      || E'How to get in:\n'
      || '1. Sign in with this email address: ' || s.email || E'\n'
      || '2. Paste this access code: ' || v_code || E'\n\n'
      || E'Keep the code to yourself. Once you are in, the page remembers you on that device.\n\n'
      || E'Any trouble getting in? Just reply to this email.\n\n'
      || 'Glad to have you.' || E'\n' || v_signer || E'\nFounder, Aviance\n';

  insert into public.mail_outbox (to_email, to_name, subject, body_text, body_html, kind)
  values (s.email, s.name, 'Welcome to Aviance — open your channel', txt, html, 'staff_invite')
  returning id into v_mail;

  return jsonb_build_object('mail_id', v_mail, 'to', s.email);
end
$fn$;


-- 8. queue_meeting_confirmation: unchanged in what it does, but the HTML edit now goes
--    through the slot markers instead of matching the headline text. The old version
--    looked for "You''re booked in." in the HTML, where the apostrophe is written
--    &rsquo; -- so it never matched and a kickoff mail kept the discovery headline
--    while the subject said Kickoff.
--    The plain-text body is fixed the same way it was always meant to be: each prep
--    sentence is swapped on its own, so a kickoff keeps step 03 instead of ending at
--    step 02. Text and HTML now carry the same three steps and the same headline.
create or replace function public.queue_meeting_confirmation()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare v_what text; v_prep text; v_head text; v_headtxt text; v_eye text; v_p3 text;
begin
  if new.status = 'booked' and new.starts_at > now()
     and coalesce(btrim(new.guest_email),'') ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    perform public.queue_call_mail('booking_confirmation', new.guest_email, new.guest_name, new.starts_at,
                                   coalesce(new.time_zone, 'America/New_York'), null, new.id, new.client_id);
    v_what := case when coalesce(new.title, '') like 'Kickoff%' then 'Kickoff'
                   when coalesce(new.title, '') like 'Onboarding call%' then 'Onboarding call' end;
    if v_what is not null or coalesce(new.minutes, 30) <> 30 then
      v_prep := case v_what
        when 'Kickoff' then 'Answer the 4 quick questions in your channel, so we use the time well.'
        when 'Onboarding call' then 'We will walk you through the test results and the launch plan.'
        else null end;
      v_head := case when v_what is null then 'You&rsquo;re booked in.'
                     else 'Your ' || lower(v_what) || ' is booked.' end;
      v_headtxt := case when v_what is null then 'You''re booked in.'
                     else 'Your ' || lower(v_what) || ' is booked.' end;
      v_eye  := case when v_what is null then 'YOUR CALL IS CONFIRMED'
                     else upper(v_what) || ' CONFIRMED' end;
      v_p3   := case v_what
        when 'Kickoff' then 'Have one or two of your best customers in mind. We build your target profile from them.'
        when 'Onboarding call' then 'Bring any last questions. After this call we launch.'
        else 'Know what one new customer is worth to you.' end;
      update public.mail_outbox mo set
        subject = case when v_what is null then mo.subject else replace(mo.subject, 'You''re booked in:', v_what || ' booked:') end,
        -- each prep sentence is swapped on its own, so step 03 survives a kickoff.
        -- Replacing lines 2 and 3 together with a single line was what dropped step 03
        -- from the text part while the HTML kept all three.
        body_text = replace(replace(replace(replace(mo.body_text,
                      ', 30 minutes.', ', ' || coalesce(new.minutes, 30) || ' minutes.'),
                      'Think about who your best customers are.', coalesce(v_prep, 'Think about who your best customers are.')),
                      'Know what one new customer is worth to you.', v_p3),
                      'You''re booked in.', v_headtxt),
        body_html = public.mail_slot(
                      public.mail_slot(
                        public.mail_slot(
                          public.mail_slot(
                            public.mail_slot(mo.body_html, 'MINS', coalesce(new.minutes, 30) || ' minutes'),
                          'HEAD', v_head),
                        'EYE', v_eye),
                      'P2', coalesce(v_prep, 'Think about who your best customers are.')),
                    'P3', v_p3)
       where mo.meeting_id = new.id and mo.kind = 'booking_confirmation' and mo.status = 'pending';
    end if;
  end if;
  return new;
end
$fn$;
