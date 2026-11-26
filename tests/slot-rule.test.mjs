// Which bookings hold their discovery slot — one rule, written in two places.
//
// The website offers slots from free_slots() in the database. The hub offers slots
// from meetings.js. If those two disagree, a prospect is shown a time the hub will
// then refuse, or the hub hides a time the website is still selling. That happened:
// free_slots() was fixed to release a 'lost' booking's slot and meetings.js kept its
// own list saying only 'cancelled' frees one, so for a while the two answered
// differently on the same half hour.
//
// This file fails if they drift apart again. It is deliberately dumb — it reads the
// SQL and the JavaScript as text and compares the two lists — because the point is to
// break the build when somebody edits one and forgets the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20261127_lost_bookings_release_their_slot.sql', import.meta.url), 'utf8');
const js  = readFileSync(new URL('../meetings.js', import.meta.url), 'utf8');

/** The statuses free_slots() treats as NOT holding a slot. */
function statusesFreedBySql(text) {
  // ... from public.discovery_bookings d where d.status not in ('cancelled', 'lost')
  const m = /discovery_bookings d\s+where d\.status not in \(([^)]*)\)/.exec(text);
  assert.ok(m, 'free_slots must still decide discovery_bookings by a "status not in (...)" list — if that shape changed, update this test deliberately');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
}

/** The statuses meetings.js treats as NOT holding a slot, for bookings. */
function statusesFreedByJs(text) {
  const m = /MT_BOOKING_FREES_TIME\s*=\s*\[([^\]]*)\]/.exec(text);
  assert.ok(m, 'meetings.js must still carry MT_BOOKING_FREES_TIME');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
}

test('the database and the hub free the same booking statuses', () => {
  const fromSql = statusesFreedBySql(sql);
  const fromJs = statusesFreedByJs(js);
  assert.deepEqual(fromJs, fromSql,
    `free_slots() frees [${fromSql}] but meetings.js frees [${fromJs}]. `
    + 'One of them was changed without the other. The website and the hub would now '
    + 'offer different times. Fix both, and SCHEMA.md with them.');
});

test('cancelled and lost free a slot; won, held and no_show do not', () => {
  // Pins the rule itself, so a change has to be argued for rather than slipped in.
  assert.deepEqual(statusesFreedBySql(sql), ['cancelled', 'lost']);
  for (const held of ['won', 'held', 'no_show', 'booked', 'brief_sent']) {
    assert.ok(!statusesFreedBySql(sql).includes(held),
      `${held} must keep holding its slot — that call happened or is going to`);
  }
});

test('meetings rows use their own shorter list, because a meeting has no "lost"', () => {
  const m = /MT_FREES_TIME\s*=\s*\[([^\]]*)\]/.exec(js);
  assert.ok(m, 'meetings.js must still carry MT_FREES_TIME for meetings rows');
  assert.deepEqual([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), ['cancelled']);
});
