/* Tests for the hub shell (index.html's inline script) and trials.js.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Both are plain browser scripts, so we load them into this process — shell
   first, then trials.js, exactly like the browser — with a tiny fake DOM and a
   fake Supabase client, then call the pure render functions with data shaped
   exactly like email-distributor/docs/HUB-API.md. No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, acme, bright, fern, fernApplication, fernDetail, stagesWith, fullHub, emptyHub, detail } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() {}, select() {}, submit() {}, addEventListener() {}, scrollIntoView() {}, closest() { return null; } };
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
  assert.equal(el('login').style.display, 'none');
  assert.equal(currentView, 'trials', 'lands on the Trials board');
  assert.equal(el('ptitle').textContent, 'Trials');
  assert.equal(el('whoName').textContent, 'Limethsith');
  assert.equal(el('whoEmail').textContent, 'owner@example.com');
  assert.equal(el('whoAvatar').textContent, 'L');
});

test('shell: render() ignores unknown views and needs a signed-in owner', () => {
  asOwner();
  render('trials'); assert.equal(currentView, 'trials');
  render('dashboard'); assert.equal(currentView, 'trials');
  render('crm'); assert.equal(currentView, 'trials');
  render('trialAlerts'); assert.equal(currentView, 'trialAlerts');
  authUser = null; render('trials'); assert.equal(currentView, 'trialAlerts', 'signed out: no navigation');
  asOwner(); render('trials');
});

test('shell: ⌘K lists trials and actions only; the bell shows trial to-dos and urgent alerts', () => {
  asOwner(); trialsIngestHub(fullHub);
  renderCmdk('');
  let list = el('cmdkList').innerHTML;
  for (const s of ['Acme Plumbing', 'Bright Dental', 'New trial client', 'Trials board', 'Machine alerts', 'Warm-up circle', 'Test Mode', 'Toggle light / dark', 'Log out']) assert.ok(list.includes(s), '⌘K has ' + s);
  assert.ok(!/New project|Add lead|Schedule meeting/.test(list));
  renderCmdk('bright'); list = el('cmdkList').innerHTML;
  assert.ok(list.includes('Bright Dental') && !list.includes('Acme Plumbing'));
  renderCmdk('trial:cobalt'); assert.ok(el('cmdkList').innerHTML.includes('Cobalt HVAC'));
  assert.equal(computeNotifs().length, 2);
  updateNotifBadge();
  assert.equal(String(el('notifDot').textContent), '2'); assert.equal(el('notifDot').style.display, 'grid');
  authUser = null; assert.equal(computeNotifs().length, 0); asOwner();
});

/* ───────────── helpers ───────────── */
test('helpers: numbers, rates, relative times, error lists, attribute escaping', () => {
  assert.equal(tkNum(null), '—'); assert.equal(tkNum(1234), '1,234'); assert.equal(tkNum(0), '0');
  assert.equal(tkRate(0.91), '91%'); assert.equal(tkRate(null), '—');
  assert.equal(tkRel('2026-10-17T11:59:18Z', NOW), '42 s ago');
  assert.equal(tkRel('2026-10-17T11:59:59Z', NOW), 'just now');
  assert.equal(tkRel('2026-10-17T11:30:00Z', NOW), '30 min ago');
  assert.equal(tkRel('2026-10-16T22:00:00Z', NOW), '14 h ago');
  assert.equal(tkRel('2026-10-20T12:00:00Z', NOW), 'in 3 d');
  assert.equal(tkRel(null), '—');
  assert.deepEqual(tkErrorList(['a', 'b']), ['a', 'b']);
  assert.deepEqual(tkErrorList({ companyName: 'Company name is required.', _form: 'Nope' }), ['companyName: Company name is required.', 'Nope']);
  assert.equal(tkAttr('it"s <b>'), '&quot;it\\&quot;s &lt;b&gt;&quot;');
  assert.equal(tkStateLabel({ state: 'awaiting_purchase' }), 'Waiting for you to buy');
  assert.equal(tkStateLabel({ state: 'sending', stateLabel: 'Sending — Day 12 of 30' }), 'Sending — Day 12 of 30');
  assert.equal(tkHeartbeatClass({ ageSec: 42 }), 'green'); assert.equal(tkHeartbeatClass({ ageSec: 600 }), 'amber'); assert.equal(tkHeartbeatClass({ ageSec: null }), 'red');
});

