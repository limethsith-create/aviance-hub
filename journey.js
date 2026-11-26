/* ============================================================================
   journey.js — Aviance OS · the client journey tracker (payment → launch)
   ----------------------------------------------------------------------------
   Day 0 is the day their first invoice was paid; launch is day 14. Six steps:
   kickoff · research · testing · build · onboarding · launch. Each is todo,
   doing or done. "Late" is never stored: a step is late when its planned day
   has gone by and it is not done.

   Two places:
     - viewJourneyBoard()          the Onboarding screen: every client between
                                   payment and launch, one row each.
     - jyMountClient(clientId, el) the tracker on one client's page, with the
                                   per-step buttons (clientbook.js makes #cbJourney).
   And jyLateCount() for the nav badge (cached, refreshed at most every 60s).

   RPCs only (the database is the one that knows the rules):
     journey_board  journey_get  journey_set  journey_move  journey_start
     offer_times  approval_request  testing_day
   Anything that writes to the client queues a DRAFT; nothing here sends.

   Every data function returns {ok, data, error} and never throws. Every
   render function is pure: data in, HTML string out, every value escaped.
   Nothing runs at load time. Prefix: jy.
   ========================================================================== */

/* [key, title, planned day offset from paid_on, short name] */
const JY_STEPS = [
  ['kickoff',    'Kickoff call',      2,  'Kickoff'],
  ['research',   'Research',          4,  'Research'],
  ['testing',    'Market testing',    11, 'Testing'],
  ['build',      'Build the campaign',13, 'Build'],
  ['onboarding', 'Onboarding call',   13, 'Onboarding'],
  ['launch',     'Launch',            14, 'Launch'],
];
/* the one-word name a pill has room for */
function jyShort(s){ const m = jyStepMeta(s && s.step); return m ? m[3] : (s && s.title) || 'Step' }
const JY_KEYS = JY_STEPS.map(s => s[0]);
const JY_STATUSES = ['todo', 'doing', 'done'];
const JY_RELOAD_MS = 60000;
const JY_DRAFT_SAID = 'Draft ready — approve it in Replies';

const jy = { board: null, at: 0, err: '', tried: false, one: {}, oneErr: {}, els: {}, busy: {}, late: 0, timer: null };
/* Sign-out: drop what was loaded and stop asking. */
function jyForget(){
  if (jy.timer) { try { clearInterval(jy.timer); } catch (e) {} jy.timer = null; }
  jy.board = null; jy.at = 0; jy.err = ''; jy.tried = false; jy.one = {}; jy.oneErr = {}; jy.els = {}; jy.busy = {}; jy.late = 0;
}

/* ===================== 1. PLUMBING ===================== */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const jyOk = coreOk;
/* What went wrong, in words the owner can act on. Our own database messages (a plpgsql `raise exception`)
   are already plain and pass through; the plumbing's own wording never reaches the screen. */
function jyPlain(m){
  const s = String(m || '');
  if (/failed to fetch|networkerror|network request|load failed|fetch failed|socket/i.test(s)) return "Can't reach Aviance right now. Check your connection and try again.";
  if (/jwt|not authenticated|invalid.*session|session.*expired/i.test(s)) return 'Your sign-in has run out. Please sign in again.';
  if (/permission denied|row-level security|not authorized|unauthorized/i.test(s)) return "You don't have access to do that.";
  if (/could not find the function|does not exist|schema cache|PGRST\d+/i.test(s)) return "That part of Aviance isn't switched on yet. Try again once the database update is applied.";
  /* anything this screen has no better word for falls through to the one place
     that decides what the owner may be shown, so a constraint name or an
     '[object Object]' cannot reach the screen by this route either. */
  return corePlain(s);
}
/* Same shape as coreErr, but the message goes through jyPlain first: this screen
   rewords the plumbing's own wording before the owner ever sees it. jyPlain is
   given the RAW text (coreRawText, not coreErrText) on purpose: coreErrText now
   rewords it too, and this screen's wording is the more specific of the two —
   "isn't switched on yet" names the thing he has to go and do. Plaining it twice
   would hand him core.js's generic instead. */
function jyErr(e){ return {ok:false, data:null, error:jyPlain(coreRawText(e))} }
function jyWrap(res, whenEmpty){ return coreWrap(res, whenEmpty, jyErr, 'No answer from Aviance. Try again.') }
async function jyRpc(name, args, whenEmpty){
  try {
    if (typeof sb === 'undefined' || !sb || typeof sb.rpc !== 'function') return jyErr('Aviance is not ready yet. Please reload the page.');
    return jyWrap(await sb.rpc(name, args || {}), whenEmpty);
  } catch (e) { return jyErr(e); }
}

/* ===================== 2. SMALL PURE HELPERS ===================== */

