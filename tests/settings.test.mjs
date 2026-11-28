/* Tests for settings.js — the owner's "Payments and documents" card: read with biz_get, saved
   with biz_set, and a plain "not set yet" beside anything still holding the database's stand-in.
   A fake `sb` with an `rpc` stands in for Supabase. No network.
   Run with:  node --test tests/settings.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;

const elements = {};
const el = (id) => (elements[id] ||= { id, value: '', textContent: '', innerHTML: '' });
globalThis.document = { getElementById: (id) => (id in elements ? elements[id] : null), querySelectorAll: () => [] };
globalThis.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
globalThis.val = (id) => String((elements[id] && elements[id].value) || '').trim();
let toasts = [];
globalThis.toast = (m) => toasts.push(m);

/* The business settings as the database ships them: stand-ins until the owner fills them in. */
const SHIPPED = { legal_name: '[YOUR COMPANY LEGAL NAME]', address: '[YOUR COMPANY ADDRESS]', email: 'aviancelk@gmail.com',
  wise_details: '[WISE BANK DETAILS — add in Settings]', payoneer_link: '', kickoff_link: 'https://www.aviance.online/book', site: 'https://aviance.store' };
let biz, rpcs, rpcFail;
const fakeSb = {
  from: () => { const b = { select: () => b, eq: () => b, order: () => b, maybeSingle: async () => ({ data: null, error: null }), then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return b; },
  async rpc(name, args) {
    rpcs.push({ name, args });
    if (rpcFail) return { data: null, error: rpcFail };
    if (name === 'biz_set') Object.assign(biz, args.p);
    return { data: { ...biz }, error: null };
  },
};
globalThis.sb = fakeSb;
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'settings.js'), 'utf8'), { filename: 'settings.js' });

beforeEach(() => {
  biz = { ...SHIPPED }; rpcs = []; rpcFail = null; toasts = [];
  Object.keys(elements).forEach((k) => delete elements[k]);
  globalThis.authUser = { id: 'u1', uid: 'u1', role: 'admin', name: 'Owner' };
});
const text = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

test('the Payments and documents card is drawn for the owner only', () => {
  const real = globalThis.setTimeout; globalThis.setTimeout = () => 0;
  try {
    const owner = viewSettings();
    assert.match(owner, /<h3>Payments and documents<\/h3>/);
    assert.ok(owner.includes('id="stBiz"'));
    globalThis.authUser = { id: 'u2', role: 'employee' };
    const staff = viewSettings();
    assert.ok(!staff.includes('Payments and documents') && !staff.includes('stBiz'));
    assert.match(staff, /<h3>The calendar<\/h3>/, 'the rest of Settings is still there');
  } finally { globalThis.setTimeout = real; }
});

test('stRenderBiz: the company fields, and "not set yet" beside every stand-in', () => {
  const h = stRenderBiz(SHIPPED);
  const t = text(h);
  for (const w of ['Company legal name', 'Company address', 'Billing email', 'Kickoff booking link', 'Who signs for Aviance', 'Business phone', 'Save']) assert.ok(t.includes(w), 'missing: ' + w);
  for (const k of ['legal_name', 'address', 'email', 'kickoff_link', 'signer_name', 'phone']) assert.ok(h.includes('id="stBiz_' + k + '"'), k);
  /* the old free-text "Wise bank details" box and Payoneer link are retired from this card:
     the Payment details card supersedes them, and Wise cannot be held in Sri Lanka at all */
  for (const k of ['wise_details', 'payoneer_link']) assert.ok(!h.includes('stBiz_' + k), k + ' is no longer edited here');
  assert.doesNotMatch(t, /Wise/i, 'and Wise is not named on this card');
  assert.ok(h.includes('value="aviancelk@gmail.com"') && h.includes('value="https://www.aviance.online/book"'));
  assert.equal(h.split('not set yet').length - 1, 2, 'legal name and address still hold a stand-in');
  for (const k of ['legal_name', 'address']) assert.ok(h.includes('id="stBiz_' + k + '_note"'), k + ' is flagged');
  for (const k of ['email', 'kickoff_link']) assert.ok(!h.includes('id="stBiz_' + k + '_note"'), k + ' is not');
  assert.ok(!h.includes('stBiz_site'), 'the site address is not on this card');

  // filled in: no notes left. Empty, null and nasty values draw without holes.
  assert.ok(!stRenderBiz({ ...SHIPPED, legal_name: 'Aviance (Pvt) Ltd', address: '1 Main St' }).includes('not set yet'));
  for (const d of [{}, null, undefined]) assert.ok(!/undefined|null|NaN/.test(stRenderBiz(d)));
  const nasty = stRenderBiz({ legal_name: '"><img src=x>', address: '</textarea><script>x</script>' });
  assert.ok(!nasty.includes('<img') && !nasty.includes('<script>'));
  assert.equal(stIsPlaceholder('  [x]'), true); assert.equal(stIsPlaceholder('x [y]'), false); assert.equal(stIsPlaceholder(''), false); assert.equal(stIsPlaceholder(null), false);
});

