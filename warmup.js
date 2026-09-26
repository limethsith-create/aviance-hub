/* ============================================================================
   warmup.js — Aviance Hub · Warm-up (the helpers, and each trial's warm-up)
   ----------------------------------------------------------------------------
   Contract: email-distributor/docs/WARMUP-HUB.md.
     GET  /api/mc/warmup   → {circle {members, helpers, clientInboxes, avianceInboxes, min, ready, missing, label},
                              helpers [{email, provider, providerLabel, health ok|new|failing|disabled, lastOkAt, problem, sentToday}],
                              providers [{key, label, steps[], note, passwordLabel}], …}
     POST /api/mc/warmup   {action:'addHelper', email, password, provider} — the system tests the login first (about 20 s)
                           and saves only when it works; otherwise 400 with the reason in plain words
                           · {action:'testHelper', email} (re-tests a saved helper) · {action:'removeHelper', email}
     GET  /api/mc/hub/{id} → … warmup {status waiting_for_helpers|warming|ready|paused, label, day, of, readyBy, inboxRate,
                              inboxes [{email, day, sentToday, inboxRate7d, ready}], problem}  (null before the inboxes connect)
   The warm-up is the system's own free warm-up circle. What it needs from the owner is helpers: free personal email
   accounts he makes once (the system never creates accounts). They help every client after that.

   What the owner sees
     · Settings › Warm-up: the circle meter ("6 of 8 in the warm-up circle — add 2 more helpers", green when ready),
       one line on why helpers exist, the helpers (Working / New / Not working: … / Off, with Test and Remove), and
       Add a helper: pick the kind (Gmail, Yahoo, AOL, iCloud, GMX, WEB.DE, Yandex) → its numbered steps → the address
       and the password (labelled the way that provider calls it) → "Test and add" (greyed out, "Testing the login…",
       until the answer is in) → "Added — Gmail helper is working" or the reason in plain words.
     · On a trial: the "Warm-up" card — a simple bar (day N of about 14), how many reach the inbox, each inbox, and
       "Ready to start sending around …". While it waits for helpers the big button is "Add N warm-up helpers"
       (trials.js tkPrimaryAction) and opens Settings › Warm-up.

   Loaded after autobuy.js: reuses tk, currentView, machineFetch, loadHub, trialsRepaint, openSettings, openMachine,
   tkTrialWarmup, tkPageSimple, tkPrimaryAction, tkAttr, tkNorm, tkTruthy, tkRate, tkDayName, tkSentence, tkHuman,
   renderLoading and the shell's esc / toast / renderNav / updateNotifBadge.
   Rules as in trials.js: every system string through esc(), links through tkSafeUrl/tkLink, handler arguments only
   through tkAttr(); render functions never touch the DOM; nothing runs at load time; a password is never kept in
   memory, never drawn into the page and never shown back.
   ========================================================================== */

/* ===================== 0. CONSTANTS + CACHE ===================== */
const WU_FRESH_MS=5*60000;     // the circle is asked for at most every 5 minutes (at once after an add, a test or a remove)
const WU_WAIT_MS=60000;        // "Test and add" / "Test": the login test takes up to about 20 s — wait up to a minute
const WU_WHY='Helpers are free email accounts that trade friendly emails with new inboxes so Gmail and Outlook learn to trust them. Make them once; they help every client.';
/* A helper's health in plain words (the tone colours the words). */
const WU_HEALTH={ok:['green','Working'],new:['blue','New'],failing:['red','Not working'],disabled:['grey','Off']};
const WU_HEALTH_ALIAS={auth_failed:'failing',imap_error:'failing',smtp_error:'failing',error:'failing',broken:'failing',off:'disabled'};   // an older system's words
const WU_PROVIDER_NAMES={google:'Gmail',yahoo:'Yahoo',aol:'AOL',icloud:'iCloud',gmx:'GMX',gmxnet:'GMX',webde:'WEB.DE',yandex:'Yandex',outlook:'Outlook'};

