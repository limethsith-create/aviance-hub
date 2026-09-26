/* Tests for the warm-up (warmup.js + its hooks in trials.js and index.html) — email-distributor/docs/WARMUP-HUB.md.
   Settings › Warm-up (the circle meter, why helpers exist, the helpers with Test / Remove, Add a helper), the "Warm-up"
   card on a trial, the big "Add N warm-up helpers" button, #settings/warmup and the {view:'settings', section} to-do.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Same set-up as autobuy.test.mjs: the shell's inline script, then every section script exactly like the browser,
   with a tiny fake DOM and a fake Supabase client. The system is a fake fetch that answers like the contract. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, simpleRows, simpleHub, stagesWith, fullHub, googleStates, cheapStates, warmupProviders, warmupStates, galeWarmup, galeWarmupTodo, galeWu, gale } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM (as in autobuy.test.mjs) ───────────── */
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
for (const f of ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'warmup.js', 'push.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
supa.session = { access_token: 'test-token' };
after(() => { trialsStopTimer(); calendarStopTimer(); });

const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const count = (s, re) => (s.match(re) || []).length;
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const no = (status, body) => ({ ok: false, status, text: async () => JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 5));
const between = (s, a, b) => { const i = s.indexOf(a); const j = b ? s.indexOf(b, i + 1) : s.length; return s.slice(i, j < 0 ? s.length : j); };
const visibleText = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
const offline = () => { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; globalThis.confirm = () => true; };
const top = (d) => between(renderTrialDetail(d, 'overview', { now: NOW }), '<section class="card tk-top', '</section>');
const bigButtons = (h) => [...h.matchAll(/<button type="button" class="btn tk-primary" onclick="([^"]*)">([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
const toastText = () => visibleText(el('toast').innerHTML.replace(/&#39;/g, "'")).trim();
const BANNED = /\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|dns|jwt|config|payload|mission control|cron|redis|endpoint|webhook)\b/i;
const SNAKE = /\b[a-z]+_[a-z_]+\b/;
const GALE = 'gale-roofing';
const WU = '/api/mc/warmup';
const hubWith = (r) => Object.assign({}, simpleHub, { stages: stagesWith({ intake: [simpleRows.fern], setup: [simpleRows.bright], build: [r], live: [simpleRows.acme] }) });
/* A fake system: GET/POST the warm-up circle (adding a helper grows the circle; a remove shrinks the list), Gale's trial, the board. */
function machine(detail, wu) {
  const st = { detail: clone(detail || galeWu('warming')), wu: clone(wu || warmupStates.short), calls: [], gate: null, addFail: null, testAnswer: null };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; st.calls.push([init.method, u.pathname, body]);
    if (u.pathname === WU) {
      if (init.method === 'GET') return ok(st.wu)();
      if (st.gate) await st.gate;
      if (body.action === 'addHelper') {
        if (st.addFail) return no(400, { error: st.addFail });
        st.wu.helpers = st.wu.helpers.concat([{ email: body.email, provider: body.provider, providerLabel: 'Gmail', health: 'ok', problem: null }]);
        const c = st.wu.circle; st.wu.circle = Object.assign({}, c, { members: c.members + 1, helpers: c.helpers + 1, missing: Math.max(0, c.missing - 1), label: null });
        return ok({ ok: true, email: body.email, provider: body.provider })();
      }
      if (body.action === 'testHelper') return st.testAnswer ? st.testAnswer(body) : ok({ ok: true, helper: { email: body.email, health: 'ok' } })();
      if (body.action === 'removeHelper') { st.wu.helpers = st.wu.helpers.filter((h) => h.email !== body.email); return ok({ ok: true })(); }
    }
    if (u.pathname === '/api/mc/hub/' + GALE) return ok(st.detail)();
    if (u.pathname === '/api/mc/hub') return ok(hubWith(st.detail.row))();
    if (u.pathname === '/api/mc/alerts') return ok({ alerts: [] })();
    if (u.pathname === '/api/mc/google') return ok(googleStates.connected)();
    if (u.pathname === '/api/mc/cheapinboxes') return ok(cheapStates.connected)();
    return ok({ ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 })();
  };
  st.posts = () => st.calls.filter((c) => c[0] === 'POST' && c[1] === WU).map((c) => c[2]);
  st.gets = () => st.calls.filter((c) => c[0] === 'GET' && c[1] === WU).length;
  return st;
}
const fresh = () => { asOwner(); trialsForget(); calendarForget(); asOwner(); };
const openWarmup = async (wu) => { fresh(); const st = machine(null, wu); openSettings('warmup'); await tick(); return st; };
const R = (data, more) => renderWarmupSet(Object.assign({ data }, more));

/* ───────────── 1. the circle meter ───────────── */
test('Settings › Warm-up: the circle meter says how full the circle is ("6 of 8 … add 2 more helpers", amber; green when ready), one square per place, who is in it; the one line on why; the state in the Settings list', () => {
  const s = R(warmupStates.short);
  assert.equal(s.state, '<span class="pill amber" id="wuPill">Add 2 more</span>');
  const meter = between(s.body, '<div class="tk-wu-meter', '<p class="tk-set-text">');
  assert.ok(meter.startsWith('<div class="tk-wu-meter amber"><p class="tk-wu-count">6 of 8 in the warm-up circle — add 2 more helpers</p>'));
  assert.equal(count(meter, /class="tk-wu-slot on"/g), 6); assert.equal(count(meter, /class="tk-wu-slot"/g), 2, '8 places, 6 taken');
  assert.ok(meter.includes('<span class="tk-wu-slots" aria-hidden="true">'), 'the squares are decoration: the sentence says it');
  assert.ok(meter.includes('<p class="tk-wu-who">In the circle: 3 helpers · 2 Aviance inboxes · 1 trial inbox</p>'));
  assert.ok(s.body.includes('<p class="tk-set-text">Helpers are free email accounts that trade friendly emails with new inboxes so Gmail and Outlook learn to trust them. Make them once; they help every client.</p>'));
  assert.ok(s.body.indexOf('tk-wu-meter') < s.body.indexOf('Helpers are free') && s.body.indexOf('Helpers are free') < s.body.indexOf('Your helpers') && s.body.indexOf('Your helpers') < s.body.indexOf('Add a helper'), 'meter, why, helpers, add');
  // ready: green, every place filled (more members than places: still 8 squares)
  const r = R(warmupStates.ready);
  assert.equal(r.state, '<span class="pill green" id="wuPill">Ready</span>');
  assert.ok(r.body.includes('<div class="tk-wu-meter green"><p class="tk-wu-count">9 in the warm-up circle — enough for new inboxes</p>'));
  assert.equal(count(r.body, /class="tk-wu-slot on"/g), 8); assert.equal(count(r.body, /class="tk-wu-slot"/g), 0);
  // no helpers yet
  const e = R(warmupStates.empty);
  assert.equal(e.state, '<span class="pill amber" id="wuPill">Add 5 more</span>');
  assert.ok(e.body.includes('In the circle: 0 helpers · 2 Aviance inboxes · 1 trial inbox'));
  assert.ok(e.body.includes('<p class="tk-set-text">No helpers yet. Add the first one below — it takes about 5 minutes.</p>'));
  // no sentence from the system: made from the numbers (one more → "helper")
  const one = R(warmupStates.oneShort);
  assert.ok(one.body.includes('<p class="tk-wu-count">7 of 8 in the warm-up circle — add 1 more helper</p>'));
  assert.equal(one.state, '<span class="pill amber" id="wuPill">Add 1 more</span>');
  assert.deepEqual(wuCircle({ circle: { members: 8, min: 8 } }), { members: 8, min: 8, helpers: null, clients: null, aviance: null, ready: true, missing: 0, label: '8 members in the warm-up circle — enough to warm up new inboxes' });
  // an older system (no `circle`): counted from its members and minPool
  const old = R(warmupStates.older);
  assert.ok(old.body.includes('<p class="tk-wu-count">5 of 8 in the warm-up circle — add 3 more helpers</p>') && old.body.includes('In the circle: 2 helpers</p>'));
  // loading, then an error with Try again — never a blank section
  const loading = R(null);
  assert.equal(loading.state, ''); assert.ok(loading.body.includes('Checking the warm-up circle…'));
  const err = R(null, { err: 'Offline <b>now</b>' });
  assert.ok(err.body.includes('<p class="tk-note red">Offline &lt;b&gt;now&lt;/b&gt; <button type="button" class="tk-textbtn" onclick="wuRetry()">Try again</button></p>'));
  // in the Settings list: after Inboxes & domains, before Reply bot; its state in one word
  const set = renderSettings({ hub: fullHub, alerts: [], open: { warmup: true }, warmup: { data: warmupStates.short }, inboxes: { data: cheapStates.connected }, now: NOW });
  assert.ok(set.includes('<details class="tk-set" id="tkSet-warmup" open ontoggle="trialsSettingsToggle(&quot;warmup&quot;,this.open)"><summary><span class="tk-set-head"><span class="tk-set-title">Warm-up</span><span class="tk-set-sub">Free helper email accounts that warm up new inboxes.</span></span><span class="pill amber" id="wuPill">Add 2 more</span></summary>'));
  assert.ok(set.indexOf('id="tkSet-inboxes"') < set.indexOf('id="tkSet-warmup"') && set.indexOf('id="tkSet-warmup"') < set.indexOf('id="tkSet-replybot"'));
  assert.ok(TK_SETTINGS.includes('warmup'));
});

/* ───────────── 2. the helpers ───────────── */
test('the helpers: address, kind of account, health in plain words (Working / New / Not working: … / Off), Test and Remove — an older system\'s words too, everything escaped', () => {
  const list = renderWarmupHelpers(wuHelpers(warmupStates.short, wuProviders(warmupStates.short)));
  const items = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(items.length, 4);
  assert.ok(items[0].startsWith('<p class="tk-wu-addr"><b class="tk-break">mia.helper@<wbr>gmail.com</b><span class="tk-wu-kind">Gmail</span></p><p class="tk-wu-health green">Working</p>'));
  assert.ok(items[1].includes('<span class="tk-wu-kind">Yahoo Mail</span></p><p class="tk-wu-health blue">New</p>'));
  assert.ok(items[2].includes('<p class="tk-wu-health red">Not working: AOL said the app password is wrong — make a new one under Account security</p>'));
  assert.ok(items[3].includes('<span class="tk-wu-kind">GMX</span></p><p class="tk-wu-health grey">Off</p>'));
  assert.ok(items[0].includes('<div class="tk-wu-acts"><button type="button" class="btn ghost" onclick="wuTest(&quot;mia.helper@gmail.com&quot;,this)" aria-label="Test mia.helper@gmail.com">Test</button><button type="button" class="btn ghost" onclick="wuRemove(&quot;mia.helper@gmail.com&quot;,this)" aria-label="Remove mia.helper@gmail.com">Remove</button></div>'));
  assert.equal(count(list, />Test<\/button>/g), 4); assert.equal(count(list, />Remove<\/button>/g), 4);
  assert.ok(list.startsWith('<h4 class="tk-set-h4">Your helpers</h4>'));
  // an older system: its own health words, switched off = Off, the kind named from the address' provider
  const old = renderWarmupHelpers(wuHelpers(warmupStates.older, []));
  assert.ok(old.includes('<b class="tk-break">a@<wbr>yahoo.com</b><span class="tk-wu-kind">Yahoo</span></p><p class="tk-wu-health red">Not working</p>'));
  assert.ok(old.includes('<b class="tk-break">b@<wbr>gmail.com</b><span class="tk-wu-kind">Gmail</span></p><p class="tk-wu-health grey">Off</p>'));
  assert.deepEqual(['imap_error', 'weird', ''].map((h) => wuHealthText(wuHelperOf({ email: 'x@y.z', health: h }, [])).text), ['Not working', 'Not checked yet', 'Not checked yet']);
  // hostile: nothing breaks out of the text or the handler argument
  const evil = renderWarmupHelpers(wuHelpers({ helpers: [{ email: '"><img src=x onerror=alert(1)>@x.com', provider: '<b>p</b>', providerLabel: '<i>Evil</i>', health: 'failing', problem: '<script>alert(2)</script>' }] }, []));
  for (const bad of ['<img src=x', '<script>', '<i>Evil', '<b>p']) assert.ok(!evil.includes(bad), bad);
  assert.ok(evil.includes('onclick="wuTest(&quot;\\&quot;&gt;&lt;img src=x onerror=alert(1)&gt;@x.com&quot;,this)"'), 'the address reaches the handler as a JSON string');
  assert.ok(!/onclick="[^"]*"[^>]*onclick=/.test(evil.replace(/"\s+[a-z-]+="[^"]*"/g, '"')), 'no attribute breaks out');
});

