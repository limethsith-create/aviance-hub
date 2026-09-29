/* ============================================================================
   ava.js — Ava, the hub's own helper (voice + typing)
   ----------------------------------------------------------------------------
   Ava (from AVIance) listens, answers out loud and takes you to the right page.
   Free: no key, no paid service. Loaded last by index.html (after people.js),
   so it can read everything the hub already knows:
     tk (trials.js: the board tk.hub, each client's page tk.detail, My stats tk.outreach),
     cal (calendar.js), tm (people.js: the team), authUser + hubIsOwner() (the shell).

     Ears   — the browser's SpeechRecognition (Chrome/Edge/Safari; Chrome turns the voice
              into text on Google's servers). Typing always works (Firefox has no voice).
     Mouth  — speechSynthesis, on the device. A mute switch, remembered on this device.
     Brain  — avaThink(text, ctx) → {say, actions, auto?, confirm?}: local rules over the loaded
              data + the written guide AVA_KB. No network. A smarter brain can replace
              avaThink later (same shape, may return a promise) — avaAsk awaits it.

   Roles: a team member (read-only, body.ro) never hears money and gets no action that changes
   anything. The owner's actions (open the add-a-client form, give access, the test run) always
   ask first ("Yes, do it") and only ever OPEN the place — Ava never sends an email or says
   yes/no to an applicant by herself.

   Every name here starts with "ava" / "AVA" (one global script with the others).
   ========================================================================== */

/* ===================== 0. STATE ===================== */
const AVA={open:false,listening:false,rec:null,log:[],acts:[],pending:null,greeted:false,muted:null,busy:false,interim:'',mounted:false,voice:null,lastClient:null};
const AVA_MUTE_KEY='avianceAvaMute:v1';
const AVA_MAX_LOG=24;

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
  ['set-keys',/\bkeys?\b/,'Settings › Keys',()=>openSettings('keys'),true],
  ['set-details',/\byour details\b|\bmy details\b/,'Settings › Your details',()=>openSettings('details'),true],
  ['set-google',/\bmeet\b/,'Settings › Google Meet',()=>openSettings('google'),true],
  ['set-replybot',/\breply bot\b|\bauto ?reply\b/,'Settings › Reply bot',()=>openSettings('replybot'),true],
  ['set-inboxes',/\bcheapinboxes\b|\binboxes (and|&) domains\b/,'Settings › Inboxes & domains',()=>openSettings('inboxes'),true],
  ['set-phone',/\bphone alerts?\b|\bnotifications\b/,'Phone alerts',()=>openPhoneAlerts(),true],
  ['set-alerts',/\balerts?\b/,'Settings › Alerts',()=>openSettings('alerts'),true],
  ['set-status',/\beverything running\b|\bhealth check\b/,'Settings › Is everything running?',()=>openSettings('status'),true],
  ['settings',/\bsettings\b/,'Settings',()=>render('settings'),true],
];
function avaPlace(key){const p=AVA_PLACES.find(x=>x[0]===key);return p?avaAct('Open '+p[2],p[3],{owner:!!p[4],place:key}):null}
/* A client's email system, at one tab. The tab names the owner hears → the keys the hub may use for them; the
   first one this hub knows wins (Overview when none does). "Only you" tabs are the owner's. */
