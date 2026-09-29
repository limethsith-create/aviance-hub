/* ============================================================================
   ava.js — Ava, the hub's own helper (voice + typing)
   ----------------------------------------------------------------------------
   Ava (from AVIance) listens, answers out loud and takes you to the right page.
   Free: no key, no paid service. Loaded last by index.html (after people.js),
   so it can read everything the hub already knows:
     tk (trials.js: the board tk.hub, each client's page tk.detail, My stats tk.outreach),
     cal (calendar.js), tm (people.js: the team), authUser + hubIsOwner() (the shell).

     Ears   — hold Space (anywhere but a text box) or hold the mic, talk, let go: sent. The browser's SpeechRecognition
              gives the live words (Chrome/Edge/Safari; Chrome uses Google for it); when the machine has POST
              /api/mc/ava/hear, a short recording gives sharper words. A tap on the mic listens until you stop talking.
              Typing always works. Hands-free: after she answers she listens again ("stop" / "thanks Ava" ends it).
     Mouth  — the browser's best voice at once; a natural voice made on the device (Kokoro, kokoro-js, in a Web Worker —
              ava-voice-worker.js) takes over once it has downloaded. Said sentence by sentence — while the answer is still
              streaming in — at the speed picked (0.9–1.2); Space, Esc or a mic tap stops her at once.
     Brain  — AI first: every question goes to the machine's AI (POST /api/mc/ava/chat, streamed as server-sent events,
              or plain JSON) with the page, the person and the last 16 turns — except a plain command ("open trials",
              "open Lakeview", "go back", "settings"), which avaThink runs here at once. avaThink (local rules over the
              loaded data + the written guide AVA_KB) is the fallback when the AI can't answer, and then she says plainly
              that she is in basic mode, and what to do. Settings › Ava shows it all.
     Panel  — calm, light markdown answers (hub links are buttons), Copy, follow-up chips, New chat; the conversation is
              kept for the tab (sessionStorage).

   Roles: a team member (read-only, body.ro) never hears money and gets no action that changes
   anything. The owner's actions (open the add-a-client form, give access, the test run) always
   ask first ("Yes, do it") and only ever OPEN the place — Ava never sends an email or says
   yes/no to an applicant by herself.

   Every name here starts with "ava" / "AVA" (one global script with the others).
   ========================================================================== */

/* ===================== 0. STATE ===================== */
const AVA={open:false,listening:false,rec:null,log:[],acts:[],pending:null,greeted:false,muted:null,busy:false,interim:'',mounted:false,voice:null,lastClient:null,
  speaking:false,say:null,gen:0,src:null,ac:null,voicePref:null,handsFree:null,loopPaused:false,retried:0,micGuided:false,cardList:[],
  k:{state:'idle',worker:null,device:null,dtype:null,loaded:0,total:0,rtf:null,err:null},   // the natural voice (Kokoro, in ava-voice-worker.js)
  speed:null,big:null,ptt:null,ptting:false,stage:null,recall:null,links:[],cap:null,naturalNote:false,
  st:{data:null,at:0,err:null,missing:false},reqs:{data:null,at:0,err:null,missing:false},test:{busy:false,result:null,err:null},
  facts:{text:null,at:0,err:null,missing:false,busy:false,saved:null}};   // Settings › Ava
const AVA_MUTE_KEY='avianceAvaMute:v1';
const AVA_MAX_LOG=40;

/* ===================== 1. WORDS: normalise, synonyms, fuzzy match ===================== */
/* Spoken and typed words that mean the same thing → one word (applied after lower-casing). */
const AVA_SYN=[
  [/\be-?mails?\b|\bmails\b/g,'emails'],[/\bcalender\b|\bschedule\b|\bagenda\b/g,'calendar'],
  [/\bwhat's\b|\bwhats\b/g,'what is'],[/\bwho's\b|\bwhos\b/g,'who is'],[/\bhow's\b/g,'how is'],[/\bthere's\b/g,'there is'],
  [/\bwarm(?:ing)?[- ]?up\b|\bwarmup\b/g,'warmup'],[/\bset(?:ting)?[- ]up\b|\bsetup\b/g,'setup'],
  [/\bi've\b/g,'i have'],[/\bdidn't\b|\bdidnt\b/g,'did not'],[/\bdon't\b|\bdont\b/g,'do not'],[/\bcan't\b|\bcant\b/g,'cannot'],
  [/\btrial clients?\b/g,'trials'],[/\bpaid clients?\b|\bpaying customers?\b/g,'paying'],
  [/\btele?phone\b/g,'phone'],[/\bpeople inside\b/g,'activity'],[/\bmy statistics\b/g,'my stats'],
  [/\bgoogle meets?\b/g,'meet'],[/\bgmail\b/g,'gmail'],[/\bconvos?\b/g,'conversations'],
];
function avaNorm(s){
  s=String(s==null?'':s).toLowerCase().replace(/[‘’]/g,"'").replace(/[“”]/g,'"');
  AVA_SYN.forEach(([re,to])=>{s=s.replace(re,to);});
  return s.replace(/'s\b/g,'').replace(/[^a-z0-9$%\s-]/g,' ').replace(/-/g,' ').replace(/\s+/g,' ').trim();
}
const AVA_STOP=new Set('a an the to of for in on at is are am be do does did i me my we our you your it its this that and or please can could would will should with about what how why when where who which there any some tell show give get let know need needs want'.split(' '));
function avaStem(w){if(w.length>5&&w.endsWith('ing'))return w.slice(0,-3);if(w.length>4&&w.endsWith('ed'))return w.slice(0,-2);if(w.length>3&&w.endsWith('es')&&!w.endsWith('ses'))return w.slice(0,-2);if(w.length>3&&w.endsWith('s')&&!w.endsWith('ss'))return w.slice(0,-1);return w}
function avaTokens(s,keepStop){return avaNorm(s).split(' ').filter(w=>w&&(keepStop||!AVA_STOP.has(w))).map(avaStem)}
/* Edit distance (Levenshtein), stopped early past `max`. */
function avaLev(a,b,max){
  a=String(a);b=String(b);if(a===b)return 0;if(max==null)max=99;if(Math.abs(a.length-b.length)>max)return max+1;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){const cur=[i];let best=i;for(let j=1;j<=b.length;j++){cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));if(cur[j]<best)best=cur[j];}if(best>max)return max+1;prev=cur;}
  return prev[b.length];
}
function avaHas(t,re){return re.test(t)}

/* ===================== 2. WHAT THE HUB KNOWS ===================== */
function avaOwner(){return typeof hubIsOwner==='function'&&hubIsOwner()}
function avaFirst(n){n=String(n||'').trim();return n?n.split(/\s+/)[0]:''}
function avaCtx(){
  const u=typeof authUser!=='undefined'&&authUser?authUser:null;
  return {owner:avaOwner(),signedIn:!!u,name:u?avaFirst(u.name):'',view:typeof currentView!=='undefined'?currentView:'',clientId:typeof currentTrialId!=='undefined'?currentTrialId:null,
    now:typeof calNow==='function'?calNow():new Date()};
}
function avaHub(){return typeof tk!=='undefined'&&tk&&tk.hub?tk.hub:null}
/* Every client the hub knows (trials and paying, not your own outreach): {id, name, person, row}. */
function avaClients(){
  const out=[],seen={};const own=id=>id==='aviance'||id==='_test'||(typeof MY_STATS_ID!=='undefined'&&id===MY_STATS_ID);
  const add=r=>{if(!r||r.id==null||own(r.id)||seen[r.id])return;seen[r.id]=1;const s=typeof tkSimple==='function'?tkSimple(r):{company:r.name,person:r.contactName};out.push({id:String(r.id),name:String(s.company||r.name||r.id),person:String(s.person||''),row:r});};
  const hub=avaHub();if(hub&&typeof tkListRows==='function')tkListRows(hub).forEach(add);
  if(typeof tk!=='undefined'&&tk&&tk.detail)Object.keys(tk.detail).forEach(k=>{const d=tk.detail[k];if(d&&d.row)add(d.row);});
  return out;
}
/* Words in a company name that say nothing on their own ("Acme Plumbing" is found by "Acme", never by "plumbing"). */
const AVA_GENERIC=new Set('it inc llc ltd co company group the and of dental plumbing roofing legal law hvac clinic services service solutions systems tech media marketing studio partners consulting health care home homes real estate construction electric electrical auto insurance agency'.split(' '));
/* The client a sentence talks about: the whole name, or its own first word, said or typed a little wrong
   ("lake view", "lakevew", "Lakeview's") — the best match or null. */
function avaFindClient(text,clients){
  clients=clients||avaClients();const t=avaNorm(text);if(!t||!clients.length)return null;
  const words=t.split(' ');let best=null;
  const consider=(c,score)=>{if(!best||score>best.score)best={client:c,score};};
  clients.forEach(c=>{
    const full=avaNorm(c.name);const cands=[[full,3]];
    const fw=full.split(' ');if(fw.length>1&&fw[0].length>=4&&!AVA_GENERIC.has(fw[0]))cands.push([fw[0],2]);
    const idw=avaNorm(String(c.id).replace(/[-_]/g,' '));if(idw&&idw!==full)cands.push([idw,2]);
    if(c.person&&c.person.split(' ').length>1)cands.push([avaNorm(c.person),1.5]);
    cands.forEach(([cand,w])=>{
      if(!cand||cand.length<3)return;
      if((' '+t+' ').includes(' '+cand+' ')){consider(c,w*10+cand.length);return;}
      const n=cand.split(' ').length;const flat=cand.replace(/ /g,'');
      for(let k=Math.max(1,n-1);k<=n+1;k++)for(let i=0;i+k<=words.length;i++){
        const g=words.slice(i,i+k).join('');if(g.length<4||g[0]!==flat[0])continue;
        const max=flat.length>=9?2:flat.length>=6?1:0;const d=avaLev(g,flat,max);
        if(d<=max)consider(c,w*10+cand.length-d*4-1);
      }
    });
  });
  return best?best.client:null;
}
function avaFive(c){
  const r=(c&&c.row)||{};const f=r.five||{};const d=typeof tk!=='undefined'&&tk&&tk.detail?tk.detail[c.id]:null;const k=(d&&d.counters)||{};
  const n=x=>x==null||x===''||isNaN(Number(x))?null:Number(x);
  const pick=key=>{const a=n(f[key]),b=n(k[key]);return a==null?b:b==null?a:Math.max(a,b)};
  return {sent:pick('sent'),replies:pick('replies'),positive:pick('positive'),booked:pick('booked'),qualified:pick('qualified'),bounces:n(k.bounces)};
}
function avaNum(n){return Number(n||0).toLocaleString('en-US')}
function avaPlural(n,one,many){return avaNum(n)+' '+(Number(n)===1?one:(many||one+'s'))}
function avaList(xs){xs=xs.filter(Boolean);if(xs.length<=1)return xs.join('');return xs.slice(0,-1).join(', ')+' and '+xs[xs.length-1]}
function avaSentence(s){s=String(s||'').trim().replace(/\s+/g,' ');if(!s)return '';s=s.charAt(0).toUpperCase()+s.slice(1);return /[.!?]$/.test(s)?s:s+'.'}
function avaStepLine(row){
  if(typeof tkStep!=='function')return '';const j=tkStep(row);if(j.notTaken)return 'not taken';if(!j.n)return '';
  return 'step '+j.n+' of 5, '+j.name.toLowerCase()+(j.day!=null?', day '+j.day+' of 30':'');
}

