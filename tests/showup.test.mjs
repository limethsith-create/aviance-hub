/* Tests for "did they show up?" — the question the guarantee turns on.

   A booked sales call counts only when the prospect actually turned up, so a
   wrong answer here is the difference between a month that hit and a month that
   refunds double. Four things are tested:

   1. THE HINT IS ONLY A HINT. call_rsvp_set writes the prospect's calendar RSVP
      and touches nothing else — not happened, not counts, not a month.
   2. THE TRUTH OVERRIDES IT, AND MOVES THE MONTH. call_verdict sets happened,
      moves the meeting with it, and recounts every month the call touches. A
      locked month is never quietly changed and the answer says so.
   3. NOTHING CAN BE FORGOTTEN. verdict_at is null until a person answers, and
      the band at the top of the Calendar lists every past call that has none.
   4. RLS. The new view is security_invoker, so a signed-in client sees nothing
      through it, exactly as they see nothing in qualified_calls.

   Run with:  node --test tests/showup.test.mjs */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = fs.readFileSync(path.join(root, 'supabase/migrations/20261207_showup.sql'), 'utf8');
const bare = SQL.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fn = (name) => {
  const i = bare.indexOf('function public.' + name);
  assert.ok(i > 0, name + ' is in the migration');
  return bare.slice(i, (bare.indexOf('$$;', i) + 1) || bare.length);
};

/* ───────────── 1. the hint is only a hint ───────────── */

test('an RSVP is kept apart from the verdict, and is not the same column', () => {
  assert.match(bare, /add column if not exists rsvp\s+text/);
  assert.match(bare, /add column if not exists verdict_at\s+timestamptz/);
  /* "nobody has answered" is a real state, and it is not happened = false */
  assert.match(SQL, /null means nobody has yet, which is NOT the same as a no-show/);
});

test('writing an RSVP never touches happened, counts or a month', () => {
  const body = fn('call_rsvp_set');
  assert.match(body, /set rsvp = v_rsvp, rsvp_at = now\(\), rsvp_source =/);
  for (const forbidden of [/happened\s*=/, /recount_month/, /client_months/, /update public\.meetings/])
    assert.ok(!forbidden.test(body), 'the hint must not move the money: ' + forbidden);
  /* and it says out loud that it changed nothing */
  assert.match(body, /only a hint\. It has not changed whether this call counts\./);
});

test('both calendars speak: needsAction and notResponded both mean "no reply"', () => {
  const body = fn('call_rsvp_set');
  assert.match(body, /when 'needsaction'\s+then 'no_reply'/);
  assert.match(body, /when 'notresponded' then 'no_reply'/);
  assert.match(bare, /check \(rsvp is null or rsvp in \('accepted','declined','tentative','no_reply'\)\)/);
});

/* ───────────── 2. the truth, and the month ───────────── */

test('the verdict sets happened, moves the meeting with it, and recounts the month', () => {
  const body = fn('call_verdict');
  assert.match(body, /set happened\s+= p_showed/);
  assert.match(body, /verdict_at\s+= now\(\)/);
  assert.match(body, /update public\.meetings/, 'the meeting says the same thing');
  assert.match(body, /case when p_showed then 'held' else 'no_show' end/);
  assert.match(body, /perform public\.recount_month\(m\.id\)/, 'the month is recounted');
  /* the row lock, so two taps cannot both half-finish */
  assert.match(body, /where id = p_call for update/);
});

test('moving a call to no-show recounts BOTH months it could belong to', () => {
  const body = fn('call_verdict');
  /* the month it is pointed at now … */
  assert.match(body, /if q\.month_id is not null then v_ids := array_append\(v_ids, q\.month_id\)/);
  /* … and the month the day it happened falls in */
  assert.match(body, /where client_id = q\.client_id and v_day between starts_on and ends_on/);
  assert.match(body, /foreach v_id in array v_ids loop/);
});

test('a locked month is never quietly changed, and the answer says so', () => {
  const body = fn('call_verdict');
  assert.match(body, /if m\.locked_at is null then\s+perform public\.recount_month/);
  assert.match(body, /else\s+v_locked := true;/);
  assert.match(body, /already locked, so that month''s number and any refund did not move/);
});

