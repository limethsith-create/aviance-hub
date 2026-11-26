/* Tests for the prospect window (prospects.js), the grant model in team.js, and the
   row level security that decides who may see a client's prospects
   (supabase/migrations/20261207_prospect_access.sql).

   Run with: npm test. No browser, no network: prospects.js runs in a vm with esc(),
   emptyState(), a tiny document and a fake Supabase client that keeps rows in memory
   AND APPLIES THE GRANT RULE THE DATABASE APPLIES — every select on an outreach table
   is filtered by can_see_prospects(client_id), so a test can sign in as an employee
   with no grant and see what the database would really hand back: nothing. The SQL
   itself cannot run under node, so the policies are also read out of the migration and
   pinned, the way tests/server-fixes.test.mjs pins the server work. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/* ───────────── a fake Supabase that enforces the grant, like the database ───────────── */

const db = { outreach_threads: [], outreach_messages: [], outreach_campaigns: [], clients: [], profiles: [], prospect_grants: [], meetings: [] };
let me = { id: 'owner', role: 'admin' };             // who is signed in, as the database sees them
const seen = [];                                     // every query, for the assertions that care
let nextId = 1;

const GRANTED = ['outreach_threads', 'outreach_messages', 'outreach_campaigns', 'outreach_accounts', 'outreach_daily', 'outreach_inboxes'];
const isAdmin = () => me && me.role === 'admin' && me.approved !== false;
/* can_see_prospects(client_id), verbatim: the owner, or a live grant for that client. */
const canSee = (clientId) => !!clientId && (isAdmin() || db.prospect_grants.some(
  (g) => String(g.user_id) === String(me && me.id) && String(g.client_id) === String(clientId) && !g.revoked_at));

const same = (a, b) => String(a) === String(b);
function match(row, f) {
  const [kind, col, v] = f;
  if (kind === 'eq') return same(row[col], v);
  if (kind === 'in') return v.some((x) => same(row[col], x));
  if (kind === 'is') return v === null ? row[col] == null : same(row[col], v);
  if (kind === 'not') return !(f[3] === null ? row[col] == null : same(row[col], f[3]));
  if (kind === 'or') {                              // lead_company.ilike.%q%,lead_name.ilike...
    return String(v).split(',').some((part) => {
      const m = /^(\w+)\.ilike\.%(.*)%$/.exec(part);
      if (!m) return false;
      return String(row[m[1]] || '').toLowerCase().includes(m[2].toLowerCase());
    });
  }
  return true;
}
function run(st) {
  seen.push(st);
  const rows = db[st.table] || [];
  let hit = rows.filter((r) => st.filters.every((f) => match(r, f)));
  /* THE RULE: every read of an outreach table is filtered by the grant. */
  if (st.op === 'select' && GRANTED.includes(st.table)) hit = hit.filter((r) => canSee(r.client_id));
  if (st.op === 'insert') {
    const list = Array.isArray(st.payload) ? st.payload : [st.payload];
    const made = list.map((p) => Object.assign({ id: 'id' + nextId++, created_at: new Date().toISOString() }, p));
    if (st.table === 'prospect_grants' && made.some((m) => db.prospect_grants.some(
      (g) => same(g.user_id, m.user_id) && same(g.client_id, m.client_id) && !g.revoked_at)))
      return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "prospect_grants_live_uq"' } });
    made.forEach((m) => rows.push(m));
    hit = made;
  } else if (st.op === 'update') {
    hit.forEach((r) => Object.assign(r, st.payload));
  }
  const total = hit.length;
  if (st.op === 'select' && st.range) hit = hit.slice(st.range[0], st.range[1] + 1);
  const data = st.single ? (hit.length ? hit[0] : null) : hit;
  return Promise.resolve({ data, error: null, count: st.count ? total : null });
}
function builder(table) {
  const st = { table, op: 'select', payload: null, filters: [], orders: [], single: false, count: false, range: null };
  const b = {
    select(_c, o) { if (o && o.count) st.count = true; return b },
    insert(r) { st.op = 'insert'; st.payload = r; return b },
    update(r) { st.op = 'update'; st.payload = r; return b },
    eq(c, v) { st.filters.push(['eq', c, v]); return b },
    in(c, v) { st.filters.push(['in', c, v]); return b },
    is(c, v) { st.filters.push(['is', c, v]); return b },
    not(c, op, v) { st.filters.push(['not', c, op, v]); return b },
    or(s) { st.filters.push(['or', null, s]); return b },
    order(c, o) { st.orders.push([c, o]); return b },
    range(a, z) { st.range = [a, z]; return b },
    single() { st.single = true; return b }, maybeSingle() { st.single = true; return b },
    then(res, rej) { return run(st).then(res, rej) },
  };
  return b;
}
/* The two definer functions, with the same guard they carry in the migration. */
const rpcs = {
  prospect_clients: () => db.clients.filter((c) => canSee(c.id)).map((c) => ({ id: c.id, company: c.company })),
  prospect_seat: () => db.prospect_grants.some((g) => String(g.user_id) === String(me && me.id) && !g.revoked_at),
  prospect_window: (a) => {
    const t = db.outreach_threads.find((x) => String(x.id) === String(a.p_thread));
    if (!t) return null;
    if (!canSee(t.client_id)) throw new Error('You have not been given this client’s prospects.');
    return {
      thread: t,
      client: db.clients.filter((c) => String(c.id) === String(t.client_id)).map((c) => ({ id: c.id, company: c.company }))[0] || null,
      campaign: db.outreach_campaigns.find((c) => String(c.id) === String(t.campaign_id)) || null,
      messages: db.outreach_messages.filter((m) => String(m.thread_id) === String(t.id))
        .sort((x, y) => String(x.sent_at).localeCompare(String(y.sent_at))),
      call: db.meetings.find((m) => String(m.id) === String(t.meeting_id)) || null,
    };
  },
};

