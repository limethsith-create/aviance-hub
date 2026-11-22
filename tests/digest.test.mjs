/* Tests for digest.js (the dashboards and the Friday update).
   A fake `sb` stands in for Supabase — a small query builder, the same idea as
   tests/channels-api.test.mjs — and the finance side is stubbed as the globals
   finance.js defines. No network, no DOM needed for the pure renderers.
   Run with:  node --test tests/digest.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;

/* ───────────── fake Supabase (a query builder over plain arrays) ───────────── */
let tables, errors, calls;
function builder(table) {
  const call = { table, filters: [], single: false };
  calls.push(call);
  const b = {
    select() { return b; },
    eq(k, v) { call.filters.push(['eq', k, v]); return b; },
    in(k, v) { call.filters.push(['in', k, v]); return b; },
    is(k, v) { call.filters.push(['is', k, v]); return b; },
    gte(k, v) { call.filters.push(['gte', k, v]); return b; },
    lte(k, v) { call.filters.push(['lte', k, v]); return b; },
    lt(k, v) { call.filters.push(['lt', k, v]); return b; },
    gt(k, v) { call.filters.push(['gt', k, v]); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { call.single = true; return b; },
    single() { call.single = true; return b; },
    then(res, rej) { return Promise.resolve(run(call)).then(res, rej); },
  };
  return b;
}
function keep(row, f) {
  const v = row[f[1]];
  if (f[0] === 'eq') return v === f[2];
  if (f[0] === 'in') return f[2].indexOf(v) >= 0;
  if (f[0] === 'is') return v === f[2];
  const t = Date.parse(String(v)), u = Date.parse(String(f[2]));
  if (!Number.isFinite(t) || !Number.isFinite(u)) return false;
  if (f[0] === 'gte') return t >= u;
  if (f[0] === 'gt') return t > u;
  if (f[0] === 'lte') return t <= u;
  if (f[0] === 'lt') return t < u;
  return true;
}
function run(call) {
  if (errors[call.table]) return { data: null, error: { message: errors[call.table] } };
  const rows = (tables[call.table] || []).filter((r) => call.filters.every((f) => keep(r, f)));
  return call.single ? { data: rows.length ? rows[0] : null, error: null } : { data: rows, error: null };
}
globalThis.sb = { from: builder };

/* ───────────── the finance side, as finance.js would define it ───────────── */
let finance;
function stubFinance() {
  finance = { money: null, exposure: null, clients: [], standing: [], invoices: [], calls: null, locked: [] };
  globalThis.fnUsd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  globalThis.fnMoney = async () => ({ ok: true, data: finance.money, error: '' });
  globalThis.fnExposure = async () => ({ ok: true, data: finance.exposure, error: '' });
  globalThis.fnClients = async () => ({ ok: true, data: finance.clients, error: '' });
  globalThis.fnInvoices = async () => ({ ok: true, data: finance.invoices, error: '' });
  globalThis.fnStanding = async (o) => ({ ok: true, data: (o && o.clientId ? finance.standing.filter((m) => m.client_id === o.clientId) : finance.standing), error: '' });
  globalThis.fnLockMonth = async (id) => { finance.locked.push(id); return { ok: true, data: { id }, error: '' }; };
}
function dropFinance() {
  for (const n of ['fnMoney', 'fnExposure', 'fnClients', 'fnInvoices', 'fnStanding', 'fnLockMonth', 'fnUsd']) delete globalThis[n];
}

vm.runInThisContext(fs.readFileSync(path.join(root, 'digest.js'), 'utf8'), { filename: 'digest.js' });

beforeEach(() => { tables = {}; errors = {}; calls = []; stubFinance(); globalThis.sb = { from: builder }; });

/* ───────────── helpers ───────────── */
const NOW = new Date('2026-11-20T15:00:00Z');                 /* a Friday */
const text = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const shape = (r) => { assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']); return r; };
const month = (o = {}) => ({ id: 'm1', client_id: 'c1', month_no: 1, starts_on: '2026-11-01', ends_on: '2026-11-30', calls_promised: 10, calls_delivered: 0, verdict: 'open', locked_at: null, refund_due: 0, monthly_fee: 3000, ...o });
const call = (o = {}) => ({ id: 'q' + Math.random().toString(36).slice(2, 7), client_id: 'c1', month_id: 'm1', prospect_name: 'A Prospect', booked_for: '2026-11-18T14:00:00Z', matched_icp: true, happened: true, happened_at: '2026-11-18T14:00:00Z', dispute_status: 'none', counts: true, ...o });
const liveClient = (o = {}) => ({ id: 'c1', company: 'Stone Roofing', stage: 'sending', day1_on: '2026-11-01', ended_on: null, monthly_fee: 3000, ...o });

/* ───────────── dgHome with nothing in the database ───────────── */
test('dgHome with zero rows: every number reads 0, never blank and never NaN', async () => {
  const r = shape(await dgHome(NOW));
  assert.equal(r.ok, true);
  const d = r.data;
  assert.deepEqual([d.calls.bookedThisWeek, d.calls.deliveredThisWeek, d.clientsLive, d.openRequests, d.overdueTasks, d.dialsToday], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([d.money.invoiced, d.money.owed, d.money.paidEver, d.refundsExposed], [0, 0, 0, 0]);
  assert.deepEqual(d.shortMonths, []);
  assert.deepEqual(d.missing, []);

  const html = dgRenderHome(d);
  const t = text(html);
  assert.ok(!/NaN|undefined|null/.test(t), t);
  assert.ok(!t.includes('—'), 'every source answered, so no dashes: ' + t);
  for (const w of ['Calls booked this week 0', 'Calls delivered this week 0', 'Clients live 0', 'Invoiced $0', 'Owed to us $0', 'Refunds exposed $0', 'Open requests 0', 'Overdue tasks 0', 'Dials today 0']) {
    assert.ok(t.includes(w), 'missing "' + w + '" in: ' + t);
  }
  assert.ok(t.includes('No month is running short'));
  /* nothing is read from a stored counter: each number came from a query or a view */
  assert.ok(calls.some((c) => c.table === 'qualified_calls') && calls.some((c) => c.table === 'tasks') && calls.some((c) => c.table === 'call_log'));
});

test('dgHome counts this week from rows, and lists the months running short with what they would cost', async () => {
  finance.clients = [liveClient(), liveClient({ id: 'c2', company: 'Harbor Co' }), liveClient({ id: 'c3', company: 'Old Co', ended_on: '2026-10-01' })];
  finance.money = { invoiced: 9000, invoiced_unpaid: 3000, paid_ever: 6000, paid_this_month: 3000, refunds_owed: 0 };
  finance.exposure = { at_risk: 6000 };
  finance.standing = [month({ calls_delivered: 2, refund_due: 6000, refund_multiplier: 2 }), month({ id: 'm2', client_id: 'c2', month_no: 3, calls_delivered: 9, calls_promised: 10, refund_due: 3000, refund_multiplier: 1 })];
  tables.qualified_calls = [call(), call({ booked_for: '2026-11-19T14:00:00Z', happened_at: '2026-11-19T14:00:00Z' }), call({ booked_for: '2026-11-02T14:00:00Z', happened_at: '2026-11-02T14:00:00Z' })];
  tables.client_requests = [{ id: 'r1', status: 'open' }, { id: 'r2', status: 'closed' }];
  tables.tasks = [{ id: 't1', status: 'todo', due_on: '2026-11-01' }, { id: 't2', status: 'todo', due_on: '2026-12-30' }, { id: 't3', status: 'done', due_on: '2026-11-01' }];
  tables.call_log = [{ id: 'l1', called_at: '2026-11-20T09:00:00Z' }, { id: 'l2', called_at: '2026-11-19T09:00:00Z' }];

  const d = (await dgHome(NOW)).data;
  assert.equal(d.calls.bookedThisWeek, 2, 'only the two in this week');
  assert.equal(d.calls.deliveredThisWeek, 2);
  assert.equal(d.clientsLive, 2, 'the ended client is not live');
  assert.equal(d.openRequests, 1);
  assert.equal(d.overdueTasks, 1);
  assert.equal(d.dialsToday, 1);
  assert.equal(d.money.owed, 3000);
  assert.equal(d.refundsExposed, 6000);
  assert.equal(d.shortMonths.length, 1, 'only the one that is actually behind');
  assert.equal(d.shortMonths[0].company, 'Stone Roofing');
  assert.equal(d.shortMonths[0].shortBy, 8);
  const t = text(dgRenderHome(d));
  assert.ok(t.includes('8 calls short') && t.includes('$6,000 at 2x if it locks short'), t);
});

/* ───────────── one client's week ───────────── */
test('dgClientWeek says "behind" when delivered is under the pro-rata pace', async () => {
  tables.clients = [liveClient()];
  finance.standing = [month({ calls_delivered: 2 })];     /* 10 promised, day 20 of 30, 2 delivered */
  tables.qualified_calls = [call(), call({ booked_for: '2026-11-19T10:00:00Z' })];

  const r = shape(await dgClientWeek('c1', NOW));
  assert.equal(r.ok, true);
  const d = r.data;
  assert.equal(d.status, 'behind');
  assert.equal(d.state, 'behind');
  assert.equal(d.onTrack, false);
  assert.equal(d.daysLeft, 10);
  assert.equal(d.promised, 10);
  assert.equal(d.bookedThisWeek.length, 2);
  assert.ok(/behind/i.test(d.line), d.line);
  assert.ok(d.pace > d.delivered);

  /* on the pace, it says so plainly */
  finance.standing = [month({ calls_delivered: 8 })];
  tables.qualified_calls = Array.from({ length: 8 }, (_, i) => call({ id: 'k' + i, prospect_name: 'P' + i, booked_for: '2026-11-1' + i + 'T14:00:00Z', happened_at: '2026-11-1' + i + 'T14:00:00Z' }));
  const ok2 = (await dgClientWeek('c1', NOW)).data;
  assert.equal(ok2.status, 'on track');
  assert.equal(ok2.onTrack, true);
});

test('dgClientWeek says "short" once the month has ended under promise, with the shortfall', async () => {
  tables.clients = [liveClient()];
  finance.standing = [month({ starts_on: '2026-10-01', ends_on: '2026-10-31', calls_delivered: 6, verdict: 'missed', refund_due: 6000, refund_multiplier: 2 })];
  tables.qualified_calls = [call({ booked_for: '2026-10-10T14:00:00Z', happened_at: '2026-10-10T14:00:00Z' })];

  const d = (await dgClientWeek('c1', NOW)).data;
  assert.equal(d.status, 'short');
  assert.equal(d.onTrack, false);
  assert.ok(d.daysLeft < 0, 'the month has ended');
  assert.ok(/short/i.test(d.line), d.line);
  assert.equal(d.shortBy, 9, 'promised 10, and only one call actually counts');
  assert.equal(d.refund.amount, 6000);
  assert.equal(d.refund.multiplier, 2);
});

test('dgClientWeek with no client id, and with no month open, both answer calmly', async () => {
  const bad = shape(await dgClientWeek('', NOW));
  assert.equal(bad.ok, false);
  assert.ok(/client/i.test(bad.error) && !/undefined/.test(bad.error));
  tables.clients = [liveClient()];
  const none = (await dgClientWeek('c1', NOW)).data;
  assert.equal(none.state, 'none');
  assert.equal(none.delivered, 0);
  assert.ok(/no month/i.test(none.line), none.line);
});

/* ───────────── the Friday update ───────────── */
test('dgFridayUpdate states the shortfall plainly and never overstates delivered calls', async () => {
  tables.clients = [liveClient()];
  /* the view says 4 delivered; only one row actually counts (one no-show, one off-profile, one upheld dispute) */
  finance.standing = [month({ starts_on: '2026-10-01', ends_on: '2026-10-31', calls_delivered: 4, verdict: 'missed', refund_due: 6000, refund_multiplier: 2 })];
  tables.qualified_calls = [
    call({ booked_for: '2026-10-05T14:00:00Z', prospect_name: 'Real One', counts: true }),
    call({ booked_for: '2026-10-06T14:00:00Z', prospect_name: 'No Show', happened: false, happened_at: null, counts: false }),
    call({ booked_for: '2026-10-07T14:00:00Z', prospect_name: 'Off Profile', matched_icp: false, counts: false }),
    call({ booked_for: '2026-10-08T14:00:00Z', prospect_name: 'Disputed', dispute_status: 'upheld', counts: false }),
  ];

  const r = shape(await dgFridayUpdate('c1', NOW));
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.data).sort(), ['facts', 'html', 'text']);
  const { text: note, html, facts } = r.data;

  assert.equal(facts.delivered, 1, 'the smaller of what the view says and what the rows support');
  assert.equal(facts.shortBy, 9);
  assert.ok(note.includes('1 of 10 calls'), note);
  assert.ok(!/\b4 of 10\b/.test(note), 'never states the view\'s 4: ' + note);
  assert.ok(/short by 9 calls/i.test(note), note);
  assert.ok(/refund \$6,000/i.test(note) && /2x/.test(note), 'says what the short month costs: ' + note);
  assert.ok(/That is on us/.test(note), 'does not flatter it');
  assert.ok(note.includes('Real One') && !note.includes('No Show') && !note.includes('Off Profile') && !note.includes('Disputed'),
    'only the calls that count are named as having turned up: ' + note);
  assert.ok(html.startsWith('<div class="dg-note">') && html.includes('short by 9 calls'));
  assert.ok(!html.includes('<script'), 'escaped');

  /* an on-track month does not invent a shortfall */
  finance.standing = [month({ calls_delivered: 8 })];
  tables.qualified_calls = Array.from({ length: 8 }, (_, i) => call({ id: 'k' + i, prospect_name: 'P' + i, booked_for: '2026-11-1' + (i % 9) + 'T14:00:00Z' }));
  const good = (await dgFridayUpdate('c1', NOW)).data;
  assert.ok(!/short/i.test(good.text), good.text);
  assert.ok(/on the pace/i.test(good.text), good.text);
});

test('dgFridayUpdate escapes what a prospect typed, and dgFridayAll builds one draft per live client', async () => {
  tables.clients = [liveClient(), liveClient({ id: 'c2', company: 'Harbor Co' })];
  finance.clients = [liveClient(), liveClient({ id: 'c2', company: 'Harbor Co' }), liveClient({ id: 'c9', company: 'Gone Co', ended_on: '2026-09-01' })];
  finance.standing = [month({ calls_delivered: 8 }), month({ id: 'm2', client_id: 'c2', calls_delivered: 1 })];
  tables.qualified_calls = [call({ prospect_name: '<script>x</script>' })];

  const one = (await dgFridayUpdate('c1', NOW)).data;
  assert.ok(!one.html.includes('<script>x</script>') && one.html.includes('&lt;script&gt;'));

  const all = shape(await dgFridayAll(NOW));
  assert.equal(all.ok, true);
  assert.equal(all.data.drafts.length, 2, 'the ended client gets no draft');
  assert.deepEqual(all.data.drafts.map((x) => x.company), ['Stone Roofing', 'Harbor Co']);
  assert.ok(all.data.drafts.every((x) => x.ok && x.text && x.facts));
  const screen = text(dgRenderFriday(all.data));
  assert.ok(screen.includes('Stone Roofing') && screen.includes('Harbor Co') && screen.includes('Built from'));
  assert.ok(dgRenderFriday(all.data).includes('<textarea'), 'editable before it goes');
  assert.ok(/Nothing is sent from this screen/.test(screen));
  /* no sending from here, in any shape */
  const src = fs.readFileSync(path.join(root, 'digest.js'), 'utf8');
  assert.ok(/\/\/ TODO:/.test(src), 'the send is left as a marked TODO');
  for (const banned of ['machineFetch', 'MACHINE_URL', 'email-distributor']) assert.ok(!src.includes(banned), banned);
});

test('dgFridayAll with no live clients says there is nothing to send', async () => {
  const r = await dgFridayAll(NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.drafts, []);
  assert.ok(text(dgRenderFriday(r.data)).includes('nothing to send'));
});

/* ───────────── month end ───────────── */
test('dgMonthClose: months whose end has passed and are not locked, 2x on month one and 1x later', async () => {
  finance.clients = [liveClient(), liveClient({ id: 'c2', company: 'Harbor Co' })];
  finance.standing = [
    month({ id: 'm1', month_no: 1, starts_on: '2026-10-01', ends_on: '2026-10-31', calls_delivered: 6, verdict: 'missed', refund_due: 6000, refund_multiplier: 2 }),
    month({ id: 'm2', client_id: 'c2', month_no: 3, starts_on: '2026-10-01', ends_on: '2026-10-31', calls_delivered: 4, verdict: 'missed', refund_due: 3000, monthly_fee: 3000 }),
    month({ id: 'm3', month_no: 2, starts_on: '2026-09-01', ends_on: '2026-09-30', verdict: 'missed', refund_due: 3000, locked_at: '2026-10-02T00:00:00Z' }),
    month({ id: 'm4', month_no: 2, starts_on: '2026-11-01', ends_on: '2026-11-30', calls_delivered: 3 }),
  ];
  const r = shape(await dgMonthClose(NOW));
  assert.equal(r.ok, true);
  const got = r.data.months;
  assert.deepEqual(got.map((x) => x.monthId), ['m1', 'm2'], 'locked and still-running months are not here');
  assert.equal(got[0].multiplier, 2);
  assert.equal(got[0].multiplierWords, '2x');
  assert.equal(got[1].multiplier, 1, 'read back from the finance side, not recomputed');
  assert.equal(got[1].multiplierWords, '1x');
  assert.equal(r.data.totalRefund, 9000);

  const t = text(dgRenderMonthEnd(r.data));
  assert.ok(t.includes('Stone Roofing') && t.includes('$6,000') && t.includes('2x') && t.includes('1x'), t);
  assert.ok(t.includes('Locking all of these would refund $9,000'));
  const html = dgRenderMonthEnd(r.data);
  assert.ok(html.includes("dgLockMonth('m1')") && html.includes("dgLockMonth('m2')"), 'a lock button per month');

  /* the button calls the finance function, and nothing else locks anything */
  await dgLockMonth('m1');
  assert.deepEqual(finance.locked, ['m1']);
});

test('dgMonthClose with nothing to close, and a hit month that costs nothing', async () => {
  const empty = await dgMonthClose(NOW);
  assert.deepEqual(empty.data.months, []);
  assert.ok(text(dgRenderMonthEnd(empty.data)).includes('No month has ended'));

  finance.clients = [liveClient()];
  finance.standing = [month({ starts_on: '2026-10-01', ends_on: '2026-10-31', calls_delivered: 10, verdict: 'hit', refund_due: 0 })];
  const hit = (await dgMonthClose(NOW)).data;
  assert.equal(hit.months.length, 1);
  assert.equal(hit.months[0].refundDue, 0);
  assert.equal(hit.months[0].state, 'hit');
  assert.equal(hit.totalRefund, 0);
  assert.ok(text(dgRenderMonthEnd(hit)).includes('—'), 'no multiplier to show when nothing is refunded');
});

/* ───────────── a missing source degrades to a dash ───────────── */
test('a missing module degrades to a dash and nothing throws', async () => {
  dropFinance();                                     /* finance.js is not loaded at all */
  errors.client_requests = 'relation "client_requests" does not exist';
  errors.call_log = 'permission denied';
  tables.tasks = [{ id: 't1', status: 'todo', due_on: '2026-11-01' }];

  const r = shape(await dgHome(NOW));
  assert.equal(r.ok, true, 'the screen still gets data');
  const d = r.data;
  assert.equal(d.money.invoiced, null);
  assert.equal(d.refundsExposed, null);
  assert.equal(d.openRequests, null);
  assert.equal(d.dialsToday, null);
  assert.equal(d.overdueTasks, 1, 'the sources that did answer still count');
  assert.ok(d.missing.length >= 4);

  const t = text(dgRenderHome(d));
  assert.ok(t.includes('Invoiced —') && t.includes('Refunds exposed —') && t.includes('Open requests —') && t.includes('Dials today —'), t);
  assert.ok(t.includes('Overdue tasks 1'));
  assert.ok(!/NaN|undefined/.test(t), t);
  assert.ok(/not in yet/.test(t), 'it says which parts did not answer');

  /* the other screens survive it too */
  const fri = await dgFridayAll(NOW);
  assert.equal(fri.ok, true);
  assert.ok(Array.isArray(fri.data.drafts));
  const close = await dgMonthClose(NOW);
  assert.equal(close.ok, true);

  /* no sb at all */
  const saved = globalThis.sb; delete globalThis.sb;
  try {
    const bare = await dgHome(NOW);
    assert.equal(bare.ok, true);
    assert.equal(bare.data.dialsToday, null);
    assert.ok(text(dgRenderHome(bare.data)).includes('—'));
    const w = await dgClientWeek('c1', NOW);
    assert.equal(w.ok, true);
    assert.equal(w.data.state, 'none');
  } finally { globalThis.sb = saved; }
});

test('a month-end lock with no finance side says so instead of throwing', async () => {
  dropFinance();
  let said = '';
  globalThis.toast = (m) => { said = m; };
  await dgLockMonth('m1');
  assert.ok(/not loaded/i.test(said), said);
  delete globalThis.toast;
});

/* ───────────── the renderers never choke on nothing ───────────── */
test('every renderer draws from nothing without throwing', () => {
  for (const fn of [dgRenderHome, dgRenderFriday, dgRenderMonthEnd]) {
    for (const arg of [undefined, null, {}]) {
      const h = fn(arg);
      assert.equal(typeof h, 'string');
      assert.ok(h.length > 10);
      assert.ok(!/NaN|undefined/.test(text(h)), fn.name + ' ' + h);
    }
  }
  for (const v of [viewHome, viewFriday, viewMonthEnd]) assert.ok(v().includes('id="dgHost"'), v.name);
  assert.ok(viewFriday().includes('data-dg-screen="friday"') && viewMonthEnd().includes('data-dg-screen="monthEnd"'));
});

/* ───────────── the shell's own wiring ───────────── */
test('dgNavCount is blank until Today has been counted, then counts what needs a person', async () => {
  assert.equal(dgNavCount(), '', 'nothing is claimed before a query has run');
  finance.clients = [liveClient()];
  finance.standing = [month({ calls_delivered: 1 })];
  tables.client_requests = [{ id: 'r1', status: 'open' }, { id: 'r2', status: 'in_progress' }];
  tables.tasks = [{ id: 't1', status: 'doing', due_on: '2026-11-01' }];
  const d = (await dgHome(NOW)).data;
  assert.equal(dgNeedsCount(d), 4, 'one short month, two requests, one overdue task');
  assert.equal(dgNeedsCount({}), 0);
  assert.equal(dgNeedsCount(null), 0);
});

test('the real view columns: v_money {invoiced, paid, owed} and a month row with only days_left', async () => {
  finance.money = { invoiced: 10000, paid: 7000, owed: 3000 };
  finance.exposure = { client_id: 'c1', at_risk: 4994 };
  finance.clients = [liveClient()];
  /* exactly the shape tests/finance.test.mjs uses for v_month_standing */
  finance.standing = [{ id: 'm1', client_id: 'c1', month_no: 1, calls_promised: 10, calls_delivered: 4, days_left: 9, verdict: 'open', refund_due: 0 }];
  const d = (await dgHome(NOW)).data;
  assert.equal(d.money.invoiced, 10000);
  assert.equal(d.money.owed, 3000);
  assert.equal(d.money.paidEver, 7000);
  assert.equal(d.refundsExposed, 4994);
  assert.equal(d.shortMonths.length, 1, 'paced off days_left when the view carries no start date');
  assert.equal(d.shortMonths[0].shortBy, 6);
  const t = text(dgRenderHome(d));
  assert.ok(t.includes('Invoiced $10,000') && t.includes('Owed to us $3,000') && t.includes('Refunds exposed $4,994'), t);

  /* and a month that ran out of days closes, even with no end date in the view */
  finance.standing = [{ id: 'm1', client_id: 'c1', month_no: 1, calls_promised: 10, calls_delivered: 4, days_left: -1, verdict: 'missed', refund_due: 6000, refund_multiplier: 2 }];
  const close = (await dgMonthClose(NOW)).data;
  assert.deepEqual(close.months.map((x) => [x.monthId, x.multiplierWords]), [['m1', '2x']]);
});
