/* The money loop: a late invoice, a refund that is OWED becoming a refund that
   was PAID, the reconciliation between the two piles, and what happens at the
   end of a month — including the one case the owner has not decided, where the
   system must refuse out loud instead of guessing.

   Nothing here works out a price or a refund: every figure is the database's and
   these tests prove the browser only reads, sorts, words and refuses. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(import.meta.dirname, '..');

/* ───────────── a fake supabase ───────────── */
let calls, rpcs, tables, rpcAnswer, rpcError, failWith;

function builder(tableName) {
  const q = { table: tableName, filters: [], payload: null, op: 'select' };
  calls.push(q);
  const settle = async () => {
    if (failWith) return { data: null, error: failWith };
    let rows = tables[tableName];
    if (rows === undefined) return { data: null, error: { message: 'no such table: ' + tableName } };
    if (Array.isArray(rows)) {
      q.filters.forEach(([k, v]) => { rows = rows.filter((r) => String(r[k]) === String(v)) });
    }
    return { data: rows, error: null };
  };
  const api = {
    select() { return api }, insert(p) { q.op = 'insert'; q.payload = p; return api },
    update(p) { q.op = 'update'; q.payload = p; return api },
    eq(k, v) { q.filters.push([k, v]); return api }, is(k, v) { q.filters.push([k, v]); return api },
    in(k, v) { q.filters.push([k, v]); return api },
    lte(k, v) { return api }, gte(k, v) { return api }, order() { return api }, limit() { return api },
    async single() { const r = await settle(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error } },
    async maybeSingle() { const r = await settle(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error } },
    then(res, rej) { return settle().then(res, rej) },
  };
  return api;
}
const fakeSb = {
  from: builder,
  async rpc(name, args) {
    rpcs.push({ name, args });
    if (rpcError && name in rpcError) return { data: null, error: rpcError[name] };
    if (rpcAnswer && name in rpcAnswer) return { data: rpcAnswer[name], error: null };
    return { data: null, error: null };
  },
};

