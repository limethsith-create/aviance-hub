/* THE MONTH-END ENGINE.
   Round 2, agent 1. What closes a month, what refuses to close one, who is
   told, and what happens when a locked month's calls are edited afterwards.

   The engine itself is SQL — 20261209_month_end_engine.sql, which is NOT
   APPLIED (the agent that wrote it cannot run DDL on the project). SQL does not
   run under node, so its properties are pinned by reading the migration with
   its comments stripped, the convention tests/server-fixes.test.mjs and
   tests/guarantee.test.mjs set. Everything the browser does about month end is
   exercised for real.

   Run with:  node --test tests/month-end.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/* ═══════════════════════════════════════════════════════════════════════════
   PART 1 — the migration: what the engine will and will not do
   ═══════════════════════════════════════════════════════════════════════════ */

const RAW = read('supabase/migrations/20261209_month_end_engine.sql');
/* comments dropped, so nothing here can be "proved" by a comment */
const SQL = RAW.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

/** The body of one `create or replace function public.<name>`. */
function fnBody(sql, name) {
  const re = new RegExp('create or replace function\\s+public\\.' + name
    + '\\s*\\([\\s\\S]*?\\sas\\s+(\\$\\w*\\$)[\\s\\S]*?\\1\\s*;', 'g');
  const all = [...sql.matchAll(re)].map((m) => m[0]);
  assert.ok(all.length >= 1, name + ' is not defined in that migration');
  return all[all.length - 1];
}
const VIEW = (() => {
  const m = SQL.match(/create or replace view\s+public\.v_months_to_close[\s\S]*?;\n/);
  assert.ok(m, 'v_months_to_close is not in the migration');
  return m[0];
})();
const SWEEP = fnBody(SQL, 'month_end_close');
const TRIGGER = fnBody(SQL, 'trg_locked_month_touched');
const PAID = fnBody(SQL, 'month_is_paid');

test('the migration says it is not applied, and applies nothing destructive', () => {
  assert.match(RAW, /NOT APPLIED/, 'the file must say so: the agent could not run DDL');
  /* no DELETE anywhere — the project refuses deletes and this file must not try */
  assert.equal(/\bdelete\s+from\b/i.test(SQL), false, 'nothing is deleted');
  assert.equal(/\bdrop\s+(table|view|function|column)\b/i.test(SQL), false, 'nothing is dropped but the trigger it replaces');
  assert.match(SQL, /drop trigger if exists qualified_calls_locked_month/, 're-runnable');
});

test('there is a view that answers "which months are over and still open"', () => {
  /* There was none. The Month end screen worked it out in the browser, so the
     screen and anything automatic could disagree about what had ended. */
  assert.match(VIEW, /where m\.locked_at is null/, 'only months with no verdict yet');
  assert.match(VIEW, /m\.verdict = 'open'/);
  assert.match(VIEW, /m\.ends_on is not null/, 'a month with no end date never ends, and is not counted as ended');
  assert.match(VIEW, /m\.ends_on < today\.us_today/, 'ended, in the house US zone');
  for (const col of ['ready', 'why_not', 'awaiting_verdict', 'days_over', 'refund_if_locked', 'month_paid'])
    assert.match(VIEW, new RegExp('\\bas ' + col + '\\b|\\b' + col + '\\b'), 'the view must carry ' + col);
});

test('"has it ended?" is asked in the house US zone, never in UTC', () => {
  /* Daylight saving and the five hours either side of midnight New York. A date
     cast against now() in UTC locks a month up to a day early. */
  assert.match(VIEW, /us_zone from public\.calendar_settings/, 'the zone is read from the settings row');
  assert.match(VIEW, /\(now\(\) at time zone \(select zone from cfg\)\)::date/);
  assert.equal(/CURRENT_DATE|current_date/.test(VIEW), false,
    'CURRENT_DATE is UTC: v_month_standing.days_left already has this bug, this view must not');
  assert.match(SWEEP, /\(now\(\) at time zone v_zone\)::date/, 'the sweep asks the same question the same way');
});

