-- The client connects their own calendar.
--
-- Why: booked calls should land on THEIR calendar, and we should be able to see
-- their free time so we stop offering slots they cannot do.
--
-- Three providers:
--   google     OAuth 2.0 authorization code flow, access_type=offline
--   microsoft  Microsoft identity platform v2.0 code flow, offline_access
--   calendly   a personal access token the client pastes. Calendly's own docs
--              say a PAT is the right thing for an internal integration over
--              one account, so there is no OAuth app to review for it.
--
-- WHERE THE SECRETS LIVE. Not here, and not in the repo. The OAuth app's client
-- id and secret are Supabase secrets, read by name inside the calendar-connect
-- edge function only:
--   GOOGLE_CALENDAR_CLIENT_ID        GOOGLE_CALENDAR_CLIENT_SECRET
--   MICROSOFT_CALENDAR_CLIENT_ID     MICROSOFT_CALENDAR_CLIENT_SECRET
--   MICROSOFT_CALENDAR_TENANT        (optional, defaults to 'common')
--   CALENDAR_CONNECT_REDIRECT        (optional, defaults to this project's
--                                     /functions/v1/calendar-connect/callback)
-- Nothing in this file holds, defaults to, or names a value of any of them.
--
-- WHERE THE CLIENT'S OWN TOKENS LIVE. calendar_tokens. These are per-client and
-- are minted at runtime, so they cannot be Supabase secrets. That table has RLS
-- ON and NO POLICY AT ALL: no browser, team member or client can read a row
-- from it, ever. Only the service role (the edge function) reaches it. The
-- browser sees calendar_connections, which holds status and an email address
-- and never a token.

/* ---------- 1. the connection a person can see ---------- */

create table if not exists public.calendar_connections (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  provider      text not null check (provider in ('google','microsoft','calendly')),
  status        text not null default 'connected'
                  check (status in ('connected','needs_reconnect','error','revoked')),
  account_email text,
  account_name  text,
  calendar_id   text,
  scopes        text,
  write_events  boolean not null default true,
  read_busy     boolean not null default true,
  connected_by  uuid,
  connected_at  timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);

comment on table public.calendar_connections is
  'One calendar a client has connected. Status and an account name only — never a token.';

create unique index if not exists calendar_connections_one_live_per_provider
  on public.calendar_connections(client_id, provider) where status <> 'revoked';

alter table public.calendar_connections enable row level security;

drop policy if exists "team reads calendar connections" on public.calendar_connections;
create policy "team reads calendar connections" on public.calendar_connections
  for select using (public.is_approved());
drop policy if exists "team writes calendar connections" on public.calendar_connections;
create policy "team writes calendar connections" on public.calendar_connections
  for all using (public.is_approved()) with check (public.is_approved());
-- a signed-in client sees their OWN company's connections and nobody else's
drop policy if exists "their own people read calendar connections" on public.calendar_connections;
create policy "their own people read calendar connections" on public.calendar_connections
  for select using (exists (
    select 1 from public.client_people p
     where p.user_id = auth.uid() and p.client_id = calendar_connections.client_id));

/* ---------- 2. the tokens nobody may read ---------- */

create table if not exists public.calendar_tokens (
  connection_id uuid primary key references public.calendar_connections(id) on delete cascade,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now()
);
comment on table public.calendar_tokens is
  'RLS is on and there is deliberately NO policy: only the service role (the calendar-connect edge function) can read or write a row. Never expose this through a view or a security definer function that returns a token.';
alter table public.calendar_tokens enable row level security;
revoke all on public.calendar_tokens from anon, authenticated;

/* ---------- 3. the one-click handshake ---------- */
-- A short-lived row per attempt: proves the callback belongs to the request we
-- started (CSRF) and carries the PKCE verifier. RLS on, no policy.
create table if not exists public.calendar_oauth_states (
  state         text primary key,
  client_id     uuid not null references public.clients(id) on delete cascade,
  provider      text not null check (provider in ('google','microsoft','calendly')),
  code_verifier text,
  started_by    uuid,
  return_to     text,
  expires_at    timestamptz not null default (now() + interval '15 minutes'),
  created_at    timestamptz not null default now()
);
alter table public.calendar_oauth_states enable row level security;
revoke all on public.calendar_oauth_states from anon, authenticated;

/* ---------- 4. their busy time ---------- */

