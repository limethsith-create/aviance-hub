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
const db = { profiles: [], tasks: [], clients: [], prospect_grants: [] };
const seen = [];                       // every query, for the assertions that care
let nextId = 1;

const same = (a, b) => String(a) === String(b);
const keep = (rows, filters) => rows.filter(r => filters.every(([kind, col, v]) =>
  kind === 'in' ? v.some(x => same(r[col], x))
  : kind === 'is' ? (v === null ? (r[col] === null || r[col] === undefined) : r[col] === v)
  : same(r[col], v)));

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
    is(c, v) { st.filters.push(['is', c, v]); return b },
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
vm.runInContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), sandbox, { filename: 'core.js' });
const SRC = fs.readFileSync(path.join(root, 'team.js'), 'utf8');
vm.runInContext(SRC + `
;globalThis.api={tmPeople,tmPending,tmApprove,tmSetRole,tmSetStatus,tmSetPersonStatus,
  tmTasks,tmAddTask,tmAssign,tmSetTaskStatus,tmSetDue,tmSetPriority,tmMine,tmByDepartment,
  tmWorkload,viewTeam,viewWork,viewMyWork,tmRenderTeam,tmRenderWork,tmRenderMine,
  tmLoadTeam,tmLoadWork,tmLoadMine,tmForget,tmSortMine,tmS,TM_DEPARTMENTS,TM_ROLES,
  tmLoadClients,tmLoadGrants,tmRenderGrants,tmRoleLabel};`,
  sandbox, { filename: 'team.js' });
const A = sandbox.api;

const TODAY = '2026-11-22';
const reset = (over) => {
  db.profiles = []; db.tasks = []; db.clients = []; db.prospect_grants = []; seen.length = 0; toasts.length = 0; nextId = 1;
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

  for (const role of ['employee']) {
    const r = await A.tmSetRole('u1', role);
    assert.equal(r.ok, false);
    assert.equal(r.data, null);
    assert.match(r.error, /cannot take away your own admin role/i);
    assert.ok(!/[{}<>]|error|code/i.test(r.error.replace(/admin/gi, '')), 'plain sentence, no jargon');
    assert.equal(db.profiles[0].role, 'admin', 'nothing was written');
  }
  // the same change to somebody else is fine, and so is staying admin
  db.profiles.push(person({ id: 'u2', name: 'Nimal', role: 'admin' }));
  assert.equal((await A.tmSetRole('u2', 'employee')).ok, true);
  assert.equal(db.profiles[1].role, 'employee');
  assert.equal((await A.tmSetRole('u1', 'admin')).ok, true);
  assert.equal(db.profiles[0].role, 'admin');
  // and a role that does not exist is refused in plain words
  const bad = await A.tmSetRole('u2', 'owner');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /admin or team member/);
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

test('two filter clicks in a row: the answer for the chip he left behind never lands', async () => {
  reset();
  db.tasks.push(task({ id: 't1', department: 'sales', title: 'Sales thing' }),
                task({ id: 't2', department: 'operations', title: 'Ops thing' }));
  A.tmS.dept = 'sales';
  const first = A.tmLoadWork();            // the read for "sales" is already on its way
  A.tmS.dept = 'operations';               // he clicks the next chip before it comes back
  const second = A.tmLoadWork();
  await Promise.all([first, second]);
  assert.deepEqual(arr(A.tmS.tasks).map(t => t.id), ['t2'],
    'the board holds the tasks for the chip he picked last, not the one he left behind');
  // and a second click while nothing is in flight still loads: the old busy flag used to swallow it
  A.tmS.dept = 'sales';
  await A.tmLoadWork();
  assert.deepEqual(arr(A.tmS.tasks).map(t => t.id), ['t1']);
});

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

/* ==========================================================================
   The employee's own screen: team.html + team-page.js (agent C).
   Nothing here touches a browser or the network. team-page.js runs in its own
   vm context with a fake Supabase client handed in through tmcUseClient, so
   every pure builder can be checked as a string and every data call can be
   made to fail on purpose. `tmc` (team chat) is a different prefix from the
   hub's own `tm` above, and the two sections do not share state.
   ========================================================================== */

const tmcSandbox = {
  console, Date, Number, Math, Promise, Array, String, Boolean, Object, JSON, RegExp, Error, isFinite,
  setTimeout, clearTimeout, crypto,
};
vm.createContext(tmcSandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), tmcSandbox, { filename: 'core.js' });
const TMC_SRC = fs.readFileSync(path.join(root, 'team-page.js'), 'utf8');
vm.runInContext(TMC_SRC + `
;globalThis.api={tmcEsc,tmcCleanBody,tmcEmailProblem,tmcCodeProblem,tmcCleanCode,tmcExt,tmcIsImage,
  tmcSize,tmcFileProblem,tmcFilePath,tmcFileLabel,tmcTime,tmcDayKey,tmcDayLabel,
  tmcGroupMessages,tmcSeenLine,tmcLoadingHtml,tmcOfflineHtml,tmcNoticeHtml,tmcSignInHtml,
  tmcChannelHtml,tmcThreadHtml,tmcAttachmentHtml,tmcPendingHtml,tmcPathsToSign,tmcSay,
  tmcSignIn,tmcSignOut,tmcSession,tmcMe,tmcSend,tmcSeen,tmcUpload,tmcFileUrl,tmcUseClient,
  TMC_OWNER,TMC_MAX_BODY,TMC_POLL_MS,TMC_OFFLINE,TMC_BAD_CODE,TMC_NO_ACCOUNT,TMC_NOT_READY,
  TMC_HISTORY_NOTE,TMC_BUCKET};`, tmcSandbox, { filename: 'team-page.js' });
const C = tmcSandbox.api;

