-- 20261126_callers.sql — the three cold callers: their leads, their call log, their bookings (builder A).
-- Contract: /home/claude/callers/SPEC.md. Pattern: 20261125_staff.sql. Safe to run more than once.
--
-- The whole point of this file: three callers hired through an agency in Egypt sign in at aviance.store/callers
-- with an email address and an access code, see ONLY the leads assigned to them, log what happened to each call,
-- and book a discovery call with the owner while the prospect is still on the phone — and can reach NOTHING
-- else: no clients, no other bookings, no invoices, no agreements, no documents, no settings, no channels, no
-- staff rows, no other caller's leads, not even their own call log through a write — even if they call the REST
-- API straight with their own token.
--
-- Why a caller is a staff row with a 'kind'
--   The staff machinery from 20261125_staff.sql already does the hard part: a person who has no hub login, an
--   access code that IS her Supabase password (the staff-code edge function), a profiles row that can never be
--   approved into the team, and an is_approved() that is 'approved AND role in (admin, employee)' so a staff
--   login matches NO team policy anywhere. A caller is the same thing with kind = 'caller'. Vera, the first
--   employee, is kind = 'employee' — the column defaults to 'employee', so her row and her screen are untouched.
--
-- Where a caller and an employee part company
--   An employee has a private channel; a caller has none and needs none. So is_staff() and my_staff_channel()
--   are narrowed here to kind = 'employee': a caller matches none of the four staff policies and none of the
--   three staff_* calls. Her screen goes through the caller_* calls below, which touch no table from her side.
--   staff_list() is narrowed the same way so callers do not turn up on the Employees screen.
--
-- How the lock-out is enforced, in order of how much it is relied on
--   1. is_approved() is false for her (role 'staff'), and every team table's policy is keyed on is_approved()
--      or is_admin(). Checked against pg_policies on 2026-11-25: the only permissive policies in public that
--      are keyed on anything else are the client portal's (my_channel_ids / my_person_in — she is no client),
--      the employee's four (my_staff_channel — now employee-only), and 'website can book' on
--      discovery_bookings, which was open to 'authenticated'. That last one is the one real hole a caller
--      would have had: she could have inserted a booking of her own with no slot check and no caller_id. It is
--      closed below with a RESTRICTIVE policy, which ANDs with the website's own policy, so the public booking
--      form keeps working and she alone is refused.
--   2. Exactly two new permissive policies mention a caller: SELECT on her own leads, and SELECT on her own
--      call_log rows. There is deliberately no INSERT, UPDATE or DELETE policy for her anywhere — every write
--      she makes goes through a security definer function that checks is_caller() and re-checks ownership.
--   3. Her six calls are definer and all six refuse a revoked caller. Everything owner-side is gated on
--      is_admin() inside the function as well as by the grant (a definer function cannot identify its caller
--      with current_user — it is the owner — so the JWT is what is judged).
--
-- What is here
--   columns:  staff.kind, discovery_bookings.caller_id, and five columns on the existing public.call_log
--   table:    public.leads (+ RLS)
--   inside:   is_caller(), my_caller_id(), caller_bonus(), caller_lead_json()
--   owner:    callers_list, caller_add, caller_set_status, leads_import, callers_board
--   caller:   caller_me, caller_next, caller_log, caller_slots, caller_book
--   narrowed: is_staff(), my_staff_channel(), staff_list(), staff_invite_mail() (employee body moved aside
--             untouched as staff_invite_mail_core, the doc_get/doc_get_core pattern from the staff migration)
--   setting:  business key 'caller_bonus', default 25, read with biz('caller_bonus')
--
-- Why the existing public.call_log is extended rather than a second table made
--   The spec fixes the name 'call_log'. One already exists (the owner's own dialling screen, calling.js, keyed
--   on call_targets) and it is empty — 0 rows, as is call_targets. So it is extended, not replaced: target_id
--   becomes nullable, lead_id/caller_id/note/callback_at/created_at are added, and the outcome CHECK becomes
--   the union of both vocabularies with a second CHECK that pins a CALLER's row to exactly the seven outcomes
--   the spec names. calling.js keeps working unchanged (its rows have caller_id null).

-- ───────────────────────── staff.kind: employee or caller ─────────────────────────
alter table public.staff add column if not exists kind text not null default 'employee';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'staff_kind_check'
                 and conrelid = 'public.staff'::regclass) then
    alter table public.staff add constraint staff_kind_check check (kind in ('employee','caller'));
  end if;
end $$;

create index if not exists staff_kind_idx on public.staff (kind);

comment on column public.staff.kind is
  'employee = a hire with her own channel (Vera); caller = a cold caller with leads. Defaults to employee.';

-- ───────────────────────── the employee surface is employees only ─────────────────────────
-- A caller has no channel, so my_staff_channel() would return null for her anyway and the four staff policies
-- would match nothing. The kind test is here so that stays true even if someone later gives a caller a channel.
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path to 'public' as $fn$
  select exists(select 1 from public.staff s
                where s.user_id = auth.uid() and s.status in ('invited','active') and s.kind = 'employee');
$fn$;

create or replace function public.my_staff_channel()
returns uuid language sql stable security definer set search_path to 'public' as $fn$
  select s.channel_id
  from public.staff s
  join public.channels c on c.id = s.channel_id
  where s.user_id = auth.uid() and s.status in ('invited','active') and s.kind = 'employee'
    and c.kind = 'staff' and c.archived_at is null
  limit 1;
$fn$;

-- ───────────────────────── who she is ─────────────────────────
-- These two are called from inside RLS policies, so 'authenticated' must keep its default EXECUTE on them
-- (a policy's expression is evaluated with the privileges of the role running the query). They leak nothing:
-- both answer only about the caller who is asking.
create or replace function public.is_caller()
returns boolean language sql stable security definer set search_path to 'public' as $fn$
  select exists(select 1 from public.staff s
                where s.user_id = auth.uid() and s.status in ('invited','active') and s.kind = 'caller');
$fn$;

create or replace function public.my_caller_id()
returns uuid language sql stable security definer set search_path to 'public' as $fn$
  select s.id from public.staff s
  where s.user_id = auth.uid() and s.status in ('invited','active') and s.kind = 'caller'
  limit 1;
$fn$;

-- ───────────────────────── the bonus figure, in the business settings ─────────────────────────
-- $7/hour is the agency's to pay, so the board shows bonus money only: this per-meeting figure plus 2% of a
-- closed deal's first month. It lives where every other business setting lives (workspace_admin.data->business,
-- read by biz()), so he can change it in Settings without a deploy.
insert into public.workspace_admin (id, data)
values (1, jsonb_build_object('business', jsonb_build_object('caller_bonus', '25')))
on conflict (id) do update
  set data = coalesce(public.workspace_admin.data, '{}'::jsonb)
             || jsonb_build_object('business',
                  coalesce(public.workspace_admin.data->'business', '{}'::jsonb)
                  || jsonb_build_object('caller_bonus', '25'))
  where coalesce(public.workspace_admin.data->'business'->>'caller_bonus', '') = '';

-- Never throws on a typed-in value: anything that is not a plain number falls back to 25.
create or replace function public.caller_bonus()
returns numeric language sql stable security definer set search_path to 'public' as $fn$
  select case when coalesce(public.biz('caller_bonus'), '') ~ '^[0-9]{1,6}(\.[0-9]{1,2})?$'
              then public.biz('caller_bonus')::numeric else 25 end;
$fn$;

