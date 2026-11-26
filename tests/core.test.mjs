/* core.js — the shared helpers, and the promise that every file still uses them.
 *
 * Two jobs here.
 *
 * 1. PIN THE BEHAVIOUR. The helpers in core.js were fifteen, twelve and six
 *    copies of themselves before this file existed, and some of them had drifted.
 *    Merging copies is only safe if the merged one answers exactly what the
 *    screens were already showing, so every answer that matters is written down
 *    below — especially the day keys. This system books calls across time zones
 *    and settles its guarantee on month boundaries: a day key that moves by one
 *    is a refund paid or not paid.
 *
 * 2. PIN THE ALIASES. Each file keeps its own name for a helper (fnOk, cbEsc,
 *    mtWrap) and each of those is `=== ` the one in core.js. That is asserted
 *    here by identity, not by behaviour, so that nobody can quietly fork a copy
 *    back out again: the moment someone writes a second body, this file fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(import.meta.dirname, '..');
/* a result built inside the vm carries that realm's Object prototype, so copy it
   into this one before a strict comparison */
const plain = (o) => ({ ...o });
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/* core.js on its own, in a bare context: it may read no hub global. */
function core() {
  const ctx = vm.createContext({ console });
  vm.runInContext(read('core.js'), ctx, { filename: 'core.js' });
  return (n) => vm.runInContext(n, ctx);
}

/* core.js plus one or more hub files, with the few globals they touch as they load. */
function load(files, extra) {
  const el = () => ({ id: '', value: '', innerHTML: '', textContent: '', style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle: () => false },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {},
    querySelectorAll: () => [], closest: () => null });
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URLSearchParams, Intl,
    document: { body: el(), documentElement: el(), getElementById: () => el(),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: el },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {}, location: { hash: '', origin: 'https://aviance.store', pathname: '/', search: '' },
    history: { replaceState() {} }, addEventListener() {}, fetch: async () => { throw new Error('no network in a test'); },
    authUser: null, currentView: 'home', I: {},
    sb: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
      rpc: async () => ({ data: null, error: null }),
      auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }) } },
    supabase: { createClient() { return this; } },
  };
  ctx.window = ctx;
  Object.assign(ctx, extra || {});
  vm.createContext(ctx);
  vm.runInContext(read('core.js'), ctx, { filename: 'core.js' });
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return (n) => vm.runInContext(n, ctx);
}

/* ═════════════════ 1. the result shape ═════════════════ */

test('coreOk, coreErr and coreWrap are the {ok,data,error} contract, and never throw', () => {
  const C = core();
  assert.deepEqual(plain(C('coreOk')([1, 2])), { ok: true, data: [1, 2], error: '' });
  assert.deepEqual(plain(C('coreOk')(null)), { ok: true, data: null, error: '' });

  /* the readable sentence is found wherever a failure chose to put it. These
     fixtures are all plain words on purpose: WHERE the message was found is what
     is being pinned here, and corePlain (below) is what decides whether a given
     message may be shown. 'permission denied' used to be one of them and is not
     any more — it is Postgres's wording, so it now comes back as the sentence a
     person can act on; that is the whole point of this pass. */
  assert.equal(C('coreErr')(new Error('Nope')).error, 'Nope');
  assert.equal(C('coreErr')({ message: 'Only the owner can do that.' }).error, 'Only the owner can do that.');
  assert.equal(C('coreErr')({ error_description: 'That month is closed.' }).error, 'That month is closed.');
  assert.equal(C('coreErr')({ msg: 'hm' }).error, 'hm');
  assert.equal(C('coreErr')('plain words').error, 'plain words');
  /* nothing at all still reads as a sentence, never as 'undefined' */
  assert.equal(C('coreErr')(null).error, 'Something went wrong.');
  assert.equal(C('coreErr')(undefined).error, 'Something went wrong.');
  for (const e of [null, undefined, 0, '', {}, [], new Error('x')]) {
    const r = plain(C('coreErr')(e));
    assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0, 'a failure always says something');
  }
});

