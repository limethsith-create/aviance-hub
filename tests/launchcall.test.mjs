/* The launch call (email-distributor docs/LAUNCH-CALL.md §5–6): the second call, near the end of warm-up, where the
   owner goes through the list and the emails with the client and they give the OK.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   What is checked: the one call card, drawn for the launch call (renderCallCard, the onboarding card reused — not a
   second card) in every status; the two new buttons (Approved on the call, Skip the call) and their contract bodies +
   confirm words; the big button's words per to-do; the Calendar's "Launch call" label and the panel's shortcut;
   Messages' labels for the invite; the research brief "Before the call" at the top of the card; no jargon; and a
   journey-style pass over the whole page in every status. The machine's own launch-call steps (15–20 of its journey
   snapshots, tests/fixtures/journey) are drawn by tests/journey.test.mjs; this file covers every status with fixtures.

   Same set-up as simple.test.mjs: the shell's inline script, then every section script, a tiny fake DOM, no network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, simpleHub, simpleRows, onboardCall, ecreekDetail, launchCalls, launchSimple, galeLaunch, calLaunch, calLaunchWeek, calSettingsFixture, botRuleWords, researchBrief } from './fixtures.mjs';

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
globalThis.addEventListener = () => {};

const supa = { session: null, user: null, profile: null };
const fakeSb = {
  auth: { getSession: async () => ({ data: { session: supa.session } }), getUser: async () => ({ data: { user: supa.user } }), signInWithPassword: async () => ({ error: null }), signOut: async () => { supa.session = null; }, resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: supa.profile }) }) }) }),
};
globalThis.supabase = { createClient: () => fakeSb };

/* ───────────── load the shell, then the section scripts ───────────── */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="trials.js">'));
const FILES = ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'warmup.js', 'keys.js', 'push.js'];
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
for (const f of FILES) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
supa.session = { access_token: 'test-token' };
after(() => { trialsStopTimer(); calendarStopTimer(); });

