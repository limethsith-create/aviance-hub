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

function obOk(data){ return {ok:true, data, error:''} }
function obErr(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return {ok:false, data:null, error:m};
}
function obWrap(res, whenEmpty){
  if (!res) return obErr('No answer from the database.');
  if (res.error) return obErr(res.error);
  return obOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
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
function obEsc(s){ return typeof esc === 'function' ? esc(s) : obText(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function obArg(v){ return obEsc(JSON.stringify(obText(v))) }
function obToday(){ return new Date().toISOString().slice(0,10) }
function obMoney(n){ return typeof fnUsd === 'function' ? fnUsd(n) : '$' + (Math.round(Number(n)||0)).toLocaleString('en-US') }

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

async function obClient(clientId){
  return obRun(() => sb.from('clients').select('*').eq('id', clientId).maybeSingle(), null);
}

/* The agreements table has no client_id: it is matched on the booking it came
   from, and failing that on the email the agreement was made out to. */
async function obAgreement(clientId){
  const c = await obClient(clientId);
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
  return obRun(() => sb.from('client_people').select('*').eq('client_id', clientId).order('created_at'), []);
}
async function obStrategyMeetings(clientId){
  return obRun(() => sb.from('meetings').select('*').eq('client_id', clientId)
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

  const ag = await obAgreement(clientId);          if (!ag.ok) return ag;
  const agree = ag.data || {row:null, state:'none'};
  const pr = await obProfile(clientId);            if (!pr.ok) return pr;
  const pe = await obPeople(clientId);             if (!pe.ok) return pe;
  const me = await obStrategyMeetings(clientId);   if (!me.ok) return me;
  const inv = typeof fnInvoices === 'function' ? await fnInvoices(clientId) : obOk([]);
  if (!inv.ok) return obErr(inv.error);

  const profile  = pr.data || null;
  const people   = pe.data || [];
  const meetings = me.data || [];
  const invoices = inv.data || [];
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
  return obOk({
    clientId, client, profile, people, meetings, invoices,
    agreement: agree.row, agreementState: agree.state,
    items, ready: left.length === 0, missing: left,
    blocking: left.length ? left[0].why : '',
    blockingLabel: left.length ? left[0].label : '',
  });
}

/* True only when every item is done. */
async function obReady(clientId){
  const ck = await obChecklist(clientId);
  if (!ck.ok) return ck;
  return obOk(Boolean(ck.data.ready));
}

/* Day one. Refuses unless every item is done, and says which one is missing.
   The month clock is the finance side's: fnStartSending sets the anchor and
   opens month one. We never work out a date or a fee here. */
async function obStart(clientId){
  const ck = await obChecklist(clientId);
  if (!ck.ok) return ck;
  if (!ck.data.ready) {
    const left = ck.data.missing;
    const more = left.length > 1 ? ' ' + (left.length - 1) + ' other thing' + (left.length === 2 ? '' : 's') + ' still to do.' : '';
    return obErr('Not ready to start: ' + left[0].why + more);
  }
  const day1 = obToday();
  const marked = await obRun(() => sb.from('clients')
    .update({inputs_complete_on: ck.data.client.inputs_complete_on || day1})
    .eq('id', clientId).select().single(), null);
  if (!marked.ok) return marked;

  const started = typeof fnStartSending === 'function'
    ? await fnStartSending(clientId, day1)
    : obErr('The finance side is not loaded, so month one cannot be opened.');
  if (!started.ok) return obErr(started.error);

  const live = await obRun(() => sb.from('clients')
    .update({stage: 'live'}).eq('id', clientId).select().single(), null);
  if (!live.ok) return live;

  return obOk({client: live.data, month: started.data && started.data.month, day1On: day1});
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
function obSay(msg){ if (typeof toast === 'function') toast(msg) }

/* Everyone still being onboarded, each with their checklist. */
async function obLoadList(){
  ob.listErr = '';
  const cs = typeof fnClients === 'function' ? await fnClients() : obOk([]);
  if (!cs.ok) { ob.listErr = cs.error; ob.list = []; return obErr(cs.error); }
  const mine = (cs.data || []).filter(c => c && OB_STAGES.includes(obText(c.stage)));
  const out = [];
  for (const c of mine) {
    const ck = await obChecklist(c.id);
    out.push(ck.ok ? ck.data : {clientId:c.id, client:c, items:[], ready:false, missing:[], blocking:ck.error, blockingLabel:''});
  }
  ob.list = out;
  return obOk(out);
}
async function obLoadOne(clientId){
  ob.oneErr = ''; ob.clientId = clientId;
  const ck = await obChecklist(clientId);
  if (!ck.ok) { ob.oneErr = ck.error; ob.one = null; return ck; }
  const inp = await obInputs(clientId);
  const ag  = await obAgreement(clientId);
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
      ? emptyState('○', 'Nobody is being onboarded', 'A client appears here the moment a deal is won, and leaves it on day one.', '', '')
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
  if (ob.oneErr) return `<div class="card ob-card"><b>We could not open this client</b><p class="muted">${obEsc(ob.oneErr)}</p></div>`;
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
    <span class="ob-inv-sum"><b>${obEsc(obMoney(inv.amount))}</b>${inv.due_on ? ` <span class="muted">· due ${obEsc(obText(inv.due_on))}${Number(inv.days_overdue) > 0 ? ` · ${obEsc(String(inv.days_overdue))} days late` : ''}</span>` : ''}</span>
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
      ? emptyState('○', 'No invoices need you', 'Invoices to raise, send and chase show up here as months open.', '', '')
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
function obShowInputsErr(msg){
  if (typeof errEl === 'function') errEl('obInputsErr', msg || '');
  if (msg) obSay(msg);
}
async function obSaveInputsFromForm(){
  if (!ob.clientId) return;
  const r = await obSaveInputs(ob.clientId, obFormFields());
  obShowInputsErr(r.ok ? '' : r.error);
  if (r.ok) obSay('Their inputs are saved.');
  await obLoadOne(ob.clientId); obPaint(obRenderOnboardingClient());
}
async function obSignOffFromForm(){
  if (!ob.clientId) return;
  const saved = await obSaveInputs(ob.clientId, obFormFields());
  if (!saved.ok) { obShowInputsErr(saved.error); return; }
  const r = await obSignOff(ob.clientId);
  obShowInputsErr(r.ok ? '' : r.error);
  if (r.ok) obSay('Their inputs are signed off.');
  await obLoadOne(ob.clientId); obPaint(obRenderOnboardingClient());
}
async function obStartGo(clientId){
  const r = await obStart(clientId);
  obSay(r.ok ? 'They are live. Month one is open.' : r.error);
  await obLoadOne(clientId); obPaint(obRenderOnboardingClient());
}
async function obDraftAgreementGo(clientId){
  const r = await obDraftAgreement(clientId);
  obSay(r.ok ? 'The agreement is drafted. Nothing has been sent.' : r.error);
  await obLoadOne(clientId); obPaint(obRenderOnboardingClient());
}
async function obRaiseGo(monthId){
  const r = typeof fnRaiseInvoice === 'function' ? await fnRaiseInvoice(monthId, 0) : obErr('The finance side is not loaded.');
  obSay(r.ok ? (r.data ? 'The invoice is raised.' : 'Nothing to bill for that month — a three-month term bills on months one, four and seven.') : r.error);
  await obLoadBilling(); obPaint(obRenderBilling());
}
async function obMarkSentGo(invoiceId){
  const r = typeof fnMarkInvoiceSent === 'function' ? await fnMarkInvoiceSent(invoiceId) : obErr('The finance side is not loaded.');
  obSay(r.ok ? 'Marked as sent.' : r.error);
  await obLoadBilling(); obPaint(obRenderBilling());
}
async function obMarkPaidGo(invoiceId, via){
  const r = typeof fnMarkInvoicePaid === 'function' ? await fnMarkInvoicePaid(invoiceId, via || 'bank transfer') : obErr('The finance side is not loaded.');
  obSay(r.ok ? (typeof fnPaidWords === 'function' ? fnPaidWords(r.data) : 'Marked paid.') : r.error);
  await obLoadBilling(); obPaint(obRenderBilling());
}
