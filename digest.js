/* ===================== AVIANCE OS — the dashboards and the Friday update =====================
   The screens that answer "how are we doing" without anyone doing arithmetic by hand.

     dgHome()               today, in numbers, and the things that need a person
     dgClientWeek(id)       one client's week: promised vs delivered, and plainly whether they are on track
     dgFridayUpdate(id)     the weekly note to a client, as text and simple HTML, from real rows only
     dgFridayAll()          that note for every live client, ready to review
     dgMonthClose()         months whose end date has passed and are not locked, and what locking costs
     viewHome() viewFriday() viewMonthEnd()   the three screens

   Rules this file keeps:
     - Every number comes from a query. Nothing is read from a stored counter.
     - The money rules live in finance.js and the database. This file reads verdicts,
       refunds and multipliers; it never works out a refund of its own.
     - Nothing here flatters the numbers. A short month says it is short, and says
       what that costs.
     - Other areas of the hub are being built beside this one. Every call into another
       module is optional: if it is not there, the number degrades to a dash and the
       screen still draws.
     - Every function returns {ok, data, error} and never throws (same plumbing as finance.js).
   ============================================================================================= */

const DG_WEEK_START = 1;              /* weeks run Monday to Sunday */
const DG_DASH = '—';
const DG_SOON_DAYS = 7;               /* "what is coming" looks a week ahead */
const DG_TASK_OPEN = ['todo', 'doing', 'blocked'];
const DG_REQUEST_OPEN = ['open', 'in_progress'];
/* A client is running once they are live. The old words — sending, warming_up,
   setting_up — went with the features that did the sending; see SCHEMA.md. */
const DG_LIVE_STAGES = ['live', 'at_risk'];

/* ---- plumbing (copied from finance.js) ---------------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const dgOk = coreOk;
const dgErr = coreErr;
const dgWrap = coreWrap;
async function dgRun(fn, whenEmpty){
  try { return dgWrap(await fn(), whenEmpty); }
  catch (e) { return dgErr(e); }
}

/* ---- talking to things that may not be there yet ------------------ */

function dgHas(name){
  try { return typeof globalThis[name] === 'function'; } catch (e) { return false; }
}
/* Call another module's function if it exists. A missing module is not an error
   worth breaking a screen over: it comes back as {ok:false} and becomes a dash. */
async function dgAsk(name){
  const args = Array.prototype.slice.call(arguments, 1);
  if (!dgHas(name)) return dgErr('That part of Aviance OS is not loaded yet.');
  try {
    const r = await globalThis[name].apply(null, args);
    if (!r || typeof r !== 'object') return dgOk(r === undefined ? null : r);
    if (r.ok === false) return dgErr(r.error || 'Nothing came back.');
    return dgOk(r.data === undefined ? null : r.data);
  } catch (e) { return dgErr(e); }
}
/* A plain query. No sb (or no table) means a dash, never a thrown error. */
async function dgQuery(table, build, whenEmpty){
  let client = null;
  try { client = typeof sb !== 'undefined' ? sb : null; } catch (e) { client = null; }
  if (!client || typeof client.from !== 'function') return dgErr('The database is not connected yet.');
  return dgRun(() => build(client.from(table)), whenEmpty);
}
/* The list a query gave us, or an empty list. */
function dgRows(res){ return res && res.ok && Array.isArray(res.data) ? res.data : []; }
/* Did a source answer at all? Used to tell "0" apart from "we do not know". */
function dgGot(res){ return !!(res && res.ok); }

/* ---- numbers and words -------------------------------------------- */

