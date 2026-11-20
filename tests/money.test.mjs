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
const cobalt = simpleRows.cobalt;   // Starter, stopped
const harbor = Object.assign({}, simpleRows.acme, { id: 'harbor-co', name: 'Harbor Co', plan: 'growth', simple: Object.assign({}, simpleRows.acme.simple, { company: 'Harbor Co', person: 'Pat Lee' }) });
const hub = Object.assign({}, fullHub, { stages: stagesWith({ live: [harbor], won: [cobalt] }) });
// the machine's month-one invoice (HUB-API.md `invoice` on GET /api/mc/hub/{id})
const cobaltDetail = Object.assign({}, detail, { row: cobalt, invoice: { number: 'AV-202609-cobalt', amount: 2497, issuedAt: '2026-09-02T10:00:00Z', paidAt: '2026-09-04T09:00:00Z', dueDate: '2026-09-02', plan: 'starter', status: 'paid' } });
const harborDetail = Object.assign({}, detail, { row: harbor, invoice: { number: 'AV-202610-harbor', amount: 3997, issuedAt: '2026-10-01T10:00:00Z', paidAt: '2026-10-03T09:00:00Z', plan: 'growth', status: 'paid' } });
const route = (map, calls) => async (url, init) => {
  const u = String(url).replace(/^https?:\/\/[^/]+/, ''); const method = (init && init.method) || 'GET';
  calls.push({ u, method, body: init && init.body ? JSON.parse(init.body) : null });
  const hit = map[method + ' ' + u] ?? map[u];
  if (hit === undefined) return { ok: false, status: 404, text: async () => '' };
  const [status, body] = Array.isArray(hit) ? hit : [200, hit];
  return { ok: status < 400, status, text: async () => JSON.stringify(typeof body === 'function' ? body() : body) };
};

/* ───────────── money on a client's Stats ───────────── */
test('Money card on a client\'s Stats: plan, each invoice (number, amount, issued, paid / not paid), total received — the owner only', () => {
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
  assert.ok(visibleText(renderMoneyCard(Object.assign({}, cobaltDetail, { invoice: null }))).includes('No invoice yet'));
  assert.ok(visibleText(renderMoneyCard(Object.assign({}, detail, { invoice: null }))).includes('Plan Starter') && !/trial/i.test(visibleText(renderMoneyCard(Object.assign({}, detail, { invoice: null })))), 'every client is on a plan');
  // under Only you › Money & plan (first), never on the shared Overview
  tk.growth['cobalt-hvac'] = { days: 45, at: Date.now(), data: { days: ['2026-10-01'], email: { sent: [40], replies: [1], bounces: [0] } } };
  const stats = renderClientStats(cobaltDetail, 'cobalt-hvac');
  assert.ok(stats.includes('Emails sent per day') && !stats.includes('tkMoney') && !stats.includes('$'), 'the shared Overview: no money');
  const money = renderSysTab(cobaltDetail, 'money', {});
  assert.ok(money.startsWith('<div class="card tk-money" id="tkMoney">') && visibleText(money).includes('Plan Starter plan'));
  delete tk.growth['cobalt-hvac'];
  assert.ok(!renderClientStats(cobaltDetail, 'cobalt-hvac').includes('tkMoney'));
  // the team: no money, one line saying why
  asEmployee(); document.body.classList.add('ro');
  assert.equal(renderMoneyCard(cobaltDetail), '');
  const em = renderSysTab(cobaltDetail, 'money', {});
  assert.ok(!em.includes('tkMoney"') && !em.includes('$') && visibleText(em).includes('Only the owner sees money.'));
  reset();
  // escaped
  assert.ok(!renderMoneyCard(Object.assign({}, cobaltDetail, { invoice: { number: '<b>x</b>', amount: 1 } })).includes('<b>x</b>'));
});

test('Clients: "Received this month · all time" above the stage tiles, paid invoices only, from the clients\' pages — the owner only', async () => {
  reset();
  tk.hub = hub; tk.hubAt = Date.now();
  // nothing counted yet → one quiet line, no made-up numbers
  let h = renderTrialList(hub, { now: MONTH_NOW }, true);
  assert.ok(h.includes('Counting the money received') && !h.includes('$'));
  // the pages come in: Cobalt paid $2,497 in September, Harbor $3,997 in October
  tk.detail['cobalt-hvac'] = cobaltDetail; tk.detail['harbor-co'] = harborDetail;
  h = renderTrialList(hub, { now: MONTH_NOW }, true);
  const line = between(h, '<div class="card tk-money-sum">', '<div class="tk-stages"');
  const t = visibleText(line);
  assert.ok(t.includes('Received this month $3,997') && t.includes('All time $6,494') && t.includes('2 paid invoices'), t);
  assert.ok(h.indexOf('tk-money-sum') < h.indexOf('tk-stages'), 'above the stage tiles');
  // an unpaid invoice adds nothing
  tk.detail['cobalt-hvac'] = Object.assign({}, cobaltDetail, { invoice: Object.assign({}, cobaltDetail.invoice, { paidAt: null, status: 'sent' }) });
  assert.ok(visibleText(renderTrialList(hub, { now: MONTH_NOW }, true)).includes('All time $3,997'));
  tk.detail['cobalt-hvac'] = cobaltDetail;
  // not for the team
  asEmployee(); assert.ok(!renderTrialList(hub, { now: MONTH_NOW }, true).includes('tk-money-sum')); reset();
  // opening Paying clients loads the pages it has not seen yet, once each
  tk.hub = hub; tk.hubAt = Date.now();
  const calls = [];
  globalThis.fetch = route({ '/api/mc/hub': hub, '/api/mc/hub/cobalt-hvac': cobaltDetail, '/api/mc/hub/harbor-co': harborDetail }, calls);
  try {
    render('paying'); for (let i = 0; i < 6; i++) await tick();
    const pages = calls.filter((c) => /^\/api\/mc\/hub\/[a-z-]+$/.test(c.u)).map((c) => c.u).sort();
    assert.deepEqual(pages, ['/api/mc/hub/cobalt-hvac', '/api/mc/hub/harbor-co'], 'each client once');
    assert.ok(visibleText(el('tkHost').innerHTML).includes('All time $6,494'));
    const n = calls.length; tkMoneyKick(); await tick();
    assert.equal(calls.length, n, 'not asked again');
    // the team never asks
    reset(); asEmployee(); tk.hub = hub; tk.hubAt = Date.now(); assert.equal(tkMoneyKick(), null);
  } finally { offline(); trialsStopTimer(); reset(); }
});

/* ───────────── Settings › Test run ───────────── */
/* ───────────── the "Test" tag ───────────── */
