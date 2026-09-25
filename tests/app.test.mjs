/* Tests for the installable-app bits: manifest.webmanifest, the icons, the <head> tags
   and sw.js (phone alerts). Run with: npm test. No browser, no network. */
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
  assert.equal(m.name, 'Aviance Hub');
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

test('icons: opaque (iOS paints transparency black on the home screen), right sizes; badge is white on transparent', () => {
  for (const [f, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const p = png(f);
    assert.deepEqual([p.w, p.h], [size, size], f);
    assert.equal(p.colorType, 2, f + ' has no alpha channel');
  }
  const b = png('badge-96.png');
  assert.deepEqual([b.w, b.h, b.colorType], [96, 96, 6], 'badge: 96px RGBA');
});

test('head: manifest, apple-touch-icon, home-screen app tags, theme colour; push.js loads after trials.js', () => {
  for (const tag of [
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Aviance">',
    '<meta name="theme-color" content="#FFFFFF" id="themeColor">',
  ]) assert.ok(html.includes(tag), tag);
  assert.ok(html.indexOf('<script src="trials.js"></script>') < html.indexOf('<script src="push.js"></script>'));
});

test('sw.js: valid script, no fetch handler (nothing cached, never stale), has a version constant', () => {
  const r = spawnSync(process.execPath, ['--check', path.join(root, 'sw.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const src = read('sw.js').toString();
  assert.match(src, /const SW_VERSION = 'aviance-sw-\d+';/);
  assert.ok(!/addEventListener\(\s*['"]fetch['"]/.test(src), 'no fetch handler');
  assert.ok(!/caches\./.test(src), 'no Cache Storage');
});

/* Run sw.js in a sandbox with a fake service-worker global. */
function loadSw({ windows = [] } = {}) {
  const on = {}, shown = [], opened = [], claimed = [], skipped = [];
  const self = {
    location: { origin: 'https://aviance.store' },
    addEventListener: (t, f) => { on[t] = f; },
    skipWaiting: () => { skipped.push(1); return Promise.resolve(); },
    registration: { showNotification: (title, opts) => { shown.push({ title, opts }); return Promise.resolve(); } },
    clients: {
      claim: () => { claimed.push(1); return Promise.resolve(); },
      matchAll: async (o) => { assert.deepEqual(plain(o), { type: 'window', includeUncontrolled: true }); return windows; },
      openWindow: async (u) => { opened.push(u); return null; },
    },
  };
  const ctx = vm.createContext({ self, URL, Date, Number, String, JSON, Promise });
  vm.runInContext(read('sw.js').toString(), ctx, { filename: 'sw.js' });
  const fire = async (type, ev) => { let p = null; ev.waitUntil = (x) => { p = x; }; on[type](ev); await p; };
  return { on, shown, opened, claimed, skipped, fire };
}
const jsonData = (o) => ({ json: () => o, text: () => JSON.stringify(o) });
const textData = (t) => ({ json: () => { throw new SyntaxError('not JSON'); }, text: () => t });

test('sw.js: install/activate take over at once', async () => {
  const sw = loadSw();
  sw.on.install({}); assert.equal(sw.skipped.length, 1);
  await sw.fire('activate', {}); assert.equal(sw.claimed.length, 1);
});

test('sw.js: an urgent alert stays on screen and re-alerts; a normal one does not', async () => {
  const sw = loadSw();
  await sw.fire('push', { data: jsonData({ title: 'Acme Plumbing: bounce rate 2.4%', body: 'Sending stopped.', url: '/#trial/acme-plumbing', tag: 'bounce:acme-plumbing', urgent: true, at: '2026-09-25T08:00:00Z' }) });
  const u = sw.shown[0];
  assert.equal(u.title, 'Acme Plumbing: bounce rate 2.4%');
  assert.equal(u.opts.body, 'Sending stopped.');
  assert.equal(u.opts.tag, 'bounce:acme-plumbing', 'same alert key replaces the previous notification');
  assert.deepEqual(plain(u.opts.data), { url: '/#trial/acme-plumbing' });
  assert.equal(u.opts.icon, '/icon-192.png'); assert.equal(u.opts.badge, '/badge-96.png');
  assert.equal(u.opts.renotify, true); assert.equal(u.opts.requireInteraction, true);
  assert.equal(u.opts.timestamp, Date.parse('2026-09-25T08:00:00Z'));
  await sw.fire('push', { data: jsonData({ title: 'Heads up', body: 'x', url: '/#alerts', tag: 't', urgent: false }) });
  assert.equal(sw.shown[1].opts.renotify, false); assert.equal(sw.shown[1].opts.requireInteraction, false);
  await sw.fire('push', { data: jsonData({ title: 'No tag', urgent: true }) });
  assert.ok(!('renotify' in sw.shown[2].opts) && !('tag' in sw.shown[2].opts), 'renotify needs a tag, so none is set');
  assert.equal(sw.shown[2].opts.data.url, '/', 'no url → the board');
});

test('sw.js: a plain-text or empty push still shows something readable; foreign urls are not followed', async () => {
  const sw = loadSw();
  await sw.fire('push', { data: textData('Machine heartbeat missed') });
  assert.equal(sw.shown[0].title, 'Aviance Hub'); assert.equal(sw.shown[0].opts.body, 'Machine heartbeat missed');
  await sw.fire('push', { data: null });
  assert.equal(sw.shown[1].title, 'Aviance Hub'); assert.match(sw.shown[1].opts.body, /Open the hub/);
  for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 42]) {
    await sw.fire('push', { data: jsonData({ title: 'x', url: bad }) });
    assert.equal(sw.shown[sw.shown.length - 1].opts.data.url, '/', String(bad));
  }
});

test('sw.js: tapping a notification focuses the open hub and sends it to the page; otherwise opens the hub there', async () => {
  const posted = [], focused = [];
  const hubWin = { url: 'https://aviance.store/', focus: async () => { focused.push(1); }, postMessage: (m) => posted.push(m) };
  const other = { url: 'https://example.com/', focus: async () => { throw new Error('wrong window'); }, postMessage: () => { throw new Error('wrong window'); } };
  let sw = loadSw({ windows: [other, hubWin] });
  let closed = 0;
  await sw.fire('notificationclick', { notification: { data: { url: '/#trial/acme-plumbing' }, close: () => { closed++; } } });
  assert.equal(closed, 1); assert.equal(focused.length, 1);
  assert.equal(posted[0].type, 'aviance:open'); assert.equal(posted[0].url, '/#trial/acme-plumbing');
  assert.equal(sw.opened.length, 0);
  sw = loadSw({ windows: [] });
  await sw.fire('notificationclick', { notification: { data: { url: '/#alerts' }, close() {} } });
  assert.deepEqual(sw.opened, ['https://aviance.store/#alerts']);
  await sw.fire('notificationclick', { notification: { data: { url: 'https://evil.example/' }, close() {} } });
  assert.equal(sw.opened[1], 'https://aviance.store/');
});
