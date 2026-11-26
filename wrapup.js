/* ===================== AVIANCE OS — Wrap-up (wrapup.js) =====================
   How a client leaves: the final count, the money owed both ways, what they
   take with them, and deleting their data when the time comes.

   Supabase only. Nothing here calls another server. Tables (SCHEMA.md):
     clients  client_months  qualified_calls  invoices  refunds
     handovers  client_events  client_profiles  meetings
     outreach_threads  outreach_messages  outreach_campaigns  outreach_accounts

   WHAT THIS FILE DOES NOT DECIDE
   ------------------------------
   No money rule lives here. The number of calls a month delivered, the verdict,
   whether a refund is owed and how big it is (month one short = 2x, later
   months = 1x) are all worked out by the database and reached through
   finance.js: fnRecount, fnLockMonth. This file recounts, locks, then ADDS UP
   the rows it finds. If a figure on the final statement is wrong, the row is
   wrong — not the arithmetic here.

   Every function returns {ok, data, error} and never throws. `error` is a
   plain sentence, safe to show a person.

   Loaded after finance.js. Every global is prefixed `wu` (the three screens
   keep the hub's `viewX` naming so index.html can mount them).
   ============================================================================= */

/* ---- plumbing (same shape as finance.js) ------------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const wuOk = coreOk;
const wuErr = coreErr;
const wuWrap = coreWrap;
async function wuRun(fn, whenEmpty){
  try { return wuWrap(await fn(), whenEmpty); }
  catch (e) { return wuErr(e); }
}

/* ---- small helpers ------------------------------------------------ */

const WU_DELETE_CONFIRM = 'DELETE';          /* what a person must type, exactly */
const WU_KEEP_DAYS = 30;                     /* a handover stays downloadable this long */

const wuNum = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 };
const wuToday = () => new Date().toISOString().slice(0,10);
function wuAddDays(day, days){
  const t = Date.parse(String(day || '') + 'T12:00:00Z');
  const base = Number.isFinite(t) ? t : Date.now();
  return new Date(base + wuNum(days) * 86400000).toISOString().slice(0,10);
}
/* Whole dollars, grouped, with a dollar sign — from core.js. */
const wuUsd = coreUsd;
function wuDay(d){
  const t = Date.parse(String(d || '') + 'T12:00:00Z');
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString('en-US', {timeZone:'UTC', day:'numeric', month:'short', year:'numeric'})
    : String(d || '');
}
/* The one escape, from core.js: strict, five characters, the single quote among them. */
const wuE = coreEsc;
/* A value safe inside onclick="…" as a JavaScript string, from core.js. */
const wuAttr = coreAttr;

/* An invoice is settled when the row says so. A void invoice is owed by nobody. */
const WU_DEAD = ['void','cancelled','canceled','written_off','rejected'];
const wuIsPaid  = r => !!(r && (r.paid_at || r.status === 'paid'));
const wuIsDead  = r => !!(r && WU_DEAD.includes(String(r.status || '')));
const wuIsOwed  = r => !!r && !wuIsPaid(r) && !wuIsDead(r);

/* ---- reading the rows a wrap-up needs ----------------------------- */

async function wuClient(clientId){
  if (!clientId) return wuErr('No client was given.');
  /* The eleven columns this file reads off a client, not all 21. A new field
     read from a client row here has to be added to this list. */
  const r = await wuRun(() => sb.from('clients')
    .select('id,company,contact_name,contact_email,website,plan,term,stage,day1_on,ended_on,end_reason')
    .eq('id', clientId).maybeSingle(), null);
  if (!r.ok) return r;
  if (!r.data) return wuErr('That client is not in Aviance OS.');
  return r;
}
async function wuMonths(clientId){
  return wuRun(() => sb.from('client_months').select('*')
    .eq('client_id', clientId).order('month_no'), []);
}
async function wuInvoices(clientId){
  return wuRun(() => sb.from('invoices')
    .select('id,client_id,month_id,number,amount,currency,issued_on,due_on,status,paid_at')
    .eq('client_id', clientId).order('issued_on'), []);
}
async function wuRefunds(clientId){
  return wuRun(() => sb.from('refunds')
    .select('id,client_id,month_id,amount,multiplier,reason,status,paid_at,created_at')
    .eq('client_id', clientId).order('created_at'), []);
}

/* ---- 1. the orderly ending ---------------------------------------- */

/* Write the trail. Never the reason a wrap-up fails — a failed event is noise. */
async function wuEvent(clientId, event, detail){
  return wuRun(() => sb.from('client_events').insert({
    client_id: clientId, area: 'wrapup', event: event, detail: detail || {}
  }).select().single(), null);
}

