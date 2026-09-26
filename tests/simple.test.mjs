/* Tests for the simplicity pass: four places only, one journey everywhere, "Needs you" first,
   three plain questions on a trial with ONE big button, Settings for everything else, plain words.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Same set-up as trials.test.mjs / calendar.test.mjs: the shell's inline script, then trials.js,
   inquiries.js, calendar.js and push.js, exactly like the browser, with a tiny fake DOM and a fake
   Supabase client. No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, acme, bright, fullHub, simpleRows, simpleHub, stagesWith, onboardCall, ecreekDetail, ecreekConvDetail, fernDetail, detail, inquirySummaryOf, inquiryRecords, calWeek, calSettingsFixture, CAL_NOW } from './fixtures.mjs';

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
const FILES = ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'warmup.js', 'push.js'];
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
const row = (base, simple) => Object.assign({}, base, { simple: Object.assign({ person: base.contactName, company: base.name, dayOf30: null, needsYou: false, since: '2026-10-10T00:00:00Z', label: 'x', next: '' }, simple) });
const top = (d, meta) => between(renderTrialDetail(d, 'overview', Object.assign({ now: NOW }, meta)), '<section class="card tk-top', '</section>');

/* The words the owner must never meet on the Trials list or at the top of a trial (the old jargon). */
const BANNED = /\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|dns|jwt|config|payload|mission control|cron|redis|endpoint|webhook)\b/i;

