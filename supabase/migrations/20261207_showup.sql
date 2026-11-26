-- Did they show up? The one question the guarantee turns on.
--
-- Two things that work together:
--   the HINT   — the prospect's RSVP on the calendar event (rsvp, rsvp_at,
--                rsvp_source). Never touches the money. It is a guess.
--   the TRUTH  — call_verdict(): whoever ran the call says "they showed" or
--                "no-show". It sets happened/happened_at, moves the meeting with
--                it, and recounts the month. It always overrides the hint.
--
-- Nothing can be forgotten: verdict_at is null until somebody answers, and
-- v_calls_awaiting_verdict lists every past qualified call that still has no
-- verdict. happened = false alone could never say that, because that is also
-- what a real no-show looks like.
--
-- Moving a call to no-show moves the month: qualified_calls.counts is generated
-- (happened and matched_icp and dispute_status <> 'upheld'), so recount_month()
-- on every month the call touched puts client_months.calls_delivered right. A
-- month that is already LOCKED is never quietly changed — the answer says so,
-- because a refund already hangs off it.

alter table public.qualified_calls
  add column if not exists meeting_id   uuid references public.meetings(id) on delete set null,
  add column if not exists verdict_at   timestamptz,
  add column if not exists verdict_by   uuid,
  add column if not exists verdict_note text,
  add column if not exists rsvp         text,
  add column if not exists rsvp_at      timestamptz,
  add column if not exists rsvp_source  text;

comment on column public.qualified_calls.verdict_at is
  'When a person answered "did they show up?". null means nobody has yet, which is NOT the same as a no-show.';
comment on column public.qualified_calls.rsvp is
  'A HINT only: what the prospect clicked on the calendar invitation. The verdict always wins.';
comment on column public.qualified_calls.meeting_id is
  'The meetings row this call was delivered as, so a verdict can move both at once.';

alter table public.qualified_calls drop constraint if exists qualified_calls_rsvp_words;
alter table public.qualified_calls
  add constraint qualified_calls_rsvp_words
  check (rsvp is null or rsvp in ('accepted','declined','tentative','no_reply'));

create unique index if not exists qualified_calls_one_per_meeting
  on public.qualified_calls(meeting_id) where meeting_id is not null;

-- Join up what is already there: same client, same instant, kind 'qualified'.
update public.qualified_calls q
   set meeting_id = m.id
  from public.meetings m
 where q.meeting_id is null
   and m.kind = 'qualified'
   and m.client_id = q.client_id
   and m.starts_at = q.booked_for
   and not exists (select 1 from public.qualified_calls o where o.meeting_id = m.id);

-- A call already marked as held was answered by someone, at some point. Say so,
-- rather than showing every old row as outstanding for ever.
update public.qualified_calls
   set verdict_at = coalesce(happened_at, booked_for)
 where verdict_at is null and happened;

/* ---------- what still needs an answer ---------- */
-- security_invoker: this view obeys the caller's RLS, so a signed-in client
-- gets nothing from it, exactly as they get nothing from qualified_calls.
create or replace view public.v_calls_awaiting_verdict
with (security_invoker = true) as
select q.id              as call_id,
       q.client_id,
       c.company,
       c.plan,
       q.prospect_name,
       q.prospect_email,
       q.prospect_company,
       q.booked_for,
       q.meeting_id,
       m.status          as meeting_status,
       m.guest_name,
       m.meet_link,
       q.rsvp,
       q.rsvp_at,
       q.rsvp_source,
       q.matched_icp,
       q.month_id,
       cm.month_no,
       cm.locked_at      as month_locked_at,
       floor(extract(epoch from (now() - q.booked_for)) / 3600)::int as hours_overdue
  from public.qualified_calls q
  join public.clients c        on c.id  = q.client_id
  left join public.meetings m  on m.id  = q.meeting_id
  left join public.client_months cm on cm.id = q.month_id
 where q.verdict_at is null
   and q.booked_for < now()
   and q.dispute_status <> 'upheld'
   and coalesce(m.status, '') <> 'cancelled';

