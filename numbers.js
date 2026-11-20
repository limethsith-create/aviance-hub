/* ============================================================================
   numbers.js — Aviance Hub · a client's numbers (the portal "Numbers" panel)
   ----------------------------------------------------------------------------
   Contract: email-distributor CONTRACT.md "Numbers (Agent G)".
     GET /api/mc/portal/numbers?clientId=…  → {ok, client{name,plan,stage,stageWords}, today{sent,replies,interested,booked},
        days[30]{day,sent,replies,interested,booked}, totals{…,replyRate}, inboxes[{email,health good|warming|paused|problem,
        healthWords,warmupDay,warmupOf,sentToday,limit}], warmup{state,day,of,words}, next{words,at}, sources, updatedAt}
     (A client's own sign-in always gets their own business; the system ignores the query.)

   renderClientNumbers(el, clientId) draws into `el`, then refreshes every 60 s while `el` is still on the page.
   Used by the client's Numbers view (#numbers, authUser.clientId), the owner's client page ("Their numbers") and
   the Channels side panel. Mount points are `<div class="nm-host" data-nm-client="ID">`; numbersMountHosts() fills them.
   Rules as everywhere: every string through esc(); render functions are pure (they return HTML); nothing runs at load time.
   ========================================================================== */

const NM_REFRESH_MS=60000;
const NM_EMPTY='No emails sent yet — sending starts after warm-up';
const NM_TILES=[['sent','Sent today'],['replies','Replies'],['interested','Interested'],['booked','Booked']];
const NM_TONE={good:'green',warming:'amber',paused:'grey',problem:'red'};
const nm={timers:new WeakMap()};

