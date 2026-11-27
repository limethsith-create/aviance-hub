/* Round three, agent 5: what a bad network, a second click, a dead sync and a
   signed-in owner found on the screens this agent owns. Every test here pins a
   fault that was first seen in a real browser (Playwright over a stubbed `sb`).
   Run with: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/* a context with core.js and one screen file in it, and a database that waits */
function load(file, extra, exportNames) {
  const calls = [];
  let fail = null, wait = 0;
  const answer = (label, data) => new Promise((res) => setTimeout(() => {
    res(fail ? { data: null, error: fail } : { data, error: null });
  }, wait));
  function builder(table) {
    let op = 'select', payload = null;
    const b = {
      select: () => b, eq: () => b, is: () => b, in: () => b, order: () => b, limit: () => b, range: () => b, or: () => b, not: () => b, ilike: () => b, gte: () => b, lte: () => b,
      insert: (p) => { op = 'insert'; payload = p; return b; },
      update: (p) => { op = 'update'; payload = p; return b; },
      upsert: (p) => { op = 'upsert'; payload = p; return b; },
      single: () => b, maybeSingle: () => b,
      then: (res, rej) => { calls.push({ table, op, payload }); return answer(table, op === 'select' ? (ctl.rows[table] !== undefined ? ctl.rows[table] : null) : (payload || {})).then(res, rej); },
    };
    return b;
  }
  const els = {};
  const ctl = {
    calls, rows: {}, toasts: [], els,
    set fail(v) { fail = v; }, set wait(v) { wait = v; },
    writes: () => calls.filter((c) => c.op !== 'select'),
  };
  const sandbox = Object.assign({
    console, Date, Number, Math, Promise, Array, String, Boolean, Object, JSON, RegExp, isNaN, Error, Intl, setTimeout, clearTimeout,
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    emptyState: (i, t, s) => `<div class="empty"><h3>${t}</h3><p>${s}</p></div>`,
    toast: (m) => ctl.toasts.push(m),
    val: (id) => String((els[id] && els[id].value) || '').trim(),
    errEl: () => false,
    document: { activeElement: null, getElementById: (id) => els[id] || null, querySelectorAll: (q) => (q === '.stDay' ? [{ checked: true, value: '1' }] : []) },
    sb: { from: builder, rpc: (name, args) => { calls.push({ rpc: name, op: 'rpc', payload: args }); return answer(name, ctl.rows['rpc:' + name] || {}); } },
    authUser: { uid: 'u-owner', role: 'admin', name: 'Owner' },
  }, extra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('core.js'), sandbox, { filename: 'core.js' });
  if (file) vm.runInContext(read(file) + `\n;globalThis.api={${exportNames.join(',')}};`, sandbox, { filename: file });
  return { s: sandbox, A: sandbox.api, ctl };
}

/* ═════════════ coreOnce: one press, one write ═════════════ */

test('coreOnce: a second call while the first is out does not run the work again, and both get the one answer', async () => {
  const { s } = load(null);
  let ran = 0;
  const work = () => new Promise((r) => setTimeout(() => { ran++; r({ ok: true, data: ran, error: '' }); }, 10));
  const a = s.coreOnce('k', work), b = s.coreOnce('k', work);
  assert.equal(a, b, 'the second press is handed the first press’s promise');
  assert.equal((await a).data, 1);
  assert.equal(ran, 1);
  /* once it has answered, the next press is a new intent and runs */
  await s.coreOnce('k', work);
  assert.equal(ran, 2);
});

test('coreOnce: different keys do not block each other, and a throw or a rejection comes back as a result in plain words', async () => {
  const { s } = load(null);
  let ran = 0;
  const slow = () => new Promise((r) => setTimeout(() => { ran++; r(1); }, 10));
  await Promise.all([s.coreOnce('a', slow), s.coreOnce('b', slow)]);
  assert.equal(ran, 2);
  const thrown = await s.coreOnce('t', () => { throw new Error('Failed to fetch'); });
  assert.equal(thrown.ok, false); assert.equal(thrown.error, s.CORE_OFFLINE);
  const rejected = await s.coreOnce('r', () => Promise.reject(new Error('relation "x" does not exist')));
  assert.equal(rejected.ok, false); assert.equal(rejected.error, s.CORE_NOT_READY);
  /* and the key is free again after a failure, or the button would be dead until a reload */
  assert.equal(await s.coreOnce('t', () => 7), 7);
});