/* ===================== 3. PLACES AND ACTIONS ===================== */
/* An action is {label, run, owner?}. Navigation runs at once (auto); anything that changes something asks first. */
function avaAct(label,run,extra){return Object.assign({label,run},extra||{})}
const AVA_PLACES=[
  // [key, words that name it, label, run, owner only]
  ['trials',/\btrials?\b(?! run)|\btrial list\b/,'Trials',()=>render('trials')],
  ['paying',/\bpaying\b|\bpaid plans?\b/,'Paying clients',()=>render('paying')],
  ['calendar',/\bcalendar\b/,'Calendar',()=>render('calendar')],
  ['team',/\bteam\b/,'Team',()=>render('team')],
  ['mystats',/\bmy stats\b|\bmy outreach\b|\bstats\b/,'My stats',()=>openMyStats()],
  ['activity',/\bactivity\b|\bwho signed in\b/,'Activity',()=>render('people'),true],
  ['inquiries',/\binquir(y|ies)\b|\bplan call requests?\b/,'Plan call requests',()=>render('inquiries')],
  ['behind',/\bbehind the scenes\b|\bboard\b/,'Behind the scenes',()=>render('trialsBoard')],
  ['set-demo',/\btest run\b|\bdemo\b/,'Settings › Test run',()=>openSettings('demo'),true],
  ['set-warmup',/\bwarmup\b|\bhelpers?\b/,'Settings › Warm-up',()=>openSettings('warmup'),true],
  ['set-ava',/\bava settings\b|\bsettings (for )?ava\b|\bava'?s? (brain|voice|requests)\b|\byour (brain|voice) settings\b/,'Settings › Ava',()=>openSettings('ava'),true],
  ['set-keys',/\bkeys?\b/,'Settings › Keys',()=>openSettings('keys'),true],
  ['set-details',/\byour details\b|\bmy details\b/,'Settings › Your details',()=>openSettings('details'),true],
  ['set-google',/\bmeet\b/,'Settings › Google Meet',()=>openSettings('google'),true],
  ['set-replybot',/\breply bot\b|\bauto ?reply\b/,'Settings › Reply bot',()=>openSettings('replybot'),true],
  ['set-inboxes',/\bcheapinboxes\b|\binboxes (and|&) domains\b/,'Settings › Inboxes & domains',()=>openSettings('inboxes'),true],
  ['set-phone',/\bphone alerts?\b|\bnotifications\b/,'Phone alerts',()=>openPhoneAlerts(),true],
  ['set-alerts',/\balerts?\b/,'Settings › Alerts',()=>openSettings('alerts'),true],
  ['set-status',/\beverything running\b|\bhealth check\b|\bsystem status\b/,'Settings › Is everything running?',()=>openSettings('status'),true],
  ['set-advanced',/\badvanced( settings)?\b/,'Settings › Advanced',()=>openSettings('advanced'),true],
  ['set-look',/\blight or dark\b|\bdark mode\b|\blight mode\b|\btheme\b|\bappearance\b/,'Settings › Light or dark',()=>openSettings('look'),true],
  ['set-account',/\b(my|your) account\b|\baccount settings\b|\bpassword\b/,'Settings › Your account',()=>openSettings('account'),true],
  ['settings',/\bsettings\b/,'Settings',()=>render('settings'),true],
];
function avaPlace(key){const p=AVA_PLACES.find(x=>x[0]===key);return p?avaAct('Open '+p[2],p[3],{owner:!!p[4],place:key}):null}
/* What she says once a place is open: short ("Here's the Calendar", "Here's Keys in Settings"). */
const AVA_HERE={trials:'Here are your trials',paying:'Here are your paying clients',calendar:"Here's your calendar",team:"Here's the team",mystats:'Here are your stats',
  activity:"Here's who signed in",inquiries:'Here are the plan call requests',behind:"Here's behind the scenes",settings:"Here's Settings",'set-phone':"Here's phone alerts"};
function avaHere(key){
  if(AVA_HERE[key])return AVA_HERE[key]+'.';
  const p=AVA_PLACES.find(x=>x[0]===key);if(!p)return 'Here it is.';
  const bits=String(p[2]).split(' › ');return bits.length>1?"Here's "+bits[1]+' in Settings.':"Here's "+p[2]+'.';
}
/* A client's email system, at one tab. The tab names the owner hears → the keys the hub may use for them; the
   first one this hub knows wins (Overview when none does). Money is the owner's only; the team sees the rest of
   "Only you" (Health, Leads, Setup) as the hub shows it to them. tkOpenSystem switches Shared / Only you by the tab. */
const AVA_TABS={
  overview:{words:/\boverview\b|\bnumbers\b|\bstats\b|\bdashboard\b/,keys:['overview'],label:'Overview'},
  conversations:{words:/\bconversations?\b|\breplies\b|\bthreads?\b/,keys:['conversations'],label:'Conversations'},
  emails:{words:/\bemails sent\b|\bsent emails\b|\bemails\b/,keys:['emails','sent'],label:'Emails sent'},
  messages:{words:/\bmessages?\b|\bchat\b/,keys:['messages'],label:'Messages'},
  calls:{words:/\bcalls?\b|\bmeetings?\b/,keys:['calls'],label:'Calls'},
  money:{words:/\bmoney\b|\binvoices?\b|\bpaid\b|\bpayments?\b/,keys:['money','overview'],label:'Money',owner:true,section:'money'},
  health:{words:/\bhealth\b|\bdeliverability\b|\bbounces?\b|\bspam\b/,keys:['health','deliverability'],label:'Health'},
  leads:{words:/\bleads?\b|\blist\b/,keys:['leads'],label:'Leads'},
  setup:{words:/\bsetup\b|\bdomain\b|\binboxes\b|\baccess\b/,keys:['setup'],label:'Setup'},
  history:{words:/\bhistory\b|\btimeline\b|\blog\b/,keys:['history','timeline','setup'],label:'History'},
};
function avaTabKey(id,want){
  const spec=AVA_TABS[want];if(!spec)return 'overview';
  const d=typeof tk!=='undefined'&&tk&&tk.detail?tk.detail[id]:null;
  const known=typeof tkSysTabs==='function'?tkSysTabs(d||null).map(t=>t[0]):[];
  const norm=k=>typeof tkTabKey==='function'?tkTabKey(k):k;
  for(const k of spec.keys){if(known.includes(k))return k;if(known.includes(norm(k)))return norm(k);}
  return 'overview';
}
function avaOpenTab(id,want){const spec=AVA_TABS[want]||{};const tab=avaTabKey(id,want);if(typeof tkOpenSystem==='function')tkOpenSystem(id,tab,spec.section&&tab==='overview'?spec.section:undefined);else openTrial(id);return tab}
function avaWantTab(t){for(const k of Object.keys(AVA_TABS))if(AVA_TABS[k].words.test(t))return k;return null}

/* ===================== 4. THE GUIDE (AVA_KB) =====================
   Everything the hub does, in plain words, from the hub's README, the screens themselves and the system's own docs
   (email-distributor docs/SPEC.md, HUB-API.md, ONBOARD-CALL.md, LAUNCH-CALL.md, WARMUP-HUB.md, AUTO-BUY.md, KEYS.md,
   REPLYBOT-MEET.md). Each entry: id, kw (the words that point to it), a (the answer, said out loud), go (Take me there),
   owner (only the owner hears it). */
const AVA_KB=[
  {id:'process',kw:'how does trial work whole process journey steps start finish month 30 day explain everything',a:"Every trial goes the same way. They apply on the website, and you read it and say yes or no. They book the onboarding call. After the call, their domain and two inboxes are bought and set up, and the inboxes warm up for about two weeks. Near the end of warm-up there's a launch call where you go through their list and emails together. Then we send for 30 days. Replies are sorted, the reply bot answers simple questions, and booked calls land in their calendar. On day 30 they get a decision page; if they pick a plan, the month-one invoice goes out and you mark it paid.",go:'trials'},
  {id:'apply',kw:'apply application applicant new applications arrive come in website form review read',a:"When someone applies on the website, they show up at the top of Trials, or Paying clients for a paid plan, under New applications, with how well they match. Tap Application (Word) to read everything they sent plus what we found about them, then press Say yes or Say no.",go:'trials'},
  {id:'sayyes',kw:'say yes approve accept applicant what happens after yes',a:"Say yes emails them at once, asking them to book the onboarding call. From then on the trial runs by itself. You'll see it move to step 2, Onboarding call.",go:'trials',owner:true},
  {id:'sayno',kw:'say no decline reject applicant not a fit',a:"Say no asks you for a short reason first, then sends them a polite no. They move to Done, not taken. Nothing is sent until you confirm.",go:'trials',owner:true},
  {id:'word',kw:'application word document download match percent score what we found research brief',a:"Application (Word) downloads one Word document: everything they wrote, our fit check with the match percent, and What we found — a short brief about the company, with where each fact comes from. It's handy to read before the onboarding call.",go:'trials'},
  {id:'addclient',kw:'add trial client yourself manually new client form create start someone',a:"Use Add a trial client yourself at the bottom of Trials — or press N anywhere. Write the company, the person, their email and website. They get the welcome email now, or join the waiting list if three trials are already running. For a paid plan use Add a paying client yourself on Paying clients.",go:'trials',owner:true},
  {id:'onboarding',kw:'onboarding call book booking mark call booked done no show did not show reminders send email again stop reminders',a:"After your yes, they get one email asking them to book the onboarding call, and reminders if they don't. On their page the call card has Mark call booked, Call done, They didn't show, Send the email again and Stop reminders. When they pick a time, it waits in the Calendar for your yes.",go:'calendar'},
  {id:'calendar',kw:'calendar yes other time suggest decline meeting request call time sri lanka eastern join',a:"The Calendar shows every call in Sri Lanka time, with US Eastern beside it. When a client asks for a time, it waits at the top: Say yes sends them the time and an invite, Suggest another time lets you pick a new one, and Say no declines it. A confirmed call has a Join Google Meet button.",go:'calendar'},
  {id:'settingup',kw:'setting up setup domain inboxes buy purchase cheapinboxes buy and paste step 3',a:"Setting up means buying their domain and two inboxes. With CheapInboxes set up, the big button shows exactly what to buy; you buy it in your CheapInboxes account and the system finds the purchase and connects everything by itself. Without it, Buy and paste lets you paste the logins.",go:'set-inboxes',owner:false},
  {id:'warmup',kw:'warmup warming mean what is warm circle inbox rate spam 14 days ready',a:"Warming up means the new inboxes send and answer friendly emails with other accounts for about two weeks, so email providers learn to trust them and our emails land in the inbox, not spam. The trial's Warm-up card shows the day and how many land in the inbox. Sending starts when they're ready.",go:'set-warmup'},
  {id:'helpers',kw:'warmup helpers add helper gmail yahoo aol icloud gmx yandex app password circle test remove',a:"Helpers are free email accounts you make once — Gmail, Yahoo, AOL, iCloud and so on — that join the warm-up circle. Go to Settings, Warm-up, press Add a helper, pick the kind, follow the steps and paste its app password, then Test and add. Each helper has Test and Remove.",go:'set-warmup',owner:true},
  {id:'launch',kw:'launch call approved on the call skip approval page list emails before sending',a:"Near the end of warm-up, the client gets the launch-call invite. On the call you go through their list and their emails together. Press Approved on the call when they say OK — sending starts on Day 1. If they already approved on the page, you can skip the call.",go:'calendar'},
  {id:'sending',kw:'sending day 1 30 how many emails per day follow ups ramp step 4',a:"Sending runs for 30 days from Day 1. Each inbox starts slowly and sends a few more each day. The list shows Day 12 of 30 and so on. Their email system shows every email sent, and the numbers on Overview.",go:'trials'},
  {id:'replies',kw:'replies reply interested hot lead forwarded question not now unsubscribe sorted',a:"Every reply is read and sorted: interested, question, not now, wrong person, no, and so on. Interested people are passed to the client as hot leads. A STOP or no is never emailed again, for any client. You see every reply under Conversations in their email system.",go:'trials'},
  {id:'replybot',kw:'reply bot switch off on automatic answers what does it answer',a:"The reply bot answers simple questions for you with fixed answers — like sending the booking link and free times, or saying who we are. It never makes things up. Switch it off for one person with the switch under Messages on their page. Settings, Reply bot lists every rule.",go:'set-replybot'},
  {id:'calls',kw:'booked calls qualified count held no show dispute guarantee',a:"Calls booked from our emails land in the client's calendar. A call counts as qualified when it was held, with the right kind of person, booked from our outreach. No-shows get a rebook email. If the client says a call doesn't count, it shows as a dispute for you to decide.",go:'trials'},
  {id:'day30',kw:'day 30 decision page end of trial plan recommendation extension zero calls bonus decide',a:"On day 30 the client gets the decision page with their numbers, one plan we recommend, and a 24-hour bonus. They can pick a plan, ask to talk, or say not now. With no qualified call yet, the trial keeps sending free until the first one, up to 60 sending days.",go:'trials'},
  {id:'invoice',kw:'invoice paid mark paid money payment month one',a:"When a client picks a plan, the month-one invoice goes out. When the money lands, press Mark paid on their to-do. Paying clients shows what you received this month and in total — that's only for you.",go:'paying',owner:true},
  {id:'tiles',kw:'stage tiles squares filter applied booking the call call booked setting up warming up sending finished counts',a:"The row of tiles on Trials and Paying clients counts how many clients are at each stage: Applied, Booking the call, Call booked, Setting up, Warming up, Sending and Finished. Tap a tile to see only those clients; tap it again or All stages to go back.",go:'trials'},
  {id:'trialspage',kw:'trials page needs you in progress done not taken red row list',a:"Trials lists every trial client. Needs you is at the top, in red, with what you need to do. In progress are the ones running with nothing needed from you. Done, not taken is folded at the bottom. Tap a row to open that client.",go:'trials'},
  {id:'payingpage',kw:'paying clients page paid plan starter growth scale',a:"Paying clients works like Trials but for clients on Starter, Growth or Scale: new paid-plan applications, the stage tiles, and every paying client. The owner also sees the money received at the top.",go:'paying'},
  {id:'clientpage',kw:'client page one client five steps big button what do you need to do open email system',a:"A client's page is one card: the five steps — Applied, Onboarding call, Setting up, Sending emails, Done — the one-line status, and when something needs you, one big button for the most important thing. Under it, Open their email system shows everything else.",go:'trials'},
  {id:'system',kw:'email system tabs shared only you overview conversations emails sent calls messages money health leads setup',a:"Their email system has tabs across the top. Shared, for everyone: Overview, Conversations, Emails sent, Calls and Messages. Only you, the owner: Money, Health, Leads and Setup. Say, for example, 'show Lakeview's conversations' and I'll open it.",go:'trials'},
  {id:'access',kw:'give client access dashboard share who can see this link stop access',a:"Open the client, then their email system's Setup tab. Under Who can see this, type an email from their business and press Give access — they get a private link to their own live page. Stop all access turns every link off.",go:'trials',owner:true},
  {id:'testrun',kw:'test run demo load remove made up fake clients test tag',a:"Settings, Test run loads two made-up clients — a trial and a paying client — who went through a whole month, marked with a Test tag. No real emails are sent. Press Remove the test run there to take them away; your real clients aren't touched.",go:'set-demo',owner:true},
  {id:'team',kw:'team page status working on who looks after whom choose clients assign',a:"The Team page shows everyone who uses the hub: who's in the hub now, where they are, what they're working on, and which clients each person looks after. Write your own line under What are you working on. The owner picks each person's clients with Choose clients.",go:'team'},
  {id:'activity',kw:'activity signed in out how long approve new account waiting approval',a:"Activity is the owner's page: who signed in and out, for how long, what they opened, and new accounts waiting for approval. Approve lets a person in — they can see everything and change nothing.",go:'activity',owner:true},
  {id:'roles',kw:'team member read only change nothing roles employee owner permission cannot press',a:"The owner can do everything. A team member sees the same screens but can't change anything, so the buttons that change things are hidden for them, and money is only for the owner. New team members make an account on the sign-in page and the owner approves it.",go:'team'},
  {id:'mystats',kw:'my stats own outreach saved history save and start fresh spreadsheet clear',a:"My stats is your own outreach: emails sent, opened, replies and bounced, emails per day, by inbox, and every reply. Saved history keeps full copies as spreadsheets. Save and start fresh saves a copy, then clears the numbers so My stats starts from zero — people already emailed are never emailed again.",go:'mystats'},
  {id:'settings',kw:'settings sections what is in settings',a:"Settings has named sections, each saying its state in one word: Alerts, Phone alerts, Your details, Keys, Ava, Google Meet, Inboxes and domains, Warm-up, Reply bot, Test run, Is everything running, Behind the scenes, Advanced, Light or dark, and Your account.",go:'settings',owner:true},
  {id:'keys',kw:'keys api key paste service google places verify test and save forget',a:"Settings, Keys has one card per free service the system uses. Each card says its state and the steps to get the key; paste it once and press Test and save. A saved key is never shown again.",go:'set-keys',owner:true},
  {id:'details',kw:'your details name address call link paypal wise clutch onboarding inbox',a:"Settings, Your details holds what the emails say about you — your name, address, email, the onboarding inbox, call link, PayPal, Wise and Clutch. Each has its own Save; it tells you what's still to fill in.",go:'set-details',owner:true},
  {id:'meet',kw:'google meet connect link calls video',a:"Settings, Google Meet connects your Google account so every call you say yes to gets a Meet link. Follow the numbered steps once, press Connect Google, then Test it.",go:'set-google',owner:true},
  {id:'phone',kw:'phone alerts push notifications iphone home screen',a:"Phone alerts send a message to your phone when something needs you. On an iPhone, add the hub to your Home Screen first, then open it from there and turn alerts on.",go:'set-phone',owner:true},
  {id:'opened',kw:'opened blank empty dash not tracked opens client why',a:"Opened is blank for clients on purpose: their emails go out without an open tracker, because trackers hurt landing in the inbox. So there's nothing to count. Only your own outreach on My stats tracks opens.",go:'mystats'},
  {id:'bounce',kw:'bounce bounced what is bounce rate address does not exist pause',a:"A bounce is an email that came back because the address doesn't exist or the mailbox refused it. A few are normal. If too many bounce — about 2 to 3 percent — sending slows down or pauses by itself to protect the inboxes, and you get an alert.",go:null},
  {id:'bell',kw:'bell notifications what needs you alerts not seen mark as seen',a:"The bell at the top lists what needs you right now. Settings, Alerts has every message from the system, not seen first, with Mark as seen.",go:'set-alerts'},
  {id:'search',kw:'search find command k shortcut keyboard slash space',a:"Press Control or Command K — or the slash key — to find any client or page. Hold the Space bar to talk to me, and let go to send; Control or Command J opens me.",go:null},
  {id:'dark',kw:'dark mode light theme look',a:"Settings, Light or dark switches how the hub looks on this device. It's also in the Control K search.",go:'settings',owner:true},
  {id:'behind',kw:'behind the scenes board every to do waiting list queue parts',a:"Behind the scenes, in Settings, is the full picture: every trial by stage, every to-do in one list, the waiting list and your own sending. Each client's email system also has behind-the-scenes tabs like Growth, Parts and Deliverability.",go:'behind'},
  {id:'waitlist',kw:'three trials waiting list queue full max limit',a:"At most three trials run at the same time. Anyone else you say yes to joins the waiting list and starts when a place opens.",go:'behind'},
  {id:'inquiries',kw:'plan call requests inquiries paid plan booked call website',a:"Plan call requests are people who booked a call about a paid plan from the website without an application. Find them at the bottom of Paying clients.",go:'inquiries'},
  {id:'ava',kw:'who are you ava privacy voice listen microphone data google what can you do',a:"I'm Ava, the hub's helper. With my AI brain switched on, you can ask me anything — about the hub, your clients or anything else — and plain commands like 'open trials' run at once. The AI is a free service that doesn't train on your data, and your prospects' email addresses are never sent. Without it I'm in basic mode and answer the simple things from what the hub has loaded. Hold Space to talk, or type.",go:null},
];
function avaKbScore(entry,qTokens){
  if(!entry._bag){entry._bag=new Set(avaTokens(entry.kw+' '+entry.id));}
  let s=0;const seen=new Set();
  qTokens.forEach(w=>{if(seen.has(w))return;seen.add(w);
    if(entry._bag.has(w)){s+=w.length>=5?2:1.4;return;}
    if(w.length>=5){for(const b of entry._bag){if(b.length>=5&&avaLev(w,b,1)<=1){s+=1;break;}}}
  });
  return s;
}
function avaKbFind(text,ctx){
  const q=avaTokens(text);if(!q.length)return null;
  let best=null;
  AVA_KB.forEach(e=>{const s=avaKbScore(e,q);if(!best||s>best.s)best={e,s};});
  if(!best||best.s<1.9)return null;
  return {entry:best.e,score:best.s,strong:best.s>=3.5||best.s>=q.length*1.5};
}

/* ===================== 5. THE BRAIN: avaThink(text, ctx) → {say, actions, auto?, confirm?} ===================== */
function avaReply(say,actions,extra){return Object.assign({say:avaSentence(say),actions:(actions||[]).filter(Boolean)},extra||{})}
const AVA_YES=/^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do|confirm|go|correct|right|yes please|ya)\b/;
const AVA_NO=/^(no|nope|cancel|stop|never ?mind|don't|do not|not now)\b/;
function avaExample(){const c=avaClients();const run=c.find(x=>typeof tkStageOf==='function'&&tkStageOf(x.row)==='sending')||c.find(x=>typeof tkStageOf==='function'&&!['applied',null].includes(tkStageOf(x.row)))||c[0];return run?run.name:'Lakeview'}
function avaChipsFor(ctx){
  const ex=avaClients().length?avaExample():null;
  const chips=['What needs me today?','How many trials are running?',"What's on my calendar today?"];
  if(ex)chips.push('How many emails did '+ex+' send?');
  chips.push('How does a trial work?');
  return chips;
}
function avaOwnerOnly(what){return avaReply("That's only for the owner"+(what?' — '+what:'')+". I can tell you anything else on the hub.",[avaPlace('trials')])}

function avaThink(text,ctx){
  ctx=ctx||avaCtx();const t=avaNorm(text);
  if(!t)return avaReply("I didn't catch that. Try again, or type it.",[]);
  const owner=!!ctx.owner;

  // 0. an answer to "shall I?"
  if(AVA.pending){
    const p=AVA.pending;
    if(AVA_YES.test(t)){AVA.pending=null;return avaReply(p.done||'Done.',[],{auto:p.act});}
    if(AVA_NO.test(t)){AVA.pending=null;return avaReply("Okay, I won't.",[]);}
    AVA.pending=null;   // anything else: a new question
  }

  // 0b. read the screen out / read more / stop / "open X and read it"
  const rc=avaReadCmd(text);
  if(rc){
    if(rc.kind==='stop'){AVA.readRest=null;return avaReply('Okay.',[],{hush:true,silent:true});}
    if(rc.kind==='more')return avaReply('',[],{read:{what:'more'}});
    if(rc.kind==='read')return avaReply('',[],{read:{what:rc.numbers?'numbers':'page'}});
    const go=avaThink(rc.nav,ctx);if(go&&go.auto)go.read={what:'page'};return go;
  }

  // 1. hello / help
  if(/^(hi|hello|hey|hiya|good (morning|afternoon|evening))( ava)?$/.test(t))return avaReply('Hi'+(ctx.name?' '+ctx.name:'')+'! Ask me what needs you, about a client, or how anything in the hub works.',[],{chips:avaChipsFor(ctx)});
  if(/\b(what can you do|help me|how do i use you|what do you do)\b|^help$/.test(t))return avaReply("I can tell you what needs you, how many trials are running, what's on your calendar and who's online. I can open any page or client — like 'open "+avaExample()+"' or 'show "+avaExample()+"'s conversations' — and explain how anything in the hub works.",[],{chips:avaChipsFor(ctx)});
  if(/\b(thank|thanks|cheers)\b/.test(t))return avaReply("You're welcome.",[]);

  // 2. back
  if(/^(go )?back$|\bgo back\b|\bprevious page\b/.test(t))return avaReply('Going back.',[],{auto:avaAct('Back',()=>goBack())});

  // 3. live answers
  const live=avaLive(t,ctx);if(live)return live;

  // 4. "how do I …" / "what is …" — the guide first
  const question=/^(how (do|does|can|should|to)|what (is|does|are|happens)|why|explain|tell me about|where (is|do|can)|when (does|do|is)|is there|can i|do i|meaning)\b/.test(t);
  const kb=avaKbFind(t,ctx);
  if(question&&kb&&kb.strong&&!avaFindClient(t))return avaKbAnswer(kb.entry,ctx);

  // 5. a client
  const client=avaFindClient(t);
  const act=avaActions(t,ctx,client);if(act)return act;
  if(client)return avaAboutClient(t,ctx,client);

  // 6. a place
  const nav=avaNavigate(t,ctx);if(nav)return nav;

  // 7. the guide, less sure (the smarter brain is asked first when it's on)
  if(kb)return Object.assign(avaKbAnswer(kb.entry,ctx),{weak:true});

  // 8. not sure
  const ex=avaExample();
  return avaReply("I'm not sure yet — try 'what needs me' or 'open "+ex+"'.",[],{chips:['What needs me today?','Open '+ex,'How does a trial work?'],unknown:true});
}
function avaKbAnswer(e,ctx){
  if(e.owner&&!ctx.owner&&/\b(money|invoice)\b/.test(e.kw))return avaOwnerOnly('money');
  const go=e.go?avaPlace(e.go):null;const ok=go&&(!go.owner||ctx.owner);
  const a=ok?avaAct('Take me there',go.run,{place:go.place}):null;
  return avaReply(e.a+(e.owner&&!ctx.owner?' (Only the owner can press those buttons.)':''),[a],{kb:e.id});
}

/* ---- live answers from what the hub has loaded ---- */
function avaLive(t,ctx){
  const hub=avaHub();const owner=!!ctx.owner;
  const wantsCount=/\bhow many\b|\bnumber of\b|\bcount\b/.test(t);
  const client=avaFindClient(t);
  // money (owner only)
  if(/\b(money|revenue|income|earn|earned|made|received|paid)\b/.test(t)&&!client&&/\b(month|how much|total|all time|this|so far|have i|did i|we)\b/.test(t)){
    if(!owner)return avaOwnerOnly('money');
    if(!hub)return avaNoData();
    const rows=typeof tkListRows==='function'?tkListRows(hub).filter(r=>tkIsPaidRow(r)):[];
    if(!rows.length)return avaReply('No paying clients yet, so no money received yet.',[avaPlace('paying')]);
    const m=tkMoneyTotals(rows,ctx.now);
    if(!m.checked)return avaReply("I'm still counting the money received — open Paying clients in a moment.",[avaPlace('paying')]);
    const extra=[m.waiting?'still counting '+avaPlural(m.waiting,'client'):'',m.demo?tkDollars(m.demo)+' of it is from the test run':''].filter(Boolean).join('; ');
    return avaReply('You received '+tkDollars(m.month)+' this month, and '+tkDollars(m.all)+' in total from '+avaPlural(m.count,'paid invoice')+(extra?' — '+extra:''),[avaPlace('paying')]);
  }
  // my own outreach
  if(/\b(have i|did i|i have|my own|my|we)\b.*\b(sent|send|emailed|outreach)\b|\bmy (outreach|emails)\b/.test(t)&&!client){
    const o=typeof tk!=='undefined'&&tk?tk.outreach:null;
    if(!o||!o.totals)return avaReply("I couldn't load your own sending just now. My stats has it.",[avaPlace('mystats')]);
    const x=o.totals;const since=x.firstDay&&typeof tkDayName==='function'?' since '+tkDayName(x.firstDay):'';
    return avaReply('Your own outreach has sent '+avaPlural(x.sent||0,'email')+since+', with '+avaPlural(x.replies||0,'reply','replies')+' and '+avaNum(x.bounces||0)+' bounced'+(x.uniqueOpens!=null?'; '+avaNum(x.uniqueOpens)+' were opened':''),[avaPlace('mystats')]);
  }
  // what needs me
  if(/\bneeds? (me|you|my|attention)\b|\bwhat (should|do) i (do|work on)\b|\bmy to ?dos?\b|\bto ?do list\b|\banything (urgent|for me)\b|\bwhat is waiting\b|\bwhat is urgent\b/.test(t))return avaNeeds(ctx);
  // new applications
  if(/\bapplications?\b|\bapplied\b|\bapplicants?\b/.test(t)&&(/\b(any|new|how many|who|waiting|list)\b/.test(t))&&!client)return avaApps(ctx);
  // calendar
  if(/\b(calendar|calls?|meetings?)\b/.test(t)&&/\b(today|tonight|tomorrow|this week|on my|have i|do i have|next)\b/.test(t)&&!client)return avaCalendar(t,ctx);
  // team
  if(/\b(who is|who are|anyone|anybody|who)\b.*\b(online|in the hub|working|here|signed in|around)\b|\bteam online\b/.test(t))return avaTeamOnline(ctx);
  if(/\bwho (looks after|takes care of|handles|owns)\b/.test(t)&&client)return avaLooksAfter(ctx,client);
  // counts by stage
  if(!client&&(wantsCount||/^who (is|are)\b|\bwhich (clients|trials)\b|\blist\b/.test(t))){
    const st=avaStageWord(t);
    if(st||/\b(trials|clients|paying|running|active|going|in progress)\b/.test(t))return avaCounts(t,ctx,st);
  }
  return null;
}
function avaNoData(){const e=typeof tk!=='undefined'&&tk&&tk.hubErr;return avaReply(e?"I couldn't load your clients just now — try again in a minute.":'Give me a second — your clients are still loading. Ask me again.',[avaPlace('trials')])}
function avaStageWord(t){
  const M=[['sending',/\bsending\b/],['warming',/\bwarmup\b|\bwarming\b/],['setup',/\bsetup\b|\bbuying\b/],['call',/\bcall booked\b|\bbooked (a|the) call\b/],['booking',/\bbooking (the )?call\b|\bneed to book\b/],['applied',/\bapplied\b|\bnew\b/],['finished',/\bfinished\b|\bdone\b|\bdeciding\b/]];
  const m=M.find(x=>x[1].test(t));return m?m[0]:null;
}
function avaCounts(t,ctx,stage){
  const hub=avaHub();if(!hub)return avaNoData();
  const paid=/\bpaying\b/.test(t);
  const g=tkListGroups(hub,paid);const all=g.needs.concat(g.going,g.done);
  const where=paid?'paying':'trials';const place=avaPlace(where);
  if(stage){
    const tile=(TK_STAGE_TILES.find(x=>x[0]===stage)||[stage,stage])[1];
    const xs=all.filter(x=>tkStageOf(x.row)===stage).map(x=>x.s.company);
    const run=avaAct('Show them',()=>{render(where);if(typeof trialsSetStage==='function'&&!(tk.stage&&tk.stage[where]===stage))trialsSetStage(paid,stage);});
    if(!xs.length)return avaReply('Nobody is at '+tile.toLowerCase()+' right now'+(paid?' among paying clients':'')+'.',[place]);
    return avaReply(avaPlural(xs.length,paid?'paying client':'trial')+' '+(xs.length===1?'is':'are')+' at '+tile.toLowerCase()+': '+avaList(xs.slice(0,5))+(xs.length>5?' and '+(xs.length-5)+' more':''),[run]);
  }
  const running=all.filter(x=>!x.s.done&&!tkStep(x.row).notTaken&&tkStageOf(x.row)!=='applied');
  const applied=all.filter(x=>!x.s.done&&tkStageOf(x.row)==='applied').length;
  if(!running.length)return avaReply((paid?'No paying clients yet':'No trials are running right now')+(applied?', and '+avaPlural(applied,'application')+' '+(applied===1?'is':'are')+' waiting':''),[place]);
  const by={};running.forEach(x=>{const k=tkStageOf(x.row);if(k)by[k]=(by[k]||0)+1;});
  const parts=TK_STAGE_TILES.filter(x=>by[x[0]]).map(x=>by[x[0]]+' '+x[1].toLowerCase());
  const needs=g.needs.length;
  return avaReply(avaPlural(running.length,paid?'paying client':'trial')+' '+(running.length===1?'is':'are')+' going: '+avaList(parts)+(applied?'. Plus '+avaPlural(applied,'applicant')+' at the start':'')+(needs?'. '+avaPlural(needs,'client')+' '+(needs===1?'needs':'need')+(ctx.owner?' you':' the owner'):''),[place]);
}
function avaNeedLine(x){
  const s=x.s;if(typeof tkIsUnderReview==='function'&&tkIsUnderReview(x.row))return s.company+' — a new application to read';
  if(s.needsReply)return s.company+' — '+(avaFirst(s.person)||'they')+' wrote, answer them';
  const nx=/^nothing\b/i.test(s.next)?'':s.next;const td=typeof tkTodosSorted==='function'?tkTodosSorted(x.row)[0]:null;
  const what=String(nx||(td&&td.text)||'open it to see what').trim().replace(/\.+$/,'');
  return s.company+' — '+what.charAt(0).toLowerCase()+what.slice(1);
}
function avaNeeds(ctx){
  const hub=avaHub();if(!hub)return avaNoData();
  const seen={};const xs=[];
  tkListGroups(hub,false).needs.concat(tkListGroups(hub,true).needs).forEach(x=>{if(!seen[x.row.id]){seen[x.row.id]=1;xs.push(x);}});
  const reqs=typeof cal!=='undefined'&&cal&&Array.isArray(cal.reqs)?cal.reqs.filter(m=>m&&!m.proposed&&m.status==='requested'):[];
  const pend=ctx.owner&&typeof pp!=='undefined'&&pp&&Array.isArray(pp.pending)?pp.pending.length:0;
  const who=ctx.owner?'you':'the owner';
  if(!xs.length&&!reqs.length&&!pend)return avaReply("Nothing needs "+who+" right now. We'll tell you when something does.",[avaPlace('trials')]);
  const lines=xs.slice(0,3).map(avaNeedLine);
  if(xs.length>3)lines.push(avaPlural(xs.length-3,'more client'));
  if(reqs.length)lines.push(avaPlural(reqs.length,'call time')+' '+(reqs.length===1?'waits':'wait')+' for your yes in the Calendar');
  if(pend)lines.push(avaPlural(pend,'new team account')+' to approve in Activity');
  const n=xs.length+(reqs.length?1:0)+(pend?1:0);
  const acts=[];
  if(xs[0])acts.push(avaAct('Open '+xs[0].s.company,()=>tkIsUnderReview(xs[0].row)?openTrial(xs[0].row.id,null,'application'):openTrial(xs[0].row.id)));
  if(xs.length)acts.push(avaPlace(tkIsPaidRow(xs[0].row)?'paying':'trials'));
  if(reqs.length)acts.push(avaAct('Open the Calendar',()=>typeof openCalendar==='function'?openCalendar(reqs[0].id):render('calendar')));
  if(pend)acts.push(avaPlace('activity'));
  return avaReply((n===1?'One thing needs ':avaNum(n)+' things need ')+who+': '+lines.join('; '),acts.slice(0,3));
}
function avaApps(ctx){
  const hub=avaHub();if(!hub)return avaNoData();
  const xs=tkListRows(hub).filter(r=>tkIsUnderReview(r));
  if(!xs.length)return avaReply('No new applications right now.',[avaPlace('trials')]);
  const names=xs.slice(0,4).map(r=>{const s=tkSimple(r);const fs=r.fitScore;return s.company+(fs&&fs.score!=null?' ('+fs.score+'% match)':'')+(tkIsPaidRow(r)?', '+tkPlanName(r.plan)+' plan':'')});
  return avaReply(avaPlural(xs.length,'new application')+' '+(xs.length===1?'is':'are')+' waiting: '+avaList(names)+(xs.length>4?' and more':'')+(ctx.owner?'. Read it, then say yes or no.':'. The owner says yes or no.'),[avaAct('Open '+tkSimple(xs[0]).company,()=>openTrial(xs[0].id,null,'application')),avaPlace(tkIsPaidRow(xs[0])?'paying':'trials')]);
}
function avaMeetings(){
  const out=[],seen={};if(typeof cal==='undefined'||!cal)return out;
  const add=m=>{if(m&&m.id!=null&&!seen[m.id]){seen[m.id]=1;out.push(m);}};
  Object.keys(cal.weeks||{}).forEach(k=>{const d=cal.weeks[k]||{};(d.meetings||[]).forEach(add);(d.requests||[]).forEach(add);});
  (cal.reqs||[]).forEach(add);return out;
}
function avaCalendar(t,ctx){
  if(typeof calSettingsNow!=='function')return avaReply('The Calendar has every call.',[avaPlace('calendar')]);
  const st=calSettingsNow();const now=typeof calNow==='function'?calNow():new Date();
  const tomorrow=/\btomorrow\b/.test(t);const week=/\bthis week\b|\bnext\b/.test(t)&&!tomorrow&&!/\btoday\b/.test(t);
  const todayKey=calDayKey(now,st.ownerZone);const key=tomorrow?calAddDays(todayKey,1):todayKey;
  const loaded=Object.keys(cal.weeks||{}).length>0;
  if(!loaded)return avaReply("I couldn't load your calendar just now.",[avaPlace('calendar')]);
  const ms=avaMeetings().filter(m=>!['cancelled','declined','no_show','deleted'].includes(String(m.status))).map(m=>({m,d:tkParseDate(calHeldAt(m))})).filter(x=>x.d);
  const pick=week?ms.filter(x=>{const k=calDayKey(x.d,st.ownerZone);return k>=todayKey&&k<=calAddDays(todayKey,6)&&x.d>=now}):ms.filter(x=>calDayKey(x.d,st.ownerZone)===key);
  pick.sort((a,b)=>a.d-b.d);
  const when=tomorrow?'tomorrow':week?'in the next seven days':'today';
  if(!pick.length)return avaReply('Nothing on your calendar '+when+'.',[avaPlace('calendar')]);
  const line=x=>{const m=x.m;const tm=calTime(x.d,st.ownerZone).replace(':00 ',' ');const day=week?calWeekdayName(x.d,st.ownerZone)+' ':'';
    const what=m.status==='blocked'?'busy':calTitle(m);
    return day+tm+' — '+what+(m.status==='requested'?(m.proposed?' (you suggested another time)':' (waiting for your yes)'):m.status==='held'?' (done)':'');};
  const first=pick[0].m;
  return avaReply('You have '+avaPlural(pick.length,pick.some(x=>x.m.status==='blocked')?'thing':'call')+' '+when+' (Sri Lanka time): '+pick.slice(0,4).map(line).join('; ')+(pick.length>4?'; and '+(pick.length-4)+' more':''),[avaAct('Open the Calendar',()=>typeof openCalendar==='function'?openCalendar(first.id):render('calendar'))]);
}
function avaTeamOnline(ctx){
  if(typeof tm==='undefined'||!tm||!tm.data)return avaReply("I couldn't load the team just now.",[avaPlace('team')]);
  const on=(tm.data.team||[]).filter(p=>p.online&&!(authUser&&p.uid===authUser.uid));
  if(!on.length)return avaReply('Nobody else is in the hub right now.',[avaPlace('team')]);
  const names=on.map(p=>avaFirst(p.name||p.email)+(p.lastView&&typeof ppPlace==='function'?' on '+ppPlace(p.lastView):''));
  return avaReply(avaPlural(on.length,'person','people')+' '+(on.length===1?'is':'are')+' in the hub: '+avaList(names),[avaPlace('team')]);
}
function avaLooksAfter(ctx,c){
  if(typeof tm==='undefined'||!tm||!tm.data)return avaReply("I couldn't load the team just now.",[avaPlace('team')]);
  const uids=(tm.data.owners||{})[c.id]||[];const names=uids.map(u=>(tm.data.team||[]).find(p=>p.uid===u)).filter(Boolean).map(p=>avaFirst(p.name||p.email));
  return avaReply(names.length?c.name+' is looked after by '+avaList(names):'Nobody looks after '+c.name+' yet'+(ctx.owner?' — choose on the Team page':''),[avaPlace('team')]);
}

/* ---- one client ---- */
function avaAboutClient(t,ctx,c){
  AVA.lastClient=c.id;
  const want=avaWantTab(t);
  const stat=/\bhow many\b|\bhow much\b|\bnumber of\b|\bhow is\b|\bhow are\b|\bdoing\b|\bstatus\b|\bwhere is\b|\bwhere are\b|\bprogress\b|\bwhat day\b|\bupdate on\b/.test(t);
  if(stat&&!/\b(open|show|go to|take me)\b/.test(t))return avaClientStats(t,ctx,c,want);
  // a longer sentence that names them but doesn't ask to go there ("summarise what Dana asked…", "tell everyone I'm on
  // calls with Lakeview"): the smarter brain is asked first; opening them is the answer when it's off
  const weak=!AVA_GO_WORDS.test(t)&&t.split(' ').length>4;
  if(want){
    const spec=AVA_TABS[want];
    if(spec.owner&&!ctx.owner)return avaOwnerOnly(spec.label.toLowerCase()+' is in the Only you part of their email system');
    return avaReply("Here's "+tkPossessive(c.name)+' '+spec.label.toLowerCase()+'.',[],{auto:avaAct('Open '+spec.label,()=>avaOpenTab(c.id,want)),weak});
  }
  return avaReply("Here's "+c.name+'.',[avaAct('Open their email system',()=>avaOpenTab(c.id,'overview'))],{auto:avaAct('Open '+c.name,()=>openTrial(c.id)),weak});
}
function avaClientStats(t,ctx,c,want){
  const f=avaFive(c);const r=c.row;const s=tkSimple(r);const step=avaStepLine(r);
  const open=avaAct('Open '+c.name,()=>openTrial(c.id));
  const j=tkStep(r);const lab=String(s.label||'').trim().replace(/\.$/,'');
  const where=avaSentence(j.notTaken?'They were not taken':"They're at "+(j.n?'step '+j.n+' of 5':'the start')+': '+(lab||j.name||step));
  if(/\b(money|paid|invoice|pay)\b/.test(t)){
    if(!ctx.owner)return avaOwnerOnly('money');
    const d=tk.detail[c.id];const inv=tkInvoicesOf(r)||tkInvoicesOf(d);
    if(!inv)return avaReply("Open their money to see their invoice — I haven't loaded it yet.",[avaAct('Open Money',()=>avaOpenTab(c.id,'money'))]);
    const got=inv.filter(i=>i.paid&&i.amount!=null).reduce((n,i)=>n+i.amount,0);
    return avaReply(c.name+' has paid '+tkDollars(got)+(inv.some(i=>!i.paid)?', with an invoice not paid yet':''),[avaAct('Open Money',()=>avaOpenTab(c.id,'money'))]);
  }
  if(f.sent==null||f.sent===0){
    return avaReply(c.name+" hasn't sent any emails yet. "+where,[open]);
  }
  const tab=k=>avaAct('Open '+AVA_TABS[k].label,()=>avaOpenTab(c.id,k));
  if(/\breplies|repl(y|ied)\b/.test(t)&&!/\bemails? sent\b/.test(t))return avaReply(c.name+' got '+avaPlural(f.replies||0,'reply','replies')+(f.positive!=null?', '+avaNum(f.positive)+' of them positive':'')+', from '+avaPlural(f.sent,'email')+' sent',[tab('conversations')]);
  if(/\bcalls?\b|\bbooked\b|\bmeetings?\b/.test(t))return avaReply(c.name+' has '+avaPlural(f.booked||0,'call')+' booked'+(f.qualified!=null?', '+avaNum(f.qualified)+' qualified so far':''),[tab('calls')]);
  if(/\bbounce/.test(t)&&f.bounces!=null)return avaReply(c.name+' had '+avaPlural(f.bounces,'bounce')+' from '+avaPlural(f.sent,'email')+' sent',[ctx.owner?tab('health'):open]);
  const tail=' '+where;
  if(/\bemails?\b|\bsent|send\b/.test(t))return avaReply(c.name+' has sent '+avaPlural(f.sent,'email')+', with '+avaPlural(f.replies||0,'reply','replies')+' and '+avaPlural(f.booked||0,'call')+' booked.'+tail,[tab('emails')]);
  return avaReply(c.name+' has sent '+avaPlural(f.sent,'email')+', got '+avaPlural(f.replies||0,'reply','replies')+' and '+avaPlural(f.booked||0,'call')+' booked.'+tail,[open]);
}

/* ---- the owner's few actions: always asked first, and they only OPEN the place ---- */
function avaActions(t,ctx,client){
  const ask=(say,label,run,done)=>{
    if(!ctx.owner)return avaReply("Only the owner can do that. I can show you where it is.",[avaPlace('trials')]);
    const act=avaAct(label,run);AVA.pending={act,done};
    return avaReply(say,[avaAct('Yes, '+label.charAt(0).toLowerCase()+label.slice(1),()=>{AVA.pending=null;run();},{yes:true}),avaAct('No',()=>{AVA.pending=null;},{no:true})],{confirm:true});
  };
  if(/\b(add|new|create|start)\b.*\b(trials?|clients?|customers?|paying)\b/.test(t)&&!/^(how|what|why)\b/.test(t)){
    const paid=/\bpaying|paid\b/.test(t);
    return ask('Shall I open the form to add a '+(paid?'paying':'trial')+' client? Nothing is sent until you press the button in it.','Open the form',()=>{render(paid?'paying':'trials');paid?openNewPayingClient():openNewTrialClient();},'Opening the form.');
  }
  if(/\b(give|share|grant)\b.*\baccess\b|\baccess\b.*\b(give|share)\b/.test(t)&&!/^(how|what|why)\b/.test(t)){
    if(!client)return avaReply("Which client? Say, for example, 'give "+avaExample()+" access'.",[]);
    return ask('Shall I open '+tkPossessive(client.name)+' Setup, where you type their email and press Give access?','Open their Setup',()=>avaOpenTab(client.id,'setup'),'Opening their Setup — Who can see this is there.');
  }
  if(/\b(load|add|start|remove|delete|clear|take away)\b.*\b(test run|demo)\b/.test(t)&&!/^(how|what|why)\b/.test(t)){
    const rm=/\b(remove|delete|clear|take away)\b/.test(t);
    return ask('Shall I open Settings, Test run? You press '+(rm?'Remove the test run':'Load the test run')+' there yourself.','Open Test run',()=>openSettings('demo'),'Opening Settings, Test run.');
  }
  if(/\b(send|email|reply|say yes|say no|approve|decline|confirm)\b/.test(t)&&/\b(to|them|applicant|application|call)\b/.test(t)&&/^(send|email|reply|say|approve|decline|confirm)\b/.test(t)){
    const where=client?avaAct('Open '+client.name,()=>openTrial(client.id)):avaPlace('trials');
    return avaReply("I don't send emails or answer applicants for you — that always takes your own click. I can open the right place.",[where]);
  }
  return null;
}

/* ---- places ---- */
function avaNavigate(t,ctx){
  const go=/\b(open|show|go to|go|take me|bring up|switch to|see|view|jump to|navigate)\b/.test(t);
  const bare=t.split(' ').length<=3;
  for(const p of AVA_PLACES){
    if(!p[1].test(t))continue;
    if(!go&&!bare)continue;
    if(p[4]&&!ctx.owner)return avaOwnerOnly(p[2]);
    const a=avaPlace(p[0]);return avaReply(avaHere(p[0]),[],{auto:a,place:p[0]});
  }
  return null;
}

/* ===================== 6. MOUTH: a natural voice on the device, the browser's voice meanwhile =====================
   1. Kokoro (kokoro-js, an open model) in a Web Worker (ava-voice-worker.js) — natural, free, no key, nothing leaves the
      device. Loaded lazily the first time Ava opens or speaks; the browser keeps it after that.
   2. Until it is ready, if it fails, if this device is too slow for it, or if "Browser voice" is picked: the best voice
      the browser has ("Natural"/"Neural"/"Online" voices first, then Google US English, Samantha / Ava on Apple).
   Answers are said sentence by sentence (the next one is made while the first plays), and stop at once when the mic is
   tapped or Ava is closed (barge-in). */
const AVA_VOICE_KEY='avianceAvaVoice:v1';
const AVA_HANDS_KEY='avianceAvaHands:v1';
const AVA_SLOW_KEY='avianceAvaSlow:v1';
const AVA_SPEED_KEY='avianceAvaSpeed:v1';   // how fast she talks: 0.9 – 1.2 (1 = normal)
const AVA_NATURAL_KEY='avianceAvaNatural:v1';   // told once that the natural voice is ready     // this computer was too slow for the natural voice: don't download it again every visit
const AVA_VOICES=[['af_heart','Heart','warm and natural'],['af_bella','Bella','bright and friendly'],['af_nicole','Nicole','soft and calm'],['bf_emma','Emma','British']];
const AVA_VOICE_MB={webgpu:350,wasm:115};   // kokoro-js bundle 2 MB + ONNX runtime 22 MB + the model (fp32 326 MB / q8 92 MB)
const AVA_SLOW_RTF=1.2;                     // a device that needs longer than 1.2 s to make 1 s of speech would pause mid-answer: the browser voice
function avaStore(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v);}catch(e){}return null}
function avaVoicePref(){if(!AVA.voicePref){const v=avaStore(AVA_VOICE_KEY);AVA.voicePref=v==='browser'||AVA_VOICES.some(x=>x[0]===v)?v:'af_heart';}return AVA.voicePref}
function avaSetVoice(v){
  v=v==='browser'||AVA_VOICES.some(x=>x[0]===v)?v:'af_heart';AVA.voicePref=v;avaStore(AVA_VOICE_KEY,v);
  // picking a natural voice by hand tries it again on a computer that was too slow before
  if(v!=='browser'&&AVA.k.state==='slow'&&!AVA.k.worker){avaStore(AVA_SLOW_KEY,'');AVA.k.state='idle';}
  avaHush();if(v!=='browser')avaVoiceWarm();avaPaintVoice();
  if(typeof currentView!=='undefined'&&currentView==='settings'&&typeof trialsRepaint==='function')trialsRepaint('settings',{soft:true});
}
function avaSpeed(){if(AVA.speed==null){const v=Number(avaStore(AVA_SPEED_KEY));AVA.speed=v>=0.9&&v<=1.2?v:1;}return AVA.speed}
function avaSetSpeed(v){v=Math.round(Math.min(1.2,Math.max(0.9,Number(v)||1))*100)/100;AVA.speed=v;avaStore(AVA_SPEED_KEY,String(v));avaPaintVoice();return v}
function avaHandsFree(){if(AVA.handsFree==null)AVA.handsFree=avaStore(AVA_HANDS_KEY)==='1';return AVA.handsFree}
function avaSetHandsFree(on){AVA.handsFree=!!on;AVA.loopPaused=false;avaStore(AVA_HANDS_KEY,on?'1':'0');avaPaintVoice();
  if(on&&AVA.open&&!AVA.listening&&!AVA.speaking&&!AVA.busy&&avaCanListen())avaListen();}
