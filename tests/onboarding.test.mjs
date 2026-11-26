/* Tests for onboarding.js (a won deal becomes a running client) and the first invoice.
   A fake `sb` stands in for Supabase: a tiny query builder over in-memory tables, plus rpc.
   finance.js is loaded into the same context, because onboarding.js calls it for the money.
   Run with:  node --test tests/onboarding.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/* ───────────── fake Supabase ───────────── */
let db, writes, reads, rpcs, toasts, painted;
let nextId = 1;

function matches(row, filters) { return filters.every(([k, v]) => String(row[k]) === String(v)); }
function builder(table) {
  const q = { table, op: 'select', cols: '*', payload: null, opts: null, filters: [], single: false, maybe: false, lim: null };
  const settle = () => {
    const rows = (db[table] || []).filter((r) => matches(r, q.filters));
    if (q.op === 'insert') {
      const row = Object.assign({ id: 'new-' + nextId++, created_at: '2026-11-22T00:00:00Z' }, q.payload);
      (db[table] = db[table] || []).push(row);
      writes.push({ table, op: 'insert', payload: q.payload });
      return { data: q.single ? row : [row], error: null };
    }
    if (q.op === 'update') {
      writes.push({ table, op: 'update', payload: q.payload, filters: q.filters });
      rows.forEach((r) => Object.assign(r, q.payload));
      return { data: q.single ? (rows[0] || null) : rows, error: null };
    }
    if (q.op === 'upsert') {
      writes.push({ table, op: 'upsert', payload: q.payload, opts: q.opts });
      const key = (q.opts && q.opts.onConflict) || 'id';
      const list = (db[table] = db[table] || []);
      const found = list.find((r) => String(r[key]) === String(q.payload[key]));
      let row;
      if (found) { Object.assign(found, q.payload); row = found; }
      else { row = Object.assign({ id: 'new-' + nextId++ }, q.payload); list.push(row); }
      return { data: q.single ? row : [row], error: null };
    }
    reads.push({ table, cols: q.cols, filters: q.filters.slice() });
    const out = q.lim ? rows.slice(0, q.lim) : rows;
    if (q.single) return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
    if (q.maybe) return { data: out.length ? out[0] : null, error: null };
    return { data: out, error: null };
  };
  const b = {
    select(c) { if (c !== undefined) q.cols = c; return b; },
    insert(p) { q.op = 'insert'; q.payload = p; return b; },
    update(p) { q.op = 'update'; q.payload = p; return b; },
    upsert(p, o) { q.op = 'upsert'; q.payload = p; q.opts = o; return b; },
    eq(k, v) { q.filters.push([k, v]); return b; },
    order() { return b; },
    limit(n) { q.lim = n; return b; },
    single() { q.single = true; return b; },
    maybeSingle() { q.maybe = true; return b; },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}
const fakeSb = {
  from: builder,
  rpc: async (name, args) => { writes.push({ rpc: name, args }); const h = rpcs[name]; return h ? h(args) : { data: null, error: null }; },
};

/* ───────────── the context the hub gives every file ───────────── */
const sandbox = {
  console, Date, Number, Math, Promise, Array, String, Boolean, Object, JSON, RegExp, isNaN, Error, Intl,
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  emptyState: (icon, title, sub) => `<div class="card"><div class="empty"><h3>${title}</h3><p>${sub}</p></div></div>`,
  toast: (m) => { toasts.push(m); },
  val: () => '',
  errEl: () => false,
  document: { getElementById: (id) => (id === 'obHost' ? { set innerHTML(h) { painted.push(h); } } : null) },
  sb: fakeSb,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), sandbox, { filename: 'core.js' });
vm.runInContext(src('finance.js'), sandbox, { filename: 'finance.js' });
vm.runInContext(src('onboarding.js') + `\n;globalThis.api={obChecklist,obReady,obStart,obInputs,obSaveInputs,obSignOff,obAgreement,obDraftAgreement,viewOnboarding,viewOnboardingClient,viewBilling,obRenderBilling,obRenderOnboarding,obRenderOnboardingClient,obLoadBilling,obLoadList,obLoadOne,ob};`, sandbox, { filename: 'onboarding.js' });
const A = sandbox.api;