/* The GET answer, its error and the one in flight; `busy` = a post on its way (one at a time); `adding` = "Test and add"
   is waiting for the login test; `provider` = the kind picked under Add a helper; `msg` = the last add's outcome. */
const wuState={s:null,sAt:0,sErr:null,sBusy:null,busy:false,adding:false,provider:null,msg:null};

/* ===================== 1. PURE HELPERS ===================== */
function wuPlural(n,one,many){return n+' '+(n===1?one:many)}
function wuClean(s){return String(s==null?'':s).trim().replace(/[.\s]+$/,'')}
/* The circle, from the answer: {members, min, helpers, clients, aviance, ready, missing, label} or null.
   An older system without `circle`: counted from its members list and minPool. */
function wuCircle(data){
  if(!data||typeof data!=='object')return null;
  const c=data.circle&&typeof data.circle==='object'?data.circle:null;
  let members,min,helpers=null,clients=null,aviance=null,label='';
  if(c){members=tkNorm(c.members);min=tkNorm(c.min);helpers=tkNorm(c.helpers);clients=tkNorm(c.clientInboxes);aviance=tkNorm(c.avianceInboxes);label=String(c.label||'').trim();}
  else if(Array.isArray(data.members)){members=data.members.length;min=tkNorm(data.minPool);helpers=Array.isArray(data.helpers)?data.helpers.length:null;}
  else return null;
  const whole=x=>x==null?null:Math.max(0,Math.round(x));
  members=whole(members)||0;min=min!=null&&min>0?Math.round(min):8;helpers=whole(helpers);clients=whole(clients);aviance=whole(aviance);
  const given=c?tkNorm(c.missing):null;
  let missing=given!=null?whole(given):Math.max(0,min-members);
  const ready=c&&c.ready!=null?tkTruthy(c.ready):missing===0;
  if(ready)missing=0;
  if(!label)label=ready?wuPlural(members,'member','members')+' in the warm-up circle — enough to warm up new inboxes':members+' of '+min+' in the warm-up circle — add '+wuPlural(missing,'more helper','more helpers');
  return {members,min,helpers,clients,aviance,ready,missing,label};
}
/* The kinds of account a helper can be (the system's list, in its order): {key, label, steps, note, passwordLabel}. */
function wuProviders(data){
  const list=data&&Array.isArray(data.providers)?data.providers:[];const seen={};
  return list.filter(p=>{const k=p&&typeof p==='object'?String(p.key||'').trim():'';if(!k||seen[k])return false;seen[k]=1;return true;}).map(p=>{
    const key=String(p.key).trim();
    return {key,label:String(p.label||'').trim()||WU_PROVIDER_NAMES[key]||tkHuman(key),
      steps:(Array.isArray(p.steps)?p.steps:[]).map(x=>String(x==null?'':x).trim()).filter(Boolean),
      note:String(p.note||'').trim(),passwordLabel:String(p.passwordLabel||'').trim()};
  });
}
function wuProviderName(key,label,provs){
  key=String(key||'');const own=String(label||'').trim();if(own)return own;
  const p=(provs||[]).find(x=>x.key===key);return p?p.label:WU_PROVIDER_NAMES[key]||tkHuman(key);
}
/* The helpers: {email, providerName, health (ok|new|failing|disabled|…), problem}. Switched off (enabled '0') reads Off. */
function wuHelperOf(h,provs){
  let health=String(h.health||'').toLowerCase();health=WU_HEALTH_ALIAS[health]||health;
  if(h.enabled!=null&&h.enabled!==''&&!tkTruthy(h.enabled))health='disabled';
  return {email:String(h.email||'').trim(),providerName:wuProviderName(h.provider,h.providerLabel,provs),health,problem:wuClean(h.problem)};
}
function wuHelpers(data,provs){
  return (data&&Array.isArray(data.helpers)?data.helpers:[]).filter(h=>h&&typeof h==='object'&&String(h.email||'').trim()).map(h=>wuHelperOf(h,provs));
}
function wuHealthText(h){
  if(h.health==='failing')return {tone:'red',text:'Not working'+(h.problem?': '+h.problem:'')};
  const w=WU_HEALTH[h.health];return w?{tone:w[0],text:w[1]}:{tone:'grey',text:'Not checked yet'};
}
/* "16-letter app password" — the provider's own name for it; `cap` for a label. */
function wuPassName(p,cap){const s=(p&&p.passwordLabel)||'password';return cap?s.charAt(0).toUpperCase()+s.slice(1):s}
/* The line under "Test and add": busy, the success, or the reason. */
function wuMsgHTML(m){
  if(!m)return '';
  if(m.busy)return '<p class="tk-status grey">Testing the login… This can take about 20 seconds.</p>';
  return `<p class="tk-status ${m.ok?'green':'red'}">${esc(m.text||'')}</p>`;
}
/* The answer to "Test" → {ok, text}. The system may answer 200 with the helper still failing; no answer at all (or a
   fault on our side) is "couldn't test", not "not working". */