function avaCanSpeak(){try{return typeof window!=='undefined'&&!!window.speechSynthesis&&typeof window.SpeechSynthesisUtterance==='function'}catch(e){return false}}
function avaMuted(){if(AVA.muted==null){try{AVA.muted=localStorage.getItem(AVA_MUTE_KEY)==='1';}catch(e){AVA.muted=false;}}return AVA.muted}
function avaSetMute(on){AVA.muted=!!on;try{localStorage.setItem(AVA_MUTE_KEY,on?'1':'0');}catch(e){}if(on)avaHush();avaPaintHead();}

/* ---- the natural voice (Kokoro) ---- */
function avaAudioClass(){try{return (typeof window!=='undefined'&&(window.AudioContext||window.webkitAudioContext))||null}catch(e){return null}}
/* Computers only: on a phone the download is too big and the phone's own voice is good (Siri / Google voices). */
function avaKokoroSupported(){try{return typeof Worker==='function'&&typeof WebAssembly==='object'&&!!avaAudioClass()&&!avaIsPhone()}catch(e){return false}}
function avaKokoroDevice(){try{return typeof navigator!=='undefined'&&navigator.gpu&&!avaIsPhone()?'webgpu':'wasm'}catch(e){return 'wasm'}}
/* 'off' (Browser voice picked) · 'unsupported' · 'idle' · 'loading' · 'ready' · 'slow' · 'failed' */
function avaKokoroState(){const k=AVA.k;if(avaVoicePref()==='browser')return 'off';if(!avaKokoroSupported()&&k.state==='idle')return 'unsupported';return k.state}
function avaVoiceWarm(){
  const k=AVA.k;if(avaVoicePref()==='browser'||k.state!=='idle'||!avaKokoroSupported())return false;
  if(avaStore(AVA_SLOW_KEY)==='1'){k.state='slow';avaPaintVoice();return false;}
  let w;try{w=new Worker('ava-voice-worker.js',{type:'module'});}catch(e){k.state='failed';k.err='The natural voice could not start in this browser.';avaPaintVoice();return false;}
  k.worker=w;k.state='loading';k.device=avaKokoroDevice();k.loaded=0;k.total=0;k.startedAt=Date.now();
  w.onmessage=e=>avaKokoroMsg((e&&e.data)||{});
  w.onerror=e=>{try{e&&e.preventDefault&&e.preventDefault();}catch(x){}avaKokoroMsg({type:'error',fatal:true,message:(e&&e.message)||'worker error'});};
  w.postMessage({type:'load',device:k.device});
  avaPaintVoice();return true;
}
function avaKokoroMsg(m){
  const k=AVA.k;
  if(m.type==='device'){k.device=m.device==='webgpu'?'webgpu':'wasm';avaPaintVoice();return;}
  if(m.type==='progress'){k.loaded=Number(m.loaded)||0;k.total=Number(m.total)||0;avaPaintVoice();return;}
  if(m.type==='ready'){k.device=m.device||k.device;k.dtype=m.dtype||null;k.rtf=m.rtf==null?null:Number(m.rtf);k.warm=k.rtf!=null;/* it timed a test sentence: already warm */k.state=k.rtf!=null&&k.rtf>AVA_SLOW_RTF?'slow':'ready';k.err=null;
    if(k.state==='slow'){avaStore(AVA_SLOW_KEY,'1');try{k.worker&&k.worker.terminate&&k.worker.terminate();}catch(e){}k.worker=null;}
    avaPaintVoice();
    if(k.state==='ready'&&avaStore(AVA_NATURAL_KEY)!=='1'){avaStore(AVA_NATURAL_KEY,'1');AVA.naturalNote=true;avaNaturalNote();}
    if(typeof currentView!=='undefined'&&currentView==='settings'&&typeof trialsRepaint==='function')trialsRepaint('settings',{soft:true});return;}
  if(m.type==='audio'){avaKokoroAudio(m);return;}
  if(m.type==='error'){
    if(m.fatal){k.state='failed';k.err=String(m.message||'');try{k.worker&&k.worker.terminate&&k.worker.terminate();}catch(e){}k.worker=null;avaPaintVoice();}
    const s=AVA.say;if(s&&s.engine==='kokoro'&&(m.fatal||m.gen===s.gen))avaSayFallback(s.gen,m.fatal?s.next:(m.i!=null?Math.max(s.next,m.i):s.next));
  }
}
/* The first time the natural voice is ready she says so, once (shown, not read out), the next time the panel is open. */
function avaNaturalNote(){if(!AVA.naturalNote||!AVA.open)return false;AVA.naturalNote=false;avaPush({who:'ava',notice:true,text:"My natural voice is ready — I'll use it from my next answer. You can change it (and how fast I talk) under Voice."});return true}
function avaUseKokoro(){return avaVoicePref()!=='browser'&&AVA.k.state==='ready'&&!!AVA.k.worker}
function avaVoiceLabel(){
  const st=avaKokoroState();const v=AVA_VOICES.find(x=>x[0]===avaVoicePref());
  if(st==='off')return 'Browser voice';
  if(st==='ready')return 'Natural voice · '+(v?v[1]:'Heart');
  if(st==='loading')return "Getting Ava's natural voice ready";
  if(st==='slow')return 'This device is too slow for the natural voice — using the browser voice';
  if(st==='failed')return "The natural voice didn't load — using the browser voice";
  if(st==='unsupported')return avaIsPhone()?'On a phone Ava uses the phone’s own voice':"This browser can't run the natural voice — using its own";
  return 'Natural voice (loads the first time)';
}
function avaVoiceLoadingLine(){
  const k=AVA.k;const mb=AVA_VOICE_MB[k.device]||AVA_VOICE_MB.wasm;
  const pct=k.total>1e6?Math.min(99,Math.floor(k.loaded/k.total*100)):null;   // (the small files come first: no % until the model shows up)
  return {text:"Getting Ava's natural voice ready (one-time download, about "+mb+' MB)…',pct};
}

