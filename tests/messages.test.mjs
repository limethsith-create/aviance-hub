/* Tests for Messages, the reply bot and Google Meet (messages.js + the Calendar's Meet part) —
   email-distributor/docs/REPLYBOT-MEET.md §4. Run with:  npm test   (= node --test tests/*.test.mjs)

   Same set-up as simple.test.mjs: the shell's inline script, then trials.js, inquiries.js, calendar.js,
   messages.js and push.js, exactly like the browser, with a tiny fake DOM and a fake Supabase client.
   The machine is a fake fetch that answers like the contract. No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, simpleRows, simpleHub, stagesWith, ecreekDetail, ecreekConvDetail, conversation, botRuleWords, googleStates, googleErrorCodes, calMeet, calMeetings, calSettingsFixture, CAL_NOW, fullHub, deliveryEntries, unopenedTodo, deliveryAlerts } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM (as in simple.test.mjs) ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, open: false, scrollTop: 0, scrollHeight: 900, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() { el._focused = (el._focused || 0) + 1; }, select() { el._selected = (el._selected || 0) + 1; }, submit() {}, addEventListener() {}, scrollIntoView() { el._scrolled = (el._scrolled || 0) + 1; }, closest() { return null; }, getAttribute() { return null; } };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const clip = { text: null, fail: false };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { if (clip.fail) throw new Error('denied'); clip.text = t; } } }, configurable: true });
globalThis.location = { hash: '', origin: 'https://aviance.store', pathname: '/', search: '', href: 'https://aviance.store/' };
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
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
for (const f of ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'keys.js', 'push.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
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
const row = (base, simple) => Object.assign({}, base, { simple: Object.assign({ person: base.contactName, company: base.name, dayOf30: null, needsYou: false, since: '2026-10-10T00:00:00Z', label: 'x', next: '' }, simple) });
const top = (d) => between(renderTrialDetail(d, 'overview', { now: NOW }), '<section class="card tk-top', '</section>');
const bigButtons = (h) => [...h.matchAll(/<button type="button" class="btn tk-primary" onclick="([^"]*)">([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
/* the page as the owner has it: eCreek with a conversation, nothing else asking for him */
const convPage = (patch) => { const d = clone(ecreekConvDetail); d.row = row(simpleRows.ecreek, { step: 'accepted', needsYou: false, next: 'Nothing for you: we remind them tomorrow', label: 'Accepted' }); d.row.todo = []; d.onboardCall = Object.assign(d.onboardCall, { needsReply: false, status: 'opened' }); return (patch && patch(d)) || d; };
const BANNED = /\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|dns|jwt|config|payload|mission control|cron|redis|endpoint|webhook)\b/i;

