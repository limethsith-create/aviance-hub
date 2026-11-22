/* Tests for team.js — the team (profiles) and the work queue (tasks).
   Run with: npm test. No browser, no network: team.js runs in a vm with esc(),
   emptyState(), a tiny document and a fake Supabase client that keeps rows in
   memory, so approving somebody really does take them off the pending list. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── a fake Supabase: rows in memory, same chain as the real one ───────────── */
const db = { profiles: [], tasks: [], clients: [] };
const seen = [];                       // every query, for the assertions that care
let nextId = 1;

const same = (a, b) => String(a) === String(b);
const keep = (rows, filters) => rows.filter(r => filters.every(([kind, col, v]) =>
  kind === 'in' ? v.some(x => same(r[col], x)) : same(r[col], v)));

function run(st) {
  seen.push(st);
  const rows = db[st.table] || [];
  let hit = keep(rows, st.filters);
  let out;
  if (st.op === 'insert') {
    const row = Object.assign({ id: 'id' + nextId++, created_at: new Date().toISOString() }, st.payload);
    rows.push(row); out = [row];
  } else if (st.op === 'update') {
    hit.forEach(r => Object.assign(r, st.payload)); out = hit;
  } else if (st.op === 'delete') {
    db[st.table] = rows.filter(r => hit.indexOf(r) < 0); out = hit;
  } else out = hit;
  const data = st.single ? (out.length ? out[0] : null) : out;
  return Promise.resolve({ data, error: null });
}
function builder(table) {
  const st = { table, op: 'select', payload: null, filters: [], orders: [], single: false };
  const b = {
    select() { return b }, insert(r) { st.op = 'insert'; st.payload = r; return b },
    update(r) { st.op = 'update'; st.payload = r; return b }, delete() { st.op = 'delete'; return b },
    eq(c, v) { st.filters.push(['eq', c, v]); return b }, in(c, v) { st.filters.push(['in', c, v]); return b },
    order(c, o) { st.orders.push([c, o]); return b },
    single() { st.single = true; return b }, maybeSingle() { st.single = true; return b },
    then(res, rej) { return run(st).then(res, rej) },
  };
  return b;
}

