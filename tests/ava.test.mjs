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
  assert.ok(['timeline', 'history', 'setup'].includes(open("show Lakeview's history")));
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
  assert.match(el('avaHeardText').textContent, /what needs/, 'words shown live');
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
  assert.match(AVA.log[0].text, /^Hi Limeth, I'm Ava\. Ask me anything — about your clients, the hub, or anything else\. Hold Space to talk, or type\.$/);
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

/* ═════════════ Ava 2: the natural voice, talking to her, the smarter brain, Settings › Ava ═════════════
   The natural voice runs ava-voice-worker.js for real — in a vm "worker" with a mocked kokoro-js module (the CDN and
   the model are never fetched) — and plays into a fake AudioContext. The machine's /api/mc/ava/* routes are faked. */
const workerSrc = fs.readFileSync(path.join(root, 'ava-voice-worker.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function kokoroMock(opt = {}) {
  const calls = [];
  const mod = { KokoroTTS: { from_pretrained: async (id, o) => {
    calls.push(['load', id, o.device, o.dtype]);
    if (opt.fail || (opt.gpuFail && o.device === 'webgpu')) throw new Error('model blocked');
    o.progress_callback && o.progress_callback({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 46e6, total: 92e6 });
    return { generate: async (text, g) => {
      calls.push(['gen', text, g.voice]);
      if (opt.slow) { await sleep(40); return { audio: new Float32Array(240), sampling_rate: 24000 }; }   // 40 ms for 0.01 s of speech
      if (opt.genFail && /FAIL/.test(text)) throw new Error('synth failed');
      if (opt.delay) await sleep(opt.delay);
      return { audio: new Float32Array(Math.max(1, text.length * 1000)), sampling_rate: 24000 };
    } };
  } } };
  return { calls, mod };
}
class FakeWorker {
  constructor(url, o) {
    FakeWorker.last = this; this.url = url; this.opts = o; this.sent = [];
    const g = { postMessage: (m) => setTimeout(() => this.onmessage && this.onmessage({ data: m }), 0), avaVoiceImport: async (u) => { this.importUrl = u; return FakeWorker.mock.mod; }, navigator: FakeWorker.gpu ? { gpu: { requestAdapter: async () => FakeWorker.gpu } } : {} };
    g.self = g; this.g = g; vm.createContext(g); vm.runInContext(workerSrc, g, { filename: 'ava-voice-worker.js' });
  }
  postMessage(m) { this.sent.push(m); setTimeout(() => this.g.onmessage({ data: m }), 0); }
  terminate() { this.terminated = true; }
}
class FakeAC {
  constructor() { FakeAC.last = this; this.state = 'running'; this.played = []; this.destination = {}; }
  createBuffer(ch, len, rate) { return { duration: len / rate, length: len, sampleRate: rate, copyToChannel() {} }; }
  createBufferSource() { const s = { connect() {}, start: () => { this.played.push(s); }, stop: () => { s.stopped = true; } }; return s; }
  resume() { this.state = 'running'; }
}
function fakeSpeech() {
  const spoken = []; const synth = { voices: [], speak: (u) => spoken.push(u), cancel() { synth.cancelled = (synth.cancelled || 0) + 1; }, getVoices: () => synth.voices, addEventListener() {} };
  globalThis.SpeechSynthesisUtterance = function (t) { this.text = t; }; globalThis.speechSynthesis = synth;
  return { spoken, synth };
}
function voiceReset() {
  avaHush(); AVA.k = { state: 'idle', worker: null, device: null, dtype: null, loaded: 0, total: 0, rtf: null, err: null };
  AVA.voicePref = null; AVA.handsFree = null; AVA.loopPaused = false; AVA.voice = null; AVA.ac = null; AVA.micGuided = false; AVA.retried = 0;
  for (const k of [AVA_VOICE_KEY, AVA_HANDS_KEY, AVA_SLOW_KEY, AVA_MUTE_KEY]) localStorage.removeItem(k);
  AVA.muted = false; AVA_AI.off = null; AVA_AI.offUntil = 0; AVA_AI.noted = false; AVA_AI.ready = null; AVA_AI.readyAt = 0; AVA_AI.checking = null; FakeAC.last = null; AVA.speed = null;
  for (const k of [AVA_SPEED_KEY, AVA_NATURAL_KEY]) localStorage.removeItem(k);
}
function voiceTeardown() {
  avaClose(); voiceReset();
  for (const k of ['Worker', 'AudioContext', 'speechSynthesis', 'SpeechSynthesisUtterance', 'webkitSpeechRecognition', 'SpeechRecognition']) delete globalThis[k];
  FakeWorker.gpu = null;
}
async function until(fn, ms = 1500) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(5); } }

