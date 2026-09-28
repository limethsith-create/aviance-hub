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
import { NOW, acme, bright, fullHub, simpleRows, simpleHub, stagesWith, onboardCall, ecreekDetail, ecreekConvDetail, fernDetail, detail, inquirySummaryOf, inquiryRecords, calWeek, calSettingsFixture, CAL_NOW, deliveryEntries, unopenedTodo, deliveryAlerts } from './fixtures.mjs';

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
const row = (base, simple) => Object.assign({}, base, { simple: Object.assign({ person: base.contactName, company: base.name, dayOf30: null, needsYou: false, since: '2026-10-10T00:00:00Z', label: 'x', next: '' }, simple) });
const top = (d, meta) => between(renderTrialDetail(d, 'overview', Object.assign({ now: NOW }, meta)), '<section class="card tk-top', '</section>');

/* The words the owner must never meet on the Trials list or at the top of a trial (the old jargon). */
const BANNED = /\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|dns|jwt|config|payload|mission control|cron|redis|endpoint|webhook)\b/i;

/* ───────────── 1. four places only ───────────── */
test('navigation: Trials, Paying clients, Calendar, Team, My stats, Activity, Settings — the same in the sidebar and the phone tab bar', () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  assert.deepEqual(navItems().map((i) => [i.view, i.label]), [['trials', 'Trials'], ['paying', 'Paying clients'], ['calendar', 'Calendar'], ['team', 'Team'], ['mystats', 'My stats'], ['people', 'Activity'], ['settings', 'Settings']]);
  render('trials');
  for (const id of ['navArea', 'tabBar']) {
    const nav = el(id).innerHTML;
    assert.equal(count(nav, /<button class="(nav-item|tab)/g), 7, id + ': seven buttons');
    assert.ok(!/Machine|Behind the scenes|Phone alerts|Mission Control|Log out|alerts/i.test(visibleText(nav)), id + ': nothing else in the navigation');
    assert.ok(nav.includes(`<button class="${id === 'navArea' ? 'nav-item' : 'tab'} active" type="button" onclick="render('trials')" aria-label="Trials" aria-current="page">`), id + ': Trials is the current place');
  }
  // pages inside a place light up their place
  for (const [view, place] of [['trial', 'trials'], ['trialPurchase', 'trials'], ['inquiries', 'paying'], ['inquiry', 'paying'], ['trialsBoard', 'settings']]) assert.ok(navItems().find((i) => i.view === place && (i.also || []).includes(view)), view + ' belongs to ' + place);
  // the phone: a tab bar at the bottom, no sidebar, no hamburger; every tab at least 44 px tall
  const shellCss = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const phone = between(shellCss, '@media(max-width:860px){', '@media(max-width:560px)');
  assert.ok(phone.includes('.sidebar{display:none}') && phone.includes('.tabbar{display:flex;'), 'on a phone: the tab bar instead of the sidebar');
  assert.match(shellCss, /\.tabbar\{display:flex;/);
  assert.match(shellCss, /\.tab\{[^}]*min-height:58px/); assert.match(shellCss, /\.nav-item\{[^}]*min-height:48px/); assert.match(shellCss, /\.btn\{[^}]*min-height:44px/);
  assert.ok(!html.includes('hamburger"') && !html.includes('id="newClientBtn"') && !html.includes('id="themeBtn"'), 'the top bar is only the title, Find (computer) and the bell');
});

test('navigation: My stats opens your own outreach (aviance) on the trial page and lights up instead of Trials; #stats deep links there', () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const item = navItems().find((i) => i.view === 'mystats');
  assert.equal(item.label, 'My stats'); assert.equal(item.icon, I.chart);
  render('trials');
  assert.ok(el('navArea').innerHTML.includes('onclick="openMyStats()" aria-label="My stats">'), 'the button opens My stats');
  openMyStats();
  assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'aviance');
  assert.deepEqual(navItems().filter((i) => i.isOn ? i.isOn() : i.view === currentView).map((i) => i.view), ['mystats']);
  openTrial('acme');
  assert.deepEqual(navItems().filter((i) => i.isOn ? i.isOn() : i.view === currentView).map((i) => i.view), ['trials']);
  assert.deepEqual(parseDeepLink('#stats'), { view: 'trial', id: 'aviance' });
});