-- ───────────────────────── leads ─────────────────────────
-- assigned_to is a staff id, not an auth user id: the owner imports leads and splits them before the callers
-- have ever signed in. null = unassigned (nobody can see it but the owner).
--   status:  'new'      never rung
--            'calling'  rung at least once, still in play (a due callback_at puts it back at the top)
--            'done'     finished with — booked, not interested, wrong number or a bad fit
-- attempts and last_call_at are not in the spec's column list; they are here because without them a lead that
-- never answers would be served to her again and again forever (see caller_next).
create table if not exists public.leads (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  name         text,
  phone        text,
  email        text,
  timezone     text,
  notes        text,
  assigned_to  uuid references public.staff(id) on delete set null,
  status       text not null default 'new' check (status in ('new','calling','done')),
  outcome      text,
  callback_at  timestamptz,
  batch        text,
  attempts     integer not null default 0,
  last_call_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One import can be run twice by mistake, so a phone number or an email address may only be in the list once.
-- The phone is compared on its digits alone, so '+1 (212) 555-0190' and '12125550190' are the same lead.
create unique index if not exists leads_phone_uniq on public.leads (regexp_replace(phone, '\D', '', 'g'))
  where phone is not null and regexp_replace(phone, '\D', '', 'g') <> '';
create unique index if not exists leads_email_uniq on public.leads (lower(email))
  where email is not null and btrim(email) <> '';
create index if not exists leads_queue_idx    on public.leads (assigned_to, status, callback_at, created_at);
create index if not exists leads_batch_idx    on public.leads (batch);

comment on table  public.leads             is 'Cold-calling list. A caller sees only her own rows: see 20261126_callers.sql.';
comment on column public.leads.assigned_to is 'public.staff id of the caller it belongs to; null = unassigned.';

alter table public.leads enable row level security;

drop policy if exists "leads_admin_all" on public.leads;
create policy "leads_admin_all" on public.leads
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Her own leads, read only. Everything that changes a lead goes through caller_log / caller_book, so there is
-- deliberately no INSERT, UPDATE or DELETE policy for her: she cannot re-assign a lead to herself, cannot
-- un-finish one, cannot blank a note, cannot delete the evidence of a call.
drop policy if exists "leads_caller_reads_own" on public.leads;
create policy "leads_caller_reads_own" on public.leads
  for select to authenticated
  using (assigned_to is not null and assigned_to = public.my_caller_id());

-- Supabase grants the lot on a new public table to anon and authenticated; take it back and leave only what
-- the two policies above allow. anon gets nothing at all.
revoke all on table public.leads from anon, authenticated;
grant select, insert, update, delete on table public.leads to authenticated;

-- ───────────────────────── call_log: the same table, taught about leads ─────────────────────────
alter table public.call_log add column if not exists lead_id     uuid references public.leads(id) on delete cascade;
alter table public.call_log add column if not exists caller_id   uuid references public.staff(id) on delete set null;
alter table public.call_log add column if not exists note        text;
alter table public.call_log add column if not exists callback_at timestamptz;
alter table public.call_log add column if not exists created_at  timestamptz not null default now();
alter table public.call_log alter column target_id drop not null;

create index if not exists call_log_lead_idx   on public.call_log (lead_id, created_at desc);
create index if not exists call_log_caller_idx on public.call_log (caller_id, created_at desc);

comment on column public.call_log.caller_id is 'public.staff id of the cold caller. null = a row from the owner''s own dialling screen.';
comment on column public.call_log.lead_id   is 'public.leads id. The older rows point at call_targets through target_id instead.';

do $$ begin
  -- the union of the two vocabularies: the nine the owner's dialling screen already writes, plus the two the
  -- spec adds. Which seven a CALLER may use is pinned by the next constraint, not by this one.
  if exists (select 1 from pg_constraint where conname = 'call_log_outcome_check'
             and conrelid = 'public.call_log'::regclass
             and pg_get_constraintdef(oid) not like '%wrong_number%') then
    alter table public.call_log drop constraint call_log_outcome_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'call_log_outcome_check'
                 and conrelid = 'public.call_log'::regclass) then
    alter table public.call_log add constraint call_log_outcome_check check (outcome in (
      'no_answer','voicemail','gatekeeper','conversation','booked','not_interested','bad_number',
      'dnc_request','callback','wrong_number','bad_fit'));
  end if;

  -- a row belongs to one list or the other, never both and never neither
  if not exists (select 1 from pg_constraint where conname = 'call_log_one_list_check'
                 and conrelid = 'public.call_log'::regclass) then
    alter table public.call_log add constraint call_log_one_list_check
      check ((target_id is not null) <> (lead_id is not null));
  end if;

  -- a caller's row: a lead, never a call_target, and exactly the seven outcomes the spec names. Belt and
  -- braces under caller_log(), so even a future function cannot write an eighth outcome for her.
  if not exists (select 1 from pg_constraint where conname = 'call_log_caller_shape_check'
                 and conrelid = 'public.call_log'::regclass) then
    alter table public.call_log add constraint call_log_caller_shape_check
      check (caller_id is null or (lead_id is not null and target_id is null and outcome in (
        'no_answer','voicemail','not_interested','callback','wrong_number','booked','bad_fit')));
  end if;
end $$;

-- Her own rows, read only. The log is append-only from her side: no INSERT, UPDATE or DELETE policy, so the
-- only way a row with her caller_id can exist is caller_log() or caller_book().
drop policy if exists "call_log_caller_reads_own" on public.call_log;
create policy "call_log_caller_reads_own" on public.call_log
  for select to authenticated
  using (caller_id is not null and caller_id = public.my_caller_id());

-- ───────────────────────── discovery_bookings: credit, and the one hole closed ─────────────────────────
alter table public.discovery_bookings add column if not exists caller_id uuid references public.staff(id) on delete set null;
create index if not exists discovery_bookings_caller_idx on public.discovery_bookings (caller_id, created_at desc);
comment on column public.discovery_bookings.caller_id is 'The cold caller who booked it, if a caller did. Set only by caller_book().';

-- 'website can book' is granted to anon AND authenticated, with no is_approved() test — it is what the public
-- booking form uses. A caller is authenticated, so without this she could POST a booking of her own: any time
-- she liked, free slot or not, with no caller_id and no lead. A RESTRICTIVE policy ANDs with every permissive
-- one, so this refuses her and changes nothing for the website (anon and the owner both have is_caller() false).
-- caller_book() is a definer function owned by postgres and so is not subject to this.
drop policy if exists "callers never insert bookings" on public.discovery_bookings;
create policy "callers never insert bookings" on public.discovery_bookings
  as restrictive for insert to anon, authenticated
  with check (not public.is_caller());

-- and she may not change one either (there is no permissive UPDATE/DELETE policy for her at all; this is the
-- floor under that, in case a later migration adds a broad one)
drop policy if exists "callers never change bookings" on public.discovery_bookings;
create policy "callers never change bookings" on public.discovery_bookings
  as restrictive for update to anon, authenticated
  using (not public.is_caller()) with check (not public.is_caller());

