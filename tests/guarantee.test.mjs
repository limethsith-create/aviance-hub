// The guarantee maths, and the money that hangs off it.
//
// A client is promised 5, 10 or 15 booked calls a month. Miss month one and the
// month's fee is refunded DOUBLE; miss any month after and that month is
// refunded in full. All of it is decided by five database rules:
//
//   qualified_calls.counts   generated: happened AND matched_icp AND no upheld dispute
//   recount_month(month)     how many of them fall inside the month
//   lock_month(month)        hit or missed, and the refund row
//   raise_invoice(month)     what is billed, and when
//   mark_paid(invoice)       what opens the portal and sends the welcome
//
// SQL cannot run under node, so these pin the properties by reading the
// migration that owns each rule — the convention tests/server-fixes.test.mjs
// set. Every assertion here was first checked against the live functions inside
// a transaction that was rolled back, so each one is a property that really
// holds (or, where marked, really did not).
//
// Two of them really did not, and are fixed in 20261208_guarantee_maths_fixes.sql:
//   * recount_month counted a month off qualified_calls.month_id, which is never
//     released, so a call that moved between months was counted in both.
//   * raise_invoice made a month-one invoice without is_first, which is the only
//     thing mark_paid opens the portal on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/* The two browser files that hold a copy of a money rule, loaded so the copy can
   be exercised rather than read. */
globalThis.window = globalThis;
globalThis.sb = { from() { throw new Error('no database in this test'); } };
for (const f of ['core.js', 'finance.js', 'digest.js', 'clientbook.js']) {
  vm.runInThisContext(read(f), { filename: f });
}
/** A migration with its comment lines dropped, so a rule can never be "proved" by a comment. */
const code = (p) => read('supabase/migrations/' + p).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

const MONTHS   = code('20261130_server_fixes.sql');     // recount_month, lock_month, the indexes
const FIXES    = code('20261208_guarantee_maths_fixes.sql');
const INVOICE  = code('20261129_no_pilot_and_agreement_v3.sql');  // raise_invoice as applied
const PAID     = code('20261124_rehearsal_fixes.sql');            // mark_paid as applied
const VERDICT  = code('20261207_showup.sql');                     // call_verdict
const README   = read('supabase/migrations/README.md');

/** The body of one `create or replace function public.<name>`, header to its closing tag.
    The files use both `$$` and `$function$` as the quote, so take whichever opened it. */
function fnBody(sql, name) {
  const re = new RegExp('create or replace function\\s+public\\.' + name
    + '\\s*\\([\\s\\S]*?\\sas\\s+(\\$\\w*\\$)[\\s\\S]*?\\1\\s*;', 'g');
  const all = [...sql.matchAll(re)].map((m) => m[0]);
  assert.ok(all.length >= 1, name + ' is not defined in that migration');
  return all[all.length - 1];   // the last definition in the file is the one that lands
}

/* ================================================================
   1. A call counts only if it matched the profile AND happened
   ================================================================ */

test('the rule for a call that counts is the database\'s, and is written down once', () => {
  // Checked live against the generated column: happened + matched_icp + no upheld
  // dispute -> true; drop any one of the three -> false; a REJECTED dispute still
  // counts; happened with no happened_at still reads counts = true.
  assert.match(README, /happened AND matched_icp AND dispute_status <> 'upheld'/,
    'the agreed rule must stay written down beside the schema');
  // counts is generated, so nothing may try to write it
  for (const f of ['finance.js', 'clientbook.js', 'digest.js', 'wrapup.js', 'portal-tracker.js']) {
    const js = read(f);
    assert.ok(!/(insert|update)\([^)]*\bcounts\s*:/.test(js),
      f + ' writes qualified_calls.counts, which the database generates');
  }
});

test('the browser\'s read of "does this call count" agrees with the database, column by column', () => {
  // digest.js keeps a fallback for a row that arrived without the generated column.
  // A fallback that is laxer than the database counts calls that will not be
  // refunded against, and the owner reads a month as safe when it is not.
  const row = (o) => ({ happened: true, matched_icp: true, dispute_status: 'none', ...o });
  assert.equal(dgCounts(row({ counts: true })), true, 'the column wins when it is there');
  assert.equal(dgCounts(row({ counts: false })), false, 'including when it says no');
  assert.equal(dgCounts(row({ counts: false, happened: true, matched_icp: true })), false,
    'the column is never second-guessed');
  // and the fallback, on each of the three conditions
  assert.equal(dgCounts(row({})), true);
  assert.equal(dgCounts(row({ happened: false })), false, 'a no-show does not count');
  assert.equal(dgCounts(row({ matched_icp: false })), false, 'off-profile does not count');
  assert.equal(dgCounts(row({ dispute_status: 'upheld' })), false, 'an upheld dispute does not count');
  assert.equal(dgCounts(row({ dispute_status: 'raised' })), true, 'a dispute not yet decided still counts');
  assert.equal(dgCounts(row({ dispute_status: 'rejected' })), true, 'a rejected dispute still counts');
  // nasty input
  assert.equal(dgCounts(null), false);
  assert.equal(dgCounts({}), false, 'a row with nothing on it counts for nothing');
  assert.equal(dgCounts(row({ happened: 0 })), false);
  // the one place the copy is laxer than the database: the database needs
  // matched_icp to be TRUE, the fallback needs it only to be "not false". The
  // column is NOT NULL, so this is only reachable by selecting without it — and
  // then the fallback must not invent a counting call.
  assert.equal(dgCounts({ happened: true, dispute_status: 'none' }), true,
    'known gap: a row read without matched_icp is treated as matching. If this '
    + 'ever becomes reachable with a nullable column, the fallback must tighten to === true');
});

