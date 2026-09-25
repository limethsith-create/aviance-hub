/* ===================== AVIANCE HUB — Calendar =====================
   Every call the owner is supposed to hold, in Sri Lanka time, with US Eastern beside it.
   Clients pick a time on the machine's booking page → a *request* lands here → the owner says
   Yes / suggests another time / declines. Meetings he adds or blocks himself live here too.
   Contract: email-distributor/docs/CALENDAR.md
     GET  /api/mc/calendar?from=ISO&to=ISO → {meetings, requests, settings, free}
     POST /api/mc/calendar {action:'confirm'|'decline'|'suggest'|'move'|'held'|'noShow'|'cancel'|'add'|'block'|'unblock', …} → {ok, meeting}
   Loaded after trials.js + inquiries.js: reuses machineFetch, trialPost, tkAttr, tkSafeUrl, tkLink,
   tkDomId, tkParseDate, tkRel, tkFull, tkFirstName, tkListRows, tkSimple, renderLoading,
   renderMachineError, tkUpdatedStamp and the shell's esc / toast / openModal / closeModal / errEl / val.

   Time rules: times are stored in UTC. Every conversion goes through Intl.DateTimeFormat with a
   timeZone — there is no fixed offset anywhere, so US daylight saving is always right. A day column
   is a Sri Lanka date: a 4 pm ET Tuesday call is ~1:30 am Wednesday in Colombo, so it sits in the
   Wednesday column, in the "after midnight" hours at the top of that day.

   Rules as in trials.js: every machine string through esc(), links through tkSafeUrl/tkLink, ids into
   handlers only through tkAttr(); render functions never touch the DOM; nothing runs at load time. */

/* ===================== 0. CONSTANTS + CACHE ===================== */
const CAL_API='/api/mc/calendar';
const CAL_DEFAULTS={hours:['09:00','17:00'],days:[1,2,3,4,5],slotMinutes:30,ownerZone:'Asia/Colombo',usZone:'America/New_York',meetingLink:null};
const CAL_PX=1.6;              // week grid: pixels per minute — a 30-minute call is 48 px tall, a 15-minute one 24 px
const CAL_GAP_PX=40;           // the folded band for the hours with no calls (Sri Lanka daytime)
const CAL_FRESH_MS=15000;      // a week answer younger than this is not fetched again on navigation
const CAL_PEEK_MS=60000;       // other screens ask for the requests waiting (sidebar badge, trial rows) at most once a minute
const CAL_REFRESH_MS=60000;    // auto-refresh while the Calendar is open
const CAL_HIDDEN=['declined','cancelled'];   // off the grid unless "Show cancelled" is ticked
const CAL_STATUS={
  requested:{cls:'requested',pill:'amber',short:'Waiting for your yes',long:'They asked for this time — waiting for your yes'},
  suggested:{cls:'suggested',pill:'amber',short:'Waiting for them',long:'You suggested this time — waiting for them to say yes'},
  confirmed:{cls:'confirmed',pill:'green',short:'Confirmed',long:'Confirmed'},
  held:{cls:'held',pill:'grey',short:'Call done',long:'Call done'},
  no_show:{cls:'noshow',pill:'red',short:'No-show',long:"They didn't show"},
  declined:{cls:'gone',pill:'grey',short:'Declined',long:'Declined'},
  cancelled:{cls:'gone',pill:'grey',short:'Cancelled',long:'Cancelled'},
  blocked:{cls:'blocked',pill:'grey',short:'Busy',long:'Busy — you blocked this time'},
};
const CAL_ZONE_NAMES={'Asia/Colombo':'Sri Lanka','America/New_York':'US Eastern','America/Detroit':'US Eastern','America/Indiana/Indianapolis':'US Eastern','America/Kentucky/Louisville':'US Eastern','America/Chicago':'US Central','America/Denver':'US Mountain','America/Boise':'US Mountain','America/Phoenix':'Arizona','America/Los_Angeles':'US Pacific','America/Anchorage':'Alaska','Pacific/Honolulu':'Hawaii'};
const CAL_WHAT={requested:'Asked for this time',confirmed:'Confirmed',moved:'Moved to a new time',suggested:'Another time suggested',declined:'Declined',held:'Call done',no_show:"Marked: they didn't show",cancelled:'Cancelled',blocked:'Time blocked',unblocked:'Unblocked',added:'Added'};
const CAL_BY={them:'by them',owner:'by you',machine:'automatically'};
const CAL_SOURCE={booking_page:'They picked it on your booking page',owner:'You added it',inbox:'Found in your inbox (a calendar invite)',onboard_card:'Marked booked on the onboarding card'};
const CAL_DAY_NAMES=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const CAL_BLOCK_LENGTHS=[[30,'30 minutes'],[60,'1 hour'],[120,'2 hours'],[180,'3 hours'],[240,'4 hours'],[15,'15 minutes']];

/* Last good answers per week (key = that week's Monday, a Sri Lanka date "YYYY-MM-DD"). */
const cal={weeks:{},at:{},err:{},inflight:{},week:null,lastWeek:null,showGone:false,reqs:[],reqsAt:0,peekAt:0,settings:null,focus:null,pick:null,timer:null,now:null};

/* ===================== 1. TIME (pure — Intl only) ===================== */
function calNow(){return cal.now?new Date(cal.now):new Date()}
function calZoneOk(z){if(!z||typeof z!=='string')return false;try{new Intl.DateTimeFormat('en-US',{timeZone:z});return true}catch(e){return false}}
function calPad(n){return (n<10?'0':'')+n}
function calHmMin(hm){const m=/^(\d{1,2}):(\d{2})$/.exec(String(hm==null?'':hm).trim());if(!m)return NaN;const h=Number(m[1]),mi=Number(m[2]);return h<=24&&mi<60?h*60+mi:NaN}
const calFmtCache={};
function calFmt(zone,kind){
  const k=zone+'|'+kind;let f=calFmtCache[k];if(f)return f;
  const o={timeZone:zone};
  if(kind==='parts')Object.assign(o,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  else if(kind==='time')Object.assign(o,{hour:'numeric',minute:'2-digit',hour12:true});
  else if(kind==='month')Object.assign(o,{day:'numeric',month:'short',year:'numeric'});
  else Object.assign(o,{weekday:'short',day:'numeric',month:'short'});
  f=calFmtCache[k]=new Intl.DateTimeFormat('en-US',o);return f;
}
function calPartsOf(fmt,d){const p={};fmt.formatToParts(d).forEach(x=>{p[x.type]=x.value;});return p}
/* The wall clock of an instant in a zone: {y, m, d, h, mi, s}. */
function calParts(d,zone){const p=calPartsOf(calFmt(zone,'parts'),d);return {y:Number(p.year),m:Number(p.month),d:Number(p.day),h:Number(p.hour)%24,mi:Number(p.minute),s:Number(p.second)}}
/* The calendar date of an instant in a zone, "YYYY-MM-DD". */
function calDayKey(d,zone){const p=calParts(d,zone);return p.y+'-'+calPad(p.m)+'-'+calPad(p.d)}
/* Calendar-date arithmetic on "YYYY-MM-DD" (no time zone involved). */
function calKeyParts(k){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k||''));return m?[Number(m[1]),Number(m[2]),Number(m[3])]:null}
function calKeyOk(k){const p=calKeyParts(k);if(!p)return false;const t=new Date(Date.UTC(p[0],p[1]-1,p[2]));return t.getUTCMonth()===p[1]-1&&t.getUTCDate()===p[2]}
function calAddDays(k,n){const p=calKeyParts(k);return new Date(Date.UTC(p[0],p[1]-1,p[2]+n)).toISOString().slice(0,10)}
function calWeekday(k){const p=calKeyParts(k);return new Date(Date.UTC(p[0],p[1]-1,p[2])).getUTCDay()}
function calMonday(k){return calAddDays(k,-((calWeekday(k)+6)%7))}
/* A zone's offset from UTC at an instant, in minutes — read from Intl, never assumed. */
function calOffsetMin(ms,zone){const p=calParts(new Date(ms),zone);return Math.round((Date.UTC(p.y,p.m-1,p.d,p.h,p.mi,p.s)-Math.floor(ms/1000)*1000)/60000)}
/* A wall-clock time in a zone → the instant. The offset is read twice, so a daylight-saving change
   between the first guess and the answer still lands right. */
