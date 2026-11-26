/* ===================== AVIANCE OS — Documents (everything a client receives) =====================
   One screen with a live preview of every email, document and chat message that goes out to a client:
   the discovery-call emails (confirmation + 3 reminders), the agreement / invoice / receipt for each of
   the 3 plans on offer (month to month and on a 3-month term), the pack and welcome emails, and every
   bot / step message in the 14-day journey.

   Data: documents_preview() (20261129_no_pilot_and_agreement_v3.sql, owner only). It runs the real flow
   for a sample client on each plan and term inside a rolled-back transaction, so what you see is exactly what the
   system would send today, with your current Settings and templates. Nothing is kept or sent.
   Returns [{group, key, type: email|agreement|invoice|chat|error, title, subject?, text?, html?, doc?, meta?}].

   Data functions (dc*) resolve to {ok, data, error} and never throw. Views only return HTML. */

/* ===================== 0. STATE ===================== */
const dc={items:[],loaded:false,loading:false,err:null,pick:null,seq:0};
const DC_GROUP_ORDER=['Discovery call','Emails — Starter','Emails — Starter (3 months)','Emails — Growth','Emails — Growth (3 months)',
  'Emails — Scale','Emails — Scale (3 months)','Agreements','Invoices','Receipts','Chat messages','Problems'];
/* Three plans are on offer: Starter, Growth, Scale. A database that has not had its
   latest update may still send a pack for the retired one-off plan; anything that
   names it (group, key, title or meta.plan) is left out, so the owner is never shown
   a document that can no longer be sold. */
function dcRetired(x){
  const o=x||{};
  if(String((o.meta&&o.meta.plan)||'').toLowerCase()==='pilot')return true;
  return /(^|[^a-z])pilot([^a-z]|$)/i.test([o.group,o.title].join(' | '))||/(^|_)pilot(_|$)/i.test(String(o.key||''));
}
/* the order a client meets the chat messages in */
const DC_CHAT_ORDER=['welcome','offer:kickoff','form','step:kickoff','approval:icp','step:testing:doing','update','step:testing:done','approval:copy','offer:onboarding','step:onboarding','step:launch'];

/* ===================== 1. DATA ===================== */
function dcSb(){try{if(typeof sb!=='undefined'&&sb)return sb;}catch(e){}return (typeof window!=='undefined'&&window.sb)||null;}
async function dcFetch(){
  const s=dcSb();if(!s)return {ok:false,data:null,error:'Aviance is not ready yet. Please reload the page.'};
  try{
    const r=await s.rpc('documents_preview',{});
    if(r&&r.error){
      const m=String(r.error.message||'');
      return {ok:false,data:null,error:/failed to fetch|network/i.test(m)?"Can't reach Aviance right now. Check your connection and try again.":(r.error.code==='P0001'&&m?m:"The documents didn't load. Try again.")};
    }
    /* An answer that is not a list is not an empty preview. Turning null into []
       made a failed build read as "0 things a client receives", which is the one
       number this screen can never truthfully show. */
    if(!Array.isArray(r&&r.data))return {ok:false,data:null,error:"The documents didn't load. Try again."};
    return {ok:true,data:r.data,error:null};
  }catch(e){return {ok:false,data:null,error:"Can't reach Aviance right now. Check your connection and try again."};}
}
/* Sort + tidy what the database sent: the per-plan booking confirmation repeats the "Discovery call" one, so it goes. */
function dcPrepare(list){
  const items=(Array.isArray(list)?list:[]).filter(x=>x&&x.key&&x.title)
    .filter(x=>!(String(x.group||'').indexOf('Emails — ')===0&&/booking confirmation/i.test(x.title)))
    .filter(x=>!dcRetired(x));
  const chatKey=x=>{
    const m=x.meta||{};const k=String(x.key||'').replace(/^chat_/,'').replace(/_\d+$/,'');
    if(k==='offer')return 'offer:'+(/onboarding/i.test(x.title)?'onboarding':'kickoff');
    if(k==='approval')return 'approval:'+(m.kind||'');
    if(k==='step')return 'step:'+(m.step||'')+((m.step==='testing')?':'+(m.status||''):'');
    return k;
  };
  const rank=x=>{
    const g=DC_GROUP_ORDER.indexOf(x.group);const gi=g<0?DC_GROUP_ORDER.length:g;
    let i=0;if(x.group==='Chat messages'){const c=DC_CHAT_ORDER.indexOf(chatKey(x));i=c<0?99:c;}
    return gi*1000+i;
  };
  return items.map((x,n)=>({...x,_n:n})).sort((a,b)=>rank(a)-rank(b)||a._n-b._n);
}
async function dcLoad(force){
  if(dc.loading&&!force)return;
  dc.loading=true;const seq=++dc.seq;dcPaint();
  let r;
  /* dc.loading is the "already asking" guard. Left true after a failure the
     Refresh button stays disabled and dcLoad() refuses to ask again, so the
     screen is stuck until the whole app is reloaded. Cleared either way. */
  try{ r=await dcFetch(); }
  catch(e){ dc.loading=false; dc.err="The documents didn't load. Try again."; dcPaint(); return; }
  if(seq!==dc.seq){dc.loading=false;return;}
  dc.loading=false;
  if(r.ok){dc.items=dcPrepare(r.data);dc.loaded=true;dc.err=null;if(!dc.pick||!dc.items.some(x=>x.key===dc.pick))dc.pick=dc.items[0]?dc.items[0].key:null;}
  else dc.err=r.error;
  dcPaint();
}