test('My stats: only your own outreach (GET /api/mc/outreach) — one row of four numbers, per day, per inbox, every reply, every email — and Saved history; no client page under it', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const outreach = {
    totals: { sent: 4, newSends: 3, followUps: 1, opens: 2, uniqueOpens: 2, replies: 1, bounces: 1, days: 3, firstDay: '2026-06-01', lastDay: '2026-06-04' },
    inboxes: [{ email: 'me@getaviance.site', sent: 3 }, { email: 'you@getaviance.site', sent: 1 }],
    byTouch: { d0: 3, d3: 1 }, byCampaign: {},
    days: [
      { date: '2026-06-04', summary: { totalSent: 1, newSends: 0, followUps: 1, totalReplies: 0 }, sent: [{ to: 'a@acme.com', company: 'Acme', subject: 'Re: Quick idea', touch: 'd3', from: 'me@getaviance.site', timestamp: '2026-06-04T14:00:00Z' }], replies: [], bounces: [] },
      { date: '2026-06-02', summary: { totalSent: 1, newSends: 1, totalReplies: 1 }, sent: [{ to: 'c@gamma.com', company: 'Gamma', subject: 'Hi <Gamma>', touch: 'd0', from: 'me@getaviance.site', timestamp: '2026-06-02T15:00:00Z' }], replies: [{ from: 'b@beta.com', company: 'Beta', subject: 'Re: Quick idea', snippet: 'Tell me more', text: 'Tell me more about <pricing>.\n\nThanks, Bea', repliedAt: '2026-06-02T09:00:00Z' }], bounces: [{ email: 'c@gamma.com', reason: 'no such user', bouncedAt: '2026-06-02T15:05:00Z' }] },
      { date: '2026-06-01', summary: { totalSent: 2, newSends: 2, totalReplies: 0 }, sent: [{ to: 'a@acme.com', company: 'Acme', subject: 'Quick idea', touch: 'd0', from: 'me@getaviance.site', timestamp: '2026-06-01T14:00:00Z' }, { to: 'b@beta.com', company: 'Beta', subject: 'Quick idea', touch: 'd0', from: 'you@getaviance.site', timestamp: '2026-06-01T15:00:00Z' }], replies: [], bounces: [] },
    ],
  };
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); if (String(url).endsWith('/api/mc/outreach')) return { ok: true, status: 200, text: async () => JSON.stringify(outreach) }; return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'Not found' }) }; };
  try {
    openMyStats(); await tick(); await tick();
    assert.ok(calls.some((u) => u.endsWith('/api/mc/outreach')), 'asks for the sending history');
    assert.ok(calls.some((u) => u.endsWith('/api/mc/archive')), 'and the saved history');
    assert.ok(!calls.some((u) => u.includes('/api/mc/hub/aviance')), 'not a client page: no trial to load');
    const h = el('tkHost').innerHTML;
    const txt = visibleText(h);
    // one row of four: emails sent, opened, replies, bounced — no first emails / follow-ups split
    assert.ok(h.includes('tk-keys tk-keys4'));
    for (const w of ['Emails sent 4', 'Opened 2 50% of emails sent', 'Replies 1 25% of emails sent', 'Bounced 1 25% of emails sent', 'me@getaviance.site 3 75%', 'Tell me more', 'Every email sent · 4', 'no such user', 'Saved history']) assert.ok(txt.includes(w), w);
    for (const w of ['First emails', 'Follow-ups', 'follow-up', 'Behind the scenes', 'Messages', 'Booking the call']) assert.ok(!txt.includes(w), 'gone: ' + w);
    assert.ok(h.includes('Hi &lt;Gamma&gt;') && !h.includes('<Gamma>'), 'escaped');
    assert.ok(h.includes('<div class="tk-reply-text">Tell me more about &lt;pricing&gt;.\n\nThanks, Bea</div>'), 'the whole reply, line breaks kept, escaped');
    assert.ok(h.includes('Emails sent per day · last 30 days'));
    assert.ok(txt.indexOf('Re: Quick idea') < txt.indexOf('Hi'), 'newest first');
    assert.equal(el('ptitle').textContent, 'My stats');
    // another trial never loads it
    calls.length = 0; openTrial('acme'); await tick();
    assert.ok(!calls.some((u) => u.endsWith('/api/mc/outreach')));
    assert.equal(renderMyOutreach(null, 'Could not reach it.').includes('Could not reach it.'), true);
  } finally { offline(); trialsStopTimer(); }
});