const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const count = (s, re) => (s.match(re) || []).length;
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 5));
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = b ? s.indexOf(b, i + a.length) : -1; return s.slice(i, j < 0 ? s.length : j); };
const decode = (t) => t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const flat = (h) => decode(String(h || '').replace(/<span class="tk-sr">[\s\S]*?<\/span>/g, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
/* The hub's own words: without what the machine wrote INTO emails (the clients' words, links). */
const hubText = (h) => flat(String(h || '').replace(/<div class="tk-cm-text">[\s\S]*?<\/div>/g, '').replace(/<div class="tk-cm-subj">[\s\S]*?<\/div>/g, '').replace(/<span class="tk-cm-sys-t">[\s\S]*?<\/span>/g, ''));
const BANNED = /\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|dns|jwt|config|payload|mission control|cron|redis|endpoint|webhook)\b/i;
const BROKEN = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|Invalid Date/;
const EMPTY = [/<button\b[^>]*>\s*<\/button>/g, /<b>\s*<\/b>/g, /<h[34]\b[^>]*>\s*<\/h[34]>/g, /<label\b[^>]*>\s*<\/label>/g, /<span class="pill[^"]*">\s*<\/span>/g, /<p\b[^>]*>\s*<\/p>/g, /<li\b[^>]*>\s*<\/li>/g];
const ODD = [/ · · /, /\(\s*\)/, /:\s+\./, /\s,/, /\.\.(?!\.)/];
const buttons = (h) => [...h.matchAll(/<button type="button" class="btn tk-primary" onclick="([^"]*)">([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
const cardBtns = (h) => [...between(h, '<h4>Update the call</h4>').matchAll(/<button class="(btn(?: ghost)?)" onclick="(trialOcAction\([^"]*)">([^<]*)<\/button>/g)].map((m) => [m[3], m[1], decode(m[2])]);

const ID = 'gale-roofing';
const card = (status, patch) => { const d = galeLaunch(status); if (patch) patch(d); return renderLaunchCall(d.launchCall, d.row, { now: NOW }); };
/* The client page, then their email system's Setup (the warm-up), Calls (the launch call, the onboarding call) and Actions (Also on your list). */
const whole = (d) => renderTrialDetail(d, 'overview', { now: NOW }) + ['setup', 'calls', 'actions'].map((t) => '<!--tab-->' + renderSysTab(d, t, { now: NOW })).join('');
const page = (status, patch) => { const d = galeLaunch(status); if (patch) patch(d); return whole(d); };
const top = (h) => between(h, '<section class="card tk-top', '</section>');
const part = (h, a) => { const i = h.indexOf(a); if (i < 0) return ''; const ends = ['<div id="tkAbHost">', '<div id="tkWuHost">', '<div id="tkLcHost">', '<div id="tkOcHost">', 'id="tkSec-application"', '<h3>Also on your list</h3>', '<!--tab-->', '<div class="section-head tk-section" id="tkSec-calls">', '<div class="card tk-pad tk-access"'].map((e) => h.indexOf(e, i + a.length)).filter((j) => j > 0); return h.slice(i, ends.length ? Math.min(...ends) : h.length); };
/* The Calendar's last answer, as the hub keeps it: the launch call's week, so the card can find the Meet link. */
function withCalendar(reqs) {
  calendarForget(); cal.settings = clone(calLaunchWeek.settings); cal.weeks['2026-10-19'] = clone(calLaunchWeek); cal.at['2026-10-19'] = Date.now(); cal.reqs = reqs ? clone(reqs) : [];
}
const STATUSES = Object.keys(launchCalls);

/* ───────────── 1. the card, per status ───────────── */
test('launch card: the onboarding card reused by kind — same steps, "Book by", the messages link; its own id and title; no second card in the code', () => {
  const src = fs.readFileSync(path.join(root, 'trials.js'), 'utf8');
  assert.equal(count(src, /^function renderCallCard\(/gm), 1, 'one card renderer');
  assert.match(src, /^function renderOnboardCall\(oc,row,meta\)\{return renderCallCard\(oc,row,meta,'onboarding'\)\}/m);
  assert.match(src, /^function renderLaunchCall\(lc,row,meta\)\{return renderCallCard\(lc,row,meta,'launch'\)\}/m);
  assert.equal(count(src, /Your emails with \$\{esc\(first\|\|'them'\)\} are under Messages/g), 1, 'the shared words live once');
  const html = card('sent');
  assert.ok(html.startsWith('<section class="card tk-oc" id="tkSec-launchcall">') && html.includes('<h3>Launch call</h3>'));
  assert.ok(html.includes('<p class="tk-oc-say">Launch invite sent — waiting for them to pick a time</p>'), 'the machine\'s label');
  assert.equal(count(html, /<li class="done"><span class="tk-oc-tick" aria-hidden="true">✓<\/span>/g), 1); assert.equal(count(html, /<li class="todo">/g), 4);
  assert.ok(html.includes('Launch invite sent</span><span class="tk-oc-at"') && html.includes(tkDateTime('2026-10-15T10:00:00Z')));
  assert.ok(html.includes('<p class="tk-oc-due">Book by ' + tkDayName('2026-10-20T10:00:00Z') + '</p>'));
  assert.ok(html.includes('First reminder ' + tkDateTime('2026-10-18T14:00:00Z') + " if they haven't booked.") && html.includes('href="https://aviance.store/book/launch"') && html.includes('Emails go from hello@aviance.store.'));
  assert.ok(html.includes('<p class="tk-oc-msgs">Your emails with Mia are under Messages. <button type="button" class="tk-textbtn" onclick="tkGoTo(&quot;messages&quot;)">See the messages</button></p>'));
  // the approval page, to share on the call — a safe link, a new tab
  assert.ok(html.includes('<a class="btn ghost" href="https://machine.test/c/tok9/approve" target="_blank" rel="noopener noreferrer">Open the approval page</a>'));
  // buttons: the launch call's own handler args (kind 'launch'), its own picker id — never the onboarding card's
  assert.deepEqual(cardBtns(html), [['Send the invite again', 'btn ghost', 'trialOcAction("gale-roofing","resend","launch")'], ['Stop the reminder emails', 'btn ghost', 'trialOcAction("gale-roofing","stopReminders","launch")']]);
  assert.ok(html.includes('<input id="tkLcWhen" type="datetime-local" data-tk-form><button class="btn" onclick="trialOcMarkBooked(&quot;gale-roofing&quot;,&quot;launch&quot;)">Mark call booked</button>') && !html.includes('tkOcWhen'));
  assert.ok(!html.includes('Approved on the call') && !html.includes('Skip the call'), 'nothing booked, nothing approved: neither of the two new buttons');
  assert.equal(renderLaunchCall(null, simpleRows.gale), '');
  // the onboarding card is untouched: two-argument handlers, its own ids
  const onb = renderOnboardCall(onboardCall, simpleRows.ecreek, { now: NOW });
  assert.ok(onb.includes('id="tkSec-onboardcall"') && onb.includes('<h3>Onboarding call</h3>') && onb.includes('trialOcAction(&quot;ecreek-it&quot;,&quot;resend&quot;)">Send the first email again') && onb.includes('id="tkOcWhen"') && onb.includes('trialOcMarkBooked(&quot;ecreek-it&quot;)">'));
  assert.ok(!onb.includes('approval page') && !onb.includes('Approved on the call'), 'the onboarding call has no approval');
});

test('launch card, they asked for a time: no "Book by", no second way to book; booked: Approved on the call first, Call done and They didn\'t show beside it, Join Google Meet + See it in the Calendar + the approval page', () => {
  withCalendar([calLaunch.requested]);
  const asked = card('requested');
  assert.ok(!flat(asked).includes('Book by') && !asked.includes('Mark call booked') && !asked.includes('Send the invite again') && asked.includes('Stop the reminder emails'));
  assert.ok(!asked.includes('Approved on the call'), 'not booked yet');
  const booked = card('booked');
  assert.ok(booked.includes('The call is on <b>Tue 20 Oct, 8:30 pm your time</b> <span class="tk-oc-us">(Tue 11:00 am US Eastern)</span> — booked through your Calendar'), 'Sri Lanka time, US Eastern beside it');
  assert.ok(booked.includes('<a class="btn" href="https://meet.google.com/gal-launch-001" target="_blank" rel="noopener noreferrer">Join Google Meet</a><button type="button" class="btn ghost" onclick="openCalendar(&quot;mlaunch&quot;)">See it in the Calendar</button><a class="btn ghost" href="https://machine.test/c/tok9/approve" target="_blank" rel="noopener noreferrer">Open the approval page</a>'));
  assert.ok(flat(booked).includes('On the call, share the approval page with Mia and go through the list and the emails. When Mia says yes, press Approved on the call.'));
  assert.deepEqual(cardBtns(booked), [['Approved on the call', 'btn', 'trialOcAction("gale-roofing","approvedOnCall","launch")'], ['Call done', 'btn ghost', 'trialOcAction("gale-roofing","markHeld","launch")'], ["They didn't show", 'btn ghost', 'trialOcAction("gale-roofing","markNoShow","launch")'], ['Stop the reminder emails', 'btn ghost', 'trialOcAction("gale-roofing","stopReminders","launch")']], 'the day-before reminder can still be stopped, as on the onboarding card');
  assert.ok(booked.includes('Call moved? Pick the new date and time') && !flat(booked).includes('Book by') && !booked.includes('Skip the call'));
  // the Calendar has no Meet link for it: still the way there
  calendarForget();
  const noMeet = card('booked');
  assert.ok(!noMeet.includes('Join Google Meet') && noMeet.includes('See it in the Calendar') && noMeet.includes('Open the approval page'));
});

test('launch card, held without the OK: amber line + Approved on the call only; approved on the call: green line "sending starts on Day 1", no buttons, no approval page link', () => {
  const held = card('held');
  assert.ok(held.includes('The call was on <b>Fri 16 Oct, 8:30 pm your time</b>'));
  assert.ok(held.includes('<p class="tk-status amber tk-oc-ok">The call is done, but their OK isn\'t in yet. If Mia said yes to the list and the emails, press Approved on the call — sending can\'t start without it.</p>'));
  assert.deepEqual(cardBtns(held), [['Approved on the call', 'btn', 'trialOcAction("gale-roofing","approvedOnCall","launch")']]);
  assert.ok(!held.includes('Mark call booked') && !held.includes('Stop the reminder emails') && held.includes('Open the approval page'));
  const done = card('approvedOnCall');
  assert.ok(done.includes('<p class="tk-status green tk-oc-ok">Approved on the call — sending starts on Day 1 (Mon 26 Oct).</p>'));
  assert.equal(count(done, /<li class="done">/g), 5);
  assert.ok(!done.includes('Update the call') && !done.includes('<button class="btn') && !done.includes('Open the approval page') && done.includes('See the messages'), 'quiet: nothing left to press');
  assert.ok(done.startsWith('<section class="card tk-oc" id="tkSec-launchcall">'), 'still warming up: the card stays open');
  // no Day 1 known: the sentence still reads right
  assert.ok(card('approvedOnCall', (d) => { d.row.day1Date = null; }).includes('Approved on the call — sending starts on Day 1.</p>'));
});

test('launch card, they approved on the page: "They approved on the page on …", the call is optional — Skip the call (first while nothing is booked, beside Call done once booked), never Approved on the call; skipped: quiet', () => {
  const pg = card('approvedOnPage');
  assert.ok(pg.includes('<p class="tk-status green tk-oc-ok">They approved on the page on Fri 16 Oct, 5:30 pm your time. The call is optional now — hold it anyway, or skip it.</p>'));
  assert.deepEqual(cardBtns(pg), [['Send the invite again', 'btn ghost', 'trialOcAction("gale-roofing","resend","launch")'], ['Stop the reminder emails', 'btn ghost', 'trialOcAction("gale-roofing","stopReminders","launch")'], ['Skip the call', 'btn', 'trialOcAction("gale-roofing","skip","launch")']]);
  assert.ok(pg.includes('Mark call booked') && pg.includes('Open the approval page'));
  const pgBooked = card('approvedOnPageBooked');
  assert.deepEqual(cardBtns(pgBooked), [['Call done', 'btn', 'trialOcAction("gale-roofing","markHeld","launch")'], ["They didn't show", 'btn ghost', 'trialOcAction("gale-roofing","markNoShow","launch")'], ['Stop the reminder emails', 'btn ghost', 'trialOcAction("gale-roofing","stopReminders","launch")'], ['Skip the call', 'btn ghost', 'trialOcAction("gale-roofing","skip","launch")']]);
  assert.ok(!pgBooked.includes('Approved on the call'), 'their OK is in already');
  // held after approving on the page: no Skip (the call happened), nothing to press
  const pgHeld = card('approvedOnPageBooked', (d) => { Object.assign(d.launchCall, { status: 'held', heldAt: '2026-10-20T15:40:00Z' }); });
  assert.ok(pgHeld.includes('They approved on the page on Fri 16 Oct, 5:30 pm your time.</p>') && !pgHeld.includes('Skip the call') && !pgHeld.includes('<h4>Update the call</h4>'));
  const sk = card('skipped');
  assert.ok(sk.includes('They approved on the page on Fri 16 Oct, 5:30 pm your time. You skipped the call on Sat 17 Oct, 2:30 pm.</p>'));
  assert.ok(!sk.includes('<h4>Update the call</h4>') && !sk.includes('Open the approval page') && flat(sk).includes('Reminders are stopped.') && !flat(sk).includes('Book by'));
  // a machine that says it with the status word only
  assert.ok(card('approvedOnPage', (d) => { Object.assign(d.launchCall, { status: 'skipped' }); }).includes('You skipped the call.</p>'));
});

test('launch card, overdue: "Book by … — overdue" in red; hostile values escaped, an unsafe approval link is no link; once the trial is sending, the card folds to one line (Done / Skipped)', () => {
  const late = card('overdue');
  assert.ok(late.includes('<p class="tk-oc-due late">Book by ' + tkDayName('2026-10-16T10:00:00Z') + ' — overdue</p>') && flat(late).includes('2 reminders sent.'));
  const evil = card('sent', (d) => { Object.assign(d.launchCall, { label: '<img src=x onerror=alert(1)>', approvalUrl: 'javascript:alert(2)', bookingUrl: 'javascript:alert(3)', fromInbox: '<b>x</b>', steps: [{ key: 'sent', label: '<i>x</i>', done: true, at: 'nope' }] }); d.row.simple.person = '<b>Eve</b> X'; });
  assert.ok(!/<img src=x|<b>x<\/b>|<i>x<\/i>|<b>Eve/.test(evil) && !evil.includes('href="javascript') && !evil.includes('Open the approval page'));
  assert.ok(evil.includes('&lt;img src=x onerror=alert(1)&gt;') && evil.includes('Your emails with &lt;b&gt;Eve&lt;/b&gt; are under Messages.'));
  const fold = card('approvedOnCall', (d) => { d.row.state = 'sending'; });
  assert.ok(fold.startsWith('<details class="tk-appbox tk-oc-done" id="tkSec-launchcall"><summary><span class="tk-appbox-title">Launch call</span><span class="pill green">Done</span></summary>'));
  assert.ok(card('skipped', (d) => { d.row.state = 'sending'; }).includes('<span class="pill grey">Skipped</span></summary>'));
  assert.ok(card('approvedOnCall', (d) => { d.row.state = 'ready'; }).startsWith('<section'), 'ready for Day 1: still open');
  assert.ok(card('booked', (d) => { d.row.state = 'sending'; }).startsWith('<section'), 'a call still ahead never folds');
});

/* ───────────── 2. the page: under the warm-up card, above the (folded) onboarding call; step ③ from the machine ───────────── */
test('their email system: the Launch call card (Calls) comes after Warm-up (Setup) and above the folded onboarding call; step ③ Setting up with the machine\'s sentence; the launch to-do is not listed twice; nothing says the OK only happens on a page', () => {
  withCalendar();
  for (const st of STATUSES) {
    const h = page(st);
    const iWu = h.indexOf('<div id="tkWuHost">'), iLc = h.indexOf('<div id="tkLcHost">'), iOc = h.indexOf('<div id="tkOcHost">');
    assert.ok(iWu > 0 && iLc > iWu && iOc > iLc, st + ': Warm-up, then Launch call, then the onboarding call');
    assert.ok(!between(h, '<section class="card tk-top', '<!--tab-->').includes('tkLcHost'), st + ': not on the client page');
    assert.ok(part(h, '<div id="tkLcHost">').includes('id="tkSec-launchcall"'), st + ': the card');
    assert.ok(part(h, '<div id="tkOcHost">').startsWith('<div id="tkOcHost"><details class="tk-appbox tk-oc-done" id="tkSec-onboardcall">'), st + ': the onboarding call is history');
    const t = top(h);
    assert.ok(t.includes('aria-label="The trial journey, step 3 of 5"') && t.includes('<li class="now" aria-current="step"><span class="tk-j-dot" aria-hidden="true">3</span><span class="tk-j-name">Setting up</span>'), st + ': step ③');
    assert.ok(t.includes('<p class="tk-q-big">' + esc(launchSimple[st].label) + '</p>'), st + ': the machine\'s sentence');
    assert.ok(!h.includes('<h3>Also on your list</h3>'), st + ': the launch to-do is the big button, not a second list');
    assert.ok(!/approval link sent|no click yet|approve on the page to start|click the approval link/i.test(hubText(h.slice(0, h.indexOf('<details class="tk-behind"')))), st + ': nothing implies the OK is a page click only');
  }
  assert.ok(!page('sent').includes('<div id="tkLcHost">') === false);
  assert.ok(!whole(clone(ecreekDetail)).includes('tkLcHost'), 'no invite yet: no launch card');
  // the machine's to-do section names ('launchCall') open their email system at Calls, at the card
  assert.equal(TK_SECTION_ALIAS.launchCall, 'launchcall');
  assert.deepEqual(tkSectionPlace(ID, 'launchCall'), { view: 'clientSystem', tab: 'calls', sec: 'launchcall' });
});

/* ───────────── 3. the big button per to-do ───────────── */
test('the big button follows the launch call: say yes to the time (Calendar), hold it then press Approved, press Approved, mark it done, skip it, write to them, answer the message; nothing until the call', () => {
  // they asked for a time: the Calendar's request says kind launch
  withCalendar([calLaunch.requested]);
  let h = page('requested');
  assert.deepEqual(buttons(top(h)), [['Say yes to their launch-call time', 'openCalendar(&quot;mlaunch-req&quot;)']]);
  assert.ok(flat(top(h)).includes('Mia asked for the launch call on Tue 20 Oct · 8:30 pm your time (Tue 11:00 am US Eastern). Say yes, or suggest another time.'), 'the Calendar\'s own style for a request, as for the onboarding call');
  assert.ok(!h.includes('cal-trial-ask'), 'said once — the big button');
  // the Calendar has not been asked yet: the to-do + the call's own requestedFor still say it is the launch call
  calendarForget(); cal.settings = clone(calSettingsFixture);
  h = page('requested');
  assert.deepEqual(buttons(top(h)), [['Say yes to their launch-call time', 'openCalendar(&quot;mlaunch-req&quot;)']]);
  assert.ok(flat(top(h)).includes('asked for the launch call on Tue 20 Oct · 8:30 pm your time'));
  // and the onboarding call's own request still reads as before
  const onb = clone(ecreekDetail); onb.onboardCall = Object.assign(clone(onboardCall), { needsReply: false, status: 'opened', requestedFor: '2026-09-30T18:00:00Z', theirZone: 'America/Denver' });
  onb.row = Object.assign({}, simpleRows.ecreek, { todo: [{ id: 'meeting-request:m77', text: 'Say yes', urgent: true, action: { type: 'view', view: 'calendar', clientId: 'ecreek-it', meetingId: 'm77' } }] });
  assert.deepEqual(buttons(top(renderTrialDetail(onb, 'overview', { now: NOW }))), [['Say yes to their call time', 'openCalendar(&quot;m77&quot;)']]);
  withCalendar();
  // booked and past: hold it, then press Approved on the call (scrolls to the card)
  h = page('past');
  assert.deepEqual(buttons(top(h)), [['Hold the launch call, then press Approved on the call', 'tkGoTo(&quot;launchcall&quot;)']]);
  assert.ok(flat(top(h)).includes('The launch call was set for Fri 16 Oct, 8:30 pm your time. On the call, share the approval page and go through the list and the emails with Mia. When Mia says yes, press Approved on the call in the launch-call box under Calls.'));
  assert.ok(top(h).includes('<section class="card tk-top needs"'), 'red: his turn');
  assert.deepEqual(buttons(top(page('past', (d) => { d.row.todo = []; }))), [['Hold the launch call, then press Approved on the call', 'tkGoTo(&quot;launchcall&quot;)']], 'from the time alone, without the to-do');
  // held, no OK: press it
  h = page('held');
  assert.deepEqual(buttons(top(h)), [['Press Approved on the call', 'tkGoTo(&quot;launchcall&quot;)']]);
  assert.ok(flat(top(h)).includes("The launch call is done, but their OK is not in yet. If Mia said yes to the list and the emails, press Approved on the call in the launch-call box under Calls — sending can't start without it."));
  // approved on the page, the call is past: just mark it done (or skip it on the card)
  h = page('approvedOnPageBooked', (d) => { d.launchCall.bookedFor = '2026-10-16T15:00:00Z'; });
  assert.deepEqual(buttons(top(h)), [['Mark the launch call done', 'trialOcTopHeld(&quot;gale-roofing&quot;,&quot;launch&quot;)']]);
  assert.ok(flat(top(h)).includes('Mia already approved on the page. If the call happened, mark it done. If not, skip it in the launch-call box under Calls.'));
  // overdue: write to them — unless they approved on the page: then skip it
  h = page('overdue');
  assert.deepEqual(buttons(top(h)), [['Write to them about booking', 'tkFocusReply()']]);
  assert.ok(flat(top(h)).includes('You need to write to them about booking the launch call.'), 'the machine\'s next step, as "You need to…"');
  assert.ok(flat(top(page('overdue', (d) => { d.row.simple.needsYou = false; }))).includes("Mia hasn't booked the launch call yet, and it's late. Send them a short note under Messages."), 'the hub\'s own words when the row has not caught up');
  h = page('overduePage');
  assert.deepEqual(buttons(top(h)), [['Skip the launch call', 'trialOcAction(&quot;gale-roofing&quot;,&quot;skip&quot;,&quot;launch&quot;)']]);
  assert.ok(flat(top(h)).includes('Mia approved on the page, so sending can start without the call. Skip it — or leave it, and hold the call if they book one.'));
  // they wrote: answer them (before anything about the call)
  h = page('past', (d) => { d.conversation.needsReply = true; });
  assert.deepEqual(buttons(top(h)), [["Answer Mia's message", 'tkFocusReply()']]);
  // a launch-call to-do the hub does not know by name: the machine says it needs him → the launch-call box, not Behind the scenes
  h = page('sent', (d) => { d.row.simple.needsYou = true; d.row.simple.next = 'Look at the launch call'; });
  assert.deepEqual(buttons(top(h)), [['Open the launch-call box', 'tkGoTo(&quot;launchcall&quot;)']]);
  // booked and still ahead: nothing to do — nothing asked on the top card; the call in both clocks is on its card (Calls)
  h = page('booked');
  assert.deepEqual(buttons(top(h)), []);
  assert.equal(tkPrimaryAction(galeLaunch('booked'), { now: NOW }).label, 'Nothing until the launch call. Join it on Tue 20 Oct, 8:30 pm your time.');
  assert.ok(!top(h).includes('tk-q-title'), flat(top(h)));
  assert.ok(flat(part(h, '<div id="tkLcHost">')).includes('Tue 20 Oct, 8:30 pm your time'));
  assert.ok(!top(h).includes('tk-top needs'));
  // approved (either way) or skipped: nothing asked, the machine's next step shows
  for (const st of ['approvedOnCall', 'approvedOnPage', 'skipped']) {
    h = page(st);
    assert.deepEqual(buttons(top(h)), [], st);
    assert.ok(!top(h).includes('tk-q-title') && tkPrimaryAction(galeLaunch(st), { now: NOW }).kind === 'none', st + ': ' + flat(top(h)));
  }
  assert.equal(tkPrimaryAction(galeLaunch('approvedOnCall'), { now: NOW }).kind, 'none');
  // the Trials list: the row's red line comes from the machine's next step
  const hub = Object.assign({}, simpleHub, { stages: simpleHub.stages.map((s) => (s.key === 'build' ? Object.assign({}, s, { clients: [galeLaunch('past').row] }) : s)) });
  const list = renderTrialList(hub, { now: NOW });
  assert.ok(between(list, 'Gale Roofing', '</button>').includes('<span class="tk-person-you">You need to hold the launch call, then press Approved on the call.</span>'));
});

/* ───────────── 4. the buttons post the contract, ask first, redraw the card and the big button from the answer ───────────── */
test('Approved on the call and Skip the call: the contract bodies to /launch-call, the confirm words, the card and the three questions redrawn from {ok, launchCall}; the onboarding card never gets them; resend/markBooked/markHeld carry the kind', async () => {
  asOwner(); trialsForget(); withCalendar(); asOwner(); trialsIngestHub(simpleHub);
  let lc = clone(launchCalls.booked); lc.bookedFor = '2026-10-16T15:00:00Z';
  const calls = []; let asked = null; globalThis.confirm = (q) => { asked = q; return true; };
  const detailNow = () => Object.assign(galeLaunch('past'), { launchCall: lc });
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push([init.method, u.pathname, body]);
    if (u.pathname === '/api/mc/clients/gale-roofing/launch-call') {
      if (body.action === 'approvedOnCall') Object.assign(lc, { status: 'held', heldAt: '2026-10-17T12:00:00Z', approvedOnCall: '2026-10-17T12:00:00Z', label: 'Approved on the call — first emails Mon 26 Oct', steps: lc.steps.map((s) => ({ key: s.key, label: s.label, done: true, at: s.at || '2026-10-17T12:00:00Z' })) });
      if (body.action === 'skip') Object.assign(lc, { skipped: '2026-10-17T12:00:00Z', stopped: true });
      if (body.action === 'markBooked') Object.assign(lc, { status: 'booked', bookedFor: body.when, bookedBy: 'owner' });
      if (body.action === 'markHeld') Object.assign(lc, { status: 'held', heldAt: '2026-10-17T12:00:00Z' });
      return ok({ ok: true, launchCall: lc })();
    }
    if (u.pathname === '/api/mc/hub/gale-roofing') return ok(detailNow())();
    if (u.pathname === '/api/mc/hub') return ok(simpleHub)();
    return ok({ ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 })();
  };
  const posts = () => calls.filter((c) => c[1].endsWith('/launch-call'));
  try {
    tk.detail[ID] = detailNow(); tk.detailAt[ID] = Date.now(); openTrial(ID); await tick();
    assert.equal(currentView, 'trial'); assert.ok(el('content').innerHTML.includes('id="tkSysBtn"'));
    tkOpenSystem(ID, 'calls'); await tick(); assert.equal(currentView, 'clientSystem'); assert.ok(el('content').innerHTML.includes('<div id="tkLcHost">'), 'the card, in their email system › Calls');
    el('tkLcHost').innerHTML = renderLaunchCall(tk.detail[ID].launchCall, tk.detail[ID].row, { now: new Date() }); el('tkTop').outerHTML = 'TOP-BEFORE';
    // Approved on the call
    asked = null; await trialOcAction(ID, 'approvedOnCall', 'launch');
    assert.equal(asked, 'This approves their list and emails — sending can start.');
    assert.deepEqual(posts().pop(), ['POST', '/api/mc/clients/gale-roofing/launch-call', { action: 'approvedOnCall' }]);
    assert.ok(el('toast').innerHTML.includes('Approved on the call — their list and emails are approved'));
    assert.ok(el('tkLcHost').innerHTML.includes('Approved on the call — sending starts on Day 1 (Mon 26 Oct).') && !el('tkLcHost').innerHTML.includes('<h4>Update the call</h4>'), 'the card is redrawn from the answer');
    assert.equal(tk.detail[ID].launchCall.approvedOnCall, '2026-10-17T12:00:00Z');
    assert.ok(el('tkTop').outerHTML.startsWith('<section class="card tk-top"') && !el('tkTop').outerHTML.includes('Hold the launch call'), 'the three questions follow at once');
    await tick(); assert.ok(calls.some((c) => c[1] === '/api/mc/hub/gale-roofing') && calls.some((c) => c[1] === '/api/mc/hub'), 'the page and the list refresh behind it');
    // no → nothing sent
    globalThis.confirm = () => false; let n = posts().length; await trialOcAction(ID, 'approvedOnCall', 'launch'); assert.equal(posts().length, n, 'cancel sends nothing'); globalThis.confirm = (q) => { asked = q; return true; };
    // Skip the call
    lc = Object.assign(clone(launchCalls.approvedOnPage)); tk.detail[ID] = detailNow(); tk.detailAt[ID] = Date.now();
    asked = null; await trialOcAction(ID, 'skip', 'launch');
    assert.equal(asked, 'Skip the launch call with Mia Gale? They approved on the page, so sending can start without it.');
    assert.deepEqual(posts().pop()[2], { action: 'skip' }); assert.ok(el('toast').innerHTML.includes('The launch call is skipped'));
    assert.ok(el('tkLcHost').innerHTML.includes('You skipped the call on ' + tkDateTime('2026-10-17T12:00:00Z') + '.'));
    // the two are the launch call's only: never posted to the onboarding call
    await tick(); const before = calls.filter((c) => c[0] === 'POST' && c[1].indexOf('/api/mc/clients/') === 0).length;
    await trialOcAction(ID, 'approvedOnCall'); await trialOcAction(ID, 'skip', 'onboarding'); await trialOcAction(ID, 'somethingElse', 'launch'); await tick();
    assert.equal(calls.filter((c) => c[0] === 'POST' && c[1].indexOf('/api/mc/clients/') === 0).length, before, 'nothing posted anywhere');
    // the kind rides along on the shared buttons
    lc = clone(launchCalls.sent); tk.detail[ID] = detailNow(); tk.detailAt[ID] = Date.now();
    asked = null; await trialOcAction(ID, 'resend', 'launch');
    assert.equal(asked, 'Send Mia Gale the launch-call invite again?'); assert.deepEqual(posts().pop()[2], { action: 'resend' }); assert.ok(el('toast').innerHTML.includes('The invite was sent again'));
    el('tkLcWhen').value = '2026-10-20T20:30'; el('tkOcWhen').value = ''; await trialOcMarkBooked(ID, 'launch');
    assert.deepEqual(posts().pop()[2], { action: 'markBooked', when: '2026-10-20T15:00:00.000Z' }, 'the picker is the owner\'s time (Sri Lanka), read from the launch card\'s own box');
    assert.ok(el('tkLcHost').innerHTML.includes('Approved on the call</button>'), 'now booked: Approved on the call shows');
    asked = null; await trialOcTopHeld(ID, 'launch');
    assert.equal(asked, 'Mark the launch call with Mia Gale as done?'); assert.deepEqual(posts().pop()[2], { action: 'markHeld' });
    assert.deepEqual(calls.filter((c) => c[1].endsWith('/onboard-call')), [], 'the onboarding call was never posted to');
    // a refusal leaves the card alone
    globalThis.fetch = async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ error: 'The call is not booked yet' }) });
    el('tkLcHost').innerHTML = 'UNCHANGED'; await trialOcAction(ID, 'approvedOnCall', 'launch');
    assert.ok(el('toast').innerHTML.includes('That did not work: The call is not booked yet') && el('tkLcHost').innerHTML === 'UNCHANGED');
    // tkOcRepaint with no kind (messages.js after a reply) redraws both cards
    tk.detail[ID] = detailNow(); el('tkLcHost').innerHTML = 'X'; el('tkOcHost').innerHTML = 'Y'; tkOcRepaint(ID);
    assert.ok(el('tkLcHost').innerHTML.includes('id="tkSec-launchcall"') && el('tkOcHost').innerHTML.includes('id="tkSec-onboardcall"'));
  } finally { globalThis.confirm = () => true; globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; trialsForget(); calendarForget(); }
});

