/* ============================================================================
   messages.js — Aviance Hub · Messages, the reply bot and Google Meet
   ----------------------------------------------------------------------------
   Contract: email-distributor/docs/REPLYBOT-MEET.md (§1 the conversation, §3 Google Meet, §4 the hub).
     GET  /api/mc/hub/{id}                → … conversation {thread, needsReply, bot, canReply, fromInbox}
     POST /api/mc/clients/{id}/messages   {action:'reply', text} | {action:'botOn'} | {action:'botOff'}
                                          → {ok, conversation}
     GET  /api/mc/google                  → {status, account, redirectUri, hasClient, connectedAt}
     POST /api/mc/google                  {action:'saveClient', clientId, clientSecret} · {action:'connect'} → {url}
                                          · {action:'test'} → {ok, meetLink} · {action:'disconnect'}
     Google sends the owner back to https://aviance.store/#settings/google?connected=1 (or ?error=<code>);
     the shell's parseDeepLink reads it and calls googleReturn(). As built (REPLYBOT-MEET §3 "as built",
     HUB-API "Google Meet", GOOGLE-SETUP.md): the status also has clientFrom (saved|env), brokenAt,
     problem (plain words when broken) and encKey; test answers {ok, meetLink, removed, note?}.

   What the owner sees
     · Messages, on every trial page right under the three questions: the whole conversation as a chat
       (theirs on the left, grey; ours on the right, outlined; the reply bot's marked "Auto-reply · …";
       automatic emails folded to one line "We sent: …"), times in Sri Lanka time with US Eastern small,
       newest at the bottom and scrolled into view; a reply box and the reply-bot switch for this person.
     · Settings › Google Meet: the status in words, the set-up steps, Client ID + secret, Connect Google,
       Test it, Disconnect.
     · Settings › Reply bot: what it answers, in plain words (switching it off for everyone stays in Advanced).

   Loaded after trials.js, inquiries.js and calendar.js: reuses tk, currentTrialId, machineFetch, trialPost,
   loadTrial, loadHub, trialsRepaint, renderTrialTop, tkConv, tkThreadSorted, tkSimple, tkFirstName,
   tkOcPath, tkOcName, tkOcRepaint, tkAttr, tkSafeUrl, tkLink, tkParseDate, tkFull, tkTruthy, tkNorm,
   tkMachineUrl, renderLoading, openMachine and the shell's esc / toast / renderNav / updateNotifBadge.
   Rules as in trials.js: every machine string through esc(), links through tkSafeUrl/tkLink, ids into
   handlers only through tkAttr(); render functions never touch the DOM; nothing runs at load time.
   ========================================================================== */

/* ===================== 0. CONSTANTS + CACHE ===================== */
const MSG_MAX=2000;                    // a message to a client: plain text, 2 000 characters at most
const MSG_ZONE_LK='Asia/Colombo';      // the owner's time (big)
const MSG_ZONE_US='America/New_York';  // US Eastern (small, beside it)
/* What the reply bot did, per rule (REPLYBOT-MEET §2), in plain words. `thanks` sends nothing, so it never shows. */
const MSG_RULES={
  wants_time:'sent your booking link and free times',
  proposes_time:'pencilled in the time they asked for',
  proposes_time_ok:'pencilled in the time they asked for',
  proposes_time_busy:'that time was taken — sent free times',
  reschedule:'sent the booking page to pick another time',
  price:'explained the trial is free',
  what_needed:'sent the one-page form',
  not_interested:'said goodbye and stopped reminders',
};
/* Our automatic emails that are part of the talk (shown in full; `system` ones fold to one line). */
const MSG_AUTO_KINDS={acceptance:'Acceptance email — sent automatically',reminder:'Reminder — sent automatically',booking:'Booking email — sent automatically'};
/* Settings › Google Meet: the status in one word (pill) and one sentence. */
const GM_STATUS={
  not_set_up:{pill:'grey',word:'Not set up',tone:'grey'},
  ready_to_connect:{pill:'amber',word:'Ready to connect',tone:'amber'},
  connected:{pill:'green',word:'Connected',tone:'green'},
  broken:{pill:'red',word:'Broken',tone:'red'},
};
const GM_FRESH_MS=5*60000;             // the Google status is asked for at most every 5 minutes (not by the 60-second refresh)
/* Back from Google with ?error=<code> (the callback's codes, docs/GOOGLE-SETUP.md "If something goes wrong"),
   in plain words with what to do. Step numbers are the hub's own steps below. */
