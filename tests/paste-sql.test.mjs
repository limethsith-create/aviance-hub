/* ===================== ROUND 3 — the SQL the owner pastes =====================
   AVIANCE-run-this.sql is assembled from nine migrations in this folder (and
   one file outside the repo). In round 3 the live `public` schema was rebuilt
   on a local Postgres and that file was run on it, twice, and then attacked as
   an owner, an employee, a client and a stranger. Every fix that came out of
   that is pinned here, by the text of the migration it was made in — the
   database itself is not reachable from a test.

   What each test guards is written as what a person would have hit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = (f) => fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8');
/* comments dropped, so nothing here can be "proved" by a comment */
const code = (f) => raw(f).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

/* the nine files of this repo that go into the paste file, in paste order */
const PASTED = [
  '20261209_lost_booking_releases_its_slot_for_real.sql',
  '20261209_recount_never_moves_a_locked_month.sql',
  '20261207_prospect_access.sql',
  '20261207_calendar_connect.sql',
  '20261209_month_end_engine.sql',
  '20261209_refunds_paid.sql',
  '20261207_outreach_sync.sql',
  '20261209_commitment.sql',
];

function fnBody(sql, name) {
  const re = new RegExp('create or replace function\\s+public\\.' + name
    + '\\s*\\([\\s\\S]*?\\sas\\s+(\\$\\w*\\$)[\\s\\S]*?\\1\\s*;', 'g');
  const all = [...sql.matchAll(re)].map((m) => m[0]);
  assert.ok(all.length >= 1, name + ' is not defined in that migration');
  return all[all.length - 1];
}

/* ═══════════════ 1. it has to run twice ═══════════════ */

