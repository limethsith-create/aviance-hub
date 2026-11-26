/* Tests for portal seats — the rule that Starter gets 2 logins, Growth 4 and
   Scale as many as it likes.

   Three things are tested, in three different ways, because a seat limit can be
   broken in three different places:

   1. THE RULE IS IN THE DATABASE, ONCE. Read as text from
      supabase/migrations/20261207_seats.sql: the numbers live only in
      plan_prices, both the issuing and the accepting side take a row lock on
      the client BEFORE they count, and the accepting side RAISES (so the
      transaction, and with it the invite it had already marked accepted, rolls
      back). A unique index means one login can never hold two seats.

   2. THE RACE. Two people open the last invite at the same instant. This runs
      the real shape of the rule — lock, then count, then take — against a model
      of two interleaved transactions, and shows that exactly one gets in. The
      same model with the lock taken out lets both in, so this test fails if
      anybody removes the lock. (A true two-session test needs two live
      Postgres connections, which this harness has not got; the live database's
      own `for update` was checked against the applied functions separately.)

   3. THE SCREEN NEVER DECIDES. clientbook.js draws portal_seat_state()'s answer
      and goes through portal_seat_free(); it holds no number of its own and
      never writes client_people.

   Run with:  node --test tests/seats.test.mjs */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = fs.readFileSync(path.join(root, 'supabase/migrations/20261207_seats.sql'), 'utf8');
const bare = SQL.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fn = (name) => {
  const i = bare.indexOf('function public.' + name);
  assert.ok(i > 0, name + ' is in the migration');
  const j = bare.indexOf('$$;', i);
  return bare.slice(i, j < 0 ? bare.length : j);
};

/* ───────────── 1. the rule is in the database, once ───────────── */

test('the seat numbers live only in plan_prices, and Scale is unlimited', () => {
  assert.match(bare, /alter table public\.plan_prices\s+add column if not exists portal_seats int/);
  assert.match(bare, /set portal_seats = 2,[^\n]*where plan = 'starter'/);
  assert.match(bare, /set portal_seats = 4,[^\n]*where plan = 'growth'/);
  /* Scale is null, not a big number: "unlimited" is a real state, not 999 */
  assert.match(bare, /set portal_seats = null,[^\n]*where plan = 'scale'/);
  assert.ok(!/portal_seats\s*=\s*(99|999|1000|2147483647)/.test(bare), 'unlimited is null, never a big number');

  /* every seat decision reads the column; none of them types a number */
  for (const f of ['portal_invite_create', 'portal_invite_consume', 'portal_seat_state', 'invite_peek'])
    assert.match(fn(f), /portal_seats/, f + ' reads the column');
  assert.match(fn('plan_seats'), /from public\.plan_prices/);
  /* the comparison is always against the column, never a literal */
  for (const f of ['portal_invite_create', 'portal_invite_consume'])
    assert.ok(!/>=\s*[0-9]+\s*then/.test(fn(f)), f + ' compares against v_seats, not a number');
});

test('unlimited really is unlimited: a null allowance skips the check entirely', () => {
  for (const f of ['portal_invite_create', 'portal_invite_consume', 'invite_peek'])
    assert.match(fn(f), /if v_seats is not null then/, f + ' only counts when there is a limit');
});

test('both sides lock the client BEFORE they count, and the count is not a read-then-write', () => {
  for (const name of ['portal_invite_create', 'portal_invite_consume']) {
    const body = fn(name);
    const lock = body.search(/from public\.clients where id = [^\n]*for update/);
    assert.ok(lock > 0, name + ' takes a row lock on the client');
    const count = body.search(/select count\(\*\) into v_held/);
    assert.ok(count > 0, name + ' counts the seats held');
    assert.ok(lock < count, name + ' locks first, then counts — not the other way round');
  }
});