/* ───────────── board ───────────── */
test('renderBoard: full board with 3 clients across stages', () => {
  const html = renderBoard(fullHub, { at: Date.now(), now: NOW });
  for (const s of ['Acme Plumbing', 'Bright Dental', 'Cobalt HVAC']) assert.ok(html.includes(s), 'client name ' + s);
  assert.ok(html.includes('Sending — Day 12 of 30'), 'stateLabel printed as-is');
  assert.ok(html.includes('Waiting for you to buy'));
  assert.ok(html.includes('Buy bright-team.com and 2 inboxes, then paste the logins'), 'todo text');
  assert.ok(html.includes('Porkbun $9.13 + Premium Inboxes 2 × $3.50'), 'todo detail');
  assert.ok(html.includes('Buy &amp; paste'), 'purchase todo button');
  assert.ok(html.includes('Machine setup: still to set — Telegram, Healthchecks'), 'setup line lists exactly the missing bits');
  assert.ok(html.includes('42 s ago') || html.includes('1 min ago'), 'heartbeat age');
  for (const l of ['Applied &amp; queued', 'Onboarding', 'Buying &amp; setup', 'Warm-up &amp; build', 'Deciding', 'Converted', 'Not now &amp; closing']) assert.ok(html.includes(l), 'stage column ' + l);
  assert.ok(!html.includes('<b>Ended</b>'), 'empty Ended column is skipped');
  assert.ok(html.includes('Delta Roofing') && html.includes('Promote'), 'queue');
  assert.ok(html.includes('Also on the machine') && html.includes('>Aviance<'), 'others');
  assert.ok(html.includes('Reoon 12 left') && html.includes('Places 12%'), 'usage');
  assert.ok(html.includes('2 <span>/ 3</span>'), 'active / max');
  const cardStart = html.indexOf('class="tk-card" onclick="openTrial(&quot;bright-dental&quot;)"');
  assert.ok(cardStart > 0, 'Bright Dental card present');
  const brightCard = html.slice(cardStart, html.indexOf('</div>\n  </div>', cardStart) + 1);
  assert.ok(brightCard.includes('<b>—</b>'), 'null five renders as —, never 0');
  assert.ok(brightCard.includes('Inbox rate —'));
  assert.ok(html.indexOf('Buy bright-team.com') < html.indexOf('Decide the dispute'), 'urgent first');
});

test('renderBoard: empty board shows the empty state, no throw', () => {
  const html = renderBoard(emptyHub, { at: Date.now(), now: NOW });
  assert.ok(html.includes('No trials yet'));
  assert.ok(html.includes('Nothing waiting on you'));
  assert.ok(!html.includes('Machine setup: still to set'), 'no setup line when everything is set');
  assert.ok(html.includes('never'), 'heartbeat never');
});

test('renderBoard: escapes hostile client names and todo text', () => {
  const evil = Object.assign({}, acme, { id: 'evil', name: '<img src=x onerror=alert(1)>', todo: [{ id: 'x', text: '<script>alert(2)</script>', urgent: true, since: null, action: { type: 'none' } }] });
  const hub = Object.assign({}, fullHub, { stages: stagesWith({ live: [evil] }), todos: [Object.assign({ clientId: 'evil', clientName: evil.name }, evil.todo[0])] });
  const html = renderBoard(hub, { now: NOW });
  assert.ok(!html.includes('<img src=x'), 'name escaped');
  assert.ok(!html.includes('<script>alert(2)'), 'todo text escaped');
  assert.ok(html.includes('&lt;img src=x'));
});

