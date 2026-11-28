/* Finance — the money. Everything here is the part that decides what a client
   pays and what we owe them back, so it is tested against a fake database
   rather than trusted. The rules themselves live in Postgres (see
   supabase/migrations); these tests check that finance.js asks for them
   correctly, never invents a price, and never throws. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(import.meta.dirname, '..');

/* ───────────── a fake supabase ───────────── */
let calls, tables, rpcs, failWith, rpcAnswer;

function builder(tableName) {
  const q = { table: tableName, filters: [], payload: null, op: null, cols: null };
  calls.push(q);
  const settle = async () => {
    if (failWith) return { data: null, error: failWith };
    const rows = tables[tableName];
    if (rows === undefined) return { data: null, error: { message: 'no such table: ' + tableName } };
    return { data: rows, error: null };
  };
  const api = {
    select(c) { q.cols = c; return api; },
    insert(p) { q.op = 'insert'; q.payload = p; return api; },
    update(p) { q.op = 'update'; q.payload = p; return api; },
    upsert(p) { q.op = 'upsert'; q.payload = p; return api; },
    eq(k, v) { q.filters.push([k, v]); return api; },
    in(k, v) { q.filters.push([k, v]); return api; },
    is(k, v) { q.filters.push([k, v]); return api; },
    lte(k, v) { q.filters.push([k, v]); return api; },
    gte(k, v) { q.filters.push([k, v]); return api; },
    order() { return api; },
    limit() { return api; },
    async single() { const r = await settle(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    async maybeSingle() { const r = await settle(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; },
    then(res, rej) { return settle().then(res, rej); },
  };
  return api;
}

const fakeSb = {
  from: builder,
  async rpc(name, args) {
    rpcs.push({ name, args });
    if (failWith) return { data: null, error: failWith };
    if (rpcAnswer && name in rpcAnswer) return { data: rpcAnswer[name], error: null };
    return { data: { id: 'm-new', month_no: 1 }, error: null };
  },
};

function reset() {
  calls = []; rpcs = []; failWith = null; rpcAnswer = null;
  tables = {
    plan_prices: [
      /* a row left over from a withdrawn plan: finance.js must never hand it on */
      { plan: 'pilot',   label: 'Old plan',  calls_promised: 2,  monthly_fee: 300,  three_month_fee: null,  is_recurring: false },
      { plan: 'starter', label: 'Starter',   calls_promised: 5,  monthly_fee: 1500, three_month_fee: 1200,  is_recurring: true },
      { plan: 'growth',  label: 'Growth',    calls_promised: 10, monthly_fee: 3000, three_month_fee: 2400,  is_recurring: true },
      { plan: 'scale',   label: 'Scale',     calls_promised: 15, monthly_fee: 4500, three_month_fee: 3600,  is_recurring: true },
    ],
    clients: [{ id: 'c1', company: 'Acme', stage: 'won' }],
    client_months: [{ id: 'm1', client_id: 'c1', month_no: 1 }],
    qualified_calls: [{ id: 'q1', client_id: 'c1' }],
    invoices: [{ id: 'i1', client_id: 'c1', number: '1001' }],
    refunds: [{ id: 'r1', client_id: 'c1', amount: 4994 }],
    v_money: [{ invoiced: 10000, paid: 7000, owed: 3000 }],
    v_exposure: [{ client_id: 'c1', at_risk: 4994 }],
    v_month_standing: [{ client_id: 'c1', month_no: 1, calls_promised: 10, calls_delivered: 4, days_left: 9, verdict: 'open', refund_due: 0 }],
    v_invoice_work: [{ month_id: 'm1', client_id: 'c1' }],
  };
}

/* load finance.js with the fake shell it expects */
globalThis.sb = fakeSb;
globalThis.esc = (s) => String(s == null ? '' : s);
reset();
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'finance.js'), 'utf8'), { filename: 'finance.js' });

const F = (n) => vm.runInThisContext(n);
const find = (table, op) => calls.find((c) => c.table === table && (!op || c.op === op));

/* ───────────── the contract ───────────── */

test('every function returns {ok,data,error} and never throws', async () => {
  const names = Object.keys(vm.runInThisContext('this'))
    .filter((k) => /^fn[A-Z]/.test(k) && typeof F(k) === 'function');
  assert.ok(names.length > 15, 'expected the finance functions to be on the shell');

  for (const n of ['fnMoney', 'fnExposure', 'fnPlans', 'fnClients', 'fnStanding', 'fnCalls', 'fnInvoices', 'fnRefunds', 'fnInvoiceWork']) {
    reset();
    const r = await F(n)();
    assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok'], n + ' shape');
    assert.equal(r.ok, true, n + ': ' + r.error);
  }
});

