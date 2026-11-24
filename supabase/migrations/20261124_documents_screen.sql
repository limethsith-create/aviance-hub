-- Documents screen: one live preview of everything that goes out to a client.
-- documents_preview() runs the REAL flow (booking -> won -> paid -> journey messages) for a sample
-- client on each plan inside a sub-transaction, collects every email / document / chat message it
-- produced, then rolls it all back. Nothing is kept and nothing is sent (the mail rows and the
-- net.http_post queue are rolled back with it). The invoice number sequence is put back after.
-- Owner only.

create or replace function public.documents_preview() returns jsonb
language plpgsql security definer set search_path to 'public' as $fn$
declare
  out jsonb := '[]'::jsonb;
  v_seq bigint; v_called boolean;
  v_plan text; v_term text; v_label text; v_i int := 0;
  b uuid; r jsonb; cid uuid; inv uuid; ag uuid; d uuid; ap uuid;
  v_at timestamptz := (date_trunc('day', now() at time zone 'America/Chicago') + interval '2 days 10 hours') at time zone 'America/Chicago';
  v_zone text := 'America/Chicago';
  k text;
begin
  if not public.is_admin() then raise exception 'Only the owner can see this.'; end if;
  select last_value, is_called into v_seq, v_called from public.invoice_no_seq;

  -- 1. the call emails (same text for every plan)
  foreach k in array array['booking_confirmation','reminder_24h','reminder_1h','reminder_5min'] loop
    out := out || jsonb_build_object('group', 'Discovery call', 'key', k, 'type', 'email',
      'title', case k when 'booking_confirmation' then 'Booking confirmation'
                      when 'reminder_24h' then 'Reminder: the day before'
                      when 'reminder_1h' then 'Reminder: 1 hour before'
                      else 'Reminder: 5 minutes before' end,
      'subject', public.mail_subject(k, v_at, v_zone),
      'text', replace(public.mail_text(k, 'Sam Lee', v_at, v_zone), '{{MEET_LINK}}', 'https://meet.google.com/abc-defg-hij'));
  end loop;

  -- 2. per plan: the real won -> paid flow, rolled back
  foreach v_plan in array array['pilot','starter3','growth','scale'] loop
    v_i := v_i + 1;
    v_term := case when v_plan = 'starter3' then '3month' else 'monthly' end;
    v_label := case v_plan when 'pilot' then 'Pilot' when 'starter3' then 'Starter (3 months)' when 'growth' then 'Growth' else 'Scale' end;
    begin
      insert into public.discovery_bookings(name, email, company, plan, call_at, minutes, timezone, source, status)
      values ('Sam Lee', 'preview@example.com', 'Sample Co', replace(v_plan, '3', ''),
              v_at + make_interval(days => 300 + v_i), 30, v_zone, 'documents preview', 'booked')
      returning id into b;
      r := public.close_won(b, replace(v_plan, '3', ''), v_term);
      cid := (r->>'client_id')::uuid; inv := (r->>'invoice_id')::uuid; ag := (r->>'agreement_id')::uuid;
      if ag is not null then
        out := out || jsonb_build_object('group', 'Agreements', 'key', 'agreement_' || v_plan, 'type', 'agreement',
          'title', 'Agreement — ' || v_label, 'doc', public.doc_get(public.doc_token('a', ag)));
      end if;
      out := out || jsonb_build_object('group', 'Invoices', 'key', 'invoice_' || v_plan, 'type', 'invoice',
        'title', 'Invoice — ' || v_label, 'doc', public.doc_get(public.doc_token('i', inv)));

      perform public.mark_paid(inv, 'preview');
      out := out || jsonb_build_object('group', 'Receipts', 'key', 'receipt_' || v_plan, 'type', 'invoice',
        'title', 'Receipt — ' || v_label, 'doc', public.doc_get(public.doc_token('i', inv)));

      -- the chat messages, once (they are the same for every plan)
      if v_plan = 'growth' then
        begin
          set constraints all immediate;
          update public.client_people set user_id = auth.uid() where client_id = cid and user_id is null
            and id = (select id from public.client_people where client_id = cid order by created_at limit 1);
        exception when others then null; end;
        d := public.offer_times(cid, 'kickoff');
        perform public.precall_request(cid);
        perform public.journey_set(cid, 'kickoff', 'done', null);
        ap := public.approval_request(cid, 'icp', 'ICP + angles', 'Owners of 10–50 truck HVAC shops in TX. Angles: after-hours, speed, maintenance plans.');
        perform public.journey_set(cid, 'testing', 'doing', null);
        perform public.testing_day(cid, 240, 7, 'after-hours', null);
        perform public.journey_set(cid, 'testing', 'done', null);
        ap := public.approval_request(cid, 'copy', 'Campaign copy', 'Subject: after-hours calls\n\nhey {first}, quick one…');
        perform public.journey_set(cid, 'build', 'done', null);
        d := public.offer_times(cid, 'onboarding');
        perform public.journey_set(cid, 'onboarding', 'done', null);
        perform public.journey_set(cid, 'launch', 'done', null);
        out := out || coalesce((select jsonb_agg(jsonb_build_object('group', 'Chat messages', 'key', 'chat_' || x.kind || '_' || x.n,
                 'type', 'chat', 'title', x.title, 'text', x.body, 'meta', x.meta) order by x.n)
          from (select bd.kind, bd.body, bd.meta, row_number() over (order by bd.created_at, bd.id) n,
                       case bd.kind when 'welcome' then 'Welcome (first login)'
                                    when 'offer' then case when bd.body ilike '%onboarding%' then 'Onboarding call: pick a time' else 'Kickoff: pick a time' end
                                    when 'form' then 'Pre-call form'
                                    when 'approval' then 'Approval request: ' || coalesce(bd.meta->>'title', '')
                                    when 'update' then 'Daily testing update'
                                    when 'step' then 'Step: ' || coalesce(bd.meta->>'step', '') || ' ' || coalesce(bd.meta->>'status', '')
                                    else initcap(bd.kind) end title
                  from public.bot_drafts bd where bd.client_id = cid) x), '[]'::jsonb);
      end if;

      -- every email this plan produced (pack, receipt, welcome, invite …)
      out := out || coalesce((select jsonb_agg(jsonb_build_object('group', 'Emails — ' || v_label, 'key', 'mail_' || v_plan || '_' || mo.kind || '_' || mo.id,
               'type', 'email', 'title', initcap(replace(mo.kind, '_', ' ')), 'subject', mo.subject,
               'text', mo.body_text, 'html', mo.body_html) order by mo.created_at)
        from public.mail_outbox mo where mo.client_id = cid or mo.booking_id = b), '[]'::jsonb);

      raise exception using errcode = 'P0V01', message = 'preview rollback';
    exception
      when sqlstate 'P0V01' then null;
      when others then
        out := out || jsonb_build_object('group', 'Problems', 'key', 'err_' || v_plan, 'type', 'error',
          'title', 'Could not build the ' || v_label || ' preview', 'text', sqlerrm);
    end;
  end loop;

  -- put the number back, but never below an invoice someone made while this ran
  select greatest(v_seq, coalesce(max(nullif(regexp_replace(number, '^.*-', ''), '')::bigint), 0)) into v_seq
    from public.invoices where number ~ '-[0-9]+$';
  perform setval('public.invoice_no_seq', v_seq, true);
  return out;
end $fn$;

revoke all on function public.documents_preview() from public, anon;
grant execute on function public.documents_preview() to authenticated;