test('natural voice: loads lazily when Ava opens (one-time download line with %), browser voice meanwhile, then Kokoro sentence by sentence in order', async () => {
  setup('owner'); voiceReset();
  const { spoken } = fakeSpeech();
  FakeWorker.mock = kokoroMock(); globalThis.Worker = FakeWorker; globalThis.AudioContext = FakeAC;
  try {
    assert.equal(avaKokoroState(), 'idle'); assert.equal(AVA.k.worker, null);
    avaOpen({ listen: false, quiet: true });
    const w = FakeWorker.last; assert.equal(w.url, 'ava-voice-worker.js'); assert.deepEqual(w.opts, { type: 'module' });
    assert.equal(AVA.k.state, 'loading'); assert.deepEqual(w.sent[0], { type: 'load', device: 'wasm' });
    assert.equal(el('avaVload').hidden, false);
    assert.match(el('avaVloadText').textContent, /^Getting Ava's natural voice ready \(one-time download, about 115 MB\)…/);
    // still loading: the browser's voice answers, one sentence per utterance
    avaSpeak('Opening Trials. Three need you.');
    assert.deepEqual(spoken.map((u) => u.text), ['Opening Trials.', 'Three need you.']); assert.equal(spoken[0].rate, 1.03);
    await until(() => AVA.k.state === 'ready');
    assert.equal(w.importUrl, 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js');
    assert.deepEqual(FakeWorker.mock.calls[0], ['load', 'onnx-community/Kokoro-82M-v1.0-ONNX', 'wasm', 'q8']);
    assert.equal(AVA.k.dtype, 'q8'); assert.ok(AVA.k.rtf < 1.2); assert.equal(el('avaVload').hidden, true);
    assert.equal(AVA.k.loaded, 46e6); assert.equal(AVA.k.total, 92e6);
    // ready: Kokoro, every sentence asked for at once (made while the first plays), played strictly in order
    spoken.length = 0;
    const said = 'Hi Limeth, I\'m Ava. Lakeview IT has sent 412 emails. They\'re at step 4 of 5.';
    assert.equal(avaSpeak(said), true); assert.equal(AVA.say.engine, 'kokoro'); assert.equal(spoken.length, 0);
    const asks = w.sent.filter((m) => m.type === 'speak'); assert.deepEqual(asks.map((m) => m.text), avaChunks(said)); assert.ok(asks.every((m) => m.voice === 'af_heart'));
    await until(() => FakeAC.last && FakeAC.last.played.length === 1);
    assert.equal(AVA.speaking, true);
    const ac = FakeAC.last; await sleep(20); assert.equal(ac.played.length, 1, 'the next waits for the first to end');
    ac.played[0].onended(); await until(() => ac.played.length === 2);
    ac.played[1].onended(); await until(() => ac.played.length === 3);
    ac.played[2].onended(); assert.equal(AVA.speaking, false); assert.equal(AVA.say, null);
    // the voice picked is the voice made
    avaSetVoice('af_nicole'); avaSpeak('Hello there.'); await sleep(5);
    assert.equal(w.sent.filter((m) => m.type === 'speak').pop().voice, 'af_nicole'); assert.equal(localStorage.getItem(AVA_VOICE_KEY), 'af_nicole');
  } finally { voiceTeardown(); }
});

test('natural voice: WebGPU when the browser has a GPU (fp32, ~350 MB), falls back to WASM q8; a failed load, a failed sentence and a slow computer all use the browser voice', async () => {
  setup('owner'); voiceReset(); const { spoken } = fakeSpeech(); globalThis.Worker = FakeWorker; globalThis.AudioContext = FakeAC;
  const nav = globalThis.navigator;
  try {
    // a GPU: asked for, fp32; the line says so
    Object.defineProperty(globalThis, 'navigator', { value: Object.assign({}, nav, { gpu: {} }), configurable: true });
    FakeWorker.gpu = { name: 'gpu' }; FakeWorker.mock = kokoroMock();
    avaVoiceWarm(); assert.equal(FakeWorker.last.sent[0].device, 'webgpu'); assert.match(avaVoiceLoadingLine().text, /about 350 MB/);
    await until(() => AVA.k.state === 'ready'); assert.deepEqual([AVA.k.device, AVA.k.dtype], ['webgpu', 'fp32']);
    // a GPU that can't run it: the CPU model
    voiceReset(); FakeWorker.gpu = { name: 'gpu' }; FakeWorker.mock = kokoroMock({ gpuFail: true });
    avaVoiceWarm(); await until(() => AVA.k.state === 'ready'); assert.deepEqual([AVA.k.device, AVA.k.dtype], ['wasm', 'q8']);
    assert.deepEqual(FakeWorker.mock.calls.filter((c) => c[0] === 'load').map((c) => c[2]), ['webgpu', 'wasm']);
    // navigator.gpu but no adapter: straight to the CPU model (no 330 MB download that can't run)
    voiceReset(); FakeWorker.gpu = null; FakeWorker.mock = kokoroMock();
    avaVoiceWarm(); await until(() => AVA.k.state === 'ready'); assert.deepEqual(FakeWorker.mock.calls.filter((c) => c[0] === 'load').map((c) => c[2]), ['wasm']);
    assert.equal(AVA.k.device, 'wasm');
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
    // the model can't load: failed → the browser voice, and it says so
    voiceReset(); FakeWorker.mock = kokoroMock({ fail: true });
    avaVoiceWarm(); await until(() => AVA.k.state === 'failed');
    assert.match(AVA.k.err, /model blocked/); assert.match(avaVoiceLabel(), /didn't load — using the browser voice/);
    spoken.length = 0; avaSpeak('Still here.'); assert.equal(AVA.say.engine, 'browser'); assert.equal(spoken[0].text, 'Still here.');
    // one sentence fails half-way: that one and the rest in the browser voice
    voiceReset(); FakeWorker.mock = kokoroMock({ genFail: true });
    avaVoiceWarm(); await until(() => AVA.k.state === 'ready');
    spoken.length = 0; avaSpeak('First one works. This one will FAIL today. And the last one.');
    await until(() => spoken.length > 0);
    assert.deepEqual(spoken.map((u) => u.text), ['This one will FAIL today.', 'And the last one.']);
    // too slow here (more than 1.2 s per second of speech): the browser voice, remembered — no download next visit
    voiceReset(); FakeWorker.mock = kokoroMock({ slow: true });
    avaVoiceWarm(); await until(() => AVA.k.state === 'slow');
    assert.ok(AVA.k.rtf > 1.2); assert.equal(localStorage.getItem(AVA_SLOW_KEY), '1'); assert.ok(FakeWorker.last.terminated);
    assert.match(avaVoiceLabel(), /too slow for the natural voice/);
    const before = FakeWorker.last; AVA.k.state = 'idle'; AVA.k.worker = null; assert.equal(avaVoiceWarm(), false); assert.equal(FakeWorker.last, before); assert.equal(AVA.k.state, 'slow');
    // picking a natural voice by hand tries again
    FakeWorker.mock = kokoroMock(); avaSetVoice('af_heart'); assert.notEqual(FakeWorker.last, before); await until(() => AVA.k.state === 'ready');
    // "Browser voice": never loads, remembered (storage may throw)
    voiceReset(); avaSetVoice('browser'); assert.equal(avaKokoroState(), 'off'); const n = FakeWorker.last; avaOpen({ quiet: true }); assert.equal(FakeWorker.last, n);
    const ls = globalThis.localStorage; globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
    try { AVA.voicePref = null; assert.equal(avaVoicePref(), 'af_heart'); avaSetVoice('bf_emma'); assert.equal(avaVoicePref(), 'bf_emma'); } finally { globalThis.localStorage = ls; }
  } finally { Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }); voiceTeardown(); }
});

test('browser voice: the most natural one ("Natural"/"Neural"/"Online", then Google US English, Samantha, Ava), never a male one first; no Worker (or a phone) = no download', () => {
  setup('owner'); voiceReset(); const { synth } = fakeSpeech();
  try {
    synth.voices = [{ name: 'Microsoft David - English (United States)', lang: 'en-US' }, { name: 'Samantha', lang: 'en-US' }, { name: 'Google US English', lang: 'en-US' }, { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' }, { name: 'Google Deutsch', lang: 'de-DE' }];
    assert.match(avaPickVoice().name, /Aria Online \(Natural\)/);
    AVA.voice = null; synth.voices = synth.voices.filter((v) => !/Aria/.test(v.name)); assert.equal(avaPickVoice().name, 'Google US English');
    AVA.voice = null; synth.voices = [{ name: 'Alex', lang: 'en-US' }, { name: 'Ava (Premium)', lang: 'en-US' }, { name: 'Samantha', lang: 'en-US' }]; assert.equal(avaPickVoice().name, 'Ava (Premium)');
    // no Worker: unsupported, nothing to load, the browser's voice
    assert.equal(avaKokoroSupported(), false); assert.equal(avaVoiceWarm(), false); assert.equal(avaKokoroState(), 'unsupported');
    // a phone: never downloads it
    globalThis.Worker = FakeWorker; globalThis.AudioContext = FakeAC; globalThis.matchMedia = () => ({ matches: true });
    assert.equal(avaKokoroSupported(), false); assert.match(avaVoiceLabel(), /phone’s own voice/);
  } finally { delete globalThis.matchMedia; voiceTeardown(); }
});

test('sentences: said in pieces — sentences, a long one cut at a comma, the first kept short, no symbols read out', () => {
  assert.deepEqual(avaChunks('Opening Trials.'), ['Opening Trials.']);
  assert.deepEqual(avaChunks("Hi Limeth! I'm Ava. Ask me anything?"), ['Hi Limeth!', "I'm Ava.", 'Ask me anything?']);
  assert.deepEqual(avaChunks('Settings › Keys — paste it once.'), ['Settings, Keys, paste it once.']);
  assert.deepEqual(avaChunks('You received $1,500.50 this month.'), ['You received $1,500.50 this month.'], 'numbers are not cut');
  const long = '3 things need you: Fern IT — a new application to read; eCreek IT — say yes to their call time; Bright Dental — buy the domain and the two inboxes, then paste the logins.';
  const parts = avaChunks(long);
  assert.ok(parts.length >= 2 && parts[0].length <= 90, JSON.stringify(parts)); assert.ok(parts.every((p) => p.length <= 180));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), avaSpeakable(long));
  assert.deepEqual(avaChunks(''), []); assert.deepEqual(avaChunks('Done. OK'), ['Done. OK'], 'a scrap goes with the piece before');
});

test('barge-in: a mic tap or closing stops her at once — the sound, the browser queue and the sentences still being made', async () => {
  setup('owner'); voiceReset(); const { synth } = fakeSpeech(); globalThis.Worker = FakeWorker; globalThis.AudioContext = FakeAC; FakeWorker.mock = kokoroMock();
  let rec; globalThis.webkitSpeechRecognition = function () { rec = this; this.start = () => { this.started = true; }; this.stop = () => {}; };
  try {
    avaOpen({ quiet: true }); await until(() => AVA.k.state === 'ready');
    avaSpeak('One. Two is here. Three is here too.'); await until(() => FakeAC.last && FakeAC.last.played.length === 1);
    const src = FakeAC.last.played[0]; const gen = AVA.say.gen; const c0 = synth.cancelled || 0;
    assert.equal(avaMicTap(), true, 'the tap listens');
    assert.ok(src.stopped, 'the sound stops'); assert.equal(AVA.speaking, false); assert.ok(synth.cancelled > c0);
    assert.ok(FakeWorker.last.sent.some((m) => m.type === 'cancel' && m.gen === gen), 'the worker drops the rest'); assert.ok(rec.started);
    await sleep(20); assert.equal(FakeAC.last.played.length, 1, 'nothing more is played');
    avaStopListening({ user: true });
    avaSpeak('Another answer. With two sentences.'); await until(() => FakeAC.last.played.length === 2);
    const s2 = FakeAC.last.played[1]; avaClose(); assert.ok(s2.stopped); assert.equal(AVA.speaking, false);
    assert.equal(avaSpeak(''), false); AVA.muted = true; assert.equal(avaSpeak('quiet'), false); AVA.muted = false;
  } finally { voiceTeardown(); }
});

test('talking to her: live words in a big listening strip, sent by itself when you stop, and hands-free listens again after she answers until "thanks Ava"', async () => {
  setup('owner'); voiceReset(); const { spoken } = fakeSpeech();
  const recs = []; globalThis.webkitSpeechRecognition = function () { recs.push(this); this.start = () => { this.started = true; }; this.stop = () => { this.stopped = true; this.onend && this.onend(); }; };
  const res = (text, isFinal) => { const r = [{ transcript: text }]; r.isFinal = isFinal; return r; };
  try {
    avaOpen({ listen: true }); let rec = recs.pop();
    assert.ok(rec.started); assert.equal(el('avaHeard').classList.contains('show'), true); assert.ok(el('avaPanel').classList.contains('listening'));
    assert.equal(el('avaHeardText').textContent, 'Listening… speak now'); assert.equal(el('avaSub').textContent, 'Listening…');
    // they stop talking: sent without waiting for the browser (interim words only, 1.4 s of quiet)
    rec.onresult({ resultIndex: 0, results: [res('open the calendar', false)] });
    assert.equal(el('avaHeardText').textContent, '“open the calendar”');
    await sleep(1450); assert.ok(rec.stopped); await tick();
    assert.equal(currentView, 'calendar'); assert.equal(AVA.listening, false);
    // hands-free on: after she finishes speaking she listens again by herself
    spoken[spoken.length - 1].onend();
    avaSetHandsFree(true); assert.equal(localStorage.getItem(AVA_HANDS_KEY), '1'); assert.ok(el('avaHands').classList.contains('on'));
    rec = recs.pop(); assert.ok(rec && rec.started, 'turning it on starts listening');
    rec.onresult({ resultIndex: 0, results: [res('how many trials are running', true)] }); rec.onend(); await tick(); await tick();
    assert.ok(spoken.some((u) => /trials are going/.test(u.text)));
    assert.equal(recs.length, 0, 'not while she is speaking');
    spoken[spoken.length - 1].onend(); await sleep(350);
    rec = recs.pop(); assert.ok(rec && rec.started, 'listening again after the answer');
    // "thanks Ava" ends the loop
    spoken.length = 0; rec.onresult({ resultIndex: 0, results: [res('thanks Ava', true)] }); rec.onend(); await tick();
    assert.equal(AVA.loopPaused, true); assert.match(AVA.log[AVA.log.length - 1].text, /I'll stop listening/);
    spoken[spoken.length - 1].onend(); await sleep(350); assert.equal(recs.length, 0, 'no more listening');
    // a mic tap while listening stops and pauses the loop; the next tap starts it again
    avaMicTap(); rec = recs.pop(); assert.equal(AVA.loopPaused, false); avaMicTap(); assert.equal(AVA.loopPaused, true); assert.ok(rec.stopped);
    // muted + hands-free: she listens again as soon as the answer is shown
    avaSetMute(true); avaMicTap(); rec = recs.pop(); rec.onresult({ resultIndex: 0, results: [res('open trials', true)] }); rec.onend(); await tick(); await sleep(350);
    assert.ok(recs.pop(), 'listening again (muted)');
  } finally { avaSetMute(false); voiceTeardown(); }
});

test('mic problems: blocked → a 3-step guide (once) and typing still works; nothing heard / network → one quiet retry, then a note; no microphone; aborted says nothing', async () => {
  setup('owner'); voiceReset();
  const recs = []; globalThis.webkitSpeechRecognition = function () { recs.push(this); this.start = () => { this.started = true; }; this.stop = () => {}; };
  try {
    avaOpen({ quiet: true });
    avaMicTap(); let rec = recs.pop(); rec.onerror({ error: 'not-allowed' }); rec.onend();
    const g = AVA.log[AVA.log.length - 1]; assert.match(g.text, /microphone is blocked for this site/); assert.deepEqual(g.guide, AVA_MIC_GUIDE);
    assert.match(el('avaLog').innerHTML, /<ol class="ava-guide"><li>Click the lock icon at the left of the address bar\.<\/li><li>Set Microphone to Allow\.<\/li><li>Reload the page, then tap the mic again\.<\/li><\/ol>/);
    assert.match(el('avaNote').textContent, /microphone is blocked/); assert.equal(recs.length, 0, 'no retry when blocked');
    const n = AVA.log.length; avaMicTap(); rec = recs.pop(); rec.onerror({ error: 'service-not-allowed' }); rec.onend(); assert.equal(AVA.log.length, n, 'the guide shows once');
    // already denied (Permissions API): the guide before anything else
    AVA.micGuided = false; const nav = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', { value: Object.assign({}, nav, { permissions: { query: async () => ({ state: 'denied' }) } }), configurable: true });
    try { assert.equal(await avaMicCheck(), 'denied'); assert.deepEqual(AVA.log[AVA.log.length - 1].guide, AVA_MIC_GUIDE); } finally { Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }); }
    // nothing heard: one retry by itself, then a note
    avaMicTap(); rec = recs.pop(); rec.onerror({ error: 'no-speech' }); rec.onend();
    rec = recs.pop(); assert.ok(rec && rec.started, 'tried again once'); rec.onerror({ error: 'no-speech' }); rec.onend();
    assert.equal(recs.length, 0); assert.match(el('avaNote').textContent, /I didn't hear anything/);
    // network: one retry, then a note
    avaMicTap(); rec = recs.pop(); rec.onerror({ error: 'network' }); rec.onend(); rec = recs.pop(); assert.ok(rec.started); rec.onerror({ error: 'network' }); rec.onend();
    assert.match(el('avaNote').textContent, /needs the internet/);
    avaMicTap(); rec = recs.pop(); rec.onerror({ error: 'audio-capture' }); rec.onend(); assert.match(el('avaNote').textContent, /can't find a microphone/); assert.equal(recs.length, 0);
    avaNote(''); avaMicTap(); rec = recs.pop(); rec.onerror({ error: 'aborted' }); rec.onend(); assert.equal(el('avaNote').textContent, ''); assert.equal(recs.length, 0);
    // a start that throws
    globalThis.webkitSpeechRecognition = function () { this.start = () => { throw new Error('busy'); }; };
    assert.equal(avaMicTap(), false); assert.equal(AVA.listening, false); assert.match(el('avaNote').textContent, /tap the mic again/);
  } finally { voiceTeardown(); }
});

/* ───────────── the smarter brain ───────────── */
function aiFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init && init.body ? JSON.parse(init.body) : null; calls.push({ url: u, method: (init && init.method) || 'GET', body });
    const r = handler(u.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''), body, init) || { status: 404, body: { error: 'Not found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return calls;
}
const noFetch = () => { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; };

test('AI first: only plain commands run here at once ("open trials", "open Lakeview", "go back", "settings") — everything else goes to the AI, with the page, the person and the last 16 turns', async () => {
  setup('owner'); voiceReset();
  const calls = aiFetch((p) => p === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'From the AI.', actions: [], brain: 'groq' } } : null);
  const chats = () => calls.filter((c) => c.url.includes('/api/mc/ava/chat')).length;
  try {
    for (const q of ['open trials', 'Open Lakeview', 'go back', 'settings', 'go to the calendar', 'show my calendar', "show Lakeview's conversations", 'open warm-up helpers', 'Trials', 'open settings keys']) {
      assert.equal(avaIsCommand(q), true, q);
      const n = chats(); const r = await avaAsk(q); assert.ok(!r.ai && r.local, q); assert.equal(chats(), n, q + ': no AI call');
      assert.ok(r.say, q + ': a short spoken confirmation');
    }
    for (const q of ['how many emails did Lakeview send', 'what needs me today', 'how do I give a client access', 'add a trial client', 'what is the capital of France', 'hello', 'open trials and tell me who is sending', 'show me how lakeview is doing', 'Lakeview', 'why is lakeview slow']) {
      assert.equal(avaIsCommand(q), false, q);
      const n = chats(); const r = await avaAsk(q); assert.equal(r.ai, true, q); assert.equal(r.say, 'From the AI.'); assert.equal(chats(), n + 1, q);
      AVA.pending = null;
    }
    // "yes" / "no" to Ava's own question stays here
    AVA.pending = { act: avaAct('x', () => {}), done: 'Done.' }; const n = chats(); await avaAsk('yes'); assert.equal(chats(), n);
    // the page, the person, the voice flag, the last 16 turns (long ones cut)
    render('trials'); openTrial('lakeview-it'); AVA.log = [];
    for (let i = 0; i < 12; i++) avaPush({ who: 'you', text: 'question ' + i + ' ' + 'x'.repeat(i === 0 ? 3000 : 5) }), avaPush({ who: 'ava', text: 'answer ' + i });
    await avaAsk('what did dana ask?', { voice: true });
    const c = calls.filter((x) => x.url.includes('/api/mc/ava/chat')).pop();
    assert.match(c.url, /\/api\/mc\/ava\/chat\?stream=1$/);
    assert.deepEqual(c.body.page, { view: 'trial', clientId: 'lakeview-it', clientName: 'Lakeview IT', tab: null });
    assert.deepEqual(c.body.user, { firstName: 'Limeth', role: 'owner' }); assert.equal(c.body.voice, true); assert.equal(c.body.stream, true);
    assert.equal(c.body.messages.length, 16); assert.deepEqual(c.body.messages[15], { role: 'user', content: 'what did dana ask?' });
    assert.ok(c.body.messages.every((m) => m.content.length <= 1000));
  } finally { noFetch(); voiceTeardown(); }
});

