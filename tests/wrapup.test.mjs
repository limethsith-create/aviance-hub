/* Tests for wrapup.js — how a client leaves: the final count, the money both
   ways, the handover, and deleting their data.

   Same shape as cleanup.test.mjs: one fresh vm context per test, the real
   finance.js and wrapup.js loaded into it like the browser does, and a small
   in-memory Supabase in place of `sb`. No network, no DOM beyond the few
   globals the hub gives every file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const FINANCE = read('finance.js');
const WRAPUP = read('wrapup.js');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clone = (o) => JSON.parse(JSON.stringify(o));
const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/* ───────────── a tiny in-memory Supabase ───────────── */
/* Tables are plain arrays and really are changed: a delete removes the row, so
   "keeps the invoices, removes the prospects" is a real check, not a stub. */
function makeDb(tables, rpcs) {
  const db = clone(tables);
  const log = [];
  let seq = 0;
  const match = (row, fs_) => fs_.every(([kind, col, val]) => {
    const v = row[col];
    if (kind === 'eq') return String(v) === String(val);
    if (kind === 'lte') return String(v) <= String(val);
    if (kind === 'gt') return v != null && String(v) > String(val);
    if (kind === 'notNull') return v !== null && v !== undefined;
    if (kind === 'in') return val.map(String).includes(String(v));
    return true;
  });
  function from(table) {
    db[table] ||= [];
    const q = { table, filters: [], op: 'select', payload: null, single: false, maybeSingle: false, order: null };
    const b = {
      select() { return b; },
      eq(c, v) { q.filters.push(['eq', c, v]); return b; },
      lte(c, v) { q.filters.push(['lte', c, v]); return b; },
      gt(c, v) { q.filters.push(['gt', c, v]); return b; },
      not(c, op, v) { if (op === 'is' && v === null) q.filters.push(['notNull', c, null]); return b; },
      in(c, v) { q.filters.push(['in', c, v]); return b; },
      order(c, o) { q.order = [c, !o || o.ascending !== false]; return b; },
      limit() { return b; },
      insert(p) { q.op = 'insert'; q.payload = p; return b; },
      update(p) { q.op = 'update'; q.payload = p; return b; },
      delete() { q.op = 'delete'; return b; },
      single() { q.single = true; return b; },
      maybeSingle() { q.maybeSingle = true; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    function run() {
      log.push({ table, op: q.op, filters: q.filters, payload: q.payload });
      let rows = db[table];
      let out;
      if (q.op === 'insert') {
        const row = Object.assign({ id: table + '-' + (++seq), created_at: new Date().toISOString() }, q.payload);
        rows.push(row); out = [row];
      } else {
        const hit = rows.filter((r) => match(r, q.filters));
        if (q.op === 'update') hit.forEach((r) => Object.assign(r, q.payload));
        if (q.op === 'delete') db[table] = rows.filter((r) => !hit.includes(r));
        out = hit;
      }
      out = clone(out);
      if (q.order) out.sort((a, z) => (String(a[q.order[0]] ?? '') < String(z[q.order[0]] ?? '') ? -1 : 1) * (q.order[1] ? 1 : -1));
      if (q.single) return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'No row.' } };
      if (q.maybeSingle) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
    return b;
  }
  const rpc = (name, args) => {
    log.push({ rpc: name, args });
    const fn = (rpcs || {})[name];
    return Promise.resolve(fn ? fn(db, args) : { data: null, error: { message: 'No such rule.' } });
  };
  return { sb: { from, rpc }, db, log };
}

/* The month clock, as the database does it. Only the fake plays by these rules;
   wrapup.js is never allowed to know them. */
const realRpcs = {
  recount_month: (db, a) => {
    const m = db.client_months.find((x) => x.id === a.p_month);
    if (!m || m.locked_at) return { data: 0, error: null };
    m.calls_delivered = db.qualified_calls.filter((c) => c.month_id === m.id && c.counts).length;
    return { data: m.calls_delivered, error: null };
  },
  lock_month: (db, a) => {
    const m = db.client_months.find((x) => x.id === a.p_month);
    if (!m) return { data: null, error: { message: 'That month is not there.' } };
    if (m.locked_at) return { data: m, error: null };
    const hit = m.calls_delivered >= m.calls_promised;
    m.verdict = hit ? 'hit' : 'missed';
    m.locked_at = new Date().toISOString();
    if (!hit) {
      const client = db.clients.find((c) => c.id === m.client_id);
      const mult = m.month_no === 1 ? 2 : 1;
      m.refund_due = mult * client.monthly_fee;
      db.refunds.push({ id: 'rf-' + m.month_no, client_id: m.client_id, month_id: m.id, amount: m.refund_due, multiplier: mult, reason: 'Month ' + m.month_no + ' short', status: 'owed', paid_at: null });
    }
    return { data: m, error: null };
  },
};

/* ───────────── fixtures ───────────── */
const CLIENT = { id: 'c1', company: 'Harbor Co', contact_name: 'Pat Lee', contact_email: 'pat@harbor.test', plan: 'growth', term: 'monthly', calls_promised: 10, monthly_fee: 3000, stage: 'sending', ended_on: null, end_reason: null, day1_on: '2026-08-01', website: null, pilot_credit: 0 };
const month = (o) => Object.assign({ id: 'm1', client_id: 'c1', month_no: 1, starts_on: '2026-08-01', ends_on: '2026-08-31', calls_promised: 10, calls_delivered: 10, verdict: 'open', locked_at: null, refund_due: 0 }, o);
const invoice = (o) => Object.assign({ id: 'i1', client_id: 'c1', month_id: 'm1', number: 'AV-1', gross_amount: 3000, amount: 3000, currency: 'USD', issued_on: '2026-08-01', due_on: '2026-08-01', status: 'sent', sent_at: null, paid_at: null }, o);
const refund = (o) => Object.assign({ id: 'r1', client_id: 'c1', month_id: 'm1', amount: 3000, multiplier: 1, reason: 'short', status: 'owed', paid_at: null }, o);

const base = (over) => Object.assign({
  clients: [clone(CLIENT)], client_months: [], qualified_calls: [], invoices: [], refunds: [],
  handovers: [], client_events: [], client_profiles: [], meetings: [],
  outreach_threads: [], outreach_messages: [], outreach_campaigns: [], outreach_accounts: [],
}, over || {});

/* ───────────── load finance.js + wrapup.js into one context ───────────── */
function load(tables, rpcs) {
  const made = makeDb(tables, rpcs === undefined ? realRpcs : rpcs);
  let modal = '', toasted = [], errs = {}, fields = {}, painted = 0;
  const ctx = {
    sb: made.sb, esc,
    openModal: (h) => { modal = h; }, closeModal: () => { modal = ''; },
    toast: (m) => toasted.push(m),
    val: (id) => fields[id] ?? '',
    errEl: (id, m) => { errs[id] = m; return false; },
    emptyState: (ic, t, s) => `<div class="card"><div class="empty"><h3>${esc(t)}</h3><p>${esc(s)}</p></div></div>`,
    render: () => { painted++; }, currentView: 'ending',
    document: { getElementById: () => null },
    window: { print() {} },
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(FINANCE, ctx, { filename: 'finance.js' });
  vm.runInContext(WRAPUP, ctx, { filename: 'wrapup.js' });
  return { ctx, db: made.db, log: made.log, modal: () => modal, toasted, errs, fields, painted: () => painted };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

/* ═════════════ 1. the orderly ending ═════════════ */

test('wuEndClient refuses while a month cannot be locked, and says which month', async () => {
  const t = load(base({
    client_months: [month({ id: 'm1', month_no: 1, locked_at: '2026-09-01T00:00:00Z', verdict: 'hit' }), month({ id: 'm2', month_no: 2, starts_on: '2026-09-01', ends_on: '2026-09-30', calls_delivered: 4 })],
  }), { recount_month: () => ({ data: 4, error: null }), lock_month: () => ({ data: null, error: { message: 'That month is still running.' } }) });

  const r = await t.ctx.wuEndClient('c1', { reason: 'They are moving in-house', lastDay: '2026-09-30' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Month 2/);
  assert.match(r.error, /hide money/);
  assert.match(r.error, /still running/);                    // what the database said, in its words
  assert.equal(t.db.clients[0].ended_on, null, 'the client row is untouched');
  assert.equal(t.db.clients[0].stage, 'sending');
  assert.equal(t.db.client_events.length, 0, 'no trail for an ending that did not happen');
});

test('wuEndClient names every unlocked month when more than one is open', async () => {
  const t = load(base({ client_months: [month({ id: 'm1', month_no: 1 }), month({ id: 'm2', month_no: 2 }), month({ id: 'm3', month_no: 3 })] }),
    { recount_month: () => ({ data: 0, error: null }), lock_month: () => ({ data: null, error: { message: 'Not yet.' } }) });
  const r = await t.ctx.wuEndClient('c1', { reason: 'done' });
  assert.equal(r.ok, false);
  assert.match(r.error, /month 1, month 2, month 3/);
});

test('wuEndClient locks the months through finance.js, sets ended_on and the stage, pauses sending, writes the trail', async () => {
  const t = load(base({
    client_months: [month({ id: 'm1', month_no: 1, calls_delivered: 0 })],
    qualified_calls: [{ id: 'q1', client_id: 'c1', month_id: 'm1', counts: true }, { id: 'q2', client_id: 'c1', month_id: 'm1', counts: false }],
    outreach_campaigns: [{ id: 'ca1', client_id: 'c1', status: 'running' }, { id: 'ca2', client_id: 'c1', status: 'finished' }],
    outreach_accounts: [{ id: 'ac1', client_id: 'c1', status: 'ok' }],
  }));
  const r = await t.ctx.wuEndClient('c1', { reason: 'Not enough calls', lastDay: '2026-09-30' });
  assert.equal(r.ok, true, r.error);

  // the count is the database's: one call counted, so month one is short
  assert.equal(t.db.client_months[0].calls_delivered, 1);
  assert.equal(t.db.client_months[0].verdict, 'missed');
  assert.ok(t.db.client_months[0].locked_at);
  assert.equal(r.data.refundFromMonths, 6000, 'month one short is 2x — worked out by the database, not here');
  assert.equal(r.data.refundOutstanding, 6000);

  assert.equal(t.db.clients[0].ended_on, '2026-09-30');
  assert.equal(t.db.clients[0].end_reason, 'Not enough calls');
  assert.equal(t.db.clients[0].stage, 'ended');

  assert.equal(t.db.outreach_campaigns.find((c) => c.id === 'ca1').status, 'paused');
  assert.equal(t.db.outreach_campaigns.find((c) => c.id === 'ca2').status, 'finished', 'a finished campaign is left alone');
  assert.equal(t.db.outreach_accounts[0].status, 'paused');
  assert.equal(r.data.providerStillRunning, true, 'somebody must still stop the provider itself');

  const ev = t.db.client_events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].area, 'wrapup');
  assert.equal(ev[0].event, 'client_ended');
  assert.equal(ev[0].detail.last_day, '2026-09-30');
  assert.equal(ev[0].detail.refund_from_months, 6000);
  // never a server: the only rules it asked for are the finance ones
  assert.deepEqual(t.log.filter((l) => l.rpc).map((l) => l.rpc), ['recount_month', 'lock_month']);
});

test('wuEndClient asks for a reason, and says so plainly', async () => {
  const t = load(base({ client_months: [] }));
  const r = await t.ctx.wuEndClient('c1', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /Say why/);
  const missing = await t.ctx.wuEndClient('nope', { reason: 'x' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not in Aviance OS/);
});

/* ═════════════ 2. the final statement ═════════════ */

test('the net figure: they owe us', async () => {
  const t = load(base({
    client_months: [month({ locked_at: 'x', verdict: 'hit' })],
    invoices: [invoice({ amount: 3000, status: 'sent', paid_at: null })],
  }));
  const r = await t.ctx.wuFinalStatement('c1');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.owedToUs, 3000);
  assert.equal(r.data.owedToThem, 0);
  assert.equal(r.data.net, 3000);
  assert.equal(r.data.invoiced, 3000);
  assert.equal(r.data.paid, 0);
  assert.equal(t.ctx.wuNetWords(r.data.net), 'They owe us $3,000.');
  const l = r.data.lines[0];
  assert.equal(l.label, 'Month 1');
  assert.equal(l.promised, 10); assert.equal(l.delivered, 10);
  assert.deepEqual(l.invoiceNumbers, ['AV-1']);
});

test('the net figure: we owe them', async () => {
  const t = load(base({
    client_months: [month({ locked_at: 'x', verdict: 'missed', calls_delivered: 4, refund_due: 3000 })],
    invoices: [invoice({ amount: 3000, status: 'paid', paid_at: '2026-08-05T00:00:00Z' })],
    refunds: [refund({ amount: 3000, multiplier: 1, status: 'owed' })],
  }));
  const r = await t.ctx.wuFinalStatement('c1');
  assert.equal(r.data.owedToUs, 0);
  assert.equal(r.data.owedToThem, 3000);
  assert.equal(r.data.net, -3000);
  assert.equal(r.data.paid, 3000);
  assert.equal(t.ctx.wuNetWords(r.data.net), 'We owe them $3,000.');
});

test('the net figure: square — paid invoice, paid refund, a void invoice owed by nobody', async () => {
  const t = load(base({
    client_months: [month({ locked_at: 'x', verdict: 'hit' })],
    invoices: [invoice({ amount: 3000, status: 'paid', paid_at: '2026-08-05T00:00:00Z' }),
      invoice({ id: 'i2', number: 'AV-2', amount: 900, status: 'void' })],
    refunds: [refund({ amount: 500, status: 'paid', paid_at: '2026-09-02T00:00:00Z' })],
  }));
  const r = await t.ctx.wuFinalStatement('c1');
  assert.equal(r.data.owedToUs, 0);
  assert.equal(r.data.owedToThem, 0);
  assert.equal(r.data.net, 0);
  assert.equal(r.data.refunded, 500);
  assert.equal(t.ctx.wuNetWords(r.data.net), 'Square — nothing owed either way.');
});

test('month one short: the statement shows the 2x refund the database raised', async () => {
  const t = load(base({
    client_months: [month({ id: 'm1', month_no: 1, calls_delivered: 3 })],
    qualified_calls: [{ id: 'q1', client_id: 'c1', month_id: 'm1', counts: true }, { id: 'q2', client_id: 'c1', month_id: 'm1', counts: true }, { id: 'q3', client_id: 'c1', month_id: 'm1', counts: true }],
    invoices: [invoice({ amount: 3000, status: 'paid', paid_at: '2026-08-05T00:00:00Z' })],
  }));
  const end = await t.ctx.wuEndClient('c1', { reason: 'Month one was short', lastDay: '2026-08-31' });
  assert.equal(end.ok, true, end.error);

  const r = await t.ctx.wuFinalStatement('c1');
  const l = r.data.lines[0];
  assert.equal(l.verdict, 'missed');
  assert.equal(l.delivered, 3);
  assert.equal(l.refundDue, 6000, 'twice the $3,000 fee, because it was month one');
  assert.equal(l.owedToThem, 6000);
  assert.deepEqual(l.multipliers, [2]);
  assert.equal(r.data.owedToThem, 6000);
  assert.equal(r.data.net, -6000);

  // and it reads that way on the printable statement
  await t.ctx.wuLoadStatement('c1');
  const h = t.ctx.viewFinalStatement('c1');
  const s = text(h);
  assert.match(s, /\$6,000/);
  assert.match(s, /2x/);
  assert.match(s, /We owe them \$6,000\./);
  assert.ok(!h.includes('<b>Harbor'), 'everything through esc()');
});

test('the statement carries invoices that belong to no month, and warns while a month is still open', async () => {
  const t = load(base({
    client_months: [month({ id: 'm1', locked_at: null, verdict: 'open' })],
    invoices: [invoice({ id: 'i9', month_id: null, number: 'AV-ODD', amount: 250, status: 'sent' })],
  }));
  const r = await t.ctx.wuFinalStatement('c1');
  assert.equal(r.data.lines.length, 2);
  assert.equal(r.data.lines[1].label, 'Outside the months');
  assert.equal(r.data.owedToUs, 250);
  assert.deepEqual(r.data.unlockedMonths, [1]);
  await t.ctx.wuLoadStatement('c1');
  assert.match(text(t.ctx.viewFinalStatement('c1')), /no final count yet/);
});

/* ═════════════ 3. the handover ═════════════ */

test('wuHandover takes their prospects, conversations, meetings, inputs and invoices, and dates the deletion 30 days on', async () => {
  const t = load(base({
    clients: [Object.assign(clone(CLIENT), { stage: 'ended', ended_on: '2026-09-30', end_reason: 'In-house' })],
    outreach_threads: [{ id: 'th1', client_id: 'c1', lead_name: 'Dana', lead_email: 'dana@lead.test', lead_company: 'Lead Co', lead_title: 'COO', sentiment: 'positive', status: 'booked', last_message_at: '2026-09-10T00:00:00Z' }],
    outreach_messages: [
      { id: 'ms1', thread_id: 'th1', client_id: 'c1', direction: 'out', subject: 'Hello', body: 'Hi Dana', sent_at: '2026-09-01T00:00:00Z', delivery: 'sent' },
      { id: 'ms2', thread_id: 'th1', client_id: 'c1', direction: 'in', subject: 'Re: Hello', body: 'Sounds good', sent_at: '2026-09-02T00:00:00Z', delivery: 'synced' },
      { id: 'ms3', thread_id: 'gone', client_id: 'c1', direction: 'out', subject: 'Orphan', body: 'x', sent_at: '2026-09-03T00:00:00Z', delivery: 'sent' },
    ],
    meetings: [{ id: 'mt1', client_id: 'c1', kind: 'prospect', starts_at: '2026-09-11T14:00:00Z', minutes: 30, time_zone: 'America/New_York', status: 'held', meet_link: 'https://meet.test/x', held_at: '2026-09-11T14:02:00Z', notes: null }],
    client_profiles: [{ client_id: 'c1', sells_what: 'HVAC', icp: { size: '10-50' }, never_email: [], calendar_url: 'https://cal.test' }],
    invoices: [invoice({ amount: 3000, status: 'paid', paid_at: '2026-08-05T00:00:00Z' })],
  }));
  const r = await t.ctx.wuHandover('c1');
  assert.equal(r.ok, true, r.error);
  const h = r.data;
  assert.equal(h.client_id, 'c1');
  assert.equal(h.data_delete_on, '2026-10-30', '30 days after the last day');
  assert.equal(h.reason, 'In-house');
  const c = h.contents;
  assert.equal(c.counts.prospects, 1);
  assert.equal(c.counts.messages, 3);
  assert.equal(c.counts.meetings, 1);
  assert.equal(c.counts.invoices, 1);
  assert.equal(c.prospects[0].email, 'dana@lead.test');
  assert.equal(c.conversations[0].messages.length, 2);
  assert.equal(c.conversations[1].messages.length, 1, 'a message whose thread is gone is still theirs');
  assert.equal(c.inputs.sells_what, 'HVAC');
  assert.equal(c.invoices[0].number, 'AV-1');
  assert.equal(c.client.company, 'Harbor Co');

  const sent = await t.ctx.wuMarkSent(h.id);
  assert.equal(sent.ok, true, sent.error);
  assert.ok(t.db.handovers[0].sent_at);
  assert.equal((await t.ctx.wuMarkSent('')).ok, false);
});

test('wuHandover with nothing to hand over still builds a row', async () => {
  const t = load(base());
  const r = await t.ctx.wuHandover('c1', { lastDay: '2026-11-01' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.contents.counts, { prospects: 0, messages: 0, meetings: 0, invoices: 0 });
  assert.equal(r.data.contents.conversations.length, 0);
  assert.equal(r.data.data_delete_on, '2026-12-01');
  assert.equal(r.data.contents.inputs, null);
});

/* ═════════════ 4. deletion ═════════════ */

const deletable = () => base({
  clients: [Object.assign(clone(CLIENT), { stage: 'ended', ended_on: '2026-09-30' })],
  client_months: [month({ locked_at: 'x', verdict: 'missed', refund_due: 6000 })],
  qualified_calls: [{ id: 'q1', client_id: 'c1', month_id: 'm1', prospect_name: 'Dana', prospect_email: 'dana@lead.test', counts: true }],
  invoices: [invoice({ amount: 3000, status: 'paid', paid_at: '2026-08-05T00:00:00Z' })],
  refunds: [refund({ amount: 6000, multiplier: 2, status: 'paid', paid_at: '2026-10-01T00:00:00Z' })],
  outreach_threads: [{ id: 'th1', client_id: 'c1', lead_name: 'Dana', lead_email: 'dana@lead.test' }, { id: 'th2', client_id: 'other', lead_email: 'not@theirs.test' }],
  outreach_messages: [{ id: 'ms1', thread_id: 'th1', client_id: 'c1', body: 'Hi Dana', sent_at: '2026-09-01T00:00:00Z' }, { id: 'ms2', thread_id: 'th2', client_id: 'other', body: 'Someone else', sent_at: '2026-09-01T00:00:00Z' }],
  outreach_campaigns: [{ id: 'ca1', client_id: 'c1', status: 'finished', sent: 400 }],
  handovers: [{ id: 'h1', client_id: 'c1', contents: { client: { company: 'Harbor Co' }, prospects: [{ email: 'dana@lead.test' }] }, data_delete_on: '2026-10-30', sent_at: '2026-10-01T00:00:00Z' }],
});

test('wuDeleteData refuses without the confirmation, and removes nothing', async () => {
  for (const bad of [undefined, '', 'yes', 'delete', 'c1']) {
    const t = load(deletable());
    const r = await t.ctx.wuDeleteData('c1', bad);
    assert.equal(r.ok, false, 'refused for ' + JSON.stringify(bad));
    assert.match(r.error, /Nothing was removed/);
    assert.match(r.error, /DELETE/);
    assert.equal(t.db.outreach_threads.length, 2);
    assert.equal(t.db.outreach_messages.length, 2);
    assert.equal(t.db.client_events.length, 0);
  }
  const t = load(deletable());
  assert.equal((await t.ctx.wuDeleteData('', 'DELETE')).ok, false);
  assert.equal(t.db.outreach_threads.length, 2);
});

test('wuDeleteData keeps the money record and removes the prospect data', async () => {
  const t = load(deletable());
  const r = await t.ctx.wuDeleteData('c1', 'DELETE');
  assert.equal(r.ok, true, r.error);

  // gone — and only theirs
  assert.deepEqual(t.db.outreach_threads.map((x) => x.id), ['th2']);
  assert.deepEqual(t.db.outreach_messages.map((x) => x.id), ['ms2']);
  assert.equal(r.data.removed.prospects, 1);
  assert.equal(r.data.removed.messages, 1);

  // kept — the money record
  assert.equal(t.db.invoices.length, 1);
  assert.equal(t.db.invoices[0].amount, 3000);
  assert.equal(t.db.refunds.length, 1);
  assert.equal(t.db.refunds[0].multiplier, 2);
  assert.equal(t.db.qualified_calls.length, 1);
  assert.equal(t.db.qualified_calls[0].prospect_email, 'dana@lead.test');
  assert.equal(t.db.clients.length, 1);
  assert.equal(t.db.client_months.length, 1);
  assert.equal(t.db.outreach_campaigns.length, 1, 'campaign totals are counts, not prospects');
  for (const k of ['invoices', 'refunds', 'qualified_calls']) assert.ok(r.data.kept.includes(k));

  // the handover row stays, its copy of the same data does not
  assert.equal(t.db.handovers.length, 1);
  assert.equal(t.db.handovers[0].contents.prospects, undefined);
  assert.match(t.db.handovers[0].contents.note, /money record is kept/);
  assert.equal(r.data.removed.handovers_emptied, 1);

  // the trail
  const ev = t.db.client_events.at(-1);
  assert.equal(ev.event, 'data_deleted');
  assert.equal(ev.detail.removed.prospects, 1);
  assert.ok(ev.detail.kept.includes('invoices'));

  // and the statement still adds up afterwards
  const s = await t.ctx.wuFinalStatement('c1');
  assert.equal(s.ok, true, s.error);
  assert.equal(s.data.paid, 3000);
  assert.equal(s.data.refunded, 6000);
  assert.equal(s.data.net, 0);
});

test('wuDeleteDue returns only the handovers whose date has passed', async () => {
  const t = load(base({
    handovers: [
      { id: 'h1', client_id: 'c1', contents: { client: { company: 'Past Co' } }, data_delete_on: '2026-10-30', sent_at: null },
      { id: 'h2', client_id: 'c2', contents: { client: { company: 'Today Co' } }, data_delete_on: '2026-11-22', sent_at: null },
      { id: 'h3', client_id: 'c3', contents: { client: { company: 'Future Co' } }, data_delete_on: '2026-12-25', sent_at: null },
      { id: 'h4', client_id: 'c4', contents: { client: { company: 'No date Co' } }, data_delete_on: null, sent_at: null },
    ],
  }));
  const due = await t.ctx.wuDeleteDue('2026-11-22');
  assert.equal(due.ok, true, due.error);
  assert.deepEqual(due.data.map((h) => h.id), ['h1', 'h2'], 'past and today, never the future and never a row with no date');
  const coming = await t.ctx.wuDeleteComing('2026-11-22');
  assert.deepEqual(coming.data.map((h) => h.id), ['h3']);
  assert.deepEqual((await t.ctx.wuDeleteDue('2026-01-01')).data, []);
});

test('the confirm step says in words what goes and what stays, and nothing is removed until the word is typed', async () => {
  const t = load(deletable());
  const html = t.ctx.wuConfirmDelete('c1', 'Harbor Co');
  const s = text(html);
  assert.match(s, /Harbor Co/);
  assert.match(s, /cannot be undone/);
  assert.match(s, /What will be removed/);
  assert.match(s, /prospect list/);
  assert.match(s, /What will be kept/);
  assert.match(s, /invoices/);
  assert.match(s, /refunds/);
  assert.match(s, /qualified calls/i);
  assert.match(s, /Type DELETE to confirm/);

  // the wrong word: the screen says so, the rows stay
  t.fields.wuDelWord = 'ok';
  const bad = await t.ctx.wuDeleteNow('c1');
  assert.equal(bad.ok, false);
  assert.match(t.errs.wuDelErr, /Nothing was removed/);
  assert.equal(t.db.outreach_threads.length, 2);

  // the right word
  t.fields.wuDelWord = 'DELETE';
  const good = await t.ctx.wuDeleteNow('c1');
  assert.equal(good.ok, true, good.error);
  assert.deepEqual(t.db.outreach_threads.map((x) => x.id), ['th2']);
  assert.match(t.toasted.join(' '), /money record is kept/);

  // escaped, even a company name with angle brackets
  assert.ok(!t.ctx.wuConfirmDelete('c1', '<b>Harbor</b>').includes('<b>Harbor</b>'));
});

test('nothing in this file deletes on its own', () => {
  assert.doesNotMatch(WRAPUP, /setInterval|setTimeout\s*\(\s*[^)]*wuDelete/);
  // the only call to wuDeleteData is the one behind the typed word
  const calls = (WRAPUP.match(/wuDeleteData\(/g) || []).length;
  assert.equal(calls, 2, 'the definition and the one confirmed caller');
  // and no machine, ever
  assert.doesNotMatch(WRAPUP, /machineFetch|MACHINE_URL|email-distributor/);
});

/* ═════════════ 5. every screen with zero rows ═════════════ */

test('Ending renders with zero rows, and with rows', async () => {
  const t = load(base({ clients: [] }));
  await t.ctx.wuLoadEnding();
  const empty = t.ctx.viewEnding();
  assert.match(text(empty), /Nobody is leaving/);
  assert.ok(!empty.includes('<table'));

  // a client still sending is not on this screen
  const t2 = load(base({ client_months: [month({ locked_at: 'x', verdict: 'hit' })] }));
  await t2.ctx.wuLoadEnding();
  assert.match(text(t2.ctx.viewEnding()), /Nobody is leaving/);

  // ended, with money both ways
  const t3 = load(base({
    clients: [Object.assign(clone(CLIENT), { stage: 'ended', ended_on: '2026-09-30', end_reason: 'Moved in-house' })],
    client_months: [month({ locked_at: 'x', verdict: 'missed', refund_due: 6000 })],
    invoices: [invoice({ amount: 3000, status: 'sent' })],
    refunds: [refund({ amount: 6000, multiplier: 2, status: 'owed' })],
  }));
  await t3.ctx.wuLoadEnding();
  const s = text(t3.ctx.viewEnding());
  assert.match(s, /Harbor Co/);
  assert.match(s, /Moved in-house/);
  assert.match(s, /We owe them \$3,000\./);          // $3,000 to collect less $6,000 to refund
  assert.match(s, /\$3,000 to collect/);
  assert.match(s, /\$6,000 to refund/);
  assert.ok(!t3.ctx.viewEnding().includes('<b>Harbor Co</b>'.replace('Harbor Co', '<x>')));
});

test('the final statement renders with zero months', async () => {
  const t = load(base());
  await t.ctx.wuLoadStatement('c1');
  const h = t.ctx.viewFinalStatement('c1');
  assert.match(text(h), /nothing to add up/);
  assert.match(text(h), /Square — nothing owed either way\./);
  assert.match(text(h), /Harbor Co/);
  // a client who is not there reads as a sentence, not a crash
  await t.ctx.wuLoadStatement('nope');
  assert.match(text(t.ctx.viewFinalStatement('nope')), /not in Aviance OS/);
});

test('Data deletion renders with zero rows, and lists due before coming', async () => {
  const t = load(base());
  await t.ctx.wuLoadDeletion();
  const empty = t.ctx.viewDataDeletion();
  assert.match(text(empty), /Nothing is due for deletion/);
  assert.match(text(empty), /Nothing is coming up/);
  assert.ok(!empty.includes('btn danger'), 'nothing to confirm when nothing is due');

  const t2 = load(base({
    handovers: [
      { id: 'h1', client_id: 'c1', contents: { client: { company: 'Harbor Co' } }, data_delete_on: '2020-01-01', sent_at: '2020-01-02T00:00:00Z' },
      { id: 'h2', client_id: 'c2', contents: { client: { company: 'Later Co' } }, data_delete_on: '2099-01-01', sent_at: null },
    ],
  }));
  await t2.ctx.wuLoadDeletion();
  const s = t2.ctx.viewDataDeletion();
  assert.match(text(s), /Harbor Co/);
  assert.match(text(s), /Later Co/);
  assert.equal((s.match(/btn danger/g) || []).length, 1, 'only the one that is due can be confirmed');
  assert.match(text(s), /Waiting for the date/);
  assert.match(text(s), /Handover sent/);
  assert.match(text(s), /Not sent yet/);
});

test('a screen asked before its rows are read says so instead of showing nothing', () => {
  const t = load(base());
  assert.match(t.ctx.viewEnding(), /role="status"/);
  assert.match(t.ctx.viewDataDeletion(), /role="status"/);
  assert.match(t.ctx.viewFinalStatement('c1'), /role="status"/);
});

test('a database that answers with an error reads as a plain sentence on every screen', async () => {
  const t = load(base());
  t.ctx.sb.from = () => { throw new Error('The database did not answer.'); };
  await t.ctx.wuLoadEnding();
  assert.match(text(t.ctx.viewEnding()), /did not answer/);
  await t.ctx.wuLoadDeletion();
  assert.match(text(t.ctx.viewDataDeletion()), /did not answer/);
  await t.ctx.wuLoadStatement('c1');
  assert.match(text(t.ctx.viewFinalStatement('c1')), /did not answer/);
});