/* ───────────── 5. the Calendar ───────────── */
test('Calendar: a kind:launch meeting is labelled "Launch call" (the machine\'s title; the hub\'s own words when there is none), drawn like an onboarding call; the panel\'s "Approved on the call" shortcut opens the trial\'s launch card while the OK is not in', () => {
  asOwner(); trialsForget(); withCalendar(); asOwner();
  const st = calSettings(calLaunchWeek.settings); const now = new Date('2026-10-17T12:00:00Z');
  const wk = renderCalendar(clone(calLaunchWeek), { now, week: '2026-10-19' });
  const blk = between(wk, '<button type="button" class="cal-ev confirmed launch"', '</button>');
  assert.ok(blk && blk.includes('Gale Roofing</span><span class="cal-ev-s">Launch call · 8:30 pm · Confirmed</span>'), 'the grid block says what it is');
  assert.ok(blk.includes('aria-label="Launch call — Gale Roofing with Mia Gale. Tue 20 Oct, 8:30 pm Sri Lanka time (Tue 11:00 am US Eastern). 30 minutes. Confirmed. Google Meet link ready."'));
  const onb = between(wk, '<button type="button" class="cal-ev confirmed"', '</button>');
  assert.ok(onb.includes('Delta Roofing</span><span class="cal-ev-s">7:30 pm · Confirmed</span>') && !onb.includes('launch'), 'an onboarding call as before');
  assert.ok(wk.includes('class="cal-aitem confirmed launch"') && wk.includes('<span class="cal-astatus">Launch call · Confirmed · 30 min · Google Meet</span>'), 'the phone list too');
  assert.equal(calTitle(calLaunch.held), 'Launch call — Gale Roofing', 'no title from the machine: the hub still says what it is');
  assert.equal(calTitle(calLaunch.confirmed), 'Launch call — Gale Roofing'); assert.equal(calTitle({ company: 'X Co', kind: 'onboarding' }), 'Call — X Co', 'unchanged for the rest');
  assert.equal(calSourceText('launch_card'), 'Marked booked on the launch-call card');
  // the panel: confirmed and past → Approved on the call first, Call done beside it; the shortcut opens the trial at the card
  const past = new Date('2026-10-20T16:00:00Z');
  let p = renderCalMeeting(clone(calLaunch.confirmed), st, { now: past });
  assert.ok(p.includes('<h3>Launch call — Gale Roofing</h3><p>Confirmed — did the call happen? If they said yes to their list and emails, press Approved on the call</p>'));
  assert.ok(p.includes('<small>Their OK</small><span>Not in yet. On the call, go through the list and the emails together; when they say yes, press Approved on the call (on their trial).</span>'));
  assert.ok(between(p, '<div class="modal-foot cal-acts">', '</div>').startsWith('<div class="modal-foot cal-acts"><button class="btn" onclick="calLaunchApprove(&quot;mlaunch&quot;)">Approved on the call</button><button class="btn ghost" onclick="calHeld(&quot;mlaunch&quot;)">Call done</button>'));
  assert.ok(p.includes('Join Google Meet'));
  // still ahead: the shortcut is there too (he may hold the call early), Call done stays ghost
  p = renderCalMeeting(clone(calLaunch.confirmed), st, { now });
  assert.ok(p.includes('calLaunchApprove(&quot;mlaunch&quot;)">Approved on the call</button><button class="btn ghost" onclick="calOpenMove('));
  // held without the OK: only the shortcut
  p = renderCalMeeting(clone(calLaunch.held), st, { now: past });
  assert.ok(between(p, '<div class="modal-foot cal-acts">', '</div>').startsWith('<div class="modal-foot cal-acts"><button class="btn" onclick="calLaunchApprove(&quot;mlaunch-held&quot;)">Approved on the call</button><button class="btn ghost" onclick="closeModal()">Close</button>'));
  assert.ok(p.includes('<small>From</small><span>Marked booked on the launch-call card</span>'));
  // the meeting says approved → no shortcut; the trial's card says approved → no shortcut; the meeting says not yet → shortcut
  p = renderCalMeeting(Object.assign(clone(calLaunch.confirmed), { approvedAt: '2026-10-20T15:30:00Z' }), st, { now: past });
  assert.ok(!p.includes('calLaunchApprove') && p.includes('<small>Their OK</small><span>In — their list and emails are approved</span>') && p.includes('<button class="btn" onclick="calHeld(&quot;mlaunch&quot;)">Call done</button>'));
  tk.detail[ID] = galeLaunch('approvedOnCall');
  assert.ok(!renderCalMeeting(clone(calLaunch.confirmed), st, { now: past }).includes('calLaunchApprove'));
  tk.detail[ID] = galeLaunch('approvedOnPage');
  assert.ok(!renderCalMeeting(clone(calLaunch.confirmed), st, { now: past }).includes('calLaunchApprove'), 'approved on the page: nothing to press');
  tk.detail[ID] = galeLaunch('past');
  assert.ok(renderCalMeeting(clone(calLaunch.confirmed), st, { now: past }).includes('calLaunchApprove'));
  assert.ok(renderCalMeeting(Object.assign(clone(calLaunch.confirmed), { approvedAt: null }), st, { now: past }).includes('calLaunchApprove'));
  // never for an onboarding call, a request, or a meeting without a trial
  assert.ok(!renderCalMeeting(clone(calLaunch.onboarding), st, { now: past }).includes('Approved on the call') && !renderCalMeeting(clone(calLaunch.requested), st, { now }).includes('Approved on the call'));
  assert.ok(!renderCalMeeting(Object.assign(clone(calLaunch.confirmed), { clientId: null }), st, { now: past }).includes('calLaunchApprove'));
  // pressing it: their email system at Calls, scrolled to the launch-call card
  tk.detail[ID] = galeLaunch('past'); tk.detailAt[ID] = Date.now(); trialsIngestHub(simpleHub);
  el('tkSec-launchcall')._scrolled = 0; calLaunchApprove('mlaunch');
  assert.equal(currentView, 'clientSystem'); assert.equal(trialTab, 'calls'); assert.equal(currentTrialId, ID); assert.equal(el('tkSec-launchcall')._scrolled, 1);
  trialsForget(); calendarForget();
});

