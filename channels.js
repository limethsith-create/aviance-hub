/* ===================== AVIANCE OS — Channels =====================
   Team chat: one channel per client (the team + the client), and team channels. A business chat in the style of
   Slack / Linear — no bots, no bubbles. Left: the channel list (clients, team, archived folded away, search).
   Middle: the messages (grouped by person and day, links clickable, images previewed, files as chips, edited /
   deleted marks, older messages load as you scroll up, a "New messages" divider, a typing line) and the composer.

   Data comes ONLY from the ch* functions of channels-api.js (CONTRACT.md "Hub data layer"); each returns
   {ok, data, error} and never throws.
     chListChannels() chMessages(id,{before,limit}) chSend(id,body,files) chEdit chDelete chMarkRead
     chSubscribe(id,{onMessage,onUpdate,onTyping}) → unsubscribe  chTyping(id)  chCreateChannel(name,memberIds)
     chRename chArchive chAddMember chRemoveMember chMembers chEnsureClientChannel(clientId,name) chFileUrl(path)
     chUnreadTotal() chSearch(text)
     chBotDrafts(channelId) chBotSend(draftId,body) chBotDiscard(draftId) — the bot's pending drafts, shown (staff only)
     above the composer of a client channel; nothing reaches the client until Send.
   `before` is passed the createdAt of the oldest message shown.

   Real tables (channels-api.js): a message's userId is its author_user (team) or author_person (client); a client's
   message has isClient:true and a name like "Pat Lee (Stone Roofing)", and the thread marks it with a Client tag.
   Files: there is no storage bucket yet, so the composer has no Attach button (CHV_FILES_ON). A message that already
   carries a web link as its attachment still shows it.

   Client mode (authUser.role==='client'): only their own channel, opened straight away, no channel admin.
   House rules: every string through esc(); links only http/https; ids reach handlers through chvA();
   view functions only return HTML; nothing runs at load time. Everything here is prefixed chv / channels. */

/* ===================== 0. STATE ===================== */
const CHV_PAGE=50;                    // messages per page
const CHV_MAX_FILE=CORE_FILE_MAX;      // per file (the storage rule; one copy, in core.js)
const CHV_MAX_FILES=5;                // per message
const CHV_FILES_ON=false;             // no 'chat-files' bucket yet: sending files is switched off
const CHV_NO_FILES="Sending files isn't switched on yet. Send the message as text, or paste a link to the file.";
const CHV_GROUP_MS=5*60*1000;         // same person within 5 minutes = one group
const CHV_POLL_MS=20000;              // unread counts for the channels that are not open (the open one is live)
const CHV_TYPING_MS=4500;
/* How long a send that was reported as failed is still believed to have landed.
   A message is one insert: the row can be committed and the answer lost on the
   way back (a dropped connection, a re-read the rule would not allow). The
   screen is then told "it didn't send" about a message the client can read, and
   the words go back in the box — so pressing Send again says it twice. For this
   long after such a failure, the same words arriving back from the server as my
   own message are taken as proof it did send: the warning goes, and the box is
   emptied of the copy rather than left waiting to be sent a second time. */
const CHV_UNSURE_MS=90000;
const chv={
  chs:[], loaded:false, err:null, loading:false,
  cur:null, want:null, msgs:[], hasMore:false, loadingOlder:false, msgsErr:null, msgsLoading:false,
  divId:null, newBelow:0, editing:null, sending:false,
  drafts:{}, pending:[], cerr:'', unsure:{},
  typing:{}, typingTimer:null, unsub:null,
  q:'', hits:[], searchSeq:0, searchTimer:null,
  pane:'list',
  archOpen:false, noChOpen:false, noChDone:{},
  urls:{}, urlWait:{},
  staff:null, staffErr:'', loadStaff:null,
  unreadTotal:0, peekAt:0, wasOpen:false, timer:null, seq:0, tmpSeq:0, creating:false, visHooked:false, caught:'',
  bot:[], botEdits:{}, botBusy:{}, botErr:'', botSeq:0, botTimers:[],
};

/* ===================== 1. HELPERS ===================== */
function chvA(v){return esc(JSON.stringify(v==null?'':String(v)));}
function chvIsClient(){return !!(typeof authUser!=='undefined'&&authUser&&authUser.role==='client');}
function chvIsStaff(){return !!(typeof authUser!=='undefined'&&authUser&&(authUser.role==='admin'||authUser.role==='employee'));}
function chvMe(){return (typeof authUser!=='undefined'&&authUser&&authUser.uid)||'';}
function chvIsPhone(){
  try{if(typeof window!=='undefined'&&typeof window.matchMedia==='function')return !!window.matchMedia('(max-width: 860px)').matches;}catch(e){}
  try{if(typeof window!=='undefined'&&typeof window.innerWidth==='number')return window.innerWidth<=860;}catch(e){}
  return false;
}
function chvNow(){return Date.now();}
function chvEl(id){return typeof document!=='undefined'?document.getElementById(id):null;}
function chvFn(name){return typeof globalThis[name]==='function'?globalThis[name]:null;}
/* Call a data function; never throws; always {ok,data,error}. */
async function chvCall(name,...args){
  const f=chvFn(name);
  if(!f)return {ok:false,data:null,error:'Channels are not available right now.'};
  try{const r=await f(...args);return r&&typeof r==='object'&&'ok' in r?r:{ok:false,data:null,error:'That did not go through. Try again.'};}
  catch(e){return {ok:false,data:null,error:'That did not go through. Check your connection and try again.'};}
}
function chvFindCh(id){return chv.chs.find(c=>c.id===id)||null;}
function chvInitial(name){return (String(name||'?').trim().charAt(0)||'?').toUpperCase();}
function chvBytes(n){n=Number(n)||0;if(n<1024)return n+' B';if(n<1048576)return Math.round(n/1024)+' KB';return (Math.round(n/104857.6)/10)+' MB';}
/* A value -> a Date, from core.js. A date-only value is a calendar day and does
   not slide with the reader's zone; a timestamp is a moment. */
const chvDate = coreToDate;
/* A day key, from core.js: 'YYYY-MM-DD' zero-padded in the reader's own calendar.
   One implementation, because a day key one day out is a refund. */
/* The key here used to be unpadded ('2026-1-2'). It is only ever compared for
   equality and grouped by, so nothing read wrong — but it sorted wrong, and a
   padded key is the one every other screen uses. */
const chvDayKey = coreDayKey;
function chvDayLabel(d,now){
  const n=new Date(now==null?chvNow():now);
  if(chvDayKey(d)===chvDayKey(n))return 'Today';
  const y=new Date(n.getTime());y.setDate(y.getDate()-1);
  if(chvDayKey(d)===chvDayKey(y))return 'Yesterday';
  try{return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:d.getFullYear()===n.getFullYear()?undefined:'numeric'});}catch(e){return d.toDateString();}
}
/* 'HH:MM' in the reader's own zone, from core.js. */
const chvTime = coreHm;
function chvBadgeText(n){n=Number(n)||0;return n>99?'99+':String(n);}
/* The total on the nav entry. */
function chvNavCount(){const n=Number(chv.unreadTotal)||0;return n>0?chvBadgeText(n):'';}
function chvAttOf(m){return Array.isArray(m&&m.attachments)?m.attachments.filter(a=>a&&a.path):[];}
function chvIsImage(a){return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(String(a.type||a.mime||''));}