test('Paying clients: paid-plan applications (name + match % + Word + yes/no) and paying clients live here, not under Trials; a converted trial shows in both', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const clone2 = (o) => JSON.parse(JSON.stringify(o));
  const paidApp = Object.assign(clone2(simpleRows.fern), { id: 'stone-roofing', name: 'Stone Roofing', plan: 'growth', fitScore: { score: 72, grade: 'B', label: 'Good fit', confidence: 60 } });
  paidApp.simple.company = 'Stone Roofing'; paidApp.todo = (paidApp.todo || []).map((t) => Object.assign({}, t, { id: String(t.id).replace('fern-it', 'stone-roofing'), clientId: 'stone-roofing' }));
  const paidLive = Object.assign(clone2(simpleRows.acme), { id: 'birch-legal', name: 'Birch Legal', plan: 'scale' });
  paidLive.simple.company = 'Birch Legal';
  const hub = Object.assign({}, simpleHub, { stages: stagesWith({ intake: [simpleRows.fern, paidApp], live: [simpleRows.acme, paidLive] }), inquiries: { counts: { new: 1, contacted: 0, won: 0, lost: 0 }, open: 1, latest: [] } });
  trialsIngestHub(hub);
  const trials = renderTrialList(hub, { now: NOW });
  const paying = renderTrialList(hub, { now: NOW }, true);
  assert.ok(trials.includes('Fern IT') && !trials.includes('Stone Roofing') && !trials.includes('Birch Legal'), 'Trials: trial clients only');
  assert.ok(paying.includes('Stone Roofing') && paying.includes('Birch Legal') && !paying.includes('Fern IT') && !paying.includes('Acme Plumbing'), 'Paying clients: paying clients only');
  const app = visibleText(between(paying, '<div class="tk-app-row">', '</div></div>'));
  assert.ok(app.includes('Stone Roofing Growth 72% match Application (Word) ↓ Say yes Say no… Details'), app);
  assert.ok(paying.includes('New paying-client applications') && paying.includes('In progress — nothing needed from you</span>'));
  assert.ok(paying.includes("onclick=\"render('inquiries')\">Plan call requests · 1 open ›"), 'call requests without a website: one tap away');
  assert.equal(payingNavCount(), 2, 'the paid application + the new call request');
  // a paid client's page lights up Paying clients, and Back goes there
  openTrial('birch-legal');
  assert.deepEqual(navItems().filter((i) => i.isOn ? i.isOn() : i.view === currentView).map((i) => i.view), ['paying']);
  views.trial.back(); assert.equal(currentView, 'paying');
  // a converted trial: a paying client, and still in the Trials history
  const conv = Object.assign(clone2(simpleRows.acme), { id: 'cobalt', name: 'Cobalt HVAC', plan: 'starter', state: 'converted' }); conv.simple.company = 'Cobalt HVAC';
  const h2 = Object.assign({}, simpleHub, { stages: stagesWith({ won: [conv] }) });
  assert.ok(renderTrialList(h2, { now: NOW }).includes('Cobalt HVAC') && renderTrialList(h2, { now: NOW }, true).includes('Cobalt HVAC'));
  // nothing paid yet
  assert.ok(visibleText(renderTrialList(Object.assign({}, simpleHub, { stages: stagesWith({}) }), { now: NOW }, true)).includes('No paying clients yet'));
  trialsForget();
});

