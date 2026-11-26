-- Aviance OS — server fixes from the perfection pass (Agent E).
-- Safe to run more than once. Nothing here touches close_won, agreement_terms, mail_pack,
-- raise_invoice, doc_get_core or documents_preview (another migration owns those six).
--
-- APPLIED to production on 2026-11-26, after the new mail-tick was deployed.
-- ORDER: deploy the mail-tick edge function FIRST, then run this file. The new mail-tick works with
-- the old SQL; the stalled-send sweep in section 1 relies on the new mail-tick stamping send_after
-- when it claims a row. (Reverse order is only risky for a mail that is mid-send in that minute.)
--
-- New functions in schema public are executable by anon and authenticated by default
-- (pg_default_acl), so every function made here has its grants set explicitly at the end.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. REMINDERS: on time, never late, never lost
-- ─────────────────────────────────────────────────────────────────────────────
-- The prospect's "tomorrow" reminder used discovery_bookings.day_before_sent_at as its marker.
-- discovery-engine/day-before uses the SAME column for the closer's brief and runs first (20-28h
-- before the call), so the day Google is connected there every prospect's 24h reminder would stop.
-- The reminder gets its own column.
alter table public.discovery_bookings add column if not exists reminded_24h_at timestamptz;

update public.discovery_bookings b
   set reminded_24h_at = coalesce(b.day_before_sent_at, now())
 where b.reminded_24h_at is null
   and exists (select 1 from public.mail_outbox o where o.booking_id = b.id and o.kind = 'reminder_24h');

