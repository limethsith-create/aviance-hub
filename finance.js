/* ===================== AVIANCE OS — Finance =====================
   The money. Everything here talks straight to Supabase through the
   shell's `sb` client.

   Schema: supabase/migrations/2026112209*_finance_*.sql
     plan_prices  clients  client_months  qualified_calls  invoices  refunds
     views:  v_month_standing  v_exposure  v_money  v_invoice_work
     rules:  open_next_month(client)  recount_month(month)
             lock_month(month)  raise_invoice(month, due_days)
             mark_paid(invoice, via)   paid, and the welcome email with their way in

   The rules live in the database on purpose. A verdict that decides a refund
   should not depend on which screen asked the question.

   Every function returns {ok, data, error} and never throws (same shape as
   channels-api.js). `error` is plain words, safe to show a person.
   ================================================================= */

/* ---- plumbing ---------------------------------------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const fnOk = coreOk;
const fnErr = coreErr;
const fnWrap = coreWrap;
/* A supabase result -> {ok,data,error}. Never throws. */
async function fnRun(fn, whenEmpty){
  try { return fnWrap(await fn(), whenEmpty); }
  catch (e) { return fnErr(e); }
}

/* ---- money, at a glance ------------------------------------------ */

/* The four numbers: invoiced and unpaid, paid this month, paid ever, refunds owed. */
async function fnMoney(){
  return fnRun(() => sb.from('v_money').select('*').maybeSingle(), null);
}

/* What we would owe if every open month ended today and missed. No cap is
   enforced — this only tells the truth about the risk. */
async function fnExposure(){
  return fnRun(() => sb.from('v_exposure').select('*').maybeSingle(), null);
}

/* ---- the plans on offer ------------------------------------------- */

/* Three plans, and only three. What each one costs lives in plan_prices. */
const FN_PLAN_WORDS = {starter:'Starter', growth:'Growth', scale:'Scale'};
const FN_PLANS = Object.keys(FN_PLAN_WORDS);
function fnPlanOffered(plan){ return FN_PLANS.includes(String(plan == null ? '' : plan).toLowerCase()) }

/* LEGACY GUARD, the only one in the owner's code. Rows written before a plan was
   withdrawn can still carry its code. That code is never sold, priced or named:
   every write refuses it with FN_RETIRED_SAYS and every screen shows FN_RETIRED_WORD.
   clientbook.js, pipeline.js, meetings.js and onboarding.js all ask fnPlanRetired. */
const FN_RETIRED_PLANS = ['pilot'];
const FN_RETIRED_WORD = 'Retired plan';
const FN_RETIRED_SAYS = 'That plan is retired. Pick Starter, Growth or Scale.';
function fnPlanRetired(plan){ return FN_RETIRED_PLANS.includes(String(plan == null ? '' : plan).toLowerCase()) }

/* "growth" -> "Growth". A retired code reads "Retired plan"; anything else is ''. */
function fnPlanWord(plan){
  if (fnPlanRetired(plan)) return FN_RETIRED_WORD;
  return FN_PLAN_WORDS[String(plan == null ? '' : plan).toLowerCase()] || '';
}

/* ---- clients and their months ------------------------------------ */

/* The price list: the plans on offer, cheapest first. A row for any other plan
   code is left out, so nothing can price or pick it. */
async function fnPlans(){
  const r = await fnRun(() => sb.from('plan_prices').select('*').order('monthly_fee'), []);
  if (!r.ok) return r;
  return fnOk((Array.isArray(r.data) ? r.data : []).filter(p => p && fnPlanOffered(p.plan)));
}

async function fnClients(stage){
  return fnRun(() => {
    let q = sb.from('clients').select('*').order('created_at', {ascending:false});
    if (stage) q = q.eq('stage', stage);
    return q;
  }, []);
}

/* Every month of every client: promised, delivered, days left, what is at risk. */
/* One row per client-month, so this grows for ever. A read with no range is answered
   out of one page (1,000 rows — about 83 clients at a year each) and says nothing
   when it is short: months would simply stop arriving, and every total built on them
   — the commitment board, the money screen — would quietly go down. So it is read a
   page at a time until a short page, and if the book ever outgrows the ceiling it
   FAILS with a sentence rather than returning part of the answer as the whole. */
const FN_STANDING_PAGE = 1000;
const FN_STANDING_MAX_PAGES = 20;
async function fnStanding(opts){
  const o = opts || {};
  const all = [];
  try {
    for (let i = 0; i < FN_STANDING_MAX_PAGES; i++) {
      let q = sb.from('v_month_standing').select('*');
      if (o.clientId) q = q.eq('client_id', o.clientId);
      if (o.openOnly) q = q.eq('verdict', 'open');
      q = q.order('ends_on');
      const canPage = q && typeof q.range === 'function';
      if (canPage) q = q.range(i * FN_STANDING_PAGE, i * FN_STANDING_PAGE + FN_STANDING_PAGE - 1);
      const r = fnWrap(await q, []);
      if (!r.ok) return r;
      const rows = Array.isArray(r.data) ? r.data : [];
      for (const row of rows) all.push(row);
      if (!canPage || rows.length < FN_STANDING_PAGE) return fnWrap({ data: all, error: null }, []);
    }
    return fnErr('There are more months on the books than this screen can read in one go, so it is not showing a part of them as the whole. Tell whoever looks after Aviance OS.');
  } catch (e) { return fnErr(e); }
}

