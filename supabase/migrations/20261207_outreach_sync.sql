-- Aviance OS — outreach-sync: who may read the outreach tables, and what runs the job.
--
-- The outreach_* tables already existed and already carry the unique indexes the sync needs
-- (outreach_campaigns_ext_uq on (account_id, external_id), outreach_inboxes_uq on
-- (account_id, email), outreach_daily_uq on (campaign_id, on_day), outreach_threads_ext_uq on
-- (campaign_id, external_id), outreach_messages_ext_uq on (thread_id, external_id)), so a second
-- run of the job changes rows and never adds them. Nothing here adds a column or an index.
--
-- Two things were missing:
--
--  1. RLS for the client. Every outreach_* table had staff policies only (is_approved()), which
--     means a signed-in client saw nothing at all. The portal has to show a client their own
--     campaign, and MUST never show them anyone else's: this is a client's prospect list.
--     So each table gets one extra SELECT policy, `client_id = public.portal_client_id()`.
--     Read only — a client never writes an outreach row; the sync writes them as service_role,
--     which is not subject to RLS. The staff policies are left exactly as they were.
--
--  2. The schedule. pg_cron, every fifteen minutes, the same shape as 'aviance-mail-tick'.
--
-- NOTE on secrets: the gateway key the cron job has to send is NOT written in this file. The DO
-- block below lifts it out of the existing 'aviance-mail-tick' job's own command, so the only
-- copy of it stays in the database where it already is. If that job is ever gone, this one is
-- not scheduled and says so, rather than being scheduled with no key and failing silently.

-- ---------------------------------------------------------------- who is this client?
-- client_people maps a signed-in user to a client, but client_people's own RLS is staff-only, so
-- a policy cannot look at it directly. Hence a definer function, the same trick portal_home()
-- already uses. STABLE, so the planner calls it once per statement and not once per row.
create or replace function public.portal_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select cp.client_id from public.client_people cp where cp.user_id = auth.uid() limit 1
$$;

comment on function public.portal_client_id() is
  'The client a signed-in portal user belongs to, or null. Used by the outreach_* client policies.';

-- ---------------------------------------------------------------- the client's own rows, and no others
-- `create policy` has no `or replace`, so each one is dropped by name first. Dropping by name is
-- safe: these names are new and belong to this migration only.

-- Three of the six tables are deliberately NOT readable by a client, because nothing a client
-- sees needs them and each one leaks something internal:
--   outreach_accounts  — carries `key_ref` (the name of a secret) and `last_error` (our wording,
--                        written for us, not for them).
--   outreach_inboxes   — the domains and addresses we send from, and their health. Ours, not theirs.
--   outreach_messages  — the full body of every email. The portal shows counts and the prospects
--                        who replied, never our copy. If a client should ever read their own
--                        campaign's copy, add the policy then, on purpose.
-- The portal reads outreach_campaigns, outreach_daily and outreach_threads and nothing else
-- (portal-tracker.js:41-42), so this is the whole surface it needs.
drop policy if exists outreach_accounts_client_read on public.outreach_accounts;
drop policy if exists outreach_inboxes_client_read on public.outreach_inboxes;
drop policy if exists outreach_messages_client_read on public.outreach_messages;

drop policy if exists outreach_campaigns_client_read on public.outreach_campaigns;
create policy outreach_campaigns_client_read on public.outreach_campaigns
  for select using (client_id = public.portal_client_id());

drop policy if exists outreach_daily_client_read on public.outreach_daily;
create policy outreach_daily_client_read on public.outreach_daily
  for select using (client_id = public.portal_client_id());

drop policy if exists outreach_threads_client_read on public.outreach_threads;
create policy outreach_threads_client_read on public.outreach_threads
  for select using (client_id = public.portal_client_id());

-- RLS is already on for all six (checked against the live database before this was written), but
-- say it anyway: a table with policies and RLS off is a table with no policies at all.
alter table public.outreach_accounts  enable row level security;
alter table public.outreach_campaigns enable row level security;
alter table public.outreach_daily     enable row level security;
alter table public.outreach_inboxes   enable row level security;
alter table public.outreach_threads   enable row level security;
alter table public.outreach_messages  enable row level security;

-- ---------------------------------------------------------------- every fifteen minutes
-- Fifteen minutes, not one: a provider's numbers move in minutes, both providers rate-limit
-- (Instantly allows 20 calls a minute on its email feed, Smartlead 10 a minute on some of its
-- analytics), and a client watching their campaign does not need it to the second. The job is
-- also safe to run twice, so a missed tick simply catches up on the next one.
--
-- Minute 7 of the quarter hour so it never lands on the same second as the hourly jobs.
do $$
declare
  v_auth text;
  v_cmd  text;
  v_job  bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'outreach-sync not scheduled: pg_cron is not installed. Schedule it by hand.';
    return;
  end if;

  -- the gateway key, taken from the job that already carries it. Never written in this repo,
  -- and never put in a NOTICE, an exception or a result: the only places it goes are v_auth and
  -- the new job's own command, which is where the existing job already keeps it.
  --
  -- ROUND 3: the key must be the WHOLE of what sits between `Bearer ` and the closing quote.
  -- The pattern used to stop at the first character it did not know, so a key holding a `+`,
  -- a `/` or an `=` was cut short, the job was scheduled with the stump, said "scheduled", and
  -- then failed with a 401 every fifteen minutes with nobody told. (Tried on a local copy with
  -- a made-up key.) The `(?=[''"])` insists the next character is the closing quote; a key it
  -- cannot read whole is not used at all.
  if not exists (select 1 from cron.job j where j.jobname = 'aviance-mail-tick') then
    raise notice 'outreach-sync not scheduled: there is no aviance-mail-tick job to take the gateway key from. Schedule it by hand in the dashboard.';
    return;
  end if;

  select (regexp_match(j.command, 'Bearer\s+([A-Za-z0-9._\-]+)(?=[''"])'))[1]
    into v_auth
    from cron.job j
   where j.jobname = 'aviance-mail-tick'
   limit 1;

  if v_auth is null then
    raise notice 'outreach-sync not scheduled: the aviance-mail-tick job is there, but its gateway key could not be read whole out of its command. Schedule it by hand in the dashboard.';
    return;
  end if;

  v_cmd := format($q$
  select net.http_post(
    url     := 'https://zjbxnkpktbghhudjbxhk.supabase.co/functions/v1/outreach-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer %s',
      'x-aviance-secret', public.aviance_webhook_secret()
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $q$, v_auth);

  select jobid into v_job from cron.job where jobname = 'aviance-outreach-sync';
  if v_job is null then
    perform cron.schedule('aviance-outreach-sync', '7,22,37,52 * * * *', v_cmd);
    raise notice 'outreach-sync scheduled every 15 minutes.';
  else
    perform cron.alter_job(v_job, schedule := '7,22,37,52 * * * *', command := v_cmd, active := true);
    raise notice 'outreach-sync schedule refreshed.';
  end if;
end $$;
