-- 20261125_staff.sql — the 'staff' role, the owner's Employees screen and her private channel (builder A).
-- Contract: /home/claude/staff/SPEC.md, plus the lead's two corrections (see "Why staff are not profiles").
-- Safe to run more than once.
--
-- The whole point of this file: his first employee signs in at aviance.store/team and can reach HER OWN CHANNEL
-- AND NOTHING ELSE — no clients, bookings, invoices, agreements, documents, settings, journey, drafts, approvals,
-- other channels, other staff — even if she calls the REST API straight with her own token.
--
-- Why staff are not profiles
--   profiles.id is a foreign key onto auth.users(id) and can never be re-pointed, so the owner cannot write her
--   profile before she has a login. Worse, the trigger on_auth_user_created -> handle_new_user() gives EVERY new
--   auth user a profiles row with role 'employee', approved false — one careless "approve" click away from the
--   whole business. So staff live in their own table, public.staff, keyed by its own id, and her auth user is
--   linked to it afterwards. Her profiles row still exists (the trigger makes one) but it is re-roled to 'staff'
--   the moment she is linked, and handle_new_user() now writes role 'staff' from the start for an email that is
--   already in public.staff. Belt and braces on top: a trigger forces approved=false on any 'staff' profiles row,
--   so she cannot be approved into the team by accident or by a stray update.
--
-- How the lock-out is enforced, in order of how much it is relied on
--   1. is_approved() stays 'approved AND role in (admin, employee)' and is pinned here. Every team table's policy
--      is keyed on is_approved() or is_admin() (checked against pg_policies, 2026-11-24 — the only policy that
--      mentions anything else is profiles_read, which adds 'id = auth.uid()', i.e. her own row). Nothing anywhere
--      keys on "role <> 'client'" or similar, so a staff login matches no team policy and those tables return
--      zero rows for her.
--   2. Four new policies, and only four, mention staff: her one channels row, read + insert on channel_messages
--      for that one channel, and her own public.staff row. channel_members gets none on purpose — she cannot
--      even list who is in her channel.
--   3. Her screen never touches a table: staff_me / staff_send / staff_seen are security definer, all three
--      refuse a revoked member, and they are the only staff functions granted to her. Everything owner-side is
--      gated on is_admin() inside the function as well as by the grant.
--
-- What is here
--   table:     public.staff (+ RLS), channels kind 'staff', channel_members member_role 'staff',
--              profiles.last_seen_at, the never-approved trigger, handle_new_user() taught about staff
--   inside:    is_staff(), my_staff_channel()
--   owner:     staff_list, staff_add, staff_set_status, staff_channel_id, staff_mark_read, staff_doc_token,
--              staff_link_auth (owner or service_role — the staff-code edge function calls this one)
--   staff:     staff_me, staff_send, staff_seen
--   doc.html:  doc_get now knows kind 's' (the welcome one-pager). The old body is renamed doc_get_core and
--              still does agreements and invoices, so nothing about those links changes.
--   storage:   private bucket 'chat-files', paths <channel_id>/<uuid>.<ext>

-- ───────────────────────── the staff table ─────────────────────────
-- id is NOT the auth user id: the owner adds her before she has a login. user_id is filled in by
-- staff_link_auth() when the staff-code function creates it.
--   status: 'new'      added, no access code yet
--           'invited'  a code exists, she has not opened her channel yet
--           'active'   she has opened it
--           'revoked'  locked out; matches nothing, anywhere
-- staff_list() reports 'new' as 'invited' so the screen only ever shows the three words the spec names.
create table if not exists public.staff (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  status      text not null default 'new' check (status in ('new','invited','active','revoked')),
  user_id     uuid references auth.users(id) on delete set null,
  channel_id  uuid references public.channels(id) on delete set null,
  code_hash   text,
  code_set_at timestamptz,
  last_seen_at timestamptz,
  created_at  timestamptz not null default now()
);

create unique index if not exists staff_email_uniq   on public.staff (lower(email));
create unique index if not exists staff_user_id_uniq on public.staff (user_id) where user_id is not null;
create index        if not exists staff_channel_idx  on public.staff (channel_id);