-- ───────────────────────── one lead, as her screen wants it ─────────────────────────
-- Inside only (revoked below). A timezone we do not recognise falls back to the calendar's US zone rather than
-- throwing, so one bad cell in a CSV cannot take her screen down.
create or replace function public.caller_lead_json(p_lead uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare l public.leads; v_zone text; v_cal text;
begin
  select * into l from public.leads where id = p_lead;
  if not found then return null; end if;
  v_cal  := coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York');
  v_zone := coalesce(nullif(btrim(coalesce(l.timezone, '')), ''), v_cal);
  if not exists (select 1 from pg_timezone_names where name = v_zone) then v_zone := v_cal; end if;
  return jsonb_build_object(
    'id', l.id, 'company', l.company, 'name', l.name, 'phone', l.phone, 'email', l.email,
    'timezone', v_zone, 'notes', l.notes, 'status', l.status, 'outcome', l.outcome,
    'callback_at', l.callback_at, 'batch', l.batch, 'attempts', l.attempts,
    'last_call_at', l.last_call_at, 'created_at', l.created_at,
    -- the time where the prospect is, so she does not ring anyone at 3am
    'local_time', to_char(now() at time zone v_zone, 'HH24:MI'),
    'calls', (select count(*) from public.call_log cl where cl.lead_id = l.id));
end $fn$;

-- the next lead for one caller: a callback that is due first, then the ones never rung, oldest first, then
-- anything still in play. A future callback_at keeps a lead out of the queue until its time comes.
create or replace function public.caller_next_id(p_caller uuid)
returns uuid language sql stable security definer set search_path to 'public' as $fn$
  select l.id from public.leads l
  where l.assigned_to = p_caller and l.status <> 'done'
    and (l.callback_at is null or l.callback_at <= now())
  order by case when l.callback_at is not null then 0 when l.status = 'new' then 1 else 2 end,
           coalesce(l.callback_at, l.created_at), l.created_at
  limit 1;
$fn$;

-- her tally for today, in the calendar's US zone so "today" means the same thing to her and to him
create or replace function public.caller_today(p_caller uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $fn$
  with z as (select coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York') as zone),
  d as (select ((now() at time zone (select zone from z))::date) as today)
  select jsonb_build_object(
    'dials', (select count(*) from public.call_log cl, z
               where cl.caller_id = p_caller
                 and (cl.created_at at time zone z.zone)::date = (select today from d)),
    'booked', (select count(*) from public.discovery_bookings b, z
                where b.caller_id = p_caller and b.status <> 'cancelled'
                  and (b.created_at at time zone z.zone)::date = (select today from d)));
$fn$;

-- ───────────────────────── her side: five calls, no table writes ─────────────────────────
-- Every one of them starts the same way: find her by her JWT, refuse her if she is revoked or is not a caller.
create or replace function public.caller_me()
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_me uuid := auth.uid(); s public.staff; v_script text; v_next uuid;
begin
  select * into s from public.staff where user_id = v_me and kind = 'caller';
  if not found or s.status = 'revoked' then raise exception 'Please sign in again.'; end if;
  update public.staff
     set last_seen_at = now(), status = case when status = 'invited' then 'active' else status end
   where id = s.id;
  update public.profiles set last_seen_at = now() where id = v_me;

  v_script := nullif(btrim(coalesce(public.biz('caller_script'), '')), '');
  v_next   := public.caller_next_id(s.id);
  return jsonb_build_object(
    'caller', jsonb_build_object('id', s.id, 'name', s.name, 'email', s.email),
    'script_url', v_script,
    'today', public.caller_today(s.id),
    'lead', public.caller_lead_json(v_next),
    'waiting', (select count(*) from public.leads l
                 where l.assigned_to = s.id and l.status <> 'done'));
end $fn$;

create or replace function public.caller_next()
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_caller uuid := public.my_caller_id();
begin
  if v_caller is null then raise exception 'Please sign in again.'; end if;
  return public.caller_lead_json(public.caller_next_id(v_caller));
end $fn$;

-- One call, one row, and the lead moved on. Nothing here trusts the screen: the lead must be hers, the outcome
-- must be one of the seven, and a callback must have a time that is actually in the future.
create or replace function public.caller_log(p_lead uuid, p_outcome text, p_note text, p_callback timestamptz)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_caller uuid := public.my_caller_id();
  v_out    text := lower(btrim(coalesce(p_outcome, '')));
  v_note   text := nullif(left(btrim(coalesce(p_note, '')), 2000), '');
  l public.leads; v_status text; v_cb timestamptz; v_row uuid;
begin
  if v_caller is null then raise exception 'Please sign in again.'; end if;
  if v_out not in ('no_answer','voicemail','not_interested','callback','wrong_number','booked','bad_fit') then
    raise exception 'That is not an outcome we use.';
  end if;

  -- hers, and still open. A lead that is not hers is not even named in the error.
  select * into l from public.leads where id = p_lead and assigned_to = v_caller;
  if not found then raise exception 'That lead is not on your list.'; end if;

  if v_out = 'callback' then
    if p_callback is null then raise exception 'Pick the day and time to ring back.'; end if;
    if p_callback <= now() then raise exception 'That time has already gone. Pick a later one.'; end if;
    if p_callback > now() + interval '90 days' then raise exception 'Pick a time in the next three months.'; end if;
  end if;

  -- 'done' is the end of the road; no_answer and voicemail come round again in a few hours so the same number
  -- is not the next thing she sees over and over.
  v_status := case when v_out in ('not_interested','wrong_number','bad_fit','booked') then 'done' else 'calling' end;
  v_cb     := case when v_out = 'callback' then p_callback
                   when v_out in ('no_answer','voicemail') then now() + interval '3 hours' end;

  insert into public.call_log (lead_id, caller_id, outcome, note, callback_at, called_at, created_at)
  values (l.id, v_caller, v_out, v_note, case when v_out = 'callback' then p_callback end, now(), now())
  returning id into v_row;

  update public.leads
     set status = v_status, outcome = v_out, callback_at = v_cb,
         attempts = attempts + 1, last_call_at = now(), updated_at = now(),
         notes = case when v_note is null then notes
                      else left(coalesce(notes || E'\n', '') || to_char(now(), 'YYYY-MM-DD HH24:MI') || ' — ' || v_note, 8000) end
   where id = l.id;

  update public.staff set last_seen_at = now(),
         status = case when status = 'invited' then 'active' else status end
   where id = v_caller;

  return jsonb_build_object('ok', true, 'logged', jsonb_build_object('id', v_row, 'outcome', v_out, 'at', now()),
                            'lead_id', l.id, 'lead_status', v_status,
                            'today', public.caller_today(v_caller),
                            'next', public.caller_lead_json(public.caller_next_id(v_caller)));
end $fn$;

-- the owner's real free times, nothing more: a thin wrapper on free_slots() so her page never touches the
-- calendar, the meetings or the other bookings it is worked out from.
create or replace function public.caller_slots(p_days integer default 14)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare v_caller uuid := public.my_caller_id(); v_zone text;
begin
  if v_caller is null then raise exception 'Please sign in again.'; end if;
  v_zone := coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'starts_at', f.starts_at, 'minutes', f.minutes, 'zone', v_zone,
             'label', public.pretty_when(f.starts_at, v_zone))
           order by f.starts_at)
    from public.free_slots(least(greatest(coalesce(p_days, 14), 1), 31)) f), '[]'::jsonb);
end $fn$;

