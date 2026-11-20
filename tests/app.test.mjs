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
    '<meta name="theme-color" content="#FAFAF9" id="themeColor">',
  ]) assert.ok(html.includes(tag), tag);
  assert.ok(!html.includes('push.js') && !fs.existsSync(path.join(root, 'sw.js')), 'no phone-alert script or service worker any more');
});