test('every part can be run a second time: nothing is created without first being dropped or guarded', () => {
  /* The repo's calendar_connect.sql made six policies with no drop before them.
     Run twice on the local copy it stopped at the first one — "policy already
     exists" — and, because the SQL editor sends a file as one request, took
     the whole paste file down with it. */
  for (const f of PASTED) {
    const sql = code(f);
    for (const m of sql.matchAll(/create policy\s+("[^"]+"|\w+)\s+on\s+(public\.\w+)/g)) {
      const drop = 'drop policy if exists ' + m[1] + ' on ' + m[2];
      const at = sql.indexOf(drop);
      assert.ok(at >= 0 && at < m.index, f + ': `' + m[0] + '` has no `' + drop + '` before it');
    }
    for (const m of sql.matchAll(/create trigger\s+(\w+)\s+(?:after|before)[\s\S]*?on\s+(public\.\w+)/g)) {
      const drop = 'drop trigger if exists ' + m[1] + ' on ' + m[2];
      const at = sql.indexOf(drop);
      assert.ok(at >= 0 && at < m.index, f + ': trigger ' + m[1] + ' is not dropped before it is made');
    }
    for (const m of sql.matchAll(/create (unique )?index\s+(?!if not exists)(\w+)/g)) {
      assert.match(sql, new RegExp('drop index if exists (public\\.)?' + m[2]),
        f + ': index ' + m[2] + ' is neither `if not exists` nor dropped first');
    }
    assert.equal(/create table\s+(?!if not exists)/.test(sql), false, f + ': a table is created without `if not exists`');
    assert.equal(/\bcreate (function|view)\b/.test(sql), false, f + ': a function or view is created without `or replace`');
    assert.equal(/add column\s+(?!if not exists)/.test(sql), false, f + ': a column is added without `if not exists`');
  }
});

/* ═══════════════ 2. the month-end engine ═══════════════ */

const ENGINE = code('20261209_month_end_engine.sql');
const SWEEP = fnBody(ENGINE, 'month_end_close');

test('a client signed in to the portal cannot read the month-end list', () => {
  /* Without security_invoker the view ran as its owner, past row security, and
     Supabase grants every new view to every signed-in user. On the local copy a
     portal user of one client read the other client's name, fee and refund. */
  assert.match(ENGINE, /create or replace view public\.v_months_to_close\s+with \(security_invoker = true\) as/);
});

test('a client signed in to the portal cannot run the month-end job, or read its answer', () => {
  /* It is security definer and granted to `authenticated`. Called by a portal
     user it ran the sweep and handed back every held client's name and why. */
  const guard = SWEEP.indexOf("if auth.uid() is not null and not public.is_admin() then");
  const lock = SWEEP.indexOf('pg_try_advisory_xact_lock');
  const read = SWEEP.indexOf('from public.v_months_to_close');
  assert.ok(guard > 0, 'the sweep must refuse a signed-in user who is not the owner');
  assert.ok(guard < lock && guard < read, 'and refuse before it takes the lock or reads a single month');
  assert.match(SWEEP, /raise exception 'Only the owner can run the month-end close\.'/);
  /* the cron job and the service role carry no user id; they must still pass */
  assert.equal(/if not public\.is_admin\(\) then/.test(SWEEP), false,
    'a bare is_admin() test would lock the cron job out of its own function');
});

test('the task for a month that cannot close quotes the count that decides, not the stale one', () => {
  /* A held month is never recounted, so client_months.calls_delivered can say
     0 on a month with 2 held calls. The task said "0 of 5 calls delivered". */
  const hold = SWEEP.slice(SWEEP.indexOf('cannot close'), SWEEP.indexOf('continue;'));
  assert.match(hold, /r\.delivered_counted, r\.calls_promised,/);
  assert.equal(/r\.calls_delivered/.test(hold), false);
});

test('a held call added to, or deleted from, a LOCKED month is recorded too', () => {
  /* The round-2 trigger sees an UPDATE. On the local copy one insert and one
     delete inside a locked month left client_events untouched. */
  const fn = fnBody(ENGINE, 'trg_locked_month_call_added_or_removed');
  assert.match(ENGINE, /create trigger qualified_calls_locked_month_rows\s*\n\s*after insert or delete on public\.qualified_calls/);
  assert.match(fn, /if tg_op = 'DELETE' then q := old; else q := new; end if;/);
  assert.match(fn, /if not coalesce\(q\.counts, false\) then return null; end if;/, 'only a call that counts can unsupport the number');
  assert.match(fn, /if m\.id is null or m\.locked_at is null then return null; end if;/, 'and only in a locked month');
  assert.match(fn, /'guarantee', 'locked_month_touched'/);
  assert.match(fn, /no longer matches its calls/);
  /* deleting a client cascades to its calls: that must not be stopped by this */
  assert.match(fn, /if not exists \(select 1 from public\.clients where id = q\.client_id\) then return null; end if;/);
  /* it records; it never re-opens a month or moves money */
  assert.equal(/update public\.client_months|update public\.refunds|insert into public\.refunds/.test(fn), false);
});

test('a refund that is raised is not called "refunded" before it is sent', () => {
  assert.equal(/with \$%s refunded/.test(ENGINE), false);
  assert.match(fnBody(ENGINE, 'trg_locked_month_touched'), /and a refund of \$%s raised/);
});

/* ═══════════════ 3. refunds ═══════════════ */

const REFUNDS = code('20261209_refunds_paid.sql');
const PAY = fnBody(REFUNDS, 'refund_pay');

test('the rest of a part-paid refund can still be paid', () => {
  /* Paying $1,000 of $3,000 marked the row paid, wrote "$2,000 of it is still
     owed", and then refused the $2,000 for ever: "already marked paid". */
  assert.match(PAY, /v_before := case when r\.status = 'paid' then coalesce\(r\.paid_amount, r\.amount\) else 0 end;/);
  assert.match(PAY, /v_left\s+:= r\.amount - v_before;/);
  assert.match(PAY, /if r\.status = 'paid' and v_left <= 0 then raise exception 'That refund is already marked paid\.'/);
  assert.equal(/if r\.status = 'paid'\s+then raise exception/.test(PAY), false, 'a paid status alone must not refuse a payment');
  assert.match(PAY, /paid_amount = v_before \+ v_amount/, 'the second transfer adds to the first');
  assert.match(PAY, /if v_amount > v_left then/, 'and "more than we owe" is measured against what is left');
  assert.match(PAY, /concat_ws\(', ', nullif\(r\.paid_reference, ''\), nullif\(v_ref, ''\)\)/, 'both references are kept');
  assert.match(PAY, /left\(concat_ws[\s\S]*?, 120\)/, 'inside the 120 characters the column allows');
});

test('refund_pay does the sums a person would expect', () => {
  /* the same arithmetic, run: amount 3000; send 1000, then 2500 (refused), then 2000, then 1 (refused) */
  const pay = (r, amount) => {
    const before = r.status === 'paid' ? (r.paid_amount == null ? r.amount : r.paid_amount) : 0;
    const left = r.amount - before;
    if (r.status === 'paid' && left <= 0) return 'already';
    const v = amount == null ? left : amount;
    if (v <= 0) return 'how much';
    if (v > left) return 'more than we owe ' + left;
    r.status = 'paid'; r.paid_amount = before + v;
    return 'ok';
  };
  const r = { status: 'owed', amount: 3000, paid_amount: null };
  assert.equal(pay(r, 3500), 'more than we owe 3000');
  assert.equal(pay(r, 1000), 'ok');
  assert.equal(r.paid_amount, 1000);
  assert.equal(pay(r, 2500), 'more than we owe 2000');
  assert.equal(pay(r, null), 'ok', 'no amount given means "the rest"');
  assert.equal(r.paid_amount, 3000);
  assert.equal(pay(r, 1), 'already');
  /* a refund paid before the column existed is paid in full */
  assert.equal(pay({ status: 'paid', amount: 1500, paid_amount: null }, 100), 'already');
});

test('v_money_back still counts the unpaid rest of a part-paid refund as owed', () => {
  /* It summed only status = 'owed', so the $2,000 above vanished from the view
     the moment the first $1,000 went. */
  const view = REFUNDS.slice(REFUNDS.indexOf('create or replace view public.v_money_back'));
  assert.match(view, /when status = 'paid' then greatest\(amount - coalesce\(paid_amount, amount\), 0\)/);
  assert.match(view, /with \(security_invoker = true\)/, 'and it stays behind the reader\'s own row rules');
});

test('the refunds index has a name the live database is not already using', () => {
  /* `create index if not exists refunds_owed_idx` — live already has an index
     of that name on (status) alone, so the statement was skipped silently. */
  assert.equal(/create index if not exists refunds_owed_idx\b/.test(REFUNDS), false);
  assert.match(REFUNDS, /create index if not exists refunds_owed_created_idx on public\.refunds \(status, created_at\)/);
});

/* ═══════════════ 4. the gateway key ═══════════════ */

const SYNC = code('20261207_outreach_sync.sql');

test('the outreach job is scheduled with the whole key or not at all', () => {
  /* The pattern stopped at the first character it did not know. A key with a
     + or a / in it was cut short, the job was scheduled with the stump, said
     "scheduled", and failed with a 401 every fifteen minutes. */
  assert.match(SYNC, /regexp_match\(j\.command, 'Bearer\\s\+\(\[A-Za-z0-9\._\\-\]\+\)\(\?=\[''"\]\)'\)/,
    'the key must run right up to its closing quote');
  assert.match(SYNC, /could not be read whole out of its command/);
  assert.match(SYNC, /there is no aviance-mail-tick job/);
  const nulls = SYNC.indexOf('if v_auth is null then');
  assert.ok(nulls > 0 && nulls < SYNC.indexOf('cron.schedule('), 'no key, no schedule');
});

test('the key is never printed: no notice and no exception carries it', () => {
  for (const m of SYNC.matchAll(/raise\s+(notice|exception|warning|info|log)\s+'[^']*'([^;]*);/g)) {
    assert.equal(/v_auth|v_cmd/.test(m[2]), false, 'a RAISE is given the key or the command: ' + m[0].slice(0, 80));
    assert.equal(/%/.test(m[0].replace(/%%/g, '')), false, 'a RAISE with a placeholder could carry the key');
  }
  assert.equal(/returning|select v_auth|select v_cmd/.test(SYNC.slice(SYNC.indexOf('do $$'))), false);
  assert.ok(!/eyJ[A-Za-z0-9_-]{20}/.test(raw('20261207_outreach_sync.sql')), 'that looks like a key in the file');
});

/* ═══════════════ 5. the commitment board ═══════════════ */

test('the commitment views obey the reader\'s own row rules, and so does the optional block', () => {
  const sql = code('20261209_commitment.sql');
  for (const v of ['v_commitment_months', 'v_commitment_now', 'v_commitment_to_close']) {
    assert.match(sql, new RegExp('create or replace view ' + v + '\\s+with \\(security_invoker = true\\) as'), v);
  }
  /* The commented-out "uncomment to apply" block re-made v_month_standing with
     no security_invoker, which takes the live one off. Run on the local copy, a
     portal user then read every client's months. The block must carry it. */
  const all = raw('20261209_commitment.sql');
  const at = all.indexOf('-- create or replace view v_month_standing');
  assert.ok(at > 0, 'the optional block is still there');
  assert.match(all.slice(at, at + 120), /-- create or replace view v_month_standing\n-- with \(security_invoker = true\) as/);
  assert.equal(/create or replace view (public\.)?v_month_standing as/.test(all), false,
    'v_month_standing must never be re-made without security_invoker');
});