const toasts = [];
const sandbox = {
  console, Date, Number, Math, Promise, Array, String, Boolean, Object, JSON, RegExp, Error,
  setTimeout, clearTimeout,
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  emptyState: (icon, title, sub) => `<div class="card"><div class="empty"><h3>${title}</h3><p>${sub}</p></div></div>`,
  toast: (m) => toasts.push(m),
  I: { people: '<svg/>', check: '<svg/>' },
  document: { getElementById: () => null },
  authUser: { id: 'u1', uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@aviance.store' },
  sb: { from: builder, rpc: () => Promise.resolve({ data: null, error: null }) },
};
vm.createContext(sandbox);
const SRC = fs.readFileSync(path.join(root, 'team.js'), 'utf8');
vm.runInContext(SRC + `
;globalThis.api={tmPeople,tmPending,tmApprove,tmSetRole,tmSetStatus,tmSetPersonStatus,
  tmTasks,tmAddTask,tmAssign,tmSetTaskStatus,tmSetDue,tmSetPriority,tmMine,tmByDepartment,
  tmWorkload,viewTeam,viewWork,viewMyWork,tmRenderTeam,tmRenderWork,tmRenderMine,
  tmLoadTeam,tmLoadWork,tmLoadMine,tmForget,tmSortMine,tmS,TM_DEPARTMENTS,TM_ROLES};`,
  sandbox, { filename: 'team.js' });
const A = sandbox.api;

const TODAY = '2026-11-22';
const reset = (over) => {
  db.profiles = []; db.tasks = []; db.clients = []; seen.length = 0; toasts.length = 0; nextId = 1;
  A.tmForget();
  sandbox.authUser = Object.assign({ id: 'u1', uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@aviance.store' }, over || {});
};
const person = (o) => Object.assign({ id: 'u?', email: 'x@aviance.store', name: 'Somebody', role: 'staff', approved: true }, o);
const task = (o) => Object.assign({ id: 't?', title: 'A thing', department: 'sales', status: 'todo', priority: 3, due_on: null, assignee: null, client_id: null, created_at: '2026-11-01T00:00:00Z' }, o);
const tick = () => new Promise(r => setTimeout(r, 5));
/* arrays made inside the vm have the vm's prototype; copy them before a strict compare */
const arr = (x) => Array.from(x);

/* ───────────── the rule that keeps the door open ───────────── */

test('an admin cannot take away their own admin role', async () => {
  reset();
  db.profiles.push(person({ id: 'u1', name: 'Owner', role: 'admin' }));

  for (const role of ['staff', 'viewer']) {
    const r = await A.tmSetRole('u1', role);
    assert.equal(r.ok, false);
    assert.equal(r.data, null);
    assert.match(r.error, /cannot take away your own admin role/i);
    assert.ok(!/[{}<>]|error|code/i.test(r.error.replace(/admin/gi, '')), 'plain sentence, no jargon');
    assert.equal(db.profiles[0].role, 'admin', 'nothing was written');
  }
  // the same change to somebody else is fine, and so is staying admin
  db.profiles.push(person({ id: 'u2', name: 'Nimal', role: 'admin' }));
  assert.equal((await A.tmSetRole('u2', 'staff')).ok, true);
  assert.equal(db.profiles[1].role, 'staff');
  assert.equal((await A.tmSetRole('u1', 'admin')).ok, true);
  assert.equal(db.profiles[0].role, 'admin');
  // and a role that does not exist is refused in plain words
  const bad = await A.tmSetRole('u2', 'owner');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /admin, staff or viewer/);
});

/* ───────────── the screen that matters on day one ───────────── */

test('approve takes somebody off the pending list', async () => {
  reset();
  db.profiles.push(person({ id: 'u1', role: 'admin' }));
  db.profiles.push(person({ id: 'u7', name: 'Dilini', email: 'dilini@aviance.store', approved: false }));

  let pending = await A.tmPending();
  assert.equal(pending.ok, true);
  assert.equal(pending.data.length, 1);
  assert.equal(pending.data[0].id, 'u7');

  const ap = await A.tmApprove('u7');
  assert.equal(ap.ok, true);
  assert.equal(ap.data.approved, true);

  pending = await A.tmPending();
  assert.deepEqual(arr(pending.data), []);
  assert.equal((await A.tmPeople()).data.length, 2, 'they are still on the team list');

  const none = await A.tmApprove('');
  assert.equal(none.ok, false);
  assert.match(none.error, /person to approve/i);
});

/* ───────────── done_at ───────────── */

test("done_at is stamped on 'done' and cleared again", async () => {
  reset();
  const made = await A.tmAddTask({ title: 'Chase Birch Legal', department: 'finance' });
  assert.equal(made.ok, true);
  assert.equal(made.data.status, 'todo');
  assert.equal(made.data.done_at, null);
  const id = made.data.id;

  const done = await A.tmSetTaskStatus(id, 'done');
  assert.equal(done.ok, true);
  assert.equal(done.data.status, 'done');
  assert.ok(done.data.done_at, 'a finish time was stamped');
  assert.ok(!Number.isNaN(Date.parse(done.data.done_at)));

  for (const s of ['doing', 'todo', 'blocked', 'cancelled']) {
    const back = await A.tmSetTaskStatus(id, s);
    assert.equal(back.ok, true);
    assert.equal(back.data.status, s);
    assert.equal(back.data.done_at, null, `done_at cleared on ${s}`);
  }

  // tmSetStatus(id, status) reaches the same place for the five task words
  const viaSet = await A.tmSetStatus(id, 'done');
  assert.equal(viaSet.ok, true);
  assert.ok(viaSet.data.done_at);
  // ...and anything else is a person's line about what they are working on
  db.profiles.push(person({ id: 'u1', role: 'admin' }));
  const line = await A.tmSetStatus('u1', 'Writing the Birch Legal emails');
  assert.equal(line.ok, true);
  assert.equal(db.profiles[0].status, 'Writing the Birch Legal emails');

  const bad = await A.tmSetTaskStatus(id, 'finished');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /to do, doing, blocked, done or cancelled/);
});

/* ───────────── my queue, in the order to pick it up ───────────── */

test('tmMine puts the overdue first, then today, then the rest by priority', async () => {
  reset();
  db.tasks.push(task({ id: 'low',  title: 'Tidy the folder',  assignee: 'u1', priority: 1, due_on: null }));
  db.tasks.push(task({ id: 'soon', title: 'Due today',        assignee: 'u1', priority: 2, due_on: TODAY }));
  db.tasks.push(task({ id: 'late', title: 'Overdue invoice',  assignee: 'u1', priority: 1, due_on: '2026-11-02' }));
  db.tasks.push(task({ id: 'big',  title: 'Later, but urgent', assignee: 'u1', priority: 5, due_on: '2026-12-15' }));
  db.tasks.push(task({ id: 'shut', title: 'Already done',     assignee: 'u1', priority: 5, status: 'done' }));
  db.tasks.push(task({ id: 'hers', title: "Somebody else's",  assignee: 'u2', priority: 5 }));

  const r = await A.tmMine(TODAY);
  assert.equal(r.ok, true);
  assert.deepEqual(arr(r.data).map(x => x.id), ['late', 'soon', 'big', 'low'],
    'overdue, then due today, then the rest heaviest first');

  // nobody signed in: a plain sentence, not a crash
  sandbox.authUser = null;
  const out = await A.tmMine(TODAY);
  assert.equal(out.ok, false);
  assert.match(out.error, /Sign in/);
});

/* ───────────── which of the eight is drowning ───────────── */

test('tmByDepartment counts todo, doing, blocked and overdue across all eight', async () => {
  reset();
  const eight = A.TM_DEPARTMENTS;
  assert.deepEqual(arr(eight), ['marketing', 'sales', 'onboarding', 'operations', 'deliverability', 'finance', 'client_success', 'admin']);

  db.tasks.push(task({ department: 'deliverability', status: 'todo' }));
  db.tasks.push(task({ department: 'deliverability', status: 'doing', due_on: '2026-11-01' }));   // overdue
  db.tasks.push(task({ department: 'deliverability', status: 'blocked', due_on: '2026-10-10' })); // overdue
  db.tasks.push(task({ department: 'sales', status: 'todo', due_on: TODAY }));                    // due today, not overdue
  db.tasks.push(task({ department: 'sales', status: 'done', due_on: '2026-01-01' }));             // closed, counts nowhere
  db.tasks.push(task({ department: 'sales', status: 'cancelled', due_on: '2026-01-01' }));
  db.tasks.push(task({ department: 'client_success', status: 'doing' }));

  const r = await A.tmByDepartment(TODAY);
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 8, 'all eight are always listed');
  assert.deepEqual(arr(r.data).map(x => x.department), arr(eight), 'in the fixed order');

  const by = {};
  r.data.forEach(x => { by[x.department] = x });
  assert.deepEqual(
    { todo: by.deliverability.todo, doing: by.deliverability.doing, blocked: by.deliverability.blocked, overdue: by.deliverability.overdue, open: by.deliverability.open },
    { todo: 1, doing: 1, blocked: 1, overdue: 2, open: 3 });
  assert.deepEqual({ todo: by.sales.todo, overdue: by.sales.overdue, open: by.sales.open }, { todo: 1, overdue: 0, open: 1 });
  assert.equal(by.client_success.doing, 1);
  assert.equal(by.client_success.label, 'Client success');
  for (const d of ['marketing', 'onboarding', 'operations', 'finance', 'admin']) {
    assert.deepEqual({ todo: by[d].todo, doing: by[d].doing, blocked: by[d].blocked, overdue: by[d].overdue, open: by[d].open },
      { todo: 0, doing: 0, blocked: 0, overdue: 0, open: 0 }, d + ' is quiet');
  }
});

