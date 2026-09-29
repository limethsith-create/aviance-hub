/* Tests for a client's mail on Stats: Conversations, Every email sent (with Show more), the thread viewer, and
   Trials with a made-up (test run) trial at step 4.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Same set-up as money.test.mjs: the shell's inline script, then the section scripts, with a tiny fake DOM. No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleRows, stagesWith, fullHub, detail } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM (as in trials.test.mjs) ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, open: false, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() { el._focused = (el._focused || 0) + 1; }, select() {}, submit() {}, addEventListener() {}, scrollIntoView() { el._scrolled = (el._scrolled || 0) + 1; }, closest() { return null; }, getAttribute() { return null; } };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.location = { hash: '', origin: 'https://aviance.store', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
globalThis.confirm = () => true; globalThis.prompt = () => 'a reason';
const winListeners = {}; globalThis.addEventListener = (type, fn) => { (winListeners[type] ||= []).push(fn); };

const supa = { session: null, user: null, profile: null };
const fakeSb = {
  auth: { getSession: async () => ({ data: { session: supa.session } }), getUser: async () => ({ data: { user: supa.user } }), signInWithPassword: async () => ({ error: null }), signOut: async () => { supa.session = null; }, resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: supa.profile }) }) }) }),
};
globalThis.supabase = { createClient: () => fakeSb };

/* ───────────── load the shell, then the section scripts ───────────── */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="trials.js">'));
const FILES = ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'warmup.js', 'keys.js', 'push.js', 'people.js'];
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
for (const f of FILES) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
supa.session = { access_token: 'test-token' };
after(() => { trialsStopTimer(); calendarStopTimer(); });

const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const count = (s, re) => (s.match(re) || []).length;
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 5));
const between = (s, a, b) => { const i = s.indexOf(a); const j = b ? s.indexOf(b, i + 1) : s.length; return s.slice(i, j < 0 ? s.length : j); };
const visibleText = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
const offline = () => { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; globalThis.confirm = () => true; };
const asEmployee = () => { authUser = { uid: 'u9', name: 'Nimal', role: 'employee', email: 'nimal@example.com' }; };
const reset = () => { asOwner(); trialsForget(); calendarForget(); asOwner(); document.body._classes.clear(); };

