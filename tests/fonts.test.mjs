/* The figures face. Round 3: JetBrains Mono is served from this site on all five
   pages, so the owner and the client read the same digits in the same font. Before
   this it came from Google on index.html and team.html only, and the client's three
   pages fell back to Courier New. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const PAGES = ['index.html', 'portal.html', 'team.html', 'doc.html', 'join.html'];
const FILE = '/fonts/jetbrains-mono-latin.woff2';

test('the mono font file is in the repo, is a real woff2, and ships with its licence', () => {
  const buf = fs.readFileSync(path.join(root, 'fonts', 'jetbrains-mono-latin.woff2'));
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2');
  assert.ok(buf.length > 20000 && buf.length < 80000, 'one latin variable file, not the whole family');
  const lic = read('fonts/JetBrainsMono-LICENSE.txt');
  assert.match(lic, /JetBrains Mono Project Authors/);
  assert.match(lic, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('every page gets a stylesheet that declares the face from this site', () => {
  const declares = (css) => /@font-face\{font-family:"JetBrains Mono";[^}]*font-weight:100 800;[^}]*url\("\/fonts\/jetbrains-mono-latin\.woff2"\) format\("woff2"\)\}/.test(css);
  assert.ok(declares(read('theme.css')), 'theme.css: index.html and team.html');
  assert.ok(declares(read('portal-client.css')), 'portal-client.css: portal.html, doc.html, join.html');
  for (const p of PAGES) {
    const html = read(p);
    const sheet = /href="portal-client\.css"/.test(html) ? 'portal-client.css' : /href="theme\.css"/.test(html) ? 'theme.css' : null;
    assert.ok(sheet, p + ' loads one of the two stylesheets that declare the face');
  }
});

test('every page preloads it, so figures do not flash in a fallback first', () => {
  for (const p of PAGES) {
    assert.ok(read(p).includes('<link rel="preload" href="' + FILE + '" as="font" type="font/woff2" crossorigin>'), p);
  }
});

test('no page asks Google for JetBrains Mono any more', () => {
  for (const p of PAGES) assert.ok(!/JetBrains\+Mono/.test(read(p)), p);
});

test('the client and the owner fall back to the same stack, and it is not Courier New', () => {
  for (const f of ['theme.css', 'brand.css', 'portal-client.css']) {
    const css = read(f);
    assert.ok(!/Courier/.test(css), f + ' does not name Courier');
    const stacks = css.match(/--(?:pc-)?mono:[^;]+;/g) || [];
    assert.ok(stacks.length > 0, f + ' defines a mono stack');
    for (const s of stacks) assert.match(s, /JetBrains Mono["'],ui-monospace,SFMono-Regular,Menlo,monospace;$/, f + ': ' + s);
  }
});

test('the site policy lets the font through and lets the browser keep it', () => {
  const cfg = JSON.parse(read('vercel.json'));
  const all = cfg.headers.find((h) => h.source === '/(.*)').headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.match(all, /font-src 'self'/);
  const fonts = cfg.headers.find((h) => h.source === '/fonts/(.*)');
  assert.ok(fonts, 'fonts have their own cache rule');
  assert.match(fonts.headers[0].value, /max-age=31536000/);
});

test('discovery-engine: the README says the copy is verified, with the date and a hash per file', () => {
  const md = read('supabase/functions/discovery-engine/README.md');
  assert.match(md, /COPY VERIFIED 2026-11-27/);
  assert.ok(!/not the same\s+as a verified byte-for-byte copy/.test(md), 'the old caveat is gone');
  /* the hashes in the README are the deployed bytes; a stray edit to the copy fails here */
  for (const f of ['index.ts', 'pipeline.js', 'deliver.js', 'research.js']) {
    const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'supabase/functions/discovery-engine', f))).digest('hex');
    assert.ok(md.includes('`' + sum + '`'), f + ' still matches the hash recorded from the deployment');
  }
});
