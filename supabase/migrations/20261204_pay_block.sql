-- ============================================================================================
-- 20261204_pay_block.sql — how a client is told to pay
--
-- Today Settings holds one free-text "Wise bank details" box and one Payoneer link, and an
-- invoice can show nothing else. This replaces the thin `pay` object on the invoice with a list
-- of methods the owner switches on in Settings. No new code is needed to turn a rail on:
-- bank_wire, wise, payoneer, card_link and paypal are all understood by settings.js and
-- portal-client.js already.
--
-- The research (/home/claude/PAYMENTS.md) settled the rail: an international USD wire into his
-- own Sri Lankan USD account is PRIMARY, Payoneer is the BACKUP, and Wise and Stripe are not
-- available in Sri Lanka at all. So the bank fields here are the fields a US company's bank
-- asks for when wiring abroad — beneficiary, SWIFT, branch address with its country, and the
-- correspondent/intermediary bank. routing/ABA stays, but only as an optional extra for the day
-- there is a US account. The `wise` key is kept because older invoices and the wise_details
-- setting use it; nothing calls it Wise any more.
--
-- NOTHING REAL IS IN THIS FILE. There is no account number, no link and no credential here, and
-- no default pretends to be one. The owner types his own values into Settings.
--
-- What it adds
--   biz('pay_preferred' | 'pay_currency' | 'pay_terms')  three new text settings
--   biz_json(key)        a settings value that is an object, not a line of text
--   pay_block()          {ready, preferred, methods[], currency?, wise_details, payoneer_link}
--   pay_ready()          true as soon as one method can really be paid into
--   biz_get / biz_set    now carry pay_methods (an object), pay_preferred, pay_currency, pay_terms
--   doc_get_core         invoice `pay` is now the rich block; `pay.ready` still true/false, and
--                        pay.wise_details / pay.payoneer_link are still there for older readers
--   mail_pack            the welcome email's "02 Pay the invoice" line now asks pay_ready()
--
-- The shape kept in workspace_admin.data->'business'->'pay_methods':
--   { "bank_wire": { "on": true, "account_holder": "...", "beneficiary_address": "...",
--                    "account_number": "...", "iban": "...", "bank_name": "...", "swift": "...",
--                    "bank_address": "...", "intermediary_bank": "...", "intermediary_swift": "...",
--                    "routing_number": "", "reference": "", "note": "" },
--     "wise": {...},   -- a historic key: to a client, simply a second bank account
--     "payoneer": { "on": true, "link": "https://..." },
--     "paypal": { "on": true, "link": "https://...", "email": "..." },
--     "card_link": { "on": true, "link": "https://..." } }
-- Any method with on<>true, or with every field empty or still [bracketed], is simply not there
-- as far as a client is concerned.
-- ============================================================================================

-- ─────────────────────── 1. the business settings, three keys wider ───────────────────────
-- Unchanged but for pay_preferred / pay_currency / pay_terms at the foot. Every key another
-- file already reads is still here, spelled the same way.
create or replace function public.biz(p_key text) returns text
language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    nullif(btrim((select w.data->'business'->>p_key from public.workspace_admin w where w.id = 1)), ''),
    case p_key
      when 'legal_name'    then '[YOUR COMPANY LEGAL NAME]'
      when 'address'       then '[YOUR COMPANY ADDRESS]'
      when 'email'         then 'aviancelk@gmail.com'
      when 'wise_details'  then '[WISE BANK DETAILS — add in Settings]'
      when 'payoneer_link' then ''
      when 'kickoff_link'  then 'https://www.aviance.online/book'
      when 'site'          then 'https://aviance.store'
      when 'signer_name'   then ''
      when 'phone'         then ''
      when 'pay_preferred' then ''
      when 'pay_currency'  then 'USD'
      when 'pay_terms'     then 'Net 7'
      else '' end);
$$;
revoke execute on function public.biz(text) from public, anon, authenticated;

-- A settings value that is an object rather than a line of text. Anything else reads as {}.
create or replace function public.biz_json(p_key text) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select case when jsonb_typeof(q.v) = 'object' then q.v else '{}'::jsonb end
  from (select (select w.data->'business'->p_key from public.workspace_admin w where w.id = 1) as v) q;
$$;
revoke execute on function public.biz_json(text) from public, anon, authenticated;