/* ───────────── detail ───────────── */
test('renderTrialDetail: header, todos, every system in contract order, all tabs', () => {
  const html = renderTrialDetail(detail, 'numbers', { at: Date.now(), now: NOW });
  assert.ok(html.includes('Acme Plumbing') && html.includes('Sending — Day 12 of 30'));
  assert.ok(html.includes('ann@acme.com') && html.includes('acme.com'));
  assert.ok(html.includes('1 hot lead unanswered 26 h'), 'health reasons');
  assert.ok(html.includes('Decide the dispute on the call'), 'client todo');
  const labels = ['Intake', 'Market count', 'Purchase', 'Setup check', 'Warm-up', 'Lead list', 'Copy', 'Canary test', 'Sending', 'Replies', 'Calls', 'Reports', 'Closing'];
  let last = -1;
  for (const l of labels) { const i = html.indexOf('<b>' + l + '</b>'); assert.ok(i > last, 'system ' + l + ' present and in order'); last = i; }
  assert.ok(html.includes('inbox ann@acme-team.com 92%'), 'system detail bullet');
  assert.ok(html.includes('tk-st blocked') && html.includes('tk-st working') && html.includes('tk-st off'), 'status pills');
  assert.ok(html.includes('Day 1') && html.includes('Day 30'));
  assert.ok(html.includes('https://machine.test/c/tok1/onboard'), 'client links');
  assert.ok(html.includes('>230<') && html.includes('interested · 4') && html.includes('unsent · 380') && html.includes('Pace checks'));
  const tabs = {
    inboxes: ['ann@acme-team.com', 'inbox rate under 80%', 'Add inbox', 'checked'],
    calls: ['bob@example.com', 'Uphold', 'Overturn', 'wrong fit'],
    replies: ['Sure, tell me more about the pricing', 'interested'],
    copy: ['Open the copy editor', 'Send approval link', 'Dispatch Lead Finder', 'both'],
    setup: ['acme-team.com', 'spf', 'Pass', 'Warn', 'Fail', 'Pending', 'Re-run setup', 'Override market'],
    reports: ['friday:2026-10-10', 'counters.held missing', 'Blocked'],
    promises: ['Answer Ann about the calendar', 'Add note'],
    timeline: ['dispute_opened', 'scorekeeper', 'd0 to bob@example.com'],
    upcoming: ['Friday update', 'Day 29 report'],
    actions: ['Pause sending', 'Clear legal hold', 'Run a job now', 'IMAP timeout', 'Mark paid', 'Log time'],
  };
  for (const [tab, needles] of Object.entries(tabs)) {
    const h = renderTab(detail, tab);
    for (const n of needles) assert.ok(h.includes(n), `tab ${tab} contains "${n}"`);
  }
  const tl = renderTab(detail, 'timeline');
  assert.ok(tl.indexOf('sent') < tl.indexOf('dispute_opened'), 'newest event first');
  assert.ok(renderTab(Object.assign({}, detail, { row: Object.assign({}, acme, { state: 'paused' }) }), 'actions').includes('Resume sending'));
  assert.ok(!renderTab(detail, 'actions').includes('Clear send hold'));
});

test('renderTrialDetail: tolerates a sparse detail (only a row)', () => {
  const html = renderTrialDetail({ row: bright }, 'inboxes', { now: NOW });
  assert.ok(html.includes('Bright Dental') && html.includes('No inboxes yet'));
  for (const tab of ['numbers', 'calls', 'replies', 'copy', 'setup', 'reports', 'promises', 'timeline', 'upcoming', 'actions']) assert.doesNotThrow(() => renderTab({ row: bright }, tab), tab);
  assert.ok(renderTrialDetail({ row: bright }, 'numbers').includes('Buy &amp; paste'), 'awaiting_purchase shows the buy button');
});