const GM_HICCUP='Google had a hiccup. Wait a minute and press Connect Google again.';
const GM_ERRORS={
  state:'That took more than 10 minutes, or the page was opened twice. Press Connect Google again.',
  denied:"Cancel was pressed on Google's page, so Google isn't connected. Press Connect Google again and choose Continue.",
  calendar_permission:"The calendar line wasn't ticked on Google's page. Press Connect Google again and tick it (or Select all).",
  exchange:"Google didn't accept your Client ID and Client secret. Paste them again (step 6), check the address in step 5, then press Connect Google again.",
  not_set_up:'Your Client ID and Client secret are not saved yet. Paste them in step 6 and press Save.',
  no_refresh_token:"Google didn't hand over a lasting connection. Press Connect Google again.",
  google_down:GM_HICCUP,google:GM_HICCUP,server:GM_HICCUP,no_code:GM_HICCUP,
};
/* The reply bot's rules in plain words, for Settings › Reply bot (read-only; the wording lives in Advanced). */
const MSG_BOT_RULES=[
  ["They ask when you're free",'sends your booking link and three free times.'],
  ['They suggest a time',"if you're free then, pencils it in and says you'll confirm (you still say yes in the Calendar); if not, sends three free times."],
  ['They need to move the call','sends the booking page so they can pick another time.'],
  ['They ask what it costs','explains the 30-day trial is free, with no card.'],
  ['They ask what to prepare','sends the one-page form.'],
  ["They're not interested",'says goodbye, stops the reminders and tells you.'],
  ['They just say thanks','nothing — no reply needed.'],
];

/* Google Meet: the last status, its error, the "you're back from Google" message and the last test. */
const msgState={g:null,gAt:0,gErr:null,gBusy:null,notice:null,test:null};

/* ===================== 1. PURE HELPERS ===================== */
const msgFmtCache={};
function msgFmt(zone,withDate){
  const k=zone+(withDate?'|d':'|t');
  if(!msgFmtCache[k])msgFmtCache[k]=new Intl.DateTimeFormat('en-US',Object.assign({timeZone:zone,weekday:'short',hour:'numeric',minute:'2-digit',hour12:true},withDate?{day:'numeric',month:'short'}:{}));
  return msgFmtCache[k];
}
function msgClock(p){return p.hour+':'+p.minute+' '+String(p.dayPeriod||'').toLowerCase()}
/* One email's time: {lk:"Fri 16 Oct, 2:30 pm" (Sri Lanka), us:"Fri 5:00 am" (US Eastern — often the day before)}. */
function msgWhen(at){
  const d=tkParseDate(at);if(!d)return null;
  const parts=f=>{const p={};f.formatToParts(d).forEach(x=>{p[x.type]=x.value;});return p};
  const a=parts(msgFmt(MSG_ZONE_LK,true)),b=parts(msgFmt(MSG_ZONE_US,false));
  return {lk:a.weekday+' '+a.day+' '+a.month+', '+msgClock(a),us:b.weekday+' '+msgClock(b)};
}
function msgIsAuto(m){return !!m&&String(m.dir)!=='in'&&(tkTruthy(m.auto)||String(m.kind||'').toLowerCase()==='auto_reply')}
function msgRuleText(rule){return MSG_RULES[String(rule||'').toLowerCase()]||''}
/* The bare address in "Sam Test <sam@ecreek.io>". */
function msgAddr(s){const m=/[^\s<>"',;:]+@[^\s<>"',;:]+\.[^\s<>"',;:]+/.exec(String(s||''));return m?m[0].toLowerCase():''}
/* Who a (non-bot) email is from, in words. Someone else from their side answering → their address. */
function msgWho(m,first,contact){
  const k=String(m.kind||'').toLowerCase();
  if(String(m.dir)==='in'){
    if(k==='booking')return 'Calendar booking';
    const f=msgAddr(m.from),c=msgAddr(contact);
    return (f&&c&&f!==c?f:(first||'They'))+' wrote';
  }
  return MSG_AUTO_KINDS[k]||'You wrote';
}
/* "Re: Re: Your call" and "Your call" are the same subject: shown once, when it changes. */
function msgSubjectKey(s){return String(s||'').replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i,'').trim().toLowerCase()}

