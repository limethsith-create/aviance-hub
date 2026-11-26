-- APPLIED to production on 2026-11-26.
-- Launch must start the guarantee clock.
-- Marking Launch done on the Onboarding board set clients.day1_on and stage 'live' but never
-- opened month one, so a client launched from the board had no month, no call count and no
-- guarantee verdict, and their first invoice was never tied to a month. Only the older checklist
-- screen opened it, from the browser. The database now does it itself, whichever screen set the day:
-- the moment day1_on is first filled in, month one is opened and the first invoice is tied to it.
create or replace function public.client_first_month()
returns trigger language plpgsql security definer set search_path = public as $$
declare m public.client_months;
begin
  if new.day1_on is not null and old.day1_on is null
     and not exists (select 1 from public.client_months where client_id = new.id) then
    m := public.open_next_month(new.id);
    if m.id is not null then
      perform public.raise_invoice(m.id, 7);   -- month one: ties the invoice sent with the agreement
    end if;
  end if;
  return null;
end $$;

create or replace trigger clients_first_month
  after update of day1_on on public.clients
  for each row execute function public.client_first_month();

revoke execute on function public.client_first_month() from public, anon, authenticated;
