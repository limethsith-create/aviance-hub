/* ============================================================================
   clientbook.js — Aviance Hub · the clients and the journey
   ----------------------------------------------------------------------------
   Who every client is, what stage they are at, and what needs a person today.
   This replaces the old Clients screen (trials.js). It talks to Supabase only,
   through the shell's `sb` client. There is no other server to call and no
   other server to call it from. Nothing here sends email, buys an inbox, warms
   anything up or touches an API key — those features are gone.

   Tables it owns:   clients  client_profiles  client_stage_history  client_events
   Views it reads:   v_month_standing  v_exposure          (finance.js owns the money)
   Tables it reads:  plan_prices  discovery_bookings  profiles  client_requests

   Every data function returns {ok, data, error} and never throws — the same
   plumbing as finance.js. `error` is a plain sentence, safe to show a person.
   Every render function is pure: data in, HTML string out, every value escaped.
   Nothing runs at load time.

   Prefix: cb.
   ========================================================================== */

/* ===================== 0. THE JOURNEY ===================== */

/* The stages, in order. A client walks these one at a time, forwards or back.
   [key, label, what it means, how many days is too long to sit here] */
const CB_STAGES = [
  ['enquiry',    'Enquiry',    'They asked. Nothing is agreed yet.',                 7],
  ['booked',     'Call booked','A discovery call is in the diary.',                   5],
  ['won',        'Won',        'They said yes. Nothing has been set up yet.',         5],
  ['onboarding', 'Onboarding', 'We are collecting their ICP and their inputs.',      14],
  ['live',       'Live',       'The month clock is running and calls are landing.',   0],
  ['at_risk',    'At risk',    'Something is wrong and they may leave.',             10],
  ['ended',      'Ended',      'They have left. Kept for the record.',                0],
];
const CB_STAGE_KEYS = CB_STAGES.map(s => s[0]);
/* The stages whose clients are still work: Ended is history, Enquiry is not ours yet. */
const CB_LIVE_STAGES = ['booked', 'won', 'onboarding', 'live', 'at_risk'];
/* A month with this many days or fewer to go, still short, is late enough to shout about. */
const CB_WARN_DAYS = 10;
const CB_RELOAD_MS = 60000;

/* What the screens are holding right now. Nothing is loaded until a view asks. */
const cb = {
  clients: null, at: 0, err: '', tried: false,
  standing: [], exposure: null, owners: {}, history: {}, requests: [], profiles: {},
  one: {}, oneErr: {},          /* one[clientId] = {client, profile, months, events, history} */
  needs: null, needsErr: '',
  busy: {},
};
function cbForget(){
  cb.clients = null; cb.at = 0; cb.err = ''; cb.tried = false;
  cb.standing = []; cb.exposure = null; cb.owners = {}; cb.history = {}; cb.requests = []; cb.profiles = {};
  cb.one = {}; cb.oneErr = {}; cb.needs = null; cb.needsErr = ''; cb.busy = {};
}

/* ===================== 1. PLUMBING (copied from finance.js) ===================== */

function cbOk(data){ return {ok:true, data, error:''} }
function cbErr(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return {ok:false, data:null, error:m};
}
/* A supabase result -> {ok,data,error}. Never throws. */
function cbWrap(res, whenEmpty){
  if (!res) return cbErr('No answer from the database.');
  if (res.error) return cbErr(res.error);
  return cbOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
async function cbRun(fn, whenEmpty){
  try { return cbWrap(await fn(), whenEmpty); }
  catch (e) { return cbErr(e); }
}

/* ===================== 2. SMALL PURE HELPERS ===================== */

/* The shell's esc(), with a real fallback so this file stands on its own in a test. */
function cbE(s){
  if (typeof esc === 'function') return esc(s);
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/* A value safe to drop inside an onclick="…" as a JavaScript string. */
function cbAttr(v){ return cbE(JSON.stringify(v == null ? '' : String(v))) }
function cbTrim(v){ return String(v == null ? '' : v).trim() }
function cbInt(v){ const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0 }
const cbUsd = n => '$' + cbInt(n).toLocaleString('en-US');
const cbIsEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cbTrim(s));
const cbToday = () => new Date().toISOString().slice(0,10);

/* "14 Nov", and "14 Nov 2025" when it is not this year — as everywhere else in the hub. */
function cbDate(v){
  if (!v) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v)+'T12:00:00Z' : v);
  if (isNaN(d)) return '—';
  const p = {};
  try {
    new Intl.DateTimeFormat('en-US', {timeZone:'UTC', day:'numeric', month:'short', year:'numeric'})
      .formatToParts(d).forEach(x => { p[x.type] = x.value });
  } catch (e) { return d.toISOString().slice(0,10); }
  return p.day + ' ' + p.month + (d.getUTCFullYear() !== new Date().getUTCFullYear() ? ' ' + p.year : '');
}
/* "3 days" / "1 day" / "today" */
function cbDays(n){
  const d = cbInt(n);
  if (d === 0) return 'today';
  return Math.abs(d) + (Math.abs(d) === 1 ? ' day' : ' days');
}
/* How many whole days ago, or null when we cannot tell. */
function cbAgo(v, now){
  const t = Date.parse(v || '');
  if (!Number.isFinite(t)) return null;
  return Math.floor(((now == null ? Date.now() : now) - t) / 86400000);
}
/* "Won and Onboarding" — a list a person would read out. */
function cbList(items){
  const a = (items || []).filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  return a.slice(0,-1).join(', ') + ' and ' + a[a.length-1];
}
function cbPossessive(n){ const s = cbTrim(n); return s ? s + (/s$/i.test(s) ? "'" : "'s") : 'Their' }

function cbStageIndex(key){ return CB_STAGE_KEYS.indexOf(String(key || '')) }
function cbStage(key){ const i = cbStageIndex(key); return i < 0 ? null : CB_STAGES[i] }
function cbStageLabel(key){ const s = cbStage(key); return s ? s[1] : (cbTrim(key) || 'Not set') }
function cbStageMeaning(key){ const s = cbStage(key); return s ? s[2] : '' }
function cbStageLimit(key){ const s = cbStage(key); return s ? s[3] : 0 }
/* The one stage after this one, and the one before. null at either end. */
function cbStageAfter(key){ const i = cbStageIndex(key); return i >= 0 && i < CB_STAGES.length-1 ? CB_STAGE_KEYS[i+1] : null }
function cbStageBefore(key){ const i = cbStageIndex(key); return i > 0 ? CB_STAGE_KEYS[i-1] : null }

/* ===================== 3. READS ===================== */

