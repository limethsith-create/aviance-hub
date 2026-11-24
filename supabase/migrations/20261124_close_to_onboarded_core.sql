-- Close to onboarded: the database side.
--   0  hardening found on the way (things a client login must never reach)
--   1  business settings (placeholders until the owner fills them in)
--   2  document links: no token stored at all, the link is signed with a key in the vault
--   3  tables: agreements a client signs, the first invoice, who a login belongs to, hashed invites
--   4  what a client login may see: its own channel and that channel's messages. Nothing else.
--   5  invites: made hashed, peeked by link, used once
--   6  the chain: close_won -> (sign, pay) -> mark_paid -> welcome
-- The wording (agreement_terms, mail_pack, mail_welcome) lives in 20261124_close_pack_templates.sql;
-- the versions here are stand-ins so this file works on its own.

-- ───────────────────────── 0. hardening ─────────────────────────
-- "Approved" now also means "on the team". Approving a client by mistake can no longer open the hub.
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists(select 1 from public.profiles p
                where p.id = auth.uid() and p.approved and p.role in ('admin','employee'));
$$;

-- Four tables were readable by ANY signed-in user. A client login is a signed-in user.
drop policy if exists "team reads bookings" on public.discovery_bookings;
create policy "team reads bookings" on public.discovery_bookings for select to authenticated using (public.is_approved());
drop policy if exists "team reads briefs" on public.research_briefs;
create policy "team reads briefs" on public.research_briefs for select to authenticated using (public.is_approved());
drop policy if exists "team reads log" on public.research_log;
create policy "team reads log" on public.research_log for select to authenticated using (public.is_approved());
drop policy if exists "team reads agreements" on public.agreements;
create policy "team reads agreements" on public.agreements for select to authenticated using (public.is_approved());

-- Views ran with their owner's rights, so they skipped every rule above them. Now they ask as the caller.
alter view public.v_month_standing   set (security_invoker = true);
alter view public.v_exposure         set (security_invoker = true);
alter view public.v_money            set (security_invoker = true);
alter view public.v_invoice_work     set (security_invoker = true);
alter view public.v_outreach_summary set (security_invoker = true);
alter view public.v_mail_to_send     set (security_invoker = true);
alter view public.v_booking_links    set (security_invoker = true);
revoke all on public.v_month_standing, public.v_exposure, public.v_money, public.v_invoice_work,
              public.v_outreach_summary, public.v_mail_to_send, public.v_booking_links from anon;
-- the website still reads the call hours, and only reads them
revoke insert, update, delete, truncate, references, trigger on public.v_call_hours from anon, authenticated;

-- Inner workings nobody should be able to call from a browser.
revoke execute on function public.queue_call_mail(text,text,text,timestamptz,text,uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.queue_due_reminders() from public, anon, authenticated;
revoke execute on function public.aviance_webhook_secret() from public, anon, authenticated;
grant  execute on function public.queue_call_mail(text,text,text,timestamptz,text,uuid,uuid,uuid) to service_role;
grant  execute on function public.queue_due_reminders() to service_role;
grant  execute on function public.aviance_webhook_secret() to service_role;

-- ───────────────────────── 1. business settings ─────────────────────────
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
      else '' end);
$$;
revoke execute on function public.biz(text) from public, anon, authenticated;

create or replace function public.biz_get() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'Only the owner can see these settings.'; end if;
  return jsonb_build_object(
    'legal_name', public.biz('legal_name'), 'address', public.biz('address'), 'email', public.biz('email'),
    'wise_details', public.biz('wise_details'), 'payoneer_link', public.biz('payoneer_link'),
    'kickoff_link', public.biz('kickoff_link'), 'site', public.biz('site'));
end $$;

create or replace function public.biz_set(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare k text; clean jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then raise exception 'Only the owner can change these settings.'; end if;
  for k in select jsonb_object_keys(coalesce(p,'{}'::jsonb)) loop
    if k = any (array['legal_name','address','email','wise_details','payoneer_link','kickoff_link','site']) then
      if k in ('payoneer_link','kickoff_link','site') and btrim(coalesce(p->>k,'')) <> '' and (p->>k) !~* '^https://\S+$' then
        raise exception 'Links have to start with https://';
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

-- ───────────────────────── 2. document links ─────────────────────────
-- A document link is  <a|i>.<id>.<signature>. Nothing is stored: the signature is made from the id with a
-- key that lives in the vault, so the link can be made again whenever an email needs it and cannot be guessed.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'aviance_doc_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'), 'aviance_doc_key', 'Signs agreement and invoice links');
  end if;
