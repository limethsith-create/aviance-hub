/* ROUND 3 — the owner's walk, in a real browser, and the 100-client load test.
   Every test here is a thing that was seen to go wrong on a screen: a button
   that announced something it had not done, a second click that did the action
   twice, a figure that did not refresh, a zero for a number nobody read, and a
   read that came back short and was shown as the whole answer.

   The fake database here answers the way the real one does: AT MOST 1,000 ROWS
   to a read that asks for no range, and it says nothing about the rest. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let tables, calls, rpcs, rpcDo, slow;
const CAP = 1000;
function builder(table) {
  const q = { table, filters: [], op: 'select', payload: null, range: null, limit: null, orders: [] };
  calls.push(q);
  const keep = (r) => q.filters.every(([k, f, v]) => {
    if (k === 'eq') return String(r[f]) === String(v);
    if (k === 'in') return v.map(String).includes(String(r[f]));
    if (k === 'is') return v === null ? r[f] == null : r[f] === v;
    if (k === 'gte') return String(r[f]) >= String(v);
    if (k === 'lt') return String(r[f]) < String(v);
    if (k === 'lte') return String(r[f]) <= String(v);
    return true;
  });
  const settle = async () => {
    if (slow) await new Promise((r) => setTimeout(r, slow));
    let rows = tables[table];
    if (rows === undefined) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public." + table + "' in the schema cache" } };
    let hit = rows.filter(keep);
    if (q.op === 'update') { hit.forEach((r) => Object.assign(r, q.payload)); return { data: hit, error: null }; }
    if (q.op === 'insert') { const row = Object.assign({ id: table + (rows.length + 1) }, q.payload); rows.push(row); return { data: [row], error: null }; }
    q.orders.forEach(([f, asc]) => { hit = hit.slice().sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (asc ? 1 : -1)); });
    if (q.range) hit = hit.slice(q.range[0], q.range[1] + 1);
    else hit = hit.slice(0, Math.min(CAP, q.limit || CAP));        /* the cut the real database makes, silently */
    return { data: hit, error: null };
  };
  const one = async () => { const r = await settle(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; };
  const api = {
    select() { return api }, insert(p) { q.op = 'insert'; q.payload = p; return api }, update(p) { q.op = 'update'; q.payload = p; return api },
    order(f, o) { q.orders.unshift([f, !o || o.ascending !== false]); return api },
    range(a, b) { q.range = [a, b]; return api }, limit(n) { q.limit = n; return api },
    single: one, maybeSingle: one, then(res, rej) { return settle().then(res, rej) },
  };
  ['eq', 'in', 'is', 'gte', 'lt', 'lte'].forEach((k) => { api[k] = (f, v) => { q.filters.push([k, f, v]); return api } });
  return api;
}
globalThis.sb = { from: builder, async rpc(name, args) { rpcs.push({ name, args }); if (slow) await new Promise((r) => setTimeout(r, slow));
  return rpcDo && rpcDo[name] ? rpcDo[name](args) : { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name } }; } };
function reset(t) { tables = t || {}; calls = []; rpcs = []; rpcDo = null; slow = 0; }

/* the shell, as far as these files need it */
let toasts = [], painted = 0;
globalThis.toast = (m) => { toasts.push(m) };
globalThis.currentView = 'monthEnd';
globalThis.render = () => { painted++ };
globalThis.authUser = { id: 'u1', uid: 'u1', role: 'admin', approved: true };
for (const f of ['core.js', 'finance.js', 'clientbook.js', 'money.js', 'digest.js', 'guarantee.js', 'wrapup.js'])
  vm.runInThisContext(read(f), { filename: f });
const F = (n) => vm.runInThisContext(n);

/* ═════════════ a read that came back short is never the whole answer ═════════════ */

/* 1,150 months, oldest first: the open ones are the LAST 100. */
function manyMonths(n) {
  return Array.from({ length: n }, (_, i) => ({
    month_id: 'm' + String(i).padStart(5, '0'), client_id: 'c' + (i % 100), company: 'Co ' + (i % 100), plan: 'growth', month_no: 1 + Math.floor(i / 100),
    starts_on: '2025-01-01', ends_on: new Date(Date.UTC(2025, 0, 1 + Math.floor(i / 100) * 30)).toISOString().slice(0, 10),
    calls_promised: 10, calls_delivered: 4, calls_short: 6, verdict: i >= n - 100 ? 'open' : 'hit', locked_at: null, at_risk: i >= n - 100 ? 7 : 0, days_left: 5,
  }));
}