test('where everyone is: one tile per stage with its count on top of Trials and Paying clients; a tap shows just that stage; + Add a paying client yourself', () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const hub = Object.assign({}, simpleHub);
  trialsIngestHub(hub);
  const html = renderTrialList(hub, { now: NOW });
  const tiles = between(html, '<div class="tk-stages"', '</div>');
  for (const label of ['Applied', 'Booking the call', 'Call booked', 'Setting up', 'Warming up', 'Sending', 'Finished']) assert.ok(tiles.includes('<span>' + label + '</span>'), label);
  assert.ok(html.indexOf('tk-stages') < html.indexOf('New trial applications'), 'the tiles sit on top of the applications');
  const rows = tkListGroups(hub).needs.concat(tkListGroups(hub).going, tkListGroups(hub).done);
  const sending = rows.filter((x) => tkStageOf(x.row) === 'sending').length;
  assert.ok(sending > 0 && tiles.includes(`onclick="trialsSetStage(false,&quot;sending&quot;)" aria-pressed="false"><b>${sending}</b><span>Sending</span>`), 'the count per stage');
  // a tap: only that stage, with a way back
  tk.stage = { trials: 'sending' };
  const one = renderTrialList(hub, { now: NOW });
  assert.ok(one.includes('class="tk-stage on"') && one.includes('>All stages</button>'));
  assert.equal(count(one, /<button type="button" class="tk-person/g), sending, 'just the clients at that stage');
  assert.ok(!one.includes('New trial applications') && !one.includes('Needs you</h3>'));
  tk.stage = { trials: 'call' };
  assert.ok(renderTrialList(hub, { now: NOW }).includes('Nobody is at this stage right now.') || renderTrialList(hub, { now: NOW }).includes('tk-person'));
  tk.stage = null;
  // running clients are folded, not a long open list
  assert.ok(html.includes('<details class="tk-done tk-going" id="tkGoingGroup"') && !html.includes('id="tkGoingGroup" open'));
  // Paying clients: its own add button (with the plan)
  const paying = renderTrialList(hub, { now: NOW }, true);
  assert.ok(paying.includes('onclick="openNewPayingClient()">+ Add a paying client yourself</button>'));
  openNewPayingClient();
  const m = el('modal').innerHTML;
  assert.ok(m.includes('Add a paying client yourself') && m.includes('<select id="ntPlan">') && m.includes('<option value="starter" selected>Starter</option>') && m.includes('<option value="scale">Scale</option>'));
  closeModal(); trialsForget();
});

test('the application as a Word document: a real .docx (zip + WordprocessingML) with what they sent, the match and our analysis; the row downloads it', async () => {
  asOwner(); trialsForget(); asOwner();
  const d = { row: { id: 'stone-roofing', name: 'Stone <Roofing> & Co', plan: 'growth', contactName: 'Bob Stone', contactEmail: 'bob@stoneroofing.com', website: 'stoneroofing.com', fitScore: { score: 72, grade: 'B', label: 'Good fit' } },
    application: { receivedAt: '2026-10-01T14:00:00Z', source: 'inquiry', answers: [{ q: 'Plan they asked for', a: 'Growth' }, { q: 'What they sell', a: 'Commercial roofing' }],
      research: { status: 'done', score: { score: 72, grade: 'B', label: 'Good fit', confidence: 60, summary: '72/100 — good fit', parts: [{ label: 'Deal size', points: 12, max: 20, items: [{ status: 'good', text: 'Big roofs', points: 12, max: 12 }] }], questions: ['Who is your dream customer?'] },
        brief: { sentences: [{ text: 'Stone Roofing fixes commercial roofs in Texas.' }] }, business: { name: 'Stone Roofing', rating: 4.6, reviews: 40, address: 'Austin, TX' }, deep: { competitors: { items: [{ name: 'Top Roof', rating: 4.9, reviews: 12 }] } } } } };
  const blocks = tkApplicationBlocks(d, new Date('2026-10-02T10:00:00Z'));
  const text = blocks.map((b) => b.t || b.p || b.li || b.muted || (b.kv ? b.kv.join(': ') : '')).join('\n');
  for (const w of ['Stone <Roofing> & Co', 'Paying-client application · Growth plan', 'Match: 72% (Good fit, grade B)', 'Deal size: 12 of 20 points', 'Plan they asked for: Growth', 'Contact: Bob Stone · bob@stoneroofing.com', 'Stone Roofing fixes commercial roofs in Texas.', 'Rating: 4.6★ from 40 reviews', 'Top Roof — 4.9★ (12)', 'Who is your dream customer?']) assert.ok(text.includes(w), w);
  const bytes = tkDocxBytes(blocks);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'a zip');
  const s = Buffer.from(bytes).toString('latin1');
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) assert.ok(s.includes(part), part);
  assert.ok(Buffer.from(bytes).toString('utf8').includes('Stone &lt;Roofing&gt; &amp; Co'), 'escaped for XML');
  assert.equal(tkCrc32(new TextEncoder().encode('123456789')), 0xCBF43926, 'CRC-32 check value');
  // the row's button: loads the application fresh, then saves "<name> — application.docx"
  const saved = []; const was = globalThis.tkSaveFile;
  globalThis.fetch = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
  globalThis.tkSaveFile = (b, name, type) => saved.push([name, type, b.length]);
  try {
    await downloadApplication('stone-roofing');
    assert.equal(saved.length, 1);
    assert.equal(saved[0][0], 'Stone Roofing & Co — application.docx');
    assert.equal(saved[0][1], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } finally { globalThis.tkSaveFile = was; offline(); trialsForget(); }
});

