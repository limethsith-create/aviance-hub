/* ===================== AVIANCE OS — Meetings =====================
   The Calendar: the one place every call lives. Website bookings
   (discovery_bookings) and the calls booked here (meetings) are read together,
   turned into one event shape and drawn as a real calendar — a week of
   business days and a month grid, coloured by plan. Clicking a call opens its panel; that is
   where a booking is marked done, a no-show, won or lost. Also here: booking,
   blocking time, reminders, no-shows, and whether a booked call counts.

   Supabase only: everything here goes straight through the shell's `sb` client.
   There is no other server — no machine, no booking service, nothing to call.

   Tables (SCHEMA.md):
     calendar_settings   one row, id=1 — the rules: hours, days, slot size, zones
     calendar_blocks     time the owner marked busy
     meetings            every call booked here: kind, starts_at, minutes, status
     discovery_bookings  every call booked on the website. Read here to draw it
                         and to keep its time taken. Its outcome is written by
                         pipeline.js (plHeld, plNoShow, plCloseWon, plLost), never here.
                         Won opens pipeline.js's plan picker and goes through the
                         `close_won` database rule, which also sends the pack.
     clients             only to name a meeting's client and take its plan colour
     qualified_calls     the money side (finance.js). A `qualified` meeting is a
                         booked sales call we delivered, so marking it held or a
                         no-show must move its qualified_calls row with it.

   pipeline.js loads before this file. The booking's panel is drawn with its
   renderers and every booking outcome goes through its data functions.

   Rules of the house:
     - Every function returns {ok, data, error} and never throws. `error` is a
       plain sentence, safe to show a person.
     - Nothing is hard-coded: the hours, days, slot size and both time zones are
       read from calendar_settings. The constants below are only used when that
       row is missing.
     - Times are stored in UTC. Every conversion goes through Intl.DateTimeFormat
       with a timeZone, so US daylight saving is always right. There is no fixed
       offset anywhere in this file.
     - Every time is shown both ways: the owner's zone first
       (calendar_settings.owner_zone), US Eastern (us_zone) beside it. The month
       is laid out by the owner's days; the week by US business days, because
       the working day crosses midnight in the owner's zone (see section 9).
       The browser's zone is never used.
     - A booking is open unless pipeline.js says it is closed (plIsOpen). There
       is no list of "open" words here; one once hid every real booking.
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
/* The plans, each with its own calm colour (meetings.css) and an initial, so the
   colour is never the only thing telling two plans apart. */
const MT_PLANS = {
  pilot:   {word:'Pilot',   tag:'P'},
  starter: {word:'Starter', tag:'S'},
  growth:  {word:'Growth',  tag:'G'},
  scale:   {word:'Scale',   tag:'Sc'}
};
const MT_NO_PLAN = {word:'No plan yet', tag:'–'};
/* The short word on a chip that sets a call booked here apart from a website one. */
const MT_KIND_SHORT = {discovery:'Discovery', strategy:'Strategy', onboarding:'Onboarding', qualified:'Booked sales call', review:'Review', check_in:'Check-in', other:'Call'};
const MT_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MT_GRID_DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
/* The short name of a zone, for the week's two time columns and beside a time.
   Only names: every offset still comes from Intl. A zone not listed here takes
   Intl's own short name. */
const MT_ZONE_SHORT = {'Asia/Colombo':'SL','America/New_York':'ET','America/Chicago':'CT','America/Denver':'MT','America/Los_Angeles':'PT','America/Phoenix':'AZ'};
const MT_LENGTHS = [15,30,45,60,90];   /* how long a meeting added by hand can be */
const MT_MIN_BLOCK = 30;        /* a shorter call is still drawn this tall, so its name fits */
const MT_VIEW_KEY = 'avianceCalView';  /* localStorage: the view last chosen */
const MT_TAKEN = 'There is already a call at that time.';
const MT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MT_CHIP_MAX = 3;          /* calls shown in a month cell before "+N more" */
const MT_GRACE_MIN = 20;        /* how long after its start a call may sit unmarked */

const mt = {settings:null, view:'week', viewRead:false, day:null, cal:null, needOnly:false, legend:false, open:null, want:null, seq:0,
            one:null, noshows:null, err:'', now:null, busy:false, bound:false};

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
/* "SL", "ET" — or whatever Intl calls a zone we have no short name for. */
function mtZoneShort(z){
  if(Object.prototype.hasOwnProperty.call(MT_ZONE_SHORT, z)) return MT_ZONE_SHORT[z];
  try{
    const p = new Intl.DateTimeFormat('en-US',{timeZone:z,timeZoneName:'short'}).formatToParts(mtNow()).find(x=>x.type==='timeZoneName');
    return p ? p.value : mtZoneName(z);
  }catch(e){ return mtZoneName(z) }
}
/* "7 am", "5:30 pm" — the hour axis has no room for ":00". */
function mtShortTime(d,zone){ return mtTime(d,zone).replace(':00','') }
function mtMinHm(min){ return mtPad(Math.floor(min/60))+':'+mtPad(min%60) }
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
   their time, website bookings that hold theirs, and blocks. One query each.
   If the bookings cannot be read this fails — a time is never offered on a guess. */