test('SCALE A: the clients screen reads every month, not the first 1,000 (the open ones were the ones cut)', async () => {
  reset({ v_month_standing: manyMonths(1150) });
  const r = await F('cbStanding')();
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 1150, 'all of them');
  assert.equal(r.data.filter((m) => m.verdict === 'open').length, 100, 'the open months are there');
  assert.equal(r.data.reduce((s, m) => s + m.at_risk, 0), 700, 'so the money at stake is whole');
  assert.equal(new Set(r.data.map((m) => m.month_id)).size, 1150, 'no month twice, none skipped');
  assert.ok(calls.filter((c) => c.table === 'v_month_standing').every((c) => c.range), 'every read asked for a page');
});

test('SCALE A: past the ceiling it fails in words, and digest does not then try an unpaged read behind it', async () => {
  reset({ v_month_standing: manyMonths(20001) });
  const r = await F('cbStanding')();
  assert.equal(r.ok, false);
  assert.match(r.error, /not showing a part of them as the whole/);
  calls.length = 0;
  const d = await F('dgStanding')(null);
  assert.equal(d.ok, false, 'the refusal is passed on');
  assert.ok(calls.every((c) => c.range), 'no whole-table read was made after the refusal');
});

test('SCALE A: two screens asking for the months at the same moment share one read', async () => {
  reset({ v_month_standing: manyMonths(30) });
  const [a, b] = await Promise.all([F('fnStanding')(), F('fnStanding')()]);
  assert.equal(a.data.length, 30); assert.equal(b.data.length, 30);
  assert.equal(calls.filter((c) => c.table === 'v_month_standing').length, 1, 'one read, not two');
  await F('fnStanding')();
  assert.equal(calls.filter((c) => c.table === 'v_month_standing').length, 2, 'and nothing is kept: the next ask reads again');
});

test('SCALE C: every invoice is read, a page at a time, and a table past the ceiling fails in words', async () => {
  const inv = (n) => Array.from({ length: n }, (_, i) => ({ id: 'i' + String(i).padStart(6, '0'), client_id: 'c1', amount: 1, status: 'sent', issued_on: '2026-01-01', due_on: '2026-01-08' }));
  reset({ invoices: inv(1183) });
  const r = await F('fnInvoices')();
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 1183);
  assert.equal(new Set(r.data.map((x) => x.id)).size, 1183);
  reset({ invoices: inv(20001) });
  const big = await F('fnInvoices')();
  assert.equal(big.ok, false);
  assert.match(big.error, /more invoices on the books than this screen can read/);
});

test('SCALE B: the Friday update counts this week\'s calls when the book holds thousands of old ones', async () => {
  const now = new Date('2026-11-27T15:00:00Z');
  const old = Array.from({ length: 3000 }, (_, i) => ({ id: 'q' + String(i).padStart(6, '0'), client_id: 'c1', booked_for: '2026-03-01T15:00:00Z', happened: true, happened_at: '2026-03-01T15:00:00Z', matched_icp: true, counts: true, prospect_name: 'Old ' + i }));
  const fresh = [
    { id: 'z1', client_id: 'c1', booked_for: '2026-11-24T15:00:00Z', happened: true, happened_at: '2026-11-24T15:00:00Z', matched_icp: true, counts: true, prospect_name: 'This week A' },
    { id: 'z2', client_id: 'c1', booked_for: '2026-11-26T15:00:00Z', happened: false, happened_at: null, matched_icp: true, counts: false, prospect_name: 'This week B' },
  ];
  reset({
    clients: [{ id: 'c1', company: 'Acme', stage: 'live', day1_on: '2026-01-01', ended_on: null, created_at: '2026-01-01' }],
    v_month_standing: [{ month_id: 'm11', client_id: 'c1', company: 'Acme', month_no: 11, starts_on: '2026-11-10', ends_on: '2026-12-09', calls_promised: 10, calls_delivered: 1, verdict: 'open', locked_at: null, days_left: 12 }],
    qualified_calls: old.concat(fresh), v_outreach_summary: [],
  });
  const r = await F('dgFridayAll')(now);
  assert.equal(r.ok, true);
  const facts = r.data.drafts[0].facts;
  assert.equal(Array.isArray(facts.bookedThisWeek) ? facts.bookedThisWeek.length : facts.bookedThisWeek, 2, 'both of this week\'s calls, not zero');
  const read = calls.filter((c) => c.table === 'qualified_calls');
  assert.ok(read.every((c) => c.range), 'paged');
  assert.ok(read.every((c) => c.filters.some(([k, f]) => k === 'gte' && f === 'booked_for')), 'and only from the day a call can first matter');
  assert.equal(read.length, 1, 'so 3,000 old calls cost nothing');
});