create or replace function public.queue_due_reminders()
returns table(queued integer, which text)
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n_day int := 0; n_hour int := 0; n_five int := 0; n_late int := 0; n_back int := 0;
begin
  -- A. A send that never finished. mail-tick stamps send_after when it claims a row, so a row still
  --    'sending' four minutes later was cut off (the function was killed, or the script hung).
  --    It gets tried again, up to the usual five attempts: a second copy of an email is a smaller
  --    problem than a booking confirmation nobody received.
  update public.mail_outbox
     set status = 'pending', send_after = now(),
         last_error = 'The last send was cut off part-way, so it is being tried again.'
   where status = 'sending' and send_after < now() - interval '4 minutes' and attempts < 5;
  get diagnostics n_back = row_count;
  update public.mail_outbox
     set status = 'failed',
         last_error = 'The send was cut off part-way and it has now been tried 5 times. Check Sent in Gmail before sending it again.'
   where status = 'sending' and send_after < now() - interval '4 minutes' and attempts >= 5;

  -- B. A reminder that can no longer arrive in time is dropped, not sent late: "we're on in five"
  --    must never land after the call has started. Mail for a cancelled call is dropped too.
  update public.mail_outbox o
     set status = 'cancelled',
         last_error = 'Not sent: it was too late to be useful, or the call was cancelled.'
   where o.status in ('pending', 'failed')
     and o.kind in ('booking_confirmation', 'reminder_24h', 'reminder_1h', 'reminder_5min')
     and exists (
       select 1 from (
         select b.call_at as call_start, (b.status = 'cancelled') as call_off
           from public.discovery_bookings b where b.id = o.booking_id
         union all
         select m.starts_at, (m.status = 'cancelled')
           from public.meetings m where m.id = o.meeting_id) x
        where x.call_off
           or (o.kind = 'reminder_5min' and x.call_start <= now() + interval '1 minute')
           or (o.kind = 'reminder_1h'   and x.call_start <= now() + interval '15 minutes')
           or (o.kind = 'reminder_24h'  and x.call_start <= now() + interval '3 hours'));
  get diagnostics n_late = row_count;

  -- C. Queue what is due. Each nudge only goes if the person booked before its window opened, and
  --    each window has a floor, so a tick that was missed for a while cannot queue a stale nudge.
  --    This runs once a minute: "in five" is queued 5-6 minutes before the start and sent in the same tick.
  for r in select * from public.discovery_bookings
     where status not in ('cancelled','held','no_show','won','lost') and reminded_24h_at is null
       and call_at between now() + interval '12 hours' and now() + interval '24 hours'
       and created_at < call_at - interval '26 hours' loop
    perform public.queue_call_mail('reminder_24h', r.email, r.name, r.call_at, r.timezone, r.id);
    update public.discovery_bookings set reminded_24h_at = now() where id = r.id;  n_day := n_day + 1;
  end loop;
  for r in select * from public.discovery_bookings
     where status not in ('cancelled','held','no_show','won','lost') and reminded_1h_at is null
       and call_at between now() + interval '20 minutes' and now() + interval '65 minutes'
       and created_at < call_at - interval '2 hours' loop
    perform public.queue_call_mail('reminder_1h', r.email, r.name, r.call_at, r.timezone, r.id);
    update public.discovery_bookings set reminded_1h_at = now() where id = r.id;  n_hour := n_hour + 1;
  end loop;
  for r in select * from public.discovery_bookings
     where status not in ('cancelled','held','no_show','won','lost') and reminded_5min_at is null
       and call_at between now() + interval '90 seconds' and now() + interval '6 minutes'
       and created_at < call_at - interval '15 minutes' loop
    perform public.queue_call_mail('reminder_5min', r.email, r.name, r.call_at, r.timezone, r.id);
    update public.discovery_bookings set reminded_5min_at = now() where id = r.id;  n_five := n_five + 1;
  end loop;

  -- The same three for a client's own meetings. They go to the person the confirmation went to
  -- (the guest), and to the client's main contact only when the meeting names no guest.
  for r in select m.*, coalesce(nullif(btrim(m.guest_email), ''), nullif(btrim(c.contact_email), '')) as to_email,
                  coalesce(nullif(btrim(m.guest_name), ''), c.contact_name) as to_name
      from public.meetings m left join public.clients c on c.id = m.client_id
     where m.status = 'booked' and m.reminded_24h_at is null
       and coalesce(nullif(btrim(m.guest_email), ''), nullif(btrim(c.contact_email), '')) is not null
       and m.starts_at between now() + interval '12 hours' and now() + interval '24 hours'
       and m.created_at < m.starts_at - interval '26 hours' loop
    perform public.queue_call_mail('reminder_24h', r.to_email, r.to_name, r.starts_at, r.time_zone, null, r.id, r.client_id);
    update public.meetings set reminded_24h_at = now() where id = r.id;  n_day := n_day + 1;
  end loop;
  for r in select m.*, coalesce(nullif(btrim(m.guest_email), ''), nullif(btrim(c.contact_email), '')) as to_email,
                  coalesce(nullif(btrim(m.guest_name), ''), c.contact_name) as to_name
      from public.meetings m left join public.clients c on c.id = m.client_id
     where m.status = 'booked' and m.reminded_1h_at is null
       and coalesce(nullif(btrim(m.guest_email), ''), nullif(btrim(c.contact_email), '')) is not null
       and m.starts_at between now() + interval '20 minutes' and now() + interval '65 minutes'
       and m.created_at < m.starts_at - interval '2 hours' loop
    perform public.queue_call_mail('reminder_1h', r.to_email, r.to_name, r.starts_at, r.time_zone, null, r.id, r.client_id);
    update public.meetings set reminded_1h_at = now() where id = r.id;  n_hour := n_hour + 1;
  end loop;
  for r in select m.*, coalesce(nullif(btrim(m.guest_email), ''), nullif(btrim(c.contact_email), '')) as to_email,
                  coalesce(nullif(btrim(m.guest_name), ''), c.contact_name) as to_name
      from public.meetings m left join public.clients c on c.id = m.client_id
     where m.status = 'booked' and m.reminded_5min_at is null
       and coalesce(nullif(btrim(m.guest_email), ''), nullif(btrim(c.contact_email), '')) is not null
       and m.starts_at between now() + interval '90 seconds' and now() + interval '6 minutes'
       and m.created_at < m.starts_at - interval '15 minutes' loop
    perform public.queue_call_mail('reminder_5min', r.to_email, r.to_name, r.starts_at, r.time_zone, null, r.id, r.client_id);
    update public.meetings set reminded_5min_at = now() where id = r.id;  n_five := n_five + 1;
  end loop;

  return query select n_day, 'a day before'::text
     union all select n_hour, 'an hour before'::text
     union all select n_five, 'five minutes before'::text
     union all select n_late, 'dropped as too late or cancelled'::text
     union all select n_back, 'put back after a stalled send'::text;
end $$;