comment on view public.v_calls_awaiting_verdict is
  'Every qualified call whose time has passed and that nobody has answered "did they show up?" for. Obeys RLS (security_invoker).';

grant select on public.v_calls_awaiting_verdict to authenticated;

/* ---------- the hint ---------- */

create or replace function public.call_rsvp_set(p_meeting uuid, p_rsvp text, p_source text default 'google')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rsvp text := lower(btrim(coalesce(p_rsvp,'')));
  q public.qualified_calls;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' and not public.is_approved() then
    raise exception 'Not allowed.';
  end if;
  -- Google calls it needsAction, Microsoft notResponded; both mean "no reply yet".
  v_rsvp := case v_rsvp
              when 'needsaction'  then 'no_reply'
              when 'notresponded' then 'no_reply'
              when 'none'         then 'no_reply'
              when 'tentativelyaccepted' then 'tentative'
              else v_rsvp end;
  if v_rsvp not in ('accepted','declined','tentative','no_reply') then
    raise exception 'An RSVP is accepted, declined, tentative or no_reply.';
  end if;

  update public.qualified_calls
     set rsvp = v_rsvp, rsvp_at = now(), rsvp_source = nullif(btrim(coalesce(p_source,'')),'')
   where meeting_id = p_meeting
   returning * into q;

  if q.id is null then
    return jsonb_build_object('ok', false,
      'error', 'No booked sales call is linked to that calendar entry, so there is nothing to note the reply against.');
  end if;
  return jsonb_build_object('ok', true, 'call_id', q.id, 'rsvp', q.rsvp,
    'verdict_at', q.verdict_at,
    'note', 'A reply on the invitation is only a hint. It has not changed whether this call counts.');
end
$$;

comment on function public.call_rsvp_set(uuid, text, text) is
  'Write the prospect''s calendar RSVP against a booked sales call. A HINT: it never changes happened, counts or the month.';

/* ---------- the truth ---------- */