/* ---- saying it: sentence by sentence ---- */
/* Markdown → plain words to say: no **, lists, headings, code marks or web addresses (a link says its words). */
function avaPlain(md){
  const t=String(md||'').replace(/\r\n?/g,'\n').replace(/```[\s\S]*?```/g,' ')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g,'$1').replace(/https?:\/\/[^\s)]+/g,'').replace(/(^|\s)#(system|trial|settings|calendar|trials|paying|inquiries|stats|alerts)(\/[^\s)]*)?/g,'$1')
    .replace(/`([^`\n]+)`/g,'$1').replace(/(\*\*|__)(.+?)\1/g,'$2').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g,'$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/^\s*>\s?/gm,'').replace(/^\s*[-*•]\s+/gm,'').replace(/^\s*\d+[.)]\s+/gm,'').replace(/\*/g,'');
  return t.split(/\n+/).map(l=>l.trim()).filter(Boolean).map((l,i,a)=>i<a.length-1&&!/[.!?:;,]$/.test(l)?l+'.':l).join(' ');
}
function avaSpeakable(s){return avaPlain(s).replace(/›/g,',').replace(/\s*[—–]\s*/g,', ').replace(/[“”"]/g,'').replace(/\s+/g,' ').replace(/\s+([,.!?;:])/g,'$1').replace(/,\s*,/g,',').trim()}
/* The text in pieces to say one after the other: sentences, and a long one cut at a comma / semicolon / colon. The
   first piece is kept short so she starts talking at once. */
function avaChunks(text,more){
  const t=avaSpeakable(text);if(!t)return [];
  const sents=t.split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);
  const out=[];
  sents.forEach(s=>{
    const max=out.length||more?180:90;
    if(s.length<=max){out.push(s);return;}
    const bits=s.split(/(?<=[,;:])\s+/);let cur='';
    bits.forEach(b=>{const lim=out.length||more?180:90;if(cur&&(cur+' '+b).length>lim){out.push(cur);cur=b;}else cur=cur?cur+' '+b:b;});
    if(cur)out.push(cur);
  });
  // a scrap of two or three letters is said with the piece before it
  for(let i=out.length-1;i>0;i--)if(out[i].replace(/[^a-z0-9]/gi,'').length<4){out[i-1]+=' '+out[i];out.splice(i,1);}
  return out;
}
const AVA_VOICE_RANK=[/natural/i,/neural/i,/premium|enhanced/i,/online/i,/google us english/i,/samantha/i,/\bava\b/i,/aria/i,/jenny/i,/zira/i,/female/i,/karen/i,/serena/i];
function avaPickVoice(){
  if(AVA.voice)return AVA.voice;
  try{const vs=window.speechSynthesis.getVoices()||[];const en=vs.filter(v=>/^en(-|_|$)/i.test(v.lang));
    let best=null,bestScore=1e9;
    en.forEach(v=>{const r=AVA_VOICE_RANK.findIndex(re=>re.test(v.name));const s=(r<0?99:r)*10+(/en[-_]us/i.test(v.lang)?0:1)+(/male\b/i.test(v.name)&&!/female/i.test(v.name)?50:0);if(s<bestScore){bestScore=s;best=v;}});
    AVA.voice=best||null;}catch(e){}
  return AVA.voice;
}
/* A speaking turn that can grow while the answer streams in: avaSayBegin() → avaSayAdd(s, text) … → avaSayEnd(s).
   avaSpeak(text) is all three at once. Each piece goes to the natural voice (made while the one before plays) or the
   browser's queue as soon as it is added, so she starts talking on the first full sentence. */
function avaSayBegin(){
  avaHush();
  if(avaMuted())return null;
  if(avaVoicePref()!=='browser')avaVoiceWarm();
  const gen=++AVA.gen;
  const s={gen,parts:[],next:0,engine:null,buf:{},playing:false,final:false,done:0};
  if(avaUseKokoro()){s.engine='kokoro';s.bridge=!AVA.k.warm&&avaCanSpeak();}   // not warm yet: the first sentence in the browser's voice, at once
  else if(avaCanSpeak())s.engine='browser';else return null;
  AVA.say=s;return s;
}
function avaSayAdd(s,text){
  if(!s||AVA.say!==s||s.final)return false;
  const parts=avaChunks(text,s.parts.length>0);if(!parts.length)return false;
  parts.forEach(p=>{const i=s.parts.push(p)-1;
    if(s.engine==='kokoro'&&s.bridge&&i===0)avaBridgeUtter(s);
    else if(s.engine==='kokoro'){try{AVA.k.worker.postMessage({type:'speak',gen:s.gen,i,text:p,voice:avaVoicePref(),speed:avaSpeed()});}catch(e){}}
    else avaBrowserUtter(s,i);});
  if(!AVA.speaking){AVA.speaking=true;avaPaintMic();}
  if(s.engine==='kokoro')avaPlayNext();
  return true;
}
function avaSayEnd(s){
  if(!s||AVA.say!==s)return false;
  s.final=true;
  if(!s.parts.length){AVA.say=null;if(AVA.speaking){AVA.speaking=false;avaPaintMic();}return false;}
  if(s.engine==='browser'&&s.done>=s.parts.length)avaSpokeDone(s.gen);
  else if(s.engine==='kokoro')avaPlayNext();
  return true;
}
/* The natural voice isn't warm yet (nothing made this visit): the first piece in the browser's voice straight away,
   the rest in the natural voice after it. */
function avaBridgeUtter(s){
  const post=()=>{s.bridge=false;try{AVA.k.worker.postMessage({type:'speak',gen:s.gen,i:0,text:s.parts[0],voice:avaVoicePref(),speed:avaSpeed()});}catch(e){}};
  try{
    const v=avaPickVoice();const u=new window.SpeechSynthesisUtterance(s.parts[0]);u.lang='en-US';u.rate=Math.round(1.03*avaSpeed()*100)/100;u.pitch=1;if(v)u.voice=v;
    const fin=()=>{if(AVA.say!==s||s.next>0)return;s.next=1;avaPlayNext();};
    u.onend=fin;u.onerror=fin;window.speechSynthesis.speak(u);return true;
  }catch(e){post();return false}
}
/* Say `text`. → true when something is being said (avaSpokeDone runs at the end), false when there is nothing to say. */
function avaSpeak(text){const s=avaSayBegin();if(!s)return false;avaSayAdd(s,text);return avaSayEnd(s)}
function avaBrowserUtter(s,i){
  try{
    const v=avaPickVoice();const u=new window.SpeechSynthesisUtterance(s.parts[i]);u.lang='en-US';u.rate=Math.round(1.03*avaSpeed()*100)/100;u.pitch=1;if(v)u.voice=v;
    const fin=()=>{if(AVA.say!==s)return;s.done=Math.max(s.done,i+1);if(s.final&&s.done>=s.parts.length)avaSpokeDone(s.gen);};
    u.onend=fin;u.onerror=fin;window.speechSynthesis.speak(u);return true;
  }catch(e){return false}
}
/* The natural voice failed half-way: the rest (and anything still to come) in the browser's voice. */
function avaSayFallback(gen,from){
  const s=AVA.say;if(!s||s.gen!==gen||s.engine!=='kokoro')return;
  try{AVA.k.worker&&AVA.k.worker.postMessage({type:'cancel',gen});}catch(e){}
  avaStopSource();s.playing=false;
  if(!avaCanSpeak()){avaSpokeDone(gen);return;}
  s.engine='browser';s.done=from;
  for(let i=from;i<s.parts.length;i++)avaBrowserUtter(s,i);
  if(s.final&&from>=s.parts.length)avaSpokeDone(gen);
}
function avaAudio(){
  if(AVA.ac)return AVA.ac;const C=avaAudioClass();if(!C)return null;
  try{AVA.ac=new C();}catch(e){AVA.ac=null;}return AVA.ac;
}
/* Browsers only play sound after a tap: every tap on Ava (open, mic, send, a chip) wakes the audio up. */
function avaAudioUnlock(){if(avaVoicePref()==='browser'||!avaKokoroSupported())return;const ac=avaAudio();try{if(ac&&ac.state==='suspended'&&ac.resume)ac.resume();}catch(e){}}
function avaKokoroAudio(m){
  AVA.k.warm=true;
  const s=AVA.say;if(!s||s.engine!=='kokoro'||m.gen!==s.gen)return;
  s.buf[m.i]=m;avaPlayNext();
}
function avaPlayNext(){
  const s=AVA.say;if(!s||s.engine!=='kokoro'||s.playing)return;
  if(s.bridge&&s.next===0)return;   // the browser is saying the first piece
  if(s.next>=s.parts.length){if(s.final)avaSpokeDone(s.gen);return;}
  const m=s.buf[s.next];if(!m)return;   // still being made
  delete s.buf[s.next];
  const ac=avaAudio();if(!ac){avaSayFallback(s.gen,s.next);return;}
  try{
    if(ac.state==='suspended'&&ac.resume)ac.resume();
    const samples=m.samples instanceof Float32Array?m.samples:new Float32Array(m.samples||[]);
    const b=ac.createBuffer(1,Math.max(1,samples.length),m.rate||24000);
    if(b.copyToChannel)b.copyToChannel(samples,0);else b.getChannelData(0).set(samples);
    const src=ac.createBufferSource();src.buffer=b;src.connect(ac.destination);
    const gen=s.gen;
    src.onended=()=>{if(AVA.src===src)AVA.src=null;const t=AVA.say;if(!t||t.gen!==gen)return;t.playing=false;t.next++;avaPlayNext();};
    AVA.src=src;s.playing=true;src.start();
  }catch(e){s.playing=false;avaSayFallback(s.gen,s.next);}
}
function avaStopSource(){const src=AVA.src;AVA.src=null;if(src){try{src.onended=null;src.stop();}catch(e){}}}
/* Stop talking now (barge-in): the sound playing, what is queued in the browser and in the worker. */
function avaHush(){
  const s=AVA.say;AVA.say=null;AVA.gen++;
  avaStopSource();
  if(s&&s.engine==='kokoro'){try{AVA.k.worker&&AVA.k.worker.postMessage({type:'cancel',gen:s.gen});}catch(e){}}
  try{if(avaCanSpeak())window.speechSynthesis.cancel();}catch(e){}
  if(AVA.speaking){AVA.speaking=false;avaPaintMic();}
}
/* She finished an answer. Hands-free: listen again (unless "stop" / "thanks Ava" or a tap paused it). */
function avaSpokeDone(gen){
  if(gen!=null&&AVA.say&&AVA.say.gen!==gen)return;
  if(gen!=null&&!AVA.say)return;
  AVA.say=null;AVA.speaking=false;avaPaintMic();
  avaAfterAnswer();
}
function avaAfterAnswer(){
  if(!avaHandsFree()||AVA.loopPaused||!AVA.open||AVA.listening||AVA.speaking||AVA.busy||!avaCanListen())return false;
  clearTimeout(AVA.loopTimer);AVA.loopTimer=setTimeout(()=>{if(avaHandsFree()&&!AVA.loopPaused&&AVA.open&&!AVA.listening&&!AVA.speaking&&!AVA.busy)avaListen({auto:true});},300);
  return true;
}

/* ===================== 7. EARS: talking to her ===================== */
function avaRecClass(){try{return (typeof window!=='undefined'&&(window.SpeechRecognition||window.webkitSpeechRecognition))||null}catch(e){return null}}
function avaCanListen(){return !!avaRecClass()}
const AVA_END_MS=500;            // quiet this long after the browser's last final words: send
const AVA_END_INTERIM_MS=1200;   // only words still being guessed: wait a little longer
const AVA_MIC_GUIDE=['Click the lock icon at the left of the address bar.','Set Microphone to Allow.','Reload the page, then tap the mic again.'];
/* Tap the mic: stop her talking and listen. While listening, a tap stops (and pauses hands-free). */
function avaListen(opts){
  opts=opts||{};
  const R=avaRecClass();
  if(!R){avaNote("Voice isn't available in this browser — type your question instead. (It works in Chrome, Edge and Safari.)");avaFocusInput();return false;}
  if(AVA.listening){avaStopListening({user:true});return false;}
  avaHush();avaAudioUnlock();
  if(!opts.auto){AVA.loopPaused=false;}
  if(!opts.retry)AVA.retried=0;
  let rec;try{rec=new R();}catch(e){avaNote("Voice didn't start — type your question instead.");return false;}
  // push-to-talk (hold Space / hold the mic): keep listening through pauses until it is let go
  const ptt=!!opts.ptt;rec._ptt=ptt;
  rec.lang='en-US';rec.interimResults=true;rec.continuous=ptt;rec.maxAlternatives=1;
  let final='',interim='',err=null;
  // they stopped talking: send what the browser heard at once — no waiting for it to notice, or for its onend
  const quiet=ms=>{clearTimeout(AVA.silence);AVA.silence=setTimeout(()=>{if(AVA.rec!==rec)return;
    const w=avaRecWords(rec);
    if(w&&!rec._ptt&&!rec._defer){rec._discard=true;try{rec.stop();}catch(e){}AVA.rec=null;AVA.listening=false;AVA.interim='';avaPaintHeard();avaPaintMic();avaAsk(w,{voice:true});}
    else{try{rec.stop();}catch(e){}}},ms);};
  rec.onresult=e=>{interim='';for(let i=e.resultIndex;i<e.results.length;i++){const r=e.results[i];if(r.isFinal)final+=r[0].transcript;else interim+=r[0].transcript;}
    rec._final=final;rec._interim=interim;
    AVA.interim=(final+' '+interim).trim();avaPaintHeard();
    if(AVA.interim&&!rec._ptt)quiet(final&&!interim.trim()?AVA_END_MS:AVA_END_INTERIM_MS);};
  rec.onerror=e=>{err=(e&&e.error)||'unknown';
    if(err==='not-allowed'||err==='service-not-allowed')avaMicBlocked();
    else if(err==='audio-capture')avaNote("I can't find a microphone. Plug one in (or pick it in the browser's settings), or type instead.");
    else if(err==='network'&&AVA.retried>=1)avaNote("Voice-to-text needs the internet in this browser, and it didn't answer. Type instead, or try again in a moment.");
    else if(err==='language-not-supported')avaNote("This browser can't turn English speech into text. Type instead.");};
  rec.onend=()=>{
    clearTimeout(AVA.silence);
    if(AVA.rec===rec){AVA.rec=null;AVA.listening=false;}
    const said=((final+' '+interim).trim()||'').trim();AVA.interim='';avaPaintHeard();avaPaintMic();
    if(rec._defer){rec._said=said;if(rec._deferRes)rec._deferRes(said);return;}   // a hold with a recording: avaHoldSend decides
    if(rec._discard)return;   // a short tap on Space / the mic: not a question
    if(said){avaAsk(said,{voice:true});return;}
    if(rec._ptt&&!err){avaNote(avaIsPhone()?"I didn't hear anything — hold the mic while you talk, then let go.":"I didn't hear anything — hold Space while you talk, then let go.");return;}
    if(rec._userStop||err==='not-allowed'||err==='service-not-allowed'||err==='audio-capture'||err==='aborted'||err==='language-not-supported')return;
    // nothing heard / the speech service hiccuped: try once more by itself, then say so
    if(AVA.open&&(AVA.retried||0)<1&&(err==null||err==='no-speech'||err==='network')){AVA.retried=(AVA.retried||0)+1;avaListen({auto:true,retry:true});return;}
    if(err==null||err==='no-speech'){avaNote("I didn't hear anything. Tap the mic and speak, or type.");AVA.loopPaused=true;}
  };
  AVA.rec=rec;AVA.listening=true;AVA.ptting=ptt;AVA.interim='';avaPaintMic();avaPaintHeard();if(!opts.retry)avaNote('');
  try{rec.start();}catch(e){AVA.listening=false;AVA.rec=null;avaPaintMic();avaPaintHeard();avaNote("Voice didn't start — tap the mic again, or type.");return false;}
  return true;
}
/* What the browser has heard so far on this recogniser (its final words, then the words still being guessed). */
function avaRecWords(rec){return rec?String(((rec._final||'')+' '+(rec._interim||'')).replace(/\s+/g,' ')).trim():''}
/* opts.user: a tap stopped it (pauses hands-free; what was heard is still sent) · opts.discard: throw away what was heard
   (a short tap on Space) · otherwise: stop and send (letting go of Space / the mic). */
function avaStopListening(opts){
  opts=opts||{};clearTimeout(AVA.silence);const rec=AVA.rec;
  if(opts.user){AVA.loopPaused=true;if(rec)rec._userStop=true;}
  if(opts.discard&&rec)rec._discard=true;
  try{if(rec){if(opts.discard&&typeof rec.abort==='function')rec.abort();else rec.stop();}}catch(e){}
  AVA.listening=false;AVA.ptting=false;avaPaintMic();avaPaintHeard();
}

/* ---- push-to-talk: hold Space (anywhere but a text box) or hold the mic / the round button ----
   Down: open Ava if she's closed and listen at once. Up: stop and send. A short tap (under AVA_TAP_MS) is not a question:
   Space toggles the panel, the round button opens her and listens as before, the mic listens until you stop talking. */
const AVA_TAP_MS=250;
function avaEditable(t){
  if(!t||typeof t!=='object')return false;
  const tag=String(t.tagName||'').toUpperCase();if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return true;
  if(t.isContentEditable===true)return true;
  const ce=typeof t.getAttribute==='function'?t.getAttribute('contenteditable'):null;return ce!=null&&ce!=='false';
}
function avaModalOpen(){const w=avaEl('modalWrap');const c=avaEl('cmdk');return !!((w&&w.classList&&w.classList.contains('open'))||(c&&c.classList&&c.classList.contains('open')))}
function avaHoldStart(src){
  if(AVA.ptt)return false;
  avaAudioUnlock();avaWarm();avaAiCheck();   // both in the background: never in the way of the question
  const wasOpen=AVA.open;
  AVA.ptt={src,at:Date.now(),wasOpen,cap:null};
  if(!wasOpen)avaOpen({listen:false,quiet:true});
  const web=avaCanListen();
  if(!web&&!avaHearOn()){avaHush();avaNote("Voice isn't available in this browser — type your question instead. (It works in Chrome, Edge and Safari.)");return false;}
  if(AVA.listening)avaStopListening({discard:true});
  let ok=false;
  if(web)ok=avaListen({ptt:true});
  else{avaHush();AVA.listening=true;AVA.ptting=true;AVA.rec=null;AVA.interim='';avaNote('');avaPaintMic();avaPaintHeard();ok=true;}   // no words in this browser: the recording only
  if(ok&&AVA.ptt)AVA.ptt.cap=avaCaptureStart();
  return ok;
}
/* → 'tap' | 'hold' | 'cancel' | null */
function avaHoldEnd(cancel){
  const p=AVA.ptt;if(!p)return null;AVA.ptt=null;
  const held=Date.now()-p.at>=AVA_TAP_MS;
  const rec=AVA.listening&&AVA.rec&&AVA.rec._ptt?AVA.rec:null;
  const bare=AVA.listening&&!AVA.rec&&AVA.ptting;   // recording only (no words from this browser)
  const drop=()=>{if(rec)avaStopListening({discard:true});else if(bare)avaStopListening({});avaCaptureKill(p.cap);};
  if(cancel){drop();return 'cancel';}
  if(held){
    // the browser already has the words: send them now (no /hear round trip, no waiting for its onend)
    const now=rec?avaRecWords(rec):'';
    if(now){rec._discard=true;avaStopListening({});avaCaptureKill(p.cap);AVA.interim='';avaPaintHeard();avaAsk(now,{voice:true});return 'hold';}
    if(p.cap&&p.cap.rec&&(rec||bare)){avaHoldSend(p.cap,rec);return 'hold';}
    avaCaptureKill(p.cap);
    if(rec)avaStopListening({});
    else if(bare){avaStopListening({});avaNote("I couldn't record your voice here — allow the microphone, or type your question.");}
    return 'hold';
  }
  // a tap
  if(p.src==='space'){drop();if(p.wasOpen)avaClose();else avaTipSeen();return 'tap';}
  if(p.src==='fab'){if(p.wasOpen){drop();avaClose();}else{avaCaptureKill(p.cap);if(rec){rec._ptt=false;AVA.ptting=false;avaPaintHeard();}else if(bare)avaStopListening({});}return 'tap';}
  // the mic: carry on listening, and send when they stop talking (tap-to-talk)
  avaCaptureKill(p.cap);if(rec){rec._ptt=false;AVA.ptting=false;avaPaintHeard();}else if(bare)avaStopListening({});
  return 'tap';
}
function avaPointer(e,src){
  AVA.holdAt=Date.now();
  if(e&&e.button!=null&&e.button!==0)return;
  if(src==='mic'&&AVA.listening){avaStopListening({user:true});return;}   // a tap while listening stops it
  if(src==='fab'&&AVA.open){AVA.ptt={src,at:Date.now(),wasOpen:true};return;}
  try{e&&e.currentTarget&&e.currentTarget.setPointerCapture&&e.currentTarget.setPointerCapture(e.pointerId);}catch(x){}
  avaHoldStart(src);
}
function avaPointerUp(e,cancel){if(AVA.ptt&&AVA.ptt.src!=='space')avaHoldEnd(!!cancel);}
/* A click after a pointer press was handled already; a click from the keyboard (Enter) is a plain tap. */
function avaFabClick(){if(Date.now()-(AVA.holdAt||0)<1500)return;avaFabTap();}
function avaMicClick(){if(Date.now()-(AVA.holdAt||0)<1500)return;avaMicTap();}
/* The browser said no to the microphone: a short guide, once per visit, and typing still works. */
function avaMicBlocked(){
  AVA.loopPaused=true;
  avaNote('The microphone is blocked for this site. Allow it (see the steps above), or type instead.');
  if(AVA.micGuided)return;AVA.micGuided=true;
  avaPush({who:'ava',text:"Your microphone is blocked for this site, so I can't hear you yet. To fix it:",guide:AVA_MIC_GUIDE});
}
/* Before listening: if the browser already knows the mic is blocked, show the guide straight away. */
function avaMicCheck(){
  try{if(typeof navigator!=='undefined'&&navigator.permissions&&navigator.permissions.query)
    return navigator.permissions.query({name:'microphone'}).then(p=>{if(p&&p.state==='denied')avaMicBlocked();return p&&p.state;}).catch(()=>null);}catch(e){}
  return Promise.resolve(null);
}

/* ===================== 8. THE AI BRAIN (the machine's AI, when a key is set) — asked first =====================
   GET  /api/mc/ava/status   → {ready, brains:[{id, name, ready, model, lastError, lastOkAt}]}
   POST /api/mc/ava/chat?stream=1   (accept: text/event-stream, application/json)
        {messages:[{role,content}] (the last 16 turns), page:{view, clientId, clientName, tab}, user:{firstName, role}, stream:true}
        → a stream (content-type text/event-stream) of
            event: delta    data: {"text":"…"}                       the next bit of the answer
            event: actions  data: {"actions":[…]}                    navigate {view, id?, tab?, section?} / read {what:"page"} / confirm / draft
            event: done     data: {"brain":"groq","tried":[…],"suggestions":[…],"timing":{firstTokenMs,…}}
            event: error    data: {"error":"…","needsKeys":true?,"status":429?}
        → or the plain JSON answer {reply, actions, brain, tried, suggestions?} | {error, needsKeys:true}
   GET/POST /api/mc/ava/requests → {requests:[{id, at, by, text, status}]}; POST {action:'add', text} / {action:'done', id}
   AI first: when a brain is on, EVERY question goes to it — except a plain command ("open trials", "open Lakeview",
   "go back", "settings"), which runs at once here. The local brain (avaThink) answers only when the AI can't (no key,
   not updated, today's limit, down, offline) — and then says plainly that she is in basic mode. Email addresses are
   taken out of what is sent. */
const AVA_AI={off:null,offUntil:0,noted:false,brains:null,ready:null,readyAt:0,checking:null};
const AVA_BRAIN_NAMES={groq:'Groq',gemini:'Gemini',google:'Gemini',cerebras:'Cerebras',openrouter:'OpenRouter',mistral:'Mistral',cloudflare:'Cloudflare',github:'GitHub Models',sambanova:'SambaNova',together:'Together',local:'this device'};
const AVA_HISTORY=16;
function avaBrainName(b){
  if(b&&typeof b==='object')b=b.name||b.id;b=String(b||'').trim();if(!b)return 'AI';
  const known=(AVA_AI.brains||[]).find(x=>x&&(x.id===b||x.name===b));if(known&&known.name)return String(known.name);
  return AVA_BRAIN_NAMES[b.toLowerCase()]||b.charAt(0).toUpperCase()+b.slice(1);
}
function avaScrub(s){return String(s||'').replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi,'[email]').slice(0,1200)}
function avaTrim(s,n){s=String(s||'');return s.length>n?s.slice(0,n-1).trimEnd()+'…':s}
/* The conversation so far (the last 16 turns; long answers cut down), as the AI reads it. */
function avaHistory(){
  return AVA.log.filter(m=>(m.who==='you'||m.who==='ava')&&!m.notice&&!m.streaming&&m.text).slice(-AVA_HISTORY).map(m=>({role:m.who==='you'?'user':'assistant',content:avaTrim(avaScrub(m.text),m.who==='you'?1000:700)}));
}
function avaPage(){
  const v=typeof currentView!=='undefined'?currentView:'';
  const id=typeof currentTrialId!=='undefined'&&currentTrialId!=null?String(currentTrialId):null;
  const inClient=id&&['trial','clientSystem','trialPurchase'].includes(v);
  return {view:v,clientId:id,clientName:inClient?avaClientName(id):null,tab:v==='clientSystem'&&typeof trialTab!=='undefined'?trialTab:null};
}
function avaUser(){const u=typeof authUser!=='undefined'&&authUser?authUser:null;return {firstName:u?avaFirst(u.name||u.email):'',role:avaOwner()?'owner':'team'}}
/* Is the AI switched on? (GET /api/mc/ava/status — for anyone signed in, kept a minute.) Only a clear "not ready"
   stops her asking it; not knowing (404, offline, not allowed) still lets her try. */
function avaAiCheck(force){
  if(typeof machineFetch!=='function')return Promise.resolve(null);
  if(!force&&(AVA_AI.checking||(AVA_AI.readyAt&&Date.now()-AVA_AI.readyAt<60000)))return AVA_AI.checking||Promise.resolve(AVA_AI.ready);
  AVA_AI.checking=Promise.resolve(machineFetch('/api/mc/ava/status',{timeout:8000})).then(r=>{
    AVA_AI.checking=null;AVA_AI.readyAt=Date.now();const d=r&&r.ok&&r.data;
    if(d&&Array.isArray(d.brains))AVA_AI.brains=d.brains;
    if(d)AVA_AI.ready=d.ready!=null?!!d.ready:Array.isArray(d.brains)?d.brains.some(b=>b&&b.ready):null;
    else AVA_AI.ready=null;
    avaPaintHead();return AVA_AI.ready;
  }).catch(()=>{AVA_AI.checking=null;return null;});
  return AVA_AI.checking;
}
/* Wake the AI up while they are still talking (GET /api/mc/ava/warm — cheap; at most once a minute, never waited for). */
const AVA_WARM={at:0};
function avaWarm(){
  if(typeof machineFetch!=='function'||Date.now()-AVA_WARM.at<60000)return null;AVA_WARM.at=Date.now();
  try{return Promise.resolve(machineFetch('/api/mc/ava/warm',{timeout:5000})).catch(()=>null);}catch(e){return null}
}
/* Server-sent events: split what has arrived into whole events ({event, data}); the rest waits for more. */
function avaSseSplit(buf){
  const events=[];buf=String(buf||'').replace(/\r\n/g,'\n');let i;
  while((i=buf.indexOf('\n\n'))>=0){
    const block=buf.slice(0,i);buf=buf.slice(i+2);
    let ev='message';const data=[];
    block.split('\n').forEach(line=>{if(!line||line[0]===':')return;const c=line.indexOf(':');const f=c<0?line:line.slice(0,c);let v=c<0?'':line.slice(c+1);if(v[0]===' ')v=v.slice(1);if(f==='event')ev=v.trim();else if(f==='data')data.push(v);});
    if(!data.length)continue;
    const raw=data.join('\n');let d=raw;try{d=JSON.parse(raw);}catch(e){d=raw;}
    events.push({event:ev,data:d});
  }
  return {events,rest:buf};
}
/* POST to the machine asking for a stream; reads it as it comes (on.delta(fullText, newBit)) — or the usual JSON when
   the machine answers with JSON. Same sign-in as machineFetch (tkToken). Never throws.
   → {ok, status, data:{reply, actions, brain, tried, suggestions, …}, error, streamed?, cut?} */
async function avaStreamFetch(path,body,on){
  on=on||{};
  const token=typeof tkToken==='function'?await tkToken():null;
  if(!token)return {ok:false,status:0,data:null,error:'You are not signed in any more. Sign out, then sign in again.'};
  const base=typeof tkMachineUrl==='function'?tkMachineUrl():'';
  const url=base+path+(path.indexOf('?')>=0?'&':'?')+'stream=1';
  const init={method:'POST',headers:{authorization:'Bearer '+token,accept:'text/event-stream, application/json','content-type':'application/json'},body:JSON.stringify(body)};
  let ctrl=null,timer=null;
  const arm=ms=>{if(!ctrl)return;clearTimeout(timer);timer=setTimeout(()=>{try{ctrl.abort();}catch(e){}},ms);};
  if(typeof AbortController!=='undefined'){ctrl=new AbortController();init.signal=ctrl.signal;arm(on.timeout||30000);}
  let res;
  try{res=await fetch(url,init);}
  catch(e){clearTimeout(timer);const to=e&&e.name==='AbortError';return {ok:false,status:0,data:null,error:to?'took too long':String((e&&e.message)||'fetch failed')};}
  let type='';try{type=String((res.headers&&typeof res.headers.get==='function'&&res.headers.get('content-type'))||'');}catch(e){}
  if(res.ok&&/text\/event-stream/i.test(type)&&res.body&&typeof res.body.getReader==='function'){
    const d={reply:'',actions:[],brain:null,tried:null,suggestions:null};
    const out={ok:true,status:res.status,streamed:true,data:d,error:null};
    const dec=typeof TextDecoder==='function'?new TextDecoder():null;
    const handle=x=>{
      const v=x.data;const o=v&&typeof v==='object'?v:{};
      if(x.event==='delta'||(x.event==='message'&&(typeof v==='string'||o.text!=null))){
        const bit=typeof v==='string'?v:String(o.text!=null?o.text:o.delta!=null?o.delta:'');if(!bit)return;
        d.reply+=bit;if(on.delta)try{on.delta(d.reply,bit);}catch(e){}return;}
      if(x.event==='actions'){if(Array.isArray(o.actions))d.actions=d.actions.concat(o.actions);if(Array.isArray(o.suggestions))d.suggestions=o.suggestions;return;}
      if(x.event==='suggestions'){if(Array.isArray(o.suggestions))d.suggestions=o.suggestions;else if(Array.isArray(v))d.suggestions=v;return;}
      if(x.event==='done'){if(o.brain)d.brain=o.brain;if(o.timing!=null)d.timing=o.timing;if(o.tried)d.tried=o.tried;if(Array.isArray(o.suggestions))d.suggestions=o.suggestions;if(Array.isArray(o.actions))d.actions=d.actions.concat(o.actions);
        if(!d.reply&&typeof o.reply==='string'){d.reply=o.reply;if(on.delta)try{on.delta(d.reply,o.reply);}catch(e){}}out.done=true;return;}
      if(x.event==='error'){const msg=String(o.error||o.message||(typeof v==='string'?v:'')||'The AI stopped answering.');
        if(d.reply){out.cut=true;out.error=msg;}else{out.ok=false;out.status=Number(o.status)||502;out.error=msg;if(o.needsKeys)d.needsKeys=true;d.error=msg;if(o.tried)d.tried=o.tried;}
        out.done=true;}
    };
    try{
      const reader=res.body.getReader();let buf='';
      while(!out.done){
        arm(on.idle||25000);
        const r=await reader.read();if(!r||r.done)break;
        const val=r.value;buf+=typeof val==='string'?val:dec?dec.decode(val,{stream:true}):String(val||'');
        const sp=avaSseSplit(buf);buf=sp.rest;sp.events.forEach(handle);
      }
      if(!out.done){if(dec)buf+=dec.decode();if(buf.trim())avaSseSplit(buf+'\n\n').events.forEach(handle);}
      if(out.done&&reader.cancel)try{reader.cancel();}catch(e){}
    }catch(e){if(d.reply){out.cut=true;out.error='The connection dropped.';}else{out.ok=false;out.status=0;out.error=e&&e.name==='AbortError'?'took too long':String((e&&e.message)||'stream failed');}}
    clearTimeout(timer);
    return out;
  }
  clearTimeout(timer);
  let text='';try{text=await res.text();}catch(e){text='';}
  let data=null;if(text){try{data=JSON.parse(text);}catch(e){data=null;}}
  if(!res.ok)return {ok:false,status:res.status,data,error:(data&&(data.error||data.message))||('HTTP '+res.status)};
  if(data===null)return {ok:false,status:res.status,data:null,error:'unreadable'};
  return {ok:true,status:res.status,data,error:null};
}
/* → {reply, actions, brain, tried, suggestions, ms, streamed, cut} or {off:'keys'|'missing'|'limit'|'net', error} */
async function avaAi(on){
  if(typeof tkToken!=='function'||typeof fetch!=='function')return {off:'net'};
  if(AVA_AI.off&&Date.now()<AVA_AI.offUntil)return {off:AVA_AI.off};
  if(AVA_AI.ready===false&&Date.now()-AVA_AI.readyAt<60000)return {off:'keys'};
  const t0=Date.now();
  let r;try{r=await avaStreamFetch('/api/mc/ava/chat',Object.assign({messages:avaHistory(),page:avaPage(),user:avaUser(),stream:true},on&&on.voice?{voice:true}:{}),on);}catch(e){r={ok:false,status:0,error:String(e&&e.message||e)};}
  const ms=Date.now()-t0;const d=(r&&r.data)||{};
  const reply=typeof d.reply==='string'?d.reply.trim():'';
  if(r&&r.ok&&reply){AVA_AI.off=null;AVA_AI.ready=true;AVA_AI.noted=false;
    return {reply,raw:d.reply,actions:Array.isArray(d.actions)?d.actions:[],brain:d.brain,tried:d.tried,timing:d.timing!=null?d.timing:null,suggestions:Array.isArray(d.suggestions)?d.suggestions.filter(x=>typeof x==='string'&&x.trim()).slice(0,4):null,ms,streamed:!!r.streamed,cut:!!r.cut};}
  // 503 {needsKeys}: no key yet · 404: the machine isn't updated · 429: today's limit · 502: no brain answered · offline
  if(d.needsKeys){AVA_AI.off='keys';AVA_AI.ready=false;AVA_AI.readyAt=Date.now();AVA_AI.offUntil=Date.now()+5*60e3;return {off:'keys'};}
  if(r&&r.status===404){AVA_AI.off='missing';AVA_AI.offUntil=Date.now()+5*60e3;return {off:'missing'};}
  if(r&&r.status===429){AVA_AI.off='limit';AVA_AI.offUntil=Date.now()+10*60e3;return {off:'limit',error:d.error||''};}
  return {off:r&&r.status>=500?'down':'net',error:(r&&r.error)||d.error||''};
}
/* A plain command that runs at once without the AI: "open trials", "go to the calendar", "settings", "open Lakeview",
   "show Lakeview's conversations", "go back". Anything with a question in it is not one. */
const AVA_CMD_VERB=/^(?:(?:hey )?ava )?(?:please )?(open|show(?: me)?|go to|goto|take me to|switch to|bring up|jump to|navigate to|pull up)\b\s*/;
function avaIsCommand(text){
  let t=avaNorm(text).replace(/\s+please$/,'').replace(/^please\s+/,'');if(!t)return false;
  if(/^(go )?back$|^go back( please)?$|^previous page$/.test(t))return true;
  if(/\b(how|what|why|when|who|which|whose|did|does|do|is|are|was|were|can|could|should|would|will|many|much|if|and|then|tell|explain|summari[sz]e|draft|write|compare)\b|\d/.test(t.replace(AVA_CMD_VERB,'')))return false;
  const m=t.match(AVA_CMD_VERB);const verb=!!m;const rem=(m?t.slice(m[0].length):t).replace(/^(the|my|our)\s+/,'').trim();
  if(!rem)return false;
  const fill=/\b(the|my|our|page|pages|tab|section|clients?|list|screen|settings|now)\b/g;
  for(const p of AVA_PLACES){
    const re=new RegExp(p[1].source,'g');if(!re.test(rem))continue;
    if(!rem.replace(new RegExp(p[1].source,'g'),' ').replace(fill,' ').trim())return true;
  }
  if(!verb)return false;
  const c=avaFindClient(rem);if(!c)return false;
  return rem.split(' ').length<=avaNorm(c.name).split(' ').length+3;
}
function avaSecs(ms){return (Math.max(0,Number(ms)||0)/1000).toFixed(1)+' s'}
/* The machine's done.timing → milliseconds to the first word, or null: a number, or {firstWordMs | firstTokenMs |
   firstMs | ttfbMs | first}. */
function avaFirstWord(t){
  if(t==null)return null;
  const v=typeof t==='object'?[t.firstWordMs,t.firstTokenMs,t.firstMs,t.ttfbMs,t.ttfwMs,t.first].find(x=>x!=null&&x!==''&&!isNaN(Number(x))):t;
  const n=Number(v);return v!=null&&v!==''&&isFinite(n)&&n>=0?n:null;
}
const AVA_GO_WORDS=/\b(open|show|go to|go|take me|bring up|switch to|jump to|navigate|see)\b/;
/* The machine's views → Ava's places (AVA_PLACES keys); settings and client are handled on their own. */
const AVA_NAV_PLACE={trials:'trials',paying:'paying',calendar:'calendar',team:'team',mystats:'mystats',activity:'activity',people:'activity',inquiries:'inquiries',behind:'behind',trialsBoard:'behind'};
/* A client-system tab key (overview, conversations, sent, calls, messages, money, health, leads, setup) → its label and
   whether it is in the owner's "Only you" part. */
function avaTabInfo(tab){
  const raw=String(tab||'');const k=typeof tkTabKey==='function'?tkTabKey(raw):raw;
  const w=Object.keys(AVA_TABS).find(x=>x===k||AVA_TABS[x].keys.includes(k))||Object.keys(AVA_TABS).find(x=>x===raw||AVA_TABS[x].keys.includes(raw));const spec=w?AVA_TABS[w]:null;
  return {key:k,label:spec?spec.label:k.charAt(0).toUpperCase()+k.slice(1),owner:spec?!!spec.owner:k==='money'};
}
/* A navigate action {view, id?, tab?, section?} → an action that goes there, with what she says once it is open
   (`here`). null when it's not a place this person may open — `why.owner` is set when it is the owner's only. */
function avaNavAct(a,ctx,why){
  why=why||{};ctx=ctx||avaCtx();
  const view=String(a.view||'');const id=a.id!=null&&a.id!==''?String(a.id):null;const tab=a.tab?String(a.tab):null;
  if(view==='client'||view==='trial'||view==='clientSystem'){
    if(!id)return null;
    const name=avaClientName(id);
    if(!tab&&view!=='clientSystem')return avaAct('Open '+name,()=>openTrial(id),{here:"Here's "+name+'.',view:'trial'});
    const info=avaTabInfo(tab||'overview');if(info.owner&&!ctx.owner){why.owner=true;why.what=info.label.toLowerCase();return null;}
    const key=typeof tkSysValid==='function'?tkSysValid(info.key):info.key;
    return avaAct('Open '+avaPossessive(name)+' '+info.label.toLowerCase(),()=>typeof tkOpenSystem==='function'?tkOpenSystem(id,key):openTrial(id),{here:"Here's "+avaPossessive(name)+' '+info.label.toLowerCase()+'.',view:'clientSystem',tab:key});
  }
  if(view==='settings'){
    if(!ctx.owner){why.owner=true;why.what='Settings';return null;}
    const want=String(a.section||tab||'');const sec=want&&typeof TK_SETTINGS!=='undefined'&&TK_SETTINGS.includes(want)?want:null;
    return avaAct('Open Settings'+(sec?' › '+avaSetName(sec):''),()=>openSettings(sec),{here:sec?"Here's "+avaSetName(sec)+' in Settings.':"Here's Settings.",view:'settings',section:sec});
  }
  const key=AVA_NAV_PLACE[view];if(!key)return null;
  const p=avaPlace(key);if(!p)return null;
  if(p.owner&&!ctx.owner){why.owner=true;why.what=AVA_PLACES.find(x=>x[0]===key)[2];return null;}
  p.here=avaHere(key);return p;
}
function avaSetName(k){return ({alerts:'Alerts',phone:'Phone alerts',details:'Your details',keys:'Keys',ava:'Ava',google:'Google Meet',inboxes:'Inboxes & domains',warmup:'Warm-up',replybot:'Reply bot',demo:'Test run',status:'Is everything running?',behind:'Behind the scenes',advanced:'Advanced',look:'Light or dark',account:'Your account'})[k]||k}
function avaClientName(id){const c=avaClients().find(x=>x.id===String(id));return c?c.name:(typeof tkClientName==='function'?tkClientName(id):String(id))}
/* What a "confirm" card may do — each only when its button is pressed (or "yes" is said right after), with the hub's
   own functions. owner: the owner only (a team member never sees the card). */
const AVA_DO={
  open_add_trial:{owner:true,ok:()=>true,run:()=>{render('trials');openNewTrialClient();}},
  open_add_paid:{owner:true,ok:()=>true,run:()=>{render('paying');openNewPayingClient();}},
  open_client:{ok:a=>!!a.id,run:a=>openTrial(String(a.id))},
  mark_todo_seen:{owner:true,ok:a=>!!a.todoId,run:a=>trialsTodoAction(String(a.todoId))},
  give_access:{owner:true,ok:a=>!!a.id,run:a=>tkOpenSystem(String(a.id),'setup','access')},
  load_test_run:{owner:true,ok:()=>true,run:()=>{openSettings('demo');return demoAction('load');}},
  remove_test_run:{owner:true,ok:()=>true,run:()=>{openSettings('demo');return demoAction('remove');}},
  set_my_status:{ok:a=>typeof a.text==='string',run:a=>avaSetStatus(a.text)},
  add_change_request:{ok:a=>!!String(a.text||'').trim(),run:a=>avaAddRequest(a.text)},
};
/* The AI's answer → Ava's usual {say, actions, auto?, cards, meta}. */
function avaFromAi(ai,text,ctx){
  const acts=[],cards=[];let auto=null,read=null,refused=null;
  const list=(ai.actions||[]).filter(a=>a&&typeof a==='object');
  // "read" (read the screen out): after the place it goes to (if any) is open and has loaded — so that place opens at once
  const wantsRead=list.some(a=>a.type==='read');
  const asked=wantsRead||AVA_GO_WORDS.test(avaNorm(text))||avaReadCmd(text)!=null;
  list.forEach(a=>{
    if(a.type==='read'){read={what:String(a.what||'page')};return;}
    if(a.type==='navigate'){const why={};const x=avaNavAct(a,ctx,why);if(!x){if(why.owner&&!refused)refused=why.what||'that page';return;}if(asked&&!auto)auto=x;else acts.push(x);return;}
    if(a.type==='confirm'){const d=AVA_DO[a.name];const args=a.args&&typeof a.args==='object'?a.args:{};
      if(!d||(d.owner&&!ctx.owner)||!d.ok(args))return;
      cards.push({kind:'confirm',label:String(a.label||a.name).trim(),name:a.name,args,state:null});return;}
    if(a.type==='draft'&&String(a.text||'').trim()){cards.push({kind:'draft',title:String(a.title||'A draft').trim(),text:String(a.text)});}
  });
  const conf=cards.filter(c=>c.kind==='confirm').pop();
  if(conf)AVA.pending={act:{label:conf.label,run:()=>avaCardDo(conf,true)},done:'Done.',card:conf};
  const first=avaFirstWord(ai.timing);
  return {say:ai.reply,raw:ai.raw,actions:acts.slice(0,4),auto,read,refused:refused?"That's only for the owner — "+refused+". I can show you anything else.":null,cards,chips:ai.suggestions&&ai.suggestions.length?ai.suggestions:null,
    meta:'answered by '+avaBrainName(ai.brain)+' · '+avaSecs(ai.ms)+(first!=null?' · '+avaSecs(first)+' to first word':''),ai:true,confirm:!!conf,cut:!!ai.cut,streamed:!!ai.streamed};
}
/* AI first. A plain command (and a "yes" / "no" to Ava's own question) runs here at once; everything else goes to the
   AI; the local brain answers only when the AI can't — marked as basic mode. `on.delta` gets the answer as it streams. */
async function avaAnswer(text,ctx,on){
  const t=avaNorm(text);
  if((AVA.pending&&(AVA_YES.test(t)||AVA_NO.test(t)))||avaIsCommand(text)||avaReadCmd(text)){
    const r=await avaThink(text,ctx);if(r&&typeof r==='object'){r.local=true;if(!r.meta)r.meta='instant, on this device';}return r;
  }
  AVA.pending=null;
  const ai=await avaAi(on);
  if(ai.reply)return avaFromAi(ai,text,ctx);
  const local=(await avaThink(text,ctx))||avaReply("I'm not sure.",[]);
  local.basic=ai.off||'net';local.meta='basic mode';
  if(AVA_AI.noted!==local.basic){AVA_AI.noted=local.basic;local.aiNote=local.basic;}
  return local;
}
/* Basic mode, said plainly — and what to do about it. */
function avaAiNoteMsg(kind,ctx){
  const lead="I'm in basic mode right now, so I can only answer simple things about the hub. ";
  if(kind==='limit')return {who:'ava',notice:true,basic:kind,text:lead+"My AI brain has reached today's limit — I'll try it again in a few minutes."};
  if(kind==='missing')return {who:'ava',notice:true,basic:kind,text:lead+"My AI brain needs your system to be updated first."};
  if(kind==='down')return {who:'ava',notice:true,basic:kind,text:lead+"My AI brain didn't answer just now — ask again in a minute."};
  if(kind==='net')return {who:'ava',notice:true,basic:kind,text:lead+"I couldn't reach my AI brain — check your internet. I'll try again with your next question."};
  return ctx.owner?{who:'ava',notice:true,basic:kind,text:lead+"My AI brain isn't switched on yet — add a free key in Settings › Keys.",actions:[avaAct('Open Settings › Keys',()=>openSettings('keys'))]}
    :{who:'ava',notice:true,basic:kind,text:lead+"My AI brain isn't switched on yet — the owner can add a free key in Settings › Keys."};
}
/* A confirm card's buttons: Do it runs the hub's own function; No does nothing. Each card answers once. */
function avaCardDo(card,yes){
  if(!card||card.state)return false;
  if(AVA.pending&&AVA.pending.card===card)AVA.pending=null;
  const d=AVA_DO[card.name];
  if(!yes||!d||(d.owner&&!avaOwner())){card.state='no';avaPaintLog();return false;}
  card.state='done';
  try{const p=d.run(card.args||{});if(p&&typeof p.catch==='function')p.catch(()=>{});}catch(e){card.state='failed';}
  avaPaintLog();return true;
}
function avaCard(n,yes){const c=(AVA.cardList||[])[n];if(!c)return;avaAudioUnlock();avaCardDo(c,!!yes);if(yes&&c.state==='done'&&avaIsPhone()&&!['set_my_status','add_change_request'].includes(c.name))avaClose({keepFocus:true});}
async function avaCopy(n){
  const c=(AVA.cardList||[])[n];if(!c)return false;
  try{await navigator.clipboard.writeText(c.text);c.copied=true;avaPaintLog();if(typeof toast==='function')toast('Copied');return true;}
  catch(e){if(typeof toast==='function')toast("Couldn't copy — select the text and copy it");return false;}
}
async function avaSetStatus(text){
  if(typeof machineFetch!=='function')return null;
  const r=await machineFetch('/api/mc/team',{method:'POST',body:{action:'status',text:String(text||'')}});
  if(r&&r.ok){if(typeof toast==='function')toast(String(text||'').trim()?'Your status is saved':'Your status is cleared');if(typeof teamKick==='function')teamKick(true);}
  else if(typeof toast==='function')toast('Not saved: '+((r&&r.error)||'try again'));
  return r;
}
async function avaAddRequest(text){
  if(typeof machineFetch!=='function')return null;
  const r=await machineFetch('/api/mc/ava/requests',{method:'POST',body:{action:'add',text:String(text||'').trim()}});
  if(r&&r.ok){if(typeof toast==='function')toast('Sent to the owner — it shows under Settings › Ava');AVA.reqs.at=0;}
  else if(typeof toast==='function')toast(r&&r.status===404?"Requests aren't available yet — your system needs an update":'Not sent: '+((r&&r.error)||'try again'));
  return r;
}

/* ---- Settings › Ava (the owner): the brains, Test Ava, the voice, the requests, privacy ---- */
async function avaLoadStatus(force){
  const st=AVA.st;if(!avaOwner()||typeof machineFetch!=='function')return null;
  if(!force&&(st.missing||(st.data&&Date.now()-(st.at||0)<60000)))return st;
  const r=await machineFetch('/api/mc/ava/status');
  if(r.ok&&r.data&&Array.isArray(r.data.brains)){st.data=r.data;st.at=Date.now();st.err=null;st.missing=false;AVA_AI.brains=r.data.brains;
    AVA_AI.ready=r.data.ready!=null?!!r.data.ready:r.data.brains.some(b=>b&&b.ready);AVA_AI.readyAt=Date.now();}
  else if(r.status===404){st.missing=true;st.err=null;}
  else st.err=r.error||"Couldn't check Ava's brains. Try again.";
  return st;
}
async function avaLoadRequests(force){
  const st=AVA.reqs;if(!avaOwner()||typeof machineFetch!=='function')return null;
  if(!force&&(st.missing||(st.data&&Date.now()-(st.at||0)<60000)))return st;
  const r=await machineFetch('/api/mc/ava/requests');
  if(r.ok&&r.data&&Array.isArray(r.data.requests)){st.data=r.data.requests;st.at=Date.now();st.err=null;st.missing=false;}
  else if(r.status===404){st.missing=true;st.err=null;}
  else st.err=r.error||"Couldn't load the requests. Try again.";
  return st;
}
/* Business facts (the owner's, ≤ 4 KB): what Ava should know about the business. GET/POST /api/mc/ava/facts {text}. */
const AVA_FACTS_MAX=4000;
async function avaLoadFacts(force){
  const st=AVA.facts;if(!avaOwner()||typeof machineFetch!=='function')return null;
  if(!force&&(st.missing||(st.text!=null&&Date.now()-(st.at||0)<60000)))return st;
  const r=await machineFetch('/api/mc/ava/facts');
  if(r.ok&&r.data){st.text=typeof r.data.text==='string'?r.data.text:'';st.at=Date.now();st.err=null;st.missing=false;}
  else if(r.status===404){st.missing=true;st.err=null;}
  else st.err=r.error||"Couldn't load the business facts. Try again.";
  return st;
}
async function avaFactsSave(){
  const st=AVA.facts;if(!avaOwner()||st.busy)return null;
  const box=avaEl('avaFacts');const text=String(box&&box.value!=null?box.value:st.text||'').slice(0,AVA_FACTS_MAX);
  st.busy=true;st.saved=null;st.err=null;avaSetRepaint();
  const r=await machineFetch('/api/mc/ava/facts',{method:'POST',body:{text}});
  st.busy=false;
  if(r.ok){st.text=r.data&&typeof r.data.text==='string'?r.data.text:text;st.draft=null;st.at=Date.now();st.saved=Date.now();if(typeof toast==='function')toast('Saved — Ava uses these facts from now on');}
  else if(r.status===404){st.missing=true;}
  else st.err=r.error||'Not saved — try again.';
  avaSetRepaint();return r;
}
function avaLoadSettings(force){return Promise.all([avaLoadStatus(force),avaLoadRequests(force),avaLoadFacts(force)])}
function avaSetRepaint(){if(typeof currentView!=='undefined'&&currentView==='settings'&&typeof trialsRepaint==='function')trialsRepaint('settings',{soft:true});}
async function avaSetRetry(){await avaLoadSettings(true);avaSetRepaint();}
async function avaTest(){
  const t=AVA.test;if(t.busy)return;t.busy=true;t.result=null;t.err=null;avaSetRepaint();
  const t0=Date.now();
  let r;try{r=await machineFetch('/api/mc/ava/chat',{method:'POST',body:{messages:[{role:'user',content:'This is a test from Settings. Say hello in one short sentence.'}],page:avaPage()},timeout:25000});}catch(e){r={ok:false,error:String(e&&e.message||e)};}
  t.busy=false;const d=(r&&r.data)||{};
  if(r.ok&&d.reply){t.result={reply:String(d.reply),brain:avaBrainName(d.brain),ms:Date.now()-t0};AVA_AI.off=null;AVA_AI.offUntil=0;AVA_AI.ready=true;AVA_AI.noted=false;}
  else if(d.needsKeys)t.err="She has no brain switched on yet — add a free key in Settings › Keys, then test again.";
  else if(r.status===404)t.err="Your system hasn't been updated for Ava's brain yet.";
  else if(r.status===429)t.err=(d.error?avaSentence(d.error)+' ':'')+'Her brain has reached its limit for now — try again later.';
  else if(r.status===502)t.err='No brain answered'+(Array.isArray(d.tried)&&d.tried.length?' (tried '+d.tried.map(avaBrainName).join(', ')+')':'')+'. '+(d.error?avaSentence(d.error):'Try again in a minute.');
  else t.err=(r&&r.error)||d.error||"Ava didn't answer. Try again.";
  await avaLoadStatus(true);avaSetRepaint();
}
async function avaReqDone(id){
  if(!avaOwner())return;const st=AVA.reqs;
  const r=await machineFetch('/api/mc/ava/requests',{method:'POST',body:{action:'done',id:String(id)}});
  if(r.ok){if(r.data&&Array.isArray(r.data.requests))st.data=r.data.requests;else if(st.data){const x=st.data.find(q=>String(q.id)===String(id));if(x)x.status='done';}if(typeof toast==='function')toast('Marked done');}
  else if(typeof toast==='function')toast('Not saved: '+(r.error||'try again'));
  avaSetRepaint();return r;
}
function avaVoiceTest(){avaAudioUnlock();avaSpeak("Hi, I'm Ava. This is how I sound.");}
function avaSettingsCtx(){return {status:AVA.st,reqs:AVA.reqs,test:AVA.test,facts:AVA.facts,voice:avaVoicePref(),kokoro:avaKokoroState(),hands:avaHandsFree()}}
function avaRenderSet(c){
  c=c||{};const e=typeof esc==='function'?esc:(s=>String(s));const at=typeof tkAttr==='function'?tkAttr:(s=>JSON.stringify(String(s)));
  const rel=v=>typeof tkRel==='function'?tkRel(v):String(v||'');
  const st=c.status||{};const brains=st.data&&Array.isArray(st.data.brains)?st.data.brains:null;
  const ready=brains?brains.filter(b=>b&&b.ready):[];const on=st.data&&st.data.ready!=null?!!st.data.ready:ready.length>0;
  const state=st.missing?'<span class="pill grey">Not available yet</span>':!brains?'':on?`<span class="pill green">On${ready[0]?' · '+e(avaBrainName(ready[0])):''}</span>`:'<span class="pill amber">Needs a key</span>';
  const intro=`<p class="tk-set-text">With a brain switched on, Ava sends every question to it — so you can ask her anything about the hub, your clients or anything else. Plain commands like “open trials” still run at once. Without a brain she works in basic mode: pages, clients, numbers and how the hub works.</p>`;
  let brainsHTML;
  if(st.missing)brainsHTML=`<p class="tk-note">Your system hasn't been updated for Ava's smarter brain yet. Until then she answers from what the hub knows.</p>`;
  else if(!brains)brainsHTML=st.err?`<p class="tk-note red">${e(st.err)} <button type="button" class="tk-textbtn" onclick="avaSetRetry()">Try again</button></p>`:(typeof renderLoading==='function'?renderLoading('Checking Ava’s brains…'):'<p class="tk-muted">Checking…</p>');
  else brainsHTML=`<ul class="ava-brains">${brains.length?brains.map(b=>`<li><span class="ava-brain-name"><b>${e(avaBrainName(b))}</b>${b.model?`<small>${e(b.model)}</small>`:''}</span><span class="ava-brain-state">${b.ready?'<span class="pill green">Ready</span>':'<span class="pill grey">Needs a key</span>'}${b.lastOkAt?`<small>Last answered ${e(rel(b.lastOkAt))}</small>`:''}${b.lastError?`<small class="tk-red">${e(String(b.lastError).slice(0,160))}</small>`:''}</span></li>`).join(''):'<li><span class="tk-muted">No brains listed.</span></li>'}</ul>`;
  const t=c.test||{};
  const testLine=t.busy?'<p class="tk-muted tk-small">Asking Ava…</p>':t.result?`<p class="tk-set-text ava-test-ok">“${e(t.result.reply)}” <small class="tk-muted">answered by ${e(t.result.brain)} · ${e(avaSecs(t.result.ms))}</small></p>`:t.err?`<p class="tk-note red">${e(t.err)}</p>`:'';
  const btns=`<div class="tk-set-links"><button type="button" class="btn"${t.busy||st.missing?' disabled':''} onclick="avaTest()">Test Ava</button><button type="button" class="btn ghost" onclick="openSettings('keys')">Open Settings › Keys</button></div>`;
  const v=c.voice||'af_heart';const kst=c.kokoro||'idle';
  const kline=kst==='loading'?(()=>{const l=avaVoiceLoadingLine();return l.text+(l.pct!=null?' '+l.pct+'%':'');})():avaVoiceLabel();
  const voice=`<h4 class="ava-set-h">Her voice</h4><div class="ava-set-voice"><label class="ava-sr" for="avaSetVoice">Ava's voice</label><select id="avaSetVoice" onchange="avaSetVoice(this.value)">${AVA_VOICES.map(x=>`<option value="${e(x[0])}"${v===x[0]?' selected':''}>${e(x[1])} — ${e(x[2])}</option>`).join('')}<option value="browser"${v==='browser'?' selected':''}>The browser's own voice</option></select><button type="button" class="btn ghost" onclick="avaVoiceTest()">Play a sample</button></div><p class="tk-muted tk-small">${e(kline)}. The natural voice runs on this device — nothing she says is sent anywhere.</p>`;
  const rq=c.reqs||{};const list=Array.isArray(rq.data)?rq.data.slice().sort((a,b)=>(a.status==='done')-(b.status==='done')||String(b.at||'').localeCompare(String(a.at||''))):null;
  const open=list?list.filter(x=>x.status!=='done').length:0;
  const reqs=`<h4 class="ava-set-h">What people asked Ava to change${open?` <span class="pill amber">${open} open</span>`:''}</h4>`+(rq.missing?`<p class="tk-muted tk-small">Not available yet — your system needs an update first.</p>`:!list?(rq.err?`<p class="tk-note red">${e(rq.err)} <button type="button" class="tk-textbtn" onclick="avaSetRetry()">Try again</button></p>`:''):!list.length?`<p class="tk-muted tk-small">Nothing yet. Anyone can tell Ava “I'd like the hub to…” and it lands here.</p>`
    :`<ul class="ava-reqs">${list.slice(0,20).map(q=>`<li class="${q.status==='done'?'done':''}"><span><b>${e(q.text||'')}</b><small>${e(q.by||'Someone')}${q.at?' · '+e(rel(q.at)):''}</small></span>${q.status==='done'?'<span class="pill grey">Done</span>':`<button type="button" class="btn ghost" onclick="avaReqDone(${at(q.id)})">Done</button>`}</li>`).join('')}</ul>`);
  const f=c.facts||{};
  const facts=`<h4 class="ava-set-h">Business facts</h4>`+(f.missing?`<p class="tk-muted tk-small">Not available yet — your system needs an update first.</p>`:f.text==null&&!f.err?`<p class="tk-muted tk-small">Loading…</p>`
    :`<p class="tk-muted tk-small">What Ava should always know about your business — what you offer, prices, hours, how you like things said. Up to ${avaNum(AVA_FACTS_MAX)} characters; her AI brain reads it with every question.</p><label class="ava-sr" for="avaFacts">Business facts</label><textarea id="avaFacts" class="ava-facts" rows="6" maxlength="${AVA_FACTS_MAX}" placeholder="e.g. We set up cold email for IT companies in the US. The trial is 30 days and free…" oninput="AVA.facts.draft=this.value">${e(f.draft!=null?f.draft:f.text||'')}</textarea><div class="tk-set-links"><button type="button" class="btn"${f.busy?' disabled':''} onclick="avaFactsSave()">${f.busy?'Saving…':'Save facts'}</button>${f.saved?'<span class="pill green">Saved</span>':''}</div>${f.err?`<p class="tk-note red">${e(f.err)} <button type="button" class="tk-textbtn" onclick="avaSetRetry()">Try again</button></p>`:''}`);
  const privacy=`<p class="ava-privacy">Your voice is turned into text by your browser (Chrome uses Google). Ava's AI only uses services that don't train on your data, and never sends your prospects' names or emails.</p>`;
  return {state,body:intro+`<h4 class="ava-set-h">Her brains</h4>`+brainsHTML+btns+testLine+facts+voice+reqs+privacy};
}

