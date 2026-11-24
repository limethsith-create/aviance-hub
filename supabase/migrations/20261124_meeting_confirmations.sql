-- A meeting booked in Aviance OS with a guest (a client's kickoff from their portal, or one the owner
-- adds by hand) now gets the same confirmation email as a website booking: mail-tick makes the
-- Google Meet for it, puts the link in the email and saves it on the meeting. Reminders already
-- follow from queue_due_reminders.
create or replace function public.queue_meeting_confirmation() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status = 'booked' and new.starts_at > now()
     and coalesce(btrim(new.guest_email),'') ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    perform public.queue_call_mail('booking_confirmation', new.guest_email, new.guest_name, new.starts_at,
                                   coalesce(new.time_zone, 'America/New_York'), null, new.id, new.client_id);
  end if;
  return new;
end $$;
revoke execute on function public.queue_meeting_confirmation() from public, anon, authenticated;
drop trigger if exists meetings_confirm on public.meetings;
create trigger meetings_confirm after insert on public.meetings for each row execute function public.queue_meeting_confirmation();
