/* ===================== AVIANCE OS — Replies to approve (drafts) =====================
   What the bot wrote. Nothing reaches a client until the owner presses Send (spec/JOURNEY.md "C's functions").
   One card per pending draft: the client, their last message, the draft in an editable box, Send / Discard.
   Keyboard: Ctrl/Cmd+Enter in a box sends it; Tab moves between boxes and buttons as usual.

   Data (database functions in 20261124_journey_core.sql, team only):
     drafts_pending() -> [{id, client_id, company, channel_id, kind, body, msg_kind, meta, reason, created_at, last_client_message}]
     draft_send(p_draft, p_body) -> {message_id}     draft_discard(p_draft)     drafts_count() -> int
   Data functions (dr*) resolve to {ok, data, error} and never throw.
   drCount() is read by the shell's navItems() for the Replies badge: it returns the cached number and, while a team
   login is signed in, keeps it fresh every 30s (then redraws the nav with renderNav()).
   House rules: every string through esc(); ids reach handlers through drA(); views only return HTML; nothing runs at load. */

/* ===================== 0. STATE ===================== */
const DR_POLL_MS=30000;
const dr={list:[],loaded:false,loading:false,err:null,count:0,timer:null,busy:{},edits:{},seq:0,shown:null};

/* ===================== 1. DATA ===================== */
function drSb(){try{if(typeof sb!=='undefined'&&sb)return sb;}catch(e){}return (typeof window!=='undefined'&&window.sb)||null;}
function drPlain(err,fallback){
  if(!err)return fallback;
  const msg=String(err.message||err),code=String(err.code||'');
  if(/failed to fetch|networkerror|network request|load failed|fetch failed/i.test(msg))return "Can't reach Aviance right now. Check your connection and try again.";
  if(code==='PGRST301'||/jwt|not authenticated|session/i.test(msg))return 'Your sign-in has run out. Please sign in again.';
  if(code==='42501'||/permission denied|not authorized|row-level security/i.test(msg))return "You don't have access to do that.";
  if(code==='P0001'&&msg)return msg;
  return fallback;
}
async function drRpc(name,args,fallback){
  const s=drSb();if(!s)return {ok:false,data:null,error:'Aviance is not ready yet. Please reload the page.'};
  try{
    const r=await s.rpc(name,args||{});
    if(r&&r.error)return {ok:false,data:null,error:drPlain(r.error,fallback)};
    return {ok:true,data:r?r.data:null,error:null};
  }catch(e){return {ok:false,data:null,error:drPlain(e,fallback)};}
}
function drRow(r){
  return {id:r.id,clientId:r.client_id||null,company:r.company||'',channelId:r.channel_id||null,kind:r.kind||'reply',body:r.body||'',
    msgKind:r.msg_kind||'bot',meta:r.meta||null,reason:r.reason||'',createdAt:r.created_at||null,
    lastClient:typeof r.last_client_message==='string'?r.last_client_message:(r.last_client_message&&r.last_client_message.body)||''};
}
async function drPending(){
  const r=await drRpc('drafts_pending',{},"The drafts didn't load. Try again.");
  if(!r.ok)return r;
  return {ok:true,data:(Array.isArray(r.data)?r.data:[]).filter(x=>x&&x.id).map(drRow),error:null};
}
async function drSend(id,body){
  const b=String(body==null?'':body).trim();
  if(!id)return {ok:false,data:null,error:'Pick a draft first.'};
  if(!b)return {ok:false,data:null,error:'The message is empty. Write something or discard it.'};
  if(b.length>8000)return {ok:false,data:null,error:'That message is too long. Keep it under 8000 characters.'};
  return drRpc('draft_send',{p_draft:id,p_body:b},"That didn't send. Try again.");
}
async function drDiscard(id){
  if(!id)return {ok:false,data:null,error:'Pick a draft first.'};
  return drRpc('draft_discard',{p_draft:id},"That draft wasn't discarded. Try again.");
}