end $$;

create or replace function public.doc_token(p_kind text, p_id uuid) returns text
language sql stable security definer set search_path to '' as $$
  select p_kind || '.' || p_id::text || '.' ||
         encode(extensions.hmac(p_kind || ':' || p_id::text,
                (select decrypted_secret from vault.decrypted_secrets where name = 'aviance_doc_key' limit 1), 'sha256'), 'hex');
$$;
revoke execute on function public.doc_token(text, uuid) from public, anon, authenticated;

-- the id inside a link, or null when the link is not one of ours
create or replace function public.doc_id(p_token text, p_kind text) returns uuid
language plpgsql stable security definer set search_path to 'public' as $$
declare parts text[] := string_to_array(coalesce(p_token,''), '.'); v uuid;
begin
  if array_length(parts,1) <> 3 or parts[1] <> p_kind then return null; end if;
  begin v := parts[2]::uuid; exception when others then return null; end;
  if public.doc_token(p_kind, v) = p_token then return v; end if;
  return null;
end $$;
revoke execute on function public.doc_id(text, text) from public, anon, authenticated;

-- ───────────────────────── 3. tables ─────────────────────────
create table if not exists public.client_agreements (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  terms        jsonb not null,                       -- the words as they stood when it was sent
  status       text not null default 'sent' check (status in ('sent','signed','void')),
  signed_name  text check (char_length(signed_name) <= 160),
  signed_at    timestamptz,
  signed_agent text check (char_length(signed_agent) <= 400),
  created_at   timestamptz not null default now()
);
create index if not exists client_agreements_client_idx on public.client_agreements(client_id);
alter table public.client_agreements enable row level security;
drop policy if exists "team reads client agreements" on public.client_agreements;
create policy "team reads client agreements" on public.client_agreements for select using (public.is_approved());
drop policy if exists "admin writes client agreements" on public.client_agreements;
create policy "admin writes client agreements" on public.client_agreements for all using (public.is_admin()) with check (public.is_admin());

alter table public.invoices add column if not exists is_first boolean not null default false;

-- which login a client's person is. One login, one person.
alter table public.client_people add column if not exists user_id uuid references auth.users(id) on delete set null;
create unique index if not exists client_people_user_uq on public.client_people(user_id) where user_id is not null;

-- invites: only a hash is kept. The token itself exists in the email and nowhere else.
alter table public.portal_invites add column if not exists token_hash text;
create unique index if not exists portal_invites_hash_uq on public.portal_invites(token_hash);
alter table public.portal_invites drop column if exists token;

-- the first month's invoice is the one raised at the close: do not bill month 1 twice
create or replace function public.raise_invoice(p_month uuid, p_due_days integer default 0)
returns public.invoices language plpgsql as $function$
declare
  m public.client_months;
  c public.clients;
  inv public.invoices;
  covers integer := 1;
  gross integer;
  credit integer := 0;
begin
  select * into m from public.client_months where id = p_month;
  if not found then raise exception 'no such month'; end if;
  select * into c from public.clients where id = m.client_id;

  select * into inv from public.invoices where month_id = p_month limit 1;
  if found then return inv; end if;                       -- never bill a month twice

  if m.month_no = 1 then                                  -- the invoice sent when they said yes
    select * into inv from public.invoices
      where client_id = c.id and is_first and month_id is null and status <> 'void' limit 1;
    if found then
      update public.invoices set month_id = m.id where id = inv.id returning * into inv;
      return inv;
    end if;
  end if;

  if c.term = '3month' then
    if (m.month_no - 1) % 3 <> 0 then
      return null;                                        -- already paid for in the quarter
    end if;
    covers := 3;
  end if;

  gross := c.monthly_fee * covers;

  if c.pilot_credit > 0 and not c.pilot_credit_used then
    credit := least(c.pilot_credit, gross);
    update public.clients set pilot_credit_used = true where id = c.id;
  end if;

  insert into public.invoices (client_id, month_id, number, gross_amount, pilot_credit, amount,
                               issued_on, due_on, status, notes)
  values (c.id, m.id,
          'AV-' || to_char(now(),'YYYY') || '-' || nextval('public.invoice_no_seq'),
          gross, credit, gross - credit,
          current_date, current_date + p_due_days, 'draft',
          case when covers = 3 then format('Months %s-%s, 3-month term.', m.month_no, m.month_no + 2)
               else format('Month %s.', m.month_no) end)
  returning * into inv;

  return inv;