/* ───────────── purchase + alerts ───────────── */
test('renderPurchase: shopping list, paste form, encKey gate', () => {
  const p = { client: { id: 'bright-dental', name: 'Bright Dental', state: 'awaiting_purchase', mainDomain: 'brightdental.com' },
    shopping: { chosenDomain: 'bright-team.com', backups: ['getbright.com', 'brighthq.com'], registrarQuotes: [{ registrar: 'porkbun', name: 'Porkbun', price: 9.13, unconfirmed: true }], inboxQuotes: [{ provider: 'premiuminboxes', name: 'Premium Inboxes', price: 3.5 }], senderAddresses: ['raj@bright-team.com', 'hello@bright-team.com'], total: 16.13, sentAt: '2026-10-16T22:00:00Z', boughtAt: null, unconfirmed: ['Porkbun .com price (last seen never)'] },
    setup: { domain: { name: null, setupPhase: null }, checks: {}, senderName: 'Raj Patel' }, inboxes: [], encKey: true };
  const html = renderPurchase(p, 'bright-dental', { at: Date.now() });
  assert.ok(html.includes('bright-team.com') && html.includes('getbright.com') && html.includes('$16.13'));
  assert.ok(html.includes('Unconfirmed'), 'unconfirmed flag');
  assert.ok(html.includes('Auto-renew is <b>OFF</b>'));
  assert.ok((html.match(/class="pc-email"/g) || []).length === 2, 'two inbox rows prefilled from sender addresses');
  assert.ok(html.includes('value="raj@bright-team.com"') && html.includes('value="Raj Patel"'));
  assert.ok(!html.includes('<fieldset class="tk-fs" id="tkPcForm" disabled'), 'form enabled');
  const off = renderPurchase(Object.assign({}, p, { encKey: false }), 'bright-dental');
  assert.ok(off.includes('ENC_KEY') && off.includes('id="tkPcForm" disabled'), 'encKey:false disables the form with the amber line');
  const wrongState = renderPurchase(Object.assign({}, p, { client: Object.assign({}, p.client, { state: 'sending' }) }), 'bright-dental');
  assert.ok(wrongState.includes('id="tkPcForm" disabled') && wrongState.includes('paste form only applies'));
});

test('renderAlerts: open filter hides acknowledged, all shows them', () => {
  const alerts = [
    { id: 'a1', at: '2026-10-17T10:00:00Z', key: 'purchase_reminder', clientId: 'bright-dental', title: 'Shopping list unanswered', urgent: true, delivered: true, acknowledged: false },
    { id: 'a2', at: '2026-10-16T08:00:00Z', key: 'dispute', clientId: 'acme-plumbing', title: 'Dispute on a call', urgent: false, delivered: false, acknowledged: true },
  ];
  const open = renderAlerts(alerts, 'open', { now: NOW });
  assert.ok(open.includes('Shopping list unanswered') && !open.includes('Dispute on a call'));
  assert.ok(open.includes('Urgent') && open.includes('Acknowledge'));
  const all = renderAlerts(alerts, 'all', { now: NOW });
  assert.ok(all.includes('Dispute on a call') && all.includes('not delivered') && all.includes('acknowledged'));
  assert.ok(renderAlerts([], 'open').includes('No open alerts'));
});

/* ───────────── machine-error state + machineFetch ───────────── */
test('machine unreachable on first load: one clear card with the reason and Try again', async () => {
  tk.hub = null; tk.hubErr = null;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const r = await loadHub(true);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('Could not reach the machine at https://email-distributor.vercel.app'));
  const html = trialsHostHTML('trials');
  assert.ok(html.includes("The machine isn't reachable from the hub yet"));
  assert.ok(html.includes('Could not reach the machine') && html.includes('Try again'));
  assert.ok(renderMachineError('CORS said no').includes('CORS said no'));
});

test('machineFetch: bearer token, JSON bodies, 401/503/non-JSON/ok:false handling', async () => {
  const calls = [];
  const respond = (status, body, isJson = true) => async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, text: async () => (isJson ? JSON.stringify(body) : body) }; };
  globalThis.fetch = respond(200, { ok: true, clientId: 'x' });
  let r = await machineFetch('/api/mc/clients/new', { body: { companyName: 'Acme' } });
  assert.equal(r.ok, true); assert.equal(r.data.clientId, 'x');
  assert.equal(calls[0].url, 'https://email-distributor.vercel.app/api/mc/clients/new');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.body, '{"companyName":"Acme"}');
  globalThis.fetch = respond(200, { x: 1 });
  r = await machineFetch('/api/mc/hub'); assert.equal(calls[1].init.method, 'GET'); assert.equal(calls[1].init.body, undefined);
  globalThis.fetch = respond(401, { error: 'Unauthorized' });
  r = await machineFetch('/api/mc/hub'); assert.equal(r.ok, false); assert.equal(r.status, 401); assert.equal(r.error, 'Unauthorized');
  globalThis.fetch = respond(503, { error: 'ENC_KEY missing' });
  r = await machineFetch('/api/mc/hub'); assert.equal(r.status, 503); assert.equal(r.error, 'ENC_KEY missing');
  globalThis.fetch = respond(403, {});
  r = await machineFetch('/api/mc/hub'); assert.ok(r.error.includes('403'));
  globalThis.fetch = respond(200, '<html>not json</html>', false);
  r = await machineFetch('/api/mc/hub'); assert.equal(r.ok, false); assert.ok(r.error.includes('not JSON'));
  globalThis.fetch = respond(400, { ok: false, errors: { companyName: 'Company name is required.' } });
  r = await machineFetch('/api/mc/clients/new', { body: {} }); assert.equal(r.ok, false); assert.equal(r.status, 400); assert.ok(r.error.includes('Company name is required.')); assert.deepEqual(r.data.errors, { companyName: 'Company name is required.' });
  globalThis.fetch = respond(200, { ok: false, error: 'client is in sending' });
  r = await machineFetch('/api/mc/x', { body: {} }); assert.equal(r.ok, false); assert.equal(r.error, 'client is in sending');
  supa.session = null;
  r = await machineFetch('/api/mc/hub'); assert.equal(r.ok, false); assert.ok(r.error.includes('not signed in'));
  supa.session = { access_token: 'test-token' };
});

