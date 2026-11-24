/* portal-schedule.js: the offered-times card, the Join-the-call card and the
   pick click. Loaded on top of portal-client.js, as portal.html does. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(import.meta.dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-client.js'), 'utf8'), { filename: 'portal-client.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-schedule.js'), 'utf8'), { filename: 'portal-schedule.js' });
const P = (n) => vm.runInThisContext(n);

const OFFER = '0919b174-c9b7-44e4-b803-c95953b9cd0b';
const NOW = '2026-11-24T12:00:00Z';
const opts = [
  { starts_at: '2026-11-26T17:00:00Z', minutes: 45 },
  { starts_at: '2026-11-27T18:30:00Z', minutes: 45 },
  { starts_at: '2026-11-30T17:00:00Z', minutes: 45 },
];
const item = (meta) => ({ msgKind: 'offer', meta: Object.assign({ offer_id: OFFER, kind: 'kickoff', options: opts }, meta || {}) });
const clearUi = () => { const u = P('psUi'); Object.keys(u).forEach((k) => delete u[k]); };

test('hooks into PC: offer + system cards and the pick action', () => {
  const PC = P('PC');
  assert.equal(typeof PC.cards.offer, 'function');
  assert.equal(typeof PC.cards.system, 'function');
  assert.equal(typeof PC.actions.pick, 'function');
});

test('three options in the viewer’s time with ET beside them', () => {
  const o = P('psOptions')(item().meta, 'America/Los_Angeles', NOW);
  assert.equal(o.length, 3);
  assert.deepEqual(o.map((x) => x.i), [1, 2, 3]);
  assert.equal(o[0].main, 'Thu, Nov 26 · 9:00 AM');
  assert.equal(o[0].et, '12:00 PM ET');
  assert.equal(o[1].et, '1:30 PM ET');
  /* in ET already: one line, zone named, no echo */
  const e = P('psOptions')(item().meta, 'America/New_York', NOW);
  assert.equal(e[0].main, 'Thu, Nov 26 · 12:00 PM ET');
  assert.equal(e[0].et, '');
  /* a different calendar day in ET says so */
  const c = P('psOptions')(item().meta, 'Asia/Colombo', NOW);
  assert.equal(c[0].main, 'Thu, Nov 26 · 10:30 PM');
  assert.equal(c[0].et, '12:00 PM ET');
  const t = P('psOptions')({ options: [{ starts_at: '2026-11-26T03:00:00Z', minutes: 30 }] }, 'Asia/Colombo', NOW);
  assert.equal(t[0].et, 'Wed, Nov 25 · 10:00 PM ET');
});

test('open card: three enabled pick buttons with offer id and 1-based index', () => {
  clearUi();
  const h = P('psOfferHtml')(item(), 'America/Los_Angeles', NOW);
  assert.equal((h.match(/data-pc-act="pick"/g) || []).length, 3);
  assert.match(h, new RegExp(`data-offer="${OFFER}" data-i="1"`));
  assert.match(h, /data-i="3"/);
  assert.doesNotMatch(h, /disabled/);
  assert.match(h, /Pick a time/);
  assert.match(h, /kickoff · 45 min/);
});

test('booked card: every button disabled, the picked one marked', () => {
  clearUi();
  const h = P('psOfferHtml')(item({ status: 'booked', picked: 2 }), 'America/Los_Angeles', NOW);
  assert.equal((h.match(/ disabled/g) || []).length, 3);
  assert.match(h, /data-i="2" disabled aria-pressed="true"/);
  assert.match(h, /ps-opt-on/);
  assert.match(h, /Booked/);
});

test('expired or past times are disabled; onboarding wording', () => {
  clearUi();
  const ex = P('psOfferHtml')(item({ status: 'expired', kind: 'onboarding' }), 'America/New_York', NOW);
  assert.equal((ex.match(/ disabled/g) || []).length, 3);
  assert.match(ex, /These times have gone/);
  assert.match(ex, /onboarding call/);
  const past = P('psOfferHtml')(item(), 'America/New_York', '2026-12-31T00:00:00Z');
  assert.match(past, /These times have gone/);
});

test('everything from the database is escaped; bad ids draw nothing', () => {
  clearUi();
  assert.equal(P('psOfferHtml')({ meta: { offer_id: '"><script>', options: opts } }), '');
  assert.equal(P('psOfferHtml')({ meta: null }), '');
  assert.equal(P('psOfferHtml')(null), '');
  const h = P('psOfferHtml')(item({ kind: '<img src=x onerror=alert(1)>', options: [{ starts_at: 'nope' }, ...opts] }), 'America/New_York', NOW);
  assert.doesNotMatch(h, /<img/);
  assert.equal((h.match(/data-pc-act="pick"/g) || []).length, 2, 'a bad time is skipped; at most three are read');
});