/* ===================== 9. ASKING: load what the question needs, think, show, say, do ===================== */
async function avaPrime(text){
  const t=avaNorm(text);const jobs=[];
  const safe=p=>Promise.resolve(p).catch(()=>null);
  // the board: waited for only when it isn't here at all — otherwise refreshed quietly, so answers stay instant
  if(typeof tk!=='undefined'&&typeof loadHub==='function'&&(!tk.hub||Date.now()-(tk.hubAt||0)>60000)){if(!tk.hub)jobs.push(safe(loadHub(false)));else safe(loadHub(false));}
  if(/\b(calendar|call|calls|meeting|meetings|today|tomorrow)\b/.test(t)&&typeof calLoad==='function'&&typeof calSettingsNow==='function'){
    const st=calSettingsNow();const k=calDayKey(calNow(),st.ownerZone);const w1=calMonday(k),w2=calMonday(calAddDays(k,/\bweek|next\b/.test(t)?6:1));
    jobs.push(safe(calLoad(w1)));if(w2!==w1)jobs.push(safe(calLoad(w2)));
  }
  if(/\b(online|team|looks after|in the hub|working)\b/.test(t)&&typeof teamKick==='function'&&(typeof tm==='undefined'||!tm.data))jobs.push(safe(teamKick(false)));
  if(/\b(i|my|we)\b.*\b(sent|send|outreach|emails)\b/.test(t)&&typeof loadOutreach==='function')jobs.push(safe(loadOutreach(false)));
  await Promise.all(jobs);
  if(/\b(money|revenue|income|received|paid|earn)\b/.test(t)&&avaOwner()&&typeof tkMoneyKick==='function'){const p=tkMoneyKick();if(p)await safe(p);}
  const c=avaFindClient(t);
  if(c&&typeof loadTrial==='function'&&/\b(money|paid|invoice|bounce|bounces)\b/.test(t))await safe(loadTrial(c.id,false));
}
const AVA_LOOP_STOP=/^(stop( listening)?|that is all( for now)?|thanks? ava|thank you( ava)?|thanks|bye|goodbye|good bye|i am done|no more|never ?mind)\b/;
/* Three follow-ups for the page you're on (when the AI gives none of its own); never the question just asked. */
function avaFollowUps(ctx,asked){
  ctx=ctx||avaCtx();const pg=avaPage();const v=pg.view;const q=avaNorm(asked||'');let xs;
  const name=pg.clientName&&pg.clientId!==(typeof MY_STATS_ID!=='undefined'?MY_STATS_ID:'aviance')?pg.clientName:null;
  if(name)xs=['How is '+name+' doing?','Summarise '+avaPossessive(name)+' latest replies','What does '+name+' need from me?'];
  else if(v==='calendar')xs=["What's on tomorrow?",'Any call times waiting for my yes?','What needs me today?'];
  else if(v==='paying')xs=ctx.owner?['How much came in this month?','Which paying clients need me?','How does a paid plan start?']:['Which paying clients need the owner?','How does a paid plan start?','What needs me today?'];
  else if(v==='settings')xs=['Is everything running?','What does warm-up do?','How do I add a key?'];
  else if(v==='team'||v==='people')xs=["Who's online?",'Who looks after '+avaExample()+'?','What needs me today?'];
  else xs=['What needs me today?','How many trials are running?',"What's on my calendar today?",'How does a trial work?'];
  return xs.filter(x=>avaNorm(x)!==q).slice(0,3);
}
function avaPossessive(n){return typeof tkPossessive==='function'?tkPossessive(n):n+"'s"}
/* Ask: show the question, think (AI first — streamed in as it comes, said sentence by sentence), show, say, do. */
async function avaAsk(text,opts){
  opts=opts||{};text=String(text||'').trim();if(!text)return null;
  avaOpen({listen:false,quiet:true});
  avaHush();AVA.recall=null;
  avaPush({who:'you',text,at:Date.now(),voice:!!opts.voice});
  // hands-free: "stop" / "thanks Ava" ends the listening loop
  if(opts.voice&&avaHandsFree()&&!AVA.pending&&AVA_LOOP_STOP.test(avaNorm(text))){
    AVA.loopPaused=true;const r=avaReply("Okay — I'll stop listening. Tap the mic when you need me.",[]);
    avaPush({who:'ava',text:r.say,at:Date.now()});avaSpeak(r.say);return r;
  }
  AVA.busy=true;AVA.stage='thinking';avaPaintLog();
  const live={msg:null,say:null,fed:0,raw:''};
  const on={voice:!!opts.voice,delta:(full)=>{
    if(!live.msg){AVA.busy=false;AVA.stage='answering';live.msg={who:'ava',text:'',streaming:true,at:Date.now()};AVA.log.push(live.msg);live.say=avaSayBegin();}
    live.raw=full;live.msg.text=full;avaFeedSpeech(live,false);avaPaintLog();
  }};
  let r;
  try{await avaPrime(text);r=await avaAnswer(text,avaCtx(),on);}
  catch(e){r=avaReply("Something went wrong on my side — try again, or ask it another way.",[]);}
  if(!r||typeof r!=='object')r=avaReply("I didn't get an answer — try again, or ask it another way.",[]);
  AVA.busy=false;AVA.stage=null;
  if(r.hush){avaHush();AVA.readRest=null;}
  const ctx=avaCtx();const reading=r.read||null;
  const chips=reading?null:r.chips||(r.local&&r.auto?null:avaFollowUps(ctx,text));
  const msg={who:'ava',text:r.say,actions:r.actions||[],chips:chips&&chips.length?chips:null,cards:r.cards&&r.cards.length?r.cards:null,meta:r.meta||null,at:Date.now(),basic:r.basic||null,streaming:false};
  if(live.msg){Object.assign(live.msg,msg);avaSave();avaPaintLog();}else if(r.say||!reading)avaPush(msg);   // a bare "read this" shows only what she reads
  if(r.refused)avaPush({who:'ava',notice:true,at:Date.now(),text:r.refused});
  if(r.aiNote)avaPush(Object.assign(avaAiNoteMsg(r.aiNote,ctx),{at:Date.now()}));
  if(r.cut)avaPush({who:'ava',notice:true,at:Date.now(),text:'The connection dropped before I finished, so that answer may be cut short. Ask again to get the rest.'});
  // her voice: one speaking turn — the answer, then (after the page is open and loaded) what she reads from it
  let s=null;
  if(live.say){live.raw=r.raw!=null?r.raw:live.raw;avaFeedSpeech(live,true);s=AVA.say===live.say?live.say:null;}
  else if(!r.silent){const lead=((r.aiNote?"I'm in basic mode right now. ":'')+(r.say||'')).trim();if(lead){s=avaSayBegin();avaSayAdd(s,lead);}}
  if(r.refused){if(!s&&!AVA.listening)s=avaSayBegin();avaSayAdd(s,r.refused);}
  let away=false;
  if(r.auto&&typeof r.auto.run==='function'){try{r.auto.run();}catch(e){}
    // on a phone the panel covers the page it just opened: fold it away once the answer is said (not while reading it out)
    if(avaIsPhone()&&!reading){away=true;setTimeout(()=>{if(!AVA.listening)avaClose({keepFocus:true});},1400);}}
  if(reading){
    const gen=AVA.gen;const began=!!s;
    AVA.stage='reading';avaPaintMic();
    let rd;try{rd=await avaReadPage(reading.what);}catch(e){rd={text:"I couldn't read this page just now.",say:"I couldn't read this page just now.",chips:null};}
    AVA.stage=null;
    avaPush({who:'ava',text:rd.text,chips:rd.chips,read:true,meta:'read from your screen, on this device',at:Date.now()});
    const interrupted=AVA.listening||(began?AVA.say!==s:AVA.gen!==gen);   // Space / the mic / Esc while it loaded: don't talk over them
    if(!interrupted&&rd.say){if(!s)s=avaSayBegin();avaSayAdd(s,rd.say);}
  }
  const talking=s?avaSayEnd(s):false;
  if(!talking&&!away)avaAfterAnswer();
  avaPaintMic();
  return r;
}
/* While the answer streams in: every finished sentence (or line) goes to her voice at once. */
const AVA_FIRST_MIN=40,AVA_FIRST_COMMA=80;
function avaFeedSpeech(live,final){
  if(!live.say||AVA.say!==live.say)return;
  const raw=String(live.raw||'').slice(live.fed);if(!raw)return;
  let cut=final?raw.length:-1;
  if(!final){const re=/[.!?](?=\s)|\n/g;let m;while((m=re.exec(raw)))cut=m.index+m[0].length;
    // the first sentence: said the moment it is here (40+ characters and its full stop), or at a comma after 80
    if(live.fed===0&&cut<0){
      if(raw.trim().length>=AVA_FIRST_MIN&&/[^\d\s][.!?]["')\]]?$/.test(raw))cut=raw.length;
      else if(raw.length>=AVA_FIRST_COMMA){const c=raw.lastIndexOf(',');if(c>=AVA_FIRST_MIN)cut=c+1;}
    }}
  if(cut<=0)return;
  live.fed+=cut;avaSayAdd(live.say,raw.slice(0,cut));
}
function avaIsPhone(){try{return typeof window.matchMedia==='function'&&window.matchMedia('(max-width:860px)').matches}catch(e){return false}}

/* ===================== 10. THE PANEL =====================
   Desktop: a 440×640 panel bottom-right (Expand makes it full height). Phone: a full-screen sheet. The orb in the
   header shows her state (listening — with the live level of your voice —, getting your words, thinking, speaking).
   Answers are light markdown (bold, lists, line breaks, links; links to hub pages are buttons); everything else is
   escaped. Each answer has Copy and a tiny "brain · time" line; the last one has follow-up chips. The conversation is
   kept for this tab (sessionStorage) until New chat. */
const AVA_IC={
  mic:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>',
  stop:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  send:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sound:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  muted:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  loop:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  expand:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  shrink:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
  copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  tune:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
};
const AVA_CHAT_KEY='avianceAvaChat:v1';   // this tab's conversation (sessionStorage)
const AVA_BIG_KEY='avianceAvaBig:v1';
const AVA_TIP_KEY='avianceAvaTip:v1';
function avaEl(id){return typeof document!=='undefined'&&document.getElementById?document.getElementById(id):null}
function avaEsc(s){return typeof esc==='function'?esc(s):String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function avaHoldHint(){return avaIsPhone()?'Hold the mic to talk':'Hold <kbd>Space</kbd> to talk'}
function avaMount(){
  const root=avaEl('avaRoot');if(!root||AVA.mounted)return;AVA.mounted=true;
  root.innerHTML=`<button type="button" class="ava-fab" aria-label="Ask Ava — hold Space to talk (Ctrl+J opens)" id="avaFab" title="Ask Ava — hold Space to talk · Ctrl/⌘ J" aria-expanded="false" aria-controls="avaPanel" onpointerdown="avaPointer(event,'fab')" onpointerup="avaPointerUp(event)" onpointercancel="avaPointerUp(event,1)" onclick="avaFabClick()"><span class="ava-fab-orb" aria-hidden="true"></span>${AVA_IC.mic}<span class="ava-fab-ring" aria-hidden="true"></span></button>
  <div class="ava-tip" id="avaTip" role="status" hidden><b>Talk to Ava</b><span>${avaHoldHint()} — let go to send.</span><button type="button" class="ava-tip-x" onclick="avaTipSeen()" aria-label="Got it">${AVA_IC.close}</button></div>
  <section class="ava-panel" id="avaPanel" role="dialog" aria-modal="false" aria-labelledby="avaTitle" hidden>
    <header class="ava-head"><span class="ava-orb" id="avaOrb" aria-hidden="true"><i></i><i></i><i></i></span><span class="ava-name"><b id="avaTitle">Ava</b><small id="avaSub">Ask me anything</small></span>
      <button type="button" class="ava-ib" id="avaNew" onclick="avaNewChat()" aria-label="New chat" title="New chat">${AVA_IC.plus}</button>
      <button type="button" class="ava-ib" id="avaMute" onclick="avaSetMute(!avaMuted())"></button>
      <button type="button" class="ava-ib ava-big-btn" id="avaBig" onclick="avaToggleBig()"></button>
      <button type="button" class="ava-ib" onclick="avaClose()" aria-label="Close Ava" title="Close (Esc)">${AVA_IC.close}</button></header>
    <div class="ava-vload" id="avaVload" role="status" hidden><span id="avaVloadText"></span><span class="ava-vbar"><i id="avaVbar"></i></span></div>
    <div class="ava-log" id="avaLog" role="log" aria-live="polite" aria-relevant="additions"></div>
    <div class="ava-heard" id="avaHeard"><span class="ava-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="ava-heard-text" id="avaHeardText" aria-live="polite"></span><small class="ava-heard-hint" id="avaHeardHint"></small></div>
    <form class="ava-in" onsubmit="event.preventDefault();avaSubmit()">
      <label class="ava-sr" for="avaInput">Ask Ava</label>
      <textarea id="avaInput" rows="1" autocomplete="off" enterkeyhint="send" placeholder="Ask anything…" maxlength="2000" onkeydown="avaInputKey(event)" oninput="avaGrow(this)"></textarea>
      <button type="button" class="ava-mic" id="avaMic" onpointerdown="avaPointer(event,'mic')" onpointerup="avaPointerUp(event)" onpointercancel="avaPointerUp(event,1)" onclick="avaMicClick()"></button>
      <button type="submit" class="ava-send" aria-label="Send">${AVA_IC.send}</button>
    </form>
    <div class="ava-opts">
      <span class="ava-hint" id="avaHint">${avaHoldHint()}</span>
      <button type="button" class="ava-hands" id="avaHands" onclick="avaSetHandsFree(!avaHandsFree())" aria-pressed="false">${AVA_IC.loop}<span>Hands-free</span></button>
      <details class="ava-vopts" id="avaVopts"><summary aria-label="Voice and speed">${AVA_IC.tune}<span>Voice</span></summary>
        <div class="ava-vpop"><label class="ava-voice"><span>Voice</span><select id="avaVoiceSel" onchange="avaSetVoice(this.value)" aria-label="Ava's voice"></select></label>
        <label class="ava-voice"><span>Speed</span><select id="avaSpeedSel" onchange="avaSetSpeed(this.value)" aria-label="How fast Ava talks"></select></label>
        <small class="ava-vstate" id="avaVstate"></small></div></details>
    </div>
    <p class="ava-note" id="avaNote" role="status"></p>
  </section>`;
  avaPaintHead();avaPaintMic();avaPaintVoice();avaSync();
}
function avaUid(){return typeof authUser!=='undefined'&&authUser?String(authUser.uid||authUser.email||''):''}
function avaSession(){try{return typeof sessionStorage!=='undefined'?sessionStorage:null}catch(e){return null}}
/* The conversation for this tab: saved after every message, read back after a reload; another person's never shown. */
function avaSave(){
  const ss=avaSession();if(!ss)return false;
  try{
    const log=AVA.log.filter(m=>m&&!m.streaming&&(m.who==='you'||m.who==='ava')).slice(-AVA_MAX_LOG).map(m=>{
      const o={who:m.who,text:String(m.text||'')};['meta','at','notice','basic','voice','greet'].forEach(k=>{if(m[k]!=null&&m[k]!==false&&m[k]!=='')o[k]=m[k];});
      if(Array.isArray(m.guide))o.guide=m.guide.slice(0,6);if(Array.isArray(m.chips))o.chips=m.chips.slice(0,4).map(String);
      const drafts=(m.cards||[]).filter(c=>c&&c.kind==='draft').map(c=>({kind:'draft',title:String(c.title||''),text:String(c.text||'')}));if(drafts.length)o.cards=drafts;
      return o;});
    ss.setItem(AVA_CHAT_KEY,JSON.stringify({v:1,uid:avaUid(),log}));return true;
  }catch(e){return false}
}
function avaRestore(){
  const ss=avaSession();if(!ss)return false;
  try{
    const raw=ss.getItem(AVA_CHAT_KEY);if(!raw)return false;const d=JSON.parse(raw);
    if(!d||!Array.isArray(d.log)||!d.uid||d.uid!==avaUid())return false;
    const log=d.log.filter(m=>m&&(m.who==='you'||m.who==='ava')&&typeof m.text==='string');if(!log.length)return false;
    AVA.log=log;AVA.greeted=true;return true;
  }catch(e){return false}
}
function avaForget(){const ss=avaSession();try{ss&&ss.removeItem(AVA_CHAT_KEY);}catch(e){}}
/* New chat: forget this conversation and start again. */
function avaNewChat(){
  avaHush();if(AVA.listening)avaStopListening({discard:true});
  AVA.log=[];AVA.pending=null;AVA.greeted=false;AVA.recall=null;AVA_AI.noted=false;avaForget();
  avaGreet();avaPaintLog();avaNote('');avaFocusInput();
}
function avaSync(){
  const root=avaEl('avaRoot');if(!root)return;
  const on=!!(typeof authUser!=='undefined'&&authUser);
  root.hidden=!on;if(root.style)root.style.display=on?'':'none';
  try{document.body.classList.toggle('ava-on',on);}catch(e){}
  if(!on){AVA.log=[];AVA.greeted=false;AVA.pending=null;AVA.restoredFor=null;AVA_AI.noted=false;avaForget();avaClose({keepFocus:true});return;}
  if(AVA.restoredFor!==avaUid()){AVA.restoredFor=avaUid();if(!AVA.log.length)avaRestore();}
  avaTip();
}
/* The first time on a computer: "Hold Space to talk" beside the round button, for a few seconds. */
function avaTip(){
  if(AVA.tipShown||avaStore(AVA_TIP_KEY)==='1')return false;
  const t=avaEl('avaTip');if(!t)return false;AVA.tipShown=true;
  t.hidden=false;clearTimeout(AVA.tipTimer);AVA.tipTimer=setTimeout(avaTipSeen,9000);return true;
}
function avaTipSeen(){const t=avaEl('avaTip');if(t)t.hidden=true;clearTimeout(AVA.tipTimer);avaStore(AVA_TIP_KEY,'1');}
function avaFabTap(){avaAudioUnlock();if(AVA.open){avaClose();return;}avaOpen({listen:true});}
function avaMicTap(){avaAudioUnlock();return avaListen();}
function avaToggle(){AVA.open?avaClose():avaOpen({listen:false})}
function avaGreet(){
  if(AVA.greeted)return;AVA.greeted=true;
  const ctx=avaCtx();
  const say='Hi'+(ctx.name?' '+ctx.name:'')+", I'm Ava. Ask me anything — about your clients, the hub, or anything else. "+(avaIsPhone()?'Hold the mic to talk, or type.':'Hold Space to talk, or type.');
  avaPush({who:'ava',text:say,chips:avaChipsFor(ctx),greet:true});
  return say;
}
function avaOpen(opts){
  opts=opts||{};if(typeof authUser!=='undefined'&&!authUser)return;
  if(!AVA.mounted)avaMount();
  const p=avaEl('avaPanel'),f=avaEl('avaFab');
  const was=AVA.open;AVA.open=true;
  if(p){p.hidden=false;if(p.classList){p.classList.add('open');p.classList.toggle('big',avaBig());}}
  if(f){f.setAttribute&&f.setAttribute('aria-expanded','true');if(f.classList)f.classList.add('on');}
  try{document.body.classList.add('ava-open');}catch(e){}
  if(!was)avaTipSeen();
  const greet=avaGreet();
  if(!was){avaNote(avaCanListen()?'':"Voice isn't available in this browser — type your question. (Voice works in Chrome, Edge and Safari.)");avaVoiceWarm();if(avaCanListen())avaMicCheck();avaWarm();avaAiCheck();avaNaturalNote();}
  avaPaintLog();avaPaintVoice();avaPaintHead();
  if(!was&&greet&&!opts.quiet&&!(opts.listen&&avaCanListen()))avaSpeak(greet);
  if(opts.listen&&avaCanListen())avaListen();else if(!opts.quiet)avaFocusInput();
}
function avaIsChrome(){try{return /Chrome\//.test(navigator.userAgent||'')&&!/Edg\//.test(navigator.userAgent||'')}catch(e){return false}}
function avaClose(opts){
  opts=opts||{};const p=avaEl('avaPanel'),f=avaEl('avaFab');
  if(AVA.ptt)AVA.ptt=null;
  if(AVA.listening)avaStopListening({discard:true});avaCaptureKill();avaHush();clearTimeout(AVA.loopTimer);
  const was=AVA.open;AVA.open=false;
  if(p){p.hidden=true;if(p.classList)p.classList.remove('open');}
  try{document.body.classList.remove('ava-open');}catch(e){}
  if(f){f.setAttribute&&f.setAttribute('aria-expanded','false');if(f.classList)f.classList.remove('on');if(was&&!opts.keepFocus)try{f.focus();}catch(e){}}
}
function avaBig(){if(AVA.big==null)AVA.big=avaStore(AVA_BIG_KEY)==='1';return AVA.big}
function avaToggleBig(){AVA.big=!avaBig();avaStore(AVA_BIG_KEY,AVA.big?'1':'0');const p=avaEl('avaPanel');if(p&&p.classList)p.classList.toggle('big',AVA.big);avaPaintHead();}
function avaFocusInput(){if(avaIsPhone())return;const i=avaEl('avaInput');if(i)setTimeout(()=>{try{i.focus();}catch(e){}},40);}
function avaGrow(i){if(!i||!i.style)return;try{i.style.height='auto';i.style.height=Math.min(160,Math.max(44,i.scrollHeight||0))+'px';}catch(e){}}
function avaSubmit(){avaAudioUnlock();const i=avaEl('avaInput');const v=i?i.value:'';if(i){i.value='';avaGrow(i);}return avaAsk(v);}
/* The box: Enter sends, Shift+Enter is a new line, ↑ in an empty box brings back your last question (again: the one before). */
function avaInputKey(e){
  if(!e)return;const i=e.target&&'value' in e.target?e.target:avaEl('avaInput');
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault&&e.preventDefault();avaSubmit();return;}
  if(e.key==='ArrowUp'&&!e.shiftKey&&!e.altKey&&i){
    const qs=AVA.log.filter(m=>m.who==='you').map(m=>m.text);if(!qs.length)return;
    const atStart=!i.value||(i.selectionStart===0&&i.selectionEnd===0)||(AVA.recall!=null&&i.value===qs[AVA.recall]);
    if(!atStart)return;
    const n=AVA.recall==null||i.value!==qs[AVA.recall]?qs.length-1:Math.max(0,AVA.recall-1);
    AVA.recall=n;i.value=qs[n];avaGrow(i);e.preventDefault&&e.preventDefault();
    try{i.setSelectionRange(i.value.length,i.value.length);}catch(x){}
  }
}
function avaChip(i){avaAudioUnlock();const c=(AVA.chipList||[])[i];if(c)return avaAsk(c);}
function avaRun(i){const a=AVA.acts[i];if(!a||typeof a.run!=='function')return;avaHush();try{a.run();}catch(e){}
  if(a.yes||a.no){avaPush({who:'ava',text:a.no?"Okay, I won't.":'Done.',at:Date.now()});}
  if(!a.no&&avaIsPhone())avaClose({keepFocus:true});}
function avaNote(s){const n=avaEl('avaNote');if(n)n.textContent=s||'';}
function avaPush(m){AVA.log.push(m);if(AVA.log.length>AVA_MAX_LOG)AVA.log.splice(0,AVA.log.length-AVA_MAX_LOG);avaSave();avaPaintLog();}
function avaPaintHead(){
  const b=avaEl('avaMute');if(b){const m=avaMuted();b.innerHTML=m?AVA_IC.muted:AVA_IC.sound;b.setAttribute&&b.setAttribute('aria-label',m?'Ava is quiet — turn her voice on':'Turn Ava’s voice off');b.setAttribute&&b.setAttribute('aria-pressed',m?'true':'false');b.title=m?'Voice off':'Voice on';}
  const g=avaEl('avaBig');if(g){const big=avaBig();g.innerHTML=big?AVA_IC.shrink:AVA_IC.expand;g.setAttribute&&g.setAttribute('aria-label',big?'Make Ava smaller':'Make Ava full height');g.setAttribute&&g.setAttribute('aria-pressed',big?'true':'false');g.title=big?'Smaller':'Full height';}
}
/* Her state, in the header line and the orb: listening → getting your words → thinking → speaking. */
function avaState(){return AVA.listening?'listening':AVA.stage==='transcribing'?'transcribing':AVA.busy?'thinking':AVA.speaking?'speaking':AVA.stage==='answering'||AVA.stage==='reading'?'thinking':'idle'}
function avaPaintMic(){
  const b=avaEl('avaMic'),f=avaEl('avaFab');const can=avaCanListen();const st=avaState();
  if(b){b.innerHTML=AVA.listening?AVA_IC.stop:AVA_IC.mic;b.setAttribute&&b.setAttribute('aria-label',AVA.listening?'Stop listening':AVA.speaking?'Interrupt Ava and speak':can?'Speak to Ava (tap, or hold and let go)':'Voice is not available in this browser');b.setAttribute&&b.setAttribute('aria-pressed',AVA.listening?'true':'false');if(b.classList){b.classList.toggle('on',AVA.listening);b.classList.toggle('off',!can);}}
  if(f&&f.classList){f.classList.toggle('listening',AVA.listening);f.classList.toggle('speaking',!!AVA.speaking&&!AVA.listening);}
  const p=avaEl('avaPanel');if(p&&p.classList){['listening','speaking','thinking','transcribing'].forEach(k=>p.classList.toggle(k,st===k||(k==='speaking'&&!!AVA.speaking&&st!=='listening')));}
  const s=avaEl('avaSub');if(s)s.textContent=st==='listening'?'Listening…':st==='transcribing'?'Getting your words…':st==='thinking'?(AVA.stage==='reading'?'Reading the page…':'Thinking…'):st==='speaking'?(avaIsPhone()?'Speaking — tap the mic to stop':'Speaking — Space or Esc stops her'):avaBasicNow()?'Basic mode':'Ask me anything';
}
function avaBasicNow(){return AVA_AI.ready===false||(!!AVA_AI.off&&Date.now()<AVA_AI.offUntil)}
function avaPaintHeard(){const h=avaEl('avaHeard'),t=avaEl('avaHeardText'),n=avaEl('avaHeardHint');if(!h)return;
  if(t)t.textContent=AVA.listening?(AVA.interim?'“'+AVA.interim+'”':'Listening… speak now'):AVA.stage==='transcribing'?'Getting your words…':'';
  if(n)n.textContent=AVA.listening?(AVA.ptting?(AVA.ptt&&AVA.ptt.src==='space'?'Let go of Space to send':'Let go to send'):'Stops when you do'):'';
  if(h.classList)h.classList.toggle('show',!!AVA.listening||AVA.stage==='transcribing');}
function avaPaintVoice(){
  const box=avaEl('avaVload');const st=avaKokoroState();
  if(box){const on=st==='loading';box.hidden=!on;if(on){const l=avaVoiceLoadingLine();const t=avaEl('avaVloadText');if(t)t.textContent=l.text+(l.pct!=null?' '+l.pct+'%':'');const bar=avaEl('avaVbar');if(bar&&bar.style)bar.style.width=(l.pct!=null?Math.max(4,l.pct):8)+'%';}}
  const sel=avaEl('avaVoiceSel');const e=avaEsc;
  if(sel){const v=avaVoicePref();
    const nat=st==='loading'?' (getting ready)':st==='unsupported'&&avaIsPhone()?' (computer)':st==='slow'||st==='failed'||st==='unsupported'?' (unavailable)':' — natural';
    sel.innerHTML=AVA_VOICES.map(x=>`<option value="${e(x[0])}"${v===x[0]?' selected':''}>${e(x[1])}${e(nat)}</option>`).join('')+`<option value="browser"${v==='browser'?' selected':''}>${avaIsPhone()?'Phone voice':'Browser voice'}</option>`;
    sel.title=avaVoiceLabel();}
  const sp=avaEl('avaSpeedSel');if(sp){const cur=avaSpeed();sp.innerHTML=[0.9,1,1.1,1.2].map(x=>`<option value="${x}"${Math.abs(cur-x)<0.01?' selected':''}>${x===1?'Normal':x+'×'}</option>`).join('');}
  const vs=avaEl('avaVstate');if(vs)vs.textContent=avaVoiceLabel();
  const h=avaEl('avaHands');if(h){const on=avaHandsFree();h.setAttribute&&h.setAttribute('aria-pressed',on?'true':'false');if(h.classList)h.classList.toggle('on',on);h.title=on?'Hands-free is on: after she answers, she listens again. Say “stop” or “thanks Ava” to end.':'Hands-free: after she answers, she listens again';}
}
function avaTime(at){if(!at)return '';try{return new Date(at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});}catch(e){return ''}}

/* ---- light markdown: **bold**, *italic*, `code`, lists, headings, line breaks, links. Everything is escaped first;
   a link to a hub page (#system/<id>, #trial/<id>, #settings/keys, #calendar …) is a button that opens it here. ---- */
const AVA_ROUTE=/^#(?:system|trial|settings|calendar|trials|paying|inquiries|stats|alerts|team|mystats|activity|behind)(?:\/[A-Za-z0-9_.:-]+){0,2}$/;
function avaMd(src){
  const lines=String(src==null?'':src).replace(/\r\n?/g,'\n').split('\n');
  let html='',list=null,para=[],code=null;
  const flush=()=>{if(para.length){html+='<p>'+para.map(avaInline).join('<br>')+'</p>';para=[];}};
  const close=()=>{if(list){html+='</'+list+'>';list=null;}};
  lines.forEach(line=>{
    if(/^\s*```/.test(line)){if(code==null){flush();close();code=[];}else{html+='<pre><code>'+avaEsc(code.join('\n'))+'</code></pre>';code=null;}return;}
    if(code!=null){code.push(line);return;}
    if(!line.trim()){flush();close();return;}
    const ul=line.match(/^\s*[-*•]\s+(.*)$/),ol=line.match(/^\s*\d{1,3}[.)]\s+(.*)$/),h=line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if(ul||ol){flush();const tag=ul?'ul':'ol';if(list!==tag){close();html+='<'+tag+'>';list=tag;}html+='<li>'+avaInline((ul||ol)[1])+'</li>';return;}
    close();
    if(h){flush();html+='<p class="ava-h">'+avaInline(h[1])+'</p>';return;}
    para.push(line.trim());
  });
  if(code!=null)html+='<pre><code>'+avaEsc(code.join('\n'))+'</code></pre>';
  flush();close();return html;
}
function avaFmt(e){   // on escaped text only
  return e.replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/__([^_]+)__/g,'<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?;:]|$)/g,'$1<i>$2</i>');
}
function avaInline(s){
  s=String(s||'');let out='',last=0;
  const re=/\[([^\]\n]{1,160})\]\(([^()\s]{1,400})\)|(https?:\/\/[^\s<>"'()]+[^\s<>"'().,!?;:])|(#(?:system|trial|settings|calendar|trials|paying|inquiries|stats|alerts)(?:\/[A-Za-z0-9_.:-]+){0,2})(?![\w/])/g;
  let m;
  while((m=re.exec(s))){
    out+=avaFmt(avaEsc(s.slice(last,m.index)));last=m.index+m[0].length;
    if(m[1]!=null){const url=m[2];const label=avaFmt(avaEsc(m[1]));
      if(AVA_ROUTE.test(url)){const n=(AVA.links||(AVA.links=[])).push(url)-1;out+=`<button type="button" class="ava-link" onclick="avaGo(${n})">${label}</button>`;}
      else if(/^https?:\/\/[^\s"'<>]+$/i.test(url))out+=`<a href="${avaEsc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      else out+=label;}
    else if(m[3]!=null)out+=`<a href="${avaEsc(m[3])}" target="_blank" rel="noopener noreferrer">${avaEsc(m[3].replace(/^https?:\/\//,''))}</a>`;
    else{const url=m[4];const n=(AVA.links||(AVA.links=[])).push(url)-1;out+=`<button type="button" class="ava-link" onclick="avaGo(${n})">${avaEsc(avaRouteLabel(url))}</button>`;}
  }
  return out+avaFmt(avaEsc(s.slice(last)));
}
/* A hub link → the place it opens ({view, id?, tab?} as the AI's navigate action), or null. */
function avaRoute(url){
  const h=String(url||'').replace(/^#/,'');const bits=h.split('/');const v=bits[0];
  if(v==='system')return bits[1]?{view:'client',id:bits[1],tab:bits[2]||'overview'}:null;
  if(v==='trial')return bits[1]?{view:'client',id:bits[1]}:null;
  if(v==='settings')return {view:'settings',tab:bits[1]||null};
  if(v==='alerts')return {view:'settings',tab:'alerts'};
  if(v==='stats')return {view:'mystats'};
  if(v==='calendar'&&bits[1])return {view:'calendar',id:bits[1]};
  return {view:v};
}
function avaRouteLabel(url){
  const r=avaRoute(url);const a=r?avaNavAct(r,avaCtx()):null;if(!a)return 'Open it';
  if(r.view==='client'&&/^#system\/[^/]+$/.test(String(url)))return 'Open '+avaPossessive(avaClientName(r.id))+' email system';
  return a.label;
}
function avaGo(n){
  const url=(AVA.links||[])[n];const r=avaRoute(url);if(!r)return false;
  if(r.view==='calendar'&&r.id){if(typeof openCalendar==='function')openCalendar(r.id);else render('calendar');}
  else{const a=avaNavAct(r,avaCtx());if(!a){if(typeof toast==='function')toast("That page is only for the owner.");return false;}avaHush();try{a.run();}catch(e){}}
  if(avaIsPhone())avaClose({keepFocus:true});
  return true;
}
/* Copy one answer (as plain words). */
async function avaCopyMsg(i){
  const m=AVA.log[i];if(!m)return false;
  try{await navigator.clipboard.writeText(String(m.text||''));m.copied=true;avaPaintLog();setTimeout(()=>{m.copied=false;avaPaintLog();},1600);if(typeof toast==='function')toast('Copied');return true;}
  catch(e){if(typeof toast==='function')toast("Couldn't copy — select the text and copy it");return false;}
}
function avaPaintLog(){
  const l=avaEl('avaLog');if(!l)return;AVA.acts=[];AVA.chipList=[];AVA.cardList=[];AVA.links=[];
  const e=avaEsc;
  // the follow-ups sit under the newest answer (a basic-mode notice after it doesn't hide them)
  let last=AVA.log.length-1;while(last>0&&AVA.log[last].notice&&!AVA.log[last].chips)last--;
  l.innerHTML=AVA.log.map((m,i)=>{
    if(m.who==='you')return `<div class="ava-msg you"><p>${e(m.text).replace(/\n/g,'<br>')}</p></div>`;
    const acts=(m.actions||[]).map(a=>{const n=AVA.acts.push(a)-1;return `<button type="button" class="ava-act${a.yes?' yes':''}" onclick="avaRun(${n})">${e(a.label)}</button>`}).join('');
    const chips=i===last&&m.chips&&!AVA.busy?`<div class="ava-chips">${m.chips.map(c=>{const n=AVA.chipList.push(c)-1;return `<button type="button" class="ava-chip" onclick="avaChip(${n})">${e(c)}</button>`}).join('')}</div>`:'';
    const guide=m.guide?`<ol class="ava-guide">${m.guide.map(g=>`<li>${e(g)}</li>`).join('')}</ol>`:'';
    const cards=(m.cards||[]).map(c=>{const n=AVA.cardList.push(c)-1;
      if(c.kind==='draft')return `<div class="ava-card draft"><div class="ava-card-head"><b>${e(c.title)}</b><button type="button" class="ava-act" onclick="avaCopy(${n})">${c.copied?'Copied':'Copy'}</button></div><div class="ava-draft">${e(c.text)}</div></div>`;
      const done=c.state==='done'?'<p class="ava-card-state">Done.</p>':c.state==='no'?'<p class="ava-card-state">Okay, I won’t.</p>':c.state==='failed'?'<p class="ava-card-state tk-red">That didn’t work — try it from the page.</p>':'';
      return `<div class="ava-card confirm"><p class="ava-card-q"><small>Ava wants to</small><b>${e(c.label)}</b></p>${c.state?done:`<div class="ava-acts"><button type="button" class="ava-act yes" onclick="avaCard(${n},1)">Do it</button><button type="button" class="ava-act" onclick="avaCard(${n},0)">No</button></div>`}</div>`;}).join('');
    const tm=m.notice?'':avaTime(m.at);
    const metaText=[m.meta,tm].filter(Boolean).join(' · ');
    const copy=!m.notice&&!m.greet&&!m.streaming&&m.text?`<button type="button" class="ava-copy" onclick="avaCopyMsg(${i})" aria-label="Copy this answer" title="Copy">${m.copied?AVA_IC.check:AVA_IC.copy}</button>`:'';
    const foot=metaText||copy?`<div class="ava-mfoot">${metaText?`<small class="ava-meta">${e(metaText)}</small>`:''}${copy}</div>`:'';
    const caret='<span class="ava-caret" aria-hidden="true"></span>';
    const md=avaMd(m.text);const body=!m.streaming?md:/<\/(?:p|li)>(?:<\/(?:ul|ol)>)?$/.test(md)?md.replace(/(<\/(?:p|li)>)((?:<\/(?:ul|ol)>)?)$/,caret+'$1$2'):md+caret;
    return `<div class="ava-msg ava${m.notice?' notice':''}${m.streaming?' streaming':''}"><div class="ava-bub">${body}</div>${guide}${cards}${acts?`<div class="ava-acts">${acts}</div>`:''}${foot}${chips}</div>`;
  }).join('')+(AVA.busy?'<div class="ava-msg ava busy" aria-hidden="true"><div class="ava-bub ava-think"><span class="ava-dots"><i></i><i></i><i></i></span><span class="ava-shimmer">Thinking…</span></div></div>':'');
  try{l.scrollTop=l.scrollHeight;}catch(e){}
  avaPaintMic();
}

/* ---- while you hold to talk: a live level meter, and — when the machine has it — a recording for sharper words
   (POST /api/mc/ava/hear, audio ≤ 2 MB → {text}; 404 / 503 = not there, asked again in 10 minutes). The browser's
   own words stay as the live caption and the fallback. ---- */
const AVA_HEAR={ok:null,at:0};
function avaMediaOk(){try{return typeof navigator!=='undefined'&&!!navigator.mediaDevices&&typeof navigator.mediaDevices.getUserMedia==='function'&&typeof window.MediaRecorder==='function'}catch(e){return false}}
function avaHearOn(){return avaMediaOk()&&!(AVA_HEAR.ok===false&&Date.now()-AVA_HEAR.at<10*60e3)}
function avaLevel(v){const p=avaEl('avaPanel');if(p&&p.style&&typeof p.style.setProperty==='function')p.style.setProperty('--lvl',String(Math.round((v||0)*100)/100));}
function avaCaptureStart(){
  const cap={stream:null,rec:null,chunks:[],ac:null,raf:null,stopped:false};AVA.cap=cap;
  if(!avaMediaOk())return cap;
  navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}}).then(stream=>{
    cap.stream=stream;if(cap.stopped){avaCaptureKill(cap);return;}
    try{const C=avaAudioClass();if(C){const ac=new C();const an=ac.createAnalyser();an.fftSize=256;ac.createMediaStreamSource(stream).connect(an);cap.ac=ac;const data=new Uint8Array(an.frequencyBinCount);
      const tick=()=>{if(cap.stopped)return;an.getByteTimeDomainData(data);let sum=0;for(let i=0;i<data.length;i++){const x=(data[i]-128)/128;sum+=x*x;}avaLevel(Math.min(1,Math.sqrt(sum/data.length)*5));cap.raf=requestAnimationFrame(tick);};tick();}}catch(e){}
    if(avaHearOn()){try{const type=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(t=>typeof MediaRecorder.isTypeSupported==='function'&&MediaRecorder.isTypeSupported(t))||'';
      cap.rec=new MediaRecorder(stream,type?{mimeType:type,audioBitsPerSecond:32000}:undefined);cap.rec.ondataavailable=ev=>{if(ev.data&&ev.data.size)cap.chunks.push(ev.data);};cap.rec.start(250);}catch(e){cap.rec=null;}}
  }).catch(()=>{});
  return cap;
}
function avaCaptureKill(cap){
  cap=cap||AVA.cap;if(!cap)return;cap.stopped=true;
  try{if(cap.raf)cancelAnimationFrame(cap.raf);}catch(e){}
  try{if(cap.rec&&cap.rec.state!=='inactive')cap.rec.stop();}catch(e){}
  try{if(cap.stream)cap.stream.getTracks().forEach(t=>t.stop());}catch(e){}
  try{if(cap.ac&&cap.ac.close)cap.ac.close();}catch(e){}
  if(AVA.cap===cap)AVA.cap=null;avaLevel(0);
}
function avaCaptureStop(cap){
  return new Promise(res=>{
    if(!cap||!cap.rec||cap.rec.state==='inactive'){avaCaptureKill(cap);res(null);return;}
    let fin=false;const done=()=>{if(fin)return;fin=true;let b=null;try{b=cap.chunks.length?new Blob(cap.chunks,{type:cap.rec.mimeType||'audio/webm'}):null;}catch(e){}avaCaptureKill(cap);res(b);};
    cap.rec.onstop=done;try{cap.rec.stop();}catch(e){done();}setTimeout(done,1200);
  });
}
async function avaHear(blob){
  if(!blob||!blob.size||blob.size<1500||blob.size>2e6||typeof tkToken!=='function')return null;
  const token=await tkToken();if(!token)return null;
  const init={method:'POST',headers:{authorization:'Bearer '+token,'content-type':blob.type||'audio/webm',accept:'application/json'},body:blob};
  let timer=null;if(typeof AbortController!=='undefined'){const c=new AbortController();init.signal=c.signal;timer=setTimeout(()=>c.abort(),7000);}
  try{
    const r=await fetch(tkMachineUrl()+'/api/mc/ava/hear',init);clearTimeout(timer);
    if(r.status===404||r.status===503){AVA_HEAR.ok=false;AVA_HEAR.at=Date.now();return null;}
    if(!r.ok)return null;const d=await r.json().catch(()=>null);AVA_HEAR.ok=true;
    const t=d&&typeof d.text==='string'?d.text.trim():'';return t||null;
  }catch(e){clearTimeout(timer);return null;}
}
/* Let go after a hold with a recording, before the browser had any words: its last words (they can land a moment after
   letting go) first; the machine's /hear only when the browser has none or can't listen at all. */
async function avaHoldSend(cap,rec){
  const web=rec?new Promise(res=>{rec._deferRes=res;}):Promise.resolve('');
  if(rec){rec._defer=true;}
  avaStopListening({});
  AVA.stage='transcribing';avaPaintHeard();avaPaintMic();
  let said=rec?(String(await Promise.race([web,new Promise(r=>setTimeout(()=>r(''),700))])||'').trim()||(rec._said||'')||avaRecWords(rec)):'';
  if(said)avaCaptureKill(cap);
  else{const blob=await avaCaptureStop(cap);said=(await avaHear(blob))||'';}
  AVA.stage=null;avaPaintHeard();avaPaintMic();
  if(said)return avaAsk(said,{voice:true});
  avaNote(avaCanListen()?(avaIsPhone()?"I didn't hear anything — hold the mic while you talk, then let go.":"I didn't hear anything — hold Space while you talk, then let go."):"I couldn't make out any words — try again, or type your question.");
  return null;
}

/* ===================== 10b. READING THE SCREEN OUT =====================
   "Read this", "what's on this page", "read me the numbers", "open Lakeview's money and read it", the AI's
   {type:'read', what:'page'}: a spoken summary of what is on the screen now, built here from the page itself — nothing is
   sent anywhere. The page's title; each number tile as "label: value, sub"; card headings; a table as "N rows" and its
   first five rows as short sentences; a list (conversations, emails, to-dos, applications, calls) as its first five
   items. Buttons, the tab bar, hidden parts and Ava's own panel are skipped. About 90 seconds at a time: "read more"
   goes on, "stop" stops. Semantic hooks first (.tk-key, headings, tables, .tk-convo, .cal-ev, details), a plain walk
   of the rest. Waits (up to ~4 s) for a page that is still loading. */
const AVA_READ_WORDS=220;   // ≈ 90 seconds of speech
const AVA_READ_ITEMS=5;
const AVA_READ_ITEM_WORDS=24;   // one row or item, said in a breath
const AVA_READ_WAIT=4000;
const AVA_R_SKIP_TAG=new Set(['SCRIPT','STYLE','SVG','NAV','SELECT','INPUT','TEXTAREA','OPTION','LABEL','NOSCRIPT','TEMPLATE','IFRAME','CANVAS','IMG','VIDEO','AUDIO','PROGRESS','METER','DIALOG','HR']);
const AVA_R_SKIP_CLS=['tk-sysbar','tk-sys-head','cal-bar','cal-nav','cal-tools','tk-chart-body','tk-chart-x','tk-chart-y','tk-legend','cal-gutter','cal-dayhead','cal-corner','tk-sr','ava-sr',
  'tk-convo-go','cal-req-acts','pp-av','tk-mv-av','avatar','tk-app-doc','tk-count','ava-count','tk-set-links','cal-foot','tk-updated','tk-jcap','toolbar','seg','tk-mail-more','tk-oc-acts','tk-todo-act','tk-add','btn'];
const AVA_R_SKIP_ID=new Set(['avaPanel','avaFab','avaTip','avaHeard','toast']);
const AVA_R_INLINE=new Set(['B','STRONG','I','EM','A','SMALL','CODE','BR','ABBR','TIME','MARK','SUB','SUP','U','S','KBD','Q','WBR']);
const AVA_R_NOITEM=new Set(['P','H1','H2','H3','H4','H5','H6','DETAILS','SECTION','TABLE','FORM','FIGURE','BR','HR','BLOCKQUOTE','PRE']);
function avaTag(e){return String((e&&(e.tagName||e.nodeName))||'').toUpperCase()}
function avaCls(e){const c=e&&e.className;return typeof c==='string'?c:(c&&typeof c.baseVal==='string'?c.baseVal:'')}
function avaHasCls(e,c){return (' '+avaCls(e)+' ').indexOf(' '+c+' ')>=0}
function avaAttr(e,k){try{return e&&typeof e.getAttribute==='function'?e.getAttribute(k):null}catch(x){return null}}
function avaKids(e){try{return Array.from((e&&e.childNodes)||[])}catch(x){return []}}
function avaElKids(e){return avaKids(e).filter(n=>n&&n.nodeType===1)}
function avaFind(e,test){if(!e||e.nodeType!==1)return null;if(test(e))return e;for(const k of avaElKids(e)){const f=avaFind(k,test);if(f)return f;}return null}
function avaFindAll(e,test,out){out=out||[];if(!e||e.nodeType!==1||avaSkip(e))return out;if(test(e)){out.push(e);return out;}avaElKids(e).forEach(k=>avaFindAll(k,test,out));return out}
function avaItemButton(e){return avaHasCls(e,'cal-ev')||avaHasCls(e,'tk-convo')||avaElKids(e).filter(k=>avaTag(k)!=='SVG').length>=2}
/* Not read: controls, the tab bar, hidden parts, screen-reader-only words, Ava herself. */
function avaSkip(e){
  const tag=avaTag(e);if(AVA_R_SKIP_TAG.has(tag))return true;
  if(e.id&&AVA_R_SKIP_ID.has(e.id))return true;
  if(e.hidden===true||avaAttr(e,'hidden')!=null||avaAttr(e,'aria-hidden')==='true')return true;
  const cls=avaCls(e);if(cls&&AVA_R_SKIP_CLS.some(c=>(' '+cls+' ').indexOf(' '+c+' ')>=0)&&!avaHasCls(e,'tk-convo')&&!avaHasCls(e,'cal-ev'))return true;
  if(tag==='BUTTON'&&!avaItemButton(e))return true;
  if(typeof window!=='undefined'&&typeof window.getComputedStyle==='function'&&e.nodeType===1&&e.isConnected!==false){
    try{const cs=window.getComputedStyle(e);if(cs&&(cs.display==='none'||cs.visibility==='hidden'))return true;}catch(x){}}
  return false;
}
/* Words fit to say: no email or web addresses, "·" as a pause, no arrows. */
function avaClean(s){
  return String(s||'').replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi,' ').replace(/https?:\/\/\S+/g,' ').replace(/[›»◀▶↗]/g,' ')
    .replace(/\s*·\s*/g,', ').replace(/\s+/g,' ').replace(/\(\s*\)/g,' ').replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/g,'').replace(/\s+([,.!?;:])/g,'$1').replace(/,(\s*,)+/g,',').trim();
}
function avaText(e){
  if(!e)return '';if(e.nodeType===3)return String(e.nodeValue!=null?e.nodeValue:e.textContent||'');
  if(e.nodeType!==1||avaSkip(e))return '';if(avaTag(e)==='BR')return ' ';
  let s='';avaKids(e).forEach(k=>{const t=avaText(k);if(!t)return;s+=k.nodeType===1&&s&&!/\s$/.test(s)&&!/^[\s,.;:!?)%]/.test(t)?' '+t:t;});
  return s;
}
/* An element as its separate bits of text (a cell's name and company, a tile's label, value and note). */
function avaPieces(e,out){
  out=out||[];if(!e)return out;
  if(e.nodeType===3){const t=avaClean(e.nodeValue!=null?e.nodeValue:e.textContent);if(t)out.push(t);return out;}
  if(e.nodeType!==1||avaSkip(e))return out;
  const al=avaAttr(e,'aria-label');if(al&&(avaTag(e)==='BUTTON'||avaHasCls(e,'cal-ev'))){out.push(avaClean(al));return out;}
  const els=avaElKids(e).filter(k=>avaTag(k)!=='BR'&&!avaSkip(k));
  const ownText=avaKids(e).some(k=>k.nodeType===3&&String(k.nodeValue||k.textContent||'').trim());
  if(!els.some(k=>!AVA_R_INLINE.has(avaTag(k)))&&(ownText||els.length<2)){const t=avaDay(avaClean(avaText(e)));if(t)out.push(t);return out;}
  avaKids(e).forEach(k=>avaPieces(k,out));return out;
}
/* A cell that is only a date ("Tue 29 Sep, 3:00 pm") is said the way people say it: "today at 3:00 pm". */
function avaDay(t){
  const m=String(t||'').match(/^((?:mon|tue|wed|thu|fri|sat|sun)[a-z]* \d{1,2} [a-z]{3})[a-z]*(?:,? (\d{1,2}:\d{2} ?[ap]m))?$/i);
  return m?avaSpokenDay(m[1])+(m[2]?' at '+m[2]:''):t;
}
function avaJoin(ps,max){
  const seen=new Set();const xs=ps.filter(p=>{const k=String(p||'').toLowerCase();if(!k||seen.has(k))return false;seen.add(k);return true;});
  let s=xs.join(', ');const w=s.split(' ');max=max||AVA_READ_ITEM_WORDS;if(w.length>max)s=w.slice(0,max).join(' ').replace(/[,;:]$/,'')+'…';return s;
}
const AVA_MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const AVA_WEEKDAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
/* "Tue 29 Sep, 2:10 pm" → "today" / "yesterday" / "Monday" (this week) / "3 September". */
function avaSpokenDay(s,now){
  const m=String(s||'').trim().match(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(\d{1,2})\s+([a-z]{3})[a-z]*/i);if(!m)return avaClean(s);
  now=now||(typeof calNow==='function'?calNow():new Date());
  const mo=AVA_MONTHS.findIndex(x=>x.slice(0,3).toLowerCase()===m[2].toLowerCase());if(mo<0)return avaClean(s);
  const today=Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());let d=Date.UTC(now.getFullYear(),mo,+m[1]);
  if(d-today>60*864e5)d=Date.UTC(now.getFullYear()-1,mo,+m[1]);
  const diff=Math.round((today-d)/864e5);
  if(diff===0)return 'today';if(diff===1)return 'yesterday';if(diff===-1)return 'tomorrow';
  if(diff>1&&diff<7)return AVA_WEEKDAYS[new Date(d).getUTCDay()];
  return +m[1]+' '+AVA_MONTHS[mo];
}
function avaLower(s){s=String(s||'');return /^[A-Z][a-z]/.test(s)?s.charAt(0).toLowerCase()+s.slice(1):s}
/* One conversation: "Beacon Plastics, Interested, handed to the client, Monday". */
function avaConvoLine(e){
  const one=c=>{const x=avaFind(e,k=>avaHasCls(k,c));return x?avaClean(avaText(x)):''};
  const at=one('tk-convo-at');
  return avaJoin([one('tk-convo-who'),one('pill'),avaLower(one('tk-convo-by')),at?avaSpokenDay(at):'']);
}
function avaItemLine(e){
  if(avaHasCls(e,'tk-convo'))return avaConvoLine(e);
  const al=avaAttr(e,'aria-label');if(al&&(avaTag(e)==='BUTTON'||avaHasCls(e,'cal-ev')))return avaClean(al);
  const ps=avaPieces(e);
  if(ps.length===2&&/^[$\d][\d,.%$]*$/.test(ps[0])&&!/^[$\d]/.test(ps[1]))return ps[1]+': '+ps[0];   // a stage tile: "Applied: 1"
  return avaJoin(ps);
}
/* A tile: "Emails sent: 1,216, since Fri 4 Sep". */
function avaTile(e){
  const ps=avaPieces(e);if(!ps.length)return '';if(ps.length===1)return ps[0];
  return ps[0]+': '+ps[1]+(ps.length>2?', '+ps.slice(2).map(avaLower).join(', '):'');
}
/* A number with its label ("<small>Received from them</small><b>$0</b>") reads like a tile. */
function avaIsTile(e){if(avaHasCls(e,'tk-key'))return true;const k=avaElKids(e).filter(x=>!avaSkip(x));return k.length>=2&&k.length<=3&&avaTag(k[0])==='SMALL'&&avaTag(k[1])==='B'}
/* Label / value pairs (.tk-kv's <small>label</small><span>value</span>…, or <dl>) → "Plan: Free trial". */
function avaPairs(e,out){
  const k=avaElKids(e).filter(x=>!avaSkip(x));let label=null;
  k.forEach(x=>{const t=avaTag(x);const txt=avaJoin(avaPieces(x));
    if(t==='DT'||(t==='SMALL'&&label==null)){label=txt;return;}
    if(label!=null){if(txt)out.push({k:'text',t:label+': '+txt});label=null;}else if(txt)out.push({k:'text',t:txt});});
  if(label)out.push({k:'text',t:label});
}
/* The chat under Messages: the newest first. */
function avaChatLine(e){
  const one=c=>{const x=avaFind(e,k=>avaHasCls(k,c));return x?x:null};
  const head=one('tk-cm-head');const at=one('tk-cm-at');
  const who=head?avaClean(avaText(avaFind(head,k=>avaTag(k)==='B')||head)):'';
  const when=at?avaDay(avaClean(avaText(avaElKids(at).length?{nodeType:1,tagName:'SPAN',childNodes:avaKids(at).filter(n=>n.nodeType===3)}:at))):'';
  const subj=one('tk-cm-subj'),text=one('tk-cm-text');
  return avaJoin([who,when,subj?avaClean(avaText(subj)):'',text?avaClean(avaText(text)):''].filter(Boolean));
}
function avaHasHead(e){return !!avaFind(e,k=>/^H[1-4]$/.test(avaTag(k))||avaTag(k)==='TABLE')}
/* The items of a list: <ul>/<ol>, or a box whose children are mostly alike (conversations, calls, requests…). */
function avaListItems(e){
  const tag=avaTag(e);const kids=avaElKids(e).filter(k=>!avaSkip(k));
  if(tag==='UL'||tag==='OL'){const li=kids.filter(k=>avaTag(k)==='LI');return li.length?li:null;}
  if(kids.length<2)return null;
  const sig=k=>avaTag(k)+'.'+(avaCls(k).trim().split(/\s+/)[0]||'');
  const count={};kids.forEach(k=>{const g=sig(k);count[g]=(count[g]||0)+1;});
  const top=Object.keys(count).sort((a,b)=>count[b]-count[a])[0];const n=count[top];
  if(n<2||n<kids.length*0.6)return null;
  const items=kids.filter(k=>sig(k)===top);
  if(AVA_R_NOITEM.has(avaTag(items[0])))return null;
  if(items.some(k=>avaHasCls(k,'tk-key')||avaHasHead(k)))return null;   // tiles, and cards with their own headings, are read one by one
  return items;
}
function avaTable(e,out){
  const rows=[];const walk=n=>avaElKids(n).forEach(k=>{const t=avaTag(k);if(t==='TR')rows.push(k);else if(t==='THEAD'||t==='TBODY'||t==='TFOOT')walk(k);});walk(e);
  const cells=r=>avaElKids(r).filter(c=>{const t=avaTag(c);return (t==='TD'||t==='TH')&&!avaSkip(c)});
  const data=rows.filter(r=>!avaSkip(r)&&cells(r).length&&!cells(r).every(c=>avaTag(c)==='TH'));
  if(!data.length){out.push({k:'text',t:'The table is empty.'});return;}
  out.push({k:'text',t:avaPlural(data.length,'row')+(data.length>AVA_READ_ITEMS?' — the first '+AVA_READ_ITEMS+':':':')});
  data.slice(0,AVA_READ_ITEMS).forEach(r=>{const t=avaJoin(cells(r).map(c=>avaJoin(avaPieces(c))).filter(Boolean));if(t)out.push({k:'item',t});});
}
function avaListOut(items,out){
  const lines=items.map(avaItemLine);
  const cap=lines.every(t=>avaWords(t)<=4)?AVA_READ_ITEMS*2:AVA_READ_ITEMS;   // short ones (stage tiles, names): a few more
  if(items.length>cap)out.push({k:'text',t:avaNum(items.length)+' in all — the first '+cap+':'});
  lines.slice(0,cap).forEach(t=>{if(t)out.push({k:'item',t});});
}
/* A heading, with the count some carry ("Conversations · 8", "New trial applications <span>1</span>") as "…: 8". */
function avaHeadText(e){
  const ps=avaPieces(e);const last=ps[ps.length-1]||'';
  if(ps.length>=2&&/^[\d,]+( open| new| waiting)?$/.test(last))return avaClean(ps.slice(0,-1).join(' '))+': '+last;
  return avaClean(avaText(e)).replace(/, ([\d,]+)$/,': $1');
}
/* Settings: the section(s) open read in full, the others named in one line. */
function avaSettingsOut(e,out){
  const secs=avaElKids(e).filter(k=>avaTag(k)==='DETAILS'&&!avaSkip(k));
  const open=secs.filter(d=>d.open===true||avaAttr(d,'open')!=null),shut=secs.filter(d=>!open.includes(d));
  open.forEach(d=>avaWalk(d,out));
  const name=d=>{const t=avaFind(d,k=>avaHasCls(k,'tk-set-title'));return t?avaClean(avaText(t)):avaJoin(avaPieces(avaElKids(d).find(k=>avaTag(k)==='SUMMARY')||d)).split(',')[0]};
  if(shut.length)out.push({k:'text',t:(open.length?'The other sections: ':'The sections: ')+avaList(shut.map(name).filter(Boolean))});
}
/* The page, in reading order → [{k:'head'|'tile'|'text'|'item', t}]. */
function avaWalk(e,out){
  if(!e||e.nodeType!==1||avaSkip(e))return;
  const tag=avaTag(e);
  if(tag==='DETAILS'&&!(e.open===true||avaAttr(e,'open')!=null)){   // folded: only its title (not "Show the numbers")
    const sm=avaElKids(e).find(k=>avaTag(k)==='SUMMARY');const t=sm?avaJoin(avaPieces(sm)):'';
    if(t&&!/^(show|see|hide|more|open|read)\b/i.test(t))out.push({k:'text',t});return;}
  if(tag==='SUMMARY'){const title=avaFind(e,k=>avaHasCls(k,'tk-set-title'));const pill=avaFind(e,k=>avaHasCls(k,'pill'));
    const t=title?avaClean(avaText(title))+(pill&&avaClean(avaText(pill))?' — '+avaClean(avaText(pill)):''):avaJoin(avaPieces(e));if(t)out.push({k:'head',t});return;}
  if(avaHasCls(e,'tk-sets')){avaSettingsOut(e,out);return;}
  if(avaHasCls(e,'tk-journey')){const al=avaAttr(e,'aria-label');if(al)out.push({k:'text',t:avaClean(al.replace(/^the trial journey,?\s*/i,'Journey: '))});return;}
  if(avaIsTile(e)){const t=avaTile(e);if(t)out.push({k:'tile',t});return;}
  if(avaHasCls(e,'tk-kv')||tag==='DL'){avaPairs(e,out);return;}
  if(avaHasCls(e,'tk-chat')){const ms=avaElKids(e).filter(k=>avaHasCls(k,'tk-cm')&&!avaSkip(k)).reverse();
    if(!ms.length)return;out.push({k:'text',t:avaPlural(ms.length,'message')+(ms.length>AVA_READ_ITEMS?' — the newest '+AVA_READ_ITEMS+':':', the newest first:')});
    ms.slice(0,AVA_READ_ITEMS).forEach(m=>{const t=avaChatLine(m);if(t)out.push({k:'item',t});});return;}
  if(avaHasCls(e,'section-head')){const h=avaFind(e,k=>/^H[1-6]$/.test(avaTag(k)));const c=avaFind(e,k=>avaHasCls(k,'count'));
    const t=avaClean(h?avaText(h):avaText(e));if(t)out.push({k:'head',t:t+(c&&avaClean(avaText(c))?': '+avaClean(avaText(c)):'')});return;}
  if(/^H[1-6]$/.test(tag)){out.push({k:'head',t:avaHeadText(e)});return;}
  if(tag==='TABLE'){avaTable(e,out);return;}
  if(avaHasCls(e,'cal-grid')){const evs=avaFindAll(e,k=>avaHasCls(k,'cal-ev'));
    if(!evs.length){out.push({k:'text',t:'Nothing on the calendar this week.'});return;}
    out.push({k:'text',t:avaPlural(evs.length,'thing')+' on the calendar'+(evs.length>AVA_READ_ITEMS?' — the first '+AVA_READ_ITEMS+':':':')});
    evs.slice(0,AVA_READ_ITEMS).forEach(i=>{const t=avaItemLine(i);if(t)out.push({k:'item',t});});return;}
  const items=avaListItems(e);if(items){avaListOut(items,out);return;}
  const kids=avaKids(e);
  if(!kids.some(k=>k.nodeType===1&&!AVA_R_INLINE.has(avaTag(k))&&!avaSkip(k))){const t=avaClean(avaText(e));if(t)out.push({k:'text',t});return;}
  kids.forEach(k=>{if(k.nodeType===3){const t=avaClean(k.nodeValue!=null?k.nodeValue:k.textContent);if(t)out.push({k:'text',t});}else avaWalk(k,out);});
}
function avaReadRoot(){return avaEl('content')}
/* Still loading? (every screen shows renderLoading's .tk-loading while it waits for the machine) */
function avaPageBusy(){
  const r=avaReadRoot();if(!r)return false;
  if(typeof r.querySelector==='function'&&r.childNodes&&r.childNodes.length!=null&&typeof r.getElementsByClassName==='function')return !!r.querySelector('.tk-loading');
  return !!avaFind(r,k=>avaHasCls(k,'tk-loading'));
}
/* The page's name as she says it: "Lakeview IT — Money & plan. Free trial, Day 12 of 30." */
function avaPageTitle(){
  const pt=avaEl('ptitle'),ps=avaEl('psub');const title=avaClean(pt?pt.textContent:''),sub=avaClean(ps?ps.textContent:'');
  const v=typeof currentView!=='undefined'?currentView:'';
  if(v==='clientSystem'&&typeof currentTrialId!=='undefined'&&currentTrialId){
    const k=typeof tkTabKey==='function'?tkTabKey(typeof trialTab!=='undefined'?trialTab:'overview'):'overview';
    const all=typeof TK_SYS_SHARED!=='undefined'?TK_SYS_SHARED.concat(TK_SYS_PRIVATE):[];const tab=(all.find(x=>x[0]===k)||[k,k])[1];
    return avaClientName(currentTrialId)+' — '+tab+(sub?'. '+sub:'');
  }
  if(v==='trial'||v==='trialPurchase')return title+(sub?'. '+sub:'');
  return title||'This page';
}
/* What is on the screen now, line by line (numbersOnly: the title and the number tiles, when there are any). */
function avaPageLines(numbersOnly){
  const out=[];avaWalk(avaReadRoot(),out);
  let body=out;if(numbersOnly){const n=out.filter(x=>x.k==='tile');if(n.length)body=n;}
  const lines=[{k:'title',t:avaPageTitle()}];
  body=body.filter(x=>!(x.k==='text'&&/\b(tap|click) (one|it|here|to)\b/i.test(x.t)&&avaWords(x.t)<14));   // "tap one to read it": a hint for the eyes
  body=body.filter((x,i)=>!(x.k==='head'&&(!body[i+1]||body[i+1].k==='head')));   // a heading with nothing under it (a chart)
  body.forEach(x=>{const last=lines[lines.length-1];if(x.t&&!(last&&last.t===x.t))lines.push(x);});
  if(lines.length===1)lines.push({k:'text',t:'There is nothing to read on this page.'});
  return lines;
}
function avaWords(s){return String(s||'').split(/\s+/).filter(Boolean).length}
/* The next ~90 seconds of AVA.readRest → {text (shown), say (spoken), chips, more}. */
function avaReadNext(){
  const rest=AVA.readRest||[];
  if(!rest.length)return {text:"That's everything on this page.",say:"That's everything on this page.",chips:null,more:false,none:true};
  const chunk=[];let words=0;
  while(rest.length&&(chunk.length===0||words+avaWords(rest[0].t)<=AVA_READ_WORDS)){const x=rest.shift();chunk.push(x);words+=avaWords(x.t);}
  const more=rest.length>0;if(!more)AVA.readRest=null;
  const md=chunk.map(x=>x.k==='title'||x.k==='head'?'**'+x.t.replace(/\*/g,'')+'**':x.k==='item'?'- '+x.t:x.t).join('\n');
  const say=chunk.map(x=>avaSentence(x.t.replace(/[:—–]\s*$/,''))).join(' ');
  return {text:md+(more?"\n\nThere's more — say “read more” to go on, or “stop”.":''),say:say+(more?" There's more. Say read more to go on, or stop.":''),chips:more?['Read more','Stop']:null,more};
}
function avaSleep(ms){return new Promise(r=>setTimeout(r,ms))}
/* Wait for the screen: a beat for it to draw, then (up to AVA_READ_WAIT) until nothing on it is loading. */
async function avaWaitPage(max){
  max=max==null?AVA_READ_WAIT:max;const t0=Date.now();
  await avaSleep(40);
  while(avaPageBusy()&&Date.now()-t0<max)await avaSleep(120);
  return !avaPageBusy();
}
/* Read the screen: {what:'page'|'numbers'|'more'} → the first (or next) part. */
async function avaReadPage(what){
  what=what||'page';
  if(what==='more')return avaReadNext();
  await avaWaitPage();
  AVA.readRest=avaPageLines(what==='numbers');
  return avaReadNext();
}
/* "read this", "what's on this page", "read me the numbers", "read more", "stop", "open X and read it" → what to do, or null. */
const AVA_READ_OBJ='(?: me)?(?: (?:this|it|that|the page|this page|the screen|this screen|this tab|the tab|the section|this section|everything|all of it|it all|what is here|what is on (?:it|this page|the page|the screen|this screen|this tab)|the details|the whole page|the page for me))?(?: out)?(?: loud| aloud)?(?: to me| for me)?';
const AVA_READ_RE=new RegExp('^(?:read|read out)'+AVA_READ_OBJ+'$');
const AVA_READ_ASK=/^(?:what is|whats) (?:on|in) (?:this|the|my) (?:page|tab|screen|section)(?: now)?$|^what am i looking at$|^what is here$|^what does (?:this|the) (?:page|screen|tab) say$|^tell me what is (?:on|in) (?:this|the) (?:page|screen|tab)$|^(?:describe|summari[sz]e) (?:this|the) (?:page|screen|tab)$/;
const AVA_READ_NUM=/^(?:read|tell|give|say)(?: me)? (?:the |these |those |its |their |all the )?(?:numbers|stats|figures)(?: out)?(?: loud| aloud)?(?: to me)?(?: on (?:this|the) (?:page|screen|tab))?$/;
const AVA_READ_MORE=/^(?:read more|more|continue|keep going|go on|keep reading|carry on|read on|read the rest|the rest|next|next part|read the next part)$/;
const AVA_READ_STOP=/^(?:stop|stop reading|stop talking|stop it|that is enough|that enough|thats enough|enough|be quiet|quiet|shush|hush|ok stop|okay stop)$/;
const AVA_READ_THEN=/^(.+?)\s+(?:and|then|and then)\s+(?:read(?: me)?(?: it| this| that| them| the details| everything| what is there| it all)?(?: out)?(?: loud| aloud)?(?: to me)?|tell me what is (?:on it|there|in it)|what is (?:on it|there))$/;
function avaReadCmd(text){
  const t=avaNorm(text).replace(/^(?:hey )?ava\s+/,'').replace(/^(?:please|can you|could you|would you)\s+/,'').replace(/\s+(?:please|ava|for me|now)$/,'').trim();
  if(!t)return null;
  if(AVA_READ_STOP.test(t))return {kind:'stop'};
  if(AVA_READ_MORE.test(t))return (AVA.readRest&&AVA.readRest.length)||/^read/.test(t)?{kind:'more'}:null;
  if(AVA_READ_NUM.test(t))return {kind:'read',numbers:true};
  if(AVA_READ_RE.test(t)||AVA_READ_ASK.test(t))return {kind:'read'};
  const m=t.match(AVA_READ_THEN);if(m&&avaIsCommand(m[1]))return {kind:'navread',nav:m[1]};
  const r=t.match(/^read(?: me| out)? (.+?)(?: out)?(?: loud| aloud)?(?: to me)?$/);   // "read me Lakeview's money", "read the calendar"
  if(r&&avaIsCommand('open '+r[1]))return {kind:'navread',nav:'open '+r[1]};
  return null;
}