/* a late invoice, an unsent one, a paid one, a void one */
const TODAY = '2026-11-27';
function reset() {
  calls = []; rpcs = []; rpcAnswer = null; rpcError = null; failWith = null;
  tables = {
    clients: [
      { id: 'c1', company: 'Acme Freight', plan: 'growth', term: 'monthly', monthly_fee: 1, stage: 'live', ended_on: null },
      { id: 'c2', company: 'Prepay Ltd', plan: 'growth', term: '3month', monthly_fee: 1, stage: 'live', ended_on: null },
      { id: 'c3', company: 'Gone & Co', plan: 'starter', term: 'monthly', monthly_fee: 1, stage: 'ended', ended_on: '2026-11-01' },
    ],
    client_months: [
      { id: 'm1', client_id: 'c1', month_no: 1 },
      { id: 'm2c2', client_id: 'c2', month_no: 3 },
    ],
    invoices: [
      { id: 'i-late', client_id: 'c1', number: 'AV-1', amount: 40, status: 'sent', sent_at: '2026-10-17T00:00:00Z', due_on: '2026-10-18', paid_at: null },
      { id: 'i-week', client_id: 'c1', number: 'AV-2', amount: 10, status: 'sent', sent_at: '2026-11-01T00:00:00Z', due_on: '2026-11-24', paid_at: null },
      { id: 'i-soon', client_id: 'c2', number: 'AV-3', amount: 20, status: 'sent', sent_at: '2026-11-20T00:00:00Z', due_on: '2026-12-04', paid_at: null },
      { id: 'i-draft', client_id: 'c2', number: 'AV-4', amount: 70, status: 'draft', sent_at: null, due_on: '2026-12-04', paid_at: null },
      { id: 'i-paid', client_id: 'c2', number: 'AV-5', amount: 30, status: 'paid', due_on: '2026-10-01', paid_at: '2026-09-30T00:00:00Z' },
      { id: 'i-void', client_id: 'c1', number: 'AV-6', amount: 999, status: 'void', due_on: '2026-01-01', paid_at: null },
    ],
    refunds: [
      { id: 'r-owed', client_id: 'c1', month_id: 'm1', amount: 50, multiplier: 2, reason: 'missed_month_one', status: 'owed', notes: 'Month 1: 3 of 10 calls delivered.', paid_at: null, paid_via: null },
      { id: 'r-paid', client_id: 'c2', month_id: null, amount: 20, multiplier: 1, reason: 'missed_month', status: 'paid', paid_at: '2026-11-10T00:00:00Z', paid_via: 'Wise', paid_amount: 20, paid_reference: 'WZ-77' },
      { id: 'r-part', client_id: 'c2', month_id: null, amount: 20, multiplier: 1, reason: 'missed_month', status: 'paid', paid_at: '2026-11-10T00:00:00Z', paid_via: 'Wise', paid_amount: 8, paid_reference: null },
      { id: 'r-gone', client_id: 'c3', month_id: null, amount: 15, multiplier: 1, reason: 'missed_month', status: 'owed', paid_at: null, paid_via: null },
    ],
    v_month_standing: [
      { month_id: 'm1', client_id: 'c1', company: 'Acme Freight', month_no: 1, verdict: 'missed', refund_due: 50 },
      { month_id: 'm9', client_id: 'c1', company: 'Acme Freight', month_no: 2, verdict: 'missed', refund_due: 60 },
      { month_id: 'm8', client_id: 'c2', company: 'Prepay Ltd', month_no: 1, verdict: 'open', refund_due: 0 },
    ],
    v_invoice_work: [
      { id: 'i-late', company: 'Acme Freight', days_overdue: 40 },
      { id: 'i-draft', company: 'Prepay Ltd', days_overdue: -7 },
    ],
    v_money: [{}], v_exposure: [{}], plan_prices: [],
  };
}

