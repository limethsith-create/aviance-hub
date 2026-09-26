/* Tests for their domain and inboxes through CheapInboxes (autobuy.js + its hooks in trials.js) —
   email-distributor/docs/AUTO-BUY.md. The owner buys in his own CheapInboxes account; the system finds the purchase
   and sets up the rest. It never buys anything, so nothing in the hub can place an order.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Same set-up as messages.test.mjs: the shell's inline script, then every section script exactly like the browser,
   with a tiny fake DOM and a fake Supabase client. The machine is a fake fetch that answers like the contract. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, simpleRows, simpleHub, stagesWith, fullHub, googleStates, autobuyBuy, autobuyStates, brightAb, cheapStates } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM (as in messages.test.mjs) ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, open: false, scrollTop: 0, scrollHeight: 900, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() { el._focused = (el._focused || 0) + 1; }, select() {}, submit() {}, addEventListener() {}, scrollIntoView() { el._scrolled = (el._scrolled || 0) + 1; }, closest() { return null; }, getAttribute() { return null; } };
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
for (const f of ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'push.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
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
const top = (d) => between(renderTrialDetail(d, 'overview', { now: NOW }), '<section class="card tk-top', '</section>');
const bigButtons = (h) => [...h.matchAll(/<button type="button" class="btn tk-primary" onclick="([^"]*)">([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
const stepClasses = (h) => [...h.matchAll(/<li class="(\w+)"(?: aria-current="step")?><span class="tk-oc-tick"/g)].map((m) => m[1]);
const toastText = () => visibleText(el('toast').innerHTML.replace(/&#39;/g, "'")).trim();
const BANNED = /\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|dns|jwt|config|payload|mission control|cron|redis|endpoint|webhook)\b/i;
const ID = 'bright-dental';
const hubWith = (r) => Object.assign({}, simpleHub, { stages: stagesWith({ intake: [simpleRows.fern], setup: [r], build: [simpleRows.gale], live: [simpleRows.acme] }) });
/* A fake machine for one trial: GET its detail / the board / the CheapInboxes status; POST autobuy and cheapinboxes. */
function machine(detail) {
  const st = { detail: clone(detail), ci: clone(cheapStates.not_set_up), calls: [], gate: null, next: {}, test: { ok: true, account: 'Aviance Ltd' } };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; st.calls.push([init.method, u.pathname, body]);
    if (u.pathname === '/api/mc/clients/' + ID + '/autobuy') {
      if (st.gate) await st.gate;
      const nx = st.next[body.action]; if (nx) st.detail = Object.assign({}, st.detail, { autobuy: typeof nx === 'function' ? nx(body) : clone(nx) });
      return ok({ ok: true, autobuy: st.detail.autobuy })();
    }
    if (u.pathname === '/api/mc/cheapinboxes') {
      if (init.method === 'GET') return ok(st.ci)();
      if (body.action === 'saveKey') { st.ci = clone(cheapStates.connected); return ok({ ok: true })(); }
      if (body.action === 'test') return st.test.ok ? ok(Object.assign({ ok: true }, st.test))() : { ok: false, status: 502, text: async () => JSON.stringify(st.test) };
      if (body.action === 'forget') { st.ci = clone(cheapStates.not_set_up); return ok({ ok: true })(); }
    }
    if (u.pathname === '/api/mc/hub/' + ID) return ok(st.detail)();
    if (u.pathname === '/api/mc/hub') return ok(hubWith(st.detail.row))();
    if (u.pathname === '/api/mc/alerts') return ok({ alerts: [] })();
    if (u.pathname === '/api/mc/google') return ok(googleStates.connected)();
    return ok({ ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 })();
  };
  st.posts = (p) => st.calls.filter((c) => c[0] === 'POST' && c[1] === p);
  st.gets = (p) => st.calls.filter((c) => c[0] === 'GET' && c[1] === p).length;
  return st;
}
const AB = '/api/mc/clients/' + ID + '/autobuy';
const openBright = async (status) => { asOwner(); trialsForget(); calendarForget(); asOwner(); const st = machine(brightAb(status)); tk.detail[ID] = clone(st.detail); tk.detailAt[ID] = Date.now(); trialsIngestHub(hubWith(st.detail.row)); openTrial(ID); await tick(); return st; };
/* The shopping list after "Buy this one instead": the other name becomes the one to buy. */
const pickedAs = (dom) => Object.assign(clone(autobuyStates.ready_to_buy), { domain: dom, label: 'Buy ' + dom + ' and 2 inboxes on CheapInboxes',
  buy: Object.assign(clone(autobuyBuy), { domain: dom, alternatives: [{ domain: 'getbrightdental.com', price: 9.99 }], mailboxes: autobuyBuy.mailboxes.map((m) => Object.assign({}, m, { email: m.prefix + '@' + dom })) }) });