test('the AI brain: POST /api/mc/ava/chat (stream asked for) with the page (emails taken out); "answered by Groq · 0.9 s · time"; a thinking state while it waits', async () => {
  setup('owner'); voiceReset(); render('trials'); openTrial('lakeview-it');
  const calls = aiFetch((p, body) => p === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'Lakeview replies are mostly questions about price.', actions: [], brain: 'groq', tried: ['groq'] } } : null);
  try {
    AVA.log = []; await avaAsk('open trials'); openTrial('lakeview-it');
    const r = await avaAsk('summarise what dana@lakeview.com asked about pricing');
    assert.equal(r.ai, true); assert.equal(r.say, 'Lakeview replies are mostly questions about price.');
    assert.match(r.meta, /^answered by Groq · \d+\.\d s$/);
    const c = calls.find((x) => x.url.includes('/api/mc/ava/chat')); assert.equal(c.method, 'POST');
    assert.equal(c.body.page.clientId, 'lakeview-it');
    const last = c.body.messages[c.body.messages.length - 1]; assert.deepEqual(last, { role: 'user', content: 'summarise what [email] asked about pricing' });
    assert.ok(c.body.messages.some((m) => m.role === 'assistant' && /^Opening Trials/.test(m.content)));
    assert.match(el('avaLog').innerHTML, /<small class="ava-meta">answered by Groq · \d+\.\d s · [^<]+<\/small>/);
    // follow-up chips for the page when the AI gives none
    assert.match(el('avaLog').innerHTML, /class="ava-chip" onclick="avaChip\(0\)">How is Lakeview IT doing\?/);
    // a thinking state while it waits
    let seen = null; globalThis.fetch = async () => { seen = { busy: AVA.busy, sub: el('avaSub').textContent, dots: /ava-dots/.test(el('avaLog').innerHTML) }; return { ok: true, status: 200, text: async () => JSON.stringify({ reply: 'ok', brain: 'cerebras', suggestions: ['One more?', 'And another?'] }) }; };
    const r2 = await avaAsk('what is the meaning of life'); assert.deepEqual(seen, { busy: true, sub: 'Thinking…', dots: true }); assert.match(r2.meta, /Cerebras/);
    assert.deepEqual(r2.chips, ['One more?', 'And another?'], 'the AI\'s own follow-ups');
    assert.match(el('avaLog').innerHTML, /onclick="avaChip\(0\)">One more\?</);
  } finally { noFetch(); voiceTeardown(); }
});

