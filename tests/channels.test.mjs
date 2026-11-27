/* Tests for the Channels screen (channels.js). Run with:  npm test
   The shell's inline script + channels.js exactly like the browser, a tiny fake DOM, and the ch* data
   functions stubbed on globalThis (the real ones are channels-api.js, CONTRACT.md "Hub data layer"). No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM ───────────── */
const elements = {};
/* Cut the element with id=X out of an html string (balanced on its own tag name). */
function slice(html, id) {
  const m = new RegExp('<([a-z0-9]+)\\b[^>]*\\bid="' + id + '"[^>]*>').exec(html);
  if (!m) return null;
  const tag = m[1]; const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'g'); re.lastIndex = m.index + m[0].length;
  let depth = 1, x;
  while ((x = re.exec(html))) { depth += x[1] ? -1 : (x[0].endsWith('/>') ? 0 : 1); if (!depth) return html.slice(m.index + m[0].length, x.index); }
  return html.slice(m.index + m[0].length);
}
const CHILD_IDS = ['chvListPane', 'chvListBody', 'chvMain', 'chvHead', 'chvThread', 'chvTyping', 'chvBot', 'chvComposer'];
function fakeEl(id) {
  let html = '';
  const el = { id, tagName: 'DIV', value: '', checked: false, textContent: '', style: {}, hidden: false, disabled: false, scrollTop: 0, scrollHeight: 1000, clientHeight: 400, _classes: new Set(), className: '',
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, contains() { return false; }, addEventListener() {}, closest() { return null; }, getAttribute() { return null; },
    focus() { el._focus = (el._focus || 0) + 1; }, select() {}, click() { el._clicked = (el._clicked || 0) + 1; }, scrollIntoView() { el._scrolled = (el._scrolled || 0) + 1; } };
  Object.defineProperty(el, 'innerHTML', { get: () => html, set(v) { html = String(v); for (const c of CHILD_IDS) { if (c === id) continue; const part = slice(html, c); if (part != null) elements[c] ? (elements[c].innerHTML = part) : (fakeElReg(c).innerHTML = part); } } });
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
function fakeElReg(id) { return (elements[id] ||= fakeEl(id)); }
const el = fakeElReg;
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.location = { hash: '', origin: 'https://aviance.store', pathname: '/', search: '' };
globalThis.history = { replaceState(_a, _b, url) { globalThis.location.hash = (String(url).match(/#.*$/) || [''])[0]; } };
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
globalThis.addEventListener = () => {};
const fakeSb = { auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }), signOut: async () => {} }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
globalThis.supabase = { createClient: () => fakeSb };

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="finance.js">'));
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'channels.js'), 'utf8'), { filename: 'channels.js' });
const chv = vm.runInThisContext('chv');
after(() => { channelsStopTimer(); });

