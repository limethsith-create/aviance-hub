/* Settings › Advanced › "Remove test data" (owner only). Never runs by itself.
   Step 1: the system lists what is clearly test data and WHY each item matched (POST /api/mc/cleanup {action:'preview'}).
   Step 2: the owner ticks what to remove, confirms, and the system answers what went (action:'apply').
   Items not ticked by default: ones that only matched by name or address (the owner decides).
   Loaded after trials.js: reuses machineFetch, openModal, closeModal, toast, esc, tkAttr. */
const cln={items:[],checked:{},stage:'idle',result:null,error:''};

function clnKey(it){return it.kind+':'+it.id}
function clnGroups(){return [['client','Test clients'],['booking','Test bookings'],['keys','Leftover records']]}

function renderCleanupItem(it,checked){
  const k=clnKey(it);
  const why=(it.reasons||[]).map(r=>`<li>${esc(r)}</li>`).join('');
  return `<label class="cln-item"><input type="checkbox" ${checked?'checked':''} onchange="clnToggle(${tkAttr(k)},this.checked)"> <span><b>${esc(it.label||it.id)}</b>${it.detail?` <span class="muted">${esc(it.detail)}</span>`:''}<br><span class="muted">Why: </span><ul class="cln-why">${why}</ul>${it.strong?'':'<span class="muted">Only matched by name or address, so it is not ticked. Check it first.</span>'}</span></label>`;
}

function renderCleanup(){
  const head=`<div class="modal-h"><b>Remove test data</b></div>`;
  const foot=(inner)=>`<div class="modal-f">${inner}</div>`;
  if(cln.stage==='loading')return head+`<div class="modal-b"><p>Looking for test data. Nothing is removed yet.</p></div>`;
  if(cln.stage==='error')return head+`<div class="modal-b"><p class="cln-err">${esc(cln.error||'That did not go through.')}</p></div>`+foot(`<button type="button" class="btn ghost" onclick="closeModal()">Close</button><button type="button" class="btn" onclick="openCleanup()">Try again</button>`);
  if(cln.stage==='done'){
    const r=cln.result||{};const rem=r.removed||[],sk=r.skipped||[];
    return head+`<div class="modal-b"><p><b>${rem.length}</b> removed${sk.length?`, <b>${sk.length}</b> left alone`:''}.</p>`+
      (rem.length?`<ul>${rem.map(x=>`<li>${esc(x.label||x.id)} <span class="muted">(${esc(x.kind==='client'?'client':x.kind==='booking'?'booking':'records')})</span></li>`).join('')}</ul>`:'')+
      (sk.length?`<p class="muted">Left alone:</p><ul>${sk.map(x=>`<li>${esc(x.id)}: ${esc(x.why)}</li>`).join('')}</ul>`:'')+`</div>`+foot(`<button type="button" class="btn" onclick="closeModal()">Done</button>`);
  }
  if(cln.stage==='confirm'){
    const n=Object.keys(cln.checked).filter(k=>cln.checked[k]).length;
    return head+`<div class="modal-b"><p>Remove <b>${n}</b> test item${n===1?'':'s'} for good? This cannot be undone.</p></div>`+foot(`<button type="button" class="btn ghost" onclick="clnBack()">Back</button><button type="button" class="btn danger" onclick="clnApply()">Remove them</button>`);
  }
  if(!cln.items.length)return head+`<div class="modal-b"><p><b>No test data found.</b></p><p class="muted">Nothing needs removing.</p></div>`+foot(`<button type="button" class="btn" onclick="closeModal()">Close</button>`);
  const body=clnGroups().map(([kind,title])=>{const rows=cln.items.filter(i=>i.kind===kind);return rows.length?`<h4>${esc(title)}</h4>`+rows.map(it=>renderCleanupItem(it,!!cln.checked[clnKey(it)])).join(''):''}).join('');
  const n=Object.keys(cln.checked).filter(k=>cln.checked[k]).length;
  return head+`<div class="modal-b"><p class="muted">These look like test data. Tick what to remove. Real clients are never listed.</p>${body}</div>`+foot(`<button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button type="button" class="btn danger" ${n?'':'disabled'} onclick="clnAsk()">Remove ${n} ticked</button>`);
}

function clnPaint(){openModal(renderCleanup())}
function clnToggle(k,on){cln.checked[k]=!!on;clnPaint()}
function clnAsk(){if(Object.keys(cln.checked).some(k=>cln.checked[k])){cln.stage='confirm';clnPaint()}}
function clnBack(){cln.stage='list';clnPaint()}

async function openCleanup(){
  cln.stage='loading';clnPaint();
  const r=await machineFetch('/api/mc/cleanup',{method:'POST',body:{action:'preview'}});
  const d=r&&r.data;
  if(!(r&&r.ok&&d&&d.ok)){cln.stage='error';cln.error=(r&&r.error)||(d&&d.error)||'That did not go through.';clnPaint();return}
  cln.items=[].concat(d.clients||[],d.bookings||[],d.keys||[]);
  cln.checked={};cln.items.forEach(it=>{if(it.strong)cln.checked[clnKey(it)]=true});
  cln.stage='list';clnPaint();
}

async function clnApply(){
  const ids=Object.keys(cln.checked).filter(k=>cln.checked[k]);
  cln.stage='loading';clnPaint();
  const r=await machineFetch('/api/mc/cleanup',{method:'POST',body:{action:'apply',ids}});
  const d=r&&r.data;
  if(!(r&&r.ok&&d&&d.ok)){cln.stage='error';cln.error=(r&&r.error)||(d&&d.error)||'That did not go through.';clnPaint();return}
  cln.result=d;cln.stage='done';clnPaint();
  if(typeof loadHub==='function')try{loadHub()}catch(e){}
}