test('SCALE B: the floor is the start of the oldest month being reported, less two days', () => {
  const floor = F('dgCallsFloor');
  const now = new Date('2026-11-27T15:00:00Z');
  assert.ok(floor([{ starts_on: '2026-11-10' }, { starts_on: '2026-10-20' }], now) < '2026-10-19', 'two days before the oldest month');
  assert.ok(floor([{ starts_on: '2026-10-20' }], now) > '2026-10-17');
  assert.ok(floor([], now) < '2026-10-14', 'no month known: 45 days back, never "no floor"');
  assert.ok(floor([null, { starts_on: '2026-11-26' }], now) < '2026-11-23', 'never later than the start of the week it reports');
});

test('SCALE D: the bell asks only for meetings that can still need an outcome, newest first, capped, and says when it is full', () => {
  const src = read('meetings.js');
  const body = src.slice(src.indexOf('async function mtBellLoad'), src.indexOf('function mtNotifs'));
  assert.match(body, /\.in\('status', MT_BELL_STATUSES\)/);
  assert.match(body, /\.order\('starts_at', \{ascending:false\}\)\.limit\(MT_BELL_MAX\)/);
  assert.match(body, /length >= MT_BELL_MAX/, 'a full read is said to be a part');
  assert.match(src, /const MT_BELL_STATUSES = \['booked', 'requested'\]/);
  /* and those two are exactly the states mtMeetingNeedsOutcome accepts, so nothing the bell shows is left out */
  assert.match(src, /function mtMeetingNeedsOutcome[\s\S]{0,200}s==='booked' \|\| s==='requested'/);
});

/* ═════════════ a second click that did the action twice ═════════════ */

function closeFixture() {
  reset({
    clients: [{ id: 'c1', company: 'Alder', term: 'monthly', monthly_fee: 9, stage: 'live', ended_on: null },
              { id: 'c2', company: 'Prepay', term: '3month', monthly_fee: 9, stage: 'live', ended_on: null }],
    client_months: [{ id: 'm1', client_id: 'c1', month_no: 1 }, { id: 'p3', client_id: 'c2', month_no: 3 }],
  });
  rpcDo = {
    lock_month: (a) => ({ data: tables.client_months.find((m) => m.id === a.p_month), error: null }),
    open_next_month: (a) => { const last = Math.max(...tables.client_months.filter((m) => m.client_id === a.p_client).map((m) => m.month_no));
      const m = { id: a.p_client + '-' + (last + 1), client_id: a.p_client, month_no: last + 1 }; tables.client_months.push(m); return { data: m, error: null }; },
    raise_invoice: () => ({ data: { id: 'inv', amount: 9 }, error: null }),
  };
}