test('stBiz reads with biz_get and stSaveBiz saves with biz_set {p}; both are the owner\'s alone', async () => {
  const got = await stBiz();
  assert.deepEqual(Object.keys(got).sort(), ['data', 'error', 'ok']);
  assert.equal(got.ok, true); assert.equal(got.data.legal_name, '[YOUR COMPANY LEGAL NAME]');
  assert.equal(rpcs[0].name, 'biz_get');

  const saved = await stSaveBiz({ legal_name: '  Aviance (Pvt) Ltd ', address: '1 Main St, Colombo', email: 'billing@aviance.test',
    wise_details: 'Account 123\nSWIFT ABC', kickoff_link: 'https://cal.test/kickoff', site: 'https://evil.test' });
  assert.equal(saved.ok, true);
  assert.deepEqual(rpcs.at(-1), { name: 'biz_set', args: { p: { legal_name: 'Aviance (Pvt) Ltd', address: '1 Main St, Colombo', email: 'billing@aviance.test',
    kickoff_link: 'https://cal.test/kickoff' } } }, 'only this card\'s fields, trimmed — not the retired two, not the site');
  assert.equal(saved.data.legal_name, 'Aviance (Pvt) Ltd');
  await stSaveBiz({ address: 'Only this' });
  assert.deepEqual(rpcs.at(-1).args, { p: { address: 'Only this' } }, 'a field not given is not sent');

  // turned down before the database is asked
  const n = rpcs.length;
  assert.match((await stSaveBiz({ email: 'not-an-email' })).error, /billing email/);
  assert.match((await stSaveBiz({ payoneer_link: 'javascript:alert(1)' })).error, /Payoneer link has to start with https/,
    'the retired key is no longer offered, but it is still checked if something sends it');
  assert.match((await stSaveBiz({ kickoff_link: 'http://plain.test' })).error, /kickoff booking link has to start with https/);
  assert.match((await stSaveBiz({})).error, /nothing to save/);
  globalThis.authUser = { id: 'u2', role: 'employee' };
  assert.match((await stBiz()).error, /Only the owner/);
  assert.match((await stSaveBiz({ address: 'x' })).error, /Only the owner/);
  assert.equal(rpcs.length, n);

  // the database's words, and a thrown error, come back as {ok:false}
  globalThis.authUser = { id: 'u1', role: 'admin' };
  rpcFail = { message: 'Only the owner can change these.' };
  assert.deepEqual(await stSaveBiz({ address: 'x' }), { ok: false, data: null, error: 'Only the owner can change these.' });
  rpcFail = null;
  const real = fakeSb.rpc; fakeSb.rpc = async () => { throw new TypeError('Failed to fetch'); };
  try { assert.equal((await stBiz()).ok, false); } finally { fakeSb.rpc = real; }
});