/* ───────────── a fake data layer ───────────── */
const tick = (ms = 8) => new Promise((r) => setTimeout(r, ms));
const iso = (daysAgo, h, min) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, min, 0, 0); return d.toISOString(); };
let be;
function reset(over = {}) {
  channelsForget();
  for (const k of Object.keys(elements)) delete elements[k];
  globalThis.innerWidth = 1400; globalThis.location.hash = '';
  be = Object.assign({
    calls: [], subs: {}, unsubs: 0, typingCalls: 0, marked: [],
    channels: [
      { id: 'c1', name: 'Stone Roofing', kind: 'client', clientId: 'stone-roofing', archived: false, lastMessageAt: iso(0, 11, 0), unread: 3 },
      { id: 't1', name: 'General', kind: 'team', clientId: null, archived: false, lastMessageAt: iso(1, 9, 0), unread: 0 },
      { id: 'a1', name: 'Old project', kind: 'team', clientId: null, archived: true, lastMessageAt: iso(30, 9, 0), unread: 0 },
    ],
    messages: { c1: [], t1: [] },
    members: [{ userId: 'u1', name: 'Owner' }, { userId: 'u2', name: 'Sam' }],
    fail: {},
  }, over);
  const rec = (n, ...a) => { be.calls.push([n, ...a]); };
  const res = (n, data) => (be.fail[n] ? { ok: false, data: null, error: be.fail[n] } : { ok: true, data, error: null });
  Object.assign(globalThis, {
    chListChannels: async () => (rec('chListChannels'), res('chListChannels', be.channels.map((c) => ({ ...c })))),
    chMessages: async (id, o) => { rec('chMessages', id, o); const all = be.messages[id] || []; const lim = (o && o.limit) || 50; let list = all; if (o && o.before) list = all.filter((m) => m.createdAt < o.before); return res('chMessages', list.slice(-lim)); },
    chSend: async (id, body, files) => { rec('chSend', id, body, files); const m = { id: 'new' + be.calls.length, userId: 'u1', name: 'Owner', body, attachments: (files || []).map((f) => ({ path: id + '/' + f.name, name: f.name, size: f.size, type: f.type })), createdAt: new Date().toISOString(), editedAt: null, deleted: false }; if (!be.fail.chSend) (be.messages[id] ||= []).push(m); return res('chSend', m); },
    chEdit: async (id, body) => (rec('chEdit', id, body), res('chEdit', { editedAt: new Date().toISOString() })),
    chDelete: async (id) => (rec('chDelete', id), res('chDelete', {})),
    chMarkRead: async (id) => (rec('chMarkRead', id), be.marked.push(id), res('chMarkRead', {})),
    chSubscribe: (id, h) => { be.subs[id] = h; rec('chSubscribe', id); return () => { be.unsubs++; delete be.subs[id]; }; },
    chTyping: async (id) => { be.typingCalls++; return res('chTyping', {}); },
    chCreateChannel: async (n, ids) => (rec('chCreateChannel', n, ids), be.channels.push({ id: 'n1', name: n, kind: 'team', clientId: null, archived: false, lastMessageAt: null, unread: 0 }), res('chCreateChannel', { id: 'n1' })),
    chRename: async (id, n) => (rec('chRename', id, n), res('chRename', {})),
    chArchive: async (id) => (rec('chArchive', id), res('chArchive', {})),
    chAddMember: async (id, u) => (rec('chAddMember', id, u), res('chAddMember', {})),
    chRemoveMember: async (id, u) => (rec('chRemoveMember', id, u), res('chRemoveMember', {})),
    chMembers: async (id) => res('chMembers', be.members),
    chEnsureClientChannel: async (cid, name) => (rec('chEnsureClientChannel', cid, name), be.channels.push({ id: 'cx', name, kind: 'client', clientId: cid, archived: false, lastMessageAt: null, unread: 0 }), res('chEnsureClientChannel', { id: 'cx' })),
    chFileUrl: async (p) => (rec('chFileUrl', p), res('chFileUrl', 'https://files.example.com/' + encodeURIComponent(p) + '?sig=1')),
    chUnreadTotal: async () => res('chUnreadTotal', 7),
    chSearch: async (q) => (rec('chSearch', q), res('chSearch', [{ id: 'm9', channelId: 't1', name: 'Sam', body: 'about the roof quote', createdAt: iso(1, 9, 5) }])),
  });
  chv.loadStaff = async () => [{ id: 'u1', name: 'Owner' }, { id: 'u2', name: 'Sam' }, { id: 'u3', name: 'Priya' }];
}
const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; currentView = 'channels'; };
const asClient = () => { authUser = { uid: 'u9', name: 'Dana', role: 'client', clientId: 'stone-roofing', email: 'd@example.com' }; currentView = 'channels'; };
const M = (id, userId, name, body, createdAt, extra = {}) => ({ id, userId, name, body, attachments: [], createdAt, editedAt: null, deleted: false, ...extra });
const calls = (n) => be.calls.filter((c) => c[0] === n);
async function show(msgs = {}) {
  Object.assign(be.messages, msgs);
  el('chvRoot').innerHTML = viewChannels();
  await tick(); await tick();
}
const C1 = () => [
  M('m1', 'u2', 'Sam', 'Morning, the quote is ready', iso(1, 10, 0)),
  M('m2', 'u1', 'Owner', 'Great, see https://example.com/quote.pdf.', iso(0, 12, 0)),
  M('m3', 'u1', 'Owner', 'and <script>alert(1)</script> javascript:alert(1)', iso(0, 12, 1), { editedAt: iso(0, 12, 2) }),
  M('m4', 'u2', 'Sam', 'photo', iso(0, 12, 30), { attachments: [{ path: 'c1/a.png', name: 'roof.png', size: 2048, type: 'image/png' }, { path: 'c1/b.pdf', name: 'quote.pdf', size: 3 * 1048576, type: 'application/pdf' }] }),
  M('m5', 'u2', 'Sam', '', iso(0, 12, 31), { deleted: true }),
];

