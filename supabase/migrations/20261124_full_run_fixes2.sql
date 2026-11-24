-- Fixes, round 2 (from the 5-agent run):
-- 1. kickoff / onboarding confirmation emails: right length, right subject, right prep list (was the discovery-call template, "30 minutes")
-- 2. chat messages written in one go keep their order (created_at = the moment of the insert, not the transaction start)
-- 3. "anything later?" -> the next kickoff offer starts after the times already offered, instead of repeating them

create or replace function public.queue_meeting_confirmation() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare v_what text; v_prep text;
begin
  if new.status = 'booked' and new.starts_at > now()
     and coalesce(btrim(new.guest_email),'') ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    perform public.queue_call_mail('booking_confirmation', new.guest_email, new.guest_name, new.starts_at,
                                   coalesce(new.time_zone, 'America/New_York'), null, new.id, new.client_id);
    v_what := case when coalesce(new.title, '') like 'Kickoff%' then 'Kickoff'
                   when coalesce(new.title, '') like 'Onboarding call%' then 'Onboarding call' end;
    if v_what is not null or coalesce(new.minutes, 30) <> 30 then
      v_prep := case v_what
        when 'Kickoff' then 'Answer the 4 quick questions in your channel, so we use the time well.'
        when 'Onboarding call' then 'We will walk you through the test results and the launch plan.'
        else null end;
      update public.mail_outbox mo set
        subject = case when v_what is null then mo.subject else replace(mo.subject, 'You''re booked in:', v_what || ' booked:') end,
        body_text = replace(replace(replace(mo.body_text,
                      ', 30 minutes.', ', ' || coalesce(new.minutes, 30) || ' minutes.'),
                      E'\n2. Think about who your best customers are.\n3. Know what one new customer is worth to you.',
                      case when v_prep is null then E'\n2. Think about who your best customers are.\n3. Know what one new customer is worth to you.' else E'\n2. ' || v_prep end),
                      'You''re booked in.', case when v_what is null then 'You''re booked in.' else 'Your ' || lower(v_what) || ' is booked.' end),
        body_html = case when mo.body_html is null then null else
                      replace(replace(replace(replace(mo.body_html,
                      ', 30 minutes.', ', ' || coalesce(new.minutes, 30) || ' minutes.'),
                      'Think about who your best customers are.', coalesce(v_prep, 'Think about who your best customers are.')),
                      'Know what one new customer is worth to you.', case when v_prep is null then 'Know what one new customer is worth to you.' else '' end),
                      'You''re booked in.', case when v_what is null then 'You''re booked in.' else 'Your ' || lower(v_what) || ' is booked.' end) end
       where mo.meeting_id = new.id and mo.kind = 'booking_confirmation' and mo.status = 'pending';
    end if;
  end if;
  return new;
end $function$;

alter table public.channel_messages alter column created_at set default clock_timestamp();
alter table public.bot_drafts alter column created_at set default clock_timestamp();

do $$ declare d text; o text; begin
  d := pg_get_functiondef('public.offer_times(uuid,text)'::regprocedure);
  o := $x$where a.starts_at >= now() + interval '2 days' and not public.us_holiday$x$;
  if position(o in d) = 0 then raise exception 'offer_times: text not found'; end if;
  execute replace(d, o, $x$where a.starts_at >= now() + interval '2 days'
         and a.starts_at > coalesce((select max((x.v->>'starts_at')::timestamptz) from public.schedule_offers so,
                                       jsonb_array_elements(so.options) x(v)
                                      where so.client_id = p_client and so.kind = 'kickoff' and so.status in ('draft', 'open')), '-infinity')
         and not public.us_holiday$x$);
end $$;
