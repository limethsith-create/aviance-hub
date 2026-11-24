-- 20261124_steps.sql — builder E: the step messages, approvals, the pre-call form and testing numbers.
-- Applied AFTER 20261124_journey_core.sql (A): needs journey_steps, bot_drafts, approvals, precall_forms,
-- testing_days, channel_messages.msg_kind/meta and public.draft_write(...).
--
-- Every bot line is a DRAFT (draft_write) the owner approves. Only pure facts are posted straight away
-- as msg_kind 'system' with author_user = the owner: "approved by …", "changes asked …", "form done ✓".
--
-- Who may call what:
--   admin (is_admin())        approval_request, testing_day, approval_reminders
--   client (portal login)     portal_approve, portal_approvals, portal_precall_get, portal_precall_submit
--   admin or inside           step_message (A's journey_set; invoker, see below)
--   internal only (no grant)  precall_request (D's pick), steps_* helpers
-- All but step_message are SECURITY DEFINER, so A's invoker functions (draft_write, journey_set) trust the calls even while a
-- client is logged in. System messages are posted as public.aviance_owner() (A).
--   approval_reminders is also run by A's journey_hourly() from pg_cron.

-- ---------------------------------------------------------------- private helpers

-- The client's live channel (the same one portal_home opens).
create or replace function public.steps_channel(p_client uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select c.id from public.channels c
   where c.kind = 'client' and c.client_id = p_client and c.archived_at is null
   order by c.created_at limit 1;
$$;

-- The portal login's own person row, or an error in plain words.
create or replace function public.steps_me() returns public.client_people
language plpgsql stable security definer set search_path = public as $$
declare per public.client_people;
begin
  if auth.uid() is null or public.portal_home() is null then
    raise exception 'Sign in to your Aviance channel first.';
  end if;
  select * into per from public.client_people where user_id = auth.uid() order by created_at limit 1;
  if not found then raise exception 'Sign in to your Aviance channel first.'; end if;
  return per;
end $$;

-- A valid time zone for a person (their own, else New York).
create or replace function public.steps_zone(p_zone text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from pg_timezone_names where name = nullif(trim(p_zone), '') limit 1), 'America/New_York');
$$;

-- Post a pure fact into the client's channel as the owner.
create or replace function public.steps_post_system(p_client uuid, p_body text, p_meta jsonb default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare ch uuid := public.steps_channel(p_client); who uuid := public.aviance_owner(); mid uuid;
begin
  if ch is null or who is null then return null; end if;
  insert into public.channel_messages (channel_id, author_user, body, msg_kind, meta)
  values (ch, who, p_body, 'system', p_meta) returning id into mid;
  return mid;
end $$;

-- ---------------------------------------------------------------- step_message

-- Queues the casual line for a step, depending on the step's CURRENT status. Called by A's journey_set
-- whenever a step changes to 'doing' or 'done'. SECURITY INVOKER on purpose (A's pattern): journey_set is an
-- invoker too, so when the admin calls it straight from the hub this runs as 'authenticated' (admin checked,
-- RLS applies); from inside a definer (portal_approve -> journey_set) it runs as the owner and is trusted.
-- Never queues the same step+status twice (pending or sent).
create or replace function public.step_message(p_client uuid, p_step text) returns void
language plpgsql security invoker set search_path = public as $$
declare st text; body text; lead text;
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    raise exception 'Only the owner can queue a step message.';
  end if;
  select status into st from public.journey_steps where client_id = p_client and step = p_step;
  if st is null then return; end if;

  if p_step = 'kickoff' and st = 'done' then
    body := 'thx for the call! diving into research now, back in ~2 days w ur icp + a few angles';
  elsif p_step = 'testing' and st = 'doing' then
    body := 'testing started 🚀 we''re sending small batches from our warmed inboxes to see which angle lands. daily numbers here';
  elsif p_step = 'testing' and st = 'done' then
    select nullif(trim(t.leading_angle), '') into lead from public.testing_days t
     where t.client_id = p_client and nullif(trim(t.leading_angle), '') is not null
     order by t.on_date desc limit 1;
    body := case when lead is null then 'testing done. building the real campaign now'
                 else 'testing done — ' || lead || ' came out on top. building the real campaign now' end;
  elsif p_step = 'onboarding' and st = 'done' then
    body := 'great call. we launch tmrw';
  elsif p_step = 'launch' and st = 'done' then
    body := 'ur live 🎉 first emails just went out, month one starts today';
  else
    return; -- research done (the approval carries it), build done, anything else: nothing
  end if;

  if exists (select 1 from public.bot_drafts d
              where d.client_id = p_client and d.kind = 'step' and d.status in ('pending', 'sent')
                and d.meta->>'step' = p_step and d.meta->>'status' = st) then
    return;
  end if;
  perform public.draft_write(p_client, 'step', body, 'bot',
    jsonb_build_object('step', p_step, 'status', st), 'step ' || p_step || ' is ' || st);
end $$;

-- ---------------------------------------------------------------- approvals

create or replace function public.approval_request(p_client uuid, p_kind text, p_title text, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare ch uuid; aid uuid; t text := trim(coalesce(p_title, '')); b text := trim(coalesce(p_body, '')); line text;
begin
  if not public.is_admin() then raise exception 'Only an admin can send something for approval.'; end if;
  if p_kind is null or p_kind not in ('icp', 'angles', 'copy') then raise exception 'Pick what this is: ICP, angles or copy.'; end if;
  if t = '' or length(t) > 160 then raise exception 'Give it a short title (up to 160 characters).'; end if;
  if b = '' or length(b) > 20000 then raise exception 'Write what the client should approve (up to 20,000 characters).'; end if;
  if not exists (select 1 from public.clients where id = p_client) then raise exception 'That client was not found.'; end if;
  ch := public.steps_channel(p_client);
  if ch is null then raise exception 'This client has no channel yet. Invite them to the portal first.'; end if;

  insert into public.approvals (client_id, channel_id, kind, title, body, status)
  values (p_client, ch, p_kind, t, b, 'pending') returning id into aid;

  line := case p_kind
    when 'icp'    then 'here''s ur icp + angles — have a look and hit approve (or tell me what to change)'
    when 'angles' then 'here are the angles we''ll test — have a look and hit approve (or tell me what to change)'
    else               'here''s the copy for ur campaign — have a look and hit approve (or tell me what to change)' end;

  return public.draft_write(p_client, 'approval', line, 'approval',
    jsonb_build_object('approval_id', aid, 'kind', p_kind, 'title', t, 'body', b), 'approval: ' || t);
end $$;

-- The caller's approvals, so the portal card can show the decided state.
create or replace function public.portal_approvals() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare per public.client_people := public.steps_me();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'title', a.title, 'body', a.body, 'status', a.status,
             'requested_at', a.requested_at, 'decided_at', a.decided_at, 'decided_name', a.decided_name, 'client_note', a.client_note)
           order by a.requested_at)
      from public.approvals a where a.client_id = per.client_id), '[]'::jsonb);
end $$;

create or replace function public.portal_approve(p_approval uuid, p_name text, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare per public.client_people := public.steps_me(); a public.approvals;
        nm text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
        nt text := nullif(trim(coalesce(p_note, '')), '');
        zone text; step_key text;
begin
  if p_decision is null or p_decision not in ('approve', 'changes') then raise exception 'Choose approve or ask for changes.'; end if;
  if length(nm) < 2 or length(nm) > 120 then raise exception 'Type your name (2 to 120 characters).'; end if;
  if p_decision = 'changes' and nt is null then raise exception 'Tell us what to change.'; end if;
  if nt is not null and length(nt) > 4000 then raise exception 'That note is too long. Use 4,000 characters or fewer.'; end if;

  select * into a from public.approvals where id = p_approval and client_id = per.client_id for update;
  if not found then raise exception 'We could not find that. Refresh the page and try again.'; end if;
  if a.status <> 'pending' then raise exception 'This one has already been answered.'; end if;

  update public.approvals
     set status = case when p_decision = 'approve' then 'approved' else 'changes' end,
         decided_at = now(), decided_name = nm, client_note = nt
   where id = a.id returning * into a;

  zone := public.steps_zone(per.timezone);
  if p_decision = 'approve' then
    perform public.steps_post_system(per.client_id,
      'approved by ' || nm || ' · ' || to_char(a.decided_at at time zone zone, 'Mon FMDD, FMHH12:MI AM'),
      jsonb_build_object('approval_id', a.id, 'decision', 'approved'));
    -- icp/angles finish research, copy finishes build, through A's journey_set (trusted here: we are definer)
    step_key := case when a.kind in ('icp', 'angles') then 'research' else 'build' end;
    if exists (select 1 from public.journey_steps where client_id = per.client_id and step = step_key and status <> 'done') then
      perform public.journey_set(per.client_id, step_key, 'done');
    end if;
  else
    perform public.steps_post_system(per.client_id, 'changes asked by ' || nm || ': ' || nt,
      jsonb_build_object('approval_id', a.id, 'decision', 'changes'));
  end if;

  return jsonb_build_object('id', a.id, 'kind', a.kind, 'title', a.title, 'status', a.status,
    'decided_at', a.decided_at, 'decided_name', a.decided_name, 'client_note', a.client_note);
end $$;

-- Hourly (A's journey_hourly): one nudge for an approval that was SENT more than 24h ago and is still pending.
create or replace function public.approval_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'Only an admin can send reminders.'; end if;
  for r in
    select a.id, a.client_id, a.title from public.approvals a
     where a.status = 'pending' and a.reminded_at is null
       and exists (select 1 from public.bot_drafts d
                    where d.client_id = a.client_id and d.msg_kind = 'approval' and d.status = 'sent'
                      and d.meta->>'approval_id' = a.id::text
                      and coalesce(d.decided_at, a.requested_at) < now() - interval '24 hours')
     for update of a skip locked
  loop
    perform public.draft_write(r.client_id, 'reminder',
      'hey just checking — did u get a chance to look at the ' || r.title || '?', 'bot',
      jsonb_build_object('approval_id', r.id), 'approval still open after 24h');
    update public.approvals set reminded_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- the pre-call form

-- D's portal_offer_pick calls this after booking a KICKOFF. One open form request per client.
create or replace function public.precall_request(p_client uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare old uuid;
begin
  if exists (select 1 from public.precall_forms f where f.client_id = p_client and f.submitted_at is not null) then return null; end if;
  select d.id into old from public.bot_drafts d
   where d.client_id = p_client and d.msg_kind = 'form' and d.status in ('pending', 'sent')
   order by d.created_at desc limit 1;
  if old is not null then return old; end if;
  return public.draft_write(p_client, 'form', 'quick one before the call — 4 short qs so we don''t waste ur time 👇', 'form',
    jsonb_build_object('form', 'precall'), 'kickoff booked: pre-call form');
end $$;

create or replace function public.portal_precall_get() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare per public.client_people := public.steps_me(); f public.precall_forms;
begin
  select * into f from public.precall_forms where client_id = per.client_id;
  if not found then
    return jsonb_build_object('offer', null, 'best_customers', null, 'deal_size', null, 'avoid', null, 'submitted_at', null);
  end if;
  return jsonb_build_object('offer', f.offer, 'best_customers', f.best_customers, 'deal_size', f.deal_size,
    'avoid', f.avoid, 'submitted_at', f.submitted_at);
end $$;

create or replace function public.portal_precall_submit(p_offer text, p_best text, p_deal text, p_avoid text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare per public.client_people := public.steps_me(); f public.precall_forms; first boolean;
        o text := trim(coalesce(p_offer, '')); b text := trim(coalesce(p_best, ''));
        d text := trim(coalesce(p_deal, '')); v text := trim(coalesce(p_avoid, ''));
begin
  if o = '' or b = '' or d = '' or v = '' then raise exception 'Answer all four questions (a word or two is fine).'; end if;
  if greatest(length(o), length(b), length(d), length(v)) > 2000 then raise exception 'Keep each answer under 2,000 characters.'; end if;
  first := not exists (select 1 from public.precall_forms where client_id = per.client_id and submitted_at is not null);
  insert into public.precall_forms (client_id, offer, best_customers, deal_size, avoid, submitted_at, updated_at)
  values (per.client_id, o, b, d, v, now(), now())
  on conflict (client_id) do update
     set offer = excluded.offer, best_customers = excluded.best_customers, deal_size = excluded.deal_size,
         avoid = excluded.avoid, submitted_at = coalesce(public.precall_forms.submitted_at, excluded.submitted_at),
         updated_at = now()
  returning * into f;
  if first then perform public.steps_post_system(per.client_id, 'form done ✓', jsonb_build_object('form', 'precall')); end if;
  return jsonb_build_object('offer', f.offer, 'best_customers', f.best_customers, 'deal_size', f.deal_size,
    'avoid', f.avoid, 'submitted_at', f.submitted_at);
end $$;

-- ---------------------------------------------------------------- testing numbers

create or replace function public.testing_day(p_client uuid, p_sent int, p_replies int, p_leading text, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare lead text := nullif(trim(coalesce(p_leading, '')), ''); dayno int; line text;
begin
  if not public.is_admin() then raise exception 'Only an admin can log testing numbers.'; end if;
  if p_sent is null or p_sent < 0 or p_replies is null or p_replies < 0 then raise exception 'Sent and replies must be 0 or more.'; end if;
  if lead is not null and length(lead) > 80 then raise exception 'Keep the leading angle under 80 characters.'; end if;
  if not exists (select 1 from public.clients where id = p_client) then raise exception 'That client was not found.'; end if;

  insert into public.testing_days (client_id, on_date, sent, replies, leading_angle, note)
  values (p_client, current_date, p_sent, p_replies, lead, nullif(trim(coalesce(p_note, '')), ''))
  on conflict (client_id, on_date) do update
     set sent = excluded.sent, replies = excluded.replies, leading_angle = excluded.leading_angle, note = excluded.note;

  select count(*) into dayno from public.testing_days where client_id = p_client and on_date <= current_date;
  line := 'day ' || dayno || ' of testing: ' || p_sent || ' sent · ' || p_replies || case when p_replies = 1 then ' reply' else ' replies' end
       || case when lead is null then ''
               when lead ~* 'angle' then ' · ' || lead || ' leading'
               else ' · angle ' || lead || ' leading' end;

  -- logging twice in a day replaces today's unsent line
  update public.bot_drafts set status = 'discarded', decided_at = now(), decided_by = auth.uid()
   where client_id = p_client and kind = 'update' and status = 'pending' and meta->>'on_date' = current_date::text;

  return public.draft_write(p_client, 'update', line, 'update',
    jsonb_build_object('sent', p_sent, 'replies', p_replies, 'leading', lead, 'day', dayno, 'on_date', current_date::text),
    'testing numbers for ' || current_date::text);
end $$;

-- ---------------------------------------------------------------- grants

revoke all on function public.steps_channel(uuid) from public, anon, authenticated;
revoke all on function public.steps_me() from public, anon, authenticated;
revoke all on function public.steps_zone(text) from public, anon, authenticated;
revoke all on function public.steps_post_system(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.step_message(uuid, text) from public, anon;
revoke all on function public.precall_request(uuid) from public, anon, authenticated;
revoke all on function public.approval_request(uuid, text, text, text) from public, anon;
revoke all on function public.testing_day(uuid, int, int, text, text) from public, anon;
revoke all on function public.approval_reminders() from public, anon;
revoke all on function public.portal_approvals() from public, anon;
revoke all on function public.portal_approve(uuid, text, text, text) from public, anon;
revoke all on function public.portal_precall_get() from public, anon;
revoke all on function public.portal_precall_submit(text, text, text, text) from public, anon;

grant execute on function public.step_message(uuid, text) to authenticated;
grant execute on function public.approval_request(uuid, text, text, text) to authenticated;
grant execute on function public.testing_day(uuid, int, int, text, text) to authenticated;
grant execute on function public.approval_reminders() to authenticated;
grant execute on function public.portal_approvals() to authenticated;
grant execute on function public.portal_approve(uuid, text, text, text) to authenticated;
grant execute on function public.portal_precall_get() to authenticated;
grant execute on function public.portal_precall_submit(text, text, text, text) to authenticated;