test('a full house at accept time RAISES, so the invite it had marked accepted rolls back', () => {
  const body = fn('portal_invite_consume');
  /* the invite is marked accepted first (one statement, so two clicks cannot
     both win it) and the seat check comes after — which only works because a
     refusal is an exception, not a return */
  const accepted = body.indexOf("status = 'accepted'");
  const refusal = body.search(/raise exception '%', public\.seat_full_message/);
  assert.ok(accepted > 0 && refusal > accepted, 'the seat refusal comes after the invite is taken');
  assert.ok(!/return jsonb_build_object\('ok', false/.test(body), 'it raises, it does not return a soft failure');
  /* and it is marked with its own SQLSTATE so portal-accept can show the sentence */
  assert.match(body, /using errcode = 'ZS001'/);
  assert.match(fn('portal_invite_create'), /using errcode = 'ZS001'/);
});

test('one login can never hold two seats, whatever the code above it does', () => {
  assert.match(bare, /create unique index if not exists client_people_one_seat_per_user\s+on public\.client_people\(user_id\) where user_id is not null/);
});

test('freeing a seat also revokes a pending invite to the same inbox', () => {
  const body = fn('portal_seat_free');
  assert.match(body, /if not public\.is_approved\(\) then/, 'team only');
  assert.match(body, /for update/, 'it lines up behind the same lock');
  assert.match(body, /update public\.portal_invites set status = 'revoked'/, 'or the seat hands itself straight back');
  assert.match(body, /set user_id = null/);
  /* the person, their messages and their channel stay */
  assert.ok(!/delete from public\.client_people/.test(body));
  assert.ok(!/delete from public\.channel_members/.test(body));
});

test('every new rule refuses a caller who is not approved team, in plain English', () => {
  for (const [f, words] of [
    ['portal_seat_state', /Only the Aviance team can see who can sign in\./],
    ['portal_seat_free',  /Only the Aviance team can free a portal login\./],
    ['portal_invite_create', /Only the Aviance team can invite a client\./],
  ]) {
    assert.match(fn(f), /is_approved\(\)/, f + ' asks who is calling');
    assert.match(fn(f), words, f + ' says why in a sentence, with no code in it');
  }
  /* and the sentences a person reads have no jargon and no error codes */
  const msg = bare.slice(bare.indexOf('function public.seat_full_message')).split('$$;')[0];
  const sentences = [...msg.matchAll(/'([^']{40,})'/g)].map((m) => m[1]);
  assert.ok(sentences.length >= 2, 'both sentences are there');
  for (const line of sentences)
    assert.ok(!/ZS001|23505|P0001|RLS|row level|constraint|null|uuid/i.test(line), 'no code in: ' + line);
  assert.match(msg, /Free one under "Who can sign in" on their page/, 'it says what to do');
  assert.match(msg, /reply to any of our emails/, 'the client is told what to do too');
});

/* ───────────── 2. the race ───────────── */

/* A model of the database rule, exactly in the order the migration has it:
   take the invite, lock the client, count the seats held, refuse or take one.
   `locking` is a knob only so that the test can prove the lock is what saves
   us: with it off, this same model lets two people in. */
function seatModel({ seats, held, locking }) {
  const db = { held: held.slice(), lockedBy: null, invites: { a: 'pending', b: 'pending' } };
  const waiting = [];
  const winners = [], refused = [];

  function* accept(who, invite) {
    /* 1. take the invite — one statement, so only one caller can win one invite */
    if (db.invites[invite] !== 'pending') { refused.push([who, 'link already used']); return }
    db.invites[invite] = 'accepted';
    yield 'took the invite';

    /* 2. lock the client */
    if (locking) {
      while (db.lockedBy && db.lockedBy !== who) { waiting.push(who); yield 'waiting for the lock' }
      db.lockedBy = who;
    }
    yield 'locked';

    /* 3. count, with the lock held */
    const used = db.held.length;
    yield 'counted ' + used;

    /* 4. refuse, or take a seat */
    if (seats !== null && used >= seats) {
      db.invites[invite] = 'pending';          // the raise rolls the whole thing back
      refused.push([who, 'no seat free']);
    } else {
      db.held.push(who);
      winners.push(who);
    }
    if (locking) db.lockedBy = null;
  }

  /* two people, interleaved step by step: the worst possible timing */
  const one = accept('ann', 'a'), two = accept('bob', 'b');
  let a = true, b = true, guard = 0;
  while ((a || b) && guard++ < 200) {
    if (a) a = !one.next().done;
    if (b) b = !two.next().done;
  }
  return { winners, refused, held: db.held, invites: db.invites };
}

test('the race: two people open the last invite at the same instant and only one gets in', () => {
  const r = seatModel({ seats: 2, held: ['sam'], locking: true });
  assert.equal(r.winners.length, 1, 'exactly one seat was taken');
  assert.equal(r.refused.length, 1, 'the other was refused');
  assert.equal(r.held.length, 2, 'the limit held: 2 of 2');
  assert.deepEqual(r.refused[0][1], 'no seat free');
  /* the refused person's link is NOT burnt — it works again once a seat frees */
  const stillGood = Object.values(r.invites).filter((s) => s === 'pending').length;
  assert.equal(stillGood, 1, 'the refused invite is back to pending, not used up');
});

test('the race, with both invites and no seats at all: nobody gets in', () => {
  const r = seatModel({ seats: 2, held: ['sam', 'kim'], locking: true });
  assert.equal(r.winners.length, 0);
  assert.equal(r.refused.length, 2);
  assert.equal(r.held.length, 2);
});

test('the race on Scale: unlimited means both get in', () => {
  const r = seatModel({ seats: null, held: ['sam', 'kim', 'lee'], locking: true });
  assert.equal(r.winners.length, 2);
  assert.equal(r.refused.length, 0);
});

test('without the lock the same rule lets two people past, which is why the lock is there', () => {
  const r = seatModel({ seats: 2, held: ['sam'], locking: false });
  assert.equal(r.winners.length, 2, 'read-then-write loses the race');
  assert.equal(r.held.length, 3, '3 people on a 2-seat plan — the bug this guards against');
});

test('two seats free, two people: both get in, and the third is turned away', () => {
  const first = seatModel({ seats: 2, held: [], locking: true });
  assert.equal(first.winners.length, 2);
  const third = seatModel({ seats: 2, held: first.held, locking: true });
  assert.equal(third.winners.length, 0);
});

/* ───────────── 3. the screen never decides ───────────── */

let calls, tables, rpcs;
function builder(table) {
  const call = { table, op: 'select', filters: [], payload: null };
  calls.push(call);
  const b = {
    select(c) { call.cols = c; return b }, insert(p) { call.op = 'insert'; call.payload = p; return b },
    update(p) { call.op = 'update'; call.payload = p; return b }, upsert(p) { call.op = 'upsert'; call.payload = p; return b },
    delete() { call.op = 'delete'; return b },
    eq(k, v) { call.filters.push(['eq', k, v]); return b }, in(k, v) { call.filters.push(['in', k, v]); return b },
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
  auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
};
const fields = {}, toasts = [];
globalThis.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
globalThis.val = (id) => String(fields[id] == null ? '' : fields[id]).trim();
globalThis.errEl = (id, msg) => { fields['err:' + id] = msg; return false };
globalThis.emptyState = (i, t, s) => `<div class="card"><h3>${t}</h3><p>${s}</p></div>`;
globalThis.toast = (m) => { toasts.push(m) };
globalThis.openModal = (h) => { fields.modal = h };
globalThis.closeModal = () => { fields.modal = null };
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'finance.js'), 'utf8'), { filename: 'finance.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'clientbook.js'), 'utf8'), { filename: 'clientbook.js' });

const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const state = (o = {}) => ({
  client_id: 'c1', company: 'Stone Roofing', plan: 'starter', plan_label: 'Starter',
  seats: 2, unlimited: false, held: 1, pending: 0, free: 1, at_limit: false, full_message: null,
  holders: [{ person_id: 'p1', name: 'Sam Stone', email: 'sam@stone.test', role: 'Owner', is_primary: true, since: '2026-10-02T09:00:00Z' }],
  invites: [], waiting: [], ...o,
});

beforeEach(() => { calls = []; tables = {}; rpcs = []; toasts.length = 0; cbForget(); });

test('the seat screen draws what the database said and holds no number of its own', () => {
  const h = cbRenderSeats('c1', state(), {});
  const t = text(h);
  assert.match(t, /Who can sign in/);
  assert.match(t, /Starter comes with 2 logins\. 1 in use\./);
  assert.match(t, /1 \/ 2/, 'the figure block');
  assert.match(t, /Sam Stone/);
  assert.match(h, /cbAskFreeSeat\(&quot;c1&quot;,&quot;p1&quot;\)/, 'a way to free that one');
  assert.ok(!/undefined|NaN|\[object/.test(h));

  /* the numbers come from the answer, not from this file */
  const growth = text(cbRenderSeats('c1', state({ plan: 'growth', plan_label: 'Growth', seats: 4, held: 3, free: 1 }), {}));
  assert.match(growth, /Growth comes with 4 logins\. 3 in use\./);
  assert.match(growth, /3 \/ 4/);
  const src = fs.readFileSync(path.join(root, 'clientbook.js'), 'utf8');
  assert.ok(!/(starter|growth|scale)\s*:\s*[0-9]/i.test(src), 'no plan-to-seats table in the browser');
});

test('Scale says unlimited, and is never at a limit', () => {
  const t = text(cbRenderSeats('c1', state({ plan: 'scale', plan_label: 'Scale', seats: null, unlimited: true, held: 7, free: null, at_limit: false }), {}));
  assert.match(t, /Unlimited logins on Scale\./);
  assert.match(t, /7 \/ ∞/);
  assert.ok(!/comes with/.test(t));
});

test('at the limit the client is told in plain English what to do, not given an error', () => {
  const full = 'Stone Roofing is on Starter, which comes with 2 portal logins, and they are all taken. Free one under "Who can sign in" on their page, or move them to a bigger plan, then send this invite again.';
  const t = text(cbRenderSeats('c1', state({ held: 2, free: 0, at_limit: true, full_message: full }), {}));
  assert.match(t, /Free one under "Who can sign in" on their page/);
  assert.ok(!/error|ZS001|23505|constraint|null/i.test(t), 'no code, no jargon');
});

test('with nobody signed in, and with the panel not switched on, it says so', () => {
  assert.match(text(cbRenderSeats('c1', state({ held: 0, holders: [], free: 2 }), {})),
    /Nobody from Stone Roofing can sign in yet/);
  assert.match(text(cbRenderSeats('c1', null, { error: CB_SEATS_NOT_READY })), /not switched on yet/);
  /* a pending invite is shown as holding a seat, because it does */
  assert.match(text(cbRenderSeats('c1', state({ pending: 1, free: 0, invites: [{ id: 'v1', email: 'kim@stone.test', expires_at: '2026-12-20T00:00:00Z' }] }), {})),
    /Invited, not opened yet/);
});

test('a name with a tag in it cannot write HTML into the seat screen', () => {
  const h = cbRenderSeats('c1', state({ holders: [{ person_id: '<img src=x>', name: '<script>alert(1)</script>', email: '"><b>x', role: '', is_primary: false }] }), {});
  assert.ok(!/<script|<img src=x|<b>x/.test(h), 'nothing a person typed became markup');
  assert.match(h, /&lt;script&gt;/);
});

test('freeing a seat goes through the database rule and never writes client_people', async () => {
  tables['rpc.portal_seat_free'] = () => ({ data: state({ held: 0, free: 2, holders: [] }), error: null });
  cb.seats.c1 = state();
  fields.cbSeatWhy = 'She has left';
  const r = await cbFreeSeatGo('c1', 'p1');
  assert.equal(r.ok, true);
  assert.deepEqual(rpcs, [{ name: 'portal_seat_free', args: { p_person: 'p1', p_reason: 'She has left' } }]);
  assert.equal(calls.filter((c) => c.table === 'client_people' && c.op !== 'select').length, 0);
  assert.equal(calls.filter((c) => c.table === 'portal_invites').length, 0);
  assert.match(toasts.at(-1), /That login is freed — 2 of 2 free now/);
});

test('a refusal from the database is shown as the sentence it sent, nothing added', async () => {
  tables['rpc.portal_seat_free'] = () => ({ data: null, error: { message: 'Sam Stone does not have a portal login, so there is nothing to free.' } });
  cb.seats.c1 = state();
  const r = await cbFreeSeatGo('c1', 'p1');
  assert.equal(r.ok, false);
  assert.equal(fields['err:cbSeatErr'], 'Sam Stone does not have a portal login, so there is nothing to free.');
});

test('a rule that is not deployed yet reads as "not switched on", never as a Postgres error', async () => {
  tables['rpc.portal_seat_state'] = () => ({ data: null, error: { message: 'Could not find the function public.portal_seat_state(p_client) in the schema cache' } });
  const r = await cbSeats('c1');
  assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']);
  assert.equal(r.ok, false);
  assert.equal(r.error, CB_SEATS_NOT_READY);
  assert.ok(!/schema cache|public\./.test(r.error));
});

test('asking who can sign in asks the database and reads no table itself', async () => {
  tables['rpc.portal_seat_state'] = () => ({ data: state(), error: null });
  const r = await cbSeats('c1');
  assert.equal(r.ok, true);
  assert.deepEqual(rpcs, [{ name: 'portal_seat_state', args: { p_client: 'c1' } }]);
  assert.equal(calls.length, 0, 'no direct read of client_people or portal_invites');
  assert.equal((await cbSeats('')).ok, false);
});

/* ───────── at the limit with nobody signed in: three statements that agreed ─────────
   Found live on a Growth client with four invitations and nobody accepted: the
   page showed the figure "0 / 4", the line "Nobody from them can sign in yet",
   and an amber note telling the owner to "Free one under 'Who can sign in'" —
   where there was nobody to free. A pending invite does hold a login, so the
   figure counts it, and the note says what is actually true. */

test('four unopened invites and nobody signed in: the figure, the line and the note agree', () => {
  const invites = [1, 2, 3, 4].map((n) => ({ id: 'v' + n, email: 'p' + n + '@stone.test', expires_at: '2026-12-20T00:00:00Z' }));
  const full = 'Stone Roofing is on Growth, which comes with 4 portal logins, and they are all taken. Free one under "Who can sign in" on their page, or move them to a bigger plan, then send this invite again.';
  const t = text(cbRenderSeats('c1', state({
    plan: 'growth', plan_label: 'Growth', seats: 4, held: 0, pending: 4, free: 0,
    at_limit: true, full_message: full, holders: [], invites,
  }), {}));

  assert.match(t, /4 \/ 4/, 'four invitations hold four logins, so the figure is 4 of 4, never 0 of 4');
  assert.ok(!/0 \/ 4/.test(t), 'the old figure said nobody held a login while every login was taken');
  assert.match(t, /Portal logins taken/, 'not "in use": nobody is using one yet');
  assert.match(t, /held by invitations nobody has opened yet/);
  assert.match(t, /each frees itself on its expiry date/);
  assert.ok(!/Free one under/.test(t), 'there is nobody to free, so it must not say to free one');
  assert.match(t, /Nobody from Stone Roofing can sign in yet/, 'still true, and no longer contradicted');
  assert.match(t, /Invited, not opened yet/);
  assert.ok(!/undefined|NaN|\[object/.test(t));
});

test('one unopened invite reads as one, and a login in use still gets the database’s own sentence', () => {
  const one = text(cbRenderSeats('c1', state({
    seats: 2, held: 0, pending: 2, free: 0, at_limit: true, holders: [],
    invites: [{ id: 'v1', email: 'kim@stone.test', expires_at: '2026-12-20T00:00:00Z' }],
  }), {}));
  assert.match(one, /2 \/ 2/);
  assert.match(one, /held by invitations nobody has opened yet/);

  /* somebody IS signed in: the refusal sentence the database wrote is the right
     one, word for word, because freeing a login is a thing the owner can do */
  const full = 'Stone Roofing is on Starter, which comes with 2 portal logins, and they are all taken. Free one under "Who can sign in" on their page, or move them to a bigger plan, then send this invite again.';
  const mix = text(cbRenderSeats('c1', state({ held: 1, pending: 1, free: 0, at_limit: true, full_message: full }), {}));
  assert.match(mix, /Free one under "Who can sign in" on their page/);
  assert.match(mix, /2 \/ 2/, 'one in use plus one invited is both logins taken');
});
