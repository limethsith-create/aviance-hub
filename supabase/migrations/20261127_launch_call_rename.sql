-- The third call is the LAUNCH call, not the onboarding call.
-- The three calls a client has are: Discovery → Kickoff → Launch.
--
-- Only the WORDS change. The stored meetings.kind stays 'onboarding' and the
-- journey step stays 'onboarding', so nothing that reads them has to change and
-- nothing can break. The hub and the portal already show "Launch call"; this is
-- the same rename for the text that lives in the database — email subjects, the
-- documents preview, the booking title and the journey seed.
--
-- It rewrites each function from its own current definition, so nothing else in
-- the body can drift: pg_get_functiondef gives back CREATE OR REPLACE ... and the
-- only edit is the wording. Safe to run twice (the second run finds nothing).
--
-- Note on the title matchers: sched_book and queue_meeting_confirmation match a
-- meeting title with LIKE 'Onboarding call%'. Those become 'Launch call%', which
-- matches the titles they now write. No meeting exists with an old title — the
-- table is empty — so nothing is orphaned.
do $$
declare r record; src text; n int := 0;
begin
  for r in
    select p.oid, p.proname
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and pg_get_functiondef(p.oid) like '%nboarding call%'
     order by p.proname
  loop
    src := pg_get_functiondef(r.oid);
    src := replace(src, 'Onboarding call', 'Launch call');
    src := replace(src, 'onboarding call', 'launch call');
    execute src;
    n := n + 1;
    raise notice 'reworded %', r.proname;
  end loop;
  raise notice '% function(s) reworded', n;
end $$;

-- Proof: this must come back with no rows.
select p.proname as "still says onboarding call"
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'public' and pg_get_functiondef(p.oid) like '%nboarding call%';