test('the owner\'s forecast of what a short month would cost uses the database\'s own multiplier', () => {
  // clientbook.js works out "what would this cost us if it ended today". It is a
  // forecast, never written anywhere, but if its multiplier drifts from
  // lock_month's the owner plans against the wrong number.
  const client = { monthly_fee: 1500 };
  const m = (o) => ({ month_no: 1, calls_promised: 5, calls_delivered: 0, verdict: 'open', refund_due: 0, at_risk: null, ...o });
  assert.equal(cbStake(client, m({ month_no: 1 })), 3000, 'month one is double the fee, as lock_month has it');
  assert.equal(cbStake(client, m({ month_no: 2 })), 1500, 'every month after is that month in full');
  assert.equal(cbStake(client, m({ month_no: 7 })), 1500);
  assert.equal(cbStake(client, m({ calls_delivered: 5 })), 0, 'a month that is on track risks nothing');
  assert.equal(cbStake(client, m({ calls_delivered: 6 })), 0, 'nor one that is ahead');
  assert.equal(cbStake(client, m({ calls_delivered: 4 })), 3000, 'one call short is the whole double');
  assert.equal(cbStake(client, m({ verdict: 'missed', refund_due: 3000 })), 3000,
    'a settled month carries the refund the database raised, not a fresh guess');
  assert.equal(cbStake(client, m({ verdict: 'hit', calls_delivered: 0 })), 0,
    'and a settled hit owes nothing, whatever the counts say');
  assert.equal(cbStake(client, m({ at_risk: 2222 })), 2222, 'the view\'s own number wins when it has one');
  // nasty input
  assert.equal(cbStake(client, null), 0);
  assert.equal(cbStake(null, m({})), 0, 'a client with no fee risks nothing rather than NaN');
  assert.equal(cbStake({ monthly_fee: null }, m({})), 0);
  assert.equal(cbStake({ monthly_fee: -1500 }, m({})), -3000, 'a negative fee is arithmetic, not a crash');
  assert.equal(cbStake(client, m({ month_no: null })), 1500, 'an unknown month is not given the double');
  assert.equal(cbStake(client, m({ calls_promised: 0, calls_delivered: 0 })), 0,
    'a month that promised nothing cannot be short');
});

test('a call is never written as happened without the time it happened, so it can be put in a month', () => {
  // counts is true the moment happened is true, but recount_month places a call
  // by happened_at. A row with happened=true and happened_at=null counts towards
  // nothing at all — checked live: it lands in no month and no month sees it.
  const fin = read('finance.js');
  assert.match(fin, /happened_at:\s*c\.happened \? \(c\.happenedAt \|\| c\.bookedFor\) : null/,
    'fnLogCall must carry a time whenever it says a call happened');
  assert.match(fin, /update\(\{happened:true, happened_at: whenIso \|\| new Date\(\)\.toISOString\(\)\}\)/,
    'fnCallHappened must set happened_at in the same write as happened');
  assert.ok(!/update\(\{happened:\s*true\}\)/.test(fin), 'happened is never set on its own');
});

test('a no-show, and an upheld dispute, each take the call back off the month', () => {
  const verdict = fnBody(VERDICT, 'call_verdict');
  // happened goes to whatever the person said, and a no-show loses its time too,
  // so counts goes false and the recount drops it. Checked live: month goes 1 -> 0.
  assert.match(verdict, /set happened\s*=\s*p_showed/);
  assert.match(verdict, /happened_at\s*=\s*case when p_showed then coalesce\(q\.happened_at, q\.booked_for\) else null end/);
  // and an already-upheld dispute is refused rather than quietly overruled
  assert.match(verdict, /if q\.dispute_status = 'upheld' then\s*\n\s*raise exception/);
  // the recount is the database's, not call_verdict's own arithmetic
  assert.match(verdict, /perform public\.recount_month\(m\.id\)/);
  assert.ok(!/calls_delivered\s*=\s*calls_delivered\s*[+-]/.test(verdict),
    'call_verdict must never nudge the count itself');
});

