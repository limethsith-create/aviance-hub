/* ===================== AVIANCE HUB — Finance =====================
   The money, and the only part of the hub that does NOT go through the machine
   the old backend. Everything here talks straight to Supabase through the
   shell's `sb` client, so it keeps working when the machine is gone.

   Schema: supabase/migrations/2026112209*_finance_*.sql
     plan_prices  clients  client_months  qualified_calls  invoices  refunds
     views:  v_month_standing  v_exposure  v_money  v_invoice_work
     rules:  open_next_month(client)  recount_month(month)
             lock_month(month)  raise_invoice(month, due_days)

   The rules live in the database on purpose. A verdict that decides a refund
   should not depend on which screen asked the question.

   Every function returns {ok, data, error} and never throws (same shape as
   channels-api.js). `error` is plain words, safe to show a person.
   ================================================================= */

const FN_MONEY_RELOAD_MS = 60000;

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

/* ---- clients and their months ------------------------------------ */

async function fnPlans(){
  return fnRun(() => sb.from('plan_prices').select('*').order('monthly_fee'), []);
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

/* Open the next month. Safe to call twice: returns the month that already exists. */
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

/* Raise the invoice for a month. Applies the $300 Pilot credit once. A month
   that is already invoiced returns its existing invoice; a 3-month term only
   bills on months 1, 4, 7 and returns null in between. */
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

async function fnMarkInvoicePaid(invoiceId, via){
  return fnRun(() => sb.from('invoices')
    .update({status:'paid', paid_at:new Date().toISOString(), paid_via:(via||'').slice(0,60)})
    .eq('id', invoiceId).select().single(), null);
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

/* ---- adding a client ---------------------------------------------- */

/* Won on the discovery call. Plan decides the number and the fee; a Pilot
   client carries their $300 forward as a credit on their first plan invoice. */
async function fnAddClient(c){
  const plans = await fnPlans();
  if (!plans.ok) return plans;
  const p = (plans.data || []).find(x => x.plan === c.plan);
  if (!p) return fnErr('That plan does not exist.');

  const fee = c.term === '3month' && p.three_month_fee ? p.three_month_fee : p.monthly_fee;
  return fnRun(() => sb.from('clients').insert({
    booking_id:     c.bookingId || null,
    company:        c.company,
    contact_name:   c.contactName,
    contact_email:  c.contactEmail,
    website:        c.website || null,
    plan:           c.plan,
    term:           c.term === '3month' ? '3month' : 'monthly',
    calls_promised: p.calls_promised,
    monthly_fee:    fee,
    pilot_credit:   c.pilotCredit || 0,
    owner_id:       c.ownerId || null,
    stage:          'won'
  }).select().single(), null);
}

/* Sending started. This sets the anchor the whole month clock hangs off,
   then opens month one. */
async function fnStartSending(clientId, day1){
  const d = day1 || new Date().toISOString().slice(0,10);
  const up = await fnRun(() => sb.from('clients')
    .update({day1_on:d, stage:'live'}).eq('id', clientId).select().single(), null);
  if (!up.ok) return up;
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
