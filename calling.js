/* ============================================================================
   calling.js — Aviance Hub · the cold calling desk and the do-not-call list
   ----------------------------------------------------------------------------
   Aviance buys no advertising. Every client it has was found by someone sitting
   at this screen with a phone. So the screen is built for that person: the next
   number large and clear, nine buttons for how the call went, and today's count
   along the top — because the only way to know whether today was a normal day
   or a bad one is to see the number next to the benchmark.

   The benchmarks the desk is planned against (CL_BENCH):
     · about 370-400 dials for one booked meeting
     · 60-70% of booked meetings show up; about 93% when the meeting is
       confirmed on the call and reminded before it

   Tables: call_targets  call_log  dnc   (SCHEMA.md "Cold calling")

   Two rules are NOT in this file on purpose:
     · The do-not-call list is enforced by database triggers. Inserting a target
       that matches a dnc row raises an error; adding a dnc row retires matching
       targets. We catch the error and show its sentence. We never re-check it
       here, because a second copy of a rule is a rule that will disagree.
     · Money and verdicts live in finance.js and the database.

   Calling hours are 8am-9pm in the PROSPECT's own time zone (TCPA). A willful
   breach runs to $1,500 per call, so clNext() will not hand over a target that
   is outside its window — it says when that window opens instead.

   Every function returns {ok, data, error} and never throws. `error` is plain
   words, safe to show a person. Same plumbing as finance.js.
   ========================================================================== */

/* ---- the follow-up rhythm — ONE table, change it here and nowhere else ----
   waitHours  how long before the number comes back round
   status     what the target becomes
   stop       true = never dial again
   asked      true = the caller is asked for a date (callback)
   dnc        true = add a dnc row first, before anything else            */
const CL_RHYTHM = {
  no_answer:      {label:'No answer',      status:'queued',         waitHours:4,   words:'Back in the queue in 4 hours.'},
  voicemail:      {label:'Voicemail',      status:'queued',         waitHours:72,  words:'Back in the queue in 3 days.'},
  gatekeeper:     {label:'Gatekeeper',     status:'queued',         waitHours:24,  words:'Back in the queue tomorrow.'},
  conversation:   {label:'Conversation',   status:'queued',         waitHours:168, words:'Spoke to them. Back in the queue in a week.'},
  callback:       {label:'Call back',      status:'callback',       asked:true,    words:'Held for the time they asked for.'},
  booked:         {label:'Booked',         status:'booked',         stop:true,     words:'Booked. Off the calling list.'},
  not_interested: {label:'Not interested', status:'not_interested', stop:true,     words:'Not interested. We do not dial them again.'},
  bad_number:     {label:'Bad number',     status:'bad_number',     stop:true,     words:'Bad number. We do not dial it again.'},
  dnc_request:    {label:'Do not call',    status:'dnc',            stop:true, dnc:true,
                   words:'On the do-not-call list. That number is never dialled again.'}
};

/* The benchmarks the desk is read against. */
const CL_BENCH = {
  dialsPerMeetingLow: 370,
  dialsPerMeeting:    400,
  showRate:           0.65,
  showRateConfirmed:  0.93
};

const CL_OPEN_HOUR  = 8;    // 8am, prospect's own time
const CL_CLOSE_HOUR = 21;   // 9pm
const CL_HOURS_WORDS = '8am-9pm in their own time zone';

/* Where a target has no `timezone`, fall back to its country. A rough zone is
   enough to keep us inside the law; the caller sees which one was used. */
const CL_COUNTRY_ZONES = {
  'us':'America/New_York', 'usa':'America/New_York', 'united states':'America/New_York',
  'ca':'America/Toronto', 'canada':'America/Toronto',
  'gb':'Europe/London', 'uk':'Europe/London', 'united kingdom':'Europe/London',
  'ie':'Europe/Dublin', 'ireland':'Europe/Dublin',
  'au':'Australia/Sydney', 'australia':'Australia/Sydney',
  'nz':'Pacific/Auckland', 'new zealand':'Pacific/Auckland',
  'de':'Europe/Berlin', 'germany':'Europe/Berlin',
  'fr':'Europe/Paris', 'france':'Europe/Paris',
  'nl':'Europe/Amsterdam', 'netherlands':'Europe/Amsterdam',
  'es':'Europe/Madrid', 'spain':'Europe/Madrid',
  'ae':'Asia/Dubai', 'uae':'Asia/Dubai',
  'sg':'Asia/Singapore', 'singapore':'Asia/Singapore',
  'in':'Asia/Kolkata', 'india':'Asia/Kolkata',
  'lk':'Asia/Colombo', 'sri lanka':'Asia/Colombo',
  'za':'Africa/Johannesburg', 'south africa':'Africa/Johannesburg'
};
const CL_ZONE_FALLBACK = 'America/New_York';

const CL_STATUSES = ['new','queued','calling','booked','not_interested','bad_number','callback','dnc'];
const CL_DNC_REASONS = ['requested','complaint','legal','bounced','competitor','other'];
const CL_DIALABLE = ['new','queued','callback'];

/* ---- plumbing (finance.js) ---------------------------------------- */

