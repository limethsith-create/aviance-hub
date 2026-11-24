-- ======================================================================
-- 20261124_scheduling.sql — builder D: offering call times in the channel
-- (see /home/claude/spec/JOURNEY.md, "D's functions"). Applied after A
-- (journey_core: journey_steps, schedule_offers, draft_write, aviance_owner, msg_kind/meta)
-- and C (bot.sql, whose message trigger calls offer_match).
--
--   offer_times(client, 'kickoff'|'onboarding') -> draft id   [admin]
--   portal_offer_pick(offer, 1|2|3)            -> jsonb      [signed-in client]
--   offer_match(channel_messages row)          -> boolean    [C's trigger only]
--   meetings_offer_link trigger: posts the Google Meet link when mail-tick saves it.
-- Option numbers are 1-based everywhere (the client replies "1", "2" or "3").
-- ======================================================================

-- ---- 1. from 20261124_meeting_confirmations.sql (copied so it is applied) ----
-- A meeting booked in Aviance OS with a guest (a client's kickoff from their portal, or one the owner
-- adds by hand) now gets the same confirmation email as a website booking: mail-tick makes the
-- Google Meet for it, puts the link in the email and saves it on the meeting. Reminders already
-- follow from queue_due_reminders.
create or replace function public.queue_meeting_confirmation() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status = 'booked' and new.starts_at > now()
     and coalesce(btrim(new.guest_email),'') ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    perform public.queue_call_mail('booking_confirmation', new.guest_email, new.guest_name, new.starts_at,
                                   coalesce(new.time_zone, 'America/New_York'), null, new.id, new.client_id);
  end if;
  return new;
end $$;
revoke execute on function public.queue_meeting_confirmation() from public, anon, authenticated;
drop trigger if exists meetings_confirm on public.meetings;
create trigger meetings_confirm after insert on public.meetings for each row execute function public.queue_meeting_confirmation();

-- ---- 2. small helpers (internal; nobody outside SQL calls them) ----

-- The owner is public.aviance_owner() (A's journey_core): bot/system messages are written as them so the
-- client sees "Aviance".

-- The client's zone: the person's own, else the primary contact's, else New York.
create or replace function public.sched_zone(p_client uuid, p_person uuid default null) returns text
language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (select nullif(btrim(timezone), '') from public.client_people where id = p_person and client_id = p_client),
    (select nullif(btrim(timezone), '') from public.client_people where client_id = p_client
       order by (nullif(btrim(timezone), '') is not null) desc, is_primary desc, (user_id is not null) desc, created_at limit 1),
    'America/New_York');
$$;

-- 'tue nov 26, 10am ET' / 'tue nov 26, 10:30am ET' — the words the chat uses.
create or replace function public.sched_when(p_at timestamptz, p_zone text) returns text
language sql stable set search_path to 'public' as $$
  with z as (select coalesce(nullif(btrim(p_zone), ''), 'America/New_York') as zone)
  select to_char(p_at at time zone z.zone, 'dy mon FMDD, FMHH12')
      || case when to_char(p_at at time zone z.zone, 'MI') = '00' then '' else ':' || to_char(p_at at time zone z.zone, 'MI') end
      || to_char(p_at at time zone z.zone, 'am') || ' '
      || regexp_replace(public.pretty_when(p_at, z.zone), '^.* [AP]M ', '')
  from z;
$$;

revoke execute on function public.sched_zone(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.sched_when(timestamptz, text) from public, anon, authenticated;

-- ---- 3. offer_times: three choices -> a draft the owner approves ----
create or replace function public.offer_times(p_client uuid, p_kind text) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare
  c        public.clients;
  v_ch     uuid;
  v_zone   text;
  v_min    int;
  v_launch date;
  v_opts   jsonb;
  v_offer  uuid;
  v_draft  uuid;
  v_body   text;
  v_lines  text;
  v_cal    text;
begin
  if not public.is_admin() then raise exception 'Only the owner can offer call times.'; end if;
  if p_kind not in ('kickoff', 'onboarding') then raise exception 'Pick kickoff or onboarding.'; end if;
  select * into c from public.clients where id = p_client;
  if not found then raise exception 'That client was not found.'; end if;
  select id into v_ch from public.channels
   where kind = 'client' and client_id = p_client and archived_at is null order by created_at limit 1;
  if v_ch is null then raise exception 'This client has no channel yet. Invite them to the portal first.'; end if;

  v_zone := public.sched_zone(p_client);
  v_cal  := coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York');
  v_min  := case when p_kind = 'kickoff' then 45 else 30 end;

  if p_kind = 'kickoff' then
    -- earliest slot of each of the first three free days, at least 2 days out,
    -- with the half hour after it free too (45 minutes); 9-5 in the client's zone if that day has one
    with f as (select fs.starts_at from public.free_slots(21) fs),
    ok as (
      select a.starts_at, (a.starts_at at time zone v_cal)::date as d,
             extract(hour from a.starts_at at time zone v_zone) between 9 and 16 as nice
        from f a
       where a.starts_at >= now() + interval '2 days'
         and exists (select 1 from f b where b.starts_at = a.starts_at + interval '30 minutes')),
    pick as (
      select starts_at, d, row_number() over (partition by d order by nice desc, starts_at) as rn from ok)
    select jsonb_agg(jsonb_build_object('starts_at', starts_at, 'minutes', 45) order by starts_at)
      into v_opts
      from (select starts_at from pick where rn = 1 order by d limit 3) x;
  else
    -- the day before launch (or the nearest days before it), 30 minutes, one per hour so they are spread
    select planned_on into v_launch from public.journey_steps where client_id = p_client and step = 'launch';
    if v_launch is null then raise exception 'Start this client''s journey first, so there is a launch date.'; end if;
    with ok as (
      select fs.starts_at, (fs.starts_at at time zone v_zone)::date as d,
             extract(hour from fs.starts_at at time zone v_zone) as h,
             extract(hour from fs.starts_at at time zone v_zone) between 9 and 16 as nice
        from public.free_slots(21) fs
       where (fs.starts_at at time zone v_zone)::date < v_launch),
    pick as (
      select starts_at, d, nice, row_number() over (partition by d, h order by starts_at) as rn from ok)
    select jsonb_agg(jsonb_build_object('starts_at', starts_at, 'minutes', 30) order by starts_at)
      into v_opts
      from (select starts_at from pick where rn = 1 order by d desc, nice desc, starts_at limit 3) x;
  end if;

  if v_opts is null or jsonb_array_length(v_opts) = 0 then
    raise exception 'There are no free times to offer. Free up the calendar and try again.';
  end if;

  -- an older offer of the same kind is no longer good
  update public.schedule_offers set status = 'expired'
   where client_id = p_client and kind = p_kind and status in ('draft', 'open');
  update public.channel_messages cm set meta = cm.meta || '{"status":"expired"}'::jsonb
   where cm.channel_id = v_ch and cm.msg_kind = 'offer'
     and cm.meta->>'offer_id' in (select id::text from public.schedule_offers
                                         where client_id = p_client and kind = p_kind and status = 'expired');

  insert into public.schedule_offers(client_id, channel_id, kind, options, status)
  values (p_client, v_ch, p_kind, v_opts, 'draft') returning id into v_offer;

  select string_agg(o.n || ') ' || public.sched_when((o.v->>'starts_at')::timestamptz, v_zone), ' ' order by o.n)
    into v_lines from jsonb_array_elements(v_opts) with ordinality as o(v, n);
  v_body := 'hey, which works for ur ' || case when p_kind = 'kickoff' then 'kickoff' else 'onboarding call' end || '? '
         || v_lines || ' just reply '
         || case jsonb_array_length(v_opts) when 1 then '1' when 2 then '1 or 2' else '1, 2 or 3' end
         || ' (or tap one)';

  v_draft := public.draft_write(p_client, 'offer', v_body, 'offer',
    jsonb_build_object('offer_id', v_offer, 'kind', p_kind, 'options', v_opts, 'zone', v_zone),
    'offering ' || jsonb_array_length(v_opts) || ' ' || p_kind || ' times');
  return v_draft;
end $$;
revoke execute on function public.offer_times(uuid, text) from public, anon;
grant execute on function public.offer_times(uuid, text) to authenticated;

-- ---- 4. the booking itself (shared by the portal button and a "2" in the chat) ----
create or replace function public.sched_book(p_offer uuid, p_index int, p_person uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  o       public.schedule_offers;
  per     public.client_people;
  c       public.clients;
  m       public.meetings;
  v_start timestamptz;
  v_min   int;
  v_zone  text;
  v_cal   text;
  v_when  text;
  v_title text;
begin
  perform pg_advisory_xact_lock(hashtext('aviance-calendar'));   -- same lock as portal_book_kickoff
  select * into o from public.schedule_offers where id = p_offer for update;
  if not found then raise exception 'Those times are not available any more.'; end if;
  select * into per from public.client_people where id = p_person;
  if not found or per.client_id <> o.client_id then raise exception 'Those times are not available any more.'; end if;
  if o.status = 'booked' then raise exception 'This call is already booked.'; end if;
  if o.status <> 'open' then raise exception 'Those times are not available any more. We will send new ones.'; end if;
  if p_index is null or p_index < 1 or p_index > jsonb_array_length(o.options) then raise exception 'Pick one of the times.'; end if;

  v_start := (o.options->(p_index - 1)->>'starts_at')::timestamptz;
  v_min   := coalesce((o.options->(p_index - 1)->>'minutes')::int, case when o.kind = 'kickoff' then 45 else 30 end);
  select * into c from public.clients where id = o.client_id;
  v_zone  := public.sched_zone(o.client_id, per.id);
  v_cal   := coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York');
  v_title := case when o.kind = 'kickoff' then 'Kickoff — ' else 'Onboarding call — ' end || c.company;

  if exists (select 1 from public.meetings where client_id = c.id and kind = 'onboarding' and status <> 'cancelled'
               and title like (case when o.kind = 'kickoff' then 'Kickoff — %' else 'Onboarding call — %' end)) then
    raise exception 'This call is already booked.';
  end if;
  -- still free? every half hour the call covers must still be a free slot
  if v_start is null
     or exists (select 1 from generate_series(0, v_min - 1, 30) g(off)
                 where not exists (select 1 from public.free_slots(21) f where f.starts_at = v_start + make_interval(mins => g.off))) then
    raise exception 'That time has just gone. Please pick another, or message us.';
  end if;

  insert into public.meetings(client_id, kind, starts_at, minutes, time_zone, status, title, guest_name, guest_email, plan)
  values (c.id, 'onboarding', v_start, v_min, v_zone, 'booked', left(v_title, 160), left(per.full_name, 120),
          case when coalesce(per.email, '') ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(per.email) <= 200 then per.email end,
          c.plan)
  returning * into m;                         -- meetings_confirm queues the email; mail-tick makes the Meet

  update public.schedule_offers set status = 'booked', meeting_id = m.id where id = o.id;
  update public.channel_messages cm
     set meta = cm.meta || jsonb_build_object('status', 'booked', 'picked', p_index, 'meeting_id', m.id)
   where cm.channel_id = o.channel_id and cm.msg_kind = 'offer' and cm.meta->>'offer_id' = o.id::text;

  update public.journey_steps
     set planned_on = (v_start at time zone v_zone)::date, status = 'doing'
   where client_id = c.id and step = o.kind and status <> 'done';

  v_when := public.sched_when(v_start, v_zone);
  insert into public.channel_messages(channel_id, author_user, body, msg_kind, meta)
  values (o.channel_id, public.aviance_owner(), 'booked: ' || v_when || '. meet link coming in a sec', 'system',
          jsonb_build_object('offer_id', o.id, 'meeting_id', m.id, 'starts_at', m.starts_at, 'kind', o.kind));

  insert into public.client_events(client_id, area, event, detail)
  values (c.id, 'client', o.kind || '_booked', jsonb_build_object(
    'words', (case when o.kind = 'kickoff' then 'Kickoff' else 'Onboarding call' end) || ' booked by '
             || coalesce(per.full_name, 'the client') || ' for ' || public.pretty_when(m.starts_at, v_cal) || '.',
    'meeting_id', m.id));

  if o.kind = 'kickoff' and to_regprocedure('public.precall_request(uuid)') is not null then
    execute 'select public.precall_request($1)' using c.id;   -- E's pre-call form draft
  end if;

  return jsonb_build_object('offer_id', o.id, 'meeting_id', m.id, 'starts_at', m.starts_at, 'minutes', m.minutes,
                            'kind', o.kind, 'when', v_when);
end $$;
revoke execute on function public.sched_book(uuid, int, uuid) from public, anon, authenticated;

-- ---- 5. the portal button ----
create or replace function public.portal_offer_pick(p_offer uuid, p_index int) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare per public.client_people;
begin
  select * into per from public.client_people where user_id = auth.uid() and auth.uid() is not null limit 1;
  if not found or public.portal_home() is null then raise exception 'Only a signed-in client can pick a time.'; end if;
  if not exists (select 1 from public.schedule_offers where id = p_offer and client_id = per.client_id) then
    raise exception 'Those times are not available any more.';
  end if;
  return public.sched_book(p_offer, p_index, per.id);
end $$;
revoke execute on function public.portal_offer_pick(uuid, int) from public, anon;
grant execute on function public.portal_offer_pick(uuid, int) to authenticated;

-- ---- 6. "2" / "option 2" / "the second one" / "tuesday works" in the chat ----
-- The choice a short reply clearly makes among n options (1-based), or null. Pure, so it is easy to test.
create or replace function public.sched_choice(p_text text, p_days text[]) returns int
language plpgsql immutable as $$
declare
  t text := lower(btrim(coalesce(p_text, '')));
  tail text := '(\s+(one|option|time|slot))?(\s+(works?|pls|please|thx|thanks|thank you|is good|is great|sounds good|for me|is perfect|perfect))*\s*[.!]*\s*$';
  n int := coalesce(array_length(p_days, 1), 0);
  hit int; k int; d text;
begin
  if t = '' or char_length(t) > 40 or t ~ '\?' or t ~ '\m(not|no|none|neither|cant|can''t|cannot|instead|other|else|later|earlier)\M' then
    return null;
  end if;
  t := regexp_replace(t, '^(ok(ay)?|yes|yep|yeah|sure|great|perfect|cool|hey|hi)[,!.]?\s+', '');
  t := regexp_replace(t, '^(let''s do|lets do|i''ll take|ill take|i''ll go with|go with|we''ll take|book)\s+', '');
  if t ~ ('^(option|opt|number|no\.?|#)?\s*[1-3]' || tail) then
    hit := substring(t from '[1-3]')::int;
  elsif t ~ ('^(the\s+)?(first|1st)' || tail) then hit := 1;
  elsif t ~ ('^(the\s+)?(second|2nd)' || tail) then hit := 2;
  elsif t ~ ('^(the\s+)?(third|3rd|last)' || tail) then hit := case when t ~ 'last' then n else 3 end;
  else
    -- a weekday that matches exactly one option
    if t !~ ('^(on\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*' || tail) then return null; end if;
    d := substring(t from '(mon|tue|wed|thu|fri|sat|sun)');
    for k in 1 .. n loop
      if p_days[k] = d then
        if hit is not null then return null; end if;
        hit := k;
      end if;
    end loop;
  end if;
  if hit is null or hit < 1 or hit > n then return null; end if;
  return hit;
end $$;
revoke execute on function public.sched_choice(text, text[]) from public, anon, authenticated;

create or replace function public.offer_match(m public.channel_messages) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare o public.schedule_offers; v_zone text; v_days text[]; v_i int;
begin
  if m.author_person is null or coalesce(m.msg_kind, 'chat') <> 'chat' then return false; end if;
  select * into o from public.schedule_offers
   where channel_id = m.channel_id and status = 'open' order by created_at desc limit 1;
  if not found then return false; end if;
  v_zone := public.sched_zone(o.client_id, m.author_person);
  select array_agg(to_char((x.v->>'starts_at')::timestamptz at time zone v_zone, 'dy') order by x.n)
    into v_days from jsonb_array_elements(o.options) with ordinality as x(v, n);
  v_i := public.sched_choice(m.body, v_days);
  if v_i is null then return false; end if;
  begin
    perform public.sched_book(o.id, v_i, m.author_person);
  exception when others then
    return false;                -- the time went, or anything else: let the bot draft a reply instead
  end;
  return true;
end $$;
revoke execute on function public.offer_match(public.channel_messages) from public, anon, authenticated;

-- ---- 7. the Meet link, once mail-tick has made it ----
create or replace function public.post_offer_meet_link() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare o public.schedule_offers; v_zone text;
begin
  if coalesce(new.meet_link, '') !~ '^https://meet\.google\.com/[^\s"''<>]+$'
     or new.meet_link is not distinct from old.meet_link then
    return new;
  end if;
  select * into o from public.schedule_offers where meeting_id = new.id limit 1;
  if not found then return new; end if;
  v_zone := coalesce(nullif(new.time_zone, ''), public.sched_zone(o.client_id));
  insert into public.channel_messages(channel_id, author_user, body, msg_kind, meta)
  values (o.channel_id, public.aviance_owner(),
          'here''s the link for ' || public.sched_when(new.starts_at, v_zone) || ': ' || new.meet_link, 'system',
          jsonb_build_object('meeting_id', new.id, 'url', new.meet_link, 'starts_at', new.starts_at, 'offer_id', o.id));
  return new;
end $$;
revoke execute on function public.post_offer_meet_link() from public, anon, authenticated;
drop trigger if exists meetings_offer_link on public.meetings;
create trigger meetings_offer_link after update of meet_link on public.meetings
  for each row execute function public.post_offer_meet_link();