globalThis.sb = fakeSb;
globalThis.esc = (s) => String(s == null ? '' : s);
reset();
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'finance.js'), 'utf8'), { filename: 'finance.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'money.js'), 'utf8'), { filename: 'money.js' });
const F = (n) => vm.runInThisContext(n);

/* ═══════════════ 1. how late a payment is ═══════════════ */

test('how many days late, counted off the due date and nothing else', () => {
  const late = F('fnDaysLate');
  assert.equal(late('2026-10-18', TODAY), 40);
  assert.equal(late('2026-11-27', TODAY), 0);
  assert.equal(late('2026-12-04', TODAY), -7);
  /* no due date is NOT nought days late, and must never read as it */
  assert.equal(late(null, TODAY), null);
  assert.equal(late('', TODAY), null);
  assert.equal(late('not a date', TODAY), null);
});

test('the bands are worst first and every day lands in exactly one', () => {
  const band = F('fnAgeBand');
  assert.equal(band(400).key, 'over30');
  assert.equal(band(31).key, 'over30');
  assert.equal(band(30).key, 'late30');
  assert.equal(band(8).key, 'late30');
  assert.equal(band(7).key, 'late7');
  assert.equal(band(1).key, 'late7');
  assert.equal(band(0).key, 'duenow');
  assert.equal(band(-1).key, 'soon');
  assert.equal(band(null).key, 'nodate');
  const bands = F('FN_AGE_BANDS');
  assert.deepEqual(bands.map((b) => b.key), ['over30', 'late30', 'late7', 'duenow', 'soon']);
});

test('an invoice raised and never sent is stuck on our side, not late on theirs', () => {
  const unsent = F('fnInvoiceUnsent'), owed = F('fnInvoiceOwed');
  const draft = tables.invoices.find((i) => i.id === 'i-draft');
  assert.equal(unsent(draft), true);
  assert.equal(owed(draft), true);
  assert.equal(unsent(tables.invoices.find((i) => i.id === 'i-late')), false);
  /* paid and void are owed by nobody */
  assert.equal(owed(tables.invoices.find((i) => i.id === 'i-paid')), false);
  assert.equal(owed(tables.invoices.find((i) => i.id === 'i-void')), false);
  /* a row half-written by hand: paid_at and no status word still reads as paid */
  assert.equal(owed({ status: '', paid_at: '2026-01-01T00:00:00Z' }), false);
  assert.match(F('fnOwedLine')(draft, TODAY), /raised and never sent/);
});

test('every unpaid invoice is banded once, with a total the owner can read', async () => {
  reset();
  const aged = F('fnAgeInvoices')(tables.invoices, TODAY);
  assert.equal(aged.count, 4, 'the paid one and the void one are not owed');
  assert.equal(aged.total, 40 + 10 + 20 + 70);
  assert.equal(aged.lateTotal, 50, 'only the two past their due date');
  assert.equal(aged.lateCount, 2);
  assert.equal(aged.oldest, 40);
  assert.equal(aged.unsentTotal, 70);
  assert.deepEqual(aged.bands.map((b) => b.key), ['over30', 'late7', 'soon']);
  /* the same invoice arriving from both reads is counted once */
  const twice = F('fnAgeInvoices')(tables.invoices.concat(tables.invoices), TODAY);
  assert.equal(twice.total, aged.total);
});

test('who owes us reads the invoices and the view, and names the client', async () => {
  reset();
  const r = await F('fnOwed')(TODAY);
  assert.equal(r.ok, true);
  const rows = r.data.bands.flatMap((b) => b.rows);
  assert.equal(rows.find((x) => x.id === 'i-late').company, 'Acme Freight');
  assert.match(rows.find((x) => x.id === 'i-late').line, /Acme Freight — \$40, 40 days late\./);
  assert.deepEqual(r.data.trouble, []);
});

test('nothing on this screen throws when the database says no', async () => {
  for (const name of ['fnOwed', 'fnRefundsForScreen', 'fnMoneyBack']) {
    reset(); failWith = { message: 'permission denied for table invoices', code: '42501' };
    const r = await F(name)();
    assert.equal(r.ok, false, name);
    assert.equal(typeof r.error, 'string');
    assert.ok(!/permission denied|42501/.test(r.error), name + ' must not hand a database message to a person');
  }
});

/* ═══════════════ 2. a refund that is owed becomes a refund that was paid ═══════════════ */

test('what is still owed on a refund, including a part payment', () => {
  const owed = F('fnRefundStillOwed');
  assert.equal(owed({ amount: 50, status: 'owed' }), 50);
  assert.equal(owed({ amount: 50, status: 'paid', paid_amount: 50 }), 0);
  assert.equal(owed({ amount: 50, status: 'paid', paid_amount: 20 }), 30);
  assert.equal(owed({ amount: 50, status: 'waived' }), 0);
  /* a database without paid_amount yet: a paid row means paid in full, which is
     exactly what it meant before the column existed */
  assert.equal(owed({ amount: 50, status: 'paid' }), 0);
  assert.equal(F('fnRefundPartPaid')({ amount: 50, status: 'paid', paid_amount: 20 }), true);
  assert.equal(F('fnRefundPartPaid')({ amount: 50, status: 'owed' }), false);
});

test('a refund says who, how much, and whether the money actually went', () => {
  const line = F('fnRefundLine');
  assert.match(line({ company: 'Acme', month_no: 1, amount: 50, status: 'owed' }), /we owe them \$50 for month 1\. Not sent yet\./);
  assert.match(line({ company: 'Acme', amount: 20, status: 'paid', paid_amount: 20, paid_via: 'Wise', paid_at: '2026-11-10T00:00:00Z', paid_reference: 'WZ-77' }),
    /\$20 sent by Wise on 2026-11-10 \(ref WZ-77\)\./);
  assert.match(line({ company: 'Acme', amount: 20, status: 'paid', paid_amount: 8, paid_via: 'Wise' }), /\$8 sent by Wise\. \$12 of it is still owed\./);
  assert.match(line({ company: 'Acme', amount: 20, status: 'waived' }), /set aside/);
  /* never 'undefined' or 'null' in front of a person */
  for (const r of [{}, null, { amount: null }, { amount: 'x', status: 'paid' }]) {
    assert.ok(!/undefined|null|NaN/.test(line(r)), JSON.stringify(r));
  }
});

test('what the owner must type before a refund can be marked paid', () => {
  const bad = F('fnRefundProblem');
  const row = { id: 'r1', amount: 50, status: 'owed' };
  assert.equal(bad(row, { via: 'Wise' }), '', 'the amount defaults to what is owed');
  assert.equal(bad(row, { amount: 50, via: 'Wise', reference: 'X' }), '');
  assert.match(bad(row, { amount: 51, via: 'Wise' }), /more than we owe\. We owe \$50\./);
  assert.match(bad(row, { amount: 0, via: 'Wise' }), /how much was sent/);
  assert.match(bad(row, { amount: 'lots', via: 'Wise' }), /as a number/);
  assert.match(bad(row, { amount: 50, via: '  ' }), /how it was sent/);
  assert.match(bad(row, { amount: 50, via: 'Wise', on: 'whenever' }), /not a date/);
  assert.match(bad({ id: 'r1', amount: 50, status: 'paid' }, { via: 'Wise' }), /already marked paid/);
  assert.match(bad({ id: 'r1', amount: 50, status: 'waived' }, { via: 'Wise' }), /set aside/);
  assert.match(bad({ amount: 50 }, { via: 'Wise' }), /Pick the refund first/);
});

test('paying a refund goes to the database rule, with every fact', async () => {
  reset(); rpcAnswer = { refund_pay: { id: 'r-owed', status: 'paid', amount: 50, paid_amount: 50, paid_via: 'Wise' } };
  const r = await F('fnMarkRefundPaid')('r-owed', { amount: 50, via: 'Wise', reference: 'WZ-9', on: '2026-11-20' });
  assert.equal(r.ok, true);
  const call = rpcs.find((x) => x.name === 'refund_pay');
  assert.deepEqual(call.args, { p_refund: 'r-owed', p_amount: 50, p_via: 'Wise', p_reference: 'WZ-9', p_on: '2026-11-20' });
  /* and nothing was written to the table behind the rule's back */
  assert.equal(calls.filter((c) => c.table === 'refunds' && c.op === 'update').length, 0);
});

test('a database without the rule yet is written to directly, and loses no fact', async () => {
  reset();
  rpcError = { refund_pay: { message: 'Could not find the function public.refund_pay', code: 'PGRST202' } };
  const r = await F('fnMarkRefundPaid')('r-owed', { amount: 50, via: 'bank transfer', reference: 'TRN-1', on: '2026-11-20' });
  assert.equal(r.ok, true);
  const wrote = calls.find((c) => c.table === 'refunds' && c.op === 'update');
  assert.equal(wrote.payload.status, 'paid');
  assert.equal(wrote.payload.paid_via, 'bank transfer');
  assert.match(wrote.payload.notes, /Month 1: 3 of 10 calls delivered\./, 'the reason it was raised survives');
  assert.match(wrote.payload.notes, /Paid \$50 by bank transfer on 2026-11-20 \(ref TRN-1\)\./);
  /* the amount the guarantee raised is never touched */
  for (const k of ['amount', 'multiplier', 'reason', 'client_id', 'month_id']) assert.ok(!(k in wrote.payload), k);
  assert.match(F('fnRefundPaidWords')(r.data), /until the database update is applied/);
  /* the day is the day that was picked, wherever it is read: noon UTC, not local midnight */
  assert.equal(wrote.payload.paid_at, '2026-11-20T12:00:00.000Z');
  /* and only a row that is still owed is written, so a second click finds nothing to write twice */
  assert.ok(wrote.filters.some(([k, v]) => k === 'status' && v === 'owed'));
});

/* ROUND 3, seen in a browser against the live shape of the database (no
   refund_pay, no paid_amount column): $1,000 recorded against a $3,000 refund
   read "Recorded. That refund is settled.", "We owe $0", and the row said the
   whole $3,000 had been sent. Two thirds of a client's money left the screen. */
test('without the rule, a PART payment leaves the refund owed in full and writes the transfer down', async () => {
  reset();
  rpcError = { refund_pay: { message: 'Could not find the function public.refund_pay', code: 'PGRST202' } };
  const r = await F('fnMarkRefundPaid')('r-owed', { amount: 30, via: 'Wise', reference: 'TRN-1', on: '2026-11-20' });
  assert.equal(r.ok, true);
  const wrote = calls.find((c) => c.table === 'refunds' && c.op === 'update');
  assert.ok(!('status' in wrote.payload), 'the row is NOT marked paid: paid reads as paid in full');
  assert.ok(!('paid_at' in wrote.payload));
  assert.match(wrote.payload.notes, /Month 1: 3 of 10 calls delivered\./, 'the reason it was raised survives');
  assert.match(wrote.payload.notes, /Part sent: \$30 by Wise on 2026-11-20 \(ref TRN-1\)\. \$20 still to send\./);
  assert.equal(r.data.part_noted, true);
  const words = F('fnRefundPaidWords')(r.data);
  assert.match(words, /\$30 sent, \$20 still to send/);
  assert.match(words, /still shows as owed in full/);
  assert.ok(!/settled/.test(words), 'it must never say settled');
  /* every screen still counts the whole of it as owed */
  assert.equal(F('fnRefundStillOwed')({ status: 'owed', amount: 50, notes: wrote.payload.notes }), 50);
});

test('a refusal from the rule is passed on, not worked around', async () => {
  reset(); rpcError = { refund_pay: { message: 'That refund is already marked paid.', code: 'P0001' } };
  const r = await F('fnMarkRefundPaid')('r-owed', { amount: 50, via: 'Wise' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'That refund is already marked paid.');
  assert.equal(calls.filter((c) => c.table === 'refunds' && c.op === 'update').length, 0, 'no table write after a refusal');
});

test('the old two-argument call still works, and a bad entry never reaches the database', async () => {
  reset(); rpcAnswer = { refund_pay: { id: 'r-owed', status: 'paid', amount: 50, paid_amount: 50 } };
  const r = await F('fnMarkRefundPaid')('r-owed', 'Payoneer');
  assert.equal(r.ok, true);
  assert.equal(rpcs.find((x) => x.name === 'refund_pay').args.p_via, 'Payoneer');
  reset();
  const no = await F('fnMarkRefundPaid')('r-owed', { amount: 500, via: 'Wise' });
  assert.equal(no.ok, false);
  assert.match(no.error, /more than we owe/);
  assert.equal(rpcs.length, 0, 'nothing was asked of the database');
});

test('the refunds screen names the client, totals what is owed, and flags the ones who have left', async () => {
  reset();
  const r = await F('fnRefundsForScreen')();
  assert.equal(r.ok, true);
  assert.equal(r.data.owedTotal, 50 + 15 + 12, 'the two owed plus what is left of the part payment');
  assert.equal(r.data.paidTotal, 20 + 8);
  assert.deepEqual(r.data.gone.map((x) => x.id), ['r-gone']);
  assert.equal(r.data.rows.find((x) => x.id === 'r-owed').company, 'Acme Freight');
  assert.equal(r.data.rows.find((x) => x.id === 'r-owed').month_no, 1);
});

/* ═══════════════ 3. the two piles, reconciled ═══════════════ */

test('what a client paid us against what we owe them back', () => {
  const rec = F('fnReconcile');
  const paid = [{ status: 'paid', amount: 100 }, { status: 'sent', amount: 900 }];
  const back = [{ amount: 60, status: 'owed' }, { amount: 20, status: 'paid', paid_amount: 20 }];
  const out = rec(paid, back, { id: 'c1', company: 'Acme', term: '3month' });
  assert.equal(out.paidIn, 100, 'an unpaid invoice is not money we have');
  assert.equal(out.refundsOwed, 60);
  assert.equal(out.refundsPaid, 20);
  assert.equal(out.refundsTotal, 80);
  assert.equal(out.overBy, -20);
  assert.equal(out.over, false);
  /* the prepaid case: a 3-month term can promise back more than it took in */
  const over = rec([{ status: 'paid', amount: 72 }], [{ amount: 48, status: 'owed' }, { amount: 24, status: 'owed' }, { amount: 24, status: 'owed' }], { id: 'c2' });
  assert.equal(over.refundsTotal, 96);
  assert.equal(over.overBy, 24);
  assert.equal(over.over, true, 'and the screen must say so');
  assert.equal(rec(null, null, null).paidIn, 0);
});

test('every client reconciled in three reads, and only the ones with money in them', async () => {
  reset();
  const r = await F('fnMoneyBack')();
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.rows.map((x) => x.company).sort(), ['Acme Freight', 'Gone & Co', 'Prepay Ltd']);
  const acme = r.data.rows.find((x) => x.company === 'Acme Freight');
  assert.equal(acme.paidIn, 0, 'Acme has paid nothing');
  assert.equal(acme.refundsOwed, 50);
  assert.ok(r.data.over.some((x) => x.company === 'Acme Freight'), 'owed money by a client who has paid none is over');
});

test('a locked month that owes a refund with no refund row behind it is found', () => {
  const gaps = F('fnRefundGaps')(tables.v_month_standing, tables.refunds);
  assert.deepEqual(gaps, [{ monthId: 'm9', clientId: 'c1', company: 'Acme Freight', monthNo: 2, amount: 60 }]);
  /* an open month owes nothing yet, and a missed month with a row is fine */
  assert.deepEqual(F('fnRefundGaps')([{ month_id: 'x', verdict: 'open', refund_due: 0 }], []), []);
  assert.deepEqual(F('fnRefundGaps')(null, null), []);
});

/* ═══════════════ 4. the month after this one ═══════════════ */

test('which months a term bills on', () => {
  const bills = F('fnBillsOnMonth');
  for (const n of [1, 2, 3, 4, 5]) assert.equal(bills({ term: 'monthly' }, n), true, 'monthly bills month ' + n);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => bills({ term: '3month' }, n)), [true, false, false, true, false, false, true]);
  assert.equal(bills({ term: '3month' }, 0), false);
});