-- The booking, done the way the website does it, so every trigger that already exists fires: the confirmation
-- email is queued (discovery_bookings_confirm), the Jitsi link is stamped on (discovery_bookings_link), the
-- research engine is poked (booking_research), and mail-tick adds the Meet link. status 'booked', score null,
-- calendar_event_id null, call_at in the future — exactly the shape the 'website can book' policy demands,
-- even though a definer function is not subject to it.
--
-- All of it in one transaction, under the same advisory lock portal_book_kickoff() and sched_book() take, and
-- the slot is re-checked against free_slots() INSIDE the lock — so two callers racing for the last slot of the
-- day cannot both get it: the second one waits, re-checks, and is told to pick again.
create or replace function public.caller_book(p_lead uuid, p_start timestamptz, p_name text, p_email text,
                                              p_company text, p_phone text, p_timezone text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_caller uuid := public.my_caller_id();
  l public.leads; b public.discovery_bookings;
  v_name text; v_email text; v_company text; v_phone text; v_zone text; v_cal text; v_min int;
begin
  if v_caller is null then raise exception 'Please sign in again.'; end if;
  select * into l from public.leads where id = p_lead and assigned_to = v_caller;
  if not found then raise exception 'That lead is not on your list.'; end if;

  v_name    := nullif(left(btrim(coalesce(p_name,    l.name,    '')), 120), '');
  v_email   := lower(nullif(left(btrim(coalesce(p_email,   l.email,   '')), 200), ''));
  v_company := nullif(left(btrim(coalesce(p_company, l.company, '')), 160), '');
  v_phone   := nullif(left(btrim(coalesce(p_phone,   l.phone,   '')), 40), '');
  v_cal     := coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York');
  v_zone    := coalesce(nullif(btrim(coalesce(p_timezone, l.timezone, '')), ''), v_cal);
  if not exists (select 1 from pg_timezone_names where name = v_zone) then v_zone := v_cal; end if;

  if v_name is null    then raise exception 'We need the name of the person you spoke to.'; end if;
  if v_company is null then raise exception 'We need the company name.'; end if;
  if v_email is null or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'We need an email address that works, so we can send the invitation.';
  end if;
  if p_start is null then raise exception 'Pick a time first.'; end if;

  -- one booking at a time, so two callers cannot take the same slot
  perform pg_advisory_xact_lock(hashtext('aviance-calendar'));

  -- still free, inside the lock. free_slots() also enforces the notice period and the working day.
  select f.minutes into v_min from public.free_slots(31) f where f.starts_at = p_start;
  if v_min is null then raise exception 'That time has just gone. Please pick another.'; end if;

  insert into public.discovery_bookings
    (name, email, company, phone, call_at, minutes, timezone, source, status, score, calendar_event_id, caller_id)
  values (v_name, v_email, v_company, v_phone, p_start, v_min, v_zone, 'cold-call', 'booked', null, null, v_caller)
  returning * into b;

  -- the lead is finished with, and the call that did it is on the log
  update public.leads
     set status = 'done', outcome = 'booked', callback_at = null,
         attempts = attempts + 1, last_call_at = now(), updated_at = now()
   where id = l.id;

  insert into public.call_log (lead_id, caller_id, outcome, note, called_at, created_at, meeting_id)
  values (l.id, v_caller, 'booked',
          'Discovery call booked for ' || public.pretty_when(b.call_at, v_zone) || '.', now(), now(), null);

  update public.staff set last_seen_at = now(),
         status = case when status = 'invited' then 'active' else status end
   where id = v_caller;

  return jsonb_build_object('booking_id', b.id, 'starts_at', b.call_at, 'minutes', b.minutes,
                            'timezone', v_zone, 'label', public.pretty_when(b.call_at, v_zone),
                            'today', public.caller_today(v_caller),
                            'next', public.caller_lead_json(public.caller_next_id(v_caller)));
end $fn$;

-- ───────────────────────── owner side ─────────────────────────
create or replace function public.callers_list()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not public.is_admin() then raise exception 'Only the owner can see the callers.'; end if;
  return (
    select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) from (
      select jsonb_build_object(
               'id', s.id, 'name', s.name, 'email', s.email,
               -- 'new' means added but no access code yet; the screen only shows the three words from the spec
               'status', case when s.status = 'new' then 'invited' else s.status end,
               'code_set', (s.code_hash is not null),
               'last_seen_at', s.last_seen_at,
               'created_at', s.created_at,
               'leads', jsonb_build_object(
                 'total',   (select count(*) from public.leads l where l.assigned_to = s.id),
                 'waiting', (select count(*) from public.leads l where l.assigned_to = s.id and l.status <> 'done'),
                 'done',    (select count(*) from public.leads l where l.assigned_to = s.id and l.status = 'done'))) as x
      from public.staff s where s.kind = 'caller'
    ) q);
end $fn$;

-- Same shape as staff_add, minus the channel: a caller has no channel and needs none. The access code is made
-- afterwards by the staff-code edge function, exactly as it is for an employee.
create or replace function public.caller_add(p_name text, p_email text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_staff uuid;
begin
  if not public.is_admin() then raise exception 'Only the owner can add a caller.'; end if;
  if v_name = '' then raise exception 'Please give her name.'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'That email address does not look right.'; end if;
  if exists (select 1 from public.staff where lower(email) = v_email) then
    raise exception 'Someone with that email address is already on the team.';
  end if;
  -- an email that is already a hub login would come back as that person, not as a caller
  if exists (select 1 from public.profiles where lower(email) = v_email) then
    raise exception 'That email address already has an Aviance login.';
  end if;

  insert into public.staff (name, email, status, kind, channel_id)
  values (v_name, v_email, 'new', 'caller', null)
  returning id into v_staff;

  return jsonb_build_object('staff_id', v_staff, 'name', v_name, 'email', v_email, 'status', 'invited');
end $fn$;

create or replace function public.caller_set_status(p_staff uuid, p_status text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare v_status text := lower(btrim(coalesce(p_status, '')));
begin
  if not public.is_admin() then raise exception 'Only the owner can change a caller''s access.'; end if;
  if v_status not in ('active','invited','revoked') then raise exception 'That is not a status we use.'; end if;
  update public.staff set status = v_status where id = p_staff and kind = 'caller';
  if not found then raise exception 'That caller is not here any more.'; end if;
  -- a revoked caller keeps her name on her old calls (the log is history) but her leads go back in the pot,
  -- so the other two can ring them
  if v_status = 'revoked' then
    update public.leads set assigned_to = null, updated_at = now()
     where assigned_to = p_staff and status <> 'done';
  end if;
  return jsonb_build_object('id', p_staff, 'status', v_status);
end $fn$;

-- The CSV, already parsed in the browser: a jsonb array of {company, name, phone, email, timezone, notes}.
-- A row with no company is not a lead. A phone or an email that is already in the list is skipped, not
-- duplicated — the two unique indexes are the real guard, so running the same file twice adds nothing.
-- What is left is split evenly across the active callers, starting with whoever has the fewest leads waiting.
create or replace function public.leads_import(p_rows jsonb, p_batch text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_batch   text := nullif(left(btrim(coalesce(p_batch, '')), 80), '');
  v_callers uuid[];
  v_n       int;
  v_added   int := 0;
  v_skipped int := 0;
  v_i       int := 0;
  r         jsonb;
  v_company text; v_phone text; v_email text; v_who uuid; v_id uuid;
  v_counts  jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then raise exception 'Only the owner can import leads.'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'Nothing to import.'; end if;
  if jsonb_array_length(p_rows) > 20000 then raise exception 'That file is too big. Please split it.'; end if;

  select coalesce(array_agg(s.id order by q.waiting, s.created_at), '{}')
    into v_callers
    from public.staff s
    cross join lateral (select count(*) as waiting from public.leads l
                         where l.assigned_to = s.id and l.status <> 'done') q
   where s.kind = 'caller' and s.status in ('new','invited','active');
  v_n := coalesce(array_length(v_callers, 1), 0);

  for r in select * from jsonb_array_elements(p_rows) loop
    v_company := nullif(left(btrim(coalesce(r->>'company', '')), 160), '');
    v_phone   := nullif(left(btrim(coalesce(r->>'phone', '')), 40), '');
    v_email   := lower(nullif(left(btrim(coalesce(r->>'email', '')), 200), ''));
    -- no company, or neither a phone nor an email: not something anyone can ring
    if v_company is null or (v_phone is null and v_email is null) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    -- already on the list (by digits of the phone, or by email)
    if exists (select 1 from public.leads l
                where (v_phone is not null and regexp_replace(l.phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g')
                       and regexp_replace(v_phone, '\D', '', 'g') <> '')
                   or (v_email is not null and lower(l.email) = v_email)) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_who := case when v_n > 0 then v_callers[(v_i % v_n) + 1] end;

    insert into public.leads (company, name, phone, email, timezone, notes, assigned_to, batch)
    values (v_company,
            nullif(left(btrim(coalesce(r->>'name', '')), 120), ''),
            v_phone, v_email,
            nullif(left(btrim(coalesce(r->>'timezone', '')), 60), ''),
            nullif(left(btrim(coalesce(r->>'notes', '')), 4000), ''),
            v_who, v_batch)
    on conflict do nothing
    returning id into v_id;

    if v_id is null then
      v_skipped := v_skipped + 1;          -- a duplicate inside the file itself
    else
      v_added := v_added + 1;
      v_i     := v_i + 1;
      if v_who is not null then
        v_counts := v_counts || jsonb_build_object(v_who::text,
                      coalesce((v_counts->>v_who::text)::int, 0) + 1);
      end if;
    end if;
    v_id := null;
  end loop;

  return jsonb_build_object(
    'added', v_added, 'skipped', v_skipped,
    'assigned', case when v_n > 0 then v_added else 0 end,
    'batch', v_batch,
    'callers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name,
                                 'added', coalesce((v_counts->>s.id::text)::int, 0))
                                order by s.name)
                          from public.staff s where s.id = any(v_callers)), '[]'::jsonb));
