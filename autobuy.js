/* ============================================================================
   autobuy.js — Aviance Hub · Inboxes & domain (CheapInboxes)
   ----------------------------------------------------------------------------
   Contract: email-distributor/docs/AUTO-BUY.md ("Buy once, the rest sets itself up").
     GET  /api/mc/hub/{id}               → … autobuy {status, buy, label, domain, steps, mailboxes, problem}
     POST /api/mc/clients/{id}/autobuy   {action:'recheck'} · {action:'pick', domain} · {action:'link', domain}
                                         · {action:'unlink'}                                → {ok, autobuy}
     GET  /api/mc/cheapinboxes           → {status, account, hasPaymentMethod, webhook, unmatched:[{domain, mailboxes, boughtAt}]}
     POST /api/mc/cheapinboxes           {action:'saveKey', apiKey} · {action:'test'} · {action:'forget'}
   The system NEVER buys anything or spends money: the owner buys in his own CheapInboxes account; the system
   finds the purchase, matches it to the trial and sets up everything after it. Nothing here can place an order.

   What the owner sees
     · A trial waiting for its domain (autobuy.status 'ready_to_buy'): the big button "Buy their domain and
       2 inboxes on CheapInboxes" opens a plain panel with exactly what to buy — the domain (up to 3 other free
       names folded under it, "Buy this one instead"), Google, the two inboxes (first name, last name, email
       prefix, full address, each with Copy), "Open CheapInboxes" and "I've bought it — check now".
     · After the purchase: the "Inboxes & domain" card — the steps with ticks and times (the current one
       highlighted), the plain sentence, each inbox and how far it is, the problem in plain words when it
       failed (+ "Check now"), and "Wrong domain? Undo" until anything is connected.
     · Settings › Inboxes & domains: the status in words, whether a card is on file, six numbered steps, the
       API key (a password box) with Save, Test it and Forget, and purchases we couldn't match ("This is for…").
     · CheapInboxes not set up: the Buy & paste page stays; the trial page points to Settings (trials.js).

   Loaded after messages.js: reuses tk, currentView, currentTrialId, machineFetch, trialPost, loadTrial, loadHub,
   trialsRepaint, renderTrialTop, tkAutobuy, tkSimple, tkListRows, tkFindRow, tkOcName, tkAttr, tkSafeUrl, tkLink,
   tkMoney, tkNorm, tkTruthy, tkDateTime, tkDayName, tkFull, tkSentence, tkHuman, renderLoading and the shell's
   esc / toast / openModal / closeModal / renderNav / updateNotifBadge.
   Rules as in trials.js: every machine string through esc(), links through tkSafeUrl/tkLink, handler arguments
   only through tkAttr(); render functions never touch the DOM; nothing runs at load time.
   ========================================================================== */

/* ===================== 0. CONSTANTS + CACHE ===================== */
const AB_HOME='https://cheapinboxes.com';    // the sign-up page, and the order page when the system sends none (or an odd one)
const AB_FRESH_MS=5*60000;                   // the CheapInboxes status is asked for at most every 5 minutes (not by the 60-second refresh)
/* Settings › Inboxes & domains: the status in one word. */
const AB_SET={not_set_up:{pill:'grey',word:'Not set up'},connected:{pill:'green',word:'Connected'},broken:{pill:'red',word:'Problem'}};
/* One inbox, how far it is. */
const AB_BOX={provisioning:['amber','Being created'],active:['blue','Created'],connected:['green','Connected']};
const AB_PROVIDER={google:'Google',microsoft:'Microsoft'};

/* The Settings status, its error and the last test; `busy` stops a second click sending twice; `open` = the trial
   whose "what to buy" panel is open. */
const abState={s:null,sAt:0,sErr:null,sBusy:null,test:null,busy:false,open:null};

