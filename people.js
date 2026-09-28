/* ===================== People inside =====================
   The team in the hub. Two parts:
   1. Presence (everyone signed in): the hub tells the machine when someone signs in, which page they open, that they
      are still there (every minute while the page is in front of them) and when they sign out —
      POST /api/mc/presence (email-distributor docs/HUB-API.md "People inside"). Identity comes from the sign-in
      token on the machine, never from here.
   2. The People inside page (the owner only): who is online now, when each person signed in and out, how long they
      spent, what they are looking at, the activity list, and the accounts waiting for the owner's approval
      (Supabase `profiles`: a team member signs up on the sign-in page; approved = false until the owner says yes). */

const pp={people:null,events:null,at:0,err:null,pending:[],pendingAt:0,filter:null,beat:null,lastView:null,lastViewAt:0,viewTimer:null};
const PP_BEAT_MS=60000;

/* ---- presence ---- */
function ppPost(body,opts){try{return machineFetch('/api/mc/presence',Object.assign({method:'POST',body,timeout:8000},opts||{})).catch(()=>null);}catch(e){return Promise.resolve(null)}}
function ppViewKey(v){if(v==='trial'){return typeof MY_STATS_ID!=='undefined'&&currentTrialId===MY_STATS_ID?'mystats':'trial:'+String(currentTrialId||'').slice(0,50);}return String(v||'').slice(0,60)}
function peopleSignedIn(){
  if(typeof authUser==='undefined'||!authUser)return;
  ppPost({event:'signin',name:authUser.name||'',view:ppViewKey(typeof currentView!=='undefined'?currentView:'')});
  if(pp.beat)clearInterval(pp.beat);
  pp.beat=setInterval(()=>{if(!authUser)return;if(typeof document!=='undefined'&&document.hidden)return;ppPost({event:'active',view:ppViewKey(currentView)});},PP_BEAT_MS);
  if(hubIsOwner())peopleLoadPending();
}
function peopleOnRender(v){
  if(typeof authUser==='undefined'||!authUser)return;
  if(v==='people')peopleKick(true);
  if(v==='team')teamKick(true);
  // one "view" per page opened, a moment after it settles (tapping through pages quickly sends only the last)
  if(pp.viewTimer)clearTimeout(pp.viewTimer);
  pp.viewTimer=setTimeout(()=>{const k=ppViewKey(v);if(k===pp.lastView&&Date.now()-pp.lastViewAt<60000)return;pp.lastView=k;pp.lastViewAt=Date.now();ppPost({event:'view',view:k});},1200);
}
async function peopleSignOut(){
  if(pp.beat){clearInterval(pp.beat);pp.beat=null;}
  if(pp.viewTimer){clearTimeout(pp.viewTimer);pp.viewTimer=null;}
  await Promise.race([ppPost({event:'signout',view:ppViewKey(currentView)}),new Promise(r=>setTimeout(r,2500))]);
  Object.assign(pp,{people:null,events:null,at:0,err:null,pending:[],pendingAt:0,filter:null,lastView:null});
  if(typeof tm!=='undefined')Object.assign(tm,{data:null,at:0,err:null});
}

