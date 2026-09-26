/* ============================================================================
   keys.js — Aviance Hub · Settings › Keys and Settings › Your details
   ----------------------------------------------------------------------------
   The owner's own set-up, so he never opens Vercel: the keys for the free services the system
   uses, and the handful of details about him (name, address, links).

   Contract (email-distributor docs/KEYS.md and docs/HUB-API.md "Keys" / "Config"):
     GET  /api/mc/keys    → { keys: [ { name, label, set, from: 'env'|'hub'|null, testedAt, ok, problem, steps, url,
                                        optional?, secret?, free?, note?, value? (a plain setting only) } ], encKey? }
     POST /api/mc/keys    { action:'save', name, value }  (Verifalia: { action:'save', name:'VERIFALIA', username, password })
                          { action:'test', name } · { action:'forget', name }   → { ok, … the key's status }
                          or 400 { error } with a plain reason (a key the service refuses is not saved).
     GET  /api/mc/config  → { settings: [ { key, default, value, overridden, toSet } ] }
     POST /api/mc/config  { action:'set', key, value } (value is JSON) · { action:'reset', key }
       The machine lists one row per top-level setting (OWNER, PAYMENT, …) with the fields inside it. A field
       such as OWNER.signerName is then saved by posting the whole OWNER row with that one field changed, and
       "cleared" by posting it with the field back at its default. Should a machine ever list a row per field
       (key 'OWNER.signerName'), that row is posted as it is (set / reset). Both shapes are handled here.

   What the owner sees
     · Settings › Your details: eight plain boxes (full name, postal address, email, the onboarding inbox, the call
       link, PayPal.me, Wise details, the Clutch review page), each with one helper line and its own Save (Enter
       saves too), "Clear" when he changed it, a plain "Saved" / the reason it was refused, "Still to fill in: N",
       and the two the first trial cannot start without (name, address) marked in amber.
     · Settings › Keys: a one-line explanation, "3 of 5 keys set", then one card per key in the order he meets
       them — Google Places, QuickEmailVerification, Verifalia (a user name and a password), Reoon, GitHub token
       (with the repository name under it) — and, folded, the optional ones (ZeroBounce, Hunter). Each card: the
       status in words (Not set / Set — working / Set — not tested yet / Set — problem: …), the numbered steps and
       an "Open …" link, a password box, Test and save, and for a set key Test and Forget. A key set on the
       server by the developer says so and has no box. A value is never shown back; a refused key keeps what he
       typed so he can fix it; a saved one is cleared from the box at once.
     · Settings › Is everything running? points to both when something is still missing (trials.js).
     · #settings/keys and #settings/details open the sections; ⌘K lists them.

   Loaded after warmup.js: reuses tk, currentView, machineFetch, trialsRepaint, tkAttr, tkSafeUrl, tkLink, tkDomId,
   tkRel, tkFull, tkSentence, tkTruthy, renderLoading and the shell's esc / toast.
   Rules as in trials.js: every machine string through esc(), links through tkSafeUrl/tkLink, handler arguments only
   through tkAttr(); render functions never touch the DOM; nothing runs at load time.
   ========================================================================== */

/* ===================== 0. CONSTANTS + CACHE ===================== */
const KY_FRESH_MS=5*60000;      // the keys and the details are asked for at most every 5 minutes (not by the 60-second refresh)
const KY_WAIT_MS=40000;         // a save checks the key with the service first: longer than the usual 30 s
/* The cards in the order the owner meets them. label = the heading; provider = the "Open …" link's words;
   why = one plain line. GITHUB_REPO is a plain setting shown inside the GitHub token card. */
const KY_CARDS=[
  {name:'PLACES_API_KEY',label:'Google Places',provider:'Google Cloud',why:'Finds the businesses we email and counts the market.'},
  {name:'QUICKEMAILVERIFICATION_API_KEY',label:'QuickEmailVerification',provider:'QuickEmailVerification',why:'Checks that an email address is real before we write to it.'},
  {name:'VERIFALIA',label:'Verifalia',provider:'Verifalia',why:'A second email checker. It is a login: a user name and a password.',login:true},
  {name:'REOON_API_KEY',label:'Reoon',provider:'Reoon',why:'A third email checker.'},
  {name:'GITHUB_TOKEN',label:'GitHub token',provider:'GitHub',why:'Lets the system start the lead finder, which looks for the businesses to email.'},
  {name:'GITHUB_REPO',label:'Repository name',provider:'GitHub',why:'Where the lead finder runs. Leave the default unless your developer moved the code.',plain:true,def:'limethsith-create/email-distributor'},
  {name:'ZEROBOUNCE_API_KEY',label:'ZeroBounce',provider:'ZeroBounce',why:'Another email checker, for when the free ones run out for the day.',optional:true},
  {name:'HUNTER_API_KEY',label:'Hunter',provider:'Hunter',why:'Another email checker, for when the free ones run out for the day.',optional:true},
];
const KY_INTRO='Keys are like passwords that let one system talk to another. Each one is free to make; paste it here once.';
/* The keys, their error and what each card last said; `busy` = {name, kind} while one call is on its way. */
const kyState={s:null,sAt:0,sErr:null,sBusy:null,busy:null,msg:{}};