/* ===================== 2. VIEW ===================== */
function dcA(v){return esc(JSON.stringify(v==null?'':String(v)));}
function viewDocuments(){
  if(!dc.loaded&&!dc.loading)setTimeout(()=>dcLoad(false),0);
  return `<div class="dc" id="dcRoot">${dcBodyHTML()}</div>`;
}
function dcBodyHTML(){
  if(!dc.loaded&&dc.err)return `<div class="card dc-empty" role="alert"><h3>The documents didn't load</h3><p>${esc(dc.err)}</p><button type="button" class="btn" onclick="dcLoad(true)">Try again</button></div>`;
  if(!dc.loaded)return `<div class="card dc-empty" role="status">Building a live preview of everything a client gets…</div>`;
  const groups=[];dc.items.forEach(x=>{let g=groups.find(y=>y.name===x.group);if(!g){g={name:x.group,items:[]};groups.push(g);}g.items.push(x);});
  const cur=dc.items.find(x=>x.key===dc.pick)||dc.items[0];
  return `<div class="dc-bar"><p class="dc-hint">${dc.items.length} things a client receives · built live from your current Settings and templates. Nothing here is sent.</p>
      <button type="button" class="btn ghost" onclick="dcLoad(true)"${dc.loading?' disabled':''}>${dc.loading?'Refreshing…':'Refresh'}</button></div>
    ${dc.err?`<div class="dc-err" role="alert">${esc(dc.err)}</div>`:''}
    <div class="dc-grid">
      <nav class="dc-list" aria-label="Documents">${groups.map(g=>`<div class="dc-group"><h3 class="dc-gname">${esc(g.name)}</h3>
        ${g.items.map(x=>`<button type="button" class="dc-item${cur&&x.key===cur.key?' on':''}${x.type==='error'?' bad':''}" onclick="dcPick(${dcA(x.key)})"${cur&&x.key===cur.key?' aria-current="true"':''}>
          <span class="dc-ititle">${esc(x.title)}</span>${x.subject?`<span class="dc-isub">${esc(x.subject)}</span>`:''}</button>`).join('')}</div>`).join('')}</nav>
      <section class="dc-view card" aria-live="polite">${cur?dcPreviewHTML(cur):'<p>Nothing to show.</p>'}</section>
    </div>`;
}
function dcPick(key){dc.pick=key;dcPaint();}
function dcPaint(){const r=typeof document!=='undefined'?document.getElementById('dcRoot'):null;if(r)r.innerHTML=dcBodyHTML();}
function dcKindLabel(t){return ({email:'Email',agreement:'Document',invoice:'Document',chat:'Chat message',error:'Problem'})[t]||'';}
function dcPreviewHTML(x){
  const head=`<header class="dc-vhead"><span class="dc-tag">${esc(dcKindLabel(x.type))}</span><h2 class="dc-vtitle">${esc(x.title)}</h2>
    ${x.subject?`<p class="dc-subj"><span>Subject</span> ${esc(x.subject)}</p>`:''}</header>`;
  if(x.type==='error')return head+`<p class="dc-err">${esc(x.text||'')}</p>`;
  if(x.type==='chat')return head+`<div class="dc-chat"><div class="dc-bubble">${esc(x.text||'')}</div>${dcChatExtra(x)}<p class="dc-note">Drafted by the bot · goes out only when you press Send in Replies.</p></div>`;
  if(x.type==='email'){
    if(x.html)return head+`<iframe class="dc-frame" title="${esc(x.title)}" sandbox="" srcdoc="${esc(x.html)}"></iframe>`;
    return head+`<pre class="dc-text">${esc(x.text||'')}</pre>`;
  }
  return head+dcPayNote(x)+`<iframe class="dc-frame tall" title="${esc(x.title)}" sandbox="allow-scripts" srcdoc="${esc(dcDocSrc(x))}"></iframe>`;
}
/* An invoice or receipt the owner is looking at: can it actually tell a client how to pay?
   The answer is in the same `pay` block portal-client.js renders, so this never guesses.
   Only the name of the method is shown — never an account number or a link. */