async function cbPlans(){
  return cbRun(() => sb.from('plan_prices').select('*').order('monthly_fee'), []);
}
async function cbClients(stage){
  return cbRun(() => {
    let q = sb.from('clients').select('*');
    if (stage) q = q.eq('stage', stage);
    return q.order('created_at', {ascending:false});
  }, []);
}
async function cbClient(clientId){
  if (!clientId) return cbErr('Which client is this about?');
  return cbRun(() => sb.from('clients').select('*').eq('id', clientId).maybeSingle(), null);
}
/* Their ICP and the inputs they gave us at kickoff. One row per client, or none yet. */
async function cbProfile(clientId){
  if (!clientId) return cbErr('Which client is this about?');
  return cbRun(() => sb.from('client_profiles').select('*').eq('client_id', clientId).maybeSingle(), null);
}
/* Every stage this client has been at, newest first. */
async function cbStageHistory(clientId){
  return cbRun(() => {
    let q = sb.from('client_stage_history').select('*');
    if (clientId) q = q.eq('client_id', clientId);
    return q.order('at', {ascending:false});
  }, []);
}
/* The dated history: everything any module has written about this client. */
async function cbEvents(clientId, opts){
  const o = opts || {};
  return cbRun(() => {
    let q = sb.from('client_events').select('*');
    if (clientId) q = q.eq('client_id', clientId);
    if (o.area) q = q.eq('area', o.area);
    return q.order('at', {ascending:false}).limit(Math.min(Math.max(cbInt(o.limit) || 100, 1), 500));
  }, []);
}
/* The months and where each one stands. finance.js owns the rules; we only read. */
async function cbStanding(opts){
  const o = opts || {};
  return cbRun(() => {
    let q = sb.from('v_month_standing').select('*');
    if (o.clientId) q = q.eq('client_id', o.clientId);
    if (o.openOnly) q = q.eq('verdict', 'open');
    return q.order('ends_on');
  }, []);
}
/* What we would owe if every open month ended today and missed. */
async function cbExposure(){
  return cbRun(() => sb.from('v_exposure').select('*').maybeSingle(), null);
}
/* Who on the team looks after whom: {profileId: name}. */
async function cbOwners(){
  const r = await cbRun(() => sb.from('profiles').select('id,name,email'), []);
  if (!r.ok) return r;
  const by = {};
  (r.data || []).forEach(p => { if (p && p.id) by[p.id] = cbTrim(p.name) || cbTrim(p.email) || 'Someone'; });
  return cbOk(by);
}
/* Requests their people have sent that nobody has closed. Read only — the portal owns these. */
async function cbOpenRequests(clientId){
  return cbRun(() => {
    let q = sb.from('client_requests').select('id,client_id,subject,status,created_at');
    if (clientId) q = q.eq('client_id', clientId);
    return q.in('status', ['open','in_progress']).order('created_at');
  }, []);
}

/* ===================== 4. WRITES ===================== */

/* The one helper every other module uses to write a line of a client's history.
   Tiny on purpose: four arguments, one row, one plain sentence when it cannot.
     cbEvent(id, 'meeting', 'held', {meetingId, minutes})
     cbEvent(id, 'invoice', 'sent',  {number:'AV-2026-11'})
   `detail` is whatever that module wants to keep; anything that is not an
   object is kept as {note:"…"} so the column is never null. */
async function cbEvent(clientId, area, event, detail){
  if (!clientId) return cbErr('Which client is this about?');
  const a = cbTrim(area), e = cbTrim(event);
  if (!a) return cbErr('An event needs to say which part of the hub it came from.');
  if (!e) return cbErr('An event needs a name.');
  const d = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail
          : detail == null || detail === '' ? {}
          : {note: String(detail)};
  return cbRun(() => sb.from('client_events').insert({
    client_id: clientId,
    area:      a.slice(0,40),
    event:     e.slice(0,80),
    detail:    d
  }).select().single(), null);
}

/* Why a move was refused, in words a person can act on. */
function cbSkipWhy(company, fromKey, toKey){
  const f = cbStageIndex(fromKey), t = cbStageIndex(toKey);
  const between = CB_STAGES.slice(Math.min(f,t) + 1, Math.max(f,t)).map(s => s[1]);
  const who = cbTrim(company) || 'This client';
  const back = t < f ? ' back' : '';
  return who + ' is at ' + cbStageLabel(fromKey) + '. Moving them' + back + ' to ' +
         cbStageLabel(toKey) + ' would skip ' + cbList(between) +
         '. Move them one stage at a time.';
}

/* Move a client along the journey. Writes three things: the clients row, a line
   in client_stage_history, and a line in client_events. One stage at a time —
   forwards or back; a move that skips a stage is refused and says why. */
async function cbMoveStage(clientId, toStage, note){
  if (!clientId) return cbErr('Which client is this about?');
  const to = cbStageIndex(toStage);
  if (to < 0) return cbErr('There is no stage called "' + cbTrim(toStage) + '". The stages are ' + cbList(CB_STAGES.map(s => s[1])) + '.');

  const got = await cbClient(clientId);
  if (!got.ok) return got;
  if (!got.data) return cbErr('That client is not in the book.');
  const c = got.data;
  const fromKey = cbTrim(c.stage);
  const from = cbStageIndex(fromKey);

  if (from === to) return cbErr((cbTrim(c.company) || 'They') + ' is already at ' + cbStageLabel(toStage) + '.');
  /* A stage we do not know (an old record) cannot be measured, so let it through
     and let the history show where it came from. */
  if (from >= 0 && Math.abs(to - from) > 1) return cbErr(cbSkipWhy(c.company, fromKey, toStage));

  const n = cbTrim(note).slice(0,600);
  const patch = {stage: toStage, updated_at: new Date().toISOString()};
  /* Ended is the one stage that carries a date and a reason of its own. */
  if (toStage === 'ended') { patch.ended_on = c.ended_on || cbToday(); if (n) patch.end_reason = n; }
  else if (fromKey === 'ended') { patch.ended_on = null; patch.end_reason = null; }

  const up = await cbRun(() => sb.from('clients').update(patch).eq('id', clientId).select().single(), null);
  if (!up.ok) return up;

  const by = (typeof authUser !== 'undefined' && authUser && (authUser.uid || authUser.id)) || null;
  const hist = await cbRun(() => sb.from('client_stage_history').insert({
    client_id:  clientId,
    from_stage: fromKey || null,
    to_stage:   toStage,
    by_profile: by,
    note:       n || null
  }).select().single(), null);
  const ev = await cbEvent(clientId, 'stage', 'moved', {from: fromKey || null, to: toStage, note: n || null});

  /* The move itself is done. If a trail line did not save, say so rather than
     pretend the move failed. */
  const lost = [!hist.ok ? 'the stage history' : '', !ev.ok ? 'their history' : ''].filter(Boolean);
  return cbOk({
    client:  up.data,
    history: hist.ok ? hist.data : null,
    event:   ev.ok ? ev.data : null,
    warning: lost.length ? 'Moved to ' + cbStageLabel(toStage) + ', but ' + cbList(lost) + ' could not be written down.' : ''
  });
}