/* ===================== 1. PURE HELPERS ===================== */
function abInboxes(n){return n+' inbox'+(n===1?'':'es')}
function abProvider(p){p=String(p||'google').toLowerCase();return AB_PROVIDER[p]||tkHuman(p)}
/* The inboxes to make: first name, last name, email prefix, full address (each may be missing — then left out). */
function abBoxes(buy){
  const dom=String((buy&&buy.domain)||'').trim();
  return (buy&&Array.isArray(buy.mailboxes)?buy.mailboxes:[]).filter(m=>m&&typeof m==='object').map(m=>{
    const prefix=String(m.prefix||'').trim();let email=String(m.email||'').trim();
    if(!email&&prefix&&dom)email=prefix+'@'+dom;
    return {first:String(m.firstName||'').trim(),last:String(m.lastName||'').trim(),prefix:prefix||(email.indexOf('@')>0?email.split('@')[0]:''),email};
  });
}
/* Up to 3 other free names (never the one already picked, never twice). */
function abAlts(buy){
  const seen={};seen[String((buy&&buy.domain)||'').trim().toLowerCase()]=1;
  return (buy&&Array.isArray(buy.alternatives)?buy.alternatives:[]).filter(a=>{
    const k=String((a&&a.domain)||'').trim().toLowerCase();if(!k||seen[k])return false;seen[k]=1;return true;
  }).slice(0,3);
}
/* "Wrong domain? Undo" — only before anything was connected (the contract's `unlink`). */
function abCanUndo(ab){
  if(!ab||!['provisioning','connecting','failed'].includes(ab.status))return false;
  if(ab.mailboxes.some(m=>String(m.status||'').toLowerCase()==='connected'))return false;
  return !ab.steps.some(x=>['connected','warmup'].includes(String(x.key||''))&&tkTruthy(x.done));
}
function abPath(id){return '/api/mc/clients/'+encodeURIComponent(id)+'/autobuy'}

/* ===================== 2. RENDERERS (pure: data → HTML) ===================== */
/* The "what to buy" panel (opened by the big button while autobuy.status is 'ready_to_buy'). */
function renderAutobuyBuy(d){
  d=d||{};const row=d.row||{};const id=row.id;const ab=tkAutobuy(d);
  const close='<div class="modal-foot"><button type="button" class="btn ghost" onclick="abCloseBuy()">Close</button></div>';
  if(!ab||!ab.toBuy)return `<div class="modal-head"><div><h3>Nothing to buy right now</h3><p>This trial isn't waiting for a domain.</p></div></div>${close}`;
  const buy=ab.buy;const inb=abInboxes(ab.count);const prov=abProvider(buy.provider);const company=tkSimple(row).company;
  const copy=(v,what)=>`<button type="button" class="btn ghost tk-abb-copy" onclick="abCopy(${tkAttr(v)})" aria-label="${esc('Copy '+what)}">Copy</button>`;
  // a long address may wrap on a phone: after the "@", never in the middle of a word
  const line=(k,v,what)=>v?`<small>${esc(k)}</small><b>${esc(v).replace(/@/g,'@<wbr>')}</b>${copy(v,what)}`:'';
  const price=tkNorm(buy.price);
  const alts=abAlts(buy);
  const altHtml=alts.length?`<details class="tk-abb-alts"><summary>Rather a different name? ${alts.length===1?'1 more is':alts.length+' more are'} free</summary><ul>${alts.map(a=>`<li><span><b class="tk-break">${esc(a.domain)}</b>${tkNorm(a.price)!=null?' · '+tkMoney(a.price):''}</span><button type="button" class="btn ghost" onclick="abPick(${tkAttr(id)},${tkAttr(a.domain)},this)">Buy this one instead</button></li>`).join('')}</ul></details>`:'';
  const boxes=abBoxes(buy).map((m,i)=>`<div class="tk-abb-box"><p class="tk-abb-boxh">Inbox ${i+1}</p><div class="tk-abb-kv">${line('First name',m.first,'the first name')}${line('Last name',m.last,'the last name')}${line('Email prefix',m.prefix,'the email prefix')}${line('Full address',m.email,'the full address')}</div></div>`).join('');
  const url=tkSafeUrl(buy.orderUrl)||AB_HOME;
  return `<div class="modal-head"><div><h3>${esc('Buy their domain and '+inb)}</h3><p>${esc('For '+company+', in your CheapInboxes account. We never buy anything ourselves.')}</p></div></div>
  <div class="modal-body tk-abb" id="abBuy">
    <h4>1. The domain</h4>
    <div class="tk-abb-kv">${line('Domain',ab.domain,'the domain')}</div>
    ${price!=null?`<p class="tk-abb-text">Price on CheapInboxes: <b>${tkMoney(price)}</b>.</p>`:''}
    ${altHtml}
    <h4>2. The inboxes</h4>
    <p class="tk-abb-text">${esc(prov+', '+inb+'. Give them exactly these names:')}</p>
    ${boxes}
    <h4>3. Buy them</h4>
    <p class="tk-abb-text">${esc('Open CheapInboxes, pick this domain with '+inb+' from '+prov+', and pay. It is charged to the card on your CheapInboxes account.')}</p>
    <a class="btn tk-abb-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open CheapInboxes ↗</a>
    <p class="tk-abb-after">After you buy, we connect everything by ourselves — you'll get a message.</p>
    <button type="button" class="tk-textbtn" onclick="abRecheck(${tkAttr(id)},this)">I've bought it — check now</button>
  </div>${close}`;
}
/* The "Inboxes & domain" card on a trial, once the domain is bought (and while it fails). Before that the big button
   opens "what to buy" — unless something more urgent has the big button: then a small card keeps the way in.
   meta.primary = the big button's kind (worked out here when not given). */
