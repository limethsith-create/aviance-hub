-- 20261207_prospect_access.sql — the prospect window (prospects.js) and the smallest
-- grant model that lets the owner appoint a named person to one client's prospects,
-- and to nothing else at all.  Builder C.
--
-- WHY A GRANT TABLE AND NOT A ROLE
--   Every team table in this database is read through is_approved() — 'approved AND
--   role in (admin, employee)'.  That is all-or-nothing: an employee who may see one
--   client's leads would, with that role, also see every other client, every meeting,
--   every month and every call.  A new role would have the same shape: a role is a
--   property of the person, and what the owner wants to hand out is a property of the
--   PAIR (person, client).  So the grant is the pair, in one table, and nothing else
--   about the person changes.
--
--     prospect_grants (user_id, client_id)  — made and revoked only by the owner
--
--   The grant alone is the appointment: the person needs no role, no approval and no
--   other row.  is_approved() is untouched, so a grant-holder who is not approved team
--   still matches no other table's policy and still sees zero rows everywhere else —
--   no money, no invoices, no agreements, no settings, no other client.  index.html
--   lets such a person in with the Prospects screen and nothing beside it.
--
-- WHAT CHANGES FOR THE SIX OUTREACH TABLES
--   They were readable by every approved team member (is_approved()), which means a
--   junior employee could read every client's prospect list.  Reading is now
--   can_see_prospects(client_id) — the owner, or a live grant for that row's client.
--   Writing is unchanged (is_approved()), only split out of the old ALL policy so that
--   policy can no longer grant a read.  The sync function runs as service_role and is
--   not affected by RLS either way.
--
-- WHAT A GRANT-HOLDER CANNOT READ DIRECTLY, AND SO COMES THROUGH A FUNCTION
--   `clients` carries monthly_fee, and `meetings` is team-only.  Two security-definer
--   functions hand over exactly the two things the screen needs and not a column more:
--     prospect_clients()            → [{id, company}] for the clients you may see
--     prospect_window(p_thread)     → one thread, its messages, its campaign's name,
--                                     and the call booked off it (time, status, guest)
--   Both refuse a client_id the caller has no grant for.
--
-- Safe to run twice.  No key, no token, no data write.

-- ───────────────────────── the grant ─────────────────────────

create table if not exists public.prospect_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  client_id   uuid not null references public.clients(id)  on delete cascade,
  granted_by  uuid references public.profiles(id),
  note        text,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- One live grant per person per client; a revoked one stays as the record of what was
-- given and when it was taken away.
create unique index if not exists prospect_grants_live_uq
  on public.prospect_grants (user_id, client_id) where revoked_at is null;
create index if not exists prospect_grants_user_idx on public.prospect_grants (user_id);
create index if not exists prospect_grants_client_idx on public.prospect_grants (client_id);

alter table public.prospect_grants enable row level security;

-- The owner makes and revokes them.  A person may read their own, so the hub can tell
-- them which clients they hold — a grant row names nothing but a client id.
drop policy if exists prospect_grants_admin_all on public.prospect_grants;
create policy prospect_grants_admin_all on public.prospect_grants
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists prospect_grants_read_own on public.prospect_grants;
create policy prospect_grants_read_own on public.prospect_grants
  for select using (user_id = auth.uid());

-- The one question every policy below asks.  Definer, because it reads profiles and
-- the grant table on behalf of someone who may read neither.
create or replace function public.can_see_prospects(p_client uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_client is not null and (
    public.is_admin()
    or exists (select 1 from public.prospect_grants g
                where g.user_id = auth.uid()
                  and g.client_id = p_client
                  and g.revoked_at is null)
  );
$$;
revoke execute on function public.can_see_prospects(uuid) from public, anon;
grant execute on function public.can_see_prospects(uuid) to authenticated, service_role;

-- Does the person signed in hold any live grant?  index.html asks this to decide
-- whether somebody who is not approved team may enter with the Prospects screen.
create or replace function public.prospect_seat()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.prospect_grants g
                  where g.user_id = auth.uid() and g.revoked_at is null);
$$;
revoke execute on function public.prospect_seat() from public, anon;
grant execute on function public.prospect_seat() to authenticated, service_role;

-- ──────────────── the six outreach tables: read by grant ────────────────