/* ===================== 2. RENDERERS (pure: data → HTML) ===================== */
/* One email in the chat. ctx: {first, contact, subject: show the subject line}. */
function renderMsgEntry(m,ctx){
  ctx=ctx||{};const inb=String(m.dir)==='in';const k=String(m.kind||'').toLowerCase();const w=msgWhen(m.at);
  const at=w?`<span class="tk-cm-at" title="${esc(tkFull(m.at))}">${esc(w.lk)} <small>(US Eastern ${esc(w.us)})</small></span>`:'';
  // an automatic email the machine sends to every client (trial dates, reports…): one line, "show" opens it
  if(!inb&&k==='system')return `<details class="tk-cm-sys"><summary><span class="tk-cm-sys-t">We sent: ${esc(m.subject||'an automatic email')}</span><span class="tk-cm-show" aria-hidden="true"><span class="tk-cm-open">show</span><span class="tk-cm-close">hide</span></span>${at}</summary><div class="tk-cm-text">${esc(m.text||'')}</div></details>`;
  const auto=msgIsAuto(m);const rule=auto?msgRuleText(m.rule):'';
  // "Auto-reply · sent your booking link" stays one phrase when it wraps on a phone
  const head=auto?`<span class="tk-cm-who"><b>Auto-reply</b>${rule?`<span class="tk-cm-rule"> · ${esc(rule)}</span>`:''}</span>`:`<b>${esc(msgWho(m,ctx.first,ctx.contact))}</b>`;
  return `<div class="tk-cm ${inb?'in':'out'}${auto?' auto':''}"><div class="tk-cm-head">${head}${at}</div>${ctx.subject&&m.subject?`<div class="tk-cm-subj">${esc(m.subject)}</div>`:''}<div class="tk-cm-text">${esc(m.text||'')}</div></div>`;
}
/* Messages, on every trial page: the whole conversation (oldest at the top, newest at the bottom),
   a line when they are waiting for an answer, the reply box (or why there is none) and the reply-bot switch. */