/* ───────────── integration ───────────── */
test('notifications, nav counts, ⌘K entities and todo actions come from the cached hub data', () => {
  asOwner(); trialsIngestHub(fullHub);
  const n = trialsNotifs();
  assert.equal(n.length, 2, 'one per urgent todo + one per urgent open alert');
  assert.equal(n[0].t, 'Buy bright-team.com and 2 inboxes, then paste the logins');
  assert.equal(n[1].t, 'Shopping list unanswered for 14 h');
  n[0].go(); assert.equal(currentView, 'trialPurchase'); assert.equal(currentTrialId, 'bright-dental');
  assert.equal(trialsNavCount(), 2); assert.equal(trialsAlertCount(), 2);
  const ents = trialsCmdkEntities();
  assert.equal(ents.length, 5, '4 trials + aviance');
  assert.ok(ents.some((e) => e.kw.includes('trial:acme-plumbing') && e.label === 'Acme Plumbing'));
  assert.deepEqual(trialsCmdkActions().map((a) => a.label), ['New trial client', 'Trials board', 'Machine alerts']);
  trialsTodoAction('buy:bright-dental'); assert.equal(currentView, 'trialPurchase');
  trialsTodoAction('dispute:acme-plumbing:b1'); assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'acme-plumbing');
  authUser = { role: 'employee' };
  assert.ok(viewTrials().includes('Owner only')); assert.equal(trialsNotifs().length, 0);
  asOwner();
});

test('a failed refresh keeps the cached board and says so, instead of blanking the screen', async () => {
  trialsIngestHub(fullHub);
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'Unauthorized' }) });
  await loadHub(true);
  const html = trialsHostHTML('trials');
  assert.ok(html.includes("Couldn't refresh from the machine") && html.includes('Unauthorized'), 'stale banner with the reason');
  assert.ok(html.includes('Acme Plumbing'), 'cached board still shown');
  assert.equal(trialsHasData('trials'), true);
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(fullHub) });
  await loadHub(true);
  assert.ok(!trialsHostHTML('trials').includes("Couldn't refresh"), 'banner clears on the next good answer');
});

test('new-client modal posts the contract body, shows 400 {errors}, and opens the new trial', async () => {
  asOwner();
  openNewTrialClient({ companyName: 'Delta Roofing', contactName: 'Sam Ito', contactEmail: 'sam@delta.com', website: 'https://delta.com' });
  assert.ok(el('modal').innerHTML.includes('value="Delta Roofing"') && el('modal').innerHTML.includes('value="sam@delta.com"'));
  assert.ok(el('modalWrap').classList.contains('open'));
  el('ntCompany').value = 'Delta Roofing'; el('ntContact').value = 'Sam Ito'; el('ntEmail').value = 'sam@delta.com'; el('ntWebsite').value = 'https://delta.com'; el('ntOverride').checked = true;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); if (url.endsWith('/clients/new')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, clientId: 'delta-roofing', state: 'onboarding' }) }; return { ok: true, status: 200, text: async () => JSON.stringify(fullHub) }; };
  await submitNewTrialClient();
  assert.deepEqual(JSON.parse(calls[0].init.body), { companyName: 'Delta Roofing', contactName: 'Sam Ito', contactEmail: 'sam@delta.com', website: 'https://delta.com', override: true });
  assert.ok(!el('modalWrap').classList.contains('open'), 'modal closed');
  assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'delta-roofing');
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ ok: false, errors: { contactEmail: 'A valid email address is required.' } }) });
  openNewTrialClient(); el('ntCompany').value = 'X'; el('ntContact').value = 'Y'; el('ntEmail').value = 'z@z.zz'; el('ntWebsite').value = 'https://z.zz';
  await submitNewTrialClient();
  assert.ok(el('ntErr').innerHTML.includes('A valid email address is required.'));
  assert.ok(el('modalWrap').classList.contains('open'), 'modal stays open on errors');
  closeModal();
});

