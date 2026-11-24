/* ===================== AVIANCE OS — Meetings =====================
   The calendar, booking, reminders, no-shows, and whether a booked call counts.
   Supabase only: everything here goes straight through the shell's `sb` client.
   There is no other server — no machine, no booking service, nothing to call.

   Tables (SCHEMA.md):
     calendar_settings   one row, id=1 — the rules: hours, days, slot size, zones
     calendar_blocks     time the owner marked busy
     meetings            every call: kind, starts_at, minutes, status, reminders
     qualified_calls     the money side (finance.js). A `qualified` meeting is a
                         booked sales call we delivered, so marking it held or a
                         no-show must move its qualified_calls row with it.

   Rules of the house:
     - Every function returns {ok, data, error} and never throws. `error` is a
       plain sentence, safe to show a person.
     - Nothing is hard-coded: the hours, days, slot size and both time zones are
       read from calendar_settings. The constants below are only used when that
       row is missing.
     - Times are stored in UTC. Every conversion goes through Intl.DateTimeFormat
       with a timeZone, so US daylight saving is always right. There is no fixed
       offset anywhere in this file.
     - The person running this sits in Asia/Colombo and the prospects are in the
       US, so every time is shown twice: US Eastern and Sri Lanka.
     - Render functions are pure (data in, HTML out) and must draw with zero rows.
     - Nothing runs at load time.
   ================================================================= */

/* ===================== 0. CONSTANTS + STATE ===================== */

/* Only used when calendar_settings has no row. Never used to override it. */
const MT_FALLBACK = {
  open_time:'07:00', close_time:'21:00', days:[1,2,3,4,5], slot_minutes:30,
  min_notice_h:12, days_ahead:30,
  us_zone:'America/New_York', owner_zone:'Asia/Colombo', meeting_link:null
};
/* The kinds of call we book. `qualified` is the one that touches the money. */
const MT_KINDS = {
  discovery:  'Discovery call',
  strategy:   'Strategy call',
  onboarding: 'Onboarding call',
  qualified:  'Booked sales call',
  review:     'Review call'
};
const MT_STATUS = {
  booked:    {word:'Booked',      pill:'green'},
  held:      {word:'Call done',   pill:'grey'},
  no_show:   {word:'No-show',     pill:'red'},
  cancelled: {word:'Cancelled',   pill:'grey'}
};
/* A cancelled meeting leaves its time open again. Everything else holds it. */
const MT_FREES_TIME = ['cancelled'];
const MT_DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MT_ZONE_NAMES = {'Asia/Colombo':'Sri Lanka','America/New_York':'US Eastern','America/Chicago':'US Central','America/Denver':'US Mountain','America/Los_Angeles':'US Pacific','America/Phoenix':'Arizona'};
const MT_NOSHOW_DAYS = 45;      /* how far back viewNoShows looks */

const mt = {settings:null, week:null, days:null, one:null, noshows:null, err:'', now:null, busy:false};

/* ===================== 1. PLUMBING (as finance.js) ===================== */

function mtOk(data){ return {ok:true, data, error:''} }
function mtErr(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return {ok:false, data:null, error:m};
}
function mtWrap(res, whenEmpty){
  if (!res) return mtErr('No answer from the database.');
  if (res.error) return mtErr(res.error);
  return mtOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
async function mtRun(fn, whenEmpty){
  try { return mtWrap(await fn(), whenEmpty); }
  catch (e) { return mtErr(e); }
}

/* ===================== 2. TIME (Intl only) ===================== */

function mtNow(){ return mt.now ? new Date(mt.now) : new Date() }
function mtZoneOk(z){ if(!z||typeof z!=='string')return false; try{ new Intl.DateTimeFormat('en-US',{timeZone:z}); return true }catch(e){ return false } }
function mtPad(n){ return (n<10?'0':'')+n }
/* "07:00" → 420 minutes after midnight; NaN when it is not a time. */
function mtHmMin(hm){
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm==null?'':hm).trim());
  if(!m) return NaN;
  const h = Number(m[1]), mi = Number(m[2]);
  return h<=24 && mi<60 ? h*60+mi : NaN;
}
const mtFmtCache = {};
function mtFmt(zone, kind){
  const k = zone+'|'+kind; let f = mtFmtCache[k]; if(f) return f;
  const o = {timeZone:zone};
  if(kind==='parts') Object.assign(o,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  else if(kind==='time') Object.assign(o,{hour:'numeric',minute:'2-digit',hour12:true});
  else Object.assign(o,{weekday:'short',day:'numeric',month:'short'});
  f = mtFmtCache[k] = new Intl.DateTimeFormat('en-US', o);
  return f;
}
function mtPartsOf(fmt,d){ const p={}; fmt.formatToParts(d).forEach(x=>{p[x.type]=x.value}); return p }
/* The wall clock of an instant in a zone. */
function mtParts(d,zone){ const p=mtPartsOf(mtFmt(zone,'parts'),d); return {y:+p.year,m:+p.month,d:+p.day,h:(+p.hour)%24,mi:+p.minute,s:+p.second} }
/* The calendar date of an instant in a zone, "YYYY-MM-DD". */
function mtDayKey(d,zone){ const p=mtParts(d,zone); return p.y+'-'+mtPad(p.m)+'-'+mtPad(p.d) }
function mtKeyParts(k){ const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k||'')); return m?[+m[1],+m[2],+m[3]]:null }
function mtKeyOk(k){ const p=mtKeyParts(k); if(!p)return false; const t=new Date(Date.UTC(p[0],p[1]-1,p[2])); return t.getUTCMonth()===p[1]-1 && t.getUTCDate()===p[2] }
function mtAddDays(k,n){ const p=mtKeyParts(k); return p?new Date(Date.UTC(p[0],p[1]-1,p[2]+n)).toISOString().slice(0,10):'' }
function mtWeekday(k){ const p=mtKeyParts(k); return p?new Date(Date.UTC(p[0],p[1]-1,p[2])).getUTCDay():-1 }
function mtMonday(k){ return mtAddDays(k, -((mtWeekday(k)+6)%7)) }
/* Whole days between two date keys (b - a). */
function mtDaysBetween(a,b){
  const x=mtKeyParts(a), y=mtKeyParts(b); if(!x||!y) return NaN;
  return Math.round((Date.UTC(y[0],y[1]-1,y[2]) - Date.UTC(x[0],x[1]-1,x[2]))/864e5);
}
/* A zone's offset from UTC at an instant, in minutes — read from Intl, never assumed. */
function mtOffsetMin(ms,zone){
  const p = mtParts(new Date(ms), zone);
  return Math.round((Date.UTC(p.y,p.m-1,p.d,p.h,p.mi,p.s) - Math.floor(ms/1000)*1000)/60000);
}
/* A wall-clock time in a zone → the instant. The offset is read twice, so a
   daylight-saving change between the first guess and the answer still lands right. */