/* ───────────── tests ───────────── */
test('the list: clients and team, unread badge, archived folded away, nav total', async () => {
  reset(); asOwner(); globalThis.innerWidth = 400;
  await show();
  const list = el('chvListBody').innerHTML;
  assert.match(list, />Clients</); assert.match(list, />Team</);
  assert.match(list, /Stone Roofing/); assert.match(list, /General/);
  assert.match(list, /chv-badge[^>]*>3</);
  assert.match(list, /<details class="chv-arch"[^>]*><summary>Archived \(1\)<\/summary>[\s\S]*Old project/);
  assert.ok(list.indexOf('Old project') > list.indexOf('General'));
  assert.equal(chvNavCount(), '3');
  assert.match(navItems().find((i) => i.view === 'channels').badge, /3/);
  assert.match(el('chvRoot').innerHTML, /New channel/);
});
test('the list filters by name and looks up messages', async () => {
  reset(); asOwner(); globalThis.innerWidth = 400;
  await show();
  chvSearchInput('gene'); assert.doesNotMatch(el('chvListBody').innerHTML, /Stone Roofing/); assert.match(el('chvListBody').innerHTML, /General/);
  chvSearchInput('roof'); await tick(300);
  assert.deepEqual(calls('chSearch')[0], ['chSearch', 'roof']);
  assert.match(el('chvListBody').innerHTML, /about the roof quote/);
});
test('open a channel: messages, day separators, author groups, links, images, files, marks', async () => {
  reset(); asOwner();
  await show({ c1: C1() });
  assert.equal(chv.cur, 'c1');                       // desktop opens the latest channel
  const t = el('chvThread').innerHTML;
  assert.match(t, />Yesterday</); assert.match(t, />Today</);
  assert.equal((t.match(/class="chv-who"/g) || []).length, 3);   // Sam (yesterday), Owner (m2+m3 grouped), Sam (m4+m5 grouped)
  assert.equal((t.match(/class="chv-msg/g) || []).length, 5);
  assert.match(t, /<a href="https:\/\/example\.com\/quote\.pdf" target="_blank" rel="noopener noreferrer nofollow">https:\/\/example\.com\/quote\.pdf<\/a>\./);
  assert.doesNotMatch(t, /<script>/); assert.match(t, /&lt;script&gt;/);
  assert.doesNotMatch(t, /href="javascript/i);
  assert.match(t, /\(edited\)/); assert.match(t, /This message was deleted/);
  await tick();
  const t2 = el('chvThread').innerHTML;
  assert.match(t2, /<img src="https:\/\/files\.example\.com\/c1%2Fa\.png\?sig=1"/);            // image preview via chFileUrl
  assert.match(t2, /class="chv-file" href="https:\/\/files\.example\.com\/c1%2Fb\.pdf\?sig=1" download="quote\.pdf"/);
  assert.match(t2, /3 MB/);
  assert.deepEqual(calls('chMessages')[0], ['chMessages', 'c1', { limit: 50 }]);
  assert.ok(be.marked.includes('c1'));                 // opening marks it read
  assert.equal(chvNavCount(), '');
  assert.equal(location.hash, '#channels/c1');
});
test('new messages divider sits before the unread ones', async () => {
  reset(); asOwner();
  await show({ c1: C1() });                            // c1 had unread 3 -> m1, m4, m5 are others' (m5 deleted but counted)
  // unread 3 from others: m5, m4, m1 -> divider before m1
  const t = el('chvThread').innerHTML;
  assert.match(t, /id="chvNew"/);
  assert.ok(t.indexOf('id="chvNew"') < t.indexOf('chvM-m1'));
  assert.ok(el('chvNew')._scrolled >= 0);
});
test('linkify only makes http/https links and escapes the rest', () => {
  assert.equal(chvLinkify('a <b> & c'), 'a &lt;b&gt; &amp; c');
  assert.doesNotMatch(chvLinkify('ftp://x.test javascript:alert(1) data:text/html,<x>'), /<a /);
  assert.match(chvLinkify('go to http://x.test/a?b=1&c=2, ok'), /href="http:\/\/x\.test\/a\?b=1&amp;c=2"/);
  assert.equal(chvLinkify('one\ntwo'), 'one<br>two');
  assert.match(chvLinkify('"><img src=x onerror=1> https://a.test/"x'), /&quot;&gt;&lt;img/);
});
test('send: Enter sends, Shift+Enter does not, the message appears and the box clears', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  el('chvInput').value = 'hello team';
  let prevented = 0;
  chvKey({ key: 'Enter', shiftKey: true, preventDefault() { prevented++; } });
  assert.equal(prevented, 0); assert.equal(calls('chSend').length, 0);
  chvKey({ key: 'Enter', shiftKey: false, preventDefault() { prevented++; } });
  await tick();
  assert.equal(prevented, 1);
  assert.deepEqual(calls('chSend')[0].slice(0, 3), ['chSend', 'c1', 'hello team']);
  assert.match(el('chvThread').innerHTML, /hello team/);
  assert.equal(chv.drafts.c1, '');
  assert.ok(el('chvThread').scrollTop >= 0);
});
test('send: empty does nothing; a failure keeps the draft and says why', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  el('chvInput').value = '   '; await chvSend(); assert.equal(calls('chSend').length, 0);
  be.fail.chSend = 'You are offline. Try again.';
  el('chvInput').value = 'will fail'; await chvSend();
  assert.equal(el('chvCErr').textContent, 'You are offline. Try again.');
  assert.doesNotMatch(el('chvThread').innerHTML, /will fail/);
  assert.equal(chv.sending, false);
});
test('edit and delete your own messages only', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  const t = el('chvThread').innerHTML;
  assert.match(t, /chvEditStart\(&quot;m2&quot;\)|chvEditStart\(\"m2\"\)/);   // own
  assert.doesNotMatch(t, /chvEditStart\(&quot;m1&quot;\)/);                    // Sam's
  chvEditStart('m2');
  assert.match(el('chvThread').innerHTML, /<textarea id="chvEdit"/);
  el('chvEdit').value = 'Great, thanks';
  chvEditKey({ key: 'Enter', shiftKey: false, preventDefault() {} }); await tick();
  assert.deepEqual(calls('chEdit')[0], ['chEdit', 'm2', 'Great, thanks']);
  assert.match(el('chvThread').innerHTML, /Great, thanks[\s\S]*\(edited\)/);
  chvEditStart('m2'); chvEditKey({ key: 'Escape', preventDefault() {} });
  assert.equal(chv.editing, null);
  chvEditStart('m1'); assert.equal(chv.editing, null);                         // not yours
  chvDelete('m2'); assert.match(el('modal').innerHTML, /Delete this message\?/);
  await chvDoDelete('m2');
  assert.deepEqual(calls('chDelete')[0], ['chDelete', 'm2']);
  assert.match(el('chvThread').innerHTML, /chvM-m2[\s\S]*This message was deleted/);
});
test('files are switched off (no storage bucket): no Attach button, adding or pasting a file says so, text still sends', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  const comp = el('chvComposer').innerHTML;
  assert.doesNotMatch(comp, /chv-attach|Attach files|type="file"/);
  chvAddFiles([{ name: 'ok.pdf', size: 1000, type: 'application/pdf' }]);
  assert.equal(chv.pending.length, 0); assert.match(chv.cerr, /Sending files isn't switched on yet/);
  let pd = 0;
  chvPaste({ clipboardData: { files: [{ name: 'image.png', size: 500, type: 'image/png' }] }, preventDefault() { pd++; } });
  assert.equal(pd, 0); assert.equal(chv.pending.length, 0);
  el('chvInput').value = 'text only';
  await chvSend();
  assert.deepEqual(calls('chSend')[0].slice(0, 4), ['chSend', 'c1', 'text only', []]);
});
test('a web-link attachment (attachment_url) shows as a file chip without signing', async () => {
  reset(); asOwner();
  await show({ c1: [M('w1', 'u2', 'Sam', 'the quote', iso(0, 9, 0), { attachments: [{ path: 'https://files.test/q.pdf', url: 'https://files.test/q.pdf', name: 'q.pdf', size: 0, type: '' }] })] });
  await tick();
  assert.match(el('chvThread').innerHTML, /class="chv-file" href="https:\/\/files\.test\/q\.pdf" download="q\.pdf"/);
  assert.equal(calls('chFileUrl').length, 0);
});
test('client channel: listed under Clients, labelled a client channel, client messages tagged, the owner replies', async () => {
  // as close_won leaves it: kind client, owner member, one client person, the client has written first
  reset({ channels: [{ id: 'cw', name: 'Blue Sky', kind: 'client', clientId: 'cl-1', company: 'Blue Sky', archived: false, lastMessageAt: iso(0, 9, 0), unread: 1 }] });
  asOwner();
  await show({ cw: [M('k1', 'p-1', 'Pat Lee (Blue Sky)', 'Hi, when do we start?', iso(0, 9, 0), { isClient: true, authorKind: 'client', company: 'Blue Sky' })] });
  const list = el('chvListBody').innerHTML;
  assert.match(list, />Clients<[\s\S]*Blue Sky/); assert.match(list, /aria-label="Blue Sky, client channel/); assert.match(list, /class="chv-row on client"/);
  assert.equal(chv.cur, 'cw');
  assert.match(el('chvHead').innerHTML, /Client channel · Blue Sky reads and writes here/);
  const t = el('chvThread').innerHTML;
  assert.match(t, /chv-msg first from-client/); assert.match(t, /Pat Lee \(Blue Sky\)<\/span><span class="chv-client-tag">Client<\/span>/);
  assert.doesNotMatch(t, /chvEditStart\(&quot;k1&quot;\)/);                     // not the owner's to edit
  assert.ok(be.marked.includes('cw'));
  el('chvInput').value = 'Monday, 10am';
  await chvSend();
  assert.deepEqual(calls('chSend')[0].slice(0, 3), ['chSend', 'cw', 'Monday, 10am']);
  const t2 = el('chvThread').innerHTML;
  assert.match(t2, /Monday, 10am/);
  assert.ok(t2.lastIndexOf('chv-client-tag') < t2.indexOf('Monday, 10am'));
  assert.doesNotMatch(t2.slice(t2.indexOf('chvM-new')), /from-client/);           // the owner's reply is not marked as the client
});
test('members of a client channel: client people are marked and cannot be removed here', async () => {
  reset({ members: [{ userId: 'u1', name: 'Owner', kind: 'team' }, { userId: 'p-1', name: 'Pat Lee (Stone Roofing)', kind: 'client', isClient: true }] });
  asOwner(); await show({ c1: C1() });
  await chvMembers(); await tick();
  const b = el('chvMemBody').innerHTML;
  assert.match(b, /Pat Lee \(Stone Roofing\)<\/span><span class="chv-client-tag">Client/);
  assert.doesNotMatch(b, /chvRemoveMember\(&quot;p-1&quot;\)/);
});
test('realtime: a message arrives at the bottom, an edit updates it, typing shows and clears', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  const h = be.subs.c1; assert.ok(h);
  el('chvThread').scrollTop = 600;                      // 1000 - 600 - 400 = 0 from the bottom
  h.onMessage(M('r1', 'u2', 'Sam', 'live message', new Date().toISOString(), { channelId: 'c1' }));
  assert.match(el('chvThread').innerHTML, /live message/);
  assert.equal(chv.newBelow, 0);
  h.onUpdate(M('r1', 'u2', 'Sam', 'live message v2', new Date().toISOString(), { editedAt: new Date().toISOString() }));
  assert.match(el('chvThread').innerHTML, /live message v2/);
  h.onUpdate({ id: 'r1', deleted: true, body: '' });
  assert.match(el('chvThread').innerHTML, /chvM-r1[\s\S]*was deleted/);
  h.onMessage(M('zz', 'u2', 'Sam', 'other channel', new Date().toISOString(), { channelId: 't1' }));
  assert.doesNotMatch(el('chvThread').innerHTML, /other channel/);
  h.onTyping({ userId: 'u2', name: 'Sam' });
  assert.equal(el('chvTyping').innerHTML, 'Sam is typing');
  h.onTyping({ userId: 'u3', name: 'Priya' });
  assert.equal(el('chvTyping').innerHTML, 'Sam and Priya are typing');
  h.onTyping({ userId: 'u1', name: 'Owner' });          // yourself: ignored
  assert.doesNotMatch(el('chvTyping').innerHTML, /Owner/);
});
test('realtime: scrolled up, a new message waits behind a "New messages" pill', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  chv.divId = null;
  el('chvThread').scrollTop = 0;                        // far from the bottom
  be.subs.c1.onMessage(M('r2', 'u2', 'Sam', 'while you read', new Date().toISOString(), { channelId: 'c1' }));
  assert.equal(chv.newBelow, 1); assert.equal(chv.divId, 'r2');
  assert.equal(el('chvNewPill').hidden, false);
  assert.match(el('chvThread').innerHTML, /id="chvNew"/);
  chvJumpNew(); assert.equal(chv.newBelow, 0); assert.equal(el('chvNewPill').hidden, true);
});
test('leaving the view unsubscribes; the nav badge keeps counting', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  const before = be.unsubs;
  currentView = 'calendar';
  channelsOnRender('calendar'); await tick();
  assert.equal(be.unsubs, before + 1);
  assert.equal(chv.unreadTotal, 7);                     // chUnreadTotal answered 7
  assert.equal(chvNavCount(), '7');
  assert.equal(location.hash, '');
});
test('older messages load when you scroll to the top', async () => {
  reset(); asOwner();
  const many = Array.from({ length: 60 }, (_, i) => M('o' + String(i).padStart(2, '0'), 'u2', 'Sam', 'msg ' + i, new Date(Date.now() - (70 - i) * 3600e3).toISOString()));
  await show({ c1: many });
  assert.equal(chv.msgs.length, 50); assert.equal(chv.hasMore, true);
  /* the earlier batch has a real button, so the thread can be paged from the keyboard */
  assert.match(el('chvThread').innerHTML, /<button type="button" class="chv-link" onclick="chvLoadOlder\(\)">Load earlier messages<\/button>/);
  el('chvThread').scrollTop = 10; chvScroll(el('chvThread')); await tick();
  assert.equal(calls('chMessages')[1][2].before, many[10].createdAt);
  assert.equal(chv.msgs.length, 60); assert.equal(chv.hasMore, false);
  assert.match(el('chvThread').innerHTML, /msg 0</); assert.match(el('chvThread').innerHTML, /Start of the conversation/);
});
test('client mode: only their channel, opens straight in, no admin, no list', async () => {
  reset(); asClient();
  be.channels = [{ id: 'c1', name: 'Stone Roofing', kind: 'client', clientId: 'stone-roofing', archived: false, lastMessageAt: iso(0, 11, 0), unread: 0 }, { id: 't1', name: 'General', kind: 'team', archived: false, unread: 0 }];
  globalThis.innerWidth = 400;                          // even on a phone
  await show({ c1: C1() });
  assert.equal(chv.cur, 'c1'); assert.equal(chv.chs.length, 1);
  const root = el('chvRoot');
  assert.match(root.innerHTML, /chv-main/);
  assert.equal(el('chvListPane').innerHTML, '');        // no list
  const head = el('chvHead').innerHTML;
  assert.doesNotMatch(head, /Rename|Archive|Members/); assert.doesNotMatch(head, /chvBack/);
  assert.doesNotMatch(root.innerHTML, /New channel/);
  assert.match(root.className, /chv-solo/);
});
test('client mode without a channel yet says so', async () => {
  reset(); asClient(); be.channels = [];
  await show();
  assert.match(el('chvMain').innerHTML, /isn't ready yet/);
});
test('phone: list -> channel -> back toggles the pane class', async () => {
  reset(); asOwner(); globalThis.innerWidth = 400;
  await show({ c1: C1() });
  assert.equal(chv.cur, null); assert.equal(chv.pane, 'list');                   // phone starts on the list
  assert.match(el('chvRoot').className, /chv-pane-list/);
  await chvOpen('c1');
  assert.match(el('chvRoot').className, /chv-pane-thread/); assert.doesNotMatch(el('chvRoot').className, /chv-pane-list/);
  assert.match(el('chvHead').innerHTML, /chvBack\(\)/);
  chvBack();
  assert.match(el('chvRoot').className, /chv-pane-list/);
});
test('the Numbers side panel is gone: nothing in the repo ever defined what filled it', () => {
  const all = fs.readdirSync(root).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  for (const gone of ['renderClientNumbers', 'chvTogglePanel', 'chv-panel-open', 'chv-side', 'chvNumbers']) assert.ok(!all.includes(gone), gone + ' is still in the site');
});
test('channel admin: new channel, rename, archive, members, start a client channel', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  await chvNewChannel();
  assert.match(el('modal').innerHTML, /Sam/); assert.doesNotMatch(el('modal').innerHTML, /value="u1"/);
  el('chvNewName').value = ''; await chvCreate(2); assert.equal(calls('chCreateChannel').length, 0);
  el('chvNewName').value = 'Sales'; el('chvNm1').checked = true; el('chvNm1').value = 'u3';
  await chvCreate(2);
  assert.deepEqual(calls('chCreateChannel')[0], ['chCreateChannel', 'Sales', ['u3']]);
  assert.equal(chv.cur, 'n1');
  chvRename(); el('chvRenameName').value = 'Sales team'; await chvDoRename();
  assert.deepEqual(calls('chRename')[0], ['chRename', 'n1', 'Sales team']); assert.match(el('chvHead').innerHTML, /Sales team/);
  await chvMembers(); await tick();
  assert.match(el('chvMemBody').innerHTML, /Sam/); assert.match(el('chvMemBody').innerHTML, /Priya/);   // Priya can be added
  el('chvAddSel').value = 'u3'; await chvAddMember(); assert.deepEqual(calls('chAddMember')[0], ['chAddMember', 'n1', 'u3']);
  await chvRemoveMember('u2'); assert.deepEqual(calls('chRemoveMember')[0], ['chRemoveMember', 'n1', 'u2']);
  await chvDoArchive();
  assert.deepEqual(calls('chArchive')[0], ['chArchive', 'n1']);
  assert.match(el('chvComposer').innerHTML, /archived/i); assert.doesNotMatch(el('chvThread').innerHTML, /chvEditStart/);
  // a client without a channel
  const shellTkListRows = globalThis.tkListRows, shellTk = globalThis.tk;
  globalThis.tkListRows = () => [{ id: 'blue-sky', name: 'Blue Sky' }]; globalThis.tk = { hub: {} };
  assert.match(chvNoChannelHTML(), /Blue Sky/);
  await chvStartClient('blue-sky');
  /* The shell now resolves a client's real company name (index.html's tkFindRow over
     the clients table), so the channel is named after the business rather than its id. */
  assert.deepEqual(calls('chEnsureClientChannel')[0], ['chEnsureClientChannel', 'blue-sky', 'Blue Sky']);
  assert.equal(chv.cur, 'cx');
  assert.doesNotMatch(chvNoChannelHTML(), /Blue Sky/);
  /* The shell defines tkListRows/tk itself now, so put them back rather than deleting them. */
  globalThis.tkListRows = shellTkListRows; globalThis.tk = shellTk;
});
test('errors are plain words with a way to try again', async () => {
  reset(); asOwner(); be.fail.chListChannels = 'The channels did not load.';
  await show();
  assert.match(el('chvListBody').innerHTML, /did not load[\s\S]*Try again/);
  reset(); asOwner(); be.fail.chMessages = 'Messages are not available.';
  await show();
  assert.match(el('chvThread').innerHTML, /Messages are not available[\s\S]*Try again/);
});
test('deep links: #channels and #channels/{id}', () => {
  assert.deepEqual(parseDeepLink('#channels'), { view: 'channels' });
  assert.deepEqual(parseDeepLink('#channels/abc-123'), { view: 'channels', id: 'abc-123' });
  assert.equal(parseDeepLink('#channels/a b'), null);
});

/* ───────────── the bot's drafts, inline at the bottom of a client channel ───────────── */
function botStubs(list) {
  const st = { list: list.slice(), sent: [], discarded: [], fail: {} };
  globalThis.chBotDrafts = async (id) => (be.calls.push(['chBotDrafts', id]), st.fail.load ? { ok: false, data: null, error: 'nope' } : { ok: true, data: st.list.filter((d) => d.channelId === id), error: null });
  globalThis.chBotSend = async (id, body) => { st.sent.push([id, body]); if (st.fail.send) return { ok: false, data: null, error: st.fail.send }; st.list = st.list.filter((d) => d.id !== id); return { ok: true, data: { messageId: 'mm' }, error: null }; };
  globalThis.chBotDiscard = async (id) => { st.discarded.push(id); st.list = st.list.filter((d) => d.id !== id); return { ok: true, data: { id }, error: null }; };
  return st;
}
function noBot() { delete globalThis.chBotDrafts; delete globalThis.chBotSend; delete globalThis.chBotDiscard; }
test('bot drafts: a client channel shows its pending drafts above the composer, escaped, for staff only', async () => {
  reset(); asOwner();
  const st = botStubs([{ id: 'd1', channelId: 'c1', kind: 'reply', body: 'hey Sam, ur kickoff is <b>tmrw</b>', reason: 'asked about the call' }, { id: 'd9', channelId: 't1', kind: 'reply', body: 'other channel' }]);
  await show({ c1: C1() }); await tick();
  const bot = el('chvBot').innerHTML;
  assert.match(bot, /Bot draft · only you can see this · asked about the call/);
  assert.match(bot, /hey Sam, ur kickoff is &lt;b&gt;tmrw&lt;\/b&gt;/);
  assert.doesNotMatch(bot, /other channel/);
  assert.match(bot, />Send</); assert.match(bot, />Discard</);
  // edit then send: the edited text goes out, the draft disappears
  chvBotEdit('d1', 'hey Sam, ur kickoff is tmrw at 10am ET');
  await chvBotSend('d1');
  assert.deepEqual(st.sent, [['d1', 'hey Sam, ur kickoff is tmrw at 10am ET']]);
  assert.equal(chv.bot.length, 0);
  assert.equal(el('chvBot').innerHTML, '');
  // a client never sees them
  reset(); asClient(); botStubs([{ id: 'd1', channelId: 'c1', kind: 'reply', body: 'secret draft' }]);
  await show({ c1: C1() }); await tick();
  assert.doesNotMatch(el('chvRoot').innerHTML + (el('chvBot').innerHTML || ''), /secret draft/);
  noBot();
});
test('bot drafts: discard, a failed send keeps the draft and says why, team channels show none', async () => {
  reset(); asOwner();
  const st = botStubs([{ id: 'd1', channelId: 'c1', kind: 'reply', body: 'one' }, { id: 'd2', channelId: 'c1', kind: 'welcome', body: 'two' }]);
  await show({ c1: C1() }); await tick();
  await chvBotDiscard('d2');
  assert.deepEqual(st.discarded, ['d2']);
  st.fail.send = 'That draft was already sent.';
  await chvBotSend('d1');
  assert.equal(chv.bot.length, 1);
  assert.match(el('chvBot').innerHTML, /That draft was already sent\./);
  // Ctrl+Enter sends
  st.fail.send = null; let prevented = 0;
  chvBotKey({ key: 'Enter', ctrlKey: true, preventDefault() { prevented++; } }, 'd1'); await tick();
  assert.equal(prevented, 1); assert.equal(st.sent.length, 2);
  // a team channel: no lookup
  be.calls.length = 0;
  await chvOpen('t1'); await tick();
  assert.equal(calls('chBotDrafts').length, 0);
  noBot();
});

/* ───────────── perfection pass ───────────── */
function slowSend() {
  let go; const gate = new Promise((r) => { go = r; });
  const real = globalThis.chSend;
  globalThis.chSend = async (...a) => { await gate; return real(...a); };
  return go;
}
test('send: the message is on screen and the box is empty before the network answers', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  const go = slowSend();
  el('chvInput').value = 'on its way';
  const p = chvSend();
  await tick();
  assert.match(el('chvThread').innerHTML, /chv-msg[^"]*sending[^>]*>[\s\S]*on its way/, 'drawn at once, marked as sending');
  assert.equal(el('chvInput').value, '', 'the box is ready for the next message');
  assert.doesNotMatch(el('chvThread').innerHTML, /chvEditStart\(&quot;chv-sending/, 'no Edit or Delete on a message that is not saved yet');
  await chvSend();                                   // a second Enter while the first is in flight does nothing
  go(); await p;
  assert.equal(calls('chSend').length, 1);
  const t = el('chvThread').innerHTML;
  assert.equal(t.split('on its way').length - 1, 1, 'the real message replaces the placeholder, never both');
  assert.doesNotMatch(t, /chv-sending-|chv-msg[^"]*sending/);
  assert.equal(chv.sending, false);
});
test('send: what he types while a message is on its way is never wiped', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  const go = slowSend();
  el('chvInput').value = 'first';
  const p = chvSend(); await tick();
  el('chvInput').value = 'second, typed during the round trip';
  go(); await p;
  assert.equal(el('chvInput').value, 'second, typed during the round trip');
  assert.equal(chv.drafts.c1, 'second, typed during the round trip');
  assert.equal(chvLeftover('first', 'first and more'), 'and more');
  assert.equal(chvLeftover('first', 'first'), '');
  assert.equal(chvLeftover('first', 'rewritten'), 'rewritten');
});
test('send: a failure takes the message back out of the thread and puts the words back in the box', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  be.fail.chSend = 'You are offline. Try again.';
  const go = slowSend();
  el('chvInput').value = 'will not go';
  const p = chvSend(); await tick();
  el('chvInput').value = 'more';
  go(); await p;
  assert.doesNotMatch(el('chvThread').innerHTML, /will not go/);
  assert.equal(el('chvInput').value, 'will not go\nmore');
  assert.equal(el('chvCErr').textContent, 'You are offline. Try again.');
  // and if he had moved to another channel meanwhile, the words wait for him in the first one
  reset(); asOwner(); await show({ c1: C1() });
  be.fail.chSend = 'You are offline. Try again.';
  const go2 = slowSend();
  el('chvInput').value = 'for the client';
  const p2 = chvSend(); await tick();
  await chvOpen('t1');
  go2(); await p2;
  assert.equal(chv.drafts.c1, 'for the client');
  assert.match(el('toast').innerHTML, /You are offline[\s\S]*back in the box in Stone Roofing/);
});
test('a live message that arrives before the send answers is not shown twice', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  let go; const gate = new Promise((r) => { go = r; });
  globalThis.chSend = async (id, body) => { be.calls.push(['chSend', id, body]); await gate; return { ok: true, data: M('real1', 'u1', 'Owner', body, new Date().toISOString()), error: null }; };
  el('chvInput').value = 'race';
  const p = chvSend(); await tick();
  be.subs.c1.onMessage(M('real1', 'u1', 'Owner', 'race', new Date().toISOString()));
  go(); await p;
  assert.equal(el('chvThread').innerHTML.split('chvM-real1').length - 1, 1);
  assert.doesNotMatch(el('chvThread').innerHTML, /chv-sending-/);
});
test('a dropped live line: the next refresh fetches what was missed, once', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  // a message lands in the open channel but the live line never delivers it.
  // It must be NEWER than the newest fixture message (m5, today 12:31), because the
  // refresh only asks for what came after the last one it knows about. This used to
  // be Date.now() + 1s, which is older than 12:31 for the whole morning — so the test
  // failed every day between midnight and lunchtime, local time, and passed in a UTC
  // afternoon. Pin it to the fixture's own clock instead of the wall clock.
  const late = M('m9', 'u2', 'Sam', 'did you see this?', iso(0, 12, 32));
  be.messages.c1.push(late);
  be.channels[0].lastMessageAt = late.createdAt; be.channels[0].unread = 1;
  const before = calls('chMessages').length;
  await chvReload(); await tick();
  assert.match(el('chvThread').innerHTML, /did you see this\?/);
  assert.equal(calls('chMessages').length, before + 1);
  await chvReload(); await tick();
  assert.equal(calls('chMessages').length, before + 1, 'nothing newer: no second fetch');
  assert.equal(chvFindCh('c1').unread, 0);
});
test('the unread counts are checked every 20 seconds, not once a minute', () => {
  assert.equal(CHV_POLL_MS, 20000);
});
test('New channel: a double click makes one channel, and a failed staff lookup is not remembered', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  await chvNewChannel();
  el('chvNewName').value = 'Sales';
  await Promise.all([chvCreate(0), chvCreate(0)]);
  assert.equal(calls('chCreateChannel').length, 1);
  // the staff list: an error is not cached as "nobody"
  chv.staff = null; chv.loadStaff = null;
  let n = 0;
  const realFrom = fakeSb.from;
  fakeSb.from = () => ({ select: async () => (++n === 1 ? { data: null, error: { message: 'down' } } : { data: [{ id: 'u2', name: 'Sam', role: 'employee', approved: true }], error: null }) });
  try {
    assert.deepEqual(await chvLoadStaffList(), []);
    assert.equal(chv.staff, null);
    assert.deepEqual((await chvLoadStaffList()).map((p) => p.name), ['Sam']);
  } finally { fakeSb.from = realFrom; }
});