test('coreWrap: no answer, an error, nothing found, and something found', () => {
  const C = core();
  const W = C('coreWrap');
  assert.deepEqual(plain(W(null, [])), { ok: false, data: null, error: 'No answer from the database.' });
  assert.deepEqual(plain(W(undefined, [])), { ok: false, data: null, error: 'No answer from the database.' });
  assert.deepEqual(plain(W({ error: { message: 'boom' } }, [])), { ok: false, data: null, error: 'boom' });
  /* a query that found nothing hands back whatever the caller said stands in for nothing,
     so a screen gets [] or null and never undefined */
  assert.deepEqual(plain(W({ data: null, error: null }, [])), { ok: true, data: [], error: '' });
  assert.deepEqual(plain(W({ data: undefined, error: null }, 'none')), { ok: true, data: 'none', error: '' });
  assert.deepEqual(plain(W({ data: [], error: null }, 'none')), { ok: true, data: [], error: '' }, 'an empty list IS an answer');
  assert.deepEqual(plain(W({ data: 0, error: null }, 'none')), { ok: true, data: 0, error: '' }, 'zero IS an answer');
  assert.deepEqual(plain(W({ data: [{ id: 1 }], error: null }, [])), { ok: true, data: [{ id: 1 }], error: '' });

  /* a file that rewords database messages for the person reading them keeps doing so */
  const mine = (e) => ({ ok: false, data: null, error: 'MINE: ' + C('coreErrText')(e) });
  assert.equal(W(null, [], mine, 'Nothing came back.').error, 'MINE: Nothing came back.');
  assert.equal(W({ error: 'denied' }, [], mine).error, 'MINE: denied');
});

/* ═════════════════ 1b. what a failure is allowed to say ═════════════════
   Twelve screens used to hand the owner whatever Postgres said. corePlain is the
   one place that decides what he may be shown, and coreErrText routes every
   file's xxErr through it, so these are the sentences on twelve screens. */