/* The one escape, from core.js: strict, five characters, the single quote among them. */
const jyE = coreEsc;
/* A value safe inside onclick="…" as a JavaScript string, from core.js. */
const jyAttr = coreAttr;
function jyTrim(v){ return String(v == null ? '' : v).trim() }
function jyInt(v){ const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0 }
function jyIsDay(v){ return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) }
/* Today as 'YYYY-MM-DD' in the viewer's own calendar, from core.js. */
const jyToday = coreTodayKey;
/* Whole days from a to b, both 'YYYY-MM-DD'. */
function jyDaysBetween(a, b){
  if (!jyIsDay(a) || !jyIsDay(b)) return null;
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}
const JY_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/* "26 Nov" — the hub's date style. */
function jyDate(v){
  const s = String(v || '').slice(0, 10);
  if (!jyIsDay(s)) return '—';
  return Number(s.slice(8, 10)) + ' ' + JY_MON[Number(s.slice(5, 7)) - 1];
}
function jyStepMeta(key){ const i = JY_KEYS.indexOf(String(key || '')); return i < 0 ? null : JY_STEPS[i] }
function jyStepTitle(key){ const m = jyStepMeta(key); return m ? m[1] : (jyTrim(key) || 'Step') }
function jyStatusWord(s){ return s === 'done' ? 'Done' : s === 'doing' ? 'In progress' : 'To do' }

/* A step is late when its day has gone by and it is not done. The database's
   own `late` wins when it says; otherwise we work it out the same way. */
function jyIsLate(step, today){
  const s = step || {};
  if (s.status === 'done') return false;
  if (typeof s.late === 'boolean') return s.late;
  return jyIsDay(s.planned_on) && String(s.planned_on) < (today || jyToday());
}

/* journey_get's answer -> what the screens draw from. Never throws. */
function jyNorm(j, today){
  const t = today || jyToday();
  const x = j && typeof j === 'object' ? j : {};
  const raw = Array.isArray(x.steps) ? x.steps.filter(Boolean) : [];
  const steps = raw.slice().sort((a, b) => {
    const pa = a.position != null ? Number(a.position) : JY_KEYS.indexOf(a.step);
    const pb = b.position != null ? Number(b.position) : JY_KEYS.indexOf(b.step);
    return pa - pb;
  }).map(s => ({
    step: jyTrim(s.step), title: jyTrim(s.title) || jyStepTitle(s.step),
    planned_on: jyIsDay(String(s.planned_on || '').slice(0, 10)) ? String(s.planned_on).slice(0, 10) : '',
    status: JY_STATUSES.indexOf(s.status) >= 0 ? s.status : 'todo',
    done_at: s.done_at || null, note: jyTrim(s.note),
    late: jyIsLate(s, t),
  }));
  const nextKey = jyTrim(x.next_step) || ((steps.find(s => s.status !== 'done') || {}).step || '');
  const launch = jyIsDay(String(x.launch_on || '').slice(0, 10)) ? String(x.launch_on).slice(0, 10)
    : ((steps.find(s => s.step === 'launch') || {}).planned_on || '');
  let days = x.days_to_launch != null && Number.isFinite(Number(x.days_to_launch)) ? jyInt(x.days_to_launch) : jyDaysBetween(t, launch);
  const done = steps.filter(s => s.status === 'done').length;
  return {
    client_id: jyTrim(x.client_id), company: jyTrim(x.company) || 'Unnamed client',
    paid_on: jyTrim(x.paid_on).slice(0, 10), launch_on: launch, days_to_launch: days,
    steps, next: steps.find(s => s.step === nextKey) || null,
    late: steps.filter(s => s.late).length, done, total: steps.length,
    live: steps.length > 0 && done === steps.length,
  };
}

/* How many steps are running late across the board. */
function jyLateOf(board, today){
  return (Array.isArray(board) ? board : []).reduce((n, j) => n + jyNorm(j, today).late, 0);
}

/* "Launch in 6 days" / "Launches today" / "Launch 2 days overdue" / "Live" */
function jyLaunchWords(n){
  if (n.live) return 'Live';
  const d = n.days_to_launch;
  if (d == null) return 'No launch date';
  if (d === 0) return 'Launches today';
  if (d < 0) return 'Launch ' + Math.abs(d) + (Math.abs(d) === 1 ? ' day' : ' days') + ' overdue';
  return 'Launch in ' + d + (d === 1 ? ' day' : ' days');
}