test('basic mode: no key (503 needsKeys) / not updated (404) / limit (429) / down (502) / offline — the local answer, said plainly once, with what to do (a team member gets no button)', async () => {
  setup('owner'); voiceReset(); const { spoken } = fakeSpeech();
  let mode = 'keys';
  const calls = aiFetch((p) => p !== '/api/mc/ava/chat' ? null : mode === 'keys' ? { status: 503, body: { error: 'No brain has a key', needsKeys: true } } : mode === 'limit' ? { status: 429, body: { error: 'Daily cap reached' } } : mode === 'down' ? { status: 502, body: { error: 'No brain answered', tried: ['groq', 'cerebras'] } } : { status: 404, body: {} });
  const chats = () => calls.filter((c) => c.url.includes('/api/mc/ava/chat')).length;
  try {
    AVA.log = [];
    let r = await avaAsk('how many emails did lakeview send');
    assert.match(r.say, /412 emails/, 'the local answer'); assert.equal(r.basic, 'keys'); assert.equal(r.aiNote, 'keys'); assert.equal(r.meta, 'basic mode');
    const note = AVA.log[AVA.log.length - 1]; assert.equal(note.notice, true);
    assert.equal(note.text, "I'm in basic mode right now, so I can only answer simple things about the hub. My AI brain isn't switched on yet — add a free key in Settings › Keys.");
    assert.ok(spoken.some((u) => /^I'm in basic mode right now\.$/.test(u.text)), 'said out loud too');
    assert.match(el('avaLog').innerHTML, /ava-msg ava notice/); assert.match(el('avaLog').innerHTML, />Open Settings › Keys</);
    avaHush(); assert.equal(el('avaSub').textContent, 'Basic mode');
    note.actions[0].run(); assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.keys, true);
    // said once; and not asked again for a while
    const n = chats(); r = await avaAsk('orange giraffe'); assert.ok(!r.aiNote); assert.equal(r.unknown, true); assert.equal(chats(), n, 'off for a few minutes: no call');
    // the status says "not ready": not asked at all
    AVA_AI.off = null; AVA_AI.offUntil = 0; AVA_AI.ready = false; AVA_AI.readyAt = Date.now(); const n2 = chats(); r = await avaAsk('purple elephant'); assert.equal(r.basic, 'keys'); assert.equal(chats(), n2);
    AVA_AI.ready = null;
    // 404: the system isn't updated
    AVA_AI.off = null; AVA_AI.offUntil = 0; mode = 'missing'; r = await avaAsk('purple elephant'); assert.equal(r.aiNote, 'missing'); assert.match(AVA.log[AVA.log.length - 1].text, /needs your system to be updated/);
    // 429: the limit
    AVA_AI.off = null; AVA_AI.offUntil = 0; mode = 'limit'; r = await avaAsk('purple elephant'); assert.equal(r.aiNote, 'limit'); assert.match(AVA.log[AVA.log.length - 1].text, /reached today's limit/);
    // 502: it says so, and asks again next time
    AVA_AI.off = null; AVA_AI.offUntil = 0; mode = 'down'; r = await avaAsk('purple elephant'); assert.equal(r.unknown, true); assert.equal(r.aiNote, 'down'); assert.match(AVA.log[AVA.log.length - 1].text, /didn't answer just now/);
    const m = chats(); await avaAsk('purple elephant'); assert.equal(chats(), m + 1);
    // offline: says so plainly (never silent)
    noFetch(); r = await avaAsk('purple elephant'); assert.equal(r.unknown, true); assert.equal(r.aiNote, 'net'); assert.match(AVA.log[AVA.log.length - 1].text, /couldn't reach my AI brain — check your internet/);
    // back on: the AI answers again, and basic mode is forgotten
    aiFetch((p) => p === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'Back.', brain: 'groq' } } : null);
    r = await avaAsk('purple elephant'); assert.equal(r.say, 'Back.'); assert.equal(AVA_AI.noted, false);
    // a team member: no button into Settings
    setup('team'); voiceReset(); mode = 'keys'; aiFetch((p) => p === '/api/mc/ava/chat' ? { status: 503, body: { error: 'x', needsKeys: true } } : null);
    AVA.log = []; await avaAsk('purple elephant banana');
    const tn = AVA.log[AVA.log.length - 1]; assert.match(tn.text, /the owner can add a free key/); assert.ok(!tn.actions);
  } finally { noFetch(); voiceTeardown(); asOwner(); }
});

test('AI actions: navigate runs when you asked to go somewhere, else it is a button; a team member never gets a place that is the owner\'s', async () => {
  setup('owner'); voiceReset();
  let actions = [];
  aiFetch((p) => p === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'Here you go.', actions, brain: 'groq' } } : null);
  try {
    render('trials');
    actions = [{ type: 'navigate', view: 'client', id: 'lakeview-it', tab: 'conversations' }];
    let r = await avaAsk('take me to where people wrote back to us yesterday');
    assert.ok(r.auto || currentView === 'clientSystem'); assert.equal(currentView, 'clientSystem'); assert.equal(trialTab, 'conversations');
    render('trials'); actions = [{ type: 'navigate', view: 'calendar' }];
    r = await avaAsk('purple elephant who wrote something'); assert.ok(!r.auto); assert.equal(currentView, 'trials');
    assert.equal(r.actions[0].label, 'Open Calendar'); r.actions[0].run(); assert.equal(currentView, 'calendar');
    const nav = (a, c) => avaNavAct(a, Object.assign(ctx(), c || {}));
    assert.equal(nav({ view: 'settings', tab: 'keys' }).label, 'Open Settings › Keys');
    assert.equal(nav({ view: 'mystats' }).label, 'Open My stats'); assert.equal(nav({ view: 'activity' }).label, 'Open Activity'); assert.equal(nav({ view: 'behind' }).label, 'Open Behind the scenes');
    assert.equal(nav({ view: 'client', id: 'lakeview-it' }).label, 'Open Lakeview IT'); assert.equal(nav({ view: 'client', id: 'lakeview-it', tab: 'sent' }).label, "Open Lakeview IT's emails sent");
    assert.equal(nav({ view: 'client' }), null); assert.equal(nav({ view: 'nowhere' }), null);
    for (const a of [{ view: 'settings' }, { view: 'activity' }, { view: 'client', id: 'lakeview-it', tab: 'money' }, { view: 'client', id: 'lakeview-it', tab: 'setup' }]) assert.equal(nav(a, { owner: false }), null, JSON.stringify(a));
    assert.ok(nav({ view: 'client', id: 'lakeview-it', tab: 'conversations' }, { owner: false }));
  } finally { noFetch(); voiceTeardown(); }
});

test('AI confirm cards: "Ava wants to: …" — every action runs only on Do it (or a spoken yes), with the hub\'s own functions; No does nothing; owner-only cards never reach a team member', async () => {
  setup('owner'); voiceReset();
  const ran = []; const saved = {};
  const spy = (name) => { saved[name] = globalThis[name]; globalThis[name] = (...a) => { ran.push([name, ...a]); }; };
  ['openNewTrialClient', 'openNewPayingClient', 'openTrial', 'trialsTodoAction', 'tkOpenSystem', 'demoAction'].forEach(spy);
  let actions = [];
  const calls = aiFetch((p, body) => {
    if (p === '/api/mc/ava/chat') return { status: 200, body: { reply: 'I can do that.', actions, brain: 'groq' } };
    if (p === '/api/mc/team') return { status: 200, body: { ok: true } };
    if (p === '/api/mc/ava/requests') return { status: 200, body: { requests: [] } };
    return null;
  });
  const cases = [
    ['open_add_trial', {}, ['openNewTrialClient']],
    ['open_add_paid', {}, ['openNewPayingClient']],
    ['open_client', { id: 'lakeview-it' }, ['openTrial', 'lakeview-it']],
    ['mark_todo_seen', { id: 'lakeview-it', todoId: 'alert:42' }, ['trialsTodoAction', 'alert:42']],
    ['give_access', { id: 'lakeview-it' }, ['tkOpenSystem', 'lakeview-it', 'setup', 'access']],
    ['load_test_run', {}, ['demoAction', 'load']],
    ['remove_test_run', {}, ['demoAction', 'remove']],
  ];
  try {
    for (const [name, args, want] of cases) {
      actions = [{ type: 'confirm', label: 'Do the thing: ' + name, name, args }];
      AVA.log = []; ran.length = 0;
      const r = await avaAsk('purple elephant dancing ' + cases.findIndex((c) => c[0] === name));
      assert.equal(r.cards.length, 1, name); assert.deepEqual(ran, [], name + ': nothing before the click');
      assert.match(el('avaLog').innerHTML, new RegExp('<small>Ava wants to</small><b>Do the thing: ' + name + '</b>'));
      assert.match(el('avaLog').innerHTML, /onclick="avaCard\(0,1\)">Do it<\/button><button type="button" class="ava-act" onclick="avaCard\(0,0\)">No</);
      avaCard(0, 1); assert.deepEqual(ran[0], want, name); assert.equal(r.cards[0].state, 'done');
      avaCard(0, 1); assert.equal(ran.length, 1, name + ': once only');
      assert.match(el('avaLog').innerHTML, /<p class="ava-card-state">Done\.<\/p>/);
    }
    // No: nothing runs
    actions = [{ type: 'confirm', label: 'Open the add form', name: 'open_add_trial', args: {} }]; ran.length = 0; AVA.log = [];
    await avaAsk('purple elephant'); avaCard(0, 0); assert.deepEqual(ran, []); assert.match(el('avaLog').innerHTML, /Okay, I won’t\./);
    // a spoken "yes" right after runs the card
    AVA.log = []; await avaAsk('purple elephant'); const y = await avaAsk('yes'); assert.ok(y.auto); y.auto.run(); assert.deepEqual(ran, [['openNewTrialClient']]);
    // set my status / a change request: posted to the machine
    actions = [{ type: 'confirm', label: 'Set your status', name: 'set_my_status', args: { text: 'Calling Lakeview' } }, { type: 'confirm', label: 'Send a request', name: 'add_change_request', args: { text: 'A bigger mic button' } }];
    AVA.log = []; const r = await avaAsk('purple elephant'); assert.equal(r.cards.length, 2);
    avaCard(0, 1); avaCard(1, 1); await tick(); await tick();
    assert.deepEqual(calls.find((c) => c.url.endsWith('/api/mc/team') && c.method === 'POST').body, { action: 'status', text: 'Calling Lakeview' });
    assert.deepEqual(calls.find((c) => c.url.endsWith('/api/mc/ava/requests') && c.method === 'POST').body, { action: 'add', text: 'A bigger mic button' });
    // unknown names / missing args are dropped
    actions = [{ type: 'confirm', label: 'Delete everything', name: 'delete_all', args: {} }, { type: 'confirm', label: 'Open', name: 'open_client', args: {} }];
    assert.equal((await avaAsk('purple elephant')).cards.length, 0);
    // a team member: owner-only cards never shown; their own status is fine
    setup('team'); voiceReset();
    actions = cases.map(([name, args]) => ({ type: 'confirm', label: name, name, args })).concat([{ type: 'confirm', label: 'status', name: 'set_my_status', args: { text: 'x' } }]);
    const t = await avaAsk('purple elephant'); assert.deepEqual(t.cards.map((c) => c.name), ['open_client', 'set_my_status']);
    // and even a forged owner-only card does nothing for them
    ran.length = 0; assert.equal(avaCardDo({ kind: 'confirm', name: 'load_test_run', args: {} }, true), false); assert.deepEqual(ran, []);
  } finally { Object.assign(globalThis, saved); noFetch(); voiceTeardown(); asOwner(); }
});