function mtZoneToUtc(key, hm, zone){
  const p = mtKeyParts(key), min = mtHmMin(hm);
  if(!p || isNaN(min) || !mtZoneOk(zone)) return null;
  const wall = Date.UTC(p[0],p[1]-1,p[2],0,min);
  let ms = wall - mtOffsetMin(wall,zone)*60000;
  ms = wall - mtOffsetMin(ms,zone)*60000;
  return new Date(ms);
}
function mtParseDate(v){
  if(v instanceof Date) return isNaN(v.getTime())?null:v;
  const t = Date.parse(String(v==null?'':v));
  return Number.isFinite(t) ? new Date(t) : null;
}
function mtTime(d,zone){ const p=mtPartsOf(mtFmt(zone,'time'),d); return p.hour+':'+p.minute+' '+String(p.dayPeriod||'').toLowerCase() }
function mtDayName(d,zone){ const p=mtPartsOf(mtFmt(zone,'day'),d); return p.weekday+' '+p.day+' '+p.month }
function mtWeekdayName(d,zone){ return mtPartsOf(mtFmt(zone,'day'),d).weekday }
function mtZoneName(z){ return MT_ZONE_NAMES[z] || String(z||'').split('/').pop().replace(/_/g,' ') }
function mtKeyDay(k){ const p=mtKeyParts(k); return p?mtDayName(new Date(Date.UTC(p[0],p[1]-1,p[2],12)),'UTC'):'' }
/* One instant, both ways round: US Eastern (where the prospects are) and Sri
   Lanka (where the person running this sits). The weekday is on both, because
   a late US afternoon call is the next morning in Colombo. */
function mtBothZones(when, st){
  const d = mtParseDate(when); if(!d) return null;
  const s = st || mtSettingsNow();
  return {
    at:       d.toISOString(),
    us:       mtWeekdayName(d,s.us_zone)+' '+mtTime(d,s.us_zone)+' '+mtZoneName(s.us_zone),
    usTime:   mtTime(d,s.us_zone),
    usDay:    mtDayName(d,s.us_zone),
    usKey:    mtDayKey(d,s.us_zone),
    owner:    mtWeekdayName(d,s.owner_zone)+' '+mtTime(d,s.owner_zone)+' '+mtZoneName(s.owner_zone),
    ownerTime:mtTime(d,s.owner_zone),
    ownerDay: mtDayName(d,s.owner_zone),
    ownerKey: mtDayKey(d,s.owner_zone),
    both:     mtDayName(d,s.us_zone)+' · '+mtTime(d,s.us_zone)+' '+mtZoneName(s.us_zone)+' / '+mtTime(d,s.owner_zone)+' '+mtZoneName(s.owner_zone)
  };
}
function mtDaysText(days){
  const ds = (days||[]).slice().sort((a,b)=>((a+6)%7)-((b+6)%7));
  if(!ds.length) return 'no days';
  const runs=[]; ds.forEach(d=>{ const r=runs[runs.length-1]; if(r && ((r[r.length-1]+1)%7)===d) r.push(d); else runs.push([d]) });
  return runs.map(r=>r.length>=3?MT_DAY_NAMES[r[0]]+'–'+MT_DAY_NAMES[r[r.length-1]]:r.map(d=>MT_DAY_NAMES[d]).join(', ')).join(', ');
}

/* ===================== 3. THE RULES (calendar_settings) ===================== */

/* One row, checked. Anything missing or odd in it falls back field by field, so
   a half-filled row still gives a working calendar. */
function mtCleanSettings(row){
  const r = row && typeof row==='object' ? row : {};
  const F = MT_FALLBACK;
  const open  = !isNaN(mtHmMin(r.open_time))  ? String(r.open_time).trim()  : F.open_time;
  const close = !isNaN(mtHmMin(r.close_time)) ? String(r.close_time).trim() : F.close_time;
  const sane  = mtHmMin(open) < mtHmMin(close);
  const days  = Array.isArray(r.days) ? r.days.map(Number).filter(n=>Number.isInteger(n)&&n>=0&&n<=6) : null;
  const slot  = Number(r.slot_minutes);
  const notice= Number(r.min_notice_h);
  const ahead = Number(r.days_ahead);
  return {
    id:           1,
    open_time:    sane?open:F.open_time,
    close_time:   sane?close:F.close_time,
    days:         days && days.length ? days : F.days.slice(),
    slot_minutes: Number.isFinite(slot) && slot>=5 && slot<=240 ? Math.round(slot) : F.slot_minutes,
    min_notice_h: Number.isFinite(notice) && notice>=0 ? notice : F.min_notice_h,
    days_ahead:   Number.isFinite(ahead) && ahead>=1 ? Math.round(ahead) : F.days_ahead,
    us_zone:      mtZoneOk(r.us_zone) ? r.us_zone : F.us_zone,
    owner_zone:   mtZoneOk(r.owner_zone) ? r.owner_zone : F.owner_zone,
    meeting_link: r.meeting_link==null || r.meeting_link==='' ? null : String(r.meeting_link),
    fallback:     !row
  };
}
/* Read the one row. Cached for the page; pass true to read it again. */
async function mtSettings(force){
  if(mt.settings && !force) return mtOk(mt.settings);
  const r = await mtRun(() => sb.from('calendar_settings').select('*').eq('id',1).maybeSingle(), null);
  if(!r.ok) return r;
  mt.settings = mtCleanSettings(r.data);
  return mtOk(mt.settings);
}
/* The rules as they stand right now, without waiting — the fallback until the
   row has been read once. Renderers use this; the data functions await mtSettings. */
function mtSettingsNow(){ return mt.settings || mtCleanSettings(null) }
function mtHoursLine(st){
  const s = st || mtSettingsNow();
  const ref = mtDayKey(mtNow(), s.us_zone);
  const a = mtZoneToUtc(ref, s.open_time, s.us_zone), b = mtZoneToUtc(ref, s.close_time, s.us_zone);
  if(!a||!b) return '';
  return 'Call hours: '+mtDaysText(s.days)+', '+mtTime(a,s.us_zone)+' – '+mtTime(b,s.us_zone)+' '+mtZoneName(s.us_zone)
       + ' (that is '+mtTime(a,s.owner_zone)+' – '+mtTime(b,s.owner_zone)+' '+mtZoneName(s.owner_zone)+'), '
       + s.slot_minutes+'-minute slots.';
}

/* ===================== 4. FREE SLOTS ===================== */

