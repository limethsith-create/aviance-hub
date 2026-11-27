/* Tests for the installable-app bits: manifest.webmanifest, the icons, the <head> tags
   (the app can be added to the Home Screen). Run with: npm test. No browser, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f));
const plain = (o) => JSON.parse(JSON.stringify(o)); // objects made inside the vm sandbox have other prototypes
const html = read('index.html').toString();

/* PNG header: width, height, colour type (2 = RGB, 6 = RGBA). */
function png(file) {
  const b = read(file);
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file + ' is a PNG');
  assert.equal(b.subarray(12, 16).toString(), 'IHDR');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
}

test('manifest: valid JSON with everything an installable app needs', () => {
  const m = JSON.parse(read('manifest.webmanifest').toString());
  assert.equal(m.name, 'Aviance OS');
  assert.equal(m.short_name, 'Aviance');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.match(m.background_color, /^#[0-9A-F]{6}$/i);
  assert.match(m.theme_color, /^#[0-9A-F]{6}$/i);
  const sizes = m.icons.map((i) => i.sizes).sort();
  assert.deepEqual(sizes, ['192x192', '512x512']);
  for (const i of m.icons) {
    assert.equal(i.type, 'image/png');
    const p = png(i.src.replace(/^\//, ''));
    assert.equal(`${p.w}x${p.h}`, i.sizes, i.src + ' matches its declared size');
  }
});

test('icons: opaque (iOS paints transparency black on the home screen), right sizes', () => {
  for (const [f, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const p = png(f);
    assert.deepEqual([p.w, p.h], [size, size], f);
    assert.equal(p.colorType, 2, f + ' has no alpha channel');
  }
});

test('head: manifest, apple-touch-icon, home-screen app tags, theme colour', () => {
  for (const tag of [
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Aviance">',
    '<meta name="theme-color" content="#F6F7F9" id="themeColor">',
  ]) assert.ok(html.includes(tag), tag);
  assert.ok(!html.includes('push.js') && !fs.existsSync(path.join(root, 'sw.js')), 'no phone-alert script or service worker any more');
});

/* ───────────── the shell: routes, the sidebar, the phone's tab bar ─────────────
   The inline script from index.html runs in its own vm context with a tiny fake page, so
   the tests below see exactly what the browser runs. No screen file is loaded: where a test
   needs a screen it puts a stand-in function on the context. */
const shellSrc = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="finance.js">'));
const loaded = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith('http'));
const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith('http'));
const screenCode = loaded.map((f) => read(f).toString()).join('\n');

function shell(role = 'admin') {
  const els = {};
  const fakeEl = (id) => {
    const e = { id, value: '', innerHTML: '', textContent: '', style: {}, _c: new Set(), scrollTop: 0,
      addEventListener() {}, focus() {}, setAttribute() {}, querySelectorAll: () => [], closest: () => null };
    e.classList = { add: (c) => e._c.add(c), remove: (c) => e._c.delete(c), contains: (c) => e._c.has(c),
      toggle(c, f) { const on = f === undefined ? !e._c.has(c) : !!f; on ? e._c.add(c) : e._c.delete(c); return on; } };
    return e;
  };
  const el = (id) => (els[id] ||= fakeEl(id));
  const ctx = {
    console, setTimeout, clearTimeout, Promise, URLSearchParams,
    document: { body: fakeEl('body'), documentElement: fakeEl('html'), getElementById: el, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { removeItem() {} },
    navigator: {}, location: { hash: '', origin: 'https://aviance.store', pathname: '/', search: '', replace() {} }, history: { replaceState() {} },
    supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }), signOut: async () => {} } }) },
  };
  ctx.window = ctx; ctx.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), ctx, { filename: 'core.js' });
  vm.runInContext(shellSrc, ctx, { filename: 'index.html (inline script)' });
  const run = (code) => vm.runInContext(code, ctx);
  if (role) run(`authUser={uid:'u1',name:'Owner',role:${JSON.stringify(role)},email:'o@example.com'}`);
  return { ctx, run, el };
}