test('system card: Join the call only for a safe meeting link, not long after the start', () => {
  const sys = P('psSystemHtml');
  const m = { meta: { meeting_id: 'x', url: 'https://meet.google.com/abc-defg-hij', starts_at: '2026-11-26T17:00:00Z' } };
  const h = sys(m, 'America/New_York', NOW);
  assert.match(h, /href="https:\/\/meet\.google\.com\/abc-defg-hij"/);
  assert.match(h, /Join the call/);
  assert.match(h, /rel="noopener noreferrer"/);
  assert.match(h, /Thu, Nov 26 · 12:00 PM ET/);
  assert.equal(sys(m, 'America/New_York', '2026-11-27T00:00:00Z'), '', 'gone 3h after the start');
  assert.equal(sys({ meta: { meeting_id: 'x', url: 'javascript:alert(1)' } }), '');
  assert.equal(sys({ meta: { meeting_id: 'x', url: 'https://x.com/"><b>' } }), '');
  assert.equal(sys({ meta: { url: 'https://meet.google.com/a' } }), '', 'needs a meeting');
  assert.equal(sys({ body: 'approved by Sam', meta: { approval_id: 'a' } }), '');
  assert.equal(sys(null), '');
});

test('the system card hands other system messages to whatever was there before', () => {
  const PC = P('PC');
  assert.equal(PC.cards.system({ meta: { approval_id: 'a' } }), '');
});

function fakeCtx(answer) {
  const calls = [];
  let refreshed = 0;
  return {
    calls, get refreshed() { return refreshed; },
    rpc: async (name, args) => { calls.push({ name, args }); if (answer instanceof Error) throw answer; return answer; },
    refresh: () => { refreshed++; },
  };
}
const btn = (offer, i) => ({ getAttribute: (k) => (k === 'data-offer' ? offer : k === 'data-i' ? String(i) : null), closest: () => null });

test('pick asks portal_offer_pick with the offer and 1-based index, then refreshes', async () => {
  clearUi();
  const ctx = fakeCtx({ ok: true, data: { when: 'fri nov 27, 9am PT' }, error: '' });
  const r = await P('psPick')(btn(OFFER, 2), ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.calls, [{ name: 'portal_offer_pick', args: { p_offer: OFFER, p_index: 2 } }]);
  assert.equal(ctx.refreshed, 1);
  /* booked locally straight away, before the refresh lands */
  const h = P('psOfferHtml')(item(), 'America/New_York', NOW);
  assert.match(h, /data-i="2" disabled aria-pressed="true"/);
  /* a second tap does nothing */
  await P('psPick')(btn(OFFER, 1), ctx);
  assert.equal(ctx.calls.length, 1);
});

test('a failed pick shows plain words and leaves the buttons usable', async () => {
  clearUi();
  const ctx = fakeCtx({ ok: false, data: null, error: 'That time has just gone. Please pick another, or message us.' });
  const r = await P('psPick')(btn(OFFER, 1), ctx);
  assert.equal(r.ok, false);
  const h = P('psOfferHtml')(item(), 'America/New_York', NOW);
  assert.match(h, /That did not book\. That time has just gone/);
  assert.doesNotMatch(h, / disabled/);
});

test('pick never throws and refuses junk without calling the database', async () => {
  clearUi();
  const ctx = fakeCtx(new Error('boom'));
  const r = await P('psPick')(btn(OFFER, 3), ctx);
  assert.equal(r.ok, false);
  const bad = fakeCtx({ ok: true });
  assert.equal((await P('psPick')(btn('nope', 1), bad)).ok, false);
  assert.equal((await P('psPick')(btn(OFFER, 4), bad)).ok, false);
  assert.equal((await P('psPick')(null, bad)).ok, false);
  assert.equal(bad.calls.length, 0);
});

test('the scheduling migration carries the meeting-confirmation trigger and D’s functions', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261124_scheduling.sql'), 'utf8');
  for (const s of ['create or replace trigger meetings_confirm after insert on public.meetings',
    'function public.offer_times(p_client uuid, p_kind text) returns uuid',
    'function public.portal_offer_pick(p_offer uuid, p_index int) returns jsonb',
    'function public.offer_match(m public.channel_messages) returns boolean',
    'create or replace trigger meetings_offer_link after update of meet_link on public.meetings',
    "to_regprocedure('public.precall_request(uuid)')",
    'grant execute on function public.portal_offer_pick(uuid, int) to authenticated']) {
    assert.ok(sql.includes(s), s);
  }
  assert.ok(/revoke execute on function public\.offer_match\(public\.channel_messages\) from public, anon, authenticated/.test(sql));
});