function renderMessages(d,meta){
  d=d||{};const row=d.row||{};const id=row.id;const c=tkConv(d);
  const first=tkFirstName(tkSimple(row).person);const name=first||'them';
  const list=tkThreadSorted(c.thread);let last='';
  const items=list.map(m=>{
    const key=msgSubjectKey(m.subject);const sys=String(m.kind||'').toLowerCase()==='system'&&String(m.dir)!=='in';
    const show=!!key&&key!==last;if(key&&!sys)last=key;
    return renderMsgEntry(m,{first,contact:row.contactEmail,subject:show});
  }).join('');
  const chat=list.length?`<div class="tk-chat" id="tkChat" role="region" tabindex="0" aria-label="${esc('Emails with '+name+', oldest at the top')}">${items}</div>`:`<p class="tk-chat-empty">No emails with ${esc(name)} yet.</p>`;
  const wait=c.needsReply?`<p class="tk-msgs-wait">${esc(first?first+' is waiting for your answer.':'They are waiting for your answer.')}</p>`:'';
  const reply=c.canReply
    ?`<div class="tk-msgs-reply"><label for="tkMsgReply">Write to ${esc(name)}</label>
      <textarea id="tkMsgReply" data-tk-form maxlength="${MSG_MAX}" rows="4" placeholder="Type your message. Plain text, no formatting." oninput="msgCount(this)"></textarea>
      <div class="tk-msgs-foot"><span id="tkMsgCount" class="tk-msgs-count">0 / ${MSG_MAX}</span><button type="button" class="btn" onclick="msgSend(${tkAttr(id)})">Send to ${esc(name)}</button></div>
      ${c.fromInbox?`<p class="tk-msgs-from">It goes from ${esc(c.fromInbox)}, in the same email thread.</p>`:''}</div>`
    :'<p class="tk-msgs-cant">Set up the inbox in Settings to reply from here.</p>';
  let bot='';
  if(c.bot){
    const on=tkTruthy(c.bot.enabled);const sent=tkNorm(c.bot.sentToday),max=tkNorm(c.bot.maxPerDay);
    // switched on, but not answering them now (it only answers while they are onboarding): say so — never "it answers for you"
    const idle=on&&c.bot.answersNow!=null&&!tkTruthy(c.bot.answersNow);
    const why=String(c.bot.why||'').trim().replace(/\s*\([^)]*\)\s*(?=[.!]?$)/,'').replace(/[.\s]+$/,'');
    const note=idle?(why||'The reply bot only answers while they are onboarding')+'. You answer '+name+' yourself now.':on?'It answers the simple questions for you — times, price, what to prepare. Anything else waits for you.'+(sent!=null&&max!=null?' '+sent+' of '+max+' auto-replies sent today.':''):'Off: you answer every message from '+name+' yourself.';
    bot=`<div class="tk-bot"><button type="button" class="tk-switch${on?' on':''}" role="switch" aria-checked="${on}" onclick="msgBot(${tkAttr(id)},${on?'false':'true'})"><span class="tk-switch-track" aria-hidden="true"><span class="tk-switch-knob"></span></span><span class="tk-switch-text">Reply bot for ${esc(name)}: <b>${on?'On':'Off'}</b></span></button><p class="tk-bot-note">${esc(note)}</p></div>`;
  }
  // no emails yet (a new application, say): one folded line — an empty box and a reply form would push what matters down a phone
  if(!list.length&&!c.needsReply)return `<section class="card tk-msgs tk-msgs-none" id="tkSec-messages"><details class="tk-msgs-fold"><summary><span class="tk-msgs-foldt">Messages</span><span class="tk-msgs-sub">${esc('No emails with '+name+' yet')}</span></summary>
    ${reply}${bot}</details></section>`;
  return `<section class="card tk-msgs" id="tkSec-messages">
    <div class="tk-msgs-head"><h3>Messages</h3><span class="tk-msgs-sub">${esc('Every email between you and '+name+'. The newest is at the bottom.')}</span></div>
    ${chat}${wait}${reply}${bot}
  </section>`;
}