/* Add a client — from a discovery_bookings row (pass bookingId and we fill the
   gaps from it) or by hand. The plan decides the number of calls and the fee,
   and both come from plan_prices. No price is ever written here by hand. */
async function cbAddClient(fields){
  const f = fields || {};
  let company = cbTrim(f.company), name = cbTrim(f.contactName), email = cbTrim(f.contactEmail), site = cbTrim(f.website);

  /* Won on the discovery call: take what they already told us. */
  const bookingId = cbTrim(f.bookingId) || null;
  if (bookingId && (!company || !name || !email)) {
    const b = await cbRun(() => sb.from('discovery_bookings').select('*').eq('id', bookingId).maybeSingle(), null);
    if (!b.ok) return b;
    if (!b.data) return cbErr('That booking is not there any more.');
    company = company || cbTrim(b.data.company);
    name    = name    || cbTrim(b.data.name);
    email   = email   || cbTrim(b.data.email);
    site    = site    || cbTrim(b.data.website);
  }

  if (!company) return cbErr('A client needs a company name.');
  if (!name)    return cbErr('A client needs someone to talk to — add their name.');
  if (!cbIsEmail(email)) return cbErr('That email address does not look right.');

  const plans = await cbPlans();
  if (!plans.ok) return plans;
  const list = plans.data || [];
  const p = list.find(x => x && x.plan === cbTrim(f.plan));
  if (!p) return cbErr(list.length
    ? 'Pick a plan: ' + cbList(list.map(x => cbTrim(x.label) || cbTrim(x.plan))) + '.'
    : 'There are no plans set up yet, so there is no price to put on this client.');

  /* The price, the term and the promise all come from the plan row. */
  const term = f.term === '3month' ? '3month' : 'monthly';
  const fee  = term === '3month' && p.three_month_fee ? p.three_month_fee : p.monthly_fee;
  const stage = CB_STAGE_KEYS.includes(cbTrim(f.stage)) ? cbTrim(f.stage) : 'won';

  const made = await cbRun(() => sb.from('clients').insert({
    booking_id:     bookingId,
    company:        company,
    contact_name:   name,
    contact_email:  email,
    website:        site || null,
    plan:           p.plan,
    term:           term,
    calls_promised: p.calls_promised,
    monthly_fee:    fee,
    pilot_credit:   cbInt(f.pilotCredit),
    owner_id:       cbTrim(f.ownerId) || null,
    stage:          stage,
    notes:          cbTrim(f.notes).slice(0,2000) || null
  }).select().single(), null);
  if (!made.ok) return made;

  const id = made.data && made.data.id;
  if (id) {
    await cbRun(() => sb.from('client_stage_history').insert({
      client_id: id, from_stage: null, to_stage: stage,
      by_profile: (typeof authUser !== 'undefined' && authUser && (authUser.uid || authUser.id)) || null,
      note: bookingId ? 'Added from their discovery call.' : 'Added by hand.'
    }).select().single(), null);
    await cbEvent(id, 'client', 'added', {
      plan: p.plan, term: term, monthly_fee: fee, calls_promised: p.calls_promised,
      stage: stage, from_booking: bookingId
    });
  }
  return cbOk(made.data);
}

/* Save their ICP and inputs, and sign them off. Onboarding cannot finish without this. */
async function cbSaveProfile(clientId, patch){
  if (!clientId) return cbErr('Which client is this about?');
  const p = patch || {};
  const row = {client_id: clientId, updated_at: new Date().toISOString()};
  ['sells_what','sells_to','calendar_url','sender_name','sender_title','time_zone'].forEach(k => {
    if (p[k] !== undefined) row[k] = cbTrim(p[k]) || null;
  });
  if (p.icp !== undefined) row.icp = p.icp && typeof p.icp === 'object' ? p.icp : {};
  if (p.never_email !== undefined) row.never_email = p.never_email && typeof p.never_email === 'object' ? p.never_email : {};
  if (p.slots_per_week !== undefined) row.slots_per_week = cbInt(p.slots_per_week);
  if (p.signedOff !== undefined) row.signed_off_at = p.signedOff ? new Date().toISOString() : null;

  const r = await cbRun(() => sb.from('client_profiles').upsert(row, {onConflict:'client_id'}).select().single(), null);
  if (!r.ok) return r;
  if (p.signedOff !== undefined) await cbEvent(clientId, 'onboarding', p.signedOff ? 'inputs_signed_off' : 'inputs_reopened', {});
  else await cbEvent(clientId, 'onboarding', 'inputs_changed', {fields: Object.keys(row).filter(k => k !== 'client_id' && k !== 'updated_at')});
  return r;
}

/* ===================== 5. WHAT THE NUMBERS MEAN ===================== */

/* The month that is still running, if there is one: the open month that ends soonest. */
function cbOpenMonth(rows, clientId){
  const mine = (rows || []).filter(r => r && (!clientId || r.client_id === clientId));
  const open = mine.filter(r => String(r.verdict || 'open') === 'open');
  const pick = (open.length ? open : mine).slice().sort((a,b) => String(a.ends_on||'').localeCompare(String(b.ends_on||'')));
  return open.length ? pick[0] : (pick.length ? pick[pick.length-1] : null);
}
/* How many calls this month is still short. */
function cbShortBy(m){
  if (!m) return 0;
  return Math.max(0, cbInt(m.calls_promised) - cbInt(m.calls_delivered));
}
/* What this month would cost us if it ended today and missed: month one is double
   the fee, any month after is that month in full (the rule finance.js enforces).
   A month already settled carries its own refund. Nothing at stake when they are
   on track. The view's own number wins when it has one. */
function cbStake(client, m){
  if (!m) return 0;
  if (m.at_risk != null) return cbInt(m.at_risk);
  if (m.verdict && m.verdict !== 'open') return cbInt(m.refund_due);
  if (!cbShortBy(m)) return 0;
  const fee = cbInt(client && client.monthly_fee);
  return cbInt(m.month_no) === 1 ? fee * 2 : fee;
}
/* A month running short, late enough in the month to matter. */
function cbMonthWarns(m){
  if (!m || String(m.verdict || 'open') !== 'open') return false;
  if (m.warn_now != null) return !!m.warn_now;
  return cbShortBy(m) > 0 && cbInt(m.days_left) <= CB_WARN_DAYS;
}

/* Everything we know about one client, as one row a screen can draw.
   bag = {standing, owners, history, requests, profiles, now} — all optional. */