-- The queue, most urgent first. It was oldest-first, so a five-minute reminder could wait behind
-- nineteen older rows. Same columns as before, with `priority` added at the end.
create or replace view public.v_mail_to_send with (security_invoker = true) as
 select o.id, o.to_email, o.to_name, o.subject, o.body_text, o.body_html, o.ics, o.kind, o.attempts,
        o.needs_meet_link, o.booking_id, o.meeting_id,
        coalesce(b.meet_link, m.meet_link) as meet_link,
        coalesce(b.calendar_event_id, m.calendar_event_id) as calendar_event_id,
        coalesce(b.call_at, m.starts_at) as starts_at,
        coalesce(b.minutes, m.minutes) as minutes,
        coalesce(b.email, o.to_email) as guest_email,
        coalesce(b.name, o.to_name) as guest_name,
        case o.kind when 'reminder_5min' then 0 when 'reminder_1h' then 1
                    when 'booking_confirmation' then 2 when 'staff_invite' then 3
                    when 'portal_invite' then 3 when 'agreement' then 3
                    when 'reminder_24h' then 4 else 5 end as priority
   from public.mail_outbox o
   left join public.discovery_bookings b on b.id = o.booking_id
   left join public.meetings m on m.id = o.meeting_id
  where o.status in ('pending', 'failed') and o.send_after <= now() and o.attempts < 5
  order by priority, o.send_after, o.created_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE MAIL ROOM
-- ─────────────────────────────────────────────────────────────────────────────
-- (The instant-send poke and the cron header change are in 20261202_mail_instant_send_NOT_APPLIED.sql:
--  they reuse the key stored in the cron job, could not be verified from here, and wait for the owner.)

-- What the owner cannot see today: mail that failed for good, or is stuck. For the hub to show.
create or replace function public.mail_health()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the owner can see the mail room.'; end if;
  return jsonb_build_object(
    'failed',   (select count(*) from public.mail_outbox where status = 'failed' and attempts >= 5),
    'retrying', (select count(*) from public.mail_outbox where status in ('pending','failed') and attempts between 1 and 4),
    'stuck',    (select count(*) from public.mail_outbox where status = 'sending' and send_after < now() - interval '4 minutes'),
    'late',     (select count(*) from public.mail_outbox where status = 'pending' and attempts = 0 and send_after < now() - interval '5 minutes'),
    'oldest_waiting', (select min(send_after) from public.mail_outbox where status = 'pending' and send_after <= now()),
    'problems', coalesce((
      select jsonb_agg(p order by p->>'created_at' desc) from (
        select jsonb_build_object('id', o.id, 'kind', o.kind, 'to_email', o.to_email, 'subject', o.subject,
                                  'status', o.status, 'attempts', o.attempts, 'error', o.last_error,
                                  'created_at', o.created_at) as p
          from public.mail_outbox o
         where (o.status = 'failed' and o.attempts >= 5)
            or (o.status = 'sending' and o.send_after < now() - interval '4 minutes')
         order by o.created_at desc limit 20) q), '[]'::jsonb));
end $$;

-- A copy of a code or a one-time link must not sit in the outbox once the row is finished with.
-- It was only hidden on 'sent'; a row that failed for good, or was cancelled, kept it.
create or replace function public.mail_outbox_scrub()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status in ('sent', 'cancelled') or (new.status = 'failed' and new.attempts >= 5) then
    if new.kind = 'portal_invite' then
      new.body_text := regexp_replace(new.body_text, 'join\.html#[0-9a-f]{48}', 'join.html#(hidden once sent)', 'g');
      new.body_html := regexp_replace(new.body_html, 'join\.html#[0-9a-f]{48}', 'join.html#(hidden once sent)', 'g');
    elsif new.kind = 'staff_invite' then
      new.body_text := regexp_replace(new.body_text, 'AVX-[A-Z0-9]{4}-[A-Z0-9]{4}', 'AVX-(hidden once sent)', 'g');
      new.body_html := regexp_replace(new.body_html, 'AVX-[A-Z0-9]{4}-[A-Z0-9]{4}', 'AVX-(hidden once sent)', 'g');
    end if;
  end if;
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE CALENDAR
-- ─────────────────────────────────────────────────────────────────────────────
-- free_slots offered US public holidays (40 open slots on Thanksgiving, the day after, Christmas
-- Eve and Christmas Day when this was written). offer_times already skipped them; the website
-- and the callers' booking page did not. Same body as before plus the one holiday test.
create or replace function public.free_slots(p_days integer default 31)
returns table(starts_at timestamp with time zone, minutes integer)
language plpgsql security definer set search_path = public as $$
declare
  s            record;
  v_days       int;
  v_open       interval;
  v_close      interval;
  v_day        date;
  v_last       date;
  v_slot       timestamptz;
  v_day_open   timestamptz;
  v_day_close  timestamptz;
  v_earliest   timestamptz;
