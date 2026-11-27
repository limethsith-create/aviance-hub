/* ============================================================================
   clientbook.js — Aviance OS · the clients and the journey
   ----------------------------------------------------------------------------
   Who every client is, what stage they are at, and what needs a person today.
   It talks to Supabase only, through the shell's `sb` client. Nothing here
   sends email.

   Tables it owns:   clients  client_profiles  client_stage_history  client_events
   Views it reads:   v_month_standing  v_exposure          (finance.js owns the money)
   Tables it reads:  plan_prices  discovery_bookings  profiles  client_requests
                     invoices (admin only, to list them on the client's page;
                     marking one paid goes through finance.js fnMarkInvoicePaid)

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
/* A month with this many days or fewer to go, still short, is late enough to shout about. */
const CB_WARN_DAYS = 10;
const CB_RELOAD_MS = 60000;

/* What the screens are holding right now. Nothing is loaded until a view asks. */
const cb = {
  clients: null, at: 0, err: '', tried: false,
  standing: [], owners: {}, history: {}, requests: [], profiles: {},
  one: {}, oneErr: {},          /* one[clientId] = {client, profile, months, events, history} */
  agreements: {}, firstInv: {},  /* newest agreement, and the first invoice, by client id */
  seats: {}, seatsErr: {},       /* portal_seat_state() by client id — who can sign in */
  cal: {}, calErr: {},           /* their connected calendars, by client id */
  busy: {},
};
/* SOMETHING ELSE CHANGED A CLIENT. This file keeps what it read — one copy of
   the list, one of each client's page — and until round 3 nothing outside it
   could say that copy was old. So a call marked "they showed" on the Calendar, a
   month locked on Month end, an invoice marked paid on Money and a login handed
   out on Their people all left the client's own page showing the figure from
   before, for the rest of the session: "4 of 10" beside a commitment board that
   said 5. The other screens call this after a write. With an id, that client's
   page; with none, every page. The list is always marked, because its row for
   that client is built from the same rows. */
function cbStale(clientId){
  const id = cbTrim(clientId);
  cb.listStale = true;
  if (id) { if (cb.one[id]) cb.one[id].stale = true; }
  else Object.keys(cb.one).forEach(k => { if (cb.one[k]) cb.one[k].stale = true; });
  return true;
}
function cbForget(){
  cb.clients = null; cb.at = 0; cb.err = ''; cb.tried = false;
  cb.standing = []; cb.owners = {}; cb.history = {}; cb.requests = []; cb.profiles = {};
  cb.one = {}; cb.oneErr = {}; cb.busy = {}; cb.endSaid = null; cb.listStale = false;
  cb.agreements = {}; cb.firstInv = {};
  cb.seats = {}; cb.seatsErr = {}; cb.cal = {}; cb.calErr = {};
}

/* ===================== 1. PLUMBING (copied from finance.js) ===================== */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const cbOk = coreOk;
const cbErr = coreErr;
const cbWrap = coreWrap;
/* A supabase result -> {ok,data,error}. Never throws. */
async function cbRun(fn, whenEmpty){
  try { return cbWrap(await fn(), whenEmpty); }
  catch (e) { return cbErr(e); }
}

/* ===================== 2. SMALL PURE HELPERS ===================== */

/* The one escape, from core.js: strict, five characters, the single quote among them. */
const cbE = coreEsc;
/* A value safe inside onclick="…" as a JavaScript string, from core.js. */
const cbAttr = coreAttr;
function cbTrim(v){ return String(v == null ? '' : v).trim() }
function cbInt(v){ const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0 }
/* Whole dollars, grouped, with a dollar sign — from core.js. */
const cbUsd = coreUsd;
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

/* "growth" → "Growth": a plan's name, as the owner reads it. A plan code that is no
   longer on offer reads "Retired plan" (finance.js), so an old client still shows. */
function cbPlanWord(p){
  const k = cbTrim(p).toLowerCase();
  return fnPlanWord(k) || (k ? k.charAt(0).toUpperCase() + k.slice(1) : '');
}
/* "Growth · monthly" for the client's page, "Growth · 3 months" for a row. A retired
   plan has no term worth saying. */
function cbPlanLine(plan, term, short){
  const w = cbPlanWord(plan);
  if (!w || fnPlanRetired(plan)) return w;
  return w + (term === '3month' ? (short ? ' · 3 months' : ' · 3-month term') : (short ? '' : ' · monthly'));
}

function cbStageIndex(key){ return CB_STAGE_KEYS.indexOf(String(key || '')) }
function cbStage(key){ const i = cbStageIndex(key); return i < 0 ? null : CB_STAGES[i] }
function cbStageLabel(key){ const s = cbStage(key); return s ? s[1] : (cbTrim(key) || 'Not set') }
function cbStageMeaning(key){ const s = cbStage(key); return s ? s[2] : '' }
function cbStageLimit(key){ const s = cbStage(key); return s ? s[3] : 0 }
/* The one stage after this one, and the one before. null at either end. */
function cbStageAfter(key){ const i = cbStageIndex(key); return i >= 0 && i < CB_STAGES.length-1 ? CB_STAGE_KEYS[i+1] : null }
function cbStageBefore(key){ const i = cbStageIndex(key); return i > 0 ? CB_STAGE_KEYS[i-1] : null }

/* ===================== 3. READS ===================== */

/* The plans a new client may be put on. finance.js reads plan_prices and leaves
   out every code that is no longer on offer, so there is one filter, not two. */
async function cbPlans(){ return fnPlans() }
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
/* Their agreements, newest first. The team can read these. */
async function cbAgreements(clientId){
  return cbRun(() => {
    let q = sb.from('client_agreements').select('id,client_id,status,signed_name,signed_at,created_at');
    if (clientId) q = q.eq('client_id', clientId);
    return q.order('created_at', {ascending:false});
  }, []);
}
/* Each client's first invoice (the one close_won raised). Admin only, like every invoice. */
async function cbFirstInvoices(){
  if (!cbIsAdmin()) return cbOk([]);
  return cbRun(() => sb.from('invoices').select('id,client_id,number,amount,status,due_on,paid_at,is_first,created_at')
    .eq('is_first', true), []);
}
/* The person we talk to there: their phone and their role. */
async function cbPerson(clientId){
  if (!clientId) return cbErr('Which client is this about?');
  return cbRun(() => sb.from('client_people').select('*').eq('client_id', clientId)
    .order('is_primary', {ascending:false}).limit(1), []);
}
/* Their private channel with us, if close_won made one. */
async function cbChannel(clientId){
  if (!clientId) return cbErr('Which client is this about?');
  return cbRun(() => sb.from('channels').select('id,name,kind,client_id,archived_at').eq('client_id', clientId).limit(1), []);
}
/* The signed doc.html link to one invoice, for the owner to open. */
async function cbInvoiceLink(invoiceId){
  if (!invoiceId) return cbErr('Which invoice is this about?');
  return cbRun(() => sb.rpc('invoice_link', {p_invoice: invoiceId}), '');
}
/* Send the agreement and the invoice again, with fresh links. */
async function cbResendPack(clientId){
  if (!clientId) return cbErr('Which client is this about?');
  return cbRun(() => sb.rpc('resend_pack', {p_client: clientId}), null);
}
/* Their invoices, newest first. Only an admin can read invoices, so anyone else
   gets an empty list without the database being asked. */
