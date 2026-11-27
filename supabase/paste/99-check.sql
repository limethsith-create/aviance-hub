-- One row per part. This is the last statement in the file, so it is what the
-- SQL editor shows you. It reads the catalogue and changes nothing. From
-- cron.job it reads the job name and the schedule only — never the command.
select part, what,
       case when ok then 'done' else 'NOT DONE — ' || fix end as result
from (values
  (1, 'a lost booking gives its slot back',
      exists (select 1 from pg_indexes where schemaname = 'public'
               and indexname = 'discovery_bookings_one_per_slot' and indexdef like '%lost%'),
      'the one-per-slot index still holds lost bookings'),
  (2, 'a recount never moves a locked month',
      exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
               and proname = 'recount_month' and prosrc like '%lm.locked_at is null%'),
      'recount_month is still the old one'),
  (3, 'prospect grants; staff read a client''s prospects only with a grant',
      to_regclass('public.prospect_grants') is not null
      and (select count(*) from pg_policies where schemaname = 'public'
            and tablename like 'outreach\_%' and policyname like '%\_read'
            and policyname not like '%client\_read' and qual like '%can_see_prospects%') = 6
      and not exists (select 1 from pg_policies where schemaname = 'public'
            and tablename like 'outreach\_%' and policyname like '%\_team\_%'),
      'an old read-everything policy is still on an outreach table'),
  (4, 'a client reads their own campaign, daily numbers and replies',
      (select count(*) from pg_policies where schemaname = 'public'
        and policyname in ('outreach_campaigns_client_read', 'outreach_daily_client_read',
                           'outreach_threads_client_read')) = 3
      and not exists (select 1 from pg_policies where schemaname = 'public'
        and policyname in ('outreach_accounts_client_read', 'outreach_inboxes_client_read',
                           'outreach_messages_client_read')),
      'the three client policies are not all there'),
  (5, 'calendar connect: four tables, tokens readable by nobody',
      to_regclass('public.calendar_connections') is not null
      and to_regclass('public.calendar_tokens') is not null
      and to_regclass('public.calendar_oauth_states') is not null
      and to_regclass('public.calendar_busy') is not null
      and not exists (select 1 from pg_policies where schemaname = 'public'
            and tablename in ('calendar_tokens', 'calendar_oauth_states')),
      'a calendar table is missing, or the token table has a policy'),
  (6, 'month-end engine, and the hourly job aviance-month-end at :40',
      to_regclass('public.v_months_to_close') is not null
      and exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'month_end_close')
      and exists (select 1 from cron.job where jobname = 'aviance-month-end' and schedule = '40 * * * *'),
      'the view, the function or the cron job is missing'),
  (7, 'refunds can be marked paid; the client can see theirs',
      exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'refunds' and column_name = 'paid_amount')
      and exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'refund_pay')
      and exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'portal_refunds')
      and to_regclass('public.v_money_back') is not null,
      'refund_pay, portal_refunds or v_money_back is missing'),
  (8, 'the outreach sync job, every 15 minutes',
      exists (select 1 from cron.job where jobname = 'aviance-outreach-sync'),
      'the job was NOT scheduled: the gateway key could not be read out of aviance-mail-tick. Everything else in this part is in. Schedule aviance-outreach-sync by hand (Database → Cron), or tell me'),
  (9, 'the commitment board''s three views',
      to_regclass('public.v_commitment_months') is not null
      and to_regclass('public.v_commitment_now') is not null
      and to_regclass('public.v_commitment_to_close') is not null,
      'a v_commitment view is missing'),
  (10, 'the caller role is gone',
      to_regclass('public.leads') is null and to_regclass('public.call_log') is null
      and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                       and proname in ('is_caller', 'my_caller_id', 'caller_book'))
      and not exists (select 1 from public.staff where kind = 'caller'),
      'a caller table, function or staff row is still there')
) as t(part, what, ok, fix)
order by part;
