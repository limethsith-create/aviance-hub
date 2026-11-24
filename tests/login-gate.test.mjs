/* Tests for the sign-in gate in index.html (routeUser / boot): the team gets in, a portal client
   is sent to portal.html and never enters this shell, and an old invite link is handed on to
   join.html. Same set-up as tests/pipeline.test.mjs: the shell's inline script in a tiny fake
   DOM with a fake `sb`. No network.
   Run with:  node --test tests/login-gate.test.mjs   (or npm test) */
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', innerHTML: '', textContent: '', style: {}, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() {}, select() {}, addEventListener() {}, scrollIntoView() {}, closest() { return null; }, getAttribute() { return null; }, setAttribute() {} };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
globalThis.sessionStorage = { _s: { avianceJoin: 'left-over-from-the-old-join-page' }, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const went = [];
const OLD_TOKEN = 'abcDEF123_-abcDEF123_-xyz';
globalThis.location = { hash: '#join=' + OLD_TOKEN, origin: 'https://aviance.store', pathname: '/', search: '', replace(u) { went.push(u); } };
globalThis.history = { replaceState() {} };
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
globalThis.addEventListener = () => {};

/* who is signed in, what their profile says, and what portal_home answers */
const s = { user: null, profile: null, home: null, homeError: null, signedOut: 0, rpcs: [] };
const fakeSb = {
  auth: {
    getSession: async () => ({ data: { session: s.user ? { access_token: 't' } : null } }),
    getUser: async () => ({ data: { user: s.user } }),
    signInWithPassword: async () => ({ error: null }),
    signOut: async () => { s.signedOut++; s.user = null; },
    signUp: async () => { throw new Error('the hub must not sign a client up'); },
  },
  from: () => { const b = { select: () => b, eq: () => b, order: () => b, limit: () => b, in: () => b, maybeSingle: async () => ({ data: s.profile, error: null }), then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return b; },
  rpc: async (name, args) => { s.rpcs.push(name); if (name === 'portal_home') return s.homeError ? { data: null, error: s.homeError } : { data: s.home, error: null }; return { data: null, error: null }; },
};
globalThis.supabase = { createClient: () => fakeSb };

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="finance.js">'));
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
after(() => { clearTimeout(window._tt); });

const HOME = { person: { id: 'p1', name: 'Dana' }, company: 'Acme Roofing', channel: { id: 'ch1', name: 'Acme Roofing' }, members: [] };
const inApp = () => el('app').style.display === 'grid';
beforeEach(() => {
  Object.assign(s, { user: { id: 'u1', email: 'x@y.test' }, profile: null, home: null, homeError: null, signedOut: 0, rpcs: [] });
  went.length = 0; authUser = null; el('app').style.display = 'none'; el('loginErr').textContent = '';
  globalThis.render = () => {};
});

test('an old-style invite link is handed straight to join.html, token in the fragment', async () => {
  assert.equal(parseJoinToken('#join=' + OLD_TOKEN), OLD_TOKEN);
  assert.equal(parseJoinToken('#join=short'), '');
  s.user = null;
  await boot();
  assert.deepEqual(went, ['/join.html#' + OLD_TOKEN]);
  assert.equal(sessionStorage.getItem('avianceJoin'), null, 'the old page\'s left-over token is cleared');
  for (const gone of ['doJoin', 'showJoin', 'joinSwitch', 'joinDone'])
    assert.equal(typeof globalThis[gone], 'undefined', gone + ' is gone');
  assert.ok(!/claim_portal_invite/.test(html), 'the RPC that does not exist is no longer called');
  assert.ok(!html.includes('id="joinBox"'), 'the old join form is gone');
});

test('the owner and an approved team member get in without portal_home being asked', async () => {
  s.profile = { id: 'u1', name: 'Owner', role: 'admin', approved: true, email: 'o@aviance.test' };
  await routeUser('loginErr');
  assert.equal(authUser.role, 'admin'); assert.ok(inApp());
  assert.deepEqual(s.rpcs.filter((n) => n === 'portal_home'), []); assert.deepEqual(went, []);
  authUser = null;
  s.profile = { id: 'u1', name: 'Sam', role: 'employee', approved: true };
  await routeUser('loginErr');
  assert.equal(authUser.role, 'employee');
});

test('a portal client is sent to portal.html, stays signed in, and never enters the hub shell', async () => {
  for (const prof of [null, { id: 'u1', role: 'client', approved: true, client_id: 'c1' }, { id: 'u1', role: 'employee', approved: false }]) {
    Object.assign(s, { user: { id: 'u1', email: 'dana@acme.test' }, profile: prof, home: HOME, signedOut: 0 });
    went.length = 0; authUser = null; el('app').style.display = 'none'; el('loginErr').textContent = '';
    await routeUser('loginErr');
    assert.deepEqual(went, ['/portal.html'], JSON.stringify(prof));
    assert.equal(authUser, null, 'no hub identity is made for a client');
    assert.ok(!inApp(), 'the hub shell is not shown');
    assert.equal(s.signedOut, 0, 'they stay signed in for their own page');
    assert.equal(el('loginErr').textContent, '', 'no "waiting for approval" error');
    assert.equal(hubIsClient(), false);
  }
  assert.ok(!/prof\.client_id/.test(shell) && !/role:'client'/.test(shell), 'the stale client branch is gone');
});

test('someone who is neither the team nor a client is signed out and told why, as before', async () => {
  s.profile = { id: 'u1', role: 'employee', approved: false };
  await routeUser('loginErr');
  assert.match(el('loginErr').textContent, /waiting for the owner to approve it/);
  assert.equal(s.signedOut, 1); assert.equal(authUser, null); assert.ok(!inApp()); assert.deepEqual(went, []);

  // a role this shell does not know, with no portal: not let in either
  Object.assign(s, { user: { id: 'u1' }, profile: { id: 'u1', role: 'client', approved: true, client_id: 'c1' }, signedOut: 0 });
  await routeUser('loginErr');
  assert.match(el('loginErr').textContent, /for the Aviance team/);
  assert.equal(authUser, null); assert.ok(!inApp());

  // portal_home failing is not a way in
  Object.assign(s, { user: { id: 'u1' }, profile: null, homeError: { message: 'function portal_home() does not exist' }, signedOut: 0 });
  await routeUser('loginErr');
  assert.equal(authUser, null); assert.ok(!inApp()); assert.deepEqual(went, []); assert.equal(s.signedOut, 1);
});
