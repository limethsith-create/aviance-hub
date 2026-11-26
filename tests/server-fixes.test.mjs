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

const confirmFix = read('supabase/migrations/20261204_confirmation_text_step_three.sql');

test('the confirmation email keeps prep step 3 in the plain-text body, not just the HTML', () => {
  const t = confirmFix;
  // it patches body_text, and the two sentences are replaced one at a time, the way the HTML fix did it
  assert.match(t, /body_text = replace\(replace\(replace\(replace\(mo\.body_text,/);
  assert.match(t, /'Think about who your best customers are\.', coalesce\(v_prep,/);
  assert.match(t, /'Know what one new customer is worth to you\.',/);
  // the old collapsing replace, which swallowed step 3, must be gone from the new expression
  assert.doesNotMatch(t, /2\. Think about who your best customers are\./, 'no two-line replace any more');
  // and it must not carry the 'n' flag, which would stop `.` crossing the newlines in the body
  assert.doesNotMatch(t, /\$b\$,\s*'n'\)/);
  assert.match(t, /raise exception 'body_text pattern not found'/, 'it refuses rather than patch nothing');
});

test('the HTML headline is matched against the markup that is really in the email', () => {
  const t = confirmFix;
  // the hero is an &rsquo; entity, a <br> between the words and the full stop in its own red span
  const hero = 'You&rsquo;re<br>booked in<span style="color:#E0290F">.</span>';
  assert.ok(t.includes(hero), 'searches for the real hero markup, not the plain sentence');
  assert.ok(t.includes('Your kickoff<br>is booked<span style="color:#E0290F">.</span>'));
  assert.ok(t.includes('Your onboarding<br>call is booked<span style="color:#E0290F">.</span>'));
  // the red full stop survives in every branch
  const patch = t.slice(t.indexOf('2. the HTML hero headline'), t.indexOf('-- The self-check'));
  assert.equal((patch.match(/<span style="color:#E0290F">\.<\/span>/g) || []).length, 4,
    'the needle and all three branches carry the red full stop');
  // an unmatched replace leaves the old headline rather than mangling the HTML: the else branch
  // is the hero unchanged, so there is no partial rewrite to go wrong
  assert.match(t, /else 'You&rsquo;re<br>booked in<span style="color:#E0290F">\.<\/span>' end\)/);
  assert.match(t, /raise exception 'body_html hero pattern not found'/);
});

test('every sentence the confirmation searches for is one the template really contains', () => {
  // The bug class: a replace() whose search string never appears, which fails silently. The
  // migration carries a self-check that compares each needle against a real queued email and
  // raises if one is missing. These are the needles it must cover.
  const t = confirmFix;
  assert.match(t, /searches for text that is not in the template/, 'the self-check is there');
  const needles = [', 30 minutes.', '&middot; 30 minutes',
    'Think about who your best customers are.', 'Know what one new customer is worth to you.',
    'You&rsquo;re<br>booked in<span style="color:#E0290F">.</span>'];
  // the check block is the second do $$ ... $$ in the file
  const checkBlock = t.slice(t.indexOf('-- The self-check'));
  for (const n of needles) assert.ok(checkBlock.includes(n), 'the self-check covers: ' + n);
  // the one needle known NOT to be in the HTML is deliberately excluded, and said to be
  assert.match(checkBlock, /known NOT to be in the HTML/);
});

test('mail-tick does not claim a trigger that was never applied', () => {
  const t = fn('mail-tick');
  const head = t.slice(0, t.indexOf('\n//\n'));
  assert.doesNotMatch(head, /is poked the moment/);
  assert.match(head, /next cron minute/);
  assert.match(head, /20261202_mail_instant_send_NOT_APPLIED\.sql/);
  assert.match(head, /deliberately NOT/);
  // the held-back migration is still there, still marked
  assert.ok(read('supabase/migrations/20261202_mail_instant_send_NOT_APPLIED.sql').length > 0);
});

/* ───────────── the journey voice migration (20261205) ───────────── */
const voice = read('supabase/migrations/20261205_journey_voice.sql');

test('the journey voice patches the live definitions instead of re-running the old files', () => {
  // the November files have been patched since by later migrations, so re-running them whole
  // would revert those patches — offer_times would lose its holiday skip and notice rule
  assert.match(voice, /pg_get_functiondef\(p_fn::regprocedure\)/);
  assert.match(voice, /execute d;/);
  assert.doesNotMatch(voice, /create or replace function public\./,
    'it must not redefine a public function from scratch');
  // it refuses rather than half-apply, and is safe to run twice
  assert.match(voice, /raise exception 'queued wording not found in %/);
  assert.match(voice, /if position\(p_pairs\[i \+ 1\] in d\) = 0 then/, 'already-applied is not an error');
  assert.match(voice, /SAFE TO RUN TWICE/);
});

test('the journey voice covers every function whose wording changed, and nothing else', () => {
  const fns = [...voice.matchAll(/pg_temp\.voice\('(public\.[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(fns.sort(), [
    'public.approval_reminders()',
    'public.approval_request(uuid,text,text,text)',
    'public.offer_times(uuid,text)',
    'public.precall_request(uuid)',
    'public.sched_when(timestamptz,text)',
    'public.step_message(uuid,text)',
    'public.testing_day(uuid,int,int,text,text)',
    'public.trg_person_welcome()',
  ]);
  // every function gets an even number of array elements: old, new, old, new …
  for (const block of voice.split('pg_temp.voice(').slice(1)) {
    const arr = block.slice(block.indexOf('array['), block.indexOf(']'));
    assert.equal((arr.match(/\$a\$/g) || []).length % 4, 0, 'old/new pairs: ' + arr.slice(0, 60));
  }
});

test('the journey voice proves itself: new wording asserted present, old wording asserted gone', () => {
  const check = voice.slice(voice.indexOf('the migration proves itself'));
  assert.match(check, /raise exception 'the new wording did not land/);
  assert.match(check, /raise exception 'the old txt-speak is still there/);
  // needles are dollar-quoted, because an apostrophe is DOUBLED inside a function body and a
  // plain SQL literal would quietly halve it and never match
  assert.doesNotMatch(check, /\(values[\s\S]{0,400}?'[A-Z][a-z]+ [a-z]/, 'no single-quoted needles');
  assert.ok(check.includes("$c$Thank you for the call. We''re starting on your research now$c$"));
  // "your campaign" contains "ur campaign", so the old-wording needle must be narrower
  assert.ok(check.includes('$c$for ur campaign$c$'));
  assert.ok(!check.includes('$c$ur campaign$c$'), 'that needle would trip on the new wording');
  // the old txt-speak list covers each file's worst offenders
  for (const old of ['thx for the call', 'we launch tmrw', 'ur live', 'did u get a chance',
                     'waste ur time', 'dy mon', 'works for ur ', '(or tap one)']) {
    assert.ok(check.includes('$c$' + old + '$c$'), 'asserts gone: ' + old);
  }
});

test('offer_times is patched against its LIVE body, not the November file', () => {
  // a later migration reflowed the message onto its own lines, so the needle carries newlines
  assert.ok(voice.includes("$a$E'\\n\\njust reply '$a$"), 'the live needle, with the newlines');
  assert.ok(voice.includes("$a$E'\\n\\nJust reply '$a$"));
  assert.ok(!voice.includes("$a$' just reply '$a$"), 'the November-file needle would never match');
  assert.match(voice, /NOTE the live body, not the November file/);
});