function calZoneToUtc(key,hm,zone){
  const p=calKeyParts(key),min=calHmMin(hm);if(!p||isNaN(min))return null;
  const wall=Date.UTC(p[0],p[1]-1,p[2],0,min);
  let ms=wall-calOffsetMin(wall,zone)*60000;
  ms=wall-calOffsetMin(ms,zone)*60000;
  return new Date(ms);
}
/* "6:30 pm" · "6:30 pm" → "6:30 pm" (short drops ":00": "9 am") */
function calTime(d,zone){const p=calPartsOf(calFmt(zone,'time'),d);return p.hour+':'+p.minute+' '+String(p.dayPeriod||'').toLowerCase()}
function calTimeShort(d,zone){return calTime(d,zone).replace(':00 ',' ')}
/* "Tue 29 Sep" */
function calDay(d,zone){const p=calPartsOf(calFmt(zone,'day'),d);return p.weekday+' '+p.day+' '+p.month}
function calWeekdayName(d,zone){return calPartsOf(calFmt(zone,'day'),d).weekday}
/* A calendar date key as "Tue 29 Sep" (formatted at noon UTC — pure calendar, no zone shift). */
function calKeyDay(k){const p=calKeyParts(k);return p?calDay(new Date(Date.UTC(p[0],p[1]-1,p[2],12)),'UTC'):''}
function calKeyDate(k,withYear){const p=calKeyParts(k);if(!p)return '';const q=calPartsOf(calFmt('UTC','month'),new Date(Date.UTC(p[0],p[1]-1,p[2],12)));return q.day+' '+q.month+(withYear?' '+q.year:'')}
function calZoneName(z){return CAL_ZONE_NAMES[z]||String(z||'').split('/').pop().replace(/_/g,' ')}
function calOwnerName(st){return calZoneName(st.ownerZone)}
/* One instant three ways: the owner's time (big) and US Eastern + theirs (small, with the weekday,
   because the US day is often the day before the Sri Lanka one). */
function calWhen(start,st,theirZone){
  const d=tkParseDate(start);if(!d)return null;
  const their=calZoneOk(theirZone)&&theirZone!==st.usZone&&theirZone!==st.ownerZone?theirZone:null;
  return {
    d,ownerKey:calDayKey(d,st.ownerZone),ownerDay:calDay(d,st.ownerZone),ownerTime:calTime(d,st.ownerZone),
    big:calDay(d,st.ownerZone)+' · '+calTime(d,st.ownerZone),
    us:calWeekdayName(d,st.usZone)+' '+calTime(d,st.usZone)+' '+calZoneName(st.usZone),
    usShort:calWeekdayName(d,st.usZone)+' '+calTime(d,st.usZone)+' ET',
    their:their?calWeekdayName(d,their)+' '+calTime(d,their)+' their time ('+calZoneName(their)+')':'',
  };
}
function calStamp(at,st){const d=tkParseDate(at);return d?calDay(d,st.ownerZone)+', '+calTime(d,st.ownerZone):''}

/* ===================== 2. DATA HELPERS (pure) ===================== */
/* The machine's settings, checked; anything missing or odd falls back to the contract's defaults. */
function calSettings(s){
  s=s&&typeof s==='object'?s:{};
  const h=s.hours;const hoursOk=Array.isArray(h)&&h.length===2&&!isNaN(calHmMin(h[0]))&&!isNaN(calHmMin(h[1]))&&calHmMin(h[0])<calHmMin(h[1]);
  return {
    hours:hoursOk?[String(h[0]).trim(),String(h[1]).trim()]:CAL_DEFAULTS.hours.slice(),
    days:Array.isArray(s.days)?s.days.map(Number).filter(n=>Number.isInteger(n)&&n>=0&&n<=6):CAL_DEFAULTS.days.slice(),
    slotMinutes:[15,30].includes(Number(s.slotMinutes))?Number(s.slotMinutes):CAL_DEFAULTS.slotMinutes,
    ownerZone:calZoneOk(s.ownerZone)?s.ownerZone:CAL_DEFAULTS.ownerZone,
    usZone:calZoneOk(s.usZone)?s.usZone:CAL_DEFAULTS.usZone,
    meetingLink:s.meetingLink==null||s.meetingLink===''?null:String(s.meetingLink),
  };
}
function calSettingsNow(){return calSettings(cal.settings)}
function calMinutes(m){const n=Math.round(Number(m&&m.minutes));return n>=5&&n<=480?n:30}
function calTitle(m){m=m||{};if(m.status==='blocked')return String(m.title||'Busy');return String(m.title||(m.company?'Call — '+m.company:'Meeting'))}
function calWhoText(m){m=m||{};return m.person&&m.company?m.person+' ('+m.company+')':String(m.person||m.company||'them')}
function calName(m){return (m&&(tkFirstName(m.person)||m.company))||'They'}
function calSourceText(s){return CAL_SOURCE[s]||String(s||'')}
function calStatusOf(m){const s=String((m&&m.status)||'');if(s==='requested'&&m.proposed&&tkParseDate(m.proposed))return CAL_STATUS.suggested;return CAL_STATUS[s]||{cls:'other',pill:'grey',short:s||'—',long:s||'—'}}
/* The time a meeting holds on the calendar: a request the owner answered with "Suggest another time"
   holds the suggested time (proposed), not the one they asked for (CALENDAR.md, as built). */
function calHeldAt(m){return m&&m.status==='requested'&&m.proposed&&tkParseDate(m.proposed)?m.proposed:(m&&m.start)}
function calDaysText(days){
  const ds=(days||[]).slice().sort((a,b)=>((a+6)%7)-((b+6)%7));if(!ds.length)return 'No days';
  const runs=[];ds.forEach(d=>{const r=runs[runs.length-1];if(r&&((r[r.length-1]+1)%7)===d)r.push(d);else runs.push([d]);});
  return runs.map(r=>r.length>=3?CAL_DAY_NAMES[r[0]]+'–'+CAL_DAY_NAMES[r[r.length-1]]:r.map(d=>CAL_DAY_NAMES[d]).join(', ')).join(', ');
}
/* Requests waiting: the machine's list plus any requested meeting in the week, once each.
   Waiting for the owner first, then the ones where he suggested another time; oldest first. */
function calRequestsOf(data){
  data=data||{};const seen={},out=[];
  [].concat(Array.isArray(data.requests)?data.requests:[],(Array.isArray(data.meetings)?data.meetings:[]).filter(m=>m&&m.status==='requested'))
    .forEach(m=>{if(m&&typeof m==='object'&&m.id!=null&&!seen[m.id]&&String(m.status||'requested')==='requested'){seen[m.id]=1;out.push(m);}});
  const ms=m=>{const d=tkParseDate(m.createdAt)||tkParseDate(m.start);return d?d.getTime():0};
  return out.map((m,i)=>({m,i})).sort((a,b)=>(!!a.m.proposed-!!b.m.proposed)||(ms(a.m)-ms(b.m))||(a.i-b.i)).map(x=>x.m);
}
function calVisible(m,showGone){return !!(m&&typeof m==='object'&&m.id!=null&&tkParseDate(calHeldAt(m))&&(showGone||!CAL_HIDDEN.includes(String(m.status))))}

/* ===================== 3. THE WEEK (pure models) ===================== */
/* Mon–Sun as Sri Lanka dates, and the UTC range the machine is asked for. */
function calWeekRange(monday,st){
  const days=[0,1,2,3,4,5,6].map(i=>calAddDays(monday,i));
  return {monday,days,from:calZoneToUtc(monday,'00:00',st.ownerZone).toISOString(),to:calZoneToUtc(calAddDays(monday,7),'00:00',st.ownerZone).toISOString()};
}
function calWeekLabel(monday){const sun=calAddDays(monday,6);return calKeyDate(monday,monday.slice(0,4)!==sun.slice(0,4))+' – '+calKeyDate(sun,true)}
/* The owner's call hours that fall on one Sri Lanka day, as [[fromMin, toMin], …] after that day's
   midnight. A US day's hours land on the Sri Lanka evening of that date and the small hours of the
   next one, so the US days before, on and after are all checked. */