/* ───────────── a client with every box ticked ───────────── */
const ID = 'c-oak';
function fullDb() {
  return {
    plan_prices: [
      { plan: 'starter', label: 'Starter', calls_promised: 5, monthly_fee: 1500, three_month_fee: 1200, is_recurring: true },
      { plan: 'growth', label: 'Growth', calls_promised: 10, monthly_fee: 3000, three_month_fee: 2400, is_recurring: true },
      { plan: 'scale', label: 'Scale', calls_promised: 15, monthly_fee: 4500, three_month_fee: 3600, is_recurring: true },
    ],
    clients: [{ id: ID, booking_id: 'b-1', company: 'Oak Roofing', contact_name: 'Sam Oak', contact_email: 'sam@oak.com',
      plan: 'growth', term: 'monthly', calls_promised: 10, monthly_fee: 3000, stage: 'won',
      inputs_complete_on: null, day1_on: null }],
    agreements: [{ id: 'a-1', booking_id: 'b-1', client_name: 'Sam Oak', client_email: 'sam@oak.com',
      client_company: 'Oak Roofing', plan: 'growth', term: 'monthly', monthly_fee: 3000, status: 'signed' }],
    invoices: [{ id: 'i-1', client_id: ID, month_id: 'm-1', number: 'AV-1001', gross_amount: 3000,
      amount: 3000, currency: 'USD', issued_on: '2026-11-01', due_on: '2026-11-01', status: 'paid' }],
    client_profiles: [{ client_id: ID, sells_what: 'Roof repairs', sells_to: 'Facility managers',
      icp: ['50-500 staff'], never_email: ['rival.com'], calendar_url: 'https://cal.test/oak',
      slots_per_week: 10, sender_name: 'Sam Oak', sender_title: 'Owner', time_zone: 'America/New_York',
      signed_off_at: '2026-11-10T09:00:00Z' }],
    client_people: [{ id: 'p-1', client_id: ID, full_name: 'Sam Oak', email: 'sam@oak.com', is_primary: true }],
    meetings: [{ id: 'mt-1', client_id: ID, kind: 'strategy', starts_at: '2026-11-12T14:00:00Z', minutes: 45,
      time_zone: 'America/New_York', status: 'held', held_at: '2026-11-12T14:05:00Z' }],
    v_invoice_work: [],
  };
}
beforeEach(() => {
  db = fullDb(); writes = []; reads = []; toasts = []; painted = []; nextId = 1;
  rpcs = { open_next_month: () => ({ data: 'm-1', error: null }), raise_invoice: () => ({ data: 'i-9', error: null }) };
  sandbox.sb = fakeSb; A.ob.list = null; A.ob.one = null; A.ob.billing = null; A.ob.clientId = null;
  A.ob.listErr = ''; A.ob.oneErr = ''; A.ob.billErr = '';
});

