/* Tests for the hub shell (index.html's inline script) and trials.js.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Both are plain browser scripts, so we load them into this process — shell
   first, then trials.js, exactly like the browser — with a tiny fake DOM and a
   fake Supabase client, then call the pure render functions with data shaped
   exactly like email-distributor/docs/HUB-API.md (incl. "v2 additions"). No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, acme, bright, fern, fernApplication, fernDetail, stagesWith, fullHub, emptyHub, detail, tinyGrowth, makeGrowth, research, shoppingV2, brightPurchase, inquiryRecords, inquiryCounts, inquirySummaryOf, hubWithInquiries, noInquiries, simpleRows, simpleHub, onboardCall, ecreekDetail } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() {}, select() {}, submit() {}, addEventListener() {}, scrollIntoView() {}, closest() { return null; }, getAttribute() { return null; } };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true }); // getter-only in Node 21+
globalThis.location = { hash: '', origin: 'https://aviance.store', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
globalThis.confirm = () => true; globalThis.prompt = () => 'a reason';
const winListeners = {}; globalThis.addEventListener = (type, fn) => { (winListeners[type] ||= []).push(fn); };

/* ───────────── fake Supabase ───────────── */
const supa = { session: null, user: null, profile: null, signOuts: 0 };
const fakeSb = {
  auth: {
    getSession: async () => ({ data: { session: supa.session } }),
    getUser: async () => ({ data: { user: supa.user } }),
    signInWithPassword: async () => ({ error: null }),
    signOut: async () => { supa.signOuts++; supa.session = null; },
    resetPasswordForEmail: async () => ({ error: null }),
    updateUser: async () => ({ error: null }),
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: supa.profile }) }) }) }),
};
globalThis.supabase = { createClient: () => fakeSb };

/* ───────────── load the shell, then trials.js ───────────── */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="trials.js">'));
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'trials.js'), 'utf8'), { filename: 'trials.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'inquiries.js'), 'utf8'), { filename: 'inquiries.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'messages.js'), 'utf8'), { filename: 'messages.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'autobuy.js'), 'utf8'), { filename: 'autobuy.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'push.js'), 'utf8'), { filename: 'push.js' });
supa.session = { access_token: 'test-token' }; // boot() has already seen "no session" and shown the login screen
after(() => trialsStopTimer());
const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const count = (s, re) => (s.match(re) || []).length;
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

/* ───────────── shell ───────────── */
test('shell: title, router knows the four places (and the pages inside them), nothing from the old workspace remains', () => {
  assert.ok(html.includes('<title>Aviance Hub — Trials</title>'));
  assert.deepEqual(Object.keys(views), ['trials', 'trial', 'trialPurchase', 'calendar', 'inquiries', 'inquiry', 'settings', 'trialsBoard']);
  assert.deepEqual(Object.keys(views).filter((v) => !views[v].back), ['trials', 'calendar', 'inquiries', 'settings'], 'the four places have no Back button; every page inside one has');
  for (const gone of ['viewDashboard', 'viewProjects', 'viewTeam', 'viewClients', 'viewCRM', 'viewProposals', 'viewInvoices', 'viewMyDay', 'viewDirectory', 'workspace_shared', 'workspace_admin', 'loadData', 'saveDB', 'openNewProject', 'composeGmail', 'submitJoin', 'approveJoin', 'applyRole', 'employeePersona', 'printDoc', 'crmStages', 'phases', 'Request to join', 'joinPane', 'roleMenu']) {
    assert.ok(!html.includes(gone), gone + ' is gone');
  }
  const trialsSrc = fs.readFileSync(path.join(root, 'trials.js'), 'utf8');
  for (const gone of [/typeof leads/, /\bleads\.find/, /\bsaveDB\b/, /\btodayShort\b/, /\bopenLead\b/, /trialsHealthCard/, /trialLineForName/, /trialStartFromLead/, /trialsBoot/, /I\.grid/]) {
    assert.ok(!gone.test(trialsSrc), 'trials.js no longer references ' + gone);
  }
});

test('shell: the full control panel pages (Mission Control) are signed-in links from Settings › Advanced and ⌘K, never in the navigation', () => {
  assert.deepEqual(MACHINE_PAGES.map(([p]) => p), ['/mc/queue', '/mc/warmup', '/mc/config', '/mc/test', '/mc/learning']);
  assert.deepEqual(MACHINE_PAGES.map((x) => x[2]), ['Waiting list', 'Warm-up circle', 'Advanced settings', 'Test mode', 'What we learned']);
  asOwner(); renderNav();
  const nav = el('navArea').innerHTML + el('tabBar').innerHTML;
  assert.ok(!nav.includes('openMachine') && !nav.includes('Mission Control') && !/Projects|CRM|Invoices/.test(nav));
  const adv = renderSettings({ open: { advanced: true } });
  for (const p of ['/mc', '/mc/queue', '/mc/warmup', '/mc/config', '/mc/test', '/mc/learning']) assert.ok(adv.includes(`onclick="openMachine(&quot;${p}&quot;)"`), 'Settings › Advanced opens ' + p);
  assert.ok(adv.includes('Full control panel ↗') && adv.includes('Advanced settings ↗'));
});

test('shell: only an approved admin profile gets in; anyone else is signed out with one line', async () => {
  authUser = null;
  supa.user = { id: 'u1', email: 'emp@example.com' };
  supa.profile = { id: 'u1', name: 'Emp', approved: true, role: 'employee', email: 'emp@example.com' };
  let before = supa.signOuts;
  await routeUser('loginErr');
  assert.equal(authUser, null);
  assert.equal(supa.signOuts, before + 1, 'employee is signed out');
  assert.equal(el('loginErr').textContent, 'This hub is for the Aviance owner.');
  assert.equal(el('login').style.display, 'flex');
  supa.profile = { id: 'u1', name: 'Nope', approved: false, role: 'admin' };
  before = supa.signOuts;
  await routeUser('loginErr');
  assert.equal(authUser, null); assert.equal(supa.signOuts, before + 1, 'unapproved admin is signed out');
  supa.session = { access_token: 'test-token' };
  supa.profile = { id: 'u1', name: 'Limethsith', approved: true, role: 'admin', email: 'owner@example.com' };
  await routeUser('loginErr');
  assert.equal(authUser.role, 'admin');
  assert.equal(el('app').style.display, 'grid');
  assert.equal(currentView, 'trials', 'lands on the Trials board');
  assert.equal(el('whoName').textContent, 'Limethsith');
});

test('shell: render() ignores unknown views and needs a signed-in owner', () => {
  asOwner();
  render('trials'); assert.equal(currentView, 'trials');
  render('dashboard'); assert.equal(currentView, 'trials');
  render('settings'); assert.equal(currentView, 'settings');
  render('trialAlerts'); assert.equal(currentView, 'settings', 'the old alerts page is gone (it is Settings › Alerts now)');
  authUser = null; render('trials'); assert.equal(currentView, 'settings', 'signed out: no navigation');
  asOwner(); render('trials');
});

test('shell: ⌘K lists trials and actions only; the bell shows trial to-dos and urgent alerts', () => {
  asOwner(); trialsIngestHub(fullHub);
  renderCmdk('');
  const list = el('cmdkList').innerHTML;
  for (const s of ['Acme Plumbing', 'Bright Dental', 'Add a trial client', '<b>Trials</b>', '<b>Settings</b>', '<b>Alerts</b>', 'Behind the scenes', 'Is everything running?', 'Warm-up circle', 'Test mode', 'Switch light / dark', 'Log out']) assert.ok(list.includes(s), '⌘K has ' + s);
  assert.ok(!/Machine alerts|Mission Control|>Machine</.test(list), 'no old words in ⌘K');
  assert.ok(!/New project|Add lead|Schedule meeting/.test(list));
  renderCmdk('bright'); assert.ok(el('cmdkList').innerHTML.includes('Bright Dental') && !el('cmdkList').innerHTML.includes('Acme Plumbing'));
  assert.equal(computeNotifs().length, 2);
  updateNotifBadge(); assert.equal(String(el('notifDot').textContent), '2');
});

test('shell: signing out forgets every cached answer, including the sparkline history', async () => {
  asOwner(); trialsIngestHub(fullHub); tkSparkPut('acme-plumbing', tkSliceGrowth(makeGrowth(14), 14));
  assert.ok(localStorage.getItem(TK_SPARK_KEY));
  await logout();
  assert.equal(localStorage.getItem(TK_SPARK_KEY), null);
  assert.equal(tk.hub, null); assert.equal(tkSparkGet('acme-plumbing'), null);
  supa.session = { access_token: 'test-token' }; // logout() signed the fake session out
  asOwner(); trialsIngestHub(fullHub);
});

/* ───────────── helpers ───────────── */
test('helpers: numbers, rates, relative times, error lists, attribute escaping, safe links', () => {
  assert.equal(tkNum(null), '—'); assert.equal(tkNum(1234), '1,234'); assert.equal(tkNum(0), '0');
  assert.equal(tkRate(0.91), '91%'); assert.equal(tkRate(null), '—'); assert.equal(tkPct1(0.012), '1.2%');
  assert.equal(tkRel('2026-10-17T11:59:18Z', NOW), '42 s ago');
  assert.equal(tkRel('2026-10-16T22:00:00Z', NOW), '14 h ago');
  assert.deepEqual(tkErrorList({ companyName: 'Company name is required.', _form: 'Nope' }), ['companyName: Company name is required.', 'Nope']);
  assert.equal(tkAttr('it"s <b>'), '&quot;it\\&quot;s &lt;b&gt;&quot;');
  assert.equal(tkStateLabel({ state: 'awaiting_purchase' }), 'Waiting for you to buy');
  assert.equal(tkSafeUrl('https://porkbun.com/x'), 'https://porkbun.com/x');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', 'ftp://x', 'https://a b']) assert.equal(tkSafeUrl(bad), '', bad);
  assert.ok(!tkLink('javascript:alert(1)', 'X').includes('href'), 'unsafe link renders as plain text');
});

/* ───────────── chart data mapping ───────────── */
test('charts: null is a gap, 0 is a recorded zero — mapped straight from the machine', () => {
  assert.deepEqual(tkSegments([1, null, 2, 3, null]), [[[0, 1]], [[2, 2], [3, 3]]]);
  assert.deepEqual(tkSegments([null, null]), []);
  assert.equal(tkNiceMax(3), 5); assert.equal(tkNiceMax(47), 50); assert.equal(tkNiceMax(0), 1);
  const m = tkSendingModel(tinyGrowth);
  assert.deepEqual(m.sent, [null, 0, 38, 0, null, 45]);
  assert.deepEqual(m.first, [null, 0, 0, 0, null, 20]);
  assert.deepEqual(m.follow, [null, 0, 38, 0, null, 25]);
  assert.deepEqual(m.replies, [null, 0, 0, 1, null, 3]);
  assert.deepEqual(m.booked, [null, 0, 0, 0, null, 1]);
  assert.equal(m.totals.sent, 83); assert.equal(m.totals.replies, 4); assert.equal(m.any, true);
  assert.deepEqual(m.running.sent, [0, 0, 38, 38, 38, 83], 'running total holds through gaps');
  const warmOnly = { days: tinyGrowth.days, email: Object.fromEntries(Object.keys(tinyGrowth.email).map((k) => [k, [null, 0, 0, 0, null, 0]])), warmup: tinyGrowth.warmup };
  assert.equal(tkSendingModel(warmOnly).any, false, 'warm-up days carry email zeros — that is not sending');
  const w = tkWarmupModel(tinyGrowth);
  assert.deepEqual(w.sent, [null, 30, 30, null, 30, 31]); assert.deepEqual(w.rate, [null, 0.9, 0.92, null, 0.94, 0.95]); assert.equal(w.lastRate, 0.95);
  const sl = tkSliceGrowth(makeGrowth(45), 14);
  assert.equal(sl.days.length, 14); assert.equal(sl.email.sent.length, 14); assert.equal(sl.inboxes[0].rate.length, 14);
  assert.ok(sl.placement.every((x) => x.day >= sl.days[0]), 'placement trimmed to the range');
});

