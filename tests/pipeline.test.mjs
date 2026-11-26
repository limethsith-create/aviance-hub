/* Tests for our own sales pipeline (pipeline.js): the bookings from the website, the research
   engine's briefs (read, never written here), and the won / lost outcome. There is no Bookings
   screen: the Calendar draws every booking and opens its panel (tests/meetings.test.mjs).
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Same set-up as the other tests: the shell's inline script in a tiny fake DOM, then
   pipeline.js exactly as the browser would load it. No network at all — `sb` is a small
   in-memory Supabase stand-in, so every query pipeline.js writes really runs. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM (as in stages.test.mjs) ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, open: false, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() {}, select() {}, submit() {}, addEventListener() {}, scrollIntoView() {}, closest() { return null; }, getAttribute() { return null; }, setAttribute() {} };
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
globalThis.addEventListener = () => {};

/* ───────────── the database: small, real enough, in memory ─────────────
   Every chain pipeline.js builds (select/insert/update + eq/in/gte/lte/order/limit and
   maybeSingle/single/await) runs against these tables. `queries` records them so a test
   can prove where a number came from. */
const db = { discovery_bookings: [], research_briefs: [], research_log: [], plan_prices: [], clients: [] };
const queries = [];
let failTable = null;          // make one table answer with an error
let nextId = 1;

function matches(row, filters) {
  return filters.every((f) => {
    const v = row[f.col];
    if (f.kind === 'eq') return String(v) === String(f.val);
    if (f.kind === 'in') return (f.val || []).map(String).includes(String(v));
    if (f.kind === 'gte') return String(v) >= String(f.val);
    if (f.kind === 'lte') return String(v) <= String(f.val);
    if (f.kind === 'lt') return String(v) < String(f.val);
    return true;
  });
}
function run(q) {
  queries.push({ table: q.table, op: q.op, filters: q.filters.slice(), patch: q.patch, row: q.row, order: q.order });
  if (failTable && q.table === failTable) return { data: null, error: { message: 'The database said no.' } };
  const table = (db[q.table] ||= []);
  if (q.op === 'insert') {
    const row = Object.assign({ id: 'row-' + nextId++, created_at: new Date().toISOString() }, q.row);
    table.push(row);
    return { data: [row], error: null };
  }
  let hit = table.filter((r) => matches(r, q.filters));
  if (q.op === 'update') {
    hit.forEach((r) => Object.assign(r, q.patch));
    return { data: hit.slice(), error: null };
  }
  if (q.order) {
    const { col, ascending } = q.order;
    hit = hit.slice().sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : String(a[col] ?? '') > String(b[col] ?? '') ? 1 : 0));
    if (ascending === false) hit.reverse();
  }
  if (q.limit != null) hit = hit.slice(0, q.limit);
  return { data: hit, error: null };
}
function builder(table) {
  const q = { table, op: 'select', filters: [], order: null, limit: null, patch: null, row: null };
  const api = {
    select() { return api; },
    insert(row) { q.op = 'insert'; q.row = row; return api; },
    update(patch) { q.op = 'update'; q.patch = patch; return api; },
    eq(col, val) { q.filters.push({ kind: 'eq', col, val }); return api; },
    in(col, val) { q.filters.push({ kind: 'in', col, val }); return api; },
    gte(col, val) { q.filters.push({ kind: 'gte', col, val }); return api; },
    lte(col, val) { q.filters.push({ kind: 'lte', col, val }); return api; },
    lt(col, val) { q.filters.push({ kind: 'lt', col, val }); return api; },
    order(col, opts) { q.order = { col, ascending: !opts || opts.ascending !== false }; return api; },
    limit(n) { q.limit = n; return api; },
    async maybeSingle() { const r = run(q); return r.error ? r : { data: (r.data || [])[0] || null, error: null }; },
    async single() { const r = run(q); if (r.error) return r; const one = (r.data || [])[0]; return one ? { data: one, error: null } : { data: null, error: { message: 'Nothing came back.' } }; },
    then(res, rej) { return Promise.resolve(run(q)).then(res, rej); },
  };
  return api;
}
/* The database's close_won rule, small and in memory: one client per booking, the plan's
   own numbers, the booking marked won. Its refusal is the real one's words. */
const rpcs = [];
let rpcFail = null;
function closeWon(a) {
  const b = (dbRows('discovery_bookings')).find((r) => String(r.id) === String(a.p_booking));
  if (!b) return { data: null, error: { message: 'That call is not here any more.' } };
  if (dbRows('clients').some((c) => String(c.booking_id) === String(b.id))) return { data: null, error: { message: 'That call is already a client.' } };
  const p = dbRows('plan_prices').find((x) => x.plan === a.p_plan);
  if (!p) return { data: null, error: { message: 'That plan is not in the price list.' } };
  const term = a.p_term === '3month' ? '3month' : 'monthly';
  const c = { id: 'cl-' + (dbRows('clients').length + 1), booking_id: b.id, company: b.company, contact_name: b.name, contact_email: b.email, plan: p.plan, term, calls_promised: p.calls_promised, monthly_fee: term === '3month' && p.three_month_fee ? p.three_month_fee : p.monthly_fee, stage: 'won' };
  dbRows('clients').push(c); b.status = 'won';
  return { data: { client_id: c.id, invoice_id: 'inv-1', agreement_id: 'agr-1', invoice_number: 'AV-2026-0001' }, error: null };
}
async function fakeRpc(name, args) {
  rpcs.push({ name, args });
  if (rpcFail) return { data: null, error: rpcFail };
  if (name === 'close_won') return closeWon(args || {});
  return { data: null, error: null };
}
const dbRows = (t) => (db[t] ||= []);
const supa = { session: null, user: null, profile: null };
const fakeSb = {
  auth: { getSession: async () => ({ data: { session: supa.session } }), getUser: async () => ({ data: { user: supa.user } }), signInWithPassword: async () => ({ error: null }), signOut: async () => { supa.session = null; }, resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) },
  from: (table) => builder(table),
  rpc: fakeRpc,
};
globalThis.supabase = { createClient: () => fakeSb };