/* ───────────── fixtures: one trial client, its sent emails, its conversations, one whole thread ───────────── */
const ID = 'acme-plumbing';
const route = (map, calls) => async (url, init) => {
  const u = String(url).replace(/^https?:\/\/[^/]+/, ''); const method = (init && init.method) || 'GET';
  calls.push({ u, method });
  const hit = map[method + ' ' + u] ?? map[u];
  if (hit === undefined) return { ok: false, status: 404, text: async () => '' };
  const [status, body] = Array.isArray(hit) ? hit : [200, hit];
  return { ok: status < 400, status, text: async () => JSON.stringify(typeof body === 'function' ? body() : body) };
};
const E = (i, o) => Object.assign({ id: 'e' + i, at: new Date(Date.UTC(2026, 9, 17, 12) - i * 3600e3).toISOString(), to: 'lead' + i + '@firm' + i + '.com', toName: 'Lead ' + i, company: 'Firm ' + i, subject: 'Quick idea for Firm ' + i, from: 'ann@acme-team.com', kind: 'first', status: 'sent', threadId: null }, o);
const page1 = { total: 203, sent: [E(0, { status: 'replied', threadId: 't1', company: 'Cobalt <HVAC>', toName: 'Bob Stone', to: 'bob@cobalt.com', subject: 'Quick idea for Cobalt' }), E(1, { status: 'bounced' }), E(2, { kind: 'followup', status: 'failed' })].concat([...Array(197)].map((_, i) => E(i + 3))), next: '2026-10-09T03:00:00.000Z' };
const page2 = { total: 203, sent: [E(200), E(201), E(202, { status: 'replied', threadId: 't2' })], next: null };
const threads = { threads: [
  { threadId: 't1', lead: { email: 'bob@cobalt.com', name: 'Bob Stone', company: 'Cobalt <HVAC>' }, lastAt: '2026-10-17T15:00:00Z', count: 3, kind: 'interested', handledBy: 'bot', snippet: 'Sounds good — can we talk\nThursday?' },
  { threadId: 't2', lead: { email: 'kim@river.com', name: 'Kim', company: 'River Dental' }, lastAt: '2026-10-16T09:00:00Z', count: 2, kind: 'question', handledBy: 'client', snippet: 'How much is it?' },
  { threadId: 't3', lead: { email: 'x@gone.com', name: '', company: 'Gone Ltd' }, lastAt: '2026-10-15T09:00:00Z', count: 1, kind: 'bounce', handledBy: null, snippet: 'Address not found' },
  { threadId: 't4', lead: { email: 'pat@oak.com', name: 'Pat', company: 'Oak Law' }, lastAt: '2026-10-14T09:00:00Z', count: 2, kind: 'not_now', handledBy: 'owner', snippet: 'Maybe next quarter' },
  { threadId: 't5', lead: { email: 'sam@elm.com', name: 'Sam', company: 'Elm Co' }, lastAt: '2026-10-13T09:00:00Z', count: 2, kind: 'unsubscribe', handledBy: null, snippet: 'Remove me' },
] };
const thread1 = { threadId: 't1', lead: threads.threads[0].lead, messages: [
  { at: '2026-10-17T12:00:00Z', dir: 'out', by: 'system', from: 'Ann Lee <ann@acme-team.com>', to: 'bob@cobalt.com', subject: 'Quick idea for Cobalt', text: 'Hi Bob,\n\nWe fix pipes <fast>.\n\nAnn' },
  { at: '2026-10-17T14:00:00Z', dir: 'in', by: 'prospect', from: 'Bob Stone <bob@cobalt.com>', to: 'ann@acme-team.com', subject: 'Re: Quick idea for Cobalt', text: 'Sounds good — can we talk\nThursday? <script>alert(1)</script>' },
  { at: '2026-10-17T15:00:00Z', dir: 'out', by: 'bot', from: 'Ann Lee <ann@acme-team.com>', to: 'bob@cobalt.com', subject: 'Re: Quick idea for Cobalt', text: 'Thursday works. Here is a link.' },
] };
const base = '/api/mc/hub/' + ID;
const MAP = { [base]: detail, [base + '/growth?days=45']: { days: ['2026-10-16', '2026-10-17'], email: { sent: [100, 103], replies: [2, 3], bounces: [1, 0] } },
  [base + '/emails?limit=200']: page1, [base + '/emails?limit=200&before=' + encodeURIComponent(page1.next)]: page2, [base + '/threads']: threads, [base + '/threads/t1']: thread1 };
/* The whole screen at one tab (the fake DOM keeps a tab's own repaint apart from #tkHost: draw it whole). */
const screenOf = (tab) => { trialsSetTab(tab); trialsRepaint('clientSystem'); return el('tkHost').innerHTML; };
/* Their email system: Conversations, then Emails sent (left open there). */
const openStats = async () => { openTrial(ID); for (let i = 0; i < 4; i++) await tick(); tkOpenSystem(ID, 'conversations'); for (let i = 0; i < 6; i++) await tick(); return screenOf('conversations') + screenOf('sent'); };