function clOk(data){ return {ok:true, data, error:''} }
function clErr(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return {ok:false, data:null, error:m};
}
function clWrap(res, whenEmpty){
  if (!res) return clErr('No answer from the database.');
  if (res.error) return clErr(res.error);
  return clOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
async function clRun(fn, whenEmpty){
  try { return clWrap(await fn(), whenEmpty); }
  catch (e) { return clErr(e); }
}

/* ---- small helpers ------------------------------------------------- */

const cl = {desk:null, targets:null, dnc:null, today:null, err:'', status:'', busy:false, report:null};

function clNow(now){ return now == null ? new Date(Date.now()) : (now instanceof Date ? now : new Date(now)); }
function clInt(v){ const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; }
function clText(v, max){ const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max || 600) : null; }

/* A phone, with only the digits that matter, so two spellings of one number
   are one number. Keeps a leading + . */
function clPhoneKey(v){
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  if (!d) return '';
  /* +1 (555) 000-1111, 15550001111 and 555-000-1111 are one number. The last
     ten digits are what actually gets dialled. */
  return d.length > 10 ? d.slice(-10) : d;
}
function clEmailKey(v){ return String(v == null ? '' : v).trim().toLowerCase(); }

/* The time zone we will treat this target as living in. */
function clZoneOf(target){
  const t = target || {};
  if (clText(t.timezone)) return String(t.timezone).trim();
  const c = String(t.country == null ? '' : t.country).trim().toLowerCase();
  return CL_COUNTRY_ZONES[c] || CL_ZONE_FALLBACK;
}
/* Which zone did we actually use, and did we have to guess? */
function clZoneSource(target){
  const t = target || {};
  if (clText(t.timezone)) return 'their time zone';
  const c = String(t.country == null ? '' : t.country).trim().toLowerCase();
  if (CL_COUNTRY_ZONES[c]) return 'their country';
  return 'our default';
}

