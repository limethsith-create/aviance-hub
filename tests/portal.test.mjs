/* Client accounts: client mode (only Channels and Numbers, nothing of the owner's fetched), the join page (#join={token}),
   and the owner's "Invite to their portal". Same set-up as simple.test.mjs: the shell's inline script and the section
   scripts in a tiny fake DOM with a fake Supabase client. No network. Run with: npm test */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', checked: false, innerHTML: '', textContent: '', style: {}, placeholder: '', autocomplete: '', disabled: false, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() {}, select() {}, addEventListener() {}, scrollIntoView() {}, closest() { return null; }, getAttribute() { return null; }, setAttribute() {} };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
const store = () => ({ _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } });
globalThis.localStorage = store();
globalThis.sessionStorage = store();
let clip = null;
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { clip = t; } } }, configurable: true });
globalThis.location = { hash: '', origin: 'https://aviance.store', pathname: '/', search: '', reloads: 0, reload() { this.reloads++; } };
globalThis.history = { replaceState() {} };
globalThis.confirm = () => true; globalThis.prompt = () => 'a reason';
const winListeners = {}; globalThis.addEventListener = (type, fn) => { (winListeners[type] ||= []).push(fn); };
const calls = [];   // every network call the hub makes
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', body: init.body }); return new Response('{}', { status: 200 }); };

const supa = { session: null, user: null, profile: null, signOuts: 0, signUp: null, signIn: null, rpc: null, rpcCalls: [], inserts: [], insertError: null };
const fakeSb = {
  auth: {
    getSession: async () => ({ data: { session: supa.session } }), getUser: async () => ({ data: { user: supa.user } }),
    signInWithPassword: async (c) => (supa.signIn ? supa.signIn(c) : { error: null }), signUp: async (c) => (supa.signUp ? supa.signUp(c) : { data: { session: { access_token: 't' } }, error: null }),
    signOut: async () => { supa.signOuts++; supa.session = null; }, resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }),
  },
  from: (table) => ({
    select: () => { const c = { eq: () => c, is: () => c, gt: () => c, limit: () => c, maybeSingle: async () => ({ data: supa.profile }), then: (res, rej) => Promise.resolve({ data: supa.liveInvites || [] }).then(res, rej) }; return c; },
    insert: async (row) => { supa.inserts.push({ table, row }); return { error: supa.insertError }; },
  }),
  rpc: async (name, args) => { supa.rpcCalls.push({ name, args }); return supa.rpc ? supa.rpc(name, args) : { data: 'stone-roofing', error: null }; },
};
globalThis.supabase = { createClient: () => fakeSb };

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="trials.js">'));
const FILES = ['trials.js', 'inquiries.js', 'feed.js', 'calendar.js', 'messages.js', 'autobuy.js', 'warmup.js', 'keys.js', 'people.js', 'numbers.js'];
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
for (const f of FILES) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
after(() => { trialsStopTimer(); calendarStopTimer(); if (pp.beat) clearInterval(pp.beat); clearTimeout(window._tt); });
const tick = () => new Promise((r) => setTimeout(r, 5));
const TOKEN = 'abcDEF0123456789_-abcDEF0123456789_-xyz';

async function signInAsClient() {
  authUser = null; calls.length = 0;
  supa.session = { access_token: 'client-token' };
  supa.user = { id: 'c1', email: 'dana@stone.test' };
  supa.profile = { id: 'c1', name: 'Dana', email: 'dana@stone.test', role: 'client', approved: true, client_id: 'stone-roofing' };
  await routeUser('loginErr');
}