/* Settings › Your details: the fields, their plain labels and helper lines. required = the first trial cannot
   start without it; emptyOk = an empty box is fine (the system has its own fallback). */
const YD_FIELDS=[
  {key:'OWNER.signerName',label:'Your full name',help:'Signs the agreements and the emails.',required:true,type:'text',auto:'name'},
  {key:'OWNER.address',label:'Your postal address',help:'Goes at the bottom of every email — US law requires one.',required:true,type:'textarea'},
  {key:'OWNER.email',label:'Your email address',help:'Where the system emails you.',type:'email'},
  {key:'ONBOARDCALL.inbox',label:'The onboarding inbox',help:'Which inbox sends the onboarding emails and receives the replies. It must be an inbox the system can log into. Left empty, the first Aviance inbox is used.',type:'email',emptyOk:true},
  {key:'CALENDAR.meetingLink',label:'Your call link',help:'Your Zoom or Google Meet link — used until Google Meet is connected.',type:'url'},
  {key:'PAYMENT.paypalMe',label:'Your PayPal.me link',help:'How a client pays you by PayPal.',type:'url'},
  {key:'PAYMENT.wiseDetails',label:'Your Wise details',help:'As text: what a client needs to pay you by Wise.',type:'textarea'},
  {key:'REVIEW.clutchUrl',label:'Your Clutch review page',help:'The link a happy client gets when we ask for a review.',type:'url'},
];
const YD_NEEDED='needed before the first trial';
/* The rows, their error and what each field last said; `busy` = the key being saved. */
const ydState={s:null,sAt:0,sErr:null,sBusy:null,busy:null,msg:{}};

/* ===================== 1. PURE HELPERS ===================== */
function kyClean(s){return String(s==null?'':s).trim().replace(/[.\s]+$/,'')}
/* The server's help texts say "the machine"; the owner reads "the system" everywhere in the hub. */
function kyPlain(s){return String(s==null?'':s).replace(/\b([Tt])he machine\b/g,'$1he system')}
/* The hub's card for a key name (its label, provider, why); an unknown key gets what the server sent. */
function kyCard(name){name=String(name||'');return KY_CARDS.find(c=>c.name===name)||null}
/* The keys as the server sent them, as a list (or an empty one). */
function kyList(data){return data&&Array.isArray(data.keys)?data.keys.filter(k=>k&&typeof k==='object'&&k.name):[]}
/* One key, normalised: {name, label, provider, why, set, env, ok, problem, testedAt, steps, url, free, note, optional, plain, login, value, def}. */
function kyOf(k){
  k=k||{};const c=kyCard(k.name)||{};const name=String(k.name||'');
  const plain=c.plain||k.secret===false;const label=c.label||String(k.short||k.label||name);
  const tail=String(k.label||'');const why=c.why||(tail.indexOf(' — ')>0?tail.slice(tail.indexOf(' — ')+3):'');
  return {name,label,provider:c.provider||label,why:kyPlain(why),set:tkTruthy(k.set),env:String(k.from||'')==='env',ok:k.ok===true?true:k.ok===false?false:null,
    problem:kyPlain(kyClean(k.problem)),testedAt:k.testedAt||null,steps:(Array.isArray(k.steps)?k.steps:[]).map(s=>kyPlain(String(s==null?'':s))).filter(Boolean),
    url:tkSafeUrl(k.url),free:kyPlain(String(k.free||'').trim()),note:kyPlain(String(k.note||'').trim()),optional:!!(c.optional||tkTruthy(k.optional)),plain,login:!!(c.login||(Array.isArray(k.parts)&&k.parts.length===2)),
    value:plain?String(k.value==null?'':k.value):'',def:plain?String(k.default||c.def||''):''};
}
/* The keys in the order the owner meets them: the hub's order first, unknown ones after, optional ones last. */
function kySorted(data){
  const all=kyList(data).map(kyOf);const out=[];
  KY_CARDS.forEach(c=>{const k=all.find(x=>x.name===c.name);if(k)out.push(k);});
  all.forEach(k=>{if(!out.includes(k))out.push(k);});
  return out.filter(k=>!k.optional).concat(out.filter(k=>k.optional));
}
/* The keys the system needs (not optional, not the plain repository setting). */
function kyRequired(data){return kySorted(data).filter(k=>!k.optional&&!k.plain)}
/* "3 of 5 keys set" and the ones still to paste / with a problem → {n, of, missing:[labels], broken:[labels]}. */
function kyCount(data){
  const req=kyRequired(data);
  return {n:req.filter(k=>k.set).length,of:req.length,missing:req.filter(k=>!k.set).map(k=>k.label),broken:kySorted(data).filter(k=>k.set&&k.ok===false).map(k=>k.label)};
}
/* The status in words, as a pill. */
function kyPillOf(k){
  if(k.plain)return k.set?'<span class="pill green">Set</span>':'<span class="pill grey">The default</span>';
  if(!k.set)return '<span class="pill grey">Not set</span>';
  if(k.ok===true)return '<span class="pill green">Set — working</span>';
  if(k.ok===false)return `<span class="pill red tk-ky-pill">${esc('Set — problem: '+(k.problem||'the service turned it down'))}</span>`;
  return '<span class="pill amber">Set — not tested yet</span>';
}
/* The Settings list's one-line state: "3 of 5 set" (green when all are set and work; red when one has a problem). */
function kyPillHTML(data){
  if(!data)return '';const c=kyCount(data);
  const tone=c.broken.length?'red':c.n===c.of&&c.of>0?'green':'amber';
  return `<span class="pill ${tone}" id="kyPill">${esc(c.n+' of '+c.of+' set'+(c.broken.length?' — '+c.broken.length+' problem'+(c.broken.length===1?'':'s'):''))}</span>`;
}
function kyMsgHTML(m){
  if(!m)return '';
  if(m.busy)return '<p class="tk-ky-wait" role="status">Testing…</p>';
  return `<p class="tk-status ${m.ok?'green':'red'}">${esc(m.text||'')}</p>`;
}

