/* Tests for Ava (ava.js) — the hub's helper: what she understands (places, clients said a little wrong, live numbers
   from what the hub has loaded, the guide, "not sure"), who may hear what (money is the owner's), that anything which
   changes something asks first and only opens the place, typing when the browser has no voice, the voice itself
   (mocked), the panel, Ctrl/⌘+J, Esc and "Ask Ava" in ⌘K.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Same set-up as simple.test.mjs: the shell's inline script, then every section script and ava.js last, exactly like
   the browser, with a tiny fake DOM and a fake Supabase client. No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleRows, stagesWith, fullHub, cobalt, calWeek, CAL_NOW } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM (as in simple.test.mjs) ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, open: false, hidden: false, _classes: new Set(), _attrs: {},
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() { el._focused = (el._focused || 0) + 1; }, select() {}, submit() {}, addEventListener() {}, scrollIntoView() {}, closest() { return null; },
    getAttribute(k) { return el._attrs[k] ?? null; }, setAttribute(k, v) { el._attrs[k] = String(v); } };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
const docListeners = {};
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener(type, fn, capture) { (docListeners[type] ||= [])[capture ? 'unshift' : 'push'](fn); } };   // capture listeners run first, as in a browser
globalThis.localStorage = { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} }, userAgent: 'Mozilla/5.0 Chrome/140.0' }, configurable: true });
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

/* ───────────── load the shell, the section scripts, then Ava ───────────── */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="trials.js">'));
const FILES = ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'warmup.js', 'keys.js', 'push.js', 'people.js', 'ava.js'];
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
for (const f of FILES) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
supa.session = { access_token: 'test-token' };
after(() => { trialsStopTimer(); calendarStopTimer(); });

const clone = (o) => JSON.parse(JSON.stringify(o));
const asOwner = () => { authUser = { uid: 'u1', name: 'Limeth Sith', role: 'admin', email: 'owner@example.com' }; document.body.classList.remove('ro'); };
const asTeam = () => { authUser = { uid: 'u9', name: 'Nimal Perera', role: 'employee', email: 'nimal@example.com' }; document.body.classList.add('ro'); };
const tick = () => new Promise((r) => setTimeout(r, 5));

/* A client called Lakeview IT, sending, with numbers — beside the usual fixtures. */
const lakeview = Object.assign(clone(simpleRows.acme), { id: 'lakeview-it', name: 'Lakeview IT', contactName: 'Dana Reed', five: { sent: 412, replies: 14, positive: 6, booked: 3, qualified: 2 }, todo: [] });
Object.assign(lakeview.simple, { company: 'Lakeview IT', person: 'Dana Reed', label: 'Sending — day 12 of 30', next: '', needsYou: false });
const paidCobalt = Object.assign(clone(simpleRows.cobalt), { plan: 'starter' });
function freshHub() {
  const S = simpleRows;
  return Object.assign({}, fullHub, { stages: stagesWith({ intake: [clone(S.fern), clone(S.delta)], onboard: [clone(S.ecreek)], setup: [clone(S.bright)], build: [clone(S.gale)], live: [clone(S.acme), clone(lakeview)], won: [clone(paidCobalt)], ended: [clone(S.iris)] }) });
}
function setup(role) {
  (role === 'team' ? asTeam : asOwner)();
  trialsForget(); calendarForget();
  (role === 'team' ? asTeam : asOwner)();
  trialsIngestHub(freshHub());
  AVA.pending = null; AVA.log = []; AVA.greeted = false; AVA.open = false;
  cal.now = CAL_NOW.toISOString();
  cal.settings = calWeek.settings;
  cal.weeks = { '2026-09-28': clone(calWeek) }; cal.at = { '2026-09-28': Date.now() }; cal.week = '2026-09-28';
  cal.reqs = calRequestsOf(calWeek);
  tm.data = { team: [
    { uid: 'u1', name: 'Limeth Sith', role: 'admin', online: true, lastView: 'trials' },
    { uid: 'u9', name: 'Nimal Perera', role: 'employee', online: true, lastView: 'paying' },
    { uid: 'u3', name: 'Sachini Fernando', role: 'employee', online: false },
  ], owners: { 'lakeview-it': ['u9', 'u3'] } };
  tk.outreach = { totals: { sent: 1012, replies: 8, bounces: 14, uniqueOpens: 260, firstDay: '2026-08-20', days: 24 }, days: [] }; tk.outreachAt = Date.now();
  closeModal();
}
const ctx = (over) => Object.assign(avaCtx(), over || {});
const think = (t) => avaThink(t, ctx());