function calDayOpen(key,st){
  const start=calZoneToUtc(key,'00:00',st.ownerZone).getTime(),end=calZoneToUtc(calAddDays(key,1),'00:00',st.ownerZone).getTime();
  const out=[];
  [-1,0,1].forEach(n=>{
    const u=calAddDays(key,n);if(!st.days.includes(calWeekday(u)))return;
    const a=calZoneToUtc(u,st.hours[0],st.usZone).getTime(),b=calZoneToUtc(u,st.hours[1],st.usZone).getTime();
    const s=Math.max(a,start),e=Math.min(b,end);
    if(e>s)out.push([Math.round((s-start)/60000),Math.round((e-start)/60000)]);
  });
  return out.sort((x,y)=>x[0]-y[0]);
}
function calMergeSpans(spans){
  const out=[];spans.slice().sort((a,b)=>a[0]-b[0]).forEach(s=>{const l=out[out.length-1];if(l&&s[0]<=l[1]+60)l[1]=Math.max(l[1],s[1]);else out.push(s.slice());});
  return out;
}
/* Side-by-side lanes for calls that overlap in one day column. */
function calLanes(items){
  let group=[],groupEnd=-1;
  const flush=()=>{const lanes=[];group.forEach(it=>{let i=lanes.findIndex(end=>end<=it.s);if(i<0){i=lanes.length;lanes.push(0);}lanes[i]=it.e;it.lane=i;});group.forEach(it=>{it.lanes=lanes.length;});group=[];groupEnd=-1;};
  items.sort((a,b)=>a.s-b.s||a.e-b.e).forEach(it=>{if(group.length&&it.s>=groupEnd)flush();group.push(it);groupEnd=Math.max(groupEnd,it.e);});
  if(group.length)flush();
  return items;
}
/* Everything the week grid and the phone list draw: seven Sri Lanka days with their calls and their
   open (call) hours, the rows actually shown (the call hours of the week plus any call outside them,
   on a 30-minute grid — the rest is folded into a thin "No calls" band), and a label per hour in
   Sri Lanka time with US Eastern beside it. */
function calWeekModel(monday,meetings,st,opts){
  opts=opts||{};const now=opts.now||calNow();const todayKey=calDayKey(now,st.ownerZone);
  const range=calWeekRange(monday,st);
  const days=range.days.map(key=>{
    const start=calZoneToUtc(key,'00:00',st.ownerZone).getTime(),end=calZoneToUtc(calAddDays(key,1),'00:00',st.ownerZone).getTime();
    const len=Math.round((end-start)/60000);
    const items=(Array.isArray(meetings)?meetings:[]).filter(m=>calVisible(m,opts.showGone)).map(m=>{const t=tkParseDate(calHeldAt(m)).getTime();const mins=calMinutes(m);const s=Math.round((t-start)/60000);return {m,t,s,e:Math.min(s+mins,len),mins}}).filter(x=>x.t>=start&&x.t<end);
    calLanes(items);
    return {key,label:calKeyDay(key),today:key===todayKey,past:key<todayKey,open:calDayOpen(key,st),items,start,end,len};
  });
  const spans=[];
  days.forEach(d=>{d.open.forEach(o=>spans.push([o[0],o[1]]));d.items.forEach(x=>spans.push([x.s,Math.max(x.e,x.s+15)]));});
  let segs=calMergeSpans(spans.map(([a,b])=>{const f=Math.floor(a/30)*30;return [f,Math.min(Math.max(Math.ceil(b/30)*30,f+30),1440)]}));
  if(!segs.length)segs=[[1080,1440]];
  let y=0;const layout=segs.map((sg,i)=>{if(i)y+=CAL_GAP_PX;const L={from:sg[0],to:sg[1],top:y};y+=(sg[1]-sg[0])*CAL_PX;return L});
  const yOf=min=>{for(const L of layout)if(min>=L.from&&min<=L.to)return Math.round((L.top+(min-L.from)*CAL_PX)*10)/10;return null};
  const gaps=layout.slice(1).map((L,i)=>({top:layout[i].top+(layout[i].to-layout[i].from)*CAL_PX,from:layout[i].to,to:L.from}));
  // One label per hour, on the whole US Eastern hours (6:30 pm = 9 am ET), worked out on the first day
  // with call hours; a US clock change inside the week is said in words below.
  const ref=days.find(d=>d.open.length)||days[0];
  const at=t=>new Date(ref.start+t*60000);
  const rows=[];
  layout.forEach(L=>{
    let first=L.from;for(let t=L.from;t<Math.min(L.from+60,L.to);t+=30)if(calParts(at(t),st.usZone).mi===0){first=t;break;}
    for(let t=first;t<L.to;t+=60){const usKey=calDayKey(at(t),st.usZone);
      rows.push({min:t,top:Math.round((L.top+(t-L.from)*CAL_PX)*10)/10,owner:calTime(at(t),st.ownerZone),us:calTimeShort(at(t),st.usZone),usRel:usKey<ref.key?'day before':usKey>ref.key?'next day':''});}
  });
  const offs=[];days.forEach(d=>d.open.forEach(o=>offs.push({d,off:calOffsetMin(d.start+o[0]*60000,st.usZone)})));
  let dst='';
  if(offs.length){const ch=offs.find(o=>o.off!==offs[0].off);if(ch)dst='US clocks change this week. From '+ch.d.label+', the '+calZoneName(st.usZone)+' times beside the hours are one hour '+(ch.off>offs[0].off?'later':'earlier')+' than shown. Every call still shows its own exact time.';}
  let nowY=null;const td=days.find(d=>d.today);
  if(td){const nm=(now.getTime()-td.start)/60000;nowY=yOf(nm);}
  return {st,range,days,layout,gaps,rows,height:Math.round(y*10)/10,yOf,dst,nowY,empty:!days.some(d=>d.items.length)};
}