/* ───────────── 6. Messages ───────────── */
test('Messages: the launch invite and the "what happens now" email are labelled as ours, sent automatically; the reply bot\'s "sent your booking link and free times" reads right for a launch-call reply', () => {
  const h = renderMessages(galeLaunch('booked'), { now: NOW });
  assert.ok(h.includes('<b>What happens now — sent automatically</b>') && h.includes('<b>Launch-call invite — sent automatically</b>'));
  assert.ok(h.includes('<b>Mia wrote</b>') && h.includes('<span class="tk-cm-who"><b>Auto-reply</b><span class="tk-cm-rule"> · sent your booking link and free times</span></span>'));
  assert.equal(MSG_RULES.wants_time, botRuleWords.wants_time);
  assert.ok(!h.includes('You wrote'), 'no automatic email of ours is shown as the owner\'s own words');
});

/* ───────────── 7. plain words + a journey-style pass over every status ───────────── */
test('journey-style: the whole trial page (front, every tab), the list row and the Calendar in every launch-call status — nothing broken, no empty labels, no jargon, no ids, Sri Lanka time', () => {
  asOwner(); trialsForget(); withCalendar([calLaunch.requested]); asOwner();
  for (const st of STATUSES) {
    const d = galeLaunch(st);
    const hub = Object.assign({}, simpleHub, { stages: simpleHub.stages.map((s) => (s.key === 'build' ? Object.assign({}, s, { clients: [d.row] }) : s)) });
    const screens = { list: renderTrialList(hub, { now: NOW }), page: renderTrialDetail(d, 'overview', { now: NOW }) };
    for (const [tab] of TK_TABS) screens['tab ' + tab] = renderTrialDetail(d, tab, { now: NOW, behindOpen: true });
    for (const [where, h] of Object.entries(screens)) {
      const t = flat(h);
      const bad = t.match(new RegExp('.{0,50}(' + BROKEN.source + ').{0,30}'));
      assert.ok(!bad, st + ' ' + where + ': broken value: "' + (bad && bad[0]) + '"');
      for (const re of EMPTY) { const m = String(h).match(re); assert.ok(!m, st + ' ' + where + ': an empty label: ' + (m && m[0])); }
      const words = hubText(where.startsWith('tab') ? h.slice(0, h.indexOf('<details class="tk-behind"')) : h);
      for (const re of ODD) { const m = words.match(new RegExp('.{0,40}' + re.source + '.{0,20}')); assert.ok(!m, st + ' ' + where + ': odd wording: "' + (m && m[0]) + '"'); }
      assert.ok(!BANNED.test(words), st + ' ' + where + ': jargon "' + (words.match(BANNED) || [])[0] + '"');
      assert.ok(!/\bgale-roofing\b/.test(words) && !/\b[a-z]+_[a-z_]+\b/.test(words.replace(/[\w.-]+@[\w.-]+/g, '')), st + ' ' + where + ': an id or a code name: ' + (words.match(/\b[a-z]+_[a-z_]+\b/) || [])[0]);
      assert.ok(!/\d (AM|PM)\b/.test(words), st + ' ' + where + ': a time not in the hub\'s style');
    }
    const c = part(screens.page, '<div id="tkLcHost">');
    assert.ok(!BANNED.test(flat(c)) && !/\b(approvedOnCall|approvedOnPage|launchCall|markHeld)\b/.test(flat(c)), st + ': the card in plain words');
  }
  const wk = renderCalendar(clone(calLaunchWeek), { now: new Date('2026-10-17T12:00:00Z'), week: '2026-10-19' });
  assert.ok(!BANNED.test(flat(wk)) && !BROKEN.test(flat(wk)));
  trialsForget(); calendarForget();
});