test('placement: seed, DKIM Validator (SpamAssassin, lower is better) and mail-tester (/10) each judged against the Day-1 line', () => {
  const p = tkPlacementModel(tinyGrowth);
  assert.deepEqual(p.seed, [null, 0.9, null, null, null, null]);
  assert.deepEqual(p.sa.high, [null, null, 3.2, null, null, null], '3.2 points: too high for Day 1');
  assert.deepEqual(p.sa.pass, [null, null, null, 1.4, null, null]);
  assert.deepEqual(p.sa.spam, [null, null, null, null, null, 5.6], '5+ points: spam');
  assert.deepEqual(p.mt.pass, [null, null, null, null, 9.1, null]);
  assert.ok(p.anySeed && p.anySa && p.anyMt);
  const v = (x) => tkSpamVerdict(x);
  assert.equal(v({ tool: 'mail-tester', score: 9.1 }).level, 'pass'); assert.ok(v({ tool: 'mail-tester', score: 9.1 }).text.includes('Day 1 needs 8+'));
  assert.equal(v({ tool: 'mail-tester', score: 7.5 }).level, 'fail'); assert.ok(v({ score: 7.5 }).text.includes('too low for Day 1'));
  assert.equal(v({ tool: 'dkimvalidator', spamAssassin: 1.4 }).level, 'pass'); assert.ok(v({ spamAssassin: 1.4 }).text.includes('1.4 SpamAssassin points — passes (Day 1 needs 2 or less)'));
  assert.equal(v({ spamAssassin: 3.2 }).level, 'high'); assert.equal(v({ spamAssassin: 5 }).level, 'spam'); assert.ok(v({ spamAssassin: 5.6 }).text.includes('marked as spam'));
  assert.equal(v({ spamAssassin: 1.4, pass: false }).level, 'fail', "the machine's pass=false wins (DKIM/SPF failed)");
  assert.equal(v({ score: 7.9, pass: true }).level, 'pass', "the machine's pass=true wins");
  assert.ok(v({ error: 'no answer' }).text.includes("Couldn't finish: no answer"));
  const html = renderPlacementGrowth(tinyGrowth);
  for (const s of ['Seed test — share that landed in the inbox', 'Spam test — SpamAssassin points (lower is better)', 'Spam test — mail-tester score (out of 10, higher is better)', 'Day 1 needs 2 or less', '5+ = spam', 'Day 1 needs 8+', 'Needed for Day 1 · 85%']) assert.ok(html.includes(s), s);
  assert.ok(html.includes('Passes') && html.includes('Too high for Day 1') && html.includes('Marked as spam'), 'legend names each verdict colour');
  assert.ok(!html.includes('Too low for Day 1'), 'a verdict that never happened is not in the legend');
  const tips = JSON.parse([...html.matchAll(/data-tips="([^"]*)"/g)][0][1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  assert.ok(tips[2].r.some((r) => r[1].includes('DKIM Validator') && r[1].includes('too high')), 'tooltip names the tool');
  assert.ok(tips[2].r.some((r) => r[1].includes('hello@acme-team.com') && r[0] === '1.1 pts'), 'per inbox in the tooltip');
});

test('charts: the SVG draws nothing on gap days, a thin tick on zero days, and breaks lines at gaps', () => {
  const m = tkSendingModel(tinyGrowth);
  const svg = renderChart({ days: m.days, height: 160, bars: [{ label: 'First emails', color: '--c1', values: m.first }, { label: 'Follow-ups', color: '--c2', values: m.follow }] });
  assert.equal(count(svg, /class="tk-zero"/g), 2, 'two recorded-zero days → two ticks');
  assert.equal(count(svg, /style="fill:var\(--c[12]\)"/g), 3, '3 bar segments: day 2 ×1 (0 first emails), day 5 ×2');
  const slot = 1000 / 6; for (const i of [0, 4]) { const gapX = ((i + 0.5) * slot - 15).toFixed(1); assert.ok(!svg.includes(`x="${gapX}"`) && !svg.includes(`M${gapX} `), 'nothing at all on gap day ' + i); }
  assert.ok(svg.includes('tk-legend') && svg.includes('First emails') && svg.includes('Follow-ups'), 'legend for two series');
  const w = tkWarmupModel(tinyGrowth);
  const rate = renderChart({ days: w.days, percent: true, lines: [{ label: 'Inbox rate', color: '--c1', values: w.rate }], refs: [{ value: 0.9, label: 'Ready · 90%' }, { value: 0.8, label: 'Low · 80%' }] });
  assert.equal(count(rate, /class="tk-line"/g), 2, 'the gap on day 3 splits the line in two');
  assert.equal(count(rate, /class="tk-refline"/g), 2); assert.ok(rate.includes('Ready · 90%') && rate.includes('Low · 80%'));
  assert.ok(!rate.includes('tk-legend'), 'single series: no legend box');
  assert.ok(rate.includes('>100%<') && rate.includes('>0%<'), 'percent axis labels in HTML');
  assert.ok(!/<text/.test(svg + rate), 'no SVG text — labels stay HTML so they never shrink below 13px');
  assert.ok(renderChart({ days: ['2026-10-17', '2026-10-18'], lines: [{ label: 'x', color: '--c1', values: [null, 5] }] }).includes('class="tk-pt"'), 'an isolated value is a dot');
  assert.ok(renderSpark([null, 0.9, null], { kind: 'line', percent: true }).includes('tk-pt tk-pt-s'), 'a lone sparkline value is a small dot');
});

test('charts: tooltips say plain words and a null day says "Nothing recorded"; a table twin exists', () => {
  const html = renderSendingGrowth(tkSendingModel(tinyGrowth), acme);
  const tips = JSON.parse(html.match(/data-tips="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  assert.equal(tips.length, 6);
  assert.equal(tips[0].note, 'Nothing recorded'); assert.deepEqual(tips[0].r, []);
  assert.deepEqual(tips[2].r.map((r) => r[1]), ['emails sent', 'first emails', 'follow-ups', 'replies', 'positive replies', 'calls booked']);
  assert.equal(tips[2].r[0][0], '38'); assert.equal(tips[1].r[0][0], '0', 'a recorded zero says 0, not "nothing recorded"');
  assert.ok(tips[5].note.includes('83 sent'), 'running totals in the tooltip');
  assert.ok(html.includes('Show the numbers') && html.includes('<th>Follow-ups</th>'), 'table view');
  const warmOnly = { days: tinyGrowth.days, email: Object.fromEntries(Object.keys(tinyGrowth.email).map((k) => [k, [null, 0, 0, 0, null, 0]])) };
  assert.ok(renderSendingGrowth(tkSendingModel(warmOnly), acme).includes('No sending yet — starts on Day 1'));
});

/* ───────────── board ───────────── */
test('renderBoard: full board with clients across stages, sparklines only where there is something to chart', () => {
  const g14 = tkSliceGrowth(makeGrowth(45), 14);
  const html = renderBoard(fullHub, { at: Date.now(), now: NOW, sparks: { 'acme-plumbing': g14 } });
  for (const s of ['Acme Plumbing', 'Bright Dental', 'Cobalt HVAC', 'Fern IT']) assert.ok(html.includes(s), 'client name ' + s);
  assert.ok(html.includes('Sending — Day 12 of 30') && html.includes('Waiting for you to buy'));
  assert.ok(html.includes('Buy bright-team.com and 2 inboxes, then paste the logins'));
  assert.ok(!html.includes('tk-bar') && !html.includes('Heartbeat') && !html.includes('Machine setup'), 'how the system is running moved to Settings');
  assert.ok(renderSystemStatus(fullHub.machine, { now: NOW }).includes('Setup is not finished. Still to set: Telegram messages, the uptime check (Healthchecks).'));
  assert.ok(html.includes('<h3>All trials by stage</h3>') && html.includes('<h3>Every to-do</h3>'));
  assert.ok(!html.includes('<b>Ended</b>'), 'empty Ended column is skipped');
  assert.ok(html.includes('<h3>Waiting list</h3>') && html.includes('Delta Roofing') && html.includes('>Start their trial now</button>') && html.includes('>Say no…</button>'));
  const ac = html.indexOf('class="tk-card" onclick="openTrial(&quot;acme-plumbing&quot;)"'); assert.ok(ac > 0);
  const m2 = /<div class="tk-card( review)?"/g; m2.lastIndex = ac + 20; const nx = m2.exec(html); const nextCard = nx ? nx.index : -1;
  const acmeCard = html.slice(ac, nextCard > 0 ? nextCard : ac + 6000);
  assert.ok(acmeCard.includes('Sent · 14 days') && acmeCard.includes('Inbox rate') && count(acmeCard, /class="tk-spark"/g) === 2, 'acme card: two sparklines');
  assert.ok(html.includes('id="tkSpark-cobalt-hvac"'), 'converted client gets a (lazy) sparkline slot');
  assert.ok(!html.includes('id="tkSpark-bright-dental"') && !html.includes('id="tkSpark-fern-it"'), 'nothing to chart before warm-up → no slot');
  const cardStart = html.indexOf('class="tk-card" onclick="openTrial(&quot;bright-dental&quot;)"');
  const brightCard = html.slice(cardStart, html.indexOf('</div>\n  </div>', cardStart) + 1);
  assert.ok(brightCard.includes('<b>—</b>'), 'null five renders as —, never 0');
  assert.ok(html.indexOf('Buy bright-team.com') < html.indexOf('Decide the dispute'), 'urgent first');
});

test('renderBoard: empty board, and hostile names are escaped', () => {
  const e = renderBoard(emptyHub, { now: NOW });
  assert.ok(e.includes('No trials yet') && e.includes('When someone applies on your website, they show up here.') && e.includes('Nothing waiting on you'));
  const evil = Object.assign({}, acme, { id: 'evil', name: '<img src=x onerror=alert(1)>', todo: [{ id: 'x', text: '<script>alert(2)</script>', urgent: true, since: null, action: { type: 'none' } }] });
  const hub = Object.assign({}, fullHub, { stages: stagesWith({ live: [evil] }), todos: [Object.assign({ clientId: 'evil', clientName: evil.name }, evil.todo[0])] });
  const h = renderBoard(hub, { now: NOW });
  assert.ok(!h.includes('<img src=x') && !h.includes('<script>alert(2)') && h.includes('&lt;img src=x'));
});

/* ───────────── the simple Trials list (row.simple) ───────────── */
const between = (html, a, b) => { const i = html.indexOf(a); const j = b ? html.indexOf(b, i + 1) : html.length; return html.slice(i, j < 0 ? html.length : j); };
const visibleText = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('Trials list: one row per trial client — company, person, the journey (bar + "Step 2 of 5 — …"), the plain sentence and what is next; Needs you, In progress, then a folded Done / not taken', () => {
  const html = renderTrialList(simpleHub, { now: NOW });
  const order = ['Fern IT', 'Bright Dental', 'eCreek IT', 'Delta Roofing', 'Gale Roofing', 'Acme Plumbing', 'Cobalt HVAC', 'Iris Dental'];
  let last = -1; for (const name of order) { const i = html.indexOf('<span class="tk-person-co">' + name + '</span>'); assert.ok(i > last, 'row order: ' + name); last = i; }
  assert.equal(count(html, /<button type="button" class="tk-person/g), 8, 'one row per trial client');
  assert.ok(!html.includes('tk-person-co">Aviance<'), "the owner's own rows are not trial clients");
  // needs you: a red heading, then the three rows with a red edge and a red "You need to…" line
  const needs = between(html, '<h3 class="tk-group red">Needs you</h3>', '<h3 class="tk-group">In progress</h3>');
  assert.equal(count(needs, /class="tk-person needs"/g), 3); assert.equal(count(needs, /class="tk-person-you"/g), 3);
  assert.ok(needs.includes('<span class="tk-person-name">Lee Park</span>') && needs.includes('Sam Test') && needs.includes('Raj Patel'), "the person's name on each row");
  assert.ok(needs.includes('<span class="tk-person-say">New application — read it and say yes or no</span>'));
  assert.ok(needs.includes('<span class="tk-person-you">Sam wrote — answer them</span>'), 'they wrote and nobody answered: that is the red line');
  assert.ok(needs.includes('<span class="tk-person-step">Step 2 of 5 — Onboarding call</span>') && needs.includes('<span class="tk-person-step">Step 1 of 5 — Applied</span>') && needs.includes('<span class="tk-person-step">Step 3 of 5 — Setting up</span>'));
  const going = between(html, '<h3 class="tk-group">In progress</h3>', '<details');
  assert.equal(count(going, /tk-person-you|tk-person needs/g), 0, 'in progress: no red');
  assert.ok(going.includes('Sending — day 12 of 30, 2 calls booked') && going.includes('<span class="tk-person-next">Nothing for you: the Friday update goes out today</span>'));
  assert.ok(going.includes('Step 4 of 5 — Sending emails</span>') && !going.includes('Day 12 of 30'), 'the plain sentence already says day 12 of 30: not said twice');
  // done / not taken: folded, with a count, remembered when opened
  const done = between(html, '<details class="tk-done"');
  assert.ok(done.startsWith('<details class="tk-done" id="tkDoneGroup" ontoggle="trialsDoneToggle(this.open)">'), 'closed by default');
  assert.ok(done.includes('Done / not taken') && done.includes('<span class="tk-done-count">2</span>') && done.includes('Finished — became a client') && done.includes('Step 5 of 5 — Done'));
  const iris = between(done, 'Iris Dental', '</button>');
  assert.ok(iris.includes('<span class="pill grey">Not taken</span>') && !iris.includes('tk-bar5') && !iris.includes('tk-person-say'), 'declined: "Not taken", no journey, no second "Declined"');
  assert.ok(renderTrialList(simpleHub, { doneOpen: true }).includes('id="tkDoneGroup" open'), 'stays open across the 60-second refresh');
  trialsDoneToggle(true); assert.equal(tk.doneOpen, true); trialsDoneToggle(false);
  // clicking a row opens that trial (an application waiting for review opens at the application)
  assert.ok(html.includes('onclick="openTrial(&quot;acme-plumbing&quot;)"') && html.includes("onclick=\"openTrial(&quot;fern-it&quot;,null,'application')\""));
  // kept: adding a client yourself (at the bottom); gone: the old links row, the inquiry strip
  assert.ok(html.indexOf('onclick="openNewTrialClient()">+ Add a trial client yourself</button>') > html.indexOf('tkDoneGroup'));
  assert.ok(!html.includes('tk-more') && !html.includes('iq-strip') && !html.includes('openPhoneAlerts'), 'phone alerts, alerts and behind the scenes live in Settings now');
  const calm = renderTrialList(Object.assign({}, simpleHub, { stages: stagesWith({ live: [simpleRows.acme] }) }), {});
  assert.ok(calm.includes("Nothing needs you right now. We'll tell you when something does.") && !calm.includes('Needs you</h3>') && !calm.includes('tk-done'));
});

test('Trials list: the clutter is gone — no stages board, no status strip, no counts, no to-do panel, no sparklines, no jargon', async () => {
  const lists = [renderTrialList(simpleHub, { now: NOW }), renderTrialList(fullHub, { now: NOW })];
  for (const html of lists) {
    for (const gone of ['tk-board', 'tk-col', 'tk-bar"', 'Heartbeat', 'Last send', 'Active trials', 'Usage', 'Redis', 'on the machine', 'waiting on you', 'Stages', 'What you need to do', 'Also on the machine', 'tk-spark', 'tk-five', 'Mission Control', 'Machine setup', 'Promote'])
      assert.ok(!html.includes(gone), 'not on the Trials screen: ' + gone);
    assert.ok(!/\bmachine\b|heartbeat|pipeline|\btick\b|\bstates?\b/i.test(visibleText(html)), 'plain words only: ' + visibleText(html).match(/\bmachine\b|heartbeat|pipeline|\btick\b|\bstates?\b/i));
  }
  // through the router, as the owner lands on it: one board call + the check, never growth history
  asOwner(); trialsForget(); asOwner();
  const calls = [];
  globalThis.fetch = async (url, init) => { const u = new URL(url); calls.push([init.method, u.pathname]); if (u.pathname === '/api/mc/hub') return ok(simpleHub)(); if (u.pathname === '/api/mc/alerts') return ok({ alerts: fullHub.alerts })(); return ok({ ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 })(); };
  try {
    render('trials'); await new Promise((r) => setTimeout(r, 5));
    const screen = el('tkHost').innerHTML;
    assert.ok(screen.includes('tk-person-co">eCreek IT<') && !screen.includes('Heartbeat') && !screen.includes('tk-board'));
    assert.equal(el('psub').textContent, 'Who is where, and what needs you');
    assert.ok(!calls.some((c) => c[1].includes('/growth')), 'no growth history for the list');
    assert.deepEqual(calls.filter((c) => c[1] === '/api/mc/onboard-calls/check'), [['POST', '/api/mc/onboard-calls/check']], 'the check is asked for once');
    render('trialsBoard'); await new Promise((r) => setTimeout(r, 5));
    assert.ok(el('tkHost').innerHTML.includes('<h3>All trials by stage</h3>') && el('tkHost').innerHTML.includes('Start their trial now'), 'the stages, the to-dos and the waiting list live on Behind the scenes');
    assert.equal(el('backBtn').style.display, 'grid', 'Behind the scenes has a Back button (to Settings)'); goBack(); assert.equal(currentView, 'settings');
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(el('tkHost').innerHTML.includes('Last check-in') && el('tkHost').innerHTML.includes('Yes. Everything is running.'), 'how the system is running: Settings');
  } finally { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; trialsStopTimer(); }
});

test('Trials list: an older machine without row.simple falls back to the state and the to-dos; an empty list says what to expect', () => {
  const html = renderTrialList(fullHub, { now: NOW });
  const needs = between(html, 'Needs you</h3>', 'In progress</h3>');
  assert.ok(needs.includes('Fern IT') && needs.includes('Applied — waiting for your review') && needs.includes("You need to review Fern IT's trial application."), 'an application to review needs you');
  assert.ok(needs.includes('Bright Dental') && needs.includes('Waiting for you to buy') && needs.includes('You need to buy bright-team.com and 2 inboxes, then paste the logins.'), 'an urgent to-do needs you; the red line is that to-do');
  const going = between(html, 'In progress</h3>', '<details');
  assert.ok(going.includes('Acme Plumbing') && going.includes('Sending — Day 12 of 30') && going.includes('Decide the dispute on the call with bob@example.com') && going.includes('Ann Lee'));
  assert.ok(going.includes('Step 4 of 5 — Sending emails'), 'the step comes from the state');
  assert.ok(between(html, '<details class="tk-done"').includes('Cobalt HVAC'), 'converted → Done');
  const e = renderTrialList(emptyHub, { now: NOW });
  assert.ok(e.includes('No trials yet') && e.includes('When someone applies on your website, they show up here.') && e.includes('Add a trial client yourself'));
  assert.ok(tkSimple({}).label === '—' && tkSimple({ state: 'sending' }).step === 'sending' && tkSimple({ state: 'declined' }).done);
});

test('Trials list: every value from the machine is escaped, ids only reach the click handler as a JSON string', () => {
  const evil = Object.assign({}, acme, { id: 'x");alert(1);("', name: '<img src=x onerror=alert(1)>', contactName: 'x',
    simple: { step: 'sending', company: '<img src=x onerror=alert(1)>', person: '<b onclick=alert(2)>Sam</b>', label: '<script>alert(3)</script>', next: '"><svg onload=alert(4)>', needsYou: true, since: '2026-10-17T00:00:00Z', dayOf30: 3 } });
  const html = renderTrialList(Object.assign({}, simpleHub, { stages: stagesWith({ live: [evil] }) }), {});
  assert.ok(!html.includes('<img src=x') && !html.includes('<b onclick') && !html.includes('<script>alert(3)') && !html.includes('"><svg onload'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('&lt;script&gt;alert(3)&lt;/script&gt;') && html.includes('&quot;&gt;&lt;svg onload=alert(4)&gt;'));
  assert.ok(html.includes('onclick="openTrial(&quot;x\\&quot;);alert(1);(\\&quot;&quot;)"'), 'the id is a JSON string inside the handler');
  assert.ok(html.includes('Step 4 of 5 — Sending emails · Day 3 of 30'), 'Day N of 30 while sending, when the sentence does not already say it');
});

test('the Trials badge counts the trial clients who need you (red), in the sidebar and the phone tab bar', () => {
  asOwner(); trialsIngestHub(simpleHub);
  assert.equal(trialsNavCount(), 3); renderNav();
  for (const id of ['navArea', 'tabBar']) {
    const nav = el(id).innerHTML;
    assert.ok(nav.includes('aria-label="Trials — 3 need you"') && nav.includes('<span class="badge red" title="3 need you" aria-hidden="true">3</span>'), id);
  }
  const one = Object.assign({}, simpleHub, { stages: stagesWith({ intake: [simpleRows.fern], live: [simpleRows.acme] }) });
  trialsIngestHub(one); renderNav(); assert.ok(el('navArea').innerHTML.includes('title="1 needs you" aria-hidden="true">1<'));
  trialsIngestHub(Object.assign({}, simpleHub, { stages: stagesWith({ live: [simpleRows.acme] }) })); assert.equal(trialsNavCount(), '');
  trialsIngestHub(fullHub);
});

/* ───────────── a trial: plain header, journey, onboarding call, behind the scenes ───────────── */
test('trial page: three questions on top — Where are they? What happens next? What do you need to do? (one big button) — then the call, the application and Behind the scenes, folded', () => {
  const html = renderTrialDetail(ecreekDetail, 'overview', { now: NOW });
  const top = between(html, '<section class="card tk-top', '</section>');
  assert.ok(top.includes('<b>Sam Test</b>') && top.includes('href="mailto:sam@ecreek.io"') && top.includes('href="https://ecreek.io"'));
  assert.deepEqual([...top.matchAll(/<h3 class="tk-q-title">([^<]+)<\/h3>/g)].map((m) => m[1]), ['Where are they?', 'What happens next?', 'What do you need to do?']);
  // Where are they? — the one journey, big, with every step's name; then the plain sentence
  const steps = [...top.matchAll(/<li class="(done|now|todo)"[^>]*><span class="tk-j-dot" aria-hidden="true">[^<]*<\/span><span class="tk-j-name">([^<]+)<\/span>/g)].map((m) => m[1] + ':' + m[2]);
  assert.deepEqual(steps, ['done:Applied', 'now:Onboarding call', 'todo:Setting up', 'todo:Sending emails', 'todo:Done']);
  assert.ok(top.includes('<li class="now" aria-current="step">') && top.includes('aria-label="The trial journey, step 2 of 5"'));
  assert.ok(top.includes('<p class="tk-jcap" aria-hidden="true">Step 2 of 5 — Onboarding call</p>'), 'a phone shows the step in words above the bar');
  assert.ok(top.includes('<p class="tk-q-big">Accepted — they replied about the call, answer them</p>'));
  // What happens next? — never the same words as the other two answers
  assert.ok(top.includes("<p class=\"tk-q-text\">It's your turn. Once you've done the step below, we carry on.</p>"));
  // What do you need to do? — ONE big button
  assert.equal(count(top, /class="btn tk-primary"/g), 1);
  assert.ok(top.includes('<p class="tk-q-say">Sam wrote to you. Read it under Messages below and write back there.</p><button type="button" class="btn tk-primary" onclick="tkFocusReply()">Answer Sam\'s message</button>'));
  assert.ok(top.includes('class="card tk-top needs"'), 'a red edge: this trial needs you');
  for (const gone of ['Mission Control', 'Day 1', 'Day 30', 'tk-pills', 'reply waiting 3 h', '← All trials', 'Refresh', 'Needs you']) assert.ok(!top.includes(gone), 'not at the top: ' + gone);
  // then: Messages, the onboarding call, the application (decided → one folded line), Behind the scenes (folded)
  const iTop = html.indexOf('tk-top'), iMsgs = html.indexOf('id="tkSec-messages"'), iCall = html.indexOf('id="tkSec-onboardcall"'), iApp = html.indexOf('<details class="tk-appbox" id="tkSec-application">'), iBehind = html.indexOf('<details class="tk-behind" id="tkBehind" ontoggle="trialsBehindToggle(this.open)">');
  assert.ok(iTop >= 0 && iTop < iMsgs && iMsgs < iCall && iCall < iApp && iApp < iBehind, 'top → messages → call → application → behind the scenes');
  assert.ok(html.indexOf('</section><div id="tkMsgHost"><section class="card tk-msgs" id="tkSec-messages">') === html.indexOf('</section>', iTop), 'Messages comes right after the three questions');
  assert.ok(!html.includes('What you need to do') && !html.includes('Also on your list'), 'the reply to-do is the big button, not a second list');
  assert.ok(!/\bmachine\b|heartbeat|pipeline|\btick\b|\bstates?\b/i.test(visibleText(html.slice(0, iBehind))), 'plain words above Behind the scenes');
  const behind = html.slice(iBehind);
  for (const inside of ['id="tkTabBar"', 'class="tk-strip-item', 'Full control panel ↗', 'Day 1', 'reply waiting 3 h', 'Onboarding</span>', '>Refresh</button>']) assert.ok(behind.includes(inside), 'behind the scenes has ' + inside);
  assert.ok(renderTrialDetail(ecreekDetail, 'overview', { behindOpen: true }).includes('id="tkBehind" open'), 'stays open once opened');
  assert.ok(!renderTrialDetail(detail, 'overview', {}).includes('<h3>Onboarding call</h3>'), 'no acceptance email yet: no card');
  // another to-do (not the one at the top) is listed under "Also on your list"
  const two = Object.assign({}, ecreekDetail, { row: Object.assign({}, simpleRows.ecreek, { todo: simpleRows.ecreek.todo.concat([{ id: 'paid:ecreek-it', text: 'Mark the invoice paid', urgent: false, action: { type: 'api', method: 'POST', path: '/api/mc/clients/ecreek-it', body: { action: 'markPaid' } } }]) }) });
  const t2 = renderTrialDetail(two, 'overview', { now: NOW });
  assert.ok(t2.includes('<h3>Also on your list</h3>') && t2.includes('Mark the invoice paid') && !between(t2, 'Also on your list', 'tkBehind').includes('Answer Sam about the onboarding call'));
});

test('onboarding call card: label, five steps with times, Book by, buttons by status — and no copy of the emails (they live under Messages: "See the messages")', () => {
  const row = simpleRows.ecreek;
  const html = renderOnboardCall(onboardCall, row, { now: NOW });
  assert.ok(html.includes('<h3>Onboarding call</h3>') && html.includes('They replied — answer them below'));
  assert.equal(count(html, /<li class="done"><span class="tk-oc-tick" aria-hidden="true">✓<\/span>/g), 3); assert.equal(count(html, /<li class="todo">/g), 2);
  assert.ok(html.includes('Acceptance email sent</span><span class="tk-oc-at"') && html.includes(tkDateTime('2026-10-16T09:00:00Z')));
  assert.ok(html.includes('<p class="tk-oc-due">Book by ' + tkDayName('2026-10-20T10:00:00Z') + '</p>'));
  assert.ok(html.includes('1 reminder sent · next one') && html.includes('href="https://cal.com/aviance/onboarding"') && html.includes('Emails go from hello@aviance.store.'));
  // the emails: not here any more — one line pointing to Messages (no second thread, no second reply box)
  assert.ok(!html.includes('Hi Sam, good news') && !html.includes('Tuesday 3 pm works') && !html.includes('<textarea') && !html.includes('tkOcReply'), 'no copy of the thread');
  assert.ok(html.includes('<p class="tk-oc-msgs">Your emails with Sam are under Messages. <button type="button" class="tk-textbtn" onclick="tkGoTo(&quot;messages&quot;)">See the messages</button></p>'));
  // buttons while they have not booked
  assert.ok(html.includes('type="datetime-local"') && html.includes('trialOcMarkBooked(&quot;ecreek-it&quot;)">Mark call booked'));
  assert.ok(html.includes('trialOcAction(&quot;ecreek-it&quot;,&quot;resend&quot;)">Send the first email again') && html.includes('trialOcAction(&quot;ecreek-it&quot;,&quot;stopReminders&quot;)">Stop the reminder emails'));
  assert.ok(!html.includes('Call done</button>') && !html.includes("They didn't show"), 'nothing booked yet: no Call done / no-show');
  // overdue → red
  const late = renderOnboardCall(Object.assign({}, onboardCall, { status: 'overdue', overdue: true }), row);
  assert.ok(late.includes('<p class="tk-oc-due late">Book by ' + tkDayName('2026-10-20T10:00:00Z') + ' — overdue</p>'));
  // booked → Call done / They didn't show, no "Book by", no resend
  const booked = renderOnboardCall(Object.assign({}, onboardCall, { status: 'booked', bookedFor: '2026-10-20T15:00:00Z', bookedBy: 'calendar' }), row);
  assert.ok(booked.includes('The call is on <b>' + tkDateTime('2026-10-20T15:00:00Z') + '</b> — they booked it on your calendar'));
  assert.ok(booked.includes('&quot;markHeld&quot;)">Call done</button>') && booked.includes("&quot;markNoShow&quot;)\">They didn't show</button>"));
  assert.ok(!booked.includes('Book by') && !booked.includes('Send the first email again') && booked.includes('Call moved? Pick the new date and time'));
  // held → quiet: no buttons, the link to the messages stays
  const held = renderOnboardCall(Object.assign({}, onboardCall, { status: 'held', bookedFor: '2026-10-20T15:00:00Z', heldAt: '2026-10-20T15:40:00Z' }), row);
  assert.ok(held.includes('The call was on') && !held.includes('Mark call booked') && !held.includes('Update the call') && held.includes('See the messages'));
  // stopped → no Stop reminders; no booking link → plain words; unsafe link → no href; hostile values escaped
  const stopped = renderOnboardCall(Object.assign({}, onboardCall, { status: 'stopped', stopped: true, bookingUrl: null }), row);
  assert.ok(stopped.includes('Reminders are stopped.') && !stopped.includes('Stop the reminder emails') && stopped.includes('No booking link: the email asks them to reply with times that suit them.'));
  const evil = renderOnboardCall(Object.assign({}, onboardCall, { label: '<img src=x onerror=alert(1)>', fromInbox: '<b>x</b>', bookingUrl: 'javascript:alert(2)', steps: [{ key: 'sent', label: '<i>x</i>', done: true, at: 'nope' }], thread: [{ dir: 'in', at: null, subject: '<u>s</u>', text: '<a href="javascript:alert(3)">x</a>', kind: 'reply' }] }), Object.assign({}, row, { simple: Object.assign({}, row.simple, { person: '<b>Eve</b> X' }) }));
  assert.ok(!/<img src=x|<b>x<\/b>|<i>x<\/i>|<u>s<\/u>|<a href="javascript|<b>Eve/.test(evil) && !evil.includes('href="javascript'));
  assert.ok(evil.includes('&lt;img src=x onerror=alert(1)&gt;') && evil.includes('Your emails with &lt;b&gt;Eve&lt;/b&gt; are under Messages.'));
  assert.equal(renderOnboardCall(null, row), '');
});

test('onboarding call: every button posts the contract body, toasts plain words and redraws the card from the answer; an older system without `conversation` takes the Messages reply through the call\'s own reply', async () => {
  asOwner(); trialsForget(); asOwner(); trialsIngestHub(simpleHub);
  const oc = JSON.parse(JSON.stringify(onboardCall));
  let reply = null; const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push([init.method, u.pathname, body]);
    if (u.pathname === '/api/mc/clients/ecreek-it/onboard-call') {
      if (reply) return { ok: reply.status < 400, status: reply.status, text: async () => JSON.stringify(reply.body) };
      if (body.action === 'reply') oc.thread.push({ id: 'm4', dir: 'out', at: '2026-10-17T12:00:00Z', text: body.text, kind: 'owner_reply' });
      if (body.action === 'markBooked') Object.assign(oc, { status: 'booked', bookedFor: body.when, bookedBy: 'owner', label: 'Call booked' });
      if (body.action === 'markHeld') Object.assign(oc, { status: 'held', label: 'Call done' });
      return ok({ ok: true, onboardCall: oc })();
    }
    if (u.pathname === '/api/mc/hub/ecreek-it') return ok(Object.assign({}, ecreekDetail, { onboardCall: oc }))();
    if (u.pathname === '/api/mc/hub') return ok(simpleHub)();
    return ok({ ok: true, checked: 1, newReplies: 0, booked: 0, remindersSent: 0 })();
  };
  const posts = () => calls.filter((c) => c[1].endsWith('/onboard-call'));
  const lastBody = () => posts().pop()[2];
  let asked = null; globalThis.confirm = (q) => { asked = q; return true; };
  try {
    tk.detail['ecreek-it'] = JSON.parse(JSON.stringify(ecreekDetail)); tk.detailAt['ecreek-it'] = Date.now();
    openTrial('ecreek-it'); await new Promise((r) => setTimeout(r, 5));
    assert.equal(currentView, 'trial'); assert.ok(el('content').innerHTML.includes('id="tkOcHost"'));
    assert.equal(el('ptitle').textContent, 'eCreek IT', 'the top bar says whose trial it is'); assert.equal(el('psub').textContent, '', 'and nothing the page repeats');
    assert.equal(el('backBtn').style.display, 'grid', 'a Back button to the list');
    assert.equal(calls.filter((c) => c[1] === '/api/mc/onboard-calls/check').length, 1, 'opening a trial asks for the check once');
    // the reply box under Messages (no `conversation` from this older system → the call's own reply, same thread):
    // empty and too long are stopped here; a real one is sent as plain text with its line breaks
    el('tkMsgReply').value = '   '; await msgSend('ecreek-it');
    assert.equal(posts().length, 0); assert.ok(el('toast').innerHTML.includes('Write your message first'));
    el('tkMsgReply').value = 'x'.repeat(2001); await msgSend('ecreek-it');
    assert.equal(posts().length, 0); assert.ok(el('toast').innerHTML.includes('2000 characters at most'));
    el('tkMsgReply').value = '  Tuesday 3 pm is perfect.\nSee you then.  '; await msgSend('ecreek-it');
    assert.deepEqual(posts().pop(), ['POST', '/api/mc/clients/ecreek-it/onboard-call', { action: 'reply', text: 'Tuesday 3 pm is perfect.\nSee you then.' }]);
    assert.ok(el('toast').innerHTML.includes('Sent to Sam Test'));
    assert.ok(el('tkMsgHost').innerHTML.includes('<b>You wrote</b>') && el('tkMsgHost').innerHTML.includes('Tuesday 3 pm is perfect.\nSee you then.'), 'Messages is redrawn from the answer');
    assert.ok(!el('tkOcHost').innerHTML.includes('Tuesday 3 pm is perfect'), 'the call card never shows the emails');
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(calls.some((c) => c[1] === '/api/mc/hub/ecreek-it') && calls.some((c) => c[1] === '/api/mc/hub'), 'the rest of the page and the list refresh behind it');
    // mark booked: needs a date and time; sends it as ISO
    el('tkOcWhen').value = ''; const n = posts().length; await trialOcMarkBooked('ecreek-it');
    assert.equal(posts().length, n); assert.ok(el('toast').innerHTML.includes('Pick the date and time of the call first'));
    el('tkOcWhen').value = '2026-10-20T15:00'; await trialOcMarkBooked('ecreek-it');
    assert.deepEqual(lastBody(), { action: 'markBooked', when: new Date('2026-10-20T15:00').toISOString() });
    assert.ok(el('toast').innerHTML.includes('Call marked as booked for') && el('tkOcHost').innerHTML.includes('Call done</button>'), 'now booked: Call done shows');
    assert.equal(tk.detail['ecreek-it'].onboardCall.status, 'booked');
    // the buttons
    asked = null; await trialOcAction('ecreek-it', 'markHeld');
    assert.deepEqual(lastBody(), { action: 'markHeld' }); assert.equal(asked, null, 'no question for Call done'); assert.ok(el('toast').innerHTML.includes('Marked: the call happened'));
    await trialOcAction('ecreek-it', 'markNoShow');
    assert.deepEqual(lastBody(), { action: 'markNoShow' }); assert.equal(asked, "Mark that Sam Test didn't show up for the call?"); assert.ok(el('toast').innerHTML.includes("Marked: they didn't show up"));
    await trialOcAction('ecreek-it', 'resend');
    assert.deepEqual(lastBody(), { action: 'resend' }); assert.equal(asked, 'Send Sam Test the acceptance email again?'); assert.ok(el('toast').innerHTML.includes('The acceptance email was sent again'));
    await trialOcAction('ecreek-it', 'stopReminders');
    assert.deepEqual(lastBody(), { action: 'stopReminders' }); assert.equal(asked, 'Stop the reminder emails to Sam Test?'); assert.ok(el('toast').innerHTML.includes('Reminders stopped'));
    globalThis.confirm = () => false; const m = posts().length; await trialOcAction('ecreek-it', 'resend'); assert.equal(posts().length, m, 'cancel sends nothing');
    globalThis.confirm = () => true; await trialOcAction('ecreek-it', 'somethingElse'); assert.equal(posts().length, m, 'unknown actions are never posted');
    // the machine says no: plain toast, nothing is redrawn, the draft stays
    reply = { status: 400, body: { ok: false, error: 'The inbox is not set up yet' } };
    el('tkMsgHost').innerHTML = 'UNCHANGED'; el('tkMsgReply').value = 'Still here';
    await msgSend('ecreek-it');
    assert.ok(el('toast').innerHTML.includes('Not sent: The inbox is not set up yet') && el('tkMsgHost').innerHTML === 'UNCHANGED' && el('tkMsgReply').value === 'Still here');
    el('tkOcHost').innerHTML = 'UNCHANGED'; await trialOcAction('ecreek-it', 'markHeld');
    assert.ok(el('toast').innerHTML.includes('That did not work: The inbox is not set up yet') && el('tkOcHost').innerHTML === 'UNCHANGED', 'a refused button leaves the card alone');
  } finally { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; globalThis.confirm = () => true; trialsStopTimer(); await new Promise((r) => setTimeout(r, 5)); }
});

test('the onboarding-call check: fire-and-forget on opening the list or a trial, never on the 60-second refresh; new replies refresh the screen; errors are ignored', async () => {
  asOwner(); trialsForget(); asOwner();
  const calls = []; let check = { ok: true, checked: 1, newReplies: 1, booked: 0, remindersSent: 0 };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); calls.push([init.method, u.pathname, init.body]);
    if (u.pathname === '/api/mc/onboard-calls/check') { if (check === 'throw') throw new TypeError('Failed to fetch'); return ok(check)(); }
    return ok(simpleHub)();
  };
  try {
    render('trials'); await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(calls.filter((c) => c[1] === '/api/mc/onboard-calls/check'), [['POST', '/api/mc/onboard-calls/check', '{}']]);
    assert.equal(calls.filter((c) => c[1] === '/api/mc/hub').length, 2, 'a new reply came in → the list is fetched again');
    calls.length = 0; await trialsTick();
    assert.ok(calls.length > 0 && !calls.some((c) => c[1].includes('onboard-calls')), 'the auto-refresh never asks for the check');
    calls.length = 0; check = { ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0, skipped: 'too soon' }; tk.hubAt = 0;
    render('trials'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.filter((c) => c[1] === '/api/mc/hub').length, 1, 'nothing new → no extra fetch');
    check = 'throw'; const before = el('toast').innerHTML;
    render('trials'); await new Promise((r) => setTimeout(r, 10));
    assert.equal(el('toast').innerHTML, before, 'a failed check says nothing'); assert.ok(el('tkHost').innerHTML.includes('eCreek IT'));
  } finally { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; trialsStopTimer(); }
});

/* ───────────── trial detail: Overview + tabs ───────────── */
test('Overview (behind the scenes): the 13-part strip, four growth numbers with sparklines; the to-do is the big button at the top', () => {
  const g14 = tkSliceGrowth(makeGrowth(45), 14);
  const html = renderTrialDetail(detail, 'overview', { now: NOW, spark: { g: g14, state: null } });
  assert.ok(html.includes('Sending — Day 12 of 30'));
  const iTodo = html.indexOf('Decide the dispute on the call'), iBehind = html.indexOf('id="tkBehind"'), iSys = html.indexOf('<h3>Parts</h3>'), iGrow = html.indexOf('<h3>Growth</h3>');
  assert.ok(iTodo > 0 && iTodo < iBehind && iBehind < iSys && iSys < iGrow, 'order: the to-do at the top, then behind the scenes: parts, growth');
  assert.ok(html.includes('>Decide the dispute</button>') && html.includes('When you have a minute: decide the dispute on the call with bob@example.com.'), 'not urgent: "when you have a minute"');
  assert.equal(count(html, /class="tk-strip-item /g), 13, '13 systems in the strip');
  const labels = ['Intake', 'Market count', 'Purchase', 'Setup check', 'Warm-up', 'Lead list', 'Copy', 'Canary test', 'Sending', 'Replies', 'Calls', 'Reports', 'Closing'];
  let last = -1; for (const l of labels) { const i = html.indexOf('<b>' + l + '</b>', iSys); assert.ok(i > last, 'strip order ' + l); last = i; }
  assert.ok(html.includes('1 blocked') && html.includes('1 waiting'), 'strip summary in words');
  assert.ok(html.includes('>Parts</button>') && !html.includes('>Systems</button>'), 'the tab is "Parts"');
  for (const k of ['Emails sent', 'Replies', 'Calls booked', 'Warm-up inbox rate']) assert.ok(html.includes('<small>' + k + '</small>'), 'key number ' + k);
  assert.ok(html.includes('>230<') && html.includes('4 positive') && html.includes('1 qualified') && html.includes('>91%<'));
  assert.ok(count(html, /class="tk-spark"/g) >= 4, 'a sparkline per key number');
  assert.ok(html.includes('in the last 7 days'));
  assert.ok(!html.includes('<h4>Emails sent per day</h4>'), 'the big charts live in the Growth tab');
  assert.ok(renderTrialDetail(detail, 'overview', { spark: { g: null, state: 'loading' } }).includes('Loading the last 14 days…'));
  assert.ok(renderTrialDetail({ row: bright }, 'overview', { spark: { g: null, state: 'pre' } }).includes('Starts once warm-up begins'));
  assert.ok(renderTrialDetail(detail, 'numbers', {}).includes('tk-strip'), 'old "numbers" tab name opens the Overview');
});

test('Growth tab: sending, warm-up, each inbox and placement charts, with a range selector', () => {
  const g = makeGrowth(45);
  const html = renderGrowthTab(detail, { g, days: 45, at: Date.now() });
  for (const n of [7, 30, 45, 90]) assert.ok(html.includes(`trialsGrowthRange(${n})`), 'range ' + n);
  assert.ok(html.includes('class="active" onclick="trialsGrowthRange(45)"'), '45 days selected');
  for (const s of ['Emails sent per day', 'Warm-up emails per day', 'Inbox rate, rolling 7 days', 'Seed test — share that landed in the inbox', 'Spam test — SpamAssassin points (lower is better)', 'Spam test — mail-tester score (out of 10, higher is better)']) assert.ok(html.includes(s), s);
  assert.ok(html.includes('Landed in the inbox') && html.includes('Landed in spam'), 'warm-up legend');
  assert.ok(html.includes('Ready · 90%') && html.includes('Low · 80%') && html.includes('Needed for Day 1 · 85%'));
  assert.equal(count(html, /class="card tk-mini-chart"/g), 2, 'one small chart per inbox');
  assert.ok(html.includes('Cap today <b>12 a day</b>') && html.includes('Cap today <b>8 a day</b>'));
  assert.ok(html.includes('All-time counters') && html.includes('Pace checks'));
  const none = { days: g.days, email: {}, warmup: {}, inboxes: [], placement: [] };
  const empty = renderGrowthTab({ row: bright }, { g: none, days: 45 });
  assert.ok(empty.includes('No sending yet — starts on Day 1') && empty.includes('No warm-up yet') && empty.includes('No inboxes yet') && empty.includes('No placement tests yet'));
  assert.ok(renderGrowthTab(detail, { g: null, days: 30, loading: true }).includes('Loading the growth history'));
  const err = renderGrowthTab(detail, { g: null, days: 30, error: 'The machine has no such endpoint yet (404)' });
  assert.ok(err.includes("Couldn't load the growth history") && err.includes('404') && err.includes('Try again'));
  assert.ok(renderGrowthTab(detail, { g, days: 90, loading: true }).includes('tk-growth tk-dim'), 'refetch keeps the old frame, dimmed');
});

test('tabs: systems, inboxes, calls, replies, copy, coming up, timeline, actions all render their key strings', () => {
  const tabs = {
    systems: ['inbox ann@acme-team.com 92%', 'tk-st blocked', 'tk-st working', 'tk-st off', 'Market count'],
    inboxes: ['ann@acme-team.com', 'inbox rate under 80%', 'Add inbox', 'checked'],
    calls: ['bob@example.com', 'Uphold', 'Overturn', 'wrong fit'],
    replies: ['interested · 4', 'Sure, tell me more about the pricing', 'Newest replies'],
    copy: ['Edit the email wording', 'Send approval link', 'Find more leads now', 'both'],
    comingup: ['Friday update', 'Day 29 report', 'Answer Ann about the calendar', 'Add a note', 'friday:2026-10-10', 'counters.held missing'],
    timeline: ['Dispute opened', 'Scorekeeper', 'd0 to bob@example.com'],
    actions: ['Pause sending', 'Clear legal hold', 'Run this task now', 'Automatic tasks', 'IMAP timeout', 'Mark paid', 'Log time', 'Override market count', 'Move to another step…'],
  };
  for (const [tab, needles] of Object.entries(tabs)) { const h = renderTab(detail, tab); for (const n of needles) assert.ok(h.includes(n), `tab ${tab} contains "${n}"`); }
  const tl = renderTab(detail, 'timeline'); assert.ok(tl.indexOf('Sent') < tl.indexOf('Dispute opened'), 'newest event first');
  assert.ok(!/dispute_opened|Run a job|Dispatch Lead Finder|Move to state/.test(renderTab(detail, 'timeline') + renderTab(detail, 'actions') + renderTab(detail, 'copy')), 'no system names or jargon in the tab words');
  assert.ok(renderTab(Object.assign({}, detail, { row: Object.assign({}, acme, { state: 'paused' }) }), 'actions').includes('Resume sending'));
  for (const old of ['setup', 'promises', 'upcoming', 'reports']) assert.ok(renderTab(detail, old).length > 100, 'old tab name ' + old + ' still lands somewhere');
  assert.ok(!renderTab(detail, 'actions').includes('Client links'), 'the machine sends links: {} — no empty section');
  assert.ok(renderLinks({ onboarding: 'https://machine.test/c/tok1/onboard' }).includes('https://machine.test/c/tok1/onboard'), 'links still render when present');
  for (const tab of ['overview', 'growth', 'systems', 'leads', 'deliverability', 'inboxes', 'calls', 'replies', 'copy', 'comingup', 'timeline', 'actions']) assert.doesNotThrow(() => renderTab({ row: bright }, tab, {}), 'sparse detail: ' + tab);
});

test('Leads tab: ready to send (not yet emailed), last graded, grade bar, checks, reasons, sources, best leads; null → empty state', () => {
  const h = renderLeadsTab(detail);
  assert.ok(h.includes('<small>Ready to send</small><b>212</b>') && h.includes('have not been emailed yet'), 'sendableUnsent is the headline');
  assert.ok(h.includes('Good leads in total</small><b>350</b>') && h.includes('>812<'));
  assert.ok(h.includes('Last graded'), 'builtAt shown');
  for (const s of ['Grade A · 140', 'Grade B · 210', 'Grade C · 90', 'Rejected · 372']) assert.ok(h.includes(s), s);
  assert.ok(h.includes('tk-gradebar') && count(h, /flex:\d+;background:var\(--(g-[abc]|c-none)\)/g) === 4, 'four grade segments');
  assert.ok(h.includes('Valid · 330') && h.includes('Catch-all · 25') && h.includes('Checks left today: <b>45</b>'));
  assert.ok(h.includes('Role address (info@)') && h.includes('google-places') && h.includes('>600<'));
  assert.ok(h.includes('Jim Reyes') && h.includes('Riverton Bistro') && h.includes('class="pill green">A<'));
  assert.ok(h.includes('in sequence · 120'), 'the lead list by status stays');
  const none = renderLeadsTab(Object.assign({}, detail, { leadQuality: null }));
  assert.ok(none.includes('No leads yet — grading starts when the Lead Finder brings in the first list') && none.includes('unsent · 380'));
  const old = renderLeadsTab(Object.assign({}, detail, { leadQuality: Object.assign({}, detail.leadQuality, { sendableUnsent: undefined, builtAt: undefined }) }));
  assert.ok(old.includes('<small>Ready to send</small><b>350</b>') && !old.includes('Last graded'), 'older machine: falls back to sendable');
});

test('Deliverability tab: bounce (sent, measured, half speed), blacklists (couldn\'t check, warnings), spam-test Day-1 check, warm-up circle extras, DNS', () => {
  const h = renderDeliverabilityTab(detail);
  assert.ok(h.includes('1.2%') && h.includes('Healthy') && h.includes('(1,240 emails sent)') && h.includes('measured'));
  assert.equal(count(h, /class="tk-meter-mark"/g), 2);
  assert.ok(h.includes('class="pill green">Clean<') && h.includes('Clean on 5 of 7 lists'));
  assert.ok(h.includes("Couldn't check: dnsbl.sorbs.net, b.barracudacentral.org"), 'unknown verdicts are "couldn\'t check", not clean');
  assert.ok(h.includes('Warning, nothing paused: bl.spamcop.net: 192.0.2.10 (A record)'));
  for (const s of ['Trial inboxes', 'Aviance inboxes', 'Provider families', 'Pairs today', 'Outside warm-up network', 'Connected', 'adds 10 warm-up emails a day']) assert.ok(h.includes(s), s);
  assert.ok(h.includes('Day 1 check not passed yet'), 'hello@ latest spam test is 3.2 points');
  assert.ok(h.includes('1.4 SpamAssassin points — passes') && h.includes('3.2 SpamAssassin points — too high for Day 1'));
  assert.ok(h.includes('DKIM Validator') && h.includes('9.1/10 — passes') && h.includes('https://www.mail-tester.com/test-abc123'));
  assert.ok(h.includes("Couldn't finish: dkimvalidator did not answer in 20 minutes"));
  assert.ok(!h.includes('javascript:'), 'unsafe report link dropped');
  assert.ok(h.includes('Domain setup') && !h.includes('DNS</h3>') && h.includes('Re-run setup check'));
  const passing = JSON.parse(JSON.stringify(detail.deliverability)); passing.placement[1].spamAssassin = 1.0; passing.placement[1].pass = true;
  assert.ok(renderDeliverabilityTab(Object.assign({}, detail, { deliverability: passing })).includes('Day 1 check passes'));
  assert.ok(renderBounceMeter({ rate7d: 0.021, pauseAt: 0.015, stopAt: 0.02 }).includes('Over the stop line'));
  const slow = renderBounceMeter({ rate7d: 0.016, pauseAt: 0.015, stopAt: 0.02, halved: true });
  assert.ok(slow.includes('Over the pause line') && slow.includes('Half speed') && slow.includes('daily cap was halved'));
  assert.ok(renderBounceMeter({ rate7d: null, pauseAt: 0.015, stopAt: 0.02 }).includes('No bounce rate yet'));
  assert.ok(renderBlacklists({ status: 'unknown', listed: [], warnings: [], clean: 0, unknown: ['a', 'b'], lists: ['a', 'b'] }).includes("Couldn't check"));
  assert.ok(renderBlacklists({ status: 'listed', listed: ['dbl.spamhaus.org'], warnings: [], clean: 6, unknown: [], lists: [] }).includes('Listed on:</b> dbl.spamhaus.org'));
  const none = renderDeliverabilityTab(Object.assign({}, detail, { deliverability: null }));
  assert.ok(none.includes('show here once there are some') && none.includes('Domain setup'));
});

/* ───────────── application review ───────────── */
test('application pending: open on the page (above Behind the scenes) with the fit check, the research, every answer and the two buttons; the big button at the top scrolls to it', () => {
  const html = renderTrialDetail(fernDetail, 'overview', { now: NOW });
  const iApp = html.indexOf('id="tkSec-application"'), iBehind = html.indexOf('id="tkBehind"'), iTabs = html.indexOf('id="tkTabBar"');
  assert.ok(iApp > 0 && iApp < iBehind && iBehind < iTabs, 'application sits above "Behind the scenes" (where the tabs are)');
  assert.ok(!html.includes('What you need to do') && !html.includes('Also on your list'), 'the review to-do is not repeated');
  assert.ok(html.includes('onclick="tkGoTo(&quot;application&quot;)">Read the application and say yes or no</button>'));
  assert.ok(html.includes('<h3>Their application</h3>') && html.includes('Looks like a fit — 3 checks unknown') && !html.includes('Waiting for your review'), 'the top already says it waits for him: no second status');
  for (const l of fernApplication.fit.lines) assert.ok(html.includes(esc(l.label)), 'fit line ' + l.rule);
  for (const x of fernApplication.answers) assert.ok(html.includes('<dt>' + esc(x.q) + '</dt>'), 'question ' + x.q);
  assert.ok(html.includes('>Say yes and email them</button>') && html.includes('>Say no…</button>'));
  assert.ok(!html.includes("trialsSetTab(&quot;application&quot;)"), 'no Application tab');
  const iResearch = html.indexOf('What we found'), iAnswers = html.indexOf('Their answers');
  assert.ok(iResearch > 0 && iResearch < iAnswers, 'research above the answers');
});

test('application research: summary, about the company, Google rating + Maps link, market, flags, Research again; pending and failed', () => {
  const h = renderResearch(research, 'fern-it');
  assert.ok(h.includes(esc(research.summary)));
  assert.ok(h.includes('About the company') && h.includes('Managed IT, Cybersecurity, HIPAA compliance, Cloud backup') && h.includes('Austin, TX · San Antonio, TX'));
  assert.ok(h.includes('4.8★') && h.includes('57 reviews') && h.includes('href="https://maps.google.com/?cid=123456"') && h.includes('Google Maps ↗'));
  assert.ok(h.includes('12 people on the team page · Since 2011') && h.includes('(512) 555-0142'));
  assert.ok(h.includes('href="https://www.linkedin.com/company/fernit"') && !h.includes('javascript:'), 'socials: safe links only');
  assert.ok(h.includes('About <b>4,820</b> matching companies') && h.includes('Google Places'));
  assert.ok(h.includes('class="pill amber">Check<') && h.includes('could be an agency') && h.includes('class="pill grey">Note<'));
  assert.ok(h.includes('trialResearchAgain(&quot;fern-it&quot;)') && h.includes('Research again'));
  assert.ok(renderResearch({ status: 'pending' }, 'x').includes('Researching their website…'));
  const f = renderResearch({ status: 'failed', error: 'Site timed out' }, 'x'); assert.ok(f.includes("Couldn't research their website: Site timed out") && f.includes('Research again'));
  const missing = renderResearch(null, 'x'); assert.ok(missing.includes('No research yet') && missing.includes('Research again'));
  assert.equal(renderResearch(null), '');
  assert.ok(renderResearch({ status: 'done', website: { url: 'https://x.com' }, business: null }, 'x').includes('Not found on Google Maps'));
});

test('Research again posts rerunResearch and says what happened', async () => {
  asOwner(); trialsIngestHub(fullHub); tk.detail['fern-it'] = fernDetail; tk.detailAt['fern-it'] = Date.now(); currentTrialId = 'fern-it';
  const calls = [];
  const answer = (status) => async (url, init) => { calls.push({ url, init }); if (url.endsWith('/intake')) return ok({ ok: true, result: { status } })(); return ok(url.includes('/hub/') ? fernDetail : fullHub)(); };
  globalThis.fetch = answer('pending'); await trialResearchAgain('fern-it');
  assert.ok(calls[0].url.endsWith('/api/mc/clients/fern-it/intake')); assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'rerunResearch' });
  assert.ok(el('toast').innerHTML.includes('Research started'));
  globalThis.fetch = answer('done'); await trialResearchAgain('fern-it'); assert.ok(el('toast').innerHTML.includes('Research finished'));
  globalThis.fetch = answer('failed'); await trialResearchAgain('fern-it'); assert.ok(el('toast').innerHTML.includes('could not finish'));
});

test('application decided: one folded line on the trial page ("Their application · You said yes"), no buttons, the decision in words', () => {
  const html = renderTrialDetail(detail, 'overview', { now: NOW });
  const box = between(html, '<details class="tk-appbox" id="tkSec-application">', '<details class="tk-behind"');
  assert.ok(box.includes('<span class="tk-appbox-title">Their application</span><span class="pill green">You said yes</span>'));
  assert.ok(box.includes('You said yes') && box.includes('They were emailed.') && !box.includes('Say no…') && !box.includes('Say yes and email them'));
  assert.ok(!html.includes("trialsSetTab(&quot;application&quot;)"), 'no Application tab any more');
  assert.ok(renderTab(detail, 'application').includes('<h3>Their application</h3>'), 'an old link to the tab still shows it');
});

test('board marker + the review to-do opens the trial scrolled to the Application section', () => {
  const html = renderBoard(fullHub, { now: NOW });
  assert.ok(html.includes('class="tk-card review"') && count(html, /New application/g) === 1);
  asOwner(); trialsIngestHub(fullHub);
  tk.detail['fern-it'] = fernDetail; tk.detailAt['fern-it'] = Date.now();
  let scrolled = 0; el('tkSec-application').scrollIntoView = () => { scrolled++; };
  trialsTodoAction('review:fern-it');
  assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'fern-it');
  assert.ok(el('content').innerHTML.includes('id="tkSec-application"'));
  assert.equal(scrolled, 1); assert.equal(tk.scrollTo, null);
});

test('approve + decline post the contract bodies and toast the outcome in plain words', async () => {
  asOwner(); trialsIngestHub(fullHub);
  tk.detail['fern-it'] = fernDetail; tk.detailAt['fern-it'] = Date.now(); currentTrialId = 'fern-it';
  let asked = ''; globalThis.confirm = (q) => { asked = q; return true; };
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); if (url.endsWith('/intake')) return { ok: true, status: 200, text: async () => JSON.stringify(JSON.parse(init.body).action === 'approveApplication' ? { ok: true, outcome: 'queued', position: 2 } : { ok: true, outcome: 'declined' }) }; return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('/hub/') ? fernDetail : fullHub) }; };
  await trialApproveApplication('fern-it');
  assert.equal(asked, 'Say yes to Fern IT? They get an email asking them to book the onboarding call.');
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'approveApplication' });
  assert.ok(el('toast').innerHTML.includes('Done. They are on the waiting list — number 2'));
  const failing = JSON.parse(JSON.stringify(fernDetail)); failing.application.fit.lines[1].status = 'fail';
  tk.detail['fern-it'] = failing; openDeclineApplication('fern-it');
  assert.ok(el('modal').innerHTML.includes('>Customer worth ≥ $2,000 in year one.</textarea>') && el('modal').innerHTML.includes('They get this reason by email.') && el('modal').innerHTML.includes('>Say no and email them</button>'));
  calls.length = 0; el('tkDeclineReason').value = '  ';
  await submitDeclineApplication('fern-it'); assert.equal(calls.length, 0); assert.ok(el('tkDeclineErr').innerHTML.includes('Write the reason first'));
  el('modalWrap').classList.add('open'); el('tkDeclineReason').value = 'We only run trials for teams of 5–50 people.';
  await submitDeclineApplication('fern-it');
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'declineApplication', reason: 'We only run trials for teams of 5–50 people.' });
  assert.ok(el('toast').innerHTML.includes('Done. They got your no by email') && !el('modalWrap').classList.contains('open'));
  tk.detail['fern-it'] = fernDetail;
});