const DC_PAY_NAMES={bank_wire:'Bank transfer',wise:'Bank transfer (second account)',payoneer:'Payoneer',paypal:'PayPal',card_link:'Card or online checkout'};
function dcPayNote(x){
  const o=x||{};
  if(o.type!=='invoice')return '';
  const doc=o.doc||{};
  const pay=(doc.pay&&typeof doc.pay==='object')?doc.pay:null;
  if(!pay)return '';
  if(String(doc.status||'')==='paid')return '';
  const list=Array.isArray(pay.methods)?pay.methods.filter(m=>m&&m.kind):[];
  if(pay.ready===false||(!list.length&&!pay.wise_details&&!pay.payoneer_link)){
    return `<p class="dc-err" role="status">This invoice cannot tell a client how to pay. It says the details are coming. Settings → Payment details fixes it.</p>`;
  }
  const first=list.find(m=>m.kind===pay.preferred)||list[0];
  const name=first?(DC_PAY_NAMES[first.kind]||first.kind):'Bank transfer';
  const others=list.filter(m=>m!==first).map(m=>DC_PAY_NAMES[m.kind]||m.kind);
  return `<p class="dc-note">How to pay: <b>${esc(name)}</b> first${others.length?', then '+esc(others.join(', ')):''}. The values come from Settings when the client opens it.</p>`;
}
function dcChatExtra(x){
  const m=x.meta||{};
  if(Array.isArray(m.options))return `<div class="dc-chips">${m.options.map((o,i)=>`<span class="dc-chip">${i+1}) ${esc(o.label||o.starts_at||'')}</span>`).join('')}</div>`;
  if(m.body)return `<div class="dc-card"><b>${esc(m.title||'')}</b><p>${esc(m.body)}</p><span class="dc-chip">Approve</span> <span class="dc-chip">Ask for changes</span></div>`;
  if(m.form)return `<div class="dc-card"><b>4 quick questions</b><p>What you sell · your best customers · deal size · who to avoid</p></div>`;
  return '';
}
/* The client's own page renders the agreement / invoice: same CSS, same renderer (portal-client.js), no sign-in. */
function dcDocSrc(x){
  const data=JSON.stringify(x.doc||{}).replace(/</g,'\\u003c');
  const fn=x.type==='agreement'?'pcAgreementHtml':'pcInvoiceHtml';
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/portal-client.css"><script src="/portal-client.js"><\/script></head>
<body><div id="pcRoot"></div><script>try{document.getElementById('pcRoot').innerHTML=${fn}(${data});}catch(e){document.body.textContent='Preview failed: '+e.message;}<\/script></body></html>`;
}
function documentsForget(){Object.assign(dc,{items:[],loaded:false,loading:false,err:null,pick:null,seq:dc.seq+1});}