test('the card loads into the page and Save reads the fields off the screen', async () => {
  el('stBiz');
  await stLoadBiz();
  assert.match(elements.stBiz.innerHTML, /not set yet/);
  for (const k of ['legal_name', 'address', 'email', 'kickoff_link']) el('stBiz_' + k).value = SHIPPED[k];
  el('stBiz_legal_name').value = 'Aviance (Pvt) Ltd'; el('stBizMsg');
  const r = await stSubmitBiz();
  assert.equal(r.ok, true);
  assert.equal(rpcs.at(-1).name, 'biz_set'); assert.equal(rpcs.at(-1).args.p.legal_name, 'Aviance (Pvt) Ltd');
  assert.ok(!('wise_details' in rpcs.at(-1).args.p), 'the retired box is not sent');
  assert.equal(elements.stBiz.innerHTML.split('not set yet').length - 1, 1, 'one fewer stand-in after the save');
  /* the business-details card and the payment-details card are two different
     cards: each says which one was saved, so a save on one cannot read as a
     save on the other */
  assert.ok(toasts.includes('Your business details are saved.'));
  assert.ok(!toasts.includes('The payment details are saved.'), 'that sentence belongs to the card below');
  el('stBiz_email').value = 'nope';
  assert.equal((await stSubmitBiz()).ok, false);
  assert.match(elements.stBizMsg.textContent, /billing email/);

  rpcFail = { message: 'Only the owner can see this.' };
  await stLoadBiz();
  assert.match(elements.stBiz.innerHTML, /Only the owner can see this\./);
});

/* ───────────── perfection pass ───────────── */
test('errors read as plain sentences; the database\'s own plain messages pass through', async () => {
  for (const raw of ['TypeError: Failed to fetch', 'JWT expired', 'permission denied for table biz_settings',
    'Could not find the function public.biz_get in the schema cache', 'duplicate key value violates unique constraint "calendar_settings_pkey"']) {
    rpcFail = { message: raw };
    const r = await stBiz();
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /jwt|function|permission denied|fetch|schema|constraint|table|TypeError/i, raw);
    assert.match(r.error, /^[A-Z].*\.$/s);
  }
  rpcFail = { message: 'Only the owner can change these.' };
  assert.equal((await stSaveBiz({ address: 'x' })).error, 'Only the owner can change these.');
});

test('"What you can do" is in his words, and no longer points at a screen that is not there', async () => {
  assert.equal(stRoleWord('admin'), 'Owner');
  assert.equal(stRoleWord('employee'), 'Team member');
  assert.equal(stRoleWord(undefined), 'Team member');
  el('stMe');
  const realFrom = fakeSb.from;
  fakeSb.from = () => { const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { name: 'Limethsith', email: 'l@example.com', role: 'admin' }, error: null }) }; return b; };
  try { await stLoadMe(); } finally { fakeSb.from = realFrom; }
  const shown = text(elements.stMe.innerHTML);
  assert.match(shown, /What you can do Only the owner can change this Owner/);
  assert.doesNotMatch(shown, /Team screen|admin/);
});

/* ───────────── Payment details: which rails are on, and what each one needs ─────────────
   The rail is not chosen yet, so all five live in Settings and the owner switches on the
   one he ends up using. Every value below is an obvious fake; nothing real is in this file. */
const FAKE = {
  bank_wire: { on: true, account_holder: 'AVIANCE TEST HOLDER', beneficiary_address: '1 Test Lane, Test City, Testland',
    account_number: '0000 0000 0000', iban: 'TT00 TEST 0000 0000', bank_name: 'Example Bank PLC',
    swift: 'TESTTEST', bank_address: '1 Example Road, Test City 03, Testland',
    intermediary_bank: 'Example Correspondent Bank, New York', intermediary_swift: 'TESTUS33',
    reference: '', routing_number: '', note: '' },
  paypal: { on: true, link: 'https://paypal.example/me/avianceTEST', email: 'billing@example.test', note: '' },
};
/* every field the wire rail offers, in the order the screen shows them */
const WIRE_FIELDS = ['account_holder', 'beneficiary_address', 'account_number', 'iban', 'bank_name',
  'swift', 'bank_address', 'intermediary_bank', 'intermediary_swift', 'reference', 'routing_number', 'note'];
const PAY_SHIPPED = { ...SHIPPED, pay_methods: {}, pay_preferred: '', pay_currency: 'USD', pay_terms: 'Net 7' };
const ALL_KINDS = ['bank_wire', 'wise', 'payoneer', 'paypal', 'card_link'];

test('the Payment details card is the owner\'s, and it is a card of its own', () => {
  const real = globalThis.setTimeout; globalThis.setTimeout = () => 0;
  try {
    const owner = viewSettings();
    assert.match(owner, /<h3>Payment details<\/h3>/);
    assert.ok(owner.includes('id="stPay"') && owner.includes('id="stBiz"'), 'both cards are there');
    globalThis.authUser = { id: 'u2', role: 'employee' };
    assert.ok(!viewSettings().includes('id="stPay"'), 'a team member is not shown it');
  } finally { globalThis.setTimeout = real; globalThis.authUser = { id: 'u1', role: 'admin' }; }
});