end $fn$;

-- Who is producing, and what he owes. Money is bonus money only: $7/hour is the agency's.
--   showed  — the booking is one the pipeline counts as held (same rule as pipeline.js: held, contacted,
--             agreement_sent, won or lost, except a 'lost' whose reason is no_show or ghosted)
--   closed  — the booking went to 'won'
--   owed    — bonus per meeting that showed, plus 2% of the first month's fee of each closed deal
create or replace function public.callers_board(p_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare v_days int; v_from timestamptz; v_bonus numeric;
begin
  if not public.is_admin() then raise exception 'Only the owner can see the board.'; end if;
  v_days  := least(greatest(coalesce(p_days, 7), 1), 365);
  v_from  := now() - make_interval(days => v_days);
  v_bonus := public.caller_bonus();

  return jsonb_build_object(
    'days', v_days, 'from', v_from, 'bonus', v_bonus,
    'callers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name,
               'status', case when s.status = 'new' then 'invited' else s.status end,
               'dials', c.dials, 'conversations', c.conversations,
               'booked', b.booked, 'showed', b.showed, 'closed', b.closed,
               'bonus_owed', round(v_bonus * b.showed, 2),
               'deal_owed', round(b.fees * 0.02, 2),
               'owed', round(v_bonus * b.showed + b.fees * 0.02, 2),
               'waiting', (select count(*) from public.leads l where l.assigned_to = s.id and l.status <> 'done'))
             order by (v_bonus * b.showed + b.fees * 0.02) desc, s.name)
      from public.staff s
      cross join lateral (
        select count(*) as dials,
               count(*) filter (where cl.outcome in ('not_interested','callback','booked','bad_fit')) as conversations
          from public.call_log cl
         where cl.caller_id = s.id and cl.created_at >= v_from) c
      cross join lateral (
        select count(*) filter (where d.status <> 'cancelled') as booked,
               count(*) filter (where d.status in ('held','contacted','agreement_sent','won','lost')
                                  and not (d.status = 'lost' and coalesce(d.lost_reason,'') in ('no_show','ghosted'))) as showed,
               count(*) filter (where d.status = 'won') as closed,
               coalesce(sum(case when d.status = 'won'
                                 then coalesce((select cl2.monthly_fee from public.clients cl2
                                                 where cl2.booking_id = d.id limit 1), 0) end), 0)::numeric as fees
          from public.discovery_bookings d
         where d.caller_id = s.id and d.created_at >= v_from) b
      where s.kind = 'caller'), '[]'::jsonb),
    -- the last ~50 calls, whoever made them
    'feed', coalesce((
      select jsonb_agg(f order by f->>'at' desc) from (
        select jsonb_build_object(
                 'id', cl.id, 'at', cl.created_at, 'outcome', cl.outcome, 'note', cl.note,
                 'caller_id', cl.caller_id, 'caller', s.name,
                 'lead_id', cl.lead_id, 'company', l.company, 'lead_name', l.name) as f
          from public.call_log cl
          join public.staff s on s.id = cl.caller_id
          left join public.leads l on l.id = cl.lead_id
         where cl.caller_id is not null and cl.created_at >= v_from
         order by cl.created_at desc
         limit 50) q), '[]'::jsonb));
end $fn$;

-- ───────────────────────── the Employees screen stays employees only ─────────────────────────
-- Same body as 20261125_staff.sql, with 'where s.kind = ''employee''' added: without it the three callers
-- would appear on the Employees screen with no channel and break it.
create or replace function public.staff_list()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not public.is_admin() then raise exception 'Only the owner can see the team.'; end if;
  return (
    select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) from (
      select jsonb_build_object(
               'id', s.id, 'name', s.name, 'email', s.email,
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
      where s.kind = 'employee'
    ) q);
end $fn$;

-- ───────────────────────── the invite email a caller gets ─────────────────────────
-- The staff-code edge function calls staff_invite_mail() for everyone it sets a code for. The employee email
-- says "open your channel" and points at /team, which is wrong for a caller twice over. So the employee body
-- is moved aside untouched — the doc_get / doc_get_core trick from the staff migration — and the new
-- staff_invite_mail() picks by kind. Nothing about an employee's invite changes.
do $$ begin
  if to_regprocedure('public.staff_invite_mail_core(uuid, text)') is null then
    alter function public.staff_invite_mail(uuid, text) rename to staff_invite_mail_core;
  end if;
