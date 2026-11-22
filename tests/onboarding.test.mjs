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
let db, writes, rpcs, toasts, painted;
let nextId = 1;

function matches(row, filters) { return filters.every(([k, v]) => String(row[k]) === String(v)); }
function builder(table) {
  const q = { table, op: 'select', payload: null, opts: null, filters: [], single: false, maybe: false, lim: null };
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
    const out = q.lim ? rows.slice(0, q.lim) : rows;
    if (q.single) return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
    if (q.maybe) return { data: out.length ? out[0] : null, error: null };
    return { data: out, error: null };
  };
  const b = {
    select() { return b; },
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
vm.runInContext(src('finance.js'), sandbox, { filename: 'finance.js' });
vm.runInContext(src('onboarding.js') + `\n;globalThis.api={obChecklist,obReady,obStart,obInputs,obSaveInputs,obSignOff,obAgreement,obDraftAgreement,viewOnboarding,viewOnboardingClient,viewBilling,obRenderBilling,obRenderOnboarding,obRenderOnboardingClient,obLoadBilling,obLoadList,obLoadOne,ob};`, sandbox, { filename: 'onboarding.js' });
const A = sandbox.api;

/* ───────────── a client with every box ticked ───────────── */
const ID = 'c-oak';
function fullDb() {
  return {
    plan_prices: [
      { plan: 'pilot', label: 'Pilot', calls_promised: 2, monthly_fee: 300, three_month_fee: null, is_recurring: false },
      { plan: 'growth', label: 'Growth', calls_promised: 10, monthly_fee: 3000, three_month_fee: 2400, is_recurring: true },
    ],
    clients: [{ id: ID, booking_id: 'b-1', company: 'Oak Roofing', contact_name: 'Sam Oak', contact_email: 'sam@oak.com',
      plan: 'growth', term: 'monthly', calls_promised: 10, monthly_fee: 3000, stage: 'won',
      inputs_complete_on: null, day1_on: null, pilot_credit: 300, pilot_credit_used: false }],
    agreements: [{ id: 'a-1', booking_id: 'b-1', client_name: 'Sam Oak', client_email: 'sam@oak.com',
      client_company: 'Oak Roofing', plan: 'growth', term: 'monthly', monthly_fee: 3000, status: 'signed' }],
    invoices: [{ id: 'i-1', client_id: ID, month_id: 'm-1', number: 'AV-1001', gross_amount: 3000, pilot_credit: 300,
      amount: 2700, currency: 'USD', issued_on: '2026-11-01', due_on: '2026-11-01', status: 'paid' }],
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
  db = fullDb(); writes = []; toasts = []; painted = []; nextId = 1;
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

/* ───────────── billing and the pilot credit ───────────── */
test('the pilot credit is shown once, on the invoice that carries it, and never twice', async () => {
  db.invoices = [
    { id: 'i-1', client_id: ID, number: 'AV-1001', gross_amount: 3000, pilot_credit: 300, amount: 2700, status: 'sent', issued_on: '2026-11-01' },
    { id: 'i-2', client_id: ID, number: 'AV-1002', gross_amount: 3000, pilot_credit: 0, amount: 3000, status: 'sent', issued_on: '2026-12-01' },
  ];
  await A.obLoadBilling();
  const html = A.obRenderBilling();
  assert.equal(html.split('Pilot credit applied once').length - 1, 1, 'exactly one invoice shows the credit');
  assert.ok(html.includes('AV-1001') && html.includes('AV-1002'));
  assert.ok(html.includes('$2,700') && html.includes('$300'));
});
test('billing lists what to raise, send and chase, and the buttons call the finance side', async () => {
  db.v_invoice_work = [{ month_id: 'm-2', client_id: ID, company: 'Oak Roofing', month_no: 2, invoice_id: null, issued_on: null }];
  db.invoices = [{ id: 'i-1', client_id: ID, number: 'AV-1001', gross_amount: 3000, pilot_credit: 0, amount: 3000, status: 'sent', issued_on: '2026-11-01' }];
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
    plan: 'growth', term: 'monthly', stage: 'won', pilot_credit: 0 });
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
  assert.equal(/\b300\b/.test(code), false, 'the pilot price is never written down in the code');
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