function cbRow(client, bag){
  const b = bag || {};
  const now = b.now == null ? Date.now() : b.now;
  const c = client || {};
  const month = cbOpenMonth(b.standing, c.id);
  const prof = (b.profiles || {})[c.id] || null;
  const reqs = (b.requests || []).filter(r => r && r.client_id === c.id);
  const hist = (b.history || {})[c.id] || null;

  /* How long they have sat where they are: their last stage move, else the row itself. */
  const sinceAt = (hist && hist.at) || c.updated_at || c.created_at || null;
  const sat = cbAgo(sinceAt, now);

  const flags = [];
  if (cbMonthWarns(month)) {
    const short = cbShortBy(month);
    flags.push({code:'month', urgent:true, text:
      'Month ' + cbInt(month.month_no) + ' is ' + short + ' call' + (short === 1 ? '' : 's') +
      ' short with ' + cbDays(month.days_left) + ' left. ' + cbUsd(cbStake(c, month)) + ' at stake.'});
  }
  if (['onboarding','live','at_risk'].includes(cbTrim(c.stage)) && !(prof && prof.signed_off_at)) {
    flags.push({code:'inputs', urgent: cbTrim(c.stage) !== 'onboarding', text:
      prof ? 'Their ICP and inputs are not signed off yet.' : 'They have given us no ICP or inputs yet.'});
  }
  const limit = cbStageLimit(c.stage);
  if (limit > 0 && sat != null && sat > limit) {
    flags.push({code:'stuck', urgent:false, text:
      'Sitting at ' + cbStageLabel(c.stage) + ' for ' + cbDays(sat) + ' — ' + cbDays(limit) + ' is the usual.'});
  }
  if (reqs.length) {
    flags.push({code:'request', urgent:true, text: reqs.length === 1
      ? 'An unanswered request: ' + (cbTrim(reqs[0].subject) || 'no subject') + '.'
      : reqs.length + ' unanswered requests.'});
  }

  return {
    client: c, id: c.id, company: cbTrim(c.company) || 'No name',
    person: cbTrim(c.contact_name), email: cbTrim(c.contact_email),
    stage: cbTrim(c.stage), stageLabel: cbStageLabel(c.stage),
    plan: cbTrim(c.plan), term: cbTrim(c.term), fee: cbInt(c.monthly_fee),
    month: month,
    promised: month ? cbInt(month.calls_promised) : cbInt(c.calls_promised),
    delivered: month ? cbInt(month.calls_delivered) : 0,
    daysLeft: month ? cbInt(month.days_left) : null,
    stake: cbStake(c, month),
    owner: (b.owners || {})[c.owner_id] || '',
    profile: prof, sat: sat, since: sinceAt,
    flags: flags, needs: flags.length, urgent: flags.some(f => f.urgent),
  };
}
/* Every client as a row, newest trouble first. */
function cbRows(clients, bag){
  return (clients || []).filter(Boolean).map(c => cbRow(c, bag));
}
/* Grouped by stage, in journey order, with the ones that need attention first
   inside each group. Stages with nobody in them are left out. */
function cbGroups(rows){
  const out = [];
  CB_STAGES.forEach(([key, label, meaning]) => {
    const mine = (rows || []).filter(r => r.stage === key);
    if (mine.length) out.push({key, label, meaning, rows: cbSortRows(mine)});
  });
  /* A stage we do not recognise still has to show up somewhere. */
  const odd = (rows || []).filter(r => cbStageIndex(r.stage) < 0);
  if (odd.length) out.push({key:'', label:'Stage not set', meaning:'These rows carry a stage the hub does not know.', rows: cbSortRows(odd)});
  return out;
}
function cbSortRows(rows){
  return (rows || []).slice().sort((a,b) =>
    (b.urgent?1:0) - (a.urgent?1:0) ||
    b.flags.length - a.flags.length ||
    b.stake - a.stake ||
    a.company.localeCompare(b.company));
}

/* ===================== 6. RENDERERS (data -> HTML) ===================== */

function cbEmpty(title, sub, btn, action){
  if (typeof emptyState === 'function') return emptyState('', cbE(title), cbE(sub), btn ? cbE(btn) : '', action || '');
  return '<div class="card"><div class="empty"><h3>' + cbE(title) + '</h3><p>' + cbE(sub) + '</p></div></div>';
}
function cbNote(msg, tone){
  return '<div class="cb-note ' + cbE(tone || '') + '" role="status">' + cbE(msg) + '</div>';
}
function cbErrNote(msg){
  return '<div class="cb-note red" role="alert">' + cbE(msg) + '</div>';
}
function cbPill(text, tone){
  return '<span class="pill ' + cbE(tone || 'grey') + '">' + cbE(text) + '</span>';
}
/* The stage a client is at, as a pill that reads the same to a screen reader. */
function cbStagePill(key){
  const tone = key === 'at_risk' ? 'red' : key === 'live' ? 'green' : key === 'ended' ? 'grey'
             : key === 'onboarding' ? 'amber' : key === 'won' ? 'blue' : 'grey';
  return cbPill(cbStageLabel(key), tone);
}
/* "4 of 10" with the shortfall said out loud, because a number alone hides it. */
function cbCallsCell(r){
  if (!r.month) return '<span class="cb-calls none">No month open</span>';
  const short = cbShortBy(r.month);
  const tone = !short ? 'ok' : cbMonthWarns(r.month) ? 'late' : 'short';
  return '<span class="cb-calls ' + tone + '"><b>' + r.delivered + '</b> of ' + r.promised + '</span>' +
    (short ? '<span class="cb-calls-sub">' + cbE(short + ' short') + '</span>' : '');
}
function cbDaysCell(r){
  if (!r.month || r.daysLeft == null) return '<span class="cb-dim">—</span>';
  if (r.daysLeft < 0) return '<span class="cb-dim">' + cbE('ended ' + cbDays(-r.daysLeft) + ' ago') + '</span>';
  return '<span class="cb-left' + (r.daysLeft <= CB_WARN_DAYS ? ' near' : '') + '">' + cbE(cbDays(r.daysLeft) + ' left') + '</span>';
}