/* ───────────── 1. four places only ───────────── */
test('navigation: four places only — Trials, Calendar, Inquiries, Settings — the same in the sidebar and the phone tab bar', () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  assert.deepEqual(navItems().map((i) => [i.view, i.label]), [['trials', 'Trials'], ['calendar', 'Calendar'], ['inquiries', 'Inquiries'], ['settings', 'Settings']]);
  render('trials');
  for (const id of ['navArea', 'tabBar']) {
    const nav = el(id).innerHTML;
    assert.equal(count(nav, /<button class="(nav-item|tab)/g), 4, id + ': four buttons');
    assert.ok(!/Machine|Behind the scenes|Phone alerts|Mission Control|Log out|alerts/i.test(visibleText(nav)), id + ': nothing else in the navigation');
    assert.ok(nav.includes(`<button class="${id === 'navArea' ? 'nav-item' : 'tab'} active" type="button" onclick="render('trials')" aria-label="Trials" aria-current="page">`), id + ': Trials is the current place');
  }
  // pages inside a place light up their place
  for (const [view, place] of [['trial', 'trials'], ['trialPurchase', 'trials'], ['inquiry', 'inquiries'], ['trialsBoard', 'settings']]) assert.ok(navItems().find((i) => i.view === place && (i.also || []).includes(view)), view + ' belongs to ' + place);
  // the phone: a tab bar at the bottom, no sidebar, no hamburger; every tab at least 44 px tall
  const shellCss = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const phone = between(shellCss, '@media(max-width:860px){', '@media(max-width:560px)');
  assert.ok(phone.includes('.sidebar{display:none}') && phone.includes('.tabbar{display:flex;'), 'on a phone: the tab bar instead of the sidebar');
  assert.match(shellCss, /\.tabbar\{display:flex;/);
  assert.match(shellCss, /\.tab\{[^}]*min-height:58px/); assert.match(shellCss, /\.nav-item\{[^}]*min-height:48px/); assert.match(shellCss, /\.btn\{[^}]*min-height:44px/);
  assert.ok(!html.includes('hamburger"') && !html.includes('id="newClientBtn"') && !html.includes('id="themeBtn"'), 'the top bar is only the title, Find (computer) and the bell');
});

test('navigation badges: Trials = how many need you (red) · Calendar = call times waiting for your yes (amber) · Inquiries = new ones (red) · Settings has none', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  trialsIngestHub(Object.assign({}, simpleHub, { inquiries: inquirySummaryOf(inquiryRecords) }));
  cal.reqs = calRequestsOf(calWeek);
  const items = navItems();
  assert.deepEqual(items.map((i) => [i.badge, i.tone || '', i.badgeTitle || '']), [[3, 'red', '3 need you'], [2, 'amber', '2 waiting for your yes'], [2, 'red', '2 new'], ['', '', '']]);
  renderNav();
  const nav = el('tabBar').innerHTML;
  assert.ok(nav.includes('<span class="badge red" title="3 need you" aria-hidden="true">3</span>'));
  assert.ok(nav.includes('<span class="badge amber" title="2 waiting for your yes" aria-hidden="true">2</span>'));
  assert.ok(nav.includes('<span class="badge red" title="2 new" aria-hidden="true">2</span>'));
  assert.ok(nav.includes('aria-label="Calendar — 2 waiting for your yes"'), 'a screen reader hears the badge in words');
  assert.ok(!between(nav, "render('settings')").includes('class="badge'), 'Settings: no badge');
  // nothing waiting → no badge at all (never a "0")
  trialsIngestHub(Object.assign({}, simpleHub, { stages: stagesWith({ live: [simpleRows.acme] }), inquiries: { counts: { new: 0, contacted: 0, won: 0, lost: 0 }, open: 0, latest: [] } })); cal.reqs = [];
  renderNav(); assert.ok(!el('tabBar').innerHTML.includes('class="badge'), 'no badges when nothing waits');
  const shellCss = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(shellCss.includes('.badge.red{background:var(--red);color:#fff}') && shellCss.includes('.badge.amber{background:var(--amber-bg);color:var(--amber)'), 'red and amber from the tested colour pairs');
  trialsForget(); calendarForget();
});

/* ───────────── 2. one journey, everywhere the same ───────────── */
test('journey: every simple.step maps to one of five numbered steps (declined = "Not taken"); an older machine maps from the state', () => {
  const expect = { new: [1, 'Applied'], queued: [1, 'Applied'], accepted: [2, 'Onboarding call'], call_booked: [2, 'Onboarding call'], setting_up: [3, 'Setting up'], warming_up: [3, 'Setting up'], sending: [4, 'Sending emails'], finished: [5, 'Done'] };
  assert.deepEqual(TK_STEPS, ['Applied', 'Onboarding call', 'Setting up', 'Sending emails', 'Done']);
  for (const [step, [n, name]] of Object.entries(expect)) {
    const j = tkStep(row(acme, { step }));
    assert.deepEqual([j.n, j.name, j.notTaken], [n, name, false], step);
    assert.equal(tkStepText(j, ''), `Step ${n} of 5 — ${name}` + (n === 4 ? '' : ''), step + ' in words');
  }
  const dec = tkStep(row(acme, { step: 'declined' }));
  assert.deepEqual([dec.n, dec.name, dec.notTaken], [0, 'Not taken', true]);
  assert.equal(renderStepBar(dec), '<span class="pill grey">Not taken</span>', 'grey, no journey');
  assert.ok(renderJourney(dec).includes('Not taken') && !renderJourney(dec).includes('<ol'));
  assert.deepEqual([tkStep(row(acme, { step: 'mystery' })).n, renderStepBar(tkStep(row(acme, { step: 'mystery' })))], [0, ''], 'an unknown step: no bar rather than a wrong one');
  // an older machine without row.simple
  const fromState = { applied: 1, queued: 1, onboarding: 2, awaiting_purchase: 3, setup_check: 3, warming: 3, ready: 3, sending: 4, paused: 4, extension: 4, deciding: 4, converted: 5, not_now: 5, retired: 5 };
  for (const [state, n] of Object.entries(fromState)) assert.equal(tkStep({ state }).n, n, state);
  for (const state of ['declined', 'closed_silent', 'deleted']) assert.equal(tkStep({ state }).notTaken, true, state);
  // Day N of 30, only while sending, and not when the sentence already says it
  assert.equal(tkStepText(tkStep(row(acme, { step: 'sending', dayOf30: 12 })), 'Sending — 2 calls booked'), 'Step 4 of 5 — Sending emails · Day 12 of 30');
  assert.equal(tkStepText(tkStep(row(acme, { step: 'sending', dayOf30: 12 })), 'Sending — day 12 of 30'), 'Step 4 of 5 — Sending emails');
  assert.equal(tkStep(row(acme, { step: 'setting_up', dayOf30: 12 })).day, null, 'no day count before sending');
  assert.equal(tkStep(Object.assign({}, acme, { simple: undefined })).day, 12, 'older machine: the trial day');
  // the small bar: done ticked, the current one filled, the rest empty
  const bar = renderStepBar(tkStep(row(acme, { step: 'setting_up' })));
  assert.deepEqual([...bar.matchAll(/<span class="tk-b5 (\w+)">([^<]*)<\/span>/g)].map((m) => m[1] + m[2]), ['done✓', 'done✓', 'now3', 'todo4', 'todo5']);
  assert.ok(bar.includes('aria-hidden="true"'), 'decoration: the words beside it say the same');
  // the same five names on the list and on the trial page
  const big = renderJourney(tkStep(row(acme, { step: 'accepted' })));
  assert.deepEqual([...big.matchAll(/<span class="tk-j-name">([^<]+)</g)].map((m) => m[1]), TK_STEPS);
});

/* ───────────── 3. "Needs you" first, with a red line ───────────── */
test('"Needs you": those rows sit at the top (newest first) with a red edge and a red "You need to…" line from the next step or the first to-do; then In progress; then Done / not taken', () => {
  const a = row(acme, { step: 'sending', needsYou: true, since: '2026-10-15T00:00:00Z', next: 'Reply to Ann about the dispute', label: 'Sending' });
  const b = row(bright, { step: 'setting_up', needsYou: true, since: '2026-10-16T00:00:00Z', next: '', label: 'Setting up their emails' });
  const c = row(Object.assign({}, acme, { id: 'c1', name: 'Calm Co' }), { step: 'sending', needsYou: false, since: '2026-10-17T00:00:00Z', next: 'Nothing for you: the Friday update goes out today', label: 'Sending' });
  const d = row(Object.assign({}, acme, { id: 'd1', name: 'Odd Co', todo: [] }), { step: 'accepted', needsYou: true, since: '2026-10-14T00:00:00Z', next: 'Nothing for you: we remind them tomorrow', label: 'Accepted' });
  const hub = Object.assign({}, simpleHub, { stages: stagesWith({ live: [a, c], setup: [b], onboard: [d] }) });
  const g = tkListGroups(hub);
  assert.deepEqual(g.needs.map((x) => x.row.id), ['bright-dental', 'acme-plumbing', 'd1'], 'needs you: newest first');
  assert.deepEqual(g.going.map((x) => x.row.id), ['c1']);
  const out = renderTrialList(hub, {});
  assert.ok(out.indexOf('Needs you</h3>') < out.indexOf('Bright Dental') && out.indexOf('Odd Co') < out.indexOf('In progress</h3>') && out.indexOf('In progress</h3>') < out.indexOf('Calm Co'));
  assert.ok(out.includes('<h3 class="tk-group red">Needs you</h3>'), 'the heading is red — the one colour for "needs you"');
  assert.ok(between(out, 'Acme Plumbing', '</button>').includes('<span class="tk-person-you">You need to reply to Ann about the dispute.</span>'), 'from the next step');
  assert.ok(between(out, 'Bright Dental', '</button>').includes('<span class="tk-person-you">You need to buy bright-team.com and 2 inboxes, then paste the logins.</span>'), 'no next step: the first to-do');
  assert.ok(between(out, 'Odd Co', '</button>').includes('<span class="tk-person-you">Something here needs you. Open it to see what.</span>'), '"Nothing for you: …" is never turned into "You need to…"');
  assert.ok(between(out, 'Calm Co', '</button>').includes('<span class="tk-person-next">Nothing for you: the Friday update goes out today</span>') && !between(out, 'Calm Co', '</button>').includes('tk-person-you'));
  assert.equal(count(out, /class="tk-person needs"/g), 3);
  assert.equal(tkYouNeedTo('Answer Sam in the onboarding call box'), 'You need to answer Sam in the onboarding call box.');
  assert.equal(tkYouNeedTo('Sam is waiting for an answer.'), 'You need to: Sam is waiting for an answer.', 'not a verb: kept as written');
  assert.equal(tkYouNeedTo(''), '');
  // the CSS: a red left edge and a red line
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  assert.match(css, /\.tk-person\.needs\{border-left-color:var\(--red\)\}/); assert.match(css, /\.tk-person-you\{[^}]*color:var\(--red\)/);
});

/* ───────────── 4. a trial: three questions, one big button ───────────── */
const sit = (patch) => { const d = clone(ecreekDetail); d.onboardCall = Object.assign(clone(onboardCall), { needsReply: false, status: 'opened' }); d.row = row(simpleRows.ecreek, { step: 'accepted', needsYou: false, next: 'Nothing for you: we remind them tomorrow', label: 'Accepted — waiting for them to book the call' }); d.row.todo = []; return patch(d) || d; };
const buttons = (h) => [...h.matchAll(/<button type="button" class="btn tk-primary" onclick="([^"]*)">([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);

test('three questions: every trial page asks the same three, in the same order, with the same journey', () => {
  for (const d of [ecreekDetail, fernDetail, detail, { row: simpleRows.cobalt }, { row: simpleRows.iris }, { row: simpleRows.gale }]) {
    const t = top(d);
    assert.deepEqual([...t.matchAll(/<h3 class="tk-q-title">([^<]+)<\/h3>/g)].map((m) => m[1]), ['Where are they?', 'What happens next?', 'What do you need to do?'], d.row.id);
    assert.ok(count(t, /class="btn tk-primary"/g) <= 1, d.row.id + ': one big button at most');
  }
  assert.ok(top({ row: simpleRows.gale }).includes('The first emails go out on Mon 26 Oct.'), 'What happens next: the next step without "Nothing for you:"');
  assert.ok(top({ row: simpleRows.cobalt }).includes('Nothing. This trial is finished.'));
  assert.ok(top({ row: simpleRows.iris }).includes("Nothing. We didn't take this one.") && top({ row: simpleRows.iris }).includes('<span class="pill grey">Not taken</span>'));
  const sending = top({ row: row(acme, { step: 'sending', dayOf30: 12, label: 'Sending — 2 calls booked', next: 'Nothing for you: the Friday update goes out today' }) });
  assert.ok(sending.includes('<p class="tk-q-day">Day 12 of 30</p>'), 'while sending: Day 12 of 30');
});

test('the one big button, for each situation (and the order when several apply)', () => {
  // a new application → read it and say yes or no (scrolls to it)
  assert.deepEqual(buttons(top(fernDetail)), [['Read the application and say yes or no', 'tkGoTo(&quot;application&quot;)']]);
  // they wrote and are waiting for his reply → answer it (the reply box under Messages)
  assert.deepEqual(buttons(top(sit((d) => { d.onboardCall.needsReply = true; }))), [["Answer Sam's message", 'tkFocusReply()']]);
  assert.deepEqual(buttons(top(sit((d) => { d.row.todo = [{ id: 'onboard-reply:ecreek-it', text: 'Answer Sam', urgent: true, action: { type: 'view', view: 'detail' } }]; }))), [["Answer Sam's message", 'tkFocusReply()']], 'or the machine\'s to-do says so');
  // they asked for a call time → say yes to it (from the Calendar's own list, or the machine's to-do alone)
  cal.reqs = calRequestsOf(calWeek); cal.settings = calSettingsFixture;
  assert.deepEqual(buttons(top(sit(() => {}))), [['Say yes to their call time', 'openCalendar(&quot;mreq1&quot;)']]);
  cal.reqs = [];
  const mreq = sit((d) => { d.row.todo = [{ id: 'meeting-request:m77', text: 'Say yes to Sam\'s call time', urgent: true, action: { type: 'view', view: 'calendar', clientId: 'ecreek-it', meetingId: 'm77' } }]; d.onboardCall.requestedFor = '2026-09-30T18:00:00Z'; d.onboardCall.theirZone = 'America/Denver'; });
  assert.deepEqual(buttons(top(mreq)), [['Say yes to their call time', 'openCalendar(&quot;m77&quot;)']]);
  assert.ok(top(mreq).includes('Sam asked for a call on Wed 30 Sep · 11:30 pm your time (Wed 2:00 pm US Eastern). Say yes, or suggest another time.'));
  assert.ok(!renderTrialDetail(mreq, 'overview', { now: NOW }).includes('Also on your list'), 'the to-do is not listed twice');
  // a booked call whose time has passed → mark it done (asks first)
  const past = sit((d) => { Object.assign(d.onboardCall, { status: 'booked', bookedFor: '2026-10-16T15:00:00Z', bookedBy: 'calendar' }); });
  assert.deepEqual(buttons(top(past)), [['Mark the call done', 'trialOcTopHeld(&quot;ecreek-it&quot;)']]);
  assert.ok(top(past).includes("If it happened, mark it done. If they didn't show, say so in the call box below."));
  assert.deepEqual(buttons(top(sit((d) => { d.row.todo = [{ id: 'onboard-mark:ecreek-it', text: 'Mark the call', urgent: true, action: { type: 'view', view: 'detail' } }]; }))), [['Mark the call done', 'trialOcTopHeld(&quot;ecreek-it&quot;)']]);
  assert.deepEqual(buttons(top(sit((d) => { Object.assign(d.onboardCall, { status: 'booked', bookedFor: '2026-10-20T15:00:00Z' }); }))), [], 'booked and still ahead: nothing to do');
  // not booked in time → write to them
  assert.deepEqual(buttons(top(sit((d) => { Object.assign(d.onboardCall, { status: 'overdue', overdue: true }); }))), [['Write to them about booking', 'tkFocusReply()']]);
  // buy the domain and inboxes
  const buy = { row: simpleRows.bright };
  assert.deepEqual(buttons(top(buy)), [['Buy the domain and inboxes', 'openTrialPurchase(&quot;bright-dental&quot;)']]);
  assert.ok(top(buy).includes('<p class="tk-q-say">You need to buy the domain and 2 inboxes, then paste the logins.</p>'), 'the machine\'s own next step, as "You need to…"');
  // anything else on the to-do list: urgent says it plainly; not urgent says "when you have a minute"
  const dispute = { row: row(acme, { step: 'sending', needsYou: false, next: 'Nothing for you: the Friday update goes out today', label: 'Sending' }) };
  assert.deepEqual(buttons(top(dispute)), [['Decide the dispute', 'trialsSetTab(&quot;calls&quot;);tkGoTo(&quot;behind&quot;)']]);
  assert.ok(top(dispute).includes('When you have a minute: decide the dispute on the call with bob@example.com.'));
  const paid = { row: row(simpleRows.cobalt, { step: 'finished', needsYou: true, next: '' }) };
  paid.row.todo = [Object.assign({}, simpleRows.cobalt.todo[0], { urgent: true })];
  assert.deepEqual(buttons(top(paid)), [['Mark the invoice paid', 'trialsTodoAction(&quot;paid:cobalt-hvac&quot;)']], 'an api to-do says what it does (markPaid)');
  // the system says it needs him but sent no to-do → look behind the scenes
  assert.deepEqual(buttons(top({ row: row(acme, { step: 'sending', needsYou: true, next: '' , label: 'Sending' }), })).length, 1);
  const look = { row: Object.assign(row(acme, { step: 'sending', needsYou: true, next: '', label: 'Sending' }), { todo: [] }) };
  assert.deepEqual(buttons(top(look)), [['See what needs you', 'tkGoTo(&quot;behind&quot;)']]);
  // nothing → a calm sentence, no button
  const none = top(sit(() => {}));
  assert.deepEqual(buttons(none), []);
  assert.ok(none.includes("<p class=\"tk-q-none\">Nothing — we'll tell you when something needs you</p>"));
  // the order when several apply: application > call time > reply > call to mark > late > buy > other to-dos
  cal.reqs = calRequestsOf(calWeek);
  const many = sit((d) => { d.application = Object.assign({}, d.application, { review: 'pending' }); d.onboardCall.needsReply = true; d.row.state = 'awaiting_purchase'; });
  assert.equal(tkPrimaryAction(many, { now: NOW }).kind, 'review');
  many.application.review = 'approved'; assert.equal(tkPrimaryAction(many, { now: NOW }).kind, 'calendar');
  cal.reqs = []; assert.equal(tkPrimaryAction(many, { now: NOW }).kind, 'reply');
  many.onboardCall.needsReply = false; Object.assign(many.onboardCall, { status: 'booked', bookedFor: '2026-10-16T15:00:00Z' }); assert.equal(tkPrimaryAction(many, { now: NOW }).kind, 'markHeld');
  Object.assign(many.onboardCall, { status: 'overdue', overdue: true, bookedFor: null }); assert.equal(tkPrimaryAction(many, { now: NOW }).kind, 'nudge');
  many.onboardCall = null; assert.equal(tkPrimaryAction(many, { now: NOW }).kind, 'buy');
  calendarForget();
});

test('the big buttons do what they say: scroll to the application, into the reply box, open the Calendar at the meeting, mark the call done (after asking)', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner(); trialsIngestHub(simpleHub);
  const calls = []; let asked = null; globalThis.confirm = (q) => { asked = q; return true; };
  globalThis.fetch = async (url, init) => { const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push([init.method, u.pathname, body]);
    if (u.pathname.endsWith('/onboard-call')) return ok({ ok: true, onboardCall: Object.assign({}, onboardCall, { status: 'held' }) })();
    if (u.pathname === '/api/mc/hub/fern-it') return ok(fernDetail)(); if (u.pathname.startsWith('/api/mc/hub/')) return ok(ecreekDetail)();
    if (u.pathname === '/api/mc/calendar') return ok(calWeek)(); if (u.pathname === '/api/mc/hub') return ok(simpleHub)();
    return ok({ ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 })(); };
  try {
    tk.detail['fern-it'] = fernDetail; tk.detailAt['fern-it'] = Date.now(); openTrial('fern-it'); await tick();
    el('tkSec-application')._scrolled = 0; tkGoTo('application'); assert.equal(el('tkSec-application')._scrolled, 1, 'the application scrolls into view');
    el('tkBehind')._scrolled = 0; tkGoTo('behind'); assert.equal(el('tkBehind')._scrolled, 1, 'behind the scenes too');
    tk.detail['ecreek-it'] = clone(ecreekDetail); tk.detailAt['ecreek-it'] = Date.now(); openTrial('ecreek-it'); await tick();
    el('tkMsgReply')._focused = 0; tkFocusReply(); assert.equal(el('tkMsgReply')._focused, 1, 'the cursor goes into the reply box under Messages');
    asked = null; await trialOcTopHeld('ecreek-it');
    assert.equal(asked, 'Mark the call with Sam Test as done?'); assert.deepEqual(calls.filter((c) => c[1].endsWith('/onboard-call')).pop()[2], { action: 'markHeld' });
    const posts = () => calls.filter((c) => c[1].endsWith('/onboard-call')).length;
    globalThis.confirm = () => false; const n = posts(); await trialOcTopHeld('ecreek-it'); assert.equal(posts(), n, 'no → nothing sent'); globalThis.confirm = () => true;
    // the machine's meeting-request to-do opens the Calendar at that meeting
    tk.hub = Object.assign({}, simpleHub, { todos: [{ id: 'meeting-request:mreq2', clientId: 'gale-roofing', text: 'Mia asked for a call time', urgent: true, action: { type: 'view', view: 'calendar', clientId: 'gale-roofing', meetingId: 'mreq2' } }] });
    assert.equal(tkTodoLabel(tk.hub.todos[0]), 'Open the Calendar');
    trialsTodoAction('meeting-request:mreq2'); await tick();
    assert.equal(currentView, 'calendar'); assert.equal(cal.focus, 'mreq2');
    // the bell lists that request once (the Calendar's own line), not twice
    await calLoad(cal.week, true);
    const bell = computeNotifs().filter((x) => /Mia|Gale/.test(x.t + x.s));
    assert.equal(bell.length, 1, 'one line for one request');
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); calendarForget(); }
});

