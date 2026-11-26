/* join.html — the first screen a paying client ever sees. Its inline script is
   run here in a tiny fake DOM with portal-client.js's data calls stubbed, the
   same way tests/login-gate.test.mjs runs index.html's shell. No network.

   What is checked is the three ways this page can fail a client:
     - a dead, used, expired or seat-full link each get their own words
     - nothing from the database is ever shown raw
     - and, the one this file was written for, an ask that NEVER ANSWERS no
       longer leaves the page saying "Loading" for ever. Both asks are capped,
       and past the cap there is a screen with a way to try again.
   Run with:  node --test tests/join-page.test.mjs   (or npm test) */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'join.html'), 'utf8');
/* the page's own script: the last inline block, which is the whole of its logic */
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
assert.ok(script.includes('pcInvitePeek'), 'the inline script was found');

globalThis.window = globalThis;
const TOKEN = 'a'.repeat(48);
const el = () => ({
  innerHTML: '', _h: { focus() {} },
  querySelector(s) { return /h1/.test(s) ? this._h : null },
  querySelectorAll() { return [] },
  addEventListener() {},
});
let pcRoot = el();
globalThis.document = { getElementById: (id) => (id === 'pcRoot' ? pcRoot : null) };
globalThis.location = { hash: '#' + TOKEN, replace() {} };

vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-client.js'), 'utf8'), { filename: 'portal-client.js' });

const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/* Run the page once with pcInvitePeek answering however this case wants, and
   give back what the client is looking at. `settle` false = never answers. */
async function openPage(peek) {
  pcRoot = el();
  globalThis.pcInvitePeek = peek;
  vm.runInThisContext(script, { filename: 'join.html (inline script)' });
  await new Promise((r) => setTimeout(r, 30));
  return pcRoot.innerHTML;
}
const ok = (data) => async () => ({ ok: true, data, error: '' });

test('a good link draws the password form, with their email and company', async () => {
  const h = await openPage(ok({ ok: true, email: 'dana@stone.test', company: 'Stone Roofing', name: 'Dana Stone' }));
  assert.match(text(h), /Welcome, Dana/);
  assert.match(text(h), /Set a password to open Stone Roofing's channel/);
  assert.match(h, /id="pcJoinForm"/);
});

test('a full house is explained before a password is typed, and the link is not called dead', async () => {
  const said = 'Stone Roofing already has all 4 of its Aviance logins in use, so this link cannot open another one.';
  const h = await openPage(ok({ ok: false, reason: 'seats_full', message: said }));
  assert.match(text(h), /Your logins are all in use/);
  assert.match(text(h), /already has all 4 of its Aviance logins in use/);
  assert.match(text(h), /Your link still works/);
  assert.doesNotMatch(text(h), /expired|not valid/i);
  assert.doesNotMatch(h, /id="pcJoinForm"/, 'no password box: there is nowhere to put them');
});

test('used, expired and dead links each say what to do next', async () => {
  const used = await openPage(ok({ ok: false, reason: 'used' }));
  assert.match(text(used), /already set up/i);
  assert.match(used, /href="\/portal\.html"/);
  assert.match(text(await openPage(ok({ ok: false, reason: 'expired' }))), /This link has expired/);
  assert.match(text(await openPage(ok({ ok: false, reason: 'nonsense' }))), /This link has closed/);
});

test('an ask that never answers does not leave the page loading for ever', async () => {
  /* the limit is twelve seconds in the page; shortened here by holding the
     promise open and waiting out the page's own timer with a fake clock */
  const real = globalThis.setTimeout;
  let fired = null;
  globalThis.setTimeout = (fn, ms) => { if (ms >= 1000) { fired = fn; return 0; } return real(fn, ms) };
  try {
    const h = await openPage(() => new Promise(() => {}));   /* never settles */
    assert.match(text(h), /Loading/, 'it says Loading while it waits');
    assert.ok(typeof fired === 'function', 'a limit was set on the ask');
    fired();                                                  /* the limit runs out */
    await new Promise((r) => real(r, 10));
    const after = pcRoot.innerHTML;
    assert.doesNotMatch(text(after), /^Loading$/);
    assert.match(text(after), /could not load this page/i);
    assert.match(after, /data-pc-retry/, 'and a way to try again');
  } finally { globalThis.setTimeout = real }
});

test('a failure to reach the database is "we could not load this", never the database\'s words', async () => {
  const h = await openPage(async () => ({ ok: false, data: null, error: 'relation "portal_invites" does not exist' }));
  assert.doesNotMatch(h, /portal_invites|relation/);
  assert.match(text(h), /could not load this page/i);
});

/* The page's own text, read as text: the token must not reach a server log and
   the client must always be told how to get help. */
test('the token rides in the fragment and help is always one line away', () => {
  assert.match(html, /pcTokenFromHash\(location\.hash\)/);
  assert.ok(!/join\.html\?/.test(html), 'never a query string');
  assert.match(html, /Reply to any of our emails/);
});