test('two clicks on Lock month open ONE next month, not two', async () => {
  closeFixture(); slow = 5;
  const [a, b] = await Promise.all([F('fnCloseMonth')('m1'), F('fnCloseMonth')('m1')]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(rpcs.filter((r) => r.name === 'open_next_month').length, 1, 'open_next_month is not safe to call twice');
  assert.deepEqual(tables.client_months.filter((m) => m.client_id === 'c1').map((m) => m.month_no), [1, 2], 'no month three that nobody sold');
});

test('Month end says what the close actually did: a 3-month term reaching month 4 is a refusal, not "opened and invoiced"', async () => {
  closeFixture(); toasts = [];
  await F('dgLockMonth')('p3');
  const said = toasts[toasts.length - 1];
  assert.match(said, /Month 3 is locked\./);
  assert.match(said, /nothing has been raised/);
  assert.ok(!/opened and invoiced/.test(said), 'it must not announce a month and an invoice that do not exist');
  assert.equal(rpcs.filter((r) => r.name === 'open_next_month').length, 0);
  /* and the sentence stays on the screen, not only in a toast that fades */
  assert.match(F('dgRenderMonthEnd')({ months: [], held: [], lastClose: F('dg').lastClose }), /nothing has been raised/);
  /* the monthly one says what it did, with the figure */
  closeFixture(); toasts = [];
  await F('dgLockMonth')('m1');
  assert.match(toasts[toasts.length - 1], /month 2 is open, and \$9 is raised as a draft/);
});

test('two clicks on the Lock button run one close', async () => {
  closeFixture(); slow = 5; toasts = [];
  await Promise.all([F('dgLockMonth')('m1'), F('dgLockMonth')('m1')]);
  assert.equal(rpcs.filter((r) => r.name === 'lock_month').length, 1);
  assert.equal(toasts.length, 1, 'and one sentence, not a success followed by an error');
});

test('two clicks on Mark paid make one call, so the refusal of the second cannot replace the success', async () => {
  reset({ invoices: [], refunds: [], clients: [], v_month_standing: [], v_invoice_work: [] });
  rpcDo = { mark_paid: () => ({ data: { invoice_id: 'i1', welcome_sent: false }, error: null }) }; slow = 5; toasts = [];
  await Promise.all([F('moPaidGo')('i1'), F('moPaidGo')('i1')]);
  assert.equal(rpcs.filter((r) => r.name === 'mark_paid').length, 1);
  assert.deepEqual(toasts, ['Marked paid.']);
});

/* ═════════════ a number shown as zero when it was never read ═════════════ */

test('the live view has no refund_due: a missed month reads its refund from at_risk, and says no figure rather than $0', () => {
  const line = F('fnMonthLine');
  assert.equal(line({ month_no: 1, verdict: 'missed', calls_delivered: 4, calls_promised: 5, at_risk: 3000 }), 'Month 1: missed — 4 of 5. $3,000 refunded.');
  assert.equal(line({ month_no: 1, verdict: 'missed', calls_delivered: 4, calls_promised: 5 }), 'Month 1: missed — 4 of 5.', 'never "$0 refunded" for a figure nobody read');
  assert.equal(line({ month_no: 1, verdict: 'missed', calls_delivered: 4, calls_promised: 5, refund_due: 0, at_risk: 9 }), 'Month 1: missed — 4 of 5. $0 refunded.', 'a real zero is still a zero');
});

test('a locked month with no refund row is found from the view as it really is (at_risk, no refund_due)', () => {
  const gaps = F('fnRefundGaps')([
    { month_id: 'm1', client_id: 'c1', company: 'Gap Co', month_no: 1, verdict: 'missed', at_risk: 6000 },
    { month_id: 'm2', client_id: 'c1', company: 'Gap Co', month_no: 2, verdict: 'missed', at_risk: 3000 },
  ], [{ id: 'r2', month_id: 'm2', amount: 3000 }]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].amount, 6000);
});

test('Month end, on the live database: the refund column is the figure, not a dash, and the total is known', async () => {
  reset({
    clients: [{ id: 'c1', company: 'Alder', monthly_fee: 1500, created_at: '2026-01-01' }],
    v_month_standing: [{ month_id: 'm1', client_id: 'c1', month_no: 1, starts_on: '2026-10-21', ends_on: '2026-11-19', calls_promised: 5, calls_delivered: 3, verdict: 'open', locked_at: null, days_left: -8, at_risk: 3000 }],
  });
  const r = await F('dgMonthClose')(new Date('2026-11-27T15:00:00Z'));
  assert.equal(r.data.engine, false, 'v_months_to_close is not there: the fallback');
  assert.equal(r.data.months[0].refundDue, 3000);
  assert.equal(r.data.months[0].multiplierWords, '2x', 'read back off the fee, not decided here');
  assert.equal(r.data.totalRefund, 3000);
  const html = F('dgRenderMonthEnd')(r.data);
  assert.match(html, /Locking all of these would refund \$3,000\./);
  assert.match(html, /Nothing closes a month on its own yet/, 'and it still says what is not switched on');
  assert.match(html, /overflow-x:auto/, 'the table scrolls on a phone instead of cutting the Lock button off');
});

/* ═════════════ refunds: in part, and then the rest ═════════════ */