function renderAutobuyCard(d,meta){
  d=d||{};meta=meta||{};const row=d.row||{};const id=row.id;const ab=tkAutobuy(d);
  if(!ab||!ab.handled)return '';
  if(ab.status==='ready_to_buy'){
    const primary=meta.primary!=null?meta.primary:tkPrimaryAction(d,{now:meta.now}).kind;
    if(primary==='autobuy')return '';
    return `<section class="card tk-ab" id="tkSec-autobuy"><h3>Inboxes &amp; domain</h3><p class="tk-ab-say">${esc('Waiting for you to buy '+ab.domain+' and '+abInboxes(ab.count)+' on CheapInboxes.')}</p><div class="tk-ab-acts"><button type="button" class="btn ghost" onclick="abOpenBuy(${tkAttr(id)})">See what to buy</button></div></section>`;
  }
  const failed=ab.status==='failed',done=ab.status==='done';
  // the inboxes are ready but the warm-up waits for helpers (warmup.js): never "warm-up has started" beside it
  const wuWaits=(tkTrialWarmup(d)||{}).status==='waiting_for_helpers';
  if(wuWaits)ab.steps=ab.steps.map(x=>String(x.key||'')==='warmup'?Object.assign({},x,{done:false,label:'Warm-up waits for more helpers'}):x);
  const cur=done?-1:ab.steps.findIndex(x=>!tkTruthy(x.done));
  const sr={done:'Done: ',now:'Now: ',stuck:'Stuck here: ',todo:'Not yet: '};
  const steps=ab.steps.length?`<ol class="tk-oc-steps tk-ab-steps">${ab.steps.map((x,i)=>{
    const ok=tkTruthy(x.done);const k=ok?'done':i===cur?(failed?'stuck':'now'):'todo';
    const at=ok&&x.at?`<span class="tk-oc-at" title="${esc(tkFull(x.at))}">${esc(tkDateTime(x.at))}</span>`:k==='now'?'<span class="tk-oc-at">Working on it</span>':'';
    return `<li class="${k}"${k==='now'||k==='stuck'?' aria-current="step"':''}><span class="tk-oc-tick" aria-hidden="true">${ok?'✓':k==='stuck'?'!':''}</span><span><span class="tk-sr">${sr[k]}</span>${esc(x.label||tkHuman(x.key))}</span>${at}</li>`;
  }).join('')}</ol>`:'';
  const boxes=ab.mailboxes.length?`<h4>The inboxes</h4><ul class="tk-ab-boxes">${ab.mailboxes.map(m=>{
    const st=String(m.status||'').toLowerCase();const p=AB_BOX[st]||['grey',tkHuman(st)||'Waiting'];
    return `<li><span class="tk-break">${esc(m.email||'')}</span><span class="pill ${p[0]}">${esc(p[1])}</span></li>`;
  }).join('')}</ul>`:'';
  let say=ab.label||(ab.domain?(done?ab.domain+' and its inboxes are ready':'Setting up '+ab.domain):'');
  if(wuWaits)say=say.replace(/\s*[—–-]\s*warm-?up has (started|begun)\.?$/i,'')+(done&&!/helper/i.test(say)?' — warm-up waits for more helpers':'');
  const problem=failed?`<p class="tk-status red">${esc(ab.problem?tkSentence(ab.problem):'Setting up their inboxes ran into a problem.')}</p><div class="tk-ab-acts"><button type="button" class="btn" onclick="abRecheck(${tkAttr(id)},this)">Check now</button></div>`:'';
  const undo=abCanUndo(ab)?`<p class="tk-ab-undo">Wrong domain? <button type="button" class="tk-textbtn" onclick="abUnlink(${tkAttr(id)},this)">Undo</button></p>`:'';
  return `<section class="card tk-ab" id="tkSec-autobuy">
    <h3>Inboxes &amp; domain</h3>
    ${say?`<p class="tk-ab-say">${esc(say)}</p>`:''}${problem}${steps}${boxes}${undo}
  </section>`;
}

