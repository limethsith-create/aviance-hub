/* Tests for money (a client's Stats and the Paying list) and the test run (Settings › Test run, the "Test" tag).
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
import { simpleRows, stagesWith, fullHub, detail } from './fixtures.mjs';

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
const asEmployee = () => { authUser = { uid: 'u9', name: 'Nimal', role: 'employee', email: 'nimal@example.com' }; };
const reset = () => { asOwner(); trialsForget(); calendarForget(); asOwner(); document.body._classes.clear(); };

/* ───────────── fixtures: one real paying client, one made-up (test run) paying client, one made-up trial ───────────── */
const MONTH_NOW = new Date('2026-10-17T12:00:00Z');
const cobalt = simpleRows.cobalt;   // Starter, converted
const demoPay = Object.assign({}, simpleRows.acme, { id: 'demo-paying', name: 'Harbor Test Co', plan: 'growth', demo: true, simple: Object.assign({}, simpleRows.acme.simple, { company: 'Harbor Test Co', person: 'Pat Demo' }) });
const demoTrial = Object.assign({}, simpleRows.acme, { id: 'demo-trial', name: 'Maple Test Ltd', demo: true, simple: Object.assign({}, simpleRows.acme.simple, { company: 'Maple Test Ltd', person: 'Tom Demo' }) });
const hub = Object.assign({}, fullHub, { stages: stagesWith({ live: [simpleRows.acme, demoTrial, demoPay], won: [cobalt] }) });
// the machine's month-one invoice (HUB-API.md `invoice` on GET /api/mc/hub/{id})
const cobaltDetail = Object.assign({}, detail, { row: cobalt, invoice: { number: 'AV-202609-cobalt', amount: 2497, issuedAt: '2026-09-02T10:00:00Z', paidAt: '2026-09-04T09:00:00Z', dueDate: '2026-09-02', plan: 'starter', status: 'paid' } });
const demoDetail = Object.assign({}, detail, { row: demoPay, invoice: { number: 'AV-202610-demo', amount: 3997, issuedAt: '2026-10-01T10:00:00Z', paidAt: '2026-10-03T09:00:00Z', plan: 'growth', status: 'paid' } });
const route = (map, calls) => async (url, init) => {
  const u = String(url).replace(/^https?:\/\/[^/]+/, ''); const method = (init && init.method) || 'GET';
  calls.push({ u, method, body: init && init.body ? JSON.parse(init.body) : null });
  const hit = map[method + ' ' + u] ?? map[u];
  if (hit === undefined) return { ok: false, status: 404, text: async () => '' };
  const [status, body] = Array.isArray(hit) ? hit : [200, hit];
  return { ok: status < 400, status, text: async () => JSON.stringify(typeof body === 'function' ? body() : body) };
};

/* ───────────── money on a client's Stats ───────────── */
test('Money card on a client\'s Stats: plan, each invoice (number, amount, issued, paid / not paid), total received — the owner only, never on My stats', () => {
  reset();
  const card = renderMoneyCard(cobaltDetail);
  const t = visibleText(card);
  for (const w of ['Money', 'Plan Starter', 'Received from them $2,497', 'AV-202609-cobalt', '$2,497', '2 Sep', 'Paid 4 Sep']) assert.ok(t.includes(w), w);
  assert.ok(card.includes('<table class="tk-table tk-money-table">'));
  // an unpaid invoice (and a later one, when the machine keeps a list): only paid money counts
  const two = Object.assign({}, cobaltDetail, { invoices: [cobaltDetail.invoice, { number: 'AV-202610-cobalt', amount: 2497, issuedAt: '2026-10-02T10:00:00Z', paidAt: null, status: 'sent' }] });
  const t2 = visibleText(renderMoneyCard(two));
  assert.ok(t2.includes('Received from them $2,497') && t2.includes('AV-202610-cobalt') && t2.includes('Not paid yet'));
  assert.ok(t2.indexOf('AV-202609-cobalt') < t2.indexOf('AV-202610-cobalt'), 'oldest first');
  assert.ok(visibleText(renderMoneyCard(Object.assign({}, cobaltDetail, { invoice: { number: 'AV-1', amount: 2497, status: 'blocked' } }))).includes('Not sent yet'));
  assert.ok(visibleText(renderMoneyCard(Object.assign({}, cobaltDetail, { invoice: null }))).includes('No invoice yet.'));
  assert.ok(visibleText(renderMoneyCard(Object.assign({}, detail, { invoice: null }))).includes('Plan Free trial'));
  // on the Stats pane, right under the four numbers
  tk.growth['cobalt-hvac'] = { days: 45, at: Date.now(), data: { days: ['2026-10-01'], email: { sent: [40], replies: [1], bounces: [0] } } };
  const stats = renderClientStats(cobaltDetail, 'cobalt-hvac');
  assert.ok(stats.includes('id="tkMoney"') && stats.indexOf('tk-keys tk-keys4') < stats.indexOf('id="tkMoney"') && stats.indexOf('id="tkMoney"') < stats.indexOf('Emails sent per day'));
  // still loading the emails: the money shows anyway
  delete tk.growth['cobalt-hvac'];
  assert.ok(renderClientStats(cobaltDetail, 'cobalt-hvac').includes('id="tkMoney"'));
  // My stats (the owner's own sending) and the team: no money
  assert.ok(!renderClientStats(Object.assign({}, cobaltDetail, { row: { id: 'aviance', name: 'Aviance' } }), 'aviance').includes('tkMoney'));
  asEmployee(); document.body.classList.add('ro');
  assert.equal(renderMoneyCard(cobaltDetail), '');
  assert.ok(!renderClientStats(cobaltDetail, 'cobalt-hvac').includes('tkMoney'));
  reset();
  // escaped
  assert.ok(!renderMoneyCard(Object.assign({}, cobaltDetail, { invoice: { number: '<b>x</b>', amount: 1 } })).includes('<b>x</b>'));
});

