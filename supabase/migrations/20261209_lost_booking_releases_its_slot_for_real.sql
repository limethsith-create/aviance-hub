-- NEEDS THE OWNER. NOT APPLIED. This file changes an index, and this session cannot
-- apply SQL to the live database.
--
-- WHAT IS WRONG
-- 20261127_lost_bookings_release_their_slot.sql taught free_slots() that a booking
-- marked 'lost' no longer holds its half hour, so the time is offered again. The
-- UNIQUE INDEX that actually enforces one booking per slot was not changed with it:
--
--   create unique index discovery_bookings_one_per_slot
--     on public.discovery_bookings (call_at) where (status <> 'cancelled');
--
-- 'lost' is not 'cancelled', so a lost booking still occupies that index entry. The
-- two rules now disagree, and the disagreement falls on a prospect:
--
--   free_slots() offers 2:00 pm   ->  the website shows 2:00 pm
--   the prospect picks 2:00 pm    ->  insert hits the index
--   the index says no             ->  23505, duplicate key value violates unique
--                                     constraint "discovery_bookings_one_per_slot"
--
-- booking_must_be_free() cannot save it: its free_slots() check PASSES, because
-- free_slots() is the half of the pair that was updated. The refusal comes from the
-- index after the trigger, so the message the prospect gets is a raw Postgres
-- duplicate-key line, not a sentence.
--
-- PROVEN ON THE LIVE DATABASE on 2026-11-26, inside a transaction that was rolled
-- back so nothing was kept:
--   slot=2026-12-18 01:30:00+00 | offered_again=true
--   second_booking=REFUSED sqlstate=23505
--     msg=duplicate key value violates unique constraint "discovery_bookings_one_per_slot"
--
-- WHAT IT COSTS
-- Every lead we turn down, disqualify or lose before their call takes one sellable
-- half hour out of the week AND turns it into a booking form that fails with a
-- database error for the next prospect who picks it. The time looks available right
-- up to the last click. That is the worst possible shape for this bug: the prospect
-- has already decided to talk to us when it breaks.
--
-- THE FIX
-- One predicate, so the index excludes exactly what free_slots() excludes. The list
-- now lives in THREE places and they must agree:
--   * free_slots()                     d.status not in ('cancelled','lost')
--   * MT_BOOKING_FREES_TIME            ['cancelled','lost']        (meetings.js)
--   * discovery_bookings_one_per_slot  this index                  (here)
-- tests/slot-rule.test.mjs already fails if the first two drift apart; extend it to
-- this file if you can.
--
-- SAFE TO RUN: it only ever allows MORE rows than before, so no existing row can
-- break it. Run it when nobody is booking; `concurrently` cannot be used inside a
-- transaction, so if you want zero locking, run the two statements one at a time
-- with `concurrently` added and no surrounding BEGIN.

drop index if exists public.discovery_bookings_one_per_slot;

create unique index discovery_bookings_one_per_slot
    on public.discovery_bookings (call_at)
 where (status not in ('cancelled', 'lost'));

comment on index public.discovery_bookings_one_per_slot is
  'One live booking per slot. Cancelled AND lost bookings let the time go, which is exactly what free_slots() offers again — the two must always say the same thing.';