/* ---- the month clock --------------------------------------------- */

/* Open the next month: the one after the last month this client has. NOT safe to call twice. */
async function fnOpenMonth(clientId){
  return fnRun(() => sb.rpc('open_next_month', {p_client: clientId}), null);
}

/* Recount a month from its calls. Does nothing to a locked month. */
async function fnRecount(monthId){
  return fnRun(() => sb.rpc('recount_month', {p_month: monthId}), 0);
}

/* Lock the verdict. If we missed, this raises the refund — double in month one,
   that month in full after. Safe to call twice: it will not refund twice. */
async function fnLockMonth(monthId){
  return fnRun(() => sb.rpc('lock_month', {p_month: monthId}), null);
}

/* ---- calls that count -------------------------------------------- */

/* THE RULE BEHIND EVERY WRITE BELOW. `qualified_calls.counts` is a generated
   column, so it is right the instant the row changes. `client_months.calls_
   delivered` is NOT: nothing in the database recounts it on its own — there is
   no trigger on qualified_calls. Only call_verdict(), lock_month() and an
   explicit recount_month() move it. So a write straight to a call leaves the
   month saying a number its own calls no longer add up to, and every screen,
   the client's portal, the exposure total and the day-20 warning read the month.
   Checked live on 2026-11-26: a direct update that made a call count left
   client_months.calls_delivered at 0 while the calls behind it said 1.
   Every write here therefore recounts afterwards. Prefer call_verdict() (the
   rpc) when you are answering "did they show up?" — it does all of this inside
   one database call and refuses a locked month. */

/* Every month of a client that a call at this instant could belong to, recounted.
   The month's edges are US dates and this is a UTC instant, so the window is
   widened by a day at each end; recount_month is idempotent, counts by its own
   date window and does nothing to a locked month, so one month too many is free. */
async function fnRecountAround(clientId, whenIso){
  if (!clientId || !whenIso) return fnOk(0);
  const t = coreToDate(whenIso);
  if (!t) return fnOk(0);
  const day = n => new Date(t.getTime() + n * 86400000).toISOString().slice(0,10);
  const got = await fnRun(() => sb.from('client_months').select('id')
    .eq('client_id', clientId).is('locked_at', null)
    .lte('starts_on', day(1)).gte('ends_on', day(-1)), []);
  if (!got.ok) return got;
  const rows = Array.isArray(got.data) ? got.data : [];
  let done = 0;
  /* One month in all but a boundary case, so this is one round trip in practice. */
  for (const m of rows) { if (m && m.id && (await fnRecount(m.id)).ok) done++; }
  return fnOk(done);
}
/* The month(s) a call row touches, recounted. Safe to call with a failed read. */
function fnRecountForCall(row){
  const r = row || {};
  return fnRecountAround(r.client_id, r.happened_at || r.booked_for);
}

/* A call only counts when it matches the profile AND actually happened. */
async function fnLogCall(clientId, call){
  const c = call || {};
  const r = await fnRun(() => sb.from('qualified_calls').insert({
    client_id:        clientId,
    prospect_name:    c.name    || null,
    prospect_email:   c.email   || null,
    prospect_company: c.company || null,
    booked_for:       c.bookedFor,
    matched_icp:      c.matchedIcp === false ? false : true,
    happened:         !!c.happened,
    happened_at:      c.happened ? (c.happenedAt || c.bookedFor) : null
  }).select().single(), null);
  if (r.ok && r.data && r.data.counts) await fnRecountForCall(r.data);
  return r;
}

/* They turned up. This is what moves the month's number. */
async function fnCallHappened(callId, whenIso){
  const r = await fnRun(() => sb.from('qualified_calls')
    .update({happened:true, happened_at: whenIso || new Date().toISOString()})
    .eq('id', callId).select().single(), null);
  if (r.ok) await fnRecountForCall(r.data);
  return r;
}

/* The client says a call should not count. Held aside until you decide. */
async function fnDisputeCall(callId, reason){
  const r = await fnRun(() => sb.from('qualified_calls')
    .update({dispute_status:'raised', dispute_reason: (reason||'').slice(0,600)})
    .eq('id', callId).select().single(), null);
  if (r.ok) await fnRecountForCall(r.data);
  return r;
}

/* You decide. 'upheld' = it does not count. 'rejected' = it stands. */
async function fnSettleDispute(callId, outcome){
  const o = outcome === 'upheld' ? 'upheld' : 'rejected';
  const r = await fnRun(() => sb.from('qualified_calls')
    .update({dispute_status:o}).eq('id', callId).select().single(), null);
  if (r.ok) await fnRecountForCall(r.data);
  return r;
}

