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
let calls, tables, rpcs, failWith;

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
    return { data: { id: 'm-new', month_no: 1 }, error: null };
  },
};

function reset() {
  calls = []; rpcs = []; failWith = null;
  tables = {
    plan_prices: [
      { plan: 'pilot',   label: 'The Pilot', calls_promised: 2,  monthly_fee: 300,  three_month_fee: 0,     is_recurring: false },
      { plan: 'starter', label: 'Starter',   calls_promised: 10, monthly_fee: 2497, three_month_fee: 2247,  is_recurring: true },
      { plan: 'growth',  label: 'Growth',    calls_promised: 20, monthly_fee: 3997, three_month_fee: 3597,  is_recurring: true },
      { plan: 'scale',   label: 'Scale',     calls_promised: 50, monthly_fee: 8497, three_month_fee: 7647,  is_recurring: true },
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
vm.runInThisContext(fs.readFileSync(path.join(root, 'finance.js'), 'utf8'), { filename: 'finance.js' });

const F = (n) => vm.runInThisContext(n);
const find = (table, op) => calls.find((c) => c.table === table && (!op || c.op === op));

/* ───────────── the contract ───────────── */

test('every function returns {ok,data,error} and never throws', async () => {
  const names = Object.keys(vm.runInThisContext('this'))
    .filter((k) => /^fn[A-Z]/.test(k) && typeof F(k) === 'function');
  assert.ok(names.length > 15, 'expected the finance functions to be on the shell');

  for (const n of ['fnMoney', 'fnExposure', 'fnPlans', 'fnClients', 'fnStanding', 'fnBehind', 'fnCalls', 'fnInvoices', 'fnRefunds', 'fnInvoiceWork']) {
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
  for (const n of ['fnMoney', 'fnExposure', 'fnPlans', 'fnClients', 'fnBehind', 'fnInvoices', 'fnRefunds', 'fnInvoiceWork']) {
    const r = await F(n)();
    assert.equal(r.ok, true, n + ': ' + r.error);
    assert.ok(r.data !== undefined, n + ' gave undefined');
  }
});

/* ───────────── the price never comes from the code ───────────── */

test('a new client takes its price and its promise from plan_prices', async () => {
  reset();
  const r = await F('fnAddClient')({ company: 'Beta', contactName: 'Sam', contactEmail: 's@beta.com', plan: 'growth', term: 'monthly' });
  assert.equal(r.ok, true, r.error);
  const ins = find('clients', 'insert');
  assert.equal(ins.payload.monthly_fee, 3997);
  assert.equal(ins.payload.calls_promised, 20);
  assert.equal(ins.payload.plan, 'growth');
});

test('a three-month term takes the lower three-month price', async () => {
  reset();
  await F('fnAddClient')({ company: 'Beta', contactName: 'Sam', contactEmail: 's@beta.com', plan: 'growth', term: '3month' });
  const ins = find('clients', 'insert');
  assert.equal(ins.payload.monthly_fee, 3597);
  assert.equal(ins.payload.term, '3month');
});

test('a plan that does not exist is refused in words', async () => {
  reset();
  const r = await F('fnAddClient')({ company: 'Beta', contactName: 'Sam', contactEmail: 's@beta.com', plan: 'platinum', term: 'monthly' });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not exist/i);
  assert.equal(find('clients', 'insert'), undefined, 'nothing should have been written');
});

test('the pilot is 2 calls for $300 and does not recur', async () => {
  reset();
  const r = await F('fnPlans')();
  const p = r.data.find((x) => x.plan === 'pilot');
  assert.equal(p.monthly_fee, 300);
  assert.equal(p.calls_promised, 2);
  assert.equal(p.is_recurring, false);
});

test('finance.js contains no hard-coded plan price', () => {
  const src = fs.readFileSync(path.join(root, 'finance.js'), 'utf8');
  for (const n of ['2497', '3997', '8497', '2247', '3597', '7647']) {
    assert.ok(!src.includes(n), 'finance.js hard-codes the price ' + n);
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
  assert.equal(rpcs.at(-1).name, 'open_next_month', 'month one must open in the same breath');
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
});

test('money is written the way a person reads it', () => {
  const usd = F('fnUsd');
  assert.equal(usd(4994), '$4,994');
  assert.equal(usd(0), '$0');
  assert.equal(usd(null), '$0');
  assert.equal(usd('2497.6'), '$2,498');
});

/* ───────────── it stands alone ───────────── */

test('finance.js calls no other server', () => {
  const src = fs.readFileSync(path.join(root, 'finance.js'), 'utf8');
  for (const bad of ['machineFetch', 'MACHINE_URL', 'email-distributor', 'fetch(']) {
    assert.ok(!src.includes(bad), 'finance.js still contains ' + bad);
  }
});