test('client mode: an approved client profile gets in with clientId, and sees only Channels, Numbers and People', async () => {
  await signInAsClient();
  assert.equal(authUser.role, 'client'); assert.equal(authUser.clientId, 'stone-roofing');
  assert.equal(el('app').style.display, 'grid');
  assert.ok(document.body._classes.has('client-mode') && document.body._classes.has('ro'));
  assert.deepEqual(navItems().map((i) => [i.view, i.label]), [['channels', 'Channels'], ['numbers', 'Numbers'], ['clientPeople', 'People']]);
  for (const id of ['navArea', 'tabBar']) {
    const nav = el(id).innerHTML;
    assert.equal((nav.match(/<button class="(nav-item|tab)/g) || []).length, 3, id);
    assert.ok(!/Clients|Calendar|Team|Activity|Settings/.test(nav.replace(/<[^>]*>/g, ' ')), id + ': nothing of the owner\'s');
  }
  assert.equal(currentView, 'channels', 'lands on Channels');
  assert.equal(el('ptitle').textContent, 'Channels');
  assert.ok(el('content').innerHTML.includes('Loading…'), 'a plain placeholder until channels.js is there');
});

test('client mode: nothing of the owner\'s is fetched or started', async () => {
  await signInAsClient();
  render('channels'); render('numbers'); render('paying'); render('settings'); render('calendar');
  await tick();
  assert.deepEqual(calls, [], 'no network call at all: ' + JSON.stringify(calls.map((c) => c.url)));
  assert.ok(['channels', 'numbers'].includes(currentView), 'owner screens redirect to Channels');
  assert.equal(currentView, 'channels');
  assert.deepEqual(computeNotifs(), []);
  // ⌘K / "/" / "n" shortcuts do nothing
  openCmdk(); assert.ok(!el('cmdkWrap')._classes.has('open'));
  assert.equal(peopleNavCount(), '', 'no approvals count');
});

test('client mode: Numbers hands the client\'s own id to renderClientNumbers', async () => {
  await signInAsClient();
  render('numbers');
  assert.ok(el('content').innerHTML.includes('data-nm-client="stone-roofing"'), 'the Numbers view is for their own client id');
  globalThis.viewChannels = () => '<p>channels screen</p>';
  render('channels');
  assert.ok(el('content').innerHTML.includes('channels screen'));
  delete globalThis.viewChannels;
});

test('client mode: a link to an owner screen, or to a client, stays inside Channels / Numbers; sign-out leaves client mode', async () => {
  await signInAsClient();
  assert.equal(goDeepLink({ view: 'trial', id: 'stone-roofing' }), true);
  assert.equal(currentView, 'channels');
  assert.deepEqual(parseDeepLink('#numbers'), { view: 'numbers' });
  goDeepLink(parseDeepLink('#numbers')); assert.equal(currentView, 'numbers');
  await logout();
  assert.equal(authUser, null); assert.ok(!document.body._classes.has('client-mode'));
  assert.deepEqual(calls, [], 'no presence call for a client');
});

test('sign-in: a client profile without a client id, or not approved, is still refused; owner and team unchanged', async () => {
  for (const profile of [{ id: 'c1', role: 'client', approved: true, client_id: null }, { id: 'c1', role: 'client', approved: false, client_id: 'x' }]) {
    authUser = null; supa.session = { access_token: 't' }; supa.user = { id: 'c1', email: 'a@b.c' }; supa.profile = profile;
    await routeUser('loginErr');
    assert.equal(authUser, null);
  }
  authUser = null; supa.session = { access_token: 't' }; supa.profile = { id: 'u2', name: 'Emp', approved: true, role: 'employee', email: 'e@x.c' };
  await routeUser('loginErr');
  assert.equal(authUser.role, 'employee'); assert.ok(!document.body._classes.has('client-mode'));
  assert.deepEqual(navItems().map((i) => i.view), ['paying', 'calendar', 'channels', 'team']);
  authUser = null; supa.session = { access_token: 't' }; supa.profile = { id: 'u1', name: 'Owner', approved: true, role: 'admin', email: 'o@x.c' };
  await routeUser('loginErr');
  assert.equal(authUser.role, 'admin');
  assert.deepEqual(navItems().map((i) => i.view), ['paying', 'calendar', 'channels', 'team', 'people', 'settings']);
  trialsStopTimer(); calendarStopTimer();
});

/* ── join ── */
test('join link: #join={token} is read once, kept for the page, and only a well-formed token counts', () => {
  assert.equal(parseJoinToken('#join=' + TOKEN), TOKEN);
  assert.equal(parseJoinToken('#x=1&join=' + TOKEN + '&y=2'), TOKEN);
  assert.equal(parseJoinToken('#join=short'), '');
  assert.equal(parseJoinToken('#join=<script>alert(1)</script>aaaaaaaaaaaaaaaa'), '');
  assert.equal(parseJoinToken(''), '');
  assert.ok(html.includes('id="joinBox"') && html.includes('Set up your Aviance account'));
});

async function startJoin(mode = 'new') {
  authUser = null; supa.rpcCalls.length = 0; supa.signOuts = 0; location.reloads = 0; supa.signIn = null; supa.signUp = null; supa.rpc = null;
  joinToken = TOKEN; showLogin(); showJoin(); joinSetMode(mode);
  el('joinOk').style.display = 'none'; el('joinErr').textContent = '';
}

test('join: set up a new account, claim the invite, reload into client mode', async () => {
  await startJoin();
  assert.ok(el('login')._classes.has('joining'));
  assert.equal(el('joinTitle').textContent, 'Set up your Aviance account');
  el('joinEmail').value = ' Dana@Stone.test '; el('joinPass').value = 'short';
  await doJoin(); assert.equal(el('joinErr').textContent, 'Use a password of at least 8 characters.');
  el('joinEmail').value = 'nope'; el('joinPass').value = 'longenough1';
  await doJoin(); assert.match(el('joinErr').textContent, /email address/);
  assert.equal(supa.rpcCalls.length, 0);
  let signedUp = null; supa.signUp = async (c) => { signedUp = c; return { data: { session: { access_token: 't' } }, error: null }; };
  el('joinEmail').value = ' Dana@Stone.test '; el('joinPass').value = 'longenough1';
  await doJoin();
  assert.deepEqual([signedUp.email, signedUp.password], ['dana@stone.test', 'longenough1']);
  assert.deepEqual(supa.rpcCalls, [{ name: 'claim_portal_invite', args: { p_token: TOKEN } }]);
  assert.equal(location.reloads, 1);
  assert.equal(joinToken, '', 'the token is forgotten after use');
  assert.equal(sessionStorage.getItem(JOIN_KEY), null);
});

test('join: someone who already has an account signs in instead; wrong password and a bad invite say so in plain words', async () => {
  await startJoin('existing');
  assert.equal(el('joinTitle').textContent, 'Sign in to join');
  supa.signIn = async () => ({ error: { message: 'Invalid login credentials' } });
  el('joinEmail').value = 'dana@stone.test'; el('joinPass').value = 'whatever12';
  await doJoin(); assert.equal(el('joinErr').textContent, 'Incorrect email or password.'); assert.equal(supa.rpcCalls.length, 0);
  let signedIn = null; supa.signIn = async (c) => { signedIn = c; return { error: null }; };
  supa.rpc = async () => ({ data: null, error: { message: 'This invite link is not valid any more. Ask Aviance for a new one.' } });
  await doJoin();
  assert.equal(signedIn.email, 'dana@stone.test');
  assert.equal(el('joinErr').textContent, 'This invite link is not valid any more. Ask Aviance for a new one.');
  assert.equal(supa.signOuts, 1, 'signed out again so nothing half-joined stays signed in'); assert.equal(location.reloads, 0);
  supa.rpc = async () => ({ data: null, error: { message: 'permission denied for function x' } });
  await doJoin();
  assert.ok(!/permission denied/.test(el('joinErr').textContent), 'no technical text'); assert.match(el('joinErr').textContent, /ask Aviance for a new link/);
});

test('join: an email already registered, or one that needs confirming first, is explained', async () => {
  await startJoin();
  supa.signUp = async () => ({ data: null, error: { message: 'User already registered' } });
  el('joinEmail').value = 'dana@stone.test'; el('joinPass').value = 'longenough1';
  await doJoin(); assert.match(el('joinErr').textContent, /already an account/); assert.equal(supa.rpcCalls.length, 0);
  supa.signUp = async () => ({ data: { session: null }, error: null });
  await doJoin(); assert.equal(el('joinOk').style.display, 'block'); assert.match(el('joinOk').textContent, /confirm your email/); assert.equal(supa.rpcCalls.length, 0);
  assert.equal(joinToken, TOKEN, 'the invite is kept for after the confirmation');
  joinSwitch(); assert.equal(joinMode, 'existing'); joinSwitch(); assert.equal(joinMode, 'new');
});

test('join: boot shows the set-up page first when an invite link is open', async () => {
  authUser = null; joinToken = TOKEN; supa.session = { access_token: 'someone-else' }; supa.user = { id: 'u9', email: 'o@x.c' }; supa.profile = { id: 'u9', role: 'admin', approved: true };
  await boot();
  assert.equal(authUser, null, 'not signed in as whoever was signed in before');
  assert.equal(el('login').style.display, 'flex'); assert.ok(el('login')._classes.has('joining'));
  joinToken = '';
});

/* ── the owner's invite ── */
test('invite to their portal: token + sha-256 hash + 14-day invite row, machine emails the link, the link is shown to copy', async () => {
  authUser = { uid: 'owner-1', name: 'Owner', role: 'admin', email: 'o@x.c' };
  const seen = []; let reply = { ok: true, status: 200, data: { ok: true, sent: true } };
  globalThis.fetch = async (url, init = {}) => { seen.push({ url: String(url), init }); return { ok: true, status: 200, text: async () => JSON.stringify(reply.data) }; };
  supa.session = { access_token: 'owner-token' };
  supa.inserts.length = 0; supa.insertError = null;
  const card = renderClientAccess({ dashboardAccess: { sharedWith: [] } }, 'stone-roofing');
  assert.ok(card.includes('Invite to their portal') && card.includes('id="tkPortalEmail"'));
  authUser = { uid: 'e1', name: 'Emp', role: 'employee', email: 'e@x.c' }; document.body._classes.add('ro');
  assert.ok(!renderClientAccess({}, 'stone-roofing').includes('Invite to their portal'), 'team members cannot invite');
  document.body._classes.delete('ro'); authUser = { uid: 'owner-1', name: 'Owner', role: 'admin', email: 'o@x.c' };

  el('tkPortalEmail').value = 'not-an-email';
  await clientInvitePortal('stone-roofing'); assert.equal(supa.inserts.length, 0);
  el('tkPortalEmail').value = 'Dana@Stone.test';
  const t0 = Date.now();
  await clientInvitePortal('stone-roofing');
  assert.equal(supa.inserts.length, 1);
  const { table, row } = supa.inserts[0];
  assert.equal(table, 'portal_invites');
  assert.deepEqual(Object.keys(row).sort(), ['client_id', 'created_by', 'email', 'expires_at', 'token_hash']);
  assert.equal(row.client_id, 'stone-roofing'); assert.equal(row.email, 'dana@stone.test'); assert.equal(row.created_by, 'owner-1');
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  const days = (new Date(row.expires_at).getTime() - t0) / 86400000;
  assert.ok(days > 13.99 && days < 14.01, 'expires in 14 days: ' + days);
  const post = seen.find((c) => /\/api\/mc\/clients\/stone-roofing$/.test(c.url));
  assert.equal(post.init.method, 'POST');
  const body = JSON.parse(post.init.body);
  assert.deepEqual([body.action, body.email], ['invitePortal', 'dana@stone.test']);
  const m = /^https:\/\/aviance\.store\/#join=([A-Za-z0-9_-]{43})$/.exec(body.link);
  assert.ok(m, 'a 32-byte url-safe token: ' + body.link);
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(m[1]))).toString('hex');
  assert.equal(row.token_hash, hash, 'only the sha-256 of the token is stored');
  assert.ok(!JSON.stringify(row).includes(m[1]), 'the token itself is never stored');
  const out = tkPortalOut('stone-roofing');
  assert.ok(out.includes('Sent to dana@stone.test') && out.includes(body.link));
  assert.equal(el('tkPortalOut').innerHTML, out);
  el('tkPortalLink').value = body.link; clientCopyPortalLink(); await tick(); assert.equal(clip, body.link);

  // two invites make two different tokens
  el('tkPortalEmail').value = 'dana@stone.test'; await clientInvitePortal('stone-roofing');
  assert.notEqual(supa.inserts[1].row.token_hash, row.token_hash);

  // the email fails: the link is still shown, in plain words
  reply = { ok: false, status: 500, data: { error: 'Set your signer name first.' } };
  globalThis.fetch = async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: 'Set your signer name (OWNER.signerName) in Config first.' }) });
  el('tkPortalEmail').value = 'sam@stone.test'; await clientInvitePortal('stone-roofing');
  const out2 = tkPortalOut('stone-roofing');
  assert.ok(out2.includes('Not emailed yet') && out2.includes('Copy the link and send it yourself') && out2.includes('#join='));

  // the invite row cannot be made: nothing is emailed
  supa.insertError = { message: 'permission denied' }; const before = supa.inserts.length;
  let emailed = 0; globalThis.fetch = async () => { emailed++; return { ok: true, status: 200, text: async () => '{}' }; };
  el('tkPortalEmail').value = 'x@stone.test'; await clientInvitePortal('stone-roofing');
  assert.equal(emailed, 0); supa.insertError = null; void before;

  // a team member cannot
  authUser = { uid: 'e1', name: 'Emp', role: 'employee', email: 'e@x.c' }; const n = supa.inserts.length;
  el('tkPortalEmail').value = 'y@stone.test'; await clientInvitePortal('stone-roofing');
  assert.equal(supa.inserts.length, n);
});

