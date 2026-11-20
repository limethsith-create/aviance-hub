/* Tests for the stage strip (stages.js): seven stages in order, counts from clients and bookings, a tap opens the people. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleRows, simpleHub, stagesWith } from "./fixtures.mjs";

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
const FILES = ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'warmup.js', 'keys.js', 'people.js', 'stages.js'];
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


const mk = (id, step, state, name) => { const r = clone(simpleRows.acme); r.id = id; r.name = name; r.state = state; r.simple.step = step; r.simple.company = name; return r; };
const rows = [mk('c1', 'accepted', 'onboarding', 'On One'), mk('c2', 'call_booked', 'onboarding', 'On Two'), mk('c3', 'setting_up', 'setup_check', 'Set Up'), mk('c4', 'warming_up', 'warming', 'Warm'),
  mk('c5', 'sending', 'sending', 'Send A'), mk('c6', 'sending', 'sending', 'Send B <b>'), mk('c7', 'finished', 'retired', 'Done Co'), mk('c8', 'sending', 'paused', 'Pause Co'), mk('c9', 'declined', 'declined', 'Not Taken')];
const hub = { stages: stagesWith({ live: rows }), machine: {} };
const bookings = [{ id: 'b1', status: 'new', company: 'Bk New' }, { id: 'b2', status: 'held', company: 'Bk Held' }, { id: 'b3', status: 'contacted', company: 'Bk Contacted' }, { id: 'b4', status: 'no_show', company: 'Bk No' },
  { id: 'b5', status: 'agreement_sent', company: 'Bk Pay' }, { id: 'b6', status: 'proposal_sent', company: 'Bk Old Pay' }, { id: 'b7', status: 'won', company: 'Won' }, { id: 'b8', status: 'lost', company: 'Lost' }];

test('the strip has the seven stages in order', () => {
  const h = renderStageStrip(hub, bookings);
  const labels = [...h.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Discovery calls', 'Waiting to pay', 'Onboarding', 'Setting up', 'Warming up', 'Sending', 'Paused']);
  assert.equal((h.match(/onclick="openStage\('/g) || []).length, 7);
});

test('counts: bookings by status, clients by step', () => {
  assert.deepEqual(stageCounts(hub, bookings), { discovery: 4, waiting_pay: 2, onboarding: 2, setting_up: 1, warming: 1, sending: 2, paused: 2 });
  assert.equal(stageOfBooking({ status: 'won' }), null);
  assert.equal(stageOfBooking({ status: 'lost' }), null);
  assert.equal(stageOfClient(rows[8]), null, 'not taken is nowhere');
});

test('empty hub and no bookings: all zero, still seven tiles', () => {
  const h = renderStageStrip(null, null);
  assert.equal((h.match(/<b>0<\/b>/g) || []).length, 7);
});

test('openStage lists the people, escaped, and each opens the right page', () => {
  tk.hub = hub; iq.list = bookings;
  let shown = ''; globalThis.openModal = (x) => { shown = x; };
  openStage('sending');
  assert.ok(shown.includes('Sending') && shown.includes('Send A') && shown.includes('Send B &lt;b&gt;') && !shown.includes('<b>Send B <b>'));
  openStage('discovery');
  assert.ok(shown.includes('Bk New') && shown.includes('Bk No') && !shown.includes('Won'));
  openStage('paused'); assert.ok(shown.includes('Done Co') && shown.includes('Pause Co'));
  openStage('warming'); const emptyHub = tk.hub; tk.hub = { stages: [] }; openStage('warming'); assert.ok(shown.includes('Nobody here')); tk.hub = emptyHub;
  const calls = []; globalThis.openInquiry = (id) => calls.push(['inq', id]); globalThis.openTrial = (id) => calls.push(['trial', id]);
  stageGo('booking', 'b1'); stageGo('client', 'c1');
  assert.deepEqual(calls, [['inq', 'b1'], ['trial', 'c1']]);
});