end $$;

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
  v_url    text; txt text; html text; v_mail uuid;
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

  txt := 'Hi ' || v_first || E',\n\n'
      || E'Welcome aboard. Your calling list is ready.\n\n'
      || E'Open it here:\n' || v_url || E'\n\n'
      || 'Sign in with ' || s.email || E' and this access code:\n\n'
      || '    ' || v_code || E'\n\n'
      || E'Keep the code to yourself. Once you are in, the page remembers you on that device, and it works on your phone.\n\n'
      || E'The page gives you one lead at a time with the number to ring, the script beside it, and a button for\n'
      || E'what happened on the call. If the prospect says yes, book the discovery call right there while you\n'
      || E'still have them on the phone.\n\n'
      || E'Any trouble getting in? Just reply to this email.\n\n'
      || 'Glad to have you.' || E'\n' || v_signer || E', Founder\nAviance\n';

  html := '<!doctype html><html lang="en"><head><meta charset="utf-8">'
       || '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviance</title></head>'
       || '<body style="margin:0;padding:24px;background:#F2F2F2;font-family:''Inter Tight'',Arial,Helvetica,sans-serif;color:#000">'
       || '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin:0 auto;background:#FFF">'
       || '<tr><td style="padding:22px 28px;border-bottom:2px solid #000;font-size:22px;font-weight:800;letter-spacing:-0.02em">Aviance</td></tr>'
       || '<tr><td style="padding:34px 28px 10px;font-size:18px;line-height:1.5">Hi ' || public.esc_html(v_first) || ','
       || '<div style="font-size:40px;line-height:1.05;font-weight:800;letter-spacing:-0.03em;padding:18px 0 10px">'
       || 'Your calling<br>list is ready<span style="color:#E0290F">.</span></div></td></tr>'
       || '<tr><td style="padding:10px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
       || '<tr><td align="center" bgcolor="#E0290F" style="background:#E0290F"><a href="' || public.esc_html(v_url)
       || '" style="display:block;padding:22px;font-size:24px;font-weight:800;color:#FFF;text-decoration:none">Open your list &rarr;</a>'
       || '</td></tr></table></td></tr>'
       || '<tr><td align="center" style="padding:16px 28px 4px;font-size:15px;color:#5C5C5C">Sign in with '
       || public.esc_html(s.email) || ' and the code below.</td></tr>'
       || '<tr><td align="center" style="padding:4px 28px 18px"><div style="display:inline-block;border:2px solid #000;padding:16px 26px">'
       || '<div style="' || mono || 'font-size:12px;font-weight:700;letter-spacing:0.16em;color:#5C5C5C;padding-bottom:6px">YOUR ACCESS CODE</div>'
       || '<div style="' || mono || 'font-size:32px;font-weight:700;letter-spacing:0.06em">' || public.esc_html(v_code) || '</div>'
       || '</div></td></tr>'
       || '<tr><td style="padding:22px 28px 30px;border-top:2px solid #000;font-size:17px;line-height:1.5">'
       || 'The page gives you one lead at a time with the number to ring, the script beside it, and a button for what '
       || 'happened on the call. If the prospect says yes, book the discovery call right there while you still have them '
       || 'on the phone.<div style="padding-top:22px">Glad to have you.<br><b>' || public.esc_html(v_signer)
       || ', Founder</b><br><span style="color:#5C5C5C">Aviance</span></div></td></tr>'
       || '</table></body></html>';

  insert into public.mail_outbox (to_email, to_name, subject, body_text, body_html, kind)
  values (s.email, s.name, 'Welcome to Aviance — your calling list is ready', txt, html, 'staff_invite')
  returning id into v_mail;

  return jsonb_build_object('mail_id', v_mail, 'to', s.email);
end $fn$;

-- the tiny escaper the email above uses (there was none in public; it is inside-only)
create or replace function public.esc_html(p_text text)
returns text language sql immutable as $fn$
  select replace(replace(replace(replace(coalesce(p_text,''), '&','&amp;'), '<','&lt;'), '>','&gt;'), '"','&quot;');
$fn$;

-- ───────────────────────── who may call what ─────────────────────────
-- Inside-only helpers. is_caller() and my_caller_id() are NOT revoked: both are used inside RLS policies, and
-- a policy's expression is evaluated with the querying role's privileges. Neither tells her anything she does
-- not already know about herself.
revoke execute on function
  public.caller_lead_json(uuid), public.caller_next_id(uuid), public.caller_today(uuid),
  public.caller_bonus(), public.staff_invite_mail_core(uuid, text)
  from public, anon, authenticated;

-- owner-only calls are gated on is_admin() inside as well; 'authenticated' only gets to try
revoke execute on function
  public.callers_list(), public.caller_add(text, text), public.caller_set_status(uuid, text),
  public.leads_import(jsonb, text), public.callers_board(integer)
  from public, anon;
grant execute on function
  public.callers_list(), public.caller_add(text, text), public.caller_set_status(uuid, text),
  public.leads_import(jsonb, text), public.callers_board(integer)
  to authenticated;

-- her five calls: a signed-in caller only (each one checks, and each one refuses a revoked caller)
revoke execute on function
  public.caller_me(), public.caller_next(), public.caller_log(uuid, text, text, timestamptz),
  public.caller_slots(integer),
  public.caller_book(uuid, timestamptz, text, text, text, text, text)
  from public, anon;
grant execute on function
  public.caller_me(), public.caller_next(), public.caller_log(uuid, text, text, timestamptz),
  public.caller_slots(integer),
  public.caller_book(uuid, timestamptz, text, text, text, text, text)
  to authenticated;

-- staff_invite_mail is called by the staff-code edge function with the service key; nobody else needs it
revoke execute on function public.staff_invite_mail(uuid, text) from public, anon;
grant execute on function public.staff_invite_mail(uuid, text) to authenticated;