function mtOverlap(aS,aE,bS,bE){ return aS < bE && bS < aE }
function mtMinutesOf(m, st){
  const n = Math.round(Number(m && m.minutes));
  return Number.isFinite(n) && n>=5 && n<=480 ? n : (st||mtSettingsNow()).slot_minutes;
}
function mtHoldsTime(m){ return !!m && MT_FREES_TIME.indexOf(String(m.status||'booked')) < 0 }
/* Everything already on the calendar that overlaps a window: meetings that hold
   their time, and blocks. One query each. */
async function mtBusy(fromIso, toIso){
  const st = mtSettingsNow();
  const back = new Date(Date.parse(fromIso) - 8*3600000).toISOString();   // a meeting that started earlier can still run into the window
  const ms = await mtRun(() => sb.from('meetings').select('*')
    .gte('starts_at', back).lt('starts_at', toIso).order('starts_at'), []);
  if(!ms.ok) return ms;
  const bl = await mtRun(() => sb.from('calendar_blocks').select('*')
    .gt('ends_at', fromIso).lt('starts_at', toIso).order('starts_at'), []);
  if(!bl.ok) return bl;
  const taken = [];
  (ms.data||[]).filter(mtHoldsTime).forEach(m=>{
    const d = mtParseDate(m.starts_at); if(!d) return;
    taken.push({from:d.getTime(), to:d.getTime()+mtMinutesOf(m,st)*60000, kind:'meeting', row:m});
  });
  (bl.data||[]).forEach(b=>{
    const a = mtParseDate(b.starts_at), z = mtParseDate(b.ends_at);
    if(a && z && z>a) taken.push({from:a.getTime(), to:z.getTime(), kind:'block', row:b});
  });
  return mtOk({taken, meetings:(ms.data||[]), blocks:(bl.data||[])});
}
/* What is in the way of a span, or null when it is free. */
function mtClash(taken, fromMs, toMs){
  return (taken||[]).find(t => mtOverlap(fromMs, toMs, t.from, t.to)) || null;
}
/* Is a span inside the open window on an allowed day? Returns a plain sentence
   when it is not, '' when it is. dateISO-free: works off the instant itself. */
function mtWindowProblem(startMs, minutes, st){
  const s = st || mtSettingsNow();
  const key = mtDayKey(new Date(startMs), s.us_zone);
  if(s.days.indexOf(mtWeekday(key)) < 0)
    return 'That day is not one of your calling days — those are '+mtDaysText(s.days)+'.';
  const open = mtZoneToUtc(key, s.open_time, s.us_zone), close = mtZoneToUtc(key, s.close_time, s.us_zone);
  if(!open || !close) return 'Your call hours are not set properly, so nothing can be booked.';
  if(startMs < open.getTime() || startMs + minutes*60000 > close.getTime())
    return 'That time is outside your call hours of '+mtTime(open,s.us_zone)+' to '+mtTime(close,s.us_zone)+' '+mtZoneName(s.us_zone)+'.';
  return '';
}

/* The free slots of one day. `dateISO` is a US Eastern date ("YYYY-MM-DD"),
   because the window, the days and the prospects are all on the US side.
   Each slot carries both clocks: US Eastern and Sri Lanka. */
async function mtSlots(dateISO){
  if(!mtKeyOk(dateISO)) return mtErr('That is not a date I can read. Use a date like 2026-11-24.');
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data;
  const now = mtNow();
  const today = mtDayKey(now, st.us_zone);

  if(st.days.indexOf(mtWeekday(dateISO)) < 0) return mtOk([]);          // not a calling day
  const ahead = mtDaysBetween(today, dateISO);
  if(ahead < 0 || ahead > st.days_ahead) return mtOk([]);               // in the past, or further out than we take bookings

  const open = mtZoneToUtc(dateISO, st.open_time, st.us_zone);
  const close = mtZoneToUtc(dateISO, st.close_time, st.us_zone);
  if(!open || !close || close <= open) return mtOk([]);

  const busy = await mtBusy(open.toISOString(), close.toISOString());
  if(!busy.ok) return busy;

  const step = st.slot_minutes*60000;
  const earliest = now.getTime() + st.min_notice_h*3600000;
  const out = [];
  for(let s = open.getTime(); s + step <= close.getTime(); s += step){
    if(s < earliest) continue;                                          // min_notice_h
    if(mtClash(busy.data.taken, s, s+step)) continue;                   // a meeting or a block
    const w = mtBothZones(new Date(s), st);
    out.push({
      startsAt: new Date(s).toISOString(),
      endsAt:   new Date(s+step).toISOString(),
      minutes:  st.slot_minutes,
      usDate:   dateISO,
      us:       w.usTime,          usZone:    st.us_zone,     usLabel: w.us,
      lk:       w.ownerTime,       ownerZone: st.owner_zone,  lkLabel: w.owner,
      lkDate:   w.ownerKey,        both:      w.both
    });
  }
  return mtOk(out);
}
/* The free slots of a whole week, keyed by US date — what viewCalendar draws. */
async function mtWeekSlots(mondayISO){
  const keys = [0,1,2,3,4,5,6].map(i=>mtAddDays(mondayISO,i));
  const out = {};
  for(const k of keys){
    const r = await mtSlots(k);
    if(!r.ok) return r;
    out[k] = r.data;
  }
  return mtOk(out);
}

/* ===================== 5. BOOKING ===================== */

/* Write a meetings row. Refuses a taken slot, or one outside the window, with a
   plain sentence — nothing is written when it refuses. */
async function mtBook(b){
  const o = b && typeof b==='object' ? b : {};
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data;

  const kind = String(o.kind||'').trim();
  if(!MT_KINDS[kind]) return mtErr('That is not a kind of call we book. Pick one of: '+Object.keys(MT_KINDS).join(', ')+'.');
  const d = mtParseDate(o.startsAt);
  if(!d) return mtErr('That start time is not a time I can read.');
  const minutes = mtMinutesOf({minutes:o.minutes}, st);
  const startMs = d.getTime();

  if(startMs < mtNow().getTime()) return mtErr('That time has already passed.');
  const win = mtWindowProblem(startMs, minutes, st);
  if(win) return mtErr(win);

  const busy = await mtBusy(new Date(startMs).toISOString(), new Date(startMs+minutes*60000).toISOString());
  if(!busy.ok) return busy;
  const clash = mtClash(busy.data.taken, startMs, startMs+minutes*60000);
  if(clash) return mtErr(clash.kind==='block'
    ? 'That time is blocked out, so nothing can be booked in it.'
    : 'That time is already taken by another call.');

  const zone = mtZoneOk(o.timeZone) ? o.timeZone : st.us_zone;
  return mtRun(() => sb.from('meetings').insert({
    client_id:   o.clientId  || null,
    booking_id:  o.bookingId || null,
    kind,
    starts_at:   new Date(startMs).toISOString(),
    minutes,
    time_zone:   zone,
    status:      'booked',
    meet_link:   o.meetLink || st.meeting_link || null,
    notes:       o.notes ? String(o.notes).slice(0,2000) : null
  }).select().single(), null);
}