/* ───────────── 1. ready to buy: the big button and the panel ───────────── */
test('ready to buy: the big button is "Buy their domain and 2 inboxes on CheapInboxes" (opens the panel); the Trials row says it in red; nothing else asks for the purchase', () => {
  const d = brightAb('ready_to_buy'); const t = top(d);
  assert.deepEqual(bigButtons(t), [['Buy their domain and 2 inboxes on CheapInboxes', 'abOpenBuy(&quot;bright-dental&quot;)']]);
  assert.ok(t.includes('<p class="tk-q-say">Buy getbrightdental.com and 2 inboxes in your CheapInboxes account. We set up everything after that by ourselves.</p>'));
  assert.ok(t.includes('<section class="card tk-top needs"'), 'his turn: the red edge');
  assert.ok(!t.includes('openTrialPurchase') && !t.includes('tk-q-hint'), 'not the Buy & paste page, no pointer to Settings');
  const page = renderTrialDetail(d, 'overview', { now: NOW });
  assert.ok(!page.includes('id="tkSec-autobuy"'), 'no progress card before the purchase');
  assert.ok(!page.includes('Also on your list'), 'the old "buy and paste" to-do is not listed again');
  // one inbox reads right
  const one = clone(d); one.autobuy.buy.mailboxes = one.autobuy.buy.mailboxes.slice(0, 1);
  assert.equal(bigButtons(top(one))[0][0], 'Buy their domain and 1 inbox on CheapInboxes');
  // the Trials list: under "Needs you", the machine's next step as "You need to…"
  const list = renderTrialList(hubWith(d.row), { now: NOW });
  assert.ok(between(list, 'Needs you</h3>', 'In progress</h3>').includes('Bright Dental'));
  assert.ok(between(list, 'Bright Dental', '</button>').includes('<span class="tk-person-you">You need to buy their domain and 2 inboxes on CheapInboxes.</span>'));
  // an order answer without a shopping list: the Buy & paste page as before
  const bare = clone(d); bare.autobuy.buy = null;
  assert.deepEqual(bigButtons(top(bare)), [['Buy the domain and inboxes', 'openTrialPurchase(&quot;bright-dental&quot;)']]);
});

test('the panel: exactly what to buy — the domain (+ 3 other free names), Google, both inboxes (first name, last name, email prefix, full address, each with Copy), Open CheapInboxes, then "I\'ve bought it — check now"', () => {
  const h = renderAutobuyBuy(brightAb('ready_to_buy'));
  assert.ok(h.includes('<h3>Buy their domain and 2 inboxes</h3>') && h.includes('<p>For Bright Dental, in your CheapInboxes account. We never buy anything ourselves.</p>'));
  assert.ok(h.includes('<div class="tk-abb-kv"><small>Domain</small><b>getbrightdental.com</b><button type="button" class="btn ghost tk-abb-copy" onclick="abCopy(&quot;getbrightdental.com&quot;)" aria-label="Copy the domain">Copy</button></div>'));
  assert.ok(h.includes('Price on CheapInboxes: <b>$9.99</b>.'));
  assert.ok(h.includes('Google, 2 inboxes. Give them exactly these names:'));
  const box2 = between(h, 'Inbox 2', '</div></div>');
  for (const [k, v] of [['First name', 'Raj'], ['Last name', 'Patel'], ['Email prefix', 'raj.patel'], ['Full address', 'raj.patel@getbrightdental.com']])
    assert.ok(box2.includes(`<small>${k}</small><b>${v.replace('@', '@<wbr>')}</b><button type="button" class="btn ghost tk-abb-copy" onclick="abCopy(&quot;${v}&quot;)"`), k + ' (a long address wraps after the @; Copy gives it whole)');
  assert.ok(between(h, 'Inbox 1', 'Inbox 2').includes('<small>Email prefix</small><b>raj</b>'));
  assert.equal(count(h, /class="btn ghost tk-abb-copy"/g), 9, 'Copy beside the domain and each of the 8 inbox details');
  assert.ok(h.includes('It is charged to the card on your CheapInboxes account.'));
  assert.ok(h.includes('<a class="btn tk-abb-open" href="https://www.cheapinboxes.com/order?domain=getbrightdental.com&amp;mailboxes=2" target="_blank" rel="noopener noreferrer">Open CheapInboxes ↗</a>'), 'their order page, in a new tab');
  assert.ok(h.includes("<p class=\"tk-abb-after\">After you buy, we connect everything by ourselves — you'll get a message.</p>"));
  assert.ok(h.includes('<button type="button" class="tk-textbtn" onclick="abRecheck(&quot;bright-dental&quot;,this)">I&#39;ve bought it — check now</button>') || h.includes('onclick="abRecheck(&quot;bright-dental&quot;,this)">I\'ve bought it — check now</button>'));
  // in that order: the domain, the inboxes, open CheapInboxes, then "after you buy" and "check now"
  const at = (s) => h.indexOf(s);
  assert.ok(at('1. The domain') < at('2. The inboxes') && at('2. The inboxes') < at('Open CheapInboxes') && at('Open CheapInboxes') < at('After you buy') && at('After you buy') < at('check now'));
  // up to 3 other free names, never the chosen one again, each "Buy this one instead" → pick
  const alts = between(h, '<details class="tk-abb-alts">', '</details>');
  assert.ok(alts.includes('<summary>Rather a different name? 3 more are free</summary>'));
  assert.deepEqual([...alts.matchAll(/onclick="abPick\(&quot;bright-dental&quot;,&quot;([^&]+)&quot;,this\)">Buy this one instead<\/button>/g)].map((m) => m[1]), ['brightdentalhq.com', 'trybrightdental.com', 'brightdental.co']);
  assert.ok(alts.includes('<b class="tk-break">trybrightdental.com</b> · $10.49'));
  assert.ok(h.includes('<button type="button" class="btn ghost" onclick="abCloseBuy()">Close</button>'));
  // Microsoft, a missing address (made from the prefix), missing names (left out), no price
  const d2 = brightAb('ready_to_buy'); d2.autobuy = clone(d2.autobuy); Object.assign(d2.autobuy.buy, { provider: 'microsoft', price: null, alternatives: [{ domain: 'only-one.com' }], mailboxes: [{ prefix: 'jo' }] });
  const h2 = renderAutobuyBuy(d2);
  assert.ok(h2.includes('Microsoft, 1 inbox. Give them exactly these names:') && h2.includes('<small>Full address</small><b>jo@<wbr>getbrightdental.com</b>') && !h2.includes('First name') && !h2.includes('Price on CheapInboxes'));
  assert.ok(h2.includes('Rather a different name? 1 more is free'));
  assert.ok(renderAutobuyBuy(brightAb('provisioning')).includes('Nothing to buy right now'), 'nothing left to buy');
});