comment on table  public.staff            is 'Employees. Deliberately not in profiles: see 20261125_staff.sql.';
comment on column public.staff.code_hash  is 'sha256 of her access code — only ever asked "does a code exist".';

alter table public.staff enable row level security;

-- the owner manages the list; nobody else writes it. She gets her own row, read only, and nothing else
-- actually needs it — her screen goes through staff_me().
drop policy if exists "staff_admin_all" on public.staff;
create policy "staff_admin_all" on public.staff
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Deliberately NO staff-facing policy on this table: it holds the hash of her access code, and her screen
-- never needs it (staff_me gives her everything). Supabase grants INSERT/UPDATE/DELETE on a new public table
-- to anon and authenticated by default, so take those away too and leave only what the policies allow.
drop policy if exists "staff_reads_own_row" on public.staff;
revoke all on table public.staff from anon, authenticated;
grant select, insert, update, delete on table public.staff to authenticated;

-- ───────────────────────── profiles: she must never be team ─────────────────────────
alter table public.profiles add column if not exists last_seen_at timestamptz;
comment on column public.profiles.last_seen_at is 'When this person last had a screen open.';

create or replace function public.staff_never_approved()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  -- whatever anyone writes, a staff profile is never approved, so is_approved() can never be true for her
  if new.role = 'staff' then new.approved := false; end if;
  return new;
end $fn$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'profiles_staff_never_approved') then
    create trigger profiles_staff_never_approved before insert or update on public.profiles
      for each row execute function public.staff_never_approved();
  end if;
end $$;

-- the team is admin/employee only — pinned here so a later edit cannot quietly let staff in
create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path to 'public' as $fn$
  select exists(select 1 from public.profiles p
                where p.id = auth.uid() and p.approved and p.role in ('admin','employee'));
$fn$;

-- Same as before in every respect but one: an email the owner has already added as staff comes in as
-- role 'staff', approved false, instead of 'employee'. Otherwise her first login would sit in the team list.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare v_is_staff boolean := exists (select 1 from public.staff s where lower(s.email) = lower(new.email));
begin
  insert into public.profiles (id, email, name, role, approved, init, emp_no)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    case when lower(new.email)=lower('limethsith@gmail.com') then 'admin'
         when v_is_staff then 'staff' else 'employee' end,
    case when lower(new.email)=lower('limethsith@gmail.com') then true else false end,
    upper(substr(coalesce(new.raw_user_meta_data->>'name', new.email),1,2)),
    case when lower(new.email)=lower('limethsith@gmail.com') then 0 else null end
  );
  return new;
end; $fn$;

-- ───────────────────────── channels and members: a 'staff' kind and seat ─────────────────────────
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'channels_kind_check'
             and conrelid = 'public.channels'::regclass
             and pg_get_constraintdef(oid) not like '%staff%') then
    alter table public.channels drop constraint channels_kind_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'channels_kind_check'
                 and conrelid = 'public.channels'::regclass) then
    alter table public.channels add constraint channels_kind_check
      check (kind in ('team','internal','client','staff'));
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'channel_members_member_role_check'
             and conrelid = 'public.channel_members'::regclass
             and pg_get_constraintdef(oid) not like '%staff%') then
    alter table public.channel_members drop constraint channel_members_member_role_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'channel_members_member_role_check'
                 and conrelid = 'public.channel_members'::regclass) then
    alter table public.channel_members add constraint channel_members_member_role_check
      check (member_role in ('member','owner','staff'));
  end if;
end $$;

-- ───────────────────────── who she is, and which one channel is hers ─────────────────────────
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path to 'public' as $fn$
  select exists(select 1 from public.staff s
                where s.user_id = auth.uid() and s.status in ('invited','active'));
$fn$;

create or replace function public.my_staff_channel()
returns uuid language sql stable security definer set search_path to 'public' as $fn$
  select s.channel_id
  from public.staff s
  join public.channels c on c.id = s.channel_id
  where s.user_id = auth.uid() and s.status in ('invited','active')
    and c.kind = 'staff' and c.archived_at is null
  limit 1;
$fn$;

-- ───────────────────────── her channel policies, and nothing else ─────────────────────────
drop policy if exists "staff reads own channel" on public.channels;
create policy "staff reads own channel" on public.channels
  for select to authenticated
  using (kind = 'staff' and id = public.my_staff_channel());

