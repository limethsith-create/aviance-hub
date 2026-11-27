/* Round 3, agent 1: what a customer tripped on when the pages were driven in a
   real browser. Each test is one of those trips, pinned.
   Run with: node --test tests/round3-customer.test.mjs */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
const nodes = {};
const mk = (id) => ({ id, innerHTML: '', get firstChild(){ return this.innerHTML ? {} : null }, querySelector(){ return null } });
const boxes = { pcTracker: mk('pcTracker'), pcStanding: mk('pcStanding'), pcCampaign: mk('pcCampaign'), pcCalls: mk('pcCalls') };
globalThis.document = {
  head: { appendChild(n){ nodes[n.id] = n } }, activeElement: null,
  getElementById(id){ return boxes[id] || nodes[id] || null },
  createElement(){ return {} }, querySelectorAll(){ return [] }, querySelector(){ return null }, addEventListener(){},
};
for (const f of ['core.js', 'portal-client.js', 'portal-tracker.js', 'portal-steps.js'])
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return coreDayKey(d); };
const liveJourney = () => ({ client_id: 'c1', launch_on: day(-18), days_to_launch: -18, next_step: null,
  steps: [1, 2, 3, 4, 5, 6].map((i) => ({ step: i === 6 ? 'launch' : 's' + i, title: 'Step ' + i, position: i, planned_on: day(-30 + i * 2), status: 'done' })) });
const MISSING = { message: 'Could not find the function public.portal_month without parameters in the schema cache', code: 'PGRST202' };

beforeEach(() => {
  Object.assign(pct, { open: false, drawn: '', at: 0, data: null, busy: false, who: '|', tab: 'chat', gone: {}, standing: '', campaignDrawn: '', callsDrawn: '',
    month: null, monthAt: 0, monthBusy: false, monthFailed: false, monthBlind: false, callsBlind: false,
    campaign: null, campaignAt: 0, campaignBusy: false, campaignFailed: false, calls: null, callsAt: 0, callsBusy: false, callsFailed: false, readMs: 0 });
  PC.tab = 'chat';
  Object.keys(boxes).forEach((k) => { boxes[k].innerHTML = '' });
});

/* the portal's real ctx.rpc is pcRpc, which words every error for a client */
function liveCtx(tables, calls){
  const sb = {
    rpc(name){ (calls || []).push(name);
      if (name === 'portal_journey') return Promise.resolve({ data: liveJourney(), error: null });
      return Promise.resolve({ data: null, error: Object.assign({}, MISSING, { message: MISSING.message.replace('portal_month', name) }) }); },
    from(t){ (calls || []).push('from:' + t); const q = { select(){ return q }, eq(){ return q }, order(){ return q }, limit(){ return Promise.resolve({ data: (tables || {})[t] || [], error: null }) } }; return q; },
  };
  pcUseClient('portal', sb);
  return { home: { person: { id: 'p1' }, channel: { id: 'ch1' } }, sb, rpc: (n, a) => pcRpc('portal', n, a) };
}

test('a function the database does not have yet is carried as a fact, never as words a client could read', () => {
  const r = pcErr(MISSING);
  assert.equal(r.missing, true);
  assert.equal(r.error, PC_WAIT);
  assert.doesNotMatch(r.error, /schema cache|function/);
  assert.equal(pcErr({ message: 'function public.portal_calls() does not exist', code: '42883' }).missing, true);
  assert.equal(pcErr({ message: 'permission denied for table refunds', code: '42501' }).missing, false);
  assert.equal(pcErr(new TypeError('Failed to fetch')).missing, false);
});