/* -- Your details -- */
function ydRows(data){if(Array.isArray(data))return data.filter(r=>r&&typeof r==='object'&&r.key);const s=data&&(data.settings||data.rows);return Array.isArray(s)?s.filter(r=>r&&typeof r==='object'&&r.key):[]}
function ydText(v){if(v==null)return '';if(typeof v==='string')return v;if(typeof v==='number'||typeof v==='boolean')return String(v);return ''}
function ydField(key){key=String(key||'');return YD_FIELDS.find(f=>f.key===key)||null}
function ydId(key){return tkDomId('',key)}
/* Where a field lives in the rows: its own row (key 'OWNER.signerName'), or the top-level row with the field inside. */
function ydFind(rows,key){
  rows=rows||[];key=String(key||'');
  const own=rows.find(r=>r.key===key);if(own)return {row:own,sub:null};
  const i=key.indexOf('.');if(i<0)return null;
  const top=rows.find(r=>r.key===key.slice(0,i));return top?{row:top,sub:key.slice(i+1)}:null;
}
/* A field's current text, its default and whether it was changed → {known, value, def, changed}. */
function ydValueOf(rows,key){
  const m=ydFind(rows,key);if(!m)return {known:false,value:'',def:'',changed:false};
  const pick=o=>m.sub?(o&&typeof o==='object'?o[m.sub]:undefined):o;
  const value=ydText(pick(m.row.value)),def=ydText(pick(m.row.default));
  return {known:true,value,def,changed:m.sub?value!==def:tkTruthy(m.row.overridden)||value!==def};
}
/* The body that saves a field: its own row as it is; a field inside a top-level row → that row with the one field changed. */
function ydSaveBody(rows,key,text){
  const m=ydFind(rows,key);
  if(!m||!m.sub)return {action:'set',key:String(key),value:text};
  const cur=m.row.value&&typeof m.row.value==='object'?m.row.value:{};
  return {action:'set',key:m.row.key,value:Object.assign({},cur,{[m.sub]:text})};
}
/* The body that clears a field (back to its default): its own row → reset; inside a top-level row → the default back in. */
function ydResetBody(rows,key){
  const m=ydFind(rows,key);
  if(!m||!m.sub)return {action:'reset',key:String(key)};
  const cur=m.row.value&&typeof m.row.value==='object'?m.row.value:{};const def=m.row.default&&typeof m.row.default==='object'?m.row.default:{};
  return {action:'set',key:m.row.key,value:Object.assign({},cur,{[m.sub]:def[m.sub]===undefined?null:def[m.sub]})};
}
/* Still to fill in: every field without a value (the onboarding inbox has its own fallback, so it never counts). */
function ydMissing(rows){return YD_FIELDS.filter(f=>!f.emptyOk&&!ydValueOf(rows,f.key).value)}
function ydPillHTML(data){
  if(!data)return '';const n=ydMissing(ydRows(data)).length;
  return n?`<span class="pill amber" id="ydPill">${esc(n+' still to fill in')}</span>`:'<span class="pill green" id="ydPill">All filled in</span>';
}
/* What was typed, checked: an email must look like one, a link must be whole (https://…). '' = fine. */
function ydProblem(f,text){
  if(!text)return '';
  if(f.type==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))return 'Type the whole email address, like name@example.com.';
  if(f.type==='url'&&!tkSafeUrl(text))return 'Paste the whole link, starting with https://.';
  if(f.type!=='textarea'&&/[\r\n]/.test(text))return 'One line only.';
  return '';
}