test('"did they show up?" takes only yes or no — not silence, and not null', () => {
  const verdict = fnBody(VERDICT, 'call_verdict');
  assert.match(verdict, /if p_showed is null then\s*\n\s*raise exception/,
    'a null answer must be refused, not read as a no-show');
  assert.match(read('supabase/migrations/20261207_showup.sql'),
    /verdict_at is null until somebody answers|null means nobody has yet/,
    'an unanswered call is not the same thing as a no-show, and that must be written down');
});

/* ================================================================
   2. recount_month: the number, and the month boundary
   ================================================================ */

test('a locked month refuses to move, quietly or otherwise', () => {
  const recount = fnBody(FIXES, 'recount_month');
  // the guard comes BEFORE either write, and hands back what is stored
  const guard = recount.indexOf('m.locked_at is not null then return m.calls_delivered');
  assert.ok(guard > 0, 'recount_month must return the stored number for a locked month');
  assert.ok(guard < recount.indexOf('update public.qualified_calls'),
    'the locked check must come before anything is written');
  assert.ok(guard < recount.indexOf('update public.client_months'));

  const lock = fnBody(MONTHS, 'lock_month');
  assert.match(lock, /where id = p_month for update;/, 'lock_month must take the row lock first');
  assert.match(lock, /if m\.locked_at is not null then return m; end if;/,
    'a second lock hands back the month unchanged and raises no second refund');
  // checked live: lock twice -> one refunds row, and a call added after the lock
  // leaves calls_delivered where it was.
});

test('the day a call lands on is read in the house US zone, in every rule that reads it', () => {
  // A call at 11pm on the last day of the month, US Eastern, is already the 1st
  // in UTC. Casting in UTC pushed it into the next month or into none at all.
  // Checked live with day1_on = 2026-01-15: 2026-02-15T04:00Z (11pm ET, 14 Feb)
  // counts in month 1, and 2026-02-15T07:00Z (2am ET, 15 Feb) counts in month 2.
  for (const [where, sql, name] of [['the fix', FIXES, 'recount_month'], ['showup', VERDICT, 'call_verdict']]) {
    const body = fnBody(sql, name);
    assert.match(body, /coalesce\(\(select us_zone from public\.calendar_settings where id = 1\), 'America\/New_York'\)/,
      name + ' (' + where + ') must take the day from the calendar\'s own US zone');
    assert.match(body, /at time zone v_zone\)::date/,
      name + ' must turn a timestamp into a day in that zone, not in UTC');
  }
  const recount = fnBody(FIXES, 'recount_month');
  assert.ok(!/happened_at\)?::date/.test(recount.replace(/at time zone v_zone\)::date/g, '')),
    'no bare ::date on a timestamp: that is the UTC cast this replaced');
  assert.match(recount, /between m\.starts_on and m\.ends_on/,
    'the window is inclusive of both the first and the last day of the month');
});

test('day one is taken in the zone the months are counted in, not in UTC', () => {
  // day1_on anchors every month boundary for that client. Taken from
  // new Date().toISOString() it is the UTC day, so a client started after 7pm
  // Eastern gets a day1_on one day late and every boundary after it shifts.
  const ob = read('onboarding.js');
  assert.match(ob, /function obTodayUs\(\)/, 'onboarding must have a zone-aware day for day one');
  assert.match(ob, /const day1 = obTodayUs\(\);/, 'obStart must use it');
  assert.match(ob, /timeZone:\s*OB_MONTH_ZONE/, 'and work it out in the month zone');
  assert.match(ob, /OB_MONTH_ZONE\s*=\s*'America\/New_York'/,
    'which is the same zone calendar_settings.us_zone defaults to');
});

test('a month\'s number is the calls inside its window, not whatever still points at it', () => {
  // THIS TEST FAILED FIRST, and the failure was a real bug.
  //
  // recount_month counted `where q.month_id = m.id and q.counts`, and month_id is
  // only ever set, never released. A call that counted in month 1 and then moved
  // into month 2 was counted in BOTH, because recounting month 1 first found it
  // still pointing at month 1. Proven live: one call, month 1 delivered = 1 and
  // month 2 delivered = 1. Month 1 reads as a hit it did not earn and its double
  // refund is never raised.
  //
  // wrapup.js ends a client with .order('month_no') — oldest month first, which is
  // exactly the order that gets it wrong.
  const recount = fnBody(FIXES, 'recount_month');
  const count = recount.slice(recount.indexOf('select count(*) into d'));
  assert.ok(!/q\.month_id = m\.id/.test(count),
    'the count must not be taken off month_id, which no rule ever releases');
  assert.match(count, /q\.client_id = m\.client_id[\s\S]*q\.counts[\s\S]*at time zone v_zone\)::date between m\.starts_on and m\.ends_on/,
    'the count is this client\'s counting calls whose day falls inside this month');

  // and the old definition is the one this replaces, so the fix must land after it
  assert.match(fnBody(MONTHS, 'recount_month'), /where q\.month_id = m\.id and q\.counts/,
    'if the applied migration no longer has the bug, this fix migration can go');
});

