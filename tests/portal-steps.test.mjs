/* portal-steps.js: the approval, pre-call form and testing-update cards in the client portal.
   Proves the cards escape everything, show the decided state, check input before asking the
   database, call the right rpc with the right arguments, and never throw. Plus a few checks on
   the SQL contract in supabase/migrations/20261124_steps.sql. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(import.meta.dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-client.js'), 'utf8'), { filename: 'portal-client.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-steps.js'), 'utf8'), { filename: 'portal-steps.js' });
const P = (n) => vm.runInThisContext(n);
const SQL = fs.readFileSync(path.join(root, 'supabase/migrations/20261124_steps.sql'), 'utf8');

/* a fake ctx: records rpc calls, answers with whatever `answer` says */
function fakeCtx(answer) {
  const calls = [];
  return {
    calls,
    home: { person: { id: 'p1', name: 'Sam Lee' } },
    async rpc(name, args) {
      calls.push({ name, args });
      const a = typeof answer === 'function' ? answer(name, args) : answer;
      if (a instanceof Error) throw a;
      return a;
    },
    refresh() { calls.push({ name: 'refresh' }); },
  };
}
const EVIL = '<img src=x onerror=alert(1)>"\'&';
const clean = (html) => !/<img|onerror=alert\(1\)>|"'&/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/g, ''));

test('the three cards are registered on PC', () => {
  const PC = P('PC');
  assert.equal(typeof PC.cards.approval, 'function');
  assert.equal(typeof PC.cards.form, 'function');
  assert.equal(typeof PC.cards.update, 'function');
  for (const a of ['pstApprove', 'pstAskChanges', 'pstSendChanges', 'pstCancel', 'pstPrecall']) assert.equal(typeof PC.actions[a], 'function', a);
  assert.ok(PC.mounts.length >= 1);
});

test('an approval card escapes the title, body and name and shows both buttons while pending', () => {
  const html = P('pstApprovalHtml')({ id: 'm1', meta: { approval_id: 'a1', kind: 'icp', title: EVIL, body: EVIL + '\nline 2' } }, undefined, {}, { person: { name: EVIL } });
  assert.ok(clean(html), html);
  assert.match(html, /For your approval · Target profile/);   // was "ICP": changed on purpose, a client does not use that word
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), /\bICP\b/);
  assert.match(html, /data-pc-act="pstApprove" data-pst-id="a1"/);
  assert.match(html, /data-pc-act="pstAskChanges"/);
  assert.match(html, /line 2/);
  assert.match(html, /<label class="pc-label" for="pst-a1-name">Your name<\/label>/);
  assert.doesNotMatch(html, /pstSendChanges/);
});