/* ===================== 2. RENDERERS (pure: data → HTML) ===================== */
/* One key's card. b = {name, kind} of the call on its way (buttons greyed out, "Testing…"); m = what it last said. */
function renderKeyCard(k,b,m,opts){
  opts=opts||{};const busy=!!(b&&b.name===k.name);
  const locked=!!opts.locked&&!k.plain;   // no encryption key on the server: nothing secret can be stored, so the box and Save are off
  const dis=busy||locked?' disabled':'';
  const id=tkDomId('',k.name);
  const tested=k.set&&k.testedAt?`<p class="tk-ky-tested" title="${esc(tkFull(k.testedAt))}">${esc('Last tested '+tkRel(k.testedAt))}</p>`:'';
  const env=k.env?'<p class="tk-ky-env">Set on the server by your developer — there is nothing to paste here.</p>':'';
  const open=k.url?`<a class="btn ghost tk-ky-open" href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">${esc('Open '+k.provider)} ↗</a>`:'';
  const stepsList=k.steps.length?`<ol class="tk-gm-steps tk-ky-steps">${k.steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol>`:'';
  const note=k.note?`<p class="tk-ky-note">${esc(k.note)}</p>`:'';
  const how=stepsList||open?(k.set?`<details class="tk-ky-how"><summary>${k.plain?'How to change it':'How to get a new one'}</summary>${stepsList}${note}${open}</details>`:`<h5 class="tk-ky-h5">How to get it</h5>${stepsList}${note}${open}`):'';
  let form='';
  if(!k.env){
    const label=busy&&b.kind==='save'?'Testing…':k.plain?'Save':'Test and save';
    const box=(sid,lab,type,ph,extra)=>`<div class="field"><label for="${esc(sid)}">${esc(lab)}</label><input id="${esc(sid)}" data-tk-form type="${type}" autocomplete="off" autocapitalize="off" spellcheck="false"${ph?` placeholder="${esc(ph)}"`:''}${extra||''}${dis}></div>`;
    const fields=k.login?box('kyUser-'+id,'User name','text','')+box('kyIn-'+id,'Password','password','')
      :k.plain?box('kyIn-'+id,k.set&&k.value?'Repository name (now '+k.value+')':'Repository name','text',k.def||'owner/repository')
      :box('kyIn-'+id,k.set?'Paste a new key only to replace the saved one':'Paste the key','password','');
    form=`<div class="tk-ky-form">${fields}<button type="button" class="btn" id="${esc('kySave-'+id)}" onclick="kySave(${tkAttr(k.name)},this)"${dis}>${esc(label)}</button></div>`;
  }
  const acts=[];
  if(k.set&&!k.plain)acts.push(`<button type="button" class="btn ghost" id="${esc('kyTest-'+id)}" onclick="kyTest(${tkAttr(k.name)},this)"${dis}>${busy&&b.kind==='test'?'Testing…':'Test'}</button>`);
  if(k.set&&!k.env)acts.push(`<button type="button" class="btn ghost" id="${esc('kyForget-'+id)}" onclick="kyForget(${tkAttr(k.name)},this)"${dis}>${busy&&b.kind==='forget'?'Forgetting…':'Forget'}</button>`);
  const msg=`<div class="tk-ky-msg" id="${esc('kyMsg-'+id)}" role="status" aria-live="polite">${kyMsgHTML(busy?{busy:true}:m)}</div>`;
  const inner=`<div class="tk-ky-head"><h4>${esc(k.label)}</h4>${kyPillOf(k)}</div>
    ${k.why?`<p class="tk-ky-why">${esc(k.why)}</p>`:''}${k.free?`<p class="tk-ky-free">${esc(k.free)}</p>`:''}${tested}${env}${how}${form}${acts.length?`<div class="tk-ky-acts">${acts.join('')}</div>`:''}${msg}`;
  return opts.inside?`<div class="tk-ky-repo" id="${esc('kyCard-'+id)}">${inner}</div>`:`<section class="tk-ky-card" id="${esc('kyCard-'+id)}">${inner}</section>`;
}
/* The body of Settings › Keys: the intro, "3 of 5 keys set", the cards, the optional ones folded. */
function renderKeysBody(c){
  c=c||{};const data=c.data;const keys=kySorted(data);const b=c.busy||null;const msgs=c.msg||{};
  const cnt=kyCount(data);
  const tone=cnt.broken.length?'red':cnt.n===cnt.of?'green':'amber';
  const say=cnt.n+' of '+cnt.of+' keys set.'+(cnt.missing.length?' Still to paste: '+cnt.missing.join(', ')+'.':'')+(cnt.broken.length?' A problem with: '+cnt.broken.join(', ')+'.':'')+(cnt.n===cnt.of&&!cnt.broken.length?' Everything the lead finder needs is in place.':'');
  const locked=!!data&&data.encKey===false;
  const lock=locked?'<p class="tk-gm-lock">Keys can\'t be stored yet (server encryption key missing). Ask your developer to set it — until then nothing you paste here can be saved.</p>':'';
  // the repository name sits inside the GitHub token card (its own card only when the token is not listed)
  const repo=keys.find(k=>k.plain&&k.name==='GITHUB_REPO')||null;const hasToken=keys.some(k=>k.name==='GITHUB_TOKEN');
  const card=k=>{
    if(k===repo&&hasToken)return '';
    let h=renderKeyCard(k,b,msgs[k.name],{locked});
    if(repo&&k.name==='GITHUB_TOKEN')h=h.replace(/<\/section>$/,renderKeyCard(repo,b,msgs[repo.name],{inside:true,locked})+'</section>');
    return h;
  };
  const main=keys.filter(k=>!k.optional).map(card).join('');
  const opt=keys.filter(k=>k.optional);
  const optional=opt.length?`<details class="tk-ky-opt"><summary>${esc('Optional — '+opt.length+' more checker'+(opt.length===1?'':'s')+', not needed to start')}</summary><div class="tk-ky-cards">${opt.map(card).join('')}</div></details>`:'';
  return `<p class="tk-set-text">${esc(KY_INTRO)}</p><p class="tk-status ${tone}">${esc(say)}</p>${lock}<div class="tk-ky-cards">${main}</div>${optional}`;
}
/* Settings › Keys. c = kySettingsCtx(): {data (GET /api/mc/keys), err, busy, msg} → {state, body}. */
function renderKeysSet(c){
  c=c||{};const data=c.data&&typeof c.data==='object'?c.data:null;
  const state=kyPillHTML(data);
  if(!data)return {state,body:c.err?`<p class="tk-note red">${esc(c.err)} <button type="button" class="tk-textbtn" onclick="kyRetry()">Try again</button></p>`:renderLoading('Checking your keys…')};
  return {state,body:`<div id="kyHost">${renderKeysBody(c)}</div>`};
}