/* A message is ONE insert, and an insert can be committed while the answer home
   is lost (a dropped connection, or a re-read the rule would not allow). The
   screen was then told "it didn't send" about a message the client can already
   read, and the words went back in the box — so pressing Send said it twice.
   When the very same words come back as mine, that is proof it did send. */
test('send: a failure that turns out to have landed clears the warning and the box', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  be.fail.chSend = 'You are offline. Try again.';
  el('chvInput').value = 'the server kept this one';
  await chvSend(); await tick();
  assert.equal(el('chvInput').value, 'the server kept this one', 'the words are kept, as before');
  assert.equal(el('chvCErr').textContent, 'You are offline. Try again.');

  /* the live line (or the 20-second catch-up) delivers the row the server did keep */
  be.subs.c1.onMessage(M('kept1', 'u1', 'Owner', 'the server kept this one', new Date().toISOString()));
  await tick();
  assert.match(el('chvThread').innerHTML, /the server kept this one/, 'it is in the thread');
  assert.equal(el('chvInput').value, '', 'and no longer waiting in the box to be said twice');
  assert.equal(chv.drafts.c1, '');
  assert.match(el('chvCErr').textContent, /did send after all/);
  assert.equal(el('chvSend').disabled, false);
});
test('send: a different message arriving does not clear a real failure', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  be.fail.chSend = 'You are offline. Try again.';
  el('chvInput').value = 'this one really did not go';
  await chvSend(); await tick();
  be.subs.c1.onMessage(M('other1', 'u2', 'Sam', 'something else entirely', new Date().toISOString()));
  await tick();
  assert.equal(el('chvInput').value, 'this one really did not go', 'the words stay');
  assert.equal(el('chvCErr').textContent, 'You are offline. Try again.', 'and so does the warning');
});
test('send: a send that worked leaves nothing behind to second-guess', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  el('chvInput').value = 'this one went';
  await chvSend(); await tick();
  assert.deepEqual(Object.keys(chv.unsure), [], 'nothing is being doubted');
});