/* ───────────── 1. places ───────────── */
test('navigation: places open at once — Trials, Paying clients, Calendar, Team, My stats, Activity, Settings, a Settings section, back', () => {
  setup('owner');
  for (const [said, view] of [['open trials', 'trials'], ['go to paying clients', 'paying'], ['show my calendar', 'calendar'], ['open the team', 'team'], ['Activity', 'people'], ['open settings', 'settings']]) {
    const r = think(said);
    assert.ok(r.auto, said + ': runs at once'); r.auto.run();
    assert.equal(currentView, view, said);
    assert.match(r.say, /^Opening /);
  }
  const s = think('open my stats'); s.auto.run(); assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'aviance');
  const w = think('open warm-up helpers'); w.auto.run(); assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.warmup, true);
  render('calendar'); render('trials'); openTrial('lakeview-it');
  const b = think('go back'); b.auto.run(); assert.equal(currentView, 'trials', 'back from a client page');
});

/* ───────────── 2. clients, said a little wrong ───────────── */
test('clients: the name found whole, by its own first word, split or misspelt, possessive — and not from a look-alike word', () => {
  setup('owner');
  const id = (t) => (avaFindClient(t) || {}).id || null;
  assert.equal(id('open Lakeview'), 'lakeview-it');
  assert.equal(id('open lake view'), 'lakeview-it', 'split by the speech engine');
  assert.equal(id('how is lakevew doing'), 'lakeview-it', 'one letter off');
  assert.equal(id("show Lakeview's conversations"), 'lakeview-it', 'possessive');
  assert.equal(id('Lakeview IT'), 'lakeview-it');
  assert.equal(id('open acme plumbing'), 'acme-plumbing');
  assert.equal(id('open bright dental'), 'bright-dental');
  assert.equal(id('that is right'), null, '"right" is not Bright Dental');
  assert.equal(id('open the calendar'), null);
  assert.equal(id('plumbing'), null, 'a word every plumber has says nothing');
  const o = think('open Lakeview'); o.auto.run();
  assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'lakeview-it');
});

test("clients: a tab of their email system by its words — conversations, emails, calls, messages, history, and the owner's own tabs (with a fallback when the tab key is not there)", () => {
  setup('owner');
  const open = (t) => { const r = think(t); assert.ok(r.auto, t); r.auto.run(); return trialTab; };
  assert.equal(open("show Lakeview's conversations"), 'conversations'); assert.equal(currentView, 'clientSystem'); assert.equal(currentTrialId, 'lakeview-it');
  assert.ok(['sent', 'emails'].includes(open('show lakeview emails sent')), 'emails sent → today\'s key');
  assert.equal(open('open lakeview calls'), 'calls');
  assert.equal(open('open lakeview messages'), 'messages');
  assert.ok(['timeline', 'history'].includes(open("show Lakeview's history")));
  assert.ok(['deliverability', 'health'].includes(open("show Lakeview's health")));
  assert.equal(open('open lakeview leads'), 'leads');
  assert.equal(open('open lakeview setup'), 'setup');
  assert.ok(['money', 'overview'].includes(open("show Lakeview's money")), 'money: its own tab, else Overview (where the money card is)');
  // a tab this hub doesn't have falls back gracefully
  assert.equal(avaTabKey('lakeview-it', 'nope'), 'overview');
});