/* -- Settings › Your details -- */
/* One field: the label (amber "needed before the first trial" while a required one is empty), the helper line,
   the box with what is set now, Save (Enter saves too), Clear when he changed it, and what it last said. */
function renderDetailField(f,rows,busyKey,m){
  const v=ydValueOf(rows,f.key);const id=ydId(f.key);const need=!!f.required&&!v.value;
  const busy=busyKey===f.key;const dis=busy?' disabled':'';
  const req=f.required?`<span class="tk-yd-req${need?' need':''}">${esc(need?YD_NEEDED:'needed — filled in')}</span>`:'';
  const common=`id="${esc('ydIn-'+id)}" data-tk-form${dis}`;
  const box=f.type==='textarea'
    ?`<textarea ${common} rows="3" autocomplete="off">${esc(v.value)}</textarea>`
    :`<input ${common} type="${f.type==='url'?'url':f.type==='email'?'email':'text'}"${f.type==='email'?' inputmode="email"':f.type==='url'?' inputmode="url"':''} autocomplete="${esc(f.auto||'off')}" autocapitalize="${f.type==='text'?'words':'off'}" spellcheck="false" value="${esc(v.value)}"${v.def&&!v.value?` placeholder="${esc(v.def)}"`:''} onkeydown="ydKey(event,${tkAttr(f.key)})">`;
  const clear=v.changed&&v.value?`<button type="button" class="tk-textbtn" onclick="ydReset(${tkAttr(f.key)},this)"${dis}>${v.def?'Use the default':'Clear'}</button>`:'';
  const unknown=v.known?'':'<p class="tk-yd-help">Your system doesn\'t have this setting yet — ask your developer for the newest update.</p>';
  return `<div class="tk-yd-field${need?' need':''}" id="${esc('ydField-'+id)}">
    <label for="${esc('ydIn-'+id)}">${esc(f.label)}${req}</label>
    <p class="tk-yd-help">${esc(f.help)}</p>${unknown}
    <div class="tk-yd-row">${box}<button type="button" class="btn" id="${esc('ydSave-'+id)}" onclick="ydSave(${tkAttr(f.key)},this)"${dis}>${busy?'Saving…':'Save'}</button></div>
    ${clear}<div class="tk-yd-msg${m?(m.ok?' green':' red'):''}" id="${esc('ydMsg-'+id)}" role="status" aria-live="polite">${m?esc(m.text||''):''}</div>
  </div>`;
}
function renderDetailsBody(c){
  c=c||{};const rows=ydRows(c.data);const missing=ydMissing(rows);const msgs=c.msg||{};
  const need=missing.filter(f=>f.required);
  const say=missing.length?'Still to fill in: '+missing.length+' — '+missing.map(f=>f.label).join(', ')+'.'+(need.length?' The first trial cannot start without '+(need.length===1?need[0].label.toLowerCase():'your name and address')+'.':''):'Everything is filled in.';
  return `<p class="tk-set-text">What the emails and agreements say about you. Each box saves by itself — press Save (or Enter) after you change one.</p>
    <p class="tk-status ${missing.length?'amber':'green'}">${esc(say)}</p>
    <div class="tk-yd-form">${YD_FIELDS.map(f=>renderDetailField(f,rows,c.busy,msgs[f.key])).join('')}</div>`;
}
/* Settings › Your details. c = ydSettingsCtx(): {data (GET /api/mc/config), err, busy, msg} → {state, body}. */
function renderDetailsSet(c){
  c=c||{};const data=c.data&&typeof c.data==='object'?c.data:null;
  const state=ydPillHTML(data);
  if(!data)return {state,body:c.err?`<p class="tk-note red">${esc(c.err)} <button type="button" class="tk-textbtn" onclick="ydRetry()">Try again</button></p>`:renderLoading('Loading your details…')};
  return {state,body:`<div id="ydHost">${renderDetailsBody(c)}</div>`};
}