test('LIVE TODAY: with no portal_month in the database the page reads the tables instead of saying "could not load"', async () => {
  const calls = [];
  const ctx = liveCtx({ client_months: [{ client_id: 'c1', month_no: 1, starts_on: day(-18), ends_on: day(11), calls_promised: 10, calls_delivered: 6 }] }, calls);
  await pctMount(ctx);
  assert.equal(pct.gone.portal_month, true, 'the missing function is remembered');
  assert.equal(pct.monthFailed, false);
  assert.ok(calls.includes('from:client_months'), 'the fallback ran');
  assert.match(text(boxes.pcStanding.innerHTML), /6 of 10/);
  await pctMount(Object.assign(ctx, {})); pct.monthAt = 0; await pctMount(ctx);
  assert.equal(calls.filter((c) => c === 'portal_month').length, 1, 'and it is asked for once, not on every refresh');
});

test('LIVE TODAY: launched, and the tables hand a client no rows — the guarantee line says Live, never "Not started" and never a number', async () => {
  const ctx = liveCtx({});
  await pctMount(ctx);
  const t = text(boxes.pcStanding.innerHTML);
  assert.equal(pct.monthBlind, true);
  assert.match(t, /Live/); assert.match(t, /cannot show your running call count yet/);
  assert.doesNotMatch(t, /Not started|could not load|days to launch|\bof\b \d/);
});

test('LIVE TODAY: the Calls tab does not tell a launched client their first call has not been booked', async () => {
  const ctx = liveCtx({});
  PC.tab = 'calls';
  await pctMount(ctx);
  const t = text(boxes.pcCalls.innerHTML);
  assert.equal(pct.callsBlind, true);
  assert.match(t, /not listed on this page yet/);
  assert.doesNotMatch(t, /has not been booked|could not load/);
});

test('before launch the same empty answer is still the honest pre-launch panel', () => {
  const j = { client_id: 'c1', launch_on: day(9), days_to_launch: 9, steps: [{ step: 'launch', title: 'Launch', position: 1, planned_on: day(9), status: 'todo' }] };
  const t = text(pctStandingHtml(pctMonthNorm(null, j), { blind: true }));
  assert.match(t, /Not started/); assert.match(t, /9 days to launch/);
  assert.match(text(pctCallsEmptyHtml(pctMonthNorm(null, j), { blind: true })), /first call has not been booked/);
});

test('the page opening twice at once does not put "could not load" on the guarantee line', async () => {
  let letGo; const held = new Promise((r) => { letGo = r });
  const ctx = liveCtx({});
  const rpc = ctx.rpc;
  ctx.rpc = (n, a) => n === 'portal_journey' ? held.then(() => rpc(n, a)) : rpc(n, a);
  const first = pctMount(ctx);          /* waiting on portal_journey */
  await new Promise((r) => setTimeout(r, 5));
  await pctMount(ctx);                  /* the second call, with no client id yet */
  assert.equal(pct.monthFailed, false, 'the second call did not fail the month for want of a client id');
  assert.equal(pct.monthAt, 0, 'it did not ask at all');
  letGo(); await first;
  assert.equal(pct.monthFailed, false);
  assert.doesNotMatch(text(boxes.pcStanding.innerHTML), /could not load/);
});

test('signing out and back in as the same person draws the guarantee line and the tabs again', async () => {
  const ctx = liveCtx({ client_months: [{ client_id: 'c1', month_no: 1, starts_on: day(-18), ends_on: day(11), calls_promised: 10, calls_delivered: 6 }] });
  await pctMount(ctx);
  assert.match(text(boxes.pcStanding.innerHTML), /6 of 10/);
  Object.keys(boxes).forEach((k) => { boxes[k].innerHTML = '' });   /* the page was rebuilt */
  await pctMount(ctx);
  assert.match(text(boxes.pcStanding.innerHTML), /6 of 10/, 'not left blank because "nothing changed"');
});

test('a later month that has been opened but not begun is not called a launch', () => {
  const m = pctMonthNorm({ client_id: 'c1', month_no: 2, starts_on: day(1), ends_on: day(30), calls_promised: 10, calls_delivered: 0 }, liveJourney());
  const t = text(pctStandingHtml(m));
  assert.match(t, /Month 2 · starts/); assert.match(t, /1 day until it starts/);
  assert.match(t, /refund that month in full/);
  assert.doesNotMatch(t, /launch|twice/i);
});