-- outreach_accounts
drop policy if exists outreach_accounts_team_read  on public.outreach_accounts;
drop policy if exists outreach_accounts_team_write on public.outreach_accounts;
drop policy if exists outreach_accounts_read on public.outreach_accounts;
create policy outreach_accounts_read on public.outreach_accounts
  for select using (public.can_see_prospects(client_id));
drop policy if exists outreach_accounts_insert on public.outreach_accounts;
create policy outreach_accounts_insert on public.outreach_accounts
  for insert with check (public.is_approved());
drop policy if exists outreach_accounts_update on public.outreach_accounts;
create policy outreach_accounts_update on public.outreach_accounts
  for update using (public.is_approved()) with check (public.is_approved());
drop policy if exists outreach_accounts_delete on public.outreach_accounts;
create policy outreach_accounts_delete on public.outreach_accounts
  for delete using (public.is_approved());

-- outreach_campaigns
drop policy if exists outreach_campaigns_team_read  on public.outreach_campaigns;
drop policy if exists outreach_campaigns_team_write on public.outreach_campaigns;
drop policy if exists outreach_campaigns_read on public.outreach_campaigns;
create policy outreach_campaigns_read on public.outreach_campaigns
  for select using (public.can_see_prospects(client_id));
drop policy if exists outreach_campaigns_insert on public.outreach_campaigns;
create policy outreach_campaigns_insert on public.outreach_campaigns
  for insert with check (public.is_approved());
drop policy if exists outreach_campaigns_update on public.outreach_campaigns;
create policy outreach_campaigns_update on public.outreach_campaigns
  for update using (public.is_approved()) with check (public.is_approved());
drop policy if exists outreach_campaigns_delete on public.outreach_campaigns;
create policy outreach_campaigns_delete on public.outreach_campaigns
  for delete using (public.is_approved());

-- outreach_daily
drop policy if exists outreach_daily_team_read  on public.outreach_daily;
drop policy if exists outreach_daily_team_write on public.outreach_daily;
drop policy if exists outreach_daily_read on public.outreach_daily;
create policy outreach_daily_read on public.outreach_daily
  for select using (public.can_see_prospects(client_id));
drop policy if exists outreach_daily_insert on public.outreach_daily;
create policy outreach_daily_insert on public.outreach_daily
  for insert with check (public.is_approved());
drop policy if exists outreach_daily_update on public.outreach_daily;
create policy outreach_daily_update on public.outreach_daily
  for update using (public.is_approved()) with check (public.is_approved());
drop policy if exists outreach_daily_delete on public.outreach_daily;
create policy outreach_daily_delete on public.outreach_daily
  for delete using (public.is_approved());

-- outreach_inboxes
drop policy if exists outreach_inboxes_team_read  on public.outreach_inboxes;
drop policy if exists outreach_inboxes_team_write on public.outreach_inboxes;
drop policy if exists outreach_inboxes_read on public.outreach_inboxes;
create policy outreach_inboxes_read on public.outreach_inboxes
  for select using (public.can_see_prospects(client_id));
drop policy if exists outreach_inboxes_insert on public.outreach_inboxes;
create policy outreach_inboxes_insert on public.outreach_inboxes
  for insert with check (public.is_approved());
drop policy if exists outreach_inboxes_update on public.outreach_inboxes;
create policy outreach_inboxes_update on public.outreach_inboxes
  for update using (public.is_approved()) with check (public.is_approved());
drop policy if exists outreach_inboxes_delete on public.outreach_inboxes;
create policy outreach_inboxes_delete on public.outreach_inboxes
  for delete using (public.is_approved());

-- outreach_threads
drop policy if exists outreach_threads_team_read  on public.outreach_threads;
drop policy if exists outreach_threads_team_write on public.outreach_threads;
drop policy if exists outreach_threads_read on public.outreach_threads;
create policy outreach_threads_read on public.outreach_threads
  for select using (public.can_see_prospects(client_id));
drop policy if exists outreach_threads_insert on public.outreach_threads;
create policy outreach_threads_insert on public.outreach_threads
  for insert with check (public.is_approved());
drop policy if exists outreach_threads_update on public.outreach_threads;
create policy outreach_threads_update on public.outreach_threads
  for update using (public.is_approved()) with check (public.is_approved());
drop policy if exists outreach_threads_delete on public.outreach_threads;
create policy outreach_threads_delete on public.outreach_threads
  for delete using (public.is_approved());