const toasts = [];
function sandboxFor(file, extra) {
  const box = {
    console, Date, Number, Math, Promise, Array, String, Boolean, Object, JSON, RegExp, Error, isNaN, parseInt,
    setTimeout, clearTimeout,
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    emptyState: (icon, title, sub) => `<div class="card"><div class="empty"><h3>${title}</h3><p>${sub}</p></div></div>`,
    toast: (m) => toasts.push(m),
    I: { people: '<svg/>', check: '<svg/>', inquiry: '<svg/>' },
    document: { getElementById: () => null },
    authUser: { id: 'owner', uid: 'owner', name: 'Owner', role: 'admin', email: 'owner@aviance.store' },
    sb: {
      from: builder,
      rpc: (name, args) => {
        seen.push({ rpc: name, args: args || {} });
        try { const d = rpcs[name] ? rpcs[name](args || {}) : null; return Promise.resolve({ data: d === undefined ? null : d, error: null }) }
        catch (e) { return Promise.resolve({ data: null, error: { message: e.message } }) }
      },
    },
  };
  Object.assign(box, extra || {});
  vm.createContext(box);
  vm.runInContext(read(file) + '\n;globalThis.__box=this;', box, { filename: file });
  return box;
}

const P = sandboxFor('prospects.js');
vm.runInContext(`globalThis.api={prThreads,prWindow,prClients,prCampaigns,prSequence,prSafeSearch,prRenderList,
  prRenderOne,prRenderFilters,prRenderPager,viewProspects,viewProspect,prLoadList,prLoadOne,prSetClient,prSetSentiment,
  prSetBooked,prSetCampaign,prClearFilters,prGoPage,prForget,prS,PR_PAGE,PR_SENTIMENTS};`, P, { filename: 'prospects.js' });
const A = P.api;

const T = sandboxFor('team.js');
vm.runInContext(`globalThis.tapi={tmGrants,tmGrantAdd,tmGrantRevoke,tmGrantsByPerson,tmRenderGrants,tmLoadGrants,
  tmDoGrant,tmDoRevoke,tmForget,tmS,tmLoadClients,tmPeople};`, T, { filename: 'team.js' });
const TA = T.tapi;

const tick = () => new Promise((r) => setTimeout(r, 5));
const signIn = (who) => { me = who; P.authUser = { id: who.id, uid: who.id, role: who.role === 'admin' ? 'admin' : 'employee', name: 'Somebody' };
  T.authUser = P.authUser; };

function reset() {
  Object.keys(db).forEach((k) => { db[k] = [] });
  seen.length = 0; toasts.length = 0; nextId = 1;
  A.prForget(); TA.tmForget();
  signIn({ id: 'owner', role: 'admin' });
}