/* -- Settings › Inboxes & domains -- c = abSettingsCtx(): {data (GET /api/mc/cheapinboxes), err, test, trials} → {state, body}. */
/* Purchases we couldn't match to a trial: each gets "This is for…" (the trials in the Setting-up step) + Link it. */
function renderAutobuyUnmatched(list,trials){
  list=(Array.isArray(list)?list:[]).filter(u=>u&&typeof u==='object'&&String(u.domain||'').trim());if(!list.length)return '';
  trials=Array.isArray(trials)?trials:[];
  return `<h4 class="tk-set-h4">Bought, but not matched to a trial</h4>
    <p class="tk-set-text">We couldn't tell which trial these are for. Pick the trial and press Link it — we set it up for them.</p>
    <ul class="tk-ab-un">${list.map((u,i)=>{
      const n=tkNorm(u.mailboxes);const facts=[n!=null?abInboxes(n):'',u.boughtAt?'bought '+tkDayName(u.boughtAt):''].filter(Boolean).join(' · ');
      const sid='abUn'+i;
      const pick=trials.length?`<div class="tk-ab-pick"><label for="${sid}">This is for…</label><div class="tk-ab-pickrow"><select id="${sid}" data-tk-form><option value="">Pick a trial</option>${trials.map(t=>`<option value="${esc(t.id)}">${esc(t.company)}</option>`).join('')}</select><button type="button" class="btn" onclick="abLink(${tkAttr(u.domain)},${tkAttr(sid)},this)">Link it</button></div></div>`
        :'<p class="tk-ab-none">No trial is waiting for a domain right now.</p>';
      return `<li><p><b class="tk-break">${esc(u.domain)}</b>${facts?` <span class="tk-ab-facts">· ${esc(facts)}</span>`:''}</p>${pick}</li>`;
    }).join('')}</ul>`;
}
/* The one-time set-up, numbered, one thing per step. */
function renderAutobuySteps(data){
  data=data||{};const st=String(data.status||'');const saved=st==='connected'||st==='broken';
  return `<ol class="tk-gm-steps">
    <li><b>Make an account at CheapInboxes.</b> Open ${tkLink(AB_HOME,'cheapinboxes.com')} and sign up. It's the shop where you buy each trial's domain and inboxes.</li>
    <li><b>Add a card.</b> In your CheapInboxes account, open Billing and add a card. What you buy there is charged to it — we never buy anything ourselves.</li>
    <li><b>Create an API key.</b> In your CheapInboxes account, open API keys and create a new key. It starts with <b>ci_live_</b>. Copy it.</li>
    <li><b>Paste it here.</b>${saved?'<span class="tk-gm-saved">Yours is saved (hidden). Paste a new one only to replace it.</span>':''}
      <div class="tk-gm-form"><div class="field"><label for="abKey">Your CheapInboxes API key</label><input id="abKey" data-tk-form type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ci_live_…"></div></div></li>
    <li><b>Press Save.</b> We check the key with CheapInboxes.
      <div class="tk-gm-form"><button type="button" class="btn" onclick="abSaveKey(this)">Save</button></div></li>
    <li><b>Press Test it</b> (at the top of this section). When it says “It works”, you're done. From then on you buy on CheapInboxes and we set up the rest by ourselves.</li>
  </ol>`;
}
function renderAutobuySet(c){
  c=c||{};const data=c.data&&typeof c.data==='object'?c.data:null;
  const S=data?AB_SET[String(data.status||'')]||null:null;
  const state=S?`<span class="pill ${S.pill}">${esc(S.word)}</span>`:'';
  if(!data)return {state,body:c.err?`<p class="tk-note red">${esc(c.err)} <button type="button" class="tk-textbtn" onclick="abSetRetry()">Try again</button></p>`:renderLoading('Checking CheapInboxes…')};
  const st=String(data.status||'');const acct=String(data.account||'').trim();const on=st==='connected'||st==='broken';
  const reason=String(data.problem||data.error||'').trim().replace(/[.\s]+$/,'');
  const say={
    not_set_up:"Not set up. Do the steps below once — about 10 minutes. After that you buy each trial's domain and inboxes on CheapInboxes, and we set up the rest by ourselves.",
    connected:'Connected'+(acct?' as '+acct:'')+'. When you buy a domain and inboxes there, we find them and set everything up by ourselves.',
    broken:'Problem — '+(reason||"CheapInboxes doesn't accept your key any more")+'. Paste a new key in step 4 and press Save.',
  }[st]||"We couldn't tell whether CheapInboxes is set up.";
  const tone={not_set_up:'grey',connected:'green',broken:'red'}[st]||'grey';
  const t=c.test;
  const test=t?(t.ok?`<p class="tk-status green">${esc('It works. CheapInboxes answered'+(t.account?' as '+t.account:'')+'.')}</p>`:`<p class="tk-status red">${esc("The test didn't work: "+(t.error||'no answer'))}</p>`):'';
  const card=on&&data.hasPaymentMethod!=null?(tkTruthy(data.hasPaymentMethod)
    ?'<p class="tk-set-text">A card is on file. What you buy on CheapInboxes is charged to it.</p>'
    :'<p class="tk-ab-warn">No card on file yet. Add a card in your CheapInboxes account under Billing.</p>'):'';
  const news=st==='connected'&&String(data.webhook||'')==='missing'?'<p class="tk-set-text">Instant updates from CheapInboxes are off, so we look for changes every few minutes instead. To turn them on, paste your key again and press Save.</p>':'';
  const acts=on?`<div class="tk-set-links tk-gm-acts"><button type="button" class="btn" onclick="abTest(this)">Test it</button><button type="button" class="btn ghost" onclick="abForget(this)">Forget the key</button></div>`:'';
  const steps=renderAutobuySteps(data);
  const setup=st==='not_set_up'||!S?steps:`<details class="tk-gm-more"><summary>The set-up steps, and changing your key</summary>${steps}</details>`;
  return {state,body:`<p class="tk-status ${tone}">${esc(say)}</p>${test}${card}${news}${acts}${renderAutobuyUnmatched(data.unmatched,c.trials)}${setup}`};
}

