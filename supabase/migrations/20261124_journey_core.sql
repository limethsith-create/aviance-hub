-- 20261124_journey_core.sql — the client journey after payment (builder A). Contract: spec/JOURNEY.md.
-- Payment is day 0. Six steps: kickoff (day 2), research (4), testing (11), build (13), onboarding (13), launch (14).
-- "late" is worked out (planned_on < today and not done), never stored.
--
-- What is here
--   channel_messages.msg_kind / meta, and the client insert rule now only lets a client post a plain 'chat'.
--   tables: journey_steps, bot_drafts, approvals, precall_forms, testing_days, schedule_offers (team reads, owner writes;
--           client logins read none of them directly, only through the portal_* functions).
--   team:   journey_get, journey_board, journey_set, journey_move, journey_start, drafts_pending, drafts_count,
--           draft_write, draft_send, draft_discard
--           (+ journey_board_one: journey_get's path when called straight from the API; not for direct use)
--   client: portal_journey
--   inside: journey_json (the one place the journey shape is built), journey_seed, aviance_owner, journey_hourly,
--           the triggers (first invoice paid -> journey_start; a client person linked to a login -> welcome draft)
--   cron:   'aviance-journey-hourly' -> journey_hourly() -> approval_reminders() when it exists.
--
-- Why four functions are SECURITY INVOKER (draft_write, journey_set, journey_move, journey_get):
-- the other builders call them from their own security-definer functions that a CLIENT login runs
-- (portal_offer_pick -> precall_request -> draft_write; portal_approve -> journey_set). Inside a definer
-- function auth.uid() is still the client, so an is_approved() check would refuse them. An invoker function
-- can tell the two apart: called straight from the API, current_user is 'authenticated'/'anon' and we check
-- the person; called from inside one of our own definer functions (or by service_role / cron), current_user is
-- the function owner and it is trusted. Direct team calls still go through the table rules (RLS) as well.
-- Every other function is security definer. All have search_path = public.
-- Safe to run more than once.

-- ───────────────────────── channel_messages: kind + meta ─────────────────────────
alter table public.channel_messages add column if not exists msg_kind text not null default 'chat';
alter table public.channel_messages add column if not exists meta jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'channel_messages_msg_kind_check') then
    alter table public.channel_messages add constraint channel_messages_msg_kind_check
      check (msg_kind in ('chat','bot','system','offer','approval','form','update'));
  end if;
end $$;

alter policy "client writes own messages" on public.channel_messages
  with check (author_user is null and author_person is not null and author_person = public.my_person_in(channel_id)
              and char_length(body) between 1 and 4000 and attachment_url is null and edited_at is null
              and deleted_at is null and msg_kind = 'chat' and meta is null);

-- ───────────────────────── tables ─────────────────────────
create table if not exists public.journey_steps (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  step       text not null check (step in ('kickoff','research','testing','build','onboarding','launch')),
  title      text not null,
  position   int  not null,
  planned_on date,
  status     text not null default 'todo' check (status in ('todo','doing','done')),
  done_at    timestamptz,
  note       text,
  unique (client_id, step)
);

create table if not exists public.bot_drafts (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients(id) on delete cascade,
  channel_id        uuid references public.channels(id) on delete set null,
  kind              text not null check (kind in ('reply','welcome','step','offer','update','reminder','approval','form')),
  body              text not null,
  msg_kind          text not null default 'bot' check (msg_kind in ('chat','bot','system','offer','approval','form','update')),
  meta              jsonb,
  status            text not null default 'pending' check (status in ('pending','sent','discarded')),
  reason            text,
  source_message_id uuid references public.channel_messages(id) on delete set null,
  created_at        timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        uuid,
  sent_message_id   uuid references public.channel_messages(id) on delete set null
);
create index if not exists bot_drafts_pending_idx on public.bot_drafts (created_at) where status = 'pending';
create index if not exists bot_drafts_client_idx on public.bot_drafts (client_id, created_at);