/* ───────────── 5. deep links ───────────── */
test('deep links still work: #trial/{id}, #calendar, #calendar/{id}, #inquiry/{id}, #inquiries, #alerts (→ Settings › Alerts), #settings, #trials', async () => {
  const cases = [['#trial/acme-plumbing', { view: 'trial', id: 'acme-plumbing' }], ['/#calendar', { view: 'calendar' }], ['#calendar/mreq1', { view: 'calendar', id: 'mreq1' }], ['#inquiry/qmgv1stone', { view: 'inquiry', id: 'qmgv1stone' }], ['#inquiries', { view: 'inquiries' }], ['#alerts', { view: 'settings', section: 'alerts' }], ['#settings', { view: 'settings' }], ['#trials', { view: 'trials' }]];
  for (const [h, want] of cases) assert.deepEqual(parseDeepLink(h), want, h);
  for (const bad of ['#trialAlerts', '#settings/alerts', '#alerts/x', '#machine', '#access_token=x&type=recovery']) assert.equal(parseDeepLink(bad), null, bad);
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const go = (h) => { location.hash = h; winListeners.hashchange.forEach((f) => f()); location.hash = ''; };
  go('#alerts'); assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.alerts, true);
  assert.ok(el('content').innerHTML.includes('<details class="tk-set" id="tkSet-alerts" open'));
  go('#trial/fern-it'); assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'fern-it');
  go('#calendar'); assert.equal(currentView, 'calendar');
  go('#inquiries'); assert.equal(currentView, 'inquiries');
  go('#inquiry/qmgv1stone'); assert.equal(currentView, 'inquiry');
  go('#settings'); assert.equal(currentView, 'settings');
  go('#trials'); assert.equal(currentView, 'trials');
  // a phone alert tapped while the hub is open
  paOnMessage({ data: { type: 'aviance:open', url: '/#alerts' } }); assert.equal(currentView, 'settings');
  paOnMessage({ data: { type: 'aviance:open', url: '/#calendar' } }); assert.equal(currentView, 'calendar');
  // signed out: kept until sign-in
  authUser = null; pendingDeepLink = null; assert.equal(goDeepLink({ view: 'settings', section: 'alerts' }), false); assert.deepEqual(pendingDeepLink, { view: 'settings', section: 'alerts' });
  supa.user = { id: 'u1', email: 'owner@example.com' }; supa.profile = { id: 'u1', name: 'Owner', approved: true, role: 'admin', email: 'owner@example.com' };
  await routeUser('loginErr'); assert.equal(currentView, 'settings'); assert.equal(pendingDeepLink, null);
  offline(); trialsStopTimer(); calendarStopTimer();
});