const AVA_TABS={
  overview:{words:/\boverview\b|\bnumbers\b/,keys:['overview'],label:'Overview'},
  conversations:{words:/\bconversations?\b|\breplies\b|\bthreads?\b/,keys:['conversations'],label:'Conversations'},
  emails:{words:/\bemails sent\b|\bsent emails\b|\bemails\b/,keys:['emails','sent'],label:'Emails sent'},
  messages:{words:/\bmessages?\b|\bchat\b/,keys:['messages'],label:'Messages'},
  calls:{words:/\bcalls?\b|\bmeetings?\b/,keys:['calls'],label:'Calls'},
  money:{words:/\bmoney\b|\binvoices?\b|\bpaid\b|\bpayments?\b/,keys:['money','overview'],label:'Money',owner:true,section:'money'},
  health:{words:/\bhealth\b|\bdeliverability\b|\bbounces?\b|\bspam\b/,keys:['health','deliverability'],label:'Health',owner:true},
  leads:{words:/\bleads?\b|\blist\b/,keys:['leads'],label:'Leads',owner:true},
  setup:{words:/\bsetup\b|\bdomain\b|\binboxes\b|\baccess\b/,keys:['setup'],label:'Setup',owner:true},
  history:{words:/\bhistory\b|\btimeline\b|\blog\b/,keys:['history','timeline'],label:'History'},
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
  {id:'settings',kw:'settings sections what is in settings',a:"Settings has named sections, each saying its state in one word: Alerts, Phone alerts, Your details, Keys, Google Meet, Inboxes and domains, Warm-up, Reply bot, Test run, Is everything running, Behind the scenes, Advanced, Light or dark, and Your account.",go:'settings',owner:true},
  {id:'keys',kw:'keys api key paste service google places verify test and save forget',a:"Settings, Keys has one card per free service the system uses. Each card says its state and the steps to get the key; paste it once and press Test and save. A saved key is never shown again.",go:'set-keys',owner:true},
  {id:'details',kw:'your details name address call link paypal wise clutch onboarding inbox',a:"Settings, Your details holds what the emails say about you — your name, address, email, the onboarding inbox, call link, PayPal, Wise and Clutch. Each has its own Save; it tells you what's still to fill in.",go:'set-details',owner:true},
  {id:'meet',kw:'google meet connect link calls video',a:"Settings, Google Meet connects your Google account so every call you say yes to gets a Meet link. Follow the numbered steps once, press Connect Google, then Test it.",go:'set-google',owner:true},
  {id:'phone',kw:'phone alerts push notifications iphone home screen',a:"Phone alerts send a message to your phone when something needs you. On an iPhone, add the hub to your Home Screen first, then open it from there and turn alerts on.",go:'set-phone',owner:true},
  {id:'opened',kw:'opened blank empty dash not tracked opens client why',a:"Opened is blank for clients on purpose: their emails go out without an open tracker, because trackers hurt landing in the inbox. So there's nothing to count. Only your own outreach on My stats tracks opens.",go:'mystats'},
  {id:'bounce',kw:'bounce bounced what is bounce rate address does not exist pause',a:"A bounce is an email that came back because the address doesn't exist or the mailbox refused it. A few are normal. If too many bounce — about 2 to 3 percent — sending slows down or pauses by itself to protect the inboxes, and you get an alert.",go:null},
  {id:'bell',kw:'bell notifications what needs you alerts not seen mark as seen',a:"The bell at the top lists what needs you right now. Settings, Alerts has every message from the system, not seen first, with Mark as seen.",go:'set-alerts'},
  {id:'search',kw:'search find command k shortcut keyboard slash',a:"Press Control or Command K — or the slash key — to find any client or page. Press Control or Command J to talk to me.",go:null},
  {id:'dark',kw:'dark mode light theme look',a:"Settings, Light or dark switches how the hub looks on this device. It's also in the Control K search.",go:'settings',owner:true},
  {id:'behind',kw:'behind the scenes board every to do waiting list queue parts',a:"Behind the scenes, in Settings, is the full picture: every trial by stage, every to-do in one list, the waiting list and your own sending. Each client's email system also has behind-the-scenes tabs like Growth, Parts and Deliverability.",go:'behind'},
  {id:'waitlist',kw:'three trials waiting list queue full max limit',a:"At most three trials run at the same time. Anyone else you say yes to joins the waiting list and starts when a place opens.",go:'behind'},
  {id:'inquiries',kw:'plan call requests inquiries paid plan booked call website',a:"Plan call requests are people who booked a call about a paid plan from the website without an application. Find them at the bottom of Paying clients.",go:'inquiries'},
  {id:'ava',kw:'who are you ava privacy voice listen microphone data google what can you do',a:"I'm Ava, the hub's helper. I work inside your browser for free: I read what the hub has already loaded and never send your data anywhere. Only the voice-to-text is done by your browser — Chrome uses Google for that. You can always type instead.",go:null},
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

  // 7. the guide, less sure
  if(kb)return avaKbAnswer(kb.entry,ctx);

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
  if(want){
    const spec=AVA_TABS[want];
    if(spec.owner&&!ctx.owner)return avaOwnerOnly(spec.label.toLowerCase()+' is in the Only you part of their email system');
    return avaReply("Opening "+tkPossessive(c.name)+' '+spec.label.toLowerCase()+'.',[],{auto:avaAct('Open '+spec.label,()=>avaOpenTab(c.id,want))});
  }
  return avaReply('Opening '+c.name+'.',[avaAct('Open their email system',()=>avaOpenTab(c.id,'overview'))],{auto:avaAct('Open '+c.name,()=>openTrial(c.id))});
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
    const a=avaPlace(p[0]);return avaReply('Opening '+p[2],[],{auto:a});
  }
  return null;
}