/* Stop the sending that is still running. Rows only: the hub's own view of it. */
async function wuPauseSending(clientId){
  /* Two writes over two different tables, neither waiting on the other. */
  const [camps, accts] = await Promise.all([
    wuRun(() => sb.from('outreach_campaigns')
      .update({status:'paused'}).eq('client_id', clientId).eq('status','running').select(), []),
    wuRun(() => sb.from('outreach_accounts')
      .update({status:'paused'}).eq('client_id', clientId).eq('status','ok').select(), []),
  ]);
  /* This pauses the hub's own rows ONLY: the hub has no line to the tool that
     sends the email, so somebody must also pause the campaigns inside that
     tool. wuEndClient says so in its result (`providerStillRunning: true`). */
  return wuOk({
    campaignsPaused: (camps.ok && camps.data ? camps.data.length : 0),
    accountsPaused:  (accts.ok && accts.data ? accts.data.length : 0),
    providerStillRunning: true,
    trouble: [camps.ok ? '' : camps.error, accts.ok ? '' : accts.error].filter(Boolean)
  });
}

/* Which months an ending closes, and which it must not touch.
   A month that finished on or before their last day was sold, served and is
   judged: the guarantee applies and it is locked. A month that runs PAST their
   last day was not. Locking it hands lock_month a month with no calls in it
   yet, which reads as missed and raises a full refund for a month that never
   ran.
   This was live and it was expensive. On 2026-11-26 one client carried twelve
   month rows out to September 2027; ending them would have locked ten months
   that had not started and raised $15,000 of refunds for them. Across the ten
   clients in the database it was $63,300 of refunds for months that were not
   over, out of $69,300 raised. One button.
   So: lock what has ended, leave what has not, and NAME what was left so the
   decision is the owner's and not a side effect. Whether a month the client cut
   short is owed back is a commercial question — the clock cannot answer it. */
function wuMonthEnded(month, lastDay){
  const ends = String((month && month.ends_on) || '').slice(0,10);
  const last = String(lastDay || '').slice(0,10);
  if (!ends) return false;            /* no end date: it never ends, so it never ended */
  if (!last) return false;
  return ends <= last;
}

/* End a client, in order:
     1. recount and lock every month that ENDED on or before their last day,
        through finance.js, so the final count is the database's count;
     2. refuse if one of THOSE is still unlocked, and say which one — ending on
        top of a finished, unjudged month would hide money we owe;
     3. add up the refunds the locked months raised;
     4. set clients.ended_on and end_reason, stage -> 'ended';
     5. pause what is still running;
     6. write a client_events row.
   Months that run past their last day are listed in `monthsLeftOpen` and in
   the trail, untouched. */
async function wuEndClient(clientId, opts){
  const o = opts || {};
  const reason = String(o.reason || '').slice(0,600);
  const lastDay = String(o.lastDay || wuToday()).slice(0,10);
  if (!reason) return wuErr('Say why they are leaving before you end them.');

  const cl = await wuClient(clientId);
  if (!cl.ok) return cl;
  if (typeof fnLockMonth !== 'function' || typeof fnRecount !== 'function')
    return wuErr('The money side is not loaded, so the final count cannot be made honest. Reload the page and try again.');

  const first = await wuMonths(clientId);
  if (!first.ok) return first;

  /* 1. the final count, made by the database, on the months that are over.
     fnLockMonth, NOT fnCloseMonth: closing a month also opens the next one and
     invoices it, and this client is leaving. ended_on is not set until step 4,
     so fnCloseMonth's own "that client has left" refusal would not save us
     here — it would open and invoice a month for somebody who is walking out
     the door. Locking is the only step an ending wants. */
  const trouble = [];
  for (const m of (first.data || [])){
    if (m.locked_at) continue;
    if (!wuMonthEnded(m, lastDay)) continue;      /* not over on their last day: not ours to judge */
    const rc = await fnRecount(m.id);
    if (!rc.ok) trouble.push('Month ' + m.month_no + ': ' + rc.error);
    const lk = await fnLockMonth(m.id);
    if (!lk.ok) trouble.push('Month ' + m.month_no + ': ' + lk.error);
  }

  /* 2. read them back and refuse on a FINISHED month that still has no verdict */
  const after = await wuMonths(clientId);
  if (!after.ok) return after;
  const months = after.data || [];
  const open = months.filter(m => !m.locked_at && wuMonthEnded(m, lastDay));
  if (open.length){
    const which = open.map(m => 'month ' + m.month_no).join(', ');
    return wuErr('Not ended. ' + (open.length === 1 ? 'Month ' + open[0].month_no + ' has' : 'These months have')
      + ' no final count yet' + (open.length === 1 ? '' : ': ' + which)
      + ', and ending now would hide money we may owe them.'
      + (trouble.length ? ' The database said: ' + trouble.join(' ') : ''));
  }
  /* the months that run past their last day, left exactly as they were */
  const leftOpen = months.filter(m => !m.locked_at).map(m => ({
    monthId: m.id, monthNo: wuNum(m.month_no),
    startsOn: m.starts_on || null, endsOn: m.ends_on || null,
    promised: wuNum(m.calls_promised), delivered: wuNum(m.calls_delivered)
  }));

  /* 3. what the locked months raised. The amounts are the database's. */
  const refundRows = await wuRefunds(clientId);
  if (!refundRows.ok) return refundRows;
  const refundFromMonths = months.reduce((s,m) => s + wuNum(m.refund_due), 0);
  const refundOutstanding = (refundRows.data || []).filter(wuIsOwed)
    .reduce((s,r) => s + wuNum(r.amount), 0);

  /* 4. the client row */
  const up = await wuRun(() => sb.from('clients')
    .update({ended_on: lastDay, end_reason: reason, stage: 'ended'})
    .eq('id', clientId).select().single(), null);
  if (!up.ok) return up;

  /* 5. stop what is still running */
  const paused = await wuPauseSending(clientId);

  /* 6. the trail */
  const detail = {
    reason: reason, last_day: lastDay,
    months_locked: months.filter(m => !!m.locked_at).length,
    months_left_open: leftOpen.map(m => m.monthNo),
    refund_from_months: refundFromMonths,
    refund_outstanding: refundOutstanding,
    campaigns_paused: paused.data.campaignsPaused,
    accounts_paused: paused.data.accountsPaused
  };
  await wuEvent(clientId, 'client_ended', detail);

  return wuOk({
    client: up.data,
    months: months,
    monthsLocked: months.filter(m => !!m.locked_at).length,
    monthsLeftOpen: leftOpen,
    refundFromMonths: refundFromMonths,
    refundOutstanding: refundOutstanding,
    campaignsPaused: paused.data.campaignsPaused,
    accountsPaused: paused.data.accountsPaused,
    providerStillRunning: true,
    trouble: trouble.concat(paused.data.trouble)
  });
}

