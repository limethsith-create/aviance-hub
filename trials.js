/* ============================================================================
   trials.js — Aviance Hub · Trials section
   ----------------------------------------------------------------------------
   The hub's window onto the Aviance Trial Machine (email-distributor). The
   machine does all the work; this file only shows and steers it through the
   contract in email-distributor/docs/HUB-API.md (incl. "v2 additions").

   Loaded by index.html after the shell script, so it can use the shell's globals:
     esc, emptyState, toast, openModal, closeModal, render, renderNav,
     updateNotifBadge, closeCmdk, I (icons), sb (Supabase client), authUser,
     currentView, MACHINE_URL.

   Layout of this file
     0. constants + in-memory cache
     1. pure helpers (time, numbers, pills, safe links) — no DOM, no network
     2. machine client: machineFetch + SSO opener       — network plumbing
     3. loaders (fill the cache; growth only on request)
     4. charts: data models + hand-rolled SVG           — pure, tested
     5. pure renderers (data → HTML string)              — what the tests call
     6. views the shell router calls (viewTrials …)
     7. actions wired to buttons
     8. shell integration (nav counts, notifications, ⌘K, auto-refresh timer)

   Rules: every machine string goes through esc(); every machine link through
   tkSafeUrl(); render functions never touch the DOM; nothing runs at load
   time; the growth history is never fetched by the 60-second auto-refresh.
   ========================================================================== */

/* ===================== 0. CONSTANTS + CACHE ===================== */
const TK_STAGE_ORDER=['intake','onboard','setup','build','live','decide','won','closing','ended'];
const TK_SYSTEM_ORDER=['intake','market','purchase','setup','warmup','list','copy','canary','sending','replies','calls','reports','closing'];
const TK_STATE_LABEL={applied:'Applied',queued:'In the queue',onboarding:'Onboarding',awaiting_purchase:'Waiting for you to buy',setup_check:'Checking the setup',warming:'Warming up',ready:'Ready for Day 1',sending:'Sending',paused:'Paused',extension:'Free extension',deciding:'Deciding',converted:'Converted',not_now:'Not now',retired:'Retired',deleted:'Deleted',declined:'Declined',closed_silent:'Never finished onboarding'};
const TK_SETUP_NAMES={migrated:'migration',encKey:'ENC_KEY',cronSecret:'CRON_SECRET',telegram:'Telegram',healthchecks:'Healthchecks',ownerInbox:'owner inbox'};
const TK_FIVE=[['sent','Sent','Emails sent'],['replies','Replies','Replies'],['positive','Pos.','Positive replies'],['booked','Booked','Calls booked'],['qualified','Qual.','Qualified calls']];
const TK_COUNTERS=[['sent','Sent'],['companiesContacted','Companies'],['bounces','Bounces'],['replies','Replies'],['positive','Positive'],['booked','Booked'],['held','Held'],['qualified','Qualified'],['noshows','No-shows'],['wrongfit','Wrong fit'],['warmupSent','Warm-up sent'],['warmupInbox','Warm-up inbox'],['warmupSpam','Warm-up spam'],['warmupRescued','Warm-up rescued']];
const TK_TABS=[['overview','Overview'],['growth','Growth'],['systems','Systems'],['leads','Leads'],['deliverability','Deliverability'],['inboxes','Inboxes'],['calls','Calls'],['replies','Replies'],['copy','Copy'],['comingup','Coming up'],['timeline','Timeline'],['actions','Actions']];
const TK_TAB_ALIAS={numbers:'overview',setup:'deliverability',promises:'comingup',upcoming:'comingup',reports:'comingup'};
const TK_TRIAL_VIEWS=['trials','trial','trialPurchase','trialAlerts'];
const TK_REFRESH_MS=60000;            // auto-refresh while a trials view is open (never fetches growth)
const TK_FRESH_MS=15000;              // a cached answer younger than this is not re-fetched on navigation
const TK_GROWTH_RANGES=[7,30,45,90];
const TK_GROWTH_FRESH_MS=5*60000;     // Growth tab: reuse an answer this young
const TK_OVERVIEW_FRESH_MS=15*60000;  // Overview sparklines (14 days)
const TK_SPARK_FRESH_MS=6*3600000;    // board-card sparklines — kept across reloads to spare the machine's Redis
const TK_SPARK_KEY='avianceGrowth14:v1';
/* States with nothing to chart yet (no warm-up, no sending): no sparkline fetch. */
const TK_PRE_WARMUP=['applied','queued','onboarding','awaiting_purchase','setup_check','declined','closed_silent','deleted'];

/* Last good answers live here so navigating back is instant. */
const tk={hub:null,hubAt:0,hubErr:null,detail:{},detailAt:{},detailErr:{},alerts:null,alertsAt:0,alertsErr:null,purchase:{},purchaseAt:{},purchaseErr:{},
  growth:{},growthErr:{},growthBusy:{},growthDays:45,spark:null,sparkErr:{},sparkBusy:{},timer:null,busy:false};
let currentTrialId=null;
let trialTab='overview';
let trialsAlertFilter='open';

/* ===================== 1. PURE HELPERS ===================== */
function tkMachineUrl(){return typeof MACHINE_URL==='string'?MACHINE_URL:'https://email-distributor.vercel.app'}
/* Safe argument for an inline onclick="fn(...)" — JSON string literal, then HTML-escaped. */
function tkAttr(v){return esc(JSON.stringify(v==null?'':String(v)))}
function tkTruthy(v){return v===true||v===1||v==='1'||v==='true'}
function tkNorm(v){if(v==null||v==='')return null;const n=Number(v);return isNaN(n)?null:n}
function tkNum(n){if(n==null||n==='')return '—';const x=Number(n);return isNaN(x)?esc(n):x.toLocaleString()}
function tkRate(x){if(x==null||x==='')return '—';const n=Number(x);return isNaN(n)?esc(x):Math.round(n*100)+'%'}
function tkPct1(x){if(x==null||x==='')return '—';const n=Number(x);return isNaN(n)?esc(x):(Math.round(n*1000)/10)+'%'}
function tkPct(x){if(x==null||x==='')return '—';const n=Number(x);return isNaN(n)?esc(x):Math.round(n)+'%'}
function tkMoney(n){if(n==null||n==='')return '—';const x=Number(n);return isNaN(x)?esc(n):'$'+x.toFixed(2)}
function tkParseDate(v){if(!v)return null;if(v instanceof Date)return isNaN(v)?null:v;const s=String(v);const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s);if(m)return new Date(+m[1],+m[2]-1,+m[3]);const d=new Date(s);return isNaN(d)?null:d}
function tkRel(v,now){const d=tkParseDate(v);if(!d)return '—';const diff=((now||new Date())-d)/1000;const a=Math.abs(diff);
  const f=a<5?'':a<60?Math.round(a)+' s':a<3600?Math.round(a/60)+' min':a<172800?Math.round(a/3600)+' h':Math.round(a/86400)+' d';
  if(!f)return 'just now';return diff>=0?f+' ago':'in '+f}