test('paying 1,000 then 2,000 of a 3,000 refund leaves it paid in full, and overpaying is still refused', async () => {
  const problem = F('fnRefundProblem'), still = F('fnRefundStillOwed');
  const row = { id: 'r1', amount: 3000, status: 'owed' };
  reset({ refunds: [row] });
  rpcDo = { refund_pay: (a) => { row.paid_amount = (row.paid_amount || 0) + a.p_amount; row.status = 'paid'; return { data: Object.assign({}, row), error: null }; } };
  const first = await F('fnMarkRefundPaid')('r1', { amount: 1000, via: 'Wise' });
  assert.equal(first.ok, true);
  assert.equal(still(row), 2000);
  assert.equal(problem(row, { amount: 2000, via: 'Wise' }), '', 'a part-paid refund takes another payment');
  assert.match(problem(row, { amount: 2001, via: 'Wise' }), /more than we owe\. We owe \$2,000/, 'against what is LEFT, not what was first raised');
  const over = await F('fnMarkRefundPaid')('r1', { amount: 2500, via: 'Wise' });
  assert.equal(over.ok, false);
  const second = await F('fnMarkRefundPaid')('r1', { via: 'Wise' });
  assert.equal(second.ok, true);
  assert.equal(rpcs[rpcs.length - 1].args.p_amount, 2000, 'left empty, the amount is what is still owed');
  assert.equal(still(row), 0);
  assert.equal(problem(row, { amount: 1, via: 'Wise' }), 'That refund is already marked paid.');
  const done = await F('fnMarkRefundPaid')('r1', { amount: 1, via: 'Wise' });
  assert.equal(done.ok, false);
});

/* ═════════════ a figure that did not refresh ═════════════ */

test('another screen can tell the clients screen its copy is old, and the next visit reads again', async () => {
  reset({ v_month_standing: [], clients: [] });
  const cb = F('cb');
  F('cbForget')();
  cb.one.a = { at: Date.now(), client: { id: 'a' }, months: [] };
  assert.equal(F('cbStale')('a'), true);
  assert.equal(cb.one.a.stale, true);
  assert.equal(cb.listStale, true);
  cb.one.b = { at: Date.now(), client: { id: 'b' }, months: [] };
  F('cbStale')();
  assert.equal(cb.one.b.stale, true, 'with no id, every page');
  const src = read('clientbook.js');
  assert.match(src, /got\.stale \|\| Date\.now\(\) - \(got\.at \|\| 0\) >= CB_RELOAD_MS\)\) cbRefreshOne\(id\)/, 'the client page re-reads when marked or old');
  assert.match(src, /cb\.listStale \|\| Date\.now\(\) - cb\.at >= CB_RELOAD_MS\)\) cbRefreshAll\(\)/, 'and so does the list, which used to be read once a session');
  /* the screens that change a client's figures say so */
  assert.match(read('meetings.js'), /cbStale\(\)/);
  assert.match(read('digest.js'), /cbStale\(\)/);
  assert.match(read('money.js'), /cbStale\(\)/);
  assert.match(read('portal.js'), /cbStale\(clientId\)/);
  F('cbForget')();
});

test('the invite just made shows in the list on the screen that made it, without wiping the link', () => {
  const src = read('portal.js');
  assert.match(src, /id="ptInviteList"/);
  const made = src.slice(src.indexOf('async function ptInviteFromForm'), src.indexOf('function ptInviteChanged'));
  assert.match(made, /ptShowInviteOnce\(out\.data\);[\s\S]*ptRefreshInviteList\(clientId\)/);
  assert.ok(!/ptRedraw\(\)/.test(made), 'a whole redraw would throw the once-only link away');
  assert.match(read('index.html'), /clientPeople:\{[^}]*back:\(\)=>render\(currentClientId\?'client':'clients'\)/, 'and Back returns to the client he came from');
});

/* ═════════════ a function that works and a button that did not reach it ═════════════ */