/* ───────────── load the shell, then pipeline.js ───────────── */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="finance.js">'));
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
/* finance.js loads first in the browser too: it owns the plans on offer and the one legacy guard */
vm.runInThisContext(fs.readFileSync(path.join(root, 'finance.js'), 'utf8'), { filename: 'finance.js' });
const SRC = fs.readFileSync(path.join(root, 'pipeline.js'), 'utf8');
vm.runInThisContext(SRC, { filename: 'pipeline.js' });
supa.session = { access_token: 'test-token' };
after(() => { clearTimeout(window._tt); });

const tick = () => new Promise((r) => setTimeout(r, 5));
const text = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const BROKEN = /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/;
const PRICES = [
  { plan: 'starter', label: 'Starter', calls_promised: 5, monthly_fee: 1500, three_month_fee: 1200, is_recurring: true },
  { plan: 'growth', label: 'Growth', calls_promised: 10, monthly_fee: 3000, three_month_fee: 2400, is_recurring: true },
  { plan: 'scale', label: 'Scale', calls_promised: 15, monthly_fee: 4500, three_month_fee: 3600, is_recurring: true },
];
const booking = (o) => Object.assign({ id: 'b-' + nextId++, name: 'Dana Smith', email: 'dana@acme.test', company: 'Acme Roofing', website: 'acme.test', role: 'Founder', city: 'Austin', country: 'US', industry: 'Roofing', budget: '$5k', decision_maker: true, goal: 'More booked calls', timeline: 'This month', current_lead_gen: 'Referrals', call_at: '2026-11-25T10:00:00Z', minutes: 30, timezone: 'America/Chicago', source: 'website', status: 'new', score: 72, created_at: '2026-11-20T09:00:00Z' }, o);
function fresh(seedPrices = true) {
  Object.keys(db).forEach((k) => { db[k] = []; });
  queries.length = 0; failTable = null; plForget(); rpcs.length = 0; rpcFail = null;
  if (seedPrices) db.plan_prices = PRICES.map((p) => Object.assign({}, p));
  authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' };
}