test('a client page: Progress | Stats — Stats is the same view as My stats from their own sending, with "Who can see this": give access by email, stop all access', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const d = clone(ecreekDetail); const id = d.row.id;
  d.row.five = { sent: 120, replies: 6, positive: 2, booked: 1, qualified: 1 };
  d.dashboardAccess = { sharedWith: [{ email: 'owner@ecreek.com', at: '2026-10-02T10:00:00Z' }] };
  const growth = { days: ['2026-10-01', '2026-10-02'], email: { sent: [60, 60], replies: [2, 4], bounces: [1, 0], opened: [30, 20] } };
  const calls = [];
  globalThis.fetch = async (url, o) => { const u = String(url); calls.push([u, o && o.body ? JSON.parse(o.body) : null]);
    if (u.includes('/growth')) return { ok: true, status: 200, text: async () => JSON.stringify(growth) };
    if (u.includes('/api/mc/clients/')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, sharedWith: [] }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(d) }; };
  try {
    openTrial(id); await tick(); await tick();
    let h = el('tkHost').innerHTML;
    assert.ok(h.includes('tk-pane-switch') && h.includes('>Progress</button>') && h.includes('>Stats</button>'), 'the switch');
    assert.ok(h.includes('id="tkSec-messages"'), 'Progress first: what needs you');
    assert.ok(!calls.some(([u]) => u.includes('/growth')), 'no history fetched until Stats is opened');
    setClientPane(id, 'stats'); await tick(); await tick();
    assert.ok(calls.some(([u]) => u.includes('/growth')), 'Stats loads their history');
    h = el('tkHost').innerHTML; const txt = visibleText(h);
    assert.ok(!h.includes('id="tkSec-messages"'), 'only their stats');
    for (const w of ['Emails sent 120', 'Opened 50 41.7% of emails sent', 'Replies 6 5% of emails sent', 'Bounced 1', 'Who can see this', 'owner@ecreek.com', 'Give access', 'Stop all access']) assert.ok(txt.includes(w), w);
    assert.ok(h.includes('tk-keys tk-keys4'));
    el('tkAccessEmail').value = 'not an email'; await clientShare(id);
    assert.ok(!calls.some(([u, b]) => b && b.action === 'shareDashboard'), 'a bad address never goes');
    el('tkAccessEmail').value = ' boss@ecreek.com '; await clientShare(id);
    assert.ok(calls.some(([u, b]) => u.endsWith('/api/mc/clients/' + id) && b && b.action === 'shareDashboard' && b.email === 'boss@ecreek.com'), 'shareDashboard with the email');
    await clientUnshare(id);
    assert.ok(calls.some(([u, b]) => b && b.action === 'unshareDashboard'), 'unshareDashboard');
    setClientPane(id, 'progress'); assert.ok(el('tkHost').innerHTML.includes('id="tkSec-messages"'), 'back to Progress');
  } finally { offline(); trialsForget(); trialsStopTimer(); }
});

