/* ============================================================================
   trials.js — Aviance Hub · Trials section
   ----------------------------------------------------------------------------
   The hub's window onto the Aviance Trial Machine (email-distributor). The
   machine does all the work; this file only shows and steers it through the
   contract in email-distributor/docs/HUB-API.md.

   Loaded by index.html after the main script, so it can use the hub's globals:
     esc, kpi, emptyState, toast, openModal, closeModal, render, renderNav,
     updateNotifBadge, I (icons), sb (Supabase client), authUser, currentView,
     currentRole, MACHINE_URL, leads, saveDB, todayShort, openLead.

   Layout of this file
     0. constants + in-memory cache
     1. pure helpers (time, numbers, pills)         — no DOM, no network
     2. machine client: machineFetch + SSO opener   — network plumbing
     3. loaders (fill the cache)
     4. pure renderers (data → HTML string)          — what the tests call
     5. views the hub router calls (viewTrials …)
     6. actions wired to buttons
     7. hub integration (nav counts, notifications, ⌘K, dashboard, CRM, timer)

   Rules: every user-supplied string goes through esc(); render functions
   never touch the DOM; nothing runs at load time.
   ========================================================================== */

/* ===================== 0. CONSTANTS + CACHE ===================== */
const TK_STAGE_ORDER=['intake','onboard','setup','build','live','decide','won','closing','ended'];
const TK_SYSTEM_ORDER=['intake','market','purchase','setup','warmup','list','copy','canary','sending','replies','calls','reports','closing'];
const TK_STATE_LABEL={applied:'Applied',queued:'In the queue',onboarding:'Onboarding',awaiting_purchase:'Waiting for you to buy',setup_check:'Checking the setup',warming:'Warming up',ready:'Ready for Day 1',sending:'Sending',paused:'Paused',extension:'Free extension',deciding:'Deciding',converted:'Converted',not_now:'Not now',retired:'Retired',deleted:'Deleted',declined:'Declined',closed_silent:'Never finished onboarding'};
const TK_SETUP_NAMES={migrated:'migration',encKey:'ENC_KEY',cronSecret:'CRON_SECRET',telegram:'Telegram',healthchecks:'Healthchecks',ownerInbox:'owner inbox'};
const TK_FIVE=[['sent','Sent'],['replies','Repl'],['positive','Pos'],['booked','Booked'],['qualified','Qual']];
const TK_COUNTERS=[['sent','Sent'],['companiesContacted','Companies'],['bounces','Bounces'],['replies','Replies'],['positive','Positive'],['booked','Booked'],['held','Held'],['qualified','Qualified'],['noshows','No-shows'],['wrongfit','Wrong fit'],['warmupSent','Warm-up sent'],['warmupInbox','Warm-up inbox'],['warmupSpam','Warm-up spam'],['warmupRescued','Warm-up rescued']];
const TK_TABS=[['numbers','Numbers'],['inboxes','Inboxes'],['calls','Calls'],['replies','Replies'],['copy','Copy'],['setup','Setup'],['reports','Reports'],['promises','Promises'],['timeline','Timeline'],['upcoming','Upcoming'],['actions','Actions']];
const TK_TRIAL_VIEWS=['trials','trial','trialPurchase','trialAlerts'];
const TK_REFRESH_MS=60000;   // auto-refresh while a trials view is open
const TK_FRESH_MS=15000;     // a cached answer younger than this is not re-fetched on navigation

/* Last good answers live here so navigating back is instant. */
const tk={hub:null,hubAt:0,hubErr:null,detail:{},detailAt:{},detailErr:{},alerts:null,alertsAt:0,alertsErr:null,purchase:{},purchaseAt:{},purchaseErr:{},timer:null,busy:false,newLeadId:null};
let currentTrialId=null;
let trialTab='numbers';
let trialsAlertFilter='open';

/* ===================== 1. PURE HELPERS ===================== */
function tkMachineUrl(){return typeof MACHINE_URL==='string'?MACHINE_URL:'https://email-distributor.vercel.app'}
/* Safe argument for an inline onclick="fn(...)" — JSON string literal, then HTML-escaped. */
function tkAttr(v){return esc(JSON.stringify(v==null?'':String(v)))}
function tkTruthy(v){return v===true||v===1||v==='1'||v==='true'}
function tkNum(n){if(n==null||n==='')return '—';const x=Number(n);return isNaN(x)?esc(n):x.toLocaleString()}
function tkRate(x){if(x==null||x==='')return '—';const n=Number(x);return isNaN(n)?esc(x):Math.round(n*100)+'%'}
function tkPct(x){if(x==null||x==='')return '—';const n=Number(x);return isNaN(n)?esc(x):Math.round(n)+'%'}
function tkMoney(n){if(n==null||n==='')return '—';const x=Number(n);return isNaN(x)?esc(n):'$'+x.toFixed(2)}
function tkParseDate(v){if(!v)return null;if(v instanceof Date)return isNaN(v)?null:v;const s=String(v);const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s);if(m)return new Date(+m[1],+m[2]-1,+m[3]);const d=new Date(s);return isNaN(d)?null:d}
function tkRel(v,now){const d=tkParseDate(v);if(!d)return '—';const diff=((now||new Date())-d)/1000;const a=Math.abs(diff);
  const f=a<5?'':a<60?Math.round(a)+' s':a<3600?Math.round(a/60)+' min':a<172800?Math.round(a/3600)+' h':Math.round(a/86400)+' d';
  if(!f)return 'just now';return diff>=0?f+' ago':'in '+f}
function tkDate(v){const d=tkParseDate(v);if(!d)return '—';const y=d.getFullYear()!==new Date().getFullYear();return d.toLocaleDateString(undefined,y?{month:'short',day:'numeric',year:'numeric'}:{month:'short',day:'numeric'})}
function tkDateTime(v){const d=tkParseDate(v);if(!d)return '—';return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}
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
function tkAllRows(hub){const out=[];if(!hub)return out;(hub.stages||[]).forEach(s=>(s.clients||[]).forEach(r=>out.push(r)));((hub.machine&&hub.machine.others)||[]).forEach(r=>out.push(r));return out}
function tkFindRow(id){if(!id)return null;const rows=tkAllRows(tk.hub);let r=rows.find(x=>x.id===id);if(!r&&tk.detail[id]&&tk.detail[id].row)r=tk.detail[id].row;return r||null}
function tkClientName(id){const r=tkFindRow(id);return r&&r.name?r.name:(id||'')}
function tkSortedStages(stages){return (stages||[]).slice().sort((a,b)=>{const ia=TK_STAGE_ORDER.indexOf(a.key),ib=TK_STAGE_ORDER.indexOf(b.key);return (ia<0?99:ia)-(ib<0?99:ib)})}
function tkSortedSystems(systems){return (systems||[]).slice().sort((a,b)=>{const ia=TK_SYSTEM_ORDER.indexOf(a.key),ib=TK_SYSTEM_ORDER.indexOf(b.key);return (ia<0?99:ia)-(ib<0?99:ib)})}
function tkTodoLabel(t){const a=(t&&t.action)||{};if(a.label)return a.label;switch(a.type){case 'api':return 'Do it';case 'view':return a.view==='purchase'?'Buy & paste':a.view==='sequence'?'Open copy':'Open trial';case 'mc':return 'Open in Mission Control';case 'link':return 'Open link';default:return ''}}
function tkFindTodo(id){const all=[];if(tk.hub)(tk.hub.todos||[]).forEach(t=>all.push(t));tkAllRows(tk.hub).forEach(r=>(r.todo||[]).forEach(t=>all.push(Object.assign({clientId:r.id,clientName:r.name},t))));Object.keys(tk.detail).forEach(k=>{const d=tk.detail[k];if(d&&d.row)(d.row.todo||[]).forEach(t=>all.push(Object.assign({clientId:d.row.id,clientName:d.row.name},t)))});return all.find(t=>t.id===id)||null}

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
  if(r.ok&&r.data&&r.data.row){tk.detail[id]=r.data;tk.detailAt[id]=Date.now();delete tk.detailErr[id];}
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