test('the verdict is open to any approved team member, not only the owner', () => {
  /* whoever ran the call has to be able to answer it, and a direct write to
     qualified_calls is admin-only, which is exactly why this is a rule */
  for (const f of ['call_verdict', 'call_verdict_by_meeting'])
    assert.match(fn(f), /if not public\.is_approved\(\) then/, f);
  assert.match(fn('call_verdict'), /Only the Aviance team can say whether a call happened\./);
  assert.match(fn('call_verdict'), /security definer/);
});

test('one call per meeting, and a verdict with no call behind it says so instead of guessing', () => {
  assert.match(bare, /create unique index if not exists qualified_calls_one_per_meeting/);
  const body = fn('call_verdict_by_meeting');
  assert.match(body, /No booked sales call is linked to this calendar entry, so there is no month to move/);
});

/* ───────────── 4. RLS on the new view ───────────── */

test('the new view obeys the caller\'s RLS, so a client sees nothing through it', () => {
  assert.match(bare, /create or replace view public\.v_calls_awaiting_verdict\s+with \(security_invoker = true\)/);
  /* it is granted to signed-in people, which is only safe BECAUSE of the line above */
  assert.match(bare, /grant select on public\.v_calls_awaiting_verdict to authenticated/);
  assert.ok(!/grant select on public\.v_calls_awaiting_verdict to anon/.test(bare), 'never to anon');
  /* it joins qualified_calls and clients, both of which already refuse a client */
  assert.match(bare, /from public\.qualified_calls q\s+join public\.clients c/);
});

test('an upheld dispute and a cancelled call are not left on the outstanding list for ever', () => {
  assert.match(bare, /and q\.dispute_status <> 'upheld'/);
  assert.match(bare, /and coalesce\(m\.status, ''\) <> 'cancelled'/);
  assert.match(bare, /where q\.verdict_at is null\s+and q\.booked_for < now\(\)/);
});

/* ───────────── the screen ───────────── */

let calls, tables, rpcs;
function builder(table) {
  const call = { table, op: 'select', filters: [], payload: null };
  calls.push(call);
  const b = {
    select(c) { call.cols = c; return b }, insert(p) { call.op = 'insert'; call.payload = p; return b },
    update(p) { call.op = 'update'; call.payload = p; return b }, upsert(p) { call.op = 'upsert'; call.payload = p; return b },
    delete() { call.op = 'delete'; return b },
    eq(k, v) { call.filters.push(['eq', k, v]); return b }, in(k, v) { call.filters.push(['in', k, v]); return b },
    gte(k, v) { call.filters.push(['gte', k, v]); return b }, lt(k, v) { call.filters.push(['lt', k, v]); return b },
    lte(k, v) { call.filters.push(['lte', k, v]); return b }, gt(k, v) { call.filters.push(['gt', k, v]); return b },
    is(k, v) { call.filters.push(['is', k, v]); return b }, order() { return b }, limit() { return b },
    single() { call.single = true; return b }, maybeSingle() { call.maybe = true; return b },
    then(res, rej) {
      const h = tables[table + '.' + call.op];
      let out = typeof h === 'function' ? h(call) : (h || { data: [], error: null });
      if ((call.single || call.maybe) && out && Array.isArray(out.data))
        out = out.data.length ? { data: out.data[0], error: null } : { data: null, error: call.maybe ? null : { message: 'no rows' } };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}
globalThis.window = globalThis;
globalThis.sb = {
  from: builder,
  rpc: async (name, args) => {
    rpcs.push({ name, args });
    const h = tables['rpc.' + name];
    return typeof h === 'function' ? h(args) : (h || { data: null, error: null });
  },
};
const toasts = [];
globalThis.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
globalThis.val = () => '';
globalThis.errEl = () => false;
globalThis.toast = (m) => { toasts.push(m) };
globalThis.emptyState = (i, t, s) => `<div>${t} ${s}</div>`;
globalThis.openModal = () => {}; globalThis.closeModal = () => {};
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'finance.js'), 'utf8'), { filename: 'finance.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'pipeline.js'), 'utf8'), { filename: 'pipeline.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'meetings.js'), 'utf8'), { filename: 'meetings.js' });