/* ===================== 3. LOADERS ===================== */
async function loadKeys(force){
  if(!force&&kyState.s&&Date.now()-kyState.sAt<KY_FRESH_MS)return {ok:true,data:kyState.s};
  if(kyState.sBusy)return kyState.sBusy;
  const p=machineFetch('/api/mc/keys').then(r=>{
    kyState.sBusy=null;
    if(r.ok&&r.data&&Array.isArray(r.data.keys)){kyState.s=r.data;kyState.sAt=Date.now();kyState.sErr=null;}
    else{kyState.sErr=r.error||"We couldn't read your keys. Try again. (For your developer: no \"keys\" in the answer.)";if(r.ok)r.ok=false;}
    return r;
  });
  kyState.sBusy=p;return p;
}
async function loadDetails(force){
  if(!force&&ydState.s&&Date.now()-ydState.sAt<KY_FRESH_MS)return {ok:true,data:ydState.s};
  if(ydState.sBusy)return ydState.sBusy;
  const p=machineFetch('/api/mc/config').then(r=>{
    ydState.sBusy=null;
    if(r.ok&&ydRows(r.data).length){ydState.s=r.data;ydState.sAt=Date.now();ydState.sErr=null;}
    else{ydState.sErr=r.error||"We couldn't read your details. Try again. (For your developer: no \"settings\" in the answer.)";if(r.ok)r.ok=false;}
    return r;
  });
  ydState.sBusy=p;return p;
}
function kySettingsCtx(){return {data:kyState.s,err:kyState.sErr,busy:kyState.busy,msg:kyState.msg}}
function ydSettingsCtx(){return {data:ydState.s,err:ydState.sErr,busy:ydState.busy,msg:ydState.msg}}
/* For "Is everything running?": how many keys are still to paste and how many details to fill in (null = not known yet). */
function kyStillToDo(){return {keys:kyState.s?kyCount(kyState.s).missing.length:null,details:ydState.s?ydMissing(ydRows(ydState.s)).length:null}}

/* ===================== 4. ACTIONS ===================== */
/* -- Settings › Keys -- */
function kyRetry(){return loadKeys(true).then(()=>trialsRepaint('settings'))}
/* Redraw the cards and the pill from the cache — keeping what is typed in the other cards (clearName's boxes are
   emptied: that key was just saved or forgotten). Settings not on screen: nothing to draw. */
function kyRepaint(clearName){
  tk.setOpen.keys=true;
  if(currentView!=='settings')return;
  const c=kySettingsCtx();const host=document.getElementById('kyHost');
  if(!c.data||!host){trialsRepaint('settings');return;}
  const keep={};
  kySorted(c.data).forEach(k=>{if(k.name===clearName)return;['kyIn-','kyUser-'].forEach(p=>{const e=document.getElementById(p+tkDomId('',k.name));if(e&&e.value)keep[p+tkDomId('',k.name)]=e.value;});});
  host.innerHTML=renderKeysBody(c);
  Object.keys(keep).forEach(id=>{const e=document.getElementById(id);if(e)e.value=keep[id];});
  const pill=document.getElementById('kyPill');const st=kyPillHTML(c.data);if(pill&&st)pill.outerHTML=st;
}
async function kyAfter(clearName){await loadKeys(true);kyRepaint(clearName);}
/* While a call is on its way: that card's boxes and buttons greyed out, the pressed one saying what it does (by id — the
   page may have been redrawn). */