/* ───────────── 6. plain words ───────────── */
test('plain words: no jargon (state, pipeline, tick, heartbeat, machine, systems, SMTP/IMAP, DNS, JWT, config, payload…) and no ids on the Trials list or at the top of any trial', () => {
  const lists = [renderTrialList(simpleHub, { now: NOW }), renderTrialList(fullHub, { now: NOW }), renderTrialList(stagesHub(), { now: NOW })];
  for (const h of lists) {
    const text = visibleText(h);
    assert.ok(!BANNED.test(text), 'Trials list: ' + (text.match(BANNED) || [])[0]);
    for (const id of ['acme-plumbing', 'bright-dental', 'fern-it', 'ecreek-it', 'cobalt-hvac']) assert.ok(!text.includes(id), 'no raw id on the list: ' + id);
    assert.ok(!/\b[a-z]+_[a-z_]+\b/.test(text), 'no snake_case names: ' + (text.match(/\b[a-z]+_[a-z_]+\b/) || [])[0]);
  }
  cal.reqs = calRequestsOf(calWeek); cal.settings = calSettingsFixture;
  const pages = [ecreekDetail, fernDetail, detail, { row: simpleRows.bright }, { row: simpleRows.gale }, { row: simpleRows.cobalt }, { row: simpleRows.iris }, { row: bright }, { row: acme }];
  for (const d of pages) {
    const text = visibleText(top(d));
    assert.ok(!BANNED.test(text), d.row.id + ' top: ' + (text.match(BANNED) || [])[0]);
    assert.ok(!text.includes(d.row.id) && !/\b[a-z]+_[a-z_]+\b/.test(text), d.row.id + ': no ids');
  }
  calendarForget();
  // Settings, the phone alerts panel and the sign-in screen are plain too (the word "system" once, when needed)
  const set = visibleText(renderSettings({ hub: fullHub, alerts: fullHub.alerts, open: TK_SETTINGS.reduce((o, k) => (o[k] = true, o), {}), phone: 'On', email: 'owner@example.com', now: NOW }));
  assert.ok(!/\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|jwt|payload)\b/i.test(set), 'Settings: ' + (set.match(/\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|jwt|payload)\b/i) || [])[0]);
  const login = visibleText(html.slice(html.indexOf('<div id="login"'), html.indexOf('<div id="modalWrap"')));
  assert.ok(!/\bmachine\b|\bsystems?\b/i.test(login), 'the sign-in screen: ' + (login.match(/\bmachine\b|\bsystems?\b/i) || [])[0]);
  assert.ok(!/Machine alerts|Mission Control ↗|Open config|Toggle light/.test(html + fs.readFileSync(path.join(root, 'trials.js'), 'utf8')), 'the old labels are gone');
});
function stagesHub() { return Object.assign({}, simpleHub, { stages: stagesWith({ intake: [simpleRows.fern, simpleRows.delta], onboard: [simpleRows.ecreek], setup: [bright], live: [acme], won: [simpleRows.cobalt], ended: [simpleRows.iris] }) }); }

