-- Kickoff / onboarding confirmation emails (HTML version), found in the perfection run:
-- 1. step "03" was printed with nothing next to it
-- 2. the length always said "30 minutes", even for a 45-minute kickoff
-- Patches the live function in place so whatever version is live keeps the rest of its body.
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.queue_meeting_confirmation()'::regprocedure);
  n := replace(d,
    $a$case when v_prep is null then 'Know what one new customer is worth to you.' else '' end)$a$,
    $b$case v_what when 'Kickoff' then 'Have one or two of your best customers in mind. We build your target profile from them.'
                                when 'Onboarding call' then 'Bring any last questions. After this call we launch.'
                                else 'Know what one new customer is worth to you.' end)$b$);
  if n = d then raise exception 'step 3 pattern not found'; end if;
  d := n;
  n := replace(d,
    $a$replace(replace(replace(replace(mo.body_html,$a$,
    $b$replace(replace(replace(replace(replace(mo.body_html, '&middot; 30 minutes', '&middot; ' || coalesce(new.minutes, 30) || ' minutes'),$b$);
  if n = d then raise exception 'minutes pattern not found'; end if;
  execute n;
end $$;