function wuTestText(r,email){
  r=r||{};const d=r.data||{};const h=d.helper&&typeof d.helper==='object'?d.helper:d;
  let health=String(h.health||'').toLowerCase();health=WU_HEALTH_ALIAS[health]||health;
  if(!r.ok&&(!r.status||r.status>=500))return {ok:false,text:"Couldn't test "+email+': '+(wuClean(r.error)||'no answer')};
  if(!r.ok)return {ok:false,text:email+' is not working: '+(wuClean(r.error)||'the login did not work')};
  if(health==='failing')return {ok:false,text:email+' is not working: '+(wuClean(h.problem)||'the login did not work')};
  return {ok:true,text:email+' is working'};
}

/* ===================== 2. RENDERERS (pure: data → HTML) ===================== */
/* The one-word state in the Settings list (id'd, so a test or a remove can update it without redrawing the page). */
function wuPillHTML(c){
  if(!c)return '';
  return c.ready?'<span class="pill green" id="wuPill">Ready</span>':`<span class="pill amber" id="wuPill">${esc(c.missing?'Add '+c.missing+' more':'Not ready')}</span>`;
}
/* The circle meter: the sentence, one square per place the circle needs (filled = taken), who is in it. */
function renderWarmupMeter(c){
  if(!c)return '';
  const n=c.min<=24?c.min:0;const on=Math.min(c.members,n);
  const slots=n?`<span class="tk-wu-slots" aria-hidden="true">${Array.from({length:n},(_,i)=>`<span class="tk-wu-slot${i<on?' on':''}"></span>`).join('')}</span>`:'';
  const who=[c.helpers!=null?wuPlural(c.helpers,'helper','helpers'):'',c.aviance?wuPlural(c.aviance,'Aviance inbox','Aviance inboxes'):'',c.clients?wuPlural(c.clients,'trial inbox','trial inboxes'):''].filter(Boolean);
  return `<div class="tk-wu-meter ${c.ready?'green':'amber'}"><p class="tk-wu-count">${esc(c.label)}</p>${slots}${who.length?`<p class="tk-wu-who">In the circle: ${esc(who.join(' · '))}</p>`:''}</div>`;
}
function renderWarmupHelpers(list){
  const head='<h4 class="tk-set-h4">Your helpers</h4>';
  if(!list.length)return head+'<p class="tk-set-text">No helpers yet. Add the first one below — it takes about 5 minutes.</p>';
  return head+`<ul class="tk-wu-list">${list.map(h=>{const t=wuHealthText(h);
    return `<li><p class="tk-wu-addr"><b class="tk-break">${esc(h.email).replace(/@/g,'@<wbr>')}</b>${h.providerName?`<span class="tk-wu-kind">${esc(h.providerName)}</span>`:''}</p>`+
      `<p class="tk-wu-health ${t.tone}">${esc(t.text)}</p>`+
      `<div class="tk-wu-acts"><button type="button" class="btn ghost" onclick="wuTest(${tkAttr(h.email)},this)" aria-label="${esc('Test '+h.email)}">Test</button><button type="button" class="btn ghost" onclick="wuRemove(${tkAttr(h.email)},this)" aria-label="${esc('Remove '+h.email)}">Remove</button></div></li>`;
  }).join('')}</ul>`;
}
/* The top of Settings › Warm-up: the meter, why, the helpers. c = wuSettingsCtx(). */
function renderWarmupTop(c){
  const data=(c&&c.data)||{};const provs=wuProviders(data);
  return renderWarmupMeter(wuCircle(data))+`<p class="tk-set-text">${esc(WU_WHY)}</p>`+renderWarmupHelpers(wuHelpers(data,provs));
}
/* Add a helper. a = {provider (picked key), msg ({ok, text}), busy}. Nothing typed is ever drawn back in. */
function renderWarmupAdd(provs,a){
  provs=Array.isArray(provs)?provs:[];a=a||{};const busy=!!a.busy;const dis=busy?' disabled':'';
  const head='<h4 class="tk-set-h4" id="wuAddTitle">Add a helper</h4>';
  const msg=`<div class="tk-wu-msg" id="wuAddMsg" role="status" aria-live="polite">${wuMsgHTML(busy?{busy:true}:a.msg)}</div>`;
  if(!provs.length)return head+`<p class="tk-set-text">Adding a helper from here needs the newest update of the warm-up circle. Until then, add helpers in the full control panel.</p><div class="tk-set-links"><button type="button" class="btn ghost" onclick="openMachine(${tkAttr('/mc/warmup')})">Open the warm-up circle ↗</button></div>`;
  const p=provs.find(x=>x.key===a.provider)||null;
  if(!p)return head+msg+`<p class="tk-set-text">Which kind of free email account is it? Pick one to see the steps.</p>`+
    `<div class="tk-wu-provs" role="group" aria-label="Kind of email account">${provs.map(x=>`<button type="button" class="btn ghost tk-wu-prov" onclick="wuPick(${tkAttr(x.key)})">${esc(x.label)}</button>`).join('')}</div>`;
  return head+`<p class="tk-wu-picked"><b>${esc(p.label)}</b><span aria-hidden="true">·</span><button type="button" class="tk-textbtn" id="wuOther" onclick="wuPick(${tkAttr('')})"${dis}>Pick another kind</button></p>`+
    (p.steps.length?`<ol class="tk-gm-steps tk-wu-steps">${p.steps.map(x=>`<li>${esc(x)}</li>`).join('')}</ol>`:'')+
    (p.note?`<p class="tk-wu-note">${esc(p.note)}</p>`:'')+
    `<div class="tk-wu-form">`+
      `<div class="field"><label for="wuEmail">The helper's email address</label><input id="wuEmail" data-tk-form type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false"${dis}></div>`+
      `<div class="field"><label for="wuPass">${esc(wuPassName(p,true))}</label><input id="wuPass" data-tk-form type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false"${dis}></div>`+
      `<button type="button" class="btn tk-wu-go" id="wuAddBtn" onclick="wuAdd(this)"${dis}>${busy?'Testing the login…':'Test and add'}</button>`+
    `</div>`+msg;
}
/* Settings › Warm-up. c = wuSettingsCtx(): {data (GET /api/mc/warmup), err, provider, msg, busy} → {state, body}.
   Two hosts so an answer can redraw the helpers without touching what is typed under Add a helper. */