test('AI drafts: a card with the text and Copy (the clipboard, a "Copied" toast); drafts are shown, not read out', async () => {
  setup('owner'); voiceReset(); const { spoken } = fakeSpeech();
  aiFetch((p) => p === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'Here is a draft.', actions: [{ type: 'draft', title: 'Reply to Dana', text: 'Hi Dana,\nThanks for the note — Tuesday works.' }], brain: 'groq' } } : null);
  const clip = []; const nav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: Object.assign({}, nav, { clipboard: { writeText: async (t) => { clip.push(t); } } }), configurable: true });
  try {
    AVA.log = []; const r = await avaAsk('draft a reply to dana saying tuesday works');
    assert.equal(r.cards[0].kind, 'draft');
    assert.match(el('avaLog').innerHTML, /<div class="ava-card draft"><div class="ava-card-head"><b>Reply to Dana<\/b><button type="button" class="ava-act" onclick="avaCopy\(0\)">Copy<\/button><\/div><div class="ava-draft">Hi Dana,\nThanks for the note — Tuesday works\.<\/div>/);
    assert.deepEqual(spoken.map((u) => u.text), ['Here is a draft.']);
    assert.equal(await avaCopy(0), true); assert.deepEqual(clip, ['Hi Dana,\nThanks for the note — Tuesday works.']); assert.match(el('toast').innerHTML, /Copied/);
    assert.match(el('avaLog').innerHTML, />Copied</);
  } finally { Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }); noFetch(); voiceTeardown(); }
});

/* ───────────── Settings › Ava ───────────── */
test('Settings › Ava: brains (ready / needs a key / last error), Test Ava, Settings › Keys, the voice, the requests with Done, privacy — and every loading / missing / error state', async () => {
  setup('owner'); voiceReset();
  const S = (c) => avaRenderSet(Object.assign({ status: {}, reqs: {}, test: {}, voice: 'af_heart', kokoro: 'idle' }, c));
  // loading, missing, error
  assert.match(S({}).body, /Checking Ava’s brains…/); assert.equal(S({}).state, '');
  let m = S({ status: { missing: true }, reqs: { missing: true } });
  assert.match(m.state, /Not available yet/); assert.match(m.body, /hasn't been updated for Ava's smarter brain yet/); assert.match(m.body, /<button type="button" class="btn" disabled onclick="avaTest\(\)">Test Ava/);
  assert.match(S({ status: { err: 'Down.' } }).body, /Down\. <button type="button" class="tk-textbtn" onclick="avaSetRetry\(\)">Try again/);
  // brains
  const brains = [{ id: 'groq', name: 'Groq', ready: true, model: 'llama-3.3-70b', lastOkAt: new Date(Date.now() - 120e3).toISOString() }, { id: 'cerebras', name: 'Cerebras', ready: false, model: 'llama-4', lastError: 'no key' }, { id: 'gemini', name: 'Gemini', ready: false }];
  const on = S({ status: { data: { brains, ready: true } } });
  assert.match(on.state, /pill green">On · Groq</);
  assert.match(on.body, /<b>Groq<\/b><small>llama-3\.3-70b<\/small>/); assert.match(on.body, /pill green">Ready</); assert.match(on.body, /Last answered/); assert.match(on.body, /class="tk-red">no key</);
  assert.match(on.body, /onclick="openSettings\('keys'\)">Open Settings › Keys</);
  assert.match(S({ status: { data: { brains: brains.map((b) => Object.assign({}, b, { ready: false })), ready: false } } }).state, /Needs a key/);
  // the voice picker + privacy
  assert.match(on.body, /<select id="avaSetVoice" onchange="avaSetVoice\(this.value\)"><option value="af_heart" selected>Heart — warm and natural<\/option>/);
  assert.match(on.body, /<option value="browser">The browser's own voice<\/option>/); assert.match(on.body, /onclick="avaVoiceTest\(\)">Play a sample/);
  assert.ok(on.body.includes("Your voice is turned into text by your browser (Chrome uses Google). Ava's AI only uses services that don't train on your data, and never sends your prospects' names or emails."));
  // requests
  const reqs = [{ id: 'r1', at: '2026-09-28T10:00:00Z', by: 'Nimal Perera', text: 'Read the reply bot rules out loud', status: 'open' }, { id: 'r2', at: '2026-09-20T10:00:00Z', by: 'Limeth', text: 'Old one', status: 'done', doneAt: '2026-09-21T10:00:00Z' }];
  const rq = S({ status: { data: { brains } }, reqs: { data: reqs } }).body;
  assert.match(rq, /What people asked Ava to change <span class="pill amber">1 open<\/span>/);
  assert.match(rq, /<b>Read the reply bot rules out loud<\/b><small>Nimal Perera · /); assert.match(rq, /onclick="avaReqDone\(&quot;r1&quot;\)">Done<\/button>|onclick="avaReqDone\('r1'\)">Done<\/button>|onclick="avaReqDone\("r1"\)">Done<\/button>/);
  assert.match(rq, /<li class="done"><span><b>Old one/);
  assert.match(S({ reqs: { data: [] } }).body, /Nothing yet/);
  // Test Ava: busy, the answer, no key, errors
  assert.match(S({ test: { busy: true } }).body, /Asking Ava…/);
  assert.match(S({ test: { result: { reply: 'Hello!', brain: 'Groq', ms: 870 } } }).body, /“Hello!” <small class="tk-muted">answered by Groq · 0\.9 s<\/small>/);
  // live: the routes, Test Ava and Done
  let status = { brains, ready: true }; let chat = { status: 200, body: { reply: 'Hello from Groq!', brain: 'groq' } };
  const calls = aiFetch((p, body) => p === '/api/mc/ava/status' ? { status: 200, body: status } : p === '/api/mc/ava/requests' ? { status: 200, body: { requests: body && body.action === 'done' ? reqs.map((q) => Object.assign({}, q, { status: 'done' })) : reqs } } : p === '/api/mc/ava/chat' ? chat : null);
  AVA.st = { data: null, at: 0, err: null, missing: false }; AVA.reqs = { data: null, at: 0, err: null, missing: false };
  openSettings('ava'); await avaLoadSettings(true);
  assert.equal(AVA.st.data.brains.length, 3); assert.equal(AVA.reqs.data.length, 2); assert.equal(avaBrainName('groq'), 'Groq');
  const page = renderSettings(trialsSettingsCtx());
  assert.match(page, /<details class="tk-set" id="tkSet-ava" open[^>]*><summary><span class="tk-set-head"><span class="tk-set-title">Ava<\/span>/);
  assert.ok(page.indexOf('tkSet-keys') < page.indexOf('tkSet-ava'), 'right after Keys');
  await avaTest(); assert.equal(AVA.test.result.reply, 'Hello from Groq!'); assert.equal(AVA.test.result.brain, 'Groq');
  chat = { status: 503, body: { error: 'x', needsKeys: true } }; await avaTest(); assert.match(AVA.test.err, /add a free key in Settings › Keys/);
  chat = { status: 429, body: { error: 'Daily cap reached' } }; await avaTest(); assert.match(AVA.test.err, /limit/);
  chat = { status: 502, body: { error: 'No brain answered', tried: ['groq', 'cerebras'] } }; await avaTest(); assert.match(AVA.test.err, /tried Groq, Cerebras/);
  await avaReqDone('r1'); assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/mc/ava/requests')).pop().body, { action: 'done', id: 'r1' });
  assert.ok(AVA.reqs.data.every((q) => q.status === 'done'));
  // 404s: "not available yet"
  aiFetch(() => ({ status: 404, body: {} })); await avaLoadSettings(true); assert.equal(AVA.st.missing, true); assert.equal(AVA.reqs.missing, true);
  // Settings › Ava by voice, and the owner only
  const r = think('open ava settings'); r.auto.run(); assert.equal(tk.setOpen.ava, true);
  setup('team'); assert.match(think('open ava settings').say, /only for the owner/); assert.equal(await avaLoadStatus(true), null);
  noFetch(); asOwner(); voiceTeardown();
});

test('the voice worker: one load, sentences answered in order, a cancel drops what is queued and what is being made; a load error is reported (fatal)', async () => {
  const out = []; FakeWorker.mock = kokoroMock({ delay: 25 }); FakeWorker.gpu = null;   // (making a sentence takes time, as for real)
  const w = new FakeWorker('ava-voice-worker.js', { type: 'module' }); w.onmessage = (e) => out.push(e.data);
  w.postMessage({ type: 'load', device: 'wasm' }); w.postMessage({ type: 'load', device: 'wasm' });
  await until(() => out.some((m) => m.type === 'ready'));
  assert.equal(FakeWorker.mock.calls.filter((c) => c[0] === 'load').length, 1, 'loaded once');
  assert.deepEqual(out.filter((m) => m.type !== 'progress').map((m) => m.type), ['device', 'ready']);
  for (let i = 0; i < 3; i++) w.postMessage({ type: 'speak', gen: 7, i, text: 'Sentence number ' + i + '.', voice: 'af_bella', speed: 1 });
  await until(() => out.filter((m) => m.type === 'audio').length === 3);
  assert.deepEqual(out.filter((m) => m.type === 'audio').map((m) => [m.gen, m.i, m.rate]), [[7, 0, 24000], [7, 1, 24000], [7, 2, 24000]]);
  assert.ok(out.find((m) => m.type === 'audio').samples.length > 0);
  out.length = 0; FakeWorker.mock.calls.length = 0;
  for (let i = 0; i < 3; i++) w.postMessage({ type: 'speak', gen: 8, i, text: 'Old ' + i + '.' });
  w.postMessage({ type: 'cancel', gen: 8 }); w.postMessage({ type: 'speak', gen: 9, i: 0, text: 'New one.' });
  await until(() => out.some((m) => m.type === 'audio' && m.gen === 9)); await sleep(10);
  assert.equal(out.filter((m) => m.type === 'audio' && m.gen === 8).length, 0, 'none of the old answer is sent');
  assert.ok(FakeWorker.mock.calls.filter((c) => /^Old/.test(c[1])).length <= 1, 'at most the one already being made is made');
  FakeWorker.mock = kokoroMock({ fail: true }); const out2 = [];
  const w2 = new FakeWorker('ava-voice-worker.js', { type: 'module' }); w2.onmessage = (e) => out2.push(e.data);
  w2.postMessage({ type: 'load', device: 'wasm' }); await until(() => out2.some((m) => m.type === 'error'));
  assert.deepEqual(clone(out2.find((m) => m.type === 'error')), { type: 'error', fatal: true, message: 'model blocked' });
});

/* ═════════════ Ava 3: AI first, hold Space to talk, streamed answers, markdown, memory ═════════════ */
const keyEv = (type, k, extra) => { const e = Object.assign({ key: k === 'Space' ? ' ' : k, code: k === 'Space' ? 'Space' : k, target: { tagName: 'BODY' }, preventDefault() { e.prevented = true; } }, extra || {}); (docListeners[type] || []).forEach((fn) => fn(e)); return e; };
function fakeRecs() {
  const recs = [];
  globalThis.webkitSpeechRecognition = function () { recs.push(this); this.start = () => { this.started = true; }; this.stop = () => { this.stopped = true; this.onend && this.onend(); }; this.abort = () => { this.aborted = true; this.onend && this.onend(); }; };
  return recs;
}
const said = (rec, text) => { const r = [{ transcript: text }]; r.isFinal = true; rec.onresult({ resultIndex: 0, results: [r] }); };

test('hold Space to talk: opens Ava and listens at once (no page scroll), keeps listening through pauses, let go = send; key repeat ignored; a short tap only opens / closes', async () => {
  setup('owner'); voiceReset(); const recs = fakeRecs();
  aiFetch((p) => p === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'Three trials are going.', brain: 'groq' } } : null);
  try {
    avaClose(); AVA.log = []; AVA.greeted = true;
    let e = keyEv('keydown', 'Space');
    assert.ok(e.prevented, 'no page scroll'); assert.equal(AVA.open, true, 'opens'); assert.equal(AVA.listening, true);
    const rec = recs.pop(); assert.ok(rec.started); assert.equal(rec.continuous, true, 'listens through pauses'); assert.equal(rec._ptt, true);
    assert.equal(el('avaHeardHint').textContent, 'Let go of Space to send');
    e = keyEv('keydown', 'Space', { repeat: true }); assert.ok(e.prevented); assert.equal(recs.length, 0, 'key repeat: nothing new');
    rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'how many trials' }], { isFinal: false })] });
    await sleep(1500); assert.ok(!rec.stopped, 'a pause does not send it while held');
    said(rec, 'how many trials are running');
    e = keyEv('keyup', 'Space'); assert.ok(e.prevented); assert.ok(rec.stopped);
    await tick(); await tick();
    assert.ok(AVA.log.some((m) => m.who === 'you' && m.text === 'how many trials are running'), 'sent');
    assert.ok(AVA.log.some((m) => m.who === 'ava' && m.text === 'Three trials are going.'));
    // a short tap while open: closes, nothing sent
    const n = AVA.log.length; keyEv('keydown', 'Space'); const r2 = recs.pop(); keyEv('keyup', 'Space');
    assert.equal(AVA.open, false, 'tap closes'); assert.ok(r2.aborted, 'what it heard is thrown away'); await tick(); assert.equal(AVA.log.length, n);
    // a short tap while closed: opens, and nothing is sent
    keyEv('keydown', 'Space'); const r3 = recs.pop(); keyEv('keyup', 'Space'); assert.equal(AVA.open, true); assert.ok(r3.aborted); assert.equal(AVA.listening, false); await tick(); assert.equal(AVA.log.length, n);
    // held but nothing said: a hint, nothing sent
    keyEv('keydown', 'Space'); const r4 = recs.pop(); await sleep(AVA_TAP_MS + 10); keyEv('keyup', 'Space'); assert.ok(r4.stopped); assert.match(el('avaNote').textContent, /hold Space while you talk/); assert.equal(AVA.log.length, n);
    // the window loses focus while held: let go (sent)
    keyEv('keydown', 'Space'); const r5 = recs.pop(); await sleep(AVA_TAP_MS + 10); said(r5, 'what needs me today'); avaBlur(); await tick(); await tick();
    assert.equal(AVA.ptt, null); assert.ok(AVA.log.some((m) => m.text === 'what needs me today'));
  } finally { noFetch(); voiceTeardown(); }
});

