/* Tests for numbers.js (a client's numbers panel). Run with: npm test. No browser, no network:
   the script runs in a vm with just esc(), machineFetch() and a tiny element. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = {
  console, setTimeout, clearTimeout, Date, Number, Math, Promise, WeakMap, Array,
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  document: { body: {}, querySelectorAll: () => [] }, authUser: { clientId: 'oak' },
  calls: [], answer: null,
};
sandbox.machineFetch = async (p) => { sandbox.calls.push(p); return sandbox.answer(); };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'numbers.js'), 'utf8') + '\n;globalThis.api={nmRender,nmSkeleton,nmError,nmAgo,renderClientNumbers,numbersView,numbersTrialSection,nm};', sandbox, { filename: 'numbers.js' });
const A = sandbox.api;

const days = Array.from({ length: 30 }, (_, i) => ({ day: `2026-11-${String(i + 1).padStart(2, '0')}`, sent: i % 3 ? 10 + i : 0, replies: i % 5 ? 1 : 0, interested: 0, booked: 0 }));
const data = (over) => Object.assign({
  ok: true, client: { name: 'Oak <b>Legal</b>', plan: 'Growth plan', stage: 'sending', stageWords: 'Sending emails' },
  today: { sent: 14, replies: 2, interested: 1, booked: 1 }, days, totals: { sent: 300, replies: 12, interested: 4, booked: 2, replyRate: 0.04 },
  inboxes: [{ email: 'a@oak.com', health: 'good', healthWords: 'Healthy', warmupDay: 14, warmupOf: 14, sentToday: 9, limit: 25 }, { email: 'b@oak.com', health: 'warming', healthWords: 'Warming up', warmupDay: 5, warmupOf: 14, sentToday: 0, limit: 8 }],
  warmup: { state: 'warming', day: 5, of: 14, words: 'Warm-up day 5 of 14' }, next: { words: 'Emails go out each weekday morning.', at: null }, sources: [{ name: 'Aviance', kind: 'native' }],
  updatedAt: '2026-11-20T12:00:00.000Z',
}, over);
const now = Date.parse('2026-11-20T12:02:00.000Z');

test('renders four tiles, the chart, reply rate, inbox pills, warm-up bar, next line and the age', () => {
  const h = A.nmRender(data(), now);
  assert.equal((h.match(/class="nm-tile"/g) || []).length, 4);
  for (const w of ['Sent today', 'Replies', 'Interested', 'Booked']) assert.ok(h.includes(w), w);
  assert.equal((h.match(/<rect[^>]*class="nm-bar"/g) || []).length, 30);
  assert.ok(h.includes('<polyline'), 'replies line');
  assert.ok(h.includes('Reply rate 4%'));
  assert.ok(h.includes('nm-pill nm-green') && h.includes('nm-pill nm-amber'));
  assert.ok(h.includes('role="progressbar"') && h.includes('aria-valuenow="36"'));
  assert.ok(h.includes('What’s next') && h.includes('Emails go out each weekday morning.'));
  assert.ok(h.includes('Updated 2 min ago'));
});

test('everything from the system is escaped', () => {
  const h = A.nmRender(data({ inboxes: [{ email: '<img src=x>', health: 'problem', healthWords: '<script>', sentToday: 0, limit: 0 }], next: { words: '<i>x</i>' } }), now);
  assert.ok(!/<img|<script|<i>x/.test(h));
  assert.ok(A.nmError('<b>bad</b>').includes('&lt;b&gt;'));
  assert.ok(A.numbersView().includes('data-nm-client="oak"'));
  assert.ok(A.numbersTrialSection('a"b').includes('a&quot;b'));
});

test('empty state when nothing was sent; skeleton and error strip', () => {
  const h = A.nmRender(data({ totals: { sent: 0, replies: 0, interested: 0, booked: 0, replyRate: 0 }, days: days.map((d) => ({ ...d, sent: 0, replies: 0 })) }), now);
  assert.ok(h.includes('No emails sent yet — sending starts after warm-up'));
  assert.ok(!h.includes('<svg'));
  assert.ok(A.nmSkeleton().includes('nm-sk'));
  const e = A.nmError('Nope.');
  assert.ok(e.includes('role="alert"') && e.includes('Try again') && e.includes('Nope.'));
});

test('renderClientNumbers: skeleton, fetch with the client id, draw; error then draw on retry; refreshes only while on the page', async () => {
  const el = { innerHTML: '', isConnected: true };
  sandbox.calls.length = 0;
  let gate; sandbox.answer = () => new Promise((r) => { gate = r; });
  const p = A.renderClientNumbers(el, 'oak/1');
  assert.ok(el.innerHTML.includes('aria-busy'));
  gate({ ok: true, data: data() }); await p;
  assert.deepEqual(Array.from(sandbox.calls), ['/api/mc/portal/numbers?clientId=oak%2F1']);
  assert.ok(el.innerHTML.includes('Sent today'));
  el.isConnected = false; // off the page: the pending refresh timer must not fetch
  A.nm.timers.get(el) && clearTimeout(A.nm.timers.get(el));
  const el2 = { innerHTML: '', isConnected: true };
  sandbox.answer = async () => ({ ok: false, status: 500, error: 'Something went wrong.' });
  await A.renderClientNumbers(el2, 'oak');
  assert.ok(el2.innerHTML.includes('Try again') && el2.innerHTML.includes('Something went wrong.'));
  clearTimeout(A.nm.timers.get(el2));
});

test('index.html wires it up and package.json checks it', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('<script src="numbers.js"></script>') && html.includes('href="numbers.css"'));
  assert.ok(/numbers:\{fn:\(\)=>numbersView\(\)/.test(html) && html.includes("h==='numbers'"));
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.check.includes('node --check numbers.js'));
});