const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const due = (o = {}) => ({
  call_id: 'q1', client_id: 'c1', company: 'Stone Roofing', plan: 'growth',
  prospect_name: 'Dana Reed', prospect_email: 'dana@acme.test', prospect_company: 'Acme',
  booked_for: '2026-11-24T15:00:00Z', meeting_id: 'm1', meeting_status: 'booked',
  rsvp: 'accepted', rsvp_at: '2026-11-20T10:00:00Z', rsvp_source: 'google',
  matched_icp: true, month_id: 'mo1', month_no: 2, month_locked_at: null, hours_overdue: 50, ...o,
});

beforeEach(() => { calls = []; tables = {}; rpcs = []; toasts.length = 0; mt.due = null; });

test('the outstanding band lists every unanswered call with one tap each way', () => {
  const h = mtRenderAwaiting({ rows: [due(), due({ call_id: 'q2', prospect_name: 'Lee Park', rsvp: null, meeting_id: 'm2', hours_overdue: 2 })] });
  const t = text(h);
  assert.match(t, /2 booked sales calls are waiting for an answer/);
  assert.match(t, /Dana Reed, Acme/, 'the prospect and their company');
  assert.match(t, /For Stone Roofing · booked call 2 days ago/, "and whose month it is");
  assert.match(t, /booked call 2 hours ago/);
  assert.match(h, /mtVerdictClick\('m1','q1',true\)/, 'they showed');
  assert.match(h, /mtVerdictClick\('m1','q1',false\)/, 'no-show');
  assert.match(t, /the guarantee is worked out from the month/);
  assert.ok(!/undefined|NaN|\[object/.test(h));
});

test('the RSVP is drawn as a hint, in words that say it is not an answer', () => {
  const t = text(mtRenderAwaiting({ rows: [due({ rsvp: 'accepted' })] }));
  assert.match(t, /Their invitation: Accepted the invitation — a hint, not an answer/);
  assert.match(text(mtRenderAwaiting({ rows: [due({ rsvp: null })] })), /No reply came back from the calendar\./);
  /* every RSVP word says you still have to answer */
  for (const r of ['accepted', 'declined', 'tentative', 'no_reply'])
    assert.match(mtRsvpLine(r), /you still have to say/i, r);
  assert.match(mtRsvpLine('declined'), /They may still have turned up/);
});

test('nothing outstanding draws nothing at all, and a missing view does not shout', () => {
  assert.equal(mtRenderAwaiting({ rows: [] }), '');
  assert.equal(mtRenderAwaiting(null), '');
  assert.equal(mtRenderAwaiting({ rows: [due()], notReady: true }), '', 'not switched on yet: the Calendar is unchanged');
});

test('a locked month is flagged on the row, before anybody taps', () => {
  assert.match(text(mtRenderAwaiting({ rows: [due({ month_locked_at: '2026-11-30T00:00:00Z' })] })),
    /Its month is already locked, so answering will not move that month\u2019s number\./);
});

test('a prospect name with a tag in it cannot write HTML into the band', () => {
  const h = mtRenderAwaiting({ rows: [due({ prospect_name: '<script>alert(1)</script>', company: '"><img src=x>', prospect_company: '<b>x' })] });
  assert.ok(!/<script|<img src=x|<b>x/.test(h));
  assert.match(h, /&lt;script&gt;/);
});

test('the outstanding list is read from the view, never from qualified_calls', async () => {
  tables['v_calls_awaiting_verdict.select'] = () => ({ data: [due()], error: null });
  const r = await mtAwaiting();
  assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']);
  assert.equal(r.ok, true);
  assert.equal(r.data.rows.length, 1);
  assert.deepEqual(calls.map((c) => c.table), ['v_calls_awaiting_verdict']);
  assert.equal(calls.filter((c) => c.table === 'qualified_calls').length, 0);
});

test('a client, who the view hides every row from, gets an empty list and no error', async () => {
  tables['v_calls_awaiting_verdict.select'] = () => ({ data: [], error: null });
  const r = await mtAwaiting();
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.rows, []);
  assert.equal(mtRenderAwaiting(r.data), '', 'and nothing is drawn');
  assert.equal(mtDueCount(), '');
});