test('stRenderPay: the rails in the order he should think about them, and every field', () => {
  const h = stRenderPay(PAY_SHIPPED);
  const t = text(h);
  for (const w of ['Bank wire (USD)', 'Second bank account', 'Payoneer', 'Card link', 'PayPal (last resort)',
    'Shown first', 'Payment terms', 'Save']) assert.ok(t.includes(w), 'missing: ' + w);
  for (const k of ALL_KINDS) assert.ok(h.includes('id="stPay_on_' + k + '"'), k + ' can be switched on');

  /* the wire is a wire TO a bank abroad: beneficiary, SWIFT, branch address, correspondent bank */
  for (const fk of WIRE_FIELDS) {
    assert.ok(h.includes('id="stPay_bank_wire_' + fk + '"'), 'bank wire needs ' + fk);
    assert.ok(h.includes('id="stPay_wise_' + fk + '"'), 'the second account needs ' + fk);
  }
  assert.ok(t.includes('Beneficiary name') && t.includes('Beneficiary bank SWIFT / BIC')
    && t.includes('Correspondent / intermediary bank') && t.includes('Correspondent bank SWIFT / BIC'));
  /* the correspondent line is the one that costs him money if it is missing, so it says so */
  assert.match(t, /USD inward-remittance instructions sheet/);
  assert.match(t, /extra hop and an extra cut/);
  /* routing is the optional extra for a US account one day, never a required field */
  assert.match(t, /Routing \/ ABA number \(optional\)/);
  assert.match(t, /A Sri Lankan account has no ABA/);
  assert.ok(h.indexOf('stPay_bank_wire_account_holder') < h.indexOf('stPay_bank_wire_swift'));
  assert.ok(h.indexOf('stPay_bank_wire_swift') < h.indexOf('stPay_bank_wire_intermediary_bank'));
  assert.ok(h.indexOf('stPay_bank_wire_intermediary_swift') < h.indexOf('stPay_bank_wire_routing_number'));

  assert.ok(h.includes('id="stPay_payoneer_link"') && h.includes('id="stPay_payoneer_account_number"'));
  assert.ok(h.includes('id="stPay_paypal_link"') && h.includes('id="stPay_paypal_email"'));
  assert.ok(h.includes('id="stPay_card_link_link"') && !h.includes('id="stPay_card_link_account_number"'));
  assert.ok(h.includes('id="stPayPref"') && h.includes('id="stPayTerms"'));
  /* No currency box: every plan is priced in USD and each invoice carries its
     own currency, so the field changed nothing and could only be got wrong. */
  assert.ok(!h.includes('stPayCurrency'));
  assert.ok(h.includes(`value="Net 7"`));
  for (const shown of ['Bank transfer', 'Bank transfer (second account)', 'Card or online checkout']) assert.ok(t.includes(shown), shown);

  /* empty, null and nasty values draw without holes */
  for (const d of [{}, null, undefined, { pay_methods: 'nope' }, { pay_methods: { bank_wire: 'nope' } }]) {
    assert.ok(!/undefined|null|NaN/.test(stRenderPay(d)), JSON.stringify(d));
  }
  const nasty = stRenderPay({ pay_methods: { bank_wire: { on: true, account_holder: '"><img src=x>', note: '</textarea><script>x</script>' } },
    pay_currency: '"><b>', pay_preferred: '"><i>' });
  assert.ok(!nasty.includes('<img') && !nasty.includes('<script>') && !nasty.includes('<b>'));
});

