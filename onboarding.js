/* ===================== AVIANCE OS — Onboarding (a won deal becomes a running client) =====================
   Four things stand between a signed deal and day one: the agreement, their
   inputs, the strategy call, and the first invoice. This file is the gate.

   Nothing here is ticked by hand. Every item on the checklist is read from the
   row that proves it:
     agreement signed        agreements (matched by booking, else their email)
     money in                invoices.status = 'paid'
     inputs signed off       client_profiles.signed_off_at
     calendar link           client_profiles.calendar_url
     primary contact         client_people.is_primary
     do-not-email list       client_profiles.never_email
     strategy call held      meetings kind 'strategy', held
   There is no "onboarded" flag to set, so nobody can fake day one.

   The money is not ours. Prices come from plan_prices and invoices come from
   finance.js (fnRaiseInvoice / fnInvoiceWork / fnInvoices / fnMarkInvoiceSent /
   fnMarkInvoicePaid / fnStartSending / fnOpenMonth).

   Every function returns {ok, data, error} and never throws (same shape as
   finance.js). `error` is plain words, safe to show a person.
   Loaded by a <script src="onboarding.js"> tag after finance.js.
   ========================================================================= */

/* ---- plumbing (same shape as finance.js) ------------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const obOk = coreOk;
const obErr = coreErr;
const obWrap = coreWrap;
async function obRun(fn, whenEmpty){
  try { return obWrap(await fn(), whenEmpty); }
  catch (e) { return obErr(e); }
}

/* ---- the words ---------------------------------------------------- */

/* The inputs we must have before anybody signs off. The second word is how we
   name the gap to a person, so it reads as a sentence: "We still need …". */
const OB_REQUIRED = [
  ['sells_what',    'what they sell'],
  ['sells_to',      'who they sell to'],
  ['icp',           'the profile of who to approach'],
  ['never_email',   'the list of people never to contact'],
  ['calendar_url',  'their calendar link'],
  ['slots_per_week','how many call slots a week'],
  ['sender_name',   "the sender's name"],
  ['sender_title',  "the sender's title"],
  ['time_zone',     'their time zone'],
];
const OB_ITEMS = [
  ['agreement', 'Agreement signed'],
  ['paid',      'Deposit or first invoice paid'],
  ['inputs',    'Inputs filled and signed off'],
  ['calendar',  'Calendar link'],
  ['contact',   'Primary contact'],
  ['neverEmail','Do-not-email list'],
  ['strategy',  'Strategy call held'],
];
/* The stages a client can be onboarding in: won, and anything before day one. */
const OB_STAGES = ['won', 'onboarding'];

/* ---- small readers ------------------------------------------------ */

function obText(v){ return String(v == null ? '' : v).trim() }
/* The one escape, from core.js: strict, five characters, the single quote among them. */
const obEsc = coreEsc;
/* coreAttr, but on the trimmed value: this file trims everything a person typed. */
function obArg(v){ return coreAttr(obText(v)) }
function obToday(){ return new Date().toISOString().slice(0,10) }
/* Day one, in the zone the months are counted in.
   day1_on anchors every month boundary for that client, and recount_month puts a
   call in a month by its day in calendar_settings.us_zone. obToday() is the UTC
   day, so a client started after 7pm Eastern would get a day1_on one day late and
   every boundary after it would sit a day out — enough to move a call on the last
   evening of a month into the next one, and a refund with it. */
