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
    'callers.js', 'caller-page.js', 'outreach-adapter.js',
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

/* Meeting words. The database refused 'qualified' and 'booked' for a while,
   which would have failed every booked sales call — the one thing the whole
   business promises. Both lists are mirrored from the check constraints on
   public.meetings. */
const MEETING_KINDS = ['discovery', 'strategy', 'onboarding', 'qualified', 'review', 'check_in', 'other'];
const MEETING_STATUS = ['requested', 'booked', 'held', 'no_show', 'cancelled'];

/* A module's own vocabulary list, checked against the database's constraint.
   This compares list to list rather than grepping for stray strings: 'kind' is
   a column on meetings, channels and client_requests, and no regex can tell
   which table a given `kind:` belongs to.

   These lists mirror the CHECK constraints on the live tables. If a migration
   changes a constraint, change it here in the same commit. */
const DB = {
  'meetings.kind':   ['discovery', 'strategy', 'onboarding', 'qualified', 'review', 'check_in', 'other'],
  'meetings.status': ['requested', 'booked', 'held', 'no_show', 'cancelled'],
  'channels.kind':   ['team', 'internal', 'client'],
};

/* Pull the keys out of an object literal declared as `const NAME = { ... }`. */
function declaredKeys(file, name) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const at = src.indexOf('const ' + name + ' = {');
  assert.ok(at >= 0, `${file} no longer declares ${name}`);
  const body = src.slice(at, src.indexOf('\n};', at));
  return [...body.matchAll(/^\s{2}([a-z_]+)\s*:/gm)].map((m) => m[1]);
}

test('the meeting kinds meetings.js offers are all ones the database accepts', () => {
  const offered = declaredKeys('meetings.js', 'MT_KINDS');
  assert.ok(offered.length >= 5, 'expected the real list of call kinds');
  for (const k of offered) {
    assert.ok(DB['meetings.kind'].includes(k), `meetings.js offers kind '${k}', which the database will refuse`);
  }
  /* The one the business is built on. */
  assert.ok(offered.includes('qualified'), 'the booked sales call must be bookable');
});

test('the meeting statuses meetings.js uses are all ones the database accepts', () => {
  const used = declaredKeys('meetings.js', 'MT_STATUS');
  assert.ok(used.length >= 4, 'expected the real list of statuses');
  for (const k of used) {
    assert.ok(DB['meetings.status'].includes(k), `meetings.js uses status '${k}', which the database will refuse`);
  }
  assert.ok(used.includes('booked'), "'booked' is what every screen writes");
});

test('no retired meeting or channel word is left in the code', () => {
  /* 'confirmed' was the old word for 'booked'; 'internal' for a team channel. */
  const code = strip(fs.readFileSync(path.join(root, 'meetings.js'), 'utf8'));
  assert.ok(!code.includes("'confirmed'"), "meetings.js uses 'confirmed'; the status is 'booked' now");
});


/* ───────────── the house look, checked across every file ───────────── */

/* DESIGN.md: "no emoji in a document", and nothing in the hub either — an emoji
   renders at whatever size and colour the reader's font felt like, which is the
   opposite of a system. The icon slot of an empty state wants an inline SVG. */
test('no screen draws an emoji', () => {
  /* the pictographic blocks and the emoji-presentation selector. Typographic
     marks a document really does use — an en dash, an arrow in a comment, a
     check mark — are not emoji and are left alone. */
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
  for (const f of jsFiles.concat(['index.html', 'portal.html', 'team.html', 'doc.html', 'join.html'])) {

    const src = fs.readFileSync(path.join(root, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      assert.ok(!EMOJI.test(line), f + ':' + (i + 1) + ' draws an emoji: ' + line.trim().slice(0, 90));
    });
  }
});

/* DESIGN.md: "Every money figure, invoice number, SWIFT code, account number and
   date-stamp is mono. This is the strongest single signal of care in the whole
   system." The shell carries one figure recipe, `.fig`, for the screens whose own
   stylesheet has none. If it is used, it has to exist. */
test('the shell defines the figure class the screens ask for', () => {
  const shell = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(shell, /\.fig\{[^}]*font-family:var\(--mono\)/, 'index.html defines .fig as mono');
  assert.match(shell, /\.fig\{[^}]*tabular-nums/, 'and lines its digits up');
  for (const [file, what] of [['pipeline.js', 'the funnel counts'], ['digest.js', "the Friday update's facts"],
                              ['onboarding.js', 'the invoice amounts']]) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /class="[^"]*\bfig\b/,
      file + ' puts ' + what + ' in the figure face');
  }
});
