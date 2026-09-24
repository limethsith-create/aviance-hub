/* Tests for trials.js — run with:  npm test   (= node --test tests/*.test.mjs)
   trials.js is a plain browser script, so we load it into this process with a
   tiny fake DOM and the hub globals it touches, then call the pure render
   functions with data shaped exactly like docs/HUB-API.md. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, acme, bright, stagesWith, fullHub, emptyHub, detail } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ───────────── fake DOM + hub globals ───────────── */
const elements = {};
function fakeEl(id) {
  return { id, value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() {}, select() {}, submit() {} };
}
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: { appendChild() {} }, getElementById: (id) => elements[id] || null, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true }); // getter-only in Node 21+
globalThis.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
globalThis.kpi = (label, val) => `<div class="kpi">${label}:${val}</div>`;
globalThis.emptyState = (icon, title, sub) => `<div class="card"><div class="empty">${icon}<h3>${title}</h3><p>${sub}</p></div></div>`;
const toasts = []; globalThis.toast = (m) => toasts.push(m);
globalThis.openModal = (html) => { globalThis.__modal = html; }; globalThis.closeModal = () => {};
const renders = []; globalThis.render = (v) => { renders.push(v); globalThis.currentView = v; };
globalThis.renderNav = () => {}; globalThis.updateNotifBadge = () => {}; globalThis.closeCmdk = () => {};
globalThis.I = { grid: '<svg data-i="grid"></svg>', trials: '<svg data-i="trials"></svg>', bell: '<svg data-i="bell"></svg>' };
globalThis.sb = { auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) } };
globalThis.MACHINE_URL = 'https://machine.test';
globalThis.authUser = { role: 'admin', email: 'owner@example.com' };
globalThis.currentView = 'trials'; globalThis.currentRole = 'admin';
globalThis.leads = []; globalThis.clients = []; globalThis.saveDB = () => {}; globalThis.todayShort = () => 'Sep 25';
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
globalThis.confirm = () => true; globalThis.prompt = () => 'a reason';

vm.runInThisContext(fs.readFileSync(path.join(here, '..', 'trials.js'), 'utf8'), { filename: 'trials.js' });

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
  // Bright Dental has five:null → dashes, never zeros
  const cardStart = html.indexOf('class="tk-card" onclick="openTrial(&quot;bright-dental&quot;)"');
  assert.ok(cardStart > 0, 'Bright Dental card present');
  const brightCard = html.slice(cardStart, html.indexOf('</div>\n  </div>', cardStart) + 1);
  assert.ok(brightCard.includes('<b>—</b>'), 'null five renders as —');
  assert.ok(brightCard.includes('Inbox rate —'));
  // urgent todo sorted first
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
  // numbers tab
  assert.ok(html.includes('>230<') && html.includes('interested · 4') && html.includes('unsent · 380') && html.includes('Pace checks'));
  // every other tab renders and carries its key strings
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
  // timeline is newest first
  const tl = renderTab(detail, 'timeline');
  assert.ok(tl.indexOf('sent') < tl.indexOf('dispute_opened'), 'newest event first');
  // paused client offers Resume
  assert.ok(renderTab(Object.assign({}, detail, { row: Object.assign({}, acme, { state: 'paused' }) }), 'actions').includes('Resume sending'));
  // no send hold → no clear button
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
test('machine unreachable: loadHub records the reason and the view shows one clear card', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const r = await loadHub(true);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('Could not reach the machine at https://machine.test'));
  const html = trialsHostHTML('trials');
  assert.ok(html.includes("The machine isn't reachable from the hub yet"));
  assert.ok(html.includes('Could not reach the machine') && html.includes('Try again'));
  assert.ok(renderMachineError('CORS said no').includes('CORS said no'));
  assert.ok(trialsHealthCard().includes('machine unreachable'));
});

test('machineFetch: bearer token, JSON bodies, 401/503/non-JSON/ok:false handling', async () => {
  const calls = [];
  const respond = (status, body, isJson = true) => async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, text: async () => (isJson ? JSON.stringify(body) : body) }; };
  globalThis.fetch = respond(200, { ok: true, clientId: 'x' });
  let r = await machineFetch('/api/mc/clients/new', { body: { companyName: 'Acme' } });
  assert.equal(r.ok, true); assert.equal(r.data.clientId, 'x');
  assert.equal(calls[0].url, 'https://machine.test/api/mc/clients/new');
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
  const savedSb = globalThis.sb; globalThis.sb = { auth: { getSession: async () => ({ data: { session: null } }) } };
  r = await machineFetch('/api/mc/hub'); assert.equal(r.ok, false); assert.ok(r.error.includes('not signed in'));
  globalThis.sb = savedSb;
});

