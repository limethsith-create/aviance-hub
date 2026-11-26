/* Tests for team-page.js + team.html — the one-click invite link on the employee's page
   (aviance.store/team), and the two things on that page a person can feel: what she types
   while a message is sending, and how long her pictures take to appear.

   The rest of the page (the thread, the sign-in form, the escaping) is covered in
   tests/team.test.mjs. Here team-page.js runs in a vm with a fake Supabase client, and the
   page's own inline script runs on top of it against a small fake document, so the boot
   flow is tested for real instead of by reading the source.

   Run with: npm test. No browser, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(root, 'team-page.js'), 'utf8');
const HTML = fs.readFileSync(path.join(root, 'team.html'), 'utf8');
const INLINE = HTML.slice(HTML.lastIndexOf('<script>') + 8, HTML.lastIndexOf('</script>'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const plain = (x) => JSON.parse(JSON.stringify(x));

const ME = () => ({
  staff: { id: 's1', name: 'Dilini' }, owner: { id: 'o1', name: 'Limethsith' }, channel: { id: 'ch1' },
  messages: [{ id: 1, author_user: 'o1', body: 'welcome', created_at: '2026-11-24T09:00:00Z' }],
});

/* One fresh world per test: a fake Supabase, a fake address bar, a fake document. */
function world(opts) {
  const o = opts || {};
  const calls = [];
  const w = {
    calls,
    otp: { data: { session: { access_token: 'fromlink', user: { email: 'dilini@example.com' } } }, error: null },
    session: { data: { session: null }, error: null },
    me: () => ({ data: ME(), error: null }),
    send: (a) => ({ data: { id: 99, author_user: 's1', body: a.p_body, created_at: new Date().toISOString() }, error: null }),
    sign: async (p) => ({ data: { signedUrl: 'https://files.test/' + p }, error: null }),
  };
  const sb = {
    from() { throw new Error('the team page must never touch a table directly'); },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      if (name === 'staff_me') return w.me();
      if (name === 'staff_send') return w.send(args);
      return { data: null, error: null };
    },
    auth: {
      async signInWithPassword(p) { calls.push({ signIn: p }); return { data: { session: {} }, error: null }; },
      async signOut(x) { calls.push({ signOut: x }); return {}; },
      async getSession() { calls.push({ getSession: 1 }); return w.session; },
      async verifyOtp(p) { calls.push({ verifyOtp: p }); if (w.otp instanceof Error) throw w.otp; return w.otp; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
    storage: { from: () => ({ createSignedUrl: (p) => { calls.push({ sign: p }); return w.sign(p); }, async upload() { return { data: {}, error: null }; } }) },
  };
  const els = {};
  const mk = (id) => els[id] || (els[id] = {
    id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, on: {},
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    focus() {}, click() {}, setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    querySelector(sel) { return mk(sel.charAt(0) === '#' ? sel.slice(1) : sel); },
    addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); },
  });
  const sandbox = {
    console, Date, Number, Math, Promise, Array, String, Boolean, Object, JSON, RegExp, Error, isFinite,
    setTimeout, clearTimeout, crypto,
    setInterval: () => 1, clearInterval: () => {},
    document: { hidden: false, title: '', getElementById: mk, addEventListener() {} },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  if (o.hash != null || o.search != null) {
    sandbox.location = { pathname: '/team', search: o.search || '', hash: o.hash || '' };
    sandbox.history = { replaceState(a, b, url) { calls.push({ replaced: url }); sandbox.location.hash = ''; } };
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), sandbox, { filename: 'core.js' });
  vm.runInContext(SRC + `;globalThis.api={tmcLinkToken,tmcForgetLinkToken,tmcLinkProblem,tmcClaimLink,tmcLeftover,tmcUseClient,
    tmcSignInHtml,TMC_LINK_BAD,TMC_LINK_SAY,TMC_OFFLINE,TMC_OWNER};`, sandbox, { filename: 'team-page.js' });
  sandbox.api.tmcUseClient(sb);
  w.A = sandbox.api; w.sandbox = sandbox; w.el = mk;
  w.boot = async () => { vm.runInContext(INLINE, sandbox, { filename: 'team.html (inline script)' }); await tick(); await tick(); };
  w.fire = (type, target) => (mk('tmcRoot').on[type] || []).forEach((fn) => fn({ target, preventDefault() {} }));
  return w;
}

/* ═════════════════ the link itself (mirrors caller-page.js) ═════════════════ */

