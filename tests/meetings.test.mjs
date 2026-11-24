/* Tests for Meetings (meetings.js) — the Calendar: every call from both tables on one
   real calendar, booking, reminders, no-shows, and whether a booked call counts.

   A tiny fake DOM, then the shell's inline script from index.html, then pipeline.js and
   meetings.js, in the order the browser loads them (the calendar draws website bookings
   through pipeline.js). There is no machine here and no network: `sb` is a small
   in-memory Supabase that really filters, orders and writes, so "found once, not twice"
   is a real test.

   Run with:  node --test tests/meetings.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM ───────────── */
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
  db = { calendar_settings: [], calendar_blocks: [], meetings: [], qualified_calls: [], discovery_bookings: [], research_briefs: [], research_log: [], clients: [], plan_prices: [] };
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
  if (bad) return { data: null, error: typeof bad === 'object' ? bad : { message: bad } };
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
const dbRows = (t) => (db[t] ||= []);
/* The database's close_won rule, small and in memory: one client per booking, the plan's
   own numbers, the booking marked won. Its refusal is the real one's words. */
const rpcs = [];
let rpcFail = null;
function closeWon(a) {
  const b = (dbRows('discovery_bookings')).find((r) => String(r.id) === String(a.p_booking));
  if (!b) return { data: null, error: { message: 'That call is not here any more.' } };
  if (dbRows('clients').some((c) => String(c.booking_id) === String(b.id))) return { data: null, error: { message: 'That call is already a client.' } };
  const p = dbRows('plan_prices').find((x) => x.plan === a.p_plan);
  if (!p) return { data: null, error: { message: 'That plan is not in the price list.' } };
  const term = a.p_term === '3month' ? '3month' : 'monthly';
  const c = { id: 'cl-' + (dbRows('clients').length + 1), booking_id: b.id, company: b.company, contact_name: b.name, contact_email: b.email, plan: p.plan, term, calls_promised: p.calls_promised, monthly_fee: term === '3month' && p.three_month_fee ? p.three_month_fee : p.monthly_fee, stage: 'won' };
  dbRows('clients').push(c); b.status = 'won';
  return { data: { client_id: c.id, invoice_id: 'inv-1', agreement_id: 'agr-1', invoice_number: 'AV-2026-0001' }, error: null };
}
async function fakeRpc(name, args) {
  rpcs.push({ name, args });
  if (rpcFail) return { data: null, error: rpcFail };
  if (name === 'close_won') return closeWon(args || {});
  return { data: null, error: null };
}
const fakeSb = {
  from: builder,
  rpc: fakeRpc,
  auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }), getUser: async () => ({ data: { user: null } }), signInWithPassword: async () => ({ error: null }), signOut: async () => {}, resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) },
};
globalThis.supabase = { createClient: () => fakeSb };

/* ───────────── load the shell, then pipeline.js, then meetings.js ───────────── */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="finance.js">'));
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'pipeline.js'), 'utf8'), { filename: 'pipeline.js' });
const SRC = fs.readFileSync(path.join(root, 'meetings.js'), 'utf8');
vm.runInThisContext(SRC, { filename: 'meetings.js' });

/* ───────────── helpers ───────────── */
const toasts = [];
globalThis.toast = (m) => { toasts.push(m); };
const openModalShell = globalThis.openModal;   /* the shell's own, kept for the shell test */
globalThis.openModal = (h) => { el('modal').innerHTML = h; };
globalThis.closeModal = () => {};
const tick = () => new Promise((r) => setTimeout(r, 5));
/* the live calendar_settings row */
const LIVE = { id: 1, open_time: '07:00', close_time: '21:00', days: [1, 2, 3, 4, 5], slot_minutes: 30, min_notice_h: 0, days_ahead: 30, us_zone: 'America/New_York', owner_zone: 'Asia/Colombo', meeting_link: null, updated_at: '2026-11-01T00:00:00Z' };
const settingsRow = (over) => { db.calendar_settings = [Object.assign({}, LIVE, over || {})]; };
const at = (now) => { mt.now = now; };
const host = (id) => el(id).innerHTML;
const visible = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const BROKEN = /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/;

/* the older tests were written against the month, so each test starts there; the default
   (week) and remembering the choice have their own test */
beforeEach(() => { resetDb(); localStorage._s = { avianceCalView: 'month' }; mtForget(); plForget(); toasts.length = 0; Object.keys(elements).forEach((k) => { elements[k].innerHTML = ''; elements[k].value = ''; elements[k].textContent = ''; }); });

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
  settingsRow(); at('2026-11-23T05:00:00Z');                // Monday 10:30 am in Colombo
  db.calendar_settings = [];                 // not even the rules row

  const cal = viewCalendar();
  assert.ok(cal.includes('id="mtCalHost"'));
  await tick(); await tick();
  const month = host('mtCalHost');
  assert.match(visible(month), /November 2026/);
  assert.match(visible(month), /Nothing booked this month yet/);
  assert.match(visible(month), /Mon Tue Wed Thu Fri Sat Sun/, 'a weekday header, Monday first');
  assert.match(visible(month), /Call hours/);
  assert.match(visible(month), /Every time is Sri Lanka time/);
  assert.ok(!month.includes('mt-legend'), 'the colour key is not drawn until it is asked for');
  assert.match(month, /aria-label="What the colours mean"/);
  assert.match(month, /onclick="mtOpenAdd\(\)">Add meeting</);
  assert.ok(!/need an outcome —|needs? an outcome<\/button>/.test(month), 'nothing is waiting, so no line about it');
  assert.ok(!BROKEN.test(visible(month)), visible(month));

  await mtSetView('week');
  const week = host('mtCalHost');
  assert.match(visible(week), /23 – 29 Nov 2026/);
  assert.match(visible(week), /Nothing booked this week yet/);
  assert.ok(week.includes('mt-wk-col') && week.includes('mt-agenda'), 'the grid and the phone list are both there');
  assert.equal(colsOf(week).length, 5, 'Monday to Friday, with nothing to put on the weekend');
  assert.ok(!BROKEN.test(visible(week)), visible(week));

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

  const fn = viewFunnel();
  assert.ok(fn.includes('id="plHost"'));
  await tick(); await tick();
  assert.match(visible(host('plHost')), /Show rate/);

  // a call that is not there any more still gives a panel that says so
  await mtOpenEvent('booking:nope');
  assert.match(visible(host('modal')), /not here any more/);
  await mtOpenEvent('meeting:nope');
  assert.match(visible(host('modal')), /not on the calendar any more/);

  // and the pure renderers with nothing at all
  assert.ok(mtRenderCal(null).length > 0);
  assert.ok(mtRenderNoShows(null).length > 0);
  assert.ok(mtRenderBookingPanel(null).length > 0);
  assert.equal(mtNavCount(), '');
});

/* ───────────── the calendar: every call, from both tables ───────────── */
const bk = (o) => Object.assign({ id: 'bk-' + (++seq), created_at: '2026-11-20T09:00:00Z', name: 'Dana Smith', email: 'dana@acme.test', role: 'Founder', company: 'Acme Roofing', website: 'acme.test', industry: 'Roofing', budget: '$20k a job', goal: 'More booked calls', current_lead_gen: 'Referrals', capacity: '5 more a week', phone: '+1 555 0100', sells: 'Commercial roofs', tried_outbound: true, plan: null, call_at: '2026-11-27T16:00:00.000Z', minutes: 30, timezone: 'America/Chicago', source: 'website', status: 'booked', score: 72, meet_link: 'https://meet.google.com/abc-defg-hij', calendar_event_id: null, lost_reason: null, lost_at: null }, o);
const PRICES = [
  { plan: 'pilot', label: 'Pilot', calls_promised: 2, monthly_fee: 300, three_month_fee: null, is_recurring: false },
  { plan: 'starter', label: 'Starter', calls_promised: 5, monthly_fee: 1500, three_month_fee: 1200, is_recurring: true },
  { plan: 'growth', label: 'Growth', calls_promised: 10, monthly_fee: 3000, three_month_fee: 2400, is_recurring: true },
  { plan: 'scale', label: 'Scale', calls_promised: 15, monthly_fee: 4500, three_month_fee: 3600, is_recurring: true },
];
/* the month grid's cells, by date */
const cellOf = (html, key) => { const c = html.split('<div class="mt-cell').find((x) => x.includes("mtDayClick('" + key + "')")); return c || ''; };
/* the week grid's columns, Monday first */
const colsOf = (html) => html.slice(html.indexOf('mt-wk-body'), html.indexOf('class="mt-agenda"')).split('<div class="mt-wk-col').slice(1);

