-- 20261208_indexes.sql
--
-- Indexes for the query shapes the hub and the portal actually run, where
-- Postgres had none it could use. Nothing here changes a row, a column or a
-- rule: an index only gives the planner a cheaper way to find what it was
-- already going to find, so these are safe to apply at any time and safe to
-- drop again.
--
-- Every one is `create index if not exists`, so re-running this file does
-- nothing. Each is named for the shape it serves, and each has the screen that
-- runs it written above it.
--
-- HOW THESE WERE PICKED
-- The existing indexes were listed out of pg_indexes and matched against every
-- read the client files make. Most shapes were already covered — clients by
-- stage and owner, meetings by client and by start, qualified_calls by
-- (client_id, booked_for), channel_messages by (channel_id, created_at desc),
-- client_events by (client_id, at desc), outreach_threads by
-- (client_id, status, last_message_at desc), tasks by (status, department,
-- due_on). What is below is what was left: a filter or a sort whose leading
-- column no index starts with, so the planner had to scan the table and sort.
--
-- An honest note on measurement: the live tables are small today (3 clients,
-- 6 meetings, 24 client_events), and at that size Postgres correctly chooses a
-- sequential scan no matter what indexes exist, so `explain analyze` cannot
-- show a difference yet. These are therefore justified by shape, not by a
-- measured speed-up: for each one, no existing index has the filtered or
-- sorted column in its leading position, which is what decides whether an
-- index can be used at all. They cost a little write time and a little disk
-- and they stop these screens turning into table scans as the rows arrive.

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

-- The wrap-up "Ending" screen asks for the clients who have left, newest last
-- day first: `... where ended_on is not null or stage in (...) order by
-- ended_on desc`. Partial, because a client who has not left has no last day
-- and does not belong in this index at all — which keeps it to the handful of
-- rows the screen wants however many live clients there are.
create index if not exists clients_ended_idx
  on public.clients (ended_on desc)
  where ended_on is not null;

-- The money screen lists every client newest first (`order by created_at
-- desc`). clients_stage_idx and clients_owner_idx cannot serve that sort.
create index if not exists clients_created_idx
  on public.clients (created_at desc);

-- ---------------------------------------------------------------------------
-- agreements
-- ---------------------------------------------------------------------------

-- The onboarding checklist finds a client's agreement by the booking it came
-- from (`where booking_id = ...`). The only index on this table was on
-- client_email, which is the fallback lookup, not the first one.
create index if not exists agreements_booking_idx
  on public.agreements (booking_id)
  where booking_id is not null;

-- ---------------------------------------------------------------------------
-- calendar_blocks
-- ---------------------------------------------------------------------------

-- The calendar asks for the blocks overlapping the week it is drawing
-- (`where ends_at > from and starts_at < to order by starts_at`) every time it
-- refreshes, which is once a minute while it is the screen open. This table
-- had nothing but its primary key, so every one of those was a scan and a
-- sort. starts_at carries both the range end and the sort; ends_at carries the
-- other end.
create index if not exists calendar_blocks_starts_idx
  on public.calendar_blocks (starts_at);
create index if not exists calendar_blocks_ends_idx
  on public.calendar_blocks (ends_at);

-- ---------------------------------------------------------------------------
-- discovery_bookings
-- ---------------------------------------------------------------------------

-- The bell asks which website bookings arrived in the last day
-- (`where created_at >= ...`). The only created_at index on this table starts
-- with caller_id, so it cannot serve a query that does not name a caller.
create index if not exists discovery_bookings_created_idx
  on public.discovery_bookings (created_at desc);

-- ---------------------------------------------------------------------------
-- qualified_calls
-- ---------------------------------------------------------------------------

-- The no-shows screen matches calls to meetings by the time they were booked
-- for, across all clients (`where booked_for in (...)`).
-- qualified_calls_client_idx is (client_id, booked_for) — booked_for is not
-- leading, so a query that names no client cannot use it.
create index if not exists qualified_calls_booked_for_idx
  on public.qualified_calls (booked_for);

-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------

-- Both the money screen and the final statement sort invoices by the day they
-- were issued, not the day the row was made. invoices_client_idx is
-- (client_id, created_at desc), which gets the client right and then has to
-- sort anyway.
create index if not exists invoices_issued_idx
  on public.invoices (issued_on desc);
create index if not exists invoices_client_issued_idx
  on public.invoices (client_id, issued_on desc);

-- ---------------------------------------------------------------------------
-- refunds
-- ---------------------------------------------------------------------------

-- A client's refunds, oldest first — refunds_client_idx is client_id alone, so
-- the order had to be sorted out afterwards.
create index if not exists refunds_client_created_idx
  on public.refunds (client_id, created_at);

-- ---------------------------------------------------------------------------
-- client_agreements
-- ---------------------------------------------------------------------------

-- The client book wants each client's newest agreement first.
-- client_agreements_client_idx is client_id alone.
create index if not exists client_agreements_client_created_idx
  on public.client_agreements (client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- client_requests
-- ---------------------------------------------------------------------------

-- The portal screen and the home dashboard both ask for every open request
-- across all clients (`where status in ('open','in_progress') order by
-- created_at`). client_requests_client_idx is (client_id, status), which needs
-- a client named to be any use.
create index if not exists client_requests_status_idx
  on public.client_requests (status, created_at);

-- ---------------------------------------------------------------------------
-- outreach_messages
-- ---------------------------------------------------------------------------

-- The handover pack reads a leaving client's whole conversation history
-- (`where client_id = ... order by sent_at`). The only index covering sent_at
-- starts with thread_id.
create index if not exists outreach_messages_client_sent_idx
  on public.outreach_messages (client_id, sent_at);

-- ---------------------------------------------------------------------------
-- handovers
-- ---------------------------------------------------------------------------

-- The wrap-up screen lists a client's handovers, and separately the ones whose
-- data-deletion day has arrived or is still coming. This table had nothing but
-- its primary key.
create index if not exists handovers_client_idx
  on public.handovers (client_id, created_at desc);
create index if not exists handovers_delete_on_idx
  on public.handovers (data_delete_on)
  where data_delete_on is not null;
