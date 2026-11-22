/* Tests for Meetings (meetings.js) — the calendar, booking, reminders, no-shows,
   and whether a booked call counts.

   Same set-up as tests/calendar.test.mjs: a tiny fake DOM, then the shell's inline
   script from index.html, then meetings.js, exactly as the browser loads them.
   There is no machine here and no network: `sb` is a small in-memory Supabase that
   really filters, orders and writes, so "found once, not twice" is a real test.

   Run with:  node --test tests/meetings.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM (as in calendar.test.mjs) ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() {}, select() {}, submit() {}, addEventListener() {}, scrollIntoView() {}, closest() { return null; }, getAttribute() { return null; } };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.location = { hash: '', origin: 'https://aviance.store', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };
globalThis.fetch = async () => { throw new TypeError('No network in the tests.'); };
globalThis.confirm = () => true; globalThis.prompt = () => 'a reason';
globalThis.addEventListener = () => {};

/* ───────────── a small in-memory Supabase ───────────── */
let db, calls, fail, seq;
function resetDb() {
  db = { calendar_settings: [], calendar_blocks: [], meetings: [], qualified_calls: [] };
  calls = []; fail = {}; seq = 0;
}
const nextId = (t) => t.slice(0, 3) + '-' + (++seq);
function keep(rows, filters) {
  return rows.filter((r) => filters.every(([op, k, v]) => {
    const a = r[k];
    if (op === 'eq') return String(a) === String(v);
    if (op === 'neq') return String(a) !== String(v);
    if (op === 'is') return v === null ? a == null : a === v;
    if (op === 'in') return v.some((x) => String(x) === String(a));
    const A = typeof a === 'string' ? a : String(a), B = typeof v === 'string' ? v : String(v);
    if (op === 'gte') return a != null && A >= B;
    if (op === 'gt') return a != null && A > B;
    if (op === 'lte') return a != null && A <= B;
    if (op === 'lt') return a != null && A < B;
    return true;
  }));
}
function builder(table) {
  const c = { table, op: 'select', filters: [], order: null, payload: null, one: null };
  calls.push(c);
  const b = {
    select() { return b; },
    insert(p) { c.op = 'insert'; c.payload = p; return b; },
    update(p) { c.op = 'update'; c.payload = p; return b; },
    delete() { c.op = 'delete'; return b; },
    eq(k, v) { c.filters.push(['eq', k, v]); return b; },
    neq(k, v) { c.filters.push(['neq', k, v]); return b; },
    is(k, v) { c.filters.push(['is', k, v]); return b; },
    in(k, v) { c.filters.push(['in', k, v]); return b; },
    gt(k, v) { c.filters.push(['gt', k, v]); return b; },
    gte(k, v) { c.filters.push(['gte', k, v]); return b; },
    lt(k, v) { c.filters.push(['lt', k, v]); return b; },
    lte(k, v) { c.filters.push(['lte', k, v]); return b; },
    order(k, o) { c.order = [k, !o || o.ascending !== false]; return b; },
    limit() { return b; },
    single() { c.one = 'single'; return b; },
    maybeSingle() { c.one = 'maybe'; return b; },
    then(res, rej) { return Promise.resolve(run(c)).then(res, rej); },
  };
  return b;
}
function run(c) {
  const bad = fail[c.table + '.' + c.op] || fail[c.table];
  if (bad) return { data: null, error: { message: bad } };
  const rows = db[c.table] || (db[c.table] = []);
  let out;
  if (c.op === 'insert') {
    const list = Array.isArray(c.payload) ? c.payload : [c.payload];
    out = list.map((p) => { const r = Object.assign({ id: nextId(c.table), created_at: new Date().toISOString() }, p); rows.push(r); return r; });
  } else if (c.op === 'update') {
    out = keep(rows, c.filters).map((r) => Object.assign(r, c.payload));
  } else if (c.op === 'delete') {
    out = keep(rows, c.filters);
    out.forEach((r) => rows.splice(rows.indexOf(r), 1));
  } else {
    out = keep(rows, c.filters).slice();
  }
  if (c.order) { const [k, asc] = c.order; out.sort((x, y) => (String(x[k]) < String(y[k]) ? -1 : String(x[k]) > String(y[k]) ? 1 : 0) * (asc ? 1 : -1)); }
  if (c.one === 'single') return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
  if (c.one === 'maybe') return { data: out.length ? out[0] : null, error: null };
  return { data: out, error: null };
}
resetDb();
const fakeSb = {
  from: builder,
  rpc: async () => ({ data: null, error: null }),
  auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }), getUser: async () => ({ data: { user: null } }), signInWithPassword: async () => ({ error: null }), signOut: async () => {}, resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) },
};
globalThis.supabase = { createClient: () => fakeSb };