/* -- Settings › Google Meet -- g = googleSettingsCtx(): {data (GET /api/mc/google), err, notice, test} → {state, body}. */
function googleErrorText(e){
  const s=String(e==null?'':e).trim();const k=s.toLowerCase();
  if(Object.prototype.hasOwnProperty.call(GM_ERRORS,k))return GM_ERRORS[k];
  if(/denied|cancel/.test(k))return GM_ERRORS.denied;
  return "Google didn't connect. Press Connect Google to try again."+(s?' (For your developer: '+s+'.)':'');
}
function renderGoogleNotice(n){
  if(!n)return '';
  if(n.kind==='connected')return '<p class="tk-status green">Google is connected. From now on every call you say yes to gets its own Google Meet link.</p>';
  return `<p class="tk-status red">${esc(googleErrorText(n.error))}</p>`;
}
/* The set-up, for an owner who has never opened Google Cloud: numbered, one thing per step, the address to copy. */
function renderGoogleSteps(uri,data){
  data=data||{};const saved=tkTruthy(data.hasClient);
  const env=String(data.clientFrom||'')==='env';const noLock=data.encKey===false;
  // set on the server by the developer: nothing to paste (saving would be refused)
  const paste=env?'<p class="tk-gm-saved">Your Client ID and secret were set up by your developer, so there is nothing to paste here.</p>'
    :`${noLock?'<p class="tk-gm-lock">They can\'t be saved yet: the password lock isn\'t set up. (For your developer: ENC_KEY.)</p>':''}
      <div class="tk-gm-form">
        <div class="field"><label for="gmClientId">Client ID</label><input id="gmClientId" data-tk-form autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="…apps.googleusercontent.com"></div>
        <div class="field"><label for="gmClientSecret">Client secret</label><input id="gmClientSecret" data-tk-form type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="GOCSPX-…"></div>
        <button type="button" class="btn" onclick="googleSave()">Save</button>
      </div>`;
  return `<ol class="tk-gm-steps">
    <li><b>Make a Google Cloud project.</b> Open ${tkLink('https://console.cloud.google.com/projectcreate','Google Cloud')} and sign in with the Google account whose calendar you use for calls. Name the project “Aviance” and press Create.</li>
    <li><b>Turn on the Google Calendar API.</b> Open ${tkLink('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com','Google Calendar API')}, check that your Aviance project is picked at the top, and press Enable.</li>
    <li><b>Set up the consent screen.</b> Open ${tkLink('https://console.cloud.google.com/apis/credentials/consent','the consent screen')} (Google may call it “Google Auth Platform”) and press Get started. App name: Aviance. Use your own email for the support and contact emails. Audience: <b>External</b>. Add your own email as the only test user. Then press <b>Publish app</b> and confirm — otherwise Google stops the connection after 7 days.</li>
    <li><b>Make the key for the hub.</b> Open ${tkLink('https://console.cloud.google.com/apis/credentials','Credentials')} and press Create credentials › OAuth client ID (on newer screens: Clients › Create client). Application type: <b>Web application</b>. Name: Aviance Hub.</li>
    <li><b>Paste this address</b> under “Authorised redirect URIs” (press Add URI first) — exactly as it is, no space, nothing added at the end — then press Create.
      <div class="tk-gm-copy"><input id="gmRedirect" class="tk-gm-uri" readonly value="${esc(uri)}" aria-label="The address to paste into Google" onfocus="this.select()"><button type="button" class="btn ghost" onclick="googleCopyRedirect()">Copy</button></div></li>
    <li><b>Copy the Client ID and the Client secret</b> that Google shows (copy the secret straight away — Google may not show it again), paste them here and press Save.${saved&&!env?'<span class="tk-gm-saved">Yours are saved (hidden). Paste new ones only if you made a new client.</span>':''}
      ${paste}</li>
    <li><b>Press Connect Google</b> and pick the same account. If Google says the app isn't verified, that's expected for your own app: press Advanced, then Go to Aviance. Make sure the calendar line is ticked, then press Continue.</li>
    <li><b>Press Test it.</b> When you see a Google Meet link, you're done.</li>
  </ol>`;
}
function renderGoogleMeetSet(g){
  g=g||{};const data=g.data&&typeof g.data==='object'?g.data:null;
  const S=data?GM_STATUS[String(data.status||'')]||null:null;
  const state=S?`<span class="pill ${S.pill}">${esc(S.word)}</span>`:'';
  const notice=renderGoogleNotice(g.notice);
  if(!data)return {state,body:notice+(g.err?`<p class="tk-note red">${esc(g.err)} <button type="button" class="tk-textbtn" onclick="googleRetry()">Try again</button></p>`:renderLoading('Checking Google…'))};
  const st=String(data.status||'');const acct=String(data.account||'');
  const say={
    not_set_up:'Not set up yet. Do the steps below once — about 15 minutes, easiest on a computer. After that, every call you say yes to gets its own Google Meet link.',
    ready_to_connect:'Ready to connect. Your Google details are saved — press Connect Google, then Allow.',
    connected:'Connected'+(acct?' as '+acct:'')+'. Every call you say yes to gets its own Google Meet link and goes on your Google Calendar.',
    broken:'Broken — connect again'+(data.problem?': '+String(data.problem).replace(/[.\s]+$/,''):'. Google stopped the connection')+'. Press Connect Google and allow it again. Until then, calls go out without a Meet link.',
  }[st]||"We couldn't tell whether Google is connected.";
  const tone=S?S.tone:'grey';
  const t=g.test;
  const test=t?(t.ok?`<p class="tk-status green">It works. Google made a test Meet link${tkSafeUrl(t.meetLink)?' ('+tkLink(t.meetLink)+')':''}${t.removed===false?esc(" but couldn't take the test event off your calendar"+(t.note?' ('+String(t.note).replace(/[.\s]+$/,'')+')':'')+' — delete it there by hand.'):' and took it off your calendar again.'}</p>`:`<p class="tk-status red">${esc("The test didn't work: "+(t.error||'no answer'))}</p>`):'';
  const btn=(fn,label,ghost)=>`<button type="button" class="btn${ghost?' ghost':''}" onclick="${fn}()">${esc(label)}</button>`;
  const acts=[];
  if(st==='ready_to_connect'||st==='broken')acts.push(btn('googleConnect','Connect Google'));
  if(st==='connected')acts.push(btn('googleTest','Test it'));
  if(st==='connected'||st==='broken')acts.push(btn('googleDisconnect','Disconnect',true));
  const uri=String(data.redirectUri||'')||tkMachineUrl()+'/api/google/callback';
  const steps=renderGoogleSteps(uri,data);
  const setup=st==='not_set_up'?steps:`<details class="tk-gm-more"><summary>The set-up steps, and changing your Google details</summary>${steps}</details>`;
  return {state,body:`${notice}<p class="tk-status ${tone}">${esc(say)}</p>${test}${acts.length?`<div class="tk-set-links tk-gm-acts">${acts.join('')}</div>`:''}${setup}`};
}