begin
  select * into s from public.calendar_settings where id = 1;
  if not found then
    -- The usual rules, if nobody has saved any yet.
    s := row(1, '07:00', '21:00', array[1,2,3,4,5], 30, 12, 21,
             'America/New_York', 'Asia/Colombo', null, now())::public.calendar_settings;
  end if;

  v_days  := least(greatest(coalesce(p_days, 31), 1), 90);   -- never more than 90 days out
  v_days  := least(v_days, s.days_ahead);
  v_open  := s.open_time::interval;
  v_close := s.close_time::interval;

  -- Nothing sooner than the notice period.
  v_earliest := now() + make_interval(hours => s.min_notice_h);

  v_day  := (now() at time zone s.us_zone)::date;
  v_last := v_day + v_days;

  while v_day <= v_last loop
    -- The working day is read in the prospect's zone, so it stays 7am-9pm
    -- for them whatever the clocks do. US public holidays are not working days.
    if extract(isodow from v_day)::int = any (
         select case when d = 0 then 7 else d end from unnest(s.days) as d
       ) and not public.us_holiday(v_day) then

      v_day_open  := (v_day + v_open)  at time zone s.us_zone;
      v_day_close := (v_day + v_close) at time zone s.us_zone;
      v_slot      := v_day_open;

      while v_slot + make_interval(mins => s.slot_minutes) <= v_day_close loop
        if v_slot >= v_earliest
           and not exists (
             select 1 from public.meetings m
              where m.status <> 'cancelled'
                and tstzrange(m.starts_at, m.starts_at + make_interval(mins => m.minutes), '[)')
                    && tstzrange(v_slot, v_slot + make_interval(mins => s.slot_minutes), '[)')
           )
           and not exists (
             select 1 from public.calendar_blocks b
              where tstzrange(b.starts_at, b.ends_at, '[)')
                    && tstzrange(v_slot, v_slot + make_interval(mins => s.slot_minutes), '[)')
           )
           and not exists (
             select 1 from public.discovery_bookings d
              where d.status <> 'cancelled'
                and tstzrange(d.call_at, d.call_at + make_interval(mins => d.minutes), '[)')
                    && tstzrange(v_slot, v_slot + make_interval(mins => s.slot_minutes), '[)')
           )
        then
          starts_at := v_slot;
          minutes   := s.slot_minutes;
          return next;
        end if;

        v_slot := v_slot + make_interval(mins => s.slot_minutes);
      end loop;
    end if;

    v_day := v_day + 1;
  end loop;
end $$;

-- A website booking checked the slot WITHOUT the calendar lock that caller_book, sched_book and
-- portal_book_kickoff all take, so a website booking and a client's kickoff could land on the same
-- half hour. It now takes the same lock. It also stops a booking made with the public key from
-- setting fields only the server should set: its own length (a 2-hour "slot"), a caller's id
-- (callers are paid per call that shows), the reminder marks, the creation time and the link.
create or replace function public.booking_must_be_free()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_min int;
begin
  if public.is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('aviance-calendar'));
  select f.minutes into v_min from public.free_slots(31) f where f.starts_at = new.call_at;
  if v_min is null then
    raise exception 'That time is not open. Please pick one of the times offered.';
  end if;
  new.minutes            := v_min;
  new.created_at         := now();
  new.meet_link          := null;          -- discovery_bookings_link gives it a room; mail-tick makes the Meet
  new.day_before_sent_at := null;
  new.reminded_24h_at    := null;
  new.reminded_1h_at     := null;
  new.reminded_5min_at   := null;
  new.lost_reason        := null;
  new.lost_at            := null;
  if new.caller_id is distinct from public.my_caller_id() then
    new.caller_id := null;                 -- only caller_book, signed in as that caller, may credit a caller
  end if;
  return new;