create or replace function public.call_verdict(p_call uuid, p_showed boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q       public.qualified_calls;
  c       public.clients;
  v_zone  text := coalesce((select us_zone from public.calendar_settings where id = 1), 'America/New_York');
  v_day   date;
  v_ids   uuid[] := '{}';
  v_id    uuid;
  v_months jsonb := '[]'::jsonb;
  m       public.client_months;
  v_locked boolean := false;
  v_said  text;
begin
  if not public.is_approved() then
    raise exception 'Only the Aviance team can say whether a call happened.';
  end if;
  if p_showed is null then
    raise exception 'Say either that they showed up or that they did not.';
  end if;

  -- one answer at a time for this call
  select * into q from public.qualified_calls where id = p_call for update;
  if q.id is null then raise exception 'That booked call is not here any more.'; end if;
  if q.dispute_status = 'upheld' then
    raise exception 'A dispute on this call was upheld, so it no longer counts either way. Reopen the dispute first.';
  end if;
  select * into c from public.clients where id = q.client_id;

  update public.qualified_calls
     set happened     = p_showed,
         happened_at  = case when p_showed then coalesce(q.happened_at, q.booked_for) else null end,
         verdict_at   = now(),
         verdict_by   = auth.uid(),
         verdict_note = nullif(btrim(coalesce(p_note,'')), '')
   where id = q.id
   returning * into q;

  -- the meeting says the same thing
  if q.meeting_id is not null then
    update public.meetings
       set status  = case when p_showed then 'held' else 'no_show' end,
           held_at = case when p_showed then coalesce(held_at, q.booked_for) else null end
     where id = q.meeting_id;
  end if;

  -- every month this call could belong to: the one it is pointed at, and the
  -- one the day it happened falls in. Both are recounted.
  v_day := (coalesce(q.happened_at, q.booked_for) at time zone v_zone)::date;
  if q.month_id is not null then v_ids := array_append(v_ids, q.month_id); end if;
  for v_id in
    select id from public.client_months
     where client_id = q.client_id and v_day between starts_on and ends_on
  loop
    if not (v_id = any(v_ids)) then v_ids := array_append(v_ids, v_id); end if;
  end loop;

  foreach v_id in array v_ids loop
    select * into m from public.client_months where id = v_id;
    if m.id is null then continue; end if;
    if m.locked_at is null then
      perform public.recount_month(m.id);
      select * into m from public.client_months where id = v_id;
    else
      v_locked := true;
    end if;
    v_months := v_months || jsonb_build_array(jsonb_build_object(
      'month_id', m.id, 'month_no', m.month_no,
      'calls_delivered', m.calls_delivered, 'calls_promised', m.calls_promised,
      'verdict', m.verdict, 'refund_due', m.refund_due,
      'locked', (m.locked_at is not null), 'short', greatest(m.calls_promised - m.calls_delivered, 0)));
  end loop;

  insert into public.client_events(client_id, area, event, detail)
  values (q.client_id, 'calls', case when p_showed then 'showed_up' else 'no_show' end,
          jsonb_build_object('call_id', q.id, 'meeting_id', q.meeting_id,
                             'prospect', q.prospect_name, 'booked_for', q.booked_for,
                             'rsvp_hint', q.rsvp, 'counts', q.counts,
                             'by', auth.uid(), 'note', q.verdict_note));

  v_said := case
    when p_showed and q.counts then 'Counted as a delivered call for the month.'
    when p_showed and not q.matched_icp then 'Marked as held. It does not count, because it did not match their profile.'
    when p_showed then 'Marked as held, but it does not count towards the month.'
    else 'Marked as a no-show. It does not count towards the month.' end;
  if v_locked then
    v_said := v_said || ' One of its months is already locked, so that month''s number and any refund did not move.';
  end if;

  return jsonb_build_object('ok', true, 'call_id', q.id, 'meeting_id', q.meeting_id,
    'happened', q.happened, 'counts', q.counts, 'verdict_at', q.verdict_at,
    'rsvp_hint', q.rsvp, 'company', c.company, 'months', v_months,
    'locked_month', v_locked, 'said', v_said);
end
$$;

comment on function public.call_verdict(uuid, boolean, text) is
  'The truth about one booked sales call: they showed, or they did not. Sets happened, moves the meeting, recounts every month it touches, and overrides any calendar RSVP hint. Any approved team member.';

-- Same answer, reached from a meeting instead of a call. meetings.js works in
-- meeting ids, and a qualified meeting always has at most one call row.
create or replace function public.call_verdict_by_meeting(p_meeting uuid, p_showed boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_call uuid; mt public.meetings;
begin
  if not public.is_approved() then
    raise exception 'Only the Aviance team can say whether a call happened.';
  end if;
  select * into mt from public.meetings where id = p_meeting;
  if mt.id is null then raise exception 'That call is not in the calendar any more.'; end if;

  select id into v_call from public.qualified_calls where meeting_id = p_meeting;
  if v_call is null and mt.client_id is not null then
    select id into v_call from public.qualified_calls
     where client_id = mt.client_id and booked_for = mt.starts_at and meeting_id is null
     limit 1;
    if v_call is not null then
      update public.qualified_calls set meeting_id = p_meeting where id = v_call;
    end if;
  end if;
  if v_call is null then
    return jsonb_build_object('ok', false,
      'error', 'No booked sales call is linked to this calendar entry, so there is no month to move. Mark it on the client''s page instead.');
  end if;
  return public.call_verdict(v_call, p_showed, p_note);
end
$$;

revoke all on function public.call_verdict(uuid, boolean, text)            from public, anon;
revoke all on function public.call_verdict_by_meeting(uuid, boolean, text) from public, anon;
revoke all on function public.call_rsvp_set(uuid, text, text)              from public, anon;
grant execute on function public.call_verdict(uuid, boolean, text)            to authenticated;
grant execute on function public.call_verdict_by_meeting(uuid, boolean, text) to authenticated;
grant execute on function public.call_rsvp_set(uuid, text, text)              to authenticated;