/* ===================== 6. VOICE: ears and mouth ===================== */
function avaRecClass(){try{return (typeof window!=='undefined'&&(window.SpeechRecognition||window.webkitSpeechRecognition))||null}catch(e){return null}}
function avaCanListen(){return !!avaRecClass()}
function avaCanSpeak(){try{return typeof window!=='undefined'&&!!window.speechSynthesis&&typeof window.SpeechSynthesisUtterance==='function'}catch(e){return false}}
function avaMuted(){if(AVA.muted==null){try{AVA.muted=localStorage.getItem(AVA_MUTE_KEY)==='1';}catch(e){AVA.muted=false;}}return AVA.muted}
function avaSetMute(on){AVA.muted=!!on;try{localStorage.setItem(AVA_MUTE_KEY,on?'1':'0');}catch(e){}if(on)avaHush();avaPaintHead();}
function avaHush(){try{if(avaCanSpeak())window.speechSynthesis.cancel();}catch(e){}}
function avaPickVoice(){
  if(AVA.voice)return AVA.voice;
  try{const vs=window.speechSynthesis.getVoices()||[];const en=vs.filter(v=>/^en(-|_|$)/i.test(v.lang));
    const pref=[/samantha/i,/aria/i,/jenny/i,/google us english/i,/zira/i,/female/i,/karen/i,/serena/i];
    for(const re of pref){const v=en.find(x=>re.test(x.name));if(v){AVA.voice=v;return v;}}
    AVA.voice=en.find(v=>/en-us/i.test(v.lang))||en[0]||null;}catch(e){}
  return AVA.voice;
}
function avaSpeak(text){
  if(avaMuted()||!avaCanSpeak()||!text)return false;
  try{avaHush();const u=new window.SpeechSynthesisUtterance(String(text).replace(/›/g,',').replace(/—/g,','));u.lang='en-US';u.rate=1.03;const v=avaPickVoice();if(v)u.voice=v;window.speechSynthesis.speak(u);return true;}catch(e){return false}
}
function avaListen(){
  const R=avaRecClass();
  if(!R){avaNote("Voice isn't available in this browser — type your question instead. (It works in Chrome, Edge and Safari.)");avaFocusInput();return false;}
  if(AVA.listening){avaStopListening();return false;}
  avaHush();
  let rec;try{rec=new R();}catch(e){avaNote("Voice didn't start — type your question instead.");return false;}
  rec.lang='en-US';rec.interimResults=true;rec.continuous=false;rec.maxAlternatives=1;
  let final='';
  rec.onresult=e=>{let interim='';for(let i=e.resultIndex;i<e.results.length;i++){const r=e.results[i];if(r.isFinal)final+=r[0].transcript;else interim+=r[0].transcript;}AVA.interim=(final+' '+interim).trim();avaPaintHeard();};
  rec.onerror=e=>{const k=e&&e.error;AVA.listening=false;
    avaNote(k==='not-allowed'||k==='service-not-allowed'?'The microphone is blocked. Allow it in the browser (the icon by the address), or type instead.':k==='no-speech'?"I didn't hear anything. Tap the mic and speak, or type.":k==='network'?"Voice needs the internet in this browser. Type instead.":k==='aborted'?'':"Voice stopped. Try again, or type.");avaPaintMic();};
  rec.onend=()=>{AVA.listening=false;AVA.rec=null;const said=(final||'').trim();AVA.interim='';avaPaintHeard();avaPaintMic();if(said)avaAsk(said,{voice:true});};
  AVA.rec=rec;AVA.listening=true;AVA.interim='';avaPaintMic();avaPaintHeard();avaNote('');
  try{rec.start();}catch(e){AVA.listening=false;AVA.rec=null;avaPaintMic();return false;}
  return true;
}
function avaStopListening(){try{if(AVA.rec)AVA.rec.stop();}catch(e){}AVA.listening=false;avaPaintMic();}