const OB_MONTH_ZONE = 'America/New_York';
function obTodayUs(){
  try {
    const d = new Intl.DateTimeFormat('en-CA',
      {timeZone: OB_MONTH_ZONE, year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : obToday();
  } catch (e) { return obToday(); }
}
/* Whole dollars, grouped, with a dollar sign — from core.js. */
const obMoney = coreUsd;

/* jsonb that people type into: a string, a list of lines, or {text:'…'}. */
function obJsonText(v){
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(obText).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    if (v.none === true) return '';
    if (typeof v.text === 'string') return v.text.trim();
    if (Array.isArray(v.entries)) return v.entries.map(obText).filter(Boolean).join('\n');
  }
  return '';
}
/* A list typed as lines or commas -> an array of lines. */
function obLines(v){
  if (Array.isArray(v)) return v.map(obText).filter(Boolean);
  return obText(obJsonText(v)).split(/[\n,;]+/).map(obText).filter(Boolean);
}
/* "nobody to exclude" is an answer too, and it is recorded, not blank. */
function obNoneSaid(v){ return Boolean(v && typeof v === 'object' && !Array.isArray(v) && v.none === true) }
function obNeverEmailRecorded(v){ return obNoneSaid(v) || obLines(v).length > 0 }

/* Is one required input filled? never_email and icp are jsonb, the rest text. */
function obFilled(profile, field){
  const p = profile || {};
  if (field === 'never_email') return obNeverEmailRecorded(p.never_email);
  if (field === 'icp')         return obLines(p.icp).length > 0;
  if (field === 'slots_per_week') return Number(p.slots_per_week) > 0;
  return obText(p[field]) !== '';
}
/* The first required input still blank, in the words we show a person. */
function obMissingField(profile){
  const miss = OB_REQUIRED.find(f => !obFilled(profile, f[0]));
  return miss ? {field: miss[0], label: miss[1]} : null;
}

/* An agreement counts as signed when its own status says so. */
function obAgreementState(row){
  if (!row) return 'none';
  const s = obText(row.status).toLowerCase();
  if (/sign|accept|counter|complete|won/.test(s)) return 'signed';
  if (/sent|await|pending/.test(s)) return 'sent';
  if (/fail|error/.test(s)) return 'failed';
  return s || 'draft';
}
const OB_AGREEMENT_WORDS = {none:'Not drafted yet', draft:'Drafted, not sent', sent:'Sent, not signed', signed:'Signed', failed:'Sending failed'};
function obAgreementWords(row){ const st = obAgreementState(row); return OB_AGREEMENT_WORDS[st] || st }

/* A meeting counts as held when it was held, not when it was booked. */
function obMeetingHeld(m){ return Boolean(m && (m.held_at || obText(m.status).toLowerCase() === 'held')) }

/* ---- reading one client's real rows ------------------------------- */

/* Only the columns this file reads off a client. `clients` has 21; asking for
   the nine used here keeps the notes and the rest off the wire. If you read a
   new field from a client row in this file, add it here or it will be
   undefined — the tests check the ones that are used. */
async function obClient(clientId){
  return obRun(() => sb.from('clients')
    .select('id,company,contact_name,contact_email,booking_id,plan,term,stage,inputs_complete_on,day1_on')
    .eq('id', clientId).maybeSingle(), null);
}

/* The agreements table has no client_id: it is matched on the booking it came
   from, and failing that on the email the agreement was made out to.
   A caller that has already read the client row passes it in as `known`, so
   the same row is not read twice in one screen. */
async function obAgreement(clientId, known){
  const c = known ? obOk(known) : await obClient(clientId);
  if (!c.ok) return c;
  if (!c.data) return obErr('That client is not on file.');
  const cl = c.data;
  let row = null;
  if (cl.booking_id) {
    const byBooking = await obRun(() => sb.from('agreements').select('*')
      .eq('booking_id', cl.booking_id).order('created_at', {ascending:false}).limit(1), []);
    if (!byBooking.ok) return byBooking;
    row = (byBooking.data || [])[0] || null;
  }
  if (!row && obText(cl.contact_email)) {
    const byEmail = await obRun(() => sb.from('agreements').select('*')
      .eq('client_email', cl.contact_email).order('created_at', {ascending:false}).limit(1), []);
    if (!byEmail.ok) return byEmail;
    row = (byEmail.data || [])[0] || null;
  }
  return obOk({client: cl, row, state: obAgreementState(row), words: obAgreementWords(row)});
}

async function obProfile(clientId){
  return obRun(() => sb.from('client_profiles').select('*').eq('client_id', clientId).maybeSingle(), null);
}
async function obPeople(clientId){
  return obRun(() => sb.from('client_people').select('id,client_id,full_name,email,is_primary,created_at')
    .eq('client_id', clientId).order('created_at'), []);
}
/* Only what "was the strategy call held?" needs. `meetings` has 21 columns. */
async function obStrategyMeetings(clientId){
  return obRun(() => sb.from('meetings').select('id,client_id,kind,starts_at,status,held_at')
    .eq('client_id', clientId)
    .eq('kind', 'strategy').order('starts_at', {ascending:false}), []);
}

/* ---- the checklist ------------------------------------------------ */

/* The gate. Seven items, each read from the row that proves it. Nothing here
   can be ticked by hand: there is no flag to set. */
async function obChecklist(clientId){
  const c = await obClient(clientId);
  if (!c.ok) return c;
  if (!c.data) return obErr('That client is not on file.');
  const client = c.data;

  /* None of these five depends on another, so they go together instead of one
     after the next: one screen's wait instead of five. The client row is
     handed to obAgreement so it is not read a second time. They are still
     checked in the same order, so the same failure is still the one reported. */
  const [ag, pr, pe, me, inv] = await Promise.all([
    obAgreement(clientId, client),
    obProfile(clientId),
    obPeople(clientId),
    obStrategyMeetings(clientId),
    typeof fnInvoices === 'function' ? fnInvoices(clientId) : obOk([]),
  ]);
  if (!ag.ok) return ag;
  if (!pr.ok) return pr;
  if (!pe.ok) return pe;
  if (!me.ok) return me;
  if (!inv.ok) return obErr(inv.error);

  return obOk(obChecklistFrom(client, {
    agreement: (ag.data || {row:null, state:'none'}).row,
    profile:   pr.data || null,
    people:    pe.data || [],
    meetings:  me.data || [],
    invoices:  inv.data || [],
  }));
}

/* The seven items, worked out from rows that are already in hand. PURE: it reads
   nothing, so the one screen that needs a dozen clients' checklists can read the
   rows for all of them in six queries and then call this once per client (see
   obChecklistMany), instead of six queries EACH. */
function obChecklistFrom(client, rows){
  const r = rows || {};
  const agreeRow = r.agreement || null;
  const agree    = {row: agreeRow, state: obAgreementState(agreeRow)};
  const profile  = r.profile || null;
  const people   = Array.isArray(r.people) ? r.people : [];
  const meetings = Array.isArray(r.meetings) ? r.meetings : [];
  const invoices = Array.isArray(r.invoices) ? r.invoices : [];
  const clientId = client && client.id;
  const paid     = invoices.filter(i => obText(i.status).toLowerCase() === 'paid');
  const primary  = people.find(p => p && p.is_primary) || null;
  const held     = meetings.find(obMeetingHeld) || null;
  const blank    = obMissingField(profile);

  const items = [
    {key:'agreement',  label:'Agreement signed',              done: agree.state === 'signed',
     detail: obAgreementWords(agree.row), why:'Their signed agreement is not on file yet.'},
    {key:'paid',       label:'Deposit or first invoice paid',  done: paid.length > 0,
     detail: paid.length ? obMoney(paid[0].amount) + ' paid' : (invoices.length ? 'Invoice raised, not paid' : 'No invoice yet'),
     why: invoices.length ? 'Their first invoice has not been paid yet.' : 'No invoice has been raised for them yet.'},
    {key:'inputs',     label:'Inputs filled and signed off',   done: Boolean(profile && profile.signed_off_at),
     detail: profile && profile.signed_off_at ? 'Signed off' : (blank ? 'Still need ' + blank.label : 'Filled, not signed off'),
     why: blank ? 'We still need ' + blank.label + '.' : 'Their inputs are filled but nobody has signed them off.'},
    {key:'calendar',   label:'Calendar link',                  done: obFilled(profile, 'calendar_url'),
     detail: obText(profile && profile.calendar_url) || 'Missing', why:'We do not have their calendar link.'},
    {key:'contact',    label:'Primary contact',                done: Boolean(primary),
     detail: primary ? obText(primary.full_name) : (people.length ? 'Nobody marked as the main one' : 'Nobody on file'),
     why: people.length ? 'None of their people is marked as the main contact.' : 'Nobody from their side is on file yet.'},
    {key:'neverEmail', label:'Do-not-email list',              done: obNeverEmailRecorded(profile && profile.never_email),
     detail: obNoneSaid(profile && profile.never_email) ? 'Nobody to exclude' : (obLines(profile && profile.never_email).length ? obLines(profile.never_email).length + ' on the list' : 'Not asked yet'),
     why:'We have not recorded who never to contact. "Nobody" is an answer, but it has to be recorded.'},
    {key:'strategy',   label:'Strategy call held',             done: Boolean(held),
     detail: held ? 'Held' : (meetings.length ? 'Booked, not held yet' : 'Not booked'),
     why: meetings.length ? 'Their strategy call is booked but has not been held yet.' : 'Their strategy call has not been booked yet.'},
  ];
  const left  = items.filter(i => !i.done);
  return {
    clientId, client, profile, people, meetings, invoices,
    agreement: agree.row, agreementState: agree.state,
    items, ready: left.length === 0, missing: left,
    blocking: left.length ? left[0].why : '',
    blockingLabel: left.length ? left[0].label : '',
  };
}

/* Everyone's checklist at once. The screen that lists the clients being
   onboarded used to call obChecklist per client — seven queries each, so a dozen
   clients was eighty-four round trips. This reads the same rows for the whole
   list in six, and works each checklist out from them in memory. The order of
   `clients` is the order of the answer, and a client with no rows comes back
   with the same "nothing yet" items obChecklist would have given.

   The agreements table has no client_id, so it is matched the same two ways as
   obAgreement does for one client: on the booking first, then on the email. */
async function obChecklistMany(clients){
  const list = (Array.isArray(clients) ? clients : []).filter(c => c && c.id != null);
  if (!list.length) return obOk([]);
  const ids      = list.map(c => c.id);
  const bookings = list.map(c => c.booking_id).filter(Boolean);
  const emails   = list.map(c => obText(c.contact_email)).filter(Boolean);

  const [agByBooking, agByEmail, prs, pes, mes, invs] = await Promise.all([
    bookings.length ? obRun(() => sb.from('agreements').select('*')
      .in('booking_id', bookings).order('created_at', {ascending:false}), []) : obOk([]),
    emails.length ? obRun(() => sb.from('agreements').select('*')
      .in('client_email', emails).order('created_at', {ascending:false}), []) : obOk([]),
    obRun(() => sb.from('client_profiles').select('*').in('client_id', ids), []),
    obRun(() => sb.from('client_people').select('id,client_id,full_name,email,is_primary,created_at')
      .in('client_id', ids).order('created_at'), []),
    obRun(() => sb.from('meetings').select('id,client_id,kind,starts_at,status,held_at')
      .in('client_id', ids).eq('kind', 'strategy').order('starts_at', {ascending:false}), []),
    /* KNOWN, NOT FIXED HERE. This reads EVERY invoice there has ever been and
       then keeps the handful belonging to these clients. A read with no range
       in it is answered out of one page, so past that page's ceiling the
       oldest clients' invoices are simply not in the answer — and this screen
       then tells the owner that a client who paid months ago "has not paid
       yet", and holds up their day one. The fix is one line in finance.js:
       fnInvoices should take a list of client ids and filter on it. The house
       rule (tests/onboarding.test.mjs) is that this file never reads the
       invoices table itself, so the fix does not belong here. */
    typeof fnInvoices === 'function' ? fnInvoices() : obOk([]),
  ]);
  /* The same order of reporting as obChecklist: the agreement first. */
  for (const r of [agByBooking, agByEmail, prs, pes, mes, invs]) if (!r.ok) return r;

  const byBooking = {}, byEmail = {};
  (agByBooking.data || []).forEach(a => { const k = String(a.booking_id);
    if (a && a.booking_id != null && !(k in byBooking)) byBooking[k] = a });
  (agByEmail.data || []).forEach(a => { const k = String(a.client_email);
    if (a && a.client_email && !(k in byEmail)) byEmail[k] = a });
  const group = (rows, key) => {
    const out = {};
    (rows || []).forEach(r => { if (!r) return; const k = String(r[key || 'client_id']);
      (out[k] || (out[k] = [])).push(r) });
    return out;
  };
  const profiles = group(prs.data), peopleBy = group(pes.data),
        meetsBy  = group(mes.data), invBy = group(invs.data);

  return obOk(list.map(c => {
    const k = String(c.id);
    const agreement = (c.booking_id && byBooking[String(c.booking_id)])
      || (obText(c.contact_email) && byEmail[obText(c.contact_email)]) || null;
    return obChecklistFrom(c, {
      agreement,
      profile:  (profiles[k] || [])[0] || null,
      people:   peopleBy[k] || [],
      meetings: meetsBy[k] || [],
      invoices: invBy[k] || [],
    });
  }));
}

/* Day one. Refuses unless every item is done, and says which one is missing.
   The month clock is the finance side's: fnStartSending sets the anchor and
   opens month one. We never work out a date or a fee here. */
async function obStart(clientId){
  const ck = await obChecklist(clientId);
  if (!ck.ok) return ck;
  const already = obText(ck.data.client && ck.data.client.day1_on);
  /* DAY ONE HAPPENS ONCE. fnStartSending writes day1_on, and day1_on is the
     anchor every month boundary of this client is counted from — month n runs
     day1_on + (n-1) months to the day before day1_on + n months. So starting a
     second time would move EVERY boundary to today: a call on the last evening
     of a month would fall into the next one, and the day a refund becomes due
     would move with it.

     Nothing else stops that. The checklist is read from rows, and those rows do
     not go away on day one, so it stays green and the button stays enabled; a
     double click, a stale screen or an impatient second tap is enough. The
     guard has to be here, in the data function, not on the button. */
  if (already) return obErr('They are already live — day one was ' + already + ', and the months are counted from it. It is set once and cannot be moved from here.');
  if (!ck.data.ready) {
    const left = ck.data.missing;
    const more = left.length > 1 ? ' ' + (left.length - 1) + ' other thing' + (left.length === 2 ? '' : 's') + ' still to do.' : '';
    return obErr('Not ready to start: ' + left[0].why + more);
  }
  const day1 = obTodayUs();
  const marked = await obRun(() => sb.from('clients')
    .update({inputs_complete_on: ck.data.client.inputs_complete_on || day1})
    .eq('id', clientId).select().single(), null);
  if (!marked.ok) return marked;

  /* This one write sets day1_on AND stage 'live', and the database's own
     clients_first_month trigger opens month one and ties the first invoice to
     it — all in the one statement, so it either all happened or none of it did.
     There used to be a third write here setting stage 'live' a second time. It
     was a second way of saying what fnStartSending had already said, and the
     gap between the two was a window where a dropped connection left a client
     live, with a month open, still reading "onboarding" on every screen. */
  const started = typeof fnStartSending === 'function'
    ? await fnStartSending(clientId, day1)
    : obErr('The finance side is not loaded, so month one cannot be opened.');
  if (!started.ok) return obErr(started.error);

  return obOk({client: (started.data && started.data.client) || null,
               month: started.data && started.data.month, day1On: day1});
}

/* ---- their inputs ------------------------------------------------- */

/* The form behind client_profiles: the row, what is still blank, and whether
   it has been signed off. */
async function obInputs(clientId){
  const pr = await obProfile(clientId);
  if (!pr.ok) return pr;
  const p = pr.data || null;
  return obOk({
    clientId,
    profile: p,
    fields: {
      sellsWhat:    obText(p && p.sells_what),
      sellsTo:      obText(p && p.sells_to),
      icp:          obJsonText(p && p.icp),
      neverEmail:   obJsonText(p && p.never_email),
      neverEmailNone: obNoneSaid(p && p.never_email),
      calendarUrl:  obText(p && p.calendar_url),
      slotsPerWeek: p && p.slots_per_week != null ? String(p.slots_per_week) : '',
      senderName:   obText(p && p.sender_name),
      senderTitle:  obText(p && p.sender_title),
      timeZone:     obText(p && p.time_zone),
    },
    missing: OB_REQUIRED.filter(f => !obFilled(p, f[0])).map(f => ({field:f[0], label:f[1]})),
    signedOffAt: (p && p.signed_off_at) || null,
  });
}

/* Save what they told us. Blanks are allowed here — sign-off is the gate. */
async function obSaveInputs(clientId, fields){
  const f = fields || {};
  const row = {client_id: clientId, updated_at: new Date().toISOString()};
  if (f.sellsWhat    !== undefined) row.sells_what   = obText(f.sellsWhat) || null;
  if (f.sellsTo      !== undefined) row.sells_to     = obText(f.sellsTo) || null;
  if (f.icp          !== undefined) row.icp          = obLines(f.icp);
  if (f.neverEmail   !== undefined || f.neverEmailNone !== undefined) {
    const list = obLines(f.neverEmail);
    row.never_email = (!list.length && f.neverEmailNone) ? {none:true} : list;
  }
  if (f.calendarUrl  !== undefined) row.calendar_url = obText(f.calendarUrl) || null;
  if (f.slotsPerWeek !== undefined) row.slots_per_week = Number(f.slotsPerWeek) > 0 ? Math.round(Number(f.slotsPerWeek)) : null;
  if (f.senderName   !== undefined) row.sender_name  = obText(f.senderName) || null;
  if (f.senderTitle  !== undefined) row.sender_title = obText(f.senderTitle) || null;
  if (f.timeZone     !== undefined) row.time_zone    = obText(f.timeZone) || null;
  return obRun(() => sb.from('client_profiles')
    .upsert(row, {onConflict:'client_id'}).select().single(), null);
}

/* Sign-off is what the checklist reads, so it refuses while anything is blank
   and names the one thing it wants. */
async function obSignOff(clientId){
  const pr = await obProfile(clientId);
  if (!pr.ok) return pr;
  if (!pr.data) return obErr('Their inputs have not been filled in yet.');
  const blank = obMissingField(pr.data);
  if (blank) return obErr('Cannot sign off yet: we still need ' + blank.label + '.');
  return obRun(() => sb.from('client_profiles')
    .update({signed_off_at: new Date().toISOString(), updated_at: new Date().toISOString()})
    .eq('client_id', clientId).select().single(), null);
}

/* ---- the agreement ------------------------------------------------ */

/* "growth" -> "Growth"; a plan code no longer on offer -> "Retired plan" (finance.js). */
function obPlanWord(plan){ return fnPlanWord(plan) || obText(plan) }

/* Build the agreements row from the client and plan_prices. The fee is read,
   never worked out here: plan_prices is the only place a price lives. */
async function obDraftAgreement(clientId){
  const c = await obClient(clientId);
  if (!c.ok) return c;
  if (!c.data) return obErr('That client is not on file.');
  const cl = c.data;

  const existing = await obAgreement(clientId);
  if (!existing.ok) return existing;
  if (existing.data.row) return obOk(existing.data.row);   // never draft twice

  /* a client left on a plan that is no longer sold gets no new agreement */
  if (fnPlanRetired(cl.plan)) return obErr('That plan is retired. They need to be on Starter, Growth or Scale before an agreement can be drafted.');
  const plans = await fnPlans();
  if (!plans.ok) return obErr(plans.error);
  const p = (plans.data || []).find(x => x && x.plan === cl.plan);
  if (!p) return obErr('There is no price on file for that plan.');
  const threeMonth = cl.term === '3month';
  const fee = threeMonth && p.three_month_fee ? p.three_month_fee : p.monthly_fee;

  const made = await obRun(() => sb.from('agreements').insert({
    booking_id:     cl.booking_id || null,
    client_name:    cl.contact_name,
    client_email:   cl.contact_email,
    client_company: cl.company,
    plan:           cl.plan,
    term:           threeMonth ? '3month' : 'monthly',
    monthly_fee:    fee,
    status:         'draft',
  }).select().single(), null);
  if (!made.ok) return made;

  // TODO: send the agreement to them (Gmail), then write gmail_message_id and
  //       status 'sent' back on this row. Nothing is sent from here.
  // TODO: render the PDF and store it in agreement_pdfs (key, filename, b64).
  return made;
}

/* ---- screens: state and loading ----------------------------------- */

const ob = {list:null, listErr:'', one:null, oneErr:'', billing:null, billErr:'', busy:false, clientId:null};

function obHost(){ return typeof document !== 'undefined' && document.getElementById ? document.getElementById('obHost') : null }
function obPaint(html){ const h = obHost(); if (h) h.innerHTML = html; return Boolean(h) }
/* The shell's own icon set, or nothing. DESIGN.md has six motifs and a bare
   typographic ring is not one of them. */
function obIcon(name){ return (typeof I !== 'undefined' && I && I[name]) || '' }
function obSay(msg){ if (typeof toast === 'function') toast(msg) }

/* Everyone still being onboarded, each with their checklist. */
async function obLoadList(){
  ob.listErr = '';
  const cs = typeof fnClients === 'function' ? await fnClients() : obOk([]);
  if (!cs.ok) { ob.listErr = cs.error; ob.list = []; return obErr(cs.error); }
  const mine = (cs.data || []).filter(c => c && OB_STAGES.includes(obText(c.stage)));
  /* Every checklist out of ONE set of reads. This used to be obChecklist per
     client — seven queries each, fired together but still seven times the
     clients' worth of traffic, and it grew with every client won. Now it is six
     queries whatever the length of the list. */
  const all = await obChecklistMany(mine);
  if (!all.ok) { ob.listErr = all.error; ob.list = []; return all; }
  ob.list = all.data;
  return all;
}
async function obLoadOne(clientId){
  ob.oneErr = ''; ob.clientId = clientId;
  const ck = await obChecklist(clientId);
  if (!ck.ok) { ob.oneErr = ck.error; ob.one = null; return ck; }
  /* The checklist already read the profile and the agreement, so these two
     come out of it rather than off the wire again. */
  const [inp, ag] = await Promise.all([obInputs(clientId), obAgreement(clientId, ck.data.client)]);
  ob.one = {check: ck.data, inputs: inp.ok ? inp.data : null, agreement: ag.ok ? ag.data : null};
  return obOk(ob.one);
}
async function obLoadBilling(){
  ob.billErr = '';
  const work = typeof fnInvoiceWork === 'function' ? await fnInvoiceWork() : obOk([]);
  const list = typeof fnInvoices === 'function' ? await fnInvoices() : obOk([]);
  if (!work.ok) { ob.billErr = work.error; }
  else if (!list.ok) { ob.billErr = list.error; }
  ob.billing = {work: work.ok ? (work.data || []) : [], invoices: list.ok ? (list.data || []) : []};
  return ob.billErr ? obErr(ob.billErr) : obOk(ob.billing);
}

/* ---- screens: the ticks ------------------------------------------- */

function obTick(done){
  return `<span class="ob-tick${done ? ' on' : ''}" aria-hidden="true">${done ? '✓' : '·'}</span>`;
}
function obTickRow(items){
  const list = items && items.length ? items : OB_ITEMS.map(i => ({key:i[0], label:i[1], done:false, detail:''}));
  return `<span class="ob-ticks">${list.map(i =>
    `<span class="ob-ticks-one" title="${obEsc(i.label + (i.detail ? ' — ' + i.detail : ''))}">${obTick(i.done)}</span>`).join('')}</span>`;
}
function obRenderChecklist(check){
  const items = (check && check.items) || [];
  if (!items.length) return `<p class="muted">Nothing to check yet.</p>`;
  return `<ul class="ob-check">${items.map(i => `<li class="ob-check-item${i.done ? ' done' : ''}">
    ${obTick(i.done)}<span class="ob-check-label">${obEsc(i.label)}</span>
    <span class="ob-check-detail">${obEsc(i.done ? (i.detail || 'Done') : (i.detail || 'Not yet'))}</span></li>`).join('')}</ul>`;
}

/* ---- screen: everyone being onboarded ----------------------------- */

function obRenderOnboarding(){
  if (ob.listErr) return `<div class="card ob-card"><b>We could not read the list</b><p class="muted">${obEsc(ob.listErr)}</p></div>`;
  if (ob.list === null) return `<div class="card ob-card"><b>Reading the list…</b><p class="muted">One moment.</p></div>`;
  if (!ob.list.length) {
    return typeof emptyState === 'function'
      ? emptyState(obIcon('steps'), 'Nobody is being onboarded', 'A client appears here the moment a deal is won, and leaves it on day one.', '', '')
      : `<div class="card ob-card"><b>Nobody is being onboarded</b><p class="muted">A client appears here the moment a deal is won.</p></div>`;
  }
  const head = `<div class="ob-row ob-row-head"><span class="ob-who">Client</span>${obTickRow(OB_ITEMS.map(i => ({key:i[0], label:i[1], done:false, detail:''})))}<span class="ob-block">What is blocking them</span></div>`;
  const rows = ob.list.map(r => {
    const name = obText(r.client && r.client.company) || 'A client';
    const go = `obOpenClient(${obArg(r.clientId)})`;
    return `<div class="ob-row"><button type="button" class="ob-who ob-go" onclick="${go}"><b>${obEsc(name)}</b><span class="muted">${obEsc(obPlanWord(r.client && r.client.plan))}</span></button>
      ${obTickRow(r.items)}
      <span class="ob-block${r.ready ? ' ready' : ''}">${obEsc(r.ready ? 'Ready to start' : (r.blocking || 'Something still to do'))}</span></div>`;
  }).join('');
  return `<div class="section-head"><h3>Being onboarded</h3><span class="count">${ob.list.length}</span></div>
    <div class="ob-list">${head}${rows}</div>`;
}
function viewOnboarding(){
  ob.list = null; ob.listErr = '';
  Promise.resolve(obLoadList()).then(() => obPaint(obRenderOnboarding())).catch(() => {});
  return `<div id="obHost">${obRenderOnboarding()}</div>`;
}

/* ---- screen: one client ------------------------------------------- */

function obRenderInputsForm(inputs){
  const f = (inputs && inputs.fields) || {};
  const signed = inputs && inputs.signedOffAt;
  const need = (inputs && inputs.missing) || [];
  const row = (id, label, value, hint, type) => `<label class="ob-field"><span>${obEsc(label)}</span>
    ${type === 'area'
      ? `<textarea id="${id}" rows="3" placeholder="${obEsc(hint||'')}">${obEsc(value)}</textarea>`
      : `<input id="${id}" type="${type||'text'}" value="${obEsc(value)}" placeholder="${obEsc(hint||'')}">`}</label>`;
  return `<form class="ob-form" onsubmit="return false">
    ${row('obSellsWhat', 'What they sell', f.sellsWhat || '', 'Roof repairs for commercial buildings', 'area')}
    ${row('obSellsTo', 'Who they sell to', f.sellsTo || '', 'Facility managers in the north-east')}
    ${row('obIcp', 'Who to approach (one a line)', f.icp || '', '50–500 staff\nOwns the building', 'area')}
    ${row('obNeverEmail', 'Never contact (one a line)', f.neverEmail || '', 'oldcustomer.com\nsam@rival.com', 'area')}
    <label class="ob-check-line"><input type="checkbox" id="obNeverEmailNone"${f.neverEmailNone ? ' checked' : ''}><span>Nobody to exclude</span></label>
    ${row('obCalendarUrl', 'Their calendar link', f.calendarUrl || '', 'https://calendly.com/…', 'url')}
    ${row('obSlots', 'Call slots a week', f.slotsPerWeek || '', '10', 'number')}
    ${row('obSenderName', "The sender's name", f.senderName || '', 'Sam Perera')}
    ${row('obSenderTitle', "The sender's title", f.senderTitle || '', 'Head of Partnerships')}
    ${row('obTimeZone', 'Their time zone', f.timeZone || '', 'America/New_York')}
    <div class="ob-form-foot">
      <button type="button" class="btn" onclick="obSaveInputsFromForm()">Save their inputs</button>
      <button type="button" class="btn ghost" onclick="obSignOffFromForm()"${signed ? ' disabled' : ''}>${signed ? 'Signed off' : 'Sign the inputs off'}</button>
      ${need.length ? `<span class="ob-need">We still need ${obEsc(need[0].label)}.</span>` : ''}
      <span class="ob-err" id="obInputsErr"></span>
    </div></form>`;
}
function obRenderAgreementCard(ag, clientId){
  const row = ag && ag.row;
  return `<div class="card ob-card"><div class="ob-card-head"><b>The agreement</b><span class="pill ${obAgreementState(row) === 'signed' ? 'green' : 'grey'}">${obEsc(obAgreementWords(row))}</span></div>
    ${row ? `<p class="muted">${obEsc(obText(row.client_company))} · ${obEsc(obPlanWord(row.plan))}${fnPlanRetired(row.plan) ? '' : ` · ${obEsc(row.term === '3month' ? '3-month term' : 'monthly')} · ${obEsc(obMoney(row.monthly_fee))} a month`}</p>`
          : `<p class="muted">No agreement has been drafted for them yet.</p>`}
    ${row ? '' : `<button type="button" class="btn" onclick="obDraftAgreementGo(${obArg(clientId)})">Draft the agreement</button>`}</div>`;
}
function obRenderOnboardingClient(){
  if (ob.oneErr) return `<div class="card ob-card"><b>We could not open this client</b><p class="muted">${obEsc(ob.oneErr)}</p><p><button type="button" class="btn ghost" onclick="obRetryOne()">Try again</button></p></div>`;
  if (!ob.one) return `<div class="card ob-card"><b>Opening…</b><p class="muted">One moment.</p></div>`;
  const ck = ob.one.check || {};
  const name = obText(ck.client && ck.client.company) || 'This client';
  const ready = Boolean(ck.ready);
  const why = ready ? '' : (ck.blocking || 'Something still to do.');
  return `<div class="ob-one">
    <div class="section-head"><h3>${obEsc(name)}</h3><span class="muted">${obEsc(obText(ck.client && ck.client.stage))}</span></div>
    <div class="card ob-card"><div class="ob-card-head"><b>Before day one</b>${obTickRow(ck.items)}</div>
      ${obRenderChecklist(ck)}
      <div class="ob-start">
        <button type="button" class="btn" onclick="obStartGo(${obArg(ck.clientId)})"${ready ? '' : ' disabled aria-disabled="true"'} title="${obEsc(why || 'Everything is done')}">Start them</button>
        <span class="ob-start-why">${obEsc(ready ? 'Everything is done — this opens month one.' : why)}</span>
      </div></div>
    ${obRenderAgreementCard(ob.one.agreement, ck.clientId)}
    <div class="card ob-card"><div class="ob-card-head"><b>Their inputs</b>${ob.one.inputs && ob.one.inputs.signedOffAt ? '<span class="pill green">Signed off</span>' : '<span class="pill grey">Not signed off</span>'}</div>
      ${obRenderInputsForm(ob.one.inputs)}</div></div>`;
}
function viewOnboardingClient(clientId){
  ob.one = null; ob.oneErr = ''; ob.clientId = clientId || null;
  if (clientId) Promise.resolve(obLoadOne(clientId)).then(() => obPaint(obRenderOnboardingClient())).catch(() => {});
  else ob.oneErr = 'No client was asked for.';
  return `<div id="obHost">${obRenderOnboardingClient()}</div>`;
}
function obOpenClient(clientId){
  if (typeof render === 'function') { ob.clientId = clientId; render('onboardingClient'); return; }
  viewOnboardingClient(clientId);
}

/* ---- screen: billing ---------------------------------------------- */

function obInvoiceRow(inv){
  const st = obText(inv.status).toLowerCase();
  const btns = [];
  if (st === 'draft' || st === 'raised' || st === 'issued') btns.push(`<button type="button" class="btn" onclick="obMarkSentGo(${obArg(inv.id)})">Mark sent</button>`);
  if (st !== 'paid' && st !== 'void' && st !== 'cancelled') btns.push(`<button type="button" class="btn ghost" onclick="obMarkPaidGo(${obArg(inv.id)})">Mark paid</button>`);
  return `<li class="ob-inv"><span class="ob-inv-no">${obEsc(obText(inv.number) || '—')}</span>
    <span class="ob-inv-who">${obEsc(obText(inv.client_name || inv.company) || '')}</span>
    <span class="ob-inv-sum"><b class="fig">${obEsc(obMoney(inv.amount))}</b>${inv.due_on ? ` <span class="muted">· due ${obEsc(obText(inv.due_on))}${Number(inv.days_overdue) > 0 ? ` · ${obEsc(String(inv.days_overdue))} days late` : ''}</span>` : ''}</span>
    <span class="pill ${st === 'paid' ? 'green' : st === 'sent' ? 'amber' : 'grey'}">${obEsc(obText(inv.status) || 'draft')}</span>
    <span class="ob-inv-btns">${btns.join('')}</span></li>`;
}
function obRenderBilling(){
  if (ob.billErr) return `<div class="card ob-card"><b>We could not read the invoices</b><p class="muted">${obEsc(ob.billErr)}</p></div>`;
  if (!ob.billing) return `<div class="card ob-card"><b>Reading the invoices…</b><p class="muted">One moment.</p></div>`;
  const work = ob.billing.work || [];
  const invoices = ob.billing.invoices || [];
  // v_invoice_work lists open invoices (with the company and due date); only a month row with no invoice yet is "to raise"
  const toRaise = work.filter(w => w.month_id && !w.invoice_id);
  const byId = {}; work.forEach(w => { if (w.id) byId[w.id] = w; });
  const open = invoices.filter(i => !['paid', 'void', 'cancelled'].includes(obText(i.status).toLowerCase()))
    .map(i => Object.assign({}, i, byId[i.id] ? {company: byId[i.id].company, days_overdue: byId[i.id].days_overdue, action_needed: byId[i.id].action_needed} : {}));

  const raiseBlock = toRaise.length
    ? `<ul class="ob-inv-list">${toRaise.map(w => `<li class="ob-inv"><span class="ob-inv-who">${obEsc(obText(w.company || w.client_name) || 'A client')}</span>
        <span class="ob-inv-sum muted">Month ${obEsc(String(w.month_no == null ? '' : w.month_no))}</span>
        <span class="ob-inv-btns"><button type="button" class="btn" onclick="obRaiseGo(${obArg(w.month_id)})">Raise the invoice</button></span></li>`).join('')}</ul>`
    : `<p class="muted">Nothing to raise.</p>`;
  const openBlock = open.length
    ? `<ul class="ob-inv-list">${open.map(obInvoiceRow).join('')}</ul>`
    : `<p class="muted">Nothing to send or chase.</p>`;

  if (!toRaise.length && !open.length) {
    return typeof emptyState === 'function'
      ? emptyState(obIcon('money'), 'No invoices need you', 'Invoices to raise, send and chase show up here as months open.', '', '')
      : `<div class="card ob-card"><b>No invoices need you</b><p class="muted">Invoices show up here as months open.</p></div>`;
  }
  return `<div class="section-head"><h3>To raise</h3>${toRaise.length ? `<span class="count">${toRaise.length}</span>` : ''}</div>
    <div class="card ob-card">${raiseBlock}</div>
    <div class="section-head"><h3>To send or chase</h3>${open.length ? `<span class="count">${open.length}</span>` : ''}</div>
    <div class="card ob-card">${openBlock}</div>`;
}
function viewBilling(){
  ob.billing = null; ob.billErr = '';
  Promise.resolve(obLoadBilling()).then(() => obPaint(obRenderBilling())).catch(() => {});
  return `<div id="obHost">${obRenderBilling()}</div>`;
}

/* ---- the buttons -------------------------------------------------- */

function obFormFields(){
  const v = (id) => (typeof val === 'function' ? val(id) : '');
  const checked = (id) => {
    const e = typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
    return Boolean(e && e.checked);
  };
  return {
    sellsWhat: v('obSellsWhat'), sellsTo: v('obSellsTo'), icp: v('obIcp'),
    neverEmail: v('obNeverEmail'), neverEmailNone: checked('obNeverEmailNone'),
    calendarUrl: v('obCalendarUrl'), slotsPerWeek: v('obSlots'),
    senderName: v('obSenderName'), senderTitle: v('obSenderTitle'), timeZone: v('obTimeZone'),
  };
}
/* Re-read one client and draw them again — unless the re-read fails while a
   good screen is already up. Then the screen stays (with whatever is typed in
   it) and a line says it may be out of date; a failed refresh is not a reason
   to take a working form away from somebody. */
async function obRedrawOne(clientId){
  const was = ob.one;
  const r = await obLoadOne(clientId);
  if (!r.ok && was) {
    ob.one = was; ob.oneErr = '';
    obSay('This screen could not be refreshed, so it may be out of date. ' + r.error);
    return r;
  }
  obPaint(obRenderOnboardingClient());
  return r;
}
function obRetryOne(){ return coreOnce('ob:retry', async () => { if (ob.clientId) { await obLoadOne(ob.clientId); obPaint(obRenderOnboardingClient()); } }) }
function obShowInputsErr(msg){
  if (typeof errEl === 'function') errEl('obInputsErr', msg || '');
  if (msg) obSay(msg);
}
function obSaveInputsFromForm(){ return coreOnce('ob:inputs', async () => {
  if (!ob.clientId) return;
  const r = await obSaveInputs(ob.clientId, obFormFields());
  obShowInputsErr(r.ok ? '' : r.error);
  /* A save that failed leaves the form exactly as it was typed. This used to
     re-read the client and redraw whatever came back — and when the save failed
     because the connection had gone, the re-read failed too, so the whole form
     was replaced by "We could not open this client" and everything typed went
     with it. */
  if (!r.ok) return r;
  obSay('Their inputs are saved.');
  await obRedrawOne(ob.clientId);
  return r;
}, typeof document !== 'undefined' ? document.activeElement : null) }
function obSignOffFromForm(){ return coreOnce('ob:inputs', async () => {
  if (!ob.clientId) return;
  const saved = await obSaveInputs(ob.clientId, obFormFields());
  if (!saved.ok) { obShowInputsErr(saved.error); return; }
  const r = await obSignOff(ob.clientId);
  if (r.ok) obSay('Their inputs are signed off.');
  await obRedrawOne(ob.clientId);
  /* after the redraw, or the new form would be drawn over the sentence */
  obShowInputsErr(r.ok ? '' : r.error);
  return r;
}, typeof document !== 'undefined' ? document.activeElement : null) }
function obStartGo(clientId){ return coreOnce('ob:start:'+clientId, async () => {
  const r = await obStart(clientId);
  obSay(r.ok ? 'They are live. Month one is open.' : r.error);
  await obRedrawOne(clientId);
}, typeof document !== 'undefined' ? document.activeElement : null) }
function obDraftAgreementGo(clientId){ return coreOnce('ob:agreement:'+clientId, async () => {
  const r = await obDraftAgreement(clientId);
  obSay(r.ok ? 'The agreement is drafted. Nothing has been sent.' : r.error);
  await obRedrawOne(clientId);
}, typeof document !== 'undefined' ? document.activeElement : null) }
function obRaiseGo(monthId){ return coreOnce('ob:raise:'+monthId, async () => {
  const r = typeof fnRaiseInvoice === 'function' ? await fnRaiseInvoice(monthId, 0) : obErr('The finance side is not loaded.');
  obSay(r.ok ? (r.data ? 'The invoice is raised.' : 'Nothing to bill for that month — a three-month term bills on months one, four and seven.') : r.error);
  await obLoadBilling(); obPaint(obRenderBilling());
}, typeof document !== 'undefined' ? document.activeElement : null) }
function obMarkSentGo(invoiceId){ return coreOnce('ob:sent:'+invoiceId, async () => {
  const r = typeof fnMarkInvoiceSent === 'function' ? await fnMarkInvoiceSent(invoiceId) : obErr('The finance side is not loaded.');
  obSay(r.ok ? 'Marked as sent.' : r.error);
  await obLoadBilling(); obPaint(obRenderBilling());
}, typeof document !== 'undefined' ? document.activeElement : null) }
function obMarkPaidGo(invoiceId, via){ return coreOnce('ob:paid:'+invoiceId, async () => {
  const r = typeof fnMarkInvoicePaid === 'function' ? await fnMarkInvoicePaid(invoiceId, via || 'bank transfer') : obErr('The finance side is not loaded.');
  obSay(r.ok ? (typeof fnPaidWords === 'function' ? fnPaidWords(r.data) : 'Marked paid.') : r.error);
  await obLoadBilling(); obPaint(obRenderBilling());
}, typeof document !== 'undefined' ? document.activeElement : null) }
