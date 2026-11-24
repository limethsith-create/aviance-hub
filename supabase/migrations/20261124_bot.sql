-- 20261124_bot.sql — the reply bot (builder C). Apply AFTER 20261124_journey_core.sql (A: msg_kind/meta, bot_drafts,
-- draft_write) and BEFORE D's scheduling file is fine: offer_match is looked up at run time, not at create time.
--
-- When a CLIENT writes a plain chat message:
--   1. if public.offer_match(channel_messages) exists (D) and returns true (the message picked a time and booked it) -> stop;
--   2. else ask the edge function 'bot-draft' to draft a reply (net.http_post, same pattern as trg_booking_research).
-- The function only queues a draft (bot_drafts via draft_write). Nothing reaches the client until the owner sends it.
-- Deploy the function with verify_jwt = false (it checks x-aviance-secret itself).

create or replace function public.trg_channel_bot()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_booked boolean := false;
  v_secret text;
begin
  if new.author_person is null or coalesce(new.msg_kind, 'chat') <> 'chat' or new.deleted_at is not null then
    return new;
  end if;

  -- D's time-pick matcher, if it is there. A failure in it must never block the client's message.
  if to_regprocedure('public.offer_match(public.channel_messages)') is not null then
    begin
      execute 'select public.offer_match($1)' into v_booked using new;
    exception when others then
      raise warning 'offer_match failed for message %: %', new.id, sqlerrm;
      v_booked := false;
    end;
    if coalesce(v_booked, false) then
      return new;
    end if;
  end if;

  v_secret := public.aviance_webhook_secret();
  if v_secret is null then
    return new;   -- no secret in the vault: nothing to call safely
  end if;

  begin
    perform net.http_post(
      url := 'https://zjbxnkpktbghhudjbxhk.supabase.co/functions/v1/bot-draft',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-aviance-secret', v_secret),
      body := jsonb_build_object('message_id', new.id),
      timeout_milliseconds := 5000);
  exception when others then
    raise warning 'bot-draft call failed for message %: %', new.id, sqlerrm;
  end;
  return new;
end $function$;

revoke all on function public.trg_channel_bot() from public, anon, authenticated;

create or replace trigger channel_messages_bot
  after insert on public.channel_messages
  for each row
  when (new.author_person is not null and new.msg_kind = 'chat')
  execute function public.trg_channel_bot();

-- one reply draft per client message (a retried webhook can't queue two)
create unique index if not exists bot_drafts_one_reply_per_message
  on public.bot_drafts (source_message_id) where kind = 'reply' and source_message_id is not null;