test('a one-click link signs her in and is wiped from the address bar', async () => {
  const w = world({ hash: '#k=one-time-token-abc' });
  assert.equal(w.A.tmcLinkToken(), 'one-time-token-abc');
  const r = await w.A.tmcClaimLink();
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.access_token, 'fromlink');
  assert.deepEqual(plain(w.calls.find((c) => c.verifyOtp).verifyOtp), { token_hash: 'one-time-token-abc', type: 'email' });
  assert.ok(w.calls.some((c) => c.replaced === '/team'), 'the token is taken out of the address bar at once');
  assert.equal(w.sandbox.location.hash, '');
  // the wipe happens BEFORE the token is spent, so a slow network never leaves it on screen
  assert.ok(w.calls.findIndex((c) => c.replaced) < w.calls.findIndex((c) => c.verifyOtp));
});

test('a percent-encoded token is decoded; a query string on the page survives the wipe', async () => {
  const w = world({ hash: '#k=abc%2Bdef&x=1', search: '?from=mail' });
  assert.equal(w.A.tmcLinkToken(), 'abc+def');
  await w.A.tmcClaimLink();
  assert.ok(w.calls.some((c) => c.replaced === '/team?from=mail'));
});

test('a used, expired or broken link reads as one plain sentence, never as an auth message', async () => {
  for (const otp of [
    { data: { session: null }, error: { message: 'Email link is invalid or has expired' } },
    { data: { session: null }, error: { message: 'Invalid login credentials' } },
    { data: { session: null }, error: null },
    new Error('otp_expired: token has expired or is invalid'),
  ]) {
    const w = world({ hash: '#k=dead-token' });
    w.otp = otp;
    const r = await w.A.tmcClaimLink();
    assert.equal(r.ok, false);
    assert.equal(r.error, w.A.TMC_LINK_BAD);
    assert.doesNotMatch(r.error, /otp|token|credentials|jwt|supabase|password/i);
    assert.match(r.error, /new one|code below/);
  }
  // no connection is a different problem with a different fix, and says so
  const off = world({ hash: '#k=fine-token' });
  off.otp = new Error('Failed to fetch');
  assert.equal((await off.A.tmcClaimLink()).error, off.A.TMC_OFFLINE);
});

test('the link checker can also turn her away before she gets here', () => {
  assert.match(world({ search: '?link=expired' }).A.tmcLinkProblem(), /run out/);
  assert.match(world({ search: '?link=email' }).A.tmcLinkProblem(), /no email address/);
  const w = world({ search: '?link=made-up-reason' });
  assert.equal(w.A.tmcLinkProblem(), w.A.TMC_LINK_BAD);
  // a reason that happens to be the name of something built in is still just an unknown reason
  for (const odd of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const o = world({ search: '?link=' + odd });
    assert.equal(o.A.tmcLinkProblem(), o.A.TMC_LINK_BAD, odd);
  }
  assert.equal(world({ search: '' }).A.tmcLinkProblem(), '');
  // every sentence is for her: no internals, and each says what to do next
  const A = world().A;
  Object.keys(A.TMC_LINK_SAY).forEach((k) => {
    assert.match(A.TMC_LINK_SAY[k], /^[A-Z].*\.$/, k);
    assert.doesNotMatch(A.TMC_LINK_SAY[k], /token|otp|supabase|password|hash/i, k);
    assert.match(A.TMC_LINK_SAY[k], /Ask Limethsith|Try it once more|code below/, k);
  });
});

test('without a browser around, the link code stays quiet instead of throwing', async () => {
  const w = world();                                   // no location, no history
  assert.equal(w.A.tmcLinkToken(), '');
  assert.equal(w.A.tmcLinkProblem(), '');
  w.A.tmcForgetLinkToken();
  const r = await w.A.tmcClaimLink();
  assert.equal(r.ok, true); assert.equal(r.data, null);
  assert.equal(w.calls.length, 0, 'no link, nothing asked');
});

/* ═════════════════ the page: what boot() does with a link ═════════════════ */

test('team.html: a good link opens her channel with no code asked for', async () => {
  const w = world({ hash: '#k=good-token' });
  await w.boot();
  assert.match(w.el('tmcRoot').innerHTML, /id="tmcCompose"/, 'she lands in her channel');
  assert.doesNotMatch(w.el('tmcRoot').innerHTML, /id="tmcInForm"/);
  assert.ok(w.calls.some((c) => c.verifyOtp) && w.calls.some((c) => c.rpc === 'staff_me'));
  assert.equal(w.calls.some((c) => c.getSession), false, 'the link is spent before anything else is tried');
  assert.equal(w.sandbox.location.hash, '');
});

test('team.html: a dead link falls back to the code form and says why in one sentence', async () => {
  const w = world({ hash: '#k=dead-token' });
  w.otp = { data: { session: null }, error: { message: 'Email link is invalid or has expired' } };
  await w.boot();
  const h = w.el('tmcRoot').innerHTML;
  assert.match(h, /id="tmcInForm"/, 'the ordinary sign-in is still there');
  assert.ok(h.includes(w.A.TMC_LINK_BAD), 'and it says what happened');
  assert.equal(w.sandbox.location.hash, '', 'the dead token is gone from the address bar too');
});

