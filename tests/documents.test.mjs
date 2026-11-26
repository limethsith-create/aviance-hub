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

  t = load({ data: 'nonsense', error: null });
  r = await t.D('dcFetch')();
  assert.deepEqual([r.ok, r.data.length], [true, 0]);
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