-- ─────────────────────── 2. pay_block: how to pay, as a client may see it ───────────────────────
-- Only methods the owner switched on, only fields he really filled in, in a fixed order so the
-- invoice reads the same way every time. A value still in [brackets] is an admin reminder and is
-- dropped. `preferred` is the owner's pick when it is one of the methods that are on, else the
-- first one. `ready` is the question every existing caller asks: can we tell a client how to pay?
create or replace function public.pay_block() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  raw     jsonb := public.biz_json('pay_methods');
  kinds   text[] := array['bank_wire','wise','payoneer','paypal','card_link'];
  -- an international wire TO a bank abroad: beneficiary, SWIFT, branch address, correspondent
  -- bank. routing/ABA is an optional extra for a US account; a Sri Lankan account has none.
  fkeys   text[] := array['account_holder','beneficiary_address','account_number','iban',
                          'bank_name','swift','bank_address','intermediary_bank',
                          'intermediary_swift','routing_number','reference','link','email','note'];
  k text; fk text; m jsonb; f jsonb; val text;
  methods jsonb := '[]'::jsonb;
  have    text[] := '{}';
  pref    text := nullif(btrim(coalesce(public.biz('pay_preferred'), '')), '');
  v_wise  text;
  v_payo  text;
begin
  foreach k in array kinds loop
    m := raw -> k;
    if jsonb_typeof(m) <> 'object' then continue; end if;
    if lower(coalesce(m->>'on', '')) not in ('true','t','1','yes','on') then continue; end if;
    f := '{}'::jsonb;
    foreach fk in array fkeys loop
      val := btrim(coalesce(m->>fk, ''));
      if val = '' or left(val, 1) = '[' then continue; end if;
      f := f || jsonb_build_object(fk, left(val, 400));
    end loop;
    if f = '{}'::jsonb then continue; end if;          -- switched on but nothing filled in
    methods := methods || jsonb_build_array(jsonb_build_object('kind', k, 'fields', f));
    have := have || k;
  end loop;

  if pref is null or not (pref = any (have)) then
    pref := case when coalesce(array_length(have, 1), 0) > 0 then have[1] else null end;
  end if;

  -- the two details the old invoice knew, left exactly as they were for every existing reader
  v_wise := btrim(coalesce(public.biz('wise_details'), ''));
  if v_wise = '' or left(v_wise, 1) = '[' then v_wise := null; end if;
  v_payo := nullif(btrim(coalesce(public.biz('payoneer_link'), '')), '');

  return jsonb_build_object(
    'ready', (jsonb_array_length(methods) > 0 or v_wise is not null or v_payo is not null),
    'preferred', pref,
    'methods', methods,
    'wise_details', v_wise,
    'payoneer_link', coalesce(v_payo, ''));
end $$;
revoke execute on function public.pay_block() from public, anon, authenticated;

create or replace function public.pay_ready() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select coalesce((public.pay_block() ->> 'ready')::boolean, false);
$$;
revoke execute on function public.pay_ready() from public, anon, authenticated;

-- ─────────────────────── 3. Settings reads and writes the new keys ───────────────────────
create or replace function public.biz_get() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'Only the owner can see these settings.'; end if;
  return jsonb_build_object(
    'legal_name', public.biz('legal_name'), 'address', public.biz('address'), 'email', public.biz('email'),
    'wise_details', public.biz('wise_details'), 'payoneer_link', public.biz('payoneer_link'),
    'kickoff_link', public.biz('kickoff_link'), 'site', public.biz('site'),
    'signer_name', public.biz('signer_name'), 'phone', public.biz('phone'),
    'pay_methods', public.biz_json('pay_methods'),
    'pay_preferred', public.biz('pay_preferred'),
    'pay_currency', public.biz('pay_currency'),
    'pay_terms', public.biz('pay_terms'),
    'pay_ready', public.pay_ready());
end $$;