test('month four on a three-month term is not guessed: it is asked', () => {
  const d = F('fnRenewalDecision');
  assert.equal(d({ term: 'monthly', company: 'Acme' }, 2).decide, false);
  assert.equal(d({ term: '3month', company: 'Prepay' }, 2).decide, false, 'month 2 is inside the term already paid');
  assert.equal(d({ term: '3month', company: 'Prepay' }, 3).decide, false);
  const four = d({ term: '3month', company: 'Prepay Ltd', monthly_fee: 1 }, 4);
  assert.equal(four.decide, true);
  assert.match(four.question, /Prepay Ltd is on a 3-month term and month 4 starts a new one/);
  assert.match(four.question, /Nobody has said whether a 3-month client is billed again at month 4/);
  assert.match(four.question, /nothing has been raised/);
  assert.equal(d({ term: '3month', company: 'P' }, 7).decide, true, 'and again at month 7');
});

test('closing a month locks it, opens the next and raises its invoice', async () => {
  reset();
  rpcAnswer = {
    lock_month: { id: 'm1', client_id: 'c1', month_no: 1, verdict: 'missed' },
    open_next_month: { id: 'm1b', client_id: 'c1', month_no: 2 },
    raise_invoice: { id: 'i-new', amount: 30, status: 'draft' },
  };
  const r = await F('fnCloseMonth')('m1');
  assert.equal(r.ok, true);
  assert.equal(r.data.opened.month_no, 2);
  assert.equal(r.data.invoice.id, 'i-new');
  assert.match(r.data.says, /Month 1 is locked, month 2 is open, and \$30 is raised as a draft/);
  assert.deepEqual(rpcs.map((x) => x.name), ['lock_month', 'open_next_month', 'raise_invoice']);
});