/* ───────────── 1. the chat ───────────── */
test('Messages: the whole conversation as a chat — oldest at the top, newest at the bottom; theirs left (grey), ours right (outlined); Sri Lanka time with US Eastern small', () => {
  const h = renderMessages(ecreekConvDetail, { now: NOW });
  assert.ok(h.startsWith('<section class="card tk-msgs" id="tkSec-messages">') && h.includes('<h3>Messages</h3>'));
  assert.ok(h.includes('<div class="tk-chat" id="tkChat" role="region" tabindex="0" aria-label="Emails with Sam, oldest at the top">'));
  // oldest first, whatever order the machine sent
  const order = ['Hi Sam, good news', 'Day 1 is Monday', 'What times work', 'Here is my booking page', 'How much is it after', 'The 30-day trial is free', 'Happy to go through', 'Sam is out today'];
  let last = -1; for (const t of order) { const i = h.indexOf(t); assert.ok(i > last, 'order: ' + t); last = i; }
  // theirs vs ours, as classes (grey on the left / outlined on the right is the CSS below)
  assert.equal(count(h, /<div class="tk-cm in">/g), 3); assert.equal(count(h, /<div class="tk-cm out">/g), 2); assert.equal(count(h, /<div class="tk-cm out auto">/g), 2);
  assert.ok(h.includes('<div class="tk-cm in"><div class="tk-cm-head"><b>Sam wrote</b>'), 'their messages: "Sam wrote"');
  assert.ok(h.includes('<b>ops@ecreek.io wrote</b>'), 'someone else from their side: their address, not "Sam"');
  assert.ok(h.includes('<div class="tk-cm out"><div class="tk-cm-head"><b>You wrote</b>') && h.includes('<b>Acceptance email — sent automatically</b>'));
  // times: Sri Lanka big, US Eastern small — the US day is often the day before
  assert.ok(h.includes('Thu 15 Oct, 7:30 am <small>(US Eastern Wed 10:00 pm)</small>'), 'acceptance: 02:00 UTC');
  assert.ok(h.includes('Fri 16 Oct, 2:30 pm <small>(US Eastern Fri 5:00 am)</small>'), 'their first reply: 09:00 UTC');
  assert.ok(h.includes(`title="${tkFull('2026-10-16T09:00:00Z')}"`), 'the exact time on hover');
  // plain text, escaped, line breaks kept (the CSS keeps them with pre-wrap)
  assert.ok(h.includes('<div class="tk-cm-text">Hi!\nWhat times work for you?\n&lt;script&gt;alert(1)&lt;/script&gt;</div>') && !h.includes('<script>alert(1)'));
  // the subject once, not on every "Re:"
  assert.equal(count(h, /class="tk-cm-subj"/g), 1); assert.ok(h.includes(`<div class="tk-cm-subj">You're in — let's book your onboarding call</div>`));
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  assert.match(css, /\.tk-cm\.in\{align-self:flex-start;background:var\(--surface-2\)/); assert.match(css, /\.tk-cm\.out\{align-self:flex-end;background:var\(--surface\);border:1px solid var\(--border\)\}/);
  assert.match(css, /\.tk-cm-text\{[^}]*white-space:pre-wrap/); assert.match(css, /\.tk-chat\{[^}]*overflow-y:auto/);
});

test('Messages: the reply bot\'s emails say "Auto-reply · …" in plain words, one per rule; automatic emails fold to one line "We sent: …" with "show"', () => {
  const h = renderMessages(ecreekConvDetail);
  assert.ok(h.includes('<div class="tk-cm out auto"><div class="tk-cm-head"><span class="tk-cm-who"><b>Auto-reply</b><span class="tk-cm-rule"> · sent your booking link and free times</span></span>'));
  assert.ok(h.includes('<b>Auto-reply</b><span class="tk-cm-rule"> · explained the trial is free</span>'));
  // every rule, in the owner's words
  for (const [rule, words] of Object.entries(botRuleWords)) {
    const one = renderMsgEntry({ dir: 'out', at: '2026-10-16T09:03:00Z', kind: 'auto_reply', auto: true, rule, text: 'x' }, {});
    assert.ok(one.includes(`<b>Auto-reply</b><span class="tk-cm-rule"> · ${words}</span>`), rule);
    assert.ok(!one.includes(rule), 'no rule name on screen: ' + rule);
  }
  assert.equal(msgRuleText('WANTS_TIME'), 'sent your booking link and free times');
  assert.ok(renderMsgEntry({ dir: 'out', kind: 'auto_reply', rule: null, text: 'x' }, {}).includes('<b>Auto-reply</b></span></div>'), 'no rule: just "Auto-reply"');
  assert.ok(renderMsgEntry({ dir: 'out', kind: 'owner_reply', auto: true, rule: 'reschedule', text: 'x' }, {}).includes(' · sent the booking page to pick another time'), 'auto: true marks it too');
  assert.ok(renderMsgEntry({ dir: 'out', kind: 'auto_reply', rule: '<b>x</b>', text: 'x' }, {}).includes('<b>Auto-reply</b></span></div>'), 'an unknown rule is never printed');
  // system emails: one line, folded, "show" / "hide"
  assert.ok(h.includes('<details class="tk-cm-sys"><summary><span class="tk-cm-sys-t">We sent: Your trial dates</span><span class="tk-cm-show" aria-hidden="true"><span class="tk-cm-open">show</span><span class="tk-cm-close">hide</span></span>'));
  assert.ok(between(h, 'tk-cm-sys', '</details>').includes('<div class="tk-cm-text">Day 1 is Monday 26 October.\nDay 30 is Tuesday 24 November.</div>'), 'the full text when opened');
  assert.ok(!between(h, 'tk-cm-sys', '</details>').includes(' open'), 'folded to begin with');
  assert.ok(renderMsgEntry({ dir: 'out', kind: 'system', text: 'x' }, {}).includes('We sent: an automatic email'));
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  assert.ok(css.includes('.tk-cm-sys[open] .tk-cm-open,.tk-cm-sys:not([open]) .tk-cm-close{display:none}'));
  assert.match(css, /\.tk-cm-sys>summary\{[^}]*min-height:44px/);
});

test('Messages: the reply box ("Send to Sam", 2 000 characters), the waiting line, the reply-bot switch; no inbox → one line; nothing yet; every value escaped', () => {
  const h = renderMessages(ecreekConvDetail);
  assert.ok(h.includes('<p class="tk-msgs-wait">Sam is waiting for your answer.</p>'));
  assert.ok(h.includes('<label for="tkMsgReply">Write to Sam</label>') && h.includes('<textarea id="tkMsgReply" data-tk-form maxlength="2000"') && h.includes('oninput="msgCount(this)"') && h.includes('<span id="tkMsgCount" class="tk-msgs-count">0 / 2000</span>'));
  assert.ok(h.includes('<button type="button" class="btn" onclick="msgSend(&quot;ecreek-it&quot;)">Send to Sam</button>'));
  assert.ok(h.includes('It goes from hello@aviance.store, in the same email thread.'));
  // the switch
  assert.ok(h.includes('<button type="button" class="tk-switch on" role="switch" aria-checked="true" onclick="msgBot(&quot;ecreek-it&quot;,false)">') && h.includes('Reply bot for Sam: <b>On</b>'));
  assert.ok(h.includes('1 of 3 auto-replies sent today.'));
  const off = renderMessages(Object.assign(clone(ecreekConvDetail), { conversation: Object.assign(clone(conversation), { bot: { enabled: false, sentToday: 0, maxPerDay: 3 }, needsReply: false }) }));
  assert.ok(off.includes('aria-checked="false" onclick="msgBot(&quot;ecreek-it&quot;,true)"') && off.includes('Reply bot for Sam: <b>Off</b>') && off.includes('Off: you answer every message from Sam yourself.'));
  assert.ok(!off.includes('tk-msgs-wait'), 'answered: no waiting line');
  // no inbox to send from: one plain line, no box
  const cant = renderMessages(Object.assign(clone(ecreekConvDetail), { conversation: Object.assign(clone(conversation), { canReply: false }) }));
  assert.ok(cant.includes('<p class="tk-msgs-cant">Set up the inbox in Settings to reply from here.</p>') && !cant.includes('<textarea'));
  // nothing yet
  const none = renderMessages({ row: simpleRows.gale, conversation: { thread: [], needsReply: false, canReply: true, bot: null } });
  assert.ok(none.includes('<details class="tk-msgs-fold"><summary><span class="tk-msgs-foldt">Messages</span><span class="tk-msgs-sub">No emails with Mia yet</span></summary>') && !none.includes('tkChat') && !none.includes('tk-switch'), 'nothing yet: one folded line (the reply box inside); no bot data: no switch');
  assert.ok(none.includes('id="tkSec-messages"') && none.includes('<textarea id="tkMsgReply"'), 'still there to write the first email');
  // an older system: the onboarding call's thread, no switch
  const legacy = renderMessages(ecreekDetail);
  assert.ok(legacy.includes('Hi Sam, good news') && legacy.includes('<b>Reminder — sent automatically</b>') && !legacy.includes('tk-switch') && legacy.includes('Send to Sam'));
  // hostile values
  const evil = renderMessages({ row: Object.assign({}, simpleRows.ecreek, { id: 'x");alert(1);("', contactEmail: 'sam@ecreek.io', simple: Object.assign({}, simpleRows.ecreek.simple, { person: '<b>Eve</b> X' }) }),
    conversation: { thread: [{ dir: 'in', at: 'nope', from: '"><img src=x onerror=alert(1)>@x.com', subject: '<u>s</u>', text: '<a href="javascript:alert(3)">x</a>', kind: '<i>k</i>' }, { dir: 'out', kind: 'system', subject: '<svg onload=alert(4)>', text: '</details><script>alert(5)</script>' }, { dir: 'out', kind: 'auto_reply', auto: true, rule: '"><b>r</b>', text: 'y' }],
      needsReply: true, canReply: true, fromInbox: '<b>inbox</b>', bot: { enabled: '"><x', sentToday: '<b>1</b>', maxPerDay: 3 } } });
  assert.ok(!/<img src=x|<u>s<\/u>|<a href="javascript|<svg onload|<script>alert|<b>Eve|<b>inbox|<b>r<\/b>|<i>k<\/i>/.test(evil), 'nothing from the machine is ever HTML');
  assert.ok(evil.includes('&lt;a href=&quot;javascript:alert(3)&quot;&gt;x&lt;/a&gt;') && evil.includes('We sent: &lt;svg onload=alert(4)&gt;') && evil.includes('&lt;b&gt;Eve&lt;/b&gt; is waiting for your answer.'));
  assert.ok(evil.includes('onclick="msgSend(&quot;x\\&quot;);alert(1);(\\&quot;&quot;)"'), 'the id reaches the handler only as a JSON string');
  assert.ok(!BANNED.test(visibleText(h)) && !BANNED.test(visibleText(off)) && !BANNED.test(visibleText(cant)), 'plain words');
});

/* ───────────── 2. the big button and the Trials row ───────────── */
test('needsReply: the big button is "Answer Sam\'s message" (into the reply box); the Trials row says "Sam wrote — answer them" in red, under Needs you', () => {
  // the page
  const waiting = convPage((d) => { d.conversation.needsReply = true; });
  assert.deepEqual(bigButtons(top(waiting)), [["Answer Sam's message", 'tkFocusReply()']]);
  assert.ok(top(waiting).includes('<p class="tk-q-say">Sam wrote to you. Read it under Messages below and write back there.</p>'));
  assert.ok(top(waiting).includes('class="card tk-top needs"') && top(waiting).includes("It's your turn."), 'his turn: the red edge, even before the list catches up');
  const answered = convPage((d) => { d.conversation.needsReply = false; d.onboardCall.needsReply = true; });
  assert.deepEqual(bigButtons(top(answered)), [], 'the conversation says answered (by him or the bot): the old call flag does not win');
  // just answered (by him or the bot): the list's row may still say "they wrote" for a moment — the page trusts the conversation
  const stale = convPage((d) => { d.conversation.needsReply = false; d.row = Object.assign({}, simpleRows.ecreek); });
  assert.equal(tkPrimaryAction(stale, { now: NOW }).kind, 'none');
  assert.ok(top(stale).includes("<p class=\"tk-q-none\">Nothing — we'll tell you when something needs you</p>") && !top(stale).includes('onboarding call box') && !top(stale).includes('tk-top needs'));
  const noName = convPage((d) => { d.row = Object.assign({}, d.row, { contactName: '', simple: Object.assign({}, d.row.simple, { person: '' }) }); });
  assert.deepEqual(bigButtons(top(noName)), [['Answer their message', 'tkFocusReply()']]);
  // a calendar request or a new application still comes first
  const app = convPage((d) => { d.application = Object.assign({}, d.application, { review: 'pending' }); });
  assert.equal(tkPrimaryAction(app, { now: NOW }).kind, 'review');
  // the list: row.simple.needsReply, or the machine's "answer them" to-do
  const r1 = row(simpleRows.acme, { step: 'sending', needsReply: true, needsYou: false, label: 'Sending — day 12 of 30', next: 'Nothing for you: the Friday update goes out today' });
  const r2 = Object.assign(row(simpleRows.gale, { step: 'warming_up', needsReply: false, needsYou: false, label: 'Setting up', next: '' }), { todo: [{ id: 'onboard-reply:gale-roofing', text: 'Answer Mia', urgent: true }] });
  const list = renderTrialList(Object.assign({}, simpleHub, { stages: stagesWith({ live: [r1], build: [r2], onboard: [simpleRows.ecreek] }) }), { now: NOW });
  const needs = between(list, '<h3 class="tk-group red">Needs you</h3>', '<details class="tk-done tk-going"');
  assert.ok(between(needs, 'Acme Plumbing', '</button>').includes('<span class="tk-person-you">Ann wrote — answer them</span>'), 'needsReply puts the row under Needs you, with the red line');
  assert.ok(between(list, 'eCreek IT', '</button>').includes('<span class="tk-person-you">Sam wrote — answer them</span>'), 'the machine\'s reply to-do says the same');
  assert.ok(!between(list, 'Gale Roofing', '</button>').includes('wrote — answer them'), 'an explicit needsReply: false wins over an old to-do');
  assert.equal(tkRowNeedsReply({ todo: [] }), false); assert.equal(tkRowNeedsReply({ needsReply: 1 }), true);
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  assert.match(css, /\.tk-person-you\{[^}]*color:var\(--red\)/);
});

test('the big button goes into the reply box under Messages; with no inbox to send from it goes to Messages, which says why', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner(); trialsIngestHub(simpleHub);
  globalThis.fetch = async (url) => { const u = new URL(url); if (u.pathname.startsWith('/api/mc/hub/')) return ok(ecreekConvDetail)(); if (u.pathname === '/api/mc/hub') return ok(simpleHub)(); return ok({ ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 })(); };
  try {
    tk.detail['ecreek-it'] = clone(ecreekConvDetail); tk.detailAt['ecreek-it'] = Date.now(); openTrial('ecreek-it'); await tick();
    assert.ok(el('content').innerHTML.includes('<div id="tkMsgHost"><section class="card tk-msgs" id="tkSec-messages">'));
    el('tkMsgReply')._focused = 0; el('tkMsgReply')._scrolled = 0; tkFocusReply();
    assert.equal(el('tkMsgReply')._focused, 1); assert.equal(el('tkMsgReply')._scrolled, 1);
    // the newest email in view: the chat box is scrolled to its bottom when the page is drawn
    el('tkChat').scrollTop = 0; el('tkChat').scrollHeight = 1234; trialsRepaint('trial'); assert.equal(el('tkChat').scrollTop, 1234);
    el('tkChat').scrollTop = 0; trialsOnRender('trial'); assert.equal(el('tkChat').scrollTop, 1234);
    // the onboarding card: "See the messages" scrolls to them
    el('tkSec-messages')._scrolled = 0; tkGoTo('messages'); assert.equal(el('tkSec-messages')._scrolled, 1);
    // no textarea on the page → Messages itself
    const real = document.getElementById; document.getElementById = (id) => (id === 'tkMsgReply' ? null : el(id));
    try { el('tkSec-messages')._scrolled = 0; tkFocusReply(); assert.equal(el('tkSec-messages')._scrolled, 1); } finally { document.getElementById = real; }
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 3. reply + bot actions ───────────── */
test('reply and the bot switch post {reply, text} / {botOff} / {botOn} to /messages and redraw Messages and the big button from the answer', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner(); trialsIngestHub(simpleHub);
  const conv = clone(conversation); const calls = []; let refuse = null;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push([init.method, u.pathname, body]);
    if (u.pathname === '/api/mc/clients/ecreek-it/messages') {
      if (refuse) return { ok: false, status: refuse.status, text: async () => JSON.stringify(refuse.body) };
      if (body.action === 'reply') { conv.thread.push({ id: 'n1', dir: 'out', at: '2026-10-17T12:00:00Z', subject: 'Re: x', text: body.text, kind: 'owner_reply', auto: false }); conv.needsReply = false; }
      if (body.action === 'botOff') conv.bot.enabled = false;
      if (body.action === 'botOn') conv.bot.enabled = true;
      return ok({ ok: true, conversation: conv })();
    }
    if (u.pathname === '/api/mc/hub/ecreek-it') return ok(Object.assign(clone(ecreekConvDetail), { conversation: conv }))();
    if (u.pathname === '/api/mc/hub') return ok(simpleHub)();
    return ok({ ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 })();
  };
  const posts = () => calls.filter((c) => c[1].endsWith('/messages'));
  try {
    tk.detail['ecreek-it'] = clone(ecreekConvDetail); tk.detailAt['ecreek-it'] = Date.now(); openTrial('ecreek-it'); await tick();
    // stopped here: empty, too long
    el('tkMsgReply').value = '  '; await msgSend('ecreek-it'); assert.equal(posts().length, 0); assert.ok(el('toast').innerHTML.includes('Write your message first'));
    el('tkMsgReply').value = 'y'.repeat(2001); await msgSend('ecreek-it'); assert.equal(posts().length, 0); assert.ok(el('toast').innerHTML.includes('2000 characters at most (yours is 2001)'));
    // the counter
    msgCount({ value: 'abc' }); assert.equal(el('tkMsgCount').textContent, '3 / 2000');
    msgCount({ value: 'z'.repeat(2001) }); assert.ok(el('tkMsgCount').classList.contains('over'));
    // a real reply: plain text with its line breaks, to /messages
    el('tkMsgReply').value = '  Wednesday works.\nSame time?  '; await msgSend('ecreek-it');
    assert.deepEqual(posts().pop(), ['POST', '/api/mc/clients/ecreek-it/messages', { action: 'reply', text: 'Wednesday works.\nSame time?' }]);
    assert.ok(el('toast').innerHTML.includes('Sent to Sam Test'));
    const msgs = el('tkMsgHost').innerHTML;
    assert.ok(msgs.includes('<b>You wrote</b>') && msgs.includes('Wednesday works.\nSame time?') && !msgs.includes('is waiting for your answer'), 'redrawn from the answer');
    assert.ok(msgs.lastIndexOf('Wednesday works.') > msgs.indexOf('Sam is out today'), 'the newest at the bottom');
    assert.ok(!el('tkTop').outerHTML.includes("Answer Sam's message") && el('tkTop').outerHTML.includes('What do you need to do?'), 'the big button follows at once');
    assert.equal(tk.detail['ecreek-it'].conversation.needsReply, false);
    await tick(); assert.ok(calls.some((c) => c[1] === '/api/mc/hub/ecreek-it') && calls.some((c) => c[1] === '/api/mc/hub'), 'the rest of the page and the list refresh behind it');
    // the switch
    await msgBot('ecreek-it', false);
    assert.deepEqual(posts().pop()[2], { action: 'botOff' }); assert.ok(el('toast').innerHTML.includes('Reply bot is off for Sam Test — you answer every message yourself'));
    assert.ok(el('tkMsgHost').innerHTML.includes('Reply bot for Sam: <b>Off</b>') && el('tkMsgHost').innerHTML.includes('aria-checked="false"'));
    await msgBot('ecreek-it', 'true');
    assert.deepEqual(posts().pop()[2], { action: 'botOn' }); assert.ok(el('toast').innerHTML.includes('Reply bot is on for Sam Test'));
    assert.ok(el('tkMsgHost').innerHTML.includes('Reply bot for Sam: <b>On</b>'));
    // the machine says no: plain words, nothing redrawn, the draft stays
    refuse = { status: 409, body: { ok: false, error: 'No inbox is set up to send from' } };
    el('tkMsgHost').innerHTML = 'UNCHANGED'; el('tkMsgReply').value = 'Keep me';
    await msgSend('ecreek-it');
    assert.ok(el('toast').innerHTML.includes('Not sent: No inbox is set up to send from') && el('tkMsgHost').innerHTML === 'UNCHANGED' && el('tkMsgReply').value === 'Keep me');
    await msgBot('ecreek-it', false); assert.ok(el('toast').innerHTML.includes('Not changed: No inbox is set up to send from'));
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); await tick(); }
});

/* ───────────── 4. the Calendar: Join Google Meet, or why not ───────────── */
test('Calendar: a confirmed call with its Meet gets a big "Join Google Meet" button (safe link, new tab) and a small camera on the grid and the phone list; without one, "No Meet link yet" and why', () => {
  const ST = calSettings(calSettingsFixture);
  const linked = renderCalMeeting(calMeet.linked, ST, { now: CAL_NOW });
  assert.ok(linked.includes('<a class="btn cal-meet" href="https://meet.google.com/xyz-abcd-efg" target="_blank" rel="noopener noreferrer"><svg class="cal-cam"') && linked.includes('</svg>Join Google Meet</a><p class="cal-meet-url">meet.google.com/xyz-abcd-efg</p>'));
  assert.ok(linked.indexOf('cal-when-big') < linked.indexOf('Join Google Meet') && linked.indexOf('Join Google Meet') < linked.indexOf('tk-kv cal-kv'), 'right under the time');
  assert.ok(!linked.includes('Calls happen on') && !linked.includes('No Meet link yet'));
  // not connected: the machine's words, the way to fix it; the email still had his usual link
  const nog = renderCalMeeting(calMeet.noGoogle, ST, { now: CAL_NOW });
  assert.ok(nog.includes('<div class="cal-nomeet"><b>No Meet link yet</b><span>Google isn\'t connected — <button type="button" class="tk-textbtn" onclick="closeModal();openSettings(&quot;google&quot;)">Settings › Google Meet</button>.</span><span>The email had your usual link instead: <a href="https://meet.google.com/abc-defg-hij"'));
  assert.ok(!nog.includes('cal-meet"'));
  // Google is connected but did not answer: no pointer to Settings; no usual link → "send one yourself"
  const STc = calSettings(Object.assign({}, calSettingsFixture, { meetingLink: null, googleMeet: 'connected' }));
  const slow = renderCalMeeting(Object.assign({}, calMeet.noGoogle, { meetError: "Google didn't answer in time" }), STc, { now: CAL_NOW });
  assert.ok(slow.includes("<b>No Meet link yet</b><span>Google didn't answer in time.</span><span>Send them a link yourself, for example from Google Calendar.</span>") && !slow.includes('openSettings'));
  // the machine's words already name Settings › Google Meet: that phrase becomes the button (not said twice)
  const disc = renderCalMeeting(Object.assign({}, calMeet.noGoogle, { meetError: 'Google is disconnected — reconnect it in Settings › Google Meet' }), calSettings(Object.assign({}, calSettingsFixture, { googleMeet: 'broken' })), { now: CAL_NOW });
  assert.ok(disc.includes('Google is disconnected — reconnect it in <button type="button" class="tk-textbtn" onclick="closeModal();openSettings(&quot;google&quot;)">Settings › Google Meet</button>.</span>') && count(disc, /Settings › Google Meet/g) === 1);
  // no reason given: before Google was connected, or Google not set up yet
  const bare = renderCalMeeting(Object.assign({}, calMeet.noGoogle, { meetError: null }), calSettings(Object.assign({}, calSettingsFixture, { meetingLink: null })), { now: CAL_NOW });
  assert.ok(bare.includes('<b>No Meet link yet</b><span>Calls get one when Google is connected — <button') && bare.includes('Send them a link yourself'));
  assert.ok(renderCalMeeting(Object.assign({}, calMeet.noGoogle, { meetError: null }), STc, { now: CAL_NOW }).includes('<span>It was confirmed before Google was connected.</span>'));
  // the reason, for each kind of answer
  const why = (e, g) => calMeetWhy(e, g);
  assert.deepEqual(why("Google isn't connected"), { text: "Google isn't connected", settings: true }, 'words, no Google status: the words decide');
  assert.deepEqual(why("Google isn't connected", 'not_set_up'), { text: "Google isn't connected", settings: true });
  assert.deepEqual(why("Google didn't answer in time", 'connected'), { text: "Google didn't answer in time", settings: false });
  assert.deepEqual(why('The Google Calendar API is not turned on in your Google Cloud project (step 2 of the guide).', 'connected'), { text: 'The Google Calendar API is not turned on in your Google Cloud project (step 2 of the guide)', settings: true }, 'the steps are in Settings');
  assert.deepEqual(why('Google was still making the Meet link', 'connected'), { text: 'Google was still making the Meet link', settings: false });
  assert.deepEqual(why('Google was still making the Meet link', 'broken'), { text: 'Google was still making the Meet link', settings: true }, 'broken now: point at Settings');
  // an older system's bare codes → words
  assert.deepEqual(why('not_connected'), { text: "Google isn't connected", settings: true });
  assert.deepEqual(why('invalid_grant'), { text: 'The Google connection stopped working — connect again', settings: true });
  assert.deepEqual(why('google_disconnected'), { text: 'The Google connection stopped working — connect again', settings: true });
  assert.deepEqual(why('rate_limit'), { text: 'Google was busy and said to try later', settings: false });
  assert.deepEqual(why('timeout'), { text: "Google didn't answer when the call was confirmed", settings: false });
  assert.deepEqual(why('weird_code'), { text: "Google couldn't make one (for your developer: weird_code)", settings: false });
  // hostile: no javascript: link, the reason escaped
  const bad = renderCalMeeting(calMeet.hostile, ST, { now: CAL_NOW });
  assert.ok(!bad.includes('javascript:') && !bad.includes('<img src=x') && bad.includes('&lt;img src=x onerror=alert(2)&gt; went wrong') && bad.includes('No Meet link yet'));
  // only confirmed calls: a request keeps "Calls happen on", a finished call shows nothing about Meet
  const req = renderCalMeeting(calMeetings.req1, ST, { now: CAL_NOW });
  assert.ok(req.includes('<small>Calls happen on</small>') && !req.includes('Meet link yet') && !req.includes('cal-meet'));
  const held = renderCalMeeting(Object.assign({}, calMeetings.held, { meetLink: 'https://meet.google.com/old-link-xyz' }), ST, { now: CAL_NOW });
  assert.ok(!held.includes('Join Google Meet') && !held.includes('No Meet link yet'));
  // the grid and the phone list: a small camera, and the words for a screen reader
  const model = calWeekModel('2026-09-28', [calMeet.linked, calMeet.noGoogle, calMeet.hostile, calMeetings.req1], ST, { now: CAL_NOW });
  const grid = renderCalGrid(model);
  const block = between(grid, 'onclick="calOpenMeeting(&quot;mmeet&quot;)"', '</button>');
  assert.ok(block.includes('<span class="cal-ev-t"><svg class="cal-cam"') && block.includes('aria-hidden="true"'));
  assert.ok(between(grid, 'calOpenMeeting(&quot;mmeet&quot;)', '>').includes('Google Meet link ready.') || grid.includes('Confirmed. Google Meet link ready.'));
  assert.equal(count(grid, /class="cal-cam"/g), 1, 'only the call with a safe link');
  const agenda = renderCalAgenda(model);
  assert.equal(count(agenda, /class="cal-cam"/g), 1); assert.ok(agenda.includes('Confirmed · 30 min · Google Meet'));
  const css = fs.readFileSync(path.join(root, 'calendar.css'), 'utf8');
  assert.match(css, /\.btn\.cal-meet\{[^}]*min-height:52px/); assert.ok(css.includes('.cal-nomeet{') && css.includes('background:var(--amber-bg);color:var(--text)'));
});

/* ───────────── 5. Settings › Google Meet ───────────── */
const gset = (data, extra) => renderGoogleMeetSet(Object.assign({ data }, extra));
test('Settings › Google Meet: the status in words (Not set up / Ready to connect / Connected as … / Broken — connect again) and the buttons each state allows', () => {
  const ns = gset(googleStates.not_set_up);
  assert.equal(ns.state, '<span class="pill grey">Not set up</span>');
  assert.ok(ns.body.includes('<p class="tk-status grey">Not set up yet. Do the steps below once — about 15 minutes, easiest on a computer.'));
  assert.ok(ns.body.includes('<ol class="tk-gm-steps">') && !ns.body.includes('tk-gm-more'), 'not set up: the steps are open');
  assert.ok(!ns.body.includes('googleConnect()') && !ns.body.includes('googleTest()') && !ns.body.includes('googleDisconnect()'));
  const rd = gset(googleStates.ready_to_connect);
  assert.equal(rd.state, '<span class="pill amber">Ready to connect</span>');
  assert.ok(rd.body.includes('Ready to connect. Your Google details are saved — press Connect Google, then Allow.'));
  assert.ok(rd.body.includes('<button type="button" class="btn" onclick="googleConnect()">Connect Google</button>') && !rd.body.includes('googleTest()'));
  assert.ok(rd.body.includes('<details class="tk-gm-more"><summary>The set-up steps, and changing your Google details</summary>'), 'the steps fold away once the details are saved');
  assert.ok(rd.body.includes('Yours are saved (hidden). Paste new ones only if you made a new client.'));
  const cn = gset(googleStates.connected);
  assert.equal(cn.state, '<span class="pill green">Connected</span>');
  assert.ok(cn.body.includes('<p class="tk-status green">Connected as owner@gmail.com. Every call you say yes to gets its own Google Meet link and goes on your Google Calendar.</p>'));
  assert.ok(cn.body.includes('onclick="googleTest()">Test it</button>') && cn.body.includes('<button type="button" class="btn ghost" onclick="googleDisconnect()">Disconnect</button>') && !cn.body.includes('googleConnect()'));
  const br = gset(googleStates.broken);
  assert.equal(br.state, '<span class="pill red">Broken</span>');
  assert.ok(br.body.includes('<p class="tk-status red">Broken — connect again: the connection was removed or has expired. Press Connect Google and allow it again.') && br.body.includes('googleConnect()') && br.body.includes('googleDisconnect()') && !br.body.includes('googleTest()'));
  assert.ok(gset(Object.assign({}, googleStates.broken, { problem: null })).body.includes('Broken — connect again. Google stopped the connection. Press Connect Google'));
  // set up by the developer on the server: nothing to paste; no password lock yet: said plainly
  const env = gset(Object.assign({}, googleStates.ready_to_connect, { clientFrom: 'env' })).body;
  assert.ok(env.includes('Your Client ID and secret were set up by your developer, so there is nothing to paste here.') && !env.includes('gmClientId') && !env.includes('Yours are saved'));
  const lock = gset(Object.assign({}, googleStates.not_set_up, { encKey: false })).body;
  assert.ok(lock.includes("<p class=\"tk-gm-lock\">They can't be saved yet: the password lock isn't set up. (For your developer: ENC_KEY.)</p>") && lock.includes('gmClientId'));
  // the test result
  assert.ok(gset(googleStates.connected, { test: { ok: true, meetLink: 'https://meet.google.com/tst-abcd-efg' } }).body.includes('It works. Google made a test Meet link (<a href="https://meet.google.com/tst-abcd-efg" target="_blank" rel="noopener noreferrer">meet.google.com/tst-abcd-efg</a>) and took it off your calendar again.'));
  assert.ok(gset(googleStates.connected, { test: { ok: false, error: 'insufficient permissions' } }).body.includes("<p class=\"tk-status red\">The test didn't work: insufficient permissions</p>"));
  assert.ok(gset(googleStates.connected, { test: { ok: true, meetLink: 'https://meet.google.com/tst-abcd-efg', removed: false, note: 'Google said 404.' } }).body.includes("(<a href=\"https://meet.google.com/tst-abcd-efg\" target=\"_blank\" rel=\"noopener noreferrer\">meet.google.com/tst-abcd-efg</a>) but couldn't take the test event off your calendar (Google said 404) — delete it there by hand.</p>"));
  assert.ok(!gset(googleStates.connected, { test: { ok: true, meetLink: 'javascript:alert(1)' } }).body.includes('javascript:'), 'the test link only when safe');
  // loading, error, odd status
  assert.ok(renderGoogleMeetSet({}).body.includes('Checking Google…') && renderGoogleMeetSet({}).state === '');
  assert.ok(renderGoogleMeetSet({ err: 'Offline' }).body.includes('Offline <button type="button" class="tk-textbtn" onclick="googleRetry()">Try again</button>'));
  assert.ok(gset({ status: '<b>odd</b>' }).body.includes("We couldn't tell whether Google is connected.") && !gset({ status: '<b>odd</b>' }).body.includes('<b>odd'));
  // hostile account
  assert.ok(!gset(Object.assign({}, googleStates.connected, { account: '<img src=x onerror=alert(1)>' })).body.includes('<img src=x'));
  // plain words
  for (const s of Object.values(googleStates)) assert.ok(!BANNED.test(visibleText(gset(s).body)), s.status + ': ' + (visibleText(gset(s).body).match(BANNED) || [])[0]);
});

test('Settings › Google Meet: the numbered steps for a first-timer, the redirect address with a Copy button, Client ID + secret (a password box) and Save', () => {
  const b = gset(googleStates.not_set_up).body;
  const steps = [...b.matchAll(/<li><b>([^<]+)<\/b>/g)].map((m) => m[1]);
  assert.deepEqual(steps, ['Make a Google Cloud project.', 'Turn on the Google Calendar API.', 'Set up the consent screen.', 'Make the key for the hub.', 'Paste this address', 'Copy the Client ID and the Client secret', 'Press Connect Google', 'Press Test it.']);
  assert.ok(b.includes('Audience: <b>External</b>') && b.includes('Add your own email as the only test user') && b.includes('press <b>Publish app</b> and confirm — otherwise Google stops the connection after 7 days'));
  assert.ok(b.includes('Create credentials › OAuth client ID') && b.includes('Application type: <b>Web application</b>'));
  assert.ok(b.includes('<input id="gmRedirect" class="tk-gm-uri" readonly value="https://email-distributor.vercel.app/api/google/callback"') && b.includes('onclick="googleCopyRedirect()">Copy</button>'));
  assert.ok(b.includes('<input id="gmClientId" data-tk-form autocomplete="off"') && b.includes('<input id="gmClientSecret" data-tk-form type="password" autocomplete="off"') && b.includes('onclick="googleSave()">Save</button>'));
  for (const u of ['https://console.cloud.google.com/projectcreate', 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'https://console.cloud.google.com/apis/credentials/consent', 'https://console.cloud.google.com/apis/credentials'])
    assert.ok(b.includes(`<a href="${u}" target="_blank" rel="noopener noreferrer">`), u);
  assert.ok(b.includes("If Google says the app isn't verified, that's expected for your own app: press Advanced, then Go to Aviance."));
  // no redirectUri from the machine → its own callback address; a hostile one is escaped
  assert.ok(gset({ status: 'not_set_up' }).body.includes('value="https://email-distributor.vercel.app/api/google/callback"'));
  assert.ok(gset({ status: 'not_set_up', redirectUri: '"><script>alert(1)</script>' }).body.includes('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  assert.match(css, /\.tk-gm-uri\{[^}]*min-height:44px[^}]*font-size:var\(--fs-base\)/, '16 px: iPhone does not zoom into it');
});

test('Settings › Google Meet: Save / Connect Google / Test it / Disconnect post the contract bodies; Connect opens only Google; Copy copies the address', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const st = { g: clone(googleStates.not_set_up), connectUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz', test: { ok: true, meetLink: 'https://meet.google.com/tst-abcd-efg' } };
  const calls = []; let asked = null; globalThis.confirm = (q) => { asked = q; return true; };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push([init.method, u.pathname, body]);
    if (u.pathname === '/api/mc/google') {
      if (init.method === 'GET') return ok(st.g)();
      if (body.action === 'saveClient') { st.g = clone(googleStates.ready_to_connect); return ok({ ok: true })(); }
      if (body.action === 'connect') return ok({ url: st.connectUrl })();
      if (body.action === 'test') return st.test.ok ? ok(Object.assign({ removed: true }, st.test))() : { ok: false, status: 502, text: async () => JSON.stringify(st.test) };
      if (body.action === 'disconnect') { st.g = clone(googleStates.ready_to_connect); return ok(Object.assign({ ok: true, revoked: true }, st.g))(); }
    }
    if (u.pathname === '/api/mc/alerts') return ok({ alerts: [] })();
    if (u.pathname === '/api/mc/hub') return ok(fullHub)();
    return ok({ ok: true })();
  };
  const posts = () => calls.filter((c) => c[1] === '/api/mc/google' && c[0] === 'POST');
  const gets = () => calls.filter((c) => c[1] === '/api/mc/google' && c[0] === 'GET').length;
  try {
    render('settings'); await tick();
    assert.equal(gets(), 1, 'opening Settings asks for the Google status once');
    assert.ok(el('tkHost').innerHTML.includes('<span class="tk-set-title">Google Meet</span>') && el('tkHost').innerHTML.includes('<span class="pill grey">Not set up</span>'));
    await trialsTick(); assert.equal(gets(), 1, 'the 60-second refresh does not ask Google again');
    // Save: both boxes needed; trimmed; an odd Client ID asks first
    el('gmClientId').value = ''; el('gmClientSecret').value = 's'; await googleSave(); assert.equal(posts().length, 0); assert.ok(el('toast').innerHTML.includes('Paste the Client ID first'));
    el('gmClientId').value = 'abc.apps.googleusercontent.com'; el('gmClientSecret').value = '  '; await googleSave(); assert.equal(posts().length, 0); assert.ok(el('toast').innerHTML.includes('Paste the Client secret first'));
    el('gmClientId').value = 'not-a-client-id'; el('gmClientSecret').value = 'GOCSPX-1'; asked = null;
    await googleSave(); assert.equal(posts().length, 0); assert.equal(asked, null);
    assert.ok(el('toast').innerHTML.includes('That isn&#39;t the Client ID') || el('toast').innerHTML.includes("That isn't the Client ID — it ends in .apps.googleusercontent.com. Copy it again from Google."));
    el('gmClientId').value = ' 123-abc.apps.googleusercontent.com '; el('gmClientSecret').value = ' GOCSPX-secret '; asked = null; await googleSave();
    assert.deepEqual(posts().pop()[2], { action: 'saveClient', clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
    assert.equal(asked, null, 'saving asks nothing');
    assert.ok(el('toast').innerHTML.includes('Saved. Now press Connect Google.'));
    assert.equal(gets(), 2, 'the status is read again after saving');
    assert.ok(el('tkHost').innerHTML.includes('<span class="pill amber">Ready to connect</span>') && el('tkHost').innerHTML.includes('id="tkSet-google" open'), 'redrawn, the section stays open');
    // Connect: posts {connect} and goes to Google's page — only Google's
    location.href = 'https://aviance.store/'; await googleConnect();
    assert.deepEqual(posts().pop()[2], { action: 'connect' }); assert.equal(location.href, st.connectUrl);
    for (const bad of ['https://evil.example/o/oauth2', 'javascript:alert(1)', 'http://accounts.google.com/x', 'https://google.com.evil.example/']) {
      st.connectUrl = bad; location.href = 'https://aviance.store/'; await googleConnect();
      assert.equal(location.href, 'https://aviance.store/', 'not followed: ' + bad); assert.ok(el('toast').innerHTML.includes("didn&#39;t open it") || el('toast').innerHTML.includes("didn't open it"));
    }
    // Test it: shows the test Meet link, or why not
    st.g = clone(googleStates.connected); await loadGoogle(true);
    await googleTest(); assert.deepEqual(posts().pop()[2], { action: 'test' });
    assert.ok(el('tkHost').innerHTML.includes('It works. Google made a test Meet link') && el('tkHost').innerHTML.includes('meet.google.com/tst-abcd-efg'));
    st.test = { error: 'The Google Calendar API is not turned on in your Google Cloud project (step 2 of the guide).' }; await googleTest();
    assert.ok(el('tkHost').innerHTML.includes("The test didn't work: The Google Calendar API is not turned on in your Google Cloud project (step 2 of the guide).") && el('toast').innerHTML.includes('The test didn'));
    // Disconnect: asks first; no → nothing sent
    globalThis.confirm = (q) => { asked = q; return false; }; const n = posts().length; await googleDisconnect(); assert.equal(posts().length, n);
    assert.equal(asked, "Disconnect Google? Calls you say yes to won't get a Google Meet link until you connect again.");
    globalThis.confirm = () => true; await googleDisconnect(); assert.deepEqual(posts().pop()[2], { action: 'disconnect' });
    assert.ok(el('toast').innerHTML.includes('Google is disconnected') && el('tkHost').innerHTML.includes('<span class="pill amber">Ready to connect</span>'), 'the saved keys stay: ready to connect again');
    // Copy the address
    el('gmRedirect').value = 'https://email-distributor.vercel.app/api/google/callback'; clip.fail = false; googleCopyRedirect(); await tick();
    assert.equal(clip.text, 'https://email-distributor.vercel.app/api/google/callback'); assert.ok(el('toast').innerHTML.includes('Address copied'));
    clip.fail = true; el('gmRedirect')._selected = 0; googleCopyRedirect(); await tick(); assert.equal(el('gmRedirect')._selected, 1, 'could not copy: selected for copying by hand'); clip.fail = false;
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); location.href = 'https://aviance.store/'; }
});

test('back from Google: #settings/google?connected=1 and ?error=… open Settings › Google Meet with a plain message', async () => {
  assert.deepEqual(parseDeepLink('#settings/google?connected=1'), { view: 'settings', section: 'google', google: 'connected' });
  assert.deepEqual(parseDeepLink('https://aviance.store/#settings/google?error=access_denied'), { view: 'settings', section: 'google', google: 'error', error: 'access_denied' });
  assert.deepEqual(parseDeepLink('/#settings/google'), { view: 'settings', section: 'google' });
  assert.deepEqual(parseDeepLink('#settings/google/?connected=true'), { view: 'settings', section: 'google', google: 'connected' });
  for (const bad of ['#settings/googlex', '#settings/google/x', '#settings/alerts', '#google']) assert.equal(parseDeepLink(bad), null, bad);
  // every code the callback can send, in plain words with what to do (never the code itself)
  for (const code of googleErrorCodes) { const t = googleErrorText(code); assert.ok(/press (Connect Google|Save)/i.test(t) && !t.includes(code) && !t.includes('developer'), code + ': ' + t); }
  assert.equal(googleErrorText('access_denied'), googleErrorText('denied'));
  assert.ok(googleErrorText('something_new').endsWith('(For your developer: something_new.)'));
  assert.equal(parseDeepLink('#settings/google?error=' + 'x'.repeat(500)).error.length, 200, 'kept short');
  asOwner(); trialsForget(); calendarForget(); asOwner();
  globalThis.fetch = async (url) => { const u = new URL(url); if (u.pathname === '/api/mc/google') return ok(googleStates.connected)(); if (u.pathname === '/api/mc/alerts') return ok({ alerts: [] })(); if (u.pathname === '/api/mc/hub') return ok(fullHub)(); return ok({ ok: true })(); };
  const go = (h) => { location.hash = h; winListeners.hashchange.forEach((f) => f()); location.hash = ''; };
  try {
    go('#settings/google?connected=1'); await tick();
    assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.google, true);
    const page = el('content').innerHTML + el('tkHost').innerHTML;
    assert.ok(page.includes('<details class="tk-set" id="tkSet-google" open'));
    assert.ok(el('tkHost').innerHTML.includes('<p class="tk-status green">Google is connected. From now on every call you say yes to gets its own Google Meet link.</p>') && el('tkHost').innerHTML.includes('Connected as owner@gmail.com'));
    go('#settings/google?error=denied'); await tick();
    assert.ok(el('tkHost').innerHTML.includes("<p class=\"tk-status red\">Cancel was pressed on Google's page, so Google isn't connected. Press Connect Google again and choose Continue.</p>"));
    go('#settings/google?error=calendar_permission'); await tick();
    assert.ok(el('tkHost').innerHTML.includes("The calendar line wasn't ticked on Google's page. Press Connect Google again and tick it (or Select all)."));
    go('#settings/google?error=%3Cb%3Eoops%3C%2Fb%3E'); await tick();
    assert.ok(el('tkHost').innerHTML.includes("Google didn't connect. Press Connect Google to try again. (For your developer: &lt;b&gt;oops&lt;/b&gt;.)"));
    // signed out: kept until sign-in
    authUser = null; pendingDeepLink = null; assert.equal(goDeepLink(parseDeepLink('#settings/google?connected=1')), false);
    assert.deepEqual(pendingDeepLink, { view: 'settings', section: 'google', google: 'connected' });
    pendingDeepLink = null; asOwner();
    // signing out forgets it
    trialsForget(); assert.equal(googleSettingsCtx().notice, null);
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 6. Settings › Reply bot ───────────── */
test('Settings › Reply bot: what it answers, in plain words; where to switch it off (one person: their page; everyone: Advanced); its state when the system tells', () => {
  const r = renderReplyBotSet({ hub: fullHub, details: { 'ecreek-it': ecreekConvDetail } });
  assert.equal(r.state, '', 'no switch for everyone in the contract: no made-up state');
  const t = visibleText(r.body);
  for (const w of ["They ask when you're free", 'sends your booking link and three free times', 'They suggest a time', 'They need to move the call', 'They ask what it costs', 'explains the 30-day trial is free', 'They ask what to prepare', 'sends the one-page form', "They're not interested", 'They just say thanks', 'nothing — no reply needed'])
    assert.ok(t.includes(w), w);
  assert.ok(t.includes('at most 3 emails a day to one person'), 'the daily limit from the bot data');
  assert.ok(t.includes('To turn it off for one person, use the switch under Messages on their trial page. To turn it off for everyone, or change what it says, open Advanced settings.'));
  assert.ok(r.body.includes('onclick="openMachine(&quot;/mc/config&quot;)">Advanced settings ↗</button>'));
  assert.ok(visibleText(renderReplyBotSet({}).body).includes('only a few emails a day'), 'no bot data: no number');
  const known = renderReplyBotSet({ hub: Object.assign({}, fullHub, { machine: Object.assign({}, fullHub.machine, { replyBot: { enabled: false, maxPerDay: 2 } }) }) });
  assert.equal(known.state, '<span class="pill grey">Off</span>'); assert.ok(known.body.includes('Off for everyone: nobody gets an auto-reply.') && known.body.includes('at most 2 emails'));
  assert.ok(!BANNED.test(t) && !/\b[a-z]+_[a-z_]+\b/.test(t), 'plain words, no rule names');
  // in Settings, between Google Meet and "Is everything running?"
  const s = renderSettings({ hub: fullHub, alerts: [], open: { google: true, replybot: true }, google: { data: googleStates.connected }, now: NOW });
  assert.ok(s.indexOf('id="tkSet-google" open') < s.indexOf('id="tkSet-replybot" open') && s.indexOf('id="tkSet-replybot"') < s.indexOf('id="tkSet-status"'));
  assert.ok(between(s, 'tkSet-google', 'tkSet-replybot').includes('<span class="pill green">Connected</span>'));
  const mine = visibleText(between(s, 'id="tkSet-google"', 'id="tkSet-status"'));
  assert.ok(mine.includes('Google Meet') && mine.includes('Reply bot') && !BANNED.test(mine), 'Google Meet + Reply bot: ' + (mine.match(BANNED) || [])[0]);
});

/* ───────────── 7. files, touch targets ───────────── */
test('files: messages.js is loaded by index.html (after calendar.js, before push.js) and syntax-checked; touch targets are 44 px or more', () => {
  assert.ok(html.indexOf('<script src="calendar.js"></script>') < html.indexOf('<script src="messages.js"></script>') && html.indexOf('<script src="messages.js"></script>') < html.indexOf('<script src="push.js"></script>'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.check.includes('node --check messages.js'));
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  for (const [sel, px] of [['.tk-switch', 44], ['.tk-cm-sys>summary', 44], ['.tk-gm-more>summary', 48], ['.tk-msgs-foot .btn', 46], ['.tk-gm-uri', 44]]) {
    const rule = css.match(new RegExp(sel.replace(/[.>]/g, (c) => '\\' + c) + '\\{([^}]*)\\}'));
    assert.ok(rule && new RegExp('min-height:' + px + 'px').test(rule[1]), sel + ' ≥ ' + px + ' px');
  }
  assert.match(css, /\.tk-msgs-reply textarea\{[^}]*font-size:var\(--fs-strong\)/, '17 px in the reply box (no iPhone zoom)');
  assert.ok(/@media\(max-width:560px\)\{\.tk-msgs\{padding:16px 14px\}/.test(css), 'phone padding');
  assert.ok(!/\.tk-(cm|chat|msgs)[^{]*\{[^}]*(width:\s*\d{3,}px|min-width:\s*\d{3,}px)/.test(css), 'nothing wider than a phone');
});

/* ───────────── 8. how each of our emails went (HUB-API "Delivery monitoring") ───────────── */
const BROKEN = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|Invalid Date/;
const plain = (where, h) => {
  const t = visibleText(h);
  assert.ok(!BROKEN.test(t), where + ': broken value "' + (t.match(new RegExp('.{0,40}(' + BROKEN.source + ').{0,20}')) || [])[0] + '"');
  assert.ok(!BANNED.test(t), where + ': jargon "' + (t.match(BANNED) || [])[0] + '"');
  assert.ok(!/\b[a-z]+_[a-z_]+\b/.test(t), where + ': a code name "' + (t.match(/\b[a-z]+_[a-z_]+\b/) || [])[0] + '"');
};
test('status line: under each of our emails the system\'s own words (statusText) in a small grey line — sent, delivered, not opened yet, opened, replied, and an older date', () => {
  const E = deliveryEntries;
  const line = (m) => renderMsgEntry(m, {});
  assert.ok(line(E.sent).includes('<div class="tk-cm-text">x</div><p class="tk-cm-st">sent Tue 8:10 pm</p></div>'), 'under the email, grey (no tone class)');
  assert.ok(line(E.delivered).includes('<p class="tk-cm-st">delivered</p>'), 'a personal reply (no pixel): "delivered"');
  assert.ok(line(E.opened).includes('<p class="tk-cm-st">delivered · opened Tue 8:10 pm</p>'), 'a milestone that was opened: grey');
  assert.ok(line(E.replied).includes('<p class="tk-cm-st">replied Tue 8:10 pm</p>'));
  assert.ok(line(E.older).includes('<p class="tk-cm-st">delivered · opened Sat 10 Oct, 8:10 pm</p>'));
  // an ordinary email not opened yet is only grey — amber is for an important one after two working days
  assert.ok(line(E.notOpened).includes('<p class="tk-cm-st">delivered · not opened yet</p>'));
  assert.equal(msgStatus(E.notOpened).tone, '');
  // a folded automatic email: the line is in its summary, seen without opening it
  const sys = line(Object.assign({}, E.notOpened, { kind: 'system', subject: 'Your first emails went out' }));
  assert.ok(sys.includes('<span class="tk-cm-sys-t">We sent: Your first emails went out</span>') && between(sys, '<summary>', '</summary>').includes('<span class="tk-cm-st">delivered · not opened yet</span>'));
  // the auto-replies and his own replies too (ours), the "sent automatically" ones too
  assert.ok(line(Object.assign({}, E.delivered, { kind: 'auto_reply', auto: true, rule: 'price' })).includes('<p class="tk-cm-st">delivered</p>'));
  assert.ok(line(Object.assign({}, E.replied, { kind: 'acceptance' })).includes('<b>Acceptance email — sent automatically</b>'));
  for (const [k, m] of Object.entries(E)) plain('status ' + k, line(m));
});

test('status line: a bounce is red with why in plain words; an important email not opened after two working days is amber ("not opened yet")', () => {
  const E = deliveryEntries;
  const b = renderMsgEntry(E.bounced, {});
  assert.ok(b.includes('<p class="tk-cm-st bounced" title="The reason given: 550 5.1.1 &lt;sam@ecreek.io&gt;: Recipient address rejected: User unknown in virtual mailbox table">bounced Tue 7:31 pm<span class="tk-cm-why"> — that email address does not exist</span></p>'), b);
  assert.ok(!visibleText(b).includes('550') && !visibleText(b).includes('Recipient'), 'the returned email\'s own words stay out of sight (the tooltip keeps them)');
  // the reasons, in plain words; anything else is "sent it back"; no reason → nothing after it
  const W = [['550 5.1.1 The email account that you tried to reach does not exist.', 'that email address does not exist'], ['550 No such user here', 'that email address does not exist'], ['552 5.2.2 Mailbox full', 'their mailbox is full'],
    ['550 5.1.2 Host unknown', "that email address's domain does not exist"], ['554 5.7.1 Message rejected as spam', 'their email provider refused it'], ['421 4.4.2 Connection timed out', "their email provider didn't take it"], ['something odd happened', 'their email provider sent it back']];
  for (const [r, w] of W) assert.equal(msgBounceWords(r), w, r);
  assert.equal(msgBounceWords(null), ''); assert.equal(msgBounceWords('  '), '');
  const noWhy = renderMsgEntry(Object.assign({}, E.bounced, { bounceReason: null }), {});
  assert.ok(noWhy.includes('<p class="tk-cm-st bounced">bounced Tue 7:31 pm</p>'), 'no reason: just the red line, no title');
  assert.ok(renderMsgEntry(Object.assign({}, E.bounced, { statusText: null }), {}).includes('<p class="tk-cm-st bounced" title="The reason given: 550'), 'a bounce without its words still shows, red');
  // amber: a milestone with unopenedAt and no openedAt (the "hasn't opened" to-do was raised)
  const u = renderMsgEntry(E.unopened, {});
  assert.ok(between(u, '<summary>', '</summary>').includes('<span class="tk-cm-st unopened">delivered · not opened yet</span>'), u);
  assert.equal(msgStatus(Object.assign({}, E.unopened, { statusText: 'sent Tue 8:10 pm' })).text, 'sent Tue 8:10 pm · not opened yet', '"not opened yet" said once, always');
  assert.equal(msgStatus(Object.assign({}, E.unopened, { openedAt: '2026-10-22T15:00:00Z', status: 'opened', statusText: 'delivered · opened Thu 8:30 pm' })).tone, '', 'opened since: grey');
  assert.equal(msgStatus(Object.assign({}, E.unopened, { milestone: false })).tone, '', 'not a watched email: grey');
  assert.equal(msgStatus(Object.assign({}, E.unopened, { unopenedAt: null })).tone, '', 'not raised yet: grey');
  assert.equal(msgStatus(Object.assign({}, E.unopened, { status: 'replied', repliedAt: '2026-10-22T15:00:00Z', statusText: 'replied Thu 8:30 pm' })).tone, '', 'they wrote back: grey');
  // tones are words, never "red" (red on a page means "needs you" — the alert says that)
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  assert.match(css, /\.tk-cm-st\{[^}]*font-size:var\(--fs-small\)[^}]*color:var\(--muted\)/);
  assert.match(css, /\.tk-cm-st\.bounced\{color:var\(--red\);font-weight:600\}/); assert.match(css, /\.tk-cm-st\.unopened\{color:var\(--amber\);font-weight:600\}/);
  assert.match(css, /\.tk-cm-sys>summary \.tk-cm-at,\.tk-cm-sys>summary \.tk-cm-st\{grid-column:1\/-1\}/, 'on a phone: its own line under the time');
  plain('bounced', b); plain('unopened', u);
});

test('status line: their emails show nothing; older emails without the new fields show nothing — never "undefined" or "null"; every value escaped', () => {
  const E = deliveryEntries;
  assert.ok(!renderMsgEntry(E.theirs, {}).includes('tk-cm-st'), 'theirs: nothing');
  assert.ok(!renderMsgEntry(Object.assign({}, E.theirs, { status: 'delivered', statusText: 'delivered' }), {}).includes('tk-cm-st'), 'theirs, even if a status came with it');
  assert.ok(!renderMsgEntry(E.untracked, {}).includes('tk-cm-st'), 'older data: nothing');
  for (const x of [{ statusText: null }, { statusText: undefined, status: undefined }, { statusText: '' }, { statusText: '   ' }, { statusText: 42 }, { statusText: { a: 1 } }]) {
    const h = renderMsgEntry(Object.assign({}, E.notOpened, x), {});
    assert.ok(!h.includes('tk-cm-st') && !BROKEN.test(visibleText(h)), JSON.stringify(x));
  }
  assert.equal(msgStatus(null), null); assert.equal(msgStatus({ dir: 'in', statusText: 'x' }), null);
  // the old conversation (no status anywhere): Messages is exactly as before
  assert.ok(!renderMessages(ecreekConvDetail).includes('tk-cm-st'));
  // escaped
  const x = renderMsgEntry(Object.assign({}, E.bounced, { statusText: '<img src=x onerror=alert(1)>', bounceReason: '"><script>alert(2)</script>' }), {});
  assert.ok(!x.includes('<img') && !x.includes('<script') && x.includes('&lt;img src=x onerror=alert(1)&gt;') && x.includes('title="The reason given: &quot;&gt;&lt;script&gt;'));
});

test('Messages with delivery: one line under each of our emails (none under theirs), in the conversation order; the onboarding call card sends him to the same Messages', () => {
  const E = deliveryEntries;
  const d = clone(ecreekConvDetail);
  d.conversation.thread = [E.replied, E.theirs, E.delivered, E.bounced, E.unopened, E.untracked, E.opened];
  const h = renderMessages(d);
  assert.equal(count(h, /class="tk-cm-st[ "]/g), 5, 'five of ours carry a status; theirs and the untracked one do not');
  for (const m of [E.replied, E.delivered, E.bounced, E.unopened, E.opened]) assert.ok(h.includes('>' + m.statusText), m.id);
  assert.ok(!between(h, '<div class="tk-cm in">', '</div></div>').includes('tk-cm-st'));
  plain('Messages', h.replace(/<div class="tk-cm-text">[\s\S]*?<\/div>/g, ''));
  // the call cards do not repeat the emails: one conversation, under Messages
  const card = renderOnboardCall(d.onboardCall, d.row, {});
  assert.ok(card.includes('See the messages') && !card.includes('tk-cm-st'));
});

/* ───────────── 9. the "hasn't opened" to-do and its big button ───────────── */
const unopenedPage = () => convPage((d) => {
  const t = unopenedTodo('ecreek-it', 'Sam');
  d.row = row(simpleRows.ecreek, { step: 'sending', dayOf30: 2, needsYou: true, next: t.text, label: 'Sending — day 2 of 30, 0 calls booked' });
  d.row.state = 'sending'; d.row.todo = [t]; d.onboardCall = null;
  d.conversation = Object.assign(clone(conversation), { needsReply: false, thread: conversation.thread.concat([deliveryEntries.unopened]) });
  return d;
});
test('"Sam hasn\'t opened the … email": the big button "I\'ve reached Sam" (red — needs him), the sentence with when it went, the amber line in Messages; the list says it as it is; Behind the scenes says what the button does', () => {
  const d = unopenedPage();
  const act = tkPrimaryAction(d, { now: NOW });
  assert.equal(act.kind, 'todo'); assert.equal(act.todoId, 'unopened:ecreek-it');
  const t = top(d);
  assert.deepEqual(bigButtons(t), [["I've reached Sam", 'trialsTodoAction(&quot;unopened:ecreek-it&quot;)']]);
  assert.ok(visibleText(t).includes("Sam hasn't opened the “we start on” email — call or text them? Sent Tue 20 Oct, 7:30 pm (your time). Once you've reached Sam, press the button — it clears this reminder."), visibleText(t));
  assert.ok(t.startsWith('<section class="card tk-top needs"'), 'red: it needs him');
  const page = renderTrialDetail(d, 'overview', { now: NOW });
  assert.ok(!page.includes('<h3>Also on your list</h3>'), 'the big button — not listed again');
  assert.ok(between(page, 'id="tkSec-messages"', '</section>').includes('<span class="tk-cm-st unopened">delivered · not opened yet</span>'), 'the email itself, in amber');
  // the list: under "Needs you", the machine's own question as the red line (never "You need to: Sam hasn't…")
  const hub = Object.assign(clone(simpleHub), { stages: stagesWith({ live: [d.row] }) });
  const list = renderTrialList(hub, { now: NOW });
  assert.ok(list.includes('<span class="tk-person-you">Sam hasn\'t opened the “we start on” email — call or text them?</span>'), between(list, 'tk-person-you', '</span>'));
  assert.equal(tkYouNeedTo('Sam hasn\'t opened the “we start on” email — call or text them?'), 'Sam hasn\'t opened the “we start on” email — call or text them?');
  assert.equal(tkYouNeedTo('Buy x.com'), 'You need to buy x.com.'); assert.equal(tkYouNeedTo('Something odd'), 'You need to: Something odd.', 'as before');
  // Behind the scenes › Every to-do / "Also on your list": the button says what it does
  assert.equal(tkTodoLabel(d.row.todo[0]), "I've reached them");
  assert.ok(renderTodos([Object.assign({ clientId: 'ecreek-it', clientName: 'eCreek IT' }, d.row.todo[0])]).includes('<button class="btn" onclick="trialsTodoAction(&quot;unopened:ecreek-it&quot;)">I\'ve reached them</button>'));
  assert.equal(tkTodoPrimary(Object.assign({}, d.row.todo[0], { detail: '' }), 'ecreek-it', { row: {} }).label, "I've reached them", 'no name: "them"');
  for (const [w, h] of [['top', t], ['list', list], ['page', page.replace(/<div class="tk-cm-text">[\s\S]*?<\/div>/g, '')]]) plain(w, h);
});

test('"I\'ve reached Sam": asks the to-do\'s own question, posts {action:\'unopenedDone\'} to /messages once, then reads the trial and the list again; "no" sends nothing; from the list, the trial kept from before is read again when opened', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const d = unopenedPage(); const after = clone(d); after.row.todo = []; Object.assign(after.row.simple, { needsYou: false, next: 'Nothing for you: replies come to you as alerts' }); after.conversation.thread = after.conversation.thread.map((m) => (m.id === 'd-unopened' ? Object.assign({}, m, { unopenedAt: null }) : m));
  const hub = Object.assign(clone(simpleHub), { stages: stagesWith({ live: [d.row] }) }); const hubAfter = Object.assign(clone(simpleHub), { stages: stagesWith({ live: [after.row] }) });
  let asked = null; let done = false; const calls = [];
  globalThis.confirm = (q) => { asked = q; return true; };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); calls.push([init.method, u.pathname, init.body ? JSON.parse(init.body) : null]);
    if (u.pathname === '/api/mc/clients/ecreek-it/messages') { done = true; return ok({ ok: true, conversation: after.conversation })(); }
    if (u.pathname === '/api/mc/hub/ecreek-it') return ok(done ? after : d)();
    if (u.pathname === '/api/mc/hub') return ok(done ? hubAfter : hub)();
    return ok({ ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 })();
  };
  try {
    trialsIngestHub(clone(hub)); tk.detail['ecreek-it'] = clone(d); tk.detailAt['ecreek-it'] = Date.now(); openTrial('ecreek-it'); await tick(); calls.length = 0;
    // "no": nothing is sent
    globalThis.confirm = (q) => { asked = q; return false; };
    await trialsTodoAction('unopened:ecreek-it');
    assert.equal(asked, 'Did you reach Sam? This clears the reminder.'); assert.equal(calls.length, 0, 'no → nothing sent');
    // "yes"
    globalThis.confirm = (q) => { asked = q; return true; };
    const r = await trialsTodoAction('unopened:ecreek-it');
    assert.ok(r && r.ok);
    assert.deepEqual(calls[0], ['POST', '/api/mc/clients/ecreek-it/messages', { action: 'unopenedDone' }]);
    assert.equal(calls.filter((c) => c[0] === 'POST').length, 1, 'posted once');
    assert.ok(calls.some((c) => c[0] === 'GET' && c[1] === '/api/mc/hub/ecreek-it') && calls.some((c) => c[0] === 'GET' && c[1] === '/api/mc/hub'), 'the trial and the list read again');
    assert.ok(el('toast').innerHTML.includes('Done — the reminder is cleared'));
    assert.deepEqual(tk.detail['ecreek-it'].row.todo, []); assert.equal(tkPrimaryAction(tk.detail['ecreek-it'], { now: NOW }).kind, 'none', 'the big button goes');
    assert.ok(!el('tkHost').innerHTML.includes("I've reached Sam") && !el('tkHost').innerHTML.includes('tk-cm-st unopened'), 'the page redrawn: no button, no amber');
    // pressed from the list (not on the trial page): the kept trial is read again when he opens it
    render('trials'); await tick(); done = false; trialsIngestHub(clone(hub)); tk.detail['ecreek-it'] = clone(d); tk.detailAt['ecreek-it'] = Date.now(); calls.length = 0;
    await trialsTodoAction('unopened:ecreek-it');
    assert.deepEqual(calls[0], ['POST', '/api/mc/clients/ecreek-it/messages', { action: 'unopenedDone' }]);
    assert.equal(tk.detailAt['ecreek-it'], 0, 'marked to be read again');
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); currentView = 'trials'; trialsForget(); await tick(); }
});

/* ───────────── 10. the new owner alerts ───────────── */
test('alerts: "could not send" and "bounced" are urgent (red, the bell, a to-do that says what to do); "hasn\'t opened" and "check back" are quiet notes — the system\'s own titles, in plain words', () => {
  asOwner(); trialsForget(); asOwner();
  const hub = Object.assign(clone(fullHub), { alerts: clone(deliveryAlerts) });
  trialsIngestHub(hub); tk.alerts = clone(deliveryAlerts);
  const list = renderAlerts(clone(deliveryAlerts), 'open', { now: NOW });
  for (const a of deliveryAlerts) {
    const at = list.indexOf('<b>' + esc(a.title) + '</b>'); assert.ok(at > 0, a.key + ': the title as the system words it');
    const item = list.slice(list.lastIndexOf('<div class="tk-alert ', at), list.indexOf('</div></div>', list.indexOf('tk-alert-act', at)));
    assert.ok(item.includes(a.urgent ? '<span class="pill red">Urgent</span>' : '<span class="pill grey">Note</span>'), a.key + ': ' + (a.urgent ? 'urgent' : 'a note'));
    assert.ok(item.includes('>Ecreek IT</button>') || item.includes('class="tk-client"'), a.key + ': which trial');
    assert.ok(item.includes('>Mark as seen</button>'), a.key);
  }
  plain('Settings › Alerts', list);
  // the bell: only the two urgent ones
  const bell = trialsNotifs().map((x) => x.t);
  assert.ok(bell.includes('Could not send Sam the “we start on” email') && bell.includes('The launch-call invite email to Sam bounced'));
  assert.ok(!bell.some((x) => /hasn't opened|Check back/.test(x)), 'quiet ones stay out of the bell');
  // their to-dos (the usual alert one): what to do, then mark it as seen — on the list, on the page
  const td = (a) => ({ id: 'alert-' + a.id + ':ecreek-it', clientId: 'ecreek-it', text: a.title, urgent: true, action: { type: 'api', method: 'POST', path: '/api/mc/alerts', body: { action: 'ack', id: a.id } } });
  const [failed, bounced, , later] = deliveryAlerts.map(td);
  assert.equal(tkTodoAsk(failed, 'Sam'), 'Reach Sam another way — an email to them could not be sent — then mark it as seen');
  assert.equal(tkTodoAsk(bounced, 'Sam'), "Check Sam's email address — an email to them bounced — then mark it as seen");
  assert.equal(tkTodoAsk(bounced), 'Check their email address — an email to them bounced — then mark it as seen');
  assert.equal(tkTodoAsk(later), 'Check back with Sam — they said not now on Mon 5 Oct — then mark it as seen', 'a title that already says what to do');
  assert.equal(tkTodoAsk({ id: 'x', text: 'Angry reply: Acme', action: { type: 'api', path: '/api/mc/alerts', body: { action: 'ack', id: 'zz' } } }), 'Read the angry reply and mark it as seen', 'the others as before');
  // without the board's alert, the title still tells which it is
  trialsForget(); asOwner();
  assert.equal(tkTodoAsk(failed, 'Sam'), 'Reach Sam another way — an email to them could not be sent — then mark it as seen');
  assert.equal(tkTodoAsk(bounced, 'Sam'), "Check Sam's email address — an email to them bounced — then mark it as seen");
  trialsIngestHub(hub);
  const page = (t, next) => convPage((d) => { d.row = row(simpleRows.ecreek, { step: 'sending', needsYou: true, next, label: 'Sending — day 2 of 30' }); d.row.state = 'sending'; d.row.todo = [t]; d.onboardCall = null; d.conversation = Object.assign(clone(conversation), { needsReply: false }); return d; });
  const f = page(failed, 'Reach Sam another way — an email to them could not be sent — then mark the alert as seen');
  assert.deepEqual(bigButtons(top(f)), [['Mark as seen', 'trialsTodoAction(&quot;alert-a-failed:ecreek-it&quot;)']]);
  assert.ok(visibleText(top(f)).includes('Could not send Sam the “we start on” email. Reach Sam another way — call or text — then mark it as seen.'), visibleText(top(f)));
  const b = page(bounced, "Check Sam's email address — an email to them bounced — then mark the alert as seen");
  assert.ok(visibleText(top(b)).includes("The launch-call invite email to Sam bounced. Check Sam's email address with them, then mark it as seen."), visibleText(top(b)));
  const l = page(later, '');
  assert.ok(visibleText(top(l)).includes('Check back with Sam — they said not now on Mon 5 Oct. Then mark it as seen.'), visibleText(top(l)));
  // the list: the system's next step, as "You need to…" ("reach" is a verb now)
  const rows = Object.assign(clone(simpleHub), { stages: stagesWith({ live: [f.row, Object.assign(clone(b.row), { id: 'b2', name: 'B2' })] }) });
  const lh = renderTrialList(rows, { now: NOW });
  assert.ok(lh.includes('<span class="tk-person-you">You need to reach Sam another way — an email to them could not be sent — then mark the alert as seen.</span>') && lh.includes('<span class="tk-person-you">You need to check Sam\'s email address — an email to them bounced — then mark the alert as seen.</span>'));
  for (const [w, h] of [['failed top', top(f)], ['bounced top', top(b)], ['later top', top(l)], ['list', lh]]) plain(w, h);
  trialsForget();
});

/* ───────────── 11. Settings › Reply bot: the two new answers ───────────── */
test('Settings › Reply bot: "They ask who you are, or how you got their email" and "They say not now, or later" (check back in N weeks — REPLYBOT.laterWeeks from the settings the hub already reads; "a few weeks" without it); the Messages labels for both', () => {
  const t = visibleText(renderReplyBotSet({ hub: fullHub }).body);
  assert.ok(t.includes('They ask who you are, or how you got their email — says honestly how their email reached you (they applied on your website, or wrote through its form) and gives your website. If they came to you another way, it leaves the answer to you.'));
  assert.ok(t.includes("They say not now, or later — says no problem and that you'll check back in a few weeks, and stops the reminders. On that day you get a reminder to check back with them."), 'no settings read: no number made up');
  // GET /api/mc/config: one row per top-level setting (the field inside), or a row per field — both shapes
  const cfg = { settings: [{ key: 'OWNER', default: {}, value: {} }, { key: 'REPLYBOT', default: { enabled: true, maxPerDay: 3, laterWeeks: 4 }, value: { enabled: true, maxPerDay: 3, laterWeeks: 6 }, overridden: true }] };
  assert.ok(visibleText(renderReplyBotSet({ hub: fullHub, config: cfg }).body).includes("you'll check back in 6 weeks, and stops"));
  assert.ok(visibleText(renderReplyBotSet({ config: { settings: [{ key: 'REPLYBOT', default: { laterWeeks: 4 }, value: {} }] } }).body).includes('check back in 4 weeks'), 'unset: its default');
  assert.ok(visibleText(renderReplyBotSet({ config: { settings: [{ key: 'REPLYBOT.laterWeeks', default: 4, value: 1 }] } }).body).includes('check back in 1 week,'), 'a row per field; one week');
  for (const bad of [{ settings: [{ key: 'REPLYBOT', value: { laterWeeks: 'soon' } }] }, { settings: [{ key: 'REPLYBOT', value: { laterWeeks: -2 } }] }, { settings: [] }, null])
    assert.ok(visibleText(renderReplyBotSet({ config: bad }).body).includes('check back in a few weeks'), JSON.stringify(bad));
  assert.equal(msgLaterWeeks({ settings: [{ key: 'REPLYBOT', value: { laterWeeks: 4 } }] }), 4);
  // Settings passes what Your details read (GET /api/mc/config)
  const s = renderSettings({ hub: fullHub, alerts: [], open: { replybot: true }, owner: { data: cfg }, now: NOW });
  assert.ok(visibleText(between(s, 'id="tkSet-replybot"', 'id="tkSet-status"')).includes('check back in 6 weeks'));
  plain('Settings › Reply bot', renderReplyBotSet({ hub: fullHub, config: cfg }).body);
  // in Messages: what the bot did, in the owner's words
  assert.ok(renderMsgEntry({ dir: 'out', kind: 'auto_reply', auto: true, rule: 'who_are_you', text: 'x' }, {}).includes('<b>Auto-reply</b><span class="tk-cm-rule"> · said who you are and how their email reached you</span>'));
  assert.ok(renderMsgEntry({ dir: 'out', kind: 'auto_reply', auto: true, rule: 'later', text: 'x' }, {}).includes("<b>Auto-reply</b><span class=\"tk-cm-rule\"> · they said not now — said you'll check back</span>"));
});