/* ───────────── Buy & paste v2 ───────────── */
test('Buy & paste: domain comparison with "Buy at" links, promo chips, live vs price-list prices, inbox order, totals', () => {
  const h = renderPurchase(brightPurchase, 'bright-dental', { at: Date.now() });
  assert.ok(h.includes('Pick a domain') && count(h, /class="tk-offer/g) === 3);
  assert.ok(h.includes('Top pick') && h.includes('<b>$9.73</b> at Porkbun') && h.includes('renews $11.08'));
  assert.ok(h.includes('href="https://porkbun.com/checkout/search?q=getbrightdental.com"') && h.includes('Buy at Porkbun ↗'), 'best.url → Buy at');
  assert.ok(h.includes('Buy at Spaceship ↗') && h.includes('Code SPACE10 · $6.98 first year'), 'best.promo chip');
  assert.ok(h.includes('Code NEWCOM598 · $5.98 first year · new customers'), 'per-price promo object');
  assert.ok(!h.includes('[object Object]'), 'promo objects never print as [object Object]');
  assert.ok(h.includes('$10.44 / $10.44') && h.includes('Live price') && h.includes('Price list'));
  assert.ok(h.includes('Availability not confirmed'), 'available: null');
  assert.ok(!h.includes('javascript:'), 'an unsafe best.url is never used');
  const coRow = h.slice(h.indexOf('data-domain="usebrightdental.co"'));
  assert.ok(coRow.includes('href="https://porkbun.com" target="_blank" rel="noopener noreferrer">Buy at Porkbun'), "unsafe best.url → falls back to the registrar's home page");
  assert.equal(count(h, /Buy at /g), 3);
  assert.equal(count(h, /trialsUseDomain\(/g), 3);
  assert.ok(h.includes('Promo codes are shown, never counted'));
  assert.ok(h.includes('Registrars compared (5)') && h.includes('At-cost renewals'));
  assert.ok(h.includes('CheapInboxes') && h.includes('$3.50 per inbox × 2 = <b>$7.00 a month</b>') && count(h, /<li><label><input type="checkbox"/g) === 5);
  assert.ok(h.includes('<b>$9.73</b> first year') && h.includes('<b class="tk-big">$16.73</b> for the first month'));
  const unknownTotal = renderPurchase(Object.assign({}, brightPurchase, { shopping: Object.assign({}, shoppingV2, { totals: { domainFirstYear: 9.73, inboxesMonthly: null, firstMonth: null } }) }), 'bright-dental');
  assert.ok(unknownTotal.includes('first month not known yet'));
  const legacy = renderPurchase({ client: brightPurchase.client, shopping: { chosenDomain: 'bright-team.com', registrarQuotes: [{ name: 'Porkbun', price: 9.13 }], total: 16.13 }, setup: {}, inboxes: [], encKey: true }, 'bright-dental');
  assert.ok(legacy.includes('Shopping list') && !legacy.includes('Pick a domain'), 'older machines: the v1 list still shows');
  const closed = renderPurchase(Object.assign({}, brightPurchase, { encKey: false }), 'bright-dental');
  assert.ok(closed.includes('id="tkPcForm" disabled') && count(closed, /disabled onclick="trialsUseDomain/g) === 3);
});

test('"Use this domain" fills the paste form and marks the row', () => {
  el('pcDomain').value = ''; el('tkPcForm').disabled = false;
  const rows = [Object.assign(fakeEl(''), { getAttribute: () => 'getbrightdental.com' }), Object.assign(fakeEl(''), { getAttribute: () => 'brightdentalhq.com' })];
  el('pcDomain').value = 'getbrightdental.com';
  const emails = [Object.assign(fakeEl(''), { value: 'raj@getbrightdental.com' }), Object.assign(fakeEl(''), { value: 'me@elsewhere.com' })];
  const saved = document.querySelectorAll; document.querySelectorAll = (sel) => (sel === '.tk-offer' ? rows : sel === '#pcRows .pc-email' ? emails : []);
  trialsUseDomain('brightdentalhq.com');
  assert.equal(emails[0].value, 'raj@brightdentalhq.com', 'sender address follows the new domain');
  assert.equal(emails[1].value, 'me@elsewhere.com', 'an address the owner typed is left alone');
  document.querySelectorAll = saved;
  assert.equal(el('pcDomain').value, 'brightdentalhq.com');
  assert.ok(rows[1].classList.contains('chosen') && !rows[0].classList.contains('chosen'));
  assert.ok(el('toast').innerHTML.includes('brightdentalhq.com is filled in'));
  el('tkPcForm').disabled = true; trialsUseDomain('getbrightdental.com');
  assert.equal(el('pcDomain').value, 'brightdentalhq.com', 'closed form is left alone'); el('tkPcForm').disabled = false;
});

/* ───────────── fetch discipline: growth only on request ───────────── */
test('growth is fetched when the owner opens it (Behind the scenes), never by the 60-second refresh or the Trials list; board sparklines skip pre-warm-up clients', async () => {
  asOwner(); trialsIngestHub(fullHub); trialsForget(); asOwner(); trialsIngestHub(fullHub);
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); const u = new URL(url); if (u.pathname.endsWith('/growth')) return ok(makeGrowth(Number(u.searchParams.get('days'))))(); if (u.pathname === '/api/mc/hub') return ok(fullHub)(); return ok(detail)(); };
  tk.detail['acme-plumbing'] = detail; tk.detailAt['acme-plumbing'] = Date.now();
  openTrial('acme-plumbing');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!urls.some((u) => u.includes('/growth')), 'opening a trial: "Behind the scenes" is closed, so no growth history');
  trialsBehindToggle(true); await new Promise((r) => setTimeout(r, 0));
  assert.ok(urls.some((u) => u.endsWith('/api/mc/hub/acme-plumbing/growth?days=14')), 'opening Behind the scenes: the Overview asks for 14 days');
  urls.length = 0; delete tk.spark['acme-plumbing']; trialsBehindToggle(true); await new Promise((r) => setTimeout(r, 0));
  assert.ok(!urls.some((u) => u.includes('/growth')), 'a repaint re-inserting <details open> fires "toggle" again — that fetches nothing');
  trialsSetTab('growth'); await new Promise((r) => setTimeout(r, 0));
  assert.ok(urls.some((u) => u.endsWith('/growth?days=45')), 'Growth tab asks for 45 days');
  assert.ok(tk.growth['acme-plumbing'] && tk.growth['acme-plumbing'].days === 45);
  urls.length = 0; await trialsTick();
  assert.ok(urls.length > 0 && !urls.some((u) => u.includes('/growth')), 'auto-refresh: no growth call');
  trialsGrowthRange(7); await new Promise((r) => setTimeout(r, 0));
  assert.ok(urls.some((u) => u.endsWith('/growth?days=7')), 'range change fetches that range');
  urls.length = 0; render('trials'); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  assert.ok(!urls.some((u) => u.includes('/growth')), 'the Trials list never asks for growth history');
  urls.length = 0; render('trialsBoard'); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  const sparkIds = urls.filter((u) => u.endsWith('/growth?days=14')).map((u) => u.split('/api/mc/hub/')[1].split('/')[0]);
  assert.ok(!sparkIds.includes('fern-it') && !sparkIds.includes('bright-dental'), 'no sparkline fetch before warm-up');
  assert.ok(!sparkIds.includes('acme-plumbing'), 'acme already cached from the Growth tab');
  assert.ok(sparkIds.includes('cobalt-hvac') && sparkIds.includes('aviance'));
  urls.length = 0; render('trialsBoard'); await new Promise((r) => setTimeout(r, 0));
  assert.ok(!urls.some((u) => u.includes('/growth')), 'cached for 6 hours — reopening the board costs nothing');
  assert.ok(JSON.parse(localStorage.getItem(TK_SPARK_KEY))['cobalt-hvac'], 'kept across reloads');
});

test('machine unreachable on first load: one clear card; a failed refresh keeps the cached board', async () => {
  tk.hub = null; tk.hubErr = null;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const r = await loadHub(true);
  assert.equal(r.ok, false);
  assert.ok(trialsHostHTML('trials').includes("We can't reach the system right now") && trialsHostHTML('trials').includes("Couldn't reach the system. Check your internet, then try again."));
  trialsIngestHub(fullHub);
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'Unauthorized' }) });
  await loadHub(true);
  const h = trialsHostHTML('trials'); assert.ok(h.includes("Couldn't refresh — showing what we had") && h.includes('Acme Plumbing'));
  globalThis.fetch = ok(fullHub); await loadHub(true);
});