/* One meeting by id. */
async function mtMeeting(id){
  const r = await mtRun(() => sb.from('meetings').select('*').eq('id', id).maybeSingle(), null);
  if(!r.ok) return r;
  if(!r.data) return mtErr('That meeting is not on the calendar any more.');
  return r;
}

/* Move a call. The same window and clash checks as booking, and the reminder
   stamps are cleared so the nudges go out again for the new time. */
async function mtReschedule(id, startsAt){
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data;
  const cur = await mtMeeting(id); if(!cur.ok) return cur;
  const m = cur.data;
  if(String(m.status) === 'cancelled') return mtErr('That call was cancelled. Book a new one instead of moving it.');

  const d = mtParseDate(startsAt);
  if(!d) return mtErr('That new start time is not a time I can read.');
  const minutes = mtMinutesOf(m, st);
  const startMs = d.getTime();
  if(startMs < mtNow().getTime()) return mtErr('That time has already passed.');
  const win = mtWindowProblem(startMs, minutes, st);
  if(win) return mtErr(win);

  const busy = await mtBusy(new Date(startMs).toISOString(), new Date(startMs+minutes*60000).toISOString());
  if(!busy.ok) return busy;
  const clash = (busy.data.taken||[]).find(t =>
    mtOverlap(startMs, startMs+minutes*60000, t.from, t.to) &&
    !(t.kind==='meeting' && String(t.row.id)===String(id)));
  if(clash) return mtErr(clash.kind==='block'
    ? 'That time is blocked out, so the call cannot move there.'
    : 'That time is already taken by another call.');

  return mtRun(() => sb.from('meetings').update({
    starts_at:        new Date(startMs).toISOString(),
    status:           'booked',
    reminded_24h_at:  null,
    reminded_1h_at:   null
  }).eq('id', id).select().single(), null);
}

/* Call off a meeting. A cancelled `qualified` call is also marked as not
   delivered, so a call nobody turned up for can never sit in the month's
   number. See mtNoShow for the same promise. */
async function mtCancel(id, reason){
  const cur = await mtMeeting(id); if(!cur.ok) return cur;
  const m = cur.data;
  let call = null;
  if(String(m.kind) === 'qualified'){
    const r = await mtSetCallHappened(m, false);
    if(!r.ok) return mtErr('The call could not be marked as not delivered, so nothing was cancelled. Try again.');
    call = r.data;
  }
  const up = await mtRun(() => sb.from('meetings').update({
    status: 'cancelled',
    held_at: null,
    notes: mtAddNote(m.notes, reason ? 'Cancelled: '+String(reason).slice(0,400) : 'Cancelled')
  }).eq('id', id).select().single(), null);
  if(!up.ok) return up;
  return mtOk({meeting: up.data, call, counted:false});
}
function mtAddNote(notes, line){
  const old = notes==null ? '' : String(notes);
  return (old ? old+'\n' : '') + String(line||'');
}

/* ===================== 6. BLOCKS ===================== */

async function mtBlock(startsAt, endsAt, reason){
  const a = mtParseDate(startsAt), z = mtParseDate(endsAt);
  if(!a || !z) return mtErr('I need a start time and an end time I can read.');
  if(z <= a) return mtErr('The end of the block has to be after its start.');
  const busy = await mtBusy(a.toISOString(), z.toISOString());
  if(!busy.ok) return busy;
  const clash = (busy.data.taken||[]).find(t => t.kind==='meeting' && mtOverlap(a.getTime(), z.getTime(), t.from, t.to));
  if(clash) return mtErr('There is already a call in that time. Move or cancel the call first.');
  return mtRun(() => sb.from('calendar_blocks').insert({
    starts_at: a.toISOString(),
    ends_at:   z.toISOString(),
    reason:    reason ? String(reason).slice(0,300) : null
  }).select().single(), null);
}
async function mtUnblock(id){
  return mtRun(() => sb.from('calendar_blocks').delete().eq('id', id).select(), []);
}
async function mtBlocks(fromIso, toIso){
  return mtRun(() => {
    let q = sb.from('calendar_blocks').select('*');
    if(toIso)   q = q.lt('starts_at', toIso);
    if(fromIso) q = q.gt('ends_at', fromIso);
    return q.order('starts_at');
  }, []);
}

/* ===================== 7. REMINDERS ===================== */
/* This finds the nudges and stamps them. It sends nothing — there is no mail
   server here. Each meeting is found once: the stamp is part of the question,
   so a stamped meeting never comes back. */

/* The meetings needing a 24-hour or a 1-hour nudge, soonest first.
   Each entry: {which:'24h'|'1h', meeting, when:{both zones}, minutesAway}. */
async function mtDue(){
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data;
  const now = mtNow().getTime();
  const nowIso = new Date(now).toISOString();
  const in1h  = new Date(now + 3600000).toISOString();
  const in24h = new Date(now + 24*3600000).toISOString();

  const one = await mtRun(() => sb.from('meetings').select('*')
    .eq('status','booked').is('reminded_1h_at', null)
    .gte('starts_at', nowIso).lte('starts_at', in1h).order('starts_at'), []);
  if(!one.ok) return one;
  const day = await mtRun(() => sb.from('meetings').select('*')
    .eq('status','booked').is('reminded_24h_at', null)
    .gte('starts_at', nowIso).lte('starts_at', in24h).order('starts_at'), []);
  if(!day.ok) return day;

  const seen = {};
  const out = [];
  const add = (m, which) => {
    if(!m || m.id==null) return;
    const key = m.id+'|'+which;
    if(seen[key]) return;
    seen[key] = 1;
    const d = mtParseDate(m.starts_at); if(!d) return;
    out.push({which, meeting:m, when: mtBothZones(d, st), minutesAway: Math.round((d.getTime()-now)/60000)});
  };
  one.data.forEach(m => add(m,'1h'));
  day.data.forEach(m => add(m,'24h'));
  out.sort((a,b) => a.minutesAway - b.minutesAway || (a.which===b.which?0:a.which==='1h'?-1:1));
  // TODO: the send hooks in here — walk this list, send each nudge, and call
  // mtMarkReminded(entry.meeting.id, entry.which) only once the send succeeded.
  return mtOk(out);
}
/* Stamp a nudge as sent. `which` is '24h' or '1h'. */
async function mtMarkReminded(id, which){
  const w = String(which||'').replace(/[^0-9a-z]/gi,'').toLowerCase();
  const col = w==='24h'||w==='24' ? 'reminded_24h_at' : w==='1h'||w==='1' ? 'reminded_1h_at' : '';
  if(!col) return mtErr('A reminder is either the 24-hour one or the 1-hour one.');
  const patch = {}; patch[col] = mtNow().toISOString();
  return mtRun(() => sb.from('meetings').update(patch).eq('id', id).select().single(), null);
}

