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
import { NOW, simpleRows, simpleHub, stagesWith, ecreekDetail, ecreekConvDetail, conversation, botRuleWords, googleStates, googleErrorCodes, calMeet, calMeetings, calSettingsFixture, CAL_NOW, fullHub } from './fixtures.mjs';

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
for (const f of ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'push.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
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
  assert.ok(none.includes('<p class="tk-chat-empty">No emails with Mia yet.</p>') && !none.includes('tkChat') && !none.includes('tk-switch'), 'no bot data: no switch');
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
  const needs = between(list, '<h3 class="tk-group red">Needs you</h3>', '<h3 class="tk-group">In progress</h3>');
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
