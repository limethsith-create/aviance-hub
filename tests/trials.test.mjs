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
import { NOW, acme, bright, fern, fernApplication, fernDetail, stagesWith, fullHub, emptyHub, detail, tinyGrowth, makeGrowth, research, shoppingV2, brightPurchase } from './fixtures.mjs';

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
supa.session = { access_token: 'test-token' }; // boot() has already seen "no session" and shown the login screen
after(() => trialsStopTimer());
const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const count = (s, re) => (s.match(re) || []).length;
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

/* ───────────── shell ───────────── */
test('shell: title, router knows only the four trial views, nothing from the old workspace remains', () => {
  assert.ok(html.includes('<title>Aviance Hub — Trials</title>'));
  assert.deepEqual(Object.keys(views), ['trials', 'trial', 'trialPurchase', 'trialAlerts']);
  for (const gone of ['viewDashboard', 'viewProjects', 'viewTeam', 'viewClients', 'viewCRM', 'viewProposals', 'viewInvoices', 'viewMyDay', 'viewDirectory', 'workspace_shared', 'workspace_admin', 'loadData', 'saveDB', 'openNewProject', 'composeGmail', 'submitJoin', 'approveJoin', 'applyRole', 'employeePersona', 'printDoc', 'crmStages', 'phases', 'Request to join', 'joinPane', 'roleMenu']) {
    assert.ok(!html.includes(gone), gone + ' is gone');
  }
  const trialsSrc = fs.readFileSync(path.join(root, 'trials.js'), 'utf8');
  for (const gone of [/typeof leads/, /\bleads\.find/, /\bsaveDB\b/, /\btodayShort\b/, /\bopenLead\b/, /trialsHealthCard/, /trialLineForName/, /trialStartFromLead/, /trialsBoot/, /I\.grid/]) {
    assert.ok(!gone.test(trialsSrc), 'trials.js no longer references ' + gone);
  }
});

test('shell: sidebar is Trials + Machine only; machine pages are SSO links with an arrow', () => {
  const groups = navConfig();
  assert.deepEqual(groups.map((g) => g.label), ['Trials', 'Machine']);
  assert.deepEqual(groups[0].items.map((i) => i.view), ['trials', 'trialAlerts']);
  assert.deepEqual(groups[1].items.map((i) => i.path), ['/mc/queue', '/mc/warmup', '/mc/config', '/mc/test', '/mc/learning']);
  asOwner(); renderNav();
  const nav = el('navArea').innerHTML;
  assert.ok(nav.includes("openMachine('/mc/config')") && nav.includes('<span class="ext">↗</span>'));
  assert.ok(nav.includes("render('trials')") && nav.includes("render('trialAlerts')"));
  assert.ok(!/Projects|CRM|Calendar|Invoices/.test(nav));
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
  render('trialAlerts'); assert.equal(currentView, 'trialAlerts');
  authUser = null; render('trials'); assert.equal(currentView, 'trialAlerts', 'signed out: no navigation');
  asOwner(); render('trials');
});

