-- NOT APPLIED YET. Waiting for the owner's go-ahead.
--
-- What it does: an insert into mail_outbox pokes mail-tick straight away, so a booking confirmation,
-- the agreement email and invites go in a few seconds instead of waiting up to a minute for the cron
-- tick (measured on 2026-11-26: 20-61 seconds). It also makes the cron tick send the webhook secret.
--
-- Why it is held back: the poke re-uses the key stored inside the cron job's command, and the second
-- block rewrites that command with a regular expression. Neither could be inspected or tested from the
-- session that wrote this (reading the command was refused, correctly, because it holds a key). A bad
-- rewrite of the cron command would stop ALL mail. Apply it with the cron command in front of you:
--   1. run the first two statements (function + trigger); insert a test row; confirm it sends in seconds
--   2. only then run the DO block, and check `select command from cron.job where jobname = 'aviance-mail-tick'`
-- The trigger never blocks an insert: any failure is a warning and the cron tick still sends the mail.

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. NO WAITING FOR THE NEXT MINUTE
-- ─────────────────────────────────────────────────────────────────────────────
-- Mail used to wait for the next cron tick: up to 60 seconds (measured: 51s median for a booking
-- confirmation). Now an insert into mail_outbox pokes mail-tick straight away; pg_net sends the
-- request after the transaction commits, so the row is there when the tick looks. The cron tick
-- stays as the safety net and for reminders. Reminders do not poke: they are queued by a tick
-- that sends them itself.
-- mail-tick has verify_jwt on, so the poke re-uses the key the cron job already carries rather
-- than writing a key into this file.
create or replace function public.mail_outbox_kick()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_key text; v_secret text; v_headers jsonb;
begin
  if not exists (select 1 from fresh f
                  where f.status = 'pending' and f.send_after <= now() + interval '5 seconds'
                    and f.kind not like 'reminder\_%') then
    return null;
  end if;
  begin
    select (regexp_match(j.command, 'Bearer ([A-Za-z0-9._-]+)'))[1] into v_key
      from cron.job j where j.jobname = 'aviance-mail-tick' limit 1;
    if v_key is null then return null; end if;          -- the next cron tick will send it
    v_secret  := public.aviance_webhook_secret();
    v_headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key);
    if v_secret is not null then v_headers := v_headers || jsonb_build_object('x-aviance-secret', v_secret); end if;
    perform net.http_post(
      url := 'https://zjbxnkpktbghhudjbxhk.supabase.co/functions/v1/mail-tick',
      headers := v_headers, body := '{}'::jsonb, timeout_milliseconds := 25000);
  exception when others then
    raise warning 'mail-tick poke failed: %', sqlerrm;  -- never block the insert; cron picks it up
  end;
  return null;
end $$;

drop trigger if exists mail_outbox_kick on public.mail_outbox;
create trigger mail_outbox_kick after insert on public.mail_outbox
  referencing new table as fresh for each statement execute function public.mail_outbox_kick();

-- The cron tick now proves who it is (the same secret the other two jobs send). mail-tick answers
-- anyone holding the public key, but only tells a caller with the secret what it did.
do $$
declare j record;
begin
  select jobid, command into j from cron.job where jobname = 'aviance-mail-tick';
  if found and j.command not like '%x-aviance-secret%' then
    perform cron.alter_job(
      job_id  := j.jobid,
      command := regexp_replace(j.command,
                   $r$'Content-Type',\s*'application/json',$r$,
                   $r$'Content-Type', 'application/json', 'x-aviance-secret', public.aviance_webhook_secret(),$r$));
  end if;
end $$;


revoke execute on function public.mail_outbox_kick() from public, anon, authenticated;