/* ---- 2. the closing position -------------------------------------- */

/* One line per month, every figure read off a row:
     promised / delivered / verdict  -> client_months
     invoiced / paid                 -> invoices for that month
     refund                          -> refunds for that month (amount AND
                                        multiplier as the database raised them,
                                        so a month-one miss shows its 2x here
                                        without this file knowing the rule)
   Then: what is still owed to us, what we still owe them, and the one net
   figure. Invoices and refunds with no month land in a last "Outside the
   months" line so nothing is dropped. */
/* `pre` lets a caller that has already read these rows — the ending screen
   reads every leaving client's months, invoices and refunds in one query each
   — hand them in instead of this reading them again per client. The sums
   below are the only place the figures are worked out either way. */
async function wuFinalStatement(clientId, pre){
  const have = pre && typeof pre === 'object' ? pre : null;
  const [cl, ms, iv, rf] = have
    ? [wuOk(have.client), wuOk(have.months || []), wuOk(have.invoices || []), wuOk(have.refunds || [])]
    /* Four reads that do not depend on each other, so one wait, not four. */
    : await Promise.all([wuClient(clientId), wuMonths(clientId), wuInvoices(clientId), wuRefunds(clientId)]);
  if (!cl.ok) return cl;
  if (!ms.ok) return ms;
  if (!iv.ok) return iv;
  if (!rf.ok) return rf;

  const months = ms.data || [], invoices = iv.data || [], refunds = rf.data || [];
  const byMonth = (rows, id) => rows.filter(r => String(r.month_id || '') === String(id || ''));

  const line = (label, monthRow, invs, refs) => {
    const invoiced = invs.reduce((s,r) => s + wuNum(r.amount), 0);
    const paid     = invs.filter(wuIsPaid).reduce((s,r) => s + wuNum(r.amount), 0);
    const owedToUs = invs.filter(wuIsOwed).reduce((s,r) => s + wuNum(r.amount), 0);
    const refunded = refs.filter(wuIsPaid).reduce((s,r) => s + wuNum(r.amount), 0);
    const owedToThem = refs.filter(wuIsOwed).reduce((s,r) => s + wuNum(r.amount), 0);
    const mult = refs.map(r => wuNum(r.multiplier)).filter(n => n > 0);
    return {
      label: label,
      monthId: monthRow ? monthRow.id : null,
      monthNo: monthRow ? wuNum(monthRow.month_no) : null,
      startsOn: monthRow ? monthRow.starts_on : null,
      endsOn: monthRow ? monthRow.ends_on : null,
      promised: monthRow ? wuNum(monthRow.calls_promised) : null,
      delivered: monthRow ? wuNum(monthRow.calls_delivered) : null,
      verdict: monthRow ? String(monthRow.verdict || '') : '',
      locked: !!(monthRow && monthRow.locked_at),
      refundDue: monthRow ? wuNum(monthRow.refund_due) : 0,
      invoiced: invoiced, paid: paid, owedToUs: owedToUs,
      refunded: refunded, owedToThem: owedToThem,
      multipliers: mult,
      invoiceNumbers: invs.map(r => String(r.number || '')),
      net: owedToUs - owedToThem
    };
  };

  const lines = months.map(m => line('Month ' + wuNum(m.month_no), m, byMonth(invoices, m.id), byMonth(refunds, m.id)));
  const loose = line('Outside the months', null, invoices.filter(r => !r.month_id), refunds.filter(r => !r.month_id));
  if (loose.invoiced || loose.refunded || loose.owedToUs || loose.owedToThem) lines.push(loose);

  const sum = k => lines.reduce((s,l) => s + wuNum(l[k]), 0);
  const owedToUs = sum('owedToUs'), owedToThem = sum('owedToThem');

  return wuOk({
    client: cl.data,
    lines: lines,
    months: months.length,
    callsPromised: months.reduce((s,m) => s + wuNum(m.calls_promised), 0),
    callsDelivered: months.reduce((s,m) => s + wuNum(m.calls_delivered), 0),
    invoiced: sum('invoiced'),
    paid: sum('paid'),
    refunded: sum('refunded'),
    owedToUs: owedToUs,
    owedToThem: owedToThem,
    net: owedToUs - owedToThem,
    unlockedMonths: months.filter(m => !m.locked_at).map(m => wuNum(m.month_no)),
    /* Of those, the ones that run past their last day. An ending leaves these
       alone on purpose (see wuEndClient), so the statement must not read them
       as a missing count somebody forgot. */
    monthsPastLastDay: months.filter(m => !m.locked_at && !wuMonthEnded(m, (cl.data && cl.data.ended_on) || wuToday()))
      .map(m => wuNum(m.month_no))
  });
}