-- pay_methods comes in as an object and is kept as one: unknown methods and unknown fields are
-- dropped, a link has to be https, and every value is trimmed and capped. An error message names
-- the field, never its value.
create or replace function public.biz_set(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  k text; clean jsonb := '{}'::jsonb;
  kinds text[] := array['bank_wire','wise','payoneer','paypal','card_link'];
  fkeys text[] := array['account_holder','beneficiary_address','account_number','iban',
                        'bank_name','swift','bank_address','intermediary_bank',
                        'intermediary_swift','routing_number','reference','link','email','note'];
  mk text; fk text; m jsonb; f jsonb; val text; pm jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then raise exception 'Only the owner can change these settings.'; end if;
  for k in select jsonb_object_keys(coalesce(p, '{}'::jsonb)) loop
    if k = 'pay_methods' then
      if jsonb_typeof(p -> k) <> 'object' then
        raise exception 'The payment methods have to come as a set of methods.';
      end if;
      foreach mk in array kinds loop
        m := (p -> k) -> mk;
        if jsonb_typeof(m) <> 'object' then continue; end if;
        f := jsonb_build_object('on', lower(coalesce(m->>'on','')) in ('true','t','1','yes','on'));
        foreach fk in array fkeys loop
          if not (m ? fk) then continue; end if;
          val := left(btrim(coalesce(m->>fk, '')), 400);
          if fk = 'link' and val <> '' and val !~* '^https://\S+$' then
            raise exception 'A payment link has to start with https://';
          end if;
          f := f || jsonb_build_object(fk, val);
        end loop;
        pm := pm || jsonb_build_object(mk, f);
      end loop;
      clean := clean || jsonb_build_object('pay_methods', pm);
    elsif k = any (array['legal_name','address','email','wise_details','payoneer_link','kickoff_link',
                         'site','signer_name','phone','pay_preferred','pay_currency','pay_terms']) then
      if k in ('payoneer_link','kickoff_link','site') and btrim(coalesce(p->>k,'')) <> '' and (p->>k) !~* '^https://\S+$' then
        raise exception 'Links have to start with https://';
      end if;
      if k = 'pay_preferred' and btrim(coalesce(p->>k,'')) <> '' and not (btrim(p->>k) = any (kinds)) then
        raise exception 'That is not a payment method Aviance knows.';
      end if;
      clean := clean || jsonb_build_object(k, left(btrim(coalesce(p->>k,'')), 2000));
    end if;
  end loop;
  insert into public.workspace_admin(id, data) values (1, jsonb_build_object('business', clean))
  on conflict (id) do update
    set data = public.workspace_admin.data || jsonb_build_object('business', coalesce(public.workspace_admin.data->'business','{}'::jsonb) || clean),
        updated_at = now();
  return public.biz_get();
end $$;
revoke execute on function public.biz_get(), public.biz_set(jsonb) from public, anon;
grant  execute on function public.biz_get(), public.biz_set(jsonb) to authenticated;

-- ─────────────────────── 4. the invoice: pay is now the rich block ───────────────────────
-- Verbatim from 20261129_no_pilot_and_agreement_v3.sql but for the pay block below. `from`
-- (legal_name, email, address, phone) and the agreement's signer name still come from Settings,
-- exactly as they did, and pay.ready is still a plain true/false.
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

      -- How to pay: every method the owner switched on in Settings, with the preferred one
      -- named, the currency and the terms beside them, and the two keys the old invoice
      -- knew kept as they were. pay_block never hands a client a [bracketed] reminder.
      v_pay := public.pay_block() || jsonb_build_object(
                 'currency', upper(coalesce(nullif(btrim(inv.currency), ''), 'USD')),
                 'terms', v_net);
      v_wise := v_pay->>'wise_details';            -- kept so the two older locals still mean something
      v_payo := nullif(v_pay->>'payoneer_link', '');

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

revoke execute on function public.doc_get_core(text) from public, anon, authenticated;

-- ─────────────────────── 5. the welcome email's "02 Pay the invoice" line ───────────────────────
-- Verbatim from 20261129 but for the three lines that decided what to say: it now asks
-- pay_ready(), so switching on any method in Settings changes the email too.
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
  if public.pay_ready() then
    v_howpay := 'The payment details are on it.';
  else
    v_howpay := 'We will send you the payment details directly.';
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

-- ─────────────────────── 6. check ───────────────────────
-- select public.pay_block();                     -- expect ready:false and methods:[] on a fresh workspace
-- select public.pay_ready();
-- select public.biz_get();                       -- owner only: pay_methods, pay_preferred, pay_currency, pay_terms
-- select public.doc_get_core(<a real invoice token>) -> 'pay';