test('Test and Remove: the contract bodies, one at a time, the button greyed out ("Testing…") until the answer is in, the result in plain words, the list read again — and nothing typed under Add a helper is touched', async () => {
  const st = await openWarmup(warmupStates.short);
  let asked = null;
  try {
    assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.warmup, true); assert.equal(st.gets(), 1, 'opening Settings asks for the circle once');
    assert.ok(el('content').innerHTML.includes('<details class="tk-set" id="tkSet-warmup" open'));
    assert.ok(el('tkHost').innerHTML.includes('6 of 8 in the warm-up circle — add 2 more helpers') && el('tkHost').innerHTML.includes('old.helper@<wbr>aol.com'));
    await trialsTick(); assert.equal(st.gets(), 1, 'the 60-second refresh does not ask again');
    el('wuAddHost').innerHTML = 'HALF-TYPED';
    // Test
    let release; st.gate = new Promise((r) => { release = r; });
    const btn = { disabled: false, textContent: 'Test' };
    const first = wuTest('old.helper@aol.com', btn); await tick();
    assert.equal(btn.disabled, true); assert.equal(btn.textContent, 'Testing…');
    const again = await wuTest('mia.helper@gmail.com', { disabled: false, textContent: 'Test' });
    assert.equal(again.busy, true); assert.equal(toastText(), 'Still working on the last one…');
    release(); st.gate = null; await first;
    assert.equal(btn.disabled, false); assert.equal(btn.textContent, 'Test');
    assert.deepEqual(st.posts(), [{ action: 'testHelper', email: 'old.helper@aol.com' }], 'sent once');
    assert.equal(toastText(), 'old.helper@aol.com is working');
    assert.equal(st.gets(), 2, 'the circle is read again');
    assert.ok(el('wuTopHost').innerHTML.includes('Your helpers') && el('wuPill').outerHTML === '<span class="pill amber" id="wuPill">Add 2 more</span>', 'the helpers and the state redrawn');
    assert.equal(el('wuAddHost').innerHTML, 'HALF-TYPED', 'Add a helper left alone');
    // still failing (200 with the helper failing), or a 400 with the reason, or no answer at all
    st.testAnswer = (b) => ok({ ok: true, helper: { email: b.email, health: 'failing', problem: 'AOL said the app password is wrong.' } })();
    await wuTest('old.helper@aol.com', null); assert.equal(toastText(), 'old.helper@aol.com is not working: AOL said the app password is wrong');
    st.testAnswer = () => no(400, { error: 'AOL said the app password is wrong' });
    await wuTest('old.helper@aol.com', null); assert.equal(toastText(), 'old.helper@aol.com is not working: AOL said the app password is wrong');
    st.testAnswer = () => { throw new TypeError('Failed to fetch'); };
    await wuTest('old.helper@aol.com', null); assert.match(toastText(), /^Couldn't test old\.helper@aol\.com: Couldn't reach the system/, 'no answer is not "not working"');
    st.testAnswer = null;
    // Remove: asks first; no → nothing sent
    globalThis.confirm = (q) => { asked = q; return false; };
    const n = st.posts().length; await wuRemove('rest.helper@gmx.com', null);
    assert.equal(st.posts().length, n);
    assert.equal(asked, 'Remove rest.helper@gmx.com from the warm-up circle? It stops trading warm-up emails. The email account itself is not deleted.');
    globalThis.confirm = () => true;
    const rb = { disabled: false, textContent: 'Remove' };
    const pr = wuRemove('rest.helper@gmx.com', rb); assert.equal(rb.textContent, 'Removing…'); await pr;
    assert.deepEqual(st.posts().pop(), { action: 'removeHelper', email: 'rest.helper@gmx.com' });
    assert.equal(toastText(), 'Removed rest.helper@gmx.com');
    assert.ok(!el('wuTopHost').innerHTML.includes('rest.helper') && el('wuTopHost').innerHTML.includes('mia.helper@<wbr>gmail.com'));
    assert.equal(el('wuAddHost').innerHTML, 'HALF-TYPED');
    // a remove the system refuses: said, nothing redrawn
    const gets = st.gets(); globalThis.fetch = async (url, init) => (init.method === 'POST' ? no(400, { error: 'That helper is not in the circle' }) : ok(st.wu)());
    await wuRemove('ghost@x.com', null); assert.equal(toastText(), 'Not removed: That helper is not in the circle'); assert.equal(gets, st.gets());
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 3. Add a helper ───────────── */
test('Add a helper, on the page: big buttons for each kind (Gmail, Yahoo, AOL, iCloud, GMX, WEB.DE, Yandex) → its numbered steps and note → the address and a password box labelled the provider\'s way → "Test and add"; greyed out while testing', () => {
  const provs = wuProviders(warmupStates.short);
  const pick = renderWarmupAdd(provs, {});
  assert.deepEqual([...pick.matchAll(/<button type="button" class="btn ghost tk-wu-prov" onclick="wuPick\(&quot;(\w+)&quot;\)">([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]),
    [['google', 'Gmail'], ['yahoo', 'Yahoo'], ['aol', 'AOL'], ['icloud', 'iCloud'], ['gmx', 'GMX'], ['webde', 'WEB.DE'], ['yandex', 'Yandex']]);
  assert.ok(pick.includes('<h4 class="tk-set-h4" id="wuAddTitle">Add a helper</h4>') && pick.includes('Which kind of free email account is it? Pick one to see the steps.'));
  assert.ok(!pick.includes('wuEmail') && !pick.includes('type="password"'), 'no boxes before the kind is picked');
  const g = renderWarmupAdd(provs, { provider: 'google' });
  assert.ok(g.includes('<p class="tk-wu-picked"><b>Gmail</b><span aria-hidden="true">·</span><button type="button" class="tk-textbtn" id="wuOther" onclick="wuPick(&quot;&quot;)">Pick another kind</button></p>'));
  assert.deepEqual([...between(g, '<ol class="tk-gm-steps tk-wu-steps">', '</ol>').matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]), warmupProviders[0].steps, 'the numbered steps, as the system wrote them');
  assert.ok(g.includes('<p class="tk-wu-note">Use the app password, not the normal Gmail password.</p>'));
  assert.ok(g.includes('<label for="wuEmail">The helper\'s email address</label><input id="wuEmail" data-tk-form type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false">'));
  assert.ok(g.includes('<label for="wuPass">16-letter app password</label><input id="wuPass" data-tk-form type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false">'), 'a password box, labelled the provider\'s way');
  assert.ok(g.includes('<button type="button" class="btn tk-wu-go" id="wuAddBtn" onclick="wuAdd(this)">Test and add</button>'));
  assert.ok(g.indexOf('tk-wu-steps') < g.indexOf('tk-wu-note') && g.indexOf('tk-wu-note') < g.indexOf('wuEmail') && g.indexOf('wuPass') < g.indexOf('wuAddBtn') && g.indexOf('wuAddBtn') < g.indexOf('id="wuAddMsg"'), 'steps, note, boxes, the button, then the answer');
  assert.deepEqual(['yahoo', 'icloud', 'gmx'].map((k) => /<label for="wuPass">([^<]+)<\/label>/.exec(renderWarmupAdd(provs, { provider: k }))[1]), ['App password', 'App-specific password', 'Password']);
  assert.ok(!renderWarmupAdd(provs, { provider: 'aol' }).includes('tk-wu-note'), 'no note: none shown');
  // while the login is tested (a redraw keeps it that way)
  const busy = renderWarmupAdd(provs, { provider: 'google', busy: true });
  assert.ok(busy.includes('spellcheck="false" disabled></div>') && count(busy, / disabled/g) === 4, 'both boxes, "Pick another kind" and the button greyed out');
  assert.ok(busy.includes('id="wuAddBtn" onclick="wuAdd(this)" disabled>Testing the login…</button>'));
  assert.ok(busy.includes('<div class="tk-wu-msg" id="wuAddMsg" role="status" aria-live="polite"><p class="tk-status grey">Testing the login… This can take about 20 seconds.</p></div>'));
  // the outcome
  assert.ok(renderWarmupAdd(provs, { msg: { ok: true, text: 'Added — Gmail helper is working' } }).includes('<p class="tk-status green">Added — Gmail helper is working</p>'));
  assert.ok(renderWarmupAdd(provs, { provider: 'gmx', msg: { ok: false, text: '<b>No</b>' } }).includes('<p class="tk-status red">&lt;b&gt;No&lt;/b&gt;</p>'));
  // an older system without the list of kinds: the way to the full control panel instead
  const old = renderWarmupAdd([], {});
  assert.ok(old.includes('Adding a helper from here needs the newest update of the warm-up circle.') && old.includes('onclick="openMachine(&quot;/mc/warmup&quot;)">Open the warm-up circle ↗</button>'));
  // hostile kinds
  const evil = renderWarmupAdd(wuProviders({ providers: [{ key: 'x");alert(1);//', label: '<img src=x>', steps: ['<script>s</script>'], note: '<b>n</b>', passwordLabel: '<i>p</i>' }] }), { provider: 'x");alert(1);//' });
  for (const bad of ['<img src=x', '<script>s', '<b>n', '<i>p']) assert.ok(!evil.includes(bad), bad);
  assert.ok(renderWarmupAdd(wuProviders({ providers: [{ key: 'x");alert(1);//', label: 'X' }] }), {}).includes('onclick="wuPick(&quot;x\\&quot;);alert(1);//&quot;)"'));
});

test('Add a helper, end to end: pick → checks the boxes → posts {addHelper, email, password, provider} once, greyed out with "Testing the login…" (waits up to a minute) → "Added — Gmail helper is working", boxes emptied, the circle read again; a refusal shows the reason and keeps what was typed', async () => {
  const st = await openWarmup(warmupStates.short);
  const realSetTimeout = globalThis.setTimeout;
  try {
    wuPick('google');
    assert.equal(wuState.provider, 'google');
    assert.ok(el('wuAddHost').innerHTML.includes('<label for="wuPass">16-letter app password</label>') && el('wuAddTitle')._scrolled >= 1, 'only Add a helper redrawn, and brought into view');
    wuPick('nope'); assert.equal(wuState.provider, null, 'an unknown kind picks nothing');
    wuPick('google');
    // the boxes are checked first: nothing is sent
    el('wuEmail').value = 'not-an-address'; el('wuPass').value = 'x';
    await wuAdd(); assert.equal(st.posts().length, 0);
    assert.ok(el('wuAddMsg').innerHTML.includes('<p class="tk-status red">Type the helper\'s whole email address first.</p>'));
    el('wuEmail').value = ' new.helper@gmail.com '; el('wuPass').value = '   ';
    await wuAdd(); assert.equal(st.posts().length, 0);
    assert.ok(el('wuAddMsg').innerHTML.includes('Paste its 16-letter app password first.'));
    // send: greyed out, "Testing the login…", one at a time
    el('wuPass').value = 'abcd efgh ijkl mnop';
    const delays = []; globalThis.setTimeout = (f, ms, ...a) => { delays.push(ms); return realSetTimeout(f, ms, ...a); };
    let release; st.gate = new Promise((r) => { release = r; });
    const pending = wuAdd(); await tick();
    globalThis.setTimeout = realSetTimeout;
    assert.ok(delays.includes(60000), 'the login test is given up to a minute');
    assert.equal(el('wuAddBtn').disabled, true); assert.equal(el('wuAddBtn').textContent, 'Testing the login…');
    assert.deepEqual(['wuEmail', 'wuPass', 'wuOther'].map((id) => el(id).disabled), [true, true, true]);
    assert.ok(el('wuAddMsg').innerHTML.includes('Testing the login… This can take about 20 seconds.'));
    assert.ok(R(wuState.s, wuSettingsCtx()).body.includes('disabled>Testing the login…</button>'), 'a redraw while it tests stays greyed out');
    assert.equal((await wuTest('mia.helper@gmail.com', null)).busy, true, 'nothing else is sent meanwhile');
    wuPick('yahoo'); assert.equal(wuState.provider, 'google', 'the kind cannot change meanwhile');
    release(); st.gate = null; const r = await pending;
    assert.ok(r.ok);
    assert.deepEqual(st.posts(), [{ action: 'addHelper', email: 'new.helper@gmail.com', password: 'abcd efgh ijkl mnop', provider: 'google' }], 'the contract body, once');
    assert.equal(toastText(), 'Added — Gmail helper is working');
    assert.equal(el('wuEmail').value, ''); assert.equal(el('wuPass').value, '', 'the password is not left on the page');
    assert.ok(!JSON.stringify(wuState).includes('abcd efgh'), 'nor kept in memory');
    assert.equal(wuState.provider, null);
    const add = el('wuAddHost').innerHTML;
    assert.ok(add.includes('<p class="tk-status green">Added — Gmail helper is working</p>') && add.includes('>Gmail</button>'), 'the success, then the kinds again for the next one');
    assert.equal(st.gets(), 2, 'the circle is read again');
    assert.ok(el('wuTopHost').innerHTML.includes('new.helper@<wbr>gmail.com') && el('wuTopHost').innerHTML.includes('7 of 8 in the warm-up circle — add 1 more helper'));
    assert.equal(el('wuPill').outerHTML, '<span class="pill amber" id="wuPill">Add 1 more</span>');
    assert.ok(st.calls.some((c) => c[1] === '/api/mc/hub'), 'the trials behind it are refreshed too');
    // refused: the reason in plain words, the boxes and the kind kept, the button back
    wuPick('yahoo'); el('wuEmail').value = 'sun2@yahoo.com'; el('wuPass').value = 'my normal password';
    st.addFail = 'Yahoo said the password is wrong — use an app password from Account security, not your normal password';
    const r2 = await wuAdd();
    assert.equal(r2.ok, false);
    assert.ok(el('wuAddMsg').innerHTML.includes('<p class="tk-status red">Yahoo said the password is wrong — use an app password from Account security, not your normal password.</p>'));
    assert.equal(el('wuAddBtn').disabled, false); assert.equal(el('wuAddBtn').textContent, 'Test and add');
    assert.deepEqual(['wuEmail', 'wuPass', 'wuOther'].map((id) => el(id).disabled), [false, false, false]);
    assert.equal(el('wuEmail').value, 'sun2@yahoo.com'); assert.equal(wuState.provider, 'yahoo');
    assert.equal(st.gets(), 2, 'nothing saved: nothing read again');
    assert.deepEqual(st.posts().pop(), { action: 'addHelper', email: 'sun2@yahoo.com', password: 'my normal password', provider: 'yahoo' });
    // no answer at all
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await wuAdd(); assert.match(el('wuAddMsg').innerHTML, /tk-status red">Couldn't reach the system/);
  } finally { globalThis.setTimeout = realSetTimeout; offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 4. the trial page ───────────── */
test('trial page: the "Warm-up" card — the bar (day N of about 14), how many reach the inbox, each inbox with its day and rate, "Warm-up should be done around …" and Day 1 beside it; the label only when the top of the page does not already say it', () => {
  const d = galeWu('warming');
  const t = top(d);
  assert.ok(t.includes('<p class="tk-q-big">Warming up — day 5 of about 14 · 96% reach the inbox</p>'), 'the machine\'s label is the big sentence at the top');
  const card = renderWarmupCard(d, { now: NOW });
  assert.ok(card.startsWith('<section class="card tk-wu" id="tkSec-warmup">') && card.includes('<h3>Warm-up</h3>'));
  assert.ok(!card.includes('tk-wu-say'), 'not said twice');
  assert.ok(card.includes('<div class="tk-wu-prog"><div class="tk-wu-bar" role="progressbar" aria-valuemin="0" aria-valuemax="14" aria-valuenow="5" aria-label="Day 5 of about 14"><span style="width:36%"></span></div><p class="tk-wu-day">Day 5 of about 14</p></div>'));
  assert.ok(card.includes('<p class="tk-wu-rate"><b>96%</b> reach the inbox</p>'));
  assert.ok(card.includes(`<p class="tk-wu-ready">Warm-up should be done around ${tkDayName('2026-10-26')}. First emails: ${tkDayName('2026-10-26')}.</p>`), 'when warm-up is done, and the first emails (Day 1) beside it');
  assert.ok(card.includes('<h4>Each inbox</h4><ul class="tk-wu-boxes"><li><span class="tk-break">mia@<wbr>galeroofing-mail.com</span><span class="tk-wu-ibx">Day 5 · 96% reach the inbox</span></li><li><span class="tk-break">hello@<wbr>galeroofing-mail.com</span><span class="tk-wu-ibx">Day 4 · not measured yet</span></li></ul>'));
  assert.ok(!card.includes('<button'), 'nothing to press while it warms');
  const at = (s) => card.indexOf(s);
  assert.ok(at('tk-wu-bar') < at('tk-wu-rate') && at('tk-wu-rate') < at('tk-wu-ready') && at('tk-wu-ready') < at('Each inbox'));
  // the row says something else: the label shows, and the day and the rate are not repeated under it
  const other = renderWarmupCard(galeWu('warming', { label: 'Setting up their emails (about 2 weeks)' }));
  assert.ok(other.includes('<p class="tk-wu-say">Warming up — day 5 of about 14 · 96% reach the inbox</p>'));
  assert.ok(other.includes('aria-label="Day 5 of about 14"') && !other.includes('<p class="tk-wu-day">') && !other.includes('tk-wu-rate'), 'the bar stays; its words are in the label');
  const plain = renderWarmupCard(galeWu('warming', { label: 'Other' }, {}));
  assert.ok(plain.includes('tk-wu-say'));
  const bare = clone(galeWu('warming', { label: 'Other' })); bare.warmup.label = 'Warming up';
  const b = renderWarmupCard(bare);
  assert.ok(b.includes('<p class="tk-wu-say">Warming up</p>') && b.includes('<p class="tk-wu-day">Day 5 of about 14</p>') && b.includes('<b>96%</b> reach the inbox'), 'a short label: the facts under it');
  // ready: a full bar, each inbox ready
  const ready = renderWarmupCard(galeWu('ready'));
  assert.ok(ready.includes('aria-valuenow="14" aria-label="Warm-up done"><span style="width:100%"></span></div><p class="tk-wu-day">Warm-up done</p>'));
  assert.equal(count(ready, /<span class="pill green">Ready<\/span>/g), 2);
  assert.ok(ready.includes('Day 14 · 95% reach the inbox') && !ready.includes('tk-wu-ready'), 'no ready-by date once it is ready');
  // paused: the reason in plain words
  const paused = renderWarmupCard(galeWu('paused'));
  assert.ok(paused.includes('<p class="tk-status red">Fewer than 8 in 10 warm-up emails reached the inbox, so it slowed down to recover.</p>'));
  assert.ok(paused.includes('<span style="width:50%"></span>') && paused.includes('<b>78%</b> reach the inbox'));
  // no `warmup` yet (before the inboxes are connected): no card
  assert.equal(renderWarmupCard({ row: gale }), '');
  assert.equal(renderWarmupCard({ row: gale, warmup: null }), '');
  // on the page: after the three questions, before Behind the scenes
  const page = renderTrialDetail(d, 'overview', { now: NOW });
  assert.ok(page.indexOf('id="tkTop"') < page.indexOf('<div id="tkWuHost"><section class="card tk-wu"') && page.indexOf('tkWuHost') < page.indexOf('id="tkBehind"'));
  assert.ok(renderTrialDetail({ row: gale }, 'overview', { now: NOW }).includes('<div id="tkWuHost"></div>'));
  // hostile
  const evil = renderWarmupCard({ row: gale, warmup: { status: 'warming', label: '<img src=x onerror=alert(1)>', day: '5"><script>', of: 'x', readyBy: '<i>soon</i>', inboxRate: '<b>', inboxes: [{ email: '<script>x</script>@a.com', day: '<u>', inboxRate7d: 'y' }], problem: '<b>p</b>' } });
  for (const bad of ['<img src=x', '<script>', '<i>soon', '<b>p', '<u>']) assert.ok(!evil.includes(bad), bad);
  assert.ok(evil.includes('&lt;img src=x onerror=alert(1)&gt;') && !evil.includes('tk-wu-bar'), 'a day that is not a number: no bar');
});

test('trial page: waiting for helpers → the big button is "Add 2 warm-up helpers" (opens Settings › Warm-up); the number from the trial, Settings or the to-do; the to-do not listed again; red on the list; a row that has not caught up asks for nothing', async () => {
  warmupForget();
  const d = galeWu('waiting');
  const t = top(d);
  assert.deepEqual(bigButtons(t), [['Add 2 warm-up helpers', 'openSettings(&quot;warmup&quot;)']]);
  assert.ok(t.includes("<p class=\"tk-q-say\">Their inboxes can't start warming up until the warm-up circle has 2 more helpers. Helpers are free email accounts you make once — they help every client after this.</p>"));
  assert.ok(t.includes('<section class="card tk-top needs"'), 'his turn: the red edge');
  assert.ok(t.includes("It's your turn. Once you've done the step below, we carry on."));
  const page = renderTrialDetail(d, 'overview', { now: NOW });
  assert.ok(!page.includes('Also on your list'), 'the "Add 2 warm-up helpers" to-do is the big button, not listed again');
  assert.equal(count(page, /openSettings\(&quot;warmup&quot;\)/g), 1, 'one way there, not two');
  const twice = clone(d); twice.row.todo = [galeWarmupTodo, Object.assign({}, galeWarmupTodo, { id: 'warmup-helpers:again' })];
  assert.ok(!renderTrialDetail(twice, 'overview', { now: NOW }).includes('Also on your list'), 'a second copy of that to-do is not listed either');
  const card = renderWarmupCard(d);
  assert.ok(card.includes('<p class="tk-wu-text">It starts by itself as soon as the circle has enough helpers.</p>') && !card.includes('tk-wu-bar'), 'no bar before it starts');
  assert.equal(count(card, /<span class="tk-wu-ibx">Waiting for helpers<\/span>/g), 2, 'each inbox: waiting for helpers (never "Day 0" or "Day 1")');
  assert.ok(!card.includes('tk-wu-say'), 'the row already says it');
  // with Settings' answer in hand: how full the circle is
  wuState.s = clone(warmupStates.short);
  assert.ok(renderWarmupCard(d).includes('<p class="tk-wu-text">6 of 8 in the warm-up circle — add 2 more helpers</p>'));
  // the number: the trial's own first, then Settings' answer, then the to-do's words; singular; unknown
  wuState.s = clone(warmupStates.empty);
  assert.equal(bigButtons(top(d))[0][0], 'Add 5 warm-up helpers', 'Settings\' fresher count beats the to-do\'s words');
  const own = clone(d); own.warmup.missing = 1;
  assert.equal(bigButtons(top(own))[0][0], 'Add 1 warm-up helper');
  assert.match(top(own), /has 1 more helper\. /);
  warmupForget();
  const words = clone(d); words.row.todo = []; words.row.simple.next = 'Add 3 more warm-up helpers';
  assert.equal(bigButtons(top(words))[0][0], 'Add 3 warm-up helpers');
  const none = clone(d); none.row.todo = []; none.row.simple.next = 'Waiting for helpers';
  assert.deepEqual(bigButtons(top(none)), [['Add warm-up helpers', 'openSettings(&quot;warmup&quot;)']]);
  assert.match(top(none), /has more helpers\. /);
  // the list has not caught up (needsYou false): still his turn on the page
  const late = galeWu('waiting', { needsYou: false, next: '' }); late.row.todo = [];
  assert.ok(top(late).includes('<section class="card tk-top needs"') && bigButtons(top(late))[0][0] === 'Add warm-up helpers');
  // something more urgent has the big button: the card keeps its own way to Settings, the to-do is listed
  const urgent = galeWu('waiting'); urgent.row = Object.assign({}, urgent.row, { todo: [{ id: 'meeting-request:m1', text: 'Mia asked for a call time', urgent: true, action: { type: 'view', view: 'calendar', clientId: GALE, meetingId: 'm1' } }, galeWarmupTodo] });
  assert.equal(bigButtons(top(urgent))[0][0], 'Say yes to their call time');
  assert.ok(renderWarmupCard(urgent).includes('<div class="tk-wu-acts"><button type="button" class="btn" onclick="openSettings(&quot;warmup&quot;)">Add warm-up helpers</button></div>'));
  assert.ok(between(renderTrialDetail(urgent, 'overview', { now: NOW }), 'Also on your list', 'id="tkBehind"').includes('onclick="trialsTodoAction(&quot;warmup-helpers:gale-roofing&quot;)">Open Settings › Warm-up</button>'));
  // the warm-up has started (he added them) but the row still asks: nothing asked on the page
  const started = galeWu('warming', { next: 'Add 2 warm-up helpers — Settings › Warm-up', needsYou: true });
  assert.ok(!top(started).includes('tk-top needs') && bigButtons(top(started)).length === 0 && top(started).includes("Nothing — we'll tell you when something needs you"));
  // the Trials list: under Needs you, the system's next step in red
  const list = renderTrialList(hubWith(d.row), { now: NOW });
  assert.ok(between(list, 'Needs you</h3>', 'In progress</h3>').includes('Gale Roofing'));
  assert.ok(between(list, 'Gale Roofing', '</button>').includes('<span class="tk-person-you">You need to add 2 warm-up helpers — Settings › Warm-up.</span>'));
  // pressing it: Settings, with Warm-up open and in view
  fresh(); const st = machine(d);
  try {
    tk.detail[GALE] = clone(d); tk.detailAt[GALE] = Date.now(); trialsIngestHub(hubWith(d.row)); openTrial(GALE); await tick();
    assert.equal(currentView, 'trial');
    el('tkSet-warmup')._scrolled = 0;
    openSettings('warmup'); await tick();
    assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.warmup, true);
    assert.ok(el('content').innerHTML.includes('<details class="tk-set" id="tkSet-warmup" open'));
    assert.ok(el('tkSet-warmup')._scrolled >= 1, 'scrolled into view');
    assert.equal(st.gets(), 1);
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 5. deep link and the to-do action ───────────── */
test('#settings/warmup and the to-do {type:\'view\', view:\'settings\', section} (warmup, inboxes) open that Settings section; the bell and ⌘K too', async () => {
  assert.deepEqual(parseDeepLink('#settings/warmup'), { view: 'settings', section: 'warmup' });
  assert.deepEqual(parseDeepLink('/#settings/warmup/'), { view: 'settings', section: 'warmup' }, 'the phone alert url form');
  assert.deepEqual(parseDeepLink('https://aviance.store/#settings/warmup'), { view: 'settings', section: 'warmup' });
  for (const bad of ['#settings/warmupx', '#settings/warmup/x', '#warmup', '#settings/warm-up', '#settings/alerts']) assert.equal(parseDeepLink(bad), null, bad);
  fresh(); machine(galeWu('waiting'));
  const go = (h) => { location.hash = h; winListeners.hashchange.forEach((f) => f()); location.hash = ''; };
  try {
    render('trials'); await tick();
    go('#settings/warmup'); await tick();
    assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.warmup, true);
    assert.ok(el('content').innerHTML.includes('<details class="tk-set" id="tkSet-warmup" open'));
    // signed out: kept until sign-in
    authUser = null; pendingDeepLink = null;
    assert.equal(goDeepLink(parseDeepLink('#settings/warmup')), false); assert.deepEqual(pendingDeepLink, { view: 'settings', section: 'warmup' });
    pendingDeepLink = null; asOwner();
    // the to-do: its button's words, and where it goes (not the trial page)
    const todo = Object.assign({ clientId: GALE, clientName: 'Gale Roofing' }, galeWarmupTodo);
    const ci = { id: 'cheapinboxes:setup', clientId: GALE, text: 'Set up CheapInboxes', urgent: false, action: { type: 'view', view: 'settings', section: 'inboxes' } };
    const odd = { id: 'settings:odd', text: 'Look at Settings', urgent: false, action: { type: 'view', view: 'settings', section: 'nope' } };
    assert.equal(tkTodoLabel(todo), 'Open Settings › Warm-up'); assert.equal(tkTodoLabel(ci), 'Open Settings › Inboxes & domains'); assert.equal(tkTodoLabel(odd), 'Open Settings');
    assert.equal(renderTodoButton(todo), '<button class="btn ghost" onclick="trialsTodoAction(&quot;warmup-helpers:gale-roofing&quot;)">Open Settings › Warm-up</button>');
    assert.deepEqual(tkTodoPrimary(galeWarmupTodo, GALE), { label: 'Open Settings › Warm-up', run: 'openSettings(&quot;warmup&quot;)' });
    tk.hub = Object.assign({}, simpleHub, { todos: [todo, ci, odd] });
    render('trials'); tk.setOpen = {};
    trialsTodoAction('warmup-helpers:gale-roofing'); await tick();
    assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.warmup, true);
    render('trials'); tk.setOpen = {};
    trialsTodoAction('cheapinboxes:setup'); await tick();
    assert.equal(currentView, 'settings'); assert.deepEqual(tk.setOpen, { inboxes: true }, 'the CheapInboxes one opens Settings › Inboxes & domains');
    render('trials'); tk.setOpen = {};
    trialsTodoAction('settings:odd'); await tick();
    assert.equal(currentView, 'settings'); assert.deepEqual(tk.setOpen, {}, 'an unknown section: Settings, nothing forced open');
    // the bell (urgent to-dos)
    render('trials'); tk.setOpen = {};
    const bell = trialsNotifs().find((n) => /warm-up helpers/.test(n.t));
    assert.ok(bell); bell.go(); await tick();
    assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.warmup, true);
    // ⌘K
    const k = trialsCmdkActions().find((a) => a.label === 'Warm-up helpers');
    assert.ok(k && k.sub === 'Settings › Warm-up');
    render('trials'); tk.setOpen = {}; k.run(); assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.warmup, true);
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 6. plain words ───────────── */
test('plain words: Settings › Warm-up (every state, a kind picked), the card and the top of the trial in every status — no jargon, no rule names', () => {
  for (const [name, s] of Object.entries(warmupStates)) {
    for (const provider of [null, 'google', 'yahoo']) {
      const t = visibleText(R(s, { provider }).body + R(s, { provider }).state);
      assert.ok(!BANNED.test(t), name + ' ' + provider + ': ' + (t.match(BANNED) || [])[0]);
      assert.ok(!SNAKE.test(t), name + ': ' + (t.match(SNAKE) || [])[0]);
    }
  }
  for (const s of Object.keys(galeWarmup)) {
    const d = galeWu(s);
    for (const [where, h] of [['top', top(d)], ['card', renderWarmupCard(d)], ['card, label shown', renderWarmupCard(galeWu(s, { label: 'x' }))]]) {
      const t = visibleText(h);
      assert.ok(!BANNED.test(t), s + ' ' + where + ': ' + (t.match(BANNED) || [])[0]);
      assert.ok(!SNAKE.test(t), s + ' ' + where + ': no snake_case — ' + (t.match(SNAKE) || [])[0]);
    }
  }
  const list = visibleText(renderTrialList(hubWith(galeWu('waiting').row), { now: NOW }));
  assert.ok(!BANNED.test(list));
  // the hub only asks the system to add, test and remove a helper — it never makes an account itself
  const src = fs.readFileSync(path.join(root, 'warmup.js'), 'utf8');
  assert.deepEqual([...new Set([...src.matchAll(/action:'(\w+)'/g)].map((m) => m[1]))].sort(), ['addHelper', 'removeHelper', 'testHelper']);
});

/* ───────────── 7. files, touch targets, the phone ───────────── */
test('files: warmup.js is loaded after autobuy.js and before push.js and syntax-checked; 44 px+ targets, 16 px boxes, nothing wider than a phone; signing out forgets', () => {
  assert.ok(html.indexOf('<script src="autobuy.js"></script>') < html.indexOf('<script src="warmup.js"></script>') && html.indexOf('<script src="warmup.js"></script>') < html.indexOf('<script src="push.js"></script>'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.check.includes('node --check warmup.js'));
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  for (const [sel, px] of [['.btn.tk-wu-prov', 56], ['.btn.tk-wu-go', 48], ['.tk-wu-form .field input', 46], ['.tk-wu .btn', 46], ['.tk-textbtn', 44]]) {
    const rule = css.match(new RegExp(sel.replace(/[.>]/g, (c) => '\\' + c).replace(/ /g, '\\s') + '\\{([^}]*)\\}'));
    assert.ok(rule && new RegExp('min-height:' + px + 'px').test(rule[1]), sel + ' ≥ ' + px + ' px');
  }
  assert.match(css, /\.tk-wu-form \.field input\{[^}]*font-size:var\(--fs-base\)/, '16 px in the boxes (no iPhone zoom)');
  assert.match(html, /--fs-base:16px/);
  assert.match(html, /\.btn\{[^}]*min-height:44px/, 'Test and Remove are ordinary buttons: 44 px');
  assert.ok(/@media\(max-width:560px\)\{\.tk-wu\{padding:16px 14px\}/.test(css), 'phone padding');
  assert.ok(!/\.tk-wu[^{]*\{[^}]*(?<![-\w])(min-)?width:\s*\d{3,}px/.test(css), 'nothing wider than a phone (a max-width is fine)');
  assert.match(css, /\.tk-wu-provs\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(140px,1fr\)\)/, 'the kinds wrap: two across on a phone');
  // the password box is never drawn with a value, and warmup.js sets no font size of its own
  const src = fs.readFileSync(path.join(root, 'warmup.js'), 'utf8');
  assert.ok(!/id="wuPass"[^>]*value=/.test(src) && !/font-size/.test(src));
  wuState.s = clone(warmupStates.short); wuState.provider = 'google'; wuState.msg = { ok: true, text: 'x' };
  trialsForget();
  assert.deepEqual([wuState.s, wuState.provider, wuState.msg, wuState.busy, wuState.adding], [null, null, null, false, false]);
});