/* ===================== 4. RENDERERS (pure: data → HTML) ===================== */
function renderCalBlock(x,model){
  const st=model.st,m=x.m,S=calStatusOf(m),d=new Date(x.t);
  const top=model.yOf(x.s);const h=Math.max(Math.round(((x.e-x.s)*CAL_PX-2)*10)/10,20);
  const w=100/(x.lanes||1),left=w*(x.lane||0);
  const who=m.status==='blocked'?calTitle(m):String(m.company||calTitle(m));
  const aria=calTitle(m)+(m.person&&m.status!=='blocked'?' with '+m.person:'')+'. '+calDay(d,st.ownerZone)+', '+calTime(d,st.ownerZone)+' '+calOwnerName(st)+' time ('+calWeekdayName(d,st.usZone)+' '+calTime(d,st.usZone)+' '+calZoneName(st.usZone)+'). '+x.mins+' minutes. '+S.short+'.';
  // who first (the row already says the time); the time and the status word on the second line when there is room
  return `<button type="button" class="cal-ev ${S.cls}${x.mins<=15?' short':''}" style="top:${top}px;height:${h}px;left:calc(${Math.round(left*100)/100}% + 2px);width:calc(${Math.round(w*100)/100}% - 4px)" onclick="calOpenMeeting(${tkAttr(m.id)})" title="${esc(aria)}" aria-label="${esc(aria)}"><span class="cal-ev-t">${esc(who)}</span>${x.mins>15?`<span class="cal-ev-s">${esc(calTime(d,st.ownerZone))} · ${esc(S.short)}</span>`:''}</button>`;
}
function renderCalGrid(model){
  const st=model.st,H=model.height;
  const head=`<div class="cal-corner"><b>${esc(calOwnerName(st))} time</b><small>${esc(calZoneName(st.usZone))} (ET) beside it</small></div>`+
    model.days.map(d=>`<div class="cal-dayhead${d.today?' today':''}${d.past?' past':''}">${esc(d.label)}${d.today?'<span class="cal-today-tag">Today</span>':''}</div>`).join('');
  const gutter=`<div class="cal-gutter" style="height:${H}px">${model.rows.map(r=>`<div class="cal-hour" style="top:${r.top}px"><b>${esc(r.owner)}</b><small>${esc(r.us)} ET${r.usRel?', '+esc(r.usRel):''}</small></div>`).join('')}${model.gaps.map(g=>`<div class="cal-gapnote" style="top:${g.top}px;height:${CAL_GAP_PX}px">No calls</div>`).join('')}</div>`;
  const cols=model.days.map(d=>{
    const lines=model.layout.map(L=>`<div class="cal-lines" style="top:${L.top}px;height:${Math.round((L.to-L.from)*CAL_PX*10)/10}px"></div>`).join('');
    const open=d.open.map(([a,b])=>{const y=model.yOf(a);return y==null?'':`<div class="cal-open" style="top:${y}px;height:${Math.round((b-a)*CAL_PX*10)/10}px"></div>`}).join('');
    const gaps=model.gaps.map(g=>`<div class="cal-gap" style="top:${g.top}px;height:${CAL_GAP_PX}px"></div>`).join('');
    const now=d.today&&model.nowY!=null?`<div class="cal-now" style="top:${model.nowY}px" aria-hidden="true"></div>`:'';
    return `<div class="cal-col${d.today?' today':''}" role="group" aria-label="${esc(d.label)}" style="height:${H}px">${open}${lines}${gaps}${d.items.map(x=>renderCalBlock(x,model)).join('')}${now}</div>`;
  }).join('');
  return `<div class="cal-grid-wrap"><div class="cal-grid" style="--cal-slot:${30*CAL_PX}px">${head}${gutter}${cols}</div></div>`;
}
/* The phone: one day after another, each call a big tappable row. */
function renderCalAgenda(model){
  const st=model.st;
  if(model.empty)return `<div class="cal-agenda"><p class="cal-anone">Nothing booked this week.</p></div>`;
  return `<div class="cal-agenda">${model.days.map(d=>`<section class="cal-aday${d.today?' today':''}"><h4>${esc(d.label)}${d.today?'<span class="cal-today-tag">Today</span>':''}</h4>${d.items.length
    ?`<ol class="cal-alist">${d.items.slice().sort((a,b)=>a.t-b.t).map(x=>{const m=x.m,S=calStatusOf(m),t=new Date(x.t);const who=m.status==='blocked'?calTitle(m):String(m.company||calTitle(m));
      return `<li><button type="button" class="cal-aitem ${S.cls}" onclick="calOpenMeeting(${tkAttr(m.id)})"><span class="cal-atime"><b>${esc(calTime(t,st.ownerZone))}</b><small>${esc(calWeekdayName(t,st.usZone)+' '+calTime(t,st.usZone))} ET</small></span><span class="cal-amain"><b>${esc(who)}</b>${m.person&&m.status!=='blocked'?`<small>${esc(m.person)}</small>`:''}<span class="cal-astatus">${esc(S.short)} · ${x.mins} min</span></span></button></li>`}).join('')}</ol>`
    :'<p class="cal-anone">Nothing booked</p>'}</section>`).join('')}</div>`;
}
function renderCalRequest(m,st,meta){
  meta=meta||{};const now=meta.now||calNow();const id=m.id;
  const w=calWhen(m.start,st,m.theirZone);const past=!!(w&&w.d<now);
  const prop=m.proposed?calWhen(m.proposed,st,m.theirZone):null;
  const focus=meta.focus!=null&&String(meta.focus)===String(id);
  const asked=tkParseDate(m.createdAt)?'Asked '+tkRel(m.createdAt,now):'';
  return `<div class="card cal-req${prop?' later':''}${focus?' focus':''}" id="${esc(tkDomId('calReq-',id))}">
    <div class="cal-req-who"><b class="cal-req-co">${esc(m.company||calTitle(m))}</b>${m.person?`<span class="cal-req-person">${esc(m.person)}</span>`:''}</div>
    ${w?`<div class="cal-req-when">${esc(w.big)} <small>your time</small></div><div class="cal-req-us">${esc(w.us)}${w.their?' · '+esc(w.their):''} · ${calMinutes(m)} min</div>`:'<div class="cal-req-when">No time given</div>'}
    ${past?'<p class="cal-req-late">This time has already passed. Suggest another time.</p>':''}
    ${prop?`<p class="cal-req-prop">You suggested ${esc(prop.big)} (your time; ${esc(prop.us)}) — waiting for them to say yes.</p>`:''}
    ${m.note?`<div class="cal-note">${esc(m.note)}</div>`:''}
    ${asked||m.source?`<div class="cal-req-meta">${esc([asked,m.source?calSourceText(m.source):''].filter(Boolean).join(' · '))}</div>`:''}
    <div class="cal-req-acts">${past||!w||prop?'':`<button class="btn" onclick="calConfirm(${tkAttr(id)})">Say yes and email them</button>`}<button class="btn${(past||!w)&&!prop?'':' ghost'}" onclick="calOpenSuggest(${tkAttr(id)})">${prop?'Suggest a different time':'Suggest another time'}</button><button class="btn ghost" onclick="calOpenDecline(${tkAttr(id)})">Say no…</button></div>
  </div>`;
}
function renderCalRequests(reqs,st,meta){
  reqs=reqs||[];const mine=reqs.filter(m=>!m.proposed),theirs=reqs.filter(m=>m.proposed);
  return `<div class="section-head tk-section cal-req-head"><h3>Waiting for your yes</h3>${mine.length?`<span class="count">${mine.length}</span>`:''}</div>`+
    (mine.length?`<p class="cal-sub">They asked for a call time. Say yes, suggest another time, or say no.</p><div class="cal-reqs">${mine.map(m=>renderCalRequest(m,st,meta)).join('')}</div>`
      :'<div class="tk-allclear">Nobody is waiting for your yes.</div>')+
    (theirs.length?`<h4 class="cal-req-sub">You suggested another time — waiting for them</h4><div class="cal-reqs">${theirs.map(m=>renderCalRequest(m,st,meta)).join('')}</div>`:'');
}
function calHoursLine(st,monday){
  if(!st.days.length)return '';
  let ref=monday;for(let i=0;i<7;i++){const k=calAddDays(monday,i);if(st.days.includes(calWeekday(k))){ref=k;break;}}
  const a=calZoneToUtc(ref,st.hours[0],st.usZone),b=calZoneToUtc(ref,st.hours[1],st.usZone);
  const next=calDayKey(b,st.ownerZone)>calDayKey(a,st.ownerZone);
  return 'Your call hours: '+calDaysText(st.days)+', '+calTime(a,st.usZone)+' – '+calTime(b,st.usZone)+' '+calZoneName(st.usZone)+' = '+calTime(a,st.ownerZone)+' – '+calTime(b,st.ownerZone)+(next?' the next morning':'')+' in '+calOwnerName(st)+'.';
}
function renderCalIntro(st,monday){
  const link=st.meetingLink?(tkSafeUrl(st.meetingLink)?tkLink(st.meetingLink):esc(st.meetingLink)):'';
  return `<div class="cal-intro"><p class="cal-explain">Clients pick a time on your booking page; you say yes here; they get an invite.</p>
    <p class="cal-facts">${link?`Calls happen on: ${link}`:"Calls happen on: no meeting link set yet, so the email says you'll send the link before the call."}<br>${esc(calHoursLine(st,monday))}</p></div>`;
}
function renderCalLegend(){
  return `<div class="cal-legend" aria-label="What the colours mean"><span><i class="cal-sw confirmed"></i>Confirmed</span><span><i class="cal-sw requested"></i>Waiting for your yes</span><span><i class="cal-sw suggested"></i>Waiting for them</span><span><i class="cal-sw held"></i>Call done</span><span><i class="cal-sw blocked"></i>Busy</span><span><i class="cal-sw noshow"></i>No-show</span><span class="cal-legend-open"><i class="cal-sw open"></i>White = your call hours</span></div>`;
}
/* The whole Calendar screen. meta: {week, now, showGone, at, focus, loading} */
function renderCalendar(data,meta){
  data=data||{};meta=meta||{};const st=calSettings(data.settings);const now=meta.now||calNow();
  const monday=calKeyOk(meta.week)?calMonday(meta.week):calMonday(calDayKey(now,st.ownerZone));
  const reqs=calRequestsOf(data);
  const bar=`<div class="cal-bar"><div class="cal-nav"><button class="btn ghost" onclick="calWeekMove(-1)" aria-label="Previous week" title="Previous week">◀</button><button class="btn ghost" onclick="calGoToday()">Today</button><button class="btn ghost" onclick="calWeekMove(1)" aria-label="Next week" title="Next week">▶</button><b class="cal-range">${esc(calWeekLabel(monday))}</b></div>
    <div class="cal-tools"><button class="btn" onclick="calOpenAdd()">Add a meeting</button><button class="btn ghost" onclick="calOpenBlock()">Block time</button><label class="cal-check"><input type="checkbox"${meta.showGone?' checked':''} onchange="calToggleGone(this.checked)">Show cancelled</label></div></div>`;
  let week;
  if(meta.loading)week=renderLoading('Loading this week…');
  else{
    const model=calWeekModel(monday,data.meetings,st,{now,showGone:meta.showGone});
    week=(model.dst?`<div class="tk-note">${esc(model.dst)}</div>`:'')+renderCalLegend()+
      (model.empty?'<p class="cal-empty">Nothing booked this week. When a client picks a time on your booking page, it shows up here for your yes.</p>':'')+
      renderCalGrid(model)+renderCalAgenda(model);
  }
  const foot=`<div class="cal-foot">${meta.at?tkUpdatedStamp(meta.at):''}<button type="button" class="tk-textbtn" onclick="calRefresh()">Refresh</button></div>`;
  return renderCalIntro(st,monday)+renderCalRequests(reqs,st,{now,focus:meta.focus})+
    `<div class="section-head tk-section cal-week-head"><h3>Your week</h3></div>`+bar+week+foot;
}
function renderCalHistory(h,st){
  const ms=x=>{const d=tkParseDate(x.at);return d?d.getTime():0};
  const list=(Array.isArray(h)?h:[]).filter(x=>x&&typeof x==='object').map((x,i)=>({x,i})).sort((a,b)=>ms(a.x)-ms(b.x)||a.i-b.i).map(o=>o.x);
  if(!list.length)return '';
  return `<h4 class="cal-h4">History</h4><ol class="cal-hist">${list.map(x=>`<li><span>${esc(CAL_WHAT[x.what]||String(x.what||''))}${x.by?' '+esc(CAL_BY[x.by]||'by '+x.by):''}</span><span class="cal-hist-at" title="${esc(tkFull(x.at))}">${esc(calStamp(x.at,st))}</span></li>`).join('')}</ol>`;
}
function calEmail(e){e=String(e||'').trim();return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(e)?e:''}
/* One call, opened from the grid or the phone list: who, when three ways, status in words, the note,
   the history, and the buttons its status allows. */
