-- The invite email for a new employee: one branded message, a big "Open your channel" button, and her
-- access code just under it. Sent through the ordinary mail room (mail_outbox -> mail-tick -> Gmail), the
-- same path as the booking confirmations and reminders, so it looks like everything else Aviance sends.
--
-- The code is in the email on purpose: only she can open her inbox, and it means one message instead of two.
-- Once the message has gone, the stored copy has the code blanked out (mail_outbox_scrub below), so the code
-- lives in her inbox and nowhere else.

create or replace function public.staff_invite_mail(p_staff uuid, p_code text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
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

  body := $s$<tr><td class="pad" bgcolor="#000000" style="background:#000000;padding:52px 40px 48px">
<div style="font-size:20px;color:#BDBDBD;padding-bottom:18px">Hi [[NAME]],</div>
<div class="h1" style="font-size:84px;line-height:0.96;font-weight:800;letter-spacing:-0.04em;color:#FFFFFF">Welcome<br>to the<br>team<span style="color:#E0290F">.</span></div></td></tr>
<tr><td class="pad" style="padding:32px 40px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#E0290F" style="background:#E0290F"><a class="btn" href="[[TEAM_URL]]" style="display:block;padding:26px 20px;font-size:26px;font-weight:800;letter-spacing:-0.01em;color:#FFFFFF;text-decoration:none">Open your channel &rarr;</a></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:18px 40px 6px;font-size:16px;line-height:1.5;color:#5C5C5C">Sign in with this email address and the code below.</td></tr>
<tr><td class="pad" align="center" style="padding:0 40px 10px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" style="border:2px solid #000000;padding:18px 28px"><div style="[[MONO]]font-size:12px;font-weight:700;letter-spacing:0.16em;color:#5C5C5C;padding-bottom:8px">YOUR ACCESS CODE</div><div style="[[MONO]]font-size:34px;font-weight:700;letter-spacing:0.06em;color:#000000">[[CODE]]</div></td></tr></table></td></tr>
<tr><td class="pad" align="center" style="padding:6px 40px 28px;font-size:15px;line-height:1.5;color:#5C5C5C">Keep this code to yourself. Once you are in, the page remembers you on that device.</td></tr>
<tr><td class="pad" style="padding:28px 40px 36px;border-top:2px solid #000000">
<div style="font-size:18px;line-height:1.5;padding-bottom:24px">That channel is your direct line to [[SIGNER]]. Ask anything, send files, and anything you need from me will be waiting for you there.</div>
<div style="[[MONO]]font-size:12px;font-weight:700;letter-spacing:0.16em;color:#5C5C5C;padding-bottom:16px">HOW TO GET IN</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:18px;line-height:1.45">
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 14px 0">01</td><td style="padding-bottom:14px">Tap <b>Open your channel</b> above.</td></tr>
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 14px 0">02</td><td style="padding-bottom:14px">Type this email address: <b>[[EMAIL]]</b></td></tr>
<tr><td valign="top" style="[[MONO]]font-size:22px;font-weight:700;color:#E0290F;padding:0 16px 0 0">03</td><td>Paste the code and you are in. Nothing to install, and it works on your phone.</td></tr>
</table>
<div style="font-size:18px;line-height:1.5;padding-top:32px">Glad to have you.<br><b>[[SIGNER]], Founder</b><br><span style="color:#5C5C5C">Aviance</span></div></td></tr>$s$;

  html := $s$<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviance</title>
<style>@media (max-width:480px){.h1{font-size:52px!important}.pad{padding-left:22px!important;padding-right:22px!important}.btn{font-size:22px!important}}</style></head>
<body style="margin:0;padding:0;background:#F2F2F2"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F2F2"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;font-family:'Inter Tight',Arial,Helvetica,sans-serif;color:#000000">
<tr><td class="pad" style="padding:18px 40px;border-bottom:2px solid #000000"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td><img src="https://www.aviance.online/logo-180.png" width="44" height="44" alt="" style="vertical-align:middle;border:0"><span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;vertical-align:middle;padding-left:10px">Aviance</span></td>
<td align="right"><span style="[[MONO]]font-size:13px;font-weight:700;letter-spacing:0.12em;background:#E0290F;color:#FFFFFF;padding:8px 12px">WELCOME</span></td></tr></table></td></tr>
[[BODY]]
<tr><td class="pad" bgcolor="#000000" style="background:#000000;padding:26px 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:15px;color:#FFFFFF">Any trouble getting in? Just reply.</td>
<td align="right"><a href="https://www.aviance.online" style="[[MONO]]font-size:12px;letter-spacing:0.1em;color:#BDBDBD;text-decoration:none">AVIANCE.ONLINE</a></td></tr></table></td></tr>
</table></td></tr></table></body></html>$s$;

  html := replace(html, '[[BODY]]', body);
  html := replace(html, '[[MONO]]', mono);
  -- her name, her email, the code and the settings are all text we put in HTML, so escape every one
  html := replace(html, '[[NAME]]',     replace(replace(replace(v_first, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[SIGNER]]',   replace(replace(replace(v_signer, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[EMAIL]]',    replace(replace(replace(s.email, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[CODE]]',     replace(replace(replace(v_code, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'));
  html := replace(html, '[[TEAM_URL]]', replace(replace(replace(replace(v_team, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'));

  txt := 'Hi ' || v_first || E',\n\n'
      || E'Welcome to the team.\n\n'
      || E'Open your channel:\n' || v_team || E'\n\n'
      || 'Sign in with ' || s.email || E' and this access code:\n\n'
      || '    ' || v_code || E'\n\n'
      || E'Keep the code to yourself. Once you are in, the page remembers you on that device.\n\n'
      || 'That channel is your direct line to ' || v_signer
      || E'. Ask anything, send files, and anything you need from me will be waiting for you there.\n\n'
      || E'Any trouble getting in? Just reply to this email.\n\n'
      || 'Glad to have you.' || E'\n' || v_signer || E', Founder\nAviance\n';

  insert into public.mail_outbox (to_email, to_name, subject, body_text, body_html, kind)
  values (s.email, s.name, 'Welcome to Aviance — open your channel', txt, html, 'staff_invite')
  returning id into v_mail;

  return jsonb_build_object('mail_id', v_mail, 'to', s.email);
end $fn$;

revoke all on function public.staff_invite_mail(uuid, text) from public, anon;
grant execute on function public.staff_invite_mail(uuid, text) to authenticated, service_role;

-- Once it is sent, the stored copy keeps no credential: the code lives in her inbox only.
create or replace function public.mail_outbox_scrub() returns trigger language plpgsql as $$
begin
  if new.status = 'sent' and new.kind = 'portal_invite' then
    new.body_text := regexp_replace(new.body_text, 'join\.html#[0-9a-f]{48}', 'join.html#(hidden once sent)', 'g');
    new.body_html := regexp_replace(new.body_html, 'join\.html#[0-9a-f]{48}', 'join.html#(hidden once sent)', 'g');
  end if;
  if new.status = 'sent' and new.kind = 'staff_invite' then
    new.body_text := regexp_replace(new.body_text, 'AVX-[A-Z0-9]{4}-[A-Z0-9]{4}', 'AVX-(hidden once sent)', 'g');
    new.body_html := regexp_replace(new.body_html, 'AVX-[A-Z0-9]{4}-[A-Z0-9]{4}', 'AVX-(hidden once sent)', 'g');
  end if;
  return new;
end $$;
drop trigger if exists mail_outbox_scrub on public.mail_outbox;
create trigger mail_outbox_scrub before update on public.mail_outbox
  for each row execute function public.mail_outbox_scrub();

-- mail_outbox only allows known kinds, so let the new one in
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'mail_outbox_kind_check'
             and conrelid = 'public.mail_outbox'::regclass
             and pg_get_constraintdef(oid) not like '%staff_invite%') then
    alter table public.mail_outbox drop constraint mail_outbox_kind_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mail_outbox_kind_check'
                 and conrelid = 'public.mail_outbox'::regclass) then
    alter table public.mail_outbox add constraint mail_outbox_kind_check
      check (kind = any (array['booking_confirmation','reminder_24h','reminder_1h','reminder_5min',
                               'agreement','portal_invite','staff_invite','friday_update','handover','other']));
  end if;
end $$;