test('asking for changes opens a note box with Send changes', () => {
  const html = P('pstApprovalHtml')({ meta: { approval_id: 'a1', title: 'T' } }, undefined, { open: true, note: EVIL }, null);
  assert.ok(clean(html));
  assert.match(html, /data-pst-in="note"/);
  assert.match(html, /pstSendChanges/);
  assert.match(html, /pstCancel/);
  assert.doesNotMatch(html, /pstApprove"/);
});

test('a decided approval shows who decided and no buttons', () => {
  const f = P('pstApprovalHtml');
  const ok = f({ meta: { approval_id: 'a1', title: 'T' } }, { id: 'a1', status: 'approved', decided_name: EVIL, decided_at: '2026-11-24T16:02:00Z' }, {}, null);
  assert.ok(clean(ok));
  assert.match(ok, /Approved by /);
  assert.match(ok, /Nov 24, /);
  assert.doesNotMatch(ok, /data-pc-act/);
  const ch = f({ meta: { approval_id: 'a1', title: 'T' } }, { id: 'a1', status: 'changes', decided_name: 'Sam', client_note: EVIL }, {}, null);
  assert.ok(clean(ch));
  assert.match(ch, /Changes asked by Sam/);
  assert.doesNotMatch(ch, /data-pc-act/);
});

test('an approval message with no approval id draws nothing', () => {
  assert.equal(P('pstApprovalHtml')({ meta: null }, undefined, {}, null), '');
  assert.equal(P('PC').cards.approval({ meta: {} }), '');
});

test('the pre-call form has 4 labelled questions, keeps typed answers, and reads done once submitted', () => {
  const f = P('pstFormHtml');
  const open = f({ id: 'm9' }, {}, { values: { offer: EVIL } });
  assert.ok(clean(open));
  assert.equal((open.match(/<textarea/g) || []).length, 4);
  assert.equal((open.match(/<label class="pc-label" for="pst-f-m9-\d">/g) || []).length, 4);
  assert.match(open, /data-pc-act="pstPrecall"/);
  const done = f({ id: 'm9' }, { submitted_at: '2026-11-24T10:00:00Z', offer: EVIL, best_customers: 'b', deal_size: '5k', avoid: 'none' }, {});
  assert.ok(clean(done));
  assert.match(done, /Done ✓/);
  assert.doesNotMatch(done, /<textarea|data-pc-act/);
});

test('the update card is a small stat row with the reply rate', () => {
  const html = P('pstUpdateHtml')({ meta: { sent: 180, replies: 7, leading: EVIL, day: 3 } });
  assert.ok(clean(html));
  assert.match(html, /Testing · day 3/);
  assert.match(html, /<strong>180<\/strong>/);
  assert.match(html, /<strong>7<\/strong>/);
  assert.match(html, /3\.9%/);
  assert.equal(P('pstUpdateHtml')({ meta: {} }), '');
  assert.doesNotMatch(P('pstUpdateHtml')({ meta: { sent: 0, replies: 0 } }), /Reply rate/);
});

test('names, notes and answers are checked before the database is asked', async () => {
  const ctx = fakeCtx({ ok: true, data: { status: 'approved' }, error: '' });
  let r = await P('pstDecide')(ctx, 'a1', ' ', 'approve');
  assert.equal(r.ok, false); assert.match(r.error, /name/);
  r = await P('pstDecide')(ctx, 'a1', 'Sam Lee', 'changes', '   ');
  assert.equal(r.ok, false); assert.match(r.error, /what to change/);
  r = await P('pstDecide')(ctx, 'a1', 'Sam Lee', 'maybe');
  assert.equal(r.ok, false);
  r = await P('pstSubmitForm')(ctx, { offer: 'x', best_customers: 'y', deal_size: '', avoid: 'z' });
  assert.equal(r.ok, false); assert.match(r.error, /all four/);
  assert.equal(ctx.calls.length, 0);
});

test('approve and ask-for-changes send the right arguments', async () => {
  const ctx = fakeCtx({ ok: true, data: { id: 'a1', status: 'approved' }, error: '' });
  const r = await P('pstDecide')(ctx, 'a1', '  Sam   Lee ', 'approve', 'ignored');
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.calls[0], { name: 'portal_approve', args: { p_approval: 'a1', p_name: 'Sam Lee', p_decision: 'approve', p_note: null } });
  const ctx2 = fakeCtx({ ok: true, data: { id: 'a1', status: 'changes' }, error: '' });
  await P('pstDecide')(ctx2, 'a1', 'Sam', 'changes', '  less fintech ');
  assert.deepEqual(ctx2.calls[0].args, { p_approval: 'a1', p_name: 'Sam', p_decision: 'changes', p_note: 'less fintech' });
});

test('the form sends its four answers trimmed', async () => {
  const ctx = fakeCtx({ ok: true, data: { submitted_at: '2026-11-24T10:00:00Z' }, error: '' });
  const r = await P('pstSubmitForm')(ctx, { offer: ' a ', best_customers: 'b', deal_size: 'c', avoid: 'd' });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.calls[0], { name: 'portal_precall_submit', args: { p_offer: 'a', p_best: 'b', p_deal: 'c', p_avoid: 'd' } });
});