/* The one thing to do on a step, by its key. [label, handler name] or null. */
function jyActionFor(step){
  switch (step) {
    case 'kickoff':    return ['Offer kickoff times', 'jyOffer', 'kickoff'];
    case 'research':   return ['Send ICP + angles for approval', 'jyAskApproval', 'icp'];
    case 'testing':    return ["Log today's numbers", 'jyAskTesting', ''];
    case 'build':      return ['Send copy for approval', 'jyAskApproval', 'copy'];
    case 'onboarding': return ['Offer onboarding call times', 'jyOffer', 'onboarding'];
    default:           return null;
  }
}
function jyActionButton(clientId, step, cls){
  const a = jyActionFor(step);
  if (!a) return '';
  const args = jyAttr(clientId) + (a[2] ? ',' + jyAttr(a[2]) : '');
  return '<button type="button" class="btn ' + (cls || '') + '" onclick="' + a[1] + '(' + args + ')">' + jyE(a[0]) + '</button>';
}

/* ===================== 3. DATA ===================== */

async function jyBoard(){
  const r = await jyRpc('journey_board', {}, []);
  if (r.ok && !Array.isArray(r.data)) r.data = [];
  return r;
}
async function jyGet(clientId){
  if (!clientId) return jyErr('Which client is this about?');
  return jyRpc('journey_get', {p_client: clientId}, null);
}
async function jySet(clientId, step, status, note){
  if (!clientId || JY_KEYS.indexOf(step) < 0) return jyErr('Which step is this?');
  if (JY_STATUSES.indexOf(status) < 0) return jyErr('A step is to do, in progress or done.');
  const args = {p_client: clientId, p_step: step, p_status: status};
  if (jyTrim(note)) args.p_note = jyTrim(note).slice(0, 500);
  return jyRpc('journey_set', args, null);
}
async function jyMoveStep(clientId, step, planned){
  if (!clientId || JY_KEYS.indexOf(step) < 0) return jyErr('Which step is this?');
  if (!jyIsDay(planned)) return jyErr('Pick a day.');
  return jyRpc('journey_move', {p_client: clientId, p_step: step, p_planned: planned}, null);
}
async function jyStartJourney(clientId){
  if (!clientId) return jyErr('Which client is this about?');
  return jyRpc('journey_start', {p_client: clientId}, null);
}
async function jyOfferTimes(clientId, kind){
  if (!clientId) return jyErr('Which client is this about?');
  if (kind !== 'kickoff' && kind !== 'onboarding') return jyErr('Kickoff or onboarding?');
  return jyRpc('offer_times', {p_client: clientId, p_kind: kind}, null);
}
async function jyApprovalRequest(clientId, kind, title, body){
  if (!clientId) return jyErr('Which client is this about?');
  if (['icp', 'angles', 'copy'].indexOf(kind) < 0) return jyErr('What is this approval for?');
  const t = jyTrim(title), b = jyTrim(body);
  if (!t) return jyErr('Give it a title.');
  if (!b) return jyErr('Write what they are approving.');
  return jyRpc('approval_request', {p_client: clientId, p_kind: kind, p_title: t.slice(0, 200), p_body: b.slice(0, 8000)}, null);
}
async function jyTestingDay(clientId, sent, replies, leading, note){
  if (!clientId) return jyErr('Which client is this about?');
  const s = Number(sent), r = Number(replies);
  if (!Number.isInteger(s) || s < 0) return jyErr('How many were sent today? A whole number.');
  if (!Number.isInteger(r) || r < 0) return jyErr('How many replies? A whole number.');
  if (r > s) return jyErr('There are more replies than emails sent.');
  const args = {p_client: clientId, p_sent: s, p_replies: r, p_leading: jyTrim(leading).slice(0, 120)};
  if (jyTrim(note)) args.p_note = jyTrim(note).slice(0, 500);
  return jyRpc('testing_day', args, null);
}

/* ===================== 4. RENDER (pure) ===================== */

function jyPill(s, opts){
  const o = opts || {};
  const tone = s.status === 'done' ? 'done' : s.late ? 'late' : s.status === 'doing' ? 'doing' : 'todo';
  const word = s.late ? 'Late' : jyStatusWord(s.status);
  const label = s.title + ' — ' + word + (s.planned_on ? ', ' + jyDate(s.planned_on) : '');
  return '<li class="jy-pill ' + tone + (o.next ? ' next' : '') + '" title="' + jyE(label) + '">' +
    '<span class="jy-dot" aria-hidden="true">' + (s.status === 'done' ? '✓' : '') + '</span>' +
    '<span class="jy-pill-t">' + jyE(jyShort(s)) + '</span>' +
    '<span class="jy-pill-d">' + jyE(s.late ? 'Late · ' + jyDate(s.planned_on) : jyDate(s.planned_on)) + '</span>' +
    '<span class="jy-sr">' + jyE(word) + '</span>' +
  '</li>';
}
/* THE OTHER GUARANTEE.
   The agreement says: not live within 14 days of kickoff and their next month
   is free. Day 14 is the launch step's planned day, so this board already
   knows the day the promise is broken — and said only "Launch 2 days overdue",
   which reads as a slipped task and not as a month of fee. Nothing in the
   database marks a month free (a month's fee comes from clients.monthly_fee,
   and there is no per-month fee or free flag), so Aviance cannot apply it by
   itself; the least it can do is say what the slip costs, on the screen where
   the owner is looking at the slip. */