/* -- Settings › Reply bot -- read-only, in plain words. There is no switch for everyone in the contract, so it
   says where that lives (Advanced); if the system ever sends replyBot {enabled} on the board, its state shows. */
function renderReplyBotSet(ctx){
  ctx=ctx||{};const hub=ctx.hub||null;
  const rb=hub&&((hub.machine&&hub.machine.replyBot)||hub.replyBot);
  const known=!!(rb&&typeof rb==='object'&&rb.enabled!=null);const on=known&&tkTruthy(rb.enabled);
  let max=known?tkNorm(rb.maxPerDay):null;
  if(max==null){const ds=ctx.details||{};for(const k of Object.keys(ds)){const b=ds[k]&&ds[k].conversation&&ds[k].conversation.bot;if(b&&tkNorm(b.maxPerDay)!=null){max=tkNorm(b.maxPerDay);break;}}}
  const state=known?`<span class="pill ${on?'green':'grey'}">${on?'On':'Off'}</span>`:'';
  const body=`${known?`<p class="tk-status ${on?'green':'grey'}">${on?'On for everyone.':'Off for everyone: nobody gets an auto-reply.'}</p>`:''}
    <p class="tk-set-text">When someone writes back, the reply bot answers the simple things for you with fixed answers (no AI). Anything else waits for you, and you get an alert.</p>
    <h4 class="tk-set-h4">What it answers</h4>
    <ul class="tk-bot-rules">${MSG_BOT_RULES.map(([a,b])=>`<li><b>${esc(a)}</b> — ${esc(b)}</li>`).join('')}</ul>
    <h4 class="tk-set-h4">What it never does</h4>
    <p class="tk-set-text">${esc('It never answers automatic emails (out of office, bounces), a message you already answered, or a message older than 3 days. It sends '+(max!=null?'at most '+max+' emails':'only a few emails')+' a day to one person, and it waits a few minutes first, so you can answer yourself. It never makes up a price.')}</p>
    <p class="tk-set-text">To turn it off for one person, use the switch under Messages on their trial page. To turn it off for everyone, or change what it says, open Advanced settings.</p>
    <button type="button" class="btn ghost" onclick="openMachine(${tkAttr('/mc/config')})">Advanced settings ↗</button>`;
  return {state,body};
}

