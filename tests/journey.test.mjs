/* The dress rehearsal: one real applicant's whole trial, step by step, through the REAL hub code.
   The machine (email-distributor) ran a simulated trial through its real routes and saved its hub answers after every
   step — Dana Whitfield of Ridgeline IT applies, is accepted, the reply bot answers, she asks for a call time, the owner
   says yes (Google Meet), the call happens, she signs, the owner buys on CheapInboxes, warm-up waits for helpers, runs,
   Day 1, replies, a booked prospect, her question, a legal hold, Day 15, Day 29, Day 30, converted, paid.
   tests/fixtures/journey/ holds a trimmed copy (tests/journey-fixtures.mjs puts it back together).

   For every step this draws what the owner sees — the Trials list, the top of the trial (Where are they? / What happens
   next? / What do you need to do? + the one big button), Messages, the onboarding call card, Inboxes & domain, Warm-up,
   every Behind-the-scenes tab, the Calendar and Settings where the step has that data — and checks: nothing throws;
   no "undefined", "null", "NaN", "[object Object]" or empty labels; the journey step is the machine's simple.step; the
   big button is what the owner must actually do; "Needs you" and red only when he is needed; plain words; every time
   in Sri Lanka time (the device here is set to US Pacific on purpose) with US Eastern beside a call's time.

   HUB_JOURNEY_REPORT=path npm test  writes a plain-text report of what the owner sees at each step. */