function renderWarmupSet(c){
  c=c||{};const data=c.data&&typeof c.data==='object'?c.data:null;
  const state=wuPillHTML(wuCircle(data));
  if(!data)return {state,body:c.err?`<p class="tk-note red">${esc(c.err)} <button type="button" class="tk-textbtn" onclick="wuRetry()">Try again</button></p>`:renderLoading('Checking the warm-up circle…')};
  return {state,body:`<div id="wuTopHost">${renderWarmupTop(c)}</div><div id="wuAddHost">${renderWarmupAdd(wuProviders(data),{provider:c.provider,msg:c.msg,busy:c.busy})}</div>`};
}
/* The "Warm-up" card on a trial (once `warmup` is set). The machine's label for the warming step is also the big sentence
   at the top of the page: it is not said again here. meta.primary = the big button's kind (worked out when not given). */
function renderWarmupCard(d,meta){
  d=d||{};meta=meta||{};const w=tkTrialWarmup(d);if(!w)return '';
  const waiting=w.status==='waiting_for_helpers',ready=w.status==='ready';
  const norm=x=>String(x||'').replace(/\s+/g,' ').trim().toLowerCase();
  const fallback={waiting_for_helpers:'Waiting for warm-up helpers',warming:'Warming up',ready:'Warm-up done',paused:'Warm-up is paused'}[w.status]||'';
  const label=w.label||fallback;const shown=label&&norm(label)!==norm(tkPageSimple(d).label)?label:'';
  const said=re=>!!shown&&re.test(shown);
  const say=shown?`<p class="tk-wu-say">${esc(shown)}</p>`:'';
  // while it waits: how full the circle is (Settings' answer, when it has been asked for) and the way there
  const c=waiting&&typeof wuCircleNow==='function'?wuCircleNow():null;
  const circle=c&&!c.ready?`<p class="tk-wu-text">${esc(c.label)}</p>`:'';
  const primary=waiting?(meta.primary!=null?meta.primary:tkPrimaryAction(d,{now:meta.now}).kind):null;
  const wait=waiting?'<p class="tk-wu-text">It starts by itself as soon as the circle has enough helpers.</p>'+(primary==='warmupHelpers'?'':`<div class="tk-wu-acts"><button type="button" class="btn" onclick="openSettings(${tkAttr('warmup')})">Add warm-up helpers</button></div>`):'';
  // the bar: day N of about 14 (full once ready)
  let bar='';
  if(!waiting&&(w.day!=null||ready)){
    const day=w.day!=null?Math.max(0,Math.round(w.day)):w.of;const pct=ready?100:Math.max(0,Math.min(100,Math.round(day/w.of*100)));
    const cap=ready?'Warm-up done':'Day '+day+' of about '+w.of;
    const capSaid=ready?said(/warm-?up (is )?done/i):said(new RegExp('\\bday\\s+'+day+'\\s+of\\s+(about\\s+|~\\s*)?'+w.of+'\\b','i'));
    bar=`<div class="tk-wu-prog"><div class="tk-wu-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${esc(w.of)}" aria-valuenow="${esc(ready?w.of:day)}" aria-label="${esc(cap)}"><span style="width:${pct}%"></span></div>${capSaid?'':`<p class="tk-wu-day">${esc(cap)}</p>`}</div>`;
  }
  const rateTxt=w.inboxRate!=null?tkRate(w.inboxRate):'';
  const rate=rateTxt&&!said(new RegExp(rateTxt.replace('%','\\s*%')+'\\s+reach(es)?\\s+the\\s+inbox','i'))?`<p class="tk-wu-rate"><b>${esc(rateTxt)}</b> reach the inbox</p>`:'';
  const readyBy=w.readyBy?`<p class="tk-wu-ready">${esc('Ready to start sending around '+tkDayName(w.readyBy)+'.')}</p>`:'';
  const problem=w.problem?`<p class="tk-status red">${esc(tkSentence(w.problem))}</p>`:'';
  const boxes=w.inboxes.length?`<h4>Each inbox</h4><ul class="tk-wu-boxes">${w.inboxes.map(x=>{
    const dd=tkNorm(x.day);const r=tkNorm(x.inboxRate7d);const rate=r!=null?tkRate(r)+' reach the inbox':'';
    const facts=dd!=null&&dd>0?'Day '+Math.round(dd)+' · '+(rate||'not measured yet'):rate||'Not started yet';   // day 0: waiting to start
    return `<li><span class="tk-break">${esc(x.email).replace(/@/g,'@<wbr>')}</span><span class="tk-wu-ibx">${esc(facts)}</span>${tkTruthy(x.ready)?'<span class="pill green">Ready</span>':''}</li>`;
  }).join('')}</ul>`:'';
  return `<section class="card tk-wu" id="tkSec-warmup">
    <h3>Warm-up</h3>
    ${say}${circle}${problem}${bar}${rate}${readyBy}${wait}${boxes}
  </section>`;
}