/* ───────────── application review (website applications) ───────────── */
test('application pending: shown above Systems with the fit check, every answer and the two buttons', () => {
  const html = renderTrialDetail(fernDetail, 'numbers', { now: NOW });
  const iApp = html.indexOf('id="tkSec-application"'), iTodo = html.indexOf('What you need to do'), iSys = html.indexOf('<h3>Systems</h3>');
  assert.ok(iApp > 0 && iApp < iTodo && iTodo < iSys, 'application section sits at the top, above the to-dos and Systems');
  assert.ok(html.includes('Waiting for your review'));
  assert.ok(html.includes('Looks like a fit — 3 checks unknown') && html.includes('Needs a look'), 'fit summary + verdict pill');
  for (const l of fernApplication.fit.lines) assert.ok(html.includes(esc(l.label)) && html.includes(esc(l.note)), 'fit line ' + l.rule);
  assert.equal((html.match(/class="pill green">Pass</g) || []).length, 3);
  assert.equal((html.match(/class="pill amber">Unknown</g) || []).length, 3);
  for (const x of fernApplication.answers) assert.ok(html.includes('<dt>' + esc(x.q) + '</dt>'), 'question ' + x.q);
  assert.ok(html.includes('Managed IT for dental and medical practices in Texas.'));
  assert.ok(html.includes('(no answer)'), 'an empty answer says so');
  assert.ok(html.includes('from the website') && html.includes('lee@fernit.com'));
  assert.ok(html.includes('Approve — send the onboarding link') && html.includes('Decline…'));
  assert.ok(!html.includes("trialsSetTab(&quot;application&quot;)"), 'no Application tab while pending');
});

test('application decided: an Application tab, no buttons, the decision in words', () => {
  const html = renderTrialDetail(detail, 'numbers', { now: NOW });
  assert.ok(!html.includes('id="tkSec-application"'), 'not at the top once decided');
  assert.ok(html.includes("trialsSetTab(&quot;application&quot;)"), 'Application tab offered');
  const tab = renderTab(detail, 'application');
  assert.ok(tab.includes('Approved') && tab.includes('the onboarding link went out'));
  assert.ok(!tab.includes('Approve — send the onboarding link') && !tab.includes('Decline…'));
  const declined = Object.assign({}, detail, { application: Object.assign({}, detail.application, { review: 'declined', decision: 'decline', declineReason: 'We only take companies with 5–50 people.' }) });
  const dt = renderTab(declined, 'application');
  assert.ok(dt.includes('Declined') && dt.includes('We only take companies with 5–50 people.'));
  assert.ok(renderTrialDetail(detail, 'application').includes('the onboarding link went out'), 'tab can be opened directly');
  assert.ok(!renderTrialDetail({ row: bright }, 'application').includes('tkSec-application'), 'no application → falls back to Numbers');
});

test('board: a client under review stands out with a "New application" marker', () => {
  const html = renderBoard(fullHub, { now: NOW });
  assert.ok(html.includes('class="tk-card review"') && html.includes('New application'));
  assert.equal((html.match(/New application/g) || []).length, 1, 'only the client under review');
  assert.ok(html.includes("Review Fern IT&#39;s trial application") || html.includes("Review Fern IT's trial application"), 'review to-do listed');
  assert.ok(html.includes('Applied — waiting for your review'));
});