function kyBusy(name,kind,on){
  const id=tkDomId('',name);const k=kyOf((kyList(kyState.s).find(x=>x.name===name))||{name});
  ['kyIn-','kyUser-','kySave-','kyTest-','kyForget-'].forEach(p=>{const e=document.getElementById(p+id);if(e)e.disabled=!!on;});
  const words={save:['kySave-',on?'Testing…':k.plain?'Save':'Test and save'],test:['kyTest-',on?'Testing…':'Test'],forget:['kyForget-',on?'Forgetting…':'Forget']}[kind];
  if(words){const b=document.getElementById(words[0]+id);if(b)b.textContent=words[1];}
  const m=document.getElementById('kyMsg-'+id);if(m)m.innerHTML=kyMsgHTML(on?{busy:true}:kyState.msg[name]);
}
/* One call at a time. Never a confirm here (kyForget asks before). */
async function kySend(name,kind,body){
  if(kyState.busy){toast('Still working on the last one…');return {ok:false,busy:true};}
  kyState.busy={name,kind};kyState.msg[name]=null;kyBusy(name,kind,true);
  try{
    const r=await machineFetch('/api/mc/keys',{body,timeout:KY_WAIT_MS});
    // a good answer carries the card, whose own `ok` is the check's outcome (false = the key has a problem) — not a refusal
    if(!r.ok&&r.data&&(r.data.saved===true||r.data.tested===true||r.data.forgotten===true))return {ok:true,status:r.status,data:r.data,error:null};
    return r;
  }
  finally{kyState.busy=null;kyBusy(name,kind,false);}
}
function kySay(name,m){kyState.msg[name]=m;const box=document.getElementById('kyMsg-'+tkDomId('',name));if(box)box.innerHTML=kyMsgHTML(m);}
/* Test and save: the system checks the key with the service, then keeps it. A refused key is not saved and what was
   typed stays in the box; a saved one is cleared from the page at once. */
async function kySave(name){
  name=String(name||'');const id=tkDomId('',name);const k=kyOf((kyList(kyState.s).find(x=>x.name===name))||kyCard(name)||{name});
  const inp=document.getElementById('kyIn-'+id),usr=document.getElementById('kyUser-'+id);
  const value=String((inp&&inp.value)||'').trim(),username=String((usr&&usr.value)||'').trim();
  if(!k.plain&&kyState.s&&kyState.s.encKey===false){kySay(name,{ok:false,text:"Keys can't be stored yet (server encryption key missing). Ask your developer to set it."});return {ok:false};}
  let body;
  if(k.login){
    if(!username){kySay(name,{ok:false,text:'Type the user name first.'});return {ok:false};}
    if(!value){kySay(name,{ok:false,text:'Paste the password first.'});return {ok:false};}
    body={action:'save',name,username,password:value};
  }else{
    if(!value){kySay(name,{ok:false,text:k.plain?'Type the repository name first, like owner/repository.':'Paste the key first.'});return {ok:false};}
    if(!k.plain&&/\s/.test(value)){kySay(name,{ok:false,text:'Paste the whole key, with no spaces or line breaks.'});return {ok:false};}
    body={action:'save',name,value};
  }
  const r=await kySend(name,'save',body);
  if(r.busy)return r;
  if(!r.ok){kySay(name,{ok:false,text:tkSentence(r.error||"That didn't work. Try again.")});return r;}   // what was typed stays, so he can fix it
  if(inp)inp.value='';if(usr)usr.value='';   // never kept on the page once it is saved
  const d=r.data||{};
  const text=d.ok===true?'Working — saved':k.plain?'Saved.':'Saved — not tested yet'+(d.problem&&!/not tested/i.test(String(d.problem))?': '+kyClean(d.problem):'');
  kySay(name,{ok:true,text});toast(text);
  await kyAfter(name);
  return r;
}
async function kyTest(name){
  name=String(name||'');
  const r=await kySend(name,'test',{action:'test',name});
  if(r.busy)return r;
  const d=(r&&r.data)||{};
  const m=!r.ok?{ok:false,text:tkSentence(r.error||"The test didn't work.")}
    :d.ok===true?{ok:true,text:'Working.'}
    :d.ok===false?{ok:false,text:'Problem: '+kyClean(d.problem||'the service turned the key down')+'.'}
    :{ok:false,text:"Couldn't test it"+(d.problem&&!/not tested/i.test(String(d.problem))?': '+kyClean(d.problem):' — the service didn\'t answer')+'. Try again in a minute.'};
  kySay(name,m);toast(m.text);
  await kyAfter(null);   // the status changed either way
  return r;
}
async function kyForget(name){
  name=String(name||'');const k=kyOf((kyList(kyState.s).find(x=>x.name===name))||kyCard(name)||{name});
  if(typeof confirm==='function'&&!confirm('Forget the '+k.label+(k.plain?' setting':' key')+'? The system stops using it until you paste '+(k.plain?'a new one':'it again')+'.'))return {ok:false,cancelled:true};
  const r=await kySend(name,'forget',{action:'forget',name});
  if(r.busy)return r;
  if(!r.ok){kySay(name,{ok:false,text:tkSentence(r.error||"That didn't work.")});return r;}
  kySay(name,{ok:true,text:'Forgotten.'});toast('Forgotten');
  await kyAfter(name);
  return r;
}

