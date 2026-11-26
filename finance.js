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

function fnOk(data){ return {ok:true, data, error:''} }
function fnErr(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return {ok:false, data:null, error:m};
}
/* A supabase result -> {ok,data,error}. Never throws. */
function fnWrap(res, whenEmpty){
  if (!res) return fnErr('No answer from the database.');
  if (res.error) return fnErr(res.error);
  return fnOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
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

/* A call only counts when it matches the profile AND actually happened. */
async function fnLogCall(clientId, call){
  const c = call || {};
  return fnRun(() => sb.from('qualified_calls').insert({
    client_id:        clientId,
    prospect_name:    c.name    || null,
    prospect_email:   c.email   || null,
    prospect_company: c.company || null,
    booked_for:       c.bookedFor,
    matched_icp:      c.matchedIcp === false ? false : true,
    happened:         !!c.happened,
    happened_at:      c.happened ? (c.happenedAt || c.bookedFor) : null
  }).select().single(), null);
}

/* They turned up. This is what moves the month's number. */
async function fnCallHappened(callId, whenIso){
  return fnRun(() => sb.from('qualified_calls')
    .update({happened:true, happened_at: whenIso || new Date().toISOString()})
    .eq('id', callId).select().single(), null);
}

/* The client says a call should not count. Held aside until you decide. */
async function fnDisputeCall(callId, reason){
  return fnRun(() => sb.from('qualified_calls')
    .update({dispute_status:'raised', dispute_reason: (reason||'').slice(0,600)})
    .eq('id', callId).select().single(), null);
}

/* You decide. 'upheld' = it does not count. 'rejected' = it stands. */
async function fnSettleDispute(callId, outcome){
  const o = outcome === 'upheld' ? 'upheld' : 'rejected';
  return fnRun(() => sb.from('qualified_calls')
    .update({dispute_status:o}).eq('id', callId).select().single(), null);
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

const fnUsd = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

/* One plain sentence for a month, the same words on your screen and theirs. */
function fnMonthLine(row){
  if (!row) return '';
  if (row.verdict === 'hit')    return `Month ${row.month_no}: hit — ${row.calls_delivered} of ${row.calls_promised} calls.`;
  if (row.verdict === 'missed') return `Month ${row.month_no}: missed — ${row.calls_delivered} of ${row.calls_promised}. ${fnUsd(row.refund_due)} refunded.`;
  if (row.verdict === 'waived') return `Month ${row.month_no}: set aside.`;
  const left = row.days_left;
  const when = left < 0 ? 'the month has ended' : left === 0 ? 'last day' : `${left} day${left===1?'':'s'} left`;
  return `Month ${row.month_no}: ${row.calls_delivered} of ${row.calls_promised} calls, ${when}.`;
}