/* ───────────── 3. live answers ───────────── */
test('live answers: emails a client sent, their replies and calls, how many trials run, who is sending / warming up, new applications, what needs me', () => {
  setup('owner');
  let r = think('how many emails did Lakeview send');
  assert.match(r.say, /Lakeview IT has sent 412 emails, with 14 replies and 3 calls booked\./); assert.match(r.say, /They're at step 4 of 5: Sending — day 12 of 30\./);
  assert.ok(r.actions.some((a) => /Emails sent/.test(a.label)), 'offers to go there');
  assert.match(think('how many replies did lakeview get').say, /Lakeview IT got 14 replies, 6 of them positive, from 412 emails sent/);
  assert.match(think('how many calls has lakeview booked').say, /Lakeview IT has 3 calls booked, 2 qualified so far/);
  assert.match(think('how is bright dental doing').say, /Bright Dental hasn't sent any emails yet\. They're at step 3 of 5: Setting up their emails/);
  r = think('how many trials are running');
  assert.match(r.say, /^6 trials are going: /); assert.match(r.say, /1 sending|2 sending/); assert.match(r.say, /need you/);
  r = think("who's sending");
  assert.ok(r.say.includes('Acme Plumbing') && r.say.includes('Lakeview IT'), r.say);
  r.actions[0].run(); assert.equal(currentView, 'trials'); assert.equal(tk.stage.trials, 'sending', 'Show them: the Sending tile');
  assert.match(think('who is warming up').say, /1 trial is at warming up: Gale Roofing/);
  assert.match(think('any new applications').say, /1 new application is waiting: Fern IT/);
  r = think('what needs me today');
  assert.match(r.say, /^\d+ things need you: /);
  for (const w of ['Fern IT — a new application to read', 'eCreek IT', 'Bright Dental — buy the domain', 'call times wait for your yes']) assert.ok(r.say.includes(w), w + ' in: ' + r.say);
  r.actions[0].run(); assert.equal(currentView, 'trial');
});

test("live answers: today's and tomorrow's calendar (Sri Lanka time), who's online, who looks after a client, my own emails, the money this month", () => {
  setup('owner');
  let r = think("what's on my calendar today");
  assert.match(r.say, /You have 1 call today \(Sri Lanka time\): 6:30 pm — Onboarding call — Acme Plumbing\./);
  r = think('any calls tomorrow');
  assert.match(r.say, /11:30 pm — Onboarding call — eCreek IT \(waiting for your yes\)/);
  assert.ok(!/Iris/.test(r.say), 'a cancelled call is not on it');
  r.actions[0].run(); assert.equal(currentView, 'calendar');
  assert.match(think("who's online").say, /1 person is in the hub: Nimal on Paying clients/);
  assert.match(think('who looks after lakeview').say, /Lakeview IT is looked after by Nimal and Sachini/);
  assert.match(think('how many emails have I sent').say, /Your own outreach has sent 1,012 emails since .*, with 8 replies and 14 bounced; 260 were opened/);
  tk.detail['cobalt-hvac'] = { row: paidCobalt, invoice: { number: 'INV-0007', amount: 1500, issuedAt: '2026-09-10', paidAt: '2026-09-20T10:00:00Z', status: 'paid' } };
  r = think('how much money did we make this month');
  assert.match(r.say, /You received \$1,500 this month, and \$1,500 in total from 1 paid invoice/);
});

/* ───────────── 4. the guide ───────────── */
test('the guide: FAQs answered from AVA_KB with a "Take me there" that goes there', () => {
  setup('owner');
  const kb = (t) => think(t).kb;
  assert.equal(kb('how do I give a client access'), 'access');
  assert.equal(kb('what does warming up mean'), 'warmup');
  assert.equal(kb('why is Opened blank for clients'), 'opened');
  assert.equal(kb('how do I remove the test run'), 'testrun');
  assert.equal(kb('what is a bounce'), 'bounce');
  assert.equal(kb('how does a trial work'), 'process');
  assert.equal(kb('what does the reply bot do'), 'replybot');
  assert.equal(kb('how do I add a warm-up helper'), 'helpers');
  assert.equal(kb('what is save and start fresh'), 'mystats');
  assert.equal(kb('what are the stage tiles'), 'tiles');
  const r = think('how do I remove the test run');
  assert.match(r.say, /Remove the test run/);
  const go = r.actions.find((a) => a.label === 'Take me there'); assert.ok(go); go.run();
  assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.demo, true);
  assert.match(think('why is opened blank for clients').say, /without an open tracker/);
  // every entry has words, an answer, and a place that exists
  for (const e of AVA_KB) { assert.ok(e.kw && e.a.length > 40, e.id); if (e.go) assert.ok(avaPlace(e.go), e.id + ' → ' + e.go); }
  assert.ok(AVA_KB.length >= 35);
});