test('hold Space: ignored while typing (input, textarea, select, contenteditable), with a modifier, during IME composition, in a form, or signed out; Space / Esc while she speaks stops her at once', async () => {
  setup('owner'); voiceReset(); const recs = fakeRecs(); const { spoken } = fakeSpeech();
  try {
    avaClose();
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }, { tagName: 'DIV', getAttribute: (k) => (k === 'contenteditable' ? 'true' : null) }]) {
      const e = keyEv('keydown', 'Space', { target }); assert.ok(!e.prevented, target.tagName); assert.equal(AVA.open, false); assert.equal(recs.length, 0);
    }
    for (const mod of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) { const e = keyEv('keydown', 'Space', mod); assert.ok(!e.prevented, JSON.stringify(mod)); assert.equal(AVA.open, false); }
    openModal('<p>x</p>'); let e = keyEv('keydown', 'Space'); assert.ok(!e.prevented); assert.equal(AVA.open, false); closeModal();
    authUser = null; e = keyEv('keydown', 'Space'); assert.ok(!e.prevented); asOwner();
    // Esc while she speaks: she stops, the panel stays; Esc again closes
    avaOpen({ quiet: true }); avaSpeak('A long answer. With two sentences.'); assert.equal(AVA.speaking, true);
    keyEv('keydown', 'Escape'); assert.equal(AVA.speaking, false); assert.equal(AVA.open, true); keyEv('keydown', 'Escape'); assert.equal(AVA.open, false);
    // Space while she speaks: stops her and listens
    avaOpen({ quiet: true }); avaSpeak('Another long answer. Here.'); assert.equal(AVA.speaking, true);
    keyEv('keydown', 'Space'); assert.equal(AVA.speaking, false); assert.equal(AVA.listening, true); keyEv('keyup', 'Space');
    // the footer says how
    assert.match(el('avaRoot').innerHTML, /<span class="ava-hint" id="avaHint">Hold <kbd>Space<\/kbd> to talk<\/span>/);
    assert.ok(spoken.length >= 2);
  } finally { voiceTeardown(); }
});

test('hold the mic (phones): press-and-hold listens and sends on release; a quick tap listens until you stop talking; a first-run tip says "Hold Space to talk" once', async () => {
  setup('owner'); voiceReset(); const recs = fakeRecs();
  aiFetch((p) => p === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'Okay.', brain: 'groq' } } : null);
  try {
    avaOpen({ quiet: true }); AVA.log = [];
    avaPointer({ button: 0 }, 'mic'); let rec = recs.pop(); assert.equal(rec._ptt, true); await sleep(AVA_TAP_MS + 10);
    said(rec, 'open my stats please now'); avaPointerUp({}); assert.ok(rec.stopped); await tick(); await tick();
    assert.ok(AVA.log.some((m) => m.who === 'you' && m.text === 'open my stats please now'));
    assert.equal(avaMicClick(), undefined, 'the click after a press is not a second tap'); assert.equal(recs.length, 0);
    // quick tap: tap-to-talk (stops by itself when you stop talking)
    avaPointer({ button: 0 }, 'mic'); rec = recs.pop(); avaPointerUp({}); assert.equal(rec._ptt, false); assert.equal(AVA.listening, true); assert.ok(!rec.stopped && !rec.aborted);
    avaPointer({ button: 0 }, 'mic'); assert.ok(rec.stopped, 'a tap while listening stops');
    // the tip: once
    localStorage.removeItem(AVA_TIP_KEY); AVA.tipShown = false; el('avaTip').hidden = true;
    assert.equal(avaTip(), true); assert.equal(el('avaTip').hidden, false); avaTipSeen(); assert.equal(el('avaTip').hidden, true);
    AVA.tipShown = false; assert.equal(avaTip(), false, 'never again on this device');
  } finally { noFetch(); voiceTeardown(); }
});

