/* Tests for the Clients page live list (feed.js): Needs you (each line with its button) and Just happened (last 7 days).
   Same set-up as simple.test.mjs: the shell script, then trials.js, inquiries.js, feed.js, calendar.js, messages.js with a tiny fake DOM. No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, simpleRows, simpleHub, stagesWith } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM (as in simple.test.mjs) ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, open: false, scrollTop: 0, scrollHeight: 900, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() { el._focused = (el._focused || 0) + 1; }, select() { el._selected = (el._selected || 0) + 1; }, submit() {}, addEventListener() {}, scrollIntoView() { el._scrolled = (el._scrolled || 0) + 1; }, closest() { return null; }, getAttribute() { return null; } };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const clip = { text: null, fail: false };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { if (clip.fail) throw new Error('denied'); clip.text = t; } } }, configurable: true });
globalThis.location = { hash: '', origin: 'https://aviance.store', pathname: '/', search: '', href: 'https://aviance.store/' };
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
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
for (const f of ['trials.js', 'inquiries.js', 'feed.js', 'calendar.js', 'messages.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
supa.session = { access_token: 'test-token' };
after(() => { trialsStopTimer(); calendarStopTimer(); feedStop(); });

const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const count = (s, re) => (s.match(re) || []).length;
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 5));
const between = (s, a, b) => { const i = s.indexOf(a); const j = b ? s.indexOf(b, i + 1) : s.length; return s.slice(i, j < 0 ? s.length : j); };
const visibleText = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
const offline = () => { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; globalThis.confirm = () => true; };

const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const bk = (o) => Object.assign({ id: 'q1', at: iso(NOW.getTime() - 3 * 86400000), status: 'new', name: 'Dana Whitfield', company: 'Ridgeline IT', email: 'dana@ridgeline.example', slotStart: iso(NOW.getTime() - 3 * H), slotEnd: iso(NOW.getTime() - 2.5 * H), stageHistory: [] }, o);
const hubOf = (list, extra) => Object.assign({}, simpleHub, { stages: stagesWith({}), alerts: [], inquiries: { counts: {}, open: list.length, latest: list } }, extra || {});
const needsOf = (h) => between(h, '<h3>Needs you</h3>', '<h3>Just happened</h3>');
const happenedOf = (h) => between(h, '<h3>Just happened</h3>');
const reset = () => { asOwner(); trialsForget(); calendarForget(); feed.snooze = null; localStorage.removeItem(FEED_SNOOZE_KEY); asOwner(); };

test('Needs you: a booked call whose time passed — Call done / No-show / Send the agreement and invoice / Lost, each wired to the existing action', () => {
  reset(); const hub = hubOf([bk()]); trialsIngestHub(hub);
  const n = needsOf(renderTrialList(hub, { now: NOW }));
  assert.ok(visibleText(n).includes('Your call with Ridgeline IT was 3 h ago. How did it go?'));
  for (const [label, status] of [['Call done', 'held'], ['No-show', 'no_show'], ['Send the agreement and invoice', 'agreement_sent'], ['Lost', 'lost']]) assert.ok(n.includes(`onclick="inquirySetStatus(&quot;q1&quot;,'${status}')">${label}</button>`), label);
  assert.ok(n.includes('onclick="openInquiry(&quot;q1&quot;)"'), 'the line opens the booking');
  // a call still ahead is not a to-do yet
  const ahead = hubOf([bk({ slotStart: iso(NOW.getTime() + 5 * H) })]); trialsIngestHub(ahead);
  assert.ok(!needsOf(renderTrialList(ahead, { now: NOW })).includes('Ridgeline IT'));
  trialsForget();
});

test('Needs you: waiting to pay (They paid / Not yet), a follow-up older than 2 days, a call done, a no-show', () => {
  reset();
  const pay = bk({ id: 'p1', status: 'agreement_sent', company: 'Pay Co', stageHistory: [{ at: iso(NOW.getTime() - 26 * H), from: 'held', to: 'agreement_sent' }] });
  const old = bk({ id: 'f1', status: 'contacted', company: 'Old Follow', stageHistory: [{ at: iso(NOW.getTime() - 3 * 86400000), to: 'contacted' }] });
  const fresh = bk({ id: 'f2', status: 'contacted', company: 'Fresh Follow', stageHistory: [{ at: iso(NOW.getTime() - 1 * 86400000), to: 'contacted' }] });
  const held = bk({ id: 'h1', status: 'held', company: 'Held Co', stageHistory: [{ at: iso(NOW.getTime() - H), to: 'held' }] });
  const ns = bk({ id: 'n1', status: 'no_show', company: 'Noshow Co', stageHistory: [{ at: iso(NOW.getTime() - 2 * H), to: 'no_show' }] });
  const hub = hubOf([pay, old, fresh, held, ns]); trialsIngestHub(hub);
  const n = needsOf(renderTrialList(hub, { now: NOW }));
  assert.ok(n.includes(`onclick="inquirySetStatus(&quot;p1&quot;,'won')">They paid</button>`) && n.includes('feedNotYet(&quot;pay:p1&quot;)">Not yet</button>'));
  assert.ok(visibleText(n).includes('Pay Co got the agreement and invoice') && visibleText(n).includes('Have they paid?'));
  assert.ok(n.includes('Old Follow') && !n.includes('Fresh Follow'), 'follow-ups only after 2 days');
  assert.ok(n.includes('Held Co') && n.includes('Noshow Co'), 'nothing a booking is waiting on is lost');
  // "Not yet" hides the question for a day
  feedNotYet('pay:p1');
  assert.ok(!needsOf(renderTrialList(hub, { now: NOW })).includes('Pay Co'));
  assert.ok(needsOf(renderTrialList(hub, { now: new Date(Date.now() + 2 * 86400000) })).includes('Pay Co'), 'it comes back');
  trialsForget();
});

test('Needs you: every old "needs you" reason is still there — a client who needs him, one who wrote, a booking held for its call, a call time asked for', () => {
  reset();
  const hub = Object.assign({}, simpleHub); trialsIngestHub(hub);
  const groups = tkListGroups(hub);
  const n = needsOf(renderTrialList(hub, { now: NOW }));
  for (const x of groups.needs) {
    const name = x.s.company;
    if (tkIsUnderReview(x.row)) assert.ok(n.includes(name) && n.includes('>Won</button>') && n.includes('>Lost</button>'), name + ' (booked call: Won / Lost)');
    else assert.ok(n.includes('feed-kind">' + esc(name) + '<'), name + ' needs him, so it is listed');
  }
  assert.ok(n.includes('<span class="tk-person-you">Sam wrote — answer them</span>') && n.includes('Answer them</button>'));
  // running clients that need nothing are not listed
  for (const x of groups.going.concat(groups.done)) assert.ok(!n.includes('feed-kind">' + esc(x.s.company) + '<'), x.s.company);
  trialsForget();
});

test('Just happened: the last 7 days, newest first, at most 30 lines; booked, agreement sent, paid, reminders; each line opens that person', () => {
  reset();
  const q = bk({ id: 'q9', status: 'won', at: iso(NOW.getTime() - 5 * 86400000), reminded_tomorrow: iso(NOW.getTime() - 4 * H), reminded_soon: iso(NOW.getTime() - 3 * H),
    stageHistory: [{ at: iso(NOW.getTime() - 2 * H), to: 'agreement_sent' }, { at: iso(NOW.getTime() - H), to: 'won' }, { at: iso(NOW.getTime() - 9 * 86400000), to: 'held' }] });
  const hub = hubOf([q]); trialsIngestHub(hub);
  const h = happenedOf(renderTrialList(hub, { now: NOW }));
  const lines = [...h.matchAll(/<span class="feed-text">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(lines, ['Ridgeline IT paid', 'Agreement and invoice sent to Ridgeline IT', '1-hour reminder sent to Ridgeline IT', 'Day-before reminder sent to Ridgeline IT', lines[4]]);
  assert.ok(lines[4].startsWith('Ridgeline IT booked a call'), 'booked 5 days ago, last');
  assert.ok(!h.includes('Call with Ridgeline IT done'), 'older than 7 days: gone');
  assert.ok(h.includes('onclick="openInquiry(&quot;q9&quot;)"'));
  const many = Array.from({ length: 45 }, (_, i) => bk({ id: 'm' + i, status: 'lost', at: iso(NOW.getTime() - (i + 1) * 600000), slotStart: null, stageHistory: [] }));
  const h2 = hubOf(many); trialsIngestHub(h2);
  assert.equal(count(happenedOf(renderTrialList(h2, { now: NOW })), /class="feed-event"/g), 30);
  trialsForget();
});

test('Just happened: client news, alerts and new messages in Channels (opens #channels/{id}); everything escaped', () => {
  reset();
  const rows = tkListRows(simpleHub);
  const hub = hubOf([bk({ id: 'e1', company: '<img src=x onerror=alert(1)>', status: 'lost' })], { alerts: [{ id: 'a1', at: iso(NOW.getTime() - H), title: 'A <b>bounce</b>', clientId: null }] });
  hub.stages = simpleHub.stages; trialsIngestHub(hub);
  feed.channels = [{ id: 'c"1', name: 'Acme team', kind: 'client', lastMessageAt: iso(NOW.getTime() - 20 * 60000), unread: 2, archived: false }, { id: 'c2', name: 'old', kind: 'team', lastMessageAt: iso(NOW.getTime() - 9 * 86400000), unread: 0 }];
  const html = renderTrialList(hub, { now: NOW });
  assert.ok(!html.includes('<img src=x') && !html.includes('<b>bounce</b>') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const h = happenedOf(html);
  assert.ok(h.includes('New message in #Acme team') && h.includes('feedOpenChannel(&quot;c\\&quot;1&quot;)') && !h.includes('#old'));
  assert.ok(h.includes('A &lt;b&gt;bounce&lt;/b&gt;') && h.includes("openSettings('alerts')"));
  assert.ok(rows.length > 0);
  feed.channels = null; trialsForget();
});

test('the Clients page is the stage strip (only when stages.js is loaded) then the live list — none of the old pieces', () => {
  reset(); const hub = Object.assign({}, simpleHub); trialsIngestHub(hub);
  const calls = []; globalThis.renderStageStrip = (h, b) => { calls.push([h, b]); return '<div class="strip-test"></div>'; };
  try {
    const html = renderTrialList(hub, { now: NOW });
    assert.equal(calls.length, 1); assert.equal(calls[0][0], hub); assert.ok(Array.isArray(calls[0][1]));
    assert.ok(html.indexOf('strip-test') < html.indexOf('id="feedHost"'));
  } finally { delete globalThis.renderStageStrip; }
  const plain = renderTrialList(hub, { now: NOW });
  for (const gone of ['tk-money-sum', 'Received this month', 'Booked a sales call —', 'In progress', 'Not taken', 'Bookings ·', 'Add a paying client yourself', 'tk-stages']) assert.ok(!plain.includes(gone), gone);
  assert.equal(typeof openNewPayingClient, 'function', '⌘K "Add a paying client" keeps working');
  trialsForget();
});

test('live: a tick fetches and repaints only the list; nothing happens while the page is hidden or another page is open', async () => {
  reset(); const hub = hubOf([bk()]); trialsIngestHub(hub); tk.hub = hub; tk.hubAt = Date.now();
  const host = el('feedHost'); host.innerHTML = 'old'; el('tkHost').innerHTML = 'strip stays';
  const urls = [];
  globalThis.fetch = async (url) => { const u = new URL(url); urls.push(u.pathname); const body = u.pathname === '/api/mc/inquiries' ? { inquiries: [bk({ company: 'Fresh Co' })], counts: {} } : hub; return { ok: true, status: 200, text: async () => JSON.stringify(body) }; };
  currentView = 'paying';
  try {
    document.hidden = true; await feedTick(); assert.deepEqual(urls, [], 'hidden: paused'); assert.equal(host.innerHTML, 'old');
    document.hidden = false; await feedTick();
    assert.ok(urls.includes('/api/mc/hub') && urls.includes('/api/mc/inquiries'));
    assert.ok(host.innerHTML.includes('Fresh Co') && el('tkHost').innerHTML === 'strip stays', 'only the list is repainted');
    currentView = 'calendar'; urls.length = 0; feedStart(); await feedTick(); assert.deepEqual(urls, []); assert.equal(feed.timer, null, 'the timer stops when the page is left');
  } finally { document.hidden = false; offline(); feedStop(); currentView = 'paying'; trialsForget(); }
});

test('files: feed.js + feed.css are in index.html and `npm run check`; the timer refreshes every 15 seconds', () => {
  const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8'); const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.ok(idx.includes('<link rel="stylesheet" href="feed.css">') && idx.includes('<script src="feed.js"></script>') && pkg.includes('node --check feed.js'));
  assert.ok(idx.indexOf('<script src="inquiries.js"></script>') < idx.indexOf('<script src="feed.js"></script>'));
  assert.equal(FEED_REFRESH_MS, 15000);
});