/* ===================== 11. SHELL HOOKS (no edits to the other files) =====================
   Hold Space (not in a text box) to talk, let go to send; a tap on Space opens / closes her. Ctrl/⌘+J opens and closes
   Ava; Esc stops her talking, then closes her; "Ask Ava" is in ⌘K; she shows only while someone is signed in (the
   shell's enterApp / showLogin are wrapped, not changed). */
function avaIsSpace(e){return e&&(e.code==='Space'||e.key===' '||e.key==='Spacebar')}
function avaKey(e){
  if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&String(e.key||'').toLowerCase()==='j'){
    if(typeof authUser!=='undefined'&&!authUser)return;e.preventDefault&&e.preventDefault();
    if(AVA.open)avaClose();else{avaOpen({listen:false});}return;
  }
  if(avaIsSpace(e)&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey&&!e.isComposing){
    if(typeof authUser!=='undefined'&&!authUser)return;
    if(avaEditable(e.target)||avaEditable(typeof document!=='undefined'?document.activeElement:null)||avaModalOpen())return;
    e.preventDefault&&e.preventDefault();
    if(e.repeat||AVA.ptt)return;
    avaHush();avaHoldStart('space');return;
  }
  if(e.key==='Escape'&&AVA.open){
    if(avaModalOpen())return;
    if(AVA.speaking){avaHush();return;}
    avaClose();
  }
}
function avaKeyUp(e){
  if(!avaIsSpace(e)||!AVA.ptt||AVA.ptt.src!=='space')return;
  e.preventDefault&&e.preventDefault();
  avaHoldEnd();
}
/* The window lost focus while holding: let go. */
function avaBlur(){if(AVA.ptt)avaHoldEnd();}
function avaHook(){
  if(typeof document!=='undefined'&&typeof document.addEventListener==='function'){
    document.addEventListener('keydown',avaKey,true);document.addEventListener('keyup',avaKeyUp,true);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)avaBlur();});
  }
  if(typeof window!=='undefined'&&typeof window.addEventListener==='function')window.addEventListener('blur',avaBlur);
  if(typeof enterApp==='function'&&!enterApp._ava){const orig=enterApp;enterApp=function(){const r=orig.apply(this,arguments);try{avaMount();avaSync();}catch(e){}return r};enterApp._ava=true;}
  if(typeof showLogin==='function'&&!showLogin._ava){const orig=showLogin;showLogin=function(){const r=orig.apply(this,arguments);try{avaSync();}catch(e){}return r};showLogin._ava=true;}
  if(typeof cmdkActions==='function'&&!cmdkActions._ava){const orig=cmdkActions;cmdkActions=function(){const a=orig.apply(this,arguments);a.unshift({type:'Ava',label:'Ask Ava',icon:AVA_IC.mic,sub:'Your helper — hold Space to talk, or type (Ctrl/⌘ J)',kw:'ask ava voice help helper assistant talk speak question how do i',run:()=>{closeCmdk();avaOpen({listen:false});}});return a};cmdkActions._ava=true;}
  try{avaMount();avaSync();}catch(e){}
  try{if(avaCanSpeak()&&window.speechSynthesis.addEventListener)window.speechSynthesis.addEventListener('voiceschanged',()=>{AVA.voice=null;});}catch(e){}
}
avaHook();