/* ───────────── load the shell, then meetings.js ───────────── */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="finance.js">'));
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
const SRC = fs.readFileSync(path.join(root, 'meetings.js'), 'utf8');
vm.runInThisContext(SRC, { filename: 'meetings.js' });

/* ───────────── helpers ───────────── */
const toasts = [];
globalThis.toast = (m) => { toasts.push(m); };
globalThis.openModal = (h) => { el('modal').innerHTML = h; };
globalThis.closeModal = () => {};
const tick = () => new Promise((r) => setTimeout(r, 5));
/* the live calendar_settings row */
const LIVE = { id: 1, open_time: '07:00', close_time: '21:00', days: [1, 2, 3, 4, 5], slot_minutes: 30, min_notice_h: 0, days_ahead: 30, us_zone: 'America/New_York', owner_zone: 'Asia/Colombo', meeting_link: null, updated_at: '2026-11-01T00:00:00Z' };
const settingsRow = (over) => { db.calendar_settings = [Object.assign({}, LIVE, over || {})]; };
const at = (now) => { mt.now = now; };
const host = (id) => el(id).innerHTML;
const visible = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

beforeEach(() => { resetDb(); mtForget(); toasts.length = 0; Object.keys(elements).forEach((k) => { elements[k].innerHTML = ''; elements[k].value = ''; elements[k].textContent = ''; }); });

/* ───────────── the rules come from the row ───────────── */
test('the rules are read from calendar_settings, never hard-coded; a missing row falls back to the live values', async () => {
  settingsRow({ open_time: '08:00', close_time: '10:00', days: [2], slot_minutes: 60, min_notice_h: 0, days_ahead: 60 });
  at('2026-11-23T05:00:00Z');
  const tue = await mtSlots('2026-11-24');                 // Tuesday, the only allowed day
  assert.equal(tue.ok, true);
  assert.deepEqual(tue.data.map((s) => s.us), ['8:00 am', '9:00 am'], 'two 60-minute slots inside 08:00–10:00');
  assert.equal(tue.data[0].minutes, 60);
  assert.deepEqual((await mtSlots('2026-11-23')).data, [], 'Monday is not an allowed day in this row');

  mtForget(); db.calendar_settings = [];                   // no row at all
  const s = await mtSettings();
  assert.equal(s.ok, true);
  assert.equal(s.data.open_time, '07:00'); assert.equal(s.data.close_time, '21:00');
  assert.deepEqual(s.data.days, [1, 2, 3, 4, 5]);
  assert.equal(s.data.slot_minutes, 30);
  assert.equal(s.data.us_zone, 'America/New_York'); assert.equal(s.data.owner_zone, 'Asia/Colombo');
  assert.equal(s.data.fallback, true, 'it says it is the fallback');
});

/* ───────────── slots ───────────── */
test('slots: inside 07:00–21:00, on weekdays only, 30 minutes each', async () => {
  settingsRow(); at('2026-11-23T05:00:00Z');               // Monday, midnight US Eastern
  const mon = await mtSlots('2026-11-23');
  assert.equal(mon.ok, true);
  assert.equal(mon.data.length, 28, '14 hours of 30-minute slots');
  assert.equal(mon.data[0].us, '7:00 am', 'the first slot is the open time');
  assert.equal(mon.data[0].startsAt, '2026-11-23T12:00:00.000Z');
  assert.equal(mon.data[27].us, '8:30 pm', 'the last slot ends at the close time, never after');
  assert.equal(Date.parse(mon.data[27].endsAt) - Date.parse(mon.data[27].startsAt), 30 * 60000);
  mon.data.forEach((s) => { assert.equal(s.minutes, 30); assert.equal(s.usDate, '2026-11-23'); });
  assert.deepEqual((await mtSlots('2026-11-28')).data, [], 'Saturday is not a calling day');
  assert.deepEqual((await mtSlots('2026-11-29')).data, [], 'Sunday is not a calling day');
  assert.deepEqual((await mtSlots('2026-11-20')).data, [], 'a day in the past has no slots');
  assert.deepEqual((await mtSlots('2027-06-01')).data, [], 'further out than days_ahead');
  assert.equal((await mtSlots('not-a-date')).ok, false);
  assert.match((await mtSlots('not-a-date')).error, /date/i);
});