process.env.TZ = 'America/Los_Angeles';   // a device zone that is neither Sri Lanka nor US Eastern: every time must still be his

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJourney } from './journey-fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM + shell, as in simple.test.mjs ───────────── */
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
globalThis.addEventListener = () => {};
const fakeSb = { auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }), getUser: async () => ({ data: { user: null } }), signOut: async () => {} }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
globalThis.supabase = { createClient: () => fakeSb };
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="trials.js">'));
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
for (const f of ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'warmup.js', 'push.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
after(() => { trialsStopTimer(); calendarStopTimer(); });
const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const offline = () => { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; globalThis.confirm = () => true; };

/* ───────────── the journey ───────────── */
const J = loadJourney();
const byStep = (p) => J.find((s) => s.step.startsWith(p));
const ID = 'ridgelineit';

/* One step's world, as the hub would hold it: the board, the trial, the alerts, and the Calendar's last answer (kept from
   the step that saved it — the hub caches it the same way), Settings' answers where the machine saved them. */
const calFor = (s) => { let c = null; for (const x of J) { if (x.extra && x.extra.calendar) c = x.extra.calendar; if (x === s) break; } return c; };
function setUp(s) {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  trialsIngestHub(clone(s.board)); tk.alerts = clone(s.board.alerts || []); tk.alertsAt = Date.now();
  if (s.detail) { tk.detail[ID] = clone(s.detail); tk.detailAt[ID] = Date.now(); currentTrialId = ID; }
  const cc = calFor(s);
  if (cc) { cal.reqs = calRequestsOf(clone(cc)); cal.settings = clone(cc.settings); const wk = calMonday(calDayKey(new Date(s.at), 'Asia/Colombo')); cal.weeks[wk] = clone(cc); cal.weeks['2026-10-05'] = clone(cc); }
  if (s.extra && s.extra.cheapinboxes) abState.s = clone(s.extra.cheapinboxes);
  if (s.extra && s.extra.warmupSettings) wuState.s = clone(s.extra.warmupSettings);
  return new Date(s.at);
}

/* ───────────── reading a screen like the owner ───────────── */
const between = (h, a, b) => { const i = h.indexOf(a); if (i < 0) return ''; const j = b ? h.indexOf(b, i + a.length) : -1; return h.slice(i, j < 0 ? h.length : j); };
const decode = (t) => t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/* What is on the screen: no screen-reader-only words, no hidden "hide" toggles, blocks on their own lines. */
function screenText(h, marks) {
  h = String(h || '').replace(/<span class="tk-bar5"[^>]*>(?:<span[^>]*>[^<]*<\/span>)*<\/span>/g, '').replace(marks ? /<span class="tk-person-go"[^>]*>[^<]*<\/span>/g : /<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, '').replace(/<span class="tk-sr">[\s\S]*?<\/span>/g, '').replace(/<span class="tk-cm-close">hide<\/span>/g, '').replace(/<(script|style|textarea)\b[\s\S]*?<\/\1>/g, ' ');
  h = h.replace(/<wbr>/g, '').replace(/<br\s*\/?>/g, '\n').replace(/<\/?(p|div|h3|h4|li|ol|ul|dt|dd|section|summary|details|blockquote|footer|tr|label|button|a class="btn[^"]*"[^>]*)\b[^>]*>/g, '\n');
  return decode(h.replace(/<[^>]*>/g, ' ')).split('\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(/ ([.,])(?=\s|$)/g, '$1').trim()).filter(Boolean).join('\n');
}
const flat = (h) => screenText(h).replace(/\n/g, ' ');
/* The same, without what the machine wrote INTO emails (clients' words, links): those are not the hub's words. */
const hubText = (h) => flat(String(h || '').replace(/<div class="tk-cm-text">[\s\S]*?<\/div>/g, '').replace(/<div class="tk-cm-subj">[\s\S]*?<\/div>/g, '').replace(/<span class="tk-cm-sys-t">[\s\S]*?<\/span>/g, ''));

const BROKEN = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|Invalid Date/;
const EMPTY = [/<button\b[^>]*>\s*<\/button>/g, /<b>\s*<\/b>/g, /<h[34]\b[^>]*>\s*<\/h[34]>/g, /<label\b[^>]*>\s*<\/label>/g, /<span class="pill[^"]*">\s*<\/span>/g, /<p\b[^>]*>\s*<\/p>/g, /<dt>\s*<\/dt>/g, /<li\b[^>]*>\s*<\/li>/g];
const ODD = [/ · · /, /\(\s*\)/, /:\s+\./, /\s,/, /\.\.(?!\.)/];
/* The old jargon the owner must never meet on the list, at the top of a trial or on its cards (simple.test.mjs). */
const BANNED = /\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|dns|jwt|config|payload|mission control|cron|redis|endpoint|webhook)\b/i;
function clean(where, h) {
  const t = flat(h);
  const bad = t.match(new RegExp('.{0,50}(' + BROKEN.source + ').{0,30}'));
  assert.ok(!bad, where + ': broken value on screen: "' + (bad && bad[0]) + '"');
  for (const re of EMPTY) { const m = String(h).match(re); assert.ok(!m, where + ': an empty label: ' + (m && m[0])); }
  const words = hubText(h);
  for (const re of ODD) { const m = words.match(new RegExp('.{0,40}' + re.source + '.{0,20}')); assert.ok(!m, where + ': odd wording: "' + (m && m[0]) + '"'); }
  assert.ok(!/\d (AM|PM)\b/.test(words), where + ': a time not in the hub\'s style (the device\'s own clock?): ' + (words.match(/.{0,30}\d (AM|PM)\b/) || [])[0]);
}

/* ───────────── the parts of one step ───────────── */
const buttons = (h) => [...h.matchAll(/<button type="button" class="btn tk-primary" onclick="([^"]*)">([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
function drawStep(s) {
  const now = setUp(s);
  const out = { now, list: renderTrialList(tk.hub, { now }), board: renderBoard(tk.hub, { now, sparks: {} }) };
  if (s.detail) {
    const d = tk.detail[ID];
    out.act = tkPrimaryAction(d, { now });
    out.page = renderTrialDetail(d, 'overview', { now });
    out.top = between(out.page, '<section class="card tk-top', '</section>');
    // each part of the page, up to whatever comes after it (a part that is not there is '')
    const ENDS = ['<div id="tkAbHost">', '<div id="tkWuHost">', '<div id="tkOcHost">', 'id="tkSec-application"', '<h3>Also on your list</h3>', '<details class="tk-behind"'];
    const part = (a) => { const i = out.page.indexOf(a); if (i < 0) return ''; const js = ENDS.map((e) => out.page.indexOf(e, i + a.length)).filter((j) => j > 0); return out.page.slice(i, js.length ? Math.min(...js) : out.page.length); };
    out.messages = part('<div id="tkMsgHost">');
    out.autobuy = part('<div id="tkAbHost">');
    out.warmup = part('<div id="tkWuHost">');
    out.call = part('<div id="tkOcHost">');
    out.also = part('<h3>Also on your list</h3>');
    out.front = out.page.slice(0, out.page.indexOf('<details class="tk-behind"'));
    out.tabs = TK_TABS.map(([tab]) => [tab, renderTrialDetail(d, tab, { now, behindOpen: true })]);
    out.buy = renderAutobuyBuy(d);
  }
  const c = s.extra && s.extra.calendar;
  if (c) {
    const st = calSettings(c.settings);
    const weeks = [...new Set([calMonday(calDayKey(now, st.ownerZone)), ...c.meetings.map((m) => calMonday(calDayKey(new Date(m.start), st.ownerZone)))])];
    out.calendar = weeks.map((week) => renderCalendar(clone(c), { now, week }));
    out.meetings = c.meetings.map((m) => renderCalMeeting(clone(m), st, { now }));
  }
  if (!s.detail || (s.extra && (s.extra.cheapinboxes || s.extra.warmupSettings))) {
    out.settings = renderSettings(Object.assign(trialsSettingsCtx(), { open: TK_SETTINGS.reduce((o, k) => ((o[k] = true), o), {}), now }));
  }
  return out;
}

/* What the owner must do at each step (the big button), from the machine's own story of the trial. */
const DO = {
  '00-owner-setup': null,
  '01-applied': ['review', 'Read the application and say yes or no', 'tkGoTo(&quot;application&quot;)'],
  '02-owner-reads': ['review', 'Read the application and say yes or no', 'tkGoTo(&quot;application&quot;)'],
  '03-accepted': ['none'], '04-reply-bot': ['none'],
  '05-time-requested': ['calendar', 'Say yes to their call time', (s) => 'openCalendar(&quot;' + s.detail.onboardCall.meetingId + '&quot;)'],
  '06-call-confirmed': ['none', /^Nothing until the call\. Join it on Tue 6 Oct, 8:30 pm your time\.$/],
  '07-day-before': ['none', /^Nothing until the call\. Join it on Tue 6 Oct, 8:30 pm your time\.$/],
  '08-call-held': ['none'],
  '09-agreement-signed': ['autobuy', 'Buy their domain and 2 inboxes on CheapInboxes', 'abOpenBuy(&quot;ridgelineit&quot;)'],
  '10-purchase-found': ['none'],
  '11-inboxes-connected': ['warmupHelpers', 'Add 6 warm-up helpers', 'openSettings(&quot;warmup&quot;)'],
  '12-helpers-added': ['none'], '13-warming-day-3': ['none'], '14-warming-day-7': ['none'], '15-approval-sent': ['none'], '16-day-1': ['none'],
  '17-replies': ['todo', 'Mark as seen', 'trialsTodoAction(&quot;alert-1792771201000-5rxn4z:ridgelineit&quot;)'],
  '18-prospect-booked': ['none'],
  '19-client-writes': ['reply', "Answer Dana's message", 'tkFocusReply()'],
  '20-owner-answered': ['none'], '21-call-showed': ['none'],
  '22-legal-hold': ['todo', 'Clear the hold and send again', 'trialsTodoAction(&quot;legal:ridgelineit&quot;)'],
  '23-hold-cleared': ['none'], '24-day-15': ['none'], '25-day-29': ['none'],
  '26-day-30': ['none', /^Nothing\. Dana chooses on the decision page — we'll tell you what they pick\.$/],
  '27-converted': ['todo', 'Mark the invoice paid', 'trialsTodoAction(&quot;invoice:ridgelineit&quot;)'],
  '28-paid': ['none', /^Nothing — we'll tell you when something needs you$/],
};

test('the journey: 29 real snapshots, in order, one applicant — each shaped as the machine promised (board + trial)', () => {
  assert.equal(J.length, 29);
  assert.deepEqual(J.map((s) => s.step), Object.keys(DO));
  for (const s of J) {
    assert.ok(s.board && Array.isArray(s.board.stages) && s.board.machine, s.step + ': the board');
    if (s.step === '00-owner-setup') { assert.equal(s.detail, null); continue; }
    assert.equal(s.detail.row.id, ID, s.step);
    const row = tkListRows(s.board).find((r) => r.id === ID);
    assert.ok(row && row.simple, s.step + ': the board row has simple');
    assert.equal(row.simple.step, s.detail.row.simple.step, s.step + ': the board and the trial agree on the step');
  }
});

for (const s of J) {
  test('step ' + s.step + ': ' + s.what.split('. ')[0].slice(0, 90), () => {
    let o;
    assert.doesNotThrow(() => { o = drawStep(s); }, s.step + ': drawing any screen throws');
    // 1. nothing broken, anywhere he can look
    clean(s.step + ' Trials list', o.list);
    clean(s.step + ' Behind the scenes (board)', o.board);
    if (o.settings) clean(s.step + ' Settings', o.settings);
    (o.calendar || []).forEach((h, i) => clean(s.step + ' Calendar week ' + i, h));
    (o.meetings || []).forEach((h, i) => clean(s.step + ' meeting panel ' + i, h));
    if (!s.detail) {
      assert.ok(flat(o.list).includes('No trials yet'), '00: an empty list says so');
      return;
    }
    clean(s.step + ' trial page', o.page);
    for (const [tab, h] of o.tabs) clean(s.step + ' Behind the scenes › ' + tab, h);
    clean(s.step + ' buy panel', o.buy);

    // 2. the journey step is the machine's simple.step
    const sim = s.detail.row.simple;
    const n = TK_STEP_OF[sim.step];
    assert.ok(n >= 1 && n <= 5, s.step + ': a known step (' + sim.step + ')');
    const rowAt = o.list.lastIndexOf('<button type="button" class="tk-person', o.list.indexOf('Ridgeline IT'));
    const rowHtml = o.list.slice(rowAt, o.list.indexOf('</button>', rowAt));
    assert.ok(rowHtml.includes('<span class="tk-person-step">Step ' + n + ' of 5 — ' + TK_STEPS[n - 1]), s.step + ': the list says step ' + n + ' — ' + TK_STEPS[n - 1]);
    assert.equal([...rowHtml.matchAll(/<span class="tk-b5 (\w+)">/g)].map((m) => m[1]).join(','), TK_STEPS.map((_, i) => (i + 1 < n ? 'done' : i + 1 === n ? 'now' : 'todo')).join(','), s.step + ': the small bar');
    assert.ok(new RegExp('<li class="now" aria-current="step"><span class="tk-j-dot" aria-hidden="true">' + n + '</span><span class="tk-j-name">' + TK_STEPS[n - 1] + '</span>').test(o.top), s.step + ': the trial page is at step ' + n);
    if (sim.dayOf30 != null) assert.ok(new RegExp('\\b[Dd]ay ' + sim.dayOf30 + ' of 30\\b').test(flat(o.top)), s.step + ': Day ' + sim.dayOf30 + ' of 30');
    assert.ok(flat(o.top).includes(sim.label), s.step + ': the machine\'s sentence is the big one: ' + sim.label);

    // 3. the big button is what he must actually do
    const want = DO[s.step];
    assert.equal(o.act.kind, want[0], s.step + ': what he must do (' + o.act.kind + ': ' + o.act.label + ')');
    if (want[0] === 'none') {
      assert.deepEqual(buttons(o.top), [], s.step + ': nothing to press');
      if (want[1]) assert.match(o.act.label, want[1], s.step);
    } else {
      const run = typeof want[2] === 'function' ? want[2](s) : want[2];
      assert.deepEqual(buttons(o.top), [[want[1], run]], s.step + ': the one big button');
      assert.ok(o.act.say && !/^You need to: /.test(o.act.say), s.step + ': a plain sentence above the button: ' + o.act.say);
    }
    assert.ok(buttons(o.page).length <= 1, s.step + ': one big button on the page');

    // 4. "Needs you" and red: only when he is needed
    const needs = sim.needsYou || o.act.kind === 'reply' || o.act.kind === 'warmupHelpers';
    const g = tkListGroups(tk.hub);
    assert.equal(g.needs.some((x) => x.row.id === ID), !!sim.needsYou, s.step + ': under "Needs you" exactly when the machine says so');
    assert.equal(o.list.includes('<h3 class="tk-group red">Needs you</h3>'), !!sim.needsYou, s.step + ': the red heading');
    assert.equal(rowHtml.includes('tk-person needs') && rowHtml.includes('class="tk-person-you"'), !!sim.needsYou, s.step + ': the red edge and the red line');
    if (sim.needsYou) assert.match(decode((rowHtml.match(/<span class="tk-person-you">([^<]*)<\/span>/) || [])[1] || ''), sim.needsReply ? /^Dana wrote — answer them$/ : /^You need to [a-z].*\.$/, s.step + ': the red line is an instruction (never "You need to: …")');
    assert.equal(o.top.includes('<section class="card tk-top needs"'), needs, s.step + ': the red edge on the page');
    const reds = [...o.front.matchAll(/class="([^"]*\b(red|late|urgent)\b[^"]*)"/g)].map((m) => m[1]);
    if (!needs) assert.deepEqual(reds, [], s.step + ': no red on a page that needs nothing from him');
    // the big button's to-do (or one of its kind) is never listed again under it, and nothing on this page says "Open the trial"
    const FAMILY = { review: /^review:/, calendar: /^meeting-request:/, reply: /^(message-reply|onboard-reply):/, autobuy: /^buy:/, buy: /^buy:/, warmupHelpers: /^warmup-helpers:/, markHeld: /^onboard-mark:/, nudge: /^onboard-overdue:/ };
    for (const t of s.detail.row.todo || []) {
      const listed = o.also.includes('<b>' + esc(t.text) + '</b>');
      if (listed) assert.ok(!(FAMILY[o.act.kind] && FAMILY[o.act.kind].test(t.id)) && t.id !== o.act.todoId, s.step + ': "' + t.text + '" is the big button — not listed again');
    }
    assert.ok(!o.also.includes('>Open the trial</button>'), s.step + ': "Open the trial" on the trial itself');

    // 5. plain words: the list, the top, the cards (the emails themselves are the clients' words)
    for (const [where, h] of [['list', o.list], ['top', o.top], ['cards', o.autobuy + o.warmup + o.call], ['Messages', o.messages]]) {
      const t = hubText(h);
      assert.ok(!BANNED.test(t), s.step + ' ' + where + ': jargon "' + (t.match(BANNED) || [])[0] + '"');
      assert.ok(!/\bridgelineit\b(?![.@])/.test(t) && !/\b[a-z]+_[a-z_]+\b/.test(t), s.step + ' ' + where + ': an id or a code name');
    }

    // 6. the parts that belong to this step are there
    const emails = ((s.detail.conversation || {}).thread || []).length;
    assert.ok(o.messages.includes(emails ? '<section class="card tk-msgs" id="tkSec-messages">' : '<section class="card tk-msgs tk-msgs-none" id="tkSec-messages"><details class="tk-msgs-fold">'), s.step + ': Messages' + (emails ? '' : ' (no emails yet: one folded line)'));
    assert.equal(!!o.call, !!s.detail.onboardCall, s.step + ': the onboarding call card when there is a call');
    assert.equal(o.warmup.includes('id="tkSec-warmup"'), !!s.detail.warmup, s.step + ': the Warm-up card when there is a warm-up');
  });
}

/* ───────────── the steps that matter most, in detail ───────────── */
test('times: Sri Lanka time everywhere whatever the device is set to (here US Pacific), US Eastern beside a call; one style ("Fri 2 Oct, 1:10 am")', () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/Los_Angeles', 'the device is not in Sri Lanka');
  assert.equal(tkDateTime('2026-10-01T19:40:28Z'), 'Fri 2 Oct, 1:10 am');
  assert.equal(tkDayName('2026-10-07T03:30:00Z'), 'Wed 7 Oct');
  assert.equal(tkDate('2026-10-21'), '21 Oct', 'a bare date is that day, never moved by a zone');
  assert.equal(tkDayName('2026-10-21'), 'Wed 21 Oct');
  assert.equal(tkDateTime('2026-10-21'), 'Wed 21 Oct', 'a bare date has no clock');
  assert.equal(tkFull('2026-10-01T19:40:28Z'), 'Fri 2 Oct 2026, 1:10 am Sri Lanka time');
  assert.deepEqual(tkCallWhen('2026-10-06T15:00:00Z'), { owner: 'Tue 6 Oct, 8:30 pm', us: 'Tue 11:00 am US Eastern', text: 'Tue 6 Oct, 8:30 pm your time (Tue 11:00 am US Eastern)' });
  assert.deepEqual(tkCallWhen('2026-11-04T15:00:00Z').us, 'Wed 10:00 am US Eastern', 'after the US clocks went back (1 November)');
  assert.equal(tkCallWhen('2026-10-21'), null); assert.equal(tkCallWhen(null), null); assert.equal(tkDateTime('nope'), '—');
  // on the screens of the journey
  let o = drawStep(byStep('01'));
  assert.ok(flat(o.page).includes('Sent Fri 2 Oct, 1:10 am your time (28 s ago) from the website.'), 'the application: when, in his time, "ago" from the step (not from today)');
  o = drawStep(byStep('05'));
  assert.ok(flat(o.top).includes('Dana asked for a call on Tue 6 Oct · 8:30 pm your time (Tue 11:00 am US Eastern). Say yes, or suggest another time.'));
  o = drawStep(byStep('06'));
  assert.ok(o.call.includes('The call is on <b>Tue 6 Oct, 8:30 pm your time</b> <span class="tk-oc-us">(Tue 11:00 am US Eastern)</span> — booked through your Calendar'));
  assert.ok(flat(o.top).includes('What happens next? The onboarding call: Tue 6 Oct, 8:30 pm your time (Tue 11:00 am US Eastern).'), '"Nothing for you until the call" → the call itself');
  assert.ok(flat(o.messages).includes('Fri 2 Oct, 8:00 pm (US Eastern Fri 10:30 am)'), 'Messages: both clocks');
  o = drawStep(byStep('03'));
  assert.ok(flat(o.call).includes('Book by Wed 7 Oct') && flat(o.call).includes('First reminder Mon 5 Oct, 6:30 pm if they haven\'t booked.'));
  // the "Mark call booked" picker is his time too
  const want = new Date('2026-10-06T15:00:00Z').getTime();
  assert.equal(tkOwnerInput('2026-10-06T20:30').getTime(), want, 'the picked 8:30 pm is Sri Lanka time, not the device\'s');
  assert.equal(tkOwnerInput('nope'), null);
});

test('01 applied: on the list under "Needs you"; the page asks him to read it in its own words (not "open it"), scrolls to the application, which is open with Say yes / Say no', () => {
  const o = drawStep(byStep('01'));
  assert.ok(flat(o.list).includes('Needs you Ridgeline IT Dana Whitfield Step 1 of 5 — Applied New application — read it and say yes or no You need to open it and press “Say yes” or “Say no”.'));
  assert.equal(o.act.say, 'Dana applied for a trial. Read what they sent and what we found, then say yes or no.', 'on the page itself, never "open it"');
  assert.ok(o.page.includes('<div class="section-head tk-section" id="tkSec-application"><h3>Their application</h3>') && o.page.includes('>Say yes and email them</button>') && o.page.includes('>Say no…</button>'));
  assert.ok(flat(o.page).includes('94 /100') && flat(o.page).includes('Strong fit'), 'the fit score');
  assert.ok(flat(o.messages).includes('The reply bot only answers while they are onboarding. You answer Dana yourself now.'), 'before the acceptance email: the bot is on but not answering');
  assert.ok(o.messages.includes('<summary><span class="tk-msgs-foldt">Messages</span><span class="tk-msgs-sub">No emails with Dana yet</span></summary>'), 'no emails yet: one folded line above the application, not an empty box and a reply form');
  const box = { open: false }; const ta = el('tkMsgReply'); const was = ta.closest; ta.closest = () => box; ta._focused = 0;
  tkFocusReply(); assert.ok(box.open && ta._focused === 1, 'writing to them opens it'); ta.closest = was;
});

test('05 time requested: the big button opens the Calendar at her request; the list links there; the Calendar shows it waiting for his yes in both clocks, with Google Meet', () => {
  const s = byStep('05');
  const o = drawStep(s);
  const mid = s.detail.onboardCall.meetingId;
  assert.ok(o.list.includes(`onclick="openCalendar(&quot;${mid}&quot;)"><span>Open the Calendar to say yes</span>`), 'the list: a way straight there');
  assert.ok(!o.page.includes('cal-trial-ask'), 'said once — the big button');
  assert.ok(!flat(o.call).includes('Book by'), 'she asked for a time: the booking deadline is not the news');
  assert.ok(flat(o.call).includes('The email links your booking page. The time they pick comes to your Calendar for your yes.'), 'the machine sends no link of his own: the booking page (not "reply with times")');
  assert.ok(!flat(o.call).includes('No booking link'));
  assert.ok(!o.call.includes('Mark call booked') && !o.call.includes('Send the first email again') && o.call.includes('Stop the reminder emails'), 'her time waits for his yes in the Calendar: no second way to book it on the card');
  const cal0 = flat(o.calendar[0]);
  assert.ok(cal0.includes('Waiting for your yes 1') && cal0.includes('Tue 6 Oct · 8:30 pm your time Tue 11:00 am US Eastern · 30 min') && cal0.includes('Marcus (our CEO) may join too.'));
  assert.ok(cal0.includes('Calls happen on: Google Meet. Each call you say yes to gets its own link.'), 'Google Meet is connected: never "no meeting link set yet"');
  assert.ok(!cal0.includes('no meeting link set yet'));
  assert.ok(flat(o.meetings[0]).includes('Calls happen on Google Meet — the link is made when you say yes'));
  assert.ok(o.calendar.some((h) => /class="cal-ev requested"[^>]*>/.test(h)), 'on the grid: waiting for his yes');
  const empty = o.calendar.find((h) => h.includes('class="cal-empty"'));
  assert.ok(empty && !empty.includes('cal-anone') && (flat(empty).match(/Nothing booked this week/g) || []).length === 1, 'an empty week says so once (on a phone it said it twice)');
  // pressing it: the Calendar at that request
  trialsTodoAction('meeting-request:ridgelineit');
  assert.equal(currentView, 'calendar'); assert.equal(cal.focus, mid);
  trialsForget(); calendarForget();
});

test('06–08 the call: Google Meet on the page before the call ("Join Google Meet", "See it in the Calendar"); nothing asked; after it, "Call done"; once they are past onboarding the card folds away', () => {
  let o = drawStep(byStep('07'));
  assert.ok(o.call.includes('<a class="btn" href="https://meet.google.com/rdg-001-avc" target="_blank" rel="noopener noreferrer">Join Google Meet</a>'), 'the Calendar knows the Meet link: join from the trial');
  assert.ok(o.call.includes(`onclick="openCalendar(&quot;${byStep('07').detail.onboardCall.meetingId}&quot;)">See it in the Calendar</button>`));
  assert.ok(flat(o.top).includes('Nothing until the call. Join it on Tue 6 Oct, 8:30 pm your time.'));
  o = drawStep(byStep('08'));
  assert.ok(!o.call.includes('Join Google Meet') && flat(o.call).includes('Call done') && flat(o.call).includes('The call was on Tue 6 Oct, 8:30 pm your time'));
  assert.ok(o.call.includes('<section class="card tk-oc"'), 'still onboarding: the card stays open');
  assert.ok(!flat(o.call).includes('booking page'), 'the booking link is old news once the call is booked');
  o = drawStep(byStep('12'));
  assert.ok(o.call.includes('<details class="tk-appbox tk-oc-done" id="tkSec-onboardcall"><summary><span class="tk-appbox-title">Onboarding call</span><span class="pill green">Done</span></summary>'), 'history: one folded line');
});

test('09 buy: the one big button opens "what to buy" on CheapInboxes (the domain, the two inboxes, Open CheapInboxes); no second way in on the page', () => {
  const o = drawStep(byStep('09'));
  assert.equal(o.act.todoId, 'buy:ridgelineit', 'the buy to-do (its section is "autobuy") is the big button');
  assert.ok(!o.page.includes('Also on your list'), 'not listed again below it (with an "Open the trial" button, on the trial itself)');
  assert.ok(flat(o.top).includes('Buy getridgelineit.com and 2 inboxes in your CheapInboxes account. We set up everything after that by ourselves.'));
  assert.equal(o.autobuy.includes('tkSec-autobuy'), false, 'the big button is the way in');
  const b = flat(o.buy);
  assert.ok(b.includes('getridgelineit.com') && b.includes('dana@getridgelineit.com') && b.includes('dana.whitfield@getridgelineit.com') && b.includes('Open CheapInboxes ↗') && b.includes("I've bought it — check now"));
});

test('10–11 inboxes: "Setting up … about 48 hours" with its steps; then ready — and while the warm-up waits for helpers, never "warm-up has started" beside it', () => {
  let o = drawStep(byStep('10'));
  assert.ok(flat(o.autobuy).includes('Setting up getridgelineit.com — about 48 hours') && o.autobuy.includes('<span class="tk-oc-at">Working on it</span>'));
  o = drawStep(byStep('11'));
  const a = flat(o.autobuy);
  assert.ok(a.includes('getridgelineit.com and 2 inboxes are ready — warm-up waits for more helpers'), a);
  assert.ok(!a.includes('warm-up has started') && !a.includes('Warm-up started'), 'the machine says it started; its own warm-up says it waits');
  assert.ok(o.autobuy.includes('<li class="todo"><span class="tk-oc-tick" aria-hidden="true"></span><span><span class="tk-sr">Not yet: </span>Warm-up waits for more helpers</span></li>'));
  const w = flat(o.warmup);
  assert.ok(w.includes('The warm-up circle has 2 of the 8 members it needs — add 6 warm-up helpers in Settings › Warm-up.') && w.includes('It starts by itself as soon as the circle has enough helpers.'));
  assert.equal((o.warmup.match(/<span class="tk-wu-ibx">Waiting for helpers<\/span>/g) || []).length, 2, 'each inbox waits — never "Day 1" before it starts');
  assert.equal((o.page.match(/openSettings\(&quot;warmup&quot;\)/g) || []).length, 1, 'one way to Settings › Warm-up: the big button');
});

test('12–16 warm-up running: the Warm-up card (day N of about 14, how many reach the inbox, when it should be done and — beside it — the first emails), nothing to press; Settings › Warm-up shows the full circle', () => {
  let o = drawStep(byStep('12'));
  assert.ok(flat(o.warmup).includes('Day 1 of about 14') && flat(o.warmup).includes('Warm-up should be done around Tue 20 Oct. First emails: Wed 21 Oct.'), 'two dates, each said for what it is');
  assert.ok(!flat(o.page).includes('Ready to start sending around'));
  const set = flat(between(o.settings, 'id="tkSet-warmup"', 'id="tkSet-replybot"'));
  assert.ok(set.includes('Ready') && set.includes('10 in the warm-up circle — enough (at least 8 needed)') && set.includes('In the circle: 8 helpers · 2 trial inboxes'));
  o = drawStep(byStep('14'));
  assert.ok(o.warmup.includes('aria-valuenow="7"') && flat(o.warmup).includes('Day 7 · 100% reach the inbox'));
  o = drawStep(byStep('16'));
  assert.ok(flat(o.top).includes('Step 4 of 5 — Sending emails') && flat(o.top).includes('Sending — day 1 of 30, 0 calls booked'));
  assert.ok(flat(o.warmup).includes('Warm-up done · 98% reach the inbox') && !flat(o.warmup).includes('should be done around'));
});

test('17 an angry reply: the reply itself at the top, "Mark as seen" (it acknowledges that alert — nothing else); the list says what to do, not the alert\'s title; the bell lists it once', async () => {
  const s = byStep('17');
  const o = drawStep(s);
  assert.ok(flat(o.list).includes('You need to read the angry reply and mark it as seen.'), 'never "You need to: Angry reply: Ridgeline IT."');
  assert.ok(!flat(o.list).includes('You need to:'));
  assert.ok(o.top.includes('<blockquote class="tk-q-quote"><p>“Stop emailing me. How did you get my address?”</p><footer>dina@vancecpa3.com · Fri 23 Oct, 9:15 pm your time</footer></blockquote>'));
  assert.ok(flat(o.top).includes('An angry reply came in. They are off every list already, so there is nothing to answer. Read it, then mark it as seen.'));
  // the bell: the to-do and its alert are one thing
  const bell = trialsNotifs().filter((x) => /Angry reply/i.test(x.t));
  assert.equal(bell.length, 1, 'once, not twice');
  // pressing it: POST /api/mc/alerts {action:'ack', id} — nothing else
  const calls = [];
  globalThis.fetch = async (url, init) => { const u = new URL(url); calls.push([init.method, u.pathname, init.body ? JSON.parse(init.body) : null]); return { ok: true, status: 200, text: async () => JSON.stringify(u.pathname === '/api/mc/hub' ? s.board : u.pathname.startsWith('/api/mc/hub/') ? s.detail : { ok: true }) }; };
  try {
    trialsTodoAction('alert-1792771201000-5rxn4z:ridgelineit'); await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(calls[0], ['POST', '/api/mc/alerts', { action: 'ack', id: '1792771201000-5rxn4z' }]);
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

test('19–20 Dana writes: "Answer Dana\'s message" puts the cursor in the reply box under Messages; her to-do is not listed again; the machine\'s "conversation" section opens Messages; once answered the red goes', () => {
  let o = drawStep(byStep('19'));
  assert.ok(flat(o.list).includes('Dana wrote — answer them'));
  assert.equal(o.also, '', 'no "Also on your list" repeating the big button');
  assert.ok(flat(o.messages).includes('Dana is waiting for your answer.') && flat(o.messages).includes('Hi Limeth — could we add Columbia, SC to the cities next week?'));
  // the machine's to-do points at section "conversation": that is Messages on the page
  currentView = 'trial'; tk.scrollTo = 'conversation'; el('tkSec-messages')._scrolled = 0; trialsApplyScroll();
  assert.equal(el('tkSec-messages')._scrolled, 1, 'section "conversation" → Messages');
  tk.scrollTo = 'onboardCall'; el('tkSec-onboardcall')._scrolled = 0; trialsApplyScroll();
  assert.equal(el('tkSec-onboardcall')._scrolled, 1, 'section "onboardCall" → the onboarding call card');
  o = drawStep(byStep('20'));
  assert.ok(!o.top.includes('tk-top needs') && flat(o.messages).includes('Hi Dana — yes, I will add Columbia from Monday.'));
  currentView = 'trials'; trialsForget();
});

test('22 legal hold: the legal reply itself, then "Clear the hold and send again" — it asks first ("Clear the legal hold and let this client send again?") and posts clearLegalHold; no raw id anywhere', async () => {
  const s = byStep('22');
  const o = drawStep(s);
  assert.ok(flat(o.list).includes('Sending stopped — a prospect replied with a legal threat You need to read the legal reply, then clear the hold.'));
  assert.ok(o.top.includes('<blockquote class="tk-q-quote"><p>“Forwarding this to our attorney. Cease and desist.”</p><footer>alan@nashlaw360.com · Wed 28 Oct, 8:10 pm your time</footer></blockquote>'));
  assert.ok(flat(o.top).includes('A prospect replied with a legal threat, so sending stopped. They are off every list already. Read what they wrote, then clear the hold to start sending again.'));
  // the machine's to-do detail is a reply id: never shown (Behind the scenes, the bell)
  assert.ok(!flat(o.board).includes('re0eea7d9132c5cd6') && !trialsNotifs().some((x) => (x.t + x.s).includes('re0eea7d9132c5cd6')));
  assert.ok(o.board.includes('>Clear the hold</button>'), 'Behind the scenes › Every to-do: the button says what it does');
  let asked = null; const calls = [];
  globalThis.confirm = (q) => { asked = q; return true; };
  globalThis.fetch = async (url, init) => { const u = new URL(url); calls.push([init.method, u.pathname, init.body ? JSON.parse(init.body) : null]); return { ok: true, status: 200, text: async () => JSON.stringify(u.pathname === '/api/mc/hub' ? s.board : u.pathname.startsWith('/api/mc/hub/') ? s.detail : { ok: true }) }; };
  try {
    trialsTodoAction('legal:ridgelineit'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(asked, 'Clear the legal hold and let this client send again?');
    assert.deepEqual(calls[0], ['POST', '/api/mc/clients/ridgelineit', { action: 'clearLegalHold' }]);
    globalThis.confirm = () => false; calls.length = 0;
    trialsTodoAction('legal:ridgelineit'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 0, 'no → nothing sent');
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

test('26 Day 30: "Trial finished — waiting for their decision" stays under In progress (not folded away with the finished ones); the page says the decision is theirs; 27 the invoice, 28 done', () => {
  let o = drawStep(byStep('26'));
  const g = tkListGroups(tk.hub);
  assert.deepEqual([g.needs.length, g.going.length, g.done.length], [0, 1, 0], 'in progress until they decide');
  assert.ok(!o.list.includes('tk-done') || !between(o.list, 'tkDoneGroup').includes('Ridgeline IT'));
  assert.ok(flat(o.top).includes('Trial finished — waiting for their decision') && flat(o.top).includes('What happens next? They choose on their decision page.'));
  o = drawStep(byStep('27'));
  assert.ok(flat(o.top).includes('Their first invoice (Starter, $2,497) went out Fri 20 Nov. When the money lands, mark it paid.'));
  assert.deepEqual(tkListGroups(tk.hub).going.map((x) => x.row.id), [ID], 'the invoice is still to mark paid: in view, not folded under Done');
  assert.ok(flat(o.top).includes("What happens next? Once you've done the step below, we carry on."), 'his step is not repeated as "what happens next"');
  const actions = flat(o.tabs.find(([t]) => t === 'actions')[1]);
  assert.ok(actions.includes('Number AV-202611-ridgelineit Plan Starter Amount $2497.00') && actions.includes('Not paid yet'), 'the invoice as the machine sends it (invoiceNo, plan)');
  o = drawStep(byStep('28'));
  assert.ok(flat(o.list).includes('Done / not taken 1') && flat(o.top).includes('Nothing. This trial is finished.'));
  assert.ok(flat(o.tabs.find(([t]) => t === 'actions')[1]).includes('Paid 24 Nov'));
});

test('"Needs you" first: the journey\'s rows side by side on one list — the ones that need him on top (newest first), then in progress (the Day 30 decision among them), then done', () => {
  const pick = ['01-applied', '05-time-requested', '11-inboxes-connected', '16-day-1', '19-client-writes', '22-legal-hold', '26-day-30', '28-paid'];
  const rows = pick.map((p) => { const r = clone(tkListRows(byStep(p).board).find((x) => x.id === ID)); r.id = 'r' + p.slice(0, 2); r.name = 'Co ' + p.slice(0, 2); r.simple.company = r.name; r.todo = (r.todo || []).map((t) => Object.assign(t, { clientId: r.id })); return r; });
  const board = Object.assign(clone(byStep('28').board), { stages: [{ key: 'all', label: 'All', states: [], clients: rows }] });
  asOwner(); trialsForget(); asOwner(); trialsIngestHub(board);
  const g = tkListGroups(board);
  assert.deepEqual(g.needs.map((x) => x.row.id), ['r22', 'r19', 'r11', 'r05', 'r01'], 'needs you: newest first');
  assert.deepEqual(g.going.map((x) => x.row.id), ['r26', 'r16']);
  assert.deepEqual(g.done.map((x) => x.row.id), ['r28']);
  const out = renderTrialList(board, { now: new Date(byStep('28').at) });
  const at = (t) => out.indexOf(t);
  assert.ok(at('Needs you</h3>') < at('Co 22') && at('Co 01') < at('In progress</h3>') && at('In progress</h3>') < at('Co 26') && at('Co 16') < at('Done / not taken'));
  assert.equal((out.match(/class="tk-person needs"/g) || []).length, 5);
  assert.equal(trialsNavCount(), 5, 'the Trials badge counts them');
  trialsForget();
});

test('Behind the scenes › History: an event\'s detail in words, never raw JSON or "null"', () => {
  assert.equal(tkDetailText({ sendingDay: 0, bounceRate: null, inboxes: [{ email: 'a' }, { email: 'b' }], ok: true }), 'sending day 0 · inboxes 2 items · ok yes');
  assert.equal(tkDetailText('plain words'), 'plain words'); assert.equal(tkDetailText(null), ''); assert.equal(tkDetailText({ a: null }), '');
  const o = drawStep(byStep('14'));
  const h = flat(o.tabs.find(([t]) => t === 'timeline')[1]);
  assert.ok(!h.includes('{"') && !/\bnull\b/.test(h) && h.includes('Caps set'), h.slice(0, 300));
});

test('to-dos: an "api" to-do\'s button says what it does; a detail that is only an id is never shown; the plain "You need to…" for an alert', () => {
  const t = (body, path) => ({ id: 'x', text: 'Angry reply: Acme', action: { type: 'api', method: 'POST', path: path || '/api/mc/clients/acme', body } });
  assert.equal(tkTodoLabel(t({ action: 'ack', id: '1' }, '/api/mc/alerts')), 'Mark as seen');
  assert.equal(tkTodoLabel(t({ action: 'clearLegalHold' })), 'Clear the hold');
  assert.equal(tkTodoLabel(t({ action: 'markPaid' })), 'Mark paid');
  assert.equal(tkTodoLabel(t({ action: 'migrate' }, '/api/mc/setup')), 'Do it', 'anything else: as before');
  assert.equal(tkTodoPrimary(t({ action: 'somethingNew' }), 'acme', {}).label, 'Do it now');
  assert.equal(tkTodoAsk(t({ action: 'ack', ids: ['1', '2'] }, '/api/mc/alerts')), 'Read the angry reply and mark it as seen');
  assert.equal(tkTodoAsk(Object.assign(t({ action: 'ack', id: '1' }, '/api/mc/alerts'), { text: 'Placement low: Acme (3 alerts)' })), 'Read the placement low and mark it as seen');
  assert.equal(tkTodoAsk({ text: 'Buy x.com' }), 'Buy x.com'); assert.equal(tkTodoAsk(null), '');
  const here = renderTodos([{ id: 'message-reply:x', text: 'Answer Dana', urgent: true, action: { type: 'view', view: 'detail', clientId: 'x', section: 'conversation' } }], { hideClient: true, noCount: true });
  assert.ok(here.includes('<button class="btn ghost" onclick="tkGoTo(&quot;conversation&quot;)">Show me</button>') && !here.includes('Open the trial'), 'on the trial page: a to-do about a part of it scrolls there');
  assert.ok(renderTodos([{ id: 'message-reply:x', clientId: 'x', text: 'Answer Dana', action: { type: 'view', view: 'detail', clientId: 'x', section: 'conversation' } }]).includes('>Open the trial</button>'), 'elsewhere: open the trial');
  assert.equal(tkTodoDetail({ detail: 're0eea7d9132c5cd6' }), ''); assert.equal(tkTodoDetail({ detail: 'They wrote 18 min ago' }), 'They wrote 18 min ago'); assert.equal(tkTodoDetail({ detail: 'getridgelineit.com' }), 'getridgelineit.com');
});

test('Messages: the reply bot switch says the truth — on, but only answering while they are onboarding', () => {
  let o = drawStep(byStep('04'));
  assert.ok(flat(o.messages).includes('Reply bot for Dana: On It answers the simple questions for you'), 'onboarding: it answers');
  assert.ok(o.messages.includes('Auto-reply</b><span class="tk-cm-rule"> · sent your booking link and free times</span>'));
  o = drawStep(byStep('16'));
  assert.ok(flat(o.messages).includes('Reply bot for Dana: On The reply bot only answers while they are onboarding. You answer Dana yourself now.'));
  assert.ok(!flat(o.messages).includes('It answers the simple questions for you') && !flat(o.messages).includes('auto-replies sent today'));
});

test('Settings on the journey: 00 the first setup (the automatic check-in is not running yet), 10 CheapInboxes connected, 12 the warm-up circle full', () => {
  let o = drawStep(byStep('00'));
  const run = flat(between(o.settings, 'id="tkSet-status"', 'id="tkSet-behind"'));
  assert.ok(run.includes("Not yet. The automatic check-in isn't running yet."));
  assert.ok(flat(between(o.settings, 'id="tkSet-alerts"', 'id="tkSet-phone"')).includes('No new alerts. Nothing needs you.'));
  o = drawStep(byStep('10'));
  const ib = flat(between(o.settings, 'id="tkSet-inboxes"', 'id="tkSet-warmup"'));
  assert.ok(ib.includes('Connected') && ib.includes('Connected as Aviance Outreach') && ib.includes('A card is on file.'));
  const al = flat(between(o.settings, 'id="tkSet-alerts"', 'id="tkSet-phone"'));
  assert.ok(al.includes('We found getridgelineit.com — connecting it to Ridgeline IT'));
});

test('on a phone (checked at iPhone width in a browser for steps 01, 05 and 26): no empty Messages box above a new application, automatic emails in two lines, the reply to read set apart', () => {
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  const phone = css.slice(css.indexOf('@media(max-width:560px){.tk-msgs{'));
  assert.match(phone, /^@media\(max-width:560px\)\{[^@]*\.tk-cm-sys>summary\{display:grid;grid-template-columns:minmax\(0,1fr\) auto;/, 'subject + "show" on one line, the time under it');
  assert.match(css, /\.tk-msgs-fold>summary\{[^}]*min-height:44px/, 'the folded Messages line is a 44 px target');
  assert.match(css, /\.tk-q-quote\{[^}]*border-left:3px solid var\(--border\)/, 'the quoted reply is set apart — not red: the words above it carry the red');
  assert.ok(!/\.tk-q-quote[^{]*\{[^}]*--red/.test(css));
});

/* ───────────── the report: what the owner sees, step by step ───────────── */
const CIRCLED = ['①', '②', '③', '④', '⑤'];
function journeyLine(row) {
  const j = tkStep(row);
  if (j.notTaken) return 'Not taken';
  return TK_STEPS.map((name, i) => (i + 1 < j.n ? CIRCLED[i] + ' ' + name + ' ✓' : i + 1 === j.n ? '[' + CIRCLED[i] + ' ' + name + ']' : CIRCLED[i] + ' ' + name)).join(' · ');
}
const indent = (t, n) => screenText(t, true).split('\n').map((l) => ' '.repeat(n) + l).join('\n');
function messagesSummary(h) {
  if (h.includes('class="tk-msgs-fold"')) return '    (one folded line) ' + flat(between(h, '<span class="tk-msgs-sub">', '</span>'));
  const items = [...h.matchAll(/<div class="tk-cm (in|out)[^"]*"><div class="tk-cm-head">([\s\S]*?)<\/div>[\s\S]*?<div class="tk-cm-text">([\s\S]*?)<\/div><\/div>|<details class="tk-cm-sys"><summary>([\s\S]*?)<\/summary>/g)];
  const lines = items.map((m) => (m[4] ? flat(m[4]).replace(/ show /, ' ') : flat(m[2]) + ' — “' + decode(m[3]).replace(/\s+/g, ' ').trim().slice(0, 90) + (decode(m[3]).length > 90 ? '…' : '') + '”'));
  const rest = flat(between(h, '<p class="tk-msgs-wait">') ? h.slice(h.indexOf('<p class="tk-msgs-wait">')) : h.slice(h.indexOf('<div class="tk-msgs-reply">')));
  return '    ' + (lines.length ? lines.length + ' email' + (lines.length === 1 ? '' : 's') + ', newest last:' : 'No emails yet.') + '\n' +
    lines.slice(-4).map((l) => '      · ' + l).join('\n') + (lines.length ? '\n' : '') + '    ' + rest.replace(/0 \/ 2000 /, '').replace(/ Send to Dana/, ' [Send to Dana]');
}
function stepReport(s) {
  const o = drawStep(s);
  const when = tkFull(s.at);
  const out = ['', '━━ ' + s.step + ' — ' + when, '   ' + s.what, '', 'TRIALS LIST'];
  out.push(indent(o.list.replace(/<span class="tk-bar5"[\s\S]*?<\/span><\/span>/g, ''), 4));
  if (s.detail) {
    const row = s.detail.row;
    out.push('', 'TRIAL PAGE — ' + row.name);
    out.push('  Where are they?      ' + journeyLine(row));
    out.push('                       ' + flat(between(o.top, '<p class="tk-q-big">', '</p>')) + (o.top.includes('tk-q-day') ? ' · ' + flat(between(o.top, '<p class="tk-q-day">', '</p>')) : ''));
    out.push('  What happens next?   ' + flat(between(o.top, '<p class="tk-q-text">', '</p>')));
    const you = between(o.top, '<div class="tk-q tk-q-you">', '</section>');
    const btn = buttons(o.top)[0];
    out.push('  What do you need to do? ' + (o.act.kind === 'none' ? o.act.label : o.act.say));
    if (o.act.quote) out.push('                       “' + o.act.quote.text + '” — ' + [o.act.quote.who, o.act.quote.at ? tkDateTime(o.act.quote.at) : ''].filter(Boolean).join(', '));
    if (btn) out.push('                       [ ' + btn[0] + ' ]' + (o.top.includes('class="card tk-top needs"') ? '   (red: needs you)' : ''));
    else if (!you) out.push('                       —');
    out.push('  Messages');
    out.push(messagesSummary(o.messages));
    if (o.autobuy.includes('tkSec-autobuy')) out.push('  Inboxes & domain', indent(between(o.autobuy, '<p class="tk-ab-say">', '</section>'), 4));
    if (o.warmup.includes('tkSec-warmup')) out.push('  Warm-up', indent(between(o.warmup, '<h3>Warm-up</h3>', '</section>').replace('<h3>Warm-up</h3>', ''), 4));
    if (o.call) out.push('  Onboarding call' + (o.call.includes('tk-oc-done') ? ' (folded: ' + flat(between(o.call, '<span class="pill', '</span>').replace(/^[^>]*>/, '')) + ')' : ''), o.call.includes('tk-oc-done') ? '' : indent(between(o.call, '<h3>Onboarding call</h3>', '<h4>Update the call</h4>').replace('<h3>Onboarding call</h3>', '') || between(o.call, '<h3>Onboarding call</h3>'), 4));
    if (o.also) out.push('  Also on your list', indent(o.also.replace('<h3>Also on your list</h3>', ''), 4));
  }
  if (o.calendar) {
    out.push('', 'CALENDAR');
    out.push(indent(between(o.calendar[0], '<div class="cal-intro">', '<div class="section-head tk-section cal-week-head">'), 4));
    o.calendar.forEach((h) => {
      const days = [...between(h, '<div class="cal-agenda">', '<div class="cal-foot">').matchAll(/<section class="cal-aday[^"]*">([\s\S]*?)<\/section>/g)].map((m) => flat(m[1])).filter((t) => !/Nothing booked/.test(t));
      out.push('    Week of ' + flat(between(h, '<b class="cal-range">', '</b>')) + ': ' + (days.length ? days.join(' | ') : 'nothing booked'));
    });
  }
  if (o.settings) {
    out.push('', 'SETTINGS');
    const secs = s.step === '00-owner-setup' ? [['alerts', 'phone'], ['status', 'behind']] : s.extra.cheapinboxes ? [['inboxes', 'warmup']] : [['warmup', 'replybot']];
    for (const [a, b] of secs) out.push(indent(between(o.settings, 'id="tkSet-' + a + '"', '<details class="tk-set" id="tkSet-' + b + '"').replace(/^[^>]*>/, '').replace(/<div class="tk-wu-add"[\s\S]*$/, '').replace(/<details class="tk-ab-how"[\s\S]*$/, ''), 4).split('\n').slice(0, 14).join('\n'));
  }
  return out.join('\n');
}

test('the step-by-step screen report (written when HUB_JOURNEY_REPORT=path is set)', () => {
  const text = ['AVIANCE HUB — what the owner sees at every step of one real trial', 'Times are Sri Lanka time (the hub shows US Eastern beside call times).', 'Generated by tests/journey.test.mjs from the machine\'s snapshots in tests/fixtures/journey/.']
    .concat(J.map(stepReport)).join('\n') + '\n';
  assert.ok(text.includes('━━ 26-day-30') && !BROKEN.test(text.replace(/[\w.-]*null[\w.-]*@/g, '')), 'the report reads cleanly');
  const to = process.env.HUB_JOURNEY_REPORT;
  if (to) { fs.mkdirSync(path.dirname(path.resolve(to)), { recursive: true }); fs.writeFileSync(to, text); }
});