test('machineFetch: bearer token, JSON bodies, 401/503/non-JSON/ok:false handling', async () => {
  const calls = [];
  const respond = (status, body, isJson = true) => async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, text: async () => (isJson ? JSON.stringify(body) : body) }; };
  globalThis.fetch = respond(200, { ok: true, clientId: 'x' });
  let r = await machineFetch('/api/mc/clients/new', { body: { companyName: 'Acme' } });
  assert.equal(r.ok, true); assert.equal(calls[0].init.headers.authorization, 'Bearer test-token'); assert.equal(calls[0].init.headers['content-type'], 'application/json');
  globalThis.fetch = respond(401, { error: 'Unauthorized' }); r = await machineFetch('/api/mc/hub'); assert.equal(r.status, 401); assert.equal(r.error, 'Unauthorized');
  globalThis.fetch = respond(503, { error: 'ENC_KEY missing' }); r = await machineFetch('/api/mc/hub'); assert.equal(r.error, 'ENC_KEY missing');
  globalThis.fetch = respond(200, '<html>not json</html>', false); r = await machineFetch('/api/mc/hub'); assert.ok(r.error.startsWith("The system sent an answer we couldn't read.") && r.error.includes('not JSON'));
  globalThis.fetch = respond(401, ''); r = await machineFetch('/api/mc/hub'); assert.ok(r.error.startsWith("The system didn't accept your sign-in. Sign out, then sign in again.") && r.error.includes('For your developer'), 'plain words first, the technical bit last');
  globalThis.fetch = respond(400, { ok: false, errors: { companyName: 'Company name is required.' } }); r = await machineFetch('/api/mc/clients/new', { body: {} }); assert.ok(r.error.includes('Company name is required.'));
  supa.session = null; r = await machineFetch('/api/mc/hub'); assert.ok(r.error.includes('not signed in')); supa.session = { access_token: 'test-token' };
});