/* ===================== 3. LOADERS ===================== */
async function loadCheapInboxes(force){
  if(!force&&abState.s&&Date.now()-abState.sAt<AB_FRESH_MS)return {ok:true,data:abState.s};
  if(abState.sBusy)return abState.sBusy;
  const p=machineFetch('/api/mc/cheapinboxes').then(r=>{
    abState.sBusy=null;
    if(r.ok&&r.data&&typeof r.data==='object'&&r.data.status){abState.s=r.data;abState.sAt=Date.now();abState.sErr=null;}
    else{abState.sErr=r.error||"We couldn't check CheapInboxes. Try again. (For your developer: no \"status\" in the answer.)";if(r.ok)r.ok=false;}
    return r;
  });
  abState.sBusy=p;return p;
}
/* The trials "This is for…" offers: those in the Setting-up step, still waiting for their domain. */
function abSetupTrials(){return tkListRows(tk.hub).filter(r=>tkSimple(r).step==='setting_up').map(r=>({id:String(r.id),company:tkSimple(r).company}))}
function abSettingsCtx(){return {data:abState.s,err:abState.sErr,test:abState.test,trials:abSetupTrials()}}

/* ===================== 4. ACTIONS ===================== */
/* Every post goes through here: one at a time (a second click while the first is on its way sends nothing),
   the pressed button greyed out until the answer is in. */