test('the verdict goes through the one database rule and reports the new count', async () => {
  tables['rpc.call_verdict_by_meeting'] = () => ({ data: {
    ok: true, call_id: 'q1', meeting_id: 'm1', happened: false, counts: false,
    verdict_at: '2026-11-26T09:00:00Z', rsvp_hint: 'accepted', company: 'Stone Roofing',
    months: [{ month_id: 'mo1', month_no: 2, calls_delivered: 6, calls_promised: 10, verdict: 'open', locked: false, short: 4 }],
    locked_month: false, said: 'Marked as a no-show. It does not count towards the month.' }, error: null });
  const r = await mtVerdict('m1', false);
  assert.equal(r.ok, true);
  assert.equal(r.data.fell_back, false);
  assert.equal(r.data.counted, false);
  assert.equal(r.data.said, 'Marked as a no-show. It does not count towards the month.');
  assert.deepEqual(rpcs, [{ name: 'call_verdict_by_meeting', args: { p_meeting: 'm1', p_showed: false, p_note: null } }]);
  /* the recount is the database's: the browser writes neither table */
  assert.equal(calls.filter((c) => c.op !== 'select').length, 0);
  assert.equal(calls.filter((c) => c.table === 'client_months').length, 0);
});

test('the recount: a no-show takes the call back off the month, a show puts it on', async () => {
  const months = (delivered) => [{ month_id: 'mo1', month_no: 2, calls_delivered: delivered, calls_promised: 10, verdict: 'open', locked: false, short: 10 - delivered }];
  tables['rpc.call_verdict_by_meeting'] = (a) => ({ data: {
    ok: true, call_id: 'q1', happened: a.p_showed, counts: a.p_showed,
    months: months(a.p_showed ? 7 : 6), locked_month: false,
    said: a.p_showed ? 'Counted as a delivered call for the month.' : 'Marked as a no-show. It does not count towards the month.' }, error: null });

  const showed = await mtVerdict('m1', true);
  assert.equal(showed.data.counted, true);
  assert.equal(showed.data.data.months[0].calls_delivered, 7);
  assert.equal(showed.data.data.months[0].short, 3);

  const missed = await mtVerdict('m1', false);
  assert.equal(missed.data.counted, false);
  assert.equal(missed.data.data.months[0].calls_delivered, 6, 'the month lost the call');
  assert.equal(missed.data.data.months[0].short, 4, 'and the shortfall moved with it');
});