/* The hour and minute it is where they are. Null if the zone is not a zone. */
function clZoneHM(zone, now){
  const d = clNow(now);
  try {
    const parts = new Intl.DateTimeFormat('en-US',
      {timeZone: zone, hour12:false, hour:'2-digit', minute:'2-digit'}).formatToParts(d);
    const h = Number((parts.find(p => p.type === 'hour') || {}).value);
    const m = Number((parts.find(p => p.type === 'minute') || {}).value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return {h: h === 24 ? 0 : h, m};
  } catch (e) { return null; }
}

/* "2:40 PM" where they are. */
function clLocalTimeWords(zone, now){
  const d = clNow(now);
  try {
    return new Intl.DateTimeFormat('en-US',
      {timeZone: zone, hour:'numeric', minute:'2-digit'}).format(d);
  } catch (e) {
    const hm = clZoneHM(CL_ZONE_FALLBACK, d) || {h:0,m:0};
    return hm.h + ':' + String(hm.m).padStart(2,'0');
  }
}
/* HH:MM:SS where they are — the call_log.target_local_time column. */
function clLocalTimeSql(zone, now){
  const hm = clZoneHM(zone, now) || clZoneHM(CL_ZONE_FALLBACK, now);
  if (!hm) return null;
  return String(hm.h).padStart(2,'0') + ':' + String(hm.m).padStart(2,'0') + ':00';
}

/* Minutes until this target may legally be called. 0 means: call them now. */
function clMinutesToWindow(zone, now){
  const hm = clZoneHM(zone, now);
  if (!hm) return 0;                         // an unreadable zone is not a reason to stop the desk
  const mins = hm.h * 60 + hm.m;
  const open = CL_OPEN_HOUR * 60, close = CL_CLOSE_HOUR * 60;
  if (mins >= open && mins < close) return 0;
  if (mins < open) return open - mins;
  return (24 * 60 - mins) + open;
}
function clIsCallableNow(target, now){ return clMinutesToWindow(clZoneOf(target), now) === 0; }

function clWaitWords(mins){
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return m <= 1 ? 'in a minute' : 'in ' + m + ' minutes';
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return 'in ' + h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' + r + ' min' : '');
  return 'in ' + Math.round(m / 60) + ' hours';
}

/* ---- who to dial next --------------------------------------------- */

/* The next target the caller may legally dial: status new or queued, or a
   callback whose time has come, soonest first — and only where it is between
   8am and 9pm where they are.
   data: {target, zone, zoneFrom, localTime, waiting, checked}
   When nobody is callable right now, target is null and `words` says when the
   first window opens, with `opensAt` and `opensInMinutes`. */
async function clNext(opts){
  const o = opts || {};
  const now = clNow(o.now);
  const got = await clRun(() => {
    let q = sb.from('call_targets').select('*').in('status', CL_DIALABLE);
    if (o.owner) q = q.eq('owner', o.owner);
    return q.order('next_call_at', {ascending:true, nullsFirst:true}).limit(o.limit || 200);
  }, []);
  if (!got.ok) return got;

  const rows = (got.data || []).filter(r => {
    if (!r) return false;
    if (r.status === 'callback' && r.next_call_at) return Date.parse(r.next_call_at) <= now.getTime();
    if (r.next_call_at) return Date.parse(r.next_call_at) <= now.getTime();
    return true;
  });

  if (!rows.length) {
    return clOk({target:null, checked:0, waiting:(got.data||[]).length,
      words:'Nothing is due to be dialled right now. Import more numbers, or wait for the callbacks to come round.'});
  }

  let soonest = null;
  for (const r of rows) {
    const zone = clZoneOf(r);
    const mins = clMinutesToWindow(zone, now);
    if (mins === 0) {
      return clOk({
        target: r, zone, zoneFrom: clZoneSource(r),
        localTime: clLocalTimeWords(zone, now),
        waiting: rows.length - 1, checked: rows.length,
        words: 'It is ' + clLocalTimeWords(zone, now) + ' where they are.'
      });
    }
    if (!soonest || mins < soonest.mins) soonest = {mins, row:r, zone};
  }

  const opensAt = new Date(now.getTime() + soonest.mins * 60000);
  return clOk({
    target: null, checked: rows.length, waiting: rows.length,
    opensAt: opensAt.toISOString(), opensInMinutes: soonest.mins,
    zone: soonest.zone, nextCompany: soonest.row.company || '',
    words: 'Nobody can be called right now — calling hours are ' + CL_HOURS_WORDS + '. ' +
           'The first window opens ' + clWaitWords(soonest.mins) + ', at ' +
           clLocalTimeWords(soonest.zone, opensAt) + ' their time' +
           (soonest.row.company ? ' (' + soonest.row.company + ')' : '') + '.'
  });
}

/* ---- logging a call ------------------------------------------------ */

function clNextCallAt(outcome, now, callbackAt){
  const r = CL_RHYTHM[outcome];
  if (!r || r.stop) return null;
  if (r.asked) {
    const t = Date.parse(callbackAt || '');
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return new Date(clNow(now).getTime() + r.waitHours * 3600000).toISOString();
}

/* Write the call down. One call: a call_log row, the target stamped with
   last_called_at, one more attempt, and the status and next_call_at the rhythm
   table says. A dnc_request adds the dnc row FIRST and stops there — the
   database's own trigger retires the target, so we do not touch it again.    */
async function clLog(targetId, call){
  const c = call || {};
  const outcome = String(c.outcome || '');
  const rhythm = CL_RHYTHM[outcome];
  if (!targetId) return clErr('Which number was that? Pick a target first.');
  if (!rhythm) return clErr('Pick how the call went before saving it.');
  if (rhythm.asked && !Date.parse(c.callbackAt || '')) {
    return clErr('A call back needs the day and time they asked for.');
  }
  const now = clNow(c.now);

  const got = await clRun(() => sb.from('call_targets').select('*').eq('id', targetId).single(), null);
  if (!got.ok) return got;
  const target = got.data;
  if (!target) return clErr('That number is not on the calling list any more.');
  const zone = clZoneOf(target);

  /* They asked us never to call again. That goes on the list before anything
     else is written, and before the number could be dialled a second time. */
  let dncRow = null;
  if (rhythm.dnc) {
    const added = await clAddToDnc({
      phone: target.phone, email: target.email, domain: target.website,
      reason: 'requested',
      note: clText(c.notes, 400) || 'Asked us not to call again on ' + now.toISOString().slice(0,10)
    });
    if (!added.ok) return added;   // nothing else is written until the list has them
    dncRow = added.data;
  }

  const logged = await clRun(() => sb.from('call_log').insert({
    target_id:         targetId,
    caller:            (typeof authUser !== 'undefined' && authUser && authUser.uid) || null,
    called_at:         now.toISOString(),
    target_local_time: clLocalTimeSql(zone, now),
    outcome,
    duration_seconds:  c.durationSeconds == null ? null : clInt(c.durationSeconds),
    notes:             clText(c.notes, 2000)
  }).select().single(), null);
  if (!logged.ok) return logged;

  /* The database has already set this target to `dnc` and will refuse an
     update to a listed number. Showing that error would only confuse. */
  if (rhythm.dnc) {
    return clOk({log: logged.data, target: null, dnc: dncRow, status:'dnc',
      nextCallAt: null, retiredByDatabase: true, words: rhythm.words});
  }

  const nextAt = clNextCallAt(outcome, now, c.callbackAt);
  const up = await clRun(() => sb.from('call_targets').update({
    status:         rhythm.status,
    attempts:       clInt(target.attempts) + 1,
    last_called_at: now.toISOString(),
    next_call_at:   nextAt
  }).eq('id', targetId).select().single(), null);
  if (!up.ok) return up;

  return clOk({log: logged.data, target: up.data, status: rhythm.status,
    nextCallAt: nextAt, words: rhythm.words});
}

/* They said yes. The target stops being a calling target here. */
async function clBooked(targetId, meetingFields){
  if (!targetId) return clErr('Which number was that? Pick a target first.');
  const m = meetingFields || {};
  const up = await clRun(() => sb.from('call_targets').update({
    status:       'booked',
    next_call_at: null,
    notes:        clText(m.notes, 2000) || undefined
  }).eq('id', targetId).select().single(), null);
  if (!up.ok) return up;

  // TODO: create the `meetings` row for this booking (kind, starts_at, minutes,
  // time_zone, meet_link, and the calendar invite). The meetings area is owned
  // by another agent — when its data layer lands, call it here with
  // {targetId, starts_at: m.startsAt, minutes: m.minutes, time_zone: m.timeZone}
  // and put the id it returns on the call_log row (call_log.meeting_id).
  // Confirming the meeting on the call and reminding before it is what moves the
  // show rate from 60-70% to about 93%, so the reminder fields matter.
  return clOk({target: up.data, meeting: null,
    words: 'Booked. The meeting itself still has to be put in the calendar.'});
}

/* ---- the do-not-call list ------------------------------------------ */

/* Add a row. The database does the rest: every matching target is retired, and
   any later import of that number is refused. */
async function clAddToDnc(entry){
  const e = entry || {};
  const phone = clText(e.phone, 40), email = clEmailKey(e.email), domain = clText(e.domain, 200);
  if (!phone && !email && !domain) return clErr('Give a phone number, an email address or a website.');
  const reason = CL_DNC_REASONS.indexOf(e.reason) >= 0 ? e.reason : 'requested';
  return clRun(() => sb.from('dnc').insert({
    phone:    phone || null,
    email:    email || null,
    domain:   domain || null,
    reason,
    note:     clText(e.note, 600),
    added_by: (typeof authUser !== 'undefined' && authUser && authUser.uid) || null
  }).select().single(), null);
}

async function clDncList(){
  return clRun(() => sb.from('dnc').select('*').order('created_at', {ascending:false}).limit(1000), []);
}

/* ---- the calling list ---------------------------------------------- */

async function clTargets(status){
  return clRun(() => {
    let q = sb.from('call_targets').select('*');
    if (status && CL_STATUSES.indexOf(status) >= 0) q = q.eq('status', status);
    return q.order('created_at', {ascending:false}).limit(500);
  }, []);
}

/* ---- import --------------------------------------------------------- */

const CL_COLUMNS = ['company','person_name','job_title','phone','email','website','country','timezone','source','notes'];
const CL_HEADERS = {
  company:'company', business:'company', name:'company', 'company name':'company',
  person:'person_name', person_name:'person_name', contact:'person_name', 'contact name':'person_name', 'full name':'person_name',
  title:'job_title', job_title:'job_title', role:'job_title', 'job title':'job_title',
  phone:'phone', telephone:'phone', number:'phone', 'phone number':'phone', mobile:'phone',
  email:'email', 'email address':'email',
  website:'website', site:'website', url:'website', domain:'website',
  country:'country', timezone:'timezone', 'time zone':'timezone', tz:'timezone',
  source:'source', list:'source', notes:'notes', note:'notes'
};

function clSplitCsvLine(line){
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t' || ch === ';') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/* Paste or CSV text in, rows out. A header line is used when we recognise it;
   without one the order is company, person, title, phone, email, website,
   country. */
function clParseRows(input){
  if (Array.isArray(input)) {
    return input.map(r => {
      const o = {};
      CL_COLUMNS.forEach(k => {
        const v = r && (r[k] !== undefined ? r[k]
          : r[k.replace('_','')] !== undefined ? r[k.replace('_','')] : undefined);
        if (v !== undefined) o[k] = clText(v, 400);
      });
      if (r && r.personName !== undefined && !o.person_name) o.person_name = clText(r.personName, 400);
      if (r && r.jobTitle !== undefined && !o.job_title) o.job_title = clText(r.jobTitle, 400);
      return o;
    });
  }
  const text = String(input == null ? '' : input).replace(/\r/g, '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const first = clSplitCsvLine(lines[0]).map(h => h.toLowerCase());
  const known = first.filter(h => CL_HEADERS[h]).length;
  let order = ['company','person_name','job_title','phone','email','website','country'];
  let start = 0;
  if (known >= 2 && known >= Math.ceil(first.length / 2)) {
    order = first.map(h => CL_HEADERS[h] || null);
    start = 1;
  }
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const cells = clSplitCsvLine(lines[i]);
    const o = {};
    cells.forEach((v, j) => { const k = order[j]; if (k && v) o[k] = clText(v, 400); });
    if (Object.keys(o).length) rows.push(o);
  }
  return rows;
}

function clRowLabel(r){
  return (r && (r.company || r.person_name || r.phone || r.email)) || 'that row';
}

/* Import, one row at a time, so one refusal never costs the rest of the list.
   Report per row: imported | skipped (on the do-not-call list) | duplicate |
   not enough | error.  Dedupe on phone and on email, inside the paste and
   against what is already on the list. */
async function clImport(input, opts){
  const o = opts || {};
  const rows = clParseRows(input);
  if (!rows.length) return clErr('Nothing to import. Paste a list, or a CSV with a header line.');

  const seen = await clRun(() => sb.from('call_targets').select('phone,email').limit(5000), []);
  if (!seen.ok) return seen;
  const phones = new Set(), emails = new Set();
  (seen.data || []).forEach(r => {
    const p = clPhoneKey(r && r.phone); if (p) phones.add(p);
    const e = clEmailKey(r && r.email); if (e) emails.add(e);
  });

  const report = [];
  let imported = 0, skipped = 0, duplicate = 0, failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], line = i + 1, label = clRowLabel(r);
    if (!r.company && !r.phone && !r.email) {
      report.push({line, label, result:'not enough', words:'No company and no number — nothing to dial.'});
      failed++; continue;
    }
    const pk = clPhoneKey(r.phone), ek = clEmailKey(r.email);
    if ((pk && phones.has(pk)) || (ek && emails.has(ek))) {
      report.push({line, label, result:'duplicate', words:'Already on the calling list.'});
      duplicate++; continue;
    }
    const ins = await clRun(() => sb.from('call_targets').insert({
      company:     r.company || label,
      person_name: r.person_name || null,
      job_title:   r.job_title || null,
      phone:       r.phone || null,
      email:       ek || null,
      website:     r.website || null,
      country:     r.country || null,
      timezone:    r.timezone || null,
      source:      r.source || clText(o.source, 120) || 'import',
      notes:       r.notes || null,
      owner:       o.owner || (typeof authUser !== 'undefined' && authUser && authUser.uid) || null,
      status:      'new'
    }).select().single(), null);

    if (ins.ok) {
      if (pk) phones.add(pk);
      if (ek) emails.add(ek);
      report.push({line, label, result:'imported', id: ins.data && ins.data.id});
      imported++;
    } else if (/do[\s-]?not[\s-]?call|dnc/i.test(ins.error)) {
      /* The trigger refused it. Its sentence is the one the person should read. */
      report.push({line, label, result:'skipped', words: ins.error});
      skipped++;
    } else {
      report.push({line, label, result:'error', words: ins.error});
      failed++;
    }
  }

  const words = imported + (imported === 1 ? ' number added' : ' numbers added') +
    (skipped ? ', ' + skipped + ' on the do-not-call list' : '') +
    (duplicate ? ', ' + duplicate + ' already on the list' : '') +
    (failed ? ', ' + failed + ' could not be read' : '') + '.';
  return clOk({rows: rows.length, imported, skipped, duplicate, failed, report, words});
}

/* ---- today, against the benchmark ---------------------------------- */

function clDayStart(now){
  const d = clNow(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/* Dials, conversations, bookings, dials per booking, and whether that is a
   normal day or a bad one next to the 370-400 benchmark. */
async function clToday(opts){
  const o = opts || {};
  const from = clDayStart(o.now);
  const to = new Date(from.getTime() + 86400000);
  const got = await clRun(() => sb.from('call_log').select('outcome,duration_seconds,called_at')
    .gte('called_at', from.toISOString()).lt('called_at', to.toISOString()).limit(5000), []);
  if (!got.ok) return got;

  const rows = got.data || [];
  const by = {};
  rows.forEach(r => { const k = (r && r.outcome) || 'unknown'; by[k] = (by[k] || 0) + 1; });

  const dials = rows.length;
  const conversations = (by.conversation || 0) + (by.booked || 0);
  const bookings = by.booked || 0;
  const talkSeconds = rows.reduce((s, r) => s + clInt(r && r.duration_seconds), 0);
  const dialsPerBooking = bookings > 0 ? Math.round(dials / bookings) : null;
  const expectedBookings = Math.round((dials / CL_BENCH.dialsPerMeeting) * 100) / 100;
  const connectRate = dials ? Math.round((conversations / dials) * 1000) / 1000 : 0;
  const onPace = bookings > 0 ? dials <= CL_BENCH.dialsPerMeeting * bookings : dials < CL_BENCH.dialsPerMeetingLow;

  let words;
  if (!dials) {
    words = 'No dials yet today. A booked meeting takes about ' + CL_BENCH.dialsPerMeetingLow +
            '-' + CL_BENCH.dialsPerMeeting + ' dials, so the number is the work.';
  } else if (bookings > 0) {
    words = dialsPerBooking + ' dials per booking so far — the plan is ' +
      CL_BENCH.dialsPerMeetingLow + '-' + CL_BENCH.dialsPerMeeting + ', so ' +
      (dialsPerBooking <= CL_BENCH.dialsPerMeeting ? 'today is a normal day or better.' : 'today is running behind.');
  } else {
    words = dials + (dials === 1 ? ' dial' : ' dials') + ', no booking yet. At the benchmark that is ' +
      (expectedBookings < 1
        ? 'still normal — a booking takes about ' + CL_BENCH.dialsPerMeeting + ' dials.'
        : 'about ' + expectedBookings + ' expected by now, so today is running behind.');
  }

  return clOk({
    dials, conversations, bookings, dialsPerBooking, connectRate,
    talkSeconds, byOutcome: by,
    benchmark: CL_BENCH.dialsPerMeeting, benchmarkLow: CL_BENCH.dialsPerMeetingLow,
    expectedBookings, onPace,
    showRateWords: 'Of the meetings booked, ' + Math.round(CL_BENCH.showRate * 100) +
      '% show up — about ' + Math.round(CL_BENCH.showRateConfirmed * 100) +
      '% when the meeting is confirmed on the call and reminded before it.',
    words
  });
}

/* ---- the desk ------------------------------------------------------- */

function clPct(r){ const n = Number(r); return (Number.isFinite(n) ? Math.round(n * 1000) / 10 : 0) + '%'; }
function clNum(n){ return clInt(n).toLocaleString('en-US'); }

function clTodayStrip(t){
  const d = t || {};
  const tiles = [
    ['Dials today', clNum(d.dials)],
    ['Conversations', clNum(d.conversations)],
    ['Booked', clNum(d.bookings)],
    ['Dials per booking', d.dialsPerBooking == null ? '—' : clNum(d.dialsPerBooking)],
    ['Benchmark', clNum(d.benchmark || CL_BENCH.dialsPerMeeting)]
  ];
  const tone = t ? (d.onPace ? ' cl-ok' : ' cl-behind') : '';
  const words = d.words || ('A booked meeting takes about ' + CL_BENCH.dialsPerMeetingLow + '-' +
    CL_BENCH.dialsPerMeeting + " dials. Today's count appears here as you dial.");
  return '<div class="cl-strip">' + tiles.map(x =>
    '<div class="cl-tile"><span class="cl-label">' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b></div>').join('') +
    '</div><p class="cl-pace' + tone + '">' + esc(words) + '</p>';
}

function clOutcomeButtons(id){
  const keys = Object.keys(CL_RHYTHM);
  return '<div class="cl-outcomes">' + keys.map(k =>
    '<button type="button" class="btn cl-out cl-out-' + esc(k) + '" ' +
    'onclick="clDeskSave(\'' + esc(k) + '\')"' + (id ? '' : ' disabled') + '>' +
    esc(CL_RHYTHM[k].label) + '</button>').join('') + '</div>';
}

/* The desk. Pure: it returns HTML from whatever has been loaded. */
function viewCalling(state){
  const s = state || cl;
  const d = s.desk, t = s.today;
  const head = '<div class="cl-head"><h2>Calling desk</h2><span class="cl-muted">Calling hours ' +
    esc(CL_HOURS_WORDS) + '</span></div>';
  const strip = clTodayStrip(t);

  if (s.err) {
    return '<div class="cl">' + head + strip +
      '<div class="cl-err" role="alert"><span>' + esc(s.err) + '</span>' +
      '<button type="button" class="btn" onclick="clDeskLoad()">Try again</button></div></div>';
  }
  if (!d) {
    return '<div class="cl">' + head + strip +
      '<section class="cl-card cl-wait" aria-busy="true"><b>Finding the next number…</b>' +
      '<button type="button" class="btn" onclick="clDeskLoad()">Load the next number</button></section></div>';
  }
  if (!d.target) {
    return '<div class="cl">' + head + strip +
      '<section class="cl-card cl-closed" role="status"><b class="cl-big">Nobody to call right now</b>' +
      '<p>' + esc(d.words || '') + '</p>' +
      (d.waiting ? '<p class="cl-muted">' + esc(clNum(d.waiting)) + ' waiting in the queue.</p>' : '') +
      '<button type="button" class="btn" onclick="clDeskLoad()">Check again</button></section>' +
      '<p class="cl-muted">' + esc(t && t.showRateWords ? t.showRateWords : '') + '</p></div>';
  }

  const x = d.target;
  return '<div class="cl">' + head + strip +
    '<section class="cl-card cl-desk">' +
      '<div class="cl-who">' +
        '<b class="cl-company">' + esc(x.company || 'No company name') + '</b>' +
        (x.person_name ? '<span class="cl-person">' + esc(x.person_name) +
          (x.job_title ? ', ' + esc(x.job_title) : '') + '</span>' : '') +
        '<a class="cl-phone" href="tel:' + esc(x.phone || '') + '">' + esc(x.phone || 'No number') + '</a>' +
        '<span class="cl-when">' + esc(d.localTime || '') + ' their time · ' + esc(d.zone || '') +
          ' (' + esc(d.zoneFrom || '') + ')</span>' +
        '<span class="cl-muted">' + esc(clNum(x.attempts)) + ' attempt' + (clInt(x.attempts) === 1 ? '' : 's') +
          ' so far' + (x.country ? ' · ' + esc(x.country) : '') + '</span>' +
        (x.notes ? '<p class="cl-notes-prev">' + esc(x.notes) + '</p>' : '') +
      '</div>' +
      '<div class="cl-work">' +
        '<label class="cl-label" for="clNotes">What they said</label>' +
        '<textarea id="clNotes" class="cl-notes" rows="5" placeholder="Anything worth remembering next time"></textarea>' +
        '<div class="cl-row">' +
          '<label class="cl-label" for="clCallback">Call back at</label>' +
          '<input type="datetime-local" id="clCallback" class="cl-input">' +
          '<label class="cl-label" for="clSeconds">Seconds</label>' +
          '<input type="number" id="clSeconds" class="cl-input cl-secs" min="0" step="5" placeholder="0">' +
        '</div>' +
        clOutcomeButtons(x.id) +
        '<p class="cl-err-line" id="clDeskErr" role="alert"></p>' +
        '<button type="button" class="btn ghost" onclick="clDeskSkip()">Skip this one</button>' +
      '</div>' +
    '</section>' +
    '<p class="cl-muted">' + esc(t && t.showRateWords ? t.showRateWords : '') + '</p>' +
  '</div>';
}

/* ---- the calling list screen ---------------------------------------- */

function clStatusPill(s){
  const v = String(s || '');
  return '<span class="cl-pill cl-s-' + esc(v) + '">' + esc(v.replace(/_/g, ' ')) + '</span>';
}
function clWhen(iso){
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString('en-US', {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
}

function clImportBox(report){
  const lines = (report && report.report) || [];
  const out = report
    ? '<div class="cl-report" role="status"><b>' + esc(report.words || '') + '</b>' +
      (lines.length ? '<ul class="cl-report-list">' + lines.map(r =>
        '<li class="cl-r-' + esc(r.result.replace(/ /g,'-')) + '"><span>Row ' + esc(r.line) + ' · ' +
        esc(r.label) + '</span><span>' + esc(r.result === 'imported' ? 'Added' : (r.words || r.result)) +
        '</span></li>').join('') + '</ul>' : '') + '</div>'
    : '';
  return '<section class="cl-card"><div class="cl-card-h"><b>Add numbers</b>' +
    '<span class="cl-muted">Paste a list, or CSV with a header line</span></div>' +
    '<textarea id="clPaste" class="cl-paste" rows="5" placeholder="company, person, title, phone, email, website, country"></textarea>' +
    '<div class="cl-row"><button type="button" class="btn" onclick="clImportPaste()">Import</button>' +
    '<span class="cl-muted">Numbers on the do-not-call list are skipped and listed back to you. Nothing else is lost.</span></div>' +
    '<p class="cl-err-line" id="clImportErr" role="alert"></p>' + out + '</section>';
}

function viewCallTargets(state){
  const s = state || cl;
  const rows = s.targets || [];
  const pick = s.status || '';
  const filter = '<div class="cl-filters">' +
    ['', ...CL_STATUSES].map(v =>
      '<button type="button" class="btn ghost cl-filter' + (pick === v ? ' on' : '') +
      '" onclick="clTargetsLoad(\'' + esc(v) + '\')">' +
      esc(v ? v.replace(/_/g, ' ') : 'All') + '</button>').join('') + '</div>';

  const table = rows.length
    ? '<table class="cl-table"><thead><tr><th>Company</th><th>Person</th><th>Phone</th>' +
      '<th>Country</th><th>Status</th><th class="cl-r">Attempts</th><th>Next call</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + esc(r.company || '') + '</td><td>' + esc(r.person_name || '') +
        '</td><td>' + esc(r.phone || '') + '</td><td>' + esc(r.country || '') + '</td><td>' +
        clStatusPill(r.status) + '</td><td class="cl-r">' + esc(clNum(r.attempts)) + '</td><td>' +
        esc(clWhen(r.next_call_at)) + '</td></tr>').join('') + '</tbody></table>'
    : (typeof emptyState === 'function'
        ? emptyState((typeof I !== 'undefined' && I && I.phone) || '', 'No numbers on the list yet',
            'Paste a list below and they appear here, ready to dial.', '', '')
        : '<p class="cl-muted">No numbers on the list yet.</p>');

  return '<div class="cl">' +
    '<div class="cl-head"><h2>Calling list</h2><span class="cl-muted">' +
      esc(clNum(rows.length)) + (rows.length === 1 ? ' number' : ' numbers') + '</span></div>' +
    (s.err ? '<div class="cl-err" role="alert"><span>' + esc(s.err) + '</span></div>' : '') +
    filter + '<section class="cl-card">' + table + '</section>' + clImportBox(s.report) + '</div>';
}

/* ---- the do-not-call list screen ------------------------------------ */

function viewDnc(state){
  const s = state || cl;
  const rows = s.dnc || [];
  const table = rows.length
    ? '<table class="cl-table"><thead><tr><th>Phone</th><th>Email</th><th>Website</th>' +
      '<th>Reason</th><th>Note</th><th>Added</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + esc(r.phone || '—') + '</td><td>' + esc(r.email || '—') +
        '</td><td>' + esc(r.domain || '—') + '</td><td>' + esc((r.reason || '').replace(/_/g,' ')) +
        '</td><td>' + esc(r.note || '') + '</td><td>' + esc(clWhen(r.created_at)) +
        '</td></tr>').join('') + '</tbody></table>'
    : (typeof emptyState === 'function'
        ? emptyState((typeof I !== 'undefined' && I && I.check) || '', 'Nobody on the do-not-call list yet',
            'Anyone who asks not to be called again goes on this list, and the database stops us dialling them.', '', '')
        : '<p class="cl-muted">Nobody on the do-not-call list yet.</p>');

  return '<div class="cl">' +
    '<div class="cl-head"><h2>Do not call</h2><span class="cl-muted">' +
      esc(clNum(rows.length)) + (rows.length === 1 ? ' entry' : ' entries') + '</span></div>' +
    '<p class="cl-warn" role="note"><b>This list only grows.</b> Anyone can add a row; only an admin can ' +
      'change or remove one. If a row here is wrong, ask an admin — do not dial the number in the meantime.</p>' +
    (s.err ? '<div class="cl-err" role="alert"><span>' + esc(s.err) + '</span></div>' : '') +
    '<section class="cl-card">' + table + '</section>' +
    '<section class="cl-card"><div class="cl-card-h"><b>Add to the list</b>' +
      '<span class="cl-muted">One of the three is enough</span></div>' +
      '<div class="cl-row"><input type="text" id="clDncPhone" class="cl-input" placeholder="Phone" aria-label="Phone">' +
      '<input type="email" id="clDncEmail" class="cl-input" placeholder="Email" aria-label="Email">' +
      '<input type="text" id="clDncDomain" class="cl-input" placeholder="Website" aria-label="Website"></div>' +
      '<div class="cl-row"><select id="clDncReason" class="cl-input" aria-label="Reason">' +
      CL_DNC_REASONS.map(r => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('') +
      '</select><input type="text" id="clDncNote" class="cl-input cl-grow" placeholder="Note" aria-label="Note">' +
      '<button type="button" class="btn" onclick="clDncAdd()">Add</button></div>' +
      '<p class="cl-err-line" id="clDncErr" role="alert"></p></section></div>';
}

/* ---- the screens, wired -------------------------------------------- */

function clDraw(view){
  if (typeof document === 'undefined' || !document.getElementById) return;
  const host = document.getElementById('clHost');
  if (host) host.innerHTML = view === 'dnc' ? viewDnc() : view === 'targets' ? viewCallTargets() : viewCalling();
  else if (typeof render === 'function') render(view === 'dnc' ? 'dnc' : view === 'targets' ? 'callTargets' : 'calling');
}

async function clDeskLoad(){
  cl.err = '';
  const [n, t] = await Promise.all([clNext(), clToday()]);
  if (!n.ok) cl.err = n.error; else cl.desk = n.data;
  if (t.ok) cl.today = t.data;
  clDraw('calling');
  return cl.desk;
}

async function clTargetsLoad(status){
  cl.status = status || '';
  const r = await clTargets(cl.status);
  cl.err = r.ok ? '' : r.error;
  cl.targets = r.ok ? r.data : [];
  clDraw('targets');
  return cl.targets;
}

async function clDncLoad(){
  const r = await clDncList();
  cl.err = r.ok ? '' : r.error;
  cl.dnc = r.ok ? r.data : [];
  clDraw('dnc');
  return cl.dnc;
}

async function clDeskSave(outcome){
  if (cl.busy) return null;
  const id = cl.desk && cl.desk.target && cl.desk.target.id;
  if (!id) return errEl('clDeskErr', 'There is no number on the desk.');
  cl.busy = true;
  try {
    const cb = (typeof val === 'function' ? val('clCallback') : '');
    const r = await clLog(id, {
      outcome,
      notes: typeof val === 'function' ? val('clNotes') : '',
      durationSeconds: Number(typeof val === 'function' ? val('clSeconds') : 0) || null,
      callbackAt: cb ? new Date(cb).toISOString() : ''
    });
    if (!r.ok) return errEl('clDeskErr', r.error);
    if (typeof toast === 'function') toast(r.data.words || 'Saved.');
    if (outcome === 'booked') await clBooked(id, {});
    cl.desk = null;
    await clDeskLoad();
    return r;
  } finally { cl.busy = false; }
}

/* Not a call — just move on. Nothing is written. */
async function clDeskSkip(){
  const skip = cl.desk && cl.desk.target && cl.desk.target.id;
  const r = await clNext();
  if (r.ok && r.data.target && r.data.target.id === skip && r.data.waiting) {
    // the same one came back: push it down the queue by asking again later
    cl.desk = Object.assign({}, r.data, {words: r.data.words + ' Still the next one in the queue.'});
  } else if (r.ok) cl.desk = r.data;
  else cl.err = r.error;
  clDraw('calling');
  return cl.desk;
}

async function clImportPaste(){
  if (cl.busy) return null;
  const text = typeof val === 'function' ? val('clPaste') : '';
  if (!text) return errEl('clImportErr', 'Paste the numbers in first.');
  cl.busy = true;
  try {
    const r = await clImport(text);
    if (!r.ok) return errEl('clImportErr', r.error);
    cl.report = r.data;
    if (typeof toast === 'function') toast(r.data.words);
    await clTargetsLoad(cl.status);
    return r;
  } finally { cl.busy = false; }
}

async function clDncAdd(){
  if (cl.busy) return null;
  const v = id => (typeof val === 'function' ? val(id) : '');
  cl.busy = true;
  try {
    const r = await clAddToDnc({
      phone: v('clDncPhone'), email: v('clDncEmail'), domain: v('clDncDomain'),
      reason: v('clDncReason'), note: v('clDncNote')
    });
    if (!r.ok) return errEl('clDncErr', r.error);
    if (typeof toast === 'function') toast('On the do-not-call list. Any matching number has been retired.');
    await clDncLoad();
    return r;
  } finally { cl.busy = false; }
}

/* Forget everything loaded (used when signing out, and by the tests). */
function clForget(){
  cl.desk = null; cl.targets = null; cl.dnc = null; cl.today = null;
  cl.err = ''; cl.status = ''; cl.busy = false; cl.report = null;
}