test('a database error comes back as a plain sentence, not a throw', async () => {
  for (const n of ['fnMoney', 'fnPlans', 'fnClients', 'fnInvoices', 'fnRefunds']) {
    reset();
    failWith = { message: 'connection refused' };
    const r = await F(n)();
    assert.equal(r.ok, false, n + ' should fail');
    assert.equal(r.data, null);
    assert.ok(r.error.length > 0 && !/\[object/.test(r.error), n + ' error text: ' + r.error);
  }
});

test('nothing in the database reads as empty, not as a crash', async () => {
  reset();
  for (const k of Object.keys(tables)) tables[k] = [];
  for (const n of ['fnMoney', 'fnExposure', 'fnPlans', 'fnClients', 'fnInvoices', 'fnRefunds', 'fnInvoiceWork']) {
    const r = await F(n)();
    assert.equal(r.ok, true, n + ': ' + r.error);
    assert.ok(r.data !== undefined, n + ' gave undefined');
  }
});

/* ───────────── the offer: three plans, priced by the database ───────────── */

test('the price list is the three plans on offer, at the offer\'s prices, cheapest first', async () => {
  reset();
  const r = await F('fnPlans')();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.map((p) => [p.plan, p.calls_promised, p.monthly_fee, p.three_month_fee, p.three_month_fee * 3]), [
    ['starter', 5, 1500, 1200, 3600],
    ['growth', 10, 3000, 2400, 7200],
    ['scale', 15, 4500, 3600, 10800],
  ]);
  assert.deepEqual(F('FN_PLANS'), ['starter', 'growth', 'scale']);
  for (const p of r.data) assert.equal(p.three_month_fee, p.monthly_fee * 0.8, p.plan + ': the 3-month term is 20% off');
});

test('a withdrawn plan code is never priced, offered or named, and a row for it is left out of the price list', async () => {
  reset();
  const r = await F('fnPlans')();
  assert.ok(!r.data.some((p) => p.plan === 'pilot'), 'the leftover row is not handed on');
  assert.equal(F('fnPlanRetired')('pilot'), true);
  assert.equal(F('fnPlanRetired')('PILOT'), true);
  for (const p of ['starter', 'growth', 'scale', '', null, undefined, 'platinum']) assert.equal(F('fnPlanRetired')(p), false, String(p));
  assert.equal(F('fnPlanOffered')('pilot'), false);
  assert.equal(F('fnPlanOffered')('Growth'), true);
  assert.equal(F('fnPlanOffered')('platinum'), false);
  assert.equal(F('fnPlanWord')('pilot'), 'Retired plan', 'old data reads safely, without the old name');
  assert.deepEqual(['starter', 'growth', 'scale', 'platinum', null].map(F('fnPlanWord')), ['Starter', 'Growth', 'Scale', '', '']);
  assert.equal(F('FN_RETIRED_SAYS'), 'That plan is retired. Pick Starter, Growth or Scale.');
  /* a price list that fails still fails in words. CHANGED in the plain-words
     pass: this used to assert the raw 'connection refused' reached the screen.
     A refused connection IS the connection, so he is now told that and what to
     do about it, rather than being handed the plumbing's own word for it. */
  failWith = { message: 'connection refused' };
  assert.deepEqual(await F('fnPlans')(),
    { ok: false, data: null, error: "Can't reach the server right now. Check your connection and try again." });
});

test('finance.js knows the withdrawn code in exactly one place, and carries no credit for it', () => {
  const src = fs.readFileSync(path.join(root, 'finance.js'), 'utf8');
  assert.equal((src.match(/pilot/gi) || []).length, 1, 'one guard, nothing else');
  assert.ok(src.includes("const FN_RETIRED_PLANS = ['pilot'];"));
  /* "credit" now means one thing only: the free month the agreement owes a
     client, applied against their next invoice. The withdrawn pilot's credit
     is gone, and this keeps it gone — every use here is the free month. */
  for (const m of src.match(/.{0,40}credit.{0,40}/gi) || []) {
    assert.ok(!/pilot/i.test(m), 'no pilot credit: ' + m);
  }
  assert.equal(typeof globalThis.fnAddClient, 'undefined', 'the unused add-a-client path is gone; close_won makes clients');
});

test('finance.js contains no hard-coded plan price', () => {
  const src = fs.readFileSync(path.join(root, 'finance.js'), 'utf8');
  for (const n of ['300', '1500', '3000', '4500', '1200', '2400', '3600', '7200', '10800', '1,500', '3,000', '4,500']) {
    assert.ok(!new RegExp('(^|[^0-9])' + n + '([^0-9]|$)').test(src), 'finance.js hard-codes the price ' + n);
  }
});