function renderCalMeeting(m,st,meta){
  meta=meta||{};const now=meta.now||calNow();const id=m.id;const status=String(m.status||'');const S=calStatusOf(m);
  const w=calWhen(calHeldAt(m),st,m.theirZone);const past=!!(w&&w.d<now);
  let long=S.long;
  if(status==='confirmed'&&past)long='Confirmed — did the call happen? Mark it below';
  const asked=status==='requested'&&m.proposed&&calHeldAt(m)!==m.start?calWhen(m.start,st,m.theirZone):null;
  const mail=calEmail(m.email);
  const kv=[];
  if(status!=='blocked'&&(m.company||m.person))kv.push(['Who',`${m.company?`<b>${esc(m.company)}</b>`:''}${m.company&&m.person?' — ':''}${esc(m.person||'')}${m.clientId!=null&&m.clientId!==''?` <button type="button" class="tk-textbtn cal-trial-link" onclick="closeModal();openTrial(${tkAttr(m.clientId)})">Open their trial</button>`:''}`]);
  if(mail)kv.push(['Email',`<a href="mailto:${esc(mail)}">${esc(mail)}</a>`]);
  const rest=long===S.short?'':long.indexOf(S.short+' — ')===0?long.charAt(S.short.length+3).toUpperCase()+long.slice(S.short.length+4):long;   // the pill already says the first words
  kv.push(['Status',`<span class="pill ${S.pill}">${esc(S.short)}</span> ${esc(rest)}`]);
  kv.push(['Length',esc(calMinutes(m)+' minutes')]);
  if(asked)kv.push(['They first asked for',esc(asked.big+' ('+asked.us+')')]);
  if(m.note)kv.push(['Their note',`<span class="cal-note">${esc(m.note)}</span>`]);
  if(m.declineReason)kv.push(['Reason',`<span class="cal-note">${esc(m.declineReason)}</span>`]);
  if(m.source)kv.push(['From',esc(calSourceText(m.source))]);
  if(status==='confirmed'||status==='requested')kv.push(['Calls happen on',st.meetingLink?(tkSafeUrl(st.meetingLink)?tkLink(st.meetingLink):esc(st.meetingLink)):'No meeting link set yet']);
  const b=(fn,label,ghost)=>`<button class="btn${ghost?' ghost':''}" onclick="${fn}(${tkAttr(id)})">${esc(label)}</button>`;
  const acts=[];
  if(status==='requested'){if(!past)acts.push(b('calConfirm','Say yes and email them'));acts.push(b('calOpenSuggest','Suggest another time',!past));acts.push(b('calOpenDecline','Say no…',true));}
  else if(status==='confirmed'){
    if(past){acts.push(b('calHeld','Call done'));acts.push(b('calNoShow','No-show',true));acts.push(b('calOpenMove','Move',true));acts.push(b('calOpenCancel','Cancel',true));}
    else{acts.push(b('calOpenMove','Move',true));acts.push(b('calHeld','Call done',true));acts.push(b('calNoShow','No-show',true));acts.push(b('calOpenCancel','Cancel',true));}
  }
  else if(status==='blocked')acts.push(b('calUnblock','Unblock'));
  return `<div class="modal-head cal-mhead"><div><h3>${esc(calTitle(m))}</h3><p>${esc(long)}</p></div></div>
    <div class="modal-body">
      ${w?`<div class="cal-when-big">${esc(w.big)} <small>${esc(calOwnerName(st))}</small></div><div class="cal-when-small">${esc(w.us)}${w.their?'<br>'+esc(w.their):''}</div>`:'<div class="cal-when-big">No time</div>'}
      <div class="tk-kv cal-kv">${kv.map(([k,v])=>`<small>${esc(k)}</small><span>${v}</span>`).join('')}</div>
      ${renderCalHistory(m.history,st)}
    </div>
    <div class="modal-foot cal-acts">${acts.join('')}<button class="btn ghost" onclick="closeModal()">Close</button></div>`;
}
/* Pick a free slot (Suggest another time / Move). p: {mode, id, week, sel}; wk: that week's answer. */
function renderCalPicker(p,m,wk,err,st,now){
  now=now||calNow();const w=m?calWhen(m.start,st,m.theirZone):null;const who=calWhoText(m);
  const head=p.mode==='suggest'
    ?`<h3>Suggest another time</h3><p>${esc(who)} asked for ${esc(w?w.big:'a time')}${w?' (your time)':''}. Pick an open time: they get an email with a one-click “Yes, that works”.</p>`
    :`<h3>Move the call</h3><p>With ${esc(who)}, now ${esc(w?w.big:'—')}${w?' (your time)':''}. Pick the new time: they get an email with it.</p>`;
  const range=calWeekRange(p.week,st);const from=Date.parse(range.from),to=Date.parse(range.to);
  let body;
  if(!wk)body=err?`<div class="tk-note red">${esc(err)}</div>`:renderLoading('Finding open times…');
  else{
    const slots=(Array.isArray(wk.free)?wk.free:[]).filter(s=>{const d=s&&tkParseDate(s.start);return d&&d>now&&d.getTime()>=from&&d.getTime()<to}).map(s=>({s,d:tkParseDate(s.start)})).sort((a,b)=>a.d-b.d);
    const byDay=[];slots.forEach(x=>{const k=calDayKey(x.d,st.ownerZone);let g=byDay.find(y=>y.k===k);if(!g){g={k,items:[]};byDay.push(g);}g.items.push(x);});
    body=byDay.length?byDay.map(g=>`<div class="cal-pick-day"><h4>${esc(calKeyDay(g.k))}</h4><div class="cal-slots">${g.items.map(x=>{const on=p.sel===x.s.start;return `<button type="button" class="cal-slot${on?' sel':''}" aria-pressed="${on}" onclick="calPickSlot(${tkAttr(x.s.start)})"><b>${esc(calTime(x.d,st.ownerZone))}</b><small>${esc(calWeekdayName(x.d,st.usZone)+' '+calTime(x.d,st.usZone))} ET</small></button>`}).join('')}</div></div>`).join('')
      :'<p class="cal-anone">No open times this week. Try the next week.</p>';
  }
  const chosen=p.sel?calWhen(p.sel,st,m&&m.theirZone):null;
  return `<div id="calPick"><div class="modal-head"><div>${head}</div></div>
    <div class="modal-body"><div class="cal-pick-nav"><button class="btn ghost" onclick="calPickWeek(-1)" aria-label="Earlier week">◀</button><b>${esc(calWeekLabel(p.week))}</b><button class="btn ghost" onclick="calPickWeek(1)" aria-label="Next week">▶</button></div>
      <p class="cal-sub">Times in ${esc(calOwnerName(st))} time, ${esc(calZoneName(st.usZone))} below each.</p>${body}
      ${chosen?`<p class="cal-chosen">Chosen: <b>${esc(chosen.big)}</b> (${esc(chosen.us)}${chosen.their?' · '+esc(chosen.their):''})</p>`:''}</div>
    <div class="modal-foot cal-acts"><button class="btn ghost" onclick="calClosePick()">Close</button><button class="btn" onclick="calSendPick()"${p.sel?'':' disabled'}>${p.mode==='suggest'?'Suggest this time':'Move to this time'}</button></div></div>`;
}
const CAL_REASONS={decline:["That time doesn't work for me. Please pick another time on the booking page.","I'm fully booked that week. Please pick a later time.","We're not able to go ahead right now."],cancel:["Something came up. Please pick a new time on the booking page.","I need to move this. I'll send you a new time.","We agreed to stop here."]};
function renderCalReason(kind,m,st){
  const w=m?calWhen(m.start,st,m.theirZone):null;const who=calWhoText(m);const id=m?m.id:'';
  const title=kind==='decline'?'Say no to '+who:'Cancel the call with '+who;
  return `<div class="modal-head"><div><h3>${esc(title)}</h3><p>${esc(w?w.big+' (your time) · '+w.us:'')}</p></div></div>
    <div class="modal-body"><div class="field"><label for="calReason">A short reason, if you like (they see it in the email)</label><textarea id="calReason" maxlength="300" rows="3" placeholder="e.g. That time doesn't work for me."></textarea></div>
      <div class="cal-chips">${CAL_REASONS[kind].map(t=>`<button type="button" class="cal-chip" onclick="calReasonUse(${tkAttr(t)})">${esc(t)}</button>`).join('')}</div>
      <div id="calReasonErr" class="login-err"></div></div>
    <div class="modal-foot cal-acts"><button class="btn ghost" onclick="closeModal()">Close</button><button class="btn" onclick="calSendReason(${tkAttr(kind)},${tkAttr(id)})">${kind==='decline'?'Say no and email them':'Cancel the call and email them'}</button></div>`;
}
function renderCalWhenFields(prefix,def){
  return `<div class="field row2"><div><label for="${prefix}Date">Date (Sri Lanka)</label><input id="${prefix}Date" type="date" value="${esc(def.date||'')}" oninput="calPreview(${tkAttr(prefix)})"></div><div><label for="${prefix}Time">Time (Sri Lanka)</label><input id="${prefix}Time" type="time" step="300" value="${esc(def.time||'')}" oninput="calPreview(${tkAttr(prefix)})"></div></div>`;
}
function renderCalAdd(clients,def,st){
  return `<div class="modal-head"><div><h3>Add a meeting</h3><p>Put a call in your calendar yourself. It is saved as confirmed.</p></div></div>
    <div class="modal-body">
      <div class="field"><label for="calAddClient">Client</label><select id="calAddClient"><option value="">No client (my own meeting)</option>${(clients||[]).map(c=>`<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}</select></div>
      <div class="field"><label for="calAddTitle">What is it?</label><input id="calAddTitle" maxlength="120" placeholder="e.g. Onboarding call" autocomplete="off"></div>
      ${renderCalWhenFields('calAdd',def)}
      <div class="field"><label for="calAddMin">How long</label><select id="calAddMin"><option value="30"${st.slotMinutes===30?' selected':''}>30 minutes</option><option value="15"${st.slotMinutes===15?' selected':''}>15 minutes</option></select></div>
      <p class="cal-preview" id="calAddPrev" aria-live="polite"></p>
      <div id="calAddErr" class="login-err"></div>
    </div>
    <div class="modal-foot cal-acts"><button class="btn ghost" onclick="closeModal()">Close</button><button class="btn" onclick="calSubmitAdd()">Add to calendar</button></div>`;
}
function renderCalBlockForm(def){
  return `<div class="modal-head"><div><h3>Block time</h3><p>Mark a time as busy so nobody can book it.</p></div></div>
    <div class="modal-body">
      ${renderCalWhenFields('calBlk',def)}
      <div class="field"><label for="calBlkMin">How long</label><select id="calBlkMin">${CAL_BLOCK_LENGTHS.map(([n,l])=>`<option value="${n}">${l}</option>`).join('')}</select></div>
      <p class="cal-preview" id="calBlkPrev" aria-live="polite"></p>
      <div id="calBlkErr" class="login-err"></div>
    </div>
    <div class="modal-foot cal-acts"><button class="btn ghost" onclick="closeModal()">Close</button><button class="btn" onclick="calSubmitBlock()">Block this time</button></div>`;
}
/* The small touches on the Trials screens: a trial with a request waiting for the owner's yes. */
function calReqFor(clientId){if(clientId==null||clientId==='')return null;return cal.reqs.find(m=>m&&!m.proposed&&m.clientId!=null&&String(m.clientId)===String(clientId))||null}
function calRowAsk(clientId,s){
  const m=calReqFor(clientId);if(!m)return '';
  const w=calWhen(m.start,calSettingsNow(),m.theirZone);
  const said=!!(s&&/calendar/i.test(String(s.label||'')+' '+String(s.next||'')));
  const text=said?'Open the Calendar to say yes':'They asked for '+(w?w.big+' (your time)':'a time')+' — say yes in the Calendar';
  return `<button type="button" class="cal-rowask" onclick="openCalendar(${tkAttr(m.id)})"><span>${esc(text)}</span><span class="cal-rowask-go" aria-hidden="true">›</span></button>`;
}
function calTrialAsk(clientId){
  const m=calReqFor(clientId);if(!m)return '';
  const w=calWhen(m.start,calSettingsNow(),m.theirZone);
  return `<div class="card cal-trial-ask"><div class="cal-trial-ask-main"><b>${esc(calName(m))} asked for a call: ${esc(w?w.big:'a time')}${w?' (your time)':''}</b><small>${esc(w?w.us+' · ':'')}${calMinutes(m)} min · say yes in the Calendar</small></div><button class="btn" onclick="openCalendar(${tkAttr(m.id)})">Open the Calendar</button></div>`;
}

/* ===================== 5. MACHINE ===================== */
async function calLoad(week,force){
  if(!calKeyOk(week))return {ok:false,error:'No week.'};
  if(!force&&cal.weeks[week]&&Date.now()-(cal.at[week]||0)<CAL_FRESH_MS)return {ok:true,data:cal.weeks[week]};
  if(cal.inflight[week])return cal.inflight[week];
  const range=calWeekRange(week,calSettingsNow());
  const p=machineFetch(CAL_API+'?from='+encodeURIComponent(range.from)+'&to='+encodeURIComponent(range.to)+'&all=1').then(r=>{
    if(r.ok&&r.data&&Array.isArray(r.data.meetings)){
      cal.weeks[week]=r.data;cal.at[week]=Date.now();delete cal.err[week];cal.lastWeek=week;
      if(r.data.settings&&typeof r.data.settings==='object')cal.settings=r.data.settings;
      cal.reqs=calRequestsOf(r.data);cal.reqsAt=Date.now();
    }else{cal.err[week]=r.error||"The calendar didn't load. Try again.";if(r.ok)r.ok=false;}
    return r;
  });
  cal.inflight[week]=p;
  try{return await p;}finally{delete cal.inflight[week];}
}
/* Put the machine's answer for one meeting into every cached week and the requests list. */
function calMerge(m){
  const st=calSettingsNow();const t=tkParseDate(calHeldAt(m));const same=x=>x&&String(x.id)===String(m.id);
  const putReq=list=>{const i=list.findIndex(same);if(m.status==='requested'){if(i>=0)list[i]=m;else list.push(m);}else if(i>=0)list.splice(i,1);return list};
  Object.keys(cal.weeks).forEach(k=>{
    const d=cal.weeks[k];if(!d)return;const list=Array.isArray(d.meetings)?d.meetings:(d.meetings=[]);
    const r=calWeekRange(k,st);const inWeek=!!t&&t.getTime()>=Date.parse(r.from)&&t.getTime()<Date.parse(r.to);
    const i=list.findIndex(same);
    if(i>=0){if(inWeek)list[i]=m;else list.splice(i,1);}else if(inWeek)list.push(m);
    if(Array.isArray(d.requests))putReq(d.requests);
  });
  putReq(cal.reqs);
}
function calFind(id){
  if(id==null)return null;const same=x=>x&&String(x.id)===String(id);
  const r=cal.reqs.find(same);if(r)return r;
  for(const k of Object.keys(cal.weeks)){const d=cal.weeks[k]||{};const x=[].concat(d.meetings||[],d.requests||[]).find(same);if(x)return x;}
  return null;
}
/* Every button goes through here: the contract body, a busy guard and plain toasts (trialPost), then
   the answer is merged at once and the week (free slots, requests) is fetched again behind it. */
async function calPost(body,opts){
  opts=opts||{};
  const r=await trialPost(CAL_API,body,{confirm:opts.confirm||'',done:opts.done,fail:opts.fail||'That did not work',reload:false});
  if(r&&r.ok){
    const m=r.data&&r.data.meeting;
    if(m&&typeof m==='object'&&m.id!=null)calMerge(m);
    if(opts.close!==false)closeModal();
    cal.pick=null;cal.focus=null;
    Object.keys(cal.at).forEach(k=>{cal.at[k]=0;});     // every other cached week is out of date now
    const cid=(m&&m.clientId)||opts.clientId;
    if(cid!=null&&typeof tk!=='undefined'){tk.detailAt[cid]=0;tk.hubAt=0;}   // the trial's onboarding card and the list pick it up next time
    calRepaint();
    calLoad(cal.week,true).then(()=>calRepaint({soft:true}));
  }else if(r&&r.status===409&&cal.pick){   // the slot was just taken: show the open times again
    calLoad(cal.pick.week,true).then(()=>calRefreshPick());
  }
  return r;
}

/* ===================== 6. VIEW (the shell router calls viewCalendar) ===================== */
function calHostHTML(){
  const wk=cal.weeks[cal.week],err=cal.err[cal.week];
  const meta={week:cal.week,showGone:cal.showGone,at:cal.at[cal.week],focus:cal.focus};
  if(wk)return (err?`<div class="tk-note red">Couldn't refresh — showing what we had ${esc(tkRel(new Date(cal.at[cal.week]||Date.now())))}. ${esc(err)} <button type="button" class="tk-textbtn" onclick="calRetry()">Try again</button></div>`:'')+renderCalendar(wk,meta);
  const last=cal.lastWeek&&cal.weeks[cal.lastWeek];
  if(last&&!err)return renderCalendar(last,Object.assign(meta,{loading:true,at:cal.at[cal.lastWeek]}));
  return err?renderMachineError(err,'calRetry()'):renderLoading('Loading your calendar…');
}
function calRepaint(){
  if(typeof currentView==='undefined'||currentView!=='calendar')return;
  const h=document.getElementById('calHost');if(!h)return;
  h.innerHTML=calHostHTML();
  try{renderNav();updateNotifBadge();}catch(e){}
  if(cal.focus&&cal.weeks[cal.week]){
    const el=document.getElementById(tkDomId('calReq-',cal.focus));
    if(el&&el.scrollIntoView)try{el.scrollIntoView({block:'center'});}catch(e){el.scrollIntoView();}
  }
}
function viewCalendar(){
  if(!trialsIsAdmin())return trialsNotAdminHTML();
  if(!calKeyOk(cal.week))cal.week=calMonday(calDayKey(calNow(),calSettingsNow().ownerZone));
  calLoad(cal.week).then(()=>{calRepaint();calOpenFocus();});
  loadHub(false).then(()=>{try{renderNav();}catch(e){}});   // the client list for "Add a meeting"
  return `<div id="calHost">${calHostHTML()}</div>`;
}
/* #calendar/{id} or a trial's "say yes in the Calendar": a request is highlighted at the top; any other
   meeting opens in its panel. */