/* Two clients, two prospects each, so a leak is visible the moment it happens. */
function seedTwoClients() {
  db.clients.push({ id: 'cA', company: 'Northwind Systems', monthly_fee: 3000 },
                  { id: 'cB', company: 'Baytown Freight', monthly_fee: 1500 });
  db.profiles.push({ id: 'owner', name: 'Owner', email: 'owner@aviance.store', role: 'admin', approved: true },
                   { id: 'emp', name: 'Priya', email: 'priya@aviance.store', role: 'employee', approved: true },
                   { id: 'junior', name: 'Ruwan', email: 'ruwan@aviance.store', role: 'employee', approved: true });
  db.outreach_campaigns.push({ id: 'kA', client_id: 'cA', name: 'Northwind — CFOs Q1', status: 'running', sent: 420, replied: 31, booked: 6, started_on: '2026-10-01' },
                             { id: 'kB', client_id: 'cB', name: 'Baytown — 3PL owners', status: 'running', sent: 210, replied: 12, booked: 2, started_on: '2026-11-02' });
  db.meetings.push({ id: 'm1', starts_at: '2026-12-02T15:00:00Z', minutes: 30, status: 'booked', kind: 'qualified', guest_name: 'Dana Whitfield', guest_email: 'dana@acme-logistics.com', time_zone: 'America/New_York' });
  db.outreach_threads.push(
    { id: 't1', client_id: 'cA', campaign_id: 'kA', lead_name: 'Dana Whitfield', lead_email: 'dana@acme-logistics.com', lead_company: 'Acme Logistics', lead_title: 'VP Finance', sentiment: 'positive', status: 'booked', meeting_id: 'm1', last_message_at: '2026-11-24T10:00:00Z', created_at: '2026-11-10T09:00:00Z' },
    { id: 't2', client_id: 'cA', campaign_id: 'kA', lead_name: 'Owen Pike', lead_email: 'owen@pike-dairy.com', lead_company: 'Pike Dairy', lead_title: 'Owner', sentiment: 'negative', status: 'closed', meeting_id: null, last_message_at: '2026-11-20T10:00:00Z', created_at: '2026-11-09T09:00:00Z' },
    { id: 't3', client_id: 'cB', campaign_id: 'kB', lead_name: 'Mel Soto', lead_email: 'mel@soto-haul.com', lead_company: 'Soto Haulage', lead_title: 'Director', sentiment: 'neutral', status: 'answered', meeting_id: null, last_message_at: '2026-11-25T10:00:00Z', created_at: '2026-11-18T09:00:00Z' },
    { id: 't4', client_id: 'cB', campaign_id: 'kB', lead_name: 'Rae Judd', lead_email: 'rae@judd-cold.com', lead_company: 'Judd Cold Chain', lead_title: 'COO', sentiment: 'unknown', status: 'open', meeting_id: null, last_message_at: null, created_at: '2026-11-19T09:00:00Z' });
  db.outreach_messages.push(
    { id: 'x1', thread_id: 't1', client_id: 'cA', direction: 'out', subject: 'Quick question, Dana', body: 'First touch.', sent_at: '2026-11-10T09:00:00Z', delivery: 'sent' },
    { id: 'x2', thread_id: 't1', client_id: 'cA', direction: 'out', subject: 'Re: Quick question', body: 'Second touch.', sent_at: '2026-11-17T09:00:00Z', delivery: 'sent' },
    { id: 'x3', thread_id: 't1', client_id: 'cA', direction: 'in', subject: 'Re: Quick question', body: 'Yes — send me a time.', sent_at: '2026-11-24T10:00:00Z', delivery: 'synced' },
    { id: 'x4', thread_id: 't3', client_id: 'cB', direction: 'out', subject: 'Soto Haulage', body: 'Only touch.', sent_at: '2026-11-25T09:00:00Z', delivery: 'failed', delivery_error: 'mailbox full' });
}

/* ═════════════ the rule that matters most: one client's leads never reach another ═════════════ */