const teamHtml = fs.readFileSync(path.join(root, 'team.html'), 'utf8');
/* the visible page: comments and the inline script are how the page works, not
   what she is shown, so the "nothing from the hub" check reads the rest */
const teamShown = teamHtml.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
/* values made inside the vm carry the vm's prototypes; compare through JSON */
const plain = (x) => JSON.parse(JSON.stringify(x));
const sameJson = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);
const teamPageSrc = TMC_SRC;

/* a fake Supabase: records what was asked for, answers what the test sets */
let tmcCalls, tmcRpcAnswer, tmcAuthAnswer, tmcStoreAnswer;
function tmcFake() {
  return {
    async rpc(name, args) { tmcCalls.push(['rpc', name, args]); const a = tmcRpcAnswer; if (a instanceof Error) throw a; return typeof a === 'function' ? a(name, args) : a; },
    auth: {
      async signInWithPassword(creds) { tmcCalls.push(['signIn', creds]); const a = tmcAuthAnswer; if (a instanceof Error) throw a; return a; },
      async signOut() { tmcCalls.push(['signOut']); return { error: null }; },
      async getSession() { tmcCalls.push(['getSession']); const a = tmcAuthAnswer; if (a instanceof Error) throw a; return a; },
      onAuthStateChange() { return { data: null }; },
    },
    storage: {
      from(bucket) {
        return {
          async upload(p, file, opts) { tmcCalls.push(['upload', bucket, p, file && file.name, opts]); const a = tmcStoreAnswer; if (a instanceof Error) throw a; return a; },
          async createSignedUrl(p, secs) { tmcCalls.push(['sign', bucket, p, secs]); const a = tmcStoreAnswer; if (a instanceof Error) throw a; return a; },
        };
      },
    },
  };
}
function tmcReset() {
  tmcCalls = [];
  tmcRpcAnswer = { data: null, error: null };
  tmcAuthAnswer = { data: { session: null }, error: null };
  tmcStoreAnswer = { data: { path: 'p' }, error: null };
  C.tmcUseClient(tmcFake());
}

/* a little bit of her channel, with text that would break a page if it were not escaped */
const NASTY_NAME = 'Dilini "Dee" <b>O\'Brien</b>';
const NASTY_BODY = '<script>alert(1)</script> & "quotes" & \'apostrophes\'';
const at = (d, h, m) => new Date(2026, 10, d, h, m).toISOString();
const ME = (over = {}) => Object.assign({
  staff: { id: 's1', name: NASTY_NAME, email: 'dilini+staff@gmail.com' },
  channel: { id: 'ch-1', name: NASTY_NAME },
  owner: { name: 'Limethsith' },
  messages: [],
}, over);

/* ───────────── escaping: her name, her email, her words ───────────── */