test('not sure: a plain "try …" with three chips', () => {
  setup('owner');
  const r = think('purple elephant banana');
  assert.equal(r.unknown, true);
  assert.match(r.say, /^I'm not sure yet — try 'what needs me' or 'open /);
  assert.equal(r.chips.length, 3);
  assert.match(think('').say, /didn't catch that/);
});

/* ───────────── 5. who hears what ───────────── */
test('roles: a team member hears no money, gets no owner-only places or tabs, and no action that changes things', () => {
  setup('team');
  const money = think('how much money this month');
  assert.ok(!/\$/.test(money.say) && /only for the owner/.test(money.say), money.say);
  tk.detail['cobalt-hvac'] = { row: paidCobalt, invoice: { amount: 1500, paidAt: '2026-09-20', status: 'paid' } };
  assert.ok(!/\$/.test(think('how much has cobalt paid').say));
  const tab = think("show Lakeview's money"); assert.ok(!tab.auto && /only for the owner/.test(tab.say));
  for (const t of ['open settings', 'open activity', 'open the test run']) { const r = think(t); assert.ok(!r.auto, t); assert.match(r.say, /only for the owner/, t); }
  for (const t of ['add a trial client', 'give Lakeview access', 'load the test run']) { const r = think(t); assert.ok(!r.confirm && !r.auto, t); assert.match(r.say, /Only the owner can do that/, t); assert.equal(AVA.pending, null); }
  const kb = think('how do I load the test run'); assert.equal(kb.kb, 'testrun'); assert.ok(!kb.actions.some((a) => a.label === 'Take me there'), 'no button into an owner-only place');
  assert.ok(!avaChipsFor(ctx()).some((c) => /money/i.test(c)));
  // the team still gets the shared answers
  assert.match(think('how many emails did Lakeview send').say, /412 emails/);
  assert.match(think('what needs me').say, /need the owner/);
  const conv = think("show Lakeview's conversations"); assert.ok(conv.auto);
});

/* ───────────── 6. ask first, then only open ───────────── */
test('actions: the owner is asked first — "yes" opens the add-a-client form, "no" does nothing; give access opens their Setup; the test run opens Settings; no emails or yes/no by voice', () => {
  setup('owner');
  let r = think('add a trial client');
  assert.equal(r.confirm, true); assert.ok(!r.auto);
  assert.ok(!el('modalWrap').classList.contains('open'), 'nothing opened before the yes');
  assert.ok(AVA.pending);
  r = think('no'); assert.ok(!r.auto); assert.equal(AVA.pending, null); assert.ok(!el('modalWrap').classList.contains('open'));
  think('add a new trial client'); r = think('yes please');
  assert.ok(r.auto); r.auto.run();
  assert.ok(el('modalWrap').classList.contains('open')); assert.match(el('modal').innerHTML, /Add a trial client yourself/);
  closeModal();
  // the Yes button does the same
  r = think('add a paying client'); const yes = r.actions.find((a) => a.yes); yes.run();
  assert.match(el('modal').innerHTML, /Add a paying client yourself/); assert.equal(AVA.pending, null); closeModal();
  r = think('give Lakeview access'); assert.equal(r.confirm, true); r = think('yes'); r.auto.run();
  assert.equal(currentView, 'clientSystem'); assert.equal(currentTrialId, 'lakeview-it'); assert.equal(trialTab, 'setup');
  assert.match(think('give access').say, /Which client\?/);
  r = think('remove the test run'); assert.equal(r.confirm, true); assert.match(r.say, /You press Remove the test run there yourself/); think('ok').auto.run();
  assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.demo, true);
  // a new question drops the pending one
  think('load the test run'); think('how many trials are running'); assert.equal(AVA.pending, null);
  for (const t of ['send an email to lakeview', 'say yes to fern it', 'approve the application']) { const q = think(t); assert.ok(!q.auto && !q.confirm, t); assert.match(q.say, /always takes your own click/, t); }
});