const shape = (r) => { assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']); return r; };
const item = (data, key) => data.items.find((i) => i.key === key);

/* ───────────── the checklist ───────────── */
test('all seven items read true from real rows, and the client is ready', async () => {
  const r = shape(await A.obChecklist(ID));
  assert.equal(r.ok, true);
  assert.equal(r.data.items.length, 7);
  assert.equal(r.data.items.filter((i) => !i.done).length, 0);
  assert.equal(r.data.ready, true);
  assert.equal(r.data.blocking, '');
  assert.equal((await A.obReady(ID)).data, true);
});

/* Each item in turn: take away the row that proves it and nothing else. */
const BREAKERS = [
  ['agreement',  'agreement',  (d) => { d.agreements = []; },                                   /signed agreement/i],
  ['agreement sent but not signed', 'agreement', (d) => { d.agreements[0].status = 'sent'; },    /signed agreement/i],
  ['paid',       'paid',       (d) => { d.invoices[0].status = 'sent'; },                        /not been paid/i],
  ['inputs',     'inputs',     (d) => { d.client_profiles[0].signed_off_at = null; },            /signed them off/i],
  ['calendar',   'calendar',   (d) => { d.client_profiles[0].calendar_url = ''; },                /calendar link/i],
  ['contact',    'contact',    (d) => { d.client_people = []; },                                 /Nobody from their side/i],
  ['neverEmail', 'neverEmail', (d) => { d.client_profiles[0].never_email = []; },                /never to contact/i],
  ['strategy',   'strategy',   (d) => { d.meetings = []; },                                      /strategy call/i],
];
for (const [name, key, breakIt, words] of BREAKERS) {
  test(`not ready while ${name} is missing, and the refusal names it`, async () => {
    breakIt(db);
    const ck = await A.obChecklist(ID);
    assert.equal(ck.data.ready, false, 'should not be ready');
    assert.equal(item(ck.data, key).done, false, key + ' should be undone');
    assert.equal(ck.data.items.filter((i) => !i.done).length >= 1, true);
    assert.equal((await A.obReady(ID)).data, false);
    const started = shape(await A.obStart(ID));
    assert.equal(started.ok, false);
    assert.match(started.error, words);
    assert.match(started.error, /^Not ready to start:/);
    assert.equal(writes.some((w) => w.rpc === 'open_next_month'), false, 'no month may be opened');
    assert.equal(db.clients[0].stage, 'won', 'the client must not move');
  });
}

test('the checklist reads rows, never a flag: a client already marked up is still not ready', async () => {
  db.clients[0].inputs_complete_on = '2026-11-01';
  db.clients[0].day1_on = '2026-11-02';
  db.clients[0].stage = 'live';
  db.agreements = []; db.invoices = []; db.client_profiles = []; db.client_people = []; db.meetings = [];
  const ck = await A.obChecklist(ID);
  assert.equal(ck.data.ready, false);
  assert.equal(ck.data.items.filter((i) => i.done).length, 0, 'nothing may be ticked without a row behind it');
  assert.equal((await A.obStart(ID)).ok, false);
});

test('a client with no rows at all does not throw; a client not on file is said plainly', async () => {
  db = { clients: [], plan_prices: [] };
  const ck = shape(await A.obChecklist('nobody'));
  assert.equal(ck.ok, false);
  assert.match(ck.error, /not on file/i);
  assert.equal(ck.data, null);
});

/* ───────────── sign-off ───────────── */
test('obSignOff refuses while a required field is blank and names that field', async () => {
  db.client_profiles[0].signed_off_at = null;
  db.client_profiles[0].sender_title = '';
  const r = shape(await A.obSignOff(ID));
  assert.equal(r.ok, false);
  assert.match(r.error, /sender's title/);
  assert.equal(writes.some((w) => w.table === 'client_profiles' && w.op === 'update'), false);

  db.client_profiles[0].sender_title = 'Owner';
  db.client_profiles[0].slots_per_week = null;
  const r2 = await A.obSignOff(ID);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /call slots a week/i);
});
test('obSignOff stamps signed_off_at once everything is filled; "nobody to exclude" counts as an answer', async () => {
  db.client_profiles[0].signed_off_at = null;
  db.client_profiles[0].never_email = { none: true };
  const r = shape(await A.obSignOff(ID));
  assert.equal(r.ok, true);
  assert.ok(db.client_profiles[0].signed_off_at, 'signed_off_at is stamped');
  const ck = await A.obChecklist(ID);
  assert.equal(item(ck.data, 'neverEmail').done, true);
  assert.equal(item(ck.data, 'inputs').done, true);
});
test('obInputs lists what is still blank; obSaveInputs writes the form through to the row', async () => {
  db.client_profiles = [];
  const before = shape(await A.obInputs(ID));
  assert.equal(before.ok, true);
  assert.equal(before.data.profile, null);
  assert.equal(before.data.missing.length, 9);
  assert.equal(before.data.signedOffAt, null);

  const saved = shape(await A.obSaveInputs(ID, {
    sellsWhat: 'Roofs', sellsTo: 'Builders', icp: '50-500 staff\nowns the building',
    neverEmail: 'rival.com', calendarUrl: 'https://cal.test/x', slotsPerWeek: '8',
    senderName: 'Sam', senderTitle: 'Owner', timeZone: 'America/New_York',
  }));
  assert.equal(saved.ok, true);
  const up = writes.find((w) => w.table === 'client_profiles' && w.op === 'upsert');
  assert.equal(up.opts.onConflict, 'client_id');
  assert.equal([...up.payload.icp].join('|'), '50-500 staff|owns the building');
  assert.equal([...up.payload.never_email].join('|'), 'rival.com');
  assert.equal(up.payload.slots_per_week, 8);
  const after = await A.obInputs(ID);
  assert.equal(after.data.missing.length, 0);
});

/* ───────────── day one ───────────── */
test('obStart is refused when not ready and leaves everything alone', async () => {
  db.meetings = [];
  const r = shape(await A.obStart(ID));
  assert.equal(r.ok, false);
  assert.match(r.error, /strategy call/i);
  assert.equal(db.clients[0].stage, 'won');
  assert.equal(db.clients[0].day1_on, null);
  assert.equal(db.clients[0].inputs_complete_on, null);
  assert.equal(writes.filter((w) => w.rpc).length, 0);
});
test('obStart succeeds when ready: inputs_complete_on, day1_on, stage live, and finance opens month one', async () => {
  const r = shape(await A.obStart(ID));
  assert.equal(r.ok, true, r.error);
  const c = db.clients[0];
  assert.ok(c.inputs_complete_on, 'inputs_complete_on is set');
  assert.ok(c.day1_on, 'day1_on is set');
  assert.equal(c.stage, 'live');
  const opened = writes.filter((w) => w.rpc === 'open_next_month');
  assert.equal(opened.length, 1, 'month one is opened once, by the database');
  assert.equal(opened[0].args.p_client, ID);
  assert.equal(r.data.month, 'm-1');
});
test('obStart says which one thing is missing, and how many others', async () => {
  db.meetings = []; db.client_people = [];
  const r = await A.obStart(ID);
  assert.match(r.error, /1 other thing still to do/);
});

/* ───────────── the agreement ───────────── */
test('obAgreement reads the row and names its state; obDraftAgreement takes the fee from plan_prices', async () => {
  const got = shape(await A.obAgreement(ID));
  assert.equal(got.data.state, 'signed');
  assert.match(got.data.words, /Signed/);

  db.agreements = [];
  db.clients[0].term = '3month';
  const made = shape(await A.obDraftAgreement(ID));
  assert.equal(made.ok, true);
  const ins = writes.find((w) => w.table === 'agreements' && w.op === 'insert');
  assert.equal(ins.payload.monthly_fee, db.plan_prices[1].three_month_fee, 'the three-month fee comes from plan_prices');
  assert.equal(ins.payload.status, 'draft');
  assert.equal(ins.payload.client_company, 'Oak Roofing');
  assert.equal(writes.some((w) => w.table === 'agreement_pdfs'), false, 'no PDF is written yet');
});
test('obDraftAgreement never drafts twice, and says so plainly when the plan has no price', async () => {
  const again = await A.obDraftAgreement(ID);
  assert.equal(again.ok, true);
  assert.equal(writes.some((w) => w.table === 'agreements' && w.op === 'insert'), false);

  db.agreements = []; db.clients[0].plan = 'moon';
  const r = await A.obDraftAgreement(ID);
  assert.equal(r.ok, false);
  assert.match(r.error, /no price on file/i);
});

/* ───────────── billing: an invoice is its amount, with no credit line ───────────── */
test('an invoice shows what is owed and nothing about a credit, even if an old row still carries the column', async () => {
  db.invoices = [
    { id: 'i-1', client_id: ID, number: 'AV-1001', gross_amount: 3000, pilot_credit: 300, amount: 2700, status: 'sent', issued_on: '2026-11-01' },
    { id: 'i-2', client_id: ID, number: 'AV-1002', gross_amount: 3000, amount: 3000, status: 'sent', issued_on: '2026-12-01' },
  ];
  await A.obLoadBilling();
  const html = A.obRenderBilling();
  assert.ok(html.includes('AV-1001') && html.includes('AV-1002'));
  assert.ok(html.includes('$2,700') && html.includes('$3,000'), 'the amount the database holds is the amount shown');
  assert.ok(!/credit|pilot/i.test(html), 'no credit line, no old plan name');
  assert.ok(!/\$300\b/.test(html));
});
test('a client left on a withdrawn plan: listed as "Retired plan", and no new agreement is drafted for them', async () => {
  db.clients[0].plan = 'pilot';
  db.agreements = [];
  db.plan_prices.push({ plan: 'pilot', label: 'Old plan', calls_promised: 2, monthly_fee: 300, three_month_fee: null, is_recurring: false });
  const r = await A.obDraftAgreement(ID);
  assert.deepEqual([r.ok, r.data, r.error], [false, null, 'That plan is retired. They need to be on Starter, Growth or Scale before an agreement can be drafted.']);
  assert.equal(db.agreements.length, 0, 'nothing was written, at any price');
  await A.obLoadList();
  const list = A.obRenderOnboarding();
  assert.ok(list.includes('Retired plan') && !/pilot/i.test(list));
  /* an agreement already on file for the old plan reads safely, without its old terms */
  db.agreements = [{ id: 'a-9', booking_id: 'b-1', client_name: 'Sam Oak', client_email: 'sam@oak.com', client_company: 'Oak Roofing', plan: 'pilot', term: 'monthly', monthly_fee: 300, status: 'signed' }];
  await A.obLoadOne(ID);
  const one = A.obRenderOnboardingClient();
  assert.ok(one.includes('Oak Roofing · Retired plan</p>'), 'the plan is named as retired and its old fee is not quoted');
  assert.ok(!/pilot/i.test(one) && !/\$300\b/.test(one));
});
test('a plan reads as its name, not its code, on the list and on the agreement', async () => {
  await A.obLoadList();
  assert.ok(A.obRenderOnboarding().includes('<span class="muted">Growth</span>'));
  await A.obLoadOne(ID);
  assert.ok(A.obRenderOnboardingClient().includes('Oak Roofing · Growth · monthly · $3,000 a month'));
});
test('billing lists what to raise, send and chase, and the buttons call the finance side', async () => {
  db.v_invoice_work = [{ month_id: 'm-2', client_id: ID, company: 'Oak Roofing', month_no: 2, invoice_id: null, issued_on: null }];
  db.invoices = [{ id: 'i-1', client_id: ID, number: 'AV-1001', gross_amount: 3000, amount: 3000, status: 'sent', issued_on: '2026-11-01' }];
  await A.obLoadBilling();
  const html = A.obRenderBilling();
  assert.ok(html.includes('obRaiseGo(&quot;m-2&quot;)'), 'raise calls fnRaiseInvoice through obRaiseGo');
  assert.ok(html.includes('obMarkPaidGo(&quot;i-1&quot;)'));
  const src = fs.readFileSync(path.join(root, 'onboarding.js'), 'utf8');
  assert.match(src, /fnRaiseInvoice\(monthId, 0\)/);
  assert.match(src, /fnMarkInvoiceSent\(invoiceId\)/);
  assert.match(src, /fnMarkInvoicePaid\(invoiceId/);
});

/* ───────────── every screen, with zero rows ───────────── */
test('every screen renders with zero rows in the database, and never throws', async () => {
  db = { clients: [], plan_prices: [], agreements: [], invoices: [], client_profiles: [], client_people: [], meetings: [], v_invoice_work: [] };
  const first = A.viewOnboarding();
  assert.ok(first.includes('id="obHost"'));
  await A.obLoadList();
  assert.match(A.obRenderOnboarding(), /Nobody is being onboarded/);

  const bill = A.viewBilling();
  assert.ok(bill.includes('id="obHost"'));
  await A.obLoadBilling();
  assert.match(A.obRenderBilling(), /No invoices need you/);

  const one = A.viewOnboardingClient('nobody');
  assert.ok(one.includes('id="obHost"'));
  await A.obLoadOne('nobody');
  assert.match(A.obRenderOnboardingClient(), /could not open this client/i);
  assert.equal(toasts.length, 0);
});
test('the onboarding list shows a row of ticks and what blocks each client', async () => {
  db.clients.push({ id: 'c-elm', company: 'Elm Glass', contact_name: 'Pat Elm', contact_email: 'pat@elm.com',
    plan: 'growth', term: 'monthly', stage: 'won' });
  db.meetings = [];
  await A.obLoadList();
  const html = A.obRenderOnboarding();
  assert.ok(html.includes('Oak Roofing') && html.includes('Elm Glass'));
  assert.match(html, /strategy call/i);
  assert.equal((html.match(/class="ob-ticks"/g) || []).length, 3, 'a head row and one row of ticks a client');
  assert.ok(html.includes('obOpenClient('));
});
test('one client: checklist, inputs form, agreement, and a Start button disabled with the reason', async () => {
  db.meetings = [];
  await A.obLoadOne(ID);
  const html = A.obRenderOnboardingClient();
  assert.ok(html.includes('Start them'));
  assert.match(html, /disabled aria-disabled="true"/);
  assert.match(html, /strategy call/i);
  assert.ok(html.includes('obSellsWhat') && html.includes('obNeverEmail') && html.includes('obTimeZone'));
  assert.ok(html.includes('Signed'), 'the agreement state is shown');

  db.meetings = [{ id: 'mt-1', client_id: ID, kind: 'strategy', starts_at: '2026-11-12T14:00:00Z', held_at: '2026-11-12T14:05:00Z', status: 'held' }];
  await A.obLoadOne(ID);
  const ok = A.obRenderOnboardingClient();
  assert.ok(!ok.includes('disabled aria-disabled'), 'the button is live once everything is done');
  assert.match(ok, /this opens month one/i);
});

/* ───────────── house rules ───────────── */
test('house rules: no machine, no hard-coded price, finance owns the money, every global is ob-prefixed', () => {
  const s = fs.readFileSync(path.join(root, 'onboarding.js'), 'utf8');
  /* the rules below are about the code, so the comments come out first */
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/machineFetch|MACHINE_URL|email-distributor/.test(s), false);
  assert.equal(/\bimport\b|\brequire\(/.test(s), false);
  assert.equal(/pilot|credit/i.test(s), false, 'the withdrawn plan and its credit are not in this file; finance.js holds the one guard');
  assert.equal(/\b(1500|2400|3000|4500|1200|3600)\b/.test(code), false, 'no plan price is written down here');
  assert.equal(/from\('client_months'\)|recount_month|lock_month|from\('refunds'\)/.test(code), false, 'the month clock and refunds stay in finance.js');
  assert.equal(/from\('invoices'\)/.test(code), false, 'invoices are read and written through finance.js');
  const globals = [...s.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)/gm)].map((m) => m[1])
    .concat([...s.matchAll(/^const ([A-Za-z0-9_]+)/gm)].map((m) => m[1]));
  const bad = globals.filter((g) => !/^(ob|OB_)/.test(g) && !['viewOnboarding', 'viewOnboardingClient', 'viewBilling'].includes(g));
  assert.deepEqual(bad, [], 'every global starts with ob/OB_, apart from the three named screens');
  assert.ok(/\/\/ TODO:/.test(s) && /agreement_pdfs/.test(s), 'the send and the PDF are left as TODOs');
  assert.ok(fs.existsSync(path.join(root, 'onboarding.css')));
  const css = fs.readFileSync(path.join(root, 'onboarding.css'), 'utf8');
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/.test(css), false, 'no new colours: theme.css tokens only');
});