async function abSend(path,body,opts,btn){
  opts=opts||{};
  if(abState.busy){toast('Still working on the last one…');return {ok:false,busy:true};}
  if(opts.confirm&&typeof confirm==='function'&&!confirm(opts.confirm))return {ok:false,cancelled:true};
  abState.busy=true;if(btn)btn.disabled=true;
  try{return await trialPost(path,body,{done:opts.done,fail:opts.fail||'That did not work',reload:false});}
  finally{abState.busy=false;if(btn)btn.disabled=false;}
}
/* The answer's `autobuy` replaces the cached one at once; the rest of the page and the list refresh quietly behind it. */
function abStore(id,data){if(data&&data.autobuy&&typeof data.autobuy==='object'&&tk.detail[id])tk.detail[id]=Object.assign({},tk.detail[id],{autobuy:data.autobuy});}
function abRepaint(id){
  if(currentView!=='trial'||currentTrialId!==id)return;const d=tk.detail[id];if(!d)return;
  const top=document.getElementById('tkTop');if(top)top.outerHTML=renderTrialTop(d,{now:new Date()});
  const host=document.getElementById('tkAbHost');if(host)host.innerHTML=renderAutobuyCard(d);
}
async function abPost(id,body,opts,btn){
  id=String(id);const r=await abSend(abPath(id),body,opts,btn);
  if(r&&r.ok){
    abStore(id,r.data);abRepaint(id);abRepaintBuy(id);
    Promise.all([loadTrial(id,true),loadHub(true)]).then(()=>{trialsRepaint('trial',{soft:true});try{renderNav();updateNotifBadge();}catch(e){}});
  }
  return r;
}
/* -- the "what to buy" panel -- */
function abOpenBuy(id){
  id=String(id);const ab=tkAutobuy(tk.detail[id]);
  if(!ab||!ab.toBuy){toast("This trial isn't waiting for a domain right now");return;}
  abState.open=id;openModal(renderAutobuyBuy(tk.detail[id]));
}
function abCloseBuy(){abState.open=null;closeModal();}
function abBuyIsOpen(){try{const w=document.getElementById('modalWrap');return !!(w&&w.classList.contains('open')&&document.getElementById('abBuy'));}catch(e){return false}}
/* Redraw the open panel from the fresh answer; once the purchase is found there is nothing left to buy: it closes. */
function abRepaintBuy(id){
  if(abState.open!==id||!abBuyIsOpen())return;
  const ab=tkAutobuy(tk.detail[id]);
  if(ab&&ab.toBuy)openModal(renderAutobuyBuy(tk.detail[id]));else abCloseBuy();
}
function abCopy(v){
  v=String(v==null?'':v);if(!v)return;
  const byHand=()=>toast("Couldn't copy — select it and copy it by hand");
  try{navigator.clipboard.writeText(v).then(()=>toast('Copied: '+v),byHand);}catch(e){byHand();}
}
/* Buy another of the listed free names instead: only the shopping list changes (nothing is bought). */
function abPick(id,domain,btn){
  domain=String(domain||'');
  return abPost(id,{action:'pick',domain},{done:'Changed. Buy '+domain+' instead',fail:'Not changed'},btn);
}
function abRecheckText(data){
  const ab=tkAutobuy({autobuy:data&&data.autobuy});
  if(!ab)return 'Checked';
  if(ab.status==='ready_to_buy')return "We don't see the purchase yet. It can take a few minutes to show up — we keep looking by ourselves";
  if(ab.status==='failed')return 'Checked. The problem is still there — see the card';
  return 'Found it'+(ab.label?'. '+ab.label.replace(/[.\s]+$/,''):'');
}
function abRecheck(id,btn){return abPost(id,{action:'recheck'},{done:abRecheckText,fail:"Couldn't check"},btn)}
function abUnlink(id,btn){
  const ab=tkAutobuy(tk.detail[String(id)]);const dom=(ab&&ab.domain)||'This domain';
  return abPost(id,{action:'unlink'},{confirm:'Undo? '+dom+' will no longer be linked to '+tkOcName(String(id))+". Do this only if it isn't their domain. Nothing is deleted at CheapInboxes.",done:'Undone. '+dom+' is no longer linked to them',fail:'Not undone'},btn);
}