test('closing a month refuses to renew a three-month term nobody has decided about', async () => {
  reset();
  rpcAnswer = { lock_month: { id: 'm2c2', client_id: 'c2', month_no: 3, verdict: 'hit' } };
  const r = await F('fnCloseMonth')('m2c2');
  assert.equal(r.ok, true, 'the lock still happened and is not undone');
  assert.equal(r.data.opened, null, 'and no month four was opened behind the owner');
  assert.equal(r.data.decide.monthNo, 4);
  assert.match(r.data.says, /Month 3 is locked\./);
  assert.match(r.data.says, /month 4 starts a new one/);
  assert.deepEqual(rpcs.map((x) => x.name), ['lock_month'], 'nothing was opened and nothing was billed');
});

test('a client who has left gets no new month and no new invoice', async () => {
  reset();
  rpcAnswer = { lock_month: { id: 'mx', client_id: 'c3', month_no: 2, verdict: 'missed' } };
  const r = await F('fnCloseMonth')('mx');
  assert.equal(r.ok, true);
  assert.match(r.data.says, /They have left, so no new month was opened\./);
  assert.deepEqual(rpcs.map((x) => x.name), ['lock_month']);
});

test('a month inside a term that is already paid opens with nothing to bill', async () => {
  reset();
  rpcAnswer = {
    lock_month: { id: 'mq', client_id: 'c2', month_no: 1, verdict: 'hit' },
    open_next_month: { id: 'mq2', client_id: 'c2', month_no: 2 },
  };
  const r = await F('fnCloseMonth')('mq');
  assert.equal(r.ok, true);
  assert.equal(r.data.invoice, null);
  assert.match(r.data.says, /inside a term that is already paid, so there is nothing to bill/);
  assert.ok(!rpcs.some((x) => x.name === 'raise_invoice'));
});