function calOpenFocus(){
  if(!cal.focus||currentView!=='calendar')return;
  const m=calFind(cal.focus);if(!m)return;
  if(m.status!=='requested'){cal.focus=null;calOpenMeeting(m.id);}
}
function openCalendar(id){
  cal.focus=id!=null&&id!==''?String(id):null;
  const m=cal.focus&&calFind(cal.focus);const t=m&&tkParseDate(calHeldAt(m));
  if(t)cal.week=calMonday(calDayKey(t,calSettingsNow().ownerZone));
  render('calendar');
  calOpenFocus();
}
function calWeekMove(n){if(!calKeyOk(cal.week))cal.week=calMonday(calDayKey(calNow(),calSettingsNow().ownerZone));cal.week=calAddDays(cal.week,7*n);cal.focus=null;calRepaint();return calLoad(cal.week).then(()=>calRepaint())}
function calGoToday(){cal.week=calMonday(calDayKey(calNow(),calSettingsNow().ownerZone));cal.focus=null;calRepaint();return calLoad(cal.week).then(()=>calRepaint())}
function calToggleGone(on){cal.showGone=!!on;calRepaint()}
function calRetry(){const h=document.getElementById('calHost');if(h&&!cal.weeks[cal.week])h.innerHTML=renderLoading('Trying again…');return calLoad(cal.week,true).then(()=>calRepaint())}
async function calRefresh(){const r=await calLoad(cal.week,true);calRepaint();if(r&&r.ok===false)toast('Refresh failed: '+(r.error||'no answer'));return r}