test('corePlain: the machine room never reaches the owner, and our own words always do', () => {
  const C = core();
  const P = C('corePlain');
  const OFFLINE = C('CORE_OFFLINE'), OUT = C('CORE_SIGNED_OUT'), NO = C('CORE_NO_ACCESS'),
        NOTREADY = C('CORE_NOT_READY'), ALREADY = C('CORE_ALREADY'), WAIT = C('CORE_WAIT');

  /* the connection */
  assert.equal(P('TypeError: Failed to fetch'), OFFLINE);
  assert.equal(P('NetworkError when attempting to fetch resource.'), OFFLINE);
  assert.equal(P('socket hung up'), OFFLINE);
  assert.equal(P('Load failed'), OFFLINE);
  assert.equal(P('connection refused'), OFFLINE);
  assert.equal(P('Failed to send a request to the Edge Function'), OFFLINE);
  assert.equal(P('canceling statement due to statement timeout'), OFFLINE);

  /* the login */
  assert.equal(P('JWT expired'), OUT);
  assert.equal(P('anything at all', 'PGRST301'), OUT);
  assert.equal(P('Token has expired or is invalid'), OUT);

  /* a rule said no */
  assert.equal(P('permission denied for table biz_settings'), NO);
  assert.equal(P('new row violates row-level security policy for table "client_journey"'), NO);

  /* a database that has not had its update applied yet */
  assert.equal(P('Could not find the function public.biz_get in the schema cache'), NOTREADY);
  assert.equal(P('relation "channels" does not exist'), NOTREADY);
  assert.equal(P('x', '42883'), NOTREADY);

  /* something that was there before this tried to add it */
  assert.equal(P('duplicate key value violates unique constraint "meetings_starts_at_live_key"'), ALREADY);

  /* the machine room: a code, a name, a stack, a bare status, a shape that was
     never a message. None of these tells a person anything they can act on, and
     each of them is how a table name or a SQL fragment reaches a screen. */
  for (const raw of ['[object Object]', 'undefined', 'null', '', '   ', 'Error', '{}',
    '404', ' 500 ', 'PGRST116', '23505', 'invalid input syntax for type uuid: "x"',
    'null value in column "client_id" violates not-null constraint',
    'syntax error at or near "select"',
    'Error: boom\n    at prThreads (prospects.js:187:11)',
    'pg_catalog.pg_class', 'x'.repeat(401),
    /* PostgREST and Postgres wording that reads like a sentence but is not one
       of ours, and tells the owner nothing he can do */
    'JSON object requested, multiple (or no) rows returned',
    'Results contain 0 rows, application/vnd.pgrst.object+json requires 1 row',
    'Invalid API key', 'The resource was not found',
    'value too long for type character varying(120)']) {
    assert.equal(P(raw), WAIT, JSON.stringify(raw));
  }
  /* and nothing that came out of it reads like the machine room either */
  for (const said of [OFFLINE, OUT, NO, NOTREADY, ALREADY, WAIT]) {
    assert.match(said, /^[A-Z].*[.!]$/s, said);
    assert.doesNotMatch(said, /\b(relation|constraint|jwt|PGRST|pg_|null|undefined|select)\b/i, said);
    assert.ok(said.length <= 180, said);
  }

  /* OUR OWN WORDS, through untouched. P0001 is a plpgsql `raise exception`,
     written for a person on purpose: the seat limit, the locked month, the
     retired plan. These are the most useful sentences in the system. */
  const seat = 'Stone Roofing is on Starter, which comes with 2 portal logins, and they are all taken. '
    + 'Free one under "Who can sign in" on their page, or move them to a bigger plan, then send this invite again.';
  assert.equal(P(seat, 'P0001'), seat);
  assert.equal(P('That month is locked, so the number did not move.', 'P0001'), 'That month is locked, so the number did not move.');
  assert.equal(P('Only the owner can open a month.', 'P0001'), 'Only the owner can open a month.');
  /* a refusal of ours that carries Postgres's own permission code, not P0001:
     still our sentence, because the kind is read off the WORDS and not the code */
  assert.equal(P("You have not been given this client's prospects.", '42501'),
    "You have not been given this client's prospects.");
  /* and a plain sentence with no code at all */
  for (const ours of ['Pick one of the times.', 'Write something first.', 'Type your full name to sign.',
    'That client has no email address to send the pack to.', 'No answer from the database.']) {
    assert.equal(P(ours), ours, ours);
  }
  /* "Write something first." is five letters then a word: a careless
     five-character code test would have eaten it */
  assert.equal(P('Those times are not available any more.'), 'Those times are not available any more.');
});

test('coreFamily names the kind, off the raw words or off the sentence corePlain made', () => {
  const C = core();
  const F = C('coreFamily'), P = C('corePlain');
  /* three screens have a better sentence of their own for one kind, and they ask
     this after the message has already been put into plain words — so it has to
     answer the same for both. */
  for (const [raw, kind] of [['Failed to fetch', 'offline'], ['JWT expired', 'signed-out'],
    ['permission denied for table x', 'no-access'],
    ['Could not find the function public.f in the schema cache', 'not-ready'],
    ['duplicate key value violates unique constraint "x"', 'already'],
    ['[object Object]', 'wait'], ['Pick one of the times.', 'said']]) {
    assert.equal(F(raw), kind, raw);
    assert.equal(F(P(raw)), kind, 'and again, after plaining: ' + raw);
  }
  assert.equal(F('Your kickoff is already booked.', 'P0001'), 'said');
});

test('coreErrText finds the message, then says it in plain words; coreRawText does not', () => {
  const C = core();
  const raw = { code: '42P01', message: 'relation "prospect_grants" does not exist' };
  assert.equal(C('coreRawText')(raw), 'relation "prospect_grants" does not exist', 'raw is for the files that reword it themselves');
  assert.equal(C('coreErrText')(raw), C('CORE_NOT_READY'));
  /* the code travels with the message, so a plpgsql message is recognised as ours */
  assert.equal(C('coreErr')({ code: 'P0001', message: 'That draft was already sent.' }).error, 'That draft was already sent.');
  /* a failure always says something, whatever arrived */
  for (const e of [null, undefined, 0, '', {}, [], new Error('x'), new Error('[object Object]')]) {
    const r = C('coreErr')(e);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.trim().length > 0, 'a failure always says something');
  }
});