create table if not exists public.approvals (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  channel_id   uuid references public.channels(id) on delete set null,
  kind         text not null check (kind in ('icp','angles','copy')),
  title        text,
  body         text,
  status       text not null default 'pending' check (status in ('pending','approved','changes')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_name text,
  client_note  text,
  reminded_at  timestamptz
);
create index if not exists approvals_client_idx on public.approvals (client_id, requested_at);

create table if not exists public.precall_forms (
  client_id      uuid primary key references public.clients(id) on delete cascade,
  offer          text,
  best_customers text,
  deal_size      text,
  avoid          text,
  submitted_at   timestamptz,
  updated_at     timestamptz not null default now()
);

create table if not exists public.testing_days (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  on_date       date not null default current_date,
  sent          int,
  replies       int,
  leading_angle text,
  note          text,
  created_at    timestamptz not null default now(),
  unique (client_id, on_date)
);

create table if not exists public.schedule_offers (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  channel_id uuid references public.channels(id) on delete set null,
  kind       text not null check (kind in ('kickoff','onboarding')),
  options    jsonb not null default '[]'::jsonb,
  status     text not null default 'draft' check (status in ('draft','open','booked','expired')),
  meeting_id uuid references public.meetings(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists schedule_offers_channel_idx on public.schedule_offers (channel_id, status);

-- ───────────────────────── table rules: team reads, owner writes, clients nothing ─────────────────────────
do $$ declare t text; begin
  foreach t in array array['journey_steps','bot_drafts','approvals','precall_forms','testing_days','schedule_offers'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_team_read') then
      execute format('create policy %I on public.%I for select to authenticated using (public.is_approved())', t || '_team_read', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_admin_write') then
      execute format('create policy %I on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
                     t || '_admin_write', t);
    end if;
  end loop;
end $$;
-- draft_write is for the whole team, so the team may add (only add) drafts.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bot_drafts' and policyname = 'bot_drafts_team_insert') then
    create policy bot_drafts_team_insert on public.bot_drafts for insert to authenticated
      with check (public.is_approved() and status = 'pending');
  end if;
end $$;

-- ───────────────────────── helpers (inside only) ─────────────────────────
-- The owner: the first approved admin. Bot and system messages are posted as this person ("Aviance" to the client).
create or replace function public.aviance_owner() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles where role = 'admin' and approved order by created_at nulls last, id limit 1
$$;

-- The journey, as one jsonb. Null when the client is not here. No checks: callers check.
create or replace function public.journey_json(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.clients; v_paid date; v_launch date; v_steps jsonb; v_next text;
begin
  select * into c from public.clients where id = p_client;
  if not found then return null; end if;
  v_paid := coalesce(
    (select min(paid_at)::date from public.invoices where client_id = p_client and status = 'paid' and is_first),
    (select min(paid_at)::date from public.invoices where client_id = p_client and status = 'paid'));
  select planned_on into v_launch from public.journey_steps where client_id = p_client and step = 'launch';
  select step into v_next from public.journey_steps where client_id = p_client and status <> 'done' order by position limit 1;
  select coalesce(jsonb_agg(jsonb_build_object(
           'step', s.step, 'title', s.title, 'position', s.position, 'planned_on', s.planned_on,
           'status', s.status, 'done_at', s.done_at, 'note', s.note,
           'late', (s.planned_on < current_date and s.status <> 'done')) order by s.position), '[]'::jsonb)
    into v_steps from public.journey_steps s where s.client_id = p_client;
  return jsonb_build_object(
    'client_id', c.id, 'company', c.company, 'paid_on', v_paid, 'launch_on', v_launch,
    'days_to_launch', case when v_launch is null then null else v_launch - current_date end,
    'steps', v_steps, 'next_step', v_next);
end $$;

-- Makes the six steps (keeps any that are there). Day 0 = the first paid invoice, or today.
create or replace function public.journey_seed(p_client uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_paid date;
begin
  if not exists (select 1 from public.clients where id = p_client) then raise exception 'That client is not here any more.'; end if;
  v_paid := coalesce(
    (select min(paid_at)::date from public.invoices where client_id = p_client and status = 'paid' and is_first),
    (select min(paid_at)::date from public.invoices where client_id = p_client and status = 'paid'),
    current_date);
  insert into public.journey_steps (client_id, step, title, position, planned_on)
  select p_client, s.step, s.title, s.position, v_paid + s.day_off
    from (values ('kickoff',    'Kickoff call',                         1,  2),
                 ('research',   'Research: your market, ICP, angles',   2,  4),
                 ('testing',    'Market testing (message-market fit)',  3, 11),
                 ('build',      'Build the real campaign',              4, 13),
                 ('onboarding', 'Onboarding call',                      5, 13),
                 ('launch',     'Launch — month one starts',            6, 14)) as s(step, title, position, day_off)
  on conflict (client_id, step) do nothing;
end $$;

-- ───────────────────────── team functions ─────────────────────────
create or replace function public.journey_start(p_client uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and auth.uid() is not null then raise exception 'Only the owner can start a journey.'; end if;
  perform public.journey_seed(p_client);
end $$;

create or replace function public.journey_get(p_client uuid) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare j jsonb;
begin
  if current_user in ('authenticated','anon') and not public.is_approved() then
    raise exception 'Only the Aviance team can see the journey.';
  end if;
  if current_user in ('authenticated','anon') then
    -- straight from the API: the definer pieces are not granted to the API roles, so build it here
    j := (select public.journey_board_one(p_client));
  else
    j := public.journey_json(p_client);
  end if;
  if j is null then raise exception 'That client is not here any more.'; end if;
  return j;
end $$;

-- journey_get's API path. Team only; a definer so it can read invoices for paid_on.
create or replace function public.journey_board_one(p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() and auth.uid() is not null then raise exception 'Only the Aviance team can see the journey.'; end if;
  return public.journey_json(p_client);
end $$;

create or replace function public.journey_board() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() and auth.uid() is not null then raise exception 'Only the Aviance team can see the journey board.'; end if;
  return coalesce((
    select jsonb_agg(j order by (j->>'launch_on') nulls last, j->>'company')
      from (select public.journey_json(c.id) as j from public.clients c where c.stage in ('won','onboarding')) x), '[]'::jsonb);
end $$;

create or replace function public.journey_set(p_client uuid, p_step text, p_status text, p_note text default null) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare s public.journey_steps; v_old text;
begin
  if current_user in ('authenticated','anon') and not public.is_admin() then
    raise exception 'Only the owner can change the journey.';
  end if;
  if p_status not in ('todo','doing','done') then raise exception 'A step is todo, doing or done.'; end if;
  select * into s from public.journey_steps where client_id = p_client and step = p_step for update;
  if not found then raise exception 'That step is not in this client''s journey.'; end if;
  v_old := s.status;
  update public.journey_steps
     set status = p_status,
         done_at = case when p_status = 'done' then coalesce(done_at, now()) else null end,
         note = coalesce(p_note, note)
   where id = s.id;

  if p_status is distinct from v_old and p_status in ('doing','done')
     and to_regprocedure('public.step_message(uuid,text)') is not null then
    execute 'select public.step_message($1, $2)' using p_client, p_step;
  end if;

  if p_step = 'launch' and p_status = 'done' then
    update public.clients set day1_on = current_date, stage = 'live' where id = p_client and stage in ('won','onboarding');
  end if;
  return public.journey_get(p_client);
end $$;

create or replace function public.journey_move(p_client uuid, p_step text, p_planned date) returns jsonb
language plpgsql security invoker set search_path = public as $$
begin
  if current_user in ('authenticated','anon') and not public.is_admin() then
    raise exception 'Only the owner can move a step.';
  end if;
  if p_planned is null then raise exception 'Pick a date for the step.'; end if;
  update public.journey_steps set planned_on = p_planned where client_id = p_client and step = p_step;
  if not found then raise exception 'That step is not in this client''s journey.'; end if;
  return public.journey_get(p_client);
end $$;

-- Queue one draft for the owner to approve. The one helper every builder uses.
create or replace function public.draft_write(p_client uuid, p_kind text, p_body text, p_msg_kind text default 'bot',
                                              p_meta jsonb default null, p_reason text default null) returns uuid
language plpgsql security invoker set search_path = public as $$
declare v_ch uuid; v_id uuid;
begin
  if current_user in ('authenticated','anon') and not public.is_approved() then
    raise exception 'Only the Aviance team can write a draft.';
  end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'A draft needs some words.'; end if;
  if not exists (select 1 from public.clients where id = p_client) then raise exception 'That client is not here any more.'; end if;
  select id into v_ch from public.channels
   where kind = 'client' and client_id = p_client and archived_at is null order by created_at limit 1;
  insert into public.bot_drafts (client_id, channel_id, kind, body, msg_kind, meta, reason)
  values (p_client, v_ch, p_kind, p_body, coalesce(p_msg_kind, 'bot'), p_meta, p_reason)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.drafts_pending() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Only the Aviance team can see the drafts.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'client_id', d.client_id, 'company', c.company, 'channel_id', ch.id,
             'kind', d.kind, 'body', d.body, 'msg_kind', d.msg_kind, 'meta', d.meta, 'reason', d.reason,
             'created_at', d.created_at,
             'last_client_message', lm.body, 'last_client_message_at', lm.created_at)
           order by d.created_at)
      from public.bot_drafts d
      join public.clients c on c.id = d.client_id
      left join lateral (select coalesce(d.channel_id, (
               select x.id from public.channels x where x.kind = 'client' and x.client_id = d.client_id
                  and x.archived_at is null order by x.created_at limit 1)) as id) ch on true
      left join lateral (select m.body, m.created_at from public.channel_messages m
                          where m.channel_id = ch.id and m.author_person is not null and m.deleted_at is null
                          order by m.created_at desc limit 1) lm on true
     where d.status = 'pending'), '[]'::jsonb);
end $$;

create or replace function public.drafts_count() returns int
language sql stable security definer set search_path = public as $$
  select case when public.is_approved() then (select count(*)::int from public.bot_drafts where status = 'pending') else 0 end
$$;

create or replace function public.draft_send(p_draft uuid, p_body text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.bot_drafts; v_ch uuid; v_body text; v_msg uuid;
begin
  if not public.is_admin() then raise exception 'Only the owner can send a draft.'; end if;
  select * into d from public.bot_drafts where id = p_draft for update;
  if not found then raise exception 'That draft is not here any more.'; end if;
  if d.status <> 'pending' then raise exception 'That draft was already %.', d.status; end if;
  v_body := coalesce(nullif(btrim(p_body), ''), d.body);
  if char_length(v_body) > 4000 then raise exception 'That message is too long.'; end if;
  v_ch := coalesce(d.channel_id, (select id from public.channels where kind = 'client' and client_id = d.client_id
                                     and archived_at is null order by created_at limit 1));
  if v_ch is null then raise exception 'This client has no channel yet, so there is nowhere to send it.'; end if;

  insert into public.channel_messages (channel_id, author_user, body, msg_kind, meta)
  values (v_ch, coalesce(auth.uid(), public.aviance_owner()), v_body, d.msg_kind, d.meta)
  returning id into v_msg;

  update public.bot_drafts set status = 'sent', body = v_body, channel_id = v_ch, decided_at = now(),
         decided_by = auth.uid(), sent_message_id = v_msg
   where id = d.id;

  if d.kind = 'offer' and d.meta ? 'offer_id' then
    update public.schedule_offers set status = 'open', channel_id = coalesce(channel_id, v_ch)
     where id = (d.meta->>'offer_id')::uuid and status = 'draft';
  end if;
  return jsonb_build_object('message_id', v_msg);
end $$;

create or replace function public.draft_discard(p_draft uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the owner can discard a draft.'; end if;
  update public.bot_drafts set status = 'discarded', decided_at = now(), decided_by = auth.uid()
   where id = p_draft and status = 'pending';
  if not found then raise exception 'That draft is not waiting any more.'; end if;
end $$;

-- ───────────────────────── client ─────────────────────────
create or replace function public.portal_journey() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_client uuid;
begin
  if public.portal_home() is null then raise exception 'This portal is not set up for you yet.'; end if;
  select client_id into v_client from public.client_people where user_id = auth.uid() limit 1;
  if v_client is null then raise exception 'This portal is not set up for you yet.'; end if;
  return public.journey_json(v_client);
end $$;

-- ───────────────────────── triggers ─────────────────────────
-- First invoice paid (mark_paid) -> the six steps.
create or replace function public.trg_invoice_journey() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.journey_seed(new.client_id);
  return new;
end $$;
create or replace trigger invoices_journey_start after update of status on public.invoices
  for each row when (new.status = 'paid' and old.status is distinct from 'paid' and new.is_first)
  execute function public.trg_invoice_journey();

-- A client person linked to a login (portal_invite_consume) -> the welcome draft, once per client.
-- Deferred to the end of the transaction: portal_invite_consume makes the channel AFTER it links the person.
create or replace function public.trg_person_welcome() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_first text;
begin
  if exists (select 1 from public.bot_drafts where client_id = new.client_id and kind = 'welcome') then return null; end if;
  v_first := nullif(split_part(btrim(coalesce(new.full_name, '')), ' ', 1), '');
  perform public.draft_write(new.client_id, 'welcome',
    'Hi ' || coalesce(v_first, 'there') || ', welcome aboard. This is your direct line to us — I''ll send a few times for your kickoff call shortly.',
    'bot', null, 'they just joined the portal');
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'client_people_welcome' and tgrelid = 'public.client_people'::regclass) then
    create constraint trigger client_people_welcome after update of user_id on public.client_people
  deferrable initially deferred for each row
  when (old.user_id is null and new.user_id is not null)
  execute function public.trg_person_welcome();
  end if;
end $$;

-- ───────────────────────── hourly ─────────────────────────
create or replace function public.journey_hourly() returns void
language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.approval_reminders()') is not null then
    execute 'select public.approval_reminders()';
  end if;
end $$;

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'aviance-journey-hourly') then
    perform cron.schedule('aviance-journey-hourly', '17 * * * *', 'select public.journey_hourly();');
  end if;
end $$;

-- ───────────────────────── who may call what ─────────────────────────
revoke execute on function
  public.aviance_owner(), public.journey_json(uuid), public.journey_seed(uuid), public.journey_hourly(),
  public.trg_invoice_journey(), public.trg_person_welcome()
  from public, anon, authenticated;

revoke execute on function
  public.journey_start(uuid), public.journey_get(uuid), public.journey_board_one(uuid), public.journey_board(),
  public.journey_set(uuid, text, text, text), public.journey_move(uuid, text, date),
  public.draft_write(uuid, text, text, text, jsonb, text), public.drafts_pending(), public.drafts_count(),
  public.draft_send(uuid, text), public.draft_discard(uuid), public.portal_journey()
  from public, anon;
grant execute on function
  public.journey_start(uuid), public.journey_get(uuid), public.journey_board_one(uuid), public.journey_board(),
  public.journey_set(uuid, text, text, text), public.journey_move(uuid, text, date),
  public.draft_write(uuid, text, text, text, jsonb, text), public.drafts_pending(), public.drafts_count(),
  public.draft_send(uuid, text), public.draft_discard(uuid), public.portal_journey()
  to authenticated, service_role;