test('a client\'s email system (Shared): Conversations (reply type, who answered, when, snippet), and Every email sent (newest first, status pills) — each its own tab; no second Replies list on the Overview', async () => {
  reset(); const calls = []; globalThis.fetch = route(MAP, calls);
  try {
    const h = await openStats();
    assert.ok(calls.some((c) => c.u === base + '/emails?limit=200') && calls.some((c) => c.u === base + '/threads'), 'both asked when Conversations opens');
    const conv = between(h, 'id="tkConvos"', 'id="tkSentMail"'); const ct = visibleText(conv);
    assert.ok(ct.includes('Conversations · 5'));
    assert.ok(conv.includes('<span class="pill tk-rt green">Interested</span>') && conv.includes('<span class="pill tk-rt q">Question</span>') && conv.includes('<span class="pill tk-rt red">Bounced</span>') && conv.includes('<span class="pill tk-rt grey">Not now</span>') && conv.includes('<span class="pill tk-rt red">Unsubscribe</span>'));
    for (const w of ['Reply bot answered', 'Handed to the client', 'You answered', 'Nothing to answer', 'Sounds good — can we talk Thursday?', 'River Dental', 'Bob Stone', '3 emails']) assert.ok(ct.includes(w), w);
    assert.ok(conv.includes('Cobalt &lt;HVAC&gt;') && !conv.includes('Cobalt <HVAC>'), 'escaped');
    assert.ok(conv.indexOf('Cobalt') < conv.indexOf('River Dental') && conv.indexOf('River Dental') < conv.indexOf('Gone Ltd'), 'newest first');
    assert.equal(count(conv, /onclick="openMailThread\(/g), 5, 'every row opens its thread');
    const sent = h.slice(h.indexOf('id="tkSentMail"')); const st = visibleText(sent);
    assert.ok(st.includes('Every email sent · 203') && st.includes('Showing 200 of 203') && sent.includes('>Show more</button>'));
    for (const th of ['When', 'To', 'Company', 'Subject', 'From inbox', 'Status']) assert.ok(sent.includes('<th>' + th + '</th>'), th);
    assert.equal(count(sent, /<tr class="tk-click"/g), 200);
    assert.ok(sent.includes('<span class="pill tk-rt green">Replied</span>') && sent.includes('<span class="pill tk-rt red">Bounced</span>') && sent.includes('<span class="pill tk-rt red">Didn\'t send</span>') && sent.includes('<span class="pill tk-rt grey">Sent</span>'));
    assert.ok(sent.includes('Follow-up') && sent.includes('Cobalt &lt;HVAC&gt;'));
    assert.ok(sent.indexOf('Quick idea for Cobalt') < sent.indexOf('Quick idea for Firm 1'), 'newest first');
    // Conversations: the list only (Messages is the tab beside it); the Overview: the chart, no conversations, no "Replies ·" card
    const cv = screenOf('conversations');
    assert.ok(cv.includes('id="tkConvos"') && !cv.includes('id="tkSentMail"') && !cv.includes('tk-mail-link'));
    assert.ok(cv.includes('onclick="trialsSetTab(&quot;messages&quot;)">Messages</button>'), 'Messages: the tab beside it');
    trialsSetTab('overview'); for (let i = 0; i < 4; i++) await tick();   // their growth history comes in
    const ov = screenOf('overview');
    assert.ok(ov.includes('Emails sent per day') && !ov.includes('id="tkConvos"') && !ov.includes('id="tkSentMail"'));
    assert.ok(!ov.includes('id="tkMyReplies"'), 'Conversations replace the old Replies list');
    // the link: Messages, in the same system
    tkMailToMessages(ID);
    assert.equal(currentView, 'clientSystem'); assert.equal(trialTab, 'messages'); assert.ok(el('content').innerHTML.includes('id="tkSec-messages"'));
    // cached 5 minutes: back to Conversations asks nothing again
    const n = calls.filter((c) => /\/(emails|threads)/.test(c.u)).length; trialsSetTab('conversations'); await tick();
    assert.equal(calls.filter((c) => /\/(emails|threads)/.test(c.u)).length, n, 'not asked again within 5 minutes');
    // My stats keeps its own Replies list and never asks for these
    assert.ok(renderStats({ totals: { sent: 1 }, replies: [] }).includes('id="tkMyReplies"'));
    assert.equal(renderClientMail(detail, 'aviance'), '');
  } finally { offline(); trialsStopTimer(); reset(); }
});

test('Every email sent: "Show more" asks for the next 200 with before=next, adds them below, and stops when there are no more', async () => {
  reset(); const calls = []; globalThis.fetch = route(MAP, calls);
  try {
    await openStats();
    await mailMore(ID);
    const more = calls.filter((c) => c.u.includes('&before='));
    assert.equal(more.length, 1); assert.equal(more[0].u, base + '/emails?limit=200&before=' + encodeURIComponent('2026-10-09T03:00:00.000Z'));
    const sent = between(screenOf('sent'), 'id="tkSentMail"', 'class="tk-mail-link"');
    assert.equal(count(sent, /<tr class="tk-click"/g), 203);
    assert.ok(!sent.includes('Show more') && sent.indexOf('Firm 199') < sent.indexOf('Firm 202'), 'older ones below; no more button');
    await mailMore(ID); assert.equal(calls.filter((c) => c.u.includes('&before=')).length, 1, 'nothing more to ask for');
  } finally { offline(); trialsStopTimer(); reset(); }
});

test('the viewer: a conversation opens like Gmail — subject, each email in order with who sent it, full text escaped with line breaks kept; an email row opens its thread; Close', async () => {
  reset(); const calls = []; globalThis.fetch = route(MAP, calls);
  try {
    await openStats();
    const p = openMailThread(ID, 't1');
    assert.ok(el('modal').innerHTML.includes('Opening the conversation…'), 'a loading state first');
    assert.ok(el('modalWrap').classList.contains('open'));
    await p; const m = el('modal').innerHTML; const t = visibleText(m);
    assert.ok(calls.some((c) => c.u === base + '/threads/t1'));
    assert.ok(m.includes('<h3>Quick idea for Cobalt</h3>') && t.includes('Cobalt HVAC · Bob Stone · bob@cobalt.com · 3 emails'));
    const a = m.indexOf('We fix pipes'), b = m.indexOf('Sounds good'), c = m.indexOf('Thursday works'); assert.ok(a > 0 && a < b && b < c, 'oldest first');
    assert.ok(m.includes('Hi Bob,\n\nWe fix pipes &lt;fast&gt;.\n\nAnn'), 'full text, line breaks kept, escaped');
    assert.ok(!m.includes('<script>') && m.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(m.includes('class="tk-mv-text"'));
    assert.equal(count(m, /class="tk-mv-msg out"/g), 2); assert.equal(count(m, /class="tk-mv-msg in"/g), 1);
    for (const w of ['Us · first email', 'Prospect', 'Reply bot', 'Ann Lee', '<ann@acme-team.com>', 'Bob Stone']) assert.ok(visibleText(m.replace(/&lt;/g, '<').replace(/&gt;/g, '>')).includes(w) || m.includes(w.replace('<', '&lt;').replace('>', '&gt;')), w);
    assert.ok(m.includes('onclick="closeModal()">Close</button>') && m.includes('aria-label="Close"'));
    closeModal(); assert.ok(!el('modalWrap').classList.contains('open'));
    // an email row with a thread: the thread (cached — not asked again)
    const n = calls.length; await openMailEmail(ID, 'e0'); assert.equal(calls.length, n, 'thread cached');
    assert.ok(el('modal').innerHTML.includes('Thursday works'));
    // an email with no thread: what we know about it
    openMailEmail(ID, 'e1'); const one = visibleText(el('modal').innerHTML);
    assert.ok(one.includes('Quick idea for Firm 1') && one.includes('lead1@firm1.com') && one.includes('Bounced'));
  } finally { offline(); trialsStopTimer(); reset(); }
});

test('a system without these yet (404): "This isn\'t available yet", no error page; the viewer says so too', async () => {
  reset(); const calls = []; globalThis.fetch = route({ [base]: detail, [base + '/growth?days=45']: MAP[base + '/growth?days=45'] }, calls);
  try {
    const h = await openStats(); const t = visibleText(h);
    assert.equal(count(t, /This isn't available yet/g), 2, 'both cards say so');
    assert.ok(h.includes('id="tkConvos"') && h.includes('id="tkSentMail"') && !/For your developer/.test(t));
    await openMailThread(ID, 'tX');
    assert.ok(visibleText(el('modal').innerHTML).includes("This isn't available yet"));
  } finally { offline(); trialsStopTimer(); reset(); }
});

test('an employee sees every conversation and every email, and can open them', async () => {
  reset(); asEmployee(); document.body.classList.add('ro');
  const calls = []; globalThis.fetch = route(MAP, calls);
  try {
    const h = await openStats();
    assert.ok(visibleText(h).includes('Conversations · 5') && visibleText(h).includes('Every email sent · 203'));
    await openMailThread(ID, 't1'); assert.ok(el('modal').innerHTML.includes('Thursday works'));
  } finally { offline(); trialsStopTimer(); reset(); }
});

test('Trials: a made-up (test run) trial at step 4 "Sending" shows with its Test tag and the journey', () => {
  reset();
  const demo = Object.assign({}, simpleRows.acme, { id: 'demo-trial', name: 'Maple Test Ltd', demo: true, simple: Object.assign({}, simpleRows.acme.simple, { company: 'Maple Test Ltd', person: 'Tom Demo' }) });
  const hub = Object.assign({}, fullHub, { stages: stagesWith({ live: [demo] }) });
  const h = renderTrialList(hub, {}); const t = visibleText(h);
  assert.ok(h.includes('Maple Test Ltd</span><span class="pill tk-test"'), 'the Test tag');
  assert.ok(t.includes('Step 4 of 5 — Sending emails'), t.slice(0, 400));
});