/* One client, as a row on the main screen. */
function cbRenderRow(r){
  const go = 'cbGo(' + cbAttr(r.id) + ')';
  const worst = r.flags.length ? r.flags[0].text : '';
  return '<button type="button" class="cb-row' + (r.urgent ? ' urgent' : r.needs ? ' needs' : '') + '" onclick="' + go + '">' +
    '<span class="cb-row-who">' +
      '<span class="cb-co">' + cbE(r.company) + '</span>' +
      (r.person ? '<span class="cb-person">' + cbE(r.person) + '</span>' : '') +
      (r.owner ? '<span class="cb-owner" title="' + cbE('Looked after by ' + r.owner) + '">' + cbE(r.owner) + '</span>' : '<span class="cb-owner none">Nobody</span>') +
    '</span>' +
    '<span class="cb-row-plan">' + (r.plan ? cbPill(r.plan + (r.term === '3month' ? ' · 3 months' : ''), 'grey') : '<span class="cb-dim">No plan</span>') + '</span>' +
    '<span class="cb-row-stage">' + cbStagePill(r.stage) + '</span>' +
    '<span class="cb-row-calls">' + cbCallsCell(r) + '</span>' +
    '<span class="cb-row-days">' + cbDaysCell(r) + '</span>' +
    '<span class="cb-row-stake">' + (r.stake ? '<b class="cb-stake">' + cbE(cbUsd(r.stake)) + '</b>' : '<span class="cb-dim">—</span>') + '</span>' +
    (worst ? '<span class="cb-row-why">' + cbE(worst) + '</span>' : '') +
    '<span class="cb-go" aria-hidden="true">›</span>' +
  '</button>';
}
/* The column headings, said once above the groups. */
function cbRenderHead(){
  return '<div class="cb-head" aria-hidden="true">' +
    ['Client','Plan','Stage','Calls this month','Days left','At stake']
      .map(h => '<span>' + cbE(h) + '</span>').join('') +
  '</div>';
}
/* The whole main screen, from data. Pure. */
function cbRenderClients(rows, meta){
  const m = meta || {};
  if (m.error && !(rows || []).length) return cbErrNote(m.error) + cbEmpty('No clients loaded', 'The list could not be read just now. Try again in a moment.', 'Try again', 'cbReload()');
  if (!(rows || []).length) {
    return (m.error ? cbErrNote(m.error) : '') +
      cbEmpty('No clients yet', 'When a discovery call is won, add them here and the journey starts at Won.', 'Add a client', 'cbOpenAdd()');
  }
  const needs = rows.filter(r => r.needs).length;
  const stake = rows.reduce((s, r) => s + r.stake, 0);
  const groups = cbGroups(rows);
  return (m.error ? cbErrNote(m.error) : '') +
    '<div class="cb-top">' +
      '<div class="cb-sum">' +
        '<div class="card cb-tile"><small>Clients</small><b>' + rows.length + '</b></div>' +
        '<div class="card cb-tile' + (needs ? ' warn' : '') + '"><small>Need a person</small><b>' + needs + '</b></div>' +
        '<div class="card cb-tile' + (stake ? ' warn' : '') + '"><small>At stake</small><b>' + cbE(cbUsd(stake)) + '</b></div>' +
      '</div>' +
      '<div class="cb-top-acts">' +
        (needs ? '<button class="btn ghost" onclick="render(\'needsYou\')">What needs you (' + needs + ')</button>' : '') +
        '<button class="btn" onclick="cbOpenAdd()">Add a client</button>' +
      '</div>' +
    '</div>' +
    cbRenderHead() +
    groups.map(g =>
      '<section class="cb-group">' +
        '<h3 class="cb-group-h">' + cbE(g.label) + ' <small>' + g.rows.length + '</small>' +
        (g.meaning ? '<span class="cb-group-sub">' + cbE(g.meaning) + '</span>' : '') + '</h3>' +
        '<div class="cb-rows">' + g.rows.map(cbRenderRow).join('') + '</div>' +
      '</section>').join('');
}

/* The stage mover on a client's page: one step forward, one step back, and a note. */
function cbRenderMover(r){
  const fwd = cbStageAfter(r.stage), back = cbStageBefore(r.stage);
  const btn = (key, kind) => key
    ? '<button class="btn' + (kind === 'back' ? ' ghost' : '') + '" onclick="cbDoMove(' + cbAttr(r.id) + ',' + cbAttr(key) + ')">' +
      cbE((kind === 'back' ? 'Back to ' : 'Move to ') + cbStageLabel(key)) + '</button>'
    : '';
  return '<section class="card cb-mover" id="cbMover">' +
    '<h3>Where are they?</h3>' +
    '<p class="cb-mover-now">' + cbStagePill(r.stage) + ' <span>' + cbE(cbStageMeaning(r.stage)) + '</span></p>' +
    '<label class="cb-lab" for="cbMoveNote">Why (kept in their history)</label>' +
    '<input id="cbMoveNote" class="cb-in" type="text" maxlength="600" placeholder="Inputs signed off on the call">' +
    '<div class="cb-mover-btns">' + btn(fwd, 'fwd') + btn(back, 'back') + '</div>' +
    (!fwd && !back ? '<p class="cb-dim">' + cbE('There is nowhere to move them from here.') + '</p>' : '') +
    '<p class="cb-mover-rule">' + cbE('One stage at a time, forwards or back. The hub will not let a stage be skipped.') + '</p>' +
    '<div class="cb-err" id="cbMoveErr" role="alert"></div>' +
  '</section>';
}

/* The facts: who they are, what they bought, who looks after them. */
function cbRenderFacts(r){
  const c = r.client;
  const pair = (label, value) => '<div><small>' + cbE(label) + '</small><b>' + (value || '<span class="cb-dim">—</span>') + '</b></div>';
  const site = cbTrim(c.website);
  const url = /^https?:\/\/\S+$/i.test(site) ? site : site ? 'https://' + site : '';
  return '<section class="card cb-facts">' +
    '<h3>The facts</h3>' +
    '<div class="cb-grid">' +
      pair('Who we talk to', cbE(r.person) + (r.email ? '<span class="cb-sub">' + cbE(r.email) + '</span>' : '')) +
      pair('Website', url ? '<a href="' + cbE(url) + '" target="_blank" rel="noopener noreferrer">' + cbE(site) + '</a>' : '') +
      pair('Plan', r.plan ? cbE(r.plan + (r.term === '3month' ? ' · 3-month term' : ' · monthly')) : '') +
      pair('Promised a month', cbE(cbInt(c.calls_promised) + ' calls')) +
      pair('Fee a month', cbE(cbUsd(r.fee))) +
      pair('Looked after by', r.owner ? cbE(r.owner) : '') +
      pair('Inputs signed off', c.inputs_complete_on ? cbE(cbDate(c.inputs_complete_on)) : '') +
      pair('Day one', c.day1_on ? cbE(cbDate(c.day1_on)) : '') +
      (cbInt(c.pilot_credit) ? pair('Pilot credit', cbE(cbUsd(c.pilot_credit) + (c.pilot_credit_used ? ' · used' : ' · not used yet'))) : '') +
      (c.ended_on ? pair('Ended', cbE(cbDate(c.ended_on) + (c.end_reason ? ' · ' + c.end_reason : ''))) : '') +
    '</div>' +
    (cbTrim(c.notes) ? '<p class="cb-notes">' + cbE(c.notes) + '</p>' : '') +
  '</section>';
}