test('her screen: every bit of text she or he typed is escaped', () => {
  const e = C.tmcEsc;
  assert.equal(e(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(e(null), ''); assert.equal(e(undefined), ''); assert.equal(e(0), '0');

  // her name and her email in the bar, and in the sign-in box
  const bar = C.tmcChannelHtml(ME());
  assert.ok(bar.includes(e(NASTY_NAME)), 'her name is escaped into the bar');
  assert.doesNotMatch(bar, /<b>O'Brien<\/b>/, 'no raw tag from her name');
  assert.doesNotMatch(bar, /<script/i);
  const form = C.tmcSignInHtml({ email: 'dee"><script>x</script>@gmail.com', error: NASTY_BODY });
  assert.doesNotMatch(form, /<script>/, 'no script from the email box or the error line');
  assert.match(form, /value="dee&quot;&gt;&lt;script&gt;/, 'the email is escaped inside the attribute');

  // her message body and his
  const days = C.tmcGroupMessages(ME({ messages: [
    { id: 1, author_user: 's1', body: NASTY_BODY, created_at: at(24, 9, 0) },
    { id: 2, author_user: 'owner', body: '<b>hi</b>', created_at: at(24, 9, 30) },
  ] }), new Date(2026, 10, 24, 12, 0));
  const thread = C.tmcThreadHtml(days, {});
  assert.doesNotMatch(thread, /<script>/);
  assert.doesNotMatch(thread, /<b>hi<\/b>/);
  assert.match(thread, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(thread, /&amp; &quot;quotes&quot; &amp; &#39;apostrophes&#39;/);
  assert.ok(thread.includes(C.tmcEsc(NASTY_NAME)), 'her name on the message head is escaped');
});

/* ───────────── the empty state and the loading / error states ───────────── */

test('her channel with nothing in it says what the channel is for, and loading says Loading', () => {
  const empty = C.tmcThreadHtml([], {});
  assert.match(empty, /class="tmc-empty"/);
  assert.ok(empty.includes(C.tmcEsc(C.TMC_HISTORY_NOTE)));
  assert.match(empty, /private line to Limethsith/);
  assert.equal(C.tmcThreadHtml(null, null), empty, 'junk in, the same calm empty state out');
  assert.equal(C.tmcThreadHtml(undefined), empty);
  assert.match(C.tmcLoadingHtml(), /aria-busy="true"/);
  assert.match(C.tmcLoadingHtml(), />Loading</);
});

test('the error state offers one Try again and never shows a database message', () => {
  const h = C.tmcOfflineHtml();
  assert.ok(h.includes(C.tmcEsc(C.TMC_OFFLINE)));
  assert.match(h, /data-tmc-retry/);
  assert.equal((h.match(/<button/g) || []).length, 1, 'one button, nothing else to press');
  assert.doesNotMatch(h, /row-level|permission denied|PGRST|42501|supabase/i);
  // a raw error never reaches her: tmcSay turns each one into plain words
  const say = C.tmcSay;
  assert.equal(say({ message: 'TypeError: Failed to fetch' }), C.TMC_OFFLINE);
  assert.equal(say({ message: 'Invalid login credentials' }), C.TMC_BAD_CODE);
  assert.equal(say({ message: 'User not found' }), C.TMC_NO_ACCOUNT);
  assert.equal(say({ message: 'permission denied for table channel_messages' }), C.TMC_NOT_READY);
  assert.equal(say({ message: 'new row violates row-level security policy' }), C.TMC_NOT_READY);
  assert.match(say({ message: 'Too many requests' }), /Wait a minute/);
  assert.equal(say({ message: 'something nobody planned for' }, 'Please try again.'), 'Please try again.');
  for (const m of ['Failed to fetch', 'Invalid login credentials', 'permission denied for table clients']) {
    const out = say({ message: m });
    assert.doesNotMatch(out, /table|policy|schema|jwt|sql/i, 'no jargon in: ' + out);
    assert.match(out, /^[A-Z].*[.?]$/s, 'one plain sentence: ' + out);
  }
});

/* ───────────── sign in vs her channel: the two states of team.html ───────────── */

test('the sign-in state asks for an email and a code, and offers no other way in', () => {
  const h = C.tmcSignInHtml({});
  assert.match(h, /id="tmcInForm"/);
  assert.match(h, /id="tmcInEmail"[^>]*type="email"/);
  assert.match(h, /id="tmcInCode"[^>]*type="password"/, 'the code is not shown as she types it');
  assert.match(h, />Access code</, 'it is called a code to her');
  const shown = h.replace(/<[^>]+>/g, ' ');            // the words she actually reads
  assert.doesNotMatch(shown, /password/i, 'she never hears the word password');
  assert.doesNotMatch(h, /sign ?up|create an account|register/i, 'no sign-up');
  assert.doesNotMatch(h, /forgot|reset|magic link|one-time link/i, 'no self-service reset — he re-keys it');
  assert.match(h, /Ask Limethsith/, 'the only route when the code fails is to ask him');
  assert.doesNotMatch(h, /<a\s/i, 'no links at all on the sign-in screen');
  // an error from a previous try is shown in the live region, and the state is remembered
  const withErr = C.tmcSignInHtml({ email: 'dee@gmail.com', error: C.TMC_BAD_CODE, busy: true });
  assert.match(withErr, /id="tmcInErr" role="alert"/);
  assert.ok(withErr.includes(C.tmcEsc(C.TMC_BAD_CODE)));
  assert.match(withErr, /value="dee@gmail.com"/, 'her email survives a wrong code');
  assert.match(withErr, /id="tmcInBtn" disabled/, 'the button locks while it is trying');
  assert.match(withErr, /Signing in…/);
});

test('the channel state is her name, his name, the thread and a send box — and nothing else', () => {
  const h = C.tmcChannelHtml(ME());
  assert.match(h, /<h1>Limethsith<\/h1>/, 'his name at the top');
  assert.ok(h.includes(C.tmcEsc(NASTY_NAME)), 'her own name beside the Aviance tag');
  assert.match(h, /id="tmcThread"[^>]*role="log"/);
  assert.match(h, /id="tmcCompose"/);
  assert.match(h, /id="tmcText"[^>]*maxlength="4000"/);
  assert.match(h, /id="tmcFile"[^>]*accept="image\/\*,\.pdf,\.docx,\.csv"/, 'she can attach a file or an image');
  assert.match(h, /id="tmcOut">Sign out</, 'she can leave');
  assert.doesNotMatch(h, /<nav|sidebar|aside/i, 'no sidebar on her page');
  // with no owner name yet it still reads as Aviance, not as "undefined"
  const bare = C.tmcChannelHtml({ staff: { id: 's1' }, channel: { id: 'c' } });
  assert.match(bare, /<h1>Limethsith<\/h1>/);
  assert.doesNotMatch(bare, /undefined|null/);
  assert.doesNotMatch(C.tmcChannelHtml(null), /undefined|null/);
});

/* ───────────── nothing on her page points at the rest of the hub ───────────── */

test('team.html mentions no other part of the hub, and loads no hub module', () => {
  const page = teamShown.replace(/<[^>]+>/g, ' ').toLowerCase();
  // the words for everything she must never know is there
  for (const word of ['client', 'invoice', 'setting', 'booking', 'pipeline', 'outreach', 'agreement',
    'document', 'meeting', 'calendar', 'finance', 'revenue', 'draft', 'approval', 'journey',
    'employee', 'onboarding', 'wrapup', 'digest', 'dashboard', 'admin']) {
    assert.doesNotMatch(page, new RegExp(word), 'team.html must not say "' + word + '"');
  }
  // and no hub script or stylesheet is pulled in: only her own two files plus the shared theme
  const srcs = [...teamHtml.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  /* core.js is the shared leaf helpers, loaded first on every page of the site. It holds no
     hub knowledge — no client, no invoice, no query — so it tells her nothing; it is there so
     her page escapes and dates from the same one copy as everything else. */
  assert.deepEqual(srcs.filter((s) => !/^https:/.test(s)), ['core.js', 'team-page.js'], 'her own file plus the shared helpers: ' + srcs.join(' '));
  const css = [...teamHtml.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  // brand.css is the shared look, like theme.css — not a hub module
  assert.deepEqual(css, ['theme.css', 'polish.css', 'team-page.css', 'brand.css']);
  for (const hub of ['index.html', 'channels.js', 'clientbook.js', 'settings.js', 'portal.js', 'app.js']) {
    assert.ok(!teamHtml.includes(hub), 'no reference to ' + hub);
  }
  // she is never sent anywhere else in the hub, and search engines are kept out
  assert.doesNotMatch(teamHtml, /href="\/(?!icon|apple|fonts)[a-z]/i, 'no link into the hub');
  assert.match(teamHtml, /name="robots" content="noindex,nofollow"/);
  // and the page is built for a phone
  assert.match(teamHtml, /name="viewport" content="width=device-width,initial-scale=1/);
  const cssText = fs.readFileSync(path.join(root, 'team-page.css'), 'utf8');
  assert.match(cssText, /360 ?px/, 'the stylesheet is written mobile-first');
  assert.match(cssText, /@media \(min-width:600px\)/, 'it only loosens on a bigger screen');
});

test('team-page.js only ever calls the three staff functions, and keeps its own login box', () => {
  const rpcNames = [...teamPageSrc.matchAll(/tmcRpc\('([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(rpcNames)], ['staff_me', 'staff_seen', 'staff_send']);
  assert.doesNotMatch(teamPageSrc, /\.from\((?!TMC_BUCKET)/, 'no table is ever read directly');
  assert.match(teamPageSrc, /storageKey: 'aviance-team-auth'/);
  assert.match(teamPageSrc, /persistSession: true/);
  assert.match(teamPageSrc, /detectSessionInUrl: false/);
  assert.equal(C.TMC_POLL_MS, 8000, 'polls about every eight seconds');
  assert.equal(C.TMC_BUCKET, 'chat-files');
});

/* ───────────── the thread: order, grouping, the "Seen" line ───────────── */

test('messages are grouped by day, oldest first, hers on one side and his on the other', () => {
  const now = new Date(2026, 10, 24, 12, 0);
  const days = C.tmcGroupMessages(ME({ messages: [
    { id: 3, author_user: 's1', body: 'three', created_at: at(24, 9, 0) },
    { id: 1, author_user: 'owner', body: 'one', created_at: at(23, 10, 0) },
    { id: 2, author_user: 'owner', body: 'two', created_at: at(23, 10, 2) },
    { id: 4, author_user: 'owner', body: 'four', created_at: at(24, 9, 40) },
  ] }), now);
  sameJson(days.map((d) => d.label), ['Yesterday', 'Today']);
  sameJson(days[0].items.map((m) => [m.id, m.mine, m.name, m.lead]),
    [[1, false, 'Limethsith', true], [2, false, 'Limethsith', false]], 'his two in a row share one head');
  sameJson(days[1].items.map((m) => [m.id, m.mine, m.lead]), [[3, true, true], [4, false, true]]);
  assert.equal(days[1].items[0].name, NASTY_NAME, 'her own name on her own messages');
  assert.match(days[1].items[0].time, /\d/);
});

test('a removed message, a repeat and junk are all left out, and nothing throws', () => {
  const now = new Date(2026, 10, 24, 12, 0);
  const days = C.tmcGroupMessages(ME({ messages: [
    { id: 1, author_user: 's1', body: 'here', created_at: at(24, 9, 0) },
    { id: 1, author_user: 's1', body: 'here', created_at: at(24, 9, 0) },
    { id: 2, author_user: 'owner', body: 'gone', created_at: at(24, 9, 1), deleted_at: at(24, 9, 2) },
    { id: null, body: 'no id', created_at: at(24, 9, 3) },
    null,
  ] }), now);
  assert.equal(days.length, 1);
  sameJson(days[0].items.map((m) => m.id), [1]);
  sameJson(C.tmcGroupMessages(null, now), []);
  sameJson(C.tmcGroupMessages({ messages: 'not a list' }, now), []);
});

test('"Seen" only once he has really read it, and under her last message alone', () => {
  const now = new Date(2026, 10, 24, 12, 0);
  const mine = [{ id: 1, author_user: 's1', body: 'did you see this?', created_at: at(24, 9, 0) }];
  // nothing read yet: Sent, never a guess at Seen
  assert.equal(C.tmcSeenLine(ME({ messages: mine }), now), 'Sent');
  // read before she wrote: still only Sent
  assert.equal(C.tmcSeenLine(ME({ messages: mine, owner: { name: 'L', last_read_at: at(24, 8, 0) } }), now), 'Sent');
  // read after she wrote: Seen with the time
  const seen = C.tmcSeenLine(ME({ messages: mine, owner: { name: 'L', last_read_at: at(24, 9, 30) } }), now);
  assert.match(seen, /^Seen \d/);
  assert.doesNotMatch(seen, / on /, 'same day: just the time');
  // read on an earlier day says which day
  const older = C.tmcSeenLine(ME({ messages: [{ id: 1, author_user: 's1', body: 'x', created_at: at(22, 9, 0) }],
    owner: { name: 'L', last_read_at: at(22, 10, 0) } }), now);
  assert.match(older, /^Seen \d.* on /);
  // his was the last word, or there is nothing of hers: no line at all
  assert.equal(C.tmcSeenLine(ME({ messages: [{ id: 9, author_user: 'owner', body: 'hi', created_at: at(24, 9, 0) }] }), now), '');
  assert.equal(C.tmcSeenLine(ME(), now), '');
  assert.equal(C.tmcSeenLine(null, now), '');
  // the line is drawn under her last message and nowhere else
  const days = C.tmcGroupMessages(ME({ messages: [
    { id: 1, author_user: 's1', body: 'first', created_at: at(24, 9, 0) },
    { id: 2, author_user: 's1', body: 'second', created_at: at(24, 9, 10) },
  ] }), now);
  const html = C.tmcThreadHtml(days, { seen: 'Seen 09:11' });
  assert.equal((html.match(/class="tmc-seen"/g) || []).length, 1);
  assert.ok(html.indexOf('second') < html.indexOf('tmc-seen'), 'it sits under the last one');
  // and never under his
  const his = C.tmcGroupMessages(ME({ messages: [{ id: 1, author_user: 'owner', body: 'mine', created_at: at(24, 9, 0) }] }), now);
  assert.doesNotMatch(C.tmcThreadHtml(his, { seen: 'Seen 09:11' }), /tmc-seen/);
});

/* ───────────── a message with a file on it ───────────── */

test('a message with an attachment: a picture when it is signed, a chip when it is not', () => {
  const now = new Date(2026, 10, 24, 12, 0);
  const days = C.tmcGroupMessages(ME({ messages: [
    { id: 1, author_user: 's1', body: 'the invoice photo', attachment_url: 'ch-1/aaaa-bbbb.png', created_at: at(24, 9, 0) },
    { id: 2, author_user: 'owner', body: 'and the brief', attachment_url: 'ch-1/cccc-dddd.pdf', created_at: at(24, 9, 5) },
  ] }), now);
  // before any link is signed, each file is a button that asks for one
  const cold = C.tmcThreadHtml(days, {});
  assert.match(cold, /<button type="button" class="tmc-file" data-tmc-open="ch-1\/aaaa-bbbb\.png">/);
  assert.match(cold, /<span>aaaa-bbbb\.png<\/span>/, 'only the file name, never the folder');
  assert.doesNotMatch(cold, /<img[^>]*src="ch-1/, 'a bare storage path is never used as a src');
  // with a signed link, an image is shown and a pdf stays a link
  const warm = C.tmcThreadHtml(days, { urls: {
    'ch-1/aaaa-bbbb.png': 'https://zjbxnkpktbghhudjbxhk.supabase.co/storage/v1/object/sign/chat-files/ch-1/aaaa-bbbb.png?token=x',
    'ch-1/cccc-dddd.pdf': 'https://zjbxnkpktbghhudjbxhk.supabase.co/storage/v1/object/sign/chat-files/ch-1/cccc-dddd.pdf?token=y',
  } });
  assert.match(warm, /<a class="tmc-shot" href="https:\/\/[^"]*aaaa-bbbb\.png\?token=x"/);
  assert.match(warm, /<img src="https:\/\/[^"]*" alt="aaaa-bbbb\.png" loading="lazy">/);
  assert.match(warm, /<a class="tmc-file" href="https:\/\/[^"]*cccc-dddd\.pdf\?token=y"[^>]*rel="noopener noreferrer"/);
  assert.match(warm, /the invoice photo/);
  // anything that is not a plain https link is refused as a link
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'http://x.example/a.png',
    'https://a.example/"onmouseover="x', '', null]) {
    const h = C.tmcAttachmentHtml('ch-1/aaaa-bbbb.png', { 'ch-1/aaaa-bbbb.png': bad });
    assert.match(h, /^<button type="button"/, 'bad link falls back to the button: ' + bad);
    assert.doesNotMatch(h, /javascript:|onmouseover|data:text/i);
  }
  // a file path with a quote or a tag in it cannot break out of the attribute
  const nasty = C.tmcAttachmentHtml('ch-1/" onclick="x()" <b>.png', {});
  assert.doesNotMatch(nasty, /onclick="x\(\)"/);
  assert.match(nasty, /&quot;|&lt;/);
  assert.equal(C.tmcAttachmentHtml('', {}), '', 'no file, no markup');
  assert.equal(C.tmcAttachmentHtml(null), '');
});

test('the file she has chosen but not sent is shown with its size and a way to drop it', () => {
  const chip = C.tmcPendingHtml({ name: 'quote <final>.pdf', size: 1.4 * 1024 * 1024 });
  assert.match(chip, /quote &lt;final&gt;\.pdf/);
  assert.match(chip, /1\.4 MB/);
  assert.match(chip, /data-tmc-drop aria-label="Remove quote &lt;final&gt;\.pdf"/);
  assert.equal(C.tmcPendingHtml(null), '');
  assert.equal(C.tmcPendingHtml({}), '');
});

test('what she may attach, and where it is stored', () => {
  const p = C.tmcFileProblem;
  assert.equal(p({ name: 'shot.png', size: 2000 }), '');
  assert.equal(p({ name: 'notes.PDF', size: 2000 }), '');
  assert.equal(p({ name: 'list.csv', size: 2000 }), '');
  assert.match(p({ name: 'app.exe', size: 2000 }), /image, a PDF, a Word file or a CSV/);
  assert.match(p({ name: 'big.png', size: 11 * 1024 * 1024 }), /too big. The limit is 10 MB/);
  assert.match(p({ name: 'empty.png', size: 0 }), /empty/);
  assert.match(p({}), /Choose a file first/);
  assert.match(p(null), /Choose a file first/);
  // the stored path is her channel's folder and a fresh id — never her file name
  const path1 = C.tmcFilePath('ch-1', '../../owner/secret.png', 'aaaaaaaa-bbbb');
  assert.equal(path1, 'ch-1/aaaaaaaa-bbbb.png', 'nothing of the name, no way up a folder');
  assert.doesNotMatch(path1, /\.\./);
  assert.match(C.tmcFilePath('ch-1', 'a.png', 'not a uuid!'), /^ch-1\/[0-9a-f-]+\.png$/, 'a bad id is replaced');
  assert.equal(C.tmcFilePath('', 'a.png'), '', 'no channel, no path');
  assert.equal(C.tmcFileLabel('ch-1/aaa.png'), 'aaa.png');
  assert.equal(C.tmcFileLabel('ch-1/aaa.png?token=secret'), 'aaa.png', 'a token never shows on screen');
});

/* ───────────── what she types is cleaned the same way the database will ───────────── */

test('her message is trimmed and capped, and the boxes catch the obvious mistakes', () => {
  assert.equal(C.tmcCleanBody('  hi\r\nthere  '), 'hi\nthere');
  assert.equal(C.tmcCleanBody('   '), '');
  assert.equal(C.tmcCleanBody(null), '');
  assert.equal(C.tmcCleanBody('x'.repeat(5000)).length, C.TMC_MAX_BODY);
  assert.match(C.tmcEmailProblem(''), /Enter your email/);
  assert.match(C.tmcEmailProblem('dee@gmail'), /does not look right/);
  assert.equal(C.tmcEmailProblem(' dilini@gmail.com '), '');
  assert.match(C.tmcCodeProblem(''), /Enter your access code/);
  assert.match(C.tmcCodeProblem('AVX'), /too short/);
  assert.equal(C.tmcCodeProblem('AVX-4K7M-Q2ZP'), '');
  assert.equal(C.tmcCleanCode(' avx-4k7m q2zp '), 'AVX-4K7MQ2ZP', 'typed loosely, sent exactly');
  assert.equal(C.tmcSize(10 * 1024 * 1024), '10 MB');
  assert.equal(C.tmcSize(0), '');
});

/* ───────────── the data calls: right arguments, never a throw ───────────── */

test('signing in sends the code as the password and says nothing about passwords to her', async () => {
  tmcReset();
  // the boxes are checked before anything leaves the page
  assert.equal((await C.tmcSignIn('', 'AVX-4K7M-Q2ZP')).ok, false);
  assert.equal((await C.tmcSignIn('dee@gmail.com', '')).ok, false);
  sameJson(tmcCalls, [], 'nothing was sent');

  tmcAuthAnswer = { data: { session: { user: { email: 'dee@gmail.com' } } }, error: null };
  const good = await C.tmcSignIn(' Dee@gmail.com ', 'avx-4k7m-q2zp');
  assert.equal(good.ok, true);
  sameJson(tmcCalls[0], ['signIn', { email: 'Dee@gmail.com', password: 'AVX-4K7M-Q2ZP' }]);

  // a wrong code is one friendly sentence, and the code is never echoed back
  tmcReset();
  tmcAuthAnswer = { data: null, error: { message: 'Invalid login credentials' } };
  const bad = await C.tmcSignIn('dee@gmail.com', 'AVX-WRONG-CODE');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, C.TMC_BAD_CODE);
  assert.doesNotMatch(bad.error, /AVX-WRONG-CODE|password/i);

  // the network falling over reads as the network, not as a wrong code
  tmcReset();
  tmcAuthAnswer = new TypeError('Failed to fetch');
  const off = await C.tmcSignIn('dee@gmail.com', 'AVX-4K7M-Q2ZP');
  assert.equal(off.ok, false);
  assert.equal(off.error, C.TMC_OFFLINE);
  assert.equal(off.offline, true);
});

test('staff_me: her channel in one call, a login that is not hers reads as no channel', async () => {
  tmcReset();
  tmcRpcAnswer = { data: ME({ messages: [{ id: 1, author_user: 's1', body: 'hi', created_at: at(24, 9, 0) }] }), error: null };
  const r = await C.tmcMe();
  assert.equal(r.ok, true);
  assert.equal(r.data.channel.id, 'ch-1');
  sameJson(tmcCalls, [['rpc', 'staff_me', {}]]);

  // a team or client login that has no staff channel: ok, but nothing to draw
  for (const d of [null, {}, { staff: { id: 's1' } }, { channel: { id: 'c' } }]) {
    tmcReset(); tmcRpcAnswer = { data: d, error: null };
    const n = await C.tmcMe();
    assert.equal(n.ok, true); assert.equal(n.data, null);
  }
  // a reply without a message list still gives her an empty thread
  tmcReset(); tmcRpcAnswer = { data: ME({ messages: null }), error: null };
  sameJson((await C.tmcMe()).data.messages, []);
});

test('sending: the trimmed body and the stored path go out, an empty message never does', async () => {
  tmcReset();
  const empty = await C.tmcSend('   ', '');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /Write a message first/);
  sameJson(tmcCalls, []);

  tmcRpcAnswer = { data: { id: 9, body: 'on it', created_at: at(24, 9, 0) }, error: null };
  const sent = await C.tmcSend('  on it \r\n ', '');
  assert.equal(sent.ok, true);
  sameJson(tmcCalls[0], ['rpc', 'staff_send', { p_body: 'on it', p_attachment: null }]);

  // a file on its own still carries a body, so the thread never shows a blank bubble
  tmcReset(); tmcRpcAnswer = { data: { id: 10 }, error: null };
  await C.tmcSend('', 'ch-1/aaa.png');
  sameJson(tmcCalls[0], ['rpc', 'staff_send', { p_body: 'aaa.png', p_attachment: 'ch-1/aaa.png' }]);

  // a refusal is told to her as a sentence about her message, not as a database error
  tmcReset(); tmcRpcAnswer = { data: null, error: { message: 'new row violates row-level security policy for table "channel_messages"' } };
  const refused = await C.tmcSend('hello', '');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'That message did not go. ' + C.TMC_NOT_READY);
  assert.doesNotMatch(refused.error, /row-level|channel_messages/);
});

test('files go up into her own channel folder and come back as a short-lived link', async () => {
  tmcReset();
  tmcStoreAnswer = { data: { path: 'ch-1/x.png' }, error: null };
  const up = await C.tmcUpload('ch-1', { name: 'shot.png', size: 2000, type: 'image/png' });
  assert.equal(up.ok, true);
  assert.match(up.data, /^ch-1\/[0-9a-f-]+\.png$/);
  assert.equal(tmcCalls[0][1], 'chat-files');
  assert.match(tmcCalls[0][2], /^ch-1\//, 'never outside her folder');
  assert.equal(tmcCalls[0][4].upsert, false, 'she cannot overwrite a file that is already there');

  // a file the bucket would refuse is stopped here first, before a 10 MB upload
  tmcReset();
  const big = await C.tmcUpload('ch-1', { name: 'big.png', size: 20 * 1024 * 1024 });
  assert.equal(big.ok, false);
  sameJson(tmcCalls, []);

  // signing
  tmcReset();
  tmcStoreAnswer = { data: { signedUrl: 'https://x.supabase.co/sign/a.png?token=t' }, error: null };
  const link = await C.tmcFileUrl('ch-1/a.png');
  assert.equal(link.ok, true);
  assert.equal(link.data, 'https://x.supabase.co/sign/a.png?token=t');
  sameJson(tmcCalls[0], ['sign', 'chat-files', 'ch-1/a.png', 600]);
  tmcReset(); tmcStoreAnswer = { data: null, error: { message: 'Object not found' } };
  const gone = await C.tmcFileUrl('ch-1/a.png');
  assert.equal(gone.ok, false);
  assert.match(gone.error, /could not open that file/);
  tmcReset(); tmcStoreAnswer = new TypeError('Failed to fetch');
  assert.equal((await C.tmcFileUrl('ch-1/a.png')).error, C.TMC_OFFLINE);
  // newest first, and never more than the limit
  const days = [{ items: [{ attachment: 'a' }, { attachment: 'b' }] }, { items: [{ attachment: 'c' }, { attachment: '' }] }];
  sameJson(C.tmcPathsToSign(days, {}, 12), ['c', 'b', 'a']);
  sameJson(C.tmcPathsToSign(days, { c: 'url' }, 12), ['b', 'a'], 'one she already has is left alone');
  sameJson(C.tmcPathsToSign(days, {}, 2), ['c', 'b']);
  sameJson(C.tmcPathsToSign(null, null, 0), []);
});

/* ───────────── the migration is not applied yet: she must be told kindly ───────────── */

test('with the staff functions not there yet, every call degrades politely', async () => {
  const missing = [
    { code: 'PGRST202', message: 'Could not find the function public.staff_me() in the schema cache' },
    { code: '42883', message: 'function public.staff_send(text, text) does not exist' },
    { code: '42501', message: 'permission denied for function staff_seen' },
  ];
  for (const err of missing) {
    tmcReset(); tmcRpcAnswer = { data: null, error: err };
    const me = await C.tmcMe();
    assert.equal(me.ok, false, err.code);
    assert.equal(me.error, C.TMC_NOT_READY);
    assert.doesNotMatch(me.error, /function|schema|PGRST|42883|42501|permission/i, 'no jargon: ' + me.error);
    assert.match(me.error, /Limethsith will let you know/);

    tmcReset(); tmcRpcAnswer = { data: null, error: err };
    const sent = await C.tmcSend('hello', '');
    assert.equal(sent.ok, false);
    assert.match(sent.error, /^That message did not go\./);

    // seen is swallowed: a missing function must not put an error in front of her
    tmcReset(); tmcRpcAnswer = { data: null, error: err };
    const seen = await C.tmcSeen();
    assert.equal(seen.ok, true);
    assert.equal(seen.data, null);
  }
  // an rpc that throws outright is still a sentence, never an exception
  tmcReset(); tmcRpcAnswer = new Error('boom');
  const r = await C.tmcMe();
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
  /* An error nobody planned for still falls through with its own wording (here
     'boom'). It cannot carry markup onto the page, because the page escapes it
     before drawing — but it is not a sentence either, so it is worth tmcSay
     ending on its calm fallback rather than on the raw text. */
  assert.doesNotMatch(r.error, /[<>]/, 'whatever it says, it cannot be markup');
  // and with no client at all (supabase-js did not load) nothing throws either
  C.tmcUseClient(null);
  const noClient = await C.tmcMe();
  assert.equal(noClient.ok, false);
  assert.equal(noClient.error, C.TMC_OFFLINE);
  assert.equal((await C.tmcSeen()).ok, true);
  assert.equal((await C.tmcSignOut()).ok, true, 'she can always get out');
});

/* ───────────── where agent A's reply and agent C's page do not meet ─────────────
   These two tests are written against what the migration actually returns today
   (supabase/migrations/20261125_staff.sql, staff_me). They pass, and what they
   assert is the bug: the lead has to change one side of each.
     1. staff_me gives each message a `mine` flag and no `author_user`, while
        tmcGroupMessages decides `mine` by comparing `author_user` to staff.id.
        Result: her own messages are drawn as his.
     2. staff_me puts the owner's read time in a top-level `seen_at`, while
        tmcSeenLine looks for owner.last_read_at / owner.read_at /
        channel.owner_last_read_at / owner_last_read_at. Result: always "Sent".
   The smallest fix is on A's side: add 'author_user', m.author_user to each
   message and return the read time as part of 'owner'. */

/* exactly the shape staff_me builds now: her auth user id as 'staff.id' (that is what her own messages carry
   in author_user), author_user on every message, and the owner's read time inside 'owner'. */
const STAFF_ME_REPLY = {
  staff: { id: 'auth-uid-1', staff_id: 'staff-row-1', name: 'Dilini', email: 'dilini@gmail.com' },
  channel: { id: 'ch-1', name: 'Dilini' },
  owner: { name: 'Limethsith', last_read_at: at(24, 10, 0) },
  seen_at: at(24, 10, 0),
  messages: [
    { id: 'm1', body: 'morning', attachment_url: null, created_at: at(24, 9, 0), author_user: 'owner-uid', mine: false },
    { id: 'm2', body: 'on it', attachment_url: null, created_at: at(24, 9, 5), author_user: 'auth-uid-1', mine: true },
  ],
};

test('her own words are hers: staff_me carries author_user, and staff.id is the id her messages carry', () => {
  const days = C.tmcGroupMessages(STAFF_ME_REPLY, new Date(2026, 10, 24, 12, 0));
  const items = days[0].items;
  sameJson(items.map((m) => [m.id, m.mine]), [['m1', false], ['m2', true]]);
  assert.equal(items[0].name, 'Limethsith', 'his message carries his name');
  assert.equal(items[1].name, 'Dilini', 'and hers carries hers');
});

test('"Seen" appears once he has read her: the read time comes inside owner', () => {
  assert.match(C.tmcSeenLine(STAFF_ME_REPLY, new Date(2026, 10, 24, 12, 0)), /^Seen \d/);
  // ...and it stays "Sent" while he has not read the latest
  const unread = JSON.parse(JSON.stringify(STAFF_ME_REPLY));
  unread.owner.last_read_at = at(24, 9, 1);
  assert.equal(C.tmcSeenLine(unread, new Date(2026, 10, 24, 12, 0)), 'Sent');
});


/* ───────────── the rehearsal pass ───────────── */

/* A read that failed and a list that is empty look identical once the rows are
   gone. The grant card used to tell the owner "There are no clients to give out
   yet" when the truth was that his client list had not loaded — a confident zero
   where it meant "I could not load this". */
test('a client list that FAILED to load never reads as "no clients"', async () => {
  reset();
  db.profiles.push(person({ id: 'u1', name: 'Owner', role: 'admin' }));
  db.profiles.push(person({ id: 'u2', name: 'Jane' }));
  db.clients.push({ id: 'c1', company: 'RH5 Stone Roofing' });

  const real = sandbox.sb.from;
  sandbox.sb.from = (table) => table === 'clients'
    ? { select: () => ({ then: (res) => Promise.resolve({ data: null, error: { message: 'Failed to fetch' } }).then(res) }) }
    : real(table);
  try { await A.tmLoadGrants(); } finally { sandbox.sb.from = real; }

  const html = A.tmRenderGrants();
  assert.ok(!/no clients to give out/i.test(html), 'it does not claim he has no clients');
  assert.match(html, /did not load/i, 'it says the list did not load');
  assert.match(html, /connection/i, 'and what to do about it');
  assert.ok(!/\{|\[object|error|PGRST/i.test(html.replace(/<[^>]*>/g, '')), 'no database wording reaches the screen');

  /* and with the read working, the empty case still reads as empty */
  reset();
  db.profiles.push(person({ id: 'u1', name: 'Owner', role: 'admin' }));
  db.profiles.push(person({ id: 'u2', name: 'Jane' }));
  await A.tmLoadGrants();
  const ok = A.tmRenderGrants();
  assert.match(ok, /no clients to give out yet/i);
  assert.ok(!/did not load/i.test(ok));
});

test('the grant card asks for its three lists together, not one after the other', async () => {
  reset();
  db.profiles.push(person({ id: 'u1', name: 'Owner', role: 'admin' }));
  db.clients.push({ id: 'c1', company: 'RH5 Stone Roofing' });
  let open = 0, mostAtOnce = 0;
  const real = sandbox.sb.from;
  sandbox.sb.from = (table) => {
    const b = real(table), realThen = b.then;
    b.then = (res, rej) => { open++; mostAtOnce = Math.max(mostAtOnce, open);
      return realThen.call(b, (v) => { open--; return res(v) }, rej) };
    return b;
  };
  try { await A.tmLoadGrants(); } finally { sandbox.sb.from = real; }
  assert.ok(mostAtOnce >= 3, 'clients, people and grants are in flight together (saw ' + mostAtOnce + ')');
});

/* The Team screen can only hand out a role the DATABASE will let into the hub.
   `is_approved()` is `role in ('admin','employee') and approved`, and the shell
   agrees with it. The screen used to offer 'staff' and 'viewer' instead:
   'staff' is forced to approved = false by the live staff_never_approved()
   trigger, so picking it quietly took the person's access away, and a 'viewer'
   is approved but still fails is_approved(), so the shell posted them off to the
   client portal, which holds nothing for a team member. Either way, you could
   not give a real employee the hub. This pins the two lists together. */
test('every role the Team screen offers is one the hub actually lets in', () => {
  const roles = Array.from(A.TM_ROLES).sort();
  assert.deepEqual(roles, ['admin', 'employee'], 'the screen hands out exactly the two is_approved() accepts');
  for (const dead of ['staff', 'viewer']) {
    assert.ok(roles.indexOf(dead) < 0, `'${dead}' cannot be handed out: the database will not let that person in`);
  }

  /* the shell's own gate, read from the file, so this breaks if one side moves */
  const shell = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const gate = /prof\.approved&&\(([^)]*)\)/.exec(shell);
  assert.ok(gate, "index.html still decides who is team with prof.approved && (...)");
  const admitted = (gate[1].match(/'([a-z_]+)'/g) || []).map((x) => x.replace(/'/g, '')).sort();
  assert.deepEqual(admitted, roles, 'the shell admits exactly the roles the Team screen hands out');

  /* a role that is still on somebody's row reads as words, not as a raw code */
  for (const old of ['staff', 'viewer']) {
    const label = A.tmRoleLabel ? A.tmRoleLabel(old) : null;
    if (label) assert.ok(/no hub|contractor/i.test(label), `'${old}' says plainly that it has no hub: ${label}`);
  }
});

test('a role the database would refuse is refused here first, in plain words', async () => {
  reset();
  db.profiles.push(person({ id: 'u1', name: 'Owner', role: 'admin' }));
  db.profiles.push(person({ id: 'u2', name: 'Jane', role: 'employee' }));
  for (const bad of ['staff', 'viewer', 'owner', '']) {
    const r = await A.tmSetRole('u2', bad);
    assert.equal(r.ok, false, `'${bad}' is refused`);
    assert.match(r.error, /admin or team member|Pick the person/i);
    assert.equal(db.profiles[1].role, 'employee', 'and nothing was written');
  }
});