/* ===================== 7. ASKING: load what the question needs, think, show, say, do ===================== */
async function avaPrime(text){
  const t=avaNorm(text);const jobs=[];
  const safe=p=>Promise.resolve(p).catch(()=>null);
  if(typeof tk!=='undefined'&&typeof loadHub==='function'&&(!tk.hub||Date.now()-(tk.hubAt||0)>60000))jobs.push(safe(loadHub(false)));
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
async function avaAsk(text,opts){
  opts=opts||{};text=String(text||'').trim();if(!text)return null;
  avaOpen({listen:false,quiet:true});
  avaPush({who:'you',text});
  AVA.busy=true;avaPaintLog();
  let r;
  try{await avaPrime(text);r=await avaThink(text,avaCtx());}
  catch(e){r=avaReply("Something went wrong on my side. Try again, or ask it another way.",[]);}
  AVA.busy=false;
  avaPush({who:'ava',text:r.say,actions:r.actions||[],chips:r.chips||null});
  avaSpeak(r.say);
  if(r.auto&&typeof r.auto.run==='function'){try{r.auto.run();}catch(e){}
    // on a phone the panel covers the page it just opened: fold it away once the answer is said
    if(avaIsPhone())setTimeout(()=>{if(!AVA.listening)avaClose({keepFocus:true});},1400);}
  return r;
}
function avaIsPhone(){try{return typeof window.matchMedia==='function'&&window.matchMedia('(max-width:860px)').matches}catch(e){return false}}

/* ===================== 8. THE PANEL ===================== */
const AVA_IC={
  mic:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>',
  stop:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  send:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sound:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  muted:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
};
function avaEl(id){return typeof document!=='undefined'&&document.getElementById?document.getElementById(id):null}
function avaMount(){
  const root=avaEl('avaRoot');if(!root||AVA.mounted)return;AVA.mounted=true;
  root.innerHTML=`<button type="button" class="ava-fab" id="avaFab" aria-label="Ask Ava — your hub helper (Ctrl+J)" title="Ask Ava (Ctrl/⌘ J)" aria-expanded="false" aria-controls="avaPanel" onclick="avaFabTap()">${AVA_IC.mic}<span class="ava-fab-ring" aria-hidden="true"></span></button>
  <section class="ava-panel" id="avaPanel" role="dialog" aria-modal="false" aria-labelledby="avaTitle" hidden>
    <header class="ava-head"><span class="ava-av" aria-hidden="true">A</span><span class="ava-name"><b id="avaTitle">Ava</b><small id="avaSub">Your hub helper</small></span>
      <button type="button" class="ava-ib" id="avaMute" onclick="avaSetMute(!avaMuted())"></button>
      <button type="button" class="ava-ib" onclick="avaClose()" aria-label="Close Ava" title="Close (Esc)">${AVA_IC.close}</button></header>
    <div class="ava-log" id="avaLog" role="log" aria-live="polite" aria-relevant="additions"></div>
    <div class="ava-heard" id="avaHeard" aria-hidden="true"></div>
    <form class="ava-in" onsubmit="event.preventDefault();avaSubmit()">
      <label class="ava-sr" for="avaInput">Ask Ava</label>
      <input id="avaInput" type="text" autocomplete="off" enterkeyhint="send" placeholder="Ask anything, or tap the mic…" maxlength="300">
      <button type="button" class="ava-mic" id="avaMic" onclick="avaListen()"></button>
      <button type="submit" class="ava-send" aria-label="Send">${AVA_IC.send}</button>
    </form>
    <p class="ava-note" id="avaNote" role="status"></p>
  </section>`;
  avaPaintHead();avaPaintMic();avaSync();
}
function avaSync(){
  const root=avaEl('avaRoot');if(!root)return;
  const on=!!(typeof authUser!=='undefined'&&authUser);
  root.hidden=!on;if(root.style)root.style.display=on?'':'none';
  try{document.body.classList.toggle('ava-on',on);}catch(e){}
  if(!on){AVA.log=[];AVA.greeted=false;AVA.pending=null;avaClose({keepFocus:true});}
}
function avaFabTap(){if(AVA.open){avaClose();return;}avaOpen({listen:true});}
function avaToggle(){AVA.open?avaClose():avaOpen({listen:false})}
function avaGreet(){
  if(AVA.greeted)return;AVA.greeted=true;
  const ctx=avaCtx();const ex=avaExample();
  const say='Hi'+(ctx.name?' '+ctx.name:'')+", I'm Ava. Ask me anything about the hub — like 'what needs me today' or 'open "+ex+"'.";
  avaPush({who:'ava',text:say,chips:avaChipsFor(ctx)});
  return say;
}
function avaOpen(opts){
  opts=opts||{};if(typeof authUser!=='undefined'&&!authUser)return;
  if(!AVA.mounted)avaMount();
  const p=avaEl('avaPanel'),f=avaEl('avaFab');
  const was=AVA.open;AVA.open=true;
  if(p){p.hidden=false;if(p.classList)p.classList.add('open');}
  if(f){f.setAttribute&&f.setAttribute('aria-expanded','true');if(f.classList)f.classList.add('on');}
  const greet=avaGreet();
  avaNote(avaCanListen()?(avaIsChrome()?'Voice is turned into text by your browser (Chrome uses Google for that). Everything else stays in your browser.':''):"Voice isn't available in this browser — type your question. (Voice works in Chrome, Edge and Safari.)");
  avaPaintLog();
  if(!was&&greet&&!opts.quiet&&!(opts.listen&&avaCanListen()))avaSpeak(greet);
  if(opts.listen&&avaCanListen())avaListen();else if(!opts.quiet)avaFocusInput();
}
function avaIsChrome(){try{return /Chrome\//.test(navigator.userAgent||'')&&!/Edg\//.test(navigator.userAgent||'')}catch(e){return false}}
function avaClose(opts){
  opts=opts||{};const p=avaEl('avaPanel'),f=avaEl('avaFab');
  if(AVA.listening)avaStopListening();avaHush();
  const was=AVA.open;AVA.open=false;
  if(p){p.hidden=true;if(p.classList)p.classList.remove('open');}
  if(f){f.setAttribute&&f.setAttribute('aria-expanded','false');if(f.classList)f.classList.remove('on');if(was&&!opts.keepFocus)try{f.focus();}catch(e){}}
}
function avaFocusInput(){const i=avaEl('avaInput');if(i)setTimeout(()=>{try{i.focus();}catch(e){}},40);}
function avaSubmit(){const i=avaEl('avaInput');const v=i?i.value:'';if(i)i.value='';return avaAsk(v);}
function avaChip(i){const c=(AVA.chipList||[])[i];if(c)avaAsk(c);}
function avaRun(i){const a=AVA.acts[i];if(!a||typeof a.run!=='function')return;try{a.run();}catch(e){}
  if(a.yes||a.no){avaPush({who:'ava',text:a.no?"Okay, I won't.":'Done.'});}
  if(!a.no&&avaIsPhone())avaClose({keepFocus:true});}
function avaNote(s){const n=avaEl('avaNote');if(n)n.textContent=s||'';}
function avaPush(m){AVA.log.push(m);if(AVA.log.length>AVA_MAX_LOG)AVA.log.splice(0,AVA.log.length-AVA_MAX_LOG);avaPaintLog();}
function avaPaintHead(){const b=avaEl('avaMute');if(!b)return;const m=avaMuted();b.innerHTML=m?AVA_IC.muted:AVA_IC.sound;b.setAttribute&&b.setAttribute('aria-label',m?'Ava is quiet — turn her voice on':'Turn Ava’s voice off');b.setAttribute&&b.setAttribute('aria-pressed',m?'true':'false');b.title=m?'Voice off':'Voice on';}
function avaPaintMic(){
  const b=avaEl('avaMic'),f=avaEl('avaFab');const can=avaCanListen();
  if(b){b.innerHTML=AVA.listening?AVA_IC.stop:AVA_IC.mic;b.setAttribute&&b.setAttribute('aria-label',AVA.listening?'Stop listening':can?'Speak to Ava':'Voice is not available in this browser');b.setAttribute&&b.setAttribute('aria-pressed',AVA.listening?'true':'false');if(b.classList){b.classList.toggle('on',AVA.listening);b.classList.toggle('off',!can);}}
  if(f&&f.classList)f.classList.toggle('listening',AVA.listening);
  const s=avaEl('avaSub');if(s)s.textContent=AVA.listening?'Listening…':AVA.busy?'Thinking…':'Your hub helper';
}
function avaPaintHeard(){const h=avaEl('avaHeard');if(!h)return;h.textContent=AVA.listening?(AVA.interim?'“'+AVA.interim+'”':'Listening… speak now'):'';if(h.classList)h.classList.toggle('show',!!AVA.listening);}
function avaPaintLog(){
  const l=avaEl('avaLog');if(!l)return;AVA.acts=[];AVA.chipList=[];
  const e=typeof esc==='function'?esc:(s=>String(s));
  const last=AVA.log.length-1;
  l.innerHTML=AVA.log.map((m,i)=>{
    if(m.who==='you')return `<div class="ava-msg you"><p>${e(m.text)}</p></div>`;
    const acts=(m.actions||[]).map(a=>{const n=AVA.acts.push(a)-1;return `<button type="button" class="ava-act${a.yes?' yes':''}" onclick="avaRun(${n})">${e(a.label)}</button>`}).join('');
    const chips=i===last&&m.chips?`<div class="ava-chips">${m.chips.map(c=>{const n=AVA.chipList.push(c)-1;return `<button type="button" class="ava-chip" onclick="avaChip(${n})">${e(c)}</button>`}).join('')}</div>`:'';
    return `<div class="ava-msg ava"><p>${e(m.text)}</p>${acts?`<div class="ava-acts">${acts}</div>`:''}${chips}</div>`;
  }).join('')+(AVA.busy?'<div class="ava-msg ava busy" aria-hidden="true"><p><span class="ava-dots"><i></i><i></i><i></i></span></p></div>':'');
  try{l.scrollTop=l.scrollHeight;}catch(e){}
  avaPaintMic();
}

/* ===================== 9. SHELL HOOKS (no edits to the other files) =====================
   Ctrl/⌘+J opens and closes Ava; Esc closes her; "Ask Ava" is in ⌘K; she shows only while someone is signed in
   (the shell's enterApp / showLogin are wrapped, not changed). */
function avaKey(e){
  if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&String(e.key||'').toLowerCase()==='j'){
    if(typeof authUser!=='undefined'&&!authUser)return;e.preventDefault&&e.preventDefault();
    if(AVA.open)avaClose();else{avaOpen({listen:false});}return;
  }
  if(e.key==='Escape'&&AVA.open){const w=avaEl('modalWrap');if(w&&w.classList&&w.classList.contains('open'))return;avaClose();}
}
function avaHook(){
  if(typeof document!=='undefined'&&typeof document.addEventListener==='function')document.addEventListener('keydown',avaKey,true);
  if(typeof enterApp==='function'&&!enterApp._ava){const orig=enterApp;enterApp=function(){const r=orig.apply(this,arguments);try{avaMount();avaSync();}catch(e){}return r};enterApp._ava=true;}
  if(typeof showLogin==='function'&&!showLogin._ava){const orig=showLogin;showLogin=function(){const r=orig.apply(this,arguments);try{avaSync();}catch(e){}return r};showLogin._ava=true;}
  if(typeof cmdkActions==='function'&&!cmdkActions._ava){const orig=cmdkActions;cmdkActions=function(){const a=orig.apply(this,arguments);a.unshift({type:'Ava',label:'Ask Ava',icon:AVA_IC.mic,sub:'Your hub helper — talk or type (Ctrl/⌘ J)',kw:'ask ava voice help helper assistant talk speak question how do i',run:()=>{closeCmdk();avaOpen({listen:false});}});return a};cmdkActions._ava=true;}
  try{avaMount();avaSync();}catch(e){}
  try{if(avaCanSpeak()&&window.speechSynthesis.addEventListener)window.speechSynthesis.addEventListener('voiceschanged',()=>{AVA.voice=null;});}catch(e){}
}
avaHook();