/* ===================== 8. OUTCOMES — and whether a call counts ===================== */
/* A `qualified` meeting IS a booked sales call we promised the client, so the
   meeting and its qualified_calls row have to say the same thing. The money
   rules live in the database (finance.js): a call counts only when it matched
   the ICP, the prospect showed up and no dispute was upheld. The only part of
   that this file owns is `happened`.

   The promise: a no-show can never silently count as a delivered call. So for a
   no-show the money side is written FIRST, and if that write fails nothing else
   changes and the error says so. For "held" the meeting is marked first and the
   call second, because that order can only ever undercount, never over. */

/* The qualified_calls row of a meeting: same client, same booked time. */
async function mtSetCallHappened(m, happened){
  if(!m || m.client_id==null) return mtOk(null);         // no client, no money row to keep honest
  const patch = happened
    ? {happened:true,  happened_at: m.starts_at}
    : {happened:false, happened_at: null};
  const r = await mtRun(() => sb.from('qualified_calls').update(patch)
    .eq('client_id', m.client_id).eq('booked_for', m.starts_at).select(), []);
  if(!r.ok) return r;
  return mtOk(Array.isArray(r.data) ? (r.data[0] || null) : r.data);
}

/* They turned up. */
async function mtHeld(id){
  const cur = await mtMeeting(id); if(!cur.ok) return cur;
  const m = cur.data;
  const up = await mtRun(() => sb.from('meetings').update({
    status:'held', held_at: mtNow().toISOString()
  }).eq('id', id).select().single(), null);
  if(!up.ok) return up;
  if(String(m.kind) !== 'qualified') return mtOk({meeting: up.data, call:null, counted:false});
  const call = await mtSetCallHappened(m, true);
  if(!call.ok) return mtErr('The call is marked as done, but the booked sales call was not counted. Open the client and mark it there.');
  if(!call.data) return mtOk({meeting: up.data, call:null, counted:false,
    note:'Marked as done. No booked sales call matched this time, so the month\u2019s number has not changed.'});
  return mtOk({meeting: up.data, call: call.data, counted:true});
}

/* They did not turn up. The money side first, always. */
async function mtNoShow(id){
  const cur = await mtMeeting(id); if(!cur.ok) return cur;
  const m = cur.data;
  let call = null;
  if(String(m.kind) === 'qualified'){
    const r = await mtSetCallHappened(m, false);
    if(!r.ok) return mtErr('They did not show, but the booked sales call could not be marked as not delivered, so nothing was changed. Try again.');
    call = r.data;
  }
  const up = await mtRun(() => sb.from('meetings').update({
    status:'no_show', held_at: null
  }).eq('id', id).select().single(), null);
  if(!up.ok) return up;
  return mtOk({meeting: up.data, call, counted:false});
}

/* ===================== 9. READING THE CALENDAR ===================== */

async function mtMeetings(fromIso, toIso, opts){
  const o = opts || {};
  return mtRun(() => {
    let q = sb.from('meetings').select('*');
    if(fromIso) q = q.gte('starts_at', fromIso);
    if(toIso)   q = q.lt('starts_at', toIso);
    if(o.clientId) q = q.eq('client_id', o.clientId);
    if(o.status)   q = q.eq('status', o.status);
    return q.order('starts_at');
  }, []);
}
/* A week at a glance: seven US days, each with its meetings, blocks and free slots. */
async function mtWeek(mondayISO){
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data;
  const monday = mtKeyOk(mondayISO) ? mtMonday(mondayISO) : mtMonday(mtDayKey(mtNow(), st.us_zone));
  const from = mtZoneToUtc(monday, '00:00', st.us_zone);
  const to   = mtZoneToUtc(mtAddDays(monday,7), '00:00', st.us_zone);
  if(!from || !to) return mtErr('Your call hours are not set properly, so the week cannot be drawn.');

  const ms = await mtMeetings(from.toISOString(), to.toISOString());
  if(!ms.ok) return ms;
  const bl = await mtBlocks(from.toISOString(), to.toISOString());
  if(!bl.ok) return bl;
  const slots = await mtWeekSlots(monday);
  if(!slots.ok) return slots;

  const today = mtDayKey(mtNow(), st.us_zone);
  const days = [0,1,2,3,4,5,6].map(i=>{
    const key = mtAddDays(monday,i);
    const items = (ms.data||[]).filter(m=>{
      const d = mtParseDate(m.starts_at);
      return d && mtDayKey(d, st.us_zone)===key;
    }).map(m=>({meeting:m, when: mtBothZones(m.starts_at, st), minutes: mtMinutesOf(m,st)}));
    const blocks = (bl.data||[]).filter(b=>{
      const d = mtParseDate(b.starts_at);
      return d && mtDayKey(d, st.us_zone)===key;
    }).map(b=>({block:b, when: mtBothZones(b.starts_at, st), until: mtBothZones(b.ends_at, st)}));
    return {
      key, label: mtKeyDay(key), today: key===today, past: key<today,
      open: st.days.indexOf(mtWeekday(key))>=0,
      items, blocks, slots: slots.data[key] || []
    };
  });
  return mtOk({st, monday, days, meetings: ms.data||[], blocks: bl.data||[], empty: !days.some(d=>d.items.length||d.blocks.length)});
}

/* The recent no-shows, and what each one did to the month's count. */
async function mtNoShows(){
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data;
  const since = new Date(mtNow().getTime() - MT_NOSHOW_DAYS*864e5).toISOString();
  const ms = await mtRun(() => sb.from('meetings').select('*')
    .eq('status','no_show').gte('starts_at', since).order('starts_at', {ascending:false}), []);
  if(!ms.ok) return ms;
  const rows = ms.data || [];
  let calls = [];
  const times = rows.filter(m=>String(m.kind)==='qualified' && m.starts_at).map(m=>m.starts_at);
  if(times.length){
    const q = await mtRun(() => sb.from('qualified_calls').select('*').in('booked_for', times), []);
    if(!q.ok) return q;
    calls = q.data || [];
  }
  const monthKey = mtDayKey(mtNow(), st.us_zone).slice(0,7);
  let thisMonth = 0;
  const list = rows.map(m=>{
    const qualified = String(m.kind)==='qualified';
    const call = qualified ? (calls.find(c => String(c.client_id)===String(m.client_id) && c.booked_for===m.starts_at) || null) : null;
    const when = mtBothZones(m.starts_at, st);
    const inMonth = !!when && when.usKey.slice(0,7)===monthKey;
    if(qualified && inMonth) thisMonth++;
    return {
      meeting:m, when, call, qualified, inMonth,
      effect: !qualified
        ? 'Not a booked sales call, so the month\u2019s count is untouched.'
        : call
          ? (call.happened === false
              ? 'The booked sales call is marked as not delivered, so it does not count towards the month.'
              : 'Careful: the booked sales call still says it happened. Mark the no-show again.')
          : 'No booked sales call matched this time, so nothing was counted for it.'
    };
  });
  return mtOk({st, list, thisMonth, monthKey, days: MT_NOSHOW_DAYS});
}