function tkDate(v){const d=tkParseDate(v);if(!d)return '—';const y=d.getFullYear()!==new Date().getFullYear();return d.toLocaleDateString(undefined,y?{month:'short',day:'numeric',year:'numeric'}:{month:'short',day:'numeric'})}
function tkDateTime(v){const d=tkParseDate(v);if(!d)return '—';return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
function tkDayName(v){const d=tkParseDate(v);return d?d.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'}):String(v||'')}
function tkDayShort(v){const d=tkParseDate(v);return d?d.toLocaleDateString(undefined,{day:'numeric',month:'short'}):String(v||'')}
function tkFull(v){const d=tkParseDate(v);return d?d.toLocaleString():''}
function tkDot(c){return `<span class="tk-dot ${esc(c||'grey')}"></span>`}
function tkHealthClass(h){h=String(h||'').toLowerCase();return h==='green'?'green':(h==='yellow'||h==='amber')?'amber':h==='red'?'red':'grey'}
function tkStateLabel(row){row=row||{};return row.stateLabel||TK_STATE_LABEL[row.state]||row.state||'—'}
function tkStatusPill(s){s=String(s||'off').toLowerCase();const lab={ok:'OK',working:'Working',waiting:'Waiting',blocked:'Blocked',off:'Off'}[s];return `<span class="pill tk-st ${lab?esc(s):'unknown'}">${esc(lab||s)}</span>`}
function tkCheckPill(s){s=String(s||'pending').toLowerCase();const m={pass:['green','Pass'],ok:['green','Pass'],fail:['red','Fail'],warn:['amber','Warn'],warning:['amber','Warn'],pending:['grey','Pending']}[s]||['grey',s];return `<span class="pill ${m[0]}">${esc(m[1])}</span>`}
function tkKindClass(k){k=String(k||'').toLowerCase();if(k==='interested')return 'green';if(k==='question'||k==='unclear')return 'amber';if(['no','angry','legal','bounce'].includes(k))return 'red';if(k==='wrongperson')return 'blue';return 'grey'}
function tkHeartbeatClass(hb){if(!hb||hb.ageSec==null||hb.ageSec==='')return 'red';const a=Number(hb.ageSec);if(isNaN(a))return 'red';return a<=180?'green':a<=900?'amber':'red'}
/* Machine `errors` come as an array of strings or an object {field: message}. */
function tkErrorList(errors){if(!errors)return [];if(Array.isArray(errors))return errors.map(String);if(typeof errors==='object')return Object.keys(errors).map(k=>k==='_form'?String(errors[k]):k+': '+String(errors[k]));return [String(errors)]}
function tkDetailText(d){if(d==null||d==='')return '';if(typeof d==='string')return d;try{const s=JSON.stringify(d);return s.length>220?s.slice(0,217)+'…':s}catch(e){return String(d)}}
/* Only http(s) links from machine data (research crawls, registrars, reports) — never javascript: or data:. */
function tkSafeUrl(u){u=String(u==null?'':u).trim();return /^https?:\/\/[^\s]+$/i.test(u)?u:''}
function tkLink(u,label){const s=tkSafeUrl(u);const text=label!=null&&label!==''?String(label):s.replace(/^https?:\/\//i,'').replace(/\/$/,'');return s?`<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`:esc(label||'')}
function tkDomId(prefix,id){return prefix+String(id==null?'':id).replace(/[^A-Za-z0-9_-]/g,'_')}
function tkAllRows(hub){const out=[];if(!hub)return out;(hub.stages||[]).forEach(s=>(s.clients||[]).forEach(r=>out.push(r)));((hub.machine&&hub.machine.others)||[]).forEach(r=>out.push(r));return out}
function tkFindRow(id){if(!id)return null;const rows=tkAllRows(tk.hub);let r=rows.find(x=>x.id===id);if(!r&&tk.detail[id]&&tk.detail[id].row)r=tk.detail[id].row;return r||null}
function tkClientName(id){const r=tkFindRow(id);return r&&r.name?r.name:(id||'')}
function tkSortedStages(stages){return (stages||[]).slice().sort((a,b)=>{const ia=TK_STAGE_ORDER.indexOf(a.key),ib=TK_STAGE_ORDER.indexOf(b.key);return (ia<0?99:ia)-(ib<0?99:ib)})}
function tkSortedSystems(systems){return (systems||[]).slice().sort((a,b)=>{const ia=TK_SYSTEM_ORDER.indexOf(a.key),ib=TK_SYSTEM_ORDER.indexOf(b.key);return (ia<0?99:ia)-(ib<0?99:ib)})}
function tkTodoLabel(t){const a=(t&&t.action)||{};if(a.label)return a.label;switch(a.type){case 'api':return 'Do it';case 'view':return a.view==='purchase'?'Buy & paste':a.view==='sequence'?'Open copy':a.section==='application'?'Review application':'Open trial';case 'mc':return 'Open in Mission Control';case 'link':return 'Open link';default:return ''}}
function tkFindTodo(id){const all=[];if(tk.hub)(tk.hub.todos||[]).forEach(t=>all.push(t));tkAllRows(tk.hub).forEach(r=>(r.todo||[]).forEach(t=>all.push(Object.assign({clientId:r.id,clientName:r.name},t))));Object.keys(tk.detail).forEach(k=>{const d=tk.detail[k];if(d&&d.row)(d.row.todo||[]).forEach(t=>all.push(Object.assign({clientId:d.row.id,clientName:d.row.name},t)))});return all.find(t=>t.id===id)||null}
function tkTabKey(tab){tab=TK_TAB_ALIAS[tab]||tab;return tab}

/* ===================== 2. MACHINE CLIENT ===================== */
async function tkToken(){try{const r=await sb.auth.getSession();return r&&r.data&&r.data.session?r.data.session.access_token||null:null}catch(e){return null}}
/* machineFetch(path, {method, body, timeout}) → {ok, status, data, error}. Never throws. */
async function machineFetch(path,opts){
  opts=opts||{};
  const token=await tkToken();
  if(!token)return {ok:false,status:0,data:null,error:'You are not signed in to the hub, so there is no token to show the machine. Sign out and back in.'};
  const headers={'authorization':'Bearer '+token,'accept':'application/json'};
  const init={method:opts.method||(opts.body!==undefined?'POST':'GET'),headers};
  if(opts.body!==undefined){headers['content-type']='application/json';init.body=typeof opts.body==='string'?opts.body:JSON.stringify(opts.body);}
  let ctrl=null,timer=null;
  if(typeof AbortController!=='undefined'){ctrl=new AbortController();init.signal=ctrl.signal;timer=setTimeout(()=>ctrl.abort(),opts.timeout||30000);}
  let res;
  try{res=await fetch(tkMachineUrl()+path,init);}
  catch(e){if(timer)clearTimeout(timer);const to=e&&e.name==='AbortError';return {ok:false,status:0,data:null,error:to?'The machine took too long to answer (timed out after '+Math.round((opts.timeout||30000)/1000)+' s).':'Could not reach the machine at '+tkMachineUrl()+' — network down, wrong MACHINE_URL, or the machine has not allowed this hub origin yet ('+((e&&e.message)||'fetch failed')+').'};}
  if(timer)clearTimeout(timer);
  let text='';try{text=await res.text();}catch(e){text='';}
  let data=null;if(text){try{data=JSON.parse(text);}catch(e){data=null;}}
  if(!res.ok){
    let msg=(data&&(data.error||data.message))||'';
    if(!msg&&data&&data.errors)msg=tkErrorList(data.errors).join(' · ');
    if(!msg){
      if(res.status===401)msg='The machine rejected the hub sign-in (401). Your email must be on the machine\'s admin list (HUB_ADMIN_EMAILS).';
      else if(res.status===403)msg='The machine refused this (403).';
      else if(res.status===404)msg='The machine has no such endpoint yet (404 on '+path+').';
      else if(res.status===503)msg='The machine is not set up for this yet (503).';
      else msg='The machine answered '+res.status+(text?': '+text.slice(0,200):'.');
    }
    return {ok:false,status:res.status,data,error:msg};
  }
  if(data===null&&text)return {ok:false,status:res.status,data:null,error:'The machine answered with something that is not JSON ('+text.slice(0,120)+').'};
  if(data&&data.ok===false)return {ok:false,status:res.status,data,error:data.error||tkErrorList(data.errors).join(' · ')||'The machine said no.'};
  return {ok:true,status:res.status,data,error:null};
}
/* Single sign-on into a Mission Control page: hidden POST form → /api/mc/login (target _blank).
   The tab is opened synchronously (inside the click) so popup blockers stay quiet. */
function openMachine(path){
  const name='aviance_mc_'+Date.now();
  let win=null;try{win=window.open('about:blank',name);}catch(e){win=null;}
  tkToken().then(token=>{
    if(!token){if(win)try{win.close();}catch(e){}toast('Not signed in — sign in to the hub first');return;}
    const f=document.createElement('form');f.method='post';f.action=tkMachineUrl()+'/api/mc/login';f.target=win?name:'_blank';f.style.display='none';
    const add=(n,v)=>{const i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.appendChild(i);};
    add('hubToken',token);add('next',path||'/mc');
    document.body.appendChild(f);f.submit();f.remove();
  });
}

/* ===================== 3. LOADERS ===================== */
function trialsIngestHub(data){tk.hub=data;tk.hubAt=Date.now();tk.hubErr=null;return data}
async function loadHub(force){
  if(!force&&tk.hub&&Date.now()-tk.hubAt<TK_FRESH_MS)return {ok:true,data:tk.hub};
  const r=await machineFetch('/api/mc/hub');
  if(r.ok&&r.data&&Array.isArray(r.data.stages))trialsIngestHub(r.data);
  else{tk.hubErr=r.error||'The machine answered without the board data (no "stages").';if(r.ok)r.ok=false;}
  return r;
}
async function loadTrial(id,force){
  if(!id)return {ok:false,error:'No trial selected.'};
  if(!force&&tk.detail[id]&&Date.now()-(tk.detailAt[id]||0)<TK_FRESH_MS)return {ok:true,data:tk.detail[id]};
  const r=await machineFetch('/api/mc/hub/'+encodeURIComponent(id));
  if(r.ok&&r.data&&r.data.row){tk.detail[id]=r.data;tk.detailAt[id]=Date.now();delete tk.detailErr[id];tkApplyGates(r.data);}
  else{tk.detailErr[id]=r.error||'The machine answered without the trial data (no "row").';if(r.ok)r.ok=false;}
  return r;
}
async function loadAlerts(force){
  if(!force&&tk.alerts&&Date.now()-tk.alertsAt<TK_FRESH_MS)return {ok:true,data:tk.alerts};
  const r=await machineFetch('/api/mc/alerts');
  if(r.ok&&r.data&&Array.isArray(r.data.alerts)){tk.alerts=r.data.alerts;tk.alertsAt=Date.now();tk.alertsErr=null;}
  else{tk.alertsErr=r.error||'The machine answered without an "alerts" list.';if(r.ok)r.ok=false;}
  return r;
}
async function loadPurchase(id,force){
  if(!id)return {ok:false,error:'No trial selected.'};
  if(!force&&tk.purchase[id]&&Date.now()-(tk.purchaseAt[id]||0)<TK_FRESH_MS)return {ok:true,data:tk.purchase[id]};
  const r=await machineFetch('/api/mc/clients/'+encodeURIComponent(id)+'/purchase');
  if(r.ok&&r.data&&typeof r.data==='object'){tk.purchase[id]=r.data;tk.purchaseAt[id]=Date.now();delete tk.purchaseErr[id];}
  else{tk.purchaseErr[id]=r.error||'The machine answered without the purchase data.';if(r.ok)r.ok=false;}
  return r;
}
/* Growth history — GET /api/mc/hub/{id}/growth?days=N. Costs the machine ~days×(2+inboxes)
   Redis reads, so it is only fetched when the owner opens something that shows it. */
async function loadGrowth(id,days,force){
  days=TK_GROWTH_RANGES.includes(Number(days))?Number(days):45;
  const c=tk.growth[id];
  if(!force&&c&&c.days===days&&Date.now()-c.at<TK_GROWTH_FRESH_MS)return {ok:true,data:c.data};
  const r=await machineFetch('/api/mc/hub/'+encodeURIComponent(id)+'/growth?days='+days);
  if(r.ok&&r.data&&Array.isArray(r.data.days)){tk.growth[id]={days,data:r.data,at:Date.now()};delete tk.growthErr[id];tkSparkPut(id,tkSliceGrowth(r.data,14));}
  else{tk.growthErr[id]=r.error||'The machine answered without growth data (no "days").';if(r.ok)r.ok=false;}
  return r;
}
/* 14-day history for sparklines (board cards + Overview): kept in memory and in localStorage. */
function tkSparkAll(){if(!tk.spark){tk.spark={};try{const raw=typeof localStorage!=='undefined'?localStorage.getItem(TK_SPARK_KEY):null;const o=raw?JSON.parse(raw):null;if(o&&typeof o==='object')tk.spark=o;}catch(e){tk.spark={};}}return tk.spark}
function tkSparkGet(id){const s=tkSparkAll()[id];return s&&s.g&&Array.isArray(s.g.days)?s:null}
function tkSparkPut(id,g){if(!id||!g)return;tkSparkAll()[id]={at:Date.now(),g:{days:g.days,email:g.email,warmup:g.warmup}};delete tk.sparkErr[id];try{localStorage.setItem(TK_SPARK_KEY,JSON.stringify(tk.spark));}catch(e){}}
function loadSpark(id,maxAge){
  const c=tkSparkGet(id);if(c&&Date.now()-c.at<maxAge)return Promise.resolve({ok:true,data:c.g});
  if(tk.sparkBusy[id])return tk.sparkBusy[id];
  const p=machineFetch('/api/mc/hub/'+encodeURIComponent(id)+'/growth?days=14').then(r=>{
    delete tk.sparkBusy[id];
    if(r.ok&&r.data&&Array.isArray(r.data.days))tkSparkPut(id,tkSliceGrowth(r.data,14));
    else{tk.sparkErr[id]=r.error||'no growth data';if(r.ok)r.ok=false;}
    return r;
  });
  tk.sparkBusy[id]=p;return p;
}

/* ===================== 4. CHARTS (pure: data → SVG/HTML string) ===================== */
/* Hand-rolled SVG, no library: themes from CSS variables (light/dark switch for free), text
   stays in HTML so it never shrinks below the 13px floor, and it is testable in Node.
   Rules (dataviz): one y-axis per chart; solid hairline grid; dashed = a threshold; null = gap. */
const TK_W=1000;
function tkSum(values){let s=0,any=false;(values||[]).forEach(v=>{if(v!=null&&!isNaN(v)){s+=Number(v);any=true;}});return any?s:null}
function tkLast(values){for(let i=(values||[]).length-1;i>=0;i--)if(values[i]!=null)return Number(values[i]);return null}
function tkHasAny(values){return (values||[]).some(v=>v!=null)}
/* Running total inside the shown range (a day with nothing recorded keeps the previous total). */
function tkRunning(values){let s=0;return (values||[]).map(v=>{if(v!=null)s+=Number(v);return s})}
/* Split a series into drawable runs; a null ends a run (the gap). */
function tkSegments(values){const out=[];let cur=null;(values||[]).forEach((v,i)=>{if(v==null||isNaN(v)){cur=null;return;}if(!cur){cur=[];out.push(cur);}cur.push([i,Number(v)]);});return out}
function tkNiceMax(m){if(!(m>0))return 1;const p=Math.pow(10,Math.floor(Math.log10(m)));const f=m/p;const s=f<=1?1:f<=2?2:f<=5?5:10;return s*p}
function tkSliceGrowth(g,n){
  if(!g||!Array.isArray(g.days))return null;const k=Math.max(0,g.days.length-n);
  const sl=a=>Array.isArray(a)?a.slice(k):[];const obj=o=>{const r={};Object.keys(o||{}).forEach(key=>{r[key]=sl(o[key]);});return r};
  const first=g.days[k];
  return {days:g.days.slice(k),email:obj(g.email),warmup:obj(g.warmup),inboxes:(g.inboxes||[]).map(ib=>Object.assign({},ib,{sent:sl(ib.sent),rate:sl(ib.rate)})),placement:(g.placement||[]).filter(p=>!p||!p.day||!first||p.day>=first)};
}
/* One series from the growth payload. The machine sends 0 for a counter that did not move on a
   recorded day and null only when nothing was recorded that day — null stays a gap, never a 0. */
function tkSeries(src,key,n){return Array.from({length:n},(_,i)=>src&&Array.isArray(src[key])?tkNorm(src[key][i]):null)}
function tkSendingModel(g){
  const days=(g&&g.days)||[];const n=days.length;const e=(g&&g.email)||{};const S=k=>tkSeries(e,k,n);
  const sent=S('sent'),d0=S('sentD0'),replies=S('replies'),positive=S('positive'),booked=S('booked'),held=S('held'),qualified=S('qualified'),bounces=S('bounces');
  const first=d0.map((v,i)=>v==null?null:(sent[i]==null?v:Math.min(v,sent[i])));
  const follow=sent.map((v,i)=>v==null?null:Math.max(0,v-(d0[i]||0)));
  return {days,first,follow,sent,replies,positive,booked,held,qualified,bounces,
    totals:{sent:tkSum(sent),first:tkSum(first),follow:tkSum(follow),replies:tkSum(replies),positive:tkSum(positive),booked:tkSum(booked),qualified:tkSum(qualified)},
    running:{sent:tkRunning(sent),replies:tkRunning(replies),positive:tkRunning(positive),booked:tkRunning(booked)},
    /* warm-up writes the same daily record, so pre-Day-1 days carry sent 0 — "any" means something actually went out */
    any:(tkSum(sent)||0)>0||(tkSum(replies)||0)>0};
}
function tkWarmupModel(g){
  const days=(g&&g.days)||[];const n=days.length;const w=(g&&g.warmup)||{};
  const sent=tkSeries(w,'sent',n),inbox=tkSeries(w,'inbox',n),spam=tkSeries(w,'spam',n),rate=tkSeries(w,'rate',n);
  return {days,sent,inbox,spam,rate,any:(tkSum(sent)||0)>0||tkHasAny(rate),
    totals:{sent:tkSum(sent),inbox:tkSum(inbox),spam:tkSum(spam)},lastRate:tkLast(rate)};
}
/* Day-1 lines: the machine's defaults (config.js CANARY.gate, PLACEMENT.minScore,
   PLACEMENT.maxSpamAssassin; SpamAssassin's own spam line is 5), replaced by the
   machine's real settings from `deliverability.gates` whenever a trial loads. */
const TK_RULES={seedGate:.85,minScore:8,maxSpamAssassin:2,spamLine:5};
function tkApplyGates(d){const g=d&&d.deliverability&&d.deliverability.gates;if(!g)return;
  const n=v=>(typeof v==='number'&&isFinite(v))?v:null;
  if(n(g.seedPlacement)!=null)TK_RULES.seedGate=g.seedPlacement;
  if(n(g.mailTesterMin)!=null)TK_RULES.minScore=g.mailTesterMin;
  if(n(g.spamAssassinMax)!=null)TK_RULES.maxSpamAssassin=g.spamAssassinMax;}
const TK_TOOL_NAME={seed:'Seed test','mail-tester':'mail-tester',dkimvalidator:'DKIM Validator'};
function tkToolName(t){return TK_TOOL_NAME[String(t||'').toLowerCase()]||String(t||'Test')}
/* A spam test's verdict in plain words. `pass` from the machine wins when present (it also
   knows the DKIM/SPF result); otherwise the number is judged against the Day-1 line. */
function tkSpamVerdict(p){
  p=p||{};const sc=tkNorm(p.score),sa=tkNorm(p.spamAssassin);
  if(sc!=null){const ok=p.pass!=null?!!p.pass:sc>=TK_RULES.minScore;
    return ok?{level:'pass',value:sc+'/10',text:sc+'/10 — passes (Day 1 needs '+TK_RULES.minScore+'+)'}:{level:'fail',value:sc+'/10',text:sc+'/10 — too low for Day 1 (needs '+TK_RULES.minScore+'+)'};}
  if(sa!=null){const pts=sa+' SpamAssassin point'+(sa===1?'':'s');
    if(sa>=TK_RULES.spamLine)return {level:'spam',value:sa+' pts',text:pts+' — marked as spam (5 or more)'};
    if(sa>TK_RULES.maxSpamAssassin)return {level:'high',value:sa+' pts',text:pts+' — too high for Day 1 (needs '+TK_RULES.maxSpamAssassin+' or less)'};
    if(p.pass===false)return {level:'fail',value:sa+' pts',text:pts+' — fails: DKIM or SPF did not pass'};
    return {level:'pass',value:sa+' pts',text:pts+' — passes (Day 1 needs '+TK_RULES.maxSpamAssassin+' or less)'};}
  if(p.error)return {level:'none',value:'—',text:"Couldn't finish: "+p.error};
  return {level:'none',value:'—',text:'No result yet'};
}
function tkSpamPill(v){const m={pass:['green','Passes'],high:['amber','Too high'],fail:['red','Fails'],spam:['red','Spam'],none:['grey','No result']}[v.level]||['grey','—'];return `<span class="pill ${m[0]}">${m[1]}</span>`}
/* Placement tests → one value per day per series (last test that day), coloured by verdict. */
function tkPlacementModel(g){
  const days=(g&&g.days)||[];const idx={};days.forEach((d,i)=>{idx[d]=i;});
  const blank=()=>days.map(()=>null);
  const seed=blank(),mt={pass:blank(),fail:blank()},sa={pass:blank(),high:blank(),spam:blank()},tests=days.map(()=>[]);
  ((g&&g.placement)||[]).forEach(p=>{if(!p)return;const i=idx[p.day];if(i==null)return;tests[i].push(p);
    const tool=String(p.tool||'seed').toLowerCase();
    if(tool==='seed'){const r=tkNorm(p.inboxRate);if(r!=null)seed[i]=r;return;}
    const v=tkSpamVerdict(p);
    if(tkNorm(p.score)!=null){mt.pass[i]=null;mt.fail[i]=null;mt[v.level==='pass'?'pass':'fail'][i]=tkNorm(p.score);}
    else if(tkNorm(p.spamAssassin)!=null){sa.pass[i]=sa.high[i]=sa.spam[i]=null;sa[v.level==='pass'?'pass':v.level==='spam'?'spam':'high'][i]=tkNorm(p.spamAssassin);}
  });
  const any=o=>Object.values(o).some(tkHasAny);
  return {days,seed,mt,sa,tests,anySeed:tkHasAny(seed),anyMt:any(mt),anySa:any(sa)};
}
function tkBarPath(x,y,w,h,r,color){
  const f=v=>v.toFixed(1);
  if(r<=0)return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" style="fill:var(${color})"/>`;
  return `<path d="M${f(x)} ${f(y+h)}V${f(y+r)}Q${f(x)} ${f(y)} ${f(x+r)} ${f(y)}H${f(x+w-r)}Q${f(x+w)} ${f(y)} ${f(x+w)} ${f(y+r)}V${f(y+h)}Z" style="fill:var(${color})"/>`;
}
/* Tooltip rows: [value, words, series-colour-token|null]. */
function tkTip(day,rows,note){return {d:tkDayName(day),r:rows||[],note:note||''}}
/*
 renderChart(o) — one chart, one y-axis.
   o.days      ['YYYY-MM-DD', …]
   o.bars      [{label, color:'--c1', values}]  stacked, bottom first
   o.lines     [{label, color, values}]         null = gap
   o.dots      [{label, color, values}]
   o.refs      [{value, label}]                 dashed threshold lines
   o.percent   y is 0–1 shown as %;  o.max fixes the top;  o.fmt formats y labels
   o.height    plot height in px;  o.tips  one tkTip per day;  o.label  for screen readers
*/
function renderChart(o){
  const days=o.days||[];const n=days.length;if(!n)return '';
  const H=o.height||160;const slot=TK_W/n;const bw=Math.min(slot*0.72,30);
  const bars=o.bars||[],lines=o.lines||[],dots=o.dots||[],refs=o.refs||[];
  let max=o.max;
  if(max==null){
    let m=0;
    for(let i=0;i<n;i++){let s=0;bars.forEach(b=>{const v=b.values[i];if(v!=null)s+=v;});m=Math.max(m,s);lines.concat(dots).forEach(l=>{const v=l.values[i];if(v!=null)m=Math.max(m,v);});}
    refs.forEach(r=>{m=Math.max(m,r.value);});
    max=o.percent?1:Math.max(1,tkNiceMax(m));
  }
  const Y=v=>H-(Math.max(0,Math.min(v,max))/max)*H;
  const X=i=>(i+.5)*slot;
  const f=v=>v.toFixed(1);
  const parts=[],pts=[];
  /* dots are HTML circles over the plot: an SVG dot would be squashed (or dropped) when a narrow screen stretches the chart */
  const pt=(i,v,color)=>pts.push(`<i class="tk-pt" style="left:${(X(i)/TK_W*100).toFixed(3)}%;top:${(Y(v)/H*100).toFixed(3)}%;background:var(${color})"></i>`);
  [0,.5,1].forEach(k=>{const y=f(H-k*H);parts.push(`<line x1="0" x2="${TK_W}" y1="${y}" y2="${y}" class="tk-gridline" vector-effect="non-scaling-stroke"/>`);});
  for(let i=0;i<n;i++){
    let base=0,rec=false;const x=X(i)-bw/2;const segs=[];
    bars.forEach(b=>{const v=b.values[i];if(v==null)return;rec=true;if(v>0){segs.push([base,v,b.color]);base+=v;}});
    if(rec&&base===0){parts.push(`<rect x="${f(x)}" y="${f(H-2)}" width="${f(bw)}" height="2" class="tk-zero"/>`);continue;}
    segs.forEach(([b0,v,color],k)=>{const top=Y(b0+v);let bot=Y(b0);if(k>0)bot-=2;const h=bot-top;if(h<=0.5)return;parts.push(tkBarPath(x,top,bw,h,k===segs.length-1?Math.min(4,h,bw/2):0,color));});
  }
  refs.forEach(r=>{const y=f(Y(r.value));parts.push(`<line x1="0" x2="${TK_W}" y1="${y}" y2="${y}" class="tk-refline" vector-effect="non-scaling-stroke"/>`);});
  lines.forEach(l=>tkSegments(l.values).forEach(seg=>{
    if(seg.length===1){pt(seg[0][0],seg[0][1],l.color);return;}
    parts.push(`<path d="${seg.map(([i,v],k)=>(k?'L':'M')+f(X(i))+' '+f(Y(v))).join('')}" class="tk-line" style="stroke:var(${l.color})" vector-effect="non-scaling-stroke"/>`);
  }));
  dots.forEach(dt=>dt.values.forEach((v,i)=>{if(v!=null)pt(i,v,dt.color);}));
  const fmt=o.fmt||(o.percent?(v=>Math.round(v*100)+'%'):(v=>tkNum(v)));
  const ylab=[[max,0],[max/2,50],[0,100]].filter(([v])=>o.percent||o.fmt||Number.isInteger(v)).map(([v,t])=>`<span style="top:${t}%">${esc(fmt(v))}</span>`).join('');
  const xi=n>2?[0,Math.floor((n-1)/2),n-1]:n===2?[0,1]:[0];
  const refLabels=refs.filter(r=>r.label).map(r=>`<span class="tk-ref" style="top:${(Y(r.value)/H*100).toFixed(2)}%">${esc(r.label)}</span>`).join('');
  const series=bars.map(b=>['bar',b]).concat(lines.map(l=>['line',l]),dots.map(d=>['dot',d]));
  const legend=series.length>1?`<div class="tk-legend">${series.map(([k,s])=>`<span><i class="tk-key-${k}" style="background:var(${s.color})"></i>${esc(s.label)}</span>`).join('')}</div>`:'';
  return `<figure class="tk-chart">${legend}<div class="tk-chart-body">
    <div class="tk-chart-y" style="height:${H}px">${ylab}</div>
    <div class="tk-chart-plot" style="height:${H}px" tabindex="0" role="img" aria-label="${esc(o.label||'Chart')}. Use the arrow keys to read each day." data-n="${n}" data-tips="${esc(JSON.stringify(o.tips||[]))}" onpointermove="tkChartTip(event,this)" onpointerdown="tkChartTip(event,this)" onpointerleave="tkChartTipHide(this)" onfocus="tkChartTipAt(this,${n-1})" onblur="tkChartTipHide(this)" onkeydown="tkChartKey(event,this)">
      <svg viewBox="0 0 ${TK_W} ${H}" preserveAspectRatio="none" aria-hidden="true">${parts.join('')}</svg>${pts.join('')}${refLabels}<div class="tk-cursor"></div><div class="tk-tip"></div>
    </div>
    <div></div><div class="tk-chart-x">${xi.map(i=>`<span>${esc(tkDayShort(days[i]))}</span>`).join('')}</div>
  </div></figure>`;
}
/* The same numbers as a table — tooltips never gate a value. Newest day first. */
function renderChartTable(days,cols){
  const rows=days.map((d,i)=>`<tr><td class="num">${esc(tkDayName(d))}</td>${cols.map(c=>{const v=c.values[i];return `<td class="num">${v==null?'<span class="tk-muted">—</span>':esc((c.fmt||tkNum)(v))}</td>`}).join('')}</tr>`).reverse().join('');
  return `<details class="tk-tv"><summary>Show the numbers</summary><div class="tk-scroll"><table class="tk-table"><tr><th>Day</th>${cols.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr>${rows}</table></div></details>`;
}
/* Tiny chart for tiles and board cards: no text inside, null = gap, 0 = a thin tick. */
function renderSpark(values,o){
  o=o||{};values=values||[];const n=values.length;if(!n||!tkHasAny(values))return '';
  const W=140,H=32;const slot=W/n;const color=o.color||'--c1';
  const max=o.percent?1:Math.max(1,...values.filter(v=>v!=null));const min=o.min!=null?o.min:0;
  const Y=v=>H-1-((Math.max(min,Math.min(v,max))-min)/(max-min))*(H-2);const f=v=>v.toFixed(1);
  let body='',pts='';
  if(o.kind==='line'){
    if(o.ref!=null)body+=`<line x1="0" x2="${W}" y1="${f(Y(o.ref))}" y2="${f(Y(o.ref))}" class="tk-refline" vector-effect="non-scaling-stroke"/>`;
    tkSegments(values).forEach(seg=>{if(seg.length===1){pts+=`<i class="tk-pt tk-pt-s" style="left:${((seg[0][0]+.5)/n*100).toFixed(3)}%;top:${(Y(seg[0][1])/H*100).toFixed(3)}%;background:var(${color})"></i>`;return;}body+=`<path d="${seg.map(([i,v],k)=>(k?'L':'M')+f((i+.5)*slot)+' '+f(Y(v))).join('')}" class="tk-line" style="stroke:var(${color})" vector-effect="non-scaling-stroke"/>`;});
  }else{
    const bw=Math.max(1,slot*0.7);
    values.forEach((v,i)=>{if(v==null)return;const x=i*slot+(slot-bw)/2;body+=v>0?`<rect x="${f(x)}" y="${f(Y(v))}" width="${f(bw)}" height="${f(H-1-Y(v))}" style="fill:var(${color})"/>`:`<rect x="${f(x)}" y="${H-2}" width="${f(bw)}" height="1.5" class="tk-zero"/>`;});
  }
  return `<span class="tk-spark" role="img" aria-label="${esc(o.label||'Last 14 days')}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${body}</svg>${pts}</span>`;
}
function tkEmptyChart(msg){return `<div class="card tk-chart-empty">${esc(msg)}</div>`}

/* ===================== 5. PURE RENDERERS (data → HTML) ===================== */
function renderLoading(msg){return `<div class="card tk-loading">${esc(msg||'Reaching the machine…')}</div>`}
function renderMachineError(reason,retryFn){
  return `<div class="card tk-err"><b>The machine isn't reachable from the hub yet</b><p>${esc(reason||'No answer.')}</p>
    <div class="tk-inline"><button class="btn" onclick="${esc(retryFn||'trialsRetry()')}">Try again</button><span class="tk-updated">Machine · ${esc(tkMachineUrl())}</span></div></div>`;
}
function tkUpdatedStamp(at){return at?`<span class="tk-updated" title="${esc(tkFull(new Date(at)))}">Updated ${esc(tkRel(new Date(at)))}</span>`:''}
/* Shown above cached data when the latest refresh failed — the screen stays useful, but says so. */
function renderStaleNote(err,at){if(!err)return '';return `<div class="tk-note red">Couldn't refresh from the machine — showing what it said ${esc(at?tkRel(new Date(at)):'earlier')}. ${esc(err)} <span class="tk-linkish" onclick="trialsRetry()">Try again</span></div>`}
function renderStatTiles(pairs){return `<div class="tk-stats">${pairs.map(([l,v])=>`<div class="card tk-stat-tile"><small>${esc(l)}</small><b>${v}</b></div>`).join('')}</div>`}

/* -- machine bar -- */
function renderMachineBar(machine,meta){
  machine=machine||{};meta=meta||{};const hb=machine.heartbeat||{};const u=machine.usage||{};
  const hbClass=tkHeartbeatClass(hb);
  const hbText=hb.lastTickAt?tkRel(hb.lastTickAt,meta.now):(hb.ageSec!=null?Math.round(hb.ageSec)+' s ago':'never');
  const usage=[];
  if(u.redis)usage.push('Redis '+tkPct(u.redis.pct));
  if(u.places)usage.push('Places '+tkPct(u.places.pct));
  if(u.reoon)usage.push('Reoon '+(u.reoon.remaining!=null?tkNum(u.reoon.remaining)+' left':tkPct(u.reoon.pct)));
  const setup=machine.setup||{};const missing=Object.keys(TK_SETUP_NAMES).filter(k=>setup[k]===false).map(k=>TK_SETUP_NAMES[k]);
  const notOk=machine.ok===false?`<div class="tk-setupline tk-red">The machine reports it is not OK${machine.error?' — '+esc(machine.error):''}.</div>`:'';
  return `<div class="card tk-bar">
    <div class="tk-stat">${tkDot(hbClass)}<div><small>Heartbeat</small><b>${esc(hbText)}${hb.source?` <span>· ${esc(hb.source)}</span>`:''}</b></div></div>
    <div class="tk-stat"><div><small>Last send</small><b>${esc(hb.lastSendAt?tkRel(hb.lastSendAt,meta.now):'—')}</b></div></div>
    <div class="tk-stat"><div><small>Active trials</small><b>${tkNum(machine.activeTrials)} <span>/ ${tkNum(machine.maxActiveTrials)}</span></b></div></div>
    <div class="tk-stat"><div><small>Extensions</small><b>${tkNum(machine.extensions)}</b></div></div>
    <div class="tk-stat"><div><small>Open alerts</small><b${Number(machine.openAlerts)>0?' class="tk-red"':''}>${tkNum(machine.openAlerts)}</b></div></div>
    <div class="tk-stat tk-stat-wide"><div><small>Usage</small><b>${usage.length?esc(usage.join(' · ')):'—'}</b></div></div>
    <div class="tk-right">${tkUpdatedStamp(meta.at)}<button class="btn ghost" onclick="trialsRefresh()">Refresh</button><button class="btn ghost" onclick="openMachine('/mc')">Mission Control ↗</button></div>
    ${missing.length?`<div class="tk-setupline">Machine setup: still to set — ${esc(missing.join(', '))}. <span class="tk-linkish" onclick="openMachine('/mc/config')">Open config</span></div>`:''}
    ${notOk}
  </div>`;
}

/* -- to-dos -- */
/* On the trial's own page, an "Open trial" button would go nowhere — leave it off. */
function tkTodoIsSelf(t){const a=(t&&t.action)||{};return a.type==='view'&&(!a.view||a.view==='detail')&&!a.section}
function renderTodoButton(t){const label=tkTodoLabel(t);if(!label)return '';const a=t.action||{};const cls=a.type==='api'||(a.type==='view'&&a.view==='purchase')?'btn':'btn ghost';return `<button class="${cls}" onclick="trialsTodoAction(${tkAttr(t.id)})">${esc(label)}</button>`}
function renderTodos(todos,opts){
  opts=opts||{};todos=(todos||[]).slice().sort((a,b)=>(b.urgent?1:0)-(a.urgent?1:0));
  const title=opts.title||'What you need to do';
  const body=todos.length?todos.map(t=>{
    const client=!opts.hideClient&&(t.clientName||t.clientId)?`<span class="tk-client" onclick="openTrial(${tkAttr(t.clientId)})">${esc(t.clientName||t.clientId)}</span> · `:'';
    return `<div class="tk-todo ${t.urgent?'urgent':''}">
      ${t.urgent?'<span class="pill red">Urgent</span>':tkDot('grey')}
      <div class="tk-todo-main"><b>${esc(t.text||'')}</b><small>${client}${t.detail?esc(t.detail)+' · ':''}<span class="tk-since" title="Due since ${esc(tkFull(t.since))}">${esc(tkRel(t.since,opts.now))}</span></small></div>
      <div class="tk-todo-act">${opts.hideClient&&tkTodoIsSelf(t)?'':renderTodoButton(t)}</div>
    </div>`}).join(''):`<div class="tk-todo-empty">${esc(opts.empty||'Nothing waiting on you.')}</div>`;
  return `<div class="section-head tk-section"><h3>${esc(title)}</h3><span class="count">${todos.length}</span></div><div class="card tk-todos">${body}</div>`;
}

/* -- board -- */
function renderFive(five){five=five||null;return `<div class="tk-five">${TK_FIVE.map(([k,l,full])=>`<div title="${esc(full)}"><b>${tkNum(five?five[k]:null)}</b><small>${esc(l)}</small></div>`).join('')}</div>`}
/* Board card: emails sent per day and the warm-up inbox rate, last 14 days — two tiny charts, one scale each. */
function renderCardSpark(g){
  if(!g)return '';
  const sm=tkSendingModel(g),wm=tkWarmupModel(g);
  if(!sm.any&&!wm.any)return '<div class="tk-card-spark-empty">Nothing sent or warmed in the last 14 days</div>';
  return `<div class="tk-card-spark">
    <div><small>Sent · 14 days</small><b>${tkNum(sm.totals.sent)}</b>${(sm.any&&renderSpark(sm.sent,{label:'Emails sent per day, last 14 days'}))||'<span class="tk-spark-none">Not sending yet</span>'}</div>
    <div><small>Inbox rate</small><b>${tkRate(wm.lastRate)}</b>${renderSpark(wm.rate,{kind:'line',percent:true,min:.5,ref:.9,label:'Warm-up inbox rate, last 14 days (50–100%)'})||'<span class="tk-spark-none">No warm-up yet</span>'}</div>
  </div>`;
}
function renderTrialCard(row,spark){
  row=row||{};const todo=(row.todo||[])[0];const alerts=Number(row.openAlerts)||0;const urgent=Number(row.urgentAlerts)||0;const review=tkIsUnderReview(row);
  const sparkable=!TK_PRE_WARMUP.includes(row.state);
  return `<div class="tk-card${review?' review':''}" onclick="${review?`openTrial(${tkAttr(row.id)},null,'application')`:`openTrial(${tkAttr(row.id)})`}">
    <div class="tk-card-top"><b>${esc(row.name||row.id||'—')}</b>${tkDot(tkHealthClass(row.health))}</div>
    <span class="tk-state">${esc(tkStateLabel(row))}</span>${review?'<span class="tk-new">New application</span>':''}
    ${renderFive(row.five)}
    ${sparkable?`<div class="tk-card-spark-host" id="${tkDomId('tkSpark-',row.id)}">${renderCardSpark(spark)}</div>`:''}
    ${alerts?`<div class="tk-card-meta"><span class="pill ${urgent?'red':'amber'}">${alerts} open alert${alerts!==1?'s':''}</span></div>`:''}
    ${todo?`<div class="tk-card-todo ${todo.urgent?'urgent':''}">${todo.urgent?'! ':'→ '}${esc(todo.text||'')}</div>`:''}
    ${row.nextUp&&row.nextUp.what?`<div class="tk-card-next">Next · ${esc(tkDate(row.nextUp.date))} · ${esc(row.nextUp.what)}</div>`:''}
  </div>`;
}
function renderStages(stages,sparks){
  sparks=sparks||{};
  const cols=tkSortedStages(stages).filter(s=>s.key!=='ended'||(s.clients&&s.clients.length));
  if(!cols.length)return '';
  return `<div class="tk-board">${cols.map(s=>`<div class="tk-col"><div class="tk-col-head"><b>${esc(s.label||s.key)}</b><span class="ct">${(s.clients||[]).length}</span></div>${(s.clients||[]).length?(s.clients||[]).map(r=>renderTrialCard(r,sparks[r.id])).join(''):'<div class="tk-empty-col">—</div>'}</div>`).join('')}</div>`;
}
function renderQueue(queue){
  queue=queue||[];if(!queue.length)return '';
  return `<div class="section-head tk-section"><h3>Queue</h3><span class="count">${queue.length}</span></div>
  <div class="tk-grid">${queue.map(q=>`<div class="card tk-mini"><b>${esc(q.position!=null?'#'+q.position+' · ':'')}${esc(q.name||q.id)}</b><small>Expected ${esc(tkDate(q.expectedDate))}${q.contactEmail?' · '+esc(q.contactEmail):''}</small>
    <div class="tk-acts"><button class="btn" onclick="trialsQueueAction(${tkAttr(q.id)},'promote')">Promote</button><button class="btn ghost" onclick="trialsQueueAction(${tkAttr(q.id)},'decline')">Decline</button></div></div>`).join('')}</div>`;
}
function renderOthers(others,sparks){
  others=others||[];sparks=sparks||{};if(!others.length)return '';
  return `<div class="section-head tk-section"><h3>Also on the machine</h3><span class="count">${others.length}</span></div>
  <div class="tk-grid">${others.map(r=>`<div class="card tk-mini click" onclick="openTrial(${tkAttr(r.id)})"><div class="tk-card-top"><b>${esc(r.name||r.id)}</b>${tkDot(tkHealthClass(r.health))}</div><small>${esc(tkStateLabel(r))}</small>${renderFive(r.five)}<div class="tk-card-spark-host" id="${tkDomId('tkSpark-',r.id)}">${renderCardSpark(sparks[r.id])}</div></div>`).join('')}</div>`;
}
function renderBoard(hub,meta){
  hub=hub||{};meta=meta||{};const machine=hub.machine||{};
  const rows=tkAllRows({stages:hub.stages});
  const toolbar=`<div class="toolbar"><span class="muted tk-small">${rows.length} trial${rows.length!==1?'s':''} on the machine · ${(hub.todos||[]).length} thing${(hub.todos||[]).length!==1?'s':''} waiting on you</span>
    <div style="margin-left:auto" class="tk-inline"><button class="btn ghost" onclick="render('trialAlerts')">${I.bell||''}Machine alerts${machine.openAlerts?` · ${tkNum(machine.openAlerts)}`:''}</button><button class="btn" onclick="openNewTrialClient()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14"/></svg>New client</button></div></div>`;
  const board=rows.length?renderStages(hub.stages,meta.sparks):emptyState(I.trials||'','No trials yet','Add the first client — the machine takes it from application to booked calls, and tells you here whenever it needs you.','New client','openNewTrialClient()');
  return toolbar+renderMachineBar(machine,{at:meta.at,now:meta.now})+renderTodos(hub.todos,{now:meta.now})+
    `<div class="section-head tk-section"><h3>Stages</h3><span class="count">${rows.length}</span></div>`+board+renderQueue(machine.queue)+renderOthers(machine.others,meta.sparks);
}

/* -- trial detail: header + tabs -- */
function tkTabsFor(d){const app=d&&d.application;return app&&app.review!=='pending'?TK_TABS.concat([['application','Application']]):TK_TABS}
function renderTabBar(active,d){return `<div class="tk-tabs" id="tkTabBar" role="tablist"><div class="seg">${tkTabsFor(d).map(([k,l])=>`<button role="tab" aria-selected="${k===active}" class="${k===active?'active':''}" onclick="trialsSetTab(${tkAttr(k)})">${esc(l)}</button>`).join('')}</div></div>`}
function renderTrialHeader(d,meta){
  const row=d.row||{};const id=row.id;const reasons=(row.healthReasons||[]).filter(Boolean);
  const canBuy=['awaiting_purchase','setup_check'].includes(row.state);
  return `<div class="card tk-head">
    <div class="tk-head-main">
      <h2>${tkDot(tkHealthClass(row.health))}${esc(row.name||id||'—')}</h2>
      <div class="tk-pills"><span class="pill grey">${esc(tkStateLabel(row))}</span>${row.trialDay!=null?`<span class="pill blue">Day ${esc(row.trialDay)}</span>`:''}${row.plan&&row.plan!=='trial'?`<span class="pill grey">${esc(row.plan)} plan</span>`:''}${Number(row.openAlerts)?`<span class="pill ${Number(row.urgentAlerts)?'red':'amber'}">${tkNum(row.openAlerts)} open alert${Number(row.openAlerts)!==1?'s':''}</span>`:''}</div>
      ${reasons.length?`<div class="tk-reasons">${reasons.map(r=>esc(r)).join(' · ')}</div>`:''}
      <div class="tk-meta">${esc(row.contactName||'—')}${row.contactEmail?` · <a href="mailto:${esc(row.contactEmail)}">${esc(row.contactEmail)}</a>`:''}${row.website?` · ${tkLink(row.website)}`:''}</div>
      <div class="tk-dates"><div><small>Day 1</small><b>${esc(tkDate(row.day1Date))}</b></div><div><small>Day 30</small><b>${esc(tkDate(row.day30Date))}</b></div>${row.nextUp&&row.nextUp.what?`<div><small>Next</small><b>${esc(tkDate(row.nextUp.date))} · ${esc(row.nextUp.what)}</b></div>`:''}</div>
    </div>
    <div class="tk-btns"><button class="btn ghost" onclick="render('trials')">← Board</button><button class="btn ghost" onclick="trialsRefresh()">Refresh</button>${canBuy?`<button class="btn" onclick="openTrialPurchase(${tkAttr(id)})">Buy & paste</button>`:''}<button class="btn ghost" onclick="openMachine(${tkAttr('/mc/clients/'+id)})">Mission Control ↗</button></div>
    ${meta&&meta.at?`<div class="tk-head-stamp">${tkUpdatedStamp(meta.at)}</div>`:''}
  </div>`;
}

/* -- Overview: what to do, the 13 systems at a glance, four growth numbers -- */
function renderSystemsStrip(systems){
  const list=tkSortedSystems(systems);if(!list.length)return '<div class="card"><div class="tk-todo-empty">No system cards yet.</div></div>';
  const words={ok:'OK',working:'Working',waiting:'Waiting',blocked:'Blocked',off:'Off'};
  return `<div class="tk-strip">${list.map(s=>{const st=String(s.status||'off').toLowerCase();return `<button class="tk-strip-item ${esc(words[st]?st:'off')}" onclick="trialsSetTab('systems')" title="${esc(s.line||'')}"><b>${esc(s.label||s.key)}</b><small>${esc(words[st]||st)}</small></button>`}).join('')}</div>`;
}
function tkSystemsSummary(systems){const c={ok:0,working:0,waiting:0,blocked:0,off:0};(systems||[]).forEach(s=>{const k=String(s.status||'off').toLowerCase();if(c[k]!=null)c[k]++;});
  return [c.blocked?c.blocked+' blocked':'',c.waiting?c.waiting+' waiting':'',c.working?c.working+' working':'',c.ok?c.ok+' done':'',c.off?c.off+' not started':''].filter(Boolean).join(' · ')}
/* ov = {g: 14-day growth or null, state: 'loading'|'error'|'pre'|null} */
function renderKeyNumbers(row,ov){
  row=row||{};ov=ov||{};const five=row.five||{};const g=ov.g||null;
  const sm=g?tkSendingModel(g):null,wm=g?tkWarmupModel(g):null;
  const none=ov.state==='loading'?'Loading the last 14 days…':ov.state==='error'?'History not available right now':ov.state==='pre'?'Starts once warm-up begins':'Nothing yet';
  const spark=(vals,o)=>(vals&&renderSpark(vals,o))||`<span class="tk-spark-none">${esc(none)}</span>`;
  const sendSpark=(vals,o)=>sm&&!sm.any?`<span class="tk-spark-none">Starts on Day 1</span>`:spark(vals,o);
  const last7=a=>a?tkSum(a.slice(-7)):null;
  const tiles=[
    ['Emails sent',tkNum(five.sent),sm&&sm.any&&last7(sm.sent)!=null?tkNum(last7(sm.sent))+' in the last 7 days':'',sendSpark(sm&&sm.sent,{label:'Emails sent per day'})],
    ['Replies',tkNum(five.replies),five.positive!=null?tkNum(five.positive)+' positive':'',sendSpark(sm&&sm.replies,{label:'Replies per day'})],
    ['Calls booked',tkNum(five.booked),five.qualified!=null?tkNum(five.qualified)+' qualified':'',sendSpark(sm&&sm.booked,{label:'Calls booked per day'})],
    ['Warm-up inbox rate',tkRate(row.inboxRate!=null?row.inboxRate:(wm&&wm.lastRate)),'Ready at 90% · low under 80%',spark(wm&&wm.rate,{kind:'line',percent:true,min:.5,ref:.9,label:'Warm-up inbox rate, 50–100%'})],
  ];
  return `<div class="tk-keys">${tiles.map(([l,v,sub,sp])=>`<button class="card tk-key" onclick="trialsSetTab('growth')"><small>${esc(l)}</small><b>${v}</b><span class="tk-key-sub">${esc(sub)}</span>${sp}</button>`).join('')}</div>`;
}
function renderOverviewTab(d,ctx){
  const row=d.row||{};ctx=ctx||{};
  return renderTodos(row.todo||[],{hideClient:true,now:ctx.now,empty:'Nothing waiting on you for this client.'})+
    `<div class="section-head tk-section"><h3>Systems</h3><span class="tk-muted tk-small">${esc(tkSystemsSummary(row.systems))}</span><div class="spacer"></div><button class="btn ghost" onclick="trialsSetTab('systems')">Details</button></div>`+renderSystemsStrip(row.systems)+
    `<div class="section-head tk-section"><h3>Growth</h3><span class="tk-muted tk-small">Last 14 days</span><div class="spacer"></div><button class="btn ghost" onclick="trialsSetTab('growth')">See the charts</button></div>`+renderKeyNumbers(row,ctx.spark);
}
function renderSystems(systems){
  const list=tkSortedSystems(systems);
  if(!list.length)return '<div class="card"><div class="tk-todo-empty">No system cards yet.</div></div>';
  return `<div class="tk-sys">${list.map(s=>{const st=String(s.status||'off').toLowerCase();const det=Array.isArray(s.detail)?s.detail:(s.detail?[s.detail]:[]);
    return `<div class="card tk-sys-card ${esc(st)}"><div class="tk-sys-top"><b>${esc(s.label||s.key)}</b>${tkStatusPill(st)}</div>${s.line?`<div class="tk-sys-line">${esc(s.line)}</div>`:''}${det.length?`<ul class="tk-sys-detail">${det.map(x=>`<li>${esc(tkDetailText(x))}</li>`).join('')}</ul>`:''}</div>`}).join('')}</div>`;
}

/* -- Growth tab: every system's progress over time -- */
function renderSendingGrowth(m,row){
  if(!m.any)return tkEmptyChart('No sending yet — starts on Day 1'+(row&&row.day1Date?' ('+tkDate(row.day1Date)+')':'')+'.');
  const tips=m.days.map((d,i)=>m.sent[i]==null?tkTip(d,[],'Nothing recorded'):tkTip(d,[[tkNum(m.sent[i]),'emails sent',null],[tkNum(m.first[i]),'first emails','--c1'],[tkNum(m.follow[i]),'follow-ups','--c2'],[tkNum(m.replies[i]),'replies',null],[tkNum(m.positive[i]),'positive replies',null],[tkNum(m.booked[i]),'calls booked',null]],'So far in this range: '+tkNum(m.running.sent[i])+' sent · '+tkNum(m.running.replies[i])+' replies · '+tkNum(m.running.booked[i])+' booked'));
  const t=m.totals;
  const small=(label,vals,total)=>`<div class="tk-sm-row"><div class="tk-sm-head"><b>${esc(label)}</b><span>${tkNum(total)} in this range</span></div>${renderChart({days:m.days,height:64,bars:[{label,color:'--c3',values:vals}],tips,label:label+' per day'})}</div>`;
  return renderStatTiles([['Emails sent',tkNum(t.sent)],['First emails',tkNum(t.first)],['Follow-ups',tkNum(t.follow)],['Replies',tkNum(t.replies)],['Positive replies',tkNum(t.positive)],['Calls booked',tkNum(t.booked)]])+
    `<div class="card tk-chart-card"><h4>Emails sent per day</h4>${renderChart({days:m.days,height:180,bars:[{label:'First emails',color:'--c1',values:m.first},{label:'Follow-ups',color:'--c2',values:m.follow}],tips,label:'Emails sent per day'})}
      <p class="tk-help">Same days below, each on its own scale:</p>
      ${small('Replies',m.replies,t.replies)}${small('Positive replies',m.positive,t.positive)}${small('Calls booked',m.booked,t.booked)}
      ${renderChartTable(m.days,[{label:'Sent',values:m.sent},{label:'First',values:m.first},{label:'Follow-ups',values:m.follow},{label:'Replies',values:m.replies},{label:'Positive',values:m.positive},{label:'Booked',values:m.booked}])}
    </div>`;
}
function renderWarmupGrowth(m){
  if(!m.any)return tkEmptyChart('No warm-up yet — it starts once the setup check passes.');
  const tips=m.days.map((d,i)=>m.sent[i]==null&&m.rate[i]==null?tkTip(d,[],'Nothing recorded'):tkTip(d,[[tkNum(m.sent[i]),'warm-up emails sent','--c3'],[tkNum(m.inbox[i]),'landed in the inbox','--c1'],[tkNum(m.spam[i]),'landed in spam','--c2'],[tkRate(m.rate[i]),'inbox rate (7 days)',null]]));
  return renderStatTiles([['Warm-up emails sent',tkNum(m.totals.sent)],['Landed in the inbox',tkNum(m.totals.inbox)],['Landed in spam',tkNum(m.totals.spam)],['Inbox rate now',tkRate(m.lastRate)]])+
    `<div class="card tk-chart-card"><h4>Warm-up emails per day</h4>${renderChart({days:m.days,height:160,bars:[{label:'Landed in the inbox',color:'--c1',values:m.inbox},{label:'Landed in spam',color:'--c2',values:m.spam}],lines:[{label:'Sent',color:'--c3',values:m.sent}],tips,label:'Warm-up emails per day'})}
      <h4>Inbox rate, rolling 7 days</h4>${renderChart({days:m.days,height:150,percent:true,lines:[{label:'Inbox rate',color:'--c1',values:m.rate}],refs:[{value:.9,label:'Ready · 90%'},{value:.8,label:'Low · 80%'}],tips,label:'Warm-up inbox rate'})}
      ${renderChartTable(m.days,[{label:'Sent',values:m.sent},{label:'Inbox',values:m.inbox},{label:'Spam',values:m.spam},{label:'Inbox rate',values:m.rate,fmt:tkRate}])}
    </div>`;
}
function renderInboxGrowth(g){
  const list=(g&&g.inboxes)||[];if(!list.length)return tkEmptyChart('No inboxes yet — they appear after you paste the logins.');
  const days=g.days||[];
  return `<div class="tk-multi">${list.map(ib=>{const rate=days.map((_,i)=>tkNorm((ib.rate||[])[i]));const sent=days.map((_,i)=>tkNorm((ib.sent||[])[i]));
    const tips=days.map((d,i)=>rate[i]==null&&sent[i]==null?tkTip(d,[],'Nothing recorded'):tkTip(d,[[tkRate(rate[i]),'inbox rate (7 days)','--c1'],[tkNum(sent[i]),'warm-up emails sent',null]]));
    return `<div class="card tk-mini-chart"><b class="tk-break">${esc(ib.email||'—')}</b>
      <div class="tk-mini-facts"><span>Inbox rate now <b>${tkRate(tkLast(rate))}</b></span><span>Cap today <b>${ib.dailyCap!=null?tkNum(ib.dailyCap)+' a day':'not set'}</b></span>${ib.warmupStartedAt?`<span>Warming since <b>${esc(tkDate(ib.warmupStartedAt))}</b></span>`:''}</div>
      ${tkHasAny(rate)?renderChart({days,height:90,percent:true,lines:[{label:'Inbox rate',color:'--c1',values:rate}],refs:[{value:.9,label:''},{value:.8,label:''}],tips,label:'Inbox rate for '+(ib.email||'inbox')}):'<div class="tk-spark-none">No warm-up results yet</div>'}
    </div>`}).join('')}</div><p class="tk-help">Dashed lines: 90% is ready to send, under 80% is low.</p>`;
}
function renderPlacementGrowth(g){
  const m=tkPlacementModel(g);if(!m.anySeed&&!m.anyMt&&!m.anySa)return tkEmptyChart('No placement tests yet — the first run a few days before Day 1.');
  const tips=m.days.map((d,i)=>{const ts=m.tests[i];if(!ts.length)return tkTip(d,[],'No test this day');
    const rows=[];
    ts.forEach(p=>{const tool=String(p.tool||'seed').toLowerCase();
      if(tool==='seed'){rows.push([tkRate(p.inboxRate),'seed test: landed in the inbox'+(p.min!=null?' (worst provider '+tkRate(p.min)+')':''),'--c1']);return;}
      const v=tkSpamVerdict(p);rows.push([v.value,tkToolName(tool)+': '+v.text.replace(/^[^—]*— /,''),v.level==='pass'?'--green':v.level==='high'?'--amber':'--red']);
      Object.keys(p.perInbox||{}).forEach(ib=>{const x=p.perInbox[ib];rows.push([x==null?'—':tkNorm(p.score)!=null?x+'/10':x+' pts','  '+ib,null]);});});
    return tkTip(d,rows);});
  const saMax=Math.max(10,tkNiceMax(Math.max(0,...Object.values(m.sa).flat().filter(v=>v!=null))));
  return `<div class="card tk-chart-card">
    ${m.anySeed?`<h4>Seed test — share that landed in the inbox</h4>${renderChart({days:m.days,height:130,percent:true,dots:[{label:'Seed test',color:'--c1',values:m.seed}],refs:[{value:TK_RULES.seedGate,label:'Needed for Day 1 · '+Math.round(TK_RULES.seedGate*100)+'%'}],tips,label:'Seed placement tests'})}`:''}
    ${m.anySa?`<h4>Spam test — SpamAssassin points (lower is better)</h4>${renderChart({days:m.days,height:130,max:saMax,fmt:v=>tkNum(v),dots:[{label:'Passes',color:'--green',values:m.sa.pass},{label:'Too high for Day 1',color:'--amber',values:m.sa.high},{label:'Marked as spam',color:'--red',values:m.sa.spam}].filter(x=>tkHasAny(x.values)),refs:[{value:TK_RULES.maxSpamAssassin,label:'Day 1 needs '+TK_RULES.maxSpamAssassin+' or less'},{value:TK_RULES.spamLine,label:'5+ = spam'}],tips,label:'SpamAssassin points from DKIM Validator'})}`:''}
    ${m.anyMt?`<h4>Spam test — mail-tester score (out of 10, higher is better)</h4>${renderChart({days:m.days,height:110,max:10,fmt:v=>tkNum(v),dots:[{label:'Passes',color:'--green',values:m.mt.pass},{label:'Too low for Day 1',color:'--red',values:m.mt.fail}].filter(x=>tkHasAny(x.values)),refs:[{value:TK_RULES.minScore,label:'Day 1 needs '+TK_RULES.minScore+'+'}],tips,label:'mail-tester scores'})}`:''}
    <p class="tk-help">Day 1 needs every inbox's latest spam test to pass, and the seed test at ${Math.round(TK_RULES.seedGate*100)}% or more.</p>
    ${renderChartTable(m.days,[{label:'Seed inbox rate',values:m.seed,fmt:tkRate},{label:'SpamAssassin points',values:m.days.map((_,i)=>m.sa.pass[i]??m.sa.high[i]??m.sa.spam[i])},{label:'mail-tester /10',values:m.days.map((_,i)=>m.mt.pass[i]??m.mt.fail[i])}])}
  </div>`;
}
/* st = {g, days, loading, error, at} */
function renderGrowthTab(d,st){
  st=st||{};const row=(d&&d.row)||{};const days=st.days||45;
  const bar=`<div class="toolbar tk-range"><div class="seg" role="group" aria-label="Range">${TK_GROWTH_RANGES.map(n=>`<button class="${n===days?'active':''}" onclick="trialsGrowthRange(${n})">${n} days</button>`).join('')}</div><div style="margin-left:auto" class="tk-inline">${st.loading?'<span class="tk-updated">Loading…</span>':tkUpdatedStamp(st.at)}<button class="btn ghost" onclick="trialsGrowthReload()">Reload</button></div></div>`;
  if(!st.g){
    if(st.error)return bar+`<div class="card tk-err"><b>Couldn't load the growth history</b><p>${esc(st.error)}</p><div class="tk-inline"><button class="btn" onclick="trialsGrowthReload()">Try again</button></div></div>`;
    return bar+renderLoading('Loading the growth history…');
  }
  const g=st.g;const c=d.counters||{};const seen=new Set(TK_COUNTERS.map(x=>x[0]));
  const tiles=TK_COUNTERS.map(([k,l])=>[l,tkNum(c[k])]);Object.keys(c).filter(k=>!seen.has(k)).forEach(k=>tiles.push([k,tkNum(c[k])]));
  const pace=d.pacelog||[];
  return bar+(st.error?`<div class="tk-note red">Couldn't reload — showing the last history. ${esc(st.error)}</div>`:'')+
    `<div class="tk-growth${st.loading?' tk-dim':''}">
      <div class="section-head tk-section"><h3>Sending</h3></div>${renderSendingGrowth(tkSendingModel(g),row)}
      <div class="section-head tk-section"><h3>Warm-up</h3></div>${renderWarmupGrowth(tkWarmupModel(g))}
      <div class="section-head tk-section"><h3>Each inbox</h3><span class="count">${(g.inboxes||[]).length}</span></div>${renderInboxGrowth(g)}
      <div class="section-head tk-section"><h3>Placement tests</h3></div>${renderPlacementGrowth(g)}
      ${Object.keys(c).length?`<div class="section-head tk-section"><h3>All-time counters</h3></div>${renderStatTiles(tiles)}`:''}
      ${pace.length?`<div class="section-head tk-section"><h3>Pace checks</h3><span class="count">${pace.length}</span></div><div class="card tk-scroll"><table class="tk-table"><tr><th>When</th><th>Day</th><th>Test</th><th>Fix</th></tr>${pace.map(p=>`<tr><td class="num">${esc(tkDateTime(p.at))}</td><td class="num">${esc(p.day!=null?p.day:'—')}</td><td class="wrap">${esc(p.test||'')}</td><td class="wrap">${esc(p.fix||'')}</td></tr>`).join('')}</table></div>`:''}
    </div>`;
}

/* -- Leads tab: lead quality -- */
function tkGradePill(gr){gr=String(gr||'').toUpperCase();const m={A:'green',B:'blue',C:'amber',REJECTED:'red'}[gr]||'grey';return `<span class="pill ${m}">${esc(gr==='REJECTED'?'Rejected':gr||'—')}</span>`}
function renderLeadsTab(d){
  const lq=d.leadQuality||null;const lbs=d.leadsByStatus||{};const lst=Object.keys(lbs);const lf=d.leadfinder||null;
  const pipeline=`<div class="section-head tk-section"><h3>Lead list</h3></div><div class="card tk-pad"><div class="tk-pills">${lst.length?lst.map(k=>`<span class="pill grey">${esc(k.replace(/_/g,' '))} · ${tkNum(lbs[k])}</span>`).join(''):'<span class="tk-muted">No leads loaded yet.</span>'}</div>${lf?`<p class="tk-help">Lead Finder · ${esc(lf.status||'—')} · found ${tkNum(lf.found)} of ${tkNum(lf.need)} needed${lf.lastRunAt?' · last run '+esc(tkRel(lf.lastRunAt)):''}</p>`:''}</div>`;
  if(!lq)return `<div class="card tk-chart-empty">No leads yet — grading starts when the Lead Finder brings in the first list.</div>`+pipeline;
  const gr=lq.grades||{};const order=[['A','--g-a'],['B','--g-b'],['C','--g-c'],['rejected','--c-none']];
  const total=order.reduce((s,[k])=>s+(Number(gr[k])||0),0)||Number(lq.graded)||0;
  const bar=total?`<div class="tk-gradebar" role="img" aria-label="${esc(order.map(([k])=>k+' '+(gr[k]||0)).join(', '))}">${order.filter(([k])=>Number(gr[k])>0).map(([k,c])=>`<span style="flex:${Number(gr[k])};background:var(${c})" title="${esc(k)}: ${tkNum(gr[k])}"></span>`).join('')}</div>`:'';
  const legend=`<div class="tk-legend">${order.map(([k,c])=>`<span><i class="tk-key-bar" style="background:var(${c})"></i>${esc(k==='rejected'?'Rejected':'Grade '+k)} · ${tkNum(gr[k]!=null?gr[k]:0)}</span>`).join('')}</div>`;
  const v=lq.verification||{};const vk=[['valid','green','Valid'],['risky','amber','Risky'],['catchall','amber','Catch-all'],['invalid','red','Invalid'],['unknown','grey','Unknown'],['pending','grey','Waiting to check']];
  const reasons=(lq.rejectReasons||[]).slice(0,8);const rmax=Math.max(1,...reasons.map(r=>Number(r.count)||0));
  const sources=lq.sources||[];const sample=(lq.sample||[]).slice(0,25);
  const ready=lq.sendableUnsent!=null?lq.sendableUnsent:lq.sendable;
  return `<div class="card tk-pad"><div class="tk-lead-head"><div><small>Ready to send</small><b>${tkNum(ready)}</b><span class="tk-muted">A and B leads that passed the checks and have not been emailed yet</span></div>${lq.sendableUnsent!=null?`<div><small>Good leads in total</small><b>${tkNum(lq.sendable)}</b><span class="tk-muted">including ones already emailed</span></div>`:''}<div><small>Graded</small><b>${tkNum(lq.graded)}</b>${lq.builtAt?`<span class="tk-muted" title="${esc(tkFull(lq.builtAt))}">Last graded ${esc(tkRel(lq.builtAt))}</span>`:''}</div></div>${legend}${bar}</div>
    <div class="tk-two">
      <div><div class="section-head tk-section"><h3>Email checks</h3></div><div class="card tk-pad"><div class="tk-pills">${vk.map(([k,c,l])=>`<span class="pill ${c}">${esc(l)} · ${tkNum(v[k]!=null?v[k]:0)}</span>`).join('')}</div><p class="tk-help">Checks left today: <b>${tkNum(v.budgetLeftToday)}</b></p></div></div>
      <div><div class="section-head tk-section"><h3>Where leads come from</h3></div><div class="card tk-pad">${sources.length?`<ul class="tk-plain">${sources.map(s=>`<li><span>${esc(s.source||'—')}</span><b>${tkNum(s.count)}</b></li>`).join('')}</ul>`:'<span class="tk-muted">No sources recorded.</span>'}</div></div>
    </div>
    <div class="section-head tk-section"><h3>Top reasons leads were rejected</h3></div>
    <div class="card tk-pad">${reasons.length?reasons.map(r=>`<div class="tk-hbar"><span class="tk-hbar-label">${esc(r.reason||'—')}</span><span class="tk-hbar-track"><i style="width:${(Number(r.count)||0)/rmax*100}%"></i></span><b>${tkNum(r.count)}</b></div>`).join(''):'<span class="tk-muted">No rejections yet.</span>'}</div>
    <div class="section-head tk-section"><h3>Best leads</h3><span class="count">${sample.length}</span></div>
    <div class="card tk-scroll"><table class="tk-table"><tr><th>Lead</th><th>Company</th><th>City</th><th>Grade</th><th>Score</th><th>Why</th></tr>${sample.length?sample.map(s=>`<tr><td class="wrap"><b>${esc(s.name||'—')}</b><div class="tk-muted tk-small">${esc(s.title||'')}</div><div class="tk-small tk-break">${esc(s.email||'')}</div></td><td class="wrap">${esc(s.company||'—')}</td><td>${esc(s.city||'—')}</td><td>${tkGradePill(s.grade)}</td><td class="num">${tkNum(s.score)}</td><td class="wrap tk-small">${(s.reasons||[]).map(esc).join(' · ')}</td></tr>`).join(''):'<tr><td colspan="6" class="tk-muted">No graded leads yet.</td></tr>'}</table></div>`+pipeline;
}

/* -- Deliverability tab (deliverabilityView: warm-up summary, placement list, blacklists, bounce) -- */
function renderBounceMeter(b){
  b=b||{};const pause=tkNorm(b.pauseAt)!=null?Number(b.pauseAt):.015,stop=tkNorm(b.stopAt)!=null?Number(b.stopAt):.02;
  const halved=b.halved===true||b.halved==='1';
  const halvedNote=halved?`<div class="tk-note tk-gap-s">Sending at half speed: bounces passed ${tkPct1(pause)}, so every inbox's daily cap was halved. Full speed comes back after 3 good days in a row.</div>`:'';
  if(tkNorm(b.rate7d)==null)return `<div class="tk-muted">No bounce rate yet — it is measured once sending starts.</div><p class="tk-help">Sending pauses at ${tkPct1(pause)} and stops at ${tkPct1(stop)}.</p>`+halvedNote;
  const rate=Number(b.rate7d);const scale=Math.max(stop*1.5,rate*1.1,.03);const pct=v=>Math.min(100,v/scale*100).toFixed(1);
  const st=rate>stop?['red','Over the stop line — sending stops']:rate>=pause?['amber','Over the pause line — sending slows']:['green','Healthy'];
  return `<div class="tk-meter-head"><b class="tk-big">${tkPct1(rate)}</b><span class="pill ${st[0]}">${esc(st[1])}</span>${halved?'<span class="pill amber">Half speed</span>':''}</div>
    <div class="tk-meter" role="img" aria-label="Bounce rate ${tkPct1(rate)}; slows at ${tkPct1(pause)}, stops over ${tkPct1(stop)}"><i class="tk-meter-fill ${st[0]}" style="width:${pct(rate)}%"></i><i class="tk-meter-mark" style="left:${pct(pause)}%"></i><i class="tk-meter-mark" style="left:${pct(stop)}%"></i></div>
    <p class="tk-help">Bounce rate over the last 7 days${tkNorm(b.sent7d)!=null?` (${tkNum(b.sent7d)} emails sent)`:''}${b.at?`, measured ${esc(tkRel(b.at))}`:''}. At ${tkPct1(pause)} sending slows to half speed; over ${tkPct1(stop)} it stops (the two marks).</p>${halvedNote}`;
}
function renderBlacklists(bl){
  if(!bl)return '<span class="tk-muted">Not checked yet.</span>';
  const listed=Array.isArray(bl.listed)?bl.listed:[],warn=Array.isArray(bl.warnings)?bl.warnings:[],unknown=Array.isArray(bl.unknown)?bl.unknown:[],lists=Array.isArray(bl.lists)?bl.lists:[];
  const status=String(bl.status||(listed.length?'listed':'clean')).toLowerCase();
  const pill=status==='listed'?`<span class="pill red">Listed</span>`:status==='unknown'?`<span class="pill grey">Couldn't check</span>`:'<span class="pill green">Clean</span>';
  const clean=tkNorm(bl.clean);
  return `<div class="tk-meter-head">${pill}<span class="tk-muted tk-small">${bl.checkedAt?'Checked '+esc(tkRel(bl.checkedAt)):''}</span></div>
    ${listed.length?`<p><b>Listed on:</b> ${listed.map(esc).join('; ')}</p>`:''}
    ${status==='unknown'?'<p class="tk-help">No list gave an answer this time — it is checked again tomorrow. Nothing was paused.</p>':clean!=null?`<p class="tk-help">Clean on ${tkNum(clean)} of ${tkNum(lists.length||clean)} lists${lists.length?': '+lists.map(esc).join(', '):''}.</p>`:''}
    ${unknown.length&&status!=='unknown'?`<p class="tk-help">Couldn't check: ${unknown.map(esc).join(', ')} (no answer this time).</p>`:''}
    ${warn.length?`<div class="tk-note tk-gap-s">Warning, nothing paused: ${warn.map(esc).join('; ')}. These are the domain's web-forwarding or mail-server addresses, not the addresses your mail is sent from.</div>`:''}`;
}
/* Day 1 needs each inbox's newest spam test to pass (newest first in the list). */
function tkSpamGate(tests){
  const latest={};(tests||[]).forEach(p=>{if(!p||String(p.tool||'').toLowerCase()==='seed')return;const k=p.inbox||'(inbox)';if(!latest[k])latest[k]=p;});
  const inboxes=Object.keys(latest);if(!inboxes.length)return null;
  const rows=inboxes.map(ib=>({inbox:ib,test:latest[ib],v:tkSpamVerdict(latest[ib])}));
  return {ok:rows.every(r=>r.v.level==='pass'),rows};
}
function renderDeliverabilityTab(d){
  const dv=d.deliverability||null;const dom=d.domain||{};const id=(d.row||{}).id;
  const phase=dom.setupPhase?`<span class="pill ${dom.setupPhase==='passed'?'green':dom.setupPhase==='failed'?'red':'amber'}">${esc(dom.setupPhase)}</span>`:'<span class="pill grey">Not run</span>';
  const dns=`<div class="section-head tk-section"><h3>Domain and DNS</h3></div><div class="card tk-pad"><div class="tk-kv">
      <small>Domain</small><span class="tk-break">${esc(dom.name||((d.shopping||{}).chosenDomain)||'—')}</span>
      <small>Setup check</small><span>${phase}</span>
      <small>DMARC pass, 7 days</small><span>${tkRate(dom.dmarcPassRate7d)}</span>
      ${dom.retiredAt?`<small>Retired</small><span>${esc(tkDateTime(dom.retiredAt))}</span>`:''}
    </div></div><div class="card tk-scroll tk-gap">${renderChecksTable(dom.checks)}</div>
    <div class="tk-inline tk-gap"><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'rerunSetup')">Re-run setup check</button>${((d.shopping||{}).total!=null||['awaiting_purchase','setup_check'].includes((d.row||{}).state))?`<button class="btn ghost" onclick="openTrialPurchase(${tkAttr(id)})">Buy & paste</button>`:''}</div>`;
  if(!dv)return `<div class="tk-note">Warm-up, placement and blacklist details show here once the machine sends them.</div>`+dns;
  const w=dv.warmup||null;const pl=(dv.placement||[]).slice(0,10);
  const prov=w&&w.providers&&typeof w.providers==='object'?Object.keys(w.providers):[];
  const gate=tkSpamGate(pl);const ext=w&&w.external;
  const wkv=w?[['Inboxes in the circle',tkNum(w.pool)],['Helper inboxes',tkNum(w.helpers)],['Trial inboxes',tkNum(w.trialInboxes)],['Aviance inboxes',tkNum(w.avianceInboxes)],['Provider families',tkNum(w.families)],['Pairs today',tkNum(w.todayPairs)]].filter(([,v])=>v!=='—'):[];
  return `<div class="tk-two">
      <div><div class="section-head tk-section"><h3>Bounces</h3></div><div class="card tk-pad">${renderBounceMeter(dv.bounce)}</div></div>
      <div><div class="section-head tk-section"><h3>Blacklists</h3></div><div class="card tk-pad">${renderBlacklists(dv.blacklists)}</div></div>
    </div>
    <div class="section-head tk-section"><h3>Spam tests</h3>${gate?(gate.ok?'<span class="pill green">Day 1 check passes</span>':'<span class="pill red">Day 1 check not passed yet</span>'):''}</div>
    ${gate?`<div class="card tk-pad tk-gap-b">${gate.rows.map(r=>`<div class="tk-gate-row">${tkSpamPill(r.v)}<b class="tk-break">${esc(r.inbox)}</b><span>${esc(tkToolName(r.test.tool))}: ${esc(r.v.text)}</span></div>`).join('')}<p class="tk-help">Day 1 needs every inbox's latest spam test to pass, and the seed test at ${Math.round(TK_RULES.seedGate*100)}% or more. A failed test is repeated the next day.</p></div>`:''}
    <div class="card tk-scroll"><table class="tk-table"><tr><th>When</th><th>Test</th><th>Inbox</th><th>Result</th><th>Details</th><th>Report</th></tr>${pl.length?pl.map(p=>{const seed=String(p.tool||'').toLowerCase()==='seed';const v=seed?null:tkSpamVerdict(p);
      return `<tr><td class="num">${esc(tkDateTime(p.at))}</td><td>${esc(tkToolName(p.tool))}</td><td class="wrap tk-small">${esc(p.inbox||'—')}</td>
      <td class="wrap">${seed?`${tkRate(p.inboxRate)} landed in the inbox${p.pass===true?' <span class="pill green">Passes</span>':p.pass===false?' <span class="pill red">Too low</span>':''}`:p.error&&v.level==='none'?`${tkSpamPill(v)} Couldn't finish`:`${tkSpamPill(v)} ${esc(v.text)}`}</td>
      <td class="wrap tk-small">${p.error?`<span class="tk-red">Couldn't finish: ${esc(p.error)}</span>`:(p.detail||[]).map(esc).join(' · ')||'—'}</td><td>${tkSafeUrl(p.reportUrl)?tkLink(p.reportUrl,'Open ↗'):'—'}</td></tr>`}).join(''):'<tr><td colspan="6" class="tk-muted">No placement tests yet.</td></tr>'}</table></div>
    <div class="section-head tk-section"><h3>Warm-up circle</h3>${w&&w.at?`<span class="tk-updated">Updated ${esc(tkRel(w.at))}</span>`:''}</div>
    <div class="card tk-pad">${w?`<div class="tk-kv">${wkv.map(([k,v])=>`<small>${esc(k)}</small><span>${v}</span>`).join('')}<small>Providers</small><span>${prov.length?`<span class="tk-pills">${prov.map(k=>`<span class="pill grey">${esc(k)} · ${tkNum(w.providers[k])}</span>`).join('')}</span>`:'—'}</span>
      <small>Outside warm-up network</small><span>${ext?`${esc(ext.name||'—')} <span class="pill ${String(ext.status)==='connected'?'green':'grey'}">${esc(String(ext.status)==='connected'?'Connected':'Not connected')}</span>${tkNorm(ext.perDay)?` <span class="tk-muted tk-small">adds ${tkNum(ext.perDay)} warm-up emails a day</span>`:''}`:'<span class="tk-muted">None declared</span>'}</span></div>`:'<span class="tk-muted">No warm-up circle data yet.</span>'}
      <div class="tk-inline tk-gap"><button class="btn ghost" onclick="openMachine('/mc/warmup')">Open the warm-up circle ↗</button></div></div>`+dns;
}

/* -- other tabs -- */
function renderInboxesTab(d){
  const id=(d.row||{}).id;const list=d.inboxes||[];
  const rows=list.map(ib=>{const on=tkTruthy(ib.enabled);const h=String(ib.health||'').toLowerCase();
    return `<tr><td class="wrap"><b class="tk-break">${esc(ib.email||'—')}</b><div class="tk-muted tk-small">${esc(ib.displayName||'')}${ib.provider?' · '+esc(ib.provider):''}${ib.hasPassword===false?' · <span class="tk-red">no password stored</span>':''}</div></td>
      <td><input type="checkbox" ${on?'checked':''} onchange="trialInboxToggle(${tkAttr(id)},${tkAttr(ib.email)},this.checked)" title="Sending on or off"></td>
      <td class="num">${tkNum(ib.dailyCap)}</td><td class="num">${tkRate(ib.inboxRate7d)}</td><td class="num">${tkRate(ib.canaryPlacement)}</td>
      <td>${h?`<span class="pill ${h==='ok'?'green':'amber'}">${esc(h==='ok'?'OK':h)}</span>`:'—'}${ib.disabledReason?`<div class="tk-muted tk-small">${esc(ib.disabledReason)}</div>`:''}</td>
      <td class="num">${esc(ib.warmupStartedAt?tkDate(ib.warmupStartedAt):'—')}</td>
      <td><button class="btn ghost" onclick="trialRemoveInbox(${tkAttr(id)},${tkAttr(ib.email)})">Remove</button></td></tr>`}).join('');
  return `<div class="card tk-scroll"><table class="tk-table"><tr><th>Inbox</th><th>On</th><th>Daily cap</th><th>Inbox rate</th><th>Placement</th><th>Health</th><th>Warming since</th><th></th></tr>${rows||'<tr><td colspan="8" class="tk-muted">No inboxes yet — paste them on the Buy & paste screen.</td></tr>'}</table></div>
  <div class="section-head tk-section"><h3>Add inbox</h3></div>
  <div class="card tk-form">
    <div class="field"><label>Email</label><input id="tkIbEmail" data-tk-form placeholder="hello@acme-team.com" autocomplete="off"></div>
    <div class="field"><label>App password</label><input id="tkIbPass" data-tk-form type="password" placeholder="16-character app password" autocomplete="new-password"></div>
    <div class="field"><label>Display name</label><input id="tkIbName" data-tk-form placeholder="Ann at Acme" autocomplete="off"></div>
    <div class="field"><label>Provider</label><select id="tkIbProv"><option value="google">Google</option><option value="microsoft">Microsoft</option><option value="other">Other (IMAP/SMTP)</option></select></div>
    <button class="btn" onclick="trialAddInbox(${tkAttr(id)})">Add inbox</button>
  </div>`;
}
function renderCallsTab(d){
  const id=(d.row||{}).id;const list=(d.bookings||[]).slice().sort((a,b)=>String(b.scheduledAt||'').localeCompare(String(a.scheduledAt||'')));
  const rows=list.map(b=>{const st=String(b.status||'').toLowerCase();const cls=st==='held'?'green':st==='noshow'||st==='disputed'?'red':st==='booked'||st==='scheduled'?'blue':'grey';
    const disputed=st==='disputed'||!!b.disputeReason;
    return `<tr><td class="wrap"><b class="tk-break">${esc(b.leadEmail||'(unmatched)')}</b></td><td class="num">${esc(tkDateTime(b.scheduledAt))}</td><td><span class="pill ${cls}">${esc(b.status||'—')}</span></td>
      <td>${tkTruthy(b.qualified)?'<span class="pill green">Yes</span>':'—'}</td><td>${esc(b.tapped||'—')}</td>
      <td class="wrap">${b.disputeReason?esc(b.disputeReason):'—'}${disputed?`<div class="tk-inline tk-gap-s"><button class="btn" onclick="trialDispute(${tkAttr(id)},${tkAttr(b.id)},'uphold')">Uphold</button><button class="btn ghost" onclick="trialDispute(${tkAttr(id)},${tkAttr(b.id)},'overturn')">Overturn</button></div>`:''}</td></tr>`}).join('');
  return `<div class="card tk-scroll"><table class="tk-table"><tr><th>Prospect</th><th>When</th><th>Status</th><th>Qualified</th><th>Client said</th><th>Dispute</th></tr>${rows||'<tr><td colspan="6" class="tk-muted">No bookings yet.</td></tr>'}</table></div>`;
}
function renderRepliesTab(d){
  const rbk=d.repliesByKind||{};const kinds=Object.keys(rbk);
  const head=`<div class="card tk-pad"><div class="tk-pills">${kinds.length?kinds.map(k=>`<span class="pill ${tkKindClass(k)}">${esc(k)} · ${tkNum(rbk[k])}</span>`).join(''):'<span class="tk-muted">No replies yet.</span>'}</div></div>`;
  const list=(d.replies||[]).slice().sort((a,b)=>String(b.receivedAt||'').localeCompare(String(a.receivedAt||''))).slice(0,50);
  if(!list.length)return head;
  return head+`<div class="section-head tk-section"><h3>Newest replies</h3><span class="count">${list.length}</span></div><div class="card">${list.map(r=>`<div class="tk-list-row"><div style="min-width:0"><div class="tk-inline"><span class="pill ${tkKindClass(r.kind)}">${esc(r.kind||'?')}</span><b class="tk-reply-email tk-break">${esc(r.leadEmail||'—')}</b><span class="tk-updated" title="${esc(tkFull(r.receivedAt))}">${esc(tkRel(r.receivedAt))}</span></div>${r.snippet?`<small>${esc(r.snippet)}</small>`:''}</div></div>`).join('')}</div>`;
}
function renderCopyTab(d){
  const id=(d.row||{}).id;const s=d.sequence||{};const lf=d.leadfinder||{};const changes=Array.isArray(s.changes)?s.changes:[];
  return `<div class="card tk-pad"><div class="tk-kv">
    <small>Active version</small><span>${esc(s.active||'—')}</span>
    <small>Version</small><span>${esc(s.version!=null?s.version:'—')}</span>
    <small>Approved</small><span>${s.approvedAt?esc(tkDateTime(s.approvedAt))+(s.approvalMode?' · by '+esc(s.approvalMode):''):'<span class="pill amber">Not yet</span>'}</span>
    <small>Change rounds</small><span>${esc(s.round!=null?s.round:'0')}</span>
    <small>Lead Finder</small><span>${esc(lf.status||'—')}${lf.found!=null?' · '+tkNum(lf.found)+' found of '+tkNum(lf.need):''}</span>
  </div>
  ${changes.length?`<h4 class="tk-gap">Change requests</h4><ul class="tk-sys-detail">${changes.map(c=>`<li>${esc(tkDetailText(c))}</li>`).join('')}</ul>`:''}
  <div class="tk-inline tk-gap"><button class="btn" onclick="openMachine(${tkAttr('/mc/clients/'+id+'/sequence')})">Open the copy editor ↗</button><button class="btn ghost" onclick="trialSequenceAction(${tkAttr(id)},'sendLink')">Send approval link</button><button class="btn ghost" onclick="trialSequenceAction(${tkAttr(id)},'dispatch')">Dispatch Lead Finder</button></div></div>`;
}
function renderChecksTable(checks){
  const keys=Object.keys(checks||{});if(!keys.length)return '<div class="tk-todo-empty">No checks recorded yet.</div>';
  return `<table class="tk-table"><tr><th>Check</th><th>Status</th><th>Detail</th></tr>${keys.map(k=>{const c=checks[k]||{};const st=typeof c==='string'?c:c.status;return `<tr><td>${esc(k)}</td><td>${tkCheckPill(st)}</td><td class="wrap tk-small">${esc(typeof c==='string'?'':(c.detail||''))}</td></tr>`}).join('')}</table>`;
}
function renderComingUpTab(d){
  const id=(d.row||{}).id;
  const up=(d.upcoming||[]).slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
  const promises=(d.promises||[]).slice().sort((a,b)=>String(a.dueAt||'').localeCompare(String(b.dueAt||'')));
  const reports=d.reports||[];const now=new Date();
  return `<div class="section-head tk-section"><h3>Dates ahead</h3><span class="count">${up.length}</span></div>
    <div class="card">${up.length?up.map(u=>`<div class="tk-list-row"><div><b>${esc(u.what||'')}</b><small>${esc(tkDate(u.date))}${u.time?' · '+esc(u.time):''}</small></div></div>`).join(''):'<div class="tk-todo-empty">Nothing dated ahead.</div>'}</div>
    <div class="section-head tk-section"><h3>Your promises and notes</h3><span class="count">${promises.length}</span></div>
    <div class="card">${promises.length?promises.map(p=>{const done=!!p.doneAt;const due=tkParseDate(p.dueAt);const over=!done&&due&&due<now;
      return `<div class="tk-list-row ${done?'done':''}"><div><b>${esc(p.text||'')}</b><small>${done?'Done '+esc(tkDateTime(p.doneAt)):(p.dueAt?'Due '+esc(tkDate(p.dueAt))+(over?' · <span class="tk-red">overdue</span>':''):'No date')}</small></div>${done?'<span class="pill green">Done</span>':`<button class="btn ghost" onclick="trialPromiseDone(${tkAttr(id)},${tkAttr(p.id)})">Done</button>`}</div>`}).join(''):'<div class="tk-todo-empty">No promises or notes yet.</div>'}</div>
    <div class="card tk-form tk-gap"><div class="field tk-span2"><label>Add a note (becomes a promise when dated)</label><input id="tkNoteText" data-tk-form placeholder="Call Ann about the calendar link" autocomplete="off"></div><div class="field"><label>Due date (optional)</label><input id="tkNoteDate" data-tk-form type="date"></div><button class="btn" onclick="trialAddNote(${tkAttr(id)})">Add note</button></div>
    <div class="section-head tk-section"><h3>Reports</h3><span class="count">${reports.length}</span></div>
    <div class="card">${reports.length?reports.map(r=>`<div class="tk-list-row"><div><b>${esc(r.name||'—')}</b><small>${r.blockedReason?'<span class="tk-red">Blocked — '+esc(r.blockedReason)+'</span>':r.renderedAt?'Sent '+esc(tkDateTime(r.renderedAt)):'Not sent yet'}</small></div>${r.blockedReason?'<span class="pill red">Blocked</span>':r.renderedAt?'<span class="pill green">Sent</span>':'<span class="pill grey">Pending</span>'}</div>`).join(''):'<div class="tk-todo-empty">No reports yet.</div>'}</div>`;
}
function renderTimeline(events){
  const list=(events||[]).slice().sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  if(!list.length)return '<div class="card"><div class="tk-todo-empty">No events yet.</div></div>';
  return `<div class="card tk-timeline">${list.map(e=>`<div class="tk-ev"><span class="t" title="${esc(tkFull(e.at))}">${esc(tkDateTime(e.at))}</span><span class="s">${esc(e.system||'')}</span><span class="e"><b>${esc(e.event||'')}</b>${e.detail!=null&&e.detail!==''?` <span>${esc(tkDetailText(e.detail))}</span>`:''}</span></div>`).join('')}</div>`;
}
function renderLinks(links){
  const keys=Object.keys(links||{}).filter(k=>links[k]);if(!keys.length)return '';
  return `<div class="section-head tk-section"><h3>Client links</h3></div><div class="card tk-links">${keys.map(k=>`<div class="tk-link"><small>${esc(k)}</small><input readonly value="${esc(links[k])}" onclick="this.select()"><button class="btn ghost" onclick="trialCopyLink(${tkAttr(links[k])})">Copy</button></div>`).join('')}</div>`;
}
function renderActionsTab(d){
  const row=d.row||{};const id=row.id;const st=row.state;const holds=d.holds||{};const jobs=d.jobs||{};const jobNames=Object.keys(jobs);const inv=d.invoice||null;
  const stateOpts=Object.keys(TK_STATE_LABEL).filter(k=>k!==st).map(k=>`<option value="${esc(k)}">${esc(TK_STATE_LABEL[k])}</option>`).join('');
  const pause=st==='sending'?`<button class="btn" onclick="trialSetState(${tkAttr(id)},'paused')">Pause sending</button>`:st==='paused'?`<button class="btn" onclick="trialSetState(${tkAttr(id)},'sending')">Resume sending</button>`:'';
  const holdLines=[];
  if(holds.legalHoldAt)holdLines.push(`<span class="pill red">Legal hold since ${esc(tkDateTime(holds.legalHoldAt))}</span>`);
  if(holds.sendHold)holdLines.push(`<span class="pill red">Send hold · ${esc(String(holds.sendHold))}</span>`);
  if(tkTruthy(holds.emergencyActive))holdLines.push('<span class="pill red">Emergency active</span>');
  if(tkTruthy(holds.emergencyHalved))holdLines.push('<span class="pill amber">Caps halved</span>');
  if(holds.pausedReason)holdLines.push(`<span class="pill amber">Paused · ${esc(String(holds.pausedReason))}</span>`);
  return `<div class="card tk-pad">
    ${holdLines.length?`<div class="tk-pills tk-gap-b">${holdLines.join('')}</div>`:''}
    <div class="tk-inline">${pause}<select id="tkStateSel"><option value="">Move to state…</option>${stateOpts}</select><button class="btn ghost" onclick="trialMoveState(${tkAttr(id)})">Move</button></div>
    <div class="tk-inline tk-gap"><select id="tkJobSel">${jobNames.length?jobNames.map(j=>`<option value="${esc(j)}">${esc(j)}</option>`).join(''):'<option value="">(no jobs listed)</option>'}</select><button class="btn ghost" onclick="trialRunJob(${tkAttr(id)})">Run a job now</button></div>
    <div class="tk-inline tk-gap">
      <button class="btn ghost" onclick="trialSimple(${tkAttr(id)},'markPaid','Mark this client as paid?')">Mark paid</button>
      <button class="btn ghost" onclick="trialSimple(${tkAttr(id)},'inboxesCancelled','Mark the inboxes as cancelled?')">Mark inboxes cancelled</button>
      ${holds.legalHoldAt?`<button class="btn" onclick="trialSimple(${tkAttr(id)},'clearLegalHold','Clear the legal hold and let sending resume?')">Clear legal hold</button>`:''}
      ${holds.sendHold?`<button class="btn" onclick="trialSimple(${tkAttr(id)},'clearSendHold','Clear the send hold?')">Clear send hold</button>`:''}
      <button class="btn ghost" onclick="trialSimple(${tkAttr(id)},'reviewCaptured','Record that a review was captured?')">Review captured</button>
    </div>
    <div class="tk-inline tk-gap"><input id="tkMinutes" data-tk-form type="number" min="1" max="600" placeholder="Minutes" style="width:110px"><button class="btn ghost" onclick="trialLogTime(${tkAttr(id)})">Log time</button></div>
  </div>
  <div class="section-head tk-section"><h3>Re-run a step</h3></div>
  <div class="card tk-pad"><div class="tk-inline"><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'rerunSetup')">Re-run setup check</button><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'rerunMarket')">Re-run market count</button><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'marketOverride')">Override market count</button><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'rerunBookingTest')">Re-test booking link</button><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'resendWelcome')">Resend welcome email</button></div></div>
  ${inv?`<div class="section-head tk-section"><h3>Invoice</h3></div><div class="card tk-pad"><div class="tk-kv"><small>Number</small><span>${esc(inv.number||'—')}</span><small>Amount</small><span>${tkMoney(inv.amount)}</span><small>Issued</small><span>${esc(tkDate(inv.issuedAt))}</span><small>Due</small><span>${esc(tkDate(inv.dueDate))}</span><small>Paid</small><span>${inv.paidAt?'<span class="pill green">Paid '+esc(tkDate(inv.paidAt))+'</span>':'<span class="pill amber">Unpaid</span>'}</span></div></div>`:''}
  ${renderLinks(d.links)}
  ${jobNames.length?`<div class="section-head tk-section"><h3>Jobs</h3><span class="count">${jobNames.length}</span></div><div class="card tk-scroll"><table class="tk-table"><tr><th>Job</th><th>Last run</th><th>Took</th><th>Result</th></tr>${jobNames.map(j=>{const r=jobs[j]||{};return `<tr><td>${esc(j)}</td><td class="num" title="${esc(tkFull(r.at))}">${esc(r.at?tkRel(r.at):'never')}</td><td class="num">${r.ms!=null?tkNum(r.ms)+' ms':'—'}</td><td class="wrap">${r.at==null?'—':r.ok===false||r.error?`<span class="pill red">Error</span> <span class="tk-small">${esc(r.error||'')}</span>`:'<span class="pill green">OK</span>'}</td></tr>`}).join('')}</table></div>`:''}`;
}
/* ctx = {now, spark:{g,state}, growth:{g,days,loading,error,at}} */
function renderTab(d,tab,ctx){
  ctx=ctx||{};
  switch(tkTabKey(tab)){
    case 'growth':return renderGrowthTab(d,ctx.growth);
    case 'systems':return renderSystems((d.row||{}).systems);
    case 'leads':return renderLeadsTab(d);
    case 'deliverability':return renderDeliverabilityTab(d);
    case 'inboxes':return renderInboxesTab(d);
    case 'calls':return renderCallsTab(d);
    case 'replies':return renderRepliesTab(d);
    case 'copy':return renderCopyTab(d);
    case 'comingup':return renderComingUpTab(d);
    case 'timeline':return renderTimeline(d.events);
    case 'actions':return renderActionsTab(d);
    case 'application':return d.application?renderApplication(d):renderOverviewTab(d,ctx);
    default:return renderOverviewTab(d,ctx);
  }
}
function renderTrialDetail(d,tab,meta){
  d=d||{};meta=meta||{};tab=tkTabKey(tab);tab=tkTabsFor(d).some(t=>t[0]===tab)?tab:'overview';
  const pending=!!(d.application&&d.application.review==='pending');
  return renderTrialHeader(d,meta)+(pending?renderApplication(d):'')+renderTabBar(tab,d)+`<div id="tkTabHost">${renderTab(d,tab,meta)}</div>`;
}

/* -- application review (website applications held for the owner) -- */
function tkIsUnderReview(row){row=row||{};if(row.application&&row.application.review==='pending')return true;return (row.todo||[]).some(t=>String(t.id||'').indexOf('review:')===0||!!(t.action&&t.action.section==='application'))}
function tkFitPill(st){st=String(st||'unknown').toLowerCase();const m={pass:['green','Pass'],fail:['red','Fail'],unknown:['amber','Unknown']}[st]||['blue',st];return `<span class="pill ${m[0]}">${esc(m[1])}</span>`}
function tkVerdictPill(v){v=String(v||'unknown').toLowerCase();const m={fit:['green','Looks like a fit'],fails:['red','Fails a rule'],unknown:['amber','Needs a look']}[v]||['blue',v];return `<span class="pill ${m[0]}">${esc(m[1])}</span>`}
function tkSourceText(src){return {website:'the website',form:'the application form',owner:'you (owner)'}[src]||src||'—'}
/* Turn a fit-rule label into a starting sentence for the decline reason. */
function tkSentence(s){s=String(s||'').trim();if(!s)return '';s=s.charAt(0).toUpperCase()+s.slice(1);return /[.!?]$/.test(s)?s:s+'.'}
/* What the machine found out about the applicant (website crawl + Google Places + market count). */
function renderResearch(r,id){
  const head=`<div class="tk-research-head"><h4>What we found</h4>${id?`<button class="btn ghost tk-btn-s" onclick="trialResearchAgain(${tkAttr(id)})">Research again</button>`:''}</div>`;
  if(!r)return id?head+'<div class="tk-research-pending">No research yet.</div>':'';
  const st=String(r.status||'').toLowerCase();
  if(st==='pending')return head+'<div class="tk-research-pending">Researching their website…</div>';
  if(st==='failed')return head+`<div class="tk-note">Couldn't research their website${r.error?': '+esc(r.error):''}. Check it yourself before deciding.</div>`;
  const w=r.website||{};const b=r.business||null;const m=r.market||null;const flags=(r.flags||[]).filter(f=>f&&f.text);
  const socials=w.socials&&typeof w.socials==='object'?Object.keys(w.socials).filter(k=>tkSafeUrl(w.socials[k])):[];
  const rows=[];
  if(w.url||w.title)rows.push(['Website',`${tkLink(w.url,w.title||null)}${w.pagesRead?` <span class="tk-muted">· read ${tkNum(w.pagesRead)} page${Number(w.pagesRead)!==1?'s':''}</span>`:''}`]);
  if(w.headline||w.description)rows.push(['What they say',esc(w.headline||w.description)]);
  if((w.services||[]).length)rows.push(['Services',esc(w.services.join(', '))]);
  if((w.locations||[]).length)rows.push(['Locations',esc(w.locations.join(' · '))]);
  if(b)rows.push(['On Google',`${b.rating!=null?`<b>${esc(b.rating)}★</b> from ${tkNum(b.reviews)} review${Number(b.reviews)!==1?'s':''}`:'No rating'}${b.category?' · '+esc(b.category):''}${tkSafeUrl(b.mapsUrl)?' · '+tkLink(b.mapsUrl,'Google Maps ↗'):''}${b.address?`<br><span class="tk-muted">${esc(b.address)}</span>`:''}`]);
  else if(st==='done')rows.push(['On Google','<span class="tk-muted">Not found on Google Maps</span>']);
  if(w.teamHint||w.yearsHint)rows.push(['Size and age',esc([w.teamHint,w.yearsHint].filter(Boolean).join(' · '))]);
  const phone=(b&&b.phone)||(w.phones||[])[0];if(phone)rows.push(['Phone',esc(phone)]);
  if((w.emails||[]).length)rows.push(['Emails on the site',esc(w.emails.join(', '))]);
  if(socials.length)rows.push(['Social',socials.map(k=>tkLink(w.socials[k],k.charAt(0).toUpperCase()+k.slice(1))).join(' · ')]);
  return head+`
    ${r.summary?`<p class="tk-research-summary">${esc(r.summary)}</p>`:''}
    ${flags.length?`<div class="tk-flags">${flags.map(f=>`<div class="tk-flag ${String(f.level)==='warn'?'warn':'info'}"><span class="pill ${String(f.level)==='warn'?'amber':'grey'}">${String(f.level)==='warn'?'Check':'Note'}</span><span>${esc(f.text)}</span></div>`).join('')}</div>`:''}
    ${rows.length?`<div class="tk-about"><h5>About the company</h5><div class="tk-kv">${rows.map(([k,v])=>`<small>${esc(k)}</small><span>${v}</span>`).join('')}</div></div>`:''}
    ${m&&m.estimate!=null?`<div class="tk-market"><h5>Their market</h5><p>About <b>${tkNum(m.estimate)}</b> matching companies for “${esc(m.query||'')}”${m.source?` <span class="tk-muted">(${esc(m.source==='places'?'Google Places':m.source==='overpass'?'OpenStreetMap':m.source)})</span>`:''}.</p></div>`:''}
    ${r.at?`<p class="tk-help">Researched ${esc(tkRel(r.at))}. Facts copied from their site and Google — nothing guessed.</p>`:''}`;
}
function renderApplication(d){
  const row=d.row||{};const id=row.id;const app=d.application||{};const fit=app.fit||{};const lines=fit.lines||[];const answers=app.answers||[];
  const review=String(app.review||'').toLowerCase();const pending=review==='pending';
  const status=pending?'<span class="pill red">Waiting for your review</span>':review==='approved'?'<span class="pill green">Approved</span>':review==='declined'?'<span class="pill grey">Declined</span>':'';
  const who=[esc(row.contactName||''),row.contactEmail?`<a href="mailto:${esc(row.contactEmail)}">${esc(row.contactEmail)}</a>`:'',row.website?tkLink(row.website):''].filter(Boolean).join(' · ');
  const decided=review==='approved'?`Approved ${esc(tkDateTime(app.decidedAt))} — the onboarding link went out.`:review==='declined'?`Declined ${esc(tkDateTime(app.decidedAt))}.${app.declineReason?` Reason sent to them: “${esc(app.declineReason)}”`:''}`:'';
  return `<div class="section-head tk-section" id="tkSec-application"><h3>Application</h3>${status}</div>
  <div class="card tk-app${pending?' pending':''}">
    <div class="tk-app-who"><b>${esc(row.name||id||'—')}</b>${who?' · '+who:''}<br><span class="tk-muted">Received ${esc(tkDateTime(app.receivedAt))} (${esc(tkRel(app.receivedAt))}) · from ${esc(tkSourceText(app.source))}</span></div>
    <h4>Fit check</h4>
    <div class="tk-fit-summary">${tkVerdictPill(fit.verdict)}<span>${esc(fit.summary||'')}</span></div>
    ${lines.length?`<div class="tk-fit">${lines.map(l=>`<div class="tk-fit-line"><div>${tkFitPill(l.status)}</div><div><b>${esc(l.label||l.rule||'')}</b>${l.note?`<small>${esc(l.note)}</small>`:''}</div></div>`).join('')}</div>`:''}
    ${renderResearch(app.research,id)}
    <h4>Their answers</h4>
    ${answers.length?`<dl class="tk-answers">${answers.map(x=>`<dt>${esc(x.q||'')}</dt><dd>${x.a!=null&&x.a!==''?esc(x.a):'<span class="tk-muted">(no answer)</span>'}</dd>`).join('')}</dl>`:'<div class="tk-muted">No answers stored.</div>'}
    ${pending?`<div class="tk-app-actions"><button class="btn" onclick="trialApproveApplication(${tkAttr(id)})">Approve — send the onboarding link</button><button class="btn ghost" onclick="openDeclineApplication(${tkAttr(id)})">Decline…</button></div>`:decided?`<div class="tk-app-decided">${decided}</div>`:''}
  </div>`;
}
function renderDeclineModal(d){
  const row=(d&&d.row)||{};const id=row.id;const app=(d&&d.application)||{};
  const fail=((app.fit&&app.fit.lines)||[]).find(l=>String(l.status).toLowerCase()==='fail');
  return `<div class="modal-head"><div><h3>Decline ${esc(row.name||id)}'s application</h3><p>Write the reason in one plain sentence.</p></div></div>
    <div class="modal-body">
      <div class="field"><label>Reason</label><textarea id="tkDeclineReason" rows="4" placeholder="e.g. We only run trials for companies whose customers are worth $2,000 or more in year one.">${esc(fail?tkSentence(fail.label):'')}</textarea><div class="tk-help">They'll get this reason by email.</div></div>
      <div id="tkDeclineErr" class="tk-modal-errs"></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="tkDeclineBtn" onclick="submitDeclineApplication(${tkAttr(id)})">Decline and email them</button></div>`;
}
/* Plain words for what the machine did with an application. */
function tkOutcomeText(data,action){
  data=data||{};const o=String(data.outcome||'').toLowerCase();
  if(o==='onboarding')return 'Onboarding link sent';
  if(o==='queued'){const pos=data.position!=null?data.position:data.queuePosition!=null?data.queuePosition:(data.queue&&data.queue.position);return 'In the queue'+(pos!=null?' — position '+pos:'');}
  if(o==='declined')return action==='approve'?'Declined — this company already had a trial; email sent':'Declined — email sent';
  return action==='approve'?'Approved':'Done';
}

/* -- purchase (Buy & paste) -- */
function renderQuoteLine(q,unconfirmed){
  if(!q||typeof q!=='object')return `<li>${esc(String(q))}</li>`;
  const name=q.name||q.registrar||q.provider||'—';const price=q.price!=null?q.price:(q.firstYearPrice!=null?q.firstYearPrice:q.monthly);
  const flag=q.unconfirmed||(unconfirmed||[]).some(u=>String(u).toLowerCase().includes(String(name).toLowerCase()));
  return `<li><b>${esc(name)}</b>${price!=null?' · '+tkMoney(price):''}${q.code?' · code '+esc(q.code):''}${q.minOrder?' · min '+esc(q.minOrder):''}${q.source?` <span class="tk-muted">(${esc(q.source)})</span>`:''}${flag?' <span class="pill amber">Unconfirmed</span>':''}</li>`;
}
function tkSourcePill(src,confirmedAt){src=String(src||'').toLowerCase();return src==='live'?`<span class="pill green" title="${esc(confirmedAt?'Checked '+tkFull(confirmedAt):'Checked live')}">Live price</span>`:src==='table'?`<span class="pill grey" title="From the machine's price list">Price list</span>`:''}
function tkRegistrarUrl(sh,name,prices){const p=(prices||[]).find(x=>x&&x.registrar===name&&tkSafeUrl(x.url));if(p)return p.url;const r=(sh.registrars||[]).find(x=>x&&x.name===name&&tkSafeUrl(x.url));return r?r.url:''}
/* A registrar promo: the machine sends {code, firstYear, note}; older data may be a bare code. Shown, never counted in the price. */
function tkPromoText(pr){if(!pr)return '';if(typeof pr!=='object')return 'Code '+String(pr);return ['Code '+(pr.code||'?'),tkNorm(pr.firstYear)!=null?tkMoney(pr.firstYear)+' first year':'',pr.note||''].filter(Boolean).join(' · ')}
function tkPromoChip(pr){const t=tkPromoText(pr);return t?`<span class="pill amber tk-promo" title="Promo codes may have ended — not counted in the price">${esc(t)}</span>`:''}
/* The domain comparison (shopping.offers): best names first, each with every registrar's price. */
function renderOffers(sh,canUse){
  const offers=(sh.offers||[]).filter(o=>o&&o.domain);if(!offers.length)return '';
  return `<div class="section-head tk-section"><h3>Pick a domain</h3><span class="tk-muted tk-small">Best first · first-year price / renewal</span></div>
  <div class="card tk-scroll"><table class="tk-table tk-offers"><tr><th>Domain</th><th>Why</th><th>Best price</th><th>Other registrars</th><th></th></tr>${offers.map((o,idx)=>{
    const best=o.best||null;const prices=(o.prices||[]).filter(p=>p&&(!best||p.registrar!==best.registrar));
    const buyUrl=best?(tkSafeUrl(best.url)||tkRegistrarUrl(sh,best.registrar,o.prices)):'';const taken=o.available===false;const unsure=o.available==null;
    return `<tr class="tk-offer${idx===0?' first':''}" data-domain="${esc(o.domain)}"><td><b class="tk-break">${esc(o.domain)}</b>${idx===0?' <span class="pill green">Top pick</span>':''}${taken?' <span class="pill red">Taken</span>':unsure?' <span class="pill amber">Availability not confirmed</span>':''}${o.score!=null?`<div class="tk-muted tk-small">Score ${tkNum(o.score)}</div>`:''}</td>
      <td class="wrap tk-small" data-label="Why">${esc(o.why||'')}</td>
      <td data-label="Best price">${best?`<b>${tkMoney(best.firstYear)}</b> at ${esc(best.registrar||'—')}<div class="tk-muted tk-small">renews ${tkMoney(best.renewal)}</div>${best.promo?`<div class="tk-gap-s">${tkPromoChip(best.promo)}</div>`:''}${buyUrl&&!taken?`<a class="btn ghost tk-buy" href="${esc(buyUrl)}" target="_blank" rel="noopener noreferrer">Buy at ${esc(best.registrar)} ↗</a>`:''}`:'<span class="tk-muted">No price known</span>'}</td>
      <td class="wrap tk-small" data-label="Other registrars">${prices.length?prices.map(p=>`<div class="tk-price">${tkSafeUrl(p.url)?tkLink(p.url,p.registrar):esc(p.registrar||'—')} ${tkMoney(p.firstYear)} / ${tkMoney(p.renewal)} ${tkSourcePill(p.source,p.confirmedAt)}${p.promo?' '+tkPromoChip(p.promo):''}</div>`).join(''):'—'}</td>
      <td>${taken?'':`<button class="btn ${idx===0?'':'ghost'}" ${canUse?'':'disabled'} onclick="trialsUseDomain(${tkAttr(o.domain)})">Use this domain</button>`}</td></tr>`}).join('')}</table></div>
  <p class="tk-help">Promo codes are shown, never counted in the price — they may have ended. Auto-renew must be off when you buy.</p>
  ${(sh.registrars||[]).length?`<details class="tk-tv"><summary>Registrars compared (${(sh.registrars||[]).length})</summary><ul class="tk-plain">${(sh.registrars||[]).map(r=>`<li><span>${tkSafeUrl(r.url)?tkLink(r.url,r.name):esc(r.name||'—')}</span><span class="tk-muted tk-small">${esc(r.why||'')}</span></li>`).join('')}</ul></details>`:''}`;
}
function renderInboxOrder(ib,senders,senderName){
  if(!ib||typeof ib!=='object')return '';
  const steps=(ib.steps||[]).filter(Boolean);
  return `<div class="section-head tk-section"><h3>Buy the inboxes</h3></div>
  <div class="card tk-pad"><div class="tk-inbox-head"><div><b>${tkSafeUrl(ib.url)?tkLink(ib.url,ib.provider||'Inbox provider'):esc(ib.provider||'Inbox provider')}</b><div class="tk-muted tk-small">${tkMoney(ib.perInbox)} per inbox × ${tkNum(ib.count)} = <b>${tkMoney(ib.monthly)} a month</b></div></div></div>
    ${ib.notes?`<p class="tk-help">${esc(ib.notes)}</p>`:''}
    ${(senders||[]).length?`<p><b>Sender addresses to create:</b> ${senders.map(s=>`<span class="tk-break">${esc(s)}</span>`).join(', ')}${senderName?` · display name <b>${esc(senderName)}</b>`:''}</p>`:''}
    ${steps.length?`<ol class="tk-steps">${steps.map((s,i)=>`<li><label><input type="checkbox" id="tkStep${i}"> <span>${esc(s)}</span></label></li>`).join('')}</ol>`:''}
  </div>`;
}
function renderPurchase(p,id,meta){
  p=p||{};meta=meta||{};const client=p.client||{};const sh=p.shopping||{};const setup=p.setup||{};const existing=p.inboxes||[];
  const state=client.state||(tkFindRow(id)||{}).state||'';
  const canPaste=!state||['awaiting_purchase','setup_check'].includes(state);
  const enc=p.encKey!==false;
  const unconfirmed=sh.unconfirmed||[];
  const domainDefault=(sh.domain&&sh.domain.name)||sh.chosenDomain||'';
  const senders=Array.isArray(sh.senderAddresses)?sh.senderAddresses:[];
  const rowsN=Math.max(2,senders.length,Number(sh.inboxes&&sh.inboxes.count)||0);
  const rows=[];for(let i=0;i<rowsN;i++)rows.push(renderPurchaseRow(senders[i]||'',setup.senderName||''));
  const notes=[];
  if(!enc)notes.push('<div class="tk-note">The machine has no ENC_KEY yet, so it cannot store app passwords safely. Set ENC_KEY on the machine, then come back.</div>');
  if(state&&!canPaste)notes.push(`<div class="tk-note">This client is in "${esc(tkStateLabel({state}))}" — the paste form only applies while it waits for the purchase or the setup check.</div>`);
  const disabled=!enc||!canPaste;
  const t=sh.totals||null;const v2=(sh.offers||[]).length>0||!!(sh.inboxes&&typeof sh.inboxes==='object')||!!t;
  const totals=t?`<div class="card tk-totals"><span>Domain <b>${tkMoney(t.domainFirstYear)}</b> first year</span><span>+ inboxes <b>${tkMoney(t.inboxesMonthly)}</b> a month</span><span>= ${tkNorm(t.firstMonth)!=null?`<b class="tk-big">${tkMoney(t.firstMonth)}</b> for the first month`:'<b>first month not known yet</b> (a price is missing)'}</span></div>`:'';
  const legacy=`<div class="section-head tk-section"><h3>Shopping list</h3>${tkUpdatedStamp(meta.at)}</div>
  <div class="card tk-shop"><div class="tk-kv">
    <small>Domain</small><span><b class="tk-break">${esc(sh.chosenDomain||'—')}</b>${(sh.backups||[]).length?` <span class="tk-muted">· backups: ${(sh.backups||[]).map(esc).join(', ')}</span>`:''}</span>
    <small>Registrar</small><span>${(sh.registrarQuotes||[]).length?`<ul class="tk-sys-detail tk-flush">${(sh.registrarQuotes||[]).map(q=>renderQuoteLine(q,unconfirmed)).join('')}</ul>`:'—'}</span>
    <small>Inboxes</small><span>${(sh.inboxQuotes||[]).length?`<ul class="tk-sys-detail tk-flush">${(sh.inboxQuotes||[]).map(q=>renderQuoteLine(q,unconfirmed)).join('')}</ul>`:'—'}</span>
    ${senders.length?`<small>Sender addresses</small><span>${senders.map(esc).join(', ')}</span>`:''}
    <small>Total</small><span class="tk-total">${tkMoney(sh.total)}</span>
  </div></div>`;
  const status=`<div class="card tk-pad tk-gap"><div class="tk-kv"><small>List sent</small><span>${sh.sentAt?esc(tkDateTime(sh.sentAt))+' ('+esc(tkRel(sh.sentAt))+')':'—'}</span><small>Bought</small><span>${sh.boughtAt?'<span class="pill green">'+esc(tkDateTime(sh.boughtAt))+'</span>':'<span class="pill amber">Not yet</span>'}</span>${unconfirmed.length?`<small>Unconfirmed</small><span class="tk-amber">${unconfirmed.map(u=>esc(String(u))).join('; ')}</span>`:''}</div></div>`;
  return `<div class="card tk-head tk-gap-b"><div class="tk-head-main"><h2>${esc(client.name||tkClientName(id)||id||'—')}</h2><div class="tk-pills"><span class="pill grey">${esc(tkStateLabel({state}))}</span>${client.mainDomain?`<span class="pill blue">${esc(client.mainDomain)}</span>`:''}</div><div class="tk-meta">The one manual step per trial: buy the domain and the inboxes, then paste the logins here. The machine checks everything else.</div></div>
    <div class="tk-btns"><button class="btn ghost" onclick="openTrial(${tkAttr(id)})">← Trial</button><button class="btn ghost" onclick="trialsRefresh()">Refresh</button><button class="btn ghost" onclick="openMachine(${tkAttr('/mc/clients/'+id+'/purchase')})">Mission Control ↗</button></div></div>
  ${notes.join('')}
  ${v2?totals+renderOffers(sh,!disabled)+renderInboxOrder(sh.inboxes,senders,setup.senderName)+status:legacy+status}
  ${existing.length?`<div class="section-head tk-section"><h3>Already pasted</h3><span class="count">${existing.length}</span></div><div class="card tk-scroll"><table class="tk-table"><tr><th>Inbox</th><th>Name</th><th>Password</th><th>On</th></tr>${existing.map(ib=>`<tr><td class="tk-break">${esc(ib.email||'')}</td><td>${esc(ib.displayName||'')}</td><td>${ib.hasPassword?'<span class="pill green">Stored</span>':'<span class="pill red">Missing</span>'}</td><td>${tkTruthy(ib.enabled)?'Yes':'No'}</td></tr>`).join('')}</table></div>`:''}
  <div class="section-head tk-section"><h3>Paste the logins</h3></div>
  <div class="card tk-pad"><fieldset class="tk-fs" id="tkPcForm" ${disabled?'disabled':''}>
    <div class="field tk-maxw"><label>Domain you bought</label><input id="pcDomain" data-tk-form value="${esc(domainDefault)}" placeholder="acme-team.com" autocomplete="off"></div>
    <label class="tk-check"><input id="pcAutoRenew" type="checkbox"> Auto-renew is <b>off</b> at the registrar (required)</label>
    <div class="field"><label>Inboxes (email · app password · display name)</label><div id="pcRows">${rows.join('')}</div><button class="li-add" type="button" onclick="trialsPurchaseAddRow()">+ Add another inbox</button></div>
    <div id="pcErr" class="tk-modal-errs"></div>
    <div class="tk-inline tk-gap"><button class="btn" onclick="submitTrialPurchase(${tkAttr(id)})">Save logins and start the setup check</button><span class="tk-help">Passwords are sent once, over HTTPS, and stored encrypted on the machine.</span></div>
  </fieldset></div>
  <div class="section-head tk-section"><h3>Setup checks</h3>${setup.domain&&setup.domain.setupPhase?`<span class="pill ${setup.domain.setupPhase==='passed'?'green':setup.domain.setupPhase==='failed'?'red':'amber'}">${esc(setup.domain.setupPhase)}</span>`:''}<div class="spacer"></div><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'rerunSetup')">Re-run setup</button></div>
  <div class="card tk-scroll">${renderChecksTable(setup.checks)}</div>`;
}
function renderPurchaseRow(email,name){return `<div class="tk-pc-row"><input class="pc-email" data-tk-form placeholder="hello@acme-team.com" value="${esc(email||'')}" autocomplete="off"><input class="pc-pass" data-tk-form type="password" placeholder="App password" autocomplete="new-password"><input class="pc-name" data-tk-form placeholder="Display name" value="${esc(name||'')}" autocomplete="off"><button class="li-del" type="button" onclick="this.parentElement.remove()" title="Remove row">✕</button></div>`}

/* -- alerts -- */
function renderAlerts(alerts,filter,meta){
  alerts=alerts||[];meta=meta||{};filter=filter||'open';
  const list=alerts.filter(a=>filter==='all'||!a.acknowledged).slice().sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  const openN=alerts.filter(a=>!a.acknowledged).length;
  const toolbar=`<div class="toolbar"><div class="seg"><button class="${filter==='all'?'active':''}" onclick="trialsSetAlertFilter('all')">All · ${alerts.length}</button><button class="${filter==='open'?'active':''}" onclick="trialsSetAlertFilter('open')">Open · ${openN}</button></div><div style="margin-left:auto" class="tk-inline">${tkUpdatedStamp(meta.at)}<button class="btn ghost" onclick="trialsRefresh()">Refresh</button><button class="btn ghost" onclick="openMachine('/mc/alerts')">Mission Control ↗</button></div></div>`;
  if(!list.length)return toolbar+`<div class="card"><div class="tk-todo-empty">${filter==='open'?'No open alerts — the machine has nothing for you.':'No alerts yet.'}</div></div>`;
  return toolbar+`<div class="card">${list.map(a=>`<div class="tk-alert ${a.acknowledged?'acked':''}">${a.urgent?'<span class="pill red">Urgent</span>':'<span class="pill grey">Info</span>'}
    <div style="min-width:0"><b>${esc(a.title||a.key||'Alert')}</b><small>${a.clientId?`<span class="tk-client" onclick="openTrial(${tkAttr(a.clientId)})">${esc(tkClientName(a.clientId))}</span> · `:''}${a.key?esc(a.key)+' · ':''}<span title="${esc(tkFull(a.at))}">${esc(tkRel(a.at,meta.now))}</span> · ${a.delivered===false?'<span class="tk-red">not delivered</span>':'delivered'}${a.acknowledged?' · acknowledged':''}</small></div>
    <div class="tk-alert-act">${a.acknowledged?'':`<button class="btn ghost" onclick="trialsAckAlert(${tkAttr(a.id)})">Acknowledge</button>`}</div></div>`).join('')}</div>`;
}

/* ===================== 6. VIEWS (called by the shell router) ===================== */
function trialsIsAdmin(){return !!(typeof authUser!=='undefined'&&authUser&&authUser.role==='admin')}
function trialsNotAdminHTML(){return emptyState(I.trials||'','Owner only','This hub is for the Aviance owner.','',null)}
/* Everything a trial's tabs need besides the detail itself (read from the caches; never fetches). */
function trialsCtx(id){
  const row=tkFindRow(id)||{};const s=tkSparkGet(id);
  const sparkState=TK_PRE_WARMUP.includes(row.state)?'pre':tk.sparkBusy[id]&&!s?'loading':tk.sparkErr[id]&&!s?'error':null;
  const gc=tk.growth[id];
  return {spark:{g:s?s.g:null,state:sparkState},growth:{g:gc?gc.data:null,days:tk.growthDays,at:gc?gc.at:0,loading:!!tk.growthBusy[id]||(gc&&gc.days!==tk.growthDays),error:tk.growthErr[id]||null}};
}
function trialsSparkMap(){const out={};const all=tkSparkAll();Object.keys(all).forEach(k=>{if(all[k]&&all[k].g)out[k]=all[k].g;});return out}
function trialsHostHTML(view){
  switch(view){
    case 'trials':return tk.hub?renderStaleNote(tk.hubErr,tk.hubAt)+renderBoard(tk.hub,{at:tk.hubAt,sparks:trialsSparkMap()}):tk.hubErr?renderMachineError(tk.hubErr):renderLoading();
    case 'trial':{const id=currentTrialId;if(!id)return emptyState(I.trials||'','Pick a trial','Open one from the board.','Trials board',"render('trials')");
      const d=tk.detail[id];return d?renderStaleNote(tk.detailErr[id],tk.detailAt[id])+renderTrialDetail(d,trialTab,Object.assign({at:tk.detailAt[id]},trialsCtx(id))):tk.detailErr[id]?renderMachineError(tk.detailErr[id]):renderLoading();}
    case 'trialPurchase':{const id=currentTrialId;if(!id)return emptyState(I.trials||'','Pick a trial','Open one from the board first.','Trials board',"render('trials')");
      const p=tk.purchase[id];return p?renderStaleNote(tk.purchaseErr[id],tk.purchaseAt[id])+renderPurchase(p,id,{at:tk.purchaseAt[id]}):tk.purchaseErr[id]?renderMachineError(tk.purchaseErr[id]):renderLoading();}
    case 'trialAlerts':return tk.alerts?renderStaleNote(tk.alertsErr,tk.alertsAt)+renderAlerts(tk.alerts,trialsAlertFilter,{at:tk.alertsAt}):tk.alertsErr?renderMachineError(tk.alertsErr):renderLoading();
  }
  return '';
}
function tkFormDirty(){try{const h=document.getElementById('tkHost');if(!h)return false;const els=h.querySelectorAll('[data-tk-form]');for(const el of els){if(el.type==='password'&&el.value)return true;if(el.value&&el.value!==el.defaultValue)return true;}const a=document.activeElement;return !!(a&&h.contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));}catch(e){return false}}
function trialsRepaint(view,opts){
  opts=opts||{};if(currentView!==view)return;
  const h=document.getElementById('tkHost');if(!h)return;
  if(opts.soft&&tkFormDirty())return;   // never wipe something the owner is typing
  h.innerHTML=trialsHostHTML(view);
  if(view==='trial'&&currentTrialId&&tk.detail[currentTrialId]){const row=tk.detail[currentTrialId].row||{};const t=document.getElementById('ptitle'),s=document.getElementById('psub');if(t)t.textContent=row.name||'Trial';if(s)s.textContent=tkStateLabel(row);}
  try{renderNav();updateNotifBadge();}catch(e){}
  trialsApplyScroll();
}
/* Repaint only the open tab (after a growth/sparkline answer) — leaves the rest of the page alone. */
function trialsRepaintTab(tab){
  if(currentView!=='trial'||tkTabKey(trialTab)!==tab||!currentTrialId)return;
  const d=tk.detail[currentTrialId];const host=document.getElementById('tkTabHost');if(!d||!host)return;
  host.innerHTML=renderTab(d,tab,trialsCtx(currentTrialId));
}
/* openTrial(id, tab, section) asks for a section (e.g. 'application'); scroll there once it exists. */
function trialsApplyScroll(){
  if(currentView!=='trial'||!tk.scrollTo||!currentTrialId||!tk.detail[currentTrialId])return;
  const el=document.getElementById('tkSec-'+tk.scrollTo);tk.scrollTo=null;
  // Instant, not smooth: smooth scrolling needs animation frames, which browsers pause in hidden tabs.
  if(el&&el.scrollIntoView)try{el.scrollIntoView({block:'start'});}catch(e){el.scrollIntoView();}
}
async function trialsKick(view,force){
  let r;
  if(view==='trials')r=await loadHub(force);
  else if(view==='trial')r=await loadTrial(currentTrialId,force);
  else if(view==='trialPurchase')r=await loadPurchase(currentTrialId,force);
  else if(view==='trialAlerts')r=await loadAlerts(force);
  trialsRepaint(view,{soft:true});
  return r;
}
function viewTrials(){if(!trialsIsAdmin())return trialsNotAdminHTML();trialsKick('trials').then(()=>trialsSparkBoot());return `<div id="tkHost">${trialsHostHTML('trials')}</div>`}
function viewTrial(){if(!trialsIsAdmin())return trialsNotAdminHTML();trialsKick('trial');loadHub(false).then(()=>{try{renderNav();}catch(e){}});return `<div id="tkHost">${trialsHostHTML('trial')}</div>`}
function viewTrialPurchase(){if(!trialsIsAdmin())return trialsNotAdminHTML();trialsKick('trialPurchase');return `<div id="tkHost">${trialsHostHTML('trialPurchase')}</div>`}
function viewTrialAlerts(){if(!trialsIsAdmin())return trialsNotAdminHTML();trialsKick('trialAlerts');loadHub(false).then(()=>{try{renderNav();}catch(e){}});return `<div id="tkHost">${trialsHostHTML('trialAlerts')}</div>`}
/* Growth fetches — only from the owner's own clicks (opening a trial or a tab), never from the timer. */
function trialsEnsureOverview(id){
  const row=tkFindRow(id);if(row&&TK_PRE_WARMUP.includes(row.state))return;
  const c=tkSparkGet(id);if(c&&Date.now()-c.at<TK_OVERVIEW_FRESH_MS)return;
  const p=loadSpark(id,TK_OVERVIEW_FRESH_MS);trialsRepaintTab('overview');
  p.then(()=>{if(currentTrialId===id)trialsRepaintTab('overview');});
}
function trialsEnsureGrowth(id,force){
  const days=tk.growthDays;const c=tk.growth[id];
  if(!force&&c&&c.days===days&&Date.now()-c.at<TK_GROWTH_FRESH_MS)return;
  if(tk.growthBusy[id])return;
  tk.growthBusy[id]=true;trialsRepaintTab('growth');
  loadGrowth(id,days,true).then(()=>{delete tk.growthBusy[id];if(currentTrialId===id)trialsRepaintTab('growth');});
}
function trialsEnsureTab(){
  if(currentView!=='trial'||!currentTrialId)return;
  const t=tkTabKey(trialTab);
  if(t==='growth')trialsEnsureGrowth(currentTrialId);
  else if(t==='overview')trialsEnsureOverview(currentTrialId);
}
/* Board sparklines: one small growth call per warming/sending client, at most every 6 hours
   (kept in localStorage so reloads are free). Started by opening the board, not by the timer. */
async function trialsSparkBoot(){
  if(!tk.hub||currentView!=='trials')return;
  const rows=tkAllRows(tk.hub).filter(r=>r&&r.id&&!TK_PRE_WARMUP.includes(r.state));
  for(const r of rows){
    const c=tkSparkGet(r.id);if(c&&Date.now()-c.at<TK_SPARK_FRESH_MS)continue;
    await loadSpark(r.id,TK_SPARK_FRESH_MS);
    if(currentView!=='trials')return;
    const el=document.getElementById(tkDomId('tkSpark-',r.id));const s=tkSparkGet(r.id);
    if(el&&s)el.innerHTML=renderCardSpark(s.g);
  }
}

/* ===================== 7. ACTIONS ===================== */
function openTrial(id,tab,section){if(!id)return;id=String(id);if(id!==currentTrialId&&!tab)trialTab='overview';currentTrialId=id;if(tab)trialTab=tkTabKey(tab);if(section){tk.scrollTo=section;if(section==='application')trialTab='application';}render('trial')}
function openTrialPurchase(id){if(!id)return;currentTrialId=String(id);render('trialPurchase')}
function trialsRetry(){const h=document.getElementById('tkHost');if(h&&!trialsHasData(currentView))h.innerHTML=renderLoading('Trying again…');trialsKick(currentView,true).then(()=>trialsRepaint(currentView))}
function trialsHasData(v){if(v==='trials')return !!tk.hub;if(v==='trial')return !!tk.detail[currentTrialId];if(v==='trialPurchase')return !!tk.purchase[currentTrialId];if(v==='trialAlerts')return !!tk.alerts;return false}
async function trialsRefresh(){
  const v=currentView;const r=await trialsKick(v,true);trialsRepaint(v);
  if(v==='trial'&&currentTrialId){const t=tkTabKey(trialTab);if(t==='growth')trialsEnsureGrowth(currentTrialId,true);else if(t==='overview'){loadSpark(currentTrialId,0).then(()=>trialsRepaintTab('overview'));}}
  if(r&&r.ok===false)toast('Refresh failed: '+(r.error||'no answer'));
}
function trialsSetTab(tab){
  trialTab=tkTabKey(tab);const bar=document.getElementById('tkTabBar'),host=document.getElementById('tkTabHost');const d=currentTrialId&&tk.detail[currentTrialId];
  if(!d||!bar||!host){trialsRepaint('trial');trialsEnsureTab();return;}
  bar.outerHTML=renderTabBar(trialTab,d);host.innerHTML=renderTab(d,trialTab,trialsCtx(currentTrialId));
  trialsEnsureTab();
}
function trialsGrowthRange(n){if(!TK_GROWTH_RANGES.includes(Number(n)))return;tk.growthDays=Number(n);trialsRepaintTab('growth');if(currentTrialId)trialsEnsureGrowth(currentTrialId);}
function trialsGrowthReload(){if(currentTrialId)trialsEnsureGrowth(currentTrialId,true);}
function trialsSetAlertFilter(f){trialsAlertFilter=f;trialsRepaint('trialAlerts')}
/* After a machine action: refresh the data behind the current screen (and the board cache) */
async function trialsAfterAction(){
  const v=currentView;
  if(v==='trial'||v==='trialPurchase'){await Promise.all([trialsKick(v,true),loadHub(true)]);}
  else if(TK_TRIAL_VIEWS.includes(v))await trialsKick(v,true);
  else await loadHub(true);
  trialsRepaint(v);
  try{renderNav();updateNotifBadge();}catch(e){}
}
/* Generic POST with optional confirm and busy guard. Returns the machineFetch result. */
async function trialPost(path,body,opts){
  opts=opts||{};
  if(opts.confirm&&typeof confirm==='function'&&!confirm(opts.confirm))return {ok:false,cancelled:true};
  if(tk.busy){toast('Still working on the last action…');return {ok:false,busy:true};}
  tk.busy=true;
  try{
    const r=await machineFetch(path,{method:opts.method||'POST',body});
    if(r.ok){toast(typeof opts.done==='function'?opts.done(r.data||{}):(opts.done||'Done'));if(opts.reload!==false)await trialsAfterAction();}
    else toast((opts.fail||'That did not work')+': '+(r.error||'no answer'));
    return r;
  }finally{tk.busy=false;}
}
function trialsTodoAction(id){
  const t=tkFindTodo(id);if(!t){toast('That to-do is gone — refreshing');trialsRefresh();return;}
  const a=t.action||{};
  switch(a.type){
    case 'api':trialPost(a.path,a.body!==undefined?a.body:{},{method:a.method||'POST',confirm:a.confirm||'',done:'Done — '+(t.text||'')});break;
    case 'view':tkOpenTodoTarget(t);break;
    case 'mc':openMachine(a.path||'/mc');break;
    case 'link':if(tkSafeUrl(a.url))window.open(a.url,'_blank','noopener');break;
    default:break;
  }
}
/* Open the hub screen a to-do points at (used by the to-do buttons and the bell). */
function tkOpenTodoTarget(t){
  const a=(t&&t.action)||{};const cid=a.clientId||t.clientId;if(!cid){render('trials');return;}
  if(a.type==='view'&&a.view==='purchase')openTrialPurchase(cid);
  else if(a.type==='view'&&a.view==='sequence')openTrial(cid,'copy');
  else openTrial(cid,null,a.section||null);
}
/* Application review: approve (onboarding or queue) / decline with a reason */
function trialApproveApplication(id){
  return trialPost('/api/mc/clients/'+encodeURIComponent(id)+'/intake',{action:'approveApplication'},{confirm:'Send '+tkClientName(id)+' the onboarding link now?',done:data=>tkOutcomeText(data,'approve'),fail:'Not approved'});
}
function openDeclineApplication(id){
  const d=tk.detail[id]||{row:tkFindRow(id)||{id}};
  openModal(renderDeclineModal(d));
  setTimeout(()=>{const t=document.getElementById('tkDeclineReason');if(t&&t.focus)t.focus();},60);
}
async function submitDeclineApplication(id){
  const t=document.getElementById('tkDeclineReason'),errEl=document.getElementById('tkDeclineErr'),btn=document.getElementById('tkDeclineBtn');
  const show=m=>{if(errEl)errEl.innerHTML=m?esc(m):'';};
  const reason=((t&&t.value)||'').trim();
  if(!reason){show("Write the reason first — one plain sentence. They'll get it by email.");return {ok:false};}
  if(tk.busy){show('Still working on the last action…');return {ok:false,busy:true};}
  show('');tk.busy=true;if(btn)btn.disabled=true;
  let r;
  try{r=await machineFetch('/api/mc/clients/'+encodeURIComponent(id)+'/intake',{body:{action:'declineApplication',reason}});}
  finally{tk.busy=false;if(btn)btn.disabled=false;}
  if(!r.ok){show(r.data&&r.data.errors?tkErrorList(r.data.errors).join(' · '):(r.error||'The machine did not accept it.'));return r;}
  closeModal();toast(tkOutcomeText(r.data,'decline'));
  await trialsAfterAction();
  return r;
}
/* Research the applicant again (website + Google listing). The machine answers {ok, result:{status}}. */
function trialResearchAgain(id){
  return trialPost('/api/mc/clients/'+encodeURIComponent(id)+'/intake',{action:'rerunResearch'},{done:data=>{const st=String((data.result&&data.result.status)||'').toLowerCase();return st==='done'?'Research finished':st==='failed'?'Research could not finish — see the note':'Research started — it carries on in the background; refresh in a minute';},fail:'Research did not start'});
}
function trialsQueueAction(id,action){
  if(action==='decline'){const reason=typeof prompt==='function'?prompt('Reason for declining '+tkClientName(id)+' (the applicant is told this):',''):null;if(reason===null)return;trialPost('/api/mc/queue',{action:'decline',clientId:id,reason},{done:'Declined'});return;}
  trialPost('/api/mc/queue',{action:'promote',clientId:id},{confirm:'Promote '+tkClientName(id)+' into onboarding now (even over the cap)?',done:'Promoted to onboarding'});
}
function trialsAckAlert(id){trialPost('/api/mc/alerts',{action:'ack',id},{done:'Acknowledged'})}
function trialAction(id,body,opts){return trialPost('/api/mc/clients/'+encodeURIComponent(id),body,opts)}
function trialInboxToggle(id,email,enabled){trialAction(id,{action:'inboxEnabled',email,enabled:!!enabled},{done:enabled?'Inbox switched on':'Inbox switched off'})}
function trialAddInbox(id){
  const g=x=>{const e=document.getElementById(x);return e?e.value.trim():''};
  const email=g('tkIbEmail'),password=(document.getElementById('tkIbPass')||{}).value||'',displayName=g('tkIbName'),provider=g('tkIbProv')||'google';
  if(!email||!/.+@.+\..+/.test(email))return toast('Enter the inbox email address');
  if(!password)return toast('Enter the app password');
  trialAction(id,{action:'addInbox',email,password,displayName,provider},{done:'Inbox added'});
}
function trialRemoveInbox(id,email){trialAction(id,{action:'removeInbox',email},{confirm:'Remove '+email+' from this client?',done:'Inbox removed'})}
function trialDispute(id,bookingId,action){trialPost('/api/mc/clients/'+encodeURIComponent(id)+'/bookings',{bookingId,action},{confirm:(action==='uphold'?'Uphold the dispute (the call does not count)?':'Overturn the dispute (the call counts)?'),done:action==='uphold'?'Dispute upheld':'Dispute overturned'})}
function trialSequenceAction(id,action){
  const body=action==='dispatch'?{action:'dispatch',mode:'refill'}:{action};
  const conf=action==='sendLink'?'Send the approval link to the client now?':action==='dispatch'?'Dispatch Lead Finder for a refill now?':'';
  trialPost('/api/mc/clients/'+encodeURIComponent(id)+'/sequence',body,{confirm:conf,done:action==='sendLink'?'Approval link sent':'Lead Finder dispatched'});
}
function trialIntakeAction(id,action){
  const labels={rerunSetup:['Re-run the full setup check now?','Setup check started'],rerunMarket:['Re-run the market count?','Market count started'],marketOverride:['Override the market count and accept this market as big enough?','Market overridden'],rerunBookingTest:['Test the calendar link now?','Booking test started'],resendWelcome:['Resend the welcome email with the two dates?','Welcome email resent']};
  const l=labels[action]||['Run '+action+'?','Done'];
  const body={action};if(action==='marketOverride')body.note='Overridden from the hub';
  trialPost('/api/mc/clients/'+encodeURIComponent(id)+'/intake',body,{confirm:l[0],done:l[1]});
}
function trialPromiseDone(id,promiseId){trialAction(id,{action:'completePromise',promiseId},{done:'Marked done'})}
function trialAddNote(id){const t=document.getElementById('tkNoteText'),d=document.getElementById('tkNoteDate');const text=t?t.value.trim():'';if(!text)return toast('Type the note first');const body={action:'addNote',text};if(d&&d.value)body.dueDate=d.value;trialAction(id,body,{done:'Note added'})}
function trialSetState(id,to){const lab=TK_STATE_LABEL[to]||to;trialAction(id,{action:'setState',to,reason:'owner (hub)'},{confirm:'Move '+tkClientName(id)+' to "'+lab+'"?',done:'Moved to '+lab})}
function trialMoveState(id){const s=document.getElementById('tkStateSel');const to=s?s.value:'';if(!to)return toast('Pick a state first');const reason=typeof prompt==='function'?prompt('Reason for moving to "'+(TK_STATE_LABEL[to]||to)+'":','owner (hub)'):'owner (hub)';if(reason===null)return;trialAction(id,{action:'setState',to,reason:reason||'owner (hub)'},{done:'Moved to '+(TK_STATE_LABEL[to]||to)})}
function trialRunJob(id){const s=document.getElementById('tkJobSel');const job=s?s.value:'';if(!job)return toast('Pick a job first');trialAction(id,{action:'runJob',job},{confirm:'Run the "'+job+'" job for '+tkClientName(id)+' now?',done:'Job "'+job+'" ran'})}
function trialSimple(id,action,confirmText){trialAction(id,{action},{confirm:confirmText||'',done:'Done'})}
function trialLogTime(id){const i=document.getElementById('tkMinutes');const minutes=Math.round(Number(i?i.value:''));if(!minutes||minutes<1||minutes>600)return toast('Enter minutes between 1 and 600');trialAction(id,{action:'logTime',minutes},{done:minutes+' min logged'})}
function trialCopyLink(url){try{navigator.clipboard.writeText(url).then(()=>toast('Link copied'),()=>toast('Could not copy — select it and copy by hand'));}catch(e){toast('Could not copy — select it and copy by hand');}}
function trialsPurchaseAddRow(){const host=document.getElementById('pcRows');if(host)host.insertAdjacentHTML('beforeend',renderPurchaseRow('',''))}
/* "Use this domain" on the comparison table: fills the paste form's domain box. */
function trialsUseDomain(domain){
  const i=document.getElementById('pcDomain');if(!i)return;
  const fs=document.getElementById('tkPcForm');if(fs&&fs.disabled){toast('The paste form is closed for this client');return;}
  const prev=String(i.value||'').trim().toLowerCase();i.value=domain;
  /* prefilled sender addresses follow the chosen domain (only ones still on the old domain) */
  if(prev&&prev!==domain)document.querySelectorAll('#pcRows .pc-email').forEach(e=>{const v=String(e.value||'');if(v.toLowerCase().endsWith('@'+prev))e.value=v.slice(0,v.length-prev.length)+domain;});
  document.querySelectorAll('.tk-offer').forEach(r=>r.classList.toggle('chosen',r.getAttribute('data-domain')===domain));
  try{i.scrollIntoView({block:'center'});i.focus();}catch(e){}
  toast(domain+' is filled in — buy it, then paste the logins');
}
async function submitTrialPurchase(id){
  const errEl=document.getElementById('pcErr');const show=list=>{if(errEl)errEl.innerHTML=list.map(e=>esc(e)).join('<br>');};
  show([]);
  const domain=(document.getElementById('pcDomain')||{}).value||'';
  const auto=document.getElementById('pcAutoRenew');
  const rows=[...document.querySelectorAll('#pcRows .tk-pc-row')].map(r=>({email:(r.querySelector('.pc-email')||{}).value||'',password:(r.querySelector('.pc-pass')||{}).value||'',displayName:(r.querySelector('.pc-name')||{}).value||''})).map(x=>({email:x.email.trim(),password:x.password,displayName:x.displayName.trim()})).filter(x=>x.email||x.password||x.displayName);
  const errs=[];
  if(!domain.trim())errs.push('Enter the domain you bought.');
  if(!auto||!auto.checked)errs.push('Tick "Auto-renew is off" — the machine will not proceed otherwise.');
  rows.forEach((x,i)=>{if(!/.+@.+\..+/.test(x.email))errs.push('Inbox '+(i+1)+': enter a valid email.');if(!x.password)errs.push('Inbox '+(i+1)+': enter the app password.');});
  if(!rows.length)errs.push('Paste at least one inbox (the trial expects two).');
  if(errs.length)return show(errs);
  if(rows.length<2&&typeof confirm==='function'&&!confirm('Only one inbox pasted — the trial expects two. Continue anyway?'))return;
  const r=await trialPost('/api/mc/clients/'+encodeURIComponent(id)+'/purchase',{domain:domain.trim(),autoRenewOff:true,inboxes:rows},{done:'Logins saved — the setup check is running',fail:'Not saved',reload:false});
  if(r&&r.ok){delete tk.purchase[id];await trialsAfterAction();}
  else if(r&&r.data&&r.data.errors)show(tkErrorList(r.data.errors));
  else if(r&&r.error)show([r.error]);
}
/* New client modal (topbar button, ⌘K, the empty board). `prefill` is optional. */
function openNewTrialClient(prefill){
  if(!trialsIsAdmin())return;prefill=prefill||{};
  openModal(`<div class="modal-head"><div><h3>New trial client</h3><p>Pre-approved — the machine skips the fit rules and starts onboarding (or queues them if three trials are running).</p></div></div>
    <div class="modal-body">
      <div class="field"><label>Company name</label><input id="ntCompany" value="${esc(prefill.companyName||'')}" placeholder="Acme Plumbing"></div>
      <div class="field row2"><div><label>Contact name</label><input id="ntContact" value="${esc(prefill.contactName||'')}" placeholder="Ann Lee"></div><div><label>Contact email</label><input id="ntEmail" type="email" value="${esc(prefill.contactEmail||'')}" placeholder="ann@acme.com"></div></div>
      <div class="field"><label>Website</label><input id="ntWebsite" value="${esc(prefill.website||'')}" placeholder="https://acme.com"></div>
      <label class="tk-check"><input id="ntOverride" type="checkbox"> Override the 3-trial cap (and the no-new-trials-during-extension rule)</label>
      <div id="ntErr" class="tk-modal-errs"></div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="ntSubmit" onclick="submitNewTrialClient()">Create trial</button></div>`);
  setTimeout(()=>{const n=document.getElementById(prefill.companyName?'ntWebsite':'ntCompany');if(n)n.focus();},60);
}
async function submitNewTrialClient(){
  const g=x=>{const e=document.getElementById(x);return e?e.value.trim():''};
  const errEl=document.getElementById('ntErr');const show=list=>{if(errEl)errEl.innerHTML=list.map(e=>esc(e)).join('<br>');};
  const body={companyName:g('ntCompany'),contactName:g('ntContact'),contactEmail:g('ntEmail'),website:g('ntWebsite')};
  const ov=document.getElementById('ntOverride');if(ov&&ov.checked)body.override=true;
  const errs=[];if(!body.companyName)errs.push('Company name is required.');if(!body.contactName)errs.push('Contact name is required.');if(!/.+@.+\..+/.test(body.contactEmail))errs.push('A valid contact email is required.');if(!body.website)errs.push('Website is required.');
  if(errs.length)return show(errs);
  const btn=document.getElementById('ntSubmit');if(btn)btn.disabled=true;
  show([]);
  const r=await machineFetch('/api/mc/clients/new',{body});
  if(btn)btn.disabled=false;
  if(!r.ok){show(r.data&&r.data.errors?tkErrorList(r.data.errors):[r.error||'The machine did not accept it.']);return;}
  const clientId=r.data&&r.data.clientId;const state=r.data&&r.data.state;
  closeModal();
  toast(`${body.companyName} created${state?' — '+(TK_STATE_LABEL[state]||state):''}`);
  await loadHub(true);
  if(clientId)openTrial(clientId);else render('trials');
}

/* ===================== 8. SHELL INTEGRATION ===================== */
function trialsNavCount(){const m=tk.hub&&tk.hub.machine;if(!m||m.activeTrials==null)return '';const n=Number(m.activeTrials);return n>0?n:''}
function trialsAlertCount(){const m=tk.hub&&tk.hub.machine;let n=m&&m.openAlerts!=null?Number(m.openAlerts):(tk.hub?(tk.hub.alerts||[]).length:0);return n>0?n:''}
function trialsNotifs(){
  const n=[];if(!trialsIsAdmin()||!tk.hub)return n;
  (tk.hub.todos||[]).filter(t=>t.urgent).forEach(t=>n.push({dot:'var(--red)',t:t.text||'To-do',s:(t.clientName||t.clientId||'Trial')+(t.detail?' · '+t.detail:''),go:()=>tkOpenTodoTarget(t)}));
  (tk.hub.alerts||[]).filter(a=>a.urgent&&!a.acknowledged).forEach(a=>n.push({dot:'var(--red)',t:a.title||a.key||'Machine alert',s:'Machine alert'+(a.clientId?' · '+tkClientName(a.clientId):''),go:()=>render('trialAlerts')}));
  return n;
}
function trialsCmdkActions(){
  return [
    {type:'Create',label:'New trial client',icon:I.trials||'',sub:'Start a trial on the machine',kw:'new trial client create start',run:()=>{closeCmdk();openNewTrialClient();}},
    {type:'Go to',label:'Trials board',icon:I.trials||'',sub:'Trials',kw:'trials board machine',run:()=>{closeCmdk();render('trials');}},
    {type:'Go to',label:'Machine alerts',icon:I.bell||'',sub:'Trials',kw:'machine alerts trials',run:()=>{closeCmdk();render('trialAlerts');}},
  ];
}
function trialsCmdkEntities(){
  if(!tk.hub)return [];
  return tkAllRows(tk.hub).map(r=>({type:'Trial',label:r.name||r.id,icon:I.trials||'',sub:tkStateLabel(r)+' · trial:'+r.id,kw:'trial:'+r.id+' '+(r.name||'')+' '+tkStateLabel(r)+' '+(r.contactName||''),run:()=>{closeCmdk();openTrial(r.id);}}));
}
/* Called by the shell's render(): explicit navigation — the only place growth fetches start. */
function trialsOnRender(v){
  if(TK_TRIAL_VIEWS.includes(v))trialsStartTimer();else trialsStopTimer();
  if(v==='trial'){trialsApplyScroll();trialsEnsureTab();}
  if(v==='trials')trialsSparkBoot();
}
/* Sign-out: drop every cached answer, including the sparkline history kept in localStorage. */
function trialsForget(){
  trialsStopTimer();
  Object.assign(tk,{hub:null,hubAt:0,hubErr:null,detail:{},detailAt:{},detailErr:{},alerts:null,alertsAt:0,alertsErr:null,purchase:{},purchaseAt:{},purchaseErr:{},growth:{},growthErr:{},growthBusy:{},spark:{},sparkErr:{},sparkBusy:{}});
  currentTrialId=null;trialTab='overview';
  try{localStorage.removeItem(TK_SPARK_KEY);}catch(e){}
}
function trialsStartTimer(){if(tk.timer)return;tk.timer=setInterval(trialsTick,TK_REFRESH_MS);}
function trialsStopTimer(){if(tk.timer){clearInterval(tk.timer);tk.timer=null;}}
/* The 60-second auto-refresh: board/detail/alerts only — it never asks for growth history. */
async function trialsTick(){
  if(!TK_TRIAL_VIEWS.includes(currentView)){trialsStopTimer();return;}
  if(currentView==='trialPurchase')return;          // never disturb the paste form
  if(typeof document!=='undefined'&&document.hidden)return;
  if(tk.busy||tkFormDirty())return;
  await trialsKick(currentView,true);
}

/* ===================== 4b. CHART HOVER (DOM) ===================== */
/* Crosshair + one tooltip listing every series for the day under the pointer; arrow keys move it.
   Built with textContent — the tooltip never parses machine text as HTML. */
function tkChartTipAt(el,i){
  let tips;try{tips=JSON.parse(el.getAttribute('data-tips')||'[]');}catch(e){tips=[];}
  const n=Number(el.getAttribute('data-n'))||tips.length||1;i=Math.max(0,Math.min(n-1,i|0));el._tkI=i;
  const cur=el.querySelector('.tk-cursor'),tip=el.querySelector('.tk-tip');const t=tips[i];if(!cur||!tip||!t)return;
  const pct=(i+.5)/n*100;cur.style.left=pct+'%';cur.style.display='block';
  tip.textContent='';
  const h=document.createElement('div');h.className='tk-tip-day';h.textContent=t.d||'';tip.appendChild(h);
  (t.r||[]).forEach(row=>{const line=document.createElement('div');line.className='tk-tip-row';
    if(row[2]){const k=document.createElement('i');k.className='tk-key-line';k.style.background='var('+row[2]+')';line.appendChild(k);}
    const b=document.createElement('b');b.textContent=row[0];line.appendChild(b);line.appendChild(document.createTextNode(' '+row[1]));tip.appendChild(line);});
  if(t.note){const nn=document.createElement('div');nn.className='tk-tip-note';nn.textContent=t.note;tip.appendChild(nn);}
  tip.style.display='block';
  const w=el.clientWidth,tw=tip.offsetWidth,x=pct/100*w;let left=x+12;if(left+tw>w)left=x-tw-12;if(left<0)left=Math.max(0,Math.min(w-tw,x-tw/2));tip.style.left=left+'px';
}
function tkChartTip(evt,el){const r=el.getBoundingClientRect();const n=Number(el.getAttribute('data-n'))||1;tkChartTipAt(el,Math.floor((evt.clientX-r.left)/Math.max(1,r.width)*n))}
function tkChartKey(evt,el){if(evt.key==='ArrowLeft'||evt.key==='ArrowRight'){evt.preventDefault();const n=Number(el.getAttribute('data-n'))||1;const i=(el._tkI==null?n-1:el._tkI)+(evt.key==='ArrowRight'?1:-1);tkChartTipAt(el,i);}else if(evt.key==='Escape')tkChartTipHide(el)}
function tkChartTipHide(el){const c=el.querySelector('.tk-cursor'),t=el.querySelector('.tk-tip');if(c)c.style.display='none';if(t)t.style.display='none'}