function jyOwesFreeMonth(n){
  return !!(n && !n.live && n.days_to_launch != null && n.days_to_launch < 0);
}
function jyFreeMonthWords(n){
  if (!jyOwesFreeMonth(n)) return '';
  const d = Math.abs(jyInt(n.days_to_launch));
  return 'Past day 14 by ' + d + (d === 1 ? ' day' : ' days') +
    ': the agreement makes their next month free. Nothing applies that on its own — raise it on their next invoice.';
}

function jyLaunchBadge(n){
  const tone = n.live ? 'live' : n.days_to_launch != null && n.days_to_launch < 0 ? 'late' : n.days_to_launch != null && n.days_to_launch <= 3 ? 'soon' : '';
  return '<span class="jy-launch ' + tone + '">' +
    (n.live || n.days_to_launch == null || n.days_to_launch <= 0 ? '<b>' + jyE(jyLaunchWords(n)) + '</b>'
      : '<b>' + jyE(n.days_to_launch) + '</b><small>' + jyE(n.days_to_launch === 1 ? 'day to launch' : 'days to launch') + '</small>') +
  '</span>';
}

/* One client on the board. */
function jyRenderBoardRow(j, today){
  const n = jyNorm(j, today);
  const nx = n.next;
  return '<article class="jy-row' + (n.late ? ' is-late' : '') + '">' +
    '<div class="jy-row-who">' +
      '<button type="button" class="jy-co" onclick="jyOpen(' + jyAttr(n.client_id) + ')">' + jyE(n.company) + '</button>' +
      '<span class="jy-sub">' + jyE((n.paid_on ? 'Paid ' + jyDate(n.paid_on) : 'Not paid yet') + ' · ' + n.done + ' of ' + (n.total || 6) + ' done') +
        (n.late ? ' · <b class="jy-late-t">' + jyE(n.late + ' late') + '</b>' : '') + '</span>' +
    '</div>' +
    '<ol class="jy-pills" aria-label="' + jyE('Steps for ' + n.company) + '">' +
      (n.steps.length ? n.steps.map(s => jyPill(s, {next: nx && s.step === nx.step})).join('') : '<li class="jy-none">Not started</li>') +
    '</ol>' +
    jyLaunchBadge(n) +
    (jyOwesFreeMonth(n) ? '<p class="jy-sub" role="alert"><b class="jy-late-t">' + jyE(jyFreeMonthWords(n)) + '</b></p>' : '') +
    '<div class="jy-row-foot">' +
      '<div class="jy-row-next">' +
        (nx ? '<span class="jy-next-l">Next</span><span class="jy-next-t">' + jyE(nx.title) + '</span>' +
              (nx.planned_on ? '<span class="jy-next-d' + (nx.late ? ' late' : '') + '">' + jyE((nx.late ? 'was due ' : 'due ') + jyDate(nx.planned_on)) + '</span>' : '')
            : '<span class="jy-next-t">' + jyE(n.live ? 'All six steps done' : 'Nothing planned') + '</span>') +
      '</div>' +
      '<div class="jy-row-acts">' +
        (nx ? jyActionButton(n.client_id, nx.step, '') : '') +
        (nx ? '<button type="button" class="btn ghost" onclick="jyMark(' + jyAttr(n.client_id) + ',' + jyAttr(nx.step) + ',' + jyAttr(nx.status === 'todo' ? 'doing' : 'done') + ')" aria-label="' +
                jyE((nx.status === 'todo' ? 'Start ' : 'Mark done: ') + nx.title) + '">' + jyE(nx.status === 'todo' ? 'Start' : 'Mark done') + '</button>' : '') +
        '<button type="button" class="btn ghost jy-open" onclick="jyOpen(' + jyAttr(n.client_id) + ')" aria-label="' + jyE('Open ' + n.company) + '">Open</button>' +
      '</div>' +
    '</div>' +
  '</article>';
}