test('a lock that fails stops there, and nothing else is attempted', async () => {
  reset(); rpcError = { lock_month: { message: 'That month is already locked.', code: 'P0001' } };
  const r = await F('fnCloseMonth')('m1');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'That month is already locked.');
  assert.deepEqual(rpcs.map((x) => x.name), ['lock_month']);
  assert.equal((await F('fnCloseMonth')()).ok, false);
});

test('the month after is opened once: a month already there is not opened again', async () => {
  reset();
  tables.client_months.push({ id: 'm1b', client_id: 'c1', month_no: 2 });
  rpcAnswer = { lock_month: { id: 'm1', client_id: 'c1', month_no: 1, verdict: 'hit' },
    raise_invoice: { id: 'i-new', amount: 30 } };
  const r = await F('fnCloseMonth')('m1');
  assert.equal(r.ok, true);
  assert.ok(!rpcs.some((x) => x.name === 'open_next_month'),
    'open_next_month opens the month AFTER the last one, so calling it with month two already there would skip to month three');
  /* and it still asks for that month's invoice, because raise_invoice hands back
     the existing one rather than raising a second: closing a month twice must
     never bill twice */
  assert.equal(rpcs.find((x) => x.name === 'raise_invoice').args.p_month, 'm1b');
  assert.match(r.data.says, /month 2 is open/);
});

