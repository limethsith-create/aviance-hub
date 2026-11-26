/* Tests for employees.js — the owner's Employees screen: his staff list, the
   access code he shows her once, and his chat with her.

   Run with: npm test. No browser and no network: employees.js runs in a vm
   with esc(), a tiny document whose one element remembers its innerHTML, and a
   fake Supabase client that records every call and answers what the test says.
   That lets the two things that would hurt most be checked for real:
     - every bit of her name, her email and her words is escaped;
     - the access code is on screen once and is gone from the page afterwards.
   The render functions are pure (data in, HTML string out), so most of this
   file is plain string checks. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── a fake world: one element, one Supabase, no timers ───────────── */

const els = {};                      // id -> a fake element that keeps its innerHTML
function el(id) {
  return els[id] || (els[id] = {
    id, innerHTML: '', value: '', scrollTop: 0, scrollHeight: 100, focused: 0,
    focus() { this.focused++; }, setAttribute() {}, getAttribute: () => null,
  });
}

let calls;                           // every rpc / table / storage call
let rpcs;                            // name -> answer
let tableAnswer;                     // (state) -> {data, error}
let fetchAnswer;                     // what the edge function says
let toasts, navs;

function builder(table) {
  const st = { table, op: 'select', payload: null, cols: '', filters: [], single: false };
  calls.push(st);
  const b = {
    select(c) { st.cols = c || ''; return b; },
    insert(p) { st.op = 'insert'; st.payload = p; return b },
    update(p) { st.op = 'update'; st.payload = p; return b },
    eq(c, v) { st.filters.push(['eq', c, v]); return b }, is(c, v) { st.filters.push(['is', c, v]); return b },
    order() { return b }, limit() { return b },
    single() { st.single = true; return b },
    then(res, rej) {
      const r = tableAnswer(st);
      const out = st.single ? { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error } : r;
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}

const storeCalls = [];
let storeAnswer;
const fakeSb = {
  from: builder,
  async rpc(name, args) {
    calls.push({ rpc: name, args });
    const h = rpcs[name];
    if (h instanceof Error) throw h;
    return h ? h(args) : { data: null, error: null };
  },
  auth: { async getSession() { return { data: { session: { access_token: 'owner-jwt' } }, error: null }; } },
  storage: {
    from(bucket) {
      return {
        async upload(p, file, opts) { storeCalls.push(['upload', bucket, p, file && file.name, opts]); if (storeAnswer instanceof Error) throw storeAnswer; return storeAnswer; },
        async createSignedUrl(p, secs) { storeCalls.push(['sign', bucket, p, secs]); if (storeAnswer instanceof Error) throw storeAnswer; return storeAnswer; },
      };
    },
  },
};

const sandbox = {
  console, Date, Number, Math, Promise, Array, String, Boolean, Object, JSON, RegExp, Error, isFinite, crypto,
  setTimeout, clearTimeout, setInterval, clearInterval,
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  toast: (m) => toasts.push(m),
  renderNav: () => { navs++; },
  emptyState: (icon, title, sub) => `<div class="card"><h3>${title}</h3><p>${sub}</p></div>`,
  I: { people: '<svg/>' },
  document: { hidden: false, activeElement: null, getElementById: el },
  navigator: {},
  authUser: { id: 'owner', uid: 'owner', role: 'admin', name: 'Limethsith' },
  sb: fakeSb,
  SUPA_URL: 'https://zjbxnkpktbghhudjbxhk.supabase.co',
  SUPA_KEY: 'sb_publishable_test',
  fetch: async (url, opts) => { calls.push({ fetch: url, opts }); if (fetchAnswer instanceof Error) throw fetchAnswer; return fetchAnswer; },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), sandbox, { filename: 'core.js' });
const SRC = fs.readFileSync(path.join(root, 'employees.js'), 'utf8');
vm.runInContext(SRC + `
;globalThis.api={emp,empRpc,empMissing,empPlain,empRow,empMsgRow,empFetchList,
  empNameProblem,empEmailProblem,empFileProblem,empExt,empAdd,empSetStatus,empMarkRead,
  empDocLink,empDocUrl,empMessages,empHerReadAt,empSendMessage,empFilePath,empUpload,empFileUrl,
  empCode,empUnreadTotal,empCount,empStart,empStop,empSetCount,employeesForget,
  empStatusLabel,empStatusTone,empTime,empAgo,empLastSeenText,empAttachName,empSeenText,
  empEmptyHTML,empAddFormHTML,empRowHTML,empListHTML,empCodeHTML,empAskHTML,empMsgHTML,
  empChatHTML,empComposerHTML,empPanelHTML,empScreenHTML,empCtx,viewEmployees,empBodyHTML,
  empForcePaint,empOpen,empCloseOpen,empForgetCode,empCodeHide,empCopyCode,empCodeGo,
  empIsOwner,EMP_NOT_READY,EMP_CODE_NOT_READY,EMP_FILES_NOT_READY,EMP_BUCKET,EMP_BODY_MAX,
  empMenuHTML,empHeadHTML,empPresence,empDotHTML,empDeleteMessage,empClearChannel,
  empMenuToggle,empDelGo,empClearGo,
  empLinkNew,empLinkHTML,empLinkGo,empLinkHide,empCopyLink,empCopyCode,empPaint,empLoadMessages,empOnRender,EMP_LINK_BASE};`,
  sandbox, { filename: 'employees.js' });
const A = sandbox.api;

/* values made inside the vm carry the vm's prototypes; compare through JSON */
const plain = (x) => JSON.parse(JSON.stringify(x));
const sameJson = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function reset(over) {
  calls = []; rpcs = {}; toasts = []; navs = 0; storeCalls.length = 0;
  tableAnswer = () => ({ data: [], error: null });
  storeAnswer = { data: { path: 'p' }, error: null };
  fetchAnswer = { ok: true, status: 200, json: async () => ({ ok: true, code: 'AVX-4K7M-Q2ZP' }) };
  for (const k of Object.keys(els)) delete els[k];
  A.employeesForget();
  sandbox.authUser = Object.assign({ id: 'owner', uid: 'owner', role: 'admin', name: 'Limethsith' }, over || {});
  sandbox.document.activeElement = null;
  sandbox.sb = fakeSb;
}
/* nothing is left ticking when the file is done */
after(() => { A.employeesForget(); });

/* her name and her words, written the way that breaks a page that does not escape */
const NASTY = 'Dilini "Dee" <b>O\'Brien</b>';
const ROWS = () => [
  { id: 's1', name: NASTY, email: 'dilini+staff@gmail.com', status: 'active', last_seen_at: new Date(Date.now() - 20 * 60000).toISOString(), channel_id: 'ch1', unread: 3, code_set: true, created_at: '2026-11-20T09:00:00Z' },
  { id: 's2', name: 'Anushka', email: 'anushka@gmail.com', status: 'invited', last_seen_at: null, channel_id: 'ch2', unread: 0, code_set: true, created_at: '2026-11-22T09:00:00Z' },
  { id: 's3', name: 'Bhanuka <script>', email: 'b@gmail.com', status: 'revoked', last_seen_at: null, channel_id: 'ch3', unread: 120, code_set: false, created_at: '2026-11-23T09:00:00Z' },
];
const MSGS = () => [
  { id: 'm1', author_user: 'owner', body: 'Morning — can you call Stone Roofing?', created_at: '2026-11-24T09:00:00Z', msg_kind: 'chat' },
  { id: 'm2', author_user: 's1u', body: 'done <b>&</b> they want 3pm', created_at: '2026-11-24T09:05:00Z', msg_kind: 'chat' },
  { id: 'm3', author_user: 'owner', body: 'perfect', created_at: '2026-11-24T09:10:00Z', msg_kind: 'chat' },
];
async function loaded() {
  reset();
  rpcs.staff_list = () => ({ data: ROWS(), error: null });
  await A.empFetchList();
  el('empRoot').innerHTML = A.viewEmployees();
  await tick();
  return A.emp;
}

/* ───────────── escaping ───────────── */

test('her name, her email and her words are escaped everywhere they appear', async () => {
  await loaded();
  const list = A.empListHTML(A.emp.list, A.empCtx());
  assert.match(list, /Dilini &quot;Dee&quot; &lt;b&gt;/, 'the list row is escaped');
  assert.doesNotMatch(list, /<b>O'Brien<\/b>/);
  assert.doesNotMatch(list, /<script>/);
  assert.match(list, /Bhanuka &lt;script&gt;/);
  // the aria-label is built from the same text, so it must be escaped too
  assert.doesNotMatch(list, /aria-label="[^"]*"[^>]*O'Brien/);

  const panel = A.empPanelHTML(A.emp.list[1], Object.assign(A.empCtx(), { msgsLoaded: true, msgs: A.emp.list }));
  assert.doesNotMatch(panel, /<script>/);

  // her message body, and a file name she chose
  const msgs = MSGS().map(A.empMsgRow);
  const chat = A.empChatHTML(msgs, { msgsLoaded: true, ownerId: 'owner', herReadAt: null });
  assert.match(chat, /done &lt;b&gt;&amp;&lt;\/b&gt; they want 3pm/);
  assert.doesNotMatch(chat, /<b>&<\/b>/);
  const withFile = A.empMsgHTML(A.empMsgRow({ id: 'm9', author_user: 's1u', body: '', attachment_url: 'ch1/a "b" <c>.pdf', created_at: '2026-11-24T09:20:00Z' }), { ownerId: 'owner' });
  assert.doesNotMatch(withFile, /<c>/);
  assert.match(withFile, /a &quot;b&quot; &lt;c&gt;\.pdf/);
});

/* ───────────── empty states ───────────── */

test('the empty states say what to do next, not "no data"', async () => {
  reset();
  const none = A.empEmptyHTML([]);
  assert.match(none, /No one works here yet/);
  assert.match(none, /Add an employee/);
  assert.match(none, /nothing else in Aviance/, 'it says what she will and will not see');
  const some = A.empEmptyHTML([{ id: 's1' }]);
  assert.match(some, /Pick someone/);
  assert.match(A.empListHTML([], {}), /Nobody is set up yet/);
  assert.match(A.empListHTML(null, {}), /Nobody is set up yet/);
  // a channel with no messages in it yet
  const chat = A.empChatHTML([], { msgsLoaded: true, ownerId: 'owner' });
  assert.match(chat, /No messages yet/);
  assert.match(chat, /she sees this the moment she signs in/);
  // and before they arrive
  assert.match(A.empChatHTML([], { msgsLoaded: false }), /Loading the messages/);
  // the whole screen with nobody on it still offers the one useful button
  const screen = A.empScreenHTML([], A.empCtx());
  assert.match(screen, /Nobody is set up yet/);
  assert.match(screen, /onclick="empAddOpen\(\)"/);
});

/* ───────────── error states ───────────── */

test('a failed list reads as one plain sentence with a way to retry', async () => {
  reset();
  rpcs.staff_list = () => ({ data: null, error: { code: '42501', message: 'permission denied for table profiles' } });
  el('empRoot').innerHTML = A.viewEmployees();
  await tick();
  const h = el('empRoot').innerHTML;
  assert.match(h, /The staff list didn.t load/);
  assert.match(h, /You don.t have access to do that\./);
  assert.doesNotMatch(h, /42501|permission denied for table|profiles/, 'no database words on screen');
  assert.match(h, /onclick="empLoad\(true\)"/, 'he can try again');

  // the network being out is told as the network
  reset();
  rpcs.staff_list = () => { throw new TypeError('Failed to fetch'); };
  el('empRoot').innerHTML = A.viewEmployees();
  await tick();
  assert.match(el('empRoot').innerHTML, /Can.t reach Aviance/);
});

test('with the migration not applied yet the screen says so, and stops asking', async () => {
  for (const err of [
    { code: 'PGRST202', message: 'Could not find the function public.staff_list() in the schema cache' },
    { code: '42883', message: 'function public.staff_list() does not exist' },
    { code: '42P01', message: 'relation "public.channel_messages" does not exist' },
  ]) {
    reset();
    rpcs.staff_list = () => ({ data: null, error: err });
    el('empRoot').innerHTML = A.viewEmployees();
    await tick();
    const h = el('empRoot').innerHTML;
    assert.equal(A.emp.missing, true, err.code + ' is read as "not applied yet"');
    assert.match(h, /Not switched on yet/);
    assert.match(h, /Once the database update is applied/);
    assert.doesNotMatch(h, new RegExp(err.code), 'no error code on screen');
    assert.doesNotMatch(h, /onclick="empLoad\(true\)"/, 'no pointless Try again: there is nothing to retry');
    // and the background poll gives up rather than hammering a function that is not there
    assert.equal(A.emp.timer, null, 'nothing left ticking');
    A.empStart();
    assert.equal(A.emp.timer, null, 'it will not start again while it is missing');
  }
});

test('the code button, the uploads and the welcome page each degrade on their own', async () => {
  // the edge function is not deployed: a plain sentence, not a 404
  reset();
  fetchAnswer = { ok: false, status: 404, json: async () => ({}) };
  const miss = await A.empCode('s1');
  assert.equal(miss.ok, false);
  assert.equal(miss.error, A.EMP_CODE_NOT_READY);
  assert.equal(miss.missing, true);
  // a stale sign-in and a non-owner are told apart
  reset(); fetchAnswer = { ok: false, status: 401, json: async () => ({}) };
  assert.match((await A.empCode('s1')).error, /sign-in has run out/);
  reset(); fetchAnswer = { ok: false, status: 403, json: async () => ({}) };
  assert.match((await A.empCode('s1')).error, /don.t have access/);
  reset(); fetchAnswer = new TypeError('Failed to fetch');
  assert.match((await A.empCode('s1')).error, /Can.t reach Aviance/);

  // no bucket yet: he is told to send text for now, and nothing throws
  reset();
  sandbox.sb = { from: builder, rpc: fakeSb.rpc, auth: fakeSb.auth };   // a client with no storage
  const up = await A.empUpload('ch1', { name: 'a.png', size: 10 });
  assert.equal(up.ok, false);
  assert.equal(up.error, A.EMP_FILES_NOT_READY);
  reset();
  storeAnswer = { data: null, error: { message: 'Bucket not found' } };
  assert.equal((await A.empUpload('ch1', { name: 'a.png', size: 10 })).error, A.EMP_FILES_NOT_READY);

  // staff_doc_token missing: the Welcome page button says it is not ready
  reset();
  rpcs.staff_doc_token = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
  const doc = await A.empDocLink('s1');
  assert.equal(doc.ok, false);
  assert.equal(doc.error, A.EMP_NOT_READY);
  // a token that comes back as junk is refused rather than opened
  reset();
  rpcs.staff_doc_token = () => ({ data: 'not a token!', error: null });
  assert.equal((await A.empDocLink('s1')).ok, false);
  assert.equal(A.empDocUrl('s.6f1e.ab12cd34ef'), 'doc.html#s.6f1e.ab12cd34ef');
  assert.equal(A.empDocUrl('javascript:alert(1)'), '');
  assert.equal(A.empDocUrl(''), '');
});

/* ───────────── the access code: shown once, then gone ───────────── */

test('the code is shown once, with the warning and a copy button', async () => {
  await loaded();
  const h = A.empCodeHTML('AVX-4K7M-Q2ZP', { name: NASTY });
  assert.match(h, /AVX-4K7M-Q2ZP/);
  assert.match(h, /<b>This code is shown once and will not be shown again\.<\/b>/, 'the warning is not optional');
  assert.match(h, /onclick="empCopyCode\(\)"/);
  assert.match(h, /onclick="empCodeHide\(\)"/);
  assert.match(h, /aviance\.store\/team/, 'he is told where she signs in');
  assert.match(h, /role="alert"/, 'a screen reader hears it');
  assert.ok(h.includes(sandbox.esc(NASTY)), 'her name is escaped into the heading');
  assert.equal(A.empCodeHTML('', { name: 'x' }), '', 'no code, no panel');
  assert.equal(A.empCodeHTML(null, null), '');
});

test('the code is not left anywhere in the page once the panel closes', async () => {
  await loaded();
  A.empOpen('s1');
  await tick();
  const CODE = 'AVX-4K7M-Q2ZP';
  fetchAnswer = { ok: true, status: 200, json: async () => ({ ok: true, code: CODE }) };
  await A.empCodeGo('s1');
  await tick();

  // it is on screen, once
  let html = el('empRoot').innerHTML;
  assert.ok(html.includes(CODE), 'he can read it');
  assert.equal(html.split(CODE).length - 1, 1, 'it appears exactly once');
  assert.equal(A.emp.code.code, CODE);
  assert.equal(A.emp.code.staffId, 's1');
  // the call carried only her id, with his own token — never the code
  const sent = calls.find((c) => c.fetch);
  assert.match(sent.fetch, /\/functions\/v1\/staff-code$/);
  assert.equal(sent.opts.body, JSON.stringify({ staff_id: 's1' }));
  assert.match(sent.opts.headers.Authorization, /^Bearer /);

  // "Done — I've copied it" wipes it from the page and from memory
  A.empCodeHide();
  html = el('empRoot').innerHTML;
  assert.equal(A.emp.code, null, 'nothing is kept');
  assert.ok(!html.includes(CODE), 'the code is gone from the page');
  assert.ok(!html.includes('empCodeVal'), 'and so is the box it was in');
  assert.equal(A.emp.codeErr, null);

  // opening somebody else, closing the panel, and signing out each drop it too
  for (const close of [() => A.empOpen('s2'), () => A.empCloseOpen(), () => A.employeesForget()]) {
    await loaded(); A.empOpen('s1'); await tick();
    fetchAnswer = { ok: true, status: 200, json: async () => ({ ok: true, code: CODE }) };
    await A.empCodeGo('s1'); await tick();
    assert.ok(el('empRoot').innerHTML.includes(CODE));
    close(); A.empForcePaint();
    assert.equal(A.emp.code, null);
    assert.ok(!el('empRoot').innerHTML.includes(CODE), 'the code never survives the panel');
  }
  // and a repaint after it is dropped cannot bring it back
  A.empForcePaint();
  assert.ok(!el('empRoot').innerHTML.includes(CODE));
  // copying with nothing to copy does nothing at all
  A.empCopyCode();
  sameJson(toasts, toasts.filter((t) => !/copied/i.test(t)), 'no "copied" toast without a code');
});

test('generating a code: he is asked first when there already is one, and a failure says why', async () => {
  await loaded();
  // she already has a code: the button asks before it re-keys
  const her = A.emp.list.find((s) => s.id === 's1');
  // the actions live in the "..." menu now, out of the way of the chat
  const menu = A.empMenuHTML(her, Object.assign(A.empCtx(), { menuOpen: 's1' }));
  assert.match(menu, /Reset code/);
  assert.match(menu, /empAskYes\('reset'/);
  assert.doesNotMatch(A.empPanelHTML(her, A.empCtx()), /Reset code<\/button>/, 'not loose on the screen');
  const ask = A.empAskHTML('reset', { id: 's1', name: NASTY });
  assert.match(ask, /Her old code stops working straight away/);
  assert.ok(ask.includes(sandbox.esc(NASTY)));
  // she has none yet: it goes straight through
  const fresh = A.empMenuHTML(A.emp.list.find((s) => s.id === 's3'), Object.assign(A.empCtx(), { menuOpen: 's3' }));
  assert.match(fresh, /Generate access code/);
  assert.match(fresh, /empCodeGo\(/);

  // a failure shows the reason and leaves no half-written code about
  await loaded(); A.empOpen('s1'); await tick();
  fetchAnswer = { ok: false, status: 500, json: async () => ({ ok: false, error: 'Her email is already used by another login.' }) };
  await A.empCodeGo('s1');
  assert.equal(A.emp.code, null);
  assert.match(A.emp.codeErr, /already used by another login/);
  assert.match(el('empRoot').innerHTML, /already used by another login/);
  assert.ok(toasts.some((t) => /already used/.test(t)));
});

/* ───────────── unread counts ───────────── */

test('unread: the badge adds up, caps at 99+, and only the owner has one', async () => {
  reset();
  assert.equal(A.empUnreadTotal([{ unread: 3 }, { unread: 0 }, { unread: 120 }]), 123);
  assert.equal(A.empUnreadTotal([{ unread: -5 }, { unread: 'x' }, null, {}]), 0, 'junk counts as nothing');
  assert.equal(A.empUnreadTotal(null), 0);

  await loaded();
  assert.equal(A.emp.count, 123, 'the sidebar count is every unread message from every one of them');
  assert.equal(A.empCount(), '99+', 'the badge never grows past 99+');
  // a row shows her own unread, and the count is in the label a screen reader reads
  const row = A.empRowHTML(A.emp.list.find((s) => s.id === 's1'), { openId: 's1' });
  assert.match(row, /<span class="badge red" aria-hidden="true">3<\/span>/);
  assert.match(row, /aria-label="[^"]*3 unread/);
  assert.match(row, /aria-current="true"/);
  const quiet = A.empRowHTML(A.emp.list.find((s) => s.id === 's2'), {});
  assert.doesNotMatch(quiet, /badge red/, 'nothing unread, no badge');
  assert.doesNotMatch(quiet, /aria-label="[^"]*unread/);
  const many = A.empRowHTML(A.emp.list.find((s) => s.id === 's3'), {});
  assert.match(many, />99\+</);

  // the nav asks again only when the number really changed
  const before = navs;
  A.empSetCount(123);
  assert.equal(navs, before, 'the same number does not redraw the sidebar');
  A.empSetCount(4);
  assert.equal(navs, before + 1);

  // somebody who is not the owner gets no badge and no polling
  reset({ role: 'employee' });
  assert.equal(A.empCount(), 0);
  assert.equal(A.emp.timer, null, 'and nothing is left ticking for them');
  assert.equal(A.empIsOwner(), false);
});

/* ───────────── "Seen" ───────────── */

test('"Seen 14:32" only when she has really read his last message', async () => {
  reset();
  const msgs = MSGS().map(A.empMsgRow);
  const ctx = (readAt) => ({ ownerId: 'owner', herReadAt: readAt, msgsLoaded: true });
  // she has not read it
  assert.equal(A.empSeenText(msgs, ctx(null)), 'Sent');
  assert.equal(A.empSeenText(msgs, ctx('2026-11-24T09:06:00Z')), 'Sent', 'read before his last one: still Sent');
  // she has
  const seen = A.empSeenText(msgs, ctx('2026-11-24T09:12:00Z'));
  assert.match(seen, /^Seen \d\d:\d\d$/);
  assert.equal(seen, 'Seen ' + A.empTime('2026-11-24T09:12:00Z'), 'her own clock, his time zone');
  // the last word is hers: no line at all
  const hersLast = msgs.slice(0, 2);
  assert.equal(A.empSeenText(hersLast, ctx('2026-11-24T09:12:00Z')), 'Seen ' + A.empTime('2026-11-24T09:12:00Z'));
  assert.equal(A.empSeenText([msgs[1]], ctx(null)), '', 'nothing of his, nothing to be seen');
  assert.equal(A.empSeenText([], ctx(null)), '');
  assert.equal(A.empSeenText(null, null), '');
  // it is drawn once, at the bottom of the thread
  const chat = A.empChatHTML(msgs, ctx('2026-11-24T09:12:00Z'));
  assert.equal((chat.match(/class="emp-seen"/g) || []).length, 1);
  assert.ok(chat.indexOf('perfect') < chat.indexOf('emp-seen'));
  assert.doesNotMatch(A.empChatHTML(msgs, ctx(null)).replace(/Sent/, ''), /emp-seen[^>]*>Seen/);

  // and "her last read" is read off her own channel_members row, never his
  reset();
  tableAnswer = (st) => st.table === 'channel_members'
    ? { data: [{ user_id: 'owner', last_read_at: '2026-11-24T23:00:00Z' }, { user_id: 's1u', last_read_at: '2026-11-24T09:12:00Z' }], error: null }
    : { data: [], error: null };
  const r = await A.empHerReadAt('ch1');
  assert.equal(r.ok, true);
  assert.equal(r.data, '2026-11-24T09:12:00Z', 'his own last_read_at is not mistaken for hers');
});

test('last seen reads in plain words, and "never" becomes "Not signed in yet"', () => {
  reset();
  assert.equal(A.empLastSeenText(null), 'Not signed in yet');
  assert.equal(A.empLastSeenText('nonsense'), 'Not signed in yet');
  assert.equal(A.empLastSeenText(new Date(Date.now() - 5 * 1000).toISOString()), 'Last seen just now');
  assert.equal(A.empLastSeenText(new Date(Date.now() - 20 * 60000).toISOString()), 'Last seen 20 min ago');
  assert.equal(A.empLastSeenText(new Date(Date.now() - 60 * 60000).toISOString()), 'Last seen 1 hour ago');
  assert.equal(A.empLastSeenText(new Date(Date.now() - 50 * 3600000).toISOString()), 'Last seen 2 days ago');
  sameJson(['active', 'invited', 'revoked', '', 'nonsense'].map(A.empStatusLabel),
    ['Active', 'Code sent', 'No access', 'Not set up', 'Not set up']);
  sameJson(['active', 'invited', 'revoked', ''].map(A.empStatusTone), ['ok', 'wait', 'off', 'wait']);
});

/* ───────────── a message with a file on it ───────────── */

test('a message with an attachment shows the file name alone, and opens through a signed link', async () => {
  reset();
  const m = A.empMsgRow({ id: 'm9', author_user: 'owner', body: 'the brief', attachment_url: 'ch1/0f3a-1b2c.pdf', created_at: '2026-11-24T09:20:00Z' });
  const h = A.empMsgHTML(m, { ownerId: 'owner' });
  assert.match(h, /class="emp-msg mine"/, 'his own message sits on his side');
  assert.match(h, /the brief/);
  assert.match(h, /onclick="empOpenFile\(&quot;ch1\/0f3a-1b2c\.pdf&quot;\)"/);
  assert.match(h, />0f3a-1b2c\.pdf</, 'the folder is not shown');
  assert.doesNotMatch(h, /<img/, 'the owner side lists the file, it does not inline a private object');
  // a file with no message beside it is not a blank bubble
  const bare = A.empMsgHTML(A.empMsgRow({ id: 'm10', author_user: 's1u', attachment_url: 'ch1/x.png', created_at: '2026-11-24T09:21:00Z' }), { ownerId: 'owner' });
  assert.doesNotMatch(bare, /\(empty message\)/);
  assert.match(bare, /x\.png/);
  const empty = A.empMsgHTML(A.empMsgRow({ id: 'm11', author_user: 's1u', created_at: '2026-11-24T09:22:00Z' }), { ownerId: 'owner' });
  assert.match(empty, /\(empty message\)/, 'a message with nothing in it still says what it is');
  // a system message is marked as one, so it cannot be mistaken for her writing
  assert.match(A.empMsgHTML(A.empMsgRow({ id: 'm12', body: 'she signed in', msg_kind: 'system', created_at: '2026-11-24T09:23:00Z' }), { ownerId: 'owner' }), /emp-msg sys/);

  // the name on screen comes from the path, never from a query string
  assert.equal(A.empAttachName('ch1/0f3a.pdf?token=secret'), '0f3a.pdf');
  assert.equal(A.empAttachName('https://x/storage/v1/object/sign/chat-files/ch1/a%20b.pdf?t=1'), 'a b.pdf');
  assert.equal(A.empAttachName(''), 'Attachment');

  // opening it asks for a short-lived link into the private bucket
  reset();
  storeAnswer = { data: { signedUrl: 'https://x.supabase.co/sign/a.pdf?token=t' }, error: null };
  const link = await A.empFileUrl('ch1/a.pdf');
  assert.equal(link.ok, true);
  sameJson(storeCalls[0], ['sign', 'chat-files', 'ch1/a.pdf', 120]);
  // a full link that is already signed is used as it is
  reset();
  assert.equal((await A.empFileUrl('https://x/already-signed')).data, 'https://x/already-signed');
  assert.equal(storeCalls.length, 0);
});

test('uploads go into her own channel folder, and only the kinds the bucket allows', async () => {
  reset();
  const p = A.empFilePath('ch1', 'Quote FINAL.PDF');
  assert.match(p, /^ch1\/[0-9a-zA-Z-]+\.pdf$/, 'the folder is the channel, the name is a fresh id');
  assert.ok(!p.includes('Quote'), 'nothing of her file name reaches the path');
  assert.ok(!A.empFilePath('ch1', '../../owner/secret.png').includes('..'));

  assert.equal(A.empFileProblem({ name: 'a.png', size: 10 }), '');
  assert.equal(A.empFileProblem({ name: 'a.CSV', size: 10 }), '');
  assert.match(A.empFileProblem({ name: 'a.exe', size: 10 }), /image, a PDF, a Word file or a CSV/);
  assert.match(A.empFileProblem({ name: 'a.png', size: 11 * 1024 * 1024 }), /bigger than 10 MB/);
  assert.equal(A.empFileProblem(null), '', 'no file chosen is not a mistake');

  reset();
  storeAnswer = { data: { path: 'ok' }, error: null };
  const up = await A.empUpload('ch1', { name: 'shot.png', size: 2000, type: 'image/png' });
  assert.equal(up.ok, true);
  assert.equal(storeCalls[0][1], 'chat-files');
  assert.match(storeCalls[0][2], /^ch1\//);
  assert.equal(storeCalls[0][4].upsert, false, 'a file already there is never overwritten');
  // a file the bucket would refuse never leaves the browser
  reset();
  assert.equal((await A.empUpload('ch1', { name: 'a.exe', size: 10 })).ok, false);
  assert.equal(storeCalls.length, 0);
});

/* ───────────── adding somebody, revoking, marking read ───────────── */

test('Add employee checks the name and the email before anything is written', async () => {
  reset();
  assert.match(A.empNameProblem(''), /Type her name/);
  assert.match(A.empNameProblem('J'), /too short/);
  assert.match(A.empNameProblem('x'.repeat(81)), /under 80/);
  assert.equal(A.empNameProblem('  Jane Perera '), '');
  assert.match(A.empEmailProblem(''), /Type her email/);
  assert.match(A.empEmailProblem('jane@gmail'), /doesn.t look like/);
  assert.equal(A.empEmailProblem('jane.perera+staff@gmail.com'), '');

  // nothing reaches the database until both are right
  reset();
  rpcs.staff_add = (args) => ({ data: { staff_id: 'new1', channel_id: 'chN' }, error: null });
  const bad = await A.empAdd('J', 'jane@gmail.com');
  assert.equal(bad.ok, false);
  assert.equal(calls.filter((c) => c.rpc).length, 0, 'no call was made');
  const good = await A.empAdd('  Jane Perera  ', '  Jane.Perera@GMAIL.com ');
  assert.equal(good.ok, true);
  sameJson(calls.find((c) => c.rpc === 'staff_add').args, { p_name: 'Jane Perera', p_email: 'jane.perera@gmail.com' },
    'trimmed, and the email lowercased so her login matches');
  // the form shows what he typed and what is wrong, escaped
  const form = A.empAddFormHTML({ addName: 'Jane "J" <b>', addEmail: 'j@gmail.com', addErr: 'That name looks too short.' });
  assert.match(form, /value="Jane &quot;J&quot; &lt;b&gt;"/);
  assert.match(form, /role="alert">That name looks too short\./);
  assert.match(form, /She still needs an access code/, 'he is told what happens next');
});

test('revoking, re-activating and marking read each ask the database the right thing', async () => {
  reset();
  rpcs.staff_set_status = () => ({ data: { ok: true }, error: null });
  rpcs.staff_mark_read = () => ({ data: { ok: true }, error: null });
  assert.equal((await A.empSetStatus('s1', 'revoked')).ok, true);
  sameJson(calls.find((c) => c.rpc === 'staff_set_status').args, { p_staff: 's1', p_status: 'revoked' });
  assert.equal((await A.empSetStatus('s1', 'active')).ok, true);
  const nonsense = await A.empSetStatus('s1', 'admin');
  assert.equal(nonsense.ok, false);
  assert.match(nonsense.error, /not a status/);
  assert.equal((await A.empSetStatus('', 'active')).ok, false);
  await A.empMarkRead('ch1');
  sameJson(calls.find((c) => c.rpc === 'staff_mark_read').args, { p_channel: 'ch1' });
  assert.equal((await A.empMarkRead('')).ok, false);
  // the revoke question makes clear nothing is deleted
  const ask = A.empAskHTML('revoke', { id: 's1', name: 'Dilini' });
  assert.match(ask, /won.t be able to sign in/);
  assert.match(ask, /Nothing is deleted/);
  // and a revoked person can be let back in
  reset();
  rpcs.staff_list = () => ({ data: ROWS(), error: null });
  await A.empFetchList();
  const revoked = A.empRow(ROWS()[2]);
  const menu = A.empMenuHTML(revoked, Object.assign(A.empCtx(), { menuOpen: 's3' }));
  assert.match(menu, /Let her back in/);
  assert.match(menu, /empRevokeGo\(&quot;s3&quot;,'active'\)/);
});

/* ───────────── the owner's side of the chat ───────────── */

test('his messages are read and written through channel_messages, as himself only', async () => {
  reset();
  tableAnswer = (st) => st.table === 'channel_messages'
    ? { data: MSGS(), error: null } : { data: [], error: null };
  const r = await A.empMessages('ch1');
  assert.equal(r.ok, true);
  sameJson(r.data.map((m) => m.id), ['m1', 'm2', 'm3']);
  const q = calls.find((c) => c.table === 'channel_messages');
  sameJson(q.filters, [['eq', 'channel_id', 'ch1'], ['is', 'deleted_at', null]], 'only her channel, nothing deleted');
  assert.match(q.cols, /msg_kind/);
  assert.equal((await A.empMessages('')).ok, false);

  // sending: his own id as the author, kind 'chat', trimmed and capped
  reset();
  tableAnswer = (st) => ({ data: st.op === 'insert' ? [Object.assign({ id: 'new' }, st.payload)] : [], error: null });
  const sent = await A.empSendMessage('ch1', '  on it  ', null);
  assert.equal(sent.ok, true);
  const ins = calls.find((c) => c.op === 'insert');
  sameJson(ins.payload, { channel_id: 'ch1', author_user: 'owner', body: 'on it', msg_kind: 'chat' });
  reset();
  tableAnswer = (st) => ({ data: st.op === 'insert' ? [Object.assign({ id: 'new' }, st.payload)] : [], error: null });
  await A.empSendMessage('ch1', 'x'.repeat(5000), 'ch1/a.png');
  const big = calls.find((c) => c.op === 'insert');
  assert.equal(big.payload.body.length, A.EMP_BODY_MAX);
  assert.equal(big.payload.attachment_url, 'ch1/a.png');
  // an empty message is refused here, before the database has to
  reset();
  assert.match((await A.empSendMessage('ch1', '   ', null)).error, /Write a message first/);
  assert.equal(calls.filter((c) => c.op === 'insert').length, 0);
  // and with no sign-in there is nobody to write as
  reset({ uid: null });
  assert.match((await A.empSendMessage('ch1', 'hello', null)).error, /sign-in has run out/);
});

test('the composer and the panel carry the one thing he must not lose: what he typed', async () => {
  await loaded();
  const c = A.empComposerHTML({ draft: 'half a sentence <b>', sending: false });
  assert.match(c, /half a sentence &lt;b&gt;<\/textarea>/);
  assert.match(c, /maxlength="4000"/);
  assert.match(c, /Ctrl\+Enter sends/);
  const busy = A.empComposerHTML({ draft: 'x', sending: true });
  assert.match(busy, /Sending…/);
  assert.match(busy, /<textarea[^>]*disabled/, 'he cannot send the same message twice');
  assert.match(A.empComposerHTML({ fileName: 'quote.pdf' }), /Attaching <b>quote\.pdf<\/b>/);
  assert.match(A.empComposerHTML({ fileErr: 'That file is bigger than 10 MB.' }), /role="alert">That file is bigger/);
  // a repaint while he is typing is skipped, so the caret never jumps
  sandbox.document.activeElement = el('empDraft');
  const before = el('empRoot').innerHTML;
  sandbox.empPaint ? sandbox.empPaint() : vm.runInContext('empPaint()', sandbox);
  assert.equal(el('empRoot').innerHTML, before, 'nothing was redrawn under his hands');
});

/* ───────────── the screen as a whole ───────────── */

test('the screen is the list, the open person and nothing from anyone else', async () => {
  await loaded();
  A.empOpen('s1');
  await tick();
  const h = el('empRoot').innerHTML;
  assert.match(h, /class="emp-row on"/, 'the open row is marked');
  assert.ok(h.includes(sandbox.esc(NASTY)));
  assert.doesNotMatch(h, /\d+ people/, 'the strip is names only, no counts');
  // the actions are one menu press away, not spread over the screen
  const menu = A.empMenuHTML(A.emp.list.find((x) => x.id === 's1'), Object.assign(A.empCtx(), { menuOpen: 's1' }));
  for (const w of ['Reset code', 'Revoke access', 'Welcome page', 'Clear this chat', 'Add an employee']) assert.match(menu, new RegExp(w));
  // the chat he is looking at is hers, and the poll was started for her channel alone
  assert.equal(A.emp.open, 's1');
  const reads = calls.filter((c) => c.table === 'channel_messages');
  assert.ok(reads.length >= 1);
  for (const q of reads) sameJson(q.filters[0], ['eq', 'channel_id', 'ch1'], 'only the open channel is ever read');
  // signing out leaves nothing behind: no list, no messages, no timer
  A.employeesForget();
  sameJson(A.emp.list, []);
  sameJson(A.emp.msgs, []);
  assert.equal(A.emp.open, null);
  assert.equal(A.emp.code, null);
  assert.equal(A.emp.count, 0);
  assert.equal(A.emp.timer, null);
  assert.equal(A.emp.chatTimer, null, 'no poll is left running after a sign-out');
});

/* ---- deleting, clearing, and the presence dot (the redesigned screen) ---- */

test('deleting one message is a soft delete, in her channel only', async () => {
  await loaded(); A.empOpen('s1'); await tick();
  calls.length = 0;
  const r = await A.empDeleteMessage('ch-1', 'm-2');
  assert.equal(r.ok, true);
  const up = calls.find((c) => c.table === 'channel_messages' && c.op === 'update');
  assert.ok(up, 'it updates rather than deleting the row');
  assert.ok(up.payload.deleted_at, 'the row is marked deleted, so her page drops it');
  assert.equal(up.payload.body, '', 'and the words are gone');
  const where = JSON.stringify(up.filters);
  assert.match(where, /ch-1/, 'always pinned to the open channel');
  assert.match(where, /m-2/, 'and to that one message');
});

test('clearing the chat touches every message in that channel and no other', async () => {
  await loaded(); A.empOpen('s1'); await tick();
  calls.length = 0;
  const r = await A.empClearChannel('ch-1');
  assert.equal(r.ok, true);
  const up = calls.find((c) => c.table === 'channel_messages' && c.op === 'update');
  assert.ok(up.payload.deleted_at);
  const where = JSON.stringify(up.filters);
  assert.match(where, /ch-1/);
  assert.match(where, /deleted_at/, 'the ones already gone are left alone');
  assert.doesNotMatch(where, /"id"/, 'no single message is singled out');
});

test('both deletes ask first, and say so in plain words', () => {
  const one = A.empAskHTML('del', { id: 'm-2' });
  const all = A.empAskHTML('clear', { id: 's1', name: 'Vera' });
  for (const h of [one, all]) {
    assert.match(h, /Yes/); assert.match(h, /No/);
    assert.doesNotMatch(h, /confirm\(/);
  }
  assert.match(all + one, /chat|message/i);
});

test('the presence dot: green now, amber lately, grey a while ago, hollow never', () => {
  const now = Date.now();
  assert.equal(A.empPresence(new Date(now - 30 * 1000).toISOString()).tone, 'on');
  assert.equal(A.empPresence(new Date(now - 20 * 60 * 1000).toISOString()).tone, 'recent');
  assert.equal(A.empPresence(new Date(now - 5 * 60 * 60 * 1000).toISOString()).tone, 'off');
  assert.equal(A.empPresence(null).tone, 'never');
  assert.match(A.empPresence(new Date(now - 30 * 1000).toISOString()).text, /Online now/);
  assert.match(A.empPresence(null).text, /Not signed in yet/);
  // the dot is readable by a screen reader, not colour alone
  const dot = A.empDotHTML(null);
  assert.match(dot, /aria-label="[^"]*Not signed in yet/);
  assert.match(A.empDotHTML(new Date(now - 30 * 1000).toISOString()), /emp-dot on/);
});

test('a row in the strip is her name, her dot and her unread count — nothing else', () => {
  const row = A.empRowHTML({ id: 's1', name: 'Vera Emmanuel Gabriel', email: 'v@example.com',
    status: 'active', unread: 3, lastSeenAt: new Date().toISOString() }, { openId: 's1' });
  assert.match(row, /Vera Emmanuel Gabriel/);
  assert.match(row, /emp-dot on/);
  assert.match(row, /3/);
  assert.doesNotMatch(row, /v@example\.com/, 'the email belongs in the chat header, not the strip');
  assert.doesNotMatch(row, /Reset code|Revoke|Welcome page/, 'no actions loose in the strip');
});

/* ───────────── perfection pass: the one-click invite link ───────────── */

test('Invite link: asks staff_link_new for 14 days and builds the aviance.store address', async () => {
  reset();
  rpcs.staff_link_new = () => ({ data: { ok: true, token: 'abc/123+x', kind: 'employee', expires_at: '2026-12-10T00:00:00Z' }, error: null });
  const r = await A.empLinkNew('s1');
  assert.equal(r.ok, true);
  sameJson(calls.find((c) => c.rpc === 'staff_link_new').args, { p_staff: 's1', p_days: 14 });
  assert.equal(A.EMP_LINK_BASE, 'https://aviance.store/go?k=');
  assert.equal(r.data.url, 'https://aviance.store/go?k=abc%2F123%2Bx', 'the token is encoded into the address');
  assert.equal(r.data.expires, '2026-12-10T00:00:00Z');
  // nobody picked, no token back, a thrown error and a refusal: each one plain sentence, never a throw
  assert.equal((await A.empLinkNew('')).ok, false);
  rpcs.staff_link_new = () => ({ data: { ok: true }, error: null });
  assert.match((await A.empLinkNew('s1')).error, /could not make a link/);
  rpcs.staff_link_new = new Error('Failed to fetch');
  assert.match((await A.empLinkNew('s1')).error, /Can't reach Aviance/);
  rpcs.staff_link_new = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.staff_link_new' } });
  const missing = await A.empLinkNew('s1');
  assert.equal(missing.ok, false); assert.equal(missing.missing, true);
  assert.doesNotMatch(missing.error, /function|PGRST|public\./);
});

test('the menu offers "Invite link", and not for someone whose access is taken away', async () => {
  await loaded();
  const s1 = A.emp.list.find((x) => x.id === 's1'), s3 = A.emp.list.find((x) => x.id === 's3');
  const menu = A.empMenuHTML(s1, {});
  assert.match(menu, /onclick="empLinkGo\(&quot;s1&quot;\)"[^>]*>Invite link</);
  assert.doesNotMatch(menu.match(/empLinkGo[^>]*>/)[0], /disabled/);
  assert.match(A.empMenuHTML(s3, {}).match(/empLinkGo[^>]*>/)[0], /disabled/, 'revoked: restore her first');
  assert.match(A.empMenuHTML(s1, { busy: { s1: 'link' } }), /Making a link…/);
});

test('the link is shown once with a copy button, and is gone from the page afterwards', async () => {
  await loaded();
  A.empOpen('s1'); await tick();
  rpcs.staff_link_new = () => ({ data: { ok: true, token: 'tok-abc' }, error: null });
  A.empMenuToggle('s1');
  await A.empLinkGo('s1'); await tick();
  const URL_ = 'https://aviance.store/go?k=tok-abc';
  let html = el('empRoot').innerHTML;
  assert.equal(html.split(URL_).length - 1, 1, 'on screen exactly once');
  assert.match(html, /id="empLinkVal"/);
  assert.match(html, /onclick="empCopyLink\(\)"/);
  assert.match(html, /<b>This link is shown once and will not be shown again\.<\/b>/);
  assert.match(html, /14 days/);
  assert.match(html, /nobody else/);
  assert.equal(A.emp.menu, '', 'the menu closes behind it');
  assert.ok(html.includes(sandbox.esc(NASTY) + '’s one-click link'), 'her name is escaped in the heading');

  // copy: the link goes to the clipboard, and the link itself is never put in a toast
  let copied = '';
  sandbox.navigator = { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } };
  A.empCopyLink(); await tick();
  assert.equal(copied, URL_);
  assert.ok(toasts.some((t) => /Link copied/.test(t)));
  assert.ok(!toasts.some((t) => String(t).includes('tok-abc')));
  sandbox.navigator = {};

  // "Done" wipes it
  A.empLinkHide();
  assert.equal(A.emp.link, null);
  assert.ok(!el('empRoot').innerHTML.includes('tok-abc'));

  // opening somebody else, leaving the screen and signing out each drop it too
  for (const close of [() => A.empOpen('s2'), () => A.empOnRender('home'), () => A.employeesForget()]) {
    await loaded(); A.empOpen('s1'); await tick();
    rpcs.staff_link_new = () => ({ data: { ok: true, token: 'tok-abc' }, error: null });
    await A.empLinkGo('s1'); await tick();
    assert.ok(el('empRoot').innerHTML.includes('tok-abc'));
    close(); A.empForcePaint();
    assert.equal(A.emp.link, null);
    assert.ok(!el('empRoot').innerHTML.includes('tok-abc'), 'the link never survives the panel');
  }
  A.empCopyLink();   // nothing to copy: nothing happens
});

test('a link that finishes after he has opened someone else is never shown under the wrong name', async () => {
  await loaded();
  A.empOpen('s1'); await tick();
  let land;
  rpcs.staff_link_new = () => new Promise((r) => { land = () => r({ data: { ok: true, token: 'for-s1' }, error: null }); });
  const p = A.empLinkGo('s1');
  await tick();
  assert.match(A.empMenuHTML(A.emp.list.find((x) => x.id === 's1'), A.empCtx()), /Making a link…/);
  A.empLinkGo('s1');                                  // a second click while it is being made does nothing
  A.empOpen('s2'); await tick();
  land(); await p;
  assert.equal(A.emp.link, null);
  assert.ok(!el('empRoot').innerHTML.includes('for-s1'));
  assert.equal(calls.filter((c) => c.rpc === 'staff_link_new').length, 1);
});

test('a refused link says why, in the panel and out loud', async () => {
  await loaded();
  A.empOpen('s1'); await tick();
  rpcs.staff_link_new = () => ({ data: null, error: { code: 'P0001', message: 'That person is revoked. Restore them first.' } });
  await A.empLinkGo('s1');
  assert.equal(A.emp.link, null);
  assert.match(el('empRoot').innerHTML, /role="alert">That person is revoked\. Restore them first\./);
  assert.ok(toasts.some((t) => /revoked/.test(t)));
});

test('when the clipboard says no, the code or the link is selected instead of the copy silently failing', async () => {
  await loaded();
  A.empOpen('s1'); await tick();
  await A.empCodeGo('s1'); await tick();
  const picked = [];
  sandbox.document.createRange = () => ({ selectNodeContents(n) { picked.push(n.id); } });
  sandbox.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  sandbox.navigator = { clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } };
  A.empCopyCode(); await tick();
  assert.deepEqual(picked, ['empCodeVal'], 'the code box is selected, whatever the clipboard error was');
  assert.ok(toasts.some((t) => /The code is selected/.test(t)));
  delete sandbox.document.createRange; delete sandbox.getSelection; sandbox.navigator = {};
});

/* ───────────── perfection pass: the chat while he is using it ───────────── */

test('her new message appears while he is typing a reply, and his words are left alone', async () => {
  await loaded();
  tableAnswer = (st) => (st.table === 'channel_messages' ? { data: MSGS(), error: null } : { data: [], error: null });
  A.empOpen('s1'); await tick();
  sandbox.document.activeElement = el('empDraft');
  const before = el('empRoot').innerHTML;
  tableAnswer = (st) => (st.table === 'channel_messages'
    ? { data: MSGS().concat([{ id: 'm4', author_user: 's1u', body: 'one more thing from her', created_at: '2026-11-24T09:20:00Z', msg_kind: 'chat' }]), error: null }
    : { data: [], error: null });
  await A.empLoadMessages(true); await tick();
  assert.match(el('empLive').innerHTML, /one more thing from her/, 'the thread is redrawn');
  assert.equal(el('empRoot').innerHTML, before, 'the send box and everything around it is not touched');
});

test('a refresh that changed nothing paints nothing, and one that did leaves him where he was reading', async () => {
  await loaded();
  tableAnswer = (st) => (st.table === 'channel_messages' ? { data: MSGS(), error: null } : { data: [], error: null });
  A.empOpen('s1'); await tick();
  const root = el('empRoot');
  let writes = 0, html = root.innerHTML;
  Object.defineProperty(root, 'innerHTML', { get: () => html, set: (v) => { writes++; html = v; }, configurable: true });
  await A.empLoadMessages(true); await tick();
  assert.equal(writes, 0, 'the 10-second tick does not redraw an unchanged chat');
  // he has scrolled up to read; a new message must not drag him to the bottom
  const thread = el('empThread'); thread.scrollHeight = 2000; thread.clientHeight = 400; thread.scrollTop = 300;
  tableAnswer = (st) => (st.table === 'channel_messages'
    ? { data: MSGS().concat([{ id: 'm5', author_user: 's1u', body: 'newer', created_at: '2026-11-24T09:30:00Z', msg_kind: 'chat' }]), error: null }
    : { data: [], error: null });
  await A.empLoadMessages(true); await tick();
  assert.equal(writes, 1);
  assert.equal(thread.scrollTop, 300, 'still where he was reading');
  // at the bottom, he follows the conversation down
  thread.scrollTop = 1600;
  tableAnswer = (st) => (st.table === 'channel_messages'
    ? { data: MSGS().concat([{ id: 'm6', author_user: 's1u', body: 'newest', created_at: '2026-11-24T09:40:00Z', msg_kind: 'chat' }]), error: null }
    : { data: [], error: null });
  await A.empLoadMessages(true); await tick();
  assert.equal(thread.scrollTop, 2000);
});

test('the messages and her "Seen" time are asked for together, and the paint does not wait for mark-read', async () => {
  await loaded();
  let open = 0, most = 0;
  tableAnswer = (st) => new Promise((r) => { open++; most = Math.max(most, open); setTimeout(() => { open--; r(st.table === 'channel_messages' ? { data: MSGS(), error: null } : { data: [], error: null }); }, 10); });
  let markDone = false;
  rpcs.staff_mark_read = () => new Promise((r) => setTimeout(() => { markDone = true; r({ data: null, error: null }); }, 60));
  A.empOpen('s1');                                   // s1 has 3 unread
  await tick(35);
  assert.equal(most, 2, 'two lookups in flight at once');
  assert.match(el('empRoot').innerHTML, /perfect/, 'the messages are on screen');
  assert.equal(markDone, false, 'before mark-read has answered');
  await tick(60);
});

test('signing out forgets a half-filled Add form too', async () => {
  await loaded();
  A.emp.adding = true; A.emp.addName = 'Half Typed'; A.emp.addEmail = 'half@typed.example';
  A.employeesForget();
  assert.equal(A.emp.addName, ''); assert.equal(A.emp.addEmail, '');
  assert.equal(A.emp.link, null);
});

/* ───────────── guard flags clear on failure ─────────────
   Every load and every button here sets a flag ("already doing that") and
   clears it when the answer comes back. If the answer never comes — the data
   function is built not to throw, but a browser can still throw at an await —
   the flag stays true: the list freezes, or a button stays disabled for the rest
   of the session, and the only way out is reloading the whole app.
   These tests make the awaited call throw and check the flag comes back. */

const run = (code) => vm.runInContext(code, sandbox);

test('a load that throws clears emp.loading, so the list keeps refreshing', async () => {
  reset();
  run('empFetchList = async () => { throw new Error("The database did not answer.") }');
  await run('empLoad(true)');
  assert.equal(A.emp.loading, false, 'cleared, so empLoad can ask again');
  assert.ok(A.emp.err, 'and the reason is said out loud');
  assert.doesNotMatch(String(A.emp.err), /permission denied|relation |PGRST|42501|undefined/i, 'in plain words');
  /* it really does ask again rather than sitting on the flag */
  let asked = 0;
  run('empFetchList = async () => { globalThis.__asked = (globalThis.__asked||0) + 1; return {ok:true, data:[], error:null, missing:false} }');
  await run('empLoad(true)');
  asked = run('globalThis.__asked');
  assert.equal(asked, 1, 'the next load reached the data function');
  assert.equal(A.emp.loaded, true);
});

test('a write that throws gives the button back — and is attempted once, never twice', async () => {
  reset();
  /* adding a person */
  run('globalThis.__n = 0; empAdd = async () => { globalThis.__n++; throw new Error("The database did not answer.") }');
  el('empAddName').value = 'Nadia Perera';
  el('empAddEmail').value = 'nadia@aviance.test';
  await run('empAddSave()');
  assert.equal(A.emp.addBusy, false, 'the Add button comes back');
  assert.ok(A.emp.addErr, 'and says why');
  assert.equal(run('globalThis.__n'), 1, 'a write is attempted once: a retry would add her twice');

  /* sending her a message */
  reset();
  run('emp.list = [{id:"s1", name:"Nadia", channelId:"ch1", status:"active", unread:0}]; emp.open = "s1";');
  el('empDraft').value = 'Morning';
  run('globalThis.__n = 0; empSendMessage = async () => { globalThis.__n++; throw new Error("The database did not answer.") }');
  await run('empSendClick()');
  assert.equal(A.emp.sending, false, 'the Send box comes back, or she can never be written to again');
  assert.equal(run('globalThis.__n'), 1, 'a message is sent once, never twice');

  /* making her access code */
  reset();
  run('emp.list = [{id:"s1", name:"Nadia", channelId:"ch1", status:"invited", unread:0}];');
  run('globalThis.__n = 0; empCode = async () => { globalThis.__n++; throw new Error("The database did not answer.") }');
  await run('empCodeGo("s1")');
  assert.equal(run('emp.busy.s1'), undefined, 'the per-person flag is cleared');
  assert.equal(run('globalThis.__n'), 1);

  /* changing whether she can sign in */
  reset();
  run('emp.list = [{id:"s1", name:"Nadia", channelId:"ch1", status:"active", unread:0}];');
  run('globalThis.__n = 0; empSetStatus = async () => { globalThis.__n++; throw new Error("The database did not answer.") }');
  await run('empRevokeGo("s1", "revoked")');
  assert.equal(run('emp.busy.s1'), undefined);
  assert.equal(run('globalThis.__n'), 1, 'never applied twice');
});
