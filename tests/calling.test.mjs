/* Tests for calling.js — the cold calling desk and the do-not-call list.
   A fake `sb` stands in for Supabase (a query builder, as in channels-api.test.mjs),
   and a tiny fake DOM stands in for the shell's helpers. No network, no clock of its own:
   every test passes its own `now`.
   Run with:  node --test tests/calling.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;

/* ───────────── the shell's helpers (index.html) ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, value: '', innerHTML: '', textContent: '', style: {}, disabled: false,
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, focus() {}, closest: () => null };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.document = { body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
globalThis.val = (id) => (elements[id] ? String(elements[id].value).trim() : '');
globalThis.errEl = (id, msg) => { el(id).textContent = msg; return false; };
globalThis.emptyState = (icon, title, sub) => `<div class="card"><div class="empty"><h3>${title}</h3><p>${sub}</p></div></div>`;
const toasts = [];
globalThis.toast = (m) => { toasts.push(m); };
globalThis.I = { phone: '<svg/>', check: '<svg/>' };
globalThis.render = () => {};
globalThis.authUser = { uid: 'u1', name: 'Caller', role: 'admin' };

/* ───────────── fake Supabase ───────────── */
let calls, tables;
function resetSb() {
  calls = [];
  tables = {};
}
function builder(table) {
  const call = { table, op: 'select', filters: [], order: null, limit: null, payload: null, single: false };
  calls.push(call);
  const b = {
    select() { return b; },
    insert(p) { call.op = 'insert'; call.payload = p; return b; },
    update(p) { call.op = 'update'; call.payload = p; return b; },
    eq(k, v) { call.filters.push(['eq', k, v]); return b; },
    in(k, v) { call.filters.push(['in', k, v]); return b; },
    gte(k, v) { call.filters.push(['gte', k, v]); return b; },
    lt(k, v) { call.filters.push(['lt', k, v]); return b; },
    order(k, o) { call.order = [k, o]; return b; },
    limit(n) { call.limit = n; return b; },
    single() { call.single = true; return b; },
    maybeSingle() { call.single = true; return b; },
    then(res, rej) {
      const h = tables[table + '.' + call.op];
      let out = typeof h === 'function' ? h(call) : (h || { data: [], error: null });
      if (call.single && out && Array.isArray(out.data)) out = { data: out.data.length ? out.data[0] : null, error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}
globalThis.sb = { from: builder, rpc: async () => ({ data: null, error: null }) };
resetSb();
vm.runInThisContext(fs.readFileSync(path.join(root, 'calling.js'), 'utf8'), { filename: 'calling.js' });
beforeEach(() => { resetSb(); clForget(); toasts.length = 0; });

/* ───────────── fixtures ───────────── */
const NY_NIGHT = '2026-11-22T08:00:00Z';   // 3:00 AM in New York — outside 8am-9pm
const NY_NOON  = '2026-11-22T17:00:00Z';   // 12:00 PM in New York — fine to call
const target = (o = {}) => ({ id: 't1', company: 'Acme Roofing', person_name: 'Dana Smith', job_title: 'Owner',
  phone: '+1 512 555 0100', email: 'dana@acme.com', website: 'acme.com', country: 'US',
  timezone: 'America/New_York', status: 'new', attempts: 2, last_called_at: null, next_call_at: null, notes: '' , ...o });
const shape = (r) => { assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']); return r; };
const log = (outcome, extra = {}) => ({ outcome, called_at: NY_NOON, duration_seconds: 30, ...extra });
const visible = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');

/* ═════════ clNext: calling hours are the law ═════════ */

test('clNext will not hand over a target whose local time is outside 8am-9pm, and says when the window opens', async () => {
  tables['call_targets.select'] = () => ({ data: [target()], error: null });
  const r = shape(await clNext({ now: NY_NIGHT }));
  assert.equal(r.ok, true);
  assert.equal(r.data.target, null, 'nobody is handed over at 3am their time');
  assert.equal(r.data.opensInMinutes, 5 * 60, '3am to 8am is five hours');
  assert.equal(r.data.opensAt, '2026-11-22T13:00:00.000Z');
  assert.match(r.data.words, /8am-9pm in their own time zone/);
  assert.match(r.data.words, /in 5 hours/);
  assert.match(r.data.words, /8:00 AM their time/);
  assert.match(r.data.words, /Acme Roofing/);
});

test('clNext hands over the same target once it is inside the window, with their local time', async () => {
  tables['call_targets.select'] = () => ({ data: [target()], error: null });
  const r = await clNext({ now: NY_NOON });
  assert.equal(r.data.target.id, 't1');
  assert.equal(r.data.localTime, '12:00 PM');
  assert.equal(r.data.zone, 'America/New_York');
  assert.equal(r.data.zoneFrom, 'their time zone');
});

test('clNext falls back to the country when there is no time zone, and to our default when there is neither', async () => {
  tables['call_targets.select'] = () => ({ data: [target({ timezone: null, country: 'United Kingdom' })], error: null });
  const uk = await clNext({ now: NY_NOON });           // 17:00 UTC = 5pm London: callable
  assert.equal(uk.data.zone, 'Europe/London');
  assert.equal(uk.data.zoneFrom, 'their country');
  tables['call_targets.select'] = () => ({ data: [target({ timezone: null, country: null })], error: null });
  const none = await clNext({ now: NY_NOON });
  assert.equal(none.data.zone, 'America/New_York');
  assert.equal(none.data.zoneFrom, 'our default');
});

test('clNext skips a target that is outside its window for one that is inside, soonest next_call_at first', async () => {
  const asleep = target({ id: 'sleepy', company: 'Night Co', timezone: 'Asia/Tokyo', next_call_at: '2026-11-01T00:00:00Z' });
  const awake = target({ id: 'awake', company: 'Day Co', next_call_at: '2026-11-02T00:00:00Z' });
  tables['call_targets.select'] = () => ({ data: [asleep, awake], error: null });
  const r = await clNext({ now: NY_NOON });            // 2am in Tokyo, noon in New York
  assert.equal(r.data.target.id, 'awake');
  assert.equal(r.data.waiting, 1);
  const q = calls[0];
  assert.deepEqual(q.filters[0], ['in', 'status', ['new', 'queued', 'callback']]);
  assert.deepEqual(q.order, ['next_call_at', { ascending: true, nullsFirst: true }]);
});

test('clNext holds back a callback whose time has not come, and says so when nothing is due', async () => {
  tables['call_targets.select'] = () => ({ data: [target({ status: 'callback', next_call_at: '2026-12-01T15:00:00Z' })], error: null });
  const r = await clNext({ now: NY_NOON });
  assert.equal(r.data.target, null);
  assert.match(r.data.words, /Nothing is due/);
});

test('clNext with an empty list says so plainly', async () => {
  const r = await clNext({ now: NY_NOON });
  assert.equal(r.ok, true); assert.equal(r.data.target, null);
  assert.match(r.data.words, /Nothing is due to be dialled right now/);
});

test('clNext passes a database error up as plain words', async () => {
  tables['call_targets.select'] = () => ({ data: null, error: { message: 'the database is away' } });
  const r = await clNext({ now: NY_NOON });
  assert.equal(r.ok, false); assert.equal(r.data, null); assert.equal(r.error, 'the database is away');
});

/* ═════════ clLog: one rhythm table, one place ═════════ */

function logSetup(row = target()) {
  tables['call_targets.select'] = () => ({ data: [row], error: null });
  tables['call_log.insert'] = (c) => ({ data: [{ id: 'log1', ...c.payload }], error: null });
  tables['call_targets.update'] = (c) => ({ data: [{ ...row, ...c.payload }], error: null });
  tables['dnc.insert'] = (c) => ({ data: [{ id: 'd1', ...c.payload }], error: null });
}
const HOUR = 3600000;

test('every outcome sets the status and the next_call_at the rhythm table says', async () => {
  const cases = [
    ['no_answer', 'queued', 4],
    ['voicemail', 'queued', 72],
    ['gatekeeper', 'queued', 24],
    ['conversation', 'queued', 168],
    ['booked', 'booked', null],
    ['not_interested', 'not_interested', null],
    ['bad_number', 'bad_number', null],
  ];
  for (const [outcome, status, hours] of cases) {
    resetSb(); logSetup();
    const r = shape(await clLog('t1', { outcome, now: NY_NOON, notes: 'said hello', durationSeconds: 45 }));
    assert.equal(r.ok, true, outcome + ': ' + r.error);
    assert.equal(r.data.status, status, outcome + ' status');
    const up = calls.find((c) => c.table === 'call_targets' && c.op === 'update');
    assert.equal(up.payload.status, status);
    assert.equal(up.payload.attempts, 3, 'one more attempt than the 2 it had');
    assert.equal(up.payload.last_called_at, new Date(NY_NOON).toISOString());
    if (hours == null) {
      assert.equal(up.payload.next_call_at, null, outcome + ' stops');
      assert.equal(r.data.nextCallAt, null);
    } else {
      assert.equal(up.payload.next_call_at, new Date(Date.parse(NY_NOON) + hours * HOUR).toISOString(), outcome + ' waits ' + hours + 'h');
    }
    const ins = calls.find((c) => c.table === 'call_log' && c.op === 'insert');
    assert.equal(ins.payload.outcome, outcome);
    assert.equal(ins.payload.target_id, 't1');
    assert.equal(ins.payload.duration_seconds, 45);
    assert.equal(ins.payload.caller, 'u1');
    assert.equal(ins.payload.target_local_time, '12:00:00', 'the time it was where they are');
  }
});

test('a callback uses the date the caller gives, and is refused without one', async () => {
  logSetup();
  const when = '2026-11-25T14:30:00.000Z';
  const r = await clLog('t1', { outcome: 'callback', callbackAt: when, now: NY_NOON });
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'callback');
  assert.equal(r.data.nextCallAt, when);
  resetSb(); logSetup();
  const bad = await clLog('t1', { outcome: 'callback', now: NY_NOON });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /day and time they asked for/);
  assert.equal(calls.filter((c) => c.op === 'insert').length, 0, 'nothing is written without the date');
});

test('clLog refuses an outcome it does not know, and a missing target, without writing anything', async () => {
  logSetup();
  const a = await clLog('t1', { outcome: 'shouted_at', now: NY_NOON });
  assert.equal(a.ok, false); assert.match(a.error, /how the call went/);
  const b = await clLog('', { outcome: 'no_answer', now: NY_NOON });
  assert.equal(b.ok, false); assert.match(b.error, /Pick a target/);
  assert.equal(calls.length, 0);
});

/* ═════════ the do-not-call list ═════════ */

test('dnc_request adds the dnc row FIRST, then the call, and never touches the target again', async () => {
  logSetup();
  const r = await clLog('t1', { outcome: 'dnc_request', now: NY_NOON, notes: 'asked us to stop' });
  assert.equal(r.ok, true);
  const order = calls.map((c) => c.table + '.' + c.op);
  assert.equal(order.indexOf('dnc.insert'), 1, 'the list comes before everything but reading the target');
  assert.ok(order.indexOf('dnc.insert') < order.indexOf('call_log.insert'), 'on the list before the call is even written down');
  assert.ok(!order.includes('call_targets.update'), 'the database retires the target — we do not update a listed number');
  const d = calls.find((c) => c.table === 'dnc').payload;
  assert.equal(d.phone, '+1 512 555 0100');
  assert.equal(d.email, 'dana@acme.com');
  assert.equal(d.domain, 'acme.com');
  assert.equal(d.reason, 'requested');
  assert.equal(d.note, 'asked us to stop');
  assert.equal(r.data.status, 'dnc');
  assert.equal(r.data.retiredByDatabase, true);
  assert.equal(r.data.target, null);
});

test('if the dnc row cannot be written, the call is not logged either', async () => {
  logSetup();
  tables['dnc.insert'] = () => ({ data: null, error: { message: 'Could not add to the do-not-call list.' } });
  const r = await clLog('t1', { outcome: 'dnc_request', now: NY_NOON });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Could not add to the do-not-call list.');
  assert.ok(!calls.some((c) => c.table === 'call_log'), 'nothing is written until they are on the list');
});

test('clAddToDnc needs one of the three, keeps the reason inside the list and lower-cases the email', async () => {
  tables['dnc.insert'] = (c) => ({ data: [{ id: 'd1', ...c.payload }], error: null });
  const none = await clAddToDnc({});
  assert.equal(none.ok, false); assert.match(none.error, /phone number, an email address or a website/);
  const r = await clAddToDnc({ email: 'Dana@ACME.com', reason: 'nonsense', note: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.data.email, 'dana@acme.com');
  assert.equal(r.data.reason, 'requested', 'an unknown reason falls back to requested');
  assert.equal(r.data.phone, null);
  assert.equal(r.data.added_by, 'u1');
  const legal = await clAddToDnc({ phone: '555', reason: 'legal' });
  assert.equal(legal.data.reason, 'legal');
});

test("the database's refusal is shown as its own sentence, not reinvented here", async () => {
  const sentence = 'That number is on the do-not-call list and cannot be added again.';
  tables['call_targets.select'] = () => ({ data: [], error: null });
  tables['call_targets.insert'] = () => ({ data: null, error: { message: sentence } });
  const r = await clImport('Acme,Dana,Owner,555-0100,dana@acme.com');
  assert.equal(r.ok, true);
  assert.equal(r.data.skipped, 1);
  assert.equal(r.data.report[0].result, 'skipped');
  assert.equal(r.data.report[0].words, sentence);
});

/* ═════════ import ═════════ */

function importSetup(existing = [], refuse = []) {
  tables['call_targets.select'] = () => ({ data: existing, error: null });
  tables['call_targets.insert'] = (c) => {
    const p = c.payload;
    if (refuse.includes(p.phone) || refuse.includes(p.email)) {
      return { data: null, error: { message: 'That number is on the do-not-call list.' } };
    }
    return { data: [{ id: 'new-' + p.company, ...p }], error: null };
  };
}

test('clImport skips the rows on the do-not-call list and still imports the rest', async () => {
  importSetup([], ['555-0002']);
  const csv = [
    'company,person,phone,email,country',
    'Acme Roofing,Dana,555-0001,dana@acme.com,US',
    'Banned Co,Sam,555-0002,sam@banned.com,US',
    'Cobalt HVAC,Ali,555-0003,ali@cobalt.com,US',
  ].join('\n');
  const r = shape(await clImport(csv));
  assert.equal(r.ok, true);
  assert.equal(r.data.rows, 3);
  assert.equal(r.data.imported, 2);
  assert.equal(r.data.skipped, 1);
  assert.deepEqual(r.data.report.map((x) => x.result), ['imported', 'skipped', 'imported']);
  assert.deepEqual(r.data.report.map((x) => x.line), [1, 2, 3]);
  assert.equal(r.data.report[1].label, 'Banned Co');
  assert.match(r.data.report[1].words, /do-not-call list/);
  assert.match(r.data.words, /2 numbers added, 1 on the do-not-call list/);
  // the two good rows really were inserted
  const ins = calls.filter((c) => c.table === 'call_targets' && c.op === 'insert');
  assert.equal(ins.length, 3);
  assert.equal(ins[0].payload.company, 'Acme Roofing');
  assert.equal(ins[0].payload.status, 'new');
  assert.equal(ins[0].payload.owner, 'u1');
});

test('clImport dedupes on phone and on email — inside the paste and against the list already there', async () => {
  importSetup([{ phone: '+1 (555) 000-1111', email: 'old@acme.com' }]);
  const csv = [
    'company,phone,email',
    'Same Phone,5550001111,new@x.com',          // the same number, spelt differently
    'Same Email,555-9999,OLD@acme.com',         // the same address, different case
    'Fresh Co,555-2222,fresh@x.com',
    'Fresh Again,555-2222,other@x.com',         // repeats a phone from this very paste
    'Fresh Email,555-3333,fresh@x.com',         // repeats an email from this very paste
  ].join('\n');
  const r = await clImport(csv);
  assert.deepEqual(r.data.report.map((x) => x.result),
    ['duplicate', 'duplicate', 'imported', 'duplicate', 'duplicate']);
  assert.equal(r.data.imported, 1);
  assert.equal(r.data.duplicate, 4);
  assert.match(r.data.report[0].words, /Already on the calling list/);
});

test('clImport takes a plain paste with no header, rows of objects, and reports a row with nothing to dial', async () => {
  importSetup();
  const paste = await clImport('Acme Roofing,Dana Smith,Owner,555-0100,dana@acme.com,acme.com,US');
  assert.equal(paste.data.imported, 1);
  const p = calls.filter((c) => c.op === 'insert')[0].payload;
  assert.equal(p.company, 'Acme Roofing'); assert.equal(p.person_name, 'Dana Smith');
  assert.equal(p.job_title, 'Owner'); assert.equal(p.phone, '555-0100');
  assert.equal(p.email, 'dana@acme.com'); assert.equal(p.website, 'acme.com'); assert.equal(p.country, 'US');
  resetSb(); importSetup();
  const rows = await clImport([{ company: 'Rows Co', phone: '555-7777', personName: 'Jo', jobTitle: 'MD' }, { notes: 'nothing useful' }]);
  assert.equal(rows.data.imported, 1);
  assert.equal(rows.data.failed, 1);
  assert.equal(rows.data.report[1].result, 'not enough');
  const q = calls.filter((c) => c.op === 'insert')[0].payload;
  assert.equal(q.person_name, 'Jo'); assert.equal(q.job_title, 'MD');
  const empty = await clImport('   ');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /Nothing to import/);
});

/* ═════════ today, against the benchmark ═════════ */

const outcomes = (list) => { tables['call_log.select'] = () => ({ data: list.map((o) => log(o)), error: null }); };

test("clToday's arithmetic: dials, conversations, bookings, dials per booking, and the 400 benchmark", async () => {
  const list = [];
  for (let i = 0; i < 180; i++) list.push('no_answer');
  for (let i = 0; i < 12; i++) list.push('voicemail');
  for (let i = 0; i < 6; i++) list.push('conversation');
  list.push('booked', 'booked');
  outcomes(list);                                   // 200 dials, 8 conversations, 2 bookings
  const r = shape(await clToday({ now: NY_NOON }));
  assert.equal(r.ok, true);
  assert.equal(r.data.dials, 200);
  assert.equal(r.data.conversations, 8, 'a booking is a conversation too');
  assert.equal(r.data.bookings, 2);
  assert.equal(r.data.dialsPerBooking, 100);
  assert.equal(r.data.benchmark, 400);
  assert.equal(r.data.benchmarkLow, 370);
  assert.equal(r.data.connectRate, 0.04);
  assert.equal(r.data.talkSeconds, 200 * 30);
  assert.equal(r.data.expectedBookings, 0.5);
  assert.equal(r.data.onPace, true);
  assert.match(r.data.words, /100 dials per booking so far/);
  assert.match(r.data.words, /normal day or better/);
  assert.match(r.data.showRateWords, /65%/);
  assert.match(r.data.showRateWords, /93%/);
  assert.deepEqual(r.data.byOutcome, { no_answer: 180, voicemail: 12, conversation: 6, booked: 2 });
  // the day it asks for is today's own day
  const q = calls[0];
  assert.equal(q.filters[0][0], 'gte');
  assert.ok(q.filters[0][2] < NY_NOON && q.filters[1][2] > NY_NOON);
});

test('clToday: a bad day reads as a bad day, and a slow start still reads as normal', async () => {
  outcomes(Array(900).fill('no_answer').concat(['booked']));   // 901 dials for one booking
  const bad = await clToday({ now: NY_NOON });
  assert.equal(bad.data.dialsPerBooking, 901);
  assert.equal(bad.data.onPace, false);
  assert.match(bad.data.words, /running behind/);
  outcomes(Array(600).fill('no_answer'));                      // no booking, past the benchmark
  const behind = await clToday({ now: NY_NOON });
  assert.equal(behind.data.dialsPerBooking, null);
  assert.equal(behind.data.expectedBookings, 1.5);
  assert.equal(behind.data.onPace, false);
  assert.match(behind.data.words, /no booking yet/);
  assert.match(behind.data.words, /running behind/);
  outcomes(Array(40).fill('no_answer'));                       // early in the day
  const early = await clToday({ now: NY_NOON });
  assert.equal(early.data.onPace, true);
  assert.match(early.data.words, /still normal/);
});

test('clToday with no calls at all: zero everywhere, and words that say what the number should be', async () => {
  const r = await clToday({ now: NY_NOON });
  assert.equal(r.data.dials, 0); assert.equal(r.data.conversations, 0); assert.equal(r.data.bookings, 0);
  assert.equal(r.data.dialsPerBooking, null); assert.equal(r.data.connectRate, 0);
  assert.match(r.data.words, /No dials yet today/);
  assert.match(r.data.words, /370-400 dials/);
});

/* ═════════ clBooked ═════════ */

test('clBooked marks the target booked, stops the dialling and leaves the meeting to another area', async () => {
  tables['call_targets.update'] = (c) => ({ data: [{ ...target(), ...c.payload }], error: null });
  const r = shape(await clBooked('t1', { startsAt: '2026-11-25T15:00:00Z', minutes: 30 }));
  assert.equal(r.ok, true);
  assert.equal(r.data.target.status, 'booked');
  assert.equal(r.data.meeting, null);
  const up = calls[0];
  assert.equal(up.payload.status, 'booked');
  assert.equal(up.payload.next_call_at, null);
  assert.deepEqual(up.filters, [['eq', 'id', 't1']]);
  const none = await clBooked('');
  assert.equal(none.ok, false);
  // the meetings row is somebody else's work, and it is written down as such
  const src = fs.readFileSync(path.join(root, 'calling.js'), 'utf8');
  assert.match(src, /\/\/ TODO:[^\n]*meetings/);
});

/* ═════════ every screen, with zero rows ═════════ */

test('every screen renders with nothing in the database', () => {
  for (const [name, html] of [['calling', viewCalling()], ['call targets', viewCallTargets()], ['dnc', viewDnc()]]) {
    assert.equal(typeof html, 'string', name);
    assert.ok(html.startsWith('<div class="cl">'), name + ' is a screen');
    assert.ok(!/undefined|NaN|null/.test(visible(html)), name + ' shows no stray undefined/NaN: ' + visible(html));
  }
  const desk = visible(viewCalling());
  assert.ok(desk.includes('Calling desk') && desk.includes('8am-9pm'), 'the hours are on the desk');
  assert.ok(desk.includes('Dials today') && desk.includes('Benchmark') && desk.includes('370-400'), "today's numbers along the top");
  const list = visible(viewCallTargets());
  assert.ok(list.includes('No numbers on the list yet'), 'an empty calling list says so');
  assert.ok(viewCallTargets().includes('id="clPaste"'), 'the import box is on the list screen');
  const dnc = visible(viewDnc());
  assert.ok(dnc.includes('Nobody on the do-not-call list yet'));
  assert.ok(dnc.includes('only an admin can change or remove one'), 'it is plain who may remove a row');
  assert.ok(viewDnc().includes('id="clDncPhone"'), 'the add box is on the do-not-call screen');
});

test('the desk draws a real target, every outcome button, a notes box and an escaped company name', async () => {
  tables['call_targets.select'] = () => ({ data: [target({ company: '<b>Acme</b>', notes: 'likes mornings' })], error: null });
  tables['call_log.select'] = () => ({ data: [log('booked'), log('no_answer')], error: null });
  const realNow = Date.now; Date.now = () => Date.parse(NY_NOON);
  try { await clDeskLoad(); } finally { Date.now = realNow; }
  const h = viewCalling();
  assert.ok(!h.includes('<b>Acme</b>'), 'escaped');
  assert.ok(h.includes('&lt;b&gt;Acme&lt;/b&gt;'));
  for (const k of Object.keys(CL_RHYTHM)) assert.ok(h.includes("clDeskSave('" + k + "')"), k + ' has a button');
  assert.ok(h.includes('id="clNotes"') && h.includes('id="clCallback"'));
  assert.ok(h.includes('tel:+1 512 555 0100'));
  assert.ok(visible(h).includes('12:00 PM their time'));
  assert.ok(visible(h).includes('likes mornings'));
});

test('the desk shows the closed-window sentence instead of a number when nobody may be called', async () => {
  tables['call_targets.select'] = () => ({ data: [target()], error: null });
  const realNow = Date.now;
  Date.now = () => Date.parse(NY_NIGHT);
  try {
    await clDeskLoad();
    const t = visible(viewCalling());
    assert.ok(t.includes('Nobody to call right now'));
    assert.ok(t.includes('8am-9pm in their own time zone'));
    assert.ok(!t.includes('512 555 0100'), 'the number is not even on screen outside its window');
  } finally { Date.now = realNow; }
});

test('a database error on the desk shows plain words and a way to try again', async () => {
  tables['call_targets.select'] = () => ({ data: null, error: { message: "Couldn't reach the calling list." } });
  await clDeskLoad();
  const h = viewCalling();
  assert.ok(visible(h).includes("Couldn't reach the calling list."));
  assert.ok(h.includes('clDeskLoad()'));
});

test('the list screen filters by status and the filter is passed to the database', async () => {
  tables['call_targets.select'] = () => ({ data: [target({ status: 'callback', next_call_at: '2026-11-25T15:00:00Z' })], error: null });
  await clTargetsLoad('callback');
  assert.deepEqual(calls[0].filters, [['eq', 'status', 'callback']]);
  const h = viewCallTargets();
  assert.ok(h.includes('cl-filter on'), 'the chosen status is marked');
  assert.ok(visible(h).includes('Acme Roofing') && visible(h).includes('callback'));
  resetSb();
  tables['call_targets.select'] = () => ({ data: [], error: null });
  await clTargetsLoad('not_a_status');
  assert.deepEqual(calls[0].filters, [], 'a status we do not know is not sent to the database');
});

test('the do-not-call screen lists the rows it is given, escaped', async () => {
  tables['dnc.select'] = () => ({ data: [{ id: 'd1', phone: '555-0002', email: null, domain: null, reason: 'requested', note: '<i>asked</i>', created_at: NY_NOON }], error: null });
  await clDncLoad();
  const h = viewDnc();
  assert.ok(h.includes('&lt;i&gt;asked&lt;/i&gt;') && !h.includes('<i>asked</i>'));
  assert.ok(visible(h).includes('555-0002'));
  assert.ok(visible(h).includes('1 entry'));
});

/* ═════════ the rules this file is not allowed to break ═════════ */

test('calling.js goes nowhere but the database: no machineFetch, no MACHINE_URL, no email-distributor', () => {
  const src = fs.readFileSync(path.join(root, 'calling.js'), 'utf8');
  assert.ok(!src.includes('machineFetch'));
  assert.ok(!src.includes('MACHINE_URL'));
  assert.ok(!src.includes('email-distributor'));
  assert.ok(!/\bfetch\s*\(/.test(src));
  assert.ok(!/^\s*import\s/m.test(src), 'no imports: it is a plain script tag');
  // the follow-up rhythm is defined once
  assert.equal((src.match(/waitHours:/g) || []).length, 4);
  // the css only uses theme.css variables, no new colours
  const css = fs.readFileSync(path.join(root, 'calling.css'), 'utf8');
  const hex = css.match(/#[0-9a-fA-F]{3,8}/g) || [];
  assert.deepEqual(hex.filter((h) => h.toLowerCase() !== '#fff'), [], 'no new colours: ' + hex.join(' '));
});