test('new-client modal posts the contract body, shows 400 {errors}, and opens the new trial', async () => {
  asOwner();
  openNewTrialClient({ companyName: 'Delta Roofing', contactName: 'Sam Ito', contactEmail: 'sam@delta.com', website: 'https://delta.com' });
  assert.ok(el('modal').innerHTML.includes('value="Delta Roofing"'));
  el('ntCompany').value = 'Delta Roofing'; el('ntContact').value = 'Sam Ito'; el('ntEmail').value = 'sam@delta.com'; el('ntWebsite').value = 'https://delta.com'; el('ntOverride').checked = true;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); if (url.endsWith('/clients/new')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, clientId: 'delta-roofing', state: 'onboarding' }) }; return { ok: true, status: 200, text: async () => JSON.stringify(fullHub) }; };
  await submitNewTrialClient();
  assert.deepEqual(JSON.parse(calls[0].init.body), { companyName: 'Delta Roofing', contactName: 'Sam Ito', contactEmail: 'sam@delta.com', website: 'https://delta.com', override: true });
  assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'delta-roofing');
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ ok: false, errors: { contactEmail: 'A valid email address is required.' } }) });
  openNewTrialClient(); el('ntCompany').value = 'X'; el('ntContact').value = 'Y'; el('ntEmail').value = 'z@z.zz'; el('ntWebsite').value = 'https://z.zz';
  await submitNewTrialClient();
  assert.ok(el('ntErr').innerHTML.includes('A valid email address is required.') && el('modalWrap').classList.contains('open'));
  closeModal();
});