test('a month that is over says Ended and its date, not "0 days left"', () => {
  const m = pctMonthNorm({ client_id: 'c1', month_no: 1, starts_on: day(-30), ends_on: day(-1), calls_promised: 10, calls_delivered: 6 }, null);
  const t = text(pctStandingHtml(m));
  assert.equal(m.over, true); assert.match(t, /Ended/); assert.match(t, /Refund due/); assert.doesNotMatch(t, /days left/);
  const last = pctMonthNorm({ client_id: 'c1', month_no: 1, starts_on: day(-29), ends_on: day(0), calls_promised: 10, calls_delivered: 6 }, null);
  assert.equal(last.over, false); assert.match(text(pctStandingHtml(last)), /0 days left/);
});

test('a write that never answers gives the button back and says it does not know, not that it failed', async () => {
  let n = 0;
  const r = await pcWrite(() => { n++; return new Promise(() => {}) }, 20);
  assert.equal(r.ok, false); assert.equal(r.noAnswer, true); assert.equal(n, 1, 'never sent twice');
  assert.match(r.error, /did not hear back/);
  assert.deepEqual(await pcWrite(() => pcOk(7), 20), pcOk(7));
  assert.equal((await pcWrite(() => { throw new Error('Failed to fetch') }, 20)).offline, true);
  /* every write a client can press goes through it */
  assert.match(read('portal.html'), /pcWrite\(function\(\)\{ return pcSend\(/);
  assert.match(read('doc.html'), /pcWrite\(function\(\)\{ return pcDocSign\(/);
  assert.match(read('portal-steps.js'), /typeof pcWrite === 'function' \? pcWrite\(work\)/);
});

test('an approval that never answers leaves the card usable, with what was typed', async () => {
  pcWriteOpts.ms = 20;
  try {
    const key = 'a:ap1', u = pstUi(key); u.name = 'Dana W'; u.note = 'drop small sites'; u.open = true;
    let refreshed = 0;
    const ctx = { home: { person: { id: 'p1', name: 'Dana W' }, channel: { id: 'ch1' } }, rpc: () => new Promise(() => {}), refresh(){ refreshed++ } };
    await PC.actions.pstSendChanges({ getAttribute: () => 'ap1' }, ctx);
    assert.equal(u.busy, false); assert.match(u.error, /did not hear back/);
    assert.equal(u.note, 'drop small sites'); assert.equal(refreshed, 1, 'and the truth is read again');
  } finally { pcWriteOpts.ms = 0; }
});

test('a redraw gives the keyboard back to the field it took it from', () => {
  const old = { id: 'pst-f-1', selectionStart: 5, selectionEnd: 5, scrollTop: 0 };
  let focused = null, sel = null;
  const fresh = { id: 'pst-f-1', focus(){ focused = this; document.activeElement = this }, setSelectionRange(a, b){ sel = [a, b] } };
  document.activeElement = old;
  const real = document.getElementById;
  document.getElementById = (id) => id === 'pst-f-1' ? fresh : real(id);
  try { pcKeepFocus({ contains: (n) => n === old }, () => { document.activeElement = null }); }
  finally { document.getElementById = real; document.activeElement = null; }
  assert.equal(focused, fresh); assert.deepEqual(sel, [5, 5]);
  assert.doesNotThrow(() => pcKeepFocus(null, () => {}));
  assert.match(read('portal.html'), /pcKeepFocus\(thread, function\(\)\{ thread\.innerHTML = html; \}\)/);
});

test('the first read of a document, of the channel, and a sign-in all have a limit', () => {
  assert.match(read('doc.html'), /pcRead\(function\(\)\{ return pcDocGet\(token\); \}\)/);
  assert.match(read('portal.html'), /await pcRead\(pcHome\)/);
  assert.match(read('portal.html'), /pcRead\(function\(\)\{ return pcSignIn\(email, pw\); \}, 20000\)/);
});