function nmInt(v){const n=Number(v);return Number.isFinite(n)&&n>0?Math.round(n):0}
function nmFmt(n){return nmInt(n).toLocaleString('en-US')}
function nmPct(r){const n=Number(r);return Number.isFinite(n)?(Math.round(n*1000)/10)+'%':'0%'}
function nmDay(d){const t=Date.parse(String(d)+'T12:00:00Z');return Number.isFinite(t)?new Date(t).toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric'}):String(d||'')}

/* "Updated 2 min ago" */
function nmAgo(iso,now){
  const t=Date.parse(iso||'');if(!Number.isFinite(t))return '';
  const s=Math.max(0,Math.round(((now==null?Date.now():now)-t)/1000));
  if(s<45)return 'Updated just now';
  const m=Math.round(s/60);if(m<60)return 'Updated '+m+' min ago';
  const h=Math.round(m/60);if(h<24)return 'Updated '+h+(h===1?' hour ago':' hours ago');
  const d=Math.round(h/24);return 'Updated '+d+(d===1?' day ago':' days ago');
}

function nmSkeleton(){
  return '<div class="nm" aria-busy="true" aria-label="Loading your numbers"><div class="nm-tiles">'+NM_TILES.map(()=>'<div class="nm-tile nm-sk"><i></i><b></b></div>').join('')+'</div><div class="nm-card nm-sk"><b class="nm-sk-chart"></b></div></div>';
}
function nmError(msg){
  return '<div class="nm"><div class="nm-err" role="alert"><span>'+esc(msg||"Couldn't load the numbers.")+'</span><button type="button" class="btn" data-nm-retry="1">Try again</button></div></div>';
}

/* Bars = sent per day; line = replies. Plain SVG, one <title> per day for the hover tooltip. */
function nmChart(days){
  const W=720,H=200,L=34,R=8,T=10,B=24,iw=W-L-R,ih=H-T-B,n=days.length||1;
  const max=Math.max(1,...days.map(d=>Math.max(nmInt(d.sent),nmInt(d.replies))));
  const top=max<=4?4:Math.ceil(max/4)*4;
  const y=v=>T+ih-(v/top)*ih,step=iw/n,bw=Math.max(2,step*0.62);
  let s='<svg class="nm-chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Emails sent each day for the last 30 days, with replies as a line" preserveAspectRatio="none">';
  for(let i=0;i<=4;i++){const v=top*i/4,yy=y(v);s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy.toFixed(1)+'" y2="'+yy.toFixed(1)+'" class="nm-grid"/><text x="'+(L-6)+'" y="'+(yy+4).toFixed(1)+'" text-anchor="end" class="nm-ax">'+nmFmt(v)+'</text>';}
  const pts=[];
  days.forEach((d,i)=>{
    const x=L+i*step+(step-bw)/2,h=(nmInt(d.sent)/top)*ih;
    s+='<rect x="'+x.toFixed(1)+'" y="'+(T+ih-h).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" class="nm-bar"/>';
    pts.push((L+i*step+step/2).toFixed(1)+','+y(nmInt(d.replies)).toFixed(1));
  });
  if(days.some(d=>nmInt(d.replies)>0))s+='<polyline points="'+pts.join(' ')+'" class="nm-line"/>';
  days.forEach((d,i)=>{s+='<rect x="'+(L+i*step).toFixed(1)+'" y="'+T+'" width="'+step.toFixed(1)+'" height="'+ih+'" class="nm-hit"><title>'+esc(nmDay(d.day)+': '+nmFmt(d.sent)+' sent, '+nmFmt(d.replies)+' replies')+'</title></rect>';});
  [0,Math.floor((n-1)/2),n-1].forEach((i,k)=>{if(days[i])s+='<text x="'+(L+i*step+step/2).toFixed(1)+'" y="'+(H-6)+'" text-anchor="'+(k===0?'start':k===2?'end':'middle')+'" class="nm-ax">'+esc(nmDay(days[i].day))+'</text>';});
  return s+'</svg>';
}

function nmInboxes(list){
  if(!list||!list.length)return '<p class="nm-muted">No inboxes yet. They appear here once they are connected.</p>';
  return '<table class="nm-table"><thead><tr><th>Inbox</th><th>Status</th><th class="nm-r">Sent today</th><th class="nm-r">Daily limit</th></tr></thead><tbody>'+
    list.map(i=>'<tr><td>'+esc(i.email)+'</td><td><span class="nm-pill nm-'+(NM_TONE[i.health]||'grey')+'"><i></i>'+esc(i.healthWords||i.health||'')+'</span></td><td class="nm-r">'+nmFmt(i.sentToday)+'</td><td class="nm-r">'+(nmInt(i.limit)?nmFmt(i.limit):'—')+'</td></tr>').join('')+'</tbody></table>';
}

function nmWarmup(w){
  if(!w)return '';
  const of=nmInt(w.of)||14,day=Math.min(nmInt(w.day),of),pct=w.state==='done'?100:Math.round(day/of*100);
  return '<div class="nm-warm"><div class="nm-warm-top"><b>'+esc(w.words||'')+'</b></div><div class="nm-bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'" aria-label="Warm-up progress"><span style="width:'+pct+'%"></span></div></div>';
}

/* The whole panel, from a good answer. */
function nmRender(d,now){
  d=d||{};const t=d.today||{},tot=d.totals||{},days=Array.isArray(d.days)?d.days:[];
  const tiles='<div class="nm-tiles">'+NM_TILES.map(x=>'<div class="nm-tile"><span class="nm-label">'+esc(x[1])+'</span><b>'+nmFmt(t[x[0]])+'</b></div>').join('')+'</div>';
  const empty=!nmInt(tot.sent);
  const chart='<section class="nm-card"><div class="nm-card-h"><b>Emails sent, last 30 days</b><span class="nm-muted">Reply rate '+esc(nmPct(tot.replyRate))+'</span></div>'+
    (empty?'<div class="nm-empty"><b>'+esc(NM_EMPTY)+'</b><span class="nm-muted">The first emails go out once your inboxes have finished warming up.</span></div>':nmChart(days)+'<div class="nm-legend"><span><i class="nm-k-bar"></i>Sent</span><span><i class="nm-k-line"></i>Replies</span></div>')+'</section>';
  const inb='<section class="nm-card"><div class="nm-card-h"><b>Inboxes</b></div>'+nmInboxes(d.inboxes)+nmWarmup(d.warmup)+'</section>';
  const next=d.next&&d.next.words?'<p class="nm-next"><b>What’s next</b> '+esc(d.next.words)+'</p>':'';
  const upd=nmAgo(d.updatedAt,now);
  return '<div class="nm">'+tiles+chart+inb+next+(upd?'<p class="nm-muted nm-upd">'+esc(upd)+'</p>':'')+'</div>';
}

function nmOnPage(el){return el.isConnected!==undefined?!!el.isConnected:(typeof document!=='undefined'&&document.body&&document.body.contains?document.body.contains(el):true)}

/* Draw into el and keep it fresh every 60 s while it is on the page. Returns a promise for the first draw. */
function renderClientNumbers(el,clientId){
  if(!el)return Promise.resolve(null);
  const prev=nm.timers.get(el);if(prev)clearTimeout(prev);
  const seq=(el._nmSeq=(el._nmSeq||0)+1);
  const load=async(first)=>{
    if(el._nmSeq!==seq)return null;
    if(first)el.innerHTML=nmSkeleton();
    const q=clientId?'?clientId='+encodeURIComponent(clientId):'';
    let r;try{r=await machineFetch('/api/mc/portal/numbers'+q);}catch(e){r={ok:false,error:"Couldn't load the numbers."};}
    if(el._nmSeq!==seq)return null;
    if(r&&r.ok&&r.data&&r.data.ok!==false){el.innerHTML=nmRender(r.data);}
    else if(first||!el.innerHTML)el.innerHTML=nmError(r&&r.error);   // a failed refresh keeps the last good numbers on screen
    if(!el._nmClick){el._nmClick=true;if(el.addEventListener)el.addEventListener('click',e=>{const b=e.target&&e.target.closest&&e.target.closest('[data-nm-retry]');if(b)renderClientNumbers(el,clientId);});}
    nm.timers.set(el,setTimeout(()=>{if(el._nmSeq===seq&&nmOnPage(el))load(false);},NM_REFRESH_MS));
    return r;
  };
  return load(true);
}

/* Fill every mount point on the page (called after the shell draws a view). */
function numbersMountHosts(){
  if(typeof document==='undefined'||!document.querySelectorAll)return;
  document.querySelectorAll('.nm-host').forEach(h=>{
    if(h._nmMounted&&nmOnPage(h)&&h.innerHTML)return;
    h._nmMounted=true;
    const id=h.getAttribute('data-nm-client')||'';
    if(id)renderClientNumbers(h,id);
  });
}
function numbersOnRender(v){if(v==='numbers'||v==='trial')numbersMountHosts();}

/* The client's own Numbers view (#numbers). */
function numbersView(){
  const id=typeof authUser!=='undefined'&&authUser?authUser.clientId:'';
  return '<div class="nm-host" data-nm-client="'+esc(id||'')+'"></div>';
}
/* "Their numbers" on the owner's client page. */
function numbersTrialSection(id){
  return id?'<section class="tk-part" id="tkSec-numbers"><div class="tk-part-head"><h2>Their numbers</h2></div><div class="nm-host" data-nm-client="'+esc(id)+'"></div></section>':'';
}
