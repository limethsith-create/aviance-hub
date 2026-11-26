-- Portal seats by plan.
--
-- A seat is one person of one client who can sign in to the portal. The rule:
-- Starter 2, Growth 4, Scale unlimited. The numbers live in ONE place —
-- plan_prices.portal_seats — so nothing hard-codes 2 or 4 anywhere else.
-- `null` means unlimited; that is the whole of Scale's rule.
--
-- Where it is enforced:
--   1. portal_invite_create  — an invite is refused when there is no free seat.
--   2. portal_invite_consume — checked AGAIN when the link is opened, because
--      an invite made while a seat was free can be opened after it is gone.
--
-- Why it cannot be raced: both take a row lock on the client
-- (`select ... from clients where id = ... for update`) before they count.
-- Two people opening the last two invites at the same instant line up behind
-- that lock; the second one then counts a fresh total and is refused. This is
-- deliberately NOT a read-then-write: the count happens while the lock is held
-- and the whole function is one transaction, so a refusal rolls back the invite
-- it had already marked accepted. A unique index
-- (client_people_one_seat_per_user) backs it up: one login can never hold two
-- seats, whatever happens above it.
--
-- The messages a person reads are built here, in plain English, with the
-- company, the plan and the number in them, and they say what to do next. They
-- are raised with SQLSTATE 'ZS001' so the portal-accept edge function can tell
-- a seat refusal apart from a dead link and show the sentence as written.

/* ---------- 1. the numbers, in one place ---------- */

alter table public.plan_prices
  add column if not exists portal_seats int;

comment on column public.plan_prices.portal_seats is
  'How many people of a client on this plan can sign in to the portal. null = unlimited (Scale). The only place these numbers live.';

update public.plan_prices set portal_seats = 2,    updated_at = now() where plan = 'starter' and portal_seats is distinct from 2;
update public.plan_prices set portal_seats = 4,    updated_at = now() where plan = 'growth'  and portal_seats is distinct from 4;
update public.plan_prices set portal_seats = null, updated_at = now() where plan = 'scale'   and portal_seats is not null;
-- the retired Pilot: one seat, so an old row still answers rather than raising
update public.plan_prices set portal_seats = 1,    updated_at = now() where plan = 'pilot'   and portal_seats is distinct from 1;

alter table public.plan_prices drop constraint if exists plan_prices_portal_seats_sane;
alter table public.plan_prices
  add constraint plan_prices_portal_seats_sane check (portal_seats is null or portal_seats >= 1);

-- one login, one seat. Backs up the lock above and makes a double-accept by the
-- same person impossible even if every check above were removed.
create unique index if not exists client_people_one_seat_per_user
  on public.client_people(user_id) where user_id is not null;

/* ---------- 2. reading the rule ---------- */

-- The seat allowance of a plan. null = unlimited. Raises in plain English when
-- the plan has no price row at all, rather than guessing a number.
create or replace function public.plan_seats(p_plan text)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_seats int; v_found boolean;
begin
  select portal_seats, true into v_seats, v_found
    from public.plan_prices where plan = lower(btrim(coalesce(p_plan,'')));
  if not coalesce(v_found, false) then
    raise exception 'We do not have a seat number for the % plan yet. Set it on the plan before inviting anyone.', coalesce(nullif(btrim(p_plan),''),'(none)');
  end if;
  return v_seats;   -- null = unlimited
end
$$;

comment on function public.plan_seats(text) is
  'Portal seats allowed on a plan, from plan_prices.portal_seats. null = unlimited.';

/* ---------- 3. the sentences a person reads ---------- */

create or replace function public.seat_full_message(p_company text, p_label text, p_seats int, p_for_client boolean default false)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_for_client then
    format('%s already has all %s of its Aviance logins in use, so this link cannot open another one. Ask whoever set up your Aviance portal to free a login, or reply to any of our emails and we will sort it out.',
           coalesce(nullif(btrim(p_company),''), 'Your company'), p_seats)
  else
    format('%s is on %s, which comes with %s portal %s, and %s taken. Free one under "Who can sign in" on their page, or move them to a bigger plan, then send this invite again.',
           coalesce(nullif(btrim(p_company),''), 'That client'), coalesce(nullif(btrim(p_label),''), 'their plan'), p_seats,
           case when p_seats = 1 then 'login' else 'logins' end,
           case when p_seats = 1 then 'it is' else 'they are all' end)
  end;
$$;

/* ---------- 4. who holds a seat (the owner's screen reads this) ---------- */