test('buttons say exactly what happens', () => {
  const app = renderTrialDetail(fernDetail, 'overview', { now: NOW });
  assert.ok(app.includes('>Say yes and email them</button>') && app.includes('>Say no…</button>'));
  assert.ok(renderDeclineModal(fernDetail).includes('>Say no and email them</button>'));
  assert.ok(renderMessages(ecreekConvDetail).includes('>Send to Sam</button>') && renderMessages(ecreekConvDetail).includes('Reply bot for Sam: <b>On</b>'));
  cal.settings = calSettingsFixture;
  assert.ok(renderCalRequest(calWeek.requests[1], calSettings(calSettingsFixture), { now: CAL_NOW }).includes('>Say yes and email them</button>'));
  assert.ok(renderInquiry(clone(inquiryRecords[0]), { now: NOW }).includes('>Start a free trial and email them</button>'));
  asOwner(); openNewTrialClient(); assert.ok(el('modal').innerHTML.includes('>Add them and send the email</button>')); closeModal();
  calendarForget();
});

/* ───────────── 7. Settings: everything else, as named sections ───────────── */
test('Settings: Alerts, Phone alerts, Google Meet, Inboxes & domains, Warm-up, Reply bot, Is everything running?, Behind the scenes, Advanced, Light or dark, Your account — each folds open, each says its state in one word', () => {
  const ctx = { hub: fullHub, at: Date.now(), alerts: fullHub.alerts, alertsAt: Date.now(), filter: 'open', open: {}, phone: '', dark: false, email: 'owner@example.com', now: NOW };
  const out = renderSettings(ctx);
  assert.deepEqual([...out.matchAll(/<span class="tk-set-title">([^<]+)<\/span>/g)].map((m) => m[1]), ['Alerts', 'Phone alerts', 'Google Meet', 'Inboxes &amp; domains', 'Warm-up', 'Reply bot', 'Is everything running?', 'Behind the scenes', 'Advanced', 'Light or dark', 'Your account']);
  assert.equal(count(out, /<details class="tk-set" id="tkSet-[a-z]+" ontoggle=/g), 11, 'all folded to begin with');
  assert.ok(between(out, 'tkSet-alerts', 'tkSet-phone').includes('<span class="pill amber">2 not seen</span>'));
  assert.ok(between(out, 'tkSet-phone', 'tkSet-google').includes('<span class="pill grey">Off</span>') && between(renderSettings(Object.assign({}, ctx, { phone: 'On' })), 'tkSet-phone', 'tkSet-google').includes('<span class="pill green">On</span>'));
  assert.ok(between(out, 'tkSet-status', 'tkSet-behind').includes('<span class="pill green">Yes</span>'));
  // Alerts (the old alerts page): not seen first, "Mark as seen", no system keys
  const al = renderSettings(Object.assign({}, ctx, { open: { alerts: true } }));
  assert.ok(al.includes('<details class="tk-set" id="tkSet-alerts" open'));
  const alerts = between(al, 'tkSet-alerts', 'tkSet-phone');
  assert.ok(alerts.includes('Not seen · 2') && alerts.includes('Shopping list unanswered for 14 h') && alerts.includes('>Mark as seen</button>') && alerts.includes('not sent to your phone or email'));
  assert.ok(!alerts.includes('purchase_reminder') && !alerts.includes('Acknowledge') && !alerts.includes('Mission Control'), 'no raw keys, no old words');
  assert.ok(renderAlerts([], 'open', {}).includes('No new alerts. Nothing needs you.'));
  // Phone alerts, Behind the scenes, Advanced, Light or dark, Your account
  assert.ok(out.includes('onclick="openPhoneAlerts()">Set up phone alerts</button>'));
  assert.ok(out.includes('onclick="render(\'trialsBoard\')">Open behind the scenes</button>'));
  assert.ok(out.includes('onclick="setTheme(\'dark\')">Dark</button>') && out.includes('<span class="pill grey">Light</span>'));
  assert.ok(out.includes('Signed in as <b>owner@example.com</b>.') && out.includes('onclick="logout()">Log out</button>'));
  // Is everything running? in plain words — the old status strip
  const st = renderSystemStatus(fullHub.machine, { now: NOW });
  assert.ok(st.includes('<p class="tk-status green">Yes. Everything is running.</p>'));
  for (const w of ['Last check-in', 'Last email sent', 'Trials running', '2 of 3', 'Free extensions', 'Alerts not seen yet', 'Paid services used', 'Google Places 12%']) assert.ok(st.includes(w), w);
  assert.ok(renderSystemStatus({ ok: false, error: 'Redis is full' }).includes('No. Something is wrong: Redis is full.'));
  assert.ok(renderSystemStatus({ heartbeat: { lastTickAt: null, ageSec: null } }).includes("Not yet. The automatic check-in isn't running yet."));
  assert.ok(renderSystemStatus({ heartbeat: { ageSec: 600 } }).includes('Mostly.'));
  // loading and errors never block the rest of Settings
  const bare = renderSettings({ hubErr: 'Offline', alertsErr: 'Offline', open: { alerts: true, status: true } });
  assert.ok(bare.includes('Offline') && bare.includes('Set up phone alerts') && bare.includes('Log out'));
  // everything is escaped
  const evil = renderSettings({ hub: { machine: { ok: false, error: '<img src=x onerror=alert(1)>' } }, alerts: [{ id: 'a"1', title: '<script>x</script>', clientId: 'c"1', urgent: true }], open: { alerts: true, status: true }, email: '<b>me</b>' });
  assert.ok(!evil.includes('<img src=x') && !evil.includes('<script>x') && !evil.includes('<b>me</b>') && evil.includes('trialsAckAlert(&quot;a\\&quot;1&quot;)'));
});