async function mtBusy(fromIso, toIso){
  const st = mtSettingsNow();
  const back = new Date(Date.parse(fromIso) - 8*3600000).toISOString();   // a call that started earlier can still run into the window
  const ms = await mtRun(() => sb.from('meetings').select('*')
    .gte('starts_at', back).lt('starts_at', toIso).order('starts_at'), []);
  if(!ms.ok) return ms;
  const bk = await mtRun(() => sb.from('discovery_bookings').select('*')
    .gte('call_at', back).lt('call_at', toIso).order('call_at'), []);
  if(!bk.ok) return bk;
  const bl = await mtRun(() => sb.from('calendar_blocks').select('*')
    .gt('ends_at', fromIso).lt('starts_at', toIso).order('starts_at'), []);
  if(!bl.ok) return bl;
  const taken = [];
  (ms.data||[]).filter(mtHoldsTime).forEach(m=>{
    const d = mtParseDate(m.starts_at); if(!d) return;
    taken.push({from:d.getTime(), to:d.getTime()+mtMinutesOf(m,st)*60000, kind:'meeting', row:m});
  });
  (bk.data||[]).filter(mtHoldsTime).forEach(b=>{
    const d = mtParseDate(b.call_at); if(!d) return;
    taken.push({from:d.getTime(), to:d.getTime()+mtMinutesOf(b,st)*60000, kind:'booking', row:b});
  });
  (bl.data||[]).forEach(b=>{
    const a = mtParseDate(b.starts_at), z = mtParseDate(b.ends_at);
    if(a && z && z>a) taken.push({from:a.getTime(), to:z.getTime(), kind:'block', row:b});
  });
  return mtOk({taken, meetings:(ms.data||[]), bookings:(bk.data||[]), blocks:(bl.data||[])});
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

/* The open window of one US day, or null when nothing can be booked on it:
   not a calling day, in the past, or further out than we take bookings. */
function mtDayWindow(dateISO, st, now){
  if(!mtKeyOk(dateISO) || st.days.indexOf(mtWeekday(dateISO)) < 0) return null;
  const ahead = mtDaysBetween(mtDayKey(now, st.us_zone), dateISO);
  if(ahead < 0 || ahead > st.days_ahead) return null;
  const open = mtZoneToUtc(dateISO, st.open_time, st.us_zone);
  const close = mtZoneToUtc(dateISO, st.close_time, st.us_zone);
  return open && close && close > open ? {open, close} : null;
}
/* The free slots of one US day, given what is already taken. Pure. */
function mtSlotsOn(dateISO, st, taken, now){
  const w = mtDayWindow(dateISO, st, now);
  if(!w) return [];
  const step = st.slot_minutes*60000;
  const earliest = now.getTime() + st.min_notice_h*3600000;
  const out = [];
  for(let s = w.open.getTime(); s + step <= w.close.getTime(); s += step){
    if(s < earliest) continue;                                          // min_notice_h
    if(mtClash(taken, s, s+step)) continue;                             // a meeting, a website booking or a block
    const z = mtBothZones(new Date(s), st);
    out.push({
      startsAt: new Date(s).toISOString(),
      endsAt:   new Date(s+step).toISOString(),
      minutes:  st.slot_minutes,
      usDate:   dateISO,
      us:       z.usTime,          usZone:    st.us_zone,     usLabel: z.us,
      lk:       z.ownerTime,       ownerZone: st.owner_zone,  lkLabel: z.owner,
      lkDate:   z.ownerKey,        both:      z.both
    });
  }
  return out;
}
/* The free slots of one day. `dateISO` is a US Eastern date ("YYYY-MM-DD"),
   because the window, the days and the prospects are all on the US side.
   Each slot carries both clocks: US Eastern and Sri Lanka. */
async function mtSlots(dateISO){
  if(!mtKeyOk(dateISO)) return mtErr('That is not a date I can read. Use a date like 2026-11-24.');
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data, now = mtNow();
  const w = mtDayWindow(dateISO, st, now);
  if(!w) return mtOk([]);
  const busy = await mtBusy(w.open.toISOString(), w.close.toISOString());
  if(!busy.ok) return busy;
  return mtOk(mtSlotsOn(dateISO, st, busy.data.taken, now));
}
/* The free slots between two instants, keyed by the owner's date — or, with
   by='us', by the US date, which is what the week of business days draws.
   One read of what is taken, however many days it covers. */
async function mtRangeSlots(fromMs, toMs, by){
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data, now = mtNow();
  const busy = await mtBusy(new Date(fromMs - 864e5).toISOString(), new Date(toMs + 864e5).toISOString());
  if(!busy.ok) return busy;
  const out = {};
  const last = mtDayKey(new Date(toMs), st.us_zone);
  let k = mtDayKey(new Date(fromMs), st.us_zone);
  for(let i = 0; i < 45 && k && k <= last; i++, k = mtAddDays(k,1)){
    mtSlotsOn(k, st, busy.data.taken, now).forEach(s=>{
      const t = Date.parse(s.startsAt);
      const key = by === 'us' ? s.usDate : s.lkDate;
      if(t >= fromMs && t < toMs) (out[key] = out[key] || []).push(s);
    });
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

/* A duplicate-key answer from the database: the unique index on starts_at. */
function mtIsDup(e){ return !!e && (String(e.code||'') === '23505' || /duplicate key/i.test(String(e.message||''))) }

/* Add one of the owner's own meetings, by hand. It is his calendar, so it may be
   at ANY time — the call hours, calling days and notice that mtBook keeps for
   bookable slots do not apply here. It still refuses a time another call or a
   website booking already holds, and only warns (data.warning) when it lands on
   blocked time. The row is kind 'other'; its colour comes from its plan.
   o: {title, guestName, guestEmail, startsAt, minutes, plan, meetLink} */
async function mtAddOwn(a){
  const o = a && typeof a==='object' ? a : {};
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data;

  const title = String(o.title==null?'':o.title).trim();
  if(!title) return mtErr('Give the meeting a title first.');
  if(title.length > 160) return mtErr('That title is too long — keep it under 160 characters.');
  const guest = String(o.guestName==null?'':o.guestName).trim();
  if(guest.length > 120) return mtErr('That name is too long — keep it under 120 characters.');
  const email = String(o.guestEmail==null?'':o.guestEmail).trim();
  if(email && !MT_EMAIL_RE.test(email)) return mtErr('That email address does not look right. Fix it, or leave it empty.');
  const d = mtParseDate(o.startsAt);
  if(!d) return mtErr('Pick the day and the time first.');
  const raw = o.minutes==null || o.minutes==='' ? 30 : Number(o.minutes);
  if(!Number.isInteger(raw) || raw < 15 || raw > 240) return mtErr('A meeting can be 15, 30, 45, 60 or 90 minutes long.');
  const planIn = String(o.plan==null?'':o.plan).trim();
  if(planIn && !mtPlanKey(planIn)) return mtErr('That is not one of the plans. Pick Pilot, Starter, Growth or Scale, or leave it empty.');
  const link = String(o.meetLink==null?'':o.meetLink).trim();
  if(link && !/^https:\/\/\S+$/i.test(link)) return mtErr('The Google Meet link has to start with https://');

  const startMs = d.getTime(), endMs = startMs + raw*60000;
  const busy = await mtBusy(new Date(startMs).toISOString(), new Date(endMs).toISOString());
  if(!busy.ok) return busy;
  const hits = (busy.data.taken||[]).filter(t => mtOverlap(startMs, endMs, t.from, t.to));
  if(hits.some(t => t.kind !== 'block')) return mtErr(MT_TAKEN);
  const warning = hits.length ? 'Added — but that time is inside a block you marked as busy.' : '';

  let res;
  try{
    res = await sb.from('meetings').insert({
      client_id:   null,
      booking_id:  null,
      kind:        'other',
      title,
      guest_name:  guest || null,
      guest_email: email || null,
      plan:        mtPlanKey(planIn) || null,
      starts_at:   new Date(startMs).toISOString(),
      minutes:     raw,
      time_zone:   st.us_zone,
      status:      'booked',
      meet_link:   link || st.meeting_link || null,
      notes:       null
    }).select().single();
  }catch(e){ return mtIsDup(e) ? mtErr(MT_TAKEN) : mtErr(e) }
  if(!res) return mtErr('No answer from the database.');
  if(res.error) return mtIsDup(res.error) ? mtErr(MT_TAKEN) : mtErr(res.error);
  return mtOk({meeting: res.data, warning});
}

/* One meeting by id. */
async function mtMeeting(id){
  const r = await mtRun(() => sb.from('meetings').select('*').eq('id', id).maybeSingle(), null);
  if(!r.ok) return r;
  if(!r.data) return mtErr('That meeting is not on the calendar any more.');
  return r;
}

/* Move a call. The same window and clash checks as booking, and the reminder
   stamps are cleared so the nudges go out again for the new time. A meeting the
   owner added by hand (kind 'other') may move to any time, as it could be added
   at any time; it still cannot land on another call. */
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
  const own = String(m.kind) === 'other';
  const win = own ? '' : mtWindowProblem(startMs, minutes, st);
  if(win) return mtErr(win);

  const busy = await mtBusy(new Date(startMs).toISOString(), new Date(startMs+minutes*60000).toISOString());
  if(!busy.ok) return busy;
  const clash = (busy.data.taken||[]).find(t =>
    mtOverlap(startMs, startMs+minutes*60000, t.from, t.to) &&
    !(t.kind==='meeting' && String(t.row.id)===String(id)) &&
    !(own && t.kind==='block'));
  if(clash) return mtErr(clash.kind==='block'
    ? 'That time is blocked out, so the call cannot move there.'
    : 'That time is already taken by another call.');

  let res;
  try{
    res = await sb.from('meetings').update({
      starts_at:        new Date(startMs).toISOString(),
      status:           'booked',
      reminded_24h_at:  null,
      reminded_1h_at:   null
    }).eq('id', id).select().single();
  }catch(e){ return mtErr(e) }
  if(res && res.error && mtIsDup(res.error)) return mtErr(MT_TAKEN);
  return mtWrap(res, null);
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
  const clash = (busy.data.taken||[]).find(t => t.kind!=='block' && mtOverlap(a.getTime(), z.getTime(), t.from, t.to));
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
/* ---- one shape for every call ---- */
function mtText(v){ return v==null ? '' : String(v).trim() }
function mtPlanKey(p){ const k = String(p==null?'':p).toLowerCase(); return Object.prototype.hasOwnProperty.call(MT_PLANS,k) ? k : '' }
function mtPlanClass(p){ return 'mt-plan-'+(mtPlanKey(p)||'none') }
function mtPlanTag(p){ const k = mtPlanKey(p); return k ? MT_PLANS[k].tag : MT_NO_PLAN.tag }
function mtPlanWord(p){ const k = mtPlanKey(p); return k ? MT_PLANS[k].word : MT_NO_PLAN.word }
/* A call booked here that has been and gone and is still only "booked". */
function mtMeetingNeedsOutcome(m, now){
  const d = mtParseDate(m && m.starts_at), s = String((m && m.status) || 'booked');
  return !!d && (s==='booked' || s==='requested') && (now||mtNow()).getTime() - d.getTime() > MT_GRACE_MIN*60000;
}
/* The part every event shares: where it sits in the owner's day (the month),
   which US business day it belongs to (the week), and its time both ways. */
function mtEventShape(e, d, st){
  const z = st.owner_zone, p = mtParts(d, z), u = mtParts(d, st.us_zone);
  e.startsAt = d.toISOString(); e.startMs = d.getTime(); e.endMs = e.startMs + e.minutes*60000;
  e.dayKey = mtDayKey(d, z); e.time = mtTime(d, z); e.minuteOfDay = p.h*60 + p.mi;
  e.usKey = mtDayKey(d, st.us_zone); e.usTime = mtTime(d, st.us_zone); e.bizMin = u.h*60 + u.mi;
  e.ownerShort = mtZoneShort(z); e.usShort = mtZoneShort(st.us_zone);
  e.ownerDow = mtWeekdayName(d, z); e.usDow = mtWeekdayName(d, st.us_zone);
  e.both = e.time+' '+e.ownerShort+' · '+e.usTime+' '+e.usShort;
  e.planClass = mtPlanClass(e.plan); e.tag = mtPlanTag(e.plan); e.planWord = mtPlanWord(e.plan);
  return e;
}
/* A website booking as an event, or null when it is not drawn (cancelled, or no time). */
function mtEventOfBooking(b, st, now){
  const d = mtParseDate(b && b.call_at);
  if(!b || b.id==null || !d || !mtHoldsTime(b)) return null;
  const s = st || mtSettingsNow();
  const words = (typeof PL_STATUS_WORDS!=='undefined' && PL_STATUS_WORDS[String(b.status)]) || ['grey', String(b.status||'—')];
  return mtEventShape({
    key:'booking:'+b.id, source:'booking', id:b.id, minutes:mtMinutesOf(b,s),
    title:String(b.company||b.name||'Someone'), who:String(b.name||''), company:String(b.company||''),
    plan:mtPlanKey(b.plan), status:String(b.status||''), statusWord:words[1], pill:words[0],
    kind:'discovery', kindWord:'', meetLink:b.meet_link||'',
    open: typeof plIsOpen==='function' ? plIsOpen(b) : true,
    needsOutcome: typeof plNeedsOutcome==='function' ? plNeedsOutcome(b, now||mtNow()) : false,
    hasBrief: b.has_brief===true, row:b
  }, d, s);
}
/* A call booked here as an event. Its own title, guest and plan come first (a
   meeting added by hand has them); otherwise it takes its client's name and
   plan colour, as before. */
function mtEventOfMeeting(m, st, now, client){
  const d = mtParseDate(m && m.starts_at);
  if(!m || m.id==null || !d || !mtHoldsTime(m)) return null;
  const s = st || mtSettingsNow(), c = client || null, S = mtStatusOf(m.status||'booked');
  return mtEventShape({
    key:'meeting:'+m.id, source:'meeting', id:m.id, minutes:mtMinutesOf(m,s),
    title:String(mtText(m.title) || (c && c.company) || mtKindWord(m.kind)), who:String(mtText(m.guest_name) || (c && c.contact_name) || ''), company:String((c && c.company) || ''),
    email:mtText(m.guest_email),
    plan:mtPlanKey(m.plan) || mtPlanKey(c && c.plan), status:String(m.status||'booked'), statusWord:S.word, pill:S.pill,
    kind:String(m.kind||''), kindWord:String(m.kind)==='other' && mtText(m.title) ? '' : (MT_KIND_SHORT[String(m.kind||'')] || 'Call'), meetLink:m.meet_link||'',
    open: ['booked','requested'].indexOf(String(m.status||'booked')) >= 0,
    needsOutcome: mtMeetingNeedsOutcome(m, now||mtNow()),
    hasBrief:false, row:m
  }, d, s);
}
/* Every call between two instants, from both tables, soonest first — plus the
   blocks. Cancelled calls are left out. */
async function mtEvents(fromIso, toIso){
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data, now = mtNow();
  if(typeof plBookings !== 'function')
    return mtErr('The website bookings could not be read, because part of Aviance OS did not load. Reload the page.');
  const ms = await mtMeetings(fromIso, toIso);
  if(!ms.ok) return ms;
  const bk = await plBookings({from:fromIso, to:toIso});
  if(!bk.ok) return mtErr(bk.error);
  const bl = await mtBlocks(fromIso, toIso);
  if(!bl.ok) return bl;

  /* the clients behind the meetings: a name and a plan colour. Without them the
     calls still draw, in grey. */
  const ids = []; (ms.data||[]).forEach(m=>{ if(m && m.client_id!=null && ids.indexOf(m.client_id)<0) ids.push(m.client_id) });
  const clients = {};
  if(ids.length){
    const c = await mtRun(() => sb.from('clients').select('*').in('id', ids), []);
    if(c.ok) (c.data||[]).forEach(r=>{ if(r && r.id!=null) clients[String(r.id)] = r });
  }
  const events = [];
  (bk.data||[]).forEach(b=>{ const e = mtEventOfBooking(b, st, now); if(e) events.push(e) });
  (ms.data||[]).forEach(m=>{ const e = mtEventOfMeeting(m, st, now, clients[String(m.client_id)]); if(e) events.push(e) });
  events.sort((a,b)=>a.startMs-b.startMs || (a.key<b.key?-1:1));
  return mtOk({st, events, blocks:(bl.data||[]), meetings:(ms.data||[]), bookings:(bk.data||[])});
}

/* ---- the grid ---- */
function mtWeekKeys(dayKey){ const mon = mtMonday(dayKey); return [0,1,2,3,4,5,6].map(i=>mtAddDays(mon,i)) }
/* The whole weeks a month sits in, Monday first. "2026-11" starts on Mon 26 Oct. */
function mtMonthGrid(ym){
  const m = /^(\d{4})-(\d{2})/.exec(String(ym||''));
  const first = m ? m[1]+'-'+m[2]+'-01' : '';
  if(!mtKeyOk(first)) return null;
  const last = m[1]+'-'+m[2]+'-'+mtPad(new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate());
  const start = mtMonday(first), end = mtAddDays(mtMonday(last), 6);
  const keys = []; for(let k = start; k <= end; k = mtAddDays(k,1)) keys.push(k);
  return {month:m[1]+'-'+m[2], first, last, start, end, keys, weeks:keys.length/7};
}
function mtCalTitle(view, keys, day){
  const sm = n => MT_MONTHS[n-1].slice(0,3);
  if(view !== 'week'){ const p = mtKeyParts(day); return p ? MT_MONTHS[p[1]-1]+' '+p[0] : '' }
  const a = mtKeyParts(keys[0]), b = mtKeyParts(keys[keys.length-1]);
  if(!a || !b) return '';
  if(a[0] !== b[0]) return a[2]+' '+sm(a[1])+' '+a[0]+' – '+b[2]+' '+sm(b[1])+' '+b[0];
  if(a[1] !== b[1]) return a[2]+' '+sm(a[1])+' – '+b[2]+' '+sm(b[1])+' '+b[0];
  return a[2]+' – '+b[2]+' '+sm(b[1])+' '+b[0];
}
/* ---- the week, by BUSINESS DAY ----
   Calls happen in the US working day (open_time→close_time in us_zone). Seen
   from the owner's zone that window crosses midnight: 7 am–9 pm Eastern is
   about 5:30 pm to 7:30 am the next morning in Colombo. A week drawn by the
   owner's calendar days would therefore cut every working day in two, half at
   the bottom of one column and half at the top of the next, and would need all
   24 hours to show them.

   So each column of the week is one US business day, running top to bottom
   from open to close. That is the only layout in which a column is one
   unbroken stretch of time, nothing is split, and the whole week fits in one
   window with no scrolling. The header gives the US date and the owner's dates
   the column spans; the two time columns on the left give every hour in both
   zones. A call's column is its US date (us_zone), never the owner's date. */

/* The business day that is "today": the US date, moving on to the next one
   once that day's call hours have closed. */
function mtBizToday(st, now){
  const k = mtDayKey(now, st.us_zone);
  const close = mtZoneToUtc(k, st.close_time, st.us_zone);
  return close && now.getTime() >= close.getTime() ? mtAddDays(k, 1) : k;
}
/* The hours the week shows: the call hours from the rules, widened to whole
   hours and to whatever `spans` ([fromMin,toMin] in US wall-clock minutes of
   their day) fall outside them. Never all 24 hours unless something forces it.
   Every label is worked out through Intl for `refKey` (a US date), so the
   owner's side moves by an hour when US daylight saving does. */
function mtHourWindow(st, refKey, spans){
  let lo = mtHmMin(st.open_time), hi = mtHmMin(st.close_time);
  (spans||[]).forEach(x=>{
    const a = Number(x && x[0]), b = Number(x && x[1]);
    if(Number.isFinite(a)) lo = Math.min(lo, a);
    if(Number.isFinite(b)) hi = Math.max(hi, b);
  });
  lo = Math.max(0, Math.floor(lo/60)*60); hi = Math.min(1440, Math.ceil(hi/60)*60);
  if(hi <= lo) hi = Math.min(1440, lo+60);
  const label = (min) => {
    const d = mtZoneToUtc(refKey, mtMinHm(min), st.us_zone);
    return d ? {min, us:mtShortTime(d, st.us_zone), owner:mtShortTime(d, st.owner_zone)} : {min, us:'', owner:''};
  };
  const hours = []; for(let m = lo; m < hi; m += 60) hours.push(label(m));
  const end = label(hi);
  return {startMin:lo, endMin:hi, rows:hours.length, hours,
          fromUs:hours[0].us, fromOwner:hours[0].owner, toUs:end.us, toOwner:end.owner,
          usShort:mtZoneShort(st.us_zone), ownerShort:mtZoneShort(st.owner_zone)};
}
/* The week of business days around `dayKey` (a US date). */
async function mtCalWeek(st, dayKey, now){
  const uz = st.us_zone, oz = st.owner_zone;
  const today = mtBizToday(st, now);
  const want = mtKeyOk(dayKey) ? dayKey : today;
  const all = mtWeekKeys(want);
  const from = mtZoneToUtc(all[0], '00:00', uz), to = mtZoneToUtc(mtAddDays(all[6],1), '00:00', uz);
  if(!from || !to) return mtErr('Your time zone is not set properly, so the calendar cannot be drawn.');
  const ev = await mtEvents(from.toISOString(), to.toISOString());
  if(!ev.ok) return ev;
  const sl = await mtRangeSlots(from.getTime(), to.getTime(), 'us');
  if(!sl.ok) return sl;

  const byAll = {}; all.forEach(k=>{ byAll[k] = [] });
  ev.data.events.forEach(e=>{ if(byAll[e.usKey]) byAll[e.usKey].push(e) });
  /* the calling days from the rules, plus any other day that has a call on it */
  let keys = all.filter(k => st.days.indexOf(mtWeekday(k)) >= 0 || byAll[k].length);
  if(!keys.length) keys = all.slice(0,5);
  const byDay = {}; keys.forEach(k=>{ byDay[k] = byAll[k] });

  /* what the hours have to stretch to: every call, and every block shorter than
     a day (a block of days off is clipped to the hours shown, not allowed to
     turn the week into 24-hour columns) */
  const spans = [];
  keys.forEach(k => byDay[k].forEach(e => spans.push([e.bizMin, Math.min(1440, e.bizMin + e.minutes)])));
  const dayStart = all.map(k => mtZoneToUtc(k, '00:00', uz).getTime()).concat([to.getTime()]);
  const blocksByDay = {}; all.forEach(k=>{ blocksByDay[k] = [] });
  (ev.data.blocks||[]).forEach(b=>{
    const a = mtParseDate(b.starts_at), e = mtParseDate(b.ends_at);
    if(!a || !e || e <= a) return;
    const short = e.getTime() - a.getTime() < 864e5;
    all.forEach((k,i)=>{
      const s0 = Math.max(a.getTime(), dayStart[i]), e0 = Math.min(e.getTime(), dayStart[i+1]);
      if(e0 <= s0) return;
      blocksByDay[k].push({block:b, s0, e0, from:mtTime(new Date(s0),oz), to:mtTime(new Date(e0),oz)});
      if(short && keys.indexOf(k) >= 0) spans.push([Math.floor((s0-dayStart[i])/60000), Math.ceil((e0-dayStart[i])/60000)]);
    });
  });
  const win = mtHourWindow(st, keys[0], spans);
  const dayNum = (d) => { const p = mtPartsOf(mtFmt(oz,'day'), d); return p.weekday+' '+p.day };
  const cols = keys.map(k=>{
    const start = mtZoneToUtc(k, mtMinHm(win.startMin), uz).getTime();
    const end = start + (win.endMin - win.startMin)*60000;
    const a = dayNum(new Date(start)), z = dayNum(new Date(end));
    return {key:k, start, end, usLabel:mtKeyDay(k), ownerFrom:a, ownerTo:z, ownerSpan: a===z ? a : a+' → '+z,
            ownerLabel: win.ownerShort+' '+(a===z ? a : a+' → '+z)};
  });
  let day = want;
  if(keys.indexOf(day) < 0){ const before = keys.filter(k => k <= want); day = before.length ? before[before.length-1] : keys[0] }
  return mtOk({
    st, view:'week', day, today, keys, allKeys:all, month:day.slice(0,7),
    title: mtCalTitle('week', all, day), from:from.toISOString(), to:to.toISOString(),
    events: ev.data.events, byDay, blocks: ev.data.blocks||[], blocksByDay, slots: sl.data,
    need: ev.data.events.filter(e=>e.needsOutcome).length,
    win, cols, nowMs: now.getTime(), empty: !ev.data.events.length
  });
}

/* The calendar for a month or a week around `dayKey`. The month is laid out by
   the owner's days (a call at 20:00 UTC on a Friday sits on Saturday in
   Colombo, because that is when the owner takes it) and `dayKey` is a date in
   the owner's zone. The week is laid out by US business days (above) and
   `dayKey` is a US date. */
async function mtCal(view, dayKey){
  const got = await mtSettings(); if(!got.ok) return got;
  const st = got.data, z = st.owner_zone, now = mtNow();
  if(view === 'week') return mtCalWeek(st, dayKey, now);
  const today = mtDayKey(now, z);
  const day = mtKeyOk(dayKey) ? dayKey : today;
  const v = 'month';
  const grid = mtMonthGrid(day.slice(0,7));
  const keys = grid.keys;
  const from = mtZoneToUtc(keys[0], '00:00', z);
  const to   = mtZoneToUtc(mtAddDays(keys[keys.length-1],1), '00:00', z);
  if(!from || !to) return mtErr('Your time zone is not set properly, so the calendar cannot be drawn.');

  const ev = await mtEvents(from.toISOString(), to.toISOString());
  if(!ev.ok) return ev;
  const slots = {};
  const byDay = {}; keys.forEach(k=>{ byDay[k] = [] });
  ev.data.events.forEach(e=>{ if(byDay[e.dayKey]) byDay[e.dayKey].push(e) });

  /* a block can run over midnight, so it is cut into the days it touches */
  const blocksByDay = {}; keys.forEach(k=>{ blocksByDay[k] = [] });
  const starts = keys.map(k=>mtZoneToUtc(k,'00:00',z).getTime()).concat([to.getTime()]);
  (ev.data.blocks||[]).forEach(b=>{
    const a = mtParseDate(b.starts_at), e = mtParseDate(b.ends_at);
    if(!a || !e || e <= a) return;
    keys.forEach((k,i)=>{
      const s0 = Math.max(a.getTime(), starts[i]), e0 = Math.min(e.getTime(), starts[i+1]);
      if(e0 <= s0) return;
      blocksByDay[k].push({block:b, fromMin:Math.round((s0-starts[i])/60000), toMin:Math.round((e0-starts[i])/60000),
        from:mtTime(new Date(s0),z), to:mtTime(new Date(e0),z)});
    });
  });
  const np = mtParts(now, z);
  return mtOk({
    st, view:v, day, today, keys, month: grid ? grid.month : day.slice(0,7),
    title: mtCalTitle(v, keys, day), from:from.toISOString(), to:to.toISOString(),
    events: ev.data.events, byDay, blocks: ev.data.blocks||[], blocksByDay, slots,
    need: ev.data.events.filter(e=>e.needsOutcome).length,
    nowMin: np.h*60+np.mi, empty: !ev.data.events.length
  });
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
function mtWho(m, client){
  const o = m || {}, c = client || null;
  if(c && (c.company || c.contact_name)) return String(c.company || c.contact_name);
  if(mtText(o.guest_name)) return mtText(o.guest_name);
  if(o.client_id) return 'Client ' + String(o.client_id).slice(0,8);
  if(o.booking_id) return 'Booking ' + String(o.booking_id).slice(0,8);
  return 'No client on this one';
}
function mtPill(s){ const S = mtStatusOf(s); return '<span class="pill '+esc(S.pill)+'">'+esc(S.word)+'</span>' }
function mtTwoTimes(w, st){
  if(!w) return '<span class="mt-when">No time</span>';
  const s = st || mtSettingsNow();
  return '<span class="mt-when"><b>'+esc(w.usTime)+'</b> <small>'+esc(mtZoneName(s.us_zone))+'</small>'
       + '<i>'+esc(w.ownerTime)+' '+esc(mtZoneName(s.owner_zone))+'</i></span>';
}

/* A free time, in the owner's time first and the prospect's side under it. */
function mtRenderSlot(s){
  return '<button type="button" class="mt-slot" title="'+esc(s.lk+' '+mtZoneShort(s.ownerZone)+' · '+s.us+' '+mtZoneShort(s.usZone))+'" onclick="mtAddAt('+mtJsArg(s.startsAt)+')">'
       + '<b>'+esc(s.lk)+'</b><small>'+esc(s.us)+' '+esc(mtZoneName(s.usZone))+'</small></button>';
}
/* A string into an onclick handler, quoted and escaped — never raw. */
function mtJsArg(v){ return "'"+String(v==null?'':v).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\u0022').replace(/</g,'\\u003c').replace(/&/g,'\\u0026')+"'" }
/* One instant in one zone, in words: "Fri 27 Nov · 9:30 pm Sri Lanka". */
function mtWhenIn(d, zone){ return mtDayName(d,zone)+' · '+mtTime(d,zone)+' '+mtZoneName(zone) }
function mtCount(n, one, many){ return n+' '+(n===1?one:many) }

/* What a call is, in one line — the tooltip, and what a screen reader hears. */
function mtEventLine(ev){
  return ev.ownerDow+' '+ev.time+' '+ev.ownerShort+' · '+ev.usDow+' '+ev.usTime+' '+ev.usShort+' · '+ev.title+(ev.kindWord?' · '+ev.kindWord:'')+' · '+ev.planWord+' · '+ev.statusWord
       + (ev.needsOutcome?' · needs an outcome':'');
}
function mtEventClass(ev){
  return ev.planClass+(ev.needsOutcome?' need':'')+(ev.source==='meeting'?' is-meeting':' is-booking')
       + (['no_show','lost'].indexOf(ev.status)>=0?' off':'');
}
function mtPlanTagHTML(ev){ return '<span class="mt-tagp" title="'+esc(ev.planWord)+'">'+esc(ev.tag)+'</span>' }
/* A call in a month cell: "9:30 pm Acme", its kind when it was booked here, and
   the plan's initial. */
function mtRenderChip(ev){
  return '<button type="button" class="mt-chip '+mtEventClass(ev)+'" title="'+esc(mtEventLine(ev))+'" aria-label="'+esc(mtEventLine(ev))+'"'
       + ' onclick="event.stopPropagation();mtOpenEvent('+mtJsArg(ev.key)+')">'
       + '<span class="mt-chip-t">'+esc(ev.time)+'</span><span class="mt-chip-n">'+esc(ev.title)+'</span>'
       + (ev.kindWord?'<span class="mt-chip-k">'+esc(ev.kindWord)+'</span>':'')
       + mtPlanTagHTML(ev)+'</button>';
}
/* A call as a full row: the phone's list of a day. The owner's time first, US
   Eastern under it. `withDay` puts the owner's weekday on it — a business day
   runs over two of the owner's days, so the list has to say which. */
function mtRenderEventRow(ev, withDay){
  const sub = [ev.who && ev.who!==ev.title ? ev.who : '', ev.kindWord || (ev.source==='booking' ? 'Discovery call' : 'Meeting'), ev.minutes+' min'].filter(Boolean).join(' · ');
  return '<li><button type="button" class="mt-row mt-evrow '+mtEventClass(ev)+'" title="'+esc(mtEventLine(ev))+'" aria-label="'+esc(mtEventLine(ev))+'" onclick="mtOpenEvent('+mtJsArg(ev.key)+')">'
       + '<span class="mt-when"><b>'+(withDay===true?esc(ev.ownerDow)+' ':'')+esc(ev.time)+'</b><small>'+esc(ev.usTime+' '+ev.usShort)+'</small></span>'
       + '<span class="mt-row-main"><b>'+esc(ev.title)+'</b><small>'+esc(sub)+'</small>'
       + (ev.needsOutcome?'<small class="mt-needword">Needs an outcome</small>':'')+'</span>'
       + mtPlanTagHTML(ev)+'<span class="pill '+esc(ev.pill)+'">'+esc(ev.statusWord)+'</span></button></li>';
}
function mtRenderBlockRow(b){
  return '<li class="mt-blockrow"><span class="mt-when"><b>'+esc(b.from)+'</b><small>to '+esc(b.to)+'</small></span>'
       + '<span class="mt-row-main"><b>Blocked out</b><small>'+esc(b.block.reason||'No reason given')+'</small></span>'
       + '<button type="button" class="mt-textbtn" onclick="mtUnblockClick('+mtJsArg(b.block.id)+')">Unblock</button></li>';
}
/* The calls to draw: all of them, or only the ones waiting for an outcome. */
function mtShown(cal){
  const only = !!cal.needOnly && cal.need > 0, out = {};
  cal.keys.forEach(k=>{ out[k] = (cal.byDay[k]||[]).filter(e=>!only || e.needsOutcome) });
  return out;
}
/* One day as a list — under the month grid on a phone (one of the owner's
   days), and the phone's week (one business day: `opts.biz`). */
function mtRenderDayList(cal, key, shown, opts){
  const o = opts || {};
  const list = (shown[key]||[]), blocks = (cal.blocksByDay[key]||[]), slots = o.slots ? (cal.slots[key]||[]) : [];
  const col = o.biz ? (cal.cols||[]).find(c=>c.key===key) : null;
  return '<section class="mt-daylist"><h4>'+esc(mtKeyDay(key))+(key===cal.today?' <span class="mt-tag">Today</span>':'')
       + (col?' <span class="mt-tag">'+esc(mtZoneName(cal.st.owner_zone)+': '+col.ownerSpan)+'</span>':'')+'</h4>'
       + (list.length || blocks.length
           ? '<ul class="mt-list">'+blocks.map(mtRenderBlockRow).join('')+list.map(e=>mtRenderEventRow(e, !!o.biz)).join('')+'</ul>'
           : '<p class="mt-none">No calls on this day.</p>')
       + (o.slots ? (slots.length
           ? '<h5>Free times — tap one to add a meeting</h5><div class="mt-slots">'+slots.map(mtRenderSlot).join('')+'</div>'
           : '<p class="mt-none">No free times on this day.</p>') : '')
       + (o.openDay ? '<div class="mt-acts"><button type="button" class="btn ghost" onclick="mtGoWeek('+mtJsArg(key)+')">Open this day</button></div>' : '')
       + '</section>';
}

/* The month: seven columns, Monday first, whole weeks. Each day holds its calls
   as chips (dots on a phone, with the picked day listed underneath). */
function mtRenderMonth(cal, shown){
  const cells = cal.keys.map(key=>{
    const p = mtKeyParts(key), list = shown[key]||[], blocks = cal.blocksByDay[key]||[];
    const more = list.length - MT_CHIP_MAX, need = list.some(e=>e.needsOutcome);
    const label = mtKeyDay(key)+', '+(list.length?mtCount(list.length,'call','calls'):'no calls')+(need?', needs an outcome':'');
    return '<div class="mt-cell'+(key.slice(0,7)!==cal.month?' out':'')+(key===cal.today?' today':'')+(key===cal.day?' sel':'')+'" onclick="mtCellTap('+mtJsArg(key)+')">'
         + '<button type="button" class="mt-daynum" aria-label="'+esc(label)+'"'+(key===cal.today?' aria-current="date"':'')
         + ' onclick="event.stopPropagation();mtDayClick('+mtJsArg(key)+')">'+p[2]+'</button>'
         + '<div class="mt-chips">'
         + (blocks.length?'<span class="mt-chip mt-chip-blk mt-hatch" title="'+esc(blocks.map(b=>b.from+' to '+b.to+(b.block.reason?' · '+b.block.reason:'')).join('; '))+'">Blocked</span>':'')
         + list.slice(0, MT_CHIP_MAX).map(mtRenderChip).join('')
         + '</div>'
         /* outside the chips, so a short row clips a chip and never this line */
         + (more>0?'<button type="button" class="mt-more" onclick="event.stopPropagation();mtGoWeek('+mtJsArg(key)+')">+'+more+' more</button>':'')
         + '<span class="mt-dots'+(need?' need':'')+'" aria-hidden="true">'
         + list.slice(0, MT_CHIP_MAX).map(e=>'<i class="mt-dot '+e.planClass+'"></i>').join('')
         + (list.length?'<b>'+list.length+'</b>':'')+'</span></div>';
  }).join('');
  const weeks = Math.max(1, Math.ceil(cal.keys.length / 7));
  return '<div class="mt-month" id="mtMo" style="--mt-weeks:'+weeks+'"><div class="mt-dow">'+MT_GRID_DAYS.map(d=>'<span>'+d+'</span>').join('')+'</div>'
       + '<div class="mt-cells">'+cells+'</div></div>'
       + '<div class="mt-under">'+mtRenderDayList(cal, cal.day, shown, {openDay:true})+'</div>';
}
/* Calls that overlap sit side by side: which lane each takes, and how many lanes
   its cluster needs. `list` is soonest first. */
function mtLanes(list, field){
  const f = field || 'minuteOfDay';
  const out = []; let group = [], ends = [], groupEnd = -1;
  const flush = () => { group.forEach(g=>{ g.lanes = ends.length }); out.push.apply(out, group); group = []; ends = []; groupEnd = -1 };
  (list||[]).forEach(ev=>{
    const a = ev[f], b = Math.min(1440, a + Math.max(ev.minutes, MT_MIN_BLOCK));
    if(group.length && a >= groupEnd) flush();
    let lane = ends.findIndex(e=>e<=a);
    if(lane < 0){ lane = ends.length; ends.push(b) } else ends[lane] = b;
    group.push({ev, lane, lanes:1, top:a, len:Math.max(b-a, 1)});
    groupEnd = Math.max(groupEnd, b);
  });
  flush();
  return out;
}
function mtPct(n){ return Math.round(n*1000)/1000 }
/* The week: one column per US business day (see section 9 for why), against
   two time columns — the owner's zone and US Eastern. Only the hours calls can
   happen are drawn, and everything is placed by percentage, so the grid takes
   whatever height the window has (meetings.css) and nothing scrolls. A call is
   a block at its time, as tall as it is long; a short one still gets one line
   for its name, and shows its times when hovered. */
function mtRenderWeekGrid(cal, shown){
  const win = cal.win, cols = cal.cols || [], n = cols.length;
  const oName = mtZoneName(cal.st.owner_zone), uName = mtZoneName(cal.st.us_zone);
  const box = (s, e, col) => {
    const a = Math.max(s, col.start), b = Math.min(e, col.end), span = col.end - col.start;
    return b > a ? 'top:'+mtPct((a-col.start)/span*100)+'%;height:'+mtPct((b-a)/span*100)+'%' : '';
  };
  const head = '<div class="mt-wk-head"><span class="mt-wk-zh" title="'+esc(oName+' time')+'">'+esc(win.ownerShort)+'</span>'
    + '<span class="mt-wk-zh" title="'+esc(uName+' time')+'">'+esc(win.usShort)+'</span>'
    + cols.map(col=>{
        const c = (shown[col.key]||[]).length;
        return '<button type="button" class="mt-wk-dayh'+(col.key===cal.today?' today':'')+'"'
             + ' title="'+esc(col.usLabel+' in '+uName+' — '+col.ownerSpan+' in '+oName)+'"'
             + ' aria-label="'+esc(col.usLabel+' '+uName+', '+oName+' '+col.ownerSpan+', '+mtCount(c,'call','calls'))+'"'
             + (col.key===cal.today?' aria-current="date"':'')
             + ' onclick="mtPickDay('+mtJsArg(col.key)+')"><b>'+esc(col.usLabel)+'</b><small>'+esc(col.ownerLabel)+'</small></button>';
      }).join('')+'</div>';
  const axis = (cls, f, name) => '<div class="mt-wk-axis '+cls+'" aria-label="'+esc(name+' time')+'">'
    + win.hours.map(h=>'<span>'+esc(h[f])+'</span>').join('')+'</div>';
  const body = cols.map(col=>{
    const key = col.key;
    const blocks = (cal.blocksByDay[key]||[]).map(b=>{
      const at = box(b.s0, b.e0, col);
      return at ? '<div class="mt-blk mt-hatch" style="'+at+'" title="'+esc('Blocked '+b.from+' to '+b.to+(b.block.reason?' · '+b.block.reason:''))+'">'
        + '<span>Blocked'+(b.block.reason?' · '+esc(b.block.reason):'')+'</span>'
        + '<button type="button" class="mt-blk-x" onclick="event.stopPropagation();mtUnblockClick('+mtJsArg(b.block.id)+')">Unblock</button></div>' : '';
    }).join('');
    const free = (cal.slots[key]||[]).map(sl=>{
      const t = Date.parse(sl.startsAt), at = box(t, t + sl.minutes*60000, col);
      return at ? '<button type="button" class="mt-free" style="'+at+'" onclick="event.stopPropagation();mtAddAt('+mtJsArg(sl.startsAt)+')"'
           + ' title="'+esc('Free — '+sl.lk+' '+win.ownerShort+' · '+sl.us+' '+win.usShort+'. Click to add a meeting.')+'"'
           + ' aria-label="'+esc('Add a meeting at '+sl.lk+' '+win.ownerShort+', '+sl.us+' '+win.usShort+', '+col.usLabel)+'"></button>' : '';
    }).join('');
    const evs = mtLanes(shown[key]||[], 'bizMin').map(l=>{
      const ev = l.ev, w = 100/l.lanes, at = box(ev.startMs, ev.startMs + l.len*60000, col);
      return at ? '<button type="button" class="mt-ev '+mtEventClass(ev)+(ev.minutes<60?' short':'')+'" style="'+at.replace(';height:', ';--mt-h:')+';left:'+mtPct(l.lane*w)+'%;width:'+mtPct(w)+'%"'
           + ' title="'+esc(mtEventLine(ev))+'" aria-label="'+esc(mtEventLine(ev))+'" onclick="event.stopPropagation();mtOpenEvent('+mtJsArg(ev.key)+')">'
           + '<b>'+esc(ev.title)+'</b>'+mtPlanTagHTML(ev)
           + '<small>'+esc(ev.time)+'<i> · '+esc(ev.usTime+' '+ev.usShort)+'</i>'
           + (ev.kindWord?' · '+esc(ev.kindWord):'')+(ev.open?'':' · '+esc(ev.statusWord))+'</small></button>' : '';
    }).join('');
    const now = cal.nowMs >= col.start && cal.nowMs < col.end
      ? '<div class="mt-now" style="top:'+mtPct((cal.nowMs-col.start)/(col.end-col.start)*100)+'%" title="Now"></div>' : '';
    return '<div class="mt-wk-col'+(key===cal.today?' today':'')+'" onclick="mtColClick(event,'+mtJsArg(key)+')">'+blocks+free+evs+now+'</div>';
  }).join('');
  /* the phone: one business day at a time, with the week as a strip of days to tap */
  const strip = cols.map(col=>{
    const key = col.key, list = shown[key]||[], d = mtKeyDay(key).split(' ');
    return '<button type="button" class="mt-strip-d'+(key===cal.day?' sel':'')+(key===cal.today?' today':'')+'"'
         + ' aria-label="'+esc(col.usLabel+', '+mtCount(list.length,'call','calls'))+'"'+(key===cal.day?' aria-pressed="true"':'')
         + ' onclick="mtPickDay('+mtJsArg(key)+')"><small>'+esc(d[0])+'</small><b>'+esc(d[1])+'</b>'
         + '<span class="mt-dots'+(list.some(e=>e.needsOutcome)?' need':'')+'">'+list.slice(0,MT_CHIP_MAX).map(e=>'<i class="mt-dot '+e.planClass+'"></i>').join('')+'</span></button>';
  }).join('');
  return '<div class="mt-wk" id="mtWk" style="--mt-rows:'+win.rows+';--mt-n:'+n+'">'+head
       + '<div class="mt-wk-body">'+axis('mt-ax-own','owner',oName)+axis('mt-ax-us','us',uName)+body+'</div></div>'
       + '<div class="mt-agenda" ontouchstart="mtSwipeStart(event)" ontouchend="mtSwipeEnd(event)">'
       + '<div class="mt-strip" style="--mt-n:'+n+'">'+strip+'</div>'
       + '<div class="mt-agenda-nav"><button type="button" class="btn ghost mt-ic" onclick="mtDayMove(-1)" aria-label="The day before">‹</button>'
       + '<button type="button" class="btn ghost mt-ic" onclick="mtDayMove(1)" aria-label="The day after">›</button></div>'
       + mtRenderDayList(cal, cal.day, shown, {slots:true, biz:true})+'</div>';
}
/* What the colours mean. Not drawn until the three-dots button asks for it. */
function mtRenderLegend(){
  const sw = (cls, tag, word) => '<li><span class="mt-sw '+cls+'">'+esc(tag)+'</span>'+esc(word)+'</li>';
  return '<div class="mt-key" id="mtKey" role="group" aria-label="What the colours mean"><ul class="mt-legend">'
       + Object.keys(MT_PLANS).map(k=>sw('mt-plan-'+k, MT_PLANS[k].tag, MT_PLANS[k].word)).join('')
       + sw('mt-plan-none', MT_NO_PLAN.tag, MT_NO_PLAN.word)
       + '<li><span class="mt-sw mt-sw-need"></span>Red outline — needs an outcome</li>'
       + '<li><span class="mt-sw mt-hatch"></span>Hatched band — blocked time</li></ul>'
       + '<p class="mt-none">A call takes its colour from its plan.</p></div>';
}
/* The whole calendar: toolbar (the colour key behind its three dots), what
   needs an outcome, then the grid. Draws with zero rows. */
function mtRenderCal(cal){
  if(!cal || !Array.isArray(cal.keys) || !cal.keys.length) return '<div class="card mt-card"><p class="mt-none">Nothing to show yet.</p></div>';
  const st = cal.st || mtSettingsNow(), week = cal.view === 'week', unit = week ? 'week' : 'month';
  const shown = mtShown(cal), only = !!cal.needOnly && cal.need > 0, key = !!cal.legend;
  const seg = (v, word) => '<button type="button" class="'+(cal.view===v?'active':'')+'" aria-pressed="'+(cal.view===v)+'" onclick="mtSetView(\''+v+'\')">'+word+'</button>';
  const dots = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  const bar = '<div class="mt-bar">'
    + '<div class="mt-keywrap"><button type="button" class="btn ghost mt-ic mt-dotsbtn" aria-label="What the colours mean" title="What the colours mean"'
    + ' aria-expanded="'+key+'" aria-controls="mtKey" onclick="mtToggleLegend()">'+dots+'</button>'+(key?mtRenderLegend():'')+'</div>'
    + '<div class="mt-nav"><button type="button" class="btn ghost mt-ic" onclick="mtCalMove(-1)" aria-label="The '+unit+' before">‹</button>'
    + '<button type="button" class="btn ghost" onclick="mtCalToday()">Today</button>'
    + '<button type="button" class="btn ghost mt-ic" onclick="mtCalMove(1)" aria-label="The '+unit+' after">›</button></div>'
    + '<h3 class="mt-title" aria-live="polite">'+esc(cal.title)+'</h3>'
    + '<div class="seg mt-seg" role="group" aria-label="Week or month">'+seg('week','Week')+seg('month','Month')+'</div>'
    + '<div class="mt-tools"><button type="button" class="btn ghost" onclick="mtOpenFunnel()">Funnel</button>'
    + '<button type="button" class="btn ghost" onclick="mtOpenBlock()">Block time</button>'
    + '<button type="button" class="btn" onclick="mtOpenAdd()">Add meeting</button></div></div>';
  const need = cal.need > 0
    ? '<button type="button" class="mt-needline'+(only?' on':'')+'" aria-pressed="'+only+'" onclick="mtToggleNeed()"><span class="mt-needdot"></span>'
      + (only ? 'Showing only the '+cal.need+' that '+(cal.need===1?'needs':'need')+' an outcome — show every call'
              : cal.need+' '+(cal.need===1?'needs':'need')+' an outcome')+'</button>'
    : '';
  /* the week says its hours on its two time columns, so the line of words is
     kept for the month — every line above the week grid is height it loses */
  const hours = week
    ? (st.fallback?'<p class="mt-hours">The saved rules could not be read, so these are the usual call hours.</p>':'')
    : '<p class="mt-hours">Every time is '+esc(mtZoneName(st.owner_zone))+' time. '+esc(mtHoursLine(st))
      + (st.fallback?' (the saved rules could not be read, so these are the usual ones)':'')+'</p>';
  return '<div class="mt-cal mt-view-'+unit+'">'+bar+need+hours
       + (cal.empty?'<p class="mt-none">Nothing booked this '+unit+' yet.'+(week?' Click any time to add a meeting.':'')+'</p>':'')
       + (week ? mtRenderWeekGrid(cal, shown) : mtRenderMonth(cal, shown))+'</div>';
}
/* The two or three lines under a call's name: the owner's time in bold, the
   other person's own time, and US Eastern whenever that is not already one of
   the two — so both clocks are always there. */
function mtBigWhen(d, st, theirs, extra){
  if(!d) return '<p class="mt-big"><b>No time on this one</b></p>';
  return '<p class="mt-big"><b>'+esc(mtWhenIn(d, st.owner_zone))+'</b><span>'+esc(mtWhenIn(d, theirs))+' — their time</span>'
       + (theirs !== st.us_zone && st.owner_zone !== st.us_zone ? '<span>'+esc(mtWhenIn(d, st.us_zone))+'</span>' : '')
       + (extra||'')+'</p>';
}
/* One meeting: its title and who it is with, when (the owner's time, then
   theirs, and US Eastern), the link, the reminders, and the buttons — done,
   no-show, cancel, move. */
function mtRenderMeeting(data){
  if(!data || !data.meeting) return '<div class="card mt-card"><p class="mt-none">That meeting is not on the calendar any more.</p></div>';
  const m = data.meeting, st = data.st || mtSettingsNow(), c = data.client || null;
  const d = mtParseDate(m.starts_at);
  const status = String(m.status||'booked');
  const theirs = mtZoneOk(m.time_zone) ? m.time_zone : st.us_zone;
  const link = /^https:\/\//i.test(String(m.meet_link||'')) ? String(m.meet_link) : '';
  const plan = mtPlanKey(m.plan) || mtPlanKey(c && c.plan);
  const title = mtText(m.title), guest = mtText(m.guest_name), mail = mtText(m.guest_email);
  const rem = [
    ['24 hours before', m.reminded_24h_at],
    ['1 hour before',   m.reminded_1h_at]
  ].map(([lbl,at])=>{
    const r = mtParseDate(at);
    return '<li>'+esc(lbl)+': '+(r?'sent '+esc(mtWhenIn(r, st.owner_zone)):'not sent yet')+'</li>';
  }).join('');
  const kv = [
    ['Who', esc(mtWho(m, c))+(c && c.contact_name && c.company ? ' · '+esc(c.contact_name) : '')+(c && guest ? ' · '+esc(guest) : '')],
    ['What', esc(String(m.kind)==='other' && title ? 'A meeting you added' : mtKindWord(m.kind))],
    ['Plan', '<span class="mt-planchip '+mtPlanClass(plan)+'">'+esc(mtPlanTag(plan))+' · '+esc(mtPlanWord(plan))+'</span>'],
    ['Status', mtPill(status)+(mtMeetingNeedsOutcome(m)?' <span class="pill red">Needs an outcome</span>':'')],
    ['How long', esc(mtMinutesOf(m,st)+' minutes')],
    ['Link', link?'<a href="'+esc(link)+'" target="_blank" rel="noopener noreferrer">Join the call</a> · <button type="button" class="mt-textbtn" onclick="mtCopy('+mtJsArg(link)+')">Copy the link</button>':'No link on this one yet']
  ];
  if(title) kv.unshift(['Title', esc(title)]);
  if(mail) kv.splice(title?2:1, 0, ['Email', MT_EMAIL_RE.test(mail) ? '<a href="mailto:'+esc(mail)+'">'+esc(mail)+'</a>' : esc(mail)]);
  if(m.notes) kv.push(['Notes','<span class="mt-note">'+esc(m.notes)+'</span>']);
  if(String(m.kind)==='qualified') kv.push(['The money side', data.call
    ? (data.call.happened ? 'Counted as delivered for the month.' : 'Not counted for the month.')
    : 'No booked sales call matched this time.']);
  const acts = [];
  let move = '';
  if(status==='booked' || status==='requested'){
    acts.push('<button type="button" class="btn" onclick="mtHeldClick('+mtJsArg(m.id)+')">Call done</button>');
    acts.push('<button type="button" class="btn ghost" onclick="mtNoShowClick('+mtJsArg(m.id)+')">No-show</button>');
    acts.push('<button type="button" class="btn ghost" onclick="mtCancelClick('+mtJsArg(m.id)+')">Cancel</button>');
    move = '<div class="mt-move"><div class="field"><label for="mtMoveTo">Move it to ('+esc(mtZoneName(st.owner_zone))+' time)</label>'
         + '<input id="mtMoveTo" type="datetime-local"></div>'
         + '<button type="button" class="btn ghost" onclick="mtMoveClick('+mtJsArg(m.id)+')">Move the call</button>'
         + '<div id="mtMoveErr" class="login-err"></div></div>';
  }
  return '<div class="card mt-card mt-one">'
    + '<h3>'+esc(title || mtKindWord(m.kind))+'</h3>'
    + mtBigWhen(d, st, theirs)
    + '<dl class="mt-kv">'+kv.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+v+'</dd>').join('')+'</dl>'
    + '<h4>Reminders</h4><ul class="mt-rem">'+rem+'</ul>'
    + (acts.length?'<div class="mt-acts">'+acts.join('')+'</div>':'')
    + move
    + '</div>';
}
/* The top of a website booking's panel: who, the plan, both clocks, the link. */
function mtRenderBookingHead(d, st){
  const b = (d && d.booking) || {}, s = st || mtSettingsNow();
  const at = mtParseDate(b.call_at);
  const theirs = mtZoneOk(b.timezone) ? b.timezone : s.us_zone;
  const plan = mtPlanKey(b.plan);
  const safe = typeof plSafeUrl==='function' ? plSafeUrl : (()=>'');
  const link = safe(b.meet_link), site = safe(b.website);
  const need = typeof plNeedsOutcome==='function' && plNeedsOutcome(b, mtNow());
  const score = d && d.score!=='' && d.score!=null ? d.score : '';
  const state = d && d.research ? d.research.state : '';
  const pills = (typeof plStatusPill==='function' ? plStatusPill(b.status) : '')
    + (need?'<span class="pill red">Needs an outcome</span>':'')
    + (score===''?'':'<span class="pill blue" title="What the research engine scored them">Score '+esc(String(score))+'</span>')
    + (state==='done' && mtBriefHas(d)?'<span class="pill green">Brief ready</span>':'<span class="pill grey">Research not ready yet</span>');
  const kv = [
    ['Who', esc(b.name||'No name given')+(b.role?' · '+esc(b.role):'')],
    ['Company', (site?'<a href="'+esc(site)+'" target="_blank" rel="noopener noreferrer">'+esc(b.company||b.website)+'</a>':esc(b.company||'Not given'))],
    ['Plan', '<span class="mt-planchip '+mtPlanClass(plan)+'">'+esc(mtPlanTag(plan))+' · '+esc(plan?mtPlanWord(plan):'No plan chosen yet')+'</span>'],
    ['How long', esc(mtMinutesOf(b,s)+' minutes')]
  ];
  return '<div class="mt-ph"><div class="mt-ph-pills">'+pills+'</div>'
    + mtBigWhen(at, s, theirs, at && typeof plRel==='function' ? '<span>'+esc(plRel(at, mtNow()))+'</span>' : '')
    + '<dl class="mt-kv">'+kv.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+v+'</dd>').join('')+'</dl>'
    + (link
        ? '<div class="mt-acts"><a class="btn" href="'+esc(link)+'" target="_blank" rel="noopener noreferrer">Join the call</a>'
          + '<button type="button" class="btn ghost" onclick="mtCopy('+mtJsArg(link)+')">Copy the link</button></div>'
        : '<p class="mt-none">No Google Meet link on this one yet.</p>')
    + '</div>';
}
/* The panel a call opens in: the shell's modal, which is a sheet on a phone. */
function mtPanelHTML(title, sub, body){
  return '<div class="modal-head"><div><h3>'+esc(title)+'</h3>'+(sub?'<p>'+esc(sub)+'</p>':'')+'</div></div>'
       + '<div class="modal-body mt-panel">'+body+'</div>'
       + '<div class="modal-foot mt-acts"><button type="button" class="btn ghost" onclick="mtClosePanel()">Close</button></div>';
}
/* ---- the research brief, laid out to be read before the call ----
   research_briefs.brief is written by the research engine, so nothing in it is
   taken on trust: every part is looked for, drawn if it is there and skipped if
   it is not, and whatever else the brief holds is listed at the end through
   pipeline.js (plBriefSections) so nothing is hidden. Never throws. */
function mtBriefText(v){
  if(v == null) return '';
  if(typeof v === 'string') return v.trim();
  if(typeof v === 'number' || typeof v === 'boolean') return String(v);
  try{ return typeof plFlat === 'function' ? plFlat(v, 3) : JSON.stringify(v) }catch(e){ return '' }
}
function mtBriefList(v){
  const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
  return arr.map(x=>x).filter(x => x != null && x !== '');
}
function mtBriefTitle(k){ return typeof plTitle === 'function' ? plTitle(k) : String(k||'').replace(/_/g,' ') }
function mtBriefSec(title, inner){ return inner ? '<div class="pl-brief-sec mt-brief-sec"><h4>'+esc(title)+'</h4>'+inner+'</div>' : '' }
function mtBriefUl(items){ return items.length ? '<ul class="mt-brief-ul">'+items.map(x=>'<li>'+x+'</li>').join('')+'</ul>' : '' }
/* Is there a brief with anything in it? */
function mtBriefHas(d){
  const row = d && d.brief && typeof d.brief === 'object' ? d.brief : null, raw = row ? row.brief : null;
  return raw != null && raw !== '' && !(typeof raw === 'object' && !Object.keys(raw).length);
}
/* `d` is what plBooking returns: d.brief is the research_briefs row or null. */
function mtRenderBrief(d){
  const row = d && d.brief && typeof d.brief === 'object' ? d.brief : null;
  const raw = row ? row.brief : null;
  const id = d && d.booking ? d.booking.id : '';
  if(!mtBriefHas(d)){
    const st = (d && d.research && d.research.state) || 'none';
    const why = st === 'running' ? 'The research engine is working on this one. The brief shows up here when it is written.'
      : st === 'failed' ? 'The research engine started on this one and did not finish.'
      : st === 'done' || st === 'empty' ? 'The research engine wrote a brief with nothing in it.'
      : 'The research engine has not written a brief for this booking. Their own answers are below.';
    return '<div class="card pl-pad pl-nobrief mt-nobrief"><b>Research not ready yet</b><p class="muted">'+esc(why)+'</p>'
      + (typeof plResearchNow === 'function' ? '<div class="pl-acts"><button type="button" class="btn ghost" onclick="plResearchNow('+mtJsArg(id)+')">Research this one</button></div>' : '')
      + '</div>';
  }
  if(typeof raw !== 'object' || Array.isArray(raw))
    return '<div class="card pl-pad pl-brief mt-brief">'+(typeof raw === 'string'
      ? '<p class="pl-pre">'+esc(raw)+'</p>'
      : mtBriefUl(mtBriefList(raw).map(x=>esc(mtBriefText(x)))))+'</div>';

  const used = {};
  const take = (...names) => { for(const n of names){ if(raw[n] != null && raw[n] !== ''){ used[n] = 1; return raw[n] } } return null };
  const kvs = (obj, skip) => {
    if(!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
    const rows = Object.keys(obj).filter(k => (skip||[]).indexOf(k) < 0 && obj[k] != null && obj[k] !== '').map(k=>{
      const v = obj[k];
      const body = Array.isArray(v) ? mtBriefUl(mtBriefList(v).map(x=>esc(mtBriefText(x)))) : esc(mtBriefText(v));
      return body ? '<small>'+esc(mtBriefTitle(k))+'</small><span>'+body+'</span>' : '';
    }).join('');
    return rows ? '<div class="pl-kv">'+rows+'</div>' : '';
  };

  const one = mtBriefText(take('one_liner','oneLiner','summary'));
  /* the score: the booking's own, and what the brief says about fit */
  const bant = take('bant','score','fit');
  const sc = d && d.score !== '' && d.score != null ? String(d.score) : '';
  const bantScore = bant && typeof bant === 'object' && !Array.isArray(bant) && bant.score != null && bant.score !== '' ? String(bant.score) : (bant != null && typeof bant !== 'object' ? String(bant) : '');
  const verdict = bant && typeof bant === 'object' && !Array.isArray(bant) ? mtBriefText(bant.verdict) : '';
  const scoreLine = [sc !== '' ? 'Booking score '+sc : '', bantScore !== '' ? 'Research score '+bantScore : ''].filter(Boolean).join(' · ');
  const score = (scoreLine ? '<p class="mt-brief-score"><b>'+esc(scoreLine)+'</b>'+(verdict?' — '+esc(verdict):'')+'</p>' : (verdict?'<p class="mt-brief-score">'+esc(verdict)+'</p>':''))
    + kvs(bant, ['score','verdict']);

  const pains = mtBriefUl(mtBriefList(take('pain_hypotheses','pains','pain_points')).map(x=>{
    if(x && typeof x === 'object' && !Array.isArray(x)){
      const p = mtBriefText(x.pain || x.title || x.name || x.hypothesis), ev = mtBriefText(x.evidence || x.why || x.detail);
      return p || ev ? '<b>'+esc(p || ev)+'</b>'+(p && ev ? '<span class="muted"> — '+esc(ev)+'</span>' : '') : esc(mtBriefText(x));
    }
    return esc(mtBriefText(x));
  }).filter(Boolean));

  const planRaw = take('closer_plan','call_plan','plan');
  const plan = planRaw && typeof planRaw === 'object' && !Array.isArray(planRaw) ? kvs(planRaw)
    : Array.isArray(planRaw) ? mtBriefUl(mtBriefList(planRaw).map(x=>esc(mtBriefText(x))))
    : planRaw != null ? '<p class="pl-pre">'+esc(mtBriefText(planRaw))+'</p>' : '';

  const flagsRaw = take('red_flags','redFlags','flags');
  used.red_flags = 1;
  const flagItems = mtBriefList(flagsRaw).map(x=>esc(mtBriefText(x))).filter(Boolean);
  const flags = flagItems.length ? mtBriefUl(flagItems) : '<p class="muted">None found.</p>';

  /* which research agents ran: research_briefs.agents */
  const agents = mtBriefUl(mtBriefList(row.agents).map(a=>{
    if(!a || typeof a !== 'object') return esc(mtBriefText(a));
    const name = mtBriefText(a.label || a.agent || a.name) || 'An agent';
    const ok = a.ok === false ? 'did not finish' : 'ran';
    const secs = Number(a.ms) > 0 ? ' in '+(Math.round(Number(a.ms)/100)/10)+' s' : '';
    const sum = mtBriefText(a.summary);
    return '<b>'+esc(name)+'</b> <span class="'+(a.ok === false ? 'mt-needword' : 'muted')+'">'+esc(ok+secs)+'</span>'+(sum?'<span class="mt-brief-sum">'+esc(sum)+'</span>':'');
  }).filter(Boolean));

  /* everything else the brief holds, in pipeline.js's own layout */
  const rest = {}; Object.keys(raw).forEach(k=>{ if(!used[k]) rest[k] = raw[k] });
  let more = '';
  try{
    const secs = typeof plBriefSections === 'function' ? plBriefSections({brief:rest}) : [];
    more = secs.map(sx => '<div class="pl-brief-sec mt-brief-sec">'+(sx.title?'<h4>'+esc(sx.title)+'</h4>':'')
      + (sx.text?'<p class="pl-pre">'+esc(sx.text)+'</p>':'')
      + (sx.lines && sx.lines.length ? '<div class="pl-kv">'+sx.lines.map(l=>'<small'+(l.label?'':' aria-hidden="true"')+'>'+esc(l.label||'·')+'</small><span>'+esc(l.value)+'</span>').join('')+'</div>' : '')
      + '</div>').join('');
  }catch(e){ more = '' }

  return '<div class="card pl-pad pl-brief mt-brief">'
    + (one ? '<p class="mt-brief-one">'+esc(one)+'</p>' : '')
    + mtBriefSec('Score', score)
    + mtBriefSec('Pains', pains)
    + mtBriefSec('Call plan', plan)
    + mtBriefSec('Red flags', flags)
    + mtBriefSec('Research agents that ran', agents || (row.writer ? '<p class="muted">Written by '+esc(String(row.writer))+'.</p>' : '<p class="muted">The brief does not say which agents ran.</p>'))
    + more + '</div>';
}

/* A website booking's panel. `d` is what pipeline.js's plBooking returns; the
   outcome buttons and their answers are pipeline.js's own renderers, and the
   brief is laid out by mtRenderBrief above. */
function mtRenderBookingPanel(d, st, error){
  if(!d || !d.booking)
    return mtPanelHTML('Booking', '', '<p class="mt-err" role="alert">'+esc(error||'That booking is not here any more.')+'</p>');
  const b = d.booking;
  /* a brief row with nothing in it is not a brief: nothing on the panel calls it ready */
  if(!mtBriefHas(d) && d.research && d.research.state === 'done') d = Object.assign({}, d, {research: Object.assign({}, d.research, {state:'empty'})});
  let body;
  try{
    body = typeof renderPlEnquiry==='function'
      ? renderPlEnquiry(d, {head: mtRenderBookingHead(d, st), brief: mtBriefSafe(d), now: mtNow()})
      : mtRenderBookingHead(d, st);
  }catch(e){ body = mtRenderBookingHead(d, st)+'<p class="mt-err" role="alert">The rest of this booking could not be drawn.</p>' }
  return mtPanelHTML(String(b.company||b.name||'Booking'), 'Booked on the website'+(b.source && b.source!=='website'?' · '+b.source:''), body);
}
function mtBriefSafe(d){
  try{ return mtRenderBrief(d) }
  catch(e){ return '<div class="card pl-pad pl-nobrief"><b>The brief could not be drawn</b><p class="muted">It is saved, but it is in a shape this screen cannot read.</p></div>' }
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

/* The view last chosen, from this browser. Week unless Month was picked. */
function mtSavedView(){
  try{ return localStorage.getItem(MT_VIEW_KEY) === 'month' ? 'month' : 'week' }catch(e){ return 'week' }
}
function mtSaveView(v){ try{ localStorage.setItem(MT_VIEW_KEY, v === 'month' ? 'month' : 'week') }catch(e){} return v }
function viewCalendar(){
  if(!mt.viewRead){ mt.viewRead = true; mt.view = mtSavedView(); }
  if(mt.want){ const w = mt.want; mt.want = null; mtGoTo(w); }
  else mtLoadCal();
  return mtHost('mtCalHost', mt.cal ? mtRenderCal(mt.cal) : mtLoading('Loading your calendar…'));
}
/* Give whichever grid is drawn — the week or the month — exactly the height the
   window has left, so the whole working day, or the whole month, shows with no
   scrolling. The stylesheet does the sum (100dvh − --mt-top); this only
   measures what sits above and below the grid. When even the smallest rows will
   not fit, the grid keeps its minimum height and the page itself scrolls —
   never a box inside it. */
function mtFit(){
  try{
    const g = document.getElementById('mtWk') || document.getElementById('mtMo'), c = document.getElementById('content');
    if(!g || !c || typeof g.getBoundingClientRect !== 'function' || typeof window === 'undefined') return false;
    const r = g.getBoundingClientRect(), cr = c.getBoundingClientRect();
    if(!(r.width > 0)) return false;                       // the phone: the grid is not drawn
    const pad = parseFloat(window.getComputedStyle(c).paddingBottom) || 0;
    const above = r.top + (c.scrollTop || 0);
    const below = Math.max(0, window.innerHeight - cr.bottom) + Math.max(0, pad - 16);   // the grid's -16px margin (meetings.css) takes back part of the padding
    g.style.setProperty('--mt-top', Math.ceil(above + below + 1)+'px');
    return true;
  }catch(e){ return false }
}
/* The listeners the calendar needs, added the first time it is drawn — nothing
   runs when the file loads. */
function mtBind(){
  if(mt.bound) return;
  try{
    if(typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('resize', mtFit);
    if(typeof document !== 'undefined' && typeof document.addEventListener === 'function'){
      document.addEventListener('click', mtLegendOutside);
      document.addEventListener('keydown', mtLegendKey);
    }
    mt.bound = true;
  }catch(e){}
}
/* Draw what is loaded. */
function mtPaintCal(){
  if(mt.cal){ mt.cal.needOnly = mt.needOnly; mt.cal.legend = mt.legend; }
  mtPaint('mtCalHost', mt.cal ? mtRenderCal(mt.cal) : mtErrorHTML(mt.err, 'mtLoadCal()'));
  mtBind(); mtFit();
  try{ if(typeof renderNav==='function') renderNav(); }catch(e){}
}
/* ---- the colour key behind the three dots ---- */
function mtToggleLegend(force){
  mt.legend = typeof force === 'boolean' ? force : !mt.legend;
  mtPaintCal();
  return mt.legend;
}
function mtLegendOutside(e){
  if(!mt.legend) return false;
  const t = e && e.target;
  try{ if(t && typeof t.closest === 'function' && t.closest('.mt-keywrap')) return false }catch(x){}
  mtToggleLegend(false);
  return true;
}
function mtLegendKey(e){
  if(!mt.legend || !e || e.key !== 'Escape') return false;
  mtToggleLegend(false);
  return true;
}
/* Read the month or week on screen and draw it. A slower, older answer never
   paints over a newer one. */
async function mtLoadCal(keep){
  const seq = ++mt.seq;
  const r = await mtCal(mt.view, mt.day);
  if(seq !== mt.seq) return r;
  mt.err = r.ok ? '' : r.error;
  mt.cal = r.ok ? r.data : null;
  if(r.ok){ mt.day = r.data.day; mt.view = r.data.view; }
  mtPaintCal();
  return r;
}
/* Today as the view on screen counts days: a business day in the week, one of
   the owner's days in the month. */
function mtToday(){
  const st = mtSettingsNow();
  return mt.view === 'week' ? mtBizToday(st, mtNow()) : mtDayKey(mtNow(), st.owner_zone);
}
function mtCalMove(n){
  const day = mtKeyOk(mt.day) ? mt.day : mtToday();
  if(mt.view === 'week') mt.day = mtAddDays(day, 7*n);
  else {
    const p = mtKeyParts(day), today = mtToday();
    const first = new Date(Date.UTC(p[0], p[1]-1+n, 1)).toISOString().slice(0,10);
    mt.day = today.slice(0,7) === first.slice(0,7) ? today : first;
  }
  return mtLoadCal();
}
function mtCalToday(){ mt.day = mtToday(); return mtLoadCal(); }
function mtSetView(v){ mt.view = mtSaveView(v === 'month' ? 'month' : 'week'); if(!mtKeyOk(mt.day)) mt.day = mtToday(); return mtLoadCal(); }
function mtGoWeek(key){ mt.view = mtSaveView('week'); if(mtKeyOk(key)) mt.day = key; return mtLoadCal(); }
/* Pick a day. Inside what is already loaded it only redraws; outside, it reads. */
function mtPickDay(key){
  if(!mtKeyOk(key)) return null;
  mt.day = key;
  const c = mt.cal;
  if(c && c.keys.indexOf(key) >= 0 && (c.view === 'week' || key.slice(0,7) === c.month)){ c.day = key; mtPaintCal(); return mtOk(c); }
  return mtLoadCal();
}
/* One day on. In the week that is the next business day shown — past the last
   one it reads the next week, past the first the week before. */
function mtDayMove(n){
  const c = mt.cal, day = mtKeyOk(mt.day) ? mt.day : mtToday();
  if(c && c.view === 'week' && mt.view === 'week' && Array.isArray(c.allKeys)){
    const i = c.keys.indexOf(day), j = i + (n < 0 ? -1 : 1);
    if(i >= 0 && j >= 0 && j < c.keys.length) return mtPickDay(c.keys[j]);
    mt.day = mtAddDays(c.allKeys[0], n < 0 ? -1 : 7);
    return mtLoadCal();
  }
  return mtPickDay(mtAddDays(day, n));
}
function mtIsPhone(){
  try{ return typeof window!=='undefined' && typeof window.matchMedia==='function' && !!window.matchMedia('(max-width:699px)').matches }catch(e){ return false }
}
/* The day number: on a phone it picks the day (listed under the grid); on a
   computer it opens that week. */
function mtDayClick(key){ return mtIsPhone() ? mtPickDay(key) : mtGoWeek(key) }
/* The rest of a day's cell: on a phone it picks the day; on a computer it opens
   the form for a new meeting on that date. */
function mtCellTap(key){ return mtIsPhone() ? mtPickDay(key) : mtOpenAdd({date:key}) }
function mtSwipeStart(e){ const t = e && e.touches && e.touches[0]; mt.sx = t ? t.clientX : null; mt.sy = t ? t.clientY : null }
function mtSwipeEnd(e){
  const t = e && e.changedTouches && e.changedTouches[0];
  if(!t || mt.sx == null) return null;
  const dx = t.clientX - mt.sx, dy = t.clientY - mt.sy; mt.sx = null;
  return Math.abs(dx) > 60 && Math.abs(dx) > 2*Math.abs(dy) ? mtDayMove(dx < 0 ? 1 : -1) : null;
}
function mtToggleNeed(){ mt.needOnly = !mt.needOnly; mtPaintCal(); return mt.needOnly }
function mtOpenFunnel(){ if(typeof render === 'function') render('funnel'); return true }

/* ---- the panel a call opens in ---- */
function mtShowPanel(html){ if(typeof openModal === 'function') openModal(html); return html }
function mtClosePanel(){ mt.open = null; if(typeof closeModal === 'function') closeModal(); return true }
function mtOpenEvent(key){
  const k = String(key||''), at = k.indexOf(':');
  const id = at < 0 ? '' : k.slice(at+1);
  if(!id) return null;
  return k.slice(0,at) === 'booking' ? mtOpenBooking(id) : mtOpenMeetingPanel(id);
}
/* A website booking: read it through pipeline.js, then draw it. */
async function mtOpenBooking(id){
  mt.open = 'booking:'+id;
  mtShowPanel(mtPanelHTML('Booking', '', '<p class="mt-none">Loading the booking…</p>'));
  if(typeof plLoadEnquiry !== 'function'){
    mtShowPanel(mtRenderBookingPanel(null, null, 'This booking could not be read, because part of Aviance OS did not load. Reload the page.'));
    return mtErr('pipeline.js did not load.');
  }
  const r = await plLoadEnquiry(id);
  if(mt.open !== 'booking:'+id) return r;
  mtShowPanel(mtRenderBookingPanel(r.ok ? r.data : null, mtSettingsNow(), r.ok ? '' : r.error));
  return r;
}
/* pipeline.js calls this after any outcome is written (plChanged): the calendar
   is read again and the open panel shows the new state. */
async function mtBookingChanged(id){
  if(mt.open === 'booking:'+id && typeof pl !== 'undefined' && pl.one && pl.one.booking)
    mtShowPanel(mtRenderBookingPanel(pl.one, mtSettingsNow()));
  if(mt.cal) await mtLoadCal(true);
  return true;
}
async function mtOpenMeetingPanel(id){
  mt.open = 'meeting:'+id;
  mtShowPanel(mtPanelHTML('Call', '', '<p class="mt-none">Loading the call…</p>'));
  const r = await mtLoadMeeting(id);
  if(!r.ok && mt.open === 'meeting:'+id) mtShowPanel(mtPanelHTML('Call', '', '<p class="mt-err" role="alert">'+esc(r.error)+'</p>'));
  return r;
}
/* Open the calendar on one call: its week, with its panel open. This is where
   an old booking link lands now that there is no Bookings screen. */
async function mtGoTo(key){
  const k = String(key||''), at = k.indexOf(':');
  const kind = at < 0 ? '' : k.slice(0,at), id = at < 0 ? '' : k.slice(at+1);
  const got = await mtSettings();
  const st = got.ok ? got.data : mtSettingsNow();
  let when = null;
  if(id && kind === 'booking' && typeof plLoadEnquiry === 'function'){
    const r = await plLoadEnquiry(id);
    if(r.ok) when = mtParseDate(r.data.booking.call_at);
  } else if(id && kind === 'meeting'){
    const r = await mtMeeting(id);
    if(r.ok) when = mtParseDate(r.data.starts_at);
  }
  if(when){ mt.view = 'week'; mt.day = mtDayKey(when, st.us_zone); }   // its business day
  const cal = await mtLoadCal();
  if(id && (kind === 'booking' || kind === 'meeting')) await mtOpenEvent(k);
  return cal;
}

function viewMeeting(id){
  const key = id==null || id==='' ? (mt.one && mt.one.id) : id;
  if(key==null || key==='') return mtHost('mtOneHost', mtRenderMeeting(null));
  mt.one = {id:key, data:null};
  mt.open = null;                 // this is the page, not the calendar's panel
  mtLoadMeeting(key);
  return mtHost('mtOneHost', mtLoading('Loading the call…'));
}
async function mtLoadMeeting(id){
  const got = await mtSettings();
  const st = got.ok ? got.data : mtSettingsNow();
  const r = await mtMeeting(id);
  if(!r.ok){ mtPaint('mtOneHost', mtErrorHTML(r.error, 'mtLoadMeeting('+mtJsArg(id)+')')); return r }
  const m = r.data;
  let call = null, client = null;
  if(String(m.kind)==='qualified' && m.client_id!=null){
    const q = await mtRun(() => sb.from('qualified_calls').select('*')
      .eq('client_id', m.client_id).eq('booked_for', m.starts_at).maybeSingle(), null);
    if(q.ok) call = q.data;
  }
  if(m.client_id!=null){
    const c = await mtRun(() => sb.from('clients').select('*').eq('id', m.client_id).maybeSingle(), null);
    if(c.ok) client = c.data;
  }
  const data = {meeting:m, when: mtBothZones(m.starts_at, st), call, client, st};
  mt.one = {id, data};
  mtPaint('mtOneHost', mtRenderMeeting(data));
  if(mt.open === 'meeting:'+id) mtShowPanel(mtPanelHTML(mtText(m.title) || mtWho(m, client),
    String(m.kind)==='other' && mtText(m.title) ? 'A meeting you added' : mtKindWord(m.kind), mtRenderMeeting(data)));
  return mtOk(data);
}
/* After a button changed a meeting: the meeting again, then the calendar. */
async function mtAfterMeeting(id){
  await mtLoadMeeting(id);
  if(mt.cal) await mtLoadCal(true);
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
/* The sidebar badge: calls that have been and gone and still have no outcome —
   website bookings and meetings alike. Read straight off what is already
   loaded — never a query. */
function mtNavCount(){
  const c = mt.cal;
  if(!c || !Array.isArray(c.events)) return '';
  const now = mtNow().getTime();
  const n = c.events.filter(e => e.needsOutcome && e.startMs < now).length;
  return n > 0 ? n : '';
}
async function mtHeldClick(id){
  const r = await mtDo(() => mtHeld(id), 'Marked: the call happened');
  if(r.ok && r.data && r.data.note && typeof toast==='function') toast(r.data.note);
  if(r.ok) await mtAfterMeeting(id);
  return r;
}
async function mtNoShowClick(id){
  const r = await mtDo(() => mtNoShow(id), "Marked: they didn't show, and it does not count");
  if(r.ok) await mtAfterMeeting(id);
  return r;
}
async function mtCancelClick(id, reason){
  const why = reason != null ? reason : (typeof prompt==='function' ? prompt('A short reason, if you like') : '');
  const r = await mtDo(() => mtCancel(id, why||''), 'Cancelled');
  if(r.ok) await mtAfterMeeting(id);
  return r;
}
/* Move a call to the time typed in its panel — a wall clock in the owner's zone. */
async function mtMoveClick(id, when){
  const to = when != null ? mtParseDate(when) : mtLocalToUtc(val('mtMoveTo'), mtSettingsNow().owner_zone);
  if(!to){ errEl('mtMoveErr', 'Pick the new day and time first.'); return mtErr('Pick the new day and time first.'); }
  const r = await mtDo(() => mtReschedule(id, to.toISOString()), 'Moved');
  if(!r.ok){ errEl('mtMoveErr', r.error); return r; }
  await mtAfterMeeting(id);
  return r;
}
async function mtCopy(text){
  let ok = false;
  try{ await navigator.clipboard.writeText(String(text||'')); ok = true; }catch(e){}
  if(typeof toast === 'function') toast(ok ? 'Link copied' : 'That could not be copied. Press and hold the link to copy it instead.');
  return ok;
}
async function mtUnblockClick(id){
  const r = await mtDo(() => mtUnblock(id), 'Unblocked — that time is open again');
  if(r.ok) await mtLoadCal(true);
  return r;
}
/* ---- add one of the owner's own meetings ----
   One form, reached three ways: the Add meeting button, a click on any empty
   time in the week, and a day in the month (which fills in that date). The
   time is typed in the owner's zone; the US Eastern time is shown beside it
   and follows as it is typed. */
function mtHm(d, zone){ const p = mtParts(d, zone); return mtPad(p.h)+':'+mtPad(p.mi) }
/* What the form opens on: {date, time} in the owner's zone. */
function mtAddDefaults(preset){
  const st = mtSettingsNow(), oz = st.owner_zone, p = preset || {};
  let d = mtParseDate(p.startsAt);
  if(d) return {date:mtDayKey(d,oz), time:mtHm(d,oz)};
  if(mtKeyOk(p.date)){
    /* a date with no time: when call hours open on that date's evening */
    const open = mtZoneToUtc(p.date, st.open_time, st.us_zone);
    return {date:p.date, time: open ? mtHm(open,oz) : '09:00'};
  }
  d = new Date(Math.ceil((mtNow().getTime()+60000)/1800000)*1800000);     // the next half hour
  return {date:mtDayKey(d,oz), time:mtHm(d,oz)};
}
/* "Fri 27 Nov · 11:00 am" in US Eastern for a date and time in the owner's zone. */
function mtAddEtText(date, time){
  const st = mtSettingsNow(), d = mtZoneToUtc(date, time, st.owner_zone);
  return d ? mtDayName(d, st.us_zone)+' · '+mtTime(d, st.us_zone) : 'Pick a day and a time';
}
function mtAddEtLine(){
  const t = mtAddEtText(val('mtAddDate'), val('mtAddTime'));
  try{ const e = document.getElementById('mtAddEt'); if(e) e.textContent = t }catch(x){}
  return t;
}
function mtRenderAddForm(preset){
  const st = mtSettingsNow(), v = mtAddDefaults(preset);
  const oName = mtZoneName(st.owner_zone), uName = mtZoneName(st.us_zone);
  return '<div class="modal-head"><div><h3>Add meeting</h3><p>One of your own, at any time you like. The time is '+esc(oName)+' time.</p></div></div>'
    + '<div class="modal-body mt-add">'
    + '<div class="field"><label for="mtAddTitle">Title</label><input id="mtAddTitle" type="text" maxlength="160" autocomplete="off" required></div>'
    + '<div class="field row2"><div><label for="mtAddName">Person\u2019s name</label><input id="mtAddName" type="text" maxlength="120" autocomplete="off"></div>'
    + '<div><label for="mtAddEmail">Email (optional)</label><input id="mtAddEmail" type="email" maxlength="254" autocomplete="off"></div></div>'
    + '<div class="mt-add-when"><div class="field"><label for="mtAddDate">Date</label><input id="mtAddDate" type="date" value="'+esc(v.date)+'" oninput="mtAddEtLine()" onchange="mtAddEtLine()"></div>'
    + '<div class="field"><label for="mtAddTime">Time ('+esc(mtZoneShort(st.owner_zone))+')</label><input id="mtAddTime" type="time" step="300" value="'+esc(v.time)+'" oninput="mtAddEtLine()" onchange="mtAddEtLine()"></div>'
    + '<div class="field mt-add-et"><label for="mtAddEt">'+esc(uName)+' ('+esc(mtZoneShort(st.us_zone))+')</label><output id="mtAddEt" for="mtAddDate mtAddTime" aria-live="polite">'+esc(mtAddEtText(v.date, v.time))+'</output></div></div>'
    + '<div class="field row2"><div><label for="mtAddLen">Length</label><select id="mtAddLen">'
    + MT_LENGTHS.map(n=>'<option value="'+n+'"'+(n===30?' selected':'')+'>'+n+' minutes</option>').join('')+'</select></div>'
    + '<div><label for="mtAddPlan">Plan (optional)</label><select id="mtAddPlan"><option value="">No plan</option>'
    + Object.keys(MT_PLANS).map(k=>'<option value="'+esc(k)+'">'+esc(MT_PLANS[k].word)+'</option>').join('')+'</select></div></div>'
    + '<div class="field"><label for="mtAddLink">Google Meet link (optional)</label><input id="mtAddLink" type="url" placeholder="https://meet.google.com/…" autocomplete="off"></div>'
    + '<p class="mt-none">This time will also be taken off your public booking page.</p>'
    + '<div id="mtAddErr" class="login-err" role="alert"></div></div>'
    + '<div class="modal-foot mt-acts"><button type="button" class="btn ghost" onclick="closeModal()">Close</button>'
    + '<button type="button" class="btn" onclick="mtSubmitAdd()">Add meeting</button></div>';
}
function mtOpenAdd(preset){
  const html = mtRenderAddForm(preset);
  if(typeof openModal === 'function') openModal(html);
  return html;
}
function mtAddAt(startsAt){ return mtOpenAdd({startsAt}) }
/* A click on empty time in a week column: the form, on the slot under the pointer. */
function mtColClick(e, key){
  const c = mt.cal;
  if(!c || c.view !== 'week' || !e) return null;
  const col = (c.cols||[]).find(x => x.key === key), box = e.currentTarget;
  if(!col || !box || typeof box.getBoundingClientRect !== 'function') return null;
  const r = box.getBoundingClientRect();
  if(!(r.height > 0)) return null;
  const f = Math.min(0.9999, Math.max(0, (e.clientY - r.top)/r.height));
  const step = c.st.slot_minutes*60000;
  return mtAddAt(new Date(col.start + Math.floor(f*(col.end-col.start)/step)*step).toISOString());
}
async function mtSubmitAdd(){
  const st = mtSettingsNow();
  const at = mtZoneToUtc(val('mtAddDate'), val('mtAddTime'), st.owner_zone);
  if(!at){ errEl('mtAddErr', 'Pick the day and the time first.'); return mtErr('Pick the day and the time first.'); }
  const len = val('mtAddLen');
  const r = await mtDo(() => mtAddOwn({
    title: val('mtAddTitle'), guestName: val('mtAddName'), guestEmail: val('mtAddEmail'),
    startsAt: at.toISOString(), minutes: len === '' ? 30 : Number(len),
    plan: val('mtAddPlan'), meetLink: val('mtAddLink')
  }), 'Added to your calendar');
  if(!r.ok){ errEl('mtAddErr', r.error); return r; }
  if(r.data && r.data.warning && typeof toast === 'function') toast(r.data.warning);
  if(typeof closeModal === 'function') closeModal();
  await mtLoadCal(true);                 // the same week, with the new meeting on it
  return r;
}
function mtOpenBlock(){
  if(typeof openModal === 'function') openModal(
    '<div class="modal-head"><div><h3>Block time</h3><p>Mark a time busy so nothing can be booked in it. Times are '+esc(mtZoneName(mtSettingsNow().owner_zone))+' time.</p></div></div>'
    + '<div class="modal-body"><div class="field row2">'
    + '<div><label for="mtBlkFrom">From</label><input id="mtBlkFrom" type="datetime-local"></div>'
    + '<div><label for="mtBlkTo">To</label><input id="mtBlkTo" type="datetime-local"></div></div>'
    + '<div class="field"><label for="mtBlkWhy">Why</label><input id="mtBlkWhy" maxlength="300" autocomplete="off"></div>'
    + '<div id="mtBlkErr" class="login-err"></div></div>'
    + '<div class="modal-foot mt-acts"><button type="button" class="btn ghost" onclick="closeModal()">Close</button>'
    + '<button type="button" class="btn" onclick="mtSubmitBlock()">Block it</button></div>');
  return true;
}
/* A "2026-11-24T14:00" from the browser is a wall clock in the owner's zone,
   like every other time on the calendar. */
function mtLocalToUtc(v, zone){
  const s = String(v||'').trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
  if(!m) return null;
  return mtZoneToUtc(m[1], m[2], zone || mtSettingsNow().owner_zone);
}
async function mtSubmitBlock(){
  const st = mtSettingsNow();
  const a = mtLocalToUtc(val('mtBlkFrom'), st.owner_zone), z = mtLocalToUtc(val('mtBlkTo'), st.owner_zone);
  if(!a || !z) return errEl('mtBlkErr','I need a start time and an end time.');
  const r = await mtDo(() => mtBlock(a.toISOString(), z.toISOString(), val('mtBlkWhy')), 'That time is blocked out');
  if(!r.ok) return errEl('mtBlkErr', r.error);
  if(typeof closeModal==='function') closeModal();
  await mtLoadCal(true);
  return r;
}

/* Forget everything read so far (used by the tests and by signing out). */
function mtForget(){
  mt.settings = null; mt.view = mtSavedView(); mt.viewRead = true; mt.day = null; mt.cal = null; mt.needOnly = false; mt.legend = false;
  mt.open = null; mt.want = null; mt.seq++; mt.one = null;
  mt.noshows = null; mt.err = ''; mt.now = null; mt.busy = false;
}