create table if not exists public.calendar_busy (
  id            uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  fetched_at    timestamptz not null default now(),
  check (ends_at > starts_at)
);
comment on table public.calendar_busy is
  'Free/busy read back from the client''s own calendar. Times only, never a title, so a cached row says nothing about their business.';
create index if not exists calendar_busy_window on public.calendar_busy(client_id, starts_at, ends_at);

alter table public.calendar_busy enable row level security;
drop policy if exists "team reads calendar busy" on public.calendar_busy;
create policy "team reads calendar busy" on public.calendar_busy
  for select using (public.is_approved());
drop policy if exists "team writes calendar busy" on public.calendar_busy;
create policy "team writes calendar busy" on public.calendar_busy
  for all using (public.is_approved()) with check (public.is_approved());
drop policy if exists "their own people read calendar busy" on public.calendar_busy;
create policy "their own people read calendar busy" on public.calendar_busy
  for select using (exists (
    select 1 from public.client_people p
     where p.user_id = auth.uid() and p.client_id = calendar_busy.client_id));

/* ---------- 5. what the browser may ask ---------- */

-- May this caller connect a calendar for this client? Team, or one of that
-- client's own signed-in people.
create or replace function public.calendar_may_connect(p_client uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_approved() or exists (
    select 1 from public.client_people p where p.user_id = auth.uid() and p.client_id = p_client);
$$;

create or replace function public.calendar_connections_for(p_client uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  if not public.calendar_may_connect(p_client) then
    raise exception 'That is not your calendar to look at.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'provider', c.provider, 'status', c.status,
           'account_email', c.account_email, 'account_name', c.account_name,
           'calendar_id', c.calendar_id, 'write_events', c.write_events,
           'read_busy', c.read_busy, 'connected_at', c.connected_at,
           'last_synced_at', c.last_synced_at, 'last_error', c.last_error)
         order by c.provider), '[]'::jsonb)
    into v
    from public.calendar_connections c
   where c.client_id = p_client and c.status <> 'revoked';
  return v;
end
$$;