test('Settings: opening, remembering what is open, the alert filter, and the theme', async () => {
  asOwner(); trialsForget(); asOwner();
  globalThis.fetch = async (url) => { const u = new URL(url); if (u.pathname === '/api/mc/alerts') return ok({ alerts: fullHub.alerts })(); if (u.pathname === '/api/mc/hub') return ok(fullHub)(); return ok({ ok: true })(); };
  try {
    render('settings'); await tick();
    assert.equal(el('ptitle').textContent, 'Settings'); assert.equal(el('backBtn').style.display, 'none', 'one of the four places: no Back');
    trialsSettingsToggle('status', true); trialsSettingsToggle('nonsense', true);
    assert.deepEqual(Object.keys(tk.setOpen).sort(), ['status']);
    trialsSetAlertFilter('all'); assert.equal(trialsAlertFilter, 'all'); assert.equal(tk.setOpen.alerts, true, 'using the filter keeps Alerts open');
    trialsSetAlertFilter('bogus'); assert.equal(trialsAlertFilter, 'open');
    el('tkSet-alerts')._scrolled = 0; openSettings('alerts'); trialsOnRender('settings'); assert.equal(el('tkSet-alerts')._scrolled, 1, 'openSettings scrolls to the section');
    setTheme('dark'); assert.ok(document.body.classList.contains('dark')); assert.equal(localStorage.getItem('avianceTheme'), 'dark');
    setTheme('light'); assert.ok(!document.body.classList.contains('dark')); assert.equal(localStorage.getItem('avianceTheme'), 'light');
    await logout(); assert.deepEqual(tk.setOpen, {}, 'signing out forgets it'); supa.session = { access_token: 'test-token' };
  } finally { offline(); trialsStopTimer(); }
});