/* ───────────── readability + one simple font ───────────── */
const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
const shellCss = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const trialsJs = fs.readFileSync(path.join(root, 'trials.js'), 'utf8');
const pushJs = fs.readFileSync(path.join(root, 'push.js'), 'utf8');
const calendarCss = fs.readFileSync(path.join(root, 'calendar.css'), 'utf8');
const calendarJs = fs.readFileSync(path.join(root, 'calendar.js'), 'utf8');
const messagesJs = fs.readFileSync(path.join(root, 'messages.js'), 'utf8');
const autobuyJs = fs.readFileSync(path.join(root, 'autobuy.js'), 'utf8');
const warmupJs = fs.readFileSync(path.join(root, 'warmup.js'), 'utf8');
const varsIn = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
const rootVars = varsIn(shellCss.match(/:root\{[\s\S]*?\n\}/)[0]);
const darkVars = Object.assign({}, rootVars, varsIn(shellCss.match(/body\.dark\{[^}]*\}/)[0]));
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const allStyle = { 'trials.css': noComments(css), 'calendar.css': noComments(calendarCss), 'index.html <style>': noComments(shellCss), 'index.html markup/script': html.slice(html.indexOf('</style>')), 'trials.js': trialsJs, 'calendar.js': calendarJs, 'messages.js': messagesJs, 'autobuy.js': autobuyJs, 'warmup.js': warmupJs, 'push.js': pushJs };