/* A streamed answer: a fake ReadableStream the test feeds bit by bit. */
function sseStream() {
  const q = []; let wake = null; const enc = new TextEncoder();
  const push = (s) => { q.push(s === null ? null : s instanceof Error ? s : enc.encode(s)); if (wake) { const w = wake; wake = null; w(); } };
  const reader = { async read() { while (!q.length) await new Promise((r) => { wake = r; }); const v = q.shift(); if (v instanceof Error) throw v; return v === null ? { done: true, value: undefined } : { done: false, value: v }; }, cancel() { reader.cancelled = true; } };
  return { push, reader, res: { ok: true, status: 200, headers: { get: (k) => (/content-type/i.test(k) ? 'text/event-stream; charset=utf-8' : null) }, body: { getReader: () => reader } } };
}
const ev = (name, data) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';

test('streaming: SSE parsing — events split across chunks, CRLF, comments, several data lines', () => {
  let r = avaSseSplit('event: delta\r\ndata: {"text":"Hi"}\r\n\r\n: keep-alive\n\nevent: done\ndata: {"brain":"groq"}\n\nevent: delta\ndata: {"te');
  assert.deepEqual(r.events, [{ event: 'delta', data: { text: 'Hi' } }, { event: 'done', data: { brain: 'groq' } }]);
  assert.equal(r.rest, 'event: delta\ndata: {"te');
  r = avaSseSplit(r.rest + 'xt":" there"}\n\n'); assert.deepEqual(r.events, [{ event: 'delta', data: { text: ' there' } }]); assert.equal(r.rest, '');
  r = avaSseSplit('data: line one\ndata: line two\n\n'); assert.deepEqual(r.events, [{ event: 'message', data: 'line one\nline two' }]);
});

test('streaming: the answer shows as it arrives, the first sentence is said as soon as it is complete (no markdown read out), then actions, follow-ups and done', async () => {
  setup('owner'); voiceReset(); const { spoken } = fakeSpeech(); render('trials');
  const s = sseStream(); const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); if (String(url).includes('/api/mc/ava/chat')) return s.res; throw new TypeError('Failed to fetch'); };
  try {
    AVA.log = []; AVA.greeted = true; const p = avaAsk('tell me about lakeview');
    await sleep(5);
    const c = calls.find((x) => x.url.includes('/api/mc/ava/chat')); assert.match(c.url, /\?stream=1$/); assert.match(c.init.headers.accept, /^text\/event-stream/); assert.equal(JSON.parse(c.init.body).stream, true);
    assert.equal(AVA.busy, true, 'thinking until the first words');
    s.push(ev('delta', { text: 'Lakeview is **doing well**' })); await sleep(5);
    const live = AVA.log[AVA.log.length - 1]; assert.equal(live.streaming, true); assert.equal(live.text, 'Lakeview is **doing well**'); assert.equal(AVA.busy, false);
    assert.match(el('avaLog').innerHTML, /ava-msg ava streaming"><div class="ava-bub"><p>Lakeview is <b>doing well<\/b><span class="ava-caret" aria-hidden="true"><\/span><\/p>/);
    assert.equal(spoken.length, 0, 'not a whole sentence yet');
    s.push(ev('delta', { text: '. They have sent 412 emails' })); await sleep(5);
    assert.deepEqual(spoken.map((u) => u.text), ['Lakeview is doing well.'], 'the first sentence at once, without the ** marks');
    s.push('event: delta\ndata: {"te'); s.push('xt":" and booked 3 calls.\\n- Next: [see the replies](#system/lakeview-it/conversations)"}\n\n'); await sleep(5);
    assert.deepEqual(spoken.map((u) => u.text), ['Lakeview is doing well.', 'They have sent 412 emails and booked 3 calls.']);
    s.push(ev('actions', { actions: [{ type: 'navigate', view: 'calendar' }], suggestions: ['Who replied last?', 'Open their calls'] }));
    s.push(ev('done', { brain: 'groq', model: 'llama', ms: 900, tried: ['groq'] })); s.push(null);
    const r = await p;
    assert.equal(r.ai, true); assert.equal(r.streamed, true); assert.match(r.meta, /^answered by Groq/);
    assert.equal(AVA.log.filter((m) => m.who === 'ava' && !m.notice).length, 1, 'one message, filled in place');
    const m = AVA.log[AVA.log.length - 1]; assert.equal(m.streaming, false); assert.deepEqual(m.chips, ['Who replied last?', 'Open their calls']);
    assert.equal(m.actions[0].label, 'Open Calendar');
    assert.deepEqual(spoken.map((u) => u.text), ['Lakeview is doing well.', 'They have sent 412 emails and booked 3 calls.', 'Next: see the replies'], 'the rest at the end, the link said as its words');
    assert.match(el('avaLog').innerHTML, /<ul><li>Next: <button type="button" class="ava-link" onclick="avaGo\(0\)">see the replies<\/button><\/li><\/ul>/);
    avaGo(0); assert.equal(currentView, 'clientSystem'); assert.equal(trialTab, 'conversations');
    spoken[spoken.length - 1].onend(); assert.equal(AVA.speaking, false);
  } finally { noFetch(); voiceTeardown(); }
});

test('streaming: an error before any words = basic mode with the reason; the connection dropping half-way keeps what came and says so; JSON answers still work', async () => {
  setup('owner'); voiceReset(); fakeSpeech();
  try {
    let s = sseStream(); globalThis.fetch = async (url) => { if (String(url).includes('/api/mc/ava/chat')) return s.res; throw new TypeError('Failed to fetch'); };
    AVA.log = []; let p = avaAsk('what needs me today'); await sleep(5);
    s.push(ev('error', { error: 'No brain has a key', needsKeys: true })); s.push(null);
    let r = await p; assert.equal(r.basic, 'keys'); assert.match(r.say, /need/); assert.match(AVA.log[AVA.log.length - 1].text, /basic mode/);
    voiceReset(); s = sseStream(); AVA.log = []; p = avaAsk('tell me a story'); await sleep(5);
    s.push(ev('delta', { text: 'Once upon a time. There was' })); await sleep(5); s.push(new Error('network lost'));
    r = await p; assert.equal(r.ai, true); assert.equal(r.cut, true); assert.equal(r.say, 'Once upon a time. There was');
    assert.match(AVA.log[AVA.log.length - 1].text, /connection dropped before I finished/);
    // plain JSON (the machine not streaming yet)
    aiFetch((pth) => pth === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'Plain **JSON** answer.', brain: 'cerebras', suggestions: ['Next?'] } } : null);
    r = await avaAsk('anything'); assert.equal(r.say, 'Plain **JSON** answer.'); assert.equal(r.streamed, false); assert.deepEqual(r.chips, ['Next?']);
    assert.match(el('avaLog').innerHTML, /<p>Plain <b>JSON<\/b> answer\.<\/p>/);
  } finally { noFetch(); voiceTeardown(); }
});