test('Saved history (owner only): list, download as a spreadsheet (.xlsx with Summary, Days, Emails sent, Replies, Bounces), save a copy, save and clear only after typing CLEAR', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const archive = { id: 'a1', createdAt: '2026-09-28T10:00:00Z', totals: { sent: 2, opened: 1, replies: 1, bounces: 0, days: 1, firstDay: '2026-06-01', lastDay: '2026-06-01' },
    days: [{ date: '2026-06-01', sent: 2, opened: 1, replies: 1, bounces: 0 }], sent: [{ at: '2026-06-01T14:00:00Z', to: 'a@acme.com', company: 'Acme & <Co>', subject: 'Quick idea', touch: 'd0', from: 'me@getaviance.site' }],
    replies: [{ at: '2026-06-02T10:00:00Z', from: 'a@acme.com', company: 'Acme', subject: 'Re: Quick idea', text: 'Yes please' }], bounces: [], leads: [{ email: 'a@acme.com', company: 'Acme', status: 'replied' }] };
  const bytes = tkXlsxBytes(tkArchiveSheets(archive));
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'a zip');
  const u8 = Buffer.from(bytes).toString('utf8');
  for (const part of ['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet6.xml', 'name="Summary"', 'name="Emails sent"', 'name="Replies"', 'name="Leads"', 'Acme &amp; &lt;Co&gt;', 'Yes please']) assert.ok(u8.includes(part), part);
  assert.equal(tkXlsxCol(0), 'A'); assert.equal(tkXlsxCol(25), 'Z'); assert.equal(tkXlsxCol(26), 'AA');
  const calls = []; const saved = []; const was = globalThis.tkSaveFile; let list = [{ id: 'a1', createdAt: archive.createdAt, totals: archive.totals }];
  globalThis.tkSaveFile = (b, name, type) => saved.push([name, type]);
  globalThis.fetch = async (url, o) => { const u = String(url); const b = o && o.body ? JSON.parse(o.body) : null; calls.push([u, b]);
    const ok = (x) => ({ ok: true, status: 200, text: async () => JSON.stringify(x) });
    if (u.endsWith('/api/mc/archive/a1') || u.endsWith('/api/mc/archive/a2')) return ok(archive);
    if (u.endsWith('/api/mc/archive') && b && b.action === 'clear') { list = list.concat([{ id: 'a2', createdAt: '2026-09-28T11:00:00Z', totals: archive.totals }]); return ok({ ok: true, archiveId: 'a2', cleared: { leads: 1, keys: [] } }); }
    if (u.endsWith('/api/mc/archive') && b && b.action === 'save') return ok({ ok: true, id: 'a3', totals: archive.totals });
    if (u.endsWith('/api/mc/archive')) return ok({ archives: list });
    if (u.endsWith('/api/mc/outreach')) return ok({ totals: { sent: 0, replies: 0, bounces: 0 }, days: [], inboxes: [] });
    return { ok: false, status: 404, text: async () => '{}' }; };
  try {
    openMyStats(); await tick(); await tick();
    let txt = visibleText(el('tkHost').innerHTML);
    for (const w of ['Saved history', 'Download spreadsheet', 'Save a copy now', 'Save and start fresh', 'Nothing sent since your last save']) assert.ok(txt.includes(w), w);
    await downloadArchive('a1');
    assert.deepEqual(saved[0], ['Aviance outreach 2026-09-28.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    await archiveSaveNow();
    assert.ok(calls.some(([u, b]) => u.endsWith('/api/mc/archive') && b && b.action === 'save'), 'save a copy');
    openArchiveClear(); el('arcConfirm').value = 'clear'; await archiveClearGo();
    assert.ok(!calls.some(([u, b]) => b && b.action === 'clear'), 'nothing cleared without typing CLEAR');
    el('arcConfirm').value = 'CLEAR'; await archiveClearGo(); await tick();
    assert.ok(calls.some(([u, b]) => b && b.action === 'clear' && b.confirm === 'CLEAR'), 'save and clear');
    assert.equal(saved.length, 2, 'the saved copy downloads right after');
    // the team (read-only) can download but not save or clear
    authUser.role = 'employee'; trialsRepaint('trial');
    txt = visibleText(el('tkHost').innerHTML);
    assert.ok(!txt.includes('Saved history') && !txt.includes('Save a copy now'), 'team: the saved copies are the owner\'s only');
  } finally { globalThis.tkSaveFile = was; offline(); trialsForget(); trialsStopTimer(); }
});

test('People inside: presence goes to the machine (sign in, the page opened, sign out); the owner sees who is online, when they signed in and out, time spent and the activity; team sign-ups wait for approval', async () => {
  asOwner(); trialsForget(); asOwner();
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/mc/presence')) { posts.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{"ok":true}' }; }
    if (u.endsWith('/api/mc/people')) return { ok: true, status: 200, text: async () => JSON.stringify({
      people: [
        { uid: 'u9', email: 'nim@aviance.online', name: 'Nimal Perera', role: 'employee', online: true, lastSignIn: new Date(Date.now() - 3600e3).toISOString(), lastSignOut: null, lastSeen: new Date().toISOString(), lastView: 'paying', sessions: 3, activeSecondsToday: 2520, activeSecondsTotal: 30000 },
        { uid: 'u1', email: 'owner@example.com', name: 'Owner', role: 'admin', online: false, lastSignIn: '2026-09-27T08:00:00Z', lastSignOut: '2026-09-27T10:00:00Z', lastSeen: '2026-09-27T10:00:00Z', lastView: 'trials', sessions: 9, activeSecondsToday: 0, activeSecondsTotal: 7200 },
      ],
      events: [
        { at: new Date().toISOString(), uid: 'u9', name: 'Nimal Perera', event: 'view', view: 'paying' },
        { at: new Date(Date.now() - 3600e3).toISOString(), uid: 'u9', name: 'Nimal Perera', event: 'signin' },
        { at: '2026-09-27T10:00:00Z', uid: 'u1', name: 'Owner', event: 'signout' },
      ] }) };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    peopleSignedIn(); await tick();
    assert.equal(posts[0].event, 'signin');
    peopleOnRender('paying'); await new Promise((r) => setTimeout(r, 1300));
    assert.deepEqual(posts[posts.length - 1], { event: 'view', view: 'paying' });
    await peopleKick(true);
    const h = renderPeople(); const txt = visibleText(h);
    for (const w of ['1 Online now', '2 People with access', 'Nimal Perera', 'Online now', 'Team · nim@aviance.online', '42 min', '8 h 20 min', 'Paying clients', 'Still in', 'Owner · owner@example.com', 'opened Paying clients', 'signed in', 'signed out']) assert.ok(txt.includes(w), w);
    // tap a person: only their activity
    peopleFilter('u1'); const one = visibleText(renderPeople());
    assert.ok(one.includes('Activity — Owner') && one.includes('signed out') && !one.includes('opened Paying clients'));
    peopleFilter(null);
    // a sign-up waiting for approval: counted on the menu, with Approve / Remove
    pp.pending = [{ id: 'p7', name: 'Kasun Silva', email: 'kasun@aviance.online', approved: false, role: 'employee', created_at: new Date().toISOString() }];
    assert.equal(peopleNavCount(), 1);
    const w = renderPeople();
    assert.ok(w.includes('Waiting for your approval') && w.includes('Kasun Silva') && w.includes('onclick="peopleApprove(&quot;p7&quot;)">Approve</button>'));
    assert.ok(navItems().some((i) => i.view === 'people' && i.badge === 1 && i.badgeTitle === '1 waiting for your approval'));
    await peopleSignOut();
    assert.equal(posts[posts.length - 1].event, 'signout');
    assert.equal(pp.people, null, 'signing out forgets the list');
  } finally { offline(); pp.pending = []; trialsForget(); }
});