test('database refusals and thrown errors come back as plain words, never a throw', async () => {
  let r = await P('pstDecide')(fakeCtx({ ok: false, data: null, error: 'This one has already been answered.' }), 'a1', 'Sam', 'approve');
  assert.deepEqual([r.ok, r.error], [false, 'This one has already been answered.']);
  r = await P('pstDecide')(fakeCtx(new Error('boom')), 'a1', 'Sam', 'approve');
  assert.deepEqual([r.ok, r.error], [false, 'boom']);
  r = await P('pstDecide')(fakeCtx({ ok: true, data: null, error: '' }), 'a1', 'Sam', 'approve');
  assert.equal(r.ok, false);
  r = await P('pstLoad')(null);
  assert.equal(r.ok, false);
  r = await P('pstLoad')(fakeCtx((n) => (n === 'portal_approvals' ? { ok: true, data: [{ id: 'a1' }] } : { ok: true, data: { submitted_at: null } })));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.approvals, [{ id: 'a1' }]);
  r = await P('pstLoad')(fakeCtx({ ok: true, data: null }), { approvals: true });
  assert.deepEqual(r.data.approvals, []);
});

test('the SQL keeps the contract: client RPCs derive the client from the login, admin RPCs check is_admin', () => {
  for (const fn of ['step_message', 'approval_request', 'portal_approve', 'approval_reminders', 'precall_request', 'portal_precall_get', 'portal_precall_submit', 'testing_day', 'portal_approvals']) {
    assert.match(SQL, new RegExp('create or replace function public\\.' + fn + '\\('), fn);
  }
  for (const fn of ['portal_approve', 'portal_approvals', 'portal_precall_get', 'portal_precall_submit']) {
    const body = SQL.split('function public.' + fn + '(')[1].split('end $$;')[0];
    assert.match(body, /steps_me\(\)/, fn + ' derives the client from auth.uid()');
  }
  assert.match(SQL.split('function public.steps_me(')[1].split('end $$;')[0], /portal_home\(\) is null/);
  for (const fn of ['approval_request', 'testing_day']) assert.match(SQL.split('function public.' + fn + '(')[1].split('end $$;')[0], /is_admin\(\)/, fn);
  assert.match(SQL.split('function public.step_message(')[1].split('end $$;')[0], /current_user in \('authenticated', 'anon'\) and not public\.is_admin\(\)/);
  assert.match(SQL, /revoke all on function public\.precall_request\(uuid\) from public, anon, authenticated/);
  assert.doesNotMatch(SQL, /insert into public\.channel_messages[^;]*'(bot|chat)'/, 'only system facts are posted directly');
});