test('shell: ⌘K lists trials and actions only; the bell shows trial to-dos and urgent alerts', () => {
  asOwner(); trialsIngestHub(fullHub);
  renderCmdk('');
  const list = el('cmdkList').innerHTML;
  for (const s of ['Acme Plumbing', 'Bright Dental', 'New trial client', 'Trials board', 'Machine alerts', 'Warm-up circle', 'Test Mode', 'Toggle light / dark', 'Log out']) assert.ok(list.includes(s), '⌘K has ' + s);
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
test('charts: null is a gap, a recorded day with a missing field is 0, never the other way round', () => {
  assert.deepEqual(tkSegments([1, null, 2, 3, null]), [[[0, 1]], [[2, 2], [3, 3]]]);
  assert.deepEqual(tkSegments([null, null]), []);
  assert.equal(tkNiceMax(3), 5); assert.equal(tkNiceMax(47), 50); assert.equal(tkNiceMax(0), 1);
  const m = tkSendingModel(tinyGrowth);
  assert.deepEqual(m.sent, [null, 40, 38, 0, null, 45], 'day 3 had only a reply → recorded, 0 sent');
  assert.deepEqual(m.first, [null, 22, 0, 0, null, 20], 'no sentD0 field on a sending day = 0 first emails');
  assert.deepEqual(m.follow, [null, 18, 38, 0, null, 25]);
  assert.deepEqual(m.replies, [null, 2, 0, 1, null, 3]);
  assert.deepEqual(m.booked, [null, 0, 0, 0, null, 1]);
  assert.equal(m.totals.sent, 123); assert.equal(m.totals.replies, 6);
  assert.deepEqual(m.running.sent, [0, 40, 78, 78, 78, 123], 'running total holds through gaps');
  const w = tkWarmupModel(tinyGrowth);
  assert.deepEqual(w.sent, [null, 30, 30, null, 30, 31]); assert.deepEqual(w.rate, [null, 0.9, 0.92, null, 0.94, 0.95]);
  assert.equal(w.lastRate, 0.95);
  const p = tkPlacementModel(tinyGrowth);
  assert.deepEqual(p.seed, [null, 0.9, null, null, null, null]); assert.deepEqual(p.mt, [null, null, null, null, 9.1, null]);
  const sl = tkSliceGrowth(makeGrowth(45), 14);
  assert.equal(sl.days.length, 14); assert.equal(sl.email.sent.length, 14); assert.equal(sl.inboxes[0].rate.length, 14);
  assert.ok(sl.placement.every((x) => x.day >= sl.days[0]), 'placement trimmed to the range');
});

test('charts: the SVG draws nothing on gap days, a thin tick on zero days, and breaks lines at gaps', () => {
  const m = tkSendingModel(tinyGrowth);
  const svg = renderChart({ days: m.days, height: 160, bars: [{ label: 'First emails', color: '--c1', values: m.first }, { label: 'Follow-ups', color: '--c2', values: m.follow }] });
  assert.equal(count(svg, /class="tk-zero"/g), 1, 'one recorded-zero day → one tick');
  assert.equal(count(svg, /style="fill:var\(--c[12]\)"/g), 5, '5 bar segments: day1 ×2, day2 ×1 (0 first skipped), day5 ×2');
  const slot = 1000 / 6; const gapX = ((0.5) * slot - 15).toFixed(1);
  assert.ok(!svg.includes(`x="${gapX}"`) && !svg.includes(`M${gapX} `), 'nothing at all on day 0 (gap)');
  assert.ok(svg.includes('tk-legend') && svg.includes('First emails') && svg.includes('Follow-ups'), 'legend for two series');
  const w = tkWarmupModel(tinyGrowth);
  const rate = renderChart({ days: w.days, percent: true, lines: [{ label: 'Inbox rate', color: '--c1', values: w.rate }], refs: [{ value: 0.9, label: 'Ready · 90%' }, { value: 0.8, label: 'Low · 80%' }] });
  assert.equal(count(rate, /class="tk-line"/g), 2, 'the gap on day 3 splits the line in two');
  assert.equal(count(rate, /class="tk-refline"/g), 2); assert.ok(rate.includes('Ready · 90%') && rate.includes('Low · 80%'));
  assert.ok(!rate.includes('tk-legend'), 'single series: no legend box');
  assert.ok(rate.includes('>100%<') && rate.includes('>0%<'), 'percent axis labels in HTML');
  assert.ok(!/<text/.test(svg + rate), 'no SVG text — labels stay HTML so they never shrink below 13px');
  const one = renderChart({ days: ['2026-10-17', '2026-10-18'], lines: [{ label: 'x', color: '--c1', values: [null, 5] }] });
  assert.ok(one.includes('tk-dot-mark'), 'a single isolated value is drawn as a dot');
});

test('charts: tooltips say plain words and a null day says "Nothing recorded"; a table twin exists', () => {
  const html = renderSendingGrowth(tkSendingModel(tinyGrowth), acme);
  const tips = JSON.parse(html.match(/data-tips="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  assert.equal(tips.length, 6);
  assert.equal(tips[0].note, 'Nothing recorded'); assert.deepEqual(tips[0].r, []);
  assert.deepEqual(tips[1].r.map((r) => r[1]), ['emails sent', 'first emails', 'follow-ups', 'replies', 'positive replies', 'calls booked']);
  assert.equal(tips[1].r[0][0], '40');
  assert.ok(tips[5].note.includes('123 sent'), 'running totals in the tooltip');
  assert.ok(html.includes('Show the numbers') && html.includes('<th>Follow-ups</th>'), 'table view');
  assert.ok(html.includes('Replies') && html.includes('Positive replies') && html.includes('Calls booked'), 'aligned small multiples, one scale each');
});

/* ───────────── board ───────────── */
test('renderBoard: full board with clients across stages, sparklines only where there is something to chart', () => {
  const g14 = tkSliceGrowth(makeGrowth(45), 14);
  const html = renderBoard(fullHub, { at: Date.now(), now: NOW, sparks: { 'acme-plumbing': g14 } });
  for (const s of ['Acme Plumbing', 'Bright Dental', 'Cobalt HVAC', 'Fern IT']) assert.ok(html.includes(s), 'client name ' + s);
  assert.ok(html.includes('Sending — Day 12 of 30') && html.includes('Waiting for you to buy'));
  assert.ok(html.includes('Buy bright-team.com and 2 inboxes, then paste the logins'));
  assert.ok(html.includes('Machine setup: still to set — Telegram, Healthchecks'));
  assert.ok(!html.includes('<b>Ended</b>'), 'empty Ended column is skipped');
  assert.ok(html.includes('Delta Roofing') && html.includes('Promote'));
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
  assert.ok(e.includes('No trials yet') && e.includes('Nothing waiting on you'));
  const evil = Object.assign({}, acme, { id: 'evil', name: '<img src=x onerror=alert(1)>', todo: [{ id: 'x', text: '<script>alert(2)</script>', urgent: true, since: null, action: { type: 'none' } }] });
  const hub = Object.assign({}, fullHub, { stages: stagesWith({ live: [evil] }), todos: [Object.assign({ clientId: 'evil', clientName: evil.name }, evil.todo[0])] });
  const h = renderBoard(hub, { now: NOW });
  assert.ok(!h.includes('<img src=x') && !h.includes('<script>alert(2)') && h.includes('&lt;img src=x'));
});

/* ───────────── trial detail: Overview + tabs ───────────── */
test('Overview: what to do, the 13-system strip, four growth numbers with sparklines', () => {
  const g14 = tkSliceGrowth(makeGrowth(45), 14);
  const html = renderTrialDetail(detail, 'overview', { now: NOW, spark: { g: g14, state: null } });
  assert.ok(html.includes('Acme Plumbing') && html.includes('Sending — Day 12 of 30'));
  const iTodo = html.indexOf('What you need to do'), iSys = html.indexOf('<h3>Systems</h3>'), iGrow = html.indexOf('<h3>Growth</h3>');
  assert.ok(iTodo > 0 && iTodo < iSys && iSys < iGrow, 'order: to-dos, systems, growth');
  assert.ok(html.includes('Decide the dispute on the call'));
  assert.equal(count(html, /class="tk-strip-item /g), 13, '13 systems in the strip');
  const labels = ['Intake', 'Market count', 'Purchase', 'Setup check', 'Warm-up', 'Lead list', 'Copy', 'Canary test', 'Sending', 'Replies', 'Calls', 'Reports', 'Closing'];
  let last = -1; for (const l of labels) { const i = html.indexOf('<b>' + l + '</b>', iSys); assert.ok(i > last, 'strip order ' + l); last = i; }
  assert.ok(html.includes('1 blocked') && html.includes('1 waiting'), 'strip summary in words');
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
  for (const s of ['Emails sent per day', 'Warm-up emails per day', 'Inbox rate, rolling 7 days', 'Seed test — share that landed in the inbox', 'Mail-tester score (out of 10)']) assert.ok(html.includes(s), s);
  assert.ok(html.includes('Landed in the inbox') && html.includes('Landed in spam'), 'warm-up legend');
  assert.ok(html.includes('Ready · 90%') && html.includes('Low · 80%') && html.includes('Needed for Day 1 · 85%'));
  assert.equal(count(html, /class="card tk-mini-chart"/g), 2, 'one small chart per inbox');
  assert.ok(html.includes('ann@acme-team.com') && html.includes('Cap today <b>12 a day</b>') && html.includes('Cap today <b>8 a day</b>'));
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
    copy: ['Open the copy editor', 'Send approval link', 'Dispatch Lead Finder', 'both'],
    comingup: ['Friday update', 'Day 29 report', 'Answer Ann about the calendar', 'Add a note', 'friday:2026-10-10', 'counters.held missing'],
    timeline: ['dispute_opened', 'scorekeeper', 'd0 to bob@example.com'],
    actions: ['Pause sending', 'Clear legal hold', 'Run a job now', 'IMAP timeout', 'Mark paid', 'Log time', 'Override market count', 'Client links', 'https://machine.test/c/tok1/onboard'],
  };
  for (const [tab, needles] of Object.entries(tabs)) { const h = renderTab(detail, tab); for (const n of needles) assert.ok(h.includes(n), `tab ${tab} contains "${n}"`); }
  const tl = renderTab(detail, 'timeline'); assert.ok(tl.indexOf('sent') < tl.indexOf('dispute_opened'), 'newest event first');
  assert.ok(renderTab(Object.assign({}, detail, { row: Object.assign({}, acme, { state: 'paused' }) }), 'actions').includes('Resume sending'));
  for (const old of ['setup', 'promises', 'upcoming', 'reports']) assert.ok(renderTab(detail, old).length > 100, 'old tab name ' + old + ' still lands somewhere');
  for (const tab of ['overview', 'growth', 'systems', 'leads', 'deliverability', 'inboxes', 'calls', 'replies', 'copy', 'comingup', 'timeline', 'actions']) assert.doesNotThrow(() => renderTab({ row: bright }, tab, {}), 'sparse detail: ' + tab);
});

test('Leads tab: grade bar, ready-to-send count, checks, reasons, sources, best-leads table', () => {
  const h = renderLeadsTab(detail);
  assert.ok(h.includes('Ready to send') && h.includes('>350<') && h.includes('>812<'));
  for (const s of ['Grade A · 140', 'Grade B · 210', 'Grade C · 90', 'Rejected · 372']) assert.ok(h.includes(s), s);
  assert.ok(h.includes('tk-gradebar') && count(h, /flex:\d+;background:var\(--(g-[abc]|c-none)\)/g) === 4, 'four grade segments');
  assert.ok(h.includes('Valid · 330') && h.includes('Catch-all · 25') && h.includes('Checks left today: <b>45</b>'));
  assert.ok(h.includes('Role address (info@)') && h.includes('google-places') && h.includes('>600<'));
  assert.ok(h.includes('Jim Reyes') && h.includes('Riverton Bistro') && h.includes('Matches a dream customer'));
  assert.ok(h.includes('class="pill green">A<') && h.includes('class="pill blue">B<') && h.includes('class="pill amber">C<'));
  assert.ok(h.includes('in sequence · 120'), 'the lead list by status stays');
  const none = renderLeadsTab(Object.assign({}, detail, { leadQuality: undefined }));
  assert.ok(none.includes('Lead grading shows here once') && none.includes('unsent · 380'));
});

test('Deliverability tab: bounce meter vs the pause/stop lines, blacklists, warm-up circle, placement list, DNS', () => {
  const h = renderDeliverabilityTab(detail);
  assert.ok(h.includes('1.2%') && h.includes('Healthy') && h.includes('pauses at 1.5%') && h.includes('stops at 2%'));
  assert.equal(count(h, /class="tk-meter-mark"/g), 2);
  assert.ok(h.includes('class="pill green">Clean<') && h.includes('Clean on 7 of 7 lists'));
  assert.ok(h.includes('Inboxes in the circle') && h.includes('>14<') && h.includes('gmail · 4') && h.includes('Pairs today'));
  assert.ok(h.includes('9.1/10') && h.includes('SPF pass') && h.includes('https://www.mail-tester.com/test-abc123'));
  assert.ok(!h.includes('javascript:'), 'unsafe report link is dropped');
  assert.ok(h.includes('Domain and DNS') && h.includes('spf') && h.includes('Re-run setup check'));
  const over = renderBounceMeter({ rate7d: 0.021, pauseAt: 0.015, stopAt: 0.02 });
  assert.ok(over.includes('Over the stop line') && over.includes('pill red'));
  assert.ok(renderBounceMeter({ rate7d: 0.016, pauseAt: 0.015, stopAt: 0.02 }).includes('Over the pause line'));
  const none = renderDeliverabilityTab(Object.assign({}, detail, { deliverability: null }));
  assert.ok(none.includes('show here once the machine sends them') && none.includes('Domain and DNS'));
});

/* ───────────── application review ───────────── */
test('application pending: shown above the tabs with the fit check, the research, every answer and the two buttons', () => {
  const html = renderTrialDetail(fernDetail, 'overview', { now: NOW });
  const iApp = html.indexOf('id="tkSec-application"'), iTabs = html.indexOf('id="tkTabBar"'), iTodo = html.indexOf('What you need to do');
  assert.ok(iApp > 0 && iApp < iTabs && iTabs < iTodo, 'application sits above the tabs');
  assert.ok(html.includes('Waiting for your review') && html.includes('Looks like a fit — 3 checks unknown'));
  for (const l of fernApplication.fit.lines) assert.ok(html.includes(esc(l.label)), 'fit line ' + l.rule);
  for (const x of fernApplication.answers) assert.ok(html.includes('<dt>' + esc(x.q) + '</dt>'), 'question ' + x.q);
  assert.ok(html.includes('Approve — send the onboarding link') && html.includes('Decline…'));
  assert.ok(!html.includes("trialsSetTab(&quot;application&quot;)"), 'no Application tab while pending');
  const iResearch = html.indexOf('What we found'), iAnswers = html.indexOf('Their answers');
  assert.ok(iResearch > 0 && iResearch < iAnswers, 'research above the answers');
});

test('application research: summary, about the company, Google rating + Maps link, market, flags; pending and failed', () => {
  const h = renderResearch(research);
  assert.ok(h.includes(esc(research.summary)));
  assert.ok(h.includes('About the company') && h.includes('Managed IT, Cybersecurity, HIPAA compliance, Cloud backup') && h.includes('Austin, TX · San Antonio, TX'));
  assert.ok(h.includes('4.8★') && h.includes('57 reviews') && h.includes('href="https://maps.google.com/?cid=123456"') && h.includes('Google Maps ↗'));
  assert.ok(h.includes('12 people on the team page · Since 2011') && h.includes('(512) 555-0142'));
  assert.ok(h.includes('href="https://www.linkedin.com/company/fernit"') && !h.includes('javascript:'), 'socials: safe links only');
  assert.ok(h.includes('About <b>4,820</b> matching companies') && h.includes('Google Places'));
  assert.ok(h.includes('class="pill amber">Check<') && h.includes('could be an agency') && h.includes('class="pill grey">Note<'));
  assert.ok(renderResearch({ status: 'pending' }).includes('Researching their website…'));
  const f = renderResearch({ status: 'failed', error: 'Site timed out' }); assert.ok(f.includes("Couldn't research their website: Site timed out"));
  assert.equal(renderResearch(null), '');
  assert.ok(renderResearch({ status: 'done', website: { url: 'https://x.com' }, business: null }).includes('Not found on Google Maps'));
});

test('application decided: an Application tab, no buttons, the decision in words', () => {
  const html = renderTrialDetail(detail, 'overview', { now: NOW });
  assert.ok(!html.includes('id="tkSec-application"'));
  assert.ok(html.includes("trialsSetTab(&quot;application&quot;)"));
  const tab = renderTab(detail, 'application');
  assert.ok(tab.includes('Approved') && tab.includes('the onboarding link went out') && !tab.includes('Decline…'));
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
  assert.equal(asked, 'Send Fern IT the onboarding link now?');
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'approveApplication' });
  assert.ok(el('toast').innerHTML.includes('In the queue — position 2'));
  const failing = JSON.parse(JSON.stringify(fernDetail)); failing.application.fit.lines[1].status = 'fail';
  tk.detail['fern-it'] = failing; openDeclineApplication('fern-it');
  assert.ok(el('modal').innerHTML.includes('>Customer worth ≥ $2,000 in year one.</textarea>') && el('modal').innerHTML.includes("They'll get this reason by email."));
  calls.length = 0; el('tkDeclineReason').value = '  ';
  await submitDeclineApplication('fern-it'); assert.equal(calls.length, 0); assert.ok(el('tkDeclineErr').innerHTML.includes('Write the reason first'));
  el('modalWrap').classList.add('open'); el('tkDeclineReason').value = 'We only run trials for teams of 5–50 people.';
  await submitDeclineApplication('fern-it');
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'declineApplication', reason: 'We only run trials for teams of 5–50 people.' });
  assert.ok(el('toast').innerHTML.includes('Declined — email sent') && !el('modalWrap').classList.contains('open'));
  tk.detail['fern-it'] = fernDetail;
});

/* ───────────── Buy & paste v2 ───────────── */
test('Buy & paste: domain comparison, registrar links, live vs price-list prices, inbox order, totals', () => {
  const h = renderPurchase(brightPurchase, 'bright-dental', { at: Date.now() });
  assert.ok(h.includes('Pick a domain') && count(h, /class="tk-offer/g) === 4);
  assert.ok(h.includes('getbrightdental.com') && h.includes('Top pick') && h.includes("Short, brand + &#39;get&#39;, .com") || h.includes("Short, brand + 'get', .com"));
  assert.ok(h.includes('<b>$9.73</b> at <a href="https://porkbun.com/checkout/search?q=getbrightdental.com"') && h.includes('renews $11.08'));
  assert.ok(h.includes('$10.44 / $10.44') && h.includes('Live price') && h.includes('Price list') && h.includes('promo NEWCOM598'));
  assert.ok(!h.includes('javascript:'), 'unsafe registrar link dropped');
  assert.equal(count(h, /trialsUseDomain\(/g), 3, 'a "Use this domain" button per available name (not the taken one)');
  assert.ok(h.includes('class="pill red">Taken<'));
  assert.ok(h.includes('Registrars compared (5)') && h.includes('At-cost renewals'));
  assert.ok(h.includes('CheapInboxes') && h.includes('$3.50 per inbox × 2 = <b>$7.00 a month</b>') && count(h, /<li><label><input type="checkbox"/g) === 6);
  assert.ok(h.includes('raj@getbrightdental.com') && h.includes('display name <b>Raj Patel</b>'));
  assert.ok(h.includes('<b>$9.73</b> first year') && h.includes('<b>$7.00</b> a month') && h.includes('<b class="tk-big">$16.73</b> for the first month'));
  assert.equal(count(h, /class="pc-email"/g), 2);
  const legacy = renderPurchase({ client: brightPurchase.client, shopping: { chosenDomain: 'bright-team.com', registrarQuotes: [{ name: 'Porkbun', price: 9.13 }], total: 16.13 }, setup: {}, inboxes: [], encKey: true }, 'bright-dental');
  assert.ok(legacy.includes('Shopping list') && legacy.includes('bright-team.com') && !legacy.includes('Pick a domain'), 'older machines: the v1 list still shows');
  const closed = renderPurchase(Object.assign({}, brightPurchase, { encKey: false }), 'bright-dental');
  assert.ok(closed.includes('id="tkPcForm" disabled') && count(closed, /disabled onclick="trialsUseDomain/g) === 3, 'form closed → use buttons disabled');
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
test('growth is fetched when the owner opens it, never by the 60-second refresh; board sparklines skip pre-warm-up clients', async () => {
  asOwner(); trialsIngestHub(fullHub); trialsForget(); asOwner(); trialsIngestHub(fullHub);
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); const u = new URL(url); if (u.pathname.endsWith('/growth')) return ok(makeGrowth(Number(u.searchParams.get('days'))))(); if (u.pathname === '/api/mc/hub') return ok(fullHub)(); return ok(detail)(); };
  tk.detail['acme-plumbing'] = detail; tk.detailAt['acme-plumbing'] = Date.now();
  openTrial('acme-plumbing');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(urls.some((u) => u.endsWith('/api/mc/hub/acme-plumbing/growth?days=14')), 'Overview asks for 14 days');
  trialsSetTab('growth'); await new Promise((r) => setTimeout(r, 0));
  assert.ok(urls.some((u) => u.endsWith('/growth?days=45')), 'Growth tab asks for 45 days');
  assert.ok(tk.growth['acme-plumbing'] && tk.growth['acme-plumbing'].days === 45);
  urls.length = 0; await trialsTick();
  assert.ok(urls.length > 0 && !urls.some((u) => u.includes('/growth')), 'auto-refresh: no growth call');
  trialsGrowthRange(7); await new Promise((r) => setTimeout(r, 0));
  assert.ok(urls.some((u) => u.endsWith('/growth?days=7')), 'range change fetches that range');
  urls.length = 0; render('trials'); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  const sparkIds = urls.filter((u) => u.endsWith('/growth?days=14')).map((u) => u.split('/api/mc/hub/')[1].split('/')[0]);
  assert.ok(!sparkIds.includes('fern-it') && !sparkIds.includes('bright-dental'), 'no sparkline fetch before warm-up');
  assert.ok(!sparkIds.includes('acme-plumbing'), 'acme already cached from the Growth tab');
  assert.ok(sparkIds.includes('cobalt-hvac') && sparkIds.includes('aviance'));
  urls.length = 0; render('trials'); await new Promise((r) => setTimeout(r, 0));
  assert.ok(!urls.some((u) => u.includes('/growth')), 'cached for 6 hours — reopening the board costs nothing');
  assert.ok(JSON.parse(localStorage.getItem(TK_SPARK_KEY))['cobalt-hvac'], 'kept across reloads');
});

test('machine unreachable on first load: one clear card; a failed refresh keeps the cached board', async () => {
  tk.hub = null; tk.hubErr = null;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const r = await loadHub(true);
  assert.equal(r.ok, false);
  assert.ok(trialsHostHTML('trials').includes("The machine isn't reachable from the hub yet"));
  trialsIngestHub(fullHub);
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'Unauthorized' }) });
  await loadHub(true);
  const h = trialsHostHTML('trials'); assert.ok(h.includes("Couldn't refresh from the machine") && h.includes('Acme Plumbing'));
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
  globalThis.fetch = respond(200, '<html>not json</html>', false); r = await machineFetch('/api/mc/hub'); assert.ok(r.error.includes('not JSON'));
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
const varsIn = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
const rootVars = varsIn(shellCss.match(/:root\{[\s\S]*?\n\}/)[0]);
const darkVars = Object.assign({}, rootVars, varsIn(shellCss.match(/body\.dark\{[^}]*\}/)[0]));
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const allStyle = { 'trials.css': noComments(css), 'index.html <style>': noComments(shellCss), 'index.html markup/script': html.slice(html.indexOf('</style>')), 'trials.js': trialsJs };

test('font: one plain system font family, no web fonts, no capitals-only labels, no letter-spacing, weights 400/600', () => {
  assert.equal(rootVars.font, '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|@import|@font-face/i.test(html + css), 'no web font is loaded');
  assert.ok(!/JetBrains|Inter Tight|var\(--mono\)|var\(--display\)/.test(noComments(html) + noComments(css) + trialsJs), 'no second family');
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
    ['red', 'urgent-row'], ['muted', 'urgent-row'], ['text', 'urgent-row'], ['text', 'amber-bg'], ['text', 'red-bg'], ['text', 'green-bg'], ['muted', 'amber-bg'], ['muted', 'red-bg'], ['muted', 'green-bg']];
  const marks = ['c1', 'c2', 'c3', 'c-none', 'g-a', 'g-b', 'g-c', 'green', 'amber', 'red'];
  for (const [mode, v] of [['light', rootVars], ['dark', darkVars]]) {
    for (const [fg, bg] of text) { const r = ratio(v[fg], v[bg]); assert.ok(r >= 4.5, `${mode}: --${fg} (${v[fg]}) on --${bg} (${v[bg]}) is ${r.toFixed(2)}:1`); }
    for (const k of marks) { const r = ratio(v[k], v.bg); assert.ok(r >= 3, `${mode}: chart mark --${k} (${v[k]}) on --bg is ${r.toFixed(2)}:1`); }
  }
  for (const cls of ['green', 'amber', 'red', 'blue']) assert.ok(shellCss.includes(`.pill.${cls}{background:var(--${cls}-bg);color:var(--${cls})}`));
});