/* The whole board. rows = journey_board's answer. */
function jyRenderBoard(rows, meta){
  const m = meta || {};
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const err = m.error ? '<div class="card jy-err-note" role="alert">' + jyE(m.error) + '</div>' : '';
  if (!list.length) {
    return err + '<div class="card"><div class="empty"><h3>' + jyE(m.error ? 'The board could not be read' : 'Nobody is onboarding') + '</h3>' +
      '<p>' + jyE(m.error ? 'Try again in a moment.' : 'When a new client pays their first invoice, their 14 days to launch show up here.') + '</p>' +
      '<button class="btn ghost" onclick="' + (m.error ? 'jyReload()' : "render('clients')") + '">' + jyE(m.error ? 'Try again' : 'All clients') + '</button></div></div>';
  }
  const today = m.today || jyToday();
  const norm = list.map(j => ({j, n: jyNorm(j, today)}));
  /* late first, then soonest launch */
  norm.sort((a, b) => (b.n.late > 0) - (a.n.late > 0) ||
    (a.n.days_to_launch == null ? 999 : a.n.days_to_launch) - (b.n.days_to_launch == null ? 999 : b.n.days_to_launch) ||
    a.n.company.localeCompare(b.n.company));
  const late = norm.reduce((s, x) => s + x.n.late, 0);
  const lateClients = norm.filter(x => x.n.late).length;
  const week = norm.filter(x => !x.n.live && x.n.days_to_launch != null && x.n.days_to_launch >= 0 && x.n.days_to_launch <= 7).length;
  return err +
    '<div class="jy-sum">' +
      '<div class="card jy-tile"><small>Onboarding</small><b>' + jyE(norm.length) + '</b></div>' +
      '<div class="card jy-tile' + (late ? ' warn' : '') + '"><small>Steps late</small><b>' + jyE(late) + '</b>' +
        (late ? '<span>' + jyE('across ' + lateClients + (lateClients === 1 ? ' client' : ' clients')) + '</span>' : '<span>On track</span>') + '</div>' +
      '<div class="card jy-tile"><small>Launching this week</small><b>' + jyE(week) + '</b></div>' +
      '<div class="jy-legend" aria-hidden="true"><span class="done">Done</span><span class="doing">In progress</span><span class="todo">To do</span><span class="late">Late</span></div>' +
    '</div>' +
    '<div class="jy-board">' + norm.map(x => jyRenderBoardRow(x.j, today)).join('') + '</div>';
}

/* One step on the client page, with its controls. */
function jyRenderStepRow(clientId, s, isNext){
  const tone = s.status === 'done' ? 'done' : s.late ? 'late' : s.status;
  const a = jyActionFor(s.step);
  return '<li class="jy-step ' + tone + (isNext ? ' next' : '') + '">' +
    '<span class="jy-step-dot" aria-hidden="true">' + (s.status === 'done' ? '✓' : '') + '</span>' +
    '<div class="jy-step-main">' +
      '<div class="jy-step-h"><b>' + jyE(s.title) + '</b>' +
        '<span class="jy-tag ' + tone + '">' + jyE(s.late ? 'Late' : jyStatusWord(s.status)) + '</span>' +
        (isNext ? '<span class="jy-tag next">Next</span>' : '') + '</div>' +
      '<div class="jy-step-when">' +
        jyE(s.status === 'done' && s.done_at ? 'Done ' + jyDate(String(s.done_at).slice(0, 10)) + ' · planned ' + jyDate(s.planned_on) : 'Planned ' + jyDate(s.planned_on)) +
      '</div>' +
      (s.note ? '<div class="jy-step-note">' + jyE(s.note) + '</div>' : '') +
    '</div>' +
    '<div class="jy-step-acts">' +
      (s.status !== 'done' && a ? jyActionButton(clientId, s.step, isNext ? '' : 'ghost') : '') +
      (s.status === 'todo' ? '<button type="button" class="btn ghost" onclick="jyMark(' + jyAttr(clientId) + ',' + jyAttr(s.step) + ',\'doing\')">Start</button>' : '') +
      (s.status !== 'done' ? '<button type="button" class="btn ghost" onclick="jyMark(' + jyAttr(clientId) + ',' + jyAttr(s.step) + ',\'done\')">Done</button>'
                           : '<button type="button" class="btn ghost" onclick="jyMark(' + jyAttr(clientId) + ',' + jyAttr(s.step) + ',\'doing\')">Reopen</button>') +
      (s.status !== 'done' ? '<button type="button" class="btn ghost" onclick="jyAskMove(' + jyAttr(clientId) + ',' + jyAttr(s.step) + ')">Move date</button>' : '') +
    '</div>' +
  '</li>';
}

