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
async function fnStanding(opts){
  const o = opts || {};
  return fnRun(() => {
    let q = sb.from('v_month_standing').select('*');
    if (o.clientId) q = q.eq('client_id', o.clientId);
    if (o.openOnly) q = q.eq('verdict', 'open');
    return q.order('ends_on');
  }, []);
}

/* The clients who are behind with 10 days or less to go. The day-20 warning. */
async function fnBehind(){
  return fnRun(() => sb.from('v_month_standing').select('*')
    .eq('warn_now', true).order('days_left'), []);
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

/* ---- refunds ------------------------------------------------------ */

async function fnRefunds(status){
  return fnRun(() => {
    let q = sb.from('refunds').select('*').order('created_at', {ascending:false});
    if (status) q = q.eq('status', status);
    return q;
  }, []);
}

async function fnMarkRefundPaid(refundId, via){
  return fnRun(() => sb.from('refunds')
    .update({status:'paid', paid_at:new Date().toISOString(), paid_via:(via||'').slice(0,60)})
    .eq('id', refundId).select().single(), null);
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