create or replace function public.portal_seat_state(p_client uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c public.clients; v_label text; v_seats int; v_held int; v_pending int;
begin
  if not public.is_approved() then
    raise exception 'Only the Aviance team can see who can sign in.';
  end if;
  select * into c from public.clients where id = p_client;
  if c.id is null then raise exception 'That client is not here any more.'; end if;

  select label, portal_seats into v_label, v_seats from public.plan_prices where plan = c.plan;

  select count(*) into v_held   from public.client_people where client_id = p_client and user_id is not null;
  select count(*) into v_pending from public.portal_invites
   where client_id = p_client and status = 'pending' and expires_at > now();

  return jsonb_build_object(
    'client_id', p_client,
    'company',   c.company,
    'plan',      c.plan,
    'plan_label', coalesce(v_label, c.plan),
    'seats',     v_seats,                                  -- null = unlimited
    'unlimited', (v_seats is null),
    'held',      v_held,
    'pending',   v_pending,
    'free',      case when v_seats is null then null else greatest(v_seats - v_held - v_pending, 0) end,
    'at_limit',  case when v_seats is null then false else (v_held + v_pending) >= v_seats end,
    'full_message', case when v_seats is null or (v_held + v_pending) < v_seats then null
                         else public.seat_full_message(c.company, coalesce(v_label, c.plan), v_seats, false) end,
    'holders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'person_id', p.id, 'name', p.full_name, 'email', p.email, 'role', p.role,
               'is_primary', p.is_primary, 'since', i.accepted_at)
             order by p.is_primary desc, p.full_name)
        from public.client_people p
        left join lateral (
          select max(accepted_at) as accepted_at from public.portal_invites
           where client_id = p.client_id and status = 'accepted'
             and (person_id = p.id or lower(email) = lower(coalesce(p.email,'')))
        ) i on true
       where p.client_id = p_client and p.user_id is not null), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', v.id, 'email', v.email, 'person_id', v.person_id,
               'portal_role', v.portal_role, 'expires_at', v.expires_at, 'created_at', v.created_at)
             order by v.created_at desc)
        from public.portal_invites v
       where v.client_id = p_client and v.status = 'pending' and v.expires_at > now()), '[]'::jsonb),
    'waiting', coalesce((
      select jsonb_agg(jsonb_build_object('person_id', p.id, 'name', p.full_name, 'email', p.email, 'role', p.role)
             order by p.full_name)
        from public.client_people p
       where p.client_id = p_client and p.user_id is null), '[]'::jsonb));
end
$$;

comment on function public.portal_seat_state(uuid) is
  'Who holds a portal seat for one client, how many are left, and the plain sentence to show when there are none. Team only.';

/* ---------- 5. free a seat ---------- */

