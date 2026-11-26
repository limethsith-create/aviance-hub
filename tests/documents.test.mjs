/* The owner's Documents screen (documents.js): a live preview of everything a client
   receives. These tests pin what the owner is shown: three plans, each month to month
   and on a 3-month term, never the retired one-off plan; and that the data call asks
   the database for the right thing and never throws. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'documents.js'), 'utf8');

/* documents.js runs inside the hub page, which gives it `esc` and `sb`. */
function load(answer) {
  const calls = [];
  const ctx = vm.createContext({
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    sb: { async rpc(name, args) { calls.push({ name, args }); if (answer instanceof Error) throw answer; return answer; } },
    setTimeout: () => 0,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), ctx, { filename: 'core.js' });
  vm.runInContext(src, ctx, { filename: 'documents.js' });
  return { D: (n) => vm.runInContext(n, ctx), calls };
}

const PLANS = [['starter', 'Starter'], ['starter3', 'Starter (3 months)'], ['growth', 'Growth'], ['growth3', 'Growth (3 months)'], ['scale', 'Scale'], ['scale3', 'Scale (3 months)']];
function pack(key, label) {
  return [
    { group: 'Agreements', key: 'agreement_' + key, type: 'agreement', title: 'Agreement — ' + label, doc: { kind: 'agreement' } },
    { group: 'Invoices', key: 'invoice_' + key, type: 'invoice', title: 'Invoice — ' + label, doc: { kind: 'invoice' } },
    { group: 'Receipts', key: 'receipt_' + key, type: 'invoice', title: 'Receipt — ' + label, doc: { kind: 'invoice', status: 'paid' } },
    { group: 'Emails — ' + label, key: 'mail_' + key + '_agreement_1', type: 'email', title: 'Agreement', subject: 'Agreement + invoice', text: 'Hi' },
  ];
}
const LIVE = [{ group: 'Discovery call', key: 'booking_confirmation', type: 'email', title: 'Booking confirmation', subject: 's', text: 't' }]
  .concat(...PLANS.map(([k, l]) => pack(k, l)));

test('the six packs on offer are all shown, each plan monthly then on its 3-month term', () => {
  const { D } = load();
  const items = D('dcPrepare')(LIVE);
  assert.equal(items.length, LIVE.length);
  const groups = [...new Set(items.map((x) => x.group))];
  assert.deepEqual(groups, ['Discovery call', 'Emails — Starter', 'Emails — Starter (3 months)', 'Emails — Growth', 'Emails — Growth (3 months)',
    'Emails — Scale', 'Emails — Scale (3 months)', 'Agreements', 'Invoices', 'Receipts']);
  assert.deepEqual(items.filter((x) => x.group === 'Agreements').map((x) => x.title),
    PLANS.map(([, l]) => 'Agreement — ' + l));
});

test('a database that still sends the retired plan\'s pack: every piece of it is left out', () => {
  const { D } = load();
  const old = LIVE.concat(
    pack('pilot', 'Pilot'),
    [{ group: 'Chat messages', key: 'chat_step_9', type: 'chat', title: 'Step: launch done', text: 'x', meta: { plan: 'PILOT' } },
     { group: 'Problems', key: 'err_pilot', type: 'error', title: 'Could not build the Pilot preview', text: 'boom' }]);
  const items = D('dcPrepare')(old);
  assert.equal(items.length, LIVE.length);
  assert.ok(!items.some((x) => /pilot/i.test(JSON.stringify(x))));
  /* the filter is about the plan, not the letters: an autopilot subject line stays */
  const kept = D('dcPrepare')([{ group: 'Emails — Growth', key: 'mail_growth_x_1', type: 'email', title: 'Autopilot tips', subject: 'On autopilot', text: 'a pilot scheme' }]);
  assert.equal(kept.length, 1);
  const r = D('dcRetired');
  for (const junk of [null, undefined, {}, { meta: null }, { group: 7, key: {}, title: [] }]) assert.equal(r(junk), false);
});

test('dcPrepare: junk in, nothing out; the repeat of the booking confirmation is dropped', () => {
  const { D } = load();
  const p = D('dcPrepare');
  assert.equal(p(null).length, 0); assert.equal(p('x').length, 0); assert.equal(p([null, {}, { key: 'a' }, { title: 'b' }]).length, 0);
  const items = p([{ group: 'Emails — Growth', key: 'm1', type: 'email', title: 'Booking Confirmation' }, { group: 'Discovery call', key: 'm2', type: 'email', title: 'Booking confirmation' }]);
  assert.deepEqual(items.map((x) => x.key), ['m2']);
});

