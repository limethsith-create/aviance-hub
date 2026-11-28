// Who is on aviance.online, as the Live screen reads it.
//
// The beacon and the alerting live in a Deno edge function, which node cannot
// run, so those properties are pinned by reading the function's source the way
// tests/server-fixes.test.mjs pins SQL. Everything node CAN run — the words,
// the badge, the rows, the timer — is exercised properly.
//
// The rules worth not breaking:
//   * nothing on this screen names anybody
//   * the badge is red only when somebody is actually booking
//   * the timer stops when the screen is left
//   * a missing table reads as a sentence, not a stack trace
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

let rows = [];
let failWith = null;

function shell() {
  const timers = [];
  const ctx = {
    console,
    document: {
      visibilityState: 'visible',
      getElementById: () => null,
    },
    setInterval: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].live = false },
    sb: {
      from() {
        const api = {
          select: () => api,
          limit: () => api,
          then: (res, rej) =>
            Promise.resolve(failWith ? { data: null, error: failWith } : { data: rows, error: null })
              .then(res, rej),
        };
        return api;
      },
    },
    URL,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('core.js'), ctx);
  vm.runInContext(read('live.js'), ctx);
  return { ctx, timers, run: (src) => vm.runInContext(src, ctx) };
}

const visitor = (over = {}) => ({
  id: 'v1', session_key: 'abc12345', path: '/', first_path: '/', referrer: '',
  country: 'US', city: 'Denver', device: 'desktop', stage: 'browsing',
  page_views: 1, seconds_here: 42, seconds_quiet: 3, ...over,
});

test('live.js uses core.js by identity, like every other screen', () => {
  const { run } = shell();
  for (const [ours, theirs] of [['lvOk', 'coreOk'], ['lvErr', 'coreErr'],
    ['lvEsc', 'coreEsc'], ['lvAgo', 'coreAgo']]) {
    assert.equal(run(ours + ' === ' + theirs), true, ours + ' is ' + theirs);
  }
});

test('nobody on the site reads as nobody, not as a failure', async () => {
  rows = []; failWith = null;
  const { run } = shell();
  await run('lvLoad()');
  assert.equal(run('lvNavCount()'), '', 'no badge for an empty site');
  const html = run('lvBody()');
  assert.match(html, /Nobody is on the site right now/);
  assert.doesNotMatch(html, /error|failed/i);
});

test('the badge counts heads and turns red only for somebody booking', async () => {
  failWith = null;
  rows = [visitor(), visitor({ id: 'v2', session_key: 'def45678' })];
  const a = shell();
  await a.run('lvLoad()');
  assert.equal(a.run('lvNavCount()'), '2');
  assert.equal(a.run('lvNavTone()'), 'amber', 'two people reading is not an emergency');

  rows = [visitor(), visitor({ id: 'v2', session_key: 'def45678', stage: 'booking' })];
  const b = shell();
  await b.run('lvLoad()');
  assert.equal(b.run('lvNavTone()'), 'red', 'somebody booking is worth looking up for');
});

test('a row says where, what and how long — and never who', async () => {
  failWith = null;
  rows = [visitor({ referrer: 'https://chatgpt.com/', path: '/book', stage: 'booking' })];
  const { run } = shell();
  await run('lvLoad()');
  const html = run('lvBody()');
  assert.match(html, /Denver, US/);
  assert.match(html, /the booking page/);
  assert.match(html, /from ChatGPT/);
  assert.match(html, /Booking a call/);
  // the session key is the only identifier there is, and it is not for showing
  assert.doesNotMatch(html, /abc12345/, 'the session key never reaches the screen');
});