/* ───────────── hub integration ───────────── */
test('notifications, nav counts, ⌘K, health card, client line come from the cached hub data', () => {
  trialsIngestHub(fullHub);
  const n = trialsNotifs();
  assert.equal(n.length, 2, 'one per urgent todo + one per urgent open alert');
  assert.equal(n[0].t, 'Buy bright-team.com and 2 inboxes, then paste the logins');
  assert.equal(n[1].t, 'Shopping list unanswered for 14 h');
  n[0].go(); assert.equal(renders.at(-1), 'trialPurchase'); assert.equal(currentTrialId, 'bright-dental');
  assert.equal(trialsNavCount(), 2); assert.equal(trialsAlertCount(), 2);
  const ents = trialsCmdkEntities();
  assert.equal(ents.length, 4, '3 trials + aviance');
  assert.ok(ents.some((e) => e.kw.includes('trial:acme-plumbing') && e.label === 'Acme Plumbing'));
  assert.ok(trialsCmdkActions().map((a) => a.label).join(',').includes('New trial client,Trials board,Machine alerts'));
  const card = trialsHealthCard();
  assert.ok(card.includes('>2<') && card.includes('1 green · 1 yellow · 1 red · 3 to-dos'));
  assert.ok(card.includes('--hc:#E0290F'), 'red when any trial is red');
  assert.ok(trialLineForName('ACME plumbing').includes('Trial: Sending — Day 12 of 30'), 'case-insensitive name match');
  assert.equal(trialLineForName('Nobody Inc'), '');
  // todo action routing
  trialsTodoAction('buy:bright-dental'); assert.equal(renders.at(-1), 'trialPurchase');
  trialsTodoAction('dispute:acme-plumbing:b1'); assert.equal(renders.at(-1), 'trial'); assert.equal(currentTrialId, 'acme-plumbing');
  // employees never see it
  const saved = globalThis.authUser; globalThis.authUser = { role: 'employee' };
  assert.ok(viewTrials().includes('Admins only')); assert.equal(trialsNotifs().length, 0);
  globalThis.authUser = saved;
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

test('new-client modal prefills from a CRM lead and posts the contract body', async () => {
  globalThis.leads = [{ id: 7, company: 'Delta Roofing', contact: 'Sam Ito', email: 'sam@delta.com', history: [] }];
  trialStartFromLead(7);
  assert.ok(globalThis.__modal.includes('value="Delta Roofing"') && globalThis.__modal.includes('value="sam@delta.com"'));
  elements.ntCompany = Object.assign(fakeEl('ntCompany'), { value: 'Delta Roofing' });
  elements.ntContact = Object.assign(fakeEl('ntContact'), { value: 'Sam Ito' });
  elements.ntEmail = Object.assign(fakeEl('ntEmail'), { value: 'sam@delta.com' });
  elements.ntWebsite = Object.assign(fakeEl('ntWebsite'), { value: 'https://delta.com' });
  elements.ntOverride = Object.assign(fakeEl('ntOverride'), { checked: true });
  elements.ntErr = fakeEl('ntErr');
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); if (url.endsWith('/clients/new')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, clientId: 'delta-roofing', state: 'onboarding' }) }; return { ok: true, status: 200, text: async () => JSON.stringify(fullHub) }; };
  await submitNewTrialClient();
  assert.deepEqual(JSON.parse(calls[0].init.body), { companyName: 'Delta Roofing', contactName: 'Sam Ito', contactEmail: 'sam@delta.com', website: 'https://delta.com', override: true });
  assert.equal(globalThis.leads[0].history.at(-1).text, 'Trial started: delta-roofing', 'lead gets a note, stage untouched');
  assert.equal(globalThis.leads[0].stage, undefined);
  assert.equal(renders.at(-1), 'trial'); assert.equal(currentTrialId, 'delta-roofing');
  // 400 {errors} shows them in the modal instead of closing
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ ok: false, errors: { contactEmail: 'A valid email address is required.' } }) });
  elements.ntEmail.value = 'sam@delta.com';
  await submitNewTrialClient();
  assert.ok(elements.ntErr.innerHTML.includes('A valid email address is required.'));
});