/* ===================== 3. LOADERS ===================== */
async function loadWarmup(force){
  if(!force&&wuState.s&&Date.now()-wuState.sAt<WU_FRESH_MS)return {ok:true,data:wuState.s};
  if(wuState.sBusy){if(!force)return wuState.sBusy;await wuState.sBusy;}   // after a change: never settle for an answer asked before it
  const p=machineFetch('/api/mc/warmup').then(r=>{
    wuState.sBusy=null;
    const d=r.ok&&r.data&&typeof r.data==='object'?r.data:null;
    if(d&&(d.circle||Array.isArray(d.members)||Array.isArray(d.helpers))){wuState.s=d;wuState.sAt=Date.now();wuState.sErr=null;}
    else{wuState.sErr=r.error||"We couldn't read the warm-up circle. Try again. (For your developer: no \"circle\" in the answer.)";if(r.ok)r.ok=false;}
    return r;
  });
  wuState.sBusy=p;return p;
}
function wuCircleNow(){return wuCircle(wuState.s)}
function wuSettingsCtx(){return {data:wuState.s,err:wuState.sErr,provider:wuState.provider,msg:wuState.msg,busy:wuState.adding}}

/* ===================== 4. ACTIONS ===================== */
function wuRetry(){return loadWarmup(true).then(()=>trialsRepaint('settings'))}
/* Redraw the meter, the helpers and the state pill (and Add a helper when asked) — never the rest of Settings,
   so nothing typed anywhere else is lost. Settings not on screen: nothing to draw (the cache is already fresh). */