test('Paying clients: "Received this month · all time" above the stage tiles, paid invoices only, from the clients\' pages — the owner only', async () => {
  reset();
  tk.hub = hub; tk.hubAt = Date.now();
  // nothing counted yet → one quiet line, no made-up numbers
  let h = renderTrialList(hub, { now: MONTH_NOW }, true);
  assert.ok(h.includes('Counting the money received') && !h.includes('$'));
  // the pages come in: Cobalt paid $2,497 in September, the test client $3,997 in October
  tk.detail['cobalt-hvac'] = cobaltDetail; tk.detail['demo-paying'] = demoDetail;
  h = renderTrialList(hub, { now: MONTH_NOW }, true);
  const line = between(h, '<div class="card tk-money-sum">', '<div class="tk-stages"');
  const t = visibleText(line);
  assert.ok(t.includes('Received this month $3,997') && t.includes('All time $6,494') && t.includes('2 paid invoices') && t.includes('includes $3,997 from the test run'), t);
  assert.ok(h.indexOf('tk-money-sum') < h.indexOf('tk-stages'), 'above the stage tiles');
  // an unpaid invoice adds nothing
  tk.detail['cobalt-hvac'] = Object.assign({}, cobaltDetail, { invoice: Object.assign({}, cobaltDetail.invoice, { paidAt: null, status: 'sent' }) });
  assert.ok(visibleText(renderTrialList(hub, { now: MONTH_NOW }, true)).includes('All time $3,997'));
  tk.detail['cobalt-hvac'] = cobaltDetail;
  // not on Trials; not for the team
  assert.ok(!renderTrialList(hub, { now: MONTH_NOW }).includes('tk-money-sum'));
  asEmployee(); assert.ok(!renderTrialList(hub, { now: MONTH_NOW }, true).includes('tk-money-sum')); reset();
  // opening Paying clients loads the pages it has not seen yet, once each
  tk.hub = hub; tk.hubAt = Date.now();
  const calls = [];
  globalThis.fetch = route({ '/api/mc/hub': hub, '/api/mc/hub/cobalt-hvac': cobaltDetail, '/api/mc/hub/demo-paying': demoDetail }, calls);
  try {
    render('paying'); for (let i = 0; i < 6; i++) await tick();
    const pages = calls.filter((c) => /^\/api\/mc\/hub\/[a-z-]+$/.test(c.u)).map((c) => c.u).sort();
    assert.deepEqual(pages, ['/api/mc/hub/cobalt-hvac', '/api/mc/hub/demo-paying'], 'the paying clients only');
    assert.ok(visibleText(el('tkHost').innerHTML).includes('All time $6,494'));
    const n = calls.length; tkMoneyKick(); await tick();
    assert.equal(calls.length, n, 'not asked again');
    // the team never asks
    reset(); asEmployee(); tk.hub = hub; tk.hubAt = Date.now(); assert.equal(tkMoneyKick(), null);
  } finally { offline(); trialsStopTimer(); reset(); }
});