/* ───────────── the rules stay in the database ───────────── */

test('opening, recounting and locking a month all go to the database rule', async () => {
  reset(); await F('fnOpenMonth')('c1');
  assert.equal(rpcs.at(-1).name, 'open_next_month');
  reset(); await F('fnRecount')('m1');
  assert.equal(rpcs.at(-1).name, 'recount_month');
  reset(); await F('fnLockMonth')('m1');
  assert.equal(rpcs.at(-1).name, 'lock_month');
  reset(); await F('fnRaiseInvoice')('m1', 7);
  assert.equal(rpcs.at(-1).name, 'raise_invoice');
});

test('finance.js never works out a refund itself', () => {
  const src = fs.readFileSync(path.join(root, 'finance.js'), 'utf8');
  assert.ok(!/refund_due\s*=/.test(src), 'a refund is being set in JavaScript');
  assert.ok(!/\*\s*2\b|\bmult/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'the 2x multiplier is being applied in JavaScript');
});

/* ───────────── a call only counts when it is real ───────────── */

test('a logged call defaults to matching the profile but NOT to having happened', async () => {
  reset();
  await F('fnLogCall')('c1', { name: 'Dana', bookedFor: '2026-12-01T15:00:00Z' });
  const ins = find('qualified_calls', 'insert');
  assert.equal(ins.payload.matched_icp, true);
  assert.equal(ins.payload.happened, false, 'a call must not count until someone turns up');
  assert.equal(ins.payload.happened_at, null);
});

test('a call logged off-profile stays off-profile', async () => {
  reset();
  await F('fnLogCall')('c1', { bookedFor: '2026-12-01T15:00:00Z', matchedIcp: false });
  assert.equal(find('qualified_calls', 'insert').payload.matched_icp, false);
});

test('marking a call as happened is what moves the number', async () => {
  reset();
  await F('fnCallHappened')('q1', '2026-12-01T15:30:00Z');
  const up = find('qualified_calls', 'update');
  assert.equal(up.payload.happened, true);
  assert.equal(up.payload.happened_at, '2026-12-01T15:30:00Z');
});

test('a dispute is held aside, not decided, and the reason is kept short', async () => {
  reset();
  const r = await F('fnDisputeCall')('q1', 'x'.repeat(900));
  assert.equal(r.ok, true, r.error);
  const up = find('qualified_calls', 'update');
  assert.equal(up.payload.dispute_status, 'raised');
  assert.equal(up.payload.dispute_reason.length, 600);
});

test('settling a dispute accepts only upheld or rejected', async () => {
  reset(); await F('fnSettleDispute')('q1', 'upheld');
  assert.equal(find('qualified_calls', 'update').payload.dispute_status, 'upheld');
  reset(); await F('fnSettleDispute')('q1', 'whatever');
  assert.equal(find('qualified_calls', 'update').payload.dispute_status, 'rejected');
});

/* ───────────── starting a client ───────────── */

test('starting a client sets day one and opens month one together', async () => {
  reset();
  const r = await F('fnStartSending')('c1', '2026-12-01');
  assert.equal(r.ok, true, r.error);
  const up = find('clients', 'update');
  assert.equal(up.payload.day1_on, '2026-12-01');
  assert.equal(up.payload.stage, 'live');
  /* The database opens month one itself when day one is first saved (clients_first_month). The browser
     reads it back and must NOT call open_next_month as well: that always opens the month AFTER the
     last one, so a second call would open month two on launch day. */
  assert.equal(r.data.month.id, 'm1', 'month one is the one the database opened');
  assert.equal(rpcs.length, 0, 'no second month is opened from the browser');
});

test('on a database that did not open month one, the browser still does', async () => {
  reset();
  tables.client_months = [];
  const r = await F('fnStartSending')('c1', '2026-12-01');
  assert.equal(r.ok, true, r.error);
  assert.equal(rpcs.length, 1);
  assert.equal(rpcs[0].name, 'open_next_month');
  assert.equal(r.data.month.id, 'm-new');
});

test('if day one cannot be saved, no month is opened', async () => {
  reset();
  failWith = { message: 'nope' };
  const r = await F('fnStartSending')('c1', '2026-12-01');
  assert.equal(r.ok, false);
  assert.equal(rpcs.length, 0, 'a month was opened against a client whose day one never saved');
});

/* ───────────── the words a client reads ───────────── */