-- PostgREST caches the list of callable functions; this makes the new caller_* and callers_* RPCs reachable
-- the moment the migration lands instead of on the next reload.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY: run these after applying. Every line says what it must say. Nothing here changes data
-- except steps 2-5, which are wrapped in a transaction and rolled back.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
--
-- 1. the shape is there, and Vera is untouched
--    select kind, count(*) from public.staff group by kind;            -- employee: 1 (Vera), caller: 0 so far
--    select column_name from information_schema.columns
--     where table_schema='public' and table_name='leads' order by ordinal_position;
--    select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='public.call_log'::regclass;
--      -- expect call_log_outcome_check (11 outcomes), call_log_one_list_check, call_log_caller_shape_check
--    select public.caller_bonus();                                     -- expect 25 (or whatever he has set)
--    select public.biz('caller_bonus');                                -- expect '25'
--    select polname, polpermissive, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
--      from pg_policy where polrelid = 'public.discovery_bookings'::regclass;
--      -- expect 'callers never insert bookings' and 'callers never change bookings' with polpermissive = false
--    select public.is_staff(), public.my_staff_channel();              -- as the owner: false, null
--
-- 2. AS THE OWNER. Add the three callers, give them a list, look at the board.
--    select public.caller_add('Mariam Hassan', 'mariam@example.com');  -> {"staff_id": ...}
--    select public.caller_add('Nour Adel',     'nour@example.com');
--    select public.caller_add('Salma Fawzy',   'salma@example.com');
--    select public.caller_add('Mariam Hassan', 'mariam@example.com');  -- expect: already on the team
--    select public.callers_list();                                     -- three rows, status 'invited', code_set false
--    select public.staff_list();                                       -- STILL ONLY VERA — no callers in it
--    select public.leads_import('[
--      {"company":"Acme Roofing","name":"Bob Vance","phone":"+1 (212) 555-0190","email":"bob@acme.com","timezone":"America/New_York","notes":"saw the ad"},
--      {"company":"Delta HVAC","name":"Jan Levin","phone":"2125550191","email":"jan@delta.com","timezone":"America/Chicago"},
--      {"company":"Echo Plumbing","name":"Pam B","phone":"2125550192","email":"pam@echo.com","timezone":"Mars/Phobos"},
--      {"company":"","name":"no company"},
--      {"company":"No Contact Ltd"},
--      {"company":"Dup Phone","phone":"1-212-555-0190","email":"other@x.com"},
--      {"company":"Dup Email","phone":"2125550199","email":"BOB@acme.com"}
--    ]'::jsonb, 'verify batch');
--      -- expect {"added": 3, "skipped": 4, "assigned": 3, ...}: no company, no phone AND no email, the same
--      -- number again (digits only), the same email again. Run it a second time: added 0, skipped 7.
--    select public.callers_board(7);     -- three callers, all zeros, bonus 25, feed []
--    select public.callers_board(0), public.callers_board(99999);      -- clamped to 1 and 365, no error
--
-- 3. Her login, through the real door (no passwords typed into a page, ever):
--    POST https://zjbxnkpktbghhudjbxhk.supabase.co/functions/v1/staff-code  { "staff_id": "<hers>" }
--    with his own session token. Expect { ok: true, code: "AVX-....-...." }. Then check the invite she got
--    points at /callers and not at /team:
--      select subject, left(body_text, 160) from public.mail_outbox
--       where kind = 'staff_invite' order by created_at desc limit 1;
--      -- expect 'your calling list is ready' and the line 'https://aviance.store/callers'
--    select status, code_set_at is not null, user_id is not null, kind from public.staff where kind='caller';
--    select role, approved from public.profiles where email = 'mariam@example.com';   -- 'staff', false
--
-- 4. AS HER. Needs step 3 first. Everything in one transaction, rolled back at the end.
--    begin;
--    select set_config('request.jwt.claims',
--      json_build_object('sub', (select user_id::text from public.staff
--                                 where kind = 'caller' and user_id is not null order by created_at limit 1),
--                        'role', 'authenticated')::text, true);
--    set local role authenticated;
--
--    -- she is a caller, and nothing else
--    select public.is_caller()       as must_be_true,
--           public.is_admin()        as must_be_false,
--           public.is_approved()     as must_be_false,
--           public.is_staff()        as must_be_false,   -- the EMPLOYEE surface is not hers
--           public.my_staff_channel() as must_be_null,
--           public.my_caller_id()    as her_staff_id;
--
--    -- her leads, and only hers
--    select count(*) as must_be_1, bool_and(assigned_to = public.my_caller_id()) as must_be_true
--      from public.leads;
--    -- her own profile row only; no staff row at all (it holds the hash of her access code)
--    select count(*) as must_be_1, bool_and(id = auth.uid()) as must_be_true from public.profiles;
--    select count(*) as must_be_0 from public.staff;
--
--    -- her five calls work
--    select public.caller_me();                       -- caller, script_url, today {dials,booked}, lead, waiting
--    select public.caller_next();                     -- the same lead
--    select public.caller_slots(14);                  -- the owner's real free times, nothing else
--    select public.caller_log((select id from public.leads limit 1), 'no_answer', 'rang out', null);
--                                                     -- {ok, logged, lead_status 'calling', today, next}
--    select public.caller_log((select id from public.leads limit 1), 'callback', 'Tuesday 10',
--                             now() + interval '2 days');
--    select count(*) as must_be_2, bool_and(caller_id = public.my_caller_id()) as must_be_true
--      from public.call_log;                          -- her own rows, and only hers
--    select public.caller_book((select id from public.leads where status <> 'done' limit 1),
--             (public.caller_slots(14)->0->>'starts_at')::timestamptz,
--             'Bob Vance', 'bob@acme.com', 'Acme Roofing', '+1 212 555 0190', 'America/New_York');
--                                                     -- {booking_id, starts_at, minutes, timezone, label, today, next}
--
--    -- the booking went down the real path: the confirmation is queued, the link is stamped, caller_id is set
--    -- (read these two back as the OWNER in step 6 — she cannot see either table)
--
--    -- ========== THE LEAK TEST. Every single number here must be 0. ==========
--    select (select count(*) from public.staff)                as staff,
--           (select count(*) from public.clients)              as clients,
--           (select count(*) from public.client_people)        as client_people,
--           (select count(*) from public.client_profiles)      as client_profiles,
--           (select count(*) from public.client_requests)      as client_requests,
--           (select count(*) from public.client_months)        as client_months,
--           (select count(*) from public.client_events)        as client_events,
--           (select count(*) from public.client_stage_history) as client_stages,
--           (select count(*) from public.client_agreements)    as client_agreements,
--           (select count(*) from public.agreements)           as agreements,
--           (select count(*) from public.agreement_pdfs)       as agreement_pdfs,
--           (select count(*) from public.invoices)             as invoices,
--           (select count(*) from public.refunds)              as refunds,
--           (select count(*) from public.discovery_bookings)   as bookings,
--           (select count(*) from public.meetings)             as meetings,
--           (select count(*) from public.qualified_calls)      as qualified_calls,
--           (select count(*) from public.schedule_offers)      as offers,
--           (select count(*) from public.precall_forms)        as precall_forms,
--           (select count(*) from public.research_briefs)      as briefs,
--           (select count(*) from public.research_log)         as research_log,
--           (select count(*) from public.handovers)            as handovers,
--           (select count(*) from public.journey_steps)        as journey,
--           (select count(*) from public.tasks)                as tasks,
--           (select count(*) from public.approvals)            as approvals,
--           (select count(*) from public.bot_drafts)           as drafts,
--           (select count(*) from public.channels)             as channels,
--           (select count(*) from public.channel_members)      as members,
--           (select count(*) from public.channel_messages)     as messages,
--           (select count(*) from public.call_targets)         as call_targets,
--           (select count(*) from public.dnc)                  as dnc,
--           (select count(*) from public.outreach_messages)    as outreach_messages,
--           (select count(*) from public.outreach_threads)     as outreach_threads,
--           (select count(*) from public.outreach_campaigns)   as outreach_campaigns,
--           (select count(*) from public.outreach_accounts)    as outreach_accounts,
--           (select count(*) from public.outreach_inboxes)     as outreach_inboxes,
--           (select count(*) from public.outreach_daily)       as outreach_daily,
--           (select count(*) from public.mail_outbox)          as mail,
--           (select count(*) from public.portal_invites)       as invites,
--           (select count(*) from public.testing_days)         as testing_days,
--           (select count(*) from public.plan_prices)          as plan_prices,
--           (select count(*) from public.calendar_settings)    as calendar_settings,
--           (select count(*) from public.calendar_blocks)      as calendar_blocks,
--           (select count(*) from public.workspace_admin)      as biz_settings,
--           (select count(*) from public.workspace_shared)     as shared_settings,
--           (select count(*) from public.v_money)              as v_money,
--           (select count(*) from public.v_exposure)           as v_exposure,
--           (select count(*) from public.v_invoice_work)       as v_invoice_work,
--           (select count(*) from public.v_month_standing)     as v_month_standing,
--           (select count(*) from public.v_outreach_summary)   as v_outreach_summary,
--           (select count(*) from public.v_mail_to_send)       as v_mail_to_send,
--           (select count(*) from public.v_booking_links)      as v_booking_links,
--           (select count(*) from public.leads
--             where assigned_to is distinct from public.my_caller_id()) as other_peoples_leads,
--           (select count(*) from public.call_log
--             where caller_id is distinct from public.my_caller_id()) as other_peoples_calls;
--      -- (public.v_call_hours is NOT in that list on purpose: it is the calendar's opening hours and is granted
--      --  to anon by design, because the public booking page needs them. It holds no names and no numbers.)
--
--    -- ========== THE REFUSALS. Every one of these must fail. ==========
--    -- she cannot book around caller_book: no slot check, no lead, no credit
--    insert into public.discovery_bookings (name, email, company, call_at, status)
--      values ('me','me@x.com','Mine', now() + interval '3 days', 'booked');
--                                                  -- expect: new row violates row-level security policy
--    update public.discovery_bookings set status = 'won';                    -- expect 0 rows or refused
--    -- she cannot write her own log, or anyone's
--    insert into public.call_log (lead_id, caller_id, outcome)
--      values ((select id from public.leads limit 1), public.my_caller_id(), 'booked');
--                                                  -- expect: new row violates row-level security policy
--    update public.call_log set note = 'nicer';                              -- expect 0 rows
--    delete from public.call_log;                                            -- expect 0 rows
--    -- she cannot take more work, un-finish a lead, or wipe one
--    update public.leads set assigned_to = public.my_caller_id();            -- expect 0 rows
--    update public.leads set status = 'new', notes = null;                   -- expect 0 rows
--    delete from public.leads;                                               -- expect 0 rows
--    insert into public.leads (company) values ('mine');                     -- expect refused
--    -- she cannot promote herself, or read the hash of her code
--    update public.staff set status = 'active', kind = 'employee';           -- expect 0 rows
--    update public.profiles set approved = true, role = 'admin';             -- expect 0 rows
--    -- the owner's calls refuse her
--    select public.callers_list();                   -- expect: Only the owner can see the callers.
--    select public.caller_add('x','x@example.com');  -- expect: Only the owner can add a caller.
--    select public.caller_set_status(public.my_caller_id(), 'active');  -- expect: Only the owner...
--    select public.leads_import('[]'::jsonb, 'x');   -- expect: Only the owner can import leads.
--    select public.callers_board(7);                 -- expect: Only the owner can see the board.
--    select public.staff_list();                     -- expect: Only the owner can see the team.
--    select public.biz_get();                        -- expect: refused (team function)
--    select public.documents_preview();              -- expect: refused or empty
--    select public.journey_board();                  -- expect: refused (team function)
--    select public.drafts_pending();                 -- expect: refused (team function)
--    select public.my_channels();                    -- expect: refused or empty
--    select public.portal_home();                    -- expect: null/refused (she is no client)
--    -- the employee's three calls are not hers either: she has no channel and is_staff() is false for her,
--    -- so all three refuse her with 'Your channel is not ready yet. Ask Aviance to check.'
--    select public.staff_me();                       -- expect: refused
--    select public.staff_send('nope', null);         -- expect: refused
--    select public.staff_seen();                     -- expect: refused
--    -- the inside helpers are not callable from the API
--    select public.caller_bonus();                   -- expect: permission denied for function
--    select public.caller_lead_json(gen_random_uuid());        -- expect: permission denied for function
--    select public.caller_next_id(public.my_caller_id());      -- expect: permission denied for function
--    select public.caller_today(public.my_caller_id());        -- expect: permission denied for function
--    select public.staff_invite_mail_core(gen_random_uuid(), 'x');  -- expect: permission denied for function
--    select public.aviance_owner();                  -- expect: permission denied for function
--    -- and the four ways she might try to cheat her own numbers
--    select public.caller_log((select id from public.leads limit 1), 'definitely_booked', null, null);
--                                                    -- expect: That is not an outcome we use.
--    select public.caller_log((select l.id from public.leads l
--                              where l.assigned_to is distinct from public.my_caller_id() limit 1),
--                             'booked', null, null);
--                                                    -- expect: That lead is not on your list.
--                                                    -- (as the owner, check such a lead exists first)
--    select public.caller_log((select id from public.leads limit 1), 'callback', null, now() - interval '1 day');
--                                                    -- expect: That time has already gone.
--    select public.caller_book((select id from public.leads limit 1), now() + interval '7 minutes',
--                             'x','x@example.com','X',null,null);
--                                                    -- expect: That time has just gone. Please pick another.
--    select public.caller_book((select id from public.leads limit 1),
--                             (public.caller_slots(14)->0->>'starts_at')::timestamptz,
--                             'x','not-an-email','X',null,null);
--                                                    -- expect: We need an email address that works...
--    select public.caller_book((select l.id from public.leads l
--                              where l.assigned_to is distinct from public.my_caller_id() limit 1),
--                             (public.caller_slots(14)->0->>'starts_at')::timestamptz,
--                             'x','x@example.com','X',null,null);
--                                                    -- expect: That lead is not on your list.
--
--    rollback;        -- undoes the verify calls, the log rows and the test booking
--    reset role;
--    select current_user;                            -- back to postgres
--
-- 5. the lock holds. In two psql sessions at the same time, as her:
--      session A:  begin; select public.caller_book(<her lead>, <the one free slot>, ...);   -- do not commit
--      session B:  begin; select public.caller_book(<her other lead>, <the SAME slot>, ...);
--    B blocks on the advisory lock. Commit A: B then wakes, re-checks free_slots() and raises
--    'That time has just gone. Please pick another.' — never two bookings on one slot.
--
-- 6. AS THE OWNER, after a real (committed) booking made by a caller:
--    select id, caller_id, source, status, score, calendar_event_id, meet_link, call_at
--      from public.discovery_bookings order by created_at desc limit 1;
--      -- caller_id = hers, source 'cold-call', status 'booked', score null, calendar_event_id null,
--      -- meet_link filled in by the discovery_bookings_link trigger
--    select kind, to_email, status, needs_meet_link from public.mail_outbox
--     where booking_id = '<that id>';                -- 'booking_confirmation', queued for the prospect
--    select status, outcome from public.leads where id = '<the lead>';     -- 'done', 'booked'
--    select outcome, caller_id from public.call_log where lead_id = '<the lead>' order by created_at desc limit 1;
--    select public.callers_board(7);
--      -- her row: dials 3, conversations 3, booked 1, showed 0, closed 0, owed 0.00
--    -- then, as he works the pipeline:  update … set status='held' → showed 1, owed 25.00
--    --                                  status='won' + a clients row at $3,000 → closed 1, owed 85.00
--
-- 7. revoke really locks her out: as the owner,
--      select public.caller_set_status('<her staff id>', 'revoked');
--    then repeat step 4 — is_caller() false, my_caller_id() null, leads and call_log both 0, and all five of
--    her calls raise 'Please sign in again.' Her unfinished leads go back to assigned_to null so the other two
--    can ring them; her old call_log rows and her bookings keep her name on them, because that is the history
--    his money is worked out from. Put her back with select public.caller_set_status('<id>', 'active') — then
--    re-import or re-assign her leads, because revoking gave them away.

-- ── Applied with these changes (lead, 2026-11-25) ─────────────────────────────
-- 1. leads: only SELECT is granted to authenticated. The table had full DML granted, with nothing
--    but the absence of a policy stopping a write; one careless policy later would have opened it.
-- 2. leads_import: a row with no company takes the contact's name instead of being skipped, so the
--    browser's "ready" count and the database's "imported" count agree.
-- 3. callers_board(1) means the calendar day where the calls happen, not a rolling 24 hours, so his
--    board and her own tally cannot disagree at midnight. The feed sorts on a real timestamp.
-- 4. staff_never_approved now fires on anyone in public.staff, not only on role 'staff': a caller or
--    an employee can never be promoted into the team from the Team screen by a misclick.
-- 5. New trigger booking_must_be_free: a booking written straight to the table (the public form, or
--    anyone holding the publishable key) must land on a slot free_slots still offers. The owner and
--    our own definer functions pass through, since they take the calendar lock themselves.