test('ending a client goes through the orderly ending: finished months lock, unfinished ones are left', async () => {
  reset({
    clients: [{ id: 'e', company: 'Cedar', stage: 'at_risk', plan: 'starter', term: 'monthly', ended_on: null }],
    client_months: [
      { id: 'e1', client_id: 'e', month_no: 1, starts_on: '2026-09-27', ends_on: '2026-10-26', locked_at: '2026-10-27', refund_due: 3000, calls_promised: 5, calls_delivered: 4 },
      { id: 'e2', client_id: 'e', month_no: 2, starts_on: '2026-10-27', ends_on: '2026-11-25', locked_at: null, refund_due: 0, calls_promised: 5, calls_delivered: 2 },
      { id: 'e3', client_id: 'e', month_no: 3, starts_on: '2026-11-26', ends_on: '2099-12-25', locked_at: null, refund_due: 0, calls_promised: 5, calls_delivered: 0 },
    ],
    refunds: [{ id: 'r1', client_id: 'e', month_id: 'e1', amount: 3000, status: 'owed' }],
    client_stage_history: [], client_events: [], outreach_campaigns: [], outreach_accounts: [],
  });
  rpcDo = {
    recount_month: () => ({ data: 2, error: null }),
    lock_month: (a) => { const m = tables.client_months.find((x) => x.id === a.p_month); m.locked_at = 'now'; m.verdict = 'missed'; m.refund_due = 1500;
      tables.refunds.push({ id: 'r2', client_id: 'e', month_id: m.id, amount: 1500, status: 'owed' }); return { data: m, error: null }; },
  };
  const none = await F('cbMoveStage')('e', 'ended', '');
  assert.equal(none.ok, false);
  assert.match(none.error, /Say why they are leaving/);
  assert.equal(tables.clients[0].stage, 'at_risk', 'nothing was written without a reason');

  const r = await F('cbMoveStage')('e', 'ended', 'Moving in-house');
  assert.equal(r.ok, true);
  assert.deepEqual(rpcs.filter((x) => x.name === 'lock_month').map((x) => x.args.p_month), ['e2'], 'only the month that had finished');
  assert.equal(tables.client_months.find((m) => m.id === 'e3').locked_at, null, 'the running month is left exactly as it was');
  assert.equal(tables.clients[0].stage, 'ended');
  assert.equal(tables.clients[0].end_reason, 'Moving in-house');
  assert.equal(rpcs.some((x) => x.name === 'open_next_month'), false, 'and no new month is opened for somebody leaving');
  const words = F('cbEndingWords')(r.data.ending);
  assert.match(words, /2 finished months are locked\./);
  assert.match(words, /\$4,500 in refunds is owed to them/);
  assert.match(words, /Month 3 had not finished and was left open/);
  assert.equal(tables.client_stage_history.length, 1, 'the move is still in their history');
});

/* ═════════════ the words, and the phone ═════════════ */

test('the commitment board counts in English: one month "is", two "are"', () => {
  const html = (n) => F('guBoardHtml')({ got: true, today: '2026-11-27', running: [], savable: [], lost: [], before: Array(n).fill({}), toClose: Array(n).fill({}),
    promised: { total: 0 }, delivered: { total: 0 }, owed: { total: 0 }, cost: { total: 0 }, closeCost: { total: 0 }, soonest: null,
    dbGot: true, dbOpenMonths: n, dbAtRiskTotal: 0, dbAtRiskMonthOne: 0 });
  assert.match(html(1), /1 month has ended and is still open/);
  assert.match(html(2), /2 months have ended and are still open/);
  assert.match(html(2), /2 months have been bought and have not started/);
  assert.match(html(1), /across 1 open month,/);
  assert.match(html(2), /across 2 open months,/);
});

test('the tiles on Money and on the board take their ground from the theme, so dark mode is not white on white', () => {
  for (const f of ['money.css', 'guarantee.css']) {
    const css = read(f);
    assert.ok(!/background:var\(--mist,#F6F7F9\)/.test(css), f + ': --mist is defined nowhere, so this was always the light colour');
    assert.match(css, /background:var\(--mist,var\(--surface-2,#F6F7F9\)\)/);
  }
  assert.ok(!/font-size:\.6\drem/.test(read('guarantee.css')), 'no label under 11px');
});

test('Ending at phone width: the Why heading hides with its cell, and what is outstanding is never hidden', () => {
  const wu = F('wu');
  wu.ending = [{ client: { id: 'g', company: 'Left Co', stage: 'ended', ended_on: '2026-11-10', end_reason: 'Capacity' }, net: -1500, owedToUs: 0, owedToThem: 1500, unlocked: [] }];
  wu.endingErr = '';
  const html = F('viewEnding')();
  assert.match(html, /<th class="wu-why">Why<\/th>/);
  assert.match(html, /<td class="wu-out">\$1,500 to refund<\/td>/);
  assert.equal((html.match(/class="wu-why"/g) || []).length, 2, 'one heading, one cell');
  assert.match(html, /overflow-x:auto/);
});

test('a cancelled call is not "waiting for an answer"', () => {
  const src = read('meetings.js');
  assert.match(src, /status === 'cancelled' && !call\.verdict_at \? 'Not counted: the call was cancelled\.'/);
});