/* -- Settings › Your details -- */
function ydRetry(){return loadDetails(true).then(()=>trialsRepaint('settings'))}
function ydSay(key,m){ydState.msg[key]=m;const box=document.getElementById('ydMsg-'+ydId(key));if(box){box.innerHTML=m?esc(m.text||''):'';box.className='tk-yd-msg'+(m?(m.ok?' green':' red'):'');}}
/* Redraw one field from the cache (its value, the amber mark, Clear) and the summary line and pill — never the other fields. */
function ydRepaint(key){
  tk.setOpen.details=true;
  if(currentView!=='settings')return;
  const c=ydSettingsCtx();const host=document.getElementById('ydHost');
  if(!c.data||!host){trialsRepaint('settings');return;}
  const f=ydField(key);const rows=ydRows(c.data);
  const el=f?document.getElementById('ydField-'+ydId(key)):null;
  if(f&&el)el.outerHTML=renderDetailField(f,rows,c.busy,(c.msg||{})[key]);else host.innerHTML=renderDetailsBody(c);
  const pill=document.getElementById('ydPill');const st=ydPillHTML(c.data);if(pill&&st)pill.outerHTML=st;
}
async function ydAfter(key){await loadDetails(true);ydRepaint(key);}
function ydBusy(key,on){
  const id=ydId(key);['ydIn-','ydSave-'].forEach(p=>{const e=document.getElementById(p+id);if(e)e.disabled=!!on;});
  const b=document.getElementById('ydSave-'+id);if(b)b.textContent=on?'Saving…':'Save';
}
async function ydSend(key,body){
  if(ydState.busy){toast('Still working on the last one…');return {ok:false,busy:true};}
  ydState.busy=key;ydState.msg[key]=null;ydBusy(key,true);
  try{return await machineFetch('/api/mc/config',{body});}
  finally{ydState.busy=null;ydBusy(key,false);}
}
/* Enter in a box saves it (a textarea keeps Enter for a new line). */
function ydKey(evt,key){if(evt&&evt.key==='Enter'&&!evt.shiftKey){if(evt.preventDefault)evt.preventDefault();ydSave(key);}}
/* Save one field: an empty box clears it (back to the default). The value goes as JSON text. */
async function ydSave(key){
  key=String(key||'');const f=ydField(key);if(!f)return {ok:false};
  const inp=document.getElementById('ydIn-'+ydId(key));const text=String((inp&&inp.value)||'').trim();
  const problem=ydProblem(f,text);if(problem){ydSay(key,{ok:false,text:problem});return {ok:false};}
  const rows=ydRows(ydState.s);
  const r=await ydSend(key,text?ydSaveBody(rows,key,text):ydResetBody(rows,key));
  if(r.busy)return r;
  if(!r.ok){ydSay(key,{ok:false,text:tkSentence(r.error||"That didn't work. Try again.")});return r;}
  ydSay(key,{ok:true,text:text?'Saved.':'Cleared.'});toast(text?'Saved — '+f.label.toLowerCase():'Cleared — '+f.label.toLowerCase());
  await ydAfter(key);
  return r;
}
async function ydReset(key){
  key=String(key||'');const f=ydField(key);if(!f)return {ok:false};
  const r=await ydSend(key,ydResetBody(ydRows(ydState.s),key));
  if(r.busy)return r;
  if(!r.ok){ydSay(key,{ok:false,text:tkSentence(r.error||"That didn't work. Try again.")});return r;}
  ydSay(key,{ok:true,text:'Cleared.'});toast('Cleared — '+f.label.toLowerCase());
  await ydAfter(key);
  return r;
}

/* ===================== 5. SHELL INTEGRATION ===================== */
function keysForget(){Object.assign(kyState,{s:null,sAt:0,sErr:null,sBusy:null,busy:null,msg:{}});Object.assign(ydState,{s:null,sAt:0,sErr:null,sBusy:null,busy:null,msg:{}});}
