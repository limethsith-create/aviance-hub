/* ===================== AVIANCE OS — Team & Work =====================
   The people who work here, and the work queue. Supabase only: `profiles`
   and `tasks` through the shell's `sb` client. Nothing here calls another
   server.

   Two halves, one file because they are one question: who is here, and what
   are they carrying.

   1. People (`profiles`): who has access, who is still waiting for it, what
      each person may do. Nobody unapproved can see anything, so the pending
      list sits at the top of the Team screen — on day one it is the only
      thing that matters.
   2. Work (`tasks`): a shared queue, one of eight departments per task, a
      person, a status, a priority and a due date.

   Conventions (SCHEMA.md): every function returns {ok, data, error} and never
   throws; `error` is a plain sentence, safe to show a person; every screen
   renders correctly with zero rows.

   Priority is 1..5 and 5 is the most urgent. tmWorkload() weighs an open task
   by its priority, so five priority-1 chores do not look like a crisis and one
   priority-5 does not hide in a long list.

   Note on tmSetStatus(id, status): a person has a status (a line they write
   about what they are working on) and a task has a status (one of five fixed
   words). One name, two tables, so this one dispatches: a value that is one of
   the five task words sets a task's status, anything else sets a person's
   line. tmSetTaskStatus() and tmSetPersonStatus() are the unambiguous ones.
   ===================================================================== */

/* The eight departments, fixed in the database constraint on tasks.department.
   Deliverability stays a department even though an outside tool does the
   sending, because someone still has to watch it. */
const TM_DEPARTMENTS = ['marketing','sales','onboarding','operations','deliverability','finance','client_success','admin'];
const TM_DEPT_LABEL = {
  marketing:'Marketing', sales:'Sales', onboarding:'Onboarding', operations:'Operations',
  deliverability:'Deliverability', finance:'Finance', client_success:'Client success', admin:'Admin'
};
const TM_ROLES = ['admin','staff','viewer'];
const TM_ROLE_LABEL = {admin:'Admin', staff:'Staff', viewer:'Viewer'};
const TM_TASK_STATUSES = ['todo','doing','blocked','done','cancelled'];
const TM_OPEN_STATUSES = ['todo','doing','blocked'];
const TM_BOARD_STATUSES = ['todo','doing','blocked','done'];
const TM_STATUS_LABEL = {todo:'To do', doing:'Doing', blocked:'Blocked', done:'Done', cancelled:'Cancelled'};
const TM_PRIORITY_LABEL = {1:'Lowest', 2:'Low', 3:'Normal', 4:'High', 5:'Urgent'};

/* What each screen is holding right now. null means "not loaded yet". */
const tmS = {
  people:null, tasks:null, mine:null, clients:null,
  err:'', dept:'', who:'', busy:false, workSeq:0
};

/* ---- plumbing (same shape as finance.js) -------------------------- */