/* The tracker on one client's page. j = journey_get's answer. */
function jyRenderTracker(clientId, j, meta){
  const m = meta || {};
  if (m.error) return '<h3>Journey</h3><p class="jy-err">' + jyE(m.error) + '</p>' +
    '<button type="button" class="btn ghost" onclick="jyRemount(' + jyAttr(clientId) + ')">Try again</button>';
  const n = jyNorm(j, m.today);
  if (!n.steps.length) return '<h3>Journey</h3>' +
    '<p class="jy-muted">The 14 days to launch start when their first invoice is paid.</p>' +
    (m.admin ? '<button type="button" class="btn ghost" onclick="jyStart(' + jyAttr(clientId) + ')">Start the tracker now</button>' : '');
  const pct = n.total ? Math.round(n.done / n.total * 100) : 0;
  return '<div class="jy-one-head">' +
      '<div><h3>Journey to launch</h3>' +
      '<p class="jy-muted">' + jyE([
        n.paid_on ? 'Paid ' + jyDate(n.paid_on) : '',
        n.launch_on ? 'launch ' + jyDate(n.launch_on) : '',
        n.done + ' of ' + n.total + ' done',
      ].filter(Boolean).join(' · ')) + '</p></div>' +
      jyLaunchBadge(n) +
    '</div>' +
    '<div class="jy-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + jyE(pct) + '" aria-label="Steps done"><span style="width:' + jyE(pct) + '%"></span></div>' +
    '<ol class="jy-steps">' + n.steps.map(s => jyRenderStepRow(clientId, s, n.next && n.next.step === s.step)).join('') + '</ol>';
}

/* The small forms, in the shell's modal. */
function jyRenderApprovalForm(clientId, kind){
  const copy = kind === 'copy';
  return '<div class="jy-form"><h3>' + jyE(copy ? 'Send copy for approval' : 'Send ICP + angles for approval') + '</h3>' +
    '<p class="jy-muted">This queues a draft in Replies. Nothing reaches them until you send it there.</p>' +
    '<label class="cb-lab" for="jyApTitle">Title they see</label>' +
    '<input id="jyApTitle" class="cb-in" type="text" maxlength="200" value="' + jyE(copy ? 'Your campaign copy' : 'Your target profile + 3 angles') + '">' +
    '<label class="cb-lab" for="jyApBody">What they are approving</label>' +
    '<textarea id="jyApBody" class="cb-in jy-ta" rows="10" maxlength="8000" placeholder="' + jyE(copy ? 'The emails, in order' : 'Who we target, and the angles we will test') + '"></textarea>' +
    '<div class="cb-err" id="jyApErr" role="alert"></div>' +
    '<div class="jy-form-btns"><button class="btn" onclick="jySendApproval(' + jyAttr(clientId) + ',' + jyAttr(copy ? 'copy' : 'icp') + ')">Draft it</button>' +
    '<button class="btn ghost" onclick="closeModal()">Cancel</button></div></div>';
}
function jyRenderTestingForm(clientId){
  return '<div class="jy-form"><h3>Log today’s numbers</h3>' +
    '<p class="jy-muted">Saved for today, and a one-line update is drafted in Replies.</p>' +
    '<div class="jy-form-row">' +
      '<div><label class="cb-lab" for="jyTdSent">Sent</label><input id="jyTdSent" class="cb-in" type="number" min="0" step="1" inputmode="numeric"></div>' +
      '<div><label class="cb-lab" for="jyTdReplies">Replies</label><input id="jyTdReplies" class="cb-in" type="number" min="0" step="1" inputmode="numeric"></div>' +
    '</div>' +
    '<label class="cb-lab" for="jyTdLead">Leading angle</label><input id="jyTdLead" class="cb-in" type="text" maxlength="120" placeholder="angle B">' +
    '<label class="cb-lab" for="jyTdNote">Note (just for us)</label><input id="jyTdNote" class="cb-in" type="text" maxlength="500">' +
    '<div class="cb-err" id="jyTdErr" role="alert"></div>' +
    '<div class="jy-form-btns"><button class="btn" onclick="jySendTesting(' + jyAttr(clientId) + ')">Save and draft</button>' +
    '<button class="btn ghost" onclick="closeModal()">Cancel</button></div></div>';
}
function jyRenderMoveForm(clientId, step, planned){
  return '<div class="jy-form"><h3>' + jyE('Move ' + jyStepTitle(step).toLowerCase()) + '</h3>' +
    '<label class="cb-lab" for="jyMvDay">New day</label><input id="jyMvDay" class="cb-in" type="date" value="' + jyE(jyIsDay(planned) ? planned : '') + '">' +
    '<div class="cb-err" id="jyMvErr" role="alert"></div>' +
    '<div class="jy-form-btns"><button class="btn" onclick="jyDoMove(' + jyAttr(clientId) + ',' + jyAttr(step) + ')">Move it</button>' +
    '<button class="btn ghost" onclick="closeModal()">Cancel</button></div></div>';
}

/* ===================== 5. LOADING + SCREENS ===================== */

