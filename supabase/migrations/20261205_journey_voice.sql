-- The client-facing chat voice: warm, plain and professional instead of lowercase txt-speak.
-- These are B2B clients who have just paid $1,500-$10,800, so "hey, which works for ur kickoff?"
-- and "ur live 🎉" are not the register. "ICP" also becomes "target profile" in anything a client
-- reads. The hub's own labels are untouched.
--
-- WHY THIS IS A PATCH AND NOT A REDEFINITION. The wording lives in 20261124_steps.sql,
-- 20261124_scheduling.sql and 20261124_journey_core.sql, and those files have been edited to
-- match, so a fresh setup reads correctly. But they must NOT be re-run against a live database:
-- later migrations (20261124_full_run_fixes2, 20261129, 20261130, 20261203) have since replaced
-- some of the same functions, and re-running the November files would silently revert that.
-- offer_times is the clearest case — full_run_fixes2 taught it to skip US holidays and to
-- require two days' notice, and its message has been reflowed onto separate lines since.
-- So this migration takes each LIVE definition, swaps the wording inside it, and puts it back.
--
-- SAFE TO RUN TWICE. For each pair, if the old wording is gone and the new wording is already
-- there, that pair is simply skipped. If NEITHER is there, the whole migration raises and
-- nothing is written, so it can never half-apply.

create or replace function pg_temp.voice(p_fn text, p_pairs text[]) returns void
language plpgsql as $f$
declare d text; n text; i int;
begin
  d := pg_get_functiondef(p_fn::regprocedure);
  for i in 1 .. array_length(p_pairs, 1) by 2 loop
    n := replace(d, p_pairs[i], p_pairs[i + 1]);
    if n = d then
      -- the old wording was not found: fine only if the new wording is already in place
      if position(p_pairs[i + 1] in d) = 0 then
        raise exception 'queued wording not found in %, and the new wording is not there either: %',
          p_fn, left(p_pairs[i], 70);
      end if;
    end if;
    d := n;
  end loop;
  execute d;
end $f$;