test('an employee with no grant sees ZERO prospect rows', async () => {
  reset(); seedTwoClients();
  signIn({ id: 'junior', role: 'employee' });

  const page = await A.prThreads({});
  assert.equal(page.ok, true);
  assert.deepEqual(Array.from(page.data.rows), [], 'no thread comes back');
  assert.equal(page.data.total, 0, 'and the count is zero, not a hint of how many there are');

  const camps = await A.prCampaigns('');
  assert.deepEqual(Array.from(camps.data), [], 'no campaign names either');
  const clients = await A.prClients();
  assert.deepEqual(Array.from(clients.data), [], 'and no client names');

  /* asking for a thread by id, straight out: refused, not handed over */
  const one = await A.prWindow('t1');
  assert.equal(one.ok, false);
  assert.match(one.error, /not been given/i);

  /* and the screen says so in words, without pretending the database is empty */
  await A.prLoadList();
  const html = A.prRenderList();
  assert.match(html, /Nothing has been shared with you/);
  for (const leak of ['Acme Logistics', 'Soto Haulage', 'Northwind', 'Baytown', 'dana@acme-logistics.com'])
    assert.ok(!html.includes(leak), html.slice(0, 200) + ' leaked ' + leak);
});

test('an employee granted one client sees that client only — the other client is invisible', async () => {
  reset(); seedTwoClients();
  db.prospect_grants.push({ id: 'g1', user_id: 'emp', client_id: 'cA', granted_by: 'owner', revoked_at: null });
  signIn({ id: 'emp', role: 'employee' });

  const page = await A.prThreads({});
  const got = Array.from(page.data.rows).map((r) => r.id).sort();
  assert.deepEqual(got, ['t1', 't2'], 'only client A');
  assert.equal(page.data.total, 2, 'the count is of what they may see, nothing more');

  const clients = Array.from(await A.prClients().then((r) => r.data));
  assert.deepEqual(clients.map((c) => c.company), ['Northwind Systems']);
  assert.ok(!JSON.stringify(clients).includes('monthly_fee'), 'a client name, never the fee beside it');

  /* client B, asked for by id and by filter, in both directions */
  assert.equal((await A.prWindow('t3')).ok, false, 'another client’s thread is refused');
  const forced = await A.prThreads({ client: 'cB' });
  assert.deepEqual(Array.from(forced.data.rows), [], 'filtering to a client they were not given returns nothing');
  const searched = await A.prThreads({ q: 'Soto' });
  assert.deepEqual(Array.from(searched.data.rows), [], 'and neither does searching for it by name');

  /* their own client still works whole */
  const one = await A.prWindow('t1');
  assert.equal(one.ok, true);
  assert.equal(one.data.messages.length, 3);
  assert.equal(one.data.call.guest_name, 'Dana Whitfield');
});

test('a grant taken back stops working at once, and a revoked row is not a grant', async () => {
  reset(); seedTwoClients();
  db.prospect_grants.push({ id: 'g1', user_id: 'emp', client_id: 'cA', revoked_at: null });
  signIn({ id: 'emp', role: 'employee' });
  assert.equal((await A.prThreads({})).data.total, 2);
  db.prospect_grants[0].revoked_at = '2026-11-26T00:00:00Z';
  A.prForget();
  assert.equal((await A.prThreads({})).data.total, 0, 'revoked is not granted');
  assert.equal((await A.prWindow('t1')).ok, false);
});

test('the owner sees every client, and the grant does not widen anything else', async () => {
  reset(); seedTwoClients();
  const page = await A.prThreads({});
  assert.equal(page.data.total, 4);
  assert.deepEqual(Array.from(await A.prClients().then((r) => r.data)).map((c) => c.company).sort(),
    ['Baytown Freight', 'Northwind Systems']);
});

/* ═════════════ the migration: the policy, not just the screen ═════════════ */

const sql = read('supabase/migrations/20261207_prospect_access.sql');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const OUTREACH = ['outreach_accounts', 'outreach_campaigns', 'outreach_daily', 'outreach_inboxes', 'outreach_threads', 'outreach_messages'];