/* ── the automatic invite when a booking is marked paid ── */
test('paid: invites the booking to their portal; skipped when they already have a login or a live invite', async () => {
  authUser = { uid: 'owner-1', name: 'Owner', role: 'admin', email: 'o@x.c' }; supa.session = { access_token: 'owner-token' };
  iq.list = [{ id: 'q1', company: 'Stone', email: 'Dana@Stone.test', status: 'agreement_sent', invoice: { number: 'A1' } }];
  const posts = []; const toasts = [];
  globalThis.toast = (m) => toasts.push(m);
  globalThis.fetch = async (url, init = {}) => { posts.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null }); const paid = /inquiries$/.test(String(url)); return { ok: true, status: 200, text: async () => JSON.stringify(paid ? { ok: true, clientId: 'stone-roofing' } : { ok: true, sent: true }) }; };
  supa.profile = null; supa.liveInvites = []; supa.inserts.length = 0;
  await inquirySetStatus('q1', 'won');
  assert.equal(supa.inserts.length, 1); assert.equal(supa.inserts[0].row.client_id, 'stone-roofing'); assert.equal(supa.inserts[0].row.email, 'dana@stone.test');
  assert.ok(posts.some((c) => /clients\/stone-roofing$/.test(c.url) && c.body.action === 'invitePortal'));
  assert.ok(toasts.includes('Portal invite sent to dana@stone.test'));
  // they already have a login: nothing new
  supa.profile = { id: 'u7' }; await inquirySetStatus('q1', 'won'); assert.equal(supa.inserts.length, 1);
  // a live unused invite exists: nothing new
  supa.profile = null; supa.liveInvites = [{ id: 'i1' }]; await inquirySetStatus('q1', 'won'); assert.equal(supa.inserts.length, 1);
  supa.liveInvites = [];
});