/* The warning under the statement, if there is one. Two different things:
   a month that FINISHED and has no verdict is money we may owe and have not
   worked out; a month that runs past their last day was deliberately left
   open when they were ended, and saying "not final" about it would send the
   owner looking for a count that nobody is meant to take. */
function wuStmtWarn(d){
  const all = (d && d.unlockedMonths) || [];
  if (!all.length) return '';
  const past = (d && d.monthsPastLastDay) || [];
  const unfinished = all.filter(n => past.indexOf(n) < 0);
  const bits = [];
  if (unfinished.length)
    bits.push('Month ' + unfinished.join(', ') + ' has no final count yet, so this is not final.');
  if (past.length)
    bits.push('Month ' + past.join(', ') + ' runs past their last day and was left open on purpose: whether any of it is owed back is your decision.');
  return '<p class="wu-warn">' + wuE(bits.join(' ')) + '</p>';
}

/* The one sentence under the statement. */
function wuNetWords(net){
  const n = wuNum(net);
  if (n > 0) return 'They owe us ' + wuUsd(n) + '.';
  if (n < 0) return 'We owe them ' + wuUsd(-n) + '.';
  return 'Square — nothing owed either way.';
}

/* ---- 3. what they take with them ---------------------------------- */

/* The handover is theirs: their prospect list, their conversations, their
   booked meetings, the inputs they gave us, and their invoices. Nothing of
   ours. It is built from rows at the moment you ask, kept in handovers.contents
   so it cannot change under them, and marked for deletion 30 days after the
   last day. */
async function wuHandover(clientId, opts){
  const o = opts || {};
  const cl = await wuClient(clientId);
  if (!cl.ok) return cl;
  const c = cl.data;

  /* None of these five depends on another. They used to be read one after the
     next, so building a handover waited for six round trips end to end; now it
     waits for two. The order they are CHECKED in is unchanged, so the same
     failure is still the one reported. */
  const [threads, msgs, meets, prof, invs] = await Promise.all([
    wuRun(() => sb.from('outreach_threads').select('*')
      .eq('client_id', clientId).order('last_message_at'), []),
    wuRun(() => sb.from('outreach_messages').select('*')
      .eq('client_id', clientId).order('sent_at'), []),
    wuRun(() => sb.from('meetings').select('*')
      .eq('client_id', clientId).order('starts_at'), []),
    wuRun(() => sb.from('client_profiles').select('*')
      .eq('client_id', clientId).maybeSingle(), null),
    wuInvoices(clientId),
  ]);
  if (!threads.ok) return threads;
  if (!msgs.ok) return msgs;
  if (!meets.ok) return meets;
  if (!prof.ok) return prof;
  if (!invs.ok) return invs;

  const messages = msgs.data || [];
  const prospects = (threads.data || []).map(t => ({
    thread_id: t.id, external_id: t.external_id || null,
    name: t.lead_name || null, email: t.lead_email || null,
    company: t.lead_company || null, title: t.lead_title || null,
    sentiment: t.sentiment || null, status: t.status || null,
    last_message_at: t.last_message_at || null
  }));
  const conversations = (threads.data || []).map(t => ({
    thread_id: t.id, lead_email: t.lead_email || null, lead_name: t.lead_name || null,
    messages: messages.filter(m => String(m.thread_id) === String(t.id)).map(m => ({
      direction: m.direction, subject: m.subject || null, body: m.body || null,
      sent_at: m.sent_at, delivery: m.delivery || null
    }))
  }));
  const loose = messages.filter(m => !(threads.data || []).some(t => String(t.id) === String(m.thread_id)));
  if (loose.length) conversations.push({
    thread_id: null, lead_email: null, lead_name: 'Messages with no thread',
    messages: loose.map(m => ({direction:m.direction, subject:m.subject||null, body:m.body||null, sent_at:m.sent_at, delivery:m.delivery||null}))
  });

  const lastDay = String(o.lastDay || c.ended_on || wuToday()).slice(0,10);
  const contents = {
    built_at: new Date().toISOString(),
    last_day: lastDay,
    client: {
      id: c.id, company: c.company, contact_name: c.contact_name,
      contact_email: c.contact_email, website: c.website || null,
      plan: c.plan, term: c.term, day1_on: c.day1_on || null,
      ended_on: c.ended_on || null, end_reason: c.end_reason || null
    },
    prospects: prospects,
    conversations: conversations,
    meetings: (meets.data || []).map(m => ({
      kind: m.kind, starts_at: m.starts_at, minutes: m.minutes,
      time_zone: m.time_zone, status: m.status, meet_link: m.meet_link || null,
      held_at: m.held_at || null, notes: m.notes || null
    })),
    inputs: prof.data || null,
    invoices: (invs.data || []).map(i => ({
      number: i.number, amount: i.amount, currency: i.currency,
      issued_on: i.issued_on, due_on: i.due_on, status: i.status,
      paid_at: i.paid_at || null
    })),
    counts: {
      prospects: prospects.length,
      messages: messages.length,
      meetings: (meets.data || []).length,
      invoices: (invs.data || []).length
    }
  };

  const row = await wuRun(() => sb.from('handovers').insert({
    client_id: clientId,
    reason: String(o.reason || c.end_reason || '').slice(0,600) || null,
    contents: contents,
    data_delete_on: wuAddDays(lastDay, WU_KEEP_DAYS)
  }).select().single(), null);
  if (!row.ok) return row;
  await wuEvent(clientId, 'handover_built', {counts: contents.counts, data_delete_on: wuAddDays(lastDay, WU_KEEP_DAYS)});
  return row;
}