/* -- Settings › Inboxes & domains -- */
function abSetRetry(){return loadCheapInboxes(true).then(()=>trialsRepaint('settings'))}
async function abSetAfter(){await loadCheapInboxes(true);trialsRepaint('settings');}
function abSetPost(body,opts,btn){tk.setOpen.inboxes=true;return abSend('/api/mc/cheapinboxes',body,opts,btn)}
async function abSaveKey(btn){
  const i=document.getElementById('abKey');const apiKey=String((i&&i.value)||'').trim();
  if(!apiKey){toast('Paste your API key first');return {ok:false};}
  if(!/^ci_[A-Za-z0-9]/.test(apiKey)){toast("That isn't a CheapInboxes API key — it starts with ci_live_. Copy it again from CheapInboxes.");return {ok:false};}
  const r=await abSetPost({action:'saveKey',apiKey},{done:'Saved. Now press Test it.',fail:'Not saved'},btn);
  if(r&&r.ok){if(i)i.value='';abState.test=null;await abSetAfter();}   // never kept on the page once it is saved
  return r;
}
async function abTest(btn){
  const r=await abSetPost({action:'test'},{done:'It works',fail:"The test didn't work"},btn);
  if(r&&(r.cancelled||r.busy))return r;
  const d=(r&&r.data)||{};
  abState.test=r&&r.ok?{ok:true,account:String(d.account||'')}:{ok:false,error:(r&&r.error)||'no answer'};
  await abSetAfter();   // a failed test can mean the key stopped working: show the fresh status with it
  return r;
}
async function abForget(btn){
  const r=await abSetPost({action:'forget'},{confirm:"Forget your CheapInboxes key? We stop finding and setting up new purchases until you paste it again. Nothing is deleted at CheapInboxes.",done:'The key is forgotten',fail:'Not forgotten'},btn);
  if(r&&r.ok){abState.test=null;await abSetAfter();}
  return r;
}
/* A purchase we couldn't match: this domain is that trial's. */
async function abLink(domain,selId,btn){
  domain=String(domain||'');const s=document.getElementById(selId);const id=String((s&&s.value)||'');
  if(!id){toast('Pick the trial it is for first');return {ok:false};}
  const name=tkSimple(tkFindRow(id)||{id}).company;
  const r=await abSend(abPath(id),{action:'link',domain},{confirm:'Link '+domain+' to '+name+'? We start setting it up for them right away.',done:'Linked. We set up '+domain+' for '+name+' now',fail:'Not linked'},btn);
  if(r&&r.ok){abStore(id,r.data);tk.setOpen.inboxes=true;await Promise.all([loadCheapInboxes(true),loadHub(true)]);trialsRepaint('settings');try{renderNav();updateNotifBadge();}catch(e){}}
  return r;
}

/* ===================== 5. SHELL INTEGRATION ===================== */
function autobuyForget(){Object.assign(abState,{s:null,sAt:0,sErr:null,sBusy:null,test:null,busy:false,open:null});}