test('the review to-do opens the trial scrolled to the Application section', () => {
  asOwner(); trialsIngestHub(fullHub);
  tk.detail['fern-it'] = fernDetail; tk.detailAt['fern-it'] = Date.now();
  let scrolled = 0; el('tkSec-application').scrollIntoView = () => { scrolled++; };
  trialsTodoAction('review:fern-it');
  assert.equal(currentView, 'trial'); assert.equal(currentTrialId, 'fern-it');
  assert.ok(el('content').innerHTML.includes('id="tkSec-application"'));
  assert.equal(scrolled, 1, 'scrolled to the section');
  assert.equal(tk.scrollTo, null, 'scroll request consumed');
});

test('approve: confirm names the client, posts approveApplication, toasts the outcome in plain words', async () => {
  asOwner(); trialsIngestHub(fullHub);
  tk.detail['fern-it'] = fernDetail; tk.detailAt['fern-it'] = Date.now(); currentTrialId = 'fern-it';
  let asked = ''; globalThis.confirm = (q) => { asked = q; return true; };
  const calls = [];
  const answer = (outcome) => async (url, init) => { calls.push({ url, init }); if (url.endsWith('/intake')) return { ok: true, status: 200, text: async () => JSON.stringify(outcome) }; return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('/hub/') ? fernDetail : fullHub) }; };
  globalThis.fetch = answer({ ok: true, outcome: 'queued', position: 2 });
  await trialApproveApplication('fern-it');
  assert.equal(asked, 'Send Fern IT the onboarding link now?');
  assert.ok(calls[0].url.endsWith('/api/mc/clients/fern-it/intake'));
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'approveApplication' });
  assert.ok(el('toast').innerHTML.includes('In the queue — position 2'));
  assert.ok(calls.some((c) => c.url.endsWith('/api/mc/hub')) && calls.some((c) => c.url.endsWith('/api/mc/hub/fern-it')), 'board and detail reloaded');
  globalThis.fetch = answer({ ok: true, outcome: 'onboarding' }); await trialApproveApplication('fern-it');
  assert.ok(el('toast').innerHTML.includes('Onboarding link sent'));
  globalThis.fetch = answer({ ok: true, outcome: 'declined' }); await trialApproveApplication('fern-it');
  assert.ok(el('toast').innerHTML.includes('already had a trial'));
  calls.length = 0; globalThis.confirm = () => false;
  await trialApproveApplication('fern-it');
  assert.equal(calls.length, 0, 'cancelled confirm sends nothing');
  globalThis.confirm = () => true;
});

test('decline: modal prefilled from the first failing rule, reason required, posts it and toasts', async () => {
  asOwner();
  const failing = JSON.parse(JSON.stringify(fernDetail));
  failing.application.fit.lines[1].status = 'fail'; failing.application.fit.lines[1].label = 'customer worth ≥ $2,000 in year one';
  tk.detail['fern-it'] = failing; tk.detailAt['fern-it'] = Date.now();
  openDeclineApplication('fern-it');
  const modal = el('modal').innerHTML;
  assert.ok(modal.includes("Decline Fern IT&#39;s application") || modal.includes("Decline Fern IT's application"));
  assert.ok(modal.includes("They'll get this reason by email."));
  assert.ok(modal.includes('>Customer worth ≥ $2,000 in year one.</textarea>'), 'first failing label, as a sentence');
  tk.detail['fern-it'] = fernDetail;
  assert.ok(renderDeclineModal(fernDetail).includes('"></textarea>'), 'no failing rule → empty box');
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); if (url.endsWith('/intake')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, outcome: 'declined' }) }; return { ok: true, status: 200, text: async () => JSON.stringify(fullHub) }; };
  el('tkDeclineReason').value = '   ';
  await submitDeclineApplication('fern-it');
  assert.equal(calls.length, 0, 'empty reason sends nothing');
  assert.ok(el('tkDeclineErr').innerHTML.includes('Write the reason first'));
  el('modalWrap').classList.add('open');
  el('tkDeclineReason').value = 'We only run trials for teams of 5–50 people.';
  await submitDeclineApplication('fern-it');
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'declineApplication', reason: 'We only run trials for teams of 5–50 people.' });
  assert.ok(el('toast').innerHTML.includes('Declined — email sent'));
  assert.ok(!el('modalWrap').classList.contains('open'), 'modal closed');
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'reason is required' }) });
  el('modalWrap').classList.add('open'); el('tkDeclineReason').value = 'x';
  await submitDeclineApplication('fern-it');
  assert.ok(el('tkDeclineErr').innerHTML.includes('reason is required'), 'machine 400 error shown in the modal');
  assert.ok(el('modalWrap').classList.contains('open'), 'modal stays open');
  closeModal();
});