/* ---- accounts waiting for approval (Supabase profiles; the owner's session may read and change them) ---- */
async function peopleLoadPending(){
  try{
    const {data,error}=await sb.from('profiles').select('*');
    if(error)throw error;
    pp.pending=(data||[]).filter(p=>!p.approved&&p.role!=='admin');pp.pendingAt=Date.now();
    pp.team=(data||[]).filter(p=>p.approved);
  }catch(e){pp.pending=[];}
  try{renderNav();}catch(e){}
  if(currentView==='people')peopleRepaint();
}
function peopleNavCount(){return hubIsOwner()&&pp.pending&&pp.pending.length?pp.pending.length:''}
async function peopleApprove(id){
  const p=(pp.pending||[]).find(x=>String(x.id)===String(id));if(!p)return;
  if(typeof confirm==='function'&&!confirm(`Let ${p.name||p.email} into the hub? They can see everything, and change nothing.`))return;
  const nums=(pp.team||[]).map(x=>Number(x.emp_no)).filter(n=>Number.isFinite(n));const next=(nums.length?Math.max(...nums):0)+1;
  const {error}=await sb.from('profiles').update({approved:true,role:'employee',emp_no:next}).eq('id',p.id);
  if(error){toast('Could not approve: '+(error.message||'try again'));return;}
  toast(`${p.name||p.email} can sign in now`);await peopleLoadPending();
}
async function peopleRemove(id){
  const p=(pp.pending||[]).concat(pp.team||[]).find(x=>String(x.id)===String(id));if(!p)return;
  if(typeof confirm==='function'&&!confirm(`Remove ${p.name||p.email}? They can't sign in any more.`))return;
  const {error}=await sb.from('profiles').delete().eq('id',p.id);
  if(error){toast('Could not remove: '+(error.message||'try again'));return;}
  toast(`${p.name||p.email} removed`);await peopleLoadPending();peopleKick(true);
}

/* ---- the page ---- */
async function peopleKick(force){
  if(!hubIsOwner())return;
  if(!force&&pp.people&&Date.now()-pp.at<30000)return;
  const r=await machineFetch('/api/mc/people');
  if(r&&r.ok&&r.data&&Array.isArray(r.data.people)){pp.people=r.data.people;pp.events=r.data.events||[];pp.at=Date.now();pp.err=null;}
  else pp.err=(r&&r.error)||"The list didn't load. Try again.";
  if(!pp.pendingAt||force)await peopleLoadPending();
  // client names for "Looking at" (the board is usually loaded already)
  if(typeof tk!=='undefined'&&!tk.hub&&typeof loadHub==='function')await loadHub(false).catch(()=>null);
  peopleRepaint();
}
function peopleRepaint(){if(currentView!=='people')return;const h=document.getElementById('ppHost');if(h)h.innerHTML=renderPeople();}
function viewPeople(){if(!hubIsOwner())return trialsNotAdminHTML();peopleKick(false);return `<div id="ppHost">${renderPeople()}</div>`}
function peopleFilter(uid){pp.filter=pp.filter===uid?null:uid;peopleRepaint()}

function ppTime(v){const d=tkParseDate(v);if(!d)return '—';const now=new Date();const same=d.toDateString()===now.toDateString();const y=new Date(now);y.setDate(now.getDate()-1);
  const t=d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  if(same)return 'Today '+t;if(d.toDateString()===y.toDateString())return 'Yesterday '+t;return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' '+t}