test('an unreadable invoice list is never drawn as an empty one', async () => {
  reset();
  tables.invoices = [];
  const r = await F('fnOwed')(TODAY);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.bands, [], 'no invoices means nothing owed, not two $0 lines off the view');
  assert.equal(r.data.total, 0);
});

/* ═══════════════ 5. the screen ═══════════════ */

test('the Money screen draws with nothing in the database at all', async () => {
  reset();
  tables.invoices = []; tables.refunds = []; tables.v_month_standing = [];
  await F('moLoad')();
  const html = F('moBodyHtml')();
  assert.ok(!/undefined|NaN|\[object/.test(html), html.slice(0, 400));
  assert.match(html, /Nothing is owed to us/);
  assert.match(html, /Nothing has been refunded and nothing is owed/);
  assert.match(html, /Every refund we owe is inside what that client has paid us/);
  assert.equal(F('moNavCount')(), '');
});

test('the Money screen puts a company name through the escape', async () => {
  reset();
  tables.clients[0].company = `O'Brien <script>alert(1)</script>`;
  await F('moLoad')();
  const html = F('moBodyHtml')();
  assert.ok(!/<script>/.test(html), 'no script tag survives');
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&#39;'));
});

test('the badge counts what needs the owner, and nothing else', async () => {
  reset();
  await F('moLoad')();
  /* two late invoices, one raised and never sent, three refunds still owed */
  assert.equal(F('moNavCount')(), '6');
});

test('the refund form offers the amount owed and refuses more', async () => {
  reset();
  await F('moLoad')();
  const html = F('moOpenPay')('r-owed');
  assert.match(html, /Record the refund/);
  assert.match(html, /value="50"/, 'the amount the guarantee raised is offered');
  assert.match(html, /Acme Freight/);
  assert.match(html, /id="moPayVia"/);
  assert.match(html, /id="moPayRef"/);
  assert.match(html, /id="moPayOn"/);
  assert.ok(!/<script>/.test(html));
});

test('every figure on the Money screen comes from a row, never from arithmetic here', () => {
  const src = fs.readFileSync(path.join(root, 'money.js'), 'utf8');
  assert.ok(!/monthly_fee\s*\*/.test(src), 'money.js must not multiply a fee');
  assert.ok(!/\*\s*2\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'money.js must not double anything');
  assert.ok(!/from\('refunds'\)|from\('invoices'\)|\.rpc\(/.test(src), 'money.js reads through finance.js, never the database');
  /* and it holds no price */
  for (const n of ['300', '1500', '3000', '4500', '1200', '2400', '3600', '7200', '10800']) {
    assert.ok(!new RegExp('(^|[^0-9])' + n + '([^0-9]|$)').test(src), 'money.js hard-codes the price ' + n);
  }
});

/* ═══════════════ 6. the migration that is not applied ═══════════════ */

test('the SQL this screen needs is written down, and says it is not applied', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261209_refunds_paid.sql'), 'utf8');
  assert.match(sql, /NOT APPLIED/);
  for (const fn of ['refund_pay', 'refund_waive', 'portal_refunds']) {
    assert.match(sql, new RegExp('create or replace function\\s+public\\.' + fn + '\\s*\\('), fn);
  }
  assert.match(sql, /create or replace view public\.v_money_back/);
  assert.ok(!/\bdrop\s+(table|function|column|view)\b/i.test(sql), 'nothing is dropped');
  assert.ok(!/delete from/i.test(sql), 'nothing is deleted');
  /* the two writes the browser cannot make itself */
  assert.match(sql, /if not public\.is_admin\(\) then raise exception 'Only the owner can pay a refund\.'/);
  assert.match(sql, /raise exception 'That is more than we owe/);
  /* the client-scoped read never selects the refunds table from the client */
  assert.match(sql, /grant execute on function public\.portal_refunds\(\) to authenticated/);
});