/* Their ICP and the inputs they gave us. An empty profile says what is missing. */
function cbRenderProfile(r){
  const p = r.profile;
  if (!p) return '<section class="card cb-icp"><h3>Their ICP and inputs</h3>' +
    '<p class="cb-dim">' + cbE('Nothing yet. ' + cbPossessive(r.company) + ' ICP, who they sell to and their calendar all come in at onboarding.') + '</p></section>';
  const bits = [];
  const line = (label, value) => { if (cbTrim(value)) bits.push('<div><small>' + cbE(label) + '</small><b>' + cbE(value) + '</b></div>'); };
  line('What they sell', p.sells_what);
  line('Who they sell to', p.sells_to);
  line('Signs the emails', [cbTrim(p.sender_name), cbTrim(p.sender_title)].filter(Boolean).join(', '));
  line('Their time zone', p.time_zone);
  line('Slots a week', p.slots_per_week != null ? String(p.slots_per_week) : '');
  line('Calendar', p.calendar_url);
  const jsonList = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x));
    if (typeof v === 'object') return Object.keys(v).map(k => k + ': ' + (Array.isArray(v[k]) ? v[k].join(', ') : typeof v[k] === 'object' ? JSON.stringify(v[k]) : String(v[k])));
    return [String(v)];
  };
  const icp = jsonList(p.icp), never = jsonList(p.never_email);
  return '<section class="card cb-icp">' +
    '<h3>Their ICP and inputs</h3>' +
    (p.signed_off_at
      ? cbNote('Signed off on ' + cbDate(p.signed_off_at) + '.', 'green')
      : cbNote('Not signed off yet. Onboarding is not finished until they agree this is right.', 'amber')) +
    (bits.length ? '<div class="cb-grid">' + bits.join('') + '</div>' : '') +
    (icp.length ? '<h4>' + cbE('Who counts as a good call') + '</h4><ul class="cb-tags">' + icp.map(x => '<li>' + cbE(x) + '</li>').join('') + '</ul>' : '') +
    (never.length ? '<h4>' + cbE('Never contact') + '</h4><ul class="cb-tags off">' + never.map(x => '<li>' + cbE(x) + '</li>').join('') + '</ul>' : '') +
  '</section>';
}

/* Every month and where it stands. The words are finance.js's, if it is loaded. */
function cbRenderMonths(r, months){
  const rows = (months || []).slice().sort((a,b) => cbInt(a.month_no) - cbInt(b.month_no));
  if (!rows.length) return '<section class="card cb-months"><h3>Their months</h3>' +
    '<p class="cb-dim">' + cbE('No month has opened yet. The clock starts on day one.') + '</p></section>';
  const say = m => typeof fnMonthLine === 'function' ? fnMonthLine(m) : cbMonthLine(m);
  const tone = m => m.verdict === 'hit' ? 'green' : m.verdict === 'missed' ? 'red' : m.verdict === 'waived' ? 'grey' : cbMonthWarns(m) ? 'amber' : 'blue';
  return '<section class="card cb-months">' +
    '<h3>Their months</h3>' +
    '<ul class="cb-monthlist">' + rows.map(m =>
      '<li class="' + cbE(tone(m)) + '">' + cbPill(cbTrim(m.verdict) || 'open', tone(m)) +
      '<span class="cb-month-say">' + cbE(say(m)) + '</span>' +
      '<span class="cb-month-when">' + cbE(cbDate(m.starts_on) + ' – ' + cbDate(m.ends_on)) + '</span>' +
      (cbInt(m.refund_due) ? '<b class="cb-stake">' + cbE(cbUsd(m.refund_due) + ' refunded') + '</b>' : '') +
      '</li>').join('') + '</ul>' +
  '</section>';
}
/* The same sentence finance.js writes, for when finance.js is not loaded. */
function cbMonthLine(m){
  if (!m) return '';
  if (m.verdict === 'hit')    return 'Month ' + m.month_no + ': hit — ' + m.calls_delivered + ' of ' + m.calls_promised + ' calls.';
  if (m.verdict === 'missed') return 'Month ' + m.month_no + ': missed — ' + m.calls_delivered + ' of ' + m.calls_promised + '.';
  if (m.verdict === 'waived') return 'Month ' + m.month_no + ': set aside.';
  const left = cbInt(m.days_left);
  return 'Month ' + m.month_no + ': ' + cbInt(m.calls_delivered) + ' of ' + cbInt(m.calls_promised) + ' calls, ' +
    (left < 0 ? 'the month has ended' : left === 0 ? 'last day' : cbDays(left) + ' left') + '.';
}

/* The dated history: every line any module has written, newest first. */
function cbEventWords(ev){
  const d = ev && ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
  const area = cbTrim(ev && ev.area), name = cbTrim(ev && ev.event);
  if (area === 'stage' && name === 'moved') {
    return 'Moved ' + (d.from ? 'from ' + cbStageLabel(d.from) + ' ' : '') + 'to ' + cbStageLabel(d.to) +
      (cbTrim(d.note) ? ' — ' + cbTrim(d.note) : '');
  }
  if (area === 'client' && name === 'added') return 'Added as a client on the ' + cbTrim(d.plan) + ' plan.';
  /* Anything another module wrote: its own words if it gave any, else the name. */
  if (cbTrim(d.words)) return cbTrim(d.words);
  if (cbTrim(d.note))  return name.replace(/_/g,' ') + ' — ' + cbTrim(d.note);
  return name.replace(/_/g,' ');
}
function cbRenderHistory(events){
  const rows = (events || []).filter(Boolean);
  if (!rows.length) return '<section class="card cb-hist"><h3>Their history</h3>' +
    '<p class="cb-dim">' + cbE('Nothing has happened yet. Every move, meeting and invoice shows up here.') + '</p></section>';
  return '<section class="card cb-hist">' +
    '<h3>Their history</h3>' +
    '<ol class="cb-timeline">' + rows.map(ev =>
      '<li><span class="cb-when">' + cbE(cbDate(ev.at)) + '</span>' +
      '<span class="cb-area">' + cbE(cbTrim(ev.area) || 'hub') + '</span>' +
      '<span class="cb-what">' + cbE(cbEventWords(ev)) + '</span></li>').join('') + '</ol>' +
  '</section>';
}

/* What needs a person on this one client, said at the top of their page. */
function cbRenderFlags(r){
  if (!r.flags.length) return cbNote('Nothing here needs you today.', 'green');
  return '<section class="card cb-flags' + (r.urgent ? ' urgent' : '') + '">' +
    '<h3>' + cbE('What needs you') + '</h3>' +
    '<ul>' + r.flags.map(f => '<li class="' + cbE(f.urgent ? 'urgent' : '') + '">' + cbE(f.text) + '</li>').join('') + '</ul>' +
  '</section>';
}

