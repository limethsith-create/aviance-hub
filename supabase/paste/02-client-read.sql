-- ───────────────────────────────────────────────────────────────────────────
--  PART 4 — the portal's Campaign tab
--  Three tables a signed-in CLIENT may read, and only their own rows.
--  Deliberately NOT readable by a client: outreach_accounts (key_ref, our own
--  error wording), outreach_inboxes (the domains we send from), and
--  outreach_messages (the full body of our copy).
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.portal_client_id()
returns uuid language sql stable security definer set search_path = public as $$
  select cp.client_id from public.client_people cp where cp.user_id = auth.uid() limit 1
$$;

comment on function public.portal_client_id() is
  'The client a signed-in portal user belongs to, or null. Used by the outreach_* client policies.';

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

alter table public.outreach_accounts  enable row level security;
alter table public.outreach_campaigns enable row level security;
alter table public.outreach_daily     enable row level security;
alter table public.outreach_inboxes   enable row level security;
alter table public.outreach_threads   enable row level security;
alter table public.outreach_messages  enable row level security;
