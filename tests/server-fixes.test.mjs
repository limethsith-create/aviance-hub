// Server-side fixes (supabase/migrations/20261130_server_fixes.sql and the edge functions).
// SQL and Deno code cannot run under node, so these pin the properties that must not regress,
// by reading the files. The behaviour itself was run against a scratch Postgres (see REVIEW-server.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const sql = read('supabase/migrations/20261130_server_fixes.sql');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const fn = (name) => read('supabase/functions/' + name + '/index.ts');

/** Every `create or replace function` statement in the migration, header + body. */
const functions = [...code.matchAll(/create or replace function\s+public\.(\w+)\s*\(([\s\S]*?)\$\$;/g)]
  .map((m) => ({ name: m[1], text: m[0] }));

test('the migration leaves the six functions another migration owns alone', () => {
  const made = functions.map((f) => f.name);
  for (const theirs of ['close_won', 'agreement_terms', 'mail_pack', 'raise_invoice', 'doc_get_core', 'documents_preview']) {
    assert.ok(!made.includes(theirs), theirs + ' must not be redefined here');
  }
  assert.ok(made.length >= 8, 'expected the functions to be found');
});

test('every function pins its search_path, and definer functions pin it to public', () => {
  for (const f of functions) {
    const head = f.text.slice(0, f.text.indexOf('$$'));
    assert.match(head, /set search_path = public/, f.name + ' has no search_path');
  }
});

test('nothing made here is left open to the public key', () => {
  for (const name of ['queue_due_reminders', 'mail_health']) {   // mail_outbox_kick lives in the held-back file
    assert.match(code, new RegExp('revoke execute on function public\\.' + name + '\\(\\)\\s+from public, anon'), name);
  }
  assert.match(code, /revoke execute on function public\.caller_next_id\(uuid\) from public, anon, authenticated;/);
});

test('the migration can be run twice and carries no key', () => {
  assert.ok(!/create (unique )?index (?!if not exists)/.test(code), 'indexes use if not exists');
  assert.ok(!/add column (?!if not exists)/.test(code), 'columns use if not exists');
  assert.ok(!/create trigger/.test(code.replace(/drop trigger if exists (\w+) on public\.(\w+);\s*create trigger \1/g, '')), 'a trigger is dropped before it is made');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(sql), 'no JWT in the file');
  assert.ok(!/\b(insert into|delete from)\b/i.test(code.replace(/insert into public\.(client_months|refunds)/g, '')), 'no data writes outside function bodies we expect');
});

test('reminders: own 24h marker, a floor on every window, late ones dropped', () => {
  const q = functions.find((f) => f.name === 'queue_due_reminders').text;
  assert.ok(!/day_before_sent_at is null/.test(q), 'must not share the closer brief marker');
  assert.match(q, /reminded_24h_at is null/);
  assert.match(q, /call_at between now\(\) \+ interval '90 seconds' and now\(\) \+ interval '6 minutes'/);
  assert.match(q, /starts_at between now\(\) \+ interval '90 seconds' and now\(\) \+ interval '6 minutes'/);
  assert.ok(!/between now\(\) (-|and)/.test(q), 'no window may start at or before now');
  assert.match(q, /o\.kind = 'reminder_5min' and x\.call_start <= now\(\) \+ interval '1 minute'/);
});

test('bookings: the website path takes the calendar lock and cannot credit a caller', () => {
  const b = functions.find((f) => f.name === 'booking_must_be_free').text;
  assert.match(b, /pg_advisory_xact_lock\(hashtext\('aviance-calendar'\)\)/);
  assert.ok(b.indexOf('pg_advisory_xact_lock') < b.indexOf('free_slots(31)'), 'lock first, then look');
  assert.match(b, /new\.minutes\s+:= v_min/);
  assert.match(b, /new\.caller_id is distinct from public\.my_caller_id\(\)/);
  assert.match(functions.find((f) => f.name === 'free_slots').text, /not public\.us_holiday\(v_day\)/);
});

test('months: contiguous, counted in the US zone, locked once', () => {
  assert.match(functions.find((f) => f.name === 'open_next_month').text, /e := \(c\.day1_on \+ \(n \* interval '1 month'\)\)::date - 1;/);
  assert.match(functions.find((f) => f.name === 'recount_month').text, /\(q\.happened_at at time zone v_zone\)::date between/);
  assert.match(functions.find((f) => f.name === 'lock_month').text, /where id = p_month for update;/);
});

test('mail-tick: time limit on every send, urgent first, no details without the secret', () => {
  const t = fn('mail-tick');
  assert.match(t, /signal: AbortSignal\.timeout\(timeoutMs\)/);
  assert.equal((t.match(/await callScript\(/g) || []).length, 2);
  assert.match(t, /MEETING_TIMEOUT_MS\);/);
  assert.match(t, /MAIL_TIMEOUT_MS\);/);
  assert.match(t, /reminder_5min: 0/);
  assert.match(t, /if \(kind === "reminder_5min"\) return 45_000;/);
  assert.match(t, /json\(tell \? body : \{ ok: body\.ok \}, status\)/);
  assert.match(t, /\.in\("status", \["pending", "failed"\]\)\.select\("id"\)/, 'still claims a row before sending');
});

test('edge functions: no raw database error reaches a browser, link previews make no login', () => {
  assert.ok(!/no\(req, used\.error\.message/.test(fn('portal-accept')));
  assert.match(fn('caller-link'), /if \(req\.method !== "GET"\) return bad\("method"\);/);
  assert.match(fn('caller-link'), /p_code_hash: ""/);
  assert.ok(!/p_code_hash: randomSecret\(\)/.test(fn('caller-link')));
  assert.match(fn('bot-draft'), /rt\.waitUntil\(/);
  assert.match(fn('staff-code'), /me\.data\.role !== "admin" \|\| me\.data\.approved !== true/);
});