test('stRenderPay: he is told what each rail really costs him before he picks it', () => {
  const t = text(stRenderPay(PAY_SHIPPED));
  /* the wire is the one that works today */
  assert.match(t, /The primary rail: a US company wires USD to your bank/);
  /* Payoneer is the backup */
  assert.match(t, /The backup rail/);
  /* PayPal is last, and the 7.3% and the missing invoicing are said before he chooses */
  assert.match(t, /PayPal invoicing and PayPal Checkout do not work in Sri Lanka/);
  assert.match(t, /7\.3%/);
  assert.match(t, /goods-and-services payment by hand/);
  /* order by where each rail's own block sits, not by the "Shown first" dropdown above them */
  const h = stRenderPay(PAY_SHIPPED);
  const at = (k) => h.indexOf('id="stPay_on_' + k + '"');
  assert.deepEqual([...ALL_KINDS].sort((x, y) => at(x) - at(y)),
    ['bank_wire', 'wise', 'payoneer', 'card_link', 'paypal'],
    'the wire first, Payoneer next, PayPal last');
  /* a card link needs a US entity, and he is told why he cannot switch it on today */
  assert.match(t, /needs a US entity, because Stripe does not operate in Sri Lanka/);
  /* Wise is never offered by name: it cannot be held in Sri Lanka at all */
  const src = fs.readFileSync(path.join(root, 'settings.js'), 'utf8');
  const shown = src.slice(src.indexOf('const ST_PAY_WIRE='), src.indexOf('const ST_PAY_FIELDS_BY_KIND='));
  assert.doesNotMatch(shown, /Wise/, 'no label or hint names Wise');
  assert.doesNotMatch(t, /Wise/i, 'and nothing on the screen does either');
});

test('stRenderPay: one line says whether invoices can tell a client how to pay', () => {
  const none = stRenderPay(PAY_SHIPPED);
  assert.match(text(none), /Invoices cannot tell a client how to pay yet/);
  assert.ok(none.includes('class="st-pay-status bad"'));
  /* switched on with nothing in it still cannot pay */
  const empty = stRenderPay({ ...PAY_SHIPPED, pay_methods: { bank_wire: { on: true } } });
  assert.match(text(empty), /cannot tell a client how to pay yet/);
  assert.match(text(empty), /nothing in it yet/);
  /* one rail filled in */
  const one = stRenderPay({ ...PAY_SHIPPED, pay_methods: { bank_wire: FAKE.bank_wire }, pay_preferred: 'bank_wire' });
  assert.ok(one.includes('class="st-pay-status good"'));
  assert.equal(text(one).includes('Invoices show how to pay. Bank transfer is shown first.'), true);
  /* two rails: the pick first, the other named as the alternative */
  const two = stRenderPay({ ...PAY_SHIPPED, pay_methods: { ...FAKE }, pay_preferred: 'paypal' });
  assert.match(text(two), /Invoices show how to pay\. PayPal is shown first, with Bank transfer as the other way\./);
  /* a stand-in still in brackets does not count as filled in */
  const held = stRenderPay({ ...PAY_SHIPPED, pay_methods: { wise: { on: true, account_number: '[YOUR ACCOUNT NUMBER]' } } });
  assert.match(text(held), /cannot tell a client how to pay yet/);
});