create or replace function public.portal_seat_free(p_person uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare per public.client_people; v_was uuid;
begin
  if not public.is_approved() then
    raise exception 'Only the Aviance team can free a portal login.';
  end if;
  select * into per from public.client_people where id = p_person;
  if per.id is null then raise exception 'That person is not on this client any more.'; end if;

  -- line up behind the same lock the invite rules use
  perform 1 from public.clients where id = per.client_id for update;

  v_was := per.user_id;
  if v_was is null then
    raise exception '% does not have a portal login, so there is nothing to free.', per.full_name;
  end if;

  update public.client_people set user_id = null where id = per.id;
  -- a pending invite to the same inbox would hand the seat straight back
  update public.portal_invites set status = 'revoked'
   where client_id = per.client_id and status = 'pending'
     and (person_id = per.id or lower(email) = lower(coalesce(per.email,'')));

  insert into public.client_events(client_id, area, event, detail)
  values (per.client_id, 'portal', 'seat_freed',
          jsonb_build_object('person_id', per.id, 'name', per.full_name, 'email', per.email,
                             'by', auth.uid(), 'reason', nullif(btrim(coalesce(p_reason,'')), '')));

  return public.portal_seat_state(per.client_id);
end
$$;

comment on function public.portal_seat_free(uuid, text) is
  'Take the portal login away from one person of a client and revoke any pending invite to the same inbox. Team only. Their person row, their messages and their channel stay.';

/* ---------- 6. enforce when the invite is ISSUED ---------- */

create or replace function public.portal_invite_create(p_client uuid, p_email text, p_person uuid default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  raw     text := encode(extensions.gen_random_bytes(24), 'hex');
  v_email text := lower(btrim(coalesce(p_email,'')));
  c       public.clients;
  v_label text; v_seats int; v_held int; v_pending int; v_has_seat boolean;
begin
  if not public.is_approved() then raise exception 'Only the Aviance team can invite a client.'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'That email address does not look right.'; end if;

  -- the lock first: every seat decision for this client is taken one at a time
  select * into c from public.clients where id = p_client for update;
  if c.id is null then raise exception 'That client is not here any more.'; end if;

  select label, portal_seats into v_label, v_seats from public.plan_prices where plan = c.plan;
  if not found then v_seats := public.plan_seats(c.plan); end if;   -- raises in plain English

  update public.portal_invites set status = 'revoked'
   where client_id = p_client and lower(email) = v_email and status = 'pending';

  if v_seats is not null then
    -- re-inviting someone who already signs in does not need another seat
    select exists(select 1 from public.client_people
                   where client_id = p_client and user_id is not null
                     and (id = p_person or lower(coalesce(email,'')) = v_email))
      into v_has_seat;
    if not v_has_seat then
      select count(*) into v_held from public.client_people
       where client_id = p_client and user_id is not null;
      select count(*) into v_pending from public.portal_invites
       where client_id = p_client and status = 'pending' and expires_at > now();
      if (v_held + v_pending) >= v_seats then
        raise exception '%', public.seat_full_message(c.company, coalesce(v_label, c.plan), v_seats, false)
          using errcode = 'ZS001';
      end if;
    end if;
  end if;

  insert into public.portal_invites(client_id, person_id, email, token_hash)
  values (p_client, p_person, v_email, public.invite_hash(raw));
  return raw;
end
$$;

/* ---------- 7. enforce AGAIN when the invite is ACCEPTED ---------- */

create or replace function public.portal_invite_consume(p_token text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  i public.portal_invites; per public.client_people; ch public.channels;
  c public.clients; v_label text; v_seats int; v_held int;
begin
  if exists (select 1 from public.profiles where id = p_user and approved and role in ('admin','employee')) then
    raise exception 'That email belongs to the Aviance team.';
  end if;
  update public.portal_invites set status = 'accepted', accepted_at = now(), accepted_user = p_user
   where token_hash = public.invite_hash(p_token) and status = 'pending' and expires_at > now()
   returning * into i;
  if not found then raise exception 'This link has already been used or has expired.'; end if;

  -- the same lock the issuing side takes. Two people opening the last invite at
  -- the same moment arrive here one after the other, and the second counts a
  -- total that already includes the first.
  select * into c from public.clients where id = i.client_id for update;

  if i.person_id is not null then select * into per from public.client_people where id = i.person_id and client_id = i.client_id; end if;
  if per.id is null then
    select * into per from public.client_people where client_id = i.client_id and lower(email) = lower(i.email) limit 1;
  end if;
  if per.id is null then
    insert into public.client_people(client_id, full_name, email) values (i.client_id, split_part(i.email,'@',1), i.email) returning * into per;
  end if;

  -- this login may already hold a seat somewhere; that one is given up first
  update public.client_people set user_id = null where user_id = p_user and id <> per.id;

  -- taking a seat they do not already hold? then there has to be one free.
  if per.user_id is distinct from p_user then
    select label, portal_seats into v_label, v_seats from public.plan_prices where plan = c.plan;
    if v_seats is not null then
      select count(*) into v_held from public.client_people
       where client_id = i.client_id and user_id is not null and id <> per.id;
      if v_held >= v_seats then
        -- one transaction: this unwinds the 'accepted' above, so the link is
        -- still good once a seat is freed.
        raise exception '%', public.seat_full_message(c.company, coalesce(v_label, c.plan), v_seats, true)
          using errcode = 'ZS001';
      end if;
    end if;
  end if;

  update public.client_people set user_id = p_user where id = per.id;
  update public.profiles set role = 'client', approved = false, name = per.full_name where id = p_user;

  select * into ch from public.channels where kind = 'client' and client_id = i.client_id and archived_at is null order by created_at limit 1;
  if not found then
    insert into public.channels(name, purpose, kind, client_id)
    values (c.company, 'Your direct line to the Aviance team', 'client', i.client_id) returning * into ch;
  end if;
  insert into public.channel_members(channel_id, person_id) values (ch.id, per.id) on conflict do nothing;
  return jsonb_build_object('ok', true, 'email', i.email, 'client_id', i.client_id, 'person_id', per.id, 'channel_id', ch.id);
end
$$;

/* ---------- 8. invite_peek tells the client about a full house ---------- */
-- So join.html can say it before they type a password, not after.
create or replace function public.invite_peek(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare i public.portal_invites; c public.clients; nm text; v_label text; v_seats int; v_held int;
begin
  select * into i from public.portal_invites where token_hash = public.invite_hash(p_token);
  if not found or i.status = 'revoked' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if i.status = 'accepted' then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if i.status = 'expired' or i.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into c from public.clients where id = i.client_id;
  select full_name into nm from public.client_people where id = i.person_id;

  select label, portal_seats into v_label, v_seats from public.plan_prices where plan = c.plan;
  if v_seats is not null then
    select count(*) into v_held from public.client_people
     where client_id = i.client_id and user_id is not null
       and (i.person_id is null or id <> i.person_id)
       and lower(coalesce(email,'')) <> lower(i.email);
    if v_held >= v_seats then
      return jsonb_build_object('ok', false, 'reason', 'seats_full',
        'message', public.seat_full_message(c.company, coalesce(v_label, c.plan), v_seats, true));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'email', i.email, 'company', c.company,
    'name', coalesce(nm, split_part(i.email,'@',1)));
end
$$;

/* ---------- 9. who may call what ---------- */
revoke all on function public.plan_seats(text)                  from public, anon;
revoke all on function public.portal_seat_state(uuid)           from public, anon;
revoke all on function public.portal_seat_free(uuid, text)      from public, anon;
grant execute on function public.plan_seats(text)               to authenticated;
grant execute on function public.portal_seat_state(uuid)        to authenticated;
grant execute on function public.portal_seat_free(uuid, text)    to authenticated;
grant execute on function public.seat_full_message(text, text, int, boolean) to authenticated, anon;