create or replace function public.calendar_disconnect(p_connection uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare c public.calendar_connections;
begin
  select * into c from public.calendar_connections where id = p_connection;
  if c.id is null then raise exception 'That calendar is not connected any more.'; end if;
  if not public.calendar_may_connect(c.client_id) then
    raise exception 'That is not your calendar to disconnect.';
  end if;
  update public.calendar_connections set status = 'revoked', last_error = null where id = c.id;
  delete from public.calendar_tokens where connection_id = c.id;
  delete from public.calendar_busy    where connection_id = c.id;
  insert into public.client_events(client_id, area, event, detail)
  values (c.client_id, 'calendar', 'disconnected',
          jsonb_build_object('provider', c.provider, 'account', c.account_email, 'by', auth.uid()));
  return jsonb_build_object('ok', true, 'provider', c.provider,
    'said', 'Disconnected. We will stop reading their free time and stop putting calls on that calendar.');
end
$$;

/* ---------- 6. what the edge function may ask (service role only) ---------- */

create or replace function public.calendar_state_new(p_client uuid, p_provider text, p_verifier text default null, p_return_to text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_state text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' and not public.calendar_may_connect(p_client) then
    raise exception 'That is not your calendar to connect.';
  end if;
  delete from public.calendar_oauth_states where expires_at < now();
  v_state := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.calendar_oauth_states(state, client_id, provider, code_verifier, started_by, return_to)
  values (v_state, p_client, lower(btrim(p_provider)), p_verifier, auth.uid(), p_return_to);
  return v_state;
end
$$;

-- One use. Taking a state deletes it, so a replayed callback finds nothing.
create or replace function public.calendar_state_take(p_state text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare s public.calendar_oauth_states;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Not allowed.'; end if;
  delete from public.calendar_oauth_states where state = p_state and expires_at > now() returning * into s;
  if s.state is null then return jsonb_build_object('ok', false, 'error', 'That connection attempt has expired. Start again.'); end if;
  return jsonb_build_object('ok', true, 'client_id', s.client_id, 'provider', s.provider,
    'code_verifier', s.code_verifier, 'return_to', s.return_to, 'started_by', s.started_by);
end
$$;

create or replace function public.calendar_connection_save(
  p_client uuid, p_provider text, p_email text, p_name text, p_calendar_id text,
  p_scopes text, p_access text, p_refresh text, p_expires timestamptz, p_by uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid; v_provider text := lower(btrim(coalesce(p_provider,'')));
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Not allowed.'; end if;

  select id into v_id from public.calendar_connections
   where client_id = p_client and provider = v_provider and status <> 'revoked';
  if v_id is null then
    insert into public.calendar_connections(client_id, provider, status, account_email, account_name,
                                            calendar_id, scopes, connected_by)
    values (p_client, v_provider, 'connected', p_email, p_name, p_calendar_id, p_scopes, p_by)
    returning id into v_id;
  else
    update public.calendar_connections
       set status = 'connected', account_email = coalesce(p_email, account_email),
           account_name = coalesce(p_name, account_name),
           calendar_id = coalesce(p_calendar_id, calendar_id),
           scopes = coalesce(p_scopes, scopes), last_error = null, connected_at = now()
     where id = v_id;
  end if;

  -- a refresh token is only sent once by Google; never overwrite one with null
  insert into public.calendar_tokens(connection_id, access_token, refresh_token, expires_at, updated_at)
  values (v_id, p_access, p_refresh, p_expires, now())
  on conflict (connection_id) do update
    set access_token  = excluded.access_token,
        refresh_token = coalesce(excluded.refresh_token, public.calendar_tokens.refresh_token),
        expires_at    = excluded.expires_at,
        updated_at    = now();

  insert into public.client_events(client_id, area, event, detail)
  values (p_client, 'calendar', 'connected',
          jsonb_build_object('provider', v_provider, 'account', p_email, 'by', p_by));
  return v_id;
end
$$;

create or replace function public.calendar_connection_trouble(p_connection uuid, p_status text, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' and not public.is_approved() then
    raise exception 'Not allowed.';
  end if;
  update public.calendar_connections
     set status = case when p_status in ('needs_reconnect','error','connected') then p_status else 'error' end,
         last_error = nullif(btrim(coalesce(p_error,'')), '')
   where id = p_connection;
end
$$;

create or replace function public.calendar_busy_put(p_connection uuid, p_from timestamptz, p_to timestamptz, p_busy jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare c public.calendar_connections; n int := 0;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' and not public.is_approved() then
    raise exception 'Not allowed.';
  end if;
  select * into c from public.calendar_connections where id = p_connection;
  if c.id is null then raise exception 'That calendar is not connected any more.'; end if;

  delete from public.calendar_busy
   where connection_id = p_connection and starts_at < p_to and ends_at > p_from;

  insert into public.calendar_busy(connection_id, client_id, starts_at, ends_at)
  select p_connection, c.client_id,
         (b->>'start')::timestamptz, (b->>'end')::timestamptz
    from jsonb_array_elements(coalesce(p_busy, '[]'::jsonb)) b
   where (b->>'end')::timestamptz > (b->>'start')::timestamptz;
  n := (select count(*) from public.calendar_busy where connection_id = p_connection);

  update public.calendar_connections set last_synced_at = now(), last_error = null where id = p_connection;
  return n;
end
$$;

/* ---------- 7. their free time, for the slot finder ---------- */
-- Busy intervals a client has on their own calendar in a window, merged. The
-- hub subtracts these so we stop offering a slot they cannot do.
create or replace function public.client_busy(p_client uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select b.starts_at, b.ends_at
    from public.calendar_busy b
    join public.calendar_connections c on c.id = b.connection_id and c.status = 'connected' and c.read_busy
   where b.client_id = p_client
     and b.starts_at < p_to and b.ends_at > p_from
     and public.calendar_may_connect(p_client)
   order by b.starts_at;
$$;

revoke all on function public.calendar_state_take(text)                          from public, anon, authenticated;
revoke all on function public.calendar_connection_save(uuid,text,text,text,text,text,text,text,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.calendar_may_connect(uuid)            to authenticated;
grant execute on function public.calendar_connections_for(uuid)        to authenticated;
grant execute on function public.calendar_disconnect(uuid)             to authenticated;
grant execute on function public.calendar_state_new(uuid,text,text,text) to authenticated;
grant execute on function public.calendar_busy_put(uuid,timestamptz,timestamptz,jsonb) to authenticated;
grant execute on function public.calendar_connection_trouble(uuid,text,text) to authenticated;
grant execute on function public.client_busy(uuid,timestamptz,timestamptz) to authenticated;