test('min_notice_h keeps the next few hours out of the list', async () => {
  settingsRow({ min_notice_h: 12 }); at('2026-11-23T13:00:00Z');      // Monday 8 am US Eastern
  const r = await mtSlots('2026-11-23');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.map((s) => s.us), ['8:00 pm', '8:30 pm'], 'only what is at least 12 hours away');
});

test('both time zones are right across a US daylight-saving change (Intl, not an offset)', async () => {
  settingsRow(); at('2026-10-20T12:00:00Z');
  const edt = (await mtSlots('2026-10-27')).data.find((s) => s.us === '9:00 am');   // US summer time
  const est = (await mtSlots('2026-11-10')).data.find((s) => s.us === '9:00 am');   // US winter time
  assert.ok(edt && est);
  assert.equal(edt.startsAt, '2026-10-27T13:00:00.000Z');
  assert.equal(est.startsAt, '2026-11-10T14:00:00.000Z', 'an hour later in UTC once the US clocks go back');
  assert.equal(edt.lk, '6:30 pm'); assert.equal(edt.lkDate, '2026-10-27');
  assert.equal(est.lk, '7:30 pm', 'Sri Lanka never changes its clocks, so the gap moves');
  assert.match(edt.lkLabel, /Sri Lanka/); assert.match(edt.usLabel, /US Eastern/);
  // a late US afternoon call is the next morning in Colombo, and it says so
  const late = (await mtSlots('2026-11-10')).data.find((s) => s.us === '8:00 pm');
  assert.equal(late.lk, '6:30 am'); assert.equal(late.lkDate, '2026-11-11');
  // no hand-rolled offsets anywhere in the file
  assert.ok(!/getTimezoneOffset|\+05:30|5\.5\s*\*|330\s*\*|UTC[+-]\d/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')), 'every conversion goes through Intl');
});

/* ───────────── a taken slot and a blocked slot ───────────── */
test('a slot with a call in it, and a blocked slot, are gone from the list and refused by mtBook', async () => {
  settingsRow(); at('2026-11-23T05:00:00Z');
  db.meetings.push({ id: 'm1', client_id: 'c1', kind: 'discovery', starts_at: '2026-11-23T14:00:00.000Z', minutes: 30, time_zone: 'America/New_York', status: 'booked' });
  db.calendar_blocks.push({ id: 'b1', starts_at: '2026-11-23T16:00:00.000Z', ends_at: '2026-11-23T17:00:00.000Z', reason: 'school run' });
  const r = await mtSlots('2026-11-23');
  const times = r.data.map((s) => s.us);
  assert.ok(!times.includes('9:00 am'), 'the booked 9 am is gone');
  assert.ok(!times.includes('11:00 am') && !times.includes('11:30 am'), 'the blocked hour is gone');
  assert.equal(r.data.length, 28 - 3);

  const taken = await mtBook({ kind: 'discovery', startsAt: '2026-11-23T14:00:00.000Z' });
  assert.equal(taken.ok, false);
  assert.match(taken.error, /already taken by another call\.$/);
  const blocked = await mtBook({ kind: 'discovery', startsAt: '2026-11-23T16:30:00.000Z' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /blocked out/);
  assert.equal(db.meetings.length, 1, 'a refusal writes nothing');
  // a cancelled call leaves its time open again
  db.meetings[0].status = 'cancelled';
  assert.ok((await mtSlots('2026-11-23')).data.map((s) => s.us).includes('9:00 am'));
  assert.equal((await mtBook({ kind: 'strategy', startsAt: '2026-11-23T14:00:00.000Z' })).ok, true);
});

test('booking outside the window is refused in a plain sentence', async () => {
  settingsRow(); at('2026-11-23T05:00:00Z');
  const early = await mtBook({ kind: 'discovery', startsAt: '2026-11-23T11:00:00.000Z' });   // 6 am US Eastern
  assert.equal(early.ok, false);
  assert.equal(early.error, 'That time is outside your call hours of 7:00 am to 9:00 pm US Eastern.');
  const late = await mtBook({ kind: 'discovery', startsAt: '2026-11-24T01:45:00.000Z' });    // 8:45 pm, would run past 9
  assert.equal(late.ok, false);
  assert.match(late.error, /outside your call hours/);
  const sat = await mtBook({ kind: 'discovery', startsAt: '2026-11-28T15:00:00.000Z' });
  assert.equal(sat.ok, false);
  assert.equal(sat.error, 'That day is not one of your calling days — those are Mon–Fri.');
  const gone = await mtBook({ kind: 'discovery', startsAt: '2026-11-16T15:00:00.000Z' });
  assert.equal(gone.ok, false); assert.match(gone.error, /already passed/);
  const odd = await mtBook({ kind: 'coffee', startsAt: '2026-11-23T15:00:00.000Z' });
  assert.equal(odd.ok, false); assert.match(odd.error, /not a kind of call we book/);
  assert.equal(db.meetings.length, 0, 'nothing was written');
  // and the good case writes one row, with the rules' slot length and zone
  const good = await mtBook({ kind: 'qualified', clientId: 'c1', startsAt: '2026-11-23T15:00:00.000Z', notes: 'from the website' });
  assert.equal(good.ok, true);
  assert.equal(good.data.status, 'booked'); assert.equal(good.data.minutes, 30);
  assert.equal(good.data.time_zone, 'America/New_York'); assert.equal(good.data.kind, 'qualified');
  assert.equal(db.meetings.length, 1);
});

test('moving a call checks the same rules and clears the reminder stamps; its own time is not a clash', async () => {
  settingsRow(); at('2026-11-23T05:00:00Z');
  const b = await mtBook({ kind: 'discovery', startsAt: '2026-11-23T15:00:00.000Z' });
  await mtMarkReminded(b.data.id, '24h');
  assert.ok(db.meetings[0].reminded_24h_at, 'stamped');
  const same = await mtReschedule(b.data.id, '2026-11-23T15:00:00.000Z');
  assert.equal(same.ok, true, 'a call never clashes with itself');
  const out = await mtReschedule(b.data.id, '2026-11-23T11:00:00.000Z');
  assert.equal(out.ok, false); assert.match(out.error, /outside your call hours/);
  const moved = await mtReschedule(b.data.id, '2026-11-23T16:00:00.000Z');
  assert.equal(moved.ok, true);
  assert.equal(moved.data.starts_at, '2026-11-23T16:00:00.000Z');
  assert.equal(moved.data.reminded_24h_at, null, 'the nudges go out again for the new time');
});

/* ───────────── reminders ───────────── */
test('reminders are found once and not twice, and nothing is sent from here', async () => {
  settingsRow(); at('2026-11-23T15:00:00.000Z');
  db.meetings.push(
    { id: 'soon', kind: 'discovery', starts_at: '2026-11-23T15:40:00.000Z', minutes: 30, status: 'booked', reminded_24h_at: '2026-11-22T15:00:00Z', reminded_1h_at: null },
    { id: 'tomorrow', kind: 'qualified', client_id: 'c1', starts_at: '2026-11-24T14:00:00.000Z', minutes: 30, status: 'booked', reminded_24h_at: null, reminded_1h_at: null },
    { id: 'faraway', kind: 'review', starts_at: '2026-11-27T14:00:00.000Z', minutes: 30, status: 'booked', reminded_24h_at: null, reminded_1h_at: null },
    { id: 'off', kind: 'review', starts_at: '2026-11-23T15:40:00.000Z', minutes: 30, status: 'cancelled', reminded_24h_at: null, reminded_1h_at: null },
  );
  const due = await mtDue();
  assert.equal(due.ok, true);
  assert.deepEqual(due.data.map((x) => [x.meeting.id, x.which]), [['soon', '1h'], ['tomorrow', '24h']], 'soonest first; the far-off and the cancelled are left alone');
  assert.match(due.data[0].when.us, /US Eastern/);
  assert.match(due.data[0].when.owner, /Sri Lanka/);

  for (const x of due.data) assert.equal((await mtMarkReminded(x.meeting.id, x.which)).ok, true);
  assert.deepEqual((await mtDue()).data, [], 'stamped, so never found a second time');
  assert.equal(db.meetings[0].reminded_1h_at, '2026-11-23T15:00:00.000Z');
  assert.equal(db.meetings[1].reminded_24h_at, '2026-11-23T15:00:00.000Z');
  assert.match((await mtMarkReminded('soon', 'weekly')).error, /24-hour|1-hour/);
  // the send is not built here; the hook says where it goes
  assert.ok(/TODO:/.test(SRC) && /mtMarkReminded\(entry\.meeting\.id, entry\.which\)/.test(SRC), 'a TODO marks where the send hooks in');
  assert.ok(!/machineFetch|MACHINE_URL|email-distributor/.test(SRC), 'no machine, no email-distributor');
});

/* ───────────── the money: a no-show can never count ───────────── */
test('a no-show on a qualified meeting flips qualified_calls.happened to false', async () => {
  settingsRow(); at('2026-11-23T20:00:00.000Z');
  const when = '2026-11-23T15:00:00.000Z';
  db.meetings.push({ id: 'q1', client_id: 'c1', kind: 'qualified', starts_at: when, minutes: 30, status: 'booked' });
  db.qualified_calls.push({ id: 'qc1', client_id: 'c1', month_id: 'mo1', booked_for: when, matched_icp: true, happened: true, happened_at: when, dispute_status: 'none' });

  const r = await mtNoShow('q1');
  assert.equal(r.ok, true);
  assert.equal(r.data.counted, false);
  assert.equal(db.meetings[0].status, 'no_show');
  assert.equal(db.meetings[0].held_at, null);
  assert.equal(db.qualified_calls[0].happened, false, 'the month stops counting it');
  assert.equal(db.qualified_calls[0].happened_at, null);

  // and the other way round
  const h = await mtHeld('q1');
  assert.equal(h.ok, true); assert.equal(h.data.counted, true);
  assert.equal(db.meetings[0].status, 'held');
  assert.equal(db.qualified_calls[0].happened, true);
  assert.equal(db.qualified_calls[0].happened_at, when);
});

test('a no-show can never silently count: if the money row cannot be written, the meeting is left alone and it says so', async () => {
  settingsRow(); at('2026-11-23T20:00:00.000Z');
  const when = '2026-11-23T15:00:00.000Z';
  db.meetings.push({ id: 'q2', client_id: 'c1', kind: 'qualified', starts_at: when, minutes: 30, status: 'booked' });
  db.qualified_calls.push({ id: 'qc2', client_id: 'c1', booked_for: when, happened: true, happened_at: when });
  fail['qualified_calls.update'] = 'the database said no';

  const r = await mtNoShow('q2');
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing was changed/);
  assert.equal(db.meetings[0].status, 'booked', 'the meeting is not marked, so the two sides never disagree');
  assert.equal(db.qualified_calls[0].happened, true);
  delete fail['qualified_calls.update'];

  // a qualified meeting with no matching call: the no-show still goes down, and nothing was ever counted
  db.qualified_calls.length = 0;
  const r2 = await mtNoShow('q2');
  assert.equal(r2.ok, true); assert.equal(r2.data.call, null); assert.equal(r2.data.counted, false);
  assert.equal(db.meetings[0].status, 'no_show');
  // marking it held instead says plainly that the month did not move
  const h = await mtHeld('q2');
  assert.equal(h.ok, true); assert.equal(h.data.counted, false);
  assert.match(h.data.note, /has not changed/);
  // cancelling a qualified call also takes it out of the month
  db.qualified_calls.push({ id: 'qc3', client_id: 'c1', booked_for: when, happened: true, happened_at: when });
  const c = await mtCancel('q2', 'they went quiet');
  assert.equal(c.ok, true);
  assert.equal(db.meetings[0].status, 'cancelled');
  assert.equal(db.qualified_calls[0].happened, false);
  assert.match(db.meetings[0].notes, /they went quiet/);
  // a meeting that is not a sales call never touches the money
  db.meetings.push({ id: 'd1', client_id: 'c1', kind: 'discovery', starts_at: when, minutes: 30, status: 'booked' });
  db.qualified_calls[0].happened = true;
  const d = await mtHeld('d1');
  assert.equal(d.ok, true); assert.equal(d.data.counted, false);
  assert.equal(db.qualified_calls[0].happened, true, 'untouched');
  assert.equal((await mtNoShow('nope')).ok, false);
});

/* ───────────── blocks ───────────── */
test('blocking and unblocking time', async () => {
  settingsRow(); at('2026-11-23T05:00:00Z');
  const b = await mtBlock('2026-11-23T16:00:00.000Z', '2026-11-23T17:00:00.000Z', 'dentist');
  assert.equal(b.ok, true); assert.equal(b.data.reason, 'dentist');
  assert.equal((await mtBlock('2026-11-23T17:00:00.000Z', '2026-11-23T16:00:00.000Z')).ok, false);
  assert.match((await mtBlock('nonsense', 'nonsense')).error, /start time and an end time/);
  db.meetings.push({ id: 'm9', kind: 'discovery', starts_at: '2026-11-24T15:00:00.000Z', minutes: 30, status: 'booked' });
  const clash = await mtBlock('2026-11-24T15:00:00.000Z', '2026-11-24T16:00:00.000Z', 'nope');
  assert.equal(clash.ok, false); assert.match(clash.error, /already a call in that time/);
  const u = await mtUnblock(b.data.id);
  assert.equal(u.ok, true); assert.equal(db.calendar_blocks.length, 0);
});

/* ───────────── every screen, with zero rows ───────────── */
test('every screen draws with zero rows in the database', async () => {
  settingsRow(); at('2026-11-23T05:00:00Z');
  db.calendar_settings = [];                 // not even the rules row

  const cal = viewCalendar();
  assert.ok(cal.includes('id="mtWeekHost"'));
  await tick(); await tick();
  const week = host('mtWeekHost');
  assert.ok(week.length > 0);
  assert.match(visible(week), /Nothing booked this week yet/);
  assert.match(visible(week), /Call hours/);
  assert.match(visible(week), /US Eastern/); assert.match(visible(week), /Sri Lanka/);
  assert.match(visible(week), /Not a calling day/, 'the weekend says why it is empty');

  const one = viewMeeting('does-not-exist');
  assert.ok(one.includes('id="mtOneHost"'));
  await tick(); await tick();
  assert.match(visible(host('mtOneHost')), /not on the calendar any more/);
  assert.match(visible(mtRenderMeeting(null)), /not on the calendar any more/);

  const ns = viewNoShows();
  assert.ok(ns.includes('id="mtNoShowHost"'));
  await tick(); await tick();
  assert.match(visible(host('mtNoShowHost')), /No booked sales call has been lost to a no-show this month/);
  assert.match(visible(host('mtNoShowHost')), /No no-shows in the last 45 days/);
  // and the pure renderers with nothing at all
  assert.ok(mtRenderWeek(null).length > 0);
  assert.ok(mtRenderNoShows(null).length > 0);
  assert.ok(mtRenderWeek({ st: mtSettingsNow(), monday: '2026-11-23', days: [], empty: true }).length > 0);
});

test('the week, one meeting and the no-shows show both zones, the link, the reminder state and what it did to the month', async () => {
  settingsRow(); at('2026-11-25T20:00:00.000Z');
  const when = '2026-11-23T15:00:00.000Z';                 // Monday 10 am US Eastern
  db.meetings.push(
    { id: 'q5', client_id: 'client-9999', kind: 'qualified', starts_at: when, minutes: 30, time_zone: 'America/Chicago', status: 'no_show', meet_link: 'https://meet.example.com/abc', reminded_24h_at: '2026-11-22T15:00:00.000Z', reminded_1h_at: null, notes: '<b>hi</b>' },
    { id: 'r5', kind: 'review', starts_at: '2026-11-26T15:00:00.000Z', minutes: 30, status: 'booked' },
  );
  db.qualified_calls.push({ id: 'qc5', client_id: 'client-9999', booked_for: when, happened: false, happened_at: null });
  db.calendar_blocks.push({ id: 'blk5', starts_at: '2026-11-26T18:00:00.000Z', ends_at: '2026-11-26T19:00:00.000Z', reason: 'dentist' });

  mt.week = '2026-11-23';
  await mtLoadWeek();
  const week = visible(host('mtWeekHost'));
  assert.match(week, /10:00 am US Eastern/); assert.match(week, /8:30 pm Sri Lanka/);
  assert.match(week, /Booked sales call/); assert.match(week, /No-show/);
  assert.match(week, /Blocked out dentist/);
  assert.ok(host('mtWeekHost').includes('mt-slot'), 'free times are there to click');

  await mtLoadMeeting('q5');
  const one = host('mtOneHost');
  assert.match(visible(one), /Mon 23 Nov · 10:00 am US Eastern/);
  assert.match(visible(one), /Mon 23 Nov · 8:30 pm Sri Lanka/);
  assert.match(one, /href="https:\/\/meet\.example\.com\/abc"/);
  assert.match(visible(one), /24 hours before: sent/); assert.match(visible(one), /1 hour before: not sent yet/);
  assert.match(visible(one), /Not counted for the month/);
  assert.ok(!one.includes('<b>hi</b>') && one.includes('&lt;b&gt;hi'), 'everything is escaped');

  await mtLoadNoShows();
  const ns = visible(host('mtNoShowHost'));
  assert.match(ns, /1 booked sales call did not count this month/);
  assert.match(ns, /does not count towards the month/);
  assert.match(ns, /10:00 am/);
});

/* ───────────── the house rules ───────────── */
test('plain browser JavaScript, no imports, and every global prefixed mt', () => {
  assert.ok(!/\brequire\(|^\s*import\s|^\s*export\s/m.test(SRC), 'no imports, no build step');
  const names = [...SRC.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1])
    .concat([...SRC.matchAll(/^const\s+([A-Za-z0-9_$]+)\s*=/gm)].map((m) => m[1]));
  const odd = names.filter((n) => !/^(mt|MT_)/.test(n) && !['viewCalendar', 'viewMeeting', 'viewNoShows'].includes(n));
  assert.deepEqual(odd, [], 'every global is mt-prefixed, apart from the three screens the shell names');
  assert.ok(typeof viewCalendar === 'function' && typeof viewMeeting === 'function' && typeof viewNoShows === 'function');
  for (const f of ['mtSlots', 'mtBook', 'mtReschedule', 'mtCancel', 'mtDue', 'mtMarkReminded', 'mtHeld', 'mtNoShow', 'mtBlock', 'mtUnblock'])
    assert.equal(typeof globalThis[f], 'function', f);
  // the css reuses theme tokens and brings no new colours
  const css = fs.readFileSync(path.join(root, 'meetings.css'), 'utf8');
  assert.ok(/var\(--/.test(css));
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no new colours');
  assert.ok(/^\.mt-|[\s,]\.mt-/m.test(css));
});

test('nothing throws: a database that says no comes back as a plain sentence', async () => {
  settingsRow();
  fail['calendar_settings'] = 'the database is not answering';
  const s = await mtSettings(true);
  assert.deepEqual([s.ok, s.data], [false, null]);
  assert.equal(s.error, 'the database is not answering');
  assert.equal((await mtSlots('2026-11-23')).ok, false);
  delete fail['calendar_settings'];
  mtForget(); at('2026-11-23T05:00:00Z');
  fail['meetings.select'] = 'no answer';
  const r = await mtSlots('2026-11-23');
  assert.equal(r.ok, false); assert.equal(r.error, 'no answer');
  assert.equal((await mtDue()).ok, false);
  delete fail['meetings.select'];
});