test('every route names a screen function that one of the loaded files defines', () => {
  const { run } = shell();
  const routes = plain(run('Object.keys(views).map(v=>[v,String(views[v].fn)])'));
  assert.ok(routes.length >= 20);
  for (const [v, fn] of routes) {
    const name = /V\('(\w+)'/.exec(fn)[1];
    assert.ok(new RegExp('function\\s+' + name + '\\s*\\(').test(screenCode), `route ${v} calls ${name}, which no loaded file defines`);
  }
  for (const gone of ['calling', 'callers', 'callTargets', 'dnc', 'outreach', 'outreachClient', 'outreachThread', 'myWork', 'finalStatement'])
    assert.equal(run(`views[${JSON.stringify(gone)}]`), undefined, gone + ' is not a route any more');
});

test('nothing the shell calls by name is missing: every hook is defined in a loaded file', () => {
  const { run } = shell();
  const hooks = [...plain(run('RENDER_HOOKS.concat(FORGET_HOOKS)')),
    ...[...shellSrc.matchAll(/typeof (\w+)==='function'/g)].map((m) => m[1]),
    ...[...shellSrc.matchAll(/\bn\('(\w+)'\)/g)].map((m) => m[1])];
  assert.ok(hooks.length > 15);
  for (const h of new Set(hooks)) {
    if (['f', 'render'].includes(h) || /^window\b/.test(h)) continue;
    assert.ok(new RegExp('function\\s+' + h + '\\s*\\(').test(screenCode + shellSrc), `the shell asks for ${h}(), which no loaded file defines`);
  }
  for (const stale of ['trialsOnRender', 'numbersOnRender', 'peopleSignedIn', 'openNewPayingClient', 'googleReturn', 'calendarCmdkActions', 'closeSidebar'])
    assert.ok(!shellSrc.includes(stale), stale + ' is gone');
});

test('index.html loads no file twice, none for a removed screen, and npm run check covers exactly the files that exist', () => {
  assert.equal(new Set(loaded).size, loaded.length); assert.equal(new Set(sheets).size, sheets.length);
  for (const f of [...loaded, ...sheets]) {
    assert.ok(fs.existsSync(path.join(root, f)), f + ' exists');
    assert.ok(!/^(calling|outreach)/.test(f), f + ' belonged to a removed screen');
  }
  const pkg = JSON.parse(read('package.json').toString());
  const checked = pkg.scripts.check.split(' && ').map((c) => c.replace('node --check ', '')).sort();
  const onDisk = fs.readdirSync(root).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(checked, onDisk);
  // the shell's own script still sits straight after the two it needs, and before every screen
  assert.ok(html.indexOf('supabase-js@') < html.indexOf('<script src="channels-api.js">'));
  assert.ok(html.indexOf('<script src="channels-api.js">') < html.indexOf('<script>\n'));
  assert.ok(html.indexOf('<script src="channels-api.js">') > html.indexOf('<body>'), 'nothing from another site holds up the first paint');
  assert.ok(!/<link[^>]+fonts\.googleapis\.com\/css2[^>]+rel="stylesheet">/.test(html), 'the web fonts do not block the first paint');
});

test('the sidebar: eleven plain places for the owner, each with its own icon, most used first', () => {
  const { run } = shell('admin');
  const items = plain(run('navItems()'));
  assert.deepEqual(items.map((i) => i.label), ['Today', 'Calendar', 'Replies', 'Clients', 'Channels', 'Prospects', 'Employees', 'Onboarding', 'Money', 'Documents', 'Settings']);
  assert.equal(new Set(items.map((i) => i.icon)).size, items.length, 'no two places share an icon');
  for (const i of items) { assert.ok(i.icon.startsWith('<svg'), i.label + ' has an icon'); assert.match(i.label, /^[A-Z][a-z]+$/); }
  // every screen that is not a place sits under one, with a way back
  const inNav = new Set(items.flatMap((i) => [i.view, ...(i.also || [])]));
  for (const [v, hasBack] of plain(run('Object.keys(views).map(v=>[v,!!views[v].back])'))) {
    assert.ok(inNav.has(v), v + ' lights a place in the sidebar');
    assert.equal(hasBack, !items.some((i) => i.view === v), v + (hasBack ? ' is a place and needs no Back' : ' is a page inside a place and needs Back'));
  }
});

test('a team member who is not the owner is offered no owner-only place, in the sidebar or in ⌘K', () => {
  const { run } = shell('employee');
  const labels = plain(run('navItems().map(i=>i.label)'));
  assert.deepEqual(labels, ['Today', 'Calendar', 'Replies', 'Clients', 'Channels', 'Prospects', 'Onboarding', 'Money']);
  const found = plain(run("cmdkEntities().filter(x=>x.type==='Screens').map(x=>x.label)"));
  for (const l of ['Employees', 'Documents', 'Settings']) assert.ok(!found.includes(l), l);
  assert.ok(found.includes('Calendar') && found.includes('Team'));
  const owner = shell('admin');
  const all = plain(owner.run("cmdkEntities().filter(x=>x.type==='Screens').map(x=>x.label)"));
  for (const l of ['Prospects', 'Employees', 'Documents', 'Settings', 'Replies', 'Onboarding', 'No-shows']) assert.ok(all.includes(l), l);
  for (const l of ['Outreach', 'Calling']) assert.ok(!all.includes(l), l + ' is gone from ⌘K');
});

test('badges say what they count, in the singular and the plural', () => {
  const { ctx, run } = shell();
  ctx.dgNavCount = () => '1'; ctx.mtNavCount = () => 2; ctx.drCount = () => 1; ctx.empCount = () => 0; ctx.jyLateCount = () => 3; ctx.chvNavCount = () => '9+';
  const by = Object.fromEntries(plain(run('navItems()')).map((i) => [i.label, i]));
  assert.equal(by.Today.badgeTitle, '1 thing needs you');
  assert.equal(by.Calendar.badgeTitle, '2 calls need an outcome');
  assert.equal(by.Replies.badgeTitle, '1 reply the bot drafted is waiting for you');
  assert.equal(by.Employees.badge, ''); assert.equal(by.Employees.badgeTitle, '');
  assert.equal(by.Onboarding.badgeTitle, '3 steps are running late');
  assert.equal(by.Channels.badgeTitle, '9+ unread');
  assert.equal(by.Money.badge, '', 'no count is invented where no screen gives one');
});

test('the phone tab bar never holds more than five: four places and More, which opens the rest', () => {
  for (const role of ['admin', 'employee']) {
    const { ctx, run, el } = shell(role);
    ctx.empCount = () => 4; ctx.jyLateCount = () => 2;
    run("currentView='journey';renderNav()");
    const tabs = el('tabBar').innerHTML.split('<button class="tab').slice(1);
    assert.equal(tabs.length, 5, role);
    assert.deepEqual(tabs.map((t) => />([A-Za-z]+)<\/span><\/button>$/.exec(t)[1]), ['Today', 'Calendar', 'Replies', 'Clients', 'More']);
    assert.ok(tabs[4].startsWith(' active') && tabs[4].includes('aria-current="page"'), 'More is lit when the open screen is behind it');
    assert.ok(tabs[4].includes('onclick="openMore()"'));
    if (role === 'admin') assert.match(tabs[4], /class="badge red" title="something is waiting in Employees, Onboarding"[^>]*>2</);
    else assert.match(tabs[4], /class="badge amber" title="something is waiting in Onboarding"[^>]*>1</);
    // the sidebar still lists every place
    assert.equal(el('navArea').innerHTML.split('<button class="nav-item').length - 1, role === 'admin' ? 11 : 8);
    run('openMore()');
    const sheet = el('modal').innerHTML;
    const rows = [...sheet.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(rows, [...(role === 'admin' ? ['Channels', 'Prospects', 'Employees', 'Onboarding', 'Money', 'Documents', 'Settings'] : ['Channels', 'Prospects', 'Onboarding', 'Money']),
      'Find a client or a screen', 'Switch light / dark', 'Sign out']);
    assert.ok(sheet.includes(`onclick="closeModal();render('journey')" aria-current="page"`));
    assert.ok(sheet.includes('onclick="closeModal();logout()"'), 'a phone can sign out');
  }
  assert.ok(html.includes('class="who-out" onclick="logout()"'), 'and so can a computer, beside your name');
});

test('a screen that reads before it draws shows Loading, then itself — never a raw promise', async () => {
  const { ctx, run, el } = shell();
  let done; ctx.viewRequests = () => new Promise((r) => { done = r; });
  run("render('requests')");
  assert.ok(el('content').innerHTML.includes('Loading') && !el('content').innerHTML.includes('[object'));
  done('<p>3 open</p>'); await new Promise((r) => setTimeout(r, 0));
  assert.ok(el('content').innerHTML.includes('<p>3 open</p>'));
  assert.equal(el('backBtn').style.display, 'grid', 'and it has a way back');
  // they moved on before it answered: the answer is dropped
  ctx.viewHome = () => '<p>today</p>';
  run("render('requests')"); const late = done; run("render('home')"); late('<p>late</p>'); await new Promise((r) => setTimeout(r, 0));
  assert.ok(el('content').innerHTML.includes('today') && !el('content').innerHTML.includes('late'));
  // one that fails says so in plain words
  ctx.viewRequests = async () => { throw new Error('The database is not answering.'); };
  run("render('requests')"); await new Promise((r) => setTimeout(r, 0));
  assert.ok(el('content').innerHTML.includes('The database is not answering.'));
  // the two screens that do this today really are async
  assert.match(read('portal.js').toString(), /async function viewRequests\(/);
});

test('deep links: the ones in use still land, and a link to a screen that is gone opens Today instead of a blank page', () => {
  const { ctx, run } = shell();
  const p = (h) => plain(run(`parseDeepLink(${JSON.stringify(h)})`));
  assert.deepEqual(p('#clients'), { view: 'clients' }); assert.deepEqual(p('#trials'), { view: 'clients' });
  assert.deepEqual(p('#onboarding'), { view: 'journey' }); assert.deepEqual(p('#drafts'), { view: 'drafts' });
  assert.deepEqual(p('#prospects'), { view: 'prospects' }); assert.deepEqual(p('#settings/keys'), { view: 'settings' });
  assert.deepEqual(p('#inquiries'), { view: 'calendar' }); assert.deepEqual(p('#calendar/m-1'), { view: 'calendar', id: 'm-1' });
  assert.deepEqual(p('#inquiry/b-1'), { view: 'inquiry', id: 'b-1' });
  for (const old of ['#numbers', '#system/abc', '#system/abc/inboxes', '#trial/abc', '#nothing']) assert.equal(p(old), null, old);
  ctx.viewHome = () => 'today';
  assert.equal(run("goDeepLink({view:'numbers'})"), true);
  assert.equal(run('currentView'), 'home');
});

test('signing out clears what every screen was holding, and boot waits for the screens to load', async () => {
  const { ctx, run } = shell();
  const cleared = [];
  for (const h of plain(run('FORGET_HOOKS'))) ctx[h] = () => cleared.push(h);
  await run('logout()');
  assert.deepEqual(cleared.sort(), plain(run('FORGET_HOOKS')).sort());
  assert.equal(run('authUser'), null);
  assert.match(shellSrc, /getSession\(\);await pageReady\(\);if\(session\)await routeUser/);
});

test('the sign-in page does not pitch, and never states the offer wrongly', () => {
  /* The sign-in page used to carry a sales panel: a headline, three bullets and
     the guarantee. Everyone who reaches it has already bought or already works
     here, so it is one centred card now. The offer itself is still stated where
     it binds — agreement_terms, mail_welcome and mail_pack in the database, and
     the client's own portal — not on the owner's sign-in screen.
     The guard against the offer drifting stays, and applies to the whole shell. */
  assert.ok(!/3 weeks/.test(html) && !/pilot/i.test(html));
  assert.ok(!/We don't sell emails/.test(html), 'no sales pitch on the sign-in screen');
  assert.match(html, /class="login-mark"/, 'the mark leads the sign-in card');
});