test('a website booking and a meeting both land on the calendar; booked and brief_sent both show; cancelled ones do not', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.clients.push({ id: 'c1', company: 'Northwind', contact_name: 'Ravi Perera', plan: 'growth' });
  db.discovery_bookings.push(
    bk({ id: 'b-booked', company: 'Booked Co', status: 'booked', call_at: '2026-11-25T15:00:00.000Z' }),
    bk({ id: 'b-brief', company: 'Brief Co', status: 'brief_sent', plan: 'pilot', call_at: '2026-11-26T15:00:00.000Z' }),
    bk({ id: 'b-gone', company: 'Gone Co', status: 'cancelled', call_at: '2026-11-26T16:00:00.000Z' }),
  );
  db.meetings.push(
    { id: 'm-strat', client_id: 'c1', kind: 'strategy', starts_at: '2026-11-27T15:00:00.000Z', minutes: 45, time_zone: 'America/New_York', status: 'booked' },
    { id: 'm-gone', client_id: 'c1', kind: 'review', starts_at: '2026-11-27T17:00:00.000Z', minutes: 30, status: 'cancelled' },
  );
  db.research_briefs.push({ booking_id: 'b-brief', brief: { summary: 'ok' } });

  const r = await mtCal('month', '2026-11-24');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.events.map((e) => e.key), ['booking:b-booked', 'booking:b-brief', 'meeting:m-strat'], 'both tables, soonest first, nothing cancelled');
  const [a, b, m] = r.data.events;
  // one shape for both
  for (const e of r.data.events) for (const f of ['key', 'source', 'id', 'startsAt', 'minutes', 'title', 'who', 'company', 'plan', 'status', 'meetLink', 'needsOutcome'])
    assert.ok(f in e, e.key + ' has ' + f);
  assert.deepEqual([a.source, a.title, a.plan, a.status, a.minutes], ['booking', 'Booked Co', '', 'booked', 30]);
  assert.deepEqual([b.source, b.title, b.plan, b.status, b.hasBrief], ['booking', 'Brief Co', 'pilot', 'brief_sent', true]);
  assert.deepEqual([m.source, m.title, m.who, m.plan, m.kindWord, m.minutes], ['meeting', 'Northwind', 'Ravi Perera', 'growth', 'Strategy', 45]);
  assert.equal(a.meetLink, 'https://meet.google.com/abc-defg-hij');

  mt.day = '2026-11-24';
  await mtLoadCal();
  const h = host('mtCalHost'), t = visible(h);
  for (const w of ['Booked Co', 'Brief Co', 'Northwind', 'Strategy']) assert.ok(t.includes(w), 'on the calendar: ' + w);
  assert.ok(!t.includes('Gone Co'), 'a cancelled booking is not drawn');
  assert.equal((h.match(/class="mt-chip mt-plan-/g) || []).length, 3, 'three chips, no more');
  assert.match(cellOf(h, '2026-11-25'), /8:30 pm<\/span><span class="mt-chip-n">Booked Co/, 'the chip reads "8:30 pm Booked Co"');
  assert.ok(!BROKEN.test(t), t);

  // the same in the week
  await mtSetView('week');
  const w = visible(host('mtCalHost'));
  for (const x of ['Booked Co', 'Brief Co', 'Northwind']) assert.ok(w.includes(x), 'in the week: ' + x);
  assert.ok(!w.includes('Gone Co'));

  // if the bookings cannot be read the calendar says so; it never quietly draws half of it
  fail['discovery_bookings'] = 'the bookings would not load';
  const bad = await mtCal('month', '2026-11-24');
  assert.equal(bad.ok, false); assert.equal(bad.error, 'the bookings would not load');
  delete fail['discovery_bookings'];
});

test('more than three calls in a day: three chips, then "+2 more", which opens that week', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  for (let i = 0; i < 5; i++) db.discovery_bookings.push(bk({ id: 'n' + i, company: 'Co ' + i, call_at: '2026-11-25T1' + i + ':00:00.000Z' }));
  mt.day = '2026-11-24'; await mtLoadCal();
  const cell = cellOf(host('mtCalHost'), '2026-11-25');
  assert.equal((cell.match(/class="mt-chip mt-plan-/g) || []).length, 3);
  assert.match(cell, /\+2 more/);
  assert.match(cell, /mtGoWeek\('2026-11-25'\)/);
  assert.match(cell, /<b>5<\/b>/, 'the phone shows the count');
  await mtGoWeek('2026-11-25');
  assert.equal(mt.view, 'week');
  assert.match(visible(host('mtCalHost')), /23 – 29 Nov 2026/);
  for (let i = 0; i < 5; i++) assert.ok(visible(host('mtCalHost')).includes('Co ' + i));
});

test('the month keeps the owner\'s days; the week is by business day: 16:00 UTC Friday and 01:00 UTC Saturday (8 pm ET Friday) are both in the FRIDAY column', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.discovery_bookings.push(
    bk({ id: 'fri', company: 'Friday Co', call_at: '2026-11-27T16:00:00.000Z' }),      // Fri 11:00 am ET · Fri 9:30 pm Colombo
    bk({ id: 'sat', company: 'Saturday Co', call_at: '2026-11-27T20:00:00.000Z' }),    // Fri 3:00 pm ET · SAT 1:30 am Colombo
    bk({ id: 'late', company: 'Late Co', call_at: '2026-11-28T01:00:00.000Z' }),       // Fri 8:00 pm ET · SAT 6:30 am Colombo
  );
  const r = await mtCal('week', '2026-11-24');
  const by = (id) => r.data.events.find((e) => e.id === id);
  const fri = by('fri'), sat = by('sat'), late = by('late');
  // the owner's day and time are still on every call (the month uses them) …
  assert.deepEqual([fri.dayKey, fri.time, mtWeekday(fri.dayKey)], ['2026-11-27', '9:30 pm', 5]);
  assert.deepEqual([sat.dayKey, sat.time, mtWeekday(sat.dayKey)], ['2026-11-28', '1:30 am', 6]);
  // … and so is the business day and the US Eastern time (the week uses those)
  assert.deepEqual([fri.usKey, fri.usTime, fri.bizMin], ['2026-11-27', '11:00 am', 660]);
  assert.deepEqual([sat.usKey, sat.usTime], ['2026-11-27', '3:00 pm']);
  assert.deepEqual([late.usKey, late.usTime, late.time, late.dayKey], ['2026-11-27', '8:00 pm', '6:30 am', '2026-11-28']);
  assert.equal(fri.both, '9:30 pm SL · 11:00 am ET');
  assert.deepEqual(r.data.keys, ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27'], 'five business days; no weekend column, because nothing falls on a US Saturday');
  assert.deepEqual(r.data.byDay['2026-11-27'].map((e) => e.id), ['fri', 'sat', 'late'], 'one unbroken Friday');
  assert.equal(r.data.byDay['2026-11-28'], undefined);

  // drawn: Friday is the fifth column and holds all three, each at its own time, placed by percentage
  mt.view = 'week'; mt.day = '2026-11-24'; await mtLoadCal();
  const h = host('mtCalHost'), cols = colsOf(h);
  assert.equal(cols.length, 5);
  for (const co of ['Friday Co', 'Saturday Co', 'Late Co']) { assert.ok(cols[4].includes(co), co + ' is in the Friday column'); assert.ok(!cols.slice(0, 4).join('').includes(co)); }
  assert.match(cols[4], /class="mt-ev [^"]*" style="top:28\.571%;--mt-h:3\.571%;left:0%;width:100%"[^>]*>(?:(?!<\/button>).)*Friday Co/, '11 am ET is 4 of the 14 hours down, and half an hour tall');
  assert.match(cols[4], /top:92\.857%;--mt-h:3\.571%[^>]*>(?:(?!<\/button>).)*Late Co/, '8 pm ET is 13 of the 14 hours down');
  // both times on the block, the owner's first, and both in its tooltip
  const block = cols[4].split('<button').find((x) => x.includes('Friday Co'));
  assert.match(block, /<small>9:30 pm<i> · 11:00 am ET<\/i><\/small>/);
  assert.match(block, /title="Fri 9:30 pm SL · Fri 11:00 am ET · Friday Co/);
  assert.match(cols[4].split('<button').find((x) => x.includes('Late Co')), /title="Sat 6:30 am SL · Fri 8:00 pm ET · Late Co/, 'the tooltip says which of the owner\'s days it is');
  // the column header: the US date, and the Sri Lanka dates it runs over
  const head = h.slice(h.indexOf('class="mt-wk-head"'), h.indexOf('class="mt-wk-body"'));
  assert.match(visible(head), /> SL ET Mon 23 Nov SL Mon 23 → Tue 24 Tue 24 Nov/);
  assert.match(visible(head), /Fri 27 Nov SL Fri 27 → Sat 28 <div$/);
  assert.ok(!/px/.test(h.slice(h.indexOf('class="mt-wk-body"'), h.indexOf('class="mt-agenda"'))), 'nothing in the grid is placed in pixels');

  // the month grid still puts them on the owner's days, the Sri Lanka time on the chip and both in the tooltip
  await mtSetView('month');
  const m = host('mtCalHost');
  assert.ok(cellOf(m, '2026-11-27').includes('Friday Co') && !cellOf(m, '2026-11-27').includes('Saturday Co'));
  assert.ok(cellOf(m, '2026-11-28').includes('Saturday Co'));
  assert.match(cellOf(m, '2026-11-28'), /<span class="mt-chip-t">1:30 am<\/span>/);
  assert.match(cellOf(m, '2026-11-28'), /title="Sat 1:30 am SL · Fri 3:00 pm ET · Saturday Co/);

  // a call on a US Saturday brings a Saturday column with it
  db.discovery_bookings.push(bk({ id: 'wk', company: 'Weekend Co', call_at: '2026-11-28T15:00:00.000Z' }));
  const w = await mtCal('week', '2026-11-24');
  assert.deepEqual(w.data.keys.slice(5), ['2026-11-28']);

  // the zones come from calendar_settings, not from this machine and not from an offset
  mtForget(); settingsRow({ owner_zone: 'America/Los_Angeles' }); at('2026-11-24T06:00:00.000Z');
  const la = (await mtCal('week', '2026-11-27')).data.events.find((e) => e.id === 'sat');
  assert.deepEqual([la.dayKey, la.time, la.ownerShort], ['2026-11-27', '12:00 pm', 'PT']);
});

test('the month grid: November 2026 starts on Monday 26 October and is whole weeks; the titles read like a calendar', async () => {
  const g = mtMonthGrid('2026-11');
  assert.equal(g.start, '2026-10-26'); assert.equal(mtWeekday(g.start), 1, 'a Monday');
  assert.equal(g.end, '2026-12-06'); assert.equal(mtWeekday(g.end), 0, 'a Sunday');
  assert.equal(g.keys.length % 7, 0); assert.equal(g.weeks, 6); assert.equal(g.keys.length, 42);
  assert.equal(g.keys[0], '2026-10-26'); assert.equal(g.keys[41], '2026-12-06');
  assert.deepEqual([mtMonthGrid('2027-02').start, mtMonthGrid('2027-02').end, mtMonthGrid('2027-02').weeks], ['2027-02-01', '2027-02-28', 4], 'a month that fits exactly gets no spare week');
  for (const ym of ['2026-01', '2026-02', '2026-08', '2026-12', '2028-02']) {
    const x = mtMonthGrid(ym);
    assert.equal(mtWeekday(x.keys[0]), 1, ym); assert.equal(x.keys.length % 7, 0, ym);
    assert.ok(x.keys.includes(ym + '-01') && x.keys.includes(x.last), ym);
  }
  assert.equal(mtMonthGrid('nonsense'), null);
  assert.equal(mtCalTitle('month', g.keys, '2026-11-24'), 'November 2026');
  assert.equal(mtCalTitle('week', mtWeekKeys('2026-11-24'), '2026-11-24'), '23 – 29 Nov 2026');
  assert.equal(mtCalTitle('week', mtWeekKeys('2026-12-01'), '2026-12-01'), '30 Nov – 6 Dec 2026');
  assert.equal(mtCalTitle('week', mtWeekKeys('2026-12-30'), '2026-12-30'), '28 Dec 2026 – 3 Jan 2027');

  // drawn: 42 cells, days from the months either side dimmed, today marked
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  mt.day = '2026-11-24'; await mtLoadCal();
  const h = host('mtCalHost');
  assert.equal((h.match(/<div class="mt-cell[ "]/g) || []).length, 42);
  // the month fits the window the same way the week does: six equal rows, no inner box that scrolls
  assert.match(h, /class="mt-month" id="mtMo" style="--mt-weeks:6"/);
  assert.ok(!/overflow-y/.test(h), 'no box inside the page that scrolls');
  assert.match(cellOf(h, '2026-10-26'), /^ out"/, 'October is dimmed');
  assert.match(cellOf(h, '2026-12-06'), /^ out"/, 'December is dimmed');
  assert.match(cellOf(h, '2026-11-24'), /^ today sel"/, 'today is marked');
  assert.match(cellOf(h, '2026-11-24'), /aria-current="date"/);
  assert.equal((h.match(/ today/g) || []).length, 1, 'only one day is today');

  // previous, next, today
  await mtCalMove(1);
  assert.match(visible(host('mtCalHost')), /December 2026/);
  await mtCalMove(-2);
  assert.match(visible(host('mtCalHost')), /October 2026/);
  await mtCalToday();
  assert.match(visible(host('mtCalHost')), /November 2026/); assert.equal(mt.day, '2026-11-24');
  await mtSetView('week'); await mtCalMove(1);
  assert.match(visible(host('mtCalHost')), /30 Nov – 6 Dec 2026/);
});

test('each plan has its own colour class and its own initial; no plan is neutral grey; a meeting takes its client\'s plan', async () => {
  const classes = ['pilot', 'starter', 'growth', 'scale'].map(mtPlanClass);
  assert.deepEqual(classes, ['mt-plan-pilot', 'mt-plan-starter', 'mt-plan-growth', 'mt-plan-scale']);
  assert.equal(new Set(classes).size, 4);
  assert.deepEqual(['pilot', 'starter', 'growth', 'scale'].map(mtPlanTag), ['P', 'S', 'G', 'Sc'], 'the initial tells them apart without colour');
  for (const none of [null, undefined, '', 'enterprise', 'constructor']) assert.equal(mtPlanClass(none), 'mt-plan-none', String(none));
  assert.equal(mtPlanClass('Growth'), 'mt-plan-growth');
  assert.equal(mtPlanWord(null), 'No plan yet');

  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.clients.push({ id: 'c1', company: 'Scale Client', plan: 'scale' }, { id: 'c2', company: 'Planless Client', plan: null });
  db.discovery_bookings.push(bk({ id: 'p', company: 'Pilot Co', plan: 'pilot', call_at: '2026-11-25T15:00:00.000Z' }), bk({ id: 'n', company: 'Undecided Co', plan: null, call_at: '2026-11-25T16:00:00.000Z' }));
  db.meetings.push(
    { id: 'm1', client_id: 'c1', kind: 'onboarding', starts_at: '2026-11-26T15:00:00.000Z', minutes: 30, status: 'booked' },
    { id: 'm2', client_id: 'c2', kind: 'review', starts_at: '2026-11-26T16:00:00.000Z', minutes: 30, status: 'booked' },
    { id: 'm3', client_id: null, kind: 'qualified', starts_at: '2026-11-26T17:00:00.000Z', minutes: 30, status: 'booked' },
  );
  const ev = (await mtCal('month', '2026-11-24')).data.events;
  const by = (id) => ev.find((e) => String(e.id) === id);
  assert.equal(by('p').planClass, 'mt-plan-pilot'); assert.equal(by('n').planClass, 'mt-plan-none');
  assert.equal(by('m1').planClass, 'mt-plan-scale'); assert.equal(by('m2').planClass, 'mt-plan-none'); assert.equal(by('m3').planClass, 'mt-plan-none');
  assert.deepEqual([by('m1').kindWord, by('m2').kindWord, by('m3').kindWord, by('p').kindWord], ['Onboarding', 'Review', 'Booked sales call', ''], 'a meeting carries its kind; a discovery call does not need one');
  mt.day = '2026-11-24'; await mtLoadCal();
  const h = host('mtCalHost');
  assert.match(h, /class="mt-chip mt-plan-pilot is-booking"[^>]*>.*?Pilot Co.*?<span class="mt-tagp" title="Pilot">P<\/span>/);
  assert.match(h, /class="mt-chip mt-plan-scale is-meeting"[^>]*>.*?Scale Client.*?<span class="mt-chip-k">Onboarding<\/span><span class="mt-tagp" title="Scale">Sc<\/span>/);
  assert.match(h, /class="mt-chip mt-plan-none is-booking"[^>]*>.*?Undecided Co/);

  // the colours themselves: defined once in meetings.css, light and dark, readable in both
  const css = fs.readFileSync(path.join(root, 'meetings.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const light = css.slice(css.indexOf(':root{'), css.indexOf('}', css.indexOf(':root{')));
  const darkAt = css.indexOf('body.dark,:root[data-theme="dark"]{');
  assert.ok(darkAt > 0, 'the dark theme has its own values');
  const dark = css.slice(darkAt, css.indexOf('}', darkAt));
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
  for (const [name, block] of [['light', light], ['dark', dark]]) {
    const v = {}; for (const m of block.matchAll(/--mt-([a-z]+)-(bg|bar|ink):(#[0-9A-Fa-f]{6})/g)) v[m[1] + '-' + m[2]] = m[3];
    assert.equal(Object.keys(v).length, 15, name + ': five plans, three colours each');
    const bgs = ['pilot', 'starter', 'growth', 'scale', 'none'].map((p2) => v[p2 + '-bg'].toUpperCase());
    assert.equal(new Set(bgs).size, 5, name + ': five different tints');
    const bars = ['pilot', 'starter', 'growth', 'scale', 'none'].map((p2) => v[p2 + '-bar'].toUpperCase());
    assert.equal(new Set(bars).size, 5, name + ': five different bars');
    for (const p2 of ['pilot', 'starter', 'growth', 'scale', 'none']) {
      assert.ok(ratio(v[p2 + '-ink'], v[p2 + '-bg']) >= 4.5, `${name} ${p2}: text on tint is ${ratio(v[p2 + '-ink'], v[p2 + '-bg']).toFixed(2)}:1`);
      assert.ok(ratio(v[p2 + '-bar'], v[p2 + '-bg']) >= 2.5, `${name} ${p2}: the bar stands out from the tint (${ratio(v[p2 + '-bar'], v[p2 + '-bg']).toFixed(2)}:1)`);
    }
  }
  for (const p2 of ['pilot', 'starter', 'growth', 'scale', 'none']) assert.ok(css.includes('.mt-plan-' + p2 + '{'), 'a class for ' + p2);
  assert.equal((css.match(/--mt-pilot-bg:/g) || []).length, 2, 'defined once per theme, nowhere else');
});

test('needs an outcome: flagged on the call, counted above the grid, and the count filters to them', async () => {
  settingsRow(); at('2026-11-25T12:00:00.000Z');
  db.discovery_bookings.push(
    bk({ id: 'late', company: 'Late Co', status: 'brief_sent', call_at: '2026-11-25T10:00:00.000Z' }),      // 2 hours ago, nothing recorded
    bk({ id: 'fresh', company: 'Fresh Co', status: 'booked', call_at: '2026-11-25T11:50:00.000Z' }),         // 10 minutes ago: still in grace
    bk({ id: 'done', company: 'Done Co', status: 'held', call_at: '2026-11-24T10:00:00.000Z' }),             // marked done
    bk({ id: 'won', company: 'Won Co', status: 'won', call_at: '2026-11-24T11:00:00.000Z' }),
    bk({ id: 'soon', company: 'Soon Co', status: 'booked', call_at: '2026-11-26T10:00:00.000Z' }),
  );
  db.meetings.push(
    { id: 'm-late', kind: 'review', starts_at: '2026-11-24T15:00:00.000Z', minutes: 30, status: 'booked' },   // yesterday, still "booked"
    { id: 'm-held', kind: 'review', starts_at: '2026-11-24T16:00:00.000Z', minutes: 30, status: 'held' },
  );
  const r = await mtCal('month', '2026-11-25');
  const need = r.data.events.filter((e) => e.needsOutcome).map((e) => e.key).sort();
  assert.deepEqual(need, ['booking:late', 'meeting:m-late']);
  assert.equal(r.data.need, 2);
  assert.equal(mtMeetingNeedsOutcome({ starts_at: '2026-11-25T11:50:00.000Z', status: 'booked' }), false, 'inside the 20 minutes');
  assert.equal(mtMeetingNeedsOutcome({ starts_at: '2026-11-25T11:39:00.000Z', status: 'booked' }), true);
  assert.equal(mtMeetingNeedsOutcome({ starts_at: '2026-11-25T10:00:00.000Z', status: 'no_show' }), false);

  mt.day = '2026-11-25'; await mtLoadCal();
  let h = host('mtCalHost');
  assert.match(visible(h), /2 need an outcome/);
  assert.match(h, /class="mt-chip mt-plan-none need is-booking"[^>]*>.*?Late Co/, 'the chip is flagged');
  assert.ok(!/need is-booking"[^>]*>(?:(?!<\/button>).)*Fresh Co/.test(h), 'a call ten minutes old is not');
  assert.match(h, /aria-label="[^"]*Late Co[^"]*needs an outcome"/, 'and it says so in words, not only in red');
  assert.equal(mtNavCount(), 2, 'the sidebar badge counts the same two');

  mtToggleNeed();
  h = host('mtCalHost');
  const t = visible(h);
  assert.ok(t.includes('Late Co') && !t.includes('Soon Co') && !t.includes('Done Co') && !t.includes('Won Co') && !t.includes('Fresh Co'), 'only the two that are waiting');
  assert.equal((h.match(/class="mt-chip mt-plan-/g) || []).length, 2);
  assert.match(t, /Showing only the 2 that need an outcome — show every call/);
  mtToggleNeed();
  assert.ok(visible(host('mtCalHost')).includes('Soon Co'), 'and back');

  // recording the outcome clears the flag and the count
  await plMarkHeld('late');
  await mtHeldClick('m-late');
  assert.equal(mt.cal.need, 0);
  assert.equal(mtNavCount(), '');
  assert.ok(!/need an outcome —|\d+ needs? an outcome/.test(visible(host('mtCalHost'))));
});

/* ───────────── the week grid ───────────── */
test('the week grid: only the hours calls can happen, both clocks down the side, a hatched block you can remove, a now line, and free times that open the form', async () => {
  settingsRow(); at('2026-11-24T16:30:00.000Z');            // Tuesday 11:30 am Eastern · 10:00 pm in Colombo
  db.discovery_bookings.push(bk({ id: 'b1', company: 'Acme Roofing', plan: 'starter', call_at: '2026-11-25T15:00:00.000Z' }));   // Wed 10 am ET
  db.calendar_blocks.push({ id: 'blk1', starts_at: '2026-11-25T18:00:00.000Z', ends_at: '2026-11-25T19:30:00.000Z', reason: 'dentist' });   // Wed 1:00–2:30 pm ET
  mt.view = 'week'; mt.day = '2026-11-24'; await mtLoadCal();
  const h = host('mtCalHost'), cols = colsOf(h);
  // 14 rows — 7 am to 9 pm Eastern — never 24
  assert.match(h, /class="mt-wk" id="mtWk" style="--mt-rows:14;--mt-n:5"/);
  assert.equal(mt.cal.win.rows, 14);
  const axis = (cls) => visible(h.slice(h.indexOf('class="mt-wk-axis ' + cls), h.indexOf('</div>', h.indexOf('class="mt-wk-axis ' + cls))).replace(/^[^>]*>/, ''));
  assert.equal(axis('mt-ax-own'), '5:30 pm 6:30 pm 7:30 pm 8:30 pm 9:30 pm 10:30 pm 11:30 pm 12:30 am 1:30 am 2:30 am 3:30 am 4:30 am 5:30 am 6:30 am');
  assert.equal(axis('mt-ax-us'), '7 am 8 am 9 am 10 am 11 am 12 pm 1 pm 2 pm 3 pm 4 pm 5 pm 6 pm 7 pm 8 pm');
  assert.match(h, /<span class="mt-wk-zh" title="Sri Lanka time">SL<\/span><span class="mt-wk-zh" title="US Eastern time">ET<\/span>/, 'the two time columns are headed SL and ET');
  assert.equal((h.match(/class="mt-wk-axis /g) || []).length, 2);
  assert.ok(!h.includes('mtWkScroll') && !/overflow-y/.test(h), 'no box inside the page that scrolls');
  assert.match(cols[1], /^ today"/, 'Tuesday is today');
  assert.match(cols[1], /class="mt-now" style="top:32\.143%"/, 'the now line sits at 11:30 am Eastern: 4.5 of 14 hours down');
  assert.equal((h.match(/class="mt-now"/g) || []).length, 1);
  // the block is one band in one column — a business day is never cut in two
  assert.match(cols[2], /class="mt-blk mt-hatch" style="top:42\.857%;height:10\.714%"/);
  assert.equal((h.match(/class="mt-blk mt-hatch"/g) || []).length, 1);
  assert.match(cols[2], /Blocked · dentist/); assert.match(cols[2], /mtUnblockClick\('blk1'\)/);
  // free times are there to click, never where the booking or the block is, and they open the one form
  const free = [...h.matchAll(/class="mt-free"[^>]*onclick="event\.stopPropagation\(\);mtAddAt\('([^']+)'\)"/g)].map((m) => m[1]);
  assert.ok(free.length > 50, 'a working week of free times');
  assert.ok(!free.includes('2026-11-25T15:00:00.000Z'), 'the booked time is not offered');
  assert.ok(!free.includes('2026-11-25T18:00:00.000Z') && !free.includes('2026-11-25T19:00:00.000Z'), 'nor the blocked ones');
  assert.ok(free.includes('2026-11-25T15:30:00.000Z'));
  assert.match(h, /title="Free — 9:00 pm SL · 10:30 am ET\. Click to add a meeting\."/);
  mtAddAt('2026-11-25T15:30:00.000Z');
  let f = host('modal');
  assert.match(visible(f), /Add meeting/);
  assert.match(f, /id="mtAddDate" type="date" value="2026-11-25"/); assert.match(f, /id="mtAddTime" type="time" step="300" value="21:00"/, 'the time is typed in Sri Lanka time');
  assert.match(f, /<output id="mtAddEt"[^>]*>Wed 25 Nov · 10:30 am<\/output>/, 'with the Eastern time beside it');
  assert.match(visible(f), /This time will also be taken off your public booking page\./);
  // a click on empty time in a column works out the slot under the pointer
  const colEl = { getBoundingClientRect: () => ({ top: 100, height: 700 }) };
  mtColClick({ clientY: 100 + 700 * (4.6 / 14), currentTarget: colEl, target: colEl }, '2026-11-26');   // 4.6 hours down Thursday: 11:36 am ET → the 11:30 slot
  f = host('modal');
  assert.match(f, /id="mtAddDate" type="date" value="2026-11-26"/); assert.match(f, /id="mtAddTime" type="time" step="300" value="22:00"/);
  assert.match(f, /Thu 26 Nov · 11:30 am/);
  assert.equal(mtColClick({ clientY: 0, currentTarget: colEl }, 'not-a-day'), null);
  // a day in the month opens the same form on that date
  mtCellTap('2026-12-03');
  assert.match(host('modal'), /id="mtAddDate" type="date" value="2026-12-03"/);
  // unblocking redraws without the band
  await mtUnblockClick('blk1');
  assert.ok(!host('mtCalHost').includes('mt-blk mt-hatch'));
  // the form for a new block speaks the owner's time
  mtOpenBlock();
  assert.match(visible(host('modal')), /Times are Sri Lanka time/);
  el('mtBlkFrom').value = '2026-11-26T22:00'; el('mtBlkTo').value = '2026-11-26T23:00'; el('mtBlkWhy').value = 'school';
  const blocked = await mtSubmitBlock();
  assert.equal(blocked.ok, true);
  assert.equal(db.calendar_blocks[0].starts_at, '2026-11-26T16:30:00.000Z', '10 pm in Colombo');

  // the stylesheet: the grid's height comes from the window, its rows are equal shares, and nothing inside it scrolls
  const css = fs.readFileSync(path.join(root, 'meetings.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const wk = css.slice(css.indexOf('.mt-wk{'), css.indexOf('}', css.indexOf('.mt-wk{')));
  assert.match(wk, /height:calc\(100dvh - var\(--mt-top,\d+px\)\)/);
  const minRow = Number(/min-height:calc\((\d+)px \+ var\(--mt-rows,14\)\*(\d+)px\)/.exec(wk)[2]), minHead = Number(/min-height:calc\((\d+)px/.exec(wk)[1]);
  assert.ok(minHead + 14 * minRow <= 450, 'fourteen hours fit well inside a 700px-tall window');
  assert.match(css, /\.mt-wk-axis\{[^}]*grid-template-rows:repeat\(var\(--mt-rows,14\),minmax\(0,1fr\)\)/);
  assert.match(css, /\.mt-wk-col\{[^}]*background-size:100% calc\(100% \/ var\(--mt-rows,14\)\)/);
  const week = css.slice(css.indexOf('.mt-wk{'), css.indexOf('.mt-agenda{display:none}'));
  assert.ok(!/overflow-y|overflow:auto|overflow:scroll|max-height/.test(week), 'the week has no scroller of its own');
  assert.match(css, /\.mt-ev\{[^}]*height:var\(--mt-h\)/);
  assert.match(css, /\.mt-ev:hover,\.mt-ev:focus-visible\{[^}]*height:auto;min-height:var\(--mt-h\)/, 'a short call opens out to show its times when pointed at');
});

test('the hours the week shows come from calendar_settings, in both zones, through Intl: November and July differ by an hour on the Sri Lanka side', async () => {
  settingsRow();
  const st = (await mtSettings()).data;
  const nov = mtHourWindow(st, '2026-11-23', []);
  assert.deepEqual([nov.startMin, nov.endMin, nov.rows], [420, 1260, 14]);
  assert.deepEqual([nov.fromUs, nov.toUs, nov.fromOwner, nov.toOwner], ['7 am', '9 pm', '5:30 pm', '7:30 am'], 'EST: 7 am–9 pm is 5:30 pm–7:30 am in Colombo');
  assert.deepEqual(nov.hours[4], { min: 660, us: '11 am', owner: '9:30 pm' });
  assert.deepEqual([nov.usShort, nov.ownerShort], ['ET', 'SL']);
  const jul = mtHourWindow(st, '2026-07-06', []);
  assert.deepEqual([jul.fromUs, jul.toUs, jul.fromOwner, jul.toOwner], ['7 am', '9 pm', '4:30 pm', '6:30 am'], 'EDT: the same US hours are an hour earlier in Colombo');
  assert.deepEqual(jul.hours.map((x) => x.owner).slice(0, 3), ['4:30 pm', '5:30 pm', '6:30 pm']);
  assert.equal(jul.rows, 14);
  // other rules, other hours — nothing is hard-coded
  const odd = mtHourWindow(mtCleanSettings({ open_time: '09:30', close_time: '12:15', us_zone: 'America/Chicago', owner_zone: 'Europe/London' }), '2026-11-23', []);
  assert.deepEqual([odd.startMin, odd.endMin, odd.rows, odd.fromUs, odd.fromOwner, odd.usShort], [540, 780, 4, '9 am', '3 pm', 'CT']);
  assert.ok(odd.ownerShort.length > 0 && !BROKEN.test(odd.ownerShort), 'a zone with no short name of ours takes Intl\'s');
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/[+-]\s*5\.5\b|330\s*\*\s*60|19800|GMT\+5|UTC\+5/.test(code), 'no fixed Sri Lanka offset anywhere');

  // it widens — to whole hours — only as far as something outside it needs
  assert.deepEqual([mtHourWindow(st, '2026-11-23', [[390, 420]]).startMin, mtHourWindow(st, '2026-11-23', [[390, 420]]).rows], [360, 15]);
  assert.deepEqual([mtHourWindow(st, '2026-11-23', [[1290, 1335]]).endMin, mtHourWindow(st, '2026-11-23', [[1290, 1335]]).toUs], [1380, '11 pm']);
  assert.deepEqual([mtHourWindow(st, '2026-11-23', [[0, 1440]]).rows, mtHourWindow(st, '2026-11-23', [[600, 630]]).rows], [24, 14]);

  // drawn from real rows: a hand-added meeting at 5:15 am Eastern on Tuesday stretches the week to start at 5 am
  at('2026-11-23T05:00:00.000Z');
  db.meetings.push({ id: 'early', kind: 'other', title: 'Early bird', starts_at: '2026-11-24T10:15:00.000Z', minutes: 30, status: 'booked' });
  let r = await mtCal('week', '2026-11-24');
  assert.deepEqual([r.data.win.startMin, r.data.win.endMin, r.data.win.rows, r.data.win.fromOwner, r.data.win.fromUs], [300, 1260, 16, '3:30 pm', '5 am']);
  assert.equal(r.data.cols[1].start, Date.parse('2026-11-24T10:00:00.000Z'), 'every column starts at 5 am Eastern');
  mt.view = 'week'; mt.day = '2026-11-24'; await mtLoadCal();
  assert.match(host('mtCalHost'), /style="--mt-rows:16;--mt-n:5"/);
  assert.match(colsOf(host('mtCalHost'))[1], /style="top:1\.563%;--mt-h:3\.125%[^>]*>(?:(?!<\/button>).)*Early bird/);
  // a block outside the hours widens it too; a block of whole days off does not turn the week into 24-hour columns
  db.meetings = [];
  db.calendar_blocks.push({ id: 'late', starts_at: '2026-11-26T02:00:00.000Z', ends_at: '2026-11-26T03:30:00.000Z', reason: 'late' });   // Wed 9:00–10:30 pm ET
  r = await mtCal('week', '2026-11-24');
  assert.deepEqual([r.data.win.startMin, r.data.win.endMin], [420, 1380]);
  db.calendar_blocks = [{ id: 'away', starts_at: '2026-11-25T00:00:00.000Z', ends_at: '2026-11-28T00:00:00.000Z', reason: 'away' }];
  r = await mtCal('week', '2026-11-24');
  assert.deepEqual([r.data.win.startMin, r.data.win.endMin, r.data.keys.length], [420, 1260, 5]);
  mt.view = 'week'; mt.day = '2026-11-24'; await mtLoadCal();
  assert.equal((host('mtCalHost').match(/class="mt-blk mt-hatch"/g) || []).length, 4, 'the days off are still hatched, clipped to the hours shown');
  // July, drawn: the same 14 rows, an hour earlier down the Sri Lanka side
  db.calendar_blocks = []; at('2026-07-06T05:00:00.000Z');
  mt.day = '2026-07-07'; await mtLoadCal();
  assert.match(visible(host('mtCalHost')), /SL ET Mon 6 Jul SL Mon 6 → Tue 7/);
  assert.match(host('mtCalHost'), /class="mt-wk-axis mt-ax-own"[^>]*><span>4:30 pm<\/span>/);
});

test('two calls at the same time sit side by side, not on top of each other', () => {
  const lanes = mtLanes([{ minuteOfDay: 600, minutes: 30 }, { minuteOfDay: 600, minutes: 30 }, { minuteOfDay: 615, minutes: 30 }, { minuteOfDay: 700, minutes: 30 }]);
  assert.deepEqual(lanes.map((l) => [l.lane, l.lanes]), [[0, 3], [1, 3], [2, 3], [0, 1]]);
  assert.deepEqual(mtLanes([]), []); assert.deepEqual(mtLanes(null), []);
});

/* ───────────── the slot finder and website bookings ───────────── */
test('a website booking holds its time: the hub never offers it, books over it or blocks over it', async () => {
  settingsRow(); at('2026-11-23T05:00:00Z');
  db.discovery_bookings.push(bk({ id: 'web1', status: 'brief_sent', call_at: '2026-11-23T14:00:00.000Z', minutes: 30 }));
  const r = await mtSlots('2026-11-23');
  assert.equal(r.ok, true);
  assert.ok(!r.data.map((s) => s.us).includes('9:00 am'), 'the website booking at 9 am Eastern is gone from the list');
  assert.ok(r.data.map((s) => s.us).includes('9:30 am'));
  assert.equal(r.data.length, 27);
  const over = await mtBook({ kind: 'strategy', startsAt: '2026-11-23T14:00:00.000Z' });
  assert.equal(over.ok, false); assert.match(over.error, /already taken by another call\.$/);
  assert.equal(db.meetings.length, 0, 'nothing was written');
  const blk = await mtBlock('2026-11-23T13:30:00.000Z', '2026-11-23T14:30:00.000Z', 'lunch');
  assert.equal(blk.ok, false); assert.match(blk.error, /already a call in that time/);
  // moving a meeting onto it is refused too
  const m = await mtBook({ kind: 'strategy', startsAt: '2026-11-23T16:00:00.000Z' });
  const moved = await mtReschedule(m.data.id, '2026-11-23T14:00:00.000Z');
  assert.equal(moved.ok, false); assert.match(moved.error, /already taken/);
  // every status but cancelled holds the time — won, lost, anything the research engine writes
  for (const s of ['booked', 'held', 'no_show', 'won', 'lost', 'whatever_next']) {
    db.discovery_bookings[0].status = s;
    assert.ok(!(await mtSlots('2026-11-23')).data.map((x) => x.us).includes('9:00 am'), s + ' still holds 9 am');
  }
  db.discovery_bookings[0].status = 'cancelled';
  assert.ok((await mtSlots('2026-11-23')).data.map((x) => x.us).includes('9:00 am'), 'a cancelled booking frees its time');
  // and if the bookings cannot be read, no time is offered on a guess
  fail['discovery_bookings'] = 'no answer';
  const blind = await mtSlots('2026-11-23');
  assert.equal(blind.ok, false); assert.equal(blind.error, 'no answer');
  assert.equal((await mtBook({ kind: 'strategy', startsAt: '2026-11-23T18:00:00.000Z' })).ok, false);
  delete fail['discovery_bookings'];
});

/* ───────────── click a call: the panel ───────────── */
test('a website booking\'s panel: who, plan, both clocks, the link, their answers — with no brief, and with a brief of any shape', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.plan_prices = PRICES.map((p) => Object.assign({}, p));
  db.discovery_bookings.push(bk({ id: 'b1', plan: 'growth', status: 'brief_sent' }));
  await mtOpenEvent('booking:b1');
  let h = host('modal'), t = visible(h);
  for (const w of ['Acme Roofing', 'Dana Smith · Founder', 'G · Growth', 'Call booked', 'Score 72', '30 minutes',
    'Fri 27 Nov · 9:30 pm Sri Lanka', 'Fri 27 Nov · 10:00 am US Central — their time',
    'Fri 27 Nov · 11:00 am US Eastern', 'Join the call', 'Copy the link', 'Research not ready yet', 'Research this one',
    'Commercial roofs', '$20k a job', 'Referrals', '5 more a week', '+1 555 0100', 'Tried outbound before', 'More booked calls',
    'Call done', 'Nobody came', 'Won', 'Lost'])
    assert.ok(t.includes(w), 'the panel shows: ' + w);
  assert.match(h, /href="https:\/\/meet\.google\.com\/abc-defg-hij"/);
  assert.match(h, /href="https:\/\/acme\.test\/"/, 'the company links to their website');
  assert.match(h, /mtCopy\('https:\/\/meet\.google\.com\/abc-defg-hij'\)/);
  assert.match(h, /value="growth" selected/, 'the plan they picked is already chosen for Won');
  assert.ok(h.includes('plMarkWon(') && h.includes('plMarkLost(') && h.includes('plMarkNoShow(') && h.includes('plMarkHeld('));
  assert.ok(!BROKEN.test(t), t);
  assert.equal(await mtCopy('https://meet.google.com/abc-defg-hij'), true);
  assert.ok(toasts.includes('Link copied'));

  // a brief of whatever shape the research engine wrote, and none of them throws
  const odd = [{ summary: 'Roofer, spends on ads', angles: ['storm season'] }, 'just a paragraph of text', 42, true, [], {}, [1, [2, [3, [4]]]], [{ title: 'One', body: { deep: { deeper: { deepest: 'x' } } } }, null],
    { a: null, b: undefined, c: '', d: { e: [] } }, { 'weird key!': [{}, [], null] }, null];
  for (const brief of odd) {
    db.research_briefs = [{ booking_id: 'b1', brief }];
    const r = await mtOpenBooking('b1');
    assert.equal(r.ok, true);
    const text = visible(host('modal'));
    assert.ok(text.includes('Acme Roofing') && text.includes('What they told us'), 'still a whole panel for ' + JSON.stringify(brief));
    assert.ok(!BROKEN.test(text), JSON.stringify(brief) + ' → ' + text);
  }
  db.research_briefs = [{ booking_id: 'b1' }];                 // a row with no brief column at all
  assert.equal((await mtOpenBooking('b1')).ok, true);
  db.research_briefs = [{ booking_id: 'b1', brief: { summary: 'Roofer, spends on ads' } }];
  await mtOpenBooking('b1');
  assert.match(visible(host('modal')), /Brief ready/); assert.match(visible(host('modal')), /Roofer, spends on ads/);
  for (const d of [null, undefined, {}, { booking: null }, { booking: { id: 'x' } }, { booking: { id: 'x', call_at: 'not a date', timezone: 'Mars/Phobos', meet_link: 'javascript:alert(1)', website: '<script>' }, sections: 'nope', research: 7, answers: null }])
    assert.doesNotThrow(() => mtRenderBookingPanel(d, mtSettingsNow()), JSON.stringify(d));
  assert.ok(!mtRenderBookingPanel({ booking: { id: 'x', meet_link: 'javascript:alert(1)' } }).includes('javascript:'), 'only a real link becomes a Join button');
  // their time falls back to the US zone when the booking has none
  db.discovery_bookings[0].timezone = null;
  await mtOpenBooking('b1');
  assert.match(visible(host('modal')), /Fri 27 Nov · 11:00 am US Eastern — their time/);

  // everything a person typed is escaped, on the calendar and in the panel
  db.discovery_bookings.push(bk({ id: 'x', company: '<b>Bad</b>', name: '<i>x</i>', goal: '<img src=x>', call_at: '2026-11-26T15:00:00.000Z' }));
  mt.day = '2026-11-24'; await mtLoadCal(); await mtOpenBooking('x');
  for (const html of [host('mtCalHost'), host('modal')]) {
    assert.ok(!html.includes('<b>Bad</b>') && html.includes('&lt;b&gt;Bad'), 'escaped');
    assert.ok(!/<img|<i>x/.test(html));
  }
});

test('the panel\'s buttons go through pipeline.js, and the calendar and the panel both show the new state', async () => {
  settingsRow(); at('2026-11-28T06:00:00.000Z');              // the morning after the call
  db.plan_prices = PRICES.map((p) => Object.assign({}, p));
  db.discovery_bookings.push(
    bk({ id: 'b1', company: 'Acme Roofing', status: 'brief_sent' }),
    bk({ id: 'b2', company: 'Beta Co', call_at: '2026-11-27T17:00:00.000Z' }),
    bk({ id: 'b3', company: 'Gamma Co', call_at: '2026-11-27T18:00:00.000Z' }),
  );
  authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' };
  mt.day = '2026-11-27'; await mtLoadCal();
  assert.equal(mt.cal.need, 3);

  // call done
  await mtOpenEvent('booking:b1');
  let r = await plMarkHeld('b1');
  assert.equal(r.ok, true); assert.equal(db.discovery_bookings[0].status, 'held');
  assert.match(visible(host('modal')), /The call is marked as done\. Did they buy\?/, 'the panel shows the new state');
  assert.ok(!host('modal').includes('plMarkHeld('), 'and no longer offers Call done');
  assert.equal(mt.cal.need, 2, 'the calendar was read again');
  assert.equal(mt.cal.events.find((e) => e.id === 'b1').statusWord, 'Call done');

  // won needs a plan; the price comes from plan_prices; a second client is refused
  el('plPlan').value = ''; el('plTerm').value = '3month';
  r = await plMarkWon('b1');
  assert.equal(r.ok, false); assert.match(r.error, /Pick the plan/); assert.equal(db.clients.length, 0);
  el('plPlan').value = 'growth';
  assert.ok(host('modal').includes('onclick="plOpenWon()"') && /Mark won and send the pack/.test(visible(host('modal'))), 'Won opens the plan picker in the panel');
  toasts.length = 0;
  r = await plMarkWon('b1');
  assert.equal(r.ok, true);
  assert.deepEqual(rpcs.at(-1), { name: 'close_won', args: { p_booking: 'b1', p_plan: 'growth', p_term: '3month' } });
  assert.ok(toasts.some((m) => /^Won\. The agreement and invoice are on their way to \S+@\S+\.$/.test(m)), toasts.join(' | '));
  assert.deepEqual([db.clients[0].plan, db.clients[0].term, db.clients[0].calls_promised, db.clients[0].monthly_fee, db.clients[0].booking_id], ['growth', '3month', 10, 2400, 'b1']);
  assert.equal(db.discovery_bookings[0].status, 'won');
  assert.match(visible(host('modal')), /Won — they are a client/);
  assert.ok(!host('modal').includes('plMarkWon('), 'a won booking offers no second client');
  r = await plWon('b1', { plan: 'scale' });
  assert.equal(r.ok, false); assert.match(r.error, /already a client/); assert.equal(db.clients.length, 1);
  assert.equal(mt.cal.events.find((e) => e.id === 'b1').statusWord, 'Won');

  // lost must name one of the fixed reasons
  await mtOpenEvent('booking:b2');
  el('plLossReason').value = '';
  r = await plMarkLost('b2');
  assert.equal(r.ok, false); assert.match(r.error, /Pick why we lost them/);
  assert.equal(db.discovery_bookings[1].status, 'booked', 'nothing was written');
  el('plLossReason').value = 'too_dear';
  assert.equal((await plMarkLost('b2')).ok, false, 'a made-up reason is refused');
  el('plLossReason').value = 'price';
  r = await plMarkLost('b2');
  assert.equal(r.ok, true);
  assert.deepEqual([db.discovery_bookings[1].status, db.discovery_bookings[1].lost_reason], ['lost', 'price']);
  assert.match(visible(host('modal')), /Lost Too expensive/);

  // nobody came
  await mtOpenEvent('booking:b3');
  r = await plMarkNoShow('b3');
  assert.equal(r.ok, true); assert.equal(db.discovery_bookings[2].status, 'no_show');
  assert.match(visible(host('modal')), /Marked as nobody came/);
  assert.equal(mt.cal.need, 0);
  assert.ok(toasts.every((m) => typeof m === 'string' && m.length && !BROKEN.test(m)), 'plain words every time');
  // the calendar never writes a booking's outcome itself
  assert.ok(!/from\('discovery_bookings'\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/.test(SRC), 'meetings.js only reads discovery_bookings');
});

test('a meeting\'s panel keeps what the meeting page offers: done, no-show, cancel, move, the reminders', async () => {
  settingsRow(); at('2026-11-23T05:00:00Z');
  db.clients.push({ id: 'c1', company: 'Northwind', contact_name: 'Ravi Perera', plan: 'starter' });
  db.meetings.push({ id: 'm1', client_id: 'c1', kind: 'strategy', starts_at: '2026-11-23T15:00:00.000Z', minutes: 30, time_zone: 'America/Chicago', status: 'booked', meet_link: 'https://meet.example.com/abc', reminded_24h_at: '2026-11-22T15:00:00.000Z', reminded_1h_at: null, notes: '<b>hi</b>' });
  mt.view = 'week'; mt.day = '2026-11-23'; await mtLoadCal();
  await mtOpenEvent('meeting:m1');
  let h = host('modal'), t = visible(h);
  for (const w of ['Northwind', 'Ravi Perera', 'Strategy call', 'S · Starter', 'Mon 23 Nov · 8:30 pm Sri Lanka', 'Mon 23 Nov · 9:00 am US Central — their time', 'Mon 23 Nov · 10:00 am US Eastern',
    '30 minutes', 'Join the call', 'Copy the link', '24 hours before: sent Sun 22 Nov · 8:30 pm Sri Lanka', '1 hour before: not sent yet', 'Call done', 'No-show', 'Cancel', 'Move the call'])
    assert.ok(t.includes(w), 'the panel shows: ' + w);
  assert.ok(!h.includes('<b>hi</b>') && h.includes('&lt;b&gt;hi'), 'escaped');

  // move: a wall clock in the owner's zone
  el('mtMoveTo').value = '';
  let r = await mtMoveClick('m1');
  assert.equal(r.ok, false); assert.match(r.error, /Pick the new day and time/);
  el('mtMoveTo').value = '2026-11-24T21:30';                 // Tuesday 9:30 pm Colombo = 11 am Eastern
  r = await mtMoveClick('m1');
  assert.equal(r.ok, true);
  assert.equal(db.meetings[0].starts_at, '2026-11-24T16:00:00.000Z');
  assert.equal(db.meetings[0].reminded_24h_at, null, 'the reminders go out again');
  assert.match(visible(host('modal')), /Tue 24 Nov · 9:30 pm Sri Lanka/, 'the panel shows the new time');
  assert.equal(mt.cal.events[0].dayKey, '2026-11-24', 'and so does the calendar');
  el('mtMoveTo').value = '2026-11-24T10:00';                 // 11:30 pm Eastern the night before: outside call hours
  r = await mtMoveClick('m1');
  assert.equal(r.ok, false); assert.match(r.error, /outside your call hours/);

  // done
  at('2026-11-24T18:00:00.000Z');
  r = await mtHeldClick('m1');
  assert.equal(r.ok, true); assert.equal(db.meetings[0].status, 'held');
  assert.match(visible(host('modal')), /Call done/);
  assert.ok(!host('modal').includes('mtHeldClick('), 'no buttons once it is decided');
  assert.equal(mt.cal.events[0].statusWord, 'Call done');
  // cancel takes it off the calendar
  db.meetings.push({ id: 'm2', kind: 'review', starts_at: '2026-11-26T15:00:00.000Z', minutes: 30, status: 'booked' });
  await mtLoadCal(); await mtOpenEvent('meeting:m2');
  assert.match(visible(host('modal')), /No client on this one/);
  await mtCancelClick('m2', 'they asked');
  assert.equal(db.meetings[1].status, 'cancelled');
  assert.deepEqual(mt.cal.events.map((e) => e.id), ['m1'], 'a cancelled call is not drawn');
  // the meeting page itself still works, with the same things on it
  await mtLoadMeeting('m1');
  assert.match(visible(host('mtOneHost')), /Tue 24 Nov · 9:30 pm Sri Lanka/);
  assert.match(host('mtOneHost'), /href="https:\/\/meet\.example\.com\/abc"/);
});

/* ───────────── no Bookings tab; old links still land ───────────── */
test('the Bookings tab is gone, the Funnel is reached from the Calendar, and an old booking link opens the Calendar on that booking', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' };
  const items = navItems();
  assert.ok(!items.some((i) => /booking/i.test(i.label)), 'no Bookings item');
  assert.ok(!items.some((i) => i.view === 'enquiries' || i.view === 'enquiry'));
  const cal = items.find((i) => i.view === 'calendar');
  assert.ok(cal && cal.also.includes('funnel') && cal.also.includes('meeting'), 'the Calendar owns the funnel and the meeting page');
  assert.ok(items.some((i) => i.view === 'channels') && items.some((i) => i.view === 'clients'), 'everything else is still there');
  assert.equal(views.enquiries, undefined); assert.equal(views.enquiry, undefined);
  assert.equal(typeof views.funnel.fn, 'function');
  assert.match(String(views.funnel.back), /render\('calendar'\)/, 'Back from the funnel goes to the Calendar');
  // the toolbar has the Funnel button, and it goes to the funnel route
  mt.day = '2026-11-24'; await mtLoadCal();
  assert.match(host('mtCalHost'), /onclick="mtOpenFunnel\(\)">Funnel</);
  mtOpenFunnel();
  assert.equal(currentView, 'funnel');
  await tick();

  // an old link to a booking: the calendar, on that booking's week, with its panel open
  db.discovery_bookings.push(bk({ id: 'far', company: 'Faraway Co', call_at: '2026-12-18T20:00:00.000Z' }));   // Sat 19 Dec 1:30 am Colombo
  openEnquiry('far');
  assert.equal(currentView, 'calendar');
  await tick(); await tick();
  assert.equal(mt.view, 'week'); assert.equal(mt.day, '2026-12-18', 'its business day: Friday 3 pm Eastern');
  assert.match(visible(host('mtCalHost')), /14 – 20 Dec 2026/);
  assert.ok(visible(host('mtCalHost')).includes('Faraway Co'));
  assert.match(visible(host('modal')), /Faraway Co/);
  assert.match(visible(host('modal')), /Sat 19 Dec · 1:30 am Sri Lanka/);
  // the same through the deep-link router, old spelling and new
  for (const view of ['enquiry', 'inquiry']) {
    mtForget(); settingsRow(); at('2026-11-24T06:00:00.000Z'); el('modal').innerHTML = '';
    assert.equal(goDeepLink({ view, id: 'far' }), true);
    await tick(); await tick();
    assert.equal(currentView, 'calendar'); assert.equal(mt.day, '2026-12-18');
    assert.match(visible(host('modal')), /Faraway Co/);
  }
  // a link to a booking that has gone still opens the calendar, and says so
  mtForget(); settingsRow(); at('2026-11-24T06:00:00.000Z');
  openEnquiry('never-existed');
  await tick(); await tick();
  assert.equal(currentView, 'calendar');
  assert.match(visible(host('mtCalHost')), /November 2026/);
  assert.match(visible(host('modal')), /not here any more/);
  // nothing in the shell still points at a screen that is gone
  assert.ok(!/render\('enquir(y|ies)'\)|viewEnquir/.test(html), 'no stale route in index.html');
});

/* ───────────── the phone ───────────── */
test('on a phone: dots and a count per day with the picked day listed underneath, and the week one day at a time', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.discovery_bookings.push(bk({ id: 'b1', company: 'Acme Roofing', plan: 'pilot', call_at: '2026-11-25T15:00:00.000Z' }));
  mt.day = '2026-11-24'; await mtLoadCal();
  let h = host('mtCalHost');
  assert.match(cellOf(h, '2026-11-25'), /<span class="mt-dots" aria-hidden="true"><i class="mt-dot mt-plan-pilot"><\/i><b>1<\/b><\/span>/);
  assert.match(h, /class="mt-under"><section class="mt-daylist"><h4>Tue 24 Nov/, 'the picked day is listed under the grid');
  assert.match(visible(h), /No calls on this day/);
  // picking another day in the same month only redraws — no new read
  const before = calls.length;
  mtPickDay('2026-11-25');
  assert.equal(calls.length, before, 'nothing was fetched');
  h = host('mtCalHost');
  assert.match(cellOf(h, '2026-11-25'), /^ sel"/);
  const under = h.slice(h.indexOf('class="mt-under"'));
  assert.match(visible(under), /Wed 25 Nov/); assert.match(visible(under), /8:30 pm 10:00 am ET Acme Roofing/, 'Sri Lanka time, then Eastern'); assert.match(visible(under), /Open this day/);
  assert.match(under, /class="mt-row mt-evrow mt-plan-pilot is-booking"/);

  // the week: a strip of business days and one day's list, with its free times to tap
  db.discovery_bookings.push(bk({ id: 'b2', company: 'Night Owl Co', call_at: '2026-11-25T23:00:00.000Z' }));   // Wed 6 pm ET · THURSDAY 4:30 am Colombo
  await mtGoWeek('2026-11-25');
  h = host('mtCalHost');
  const agenda = h.slice(h.indexOf('class="mt-agenda"'));
  assert.equal((agenda.match(/class="mt-strip-d/g) || []).length, 5, 'Monday to Friday');
  assert.match(agenda, /class="mt-strip" style="--mt-n:5"/);
  assert.match(agenda, /class="mt-strip-d sel"[^>]*aria-pressed="true"/);
  assert.match(visible(agenda), /Wed 25 Nov Sri Lanka: Wed 25 → Thu 26/, 'the day is a business day, and says which Sri Lanka days it runs over');
  assert.match(visible(agenda), /Wed 8:30 pm 10:00 am ET Acme Roofing/);
  assert.match(visible(agenda), /Thu 4:30 am 6:00 pm ET Night Owl Co/, 'the same business day, the next morning in Colombo — and the row says so');
  assert.ok(agenda.includes('class="mt-slot"'), 'free times to tap');
  assert.match(agenda, /class="mt-slot" title="[^"]* SL · [^"]* ET" onclick="mtAddAt\('/, 'a free time opens the form for a new meeting');
  assert.match(agenda, /ontouchstart="mtSwipeStart\(event\)" ontouchend="mtSwipeEnd\(event\)"/);
  // the day arrows, and a swipe, move one business day; past Friday it reads the next week, back past Monday the one before
  mtDayMove(1);
  assert.equal(mt.day, '2026-11-26');
  mtSwipeStart({ touches: [{ clientX: 300, clientY: 100 }] });
  mtSwipeEnd({ changedTouches: [{ clientX: 100, clientY: 110 }] });
  assert.equal(mt.day, '2026-11-27', 'a swipe to the left is the next day');
  mtSwipeStart({ touches: [{ clientX: 100, clientY: 100 }] });
  mtSwipeEnd({ changedTouches: [{ clientX: 120, clientY: 300 }] });
  assert.equal(mt.day, '2026-11-27', 'scrolling down is not a swipe');
  await mtDayMove(1);
  assert.equal(mt.day, '2026-11-30', 'after Friday comes Monday, not an empty Saturday');
  assert.match(visible(host('mtCalHost')), /30 Nov – 6 Dec 2026/);
  await mtDayMove(-1);
  assert.equal(mt.day, '2026-11-27', 'and back to Friday');

  // the stylesheet: under 700px the grids give way, and the things you tap are 44px
  const css = fs.readFileSync(path.join(root, 'meetings.css'), 'utf8');
  const phone = css.slice(css.indexOf('@media (max-width:699px)'));
  assert.ok(phone.length > 50, 'a phone layout');
  for (const rule of ['.mt-wk{display:none}', '.mt-chips{display:none}', '.mt-dots{display:flex}', '.mt-under{display:block}', '.mt-agenda{display:flex'])
    assert.ok(phone.includes(rule), 'phone: ' + rule);
  assert.match(css, /\.mt-row,\.mt-blockrow\{[^}]*min-height:44px/);
  assert.match(css, /\.mt-slot\{[^}]*min-height:44px/);
  assert.match(css, /\.mt-bar \.btn\{min-height:44px/);
  assert.match(phone, /\.mt-cell\{min-height:5\dpx/);
  assert.match(phone, /\.mt-month\{height:auto/, 'phone: the month is as tall as it needs to be');
  // both grids are sized from the window, so neither needs scrolling
  for (const sel of ['.mt-wk{', '.mt-month{'])
    assert.ok(css.slice(css.indexOf(sel)).slice(0, 400).includes('100dvh - var(--mt-top'), sel + ' takes the height the window has left');
  assert.match(css, /\.mt-cells\{[^}]*grid-template-rows:repeat\(var\(--mt-weeks,6\),minmax\(0,1fr\)\)/);
  assert.ok(/grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/.test(css), 'seven columns that shrink instead of pushing the page sideways');
});

/* ───────────── the colour key, behind the three dots ───────────── */
test('the colour key is not drawn until the three-dots button is pressed; outside clicks and Escape close it', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.discovery_bookings.push(bk({ id: 'b1', company: 'Acme Roofing', plan: null, call_at: '2026-11-25T15:00:00.000Z' }));
  for (const view of ['week', 'month']) {
    mt.view = view; mt.day = '2026-11-24'; await mtLoadCal();
    let h = host('mtCalHost');
    assert.ok(!h.includes('mt-legend') && !h.includes('id="mtKey"'), view + ': no key on the page');
    assert.ok(!/Hatched band|Red outline/.test(visible(h)));
    const bar = h.slice(h.indexOf('class="mt-bar"'));
    assert.match(bar, /^class="mt-bar"><div class="mt-keywrap"><button type="button" class="btn ghost mt-ic mt-dotsbtn" aria-label="What the colours mean"/, 'the first thing in the toolbar');
    assert.match(bar, /aria-expanded="false" aria-controls="mtKey" onclick="mtToggleLegend\(\)"><svg[^>]*aria-hidden="true">(<circle [^>]*\/>){3}<\/svg><\/button><\/div>/, 'three dots drawn as an svg, no emoji');
    assert.equal(mtToggleLegend(), true);
    h = host('mtCalHost');
    assert.match(h, /aria-expanded="true"/);
    assert.match(visible(h.slice(h.indexOf('id="mtKey"'), h.indexOf('class="mt-nav"'))), /P Pilot S Starter G Growth Sc Scale – No plan yet Red outline — needs an outcome Hatched band — blocked time/);
    for (const k of ['pilot', 'starter', 'growth', 'scale', 'none']) assert.ok(h.includes('class="mt-sw mt-plan-' + k + '"'), 'a swatch for ' + k);
    assert.equal(mtToggleLegend(), false);
    assert.ok(!host('mtCalHost').includes('mt-legend'));
    // a click inside it leaves it open; a click anywhere else, or Escape, closes it
    mtToggleLegend();
    assert.equal(mtLegendOutside({ target: { closest: (q) => (q === '.mt-keywrap' ? {} : null) } }), false);
    assert.ok(host('mtCalHost').includes('mt-legend'));
    assert.equal(mtLegendOutside({ target: { closest: () => null } }), true);
    assert.ok(!host('mtCalHost').includes('mt-legend'));
    mtToggleLegend();
    assert.equal(mtLegendKey({ key: 'a' }), false);
    assert.equal(mtLegendKey({ key: 'Escape' }), true);
    assert.ok(!host('mtCalHost').includes('mt-legend') && mt.legend === false);
    assert.equal(mtLegendOutside({ target: null }), false, 'closed: nothing to do');
  }
  // the colours themselves are untouched: a call still takes its plan's class
  assert.ok(host('mtCalHost').includes('class="mt-chip mt-plan-none is-booking"'));
});

/* ───────────── the owner's own meetings ───────────── */
test('mtAddOwn: a title is required, the email and the link are checked, and a time a website booking holds is refused', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.discovery_bookings.push(bk({ id: 'web', company: 'Website Co', call_at: '2026-11-27T16:00:00.000Z', minutes: 30 }));
  db.meetings.push({ id: 'm0', kind: 'strategy', starts_at: '2026-11-27T18:00:00.000Z', minutes: 30, status: 'booked' });
  const ok = { title: 'Accountant', startsAt: '2026-11-26T16:00:00.000Z' };
  const no = async (over, re) => { const r = await mtAddOwn(Object.assign({}, ok, over)); assert.deepEqual([r.ok, r.data], [false, null], JSON.stringify(over)); assert.match(r.error, re); };
  await no({ title: '' }, /Give the meeting a title/);
  await no({ title: '   ' }, /Give the meeting a title/);
  await no({ title: 'x'.repeat(161) }, /too long/);
  await no({ guestName: 'n'.repeat(121) }, /too long/);
  for (const bad of ['nope', 'a@b', 'a b@c.com', '@c.com', 'a@.c']) await no({ guestEmail: bad }, /email address does not look right/);
  for (const bad of ['http://meet.google.com/abc', 'meet.google.com/abc', 'javascript:alert(1)', 'https://', 'https://a b']) await no({ meetLink: bad }, /has to start with https:\/\//);
  await no({ startsAt: 'whenever' }, /Pick the day and the time/);
  await no({ minutes: 10 }, /15, 30, 45, 60 or 90/);
  await no({ plan: 'enterprise' }, /not one of the plans/);
  // taken by a website booking — the same start, or only overlapping it — or by another meeting
  await no({ startsAt: '2026-11-27T16:00:00.000Z' }, /^There is already a call at that time\.$/);
  await no({ startsAt: '2026-11-27T15:45:00.000Z' }, /^There is already a call at that time\.$/);
  await no({ startsAt: '2026-11-27T18:15:00.000Z', minutes: 15 }, /^There is already a call at that time\.$/);
  assert.equal(db.meetings.length, 1, 'nothing was written by any refusal');
  assert.equal(calls.filter((c) => c.table === 'meetings' && c.op === 'insert').length, 0);
  // if what is taken cannot be read, it does not guess
  fail['discovery_bookings'] = 'the bookings would not load';
  assert.equal((await mtAddOwn(ok)).error, 'the bookings would not load');
  delete fail['discovery_bookings'];

  // the plain case: everything optional left out
  const r = await mtAddOwn(ok);
  assert.equal(r.ok, true); assert.equal(r.error, ''); assert.equal(r.data.warning, '');
  assert.deepEqual(r.data.meeting, Object.assign({}, r.data.meeting, { client_id: null, booking_id: null, kind: 'other', title: 'Accountant', guest_name: null, guest_email: null, plan: null,
    starts_at: '2026-11-26T16:00:00.000Z', minutes: 30, time_zone: 'America/New_York', status: 'booked', meet_link: null, notes: null }));
  // everything filled in, trimmed
  const full = await mtAddOwn({ title: '  Quarterly review ', guestName: ' Nimal Silva ', guestEmail: ' nimal@example.com ', startsAt: '2026-11-26T17:00:00.000Z', minutes: 90, plan: 'Growth', meetLink: ' https://meet.google.com/abc-defg-hij ' });
  assert.equal(full.ok, true);
  assert.deepEqual([full.data.meeting.title, full.data.meeting.guest_name, full.data.meeting.guest_email, full.data.meeting.minutes, full.data.meeting.plan, full.data.meeting.meet_link],
    ['Quarterly review', 'Nimal Silva', 'nimal@example.com', 90, 'growth', 'https://meet.google.com/abc-defg-hij']);
});

test('mtAddOwn takes any time — 3 am on a Sunday, outside call hours, with no notice — where mtBook still refuses; a block only warns; a duplicate key becomes a plain sentence', async () => {
  settingsRow({ min_notice_h: 12 }); at('2026-11-28T20:00:00.000Z');          // Sunday 1:30 am in Colombo
  const sun3am = mtZoneToUtc('2026-11-29', '03:00', 'Asia/Colombo').toISOString();
  assert.equal(sun3am, '2026-11-28T21:30:00.000Z', '4:30 pm on a US Saturday, an hour and a half from now');
  const book = await mtBook({ kind: 'discovery', startsAt: sun3am });
  assert.equal(book.ok, false); assert.match(book.error, /not one of your calling days/, 'the bookable slots keep their rules');
  const r = await mtAddOwn({ title: 'Call with dad', startsAt: sun3am });
  assert.equal(r.ok, true, r.error);
  assert.equal(db.meetings[0].starts_at, sun3am); assert.equal(db.meetings[0].kind, 'other');
  // midnight Eastern on a weekday, and a time that has already gone: also his to add
  assert.equal((await mtAddOwn({ title: 'Midnight', startsAt: '2026-12-01T05:00:00.000Z' })).ok, true);
  assert.equal((await mtAddOwn({ title: 'Last week, for the record', startsAt: '2026-11-20T10:00:00.000Z' })).ok, true);
  // mtBook itself was not loosened
  assert.match((await mtBook({ kind: 'discovery', startsAt: '2026-12-01T05:00:00.000Z' })).error, /already taken|outside your call hours/);
  assert.match((await mtBook({ kind: 'discovery', startsAt: '2026-12-01T06:00:00.000Z' })).error, /outside your call hours/);

  // on blocked time: added, with a warning
  db.calendar_blocks.push({ id: 'blk', starts_at: '2026-12-02T15:00:00.000Z', ends_at: '2026-12-02T17:00:00.000Z', reason: 'school' });
  const w = await mtAddOwn({ title: 'Over the block', startsAt: '2026-12-02T16:00:00.000Z' });
  assert.equal(w.ok, true); assert.match(w.data.warning, /inside a block you marked as busy/);
  assert.equal(db.meetings.filter((m) => m.title === 'Over the block').length, 1);

  // the unique index answering: code 23505, or only its message
  const before = db.meetings.length;
  fail['meetings.insert'] = { code: '23505', message: 'duplicate key value violates unique constraint "meetings_starts_at_live_key"' };
  let d = await mtAddOwn({ title: 'Clash', startsAt: '2026-12-03T16:00:00.000Z' });
  assert.deepEqual([d.ok, d.data, d.error], [false, null, 'There is already a call at that time.']);
  fail['meetings.insert'] = 'duplicate key value violates unique constraint "x"';
  d = await mtAddOwn({ title: 'Clash', startsAt: '2026-12-03T16:00:00.000Z' });
  assert.equal(d.error, 'There is already a call at that time.');
  fail['meetings.insert'] = { code: '42501', message: 'permission denied for table meetings' };
  d = await mtAddOwn({ title: 'Clash', startsAt: '2026-12-03T16:00:00.000Z' });
  assert.deepEqual([d.ok, d.error], [false, 'permission denied for table meetings'], 'any other error is passed on as it is');
  delete fail['meetings.insert'];
  assert.equal(db.meetings.length, before);
  // moving one of his own meetings is as free as adding it; the clash sentence is the same
  const own = db.meetings.find((m) => m.title === 'Midnight');
  assert.equal((await mtReschedule(own.id, '2026-12-05T08:00:00.000Z')).ok, true, 'a Saturday, 3 am Eastern');
  fail['meetings.update'] = { code: '23505', message: 'duplicate key' };
  assert.equal((await mtReschedule(own.id, '2026-12-05T09:00:00.000Z')).error, 'There is already a call at that time.');
  delete fail['meetings.update'];
});

test('a hand-added meeting is on the calendar at once, in its plan\'s colour under its own title, and its panel has the person, the email, both times, the link and the buttons', async () => {
  settingsRow({ meeting_link: 'https://meet.google.com/own-room' }); at('2026-11-24T06:00:00.000Z');
  db.clients.push({ id: 'c1', company: 'Northwind', contact_name: 'Ravi Perera', plan: 'scale' });
  mt.view = 'week'; mt.day = '2026-11-24'; await mtLoadCal();
  mtOpenAdd();
  let f = host('modal');
  for (const id of ['mtAddTitle', 'mtAddName', 'mtAddEmail', 'mtAddDate', 'mtAddTime', 'mtAddEt', 'mtAddLen', 'mtAddPlan', 'mtAddLink', 'mtAddErr']) assert.ok(f.includes('id="' + id + '"'), 'the form has ' + id);
  assert.match(f, /id="mtAddDate" type="date" value="2026-11-24"/); assert.match(f, /id="mtAddTime" type="time" step="300" value="12:00"/, 'it opens on the next half hour, Sri Lanka time');
  assert.match(f, /<option value="15">15 minutes<\/option><option value="30" selected>30 minutes<\/option><option value="45">45 minutes<\/option><option value="60">60 minutes<\/option><option value="90">90 minutes<\/option>/);
  assert.match(f, /<option value="">No plan<\/option><option value="pilot">Pilot<\/option><option value="starter">Starter<\/option><option value="growth">Growth<\/option><option value="scale">Scale<\/option>/);
  assert.match(visible(f), /Time \(SL\) US Eastern \(ET\) Tue 24 Nov · 1:30 am/);
  assert.match(f, /oninput="mtAddEtLine\(\)"/);
  // the Eastern time follows what is typed
  el('mtAddDate').value = '2026-11-27'; el('mtAddTime').value = '21:30';
  assert.equal(mtAddEtLine(), 'Fri 27 Nov · 11:00 am'); assert.equal(el('mtAddEt').textContent, 'Fri 27 Nov · 11:00 am');
  el('mtAddTime').value = '';
  assert.equal(mtAddEtLine(), 'Pick a day and a time');
  // submitting with nothing typed says what is missing, and writes nothing
  let r = await mtSubmitAdd();
  assert.equal(r.ok, false); assert.equal(el('mtAddErr').textContent, 'Pick the day and the time first.');
  el('mtAddTime').value = '21:30';
  r = await mtSubmitAdd();
  assert.equal(r.ok, false); assert.match(el('mtAddErr').textContent, /Give the meeting a title/);
  assert.equal(db.meetings.length, 0);

  el('mtAddTitle').value = 'Growth plan <review>'; el('mtAddName').value = 'Nimal Silva'; el('mtAddEmail').value = 'nimal@example.com';
  el('mtAddLen').value = '45'; el('mtAddPlan').value = 'growth'; el('mtAddLink').value = '';
  r = await mtSubmitAdd();
  assert.equal(r.ok, true, r.error);
  assert.ok(toasts.includes('Added to your calendar'));
  const row = db.meetings[0];
  assert.deepEqual([row.kind, row.title, row.guest_name, row.guest_email, row.plan, row.starts_at, row.minutes, row.status, row.client_id],
    ['other', 'Growth plan <review>', 'Nimal Silva', 'nimal@example.com', 'growth', '2026-11-27T16:00:00.000Z', 45, 'booked', null]);
  assert.equal(row.meet_link, 'https://meet.google.com/own-room', 'no link typed: the room from the rules (the database fills one in when there is none at all)');
  // on the calendar straight away, same week, growth colour, its own title
  assert.equal(mt.view, 'week'); assert.equal(mt.day, '2026-11-24');
  const ev = mt.cal.events.find((e) => e.key === 'meeting:' + row.id);
  assert.deepEqual([ev.title, ev.who, ev.email, ev.plan, ev.planClass, ev.kindWord, ev.time, ev.usTime, ev.usKey], ['Growth plan <review>', 'Nimal Silva', 'nimal@example.com', 'growth', 'mt-plan-growth', '', '9:30 pm', '11:00 am', '2026-11-27']);
  const cols = colsOf(host('mtCalHost'));
  assert.match(cols[4], /class="mt-ev mt-plan-growth is-meeting short"[^>]*><b>Growth plan &lt;review&gt;<\/b><span class="mt-tagp" title="Growth">G<\/span><small>9:30 pm<i> · 11:00 am ET<\/i><\/small>/);
  assert.ok(!host('mtCalHost').includes('<review>'), 'escaped');
  // no plan → grey; and a client's plan and name are still the fallback when the meeting has none of its own
  await mtAddOwn({ title: 'No plan on this', startsAt: '2026-11-26T16:00:00.000Z' });
  db.meetings.push({ id: 'm-cl', client_id: 'c1', kind: 'review', starts_at: '2026-11-25T16:00:00.000Z', minutes: 30, status: 'booked' },
    { id: 'm-both', client_id: 'c1', kind: 'review', title: 'Renewal chat', guest_name: 'Their CFO', plan: 'pilot', starts_at: '2026-11-25T17:00:00.000Z', minutes: 30, status: 'booked' });
  await mtLoadCal();
  const by = (t) => mt.cal.events.find((e) => e.title === t);
  assert.equal(by('No plan on this').planClass, 'mt-plan-none');
  assert.deepEqual([by('Northwind').who, by('Northwind').planClass, by('Northwind').kindWord], ['Ravi Perera', 'mt-plan-scale', 'Review']);
  assert.deepEqual([by('Renewal chat').who, by('Renewal chat').planClass, by('Renewal chat').company], ['Their CFO', 'mt-plan-pilot', 'Northwind'], 'its own title, guest and plan win over the client\'s');
  // the month too
  await mtSetView('month');
  assert.match(cellOf(host('mtCalHost'), '2026-11-27'), /class="mt-chip mt-plan-growth is-meeting" title="Fri 9:30 pm SL · Fri 11:00 am ET · Growth plan &lt;review&gt; · Growth · Booked"[^>]*>(?:(?!<\/button>).)*<span class="mt-chip-t">9:30 pm<\/span><span class="mt-chip-n">Growth plan &lt;review&gt;/);

  // its panel
  await mtSetView('week');
  await mtOpenEvent('meeting:' + row.id);
  const h = host('modal'), t = visible(h);
  for (const w of ['Growth plan', 'Title', 'A meeting you added', 'Nimal Silva', 'nimal@example.com', 'G · Growth', 'Fri 27 Nov · 9:30 pm Sri Lanka', 'Fri 27 Nov · 11:00 am US Eastern — their time',
    '45 minutes', 'Join the call', 'Copy the link', 'Call done', 'No-show', 'Cancel', 'Move the call'])
    assert.ok(t.includes(w), 'the panel shows: ' + w);
  assert.ok(h.includes('Growth plan &lt;review&gt;'));
  assert.match(h, /<a href="mailto:nimal@example\.com">nimal@example\.com<\/a>/);
  assert.match(h, /href="https:\/\/meet\.google\.com\/own-room"/);
  assert.ok(!h.includes('<review>'), 'escaped');
  assert.ok(!BROKEN.test(t), t);
  // and its buttons work like any other call's
  el('mtMoveTo').value = '2026-11-29T03:00';                // Sunday 3 am in Colombo: his own meeting may go there
  assert.equal((await mtMoveClick(row.id)).ok, true);
  assert.equal(db.meetings[0].starts_at, '2026-11-28T21:30:00.000Z');
  at('2026-11-29T06:00:00.000Z');
  assert.equal((await mtHeldClick(row.id)).ok, true); assert.equal(db.meetings[0].status, 'held');
  // a time taken shows the sentence in the form, and the form stays
  el('mtAddTitle').value = 'Second'; el('mtAddDate').value = '2026-11-26'; el('mtAddTime').value = '21:30'; el('mtAddEmail').value = ''; el('mtAddName').value = ''; el('mtAddPlan').value = ''; el('mtAddLen').value = '30';
  r = await mtSubmitAdd();
  assert.equal(r.ok, false); assert.equal(el('mtAddErr').textContent, 'There is already a call at that time.');
});

/* ───────────── which view it opens on ───────────── */
test('the Calendar opens on the week, and remembers the view last chosen', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  localStorage._s = {}; mtForget();
  assert.equal(mtSavedView(), 'week'); assert.equal(mt.view, 'week');
  viewCalendar(); await tick(); await tick();
  assert.equal(mt.cal.view, 'week');
  assert.match(host('mtCalHost'), /class="mt-cal mt-view-week"/);
  assert.match(host('mtCalHost'), /<button type="button" class="active" aria-pressed="true" onclick="mtSetView\('week'\)">Week<\/button>/);
  assert.match(visible(host('mtCalHost')), /23 – 29 Nov 2026/);
  // choosing the month is remembered …
  await mtSetView('month');
  assert.equal(localStorage.getItem('avianceCalView'), 'month');
  mtForget(); settingsRow(); at('2026-11-24T06:00:00.000Z');
  assert.equal(mt.view, 'month');
  viewCalendar(); await tick(); await tick();
  assert.match(host('mtCalHost'), /class="mt-cal mt-view-month"/);
  // … and so is going back to the week, by the switch or by opening a day
  await mtSetView('week');
  assert.equal(localStorage.getItem('avianceCalView'), 'week');
  await mtSetView('month'); await mtGoWeek('2026-11-25');
  assert.equal(localStorage.getItem('avianceCalView'), 'week');
  // anything odd in storage, or no storage at all, is the week — and nothing throws
  localStorage._s = { avianceCalView: 'year' }; assert.equal(mtSavedView(), 'week');
  const real = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  try {
    assert.equal(mtSavedView(), 'week');
    assert.doesNotThrow(() => mtSaveView('month'));
    mtForget(); settingsRow(); at('2026-11-24T06:00:00.000Z');
    assert.equal(mt.view, 'week');
    assert.equal((await mtSetView('month')).ok, true, 'the view still changes; it is only not remembered');
  } finally { globalThis.localStorage = real; }
  assert.match(SRC, /try\{ return localStorage\.getItem\(MT_VIEW_KEY\)/); assert.match(SRC, /try\{ localStorage\.setItem\(MT_VIEW_KEY/);
  // today in the week is the business day: after 9 pm Eastern it is already the next one
  assert.equal(mtBizToday(mtSettingsNow(), new Date('2026-11-24T06:00:00.000Z')), '2026-11-24', 'Tue 1 am Eastern');
  assert.equal(mtBizToday(mtSettingsNow(), new Date('2026-11-25T01:59:00.000Z')), '2026-11-24', 'Tue 8:59 pm Eastern');
  assert.equal(mtBizToday(mtSettingsNow(), new Date('2026-11-25T02:00:00.000Z')), '2026-11-25', 'Tue 9 pm Eastern: the day has closed');
});

/* ───────────── the research brief in the panel ───────────── */
test('a booking\'s panel lays the research brief out to be read — one-liner, score, pains, call plan, red flags, the agents that ran — and says "Research not ready yet" when there is none', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.plan_prices = PRICES.map((p) => Object.assign({}, p));
  db.discovery_bookings.push(bk({ id: 'b1', score: 81 }));
  await mtOpenEvent('booking:b1');
  let t = visible(host('modal'));
  assert.match(t, /What we found out Research not ready yet The research engine has not written a brief for this booking\. Their own answers are below\. Research this one/);
  assert.ok(!/Pains|Call plan|Red flags/.test(t));
  // the shape the research engine writes
  db.research_briefs = [{ booking_id: 'b1', writer: 'writer', ms: 9000,
    agents: [{ agent: 'site', label: 'Website reader', ok: true, ms: 4200, summary: 'Read 6 pages' }, { agent: 'reviews', label: 'Reviews', ok: false, ms: 900, summary: 'No <b>review</b> pages' }, { agent: 'news', ok: true }],
    brief: { one_liner: 'Commercial roofer, 20 staff, referrals only.', bant: { score: 78, verdict: 'Good fit', need: 'More commercial leads', budget: '$3k a month is fine', timing: 'This quarter', authority: 'Owner' },
      pain_hypotheses: [{ pain: 'Referrals have dried up', evidence: 'Said so on the form' }, { pain: 'No outbound at all' }, 'Slow winters'],
      closer_plan: { label: 'Lead with referrals', clarify: ['How many jobs a month?', 'Who follows up?'], past_pain: ['Tried an agency in 2024'], reinforce: 'They want predictable calls', objections: ['Price'], sell_the_vacation: 'Ten calls a month without lifting a finger' },
      red_flags: ['Owner is the only closer'], what_they_sell: 'Commercial roofs', recommended_plan: 'growth', _writer_note: 'short site' } }];
  await mtOpenBooking('b1');
  const h = host('modal'); t = visible(h);
  const briefAt = h.indexOf('class="card pl-pad pl-brief mt-brief"');
  assert.ok(briefAt > 0);
  const b = visible(h.slice(briefAt, h.indexOf('What they told us')).replace(/^[^>]*>/, ''));
  assert.match(b, /^Acme Roofing Commercial roofer, 20 staff, referrals only\. Score Booking score 81 · Research score 78 — Good fit based on: need, budget, authority, timing Need More commercial leads Budget \$3k a month is fine Timing This quarter Authority Owner The business What they sell Commercial roofs Room for new calls 5 more a week · from their booking form Pains Referrals have dried up — Said so on the form No outbound at all Slow winters Call plan Say it back to them Lead with referrals Questions to ask How many jobs a month\? Who follows up\? What they have tried Tried an agency in 2024 Reinforce They want predictable calls Paint the picture Ten calls a month without lifting a finger If they push back Price Red flags Owner is the only closer Research Website reader ran in 4\.2 s Read 6 pages Reviews did not finish in 0\.9 s No b review \/b pages news ran/, b);
  assert.match(b, /What they sell Commercial roofs/); assert.match(b, /Recommended plan growth/); assert.match(b, /short site/, 'whatever else the brief holds is still listed');
  assert.ok(!h.includes('<b>review</b>') && h.includes('&lt;b&gt;review'), 'escaped');
  assert.match(t, /Brief ready/); assert.ok(!t.includes('Research not ready yet'));
  assert.ok(!BROKEN.test(t), t);
  // no red flags is said, not left out; and an empty brief is "not ready"
  db.research_briefs = [{ booking_id: 'b1', brief: { one_liner: 'Short one.', red_flags: [] } }];
  await mtOpenBooking('b1');
  assert.match(visible(host('modal')), /Acme Roofing Score Booking score 81 The business What they sell Commercial roofs · from their booking form Room for new calls 5 more a week · from their booking form Red flags None found\. Research The brief does not say which agents ran\./, 'a two-word one-liner is a page title, so the card is titled with the company');
  for (const empty of [{}, [], '', null]) {
    db.research_briefs = [{ booking_id: 'b1', brief: empty }];
    await mtOpenBooking('b1');
    assert.match(visible(host('modal')), /Research not ready yet/, JSON.stringify(empty));
    assert.ok(!visible(host('modal')).includes('Brief ready'), 'the pill at the top agrees');
  }
  // research that is running, or that fell over, says so under the same plain heading
  db.research_briefs = [];
  db.research_log = [{ id: 1, booking_id: 'b1', at: new Date().toISOString(), event: { status: 'running' } }];
  await mtOpenBooking('b1');
  assert.match(visible(host('modal')), /Research not ready yet The research engine is working on this one/);
  // the pure renderer never throws, whatever it is handed
  for (const d of [null, undefined, {}, { brief: 7 }, { brief: { brief: 'text' } }, { brief: { brief: [1, { a: 1 }] } }, { brief: { brief: { bant: 5, pain_hypotheses: 'one', closer_plan: 'call them', red_flags: { a: 1 }, one_liner: { x: 1 } }, agents: 'none' } }, { brief: { brief: { bant: [1], closer_plan: [['a'], null] }, agents: [null, 3, {}] } }])
    assert.ok(!BROKEN.test(visible(mtRenderBrief(d))), JSON.stringify(d) + ' → ' + visible(mtRenderBrief(d)));
});

/* ───────────── the house rules ───────────── */
test('plain browser JavaScript, no imports, and every global prefixed mt', () => {
  assert.ok(!/\brequire\(|^\s*import\s|^\s*export\s/m.test(SRC), 'no imports, no build step');
  const names = [...SRC.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1])
    .concat([...SRC.matchAll(/^const\s+([A-Za-z0-9_$]+)\s*=/gm)].map((m) => m[1]));
  const odd = names.filter((n) => !/^(mt|MT_)/.test(n) && !['viewCalendar', 'viewMeeting', 'viewNoShows'].includes(n));
  assert.deepEqual(odd, [], 'every global is mt-prefixed, apart from the three screens the shell names');
  assert.ok(typeof viewCalendar === 'function' && typeof viewMeeting === 'function' && typeof viewNoShows === 'function');
  for (const f of ['mtAddOwn', 'mtHourWindow', 'mtSlots', 'mtBook', 'mtReschedule', 'mtCancel', 'mtDue', 'mtMarkReminded', 'mtHeld', 'mtNoShow', 'mtBlock', 'mtUnblock', 'mtEvents', 'mtCal', 'mtNavCount'])
    assert.equal(typeof globalThis[f], 'function', f);
  assert.ok(!/email-distributor|machineFetch|MACHINE_URL/.test(SRC));
  // the css reuses theme tokens; the only colours it brings are the plan colours, each defined as a --mt- variable
  const css = fs.readFileSync(path.join(root, 'meetings.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/var\(--/.test(css));
  const outside = css.replace(/--mt-[a-z]+-(?:bg|bar|ink):#[0-9A-Fa-f]{6};/g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(outside), 'no colour outside the plan variables');
  assert.ok(/^\.mt-|[\s,]\.mt-/m.test(css));
  // the calendar never reads the browser's own zone, and never a fixed offset
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/getTimezoneOffset|resolvedOptions|toLocale(Time|Date)?String|\.getHours\(\)|\.getDate\(\)|\.getDay\(\)/.test(code), 'every time goes through Intl with a named zone');
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

/* ───────────── dress rehearsal: the brief as the research engine really writes it ───────────── */
const REHEARSAL_BRIEF = {
  bant: { need: 'Can cold email actually land commercial contracts for a plumbing company? We tried it once ourselves and got nothing.', score: 88, budget: '$5,000 – $25,000', timing: 'not given', verdict: 'hot — decision maker with budget and urgency', authority: 'not given' },
  facts: { city: null, maps: null, news: [], tech: [], phone: null, company: 'Brightline Plumbing', socials: [], website: 'https://example.com', competitors: [], google_rating: null, google_reviews: null },
  signals: [], one_liner: 'Example Domain', red_flags: [], reputation: { praise: [], complaints: [] },
  closer_plan: {
    label: 'So the goal is Can cold email actually land commercial contracts for a plumbing company? We tried it once ourselves, and today new business depends on Mostly referrals.',
    clarify: ['What made you book a call with us now, Riley?', 'You wrote "Can cold email actually land commercial contracts for a plumbing company? We tri" — what does hitting that look like in 90 days?'],
    objections: [{ objection: "We tried cold email and it didn't work", acknowledge_associate_ask: 'Totally fair. What did your setup look like?' }],
  },
  _writer_note: 'Groq unavailable (no GROQ_API_KEY); brief built from rules.',
  size_estimate: 'unknown', what_they_sell: 'unknown', who_they_sell_to: 'unknown — ask on the call',
  recommended_plan: 'Growth — budget fits and they want consistent volume',
};
const REHEARSAL_AGENTS = [{ ms: 67, ok: true, agent: 'website', label: 'Website reader', summary: '1 pages read' }, { ms: 2, ok: false, agent: 'google', label: 'Google search', summary: 'no SERPER_API_KEY' }, { ms: 0, ok: false, agent: 'competitors', label: 'Local competitors', summary: 'needs industry + city' }];
const REHEARSAL_BOOKING = { id: 'b1', company: 'Brightline Plumbing', country: 'us', capacity: 'Around 10', score: 88,
  goal: 'Can cold email actually land commercial contracts for a plumbing company? We tried it once ourselves and got nothing.', current_lead_gen: 'Mostly referrals',
  sells: "Commercial plumbing services for property managers and general contractors in the Austin, TX area. We're 12 people and want more commercial contracts." };

test('the rehearsal brief: titled with the company, form answers fill the unknowns, no empty rows, one grey line for web research, a truthful score', () => {
  const h = mtRenderBrief({ booking: REHEARSAL_BOOKING, score: 88, brief: { brief: REHEARSAL_BRIEF, agents: REHEARSAL_AGENTS, writer: 'rules' }, research: { state: 'done' } });
  const t = visible(h);
  assert.match(h, /<h3 class="mt-brief-co">Brightline Plumbing<\/h3>/, 'the card is titled with the company');
  assert.ok(!t.includes('Example Domain'), 'never the scraped page title');
  assert.match(t, /What they sell Commercial plumbing services for property managers .* · from their booking form/);
  assert.match(t, /Who they sell to property managers and general contractors in the Austin, TX area · from their booking form/);
  assert.match(t, /How big they are 12 people · from their booking form/);
  assert.match(t, /Room for new calls Around 10 · from their booking form/);
  assert.ok(!/\bunknown\b|not given: .*Timing not given|Authority not given/i.test(t.replace(/not given: authority, timing/, '')), 'no row that says it does not know: ' + t);
  for (const empty of ['News', 'Tech', 'Socials', 'Competitors', 'Praise', 'Complaints', 'Signals', 'Google rating']) assert.ok(!t.includes(empty), 'no empty row: ' + empty);
  assert.match(t, /Score Score 88 out of 100 — hot based on: need, budget · not given: authority, timing/);
  assert.ok(!t.includes('decision maker with budget and urgency'), 'no claim the signals do not support');
  assert.match(t, /So the goal is can cold email actually land/, 'their words carry on mid-sentence in lower case');
  assert.match(t, /depends on mostly referrals/);
  assert.match(t, /You wrote Can cold email actually land commercial contracts for a plumbing company\? We… — what/, 'a quote is cut at a word, with …');
  assert.ok(!h.includes('We tri&quot;') && !t.includes('We tri '));
  assert.match(t, /If they push back “We tried cold email and it didn't work” Say: Totally fair/);
  assert.ok(!/Acknowledge associate ask/i.test(t));
  assert.match(t, /Research Web research is off — this brief uses only what they told us on the booking form\. details Website reader ran/);
  assert.match(h, /<details class="mt-brief-det"><summary>details<\/summary>/, 'the agent list sits behind a toggle');
  assert.ok(!h.includes('mt-needword'), 'no red per-agent failure list');
  assert.ok(!t.includes('None found'), 'no red flags is not claimed when nothing could look');
  assert.ok(!BROKEN.test(t), t);
  // a real failure (not a missing key) is still shown in red
  const broke = mtRenderBrief({ booking: REHEARSAL_BOOKING, brief: { brief: { one_liner: 'A roofer with twenty staff.' }, agents: [{ label: 'News', ok: false, summary: 'timed out' }] } });
  assert.ok(broke.includes('mt-needword') && !visible(broke).includes('Web research is off'));
});

test('mtTidy and mtCut: quotes cut at a word, a capital only where a sentence starts', () => {
  assert.equal(mtCut('one two three four', 9), 'one two…');
  assert.equal(mtCut('short', 80), 'short');
  const b = { goal: 'More booked calls every month', current_lead_gen: 'Referrals' };
  assert.equal(mtTidy('The goal is More booked calls every month.', b), 'The goal is more booked calls every month.');
  assert.equal(mtTidy('More booked calls every month is the goal.', b), 'More booked calls every month is the goal.', 'a sentence still starts with a capital');
  assert.equal(mtTidy('They said: "More booked c" and left.', b), 'They said: "More booked…" and left.');
  assert.equal(mtTidy('Nothing of theirs here.', b), 'Nothing of theirs here.');
  assert.equal(mtTidy('', b), '');
  assert.equal(mtTidy('Fine', null), 'Fine');
});

test('the booking panel: the company is plain text, the website its own row; once won the company opens the client and Join the call is gone', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.discovery_bookings.push(bk({ id: 'b1' }));
  await mtOpenEvent('booking:b1');
  let h = host('modal');
  assert.match(visible(h), /Company Acme Roofing Website acme\.test/);
  assert.ok(!/<a [^>]*>Acme Roofing<\/a>/.test(h), 'the company name is not a link to their website');
  assert.match(h, /Join the call/);
  db.clients.push({ id: 'cl-9', booking_id: 'b1', company: 'Acme Roofing', plan: 'growth', calls_promised: 10, term: 'monthly' });
  db.discovery_bookings[0].status = 'won';
  await mtOpenBooking('b1');
  h = host('modal');
  assert.match(h, /mtOpenClientRecord\('cl-9'\)/);
  assert.ok(!h.includes('Join the call'), 'no Join for a won booking');
  assert.match(visible(h), /Open client →/);
  assert.match(visible(h), /Growth, 10 calls a month/, 'the plan is capitalised');
});

test('the bell: new website bookings from the last 24 hours and calls needing an outcome, each opening its call', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  const now = new Date('2026-11-24T06:00:00.000Z');
  const rows = [
    bk({ id: 'n1', company: 'Brightline', created_at: '2026-11-24T01:00:00Z', call_at: '2026-11-27T15:00:00Z' }),
    bk({ id: 'n2', company: 'Preview Co', created_at: '2026-11-24T01:00:00Z', source: 'preview' }),
    bk({ id: 'n3', company: 'Gone Co', created_at: '2026-11-24T01:00:00Z', status: 'cancelled' }),
    bk({ id: 'n4', company: 'Old Co', created_at: '2026-11-20T01:00:00Z', call_at: '2026-11-23T15:00:00Z' }),
  ];
  const items = mtBellItems(rows, [{ id: 'm1', kind: 'strategy', starts_at: '2026-11-23T14:00:00Z', status: 'booked', guest_name: 'Pat' }], now, mtSettingsNow());
  assert.deepEqual(items.map((x) => x.key), ['booking:n1', 'booking:n4', 'meeting:m1']);
  assert.match(items[0].t, /^New booking: Brightline, Fri 27 Nov · 8:30 pm Sri Lanka$/);
  assert.equal(items[1].t, 'How did the call with Old Co go?');
  assert.equal(items[2].t, 'How did the call with Pat go?');
  // the shell asks synchronously; the first ask reads, the next answers from it
  db.discovery_bookings = rows;
  authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' };
  assert.deepEqual(mtNotifs(), []);
  await tick(); await tick();
  const n = mtNotifs();
  assert.ok(n.length >= 2 && n[0].t.startsWith('New booking: Brightline'), JSON.stringify(n));
  n[0].go();
  assert.equal(currentView, 'calendar');
  for (let i = 0; i < 10; i++) await tick();   // let the calendar it opened finish reading
  assert.equal(typeof computeNotifs, 'function');
});

test('the calendar refreshes once a minute while it is open and seen, without redrawing what has not changed, and stops on another screen', async () => {
  settingsRow(); at('2026-11-24T06:00:00.000Z');
  db.discovery_bookings.push(bk({ id: 'b1' }));
  await mtLoadCal();
  assert.equal(mtOnRender('calendar'), true);
  assert.ok(mt.timer, 'a timer runs while the Calendar is open');
  el('mtCalHost').innerHTML = 'UNTOUCHED';
  currentView = 'calendar';
  await mtTick();
  assert.equal(host('mtCalHost'), 'UNTOUCHED', 'nothing changed, so nothing was drawn again');
  db.discovery_bookings.push(bk({ id: 'b2', company: 'New Co', call_at: '2026-11-26T16:00:00.000Z' }));
  await mtTick();
  assert.match(host('mtCalHost'), /New Co/, 'a new booking appears');
  document.hidden = true; el('mtCalHost').innerHTML = 'HIDDEN';
  db.discovery_bookings.push(bk({ id: 'b3', company: 'Third Co', call_at: '2026-11-26T18:00:00.000Z' }));
  await mtTick();
  assert.equal(host('mtCalHost'), 'HIDDEN', 'not while the tab is not seen');
  document.hidden = false;
  mtOnRender('home');
  assert.equal(mt.timer, null, 'leaving the Calendar stops it');
  // realtime: subscribes when sb can, never throws when it cannot
  const subs = [];
  fakeSb.channel = (name) => { const ch = { on(ev, f, cb) { subs.push([name, ev, f]); return ch; }, subscribe() { return ch; } }; return ch; };
  fakeSb.removeChannel = () => {};
  mtStopTimer(); assert.equal(mtListen(), true);
  assert.deepEqual(subs[0].slice(0, 3), ['mt-bookings', 'postgres_changes', { event: 'INSERT', schema: 'public', table: 'discovery_bookings' }]);
  mtStopTimer(); delete fakeSb.channel; delete fakeSb.removeChannel;
  assert.equal(mtListen(), false);
});

test('the shell: #clients opens Clients, the bell popover closes on Escape and when a modal opens, ⌘K finds clients and screens', () => {
  assert.deepEqual(parseDeepLink('#clients'), { view: 'clients' });
  assert.deepEqual(parseDeepLink('#paying'), { view: 'clients' });
  el('notifPop').classList.add('open');
  openModalShell('<p>x</p>');
  assert.equal(el('notifPop').classList.contains('open'), false, 'opening a modal closes the popover');
  el('notifPop').classList.add('open');
  assert.equal(closeNotif(), true);
  assert.equal(closeNotif(), false);
  hubClients = [{ id: 'c1', company: 'Brightline Plumbing', contact_name: 'Riley', stage: 'won' }];
  const all = cmdkEntities();
  assert.ok(all.some((x) => x.type === 'Clients' && x.label === 'Brightline Plumbing' && /brightline/i.test(x.kw)));
  assert.ok(all.some((x) => x.type === 'Screens' && x.label === 'Channels'));
  hubClients = [];
});