test('dcFetch asks documents_preview and answers {ok, data, error} in plain words, never throwing', async () => {
  let t = load({ data: LIVE, error: null });
  let r = await t.D('dcFetch')();
  assert.equal(t.calls[0].name, 'documents_preview');
  assert.equal(r.ok, true); assert.equal(r.data.length, LIVE.length); assert.equal(r.error, null);

  t = load({ data: null, error: { code: 'P0001', message: 'Only the owner can see this.' } });
  r = await t.D('dcFetch')();
  assert.deepEqual([r.ok, r.data, r.error], [false, null, 'Only the owner can see this.']);

  t = load({ data: null, error: { code: '42883', message: 'function x(unknown) does not exist' } });
  r = await t.D('dcFetch')();
  assert.equal(r.ok, false); assert.equal(r.error, "The documents didn't load. Try again.");

  t = load(new TypeError('Failed to fetch'));
  r = await t.D('dcFetch')();
  assert.equal(r.ok, false); assert.match(r.error, /Can't reach Aviance/);

  /* An answer that is not a list is a FAILURE, not an empty preview. This used
     to come back as {ok:true, data:[]}, and the screen then read "0 things a
     client receives" — the one number this screen can never truthfully show. */
  t = load({ data: 'nonsense', error: null });
  r = await t.D('dcFetch')();
  assert.deepEqual([r.ok, r.data], [false, null]);
  assert.equal(r.error, "The documents didn't load. Try again.");
  t = load({ data: null, error: null });
  r = await t.D('dcFetch')();
  assert.equal((await t.D('dcFetch')()).ok, false, 'and so is no answer at all');
});

test('the preview is drawn by the client\'s own renderer, with the document safely inlined', () => {
  const { D } = load();
  const inv = D('dcDocSrc')({ type: 'invoice', doc: { kind: 'invoice', number: '</script><script>alert(1)</script>' } });
  assert.ok(inv.includes('pcInvoiceHtml(') && inv.includes('/portal-client.js') && inv.includes('/portal-client.css'));
  assert.ok(!inv.includes('</script><script>alert(1)') && inv.includes('\\u003c/script>'));
  assert.ok(D('dcDocSrc')({ type: 'agreement', doc: {} }).includes('pcAgreementHtml('));
  assert.doesNotThrow(() => D('dcDocSrc')({ type: 'invoice' }));
  const html = D('dcPreviewHTML')({ type: 'error', title: '<b>x</b>', text: '<i>boom</i>' });
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && html.includes('&lt;i&gt;boom&lt;/i&gt;'));
});

test('documents.js no longer talks about the retired plan as something on offer', () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(code.match(/pilot/gi), ['pilot', 'pilot', 'pilot'], 'only the three checks inside dcRetired');
  assert.ok(!/\$300/.test(src));
});

/* ───────────── the Documents screen says whether an invoice can be paid ─────────────
   Same `pay` block portal-client.js renders, so this never guesses. Only the name of a
   method is shown to the owner here — never an account number or a link. */
const FAKE_PAY = { ready: true, preferred: 'paypal', currency: 'USD', terms: 'Net 7',
  methods: [{ kind: 'bank_wire', fields: { account_holder: 'Aviance Test Holder', account_number: '0000 0000 0000' } },
    { kind: 'paypal', fields: { link: 'https://paypal.example/me/avianceTEST' } }] };

test('an invoice with no way to pay is flagged to the owner, and pointed at Settings', () => {
  const { D } = load();
  const note = D('dcPayNote');
  for (const pay of [{ ready: false, methods: [], wise_details: null, payoneer_link: '' },
    { ready: false, methods: [], payoneer_link: '' }]) {
    const h = note({ type: 'invoice', doc: { kind: 'invoice', status: 'sent', pay } });
    assert.match(h, /cannot tell a client how to pay/);
    assert.match(h, /Settings → Payment details/);
  }
  /* no pay block at all (an older preview): nothing is claimed either way */
  assert.equal(note({ type: 'invoice', doc: { kind: 'invoice', status: 'sent' } }), '');
  assert.equal(note({ type: 'agreement', doc: { pay: { ready: false } } }), '');
  for (const junk of [null, undefined, {}, { type: 'invoice' }, { type: 'invoice', doc: { pay: 'nope' } }]) {
    assert.doesNotThrow(() => note(junk));
  }
});