test('the panel: every value is escaped, handler values go through tkAttr, and an odd order link is never followed', () => {
  const d = brightAb('ready_to_buy'); d.autobuy = clone(d.autobuy);
  Object.assign(d.autobuy.buy, { domain: '<img src=x onerror=alert(1)>.com', orderUrl: 'javascript:alert(2)', provider: '<b>p</b>', alternatives: [{ domain: '");alert(3);//', price: '<i>9</i>' }],
    mailboxes: [{ firstName: '<script>a</script>', lastName: '"><svg onload=alert(4)>', prefix: "x');alert(5);//", email: '<u>e</u>@x.com' }] });
  d.row = Object.assign({}, d.row, { simple: Object.assign({}, d.row.simple, { company: '<b>Evil</b>' }) });
  const h = renderAutobuyBuy(d);
  for (const bad of ['<img src=x', '<script>a', '<svg onload', '<u>e</u>', '<b>p</b>', '<b>Evil</b>', '<i>9</i>', 'javascript:']) assert.ok(!h.includes(bad), bad);
  assert.ok(h.includes('href="https://cheapinboxes.com"'), 'an odd order link falls back to CheapInboxes itself');
  assert.ok(h.includes('abPick(&quot;bright-dental&quot;,&quot;\\&quot;);alert(3);//&quot;,this)'), 'quotes stay inside the handler argument');
  assert.ok(!/onclick="[^"]*"[^>]*onclick=/.test(h.replace(/"\s+[a-z-]+="[^"]*"/g, '"')), 'no attribute breaks out');
});