test('a month with a call nobody has judged is HELD, not locked', () => {
  /* The expensive one. An unverdicted call counts as not delivered, so locking
     under-counts the month and over-refunds — $1,500, or $3,000 in month one —
     and recount_month never runs on a locked month, so it cannot be undone. */
  assert.match(VIEW, /q\.verdict_at is null/, 'the readiness test looks for unanswered calls');
  assert.match(VIEW, /not exists \(select 1 from public\.qualified_calls q/);
  assert.match(VIEW, /q\.dispute_status = 'raised'/, 'a dispute still being decided can change the count too');
  assert.match(SWEEP, /if not r\.ready then/, 'the sweep acts on the view\'s decision, it does not re-decide');
  assert.match(SWEEP, /continue;/, 'a held month is skipped, not locked');
});

test('a call whose meeting was CANCELLED does not hold its month forever', () => {
  /* A cancelled call is never given a verdict, so "no verdict yet" would have
     been true of it for ever and the month would never close — the exact
     failure this engine exists to stop, reintroduced by the fix for it.
     v_calls_awaiting_verdict already excludes a cancelled meeting; the
     readiness test asks the same question the same way. */
  const clauses = VIEW.match(/<> 'cancelled'/g) || [];
  assert.equal(clauses.length, 3, 'the count, the readiness test and the reason must all exclude it');
  assert.match(VIEW, /select mt\.status from public\.meetings mt where mt\.id = q\.meeting_id/);
});

test('a hold becomes a task rather than a habit', () => {
  /* A month that is never locked and never mentioned is the bug this engine
     exists to fix. A hold is quiet for a day or two, then loud, and stays loud. */
  assert.match(SWEEP, /MONTH_END_NAG_DAYS constant integer := \d+/);
  assert.match(SWEEP, /if r\.days_over >= MONTH_END_NAG_DAYS then/);
  assert.match(SWEEP, /perform public\.month_task\(/);
  assert.match(SWEEP, /cannot close/, 'the task says what it is');
});

test('a month that was never paid for does not raise a refund by itself', () => {
  /* Checked live 2026-11-26: BOTH months that had ended and were still open
     were unpaid — one invoice 'draft', one 'sent'. Locking them would have
     raised $6,000 of owed refunds against $3,000 that never arrived, and
     refunds_one_per_missed_month means a corrected refund can never be raised
     for that month afterwards. A month that was HIT is locked anyway: locking a
     hit raises no money. */
  assert.match(VIEW, /\) >= m\.calls_promised\n\s*or public\.month_is_paid\(m\.id\)\)/,
    'a month that HIT locks whatever its invoice says: locking a hit raises no money');
  assert.match(VIEW, /never paid for/, 'and says so in a sentence the owner can act on');
  /* and the hit test counts the calls rather than trusting client_months.calls_delivered,
     which is a cached number nothing recounts on its own. lock_month() recounts BEFORE
     it judges, so a stale 5-of-5 would otherwise be waved through as a hit and come
     back as a refund on money that never arrived. Found by running the engine against
     a month whose stored count had no calls behind it. */
  assert.match(VIEW, /as delivered_counted,/);
  assert.equal(/and \(m\.calls_delivered >= m\.calls_promised or/.test(VIEW), false,
    'the stored count must not be what decides whether an unpaid month may lock');
  /* a 3-month prepay: months 2 and 3 have no invoice of their own and must not read as unpaid */
  assert.match(PAID, /'3month'/);
  assert.match(PAID, /1 \+ 3 \* \(\(m\.month_no - 1\) \/ 3\)/, 'the covering invoice is months 1, 4, 7 …');
});

test('a client who has stopped is left to the Ending screen', () => {
  assert.match(VIEW, /c\.ended_on is null/);
  assert.match(VIEW, /coalesce\(c\.stage, ''\) not in \('ended', 'paused'\)/,
    'a null stage must read as "not stopped", not as unknown-and-therefore-not-ready');
  assert.match(VIEW, /your decision, not the clock/);
});

test('a month that was never set up properly is skipped, never guessed at', () => {
  assert.match(VIEW, /m\.starts_on is not null/);
  assert.match(VIEW, /c\.plan in \('starter', 'growth', 'scale'\)/);
  assert.match(VIEW, /coalesce\(c\.monthly_fee, 0\) > 0/);
  assert.match(VIEW, /no start or end date/);
  assert.match(VIEW, /monthly fee is not set/);
});

test('two months ending the same night: one that fails does not take the other with it', () => {
  /* A per-row exception block. Without it the first month that raises aborts
     the whole sweep and every month behind it stays open with nobody told. */
  assert.match(SWEEP, /begin[\s\S]*exception when others then[\s\S]*v_failed := v_failed/);
  assert.match(SWEEP, /'error', sqlerrm/, 'the database\'s own words are kept, for the log');
});

test('two sweeps cannot interleave, and a month cannot be locked twice', () => {
  assert.match(SWEEP, /pg_try_advisory_xact_lock\(hashtext\('aviance\.month_end_close'\)\)/);
  assert.match(SWEEP, /another month-end run is in progress/);
  /* and the view only ever offers months that are not locked */
  assert.match(VIEW, /where m\.locked_at is null/);
});

test('the sweep decides nothing about money: every verdict goes through lock_month', () => {
  assert.match(SWEEP, /m := public\.lock_month\(r\.month_id\);/);
  /* no fee arithmetic of its own anywhere in the sweep */
  assert.equal(/monthly_fee\s*\*/.test(SWEEP), false, 'the guarantee basis lives in lock_month, nowhere else');
  assert.equal(/\bmult\b|\* 2\.0\b/.test(SWEEP), false);
});

test('a locked month with money owed raises something the owner looks at', () => {
  /* No notification system is invented: tasks (the Team screen, Today\'s
     "Needs a person", the sidebar badge) and client_events (the client\'s own
     trail). NOT a client channel — a client must not read "we owe you $3,000"
     before the owner has. */
  assert.match(SWEEP, /insert into public\.client_events[\s\S]*'guarantee', 'month_closed'/);
  assert.match(SWEEP, /if coalesce\(m\.refund_due, 0\) > 0 then/);
  assert.match(SWEEP, /Refund owed: %s month %s/);
  assert.equal(/channel_messages/.test(SQL), false, 'nothing is written into a client channel');
  const task = fnBody(SQL, 'month_task');
  assert.match(task, /'finance'/);
  assert.match(task, /status not in \('done', 'cancelled'\)/, 'one task per month, not one an hour');
});

test('the job locks and refunds, and never opens or invoices a month', () => {
  /* Opening the next month needs two decisions a clock cannot make — whether a
     3-month client renews at the term boundary, and that nothing is opened for
     a client who has left — so finance.js fnCloseMonth keeps them and this job
     does not touch them. A cron that opened month 4 of a 3-month term would be
     invoicing a renewal nobody agreed to. */
  assert.equal(/open_next_month|raise_invoice/.test(SWEEP), false,
    'the sweep must not open a month or raise an invoice');
  assert.match(RAW, /DOES NOT DO|does not do/, 'and the file must say which steps it leaves alone');
  assert.match(RAW, /3-month term boundary/);
  assert.match(RAW, /APPLY THIS AFTER 20261208_guarantee_maths_fixes\.sql/,
    'with the old recount_month, oldest-first double-counts a call that moved month');
});

test('a client\'s months are closed oldest first', () => {
  /* Month 1 refunds at twice the fee and every month after at one, so month 1's
     verdict must be settled before month 2's. Live data had them out of order:
     one client's month 2 was locked on 26 November while its month 1, which
     ended on 9 October, was still open. */
  assert.match(SWEEP, /order by client_id, month_no loop/);
});

test('the schedule is hourly, and named so it can be replaced', () => {
  assert.match(SQL, /cron\.schedule\('aviance-month-end', '40 \* \* \* \*'/);
  assert.match(SQL, /month_end_close\(\)/);
  /* clear of the two jobs already on the project: :05 and :17 */
  assert.equal(/'5 \* \* \* \*'|'17 \* \* \* \*'/.test(SQL), false);
});

test('an edit to a call in a LOCKED month is allowed, recorded, and raised', () => {
  /* Round 1 found that a locked month\'s calls can still be edited and nothing
     records it. RECORD, not refuse: a client may raise a dispute weeks after a
     month closes and is entitled to, call_verdict() already allows the edit
     deliberately, and a refusal would surface as a failed button in the portal.
     What was missing was the record, not the refusal. */
  assert.match(SQL, /create trigger qualified_calls_locked_month\s*\n\s*after update on public\.qualified_calls/);
  assert.match(TRIGGER, /if m\.id is null or m\.locked_at is null then return new; end if;/);
  assert.match(TRIGGER, /'guarantee', 'locked_month_touched'/);
  assert.match(TRIGGER, /'was', jsonb_build_object/, 'before');
  assert.match(TRIGGER, /'now', jsonb_build_object/, 'and after');
  assert.match(TRIGGER, /if new\.counts is distinct from old\.counts then/,
    'only a change that moves whether the call counts can unsupport the number');
  assert.match(TRIGGER, /no longer matches its calls/);
  /* nothing is re-opened and no refund is rewritten behind the owner's back */
  assert.equal(/update public\.client_months/.test(TRIGGER), false);
  assert.equal(/update public\.refunds|insert into public\.refunds/.test(TRIGGER), false);
  assert.match(TRIGGER, /return new;/, 'the edit stands');
});

test('the trigger ignores an edit that cannot change a count', () => {
  assert.match(TRIGGER, /if new\.happened is not distinct from old\.happened[\s\S]*then return new; end if;/,
    'a note, an email address or a reschedule must not raise a finance task');
});

test('the engine is reachable by the owner and by nobody else', () => {
  assert.match(SQL, /revoke execute on function public\.month_end_close\(\)\s+from public, anon;/);
  assert.match(SQL, /grant\s+execute on function public\.month_end_close\(\)\s+to authenticated, service_role;/);
  assert.match(SQL, /revoke execute on function public\.month_task\(uuid, text, text, date\) from public, anon, authenticated;/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   PART 2 — digest.js: the list, and Today
   ═══════════════════════════════════════════════════════════════════════════ */

let tables, errors, calls;
function builder(table) {
  const call = { table, filters: [], single: false };
  calls.push(call);
  const b = {
    select() { return b; }, eq(k, v) { call.filters.push([k, v]); return b; },
    in() { return b; }, is() { return b; }, gte() { return b; }, lte() { return b; },
    lt() { return b; }, gt() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle() { call.single = true; return b; }, single() { call.single = true; return b; },
    then(res, rej) {
      if (errors[table]) return Promise.resolve({ data: null, error: { message: errors[table] } }).then(res, rej);
      const rows = (tables[table] || []).filter((r) => call.filters.every(([k, v]) => r[k] === v));
      return Promise.resolve(call.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }).then(res, rej);
    },
  };
  return b;
}
let finance;
const dgCtx = {};
vm.runInThisContext(read('core.js'), { filename: 'core.js' });
vm.runInThisContext(read('digest.js'), { filename: 'digest.js' });

beforeEach(() => {
  tables = {}; errors = {}; calls = [];
  globalThis.window = globalThis;
  globalThis.sb = { from: builder };
  finance = { money: null, exposure: null, clients: [], standing: [], invoices: [], locked: [] };
  globalThis.fnMoney = async () => ({ ok: true, data: finance.money, error: '' });
  globalThis.fnExposure = async () => ({ ok: true, data: finance.exposure, error: '' });
  globalThis.fnClients = async () => ({ ok: true, data: finance.clients, error: '' });
  globalThis.fnInvoices = async () => ({ ok: true, data: finance.invoices, error: '' });
  globalThis.fnStanding = async () => ({ ok: true, data: finance.standing, error: '' });
  globalThis.fnLockMonth = async (id) => { finance.locked.push(id); return { ok: true, data: { id }, error: '' }; };
});

const NOW = new Date('2026-11-27T15:00:00Z');
const strip = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/* a row of v_months_to_close, as the migration defines it */
const toClose = (o = {}) => ({
  month_id: 'm1', client_id: 'c1', company: 'Stone Roofing', plan: 'starter', term: 'monthly',
  monthly_fee: 1500, month_no: 1, starts_on: '2026-09-10', ends_on: '2026-10-09',
  calls_promised: 5, calls_delivered: 0, calls_short: 5, days_over: 48, multiplier: 2,
  refund_if_locked: 3000, awaiting_verdict: 0, disputes_open: 0, month_paid: true,
  client_gone: false, ready: true, why_not: '', ...o,
});
const standingRow = (o = {}) => ({
  month_id: 's1', client_id: 'c1', company: 'Stone Roofing', month_no: 1,
  starts_on: '2026-11-01', ends_on: '2026-11-30', calls_promised: 10, calls_delivered: 2,
  verdict: 'open', locked_at: null, refund_due: 0, at_risk: 6000, monthly_fee: 3000, ...o,
});

test('dgMonthClose reads the engine\'s own view, so the screen and the sweep cannot disagree', async () => {
  tables.v_months_to_close = [
    toClose(),
    toClose({ month_id: 'm2', company: 'Harbor Co', client_id: 'c2', month_no: 3, monthly_fee: 3000,
      refund_if_locked: 3000, multiplier: 1, calls_delivered: 7, calls_promised: 10, days_over: 2 }),
  ];
  finance.clients = [{ id: 'c1', company: 'Stone Roofing' }, { id: 'c2', company: 'Harbor Co' }];
  const r = await dgMonthClose(NOW);
  assert.equal(r.ok, true);
  assert.equal(r.data.engine, true);
  assert.deepEqual(r.data.months.map((x) => x.monthId), ['m1', 'm2'], 'biggest refund first');
  assert.deepEqual(r.data.held, []);
  assert.equal(r.data.totalRefund, 6000);
  assert.ok(calls.some((c) => c.table === 'v_months_to_close'), 'the view was read');

  const t = strip(dgRenderMonthEnd(r.data));
  assert.match(t, /closes these by itself, every hour/, 'the owner is told what is watching');
  assert.match(t, /\$3,000/);
  assert.match(t, /48 days ago/, 'how overdue it is, not just the date');
  assert.match(t, /Locking all of these would refund \$6,000/);
});

test('a month the engine will NOT close is shown with the reason, and can still be locked by hand', async () => {
  tables.v_months_to_close = [
    toClose({ ready: false, awaiting_verdict: 2,
      why_not: 'Some calls in this month have not been marked as held or missed yet. Mark them and it closes by itself within the hour.' }),
  ];
  finance.clients = [{ id: 'c1', company: 'Stone Roofing' }];
  const r = await dgMonthClose(NOW);
  assert.deepEqual(r.data.months, []);
  assert.equal(r.data.held.length, 1);
  assert.equal(r.data.held[0].awaitingVerdict, 2);
  assert.equal(r.data.heldRefund, 3000);

  const html = dgRenderMonthEnd(r.data);
  const t = strip(html);
  assert.match(t, /Ended, but not closing by itself/);
  assert.match(t, /have not been marked as held or missed/, 'the reason, in words');
  assert.match(t, /As they stand these would refund \$3,000/);
  assert.ok(html.includes('dgLockMonth(&#39;m1&#39;)'), 'the owner can always override the engine');
  assert.match(t, /Lock it anyway/);
});

test('the close button uses the money side\'s own sequence when it is there', async () => {
  /* Closing a month is lock + refund + open the next + invoice it, and
     fnCloseMonth is the one place that does all four with the right refusals.
     This screen must not write a second sequence. */
  tables.v_months_to_close = [toClose()];
  finance.clients = [{ id: 'c1', company: 'Stone Roofing' }];
  const closed = [];
  globalThis.fnCloseMonth = async (id) => { closed.push(id); return { ok: true, data: { id }, error: '' } };
  await dgLockMonth('m1');
  assert.deepEqual(closed, ['m1']);
  assert.deepEqual(finance.locked, [], 'and it does not then lock the month a second way');

  /* a refusal comes back in its own words, and nothing is locked behind it */
  globalThis.fnCloseMonth = async () => ({ ok: false, data: null,
    error: 'That is the end of their 3-month term. Decide whether they renew before closing it.' });
  await dgLockMonth('m1');
  assert.deepEqual(finance.locked, [], 'a refusal is a refusal, not a reason to fall back to locking');
  delete globalThis.fnCloseMonth;

  /* and on a build without it, the button still locks */
  await dgLockMonth('m1');
  assert.deepEqual(finance.locked, ['m1']);
});

test('without the migration the screen falls back, and says nothing is closing months on its own', async () => {
  errors.v_months_to_close = 'relation "public.v_months_to_close" does not exist';
  finance.clients = [{ id: 'c1', company: 'Stone Roofing' }];
  finance.standing = [standingRow({ ends_on: '2026-10-31', verdict: 'open', refund_due: 3000 })];
  const r = await dgMonthClose(NOW);
  assert.equal(r.ok, true);
  assert.equal(r.data.engine, false);
  assert.equal(r.data.months.length, 1, 'the old browser-side answer still works');
  const t = strip(dgRenderMonthEnd(r.data));
  assert.match(t, /Nothing closes a month on its own yet/);
  assert.match(t, /waits for the button/);
});

test('dgHome counts the months that are over and still open, and what they cost', async () => {
  /* Today's only mention of month end was a link reading "Close the months
     that have ended" — the same words whether there were none or five, and
     whether they owed nothing or $6,000. The month that ended on 9 October
     owing $3,000 sat 48 days behind that one sentence.
     Round 2 agent 5 owns the commitment board that draws these on Today, so
     this is the count and the money, off rows dgHome already reads; nothing
     here draws a second copy of them. */
  finance.clients = [{ id: 'c1', company: 'Stone Roofing', stage: 'live', day1_on: '2026-09-10' }];
  finance.standing = [
    standingRow({ month_id: 'a', starts_on: '2026-09-10', ends_on: '2026-10-09', at_risk: 3000, refund_due: 3000 }),
    standingRow({ month_id: 'b', starts_on: '2026-10-10', ends_on: '2026-11-09', at_risk: 1500, refund_due: 1500 }),
    standingRow({ month_id: 'c', starts_on: '2026-11-10', ends_on: '2026-12-09', at_risk: 1500, refund_due: 0 }),
  ];
  const d = (await dgHome(NOW)).data;
  assert.equal(d.endedOpen.count, 2, 'two months are over and still open');
  assert.equal(d.endedOpen.refund, 4500);
  assert.equal(d.endedOpen.oldestDays, 49);
  /* Today itself is left exactly as it was: the action lives on Month end. */
  assert.match(strip(dgRenderHome(d)), /Close the months that have ended/);
});

test('a refund it could not read makes the total unknown, never a smaller number', async () => {
  finance.clients = [{ id: 'c1', company: 'Stone Roofing', stage: 'live', day1_on: '2026-09-10' }];
  finance.standing = [
    standingRow({ month_id: 'a', ends_on: '2026-10-09', at_risk: 3000, refund_due: 3000 }),
    { month_id: 'b', client_id: 'c1', month_no: 2, starts_on: '2026-10-10', ends_on: '2026-11-09',
      calls_promised: 5, calls_delivered: 0, verdict: 'open', locked_at: null },
  ];
  const d = (await dgHome(NOW)).data;
  assert.equal(d.endedOpen.count, 2);
  assert.equal(d.endedOpen.refund, null, 'one of them is unknown, so the total is unknown');
});

test('nothing over and still open is counted as nothing, and an unreadable view as unknown', async () => {
  const d = (await dgHome(NOW)).data;
  assert.equal(d.endedOpen.count, 0);

  globalThis.fnStanding = async () => ({ ok: false, data: null, error: 'The month standings could not be read.' });
  errors.v_month_standing = 'nope';
  const d2 = (await dgHome(NOW)).data;
  assert.equal(d2.endedOpen, null, 'never a confident zero for something that was not read');
});

test('a month that is OVER is not also counted as "running short"', async () => {
  /* It was in both lists, so anything adding them up counted it twice. A month
     that has ended is not running: it belongs under months to close. */
  finance.clients = [{ id: 'c1', company: 'Stone Roofing', stage: 'live', day1_on: '2026-09-10' }];
  finance.standing = [standingRow({ ends_on: '2026-10-09', at_risk: 3000, refund_due: 3000 })];
  const d = (await dgHome(NOW)).data;
  assert.deepEqual(d.shortMonths, []);
  assert.equal(d.endedOpen.count, 1);
  assert.equal(dgNeedsCount(d), 0, 'counted where it belongs, and not twice');
  assert.match(strip(dgRenderHome(d)), /No month is running short/);
});

test('how much of the exposure total has not started yet is counted separately', async () => {
  /* v_exposure adds up every open month. Live on 2026-11-26 it said $69,300,
     of which $30,000 was 14 months whose first day had not come — and the tile
     reads "if every open month missed today". The view's figure is left
     untouched (this file does not re-work the money, and the tile belongs to
     the screen that draws it); what it is made of is counted. */
  finance.exposure = { at_risk_total: 9000 };
  finance.clients = [{ id: 'c1', company: 'Stone Roofing', stage: 'live', day1_on: '2026-11-01' }];
  finance.standing = [
    standingRow({ month_id: 'now', starts_on: '2026-11-01', ends_on: '2026-11-30', at_risk: 3000 }),
    standingRow({ month_id: 'next', starts_on: '2026-12-01', ends_on: '2026-12-30', at_risk: 3000 }),
    standingRow({ month_id: 'after', starts_on: '2027-01-01', ends_on: '2027-01-30', at_risk: 3000 }),
  ];
  const d = (await dgHome(NOW)).data;
  assert.equal(d.exposureNotStarted, 6000);
  /* a month already running is exposure today and is not counted here */
  assert.equal(dgExposureNotStarted(finance.standing, new Date('2027-02-01T12:00:00Z')), 0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   PART 3 — wrapup.js: ending a client must not refund months that never ran
   ═══════════════════════════════════════════════════════════════════════════ */

/* The same in-memory Supabase and real month clock as tests/wrapup.test.mjs. */
function makeDb(seed, rpcs) {
  const db = JSON.parse(JSON.stringify(seed));
  const log = [];
  let seq = 0;
  const match = (row, fs_) => fs_.every(([kind, col, val]) => {
    const v = row[col];
    if (kind === 'eq') return String(v) === String(val);
    if (kind === 'in') return val.map(String).includes(String(v));
    return true;
  });
  function from(table) {
    db[table] ||= [];
    const q = { table, filters: [], op: 'select', payload: null, single: false, maybeSingle: false, order: null };
    const b = {
      select() { return b; }, eq(c, v) { q.filters.push(['eq', c, v]); return b; },
      lte() { return b; }, gt() { return b; }, not() { return b; }, or() { return b; },
      in(c, v) { q.filters.push(['in', c, v]); return b; },
      order(c, o) { q.order = [c, !o || o.ascending !== false]; return b; }, limit() { return b; },
      insert(p) { q.op = 'insert'; q.payload = p; return b; },
      update(p) { q.op = 'update'; q.payload = p; return b; },
      delete() { q.op = 'delete'; return b; },
      single() { q.single = true; return b; }, maybeSingle() { q.maybeSingle = true; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    function run() {
      log.push({ table, op: q.op, payload: q.payload });
      let out;
      if (q.op === 'insert') {
        const row = Object.assign({ id: table + '-' + (++seq) }, q.payload);
        db[table].push(row); out = [row];
      } else {
        const hit = db[table].filter((r) => match(r, q.filters));
        if (q.op === 'update') hit.forEach((r) => Object.assign(r, q.payload));
        out = hit;
      }
      out = JSON.parse(JSON.stringify(out));
      if (q.order) out.sort((a, z) => (String(a[q.order[0]] ?? '') < String(z[q.order[0]] ?? '') ? -1 : 1) * (q.order[1] ? 1 : -1));
      if (q.single) return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'No row.' } };
      if (q.maybeSingle) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
    return b;
  }
  const rpc = (name, args) => {
    log.push({ rpc: name, args });
    const fn = (rpcs || {})[name];
    return Promise.resolve(fn ? fn(db, args) : { data: null, error: { message: 'No such rule.' } });
  };
  return { sb: { from, rpc }, db, log };
}
const monthClock = {
  recount_month: (db, a) => {
    const m = db.client_months.find((x) => x.id === a.p_month);
    if (!m || m.locked_at) return { data: 0, error: null };
    return { data: m.calls_delivered, error: null };
  },
  lock_month: (db, a) => {
    const m = db.client_months.find((x) => x.id === a.p_month);
    if (!m) return { data: null, error: { message: 'That month is not there.' } };
    if (m.locked_at) return { data: m, error: null };
    const hit = m.calls_delivered >= m.calls_promised;
    m.verdict = hit ? 'hit' : 'missed';
    m.locked_at = '2026-11-27T15:00:00Z';
    if (!hit) {
      const c = db.clients.find((x) => x.id === m.client_id);
      const mult = m.month_no === 1 ? 2 : 1;
      m.refund_due = mult * c.monthly_fee;
      db.refunds.push({ id: 'rf-' + m.month_no, client_id: m.client_id, month_id: m.id,
        amount: m.refund_due, multiplier: mult, reason: 'short', status: 'owed', paid_at: null });
    }
    return { data: m, error: null };
  },
};
function loadWrapup(seed) {
  const made = makeDb(seed, monthClock);
  const ctx = {
    sb: made.sb, esc: (s) => String(s ?? ''),
    openModal() {}, closeModal() {}, toast() {}, val: () => '', errEl: () => false,
    emptyState: (i, t, s) => String(t) + ' ' + String(s), render() {}, currentView: 'ending',
    document: { getElementById: () => null }, window: { print() {} }, console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('core.js'), ctx, { filename: 'core.js' });
  vm.runInContext(read('finance.js'), ctx, { filename: 'finance.js' });
  vm.runInContext(read('wrapup.js'), ctx, { filename: 'wrapup.js' });
  return { ctx, db: made.db, log: made.log };
}
const wuClient = { id: 'c1', company: 'Harbor Co', contact_name: 'Pat', contact_email: 'pat@harbor.test',
  plan: 'starter', term: 'monthly', calls_promised: 5, monthly_fee: 1500, stage: 'live',
  ended_on: null, end_reason: null, day1_on: '2026-09-10', website: null };
const wuMonth = (o) => Object.assign({ id: 'x', client_id: 'c1', month_no: 1, starts_on: '2026-09-10',
  ends_on: '2026-10-09', calls_promised: 5, calls_delivered: 0, verdict: 'open',
  locked_at: null, refund_due: 0 }, o);
const wuSeed = (over) => Object.assign({
  clients: [JSON.parse(JSON.stringify(wuClient))], client_months: [], qualified_calls: [],
  invoices: [], refunds: [], handovers: [], client_events: [], client_profiles: [], meetings: [],
  outreach_threads: [], outreach_messages: [], outreach_campaigns: [], outreach_accounts: [],
}, over || {});

test('ending a client does not refund months that never ran', async () => {
  /* Live on 2026-11-26 one client carried twelve month rows out to September
     2027. Ending them locked every unlocked one, which read ten unstarted
     months as missed and raised $15,000 of refunds for months nobody had been
     sold. Across the ten clients in the database: $63,300 of $69,300 raised
     was for months that were not over. One button. */
  const months = [wuMonth({ id: 'm1', month_no: 1, starts_on: '2026-09-10', ends_on: '2026-10-09' })];
  for (let n = 2; n <= 12; n++) {
    months.push(wuMonth({ id: 'm' + n, month_no: n,
      starts_on: '2026-' + String(9 + n > 12 ? 1 : 9 + n).padStart(2, '0') + '-10',
      ends_on: n <= 2 ? '2026-11-09' : '2027-' + String(n - 2).padStart(2, '0') + '-09' }));
  }
  const t = loadWrapup(wuSeed({ client_months: months }));
  const r = await t.ctx.wuEndClient('c1', { reason: 'They are moving in-house', lastDay: '2026-11-27' });
  assert.equal(r.ok, true, r.error);

  const locked = t.db.client_months.filter((m) => m.locked_at).map((m) => m.month_no).sort((a, b) => a - b);
  assert.deepEqual(locked, [1, 2], 'only the two months that finished on or before their last day');
  const raised = t.db.refunds.reduce((s, x) => s + x.amount, 0);
  assert.equal(raised, 3000 + 1500, 'month one at 2x and month two at 1x — and nothing else');
  assert.equal(r.data.monthsLeftOpen.length, 10);
  assert.deepEqual(r.data.monthsLeftOpen.map((m) => m.monthNo).sort((a, b) => a - b),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  /* and the trail says which ones were left, so it was a decision and not a gap */
  const ev = t.db.client_events.find((e) => e.event === 'client_ended');
  assert.deepEqual(ev.detail.months_left_open.slice().sort((a, b) => a - b),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(ev.detail.months_locked, 2);
});

test('ending a client still refuses while a FINISHED month has no verdict', async () => {
  /* The protection that mattered is kept: a month that ran to its end and has
     no count may hide money we owe, and ending on top of it hides it. */
  const t = loadWrapup(wuSeed({
    client_months: [wuMonth({ id: 'm1', month_no: 1, ends_on: '2026-10-09' })],
  }), {});
  t.ctx.fnLockMonth = async () => ({ ok: false, data: null, error: 'That month is still running.' });
  const r = await t.ctx.wuEndClient('c1', { reason: 'done', lastDay: '2026-11-27' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Month 1/);
  assert.match(r.error, /hide money/);
  assert.equal(t.db.clients[0].ended_on, null);
});

test('the final statement tells a missing count apart from a month left open on purpose', async () => {
  const t = loadWrapup(wuSeed({
    clients: [Object.assign(JSON.parse(JSON.stringify(wuClient)), { ended_on: '2026-10-09', stage: 'ended' })],
    client_months: [
      wuMonth({ id: 'm1', month_no: 1, ends_on: '2026-10-09', locked_at: null }),
      wuMonth({ id: 'm2', month_no: 2, starts_on: '2026-10-10', ends_on: '2026-11-09', locked_at: null }),
    ],
  }));
  const s = await t.ctx.wuFinalStatement('c1');
  assert.equal(s.ok, true, s.error);
  assert.deepEqual(s.data.unlockedMonths, [1, 2]);
  assert.deepEqual(s.data.monthsPastLastDay, [2], 'month 2 runs past their last day');
  const warn = t.ctx.wuStmtWarn(s.data);
  assert.match(warn, /Month 1 has no final count yet/);
  assert.match(warn, /Month 2 runs past their last day and was left open on purpose/);
  assert.match(warn, /your decision/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   PART 4 — journey.js: the other guarantee
   ═══════════════════════════════════════════════════════════════════════════ */

test('a launch past day 14 says what it costs, not just that it is late', () => {
  /* "Not live within 14 days of kickoff → next month free" is a money promise,
     and the board said only "Launch 2 days overdue", which reads as a slipped
     task. Nothing in the database can mark a month free, so the least Aviance
     can do is say it where the owner is looking at the slip. */
  const ctx = { window: {}, console, document: { getElementById: () => null } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('core.js'), ctx, { filename: 'core.js' });
  vm.runInContext(read('journey.js'), ctx, { filename: 'journey.js' });

  const steps = ['kickoff', 'research', 'testing', 'build', 'onboarding', 'launch']
    .map((step, i) => ({ step, status: i < 5 ? 'done' : 'todo', planned_on: '2026-11-20' }));
  const late = ctx.jyNorm({ client_id: 'c1', company: 'Harbor Co', paid_on: '2026-11-06',
    launch_on: '2026-11-20', steps }, '2026-11-23');
  assert.equal(ctx.jyOwesFreeMonth(late), true);
  assert.match(ctx.jyFreeMonthWords(late), /Past day 14 by 3 days/);
  assert.match(ctx.jyFreeMonthWords(late), /next month free/);
  /* The words say what it costs; the button beside them is what applies it.
     Nothing grants a month of fee on a date comparison alone. */
  assert.match(ctx.jyFreeMonthButton(late), /Credit the free month/);
  assert.match(ctx.jyFreeMonthButton(late), /jyGiveFreeMonth/);
  const row = ctx.jyRenderBoardRow({ client_id: 'c1', company: 'Harbor Co', paid_on: '2026-11-06',
    launch_on: '2026-11-20', steps }, '2026-11-23');
  assert.match(strip(row), /next month free/);

  /* a client who IS live, or who has days to go, is told nothing of the sort */
  const live = ctx.jyNorm({ client_id: 'c1', company: 'Harbor Co', launch_on: '2026-11-20',
    steps: steps.map((s) => ({ ...s, status: 'done' })) }, '2026-11-23');
  assert.equal(ctx.jyOwesFreeMonth(live), false);
  assert.equal(ctx.jyFreeMonthWords(live), '');
  const early = ctx.jyNorm({ client_id: 'c1', company: 'Harbor Co', launch_on: '2026-12-10', steps }, '2026-11-23');
  assert.equal(ctx.jyOwesFreeMonth(early), false);
});
