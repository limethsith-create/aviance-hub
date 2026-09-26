/* Tests for Settings › Keys and Settings › Your details (keys.js + its hooks in trials.js and index.html) —
   email-distributor docs/KEYS.md and docs/HUB-API.md "Keys" / "Config". The owner pastes each service key once and
   fills in his own details in the hub, so he never opens Vercel. A key's value is never drawn back.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Same set-up as autobuy.test.mjs: the shell's inline script, then every section script exactly like the browser,
   with a tiny fake DOM and a fake Supabase client. The machine is a fake fetch that answers like the contract. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, fullHub, simpleHub, googleStates, cheapStates, warmupStates, keysStates, configStates, KEYS_REPO } from './fixtures.mjs';

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
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
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
for (const f of ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js', 'warmup.js', 'keys.js', 'push.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
supa.session = { access_token: 'test-token' };
after(() => { trialsStopTimer(); calendarStopTimer(); });

const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const count = (s, re) => (s.match(re) || []).length;
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const bad = (status, error) => async () => ({ ok: false, status, text: async () => JSON.stringify({ error }) });
const tick = () => new Promise((r) => setTimeout(r, 5));
const between = (s, a, b) => { const i = s.indexOf(a); const j = b ? s.indexOf(b, i + 1) : s.length; return s.slice(i, j < 0 ? s.length : j); };
const visibleText = (h) => h.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
const offline = () => { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; globalThis.confirm = () => true; };
const toastText = () => visibleText(el('toast').innerHTML.replace(/&#39;/g, "'")).trim();
const BANNED = /\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|dns|jwt|config|payload|mission control|cron|redis|endpoint|webhook)\b/i;
const KEYS = '/api/mc/keys', CFG = '/api/mc/config';
const card = (h, name) => between(h, 'id="kyCard-' + name + '"', '</section>');
const field = (h, key) => { const i = h.indexOf('id="ydField-' + key.replace('.', '_') + '"'); if (i < 0) return ''; const end = '</div>\n  </div>'; const j = h.indexOf(end, i); return h.slice(h.lastIndexOf('<div class="tk-yd-field', i), j < 0 ? h.length : j + end.length); };

/* A fake machine: GET the keys / the settings / the board; POST keys and config like the contract. */
function machine(opts) {
  opts = opts || {};
  const st = { keys: clone(opts.keys || keysStates.mixed), cfg: clone(opts.cfg || configStates.some), calls: [], saveOk: true, refuse: null, testOk: true, cfgErr: null };
  const findKey = (name) => st.keys.keys.find((k) => k.name === name);
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; st.calls.push([init.method, u.pathname, body]);
    if (u.pathname === KEYS) {
      if (init.method === 'GET') return ok(st.keys)();
      const k = findKey(body.name); if (!k) return bad(400, 'That is not a key the machine knows.')();
      if (body.action === 'save') {
        if (st.refuse) return bad(400, st.refuse)();
        Object.assign(k, { set: true, from: 'hub', savedAt: '2026-10-17T12:00:00Z', testedAt: '2026-10-17T12:00:00Z', ok: st.saveOk ? true : null, problem: st.saveOk ? null : 'not tested yet' });
        if (k.name === 'GITHUB_REPO') k.value = body.value;
        return ok(Object.assign({ saved: true }, k))();
      }
      if (body.action === 'test') { Object.assign(k, { testedAt: '2026-10-17T12:05:00Z', ok: st.testOk, problem: st.testOk ? null : 'Google said the key is not valid for the Places API.' }); return ok(Object.assign({ tested: true }, k))(); }
      if (body.action === 'forget') { Object.assign(k, { set: false, from: null, savedAt: null, testedAt: null, ok: null, problem: null }); if (k.name === 'GITHUB_REPO') k.value = null; return ok(Object.assign({ forgotten: true }, k))(); }
    }
    if (u.pathname === CFG) {
      if (init.method === 'GET') return ok(st.cfg)();
      if (st.cfgErr) return bad(400, st.cfgErr)();
      const row = st.cfg.settings.find((r) => r.key === body.key); if (!row) return bad(400, 'unknown setting ' + body.key)();
      if (body.action === 'set') { row.value = body.value; row.overridden = JSON.stringify(row.value) !== JSON.stringify(row.default); return ok({ ok: true, key: body.key, written: 1 })(); }
      if (body.action === 'reset') { row.value = row.default; row.overridden = false; return ok({ ok: true, key: body.key, cleared: 1 })(); }
    }
    if (u.pathname === '/api/mc/hub') return ok(simpleHub)();
    if (u.pathname === '/api/mc/alerts') return ok({ alerts: [] })();
    if (u.pathname === '/api/mc/google') return ok(googleStates.connected)();
    if (u.pathname === '/api/mc/cheapinboxes') return ok(cheapStates.connected)();
    if (u.pathname === '/api/mc/warmup') return ok(warmupStates.ready)();
    return ok({ ok: true })();
  };
  st.posts = (p) => st.calls.filter((c) => c[0] === 'POST' && c[1] === p);
  st.gets = (p) => st.calls.filter((c) => c[0] === 'GET' && c[1] === p).length;
  return st;
}
const openSet = async (opts) => { asOwner(); trialsForget(); calendarForget(); asOwner(); const st = machine(opts); render('settings'); await tick(); return st; };