async function wuMarkSent(id){
  if (!id) return wuErr('No handover was given.');
  return wuRun(() => sb.from('handovers')
    .update({sent_at: new Date().toISOString()})
    .eq('id', id).select().single(), null);
}

async function wuHandovers(clientId){
  return wuRun(() => {
    let q = sb.from('handovers').select('*').order('created_at', {ascending:false});
    if (clientId) q = q.eq('client_id', clientId);
    return q;
  }, []);
}

/* ---- 4. deleting their data --------------------------------------- */

/* WHAT GOES, WHAT IS KEPT, AND WHY
   --------------------------------
   GOES — the prospect and conversation data. It is people's personal data,
   it was only ever held to do the work, and the work has ended:
     outreach_messages   every email in or out for this client
     outreach_threads    the prospects themselves: name, email, company, title
   KEPT — the money record, which we are required to be able to show and which
   nothing above is needed to read:
     invoices            what we charged and what they paid
     refunds             what we gave back, and the multiplier it was given at
     qualified_calls     the count the money was based on. It holds prospect
                         names, so it is the one exception: without it an
                         invoice or a refund cannot be explained, and the
                         statement stops adding up.
     clients             the client row itself, with ended_on and end_reason
     client_months       the final count per month
     client_events       the trail, including this deletion
     handovers           the row (its `contents` is emptied here, because the
                         copy inside it is the same prospect data)
   Campaign totals (outreach_campaigns, outreach_daily, outreach_inboxes) are
   counts and our own mailboxes, not their prospects, so they stay.

   This is destructive and never undone. It takes an explicit confirmation and
   refuses without it, and nothing in this file ever calls it on a timer, on
   load, or from a view that was merely opened. A person types the word. */

/* The handovers whose date has passed: these are due for deletion now. */
async function wuDeleteDue(today){
  const day = String(today || wuToday()).slice(0,10);
  return wuRun(() => sb.from('handovers').select('*')
    .not('data_delete_on', 'is', null)
    .lte('data_delete_on', day)
    .order('data_delete_on'), []);
}

/* The ones whose date has not come yet, so a person can see what is coming. */
async function wuDeleteComing(today){
  const day = String(today || wuToday()).slice(0,10);
  return wuRun(() => sb.from('handovers').select('*')
    .not('data_delete_on', 'is', null)
    .gt('data_delete_on', day)
    .order('data_delete_on'), []);
}

/* In words, for the confirm step. Pure, so the screen and a test agree. */
function wuDeleteWords(company){
  const who = String(company || 'this client');
  return {
    goes: [
      'Every email sent to and from their prospects (outreach_messages).',
      'Their prospect list — names, emails, companies, job titles (outreach_threads).',
      'The copy of that data held inside their handover.'
    ],
    kept: [
      'Their invoices — what we charged and what they paid.',
      'Their refunds — what we gave back, and at what multiplier.',
      'The qualified calls the money was counted from.',
      'Their client row, final month counts, and the trail of what happened.'
    ],
    sentence: 'This removes ' + who + "'s prospect and conversation data for good. "
      + 'The money record stays. It cannot be undone.'
  };
}

