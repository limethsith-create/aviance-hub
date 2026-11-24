-- ============================================================================
-- 20261124_rehearsal_fixes.sql — fixes from the owner-side dress rehearsal.
--
--   1. History. close_won, mark_paid and doc_sign now write client_events rows,
--      so a client's page says what happened to them:
--        close_won  -> client/won, agreement/sent, invoice/sent
--        mark_paid  -> invoice/paid (+ email/welcome_sent the first time)
--        doc_sign   -> agreement/signed
--      Every row carries detail.words: the sentence the client page shows.
--   2. invoice_link(p_invoice) and agreement_link(p_client): the signed doc.html
--      link for the owner to open. Admin only.
--   3. resend_pack(p_client): queue the agreement + invoice email again, with
--      fresh links. Admin only.
--   4. discovery_bookings joins the realtime publication, so the Calendar hears
--      a new website booking the moment it lands (RLS still decides who sees it).
--
-- Everything is `create or replace`; the bodies of close_won / mark_paid /
-- doc_sign are the live ones with only the event lines added.
-- ============================================================================

-- ---------------------------------------------------------------- close_won
create or replace function public.close_won(p_booking uuid, p_plan text, p_term text default 'monthly'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  b public.discovery_bookings; pp public.plan_prices; c public.clients; per public.client_people;
  ch public.channels; ag public.client_agreements; inv public.invoices;
  v_term text := coalesce(nullif(btrim(p_term),''),'monthly'); v_fee integer; v_gross integer; v_credit integer := 0;
  v_pilot integer := 0; v_site text := rtrim(public.biz('site'),'/'); v_label text; m jsonb;
begin
  if not public.is_admin() then raise exception 'Only the owner can mark a call won.'; end if;
  select * into b from public.discovery_bookings where id = p_booking for update;
  if not found then raise exception 'That call is not on the calendar any more.'; end if;
  if exists (select 1 from public.clients where booking_id = p_booking) then raise exception 'That call is already a client.'; end if;
  select * into pp from public.plan_prices where plan = lower(btrim(coalesce(p_plan,'')));
  if not found then raise exception 'Pick a plan first: Pilot, Starter, Growth or Scale.'; end if;
  if v_term not in ('monthly','3month') then raise exception 'The term is either monthly or 3 months.'; end if;
  if not pp.is_recurring or coalesce(pp.three_month_fee,0) = 0 then v_term := 'monthly'; end if;
  if coalesce(btrim(b.email),'') !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'That booking has no email address to send the pack to.'; end if;
  v_fee := case when v_term = '3month' then pp.three_month_fee else pp.monthly_fee end;

  if pp.plan <> 'pilot' then
    select coalesce(max(o.monthly_fee),0) into v_pilot from public.clients o
     where lower(o.contact_email) = lower(b.email) and o.plan = 'pilot' and o.created_at > now() - interval '60 days'
       and exists (select 1 from public.invoices x where x.client_id = o.id and x.status = 'paid');
  end if;

  insert into public.clients(booking_id, company, contact_name, contact_email, website, plan, term, calls_promised, monthly_fee, stage, pilot_credit, owner_id)
  values (b.id, left(b.company,200), left(b.name,160), left(b.email,200), left(b.website,300), pp.plan, v_term, pp.calls_promised, v_fee, 'won', v_pilot, auth.uid())
  returning * into c;

  insert into public.client_people(client_id, full_name, email, phone, role, is_primary, timezone)
  values (c.id, c.contact_name, c.contact_email, b.phone, b.role, true, b.timezone) returning * into per;

  insert into public.channels(name, purpose, kind, client_id, created_by)
  values (c.company, 'Your direct line to the Aviance team', 'client', c.id, auth.uid()) returning * into ch;
  insert into public.channel_members(channel_id, user_id, member_role) values (ch.id, auth.uid(), 'owner');
  insert into public.channel_members(channel_id, person_id) values (ch.id, per.id);

  v_gross  := v_fee * (case when v_term = '3month' then 3 else 1 end);
  v_credit := least(c.pilot_credit, v_gross);
  if v_credit > 0 then update public.clients set pilot_credit_used = true where id = c.id; end if;
  v_label := pp.label || ' · ' || pp.calls_promised || ' qualified calls' ||
             case when v_term = '3month' then ' a month · 3 months' when pp.is_recurring then ' · month 1' else '' end;

  insert into public.invoices(client_id, month_id, number, gross_amount, pilot_credit, amount, issued_on, due_on, status, sent_at, notes, is_first)
  values (c.id, null, 'AV-' || to_char(now(),'YYYY') || '-' || nextval('public.invoice_no_seq'),
          v_gross, v_credit, v_gross - v_credit, current_date, current_date + 7, 'sent', now(), v_label, true)
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

-- ---------------------------------------------------------------- mark_paid
create or replace function public.mark_paid(p_invoice uuid, p_via text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  inv public.invoices; c public.clients; per public.client_people; ag public.client_agreements;
  raw text; v_site text := rtrim(public.biz('site'),'/'); m jsonb; v_welcome boolean := false;
begin
  if not public.is_admin() then raise exception 'Only the owner can mark an invoice paid.'; end if;
  select * into inv from public.invoices where id = p_invoice for update;
  if not found then raise exception 'That invoice is not here any more.'; end if;
  if inv.status = 'paid' then raise exception 'That invoice is already marked paid.'; end if;
  if inv.status = 'void' then raise exception 'That invoice was cancelled, so it cannot be paid.'; end if;

  update public.invoices set status = 'paid', paid_at = now(), paid_via = left(btrim(coalesce(p_via,'')), 60)
   where id = inv.id returning * into inv;
  select * into c from public.clients where id = inv.client_id;

  insert into public.client_events(client_id, area, event, detail)
  values (c.id, 'invoice', 'paid', jsonb_build_object(
    'words', 'Invoice ' || coalesce(inv.number,'') || ' paid: $' || to_char(inv.amount, 'FM999,999,990') ||
             case when coalesce(inv.paid_via,'') <> '' then ' by ' || inv.paid_via else '' end || '.',
    'invoice_id', inv.id, 'number', inv.number, 'amount', inv.amount));

  if inv.is_first and not exists (select 1 from public.portal_invites where client_id = c.id and status in ('pending','accepted')) then
    select * into per from public.client_people where client_id = c.id order by is_primary desc, created_at limit 1;
    if not found then
      insert into public.client_people(client_id, full_name, email, is_primary) values (c.id, c.contact_name, c.contact_email, true) returning * into per;
    end if;
    raw := encode(extensions.gen_random_bytes(24), 'hex');
    insert into public.portal_invites(client_id, person_id, email, token_hash)
    values (c.id, per.id, lower(coalesce(nullif(btrim(per.email),''), c.contact_email)), public.invite_hash(raw));

    select * into ag from public.client_agreements where client_id = c.id and status <> 'void' order by created_at desc limit 1;
    m := public.mail_welcome(c.id,
           v_site || '/join.html#' || raw,
           case when ag.id is null then v_site else v_site || '/doc.html#' || public.doc_token('a', ag.id) end,
           v_site || '/doc.html#' || public.doc_token('i', inv.id),
           public.biz('kickoff_link'));
    insert into public.mail_outbox(to_email, to_name, subject, body_text, body_html, kind, client_id, needs_meet_link)
    values (c.contact_email, c.contact_name, m->>'subject', m->>'text', m->>'html', 'portal_invite', c.id, false);
    update public.clients set stage = 'onboarding' where id = c.id and stage = 'won';
    v_welcome := true;

    insert into public.client_events(client_id, area, event, detail)
    values (c.id, 'email', 'welcome_sent', jsonb_build_object(
      'words', 'Welcome email sent to ' || lower(coalesce(nullif(btrim(per.email),''), c.contact_email)) || ', with their way in to the portal.'));
  end if;

  return jsonb_build_object('invoice_id', inv.id, 'client_id', c.id, 'welcome_sent', v_welcome);
end $function$;

-- ---------------------------------------------------------------- doc_sign
create or replace function public.doc_sign(p_token text, p_name text, p_agent text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v uuid := public.doc_id(p_token, 'a'); ag public.client_agreements; v_name text := btrim(coalesce(p_name,''));
begin
  if v is null then raise exception 'This link is not valid.'; end if;
  if char_length(v_name) < 3 or char_length(v_name) > 160 then raise exception 'Type your full name to sign.'; end if;
  update public.client_agreements set status = 'signed', signed_name = v_name, signed_at = now(), signed_agent = left(coalesce(p_agent,''), 400)
   where id = v and status = 'sent' returning * into ag;
  if not found then
    select * into ag from public.client_agreements where id = v;
    if not found then raise exception 'This link is not valid.'; end if;
    if ag.status = 'signed' then raise exception 'This agreement has already been signed.'; end if;
    raise exception 'This agreement is no longer open for signing.';
  end if;
  insert into public.client_events(client_id, area, event, detail)
  values (ag.client_id, 'agreement', 'signed', jsonb_build_object(
    'words', 'Agreement signed by ' || v_name || '.', 'agreement_id', ag.id, 'signed_name', v_name));
  return public.doc_get(p_token);
end $function$;

-- ---------------------------------------------------------------- links for the owner
create or replace function public.invoice_link(p_invoice uuid)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_admin() then raise exception 'Only the owner can open an invoice link.'; end if;
  if not exists (select 1 from public.invoices where id = p_invoice) then raise exception 'That invoice is not here any more.'; end if;
  return rtrim(public.biz('site'),'/') || '/doc.html#' || public.doc_token('i', p_invoice);
end $function$;

create or replace function public.agreement_link(p_client uuid)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare v uuid;
begin
  if not public.is_admin() then raise exception 'Only the owner can open an agreement link.'; end if;
  select id into v from public.client_agreements where client_id = p_client and status <> 'void' order by created_at desc limit 1;
  if v is null then raise exception 'This client has no agreement yet.'; end if;
  return rtrim(public.biz('site'),'/') || '/doc.html#' || public.doc_token('a', v);
end $function$;

-- ---------------------------------------------------------------- resend the pack
create or replace function public.resend_pack(p_client uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  c public.clients; ag public.client_agreements; inv public.invoices;
  v_site text := rtrim(public.biz('site'),'/'); m jsonb;
begin
  if not public.is_admin() then raise exception 'Only the owner can send the pack again.'; end if;
  select * into c from public.clients where id = p_client;
  if not found then raise exception 'That client is not in the book.'; end if;
  if coalesce(btrim(c.contact_email),'') !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'This client has no email address to send the pack to.'; end if;
  select * into ag from public.client_agreements where client_id = c.id and status <> 'void' order by created_at desc limit 1;
  if ag.id is null then raise exception 'This client has no agreement to send.'; end if;
  -- mail_pack names the newest invoice, so the link must be to that same one
  select * into inv from public.invoices where client_id = c.id order by created_at desc limit 1;
  if inv.id is null then raise exception 'This client has no invoice to send.'; end if;
  if inv.status = 'void' then raise exception 'Their newest invoice was cancelled, so there is nothing to send.'; end if;

  m := public.mail_pack(c.id, v_site || '/doc.html#' || public.doc_token('a', ag.id), v_site || '/doc.html#' || public.doc_token('i', inv.id));
  insert into public.mail_outbox(to_email, to_name, subject, body_text, body_html, kind, client_id, needs_meet_link)
  values (c.contact_email, c.contact_name, m->>'subject', m->>'text', m->>'html', 'agreement', c.id, false);

  insert into public.client_events(client_id, area, event, detail)
  values (c.id, 'agreement', 'resent', jsonb_build_object(
    'words', 'Agreement and invoice ' || coalesce(inv.number,'') || ' sent again to ' || c.contact_email || '.',
    'invoice_id', inv.id, 'agreement_id', ag.id));

  return jsonb_build_object('client_id', c.id, 'email', c.contact_email, 'invoice_number', inv.number, 'invoice_id', inv.id);
end $function$;

revoke all on function public.invoice_link(uuid)   from public, anon;
revoke all on function public.agreement_link(uuid) from public, anon;
revoke all on function public.resend_pack(uuid)    from public, anon;
grant execute on function public.invoice_link(uuid)   to authenticated;
grant execute on function public.agreement_link(uuid) to authenticated;
grant execute on function public.resend_pack(uuid)    to authenticated;

-- ---------------------------------------------------------------- realtime
do $$
begin
  alter publication supabase_realtime add table public.discovery_bookings;
exception when duplicate_object then null;
end $$;