end $$;

alter function public.give_booking_a_link() set search_path = public;
alter function public.give_meeting_a_link() set search_path = public;
alter function public.mail_no_placeholder() set search_path = public;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. MONTHS AND THE GUARANTEE
-- ─────────────────────────────────────────────────────────────────────────────
-- open_next_month ended each month at (its own start + 1 month - 1 day). For a client who started
-- on the 29th-31st that leaves days that belong to no month (start 31 Jan: month 2 ran 28 Feb to
-- 27 Mar, month 3 started 31 Mar, and a call held 28-30 Mar counted for nothing). Each month now
-- ends the day before the next one starts.
create or replace function public.open_next_month(p_client uuid)
returns public.client_months language plpgsql set search_path = public as $$
declare
  c public.clients;
  n integer;
  s date;
  e date;
  m public.client_months;
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    raise exception 'Only the owner can open a month.';
  end if;
  select * into c from public.clients where id = p_client;
  if not found then raise exception 'no such client'; end if;
  if c.day1_on is null then raise exception 'day1_on is not set: sending has not started'; end if;

  select coalesce(max(month_no), 0) + 1 into n from public.client_months where client_id = p_client;
  s := (c.day1_on + ((n - 1) * interval '1 month'))::date;
  e := (c.day1_on + (n * interval '1 month'))::date - 1;

  insert into public.client_months (client_id, month_no, starts_on, ends_on, calls_promised)
  values (p_client, n, s, e, c.calls_promised)
  on conflict (client_id, month_no) do nothing;

  select * into m from public.client_months where client_id = p_client and month_no = n;
  return m;
end $$;

-- recount_month cast the call time to a date in UTC, so a call held on the evening of the last day
-- (US time) fell into the next month, or into none. The day is now read in the calendar's US zone.
create or replace function public.recount_month(p_month uuid)
returns integer language plpgsql set search_path = public as $$
declare
  m public.client_months;
  d integer;
  v_zone text := coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York');
begin
  select * into m from public.client_months where id = p_month;
  if not found then raise exception 'no such month'; end if;
  if m.locked_at is not null then return m.calls_delivered; end if;

  -- a call belongs to the month its meeting happened in
  update public.qualified_calls q
     set month_id = m.id
   where q.client_id = m.client_id
     and q.counts
     and (q.happened_at at time zone v_zone)::date between m.starts_on and m.ends_on
     and (q.month_id is distinct from m.id);

  select count(*) into d
    from public.qualified_calls q
   where q.month_id = m.id and q.counts;

  update public.client_months set calls_delivered = d where id = p_month;
  return d;
end $$;

-- lock_month read the month without locking the row: two clicks at once both saw "not locked" and
-- both wrote a refund. The row is now locked for the length of the call, and one index makes a
-- second refund for the same missed month impossible.
create or replace function public.lock_month(p_month uuid)
returns public.client_months language plpgsql set search_path = public as $$
declare
  m public.client_months;
  c public.clients;
  owed integer := 0;
  mult numeric(3,1) := 1.0;
  why text;
begin
  select * into m from public.client_months where id = p_month for update;
  if not found then raise exception 'no such month'; end if;
  if m.locked_at is not null then return m; end if;

  perform public.recount_month(p_month);
  select * into m from public.client_months where id = p_month;
  select * into c from public.clients where id = m.client_id;

  if m.calls_delivered >= m.calls_promised then
    update public.client_months
       set verdict = 'hit', locked_at = now(), refund_due = 0
     where id = p_month;
  else
    -- month one pays double. every month after pays that month back in full.
    if m.month_no = 1 then mult := 2.0; why := 'missed_month_one';
    else                   mult := 1.0; why := 'missed_month'; end if;
    owed := round(c.monthly_fee * mult);

    update public.client_months
       set verdict = 'missed', locked_at = now(), refund_due = owed
     where id = p_month;

    insert into public.refunds (client_id, month_id, amount, multiplier, reason, status, notes)
    values (m.client_id, m.id, owed, mult, why, 'owed',
            format('Month %s: %s of %s calls delivered.', m.month_no, m.calls_delivered, m.calls_promised));
  end if;

  select * into m from public.client_months where id = p_month;
  return m;