/* ===================== 4. PURE RENDERERS (data → HTML) ===================== */
function renderLoading(msg){return `<div class="card tk-loading">${esc(msg||'Reaching the machine…')}</div>`}
function renderMachineError(reason,retryFn){
  return `<div class="card tk-err"><b>The machine isn't reachable from the hub yet</b><p>${esc(reason||'No answer.')}</p>
    <div class="tk-inline"><button class="btn" onclick="${esc(retryFn||'trialsRetry()')}">Try again</button><span class="tk-updated">Machine · ${esc(tkMachineUrl())}</span></div></div>`;
}
function tkUpdatedStamp(at){return at?`<span class="tk-updated" title="${esc(tkFull(new Date(at)))}">Updated ${esc(tkRel(new Date(at)))}</span>`:''}
/* Shown above cached data when the latest refresh failed — the screen stays useful, but says so. */
function renderStaleNote(err,at){if(!err)return '';return `<div class="tk-note red">Couldn't refresh from the machine — showing what it said ${esc(at?tkRel(new Date(at)):'earlier')}. ${esc(err)} <span style="cursor:pointer;text-decoration:underline" onclick="trialsRetry()">Try again</span></div>`}

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
  const notOk=machine.ok===false?`<div class="tk-setupline" style="color:var(--red)">The machine reports it is not OK${machine.error?' — '+esc(machine.error):''}.</div>`:'';
  return `<div class="card tk-bar">
    <div class="tk-stat">${tkDot(hbClass)}<div><small>Heartbeat</small><b>${esc(hbText)}${hb.source?` <span>· ${esc(hb.source)}</span>`:''}</b></div></div>
    <div class="tk-stat"><div><small>Last send</small><b>${esc(hb.lastSendAt?tkRel(hb.lastSendAt,meta.now):'—')}</b></div></div>
    <div class="tk-stat"><div><small>Active trials</small><b>${tkNum(machine.activeTrials)} <span>/ ${tkNum(machine.maxActiveTrials)}</span></b></div></div>
    <div class="tk-stat"><div><small>Extensions</small><b>${tkNum(machine.extensions)}</b></div></div>
    <div class="tk-stat"><div><small>Open alerts</small><b${Number(machine.openAlerts)>0?' style="color:var(--red)"':''}>${tkNum(machine.openAlerts)}</b></div></div>
    <div class="tk-stat"><div><small>Usage</small><b>${usage.length?esc(usage.join(' · ')):'—'}</b></div></div>
    <div class="tk-right">${tkUpdatedStamp(meta.at)}<button class="btn ghost" onclick="trialsRefresh()">Refresh</button><button class="btn ghost" onclick="openMachine('/mc')">Mission Control ↗</button></div>
    ${missing.length?`<div class="tk-setupline">Machine setup: still to set — ${esc(missing.join(', '))}. <span style="cursor:pointer;text-decoration:underline" onclick="openMachine('/mc/config')">Open config</span></div>`:''}
    ${notOk}
  </div>`;
}

/* -- to-dos -- */
function renderTodoButton(t){const label=tkTodoLabel(t);if(!label)return '';const a=t.action||{};const cls=a.type==='api'||(a.type==='view'&&a.view==='purchase')?'btn':'btn ghost';return `<button class="${cls}" onclick="trialsTodoAction(${tkAttr(t.id)})">${esc(label)}</button>`}
function renderTodos(todos,opts){
  opts=opts||{};todos=(todos||[]).slice().sort((a,b)=>(b.urgent?1:0)-(a.urgent?1:0));
  const title=opts.title||'What you need to do';
  const body=todos.length?todos.map(t=>{
    const client=!opts.hideClient&&(t.clientName||t.clientId)?`<span class="tk-client" onclick="openTrial(${tkAttr(t.clientId)})">${esc(t.clientName||t.clientId)}</span> · `:'';
    return `<div class="tk-todo ${t.urgent?'urgent':''}">
      ${t.urgent?'<span class="pill red">Urgent</span>':tkDot('grey')}
      <div class="tk-todo-main"><b>${esc(t.text||'')}</b><small>${client}${t.detail?esc(t.detail)+' · ':''}<span class="tk-since" title="Due since ${esc(tkFull(t.since))}">${esc(tkRel(t.since,opts.now))}</span></small></div>
      <div class="tk-todo-act">${renderTodoButton(t)}</div>
    </div>`}).join(''):`<div class="tk-todo-empty">${esc(opts.empty||'Nothing waiting on you.')}</div>`;
  return `<div class="section-head tk-section"><h3>${esc(title)}</h3><span class="count">${todos.length}</span></div><div class="card tk-todos">${body}</div>`;
}

/* -- board -- */
function renderFive(five){five=five||null;return `<div class="tk-five">${TK_FIVE.map(([k,l])=>`<div><b>${tkNum(five?five[k]:null)}</b><small>${l}</small></div>`).join('')}</div>`}
function renderTrialCard(row){
  row=row||{};const todo=(row.todo||[])[0];const alerts=Number(row.openAlerts)||0;const urgent=Number(row.urgentAlerts)||0;
  return `<div class="tk-card" onclick="openTrial(${tkAttr(row.id)})">
    <div class="tk-card-top"><b>${esc(row.name||row.id||'—')}</b>${tkDot(tkHealthClass(row.health))}</div>
    <span class="tk-state">${esc(tkStateLabel(row))}</span>
    ${renderFive(row.five)}
    <div class="tk-card-meta"><span>Inbox rate ${tkRate(row.inboxRate)}</span>${alerts?`<span class="pill ${urgent?'red':'amber'}">${alerts} alert${alerts!==1?'s':''}</span>`:''}</div>
    ${todo?`<div class="tk-card-todo ${todo.urgent?'urgent':''}">${todo.urgent?'! ':'→ '}${esc(todo.text||'')}</div>`:''}
    ${row.nextUp&&row.nextUp.what?`<div class="tk-card-next">Next · ${esc(tkDate(row.nextUp.date))} · ${esc(row.nextUp.what)}</div>`:''}
  </div>`;
}
function renderStages(stages){
  const cols=tkSortedStages(stages).filter(s=>s.key!=='ended'||(s.clients&&s.clients.length));
  if(!cols.length)return '';
  return `<div class="tk-board">${cols.map(s=>`<div class="tk-col"><div class="tk-col-head"><b>${esc(s.label||s.key)}</b><span class="ct">${(s.clients||[]).length}</span></div>${(s.clients||[]).length?(s.clients||[]).map(renderTrialCard).join(''):'<div class="tk-empty-col">—</div>'}</div>`).join('')}</div>`;
}
function renderQueue(queue){
  queue=queue||[];if(!queue.length)return '';
  return `<div class="section-head tk-section"><h3>Queue</h3><span class="count">${queue.length}</span></div>
  <div class="tk-grid">${queue.map(q=>`<div class="card tk-mini"><b>${esc(q.position!=null?'#'+q.position+' · ':'')}${esc(q.name||q.id)}</b><small>Expected ${esc(tkDate(q.expectedDate))}${q.contactEmail?' · '+esc(q.contactEmail):''}</small>
    <div class="tk-acts"><button class="btn" onclick="trialsQueueAction(${tkAttr(q.id)},'promote')">Promote</button><button class="btn ghost" onclick="trialsQueueAction(${tkAttr(q.id)},'decline')">Decline</button></div></div>`).join('')}</div>`;
}
function renderOthers(others){
  others=others||[];if(!others.length)return '';
  return `<div class="section-head tk-section"><h3>Also on the machine</h3><span class="count">${others.length}</span></div>
  <div class="tk-grid">${others.map(r=>`<div class="card tk-mini click" onclick="openTrial(${tkAttr(r.id)})"><div class="tk-card-top"><b>${esc(r.name||r.id)}</b>${tkDot(tkHealthClass(r.health))}</div><small>${esc(tkStateLabel(r))}</small>${renderFive(r.five)}</div>`).join('')}</div>`;
}
function renderBoard(hub,meta){
  hub=hub||{};meta=meta||{};const machine=hub.machine||{};
  const rows=tkAllRows({stages:hub.stages});
  const toolbar=`<div class="toolbar"><span class="muted" style="font-size:12.5px">${rows.length} trial${rows.length!==1?'s':''} on the machine · ${(hub.todos||[]).length} thing${(hub.todos||[]).length!==1?'s':''} waiting on you</span>
    <div style="margin-left:auto" class="tk-inline"><button class="btn ghost" onclick="render('trialAlerts')">${I.bell||''}Machine alerts${machine.openAlerts?` <span class="badge" style="background:var(--surface-3);color:var(--muted);font-size:10px;padding:1px 6px">${tkNum(machine.openAlerts)}</span>`:''}</button><button class="btn" onclick="openNewTrialClient()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14"/></svg>New client</button></div></div>`;
  const stages=renderStages(hub.stages);
  const board=rows.length?stages:emptyState(I.trials||I.grid,'No trials yet','Add the first client — the machine takes it from application to booked calls, and tells you here whenever it needs you.','New client','openNewTrialClient()');
  return toolbar+renderMachineBar(machine,{at:meta.at,now:meta.now})+renderTodos(hub.todos,{now:meta.now})+
    `<div class="section-head tk-section"><h3>Stages</h3><span class="count">${rows.length}</span></div>`+board+renderQueue(machine.queue)+renderOthers(machine.others);
}