/* ===================== 7. ACTIONS ===================== */
function calOpenMeeting(id){const m=calFind(id);if(!m){toast('That meeting is not on the calendar any more');return;}openModal(renderCalMeeting(m,calSettingsNow(),{now:calNow()}))}
function calConfirm(id){
  const m=calFind(id);const w=m&&calWhen(m.start,calSettingsNow(),m.theirZone);
  return calPost({action:'confirm',id},{confirm:'Say yes to '+calWhoText(m)+(w?' for '+w.big+' (your time)':'')+'? They get an email with the time and a calendar invite.',done:'Confirmed. '+calName(m)+' gets an email with the time and a calendar invite',fail:'Not confirmed',clientId:m&&m.clientId});
}
function calHeld(id){const m=calFind(id);return calPost({action:'held',id},{done:'Marked: the call happened',clientId:m&&m.clientId})}
function calNoShow(id){const m=calFind(id);return calPost({action:'noShow',id},{confirm:'Mark that '+calWhoText(m)+" didn't show up?",done:"Marked: they didn't show",clientId:m&&m.clientId})}
function calUnblock(id){return calPost({action:'unblock',id},{done:'Unblocked. That time is open again'})}
/* Suggest another time / Move: pick from the machine's open slots, a week at a time. */
function calOpenPick(mode,id){
  const m=calFind(id);const st=calSettingsNow();const now=calNow();const t=m&&tkParseDate(m.start);
  const week=calMonday(calDayKey(t&&t>now?t:now,st.ownerZone));
  cal.pick={mode,id:String(id),week,sel:null};
  openModal(calPickHTML());
  if(!cal.weeks[week]||Date.now()-(cal.at[week]||0)>CAL_FRESH_MS)return calLoad(week).then(()=>calRefreshPick());
  return Promise.resolve();
}
function calPickHTML(){const p=cal.pick;return renderCalPicker(p,calFind(p.id),cal.weeks[p.week],cal.err[p.week],calSettingsNow(),calNow())}
function calRefreshPick(){if(!cal.pick)return;try{const w=document.getElementById('modalWrap');if(!w||!w.classList.contains('open')||!document.getElementById('calPick'))return;}catch(e){return;}openModal(calPickHTML())}
function calOpenSuggest(id){return calOpenPick('suggest',id)}
function calOpenMove(id){return calOpenPick('move',id)}
function calPickWeek(n){const p=cal.pick;if(!p)return Promise.resolve();p.week=calAddDays(p.week,7*n);p.sel=null;openModal(calPickHTML());return calLoad(p.week).then(()=>calRefreshPick())}
function calPickSlot(start){if(!cal.pick)return;cal.pick.sel=String(start);openModal(calPickHTML())}
function calClosePick(){cal.pick=null;closeModal()}
function calSendPick(){
  const p=cal.pick;if(!p)return Promise.resolve({ok:false});
  if(!p.sel){toast('Pick a time first');return Promise.resolve({ok:false});}
  const m=calFind(p.id);const w=calWhen(p.sel,calSettingsNow(),m&&m.theirZone);const when=w?w.big+' ('+w.us+')':'the new time';
  return calPost({action:p.mode,id:p.id,start:p.sel},p.mode==='suggest'
    ?{done:'Sent. '+calName(m)+' can say yes to '+when+' with one click',fail:'Not sent',clientId:m&&m.clientId}
    :{done:'Moved to '+when+'. '+calName(m)+' gets an email with the new time',fail:'Not moved',clientId:m&&m.clientId});
}
function calOpenDecline(id){openModal(renderCalReason('decline',calFind(id)||{id},calSettingsNow()))}
function calOpenCancel(id){openModal(renderCalReason('cancel',calFind(id)||{id},calSettingsNow()))}
function calReasonUse(t){const e=document.getElementById('calReason');if(e){e.value=String(t||'');try{e.focus();}catch(x){}}}
function calSendReason(kind,id){
  if(kind!=='decline'&&kind!=='cancel')return Promise.resolve({ok:false});
  const e=document.getElementById('calReason');const reason=String((e&&e.value)||'').trim();
  if(reason.length>300){errEl('calReasonErr','Keep it short: 300 characters at most.');return Promise.resolve({ok:false});}
  const m=calFind(id);
  return calPost(Object.assign({action:kind,id},reason?{reason}:{}),kind==='decline'?{done:'Done. You said no',fail:'Not sent',clientId:m&&m.clientId}:{done:'Call cancelled',fail:'Not cancelled',clientId:m&&m.clientId});
}
/* Add a meeting / Block time: the owner types Sri Lanka time; the machine gets UTC. */
function calClientOptions(){
  const rows=typeof tkListRows==='function'&&typeof tk!=='undefined'&&tk.hub?tkListRows(tk.hub):[];
  return rows.filter(r=>r&&r.id!=null).map(r=>{const s=tkSimple(r);return {id:String(r.id),label:s.company+(s.person?' — '+s.person:''),done:s.done?1:0,company:s.company}}).sort((a,b)=>a.done-b.done||a.label.localeCompare(b.label));
}
/* The first open slot still ahead (else today, no time) — the form's starting value. */
function calDefaultWhen(){
  const st=calSettingsNow();const now=calNow();const wk=cal.weeks[calMonday(calDayKey(now,st.ownerZone))]||cal.weeks[cal.week];
  const next=((wk&&Array.isArray(wk.free))?wk.free:[]).map(s=>s&&tkParseDate(s.start)).filter(d=>d&&d>now).sort((a,b)=>a-b)[0];
  const d=next||now;const p=calParts(d,st.ownerZone);
  return {date:calDayKey(d,st.ownerZone),time:next?calPad(p.h)+':'+calPad(p.mi):''};
}
function calReadWhen(prefix){
  const date=val(prefix+'Date'),time=val(prefix+'Time');
  if(!calKeyOk(date)||isNaN(calHmMin(time))||calHmMin(time)>=1440)return null;
  return calZoneToUtc(date,time,calSettingsNow().ownerZone);
}
function calPreview(prefix){
  const out=document.getElementById(prefix+'Prev');if(!out)return;
  const d=calReadWhen(prefix);const st=calSettingsNow();
  out.textContent=d?'That is '+calWeekdayName(d,st.usZone)+' '+calTime(d,st.usZone)+' '+calZoneName(st.usZone)+' ('+calDay(d,st.ownerZone)+', '+calTime(d,st.ownerZone)+' in '+calOwnerName(st)+').':'';
}
function calOpenAdd(){openModal(renderCalAdd(calClientOptions(),calDefaultWhen(),calSettingsNow()));calPreview('calAdd')}
function calOpenBlock(){openModal(renderCalBlockForm(calDefaultWhen()));calPreview('calBlk')}
function calSubmitAdd(){
  const st=calSettingsNow();const d=calReadWhen('calAdd');
  if(!d){errEl('calAddErr','Pick the date and the time first.');return Promise.resolve({ok:false});}
  const clientId=val('calAddClient')||null;let title=val('calAddTitle');
  if(!title&&clientId){const c=calClientOptions().find(x=>x.id===clientId);title='Call — '+(c?c.company:clientId);}
  if(!title){errEl('calAddErr','Write what it is, e.g. "Call with my accountant".');return Promise.resolve({ok:false});}
  const minutes=Number(val('calAddMin'))===15?15:30;
  return calPost({action:'add',clientId,title,start:d.toISOString(),minutes},{done:'Added: '+calDay(d,st.ownerZone)+', '+calTime(d,st.ownerZone),fail:'Not added',clientId});
}
function calSubmitBlock(){
  const st=calSettingsNow();const d=calReadWhen('calBlk');
  if(!d){errEl('calBlkErr','Pick the date and the time first.');return Promise.resolve({ok:false});}
  const n=Number(val('calBlkMin'));const minutes=CAL_BLOCK_LENGTHS.some(([x])=>x===n)?n:30;
  return calPost({action:'block',start:d.toISOString(),minutes},{done:'Blocked: '+calDay(d,st.ownerZone)+', '+calTime(d,st.ownerZone),fail:'Not blocked'});
}