do $$
begin

  -- ---------------------------------------------------------------- the welcome message
  perform pg_temp.voice('public.trg_person_welcome()', array[
    $a$'hey ' || coalesce(v_first, 'there') || '! welcome in 👋 this is ur direct line to us. i''ll send a few times for ur kickoff call shortly'$a$,
    $a$'Hi ' || coalesce(v_first, 'there') || ', welcome aboard. This is your direct line to us — I''ll send a few times for your kickoff call shortly.'$a$
  ]);

  -- ---------------------------------------------------------------- the five step messages
  perform pg_temp.voice('public.step_message(uuid,text)', array[
    $a$'thx for the call! diving into research now, back in ~2 days w ur icp + a few angles'$a$,
    $a$'Thank you for the call. We''re starting on your research now, and will be back in about two days with your target profile and a few angles.'$a$,

    $a$'testing started 🚀 we''re sending small batches from our warmed inboxes to see which angle lands. daily numbers here'$a$,
    $a$'Testing has started. We''re sending small batches from our warmed inboxes to see which angle lands, and the daily numbers will appear here.'$a$,

    -- the longer branch first, so neither can shadow the other
    $a$'testing done — ' || lead || ' came out on top. building the real campaign now'$a$,
    $a$'Testing is done — ' || lead || ' came out on top. We''re building the real campaign now.'$a$,

    $a$'testing done. building the real campaign now'$a$,
    $a$'Testing is done. We''re building the real campaign now.'$a$,

    $a$'great call. we launch tmrw'$a$,
    $a$'Great call, thank you. We launch tomorrow.'$a$,

    -- the one emoji that earns itself: going live
    $a$'ur live 🎉 first emails just went out, month one starts today'$a$,
    $a$'You''re live 🎉 Your first emails have just gone out, and month one starts today.'$a$
  ]);

  -- ---------------------------------------------------------------- the three approval lines
  perform pg_temp.voice('public.approval_request(uuid,text,text,text)', array[
    $a$'here''s ur icp + angles — have a look and hit approve (or tell me what to change)'$a$,
    $a$'Here''s your target profile and the angles that come out of it. Have a look and press Approve, or tell me what you''d like changed.'$a$,

    $a$'here are the angles we''ll test — have a look and hit approve (or tell me what to change)'$a$,
    $a$'Here are the angles we''ll test. Have a look and press Approve, or tell me what you''d like changed.'$a$,

    $a$'here''s the copy for ur campaign — have a look and hit approve (or tell me what to change)'$a$,
    $a$'Here''s the copy for your campaign. Have a look and press Approve, or tell me what you''d like changed.'$a$
  ]);

  -- ---------------------------------------------------------------- the 24-hour approval nudge
  perform pg_temp.voice('public.approval_reminders()', array[
    $a$'hey just checking — did u get a chance to look at the '$a$,
    $a$'Just checking in — did you get a chance to look at the '$a$
  ]);

  -- ---------------------------------------------------------------- the pre-call form line
  perform pg_temp.voice('public.precall_request(uuid)', array[
    $a$'quick one before the call — 4 short qs so we don''t waste ur time 👇'$a$,
    $a$'One quick thing before the call: four short questions, so we make the most of your time.'$a$
  ]);

  -- ---------------------------------------------------------------- the daily testing line
  perform pg_temp.voice('public.testing_day(uuid,int,int,text,text)', array[
    $a$'day ' || dayno || ' of testing: ' || p_sent || ' sent · ' || p_replies || case when p_replies = 1 then ' reply' else ' replies' end$a$,
    $a$'Day ' || dayno || ' of testing: ' || p_sent || ' sent, ' || p_replies || case when p_replies = 1 then ' reply' else ' replies' end || '.'$a$,

    $a$' · ' || lead || ' leading'$a$,
    $a$' The strongest angle so far is ' || lead || '.'$a$,

    $a$' · angle ' || lead || ' leading'$a$,
    $a$' The strongest angle so far is angle ' || lead || '.'$a$
  ]);

  -- ---------------------------------------------------------------- the times we read out
  -- 'tue nov 26, 10am ET' -> 'Tue Nov 26, 10am ET'
  perform pg_temp.voice('public.sched_when(timestamptz,text)', array[
    $a$'dy mon FMDD, FMHH12'$a$,
    $a$'Dy Mon FMDD, FMHH12'$a$
  ]);

  -- ---------------------------------------------------------------- the time-offer message
  -- NOTE the live body, not the November file: the message was reflowed onto its own lines by a
  -- later migration, so the needle is E'\n\njust reply ' and not ' just reply '.
  perform pg_temp.voice('public.offer_times(uuid,text)', array[
    $a$'hey, which works for ur '$a$,
    $a$'Which of these works for your '$a$,

    $a$E'\n\njust reply '$a$,
    $a$E'\n\nJust reply '$a$,

    $a$' (or tap one)'$a$,
    $a$', or tap one.'$a$
  ]);

end $$;

-- ---------------------------------------------------------------- the migration proves itself
-- Every new sentence must now be in the live definition, and no old txt-speak sentence may
-- survive in them. This is the guard the confirmation-email fix needed: a replace() whose
-- search string never matches fails silently otherwise.
--
-- Needles are dollar-quoted, never single-quoted. These sentences live inside string literals
-- in a function body, so an apostrophe is DOUBLED in the text we are searching ("We''re"), and
-- writing the needle as an ordinary SQL literal would quietly halve it and never match.
do $$
declare
  r      record;
  v_miss text[] := '{}';
  v_left text[] := '{}';