/* Message text → safe HTML: escaped first, then only http/https links become anchors. */
function chvLinkify(text){
  const s=String(text==null?'':text);
  const re=/https?:\/\/[^\s<>"'`]+/gi;let out='',last=0,m;
  while((m=re.exec(s))){
    let url=m[0],tail='';
    while(/[.,;:!?)\]}]$/.test(url)){tail=url.slice(-1)+tail;url=url.slice(0,-1);}
    let ok=false;try{const u=new URL(url);ok=u.protocol==='http:'||u.protocol==='https:';}catch(e){ok=false;}
    out+=esc(s.slice(last,m.index));
    out+=ok?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url)}</a>`+esc(tail):esc(m[0]);
    last=m.index+m[0].length;
  }
  out+=esc(s.slice(last));
  return out.replace(/\r?\n/g,'<br>');
}

/* ===================== 2. VIEW SHELL ===================== */
function chvRootClass(){
  const c=['chv','chv-pane-'+chv.pane];
  if(chvIsClient())c.push('chv-solo');
  return c.join(' ');
}
function chvSyncClasses(){
  const r=chvEl('chvRoot');if(!r)return;
  r.className=chvRootClass();
}
function viewChannels(){
  chv.loading=true;
  const want=chv.want||chv.cur||null;chv.want=want;
  chvInit();
  return `<div class="${chvRootClass()}" id="chvRoot">${chvSkeleton()}</div>`;
}
function chvSkeleton(){
  return `<aside class="chv-list"><div class="chv-skel"></div><div class="chv-skel"></div><div class="chv-skel"></div></aside><section class="chv-main"><div class="chv-skel wide"></div></section>`;
}
async function chvInit(){
  const seq=++chv.seq;
  let r;
  /* chv.loading left true keeps the grey skeleton on screen for good: no list,
     no message, no way to ask again short of reloading the app. */
  try{ r=await chvCall('chListChannels'); }
  catch(e){ chv.loading=false;chv.loaded=false;chv.err="The channels didn't load. Try again.";chvPaintAll();return; }
  if(seq!==chv.seq){chv.loading=false;return;}
  chv.loading=false;
  if(r.ok&&Array.isArray(r.data)){chv.chs=chvVisible(r.data);chv.loaded=true;chv.err=null;}
  else{chv.err=r.error||"The channels didn't load. Try again.";chv.loaded=false;}
  chvUpdateTotal();
  const phone=chvIsPhone();
  let target=chv.want&&chvFindCh(chv.want)?chv.want:null;
  if(!target&&chvIsClient()){const f=chv.chs.find(c=>!c.archived);target=f?f.id:null;}
  if(!target&&!phone&&!chvIsClient()){const f=chvSorted(chv.chs.filter(c=>!c.archived))[0];target=f?f.id:null;}
  chv.want=null;
  if(!target&&chv.cur&&!chvFindCh(chv.cur))chvLeave();
  chv.pane=target||chv.cur?'thread':'list';
  if(chvIsClient()&&!target)chv.pane='thread';
  chvPaintAll();
  if(target){await chvOpen(target,true);}
  else if(!chvIsClient()&&chvIsStaff())chvLoadNoChannel();
}
function chvVisible(list){
  list=list.filter(c=>c&&c.id);
  if(chvIsClient())list=list.filter(c=>c.kind==='client'&&(!c.clientId||!authUser.clientId||c.clientId===authUser.clientId));
  return list;
}
function chvSorted(list){
  return list.slice().sort((a,b)=>{
    const ta=a.lastMessageAt?Date.parse(a.lastMessageAt)||0:0,tb=b.lastMessageAt?Date.parse(b.lastMessageAt)||0:0;
    return tb-ta||String(a.name||'').localeCompare(String(b.name||''));
  });
}
function chvUpdateTotal(){
  chv.unreadTotal=chv.chs.filter(c=>!c.archived).reduce((n,c)=>n+(Number(c.unread)||0),0);
  try{if(typeof renderNav==='function')renderNav();}catch(e){}
}
/* Paint everything (list, header, thread, composer). */
function chvPaintAll(){
  const r=chvEl('chvRoot');if(!r)return;
  r.className=chvRootClass();
  r.innerHTML=`<aside class="chv-list" id="chvListPane">${chvListHTML()}</aside>
    <section class="chv-main" id="chvMain">${chvMainHTML()}</section>`;
}

/* ===================== 3. LIST ===================== */
function chvListHTML(){
  if(chvIsClient())return '';
  const staff=chvIsStaff();
  return `<div class="chv-list-head"><h3>Channels</h3>${staff?`<button class="chv-btn primary" type="button" onclick="chvNewChannel()">New channel</button>`:''}</div>
    <div class="chv-search"><input id="chvSearch" type="search" placeholder="Search channels and messages" aria-label="Search channels and messages" value="${esc(chv.q)}" oninput="chvSearchInput(this.value)" autocomplete="off"></div>
    <div class="chv-list-body" id="chvListBody">${chvListBodyHTML()}</div>`;
}
function chvRow(c){
  const u=Number(c.unread)||0,on=c.id===chv.cur;
  const cl=c.kind==='client';
  return `<button type="button" class="chv-row${on?' on':''}${u?' unread':''}${cl?' client':''}" onclick="chvOpen(${chvA(c.id)})"${on?' aria-current="true"':''} aria-label="${esc((c.name||'Channel')+(cl?', client channel':'')+(u?', '+u+' unread':''))}"${cl?' title="Client channel: the client reads and writes here"':''}>
    <span class="chv-hash" aria-hidden="true">${cl?'C':'#'}</span><span class="chv-rname">${esc(c.name||'Channel')}</span>${u?`<span class="chv-badge" aria-hidden="true">${esc(chvBadgeText(u))}</span>`:''}</button>`;
}
function chvListBodyHTML(){
  if(chv.err&&!chv.chs.length)return `<div class="chv-err" role="alert">${esc(chv.err)} <button type="button" class="chv-link" onclick="chvReload()">Try again</button></div>`;
  if(!chv.loaded&&!chv.chs.length)return `<div class="chv-skel"></div><div class="chv-skel"></div><div class="chv-skel"></div>`;
  const q=chv.q.trim().toLowerCase();
  const match=c=>!q||String(c.name||'').toLowerCase().includes(q);
  const act=chvSorted(chv.chs.filter(c=>!c.archived&&match(c)));
  const arch=chvSorted(chv.chs.filter(c=>c.archived&&match(c)));
  const cl=act.filter(c=>c.kind==='client'),tm=act.filter(c=>c.kind!=='client');
  let h='';
  if(cl.length)h+=`<div class="chv-sec">Clients</div>`+cl.map(chvRow).join('');
  if(tm.length)h+=`<div class="chv-sec">Team</div>`+tm.map(chvRow).join('');
  if(!act.length&&!arch.length&&!chv.hits.length){
    h+=q?`<div class="chv-empty"><b>No channels match</b><span>Try a different name.</span></div>`
        :`<div class="chv-empty"><b>No channels yet</b><span>${chvIsStaff()?'Start one with New channel.':'Aviance will set yours up.'}</span></div>`;
  }
  if(arch.length)h+=`<details class="chv-arch"${chv.archOpen||q?' open':''} ontoggle="chv.archOpen=this.open"><summary>Archived (${arch.length})</summary>${arch.map(chvRow).join('')}</details>`;
  if(chvIsStaff()&&!q)h+=chvNoChannelHTML();
  if(chv.hits.length){
    h+=`<div class="chv-sec">Messages</div>`+chv.hits.map((m,i)=>{
      const ch=chvFindCh(m.channelId);
      return `<button type="button" class="chv-hit" onclick="chvOpenHit(${i})"><span class="chv-hit-top">${esc((ch&&ch.name)||m.channelName||'Channel')} <span class="muted">${esc(m.name||'')}</span></span><span class="chv-hit-body">${esc(String(m.body||'').slice(0,140))}</span></button>`;
    }).join('');
  }
  return h;
}
function chvPaintList(){
  const b=chvEl('chvListBody');if(b)b.innerHTML=chvListBodyHTML();
}
async function chvReload(){
  const r=await chvCall('chListChannels');
  if(r.ok&&Array.isArray(r.data)){chv.chs=chvVisible(r.data);chv.loaded=true;chv.err=null;}
  else if(!chv.chs.length){chv.err=r.error||"The channels didn't load. Try again.";}
  // the open channel's unread stays zero while it is open
  const c=chvFindCh(chv.cur);
  const missed=!!(c&&chvViewing()&&chvBehind(c));
  if(c&&chvViewing())c.unread=0;
  chvUpdateTotal();
  chvPaintList();
  if(missed)await chvCatchUp();
}
/* True when the list says the open channel has a newer message than the thread shows: the live line dropped
   (a laptop that slept, a phone that lost signal) and missed something. */
function chvBehind(c){
  if(chv.msgsLoading||chv.sending)return false;
  const last=chv.msgs.length?chv.msgs[chv.msgs.length-1]:null;
  const listAt=Date.parse((c&&c.lastMessageAt)||'')||0,haveAt=last?(Date.parse(last.createdAt||'')||0):0;
  if(listAt<=haveAt||chv.caught===c.id+'|'+c.lastMessageAt)return false;   // already looked for this one
  chv.caught=c.id+'|'+c.lastMessageAt;
  return true;
}
/* Fetch the newest page again and add whatever the live line missed, exactly as if it had arrived live. */
async function chvCatchUp(){
  const id=chv.cur;if(!id)return;
  const r=await chvCall('chMessages',id,{limit:CHV_PAGE});
  if(id!==chv.cur||!r.ok||!Array.isArray(r.data))return;
  const have={};chv.msgs.forEach(m=>{have[m.id]=1;});
  r.data.filter(m=>m&&m.id&&!have[m.id]).forEach(chvOnMessage);
}
function chvViewing(){return typeof currentView!=='undefined'&&currentView==='channels'&&!!chv.cur;}

/* Clients that have no channel yet (staff). */
function chvClientsWithout(){
  let rows=[];try{if(typeof tkListRows==='function'&&typeof tk!=='undefined')rows=tkListRows(tk.hub);}catch(e){rows=[];}
  const have={};chv.chs.forEach(c=>{if(c.clientId)have[c.clientId]=1;});
  return rows.filter(r=>r&&r.id!=null&&!have[r.id]&&!chv.noChDone[r.id]);
}
function chvNoChannelHTML(){
  const rows=chvClientsWithout();if(!rows.length)return '';
  return `<details class="chv-arch"${chv.noChOpen?' open':''} ontoggle="chv.noChOpen=this.open"><summary>Clients without a channel (${rows.length})</summary>`+
    rows.map(r=>`<button type="button" class="chv-row" onclick="chvStartClient(${chvA(r.id)})"><span class="chv-hash" aria-hidden="true">+</span><span class="chv-rname">${esc(r.name||r.id)}</span><span class="chv-start">Start</span></button>`).join('')+`</details>`;
}
async function chvLoadNoChannel(){
  try{if(typeof loadHub==='function'){await loadHub(false);chvPaintList();}}catch(e){}
}
async function chvStartClient(clientId){
  let name=String(clientId);
  try{const row=typeof tkFindRow==='function'?tkFindRow(clientId):null;if(row&&row.name)name=row.name;}catch(e){}
  const r=await chvCall('chEnsureClientChannel',clientId,name);
  if(!r.ok){toast(r.error||"The channel didn't start. Try again.");return;}
  chv.noChDone[clientId]=1;
  await chvReload();
  const id=r.data&&(r.data.id||r.data.channelId||(typeof r.data==='string'?r.data:null));
  const target=id&&chvFindCh(id)?id:(chv.chs.find(c=>c.clientId===clientId)||{}).id;
  if(target)chvOpen(target);
}

/* Search: channel names filter at once; messages are looked up after a short pause. */
function chvSearchInput(v){
  chv.q=String(v||'');
  chvPaintList();
  clearTimeout(chv.searchTimer);
  const q=chv.q.trim();
  if(q.length<2){chv.hits=[];chv.searchSeq++;chvPaintList();return;}
  const seq=++chv.searchSeq;
  chv.searchTimer=setTimeout(async()=>{
    const r=await chvCall('chSearch',q);
    if(seq!==chv.searchSeq)return;
    chv.hits=r.ok&&Array.isArray(r.data)?r.data.slice(0,20):[];
    chvPaintList();
  },250);
  if(chv.searchTimer&&chv.searchTimer.unref)chv.searchTimer.unref();
}
function chvOpenHit(i){const m=chv.hits[i];if(m&&m.channelId)chvOpen(m.channelId);}

/* ===================== 4. MAIN: header, thread, composer ===================== */
function chvMainHTML(){
  const c=chvFindCh(chv.cur);
  if(!c){
    if(chvIsClient()&&chv.loaded)return `<div class="chv-blank"><b>Your channel isn't ready yet</b><span>Aviance will set it up shortly. Check back soon.</span></div>`;
    if(chv.err&&!chv.chs.length&&chvIsClient())return `<div class="chv-err" role="alert">${esc(chv.err)} <button type="button" class="chv-link" onclick="chvInit()">Try again</button></div>`;
    return `<div class="chv-blank"><b>Pick a channel</b><span>Choose one from the list to read and write messages.</span></div>`;
  }
  return `<header class="chv-head" id="chvHead">${chvHeadHTML(c)}</header>
    <div class="chv-thread" id="chvThread" onscroll="chvScroll(this)" role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages">${chvThreadHTML()}</div>
    <button type="button" class="chv-newpill" id="chvNewPill" onclick="chvJumpNew()" hidden>New messages</button>
    <div class="chv-typing" id="chvTyping" aria-live="polite">${chvTypingText()}</div>
    <div class="chv-bot" id="chvBot" aria-label="Replies the bot drafted">${chvBotHTML()}</div>
    <div class="chv-composer" id="chvComposer">${chvComposerHTML(c)}</div>`;
}
function chvHeadHTML(c){
  const staff=chvIsStaff();
  return `${chvIsClient()?'':`<button type="button" class="chv-back" onclick="chvBack()" aria-label="Back to channels">Channels</button>`}
    <div class="chv-title"><h2>${esc(c.name||'Channel')}</h2><span class="chv-kind${c.kind==='client'?' client':''}">${c.kind==='client'?`Client channel · ${esc(c.company||c.name||'the client')} reads and writes here`:'Team'}${c.archived?' · Archived':''}</span></div>
    <div class="chv-actions">
      ${staff&&!c.archived?`<button type="button" class="chv-btn" onclick="chvMembers()">Members</button><button type="button" class="chv-btn" onclick="chvRename()">Rename</button><button type="button" class="chv-btn" onclick="chvArchive()">Archive</button>`:''}
    </div>`;
}
function chvPaintHead(){const c=chvFindCh(chv.cur),h=chvEl('chvHead');if(c&&h)h.innerHTML=chvHeadHTML(c);}