test('team.html: a dead link does not throw away a login she already has', async () => {
  const w = world({ hash: '#k=dead-token' });
  w.otp = { data: { session: null }, error: { message: 'expired' } };
  w.session = { data: { session: { user: { email: 'dilini@example.com' } } }, error: null };
  await w.boot();
  assert.match(w.el('tmcRoot').innerHTML, /id="tmcCompose"/);
});

test('team.html: turned away by the link checker (?link=expired) she is told, and can still use her code', async () => {
  const w = world({ search: '?link=expired' });
  await w.boot();
  const h = w.el('tmcRoot').innerHTML;
  assert.match(h, /id="tmcInForm"/);
  assert.match(h, /That link has run out\./);
  assert.equal(w.calls.some((c) => c.verifyOtp), false);
  // and an ordinary visit says nothing at all
  const calm = world({ search: '' });
  await calm.boot();
  assert.match(calm.el('tmcRoot').innerHTML, /id="tmcInErr" role="alert" aria-live="assertive"><\/p>/);
});

/* ═════════════════ only the fenced block may touch the address bar ═════════════════ */

test('nothing on her page reads or changes where the browser is, except the fenced link block', () => {
  const fenced = SRC.match(/---8<--- link-claim[\s\S]*?---8<--- end link-claim ---8<--- \*\//g) || [];
  assert.equal(fenced.length, 1, 'exactly one fenced block may touch the address bar');
  ['location.href', 'window.open', 'history.push', 'location.assign', 'location.replace', '<a ', '<nav'].forEach((x) =>
    assert.equal(fenced[0].indexOf(x), -1, 'even the fenced block never navigates: ' + x));
  const code = INLINE.replace(/tmcClaimLink\(\)|tmcLinkProblem\(\)/g, ' ') + SRC.replace(fenced[0], ' ');
  ['location.href', 'location.hash', 'window.location', 'history.push', 'history.replace', 'location.assign', 'location.replace', '<nav']
    .forEach((x) => assert.equal(code.indexOf(x), -1, 'no ' + x + ' outside the fenced block'));
  // the session is still never read out of the URL by Supabase itself: only our block does it
  assert.match(SRC, /detectSessionInUrl: false/);
  // the one window.open on the page opens a signed file link she tapped, nothing else
  assert.equal((INLINE.match(/window\.open\(/g) || []).length, 1);
  assert.match(INLINE, /window\.open\(r\.data, '_blank', 'noopener'\)/);
  // the sign-in form itself still offers no self-service link of any kind
  assert.doesNotMatch(world().A.tmcSignInHtml({}), /magic link|one-time link|forgot|reset/i);
});

/* ═════════════════ what she can feel ═════════════════ */

test('what she types while a message is sending is kept', async () => {
  const A = world().A;
  assert.equal(A.tmcLeftover('hello', 'hello'), '', 'nothing new: the box empties');
  assert.equal(A.tmcLeftover('hello', 'hello and the next thing'), 'and the next thing');
  assert.equal(A.tmcLeftover('hello', 'rewritten'), 'rewritten');
  assert.equal(A.tmcLeftover(null, null), '');

  const w = world();
  w.session = { data: { session: { user: { email: 'dilini@example.com' } } }, error: null };
  let land;
  w.send = (a) => new Promise((r) => { land = () => r({ data: { id: 99, author_user: 's1', body: a.p_body, created_at: new Date().toISOString() }, error: null }); });
  await w.boot();
  const box = w.el('tmcText');
  box.value = 'first message';
  w.fire('submit', { id: 'tmcCompose' });
  await tick();
  box.value = 'first message second one already';
  land(); await tick(); await tick();
  assert.equal(box.value, 'second one already');
  assert.equal(w.calls.filter((c) => c.rpc === 'staff_send').length, 1);
  assert.equal(w.calls.find((c) => c.rpc === 'staff_send').args.p_body, 'first message');
});

test('her pictures are signed together, not one after another', async () => {
  const w = world();
  w.session = { data: { session: { user: { email: 'dilini@example.com' } } }, error: null };
  const msgs = [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, author_user: 'o1', body: 'pic', attachment_url: 'ch1/p' + i + '.png', created_at: '2026-11-24T09:0' + i + ':00Z' }));
  w.me = () => ({ data: Object.assign(ME(), { messages: msgs }), error: null });
  let open = 0, most = 0;
  w.sign = (p) => new Promise((r) => { open++; most = Math.max(most, open); setTimeout(() => { open--; r({ data: { signedUrl: 'https://files.test/' + p }, error: null }); }, 10); });
  await w.boot(); await tick(40);
  assert.equal(w.calls.filter((c) => c.sign).length, 6);
  assert.equal(most, 6, 'all six were in flight at once');
  assert.match(w.el('tmcThread').innerHTML, /<img src="https:\/\/files\.test\/ch1\/p6\.png"/);
});