begin
  for r in
    select * from (values
      ('public.trg_person_welcome()',                  $c$welcome aboard. This is your direct line to us$c$),
      ('public.step_message(uuid,text)',               $c$Thank you for the call. We''re starting on your research now$c$),
      ('public.step_message(uuid,text)',               $c$your target profile and a few angles$c$),
      ('public.step_message(uuid,text)',               $c$Testing has started.$c$),
      ('public.step_message(uuid,text)',               $c$Testing is done. We''re building the real campaign now.$c$),
      ('public.step_message(uuid,text)',               $c$Testing is done — $c$),
      ('public.step_message(uuid,text)',               $c$Great call, thank you. We launch tomorrow.$c$),
      ('public.step_message(uuid,text)',               $c$You''re live 🎉 Your first emails have just gone out$c$),
      ('public.approval_request(uuid,text,text,text)', $c$Here''s your target profile and the angles that come out of it.$c$),
      ('public.approval_request(uuid,text,text,text)', $c$Here are the angles we''ll test.$c$),
      ('public.approval_request(uuid,text,text,text)', $c$Here''s the copy for your campaign.$c$),
      ('public.approval_request(uuid,text,text,text)', $c$press Approve, or tell me what you''d like changed.$c$),
      ('public.approval_reminders()',                  $c$Just checking in — did you get a chance to look at the $c$),
      ('public.precall_request(uuid)',                 $c$One quick thing before the call: four short questions$c$),
      ('public.testing_day(uuid,int,int,text,text)',   $c$Day ' || dayno || ' of testing: $c$),
      ('public.testing_day(uuid,int,int,text,text)',   $c$The strongest angle so far is $c$),
      ('public.sched_when(timestamptz,text)',          $c$Dy Mon FMDD, FMHH12$c$),
      ('public.offer_times(uuid,text)',                $c$Which of these works for your $c$),
      ('public.offer_times(uuid,text)',                $c$Just reply $c$),
      ('public.offer_times(uuid,text)',                $c$, or tap one.$c$)
    ) as t(fn, needle)
  loop
    if position(r.needle in pg_get_functiondef(r.fn::regprocedure)) = 0 then
      v_miss := v_miss || (r.fn || ' :: ' || r.needle);
    end if;
  end loop;

  -- and nothing a client reads still speaks the old way. Each needle below is chosen so the NEW
  -- wording cannot trip it: "for ur campaign" rather than "ur campaign", because "your campaign"
  -- contains "ur campaign".
  for r in
    select * from (values
      ('public.trg_person_welcome()',                  $c$welcome in$c$),
      ('public.step_message(uuid,text)',               $c$thx for the call$c$),
      ('public.step_message(uuid,text)',               $c$ur icp$c$),
      ('public.step_message(uuid,text)',               $c$we launch tmrw$c$),
      ('public.step_message(uuid,text)',               $c$ur live$c$),
      ('public.step_message(uuid,text)',               $c$testing started$c$),
      ('public.step_message(uuid,text)',               $c$building the real campaign now'$c$),
      ('public.approval_request(uuid,text,text,text)', $c$ur icp$c$),
      ('public.approval_request(uuid,text,text,text)', $c$hit approve$c$),
      ('public.approval_request(uuid,text,text,text)', $c$for ur campaign$c$),
      ('public.approval_reminders()',                  $c$did u get a chance$c$),
      ('public.precall_request(uuid)',                 $c$waste ur time$c$),
      ('public.testing_day(uuid,int,int,text,text)',   $c$ leading'$c$),
      ('public.sched_when(timestamptz,text)',          $c$dy mon$c$),
      ('public.offer_times(uuid,text)',                $c$works for ur $c$),
      ('public.offer_times(uuid,text)',                $c$just reply $c$),
      ('public.offer_times(uuid,text)',                $c$(or tap one)$c$)
    ) as t(fn, needle)
  loop
    if position(r.needle in pg_get_functiondef(r.fn::regprocedure)) > 0 then
      v_left := v_left || (r.fn || ' :: ' || r.needle);
    end if;
  end loop;

  if array_length(v_miss, 1) > 0 then
    raise exception 'the new wording did not land: %', v_miss;
  end if;
  if array_length(v_left, 1) > 0 then
    raise exception 'the old txt-speak is still there: %', v_left;
  end if;
  raise notice 'journey voice: all 20 new lines in place, no old wording left.';
end $$;