test('every outreach table is read by grant, and no policy can hand a read to anybody else', () => {
  for (const t of OUTREACH) {
    assert.match(code, new RegExp('create policy ' + t + '_read on public\\.' + t + '\\s*\\n?\\s*for select using \\(public\\.can_see_prospects\\(client_id\\)\\)'), t + ' reads by grant');
    // the old blanket policy is gone, and nothing is left that covers SELECT for all staff
    assert.match(code, new RegExp('drop policy if exists ' + t + '_team_read  on public\\.' + t), t + ' loses its old read');
    assert.match(code, new RegExp('drop policy if exists ' + t + '_team_write on public\\.' + t), t + ' loses the ALL policy that also granted a read');
    assert.ok(!new RegExp('create policy[^;]*on public\\.' + t + '[^;]*for all', 'i').test(code), t + ' has no ALL policy any more');
    for (const cmd of ['insert', 'update', 'delete'])
      assert.match(code, new RegExp('create policy ' + t + '_' + cmd + ' on public\\.' + t), t + ' can still be written by the sync');
  }
  assert.ok(!/is_approved\(\)\)?\s*\);?\s*$/m.test(code.split('for select using (public.is_approved())')[1] || ''), 'no select is left on is_approved()');
  assert.ok(!code.includes('for select using (public.is_approved())'), 'no outreach read is left open to every approved staff member');
});

test('can_see_prospects is the one question, and it answers no by default', () => {
  const fn = /create or replace function public\.can_see_prospects[\s\S]*?\$\$;/.exec(code)[0];
  assert.match(fn, /stable security definer set search_path = public/);
  assert.match(fn, /p_client is not null/, 'a null client is not a free pass');
  assert.match(fn, /public\.is_admin\(\)/);
  assert.match(fn, /g\.user_id = auth\.uid\(\)/);
  assert.match(fn, /g\.revoked_at is null/);
  assert.ok(!/is_approved/.test(fn), 'being approved team is NOT enough — the grant is');
});

test('the grant table is the owner’s to write, yours only to read, and one live row per pair', () => {
  assert.match(code, /create table if not exists public\.prospect_grants/);
  assert.match(code, /alter table public\.prospect_grants enable row level security/);
  assert.match(code, /create policy prospect_grants_admin_all on public\.prospect_grants\s*\n\s*for all using \(public\.is_admin\(\)\) with check \(public\.is_admin\(\)\)/);
  assert.match(code, /create policy prospect_grants_read_own on public\.prospect_grants\s*\n\s*for select using \(user_id = auth\.uid\(\)\)/);
  assert.match(code, /create unique index if not exists prospect_grants_live_uq[\s\S]*?where revoked_at is null/);
  assert.match(code, /references public\.profiles\(id\) on delete cascade/);
  assert.match(code, /references public\.clients\(id\)  on delete cascade/);
});

test('both new functions check the grant themselves and are shut to anon', () => {
  for (const [name, sig] of [['prospect_clients', '()'], ['prospect_window', '(uuid)'], ['can_see_prospects', '(uuid)'], ['prospect_seat', '()']]) {
    const fn = new RegExp('create or replace function public\\.' + name + '[\\s\\S]*?\\$\\$;').exec(code)[0];
    assert.match(fn, /security definer set search_path = public/, name + ' pins its search_path');
    assert.match(code, new RegExp('revoke execute on function public\\.' + name.replace(/[()]/g, '') + '\\' + sig[0] + '[^)]*\\) from public, anon'), name + ' is shut to anon');
  }
  const w = /create or replace function public\.prospect_window[\s\S]*?\$\$;/.exec(code)[0];
  assert.match(w, /if not public\.can_see_prospects\(t\.client_id\) then\s*\n\s*raise exception/, 'prospect_window refuses a client you were not given');
  assert.ok(!/monthly_fee|three_month_fee|amount|invoice/i.test(w), 'and it hands over no money');
  const c = /create or replace function public\.prospect_clients[\s\S]*?\$\$;/.exec(code)[0];
  assert.match(c, /jsonb_build_object\('id', c\.id, 'company', c\.company\)/, 'two columns of clients, no more');
  assert.ok(!/monthly_fee|plan|stage/.test(c));
});

test('the migration can be run twice and carries no key', () => {
  assert.ok(!/create (unique )?index (?!if not exists)/.test(code), 'indexes use if not exists');
  assert.ok(!/create table (?!if not exists)/.test(code), 'the table uses if not exists');
  for (const m of code.matchAll(/create policy (\w+) on public\.(\w+)/g))
    assert.ok(code.includes('drop policy if exists ' + m[1] + ' on public.' + m[2]), m[1] + ' is dropped before it is made');
  assert.ok(!/\b(insert into|delete from|update)\b/i.test(code.replace(/update using|for update|create or replace/g, '')), 'no data is written');
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(sql), 'no JWT in the file');
  assert.ok(!/\b(password|secret|api[_-]?key)\s*=/i.test(sql), 'no key in the file');
});