test('an invoice that can be paid names the method shown first, and shows no detail of it', () => {
  const { D } = load();
  const h = D('dcPayNote')({ type: 'invoice', doc: { kind: 'invoice', status: 'sent', pay: FAKE_PAY } });
  assert.match(h, /How to pay: <b>PayPal<\/b> first, then Bank transfer\./);
  assert.ok(!h.includes('cannot tell a client'));
  for (const secret of ['0000 0000 0000', 'Aviance Test Holder', 'paypal.example']) {
    assert.ok(!h.includes(secret), 'the owner\'s screen leaked a stored value: ' + secret);
  }
  /* an unknown pick falls back to the first method the database sent */
  assert.match(D('dcPayNote')({ type: 'invoice', doc: { kind: 'invoice', pay: { ...FAKE_PAY, preferred: 'nonsense' } } }),
    /<b>Bank transfer<\/b> first, then PayPal/);
  /* the older shape still counts as payable */
  assert.match(D('dcPayNote')({ type: 'invoice', doc: { kind: 'invoice', pay: { ready: true, methods: [], wise_details: 'Account 0000' } } }),
    /How to pay: <b>Bank transfer<\/b> first\./);
});

test('a receipt is never nagged about how to pay, and the note sits above the preview', () => {
  const { D } = load();
  assert.equal(D('dcPayNote')({ type: 'invoice', doc: { kind: 'invoice', status: 'paid', pay: { ready: false, methods: [] } } }), '');
  const html = D('dcPreviewHTML')({ type: 'invoice', title: 'Invoice — Growth',
    doc: { kind: 'invoice', status: 'sent', pay: { ready: false, methods: [] } } });
  assert.ok(html.indexOf('cannot tell a client how to pay') < html.indexOf('<iframe'));
  const ok = D('dcPreviewHTML')({ type: 'invoice', title: 'x', doc: { kind: 'invoice', status: 'paid', pay: FAKE_PAY } });
  assert.ok(!ok.includes('cannot tell a client') && ok.includes('<iframe'));
});

/* ───────────── the guard flag ─────────────
   dc.loading means "already asking". It gates dcLoad() and it disables the
   Refresh button. Left true after a failure the screen never asks again and
   Refresh never comes back: the owner has to reload the whole app. */
test('a data call that throws clears dc.loading, so the screen can be asked again', async () => {
  const t = load(new Error('The database did not answer.'));
  await t.D('dcLoad(false)');
  assert.equal(t.D('dc.loading'), false, 'the flag cleared, so Refresh works and dcLoad can ask again');
  /* and the screen says what happened, with the way out on it */
  const h = t.D('dcBodyHTML()');
  assert.match(h, /role="alert"/);
  assert.match(h, /didn't load/);
  assert.match(h, /dcLoad\(true\)/);
  assert.doesNotMatch(h, /disabled/, 'Refresh is not stuck disabled');
  /* really asking again: the next call reaches the database */
  const n = t.calls.length;
  await t.D('dcLoad(false)');
  assert.ok(t.calls.length > n, 'it asked again rather than sitting on the flag');
});

/* ── the preview must actually load ─────────────────────────────────────────
   The owner's preview iframe loaded portal-client.js on its own. That file opens
   with `const pcEsc = coreEsc`, so without core.js it throws on its first line and
   every agreement and every invoice came up as:

       Preview failed: Cannot access 'pcEsc' before initialization

   — a broken screen AND machine wording shown to a person, in the one place he goes
   to check what a client is about to receive. doc.html, which is what the CLIENT
   sees, has always loaded core.js first; only the owner's preview of the same
   document was broken.

   These read the generated markup as text rather than running a browser, because the
   thing that regresses is the script order in one template string. */
test('the preview loads core.js, and loads it before portal-client.js', () => {
  const src = fs.readFileSync(path.join(root, 'documents.js'), 'utf8');
  const tpl = /return `<!doctype html>[\s\S]*?<\/head>/.exec(src);
  assert.ok(tpl, 'the preview document template must still be a template literal here');
  const head = tpl[0];

  const core = head.indexOf('/core.js');
  const portal = head.indexOf('/portal-client.js');
  assert.ok(core !== -1,
    'the preview must load core.js — portal-client.js aliases coreEsc on its first line and throws without it');
  assert.ok(portal !== -1, 'the preview still loads portal-client.js');
  assert.ok(core < portal,
    'core.js must come FIRST: portal-client.js reads coreEsc at parse time, not at call time');
});

test('portal-client.js really does need core.js at parse time', () => {
  /* Pins the reason the test above exists, so nobody "tidies" it away: if this
     aliasing ever stops being top-level, the ordering above stops mattering and
     this test should be the one that tells you. */
  const pc = fs.readFileSync(path.join(root, 'portal-client.js'), 'utf8');
  assert.match(pc, /^const pc[A-Za-z]+ = core[A-Za-z]+;/m,
    'portal-client.js still aliases a core.js helper at the top level');
});
