/* One vocabulary, checked across every file.
   The hub used to have stages for features it no longer has — sending,
   warming_up, setting_up, finished. A module left holding an old word does not
   crash; it just quietly counts nothing, which is worse. So the words live
   here, and every file is checked against them. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const jsFiles = fs.readdirSync(root).filter((f) => f.endsWith('.js'));

/* The agreed stages, in journey order. Mirrors the clients_stage_check
   constraint in the database. */
const STAGES = ['enquiry', 'booked', 'won', 'onboarding', 'live', 'at_risk', 'paused', 'ended', 'lost'];

/* Words that USED to be stages. A module still using one is a bug. */
const RETIRED = ['warming_up', 'setting_up'];

/* Files allowed to say 'sending', 'warming' or 'finished': those are the
   outreach provider's own words for an inbox warming up, a message on its way
   out, or a campaign that has run its course — nothing to do with a client's
   stage. */
const PROVIDER_WORDS = new Set(['outreach.js', 'outreach-demo.js', 'outreach-adapter.js', 'outreach-smartlead.js', 'outreach-instantly.js']);

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no file uses a stage word that was retired with the sending features', () => {
  for (const f of jsFiles) {
    const code = strip(fs.readFileSync(path.join(root, f), 'utf8'));
    for (const word of RETIRED) {
      assert.ok(!code.includes(word), `${f} still uses the retired stage '${word}'`);
    }
  }
});

test("only the outreach files may say 'sending', 'warming' or 'finished'", () => {
  for (const f of jsFiles) {
    if (PROVIDER_WORDS.has(f)) continue;
    const code = strip(fs.readFileSync(path.join(root, f), 'utf8'));
    for (const word of ["'sending'", "'warming'", "'finished'"]) {
      assert.ok(!code.includes(word), `${f} uses ${word}; a client's stage is one of: ${STAGES.join(', ')}`);
    }
  }
});

test('every stage a module writes to clients.stage is one the database allows', () => {
  for (const f of jsFiles) {
    const code = strip(fs.readFileSync(path.join(root, f), 'utf8'));
    for (const m of code.matchAll(/stage\s*:\s*'([a-z_]+)'/g)) {
      assert.ok(STAGES.includes(m[1]), `${f} writes stage '${m[1]}', which the database will refuse`);
    }
  }
});

test('the stage lists modules keep in step hold only real stages', () => {
  for (const f of jsFiles) {
    const code = strip(fs.readFileSync(path.join(root, f), 'utf8'));
    /* any array literal of bare lowercase strings assigned to a *STAGES* name */
    for (const m of code.matchAll(/[A-Z_]*STAGES[A-Za-z_]*\s*=\s*\[([^\]]*)\]/g)) {
      const words = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      for (const w of words) {
        assert.ok(STAGES.includes(w), `${f} lists '${w}' as a stage; it is not one of: ${STAGES.join(', ')}`);
      }
    }
  }
});

test('no file calls another server', () => {
  for (const f of jsFiles) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const bad of ['machineFetch', 'MACHINE_URL', 'email-distributor']) {
      assert.ok(!src.includes(bad), `${f} still contains ${bad}`);
    }
  }
});

test('index.html calls another server nowhere either', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const bad of ['machineFetch', 'MACHINE_URL', 'email-distributor']) {
    assert.ok(!html.includes(bad), `index.html still contains ${bad}`);
  }
});

test('every script and stylesheet index.html asks for actually exists', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const wanted = [
    ...[...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]),
  ].filter((p) => !p.startsWith('http'));
  assert.ok(wanted.length > 20, 'expected index.html to load the hub files');
  for (const p of wanted) {
    assert.ok(fs.existsSync(path.join(root, p)), `index.html loads ${p}, which is not in the repo`);
  }
});

test('every browser file is syntax-checked by npm run check', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const f of jsFiles) {
    assert.ok(pkg.scripts.check.includes('node --check ' + f), `${f} is missing from the check script`);
  }
});

/* The two stage bugs this file exists to catch were both written by someone
   reading a comment that described the old hub. So the prose is checked too. */
test('no file mentions a module that was deleted, even in a comment', () => {
  const RETIRED_FILES = [
    'trials.js', 'calendar.js', 'inquiries.js', 'messages.js', 'warmup.js',
    'keys.js', 'autobuy.js', 'seats.js', 'people.js', 'numbers.js',
    'cleanup.js', 'feed.js', 'stages.js',
  ];
  const sources = [...jsFiles, 'index.html'];
  for (const f of sources) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const gone of RETIRED_FILES) {
      assert.ok(
        !src.includes(gone),
        `${f} mentions ${gone}, which no longer exists — a stale comment is how the last two bugs got written`
      );
    }
  }
});