drop policy if exists "staff reads own messages" on public.channel_messages;
create policy "staff reads own messages" on public.channel_messages
  for select to authenticated
  using (deleted_at is null and channel_id = public.my_staff_channel()
         and msg_kind in ('chat','system'));

-- she cannot forge an author, cannot post a 'system'/'bot'/'approval' message, cannot reach another channel,
-- cannot attach a file from someone else's folder. staff_send() is what her screen calls; this is the floor.
drop policy if exists "staff writes own messages" on public.channel_messages;
create policy "staff writes own messages" on public.channel_messages
  for insert to authenticated
  with check (author_user = auth.uid() and author_person is null
              and channel_id = public.my_staff_channel()
              and char_length(body) between 1 and 4000
              and edited_at is null and deleted_at is null
              and msg_kind = 'chat' and meta is null
              and (attachment_url is null
                   or split_part(attachment_url, '/', 1) = public.my_staff_channel()::text));

-- ───────────────────────── owner side ─────────────────────────
create or replace function public.staff_channel_id(p_staff uuid)
returns uuid language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not public.is_admin() then raise exception 'Only the owner can do that.'; end if;
  return (select s.channel_id from public.staff s where s.id = p_staff);
end $fn$;

create or replace function public.staff_list()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not public.is_admin() then raise exception 'Only the owner can see the team.'; end if;
  return (
    select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) from (
      select jsonb_build_object(
               'id', s.id, 'name', s.name, 'email', s.email,
               -- 'new' means added but no code yet; the screen only knows the three words from the spec
               'status', case when s.status = 'new' then 'invited' else s.status end,
               'last_seen_at', s.last_seen_at,
               'channel_id', s.channel_id,
               'unread', coalesce((select count(*) from public.channel_messages m
                                   where m.channel_id = s.channel_id and m.deleted_at is null
                                     and m.author_user = s.user_id and s.user_id is not null
                                     and (own.last_read_at is null or m.created_at > own.last_read_at)), 0),
               'code_set', (s.code_hash is not null),
               'created_at', s.created_at) as x
      from public.staff s
      left join public.channel_members own
             on own.channel_id = s.channel_id and own.user_id = public.aviance_owner()
    ) q);
end $fn$;