test('Team: your own "working on" line, and a card per person — in the hub or not, where, what they are working on, the clients they look after; the owner chooses clients', async () => {
  asOwner(); trialsForget(); asOwner(); trialsIngestHub(simpleHub);
  authUser.uid = 'owner-1';
  const posts = [];
  const team = { team: [
      { uid: 'emp-1', name: 'Nimal Perera', email: 'n@a.com', role: 'employee', online: true, lastSeen: new Date().toISOString(), lastView: 'paying', status: { text: 'Writing the Birch <b>emails</b>', at: new Date(Date.now() - 20 * 60e3).toISOString() }, clients: [{ id: 'acme-plumbing', name: 'Acme Plumbing', state: 'sending', plan: 'trial' }] },
      { uid: 'owner-1', name: 'Limeth', email: 'o@a.com', role: 'admin', online: false, lastSeen: new Date(Date.now() - 3 * 3600e3).toISOString(), lastView: 'trials', status: null, clients: [] },
    ], owners: { 'acme-plumbing': ['emp-1'] } };
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/mc/team')) { if (init && init.method === 'POST') { posts.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{"ok":true}' }; } return { ok: true, status: 200, text: async () => JSON.stringify(team) }; }
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    await teamKick(true);
    const h = renderTeam(); const txt = visibleText(h);
    for (const w of ['What are you working on?', '1 in the hub now', 'Nimal Perera', 'In the hub', 'Working on Writing the Birch', 'Where Paying clients', 'Looks after Acme Plumbing', 'Limeth', 'Seen 3 h ago', 'Nothing written yet', 'Not in the hub', 'No clients yet', 'Nobody looks after these yet']) assert.ok(txt.includes(w), w);
    assert.ok(h.includes('&lt;b&gt;emails&lt;/b&gt;') && !h.includes('<b>emails'), 'escaped');
    assert.ok(h.includes('onclick="openTrial(&quot;acme-plumbing&quot;)">Acme Plumbing</button>'), 'a client opens its page');
    assert.ok(h.includes('onclick="teamOpenAssign(&quot;emp-1&quot;)">Choose clients</button>'), 'the owner chooses clients');
    // my own line
    el('tmStatus').value = 'Calling Fern IT';
    await teamSaveStatus();
    assert.deepEqual(posts[0], { action: 'status', text: 'Calling Fern IT' });
    // a team member: no "Choose clients"
    authUser.role = 'employee';
    assert.ok(!renderTeam().includes('Choose clients'));
    assert.ok(navItems().some((i) => i.view === 'team') && !navItems().some((i) => i.view === 'people'), 'the team sees Team, not Activity');
  } finally { offline(); asOwner(); trialsForget(); }
});