/* ===================== 8. SHELL INTEGRATION ===================== */
/* The sidebar badge beside Calendar: requests waiting for the owner's yes. */
function calNavCount(){const n=cal.reqs.filter(m=>!m.proposed).length;return n>0?n:''}
function calendarNotifs(){
  if(!trialsIsAdmin())return [];const st=calSettingsNow();
  return cal.reqs.filter(m=>!m.proposed).map(m=>{const w=calWhen(m.start,st,m.theirZone);return {dot:'var(--amber)',t:calWhoText(m)+' asked for a time',s:(w?w.big+' your time · ':'')+'say yes in the Calendar',go:()=>openCalendar(m.id)}});
}
function calendarCmdkActions(){
  const ic=(typeof I!=='undefined'&&I.calendar)||'';
  return [
    {type:'Go to',label:'Calendar',icon:ic,sub:'Every call, in Sri Lanka time',kw:'calendar meetings calls week booking requests yes',run:()=>{closeCmdk();render('calendar');}},
    {type:'Create',label:'Add a meeting',icon:ic,sub:'Put a call in your calendar',kw:'add a meeting call calendar new',run:()=>{closeCmdk();render('calendar');calOpenAdd();}},
    {type:'Create',label:'Block time',icon:ic,sub:'Mark a time as busy',kw:'block time busy calendar',run:()=>{closeCmdk();render('calendar');calOpenBlock();}},
  ];
}
/* Other screens: ask for the requests waiting (sidebar badge, the trial rows) at most once a minute. */
function calReqSig(){return cal.reqs.map(m=>m.id+':'+(m.proposed||'')+':'+m.start).join('|')}
function calPeek(){
  if(!trialsIsAdmin()||Date.now()-cal.peekAt<CAL_PEEK_MS)return Promise.resolve(null);
  cal.peekAt=Date.now();const before=calReqSig();
  return calLoad(calMonday(calDayKey(calNow(),calSettingsNow().ownerZone))).then(r=>{
    if(r&&r.ok&&calReqSig()!==before){
      try{renderNav();updateNotifBadge();}catch(e){}
      if(currentView==='trials'||currentView==='trial')trialsRepaint(currentView,{soft:true});
    }
    return r;
  },()=>null);
}
/* Called by the shell's render(). */
function calendarOnRender(v){
  if(v==='calendar')calStartTimer();else{calendarStopTimer();calPeek();}
}
function calStartTimer(){if(!cal.timer)cal.timer=setInterval(calTick,CAL_REFRESH_MS)}
function calendarStopTimer(){if(cal.timer){clearInterval(cal.timer);cal.timer=null;}}
/* The 60-second refresh: never while a panel is open, the page is hidden or an action is running. */
async function calTick(){
  if(currentView!=='calendar'){calendarStopTimer();return;}
  if(typeof document!=='undefined'&&document.hidden)return;
  try{const w=document.getElementById('modalWrap');if(w&&w.classList.contains('open'))return;}catch(e){}
  if(typeof tk!=='undefined'&&tk.busy)return;
  await calLoad(cal.week,true);calRepaint();
}
/* Sign-out: drop everything. */
function calendarForget(){
  calendarStopTimer();
  Object.assign(cal,{weeks:{},at:{},err:{},inflight:{},week:null,lastWeek:null,showGone:false,reqs:[],reqsAt:0,peekAt:0,settings:null,focus:null,pick:null});
}