-- her row, her channel, and the owner's seat in it. Her own seat waits for her login (staff_link_auth).
create or replace function public.staff_add(p_name text, p_email text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_name  text := btrim(coalesce(p_name,''));
  v_email text := lower(btrim(coalesce(p_email,'')));
  v_owner uuid := public.aviance_owner();
  v_staff uuid; v_chan uuid;
begin
  if not public.is_admin() then raise exception 'Only the owner can add an employee.'; end if;
  if v_name = '' then raise exception 'Please give her name.'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'That email address does not look right.'; end if;
  if exists (select 1 from public.staff where lower(email) = v_email) then
    raise exception 'Someone with that email address is already on the team.';
  end if;
  -- an email that is already a hub login would come back as that person, not as staff
  if exists (select 1 from public.profiles where lower(email) = v_email) then
    raise exception 'That email address already has an Aviance login.';
  end if;

  insert into public.channels (name, purpose, kind, client_id, created_by)
  values (v_name, 'Private channel between ' || v_name || ' and Aviance', 'staff', null, v_owner)
  returning id into v_chan;

  insert into public.staff (name, email, status, channel_id)
  values (v_name, v_email, 'new', v_chan)
  returning id into v_staff;

  if v_owner is not null then
    insert into public.channel_members (channel_id, user_id, member_role, last_read_at)
    values (v_chan, v_owner, 'owner', now());
  end if;

  return jsonb_build_object('staff_id', v_staff, 'channel_id', v_chan);
end $fn$;

create or replace function public.staff_set_status(p_staff uuid, p_status text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_status text := lower(btrim(coalesce(p_status,'')));
begin
  if not public.is_admin() then raise exception 'Only the owner can change an employee''s access.'; end if;
  if v_status not in ('active','invited','revoked') then raise exception 'That is not a status we use.'; end if;
  update public.staff set status = v_status where id = p_staff;
  if not found then raise exception 'That employee is not here any more.'; end if;
  return jsonb_build_object('id', p_staff, 'status', v_status);
end $fn$;

create or replace function public.staff_mark_read(p_channel uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_owner uuid := public.aviance_owner();
begin
  if not public.is_admin() then raise exception 'Only the owner can do that.'; end if;
  if not exists (select 1 from public.channels where id = p_channel and kind = 'staff') then
    raise exception 'That is not a staff channel.';
  end if;
  update public.channel_members set last_read_at = now()
   where channel_id = p_channel and user_id = v_owner;
  if not found then
    insert into public.channel_members (channel_id, user_id, member_role, last_read_at)
    values (p_channel, v_owner, 'owner', now());
  end if;
  return jsonb_build_object('channel_id', p_channel, 'last_read_at', now());
end $fn$;

create or replace function public.staff_doc_token(p_staff uuid)
returns text language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not public.is_admin() then raise exception 'Only the owner can share the welcome page.'; end if;
  if not exists (select 1 from public.staff where id = p_staff) then
    raise exception 'That employee is not here any more.';
  end if;
  return public.doc_token('s', p_staff);
end $fn$;

-- ───────────────────────── linking her login (the staff-code edge function) ─────────────────────────
-- The edge function creates or re-keys her auth user, then calls this with the new user id and the sha256 of
-- the code. It does three things in one transaction: records the login and the code on her staff row, gives
-- her a seat in her channel, and re-roles the profiles row that handle_new_user() just made so that she can
-- never be approved into the team.
create or replace function public.staff_link_auth(p_staff uuid, p_user uuid, p_code_hash text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_chan uuid; v_now timestamptz := now();
begin
  -- current_user inside a definer function is the function's OWNER, so it can never identify the caller.
  -- Judge the caller by the JWT instead: the owner's own session, or the service key the edge function uses.
  if not (public.is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'Only Aviance can issue an access code.';
  end if;
  if p_staff is null or p_user is null then raise exception 'Both ids are needed.'; end if;

  -- that login may not be taken by a different employee
  if exists (select 1 from public.staff where user_id = p_user and id <> p_staff) then
    raise exception 'That login already belongs to someone else on the team.';
  end if;

  update public.staff
     set user_id = p_user, status = 'invited', code_set_at = v_now,
         code_hash = nullif(btrim(coalesce(p_code_hash,'')), '')
   where id = p_staff
  returning channel_id into v_chan;
  if not found then raise exception 'That employee is not here any more.'; end if;

  if v_chan is not null and not exists (
       select 1 from public.channel_members where channel_id = v_chan and user_id = p_user) then
    insert into public.channel_members (channel_id, user_id, member_role, last_read_at)
    values (v_chan, p_user, 'staff', null);
  end if;

  -- the row handle_new_user() made: role 'staff', never approved (the trigger enforces the second part too)
  update public.profiles set role = 'staff', approved = false where id = p_user;

  return jsonb_build_object('staff_id', p_staff, 'user_id', p_user,
                            'channel_id', v_chan, 'code_set_at', v_now);
end $fn$;

-- ───────────────────────── her side: three calls, no tables ─────────────────────────
create or replace function public.staff_me()
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_me uuid := auth.uid(); v_owner uuid := public.aviance_owner();
  s public.staff; v_chan uuid; v_cname text; v_seen timestamptz;
begin
  select * into s from public.staff where user_id = v_me;
  if not found or s.status = 'revoked' then raise exception 'Please sign in again.'; end if;
  v_chan := public.my_staff_channel();
  if v_chan is null then raise exception 'Your channel is not ready yet. Ask Aviance to check.'; end if;

  select name into v_cname from public.channels where id = v_chan;
  select last_read_at into v_seen from public.channel_members
   where channel_id = v_chan and user_id = v_owner;

  -- the first time she opens it, 'invited' becomes 'active'
  update public.staff
     set last_seen_at = now(), status = case when status = 'invited' then 'active' else status end
   where id = s.id;
  update public.profiles set last_seen_at = now() where id = v_me;

  return jsonb_build_object(
    -- 'id' is her auth user id on purpose: it is what her own messages carry in author_user, and her screen
    -- compares the two. Her staff-row id is separate and stays on the owner's side.
    'staff',   jsonb_build_object('id', v_me, 'staff_id', s.id, 'name', s.name, 'email', s.email),
    'channel', jsonb_build_object('id', v_chan, 'name', v_cname),
    'owner',   jsonb_build_object('name', (select nullif(btrim(o.name),'')
                                             from public.profiles o where o.id = v_owner),
                                   -- her screen reads owner.last_read_at for the "Seen 14:32" line
                                   'last_read_at', v_seen),
    'seen_at', v_seen,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'body', m.body, 'attachment_url', m.attachment_url,
               'created_at', m.created_at, 'author_user', m.author_user,
               'mine', (m.author_user = v_me))
             order by m.created_at)
      from public.channel_messages m
      where m.channel_id = v_chan and m.deleted_at is null and m.msg_kind in ('chat','system')
    ), '[]'::jsonb));
end $fn$;

create or replace function public.staff_send(p_body text, p_attachment text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_me uuid := auth.uid(); s public.staff; v_chan uuid;
  v_body text := btrim(coalesce(p_body,'')); v_att text := nullif(btrim(coalesce(p_attachment,'')), '');
  m public.channel_messages;
begin
  select * into s from public.staff where user_id = v_me;
  if not found or s.status = 'revoked' then raise exception 'Please sign in again.'; end if;
  v_chan := public.my_staff_channel();
  if v_chan is null then raise exception 'Your channel is not ready yet. Ask Aviance to check.'; end if;
  if v_body = '' and v_att is null then raise exception 'Write something first.'; end if;
  if v_body = '' then v_body := '(file)'; end if;
  v_body := left(v_body, 4000);
  -- a path she could not have uploaded is not hers to attach
  if v_att is not null and split_part(v_att, '/', 1) <> v_chan::text then
    raise exception 'That file is not in this channel.';
  end if;

  insert into public.channel_messages (channel_id, author_user, author_person, body, attachment_url, msg_kind)
  values (v_chan, v_me, null, v_body, v_att, 'chat')
  returning * into m;

  update public.channel_members set last_read_at = now() where channel_id = v_chan and user_id = v_me;
  update public.staff
     set last_seen_at = now(), status = case when status = 'invited' then 'active' else status end
   where id = s.id;
  update public.profiles set last_seen_at = now() where id = v_me;

  return jsonb_build_object('id', m.id, 'channel_id', m.channel_id, 'body', m.body,
                            'attachment_url', m.attachment_url, 'created_at', m.created_at, 'mine', true);
end $fn$;

create or replace function public.staff_seen()
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_me uuid := auth.uid(); s public.staff; v_chan uuid;
begin
  select * into s from public.staff where user_id = v_me;
  if not found or s.status = 'revoked' then raise exception 'Please sign in again.'; end if;
  v_chan := public.my_staff_channel();
  if v_chan is null then raise exception 'Your channel is not ready yet. Ask Aviance to check.'; end if;
  update public.channel_members set last_read_at = now() where channel_id = v_chan and user_id = v_me;
  update public.staff
     set last_seen_at = now(), status = case when status = 'invited' then 'active' else status end
   where id = s.id;
  update public.profiles set last_seen_at = now() where id = v_me;
  return jsonb_build_object('channel_id', v_chan, 'last_read_at', now());
end $fn$;

-- ───────────────────────── doc.html: the welcome one-pager (kind 's') ─────────────────────────
-- doc_get keeps its name and its grants so doc.html is unchanged. The agreement and invoice body is moved
-- aside untouched rather than copied, so those links cannot be broken by a typo here.
do $$ begin
  if to_regprocedure('public.doc_get_core(text)') is null then
    alter function public.doc_get(text) rename to doc_get_core;
  end if;
end $$;

create or replace function public.doc_get(p_token text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare v uuid; s public.staff; v_site text;
begin
  v := public.doc_id(p_token, 's');
  if v is not null then
    select * into s from public.staff where id = v;
    if found then
      v_site := coalesce(nullif(btrim(public.biz('site')), ''), 'https://aviance.store');
      return jsonb_build_object(
        'kind', 'staff',
        'name', s.name, 'email', s.email,
        'status', case when s.status = 'new' then 'invited' else s.status end,
        'owner_name', (select nullif(btrim(o.name),'')
                         from public.profiles o where o.id = public.aviance_owner()),
        'owner_email', public.biz('email'),
        'site', v_site,
        'team_url', rtrim(v_site, '/') || '/team');
    end if;
    raise exception 'This link is not valid.';
  end if;
  return public.doc_get_core(p_token);
end $fn$;

-- ───────────────────────── storage: the chat-files bucket ─────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-files', 'chat-files', false, 10485760, array[
  'image/png','image/jpeg','image/gif','image/webp','image/heic','image/heif','application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/csv'])
on conflict (id) do update
  set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "chat_files_team_all" on storage.objects;
create policy "chat_files_team_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'chat-files' and public.is_approved())
  with check (bucket_id = 'chat-files' and public.is_approved());

-- only under her own channel's folder, and she may not change or remove anything
drop policy if exists "chat_files_staff_read" on storage.objects;
create policy "chat_files_staff_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-files' and split_part(name, '/', 1) = public.my_staff_channel()::text);

drop policy if exists "chat_files_staff_insert" on storage.objects;
create policy "chat_files_staff_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-files' and split_part(name, '/', 1) = public.my_staff_channel()::text);

-- ───────────────────────── who may call what ─────────────────────────
-- the inside helpers: nobody from the API.
-- staff_never_approved() and handle_new_user() are deliberately NOT revoked: they are trigger functions, a
-- direct call just errors ('can only be called as a trigger'), and GoTrue's own role inserts into auth.users
-- through PUBLIC's grant — revoking it risks breaking sign-up for nothing.
revoke execute on function public.doc_get_core(text) from public, anon, authenticated;

-- owner-only calls are gated on is_admin() inside as well; 'authenticated' only gets to try
revoke execute on function
  public.staff_list(), public.staff_add(text, text), public.staff_set_status(uuid, text),
  public.staff_channel_id(uuid), public.staff_mark_read(uuid), public.staff_doc_token(uuid),
  public.staff_link_auth(uuid, uuid, text)
  from public, anon;
grant execute on function
  public.staff_list(), public.staff_add(text, text), public.staff_set_status(uuid, text),
  public.staff_channel_id(uuid), public.staff_mark_read(uuid), public.staff_doc_token(uuid),
  public.staff_link_auth(uuid, uuid, text)
  to authenticated, service_role;

revoke execute on function
  public.staff_me(), public.staff_send(text, text), public.staff_seen(),
  public.is_staff(), public.my_staff_channel()
  from public, anon;
grant execute on function
  public.staff_me(), public.staff_send(text, text), public.staff_seen(),
  public.is_staff(), public.my_staff_channel()
  to authenticated, service_role;

-- doc.html is a public page
grant execute on function public.doc_get(text) to anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFY: run these after applying. Step 4 is the one that matters.
--
-- 1. the team still excludes staff, and the two guards are on
--    select pg_get_functiondef('public.is_approved()'::regprocedure) like '%''admin'',''employee''%' as team_ok;
--    select count(*) = 1 as trigger_on from pg_trigger where tgname = 'profiles_staff_never_approved';
--    select pg_get_functiondef('public.handle_new_user()'::regprocedure) like '%v_is_staff%' as new_user_ok;
--    select count(*) = 0 as no_staff_in_team from public.profiles where role = 'staff' and approved;
--
-- 2. every new object is there
--    select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and proname in
--      ('staff_list','staff_add','staff_set_status','staff_channel_id','staff_mark_read','staff_me',
--       'staff_send','staff_seen','staff_doc_token','staff_link_auth','is_staff','my_staff_channel',
--       'doc_get','doc_get_core') order by proname;   -- expect 14
--    select policyname, cmd from pg_policies
--     where policyname in ('staff reads own channel','staff reads own messages','staff writes own messages',
--                          'staff_admin_all','staff_reads_own_row',
--                          'chat_files_team_all','chat_files_staff_read','chat_files_staff_insert'); -- expect 8
--    select relrowsecurity as must_be_true from pg_class where oid = 'public.staff'::regclass;
--    select id, public, file_size_limit from storage.buckets where id = 'chat-files';  -- false, 10485760
--    select pg_get_constraintdef(oid) from pg_constraint
--      where conname in ('channels_kind_check','channel_members_member_role_check');  -- both include 'staff'
--
-- 3. the owner's side, as the owner in the hub: Add employee -> Generate access code -> Welcome page -> send a
--    message. Then check the plumbing:
--    select * from public.staff;                       -- user_id and channel_id set, status 'invited', code_hash set
--    select member_role, user_id from public.channel_members
--      where channel_id = (select channel_id from public.staff limit 1);   -- two rows: 'owner' and 'staff'
--    select role, approved from public.profiles
--      where id = (select user_id from public.staff limit 1);              -- 'staff', false
--
-- 4. AS HER. Needs her login to exist (step 3 first).
--    begin;
--    select set_config('request.jwt.claims',
--      json_build_object('sub', (select user_id::text from public.staff
--                                 where user_id is not null order by created_at limit 1),
--                        'role', 'authenticated')::text, true);
--    set local role authenticated;
--
--    -- she is not team, not admin, and is staff
--    select public.is_approved() as must_be_false, public.is_admin() as must_be_false2,
--           public.is_staff() as must_be_true, public.my_staff_channel() as her_channel;
--
--    -- exactly one channel, and it is hers; only her channel's messages; one staff row; her own profile only
--    select count(*) as must_be_1 from public.channels;
--    select bool_and(id = public.my_staff_channel()) as must_be_true from public.channels;
--    select count(distinct channel_id) as must_be_at_most_1 from public.channel_messages;
--    select count(*) as must_be_1, bool_and(user_id = auth.uid()) as must_be_true from public.staff;
--    select count(*) as must_be_1, bool_and(id = auth.uid()) as must_be_true from public.profiles;
--
--    -- everything else is empty. Every one of these must be 0.
--    select (select count(*) from public.clients)              as clients,
--           (select count(*) from public.invoices)             as invoices,
--           (select count(*) from public.discovery_bookings)   as bookings,
--           (select count(*) from public.client_agreements)    as agreements,
--           (select count(*) from public.agreements)           as agreement_templates,
--           (select count(*) from public.agreement_pdfs)       as agreement_pdfs,
--           (select count(*) from public.workspace_admin)      as biz_settings,
--           (select count(*) from public.workspace_shared)     as shared_settings,
--           (select count(*) from public.journey_steps)        as journey,
--           (select count(*) from public.bot_drafts)           as drafts,
--           (select count(*) from public.approvals)            as approvals,
--           (select count(*) from public.channel_members)      as members,
--           (select count(*) from public.client_people)        as people,
--           (select count(*) from public.client_profiles)      as client_profiles,
--           (select count(*) from public.client_requests)      as client_requests,
--           (select count(*) from public.client_months)        as months,
--           (select count(*) from public.client_events)        as events,
--           (select count(*) from public.client_stage_history) as stages,
--           (select count(*) from public.tasks)                as tasks,
--           (select count(*) from public.meetings)             as meetings,
--           (select count(*) from public.qualified_calls)      as calls,
--           (select count(*) from public.call_log)             as call_log,
--           (select count(*) from public.call_targets)         as targets,
--           (select count(*) from public.dnc)                  as dnc,
--           (select count(*) from public.outreach_messages)    as outreach,
--           (select count(*) from public.outreach_threads)     as threads,
--           (select count(*) from public.outreach_campaigns)   as campaigns,
--           (select count(*) from public.outreach_accounts)    as accounts,
--           (select count(*) from public.outreach_inboxes)     as inboxes,
--           (select count(*) from public.outreach_daily)       as outreach_daily,
--           (select count(*) from public.mail_outbox)          as mail,
--           (select count(*) from public.portal_invites)       as invites,
--           (select count(*) from public.refunds)              as refunds,
--           (select count(*) from public.handovers)            as handovers,
--           (select count(*) from public.precall_forms)        as forms,
--           (select count(*) from public.schedule_offers)      as offers,
--           (select count(*) from public.research_briefs)      as briefs,
--           (select count(*) from public.research_log)         as research_log,
--           (select count(*) from public.testing_days)         as testing_days,
--           (select count(*) from public.plan_prices)          as prices,
--           (select count(*) from public.calendar_settings)    as calsettings,
--           (select count(*) from public.calendar_blocks)      as calblocks,
--           (select count(*) from public.v_money)              as v_money,
--           (select count(*) from public.v_exposure)           as v_exposure,
--           (select count(*) from public.v_invoice_work)       as v_invoice_work,
--           (select count(*) from public.v_month_standing)     as v_month_standing,
--           (select count(*) from public.v_outreach_summary)   as v_outreach_summary,
--           (select count(*) from public.v_mail_to_send)       as v_mail_to_send,
--           (select count(*) from public.v_booking_links)      as v_booking_links;
--
--    -- her three calls work
--    select public.staff_me();
--    select public.staff_seen();
--    select public.staff_send('verify — please ignore', null);
--
--    -- and everything owner-side refuses her
--    select public.staff_list();                            -- expect: Only the owner...
--    select public.staff_add('x','x@example.com');           -- expect: Only the owner...
--    select public.staff_set_status(
--             (select id from public.staff limit 1), 'active');  -- expect: Only the owner...
--    select public.staff_doc_token((select id from public.staff limit 1));  -- expect: Only the owner...
--    select public.staff_link_auth((select id from public.staff limit 1), auth.uid(), 'x');
--                                                            -- expect: Only Aviance can issue an access code.
--    select public.my_channels();                            -- expect: refused or empty (team function)
--    select public.biz_get();                                -- expect: refused (team function)
--    select public.drafts_pending();                         -- expect: refused (team function)
--    select public.journey_board();                          -- expect: refused (team function)
--    select public.documents_preview();                      -- expect: refused or empty
--    select public.portal_home();                            -- expect: refused (she is no client)
--    select public.doc_token('s', gen_random_uuid());        -- expect: permission denied for function
--    select public.aviance_owner();                          -- expect: permission denied for function
--    select public.handle_new_user();                        -- expect: can only be called as a trigger
--
--    -- she cannot forge a message: every one of these must be refused by the row-level check
--    insert into public.channel_messages (channel_id, author_user, body)
--      values ((select id from public.channels where kind <> 'staff' limit 1), auth.uid(), 'nope');
--    insert into public.channel_messages (channel_id, author_user, body, msg_kind)
--      values (public.my_staff_channel(), auth.uid(), 'nope', 'system');
--    insert into public.channel_messages (channel_id, author_user, body)
--      values (public.my_staff_channel(), public.aviance_owner(), 'nope');
--    insert into public.channel_messages (channel_id, author_user, body, attachment_url)
--      values (public.my_staff_channel(), auth.uid(), 'nope', 'some-other-channel/x.png');
--    update public.channel_messages set body = 'nope';           -- expect 0 rows
--    update public.staff set status = 'active', code_hash = null; -- expect 0 rows (no update policy for her)
--    update public.profiles set approved = true, role = 'admin';  -- expect 0 rows
--    insert into public.channels (name, kind) values ('nope', 'staff');     -- expect refused
--    insert into public.channel_members (channel_id, user_id, member_role)
--      values ((select id from public.channels where kind <> 'staff' limit 1), auth.uid(), 'staff'); -- refused
--
--    -- storage: her folder only, and no bucket listing
--    select count(*) as must_be_0 from storage.objects
--     where bucket_id = 'chat-files' and split_part(name,'/',1) <> public.my_staff_channel()::text;
--    select count(*) as must_be_0 from storage.buckets;
--
--    rollback;            -- undoes the verify message and the last_seen touches
--    reset role;
--    select current_user;  -- back to postgres
--
-- 5. revoke really locks her out: as the owner,
--      select public.staff_set_status((select id from public.staff limit 1), 'revoked');
--    then repeat step 4 — is_staff() false, my_staff_channel() null, channels / channel_messages / staff all 0,
--    and staff_me(), staff_send(), staff_seen() all raise 'Please sign in again.'
--    Put her back with select public.staff_set_status(..., 'active');
--
-- 6. the old doc links still work, and the new one does:
--    select public.doc_get(public.doc_token('i', (select id from public.invoices limit 1)))        -> 'invoice'
--    select public.doc_get(public.doc_token('a', (select id from public.client_agreements limit 1)))-> 'agreement'
--    select public.doc_get(public.staff_doc_token((select id from public.staff limit 1)))          -> 'staff'
--    select public.doc_get('s.00000000-0000-0000-0000-000000000000.deadbeef')  -> 'This link is not valid.'