/* ═════════════════ 2. the one escape ═════════════════ */

test('coreEsc protects all five characters, the single quote among them', () => {
  const C = core();
  const esc = C('coreEsc');
  assert.equal(esc('&'), '&amp;');
  assert.equal(esc('<'), '&lt;');
  assert.equal(esc('>'), '&gt;');
  assert.equal(esc('"'), '&quot;');
  assert.equal(esc("'"), '&#39;', "the single quote is protected — this is the whole point of one escaper");
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
  /* the ampersand goes first, or every other entity would be escaped twice */
  assert.equal(esc('&lt;'), '&amp;lt;');
  assert.equal(esc('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(esc("' onmouseover='alert(1)"), '&#39; onmouseover=&#39;alert(1)');
  /* nothing escapable comes back untouched, character for character */
  assert.equal(esc('Brightline Plumbing — 12 people'), 'Brightline Plumbing — 12 people');
});

test('coreAttr makes a value safe inside onclick="…" as a JavaScript string', () => {
  const C = core();
  const attr = C('coreAttr');
  assert.equal(attr('c1'), '&quot;c1&quot;');
  assert.equal(attr(null), '&quot;&quot;');
  /* a quote inside the value cannot end the JavaScript string, nor the attribute */
  assert.equal(attr('a"b'), '&quot;a\\&quot;b&quot;');
  assert.equal(attr("O'Brien"), '&quot;O&#39;Brien&quot;');
  assert.ok(!attr('</script><b>').includes('<'), 'nothing in it can close a tag');
  assert.ok(!attr('x"onerror="y').includes('"'), 'nothing in it can close the attribute');
});

/* ═════════════════ 3. money ═════════════════ */

test('coreUsd: whole dollars, grouped, and never an impossible figure', () => {
  const C = core();
  const usd = C('coreUsd');
  assert.equal(usd(0), '$0');
  assert.equal(usd(1500), '$1,500');
  assert.equal(usd(1234567), '$1,234,567');
  assert.equal(usd('4994'), '$4,994');
  assert.equal(usd(4994.5), '$4,995', 'rounded, because the owner is never shown cents');
  assert.equal(usd(4994.4), '$4,994');
  /* a negative reads '$-300'. It has never been shown — no screen renders a negative
     figure through this — and that is the wording the owner's screens have always had. */
  assert.equal(usd(-300), '$-300');
  /* a figure we do not have must read as a figure, never as NaN or Infinity */
  assert.equal(usd(null), '$0');
  assert.equal(usd(undefined), '$0');
  assert.equal(usd('not a number'), '$0');
  assert.equal(usd(Infinity), '$0');
  assert.equal(usd(NaN), '$0');
});

/* ═════════════════ 4. days, dates and times ═════════════════
   The careful part. A day key that moves by one day moves a month boundary,
   and the guarantee is settled on month boundaries. */

test('coreToDate: a date-only value is a calendar day and does not slide with the zone', () => {
  const C = core();
  const toDate = C('coreToDate');
  const d = toDate('2026-11-24');
  /* read back in the LOCAL calendar — not UTC. '2026-11-24' means that day, wherever
     the reader is. `new Date('2026-11-24')` would be UTC midnight, which in any zone
     behind UTC is the 23rd, and that is the off-by-one this function exists to stop. */
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 10);
  assert.equal(d.getDate(), 24);
  assert.equal(d.getHours(), 0);

  /* the first and last day of a month survive the round trip, in any zone */
  for (const day of ['2026-01-01', '2026-02-28', '2026-11-30', '2026-12-01', '2026-12-31']) {
    assert.equal(C('coreDayKey')(toDate(day)), day, day + ' must not move');
    assert.equal(C('coreDayKey')(day), day, day + ' must not move');
  }

  /* a Date comes back as itself; a timestamp is a moment and is read as one */
  const now = new Date('2026-11-24T22:30:00Z');
  assert.equal(toDate(now).getTime(), now.getTime());
  assert.equal(toDate('2026-11-24T22:30:00Z').getTime(), now.getTime());

  /* nothing we can read is null, never an Invalid Date that renders as 'NaN' */
  for (const bad of [null, undefined, '', 'not a date', new Date('x'), {}]) {
    assert.equal(toDate(bad), null, String(bad) + ' is not a date');
  }
});

test('coreDayKey: YYYY-MM-DD, zero-padded, in the reader own calendar', () => {
  const C = core();
  const key = C('coreDayKey');
  /* zero-padded, so the keys of one year sort as text in calendar order. An
     unpadded key ('2026-1-2') compares equal to itself but sorts wrong, which is
     how a "latest day" picked by sorting lands on the wrong day. */
  assert.equal(key(new Date(2026, 0, 2)), '2026-01-02');
  assert.equal(key(new Date(2026, 10, 24)), '2026-11-24');
  assert.equal(key(new Date(2026, 11, 31)), '2026-12-31');
  const keys = [new Date(2026, 0, 2), new Date(2026, 10, 24), new Date(2026, 1, 10)].map(key);
  assert.deepEqual([...keys].sort(), ['2026-01-02', '2026-02-10', '2026-11-24'], 'text order is calendar order');
  assert.equal(key(null), '');
  assert.equal(key('nonsense'), '');
});

test('coreTodayKey: today, or the key of a moment handed in', () => {
  const C = core();
  assert.equal(C('coreTodayKey')(new Date(2026, 10, 26)), '2026-11-26');
  assert.equal(C('coreTodayKey')('2026-11-26'), '2026-11-26', 'a day handed in comes back as itself');
  const now = C('coreTodayKey')();
  assert.match(now, /^\d{4}-\d{2}-\d{2}$/, 'no argument means now, and still a real key');
  assert.equal(now, C('coreDayKey')(new Date()));
});

test('coreHm and coreTime: a clock reading, and never NaN', () => {
  const C = core();
  assert.equal(C('coreHm')(new Date(2026, 10, 24, 9, 5)), '09:05');
  assert.equal(C('coreHm')(new Date(2026, 10, 24, 23, 59)), '23:59');
  assert.equal(C('coreHm')(new Date(2026, 10, 24, 0, 0)), '00:00');
  assert.equal(C('coreHm')(null), '');
  assert.equal(C('coreHm')('rubbish'), '');
  assert.match(C('coreTime')(new Date(2026, 10, 24, 14, 5)), /\d/);
  assert.equal(C('coreTime')(null), '');
  assert.equal(C('coreTime')('rubbish'), '');
});

test('coreAgo: how long ago, in words, with the caller own word for do not know', () => {
  const C = core();
  const ago = C('coreAgo');
  const now = Date.parse('2026-11-26T12:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(ago(at(0), '', now), 'just now');
  assert.equal(ago(at(20 * 1000), '', now), 'just now');
  assert.equal(ago(at(45 * 1000), '', now), '1 min ago', 'rounded to the nearer minute, as it always was');
  assert.equal(ago(at(5 * 60000), '', now), '5 min ago');
  assert.equal(ago(at(59 * 60000), '', now), '59 min ago');
  assert.equal(ago(at(60 * 60000), '', now), '1 hour ago');
  assert.equal(ago(at(3 * 3600000), '', now), '3 hours ago');
  assert.equal(ago(at(24 * 3600000), '', now), '1 day ago');
  assert.equal(ago(at(5 * 86400000), '', now), '5 days ago');
  /* a time in the future is not "in -3 minutes": clocks disagree, and the reader
     does not care. It reads as just now. */
  assert.equal(ago(new Date(now + 60000).toISOString(), '', now), 'just now');
  /* and the word for "we have no idea" belongs to the caller: '' in a chat row,
     'never' under a team member's name */
  assert.equal(ago(null, '', now), '');
  assert.equal(ago('', 'never', now), 'never');
  assert.equal(ago('not a date', 'never', now), 'never');
});

/* ═════════════════ 5. nothing here knows about the hub ═════════════════ */

test('core.js is leaf code: it reads no hub global and asks the database nothing', () => {
  const src = read('core.js');
  for (const bad of ['sb.', 'sb,', 'authUser', 'document', 'window', 'localStorage', 'fetch(',
    'currentView', 'render(', 'esc(s)}', 'supabase']) {
    assert.ok(!src.includes(bad), 'core.js must not mention ' + bad);
  }
  /* it loads first on every page, so a context with nothing in it must be enough */
  assert.doesNotThrow(() => core(), 'core.js loads with no globals at all');
});

test('core.js declares nothing with const or let, so a test may load it twice', () => {
  /* every test harness runs source files into a vm context. A `const` at the top of
     a file that is loaded twice into one context is a SyntaxError, and core.js is
     the one file that every other file needs loaded first. */
  const src = read('core.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of src.matchAll(/^(const|let)\s/gm)) {
    assert.fail('core.js declares a top-level ' + m[1] + '; use function or var');
  }
  const ctx = vm.createContext({ console });
  assert.doesNotThrow(() => {
    vm.runInContext(read('core.js'), ctx, { filename: 'core.js (first)' });
    vm.runInContext(read('core.js'), ctx, { filename: 'core.js (again)' });
  }, 'core.js loads twice into one context');
});

test('core.js loads first on every page of the site', () => {
  for (const page of ['index.html', 'portal.html', 'team.html', 'doc.html', 'join.html']) {
    const html = read(page);
    const local = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith('http'));
    assert.equal(local[0], 'core.js', page + ' must load core.js before anything that uses it');
    assert.equal(local.filter((p) => p === 'core.js').length, 1, page + ' loads core.js once');
  }
});

/* ═════════════════ 6. every file's own name points AT core.js ═════════════════
   The point of core.js is one implementation, not one implementation plus
   fourteen that happen to agree today. So each file's alias is checked by
   IDENTITY: `fnOk === coreOk`, not `fnOk(1)` looks like `coreOk(1)`. The moment
   somebody writes a second body under an old name, this fails and says so. */

const ALIASES = [
  /* the result shape */
  [['finance.js'], { fnOk: 'coreOk', fnErr: 'coreErr', fnWrap: 'coreWrap', fnUsd: 'coreUsd' }],
  [['finance.js', 'clientbook.js'], { cbOk: 'coreOk', cbErr: 'coreErr', cbWrap: 'coreWrap',
    cbE: 'coreEsc', cbAttr: 'coreAttr', cbUsd: 'coreUsd' }],
  [['finance.js', 'pipeline.js'], { plOk: 'coreOk', plErr: 'coreErr', plWrap: 'coreWrap',
    plAttr: 'coreAttr', plUsd: 'coreUsd' }],
  [['finance.js', 'pipeline.js', 'meetings.js'], { mtOk: 'coreOk', mtErr: 'coreErr', mtWrap: 'coreWrap' }],
  [['prospects.js'], { prOk: 'coreOk', prErr: 'coreErr', prWrap: 'coreWrap', prX: 'coreEsc' }],
  [['portal.js'], { ptOk: 'coreOk', ptErr: 'coreErr', ptWrap: 'coreWrap', ptEsc: 'coreEsc' }],
  [['finance.js', 'onboarding.js'], { obOk: 'coreOk', obErr: 'coreErr', obWrap: 'coreWrap',
    obEsc: 'coreEsc', obMoney: 'coreUsd' }],
  [['finance.js', 'wrapup.js'], { wuOk: 'coreOk', wuErr: 'coreErr', wuWrap: 'coreWrap',
    wuE: 'coreEsc', wuAttr: 'coreAttr', wuUsd: 'coreUsd' }],
  [['team.js'], { tmOk: 'coreOk', tmErr: 'coreErr', tmWrap: 'coreWrap', tmX: 'coreEsc',
    tmToday: 'coreTodayKey' }],
  [['digest.js'], { dgOk: 'coreOk', dgErr: 'coreErr', dgWrap: 'coreWrap', dgEsc: 'coreEsc' }],
  [['journey.js'], { jyOk: 'coreOk', jyE: 'coreEsc', jyAttr: 'coreAttr', jyToday: 'coreTodayKey' }],
  [['settings.js'], { stOk: 'coreOk' }],
  [['drafts.js'], { drA: 'coreAttr' }],
  [['employees.js'], { empTime: 'coreHm' }],
  [['channels.js'], { chvDate: 'coreToDate', chvDayKey: 'coreDayKey', chvTime: 'coreHm' }],
  /* the client's own pages: they load core.js too, so the escape and the day key
     a client sees are the same one the owner sees */
  [['portal-client.js'], { pcOk: 'coreOk', pcEsc: 'coreEsc', pcToDate: 'coreToDate',
    pcDayKey: 'coreDayKey', pcTime: 'coreTime' }],
  [['portal-client.js', 'portal-tracker.js'], { pctEsc: 'coreEsc', pctKey: 'coreDayKey' }],
  [['portal-client.js', 'portal-steps.js'], { pstOk: 'coreOk' }],
  [['team-page.js'], { tmcOk: 'coreOk', tmcEsc: 'coreEsc', tmcToDate: 'coreToDate',
    tmcDayKey: 'coreDayKey', tmcTime: 'coreTime' }],
];

for (const [files, pairs] of ALIASES) {
  test(`${files[files.length - 1]}: its helpers ARE the ones in core.js`, () => {
    const R = load(files);
    for (const [mine, shared] of Object.entries(pairs)) {
      assert.equal(typeof R(mine), 'function', mine + ' is gone');
      assert.ok(R(`${mine} === ${shared}`),
        `${mine} is no longer ${shared} — a copy has been forked back out. ` +
        `If the two must differ, give the new one its own name and say in a comment why.`);
    }
  });
}

/* The ones that deliberately do NOT point at core.js, with the reason. If one of
   these ever becomes identical to its core counterpart, merge it — but until then
   this test is what stops somebody "tidying" them into one and changing a screen. */
test('the helpers that differ on purpose still differ, and still work', () => {
  /* a client's invoice shows cents and its own currency; the owner's screens show
     whole dollars, because that reads faster */
  const P = load(['portal-client.js']);
  assert.ok(P('pcMoney') !== P('coreUsd'), 'pcMoney is not coreUsd');
  assert.equal(P('pcMoney')(3000, 'USD'), '$3,000.00');
  assert.equal(P('pcMoney')(1200, 'GBP'), '£1,200.00');
  assert.equal(P('coreUsd')(3000), '$3,000');

  /* 'how long ago' on a prospect row is counted in days and months, not minutes:
     a reply three weeks old is news, a reply 40 minutes old is not */
  const R = load(['prospects.js']);
  assert.ok(R('prAgo') !== R('coreAgo'), 'prAgo is not coreAgo');
  const now = Date.parse('2026-11-26T12:00:00Z');
  assert.equal(R('prAgo')('2026-11-26T11:00:00Z', now), 'today');
  assert.equal(R('prAgo')('2026-11-25T11:00:00Z', now), 'yesterday');
  assert.equal(R('prAgo')('2026-10-01T11:00:00Z', now), '2 months ago');

  /* cbAgo answers a NUMBER of days, for arithmetic, not words for a screen */
  const C = load(['finance.js', 'clientbook.js']);
  assert.equal(C('cbAgo')('2026-11-21T12:00:00Z', Date.parse('2026-11-26T12:00:00Z')), 5);

  /* the calendar's day key takes a time zone, because a call booked at 11pm in
     Colombo is a different day to the owner in London, and the month it counts
     toward is the client's */
  const M = load(['finance.js', 'pipeline.js', 'meetings.js']);
  assert.ok(M('mtDayKey') !== M('coreDayKey'), 'mtDayKey is not coreDayKey');
  const at = new Date('2026-11-30T23:30:00Z');
  assert.equal(M('mtDayKey')(at, 'UTC'), '2026-11-30');
  assert.equal(M('mtDayKey')(at, 'Asia/Colombo'), '2026-12-01', 'a month boundary moves with the zone');

  /* the tracker reads the DATE PART of whatever the server sent and does not
     convert it: the campaign's days are the client's days, already worked out */
  const T = load(['portal-client.js', 'portal-tracker.js']);
  assert.ok(T('pctDay') !== T('coreToDate'), 'pctDay is not coreToDate');
  assert.equal(T('pctKey')(T('pctDay')('2026-11-30T23:30:00Z')), '2026-11-30');

  /* a JavaScript string for an onclick, written as a single-quoted literal with
     backslashes rather than as JSON — a different job to coreAttr */
  assert.ok(M('mtJsArg') !== M('coreAttr'));
  assert.equal(M('mtJsArg')("O'Brien"), "'O\\'Brien'");
});

/* ═════════════════ 7. the two things NOT moved into core.js ═════════════════ */

test('a plan code becomes a word in exactly one place, and that place is finance.js', () => {
  /* The survey counted five copies of "turn a plan code into a word". There is one
     implementation — fnPlanWord, next to the list of plans on offer and the guard for
     the withdrawn one — and the other four are thin wrappers over it that differ only
     in what they fall back to for a code finance.js does not know. That belongs in
     finance.js and not in core.js: which plans Aviance sells is not a leaf helper, and
     core.js is loaded by the client's own pages, which must not be told. */
  const C = load(['finance.js', 'clientbook.js']);
  assert.equal(C('fnPlanWord')('growth'), 'Growth');
  assert.equal(C('fnPlanWord')('GROWTH'), 'Growth');
  assert.equal(C('fnPlanWord')('nonsense'), '');
  assert.equal(C('cbPlanWord')('growth'), 'Growth', 'clientbook asks finance');
  assert.equal(C('cbPlanWord')('nonsense'), 'Nonsense', 'and only differs in the fallback');

  const O = load(['finance.js', 'onboarding.js']);
  assert.equal(O('obPlanWord')('scale'), 'Scale');
  const P = load(['finance.js', 'pipeline.js']);
  assert.equal(P('plPlanWord')('starter'), 'Starter');

  /* and nobody keeps their own list of the plans' names */
  for (const f of ['clientbook.js', 'pipeline.js', 'onboarding.js', 'digest.js', 'wrapup.js',
    'journey.js', 'prospects.js', 'team.js', 'settings.js', 'core.js']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/starter\s*:\s*'Starter'|'Starter'\s*,\s*'Growth'/.test(src),
      f + ' keeps its own copy of the plan names; finance.js owns them');
  }
});

test('core.js says nothing about Aviance: a client loads it too', () => {
  /* core.js is served to portal.html, doc.html and join.html, which a client opens.
     It must hold no business fact — not a plan name, not a price, not a stage, not a
     sentence about the guarantee — only leaf helpers. */
  /* Comments may point at the hub to explain why something is the way it is — the note
     beside coreUsd says where the client's own money helper lives, and that is worth
     having. The CODE may not: strip the prose and nothing about the business is left. */
  const code = read('core.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['Starter', 'Growth', 'Scale', 'plan_prices', 'qualified', 'refund',
    'client', 'invoice', 'guarantee', 'Aviance', 'stage', 'plan']) {
    assert.ok(!code.toLowerCase().includes(word.toLowerCase()), 'core.js must not mention ' + word);
  }
  /* and the only names it puts on the page all begin core — nothing of a screen's own */
  for (const m of code.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) {
    assert.match(m[1], /^core/, 'core.js declares ' + m[1] + '; every name here begins "core"');
  }
});