test('the month sentence says the same thing on our screen and theirs', () => {
  const line = F('fnMonthLine');
  assert.match(line({ month_no: 1, verdict: 'hit', calls_delivered: 10, calls_promised: 10 }), /hit — 10 of 10/);
  assert.match(line({ month_no: 1, verdict: 'missed', calls_delivered: 6, calls_promised: 10, refund_due: 4994 }), /missed — 6 of 10\. \$4,994 refunded/);
  assert.match(line({ month_no: 2, verdict: 'open', calls_delivered: 4, calls_promised: 20, days_left: 9 }), /4 of 20 calls, 9 days left/);
  assert.match(line({ month_no: 2, verdict: 'open', calls_delivered: 4, calls_promised: 20, days_left: 1 }), /1 day left/);
  assert.match(line({ month_no: 2, verdict: 'open', calls_delivered: 4, calls_promised: 20, days_left: 0 }), /last day/);
  assert.match(line({ month_no: 2, verdict: 'open', calls_delivered: 4, calls_promised: 20, days_left: -3 }), /the month has ended/);
  assert.equal(line(null), '');
  // a view row that leaves a number out must never read as "undefined" or "null" to a client
  const thin = line({ month_no: 3, verdict: 'open' });
  assert.equal(thin, 'Month 3: 0 of 0 calls, the month is still running.');
  assert.doesNotMatch(thin, /undefined|null|NaN/);
  assert.doesNotMatch(line({ verdict: 'hit' }), /undefined|null|NaN/);
  assert.doesNotMatch(line({ month_no: 1, verdict: 'missed' }), /undefined|null|NaN/);
});

test('money is written the way a person reads it', () => {
  const usd = F('fnUsd');
  assert.equal(usd(4994), '$4,994');
  assert.equal(usd(0), '$0');
  assert.equal(usd(null), '$0');
  assert.equal(usd('2497.6'), '$2,498');
});

/* ───────────── paid goes through the database rule ───────────── */

test('fnMarkInvoicePaid calls mark_paid and never writes the invoices table itself', async () => {
  reset();
  rpcAnswer = { mark_paid: { invoice_id: 'i-1', client_id: 'c-1', welcome_sent: true } };
  const r = await F('fnMarkInvoicePaid')('i-1', '  Wise  ');
  assert.deepEqual(r, { ok: true, data: { invoice_id: 'i-1', client_id: 'c-1', welcome_sent: true }, error: '' });
  assert.deepEqual(rpcs.at(-1), { name: 'mark_paid', args: { p_invoice: 'i-1', p_via: 'Wise' } });
  assert.equal(calls.filter((c) => c.table === 'invoices').length, 0, 'no direct table update');
  assert.equal(F('fnPaidWords')(r.data), 'Paid. The welcome email and their way in are on their way.');

  await F('fnMarkInvoicePaid')('i-2');
  assert.deepEqual(rpcs.at(-1).args, { p_invoice: 'i-2', p_via: null }, 'no way of paying given: the rule decides');
  assert.equal(F('fnPaidWords')({ welcome_sent: false }), 'Marked paid.');
  assert.equal(F('fnPaidWords')(null), 'Marked paid.');
  assert.equal(F('fnPaidWords')({ welcome_sent: 'yes' }), 'Marked paid.', 'only a real true counts');

  const n = rpcs.length;
  assert.equal((await F('fnMarkInvoicePaid')('')).ok, false);
  assert.equal(rpcs.length, n, 'nothing is asked without an invoice');
  failWith = { message: 'Only the owner can mark an invoice paid.' };
  assert.deepEqual(await F('fnMarkInvoicePaid')('i-1'), { ok: false, data: null, error: 'Only the owner can mark an invoice paid.' });
  const src = fs.readFileSync(path.join(root, 'finance.js'), 'utf8');
  const body = src.slice(src.indexOf('async function fnMarkInvoicePaid'), src.indexOf('function fnPaidWords'));
  assert.ok(body.includes("sb.rpc('mark_paid'") && !body.includes('.update('), 'the old invoice update is gone');
});

/* ───────────── it stands alone ───────────── */

test('finance.js calls no other server', () => {
  const src = fs.readFileSync(path.join(root, 'finance.js'), 'utf8');
  for (const bad of ['machineFetch', 'MACHINE_URL', 'email-distributor', 'fetch(']) {
    assert.ok(!src.includes(bad), 'finance.js still contains ' + bad);
  }
});

/* ───────────── a direct write to a call must still move the month ─────────────
   There is no trigger on qualified_calls, and `counts` is a generated column:
   the call row goes right at once but client_months.calls_delivered does not
   move unless something recounts. Checked live on the real database
   (2026-11-26): after `update qualified_calls set happened = true` the call
   counted and client_months.calls_delivered was still 0, and v_month_standing
   showed the stale 0 to every screen. Each of these four writes now recounts. */