test('"Before the call" on the launch-call card: the research brief at its top — the same card as under "What we found" (one function), open while the call is ahead, one closed line once it is over; none without a brief; a repaint keeps it', () => {
  const withBrief = (st) => { const d = galeLaunch(st); d.application.research = { status: 'done', at: '2026-09-28T09:05:00Z', brief: clone(researchBrief) }; return d; };
  const lcPart = (d) => part(whole(d), '<div id="tkLcHost">');
  for (const st of STATUSES) {
    const c = lcPart(withBrief(st));
    const folded = ['held', 'approvedOnCall', 'skipped'].includes(st);
    if (folded) assert.ok(/<(section class="card tk-oc" id="tkSec-launchcall">\s*<h3>Launch call<\/h3>|div class="card tk-oc">)\s*<details class="tk-brief tk-brief-fold"><summary class="tk-brief-title">Before the call<span class="tk-brief-count">what we found<\/span><\/summary>/.test(c), st + ': the call is over — the brief is one closed line at the top');
    else assert.ok(c.includes('<h3>Launch call</h3>\n    <div class="tk-brief"><h4 class="tk-brief-title">Before the call</h4><p class="tk-brief-text">'), st + ': the brief open, first on the card');
    assert.ok(c.indexOf('tk-brief') < c.indexOf('class="tk-oc-say"'), st + ': above the call\'s own sentence');
    const words = hubText(c);
    assert.ok(!BANNED.test(words) && !BROKEN.test(flat(c)), st + ': plain words: ' + (words.match(BANNED) || [])[0]);
    for (const re of EMPTY) { const m = c.match(re); assert.ok(!m, st + ': an empty label: ' + (m && m[0])); }
  }
  // one function, both places: the same paragraph and the same sources under "What we found"
  const d = withBrief('booked'); const page = whole(d);
  const onCard = between(part(page, '<div id="tkLcHost">'), '<p class="tk-brief-text">', '</details>');
  const inFound = between(between(page, '<h4>What we found</h4>'), '<p class="tk-brief-text">', '</details>');
  assert.ok(onCard.length > 500 && onCard === inFound, 'the same card in both places');
  // no brief (older research, nothing found) → no card, no empty heading
  for (const b of [undefined, null, { text: '', sentences: [], sources: [] }]) {
    const x = galeLaunch('booked'); if (b !== undefined) x.application.research = { status: 'done', brief: b };
    const c = lcPart(x); assert.ok(!c.includes('tk-brief') && !c.includes('Before the call'), JSON.stringify(b));
  }
  assert.ok(!renderLaunchCall(d.launchCall, d.row, { now: NOW }).includes('tk-brief'), 'the card alone, without meta.brief: nothing');
  assert.ok(!renderOnboardCall(d.onboardCall, d.row, { now: NOW, brief: researchBrief }).includes('tk-brief'), 'the onboarding card never shows it');
  // after a button, the card is redrawn from the cache: the brief stays
  asOwner(); currentView = 'trial'; currentTrialId = ID; tk.detail[ID] = withBrief('booked'); el('tkLcHost').innerHTML = '';
  tkOcRepaint(ID, 'launch');
  assert.ok(el('tkLcHost').innerHTML.includes('<h4 class="tk-brief-title">Before the call</h4>'));
  currentView = 'trials'; trialsForget();
});