/* One client's whole page, from data. Pure. */
function cbRenderClient(r, months, events){
  if (!r) return cbEmpty('That client is not here', 'The link may be old, or they may have been removed.', 'Back to clients', "render('clients')");
  return '<div class="cb-one">' +
    '<header class="cb-one-head">' +
      '<div><h2>' + cbE(r.company) + '</h2>' +
      '<p class="cb-one-sub">' + cbStagePill(r.stage) +
      (r.sat != null ? ' <span class="cb-dim">' + cbE('here ' + cbDays(r.sat) + (r.sat === 0 ? '' : ' now')) + '</span>' : '') + '</p></div>' +
      '<button class="btn ghost" onclick="render(\'clients\')">All clients</button>' +
    '</header>' +
    cbRenderFlags(r) +
    cbRenderFacts(r) +
    cbRenderMover(r) +
    cbRenderProfile(r) +
    cbRenderMonths(r, months) +

    /* ---- where the rest of the hub hangs off this page ----
       Each of these is another agent's screen. The anchor is here, with the
       client's id, so that module can fill it in without touching this file.
       Do not write these here. */
    // TODO: meetings — their discovery, onboarding and launch calls (meetings).
    //       Mount into #cbMeetings with the client's id.
    '<section class="card cb-slot" id="cbMeetings" data-cb-client="' + cbE(r.id) + '"></section>' +
    // TODO: outreach — their campaigns, replies and booked calls (v_outreach_summary).
    '<section class="card cb-slot" id="cbOutreach" data-cb-client="' + cbE(r.id) + '"></section>' +
    // TODO: invoices and refunds — finance.js owns the money; link it in here.
    '<section class="card cb-slot" id="cbInvoices" data-cb-client="' + cbE(r.id) + '"></section>' +
    // TODO: their people — client_people and portal_invites, and their open requests.
    '<section class="card cb-slot" id="cbPeople" data-cb-client="' + cbE(r.id) + '"></section>' +
    // TODO: handover — what we send them when they leave (handovers).
    '<section class="card cb-slot" id="cbHandover" data-cb-client="' + cbE(r.id) + '"></section>' +

    cbRenderHistory(events) +
  '</div>';
}

/* The short list across every client of what is actually behind. */
function cbRenderNeeds(rows, meta){
  const m = meta || {};
  const mine = (rows || []).filter(r => r.needs);
  if (m.error && !mine.length) return cbErrNote(m.error);
  if (!(rows || []).length) return (m.error ? cbErrNote(m.error) : '') +
    cbEmpty('Nothing to do', 'There are no clients yet, so nothing is behind.', 'Add a client', 'cbOpenAdd()');
  if (!mine.length) return (m.error ? cbErrNote(m.error) : '') +
    cbEmpty('Nothing is behind', 'Every month is on track, every input is signed off and nobody is waiting on an answer.', 'All clients', "render('clients')");
  const items = [];
  cbSortRows(mine).forEach(r => r.flags.forEach(f => items.push({r, f})));
  return (m.error ? cbErrNote(m.error) : '') +
    '<p class="cb-needs-lead">' + cbE(items.length + (items.length === 1 ? ' thing needs' : ' things need') + ' a person, across ' +
      mine.length + (mine.length === 1 ? ' client' : ' clients') + '.') + '</p>' +
    '<ul class="cb-needs">' + items.map(({r, f}) =>
      '<li class="' + cbE(f.urgent ? 'urgent' : '') + '">' +
        '<button type="button" onclick="cbGo(' + cbAttr(r.id) + ')">' +
          '<span class="cb-needs-co">' + cbE(r.company) + '</span>' +
          '<span class="cb-needs-stage">' + cbStagePill(r.stage) + '</span>' +
          '<span class="cb-needs-what">' + cbE(f.text) + '</span>' +
          '<span class="cb-go" aria-hidden="true">›</span>' +
        '</button>' +
      '</li>').join('') + '</ul>';
}

/* ===================== 7. LOADING ===================== */

/* Everything the main screen and the needs list both want, in one go. */
async function cbLoadAll(force){
  if (cb.busy.all) return cb.busy.all;
  if (!force && cb.clients && Date.now() - cb.at < CB_RELOAD_MS) return cbOk(cb.clients);
  cb.busy.all = (async () => {
    const [clients, standing, owners, requests, hist, profiles] = await Promise.all([
      cbClients(), cbStanding(), cbOwners(), cbOpenRequests(), cbStageHistory(null),
      cbRun(() => sb.from('client_profiles').select('client_id,signed_off_at,icp'), [])
    ]);
    if (!clients.ok) { cb.err = clients.error; cb.at = Date.now(); cb.tried = true; return clients; }
    cb.clients = clients.data || [];
    cb.standing = standing.ok ? (standing.data || []) : [];
    cb.owners = owners.ok ? (owners.data || {}) : {};
    cb.requests = requests.ok ? (requests.data || []) : [];
    /* Only the newest move per client is needed to say how long they have sat. */
    cb.history = {};
    (hist.ok ? hist.data || [] : []).forEach(h => { if (h && h.client_id && !cb.history[h.client_id]) cb.history[h.client_id] = h; });
    cb.profiles = {};
    (profiles.ok ? profiles.data || [] : []).forEach(p => { if (p && p.client_id) cb.profiles[p.client_id] = p; });
    /* A part that did not load is said out loud, not hidden. */
    const bad = [!standing.ok ? 'their months' : '', !requests.ok ? 'their requests' : ''].filter(Boolean);
    cb.err = bad.length ? 'Showing the clients, but ' + cbList(bad) + ' could not be read just now.' : '';
    cb.at = Date.now();
    cb.tried = true;
    return cbOk(cb.clients);
  })();
  try { return await cb.busy.all; }
  finally { delete cb.busy.all; }
}
/* One client, with their months, their profile and their history. */
async function cbLoadOne(clientId, force){
  if (!clientId) return cbErr('Which client is this about?');
  const key = 'one:' + clientId;
  if (cb.busy[key]) return cb.busy[key];
  if (!force && cb.one[clientId]) return cbOk(cb.one[clientId]);
  cb.busy[key] = (async () => {
    const [client, profile, months, events, hist, reqs, owners] = await Promise.all([
      cbClient(clientId), cbProfile(clientId), cbStanding({clientId}), cbEvents(clientId),
      cbStageHistory(clientId), cbOpenRequests(clientId),
      Object.keys(cb.owners || {}).length ? Promise.resolve(cbOk(cb.owners)) : cbOwners()
    ]);
    if (!client.ok) { cb.oneErr[clientId] = client.error; return client; }
    cb.one[clientId] = {
      client: client.data, profile: profile.ok ? profile.data : null,
      months: months.ok ? months.data || [] : [], events: events.ok ? events.data || [] : [],
      history: hist.ok ? hist.data || [] : [], requests: reqs.ok ? reqs.data || [] : [],
      owners: owners.ok ? owners.data || {} : {},
      err: [!months.ok ? 'their months' : '', !events.ok ? 'their history' : ''].filter(Boolean).length
        ? 'Some of this page could not be read just now.' : ''
    };
    cb.oneErr[clientId] = '';
    return cbOk(cb.one[clientId]);
  })();
  try { return await cb.busy[key]; }
  finally { delete cb.busy[key]; }
}

/* ===================== 8. THE SCREENS ===================== */

/* The shell calls a view's fn() for HTML, then its after() to kick a load. These
   return what we have and ask for the rest; cbPaint() draws again when it lands. */