/* ───────────── how much the onboarding screens cost ─────────────
   About round trips and columns, not about what is shown. */

const readsOf = (table) => reads.filter((r) => r.table === table);

test('the checklist reads the client row once, not twice', async () => {
  const r = await A.obChecklist(ID);
  assert.equal(r.ok, true);
  assert.equal(readsOf('clients').length, 1,
    'obAgreement is handed the client row the checklist already read');
});

test('the client row is asked for by column, and includes every field this file reads off it', async () => {
  await A.obChecklist(ID);
  const read = readsOf('clients')[0];
  assert.notEqual(read.cols, '*', '`clients` has 21 columns; this screen reads nine');
  const got = read.cols.split(',');
  /* Each of these is read somewhere in onboarding.js. inputs_complete_on is
     the one that is easy to miss: obStart writes it back, and if it is not
     asked for it comes back undefined and the day is silently overwritten. */
  for (const c of ['id', 'company', 'contact_name', 'contact_email', 'booking_id', 'plan', 'term', 'stage', 'inputs_complete_on'])
    assert.ok(got.includes(c), 'the client read must include ' + c);
});

test('obStart keeps the day already on the row, which needs inputs_complete_on to have been read', async () => {
  db.clients[0].inputs_complete_on = '2026-10-01';
  const r = await A.obStart(ID);
  assert.equal(r.ok, true, r.error);
  const up = writes.find((w) => w.table === 'clients' && w.op === 'update' && w.payload.inputs_complete_on !== undefined);
  assert.equal(up.payload.inputs_complete_on, '2026-10-01',
    'the day already there is kept, not replaced with today');
});