test('stValidPay: shapes caught before the database is asked, and never the value itself', () => {
  const on = (kind, fields) => ({ pay_methods: { [kind]: { on: true, ...fields } } });
  assert.equal(stValidPay(on('bank_wire', FAKE.bank_wire)), '');
  assert.equal(stValidPay({ ...PAY_SHIPPED, pay_methods: FAKE, pay_preferred: 'paypal' }), '');

  const bads = [
    [on('bank_wire', { account_number: '12ab34', account_holder: 'x' }), /Beneficiary account number should be digits/],
    [on('bank_wire', { routing_number: 'abc', account_holder: 'x' }), /Routing \/ ABA number \(optional\) should be digits/],
    [on('bank_wire', { swift: 'AB', account_holder: 'x' }), /SWIFT \/ BIC should be 6 to 20/],
    [on('bank_wire', { intermediary_swift: 'AB', account_holder: 'x' }), /Correspondent bank SWIFT \/ BIC should be 6 to 20/],
    [on('bank_wire', { iban: 'TT00', account_holder: 'x' }), /IBAN should be 10 to 42/],
    [on('card_link', { link: 'http://checkout.example' }), /has to start with https/],
    [on('card_link', { link: 'javascript:alert(1)' }), /has to start with https/],
    [on('paypal', { email: 'not-an-email' }), /does not look like an email/],
    [on('bank_wire', {}), /Bank wire \(USD\) is switched on but has nothing in it/],
    [on('card_link', { note: 'just a note' }), /Card link is switched on but has nothing in it/],
    [on('bank_wire', { reference: 'AVIANCE-REF' }), /Bank wire \(USD\) is switched on but has nothing in it/],
    [{ ...PAY_SHIPPED, pay_currency: 'dollars' }, /three-letter code/],
    [{ pay_methods: { bank_wire: FAKE.bank_wire }, pay_preferred: 'paypal' }, /not switched on/],
  ];
  for (const [f, re] of bads) {
    const msg = stValidPay(f);
    assert.match(msg, re, JSON.stringify(f));
    /* an error names the field, never what the owner typed into it */
    for (const secret of ['12ab34', 'abc', '0000 0000 0000', '000000000', 'TESTTEST', 'TT00', 'checkout.example',
      'javascript:alert(1)', 'not-an-email', 'AVIANCE TEST HOLDER', 'just a note', 'AVIANCE-REF', 'dollars']) {
      assert.ok(!msg.includes(secret), 'the error echoed a stored value: ' + msg);
    }
  }
  /* digits with spaces and dashes are fine; a rail that is off is not nagged about */
  assert.equal(stValidPay(on('bank_wire', { account_number: '0000-0000 0000', account_holder: 'x' })), '');
  /* a wire with no ABA at all is perfectly valid: a Sri Lankan account has none */
  assert.equal(stValidPay(on('bank_wire', FAKE.bank_wire)), '');
  assert.equal(stValidPay(on('bank_wire', { ...FAKE.bank_wire, iban: '', routing_number: '' })), '');
  /* a rail that is off is not nagged for being empty, but a field in it still has to be a field:
     rubbish is never stored to surprise him the day he switches it on */
  assert.equal(stValidPay({ pay_methods: { bank_wire: { on: false } } }), '');
  assert.match(stValidPay({ pay_methods: { bank_wire: { on: false, account_number: 'nonsense' } } }),
    /Beneficiary account number should be digits/);
});

test('stSavePay sends the whole picture to biz_set, and only the owner may', async () => {
  const r = await stSavePay({ pay_methods: FAKE, pay_preferred: 'paypal', pay_currency: ' usd ', pay_terms: ' Net 7 ' });
  assert.equal(r.ok, true);
  const sent = rpcs.at(-1);
  assert.equal(sent.name, 'biz_set');
  assert.deepEqual(Object.keys(sent.args.p).sort(), ['pay_currency', 'pay_methods', 'pay_preferred', 'pay_terms']);
  assert.deepEqual([sent.args.p.pay_currency, sent.args.p.pay_terms, sent.args.p.pay_preferred], ['USD', 'Net 7', 'paypal']);
  assert.deepEqual(Object.keys(sent.args.p.pay_methods).sort(), [...ALL_KINDS].sort(), 'every rail, on or off');
  assert.deepEqual(Object.keys(sent.args.p.pay_methods.bank_wire).sort(), ['on'].concat(WIRE_FIELDS).sort());
  assert.deepEqual(sent.args.p.pay_methods.bank_wire, { on: true, ...FAKE.bank_wire });
  assert.equal(sent.args.p.pay_methods.bank_wire.routing_number, '', 'no ABA is saved when there is none');
  assert.deepEqual(sent.args.p.pay_methods.card_link, { on: false, link: '', note: '' }, 'a rail never used is saved off and empty');
  assert.ok(!('legal_name' in sent.args.p), 'the other card\'s fields are left alone');

  /* a pick that is not switched on is replaced by one that is, rather than refused */
  await stSavePay({ pay_methods: { bank_wire: FAKE.bank_wire }, pay_preferred: '' });
  assert.equal(rpcs.at(-1).args.p.pay_preferred, 'bank_wire');

  const n = rpcs.length;
  assert.match((await stSavePay({ pay_methods: { paypal: { on: true, email: 'nope' } } })).error, /email address/);
  assert.equal(rpcs.length, n, 'a bad shape never reaches the database');
  globalThis.authUser = { id: 'u2', role: 'employee' };
  assert.match((await stSavePay({ pay_methods: FAKE })).error, /Only the owner/);
  assert.match((await stPay()).error, /Only the owner/);
  assert.equal(rpcs.length, n);
  globalThis.authUser = { id: 'u1', role: 'admin' };
  rpcFail = { message: 'permission denied for table workspace_admin' };
  const bad = await stSavePay({ pay_methods: FAKE });
  assert.equal(bad.ok, false);
  assert.doesNotMatch(bad.error, /permission denied|table/i);
});