test('ending a client recounts and locks every open month, and refuses to end on one left open', () => {
  const wu = read('wrapup.js');
  assert.match(wu, /const rc = await fnRecount\(m\.id\);/);
  assert.match(wu, /const lk = await fnLockMonth\(m\.id\);/);
  assert.match(wu, /if \(m\.locked_at\) continue;/, 'a locked month is left exactly as it is');
  assert.match(wu, /ending now would hide money we may owe them/,
    'a month with no final count must stop the ending, not be skipped');
});

/* ================================================================
   3. lock_month: the verdict and the refund
   ================================================================ */

test('hit and missed turn on the one comparison, the right way round', () => {
  const lock = fnBody(MONTHS, 'lock_month');
  assert.match(lock, /if m\.calls_delivered >= m\.calls_promised then/,
    'promised calls DELIVERED must be at least PROMISED to be a hit');
  // a flipped comparison is the whole bug, so pin which branch does what
  const hit = lock.slice(lock.indexOf('>= m.calls_promised'));
  const elseAt = hit.indexOf('else');
  assert.ok(hit.slice(0, elseAt).includes("verdict = 'hit'"), 'delivered >= promised is a hit');
  assert.ok(hit.slice(0, elseAt).includes('refund_due = 0'), 'a hit owes nothing');
  assert.ok(hit.slice(elseAt).includes("verdict = 'missed'"), 'anything less is missed');
  assert.ok(!/calls_promised >= m\.calls_delivered|> m\.calls_promised/.test(lock),
    'exactly 5 of 5 is a hit, not a miss');
  // checked live: starter, 0 of 5 -> missed; the refund row carries the shortfall in words
  assert.match(lock, /format\('Month %s: %s of %s calls delivered\.'/);
});

test('month one refunds DOUBLE, every month after refunds that month in full', () => {
  const lock = fnBody(MONTHS, 'lock_month');
  assert.match(lock, /if m\.month_no = 1 then mult := 2\.0; why := 'missed_month_one';/,
    'month one is the double');
  assert.match(lock, /else\s+mult := 1\.0; why := 'missed_month'; end if;/,
    'every month after is that month in full');
  assert.match(lock, /owed := round\(c\.monthly_fee \* mult\);/,
    'the amount is the fee times the multiplier, worked out in the database');
  assert.match(lock, /insert into public\.refunds \(client_id, month_id, amount, multiplier, reason, status, notes\)/);
  assert.match(lock, /'owed'/, 'a new refund starts owed, never paid');
  // checked live: starter ($1,500) month 1 -> refund_due 3000, multiplier 2.0,
  // reason missed_month_one; month 2 -> 1500, 1.0, missed_month.
});

test('the same missed month can never be refunded twice', () => {
  assert.match(MONTHS, /create unique index if not exists refunds_one_per_missed_month\s*\n\s*on public\.refunds \(month_id\)\s*\n\s*where month_id is not null and reason in \('missed_month_one', 'missed_month'\)/,
    'the table, not the function, is what makes a second refund impossible');
  // and the function cannot reach the insert twice anyway
  const lock = fnBody(MONTHS, 'lock_month');
  assert.ok(lock.indexOf('for update') < lock.indexOf('locked_at is not null then return m'),
    'the row is locked before the locked check, so two clicks at once cannot both pass it');
  // checked live: lock_month twice -> exactly one refunds row.
});

test('no screen decides a verdict, and no screen writes a refund amount', () => {
  for (const f of ['finance.js', 'wrapup.js', 'digest.js', 'clientbook.js', 'portal-tracker.js']) {
    const js = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/(insert|update)\([^)]*verdict\s*:/.test(js), f + ' must not write a verdict');
    assert.ok(!/(insert|update)\([^)]*refund_due\s*:/.test(js), f + ' must not write refund_due');
    assert.ok(!/(insert|update)\([^)]*\bamount\s*:/.test(js) || f !== 'wrapup.js',
      f + ' must not write a refund amount');
    assert.ok(!/from\('refunds'\)[\s\S]{0,200}insert\(/.test(js), f + ' must not raise a refund row itself');
  }
  // the only write to refunds anywhere in the browser is marking one paid
  const fin = read('finance.js');
  const refundWrites = [...fin.matchAll(/from\('refunds'\)\s*\n?\s*\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(refundWrites)].sort(), ['select', 'update']);
  /* What the browser may write on a refunds row: that it was paid, when, how, and
     what was actually sent back. What it may NEVER write is the figure the
     guarantee raised — `amount`, `multiplier` and `reason` are lock_month's, and
     a browser that could change them could change the promise. The amount the
     owner actually transferred (`paid_amount`) is a different number: it is a
     fact about a bank transfer, it is checked against `amount` and refused if it
     is bigger, and the real write goes through refund_pay() in the database. */
  const refundUpdate = /from\('refunds'\)\.update\(\{([\s\S]*?)\}\)/.exec(fin.replace(/\s*\n\s*/g, ''));
  assert.ok(refundUpdate, 'the refunds update is still one object literal');
  for (const banned of ['amount:', 'multiplier:', 'reason:', 'month_id:', 'client_id:']) {
    assert.ok(refundUpdate[1].indexOf(banned) < 0, 'the browser must not write refunds.' + banned.replace(':', ''));
  }
  assert.match(fin, /sb\.rpc\('refund_pay'/, 'paying a refund goes to the database rule first');
});

/* ================================================================
   4. Money: raise_invoice and mark_paid
   ================================================================ */

test('a 3-month term bills months 1, 4 and 7 and nothing in between', () => {
  for (const [where, sql] of [['applied', INVOICE], ['the fix', FIXES]]) {
    const r = fnBody(sql, 'raise_invoice');
    assert.match(r, /if c\.term = '3month' then\s*\n\s*if \(m\.month_no - 1\) % 3 <> 0 then\s*\n\s*return null;/,
      where + ': months 2, 3, 5, 6 raise no invoice at all');
    assert.match(r, /covers := 3;/, where + ': the invoice covers three months');
    assert.match(r, /gross := c\.monthly_fee \* covers;/, where + ': three months of the monthly fee');
    assert.match(r, /format\('Months %s-%s, 3-month term\.', m\.month_no, m\.month_no \+ 2\)/,
      where + ': and says which three');
  }
  // checked live on a 3-month Growth client ($2,400): months 1, 4, 7 each raise one
  // $7,200 invoice; months 2, 3, 5, 6, 8 raise none; three invoices in all.
});

test('a month that already has an invoice is handed the one it has, never a second', () => {
  for (const [where, sql] of [['applied', INVOICE], ['the fix', FIXES]]) {
    const r = fnBody(sql, 'raise_invoice');
    const guard = r.indexOf('select * into inv from public.invoices where month_id = p_month limit 1');
    assert.ok(guard > 0, where + ': raise_invoice must look for the month\'s invoice first');
    assert.ok(r.slice(guard).startsWith('select * into inv from public.invoices where month_id = p_month limit 1;\n  if found then return inv; end if;'),
      where + ': and return it before anything is inserted');
    assert.ok(guard < r.indexOf('insert into public.invoices'));
  }
  assert.match(MONTHS, /create unique index if not exists invoices_one_per_month\s*\n\s*on public\.invoices \(month_id\)\s*\n\s*where month_id is not null and status <> 'void'/,
    'and the table refuses a second live invoice for a month, whatever the code does');
});

test('an invoice number is never reused and never collides', () => {
  for (const [where, sql] of [['applied', INVOICE], ['the fix', FIXES]]) {
    assert.match(fnBody(sql, 'raise_invoice'),
      /'AV-' \|\| to_char\(now\(\),'YYYY'\) \|\| '-' \|\| nextval\('public\.invoice_no_seq'\)/,
      where + ': the number comes off a sequence, which never hands out the same value twice');
  }
  assert.ok(!/setval\(\s*'public\.invoice_no_seq'/.test(FIXES + MONTHS),
    'neither the fix nor the month rules may wind the invoice sequence back');

  // The one place that does wind it back is documents_preview, which raises
  // specimen invoices inside a subtransaction it then rolls back, so a preview
  // does not burn real numbers. A sequence is not rolled back by the rollback, so
  // it has to be put back by hand — and it must never be put back BELOW a number
  // already on a real invoice.
  const prev = fnBody(INVOICE, 'documents_preview');
  const setvals = [...prev.matchAll(/setval\('public\.invoice_no_seq', ([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(setvals, ['v_seq'], 'exactly one reset, of the one sequence');
  assert.match(prev, /select greatest\(v_seq, coalesce\(max\(nullif\(regexp_replace\(number, '\^\.\*-', ''\), ''\)::bigint\), 0\)\) into v_seq\s*\n\s*from public\.invoices where number ~ '-\[0-9\]\+\$';/,
    'the reset must take the greatest of where it started and the highest number a real invoice holds, '
    + 'so a preview can never hand a used number out again');
  const resetAt = prev.lastIndexOf('setval(');
  assert.ok(prev.lastIndexOf('select greatest(v_seq') < resetAt, 'and work that out before resetting');
  // checked live: invoices.number carries a unique index (invoices_number_key), so
  // even a reused number is refused by the table rather than quietly duplicated;
  // consecutive raises gave AV-2026-1022, -1023, -1024.
});

test('a client left on a plan that is no longer offered is refused, not priced as something else', () => {
  for (const [where, sql] of [['applied', INVOICE], ['the fix', FIXES]]) {
    const r = fnBody(sql, 'raise_invoice');
    assert.match(r, /if c\.plan not in \('starter','growth','scale'\) then\s*\n\s*raise exception 'That plan is no longer offered\./,
      where + ': an unknown or retired plan code raises, in plain words');
    assert.ok(r.indexOf('not in (\'starter\',\'growth\',\'scale\')') < r.indexOf('insert into public.invoices'),
      where + ': and is refused before anything is billed');
  }
});

test('the month-one invoice is marked as the first one, which is what opens the portal', () => {
  // THIS TEST FAILED FIRST, and the failure was a real bug.
  //
  // raise_invoice inserted a month-one invoice without is_first, so it defaulted
  // to false, and mark_paid opens the portal and sends the welcome only
  // `if inv.is_first`. Proven live on a fresh 3-month client whose month one was
  // opened by the day1_on trigger: AV-2026-1022, is_first = false. The client pays
  // and gets no portal, no welcome and no stage change — nothing at all.
  //
  // Today close_won always makes the is_first invoice first and raise_invoice
  // adopts it (live: both month-one invoices are is_first), so no row is wrong
  // yet. Void that invoice, or set a client up by hand, and the first payment
  // goes silent.
  const fixed = fnBody(FIXES, 'raise_invoice');
  assert.match(fixed, /issued_on, due_on, status, notes, is_first\)/,
    'the insert must set is_first');
  assert.match(fixed, /\(m\.month_no = 1\)\)/, 'and set it to whether this is month one');

  // the adoption path, which is what keeps today\'s rows right, must stay
  for (const [where, sql] of [['applied', INVOICE], ['the fix', FIXES]]) {
    assert.match(fnBody(sql, 'raise_invoice'),
      /where client_id = c\.id and is_first and month_id is null and status <> 'void' limit 1/,
      where + ': month one adopts the invoice close_won already sent');
  }
  // and the applied version is the one with the bug, so the fix is still needed
  assert.ok(!/status, notes, is_first\)/.test(fnBody(INVOICE, 'raise_invoice')),
    'if the applied raise_invoice now sets is_first, this fix migration can go');
});

test('raise_invoice pins its search_path, because a definer trigger calls it', () => {
  // client_first_month() is SECURITY DEFINER and calls raise_invoice. Unpinned,
  // raise_invoice runs under whatever search_path the caller brought.
  assert.match(fnBody(FIXES, 'raise_invoice'), /set search_path = public/);
  assert.match(read('supabase/migrations/20261208_guarantee_maths_fixes.sql'),
    /client_first_month\(\), which is\s*\n?--?\s*SECURITY DEFINER|SECURITY DEFINER/,
    'and says why');
});

test('being paid goes through the one rule, and that rule is the owner\'s alone', () => {
  const paid = fnBody(PAID, 'mark_paid');
  assert.match(paid, /if not public\.is_admin\(\) then raise exception 'Only the owner can mark an invoice paid\.'/);
  assert.match(paid, /where id = p_invoice for update;/, 'the invoice row is locked for the call');
  assert.match(paid, /if inv\.status = 'paid' then raise exception 'That invoice is already marked paid\.'/,
    'paying twice is refused in words, so no second welcome can go');
  assert.match(paid, /if inv\.status = 'void' then raise exception 'That invoice was cancelled, so it cannot be paid\.'/,
    'a cancelled invoice cannot be paid');
  // the browser must not write the table instead
  const fin = read('finance.js');
  assert.match(fin, /sb\.rpc\('mark_paid', \{p_invoice: invoiceId, p_via: how \|\| null\}\)/);
  assert.ok(!/from\('invoices'\)[\s\S]{0,120}update\(\{status:\s*'paid'/.test(fin),
    'finance.js must never set an invoice to paid itself');
});

test('the welcome and the portal go once, off the first invoice, and never twice', () => {
  const paid = fnBody(PAID, 'mark_paid');
  assert.match(paid, /if inv\.is_first and not exists \(select 1 from public\.portal_invites where client_id = c\.id and status in \('pending','accepted'\)\) then/,
    'one gate: the first invoice, and no invite already out');
  assert.match(paid, /insert into public\.portal_invites\(client_id, person_id, email, token_hash\)/,
    'the invite is stored as a hash, never as the link');
  assert.match(paid, /public\.invite_hash\(raw\)/);
  assert.ok(!/insert into public\.portal_invites[\s\S]{0,200}values[^)]*raw[,)]/.test(paid),
    'the raw token must not be written to the table');
  assert.match(paid, /raw := encode\(extensions\.gen_random_bytes\(24\), 'hex'\)/,
    '24 random bytes: a link nobody can guess');
  assert.match(paid, /'welcome_sent'/, 'and it is written down that it went');
  assert.match(paid, /update public\.clients set stage = 'onboarding' where id = c\.id and stage = 'won'/,
    'the stage only moves on from won, so a later stage is never dragged back');
});

test('what the person is told after clicking Paid matches what the rule did', () => {
  const fin = read('finance.js');
  assert.match(fin, /data\.welcome_sent === true/, 'the words come off the rule\'s own answer');
  assert.match(fin, /The welcome email and their way in are on their way\./);
  assert.match(fin, /'Marked paid\.'/, 'and a later invoice says only that');
});

/* ================================================================
   5. The document links the client is sent
   ================================================================ */

test('a document link is signed, bound to its kind, and cannot be guessed or bent to another', () => {
  // Checked live: doc_token('a', id) and doc_token('i', id) are different tokens
  // for the same id; doc_id(token,'a') gives the id back and doc_id(token,'i')
  // gives null; a forged signature, a token with two parts, junk and null all
  // give null; the signature is 64 hex characters of HMAC-SHA256.
  const docs = code('20261124_close_to_onboarded_core.sql') + code('20261124_rehearsal_fixes.sql');
  assert.match(docs, /extensions\.hmac\(p_kind \|\| ':' \|\| p_id::text,/,
    'the signature covers the kind AND the id, so one document\'s link never opens another');
  assert.match(docs, /decrypted_secret from vault\.decrypted_secrets where name = 'aviance_doc_key'/,
    'the key lives in the vault, never in the repo');
  assert.match(docs, /if array_length\(parts,1\) <> 3 or parts\[1\] <> p_kind then return null; end if;/,
    'a token that is not three parts of the right kind is refused without a lookup');
  assert.match(docs, /begin v := parts\[2\]::uuid; exception when others then return null; end;/,
    'junk where the id should be answers null rather than raising');
  assert.match(docs, /if public\.doc_token\(p_kind, v\) = p_token then return v; end if;\s*\n\s*return null;/,
    'the token must re-sign to itself, and anything else is refused');
  // and no key of any kind is in the repo
  for (const f of ['20261124_close_to_onboarded_core.sql', '20261208_guarantee_maths_fixes.sql']) {
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(read('supabase/migrations/' + f)), f);
  }
});

test('a link that is not valid says so in one sentence, on every kind of document', () => {
  const docs = code('20261124_close_to_onboarded_core.sql') + code('20261124_rehearsal_fixes.sql');
  assert.match(docs, /raise exception 'This link is not valid\.'/);
  assert.match(docs, /raise exception 'This agreement has already been signed\.'/,
    'a second click on a signing link says it is already signed, not that it is broken');
  assert.match(docs, /where id = v and status = 'sent'/,
    'signing is single use: only an agreement still out can be signed');
});

test('an invite link is single use, expires, and a second click is told which', () => {
  const seats = code('20261207_seats.sql');
  const consume = fnBody(seats, 'portal_invite_consume');
  // the claim is one statement: the row is moved from pending to accepted and
  // handed back in the same breath, so two clicks cannot both win it
  assert.match(consume, /update public\.portal_invites set status = 'accepted', accepted_at = now\(\), accepted_user = p_user\s*\n\s*where token_hash = public\.invite_hash\(p_token\) and status = 'pending' and expires_at > now\(\)\s*\n\s*returning \* into i;/,
    'the invite must be claimed by one conditional update, not read then written');
  assert.match(consume, /if not found then raise exception 'This link has already been used or has expired\.'/,
    'and a second click is told so in words');
  // the token itself is never stored, only its hash
  assert.ok(!/portal_invites[\s\S]{0,400}\bset\b[^;]*\btoken\b\s*=/.test(consume),
    'the raw token is never written back');
  assert.match(consume, /token_hash = public\.invite_hash\(p_token\)/,
    'a link is found by hashing what was clicked, so the table holds nothing usable');
  // checked live: portal_invites.expires_at defaults to now() + 14 days and is NOT
  // NULL, so no invite can be made that never expires; token_hash carries a unique
  // index, so no two invites can share a link.
  assert.match(seats, /for update;/, 'and the client row is locked before any seat is counted');

  // invite_peek, which join.html asks before a password is typed, must answer with
  // the reason and never with a seat it cannot give
  const peek = fnBody(seats, 'invite_peek');
  assert.match(peek, /if not found or i\.status = 'revoked' then return jsonb_build_object\('ok', false, 'reason', 'invalid'\)/);
  assert.match(peek, /if i\.status = 'accepted' then return jsonb_build_object\('ok', false, 'reason', 'used'\)/);
  assert.match(peek, /if i\.status = 'expired' or i\.expires_at <= now\(\) then return jsonb_build_object\('ok', false, 'reason', 'expired'\)/);
  assert.ok(peek.indexOf("'reason', 'invalid'") < peek.indexOf("'reason', 'used'"),
    'a revoked link is invalid before it is anything else');
});

test('nothing may ever hand a client a direct read of the money tables', () => {
  // Checked live: clients, client_people, client_months, qualified_calls and
  // portal_invites are readable only by is_approved(); invoices and refunds only
  // by is_admin(). There is no policy for a signed-in client at all, and RLS
  // denies by default, so a client reads ZERO rows from every one of them and
  // sees their own figures only through the portal's definer functions.
  //
  // This is the regression guard: a migration in this repo must not add a policy
  // to one of those tables whose test is anything other than the team's.
  const money = ['clients', 'client_people', 'client_months', 'qualified_calls',
    'invoices', 'refunds', 'portal_invites'];
  const files = ['20261124_close_to_onboarded_core.sql', '20261124_rehearsal_fixes.sql',
    '20261129_no_pilot_and_agreement_v3.sql', '20261130_server_fixes.sql',
    '20261207_seats.sql', '20261207_showup.sql', '20261208_guarantee_maths_fixes.sql'];
  for (const f of files) {
    const sql = code(f);
    for (const m of [...sql.matchAll(/create policy\s+"?([^"\n]+?)"?\s+on\s+public\.(\w+)([\s\S]*?);/g)]) {
      if (!money.includes(m[2])) continue;
      assert.match(m[3], /is_admin\(\)|is_approved\(\)/,
        f + ': policy "' + m[1] + '" on ' + m[2] + ' must be the team\'s test, not a client\'s');
      assert.ok(!/auth\.uid\(\)\s*=\s*\w*user_id/.test(m[3]),
        f + ': policy "' + m[1] + '" on ' + m[2] + ' would let a signed-in client read the table directly');
    }
  }
  // The portal reads what it can through definer functions. portal-tracker.js does
  // keep a fallback that reads two of these tables directly, for a database where
  // the rpc is not deployed yet; today RLS hands it nothing, which is why it ends
  // in an empty state rather than another client's rows. It stays safe only while
  // every one of those reads is narrowed to the signed-in client AND the rows are
  // filtered again on the way back.
  const pt = read('portal-tracker.js');
  const direct = [...pt.matchAll(/pctRows\(\s*(?:ctx && ctx\.sb|sb)\s*,\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(direct.length >= 2, 'expected the fallback reads to be found');
  for (const t of direct) {
    assert.ok(!['invoices', 'refunds', 'clients', 'client_people', 'portal_invites'].includes(t),
      'portal-tracker.js reads ' + t + ' directly, and no client may ever reach that table');
  }
  assert.match(pt, /let q = sb\.from\(table\)\.select\(cols\)\.eq\('client_id', clientId\);/,
    'every direct read is narrowed to the signed-in client, in the one place that makes them');
  // With no client id, no query may go out — otherwise the read is unnarrowed and
  // RLS is the only thing standing between a client and the whole table. It used to
  // return [] here, which was safe but dishonest: the tabs drew "nothing yet" and a
  // client whose month was running read "Not started" beside their guarantee. It now
  // throws, so the failure is reported. Either way the database is never asked.
  assert.match(pt, /if \(!clientId\) throw new Error\(/,
    'with no client id it must refuse, so no unnarrowed read can ever be made');
  assert.ok(!/if \(!clientId\) return \[\]/.test(pt),
    'and it must not go back to answering "nothing" for "we do not know who you are"');
  assert.match(pt, /const mine = pctMine\(rows, clientId\)/,
    'and the rows are filtered again on the way back');
  // portal-client.js reads one table, and it is not one of these
  const pcTables = [...read('portal-client.js').matchAll(/\.from\('(\w+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(pcTables)].sort(), ['channel_messages']);
});

/* ================================================================
   6. The fix migration itself
   ================================================================ */

test('the fix migration can be run twice, writes no data and carries no key', () => {
  const raw = read('supabase/migrations/20261208_guarantee_maths_fixes.sql');
  assert.ok(!/create (unique )?index (?!if not exists)/.test(FIXES), 'indexes use if not exists');
  assert.ok(!/add column (?!if not exists)/.test(FIXES), 'columns use if not exists');
  assert.ok(!/create trigger/.test(FIXES), 'no trigger is made here');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(raw), 'no JWT in the file');
  // the only writes are inside the two function bodies, to the two tables they own
  const writes = [...FIXES.matchAll(/\b(insert into|update|delete from)\s+public\.(\w+)/g)].map((m) => m[2]);
  assert.deepEqual([...new Set(writes)].sort(), ['client_months', 'invoices', 'qualified_calls']);
  assert.ok(!/delete from/.test(FIXES), 'nothing is deleted');
  // and it redefines only the two functions it says it does
  const made = [...FIXES.matchAll(/create or replace function\s+public\.(\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(made, ['raise_invoice', 'recount_month']);
});

test('every database rule the money screens call is written down in a migration', () => {
  // A screen that calls an rpc nobody wrote shows a Postgres error to the owner.
  const sql = ['20261124_close_to_onboarded_core.sql', '20261124_rehearsal_fixes.sql',
    '20261129_no_pilot_and_agreement_v3.sql', '20261130_server_fixes.sql',
    '20261207_showup.sql', '20261207_seats.sql', '20261208_guarantee_maths_fixes.sql',
    '20261127_refunds_paid_NOT_APPLIED.sql']
    .map((f) => read('supabase/migrations/' + f)).join('\n');
  const js = ['finance.js', 'wrapup.js', 'onboarding.js'].map(read).join('\n');
  const called = [...js.matchAll(/sb\.rpc\('(\w+)'/g)].map((m) => m[1]);
  assert.ok(called.length >= 5, 'expected the money rpcs to be found');
  for (const name of new Set(called)) {
    assert.match(sql, new RegExp('function\\s+public\\.' + name + '\\s*\\('), name + ' is called but never defined');
  }
});
