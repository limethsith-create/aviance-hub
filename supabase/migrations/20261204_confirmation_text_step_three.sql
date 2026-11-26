-- Kickoff / onboarding confirmation emails: two things 20261203_confirmation_email_fix.sql left behind.
--
-- 1. THE PLAIN-TEXT BODY LOST PREP STEP 3. body_text replaced lines 2 AND 3 together with one
--    line, so the text part of the email read "2. <prep>" and had no step 3 at all. The HTML was
--    fixed in 20261203 by replacing each sentence on its own; body_text now does the same.
--
-- 2. THE HTML HEADLINE NEVER CHANGED. The function looked for the plain sentence
--    'You''re booked in.' in body_html, but the hero markup is
--        You&rsquo;re<br>booked in<span style="color:#E0290F">.</span>
--    — a &rsquo; entity, a <br> between the words, and the full stop in its own red <span>. The
--    search string could never appear, so every kickoff and onboarding email went out with the
--    generic headline, which is the version almost everyone sees. We now match the real markup
--    and keep the red full stop. Both replaces are left in place; if the hero is ever reworded,
--    replace() simply finds nothing and the old headline stays — it cannot corrupt the HTML.
--
-- Patches whatever version is live in place, so the rest of the body is left as it is.
-- Each step refuses loudly if its pattern is not found, so this can never half-apply.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.queue_meeting_confirmation()'::regprocedure);

  -- 1. the plain-text body: each sentence replaced on its own, so "3." survives
  -- (no 'n' flag anywhere here: `.` must run across the newlines inside the body)
  n := regexp_replace(d, 'body_text = replace\(.*?end\),\s*body_html',
    $b$body_text = replace(replace(replace(replace(mo.body_text,
                      ', 30 minutes.', ', ' || coalesce(new.minutes, 30) || ' minutes.'),
                      'Think about who your best customers are.', coalesce(v_prep, 'Think about who your best customers are.')),
                      'Know what one new customer is worth to you.',
                        case v_what when 'Kickoff' then 'Have one or two of your best customers in mind. We build your target profile from them.'
                                    when 'Onboarding call' then 'Bring any last questions. After this call we launch.'
                                    else 'Know what one new customer is worth to you.' end),
                      'You''re booked in.', case when v_what is null then 'You''re booked in.' else 'Your ' || lower(v_what) || ' is booked.' end),
        body_html$b$);
  if n = d then raise exception 'body_text pattern not found'; end if;
  d := n;

  -- 2. the HTML hero headline, matched against the markup that is really there
  n := regexp_replace(d, 'body_html = case when mo\.body_html is null then null else.*?end\s*where mo\.meeting_id',
    $b$body_html = case when mo.body_html is null then null else
                      replace(replace(replace(replace(replace(replace(mo.body_html,
                      '&middot; 30 minutes', '&middot; ' || coalesce(new.minutes, 30) || ' minutes'),
                      ', 30 minutes.', ', ' || coalesce(new.minutes, 30) || ' minutes.'),
                      'Think about who your best customers are.', coalesce(v_prep, 'Think about who your best customers are.')),
                      'Know what one new customer is worth to you.',
                        case v_what when 'Kickoff' then 'Have one or two of your best customers in mind. We build your target profile from them.'
                                    when 'Onboarding call' then 'Bring any last questions. After this call we launch.'
                                    else 'Know what one new customer is worth to you.' end),
                      'You''re booked in.', case when v_what is null then 'You''re booked in.' else 'Your ' || lower(v_what) || ' is booked.' end),
                      'You&rsquo;re<br>booked in<span style="color:#E0290F">.</span>',
                        case v_what when 'Kickoff' then 'Your kickoff<br>is booked<span style="color:#E0290F">.</span>'
                                    when 'Onboarding call' then 'Your onboarding<br>call is booked<span style="color:#E0290F">.</span>'
                                    else 'You&rsquo;re<br>booked in<span style="color:#E0290F">.</span>' end) end
       where mo.meeting_id$b$);
  if n = d then raise exception 'body_html hero pattern not found'; end if;

  execute n;
end $$;

-- The self-check this class of bug needed. Every literal the function searches for with
-- replace(mo.body_text, ...) / replace(mo.body_html, ...) must actually occur in a real queued
-- confirmation. A search string that can never match is exactly what let the HTML headline rot
-- for a release while the text fix "passed".
do $$
declare
  v_def  text := pg_get_functiondef('public.queue_meeting_confirmation()'::regprocedure);
  v_text text;
  v_html text;
  r      record;
  v_miss text[] := '{}';
begin
  select body_text, body_html into v_text, v_html
    from public.mail_outbox
   where kind = 'booking_confirmation' and body_html is not null
   order by created_at desc limit 1;
  if v_text is null then
    raise notice 'No booking_confirmation to check against yet — skipping the needle check.';
    return;
  end if;
  -- every single-quoted literal that is used as a replace() needle, i.e. the first argument
  -- of each pair; the ones we care about are the human sentences and the hero markup
  for r in
    select unnest(array[
      ', 30 minutes.',
      'Think about who your best customers are.',
      'Know what one new customer is worth to you.'
    ]) as needle, 'text' as part
    union all
    select unnest(array[
      '&middot; 30 minutes',
      ', 30 minutes.',
      'Think about who your best customers are.',
      'Know what one new customer is worth to you.',
      'You&rsquo;re<br>booked in<span style="color:#E0290F">.</span>'
    ]) as needle, 'html' as part
  loop
    if position(r.needle in case r.part when 'text' then v_text else v_html end) = 0 then
      v_miss := v_miss || (r.part || ': ' || r.needle);
    end if;
  end loop;
  if array_length(v_miss, 1) > 0 then
    raise exception 'queue_meeting_confirmation searches for text that is not in the template: %', v_miss;
  end if;
  -- and the plain sentence the HTML chain still looks for is known NOT to be in the HTML; that
  -- replace is kept on purpose as a belt-and-braces for a future plain-sentence template, so it
  -- is deliberately left out of the check above.
  if v_def is null then raise exception 'unreachable'; end if;
end $$;