/* DESTRUCTIVE. `confirmation` must be exactly the word DELETE. */
async function wuDeleteData(clientId, confirmation){
  if (!clientId) return wuErr('No client was given.');
  if (String(confirmation) !== WU_DELETE_CONFIRM)
    return wuErr('Nothing was removed. Type ' + WU_DELETE_CONFIRM + ' to confirm you want their prospect and conversation data removed for good.');

  const cl = await wuClient(clientId);
  if (!cl.ok) return cl;

  /* messages first — they hang off the threads */
  const msgs = await wuRun(() => sb.from('outreach_messages').delete()
    .eq('client_id', clientId).select(), []);
  if (!msgs.ok) return msgs;
  const threads = await wuRun(() => sb.from('outreach_threads').delete()
    .eq('client_id', clientId).select(), []);
  if (!threads.ok) return threads;

  /* the handover held a copy of the same data: empty it, keep the row so the
     trail of what was handed over and when still reads. */
  const hand = await wuRun(() => sb.from('handovers')
    .update({contents: {deleted_on: wuToday(), note: 'The prospect and conversation data in this handover has been removed. The money record is kept.'}})
    .eq('client_id', clientId).select(), []);

  const removed = {
    messages: (msgs.data || []).length,
    prospects: (threads.data || []).length,
    handovers_emptied: (hand.ok && hand.data ? hand.data.length : 0)
  };
  await wuEvent(clientId, 'data_deleted', {
    removed: removed,
    kept: ['invoices','refunds','qualified_calls','clients','client_months','client_events','handovers']
  });
  return wuOk({
    client: cl.data, removed: removed,
    kept: ['invoices','refunds','qualified_calls','clients','client_months','client_events','handovers'],
    words: wuDeleteWords(cl.data.company)
  });
}

/* ---- the screens -------------------------------------------------- */

/* State. null means "not read yet"; [] means "read, and there is nothing". */
const wu = {ending:null, endingErr:'', stmt:{}, stmtErr:{}, due:null, coming:null, delErr:'', busy:{}};

function wuPaint(){ if (typeof render === 'function' && typeof currentView !== 'undefined') try{ render(currentView) }catch(e){} }
function wuKick(fn){ if (typeof sb === 'undefined' || !sb) return; Promise.resolve().then(fn).catch(() => {}) }

/* On their way out, or already out. 'ending' and 'cancelled' were never stages
   the database allows; see SCHEMA.md for the nine it does. A client with
   ended_on set counts whatever their stage says. */
const WU_ENDING_STAGES = ['ended','lost','paused'];

/* Everyone on their way out, with each one's final figures.
   This used to read every client row, every column, and then one statement per
   client — four more round trips each, one after the other. Now the database
   is asked only for the clients who have actually left, and the months, the
   invoices and the refunds come back one query each for the whole list. The
   figures are still worked out by wuFinalStatement and nowhere else.
   The `or` narrows the read at the database; the same test is applied again
   here, so the screen shows the same rows whether or not the database
   understood it. */
async function wuLoadEnding(){
  const cols = 'id,company,contact_name,contact_email,website,plan,term,stage,day1_on,ended_on,end_reason';
  const cs = await wuRun(() => sb.from('clients').select(cols)
    .or('ended_on.not.is.null,stage.in.(' + WU_ENDING_STAGES.join(',') + ')')
    .order('ended_on', {ascending:false}), []);
  if (!cs.ok){ wu.endingErr = cs.error; wu.ending = []; wuPaint(); return cs }
  const rows = (cs.data || []).filter(c => c && (c.ended_on || WU_ENDING_STAGES.includes(String(c.stage || ''))));
  const ids = rows.map(c => c.id);

  let months = [], invoices = [], refunds = [], trouble = '';
  if (ids.length){
    const [ms, iv, rf] = await Promise.all([
      wuRun(() => sb.from('client_months').select('*').in('client_id', ids).order('month_no'), []),
      wuRun(() => sb.from('invoices').select('id,client_id,month_id,number,amount,currency,issued_on,due_on,status,paid_at')
        .in('client_id', ids).order('issued_on'), []),
      wuRun(() => sb.from('refunds').select('id,client_id,month_id,amount,multiplier,reason,status,paid_at,created_at')
        .in('client_id', ids).order('created_at'), []),
    ]);
    months = ms.ok ? (ms.data || []) : [];
    invoices = iv.ok ? (iv.data || []) : [];
    refunds = rf.ok ? (rf.data || []) : [];
    trouble = !ms.ok ? ms.error : !iv.ok ? iv.error : !rf.ok ? rf.error : '';
  }
  const mine = (list, id) => list.filter(r => String(r.client_id) === String(id));

  const made = await Promise.all(rows.map(c => wuFinalStatement(c.id, {
    client: c, months: mine(months, c.id), invoices: mine(invoices, c.id), refunds: mine(refunds, c.id)
  })));
  const out = rows.map((c, i) => {
    const s = made[i];
    const ok = s.ok && !trouble;
    return {
      client: c,
      net: ok ? s.data.net : 0,
      owedToUs: ok ? s.data.owedToUs : 0,
      owedToThem: ok ? s.data.owedToThem : 0,
      unlocked: ok ? s.data.unlockedMonths : [],
      trouble: ok ? '' : (trouble || s.error)
    };
  });
  wu.ending = out; wu.endingErr = ''; wuPaint();
  return wuOk(out);
}

/* The shell's own icon set, or nothing. DESIGN.md allows no emoji and no glyph
   standing in for a mark, so an icon we do not have is simply absent. */
function wuIcon(name){ return (typeof I !== 'undefined' && I && I[name]) || '' }