test('files: the styles keep the readability floor (tokens only), the new calendar class is drawn like a call; the machine\'s snapshots carry launchCall from the invite on', () => {
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8'); const ccss = fs.readFileSync(path.join(root, 'calendar.css'), 'utf8');
  assert.match(css, /\.tk-oc-ok\{/); assert.match(css, /\.tk-oc-hint\{[^}]*font-size:var\(--fs-base\)/);
  assert.ok(!/\.tk-oc-(ok|hint)\{[^}]*font-size:\s*(\d|1[0-2])px/.test(css));
  assert.match(ccss, /\.cal-ev\.launch,\.cal-aitem\.launch\{border-left-style:double\}/);
  // the trimmed journey snapshots (tests/fixtures/journey/trim.mjs): the launch call from step 15 (the invite) on —
  // tests/journey.test.mjs draws those real steps
  const dir = path.join(root, 'tests', 'fixtures', 'journey');
  const withLaunch = fs.readdirSync(dir).filter((f) => /^\d\d-.*\.json$/.test(f)).filter((f) => /"launchCall":\{/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.equal(withLaunch[0], '15-launch-invite.json', 'the first snapshot with a launch call is the invite');
  assert.ok(withLaunch.includes('20-launch-approved.json'));
  // the brief's styles: tokens only, nothing under the 13 px floor, a 44 px target to open the sources
  assert.ok(!/\.tk-brief[^{]*\{[^}]*font-size:\s*\d+px/.test(css), 'the brief: font sizes are tokens');
  assert.match(css, /\.tk-brief-src>summary\{[^}]*min-height:44px/);
  assert.match(css, /\.tk-brief-mark\{[^}]*font-size:var\(--fs-min\)/);
});

test('the Calendar strips on the Trials screens say it is the launch call they asked for', () => {
  asOwner(); trialsForget(); withCalendar([calLaunch.requested]); asOwner();
  const ask = calTrialAsk(ID);
  assert.ok(ask.includes('<b>Mia asked for the launch call: Tue 20 Oct · 8:30 pm (your time)</b>') && ask.includes('openCalendar(&quot;mlaunch-req&quot;)'));
  const rowAsk = calRowAsk(ID, { label: 'Warming up', next: 'Nothing for you' });
  assert.ok(rowAsk.includes('<span>They asked for the launch call on Tue 20 Oct · 8:30 pm (your time) — say yes in the Calendar</span>'));
  // an onboarding request reads as before
  cal.reqs = [clone(calLaunch.requested)]; cal.reqs[0].kind = 'onboarding'; cal.reqs[0].id = 'monb-req';
  assert.ok(calTrialAsk(ID).includes('<b>Mia asked for a call: Tue 20 Oct · 8:30 pm (your time)</b>'));
  assert.ok(calRowAsk(ID, {}).includes('<span>They asked for Tue 20 Oct · 8:30 pm (your time) — say yes in the Calendar</span>'));
  trialsForget(); calendarForget();
});