/* ───────────── Settings › Test run ───────────── */
test('Settings › Test run: says what it is, whether it is loaded; Load / Remove the test run (with a question first), then Trials; a system without it says so kindly', async () => {
  reset();
  const R = (st) => renderDemoSet(st);
  const loading = R(undefined);
  assert.ok(visibleText(loading.body).includes('Two made-up clients — a trial and a paying client — who went through everything: applying, your yes, the calls, inbox setup, warm-up, a month of sending, replies and the reply bot, and payment. No real emails are sent.'));
  const off = R({ data: { loaded: false, ids: [], at: null } });
  assert.equal(off.state, '<span class="pill grey">Not loaded</span>');
  assert.ok(off.body.includes('onclick="demoAction(\'load\')">Load the test run</button>') && !off.body.includes('Remove the test run'));
  const on = R({ data: { loaded: true, ids: ['demo-trial', 'demo-paying'], at: '2026-10-17T10:00:00Z' } });
  assert.equal(on.state, '<span class="pill green">Loaded</span>');
  assert.ok(on.body.includes('>Remove the test run</button>') && !on.body.includes('Load the test run') && visibleText(on.body).includes('2 made-up clients'));
  const missing = R({ missing: true });
  assert.ok(missing.state.includes('Not available yet') && visibleText(missing.body).includes("Your system hasn't been updated for the test run yet"));
  assert.ok(!missing.body.includes('<button'));
  // in Settings, between Reply bot and Is everything running?
  const s = renderSettings({ hub: fullHub, open: { demo: true }, demo: { data: { loaded: false, ids: [] } } });
  assert.ok(s.includes('<details class="tk-set" id="tkSet-demo" open') && s.indexOf('id="tkSet-replybot"') < s.indexOf('id="tkSet-demo"') && s.indexOf('id="tkSet-demo"') < s.indexOf('id="tkSet-status"'));
  assert.ok(TK_SETTINGS.includes('demo') && TK_SETTINGS_NAMES.demo === 'Test run');

  // load: a question, POST {action:'load'}, the hub reloaded, then Trials
  const calls = []; let loaded = false; const asked = [];
  globalThis.confirm = (q) => { asked.push(q); return true; };
  globalThis.fetch = route({
    'GET /api/mc/demo': () => ({ loaded, ids: loaded ? ['demo-trial', 'demo-paying'] : [], at: loaded ? '2026-10-17T10:00:00Z' : null }),
    'POST /api/mc/demo': () => { const b = calls[calls.length - 1].body; loaded = b.action === 'load'; return b.action === 'load' ? { ok: true, ids: ['demo-trial', 'demo-paying'] } : { ok: true, removed: ['demo-trial', 'demo-paying'] }; },
    '/api/mc/hub': () => (loaded ? hub : fullHub), '/api/mc/alerts': { alerts: [] },
  }, calls);
  try {
    render('settings'); await tick(); await tick();
    assert.ok(calls.some((c) => c.u === '/api/mc/demo' && c.method === 'GET'), 'Settings asks whether it is loaded');
    assert.equal(tk.demo.data.loaded, false);
    await demoAction('load');
    assert.ok(/Load the test run\? .*No real emails are sent\./.test(asked[0]));
    assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.u === '/api/mc/demo').map((c) => c.body), [{ action: 'load' }]);
    const after1 = calls.slice(calls.findIndex((c) => c.method === 'POST' && c.u === '/api/mc/demo'));
    assert.ok(after1.some((c) => c.u === '/api/mc/hub') && after1.some((c) => c.u === '/api/mc/demo' && c.method === 'GET'), 'the hub and the test run asked again');
    assert.equal(currentView, 'trials'); assert.equal(tk.demo.data.loaded, true);
    assert.ok(el('tkHost').innerHTML.includes('Maple Test Ltd</span><span class="pill tk-test"'), 'the made-up trial shows, tagged');
    // remove: "no" → nothing sent
    globalThis.confirm = (q) => { asked.push(q); return false; };
    const posts = () => calls.filter((c) => c.method === 'POST' && c.u === '/api/mc/demo').length; const n = posts(); await demoAction('remove'); assert.equal(posts(), n, 'no → nothing sent');
    assert.ok(/^Remove the test run\?/.test(asked[asked.length - 1]));
    // remove: yes → POST {action:'remove'}, their pages forgotten, Trials without them
    globalThis.confirm = () => true; tk.detail['demo-paying'] = demoDetail;
    await demoAction('remove');
    assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.u === '/api/mc/demo').map((c) => c.body), [{ action: 'load' }, { action: 'remove' }]);
    assert.equal(tk.detail['demo-paying'], undefined);
    assert.equal(currentView, 'trials'); assert.equal(tk.demo.data.loaded, false);
    assert.ok(!el('tkHost').innerHTML.includes('Maple Test Ltd'));
    // a system without the test run (404): a kind line, no error page
    globalThis.fetch = route({}, calls); trialsForget(); asOwner();
    render('settings'); await tick(); await tick();
    assert.equal(tk.demo.missing, true);
    tk.setOpen.demo = true; trialsRepaint('settings');
    assert.ok(visibleText(el('tkHost').innerHTML).includes("Your system hasn't been updated for the test run yet"));
    tk.demo.missing = false; tk.demo.data = { loaded: false, ids: [] };
    await demoAction('load');
    assert.equal(tk.demo.missing, true); assert.equal(currentView, 'settings', 'stays in Settings');
  } finally { offline(); trialsStopTimer(); reset(); }
});