/* ===================== 2. NAV BADGE ===================== */
function drIsStaff(){return !!(typeof authUser!=='undefined'&&authUser&&(authUser.role==='admin'||authUser.role==='employee'));}
function drCount(){
  if(!drIsStaff()){drStop();return 0;}
  drStart();
  const n=Number(dr.count)||0;
  return n>99?'99+':n;
}
function drStart(){
  if(dr.timer||typeof setInterval!=='function')return;
  dr.timer=setInterval(drTick,DR_POLL_MS);
  if(dr.timer&&dr.timer.unref)dr.timer.unref();
  setTimeout(drTick,0);
}
function drStop(){if(dr.timer){clearInterval(dr.timer);dr.timer=null;}}
async function drTick(){
  if(!drIsStaff()){drStop();return;}
  if(typeof document!=='undefined'&&document.hidden)return;
  if(typeof currentView!=='undefined'&&currentView==='drafts'){await drLoad(true);return;}
  const r=await drRpc('drafts_count',{},'');
  if(r.ok)drSetCount(Number(r.data)||0);
}
function drSetCount(n){
  const changed=n!==dr.count;dr.count=n;
  if(changed){try{if(typeof renderNav==='function')renderNav();}catch(e){}}
}
/* Ask again now (after a draft was made elsewhere, e.g. the onboarding tracker). */
function drRefresh(){return drTick();}
/* Sign-out: drop everything. */
function draftsForget(){drStop();Object.assign(dr,{list:[],loaded:false,loading:false,err:null,count:0,busy:{},edits:{},seq:dr.seq+1,shown:null});}

/* ===================== 3. VIEW ===================== */
/* A value safe inside onclick="…" as a JavaScript string, from core.js. */
const drA = coreAttr;
function drEl(id){return typeof document!=='undefined'?document.getElementById(id):null;}
function drKindLabel(k){return ({reply:'Reply',welcome:'Welcome',step:'Step update',offer:'Call times',update:'Testing numbers',reminder:'Reminder',approval:'Approval',form:'Form'})[k]||'Message';}
/* coreAgo, and in a draft row a time we do not have shows nothing at all. */
function drAgo(s){ return coreAgo(s, '') }
function viewDrafts(){
  drLoad(false);
  const html=drBodyHTML();dr.shown=html;
  return `<div class="dr" id="drRoot">${html}</div>`;
}
function drBodyHTML(){
  const cantLoad=`<div class="card dr-empty" role="alert"><h3>The drafts didn't load</h3><p>${esc(dr.err||'')}</p><button type="button" class="btn" onclick="drLoad(true)">Try again</button></div>`;
  if(!dr.loaded&&dr.err)return cantLoad;
  if(!dr.loaded)return `<div class="card dr-empty" role="status">Loading the drafts…</div>`;
  /* "Nothing to approve" is a promise that nothing is waiting on him. It must
     never stand for "I could not read the drafts". The first load answering
     empty and a later refresh failing left dr.loaded true with an empty list,
     and the error below was never reached — the owner was told there was
     nothing to approve while drafts sat unread. */
  if(!dr.list.length&&dr.err)return cantLoad;
  if(!dr.list.length)return `<div class="card dr-empty"><h3>Nothing to approve</h3><p>When a client writes, the bot drafts a reply here. Nothing goes out until you send it.</p></div>`;
  return (dr.err?`<div class="dr-err" role="alert">${esc(dr.err)}</div>`:'')+
    `<p class="dr-hint">${dr.list.length} waiting · edit any draft, then Send (Ctrl+Enter) or Discard.</p>`+
    dr.list.map(drCardHTML).join('');
}
function drCardHTML(d){
  const busy=dr.busy[d.id]||'';
  const val=Object.prototype.hasOwnProperty.call(dr.edits,d.id)?dr.edits[d.id]:d.body;
  const company=d.company||'Client';
  return `<article class="card dr-card" id="drCard-${esc(d.id)}" aria-label="${esc(drKindLabel(d.kind)+' for '+company)}">
    <header class="dr-head"><b class="dr-co">${esc(company)}</b><span class="dr-tag">${esc(drKindLabel(d.kind))}</span><time class="dr-time">${esc(drAgo(d.createdAt))}</time>
      ${d.channelId?`<button type="button" class="dr-link" onclick="drOpenChannel(${drA(d.channelId)})">Open channel</button>`:''}</header>
    ${d.lastClient?`<blockquote class="dr-said"><span class="dr-said-k">They said</span>${esc(d.lastClient)}</blockquote>`:''}
    <label class="dr-label" for="drBody-${esc(d.id)}">Draft${d.reason?` <span class="dr-why">· ${esc(d.reason)}</span>`:''}</label>
    <textarea class="dr-box" id="drBody-${esc(d.id)}" rows="3" oninput="drEdit(${drA(d.id)},this.value)" onkeydown="drKey(event,${drA(d.id)})"${busy?' disabled':''}>${esc(val)}</textarea>
    <div class="dr-acts">
      <button type="button" class="btn" onclick="drSendClick(${drA(d.id)})"${busy?' disabled':''}>${busy==='send'?'Sending…':'Send'}</button>
      <button type="button" class="btn ghost" onclick="drDiscardClick(${drA(d.id)})"${busy?' disabled':''}>${busy==='discard'?'Discarding…':'Discard'}</button>
    </div>
  </article>`;
}
/* force=false is the 30-second refresh: when nothing changed it must not redraw, or a box he resized snaps back
   and the button he had tabbed to loses focus. */
