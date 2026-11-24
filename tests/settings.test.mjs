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

test('stRenderBiz: the six fields, their values, and "not set yet" beside every stand-in', () => {
  const h = stRenderBiz(SHIPPED);
  const t = text(h);
  for (const w of ['Company legal name', 'Company address', 'Billing email', 'Wise bank details', 'Payoneer link', 'Kickoff booking link', 'Save']) assert.ok(t.includes(w), 'missing: ' + w);
  for (const k of ['legal_name', 'address', 'email', 'wise_details', 'payoneer_link', 'kickoff_link']) assert.ok(h.includes('id="stBiz_' + k + '"'), k);
  assert.match(h, /<textarea id="stBiz_wise_details"[^>]*>\[WISE BANK DETAILS — add in Settings\]<\/textarea>/, 'Wise details are a textarea');
  assert.ok(h.includes('value="aviancelk@gmail.com"') && h.includes('value="https://www.aviance.online/book"'));
  assert.equal(h.split('not set yet').length - 1, 3, 'legal name, address and Wise details still hold a stand-in');
  for (const k of ['legal_name', 'address', 'wise_details']) assert.ok(h.includes('id="stBiz_' + k + '_note"'), k + ' is flagged');
  for (const k of ['email', 'payoneer_link', 'kickoff_link']) assert.ok(!h.includes('id="stBiz_' + k + '_note"'), k + ' is not');
  assert.ok(!h.includes('stBiz_site'), 'the site address is not on this card');

  // filled in: no notes left. Empty, null and nasty values draw without holes.
  assert.ok(!stRenderBiz({ ...SHIPPED, legal_name: 'Aviance (Pvt) Ltd', address: '1 Main St', wise_details: 'IBAN 123' }).includes('not set yet'));
  for (const d of [{}, null, undefined]) assert.ok(!/undefined|null|NaN/.test(stRenderBiz(d)));
  const nasty = stRenderBiz({ legal_name: '"><img src=x>', wise_details: '</textarea><script>x</script>' });
  assert.ok(!nasty.includes('<img') && !nasty.includes('<script>'));
  assert.equal(stIsPlaceholder('  [x]'), true); assert.equal(stIsPlaceholder('x [y]'), false); assert.equal(stIsPlaceholder(''), false); assert.equal(stIsPlaceholder(null), false);
});

test('stBiz reads with biz_get and stSaveBiz saves with biz_set {p}; both are the owner\'s alone', async () => {
  const got = await stBiz();
  assert.deepEqual(Object.keys(got).sort(), ['data', 'error', 'ok']);
  assert.equal(got.ok, true); assert.equal(got.data.legal_name, '[YOUR COMPANY LEGAL NAME]');
  assert.equal(rpcs[0].name, 'biz_get');

  const saved = await stSaveBiz({ legal_name: '  Aviance (Pvt) Ltd ', address: '1 Main St, Colombo', email: 'billing@aviance.test',
    wise_details: 'Account 123\nSWIFT ABC', payoneer_link: '', kickoff_link: 'https://cal.test/kickoff', site: 'https://evil.test' });
  assert.equal(saved.ok, true);
  assert.deepEqual(rpcs.at(-1), { name: 'biz_set', args: { p: { legal_name: 'Aviance (Pvt) Ltd', address: '1 Main St, Colombo', email: 'billing@aviance.test',
    wise_details: 'Account 123\nSWIFT ABC', payoneer_link: '', kickoff_link: 'https://cal.test/kickoff' } } }, 'only the six fields, trimmed');
  assert.equal(saved.data.legal_name, 'Aviance (Pvt) Ltd');
  await stSaveBiz({ address: 'Only this' });
  assert.deepEqual(rpcs.at(-1).args, { p: { address: 'Only this' } }, 'a field not given is not sent');

  // turned down before the database is asked
  const n = rpcs.length;
  assert.match((await stSaveBiz({ email: 'not-an-email' })).error, /billing email/);
  assert.match((await stSaveBiz({ payoneer_link: 'javascript:alert(1)' })).error, /Payoneer link has to start with https/);
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
  for (const k of ['legal_name', 'address', 'email', 'wise_details', 'payoneer_link', 'kickoff_link']) el('stBiz_' + k).value = SHIPPED[k];
  el('stBiz_legal_name').value = 'Aviance (Pvt) Ltd'; el('stBizMsg');
  const r = await stSubmitBiz();
  assert.equal(r.ok, true);
  assert.equal(rpcs.at(-1).name, 'biz_set'); assert.equal(rpcs.at(-1).args.p.legal_name, 'Aviance (Pvt) Ltd');
  assert.equal(elements.stBiz.innerHTML.split('not set yet').length - 1, 2, 'one fewer stand-in after the save');
  assert.ok(toasts.includes('The payment details are saved.'));
  el('stBiz_email').value = 'nope';
  assert.equal((await stSubmitBiz()).ok, false);
  assert.match(elements.stBizMsg.textContent, /billing email/);

  rpcFail = { message: 'Only the owner can see this.' };
  await stLoadBiz();
  assert.match(elements.stBiz.innerHTML, /Only the owner can see this\./);
});