function ppAgo(v){const d=tkParseDate(v);if(!d)return '';const s=Math.max(0,(Date.now()-d.getTime())/1000);if(s<90)return 'just now';if(s<3600)return Math.round(s/60)+' min ago';if(s<86400)return Math.round(s/3600)+' h ago';return Math.round(s/86400)+' d ago'}
function ppDur(sec){sec=Number(sec)||0;if(sec<60)return sec?'<1 min':'—';const h=Math.floor(sec/3600),m=Math.round((sec%3600)/60);return h?`${h} h ${m} min`:`${m} min`}
function ppPlace(k){
  k=String(k||'');if(!k)return '—';
  const names={team:'Team',trials:'Trials',paying:'Paying clients',calendar:'Calendar',mystats:'My stats',settings:'Settings',people:'Activity',inquiries:'Plan call requests',inquiry:'A plan call request',trialsBoard:'Behind the scenes',trialPurchase:'A purchase page'};
  if(names[k])return names[k];
  if(k.indexOf('trial:')===0){const id=k.slice(6);const r=typeof tkFindRow==='function'?tkFindRow(id):null;return (r&&(r.name||(r.simple&&r.simple.company)))||('the page of '+id);}
  return k;
}
function ppInitials(n){return String(n||'?').trim().split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase()||'?'}
function ppEventText(e){
  switch(e.event){
    case 'signin':return 'signed in';
    case 'signout':return 'signed out';
    case 'view':return 'opened '+ppPlace(e.view);
    default:return String(e.event||'');
  }
}
function renderPeople(){
  const people=pp.people||[],events=pp.events||[],pending=pp.pending||[];
  if(!pp.people&&!pp.err)return renderLoading('Loading who is inside…');
  const online=people.filter(p=>p.online).length;
  const summary=`<div class="pp-summary">
    <div><b>${online}</b><span>Online now</span></div>
    <div><b>${people.length}</b><span>${people.length===1?'Person':'People'} with access</span></div>
    <div><b>${pending.length}</b><span>Waiting for your approval</span></div>
  </div>`;
  const wait=pending.length?`<div class="section-head tk-section"><h3>Waiting for your approval</h3><span class="count">${pending.length}</span></div>
    <div class="pp-list">${pending.map(p=>`<div class="pp-row"><span class="pp-av">${esc(ppInitials(p.name||p.email))}</span><span class="pp-who"><b>${esc(p.name||'—')}</b><small>${esc(p.email||'')}${p.created_at?' · asked '+esc(ppAgo(p.created_at)):''}</small></span>
      <span class="pp-acts"><button class="btn" onclick="peopleApprove(${tkAttr(p.id)})">Approve</button><button class="btn ghost" onclick="peopleRemove(${tkAttr(p.id)})">Remove</button></span></div>`).join('')}</div>`:'';
  const err=pp.err?`<div class="card tk-pad tk-muted">${esc(pp.err)} <button class="btn ghost" onclick="peopleKick(true)">Try again</button></div>`:'';
  const table=people.length?`<div class="section-head tk-section"><h3>Everyone with access</h3><span class="tk-muted tk-small">Tap a person to see only their activity</span></div>
    <div class="card pp-table-card"><div class="tk-scroll"><table class="tk-table pp-table">
      <tr><th>Person</th><th>Status</th><th>Signed in</th><th>Signed out</th><th>Today</th><th>In total</th><th>Looking at</th></tr>
      ${people.map(p=>`<tr class="pp-tr${pp.filter===p.uid?' on':''}" onclick="peopleFilter(${tkAttr(p.uid)})">
        <td><span class="pp-person"><span class="pp-av">${esc(ppInitials(p.name||p.email))}</span><span class="pp-who"><b>${esc(p.name||p.email||'—')}</b><small>${esc(p.role==='admin'?'Owner':'Team')} · ${esc(p.email||'')}</small></span></span></td>
        <td>${p.online?'<span class="pp-dot on"></span>Online now':`<span class="pp-dot"></span>${esc(p.lastSeen?'Seen '+ppAgo(p.lastSeen):'Never')}`}</td>
        <td>${esc(ppTime(p.lastSignIn))}</td>
        <td>${esc(p.online&&(!p.lastSignOut||p.lastSignOut<p.lastSignIn)?'Still in':ppTime(p.lastSignOut))}</td>
        <td>${esc(ppDur(p.activeSecondsToday))}</td>
        <td>${esc(ppDur(p.activeSecondsTotal))}</td>
        <td>${esc(p.online?ppPlace(p.lastView):'—')}</td>
      </tr>`).join('')}
    </table></div></div>`:(pp.people?`<div class="tk-allclear">Nobody has signed in yet. When your team makes an account on the sign-in page, it waits here for your approval.</div>`:'');
  const who=pp.filter?people.find(p=>p.uid===pp.filter):null;
  const evs=events.filter(e=>!pp.filter||e.uid===pp.filter).slice(0,200);
  const byDay=[];evs.forEach(e=>{const d=tkParseDate(e.at);const k=d?d.toDateString():'';let g=byDay.find(x=>x.k===k);if(!g){g={k,label:d?(k===new Date().toDateString()?'Today':d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})):'',xs:[]};byDay.push(g);}g.xs.push(e);});
  const feed=`<div class="section-head tk-section"><h3>Activity${who?' — '+esc(who.name||who.email):''}</h3>${who?`<button class="btn ghost" onclick="peopleFilter(null)">Everyone</button>`:''}</div>
    ${evs.length?`<div class="card pp-feed">${byDay.map(g=>`<div class="pp-day">${esc(g.label)}</div>${g.xs.map(e=>`<div class="pp-ev pp-${esc(e.event)}"><span class="pp-ev-time">${esc(tkParseDate(e.at)?tkParseDate(e.at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}):'')}</span><span class="pp-ev-dot"></span><span><b>${esc(e.name||e.email||'Someone')}</b> ${esc(ppEventText(e))}</span></div>`).join('')}`).join('')}</div>`:'<div class="tk-allclear">No activity yet.</div>'}`;
  return summary+wait+err+table+feed;
}