test('the Payment details card loads, and Save reads the rails off the screen', async () => {
  el('stPay');
  await stLoadPay();
  assert.match(elements.stPay.innerHTML, /Invoices cannot tell a client how to pay yet/);
  assert.equal(rpcs.at(-1).name, 'biz_get');

  el('stPay_on_bank_wire').checked = true;
  el('stPay_bank_wire_account_holder').value = 'Aviance Test Holder';
  el('stPay_bank_wire_account_number').value = '0000 0000 0000';
  el('stPay_bank_wire_swift').value = 'TESTTEST';
  el('stPay_bank_wire_intermediary_bank').value = 'Example Correspondent Bank, New York';
  el('stPay_bank_wire_intermediary_swift').value = 'TESTUS33';
  el('stPayPref').value = 'bank_wire'; el('stPayTerms').value = 'Net 7'; el('stPayMsg');
  const got = stReadPay();
  assert.equal(got.pay_methods.bank_wire.on, true);
  assert.equal(got.pay_methods.bank_wire.account_number, '0000 0000 0000');
  assert.equal(got.pay_methods.bank_wire.intermediary_swift, 'TESTUS33', 'the correspondent bank is read off the screen too');
  assert.equal(got.pay_methods.wise.on, false);

  const r = await stSubmitPay();
  assert.equal(r.ok, true);
  assert.equal(rpcs.at(-1).args.p.pay_preferred, 'bank_wire');
  assert.match(elements.stPay.innerHTML, /Invoices show how to pay\. Bank transfer is shown first\./);
  assert.equal(elements.stPayMsg.textContent, 'Saved.');
  assert.ok(toasts.includes('The payment details are saved.'));

  el('stPay_bank_wire_account_number').value = 'not digits';
  assert.equal((await stSubmitPay()).ok, false);
  assert.match(elements.stPayMsg.textContent, /Beneficiary account number should be digits/);
  assert.ok(!elements.stPayMsg.textContent.includes('not digits'), 'the message never echoes the value');

  rpcFail = { message: 'Only the owner can see this.' };
  await stLoadPay();
  assert.match(elements.stPay.innerHTML, /Only the owner can see this\./);
});

test('no stored payment value is ever written to a log, and no real detail is in the file', () => {
  const src = fs.readFileSync(path.join(root, 'settings.js'), 'utf8');
  assert.deepEqual(src.match(/console\.(log|warn|error|info|debug)/g), null, 'settings.js logs nothing');
  /* nothing in the file could be mistaken for a real account, link or key */
  assert.deepEqual(src.match(/\b\d{6,}\b/g), null, 'no long number is hard-coded');
  for (const re of [/\bsk_live\b/, /\bpk_live\b/, /paypal\.me\/[a-z0-9]/i, /wise\.com\/[a-z]/i]) {
    assert.doesNotMatch(src, re, String(re));
  }
});

/* ───────────── the rehearsal pass ───────────── */

test('opening Settings asks the database for the business row ONCE, not once per card', async () => {
  /* Two cards — "Payments and documents" and "Payment details" — are two views
     of one row. Each used to read it on open. */
  el('stMe'); el('stCal'); el('stOut'); el('stBiz'); el('stPay');
  await stLoad();
  const reads = rpcs.filter((r) => r.name === 'biz_get').length;
  assert.equal(reads, 1, 'biz_get is asked for once per open, not twice');
  assert.match(elements.stBiz.innerHTML, /not set yet/, 'the business card still fills in');
  assert.ok(elements.stPay.innerHTML.length > 0, 'the payment card still fills in');
});

test('a client list that FAILED to load does not read as "no clients yet"', () => {
  /* The picker that connects an Instantly or Smartlead account. An empty list
     and a list that did not load look the same from here; they must not read
     the same. */
  const failed = stRenderOut([], [], 'Can’t reach Aviance right now. Check your connection and try again.');
  assert.match(text(failed), /Your clients did not load/);
  assert.ok(!/No clients yet/.test(text(failed)), 'it never claims he has no clients');
  assert.match(text(failed), /Check your connection/, 'and it says why');

  const empty = stRenderOut([], [], '');
  assert.match(text(empty), /No clients yet/);
  assert.ok(!/did not load/.test(text(empty)));
});