end $function$;

-- ───────────────────────── 4. what a client login may see ─────────────────────────
-- A client's person is in a channel when channel_members says so. That is the whole rule.
create or replace function public.my_channel_ids() returns setof uuid
language sql stable security definer set search_path to 'public' as $$
  select cm.channel_id
  from public.client_people p
  join public.channel_members cm on cm.person_id = p.id
  join public.channels c on c.id = cm.channel_id
  where p.user_id = auth.uid() and c.kind = 'client' and c.client_id = p.client_id and c.archived_at is null;
$$;
create or replace function public.my_person_in(p_channel uuid) returns uuid
language sql stable security definer set search_path to 'public' as $$
  select p.id
  from public.client_people p
  join public.channel_members cm on cm.person_id = p.id and cm.channel_id = p_channel
  join public.channels c on c.id = cm.channel_id
  where p.user_id = auth.uid() and c.kind = 'client' and c.client_id = p.client_id and c.archived_at is null
  limit 1;
$$;
revoke execute on function public.my_channel_ids(), public.my_person_in(uuid) from public, anon;
grant  execute on function public.my_channel_ids(), public.my_person_in(uuid) to authenticated;

drop policy if exists "client reads own channel" on public.channels;
create policy "client reads own channel" on public.channels for select to authenticated
  using (id in (select public.my_channel_ids()));

drop policy if exists "client reads own messages" on public.channel_messages;
create policy "client reads own messages" on public.channel_messages for select to authenticated
  using (deleted_at is null and channel_id in (select public.my_channel_ids()));

drop policy if exists "client writes own messages" on public.channel_messages;
create policy "client writes own messages" on public.channel_messages for insert to authenticated
  with check (author_user is null and author_person is not null
              and author_person = public.my_person_in(channel_id)
              and char_length(body) between 1 and 4000
              and attachment_url is null and edited_at is null and deleted_at is null);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'channel_messages') then
    alter publication supabase_realtime add table public.channel_messages;
  end if;
exception when undefined_object then null; end $$;

-- everything the client's page needs besides the messages, in one answer
create or replace function public.portal_home() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare per public.client_people; ch public.channels; co text;
begin
  select * into per from public.client_people where user_id = auth.uid() limit 1;
  if not found then return null; end if;
  select c.* into ch from public.channels c
    join public.channel_members cm on cm.channel_id = c.id and cm.person_id = per.id
   where c.kind = 'client' and c.client_id = per.client_id and c.archived_at is null
   order by c.created_at limit 1;
  if not found then return null; end if;
  select company into co from public.clients where id = per.client_id;
  return jsonb_build_object(
    'person',  jsonb_build_object('id', per.id, 'name', per.full_name),
    'company', co,
    'channel', jsonb_build_object('id', ch.id, 'name', ch.name),
    'members', coalesce((
      select jsonb_agg(x order by x->>'kind' desc, x->>'name') from (
        select jsonb_build_object('kind','team','id', cm.user_id, 'name', coalesce(nullif(pr.name,''),'Aviance')) as x
          from public.channel_members cm left join public.profiles pr on pr.id = cm.user_id
         where cm.channel_id = ch.id and cm.user_id is not null
        union all
        select jsonb_build_object('kind','client','id', cp.id, 'name', cp.full_name)
          from public.channel_members cm join public.client_people cp on cp.id = cm.person_id
         where cm.channel_id = ch.id
      ) s), '[]'::jsonb));
end $$;
revoke execute on function public.portal_home() from public, anon;
grant  execute on function public.portal_home() to authenticated;

-- ───────────────────────── 5. invites ─────────────────────────
create or replace function public.invite_hash(p_token text) returns text
language sql immutable set search_path to '' as $$
  select encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex');
$$;