async function jyLoadBoard(force){
  if (jy.busy.board) return jy.busy.board;
  if (!force && jy.board && Date.now() - jy.at < JY_RELOAD_MS) return jyOk(jy.board);
  jy.busy.board = (async () => {
    const r = await jyBoard();
    jy.at = Date.now(); jy.tried = true;
    if (!r.ok) { jy.err = r.error; return r; }
    jy.board = r.data; jy.err = '';
    const was = jy.late;
    jy.late = jyLateOf(jy.board);
    if (was !== jy.late && typeof renderNav === 'function') { try { renderNav(); } catch (e) {} }
    return r;
  })();
  try { return await jy.busy.board; }
  finally { delete jy.busy.board; }
}
function jyPaint(){
  if (typeof render !== 'function' || typeof currentView === 'undefined') return;
  if (String(currentView || '') !== 'journey') return;
  try { render('journey'); } catch (e) {}
}
/* The board is asked for and drawn when it lands. jyLoadBoard() is built not to
   throw, but if it ever does the promise rejects, jyPaint never runs, jy.tried
   stays false and the screen says "Loading the board…" until the app is
   reloaded. So every ask has a failure path: mark it asked, say why, draw. */
function jyThen(p){
  if (!p || typeof p.then !== 'function') return p;
  return p.then(jyPaint, (e) => {
    jy.tried = true; jy.at = Date.now();
    jy.err = 'Aviance could not read the board just now. Try again in a moment.';
    jyPaint();
  });
}
function jyReload(){ jy.tried = false; return jyThen(jyLoadBoard(true)) }

function viewJourneyBoard(){
  if (!jy.board) {
    if (!jy.tried) { jyThen(jyLoadBoard()); return '<div class="cb-loading" role="status">Loading the board…</div>'; }
    return jyRenderBoard([], {error: jy.err});
  }
  return jyRenderBoard(jy.board, {error: jy.err});
}

/* The nav badge: the cached count; asks again when it is over a minute old. */
function jyLateCount(){
  const isClient = typeof hubIsClient === 'function' && (() => { try { return hubIsClient(); } catch (e) { return false; } })();
  if (!isClient && typeof sb !== 'undefined' && sb && (!jy.at || Date.now() - jy.at >= JY_RELOAD_MS) && !jy.busy.board) {
    /* the nav badge only: a failure must not become an unhandled rejection */
    jyLoadBoard(true).then(() => {}, () => {});
  }
  if (!isClient && !jy.timer && typeof setInterval === 'function' && typeof document !== 'undefined' && document && document.getElementById) {
    jy.timer = setInterval(() => {
      /* signed out: stop asking, and keep nothing of the last login */
      let signedIn = true;
      try { signedIn = typeof authUser === 'undefined' || !!authUser; } catch (e) { signedIn = true; }
      if (!signedIn) { jyForget(); return; }
      if (typeof document === 'undefined' || !document.hidden) jyThen(jyLoadBoard(true));
    }, JY_RELOAD_MS);
    if (jy.timer && jy.timer.unref) jy.timer.unref();
  }
  return jy.late || 0;
}

function jyIsAdmin(){
  try {
    if (typeof cbIsAdmin === 'function') return !!cbIsAdmin();
    return typeof authUser !== 'undefined' && !!authUser && (authUser.role === 'admin' || authUser.role === 'owner');
  } catch (e) { return false; }
}

/* The tracker on a client's page. clientbook.js makes the element (#cbJourney). */
async function jyMountClient(clientId, el){
  if (!clientId || !el) return jyErr('Nowhere to draw the tracker.');
  jy.els[clientId] = el;
  const stage = el.getAttribute ? el.getAttribute('data-cb-stage') : '';
  if (!jy.one[clientId]) el.innerHTML = '<div class="cb-loading" role="status">Loading their journey…</div>';
  else el.innerHTML = jyRenderTracker(clientId, jy.one[clientId], {admin: jyIsAdmin()});
  const r = await jyGet(clientId);
  if (r.ok) jy.one[clientId] = r.data;
  const n = jyNorm(r.data);
  /* a client who went live before the tracker existed: nothing to show */
  if (r.ok && !n.steps.length && stage && stage !== 'won' && stage !== 'onboarding') { el.innerHTML = ''; return r; }
  el.innerHTML = jyRenderTracker(clientId, r.ok ? r.data : null, {error: r.ok ? '' : r.error, admin: jyIsAdmin()});
  return r;
}
function jyRemount(clientId){
  let el = jy.els[clientId];
  if ((!el || el.isConnected === false) && typeof document !== 'undefined' && document && document.getElementById) el = document.getElementById('cbJourney');
  if (!el) return Promise.resolve(jyOk(null));
  return jyMountClient(clientId, el);
}
/* After any change: this client's tracker, the board, and the badge. */
async function jyAfter(clientId, fresh){
  if (fresh && typeof fresh === 'object' && Array.isArray(fresh.steps)) jy.one[clientId] = fresh;
  await Promise.all([jyRemount(clientId), jyLoadBoard(true)]);
  jyPaint();
}

/* ===================== 6. WHAT THE BUTTONS DO ===================== */