/* ===================== 3. LOADERS ===================== */
async function loadGoogle(force){
  if(!force&&msgState.g&&Date.now()-msgState.gAt<GM_FRESH_MS)return {ok:true,data:msgState.g};
  if(msgState.gBusy)return msgState.gBusy;
  const p=machineFetch('/api/mc/google').then(r=>{
    msgState.gBusy=null;
    if(r.ok&&r.data&&typeof r.data==='object'&&r.data.status){msgState.g=r.data;msgState.gAt=Date.now();msgState.gErr=null;}
    else{msgState.gErr=r.error||"We couldn't check Google. Try again. (For your developer: no \"status\" in the answer.)";if(r.ok)r.ok=false;}
    return r;
  });
  msgState.gBusy=p;return p;
}
function googleSettingsCtx(){return {data:msgState.g,err:msgState.gErr,notice:msgState.notice,test:msgState.test}}

/* ===================== 4. ACTIONS ===================== */
/* -- Messages -- */
function msgPath(id){return '/api/mc/clients/'+encodeURIComponent(id)+'/messages'}
function msgCount(el){const c=document.getElementById('tkMsgCount');const n=String((el&&el.value)||'').length;if(c){c.textContent=n+' / '+MSG_MAX;c.classList.toggle('over',n>MSG_MAX);}}
/* The newest email in view: the chat box scrolls to its bottom (the page itself stays where it is). */
function msgScrollDown(){try{const b=document.getElementById('tkChat');if(b&&b.scrollHeight!=null)b.scrollTop=b.scrollHeight;}catch(e){}}
/* Redraw Messages and the three questions (the big button follows needsReply) from the cache, at once. */
function msgRepaint(id){
  if(currentView!=='trial'||currentTrialId!==id)return;const d=tk.detail[id];if(!d)return;
  const host=document.getElementById('tkMsgHost');if(host)host.innerHTML=renderMessages(d,{});
  const top=document.getElementById('tkTop');if(top)top.outerHTML=renderTrialTop(d,{now:new Date()});
  if(d.onboardCall&&typeof d.onboardCall==='object')tkOcRepaint(id);
  msgScrollDown();
}
/* Post to the conversation: Messages is redrawn from the answer at once, the rest of the page and the list
   refresh quietly behind it. An older system without `conversation` takes a reply through the onboarding
   call's own reply (the same email thread). A failure keeps what was typed. */
async function msgPost(id,body,opts){
  opts=opts||{};const d=tk.detail[id]||{};
  const legacy=body.action==='reply'&&!(d.conversation&&typeof d.conversation==='object')&&!!(d.onboardCall&&typeof d.onboardCall==='object');
  const r=await trialPost(legacy?tkOcPath(id):msgPath(id),body,{done:opts.done,fail:opts.fail||'That did not work',reload:false});
  if(r&&r.ok){
    const data=r.data||{};const cur=tk.detail[id];
    if(cur){const patch={};if(data.conversation&&typeof data.conversation==='object')patch.conversation=data.conversation;if(data.onboardCall&&typeof data.onboardCall==='object')patch.onboardCall=data.onboardCall;tk.detail[id]=Object.assign({},cur,patch);}
    msgRepaint(id);
    Promise.all([loadTrial(id,true),loadHub(true)]).then(()=>{trialsRepaint('trial',{soft:true});try{renderNav();updateNotifBadge();}catch(e){}});
  }
  return r;
}
function msgSend(id){
  const t=document.getElementById('tkMsgReply');const text=String((t&&t.value)||'').trim();
  if(!text){toast('Write your message first');return Promise.resolve({ok:false});}
  if(text.length>MSG_MAX){toast('That is too long — '+MSG_MAX+' characters at most (yours is '+text.length+')');return Promise.resolve({ok:false});}
  return msgPost(id,{action:'reply',text},{done:'Sent to '+tkOcName(id),fail:'Not sent'});
}
function msgBot(id,on){
  on=on===true||on==='true';const n=tkOcName(id);
  return msgPost(id,{action:on?'botOn':'botOff'},{done:on?'Reply bot is on for '+n:'Reply bot is off for '+n+' — you answer every message yourself',fail:'Not changed'});
}