test('the big button opens the panel; Copy copies; "Buy this one instead" posts {pick} once, greys the button while sending and redraws the panel from the answer', async () => {
  const st = await openBright('ready_to_buy');
  try {
    closeModal(); abOpenBuy(ID);
    assert.ok(el('modalWrap').classList.contains('open') && el('modal').innerHTML.includes('id="abBuy"') && el('modal').innerHTML.includes('<b>getbrightdental.com</b>'));
    clip.fail = false; abCopy('raj.patel'); await tick(); assert.equal(clip.text, 'raj.patel'); assert.equal(toastText(), 'Copied: raj.patel');
    clip.fail = true; abCopy('raj'); await tick(); assert.match(toastText(), /Couldn't copy — select it and copy it by hand/); clip.fail = false;
    // pick: one post, even when pressed twice; the button is greyed out until the answer is in
    st.next.pick = (b) => pickedAs(b.domain);
    let release; st.gate = new Promise((r) => { release = r; });
    const btn = { disabled: false };
    const first = abPick(ID, 'brightdentalhq.com', btn); await tick();
    assert.equal(btn.disabled, true, 'greyed out while sending');
    const second = await abPick(ID, 'brightdentalhq.com', { disabled: false });
    assert.equal(second.busy, true); assert.match(toastText(), /Still working on the last one/);
    release(); st.gate = null; const r = await first;
    assert.ok(r.ok); assert.equal(btn.disabled, false);
    assert.deepEqual(st.posts(AB).map((c) => c[2]), [{ action: 'pick', domain: 'brightdentalhq.com' }], 'sent once');
    assert.equal(toastText(), 'Changed. Buy brightdentalhq.com instead');
    assert.equal(tk.detail[ID].autobuy.buy.domain, 'brightdentalhq.com', 'the answer replaces the shopping list at once');
    assert.ok(el('modalWrap').classList.contains('open') && el('modal').innerHTML.includes('<small>Domain</small><b>brightdentalhq.com</b>') && el('modal').innerHTML.includes('raj.patel@<wbr>brightdentalhq.com'), 'the panel is redrawn with the new name');
    assert.ok(el('tkTop').outerHTML.includes('Buy brightdentalhq.com and 2 inboxes in your CheapInboxes account.'), 'the three questions follow');
    // opening the panel when there is nothing to buy
    tk.detail[ID] = clone(brightAb('provisioning')); closeModal(); abOpenBuy(ID);
    assert.ok(!el('modalWrap').classList.contains('open')); assert.match(toastText(), /isn't waiting for a domain/);
  } finally { offline(); trialsStopTimer(); closeModal(); }
});

test('"I\'ve bought it — check now": not there yet → says so, the panel stays; found → the panel closes and the card shows how far it is', async () => {
  const st = await openBright('ready_to_buy');
  try {
    abOpenBuy(ID);
    await abRecheck(ID, { disabled: false });
    assert.deepEqual(st.posts(AB).pop()[2], { action: 'recheck' });
    assert.equal(toastText(), "We don't see the purchase yet. It can take a few minutes to show up — we keep looking by ourselves");
    assert.ok(el('modalWrap').classList.contains('open'), 'still open: nothing found yet');
    st.next.recheck = autobuyStates.provisioning;
    await abRecheck(ID, { disabled: false });
    assert.equal(toastText(), 'Found it. Setting up getbrightdental.com — about 48 hours');
    assert.ok(!el('modalWrap').classList.contains('open'), 'nothing left to buy: the panel closes');
    assert.ok(el('tkAbHost').innerHTML.includes('<h3>Inboxes &amp; domain</h3>') && el('tkAbHost').innerHTML.includes('Setting up getbrightdental.com — about 48 hours'));
    assert.deepEqual(bigButtons(el('tkTop').outerHTML), [], 'nothing for him to do while it sets itself up (the row still says "Buy…" until it refreshes)');
    assert.ok(!el('tkTop').outerHTML.includes('tk-top needs') && el('tkTop').outerHTML.includes("Nothing — we'll tell you when something needs you"));
    await tick(); await tick();
    assert.ok(st.gets('/api/mc/hub/' + ID) >= 1 && st.gets('/api/mc/hub') >= 1, 'the page and the list refresh quietly behind it');
  } finally { offline(); trialsStopTimer(); closeModal(); }
});

/* ───────────── 2. after the purchase: the "Inboxes & domain" card ───────────── */
test('the card, per status: the steps ticked with times, the current one highlighted, the plain sentence, each inbox in words', () => {
  const card = (s) => renderAutobuyCard(brightAb(s));
  for (const s of ['not_set_up', 'ready_to_buy']) assert.equal(card(s), '', s + ': no card');
  assert.equal(renderAutobuyCard({ row: simpleRows.bright }), '', 'an older system: no card');
  const p = card('provisioning');
  assert.ok(p.startsWith('<section class="card tk-ab" id="tkSec-autobuy">') && p.includes('<h3>Inboxes &amp; domain</h3>') && p.includes('<p class="tk-ab-say">Setting up getbrightdental.com — about 48 hours</p>'));
  assert.deepEqual(stepClasses(p), ['done', 'now', 'todo', 'todo', 'todo']);
  assert.ok(p.includes('<li class="now" aria-current="step"><span class="tk-oc-tick" aria-hidden="true"></span><span><span class="tk-sr">Now: </span>Domain live + spam protection set</span><span class="tk-oc-at">Working on it</span></li>'));
  assert.ok(between(p, 'You bought it', '</li>').includes(`<span class="tk-oc-at" title="${tkFull('2026-10-16T10:00:00Z')}">`), 'when it was done (Sri Lanka time, whatever the device)');
  assert.equal(count(p, /<span class="pill amber">Being created<\/span>/g), 2);
  assert.ok(p.includes('<span class="tk-break">raj.patel@getbrightdental.com</span>'));
  const c = card('connecting');
  assert.deepEqual(stepClasses(c), ['done', 'done', 'done', 'now', 'todo']);
  assert.ok(c.includes('<span class="pill green">Connected</span>') && c.includes('<span class="pill blue">Created</span>'));
  const done = card('done');
  assert.deepEqual(stepClasses(done), ['done', 'done', 'done', 'done', 'done']);
  assert.ok(done.includes('getbrightdental.com and 2 inboxes are ready — warm-up has started') && !done.includes('aria-current') && !done.includes('tk-status red'));
  // failed: where it stopped, the problem in plain words and "Check now" (never a second purchase)
  const f = card('failed');
  assert.deepEqual(stepClasses(f), ['done', 'done', 'stuck', 'todo', 'todo']);
  assert.ok(f.includes('<li class="stuck" aria-current="step"><span class="tk-oc-tick" aria-hidden="true">!</span><span><span class="tk-sr">Stuck here: </span>2 inboxes created</span></li>'));
  assert.ok(f.includes('<p class="tk-status red">CheapInboxes could not create the inboxes because the card was declined. Update the card in your CheapInboxes account under Billing, then press Check now.</p>'));
  assert.ok(f.includes('<button type="button" class="btn" onclick="abRecheck(&quot;bright-dental&quot;,this)">Check now</button>'));
  assert.ok(!/Try again|retry|Buy/i.test(visibleText(f)), 'no retry, nothing to buy again');
  // an unknown inbox status and a missing label still read
  const odd = brightAb('provisioning'); odd.autobuy = Object.assign(clone(odd.autobuy), { label: '', mailboxes: [{ email: 'a@b.com', status: 'queued_up' }] });
  const o = renderAutobuyCard(odd);
  assert.ok(o.includes('<p class="tk-ab-say">Setting up getbrightdental.com</p>') && o.includes('<span class="pill grey">Queued up</span>'));
  // still to buy while something more urgent has the big button: a small card keeps the way to "what to buy"
  const busy = clone(brightAb('ready_to_buy')); busy.conversation = { thread: [{ dir: 'in', at: '2026-10-17T09:00:00Z', subject: 'Hi', text: 'A question' }], needsReply: true, canReply: true };
  assert.equal(bigButtons(top(busy))[0][0], "Answer Raj's message");
  const small = between(renderTrialDetail(busy, 'overview', { now: NOW }), '<div id="tkAbHost">', '</section>');
  assert.ok(small.includes('<p class="tk-ab-say">Waiting for you to buy getbrightdental.com and 2 inboxes on CheapInboxes.</p>') && small.includes('<button type="button" class="btn ghost" onclick="abOpenBuy(&quot;bright-dental&quot;)">See what to buy</button>'));
  assert.equal(renderAutobuyCard(busy, { primary: 'autobuy' }), '', 'when the big button is the purchase itself, no second way in');
  // escaped
  const evil = brightAb('failed'); evil.autobuy = Object.assign(clone(evil.autobuy), { label: '<img src=x onerror=alert(1)>', problem: '<script>x</script>', mailboxes: [{ email: '<b>m</b>', status: '<i>s</i>' }], steps: [{ key: 'bought', label: '<svg onload=alert(2)>', done: true, at: 'nope' }] });
  const e = renderAutobuyCard(evil);
  for (const bad of ['<img src=x', '<script>x', '<b>m</b>', '<i>s</i>', '<svg onload']) assert.ok(!e.includes(bad), bad);
});

test('the big button while CheapInboxes sets them up: nothing to do (even with the old "buy" to-do still on the row); when it fails, "See what went wrong" goes to the card', async () => {
  for (const s of ['provisioning', 'connecting', 'done']) {
    const d = brightAb(s); const t = top(d);
    assert.deepEqual(bigButtons(t), [], s + ': no button');
    assert.ok(t.includes("<p class=\"tk-q-none\">Nothing — we'll tell you when something needs you</p>"), s);
    assert.ok(!t.includes('Buy the domain') && !t.includes('openTrialPurchase'), s + ': never the Buy & paste page');
    const page = renderTrialDetail(d, 'overview', { now: NOW });
    assert.ok(!page.includes('Also on your list') && page.includes('id="tkSec-autobuy"'), s + ': the old to-do is not listed; the card is');
    assert.ok(page.indexOf('id="tkSec-messages"') < page.indexOf('id="tkSec-autobuy"'), s + ': the card comes after Messages');
  }
  assert.ok(top(brightAb('provisioning')).includes('<p class="tk-q-text">We connect the inboxes by ourselves.</p>'), 'what happens next: the machine\'s own words');
  const f = top(brightAb('failed'));
  assert.deepEqual(bigButtons(f), [['See what went wrong', 'tkGoTo(&quot;autobuy&quot;)']]);
  assert.ok(f.includes('<p class="tk-q-say">CheapInboxes could not create the inboxes because the card was declined. Update the card in your CheapInboxes account under Billing, then press Check now.</p>'));
  const noWords = brightAb('failed'); noWords.autobuy = Object.assign(clone(noWords.autobuy), { problem: null });
  assert.ok(top(noWords).includes('Setting up their inboxes ran into a problem.'));
  // the button takes him to the card
  await openBright('failed');
  try { el('tkSec-autobuy')._scrolled = 0; tkGoTo('autobuy'); assert.equal(el('tkSec-autobuy')._scrolled, 1); } finally { offline(); trialsStopTimer(); }
});

test('"Wrong domain? Undo" only before anything is connected; it asks first and posts {unlink}; "Check now" posts {recheck}', async () => {
  const has = (s) => renderAutobuyCard(brightAb(s)).includes('Wrong domain? <button type="button" class="tk-textbtn" onclick="abUnlink(&quot;bright-dental&quot;,this)">Undo</button>');
  assert.deepEqual(['provisioning', 'connecting', 'done', 'failed'].map(has), [true, false, false, true], 'connecting has a connected inbox; done is done');
  const stepOnly = brightAb('provisioning'); stepOnly.autobuy = Object.assign(clone(stepOnly.autobuy), { mailboxes: [], steps: stepOnly.autobuy.steps.map((x) => Object.assign({}, x, { done: x.key === 'connected' || x.done })) });
  assert.equal(abCanUndo(tkAutobuy(stepOnly)), false, 'the "connected" step done: too late to undo');
  const st = await openBright('provisioning');
  let asked = null;
  try {
    globalThis.confirm = (q) => { asked = q; return false; };
    await abUnlink(ID, { disabled: false });
    assert.equal(asked, "Undo? getbrightdental.com will no longer be linked to Raj Patel. Do this only if it isn't their domain. Nothing is deleted at CheapInboxes.");
    assert.equal(st.posts(AB).length, 0, 'no → nothing sent');
    globalThis.confirm = () => true; st.next.unlink = autobuyStates.ready_to_buy;
    await abUnlink(ID, { disabled: false });
    assert.deepEqual(st.posts(AB).pop()[2], { action: 'unlink' });
    assert.equal(toastText(), 'Undone. getbrightdental.com is no longer linked to them');
    assert.equal(el('tkAbHost').innerHTML, '', 'the card is gone');
    assert.deepEqual(bigButtons(el('tkTop').outerHTML), [['Buy their domain and 2 inboxes on CheapInboxes', 'abOpenBuy(&quot;bright-dental&quot;)']], 'back to buying');
    // failed → Check now
    st.detail = clone(brightAb('failed')); tk.detail[ID] = clone(st.detail); st.next.recheck = null;
    await abRecheck(ID, { disabled: false });
    assert.deepEqual(st.posts(AB).pop()[2], { action: 'recheck' });
    assert.equal(toastText(), 'Checked. The problem is still there — see the card');
  } finally { offline(); trialsStopTimer(); }
});

/* ───────────── 3. not set up: the Buy & paste page as before ───────────── */
test('CheapInboxes not set up: the Buy & paste page as before, and one line pointing to Settings; an older system (no autobuy) gets no pointer', async () => {
  const t = top(brightAb('not_set_up'));
  assert.ok(t.includes('<p class="tk-q-say">You need to buy the domain and 2 inboxes, then paste the logins.</p>'), 'the machine\'s own words, as before');
  assert.deepEqual(bigButtons(t), [['Buy the domain and inboxes', 'openTrialPurchase(&quot;bright-dental&quot;)']]);
  assert.ok(t.includes('<p class="tk-q-hint">Want the setup done for you? You buy on CheapInboxes, we do the rest. <button type="button" class="tk-textbtn" onclick="openSettings(&quot;inboxes&quot;)">Set up CheapInboxes in Settings</button></p>'));
  assert.equal(count(t, /class="btn tk-primary"/g), 1, 'still one big button');
  const old = top({ row: simpleRows.bright });
  assert.deepEqual(bigButtons(old), [['Buy the domain and inboxes', 'openTrialPurchase(&quot;bright-dental&quot;)']]);
  assert.ok(!old.includes('tk-q-hint') && !old.includes('CheapInboxes'), 'an older system knows nothing about it: no pointer');
  asOwner(); trialsForget(); asOwner(); machine(brightAb('not_set_up'));
  try {
    openSettings('inboxes'); await tick();
    assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.inboxes, true);
    assert.ok(el('content').innerHTML.includes('<details class="tk-set" id="tkSet-inboxes" open'));
  } finally { offline(); trialsStopTimer(); }
});

/* ───────────── 4. Settings › Inboxes & domains ───────────── */
test('Settings › Inboxes & domains: the status in words (Not set up / Connected as … / Problem — …), the card on file, the numbered steps, the key box, and the buttons each state allows', () => {
  const R = (data, more) => renderAutobuySet(Object.assign({ data }, more));
  const n = R(cheapStates.not_set_up);
  assert.equal(n.state, '<span class="pill grey">Not set up</span>');
  assert.ok(n.body.includes("<p class=\"tk-status grey\">Not set up. Do the steps below once — about 10 minutes. After that you buy each trial's domain and inboxes on CheapInboxes, and we set up the rest by ourselves.</p>"));
  const steps = between(n.body, '<ol class="tk-gm-steps">', '</ol>');
  assert.deepEqual([...steps.matchAll(/<li><b>([^<]+)<\/b>/g)].map((m) => m[1]), ['Make an account at CheapInboxes.', 'Add a card.', 'Create an API key.', 'Paste it here.', 'Press Save.', 'Press Test it']);
  assert.ok(steps.includes('<a href="https://cheapinboxes.com" target="_blank" rel="noopener noreferrer">cheapinboxes.com</a>') || /<a [^>]*href="https:\/\/cheapinboxes\.com"[^>]*>cheapinboxes\.com<\/a>/.test(steps));
  assert.ok(steps.includes('open Billing and add a card') && steps.includes('we never buy anything ourselves') && steps.includes('It starts with <b>ci_live_</b>'));
  assert.ok(steps.includes('<input id="abKey" data-tk-form type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ci_live_…">'), 'a password box: the key is never shown');
  assert.ok(steps.includes('<button type="button" class="btn" onclick="abSaveKey(this)">Save</button>'));
  assert.ok(!n.body.includes('abTest(') && !n.body.includes('abForget(') && !n.body.includes('tk-gm-more'), 'not set up: steps open, nothing to test or forget');
  const c = R(cheapStates.connected);
  assert.equal(c.state, '<span class="pill green">Connected</span>');
  assert.ok(c.body.includes('<p class="tk-status green">Connected as Aviance Ltd. When you buy a domain and inboxes there, we find them and set everything up by ourselves.</p>'));
  assert.ok(c.body.includes('A card is on file. What you buy on CheapInboxes is charged to it.'));
  assert.ok(c.body.includes('<button type="button" class="btn" onclick="abTest(this)">Test it</button><button type="button" class="btn ghost" onclick="abForget(this)">Forget the key</button>'));
  assert.ok(c.body.includes('<details class="tk-gm-more"><summary>The set-up steps, and changing your key</summary>') && c.body.includes('Yours is saved (hidden). Paste a new one only to replace it.'));
  assert.ok(!c.body.includes('Instant updates'), 'updates on: nothing to say');
  assert.ok(R(cheapStates.noCard).body.includes('<p class="tk-ab-warn">No card on file yet. Add a card in your CheapInboxes account under Billing.</p>'));
  assert.ok(R(cheapStates.noUpdates).body.includes('Instant updates from CheapInboxes are off, so we look for changes every few minutes instead. To turn them on, paste your key again and press Save.'));
  const b = R(cheapStates.broken);
  assert.equal(b.state, '<span class="pill red">Problem</span>');
  assert.ok(b.body.includes('<p class="tk-status red">Problem — CheapInboxes turned the key down — it may have been deleted. Paste a new key in step 4 and press Save.</p>'));
  assert.ok(R(Object.assign({}, cheapStates.broken, { problem: null })).body.includes("Problem — CheapInboxes doesn't accept your key any more."));
  // the last test, loading and errors
  assert.ok(R(cheapStates.connected, { test: { ok: true, account: 'Aviance Ltd' } }).body.includes('<p class="tk-status green">It works. CheapInboxes answered as Aviance Ltd.</p>'));
  assert.ok(R(cheapStates.connected, { test: { ok: false, error: 'The key was turned down' } }).body.includes("<p class=\"tk-status red\">The test didn't work: The key was turned down</p>"));
  assert.ok(renderAutobuySet({}).body.includes('Checking CheapInboxes…') && renderAutobuySet({}).state === '');
  assert.ok(renderAutobuySet({ err: 'Offline' }).body.includes('Offline <button type="button" class="tk-textbtn" onclick="abSetRetry()">Try again</button>'));
  // escaped, plain words
  const evil = R(Object.assign({}, cheapStates.broken, { account: '<b>x</b>', problem: '<img src=x onerror=alert(1)>' }), { test: { ok: false, error: '<script>y</script>' } });
  assert.ok(!evil.body.includes('<img src=x') && !evil.body.includes('<script>y'));
  for (const s of Object.values(cheapStates)) { const t = visibleText(R(s, { trials: [{ id: ID, company: 'Bright Dental' }] }).body); assert.ok(!BANNED.test(t), s.status + ': ' + (t.match(BANNED) || [])[0]); }
  // in Settings, after Google Meet and before the reply bot
  const set = renderSettings({ hub: fullHub, alerts: [], open: { inboxes: true }, google: { data: googleStates.connected }, inboxes: { data: cheapStates.connected }, now: NOW });
  assert.ok(set.includes('<details class="tk-set" id="tkSet-inboxes" open ontoggle="trialsSettingsToggle(&quot;inboxes&quot;,this.open)"><summary><span class="tk-set-head"><span class="tk-set-title">Inboxes &amp; domains</span><span class="tk-set-sub">You buy on CheapInboxes, we set up the rest.</span></span><span class="pill green">Connected</span></summary>'));
  assert.ok(set.indexOf('id="tkSet-google"') < set.indexOf('id="tkSet-inboxes"') && set.indexOf('id="tkSet-inboxes"') < set.indexOf('id="tkSet-replybot"'));
});

test('Settings › Inboxes & domains: purchases we could not match — "This is for…" lists the trials in the Setting-up step, then Link it', () => {
  const b = renderAutobuySet({ data: cheapStates.unmatched, trials: [{ id: ID, company: 'Bright Dental' }] }).body;
  assert.ok(b.includes('<h4 class="tk-set-h4">Bought, but not matched to a trial</h4>'));
  const first = between(b, 'brightdental-mail.com', '</li>');
  assert.ok(first.includes(`· 2 inboxes · bought ${tkDayName('2026-10-16T10:00:00Z')}`));
  assert.ok(first.includes('<label for="abUn0">This is for…</label>') && first.includes('<select id="abUn0" data-tk-form><option value="">Pick a trial</option><option value="bright-dental">Bright Dental</option></select>'));
  assert.ok(first.includes('<button type="button" class="btn" onclick="abLink(&quot;brightdental-mail.com&quot;,&quot;abUn0&quot;,this)">Link it</button>'));
  assert.ok(between(b, 'odd-name.io', '</li>').includes('· 1 inbox</span>') && b.includes('id="abUn1"'));
  assert.ok(renderAutobuySet({ data: cheapStates.unmatched, trials: [] }).body.includes('<p class="tk-ab-none">No trial is waiting for a domain right now.</p>'));
  assert.ok(!renderAutobuySet({ data: cheapStates.connected }).body.includes('not matched'), 'nothing unmatched: nothing shown');
  // only trials in the Setting-up step (not warming up, not sending, not new)
  trialsIngestHub(hubWith(simpleRows.bright));
  assert.deepEqual(abSetupTrials(), [{ id: ID, company: 'Bright Dental' }]);
  const evil = renderAutobuySet({ data: Object.assign({}, cheapStates.connected, { unmatched: [{ domain: '");alert(1);//<b>', mailboxes: 'x' }] }), trials: [{ id: 'a"b', company: '<i>c</i>' }] }).body;
  assert.ok(!evil.includes('//<b>') && !evil.includes('<i>c</i>') && evil.includes('value="a&quot;b"') && evil.includes('abLink(&quot;\\&quot;);alert(1);//&lt;b&gt;&quot;,&quot;abUn0&quot;,this)'));
});

test('Settings › Inboxes & domains: Save / Test it / Forget / Link it post the contract bodies; the key never stays on the page; the status is asked for once per visit', async () => {
  asOwner(); trialsForget(); calendarForget(); asOwner();
  const st = machine(brightAb('ready_to_buy'));
  let asked = null; globalThis.confirm = (q) => { asked = q; return true; };
  const CI = '/api/mc/cheapinboxes';
  try {
    render('settings'); await tick();
    assert.equal(st.gets(CI), 1, 'opening Settings asks for the status once');
    assert.ok(el('tkHost').innerHTML.includes('<span class="tk-set-title">Inboxes &amp; domains</span>') && el('tkHost').innerHTML.includes('<span class="pill grey">Not set up</span>'));
    await trialsTick(); assert.equal(st.gets(CI), 1, 'the 60-second refresh does not ask again');
    // Save: a key is needed, and it must look like one
    el('abKey').value = '  '; await abSaveKey(null); assert.equal(st.posts(CI).length, 0); assert.equal(toastText(), 'Paste your API key first');
    el('abKey').value = 'sk_live_123'; await abSaveKey(null); assert.equal(st.posts(CI).length, 0); assert.match(toastText(), /isn't a CheapInboxes API key — it starts with ci_live_/);
    el('abKey').value = ' ci_live_abc123 '; asked = null; const btn = { disabled: false };
    await abSaveKey(btn);
    assert.deepEqual(st.posts(CI).pop()[2], { action: 'saveKey', apiKey: 'ci_live_abc123' });
    assert.equal(asked, null, 'saving asks nothing'); assert.equal(btn.disabled, false);
    assert.equal(toastText(), 'Saved. Now press Test it.');
    assert.equal(el('abKey').value, '', 'the key is cleared from the box');
    assert.ok(!el('tkHost').innerHTML.includes('ci_live_abc123'), 'and never drawn on the page');
    assert.equal(st.gets(CI), 2, 'the status is read again');
    assert.ok(el('tkHost').innerHTML.includes('id="tkSet-inboxes" open') && el('tkHost').innerHTML.includes('Connected as Aviance Ltd.'), 'redrawn, the section stays open');
    // Test it
    await abTest(null); assert.deepEqual(st.posts(CI).pop()[2], { action: 'test' });
    assert.ok(el('tkHost').innerHTML.includes('It works. CheapInboxes answered as Aviance Ltd.'));
    st.test = { ok: false, error: 'CheapInboxes turned the key down' }; await abTest(null);
    assert.ok(el('tkHost').innerHTML.includes("The test didn't work: CheapInboxes turned the key down"));
    // Forget: asks first; no → nothing sent
    globalThis.confirm = (q) => { asked = q; return false; }; const n = st.posts(CI).length; await abForget(null); assert.equal(st.posts(CI).length, n);
    assert.equal(asked, 'Forget your CheapInboxes key? We stop finding and setting up new purchases until you paste it again. Nothing is deleted at CheapInboxes.');
    globalThis.confirm = () => true; await abForget(null); assert.deepEqual(st.posts(CI).pop()[2], { action: 'forget' });
    assert.ok(el('tkHost').innerHTML.includes('<span class="pill grey">Not set up</span>') && toastText() === 'The key is forgotten');
    // Link it: a purchase we couldn't match becomes this trial's
    st.ci = clone(cheapStates.unmatched); await loadCheapInboxes(true); trialsRepaint('settings');
    assert.ok(el('tkHost').innerHTML.includes('<option value="bright-dental">Bright Dental</option>'));
    el('abUn0').value = ''; await abLink('brightdental-mail.com', 'abUn0', null);
    assert.equal(st.posts(AB).length, 0); assert.equal(toastText(), 'Pick the trial it is for first');
    st.next.link = autobuyStates.provisioning; tk.detail[ID] = clone(st.detail);
    el('abUn0').value = ID; globalThis.confirm = (q) => { asked = q; return true; };
    await abLink('brightdental-mail.com', 'abUn0', { disabled: false });
    assert.equal(asked, 'Link brightdental-mail.com to Bright Dental? We start setting it up for them right away.');
    assert.deepEqual(st.posts(AB).pop()[2], { action: 'link', domain: 'brightdental-mail.com' });
    assert.equal(toastText(), 'Linked. We set up brightdental-mail.com for Bright Dental now');
    assert.equal(tk.detail[ID].autobuy.status, 'provisioning', 'the trial knows at once');
    assert.equal(st.gets(CI), 7, 'the list of unmatched purchases is read again');
    assert.ok(el('tkHost').innerHTML.includes('id="tkSet-inboxes" open'), 'the section stays open');
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 5. plain words, and nothing can spend money ───────────── */
test('plain words on the top of the trial, the panel, the card and the list; the hub can only ask to recheck / pick / link / unlink — never to buy', () => {
  for (const s of Object.keys(autobuyStates)) {
    const d = brightAb(s);
    for (const [where, h] of [['top', top(d)], ['card', renderAutobuyCard(d)], ['panel', renderAutobuyBuy(d)]]) {
      const t = visibleText(h);
      assert.ok(!BANNED.test(t), s + ' ' + where + ': ' + (t.match(BANNED) || [])[0]);
      assert.ok(!/\b[a-z]+_[a-z_]+\b/.test(t), s + ' ' + where + ': no snake_case — ' + (t.match(/\b[a-z]+_[a-z_]+\b/) || [])[0]);
    }
  }
  const list = visibleText(renderTrialList(hubWith(brightAb('provisioning').row), { now: NOW }));
  assert.ok(list.includes('Step 3 of 5 — Setting up') && list.includes('Setting up their inboxes (about 2 days)'), 'step ③ carries the machine\'s own sentence');
  assert.ok(!BANNED.test(list));
  const src = fs.readFileSync(path.join(root, 'autobuy.js'), 'utf8');
  assert.deepEqual([...new Set([...src.matchAll(/action:'(\w+)'/g)].map((m) => m[1]))].sort(), ['forget', 'link', 'pick', 'recheck', 'saveKey', 'test', 'unlink']);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/expectCents|checkout|\/orders|'buy'|"buy"/.test(code), 'no way to place an order');
});

/* ───────────── 6. files, touch targets, the phone ───────────── */
test('files: autobuy.js is loaded after messages.js and before push.js and syntax-checked; touch targets 44 px+; nothing wider than a phone; ⌘K; signing out forgets', () => {
  assert.ok(html.indexOf('<script src="messages.js"></script>') < html.indexOf('<script src="autobuy.js"></script>') && html.indexOf('<script src="autobuy.js"></script>') < html.indexOf('<script src="push.js"></script>'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.check.includes('node --check autobuy.js'));
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  for (const [sel, px] of [['.btn.tk-abb-copy', 44], ['.tk-abb-alts>summary', 48], ['.tk-ab-pickrow select', 46], ['.tk-ab .btn', 46], ['.tk-textbtn', 44]]) {
    const rule = css.match(new RegExp(sel.replace(/[.>]/g, (c) => '\\' + c).replace(/ /g, '\\s') + '\\{([^}]*)\\}'));
    assert.ok(rule && new RegExp('min-height:' + px + 'px').test(rule[1]), sel + ' ≥ ' + px + ' px');
  }
  assert.match(css, /\.tk-ab-pickrow select\{[^}]*font-size:var\(--fs-strong\)/, '17 px in the picker (no iPhone zoom)');
  assert.ok(/@media\(max-width:560px\)\{\.tk-ab\{padding:16px 14px\}[^\n]*\.tk-abb-kv\{grid-template-columns:minmax\(0,1fr\) auto\}/.test(css), 'on a phone: the label above, the value and Copy side by side');
  assert.ok(!/\.tk-ab[^{]*\{[^}]*(width:\s*\d{3,}px|min-width:\s*\d{3,}px)/.test(css), 'nothing wider than a phone');
  assert.ok(trialsCmdkActions().some((a) => a.label === 'Inboxes & domains' && a.sub === 'Settings › your CheapInboxes account'));
  abState.s = { status: 'connected' }; abState.open = ID; abState.test = { ok: true };
  trialsForget();
  assert.deepEqual([abState.s, abState.open, abState.test, abState.busy], [null, null, null, false]);
});