async function fnCalls(clientId, monthId){
  return fnRun(() => {
    let q = sb.from('qualified_calls').select('*').eq('client_id', clientId);
    if (monthId) q = q.eq('month_id', monthId);
    return q.order('booked_for', {ascending:false});
  }, []);
}

/* ---- invoices ----------------------------------------------------- */

/* Raise the invoice for a month. A month that is already invoiced returns its
   existing invoice; a 3-month term only bills on months 1, 4, 7 and returns
   null in between. */
async function fnRaiseInvoice(monthId, dueDays){
  return fnRun(() => sb.rpc('raise_invoice',
    {p_month: monthId, p_due_days: Number.isFinite(dueDays) ? dueDays : 0}), null);
}

/* Invoices to send, and payments to chase. */
async function fnInvoiceWork(){
  return fnRun(() => sb.from('v_invoice_work').select('*').order('issued_on'), []);
}

async function fnInvoices(clientId){
  return fnRun(() => {
    let q = sb.from('invoices').select('*').order('issued_on', {ascending:false});
    if (clientId) q = q.eq('client_id', clientId);
    return q;
  }, []);
}

async function fnMarkInvoiceSent(invoiceId){
  return fnRun(() => sb.from('invoices')
    .update({status:'sent', sent_at:new Date().toISOString()})
    .eq('id', invoiceId).select().single(), null);
}

/* Paid. This goes through the database rule, not a table update, because being
   paid does more than change a word: the first time a client pays, the rule
   makes their invite and queues the welcome email with their way in.
   -> {invoice_id, client_id, welcome_sent} */
async function fnMarkInvoicePaid(invoiceId, via){
  if (!invoiceId) return fnErr('Pick the invoice first.');
  const how = String(via || '').trim().slice(0,60);
  return fnRun(() => sb.rpc('mark_paid', {p_invoice: invoiceId, p_via: how || null}), null);
}
/* What to tell the person who clicked Paid. */
function fnPaidWords(data){
  return data && data.welcome_sent === true
    ? 'Paid. The welcome email and their way in are on their way.'
    : 'Marked paid.';
}

/* ---- how late a payment is ---------------------------------------- */

/* Nothing in the database ages an invoice. `invoices.status` has 'overdue' in
   its CHECK constraint and NO code, trigger or job ever writes it: checked live
   on 2026-11-27, every unpaid invoice is still 'draft' or 'sent'. So "how late
   is this" is worked out here, from the due date, every time it is asked. That
   is on purpose — a status word that has to be swept by a cron job goes stale
   the moment the job misses a run, and a date never does. */

/* An invoice nobody has settled yet. Void is owed by nobody; paid is done.
   `paid_at` is believed as readily as the word, because mark_paid() sets both
   and a row half-written by hand must not read as unpaid. */
const FN_INVOICE_DEAD = ['void', 'cancelled', 'canceled'];
function fnInvoicePaid(row){ const r = row || {}; return !!(r.paid_at || String(r.status || '') === 'paid') }
function fnInvoiceDead(row){ return FN_INVOICE_DEAD.includes(String((row || {}).status || '')) }
function fnInvoiceOwed(row){ return !!row && !fnInvoicePaid(row) && !fnInvoiceDead(row) }
/* Raised but never sent. The client has not been ASKED for this money, so it is
   not late — it is stuck on our side, which is worse and reads differently. */
function fnInvoiceUnsent(row){
  const r = row || {};
  return fnInvoiceOwed(r) && !r.sent_at && String(r.status || '') === 'draft';
}

/* How many days past its due date, in the reader's own calendar. null when the
   invoice has no due date — which is not 0 days late, and must never read as it. */