end $$;

create unique index if not exists refunds_one_per_missed_month
  on public.refunds (month_id)
  where month_id is not null and reason in ('missed_month_one', 'missed_month');

-- raise_invoice checks "is there an invoice for this month?" and then inserts, with nothing to stop
-- two calls at once from both inserting. One live invoice per month, enforced by the table.
create unique index if not exists invoices_one_per_month
  on public.invoices (month_id)
  where month_id is not null and status <> 'void';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. STAFF LINKS AND CALLERS
-- ─────────────────────────────────────────────────────────────────────────────
-- staff_link_claim now also says which login the staff row is tied to, so caller-link can repair a
-- row whose login exists but was never linked (she would land signed in and see "sign in again").
create or replace function public.staff_link_claim(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.staff;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' and not public.is_admin() then
    raise exception 'Not allowed.';
  end if;
  if coalesce(btrim(p_token), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'no token');
  end if;

  select * into v_row
    from public.staff
   where link_hash = encode(extensions.digest(btrim(p_token), 'sha256'), 'hex')
   limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'unknown');
  end if;
  if v_row.status = 'revoked' then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;
  if v_row.link_expires_at is null or v_row.link_expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  update public.staff
     set link_last_used = now(),
         link_uses      = link_uses + 1,
         status         = case when status = 'invited' then 'active' else status end
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'email', v_row.email,
                            'kind', v_row.kind, 'name', v_row.name, 'user_id', v_row.user_id);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. WHO MAY CALL WHAT
-- ─────────────────────────────────────────────────────────────────────────────
-- caller_next_id(p_caller) is SECURITY DEFINER, checks nothing and trusts its argument: any signed-in
-- user (a client in the portal, an employee, another caller) could call it with a caller's id and it
-- would hand an unassigned lead to that caller. It is only ever called from inside caller_me,
-- caller_next, caller_log and caller_book, which run as the owner, so the API roles lose it.
revoke execute on function public.caller_next_id(uuid) from public, anon, authenticated;

-- These check their caller themselves, but nobody without a login has any business reaching them.
revoke execute on function public.staff_link_new(uuid, integer) from public, anon;
revoke execute on function public.staff_link_claim(text)        from public, anon;
revoke execute on function public.staff_link_clear(uuid)        from public, anon;
grant  execute on function public.staff_link_new(uuid, integer) to authenticated, service_role;
grant  execute on function public.staff_link_claim(text)        to authenticated, service_role;
grant  execute on function public.staff_link_clear(uuid)        to authenticated, service_role;

revoke execute on function public.open_next_month(uuid) from public, anon;
revoke execute on function public.recount_month(uuid)   from public, anon;
revoke execute on function public.lock_month(uuid)      from public, anon;
grant  execute on function public.open_next_month(uuid) to authenticated, service_role;
grant  execute on function public.recount_month(uuid)   to authenticated, service_role;
grant  execute on function public.lock_month(uuid)      to authenticated, service_role;

revoke execute on function public.mail_welcome(uuid, text, text, text, text) from public, anon;
grant  execute on function public.mail_welcome(uuid, text, text, text, text) to authenticated, service_role;

-- the functions made in this file
revoke execute on function public.queue_due_reminders()  from public, anon, authenticated;
grant  execute on function public.queue_due_reminders()  to service_role;
revoke execute on function public.mail_health()          from public, anon;
grant  execute on function public.mail_health()          to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. INDEXES
-- ─────────────────────────────────────────────────────────────────────────────
-- Already there and right (checked in pg_indexes): channel_messages (channel_id, created_at desc),
-- leads (assigned_to, status, callback_at, created_at), call_log (caller_id, created_at desc),
-- mail_outbox (send_after) where pending/failed, discovery_bookings (call_at).
-- Missing: every lookup of a client's invoices or refunds, and "which client came from this booking".
create index if not exists invoices_client_idx on public.invoices (client_id, created_at desc);
create index if not exists refunds_client_idx  on public.refunds (client_id);
create index if not exists clients_booking_idx on public.clients (booking_id) where booking_id is not null;
-- the stalled-send sweep runs every minute
create index if not exists mail_outbox_sending_idx on public.mail_outbox (send_after) where status = 'sending';
