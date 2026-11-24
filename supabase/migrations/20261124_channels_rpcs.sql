-- Channels: the four database functions the team's Channels screen (channels-api.js) calls.
-- Written against the live tables: channels, channel_members, channel_messages, client_people, profiles, clients.
--   my_channels()                          -> jsonb array, every channel the caller sees, with unread counts
--   mark_channel_read(c)                   -> void, the caller has read channel c up to now
--   channel_people(p_ids)                  -> jsonb array, names for team user ids AND client person ids
--   ensure_client_channel(p_client_id, p_name) -> uuid, the client's channel (made if missing)
-- All four are team-only (public.is_approved()); a client login gets a plain refusal.
-- Client logins never call these: they use portal_home() and the client RLS policies, which are unchanged.

-- ───────────────────────── my_channels ─────────────────────────
-- The team sees every client channel, plus team/internal channels they are a member of or created.
-- unread = live messages from someone else after the caller's last_read_at. A member who has never
-- opened the channel (last_read_at null, e.g. the owner row close_won makes) has everything unread.
-- No membership row at all = nothing unread.
create or replace function public.my_channels() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.is_approved() then raise exception 'Only the Aviance team can see the channels.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'name', c.name, 'purpose', c.purpose, 'kind', c.kind, 'client_id', c.client_id,
             'company', cl.company, 'archived_at', c.archived_at, 'created_at', c.created_at,
             'last_message_at', lm.created_at, 'last_body', lm.body,
             'unread', case when me.id is null then 0 else (
                 select count(*) from public.channel_messages m
                  where m.channel_id = c.id and m.deleted_at is null
                    and m.author_user is distinct from v_uid
                    and (me.last_read_at is null or m.created_at > me.last_read_at)) end)
           order by coalesce(lm.created_at, c.created_at) desc)
      from public.channels c
      left join public.clients cl on cl.id = c.client_id
      left join public.channel_members me on me.channel_id = c.id and me.user_id = v_uid
      left join lateral (select m.created_at, m.body from public.channel_messages m
                          where m.channel_id = c.id and m.deleted_at is null
                          order by m.created_at desc limit 1) lm on true
     where c.kind = 'client' or me.id is not null or c.created_by = v_uid
  ), '[]'::jsonb);
end $$;

-- ───────────────────────── mark_channel_read ─────────────────────────
-- Upserts the caller's own member row (adds them as a member if missing) with last_read_at = now().
create or replace function public.mark_channel_read(c uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Only the Aviance team can do that.'; end if;
  if c is null or not exists (select 1 from public.channels where id = c) then
    raise exception 'That channel is not there any more.';
  end if;
  insert into public.channel_members(channel_id, user_id, member_role, last_read_at)
  values (c, auth.uid(), 'member', now())
  on conflict (channel_id, user_id) where user_id is not null
  do update set last_read_at = excluded.last_read_at;
end $$;

-- ───────────────────────── channel_people ─────────────────────────
-- One list for both kinds of author: team logins (profiles) and client people (client_people).
-- {id, name, role, kind:'team'|'client', company}; company is set for client people only.
create or replace function public.channel_people(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_approved() then raise exception 'Only the Aviance team can do that.'; end if;
  return coalesce((
    select jsonb_agg(x) from (
      select jsonb_build_object('id', p.id, 'name', coalesce(nullif(btrim(p.name), ''), p.email, 'Team member'),
                                'role', p.role, 'kind', 'team', 'company', null) as x
        from public.profiles p where p.id = any(coalesce(p_ids, '{}'))
      union all
      select jsonb_build_object('id', cp.id, 'name', coalesce(nullif(btrim(cp.full_name), ''), cp.email, 'Client'),
                                'role', 'client', 'kind', 'client', 'company', cl.company)
        from public.client_people cp left join public.clients cl on cl.id = cp.client_id
       where cp.id = any(coalesce(p_ids, '{}'))
    ) s
  ), '[]'::jsonb);
end $$;

-- ───────────────────────── ensure_client_channel ─────────────────────────
-- The client's live channel, or a new one named after the company, with the caller as owner
-- and every person of that client as a member. Safe to call twice.
create or replace function public.ensure_client_channel(p_client_id uuid, p_name text) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_ch uuid; v_company text;
begin
  if not public.is_approved() then raise exception 'Only Aviance staff can set up a client channel.'; end if;
  select company into v_company from public.clients where id = p_client_id;
  if not found then raise exception 'That client is not there any more.'; end if;

  select id into v_ch from public.channels
   where kind = 'client' and client_id = p_client_id and archived_at is null
   order by created_at limit 1;
  if v_ch is null then
    insert into public.channels(name, purpose, kind, client_id, created_by)
    values (coalesce(nullif(btrim(v_company), ''), nullif(btrim(p_name), ''), 'Client'),
            'Your direct line to the Aviance team', 'client', p_client_id, auth.uid())
    returning id into v_ch;
  end if;

  insert into public.channel_members(channel_id, user_id, member_role)
  values (v_ch, auth.uid(), 'owner')
  on conflict (channel_id, user_id) where user_id is not null do nothing;

  insert into public.channel_members(channel_id, person_id)
  select v_ch, cp.id from public.client_people cp where cp.client_id = p_client_id
  on conflict (channel_id, person_id) where person_id is not null do nothing;

  return v_ch;
end $$;

revoke execute on function public.my_channels(), public.mark_channel_read(uuid),
  public.channel_people(uuid[]), public.ensure_client_channel(uuid, text) from public, anon;
grant execute on function public.my_channels(), public.mark_channel_read(uuid),
  public.channel_people(uuid[]), public.ensure_client_channel(uuid, text) to authenticated;