function dgNum(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function dgInt(v){ return Math.round(dgNum(v)); }
function dgFmt(v){ return dgInt(v).toLocaleString('en-US'); }
/* A number we have, or a dash when the source could not answer. */
function dgShow(v){ return v === null || v === undefined ? DG_DASH : dgFmt(v); }
/* coreUsd, except that a figure the source could not answer reads as a dash
   rather than '$0' — this screen must never state a number it does not have. */
function dgUsd(v){ return v === null || v === undefined ? DG_DASH : coreUsd(v) }
/* The one escape, from core.js: strict, five characters, the single quote among them. */
const dgEsc = coreEsc;
/* The first key a row actually has. The views are owned by finance; this file
   reads whichever spelling it finds and says "we do not know" rather than guess. */
function dgPick(row, names){
  if (!row) return null;
  for (let i = 0; i < names.length; i++) {
    const v = row[names[i]];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}
function dgPickNum(row, names){
  const v = dgPick(row, names);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function dgPlural(n, one, many){ return dgInt(n) === 1 ? one : (many || one + 's'); }
function dgName(row){
  return String(dgPick(row, ['company', 'client_name', 'name', 'client']) || 'This client');
}

/* ---- dates --------------------------------------------------------- */

function dgNow(now){ return now instanceof Date && !isNaN(now) ? new Date(now.getTime()) : new Date(); }
function dgDayStart(d){ const x = dgNow(d); x.setHours(0,0,0,0); return x; }
function dgDateOnly(d){
  const x = dgNow(d);
  const m = String(x.getMonth()+1).padStart(2,'0'), day = String(x.getDate()).padStart(2,'0');
  return x.getFullYear() + '-' + m + '-' + day;
}
function dgParse(v){
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00Z' : s);
  return Number.isFinite(t) ? new Date(t) : null;
}
/* Monday 00:00 of the week `now` sits in, and the moment the week ends. */
function dgWeek(now){
  const start = dgDayStart(now);
  const shift = (start.getDay() - DG_WEEK_START + 7) % 7;
  start.setDate(start.getDate() - shift);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 7);
  return {from: start, to: end, fromIso: start.toISOString(), toIso: end.toISOString()};
}
function dgDays(from, to){
  const a = dgParse(from), b = dgParse(to);
  if (!a || !b) return null;
  return Math.round((dgDayStart(b) - dgDayStart(a)) / 86400000);
}
function dgNiceDay(v){
  const d = dgParse(v);
  if (!d) return '';
  return d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
}
function dgNiceDate(v){
  const d = dgParse(v);
  return d ? d.toLocaleDateString('en-US', {month:'short', day:'numeric'}) : '';
}

/* ---- calls: what counts ------------------------------------------- */

/* The database decides this (qualified_calls.counts is a generated column).
   When a row carries `counts` we believe it; otherwise we read the same three
   conditions off the row. We never count a call the row does not support. */
function dgCounts(call){
  if (!call) return false;
  if (call.counts !== undefined && call.counts !== null) return !!call.counts;
  return !!call.happened && call.matched_icp !== false && call.dispute_status !== 'upheld';
}
function dgShowedUp(call){ return !!(call && call.happened); }
function dgCallWho(call){
  return String(dgPick(call, ['prospect_name', 'prospect_company', 'prospect_email']) || 'A prospect');
}

/* ---- the month a client is in ------------------------------------- */

/* Every month row for a client, newest last. Through finance.js when it is loaded. */
async function dgStanding(clientId){
  const viaFinance = await dgAsk('fnStanding', clientId ? {clientId} : {});
  if (viaFinance.ok) return dgOk(Array.isArray(viaFinance.data) ? viaFinance.data : []);
  const direct = await dgQuery('v_month_standing', q => {
    let x = q.select('*');
    if (clientId) x = x.eq('client_id', clientId);
    return x.order('ends_on');
  }, []);
  return direct.ok ? dgOk(dgRows(direct)) : direct;
}
/* The month that is running now: the open one, else the last one that ended. */
function dgCurrentMonth(rows, now){
  const list = (rows || []).filter(Boolean);
  if (!list.length) return null;
  const open = list.filter(r => dgPick(r, ['verdict']) === 'open' && !dgPick(r, ['locked_at']));
  const pickLatest = arr => arr.slice().sort((a, b) => {
    const x = dgParse(dgPick(a, ['ends_on'])), y = dgParse(dgPick(b, ['ends_on']));
    return (x ? x.getTime() : 0) - (y ? y.getTime() : 0);
  }).pop();
  if (open.length) return pickLatest(open);
  return pickLatest(list);
}
/* Days still to go in a month. The view usually says; otherwise count them. */
function dgDaysLeft(month, now){
  const given = dgPickNum(month, ['days_left']);
  if (given !== null) return given;
  const d = dgDays(now, dgPick(month, ['ends_on']));
  return d === null ? null : d;
}
/* The pace a month has to keep to land on its promise. */
function dgPace(month, now){
  const promised = dgPickNum(month, ['calls_promised']);
  if (promised === null) return null;
  const starts = dgParse(dgPick(month, ['starts_on'])), ends = dgParse(dgPick(month, ['ends_on']));
  if (starts && ends) {
    const total = Math.max(1, dgDays(starts, ends) + 1);
    const gone = Math.min(total, Math.max(0, dgDays(starts, now) + 1));
    return promised * (gone / total);
  }
  /* no start date in the view: a month is 30 days, so days left is enough to pace it */
  const left = dgPickNum(month, ['days_left']);
  if (left === null) return null;
  const total = 30, gone = Math.min(total, Math.max(0, total - left));
  return promised * (gone / total);
}

/* How a month stands, in one word and one sentence, without flattering it. */
function dgVerdict(month, delivered, now){
  if (!month) return {state:'none', word:'no month open', line:'No month is open yet.'};
  const promised = dgPickNum(month, ['calls_promised']);
  const got = delivered === null || delivered === undefined ? dgPickNum(month, ['calls_delivered']) : delivered;
  const verdict = String(dgPick(month, ['verdict']) || 'open');
  const left = dgDaysLeft(month, now);
  const shortBy = promised === null || got === null ? null : Math.max(0, promised - got);
  const ended = left !== null && left < 0;

  if (verdict === 'waived') return {state:'waived', word:'set aside', line:'This month has been set aside.', shortBy};
  if (verdict === 'hit' || (promised !== null && got !== null && got >= promised)) {
    return {state:'hit', word:'on track', line:'The promise is met: ' + dgShow(got) + ' of ' + dgShow(promised) + ' calls.', shortBy:0};
  }
  if (verdict === 'missed' || (ended && shortBy)) {
    return {state:'short', word:'short',
      line:'The month has ended short: ' + dgShow(got) + ' of ' + dgShow(promised) + ' calls, ' + dgShow(shortBy) + ' ' + dgPlural(shortBy, 'call') + ' short.',
      shortBy};
  }
  const pace = dgPace(month, now);
  if (pace !== null && got !== null && got + 1e-9 < pace) {
    return {state:'behind', word:'behind',
      line:'Behind the pace: ' + dgShow(got) + ' of ' + dgShow(promised) + ' calls with ' +
           (left === null ? 'the month still running' : dgShow(left) + ' ' + dgPlural(left, 'day') + ' left') + '.',
      shortBy, pace};
  }
  return {state:'on_track', word:'on track',
    line:'On track: ' + dgShow(got) + ' of ' + dgShow(promised) + ' calls with ' +
         (left === null ? 'the month still running' : dgShow(left) + ' ' + dgPlural(left, 'day') + ' left') + '.',
    shortBy, pace};
}

/* Has this month's end date gone by? Asked of a standing row. */
function dgMonthEnded(m, now){
  const ends = dgParse(dgPick(m, ['ends_on']));
  if (ends) return dgDayStart(ends) < dgDayStart(dgNow(now));
  const left = dgPickNum(m, ['days_left']);
  return left !== null && left < 0;
}
/* The months that are over and still open: how many, what they would refund,
   and how long the oldest of them has been waiting. Counts nothing it cannot
   read: a refund it does not know makes the total null, never a smaller number. */
function dgEndedOpen(rows, now){
  const at = dgNow(now);
  let count = 0, refund = 0, known = true, oldest = null;
  (rows || []).forEach(m => {
    if (!m || dgPick(m, ['locked_at'])) return;
    if (String(dgPick(m, ['verdict']) || 'open') !== 'open') return;
    if (!dgMonthEnded(m, at)) return;
    count++;
    const due = dgRefundIfLocked(m).amount;
    if (due === null) known = false; else refund += dgNum(due);
    const over = dgDays(dgPick(m, ['ends_on']), at);
    if (over !== null && (oldest === null || over > oldest)) oldest = over;
  });
  return {count, refund: known ? refund : null, oldestDays: oldest};
}
/* How much of the exposure total belongs to months that have not started yet.
   Counted only from rows that say when they start AND what they are worth;
   a row missing either is not guessed at, it just is not counted. */
function dgExposureNotStarted(rows, now){
  const at = dgNow(now);
  let total = 0;
  (rows || []).forEach(m => {
    if (!m || dgPick(m, ['locked_at'])) return;
    if (String(dgPick(m, ['verdict']) || 'open') !== 'open') return;
    const starts = dgParse(dgPick(m, ['starts_on']));
    if (!starts || dgDayStart(starts) <= dgDayStart(at)) return;    /* already begun */
    total += dgNum(dgPickNum(m, ['at_risk', 'refund_due']));
  });
  return total;
}

/* What locking a short month costs, read off the finance side — never worked out here. */
function dgRefundIfLocked(month){
  const due = dgPickNum(month, ['refund_due', 'refund_amount', 'refund']);
  let mult = dgPickNum(month, ['refund_multiplier', 'multiplier', 'refund_x']);
  if (mult === null && due !== null && due > 0) {
    const fee = dgPickNum(month, ['monthly_fee', 'fee', 'month_fee']);
    if (fee !== null && fee > 0) mult = Math.round((due / fee) * 100) / 100;   /* reading back what finance set, not deciding it */
  }
  return {amount: due, multiplier: mult};
}
function dgMultWords(mult){
  if (mult === null || mult === undefined) return DG_DASH;
  const n = Math.round(Number(mult) * 100) / 100;
  return (Number.isInteger(n) ? String(n) : String(n)) + 'x';
}

/* A website booking that is a real call: not a preview from the site's own tests,
   not one that was cancelled. */
function dgRealBooking(b){
  if (!b) return false;
  return String(dgPick(b, ['source']) || '') !== 'preview' && String(dgPick(b, ['status']) || '') !== 'cancelled';
}
/* What is owed, split by its due date: {overdue, waiting, nextDue}. A sent invoice
   is only overdue once its due date has passed. null when the invoices were not read. */
function dgOwedSplit(invRows, now){
  if (!Array.isArray(invRows)) return null;
  const today = dgDateOnly(now);
  let overdue = 0, waiting = 0, nextDue = null;
  invRows.forEach(r => {
    const st = String(dgPick(r, ['status']) || '');
    if (['sent', 'overdue', 'unpaid'].indexOf(st) < 0) return;
    const amt = dgNum(dgPick(r, ['amount', 'gross_amount']));
    const due = String(dgPick(r, ['due_on']) || '').slice(0, 10);
    if (st === 'overdue' || (due && due < today)) overdue += amt;
    else { waiting += amt; if (due && (!nextDue || due < nextDue)) nextDue = due; }
  });
  return {overdue, waiting, nextDue};
}

/* =================================================================== */
/* ---- dgHome: the one screen a person opens first ------------------ */
/* =================================================================== */

async function dgHome(now){
  const at = dgNow(now);
  const week = dgWeek(at);
  const today = dgDateOnly(at);

  /* Eleven separate reads, none waiting on another: ask for them all at once, so Today
     opens in the time of the slowest one instead of the sum of them. */
  const [money, exposure, clients, standing, invoices,
         callsRes, deliveredRes, requestsRes, tasksRes, siteRes, profilesRes] = await Promise.all([
    dgAsk('fnMoney'),
    dgAsk('fnExposure'),
    dgAsk('fnClients'),
    dgStanding(null),
    dgAsk('fnInvoices'),
    dgQuery('qualified_calls',
      q => q.select('*').gte('booked_for', week.fromIso).lt('booked_for', week.toIso), []),
    dgQuery('qualified_calls',
      q => q.select('*').gte('happened_at', week.fromIso).lt('happened_at', week.toIso), []),
    dgQuery('client_requests',
      q => q.select('*').in('status', DG_REQUEST_OPEN), []),
    dgQuery('tasks',
      q => q.select('*').in('status', DG_TASK_OPEN).lt('due_on', today), []),
    /* discovery calls booked from the website for this week — not the preview ones, not the cancelled */
    dgQuery('discovery_bookings',
      q => q.select('*').gte('call_at', week.fromIso).lt('call_at', week.toIso), []),
    dgQuery('client_profiles', q => q.select('client_id,signed_off_at'), [])
  ]);
  const clientsQ = clients.ok ? clients : await dgQuery('clients', q => q.select('*'), []);

  /* clients live now: a client with sending under way and no end date */
  let clientsLive = null;
  if (dgGot(clientsQ)) {
    clientsLive = dgRows(clientsQ).filter(c => {
      if (!c || dgPick(c, ['ended_on'])) return false;
      const stage = String(dgPick(c, ['stage']) || '');
      return DG_LIVE_STAGES.indexOf(stage) >= 0 || !!dgPick(c, ['day1_on']);
    }).length;
  }

  /* months running short, and by how much */
  const nameOf = {};
  dgRows(clientsQ).forEach(c => { if (c && c.id) nameOf[c.id] = dgName(c); });
  const shortMonths = [];
  if (dgGot(standing)) {
    dgRows(standing).forEach(m => {
      if (!m || dgPick(m, ['locked_at'])) return;
      /* A month that is OVER is not running short, it is waiting to be closed:
         it belongs under "months to close", and counting it in both places
         counted it twice in the sidebar badge. */
      if (dgMonthEnded(m, at)) return;
      const v = dgVerdict(m, null, at);
      if (v.state !== 'behind' && v.state !== 'short') return;
      shortMonths.push({
        monthId: dgPick(m, ['id', 'month_id']),
        clientId: dgPick(m, ['client_id']),
        company: nameOf[dgPick(m, ['client_id'])] || dgName(m),
        monthNo: dgPickNum(m, ['month_no']),
        promised: dgPickNum(m, ['calls_promised']),
        delivered: dgPickNum(m, ['calls_delivered']),
        shortBy: v.shortBy,
        daysLeft: dgDaysLeft(m, at),
        state: v.state,
        line: v.line,
        refund: dgRefundIfLocked(m)
      });
    });
    shortMonths.sort((a, b) => dgNum(b.shortBy) - dgNum(a.shortBy));
  }

  /* MONTHS THAT ARE OVER AND STILL OPEN — counted, not drawn here.
     Round 2 agent 5 owns the commitment board at the top of Today and already
     gives these a line of their own, so this screen does not draw a second
     copy of them. What is added here is the count, the money and how long the
     oldest has waited, off rows dgHome has already read, for whatever draws
     them; the ACTION (lock, with the outstanding-verdict check) lives on the
     Month end screen, which is where locking happens.
     THE ORIGINAL BUG, for the record: Today's only mention of month end was a
     link reading "Close the months that have ended", the same words whether
     there were none or five and whether they owed nothing or $6,000. The month
     that ended on 9 October owing $3,000 sat 48 days behind that sentence.
     Until this was counted here, Today's only mention of month end was a link
     that said "Close the months that have ended" whether there were none or
     five, and whether they owed nothing or $6,000. The month that ended on
     9 October owing $3,000 sat 48 days behind that sentence. Counted off the
     same rows, so it needs no extra read and works whether or not the
     month-end engine is in the database yet. */
  const endedOpen = dgGot(standing) ? dgEndedOpen(dgRows(standing), at) : null;

  /* WHAT THE EXPOSURE FIGURE IS MADE OF — again counted, not drawn here.
     The tile's own wording belongs to the screen that draws it.
     v_exposure adds up every open month, months that have not started
     included. On the live database on 2026-11-26 that was $69,300, of which
     $30,000 was 14 months whose first day has not come — a month that has not
     begun cannot miss today. The headline figure is left exactly as the
     finance view states it (this file does not re-work the money), but the
     part of it that cannot be lost today is counted separately, so whatever
     draws the tile can say so instead of letting the number read as a hole
     $30,000 bigger than it is. */
  const exposureNotStarted = dgGot(standing) ? dgExposureNotStarted(dgRows(standing), at) : null;

  /* money. v_money first; invoice rows only as a fallback for a key it does not carry. */
  const m = money.ok ? money.data : null;
  const invRows = dgGot(invoices) ? dgRows(invoices) : null;
  const sumInv = pick => invRows === null ? null : invRows.reduce((t, r) => t + (pick(r) ? dgNum(dgPick(r, ['amount', 'gross_amount'])) : 0), 0);
  /* v_money's own names, checked against the live view on 2026-11-26:
     unpaid_invoiced, paid_this_month, paid_all_time, refunds_owed, refunds_paid.
     'unpaid_invoiced' and 'paid_all_time' were not in these lists either, so
     both tiles were quietly being added up in the browser off the invoice rows
     instead of being read from the view. They agreed, this time. The view has no
     column for everything ever invoiced, so that one is still a browser sum —
     labelled as such in the note above. */
  const invoiced = dgPickNum(m, ['invoiced', 'invoiced_total', 'billed', 'gross_invoiced']);
  const owed     = dgPickNum(m, ['unpaid_invoiced', 'invoiced_unpaid', 'unpaid', 'owed', 'outstanding', 'awaiting_payment']);
  const paidEver = dgPickNum(m, ['paid_all_time', 'paid_ever', 'paid', 'paid_total', 'received_ever']);
  const paidMonth= dgPickNum(m, ['paid_this_month', 'paid_month', 'received_this_month']);
  const refundsOwed = dgPickNum(m, ['refunds_owed', 'refunds_unpaid', 'owed_refunds']);
  /* A view that answered with no rows means zero, not "we do not know". A view
     that did not answer at all means a dash. */
  const first = (fromView, fromRows) =>
    fromView !== null && fromView !== undefined ? fromView
    : (fromRows !== null && fromRows !== undefined ? fromRows : (money.ok ? 0 : null));
  const moneyOut = {
    invoiced: first(invoiced, sumInv(r => String(dgPick(r, ['status']) || '') !== 'void')),
    owed:     first(owed, sumInv(r => ['sent', 'overdue', 'unpaid', 'draft'].indexOf(String(dgPick(r, ['status']) || '')) >= 0)),
    paidEver: first(paidEver, sumInv(r => String(dgPick(r, ['status']) || '') === 'paid')),
    paidThisMonth: first(paidMonth, null),
    refundsOwed: first(refundsOwed, null)
  };

  /* v_exposure's columns are open_months, at_risk_total and at_risk_month_one.
     This list did not have at_risk_total in it, so dgPick found nothing, and the
     line below turned that into a confident 0: on 2026-11-26 the Today screen
     said "$0 refunds exposed" while the view itself said $69,300. The real name
     goes first; the old guesses stay behind it in case the view is ever renamed.
     A view that answered with NO ROW AT ALL still means zero — there are no open
     months — but a view that answered without the column we wanted does not, and
     that case is now a dash. */
  const exp = exposure.ok ? exposure.data : null;
  let refundsExposed = dgPickNum(exp, ['at_risk_total', 'at_risk', 'exposure', 'refund_at_risk', 'would_owe', 'amount', 'total']);
  if (refundsExposed === null && exposure.ok && exp === null) refundsExposed = 0;

  const salesBooked = dgGot(callsRes) ? dgRows(callsRes).length : null;
  const siteBooked = dgGot(siteRes) ? dgRows(siteRes).filter(dgRealBooking).length : null;
  const booked = salesBooked === null && siteBooked === null ? null : dgInt(salesBooked) + dgInt(siteBooked);

  /* money owed, split: past its due date (chase it) and not yet due (we are only waiting) */
  const owedSplit = dgOwedSplit(invRows, at);

  /* clients in onboarding who have not given us their inputs */
  const signed = {};
  dgRows(profilesRes).forEach(p => { if (p && p.client_id && dgPick(p, ['signed_off_at'])) signed[p.client_id] = true; });
  const onboardingWaiting = dgGot(clientsQ) ? dgRows(clientsQ)
    .filter(c => c && String(dgPick(c, ['stage']) || '') === 'onboarding' && !signed[c.id])
    .map(c => ({clientId: c.id, company: dgName(c)})) : [];
  const delivered = dgGot(deliveredRes) ? dgRows(deliveredRes).filter(dgCounts).length : null;

  return dgOk({
    now: at.toISOString(),
    week: {from: week.fromIso, to: week.toIso, label: dgNiceDate(week.from) + ' – ' + dgNiceDate(new Date(week.to.getTime() - 86400000))},
    calls: {bookedThisWeek: booked, deliveredThisWeek: delivered, websiteThisWeek: siteBooked, salesThisWeek: salesBooked},
    owedSplit,
    onboardingWaiting,
    clientsLive,
    shortMonths,
    endedOpen,
    exposureNotStarted,
    money: moneyOut,
    refundsExposed,
    openRequests: dgGot(requestsRes) ? dgRows(requestsRes).length : null,
    overdueTasks: dgGot(tasksRes) ? dgRows(tasksRes).length : null,
    requests: dgRows(requestsRes).slice(0, 8),
    tasks: dgRows(tasksRes).slice(0, 8),
    missing: [
      money.ok ? null : 'the money view',
      exposure.ok ? null : 'what refunds are exposed',
      dgGot(standing) ? null : 'the month standings',
      dgGot(clientsQ) ? null : 'the client list',
      dgGot(requestsRes) ? null : 'client requests',
      dgGot(tasksRes) ? null : 'the work queue'
    ].filter(Boolean)
  });
}

/* =================================================================== */
/* ---- dgClientWeek: one client's week ----------------------------- */
/* =================================================================== */

/* `pre` lets a caller that has already read these four things for a whole list
   of clients hand them in — see dgFridayAll, which reads them once for
   everybody instead of four times per client. Each entry is a whole
   {ok,data,error}, so a source that could not answer still shows as a dash
   here and not as a zero. */
async function dgClientWeek(clientId, now, pre){
  if (!clientId) return dgErr('Which client? No client was given.');
  const at = dgNow(now);
  const week = dgWeek(at);
  const have = pre && typeof pre === 'object' ? pre : null;

  /* Four things, none of which needs any of the others, so they are asked for
     together: one wait instead of four. */
  const [clientRes, standing, callsRes, sum] = have
    ? [have.client, have.standing, have.calls, have.summary]
    : await Promise.all([
      dgQuery('clients', q => q.select('id,company').eq('id', clientId).maybeSingle(), null),
      dgStanding(clientId),
      dgHas('fnCalls')
        ? dgAsk('fnCalls', clientId)
        : dgQuery('qualified_calls', q => q.select('*').eq('client_id', clientId), []),
      dgQuery('v_outreach_summary', q => q.select('*').eq('client_id', clientId).maybeSingle(), null),
    ]);
  const month = dgCurrentMonth(dgRows(standing), at);
  const monthId = month ? dgPick(month, ['id', 'month_id']) : null;
  const calls = dgRows(callsRes);

  const inWindow = (v, from, to) => {
    const d = dgParse(v);
    return !!d && d >= from && d < to;
  };
  const mStart = dgParse(month && dgPick(month, ['starts_on']));
  const mEnd = dgParse(month && dgPick(month, ['ends_on']));
  const inMonth = call => {
    if (monthId && dgPick(call, ['month_id'])) return dgPick(call, ['month_id']) === monthId;
    if (!mStart || !mEnd) return true;
    const d = dgParse(dgPick(call, ['booked_for']));
    return !!d && dgDayStart(d) >= dgDayStart(mStart) && dgDayStart(d) <= dgDayStart(mEnd);
  };

  const monthCalls = calls.filter(inMonth);
  const countedThisMonth = monthCalls.filter(dgCounts).length;
  const fromView = dgPickNum(month, ['calls_delivered']);
  /* Never overstate: when the view and the rows disagree, say the smaller number. */
  const delivered = fromView === null ? (dgGot(callsRes) ? countedThisMonth : null)
    : (dgGot(callsRes) ? Math.min(fromView, countedThisMonth) : fromView);

  const bookedThisWeek = calls.filter(c => inWindow(dgPick(c, ['booked_for']), week.from, week.to));
  const noShows = monthCalls.filter(c => {
    const d = dgParse(dgPick(c, ['booked_for']));
    return !!d && d < at && !dgShowedUp(c);
  });
  const soonTo = new Date(dgDayStart(at).getTime() + DG_SOON_DAYS * 86400000);
  const coming = calls.filter(c => {
    const d = dgParse(dgPick(c, ['booked_for']));
    return !!d && d >= at && d < soonTo;
  }).sort((a, b) => dgParse(dgPick(a, ['booked_for'])) - dgParse(dgPick(b, ['booked_for'])));

  /* replies belong to the outreach area. Missing is a dash, not a zero. */
  let replies = null;
  if (sum && sum.ok && sum.data) replies = dgPickNum(sum.data, ['replied', 'replies']);

  const verdict = dgVerdict(month, delivered, at);
  const left = dgDaysLeft(month, at);

  return dgOk({
    clientId,
    company: clientRes.ok && clientRes.data ? dgName(clientRes.data) : (month ? dgName(month) : 'This client'),
    week: {from: week.fromIso, to: week.toIso},
    monthNo: dgPickNum(month, ['month_no']),
    monthId,
    promised: dgPickNum(month, ['calls_promised']),
    delivered,
    bookedThisWeek: bookedThisWeek.map(c => ({
      who: dgCallWho(c), at: dgPick(c, ['booked_for']), counts: dgCounts(c), showedUp: dgShowedUp(c)
    })),
    showedUp: monthCalls.filter(dgCounts).map(dgCallWho),
    coming: coming.map(c => ({who: dgCallWho(c), at: dgPick(c, ['booked_for'])})),
    replies,
    noShows: dgGot(callsRes) ? noShows.length : null,
    daysLeft: left,
    pace: verdict.pace === undefined ? null : verdict.pace,
    shortBy: verdict.shortBy === undefined ? null : verdict.shortBy,
    onTrack: verdict.state === 'hit' || verdict.state === 'on_track',
    status: verdict.word,                 /* "on track" | "behind" | "short" | "set aside" | "no month open" */
    state: verdict.state,
    line: verdict.line,
    refund: dgRefundIfLocked(month)
  });
}

/* =================================================================== */
/* ---- dgFridayUpdate: the note that goes to a client -------------- */
/* =================================================================== */

/* Built from rows only. If the month is short it says so, and says what happens
   next, because the guarantee means a short month costs money. */
async function dgFridayUpdate(clientId, now, pre){
  const wk = await dgClientWeek(clientId, now, pre);
  if (!wk.ok) return wk;
  const d = wk.data;
  const at = dgNow(now);

  const promised = d.promised, delivered = d.delivered, left = d.daysLeft;
  const facts = {
    company: d.company,
    monthNo: d.monthNo,
    promised, delivered,
    bookedThisWeek: d.bookedThisWeek.length,
    showedUp: d.showedUp.slice(),
    coming: d.coming.slice(),
    replies: d.replies,
    noShows: d.noShows,
    daysLeft: left,
    status: d.status,
    state: d.state,
    shortBy: d.shortBy,
    refund: d.refund,
    week: d.week
  };

  const lines = [];
  lines.push('Week of ' + dgNiceDate(dgWeek(at).from) + ' — ' + d.company);
  lines.push('');

  if (!d.bookedThisWeek.length) lines.push('Booked this week: nothing yet.');
  else {
    lines.push('Booked this week: ' + d.bookedThisWeek.length + ' ' + dgPlural(d.bookedThisWeek.length, 'call') + '.');
    d.bookedThisWeek.forEach(c => lines.push('  - ' + c.who + ' — ' + (dgNiceDay(c.at) || 'time to confirm')));
  }

  if (d.showedUp.length) lines.push('Turned up and counted this month: ' + d.showedUp.length + ' (' + d.showedUp.join(', ') + ').');
  else lines.push('Turned up and counted this month: none yet.');

  if (d.noShows !== null && d.noShows > 0) lines.push('Did not turn up: ' + d.noShows + '. Those do not count towards the month.');
  if (d.replies !== null) lines.push('Replies so far: ' + dgFmt(d.replies) + '.');

  if (d.coming.length) {
    lines.push('Coming up: ' + d.coming.length + ' ' + dgPlural(d.coming.length, 'call') + '.');
    d.coming.forEach(c => lines.push('  - ' + c.who + ' — ' + (dgNiceDay(c.at) || 'time to confirm')));
  } else lines.push('Coming up: nothing booked yet for the next week.');

  lines.push('');
  if (d.state === 'none') {
    lines.push('Where the month stands: no month is open yet, so nothing is counting.');
  } else {
    lines.push('Where the month stands: ' + dgShow(delivered) + ' of ' + dgShow(promised) +
      ' calls' + (d.monthNo === null ? '' : ' in month ' + d.monthNo) +
      (left === null ? '' : (left < 0 ? ', the month has ended' : ', ' + dgShow(left) + ' ' + dgPlural(left, 'day') + ' left')) + '.');
    if (d.state === 'short') {
      lines.push('This month is short by ' + dgShow(d.shortBy) + ' ' + dgPlural(d.shortBy, 'call') + '. That is on us.');
      lines.push(d.refund.amount !== null && d.refund.amount > 0
        ? 'What happens next: we refund ' + dgUsd(d.refund.amount) + (d.refund.multiplier ? ' (' + dgMultWords(d.refund.multiplier) + ' the month)' : '') + ' when the month is locked.'
        : 'What happens next: the guarantee applies and the refund is worked out when the month is locked.');
    } else if (d.state === 'behind') {
      lines.push('We are behind the pace needed to meet the promise. ' +
        (left !== null && left >= 0 ? 'There are ' + dgShow(left) + ' ' + dgPlural(left, 'day') + ' left and we are pushing volume to catch up. ' : '') +
        'If the month ends short, the guarantee applies and you get money back.');
    } else if (d.state === 'hit') {
      lines.push('The promise for this month is met.');
    } else if (d.state === 'waived') {
      lines.push('This month has been set aside, so nothing is counting against the promise.');
    } else {
      lines.push('We are on the pace needed to meet the promise.');
    }
  }
  lines.push('');
  lines.push('Anything wrong in here, tell us and we will fix the record.');

  const text = lines.join('\n');
  const html = '<div class="dg-note">' + lines.map(l => {
    if (l === '') return '';
    if (/^ {2}- /.test(l)) return '<div class="dg-note-item">' + dgEsc(l.replace(/^ {2}- /, '')) + '</div>';
    return '<p>' + dgEsc(l) + '</p>';
  }).join('') + '</div>';

  // TODO: send this update to the client. Nothing in this file sends anything — the
  // TODO: note is written here and read on screen first. When the sending area exists,
  // TODO: hand it {clientId, text, html} and write the send against the client.

  return dgOk({text, html, facts});
}

/* Every live client's update, ready to review before anything goes out. */
async function dgFridayAll(now){
  const clients = await dgAsk('fnClients');
  const list = clients.ok ? clients : await dgQuery('clients', q => q.select('*'), []);
  if (!dgGot(list)) return dgOk({drafts: [], error: list.error || '', missing: ['the client list']});

  const live = dgRows(list).filter(c => {
    if (!c || !c.id || dgPick(c, ['ended_on'])) return false;
    const stage = String(dgPick(c, ['stage']) || '');
    return DG_LIVE_STAGES.indexOf(stage) >= 0 || !!dgPick(c, ['day1_on']);
  });

  /* One draft per client used to cost four round trips of its own, run one
     client after the next: twenty-five clients was a hundred waits in a row.
     The four things every draft needs are read once here for the whole list
     and handed to each draft, so the figures are still worked out in one
     place — dgClientWeek — and the screen costs four reads, not a hundred. */
  const ids = live.map(c => c.id);
  const byId = (res, key) => {
    const m = {};
    dgRows(res).forEach(r => { const k = r && dgPick(r, [key || 'client_id']); if (k != null) (m[k] = m[k] || []).push(r); });
    return m;
  };
  const [allStanding, allCalls, allSummary] = ids.length ? await Promise.all([
    dgStanding(null),
    /* fnCalls only answers about one client, so the whole list is read here. */
    dgQuery('qualified_calls', q => q.select('*').in('client_id', ids), []),
    dgQuery('v_outreach_summary', q => q.select('*').in('client_id', ids), []),
  ]) : [dgOk([]), dgOk([]), dgOk([])];
  const standingBy = byId(allStanding), callsBy = byId(allCalls), sumBy = byId(allSummary);
  /* A source that did not answer stays "did not answer" for every client, so a
     database that is down still shows a dash and never a made-up zero. */
  const slice = (res, map, id) => (res.ok ? dgOk(map[id] || []) : res);

  const made = await Promise.all(live.map(c => dgFridayUpdate(c.id, now, {
    client: dgOk(c),
    standing: slice(allStanding, standingBy, c.id),
    calls: slice(allCalls, callsBy, c.id),
    summary: allSummary.ok ? dgOk((sumBy[c.id] || [])[0] || null) : allSummary,
  })));
  const drafts = live.map((c, i) => {
    const r = made[i];
    return r.ok
      ? {clientId: c.id, company: dgName(c), ok: true, text: r.data.text, html: r.data.html, facts: r.data.facts, error: ''}
      : {clientId: c.id, company: dgName(c), ok: false, text: '', html: '', facts: null, error: r.error};
  });
  return dgOk({drafts, missing: []});
}

/* =================================================================== */
/* ---- dgMonthClose: the months ready to close --------------------- */
/* =================================================================== */

/* THE ENGINE AND THIS SCREEN READ THE SAME ROW.
   20261209_month_end_engine.sql adds v_months_to_close — every month whose end
   date has passed in the house US zone and that is still open — and
   month_end_close(), an hourly pg_cron sweep that locks the ones it can lock
   safely. The view carries the whole decision: `ready` and, when it is false,
   `why_not` in a sentence. This screen shows that list, so what the owner sees
   and what the sweep will do cannot drift apart.

   Until that migration is applied the view is not there, and the browser falls
   back to working it out from v_month_standing, as it always did. The fallback
   cannot know whether a month is held, so it says so rather than implying every
   month on it is safe to lock. */

const DG_TO_CLOSE_VIEW = 'v_months_to_close';

/* One row of the view, in this file's words. */
function dgCloseRow(m, nameOf){
  const promised = dgPickNum(m, ['calls_promised']);
  const delivered = dgPickNum(m, ['calls_delivered']);
  const short = promised === null || delivered === null ? null : Math.max(0, promised - delivered);
  const over = dgPickNum(m, ['days_over']);
  const waiting = dgPickNum(m, ['awaiting_verdict']);
  return {
    monthId: dgPick(m, ['month_id', 'id']),
    clientId: dgPick(m, ['client_id']),
    company: (nameOf && nameOf[dgPick(m, ['client_id'])]) || dgName(m),
    monthNo: dgPickNum(m, ['month_no']),
    promised, delivered,
    shortBy: short,
    endsOn: dgPick(m, ['ends_on']),
    daysOver: over,
    verdict: String(dgPick(m, ['verdict']) || 'open'),
    state: short ? 'short' : 'hit',
    refundDue: dgPickNum(m, ['refund_if_locked', 'refund_due', 'at_risk']),
    multiplier: dgPickNum(m, ['multiplier']),
    multiplierWords: dgMultWords(dgPickNum(m, ['multiplier'])),
    awaitingVerdict: waiting,
    ready: m.ready === undefined ? null : !!m.ready,
    whyNot: String(dgPick(m, ['why_not']) || ''),
    line: (short
      ? 'Ended short: ' + dgShow(delivered) + ' of ' + dgShow(promised) + ' calls, ' +
        dgShow(short) + ' ' + dgPlural(short, 'call') + ' short.'
      : 'Ended having met the promise: ' + dgShow(delivered) + ' of ' + dgShow(promised) + ' calls.') +
      (over === null || over <= 0 ? '' : ' ' + dgShow(over) + ' ' + dgPlural(over, 'day') + ' ago.')
  };
}

async function dgMonthClose(now){
  /* The engine's own view first: one answer, shared with the sweep. A database
     without the migration answers with an error (the view is not there), which
     core.js turns into "that part isn't switched on yet"; a database WITH it and
     nothing to close answers with no rows, and then the two ways of counting
     agree anyway, so the cheaper one is used and the screen still says the
     engine is running. */
  const viaView = await dgQuery(DG_TO_CLOSE_VIEW, q => q.select('*').order('ends_on'), []);
  const viewRows = dgGot(viaView) ? dgRows(viaView) : null;
  if (viewRows && viewRows.length) {
    const clients = await dgAsk('fnClients');
    const clientsQ = clients.ok ? clients : await dgQuery('clients', q => q.select('*'), []);
    const nameOf = {};
    dgRows(clientsQ).forEach(c => { if (c && c.id) nameOf[c.id] = dgName(c); });
    const all = viewRows.map(m => dgCloseRow(m, nameOf));
    const byMoney = (a, b) => dgNum(b.refundDue) - dgNum(a.refundDue);
    const ready = all.filter(x => x.ready !== false).sort(byMoney);
    const held  = all.filter(x => x.ready === false).sort(byMoney);
    return dgOk({
      months: ready, held, engine: true,
      totalRefund: dgCloseTotal(ready),
      heldRefund: dgCloseTotal(held),
      missing: []
    });
  }
  const fb = await dgMonthCloseFromStanding(now);
  if (viewRows && fb.ok && fb.data && !fb.data.months.length) {
    fb.data.engine = true;
    fb.data.missing = [];
  }
  return fb;
}

/* What locking this lot would refund. null when any one of them is unknown,
   because a total with a hole in it is worse than no total. */
function dgCloseTotal(rows){
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 0;
  if (list.some(x => x.refundDue === null || x.refundDue === undefined)) return null;
  return list.reduce((t, x) => t + dgNum(x.refundDue), 0);
}

/* The old way, kept for a database that does not have the engine yet. */
async function dgMonthCloseFromStanding(now){
  const at = dgNow(now);
  const standing = await dgStanding(null);
  if (!dgGot(standing)) return dgOk({months: [], totalRefund: null, missing: ['the month standings'], error: standing.error || ''});

  const clients = await dgAsk('fnClients');
  const clientsQ = clients.ok ? clients : await dgQuery('clients', q => q.select('*'), []);
  const nameOf = {};
  dgRows(clientsQ).forEach(c => { if (c && c.id) nameOf[c.id] = dgName(c); });

  const months = [];
  dgRows(standing).forEach(m => {
    if (!m || dgPick(m, ['locked_at'])) return;
    const ends = dgParse(dgPick(m, ['ends_on']));
    const left = dgPickNum(m, ['days_left']);
    const ended = ends ? dgDayStart(ends) < dgDayStart(at) : (left !== null && left < 0);
    if (!ended) return;                                            /* only months whose end date has passed */
    const v = dgVerdict(m, null, at);
    const refund = dgRefundIfLocked(m);
    months.push({
      monthId: dgPick(m, ['id', 'month_id']),
      clientId: dgPick(m, ['client_id']),
      company: nameOf[dgPick(m, ['client_id'])] || dgName(m),
      monthNo: dgPickNum(m, ['month_no']),
      promised: dgPickNum(m, ['calls_promised']),
      delivered: dgPickNum(m, ['calls_delivered']),
      endsOn: dgPick(m, ['ends_on']),
      verdict: String(dgPick(m, ['verdict']) || 'open'),
      state: v.state,
      shortBy: v.shortBy,
      refundDue: refund.amount,
      multiplier: refund.multiplier,
      multiplierWords: dgMultWords(refund.multiplier),
      line: v.line
    });
  });
  months.sort((a, b) => dgNum(b.refundDue) - dgNum(a.refundDue));
  months.forEach(m => { m.ready = null; m.whyNot = ''; m.awaitingVerdict = null; m.daysOver = dgDays(m.endsOn, at); });
  return dgOk({
    months, held: [], engine: false,
    totalRefund: dgCloseTotal(months),
    heldRefund: 0,
    missing: ['whether each month is safe to lock']
  });
}

/* =================================================================== */
/* ---- the screens -------------------------------------------------- */
/* =================================================================== */

function dgTile(label, value, note){
  return '<div class="dg-tile"><span class="dg-tile-l">' + dgEsc(label) + '</span><b class="dg-tile-v">' + dgEsc(value) + '</b>' +
    (note ? '<span class="dg-tile-n">' + dgEsc(note) + '</span>' : '') + '</div>';
}
/* A bar made of plain divs: delivered against promised. Readable in both themes. */
function dgBar(delivered, promised, state){
  const p = dgInt(promised), g = dgInt(delivered);
  const pct = p > 0 ? Math.max(0, Math.min(100, Math.round((g / p) * 100))) : 0;
  return '<div class="dg-bar" role="img" aria-label="' + dgEsc(dgShow(delivered) + ' of ' + dgShow(promised) + ' calls') + '">' +
    '<span class="dg-bar-fill dg-' + dgEsc(state || 'open') + '" style="width:' + pct + '%"></span></div>';
}
function dgLink(label, onclick, main){
  return '<button type="button" class="btn' + (main ? '' : ' ghost') + '" onclick="' + dgEsc(onclick) + '">' + dgEsc(label) + '</button>';
}
function dgMissingLine(missing){
  if (!missing || !missing.length) return '';
  return '<p class="dg-missing">Some of this is not in yet: ' + dgEsc(missing.join(', ')) +
    '. Those numbers show a dash until that part of Aviance OS answers.</p>';
}

/* --- the front screen --- */
function dgRenderHome(data){
  const d = data || {};
  const c = d.calls || {}, m = d.money || {};
  const tiles = [
    dgTile('Calls booked this week', dgShow(c.bookedThisWeek), c.websiteThisWeek ? dgFmt(c.websiteThisWeek) + ' from the website' : ''),
    dgTile('Calls delivered this week', dgShow(c.deliveredThisWeek)),
    dgTile('Clients live', dgShow(d.clientsLive)),
    dgTile('Invoiced', dgUsd(m.invoiced)),
    dgTile('Owed to us', dgUsd(m.owed)),
    dgTile('Refunds exposed', dgUsd(d.refundsExposed), 'every open month, started or not'),
    dgTile('Open requests', dgShow(d.openRequests)),
    dgTile('Overdue tasks', dgShow(d.overdueTasks))
  ].join('');

  const short = Array.isArray(d.shortMonths) ? d.shortMonths : [];
  const shortBlock = short.length
    ? '<ul class="dg-list">' + short.map(s =>
        '<li class="dg-row"><div class="dg-row-main"><b>' + dgEsc(s.company) + '</b>' +
        '<span class="dg-row-sub">' + dgEsc(s.line) + '</span>' +
        dgBar(s.delivered, s.promised, s.state) + '</div>' +
        '<div class="dg-row-side"><span class="dg-amount">' + dgEsc(s.shortBy === null ? DG_DASH : dgShow(s.shortBy) + ' ' + dgPlural(s.shortBy, 'call') + ' short') + '</span>' +
        '<span class="dg-row-sub">' + dgEsc(s.refund.amount ? dgUsd(s.refund.amount) + ' at ' + dgMultWords(s.refund.multiplier) + ' if it locks short' : 'no refund worked out yet') + '</span></div>' +
        '<div class="dg-row-act">' + dgLink('Open this client', "dgOpenClient('" + dgEsc(String(s.clientId || '')) + "')", true) + '</div></li>').join('') + '</ul>'
    : '<p class="dg-none">No month is running short. Nothing needs a person here.</p>';

  const needs = [];
  if (dgNum(d.openRequests) > 0) needs.push(['Answer ' + dgShow(d.openRequests) + ' open client ' + dgPlural(d.openRequests, 'request'), "dgGo('requests')"]);
  if (dgNum(d.overdueTasks) > 0) needs.push(['Clear ' + dgShow(d.overdueTasks) + ' overdue ' + dgPlural(d.overdueTasks, 'task'), "dgGo('tasks')"]);
  const split = d.owedSplit;
  if (split && (split.overdue > 0 || split.waiting > 0)) {
    if (split.overdue > 0) needs.push(['Chase ' + dgUsd(split.overdue) + ' overdue', "dgGo('money')"]);
    if (split.waiting > 0) needs.push(['Awaiting ' + dgUsd(split.waiting) + (split.nextDue ? ' (due ' + dgNiceDate(dgParse(split.nextDue)) + ')' : ''), "dgGo('money')"]);
  } else if (dgNum(m.owed) > 0) needs.push([dgUsd(m.owed) + ' owed to us', "dgGo('money')"]);
  const waitingOn = Array.isArray(d.onboardingWaiting) ? d.onboardingWaiting : [];
  waitingOn.forEach(w => needs.push(['Onboarding: ' + w.company + ' — waiting on their inputs', "dgOpenClient('" + String(w.clientId || '').replace(/[^A-Za-z0-9_.:-]/g, '') + "')"]));
  needs.push(['Review this week\'s client updates', "dgGo('friday')"]);
  needs.push(['Close the months that have ended', "dgGo('monthEnd')"]);

  return '<div class="dg-screen">' +
    '<div class="dg-tiles">' + tiles + '</div>' +
    (d.week && d.week.label ? '<p class="dg-week">Week of ' + dgEsc(d.week.label) + '</p>' : '') +
    '<div class="dg-head"><h3>Running short</h3></div>' + shortBlock +
    '<div class="dg-head"><h3>Needs a person</h3></div>' +
    '<ul class="dg-links">' + needs.map(n => '<li><button type="button" class="dg-link" onclick="' + dgEsc(n[1]) + '">' + dgEsc(n[0]) + '</button></li>').join('') + '</ul>' +
    dgMissingLine(d.missing) + '</div>';
}

/* --- the Friday drafts --- */
function dgFactList(f){
  if (!f) return '<p class="dg-none">No facts to show.</p>';
  const rows = [
    ['Month', f.monthNo === null || f.monthNo === undefined ? DG_DASH : String(f.monthNo)],
    ['Promised', dgShow(f.promised)],
    ['Delivered (counted)', dgShow(f.delivered)],
    ['Booked this week', dgShow(f.bookedThisWeek)],
    ['Turned up', dgShow(f.showedUp ? f.showedUp.length : null)],
    ['Did not turn up', dgShow(f.noShows)],
    ['Coming up', dgShow(f.coming ? f.coming.length : null)],
    ['Replies', dgShow(f.replies)],
    ['Days left', f.daysLeft === null || f.daysLeft === undefined ? DG_DASH : dgShow(f.daysLeft)],
    ['Where it stands', String(f.status || DG_DASH)],
    ['Refund if it locks short', f.refund && f.refund.amount ? dgUsd(f.refund.amount) + ' at ' + dgMultWords(f.refund.multiplier) : DG_DASH]
  ];
  /* DESIGN.md: the figures in this list are mono. They are counts, money and
     day counts, read side by side, so they line up or they are harder to read
     than they need to be. */
  return '<dl class="dg-facts">' + rows.map(r => '<div><dt>' + dgEsc(r[0]) + '</dt><dd class="fig">' + dgEsc(r[1]) + '</dd></div>').join('') + '</dl>';
}
function dgRenderFriday(data){
  const d = data || {};
  const drafts = Array.isArray(d.drafts) ? d.drafts : [];
  if (!drafts.length) return '<div class="dg-screen"><p class="dg-none">No live clients, so there is nothing to send yet.</p>' + dgMissingLine(d.missing) + '</div>';
  return '<div class="dg-screen"><div class="dg-head"><h3>This week\'s updates</h3>' +
    '<span class="dg-sub">' + dgEsc(drafts.length + ' ' + dgPlural(drafts.length, 'draft') + '. Read the facts beside each one before it goes.') + '</span></div>' +
    '<div class="dg-drafts">' + drafts.map((x, i) =>
      '<section class="dg-draft"><div class="dg-draft-h"><b>' + dgEsc(x.company) + '</b>' +
      dgLink('Copy', "dgCopyDraft(" + i + ")") + '</div>' +
      (x.ok
        ? '<textarea class="dg-note-edit" id="dgDraft' + i + '" rows="16" spellcheck="true" aria-label="' + dgEsc('Update for ' + x.company) + '">' + dgEsc(x.text) + '</textarea>'
        : '<p class="dg-missing">' + dgEsc(x.error || 'This one could not be built.') + '</p>') +
      '<div class="dg-draft-facts"><b class="dg-facts-h">Built from</b>' + dgFactList(x.facts) + '</div>' +
      '<p class="dg-note-foot">Nothing is sent from this screen. Copy it into the client\'s channel when you are happy with it.</p></section>').join('') +
    '</div>' + dgMissingLine(d.missing) + '</div>';
}

/* --- the months ready to close --- */

/* How overdue a month is, in words. A month that ended yesterday is not news; a
   month that ended seven weeks ago is the whole problem. */
function dgOverWords(days){
  const n = dgPickNum({d: days}, ['d']);
  if (n === null) return '';
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return n + ' days ago';
}
function dgCloseTable(rows, withButton){
  return '<table class="dg-table"><thead><tr><th>Client</th><th>Month</th><th>Calls</th><th>Ended</th>' +
    '<th>Refund if locked</th><th>At</th><th>' + (withButton ? '' : 'Waiting on') + '</th></tr></thead><tbody>' +
    rows.map(x =>
      '<tr><td>' + dgEsc(x.company) + '</td><td>' + dgEsc(x.monthNo === null ? DG_DASH : String(x.monthNo)) + '</td>' +
      '<td>' + dgEsc(dgShow(x.delivered) + ' of ' + dgShow(x.promised)) + '</td>' +
      '<td>' + dgEsc((dgNiceDate(x.endsOn) || DG_DASH) + (dgOverWords(x.daysOver) ? ' · ' + dgOverWords(x.daysOver) : '')) + '</td>' +
      '<td class="dg-amount">' + dgEsc(x.refundDue === null ? DG_DASH : dgUsd(x.refundDue)) + '</td>' +
      '<td>' + dgEsc(x.refundDue ? x.multiplierWords : DG_DASH) + '</td>' +
      '<td>' + (withButton
        ? dgLink('Lock month ' + (x.monthNo === null ? '' : x.monthNo), "dgLockMonth('" + dgEsc(String(x.monthId || '')) + "')", true)
        /* The reason first, then the override. The owner can always lock a month
           by hand — the engine declining to do it for him is not a veto. */
        : '<span class="dg-row-sub">' + dgEsc(x.whyNot || 'Something about this month needs a person.') + '</span> ' +
          dgLink('Open this client', "dgOpenClient('" + dgEsc(String(x.clientId || '')) + "')") + ' ' +
          dgLink('Lock it anyway', "dgLockMonth('" + dgEsc(String(x.monthId || '')) + "')")) +
      '</td></tr>').join('') +
    '</tbody></table>';
}
function dgRenderMonthEnd(data){
  const d = data || {};
  const months = Array.isArray(d.months) ? d.months : [];
  const held = Array.isArray(d.held) ? d.held : [];
  /* What closes a month, said once, on the screen that closes them. The owner
     should not have to guess whether anything is watching. */
  const how = d.engine
    ? 'Aviance closes these by itself, every hour. A month that has ended, has every call marked and was paid for locks on its own, raises its refund and puts it on your list. The ones below are what the clock will not decide for you.'
    : 'Nothing closes a month on its own yet — the month-end schedule is in a database update that has not been applied. Until it is, every month on this screen waits for the button beside it.';
  if (!months.length && !held.length) {
    return '<div class="dg-screen"><p class="dg-none">No month has ended and is waiting to be locked.</p>' +
      '<p class="dg-note-foot">' + dgEsc(how) + '</p>' + dgMissingLine(d.missing) + '</div>';
  }
  return '<div class="dg-screen">' +
    '<p class="dg-note-foot">' + dgEsc(how) + '</p>' +
    (months.length
      ? '<div class="dg-head"><h3>Ready to close</h3>' +
        '<span class="dg-sub">' + dgEsc('Locking a month is final. A short month raises its refund at the multiplier the finance side set: double in month one, that month in full after.') + '</span></div>' +
        dgCloseTable(months, true) +
        '<p class="dg-total">' + dgEsc(d.totalRefund === null || d.totalRefund === undefined
          ? 'The total refund is not known yet.'
          : 'Locking all of these would refund ' + dgUsd(d.totalRefund) + '.') + '</p>'
      : '<p class="dg-none">Nothing is ready to close by itself.</p>') +
    (held.length
      ? '<div class="dg-head"><h3>' + dgEsc('Ended, but not closing by itself') + '</h3>' +
        '<span class="dg-sub">' + dgEsc('These are over and still open. Aviance will not lock them on a guess — a month locked on the wrong number cannot be un-locked, and its refund cannot be raised twice. Clear what each one is waiting on and it closes within the hour.') + '</span></div>' +
        dgCloseTable(held, false) +
        '<p class="dg-total">' + dgEsc(d.heldRefund === null || d.heldRefund === undefined
          ? 'What these would refund is not known yet.'
          : 'As they stand these would refund ' + dgUsd(d.heldRefund) + '.') + '</p>'
      : '') +
    dgMissingLine(d.missing) + '</div>';
}

/* ---- the three screens, as the hub draws them --------------------- */

/* index.html routes 'home', 'friday' and 'monthEnd' here. A view function must
   return HTML at once, so each one hands back its host and then fills it from
   real queries. Nothing is drawn from a number held over from last time. */
const dg = {screen: 'home', drafts: [], needs: null, needsAt: 0};

function dgSkeleton(){ return '<div class="dg-screen" aria-busy="true"><p class="dg-none">Counting…</p></div>'; }
function dgHost(screen){
  dg.screen = screen;
  if (typeof document !== 'undefined' && document.getElementById) setTimeout(() => { dgMount(screen); }, 0);
  return '<div class="dg" id="dgHost" data-dg-screen="' + dgEsc(screen) + '">' + dgSkeleton() + '</div>';
}
function viewHome(){ return dgHost('home'); }
function viewFriday(){ return dgHost('friday'); }
function viewMonthEnd(){ return dgHost('monthEnd'); }

function dgPaint(html){
  if (typeof document === 'undefined' || !document.getElementById) return false;
  const host = document.getElementById('dgHost');
  if (host) host.innerHTML = html;
  return !!host;
}
async function dgMount(screen){
  dg.screen = screen || dg.screen;
  try {
    if (dg.screen === 'friday') {
      const r = await dgFridayAll();
      dg.drafts = r.ok && r.data ? (r.data.drafts || []) : [];
      dgPaint(dgRenderFriday(r.ok ? r.data : {drafts: [], missing: ['this week\'s drafts']}));
    } else if (dg.screen === 'monthEnd') {
      const r = await dgMonthClose();
      dgPaint(dgRenderMonthEnd(r.ok ? r.data : {months: [], missing: ['the month standings']}));
    } else {
      const r = await dgHome();
      if (r.ok) { dg.needs = dgNeedsCount(r.data); dg.needsAt = Date.now(); }
      dgPaint(dgRenderHome(r.ok ? r.data : {missing: ['everything — the database did not answer']}));
      if (dgHas('renderNav')) { try { renderNav(); } catch (e) { /* signed out */ } }
    }
  } catch (e) {
    dgPaint('<div class="dg-screen"><p class="dg-missing">Could not count that just now. Open it again in a moment.</p></div>');
  }
}

/* How many things on Today need a person. Counted from the rows the last load
   read — never a counter anyone writes to. Blank until Today has been opened. */
function dgNeedsCount(data){
  const d = data || {};
  return (Array.isArray(d.shortMonths) ? d.shortMonths.length : 0) + dgInt(d.openRequests) + dgInt(d.overdueTasks);
}
function dgNavCount(){
  return dg.needs === null || !dg.needs ? '' : String(dg.needs);
}

/* Links out to the rest of the hub. Every one of them is optional: an area that
   is not built yet says so instead of breaking this screen. */
function dgRender(view){
  if (dgHas('render')) { try { render(view); return true; } catch (e) { /* fall through */ } }
  return false;
}
function dgOpenClient(id){
  if (!id) return;
  if (dgHas('openClient')) { try { openClient(id); return; } catch (e) { /* fall through */ } }
  if (!dgRender('clients') && dgHas('toast')) toast('That screen is not in Aviance OS yet.');
}
function dgGo(what){
  const where = {requests: 'requests', tasks: 'work', money: 'billing', friday: 'friday', monthEnd: 'monthEnd', home: 'home'}[what];
  if (where && dgRender(where)) return true;
  /* no router (or that screen is not registered): draw it here instead */
  if (what === 'friday' || what === 'monthEnd' || what === 'home') { dgPaint(dgSkeleton()); dgMount(what); return true; }
  if (dgHas('toast')) toast('That screen is not in Aviance OS yet.');
  return false;
}
/* CLOSING a month is four steps — lock the verdict, raise the refund, open the
   next month, invoice it — and fnCloseMonth (finance.js) is the one place that
   does all four, with the two refusals a clock cannot make for itself: not at a
   3-month term boundary, and not for a client who has left. Use it when it is
   there, and fall back to locking alone when it is not, so this button keeps
   working on a build without it. Either way this screen writes no sequence of
   its own: the money side owns the order. */
async function dgLockMonth(monthId){
  if (!monthId) return;
  if (dgHas('fnCloseMonth')) {
    const c = await dgAsk('fnCloseMonth', monthId);
    /* fnCloseMonth refuses in a sentence the owner can act on — show it as it
       came, and do not then try to lock the month behind its back. */
    if (dgHas('toast')) toast(c.ok ? 'Month closed. Any refund it owes is raised, and the next month is opened and invoiced.' : c.error);
    dgMount('monthEnd');
    return;
  }
  if (!dgHas('fnLockMonth')) { if (dgHas('toast')) toast('The money side is not loaded, so nothing was locked.'); return; }
  const r = await dgAsk('fnLockMonth', monthId);
  if (dgHas('toast')) toast(r.ok ? 'Month locked. Any refund it owes is now raised.' : r.error);
  dgMount('monthEnd');
}
function dgCopyDraft(i){
  const d = dg.drafts[i];
  if (!d || !d.text) return;
  let text = d.text;
  if (typeof document !== 'undefined' && document.getElementById) {
    const box = document.getElementById('dgDraft' + i);
    if (box && typeof box.value === 'string' && box.value) text = box.value;   /* whatever the person edited */
  }
  try { navigator.clipboard.writeText(text); if (dgHas('toast')) toast('Copied. Paste it into their channel.'); }
  catch (e) { if (dgHas('toast')) toast('Could not copy it — select the text and copy it by hand.'); }
}