/* ───────────── readability floor ───────────── */
const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
const shellCss = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const trialsJs = fs.readFileSync(path.join(root, 'trials.js'), 'utf8');
const varsIn = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
const rootVars = varsIn(shellCss.match(/:root\{[\s\S]*?\n\}/)[0]);
const darkVars = Object.assign({}, rootVars, varsIn(shellCss.match(/body\.dark\{[^}]*\}/)[0]));

test('readability: no font size below 13px anywhere (CSS, shell styles, inline styles in JS)', () => {
  const fs_ = Object.entries(rootVars).filter(([k]) => k.startsWith('fs-'));
  assert.ok(fs_.length >= 6, 'type scale tokens exist');
  for (const [k, v] of fs_) assert.ok(parseFloat(v) >= 13, `--${k} is ${v}`);
  const sources = { 'trials.css': css, 'index.html <style>': shellCss, 'index.html markup/script': html.slice(html.indexOf('</style>')), 'trials.js': trialsJs };
  let checked = 0;
  for (const [name, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/font-size:\s*([^;"'}]+)/g)) {
      const v = m[1].trim(); checked++;
      const tok = /^var\(--(fs-[\w-]+)\)$/.exec(v);
      if (tok) { assert.ok(rootVars[tok[1]], `${name}: unknown token ${v}`); assert.ok(parseFloat(rootVars[tok[1]]) >= 13, `${name}: ${v}`); continue; }
      assert.match(v, /^\d+(\.\d+)?px$/, `${name}: font-size must be a --fs-* token or px, got "${v}"`);
      assert.ok(parseFloat(v) >= 13, `${name}: font-size ${v} is below the 13px floor`);
    }
  }
  assert.ok(checked > 100, 'scanned the real rules (' + checked + ')');
  assert.ok(/body\{[^}]*font-size:var\(--fs-base\)/.test(shellCss) && rootVars['fs-base'] === '15px', 'body text is 15px');
});

test('readability: text colours pass WCAG AA (4.5:1) in light and dark, including pills', () => {
  const rgb = (c) => { c = c.replace('#', ''); if (c.length === 3) c = [...c].map((x) => x + x).join(''); return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const pairs = [['text', 'bg'], ['text', 'surface-2'], ['text', 'surface-3'], ['muted', 'bg'], ['muted', 'surface-2'], ['muted', 'surface-3'], ['muted-2', 'bg'], ['muted-2', 'surface-2'], ['muted-2', 'surface-3'],
    ['green', 'bg'], ['amber', 'bg'], ['red', 'bg'], ['blue', 'bg'], ['green', 'green-bg'], ['amber', 'amber-bg'], ['red', 'red-bg'], ['blue', 'blue-bg'], ['muted', 'blue-bg'],
    ['red', 'urgent-row'], ['muted', 'urgent-row'], ['text', 'urgent-row']];
  for (const [mode, v] of [['light', rootVars], ['dark', darkVars]]) {
    for (const [fg, bg] of pairs) {
      const r = ratio(v[fg], v[bg]);
      assert.ok(r >= 4.5, `${mode}: --${fg} (${v[fg]}) on --${bg} (${v[bg]}) is ${r.toFixed(2)}:1`);
    }
  }
  assert.ok(ratio('#FFFFFF', rootVars.red) >= 4.5 && ratio('#000000', darkVars.red) >= 4.5, 'bell count badge');
  for (const cls of ['green', 'amber', 'red', 'blue']) assert.ok(shellCss.includes(`.pill.${cls}{background:var(--${cls}-bg);color:var(--${cls})}`), `pill.${cls} uses the tested pair`);
  assert.ok(!/rgba\([^)]*\)[^;]*;?\s*color/.test(css.match(/\.pill\.tk-st[^\n]*/g).join('')), 'status pills use tokens, not rgba fills');
});