test('a locked month is reported to the person, not hidden', async () => {
  tables['rpc.call_verdict_by_meeting'] = () => ({ data: {
    ok: true, call_id: 'q1', happened: false, counts: false, locked_month: true,
    months: [{ month_id: 'mo1', month_no: 1, calls_delivered: 5, calls_promised: 5, verdict: 'hit', locked: true, short: 0 }],
    said: "Marked as a no-show. It does not count towards the month. One of its months is already locked, so that month's number and any refund did not move." }, error: null });
  const r = await mtVerdict('m1', false);
  assert.match(r.data.said, /already locked, so that month's number and any refund did not move/);
  assert.equal(r.data.data.locked_month, true);
});

test('before the migration is applied it falls back and says the month was NOT recounted', async () => {
  tables['rpc.call_verdict_by_meeting'] = () => ({ data: null, error: { message: 'Could not find the function public.call_verdict_by_meeting in the schema cache' } });
  tables['meetings.select'] = () => ({ data: [{ id: 'm1', kind: 'qualified', client_id: 'c1', starts_at: '2026-11-24T15:00:00Z', status: 'booked' }], error: null });
  tables['meetings.update'] = () => ({ data: [{ id: 'm1', status: 'no_show' }], error: null });
  tables['qualified_calls.update'] = () => ({ data: [{ id: 'q1', happened: false }], error: null });
  const r = await mtVerdict('m1', false);
  assert.equal(r.ok, true);
  assert.equal(r.data.fell_back, true);
  assert.match(r.data.said, /not applied to the database yet, so the month has not been recounted/);
  assert.ok(!/schema cache/.test(r.data.said), 'no Postgres wording reaches a person');
});

test('a verdict with no meeting behind it answers the call itself', async () => {
  tables['rpc.call_verdict'] = () => ({ data: { ok: true, call_id: 'q9', happened: true, counts: true, said: 'Counted as a delivered call for the month.' }, error: null });
  const r = await mtVerdictClick('', 'q9', true);
  assert.equal(r.ok, true);
  assert.deepEqual(rpcs[0], { name: 'call_verdict', args: { p_call: 'q9', p_showed: true, p_note: null } });
  assert.match(toasts.join(' | '), /Counted as a delivered call for the month\./);
});

test('"showed up" or "did not" — nothing else is an answer', async () => {
  assert.equal((await mtVerdict('m1', 'maybe')).ok, false);
  assert.equal((await mtVerdict('', true)).ok, false);
  assert.match((await mtVerdict('m1', null)).error, /Say either that they showed up or that they did not\./);
});

test('the call panel says plainly when nobody has answered, and never calls that a no-show', () => {
  const st = mtSettingsNow();
  const m = { id: 'm1', kind: 'qualified', client_id: 'c1', starts_at: '2026-11-24T15:00:00Z', minutes: 30, status: 'booked', time_zone: 'America/New_York', plan: 'growth' };
  const noVerdict = text(mtRenderMeeting({ meeting: m, when: mtBothZones(m.starts_at, st), st,
    client: { id: 'c1', company: 'Stone Roofing', plan: 'growth' },
    call: { id: 'q1', happened: false, verdict_at: null, counts: false, matched_icp: true, rsvp: 'accepted' } }));
  assert.match(noVerdict, /Did they show up\? Nobody has answered yet/);
  assert.match(noVerdict, /Not counted, because nobody has answered yet\./);
  assert.match(noVerdict, /Their invitation Accepted the invitation/);
  assert.ok(!/No-show/.test(noVerdict.replace(/No-show<\/button>/g, '')) || /Nobody has answered yet/.test(noVerdict));

  const answered = text(mtRenderMeeting({ meeting: m, when: mtBothZones(m.starts_at, st), st,
    client: { id: 'c1', company: 'Stone Roofing', plan: 'growth' },
    call: { id: 'q1', happened: false, verdict_at: '2026-11-26T09:00:00Z', counts: false, matched_icp: true, rsvp: 'accepted' } }));
  assert.match(answered, /Did they show up\? No-show/);
  assert.match(answered, /Not counted for the month\./);
});

test('a booked sales call is answered through the verdict rule, another kind of call is not', () => {
  const st = mtSettingsNow();
  const base = { id: 'm1', starts_at: '2026-11-24T15:00:00Z', minutes: 30, status: 'booked', time_zone: 'America/New_York' };
  const q = mtRenderMeeting({ meeting: { ...base, kind: 'qualified', client_id: 'c1' }, when: mtBothZones(base.starts_at, st), st, client: null, call: null });
  assert.match(q, /mtVerdictClick\('m1',''/, 'the money goes through one rule');
  assert.ok(!/mtHeldClick/.test(q));
  const other = mtRenderMeeting({ meeting: { ...base, kind: 'onboarding', client_id: 'c1' }, when: mtBothZones(base.starts_at, st), st, client: null, call: null });
  assert.match(other, /mtHeldClick\('m1'\)/, 'an onboarding call keeps its simpler path');
  assert.ok(!/mtVerdictClick/.test(other));
});

test('the sidebar badge counts what is outstanding, off what is already loaded', async () => {
  tables['v_calls_awaiting_verdict.select'] = () => ({ data: [due(), due({ call_id: 'q2' })], error: null });
  const r = await mtAwaiting();
  mt.due = r.data;
  assert.equal(mtDueCount(), 2);
  mt.due = { rows: [] };
  assert.equal(mtDueCount(), '');
});