/* ===================== Team =====================
   Everyone who uses the hub: online or not, where they are in the hub right now, what they are working on (a line
   each person writes about themselves) and which clients they look after (the owner chooses). GET/POST /api/mc/team. */
const tm={data:null,at:0,err:null,busy:false};
async function teamKick(force){
  if(!force&&tm.data&&Date.now()-tm.at<30000)return;
  const r=await machineFetch('/api/mc/team');
  if(r&&r.ok&&r.data&&Array.isArray(r.data.team)){tm.data=r.data;tm.at=Date.now();tm.err=null;}
  else tm.err=(r&&r.error)||"The team didn't load. Try again.";
  if(typeof tk!=='undefined'&&!tk.hub&&typeof loadHub==='function')await loadHub(false).catch(()=>null);
  teamRepaint();
}
function teamRepaint(){if(currentView==='trials'||currentView==='paying'){try{trialsRepaint(currentView,{soft:true});}catch(e){}return;}if(currentView!=='team')return;const h=document.getElementById('tmHost');if(h)h.innerHTML=renderTeam();}
function teamPageView(){if(!trialsIsAdmin())return trialsNotAdminHTML();teamKick(false);return `<div id="tmHost">${renderTeam()}</div>`}
function teamMe(){return tm.data&&authUser?(tm.data.team||[]).find(p=>p.uid===authUser.uid):null}
async function teamSaveStatus(){
  const i=document.getElementById('tmStatus');const text=i?i.value:'';
  const r=await machineFetch('/api/mc/team',{method:'POST',body:{action:'status',text}});
  if(r&&r.ok){toast(text.trim()?'Your status is saved':'Your status is cleared');await teamKick(true);}else toast('Not saved: '+((r&&r.error)||'try again'));
}
/* A made-up client from the test run (trials.js tkIsDemo): the same small "Test" tag as everywhere else. */
function teamTestPill(c){return c&&(c.demo||(typeof tkIsDemoId==='function'&&tkIsDemoId(c.id)))?' <span class="pill tk-test">Test</span>':''}
function teamClients(){return (typeof tkListRows==='function'&&typeof tk!=='undefined'&&tk.hub?tkListRows(tk.hub):[]).map(r=>({id:r.id,name:r.name||(r.simple&&r.simple.company)||r.id,paid:typeof tkIsPaidRow==='function'&&tkIsPaidRow(r),demo:typeof tkIsDemo==='function'&&tkIsDemo(r)})).sort((a,b)=>a.name.localeCompare(b.name))}
function teamOpenAssign(uid){
  if(!hubIsOwner()||!tm.data)return;const p=(tm.data.team||[]).find(x=>x.uid===uid);if(!p)return;
  const owners=tm.data.owners||{};const list=teamClients();
  openModal(`<div class="modal-head"><div><h3>Clients ${esc(p.name||p.email)} looks after</h3><p>Tick the clients they take care of. Everyone sees this on the Team page.</p></div></div>
    <div class="modal-body tm-pick">${list.length?list.map(c=>`<label class="tm-check"><input type="checkbox" data-tm-client="${esc(c.id)}"${(owners[c.id]||[]).includes(uid)?' checked':''}><span>${esc(c.name)}${teamTestPill(c)}</span><small>${c.paid?'Paying':'Trial'}</small></label>`).join(''):'<p class="tk-muted">No clients yet.</p>'}</div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" onclick="teamSaveAssign(${tkAttr(uid)})">Save</button></div>`);
}
async function teamSaveAssign(uid){
  const owners=(tm.data&&tm.data.owners)||{};const boxes=[...(document.querySelectorAll?document.querySelectorAll('[data-tm-client]'):[])];
  const calls=[];
  for(const b of boxes){const id=b.getAttribute('data-tm-client');const cur=owners[id]||[];const has=cur.includes(uid);
    if(b.checked&&!has)calls.push({clientId:id,uids:cur.concat(uid)});
    else if(!b.checked&&has)calls.push({clientId:id,uids:cur.filter(u=>u!==uid)});}
  for(const c of calls){const r=await machineFetch('/api/mc/team',{method:'POST',body:Object.assign({action:'assign'},c)});if(!(r&&r.ok)){toast('Not saved: '+((r&&r.error)||'try again'));break;}}
  closeModal();toast('Saved');await teamKick(true);
}
function renderTeam(){
  if(!tm.data&&!tm.err)return renderLoading('Loading the team…');
  if(!tm.data)return `<div class="card tk-pad tk-muted">${esc(tm.err)} <button class="btn ghost" onclick="teamKick(true)">Try again</button></div>`;
  const team=tm.data.team||[];const me=teamMe();const owner=hubIsOwner();
  const mine=`<div class="card tm-me"><label for="tmStatus"><b>What are you working on?</b></label>
    <div class="tm-me-row"><input id="tmStatus" maxlength="140" placeholder="e.g. Writing the emails for Birch Legal" value="${esc(me&&me.status?me.status.text:'')}" onkeydown="if(event.key==='Enter')teamSaveStatus()"><button class="btn ro-ok" onclick="teamSaveStatus()">Save</button></div></div>`;
  const online=team.filter(p=>p.online).length;
  const cards=team.length?`<div class="tm-grid">${team.map(p=>`<div class="card tm-card${p.online?' on':''}">
      <div class="tm-top"><span class="pp-av">${esc(ppInitials(p.name||p.email))}</span><span class="pp-who"><b>${esc(p.name||p.email)}</b><small>${esc(p.role==='admin'?'Owner':'Team')}</small></span>
        <span class="tm-state">${p.online?'<span class="pp-dot on"></span>In the hub':`<span class="pp-dot"></span>${esc(p.lastSeen?'Seen '+ppAgo(p.lastSeen):'Not in yet')}`}</span></div>
      <div class="tm-line"><small>Working on</small><span>${p.status?esc(p.status.text)+`<em> · ${esc(ppAgo(p.status.at))}</em>`:'<span class="tk-muted">Nothing written yet</span>'}</span></div>
      <div class="tm-line"><small>Where</small><span>${p.online?esc(ppPlace(p.lastView)):'<span class="tk-muted">Not in the hub</span>'}</span></div>
      <div class="tm-line"><small>Looks after</small><span class="tm-clients">${p.clients&&p.clients.length?p.clients.map(c=>`<button type="button" class="tm-chip" onclick="openTrial(${tkAttr(c.id)})">${esc(c.name)}${teamTestPill(c)}</button>`).join(''):'<span class="tk-muted">No clients yet</span>'}</span></div>
      ${owner?`<div class="tm-foot"><button class="btn ghost" onclick="teamOpenAssign(${tkAttr(p.uid)})">Choose clients</button></div>`:''}
    </div>`).join('')}</div>`:`<div class="tk-allclear">Nobody has signed in yet.</div>`;
  const free=teamClients().filter(c=>!((tm.data.owners||{})[c.id]||[]).length);
  const unassigned=owner&&free.length?`<div class="section-head tk-section"><h3>Nobody looks after these yet</h3><span class="count">${free.length}</span></div><div class="tm-clients tm-free">${free.map(c=>`<button type="button" class="tm-chip" onclick="openTrial(${tkAttr(c.id)})">${esc(c.name)}${teamTestPill(c)}</button>`).join('')}</div>`:'';
  return mine+`<div class="section-head tk-section"><h3>The team</h3><span class="count">${online} in the hub now</span></div>`+cards+unassigned;
}