create or replace function public.portal_invite_create(p_client uuid, p_email text, p_person uuid default null)
returns text language plpgsql security definer set search_path to 'public' as $$
declare raw text := encode(extensions.gen_random_bytes(24), 'hex'); v_email text := lower(btrim(coalesce(p_email,'')));
begin
  if not public.is_approved() then raise exception 'Only the Aviance team can invite a client.'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'That email address does not look right.'; end if;
  if not exists (select 1 from public.clients where id = p_client) then raise exception 'That client is not here any more.'; end if;
  update public.portal_invites set status = 'revoked'
   where client_id = p_client and lower(email) = v_email and status = 'pending';
  insert into public.portal_invites(client_id, person_id, email, token_hash)
  values (p_client, p_person, v_email, public.invite_hash(raw));
  return raw;
end $$;
revoke execute on function public.portal_invite_create(uuid, text, uuid) from public, anon;
grant  execute on function public.portal_invite_create(uuid, text, uuid) to authenticated;

create or replace function public.invite_peek(p_token text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare i public.portal_invites; co text; nm text;
begin
  select * into i from public.portal_invites where token_hash = public.invite_hash(p_token);
  if not found or i.status = 'revoked' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if i.status = 'accepted' then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if i.status = 'expired' or i.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select company into co from public.clients where id = i.client_id;
  select full_name into nm from public.client_people where id = i.person_id;
  return jsonb_build_object('ok', true, 'email', i.email, 'company', co, 'name', coalesce(nm, split_part(i.email,'@',1)));
end $$;
revoke execute on function public.invite_peek(text) from public;
grant  execute on function public.invite_peek(text) to anon, authenticated;

-- the server-side half of "set a password": only the portal-accept function may call these
create or replace function public.auth_user_by_email(p_email text) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('id', u.id,
           'team', exists(select 1 from public.profiles p where p.id = u.id and p.approved and p.role in ('admin','employee')))
  from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
$$;

create or replace function public.portal_invite_consume(p_token text, p_user uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare i public.portal_invites; per public.client_people; ch public.channels; co text;
begin
  if exists (select 1 from public.profiles where id = p_user and approved and role in ('admin','employee')) then
    raise exception 'That email belongs to the Aviance team.';
  end if;
  update public.portal_invites set status = 'accepted', accepted_at = now(), accepted_user = p_user
   where token_hash = public.invite_hash(p_token) and status = 'pending' and expires_at > now()
   returning * into i;
  if not found then raise exception 'This link has already been used or has expired.'; end if;

  if i.person_id is not null then select * into per from public.client_people where id = i.person_id and client_id = i.client_id; end if;
  if per.id is null then
    select * into per from public.client_people where client_id = i.client_id and lower(email) = lower(i.email) limit 1;
  end if;
  if per.id is null then
    insert into public.client_people(client_id, full_name, email) values (i.client_id, split_part(i.email,'@',1), i.email) returning * into per;
  end if;
  update public.client_people set user_id = null where user_id = p_user and id <> per.id;
  update public.client_people set user_id = p_user where id = per.id;

  -- a client is never "approved": approved means team, and team sees everything
  update public.profiles set role = 'client', approved = false, name = per.full_name where id = p_user;

  select company into co from public.clients where id = i.client_id;
  select * into ch from public.channels where kind = 'client' and client_id = i.client_id and archived_at is null order by created_at limit 1;
  if not found then
    insert into public.channels(name, purpose, kind, client_id) values (co, 'Your direct line to the Aviance team', 'client', i.client_id) returning * into ch;
  end if;
  insert into public.channel_members(channel_id, person_id) values (ch.id, per.id) on conflict do nothing;
  return jsonb_build_object('ok', true, 'email', i.email, 'client_id', i.client_id, 'person_id', per.id, 'channel_id', ch.id);
end $$;
revoke execute on function public.auth_user_by_email(text), public.portal_invite_consume(text, uuid) from public, anon, authenticated;
grant  execute on function public.auth_user_by_email(text), public.portal_invite_consume(text, uuid) to service_role;

-- once an invite email has gone, the copy we keep no longer carries a working link
create or replace function public.mail_outbox_scrub() returns trigger language plpgsql as $$
begin
  if new.status = 'sent' and new.kind = 'portal_invite' then
    new.body_text := regexp_replace(new.body_text, 'join\.html#[0-9a-f]{48}', 'join.html#(hidden once sent)', 'g');
    new.body_html := regexp_replace(new.body_html, 'join\.html#[0-9a-f]{48}', 'join.html#(hidden once sent)', 'g');
  end if;
  return new;
end $$;
drop trigger if exists mail_outbox_scrub on public.mail_outbox;
create trigger mail_outbox_scrub before update on public.mail_outbox for each row execute function public.mail_outbox_scrub();

-- ───────────────────────── 6. the chain ─────────────────────────
-- stand-ins for the wording (replaced by 20261124_close_pack_templates.sql)
do $$ begin
  if not exists (select 1 from pg_proc where proname = 'agreement_terms' and pronamespace = 'public'::regnamespace) then
    execute $f$create function public.agreement_terms(p_client uuid) returns jsonb language sql stable set search_path = public as
      $b$ select jsonb_build_object('title','Service agreement','intro','', 'parties','[]'::jsonb,'sections','[]'::jsonb,'placeholders','[]'::jsonb) $b$ $f$;
  end if;
  if not exists (select 1 from pg_proc where proname = 'mail_pack' and pronamespace = 'public'::regnamespace) then
    execute $f$create function public.mail_pack(p_client uuid, p_agreement_url text, p_invoice_url text) returns jsonb language sql stable set search_path = public as
      $b$ select jsonb_build_object('subject','Your Aviance agreement and invoice','text', E'Agreement: '||p_agreement_url||E'\nInvoice: '||p_invoice_url,'html', null) $b$ $f$;
  end if;
  if not exists (select 1 from pg_proc where proname = 'mail_welcome' and pronamespace = 'public'::regnamespace) then
    execute $f$create function public.mail_welcome(p_client uuid, p_join_url text, p_agreement_url text, p_receipt_url text, p_kickoff_url text) returns jsonb language sql stable set search_path = public as
      $b$ select jsonb_build_object('subject','You''re in: open your Aviance channel','text', E'Join: '||p_join_url||E'\nAgreement: '||p_agreement_url||E'\nReceipt: '||p_receipt_url||E'\nKickoff: '||p_kickoff_url,'html', null) $b$ $f$;
  end if;
end $$;

-- 1. the call is won
create or replace function public.close_won(p_booking uuid, p_plan text, p_term text default 'monthly')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
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

  -- a pilot they paid for in the last 60 days comes off the first invoice
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

  return jsonb_build_object('client_id', c.id, 'invoice_id', inv.id, 'agreement_id', ag.id, 'invoice_number', inv.number);
end $$;

-- 2. the money arrived
create or replace function public.mark_paid(p_invoice uuid, p_via text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
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
  end if;

  return jsonb_build_object('invoice_id', inv.id, 'client_id', c.id, 'welcome_sent', v_welcome);
end $$;
revoke execute on function public.close_won(uuid, text, text), public.mark_paid(uuid, text) from public, anon;
grant  execute on function public.close_won(uuid, text, text), public.mark_paid(uuid, text) to authenticated;

-- 3. what a document link shows
create or replace function public.doc_get(p_token text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v uuid; ag public.client_agreements; inv public.invoices; c public.clients; lines jsonb;
begin
  v := public.doc_id(p_token, 'a');
  if v is not null then
    select * into ag from public.client_agreements where id = v;
    if found then
      select * into c from public.clients where id = ag.client_id;
      return jsonb_build_object('kind','agreement','company', c.company, 'contact_name', c.contact_name,
        'status', ag.status, 'signed_name', ag.signed_name, 'signed_at', ag.signed_at, 'terms', ag.terms);
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
      return jsonb_build_object('kind','invoice','number', inv.number, 'status', inv.status,
        'issued_on', inv.issued_on, 'due_on', inv.due_on, 'paid_at', inv.paid_at, 'currency', inv.currency,
        'lines', lines, 'gross', inv.gross_amount, 'pilot_credit', inv.pilot_credit, 'amount', inv.amount,
        'bill_to', jsonb_build_object('company', c.company, 'contact_name', c.contact_name, 'contact_email', c.contact_email),
        'from', jsonb_build_object('legal_name', public.biz('legal_name'), 'address', public.biz('address'), 'email', public.biz('email')),
        'pay', jsonb_build_object('wise_details', public.biz('wise_details'), 'payoneer_link', public.biz('payoneer_link')));
    end if;
  end if;
  raise exception 'This link is not valid.';
end $$;

create or replace function public.doc_sign(p_token text, p_name text, p_agent text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
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
  return public.doc_get(p_token);
end $$;
revoke execute on function public.doc_get(text), public.doc_sign(text, text, text) from public;
grant  execute on function public.doc_get(text), public.doc_sign(text, text, text) to anon, authenticated;
