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
import { NOW, acme, bright, fern, fernApplication, fernDetail, stagesWith, fullHub, emptyHub, detail, tinyGrowth, makeGrowth, research, shoppingV2, brightPurchase, inquiryRecords, inquiryCounts, inquirySummaryOf, hubWithInquiries, noInquiries } from './fixtures.mjs';

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
vm.runInThisContext(fs.readFileSync(path.join(root, 'push.js'), 'utf8'), { filename: 'push.js' });
supa.session = { access_token: 'test-token' }; // boot() has already seen "no session" and shown the login screen
after(() => trialsStopTimer());
const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const count = (s, re) => (s.match(re) || []).length;
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

/* ───────────── shell ───────────── */
test('shell: title, router knows only the trial + inquiry views, nothing from the old workspace remains', () => {
  assert.ok(html.includes('<title>Aviance Hub — Trials</title>'));
  assert.deepEqual(Object.keys(views), ['trials', 'trial', 'trialPurchase', 'trialAlerts', 'inquiries', 'inquiry']);
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
  assert.deepEqual(groups[0].items.map((i) => i.view), ['trials', 'inquiries', 'trialAlerts']);
  assert.deepEqual(groups[1].items.filter((i) => i.path).map((i) => i.path), ['/mc/queue', '/mc/warmup', '/mc/config', '/mc/test', '/mc/learning']);
  const phone = groups[1].items[groups[1].items.length - 1];
  assert.equal(phone.label, 'Phone alerts'); assert.equal(phone.run, 'openPhoneAlerts()'); assert.equal(phone.icon, I.bellRing);
  asOwner(); renderNav();
  const nav = el('navArea').innerHTML;
  assert.ok(nav.includes("openMachine('/mc/config')") && nav.includes('<span class="ext">↗</span>'));
  assert.ok(nav.includes("render('trials')") && nav.includes("render('trialAlerts')"));
  assert.ok(nav.includes('onclick="openPhoneAlerts()"') && nav.includes('Phone alerts'), 'Phone alerts sits under Machine');
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
    copy: ['Open the copy editor', 'Send approval link', 'Dispatch Lead Finder', 'both'],
    comingup: ['Friday update', 'Day 29 report', 'Answer Ann about the calendar', 'Add a note', 'friday:2026-10-10', 'counters.held missing'],
    timeline: ['dispute_opened', 'scorekeeper', 'd0 to bob@example.com'],
    actions: ['Pause sending', 'Clear legal hold', 'Run a job now', 'IMAP timeout', 'Mark paid', 'Log time', 'Override market count'],
  };
  for (const [tab, needles] of Object.entries(tabs)) { const h = renderTab(detail, tab); for (const n of needles) assert.ok(h.includes(n), `tab ${tab} contains "${n}"`); }
  const tl = renderTab(detail, 'timeline'); assert.ok(tl.indexOf('sent') < tl.indexOf('dispute_opened'), 'newest event first');
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
  assert.ok(h.includes('Domain and DNS') && h.includes('Re-run setup check'));
  const passing = JSON.parse(JSON.stringify(detail.deliverability)); passing.placement[1].spamAssassin = 1.0; passing.placement[1].pass = true;
  assert.ok(renderDeliverabilityTab(Object.assign({}, detail, { deliverability: passing })).includes('Day 1 check passes'));
  assert.ok(renderBounceMeter({ rate7d: 0.021, pauseAt: 0.015, stopAt: 0.02 }).includes('Over the stop line'));
  const slow = renderBounceMeter({ rate7d: 0.016, pauseAt: 0.015, stopAt: 0.02, halved: true });
  assert.ok(slow.includes('Over the pause line') && slow.includes('Half speed') && slow.includes('daily cap was halved'));
  assert.ok(renderBounceMeter({ rate7d: null, pauseAt: 0.015, stopAt: 0.02 }).includes('No bounce rate yet'));
  assert.ok(renderBlacklists({ status: 'unknown', listed: [], warnings: [], clean: 0, unknown: ['a', 'b'], lists: ['a', 'b'] }).includes("Couldn't check"));
  assert.ok(renderBlacklists({ status: 'listed', listed: ['dbl.spamhaus.org'], warnings: [], clean: 6, unknown: [], lists: [] }).includes('Listed on:</b> dbl.spamhaus.org'));
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
const pushJs = fs.readFileSync(path.join(root, 'push.js'), 'utf8');
const varsIn = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
const rootVars = varsIn(shellCss.match(/:root\{[\s\S]*?\n\}/)[0]);
const darkVars = Object.assign({}, rootVars, varsIn(shellCss.match(/body\.dark\{[^}]*\}/)[0]));
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const allStyle = { 'trials.css': noComments(css), 'index.html <style>': noComments(shellCss), 'index.html markup/script': html.slice(html.indexOf('</style>')), 'trials.js': trialsJs, 'push.js': pushJs };

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
test('deep links: #trial/{id}, #alerts and #trials parse; anything else (incl. Supabase auth hashes) does not', () => {
  assert.deepEqual(parseDeepLink('#trial/acme-plumbing'), { view: 'trial', id: 'acme-plumbing' });
  assert.deepEqual(parseDeepLink('/#trial/acme-plumbing'), { view: 'trial', id: 'acme-plumbing' }, 'the push payload url form');
  assert.deepEqual(parseDeepLink('https://aviance.store/#trial/fern-it/'), { view: 'trial', id: 'fern-it' });
  assert.deepEqual(parseDeepLink('#trial/a%2Eb'), { view: 'trial', id: 'a.b' });
  assert.deepEqual(parseDeepLink('#alerts'), { view: 'trialAlerts' });
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
  location.hash = '#alerts'; winListeners.hashchange.forEach((f) => f());
  assert.equal(currentView, 'trialAlerts', 'hashchange → Machine alerts');
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
  assert.ok(r({ mode: 'nokeys' }).includes("The machine isn't ready to send phone alerts yet") && r({ mode: 'nokeys' }).includes('phoneAlertsCheck()'));
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
    assert.equal(paView().mode, 'nokeys'); assert.ok(el('paPanel').innerHTML.includes("isn't ready to send phone alerts"));
    // no network
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await phoneAlertsCheck();
    assert.equal(paView().mode, 'error'); assert.ok(el('paPanel').innerHTML.includes("Couldn't reach the machine"));
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

test('inquiries list: counts strip, filter chips, newest-first cards with plan, call time, what they sell, and a New marker', () => {
  const html = renderInquiries(inquiryRecords, inquiryCounts, 'open', { now: NOW });
  for (const [label, n] of [['New', 2], ['Contacted', 2], ['Won', 1], ['Lost', 1]]) assert.ok(html.includes(`<small>${label}</small><b>${n}</b>`), label + ' tile');
  for (const chip of ['Open · 4', 'All · 6', 'New · 2', 'Contacted · 2', 'Won · 1', 'Lost · 1']) assert.ok(html.includes(chip), chip);
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
  assert.ok(html.includes('class="iq-count new has"'), 'new count in red when there are new ones');
  const empty = renderInquiries(noInquiries.inquiries, noInquiries.counts, 'open', { now: NOW });
  assert.ok(empty.includes('class="iq-count new"'), 'no red for zero');
  assert.ok(empty.includes('No inquiries yet') && empty.includes('Book a call') && !empty.includes('iq-card'));
});

test('inquiry detail: reply by email, their time, website, notes, status moves, and Start a trial instead', () => {
  const s = renderInquiry(Q('qmgv1stone'), { now: NOW });
  assert.ok(s.includes('<h3 class="iq-company">Stone Roofing</h3>') && s.includes('Dana Stone') && s.includes('Growth plan'));
  assert.ok(s.includes('href="mailto:dana@stoneroofing.com?subject=Your%20Aviance%20call">Reply by email</a>'));
  assert.ok(s.includes('Tuesday, October 20, 2026 at 7:30 PM') && s.includes('call in 3 days'));
  assert.ok(s.includes('Tuesday, October 20, 2026 at 9:00 AM <span class="muted">(America/Chicago)</span>'), 'their time + zone');
  assert.ok(s.includes('href="https://stoneroofing.com"') && s.includes('>stoneroofing.com</a>'));
  assert.ok(s.includes('No notes yet.') && s.includes('id="iqNoteText"') && s.includes('Add note'));
  assert.ok(s.includes('>Mark contacted</button>') && s.includes('>Mark won</button>') && s.includes('>Mark lost</button>') && !s.includes('Back to New'), 'moves away from New');
  assert.ok(s.includes('id="iqStatusNote"') && s.includes('Note with the change (optional)'));
  assert.ok(s.includes('>Start a trial instead</button>') && s.includes('inquiryToTrial(&quot;qmgv1stone&quot;)'));
  const c = renderInquiry(Q('qmgp2cedar'), { now: NOW });
  assert.ok(c.includes('<b>Now a trial</b> — waiting in the queue') && c.includes('openTrial(&quot;cedar-hvac&quot;)') && c.includes('Open the trial →'));
  assert.ok(!c.includes('Start a trial instead') && c.includes('Back to New') && !c.includes('>Mark contacted<'));
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
  assert.ok(board.includes('New plan inquiry from Stone Roofing — call them back') && board.includes('>Open inquiry</button>'));
  assert.ok(board.includes('<span class="tk-client" onclick="openInquiry(&quot;qmgv1stone&quot;)">Stone Roofing</span>'), 'the company opens the inquiry, not a trial');
  assert.ok(!renderBoard(fullHub, { now: NOW }).includes('iq-strip'), 'an older machine without inquiries: no strip');
  const quiet = inquirySummaryOf(inquiryRecords.filter((q) => q.status === 'won' || q.status === 'lost'));
  assert.equal(renderInquiryStrip(quiet, { now: NOW }), '', 'nothing open: no strip');
  const contactedOnly = inquirySummaryOf(inquiryRecords.filter((q) => q.status === 'contacted'));
  assert.ok(renderInquiryStrip(contactedOnly, { now: NOW }).includes('2 open inquiries'));
  assert.equal(inquiriesNavCount(), 2); renderNav();
  assert.ok(el('navArea').innerHTML.includes('Inquiries<span class="badge new" title="2 new">2</span>'));
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
    assert.ok(el('tkHost').innerHTML.includes('Stone Roofing') && el('ptitle').textContent === 'Stone Roofing' && el('psub').textContent === 'Plan inquiry · New');
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
    assert.equal(asked, 'Email Dana Stone the trial onboarding link now?');
    assert.deepEqual(calls.filter((c) => c[0] === 'POST').pop()[2], { action: 'toTrial', id: 'qmgv1stone' });
    assert.ok(el('toast').innerHTML.includes('Trial started. Dana Stone was emailed the onboarding link'));
    assert.ok(el('tkHost').innerHTML.includes('Open the trial →') && el('tkHost').innerHTML.includes('openTrial(&quot;stone-roofing&quot;)'), 'links to the new trial');
    toTrialReply = { status: 200, body: { ok: true, clientId: 'birch-legal', outcome: 'queued', position: 2 } };
    await inquiryToTrial('qmgu9birch');
    assert.ok(el('toast').innerHTML.includes('In the queue at position 2'));
    toTrialReply = { status: 400, body: { ok: false, errors: { website: 'A website is required.' } } };
    await inquiryToTrial('qmgn1harbor');
    assert.ok(el('toast').innerHTML.includes('Trial not started: website: A website is required.'));
    globalThis.confirm = () => false; const n = calls.length;
    await inquiryToTrial('qmgn1harbor'); assert.equal(calls.length, n, 'cancel sends nothing');
    globalThis.confirm = () => true;
    // the list view + filters
    render('inquiries'); await new Promise((r) => setTimeout(r, 5));
    assert.ok(el('tkHost').innerHTML.includes('iq-counts'));
    inquiriesSetFilter('won'); assert.ok(el('tkHost').innerHTML.includes('Northwind Logistics') && !el('tkHost').innerHTML.includes('Stone Roofing'));
    inquiriesSetFilter('open');
    assert.equal(iqTrialToast({ already: true }), 'This inquiry is already a trial');
    assert.ok(/moments ago/.test(iqTrialToast({ ok: true, duplicate: true, outcome: 'received' }, 'Omar')));
    assert.ok(/declined/.test(iqTrialToast({ outcome: 'declined', reason: 'already_had_trial' })));
    assert.ok(/finish it/.test(iqTrialToast({ outcome: 'manual' })));
    // unknown id
    openInquiry('qnope'); await new Promise((r) => setTimeout(r, 5));
    assert.ok(el('tkHost').innerHTML.includes('Inquiry not found'));
    // machine down
    inquiriesForget(); globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    render('inquiries'); await new Promise((r) => setTimeout(r, 5));
    assert.ok(el('tkHost').innerHTML.includes("The machine isn't reachable"));
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