/* ═════════════ the screen ═════════════ */

test('the list pages, and never reads the whole table', async () => {
  reset();
  db.clients.push({ id: 'cA', company: 'Northwind Systems' });
  for (let i = 0; i < 60; i++)
    db.outreach_threads.push({ id: 'n' + i, client_id: 'cA', campaign_id: 'kA', lead_company: 'Lead ' + i,
      lead_name: 'Person ' + i, lead_email: 'p' + i + '@x.com', sentiment: 'unknown', status: 'open',
      meeting_id: null, last_message_at: '2026-11-0' + (i % 9 + 1) + 'T10:00:00Z', created_at: '2026-10-01T09:00:00Z' });
  const first = await A.prThreads({ page: 0 });
  assert.equal(first.data.rows.length, A.PR_PAGE);
  assert.equal(A.PR_PAGE, 25);
  assert.equal(first.data.total, 60);
  assert.equal(first.data.pages, 3);
  const last = await A.prThreads({ page: 2 });
  assert.equal(last.data.rows.length, 10, 'the last page is short, not wrapped');
  /* every select asked the database for a window, not the lot */
  const ranges = seen.filter((s) => s.table === 'outreach_threads').map((s) => s.range);
  assert.ok(ranges.length >= 2 && ranges.every((r) => r && r[1] - r[0] === 24), 'every read is one page wide');

  A.prS.rows = first.data.rows; A.prS.total = 60; A.prS.page = 0; A.prS.clients = [{ id: 'cA', company: 'Northwind Systems' }];
  const html = A.prRenderList();
  assert.match(html, /1–25<\/span> of <span class="pr-fig">60/);
  assert.match(html, /onclick="prGoPage\(1\)"/);
  assert.match(html, /onclick="prGoPage\(-1\)" disabled/, 'Back is dead on the first page');
});

test('search and the four filters each narrow the read, and a typed comma cannot break the query', async () => {
  reset(); seedTwoClients();
  assert.deepEqual(Array.from((await A.prThreads({ q: 'acme' })).data.rows).map((r) => r.id), ['t1'], 'by company, case ignored');
  assert.deepEqual(Array.from((await A.prThreads({ q: 'owen@pike' })).data.rows).map((r) => r.id), ['t2'], 'by email');
  assert.deepEqual(Array.from((await A.prThreads({ sentiment: 'positive' })).data.rows).map((r) => r.id), ['t1']);
  assert.deepEqual(Array.from((await A.prThreads({ booked: 'yes' })).data.rows).map((r) => r.id), ['t1']);
  assert.deepEqual(Array.from((await A.prThreads({ booked: 'no' })).data.rows).map((r) => r.id).sort(), ['t2', 't3', 't4']);
  assert.deepEqual(Array.from((await A.prThreads({ campaign: 'kB' })).data.rows).map((r) => r.id).sort(), ['t3', 't4']);
  assert.deepEqual(Array.from((await A.prThreads({ client: 'cA' })).data.rows).map((r) => r.id).sort(), ['t1', 't2']);
  /* the search box is typed into by a person: what goes into the `or` filter is clean */
  assert.equal(A.prSafeSearch('acme,*(x)%'), 'acme x');
  const before = seen.length;
  await A.prThreads({ q: 'a,b)' });
  const or = seen.slice(before).find((s) => s.filters && s.filters.some((f) => f[0] === 'or')).filters.find((f) => f[0] === 'or')[2];
  assert.ok(!/[(),*%]/.test(or.replace(/%/g, '').replace(/,lead/g, '')), 'nothing a person typed can escape the filter');
});