function tmOk(data){ return {ok:true, data, error:''} }
function tmErr(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return {ok:false, data:null, error:m};
}
function tmWrap(res, whenEmpty){
  if (!res) return tmErr('No answer from the database.');
  if (res.error) return tmErr(res.error);
  return tmOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
async function tmRun(fn, whenEmpty){
  try { return tmWrap(await fn(), whenEmpty); }
  catch (e) { return tmErr(e); }
}

/* ---- small helpers ------------------------------------------------ */

/* Who is signed in. The shell sets `authUser`; profiles.id is the auth user. */
function tmMeId(){
  if (typeof authUser === 'undefined' || !authUser) return '';
  return String(authUser.id || authUser.uid || '');
}
function tmMeIsAdmin(){
  return !!(typeof authUser !== 'undefined' && authUser && authUser.role === 'admin');
}
/* Today, as the database writes a date. */
function tmToday(){
  const d = new Date();
  const p = n => String(n).padStart(2,'0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
}
function tmDay(v){ return v ? String(v).slice(0,10) : '' }
function tmDeptLabel(d){ return TM_DEPT_LABEL[d] || (d ? String(d) : 'No department') }
function tmStatusLabel(s){ return TM_STATUS_LABEL[s] || String(s || '') }
function tmRoleLabel(r){ return TM_ROLE_LABEL[r] || (r ? String(r) : 'No role yet') }
function tmPersonName(p){ return (p && (p.name || p.email)) || 'Somebody' }
function tmInitials(p){
  if (p && p.init) return String(p.init).slice(0,2).toUpperCase();
  const n = String((p && (p.name || p.email)) || '?').trim();
  return (n.split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase()) || '?';
}
/* Is this open task past its due date? */
function tmIsOverdue(t, today){
  if (!t || TM_OPEN_STATUSES.indexOf(t.status) < 0) return false;
  const d = tmDay(t.due_on);
  return !!d && d < (today || tmToday());
}
function tmX(s){ return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s) }
function tmIc(name){ return (typeof I !== 'undefined' && I && I[name]) || '' }
function tmEmpty(icon, title, sub, btn, action){
  if (typeof emptyState === 'function') return emptyState(icon, title, sub, btn, action);
  return `<div class="card"><div class="empty"><h3>${tmX(title)}</h3><p>${tmX(sub)}</p></div></div>`;
}

/* ================= PEOPLE ========================================= */

/* Everyone with a profile, approved or not. */
async function tmPeople(){
  return tmRun(() => sb.from('profiles').select('*').order('name'), []);
}

/* The people waiting to be let in. Nobody unapproved can see anything, so
   this is the screen that matters most on day one. */
async function tmPending(){
  return tmRun(() => sb.from('profiles').select('*')
    .eq('approved', false).order('created_at'), []);
}

/* Let somebody in. They keep whatever role the database gave them. */
async function tmApprove(id){
  if (!id) return tmErr('Pick the person to approve first.');
  return tmRun(() => sb.from('profiles').update({approved:true})
    .eq('id', id).select().single(), null);
}

/* admin / staff / viewer. An admin cannot take away their own admin role:
   one wrong tap would lock the whole team out with nobody left to fix it. */
async function tmSetRole(id, role){
  if (!id) return tmErr('Pick the person first.');
  if (TM_ROLES.indexOf(String(role)) < 0) return tmErr('A role is admin, staff or viewer.');
  const me = tmMeId();
  if (role !== 'admin' && me && String(id) === me && tmMeIsAdmin()) {
    return tmErr('You cannot take away your own admin role. Ask another admin to do it for you.');
  }
  return tmRun(() => sb.from('profiles').update({role})
    .eq('id', id).select().single(), null);
}

/* The line a person writes about what they are working on. */
async function tmSetPersonStatus(id, status){
  if (!id) return tmErr('Pick the person first.');
  const text = String(status == null ? '' : status).trim().slice(0,140);
  return tmRun(() => sb.from('profiles').update({status: text || null})
    .eq('id', id).select().single(), null);
}

/* ================= WORK QUEUE ===================================== */

/* The queue, narrowed by department, by person, or by status. `status` takes
   one word or a list of them. */
async function tmTasks(filter){
  const f = filter || {};
  return tmRun(() => {
    let q = sb.from('tasks').select('*');
    if (f.department) q = q.eq('department', f.department);
    if (f.assignee)   q = q.eq('assignee', f.assignee);
    if (f.client_id)  q = q.eq('client_id', f.client_id);
    if (f.status) q = Array.isArray(f.status) ? q.in('status', f.status) : q.eq('status', f.status);
    return q.order('due_on', {ascending:true, nullsFirst:false}).order('priority', {ascending:false});
  }, []);
}

/* Put something in the queue. Title and department are the only things we
   insist on; everything else can be filled in later from the card. */
async function tmAddTask(fields){
  const f = fields || {};
  const title = String(f.title == null ? '' : f.title).trim();
  if (!title) return tmErr('Give the task a title first.');
  const dept = String(f.department || '');
  if (TM_DEPARTMENTS.indexOf(dept) < 0) return tmErr('Choose which department this belongs to.');
  const status = TM_TASK_STATUSES.indexOf(String(f.status)) >= 0 ? f.status : 'todo';
  let priority = Number(f.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) priority = 3;
  return tmRun(() => sb.from('tasks').insert({
    title:      title.slice(0,200),
    detail:     f.detail ? String(f.detail).slice(0,4000) : null,
    department: dept,
    client_id:  f.client_id || f.clientId || null,
    assignee:   f.assignee || null,
    status,
    priority,
    due_on:     tmDay(f.due_on || f.dueOn) || null,
    created_by: tmMeId() || null,
    done_at:    status === 'done' ? new Date().toISOString() : null
  }).select().single(), null);
}

/* Hand a task to somebody, or to nobody (pass null to put it back). */
async function tmAssign(id, userId){
  if (!id) return tmErr('Pick the task first.');
  return tmRun(() => sb.from('tasks').update({assignee: userId || null})
    .eq('id', id).select().single(), null);
}

/* Move a task. 'done' stamps done_at; anything else clears it, so a task
   reopened by mistake does not keep a finish time it never had. */
async function tmSetTaskStatus(id, status){
  if (!id) return tmErr('Pick the task first.');
  const s = String(status);
  if (TM_TASK_STATUSES.indexOf(s) < 0) return tmErr('A task is to do, doing, blocked, done or cancelled.');
  return tmRun(() => sb.from('tasks')
    .update({status: s, done_at: s === 'done' ? new Date().toISOString() : null})
    .eq('id', id).select().single(), null);
}

/* One name, two tables — see the note at the top of this file. */
async function tmSetStatus(id, status){
  return TM_TASK_STATUSES.indexOf(String(status)) >= 0
    ? tmSetTaskStatus(id, status)
    : tmSetPersonStatus(id, status);
}

/* When it is wanted. Pass nothing to take the date off. */
async function tmSetDue(id, date){
  if (!id) return tmErr('Pick the task first.');
  const d = tmDay(date);
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return tmErr('Write the date as year-month-day, like 2026-11-30.');
  return tmRun(() => sb.from('tasks').update({due_on: d || null})
    .eq('id', id).select().single(), null);
}

/* 1 is lowest, 5 is urgent. */
async function tmSetPriority(id, priority){
  if (!id) return tmErr('Pick the task first.');
  const p = Number(priority);
  if (!Number.isInteger(p) || p < 1 || p > 5) return tmErr('Priority goes from 1 to 5.');
  return tmRun(() => sb.from('tasks').update({priority: p})
    .eq('id', id).select().single(), null);
}

/* ---- my queue ----------------------------------------------------- */

/* Overdue first, then due today, then everything else by priority. */
function tmSortMine(rows, today){
  const t = today || tmToday();
  const bucket = r => {
    const d = tmDay(r && r.due_on);
    if (!d) return 2;
    if (d < t) return 0;
    if (d === t) return 1;
    return 2;
  };
  return (rows || []).slice().sort((a, b) =>
    bucket(a) - bucket(b)
    || (Number(b.priority) || 0) - (Number(a.priority) || 0)
    || String(tmDay(a.due_on) || '9999-12-31').localeCompare(String(tmDay(b.due_on) || '9999-12-31'))
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
  );
}

/* The signed-in person's open work, in the order they should pick it up. */
async function tmMine(today){
  const me = tmMeId();
  if (!me) return tmErr('Sign in to see your own work.');
  const r = await tmTasks({assignee: me, status: TM_OPEN_STATUSES});
  if (!r.ok) return r;
  return tmOk(tmSortMine(r.data, today));
}

/* ---- the two numbers that say where to look ----------------------- */

/* A count per department of todo, doing, blocked and overdue, so it is
   obvious which of the eight is drowning. All eight are always listed, even
   the quiet ones. */
async function tmByDepartment(today){
  const r = await tmTasks({status: TM_OPEN_STATUSES});
  if (!r.ok) return r;
  const t = today || tmToday();
  const rows = TM_DEPARTMENTS.map(d => ({
    department: d, label: tmDeptLabel(d),
    todo: 0, doing: 0, blocked: 0, overdue: 0, open: 0
  }));
  const by = {};
  rows.forEach(x => { by[x.department] = x });
  (r.data || []).forEach(task => {
    const row = by[task.department];
    if (!row) return;
    if (row[task.status] !== undefined) row[task.status] += 1;
    row.open += 1;
    if (tmIsOverdue(task, t)) row.overdue += 1;
  });
  return tmOk(rows);
}

/* Open tasks per person, weighted by priority, so work can be moved off
   whoever is buried. Heaviest first; people with nothing are still listed. */
async function tmWorkload(today){
  const p = await tmPeople();
  if (!p.ok) return p;
  const r = await tmTasks({status: TM_OPEN_STATUSES});
  if (!r.ok) return r;
  const t = today || tmToday();
  const rows = (p.data || []).filter(x => x.approved).map(x => ({
    id: x.id, name: tmPersonName(x), init: tmInitials(x), color: x.color || '',
    title: x.title || '', role: x.role || '', status: x.status || '',
    open: 0, weight: 0, overdue: 0
  }));
  const by = {};
  rows.forEach(x => { by[String(x.id)] = x });
  (r.data || []).forEach(task => {
    const row = by[String(task.assignee)];
    if (!row) return;
    row.open += 1;
    row.weight += (Number(task.priority) || 0);
    if (tmIsOverdue(task, t)) row.overdue += 1;
  });
  rows.sort((a, b) => b.weight - a.weight || b.open - a.open || a.name.localeCompare(b.name));
  return tmOk(rows);
}

/* ================= SCREENS ======================================== */

/* Client names for the cards. A task without a client just shows nothing. */
async function tmLoadClients(){
  const r = await tmRun(() => sb.from('clients').select('id,company'), []);
  const map = {};
  if (r.ok) (r.data || []).forEach(c => { map[String(c.id)] = c.company || '' });
  tmS.clients = map;
  return map;
}
function tmClientName(id){
  if (!id) return '';
  return (tmS.clients && tmS.clients[String(id)]) || '';
}
function tmPaint(hostId, html){
  if (typeof document === 'undefined' || !document.getElementById) return;
  const el = document.getElementById(hostId);
  if (el) el.innerHTML = html;
}
function tmLoading(what){
  return `<div class="card tm-pad" role="status">Loading ${tmX(what)}…</div>`;
}
function tmErrorCard(msg, retry){
  return `<div class="card tm-pad tm-err" role="alert">${tmX(msg)} <button class="btn ghost" type="button" onclick="${retry}">Try again</button></div>`;
}

/* ---- Team ---------------------------------------------------------- */

async function tmLoadTeam(){
  if (tmS.busy) return;
  tmS.busy = true;
  try {
    const [people, tasks] = await Promise.all([tmPeople(), tmTasks({status: TM_OPEN_STATUSES})]);
    tmS.err = people.ok ? (tasks.ok ? '' : tasks.error) : people.error;
    tmS.people = people.ok ? people.data : [];
    tmS.tasks  = tasks.ok  ? tasks.data  : [];
  } finally { tmS.busy = false }
  tmPaint('tmTeamHost', tmRenderTeam());
}

/* Everyone: name, title, role, status, open tasks, with the approve action
   and the people still waiting at the top. */
function tmRenderTeam(today){
  if (tmS.people === null) return tmLoading('the team');
  const t = today || tmToday();
  const people = tmS.people || [];
  const open = tmS.tasks || [];
  const counts = {};
  open.forEach(x => { const k = String(x.assignee); counts[k] = (counts[k] || 0) + 1 });

  const waiting = people.filter(p => !p.approved);
  const here = people.filter(p => p.approved);
  const err = tmS.err ? tmErrorCard(tmS.err, 'tmLoadTeam()') : '';

  const pending = waiting.length ? `
    <div class="tm-head"><h3>Waiting to be let in</h3><span class="tm-count">${waiting.length}</span></div>
    <div class="card tm-pad tm-pending">
      <p class="tm-muted tm-small">Until you approve them they can see nothing at all.</p>
      ${waiting.map(p => `<div class="tm-prow">
        <span class="tm-av">${tmX(tmInitials(p))}</span>
        <span class="tm-who"><b>${tmX(tmPersonName(p))}</b><small>${tmX(p.email || '')}</small></span>
        <button class="btn" type="button" onclick="tmDoApprove('${tmX(p.id)}')">Approve</button>
      </div>`).join('')}
    </div>` : '';

  const list = here.length ? `
    <div class="tm-head"><h3>The team</h3><span class="tm-count">${here.length}</span></div>
    <div class="card tm-tablecard"><div class="tm-scroll"><table class="tm-table">
      <thead><tr><th>Person</th><th>Title</th><th>Role</th><th>Working on</th><th>Open tasks</th></tr></thead>
      <tbody>${here.map(p => `<tr>
        <td><span class="tm-person"><span class="tm-av" ${p.color ? `style="background:${tmX(p.color)}"` : ''}>${tmX(tmInitials(p))}</span>
          <span class="tm-who"><b>${tmX(tmPersonName(p))}</b><small>${tmX(p.email || '')}</small></span></span></td>
        <td>${p.title ? tmX(p.title) : '<span class="tm-muted">—</span>'}</td>
        <td><span class="tm-role tm-role-${tmX(p.role || 'none')}">${tmX(tmRoleLabel(p.role))}</span></td>
        <td>${p.status ? tmX(p.status) : '<span class="tm-muted">Nothing written yet</span>'}</td>
        <td class="tm-num">${counts[String(p.id)] || 0}</td>
      </tr>`).join('')}</tbody>
    </table></div></div>` : '';

  const nobody = (!here.length && !waiting.length)
    ? tmEmpty(tmIc('people'), 'Nobody here yet',
        'When somebody makes an account on the sign-in page they appear here, waiting for you to approve them.')
    : '';
  return pending + err + list + nobody;
}

function viewTeam(){
  tmLoadTeam();
  return `<div id="tmTeamHost">${tmRenderTeam()}</div>`;
}

async function tmDoApprove(id){
  const r = await tmApprove(id);
  if (!r.ok) { if (typeof toast === 'function') toast(r.error); return r }
  if (typeof toast === 'function') toast('They can sign in now.');
  await tmLoadTeam();
  return r;
}
async function tmDoSetRole(id, role){
  const r = await tmSetRole(id, role);
  if (typeof toast === 'function') toast(r.ok ? 'Role saved.' : r.error);
  if (r.ok) await tmLoadTeam();
  return r;
}

/* ---- The work queue ------------------------------------------------ */

/* Each filter click starts a fresh read. The one that answers last is not the one that
   wins: only the newest read paints, so a slow answer for the old filter cannot land
   under the chip he has just picked. */
async function tmLoadWork(){
  const seq = ++tmS.workSeq;
  if (tmS.clients === null) await tmLoadClients();
  const [tasks, people] = await Promise.all([
    tmTasks({department: tmS.dept || null, assignee: tmS.who || null, status: TM_BOARD_STATUSES}),
    tmPeople()
  ]);
  if (seq !== tmS.workSeq) return;
  tmS.err = tasks.ok ? (people.ok ? '' : people.error) : tasks.error;
  tmS.tasks  = tasks.ok  ? tasks.data  : [];
  tmS.people = people.ok ? people.data : [];
  tmPaint('tmWorkHost', tmRenderWork());
}

function tmTaskCard(task, today){
  const t = today || tmToday();
  const due = tmDay(task.due_on);
  const late = tmIsOverdue(task, t);
  const client = tmClientName(task.client_id);
  const whenWords = !due ? 'No date' : late ? 'Overdue · ' + due : due === t ? 'Due today' : 'Due ' + due;
  return `<article class="tm-card tm-p${tmX(task.priority || 3)}${late ? ' tm-late' : ''}">
    <h5>${tmX(task.title || 'Untitled')}</h5>
    <div class="tm-tags">
      <span class="tm-tag">${tmX(tmDeptLabel(task.department))}</span>
      ${client ? `<span class="tm-tag tm-tag-client">${tmX(client)}</span>` : ''}
      <span class="tm-tag tm-when${late ? ' tm-late-tag' : ''}">${tmX(whenWords)}</span>
    </div>
    <div class="tm-cardfoot"><span class="tm-muted tm-small">${tmX(TM_PRIORITY_LABEL[task.priority] || 'Normal')}</span>
      <span class="tm-muted tm-small">${tmX(tmWhoName(task.assignee))}</span></div>
  </article>`;
}
function tmWhoName(id){
  if (!id) return 'Nobody yet';
  const p = (tmS.people || []).find(x => String(x.id) === String(id));
  return p ? tmPersonName(p) : 'Somebody';
}

/* The queue: a column per status, filterable by department and by person,
   with a card per task carrying its department, client and due date. */
function tmRenderWork(today){
  if (tmS.tasks === null) return tmLoading('the work queue');
  const t = today || tmToday();
  const tasks = tmS.tasks || [];
  const people = (tmS.people || []).filter(p => p.approved);

  const filters = `<div class="card tm-pad tm-filters">
    <label class="tm-field"><span>Department</span>
      <select onchange="tmFilterDept(this.value)">
        <option value=""${tmS.dept ? '' : ' selected'}>All eight</option>
        ${TM_DEPARTMENTS.map(d => `<option value="${d}"${tmS.dept === d ? ' selected' : ''}>${tmX(tmDeptLabel(d))}</option>`).join('')}
      </select></label>
    <label class="tm-field"><span>Person</span>
      <select onchange="tmFilterWho(this.value)">
        <option value=""${tmS.who ? '' : ' selected'}>Everyone</option>
        ${people.map(p => `<option value="${tmX(p.id)}"${String(tmS.who) === String(p.id) ? ' selected' : ''}>${tmX(tmPersonName(p))}</option>`).join('')}
      </select></label>
    ${tmS.dept || tmS.who ? '<button class="btn ghost" type="button" onclick="tmClearFilters()">Show everything</button>' : ''}
  </div>`;

  const err = tmS.err ? tmErrorCard(tmS.err, 'tmLoadWork()') : '';
  const board = `<div class="tm-board">${TM_BOARD_STATUSES.map(s => {
    const col = tasks.filter(x => x.status === s);
    const sorted = s === 'done' ? col : tmSortMine(col, t);
    return `<section class="tm-col tm-col-${s}">
      <header><h4>${tmX(tmStatusLabel(s))}</h4><span class="tm-count">${col.length}</span></header>
      ${col.length ? sorted.map(x => tmTaskCard(x, t)).join('') : '<p class="tm-muted tm-small tm-colempty">Nothing here.</p>'}
    </section>`;
  }).join('')}</div>`;

  const none = !tasks.length && !tmS.dept && !tmS.who
    ? tmEmpty(tmIc('check'), 'The queue is empty',
        'Nothing is waiting on anybody. Add the first task when there is something to do.')
    : '';
  return filters + err + (none || board);
}

function viewWork(){
  tmLoadWork();
  return `<div id="tmWorkHost">${tmRenderWork()}</div>`;
}
function tmFilterDept(d){ tmS.dept = TM_DEPARTMENTS.indexOf(String(d)) >= 0 ? String(d) : ''; tmS.tasks = null; tmPaint('tmWorkHost', tmRenderWork()); return tmLoadWork() }
function tmFilterWho(id){ tmS.who = id ? String(id) : ''; tmS.tasks = null; tmPaint('tmWorkHost', tmRenderWork()); return tmLoadWork() }
function tmClearFilters(){ tmS.dept = ''; tmS.who = ''; tmS.tasks = null; tmPaint('tmWorkHost', tmRenderWork()); return tmLoadWork() }

/* ---- Just mine ------------------------------------------------------ */

async function tmLoadMine(){
  if (tmS.clients === null) await tmLoadClients();
  if (tmS.people === null) { const p = await tmPeople(); tmS.people = p.ok ? p.data : [] }
  const r = await tmMine();
  tmS.err = r.ok ? '' : r.error;
  tmS.mine = r.ok ? r.data : [];
  tmPaint('tmMineHost', tmRenderMine());
}

function tmRenderMine(today){
  if (tmS.mine === null) return tmLoading('your work');
  const t = today || tmToday();
  const rows = tmS.mine || [];
  const err = tmS.err ? tmErrorCard(tmS.err, 'tmLoadMine()') : '';
  if (!rows.length) {
    return err + tmEmpty(tmIc('check'), 'Nothing on you',
      'No open task is assigned to you. Anything new will show up here, the most urgent first.');
  }
  const late = rows.filter(x => tmIsOverdue(x, t)).length;
  const head = `<div class="tm-head"><h3>Your work</h3>
    <span class="tm-count">${rows.length}</span>
    ${late ? `<span class="tm-count tm-count-late">${late} overdue</span>` : ''}</div>`;
  return err + head + `<div class="tm-mine">${rows.map(x => tmTaskCard(x, t)).join('')}</div>`;
}

function viewMyWork(){
  tmLoadMine();
  return `<div id="tmMineHost">${tmRenderMine()}</div>`;
}

/* Forget everything on sign-out. */
function tmForget(){
  Object.assign(tmS, {people:null, tasks:null, mine:null, clients:null, err:'', dept:'', who:'', busy:false, workSeq:tmS.workSeq + 1});
}