test('the onboarding list costs the same number of reads per client however many there are', async () => {
  const one = async (n) => {
    db = fullDb();
    for (let i = 2; i <= n; i++) {
      db.clients.push(Object.assign({}, db.clients[0], { id: 'c-' + i, booking_id: 'b-' + i, company: 'Co ' + i }));
      db.client_profiles.push(Object.assign({}, db.client_profiles[0], { client_id: 'c-' + i }));
      db.client_people.push(Object.assign({}, db.client_people[0], { id: 'p-' + i, client_id: 'c-' + i }));
      db.meetings.push(Object.assign({}, db.meetings[0], { id: 'mt-' + i, client_id: 'c-' + i }));
      db.invoices.push(Object.assign({}, db.invoices[0], { id: 'i-' + i, client_id: 'c-' + i }));
      db.agreements.push(Object.assign({}, db.agreements[0], { id: 'a-' + i, booking_id: 'b-' + i }));
    }
    reads = []; writes = [];
    A.ob.list = null;
    const r = await A.obLoadList();
    assert.equal(r.ok, true);
    assert.equal(r.data.length, n, n + ' clients on the list');
    return reads.length;
  };
  const forOne = await one(1);
  const forFour = await one(4);
  const perClient = (forFour - forOne) / 3;
  assert.ok(perClient <= 6, 'at most six reads per client on the list, got ' + perClient);
  /* The client row is read once per client, not twice — the regression that
     doubled this screen's cost. */
  assert.equal(readsOf('clients').length, 5, 'one list read plus one row per client');
});

test('the strategy-call read asks for the four columns that answer "was it held?"', async () => {
  await A.obChecklist(ID);
  const read = readsOf('meetings')[0];
  assert.notEqual(read.cols, '*', '`meetings` has 21 columns');
  for (const c of ['status', 'held_at', 'starts_at', 'kind'])
    assert.ok(read.cols.split(',').includes(c), 'needs ' + c);
});

test('one client, whole: the agreement is not read a second time for the same client', async () => {
  const r = await A.obLoadOne(ID);
  assert.equal(r.ok, true);
  assert.equal(readsOf('clients').length, 1,
    'the checklist read the client; the inputs and the agreement reuse it');
  assert.ok(r.data.agreement, 'and the agreement is still there');
  assert.ok(r.data.inputs, 'and so are the inputs');
});
