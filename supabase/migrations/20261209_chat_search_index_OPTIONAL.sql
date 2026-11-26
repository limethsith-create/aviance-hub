-- NEEDS THE OWNER. NOT APPLIED. OPTIONAL — nothing is broken today.
--
-- WHAT WAS MEASURED, on the live database, 2026-11-26
-- The Channels search (chSearch, channels-api.js) is one query:
--
--   select ... from channel_messages
--    where body ilike '%roof%' and deleted_at is null
--    order by created_at desc limit 50;
--
-- explain analyze says:
--
--   Seq Scan on channel_messages  (actual time=1.304..1.304 rows=0)
--     Filter: ((deleted_at IS NULL) AND (body ~~* '%roof%'))
--     Rows Removed by Filter: 63
--   Execution Time: 1.408 ms
--
-- A sequential scan of every message in the business. With 63 messages that is
-- 1.4 ms and nobody will ever notice. A leading wildcard cannot use a btree, so
-- the existing channel_messages(channel_id, created_at DESC) index — which does
-- serve the thread, the last-message lookup and the unread count properly — can
-- do nothing for this one.
--
-- WHERE IT STOPS BEING FINE
-- channels.js searches 250 ms after the typing stops, every time it stops. At 50
-- clients with a year of conversation behind each of them (call it 30,000 to
-- 40,000 messages) the same query is a 40,000-row scan with a case-insensitive
-- substring test on every row, a few times per search. It will not fall over; it
-- will get slower every month, and it is the one read in the chat that nothing
-- bounds.
--
-- THE FIX, when it starts to matter
-- A trigram index can serve ILIKE '%x%'. It costs one extension and one index,
-- and the query does not change.
--
-- WHY IT IS NOT URGENT: 63 messages. Apply it when the count is in the tens of
-- thousands, or when search starts to feel slow — not before. Measure first:
--   explain analyze select 1 from channel_messages where body ilike '%something%';
-- and look for the Seq Scan's actual time.
--
-- NOTE ON THE EXTENSION: Supabase puts extensions in the `extensions` schema, and
-- the project already uses extensions.digest and extensions.gen_random_bytes, so
-- that is where this goes too. `create index concurrently` cannot run inside a
-- transaction — run that statement on its own.

create extension if not exists pg_trgm with schema extensions;

create index if not exists channel_messages_body_trgm
    on public.channel_messages using gin (body extensions.gin_trgm_ops);

comment on index public.channel_messages_body_trgm is
  'Serves the Channels search (ILIKE ''%text%''), which has no other index it can use. Added on measurement, not on principle — see the migration file.';