/* ───────────── 8. the Calendar: a request with a suggestion holds the suggested time ───────────── */
test('Calendar: a request the owner answered with "Suggest another time" is drawn at the suggested time, says "waiting for them", and is not a yes for him', () => {
  const ST = calSettings(calSettingsFixture);
  const where = (m, id) => { for (const d of m.days) { const x = d.items.find((i) => i.m.id === id); if (x) return [d.key, x.s, x.m.status]; } return null; };
  assert.equal(where(calWeekModel('2026-09-28', calWeek.meetings, ST, { now: CAL_NOW }), 'mreq3'), null, 'not at the time they first asked for (Fri 2 Oct)');
  assert.deepEqual(where(calWeekModel('2026-10-05', calWeek.meetings, ST, { now: CAL_NOW }), 'mreq3'), ['2026-10-05', 19 * 60, 'requested'], 'at the suggested time: Mon 5 Oct, 7:00 pm');
  assert.equal(calHeldAt(calWeek.meetings.find((m) => m.id === 'mreq3')), '2026-10-05T13:30:00Z'); assert.equal(calHeldAt(calWeek.meetings.find((m) => m.id === 'mconf')), '2026-09-29T13:00:00Z');
  const grid = renderCalGrid(calWeekModel('2026-10-05', calWeek.meetings, ST, { now: CAL_NOW }));
  assert.ok(/class="cal-ev suggested"[^>]*onclick="calOpenMeeting\(&quot;mreq3&quot;\)"[^>]*>.*Waiting for them/.test(grid), 'drawn apart from the ones waiting for his yes, in words');
  assert.equal(calNavCount(), '', 'a suggestion waiting for them is no badge for him');
  cal.reqs = calRequestsOf(calWeek); assert.equal(calNavCount(), 2); calendarForget();
  // the grid helper and the "Call done" action are two different functions (one global script)
  assert.equal(typeof calHeldAt, 'function'); assert.ok(/calPost\(\{action:'held'/.test(calHeld.toString()));
});

/* ───────────── 9. one global script: no name used twice ───────────── */
test('one global script: no two files (or two places in one file) declare the same function or top-level name', () => {
  const sources = { 'index.html': shell };
  for (const f of FILES) sources[f] = fs.readFileSync(path.join(root, f), 'utf8');
  const seen = {};
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) (seen[m[1]] ||= []).push(file);
    for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) (seen[m[1]] ||= []).push(file);
  }
  const dup = Object.entries(seen).filter(([, where]) => where.length > 1).map(([n, where]) => n + ' (' + where.join(', ') + ')');
  assert.deepEqual(dup, [], 'declared twice: a later one silently replaces the earlier one');
  assert.ok(Object.keys(seen).length > 300, 'scanned the real files (' + Object.keys(seen).length + ' names)');
});