test('where they came from, in words', () => {
  const { run } = shell();
  assert.equal(run('lvSource('+JSON.stringify('')+')'), 'came straight here');
  assert.equal(run('lvSource('+JSON.stringify('https://www.google.com/search?q=x')+')'), 'from Google');
  assert.equal(run('lvSource('+JSON.stringify('https://www.perplexity.ai/')+')'), 'from Perplexity');
  assert.equal(run('lvSource('+JSON.stringify('https://claude.ai/')+')'), 'from Claude');
  assert.equal(run('lvSource('+JSON.stringify('https://www.aviance.online/compare')+')'), '', 'our own pages are not a source');
  assert.equal(run('lvSource('+JSON.stringify('not a url')+')'), 'came straight here');
});

test('the pages read as pages, not as paths', () => {
  const { run } = shell();
  assert.equal(run('lvPage('+JSON.stringify('/')+')'), 'the home page');
  assert.equal(run('lvPage('+JSON.stringify('/book')+')'), 'the booking page');
  assert.equal(run('lvPage('+JSON.stringify('/compare')+')'), 'the comparisons');
  assert.equal(run('lvPage('+JSON.stringify('/compare/in-house-sdr')+')'), 'in house sdr');
});

test('how long they have been here, in the shortest true form', () => {
  const { run } = shell();
  assert.equal(run('lvFor('+JSON.stringify(9)+')'), '9s');
  assert.equal(run('lvFor('+JSON.stringify(130)+')'), '2m');
  assert.equal(run('lvFor('+JSON.stringify(7200)+')'), '2h');
  assert.equal(run('lvFor('+JSON.stringify(null)+')'), '0s');
  assert.equal(run('lvFor('+JSON.stringify(-5)+')'), '0s', 'a clock skew is not negative time');
});

test('a missing table says what to run, not what threw', async () => {
  rows = [];
  failWith = { message: 'relation "public.v_site_live" does not exist' };
  const { run } = shell();
  await run('lvLoad()');
  const html = run('lvBody()');
  assert.match(html, /20261128_site_presence\.sql/);
  assert.doesNotMatch(html, /relation|public\./, 'no database words on a screen');
  assert.equal(run('lvNavCount()'), '', 'a failure does not badge the sidebar with a number');
});

test('the timer runs only while the screen is open', () => {
  rows = []; failWith = null;
  const { timers, run } = shell();
  run("lvOnRender('live')");
  assert.equal(timers.filter((t) => t.live).length, 1, 'one timer while Live is open');
  run("lvOnRender('home')");
  assert.equal(timers.filter((t) => t.live).length, 0, 'and none once it is left');
  // opening it twice does not leave two behind
  run("lvOnRender('live')"); run("lvOnRender('live')");
  assert.equal(timers.filter((t) => t.live).length, 1);
});

test('the beacon keeps nothing that identifies anybody', () => {
  const fn = read('supabase/functions/site-beacon/index.ts');
  for (const bad of ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip']) {
    assert.ok(!fn.includes(bad), 'no IP address is read: ' + bad);
  }
  assert.ok(/user-agent/.test(fn) && /phone' : 'desktop'/.test(fn),
    'the user agent is reduced to one word and not stored');
  // the owner's own browsing never reaches his phone
  assert.match(fn, /if \(!row \|\| row\.is_owner\) return/);
  // and nobody is told twice about the same session
  assert.match(fn, /if \(!row\.alerted_at\)/);
  assert.match(fn, /stage === 'booking' && !row\.booking_alerted_at/);
});

test('the beacon sends nothing when no provider is configured', () => {
  const fn = read('supabase/functions/site-beacon/index.ts');
  assert.match(fn, /return 'no provider set'/);
  // and a provider having a bad day never breaks a beacon
  assert.match(fn, /catch \(e\) \{\s*return 'send failed/);
});

test('the migration keeps the owner out and sweeps old rows', () => {
  const sql = read('supabase/migrations/20261128_site_presence.sql');
  assert.match(sql, /where is_owner = false/, 'the owner is not a visitor');
  assert.match(sql, /last_seen_at > now\(\) - interval '2 minutes'/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /using \(public\.is_admin\(\)\)/, 'only the owner reads it');
  assert.match(sql, /interval '14 days'/, 'rows do not pile up for ever');
});