/* Clients ending or ended: the net figure and what is still outstanding. */
function viewEnding(){
  if (wu.ending === null){ wuKick(wuLoadEnding); return '<div class="card wu-wait" role="status">Reading the final figures…</div>' }
  if (wu.endingErr) return `<div class="card"><p class="wu-err" role="alert">${wuE(wu.endingErr)}</p></div>`;
  if (!wu.ending.length){
    return typeof emptyState === 'function'
      /* DESIGN.md: no emoji anywhere in this system. The icon slot wants the
         shell's own inline SVG; a flag glyph rendered at whatever size and
         colour the reader's font felt like. */
      ? emptyState(wuIcon('clients'), 'Nobody is leaving', 'Clients appear here once they are ending or ended.', '', '')
      : '<div class="card"><h3>Nobody is leaving</h3><p>Clients appear here once they are ending or ended.</p></div>';
  }
  const rows = wu.ending.map(r => {
    const c = r.client, ended = String(c.stage||'') === 'ended' || !!c.ended_on;
    const out = [];
    if (r.owedToUs)   out.push(wuUsd(r.owedToUs) + ' to collect');
    if (r.owedToThem) out.push(wuUsd(r.owedToThem) + ' to refund');
    if (r.unlocked && r.unlocked.length) out.push('month ' + r.unlocked.join(', ') + ' not counted yet');
    return `<tr>
      <td><b>${wuE(c.company)}</b><span class="wu-sub">${wuE(c.contact_name || '')}</span></td>
      <td>${ended ? 'Ended' : 'Ending'}${c.ended_on ? ' ' + wuE(wuDay(c.ended_on)) : ''}</td>
      <td class="wu-why">${wuE(c.end_reason || '—')}</td>
      <td class="wu-n ${r.net > 0 ? 'wu-up' : r.net < 0 ? 'wu-down' : ''}">${wuE(wuNetWords(r.net))}</td>
      <td class="wu-why">${out.length ? wuE(out.join(' · ')) : 'Nothing outstanding'}</td>
      <td><button type="button" class="btn ghost" onclick="viewEndingOpen(${wuAttr(c.id)})">Statement</button></td>
    </tr>`;
  }).join('');
  return `<div class="card wu-card"><h3>Ending and ended</h3>
    <table class="wu-table"><thead><tr><th>Client</th><th>When</th><th>Why</th><th>Net</th><th>Outstanding</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
function viewEndingOpen(clientId){
  if (typeof openModal === 'function') openModal(viewFinalStatement(clientId));
}

async function wuLoadStatement(clientId){
  const s = await wuFinalStatement(clientId);
  if (s.ok) wu.stmt[clientId] = s.data; else wu.stmtErr[clientId] = s.error;
  if (typeof openModal === 'function' && typeof document !== 'undefined'){
    const host = document.getElementById('modal');
    if (host && String(host.innerHTML || '').includes('wu-stmt')) openModal(viewFinalStatement(clientId));
  } else wuPaint();
  return s;
}

/* The statement, line by line, printable. */
function viewFinalStatement(clientId){
  const head = '<div class="wu-stmt">';
  if (wu.stmtErr[clientId]) return head + `<p class="wu-err" role="alert">${wuE(wu.stmtErr[clientId])}</p></div>`;
  const d = wu.stmt[clientId];
  if (!d){ wuKick(() => wuLoadStatement(clientId)); return head + '<p role="status">Adding up the rows…</p></div>' }
  const c = d.client || {};
  const lines = (d.lines || []).map(l => `<tr>
    <td>${wuE(l.label)}${l.endsOn ? `<span class="wu-sub">${wuE(wuDay(l.startsOn))} – ${wuE(wuDay(l.endsOn))}</span>` : ''}</td>
    <td class="wu-n">${l.promised === null ? '—' : l.promised}</td>
    <td class="wu-n">${l.delivered === null ? '—' : l.delivered}</td>
    <td>${wuE(l.verdict || '—')}${l.locked ? '' : l.monthNo === null ? '' : ' <span class="wu-sub">not counted yet</span>'}</td>
    <td class="wu-n">${wuE(wuUsd(l.invoiced))}</td>
    <td class="wu-n">${wuE(wuUsd(l.paid))}</td>
    <td class="wu-n">${l.owedToUs ? wuE(wuUsd(l.owedToUs)) : '—'}</td>
    <td class="wu-n">${(l.refunded || l.owedToThem) ? wuE(wuUsd(l.refunded + l.owedToThem)) : '—'}${l.multipliers && l.multipliers.length ? ` <span class="wu-sub">${wuE(l.multipliers.join(', '))}x</span>` : ''}</td>
  </tr>`).join('');
  const body = lines || `<tr><td colspan="8">No months yet, so there is nothing to add up.</td></tr>`;
  return head + `<div class="wu-stmt-h"><h3>Final statement — ${wuE(c.company || '')}</h3>
      <span class="wu-sub">${wuE(c.plan || '')} ${wuE(c.term || '')}${c.ended_on ? ' · ended ' + wuE(wuDay(c.ended_on)) : ''}</span></div>
    <table class="wu-table"><thead><tr><th>Period</th><th>Promised</th><th>Delivered</th><th>Verdict</th><th>Invoiced</th><th>Paid</th><th>Still owed</th><th>Refund</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><th>All of it</th><th class="wu-n">${d.callsPromised}</th><th class="wu-n">${d.callsDelivered}</th><th></th>
        <th class="wu-n">${wuE(wuUsd(d.invoiced))}</th><th class="wu-n">${wuE(wuUsd(d.paid))}</th>
        <th class="wu-n">${wuE(wuUsd(d.owedToUs))}</th><th class="wu-n">${wuE(wuUsd(d.refunded + d.owedToThem))}</th></tr></tfoot></table>
    <p class="wu-net"><b>${wuE(wuNetWords(d.net))}</b></p>
    ${wuStmtWarn(d)}
    <div class="wu-print"><button type="button" class="btn ghost" onclick="window.print()">Print</button></div></div>`;
}

async function wuLoadDeletion(){
  const due = await wuDeleteDue();
  const soon = await wuDeleteComing();
  wu.due = due.ok ? (due.data || []) : [];
  wu.coming = soon.ok ? (soon.data || []) : [];
  wu.delErr = due.ok ? (soon.ok ? '' : soon.error) : due.error;
  wuPaint();
  return wuOk({due: wu.due, coming: wu.coming});
}

function wuHandoverName(h){
  const c = (h && h.contents && h.contents.client) || {};
  return c.company || (h && h.client_id) || 'this client';
}

/* What is due for deletion and what is coming. Nothing is removed by opening
   this screen: every row needs its own confirm step. */
function viewDataDeletion(){
  if (wu.due === null || wu.coming === null){ wuKick(wuLoadDeletion); return '<div class="card wu-wait" role="status">Reading the handovers…</div>' }
  const err = wu.delErr ? `<p class="wu-err" role="alert">${wuE(wu.delErr)}</p>` : '';
  const row = (h, due) => {
    const name = wuHandoverName(h);
    return `<tr>
      <td><b>${wuE(name)}</b></td>
      <td>${wuE(wuDay(h.data_delete_on))}${due ? ' <span class="wu-sub">due now</span>' : ''}</td>
      <td>${h.sent_at ? 'Handover sent' : 'Not sent yet'}</td>
      <td>${due ? `<button type="button" class="btn danger" onclick="wuConfirmDelete(${wuAttr(h.client_id)},${wuAttr(name)})">Remove their data…</button>` : '<span class="wu-sub">Waiting for the date</span>'}</td>
    </tr>`;
  };
  const dueBody = wu.due.length ? wu.due.map(h => row(h, true)).join('') : `<tr><td colspan="4">Nothing is due for deletion.</td></tr>`;
  const comingBody = wu.coming.length ? wu.coming.map(h => row(h, false)).join('') : `<tr><td colspan="4">Nothing is coming up.</td></tr>`;
  return `<div class="card wu-card">${err}<h3>Due for deletion</h3>
      <p class="wu-sub">Thirty days after a client's last day their prospect and conversation data can go. Nothing happens on its own — somebody confirms each one.</p>
      <table class="wu-table"><thead><tr><th>Client</th><th>Date</th><th>Handover</th><th></th></tr></thead><tbody>${dueBody}</tbody></table></div>
    <div class="card wu-card"><h3>Coming up</h3>
      <table class="wu-table"><thead><tr><th>Client</th><th>Date</th><th>Handover</th><th></th></tr></thead><tbody>${comingBody}</tbody></table></div>`;
}

/* The confirm step, in words, with the typed word. */
function wuConfirmDelete(clientId, company){
  const w = wuDeleteWords(company);
  const html = `<div class="modal-h"><b>Remove ${wuE(company)}'s data</b></div>
    <div class="modal-b wu-confirm">
      <p>${wuE(w.sentence)}</p>
      <h4>What will be removed</h4><ul class="wu-goes">${w.goes.map(x => `<li>${wuE(x)}</li>`).join('')}</ul>
      <h4>What will be kept</h4><ul class="wu-kept">${w.kept.map(x => `<li>${wuE(x)}</li>`).join('')}</ul>
      <label for="wuDelWord">Type ${WU_DELETE_CONFIRM} to confirm</label>
      <input id="wuDelWord" type="text" autocomplete="off" placeholder="${WU_DELETE_CONFIRM}">
      <p class="wu-err" id="wuDelErr"></p>
    </div>
    <div class="modal-f"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn danger" onclick="wuDeleteNow(${wuAttr(clientId)})">Remove their data for good</button></div>`;
  if (typeof openModal === 'function') openModal(html);
  return html;
}

/* Only ever reached by a person typing the word and pressing the button. */
async function wuDeleteNow(clientId){
  const word = typeof val === 'function' ? val('wuDelWord') : '';
  const r = await wuDeleteData(clientId, word);
  if (!r.ok){ if (typeof errEl === 'function') errEl('wuDelErr', r.error); return r }
  if (typeof closeModal === 'function') closeModal();
  if (typeof toast === 'function') toast('Their prospect and conversation data is gone. The money record is kept.');
  wu.due = null; wu.coming = null;
  wuKick(wuLoadDeletion);
  return r;
}

/* Reload when one of these screens is opened. index.html can call this. */
function wuOnRender(v){
  if (v === 'ending'){ wu.ending = null; wuKick(wuLoadEnding) }
  if (v === 'dataDeletion'){ wu.due = null; wu.coming = null; wuKick(wuLoadDeletion) }
}