/* The thread: day separators, author groups, the new-messages divider. */
function chvThreadHTML(){
  if(chv.msgsLoading&&!chv.msgs.length)return `<div class="chv-skel wide"></div><div class="chv-skel wide"></div><div class="chv-skel wide"></div>`;
  if(chv.msgsErr&&!chv.msgs.length)return `<div class="chv-err" role="alert">${esc(chv.msgsErr)} <button type="button" class="chv-link" onclick="chvOpen(${chvA(chv.cur)},true)">Try again</button></div>`;
  if(!chv.msgs.length)return `<div class="chv-blank"><b>No messages yet</b><span>Write the first one below.</span></div>`;
  const me=chvMe();let h='';
  /* a real button, not just "scroll up": a long thread has to be pageable from the keyboard */
  if(chv.hasMore)h+=`<div class="chv-older">${chv.loadingOlder?'Loading earlier messages':'<button type="button" class="chv-link" onclick="chvLoadOlder()">Load earlier messages</button>'}</div>`;
  else h+=`<div class="chv-older">Start of the conversation</div>`;
  let prev=null,prevDay='';
  chv.msgs.forEach(m=>{
    const d=chvDate(m.createdAt);const dk=d?chvDayKey(d):'';
    if(dk!==prevDay){h+=`<div class="chv-day"><span>${esc(d?chvDayLabel(d):'')}</span></div>`;prevDay=dk;prev=null;}
    if(chv.divId&&m.id===chv.divId)h+=`<div class="chv-divider" id="chvNew" role="separator"><span>New messages</span></div>`;
    const grouped=prev&&prev.userId===m.userId&&d&&chvDate(prev.createdAt)&&(d.getTime()-chvDate(prev.createdAt).getTime())<CHV_GROUP_MS&&!(chv.divId&&m.id===chv.divId);
    h+=chvMsgHTML(m,!grouped,m.userId===me,d);
    prev=m;
  });
  return h;
}
function chvMsgHTML(m,first,own,d){
  const idAttr='chvM-'+esc(m.id);
  const cl=!!m.isClient;
  const gut=`<div class="chv-gut">${first?`<span class="chv-av${cl?' client':''}" aria-hidden="true">${esc(chvInitial(m.name))}</span>`:''}</div>`;
  const head=first?`<div class="chv-mhead"><span class="chv-who">${esc(m.name||'Someone')}</span>${cl?'<span class="chv-client-tag">Client</span>':''}<time>${esc(d?chvTime(d):'')}</time></div>`:'';
  if(m.deleted)return `<div class="chv-msg${first?' first':''} deleted" id="${idAttr}">${gut}<div class="chv-col">${head}<div class="chv-body"><span class="chv-gone">This message was deleted</span></div></div></div>`;
  let body;
  if(chv.editing===m.id){
    body=`<div class="chv-editbox"><textarea id="chvEdit" rows="2" onkeydown="chvEditKey(event)" aria-label="Edit message">${esc(m.body||'')}</textarea>
      <div class="chv-edithint">Enter to save · Esc to cancel <button type="button" class="chv-btn" onclick="chvEditCancel()">Cancel</button><button type="button" class="chv-btn primary" onclick="chvEditSave()">Save</button></div></div>`;
  }else{
    body=(m.body?`<div class="chv-text">${chvLinkify(m.body)}${m.editedAt?` <span class="chv-edited">(edited)</span>`:''}</div>`:'')+chvAttsHTML(m);
  }
  const actions=own&&!m.sending&&chv.editing!==m.id&&!(chvFindCh(chv.cur)||{}).archived?`<span class="chv-macts"><button type="button" class="chv-link" onclick="chvEditStart(${chvA(m.id)})">Edit</button><button type="button" class="chv-link" onclick="chvDelete(${chvA(m.id)})">Delete</button></span>`:'';
  return `<div class="chv-msg${first?' first':''}${own?' own':''}${cl?' from-client':''}${m.sending?' sending':''}" id="${idAttr}">${gut}<div class="chv-col">${head}<div class="chv-body">${body}${actions}</div></div></div>`;
}
function chvAttsHTML(m){
  const atts=chvAttOf(m);if(!atts.length)return '';
  return `<div class="chv-atts">`+atts.map((a,i)=>{
    const direct=a.url&&/^https?:\/\//i.test(a.url)?a.url:'';   // a web link needs no signing
    const url=chv.urls[a.path]||direct;
    const name=esc(a.name||'file'),size=a.size?chvBytes(a.size):'';
    if(!direct)chvWantUrl(a.path);
    if(chvIsImage(a)){
      return url?`<a class="chv-img" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="${name}" loading="lazy"></a>`
        :`<span class="chv-img pending" aria-label="${name}"><span>${name}</span></span>`;
    }
    return `<a class="chv-file" href="${url?esc(url):'#'}" ${url?`download="${name}" target="_blank" rel="noopener noreferrer"`:`onclick="return chvFile(event,${chvA(m.id)},${i})"`}><span class="chv-fname">${name}</span><span class="chv-fsize">${esc(size)}</span></a>`;
  }).join('')+`</div>`;
}
/* Signed links last an hour: fetched once per file, then the thread repaints with them. */
function chvWantUrl(path){
  if(chv.urls[path]||chv.urlWait[path])return;
  chv.urlWait[path]=true;
  /* urlWait is the "already asking" flag. Left true it is never cleared, so the
     attachment shows its grey placeholder for the rest of the session and is
     never asked for again — the file looks broken when the link simply did not
     arrive. Cleared either way, the next repaint asks again. */
  const done=()=>{delete chv.urlWait[path];};
  chvCall('chFileUrl',path).then(r=>{
    done();
    const u=r.ok&&r.data&&(typeof r.data==='string'?r.data:r.data.url);
    if(u&&/^https?:\/\//i.test(u)){
      chv.urls[path]=u;
      chvPaintThread(true);
    }
  },done);
}
async function chvFile(ev,msgId,i){
  if(ev&&ev.preventDefault)ev.preventDefault();
  const m=chv.msgs.find(x=>x.id===msgId),a=m&&chvAttOf(m)[i];if(!a)return false;
  const r=await chvCall('chFileUrl',a.path);
  const u=r.ok&&r.data&&(typeof r.data==='string'?r.data:r.data.url);
  if(u&&/^https?:\/\//i.test(u)){try{window.open(u,'_blank','noopener');}catch(e){}}
  else toast(r.error||"The file didn't open. Try again.");
  return false;
}
/* Repaint the thread. keep = stay where you are (distance from the bottom is kept). */
function chvPaintThread(keep){
  const t=chvEl('chvThread');if(!t)return;
  const fromBottom=(t.scrollHeight||0)-(t.scrollTop||0);
  t.innerHTML=chvThreadHTML();
  if(keep)t.scrollTop=Math.max(0,(t.scrollHeight||0)-fromBottom);
}
function chvScrollBottom(){const t=chvEl('chvThread');if(t)t.scrollTop=t.scrollHeight||0;}
function chvAtBottom(){const t=chvEl('chvThread');if(!t)return true;return (t.scrollHeight||0)-(t.scrollTop||0)-(t.clientHeight||0)<80;}
function chvShowPill(on){const p=chvEl('chvNewPill');if(p)p.hidden=!on;}

/* Scrolling: near the top loads older messages; at the bottom clears "new messages". */
function chvScroll(t){
  if(!t)return;
  if((t.scrollTop||0)<60&&chv.hasMore&&!chv.loadingOlder&&chv.msgs.length)chvLoadOlder();
  if(chv.newBelow&&(t.scrollHeight||0)-(t.scrollTop||0)-(t.clientHeight||0)<80){chv.newBelow=0;chvShowPill(false);chvMarkReadNow();}
}
async function chvLoadOlder(){
  const id=chv.cur,first=chv.msgs[0];if(!id||!first||chv.loadingOlder)return;
  chv.loadingOlder=true;
  const t=chvEl('chvThread');const before=t?(t.scrollHeight||0):0;
  const r=await chvCall('chMessages',id,{before:first.createdAt,limit:CHV_PAGE});
  chv.loadingOlder=false;
  if(id!==chv.cur)return;
  if(!r.ok||!Array.isArray(r.data)){toast(r.error||"Earlier messages didn't load. Try again.");chvPaintThread(true);return;}
  const have={};chv.msgs.forEach(m=>{have[m.id]=1;});
  const older=r.data.filter(m=>!have[m.id]);
  chv.hasMore=r.data.length>=CHV_PAGE&&older.length>0;
  chv.msgs=older.concat(chv.msgs);
  chvPaintThread(false);
  const t2=chvEl('chvThread');if(t2)t2.scrollTop=Math.max(0,(t2.scrollHeight||0)-before);
}

/* Typing line */
function chvTypingNames(){
  const now=chvNow();return Object.keys(chv.typing).filter(k=>chv.typing[k].until>now).map(k=>chv.typing[k].name||'Someone');
}
function chvTypingText(){
  const n=chvTypingNames();
  if(!n.length)return '';
  if(n.length===1)return esc(n[0])+' is typing';
  if(n.length===2)return esc(n[0])+' and '+esc(n[1])+' are typing';
  return 'Several people are typing';
}
function chvPaintTyping(){const e=chvEl('chvTyping');if(e)e.innerHTML=chvTypingText();}
function chvOnTyping(p){
  if(!p||!p.userId||p.userId===chvMe())return;
  chv.typing[p.userId]={name:p.name||'Someone',until:chvNow()+CHV_TYPING_MS};
  chvPaintTyping();
  clearTimeout(chv.typingTimer);
  chv.typingTimer=setTimeout(()=>{chvPaintTyping();},CHV_TYPING_MS+50);
  if(chv.typingTimer&&chv.typingTimer.unref)chv.typingTimer.unref();
}

/* ===================== 5. OPEN / LEAVE / REALTIME ===================== */
function chvLeave(){
  chvSaveDraft();
  if(chv.unsub){try{chv.unsub();}catch(e){}chv.unsub=null;}
  chv.urls={};chv.urlWait={};
  chv.cur=null;chv.msgs=[];chv.hasMore=false;chv.divId=null;chv.newBelow=0;chv.editing=null;chv.typing={};chv.pending=[];chv.cerr='';
  chvBotClear();
}
async function chvOpen(id,force){
  if(!id)return;
  const c=chvFindCh(id);if(!c)return;
  if(id===chv.cur&&!force){chv.pane='thread';chvSyncClasses();return;}
  if(id!==chv.cur)chvLeave();
  chv.cur=id;chv.pane='thread';chv.msgsLoading=true;chv.msgsErr=null;chv.msgs=[];chv.divId=null;chv.newBelow=0;chv.editing=null;
  const unread=Number(c.unread)||0;
  const seq=++chv.seq;
  chvPaintAll();
  try{if(typeof history!=='undefined'&&history.replaceState)history.replaceState(null,'',(location.pathname||'/')+(location.search||'')+'#channels/'+encodeURIComponent(id));}catch(e){}
  const r=await chvCall('chMessages',id,{limit:CHV_PAGE});
  if(seq!==chv.seq||id!==chv.cur)return;
  chv.msgsLoading=false;
  if(!r.ok||!Array.isArray(r.data)){chv.msgsErr=r.error||"The messages didn't load. Try again.";chvPaintThread(false);return;}
  chv.msgs=r.data.slice();
  chv.hasMore=r.data.length>=CHV_PAGE;
  chv.divId=unread>0?chvFirstUnreadId(unread):null;
  chvPaintThread(false);
  const nd=chv.divId?chvEl('chvNew'):null;
  if(nd&&nd.scrollIntoView)nd.scrollIntoView({block:'start'});else chvScrollBottom();
  // subscribe for live messages
  if(chv.unsub){try{chv.unsub();}catch(e){}chv.unsub=null;}
  try{
    const u=chvFn('chSubscribe')?chSubscribe(id,{onMessage:chvOnMessage,onUpdate:chvOnUpdate,onTyping:chvOnTyping}):null;
    chv.unsub=typeof u==='function'?u:null;
  }catch(e){chv.unsub=null;}
  chvMarkReadNow();
  chvBotLoad();
  const input=chvEl('chvInput');if(input&&input.focus&&!chvIsPhone())input.focus();
}
/* The first of the last N messages that came from other people. */
function chvFirstUnreadId(n){
  const me=chvMe();let count=0,id=null;
  for(let i=chv.msgs.length-1;i>=0;i--){
    const m=chv.msgs[i];if(m.userId===me)continue;
    count++;id=m.id;if(count>=n)break;
  }
  return id;
}
async function chvMarkReadNow(){
  const id=chv.cur;if(!id)return;
  const c=chvFindCh(id);
  if(c&&c.unread){c.unread=0;chvUpdateTotal();chvPaintList();}
  chCallQuiet('chMarkRead',id);
}
function chCallQuiet(name,...a){chvCall(name,...a);}
function chvOnMessage(m){
  if(!m||!m.id)return;
  if(m.channelId&&m.channelId!==chv.cur)return;
  const i=chv.msgs.findIndex(x=>x.id===m.id);
  if(i>=0){chv.msgs[i]=Object.assign({},chv.msgs[i],m);chvPaintThread(true);return;}
  const own=m.userId===chvMe();
  const atBottom=chvAtBottom();
  chv.msgs.push(m);
  if(own)chvSendLanded(m);
  if(m.isClient)chvBotSoon();
  if(chv.typing[m.userId]){delete chv.typing[m.userId];chvPaintTyping();}
  const c=chvFindCh(chv.cur);if(c)c.lastMessageAt=m.createdAt||c.lastMessageAt;
  if(own||atBottom){
    chvPaintThread(false);chvScrollBottom();
    if(!own)chvMarkReadNow();
  }else{
    if(!chv.divId)chv.divId=m.id;
    chv.newBelow++;
    chvPaintThread(true);chvShowPill(true);
  }
  chvPaintList();
}
/* My own message arriving from the server after a send that was reported as
   failed: it did send after all. Take the copy out of the box and take the
   warning down, so it is not said to the client twice. Only the exact words,
   only mine, only inside CHV_UNSURE_MS. */
function chvSendLanded(m){
  const id=m&&m.channelId||chv.cur;if(!id)return false;
  const u=chv.unsure[id];if(!u)return false;
  if(chvNow()-u.at>CHV_UNSURE_MS){delete chv.unsure[id];return false;}
  if(String(m.body||'').trim()!==String(u.body||'').trim())return false;
  delete chv.unsure[id];
  if(String(chv.drafts[id]||'').trim()===String(u.body||'').trim()){
    chv.drafts[id]='';
    const box=chvEl('chvInput');if(box){box.value='';if(box.style)box.style.height='auto';}
  }
  chv.cerr='It did send after all — it was only the answer that went missing.';
  const e=chvEl('chvCErr');if(e)e.textContent=chv.cerr;
  const b=chvEl('chvSend');if(b)b.disabled=false;
  return true;
}
function chvOnUpdate(m){
  if(!m||!m.id)return;
  if(m.channelId&&m.channelId!==chv.cur)return;
  const i=chv.msgs.findIndex(x=>x.id===m.id);
  if(i<0)return;
  chv.msgs[i]=Object.assign({},chv.msgs[i],m);
  if(chv.editing===m.id&&m.deleted)chv.editing=null;
  chvPaintThread(true);
}
function chvJumpNew(){chv.newBelow=0;chvShowPill(false);const nd=chvEl('chvNew');if(nd&&nd.scrollIntoView)nd.scrollIntoView({block:'start'});else chvScrollBottom();chvMarkReadNow();}
/* Phone: back from a channel to the list. */
function chvBack(){chv.pane='list';chvSyncClasses();}

/* ===================== 6. COMPOSER ===================== */
function chvComposerHTML(c){
  if(c.archived)return `<div class="chv-archived">This channel is archived. You can read it, but not write in it.</div>`;
  const chips=chv.pending.map((f,i)=>`<span class="chv-chip"><span class="chv-fname">${esc(f.name||'file')}</span><span class="chv-fsize">${esc(chvBytes(f.size))}</span><button type="button" class="chv-x" onclick="chvUnattach(${i})" aria-label="Remove ${esc(f.name||'file')}">Remove</button></span>`).join('');
  return `${chips?`<div class="chv-chips" id="chvChips">${chips}</div>`:'<div class="chv-chips" id="chvChips"></div>'}
    <div class="chv-cerr" id="chvCErr" role="alert">${esc(chv.cerr)}</div>
    <div class="chv-cbox">
      ${CHV_FILES_ON?`<button type="button" class="chv-attach" onclick="chvPick()" aria-label="Attach files">Attach</button>`:''}
      <textarea id="chvInput" rows="1" placeholder="Write a message" aria-label="Write a message" onkeydown="chvKey(event)" oninput="chvInput(this)" onpaste="chvPaste(event)">${esc(chv.drafts[chv.cur]||'')}</textarea>
      <button type="button" class="chv-send" id="chvSend" onclick="chvSend()"${chv.sending?' disabled':''}>Send</button>
      ${CHV_FILES_ON?`<input type="file" id="chvFile" multiple hidden onchange="chvFiles(this)">`:''}
    </div>`;
}
function chvPaintComposer(){const c=chvFindCh(chv.cur),e=chvEl('chvComposer');if(c&&e)e.innerHTML=chvComposerHTML(c);}
function chvSaveDraft(){const i=chvEl('chvInput');if(i&&chv.cur)chv.drafts[chv.cur]=i.value||'';}
function chvPick(){const f=chvEl('chvFile');if(f&&f.click)f.click();}
function chvInput(t){
  if(t&&t.style){t.style.height='auto';t.style.height=Math.min(t.scrollHeight||0,160)+'px';}
  if(t&&t.value&&chv.cur)chCallQuiet('chTyping',chv.cur);
}
function chvKey(e){
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();chvSend();}
}
/* Add files, checking the limits; says what was left out in plain words. */
function chvAddFiles(list){
  if(!CHV_FILES_ON){chv.cerr=CHV_NO_FILES;const e=chvEl('chvCErr');if(e)e.textContent=chv.cerr;return;}
  const msgs=[];
  Array.from(list||[]).forEach(f=>{
    if(!f)return;
    if(chv.pending.length>=CHV_MAX_FILES){if(!msgs.some(x=>x.startsWith('You can')))msgs.push(`You can send up to ${CHV_MAX_FILES} files at a time.`);return;}
    if(!(f.size>0)){msgs.push(`${f.name||'That file'} is empty, so it was not added.`);return;}
    if(f.size>CHV_MAX_FILE){msgs.push(`${f.name||'That file'} is bigger than ${CHV_MAX_FILE/1048576} MB, so it was not added.`);return;}
    chv.pending.push(f);
  });
  chv.cerr=msgs.join(' ');
  chvSaveDraft();chvPaintComposer();
  const i=chvEl('chvInput');if(i&&i.focus&&!chvIsPhone())i.focus();
}
function chvFiles(input){chvAddFiles(input&&input.files);if(input)try{input.value='';}catch(e){}}
function chvUnattach(i){chv.pending.splice(i,1);chv.cerr='';chvSaveDraft();chvPaintComposer();}
/* Pasting a screenshot attaches it; pasting text works as usual. */
function chvPaste(e){
  if(!CHV_FILES_ON)return;                     // text pastes as usual; images are not sent while files are off
  const cd=e&&e.clipboardData;if(!cd)return;
  const files=[];
  if(cd.files&&cd.files.length)Array.from(cd.files).forEach(f=>{if(/^image\//i.test(f.type||''))files.push(f);});
  else if(cd.items)Array.from(cd.items).forEach(it=>{if(it.kind==='file'&&/^image\//i.test(it.type||'')){const f=it.getAsFile&&it.getAsFile();if(f)files.push(f);}});
  if(!files.length)return;
  e.preventDefault();chvAddFiles(files);
}
/* What is left in the box once `sent` has gone: whatever was typed after it while it was on its way. Pure. */
function chvLeftover(sent,now){
  const a=String(sent==null?'':sent),b=String(now==null?'':now);
  if(b===a)return '';
  return b.indexOf(a)===0?b.slice(a.length).replace(/^\s+/,''):b;
}
/* Send. The message is drawn the moment Enter is pressed and the box is emptied, so there is no wait on the
   network; if it does not go, it is taken back out of the thread and the words are put back in the box. */
async function chvSend(){
  const id=chv.cur,c=chvFindCh(id);if(!c||c.archived||chv.sending)return;
  const input=chvEl('chvInput');
  const raw=String(input?input.value:(chv.drafts[id]||''));
  const body=raw.trim();
  if(!body&&!chv.pending.length)return;
  chv.sending=true;chv.cerr='';
  const ce=chvEl('chvCErr');if(ce)ce.textContent='';
  const btn=chvEl('chvSend');if(btn)btn.disabled=true;
  const files=chv.pending.slice();
  let tmp=null;
  if(body&&!files.length){
    tmp={id:'chv-sending-'+(++chv.tmpSeq),channelId:id,userId:chvMe(),name:(typeof authUser!=='undefined'&&authUser&&authUser.name)||'',body,attachments:[],createdAt:new Date(chvNow()).toISOString(),sending:true};
    chv.msgs.push(tmp);chv.drafts[id]='';chv.divId=null;
    if(input){input.value='';if(input.style)input.style.height='auto';}
    chvPaintThread(false);chvScrollBottom();
  }
  let r;
  /* A message is a write: never sent twice from here. But chv.sending left true
     disables the Send button for the rest of the session. */
  try{ r=await chvCall('chSend',id,body,files); }
  catch(e){ r={ok:false,data:null,error:"Your message didn't send. Try again."}; }
  finally{ chv.sending=false; }
  if(tmp)chv.msgs=chv.msgs.filter(x=>x!==tmp);
  /* It said no — but a send is one insert, so the row may be on the server all
     the same. Remember the words, so that the same message coming back as mine
     clears the warning instead of sitting in the box to be sent twice. */
  if(!r.ok&&body)chv.unsure[id]={body:body,at:chvNow()};
  if(id!==chv.cur){
    // he moved to another channel while it was on its way: never lose the words
    if(!r.ok){if(tmp&&!chv.drafts[id])chv.drafts[id]=raw;toast((r.error||"Your message didn't send.")+' It is back in the box in '+(c.name||'that channel')+'.');}
    return;
  }
  const box=chvEl('chvInput');
  if(!r.ok){
    chv.cerr=r.error||"Your message didn't send. Try again.";
    if(tmp){
      const typed=box?String(box.value||''):'';
      chv.drafts[id]=typed?raw+'\n'+typed:raw;
      if(box)box.value=chv.drafts[id];
      chvPaintThread(true);
    }
    const e=chvEl('chvCErr');if(e)e.textContent=chv.cerr;
    const b=chvEl('chvSend');if(b)b.disabled=false;
    return;
  }
  // anything typed while it was on its way stays in the box
  chv.drafts[id]=tmp?String(box?box.value||'':''):chvLeftover(raw,box?box.value:raw);
  chv.pending=[];chv.cerr='';delete chv.unsure[id];
  const m=r.data&&typeof r.data==='object'&&r.data.id?r.data:null;
  if(m){
    if(!m.userId)m.userId=chvMe();
    if(!m.name)m.name=(authUser&&authUser.name)||'';
    if(!m.createdAt)m.createdAt=new Date(chvNow()).toISOString();
    if(!chv.msgs.some(x=>x.id===m.id))chv.msgs.push(m);
    c.lastMessageAt=m.createdAt;
  }
  chv.divId=null;
  chvPaintThread(false);chvScrollBottom();
  if(tmp){
    // the box was emptied when Enter was pressed and may hold the next message already: leave it alone
    const b=chvEl('chvSend');if(b)b.disabled=false;
  }else{
    chvPaintComposer();
    const i2=chvEl('chvInput');if(i2&&i2.style)i2.style.height='auto';
  }
  const i3=chvEl('chvInput');if(i3&&i3.focus&&!chvIsPhone())i3.focus();
  chvPaintList();
}

/* ===================== 7. EDIT / DELETE ===================== */
function chvEditStart(id){
  const m=chv.msgs.find(x=>x.id===id);if(!m||m.userId!==chvMe()||m.deleted)return;
  chv.editing=id;chvPaintThread(true);
  const e=chvEl('chvEdit');if(e){if(e.focus)e.focus();}
}
function chvEditCancel(){chv.editing=null;chvPaintThread(true);}
function chvEditKey(e){
  if(e.key==='Escape'){e.preventDefault();chvEditCancel();}
  else if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();chvEditSave();}
}
function chvEditSave(){ return coreOnce('chv:edit', async () => {
  const id=chv.editing;if(!id)return;
  const m=chv.msgs.find(x=>x.id===id);if(!m)return;
  const e=chvEl('chvEdit');const body=String(e?e.value:m.body||'').trim();
  if(!body&&!chvAttOf(m).length){toast('A message cannot be empty. Delete it instead.');return;}
  if(body===(m.body||'')){chvEditCancel();return;}
  const r=await chvCall('chEdit',id,body);
  if(!r.ok){toast(r.error||"The change didn't save. Try again.");return;}
  chv.editing=null;
  const i=chv.msgs.findIndex(x=>x.id===id);
  if(i>=0)chv.msgs[i]=Object.assign({},chv.msgs[i],{body,editedAt:(r.data&&r.data.editedAt)||new Date(chvNow()).toISOString()});
  chvPaintThread(true);
}, typeof document !== 'undefined' ? document.activeElement : null) }
function chvDelete(id){
  const m=chv.msgs.find(x=>x.id===id);if(!m||m.userId!==chvMe())return;
  openModal(`<div class="modal-head"><div><h3>Delete this message?</h3><p>It will show as deleted for everyone in the channel.</p></div></div>
    <div class="modal-foot"><button class="btn ghost" type="button" onclick="closeModal()">Cancel</button><button class="btn" type="button" onclick="chvDoDelete(${chvA(id)})">Delete</button></div>`);
}
function chvDoDelete(id){ return coreOnce('chv:delete:'+id, async () => {
  closeModal();
  const r=await chvCall('chDelete',id);
  if(!r.ok){toast(r.error||"The message wasn't deleted. Try again.");return;}
  const i=chv.msgs.findIndex(x=>x.id===id);
  if(i>=0){chv.msgs[i]=Object.assign({},chv.msgs[i],{deleted:true,body:'',attachments:[]});chvPaintThread(true);}
}, typeof document !== 'undefined' ? document.activeElement : null) }

/* ===================== 8. CHANNEL ADMIN (staff) ===================== */
async function chvLoadStaffList(){
  if(chv.staff)return chv.staff;
  try{
    if(chv.loadStaff){chv.staff=await chv.loadStaff();return chv.staff;}
    const {data,error}=await sb.from('profiles').select('id,name,email,role,approved');
    /* A failed lookup is not remembered: the next open asks again. It is also not
       an empty team — "No one else on the team yet" under a read that was
       refused is the same confident zero, in a modal. */
    if(error||!Array.isArray(data)){chv.staffErr="The team list didn't load, so nobody can be picked here. Close this and try again.";return [];}
    chv.staffErr='';
    chv.staff=data.filter(p=>p&&p.approved&&(p.role==='admin'||p.role==='employee')).map(p=>({id:p.id,name:p.name||p.email||'Team member'}));
  }catch(e){chv.staffErr="The team list didn't load, so nobody can be picked here. Close this and try again.";return [];}
  chv.staffErr='';
  return chv.staff;
}
async function chvNewChannel(){
  if(!chvIsStaff())return;
  const staff=(await chvLoadStaffList()).filter(p=>p.id!==chvMe());
  openModal(`<div class="modal-head"><div><h3>New channel</h3><p>A team channel. Client channels are started from the client's name in the list.</p></div></div>
    <div class="modal-body"><div class="field"><label for="chvNewName">Name</label><input id="chvNewName" maxlength="80" placeholder="For example: Sales" autocomplete="off"></div>
    <div class="field"><label>Members</label><div class="chv-pick">${staff.length?staff.map((p,i)=>`<label class="chv-check"><input type="checkbox" id="chvNm${i}" value="${esc(p.id)}"> <span>${esc(p.name)}</span></label>`).join(''):(chv.staffErr?`<span class="chv-err" role="alert">${esc(chv.staffErr)}</span>`:'<span class="muted">No one else on the team yet.</span>')}</div></div>
    <div id="chvModalErr" class="chv-err" role="alert" hidden></div></div>
    <div class="modal-foot"><button class="btn ghost" type="button" onclick="closeModal()">Cancel</button><button class="btn" type="button" onclick="chvCreate(${staff.length})">Create channel</button></div>`);
  const n=chvEl('chvNewName');if(n&&n.focus)n.focus();
}
function chvModalErr(msg){const e=chvEl('chvModalErr');if(e){e.textContent=msg;e.hidden=!msg;}}
async function chvCreate(n){
  const name=String((chvEl('chvNewName')||{}).value||'').trim();
  if(!name)return chvModalErr('Give the channel a name.');
  const ids=[];
  for(let i=0;i<n;i++){const b=chvEl('chvNm'+i);if(b&&b.checked&&b.value)ids.push(b.value);}
  if(chv.creating)return;                       // a double click must not make two channels
  chv.creating=true;
  const r=await chvCall('chCreateChannel',name,ids);
  chv.creating=false;
  if(!r.ok)return chvModalErr(r.error||"The channel wasn't created. Try again.");
  closeModal();
  await chvReload();
  const id=r.data&&(r.data.id||r.data.channelId||(typeof r.data==='string'?r.data:null));
  if(id&&chvFindCh(id))chvOpen(id);
  toast('Channel created');
}
function chvRename(){
  const c=chvFindCh(chv.cur);if(!c||!chvIsStaff())return;
  openModal(`<div class="modal-head"><div><h3>Rename channel</h3></div></div>
    <div class="modal-body"><div class="field"><label for="chvRenameName">Name</label><input id="chvRenameName" maxlength="80" value="${esc(c.name||'')}" autocomplete="off" onkeydown="if(event.key==='Enter')chvDoRename()"></div><div id="chvModalErr" class="chv-err" role="alert" hidden></div></div>
    <div class="modal-foot"><button class="btn ghost" type="button" onclick="closeModal()">Cancel</button><button class="btn" type="button" onclick="chvDoRename()">Save</button></div>`);
  const n=chvEl('chvRenameName');if(n&&n.focus)n.focus();
}
function chvDoRename(){ return coreOnce('chv:rename', async () => {
  const c=chvFindCh(chv.cur);if(!c)return;
  const name=String((chvEl('chvRenameName')||{}).value||'').trim();
  if(!name)return chvModalErr('Give the channel a name.');
  const r=await chvCall('chRename',c.id,name);
  if(!r.ok)return chvModalErr(r.error||"The name didn't change. Try again.");
  c.name=name;closeModal();chvPaintHead();chvPaintList();
}, typeof document !== 'undefined' ? document.activeElement : null) }
function chvArchive(){
  const c=chvFindCh(chv.cur);if(!c||!chvIsStaff())return;
  openModal(`<div class="modal-head"><div><h3>Archive ${esc(c.name||'this channel')}?</h3><p>It moves to Archived. People can still read it, but no one can write in it${c.kind==='client'?'. The client will no longer see it':''}.</p></div></div>
    <div class="modal-foot"><button class="btn ghost" type="button" onclick="closeModal()">Cancel</button><button class="btn" type="button" onclick="chvDoArchive()">Archive channel</button></div>`);
}
function chvDoArchive(){ return coreOnce('chv:archive', async () => {
  const c=chvFindCh(chv.cur);if(!c)return;
  const r=await chvCall('chArchive',c.id);
  closeModal();
  if(!r.ok){toast(r.error||"The channel wasn't archived. Try again.");return;}
  c.archived=true;c.unread=0;chvUpdateTotal();chvPaintAll();toast('Channel archived');
}, typeof document !== 'undefined' ? document.activeElement : null) }
async function chvMembers(){
  const c=chvFindCh(chv.cur);if(!c||!chvIsStaff())return;
  openModal(`<div class="modal-head"><div><h3>Members of ${esc(c.name||'channel')}</h3></div></div><div class="modal-body" id="chvMemBody"><div class="chv-skel"></div></div>
    <div class="modal-foot"><button class="btn" type="button" onclick="closeModal()">Done</button></div>`);
  chvPaintMembers();
}
async function chvPaintMembers(){
  const c=chvFindCh(chv.cur);const b=chvEl('chvMemBody');if(!c||!b)return;
  const [mr,staff]=await Promise.all([chvCall('chMembers',c.id),chvLoadStaffList()]);
  const b2=chvEl('chvMemBody');if(!b2)return;
  if(!mr.ok){b2.innerHTML=`<div class="chv-err" role="alert">${esc(mr.error||"The members didn't load. Try again.")}</div>`;return;}
  const mem=Array.isArray(mr.data)?mr.data:[];
  const ids={};mem.forEach(m=>{ids[m.userId||m.id]=1;});
  const addable=staff.filter(p=>!ids[p.id]);
  // A client's own people are shown, marked Client, and are not removable here (that would cut the client off).
  b2.innerHTML=`<ul class="chv-members">${mem.map(m=>{const uid=m.userId||m.id,cl=!!m.isClient||m.kind==='client';return `<li${cl?' class="client"':''}><span class="chv-av${cl?' client':''}" aria-hidden="true">${esc(chvInitial(m.name))}</span><span class="chv-mname">${esc(m.name||'Member')}</span>${cl?'<span class="chv-client-tag">Client</span>':uid===chvMe()?'<span class="muted">You</span>':`<button type="button" class="chv-link" onclick="chvRemoveMember(${chvA(uid)})">Remove</button>`}</li>`;}).join('')||'<li class="muted">No members.</li>'}</ul>
    ${!addable.length&&chv.staffErr?`<div class="chv-err" role="alert">${esc(chv.staffErr)}</div>`:''}
    ${addable.length?`<div class="field"><label for="chvAddSel">Add a team member</label><div class="chv-addrow"><select id="chvAddSel">${addable.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><button type="button" class="btn" onclick="chvAddMember()">Add</button></div></div>`:''}
    <div id="chvModalErr" class="chv-err" role="alert" hidden></div>`;
}
function chvAddMember(){ return coreOnce('chv:member', async () => {
  const c=chvFindCh(chv.cur);const sel=chvEl('chvAddSel');if(!c||!sel||!sel.value)return;
  const r=await chvCall('chAddMember',c.id,sel.value);
  if(!r.ok)return chvModalErr(r.error||"That person wasn't added. Try again.");
  chvPaintMembers();
}, typeof document !== 'undefined' ? document.activeElement : null) }
function chvRemoveMember(uid){ return coreOnce('chv:member', async () => {
  const c=chvFindCh(chv.cur);if(!c)return;
  const r=await chvCall('chRemoveMember',c.id,uid);
  if(!r.ok)return chvModalErr(r.error||"That person wasn't removed. Try again.");
  chvPaintMembers();
}, typeof document !== 'undefined' ? document.activeElement : null) }

/* ===================== 8b. THE BOT'S DRAFTS (staff, client channels) =====================
   Pending drafts for the open channel sit just above the composer: edit, Send or Discard. Nothing reaches the client
   until Send (chBotSend -> draft_send). After a client writes, the drafts are looked up again a little later, since the
   bot needs a few seconds to write. */
function chvBotOn(){const c=chvFindCh(chv.cur);return !!(c&&c.kind==='client'&&chvIsStaff()&&chvFn('chBotDrafts'));}
function chvBotClear(){
  (chv.botTimers||[]).forEach(t=>clearTimeout(t));
  chv.bot=[];chv.botEdits={};chv.botBusy={};chv.botErr='';chv.botTimers=[];chv.botSeq++;
}
function chvBotHTML(){
  if(!chvBotOn()||!chv.bot.length)return chv.botErr&&chvBotOn()?`<div class="chv-bot-err" role="alert">${esc(chv.botErr)}</div>`:'';
  return chv.bot.map(d=>{
    const busy=chv.botBusy[d.id]||'';
    const val=Object.prototype.hasOwnProperty.call(chv.botEdits,d.id)?chv.botEdits[d.id]:d.body;
    return `<div class="chv-bot-item" id="chvBot-${esc(d.id)}"><span class="chv-bot-k">Bot draft · only you can see this${d.reason?' · '+esc(d.reason):''}</span>
      <textarea id="chvBotBox-${esc(d.id)}" rows="2" aria-label="Bot draft — edit before sending" oninput="chvBotEdit(${chvA(d.id)},this.value)" onkeydown="chvBotKey(event,${chvA(d.id)})"${busy?' disabled':''}>${esc(val)}</textarea>
      <span class="chv-bot-acts"><button type="button" class="chv-btn primary" onclick="chvBotSend(${chvA(d.id)})"${busy?' disabled':''}>${busy==='send'?'Sending':'Send'}</button><button type="button" class="chv-btn" onclick="chvBotDiscard(${chvA(d.id)})"${busy?' disabled':''}>${busy==='discard'?'Discarding':'Discard'}</button></span></div>`;
  }).join('')+(chv.botErr?`<div class="chv-bot-err" role="alert">${esc(chv.botErr)}</div>`:'');
}
function chvPaintBot(){
  const e=chvEl('chvBot');if(!e)return;
  const a=typeof document!=='undefined'?document.activeElement:null;
  if(a&&a.id&&String(a.id).startsWith('chvBotBox-'))return;   // don't wipe what is being typed
  e.innerHTML=chvBotHTML();
}
async function chvBotLoad(){
  if(!chvBotOn())return;
  const id=chv.cur,seq=++chv.botSeq;
  const r=await chvCall('chBotDrafts',id);
  if(seq!==chv.botSeq||id!==chv.cur)return;
  /* A read that failed and a channel with no drafts both used to leave an empty
     strip, so a draft waiting behind a refused read looked like no draft at all.
     The thread still works without them, but the owner is told. */
  if(!r.ok||!Array.isArray(r.data)){chv.botErr=r.error||"The bot's drafts didn't load. They are still in Replies.";chvPaintBot();return;}
  chv.botErr='';
  chv.bot=r.data;
  const have={};chv.bot.forEach(d=>{have[d.id]=1;});
  Object.keys(chv.botEdits).forEach(k=>{if(!have[k])delete chv.botEdits[k];});
  chvPaintBot();
}
function chvBotSoon(){
  if(!chvBotOn()||typeof setTimeout!=='function')return;
  [6000,15000].forEach(ms=>{const t=setTimeout(chvBotLoad,ms);if(t&&t.unref)t.unref();chv.botTimers.push(t);});
}
function chvBotEdit(id,v){chv.botEdits[id]=String(v==null?'':v);}
function chvBotKey(e,id){if(e&&e.key==='Enter'&&(e.ctrlKey||e.metaKey)){if(e.preventDefault)e.preventDefault();chvBotSend(id);}}
async function chvBotSend(id){
  const d=chv.bot.find(x=>x.id===id);if(!d||chv.botBusy[id])return;
  const body=Object.prototype.hasOwnProperty.call(chv.botEdits,id)?chv.botEdits[id]:d.body;
  chv.botBusy[id]='send';chv.botErr='';chvPaintBot();
  const r=await chvCall('chBotSend',id,body);
  delete chv.botBusy[id];
  if(!r.ok){chv.botErr=r.error||"That didn't send. Try again.";chvPaintBot();return;}
  chvBotGone(id);
}
async function chvBotDiscard(id){
  const d=chv.bot.find(x=>x.id===id);if(!d||chv.botBusy[id])return;
  chv.botBusy[id]='discard';chv.botErr='';chvPaintBot();
  const r=await chvCall('chBotDiscard',id);
  delete chv.botBusy[id];
  if(!r.ok){chv.botErr=r.error||"That draft wasn't discarded. Try again.";chvPaintBot();return;}
  chvBotGone(id);
}
function chvBotGone(id){
  chv.bot=chv.bot.filter(x=>x.id!==id);delete chv.botEdits[id];
  const e=chvEl('chvBot');if(e)e.innerHTML=chvBotHTML();
  try{if(typeof dr!=='undefined'&&typeof drSetCount==='function')drSetCount(Math.max(0,(Number(dr.count)||0)-1));}catch(e2){}
}

/* ===================== 10. LIFECYCLE (called by the shell) ===================== */
/* Called by the shell's render() for every view: the Channels timer / unsubscribe, and the nav badge. */
/* WHY chvPeek IS NOT FORCED HERE ANY MORE
   render() calls this for EVERY screen the owner opens, and it used to force
   the unread count, which is one my_channels() round trip each time: a single
   walk of the hub fired it 33 times. my_channels is a security-definer rpc that
   joins every channel, its last message and its unread count for the signed-in
   person, so 33 of them is 33 of the most expensive read in the hub, for a
   number that only changes when somebody writes a message.
   It is still forced in exactly the case that needs it: coming OFF the Channels
   screen, where the owner has just read messages and the badge would otherwise
   sit there wrong for up to half a minute. Every other navigation takes the
   30-second throttle chvPeek already had, and the poll timer keeps the badge
   fresh regardless. */
function channelsOnRender(v){
  if(v==='channels'){chv.wasOpen=true;channelsStartTimer();return;}
  if(chv.unsub){try{chv.unsub();}catch(e){}chv.unsub=null;}
  chv.seq++;
  try{if(/^#channels/.test(location.hash||'')&&history.replaceState)history.replaceState(null,'',(location.pathname||'/')+(location.search||''));}catch(e){}
  channelsStartTimer();
  const leaving=!!chv.wasOpen; chv.wasOpen=false;
  chvPeek(leaving);
}
function channelsStartTimer(){
  if(chv.timer||typeof setInterval!=='function')return;
  chv.timer=setInterval(chvTick,CHV_POLL_MS);
  if(chv.timer&&chv.timer.unref)chv.timer.unref();
  // coming back to the tab checks at once instead of waiting for the next tick
  if(!chv.visHooked&&typeof document!=='undefined'&&typeof document.addEventListener==='function'){
    chv.visHooked=true;
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&chv.timer)chvTick();});
  }
}
function channelsStopTimer(){if(chv.timer){clearInterval(chv.timer);chv.timer=null;}}
async function chvTick(){
  if(typeof authUser==='undefined'||!authUser){channelsStopTimer();return;}
  if(typeof document!=='undefined'&&document.hidden)return;
  if(typeof currentView!=='undefined'&&currentView==='channels'){await chvReload();chvBotLoad();}
  else await chvPeek(true);
}
/* The unread total for the nav badge when Channels is not open. */
async function chvPeek(force){
  if(typeof authUser==='undefined'||!authUser)return;
  if(!chvFn('chUnreadTotal'))return;
  if(!force&&chvNow()-chv.peekAt<30000)return;
  chv.peekAt=chvNow();
  const r=await chvCall('chUnreadTotal');
  if(r.ok){const n=typeof r.data==='number'?r.data:Number(r.data&&r.data.total)||0;chv.unreadTotal=n;try{if(typeof renderNav==='function')renderNav();}catch(e){}}
}
/* Sign-out: drop everything. */
function channelsForget(){
  channelsStopTimer();
  if(chv.unsub){try{chv.unsub();}catch(e){}chv.unsub=null;}
  clearTimeout(chv.searchTimer);clearTimeout(chv.typingTimer);
  Object.assign(chv,{chs:[],loaded:false,err:null,loading:false,cur:null,want:null,msgs:[],hasMore:false,loadingOlder:false,msgsErr:null,msgsLoading:false,divId:null,newBelow:0,editing:null,sending:false,drafts:{},pending:[],cerr:'',unsure:{},typing:{},q:'',hits:[],pane:'list',archOpen:false,noChOpen:false,noChDone:{},urls:{},urlWait:{},staff:null,staffErr:'',unreadTotal:0,peekAt:0,wasOpen:false,creating:false,caught:'',seq:chv.seq+1});
  chvBotClear();
}