test('coreOnce: the pressed button is off and aria-busy while the write is out, and back on afterwards', async () => {
  const { s } = load(null);
  const attrs = {};
  const btn = { tagName: 'BUTTON', disabled: false, isConnected: true, ownerDocument: null,
    setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, focus() {} };
  const p = s.coreOnce('k', () => new Promise((r) => setTimeout(() => r(1), 10)), btn);
  assert.equal(btn.disabled, true); assert.equal(attrs['aria-busy'], 'true');
  await p;
  assert.equal(btn.disabled, false); assert.equal('aria-busy' in attrs, false);
  /* a field, a missing element or a button already off is left exactly alone */
  const field = { tagName: 'INPUT', disabled: false };
  await s.coreOnce('f', () => 1, field); assert.equal(field.disabled, false);
  const off = { tagName: 'BUTTON', disabled: true, setAttribute() { throw new Error('touched'); } };
  await s.coreOnce('o', () => 1, off); assert.equal(off.disabled, true);
  await s.coreOnce('n', () => 1, null);
});

/* ═════════════ coreFresh ═════════════ */

test('coreFresh: recent is fresh; three missed ticks is stale; never read is stale and says so', () => {
  const { s } = load(null);
  const now = Date.parse('2026-11-27T12:00:00Z');
  const f = (iso, max) => s.coreFresh(iso, now, max);
  assert.equal(f('2026-11-27T11:50:00Z').stale, false);
  assert.equal(f('2026-11-27T11:15:00Z').stale, false, '45 minutes is the limit, not past it');
  assert.equal(f('2026-11-27T11:14:00Z').stale, true);
  const old = f('2026-11-24T12:00:00Z');
  assert.equal(old.stale, true); assert.equal(old.ago, '3 days ago'); assert.equal(old.known, true);
  for (const never of [null, '', undefined, 'not a date']) {
    const n = f(never);
    assert.equal(n.known, false); assert.equal(n.stale, true); assert.equal(n.ago, ''); assert.equal(n.minutes, null);
  }
  assert.equal(f('2026-11-27T11:14:00Z', 120).stale, false, 'a caller may set its own limit');
  assert.equal(f('2026-11-27T12:05:00Z').minutes, 0, 'a clock a little ahead is not negative age');
});

/* ═════════════ Settings ═════════════ */

const ST = ['stMe', 'stSaveMe', 'stOutState', 'stWhen', 'stRenderOut', 'stSubmitCal', 'stSubmitBiz', 'stSubmitPay', 'stSubmitMe', 'stTogglePause', 'stMeId'];