/* ───────────── 1. nothing here calls another server ───────────── */
test('pipeline.js talks only to Supabase, and never writes a price or a brief of its own', () => {
  assert.ok(!/machineFetch|MACHINE_URL|email-distributor/.test(SRC), 'no machine');
  assert.ok(!/\bimport\b|\brequire\(/.test(SRC), 'plain browser JS');
  // the research engine's two tables are only ever read
  assert.ok(!/from\('research_briefs'\)[\s\S]{0,80}?\.(insert|update|upsert|delete)/.test(SRC), 'research_briefs is read only');
  assert.ok(!/from\('research_log'\)[\s\S]{0,80}?\.(insert|update|upsert|delete)/.test(SRC), 'research_log is read only');
  // no price is ever typed into this file
  assert.ok(!/monthly_fee:\s*\d/.test(SRC) && !/calls_promised:\s*\d/.test(SRC), 'no hard-coded price or call count');
  assert.ok(!/\$\s?(300|1,?500|3,?000|4,?500|1,?200|2,?400|3,?600|7,?200|10,?800)\b/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')), 'no plan price is written down in the code');
  assert.ok(!/from\('clients'\)[\s\S]{0,40}?\.insert/.test(SRC), 'a client is only ever made by close_won');
  assert.ok(!/pilot|credit/i.test(SRC), 'the withdrawn plan is not named here; finance.js holds the one guard');
  assert.ok(/plResearchNow/.test(SRC) && /\/\/ TODO: trigger the research engine/.test(SRC), 'the research action leaves a marked TODO');
});

/* ───────────── 2. the bookings list ───────────── */
test('plBookings: soonest call first, with the score and whether a brief exists', async () => {
  fresh();
  const later = booking({ id: 'b-later', call_at: '2026-12-01T10:00:00Z', score: 40 });
  const sooner = booking({ id: 'b-sooner', call_at: '2026-11-24T10:00:00Z', score: 91 });
  const won = booking({ id: 'b-won', call_at: '2026-11-23T10:00:00Z', status: 'won' });
  db.discovery_bookings = [later, sooner, won];
  db.research_briefs = [{ booking_id: 'b-sooner', brief: { summary: 'Good fit' }, writer: 'engine' }];

  const open = await plBookings({ status: 'open' });
  assert.equal(open.ok, true);
  assert.deepEqual(open.data.map((b) => b.id), ['b-sooner', 'b-later'], 'soonest first, won is not open');
  assert.deepEqual(open.data.map((b) => b.score), [91, 40]);
  assert.deepEqual(open.data.map((b) => b.has_brief), [true, false]);

  const all = await plBookings({});
  assert.deepEqual(all.data.map((b) => b.id), ['b-won', 'b-sooner', 'b-later']);
  const onlyWon = await plBookings({ status: 'won' });
  assert.deepEqual(onlyWon.data.map((b) => b.id), ['b-won']);
  // a database that says no gives plain words, not a throw
  failTable = 'discovery_bookings';
  const bad = await plBookings({});
  assert.equal(bad.ok, false); assert.equal(bad.data, null); assert.equal(bad.error, 'The database said no.');
});

test('plBooking: their answers, the score and the brief, all in one', async () => {
  fresh();
  db.discovery_bookings = [booking({ id: 'b1' })];
  db.research_briefs = [{ booking_id: 'b1', brief: { summary: 'Roofer in Austin', fit: { score: 'high', why: 'spends on ads' } } }];
  const r = await plBooking('b1');
  assert.equal(r.ok, true);
  assert.equal(r.score, undefined); assert.equal(r.data.score, 72);
  const labels = r.data.answers.map((a) => a.label);
  assert.ok(labels.includes('Their role') && labels.includes('What they want') && labels.includes('Can they decide'));
  assert.equal(r.data.answers.find((a) => a.label === 'Can they decide').value, 'Yes');
  assert.ok(!labels.includes('Website on file'), 'only what they filled in');
  assert.equal(r.data.research.state, 'done');
  assert.ok(r.data.sections.length, 'the brief is laid out, not raw json');
  assert.equal(r.data.client, null);
  const gone = await plBooking('nope');
  assert.equal(gone.ok, false); assert.match(gone.error, /not here any more/);
  assert.equal((await plBooking('')).ok, false);
});

/* ───────────── 3. where the research got to ───────────── */
test('plResearchState: none, running, done and failed, worked out from research_briefs and research_log', async () => {
  fresh();
  db.discovery_bookings = [booking({ id: 'none' }), booking({ id: 'running' }), booking({ id: 'done' }), booking({ id: 'failed' })];
  // none: no brief, nothing in the log
  assert.equal((await plResearchState('none')).data.state, 'none');
  // running: the engine said it started, a moment ago
  db.research_log.push({ id: 1, booking_id: 'running', at: new Date(Date.now() - 60000).toISOString(), event: { event: 'started', agents: 3 } });
  const running = await plResearchState('running');
  assert.equal(running.data.state, 'running');
  assert.ok(running.data.log.length === 1);
  // done: the brief is there (whatever the log says)
  db.research_briefs.push({ booking_id: 'done', brief: { summary: 'x' }, writer: 'engine', updated_at: '2026-11-21T10:00:00Z' });
  db.research_log.push({ id: 2, booking_id: 'done', at: '2026-11-21T09:00:00Z', event: 'started' });
  const done = await plResearchState('done');
  assert.equal(done.data.state, 'done'); assert.equal(done.data.writer, 'engine');
  // failed: the engine's last word was an error
  db.research_log.push({ id: 3, booking_id: 'failed', at: '2026-11-21T09:00:00Z', event: { event: 'started' } });
  db.research_log.push({ id: 4, booking_id: 'failed', at: '2026-11-21T09:05:00Z', event: { event: 'error', message: 'the site would not load' } });
  assert.equal((await plResearchState('failed')).data.state, 'failed');
  // a start that never finished is not "running" for ever
  db.research_log.push({ id: 5, booking_id: 'stale', at: '2026-01-01T00:00:00Z', event: { event: 'started' } });
  assert.equal((await plResearchState('stale')).data.state, 'failed');
  // odd log shapes do not break it
  db.research_log.push({ id: 6, booking_id: 'odd', at: '2026-11-21T09:00:00Z', event: [1, 2, 3] });
  assert.equal((await plResearchState('odd')).data.state, 'none');
  db.research_log.push({ id: 7, booking_id: 'odd2', at: '2026-11-21T09:00:00Z', event: null });
  assert.equal((await plResearchState('odd2')).data.state, 'none');
  // "research this one" writes nothing at all
  queries.length = 0;
  const asked = plResearchNow('none');
  assert.equal(asked.ok, true); assert.equal(asked.data.triggered, false);
  assert.deepEqual(queries, [], 'it must never write a brief itself');
});

/* ───────────── 4. the brief, whatever shape it is ───────────── */
test('a brief whose shape is not what we expect still reads as a brief, and never throws', () => {
  fresh();
  const shapes = [
    { brief: { summary: 'They sell roofs', angles: ['storm damage', 'insurance work'], fit: { score: 9, why: 'ads already running' } } },
    { brief: 'Just one long sentence from the engine.' },
    { brief: ['first point', 'second point'] },
    { brief: [{ title: 'Angle', detail: 'storms' }, { title: 'Risk', detail: { depth: { deeper: { deepest: 'still fine' } } } }] },
    { brief: { nothing: null, empty: '', zero: 0, no: false, list: [] } },
    { brief: 42 },
    { brief: { nested: { a: { b: { c: { d: 'very deep' } } } } } },
    { brief: null },
    {},
    null,
  ];
  shapes.forEach((row, i) => {
    let sections;
    assert.doesNotThrow(() => { sections = plBriefSections(row); }, 'shape ' + i);
    let h;
    assert.doesNotThrow(() => { h = renderPlBrief(sections, { state: sections.length ? 'done' : 'none' }, 'b1'); }, 'render shape ' + i);
    assert.ok(typeof h === 'string' && h.length);
    assert.ok(!BROKEN.test(text(h)), 'shape ' + i + ' reads badly: ' + text(h));
  });
  // the words really do come through, and html in a brief is escaped
  const s = plBriefSections({ brief: { summary: 'They sell roofs', angles: ['storm damage', 'insurance work'] } });
  const h = renderPlBrief(s, { state: 'done' }, 'b1');
  assert.ok(text(h).includes('They sell roofs') && text(h).includes('storm damage'));
  assert.ok(text(h).includes('Angles'), 'keys read as words');
  const nasty = renderPlBrief(plBriefSections({ brief: { summary: '<img src=x onerror=alert(1)>' } }), { state: 'done' }, 'b1');
  assert.ok(!nasty.includes('<img'), 'escaped');
  // no brief: a calm line and the research action
  const nope = renderPlBrief([], { state: 'none' }, 'b1');
  assert.ok(text(nope).includes('No brief yet') && nope.includes('plResearchNow('));
  assert.ok(text(renderPlBrief([], { state: 'running' }, 'b1')).includes('Research is running'));
  assert.ok(text(renderPlBrief([], { state: 'failed' }, 'b1')).includes('did not finish'));
});

/* ───────────── 5. won ───────────── */
test('an empty book: no booking, no funnel, and neither screen breaks', async () => {
  fresh();
  assert.ok(text(renderPlEnquiry(null, {})).includes('Booking not found'));
  const zero = text(renderPlFunnel((await plFunnel({})).data, {}));
  assert.ok(zero.includes('Show rate') && zero.includes('Win rate') && zero.includes('No enquiries in this period'));
  assert.ok(!renderPlFunnel(null, {}).includes('undefined'));
});

test('the Bookings list screen is gone; the data layer and the funnel stay', () => {
  for (const gone of ['viewEnquiries', 'viewEnquiry', 'renderPlEnquiries', 'renderPlBookingCard', 'plLoadEnquiries', 'plOpenEnquiry'])
    assert.equal(typeof globalThis[gone], 'undefined', gone + ' should be gone');
  for (const kept of ['plBookings', 'plBooking', 'plCloseWon', 'plLost', 'plNoShow', 'plHeld', 'plFunnel', 'plBrief', 'plBriefSections', 'plResearchState', 'renderPlBrief', 'renderPlEnquiry', 'viewFunnel'])
    assert.equal(typeof globalThis[kept], 'function', kept);
  assert.equal(typeof globalThis.plWon, 'undefined', 'the old path that wrote a client row from the browser is gone');
  assert.equal(views.enquiries, undefined); assert.equal(views.enquiry, undefined);
  assert.ok(views.funnel && views.calendar, 'the funnel and the calendar are still routes');
});

test('one booking: their answers, the brief and the outcome buttons; a won one offers no second client', async () => {
  fresh();
  db.discovery_bookings = [booking({ id: 'b1' })];
  db.research_briefs = [{ booking_id: 'b1', brief: { summary: 'Roofer, spends on ads', angles: ['storm season'] } }];
  const d = (await plBooking('b1')).data;
  const h = renderPlEnquiry(d, { now: new Date('2026-11-22T12:00:00Z') });
  const t = text(h);
  for (const w of ['Acme Roofing', 'Score 72', 'Roofer, spends on ads', 'storm season', 'More booked calls', 'Won', 'Lost', 'Nobody came', 'Call done']) {
    assert.ok(t.includes(w), 'missing: ' + w);
  }
  assert.ok(h.includes('plMarkWon(') && h.includes('plMarkLost(') && h.includes('plMarkNoShow(') && h.includes('plMarkHeld('));
  assert.ok(h.includes('onclick="plOpenWon()"'), 'Won opens the plan picker');
  // the caller can bring its own top (the Calendar's panel does), and the rest still draws
  const own = renderPlEnquiry(d, { head: '<p>MY HEAD</p>' });
  assert.ok(own.includes('MY HEAD') && !own.includes('pl-head') && own.includes('plMarkWon('));
  // the plan they picked on the website is already chosen, and the new answers are shown
  const picked = renderPlEnquiry((await plBooking('b1')).data && Object.assign({}, d, { booking: Object.assign({}, d.booking, { plan: 'growth' }) }), {});
  assert.match(picked, /value="growth" selected/);
  const more = plAnswers({ name: 'A', sells: 'Roofs', capacity: '5 a week', phone: '+1 555', tried_outbound: false, budget: '$20k' });
  assert.deepEqual(more.map((a) => a.label + '=' + a.value), ['Name=A', 'Phone=+1 555', 'What they sell=Roofs', 'Deal size=$20k', 'Capacity for new calls=5 a week', 'Tried outbound before=No']);
  assert.ok(h.includes('id="plLossReason"') && /value="went_elsewhere"/.test(h), 'the reasons are the fixed list');
  assert.ok(!/value="too_dear"/.test(h));
  assert.ok(!BROKEN.test(t), t);

  // once they are a client the screen says so instead of offering Won again
  assert.equal((await plCloseWon('b1', 'growth', 'monthly')).ok, true);
  const after = renderPlEnquiry((await plBooking('b1')).data, {});
  assert.ok(text(after).includes('they are a client') && !after.includes('plMarkWon('));
  assert.ok(text(after).includes('Growth') && text(after).includes('10 calls a month'), 'the plan name is capitalised for the owner');
  assert.ok(after.includes('plOpenClient(') && text(after).includes('Open client →'), 'won: a way to their client record');
});

test('the buttons read the plan and the reason off the screen, and say plainly when they will not act', async () => {
  fresh();
  db.discovery_bookings = [booking({ id: 'b1' })];
  const said = [];
  const realToast = globalThis.toast;
  globalThis.toast = (m) => said.push(m);
  try {
    el('plPlan').value = ''; el('plTerm').value = 'monthly'; el('plLossReason').value = '';
    let r = await plMarkWon('b1');
    assert.equal(r.ok, false); assert.match(r.error, /Pick the plan/);
    assert.equal(db.clients.length, 0);
    r = await plMarkLost('b1');
    assert.equal(r.ok, false); assert.match(r.error, /Pick why we lost them/);
    el('plPlan').value = 'scale';
    r = await plMarkWon('b1');
    assert.equal(r.ok, true);
    assert.equal(db.clients[0].monthly_fee, 4500); assert.equal(db.clients[0].calls_promised, 15);
    assert.deepEqual(rpcs.at(-1), { name: 'close_won', args: { p_booking: 'b1', p_plan: 'scale', p_term: 'monthly' } }, 'Won goes through the database rule');
    assert.ok(!queries.some((q) => q.table === 'clients' && q.op === 'insert'), 'and never writes the client row from the browser');
    assert.ok(said.some((m) => /^Won\. The agreement and invoice are on their way to /.test(m)));
    assert.ok(said.every((m) => typeof m === 'string' && m.length && !BROKEN.test(m)), 'plain words');
  } finally { globalThis.toast = realToast; }
});

/* ───────────── won: the plan picker and the close_won rule ───────────── */
test('plCloseWon calls close_won with the booking, plan and term, and hands back what the database made', async () => {
  fresh();
  db.discovery_bookings = [booking({ id: 'b1' }), booking({ id: 'b2' }), booking({ id: 'b3' })];
  const r = await plCloseWon('b1', 'growth', '3month');
  assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']);
  assert.deepEqual(r, { ok: true, data: { client_id: 'cl-1', invoice_id: 'inv-1', agreement_id: 'agr-1', invoice_number: 'AV-2026-0001' }, error: '' });
  assert.deepEqual(rpcs, [{ name: 'close_won', args: { p_booking: 'b1', p_plan: 'growth', p_term: '3month' } }]);
  assert.equal(queries.length, 0, 'plCloseWon reads and writes no table itself');

  // a plan code from before the three plans is refused in one plain sentence, before the
  // database is asked, and is never quietly turned into another plan
  const retired = await plCloseWon('b2', 'pilot', '3month');
  assert.deepEqual(retired, { ok: false, data: null, error: 'That plan is retired. Pick Starter, Growth or Scale.' });
  assert.equal(rpcs.length, 1, 'nothing was sent for a retired plan');
  await plCloseWon('b3', 'starter');
  assert.equal(rpcs.at(-1).args.p_term, 'monthly');

  // refused before the database is asked
  const n = rpcs.length;
  assert.match((await plCloseWon('', 'growth')).error, /No booking/);
  assert.match((await plCloseWon('b1', '')).error, /Pick the plan/);
  assert.match((await plCloseWon('b1', 'platinum')).error, /price list/);
  assert.equal(rpcs.length, n);

  // the database's own words come back untouched; a thrown error does not escape
  const twice = await plCloseWon('b1', 'scale', 'monthly');
  assert.deepEqual(twice, { ok: false, data: null, error: 'That call is already a client.' });
  const real = fakeSb.rpc; fakeSb.rpc = async () => { throw new TypeError('Failed to fetch'); };
  try { const down = await plCloseWon('b3', 'growth'); assert.equal(down.ok, false); assert.equal(down.data, null); }
  finally { fakeSb.rpc = real; }
});

test('the won picker: the three plans on offer, the booking\'s plan already chosen, the term always there', () => {
  fresh();
  const h = renderPlWonPicker(booking({ id: 'b1', plan: 'growth', email: 'dana@acme.test' }), { open: true });
  const t = text(h);
  for (const w of ['Starter', 'Growth', 'Scale', 'Monthly', '3 months', 'Mark won and send the pack', 'dana@acme.test']) assert.ok(t.includes(w), 'missing: ' + w);
  assert.ok(!/pilot/i.test(h), 'the withdrawn plan is not offered or named');
  assert.equal((h.match(/<option value="(starter|growth|scale)"/g) || []).length, 3, 'three plans, no more');
  assert.match(h, /<option value="growth" selected>Growth<\/option>/);
  assert.equal((h.match(/ selected/g) || []).length, 1);
  assert.match(h, /<option value="monthly">Monthly<\/option><option value="3month">3 months<\/option>/);
  assert.ok(h.includes('onclick="plMarkWon(&quot;b1&quot;)"'), 'the confirm button is the one that writes');
  assert.ok(!/id="plWonPick"[^>]*display:none/.test(h), 'open when asked');
  assert.ok(!/id="plTermField"[^>]*display:none/.test(h), 'a recurring plan shows the term');

  // closed until Won is clicked, which is how the panel draws it
  assert.match(renderPlWonPicker(booking({ id: 'b1' }), {}), /id="plWonPick"[^>]*display:none/);
  // an old booking that carries the withdrawn plan code: nothing is preselected, it is
  // not an option, no price is quoted, and the owner has to pick one of the three
  const old = renderPlWonPicker(booking({ id: 'b1', plan: 'pilot' }), { open: true, prices: PRICES.concat([{ plan: 'pilot', calls_promised: 2, monthly_fee: 300 }]) });
  assert.ok(!/pilot/i.test(old) && !/ selected/.test(old) && !old.includes('$'), 'no such option, nothing preselected, nothing priced');
  assert.ok(!/id="plTermField"[^>]*display:none/.test(old), 'the term is always there');
  // no plan on the booking, a plan the list does not know, nothing at all
  for (const b of [booking({ id: 'b1', plan: null }), booking({ id: 'b1', plan: 'platinum' }), {}, null]) {
    const x = renderPlWonPicker(b, { open: true });
    assert.ok(!/ selected/.test(x) && !BROKEN.test(text(x)), text(x));
  }
  assert.ok(!renderPlWonPicker(booking({ id: 'b1', email: '<img src=x onerror=alert(1)>' }), {}).includes('<img'));
});

test('Won opens the picker, keeps the term for every plan on offer, and confirming sends the pack through close_won', async () => {
  fresh();
  db.discovery_bookings = [booking({ id: 'b1', plan: 'starter', email: 'dana@acme.test' })];
  await plLoadEnquiry('b1');
  const said = [];
  const realToast = globalThis.toast;
  globalThis.toast = (m) => said.push(m);
  try {
    el('plWonPick').style.display = 'none';
    el('plPlan').value = 'starter'; el('plTerm').value = 'monthly';
    assert.equal(plOpenWon(), true);
    assert.equal(el('plWonPick').style.display, '');
    assert.equal(el('plWonPrice').textContent, 'Starter · monthly — 5 calls a month, $1,500 a month');
    el('plPlan').value = 'growth'; el('plTerm').value = '3month'; plWonTermShow();
    assert.equal(el('plWonPrice').textContent, 'Growth · 3 months — 10 calls a month, $2,400 a month ($7,200 billed up front)');
    assert.equal(plOpenWon(), false, 'clicking Won again tucks it away');
    assert.equal(rpcs.length, 0, 'opening the picker writes nothing');

    el('plPlan').value = 'starter'; el('plTerm').value = 'monthly';
    let r = await plMarkWon('b1');
    assert.equal(r.ok, true);
    assert.deepEqual(rpcs.at(-1).args, { p_booking: 'b1', p_plan: 'starter', p_term: 'monthly' });
    assert.equal(said.at(-1), 'Won. The agreement and invoice are on their way to dana@acme.test.');
    assert.equal(db.discovery_bookings[0].status, 'won');
    const after = renderPlEnquiry(pl.one, {});
    assert.ok(text(after).includes('Won') && !after.includes('plMarkWon(') && !after.includes('plOpenWon('), 'a won booking shows Won, not the button');

    // the database's refusal is shown word for word
    r = await plMarkWon('b1');
    assert.equal(r.ok, false);
    assert.equal(said.at(-1), 'That call is already a client.');
    rpcFail = { message: 'Only the owner can mark a call won.' };
    await plMarkWon('b1');
    assert.equal(said.at(-1), 'Only the owner can mark a call won.');
  } finally { globalThis.toast = realToast; }

  // marked won with no client row we can read: still the Won state, never the button
  const bare = renderPlOutcome({ booking: booking({ id: 'b9', status: 'won' }), client: null });
  assert.ok(text(bare).includes('Won') && !bare.includes('plMarkWon(') && !bare.includes('plOpenWon('));
});

/* ───────────── dress rehearsal: the Won flow says what it will do ───────────── */
test('the won picker shows the price beside the button, preselects the recommended plan, warns of a call still to come, and asks once', () => {
  fresh();
  /* the offer, plan by plan: calls a month, the monthly price, and the 3-month price billed up front */
  assert.deepEqual(['starter', 'growth', 'scale'].map((p) => plPriceWords(p, 'monthly', PRICES)), [
    'Starter · monthly — 5 calls a month, $1,500 a month',
    'Growth · monthly — 10 calls a month, $3,000 a month',
    'Scale · monthly — 15 calls a month, $4,500 a month']);
  assert.deepEqual(['starter', 'growth', 'scale'].map((p) => plPriceWords(p, '3month', PRICES)), [
    'Starter · 3 months — 5 calls a month, $1,200 a month ($3,600 billed up front)',
    'Growth · 3 months — 10 calls a month, $2,400 a month ($7,200 billed up front)',
    'Scale · 3 months — 15 calls a month, $3,600 a month ($10,800 billed up front)']);
  assert.deepEqual(['starter', 'growth', 'scale'].map((p) => plFirstInvoice(p, '3month', PRICES)), [3600, 7200, 10800]);
  /* the withdrawn plan code has no price to say, even if a row for it is still in the list */
  const stale = PRICES.concat([{ plan: 'pilot', label: 'Old plan', calls_promised: 2, monthly_fee: 300, three_month_fee: null }]);
  assert.equal(plPriceWords('pilot', '3month', stale), '');
  assert.equal(plFirstInvoice('pilot', 'monthly', stale), null);
  assert.equal(plWonConfirmWords({ email: 'r@b.test' }, 'pilot', '3month', stale), 'Send the agreement and the invoice to r@b.test?', 'no amount is ever quoted for it');
  assert.equal(plPlanWord('pilot'), 'Retired plan');
  assert.equal(plPriceWords('growth', 'monthly', []), '', 'no price list, no made-up price');
  assert.equal(plWonConfirmWords({ email: 'riley@brightline.test' }, 'growth', 'monthly', PRICES), 'Send the agreement and the $3,000 invoice to riley@brightline.test?');
  assert.equal(plWonConfirmWords({ email: 'r@b.test' }, 'growth', '3month', PRICES), 'Send the agreement and the $7,200 invoice to r@b.test?');
  assert.equal(plRecommendedPlan({ brief: { recommended_plan: 'Growth — budget fits and they want consistent volume' } }), 'growth');
  // an old brief may still name the withdrawn plan: nothing is preselected then
  assert.equal(plRecommendedPlan({ brief: { recommended_plan: 'The $300 Pilot' } }), '');
  assert.equal(plRecommendedPlan({ brief: { recommended_plan: 'whatever' } }), '');
  assert.equal(plRecommendedPlan(null), '');

  const future = { id: 'b1', email: 'r@b.test', call_at: '2099-01-01T10:00:00Z', plan: null };
  const h = renderPlWonPicker(future, { open: true, prices: PRICES, recommended: 'growth' });
  const t = text(h);
  assert.match(h, /<option value="growth" selected>Growth<\/option>/, 'the recommended plan is picked when they chose none');
  assert.ok(t.includes('The brief recommends Growth.'));
  /* a booking whose own plan cannot be used (withdrawn, or unknown) falls back to the brief's, and says so */
  for (const stale of ['pilot', 'platinum']) {
    const fb = renderPlWonPicker(Object.assign({}, future, { plan: stale }), { open: true, prices: PRICES, recommended: 'growth' });
    assert.ok(/value="growth" selected/.test(fb) && text(fb).includes('The brief recommends Growth.'), stale + ': the preselection is explained');
  }
  assert.ok(!text(renderPlWonPicker(Object.assign({}, future, { plan: 'scale' }), { open: true, prices: PRICES, recommended: 'growth' })).includes('The brief recommends'), 'their own choice needs no note');
  assert.ok(t.includes('Growth · monthly — 10 calls a month, $3,000 a month'));
  assert.ok(t.includes('This call hasn’t happened yet.'));
  assert.ok(h.includes('onclick="plWonAsk(&quot;b1&quot;)"'), 'the first button only asks');
  assert.match(h, /id="plWonConfirm"[^>]*display:none/);
  assert.ok(t.includes('Send the agreement and the $3,000 invoice to r@b.test?') && t.includes('Yes, send it') && t.includes('Back'));
  const past = renderPlWonPicker(Object.assign({}, future, { call_at: '2020-01-01T10:00:00Z', plan: 'scale' }), { open: true, prices: PRICES, recommended: 'growth' });
  assert.ok(!text(past).includes('hasn’t happened') && /value="scale" selected/.test(past), 'the plan they chose beats the recommendation');

  // asking shows the confirm line and hides the first button; Back undoes it
  el('plPlan').value = ''; assert.equal(plWonAsk('b1').ok, false);
  pl.one = { booking: future, prices: PRICES };
  el('plPlan').value = 'growth'; el('plTerm').value = '3month';
  el('plWonConfirm').style.display = 'none'; el('plWonAskRow').style.display = '';
  assert.equal(plWonAsk('b1').data.asked, 'Send the agreement and the $7,200 invoice to r@b.test?');
  assert.equal(el('plWonConfirm').style.display, ''); assert.equal(el('plWonAskRow').style.display, 'none');
  plWonTermShow();
  assert.equal(el('plWonPrice').textContent, 'Growth · 3 months — 10 calls a month, $2,400 a month ($7,200 billed up front)');
  assert.equal(el('plWonConfirm').style.display, 'none', 'changing the plan or term goes back a step');
  assert.equal(rpcs.length, 0, 'nothing was sent by asking');
});

test('after Won: the invoice line and Open client; capitalised plan; the country in capitals; empty brief rows left out', () => {
  fresh();
  const d = { booking: booking({ id: 'b1', status: 'won' }), client: { id: 'cl-1', company: 'Acme Roofing', plan: 'growth', calls_promised: 10, term: 'monthly' }, invoice: { number: 'AV-2026-1001', amount: 3000, status: 'sent' } };
  const h = renderPlOutcome(d); const t = text(h);
  assert.ok(t.includes('Acme Roofing is on Growth, 10 calls a month'));
  assert.ok(t.includes('Invoice AV-2026-1001 · $3,000 sent'));
  assert.ok(h.includes('plOpenClient(&quot;cl-1&quot;)') && t.includes('Open client →'));
  assert.ok(text(renderPlOutcome(Object.assign({}, d, { client: Object.assign({}, d.client, { term: '3month' }) }))).includes('Acme Roofing is on Growth · 3 months, 10 calls a month'));
  /* a client from before the three plans: shown safely, with none of the old name, price or call count */
  const oldOne = renderPlOutcome(Object.assign({}, d, { client: { id: 'cl-0', company: 'Old Co', plan: 'pilot', calls_promised: 2, term: 'monthly' }, invoice: null }));
  assert.ok(text(oldOne).includes('Old Co is on a retired plan. This booking cannot make a second client.'), text(oldOne));
  assert.ok(!/pilot/i.test(oldOne) && !/2 calls/.test(oldOne) && !BROKEN.test(text(oldOne)));
  assert.ok(!renderPlEnquiry(Object.assign({}, d, { booking: Object.assign({}, d.booking, { meet_link: 'https://meet.google.com/x' }) }), {}).includes('Join the call'), 'no Join for a won call');
  assert.equal(plCountry('us'), 'US'); assert.equal(plCountry('Sri Lanka'), 'Sri Lanka'); assert.equal(plCountry(null), '');
  assert.ok(plAnswers({ city: 'Austin', country: 'us' }).some((a) => a.value === 'Austin, US'));
  const secs = plBriefSections({ brief: { facts: { city: null, news: [], tech: [], company: 'Acme' }, reputation: { praise: [], complaints: [] }, signals: [], _writer_note: 'x', summary: 'Kept' } });
  assert.ok(!secs.some((s) => ['Reputation', 'Signals'].includes(s.title)), 'a heading with nothing under it is not drawn');
  assert.ok(secs.every((s) => s.text || s.lines.length));
  assert.ok(!JSON.stringify(secs).includes('News') && !JSON.stringify(secs).includes('Reputation') && !JSON.stringify(secs).includes('Writer note'), JSON.stringify(secs));
  assert.ok(JSON.stringify(secs).includes('Acme') && JSON.stringify(secs).includes('Kept'));
});

/* ───────────── the rehearsal pass ───────────── */

test('opening one booking reads the brief once, and asks for everything at once', async () => {
  /* plBooking read research_briefs itself and then called plResearchState,
     which read it AGAIN; and the booking, the brief, the log, the client and
     the price list were read one after the other — six waits end to end for a
     screen that could have waited twice. */
  fresh();
  db.discovery_bookings = [booking({ id: 'b1' })];
  db.research_briefs = [{ booking_id: 'b1', brief: { summary: 'A roofer' }, writer: 'engine' }];
  db.research_log = [{ booking_id: 'b1', at: '2026-11-20T10:00:00Z', event: { event: 'finished' } }];
  db.plan_prices = [{ plan: 'growth', monthly: 3000 }];

  queries.length = 0;
  const r = await plBooking('b1');
  assert.equal(r.ok, true, r.error);
  const briefReads = queries.filter((q) => q.table === 'research_briefs').length;
  assert.equal(briefReads, 1, 'the brief is read once, not twice');
  assert.equal(r.data.research.state, 'done', 'and the research state still comes out right');
  assert.ok(queries.length <= 6, 'six queries at most for one booking, got ' + queries.length);
});

test('plResearchFrom works the state out from rows already in hand, and reads nothing', () => {
  queries.length = 0;
  const none = plResearchFrom({ ok: true, data: null, error: '' }, { ok: true, data: [], error: '' });
  assert.equal(none.data.state, 'none');
  const running = plResearchFrom({ ok: true, data: null, error: '' },
    { ok: true, data: [{ at: new Date().toISOString(), event: { event: 'started' } }], error: '' });
  assert.equal(running.data.state, 'running');
  const failed = plResearchFrom({ ok: true, data: null, error: '' },
    { ok: true, data: [{ at: new Date().toISOString(), event: { event: 'crashed' } }], error: '' });
  assert.equal(failed.data.state, 'failed');
  const done = plResearchFrom({ ok: true, data: { updated_at: 'x', writer: 'engine' }, error: '' }, { ok: true, data: [], error: '' });
  assert.equal(done.data.state, 'done');
  /* a brief that could not be read is passed straight back, not called 'none' */
  const bad = plResearchFrom({ ok: false, data: null, error: 'The database said no.' }, { ok: true, data: [], error: '' });
  assert.equal(bad.ok, false);
  assert.equal(queries.length, 0, 'it reads nothing');
});