/* ───────────── the "Test" tag ───────────── */
test('the "Test" tag: next to a made-up client\'s name on Trials, Paying clients, their page, Behind the scenes, Team and the Calendar — never on real clients', () => {
  reset();
  tk.hub = hub; tk.hubAt = Date.now();
  const PILL = '<span class="pill tk-test" title="A made-up client from the test run">Test</span>';
  const trials = renderTrialList(hub, { now: MONTH_NOW });
  assert.ok(trials.includes('Maple Test Ltd</span>' + PILL));
  assert.ok(!trials.includes('Acme Plumbing</span>' + PILL) && !trials.includes('Acme Plumbing</span><span class="pill tk-test"'));
  const paying = renderTrialList(hub, { now: MONTH_NOW }, true);
  assert.ok(paying.includes('Harbor Test Co</span>' + PILL) && !paying.includes('Cobalt HVAC</span><span class="pill tk-test"'));
  assert.equal(count(paying, /tk-test"/g), 1);
  // a made-up application waiting for a yes
  const app = Object.assign({}, simpleRows.fern, { demo: true });
  assert.ok(renderApplicationRow(app).includes(PILL) && !renderApplicationRow(simpleRows.fern).includes('tk-test'));
  // their page: a line at the top, and the tag beside the title
  const top = renderTrialTop(demoDetail, { now: MONTH_NOW });
  assert.ok(top.includes('<p class="tk-top-test">' + PILL) && visibleText(top).includes('A made-up client from the test run. No real emails go out.'));
  assert.ok(!renderTrialTop(cobaltDetail, { now: MONTH_NOW }).includes('tk-test'));
  tk.detail['demo-paying'] = demoDetail; currentTrialId = 'demo-paying'; currentView = 'trial';
  const title = el('ptitle'); title.insertAdjacentHTML = (where, h) => { title.textContent += h; };
  trialsTitle(); assert.equal(title.textContent, 'Harbor Test Co ' + PILL);
  // Behind the scenes (the board cards)
  assert.ok(renderTrialCard(demoPay).includes('<b>Harbor Test Co</b>' + PILL) && !renderTrialCard(cobalt).includes('tk-test'));
  // Team: the chips and the "choose clients" list
  assert.ok(teamClients().find((c) => c.id === 'demo-trial').demo === true && teamClients().find((c) => c.id === 'cobalt-hvac').demo === false);
  assert.ok(teamTestPill({ id: 'demo-paying' }).includes('Test') && teamTestPill({ id: 'cobalt-hvac' }) === '');
  tm.data = { team: [{ uid: 'u9', name: 'Nimal', role: 'employee', online: true, clients: [{ id: 'demo-paying', name: 'Harbor Test Co' }, { id: 'cobalt-hvac', name: 'Cobalt HVAC' }] }], owners: { 'demo-paying': ['u9'], 'cobalt-hvac': ['u9'] } };
  const team = renderTeam();
  assert.ok(team.includes('Harbor Test Co <span class="pill tk-test">Test</span></button>') && team.includes('Cobalt HVAC</button>'));
  assert.ok(team.includes('Maple Test Ltd <span class="pill tk-test">Test</span></button>'), 'nobody looks after it yet: tagged there too');
  tm.data = null;
  // Calendar: a call with a made-up client
  assert.ok(calTestTag({ clientId: 'demo-trial', company: 'Maple Test Ltd' }).includes('Test') && calTestTag({ clientId: 'acme-plumbing' }) === '' && calTestTag({ demo: true }).includes('Test') && calTestTag({}) === '');
  reset();
});
