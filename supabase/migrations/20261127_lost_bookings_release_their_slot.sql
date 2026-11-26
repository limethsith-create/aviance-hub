-- A booking should hold a discovery slot only while the call is still expected to
-- happen. free_slots() excluded 'cancelled' and nothing else, but pipeline.js's
-- plLost() marks a booking 'lost' and never frees the time. So a lead turned down,
-- disqualified or gone quiet BEFORE their call kept that slot blocked for ever, and
-- there is no button anywhere that releases it. Every lost future lead silently cost
-- a sellable half hour.
--
-- 'won', 'held' and 'no_show' still hold their slot: those calls happened or are
-- going to. Only 'cancelled' and 'lost' let it go.
--
-- THIS RULE LIVES IN TWO PLACES AND THEY MUST AGREE. The other is
-- MT_BOOKING_FREES_TIME in meetings.js, which is what the hub's own slot finder
-- uses. tests/slot-rule.test.mjs fails if they drift apart. See SCHEMA.md,
-- "Which bookings hold their slot".
--
-- Applied live on 2026-11-27 before this file existed; committed afterwards so the
-- migration history matches the database.
create or replace function public.free_slots(p_days integer default 31)
 returns table(starts_at timestamp with time zone, minutes integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
    s := row(1, '07:00', '21:00', array[1,2,3,4,5], 30, 12, 21,
             'America/New_York', 'Asia/Colombo', null, now())::public.calendar_settings;
  end if;

  v_days  := least(greatest(coalesce(p_days, 31), 1), 90);
  v_days  := least(v_days, s.days_ahead);
  v_open  := s.open_time::interval;
  v_close := s.close_time::interval;

  v_earliest := now() + make_interval(hours => s.min_notice_h);

  v_day  := (now() at time zone s.us_zone)::date;
  v_last := v_day + v_days;

  while v_day <= v_last loop
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
              where d.status not in ('cancelled', 'lost')
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
end $function$;

comment on function public.free_slots(integer) is
  'Open discovery slots. A booking holds its slot unless it is cancelled or lost — a lead turned down before the call frees the time again.';