function cbIsAdmin(){
  try { return typeof authUser !== 'undefined' && !!authUser && authUser.role === 'admin'; } catch (e) { return false; }
}
async function cbInvoices(clientId){
  if (!clientId) return cbErr('Which client is this about?');
  if (!cbIsAdmin()) return cbOk([]);
  return cbRun(() => sb.from('invoices').select('*').eq('client_id', clientId)
    .order('issued_on', {ascending:false}), []);
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
/* THROUGH finance.js, WHICH READS IT A PAGE AT A TIME. This used to read the view
   whole, oldest month first. The database answers one page (1,000 rows) and says
   nothing about the rest, so from the 1,001st month on the books the rows that
   fell off were the NEWEST — the months that are open today. Measured at 100
   clients and 13 months: "$0 at stake" against a true $214,500, and "What needs
   you (20)" against 80. fnStanding pages, and refuses in words at its ceiling.
   Without finance.js loaded this refuses too: a part of the months is not shown
   as all of them. */
async function cbStanding(opts){
  const o = opts || {};
  if (typeof fnStanding !== 'function') return cbErr('The money side of Aviance OS did not load, so the months cannot be read. Reload the page.');
  try { return await fnStanding(o); }
  catch (e) { return cbErr(e); }
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
  if (!a) return cbErr('An event needs to say which part of Aviance OS it came from.');
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

  /* ENDING IS NOT A STAGE CHANGE. wrapup.js's wuEndClient is the orderly ending:
     it recounts and locks every month that has FINISHED (which is what raises a
     refund the guarantee owes), leaves alone the months that have not, refuses
     if a finished month cannot be judged, sets the date and the reason, and
     pauses what is still sending. Until round 3 nothing in the browser called
     it. This button wrote stage = 'ended' straight onto the row, so a client
     could leave with a finished, short month still open — no verdict, no refund
     row, nothing on Money — and Month end then told the owner to "close it from
     the Ending screen", which has no button that closes anything. */
  let ending = null, up;
  if (toStage === 'ended' && typeof wuEndClient === 'function') {
    const end = await wuEndClient(clientId, {reason: n, lastDay: patch.ended_on});
    if (!end.ok) return end;
    ending = end.data || null;
    up = cbOk((ending && ending.client) || Object.assign({}, c, patch));
  } else {
    up = await cbRun(() => sb.from('clients').update(patch).eq('id', clientId).select().single(), null);
    if (!up.ok) return up;
  }

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
    ending:  ending,
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
  /* a plan code from before the three plans: refused in words, never mapped to another */
  if (fnPlanRetired(cbTrim(f.plan))) return cbErr(FN_RETIRED_SAYS);
  const list = plans.data;
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
/* EVERY month this client still has running, added up — the row's figure and the
   "At stake" tile. `cbStake` answers for ONE month, and the tile used to add up
   one month per client, so a client who had two months open at once (the normal
   state the day a month ends before it has been locked) was counted once. The
   database's own total, v_exposure.at_risk_total, sums every open month, so the
   tile and the Today screen disagreed about the same business. This sums the
   same months the same way, over the clients on screen: every number comes from
   v_month_standing.at_risk, worked out in the database, never here.
   A month already settled is not at stake — it is a refund, and it has its own
   line on the client. */
function cbStakeAll(client, rows){
  const c = client || {};
  return (Array.isArray(rows) ? rows : [])
    .filter(m => m && m.client_id === c.id && String(m.verdict || 'open') === 'open')
    .reduce((s, m) => s + cbStake(c, m), 0);
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
      ' short ' + cbWhenWords(month.days_left) + '. ' + cbUsd(cbStake(c, month)) + ' at stake.'});
  }
  if (['onboarding','live','at_risk'].includes(cbTrim(c.stage)) && !(prof && prof.signed_off_at)) {
    flags.push({code:'inputs', urgent: cbTrim(c.stage) !== 'onboarding', text:
      prof ? 'Their ICP and inputs are not signed off yet.' : 'They have given us no ICP or inputs yet.'});
  }
  const waiting = cbWaiting(c, (b.agreements || {})[c.id], (b.firstInvoices || {})[c.id], now);
  if (waiting) flags.push(waiting);
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
    stake: cbStakeAll(c, b.standing),
    owner: (b.owners || {})[c.owner_id] || '',
    profile: prof, sat: sat, since: sinceAt,
    flags: flags, needs: flags.length, urgent: flags.some(f => f.urgent),
  };
}
/* A won client still waiting on us being paid, or on their signature:
   "Waiting on: agreement signature · payment (due 1 Dec)". Overdue is urgent;
   before the due date it is only waiting. null when nothing is outstanding. */