test('every line a client reads is warm, plain and professional — no text-speak, no "ICP"', () => {
  const said = (SQL.match(/body := '([^']|'')+'|then '([^']|'')+'|'Just checking in[^']*'|'One quick thing[^']*'/g) || [])
    /* a real sentence, not a SQL enum like then 'approved' */
    .filter((m) => { const t = m.replace(/^[^']*'/, '').replace(/'$/, ''); return t.length > 20 && /\s/.test(t); });
  assert.ok(said.length >= 6, 'found the lines');
  for (const s of said) {
    const text = s.replace(/^[^']*'/, '').replace(/'$/, '');
    /* a fragment that starts with a space continues an earlier sentence, so it is not capitalised */
    if (!/^\s/.test(text)) assert.match(text, /^[A-Z]/, 'starts with a capital letter: ' + s);
    assert.doesNotMatch(text, /\b(ur|thx|thnx|tmrw|tmw|pls|plz|ty)\b/i, 'no text-speak: ' + s);
    assert.doesNotMatch(text, /\bu\b(?!\.)/i, 'writes "you" in full: ' + s);
    assert.doesNotMatch(text, /\bw\//i, 'writes "with" in full: ' + s);
    assert.doesNotMatch(text, /\bICP\b/i, 'says "target profile" to a client: ' + s);
    assert.ok((text.match(/\p{Extended_Pictographic}/gu) || []).length <= 1, 'at most one emoji: ' + s);
  }
  // and the whole file holds no text-speak outside the patterns that READ what a client typed
  const ours = SQL.split('\n').filter((l) => !/tail text|regexp_replace\(t,|^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(ours, /\b(ur|thx|tmrw)\b/i);
});

/* ───────────── perfection pass ───────────── */

/* a document with just enough to run the mount: which cards are on screen, and nothing to redraw */
function withCards(sel, fn) {
  const had = globalThis.document;
  globalThis.document = { querySelector: (q) => (sel.some((x) => q.includes(x)) ? {} : null), querySelectorAll: () => [] };
  return Promise.resolve().then(fn).finally(() => { globalThis.document = had; });
}
const theMount = () => P('PC').mounts[P('PC').mounts.length - 1];
const homeOf = (id) => ({ person: { id, name: 'Person ' + id }, channel: { id: 'ch-' + id } });

test('a second person signing in on the same browser never sees the first person\'s answers', async () => {
  const st = P('pstState');
  const ctxA = Object.assign(fakeCtx((name) => name === 'portal_precall_get'
    ? { ok: true, data: { offer: 'SECRET of client A', best_customers: 'a', deal_size: 'a', avoid: 'a' }, error: '' }
    : { ok: true, data: [{ id: 'a1', status: 'approved', decided_name: 'Client A' }], error: '' }), { home: homeOf('pA') });
  P('PC').cards.form({ id: 'm1', meta: { form: 'precall' } });
  await withCards(['a:', 'f:'], () => theMount()(ctxA));
  P('pstUi')('f').values = { offer: 'half typed by A' };
  assert.equal(st.form.offer, 'SECRET of client A');
  assert.match(P('PC').cards.form({ id: 'm1', meta: {} }), /half typed by A/);

  /* A signs out, B signs in: the page calls the mounts with B's home */
  const ctxB = Object.assign(fakeCtx(() => ({ ok: false, data: null, error: 'offline' })), { home: homeOf('pB') });
  await withCards(['f:'], () => theMount()(ctxB));
  const card = P('PC').cards.form({ id: 'm1', meta: {} });
  assert.doesNotMatch(card, /SECRET of client A|half typed by A/);
  assert.deepEqual(st.approvals, {});
  assert.equal(st.home.person.id, 'pB');
});

test('the cards\' state is not asked for again on every refresh, and both lookups go out together', async () => {
  P('pstReset')(); P('pstState').who = '';
  let open = 0, most = 0;
  const ctx = Object.assign(fakeCtx(() => new Promise((r) => { open++; most = Math.max(most, open); setTimeout(() => { open--; r({ ok: true, data: [], error: '' }); }, 10); })), { home: homeOf('pC') });
  await withCards(['a:', 'f:'], () => theMount()(ctx));     // first time: nothing known yet
  P('PC').cards.approval({ id: 'm1', meta: { approval_id: 'a1' } });
  await withCards(['a:', 'f:'], () => theMount()(ctx));     // a card arrived: ask
  const asked = ctx.calls.length;
  assert.equal(most, 2, 'approvals and the form are asked for at the same time');
  await withCards(['a:', 'f:'], () => theMount()(ctx));     // the 20-second refresh: same cards, nothing to ask
  await withCards(['a:', 'f:'], () => theMount()(ctx));
  assert.equal(ctx.calls.length, asked);
  P('PC').cards.approval({ id: 'm2', meta: { approval_id: 'a2' } });
  await withCards(['a:', 'f:'], () => theMount()(ctx));     // a new card: ask again
  assert.ok(ctx.calls.length > asked);
});

test('an answer she has cleared stays cleared when the card is drawn again', () => {
  const h = P('pstFormHtml')({ id: 'm9' }, { offer: 'what the database had' }, { values: { offer: '' } });
  assert.doesNotMatch(h, /what the database had/);
  assert.match(P('pstFormHtml')({ id: 'm9' }, { offer: 'what the database had' }, {}), /what the database had/);
});

test('a card never claims a state it has not been told: not loaded, and failed', () => {
  const ap = P('pstApprovalHtml'), fm = P('pstFormHtml');
  const m = { id: 'm1', meta: { approval_id: 'a1', kind: 'icp', title: 'Your target profile', body: 'US dental groups' } };

  /* still being read: no Approve button, because she may have approved it days ago */
  const reading = ap(m, undefined, {}, null, { loaded: false, failed: '' });
  assert.ok(clean(reading));
  assert.doesNotMatch(reading, /data-pc-act="pstApprove"|data-pc-act="pstAskChanges"/);
  assert.match(reading, /Checking where this is up to/);

  /* the ask failed: the sentence, and a way out other than reloading */
  const broke = ap(m, undefined, {}, null, { loaded: false, failed: 'We could not reach Aviance. Check your connection and try again.' });
  assert.ok(clean(broke));
  assert.doesNotMatch(broke, /data-pc-act="pstApprove"/);
  assert.match(broke, /could not reach Aviance/);
  assert.match(broke, /data-pc-act="pstRetry"/);

  /* told, and pending: exactly as before */
  const live = ap(m, { id: 'a1', status: 'pending' }, {}, null, { loaded: true, failed: '' });
  assert.match(live, /data-pc-act="pstApprove"/);
  /* told it is decided while the rest is still loading: the stamp wins over the wait */
  const done = ap(m, { id: 'a1', status: 'approved', decided_name: 'Dana' }, {}, null, { loaded: false, failed: 'x' });
  assert.match(done, /Approved by Dana/);
  assert.doesNotMatch(done, /pstRetry/);
  /* no load argument at all: today's behaviour, so nothing that already calls this moves */
  assert.match(ap(m, undefined, {}, null), /data-pc-act="pstApprove"/);

  /* the form: four empty boxes before the answers arrive could wipe what she wrote,
     because portal_precall_submit overwrites */
  const fReading = fm({ id: 'm9' }, null, {}, { loaded: false, failed: '' });
  assert.ok(clean(fReading));
  assert.doesNotMatch(fReading, /<textarea|data-pc-act="pstPrecall"/);
  assert.match(fReading, /Checking your answers/);
  const fBroke = fm({ id: 'm9' }, null, {}, { loaded: false, failed: 'Something went wrong at our end.' });
  assert.doesNotMatch(fBroke, /<textarea/);
  assert.match(fBroke, /data-pc-act="pstRetry"/);
  /* answered, or asked and genuinely empty, or no load argument: as before */
  assert.match(fm({ id: 'm9' }, {}, {}, { loaded: true }), /data-pc-act="pstPrecall"/);
  assert.match(fm({ id: 'm9' }, null, {}), /data-pc-act="pstPrecall"/);
  assert.match(fm({ id: 'm9' }, { submitted_at: '2026-11-24T10:00:00Z' }, {}, { loaded: false, failed: 'x' }), /Done ✓/);
});

test('a load that failed is written down, cleared on the next good answer, and retryable', async () => {
  const mount = theMount();
  pstState.who = ''; pstState.loaded = false; pstState.failed = ''; pstState.at = 0; pstState.seen = '';
  pstState.approvals = {}; pstState.form = null; pstState.items = {};
  const home = { person: { id: 'p1', name: 'Dana' }, channel: { id: 'ch1' } };

  let bad = true;
  const ctx = { home, rpc: async (n) => (bad
    ? { ok: false, error: 'We could not reach Aviance. Check your connection and try again.' }
    : { ok: true, data: n === 'portal_approvals' ? [{ id: 'a1', status: 'approved' }] : { submitted_at: '2026-11-24T10:00:00Z' } }) };

  await withCards(['a:', 'f:'], () => mount(ctx));
  assert.match(pstState.failed, /could not reach Aviance/);
  assert.equal(pstState.loaded, false);

  bad = false;
  pstState.at = 0;
  await withCards(['a:', 'f:'], () => mount(ctx));
  assert.equal(pstState.failed, '');
  assert.equal(pstState.loaded, true);
  assert.equal(pstState.approvals.a1.status, 'approved');

  assert.equal(typeof P('PC').actions.pstRetry, 'function');
  bad = true; pstState.at = Date.now();
  await withCards(['a:', 'f:'], () => P('PC').actions.pstRetry(null, ctx));
  assert.match(pstState.failed, /could not reach Aviance/);   /* the back-off was forgotten and it asked again */
});