/* The three screens this file draws. Only these are ever redrawn from here. */
const CB_VIEWS = ['clients', 'client', 'needsYou'];
function cbPaint(){
  if (typeof render !== 'function' || typeof currentView === 'undefined') return;
  if (CB_VIEWS.indexOf(String(currentView || '')) < 0) return;
  try { render(currentView); } catch (e) {}
}
function cbLoading(what){
  return '<div class="cb-loading" role="status">' + cbE('Loading ' + (what || 'the clients') + '…') + '</div>';
}
function cbReload(){ cb.tried = false; cbLoadAll(true).then(cbPaint) }

/* Open one client. The shell's openClient() sets the id its 'client' view reads;
   on its own, this file remembers it. */
function cbGo(clientId){
  cbOpenId = cbTrim(clientId) || null;
  if (typeof openClient === 'function') return openClient(clientId);
  if (typeof render === 'function') render('client');
}

/* Everything cbRow() needs about every client, from what is loaded. */
function cbBag(extra){
  return Object.assign({standing:cb.standing, owners:cb.owners, history:cb.history,
                        requests:cb.requests, profiles:cb.profiles}, extra || {});
}

/* ---- the main screen ---- */
function viewClients(){
  if (!cb.clients) {
    if (!cb.tried) { cbLoadAll().then(cbPaint); return cbLoading('the clients'); }
    return cbRenderClients([], {error: cb.err});   /* it was asked for and it would not come */
  }
  return cbRenderClients(cbRows(cb.clients, cbBag()), {error: cb.err});
}

/* ---- one client ----
   A view function is pure: it is handed the id and returns HTML. Going to a
   client is openClient()'s job in the shell — never render() from in here, or
   the 'client' view would draw itself for ever. */
let cbOpenId = null;
function viewClient(clientId){
  const id = cbTrim(clientId) || cbOpenId ||
    (typeof currentClientId !== 'undefined' && currentClientId ? String(currentClientId) : '');
  if (!id) return cbEmpty('No client chosen', 'Pick someone from the clients list.', 'All clients', "render('clients')");
  cbOpenId = id;
  const got = cb.one[id];
  if (!got) { cbLoadOne(id).then(cbPaint); return cbLoading('their page'); }
  const r = cbRow(got.client, {
    standing: got.months, owners: got.owners, requests: got.requests,
    profiles: got.profile ? {[id]: got.profile} : {},
    history: got.history && got.history.length ? {[id]: got.history[0]} : {}
  });
  return (got.err ? cbErrNote(got.err) : '') + cbRenderClient(got.client ? r : null, got.months, got.events);
}

/* ---- what needs a person today ---- */
function viewNeedsYou(){
  if (!cb.clients) {
    if (!cb.tried) { cbLoadAll().then(cbPaint); return cbLoading('what needs you'); }
    return cbRenderNeeds([], {error: cb.err});
  }
  return cbRenderNeeds(cbRows(cb.clients, cbBag()), {error: cb.err});
}

/* ===================== 9. WHAT THE BUTTONS DO ===================== */

function cbSay(msg){ if (typeof toast === 'function') toast(msg); }
function cbShowErr(id, msg){
  if (typeof errEl === 'function') return errEl(id, msg);
  const e = typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
  if (e) e.textContent = msg;
  return false;
}
function cbField(id){ return typeof val === 'function' ? val(id) : '' }

/* Move them, from the mover on their page. */
async function cbDoMove(clientId, toStage){
  cbShowErr('cbMoveErr', '');
  const r = await cbMoveStage(clientId, toStage, cbField('cbMoveNote'));
  if (!r.ok) { cbShowErr('cbMoveErr', r.error); return r; }
  if (r.data && r.data.warning) cbSay(r.data.warning);
  else cbSay('Moved to ' + cbStageLabel(toStage));
  delete cb.one[clientId];
  cb.clients = null; cb.tried = false;
  await cbLoadOne(clientId, true);
  cbPaint();
  return r;
}

/* Add a client by hand. The plans come from plan_prices, so the prices are never typed. */
async function cbOpenAdd(bookingId){
  const plans = await cbPlans();
  const list = plans.ok ? plans.data || [] : [];
  const opts = list.map(p => '<option value="' + cbE(p.plan) + '">' +
    cbE((cbTrim(p.label) || cbTrim(p.plan)) + ' — ' + cbInt(p.calls_promised) + ' calls, ' + cbUsd(p.monthly_fee) + ' a month') + '</option>').join('');
  const html = '<div class="cb-add"><h3>Add a client</h3>' +
    (!list.length ? cbErrNote('There are no plans set up, so there is no price to put on a client yet.') : '') +
    '<input type="hidden" id="cbAddBooking" value="' + cbE(bookingId || '') + '">' +
    '<label class="cb-lab" for="cbAddCo">Company</label><input id="cbAddCo" class="cb-in" type="text" maxlength="200">' +
    '<label class="cb-lab" for="cbAddName">Who we talk to</label><input id="cbAddName" class="cb-in" type="text" maxlength="200">' +
    '<label class="cb-lab" for="cbAddEmail">Their email</label><input id="cbAddEmail" class="cb-in" type="email" maxlength="200">' +
    '<label class="cb-lab" for="cbAddSite">Website</label><input id="cbAddSite" class="cb-in" type="text" maxlength="300">' +
    '<label class="cb-lab" for="cbAddPlan">Plan</label><select id="cbAddPlan" class="cb-in">' + opts + '</select>' +
    '<label class="cb-lab" for="cbAddTerm">Term</label><select id="cbAddTerm" class="cb-in">' +
      '<option value="monthly">Monthly</option><option value="3month">Three months, billed up front</option></select>' +
    '<div class="cb-err" id="cbAddErr" role="alert"></div>' +
    '<div class="cb-mover-btns"><button class="btn" onclick="cbSaveAdd()">Add them</button>' +
    '<button class="btn ghost" onclick="closeModal()">Cancel</button></div></div>';
  if (typeof openModal === 'function') openModal(html);
  return html;
}
async function cbSaveAdd(){
  cbShowErr('cbAddErr', '');
  const r = await cbAddClient({
    bookingId: cbField('cbAddBooking'), company: cbField('cbAddCo'),
    contactName: cbField('cbAddName'), contactEmail: cbField('cbAddEmail'),
    website: cbField('cbAddSite'), plan: cbField('cbAddPlan'), term: cbField('cbAddTerm')
  });
  if (!r.ok) { cbShowErr('cbAddErr', r.error); return r; }
  if (typeof closeModal === 'function') closeModal();
  cbSay((cbTrim(r.data && r.data.company) || 'They') + ' is in the book');
  cb.clients = null; cb.tried = false;
  await cbLoadAll(true);
  cbPaint();
  return r;
}

/* The shell calls this after every render. Keeps the lists warm, nothing else. */
function cbOnRender(view){
  if (view === 'clients' || view === 'needsYou') cbLoadAll().then(() => {});
  else if (view === 'client' && cbOpenId) cbLoadOne(cbOpenId).then(() => {});
}