/* The same signature again, twice more: a read whose failure and whose empty
   answer both leave an empty list on screen. */
test("bot drafts: a read that was refused says so, instead of an empty strip", async () => {
  reset(); asOwner();
  const st = botStubs([{ id: 'd1', channelId: 'c1', kind: 'reply', body: 'a draft that is really waiting' }]);
  st.fail.load = true;
  await show({ c1: C1() }); await tick(30);
  const bot = el('chvBot').innerHTML;
  assert.ok(chv.botErr, 'the failure is held');
  assert.match(bot, /nope|didn't load/, 'and the owner is told, rather than shown nothing');
  assert.equal(chv.bot.length, 0);
  /* and it clears once the read works */
  st.fail.load = false;
  await chvBotLoad(); await tick();
  assert.equal(chv.botErr, '');
  assert.match(el('chvBot').innerHTML, /a draft that is really waiting/);
  noBot();
});
test('the team list: a read that was refused is not "No one else on the team yet"', async () => {
  reset(); asOwner(); await show({ c1: C1() });
  chv.staff = null; chv.loadStaff = null; chv.staffErr = '';
  const realFrom = fakeSb.from;
  fakeSb.from = () => ({ select: async () => ({ data: null, error: { message: 'down' } }) });
  try {
    assert.deepEqual(await chvLoadStaffList(), []);
    assert.ok(chv.staffErr, 'the failure is held');
    await chvNewChannel();
    const modal = el('modal').innerHTML;
    assert.doesNotMatch(modal, /No one else on the team yet/, 'never a confident zero');
    assert.ok(modal.includes(globalThis.esc(chv.staffErr)), 'the reason is in the modal');
  } finally { fakeSb.from = realFrom; }
  /* a team that really is one person still reads as one person */
  chv.staff = null; chv.staffErr = '';
  chv.loadStaff = async () => [{ id: 'u1', name: 'Owner' }];
  assert.deepEqual((await chvLoadStaffList()).map((p) => p.name), ['Owner']);
  assert.equal(chv.staffErr, '');
  await chvNewChannel();
  assert.match(el('modal').innerHTML, /No one else on the team yet/);
});