test('every direct write to a call recounts the month it belongs to', async () => {
  const row = { id: 'q1', client_id: 'c1', booked_for: '2026-12-01T15:00:00Z', happened_at: '2026-12-01T15:00:00Z', counts: true };
  for (const [name, args] of [
    ['fnCallHappened', ['q1', '2026-12-01T15:30:00Z']],
    ['fnDisputeCall', ['q1', 'they never joined']],
    ['fnSettleDispute', ['q1', 'upheld']],
  ]) {
    reset();
    tables.qualified_calls = [row];
    tables.client_months = [{ id: 'm1' }];
    const r = await F(name)(...args);
    assert.equal(r.ok, true, name + ': ' + r.error);
    assert.ok(calls.some((c) => c.table === 'client_months' && c.op === null),
      name + ' must look up the months the call touches');
    assert.deepEqual(rpcs.filter((x) => x.name === 'recount_month'), [{ name: 'recount_month', args: { p_month: 'm1' } }],
      name + ' must recount that month exactly once');
  }
});

test('a logged call that already counts recounts; one that cannot count does not', async () => {
  reset();
  tables.qualified_calls = [{ id: 'q9', client_id: 'c1', booked_for: '2026-12-01T15:00:00Z', happened_at: '2026-12-01T15:00:00Z', counts: true }];
  tables.client_months = [{ id: 'm1' }];
  await F('fnLogCall')('c1', { bookedFor: '2026-12-01T15:00:00Z', happened: true });
  assert.equal(rpcs.filter((x) => x.name === 'recount_month').length, 1, 'a call that counts moves the month');

  reset();
  tables.qualified_calls = [{ id: 'q9', client_id: 'c1', booked_for: '2026-12-01T15:00:00Z', counts: false }];
  tables.client_months = [{ id: 'm1' }];
  await F('fnLogCall')('c1', { bookedFor: '2026-12-01T15:00:00Z' });
  assert.equal(rpcs.filter((x) => x.name === 'recount_month').length, 0, 'nothing counts yet, so no month moved');
});

test('the recount never touches a locked month, and asks for nothing it cannot place', async () => {
  reset();
  tables.client_months = [{ id: 'm1' }];
  /* the query must exclude a locked month itself: the database refuses anyway,
     but asking for it would hide a real month behind a wasted round trip */
  await F('fnRecountAround')('c1', '2026-12-01T15:00:00Z');
  const q = find('client_months');
  assert.ok(q.filters.some((f) => f[0] === 'locked_at' && f[1] === null), 'only unlocked months');
  assert.ok(q.filters.some((f) => f[0] === 'client_id' && f[1] === 'c1'), 'only this client');

  reset();
  assert.deepEqual(await F('fnRecountAround')(null, '2026-12-01T15:00:00Z'), { ok: true, data: 0, error: '' });
  assert.deepEqual(await F('fnRecountAround')('c1', null), { ok: true, data: 0, error: '' });
  assert.deepEqual(await F('fnRecountAround')('c1', 'not a time'), { ok: true, data: 0, error: '' });
  assert.equal(calls.length, 0, 'nothing is asked when there is nothing to place');
});

test('a failed recount never turns a write that worked into an error', async () => {
  reset();
  tables.qualified_calls = [{ id: 'q1', client_id: 'c1', booked_for: '2026-12-01T15:00:00Z', happened_at: '2026-12-01T15:00:00Z' }];
  delete tables.client_months;                      // the months cannot be read
  const r = await F('fnCallHappened')('q1', '2026-12-01T15:30:00Z');
  assert.equal(r.ok, true, 'the call was written, so the answer is yes');
  assert.equal(r.data.id, 'q1');
});

/* fnStanding reads every client-month. Past one page PostgREST answers short and says
   nothing, so months silently go missing from every total. It must page, and it must
   refuse out loud rather than pass a part off as the whole. */
test('fnStanding source pages its read and fails loudly at the ceiling', () => {
  const src = fs.readFileSync(new URL('../finance.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function fnStanding'), src.indexOf('function fnStanding') + 900);
  assert.match(body, /fnPaged\(/, 'reads a page at a time');
  assert.match(body, /\.order\('month_id'\)/, 'a unique tie-break, so a page cannot repeat or skip a month');
  const pager = src.slice(src.indexOf('async function fnPaged'), src.indexOf('async function fnPaged') + 900);
  assert.match(pager, /rows\.length < FN_PAGE/, 'stops on a short page');
  assert.match(pager, /not showing a part of them as the whole/, 'refuses in words at the ceiling');
});