/* ===================== 10. RENDERERS (pure: data → HTML) ===================== */

function mtKindWord(k){ return MT_KINDS[String(k||'')] || 'Call' }
function mtStatusOf(s){ return MT_STATUS[String(s||'')] || {word:String(s||'—'), pill:'grey'} }
function mtWho(m){
  const o = m || {};
  if(o.client_id) return 'Client ' + String(o.client_id).slice(0,8);
  if(o.booking_id) return 'Booking ' + String(o.booking_id).slice(0,8);
  return 'No client on this one';
}
function mtPill(s){ const S = mtStatusOf(s); return '<span class="pill '+esc(S.pill)+'">'+esc(S.word)+'</span>' }
function mtZonesNote(st){
  const s = st || mtSettingsNow();
  return '<p class="mt-zones">Every time is shown twice: '+esc(mtZoneName(s.us_zone))+' first, then '+esc(mtZoneName(s.owner_zone))+'.</p>';
}
function mtTwoTimes(w, st){
  if(!w) return '<span class="mt-when">No time</span>';
  const s = st || mtSettingsNow();
  return '<span class="mt-when"><b>'+esc(w.usTime)+'</b> <small>'+esc(mtZoneName(s.us_zone))+'</small>'
       + '<i>'+esc(w.ownerTime)+' '+esc(mtZoneName(s.owner_zone))+'</i></span>';
}

function mtRenderSlot(s){
  return '<button type="button" class="mt-slot" onclick="mtPickSlot('+mtJsArg(s.startsAt)+')">'
       + '<b>'+esc(s.us)+'</b><small>'+esc(s.lk)+' '+esc(mtZoneName(s.ownerZone))+'</small></button>';
}
/* A string into an onclick handler, quoted and escaped — never raw. */
function mtJsArg(v){ return "'"+String(v==null?'':v).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/</g,'\\u003c').replace(/&/g,'\\u0026')+"'" }

function mtRenderMeetingRow(it, st){
  const m = it.meeting;
  return '<li><button type="button" class="mt-row" onclick="mtOpenMeeting('+mtJsArg(m.id)+')">'
       + mtTwoTimes(it.when, st)
       + '<span class="mt-row-main"><b>'+esc(mtKindWord(m.kind))+'</b><small>'+esc(mtWho(m))+' · '+it.minutes+' min</small></span>'
       + mtPill(m.status) + '</button></li>';
}
function mtRenderBlockRow(b, st){
  return '<li class="mt-blockrow">'+mtTwoTimes(b.when, st)
       + '<span class="mt-row-main"><b>Blocked out</b><small>'+esc(b.block.reason||'No reason given')+'</small></span>'
       + '<button type="button" class="mt-textbtn" onclick="mtUnblockClick('+mtJsArg(b.block.id)+')">Unblock</button></li>';
}
/* A week at a glance: both zones, blocks and meetings on it, a free slot opens
   the booking panel. Draws with zero rows. */
function mtRenderWeek(wk){
  if(!wk) return '<div class="card mt-card"><p class="mt-none">Nothing to show yet.</p></div>';
  const st = wk.st || mtSettingsNow();
  const head = '<div class="mt-bar">'
    + '<button type="button" class="btn ghost" onclick="mtWeekMove(-1)" aria-label="Earlier week">◀</button>'
    + '<button type="button" class="btn ghost" onclick="mtThisWeek()">This week</button>'
    + '<button type="button" class="btn ghost" onclick="mtWeekMove(1)" aria-label="Next week">▶</button>'
    + '<b class="mt-range">'+esc(mtKeyDay(wk.monday))+' – '+esc(mtKeyDay(mtAddDays(wk.monday,6)))+'</b>'
    + '<button type="button" class="btn ghost mt-blockbtn" onclick="mtOpenBlock()">Block time</button></div>';
  const days = wk.days.map(d=>{
    const inner = !d.open
      ? '<p class="mt-none">Not a calling day.</p>'
      : (d.blocks.length ? '<ul class="mt-list">'+d.blocks.map(b=>mtRenderBlockRow(b,st)).join('')+'</ul>' : '')
        + (d.items.length ? '<ul class="mt-list">'+d.items.map(it=>mtRenderMeetingRow(it,st)).join('')+'</ul>'
                          : '<p class="mt-none">No calls.</p>')
        + (d.slots.length ? '<div class="mt-slots">'+d.slots.map(mtRenderSlot).join('')+'</div>'
                          : '<p class="mt-none">No free times left.</p>');
    return '<section class="mt-day'+(d.today?' today':'')+(d.past?' past':'')+'">'
         + '<h4>'+esc(d.label)+(d.today?' <span class="mt-tag">Today</span>':'')+'</h4>'+inner+'</section>';
  }).join('');
  return '<div class="mt-week">'+head+mtZonesNote(st)
       + '<p class="mt-hours">'+esc(mtHoursLine(st))+(st.fallback?' (the saved rules could not be read, so these are the usual ones)':'')+'</p>'
       + (wk.empty?'<p class="mt-none">Nothing booked this week yet. Pick a free time below to book a call.</p>':'')
       + '<div class="mt-days">'+days+'</div></div>';
}
/* One meeting: who, when in both zones, the link, the reminders, the buttons. */
function mtRenderMeeting(data){
  if(!data || !data.meeting) return '<div class="card mt-card"><p class="mt-none">That meeting is not on the calendar any more.</p></div>';
  const m = data.meeting, w = data.when, st = data.st || mtSettingsNow();
  const status = String(m.status||'booked');
  const link = /^https:\/\//i.test(String(m.meet_link||'')) ? String(m.meet_link) : '';
  const rem = [
    ['24 hours before', m.reminded_24h_at],
    ['1 hour before',   m.reminded_1h_at]
  ].map(([lbl,at])=>{
    const d = mtParseDate(at);
    return '<li>'+esc(lbl)+': '+(d?'sent '+esc(mtDayName(d,st.us_zone))+', '+esc(mtTime(d,st.us_zone))+' '+esc(mtZoneName(st.us_zone)):'not sent yet')+'</li>';
  }).join('');
  const kv = [
    ['Who', esc(mtWho(m))],
    ['What', esc(mtKindWord(m.kind))],
    ['Status', mtPill(status)],
    ['How long', esc(mtMinutesOf(m,st)+' minutes')],
    ['Their time zone', esc(m.time_zone||st.us_zone)],
    ['Link', link?'<a href="'+esc(link)+'" target="_blank" rel="noopener noreferrer">Join the call</a>':'No link on this one yet']
  ];
  if(m.notes) kv.push(['Notes','<span class="mt-note">'+esc(m.notes)+'</span>']);
  if(String(m.kind)==='qualified') kv.push(['The money side', data.call
    ? (data.call.happened ? 'Counted as delivered for the month.' : 'Not counted for the month.')
    : 'No booked sales call matched this time.']);
  const acts = [];
  if(status==='booked'){
    acts.push('<button type="button" class="btn" onclick="mtHeldClick('+mtJsArg(m.id)+')">Call done</button>');
    acts.push('<button type="button" class="btn ghost" onclick="mtNoShowClick('+mtJsArg(m.id)+')">No-show</button>');
    acts.push('<button type="button" class="btn ghost" onclick="mtCancelClick('+mtJsArg(m.id)+')">Cancel</button>');
  }
  return '<div class="card mt-card mt-one">'
    + '<h3>'+esc(mtKindWord(m.kind))+'</h3>'
    + (w?'<p class="mt-big"><b>'+esc(w.usDay)+' · '+esc(w.usTime)+' '+esc(mtZoneName(st.us_zone))+'</b><span>'+esc(w.ownerDay)+' · '+esc(w.ownerTime)+' '+esc(mtZoneName(st.owner_zone))+'</span></p>':'<p class="mt-big"><b>No time on this one</b></p>')
    + '<dl class="mt-kv">'+kv.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+v+'</dd>').join('')+'</dl>'
    + '<h4>Reminders</h4><ul class="mt-rem">'+rem+'</ul>'
    + (acts.length?'<div class="mt-acts">'+acts.join('')+'</div>':'')
    + '</div>';
}
/* The recent no-shows and what each one did to the month's count. Zero rows is
   the good case, and it says so. */