/* -- Settings › Google Meet -- */
/* Back from Google (#settings/google?connected=1 or ?error=…): the message shows at the top of the section. */
function googleReturn(kind,error){msgState.notice={kind:kind==='connected'?'connected':'error',error:String(error==null?'':error).slice(0,200)};msgState.gAt=0;msgState.test=null;}
function googleRetry(){return loadGoogle(true).then(()=>trialsRepaint('settings'))}
async function googlePost(body,opts){
  opts=opts||{};msgState.notice=null;tk.setOpen.google=true;
  return trialPost('/api/mc/google',body,{confirm:opts.confirm||'',done:opts.done,fail:opts.fail||'That did not work',reload:false});
}
async function googleAfter(){await loadGoogle(true);trialsRepaint('settings');}
function googleCopyRedirect(){
  const i=document.getElementById('gmRedirect');const v=String((i&&i.value)||'');if(!v)return;
  const byHand=()=>{try{i.focus();i.select();}catch(e){}toast("Couldn't copy — the address is selected, copy it by hand");};
  try{navigator.clipboard.writeText(v).then(()=>toast('Address copied — paste it into Google'),byHand);}catch(e){byHand();}
}
async function googleSave(){
  const g=x=>String(((document.getElementById(x)||{}).value)||'').trim();
  const clientId=g('gmClientId'),clientSecret=g('gmClientSecret');
  if(!clientId){toast('Paste the Client ID first');return {ok:false};}
  if(!clientSecret){toast('Paste the Client secret first');return {ok:false};}
  if(!/\.apps\.googleusercontent\.com$/i.test(clientId)){toast("That isn't the Client ID — it ends in .apps.googleusercontent.com. Copy it again from Google.");return {ok:false};}
  const r=await googlePost({action:'saveClient',clientId,clientSecret},{done:'Saved. Now press Connect Google.',fail:'Not saved'});
  if(r&&r.ok){msgState.test=null;await googleAfter();}
  return r;
}
/* Only Google's own sign-in page is opened (https, *.google.com). */
function googleSafeUrl(u){
  const s=tkSafeUrl(u);if(!s||!/^https:\/\//i.test(s))return '';
  let h='';try{h=new URL(s).hostname.toLowerCase();}catch(e){return '';}
  return h==='google.com'||h.endsWith('.google.com')?s:'';
}
async function googleConnect(){
  const r=await googlePost({action:'connect'},{done:'Opening Google…',fail:"Couldn't start the connection"});
  if(!(r&&r.ok))return r;
  const url=googleSafeUrl(r.data&&r.data.url);
  if(!url){toast("Google's sign-in address looked wrong, so we didn't open it. Try again.");return {ok:false,error:'bad url'};}
  try{location.href=url;}catch(e){}
  return r;
}
async function googleTest(){
  const r=await googlePost({action:'test'},{done:d=>d&&tkSafeUrl(d.meetLink)?'It works — Google made a test Meet link':'Test finished',fail:"The test didn't work"});
  if(r&&(r.cancelled||r.busy))return r;
  const d=(r&&r.data)||{};
  msgState.test=r&&r.ok?{ok:true,meetLink:String(d.meetLink||''),removed:d.removed===false?false:true,note:d.note?String(d.note):''}:{ok:false,error:(r&&r.error)||'no answer'};
  await googleAfter();   // a failed test can mean the connection broke: show the fresh status with it
  return r;
}
async function googleDisconnect(){
  const r=await googlePost({action:'disconnect'},{confirm:"Disconnect Google? Calls you say yes to won't get a Google Meet link until you connect again.",done:'Google is disconnected',fail:'Not disconnected'});
  if(r&&r.ok){msgState.test=null;await googleAfter();}
  return r;
}

/* ===================== 5. SHELL INTEGRATION ===================== */
function messagesForget(){Object.assign(msgState,{g:null,gAt:0,gErr:null,gBusy:null,notice:null,test:null});}