test('Settings "You": the shell signs a person in as authUser.uid, and the card reads and saves by it', async () => {
  const { A, ctl, s } = load('settings.js', {}, ST);
  ctl.rows.profiles = { id: 'u-owner', name: 'Dinuka' };
  /* exactly what index.html routeUser builds: uid, never id */
  assert.equal('id' in s.authUser, false);
  const r = await A.stMe();
  assert.equal(r.ok, true, 'it used to answer "You are not signed in." to the signed-in owner');
  assert.equal(r.data.name, 'Dinuka');
  const saved = await A.stSaveMe({ name: 'Dinuka P' });
  assert.equal(saved.ok, true);
  assert.equal(ctl.writes().length, 1); assert.equal(ctl.writes()[0].table, 'profiles');
  /* and with nobody signed in it still refuses, without asking the database */
  s.authUser = null; ctl.calls.length = 0;
  assert.equal((await A.stMe()).error, 'You are not signed in.');
  assert.equal(ctl.calls.length, 0);
  /* the shell's own shape is what the test above assumed */
  assert.match(read('index.html'), /authUser=\{uid:prof\.id/);
});

test('Settings: an account the sync last read three days ago does not say "Reading"', () => {
  const { A } = load('settings.js', {}, ST);
  const now = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(A.stOutState({ status: 'ok', last_synced_at: '2026-11-27T11:50:00Z' }, now).word, 'Reading');
  const down = A.stOutState({ status: 'ok', last_synced_at: '2026-11-24T11:00:00Z' }, now);
  assert.equal(down.word, 'Stopped reading'); assert.equal(down.cls, 'st-err');
  assert.match(down.why, /Last read 3 days ago/); assert.match(down.why, /as it stood then/);
  /* the live database on 2026-11-27: three accounts at 'ok' that have never been read */
  const never = A.stOutState({ status: 'ok', last_synced_at: null }, now);
  assert.equal(never.word, 'Never read'); assert.equal(never.cls, 'st-err');
  /* the states that are not a fault are untouched */
  assert.equal(A.stOutState({ status: 'needs_key' }, now).word, 'Waiting for its key');
  assert.equal(A.stOutState({ status: 'paused', last_synced_at: '2020-01-01T00:00:00Z' }, now).word, 'Paused');
  assert.equal(A.stOutState({ status: 'error' }, now).word, 'Could not read');
  assert.match(A.stWhen('2026-11-24T11:00:00Z', now), /2026-11-24 11:00 UTC · 3 days ago/);
  assert.equal(A.stWhen(null, now), 'never');
  const html = A.stRenderOut([{ id: 'a', status: 'ok', last_synced_at: '2020-01-01T00:00:00Z', provider: 'instantly', label: 'Main' }], [], '');
  assert.match(html, /Stopped reading/); assert.doesNotMatch(html, />Reading</);
});

test('Settings: two presses on Save are one write, on every card', async () => {
  for (const [fn, n] of [['stSubmitCal', 1], ['stSubmitBiz', 1], ['stSubmitPay', 1], ['stSubmitMe', 1]]) {
    const { A, ctl } = load('settings.js', {}, ST);
    ctl.wait = 10;
    ctl.els.stName = { value: 'Dinuka' };
    ctl.els.stBiz_legal_name = { value: 'Aviance' }; ctl.els.stBiz_email = { value: 'a@b.co' };
    ctl.els.stBizMsg = { textContent: '' };
    ctl.els.stOpen = { value: '07:00' }; ctl.els.stClose = { value: '21:00' }; ctl.els.stSlot = { value: '30' };
    ctl.els.stNotice = { value: '12' }; ctl.els.stAhead = { value: '21' };
    ctl.els.stUsZone = { value: 'America/New_York' }; ctl.els.stOwnZone = { value: 'Asia/Colombo' }; ctl.els.stLink = { value: '' };
    A[fn](); A[fn]();
    await tick(60);
    const w = ctl.calls.filter((c) => c.op !== 'select' && c.rpc !== 'biz_get');
    assert.equal(w.length, n, fn + ' wrote ' + w.length + ' times for two presses');
  }
  const { A, ctl } = load('settings.js', {}, ST);
  ctl.wait = 10;
  A.stTogglePause('oa1', true); A.stTogglePause('oa1', true);
  await tick(60);
  assert.equal(ctl.writes().length, 1);
});

/* ═════════════ Team ═════════════ */

test('Team: two presses on Approve, or on "Give them this client", are one write', async () => {
  const { A, ctl } = load('team.js', {}, ['tmDoApprove', 'tmDoGrant', 'tmDoRevoke', 'tmDoSetRole']);
  ctl.wait = 10;
  ctl.els.tmGrantWho = { value: 'u2' }; ctl.els.tmGrantClient = { value: 'c1' };
  const a = A.tmDoApprove('u2'), b = A.tmDoApprove('u2');
  assert.equal(a, b);
  await a;
  assert.equal(ctl.writes().filter((c) => c.table === 'profiles').length, 1);
  A.tmDoGrant(); A.tmDoGrant();
  await tick(80);
  assert.equal(ctl.writes().filter((c) => c.table === 'prospect_grants' && c.op === 'insert').length, 1);
  /* approving two DIFFERENT people at once is two intents and both go */
  ctl.calls.length = 0;
  await Promise.all([A.tmDoApprove('u3'), A.tmDoApprove('u4')]);
  assert.equal(ctl.writes().filter((c) => c.table === 'profiles').length, 2);
});

/* ═════════════ Prospects: how old is this ═════════════ */

const PR = ['prSyncNote', 'prSync'];
test('Prospects: with the sending tool down three days, the screen says when it was last read', () => {
  const { A } = load('prospects.js', {}, PR);
  const now = Date.parse('2026-11-27T12:00:00Z');
  const old = '2026-11-24T11:00:00Z', fresh = '2026-11-27T11:55:00Z';
  assert.equal(A.prSyncNote([{ client_id: 'c1', status: 'ok', last_synced_at: fresh }], '', now), '', 'read five minutes ago: nothing to say');
  const one = A.prSyncNote([{ client_id: 'c1', status: 'ok', last_synced_at: old }], '', now);
  assert.match(one, /^The sending tool was last read 3 days ago\./);
  assert.match(one, /as it stood then, not as it stands now/);
  const some = A.prSyncNote([{ client_id: 'c1', status: 'ok', last_synced_at: old }, { client_id: 'c2', status: 'ok', last_synced_at: fresh }], '', now);
  assert.match(some, /^1 of the 2 sending accounts has stopped being read; the most recent read was 3 days ago\./);
  /* narrowed to the client whose account is fine, there is nothing to warn about */
  assert.equal(A.prSyncNote([{ client_id: 'c1', status: 'ok', last_synced_at: old }, { client_id: 'c2', status: 'ok', last_synced_at: fresh }], 'c2', now), '');
  /* the live shape: three accounts, none ever read */
  const never = A.prSyncNote([1, 2, 3].map((i) => ({ client_id: 'c' + i, status: 'ok', last_synced_at: null })), '', now);
  assert.match(never, /^All 3 sending accounts have never been read\./);
  /* a paused account is the owner's own choice, not an outage; no accounts, or a refused read, says nothing */
  assert.equal(A.prSyncNote([{ client_id: 'c1', status: 'paused', last_synced_at: old }], '', now), '');
  assert.equal(A.prSyncNote([], '', now), ''); assert.equal(A.prSyncNote(null, '', now), '');
  /* an account in error is named even if its last read was recent */
  assert.match(A.prSyncNote([{ client_id: 'c1', status: 'error', last_synced_at: fresh }], '', now), /^The sending tool was last read/);
});