function mtRenderNoShows(data){
  const d = data || {list:[], thisMonth:0, days:MT_NOSHOW_DAYS};
  const list = Array.isArray(d.list) ? d.list : [];
  const head = '<p class="mt-sum">'+(d.thisMonth
      ? esc(d.thisMonth+(d.thisMonth===1?' booked sales call':' booked sales calls')+' did not count this month, because nobody turned up.')
      : 'No booked sales call has been lost to a no-show this month.')+'</p>';
  if(!list.length) return '<div class="card mt-card">'+head+'<p class="mt-none">No no-shows in the last '+esc(d.days)+' days.</p></div>';
  return '<div class="card mt-card">'+head+'<ul class="mt-list mt-noshows">'
    + list.map(x=>'<li><button type="button" class="mt-row" onclick="mtOpenMeeting('+mtJsArg(x.meeting.id)+')">'
        + mtTwoTimes(x.when, d.st)
        + '<span class="mt-row-main"><b>'+esc(mtKindWord(x.meeting.kind))+'</b><small>'+esc(mtWho(x.meeting))+'</small>'
        + '<small class="mt-effect">'+esc(x.effect)+'</small></span></button></li>').join('')
    + '</ul></div>';
}

/* ===================== 11. THE SCREENS ===================== */
/* The shell router calls these. Each returns its host right away and fills it
   in once Supabase answers, so a slow database never blocks the screen. */

function mtHost(id, inner){ return '<div id="'+id+'">'+inner+'</div>' }
function mtLoading(what){ return '<div class="card mt-card"><p class="mt-none">'+esc(what)+'</p></div>' }
function mtErrorHTML(msg, retry){
  return '<div class="card mt-card"><p class="mt-err" role="alert">'+esc(msg||'Something went wrong.')+'</p>'
       + '<button type="button" class="btn" onclick="'+esc(retry)+'">Try again</button></div>';
}
function mtPaint(id, html){
  try{ const h = document.getElementById(id); if(h) h.innerHTML = html; }catch(e){}
}

function viewCalendar(){
  const st = mtSettingsNow();
  if(!mtKeyOk(mt.week)) mt.week = mtMonday(mtDayKey(mtNow(), st.us_zone));
  mtLoadWeek();
  return mtHost('mtWeekHost', mt.days ? mtRenderWeek(mt.days) : mtLoading('Loading your calendar…'));
}
async function mtLoadWeek(){
  const r = await mtWeek(mt.week);
  mt.err = r.ok ? '' : r.error;
  mt.days = r.ok ? r.data : null;
  mtPaint('mtWeekHost', r.ok ? mtRenderWeek(r.data) : mtErrorHTML(r.error, 'mtLoadWeek()'));
  return r;
}
function mtWeekMove(n){
  const st = mtSettingsNow();
  if(!mtKeyOk(mt.week)) mt.week = mtMonday(mtDayKey(mtNow(), st.us_zone));
  mt.week = mtAddDays(mt.week, 7*n);
  mtPaint('mtWeekHost', mtLoading('Loading…'));
  return mtLoadWeek();
}
function mtThisWeek(){
  mt.week = mtMonday(mtDayKey(mtNow(), mtSettingsNow().us_zone));
  return mtLoadWeek();
}

function viewMeeting(id){
  const key = id==null || id==='' ? (mt.one && mt.one.id) : id;
  if(key==null || key==='') return mtHost('mtOneHost', mtRenderMeeting(null));
  mt.one = {id:key, data:null};
  mtLoadMeeting(key);
  return mtHost('mtOneHost', mtLoading('Loading the call…'));
}
async function mtLoadMeeting(id){
  const got = await mtSettings();
  const st = got.ok ? got.data : mtSettingsNow();
  const r = await mtMeeting(id);
  if(!r.ok){ mtPaint('mtOneHost', mtErrorHTML(r.error, 'mtLoadMeeting('+mtJsArg(id)+')')); return r }
  const m = r.data;
  let call = null;
  if(String(m.kind)==='qualified' && m.client_id!=null){
    const q = await mtRun(() => sb.from('qualified_calls').select('*')
      .eq('client_id', m.client_id).eq('booked_for', m.starts_at).maybeSingle(), null);
    if(q.ok) call = q.data;
  }
  const data = {meeting:m, when: mtBothZones(m.starts_at, st), call, st};
  mt.one = {id, data};
  mtPaint('mtOneHost', mtRenderMeeting(data));
  return mtOk(data);
}