/* ───────────── who is buried ───────────── */

test('tmWorkload weighs open tasks by priority', async () => {
  reset();
  db.profiles.push(person({ id: 'u1', name: 'Asela', role: 'admin', title: 'Owner' }));
  db.profiles.push(person({ id: 'u2', name: 'Bimal' }));
  db.profiles.push(person({ id: 'u3', name: 'Chatura' }));
  db.profiles.push(person({ id: 'u4', name: 'Waiting', approved: false }));

  db.tasks.push(task({ assignee: 'u1', priority: 5 }));
  db.tasks.push(task({ assignee: 'u1', priority: 3, due_on: '2026-11-01' }));   // overdue
  db.tasks.push(task({ assignee: 'u1', priority: 5, status: 'done' }));          // closed, no weight
  db.tasks.push(task({ assignee: 'u2', priority: 1 }));
  db.tasks.push(task({ assignee: 'u2', priority: 1 }));
  db.tasks.push(task({ assignee: 'u2', priority: 1 }));
  db.tasks.push(task({ assignee: 'u2', priority: 1 }));
  db.tasks.push(task({ assignee: null, priority: 5 }));                          // nobody's yet

  const r = await A.tmWorkload(TODAY);
  assert.equal(r.ok, true);
  assert.deepEqual(arr(r.data).map(x => x.name), ['Asela', 'Bimal', 'Chatura'],
    'only approved people, heaviest first');
  assert.deepEqual(arr(r.data).map(x => [x.open, x.weight, x.overdue]),
    [[2, 8, 1], [4, 4, 0], [0, 0, 0]],
    'two urgent tasks outweigh four small ones');
  assert.equal(r.data[0].init, 'A');
});