function jySay(msg){ if (typeof toast === 'function') { try { toast(msg); } catch (e) {} } }
function jyShowErr(id, msg){
  const e = typeof document !== 'undefined' && document && document.getElementById ? document.getElementById(id) : null;
  if (e) e.textContent = msg;
  return false;
}
function jyField(id){ return typeof val === 'function' ? val(id) : '' }
function jyModal(html){ if (typeof openModal === 'function') openModal(html); return html; }
function jyClose(){ if (typeof closeModal === 'function') closeModal(); }

/* "Draft ready — approve it in Replies", with a button that goes there. */
function jyDraftToast(){
  jySay(JY_DRAFT_SAID);
  const t = typeof document !== 'undefined' && document && document.getElementById ? document.getElementById('toast') : null;
  if (t) {
    t.innerHTML = '<span class="tdot"></span><span>' + jyE(JY_DRAFT_SAID) + '</span>' +
      '<button type="button" class="jy-toast-go" onclick="render(\'drafts\')">Open Replies</button>';
    try { clearTimeout(window._tt); window._tt = setTimeout(() => t.classList.remove('show'), 7000); } catch (e) {}
  }
  return JY_DRAFT_SAID;
}

function jyOpen(clientId){
  if (typeof openClient === 'function') return openClient(clientId);
  return false;
}
async function jyMark(clientId, step, status){
  const key = 'set:' + clientId + ':' + step;
  if (jy.busy[key]) return jyErr('Still working on it.');
  jy.busy[key] = true;
  let r;
  try { r = await jySet(clientId, step, status); } finally { delete jy.busy[key]; }
  if (!r.ok) { jySay(r.error); return r; }
  const title = jyStepTitle(step);
  jySay(status === 'done' ? title + ' done' + (step === 'launch' ? ' — they are live' : '') : status === 'doing' ? title + ' started' : title + ' reopened');
  await jyAfter(clientId, r.data);
  return r;
}
/* One press, one request: a double click on these must never queue two drafts for the client. */
async function jyOnce(key, fn){
  if (jy.busy[key]) return jyErr('Still working on it.');
  jy.busy[key] = true;
  try { return await fn(); } finally { delete jy.busy[key]; }
}
async function jyStart(clientId){
  const r = await jyOnce('start:' + clientId, () => jyStartJourney(clientId));
  if (!r.ok) { jySay(r.error); return r; }
  jySay('Tracker started');
  await jyAfter(clientId);
  return r;
}
function jyAskMove(clientId, step){
  const n = jyNorm(jy.one[clientId]);
  const s = n.steps.find(x => x.step === step);
  return jyModal(jyRenderMoveForm(clientId, step, s ? s.planned_on : ''));
}
async function jyDoMove(clientId, step){
  jyShowErr('jyMvErr', '');
  const r = await jyOnce('move:' + clientId + ':' + step, () => jyMoveStep(clientId, step, jyField('jyMvDay')));
  if (!r.ok) { jyShowErr('jyMvErr', r.error); return r; }
  jyClose();
  jySay(jyStepTitle(step) + ' moved to ' + jyDate(jyField('jyMvDay')));
  await jyAfter(clientId, r.data);
  return r;
}
async function jyOffer(clientId, kind){
  const key = 'offer:' + clientId + ':' + kind;
  if (jy.busy[key]) return jyErr('Still working on it.');
  jy.busy[key] = true;
  let r;
  try { r = await jyOfferTimes(clientId, kind); } finally { delete jy.busy[key]; }
  if (!r.ok) { jySay(r.error); return r; }
  jyDraftToast();
  if (typeof drRefresh === 'function') { try { drRefresh(); } catch (e) {} }
  return r;
}
function jyAskApproval(clientId, kind){ return jyModal(jyRenderApprovalForm(clientId, kind)); }
async function jySendApproval(clientId, kind){
  jyShowErr('jyApErr', '');
  const r = await jyOnce('approval:' + clientId + ':' + kind, () => jyApprovalRequest(clientId, kind, jyField('jyApTitle'), jyField('jyApBody')));
  if (!r.ok) { jyShowErr('jyApErr', r.error); return r; }
  jyClose();
  jyDraftToast();
  return r;
}
function jyAskTesting(clientId){ return jyModal(jyRenderTestingForm(clientId)); }
async function jySendTesting(clientId){
  jyShowErr('jyTdErr', '');
  const sent = jyField('jyTdSent'), rep = jyField('jyTdReplies');
  if (sent === '' || rep === '') { jyShowErr('jyTdErr', 'Fill in sent and replies.'); return jyErr('Fill in sent and replies.'); }
  const r = await jyOnce('testing:' + clientId, () => jyTestingDay(clientId, Number(sent), Number(rep), jyField('jyTdLead'), jyField('jyTdNote')));
  if (!r.ok) { jyShowErr('jyTdErr', r.error); return r; }
  jyClose();
  jyDraftToast();
  return r;
}

if (typeof window !== 'undefined') window.jyMountClient = jyMountClient;