function viewNoShows(){
  mtLoadNoShows();
  return mtHost('mtNoShowHost', mt.noshows ? mtRenderNoShows(mt.noshows) : mtLoading('Looking for no-shows…'));
}
async function mtLoadNoShows(){
  const r = await mtNoShows();
  mt.noshows = r.ok ? r.data : null;
  mtPaint('mtNoShowHost', r.ok ? mtRenderNoShows(r.data) : mtErrorHTML(r.error, 'mtLoadNoShows()'));
  return r;
}

/* ===================== 12. BUTTONS ===================== */
/* Every button goes through here: one at a time, a plain toast either way. */

async function mtDo(fn, done){
  if(mt.busy) return mtErr('One thing at a time — that is still going.');
  mt.busy = true;
  try{
    const r = await fn();
    if(typeof toast === 'function') toast(r.ok ? (done||'Done') : r.error);
    return r;
  } finally { mt.busy = false }
}
function mtOpenMeeting(id){
  mt.one = {id, data:null};
  if(typeof openMeeting === 'function'){ try{ return openMeeting(id) }catch(e){} }
  return mtLoadMeeting(id);
}
/* The sidebar badge: calls that have happened and are still waiting to be marked
   done or a no-show. Read straight off what is already loaded — never a query. */
function mtNavCount(){
  const d = mt.days;
  if(!d || !Array.isArray(d.days)) return '';
  const now = mtNow().getTime();
  let n = 0;
  d.days.forEach(day => day.items.forEach(it => {
    const t = mtParseDate(it.meeting.starts_at);
    if(t && String(it.meeting.status)==='booked' && t.getTime() + it.minutes*60000 < now) n++;
  }));
  return n > 0 ? n : '';
}
async function mtHeldClick(id){
  const r = await mtDo(() => mtHeld(id), 'Marked: the call happened');
  if(r.ok && r.data && r.data.note && typeof toast==='function') toast(r.data.note);
  if(r.ok) await mtLoadMeeting(id);
  return r;
}
async function mtNoShowClick(id){
  const r = await mtDo(() => mtNoShow(id), "Marked: they didn't show, and it does not count");
  if(r.ok) await mtLoadMeeting(id);
  return r;
}
async function mtCancelClick(id, reason){
  const why = reason != null ? reason : (typeof prompt==='function' ? prompt('A short reason, if you like') : '');
  const r = await mtDo(() => mtCancel(id, why||''), 'Cancelled');
  if(r.ok) await mtLoadMeeting(id);
  return r;
}
async function mtUnblockClick(id){
  const r = await mtDo(() => mtUnblock(id), 'Unblocked — that time is open again');
  if(r.ok) await mtLoadWeek();
  return r;
}
/* Clicking a free slot: the booking panel, prefilled with that time. */
function mtPickSlot(startsAt){
  mt.pick = String(startsAt||'');
  if(typeof openModal === 'function') openModal(mtRenderBookForm(startsAt));
  return mt.pick;
}
function mtRenderBookForm(startsAt){
  const st = mtSettingsNow(), w = mtBothZones(startsAt, st);
  return '<div class="modal-head"><div><h3>Book this time</h3><p>'+esc(w?w.both:'')+'</p></div></div>'
    + '<div class="modal-body">'
    + '<div class="field"><label for="mtKind">What kind of call</label><select id="mtKind">'
    + Object.keys(MT_KINDS).map(k=>'<option value="'+esc(k)+'">'+esc(MT_KINDS[k])+'</option>').join('')
    + '</select></div>'
    + '<div class="field"><label for="mtClient">Client id (if they are a client)</label><input id="mtClient" autocomplete="off"></div>'
    + '<div class="field"><label for="mtNotes">Notes</label><textarea id="mtNotes" rows="3" maxlength="2000"></textarea></div>'
    + '<div id="mtBookErr" class="login-err"></div></div>'
    + '<div class="modal-foot mt-acts"><button type="button" class="btn ghost" onclick="closeModal()">Close</button>'
    + '<button type="button" class="btn" onclick="mtSubmitBook()">Book it</button></div>';
}
async function mtSubmitBook(){
  const start = mt.pick;
  if(!start) return errEl('mtBookErr','Pick a time first.');
  const r = await mtDo(() => mtBook({
    kind: val('mtKind') || 'discovery',
    clientId: val('mtClient') || null,
    startsAt: start,
    notes: val('mtNotes')
  }), 'Booked');
  if(!r.ok) return errEl('mtBookErr', r.error);
  if(typeof closeModal==='function') closeModal();
  mt.pick = null;
  await mtLoadWeek();
  return r;
}
function mtOpenBlock(){
  if(typeof openModal === 'function') openModal(
    '<div class="modal-head"><div><h3>Block time</h3><p>Mark a time busy so nothing can be booked in it. Times are '+esc(mtZoneName(mtSettingsNow().us_zone))+'.</p></div></div>'
    + '<div class="modal-body"><div class="field row2">'
    + '<div><label for="mtBlkFrom">From</label><input id="mtBlkFrom" type="datetime-local"></div>'
    + '<div><label for="mtBlkTo">To</label><input id="mtBlkTo" type="datetime-local"></div></div>'
    + '<div class="field"><label for="mtBlkWhy">Why</label><input id="mtBlkWhy" maxlength="300" autocomplete="off"></div>'
    + '<div id="mtBlkErr" class="login-err"></div></div>'
    + '<div class="modal-foot mt-acts"><button type="button" class="btn ghost" onclick="closeModal()">Close</button>'
    + '<button type="button" class="btn" onclick="mtSubmitBlock()">Block it</button></div>');
  return true;
}
/* A "2026-11-24T14:00" from the browser is a wall clock in the US zone. */
function mtLocalToUtc(v, zone){
  const s = String(v||'').trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
  if(!m) return null;
  return mtZoneToUtc(m[1], m[2], zone || mtSettingsNow().us_zone);
}
async function mtSubmitBlock(){
  const st = mtSettingsNow();
  const a = mtLocalToUtc(val('mtBlkFrom'), st.us_zone), z = mtLocalToUtc(val('mtBlkTo'), st.us_zone);
  if(!a || !z) return errEl('mtBlkErr','I need a start time and an end time.');
  const r = await mtDo(() => mtBlock(a.toISOString(), z.toISOString(), val('mtBlkWhy')), 'That time is blocked out');
  if(!r.ok) return errEl('mtBlkErr', r.error);
  if(typeof closeModal==='function') closeModal();
  await mtLoadWeek();
  return r;
}

/* Forget everything read so far (used by the tests and by signing out). */
function mtForget(){
  mt.settings = null; mt.week = null; mt.days = null; mt.one = null;
  mt.noshows = null; mt.err = ''; mt.now = null; mt.busy = false; mt.pick = null;
}