function cbWaiting(client, agreement, invoice, now){
  const c = client || {};
  if (['won','onboarding','live','at_risk'].indexOf(cbTrim(c.stage)) < 0) return null;
  const parts = [];
  const ag = agreement || null, inv = invoice || null;
  if (ag && ['signed','void'].indexOf(cbTrim(ag.status)) < 0) parts.push('agreement signature');
  let late = false;
  if (inv && ['paid','void'].indexOf(cbTrim(inv.status)) < 0) {
    const today = new Date(now == null ? Date.now() : now).toISOString().slice(0,10);
    const due = cbTrim(inv.due_on).slice(0,10);
    late = cbTrim(inv.status) === 'overdue' || (!!due && due < today);
    parts.push('payment' + (due ? (late ? ' (overdue since ' + cbDate(due) + ')' : ' (due ' + cbDate(due) + ')') : ''));
  }
  if (!parts.length) return null;
  return {code:'waiting', urgent: late, text: 'Waiting on: ' + parts.join(' · ')};
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
  if (odd.length) out.push({key:'', label:'Stage not set', meaning:'These rows carry a stage Aviance OS does not know.', rows: cbSortRows(odd)});
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
/* "with 6 days left" / "on its last day" / "and it ended 48 days ago".
   cbDays() throws the sign away, so a month that is over used to be announced as
   having that many days LEFT — seen live: a month that ended on 9 October read
   "5 calls short with 48 days left" on 27 November. The one sentence on the
   screen that is meant to make somebody act must not say the opposite of the
   truth. The days cell beside it has always said "ended 48 days ago". */
function cbWhenWords(n){
  const d = n == null ? NaN : Number(n);
  if (!Number.isFinite(d)) return 'and the month is still running';
  if (d < 0)  return 'and it ended ' + cbDays(-d) + ' ago';
  if (d === 0) return 'on its last day';
  return 'with ' + cbDays(d) + ' left';
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
    '<span class="cb-row-plan">' + (r.plan ? cbPill(cbPlanLine(r.plan, r.term, true), 'grey') : '<span class="cb-dim">No plan</span>') + '</span>' +
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
  // a client who only has to sign or pay (not late yet) needs nobody: they are not counted here
  const needs = rows.filter(r => (r.flags || []).some(f => !(f.code === 'waiting' && !f.urgent))).length;
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

/* What "Why" might say, for the move forward from each stage. */
const CB_MOVE_HINTS = {
  enquiry:'Booked a discovery call', booked:'Said yes on the call', won:'Agreement signed and first invoice paid',
  onboarding:'Inputs signed off on the kickoff call', live:'Two months short, they want to talk', at_risk:'They asked to stop',
  ended:'They came back',
};
/* Why a move forward cannot happen yet, from what the page already knows. '' when it can. */
function cbMoveBlock(r, toKey){
  if (toKey !== 'live') return '';
  const p = r && r.profile;
  if (p && p.signed_off_at) return '';
  return p ? 'Live needs their ICP and inputs signed off first.' : 'Live needs their ICP and inputs first — they have given us none yet.';
}
/* The stage mover on a client's page: one step forward, one step back, and a note. */
function cbRenderMover(r){
  const fwd = cbStageAfter(r.stage), back = cbStageBefore(r.stage);
  const blocked = fwd ? cbMoveBlock(r, fwd) : '';
  const btn = (key, kind) => key
    ? '<button class="btn' + (kind === 'back' ? ' ghost' : '') + '"' +
      (kind !== 'back' && blocked ? ' disabled aria-describedby="cbMoveWhyNot"' : ' onclick="cbDoMove(' + cbAttr(r.id) + ',' + cbAttr(key) + ')"') + '>' +
      cbE((kind === 'back' ? 'Back to ' : 'Move to ') + cbStageLabel(key)) + '</button>'
    : '';
  return '<section class="card cb-mover" id="cbMover">' +
    '<h3>Where are they?</h3>' +
    '<p class="cb-mover-now">' + cbStagePill(r.stage) + ' <span>' + cbE(cbStageMeaning(r.stage)) + '</span></p>' +
    '<label class="cb-lab" for="cbMoveNote">Why (kept in their history)</label>' +
    '<input id="cbMoveNote" class="cb-in" type="text" maxlength="600" placeholder="' + cbE(CB_MOVE_HINTS[r.stage] || 'What happened') + '">' +
    '<div class="cb-mover-btns">' + btn(fwd, 'fwd') + btn(back, 'back') + '</div>' +
    (blocked ? '<p class="cb-dim" id="cbMoveWhyNot">' + cbE(blocked) + '</p>' : '') +
    (!fwd && !back ? '<p class="cb-dim">' + cbE('There is nowhere to move them from here.') + '</p>' : '') +
    '<p class="cb-mover-rule">' + cbE('One stage at a time, forwards or back. Aviance OS will not let a stage be skipped.') + '</p>' +
    '<div class="cb-err" id="cbMoveErr" role="alert"></div>' +
  '</section>';
}

/* Where their agreement stands, in a few words. */
function cbAgreementWords(ag){
  if (!ag) return '';
  const st = cbTrim(ag.status);
  if (st === 'signed') return 'Signed' + (cbTrim(ag.signed_name) ? ' by ' + cbTrim(ag.signed_name) : '') + (ag.signed_at ? ' on ' + cbDate(ag.signed_at) : '');
  if (st === 'void') return 'Cancelled';
  return 'Sent' + (ag.created_at ? ' ' + cbDate(ag.created_at) : '') + ', not signed yet';
}
/* The facts: who they are, what they bought, who looks after them, and the way to
   their booking and their channel. `x` = {person, agreement, channel}. */
function cbRenderFacts(r, x){
  const c = r.client;
  const o = x || {};
  const per = o.person || {};
  const link = (label, onclick) => '<button type="button" class="cb-link" onclick="' + onclick + '">' + cbE(label) + '</button>';
  const pair = (label, value) => '<div><small>' + cbE(label) + '</small><b>' + (value || '<span class="cb-dim">—</span>') + '</b></div>';
  const site = cbTrim(c.website);
  const url = /^https?:\/\/\S+$/i.test(site) ? site : site ? 'https://' + site : '';
  return '<section class="card cb-facts">' +
    '<h3>The facts</h3>' +
    '<div class="cb-grid">' +
      pair('Who we talk to', cbE(r.person) + (r.email ? '<span class="cb-sub">' + cbE(r.email) + '</span>' : '')) +
      pair('Phone', cbTrim(per.phone) ? cbE(per.phone) : '') +
      pair('Their role', cbTrim(per.role) ? cbE(per.role) : '') +
      pair('Website', url ? '<a href="' + cbE(url) + '" target="_blank" rel="noopener noreferrer">' + cbE(site) + '</a>' : '') +
      pair('Plan', r.plan ? cbE(cbPlanLine(r.plan, r.term)) : '') +
      pair('Agreement', o.agreement ? cbE(cbAgreementWords(o.agreement)) : '') +
      pair('Their booking', c.booking_id ? link('Open the discovery call', 'cbOpenBooking(' + cbAttr(c.booking_id) + ')') : '') +
      pair('Their channel', o.channel && o.channel.id ? link('Open ' + (cbTrim(o.channel.name) || 'their channel'), 'cbOpenChannel(' + cbAttr(o.channel.id) + ')') : '') +
      pair('Promised a month', cbE(cbInt(c.calls_promised) + ' calls')) +
      pair('Fee a month', cbE(cbUsd(r.fee))) +
      pair('Looked after by', r.owner ? cbE(r.owner) : '') +
      pair('Inputs signed off', c.inputs_complete_on ? cbE(cbDate(c.inputs_complete_on)) : '') +
      pair('Day one', c.day1_on ? cbE(cbDate(c.day1_on)) : '') +
      (c.ended_on ? pair('Ended', cbE(cbDate(c.ended_on) + (c.end_reason ? ' · ' + c.end_reason : ''))) : '') +
    '</div>' +
    (cbTrim(c.notes) ? '<p class="cb-notes">' + cbE(c.notes) + '</p>' : '') +
    '<div class="cb-mover-btns cb-facts-acts">' +
      '<button class="btn" onclick="cbMessage(' + cbAttr(r.id) + ')">Message them</button>' +
      '<button class="btn ghost" onclick="cbOpenOnboarding(' + cbAttr(r.id) + ')">Onboarding checklist</button>' +
    '</div>' +
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
      /* The refund is in the sentence above when finance.js wrote it ("missed —
         3 of 5. $1,500 refunded."). Printing it again beside the dates said the
         same money twice in one line; the figure only appears here when
         finance.js is not loaded and the fallback sentence left it out. */
      (cbInt(m.refund_due) && typeof fnMonthLine !== 'function'
        ? '<b class="cb-stake">' + cbE(cbUsd(m.refund_due) + ' refunded') + '</b>' : '') +
      '</li>').join('') + '</ul>' +
  '</section>';
}
/* The same sentence finance.js writes, for when finance.js is not loaded. Word for word the
   same as fnMonthLine: a number the view left out reads as 0, never "undefined", and a missing
   day count says the month is still running rather than claiming it is the last day. */
function cbMonthLine(m){
  if (!m) return '';
  const no = cbInt(m.month_no), got = cbInt(m.calls_delivered), want = cbInt(m.calls_promised);
  if (m.verdict === 'hit')    return 'Month ' + no + ': hit — ' + got + ' of ' + want + ' calls.';
  if (m.verdict === 'missed') return 'Month ' + no + ': missed — ' + got + ' of ' + want + '.';
  if (m.verdict === 'waived') return 'Month ' + no + ': set aside.';
  const left = Number(m.days_left);
  return 'Month ' + no + ': ' + got + ' of ' + want + ' calls, ' +
    (!Number.isFinite(left) ? 'the month is still running'
      : left < 0 ? 'the month has ended' : left === 0 ? 'last day' : cbDays(left) + ' left') + '.';
}

/* The dated history: every line any module has written, newest first. */
function cbEventWords(ev){
  const d = ev && ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
  const area = cbTrim(ev && ev.area), name = cbTrim(ev && ev.event);
  if (area === 'stage' && name === 'moved') {
    return 'Moved ' + (d.from ? 'from ' + cbStageLabel(d.from) + ' ' : '') + 'to ' + cbStageLabel(d.to) +
      (cbTrim(d.note) ? ' — ' + cbTrim(d.note) : '');
  }
  if (area === 'client' && name === 'added') return fnPlanRetired(d.plan) || !cbPlanWord(d.plan) ? 'Added as a client.' : 'Added as a client on the ' + cbPlanWord(d.plan) + ' plan.';
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

/* Their invoices, compact: number, amount, where it stands, and a Paid button on
   the ones we are waiting for. Admin only — `meta.admin` decides, and without it
   the block is an empty slot. Pure. */
const CB_INVOICE_WORDS = {draft:['grey','Draft'], sent:['amber','Sent'], overdue:['red','Overdue'], paid:['green','Paid'], void:['grey','Void']};
function cbRenderInvoices(r, invoices, meta){
  const m = meta || {};
  const slot = '<section class="card cb-slot" id="cbInvoices" data-cb-client="' + cbE(r.id) + '">';
  if (!m.admin) return slot + '</section>';
  const rows = (invoices || []).filter(Boolean);
  if (m.error && !rows.length) return slot + '<h3>Invoices</h3><p class="cb-dim">' + cbE('Their invoices could not be read just now.') + '</p></section>';
  if (!rows.length) return slot + '<h3>Invoices</h3><p class="cb-dim">' + cbE('No invoice yet. The first one is made when a call is marked won.') + '</p></section>';
  return slot + '<h3>Invoices</h3>' +
    '<ul class="cb-monthlist cb-invoices">' + rows.map(i => {
      const st = cbTrim(i.status).toLowerCase();
      const w = CB_INVOICE_WORDS[st] || ['grey', st || 'Draft'];
      const owed = st === 'sent' || st === 'overdue';
      return '<li class="' + cbE(w[0]) + '">' + cbPill(w[1], w[0]) +
        '<span class="cb-month-say"><b>' + cbE(cbTrim(i.number) || 'Invoice') + '</b> · ' + cbE(cbUsd(i.amount)) + '</span>' +
        '<span class="cb-month-when">' + cbE(st === 'paid' ? 'paid ' + cbDate(i.paid_at) : 'due ' + cbDate(i.due_on)) + '</span>' +
        '<span class="cb-inv-acts">' +
        '<button class="btn ghost" onclick="cbViewInvoice(' + cbAttr(i.id) + ')">View</button>' +
        (owed ? '<button class="btn ghost" onclick="cbResend(' + cbAttr(r.id) + ')">Resend</button>' : '') +
        (owed ? '<button class="btn" onclick="cbAskPaid(' + cbAttr(r.id) + ',' + cbAttr(i.id) + ')">Paid</button>' : '') +
        '</span></li>';
    }).join('') + '</ul>' +
    (rows.some(i => ['sent','overdue'].indexOf(cbTrim(i.status).toLowerCase()) >= 0)
      ? '<p class="cb-dim">' + cbE('Click Paid when their money has arrived. The first time, that sends their welcome email and their way in.') + '</p>' : '') +
    (cbWelcomeAt(rows, m.events) ? '<p class="cb-dim">' + cbE('Welcome email sent ' + cbDate(cbWelcomeAt(rows, m.events)) + '.') + '</p>' : '') +
  '</section>';
}

/* When their welcome email went: the history says so (mark_paid writes it), or
   else the day their first invoice was paid. '' while it has not gone. */
function cbWelcomeAt(invoices, events){
  const ev = (events || []).find(e => e && cbTrim(e.area) === 'email' && cbTrim(e.event) === 'welcome_sent');
  if (ev && ev.at) return ev.at;
  const first = (invoices || []).find(i => i && i.is_first === true && cbTrim(i.status) === 'paid');
  return first ? (first.paid_at || '') : '';
}
/* What needs a person on this one client, said at the top of their page. */
function cbRenderFlags(r){
  if (!r.flags.length) return cbNote('Nothing here needs you today.', 'green');
  return '<section class="card cb-flags' + (r.urgent ? ' urgent' : '') + '">' +
    '<h3>' + cbE('What needs you') + '</h3>' +
    '<ul>' + r.flags.map(f => '<li class="' + cbE(f.urgent ? 'urgent' : '') + '">' + cbE(f.text) + '</li>').join('') + '</ul>' +
  '</section>';
}

/* One client's whole page, from data. Pure. `extra` = {admin, invoices, invoicesErr}. */
function cbRenderClient(r, months, events, extra){
  const x = extra || {};
  if (!r) return cbEmpty('That client is not here', 'The link may be old, or they may have been removed.', 'Back to clients', "render('clients')");
  return '<div class="cb-one">' +
    '<header class="cb-one-head">' +
      '<div><h2>' + cbE(r.company) + '</h2>' +
      '<p class="cb-one-sub">' + cbStagePill(r.stage) +
      (r.sat != null ? ' <span class="cb-dim">' + cbE('here ' + cbDays(r.sat) + (r.sat === 0 ? '' : ' now')) + '</span>' : '') + '</p></div>' +
      '<button class="btn ghost" onclick="render(\'clients\')">All clients</button>' +
    '</header>' +
    cbRenderFlags(r) +
    /* journey.js fills this with the payment-to-launch tracker (window.jyMountClient). */
    (['won', 'onboarding', 'live'].indexOf(r.stage) >= 0
      ? '<section class="card cb-slot cb-journey" id="cbJourney" data-cb-client="' + cbE(r.id) + '" data-cb-stage="' + cbE(r.stage) + '"></section>' : '') +
    cbRenderFacts(r, {person: x.person, agreement: x.agreement, channel: x.channel}) +
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
    /* invoices: listed here for an admin, with Paid on the ones we are waiting for.
       Refunds are still finance.js's own screen. */
    cbRenderInvoices(r, x.invoices, {admin: !!x.admin, error: x.invoicesErr, events: events}) +
    /* their people: who holds a portal login, and a way to free one.
       The seat rule itself is the database's (20261207_seats.sql); this only draws it. */
    cbRenderSeats(r.id, x.seats, {error: x.seatsErr}) +
    /* their own calendar: Google, Outlook or Calendly, connected in one click */
    cbRenderCalendar(r.id, x.cal, {error: x.calErr}) +
    // TODO: handover — what we send them when they leave (handovers).
    '<section class="card cb-slot" id="cbHandover" data-cb-client="' + cbE(r.id) + '"></section>' +

    cbRenderHistory(events) +
  '</div>';
}

/* The short list across every client of what is actually behind. */
function cbRenderNeeds(rows, meta){
  const m = meta || {};
  const mine = (rows || []).filter(r => r.needs);
  /* It would not load and there is nothing to show. This used to be a bare red
     bar with no way on: the only move left was reloading the app. */
  if (m.error && !mine.length) return cbErrNote(m.error) +
    cbEmpty('Nothing loaded', 'This could not be read just now, so nothing can be shown as behind. Nothing has been changed.', 'Try again', 'cbReload()');
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
  if (!force && !cb.listStale && cb.clients && Date.now() - cb.at < CB_RELOAD_MS) return cbOk(cb.clients);
  cb.listStale = false;
  cb.busy.all = (async () => {
    const [clients, standing, owners, requests, hist, profiles, agreements, firsts] = await Promise.all([
      cbClients(), cbStanding(), cbOwners(), cbOpenRequests(), cbStageHistory(null),
      cbRun(() => sb.from('client_profiles').select('client_id,signed_off_at,icp'), []),
      cbAgreements(null), cbFirstInvoices()
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
    /* newest agreement first, so the first one seen per client is the one that counts */
    cb.agreements = {};
    (agreements.ok ? agreements.data || [] : []).forEach(a => { if (a && a.client_id && !cb.agreements[a.client_id]) cb.agreements[a.client_id] = a; });
    cb.firstInv = {};
    (firsts.ok ? firsts.data || [] : []).forEach(i => { if (i && i.client_id && !cb.firstInv[i.client_id]) cb.firstInv[i.client_id] = i; });
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
    const [client, profile, months, events, hist, reqs, owners, invs, ags, person, channel, seats, cal] = await Promise.all([
      cbClient(clientId), cbProfile(clientId), cbStanding({clientId}), cbEvents(clientId),
      cbStageHistory(clientId), cbOpenRequests(clientId),
      Object.keys(cb.owners || {}).length ? Promise.resolve(cbOk(cb.owners)) : cbOwners(),
      cbInvoices(clientId), cbAgreements(clientId), cbPerson(clientId), cbChannel(clientId),
      cbSeats(clientId), cbCalendars(clientId)
    ]);
    /* Seats and the calendar are drawn from their own slots in cb, so a part
       that is not switched on yet says so where it belongs instead of taking
       the whole page down with it. */
    cb.seats[clientId]   = seats.ok ? seats.data : null;
    cb.seatsErr[clientId] = seats.ok ? '' : seats.error;
    cb.cal[clientId]     = cal.ok ? (cal.data || []) : [];
    cb.calErr[clientId]  = cal.ok ? '' : cal.error;
    const firstRow = (res) => res && res.ok && Array.isArray(res.data) && res.data.length ? res.data[0] : null;
    if (!client.ok) { cb.oneErr[clientId] = client.error; return client; }
    cb.one[clientId] = {
      at: Date.now(),
      client: client.data, profile: profile.ok ? profile.data : null,
      months: months.ok ? months.data || [] : [], events: events.ok ? events.data || [] : [],
      history: hist.ok ? hist.data || [] : [], requests: reqs.ok ? reqs.data || [] : [],
      owners: owners.ok ? owners.data || {} : {},
      invoices: invs.ok ? invs.data || [] : [], invoicesErr: invs.ok ? '' : invs.error,
      agreement: firstRow(ags), person: firstRow(person), channel: firstRow(channel),
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
  /* `painting` tells the views this draw is ours, off rows that have just been
     read — so they must not start another read, or the screen would read itself
     for ever. */
  cb.painting = true;
  try { render(currentView); } catch (e) {} finally { cb.painting = false; }
}
function cbLoading(what){
  return '<div class="cb-loading" role="status">' + cbE('Loading ' + (what || 'the clients') + '…') + '</div>';
}

/* Every screen here asks for its rows and draws again when they land. The load
   functions are built not to throw — but if one ever does, the promise rejects,
   nothing redraws, and the screen sits on "Loading…" for the rest of the day
   with nobody told. So no load is ever started without a failure path: the
   screen is marked as asked (so it stops saying "Loading"), the reason is put
   where the screen already shows one, and it is drawn again. The person then
   sees a sentence and a Try again button instead of a spinner.
   `what` is what was being read, in the words the screen uses. */
function cbThen(p, what, clientId){
  if (!p || typeof p.then !== 'function') return p;
  return p.then(cbPaint, (e) => {
    const why = 'Aviance could not read ' + (what || 'this') + ' just now. Try again in a moment.';
    if (clientId) cb.oneErr[clientId] = why; else cb.err = why;
    cb.tried = true; cb.at = Date.now();
    cbPaint();
  });
}
function cbReload(){ cb.tried = false; cbThen(cbLoadAll(true), 'the clients') }
/* Try their page again: forget the last failure first, or the screen would draw
   the failure straight back instead of asking. */
function cbRetryClient(clientId){
  const id = cbTrim(clientId);
  if (!id) return;
  delete cb.oneErr[id]; delete cb.one[id];
  const p = cbThen(cbLoadOne(id, true), 'their page', id);
  cbPaint();
  return p;
}

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
                        requests:cb.requests, profiles:cb.profiles,
                        agreements:cb.agreements, firstInvoices:cb.firstInv}, extra || {});
}

/* ---- the main screen ---- */
function viewClients(){
  if (!cb.clients) {
    if (!cb.tried) { cbThen(cbLoadAll(), 'the clients'); return cbLoading('the clients'); }
    return cbRenderClients([], {error: cb.err});   /* it was asked for and it would not come */
  }
  /* What is held is drawn at once, and read again behind it when it is old or
     another screen has said it changed. Before this the list was read ONCE per
     session: CB_RELOAD_MS was only ever consulted on a path this function did
     not take once it had rows. */
  if (!cb.painting && !cb.busy.all && (cb.listStale || Date.now() - cb.at >= CB_RELOAD_MS)) cbRefreshAll();
  return cbRenderClients(cbRows(cb.clients, cbBag()), {error: cb.err});
}
/* Read again, and draw again only if what came back is different — a redraw
   moves the page to the top and empties a box somebody is typing in. */
function cbListSig(){
  try { return JSON.stringify([cb.clients, cb.standing, cb.requests, cb.firstInv, cb.agreements, cb.err]); } catch (e) { return String(Date.now()); }
}
function cbOneSig(id){
  try {
    const o = Object.assign({}, cb.one[id] || {}); delete o.at; delete o.stale;
    return JSON.stringify([o, cb.seats[id], cb.seatsErr[id], cb.cal[id], cb.calErr[id]]);
  } catch (e) { return String(Date.now()); }
}
function cbRefreshAll(){
  const before = cbListSig();
  return cbLoadAll(true).then(() => { if (cbListSig() !== before) cbPaint(); }, () => {});
}
function cbRefreshOne(id){
  const before = cbOneSig(id);
  return cbLoadOne(id, true).then(() => {
    if (cb.one[id]) cb.one[id].stale = false;
    if (cbOneSig(id) !== before) cbPaint();
  }, () => {});
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
  /* Their page would not load. cb.oneErr was already being filled in and never
     read, so this screen used to answer "Loading their page…" for ever AND ask
     the database again on every redraw — a spinner that never stops and a query
     loop behind it. Now it says what happened and offers the way back. */
  if (!got && cb.oneErr[id]) {
    return cbErrNote(cb.oneErr[id]) +
      cbEmpty('Their page did not load', 'Nothing has been changed. Try again, or go back to the list.',
              'Try again', 'cbRetryClient(' + cbAttr(id) + ')');
  }
  if (!got) { cbThen(cbLoadOne(id), 'their page', id); return cbLoading('their page'); }
  /* Their page is kept, and it used to be kept for good: opened once, it showed
     the same months, invoices and logins until the browser was reloaded, whatever
     had happened on the Calendar, Month end or Money since. It is still drawn at
     once from what is held — and read again behind that when another screen has
     marked it (cbStale) or it is older than the list is allowed to be. */
  if (!cb.painting && !cb.busy['one:' + id] && (got.stale || Date.now() - (got.at || 0) >= CB_RELOAD_MS)) cbRefreshOne(id);
  const r = cbRow(got.client, {
    standing: got.months, owners: got.owners, requests: got.requests,
    profiles: got.profile ? {[id]: got.profile} : {},
    history: got.history && got.history.length ? {[id]: got.history[0]} : {},
    agreements: got.agreement ? {[id]: got.agreement} : {},
    firstInvoices: cbFirstOf(got.invoices) ? {[id]: cbFirstOf(got.invoices)} : {}
  });
  cbMountJourney(id);
  const said = cb.endSaid && cb.endSaid.id === id ? cbNote(cb.endSaid.words, 'amber') : '';
  return said + (got.err ? cbErrNote(got.err) : '') + cbRenderClient(got.client ? r : null, got.months, got.events,
    {admin: cbIsAdmin(), invoices: got.invoices, invoicesErr: got.invoicesErr,
     agreement: got.agreement, person: got.person, channel: got.channel,
     seats: cb.seats[id], seatsErr: cb.seatsErr[id],
     cal: cb.cal[id], calErr: cb.calErr[id]});
}

/* Once the page is on screen, journey.js draws its tracker into #cbJourney. */
function cbMountJourney(clientId){
  if (typeof window === 'undefined' || typeof window.jyMountClient !== 'function' || typeof setTimeout !== 'function') return;
  setTimeout(() => {
    const el = typeof document !== 'undefined' && document.getElementById ? document.getElementById('cbJourney') : null;
    if (el && el.getAttribute('data-cb-client') === String(clientId)) window.jyMountClient(clientId, el);
  }, 0);
}

/* Their first invoice, out of all of them: the one marked first, else the oldest. */
function cbFirstOf(invoices){
  const rows = (invoices || []).filter(Boolean);
  return rows.find(i => i.is_first === true) || null;
}

/* ---- what needs a person today ---- */
function viewNeedsYou(){
  if (!cb.clients) {
    if (!cb.tried) { cbThen(cbLoadAll(), 'what needs you'); return cbLoading('what needs you'); }
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

/* How the money came. The choice is kept on the invoice as `paid_via`. */
const CB_PAID_VIA = ['Wise', 'Payoneer', 'Bank transfer', 'Other'];
/* Paid asks first: how it came, an optional reference, then one button that says
   exactly what it will do ("Mark $3,000 paid and send their welcome email"). */
function cbRenderPaidAsk(clientId, inv, welcomeGone){
  const i = inv || {};
  const welcome = i.is_first === true && !welcomeGone;
  return '<div class="cb-add"><h3>' + cbE('Invoice ' + (cbTrim(i.number) || '') + ' paid?') + '</h3>' +
    '<label class="cb-lab" for="cbPaidVia">How did it come</label><select id="cbPaidVia" class="cb-in">' +
      CB_PAID_VIA.map(v => '<option value="' + cbE(v) + '">' + cbE(v) + '</option>').join('') + '</select>' +
    '<label class="cb-lab" for="cbPaidRef">Reference (if there is one)</label><input id="cbPaidRef" class="cb-in" type="text" maxlength="40" placeholder="The transfer reference">' +
    '<div class="cb-err" id="cbPaidErr" role="alert"></div>' +
    '<div class="cb-mover-btns"><button class="btn" onclick="cbConfirmPaid(' + cbAttr(clientId) + ',' + cbAttr(i.id) + ')">' +
      cbE('Mark ' + cbUsd(i.amount) + ' paid' + (welcome ? ' and send their welcome email' : '')) + '</button>' +
    '<button class="btn ghost" onclick="closeModal()">Back</button></div></div>';
}
function cbAskPaid(clientId, invoiceId){
  const got = cb.one[clientId];
  const inv = got && (got.invoices || []).find(i => i && String(i.id) === String(invoiceId));
  if (!inv) return cbMarkPaid(clientId, invoiceId);
  const html = cbRenderPaidAsk(clientId, inv, !!cbWelcomeAt(got.invoices, got.events));
  if (typeof openModal === 'function') openModal(html);
  return html;
}
/* "Wise · REF123" — what goes to mark_paid as p_via. */
function cbPaidVia(method, ref){
  const m = cbTrim(method), r = cbTrim(ref);
  return (m && r ? m + ' · ' + r : m || r).slice(0, 60);
}
async function cbConfirmPaid(clientId, invoiceId){
  const via = cbPaidVia(cbField('cbPaidVia'), cbField('cbPaidRef'));
  const r = await cbMarkPaid(clientId, invoiceId, via);
  if (r.ok && typeof closeModal === 'function') closeModal();
  else if (!r.ok) cbShowErr('cbPaidErr', r.error);
  return r;
}
/* View: the invoice as the client sees it, in a new tab. The tab is opened before
   the link is asked for, so the browser does not block it. */
async function cbViewInvoice(invoiceId){
  let w = null;
  try { w = typeof window !== 'undefined' && typeof window.open === 'function' ? window.open('', '_blank') : null; } catch (e) { w = null; }
  const r = await cbInvoiceLink(invoiceId);
  if (!r.ok || !cbTrim(r.data)) {
    try { if (w) w.close(); } catch (e) {}
    cbSay(r.ok ? 'There is no link for that invoice.' : r.error);
    return r.ok ? cbErr('There is no link for that invoice.') : r;
  }
  try { if (w) { w.opener = null; w.location.href = r.data; } else cbSay('Open it here: ' + r.data); } catch (e) {}
  return r;
}
/* Resend: the agreement and the invoice again, to the same person, with fresh links. */
async function cbResend(clientId){
  const key = 'resend:' + clientId;
  if (cb.busy[key]) return cbErr('Still working on it.');
  cb.busy[key] = true;
  let r;
  try { r = await cbResendPack(clientId); } finally { delete cb.busy[key]; }
  cbSay(r.ok ? 'Sent again to ' + (cbTrim(r.data && r.data.email) || 'them') + '.' : r.error);
  if (r.ok) { delete cb.one[clientId]; await cbLoadOne(clientId, true); cbPaint(); }
  return r;
}
/* Their discovery call: the Calendar, on that call, with its panel open. */
function cbOpenBooking(bookingId){
  if (!bookingId) return false;
  if (typeof openEnquiry === 'function') { openEnquiry(bookingId); return true; }
  return false;
}
/* Channels, with this channel already open. */
function cbOpenChannel(channelId){
  try { if (typeof chv !== 'undefined' && chv) chv.want = channelId || null; } catch (e) {}
  if (typeof render === 'function') { render('channels'); return true; }
  return false;
}
/* Message them: their channel if we know it, else Channels as it is. */
function cbMessage(clientId){
  const got = cb.one[clientId];
  const ch = got && got.channel;
  return cbOpenChannel(ch && ch.id ? ch.id : null);
}
function cbOpenOnboarding(clientId){
  if (typeof openClientOnboarding === 'function') { openClientOnboarding(clientId); return true; }
  if (typeof render === 'function') { render('onboarding'); return true; }
  return false;
}
/* Paid, from the invoice on their page. The database rule does the rest: the
   first payment sends their welcome email and their way in. One at a time. */
async function cbMarkPaid(clientId, invoiceId, via){
  const key = 'paid:' + invoiceId;
  if (cb.busy[key]) return cbErr('Still working on it.');
  cb.busy[key] = true;
  let r;
  try {
    r = typeof fnMarkInvoicePaid === 'function' ? await fnMarkInvoicePaid(invoiceId, via) : cbErr('The finance side is not loaded.');
  } finally { delete cb.busy[key]; }
  if (!r.ok) { cbSay(r.error); return r; }
  cbSay(typeof fnPaidWords === 'function' ? fnPaidWords(r.data) : 'Marked paid.');
  delete cb.one[clientId];
  cb.clients = null; cb.tried = false;
  await cbLoadOne(clientId, true);
  cbPaint();
  return r;
}

/* What an ending did, in one sentence the owner can check against Money and
   Month end. Pure. Every figure is one wuEndClient handed back. */
function cbEndingWords(e){
  if (!e) return '';
  const left = Array.isArray(e.monthsLeftOpen) ? e.monthsLeftOpen : [];
  const owed = cbInt(e.refundOutstanding);
  const out = ['Ended.'];
  out.push(cbInt(e.monthsLocked) === 1 ? '1 finished month is locked.' : cbInt(e.monthsLocked) + ' finished months are locked.');
  out.push(owed > 0 ? cbUsd(owed) + ' in refunds is owed to them — it is on Money.' : 'No refund is owed.');
  if (left.length) out.push((left.length === 1 ? 'Month ' + left[0].monthNo + ' had' : 'Months ' + cbList(left.map(m => String(m.monthNo))) + ' had') +
    ' not finished and ' + (left.length === 1 ? 'was' : 'were') + ' left open: whether a month they cut short is owed back is yours to decide.');
  if (e.providerStillRunning) out.push('Pause their campaigns in the sending tool too — Aviance OS cannot reach it.');
  return out.join(' ');
}

/* Move them, from the mover on their page. One press at a time: two clicks
   wrote the move, and its line in their history, twice. */
async function cbDoMove(clientId, toStage){
  const key = 'move:' + clientId;
  if (cb.busy[key]) return cbErr('Still working on it.');
  cb.busy[key] = true;
  try { return await cbDoMoveOnce(clientId, toStage); }
  finally { delete cb.busy[key]; }
}
async function cbDoMoveOnce(clientId, toStage){
  cbShowErr('cbMoveErr', '');
  const r = await cbMoveStage(clientId, toStage, cbField('cbMoveNote'));
  if (!r.ok) { cbShowErr('cbMoveErr', r.error); return r; }
  if (r.data && r.data.ending) {
    /* long, and it is about money: say it, and keep it on their page too */
    const words = cbEndingWords(r.data.ending) + (r.data.warning ? ' ' + r.data.warning : '');
    cb.endSaid = {id: String(clientId), words};
    cbSay(words);
  }
  else if (r.data && r.data.warning) cbSay(r.data.warning);
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
  const list = plans.ok ? plans.data : [];
  const opts = list.map(p => '<option value="' + cbE(p.plan) + '">' +
    cbE((cbTrim(p.label) || cbTrim(p.plan)) + ' — ' + cbInt(p.calls_promised) + ' calls a month, ' + cbUsd(p.monthly_fee) + ' a month') + '</option>').join('');
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

/* ===================== 10. PORTAL SEATS AND THEIR CALENDAR ===================== */
/* Seats: a seat is one person of this client who can sign in to the portal.
   Starter 2, Growth 4, Scale unlimited — and those numbers are NOT written
   here. They live in plan_prices.portal_seats and come back from
   portal_seat_state(); this file only draws what it is told, so changing a plan
   changes the screen. The limit itself is enforced in the database, twice (when
   an invite is issued and again when it is accepted), behind a lock, so nothing
   on this screen can be the thing that lets a third person in.

   Calendar: the client's own Google, Outlook or Calendly, so booked calls land
   on their calendar and we can see their free time. The handshake happens in
   the `calendar-connect` edge function, which is the only thing that ever sees
   an OAuth credential; this screen asks it for a URL and sends the browser
   there. 20261207_calendar_connect.sql names the secrets it reads.

   Both panels say "not switched on yet", in plain English, when their migration
   has not been applied. Nothing here throws. */

const CB_SEATS_NOT_READY = 'Portal logins are not switched on yet. Once the database update is applied, who can sign in will show here.';
const CB_CAL_NOT_READY = 'Calendar connecting is not switched on yet. Once the database update and the calendar-connect function are live, they can connect theirs here.';
const CB_CAL_PROVIDERS = [
  ['google',    'Google Calendar',  'One click, and we read their free time and put booked calls on it.'],
  ['microsoft', 'Outlook',          'The same, through their Microsoft work or personal account.'],
  ['calendly',  'Calendly',         'They paste a personal access token from Calendly; we read their busy times from it.'],
];
/* The edge function that holds the OAuth side. Same origin as the database. */
function cbFnBase(){
  try {
    const u = (typeof sb !== 'undefined' && sb && (sb.supabaseUrl || (sb.rest && sb.rest.url))) || '';
    const s = cbTrim(u).replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
    return s ? s + '/functions/v1' : '';
  } catch (e) { return '' }
}
/* A database rule that is not there yet reads as "not switched on", never as a
   crash and never as a Postgres code. */
function cbMissing(error){
  const m = cbTrim(error);
  /* coreFamily decides the kind, once, for every screen: by the time this asks,
     the database's own wording has already become plain words, so looking for
     "schema cache" here would no longer find it. */
  return coreFamily(m) === 'not-ready' || m.toLowerCase().indexOf('not find the table') >= 0;
}

/* ---- reads ---- */

/* Who holds a seat, how many are left, and the sentence to show when none are. */
async function cbSeats(clientId){
  if (!clientId) return cbErr('Which client is this about?');
  const r = await cbRun(() => sb.rpc('portal_seat_state', {p_client: clientId}), null);
  if (!r.ok && cbMissing(r.error)) return cbErr(CB_SEATS_NOT_READY);
  return r;
}
/* Take a person's login away. The database revokes any pending invite to the
   same inbox at the same time, so the seat does not hand itself straight back. */
async function cbSeatFree(personId, reason){
  if (!personId) return cbErr('Which person is this about?');
  const r = await cbRun(() => sb.rpc('portal_seat_free', {p_person: personId, p_reason: cbTrim(reason) || null}), null);
  if (!r.ok && cbMissing(r.error)) return cbErr(CB_SEATS_NOT_READY);
  return r;
}
async function cbCalendars(clientId){
  if (!clientId) return cbErr('Which client is this about?');
  const r = await cbRun(() => sb.rpc('calendar_connections_for', {p_client: clientId}), []);
  if (!r.ok && cbMissing(r.error)) return cbErr(CB_CAL_NOT_READY);
  return r;
}
async function cbCalDisconnect(connectionId){
  if (!connectionId) return cbErr('Which calendar is this about?');
  const r = await cbRun(() => sb.rpc('calendar_disconnect', {p_connection: connectionId}), null);
  if (!r.ok && cbMissing(r.error)) return cbErr(CB_CAL_NOT_READY);
  return r;
}
/* Ask the edge function where to send them. It mints the state, reads the
   OAuth client id from a Supabase secret and hands back one URL. We never see a
   credential, and there is none in this repo to see. */
async function cbCalStartUrl(clientId, provider){
  const base = cbFnBase();
  if (!base) return cbErr(CB_CAL_NOT_READY);
  if (CB_CAL_PROVIDERS.findIndex(p => p[0] === cbTrim(provider)) < 0) return cbErr('Pick Google, Outlook or Calendly.');
  try {
    const ses = await sb.auth.getSession();
    const tok = ses && ses.data && ses.data.session ? ses.data.session.access_token : '';
    if (!tok) return cbErr('Sign in again and then connect their calendar.');
    const res = await fetch(base + '/calendar-connect/start', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + tok},
      body: JSON.stringify({client_id: clientId, provider: provider,
                            return_to: typeof location !== 'undefined' ? String(location.href) : ''})
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body || body.ok !== true || !body.url) {
      return cbErr((body && body.error) || CB_CAL_NOT_READY);
    }
    return cbOk(body);
  } catch (e) { return cbErr(CB_CAL_NOT_READY) }
}

/* ---- the seat screen (pure) ---- */

/* "2 of 2 used" / "unlimited". The one place the wording lives. */
function cbSeatLine(s){
  if (!s) return '';
  if (s.unlimited) return 'Unlimited logins on ' + (cbTrim(s.plan_label) || cbPlanWord(s.plan)) + '.';
  const held = cbInt(s.held), pend = cbInt(s.pending), seats = cbInt(s.seats);
  return (cbTrim(s.plan_label) || cbPlanWord(s.plan)) + ' comes with ' + seats +
    (seats === 1 ? ' login' : ' logins') + '. ' + held + ' in use' +
    (pend ? ', ' + pend + ' invited and not opened yet' : '') + '.';
}
/* One row of a list of people or calendars: the name on the left, what to do
   about it on the right, and never the two on top of each other. clientbook.css
   belongs to the clients list, so the few rules these rows need are inline. */
const CB_EYEBROW = 'font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted,#63636A);margin:0';
const CB_ROW = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 0;border-top:1px solid var(--line,#DCDCE0)';
const CB_ROW_MAIN = 'flex:1 1 300px;min-width:0';
const CB_META = 'display:block;font-family:var(--mono);font-size:12px;line-height:1.5;color:var(--muted,#63636A);margin-top:5px;word-break:break-word';
/* "sam@stone.test · Owner · signed in since 2 Oct" — nothing empty, nothing run together. */
function cbMeta(parts){
  const a = (parts || []).map(cbTrim).filter(Boolean);
  return a.length ? '<span style="' + CB_META + '">' + cbE(a.join(' · ')) + '</span>' : '';
}
/* The figure block from the design system: a mono caption above one big mono
   number. The number is the whole answer to "how many logins are in use". */
function cbSeatFig(s){
  if (!s) return '';
  /* A pending invite HOLDS a login: portal_invite_create counts it, which is why
     the fifth invite on Growth is refused while four invitations sit unopened.
     The figure showed `held` on its own, so a client with four unopened invites
     read "0 / 4" directly above a note saying every login was taken. */
  const taken = cbInt(s.held) + cbInt(s.pending);
  const txt = s.unlimited ? taken + ' / ∞' : taken + ' / ' + cbInt(s.seats);
  return '<div style="margin:14px 0 10px">' +
    '<p style="' + CB_EYEBROW + '">' + cbE(cbInt(s.pending) ? 'Portal logins taken' : 'Portal logins in use') + '</p>' +
    '<p style="font-family:var(--mono);font-size:34px;font-weight:700;letter-spacing:-.03em;line-height:1;margin:6px 0 0">' +
      cbE(txt) + '</p></div>';
}
/* Why every login is taken, in words that match the rest of the screen.
   The database's own sentence (`full_message`) is written for the moment an
   invite is refused and tells the owner to free a login under "Who can sign in".
   When nobody has signed in at all there is nobody to free: seen live on a
   Growth client with four unopened invites, the page said "0 / 4", "Nobody from
   them can sign in yet" AND "free one" — three statements contradicting each
   other. With somebody signed in, the database's sentence is right and is used
   exactly as it was written. */
function cbSeatWhyFull(s){
  const held = cbInt(s && s.held), pend = cbInt(s && s.pending), seats = cbInt(s && s.seats);
  const said = cbTrim(s && s.full_message) ||
    'Every login on their plan is in use. Free one here, or move them to a bigger plan, before inviting anyone else.';
  if (held > 0 || pend < 1) return said;
  return 'All ' + seats + (seats === 1 ? ' login' : ' logins') + ' on their plan are held by ' +
    (pend === 1 ? 'an invitation' : 'invitations') + ' nobody has opened yet. ' +
    (pend === 1 ? 'It is' : 'They are') + ' listed below and ' +
    (pend === 1 ? 'frees' : 'each frees') + ' itself on its expiry date. ' +
    'To invite somebody else sooner, move them to a bigger plan.';
}

/* Who can sign in, and a way to free one. Pure: data in, HTML out. */
function cbRenderSeats(clientId, s, meta){
  const m = meta || {};
  const head = '<h3>' + cbE('Who can sign in') + '</h3>';
  if (!s) {
    return '<section class="card cb-slot" id="cbPeople" data-cb-client="' + cbE(clientId) + '">' + head +
      (m.error ? cbErrNote(m.error) : '<p class="cb-dim">' + cbE('Loading their logins…') + '</p>') + '</section>';
  }
  const holders = Array.isArray(s.holders) ? s.holders : [];
  const invites = Array.isArray(s.invites) ? s.invites : [];
  const waiting = Array.isArray(s.waiting) ? s.waiting : [];
  const rows = holders.map(h =>
    '<li style="' + CB_ROW + '">' +
      '<span style="' + CB_ROW_MAIN + '">' +
        '<b>' + cbE(cbTrim(h.name) || cbTrim(h.email) || 'Someone') + '</b>' +
        (h.is_primary ? ' ' + cbPill('Main contact', 'blue') : '') +
        cbMeta([h.email, h.role, h.since ? 'signed in since ' + cbDate(h.since) : '']) +
      '</span>' +
      '<button class="btn ghost" onclick="cbAskFreeSeat(' + cbAttr(clientId) + ',' + cbAttr(h.person_id) + ')">' +
        cbE('Free this login') + '</button>' +
    '</li>').join('');

  const pend = invites.map(v =>
    '<li style="' + CB_ROW + '">' +
      '<span style="' + CB_ROW_MAIN + '">' +
        '<b>' + cbE(cbTrim(v.email)) + '</b> ' + cbPill('Invited', 'amber') +
        cbMeta(['holds a login until ' + cbDate(v.expires_at) + ', or until they open it']) +
      '</span>' +
    '</li>').join('');

  return '<section class="card cb-slot" id="cbPeople" data-cb-client="' + cbE(clientId) + '">' + head +
    (m.error ? cbErrNote(m.error) : '') +
    cbSeatFig(s) +
    '<p class="cb-dim">' + cbE(cbSeatLine(s)) + '</p>' +
    (s.at_limit ? cbNote(cbSeatWhyFull(s), 'amber') : '') +
    /* The only place in the browser that can make a portal invite is the
       'Their people' screen (portal.js viewClientPeople -> portal_invite_create).
       Nothing linked to it, so a Growth client's logins 2, 3 and 4 needed the SQL
       editor. This is where the owner is already looking when he wonders who can
       sign in. */
    '<p style="margin:12px 0 0"><button class="btn' + (s.at_limit ? ' ghost' : '') +
      '" onclick="openClientPeople(' + cbAttr(clientId) + ')">' +
      cbE(s.at_limit ? 'Manage their logins' : 'Give someone a login') + '</button></p>' +
    (holders.length ? '<ul style="list-style:none;margin:10px 0 0;padding:0">' + rows + '</ul>'
      : '<p class="cb-dim">' + cbE('Nobody from ' + (cbTrim(s.company) || 'this client') + ' can sign in yet. The welcome email sends the first login when their first invoice is marked paid.') + '</p>') +
    (pend ? '<p style="' + CB_EYEBROW + ';margin-top:22px">' + cbE('Invited, not opened yet') + '</p>' +
            '<ul style="list-style:none;margin:0;padding:0">' + pend + '</ul>' : '') +
    (waiting.length ? '<p class="cb-dim" style="margin-top:14px">' + cbE(
        cbList(waiting.map(w => cbTrim(w.name) || cbTrim(w.email))) +
        (waiting.length === 1 ? ' is on their people list without a login.' : ' are on their people list without a login.')) + '</p>' : '') +
  '</section>';
}

/* ---- their calendar (pure) ---- */

const CB_CAL_WORDS = {google:'Google Calendar', microsoft:'Outlook', calendly:'Calendly'};
function cbCalWord(p){ return CB_CAL_WORDS[cbTrim(p)] || (cbTrim(p) || 'A calendar') }
function cbCalStatusWords(c){
  const st = cbTrim(c && c.status);
  if (st === 'connected') return ['Connected', 'green'];
  if (st === 'needs_reconnect') return ['Needs reconnecting', 'amber'];
  if (st === 'error') return ['Something went wrong', 'red'];
  return [st || 'Not connected', 'grey'];
}
function cbRenderCalendar(clientId, list, meta){
  const m = meta || {};
  const head = '<h3>' + cbE('Their calendar') + '</h3>';
  const rows = (Array.isArray(list) ? list : []).filter(Boolean);
  const byProvider = {};
  rows.forEach(c => { byProvider[cbTrim(c.provider)] = c });

  /* One red thing per screenful (DESIGN.md): the first calendar they have not
     connected is the red button, the rest are quiet. Two red buttons side by
     side would mean neither reads as the thing to do. */
  let redUsed = false;
  const cards = CB_CAL_PROVIDERS.map(([key, label, why]) => {
    const got = byProvider[key];
    if (got) {
      const [word, tone] = cbCalStatusWords(got);
      return '<li style="' + CB_ROW + '">' +
        '<span style="' + CB_ROW_MAIN + '">' +
          '<b>' + cbE(label) + '</b> ' + cbPill(word, tone) +
          cbMeta([got.account_email, got.last_synced_at
            ? 'free time last read ' + cbDate(got.last_synced_at)
            : 'free time not read yet']) +
          (cbTrim(got.last_error) ? cbErrNote(got.last_error) : '') +
        '</span>' +
        '<button class="btn ghost" onclick="cbAskDisconnectCal(' + cbAttr(clientId) + ',' + cbAttr(got.id) + ',' + cbAttr(key) + ')">' +
          cbE('Disconnect') + '</button>' +
      '</li>';
    }
    const red = !redUsed;
    redUsed = true;
    return '<li style="' + CB_ROW + '">' +
      '<span style="' + CB_ROW_MAIN + '">' +
        '<b>' + cbE(label) + '</b>' +
        '<span style="display:block;font-size:14px;line-height:1.5;color:var(--muted,#63636A);margin-top:5px">' + cbE(why) + '</span>' +
      '</span>' +
      '<button class="btn' + (red ? '' : ' ghost') + '" onclick="cbConnectCal(' + cbAttr(clientId) + ',' + cbAttr(key) + ')">' +
        cbE('Connect ' + label) + '</button>' +
    '</li>';
  }).join('');

  return '<section class="card cb-slot" id="cbCalendar" data-cb-client="' + cbE(clientId) + '">' + head +
    (m.error ? cbErrNote(m.error) : '') +
    '<p class="cb-dim">' + cbE('Connect their calendar once and booked calls land on it, and we stop offering times they cannot do.') + '</p>' +
    (m.error ? '' : '<ul style="list-style:none;margin:10px 0 0;padding:0">' + cards + '</ul>') +
  '</section>';
}

/* ---- what the buttons do ---- */

function cbAskFreeSeat(clientId, personId){
  const s = cb.seats[clientId];
  const who = s && (s.holders || []).find(h => h && String(h.person_id) === String(personId));
  const name = cbTrim(who && who.name) || cbTrim(who && who.email) || 'This person';
  const html = '<div class="cb-add"><h3>' + cbE('Free ' + cbPossessive(name) + ' login?') + '</h3>' +
    '<p class="cb-dim">' + cbE(name + ' will not be able to sign in to the portal any more. Their messages, their name and their place in the channel all stay, and the login can be given back by inviting them again.') + '</p>' +
    '<label class="cb-lab" for="cbSeatWhy">Why (only we see this)</label>' +
    '<input id="cbSeatWhy" class="cb-in" type="text" maxlength="200" placeholder="They have left the company">' +
    '<div class="cb-err" id="cbSeatErr" role="alert"></div>' +
    '<div class="cb-mover-btns"><button class="btn" onclick="cbFreeSeatGo(' + cbAttr(clientId) + ',' + cbAttr(personId) + ')">' +
      cbE('Free the login') + '</button>' +
    '<button class="btn ghost" onclick="closeModal()">Keep it</button></div></div>';
  if (typeof openModal === 'function') openModal(html);
  return html;
}
async function cbFreeSeatGo(clientId, personId){
  cbShowErr('cbSeatErr', '');
  const r = await cbSeatFree(personId, cbField('cbSeatWhy'));
  if (!r.ok) { cbShowErr('cbSeatErr', r.error); return r; }
  if (typeof closeModal === 'function') closeModal();
  cb.seats[clientId] = r.data || null;
  cb.seatsErr[clientId] = '';
  const s = r.data || {};
  cbSay(s.unlimited ? 'That login is freed'
    : 'That login is freed — ' + cbInt(s.free) + ' of ' + cbInt(s.seats) + ' free now');
  cbPaint();
  return r;
}
async function cbConnectCal(clientId, provider){
  const r = await cbCalStartUrl(clientId, provider);
  if (!r.ok) { cbSay(r.error); return r; }
  if (typeof window !== 'undefined' && window.location && r.data && r.data.url) window.location.href = r.data.url;
  return r;
}
function cbAskDisconnectCal(clientId, connectionId, provider){
  const html = '<div class="cb-add"><h3>' + cbE('Disconnect ' + cbCalWord(provider) + '?') + '</h3>' +
    '<p class="cb-dim">' + cbE('We will stop putting booked calls on it and stop reading their free time, so the hub may start offering times they cannot do. Their calendar itself is not changed, and calls already on it stay.') + '</p>' +
    '<div class="cb-err" id="cbCalErr" role="alert"></div>' +
    '<div class="cb-mover-btns"><button class="btn" onclick="cbDisconnectCalGo(' + cbAttr(clientId) + ',' + cbAttr(connectionId) + ')">' +
      cbE('Disconnect it') + '</button>' +
    '<button class="btn ghost" onclick="closeModal()">Leave it connected</button></div></div>';
  if (typeof openModal === 'function') openModal(html);
  return html;
}
async function cbDisconnectCalGo(clientId, connectionId){
  cbShowErr('cbCalErr', '');
  const r = await cbCalDisconnect(connectionId);
  if (!r.ok) { cbShowErr('cbCalErr', r.error); return r; }
  if (typeof closeModal === 'function') closeModal();
  const got = await cbCalendars(clientId);
  cb.cal[clientId] = got.ok ? (got.data || []) : [];
  cb.calErr[clientId] = got.ok ? '' : got.error;
  cbSay(cbTrim(r.data && r.data.said) || 'Disconnected');
  cbPaint();
  return r;
}