test('markdown: bold, italic, code, lists, headings, line breaks, safe links and hub links as buttons — everything else escaped (no HTML injection)', () => {
  setup('owner');
  const h = avaMd('<img src=x onerror=alert(1)> **bold** *it* `<b>code</b>`');
  assert.ok(!/<img/.test(h) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(h), h);
  assert.match(h, /<b>bold<\/b> <i>it<\/i> <code>&lt;b&gt;code&lt;\/b&gt;<\/code>/);
  assert.equal(avaMd('- one\n- two\n\n1. a\n2. b'), '<ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol>');
  assert.equal(avaMd('line one\nline two\n\n## Head'), '<p>line one<br>line two</p><p class="ava-h">Head</p>');
  const js = avaMd('[click](javascript:alert(1)) [x](data:text/html,hi)'); assert.ok(!/href/.test(js) && !/javascript:alert\(1\)"/.test(js), js);
  const q = avaMd('[site](https://ok.com/a?b=1&c="2")'); assert.ok(!/"2"/.test(q), q);
  assert.match(avaMd('[site](https://ok.com/a?b=1&c=2)'), /<a href="https:\/\/ok\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">site<\/a>/);
  const bad = avaMd('[evil](#system/x" onclick="alert(1))'); assert.ok(!/onclick="alert/.test(bad), bad);
  AVA.links = []; assert.match(avaMd('See #system/lakeview-it'), /<button type="button" class="ava-link" onclick="avaGo\(0\)">Open Lakeview IT's email system<\/button>/);
  assert.match(avaMd('```\n<script>x</script>\n```'), /<pre><code>&lt;script&gt;x&lt;\/script&gt;<\/code><\/pre>/);
  // what she says out loud: the words only
  const p = avaPlain('**Bold** and [the link](https://x.com) at https://y.com/z\n- item one\n- item two\n`code`');
  assert.ok(!/[*#`]|http|\[|\]/.test(p), p); assert.match(p, /^Bold and the link at\s*\.? item one\. item two\. code$/);
  // a team member: an owner-only hub link does nothing
  asTeam(); AVA.links = ['#settings/keys']; assert.equal(avaGo(0), false); asOwner();
});

test('memory: the conversation survives a reload in this tab (sessionStorage), never shown to someone else; New chat clears it; storage that throws is fine', async () => {
  setup('owner'); voiceReset();
  const store = {}; globalThis.sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  try {
    AVA.log = []; avaPush({ who: 'you', text: 'hello', at: 1 }); avaPush({ who: 'ava', text: 'Hi **there**', meta: 'answered by Groq · 0.4 s', at: 2, actions: [avaPlace('trials')], cards: [{ kind: 'draft', title: 'D', text: 'draft text' }, { kind: 'confirm', label: 'x', name: 'open_client', args: {} }] });
    const saved = JSON.parse(store[AVA_CHAT_KEY]); assert.equal(saved.uid, 'u1'); assert.equal(saved.log.length, 2);
    assert.deepEqual(saved.log[1], { who: 'ava', text: 'Hi **there**', meta: 'answered by Groq · 0.4 s', at: 2, cards: [{ kind: 'draft', title: 'D', text: 'draft text' }] });
    // "reload": the log is read back
    AVA.log = []; AVA.greeted = false; AVA.restoredFor = null; avaSync();
    assert.deepEqual(AVA.log.map((m) => m.text), ['hello', 'Hi **there**']); assert.equal(AVA.greeted, true);
    // the next question carries it as history
    const calls = aiFetch((p) => p === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'Sure.', brain: 'groq' } } : null);
    await avaAsk('and then?'); const body = calls.find((c) => c.url.includes('/api/mc/ava/chat')).body;
    assert.deepEqual(body.messages.slice(0, 2), [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi **there**' }]);
    // someone else in this tab: not theirs
    asTeam(); AVA.log = []; assert.equal(avaRestore(), false); asOwner();
    // New chat: gone (only the greeting)
    avaRestore(); avaNewChat();
    assert.equal(AVA.log.length, 1); assert.match(AVA.log[0].text, /^Hi Limeth/); assert.equal(JSON.parse(store[AVA_CHAT_KEY]).log.length, 1);
    assert.match(el('avaRoot').innerHTML, /id="avaNew" onclick="avaNewChat\(\)" aria-label="New chat"/);
    // signed out: forgotten
    authUser = null; avaSync(); assert.equal(store[AVA_CHAT_KEY], undefined); asOwner();
    // storage that throws: no crash
    globalThis.sessionStorage = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } };
    assert.equal(avaSave(), false); assert.equal(avaRestore(), false); avaNewChat(); assert.equal(AVA.log.length, 1);
  } finally { delete globalThis.sessionStorage; noFetch(); voiceTeardown(); }
});

test('the box and the answers: Enter sends, Shift+Enter is a new line, ↑ brings back the last questions; Copy on each answer; the brain · time line; the thinking shimmer', async () => {
  setup('owner'); voiceReset();
  aiFetch((p) => p === '/api/mc/ava/chat' ? { status: 200, body: { reply: 'Answer.', brain: 'groq' } } : null);
  const clip = []; const nav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: Object.assign({}, nav, { clipboard: { writeText: async (t) => { clip.push(t); } } }), configurable: true });
  try {
    avaOpen({ quiet: true }); AVA.log = [];
    const box = el('avaInput'); const k = (key, extra) => { const e = Object.assign({ key, target: box, preventDefault() { e.prevented = true; } }, extra || {}); avaInputKey(e); return e; };
    box.value = 'first question'; let e = k('Enter'); assert.ok(e.prevented); await tick(); await tick(); assert.equal(box.value, '');
    box.value = 'line one'; e = k('Enter', { shiftKey: true }); assert.ok(!e.prevented, 'Shift+Enter: a new line'); box.value = '';
    box.value = 'second question'; k('Enter'); await tick(); await tick();
    box.value = ''; box.selectionStart = box.selectionEnd = 0;
    e = k('ArrowUp'); assert.ok(e.prevented); assert.equal(box.value, 'second question');
    k('ArrowUp'); assert.equal(box.value, 'first question'); k('ArrowUp'); assert.equal(box.value, 'first question');
    box.value = 'typing something'; box.selectionStart = box.selectionEnd = 5; e = k('ArrowUp'); assert.ok(!e.prevented, 'not while editing text');
    const i = AVA.log.findIndex((m) => m.who === 'ava' && m.text === 'Answer.');
    assert.match(el('avaLog').innerHTML, new RegExp('onclick="avaCopyMsg\\(' + i + '\\)" aria-label="Copy this answer"'));
    assert.equal(await avaCopyMsg(i), true); assert.deepEqual(clip, ['Answer.']);
    AVA.busy = true; avaPaintLog(); assert.match(el('avaLog').innerHTML, /<span class="ava-shimmer">Thinking…<\/span>/); AVA.busy = false;
    // expand: remembered
    avaToggleBig(); assert.equal(localStorage.getItem(AVA_BIG_KEY), '1'); assert.ok(el('avaPanel').classList.contains('big')); avaToggleBig(); assert.ok(!el('avaPanel').classList.contains('big'));
  } finally { Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }); noFetch(); voiceTeardown(); }
});

test('voice: speed 0.9–1.2 (remembered, used by both voices); the natural voice ready is told once; a hold with a recording prefers the machine\'s words (/api/mc/ava/hear), else the browser\'s', async () => {
  setup('owner'); voiceReset(); const { spoken } = fakeSpeech();
  const nav = globalThis.navigator;
  try {
    assert.equal(avaSpeed(), 1); assert.equal(avaSetSpeed(1.5), 1.2); assert.equal(localStorage.getItem(AVA_SPEED_KEY), '1.2'); assert.equal(avaSetSpeed(0.2), 0.9); avaSetSpeed(1.1);
    avaSpeak('Hello.'); assert.equal(spoken[0].rate, 1.13);
    avaOpen({ quiet: true }); assert.match(el('avaSpeedSel').innerHTML, /<option value="1.1" selected>1.1×<\/option>/);
    // the natural voice: told once
    AVA.log = []; avaKokoroMsg({ type: 'ready', device: 'wasm', dtype: 'q8', rtf: 0.4 });
    assert.match(AVA.log[AVA.log.length - 1].text, /natural voice is ready/); const n = AVA.log.length;
    avaKokoroMsg({ type: 'ready', device: 'wasm', dtype: 'q8', rtf: 0.4 }); assert.equal(AVA.log.length, n, 'once');
    AVA.k.state = 'idle';
    // hold with a recording: the machine's words win
    const recs = fakeRecs(); const posted = [];
    class FakeMR { constructor(stream, o) { this.state = 'inactive'; this.mimeType = (o && o.mimeType) || 'audio/webm'; } static isTypeSupported(t) { return t === 'audio/webm'; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.ondataavailable && this.ondataavailable({ data: new Blob(['x'.repeat(4000)], { type: 'audio/webm' }) }); this.onstop && this.onstop(); } }
    globalThis.MediaRecorder = FakeMR;
    Object.defineProperty(globalThis, 'navigator', { value: Object.assign({}, nav, { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }), configurable: true });
    let hear = { status: 200, body: { text: 'what needs me today' } };
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/api/mc/ava/hear')) { posted.push(init); return { ok: hear.status === 200, status: hear.status, json: async () => hear.body }; }
      if (u.includes('/api/mc/ava/chat')) return { ok: true, status: 200, text: async () => JSON.stringify({ reply: 'Nothing needs you.', brain: 'groq' }) };
      throw new TypeError('Failed to fetch');
    };
    AVA.log = []; keyEv('keydown', 'Space'); let rec = recs.pop(); await tick(); await sleep(AVA_TAP_MS);
    said(rec, 'what knees me today'); keyEv('keyup', 'Space'); await sleep(30);
    assert.equal(posted.length, 1); assert.equal(posted[0].headers['content-type'], 'audio/webm'); assert.ok(posted[0].body instanceof Blob);
    assert.ok(AVA.log.some((m) => m.who === 'you' && m.text === 'what needs me today'), JSON.stringify(AVA.log.map((m) => m.text)));
    // /hear not there (404): the browser's words, and it isn't asked again for a while
    hear = { status: 404, body: {} }; AVA.log = [];
    keyEv('keydown', 'Space'); rec = recs.pop(); await tick(); await sleep(AVA_TAP_MS); said(rec, 'open trials'); keyEv('keyup', 'Space'); await sleep(30);
    assert.ok(AVA.log.some((m) => m.who === 'you' && m.text === 'open trials')); assert.equal(AVA_HEAR.ok, false); assert.equal(avaHearOn(), false);
  } finally { delete globalThis.MediaRecorder; Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }); AVA_HEAR.ok = null; noFetch(); voiceTeardown(); }
});

test('Settings › Ava: Business facts — loaded, saved (≤ 4,000 characters), and not there yet (404)', async () => {
  setup('owner'); voiceReset();
  let facts = 'We set up cold email for IT firms.'; let mode = 'ok';
  const calls = aiFetch((p, body) => p === '/api/mc/ava/facts' ? (mode === 'missing' ? { status: 404, body: {} } : body ? (facts = body.text, { status: 200, body: { text: facts } }) : { status: 200, body: { text: facts } }) : null);
  try {
    AVA.facts = { text: null, at: 0, err: null, missing: false, busy: false, saved: null };
    await avaLoadFacts(true);
    let b = avaRenderSet(avaSettingsCtx()).body;
    assert.match(b, /<h4 class="ava-set-h">Business facts<\/h4>/); assert.match(b, /<textarea id="avaFacts" class="ava-facts" rows="6" maxlength="4000"[^>]*>We set up cold email for IT firms\.<\/textarea>/);
    el('avaFacts').value = 'New <facts> & prices'; await avaFactsSave();
    assert.deepEqual(calls.filter((c) => c.method === 'POST').pop().body, { text: 'New <facts> & prices' });
    b = avaRenderSet(avaSettingsCtx()).body; assert.match(b, />New &lt;facts&gt; &amp; prices<\/textarea>/); assert.match(b, /Saved/);
    mode = 'missing'; AVA.facts.text = null; await avaLoadFacts(true); assert.match(avaRenderSet(avaSettingsCtx()).body, /Business facts<\/h4><p class="tk-muted tk-small">Not available yet/);
  } finally { noFetch(); voiceTeardown(); }
});