test('one prospect shows the whole story: the people, every mail, the sentiment, the step, the call', async () => {
  reset(); seedTwoClients();
  await A.prLoadOne('t1');
  const html = A.prRenderOne();
  assert.match(html, /Northwind Systems/, 'whose prospect this is');
  assert.match(html, /Acme Logistics/);
  assert.match(html, /Dana Whitfield · VP Finance/);
  assert.match(html, /dana@acme-logistics\.com/);
  assert.match(html, /Northwind — CFOs Q1/, 'the campaign');
  assert.match(html, /Positive/);
  assert.match(html, /Call booked/);
  assert.match(html, /We sent[\s\S]*We sent[\s\S]*They replied/, 'every message, in order, both ways');
  assert.match(html, /Yes — send me a time\./);
  assert.match(html, /Mails sent<\/p>\s*<b class="pr-fig">2</, 'the figures are mono');
  assert.match(html, /Sequence step<\/p>\s*<b class="pr-fig">2</);
  assert.match(html, /pr-figure-red/, 'the booked call is the one red thing on the screen');
  /* the sequence is counted from the messages, not from a column somebody maintains */
  const seq = A.prSequence(db.outreach_messages.filter((m) => m.thread_id === 't1'));
  assert.equal(seq.sent, 2); assert.equal(seq.replies, 1); assert.equal(seq.waiting, true);
});

test('a reply that did not get through says so, and a prospect’s own words are escaped', async () => {
  reset(); seedTwoClients();
  db.outreach_threads.push({ id: 't9', client_id: 'cA', campaign_id: 'kA', lead_name: '<script>x</script>',
    lead_company: 'Bad & Co "quoted"', sentiment: 'neutral', status: 'answered', meeting_id: null,
    last_message_at: '2026-11-25T10:00:00Z', created_at: '2026-11-01T09:00:00Z' });
  db.outreach_messages.push({ id: 'x9', thread_id: 't9', client_id: 'cA', direction: 'in', subject: '<b>hi</b>',
    body: '<img src=x onerror=alert(1)>', sent_at: '2026-11-25T10:00:00Z', delivery: 'synced' },
    { id: 'x10', thread_id: 't9', client_id: 'cA', direction: 'out', subject: 'Hello', body: 'ours',
      sent_at: '2026-11-24T10:00:00Z', delivery: 'failed', delivery_error: 'mailbox full' });
  await A.prLoadOne('t9');
  const html = A.prRenderOne();
  assert.ok(!html.includes('<script>x</script>') && !html.includes('<img src=x'), 'nothing a prospect wrote is ever markup');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Bad &amp; Co &quot;quoted&quot;/);
  assert.match(html, /Failed/);
  assert.match(html, /mailbox full/);
  assert.match(html, /1 of these did not get through/);
});