-- outreach_messages
drop policy if exists outreach_messages_team_read  on public.outreach_messages;
drop policy if exists outreach_messages_team_write on public.outreach_messages;
drop policy if exists outreach_messages_read on public.outreach_messages;
create policy outreach_messages_read on public.outreach_messages
  for select using (public.can_see_prospects(client_id));
drop policy if exists outreach_messages_insert on public.outreach_messages;
create policy outreach_messages_insert on public.outreach_messages
  for insert with check (public.is_approved());
drop policy if exists outreach_messages_update on public.outreach_messages;
create policy outreach_messages_update on public.outreach_messages
  for update using (public.is_approved()) with check (public.is_approved());
drop policy if exists outreach_messages_delete on public.outreach_messages;
create policy outreach_messages_delete on public.outreach_messages
  for delete using (public.is_approved());

-- The screen pages by the newest message, filtered by client, campaign, sentiment and
-- whether a call was booked.  One index per shape it asks for.
create index if not exists outreach_threads_client_last_idx
  on public.outreach_threads (client_id, last_message_at desc nulls last);
create index if not exists outreach_threads_campaign_last_idx
  on public.outreach_threads (campaign_id, last_message_at desc nulls last);
create index if not exists outreach_threads_meeting_idx
  on public.outreach_threads (meeting_id) where meeting_id is not null;

-- ─────────────── what a grant-holder may not read directly ───────────────

-- The clients whose prospects you may see, by name.  `clients` itself carries
-- monthly_fee and is admin-write / team-read, so this hands over two columns only.
create or replace function public.prospect_clients()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'company', c.company)
                            order by c.company), '[]'::jsonb)
    from public.clients c
   where public.can_see_prospects(c.id);
$$;
revoke execute on function public.prospect_clients() from public, anon;
grant execute on function public.prospect_clients() to authenticated, service_role;

-- One prospect, whole: the company and the person, every message both ways, the
-- campaign it belongs to and the call booked off it.  Refuses a thread whose client
-- the caller holds no grant for — the same question the table policy asks.
create or replace function public.prospect_window(p_thread uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t public.outreach_threads; out jsonb;
begin
  if p_thread is null then return null; end if;
  select * into t from public.outreach_threads where id = p_thread;
  if not found then return null; end if;
  if not public.can_see_prospects(t.client_id) then
    raise exception 'You have not been given this client''s prospects.' using errcode = '42501';
  end if;
  out := jsonb_build_object(
    'thread', jsonb_build_object(
      'id', t.id, 'client_id', t.client_id, 'campaign_id', t.campaign_id,
      'lead_name', t.lead_name, 'lead_email', t.lead_email,
      'lead_company', t.lead_company, 'lead_title', t.lead_title,
      'sentiment', t.sentiment, 'status', t.status, 'owner', t.owner,
      'meeting_id', t.meeting_id, 'last_message_at', t.last_message_at,
      'created_at', t.created_at, 'external_id', t.external_id),
    'client', (select jsonb_build_object('id', c.id, 'company', c.company)
                 from public.clients c where c.id = t.client_id),
    'campaign', (select jsonb_build_object('id', ca.id, 'name', ca.name, 'status', ca.status,
                                           'started_on', ca.started_on, 'sent', ca.sent,
                                           'replied', ca.replied, 'booked', ca.booked)
                   from public.outreach_campaigns ca where ca.id = t.campaign_id),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'direction', m.direction, 'subject', m.subject, 'body', m.body,
               'sent_at', m.sent_at, 'delivery', m.delivery, 'delivery_error', m.delivery_error,
               'author_user', m.author_user)
             order by m.sent_at, m.created_at)
        from public.outreach_messages m where m.thread_id = t.id), '[]'::jsonb),
    'call', (select jsonb_build_object('id', mt.id, 'starts_at', mt.starts_at, 'minutes', mt.minutes,
                                       'time_zone', mt.time_zone, 'status', mt.status, 'kind', mt.kind,
                                       'guest_name', mt.guest_name, 'guest_email', mt.guest_email,
                                       'held_at', mt.held_at, 'meet_link', mt.meet_link)
               from public.meetings mt where mt.id = t.meeting_id));
  return out;
end $$;
revoke execute on function public.prospect_window(uuid) from public, anon;
grant execute on function public.prospect_window(uuid) to authenticated, service_role;
