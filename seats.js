/* ============================================================================
   seats.js — Aviance Hub · how many people a client may have (their plan) and the client's "People" page
   ----------------------------------------------------------------------------
   Starter 2, Growth 4, Scale 6 client people per client; the team never counts. The real limit lives in the database
   (supabase/migrations/20261120_03_seat_limits.sql): table client_seats, and triggers that refuse an invite or a claim beyond it.
   The owner's invite writes the client's limit first (seatsUpsert); a client adds their own people from "People"
   (peopleAddPerson): it saves the invite (portal_invites, own client only), then asks the machine to email the link
   (POST /api/mc/portal/invite {email, link}). Every string through esc(); render functions return HTML.
   ========================================================================== */
const SEATS_BY_PLAN={starter:2,growth:4,scale:6};
const SEATS_FULL="You've reached the limit for your plan";
const sp={rows:null,seats:null,err:'',busy:false,out:null};

function seatsForPlan(plan){const p=String(plan||'').toLowerCase();return SEATS_BY_PLAN[p]||SEATS_BY_PLAN.starter}
/* The owner's side: store this client's limit (from their plan) before an invite is made. Returns an error text or ''. */
async function seatsUpsert(clientId,plan){
  if(!clientId)return 'Missing client.';
  try{
    const r=await sb.from('client_seats').upsert({client_id:clientId,seats:seatsForPlan(plan),updated_at:new Date().toISOString()},{onConflict:'client_id'});
    return r&&r.error?(r.error.message||'Could not save the limit.'):'';
  }catch(e){return 'Could not save the limit.';}
}
/* The database's refusal, in plain words (its message already reads "You've reached the limit for your plan (N people)."). */
function seatsPlain(msg){const m=String(msg||'');return m.indexOf(SEATS_FULL)>=0?m:(m||'Something went wrong. Try again.');}

function peopleClientView(){return '<div class="sp-host" id="spHost"></div>';}
function peopleRender(){
  const rows=sp.rows||[];const people=rows.filter(r=>r.kind==='person'),waiting=rows.filter(r=>r.kind==='invited');
  const used=people.length+waiting.length,seats=sp.seats;const full=seats!=null&&used>=seats;
  const li=r=>`<li style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--border)"><span><b>${esc(r.name||r.email||'')}</b>${r.name&&r.email?` <span class="tk-muted">${esc(r.email)}</span>`:''}</span><span class="tk-muted">${r.kind==='invited'?'Invited, not joined yet':'Joined'}</span></li>`;
  const add=full
    ?`<p role="status"><b>${esc(SEATS_FULL)} (${esc(seats)} people).</b> <span class="tk-muted">To add more, ask Aviance about a bigger plan.</span></p>`
    :`<div style="display:flex;gap:8px;flex-wrap:wrap"><input type="email" id="spEmail" aria-label="Their email address" placeholder="name@yourbusiness.com" style="flex:1;min-width:220px" onkeydown="if(event.key==='Enter')peopleAddPerson()"><button class="btn" type="button" id="spAdd" onclick="peopleAddPerson()">Add a person</button></div><p class="tk-muted tk-small">We email them a private link. It works for 14 days.</p>`;
  const out=sp.out?`<div role="status" class="tk-portal-out"><p class="tk-small"><b>${sp.out.sent?'Sent to '+esc(sp.out.email):'Not emailed yet'}</b>${sp.out.sent?'':' — the email did not go out. Copy the link and send it yourself.'}</p><div style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" readonly id="spLink" aria-label="Invite link" value="${esc(sp.out.link)}" onfocus="this.select()" style="flex:1;min-width:220px"><button class="btn ghost" type="button" onclick="peopleCopyLink()">Copy link</button></div></div>`:'';
  return `<div class="card" style="padding:16px 20px"><div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:8px"><h4 style="margin:0">People</h4>${seats!=null?`<span class="tk-muted" style="font-variant-numeric:tabular-nums">${esc(used)} of ${esc(seats)} used</span>`:''}</div>
    ${sp.err?`<p role="alert" style="color:var(--red)">${esc(sp.err)}</p>`:''}
    ${rows.length?`<ul style="list-style:none;margin:0 0 14px;padding:0">${rows.map(li).join('')}</ul>`:'<p><b>Nobody yet</b></p>'}
    ${add}${out}</div>`;
}
function peopleDraw(){const el=document.getElementById('spHost');if(el)el.innerHTML=peopleRender();}
async function peopleClientLoad(){
  const el=document.getElementById('spHost');if(!el)return;
  el.innerHTML='<div class="card client-loading" role="status">Loading…</div>';
  try{
    const [p,s]=await Promise.all([sb.rpc('my_people'),sb.from('client_seats').select('seats').maybeSingle()]);
    if(p&&p.error)sp.err='Could not load your people. Try again.';else{sp.err='';sp.rows=p.data||[];}
    sp.seats=s&&s.data&&s.data.seats!=null?Number(s.data.seats):null;
  }catch(e){sp.err='Could not load your people. Try again.';}
  peopleDraw();
}
async function peopleAddPerson(){
  if(sp.busy)return;
  const el=document.getElementById('spEmail');const email=(el?el.value.trim():'').toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){toast('Type their email address first');return;}
  sp.busy=true;const btn=document.getElementById('spAdd');if(btn)btn.disabled=true;
  try{
    const token=tkPortalToken();const hash=await tkSha256Hex(token);
    const ins=await sb.from('portal_invites').insert({client_id:authUser.clientId,email,token_hash:hash,created_by:authUser.uid||null,expires_at:new Date(Date.now()+14*86400000).toISOString()});
    if(ins&&ins.error){sp.err=seatsPlain(ins.error.message);await peopleClientLoad();return;}
    const link=location.origin+'/#join='+token;
    const r=await machineFetch('/api/mc/portal/invite',{method:'POST',body:{email,link}});
    sp.out={email,link,sent:!!(r.ok&&r.data&&r.data.sent)};sp.err='';
    toast(sp.out.sent?'Invite sent to '+email:'The invite is ready, but the email did not send');
    await peopleClientLoad();
  }catch(e){sp.err='Could not add them. Try again.';peopleDraw();}
  finally{sp.busy=false;}
}
function peopleCopyLink(){
  const el=document.getElementById('spLink');if(!el)return;
  try{navigator.clipboard.writeText(el.value).then(()=>toast('Link copied'),()=>{if(el.select)el.select();toast('Press Ctrl+C to copy');});}catch(e){if(el.select)el.select();toast('Press Ctrl+C to copy');}
}
function peopleForgetClient(){sp.rows=null;sp.seats=null;sp.err='';sp.out=null;}