test('every screen draws with zero rows, and a database that is down is said in a sentence', async () => {
  reset();
  db.clients.push({ id: 'cA', company: 'Northwind Systems' });
  await A.prLoadList();
  const html = A.prRenderList();
  assert.match(html, /No prospects yet/);
  assert.ok(!/undefined|null|NaN|\[object/.test(html));
  assert.match(A.viewProspects(), /id="prListHost"/);
  assert.match(A.viewProspect(''), /No prospect chosen/);
  /* the screen never throws, whatever comes back */
  const broken = { ...P.sb, from: () => { throw new Error('socket hung up') } };
  const saved = P.sb; P.sb = broken;
  const r = await A.prThreads({});
  assert.equal(r.ok, false); assert.match(r.error, /socket hung up/);
  P.sb = saved;
});

/* ═════════════ the owner giving and taking access away (team.js) ═════════════ */

test('the owner appoints a named person to one client, and can take it back', async () => {
  reset(); seedTwoClients();
  await TA.tmLoadClients();
  TA.tmS.people = db.profiles.slice();
  const made = await TA.tmGrantAdd('emp', 'cA');
  assert.equal(made.ok, true);
  assert.equal(db.prospect_grants.length, 1);
  assert.equal(db.prospect_grants[0].client_id, 'cA');
  assert.equal(db.prospect_grants[0].granted_by, 'owner', 'who gave it is recorded');

  const again = await TA.tmGrantAdd('emp', 'cA');
  assert.equal(again.ok, false);
  assert.match(again.error, /already have that client/);

  /* it works, right away, through the same query the owner runs */
  signIn({ id: 'emp', role: 'employee' });
  assert.equal((await A.prThreads({})).data.total, 2);

  signIn({ id: 'owner', role: 'admin' });
  const gone = await TA.tmGrantRevoke(db.prospect_grants[0].id);
  assert.equal(gone.ok, true);
  assert.ok(db.prospect_grants[0].revoked_at, 'the row stays, marked, as the record of what was taken back');
  signIn({ id: 'emp', role: 'employee' });
  A.prForget();
  assert.equal((await A.prThreads({})).data.total, 0);
});

test('a staff member cannot give themselves a client, and the screen does not offer it', async () => {
  reset(); seedTwoClients();
  signIn({ id: 'emp', role: 'employee' });
  T.authUser = { id: 'emp', uid: 'emp', role: 'employee' };
  const r = await TA.tmGrantAdd('emp', 'cA');
  assert.equal(r.ok, false);
  assert.match(r.error, /Only the owner/);
  assert.equal(db.prospect_grants.length, 0, 'and nothing was written');
  assert.equal(TA.tmRenderGrants(), '', 'the panel is the owner’s only');
  const v = await TA.tmGrantRevoke('g1');
  assert.equal(v.ok, false);
});

test('the Team screen names who holds which client, and says what it does and does not give', async () => {
  reset(); seedTwoClients();
  db.prospect_grants.push({ id: 'g1', user_id: 'emp', client_id: 'cA', revoked_at: null },
                           { id: 'g2', user_id: 'emp', client_id: 'cB', revoked_at: null });
  await TA.tmLoadGrants();
  const html = TA.tmRenderGrants();
  assert.match(html, /Who can see which prospects/);
  assert.match(html, /Priya/);
  assert.match(html, /Northwind Systems/);
  assert.match(html, /Baytown Freight/);
  assert.match(html, /no money, no invoices, no agreements, no settings and no other client/);
  assert.match(html, /onclick="tmDoRevoke\('g1'\)"/);
  assert.match(html, /<select id="tmGrantWho">/);
  const held = TA.tmGrantsByPerson();
  assert.equal(held.length, 1);
  assert.equal(Array.from(held[0].clients).length, 2);
  /* a revoked grant is not listed */
  db.prospect_grants[1].revoked_at = '2026-11-26T00:00:00Z';
  TA.tmS.grants = null;
  await TA.tmLoadGrants();
  const after = TA.tmRenderGrants();
  assert.ok(!after.includes("tmDoRevoke('g2')"), 'the revoked one is no longer held');
  assert.equal(Array.from(TA.tmGrantsByPerson()[0].clients).length, 1);
});

/* ═════════════ the shell ═════════════ */

const html = read('index.html');

test('the shell has the screen, the place in the sidebar, the deep link and the forget hook', () => {
  assert.match(html, /prospects:\{fn:\(\)=>V\('viewProspects'\)/);
  assert.match(html, /prospect:\{fn:\(\)=>V\('viewProspect',currentThreadId\)[^}]*back:\(\)=>render\('prospects'\)/);
  assert.match(html, /\{view:'prospects',icon:I\.inquiry,label:'Prospects'[^}]*also:\['prospect'\]\}/);
  assert.match(html, /<script src="prospects\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="prospects\.css">/);
  assert.match(html, /'prForget'/);
  assert.match(html, /\['prospects','Prospects'/, 'and ⌘K finds it');
  assert.match(html, /prospect\|?/);
});

test('a seat that is one screen wide: the grant lets somebody in, and in to nothing else', () => {
  assert.match(html, /const PROSPECT_SEAT_VIEWS=\['prospects','prospect'\]/);
  assert.match(html, /sb\.rpc\('prospect_seat'\)/, 'the database says whether they hold a grant');
  assert.match(html, /authUser=\{uid:prof\.id,name:prof\.name\|\|'Team member',role:'prospect'/);
  assert.match(html, /if\(hubProspectSeat\(\)\)return PROSPECT_SEAT_VIEWS\.includes\(v\)/);
  assert.match(html, /if\(!hubAllowed\(v\)\)v=hubProspectSeat\(\)\?'prospects':'home'/, 'every other screen sends them back to theirs');
  assert.match(html, /render\(hubProspectSeat\(\)\?'prospects':'home'\)/);
  assert.match(html, /\.filter\(it=>hubAllowed\(it\.view\)\)/, 'the sidebar holds nothing they may not open');
  assert.match(html, /CMDK_SCREENS\.forEach\(\(\[v,label,kw\]\)=>\{if\(!views\[v\]\|\|!hubAllowed\(v\)\)return;/, 'and neither does ⌘K');
});