/* -- trial detail -- */
function renderSystems(systems){
  const list=tkSortedSystems(systems);
  if(!list.length)return '<div class="card"><div class="tk-todo-empty">No system cards yet.</div></div>';
  return `<div class="tk-sys">${list.map(s=>{const st=String(s.status||'off').toLowerCase();const det=Array.isArray(s.detail)?s.detail:(s.detail?[s.detail]:[]);
    return `<div class="card tk-sys-card ${esc(st)}"><div class="tk-sys-top"><b>${esc(s.label||s.key)}</b>${tkStatusPill(st)}</div>${s.line?`<div class="tk-sys-line">${esc(s.line)}</div>`:''}${det.length?`<ul class="tk-sys-detail">${det.map(d=>`<li>${esc(tkDetailText(d))}</li>`).join('')}</ul>`:''}</div>`}).join('')}</div>`;
}
function renderTabBar(active){return `<div class="tk-tabs" id="tkTabBar"><div class="seg">${TK_TABS.map(([k,l])=>`<button class="${k===active?'active':''}" onclick="trialsSetTab(${tkAttr(k)})">${l}</button>`).join('')}</div></div>`}
function renderTrialHeader(d,meta){
  const row=d.row||{};const id=row.id;const reasons=(row.healthReasons||[]).filter(Boolean);
  const canBuy=['awaiting_purchase','setup_check'].includes(row.state);
  return `<div class="card tk-head">
    <div class="tk-head-main">
      <h2>${tkDot(tkHealthClass(row.health))}${esc(row.name||id||'—')}</h2>
      <div class="tk-pills"><span class="pill grey">${esc(tkStateLabel(row))}</span>${row.trialDay!=null?`<span class="pill blue">Day ${esc(row.trialDay)}</span>`:''}${row.plan?`<span class="pill grey">${esc(row.plan)}</span>`:''}${Number(row.openAlerts)?`<span class="pill ${Number(row.urgentAlerts)?'red':'amber'}">${tkNum(row.openAlerts)} open alert${Number(row.openAlerts)!==1?'s':''}</span>`:''}</div>
      ${reasons.length?`<div class="tk-reasons">${reasons.map(r=>esc(r)).join(' · ')}</div>`:''}
      <div class="tk-meta">${esc(row.contactName||'—')}${row.contactEmail?` · <a href="mailto:${esc(row.contactEmail)}">${esc(row.contactEmail)}</a>`:''}${row.website?` · <a href="${esc(row.website)}" target="_blank" rel="noopener">${esc(row.website.replace(/^https?:\/\//,''))}</a>`:''}<span class="tk-mono tk-muted"> · ${esc(id||'')}</span></div>
      <div class="tk-dates"><div><small>Day 1</small><b>${esc(tkDate(row.day1Date))}</b></div><div><small>Day 30</small><b>${esc(tkDate(row.day30Date))}</b></div><div><small>Inbox rate</small><b>${tkRate(row.inboxRate)}</b></div>${meta&&meta.at?`<div><small>Updated</small><b title="${esc(tkFull(new Date(meta.at)))}">${esc(tkRel(new Date(meta.at)))}</b></div>`:''}</div>
    </div>
    <div class="tk-btns"><button class="btn ghost" onclick="render('trials')">← Board</button><button class="btn ghost" onclick="trialsRefresh()">Refresh</button>${canBuy?`<button class="btn" onclick="openTrialPurchase(${tkAttr(id)})">Buy & paste</button>`:''}<button class="btn ghost" onclick="openMachine(${tkAttr('/mc/clients/'+id)})">Mission Control ↗</button></div>
  </div>`;
}
function renderStatTiles(pairs){return `<div class="tk-stats">${pairs.map(([l,v])=>`<div class="card tk-stat-tile"><small>${esc(l)}</small><b>${v}</b></div>`).join('')}</div>`}
function renderNumbersTab(d){
  const c=d.counters||{};const seen=new Set(TK_COUNTERS.map(x=>x[0]));
  const tiles=TK_COUNTERS.map(([k,l])=>[l,tkNum(c[k])]);Object.keys(c).filter(k=>!seen.has(k)).forEach(k=>tiles.push([k,tkNum(c[k])]));
  const rbk=d.repliesByKind||{};const kinds=Object.keys(rbk);
  const lbs=d.leadsByStatus||{};const lst=Object.keys(lbs);
  const lf=d.leadfinder||null;const inv=d.invoice||null;const pace=d.pacelog||[];
  return renderStatTiles(tiles)+
    `<div class="section-head tk-section"><h3>Replies by kind</h3></div><div class="card" style="padding:14px"><div class="tk-pills">${kinds.length?kinds.map(k=>`<span class="pill ${tkKindClass(k)}">${esc(k)} · ${tkNum(rbk[k])}</span>`).join(''):'<span class="tk-muted tk-small">No replies yet.</span>'}</div></div>`+
    `<div class="section-head tk-section"><h3>Leads</h3></div><div class="card" style="padding:14px"><div class="tk-pills">${lst.length?lst.map(k=>`<span class="pill grey">${esc(k)} · ${tkNum(lbs[k])}</span>`).join(''):'<span class="tk-muted tk-small">No leads loaded yet.</span>'}</div>${lf?`<div class="tk-mono tk-muted" style="margin-top:10px">Lead Finder · ${esc(lf.status||'—')} · found ${tkNum(lf.found)} of ${tkNum(lf.need)} needed${lf.lastRunAt?' · last run '+esc(tkRel(lf.lastRunAt)):''}</div>`:''}</div>`+
    (inv?`<div class="section-head tk-section"><h3>Invoice</h3></div><div class="card" style="padding:14px"><div class="tk-kv"><small>Number</small><span class="mono">${esc(inv.number||'—')}</span><small>Amount</small><span class="mono">${tkMoney(inv.amount)}</span><small>Issued</small><span>${esc(tkDate(inv.issuedAt))}</span><small>Due</small><span>${esc(tkDate(inv.dueDate))}</span><small>Paid</small><span>${inv.paidAt?'<span class="pill green">Paid '+esc(tkDate(inv.paidAt))+'</span>':'<span class="pill amber">Unpaid</span>'}</span></div></div>`:'')+
    (pace.length?`<div class="section-head tk-section"><h3>Pace checks</h3><span class="count">${pace.length}</span></div><div class="card tk-scroll"><table class="tk-table"><tr><th>When</th><th>Day</th><th>Test</th><th>Fix</th></tr>${pace.map(p=>`<tr><td class="mono">${esc(tkDateTime(p.at))}</td><td class="mono">${esc(p.day!=null?p.day:'—')}</td><td class="wrap">${esc(p.test||'')}</td><td class="wrap">${esc(p.fix||'')}</td></tr>`).join('')}</table></div>`:'');
}
function renderInboxesTab(d){
  const id=(d.row||{}).id;const list=d.inboxes||[];
  const rows=list.map(ib=>{const on=tkTruthy(ib.enabled);const h=String(ib.health||'').toLowerCase();
    return `<tr><td class="wrap"><b>${esc(ib.email||'—')}</b><div class="tk-muted tk-small">${esc(ib.displayName||'')}${ib.provider?' · '+esc(ib.provider):''}${ib.hasPassword===false?' · <span style="color:var(--red)">no password stored</span>':''}</div></td>
      <td><input type="checkbox" ${on?'checked':''} onchange="trialInboxToggle(${tkAttr(id)},${tkAttr(ib.email)},this.checked)" title="Enabled"></td>
      <td class="mono">${tkNum(ib.dailyCap)}</td><td class="mono">${tkRate(ib.inboxRate7d)}</td><td class="mono">${tkRate(ib.canaryPlacement)}</td>
      <td>${h?`<span class="pill ${h==='ok'?'green':'amber'}">${esc(h)}</span>`:'—'}${ib.disabledReason?`<div class="tk-muted tk-small">${esc(ib.disabledReason)}</div>`:''}</td>
      <td class="mono">${esc(ib.warmupStartedAt?tkDate(ib.warmupStartedAt):'—')}</td>
      <td><button class="btn ghost" onclick="trialRemoveInbox(${tkAttr(id)},${tkAttr(ib.email)})">Remove</button></td></tr>`}).join('');
  return `<div class="card tk-scroll"><table class="tk-table"><tr><th>Inbox</th><th>On</th><th>Cap</th><th>Rate 7d</th><th>Canary</th><th>Health</th><th>Warm-up since</th><th></th></tr>${rows||'<tr><td colspan="8" class="tk-muted">No inboxes yet — paste them on the Buy & paste screen.</td></tr>'}</table></div>
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
    return `<tr><td class="wrap"><b>${esc(b.leadEmail||'(unmatched)')}</b>${b.id?`<div class="tk-mono tk-muted">${esc(b.id)}</div>`:''}</td><td class="mono">${esc(tkDateTime(b.scheduledAt))}</td><td><span class="pill ${cls}">${esc(b.status||'—')}</span></td>
      <td class="mono">${tkTruthy(b.qualified)?'<span class="pill green">Yes</span>':'—'}</td><td class="mono">${esc(b.tapped||'—')}</td>
      <td class="wrap">${b.disputeReason?esc(b.disputeReason):'—'}${disputed?`<div class="tk-inline" style="margin-top:6px"><button class="btn" onclick="trialDispute(${tkAttr(id)},${tkAttr(b.id)},'uphold')">Uphold</button><button class="btn ghost" onclick="trialDispute(${tkAttr(id)},${tkAttr(b.id)},'overturn')">Overturn</button></div>`:''}</td></tr>`}).join('');
  return `<div class="card tk-scroll"><table class="tk-table"><tr><th>Prospect</th><th>Scheduled</th><th>Status</th><th>Qualified</th><th>Tapped</th><th>Dispute</th></tr>${rows||'<tr><td colspan="6" class="tk-muted">No bookings yet.</td></tr>'}</table></div>`;
}
function renderRepliesTab(d){
  const list=(d.replies||[]).slice().sort((a,b)=>String(b.receivedAt||'').localeCompare(String(a.receivedAt||''))).slice(0,50);
  if(!list.length)return '<div class="card"><div class="tk-todo-empty">No replies yet.</div></div>';
  return `<div class="card">${list.map(r=>`<div class="tk-list-row"><div style="min-width:0"><div class="tk-inline" style="gap:8px"><span class="pill ${tkKindClass(r.kind)}">${esc(r.kind||'?')}</span><b style="font-size:12.5px">${esc(r.leadEmail||'—')}</b><span class="tk-updated" title="${esc(tkFull(r.receivedAt))}">${esc(tkRel(r.receivedAt))}</span></div>${r.snippet?`<small style="margin-top:5px;line-height:1.45">${esc(r.snippet)}</small>`:''}</div></div>`).join('')}</div>`;
}
function renderCopyTab(d){
  const id=(d.row||{}).id;const s=d.sequence||{};const lf=d.leadfinder||{};const changes=Array.isArray(s.changes)?s.changes:[];
  return `<div class="card" style="padding:16px"><div class="tk-kv">
    <small>Active variant</small><span>${esc(s.active||'—')}</span>
    <small>Version</small><span class="mono">${esc(s.version!=null?s.version:'—')}</span>
    <small>Approved</small><span>${s.approvedAt?esc(tkDateTime(s.approvedAt))+(s.approvalMode?' · by '+esc(s.approvalMode):''):'<span class="pill amber">Not yet</span>'}</span>
    <small>Change rounds</small><span class="mono">${esc(s.round!=null?s.round:'0')}</span>
    <small>Lead Finder</small><span>${esc(lf.status||'—')}${lf.found!=null?' · '+tkNum(lf.found)+' found of '+tkNum(lf.need):''}</span>
  </div>
  ${changes.length?`<div class="section-head" style="margin:16px 0 8px"><h3 style="font-size:13px">Change requests</h3></div><ul class="tk-sys-detail" style="padding-left:16px">${changes.map(c=>`<li>${esc(tkDetailText(c))}</li>`).join('')}</ul>`:''}
  <div class="tk-inline" style="margin-top:16px"><button class="btn" onclick="openMachine(${tkAttr('/mc/clients/'+id+'/sequence')})">Open the copy editor ↗</button><button class="btn ghost" onclick="trialSequenceAction(${tkAttr(id)},'sendLink')">Send approval link</button><button class="btn ghost" onclick="trialSequenceAction(${tkAttr(id)},'dispatch')">Dispatch Lead Finder</button></div></div>`;
}
function renderChecksTable(checks){
  const keys=Object.keys(checks||{});if(!keys.length)return '<div class="tk-todo-empty">No checks recorded yet.</div>';
  return `<table class="tk-table"><tr><th>Check</th><th>Status</th><th>Detail</th></tr>${keys.map(k=>{const c=checks[k]||{};const st=typeof c==='string'?c:c.status;return `<tr><td class="mono">${esc(k)}</td><td>${tkCheckPill(st)}</td><td class="wrap tk-small">${esc(typeof c==='string'?'':(c.detail||''))}</td></tr>`}).join('')}</table>`;
}
function renderSetupTab(d){
  const id=(d.row||{}).id;const dom=d.domain||{};const sh=d.shopping||{};
  const phase=dom.setupPhase?`<span class="pill ${dom.setupPhase==='passed'?'green':dom.setupPhase==='failed'?'red':'amber'}">${esc(dom.setupPhase)}</span>`:'<span class="pill grey">not run</span>';
  return `<div class="card" style="padding:16px"><div class="tk-kv">
    <small>Domain</small><span class="mono">${esc(dom.name||sh.chosenDomain||'—')}</span>
    <small>Setup</small><span>${phase}</span>
    <small>DMARC pass 7d</small><span class="mono">${tkRate(dom.dmarcPassRate7d)}</span>
    <small>Blacklist</small><span>${dom.blacklist?`<span class="pill ${dom.blacklist==='clean'?'green':'red'}">${esc(dom.blacklist)}</span>`:'—'}</span>
    ${dom.retiredAt?`<small>Retired</small><span class="mono">${esc(tkDateTime(dom.retiredAt))}</span>`:''}
    ${sh.total!=null?`<small>Shopping list</small><span>${tkMoney(sh.total)} total${sh.sentAt?' · sent '+esc(tkRel(sh.sentAt)):''}${sh.boughtAt?' · bought '+esc(tkRel(sh.boughtAt)):''} · <span class="tk-client" style="text-decoration:underline;cursor:pointer" onclick="openTrialPurchase(${tkAttr(id)})">open Buy & paste</span></span>`:''}
  </div></div>
  <div class="section-head tk-section"><h3>Domain checks</h3></div><div class="card tk-scroll">${renderChecksTable(dom.checks)}</div>
  <div class="section-head tk-section"><h3>Intake actions</h3></div>
  <div class="card" style="padding:14px"><div class="tk-inline"><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'rerunSetup')">Re-run setup</button><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'rerunMarket')">Re-run market</button><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'marketOverride')">Override market</button><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'rerunBookingTest')">Re-run booking test</button><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'resendWelcome')">Resend welcome</button></div></div>`;
}
function renderReportsTab(d){
  const list=d.reports||[];if(!list.length)return '<div class="card"><div class="tk-todo-empty">No reports rendered yet.</div></div>';
  return `<div class="card">${list.map(r=>`<div class="tk-list-row"><div><b class="tk-mono">${esc(r.name||'—')}</b><small>${r.blockedReason?'<span style="color:var(--red)">Blocked — '+esc(r.blockedReason)+'</span>':r.renderedAt?'Rendered '+esc(tkDateTime(r.renderedAt)):'Not rendered yet'}</small></div>${r.blockedReason?'<span class="pill red">Blocked</span>':r.renderedAt?'<span class="pill green">Sent</span>':'<span class="pill grey">Pending</span>'}</div>`).join('')}</div>`;
}
function renderPromisesTab(d){
  const id=(d.row||{}).id;const list=(d.promises||[]).slice().sort((a,b)=>String(a.dueAt||'').localeCompare(String(b.dueAt||'')));
  const now=new Date();
  const rows=list.map(p=>{const done=!!p.doneAt;const due=tkParseDate(p.dueAt);const over=!done&&due&&due<now;
    return `<div class="tk-list-row ${done?'done':''}"><div><b>${esc(p.text||'')}</b><small>${done?'Done '+esc(tkDateTime(p.doneAt)):(p.dueAt?'Due '+esc(tkDate(p.dueAt))+(over?' · <span style="color:var(--red)">overdue</span>':''):'No date')}</small></div>${done?'<span class="pill green">Done</span>':`<button class="btn ghost" onclick="trialPromiseDone(${tkAttr(id)},${tkAttr(p.id)})">Done</button>`}</div>`}).join('');
  return `<div class="card">${rows||'<div class="tk-todo-empty">No promises or notes yet.</div>'}</div>
  <div class="section-head tk-section"><h3>Add note</h3></div>
  <div class="card tk-form"><div class="field" style="grid-column:span 2"><label>Note (becomes a promise when dated)</label><input id="tkNoteText" data-tk-form placeholder="Call Ann about the calendar link" autocomplete="off"></div><div class="field"><label>Due date (optional)</label><input id="tkNoteDate" data-tk-form type="date"></div><button class="btn" onclick="trialAddNote(${tkAttr(id)})">Add note</button></div>`;
}
function renderTimeline(events){
  const list=(events||[]).slice().sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  if(!list.length)return '<div class="card"><div class="tk-todo-empty">No events yet.</div></div>';
  return `<div class="card tk-timeline">${list.map(e=>`<div class="tk-ev"><span class="t" title="${esc(tkFull(e.at))}">${esc(tkDateTime(e.at))}</span><span class="s">${esc(e.system||'')}</span><span class="e"><b>${esc(e.event||'')}</b>${e.detail!=null&&e.detail!==''?` <span>${esc(tkDetailText(e.detail))}</span>`:''}</span></div>`).join('')}</div>`;
}
function renderUpcomingTab(d){
  const list=(d.upcoming||[]).slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
  if(!list.length)return '<div class="card"><div class="tk-todo-empty">Nothing dated ahead.</div></div>';
  return `<div class="card">${list.map(u=>`<div class="tk-list-row"><div><b>${esc(u.what||'')}</b><small class="tk-mono">${esc(tkDate(u.date))}${u.time?' · '+esc(u.time):''}</small></div></div>`).join('')}</div>`;
}
function renderActionsTab(d){
  const row=d.row||{};const id=row.id;const st=row.state;const holds=d.holds||{};const jobs=d.jobs||{};const jobNames=Object.keys(jobs);
  const stateOpts=Object.keys(TK_STATE_LABEL).filter(k=>k!==st).map(k=>`<option value="${esc(k)}">${esc(TK_STATE_LABEL[k])} (${esc(k)})</option>`).join('');
  const pause=st==='sending'?`<button class="btn" onclick="trialSetState(${tkAttr(id)},'paused')">Pause sending</button>`:st==='paused'?`<button class="btn" onclick="trialSetState(${tkAttr(id)},'sending')">Resume sending</button>`:'';
  const holdLines=[];
  if(holds.legalHoldAt)holdLines.push(`<span class="pill red">Legal hold since ${esc(tkDateTime(holds.legalHoldAt))}</span>`);
  if(holds.sendHold)holdLines.push(`<span class="pill red">Send hold · ${esc(String(holds.sendHold))}</span>`);
  if(tkTruthy(holds.emergencyActive))holdLines.push('<span class="pill red">Emergency active</span>');
  if(tkTruthy(holds.emergencyHalved))holdLines.push('<span class="pill amber">Caps halved</span>');
  if(holds.pausedReason)holdLines.push(`<span class="pill amber">Paused · ${esc(String(holds.pausedReason))}</span>`);
  return `<div class="card" style="padding:16px">
    ${holdLines.length?`<div class="tk-pills" style="margin-bottom:14px">${holdLines.join('')}</div>`:''}
    <div class="tk-inline">${pause}<select id="tkStateSel"><option value="">Move to state…</option>${stateOpts}</select><button class="btn ghost" onclick="trialMoveState(${tkAttr(id)})">Move</button></div>
    <div class="tk-inline" style="margin-top:12px"><select id="tkJobSel">${jobNames.length?jobNames.map(j=>`<option value="${esc(j)}">${esc(j)}</option>`).join(''):'<option value="">(no jobs listed)</option>'}</select><button class="btn ghost" onclick="trialRunJob(${tkAttr(id)})">Run a job now</button></div>
    <div class="tk-inline" style="margin-top:12px">
      <button class="btn ghost" onclick="trialSimple(${tkAttr(id)},'markPaid','Mark this client as paid?')">Mark paid</button>
      <button class="btn ghost" onclick="trialSimple(${tkAttr(id)},'inboxesCancelled','Mark the inboxes as cancelled?')">Mark inboxes cancelled</button>
      ${holds.legalHoldAt?`<button class="btn" onclick="trialSimple(${tkAttr(id)},'clearLegalHold','Clear the legal hold and let sending resume?')">Clear legal hold</button>`:''}
      ${holds.sendHold?`<button class="btn" onclick="trialSimple(${tkAttr(id)},'clearSendHold','Clear the send hold?')">Clear send hold</button>`:''}
      <button class="btn ghost" onclick="trialSimple(${tkAttr(id)},'reviewCaptured','Record that a review was captured?')">Review captured</button>
    </div>
    <div class="tk-inline" style="margin-top:12px"><input id="tkMinutes" data-tk-form type="number" min="1" max="600" placeholder="Minutes" style="width:110px"><button class="btn ghost" onclick="trialLogTime(${tkAttr(id)})">Log time</button></div>
  </div>
  ${jobNames.length?`<div class="section-head tk-section"><h3>Jobs</h3><span class="count">${jobNames.length}</span></div><div class="card tk-scroll"><table class="tk-table"><tr><th>Job</th><th>Last run</th><th>Took</th><th>Result</th></tr>${jobNames.map(j=>{const r=jobs[j]||{};return `<tr><td class="mono">${esc(j)}</td><td class="mono" title="${esc(tkFull(r.at))}">${esc(r.at?tkRel(r.at):'never')}</td><td class="mono">${r.ms!=null?tkNum(r.ms)+' ms':'—'}</td><td class="wrap">${r.at==null?'—':r.ok===false||r.error?`<span class="pill red">Error</span> <span class="tk-small">${esc(r.error||'')}</span>`:'<span class="pill green">OK</span>'}</td></tr>`}).join('')}</table></div>`:''}`;
}
function renderLinks(links){
  const keys=Object.keys(links||{}).filter(k=>links[k]);if(!keys.length)return '';
  return `<div class="section-head tk-section"><h3>Client links</h3></div><div class="card tk-links">${keys.map(k=>`<div class="tk-link"><small>${esc(k)}</small><input readonly value="${esc(links[k])}" onclick="this.select()"><button class="btn ghost" onclick="trialCopyLink(${tkAttr(links[k])})">Copy</button></div>`).join('')}</div>`;
}
function renderTab(d,tab){
  switch(tab){
    case 'inboxes':return renderInboxesTab(d);
    case 'calls':return renderCallsTab(d);
    case 'replies':return renderRepliesTab(d);
    case 'copy':return renderCopyTab(d);
    case 'setup':return renderSetupTab(d);
    case 'reports':return renderReportsTab(d);
    case 'promises':return renderPromisesTab(d);
    case 'timeline':return renderTimeline(d.events);
    case 'upcoming':return renderUpcomingTab(d);
    case 'actions':return renderActionsTab(d);
    default:return renderNumbersTab(d);
  }
}
function renderTrialDetail(d,tab,meta){
  d=d||{};const row=d.row||{};tab=TK_TABS.some(t=>t[0]===tab)?tab:'numbers';
  return renderTrialHeader(d,meta)+
    renderTodos(row.todo||[],{hideClient:true,now:meta&&meta.now,empty:'Nothing waiting on you for this client.'})+
    `<div class="section-head tk-section"><h3>Systems</h3><span class="count">${(row.systems||[]).length}</span></div>`+renderSystems(row.systems)+
    renderTabBar(tab)+`<div id="tkTabHost">${renderTab(d,tab)}</div>`+renderLinks(d.links);
}

/* -- purchase -- */
function renderQuoteLine(q,unconfirmed){
  if(!q||typeof q!=='object')return `<li>${esc(String(q))}</li>`;
  const name=q.name||q.registrar||q.provider||'—';const price=q.price!=null?q.price:(q.firstYearPrice!=null?q.firstYearPrice:q.monthly);
  const flag=q.unconfirmed||(unconfirmed||[]).some(u=>String(u).toLowerCase().includes(String(name).toLowerCase()));
  return `<li><b>${esc(name)}</b>${price!=null?' · '+tkMoney(price):''}${q.code?' · code '+esc(q.code):''}${q.minOrder?' · min '+esc(q.minOrder):''}${q.source?` <span class="tk-muted">(${esc(q.source)})</span>`:''}${flag?' <span class="pill amber">Unconfirmed</span>':''}</li>`;
}
function renderPurchase(p,id,meta){
  p=p||{};meta=meta||{};const client=p.client||{};const sh=p.shopping||{};const setup=p.setup||{};const existing=p.inboxes||[];
  const state=client.state||(tkFindRow(id)||{}).state||'';
  const canPaste=!state||['awaiting_purchase','setup_check'].includes(state);
  const enc=p.encKey!==false;
  const unconfirmed=sh.unconfirmed||[];
  const domainDefault=(sh.domain&&sh.domain.name)||sh.chosenDomain||'';
  const senders=Array.isArray(sh.senderAddresses)?sh.senderAddresses:[];
  const rowsN=Math.max(2,senders.length);
  const rows=[];for(let i=0;i<rowsN;i++)rows.push(renderPurchaseRow(senders[i]||'',setup.senderName||''));
  const notes=[];
  if(!enc)notes.push('<div class="tk-note">The machine has no ENC_KEY yet, so it cannot store app passwords safely. Set ENC_KEY on the machine, then come back.</div>');
  if(state&&!canPaste)notes.push(`<div class="tk-note">This client is in "${esc(tkStateLabel({state}))}" — the paste form only applies while it waits for the purchase or the setup check.</div>`);
  const disabled=!enc||!canPaste;
  return `<div class="card tk-head" style="margin-bottom:16px"><div class="tk-head-main"><h2>${esc(client.name||tkClientName(id)||id||'—')}</h2><div class="tk-pills"><span class="pill grey">${esc(tkStateLabel({state}))}</span>${client.mainDomain?`<span class="pill blue">${esc(client.mainDomain)}</span>`:''}</div><div class="tk-meta">The one manual step per trial: buy the domain and two inboxes, then paste the logins here. The machine checks everything else.</div></div>
    <div class="tk-btns"><button class="btn ghost" onclick="openTrial(${tkAttr(id)})">← Trial</button><button class="btn ghost" onclick="trialsRefresh()">Refresh</button><button class="btn ghost" onclick="openMachine(${tkAttr('/mc/clients/'+id+'/purchase')})">Mission Control ↗</button></div></div>
  ${notes.join('')}
  <div class="section-head tk-section"><h3>Shopping list</h3>${tkUpdatedStamp(meta.at)}</div>
  <div class="card tk-shop"><div class="tk-kv">
    <small>Domain</small><span class="mono"><b>${esc(sh.chosenDomain||'—')}</b>${(sh.backups||[]).length?` <span class="tk-muted">· backups: ${(sh.backups||[]).map(esc).join(', ')}</span>`:''}</span>
    <small>Registrar</small><span>${(sh.registrarQuotes||[]).length?`<ul class="tk-sys-detail" style="margin:0;padding-left:14px">${(sh.registrarQuotes||[]).map(q=>renderQuoteLine(q,unconfirmed)).join('')}</ul>`:'—'}</span>
    <small>Inboxes</small><span>${(sh.inboxQuotes||[]).length?`<ul class="tk-sys-detail" style="margin:0;padding-left:14px">${(sh.inboxQuotes||[]).map(q=>renderQuoteLine(q,unconfirmed)).join('')}</ul>`:'—'}</span>
    ${senders.length?`<small>Sender addresses</small><span class="mono">${senders.map(esc).join(', ')}</span>`:''}
    <small>Total</small><span class="tk-total">${tkMoney(sh.total)}</span>
    <small>List sent</small><span>${sh.sentAt?esc(tkDateTime(sh.sentAt))+' ('+esc(tkRel(sh.sentAt))+')':'—'}</span>
    <small>Bought</small><span>${sh.boughtAt?'<span class="pill green">'+esc(tkDateTime(sh.boughtAt))+'</span>':'<span class="pill amber">Not yet</span>'}</span>
    ${unconfirmed.length?`<small>Unconfirmed</small><span style="color:var(--amber)">${unconfirmed.map(u=>esc(String(u))).join('; ')}</span>`:''}
  </div></div>
  ${existing.length?`<div class="section-head tk-section"><h3>Already pasted</h3><span class="count">${existing.length}</span></div><div class="card tk-scroll"><table class="tk-table"><tr><th>Inbox</th><th>Name</th><th>Password</th><th>On</th></tr>${existing.map(ib=>`<tr><td class="mono">${esc(ib.email||'')}</td><td>${esc(ib.displayName||'')}</td><td>${ib.hasPassword?'<span class="pill green">Stored</span>':'<span class="pill red">Missing</span>'}</td><td class="mono">${tkTruthy(ib.enabled)?'yes':'no'}</td></tr>`).join('')}</table></div>`:''}
  <div class="section-head tk-section"><h3>Paste the logins</h3></div>
  <div class="card" style="padding:16px"><fieldset class="tk-fs" id="tkPcForm" ${disabled?'disabled':''}>
    <div class="field" style="max-width:360px"><label>Domain you bought</label><input id="pcDomain" data-tk-form value="${esc(domainDefault)}" placeholder="acme-team.com" autocomplete="off"></div>
    <label class="tk-check"><input id="pcAutoRenew" type="checkbox"> Auto-renew is <b>OFF</b> at the registrar (required)</label>
    <div class="field"><label>Inboxes (email · app password · display name)</label><div id="pcRows">${rows.join('')}</div><button class="li-add" type="button" onclick="trialsPurchaseAddRow()">+ Add another inbox</button></div>
    <div id="pcErr" class="tk-modal-errs"></div>
    <div class="tk-inline" style="margin-top:12px"><button class="btn" onclick="submitTrialPurchase(${tkAttr(id)})">Save logins & start the setup check</button><span class="tk-updated">Passwords are sent once, over HTTPS, and stored encrypted on the machine.</span></div>
  </fieldset></div>
  <div class="section-head tk-section"><h3>Setup checks</h3>${setup.domain&&setup.domain.setupPhase?`<span class="pill ${setup.domain.setupPhase==='passed'?'green':setup.domain.setupPhase==='failed'?'red':'amber'}">${esc(setup.domain.setupPhase)}</span>`:''}<div class="spacer"></div><button class="btn ghost" onclick="trialIntakeAction(${tkAttr(id)},'rerunSetup')">Re-run setup</button></div>
  <div class="card tk-scroll">${renderChecksTable(setup.checks)}</div>`;
}
function renderPurchaseRow(email,name){return `<div class="tk-pc-row"><input class="pc-email" data-tk-form placeholder="hello@acme-team.com" value="${esc(email||'')}" autocomplete="off"><input class="pc-pass" data-tk-form type="password" placeholder="app password" autocomplete="new-password"><input class="pc-name" data-tk-form placeholder="Display name" value="${esc(name||'')}" autocomplete="off"><button class="li-del" type="button" onclick="this.parentElement.remove()" title="Remove row">✕</button></div>`}

/* -- alerts -- */
function renderAlerts(alerts,filter,meta){
  alerts=alerts||[];meta=meta||{};filter=filter||'open';
  const list=alerts.filter(a=>filter==='all'||!a.acknowledged).slice().sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  const openN=alerts.filter(a=>!a.acknowledged).length;
  const toolbar=`<div class="toolbar"><div class="seg"><button class="${filter==='all'?'active':''}" onclick="trialsSetAlertFilter('all')">All · ${alerts.length}</button><button class="${filter==='open'?'active':''}" onclick="trialsSetAlertFilter('open')">Open · ${openN}</button></div><div style="margin-left:auto" class="tk-inline">${tkUpdatedStamp(meta.at)}<button class="btn ghost" onclick="trialsRefresh()">Refresh</button><button class="btn ghost" onclick="openMachine('/mc/alerts')">Mission Control ↗</button></div></div>`;
  if(!list.length)return toolbar+`<div class="card"><div class="tk-todo-empty">${filter==='open'?'No open alerts — the machine has nothing for you.':'No alerts yet.'}</div></div>`;
  return toolbar+`<div class="card">${list.map(a=>`<div class="tk-alert ${a.acknowledged?'acked':''}">${a.urgent?'<span class="pill red">Urgent</span>':'<span class="pill grey">Info</span>'}
    <div style="min-width:0"><b>${esc(a.title||a.key||'Alert')}</b><small>${a.clientId?`<span class="tk-client" onclick="openTrial(${tkAttr(a.clientId)})">${esc(tkClientName(a.clientId))}</span> · `:''}${a.key?'<span class="tk-mono">'+esc(a.key)+'</span> · ':''}<span title="${esc(tkFull(a.at))}">${esc(tkRel(a.at,meta.now))}</span> · ${a.delivered===false?'<span style="color:var(--red)">not delivered</span>':'delivered'}${a.acknowledged?' · acknowledged':''}</small></div>
    <div class="tk-alert-act">${a.acknowledged?'':`<button class="btn ghost" onclick="trialsAckAlert(${tkAttr(a.id)})">Acknowledge</button>`}</div></div>`).join('')}</div>`;
}

/* -- hub bits -- */
function trialsHealthCard(){
  const hub=tk.hub;let num='—',sub='loading…',hc='#000000',bg='rgba(0,0,0,.14)';
  if(hub){
    const rows=tkAllRows({stages:(hub.stages||[]).filter(s=>s.key!=='ended')});
    const g=rows.filter(r=>tkHealthClass(r.health)==='green').length,y=rows.filter(r=>tkHealthClass(r.health)==='amber').length,r=rows.filter(x=>tkHealthClass(x.health)==='red').length;
    const todos=(hub.todos||[]).length;
    num=String(hub.machine&&hub.machine.activeTrials!=null?hub.machine.activeTrials:rows.length);
    sub=`${g} green · ${y} yellow · ${r} red · ${todos} to-do${todos!==1?'s':''}`;
    if(r){hc='#E0290F';bg='rgba(224,41,15,.12)';}else if(y||todos){hc='#A16207';bg='rgba(161,98,7,.13)';}else{hc='#1E7A3B';bg='rgba(30,122,59,.13)';}
  }else if(tk.hubErr){sub='machine unreachable';hc='#E0290F';bg='rgba(224,41,15,.12)';}
  return `<div class="hcard" id="tkHealthCard" style="--hc:${hc};--hc-bg:${bg}" onclick="render('trials')"><div class="hc-ic">${I.trials||I.grid}</div><div><div class="hc-lbl">Trials</div><div class="hc-num">${esc(num)}</div><div class="hc-sub">${esc(sub)}</div></div></div>`;
}
function trialLineForName(name){
  if(!name||!tk.hub)return '';const n=String(name).trim().toLowerCase();if(!n)return '';
  const row=tkAllRows(tk.hub).find(r=>String(r.name||'').trim().toLowerCase()===n);
  return row?`<span class="tk-trial-line" onclick="event.stopPropagation();openTrial(${tkAttr(row.id)})">Trial: ${esc(tkStateLabel(row))}</span>`:'';
}

/* ===================== 5. VIEWS (called by the hub router) ===================== */
function trialsIsAdmin(){return !!(typeof authUser!=='undefined'&&authUser&&authUser.role==='admin')}
function trialsNotAdminHTML(){return emptyState(I.trials||I.grid,'Admins only','The trial machine is run by the founder. Nothing here is visible to employees.','',null)}
function trialsHostHTML(view){
  switch(view){
    case 'trials':return tk.hub?renderStaleNote(tk.hubErr,tk.hubAt)+renderBoard(tk.hub,{at:tk.hubAt}):tk.hubErr?renderMachineError(tk.hubErr):renderLoading();
    case 'trial':{const id=currentTrialId;if(!id)return emptyState(I.trials||I.grid,'Pick a trial','Open one from the board.','Trials board',"render('trials')");
      const d=tk.detail[id];return d?renderStaleNote(tk.detailErr[id],tk.detailAt[id])+renderTrialDetail(d,trialTab,{at:tk.detailAt[id]}):tk.detailErr[id]?renderMachineError(tk.detailErr[id]):renderLoading();}
    case 'trialPurchase':{const id=currentTrialId;if(!id)return emptyState(I.trials||I.grid,'Pick a trial','Open one from the board first.','Trials board',"render('trials')");
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
function viewTrials(){if(!trialsIsAdmin())return trialsNotAdminHTML();trialsKick('trials');return `<div id="tkHost">${trialsHostHTML('trials')}</div>`}
function viewTrial(){if(!trialsIsAdmin())return trialsNotAdminHTML();trialsKick('trial');loadHub(false).then(()=>{try{renderNav();}catch(e){}});return `<div id="tkHost">${trialsHostHTML('trial')}</div>`}
function viewTrialPurchase(){if(!trialsIsAdmin())return trialsNotAdminHTML();trialsKick('trialPurchase');return `<div id="tkHost">${trialsHostHTML('trialPurchase')}</div>`}
function viewTrialAlerts(){if(!trialsIsAdmin())return trialsNotAdminHTML();trialsKick('trialAlerts');loadHub(false).then(()=>{try{renderNav();}catch(e){}});return `<div id="tkHost">${trialsHostHTML('trialAlerts')}</div>`}

/* ===================== 6. ACTIONS ===================== */
function openTrial(id,tab){if(!id)return;currentTrialId=String(id);if(tab)trialTab=tab;render('trial')}
function openTrialPurchase(id){if(!id)return;currentTrialId=String(id);render('trialPurchase')}
function trialsRetry(){const h=document.getElementById('tkHost');if(h&&!trialsHasData(currentView))h.innerHTML=renderLoading('Trying again…');trialsKick(currentView,true).then(()=>trialsRepaint(currentView))}
function trialsHasData(v){if(v==='trials')return !!tk.hub;if(v==='trial')return !!tk.detail[currentTrialId];if(v==='trialPurchase')return !!tk.purchase[currentTrialId];if(v==='trialAlerts')return !!tk.alerts;return false}
async function trialsRefresh(){const v=currentView;const r=await trialsKick(v,true);trialsRepaint(v);if(r&&r.ok===false)toast('Refresh failed: '+(r.error||'no answer'));}
function trialsSetTab(tab){trialTab=tab;const bar=document.getElementById('tkTabBar'),host=document.getElementById('tkTabHost');const d=currentTrialId&&tk.detail[currentTrialId];if(!d||!bar||!host){trialsRepaint('trial');return;}bar.outerHTML=renderTabBar(tab);host.innerHTML=renderTab(d,tab);}
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
    if(r.ok){toast(opts.done||'Done');if(opts.reload!==false)await trialsAfterAction();}
    else toast((opts.fail||'That did not work')+': '+(r.error||'no answer'));
    return r;
  }finally{tk.busy=false;}
}
function trialsTodoAction(id){
  const t=tkFindTodo(id);if(!t){toast('That to-do is gone — refreshing');trialsRefresh();return;}
  const a=t.action||{};const cid=a.clientId||t.clientId;
  switch(a.type){
    case 'api':trialPost(a.path,a.body!==undefined?a.body:{},{method:a.method||'POST',confirm:a.confirm||'',done:'Done — '+(t.text||'')});break;
    case 'view':if(a.view==='purchase')openTrialPurchase(cid);else if(a.view==='sequence')openTrial(cid,'copy');else openTrial(cid);break;
    case 'mc':openMachine(a.path||'/mc');break;
    case 'link':if(a.url)window.open(a.url,'_blank','noopener');break;
    default:break;
  }
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
async function submitTrialPurchase(id){
  const errEl=document.getElementById('pcErr');const show=list=>{if(errEl)errEl.innerHTML=list.map(e=>esc(e)).join('<br>');};
  show([]);
  const domain=(document.getElementById('pcDomain')||{}).value||'';
  const auto=document.getElementById('pcAutoRenew');
  const rows=[...document.querySelectorAll('#pcRows .tk-pc-row')].map(r=>({email:(r.querySelector('.pc-email')||{}).value||'',password:(r.querySelector('.pc-pass')||{}).value||'',displayName:(r.querySelector('.pc-name')||{}).value||''})).map(x=>({email:x.email.trim(),password:x.password,displayName:x.displayName.trim()})).filter(x=>x.email||x.password||x.displayName);
  const errs=[];
  if(!domain.trim())errs.push('Enter the domain you bought.');
  if(!auto||!auto.checked)errs.push('Tick "Auto-renew is OFF" — the machine will not proceed otherwise.');
  rows.forEach((x,i)=>{if(!/.+@.+\..+/.test(x.email))errs.push('Inbox '+(i+1)+': enter a valid email.');if(!x.password)errs.push('Inbox '+(i+1)+': enter the app password.');});
  if(!rows.length)errs.push('Paste at least one inbox (the trial expects two).');
  if(errs.length)return show(errs);
  if(rows.length<2&&typeof confirm==='function'&&!confirm('Only one inbox pasted — the trial expects two. Continue anyway?'))return;
  const r=await trialPost('/api/mc/clients/'+encodeURIComponent(id)+'/purchase',{domain:domain.trim(),autoRenewOff:true,inboxes:rows},{done:'Logins saved — the setup check is running',fail:'Not saved',reload:false});
  if(r&&r.ok){delete tk.purchase[id];await trialsAfterAction();}
  else if(r&&r.data&&r.data.errors)show(tkErrorList(r.data.errors));
  else if(r&&r.error)show([r.error]);
}
/* New client modal (also used by the CRM "Start a trial" button, prefilled) */
function openNewTrialClient(prefill){
  if(!trialsIsAdmin())return;prefill=prefill||{};tk.newLeadId=prefill.leadId||null;
  openModal(`<div class="modal-head"><div class="pj-ic" style="background:#0000001f;color:#000000;width:40px;height:40px">+</div><div><h3>New trial client</h3><p>Pre-approved — the machine skips the fit rules and starts onboarding (or queues them if three trials are running).</p></div></div>
    <div class="modal-body">
      <div class="field"><label>Company name</label><input id="ntCompany" value="${esc(prefill.companyName||'')}" placeholder="Acme Plumbing"></div>
      <div class="field row2"><div><label>Contact name</label><input id="ntContact" value="${esc(prefill.contactName||'')}" placeholder="Ann Lee"></div><div><label>Contact email</label><input id="ntEmail" type="email" value="${esc(prefill.contactEmail||'')}" placeholder="ann@acme.com"></div></div>
      <div class="field"><label>Website</label><input id="ntWebsite" value="${esc(prefill.website||'')}" placeholder="https://acme.com"></div>
      <label class="tk-check" style="margin:4px 0 10px"><input id="ntOverride" type="checkbox"> Override the 3-trial cap (and the no-new-trials-during-extension rule)</label>
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
  if(tk.newLeadId!=null)trialsNoteOnLead(tk.newLeadId,clientId);
  tk.newLeadId=null;
  await loadHub(true);
  if(clientId)openTrial(clientId);else render('trials');
}
/* CRM hook: the lead keeps its stage; it just gets a note. */
function trialStartFromLead(leadId){
  if(!trialsIsAdmin())return;const l=(typeof leads!=='undefined'?leads:[]).find(x=>x.id===leadId);if(!l)return;
  openNewTrialClient({companyName:l.company||'',contactName:l.contact||'',contactEmail:l.email||'',website:l.website||'',leadId:l.id});
}
function trialsNoteOnLead(leadId,clientId){
  try{const l=(typeof leads!=='undefined'?leads:[]).find(x=>x.id===leadId);if(!l)return;l.history=l.history||[];l.history.push({date:typeof todayShort==='function'?todayShort():new Date().toLocaleDateString(),type:'note',text:'Trial started: '+(clientId||'?')});l.lastTouch=typeof todayShort==='function'?todayShort():l.lastTouch;if(typeof saveDB==='function')saveDB();
    const panel=document.getElementById('panel');if(panel&&panel.classList.contains('open')&&typeof openLead==='function')openLead(leadId);}catch(e){}
}

/* ===================== 7. HUB INTEGRATION ===================== */
function trialsNavCount(){const m=tk.hub&&tk.hub.machine;if(!m||m.activeTrials==null)return '';const n=Number(m.activeTrials);return n>0?n:''}
function trialsAlertCount(){const m=tk.hub&&tk.hub.machine;let n=m&&m.openAlerts!=null?Number(m.openAlerts):(tk.hub?(tk.hub.alerts||[]).length:0);return n>0?n:''}
function trialsNotifs(){
  const n=[];if(!trialsIsAdmin()||!tk.hub)return n;
  (tk.hub.todos||[]).filter(t=>t.urgent).forEach(t=>n.push({dot:'var(--red)',t:t.text||'To-do',s:(t.clientName||t.clientId||'Trial')+(t.detail?' · '+t.detail:''),go:()=>{const a=t.action||{};if(a.type==='view'&&a.view==='purchase')openTrialPurchase(t.clientId);else if(t.clientId)openTrial(t.clientId);else render('trials');}}));
  (tk.hub.alerts||[]).filter(a=>a.urgent&&!a.acknowledged).forEach(a=>n.push({dot:'var(--red)',t:a.title||a.key||'Machine alert',s:'Machine alert'+(a.clientId?' · '+tkClientName(a.clientId):''),go:()=>render('trialAlerts')}));
  return n;
}
function trialsCmdkActions(){
  return [
    {type:'Create',label:'New trial client',icon:I.trials||I.grid,sub:'Start a trial on the machine',kw:'new trial client create start',run:()=>{closeCmdk();openNewTrialClient();}},
    {type:'Go to',label:'Trials board',icon:I.trials||I.grid,sub:'Trials',kw:'trials board machine',run:()=>{closeCmdk();render('trials');}},
    {type:'Go to',label:'Machine alerts',icon:I.bell||I.grid,sub:'Trials',kw:'machine alerts trials',run:()=>{closeCmdk();render('trialAlerts');}},
  ];
}
function trialsCmdkEntities(){
  if(!tk.hub)return [];
  return tkAllRows(tk.hub).map(r=>({type:'Trial',label:r.name||r.id,icon:I.trials||I.grid,sub:tkStateLabel(r)+' · trial:'+r.id,kw:'trial:'+r.id+' '+(r.name||'')+' '+tkStateLabel(r)+' '+(r.contactName||''),run:()=>{closeCmdk();openTrial(r.id);}}));
}
function trialsBoot(){
  if(!trialsIsAdmin())return;
  loadHub(true).then(()=>{try{renderNav();updateNotifBadge();const el=document.getElementById('tkHealthCard');if(el)el.outerHTML=trialsHealthCard();}catch(e){}});
}
function trialsOnRender(v){if(TK_TRIAL_VIEWS.includes(v))trialsStartTimer();else trialsStopTimer();}
function trialsStartTimer(){if(tk.timer)return;tk.timer=setInterval(trialsTick,TK_REFRESH_MS);}
function trialsStopTimer(){if(tk.timer){clearInterval(tk.timer);tk.timer=null;}}
async function trialsTick(){
  if(!TK_TRIAL_VIEWS.includes(currentView)){trialsStopTimer();return;}
  if(currentView==='trialPurchase')return;          // never disturb the paste form
  if(typeof document!=='undefined'&&document.hidden)return;
  if(tk.busy||tkFormDirty())return;
  await trialsKick(currentView,true);
}