function fnDaysLate(dueOn, today){
  const due = coreToDate(dueOn);
  if (!due) return null;
  const now = coreToDate(today) || new Date();
  const a = Date.parse(coreDayKey(due) + 'T00:00:00Z'), b = Date.parse(coreDayKey(now) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/* The bands the owner reads the list in. One pass, worst first. */
const FN_AGE_BANDS = [
  {key:'over30', label:'Over 30 days late', from:31,  to:Infinity, tone:'red'},
  {key:'late30', label:'8 to 30 days late', from:8,   to:30,       tone:'red'},
  {key:'late7',  label:'Up to a week late', from:1,   to:7,        tone:'amber'},
  {key:'duenow', label:'Due today',         from:0,   to:0,        tone:'amber'},
  {key:'soon',   label:'Not due yet',       from:-Infinity, to:-1, tone:'grey'},
];
const FN_AGE_UNKNOWN = {key:'nodate', label:'No due date', tone:'amber'};
function fnAgeBand(daysLate){
  if (daysLate == null || !Number.isFinite(Number(daysLate))) return FN_AGE_UNKNOWN;
  const d = Number(daysLate);
  return FN_AGE_BANDS.find(b => d >= b.from && d <= b.to) || FN_AGE_UNKNOWN;
}

/* One invoice, in a sentence the owner can act on. */
function fnOwedLine(row, today){
  const r = row || {};
  const who = String(r.company || r.client_name || 'A client');
  const amt = fnUsd(r.amount);
  if (fnInvoiceUnsent(r)) return `${who} — ${amt} raised and never sent. Nobody has asked them for it.`;
  const late = fnDaysLate(r.due_on, today);
  if (late == null) return `${who} — ${amt} owed, with no due date on the invoice.`;
  if (late > 0)  return `${who} — ${amt}, ${late} day${late === 1 ? '' : 's'} late.`;
  if (late === 0) return `${who} — ${amt}, due today.`;
  return `${who} — ${amt}, due in ${-late} day${late === -1 ? '' : 's'}.`;
}

/* Every unpaid invoice, banded. Pure: hand it rows, get the owner's screen.
   `rows` may be invoices, v_invoice_work rows, or the two merged. */
function fnAgeInvoices(rows, today){
  const list = (Array.isArray(rows) ? rows : []).filter(fnInvoiceOwed);
  const seen = {};
  const bands = FN_AGE_BANDS.concat([FN_AGE_UNKNOWN]).map(b => ({key:b.key, label:b.label, tone:b.tone, total:0, rows:[]}));
  const byKey = {}; bands.forEach(b => { byKey[b.key] = b });
  let total = 0, lateTotal = 0, lateCount = 0, unsentTotal = 0, oldest = 0;
  list.forEach(r => {
    const id = String(r.id == null ? '' : r.id);
    if (id && seen[id]) return;          /* the same invoice from both reads */
    if (id) seen[id] = true;
    const late = fnDaysLate(r.due_on, today);
    const band = byKey[fnAgeBand(late).key];
    const amt = fnCount(r.amount);
    const one = Object.assign({}, r, {daysLate: late, band: band.key, line: fnOwedLine(r, today), unsent: fnInvoiceUnsent(r)});
    band.rows.push(one); band.total += amt; total += amt;
    if (one.unsent) unsentTotal += amt;
    if (late != null && late > 0) { lateTotal += amt; lateCount += 1; if (late > oldest) oldest = late; }
  });
  bands.forEach(b => b.rows.sort((a, c) => (c.daysLate == null ? -1e9 : c.daysLate) - (a.daysLate == null ? -1e9 : a.daysLate)));
  return {bands: bands.filter(b => b.rows.length), total, lateTotal, lateCount, unsentTotal, oldest, count: Object.keys(seen).length};
}

/* Who owes us money, worst first. One read of the invoices and one of
   v_invoice_work, because only the view carries the company name. */
async function fnOwed(today){
  const [inv, work] = await Promise.all([fnInvoices(), fnInvoiceWork()]);
  if (!inv.ok && !work.ok) return inv;
  const byId = {};
  (work.ok ? work.data || [] : []).forEach(w => { if (w && w.id) byId[w.id] = w });
  const rows = (inv.ok ? inv.data || [] : []).map(r => {
    const w = byId[r.id];
    return w ? Object.assign({}, r, {company: w.company}) : r;
  });
  /* The invoices themselves are the source. v_invoice_work is read only for the
     company name, and its rows are used INSTEAD only when the invoices could not
     be read at all — a view row carries no amount and no sent_at, so ageing it
     as if it were an invoice invents a $0 line with no due date. An empty
     invoices table is not a failure: it means nothing is owed. */
  const aged = fnAgeInvoices(inv.ok ? rows : (work.ok ? work.data || [] : []).filter(w => w && w.id), today);
  return fnOk(Object.assign(aged, {trouble: [inv.ok ? '' : inv.error, work.ok ? '' : work.error].filter(Boolean)}));
}

/* ---- refunds: owed, then actually paid ---------------------------- */

/* THE GAP THIS CLOSES. lock_month() writes one `refunds` row with
   status = 'owed' and stops. Until 2026-11-27 `fnMarkRefundPaid` below was
   called by nothing at all — no screen, no button — so a refund the guarantee
   had raised could never be closed, and four live rows totalling $16,500 had
   sat at 'owed' since the day they were raised. The guarantee IS the product;
   the part where the client gets their money back cannot be a row nobody can
   reach. See supabase/migrations/20261209_refunds_paid.sql.

   No amount is worked out here. `refunds.amount` is written by lock_month(),
   and what the owner types is checked against it, never replaced by it. */

const FN_REFUND_WORDS = {owed: 'Owed', paid: 'Paid', waived: 'Set aside'};
const FN_REFUND_METHODS = ['bank transfer', 'Wise', 'Payoneer', 'PayPal', 'card refund'];
const FN_REFUND_MAX_VIA = 60;
const FN_REFUND_MAX_REF = 120;

function fnRefundState(row){
  const s = String((row || {}).status || 'owed').toLowerCase();
  return FN_REFUND_WORDS[s] ? s : 'owed';
}
/* What is still owed on this row. A part payment leaves the rest owed: the
   promise is `amount`, the fact is `paid_amount`, and the difference is money
   the client has not had. A database without paid_amount reads a paid row as
   paid in full, which is what it meant before the column existed. */
function fnRefundStillOwed(row){
  const r = row || {};
  const owed = fnCount(r.amount);
  if (fnRefundState(r) === 'waived') return 0;
  if (fnRefundState(r) === 'owed') return owed;
  const paid = r.paid_amount == null ? owed : fnCount(r.paid_amount);
  return Math.max(0, owed - paid);
}
function fnRefundPartPaid(row){
  return fnRefundState(row) === 'paid' && fnRefundStillOwed(row) > 0;
}
/* One refund, in a sentence. The owner's words; the client's are in
   portal-client.js and say less. */
function fnRefundLine(row){
  const r = row || {};
  const who = String(r.company || r.client_name || 'A client');
  const month = r.month_no == null ? '' : ` month ${fnCount(r.month_no)}`;
  const amt = fnUsd(r.amount);
  const state = fnRefundState(r);
  if (state === 'waived') return `${who} —${month || ''} ${amt} set aside.`;
  if (state === 'paid') {
    const how = String(r.paid_via || '').trim();
    const when = r.paid_at ? coreDayKey(r.paid_at) : '';
    const ref = String(r.paid_reference || '').trim();
    const rest = fnRefundStillOwed(r);
    return `${who} —${month ? month + ':' : ''} ${fnUsd(r.paid_amount == null ? r.amount : r.paid_amount)} sent`
      + (how ? ` by ${how}` : '') + (when ? ` on ${when}` : '') + (ref ? ` (ref ${ref})` : '') + '.'
      + (rest > 0 ? ` ${fnUsd(rest)} of it is still owed.` : '');
  }
  return `${who} — we owe them ${amt}${month ? ' for' + month : ''}. Not sent yet.`;
}

/* '' when the entry is fine, otherwise what to fix. Checked here as well as in
   the database so the owner is told before a round trip, and the database still
   refuses if this is ever bypassed. */
function fnRefundProblem(row, entry){
  const r = row || {}, e = entry || {};
  if (!r.id) return 'Pick the refund first.';
  if (fnRefundState(r) === 'paid') return 'That refund is already marked paid.';
  if (fnRefundState(r) === 'waived') return 'That refund was set aside, so it cannot be paid.';
  const owed = fnCount(r.amount);
  const raw = e.amount === '' || e.amount == null ? owed : Number(e.amount);
  if (!Number.isFinite(raw)) return 'Write the amount you sent as a number.';
  const amount = Math.round(raw);
  if (amount <= 0) return 'Say how much was sent back.';
  if (amount > owed) return `That is more than we owe. We owe ${fnUsd(owed)}.`;
  if (!String(e.via || '').trim()) return 'Say how it was sent — bank transfer, Wise, Payoneer.';
  if (String(e.via || '').trim().length > FN_REFUND_MAX_VIA) return 'Shorten how it was sent.';
  if (String(e.reference || '').trim().length > FN_REFUND_MAX_REF) return 'That reference is too long.';
  if (e.on && !coreToDate(e.on)) return 'That is not a date we can read. Use the date picker.';
  return '';
}

async function fnRefunds(status){
  return fnRun(() => {
    let q = sb.from('refunds').select('*').order('created_at', {ascending:false});
    if (status) q = q.eq('status', status);
    return q;
  }, []);
}

/* Every refund with the client's name and the month beside it, because a row
   that says what we owe and not who to is useless at 2am. The client list
   is read once for the whole lot, not once per refund. */
async function fnRefundsForScreen(){
  const [rf, cl, ms] = await Promise.all([fnRefunds(), fnClients(), fnStanding()]);
  if (!rf.ok) return rf;
  const who = {}; (cl.ok ? cl.data || [] : []).forEach(c => { if (c && c.id) who[c.id] = c });
  const month = {}; (ms.ok ? ms.data || [] : []).forEach(m => { if (m && m.month_id) month[m.month_id] = m });
  const rows = (rf.data || []).map(r => {
    const c = who[r.client_id] || {};
    const m = month[r.month_id] || {};
    return Object.assign({}, r, {
      company: c.company || '', plan: c.plan || '', term: c.term || '',
      client_ended_on: c.ended_on || null,
      month_no: r.month_no == null ? (m.month_no == null ? null : m.month_no) : r.month_no,
      state: fnRefundState(r), still_owed: fnRefundStillOwed(r), line: fnRefundLine(Object.assign({}, r, {company: c.company, month_no: m.month_no})),
    });
  });
  const owed = rows.filter(r => r.state === 'owed' || fnRefundPartPaid(r));
  return fnOk({
    rows,
    owed,
    owedTotal: owed.reduce((s, r) => s + fnRefundStillOwed(r), 0),
    paidTotal: rows.filter(r => r.state === 'paid').reduce((s, r) => s + fnCount(r.paid_amount == null ? r.amount : r.paid_amount), 0),
    /* a refund owed on a client who has already left: the row stays owed, and
       the client is gone from every "live clients" list there is */
    gone: owed.filter(r => r.client_ended_on),
    trouble: [cl.ok ? '' : cl.error, ms.ok ? '' : ms.error].filter(Boolean),
  });
}

/* Record that a refund was actually sent. The database rule is tried first,
   because this is money and the rule refuses what this file would only warn
   about. A database without the rule yet (it is in a migration the owner has
   not run) is written to directly, with the same checks, and the extra two
   facts kept in `notes` so nothing the owner typed is lost.
   opts = {amount, via, reference, on} — or a plain string, which is the method,
   so the old two-argument call still works. */
async function fnMarkRefundPaid(refundId, opts){
  const e = typeof opts === 'string' || opts == null ? {via: opts || ''} : opts;
  const got = await fnRun(() => sb.from('refunds').select('*').eq('id', refundId).maybeSingle(), null);
  if (!got.ok) return got;
  if (!got.data) return fnErr('That refund is not here any more.');
  const bad = fnRefundProblem(got.data, e);
  if (bad) return fnErr(bad);

  const amount = Math.round(e.amount === '' || e.amount == null ? fnCount(got.data.amount) : Number(e.amount));
  const via = String(e.via || '').trim().slice(0, FN_REFUND_MAX_VIA);
  const ref = String(e.reference || '').trim().slice(0, FN_REFUND_MAX_REF);
  const when = e.on ? coreToDate(e.on) : null;

  const viaRpc = await fnRun(() => sb.rpc('refund_pay', {
    p_refund: refundId, p_amount: amount, p_via: via,
    p_reference: ref || null, p_on: when ? coreDayKey(when) : null,
  }), null);
  if (viaRpc.ok) return viaRpc;
  if (coreFamily(viaRpc.error) !== 'not-ready') return viaRpc;

  /* no rule in this database yet — write the row, keep every fact */
  const note = [String(got.data.notes || '').trim(),
    `Paid ${fnUsd(amount)}${via ? ' by ' + via : ''}${ref ? ' (ref ' + ref + ')' : ''}.`,
    amount < fnCount(got.data.amount) ? `${fnUsd(fnCount(got.data.amount) - amount)} of it is still owed.` : '',
  ].filter(Boolean).join(' ').slice(0, 2000);
  const wrote = await fnRun(() => sb.from('refunds').update({
    status: 'paid', paid_at: (when || new Date()).toISOString(), paid_via: via, notes: note,
  }).eq('id', refundId).select().single(), null);
  if (!wrote.ok) return wrote;
  return fnOk(Object.assign({}, wrote.data, {partial_record: true}));
}

/* What to tell the person who clicked it. */
function fnRefundPaidWords(data){
  const d = data || {};
  const rest = fnRefundStillOwed(d);
  return (rest > 0 ? `Recorded. ${fnUsd(rest)} of it is still owed.` : 'Recorded. That refund is settled.')
    + (d.partial_record ? ' The amount and reference are in the notes until the database update is applied.' : '');
}

/* ---- what we took in against what we owe back --------------------- */

/* Nothing anywhere reconciled these two. Invoices summed one way, refunds
   summed another, and v_money shows them as two separate totals that are never
   compared for ONE client. A prepaid 3-month term can honestly promise back
   more than it ever took in — 2x the month in month one plus 1x in each of
   months two and three is four months' fee against the three that were paid —
   and no screen noticed. This adds up the database's own figures and says so;
   it works out no refund of its own. */
function fnReconcile(invoices, refunds, client){
  const c = client || {};
  const paidIn = (Array.isArray(invoices) ? invoices : [])
    .filter(fnInvoicePaid).reduce((s, r) => s + fnCount(r.amount), 0);
  const list = Array.isArray(refunds) ? refunds : [];
  const owed = list.reduce((s, r) => s + fnRefundStillOwed(r), 0);
  const sent = list.filter(r => fnRefundState(r) === 'paid')
    .reduce((s, r) => s + fnCount(r.paid_amount == null ? r.amount : r.paid_amount), 0);
  const back = owed + sent;
  return {
    clientId: c.id || null, company: c.company || '', plan: c.plan || '', term: c.term || '',
    paidIn, refundsOwed: owed, refundsPaid: sent, refundsTotal: back, overBy: back - paidIn,
    over: back > paidIn,
  };
}

/* The same question for every client, in three reads rather than three a client. */
async function fnMoneyBack(){
  const [inv, rf, cl] = await Promise.all([fnInvoices(), fnRefunds(), fnClients()]);
  if (!cl.ok) return cl;
  if (!inv.ok) return inv;
  if (!rf.ok) return rf;
  const byClient = (rows, key) => {
    const out = {};
    (rows || []).forEach(r => { if (r && r[key]) (out[r[key]] = out[r[key]] || []).push(r) });
    return out;
  };
  const iv = byClient(inv.data, 'client_id'), re = byClient(rf.data, 'client_id');
  const rows = (cl.data || []).map(c => fnReconcile(iv[c.id] || [], re[c.id] || [], c))
    .filter(r => r.paidIn > 0 || r.refundsTotal > 0);
  return fnOk({rows, over: rows.filter(r => r.over), owedTotal: rows.reduce((s, r) => s + r.refundsOwed, 0)});
}

/* A locked month that says it owes a refund but has no refund row behind it.
   This is live today: RH4 Locked Month's month one carries a refund figure of
   twice the Growth monthly fee and verdict 'missed', and there is no `refunds`
   row for it — a month locked by a direct write rather than by lock_month().
   (No price is written here: finance.js never holds one.) The owner would never find it, and
   a client would never be paid. Pure; it only compares the two. */
function fnRefundGaps(months, refunds){
  const byMonth = {};
  (Array.isArray(refunds) ? refunds : []).forEach(r => { if (r && r.month_id) byMonth[r.month_id] = r });
  return (Array.isArray(months) ? months : []).filter(m => {
    if (!m || !m.month_id && !m.id) return false;
    if (String(m.verdict || '') !== 'missed') return false;
    if (fnCount(m.refund_due) <= 0) return false;
    return !byMonth[m.month_id || m.id];
  }).map(m => ({
    monthId: m.month_id || m.id, clientId: m.client_id || null, company: m.company || '',
    monthNo: fnCount(m.month_no), amount: fnCount(m.refund_due),
  }));
}

/* ---- closing a month, and the month after it ---------------------- */

/* WHAT HAPPENS TODAY, CHECKED: nothing opens month two. `open_next_month` is
   reached from this file only, `fnOpenMonth` is called only by
   fnStartSending's fallback, and there is no trigger and no cron job that opens
   a month (the one hourly job, journey_hourly, only chases staff approvals).
   So a client's month one ends, Month end locks it, and the clock stops: no
   month two, no month-two invoice, no month-two guarantee. Revenue stops after
   one month and no screen says so.

   fnCloseMonth is the loop: lock the month the database's way, then open the
   next one and raise its invoice — EXCEPT where the answer is not settled, and
   there it refuses in words rather than guessing. */

/* Which months a term bills on. A monthly term bills every month; a 3-month
   term bills months 1, 4, 7 … and raise_invoice returns null in between.
   This mirrors raise_invoice; it does not decide anything raise_invoice does
   not already do. */
function fnTermCovers(client){ return String((client || {}).term || 'monthly') === '3month' ? 3 : 1 }
function fnBillsOnMonth(client, monthNo){
  const n = fnCount(monthNo);
  return n >= 1 && (n - 1) % fnTermCovers(client) === 0;
}

/* THE QUESTION THE OWNER HAS NOT ANSWERED. A 3-month prepay reaches month four
   and the contract and the system disagree about whether that is a new term.
   Checked on the live functions inside a rolled-back transaction on 2026-11-27:
   open_next_month opens month 4 without complaint, and raise_invoice(month 4)
   raises a NEW invoice for 3 x the discounted monthly fee, noted
   "Months 4-6, 3-month term." So the DATABASE already believes a 3-month term
   rolls into another one at the same discount, for ever. Nothing in the browser
   can get there, because nothing opens month two in the first place. That is
   half of each answer, which is the one thing we must not ship.

   Until the owner says, this refuses and asks. It does not pick. */
function fnRenewalDecision(client, nextMonthNo){
  const c = client || {};
  const n = fnCount(nextMonthNo);
  if (fnTermCovers(c) === 1 || !fnBillsOnMonth(c, n) || n <= 1) return {decide: false, question: ''};
  const fee = fnUsd(fnCount(c.monthly_fee) * 3);
  return {decide: true, monthNo: n, question:
    `${c.company || 'This client'} is on a 3-month term and month ${n} starts a new one. `
    + `Aviance OS would raise ${fee} for months ${n} to ${n + 2} at the 3-month price. `
    + `Nobody has said whether a 3-month client is billed again at month ${n}, so nothing has been raised. `
    + `Decide it once in Settings and this stops asking.`};
}

/* Lock a month, then keep the clock running: open the next month and raise its
   invoice if that month bills. Every step is the database's; this only puts
   them in order and stops where the answer is not known.
   -> {month, opened, invoice, decide, says} */
async function fnCloseMonth(monthId){
  if (!monthId) return fnErr('Pick the month first.');
  const locked = await fnLockMonth(monthId);
  if (!locked.ok) return locked;
  const m = locked.data || {};
  if (!m.client_id || !m.month_no) return fnOk({month: m, opened: null, invoice: null, decide: null,
    says: 'The month is locked. Aviance OS could not tell which client it belongs to, so no next month was opened.'});

  const cl = await fnRun(() => sb.from('clients').select('*').eq('id', m.client_id).maybeSingle(), null);
  if (!cl.ok) return fnOk({month: m, opened: null, invoice: null, decide: null,
    says: 'The month is locked. We could not read the client, so no next month was opened: ' + cl.error});
  const c = cl.data || {};
  if (c.ended_on || String(c.stage || '') === 'ended') return fnOk({month: m, opened: null, invoice: null, decide: null,
    says: 'The month is locked. They have left, so no new month was opened.'});

  const next = fnCount(m.month_no) + 1;
  const have = await fnRun(() => sb.from('client_months').select('id,month_no')
    .eq('client_id', m.client_id).eq('month_no', next).maybeSingle(), null);
  if (!have.ok) return fnOk({month: m, opened: null, invoice: null, decide: null,
    says: 'The month is locked. We could not check whether month ' + next + ' is already open: ' + have.error});

  const decision = fnRenewalDecision(c, next);
  if (!have.data && decision.decide) {
    return fnOk({month: m, opened: null, invoice: null, decide: decision,
      says: 'Month ' + fnCount(m.month_no) + ' is locked. ' + decision.question});
  }

  let opened = have.data || null;
  if (!opened) {
    const o = await fnOpenMonth(m.client_id);
    if (!o.ok) return fnOk({month: m, opened: null, invoice: null, decide: null,
      says: 'The month is locked, but month ' + next + ' could not be opened: ' + o.error});
    opened = o.data || null;
    /* open_next_month opens the month after the LAST one, so a client who
       already has a later month gets that one instead. The check below says so
       rather than calling whatever came back "the next month". */
  }
  if (!opened || fnCount(opened.month_no) !== next) {
    return fnOk({month: m, opened, invoice: null, decide: null,
      says: 'Month ' + fnCount(m.month_no) + ' is locked. Month ' + next + ' was already there.'});
  }

  if (!fnBillsOnMonth(c, next)) return fnOk({month: m, opened, invoice: null, decide: null,
    says: 'Month ' + fnCount(m.month_no) + ' is locked and month ' + next + ' is open. It is inside a term that is already paid, so there is nothing to bill.'});

  const inv = await fnRaiseInvoice(opened.id, 7);
  if (!inv.ok) return fnOk({month: m, opened, invoice: null, decide: null,
    says: 'Month ' + fnCount(m.month_no) + ' is locked and month ' + next + ' is open, but its invoice could not be raised: ' + inv.error});
  return fnOk({month: m, opened, invoice: inv.data || null, decide: null,
    says: inv.data
      ? 'Month ' + fnCount(m.month_no) + ' is locked, month ' + next + ' is open, and ' + fnUsd(inv.data.amount) + ' is raised as a draft. Send it from Invoices.'
      : 'Month ' + fnCount(m.month_no) + ' is locked and month ' + next + ' is open. Nothing to bill for it.'});
}

/* ---- starting a client -------------------------------------------- */

/* Sending started. This sets the anchor the whole month clock hangs off,
   then opens month one. */
async function fnStartSending(clientId, day1){
  const d = day1 || new Date().toISOString().slice(0,10);
  const up = await fnRun(() => sb.from('clients')
    .update({day1_on:d, stage:'live'}).eq('id', clientId).select().single(), null);
  if (!up.ok) return up;
  /* The database opens month one itself the moment day1_on is first set (clients_first_month), and
     ties the first invoice to it. Calling open_next_month here as well would open month TWO, because
     it always opens the month after the last one. So read month one back, and only open it from here
     if the database did not (an older database without the trigger). */
  const got = await fnRun(() => sb.from('client_months').select('*')
    .eq('client_id', clientId).eq('month_no', 1).maybeSingle(), null);
  if (got.ok && got.data) return fnOk({client: up.data, month: got.data});
  const m = await fnOpenMonth(clientId);
  if (!m.ok) return m;
  return fnOk({client: up.data, month: m.data});
}

/* ---- money, in words ---------------------------------------------- */

/* Whole dollars, grouped, with a dollar sign — from core.js. */
const fnUsd = coreUsd;

/* One plain sentence for a month, the same words on your screen and theirs.
   A number the view did not send is read as 0, and a missing day count says so
   in words: a client must never read "undefined of undefined" or "null days left". */
const fnCount = n => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : 0);
function fnMonthLine(row){
  if (!row) return '';
  const no = fnCount(row.month_no), got = fnCount(row.calls_delivered), want = fnCount(row.calls_promised);
  if (row.verdict === 'hit')    return `Month ${no}: hit — ${got} of ${want} calls.`;
  if (row.verdict === 'missed') return `Month ${no}: missed — ${got} of ${want}. ${fnUsd(row.refund_due)} refunded.`;
  if (row.verdict === 'waived') return `Month ${no}: set aside.`;
  const left = Number(row.days_left);
  const when = !Number.isFinite(left) ? 'the month is still running'
    : left < 0 ? 'the month has ended' : left === 0 ? 'last day' : `${left} day${left===1?'':'s'} left`;
  return `Month ${no}: ${got} of ${want} calls, ${when}.`;
}