/* ───────────── 7. ears and mouth ───────────── */
test('no voice in this browser (Firefox): typing still works, with a note; the mic button says so', async () => {
  setup('owner');
  delete globalThis.SpeechRecognition; delete globalThis.webkitSpeechRecognition;
  assert.equal(avaCanListen(), false);
  avaOpen({ listen: true });
  assert.match(el('avaNote').textContent, /Voice isn't available in this browser — type your question/);
  assert.equal(avaListen(), false);
  assert.ok(el('avaInput')._focused || true);
  el('avaInput').value = 'how many emails did lakeview send';
  const r = await avaSubmit();
  assert.match(r.say, /412 emails/);
  assert.equal(el('avaInput').value, '', 'the box is emptied');
  assert.match(el('avaLog').innerHTML, /how many emails did lakeview send/);
  assert.match(el('avaLog').innerHTML, /Lakeview IT has sent 412 emails/);
  assert.ok(el('avaMic').classList.contains('off'));
  avaClose();
});

test('voice: listens in en-US with live words, answers what was said, speaks the answer (unless muted — remembered, and storage may fail)', async () => {
  setup('owner');
  const spoken = [];
  globalThis.SpeechSynthesisUtterance = function (t) { this.text = t; };
  globalThis.speechSynthesis = { speak: (u) => spoken.push(u.text), cancel() {}, getVoices: () => [{ name: 'Samantha', lang: 'en-US' }], addEventListener() {} };
  let rec;
  globalThis.webkitSpeechRecognition = function () { rec = this; this.start = () => { this.started = true; }; this.stop = () => { this.onend && this.onend(); }; };
  AVA.muted = null; localStorage.removeItem(AVA_MUTE_KEY);
  avaOpen({ listen: true });
  assert.ok(rec && rec.started, 'tap → listening'); assert.equal(rec.lang, 'en-US'); assert.equal(rec.interimResults, true);
  assert.ok(el('avaFab').classList.contains('listening'));
  const res = (text, isFinal) => { const r = [{ transcript: text }]; r.isFinal = isFinal; return r; };
  rec.onresult({ resultIndex: 0, results: [res('what needs', false)] });
  assert.match(el('avaHeard').textContent, /what needs/, 'words shown live');
  rec.onresult({ resultIndex: 0, results: [res('what needs me today', true)] });
  rec.onend(); await tick(); await tick();
  assert.equal(AVA.listening, false);
  assert.match(el('avaLog').innerHTML, /what needs me today/);
  assert.ok(spoken.some((s) => /things need you/.test(s)), 'the answer is spoken');
  // mute: nothing spoken, remembered on this device
  avaSetMute(true); assert.equal(localStorage.getItem(AVA_MUTE_KEY), '1');
  spoken.length = 0; await avaAsk('open trials'); assert.equal(spoken.length, 0);
  AVA.muted = null; assert.equal(avaMuted(), true, 'read back');
  avaSetMute(false);
  // storage that throws (private mode): no crash, voice on
  const ls = globalThis.localStorage; globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  try { AVA.muted = null; assert.equal(avaMuted(), false); avaSetMute(true); assert.equal(avaMuted(), true); } finally { globalThis.localStorage = ls; AVA.muted = false; }
  // a blocked microphone says what to do
  avaListen(); rec.onerror({ error: 'not-allowed' }); assert.match(el('avaNote').textContent, /microphone is blocked/);
  delete globalThis.webkitSpeechRecognition; delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance;
  avaClose();
});

/* ───────────── 8. the panel ───────────── */
test('panel: shown only when signed in; the greeting by first name with chips; Ctrl/⌘+J toggles, Esc closes (not while a form is open); "Ask Ava" in ⌘K; answers are aria-live', () => {
  setup('owner');
  avaSync(); assert.equal(el('avaRoot').hidden, false);
  assert.match(el('avaRoot').innerHTML, /class="ava-fab"[^>]*aria-label="Ask Ava/);
  assert.match(el('avaRoot').innerHTML, /id="avaLog" role="log" aria-live="polite"/);
  assert.match(el('avaRoot').innerHTML, /<label class="ava-sr" for="avaInput">Ask Ava<\/label>/);
  AVA.greeted = false; AVA.log = [];
  const key = (k, mod) => { const e = Object.assign({ key: k, target: { tagName: 'BODY' }, preventDefault() { e.prevented = true; } }, mod || {}); docListeners.keydown.forEach((fn) => fn(e)); return e; };
  const e = key('j', { ctrlKey: true });
  assert.ok(e.prevented); assert.equal(AVA.open, true); assert.equal(el('avaPanel').hidden, false);
  assert.equal(el('avaFab').getAttribute('aria-expanded'), 'true');
  assert.match(AVA.log[0].text, /^Hi Limeth, I'm Ava\. Ask me anything about the hub — like 'what needs me today' or 'open /);
  assert.ok(AVA.log[0].chips.length >= 4);
  assert.match(el('avaLog').innerHTML, /class="ava-chip" onclick="avaChip\(0\)">What needs me today\?/);
  key('j', { metaKey: true }); assert.equal(AVA.open, false);
  avaOpen({}); openModal('<p>x</p>'); key('Escape'); assert.equal(AVA.open, true, 'Esc closes the form first');
  closeModal(); key('Escape'); assert.equal(AVA.open, false); assert.ok(el('avaFab')._focused, 'focus back on the button');
  const ask = cmdkActions()[0]; assert.equal(ask.label, 'Ask Ava'); ask.run(); assert.equal(AVA.open, true); avaClose();
  // an answer's buttons run from the panel
  AVA.log = []; avaPush({ who: 'ava', text: 'x', actions: [avaPlace('calendar')] });
  assert.match(el('avaLog').innerHTML, /onclick="avaRun\(0\)">Open Calendar</);
  avaRun(0); assert.equal(currentView, 'calendar');
  // signed out: hidden, forgotten
  authUser = null; avaSync(); assert.equal(el('avaRoot').hidden, true); assert.equal(AVA.log.length, 0);
  key('j', { ctrlKey: true }); assert.equal(AVA.open, false, 'nothing while signed out');
  asOwner();
});

test('the brain is pluggable: avaAsk awaits whatever avaThink returns (a promise works), and loads the board first when it is missing', async () => {
  setup('owner');
  const orig = avaThink;
  try {
    avaThink = async (text) => ({ say: 'From another brain: ' + text, actions: [] });
    const r = await avaAsk('hello there'); assert.equal(r.say, 'From another brain: hello there');
  } finally { avaThink = orig; }
  // the board missing: Ava asks for it (the hub's normal call) before answering
  const calls = []; tk.hub = null; tk.hubAt = 0;
  globalThis.fetch = async (url) => { calls.push(String(url)); if (String(url).endsWith('/api/mc/hub')) return { ok: true, status: 200, text: async () => JSON.stringify(freshHub()) }; throw new TypeError('Failed to fetch'); };
  try { const r = await avaAsk('how many emails did lakeview send'); assert.ok(calls.some((u) => u.endsWith('/api/mc/hub'))); assert.match(r.say, /412 emails/); }
  finally { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; }
});

test('one global script: ava.js declares no name another file already has; every name starts with ava/AVA', () => {
  const sources = { 'index.html': shell };
  for (const f of FILES) sources[f] = fs.readFileSync(path.join(root, f), 'utf8');
  const seen = {};
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) (seen[m[1]] ||= []).push(file);
    for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) (seen[m[1]] ||= []).push(file);
  }
  const dup = Object.entries(seen).filter(([, w]) => w.length > 1 && w.includes('ava.js')).map(([n, w]) => n + ' (' + w.join(', ') + ')');
  assert.deepEqual(dup, []);
  const mine = Object.entries(seen).filter(([, w]) => w.includes('ava.js')).map(([n]) => n);
  assert.ok(mine.length > 50 && mine.every((n) => /^(ava|AVA)/.test(n)), mine.filter((n) => !/^(ava|AVA)/.test(n)).join(', '));
  // index.html: only the link, the mount and the script
  assert.ok(html.includes('<link rel="stylesheet" href="ava.css">') && html.includes('<div id="avaRoot" hidden></div>\n<script src="ava.js"></script>'));
});