function wuRepaint(add){
  tk.setOpen.warmup=true;
  if(currentView!=='settings')return;
  const c=wuSettingsCtx();const top=document.getElementById('wuTopHost');
  if(!c.data||!top){trialsRepaint('settings');return;}
  top.innerHTML=renderWarmupTop(c);
  const pill=document.getElementById('wuPill');const st=wuPillHTML(wuCircle(c.data));if(pill&&st)pill.outerHTML=st;
  if(add){const h=document.getElementById('wuAddHost');if(h)h.innerHTML=renderWarmupAdd(wuProviders(c.data),{provider:c.provider,msg:c.msg,busy:c.busy});}
}
/* After a change: the fresh circle at once; the trials behind it quietly (a trial may stop waiting for helpers). */
async function wuAfter(add){
  await loadWarmup(true);wuRepaint(add);
  loadHub(true).then(()=>{try{renderNav();updateNotifBadge();}catch(e){}});
}
/* One post at a time: the pressed button greyed out (with busyLabel) until the answer is in. */
async function wuSend(body,btn,busyLabel){
  if(wuState.busy){toast('Still working on the last one…');return {ok:false,busy:true};}
  wuState.busy=true;const label=btn?btn.textContent:'';if(btn){btn.disabled=true;if(busyLabel)btn.textContent=busyLabel;}
  try{return await machineFetch('/api/mc/warmup',{body,timeout:WU_WAIT_MS});}
  finally{wuState.busy=false;if(btn){btn.disabled=false;if(busyLabel&&label)btn.textContent=label;}}
}
async function wuTest(email,btn){
  email=String(email||'');if(!email)return {ok:false};
  const r=await wuSend({action:'testHelper',email},btn,'Testing…');
  if(r.busy)return r;
  toast(wuTestText(r,email).text);
  await wuAfter(false);   // its health changed either way
  return r;
}
async function wuRemove(email,btn){
  email=String(email||'');if(!email)return {ok:false};
  if(typeof confirm==='function'&&!confirm('Remove '+email+' from the warm-up circle? It stops trading warm-up emails. The email account itself is not deleted.'))return {ok:false,cancelled:true};
  const r=await wuSend({action:'removeHelper',email},btn,'Removing…');
  if(r.busy)return r;
  if(!r.ok){toast('Not removed: '+(r.error||'no answer'));return r;}
  toast('Removed '+email);
  await wuAfter(false);
  return r;
}
/* Add a helper: pick the kind (or '' to pick again). Only Add a helper is redrawn. */
function wuPick(key){
  if(wuState.adding)return;
  key=String(key||'');const provs=wuProviders(wuState.s);
  wuState.provider=provs.some(p=>p.key===key)?key:null;wuState.msg=null;tk.setOpen.warmup=true;
  if(currentView!=='settings')return;
  const h=document.getElementById('wuAddHost');if(!h){trialsRepaint('settings');return;}
  h.innerHTML=renderWarmupAdd(provs,{provider:wuState.provider});
  const t=document.getElementById('wuAddTitle');if(t&&t.scrollIntoView)try{t.scrollIntoView({block:'start'});}catch(e){t.scrollIntoView();}
}
/* While the login is tested: the boxes and the button greyed out, "Testing the login…" (by id — the page may have been redrawn). */
function wuAddBusy(on){
  ['wuEmail','wuPass','wuOther'].forEach(id=>{const e=document.getElementById(id);if(e)e.disabled=!!on;});
  const b=document.getElementById('wuAddBtn');if(b){b.disabled=!!on;b.textContent=on?'Testing the login…':'Test and add';}
  const m=document.getElementById('wuAddMsg');if(m)m.innerHTML=wuMsgHTML(on?{busy:true}:wuState.msg);
}
async function wuAdd(){
  const p=wuProviders(wuState.s).find(x=>x.key===wuState.provider);
  if(!p){toast('Pick the kind of email account first');return {ok:false};}
  const ei=document.getElementById('wuEmail'),pi=document.getElementById('wuPass');
  const email=String((ei&&ei.value)||'').trim(),password=String((pi&&pi.value)||'');
  const say=m=>{wuState.msg=m;const box=document.getElementById('wuAddMsg');if(box)box.innerHTML=wuMsgHTML(m);};
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){say({ok:false,text:"Type the helper's whole email address first."});return {ok:false};}
  if(!password.trim()){say({ok:false,text:'Paste its '+wuPassName(p)+' first.'});return {ok:false};}
  if(wuState.busy){toast('Still working on the last one…');return {ok:false,busy:true};}
  wuState.busy=true;wuState.adding=true;wuState.msg=null;wuAddBusy(true);
  let r;
  try{r=await machineFetch('/api/mc/warmup',{body:{action:'addHelper',email,password,provider:p.key},timeout:WU_WAIT_MS});}
  finally{wuState.busy=false;wuState.adding=false;}
  if(!r.ok){wuAddBusy(false);say({ok:false,text:tkSentence(r.error||"That didn't work. Try again.")});return r;}
  const text='Added — '+p.label+' helper is working';
  ['wuEmail','wuPass'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});   // never kept on the page once it is saved
  wuState.provider=null;wuState.msg={ok:true,text};
  toast(text);
  await wuAfter(true);
  return r;
}

/* ===================== 5. SHELL INTEGRATION ===================== */
function warmupForget(){Object.assign(wuState,{s:null,sAt:0,sErr:null,sBusy:null,busy:false,adding:false,provider:null,msg:null});}