/* ───────────── 1. Settings › Keys: the cards ───────────── */
test('Settings › Keys: one card per key in the owner\'s order, the status in words for every state, a key set on the server has no box, the optional ones are folded', () => {
  const r = renderKeysSet({ data: keysStates.mixed });
  const b = r.body;
  const order = [...b.matchAll(/id="kyCard-([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['PLACES_API_KEY', 'QUICKEMAILVERIFICATION_API_KEY', 'VERIFALIA', 'REOON_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO', 'ZEROBOUNCE_API_KEY', 'HUNTER_API_KEY'], 'the hub\'s order, not the server\'s');
  assert.ok(b.indexOf('<details class="tk-ky-opt"><summary>Optional — 2 more checkers, not needed to start</summary>') < b.indexOf('id="kyCard-ZEROBOUNCE_API_KEY"'), 'ZeroBounce and Hunter fold away');
  assert.ok(between(b, 'id="kyCard-GITHUB_TOKEN"', '</section>').includes('<div class="tk-ky-repo" id="kyCard-GITHUB_REPO">'), 'the repository name sits inside the GitHub token card');
  // the plain labels and the status in words
  const heads = [...b.matchAll(/<div class="tk-ky-head"><h4>([^<]+)<\/h4>(<span class="pill[^>]*>[^<]*<\/span>)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(heads, [
    ['Google Places', '<span class="pill green">Set — working</span>'],
    ['QuickEmailVerification', '<span class="pill amber">Set — not tested yet</span>'],
    ['Verifalia', '<span class="pill red tk-ky-pill">Set — problem: Verifalia turned the login down — check the user name and password</span>'],
    ['Reoon', '<span class="pill grey">Not set</span>'],
    ['GitHub token', '<span class="pill green">Set — working</span>'],
    ['Repository name', '<span class="pill grey">The default</span>'],
    ['ZeroBounce', '<span class="pill grey">Not set</span>'],
    ['Hunter', '<span class="pill green">Set — working</span>'],
  ]);
  // set on the server by the developer: said so, no box, no Forget — Test stays
  const gh = card(b, 'GITHUB_TOKEN').split('<div class="tk-ky-repo"')[0];
  assert.ok(gh.includes('<p class="tk-ky-env">Set on the server by your developer — there is nothing to paste here.</p>'));
  assert.ok(!gh.includes('kyIn-GITHUB_TOKEN') && !gh.includes('kySave(') && !gh.includes('kyForget(') && gh.includes('onclick="kyTest(&quot;GITHUB_TOKEN&quot;,this)"'));
  // a working key: a box to replace it, Test and Forget; the steps folded
  const pl = card(b, 'PLACES_API_KEY');
  assert.ok(pl.includes('<label for="kyIn-PLACES_API_KEY">Paste a new key only to replace the saved one</label><input id="kyIn-PLACES_API_KEY" data-tk-form type="password" autocomplete="off" autocapitalize="off" spellcheck="false">'));
  assert.ok(pl.includes('<button type="button" class="btn" id="kySave-PLACES_API_KEY" onclick="kySave(&quot;PLACES_API_KEY&quot;,this)">Test and save</button>'));
  assert.ok(pl.includes('<button type="button" class="btn ghost" id="kyTest-PLACES_API_KEY" onclick="kyTest(&quot;PLACES_API_KEY&quot;,this)">Test</button><button type="button" class="btn ghost" id="kyForget-PLACES_API_KEY" onclick="kyForget(&quot;PLACES_API_KEY&quot;,this)">Forget</button>'));
  assert.ok(pl.includes('<details class="tk-ky-how"><summary>How to get a new one</summary>') && pl.includes('Last tested '));
  // a key not set: the steps open, "Open …", the box, Test and save; nothing to test or forget
  const re = card(b, 'REOON_API_KEY');
  assert.ok(re.includes('<h5 class="tk-ky-h5">How to get it</h5><ol class="tk-gm-steps tk-ky-steps"><li>Sign up at emailverifier.reoon.com and confirm your email.</li>'));
  assert.ok(re.includes('<a class="btn ghost tk-ky-open" href="https://emailverifier.reoon.com/" target="_blank" rel="noopener noreferrer">Open Reoon ↗</a>'));
  assert.ok(re.includes('<label for="kyIn-REOON_API_KEY">Paste the key</label>') && !re.includes('kyTest(') && !re.includes('kyForget(') && !re.includes('tk-ky-how'));
  assert.ok(re.includes('<p class="tk-ky-free">20 checks a day (up to 600 a month) plus 100 on signup; paid packs never expire.</p>') && re.includes('<p class="tk-ky-note">Their menus may have moved — check on their site.</p>'), 'the free limit and the note');
  // Verifalia: a user name and a password
  const vf = card(b, 'VERIFALIA');
  assert.ok(vf.includes('<label for="kyUser-VERIFALIA">User name</label><input id="kyUser-VERIFALIA" data-tk-form type="text"') && vf.includes('<label for="kyIn-VERIFALIA">Password</label><input id="kyIn-VERIFALIA" data-tk-form type="password"'));
  assert.ok(vf.includes('It is a login: a user name and a password.'));
  // the repository: a plain text box, the default shown, Save (not "Test and save")
  const rp = between(b, 'id="kyCard-GITHUB_REPO"', '</section>');
  assert.ok(rp.includes(`<label for="kyIn-GITHUB_REPO">Repository name</label><input id="kyIn-GITHUB_REPO" data-tk-form type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${KEYS_REPO}">`));
  assert.ok(rp.includes('onclick="kySave(&quot;GITHUB_REPO&quot;,this)">Save</button>') && rp.includes('Leave the default unless your developer moved the code.'));
  const all = renderKeysSet({ data: keysStates.all }).body;
  const rp2 = between(all, 'id="kyCard-GITHUB_REPO"', '</section>');
  assert.ok(rp2.includes('<span class="pill green">Set</span>') && rp2.includes('Repository name (now aviance/leadfinder)') && rp2.includes('onclick="kyForget(&quot;GITHUB_REPO&quot;,this)">Forget</button>'), 'changed: shown, and Forget goes back to the default');
  assert.ok(!all.includes('kyTest(&quot;GITHUB_REPO&quot;'), 'a plain setting has no Test of its own');
});

test('Settings › Keys: the intro, "3 of 5 keys set" and the pill; "the machine" reads "the system"; loading, errors, no encryption key; never a value; escaped', () => {
  const m = renderKeysSet({ data: keysStates.mixed });
  assert.equal(m.state, '<span class="pill red" id="kyPill">4 of 5 set — 1 problem</span>');
  assert.ok(m.body.startsWith('<div id="kyHost"><p class="tk-set-text">Keys are like passwords that let one system talk to another. Each one is free to make; paste it here once.</p>'));
  assert.ok(m.body.includes('<p class="tk-status red">4 of 5 keys set. Still to paste: Reoon. A problem with: Verifalia.</p>'));
  const three = { keys: keysStates.mixed.keys.map((k) => (k.name === 'GITHUB_TOKEN' ? Object.assign({}, k, { set: false, from: null, ok: null }) : k)), encKey: true };
  assert.equal(renderKeysSet({ data: three }).state, '<span class="pill red" id="kyPill">3 of 5 set — 1 problem</span>');
  assert.ok(renderKeysSet({ data: three }).body.includes('3 of 5 keys set. Still to paste: Reoon, GitHub token. A problem with: Verifalia.'));
  const f = renderKeysSet({ data: keysStates.fresh });
  assert.equal(f.state, '<span class="pill amber" id="kyPill">0 of 5 set</span>');
  assert.ok(f.body.includes('<p class="tk-status amber">0 of 5 keys set. Still to paste: Google Places, QuickEmailVerification, Verifalia, Reoon, GitHub token.</p>'));
  assert.ok(!f.body.includes('kyTest(') && !f.body.includes('kyForget(') && !f.body.includes('tk-ky-how'), 'nothing set: every step open, nothing to test or forget');
  const a = renderKeysSet({ data: keysStates.all });
  assert.equal(a.state, '<span class="pill green" id="kyPill">5 of 5 set</span>');
  assert.ok(a.body.includes('<p class="tk-status green">5 of 5 keys set. Everything the lead finder needs is in place.</p>'));
  // the server's words say "the machine"; the owner reads "the system"
  assert.ok(card(f.body, 'GITHUB_TOKEN').includes('Free. The token only lets the system start the lead finder job in your repository.') && !f.body.includes('the machine'));
  // no encryption key on the server: one line, saving off (the plain repository setting still saves)
  const l = renderKeysSet({ data: keysStates.noLock }).body;
  assert.ok(l.includes('<p class="tk-gm-lock">Keys can\'t be stored yet (server encryption key missing). Ask your developer to set it — until then nothing you paste here can be saved.</p>'));
  assert.ok(card(l, 'PLACES_API_KEY').includes('<input id="kyIn-PLACES_API_KEY" data-tk-form type="password" autocomplete="off" autocapitalize="off" spellcheck="false" disabled>') && card(l, 'PLACES_API_KEY').includes('>Test and save</button>') && card(l, 'PLACES_API_KEY').includes('onclick="kySave(&quot;PLACES_API_KEY&quot;,this)" disabled>'));
  assert.ok(between(l, 'id="kyCard-GITHUB_REPO"', '</section>').includes('onclick="kySave(&quot;GITHUB_REPO&quot;,this)">Save</button>'));
  assert.ok(!m.body.includes('tk-gm-lock'), 'with the key: no line');
  // loading, error, odd answers
  assert.ok(renderKeysSet({}).body.includes('Checking your keys…') && renderKeysSet({}).state === '');
  assert.ok(renderKeysSet({ err: 'Offline' }).body.includes('Offline <button type="button" class="tk-textbtn" onclick="kyRetry()">Try again</button>'));
  assert.ok(renderKeysSet({ data: { keys: [] } }).body.includes('0 of 0 keys set.'));
  // a card the hub does not know: the server's words, safe link only, no crash
  const odd = renderKeysSet({ data: { keys: [{ name: 'NEW_THING', short: 'New thing', label: 'New thing — does something new', set: true, from: 'hub', ok: true, url: 'javascript:alert(1)', steps: ['<b>one</b>'], problem: null }] } }).body;
  assert.ok(odd.includes('<h4>New thing</h4>') && odd.includes('does something new') && odd.includes('&lt;b&gt;one&lt;/b&gt;') && !odd.includes('javascript:') && !odd.includes('tk-ky-open'));
  // hostile words from the server never run; a value never shows (the answer has none, and the hub draws none)
  const evil = renderKeysSet({ data: { keys: [Object.assign({}, keysStates.mixed.keys[2], { problem: '<img src=x onerror=alert(1)>', free: '<script>x</script>', note: '"><i>y</i>', value: 'sk_should_never_show' })], encKey: true } }).body;
  assert.ok(!evil.includes('<img src=x') && !evil.includes('<script>x') && !evil.includes('<i>y</i>') && !evil.includes('sk_should_never_show'));
  // plain words in every state
  for (const [n, s] of Object.entries(keysStates)) { const t = visibleText(renderKeysSet({ data: s }).body); assert.ok(!BANNED.test(t), n + ': ' + (t.match(BANNED) || [])[0]); }
});

/* ───────────── 2. Settings › Keys: the actions ───────────── */
test('Settings › Keys: Test and save / Test / Forget post the contract bodies (Verifalia: user name + password; the repository: a value); a refused key keeps what was typed; a saved one is cleared and never drawn; buttons greyed out while testing', async () => {
  const st = await openSet({ keys: keysStates.fresh });
  let asked = null; globalThis.confirm = (q) => { asked = q; return true; };
  try {
    assert.equal(st.gets(KEYS), 1, 'opening Settings asks for the keys once');
    assert.ok(el('tkHost').innerHTML.includes('<span class="tk-set-title">Keys</span>') && el('tkHost').innerHTML.includes('<span class="pill amber" id="kyPill">0 of 5 set</span>'));
    await trialsTick(); assert.equal(st.gets(KEYS), 1, 'the 60-second refresh does not ask again');
    // nothing pasted, or a key with a space inside: said in the card, nothing sent
    el('kyIn-PLACES_API_KEY').value = '  '; await kySave('PLACES_API_KEY'); assert.equal(st.posts(KEYS).length, 0);
    assert.equal(el('kyMsg-PLACES_API_KEY').innerHTML, '<p class="tk-status red">Paste the key first.</p>');
    el('kyIn-PLACES_API_KEY').value = 'AIza abc'; await kySave('PLACES_API_KEY'); assert.equal(st.posts(KEYS).length, 0);
    assert.equal(el('kyMsg-PLACES_API_KEY').innerHTML, '<p class="tk-status red">Paste the whole key, with no spaces or line breaks.</p>');
    // refused by the service: the plain reason, what was typed stays, nothing saved
    st.refuse = 'Google said the key is not valid for the Places API. Check step 6 and paste it again.';
    el('kyIn-PLACES_API_KEY').value = 'AIzaBadKey123';
    let p = kySave('PLACES_API_KEY');
    assert.equal(el('kySave-PLACES_API_KEY').textContent, 'Testing…'); assert.equal(el('kySave-PLACES_API_KEY').disabled, true); assert.equal(el('kyIn-PLACES_API_KEY').disabled, true, 'greyed out while the service checks it');
    assert.equal(el('kyMsg-PLACES_API_KEY').innerHTML, '<p class="tk-ky-wait" role="status">Testing…</p>');
    await p;
    assert.deepEqual(st.posts(KEYS).pop()[2], { action: 'save', name: 'PLACES_API_KEY', value: 'AIzaBadKey123' });
    assert.equal(el('kyIn-PLACES_API_KEY').value, 'AIzaBadKey123', 'what was typed stays, so he can fix it');
    assert.equal(el('kyMsg-PLACES_API_KEY').innerHTML, '<p class="tk-status red">Google said the key is not valid for the Places API. Check step 6 and paste it again.</p>');
    assert.equal(el('kySave-PLACES_API_KEY').textContent, 'Test and save'); assert.equal(el('kySave-PLACES_API_KEY').disabled, false);
    assert.ok(!el('tkHost').innerHTML.includes('AIzaBadKey123'), 'never drawn on the page');
    // accepted: "Working — saved", the box cleared, the card redrawn as working, the pill counts it
    st.refuse = null; el('kyIn-PLACES_API_KEY').value = ' AIzaGoodKey456 ';
    await kySave('PLACES_API_KEY');
    assert.deepEqual(st.posts(KEYS).pop()[2], { action: 'save', name: 'PLACES_API_KEY', value: 'AIzaGoodKey456' });
    assert.equal(asked, null, 'saving asks nothing');
    assert.equal(el('kyIn-PLACES_API_KEY').value, '', 'the key is cleared from the box');
    assert.equal(toastText(), 'Working — saved');
    assert.ok(el('kyHost').innerHTML.includes('<p class="tk-status green">Working — saved</p>'));
    assert.ok(!el('kyHost').innerHTML.includes('AIzaGoodKey456') && !el('tkHost').innerHTML.includes('AIzaGoodKey456'), 'and never drawn');
    assert.equal(st.gets(KEYS), 2, 'the keys are read again');
    assert.ok(card(el('kyHost').innerHTML, 'PLACES_API_KEY').includes('<span class="pill green">Set — working</span>') && el('kyPill').outerHTML === '<span class="pill amber" id="kyPill">1 of 5 set</span>');
    assert.equal(tk.setOpen.keys, true, 'the section stays open');
    // the service could not be reached: saved, but not tested yet
    st.saveOk = false; el('kyIn-REOON_API_KEY').value = 'reoonkey1'; await kySave('REOON_API_KEY');
    assert.equal(toastText(), 'Saved — not tested yet');
    assert.ok(card(el('kyHost').innerHTML, 'REOON_API_KEY').includes('<span class="pill amber">Set — not tested yet</span>'));
    st.saveOk = true;
    // Verifalia: both boxes needed; the body carries username + password; both cleared after
    el('kyUser-VERIFALIA').value = ''; el('kyIn-VERIFALIA').value = 'pw'; await kySave('VERIFALIA');
    assert.equal(el('kyMsg-VERIFALIA').innerHTML, '<p class="tk-status red">Type the user name first.</p>');
    el('kyUser-VERIFALIA').value = 'sid-123'; el('kyIn-VERIFALIA').value = ''; await kySave('VERIFALIA');
    assert.equal(el('kyMsg-VERIFALIA').innerHTML, '<p class="tk-status red">Paste the password first.</p>');
    el('kyIn-VERIFALIA').value = 'tok-456'; const n = st.posts(KEYS).length; await kySave('VERIFALIA');
    assert.equal(st.posts(KEYS).length, n + 1);
    assert.deepEqual(st.posts(KEYS).pop()[2], { action: 'save', name: 'VERIFALIA', username: 'sid-123', password: 'tok-456' });
    assert.equal(el('kyUser-VERIFALIA').value, ''); assert.equal(el('kyIn-VERIFALIA').value, '');
    assert.ok(!el('tkHost').innerHTML.includes('sid-123') && !el('tkHost').innerHTML.includes('tok-456'));
    // the repository: a plain value
    el('kyIn-GITHUB_REPO').value = 'aviance/leadfinder'; await kySave('GITHUB_REPO');
    assert.deepEqual(st.posts(KEYS).pop()[2], { action: 'save', name: 'GITHUB_REPO', value: 'aviance/leadfinder' });
    assert.ok(between(el('kyHost').innerHTML, 'id="kyCard-GITHUB_REPO"', '</section>').includes('Repository name (now aviance/leadfinder)'), 'a plain setting is shown');
    // what is typed in another card survives a save elsewhere
    el('kyIn-QUICKEMAILVERIFICATION_API_KEY').value = 'half-typed'; el('kyIn-HUNTER_API_KEY').value = 'hunterkey'; await kySave('HUNTER_API_KEY');
    assert.equal(el('kyIn-QUICKEMAILVERIFICATION_API_KEY').value, 'half-typed'); assert.equal(el('kyIn-HUNTER_API_KEY').value, '');
    // Test: working / a problem, the card says it
    await kyTest('PLACES_API_KEY'); assert.deepEqual(st.posts(KEYS).pop()[2], { action: 'test', name: 'PLACES_API_KEY' });
    assert.equal(toastText(), 'Working.'); assert.ok(card(el('kyHost').innerHTML, 'PLACES_API_KEY').includes('<p class="tk-status green">Working.</p>'));
    st.testOk = false; await kyTest('PLACES_API_KEY');
    assert.equal(toastText(), 'Problem: Google said the key is not valid for the Places API.');
    assert.ok(card(el('kyHost').innerHTML, 'PLACES_API_KEY').includes('<span class="pill red tk-ky-pill">Set — problem: Google said the key is not valid for the Places API</span>'));
    assert.ok(el('kyPill').outerHTML.includes('— 1 problem'));
    // Forget: asks first; no → nothing sent; yes → the card is "Not set" again
    globalThis.confirm = (q) => { asked = q; return false; }; const before = st.posts(KEYS).length; await kyForget('PLACES_API_KEY'); assert.equal(st.posts(KEYS).length, before);
    assert.equal(asked, 'Forget the Google Places key? The system stops using it until you paste it again.');
    globalThis.confirm = () => true; await kyForget('PLACES_API_KEY'); assert.deepEqual(st.posts(KEYS).pop()[2], { action: 'forget', name: 'PLACES_API_KEY' });
    assert.equal(toastText(), 'Forgotten'); assert.ok(card(el('kyHost').innerHTML, 'PLACES_API_KEY').includes('<span class="pill grey">Not set</span>'));
    // one at a time
    kyState.busy = { name: 'REOON_API_KEY', kind: 'test' }; const r = await kyTest('REOON_API_KEY'); assert.equal(r.busy, true); assert.equal(toastText(), 'Still working on the last one…'); kyState.busy = null;
    // no encryption key: nothing is sent
    kyState.s.encKey = false; el('kyIn-QUICKEMAILVERIFICATION_API_KEY').value = 'qevkey'; const m = st.posts(KEYS).length; await kySave('QUICKEMAILVERIFICATION_API_KEY');
    assert.equal(st.posts(KEYS).length, m); assert.ok(el('kyMsg-QUICKEMAILVERIFICATION_API_KEY').innerHTML.includes("Keys can't be stored yet (server encryption key missing)")); kyState.s.encKey = true;
    // the source has only the contract's three actions
    const src = fs.readFileSync(path.join(root, 'keys.js'), 'utf8');
    assert.deepEqual([...new Set([...src.matchAll(/action:'(\w+)'/g)].map((x) => x[1]))].sort(), ['forget', 'reset', 'save', 'set', 'test']);
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 3. Settings › Your details ───────────── */
test('Settings › Your details: the eight boxes with plain labels and helper lines, what is set now, the two the first trial needs marked in amber, "Still to fill in: N"; a machine with one row per field too', () => {
  const s = renderDetailsSet({ data: configStates.some });
  assert.equal(s.state, '<span class="pill amber" id="ydPill">4 still to fill in</span>');
  const b = s.body;
  assert.ok(b.includes('<p class="tk-status amber">Still to fill in: 4 — Your postal address, Your PayPal.me link, Your Wise details, Your Clutch review page. The first trial cannot start without your postal address.</p>'));
  const labels = [...b.matchAll(/<label for="ydIn-[A-Za-z_]+">([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Your full name', 'Your postal address', 'Your email address', 'The onboarding inbox', 'Your call link', 'Your PayPal.me link', 'Your Wise details', 'Your Clutch review page']);
  for (const h of ['Signs the agreements and the emails.', 'Goes at the bottom of every email — US law requires one.', 'Where the system emails you.', 'Which inbox sends the onboarding emails and receives the replies. It must be an inbox the system can log into. Left empty, the first Aviance inbox is used.', 'Your Zoom or Google Meet link — used until Google Meet is connected.', 'How a client pays you by PayPal.', 'As text: what a client needs to pay you by Wise.', 'The link a happy client gets when we ask for a review.'])
    assert.ok(b.includes('<p class="tk-yd-help">' + h + '</p>'), h);
  // the name is in (green mark, the value shown, Clear); the address is not (amber box and mark)
  const name = field(b, 'OWNER.signerName');
  assert.ok(name.startsWith('<div class="tk-yd-field" id="ydField-OWNER_signerName">') && name.includes('<span class="tk-yd-req">needed — filled in</span>'));
  assert.ok(name.includes('<input id="ydIn-OWNER_signerName" data-tk-form type="text" autocomplete="name" autocapitalize="words" spellcheck="false" value="Limeth Sith" onkeydown="ydKey(event,&quot;OWNER.signerName&quot;)">'));
  assert.ok(name.includes('<button type="button" class="btn" id="ydSave-OWNER_signerName" onclick="ydSave(&quot;OWNER.signerName&quot;,this)">Save</button>') && name.includes('onclick="ydReset(&quot;OWNER.signerName&quot;,this)">Clear</button>'));
  const addr = field(b, 'OWNER.address');
  assert.ok(addr.startsWith('<div class="tk-yd-field need" id="ydField-OWNER_address">') && addr.includes('<span class="tk-yd-req need">needed before the first trial</span>'));
  assert.ok(addr.includes('<textarea id="ydIn-OWNER_address" data-tk-form rows="3" autocomplete="off"></textarea>') && !addr.includes('ydReset('), 'a postal address gets more than one line; nothing to clear');
  // the others are not marked; the email and the links have the right kind of box
  assert.ok(!field(b, 'OWNER.email').includes('tk-yd-req') && field(b, 'OWNER.email').includes('type="email" inputmode="email"') && field(b, 'OWNER.email').includes('value="owner@example.com"'));
  assert.ok(field(b, 'CALENDAR.meetingLink').includes('type="url" inputmode="url"') && field(b, 'CALENDAR.meetingLink').includes('value="https://meet.google.com/abc-defg-hij"'));
  assert.ok(field(b, 'PAYMENT.wiseDetails').includes('<textarea id="ydIn-PAYMENT_wiseDetails"'));
  assert.ok(!field(b, 'ONBOARDCALL.inbox').includes('need') && b.includes('Still to fill in: 4'), 'the onboarding inbox has its own fallback: never counted');
  // everything empty / everything in
  const e = renderDetailsSet({ data: configStates.empty });
  assert.equal(e.state, '<span class="pill amber" id="ydPill">7 still to fill in</span>');
  assert.ok(e.body.includes('Still to fill in: 7 — Your full name, Your postal address, Your email address, Your call link, Your PayPal.me link, Your Wise details, Your Clutch review page. The first trial cannot start without your name and address.'));
  assert.equal(count(e.body, /class="tk-yd-field need"/g), 2);
  const full = clone(configStates.some); Object.assign(full.settings[0].value, { address: '12 Main St, Austin TX' }); Object.assign(full.settings[1].value, { paypalMe: 'https://paypal.me/aviance', wiseDetails: 'Wise USD 123' }); full.settings[4].value.clutchUrl = 'https://clutch.co/profile/aviance';
  const fr = renderDetailsSet({ data: full });
  assert.equal(fr.state, '<span class="pill green" id="ydPill">All filled in</span>'); assert.ok(fr.body.includes('<p class="tk-status green">Everything is filled in.</p>') && !fr.body.includes('needed before the first trial') && !fr.body.includes('tk-yd-field need'));
  assert.ok(fr.body.includes('<textarea id="ydIn-OWNER_address" data-tk-form rows="3" autocomplete="off">12 Main St, Austin TX</textarea>'));
  // one row per field
  const d = renderDetailsSet({ data: configStates.dotted });
  assert.equal(d.state, '<span class="pill amber" id="ydPill">3 still to fill in</span>');
  assert.ok(field(d.body, 'OWNER.signerName').includes('value="Limeth Sith"') && field(d.body, 'PAYMENT.paypalMe').includes('value="https://paypal.me/aviance"') && field(d.body, 'OWNER.address').includes('tk-yd-field need'));
  // a setting the system does not have yet
  const part = renderDetailsSet({ data: { settings: configStates.some.settings.filter((r) => r.key !== 'REVIEW') } }).body;
  assert.ok(field(part, 'REVIEW.clutchUrl').includes("Your system doesn't have this setting yet — ask your developer for the newest update."));
  // loading, error, escaped, plain words
  assert.ok(renderDetailsSet({}).body.includes('Loading your details…') && renderDetailsSet({}).state === '');
  assert.ok(renderDetailsSet({ err: 'Offline' }).body.includes('Offline <button type="button" class="tk-textbtn" onclick="ydRetry()">Try again</button>'));
  const evil = clone(configStates.some); evil.settings[0].value.signerName = '"><script>alert(1)</script>'; evil.settings[0].value.address = '</textarea><img src=x onerror=alert(2)>';
  const ev = renderDetailsSet({ data: evil }).body;
  assert.ok(!ev.includes('<script>alert') && !ev.includes('<img src=x') && ev.includes('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
  for (const [n, s2] of Object.entries(configStates)) { const t = visibleText(renderDetailsSet({ data: s2 }).body); assert.ok(!BANNED.test(t), n + ': ' + (t.match(BANNED) || [])[0]); }
});

test('Settings › Your details: Save (Enter too) and Clear post the right bodies — the whole top-level row with the one field changed (the machine as built), or the field\'s own row when the machine lists one per field; values as JSON; checks; plain success / the reason', async () => {
  const st = await openSet({ cfg: configStates.some });
  try {
    assert.equal(st.gets(CFG), 1, 'opening Settings asks for the details once');
    assert.ok(el('tkHost').innerHTML.includes('<span class="tk-set-title">Your details</span>') && el('tkHost').innerHTML.includes('<span class="pill amber" id="ydPill">4 still to fill in</span>'));
    await trialsTick(); assert.equal(st.gets(CFG), 1, 'the 60-second refresh does not ask again');
    // the address: the whole OWNER row goes, with the address in it (a string, JSON-encoded by the request)
    el('ydIn-OWNER_address').value = ' 12 Main St\nAustin, TX 78701 ';
    let p = ydSave('OWNER.address');
    assert.equal(el('ydSave-OWNER_address').textContent, 'Saving…'); assert.equal(el('ydSave-OWNER_address').disabled, true);
    await p;
    const [, , body] = st.posts(CFG).pop();
    assert.deepEqual(body, { action: 'set', key: 'OWNER', value: { usHours: ['09:00', '17:00'], signerName: 'Limeth Sith', address: '12 Main St\nAustin, TX 78701', email: 'owner@example.com', telegramChatId: null } });
    assert.equal(typeof JSON.parse(JSON.stringify(body)).value.address, 'string', 'the value travels as JSON text, line breaks kept');
    assert.equal(toastText(), 'Saved — your postal address');
    assert.equal(el('ydMsg-OWNER_address').innerHTML, 'Saved.'); assert.equal(el('ydMsg-OWNER_address').className, 'tk-yd-msg green');
    assert.equal(st.gets(CFG), 2, 'the details are read again');
    assert.ok(el('ydField-OWNER_address').outerHTML.startsWith('<div class="tk-yd-field" id="ydField-OWNER_address">') && el('ydField-OWNER_address').outerHTML.includes('needed — filled in'), 'the amber mark goes');
    assert.equal(el('ydPill').outerHTML, '<span class="pill amber" id="ydPill">3 still to fill in</span>');
    assert.equal(el('ydSave-OWNER_address').textContent, 'Save'); assert.equal(el('ydSave-OWNER_address').disabled, false);
    assert.equal(tk.setOpen.details, true, 'the section stays open');
    // Enter saves a one-line box; a wrong email or a half link is refused before anything is sent
    let prevented = 0; const n0 = st.posts(CFG).length;
    el('ydIn-OWNER_email').value = 'not-an-email'; ydKey({ key: 'Enter', preventDefault: () => { prevented++; } }, 'OWNER.email'); await tick();
    assert.equal(prevented, 1); assert.equal(st.posts(CFG).length, n0); assert.equal(el('ydMsg-OWNER_email').innerHTML, 'Type the whole email address, like name@example.com.'); assert.equal(el('ydMsg-OWNER_email').className, 'tk-yd-msg red');
    el('ydIn-OWNER_email').value = 'me@aviance.store'; ydKey({ key: 'Enter' }, 'OWNER.email'); await tick(); await tick();
    assert.deepEqual(st.posts(CFG).pop()[2].value.email, 'me@aviance.store');
    ydKey({ key: 'a' }, 'OWNER.email'); await tick(); assert.equal(st.posts(CFG).length, n0 + 1, 'other keys do nothing');
    el('ydIn-PAYMENT_paypalMe').value = 'paypal.me/aviance'; await ydSave('PAYMENT.paypalMe');
    assert.equal(st.posts(CFG).length, n0 + 1); assert.equal(el('ydMsg-PAYMENT_paypalMe').innerHTML, 'Paste the whole link, starting with https://.');
    el('ydIn-PAYMENT_paypalMe').value = 'https://paypal.me/aviance'; await ydSave('PAYMENT.paypalMe');
    assert.deepEqual(st.posts(CFG).pop()[2], { action: 'set', key: 'PAYMENT', value: { paypalMe: 'https://paypal.me/aviance', wiseDetails: null } });
    // an empty box saves as "back to the default" (the field's default back in the row); Clear does the same
    el('ydIn-OWNER_email').value = ''; await ydSave('OWNER.email');
    assert.deepEqual(st.posts(CFG).pop()[2], { action: 'set', key: 'OWNER', value: { usHours: ['09:00', '17:00'], signerName: 'Limeth Sith', address: '12 Main St\nAustin, TX 78701', email: null, telegramChatId: null } });
    assert.equal(toastText(), 'Cleared — your email address');
    await ydReset('OWNER.signerName');
    assert.deepEqual(st.posts(CFG).pop()[2], { action: 'set', key: 'OWNER', value: { usHours: ['09:00', '17:00'], signerName: null, address: '12 Main St\nAustin, TX 78701', email: null, telegramChatId: null } });
    assert.ok(el('ydField-OWNER_signerName').outerHTML.includes('tk-yd-field need') && el('ydField-OWNER_signerName').outerHTML.includes('needed before the first trial'), 'cleared: needed again');
    // the reason when the machine says no
    st.cfgErr = 'OWNER.email: expected text'; el('ydIn-OWNER_email').value = 'x@y.co'; await ydSave('OWNER.email');
    assert.equal(el('ydMsg-OWNER_email').innerHTML, 'OWNER.email: expected text.'); assert.equal(el('ydMsg-OWNER_email').className, 'tk-yd-msg red'); assert.equal(el('ydIn-OWNER_email').value, 'x@y.co', 'what was typed stays');
    st.cfgErr = null;
    // one at a time
    ydState.busy = 'OWNER.address'; const r = await ydSave('OWNER.email'); assert.equal(r.busy, true); ydState.busy = null;
    // a machine with one row per field: set / reset on that row
    st.cfg = clone(configStates.dotted); await loadDetails(true); trialsRepaint('settings');
    el('ydIn-OWNER_address').value = '1 Side St'; await ydSave('OWNER.address');
    assert.deepEqual(st.posts(CFG).pop()[2], { action: 'set', key: 'OWNER.address', value: '1 Side St' });
    await ydReset('PAYMENT.paypalMe');
    assert.deepEqual(st.posts(CFG).pop()[2], { action: 'reset', key: 'PAYMENT.paypalMe' });
    el('ydIn-OWNER_email').value = ''; await ydSave('OWNER.email');
    assert.deepEqual(st.posts(CFG).pop()[2], { action: 'reset', key: 'OWNER.email' });
    // the pure bodies
    const rows = configStates.some.settings;
    assert.deepEqual(ydSaveBody(rows, 'REVIEW.clutchUrl', 'https://clutch.co/x'), { action: 'set', key: 'REVIEW', value: { clutchUrl: 'https://clutch.co/x' } });
    assert.deepEqual(ydResetBody(rows, 'CALENDAR.meetingLink').value.meetingLink, null);
    assert.deepEqual(ydSaveBody([], 'OWNER.signerName', 'x'), { action: 'set', key: 'OWNER.signerName', value: 'x' }, 'unknown rows: the field\'s own key');
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 4. in Settings, deep links, ⌘K, "Is everything running?" ───────────── */
test('Settings: Your details and Keys sit after Phone alerts with their folded labels; #settings/keys and #settings/details open them; ⌘K lists them; "Is everything running?" points to what is still missing; signing out forgets', async () => {
  const s = renderSettings({ hub: fullHub, alerts: [], open: {}, keys: { data: keysStates.mixed }, owner: { data: configStates.some }, left: { keys: 1, details: 4 }, now: NOW });
  const titles = [...s.matchAll(/<span class="tk-set-title">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(titles.slice(0, 5), ['Alerts', 'Phone alerts', 'Your details', 'Keys', 'Google Meet']);
  assert.ok(s.includes('<details class="tk-set" id="tkSet-details" ontoggle="trialsSettingsToggle(&quot;details&quot;,this.open)"><summary><span class="tk-set-head"><span class="tk-set-title">Your details</span><span class="tk-set-sub">Your name, address and links — what the emails say about you.</span></span><span class="pill amber" id="ydPill">4 still to fill in</span></summary>'));
  assert.ok(s.includes('<details class="tk-set" id="tkSet-keys" ontoggle="trialsSettingsToggle(&quot;keys&quot;,this.open)"><summary><span class="tk-set-head"><span class="tk-set-title">Keys</span><span class="tk-set-sub">The keys for the free services the system uses. Paste each one once.</span></span><span class="pill red" id="kyPill">4 of 5 set — 1 problem</span></summary>'));
  assert.ok(TK_SETTINGS.includes('keys') && TK_SETTINGS.includes('details'));
  assert.equal(tkSettingsLabel('keys'), 'Open Settings › Keys'); assert.equal(tkSettingsLabel('details'), 'Open Settings › Your details');
  // Is everything running? — the way to both while something is missing; nothing when all is in
  const run = between(s, 'id="tkSet-status"', 'id="tkSet-behind"');
  assert.ok(run.includes('<p class="tk-note tk-gap">Not finished yet: 1 key still to paste <button type="button" class="tk-textbtn" onclick="openSettings(&quot;keys&quot;)">Open Settings › Keys</button> · 4 of your details still to fill in <button type="button" class="tk-textbtn" onclick="openSettings(&quot;details&quot;)">Open Settings › Your details</button></p>'));
  assert.ok(renderSystemStatus(fullHub.machine, { now: NOW, left: { keys: 2, details: 0 } }).includes('Not finished yet: 2 keys still to paste <button') && !renderSystemStatus(fullHub.machine, { now: NOW, left: { keys: 2, details: 0 } }).includes('your details'));
  assert.ok(!renderSystemStatus(fullHub.machine, { now: NOW, left: { keys: 0, details: 0 } }).includes('Not finished yet') && !renderSystemStatus(fullHub.machine, { now: NOW }).includes('Not finished yet'));
  // the plain-words rule over the whole of Settings with both sections open
  const all = visibleText(renderSettings({ hub: fullHub, alerts: fullHub.alerts, open: TK_SETTINGS.reduce((o, k) => ((o[k] = true), o), {}), keys: { data: keysStates.mixed }, owner: { data: configStates.empty }, left: { keys: 1, details: 7 }, phone: 'On', email: 'owner@example.com', now: NOW }));
  assert.ok(!/\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|jwt|payload)\b/i.test(all), 'Settings: ' + (all.match(/\b(states?|pipeline|tick|heartbeat|machine|systems|smtp|imap|jwt|payload)\b/i) || [])[0]);
  // deep links
  assert.deepEqual(parseDeepLink('#settings/keys'), { view: 'settings', section: 'keys' });
  assert.deepEqual(parseDeepLink('/#settings/details/'), { view: 'settings', section: 'details' });
  assert.deepEqual(parseDeepLink('https://aviance.store/#settings/keys'), { view: 'settings', section: 'keys' });
  assert.deepEqual(parseDeepLink('#settings/warmup'), { view: 'settings', section: 'warmup' }, 'the old one still works');
  for (const b of ['#settings/key', '#settings/keys/x', '#keys', '#settings/detail', '#settings/alerts', '#details']) assert.equal(parseDeepLink(b), null, b);
  const st = await openSet({});
  try {
    const go = (h) => goDeepLink(parseDeepLink(h));
    render('trials'); el('tkSet-keys')._scrolled = 0; go('#settings/keys'); await tick(); trialsOnRender('settings');
    assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.keys, true);
    assert.ok(el('content').innerHTML.includes('<details class="tk-set" id="tkSet-keys" open')); assert.ok(el('tkSet-keys')._scrolled >= 1, 'scrolled into view');
    go('#settings/details'); await tick(); assert.equal(tk.setOpen.details, true); assert.ok(el('content').innerHTML.includes('<details class="tk-set" id="tkSet-details" open'));
    // the live page: both sections with their pills from the machine's answers
    assert.ok(el('tkHost').innerHTML.includes('<span class="pill red" id="kyPill">4 of 5 set — 1 problem</span>') && el('tkHost').innerHTML.includes('<span class="pill amber" id="ydPill">4 still to fill in</span>'));
    assert.ok(between(el('tkHost').innerHTML, 'id="tkSet-status"', 'id="tkSet-behind"').includes('1 key still to paste') && between(el('tkHost').innerHTML, 'id="tkSet-status"', 'id="tkSet-behind"').includes('4 of your details still to fill in'));
    // signed out: kept until sign-in
    authUser = null; pendingDeepLink = null; assert.equal(go('#settings/keys'), false); assert.deepEqual(pendingDeepLink, { view: 'settings', section: 'keys' }); pendingDeepLink = null; asOwner();
    // ⌘K
    const ck = trialsCmdkActions();
    assert.ok(ck.some((a) => a.label === 'Keys' && a.sub === 'Settings › the keys for the free services' && /verifalia/.test(a.kw)));
    assert.ok(ck.some((a) => a.label === 'Your details' && a.sub === 'Settings › your name, address and links' && /paypal/.test(a.kw)));
    ck.find((a) => a.label === 'Keys').run(); assert.equal(currentView, 'settings'); assert.equal(tk.setOpen.keys, true);
    // signing out forgets everything, including what a card last said
    kyState.msg.PLACES_API_KEY = { ok: true, text: 'x' }; ydState.msg['OWNER.email'] = { ok: true, text: 'y' };
    trialsForget();
    assert.deepEqual([kyState.s, kyState.sErr, kyState.busy, kyState.msg, ydState.s, ydState.busy, ydState.msg], [null, null, null, {}, null, null, {}]);
  } finally { offline(); trialsStopTimer(); calendarStopTimer(); }
});

/* ───────────── 5. files, touch targets, the phone ───────────── */
test('files: keys.js is loaded after warmup.js and before push.js and syntax-checked; touch targets 44 px+; 16 px in the boxes; nothing wider than a phone; the readability floor', () => {
  assert.ok(html.indexOf('<script src="warmup.js"></script>') < html.indexOf('<script src="keys.js"></script>') && html.indexOf('<script src="keys.js"></script>') < html.indexOf('<script src="push.js"></script>'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.check.includes('node --check keys.js'));
  const css = fs.readFileSync(path.join(root, 'trials.css'), 'utf8');
  for (const [sel, px] of [['.tk-ky-how>summary', 48], ['.tk-ky-opt>summary', 48], ['.tk-ky-form .field input', 46], ['.tk-ky-form .btn', 46], ['.tk-ky-acts .btn', 46], ['.tk-yd-row input,.tk-yd-row textarea', 46], ['.tk-yd-row .btn', 46]]) {
    const rule = css.match(new RegExp(sel.replace(/[.>,]/g, (c) => '\\' + c).replace(/ /g, '\\s') + '\\{([^}]*)\\}'));
    assert.ok(rule && new RegExp('min-height:' + px + 'px').test(rule[1]), sel + ' ≥ ' + px + ' px');
  }
  assert.match(css, /\.tk-ky-form \.field input\{[^}]*font-size:var\(--fs-base\)/, '16 px in the key boxes (no iPhone zoom)');
  assert.match(css, /\.tk-yd-row input,\.tk-yd-row textarea\{[^}]*font-size:var\(--fs-base\)/, '16 px in the detail boxes');
  assert.ok(!/\.tk-(ky|yd)[^{]*\{[^}]*(?<![a-z-])(min-)?width:\s*\d{3,}px/.test(css), 'nothing wider than a phone (a max-width only shrinks)');
  assert.ok(/@media\(max-width:560px\)\{\.tk-ky-card,\.tk-yd-field\{padding:12px\}/.test(css), 'phone padding; buttons full width');
  assert.ok(!/\.tk-(ky|yd)[^{]*\{[^}]*font-size:\s*(\d|1[0-2])px/.test(css) && !/\.tk-(ky|yd)[^{]*\{[^}]*font-size:var\(--fs-(xs|tiny)\)/.test(css), 'nothing under the 13 px floor: only the tokens');
  assert.ok(/\.tk-yd-field\.need\{[^}]*background:var\(--amber-bg\)/.test(css) && /\.tk-yd-req\.need\{[^}]*color:var\(--amber\)/.test(css), 'the amber mark uses the AA tokens');
  // the source: every machine string through esc(), links through tkSafeUrl, handler arguments through tkAttr
  const src = fs.readFileSync(path.join(root, 'keys.js'), 'utf8');
  assert.ok(!/onclick="[a-zA-Z]+\(\$\{(?!tkAttr)/.test(src), 'handler arguments only through tkAttr()');
  assert.ok(!/href="\$\{(?!esc\(k\.url\))/.test(src), 'the only link is the safe url');
});