function drPaint(force){
  const r=drEl('drRoot');if(!r)return;
  const html=drBodyHTML();
  if(force===false&&html===dr.shown)return;
  r.innerHTML=html;dr.shown=html;
}
async function drLoad(force){
  if(dr.loading&&!force)return;
  dr.loading=true;
  const seq=++dr.seq;
  let r;
  /* A guard flag left true never asks again: the drafts would stop arriving
     with nothing on screen to say so. */
  try{ r=await drPending(); }
  catch(e){ dr.loading=false; dr.err=drPlain(e,"The drafts didn't load. Try again."); drPaint(false); return; }
  if(seq!==dr.seq){dr.loading=false;return;}
  dr.loading=false;
  if(r.ok){
    dr.list=r.data;dr.loaded=true;dr.err=null;
    const have={};dr.list.forEach(d=>{have[d.id]=1;});
    Object.keys(dr.edits).forEach(k=>{if(!have[k])delete dr.edits[k];});
    drSetCount(dr.list.length);
  }else{dr.err=r.error;}
  // keep what the owner is typing: repaint only when no draft box has focus
  const a=typeof document!=='undefined'?document.activeElement:null;
  if(a&&a.id&&String(a.id).startsWith('drBody-')&&dr.loaded)return;
  drPaint(false);
}
function drEdit(id,v){dr.edits[id]=String(v==null?'':v);}
function drKey(e,id){
  if(e&&e.key==='Enter'&&(e.ctrlKey||e.metaKey)){if(e.preventDefault)e.preventDefault();drSendClick(id);}
}
function drFind(id){return dr.list.find(d=>d.id===id)||null;}
async function drSendClick(id){
  const d=drFind(id);if(!d||dr.busy[id])return;
  const body=Object.prototype.hasOwnProperty.call(dr.edits,id)?dr.edits[id]:d.body;   // oninput keeps dr.edits current
  dr.busy[id]='send';drPaint();
  const r=await drSend(id,body);
  delete dr.busy[id];
  if(!r.ok){dr.err=r.error;drPaint();if(typeof toast==='function')toast(r.error);return;}
  dr.err=null;drDrop(id);
  if(typeof toast==='function')toast('Sent to '+(d.company||'the client'));
}
async function drDiscardClick(id){
  const d=drFind(id);if(!d||dr.busy[id])return;
  dr.busy[id]='discard';drPaint();
  const r=await drDiscard(id);
  delete dr.busy[id];
  if(!r.ok){dr.err=r.error;drPaint();if(typeof toast==='function')toast(r.error);return;}
  dr.err=null;drDrop(id);
  if(typeof toast==='function')toast('Draft discarded');
}
function drDrop(id){
  dr.list=dr.list.filter(d=>d.id!==id);delete dr.edits[id];
  drSetCount(dr.list.length);drPaint();
  const next=dr.list[0]&&drEl('drBody-'+dr.list[0].id);if(next&&next.focus)next.focus();
}
function drOpenChannel(channelId){
  if(typeof chv!=='undefined')chv.want=channelId;
  if(typeof render==='function')render('channels');
}