/* ───────────── every screen with zero rows ───────────── */

test('every screen renders with zero rows in the database', async () => {
  reset();
  // before anything has loaded: a quiet line, never a crash
  for (const v of [A.viewTeam(), A.viewWork(), A.viewMyWork()]) assert.match(v, /Loading/);
  await tick();

  reset();
  await A.tmLoadTeam();
  const team = A.viewTeam();
  assert.match(team, /Nobody here yet/);
  assert.ok(!/undefined|NaN|\[object/.test(team), team.slice(0, 200));

  reset();
  await A.tmLoadWork();
  const work = A.viewWork();
  assert.match(work, /The queue is empty/);
  assert.match(work, /All eight/);
  for (const d of ['Marketing', 'Deliverability', 'Client success', 'Admin']) assert.ok(work.includes(d), d);
  assert.ok(!/undefined|NaN|\[object/.test(work));

  reset();
  await A.tmLoadMine();
  const mine = A.viewMyWork();
  assert.match(mine, /Nothing on you/);
  assert.ok(!/undefined|NaN|\[object/.test(mine));
});

test('the screens hold up with rows, and everything from a person is escaped', async () => {
  reset();
  db.clients.push({ id: 'c1', company: 'Birch <b>Legal</b>' });
  db.profiles.push(person({ id: 'u1', name: '<img src=x>', role: 'admin', title: 'Owner', status: 'On the <script>' }));
  db.profiles.push(person({ id: 'u9', name: 'Waiting', email: 'w@aviance.store', approved: false }));
  db.tasks.push(task({ id: 't1', title: 'Fix <b>bounces</b>', department: 'deliverability', assignee: 'u1', priority: 5, due_on: '2026-11-01', client_id: 'c1' }));
  db.tasks.push(task({ id: 't2', title: 'Call back', department: 'sales', status: 'blocked', due_on: TODAY }));
  db.tasks.push(task({ id: 't3', title: 'Shipped', department: 'admin', status: 'done' }));

  await A.tmLoadTeam();
  const team = A.tmRenderTeam(TODAY);
  assert.match(team, /Waiting to be let in/);
  assert.ok(team.indexOf('Waiting to be let in') < team.indexOf('The team'), 'pending sits at the top');
  assert.match(team, /tmDoApprove\('u9'\)/);
  assert.ok(team.includes('&lt;img src=x&gt;') && !team.includes('<img src=x>'));
  assert.ok(team.includes('&lt;script&gt;') && !team.includes('<script>'));
  assert.ok(team.includes('Admin') && team.includes('Owner'));

  await A.tmLoadWork();
  const work = A.tmRenderWork(TODAY);
  for (const col of ['To do', 'Doing', 'Blocked', 'Done']) assert.ok(work.includes('<h4>' + col + '</h4>'), col);
  assert.ok(work.includes('Fix &lt;b&gt;bounces&lt;/b&gt;') && !work.includes('Fix <b>bounces</b>'));
  assert.ok(work.includes('Birch &lt;b&gt;Legal') && !work.includes('Birch <b>Legal</b>'), 'the client is on the card');
  assert.ok(work.includes('Deliverability'), 'the department is on the card');
  assert.ok(work.includes('Overdue · 2026-11-01'), 'the due date is on the card');
  assert.ok(work.includes('Due today'));

  await A.tmLoadMine();
  const mine = A.tmRenderMine(TODAY);
  assert.match(mine, /1 overdue/);
  assert.ok(mine.includes('Fix &lt;b&gt;bounces'));
});

/* ───────────── the house rules ───────────── */

test('nothing calls another server, and every global is prefixed tm', () => {
  assert.ok(!/machineFetch|MACHINE_URL|email-distributor/.test(SRC), 'no machine');
  assert.ok(!/\bimport\b|\brequire\(/.test(SRC), 'no imports, no build step');
  for (const bad of ['seats', 'warm-up', 'warmup', 'API key', 'api_key']) {
    assert.ok(!SRC.toLowerCase().includes(bad.toLowerCase()), bad + ' is gone');
  }
  const names = [...SRC.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^const\s+([A-Za-z0-9_$]+)/gm)]
    .map(m => m[1] || m[2]);
  assert.ok(names.length > 20);
  for (const n of names) {
    assert.ok(/^(tm|TM_|view(Team|Work|MyWork)$)/.test(n), n + ' is not prefixed tm');
  }
  // the three screens are the only non-tm names, as the hub's render() expects
  assert.ok(names.includes('viewTeam') && names.includes('viewWork') && names.includes('viewMyWork'));
});

test('bad input is refused in plain words, and nothing ever throws', async () => {
  reset();
  const refusals = await Promise.all([
    A.tmAddTask({ title: '', department: 'sales' }),
    A.tmAddTask({ title: 'No home', department: 'legal' }),
    A.tmSetPriority('t1', 0), A.tmSetPriority('t1', 6), A.tmSetPriority('t1', 2.5),
    A.tmSetDue('t1', 'next Tuesday'), A.tmAssign('', 'u1'),
  ]);
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.equal(r.data, null);
    assert.match(r.error, /^[A-Z].*[.?]$/, 'one plain sentence: ' + r.error);
  }
  const good = await A.tmAddTask({ title: 'Watch the bounce rate', department: 'deliverability', priority: 4, due_on: '2026-11-30', assignee: 'u1', client_id: 'c1' });
  assert.equal(good.ok, true);
  assert.equal(good.data.priority, 4);
  assert.equal(good.data.due_on, '2026-11-30');
  assert.equal(good.data.created_by, 'u1');
  assert.equal((await A.tmSetPriority(good.data.id, 5)).data.priority, 5);
  assert.equal((await A.tmSetDue(good.data.id, null)).data.due_on, null);
  assert.equal((await A.tmAssign(good.data.id, null)).data.assignee, null);

  // a database that answers with an error becomes a sentence, not a throw
  const broken = { from: () => ({ select: () => ({ order: () => Promise.resolve({ error: { message: 'The database is asleep.' } }) }) }) };
  const realSb = sandbox.sb; sandbox.sb = broken;
  const r = await A.tmPeople();
  sandbox.sb = realSb;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'The database is asleep.');
});