test('navigation badges: Trials = how many need you (red) · Paying clients = new plan requests + paid applications (red) · Calendar = call times waiting for your yes (amber) · Settings has none', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  trialsIngestHub(Object.assign({}, simpleHub, { inquiries: inquirySummaryOf(inquiryRecords) }));
  cal.reqs = calRequestsOf(calWeek);
  const items = navItems();
  assert.deepEqual(items.map((i) => [i.badge, i.tone || '', i.badgeTitle || '']), [[3, 'red', '3 need you'], [2, 'red', '2 need you'], [2, 'amber', '2 waiting for your yes'], ['', '', ''], ['', '', ''], ['', '', ''], ['', '', '']]);
  renderNav();
  const nav = el('tabBar').innerHTML;
  assert.ok(nav.includes('<span class="badge red" title="3 need you" aria-hidden="true">3</span>'));
  assert.ok(nav.includes('<span class="badge amber" title="2 waiting for your yes" aria-hidden="true">2</span>'));
  assert.ok(nav.includes('<span class="badge red" title="2 need you" aria-hidden="true">2</span>'));
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
  assert.ok(out.indexOf('Needs you</h3>') < out.indexOf('Bright Dental') && out.indexOf('Odd Co') < out.indexOf('In progress — nothing needed from you</span>') && out.indexOf('In progress — nothing needed from you</span>') < out.indexOf('Calm Co'));
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
  // how each email went (Messages), the "hasn't opened" to-do and the new alerts' to-dos (HUB-API "Delivery monitoring")
  const msgs = renderMessages(Object.assign({}, ecreekConvDetail, { conversation: Object.assign({}, ecreekConvDetail.conversation, { thread: Object.values(deliveryEntries) }) })).replace(/<div class="tk-cm-text">[\s\S]*?<\/div>/g, '').replace(/<div class="tk-cm-subj">[\s\S]*?<\/div>/g, '');
  assert.ok(msgs.includes('tk-cm-st bounced') && msgs.includes('tk-cm-st unopened'), 'the status lines are there to check');
  const watch = [unopenedTodo('ecreek-it', 'Sam')].concat(deliveryAlerts.map((a) => ({ id: 'alert-' + a.id + ':ecreek-it', text: a.title, urgent: true, action: { type: 'api', method: 'POST', path: '/api/mc/alerts', body: { action: 'ack', id: a.id } } })))
    .map((t) => ({ row: Object.assign({}, simpleRows.ecreek, { todo: [t], simple: Object.assign({}, simpleRows.ecreek.simple, { needsYou: true, next: '', needsReply: false }) }) }));
  for (const [where, h] of [['Messages with delivery', msgs], ...watch.map((d) => [d.row.todo[0].id + ' top', top(d)]), ['Trials list with the delivery to-dos', renderTrialList(Object.assign({}, simpleHub, { stages: stagesWith({ live: watch.map((d, i) => Object.assign({}, d.row, { id: 'w' + i })) }) }), { now: NOW })]]) {
    const text = visibleText(h);
    assert.ok(!BANNED.test(text), where + ': ' + (text.match(BANNED) || [])[0]);
    assert.ok(!/\b[a-z]+_[a-z_]+\b/.test(text) && !/\bundefined\b|\bnull\b|\[object Object\]/.test(text), where + ': ' + (text.match(/\b[a-z]+_[a-z_]+\b|\bundefined\b|\bnull\b|\[object Object\]/) || [])[0]);
  }
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
  assert.ok(renderCalRequest(calWeek.requests[1], calSettings(calSettingsFixture), { now: CAL_NOW }).includes('title="Say yes and email them the invite">Yes</button>'), 'short, and the hover says exactly what happens');
  assert.ok(renderInquiry(clone(inquiryRecords[0]), { now: NOW }).includes('>Start a free trial and email them</button>'));
  asOwner(); openNewTrialClient(); assert.ok(el('modal').innerHTML.includes('>Add them and send the email</button>')); closeModal();
  calendarForget();
});

/* ───────────── 7. Settings: everything else, as named sections ───────────── */
test('Settings: Alerts, Phone alerts, Your details, Keys, Google Meet, Inboxes & domains, Warm-up, Reply bot, Test run, Is everything running?, Behind the scenes, Advanced, Light or dark, Your account — each folds open, each says its state in one word', () => {
  const ctx = { hub: fullHub, at: Date.now(), alerts: fullHub.alerts, alertsAt: Date.now(), filter: 'open', open: {}, phone: '', dark: false, email: 'owner@example.com', now: NOW };
  const out = renderSettings(ctx);
  assert.deepEqual([...out.matchAll(/<span class="tk-set-title">([^<]+)<\/span>/g)].map((m) => m[1]), ['Alerts', 'Phone alerts', 'Your details', 'Keys', 'Google Meet', 'Inboxes &amp; domains', 'Warm-up', 'Reply bot', 'Test run', 'Is everything running?', 'Behind the scenes', 'Advanced', 'Light or dark', 'Your account']);
  assert.equal(count(out, /<details class="tk-set" id="tkSet-[a-z]+" ontoggle=/g), 14, 'all folded to begin with');
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
