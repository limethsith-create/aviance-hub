-- remove-calling.sql — Aviance is not cold calling any more.
--
-- Written by agent E on branch claude/portal, 2026-11-26, against project
-- zjbxnkpktbghhudjbxhk. NOT APPLIED: every statement below is destructive, so it is
-- left here for the owner to read and run. Apply it as one migration.
--
-- The repo side is already done on the branch: callers.js/.css/.html, caller-page.js/.css
-- and their two test files are deleted, the /callers rewrite is out of vercel.json, the
-- caller-link edge function no longer has a caller branch, and Today's "Dials today" tile
-- and its call_log read are out of digest.js. So every statement below is unblocked:
-- there is no second part and nothing is left pending.
--
-- Every name dropped below was grepped against the whole repo AND against pg_proc.prosrc,
-- pg_policies, pg_trigger and information_schema.views first. The comment above each
-- statement says what referenced it and what came back clean.
--
-- WHAT IS DELIBERATELY NOT DROPPED (checked, and NOT caller-only — do not add these):
--   staff.kind                  is_staff(), my_staff_channel(), staff_list(),
--                               staff_link_new(), staff_link_claim() and staff_invite_mail()
--                               all test kind = 'employee'. The column stays; only the
--                               caller ROWS go (step 11). See the optional step 13.
--   staff.link_hash, link_uses, link_made_at, link_expires_at, link_last_used
--                               the one-click invite link is shared: 20261128_invite_link.sql
--                               is titled "for callers and employees" and employees.js
--                               (empLink -> staff_link_new) is the live caller of it.
--   staff_link_new / staff_link_claim / staff_link_clear / staff_link_auth
--                               same: the Employees screen and the /go link use all four.
--   staff_invite_mail_core      this is the EMPLOYEE invite email. Keep it. (staff_invite_mail
--                               is the caller one — but it is also the entry point the
--                               staff-code edge function calls for everyone, so it is
--                               emptied into a pass-through in step 9, not dropped.)
--   esc_html()                  added by the caller migration but used by the mail_* family.
--   booking_must_be_free()      the website's free-slot guard. It only MENTIONS a caller;
--                               step 1 rewrites it, it is not dropped.
--
-- ORDER MATTERS: policies before the functions they call, tables before the functions that
-- read them is irrelevant for Postgres (prosrc is not tracked) but is kept for readability.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. booking_must_be_free(): the same trigger function, with the caller credit gone.
--    It is the BEFORE INSERT guard on discovery_bookings (trigger
--    discovery_bookings_free_slot) and it STAYS — the website books through it. It is
--    rewritten here only because its last two lines read new.caller_id and
--    my_caller_id(), both of which go below. Body otherwise byte-for-byte the live one.
--    (The copy in 20261130_server_fixes.sql is history and is not edited, per
--    supabase/migrations/README.md.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.booking_must_be_free()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
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
  return new;
end $fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The two RESTRICTIVE policies on discovery_bookings that existed only to refuse a
--    caller. Checked in pg_policies: their whole expression is "NOT is_caller()", they
--    are the only policies on that table mentioning a caller, and with no callers left
--    they can only cost a function call on every website booking. The website's own
--    permissive "website can book" policy is untouched.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "callers never insert bookings" on public.discovery_bookings;
drop policy if exists "callers never change bookings" on public.discovery_bookings;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. discovery_bookings.caller_id — "the cold caller who booked it", set only by
--    caller_book(). 1 row has one today (a test booking from the Callers screen).
--    Referenced by: booking_must_be_free (rewritten in step 1), the two policies dropped
--    in step 2, callers_board (dropped in step 5) and its own index. Nothing else: no
--    view, no trigger, and no file in the repo reads it (grepped).
-- ─────────────────────────────────────────────────────────────────────────────
drop index if exists public.discovery_bookings_caller_idx;
alter table public.discovery_bookings drop column if exists caller_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The two caller SELECT policies. They are the only permissive policies in public
--    that name a caller (verified against pg_policies). leads goes away entirely in
--    step 7 and call_log in step 10, but both policies are dropped here by name first:
--    an RLS policy is a real dependency on my_caller_id(), so step 6 cannot drop that
--    function while either policy still exists.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "leads_caller_reads_own" on public.leads;
drop policy if exists "call_log_caller_reads_own" on public.call_log;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The owner's caller RPCs. Called only from callers.js, which is deleted. Nothing in
--    pg_proc.prosrc calls any of them except each other.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.callers_list();
drop function if exists public.callers_board(integer);
drop function if exists public.caller_add(text, text);
drop function if exists public.caller_set_status(uuid, text);
drop function if exists public.leads_import(jsonb, text);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The caller's own five RPCs plus their four helpers. Called only from
--    caller-page.js, which is deleted. The only outside reference to any of them was
--    booking_must_be_free -> my_caller_id(), fixed in step 1, and a comment in
--    booking_must_be_free naming caller_book, which the rewrite drops.
--    caller_lead_json, caller_today and caller_next_id were inside-only already
--    (execute revoked from every API role by 20261130_server_fixes.sql).
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.caller_me();
drop function if exists public.caller_next();
drop function if exists public.caller_log(uuid, text, text, timestamptz);
drop function if exists public.caller_slots(integer);
drop function if exists public.caller_book(uuid, timestamptz, text, text, text, text, text);
drop function if exists public.caller_lead_json(uuid);
drop function if exists public.caller_today(uuid);
drop function if exists public.caller_next_id(uuid);
drop function if exists public.caller_bonus();            -- read only by callers_board, dropped in step 5

-- is_caller() and my_caller_id() are called from inside RLS policies, so they go AFTER
-- the policies that call them (steps 2 and 4) and after step 1. Re-checked: no other
-- policy, trigger or function names either.
drop function if exists public.is_caller();
drop function if exists public.my_caller_id();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. public.leads — the cold-calling list, 5 rows. Caller-only beyond doubt: only the
--    caller_* functions (all dropped above) and callers.js/caller-page.js (deleted) ever
--    touched it. CASCADE drops exactly one thing: the call_log.lead_id foreign key.
--    *** THIS DELETES 5 LEAD ROWS. They are the test import from the Callers screen. ***
-- ─────────────────────────────────────────────────────────────────────────────
drop table if exists public.leads cascade;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. The do-not-call list and the owner's old dialling targets. Both are empty (0 rows,
--    confirmed) and are orphans: the screen that used them (calling.js) is already gone —
--    tests/app.test.mjs line 103 asserts the 'calling', 'callTargets' and 'dnc' routes no
--    longer exist. No file in the repo reads either table (grepped). Their two trigger
--    functions are used by nothing else (pg_proc checked). CASCADE on call_targets drops
--    only the call_log.target_id foreign key.
-- ─────────────────────────────────────────────────────────────────────────────
drop table if exists public.dnc cascade;                       -- takes trigger dnc_retires with it
drop table if exists public.call_targets cascade;              -- takes trigger call_targets_dnc with it
drop function if exists public.dnc_blocks_target() cascade;
drop function if exists public.dnc_retires_targets() cascade;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. staff_invite_mail(p_staff, p_code) — the CALLER invite email ("Your calling list is
--    ready", linking to /callers, which no longer exists).
--    CAREFUL, and this is why it is not dropped: it is also the name the staff-code edge
--    function calls for EVERY staff member (supabase/functions/staff-code/index.ts:142),
--    and its body already forwards an employee to staff_invite_mail_core. So the caller
--    email is removed by making the whole function a pass-through. Nothing about an
--    employee's invite changes, and it cannot break whichever order SQL and edge
--    functions are deployed in.
--    staff_invite_mail_core — the EMPLOYEE email, "open your channel" — is NOT touched.
--    (Optional follow-up for the owner, not done here: point staff-code at
--    staff_invite_mail_core directly, then drop this wrapper.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.staff_invite_mail(p_staff uuid, p_code text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
begin
  -- There is one staff invite email now: the employee's. Aviance does not cold call.
  return public.staff_invite_mail_core(p_staff, p_code);
end $fn$;

revoke execute on function public.staff_invite_mail(uuid, text) from public, anon;
grant  execute on function public.staff_invite_mail(uuid, text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. public.call_log — the log of dials, 5 rows, all written by a caller. This IS a
--     cold-calling table: target_id pointed at the owner's old dialling list
--     (call_targets, dropped in step 8) and lead_id at the callers' leads (step 7).
--     It was blocked on one reader, Today's "Dials today" tile — digest.js:317 read it
--     and digest.js:715 drew it. Both are now removed on this branch, with the three
--     assertions in tests/digest.test.mjs, so nothing in the repo or in pg_proc reads
--     call_log any more (re-grepped after the change). CASCADE takes its two is_approved()
--     team policies and the two caller indexes with it.
--     *** THIS DELETES 5 CALL LOG ROWS and the table. ***
-- ─────────────────────────────────────────────────────────────────────────────
drop table if exists public.call_log cascade;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. The caller staff rows: 2 of the 3 rows in public.staff. The third is Vera, the
--     employee — she is kind = 'employee' and is NOT touched. A caller has no channel,
--     so there is no channel, no membership and no message to clean up (checked: a
--     caller's channel_id is null). Their foreign keys are already gone with leads and
--     the call_log/discovery_bookings columns above.
--     *** Their Supabase AUTH logins and profiles rows are NOT removed here. One of the
--     two callers has a login (the other never signed in). Deleting an auth user cannot
--     be done in SQL safely from a migration; the owner should delete that caller login
--     in the Supabase dashboard (Authentication -> Users). Until then the login can sign
--     in and see nothing: is_approved() is false for it,
--     is_staff() is false (kind test), and every caller_* RPC is gone. ***
-- ─────────────────────────────────────────────────────────────────────────────
delete from public.staff where kind = 'caller';

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. The caller settings keys. 'caller_bonus' is the only key in
--     workspace_admin.data->'business' today (value '25'); 'caller_script' was never set.
--     Read only by caller_bonus() and caller_me(), both dropped. settings.js does not
--     mention either (grepped), so no screen loses a field.
-- ─────────────────────────────────────────────────────────────────────────────
update public.workspace_admin
   set data = jsonb_set(data, '{business}',
                        (data->'business') - 'caller_bonus' - 'caller_script')
 where id = 1 and data ? 'business';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. OPTIONAL, and left commented on purpose. staff.kind now only ever holds
--     'employee', but the column and its check constraint are shared machinery (see the
--     header). Narrowing the constraint makes a caller row impossible to create again.
--     Run it only when you are sure no caller rows are coming back.
--
--     alter table public.staff drop constraint if exists staff_kind_check;
--     alter table public.staff add  constraint staff_kind_check check (kind in ('employee'));
--     comment on column public.staff.kind is 'Always ''employee''. Cold calling is retired.';
-- ─────────────────────────────────────────────────────────────────────────────