test('font: one plain system font family, no web fonts, no capitals-only labels, no letter-spacing, weights 400/600', () => {
  assert.equal(rootVars.font, '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|@import|@font-face/i.test(html + css), 'no web font is loaded');
  assert.ok(!/JetBrains|Inter Tight|var\(--mono\)|var\(--display\)/.test(noComments(html) + noComments(css) + noComments(calendarCss) + trialsJs + calendarJs + messagesJs + autobuyJs + warmupJs), 'no second family');
  for (const [name, src] of Object.entries(allStyle)) {
    for (const m of src.matchAll(/font-family:\s*([^;"'}]+)/g)) assert.ok(['var(--font)', 'inherit'].includes(m[1].trim()), `${name}: font-family ${m[1]}`);
    assert.ok(!/text-transform:\s*uppercase/.test(src), `${name}: no capitals-only text`);
    assert.ok(!/letter-spacing/.test(src), `${name}: no letter-spacing`);
    for (const m of src.matchAll(/font-weight:\s*([^;"'}!]+)/g)) assert.ok(['400', '600', 'normal'].includes(m[1].trim()), `${name}: font-weight ${m[1]}`);
  }
  assert.ok(/b,strong,th,h5,summary\{font-weight:600\}/.test(shellCss) && /h1,h2,h3,h4\{font-weight:600\}/.test(shellCss), 'browser-bold elements capped at 600');
});

test('readability: no font size below 13px anywhere (CSS, shell styles, inline styles in JS)', () => {
  const fs_ = Object.entries(rootVars).filter(([k]) => k.startsWith('fs-'));
  assert.ok(fs_.length >= 6);
  for (const [k, v] of fs_) assert.ok(parseFloat(v) >= 13, `--${k} is ${v}`);
  let checked = 0;
  for (const [name, src] of Object.entries(allStyle)) {
    for (const m of src.matchAll(/font-size:\s*([^;"'}]+)/g)) {
      const v = m[1].trim(); checked++;
      if (v === 'inherit') continue;
      const tok = /^var\(--(fs-[\w-]+)\)$/.exec(v);
      if (tok) { assert.ok(parseFloat(rootVars[tok[1]]) >= 13, `${name}: ${v}`); continue; }
      assert.match(v, /^\d+(\.\d+)?px$/, `${name}: font-size must be a --fs-* token or px, got "${v}"`);
      assert.ok(parseFloat(v) >= 13, `${name}: font-size ${v} is below the 13px floor`);
    }
  }
  assert.ok(checked > 150, 'scanned the real rules (' + checked + ')');
});

test('readability: text passes WCAG AA (4.5:1) and chart marks pass 3:1, in light and dark', () => {
  const rgb = (c) => { c = c.replace('#', ''); if (c.length === 3) c = [...c].map((x) => x + x).join(''); return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const text = [['text', 'bg'], ['text', 'surface-2'], ['text', 'surface-3'], ['muted', 'bg'], ['muted', 'surface-2'], ['muted', 'surface-3'], ['muted-2', 'bg'], ['muted-2', 'surface-2'], ['muted-2', 'surface-3'],
    ['green', 'bg'], ['amber', 'bg'], ['red', 'bg'], ['blue', 'bg'], ['green', 'green-bg'], ['amber', 'amber-bg'], ['red', 'red-bg'], ['blue', 'blue-bg'], ['muted', 'blue-bg'],
    ['red', 'urgent-row'], ['muted', 'urgent-row'], ['text', 'urgent-row'], ['red', 'surface-2'], ['green', 'surface-2'], ['text', 'amber-bg'], ['text', 'red-bg'], ['text', 'green-bg'], ['muted', 'amber-bg'], ['muted', 'red-bg'], ['muted', 'green-bg']];
  const marks = ['c1', 'c2', 'c3', 'c-none', 'g-a', 'g-b', 'g-c', 'green', 'amber', 'red'];
  for (const [mode, v] of [['light', rootVars], ['dark', darkVars]]) {
    for (const [fg, bg] of text) { const r = ratio(v[fg], v[bg]); assert.ok(r >= 4.5, `${mode}: --${fg} (${v[fg]}) on --${bg} (${v[bg]}) is ${r.toFixed(2)}:1`); }
    for (const k of marks) { const r = ratio(v[k], v.bg); assert.ok(r >= 3, `${mode}: chart mark --${k} (${v[k]}) on --bg is ${r.toFixed(2)}:1`); }
  }
  for (const cls of ['green', 'amber', 'red', 'blue']) assert.ok(shellCss.includes(`.pill.${cls}{background:var(--${cls}-bg);color:var(--${cls})}`));
});

test('Day-1 limits follow the machine settings (deliverability.gates)', () => {
  assert.equal(tkSpamVerdict({ score: 8.5 }).level, 'pass', 'default mail-tester line is 8');
  tkApplyGates({ deliverability: { gates: { seedPlacement: 0.9, mailTesterMin: 9, spamAssassinMax: 1.5, spamTestRequired: true } } });
  assert.equal(tkSpamVerdict({ score: 8.5 }).level, 'fail', 'machine says 9, so 8.5 is too low');
  assert.equal(tkSpamVerdict({ spamAssassin: 1.8 }).level, 'high', 'machine says 1.5 points or less');
  tkApplyGates({ deliverability: { gates: { seedPlacement: 0.85, mailTesterMin: 8, spamAssassinMax: 2 } } });
  tkApplyGates({ deliverability: null }); // missing gates keep the current lines
  assert.equal(tkSpamVerdict({ score: 8.5 }).level, 'pass');
});

/* ───────────── deep links + phone alerts (push.js) ───────────── */
test('deep links: #trial/{id}, #alerts (Settings › Alerts), #settings and #trials parse; anything else (incl. Supabase auth hashes) does not', () => {
  assert.deepEqual(parseDeepLink('#trial/acme-plumbing'), { view: 'trial', id: 'acme-plumbing' });
  assert.deepEqual(parseDeepLink('/#trial/acme-plumbing'), { view: 'trial', id: 'acme-plumbing' }, 'the push payload url form');
  assert.deepEqual(parseDeepLink('https://aviance.store/#trial/fern-it/'), { view: 'trial', id: 'fern-it' });
  assert.deepEqual(parseDeepLink('#trial/a%2Eb'), { view: 'trial', id: 'a.b' });
  assert.deepEqual(parseDeepLink('#alerts'), { view: 'settings', section: 'alerts' });
  assert.deepEqual(parseDeepLink('/#settings'), { view: 'settings' });
  assert.deepEqual(parseDeepLink('/#trials'), { view: 'trials' });
  for (const bad of ['', '#', '/', '#trial/', '#trial/<script>', '#trial/a b', '#trial/%E0%A4%A', '#trial/x/y', '#access_token=abc&type=recovery', '#type=recovery', '#dashboard', 'trial/acme'])
    assert.equal(parseDeepLink(bad), null, JSON.stringify(bad));
});

test('deep links: signed out → kept until sign-in, then lands there; hashchange and a notification tap also navigate', async () => {
  const replaced = []; history.replaceState = (s, t, u) => replaced.push(u);
  authUser = null; pendingDeepLink = null;
  assert.equal(goDeepLink({ view: 'trial', id: 'acme-plumbing' }), false, 'signed out: nothing happens yet');
  assert.deepEqual(pendingDeepLink, { view: 'trial', id: 'acme-plumbing' });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  supa.session = { access_token: 'test-token' }; supa.user = { id: 'u1', email: 'owner@example.com' };
  supa.profile = { id: 'u1', name: 'Limethsith', approved: true, role: 'admin', email: 'owner@example.com' };
  await routeUser('loginErr');
  assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'acme-plumbing'); assert.equal(pendingDeepLink, null);
  assert.ok(replaced.includes('/'), 'the hash is cleared so the same alert can open it again');
  tk.setOpen = {}; location.hash = '#alerts'; winListeners.hashchange.forEach((f) => f());
  assert.equal(currentView, 'settings', 'hashchange #alerts → Settings'); assert.equal(tk.setOpen.alerts, true, '… with Alerts open');
  assert.ok(el('content').innerHTML.includes('<details class="tk-set" id="tkSet-alerts" open'));
  paOnMessage({ data: { type: 'aviance:open', url: '/#trial/fern-it' } });
  assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'fern-it');
  paOnMessage({ data: { type: 'something-else', url: '/#alerts' } });
  assert.equal(currentView, 'trial', 'other messages are ignored');
  paOnMessage({ data: { type: 'aviance:open', url: 'https://evil.example/' } });
  assert.equal(currentView, 'trials', 'an unknown url falls back to the board');
  location.hash = ''; history.replaceState = () => {};
  trialsStopTimer();
});

test('push: urlBase64ToUint8Array decodes base64url (no padding, - and _) and a real 65-byte P-256 key', async () => {
  assert.deepEqual([...urlBase64ToUint8Array('AQID')], [1, 2, 3]);
  assert.deepEqual([...urlBase64ToUint8Array('-_8')], [251, 255]);
  assert.deepEqual([...urlBase64ToUint8Array('AQ')], [1]);
  const { createECDH } = await import('node:crypto');
  const ecdh = createECDH('prime256v1'); const pub = ecdh.generateKeys();
  const b64url = pub.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = urlBase64ToUint8Array(b64url);
  assert.equal(bytes.length, 65); assert.equal(bytes[0], 4, 'uncompressed point'); assert.deepEqual(Buffer.from(bytes), pub);
});

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
};
const fakeWin = ({ push = true, permission = 'default', standalone = false, secure = true } = {}) => ({
  PushManager: push ? function PushManager() {} : undefined, Notification: { permission }, isSecureContext: secure,
  matchMedia: (q) => ({ matches: standalone && q === '(display-mode: standalone)' }),
});

test('push: device detection → the panel state (not installed on iOS / installed / on / denied / unsupported / no keys)', () => {
  const sw = { serviceWorker: {} };
  let env = paEnv({ ...sw, userAgent: UA.iphone, platform: 'iPhone' }, fakeWin());
  assert.deepEqual([env.ios, env.standalone, env.device, env.browser], [true, false, 'iPhone', 'Safari']);
  assert.equal(paModeFor(env, { checked: true }), 'install', 'iPhone Safari tab: add to Home Screen first');
  env = paEnv({ ...sw, userAgent: UA.iphoneApp, platform: 'iPhone', standalone: true }, fakeWin());
  assert.equal(paModeFor(env, { checked: true }), 'off', 'home-screen app with push: ready to turn on');
  assert.equal(paDeviceName(env), 'iPhone · Safari');
  assert.equal(paModeFor(env, { checked: false }), 'checking');
  assert.equal(paModeFor(env, { checked: true, on: true }), 'on');
  assert.equal(paModeFor(env, { checked: true, busy: 'on' }), 'busy');
  assert.equal(paModeFor(env, { checked: true, keyStatus: 503 }), 'nokeys');
  assert.equal(paModeFor(env, { checked: true, error: 'x' }), 'error');
  env = paEnv({ ...sw, userAgent: UA.iphoneApp, standalone: true }, fakeWin({ standalone: true, permission: 'denied' }));
  assert.equal(paModeFor(env, { checked: true, on: true }), 'denied', 'blocked in Settings wins over everything');
  env = paEnv({ ...sw, userAgent: UA.iphoneApp, standalone: true }, fakeWin({ push: false }));
  assert.equal(paModeFor(env, { checked: true }), 'unsupported', 'iOS older than 16.4: no PushManager');
  env = paEnv({ ...sw, userAgent: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5 }, fakeWin());
  assert.deepEqual([env.ios, env.device, paModeFor(env, { checked: true })], [true, 'iPad', 'install'], 'iPadOS reports a Mac user agent');
  env = paEnv({ ...sw, userAgent: UA.macChrome, platform: 'MacIntel', maxTouchPoints: 0 }, fakeWin());
  assert.deepEqual([env.ios, env.supported, paDeviceName(env), paModeFor(env, { checked: true })], [false, true, 'Mac · Chrome', 'off'], 'desktop Chrome: no install step');
  env = paEnv({ ...sw, userAgent: UA.android }, fakeWin());
  assert.equal(paDeviceName(env), 'Android phone · Chrome');
  env = paEnv({ ...sw, userAgent: UA.android, platform: 'MacIntel', maxTouchPoints: 5 }, fakeWin());
  assert.deepEqual([env.ios, env.device], [false, 'Android phone'], 'a touch-emulating desktop browser is not an iPad');
  env = paEnv({ userAgent: UA.macChrome }, fakeWin());
  assert.equal(paModeFor(env, { checked: true }), 'unsupported', 'no service worker support');
  env = paEnv({ ...sw, userAgent: UA.macChrome }, fakeWin({ secure: false }));
  assert.deepEqual([env.secure, paModeFor(env, { checked: true })], [false, 'unsupported']);
});

test('push: the panel says the right thing in plain words for every state', () => {
  const r = (v) => renderPhoneAlerts(Object.assign({ device: 'iPhone', ios: true }, v));
  const install = r({ mode: 'install' });
  assert.equal(count(install, /<li>/g), 4);
  for (const s of ['Tap the Share button', 'square with an arrow pointing up', 'Add to Home Screen', 'Open Aviance Hub from your home screen', 'and tap Turn on', 'iOS 16.4']) assert.ok(install.includes(s), s);
  assert.ok(!install.includes('phoneAlertsOn'), 'no Turn on button until installed');
  const off = r({ mode: 'off' });
  assert.ok(off.includes('Off on this iPhone') && off.includes('>Turn on phone alerts</button>') && off.includes('onclick="phoneAlertsOn()"') && off.includes('Tap <b>Allow</b>'));
  const on = r({ mode: 'on', count: 1 });
  assert.ok(on.includes('On for this iPhone') && on.includes('>Send a test</button>') && on.includes('>Turn off</button>') && !on.includes('devices in total'));
  assert.ok(r({ mode: 'on', count: 3 }).includes('Alerts go to 3 devices in total.'));
  assert.ok(r({ mode: 'on', busy: 'test' }).includes('Sending…') && r({ mode: 'on', busy: 'off' }).includes('Turning off…'));
  const denied = r({ mode: 'denied' });
  for (const s of ['Alerts are blocked on this iPhone', '<b>Settings</b>', '<b>Notifications</b>, then <b>Aviance</b>', 'Allow Notifications', 'Check again']) assert.ok(denied.includes(s), s);
  assert.ok(r({ mode: 'denied', ios: false, device: 'Mac' }).includes('left of the address bar'));
  assert.ok(r({ mode: 'unsupported' }).includes('needs iOS 16.4 or later') && r({ mode: 'unsupported' }).includes('Software Update'));
  assert.ok(r({ mode: 'unsupported', ios: false, device: 'Mac' }).includes("This browser can't show alerts."));
  assert.ok(r({ mode: 'nokeys' }).includes("Phone alerts aren't switched on at our end yet") && r({ mode: 'nokeys' }).includes('phoneAlertsCheck()'));
  assert.ok(install.includes('(Settings → Phone alerts)'), 'the steps point at Settings');
  for (const mode of ['install', 'unsupported', 'denied', 'checking', 'busy', 'nokeys', 'error', 'on', 'off']) assert.ok(!/\bmachine\b/i.test(r({ mode }).replace(/<[^>]*>/g, ' ')), 'plain words: ' + mode);
  const err = r({ mode: 'error', error: '<b>boom</b>' });
  assert.ok(err.includes('&lt;b&gt;boom&lt;/b&gt;') && err.includes('Try again'), 'errors are escaped');
  assert.ok(r({ mode: 'off', note: "You didn't allow notifications." }).includes('pa-note'));
  assert.ok(r({ mode: 'busy' }).includes('disabled'));
});

test('push: Turn on asks permission first, subscribes with the machine key, and posts {subscription, device}; test + Turn off post the endpoint', async () => {
  const realNav = globalThis.navigator;
  const calls = [];
  const key = 'BAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QA';
  let sub = null, unsubscribed = 0, permAsked = 0, registered;
  const makeSub = (opts) => ({ endpoint: 'https://push.example/ep1', options: { applicationServerKey: opts.applicationServerKey.buffer }, toJSON: () => ({ endpoint: 'https://push.example/ep1', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { unsubscribed++; sub = null; return true; } });
  const reg = { active: {}, pushManager: { getSubscription: async () => sub, subscribe: async (o) => { assert.equal(o.userVisibleOnly, true); assert.deepEqual([...o.applicationServerKey], [...urlBase64ToUint8Array(key)]); sub = makeSub(o); return sub; } } };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: UA.iphoneApp, platform: 'iPhone', standalone: true, serviceWorker: { register: async (u, o) => { calls.push(['register', u, o.scope, o.updateViaCache]); registered = reg; return reg; }, getRegistration: async (scope) => { calls.push(['getRegistration', scope]); return registered; }, ready: Promise.resolve(reg) } }, configurable: true });
  globalThis.PushManager = function PushManager() {};
  globalThis.Notification = { permission: 'default', requestPermission: async () => { permAsked++; globalThis.Notification.permission = 'granted'; return 'granted'; } };
  let machine = { key: { status: 200, body: { publicKey: key } } };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null;
    calls.push([init.method, u.pathname + u.search, body, init.headers.authorization]);
    const reply = u.pathname === '/api/mc/push/key' ? machine.key
      : u.pathname === '/api/mc/push/subscribe' ? { status: 200, body: { ok: true, count: 2 } }
      : u.pathname === '/api/mc/push/status' ? { status: 200, body: { subscribed: true, count: 2 } }
      : u.pathname === '/api/mc/push/test' ? { status: 200, body: { ok: true, sent: 1, failed: 0 } }
      : u.pathname === '/api/mc/push/unsubscribe' ? { status: 200, body: { ok: true } } : { status: 404, body: {} };
    return { ok: reply.status < 400, status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  try {
    asOwner(); paRegP = null; Object.assign(pa, { checked: false, on: false, sub: null, count: null, key: null, keyStatus: 0, busy: '', error: '', note: '' });
    openPhoneAlerts();
    assert.ok(el('modalWrap').classList.contains('open'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(paView().mode, 'off'); assert.ok(el('paPanel').innerHTML.includes('Turn on phone alerts'));
    assert.ok(calls.some((c) => c[1] === '/api/mc/push/key' && c[3] === 'Bearer test-token'), 'the key is fetched when the panel opens, with the hub token');
    assert.ok(!calls.some((c) => c[0] === 'register'), 'looking at the panel registers nothing');
    await phoneAlertsOn();
    assert.equal(permAsked, 1);
    assert.deepEqual(calls.find((c) => c[0] === 'register'), ['register', '/sw.js', '/', 'none'], 'Turn on registers /sw.js for the whole site, never from the HTTP cache');
    const subCall = calls.find((c) => c[1] === '/api/mc/push/subscribe');
    assert.deepEqual(subCall[2], { subscription: { endpoint: 'https://push.example/ep1', keys: { p256dh: 'p', auth: 'a' } }, device: 'iPhone · Safari' });
    assert.equal(paView().mode, 'on'); assert.equal(pa.count, 2);
    assert.ok(el('paPanel').innerHTML.includes('On for this iPhone') && el('paPanel').innerHTML.includes('Alerts go to 2 devices'));
    assert.equal(phoneAlertsNavNote(), 'On');
    assert.equal(el('toast').innerHTML.includes('Phone alerts are on for this iPhone'), true);
    await phoneAlertsTest();
    assert.deepEqual(calls.find((c) => c[1] === '/api/mc/push/test')[2], { endpoint: 'https://push.example/ep1' });
    assert.ok(el('toast').innerHTML.includes('Test sent'));
    // a reload: the quiet re-post of the (maybe rotated) subscription
    Object.assign(pa, { on: false, sub: null }); const before = calls.filter((c) => c[1] === '/api/mc/push/subscribe').length;
    await phoneAlertsBoot();
    assert.equal(calls.filter((c) => c[1] === '/api/mc/push/subscribe').length, before + 1); assert.equal(pa.on, true);
    await phoneAlertsOff();
    assert.deepEqual(calls.find((c) => c[1] === '/api/mc/push/unsubscribe')[2], { endpoint: 'https://push.example/ep1' });
    assert.equal(unsubscribed, 1); assert.equal(paView().mode, 'off'); assert.equal(phoneAlertsNavNote(), '');
    // the machine has no VAPID keys yet
    machine.key = { status: 503, body: { error: 'no VAPID keys' } }; pa.key = null;
    await phoneAlertsCheck();
    assert.equal(paView().mode, 'nokeys'); assert.ok(el('paPanel').innerHTML.includes("aren't switched on at our end"));
    // no network
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await phoneAlertsCheck();
    assert.equal(paView().mode, 'error'); assert.ok(el('paPanel').innerHTML.includes("Couldn't reach the system"));
    // the owner says Don't Allow
    globalThis.Notification = { permission: 'default', requestPermission: async () => { globalThis.Notification.permission = 'denied'; return 'denied'; } };
    pa.error = '';
    await phoneAlertsOn();
    assert.equal(paView().mode, 'denied'); assert.ok(el('paPanel').innerHTML.includes('Allow Notifications'));
    // dismissed the prompt without choosing
    globalThis.Notification = { permission: 'default', requestPermission: async () => 'default' };
    await phoneAlertsOn();
    assert.ok(el('paPanel').innerHTML.includes("You didn't allow notifications"));
    // iPhone in a Safari tab: instructions only, and Turn on does nothing
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: UA.iphone, platform: 'iPhone', serviceWorker: navigator.serviceWorker }, configurable: true });
    const n = calls.length; await phoneAlertsOn(); await phoneAlertsCheck();
    assert.equal(calls.length, n); assert.equal(paView().mode, 'install'); assert.ok(el('paPanel').innerHTML.includes('Add to Home Screen'));
  } finally {
    closeModal();
    Object.defineProperty(globalThis, 'navigator', { value: realNav, configurable: true });
    delete globalThis.PushManager; delete globalThis.Notification;
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    Object.assign(pa, { checked: false, on: false, sub: null, count: null, key: null, keyStatus: 0, busy: '', error: '', note: '' }); paRegP = null;
  }
});

test('push: the home-screen app shows "First time in the app? Sign in once here." on the login screen', () => {
  assert.ok(html.includes('<div id="loginAppNote" class="login-app-note" style="display:none">First time in the app? Sign in once here.</div>'));
  assert.equal(hubStandalone(), false, 'a normal browser tab');
  const realNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { standalone: true }, configurable: true });
  try { assert.equal(hubStandalone(), true); el('loginAppNote').style.display = 'none'; boot(); assert.equal(el('loginAppNote').style.display, 'block'); }
  finally { Object.defineProperty(globalThis, 'navigator', { value: realNav, configurable: true }); }
});

/* ───────────── Inquiries (inquiries.js) ───────────── */
const Q = (id) => JSON.parse(JSON.stringify(inquiryRecords.find((q) => q.id === id)));

test('inquiries: call times read "call in 3 h" / "call is now" / "was 2 days ago"; the board uses the owner\'s short time', () => {
  assert.equal(iqCallRel('2026-10-17T15:00:00Z', '2026-10-17T15:15:00Z', NOW), 'call in 3 h');
  assert.equal(iqCallRel('2026-10-17T11:55:00Z', '2026-10-17T12:10:00Z', NOW), 'call is now');
  assert.equal(iqCallRel('2026-10-15T16:00:00Z', null, NOW), 'was 2 days ago');
  assert.equal(iqCallRel('2026-10-17T12:40:00Z', null, NOW), 'call in 40 min');
  assert.equal(iqCallRel('2026-10-20T14:00:00Z', null, NOW), 'call in 3 days');
  assert.equal(iqCallRel(null, null, NOW), '');
  assert.equal(iqHostShort('2026-10-20T14:00:00Z', NOW), 'Tue 7:30 PM', 'Sri Lanka time, this week');
  assert.equal(iqHostShort('2026-10-30T14:00:00Z', NOW), 'Oct 30, 7:30 PM', 'further out: the date');
  assert.equal(iqSiteUrl('stoneroofing.com'), 'https://stoneroofing.com');
  assert.equal(iqSiteUrl('https://birchlegal.co.uk'), 'https://birchlegal.co.uk');
  assert.equal(iqSiteUrl('javascript:alert(1)'), '');
  assert.equal(iqMailto(Q('qmgv1stone')), 'mailto:dana@stoneroofing.com?subject=Your%20Aviance%20call');
  assert.equal(iqMailto({ email: 'x" onclick="y@z.com' }), '', 'odd addresses are not linked');
  assert.deepEqual(iqCountsOf(inquiryRecords), inquiryCounts);
});

test('inquiries list: four filter chips (no second row of count boxes), newest-first cards with plan, call time, what they sell, and a New marker', () => {
  const html = renderInquiries(inquiryRecords, inquiryCounts, 'open', { now: NOW });
  assert.ok(!html.includes('iq-counts') && !html.includes('iq-count '), 'the counts live on the chips only');
  for (const chip of ['Open · 4', 'Won · 1', 'Lost · 1', 'All · 6']) assert.ok(html.includes(chip), chip);
  assert.ok(!html.includes('New · 2') && !html.includes('Contacted · 2'), 'New and Contacted are inside Open (each card says its status)');
  assert.ok(renderInquiries(inquiryRecords, inquiryCounts, 'contacted', { now: NOW }).includes('aria-pressed="true" onclick="inquiriesSetFilter(\'contacted\')">Contacted · 2'), 'a filter from elsewhere still shows as a chip');
  const order = ['Stone Roofing', 'Birch Legal', 'Cedar HVAC', 'Harbor Dental Group'].map((c) => html.indexOf(c));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), 'open ones, newest first');
  assert.ok(!html.includes('Northwind') && !html.includes('Pixel'), 'won/lost hidden under Open');
  assert.equal(count(html, /class="card iq-card iq-new"/g), 2, 'two New markers');
  assert.equal(count(html, /<span class="pill red">New<\/span>/g), 2);
  assert.ok(html.includes('Growth plan') && html.includes('Scale plan') && html.includes('No plan picked'));
  assert.ok(html.includes('<b>Saturday, October 17, 2026 at 8:30 PM</b> <span class="muted">your time</span>') && html.includes('call in 3 h'));
  assert.ok(html.includes('was 2 days ago'), 'Harbor: the call already happened');
  assert.ok(html.includes('Roof replacement and storm-damage repair'));
  assert.ok(html.includes('Now a trial'), 'Cedar became a trial');
  assert.ok(html.includes('openInquiry(&quot;qmgv1stone&quot;)'));
  const lost = renderInquiries(inquiryRecords, inquiryCounts, 'lost', { now: NOW });
  assert.ok(lost.includes('Pixel &amp; Co') && lost.includes('&lt;b&gt;Brand design&lt;/b&gt;') && !lost.includes('<b>Brand design'), 'escaped');
  assert.ok(lost.includes('No call booked'));
  assert.equal(count(renderInquiries(inquiryRecords, inquiryCounts, 'all', { now: NOW }), /class="card iq-card/g), 6);
  const none = renderInquiries(inquiryRecords.filter((q) => q.status === 'won'), { new: 0, contacted: 0, won: 1, lost: 0 }, 'open', { now: NOW });
  assert.ok(none.includes('Nothing open. Every inquiry has been answered.') && none.includes("inquiriesSetFilter('all')"));
  const empty = renderInquiries(noInquiries.inquiries, noInquiries.counts, 'open', { now: NOW });
  assert.ok(empty.includes('No inquiries yet') && empty.includes("When someone books a call from your website's Book a call form, it shows up here and on your phone.") && !empty.includes('iq-card'));
});

test('inquiry detail: reply by email, their time, website, notes, status moves, and Start a trial instead', () => {
  const s = renderInquiry(Q('qmgv1stone'), { now: NOW });
  assert.ok(!s.includes('iq-company') && s.includes('Dana Stone') && s.includes('Growth plan'), 'the company is the page title (top bar), not repeated');
  assert.equal(count(s, /<span class="pill red">New<\/span>/g), 1, 'the status is said once ("Where it stands")');
  assert.ok(!s.includes('← All inquiries'), 'Back is in the top bar');
  assert.ok(s.includes('href="mailto:dana@stoneroofing.com?subject=Your%20Aviance%20call">Reply by email</a>'));
  assert.ok(s.includes('Tuesday, October 20, 2026 at 7:30 PM') && s.includes('call in 3 days'));
  assert.ok(s.includes('Tuesday, October 20, 2026 at 9:00 AM <span class="muted">(America/Chicago)</span>'), 'their time + zone');
  assert.ok(s.includes('href="https://stoneroofing.com"') && s.includes('>stoneroofing.com</a>'));
  assert.ok(s.includes('No notes yet.') && s.includes('id="iqNoteText"') && s.includes('Add note'));
  assert.ok(s.includes('>Mark contacted</button>') && s.includes('>Mark won</button>') && s.includes('>Mark lost</button>') && !s.includes('Back to New'), 'moves away from New');
  assert.ok(s.includes('id="iqStatusNote"') && s.includes('Note with the change (optional)'));
  assert.ok(s.includes('>Start a free trial and email them</button>') && s.includes('inquiryToTrial(&quot;qmgv1stone&quot;)'));
  const c = renderInquiry(Q('qmgp2cedar'), { now: NOW });
  assert.ok(c.includes('<b>Now a trial</b> — on the waiting list') && c.includes('openTrial(&quot;cedar-hvac&quot;)') && c.includes('Open the trial →'));
  assert.ok(!c.includes('Start a free trial') && c.includes('Back to New') && !c.includes('>Mark contacted<'));
  assert.ok(c.includes('Good call. Not ready to pay yet'));
  const h = renderInquiry(Q('qmgn1harbor'), { now: NOW });
  assert.ok(h.indexOf('Proposal drafted.') < h.indexOf('Called. They want a proposal'), 'newest note first');
  const p = renderInquiry(Q('qmgj2pixel'), { now: NOW });
  assert.ok(!p.includes('href="javascript') && p.includes('javascript:alert(1)'), 'unsafe website shown as text, not linked');
  assert.ok(p.includes('&lt;script&gt;x&lt;/script&gt;') && !p.includes('<script>x'));
  assert.ok(p.includes('No call booked') && p.includes('Not picked') === false && p.includes('Growth'));
  assert.ok(renderInquiry(null).includes('Inquiry not found'));
});

test('inquiries on the board: a strip ("2 new inquiries — Birch Legal, call Sat 8:30 PM"), to-dos open the inquiry, bell and ⌘K include them', () => {
  asOwner(); trialsIngestHub(hubWithInquiries); iq.list = null; iq.counts = null; iq.at = 0;
  const board = renderBoard(hubWithInquiries, { now: NOW });
  assert.ok(board.includes('<b>2 new inquiries — Birch Legal, call Sat 8:30 PM</b>'), 'the soonest upcoming call');
  assert.ok(board.includes('2 more in progress') && board.includes('onclick="render(\'inquiries\')"'));
  assert.ok(board.includes('New plan inquiry from Stone Roofing — call them back') && board.includes('>Open the inquiry</button>'));
  assert.ok(board.includes('<span class="tk-client" onclick="openInquiry(&quot;qmgv1stone&quot;)">Stone Roofing</span>'), 'the company opens the inquiry, not a trial');
  assert.ok(!renderBoard(fullHub, { now: NOW }).includes('iq-strip'), 'an older machine without inquiries: no strip');
  const quiet = inquirySummaryOf(inquiryRecords.filter((q) => q.status === 'won' || q.status === 'lost'));
  assert.equal(renderInquiryStrip(quiet, { now: NOW }), '', 'nothing open: no strip');
  const contactedOnly = inquirySummaryOf(inquiryRecords.filter((q) => q.status === 'contacted'));
  assert.ok(renderInquiryStrip(contactedOnly, { now: NOW }).includes('2 open inquiries'));
  assert.equal(inquiriesNavCount(), 2); renderNav();
  assert.ok(el('navArea').innerHTML.includes('aria-label="Inquiries — 2 new"') && el('navArea').innerHTML.includes('<span class="badge red" title="2 new" aria-hidden="true">2</span>'));
  const bell = trialsNotifs().filter((n) => /plan inquiry/.test(n.t));
  assert.equal(bell.length, 2); bell[0].go();
  assert.equal(currentView, 'inquiry'); assert.ok(['qmgv1stone', 'qmgu9birch'].includes(currentInquiryId));
  trialsTodoAction('inquiry:qmgu9birch'); assert.equal(currentInquiryId, 'qmgu9birch');
  const ents = trialsCmdkEntities().filter((e) => e.type === 'Inquiry');
  assert.deepEqual(ents.map((e) => e.label), ['Stone Roofing', 'Birch Legal', 'Cedar HVAC', 'Harbor Dental Group']);
  assert.ok(trialsCmdkActions().some((a) => a.label === 'Inquiries'));
  trialsIngestHub(emptyHub); assert.equal(inquiriesNavCount(), '', 'no inquiries block → no badge');
  trialsStopTimer();
});

test('inquiries: #inquiry/{id} and #inquiries deep links; the list, the detail and every action post the contract bodies', async () => {
  assert.deepEqual(parseDeepLink('/#inquiry/qmgv1stone'), { view: 'inquiry', id: 'qmgv1stone' });
  assert.deepEqual(parseDeepLink('#inquiries'), { view: 'inquiries' });
  assert.equal(parseDeepLink('#inquiry/<x>'), null);
  asOwner();
  const recs = JSON.parse(JSON.stringify(inquiryRecords)); const calls = [];
  let toTrialReply = { status: 200, body: { ok: true, clientId: 'stone-roofing', outcome: 'onboarding' } };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; calls.push([init.method, u.pathname, body]);
    let reply = { status: 404, body: { error: 'no' } };
    if (u.pathname === '/api/mc/hub') reply = { status: 200, body: Object.assign({}, fullHub, { inquiries: inquirySummaryOf(recs) }) };
    if (u.pathname === '/api/mc/inquiries' && init.method === 'GET') reply = { status: 200, body: { inquiries: recs, counts: inquirySummaryOf(recs).counts } };
    if (u.pathname === '/api/mc/inquiries' && init.method === 'POST') {
      const q = recs.find((r) => r.id === body.id);
      if (body.action === 'status') { q.status = body.status; if (body.note) q.notes.push({ at: NOW.toISOString(), text: body.note }); reply = { status: 200, body: { ok: true, inquiry: q } }; }
      if (body.action === 'note') { q.notes.push({ at: NOW.toISOString(), text: body.text }); reply = { status: 200, body: { ok: true, inquiry: q } }; }
      if (body.action === 'toTrial') { reply = toTrialReply; if (reply.body.clientId) Object.assign(q, { clientId: reply.body.clientId, trialOutcome: reply.body.outcome }); }
    }
    return { ok: reply.status < 400, status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  try {
    inquiriesForget();
    location.hash = '#inquiry/qmgv1stone'; winListeners.hashchange.forEach((f) => f()); location.hash = '';
    assert.equal(currentView, 'inquiry'); assert.equal(currentInquiryId, 'qmgv1stone');
    await loadInquiries(true); trialsRepaint('inquiry');
    assert.ok(el('tkHost').innerHTML.includes('Dana Stone') && el('ptitle').textContent === 'Stone Roofing' && el('psub').textContent === 'Plan inquiry · New');
    assert.equal(el('backBtn').style.display, 'grid', 'a Back button to the list');
    // status with a note
    el('iqStatusNote').value = 'Called, sending a proposal';
    await inquirySetStatus('qmgv1stone', 'contacted');
    assert.deepEqual(calls.filter((c) => c[0] === 'POST').pop()[2], { action: 'status', id: 'qmgv1stone', status: 'contacted', note: 'Called, sending a proposal' });
    assert.ok(el('toast').innerHTML.includes('Marked contacted'));
    assert.ok(calls.filter((c) => c[1] === '/api/mc/hub').length >= 1, 'the board (badge, to-dos) is refreshed too');
    el('iqStatusNote').value = '';
    await inquirySetStatus('qmgv1stone', 'new');
    assert.deepEqual(calls.filter((c) => c[0] === 'POST').pop()[2], { action: 'status', id: 'qmgv1stone', status: 'new' }, 'no empty note is sent');
    // notes
    el('iqNoteText').value = '   '; const before = calls.length;
    await inquiryAddNote('qmgv1stone');
    assert.equal(calls.length, before, 'an empty note is not sent'); assert.ok(el('toast').innerHTML.includes('Write the note first'));
    el('iqNoteText').value = 'Wants to start in November';
    await inquiryAddNote('qmgv1stone');
    assert.deepEqual(calls.filter((c) => c[0] === 'POST').pop()[2], { action: 'note', id: 'qmgv1stone', text: 'Wants to start in November' });
    // Start a trial instead
    let asked = ''; globalThis.confirm = (m) => { asked = m; return true; };
    await inquiryToTrial('qmgv1stone');
    assert.equal(asked, 'Start a free trial for Dana Stone? They get the welcome email now.');
    assert.deepEqual(calls.filter((c) => c[0] === 'POST').pop()[2], { action: 'toTrial', id: 'qmgv1stone' });
    assert.ok(el('toast').innerHTML.includes('Trial started. Dana Stone was emailed the welcome link'));
    assert.ok(el('tkHost').innerHTML.includes('Open the trial →') && el('tkHost').innerHTML.includes('openTrial(&quot;stone-roofing&quot;)'), 'links to the new trial');
    toTrialReply = { status: 200, body: { ok: true, clientId: 'birch-legal', outcome: 'queued', position: 2 } };
    await inquiryToTrial('qmgu9birch');
    assert.ok(el('toast').innerHTML.includes('On the waiting list at number 2'));
    toTrialReply = { status: 400, body: { ok: false, errors: { website: 'A website is required.' } } };
    await inquiryToTrial('qmgn1harbor');
    assert.ok(el('toast').innerHTML.includes('Trial not started: website: A website is required.'));
    globalThis.confirm = () => false; const n = calls.length;
    await inquiryToTrial('qmgn1harbor'); assert.equal(calls.length, n, 'cancel sends nothing');
    globalThis.confirm = () => true;
    // the list view + filters
    render('inquiries'); await new Promise((r) => setTimeout(r, 5));
    assert.ok(el('tkHost').innerHTML.includes('iq-filters'));
    inquiriesSetFilter('won'); assert.ok(el('tkHost').innerHTML.includes('Northwind Logistics') && !el('tkHost').innerHTML.includes('Stone Roofing'));
    inquiriesSetFilter('open');
    assert.equal(iqTrialToast({ already: true }), 'This inquiry is already a trial');
    assert.ok(/moments ago/.test(iqTrialToast({ ok: true, duplicate: true, outcome: 'received' }, 'Omar')));
    assert.equal(iqTrialToast({ outcome: 'declined', reason: 'already_had_trial' }), 'The trial was turned down automatically (already had trial)');
    assert.ok(/finish it/.test(iqTrialToast({ outcome: 'manual' })));
    // unknown id
    openInquiry('qnope'); await new Promise((r) => setTimeout(r, 5));
    assert.ok(el('tkHost').innerHTML.includes('Inquiry not found'));
    // machine down
    inquiriesForget(); globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    render('inquiries'); await new Promise((r) => setTimeout(r, 5));
    assert.ok(el('tkHost').innerHTML.includes("We can't reach the system right now"));
  } finally {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; globalThis.confirm = () => true;
    inquiriesForget(); trialsStopTimer(); render('trials'); trialsStopTimer();
  }
});

test('fit score: number, label, how much was checked, six parts with evidence, dealbreakers and questions — all escaped', () => {
  const score = {
    score: 82, grade: 'A', label: 'Strong fit', confidence: 74, summary: '82/100 — strong fit (74 of 100 points checked).',
    parts: [
      { key: 'b2b', label: 'Sells to businesses', points: 20, checked: 20, max: 20, pct: 100, items: [{ text: 'Website talks to businesses (9 mentions)', status: 'good', max: 12, points: 12, evidence: { quote: 'IT for <law> firms', page: '/' }, known: true }] },
      { key: 'market', label: 'Market', points: 0, checked: 0, max: 15, pct: null, items: [{ text: 'Market size: not counted yet', status: 'unknown', max: 8, points: null, evidence: null, known: false }] },
    ],
    dealbreakers: [], questions: ['How many people work at the company?'],
  };
  const h = renderFitScore({ status: 'done', score });
  assert.ok(h.includes('<b>82</b><small>/100</small>') && h.includes('class="pill green">Strong fit<') && h.includes('Grade A'));
  assert.ok(h.includes('<b>74</b> of 100 points'));
  assert.ok(h.includes('Sells to businesses') && h.includes('<b>100%</b>') && h.includes('not checked'));
  assert.ok(h.includes('“IT for &lt;law&gt; firms” — /'), 'evidence quote escaped');
  assert.ok(h.includes('Not counted — up to 8 points once known'));
  assert.ok(h.includes('Ask them on the call') && h.includes('How many people work at the company?'));
  const no = renderFitScore({ status: 'done', score: { ...score, grade: 'D', label: 'Not a fit', dealbreakers: [{ text: 'Sells cold outreach themselves', evidence: null }] } });
  assert.ok(no.includes('Dealbreakers') && no.includes('class="pill red">No<') && no.includes('class="pill red">Not a fit<'));
  assert.ok(renderFitScore({ status: 'pending' }).includes('Scoring once the website research finishes'));
  assert.equal(renderFitScore(null), '');
  assert.equal(renderFitScore({ status: 'done' }), '', 'no score yet: nothing shown');
  assert.ok(tkScoreBadge({ score: 64, grade: 'C', label: 'Borderline' }).includes('64/100 · Borderline'));
  assert.equal(tkScoreBadge(null), '');
});

test('full company file: money with its basis, offers, history, people, proof, tools, documents — all escaped', () => {
  const d = {
    facts: 212, pagesRead: 48, words: 31240,
    money: {
      revenue: [{ low: 2520000, high: 4500000, basis: '18 people × $140,000–$250,000 revenue per employee for IT services / MSPs (Census SUSB 2022)', floor: false }],
      federal: { searched: ['Hill IT'], state: 'NC', payroll: { annual: 720000, basis: 'PPP loan ÷ 2.5 × 12' }, ppp: [{ amount: 150000, date: '2020-04-20', forgiven: true, recipient: 'HILL IT LLC' }], contracts: [{ amount: 250000, agency: 'Department of Veterans Affairs', date: '2023-02-01', what: 'NETWORK <SUPPORT>' }], grants: [], federalTotal: 250000 },
      sec: { filings: [], raisedMoney: false },
    },
    offers: { promos: [{ offer: 'No long-term contracts', quote: 'No long-term contracts, ever.', page: '/pricing' }], plans: [{ name: 'Essentials', price: '$99 per user / month', page: '/pricing' }], ctas: ['Get a free network assessment'], magnets: [] },
    ads: ['Meta Pixel'],
    company: { founded: '2011', employees: 18 },
    history: { firstSeen: '2012-03-04', monthsCaptured: 120 },
    timeline: [{ year: 2012, title: 'Hill Computer Repair', headline: 'Home & office', url: 'https://web.archive.org/web/2012/x' }, { year: 2025, title: 'Hill IT | Managed IT', changed: ['title'], url: 'https://web.archive.org/web/2025/x' }],
    blog: { posts: 30, latest: '2026-08-01', first: '2019-02-01' },
    people: [{ name: 'Jane Hill', title: 'Founder & CEO', page: '/team' }], jobs: [{ title: 'Account Executive', sales: true, page: '/careers' }],
    clients: [{ name: 'Smith & Lowe' }], testimonials: [{ quote: 'Fast <b>fix</b>', by: 'Ann', page: '/' }], caseStudies: [], industries: ['law firms'],
    credentials: [{ name: 'SOC 2', quote: 'SOC 2 aligned', page: '/about' }], tech: [{ name: 'HubSpot', kind: 'crm / marketing' }],
    emailSetup: { mailHost: 'Microsoft 365', senders: ['HubSpot'], dmarc: 'quarantine', verifiedTools: ['DocuSign'] },
    lookalikes: [{ domain: 'gethillit.com', mail: true, pointsHome: true }],
    documents: [{ url: 'https://hill-it.com/cap.pdf', title: 'Capabilities', pages: 2, words: 800, credentials: ['CMMC'] }], addresses: ['100 Main St, Charlotte, NC 28202'],
  };
  const h = renderDeep(d);
  assert.ok(h.includes('212 facts from 48 pages and 1 document'));
  assert.ok(h.includes('<b>$2.5M–$4.5M</b>') && h.includes('18 people × $140,000–$250,000'));
  assert.ok(h.includes('Payroll $720k a year (2019)') && h.includes('$150k · 2020-04-20 · forgiven'));
  assert.ok(h.includes('Department of Veterans Affairs') && h.includes('NETWORK &lt;SUPPORT&gt;'));
  assert.ok(h.includes('No long-term contracts') && h.includes('Essentials · $99 per user / month') && h.includes('Get a free network assessment') && h.includes('tracking for Meta Pixel'));
  assert.ok(h.includes('Founded <b>2011</b>') && h.includes('online since <b>2012-03-04</b>') && h.includes('class="pill amber">changed<'));
  assert.ok(h.includes('<b>Jane Hill</b> — Founder &amp; CEO') && h.includes('class="pill blue">sales<'));
  assert.ok(h.includes('“Fast &lt;b&gt;fix&lt;/b&gt;”'), 'testimonial escaped');
  assert.ok(h.includes('Hosted by Microsoft 365') && h.includes('gethillit.com · has mail servers · <b>points at their site</b>'));
  assert.ok(h.includes('href="https://hill-it.com/cap.pdf"') && h.includes('mentions CMMC'));
  assert.equal(renderDeep(null), '');
});
