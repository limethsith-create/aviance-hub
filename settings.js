/* Settings — you, the calendar, which tool is doing the sending, and (for the
   owner only) the business details that go on agreements, invoices and emails.
   There are no API keys in the hub. The outreach tool is reached by the
   outreach-sync edge function, and its key lives in Supabase secrets, named by
   the account's key_ref. This screen shows that name and never the key itself.

   Payments and documents: read with the `biz_get` database rule and saved with
   `biz_set`, both admin only. A value that still starts with "[" is the
   stand-in the database ships with, so the screen says "not set yet" beside it.

   Every data function returns {ok, data, error} and never throws. Prefix: st. */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const stOk = coreOk;
/* What went wrong, in words the owner can act on. Our own sentences and the database's own plain messages
   pass through; the plumbing's wording never reaches the screen. */
function stPlain(m){
  const s=String(m||'');
  if(/failed to fetch|networkerror|network request|load failed|fetch failed/i.test(s))return "Can't reach Aviance right now. Check your connection and try again.";
  if(/jwt|not authenticated/i.test(s))return 'Your sign-in has run out. Please sign in again.';
  if(/permission denied|row-level security|not authorized|unauthorized/i.test(s))return "You don't have access to change that.";
  if(/could not find the function|does not exist|schema cache|PGRST\d+|violates|duplicate key/i.test(s))return "That didn't work. Try again. If it keeps happening, the database needs its latest update.";
  /* anything this screen has no better word for falls through to the one place
     that decides what the owner may be shown. */
  return corePlain(s);
}
/* Same shape as coreErr, with stPlain's rewording on top. stPlain is handed the
   RAW text (coreRawText, not coreErrText) on purpose: coreErrText rewords it as
   well, and this screen's own sentences are the more specific of the two, so
   plaining it twice would replace them with core.js's generic. */
function stErr(e){ return {ok:false,data:null,error:stPlain(coreRawText(e))} }
/* 'admin' and 'employee' are the database's words, not his. */
function stRoleWord(role){ return ({admin:'Owner',employee:'Team member'})[String(role||'')]||'Team member' }
function stWrap(res,whenEmpty){ return coreWrap(res, whenEmpty, stErr, 'No answer from Aviance. Try again.') }
async function stRun(fn,whenEmpty){ try{ return stWrap(await fn(),whenEmpty) }catch(e){ return stErr(e) } }

/* ---- You ---- */
async function stMe(){
  if(!authUser||!authUser.id)return stErr('You are not signed in.');
  return stRun(()=>sb.from('profiles').select('*').eq('id',authUser.id).maybeSingle(),null);
}
async function stSaveMe(fields){
  if(!authUser||!authUser.id)return stErr('You are not signed in.');
  const allow=['name','title','loc','phone'];
  const patch={}; allow.forEach(k=>{ if(fields&&fields[k]!==undefined)patch[k]=String(fields[k]||'').trim() });
  if(!patch.name)return stErr('Put your name in before saving.');
  return stRun(()=>sb.from('profiles').update(patch).eq('id',authUser.id).select().maybeSingle(),null);
}

/* ---- The calendar ---- */
/* One row, id = 1. Every screen that offers a time reads it, so this is the only
   place the working day is set. */
const ST_CAL_FALLBACK={id:1,open_time:'07:00',close_time:'21:00',days:[1,2,3,4,5],slot_minutes:30,min_notice_h:12,days_ahead:21,us_zone:'America/New_York',owner_zone:'Asia/Colombo',meeting_link:null};

async function stCalendar(){
  const r=await stRun(()=>sb.from('calendar_settings').select('*').eq('id',1).maybeSingle(),null);
  if(!r.ok)return r;
  return stOk(r.data||ST_CAL_FALLBACK);
}
function stValidCal(f){
  const hm=/^([01]\d|2[0-3]):([0-5]\d)$/;
  if(!hm.test(String(f.open_time||'')))return 'Opening time has to look like 07:00.';
  if(!hm.test(String(f.close_time||'')))return 'Closing time has to look like 21:00.';
  if(String(f.close_time)<=String(f.open_time))return 'Closing time has to be after opening time.';
  if(!Array.isArray(f.days)||!f.days.length)return 'Pick at least one day of the week.';
  if(f.days.some(d=>!(Number(d)>=0&&Number(d)<=6)))return 'The days of the week are 0 (Sunday) to 6 (Saturday).';
  const slot=Number(f.slot_minutes);
  if(![15,20,30,45,60].includes(slot))return 'A slot is 15, 20, 30, 45 or 60 minutes.';
  if(!(Number(f.min_notice_h)>=0))return 'Notice cannot be a negative number of hours.';
  if(!(Number(f.days_ahead)>0))return 'People have to be able to book at least one day ahead.';
  try{ new Intl.DateTimeFormat('en',{timeZone:String(f.us_zone)}) }catch(e){ return 'That is not a time zone the browser knows.' }
  try{ new Intl.DateTimeFormat('en',{timeZone:String(f.owner_zone)}) }catch(e){ return 'That is not a time zone the browser knows.' }
  return '';
}
async function stSaveCalendar(fields){
  const bad=stValidCal(fields||{});
  if(bad)return stErr(bad);
  const row={id:1,open_time:fields.open_time,close_time:fields.close_time,
    days:fields.days.map(Number),slot_minutes:Number(fields.slot_minutes),
    min_notice_h:Number(fields.min_notice_h),days_ahead:Number(fields.days_ahead),
    us_zone:fields.us_zone,owner_zone:fields.owner_zone,
    meeting_link:(fields.meeting_link||'').trim()||null,updated_at:new Date().toISOString()};
  return stRun(()=>sb.from('calendar_settings').upsert(row,{onConflict:'id'}).select().maybeSingle(),null);
}

/* ---- The outreach tool behind the hub ----
   An account here is "this client's Instantly/Smartlead login, under this label". The key itself
   is NOT here and never will be: it lives in Supabase > Edge Functions > Secrets, and the row only
   holds key_ref, which is the NAME of that secret. stKeyRef works the name out so the owner can
   copy it straight into the dashboard, and the screen shows the name, never a value. */
const ST_OUT_PROVIDERS=[['instantly','Instantly'],['smartlead','Smartlead']];

async function stOutreachAccounts(){
  return stRun(()=>sb.from('outreach_accounts')
    .select('id,client_id,provider,label,external_id,key_ref,status,last_synced_at,last_error,clients(company)')
    .order('created_at',{ascending:false}),[]);
}
async function stOutreachClients(){
  return stRun(()=>sb.from('clients').select('id,company').order('company'),[]);
}
/* The exact Supabase secret name for this account. Must match oxEnvName in
   supabase/functions/outreach-sync/map.mjs — the sync looks the key up by this name. */
function stKeyRef(provider,label){
  const up=s=>String(s==null?'':s).toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  const p=up(provider), l=up(label);
  return 'OUTREACH_'+p+(l?'_'+l:'');
}
function stOutProviderName(p){ const hit=ST_OUT_PROVIDERS.find(x=>x[0]===String(p)); return hit?hit[1]:String(p||'') }
/* 'needs_key' is not a fault, it is a thing the owner has not done yet, so it reads as a to-do. */
function stOutState(a){
  const s=String((a&&a.status)||'');
  if(s==='ok')return {word:'Reading',cls:''};
  if(s==='needs_key')return {word:'Waiting for its key',cls:'st-ro'};
  if(s==='paused')return {word:'Paused',cls:'st-ro'};
  if(s==='error')return {word:'Could not read',cls:'st-err'};
  return {word:s||'—',cls:'st-ro'};
}
function stWhen(v){ return v?String(v).slice(0,16).replace('T',' ')+' UTC':'never' }

function stValidOutreach(f){
  const g=f||{};
  if(!String(g.client_id||'').trim())return 'Pick which client this account belongs to.';
  if(!ST_OUT_PROVIDERS.some(p=>p[0]===String(g.provider)))return 'Pick Instantly or Smartlead.';
  const label=String(g.label||'').trim();
  if(label.length<2)return 'Give the account a short label, like "Main" or the sending domain.';
  if(label.length>60)return 'Keep the label under 60 characters.';
  return '';
}
/* Connects an account. It starts as needs_key on purpose: until the secret named below is set in
   Supabase, the sync skips this account, says so in last_error, and leaves the others alone. */
async function stConnectOutreach(fields){
  const bad=stValidOutreach(fields||{});
  if(bad)return stErr(bad);
  const label=String(fields.label||'').trim();
  const row={client_id:String(fields.client_id).trim(),provider:String(fields.provider),label,
    external_id:String(fields.external_id||'').trim()||null,
    key_ref:stKeyRef(fields.provider,label),status:'needs_key',
    last_error:'No API key yet. Set the Supabase secret '+stKeyRef(fields.provider,label)+' and this account syncs on the next tick.'};
  return stRun(()=>sb.from('outreach_accounts').upsert(row,{onConflict:'client_id,provider,label'}).select().maybeSingle(),null);
}
/* Pause stops the sync touching this account at all; it does not delete anything already read. */
async function stPauseOutreach(id,paused){
  if(!String(id||'').trim())return stErr('No account to change.');
  return stRun(()=>sb.from('outreach_accounts').update({status:paused?'paused':'needs_key',
    last_error:paused?'Paused by the owner in Settings.':null}).eq('id',id).select().maybeSingle(),null);
}

/* ---- Payments and documents (admin only) ---- */
/* [key the database knows, label, kind of field, a hint] */
/* The old "Wise bank details" box and "Payoneer link" are gone from this card: the Payment
   details card below supersedes them, and Wise cannot be held in Sri Lanka at all. The two
   database keys still exist and are still read — an invoice with nothing in the new card falls
   back to them — so an older setup keeps working. They are simply no longer edited here. */
const ST_BIZ_FIELDS=[
  ['legal_name','Company legal name','text','The name on the agreement and the invoice'],
  ['address','Company address','text','Printed on every invoice'],
  ['email','Billing email','email','Where a client writes about an invoice'],
  ['kickoff_link','Kickoff booking link','url','Sent in the welcome email so a new client can book their kickoff'],
  ['signer_name','Who signs for Aviance','text','Your full name. Shown as the Aviance signature on every agreement and the welcome email'],
  ['phone','Business phone','text','Optional. Printed on invoices']
];
function stIsAdmin(){ try{ return typeof authUser!=='undefined'&&!!authUser&&authUser.role==='admin' }catch(e){ return false } }
/* A stand-in the database ships with, e.g. "[YOUR COMPANY LEGAL NAME]". */
function stIsPlaceholder(v){ return String(v==null?'':v).trim().charAt(0)==='[' }
async function stBiz(){
  if(!stIsAdmin())return stErr('Only the owner can see the payment details.');
  return stRun(()=>sb.rpc('biz_get'),{});
}
function stValidBiz(f){
  const email=String(f.email||'').trim();
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))return 'The billing email does not look like an email address.';
  for(const k of ['payoneer_link','kickoff_link']){
    const u=String(f[k]||'').trim();
    if(u&&!/^https:\/\/\S+$/i.test(u))return (k==='payoneer_link'?'The Payoneer link':'The kickoff booking link')+' has to start with https://';
  }
  return '';
}
/* Saves only the fields on this card; anything else the database holds is left alone. */
async function stSaveBiz(fields){
  if(!stIsAdmin())return stErr('Only the owner can change the payment details.');
  const f=fields||{};
  const bad=stValidBiz(f);
  if(bad)return stErr(bad);
  const p={};
  ST_BIZ_FIELDS.forEach(([k])=>{ if(f[k]!==undefined)p[k]=String(f[k]==null?'':f[k]).trim() });
  if(!Object.keys(p).length)return stErr('There is nothing to save.');
  return stRun(()=>sb.rpc('biz_set',{p}),{});
}
/* The card's inside. Pure: the saved values in, HTML out. */
function stRenderBiz(data){
  const d=data||{};
  const rows=ST_BIZ_FIELDS.map(([k,label,kind,hint])=>{
    const v=d[k]==null?'':String(d[k]);
    const id='stBiz_'+k;
    const note=stIsPlaceholder(v)?` <small class="st-err" id="${id}_note">not set yet</small>`:'';
    const input=kind==='area'
      ?`<textarea id="${id}" rows="5" style="width:100%;max-width:420px;background:var(--surface-2);border:1px solid var(--border);color:var(--text);font:inherit;font-size:var(--fs-base);padding:8px 10px">${esc(v)}</textarea>`
      :`<input id="${id}" value="${esc(v)}"${kind==='email'?' inputmode="email"':kind==='url'?' inputmode="url" placeholder="https://…"':''} style="min-width:280px">`;
    return stRow(label,input+note,hint);
  }).join('');
  return rows+`<div class="st-act"><button class="btn" onclick="stSubmitBiz()">Save</button><span id="stBizMsg" class="st-msg"></span></div>`;
}

/* ---- Payment details: which rails are on, and what each one needs ----
   An international USD wire into his own bank is the rail that works today, so it is first and
   is what a client is normally shown. Payoneer is the backup. Card checkout needs a US entity
   and PayPal costs about 7.3% and cannot issue an invoice in Sri Lanka, so both are here with
   that said plainly rather than left for him to find out. Wise is not offered by name: it
   cannot be held in Sri Lanka at all.

   Nothing in this file is a real account number or link: every value below is typed in by the
   owner and kept in the database under business.pay_methods. An error message names the field,
   never what is in it, and no stored value is ever written to a log.
/* An international USD wire FROM a US company TO a bank abroad. A Sri Lankan account has no
   ABA, so routing is an optional extra for the day there is a US account; what a US client's
   bank really asks for is the beneficiary, the SWIFT, the branch address with its country, and
   the correspondent bank. The correspondent line is the one most often missing and the most
   expensive to miss. Every hint below is for the owner; none of it reaches a client.

   [key, label, kind of field, a hint]  —  kind: text | acct | code | iban | url | email | area */
const ST_PAY_WIRE=[
  ['account_holder','Beneficiary name','text','Exactly as the bank holds it, character for character. A name that does not match bounces the wire.'],
  ['beneficiary_address','Beneficiary address','area','Your own address as the bank has it. US wire forms ask for it.'],
  ['account_number','Beneficiary account number','acct','The USD account the money should land in — not an account that converts on arrival.'],
  ['iban','IBAN','iban','Only if your bank issues one. Leave it empty if it does not.'],
  ['bank_name','Beneficiary bank name','text','The bank’s full legal name.'],
  ['swift','Beneficiary bank SWIFT / BIC','code','8 or 11 characters, from the bank itself — never from a web lookup.'],
  ['bank_address','Beneficiary bank branch address','area','Street, city, postal code, and the country.'],
  ['intermediary_bank','Correspondent / intermediary bank','text','Ask your bank for its USD inward-remittance instructions sheet and copy this from there. Leave it out and the wire takes an extra hop and an extra cut.'],
  ['intermediary_swift','Correspondent bank SWIFT / BIC','code','From the same sheet as the line above.'],
  ['reference','Reference to quote','text','What you want written on the payment. Leave it empty and the invoice number is used, which is usually what you want.'],
  ['routing_number','Routing / ABA number (optional)','acct','Optional, and only for a US account. A Sri Lankan account has no ABA — leave this empty.']
];
/* [key, label here, what the client is told it is, the fields, a hint for the owner]
   Order is the order he should think about them in: the wire first, then the backup, then the
   two he cannot switch on today. `wise` is a historic key kept so older invoices and the
   wise_details setting still work — to him and to a client it is just a second bank account. */
const ST_PAY_KINDS=[
  ['bank_wire','Bank wire (USD)','Bank transfer',ST_PAY_WIRE,
   'The primary rail: a US company wires USD to your bank. It works today and costs roughly 1–4% at these amounts. The client types these fields into their bank.'],
  ['wise','Second bank account','Bank transfer (second account)',ST_PAY_WIRE,
   'Only if you ever hold a second account worth offering. Same fields as above.'],
  ['payoneer','Payoneer','Payoneer',[['link','Payment request link','url','The “Request a Payment” link. The client pays by US bank debit or card with no Payoneer account of their own.']].concat(ST_PAY_WIRE),
   'The backup rail, and the nicest for the client — if your signup is accepted. A link, or the receiving account details, or both.'],
  ['card_link','Card link','Card or online checkout',[['link','Hosted checkout URL','url','A Stripe or PayPal checkout page.']],
   'You cannot switch this on today: a hosted checkout needs a US entity, because Stripe does not operate in Sri Lanka. It is here for the day that changes.'],
  ['paypal','PayPal (last resort)','PayPal',[['email','PayPal or invoice email','email','The address a goods-and-services payment should be sent to.'],['link','paypal.me link','url','Optional. A paypal.me link, if you have one.']],
   'Last resort. PayPal invoicing and PayPal Checkout do not work in Sri Lanka, so the client has to send a goods-and-services payment by hand to your email address, and it costs about 7.3% all in. Read that again before choosing it.']
];
/* every rail also takes a free note, printed under it on the invoice */
const ST_PAY_NOTE=['note','Note to the client','area','Optional. One line printed under this method on the invoice.'];
const ST_PAY_FIELDS_BY_KIND=(()=>{ const o={}; ST_PAY_KINDS.forEach(([k,,,f])=>{ o[k]=f.concat([ST_PAY_NOTE]) }); return o })();

function stPayOn(m){ const v=m&&m.on; return v===true||v==='true'||v===1||v==='1'||v==='yes'||v==='on' }
/* What the database holds, read into one shape the screen and the validator both use. */
function stPayState(data){
  const d=(data&&typeof data==='object')?data:{};
  const raw=(d.pay_methods&&typeof d.pay_methods==='object')?d.pay_methods:{};
  const methods={};
  ST_PAY_KINDS.forEach(([k])=>{
    const m=(raw[k]&&typeof raw[k]==='object')?raw[k]:{};
    const f={};
    ST_PAY_FIELDS_BY_KIND[k].forEach(([fk])=>{ f[fk]=String(m[fk]==null?'':m[fk]) });
    methods[k]={on:stPayOn(m),fields:f};
  });
  return {methods,
    preferred:String(d.pay_preferred==null?'':d.pay_preferred),
    currency:String(d.pay_currency==null?'':d.pay_currency)||'USD',
    terms:String(d.pay_terms==null?'':d.pay_terms)||'Net 7'};
}
/* Can an invoice tell a client how to pay today? A method switched on with every field
   empty cannot, so it does not count. */
function stPayFilled(st,k){
  const m=(st.methods||{})[k];
  if(!m||!m.on)return false;
  const payable=fk=>fk!=='note'&&fk!=='reference';   /* neither of these is somewhere money can go */
  return ST_PAY_FIELDS_BY_KIND[k].some(([fk])=>payable(fk)&&String(m.fields[fk]||'').trim()!==''&&String(m.fields[fk]||'').trim().charAt(0)!=='[');
}
function stPayLive(st){ return ST_PAY_KINDS.map(([k])=>k).filter(k=>stPayFilled(st,k)) }
/* The one line the owner should be able to read without thinking. */
function stPayStatus(st){
  const live=stPayLive(st);
  if(!live.length)return {ok:false,text:'Invoices cannot tell a client how to pay yet. A client sees “We’ll send these to you directly.” Switch a method on below and fill it in.'};
  const name=k=>{ const r=ST_PAY_KINDS.find(x=>x[0]===k); return r?r[2]:k };
  const pref=live.indexOf(st.preferred)>=0?st.preferred:live[0];
  return {ok:true,text:'Invoices show how to pay. '+name(pref)+' is shown first'
    +(live.length>1?', with '+live.filter(k=>k!==pref).map(name).join(' and ')+' as the other way'+(live.length>2?'s':''):'')+'.'};
}
/* Shapes, not opinions: enough to catch a typo, not enough to argue with a real bank. */
function stValidPayField(kind,label,value){
  const v=String(value==null?'':value).trim();
  if(!v)return '';
  if(kind==='acct'&&!/^[0-9][0-9 -]*$/.test(v))return label+' should be digits, with spaces or dashes if you like.';
  if(kind==='code'&&!/^[A-Za-z0-9][A-Za-z0-9 -]{5,19}$/.test(v))return label+' should be 6 to 20 letters and digits.';
  if(kind==='iban'&&!/^[A-Za-z0-9][A-Za-z0-9 ]{9,41}$/.test(v))return label+' should be 10 to 42 letters and digits.';
  if(kind==='url'&&!/^https:\/\/\S+$/i.test(v))return label+' has to start with https://';
  if(kind==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v))return label+' does not look like an email address.';
  return '';
}
function stValidPay(f){
  const st=stPayState(f);
  for(const [k,label,,,] of ST_PAY_KINDS){
    const m=st.methods[k];
    for(const [fk,flabel,fkind] of ST_PAY_FIELDS_BY_KIND[k]){
      const bad=stValidPayField(fkind,label+' — '+flabel,m.fields[fk]);
      if(bad)return bad;
    }
    if(m.on&&!stPayFilled(st,k))return label+' is switched on but has nothing in it. Fill one of its fields in, or switch it off.';
  }
  if(String(f&&f.pay_currency||'').trim()&&!/^[A-Za-z]{3}$/.test(String(f.pay_currency).trim()))return 'The currency is a three-letter code, such as USD.';
  const live=stPayLive(st);
  if(st.preferred&&live.indexOf(st.preferred)<0&&live.length)return 'The method you marked preferred is not switched on. Pick one of the ones that are.';
  return '';
}
async function stPay(){
  if(!stIsAdmin())return stErr('Only the owner can see the payment details.');
  return stRun(()=>sb.rpc('biz_get'),{});
}
/* Sends the whole picture at once: which methods are on, their fields, and the pick. */
async function stSavePay(fields){
  if(!stIsAdmin())return stErr('Only the owner can change the payment details.');
  const f=fields||{};
  const bad=stValidPay(f);
  if(bad)return stErr(bad);
  const st=stPayState(f);
  const pay_methods={};
  ST_PAY_KINDS.forEach(([k])=>{
    const m=st.methods[k], out={on:!!m.on};
    ST_PAY_FIELDS_BY_KIND[k].forEach(([fk])=>{ out[fk]=String(m.fields[fk]||'').trim() });
    pay_methods[k]=out;
  });
  const live=stPayLive(st);
  const preferred=live.indexOf(st.preferred)>=0?st.preferred:(live[0]||'');
  return stRun(()=>sb.rpc('biz_set',{p:{pay_methods,pay_preferred:preferred,
    pay_currency:String(st.currency||'USD').trim().toUpperCase(),pay_terms:String(st.terms||'').trim()}}),{});
}
/* The look lives here rather than in settings.css, the same way the Wise box above does. */
const ST_PAY_CSS={
  in:'background:var(--surface-2);border:1px solid var(--border);color:var(--text);font:inherit;font-size:var(--fs-base);padding:7px 9px;width:100%',
  area:'background:var(--surface-2);border:1px solid var(--border);color:var(--text);font:inherit;font-size:var(--fs-base);padding:7px 9px;width:100%;resize:vertical',
  f:'display:flex;flex-direction:column;gap:4px',
  lab:'color:var(--muted-2);font-size:var(--fs-min)',
  fs:'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px 16px;margin-top:10px',
  m:'border:1px solid var(--border);padding:12px 14px;margin:0 0 10px',
  mOn:'border:1px solid var(--text);padding:12px 14px;margin:0 0 10px',
  leg:'padding:0 6px;font-size:var(--fs-base);color:var(--text)',
  ms:'margin-top:16px',
  ok:'color:var(--text);font-size:var(--fs-base);border-left:3px solid var(--ok,#1f9d55);padding:8px 12px;margin:0 0 14px;background:var(--surface-2)',
  bad:'color:var(--text);font-size:var(--fs-base);border-left:3px solid #E0290F;padding:8px 12px;margin:0 0 14px;background:var(--surface-2)'
};
/* The card's inside. Pure: the saved values in, HTML out. Nothing is logged. */
function stRenderPay(data){
  const st=stPayState(data);
  const status=stPayStatus(st);
  const live=stPayLive(st);
  const pick=live.indexOf(st.preferred)>=0?st.preferred:(live[0]||'');
  const field=(k,fk,flabel,fkind,fhint)=>{
    const id='stPay_'+k+'_'+fk;
    const v=String((st.methods[k].fields[fk])||'');
    const box=fkind==='area'
      ?`<textarea id="${id}" rows="3" class="st-pay-area" style="${ST_PAY_CSS.area}">${esc(v)}</textarea>`
      :`<input id="${id}" value="${esc(v)}"${fkind==='url'?' inputmode="url" placeholder="https://…"':fkind==='email'?' inputmode="email"':fkind==='acct'?' inputmode="numeric"':''} class="st-pay-in" style="${ST_PAY_CSS.in}">`;
    return `<div class="st-pay-f" style="${ST_PAY_CSS.f}"><label for="${id}" style="${ST_PAY_CSS.lab}">${esc(flabel)}</label>${box}${fhint?`<small class="st-pay-fhint" style="${ST_PAY_CSS.lab}">${esc(fhint)}</small>`:''}</div>`;
  };
  const blocks=ST_PAY_KINDS.map(([k,label,shown,,hint])=>{
    const on=st.methods[k].on;
    return `<fieldset class="st-pay-m${on?' on':''}"${stPayFilled(st,k)?' data-st-live="1"':''} style="${on?ST_PAY_CSS.mOn:ST_PAY_CSS.m}">
      <legend style="${ST_PAY_CSS.leg}"><label style="cursor:pointer"><input type="checkbox" id="stPay_on_${k}"${on?' checked':''}> ${esc(label)}</label></legend>
      <small class="st-pay-hint" style="${ST_PAY_CSS.lab}">${esc(hint)}</small>
      <small class="st-pay-shown" style="${ST_PAY_CSS.lab};display:block;margin-top:2px">On the invoice it reads “${esc(shown)}”${stPayFilled(st,k)?'':' · nothing in it yet'}</small>
      <div class="st-pay-fs" style="${ST_PAY_CSS.fs}">${ST_PAY_FIELDS_BY_KIND[k].map(([fk,fl,fkd,fh])=>field(k,fk,fl,fkd,fh)).join('')}</div>
    </fieldset>`;
  }).join('');
  const opts=ST_PAY_KINDS.map(([k,,shown])=>`<option value="${esc(k)}"${pick===k?' selected':''}>${esc(shown)}</option>`).join('');
  return `<p class="st-pay-status ${status.ok?'good':'bad'}" role="status" style="${status.ok?ST_PAY_CSS.ok:ST_PAY_CSS.bad}">${esc(status.text)}</p>
    ${stRow('Shown first',`<select id="stPayPref"><option value="">— none —</option>${opts}</select>`,'The one a client sees large; the rest read as “or”')}
    ${stRow('Currency',`<input id="stPayCurrency" value="${esc(st.currency)}" maxlength="3" class="st-pay-cur" style="max-width:92px">`,'A three-letter code. Every plan is priced in USD.')}
    ${stRow('Payment terms',`<input id="stPayTerms" value="${esc(st.terms)}" placeholder="Net 7">`,'Printed on the invoice beside the due date')}
    <div class="st-pay-ms" style="${ST_PAY_CSS.ms}">${blocks}</div>
    <div class="st-act"><button class="btn" onclick="stSubmitPay()">Save</button><span id="stPayMsg" class="st-msg"></span></div>`;
}
function stReadPay(){
  const f={pay_methods:{},
    pay_preferred:(document.getElementById('stPayPref')||{}).value||'',
    pay_currency:(document.getElementById('stPayCurrency')||{}).value||'',
    pay_terms:(document.getElementById('stPayTerms')||{}).value||''};
  ST_PAY_KINDS.forEach(([k])=>{
    const box=document.getElementById('stPay_on_'+k);
    const m={on:!!(box&&box.checked)};
    ST_PAY_FIELDS_BY_KIND[k].forEach(([fk])=>{ const e=document.getElementById('stPay_'+k+'_'+fk); m[fk]=e?String(e.value||''):'' });
    f.pay_methods[k]=m;
  });
  return f;
}
function stShowPay(r){
  const el=document.getElementById('stPay'); if(!el)return;
  if(!r.ok){ el.innerHTML=`<p class="st-err">${esc(r.error)}</p>`; return }
  el.innerHTML=stRenderPay(r.data);
}
async function stLoadPay(){
  const el=document.getElementById('stPay'); if(!el)return;
  stShowPay(await stPay());
}
async function stSubmitPay(){
  const msg=document.getElementById('stPayMsg'); if(msg)msg.textContent='Saving…';
  const r=await stSavePay(stReadPay());
  if(!r.ok){ if(msg)msg.textContent=r.error; return r }
  const el=document.getElementById('stPay'); if(el)el.innerHTML=stRenderPay(r.data);
  const again=document.getElementById('stPayMsg'); if(again)again.textContent='Saved.';
  if(typeof toast==='function')toast('The payment details are saved.');
  return r;
}

/* ---- Screens ---- */
function stRow(label,html,hint){
  return `<div class="st-row"><div class="st-lab">${esc(label)}${hint?`<small>${esc(hint)}</small>`:''}</div><div class="st-fld">${html}</div></div>`;
}
function viewSettings(){
  setTimeout(stLoad,0);
  return `<div class="card"><h3>You</h3><div id="stMe" class="st-wrap">Loading…</div></div>
<div class="card"><h3>The calendar</h3>
  <p class="st-note">Every screen that offers someone a time reads this. Change it here and it changes everywhere.</p>
  <div id="stCal" class="st-wrap">Loading…</div></div>
<div class="card"><h3>The tool doing the sending</h3>
  <p class="st-note">Aviance OS never sends email itself. It reads from whichever tool is behind it. There are no keys stored in Aviance OS.</p>
  <div id="stOut" class="st-wrap">Loading…</div></div>`
  +(stIsAdmin()?`
<div class="card"><h3>Payments and documents</h3>
  <p class="st-note">These go on every agreement, invoice and welcome email. Anything marked “not set yet” still shows a stand-in to the client, so fill it in before the first call is won.</p>
  <div id="stBiz" class="st-wrap">Loading…</div></div>
<div class="card"><h3>Payment details</h3>
  <p class="st-note">How a client is told to pay. Switch on the ways you really accept, fill each one in, and mark the one to show first. Until one of them has something in it, an invoice can only say the details are coming.</p>
  <div id="stPay" class="st-wrap">Loading…</div></div>`:'');
}

/* "Payments and documents" and "Payment details" are two cards over ONE database
   row, and each used to ask for it on open: biz_get twice, every time Settings
   was opened. One read now fills both. */
async function stLoad(){
  stLoadMe(); stLoadCal(); stLoadOut();
  if(!stIsAdmin())return;
  const r=await stBiz();
  stShowBiz(r); stShowPay(r);
}

function stShowBiz(r){
  const el=document.getElementById('stBiz'); if(!el)return;
  if(!r.ok){ el.innerHTML=`<p class="st-err">${esc(r.error)}</p>`; return }
  el.innerHTML=stRenderBiz(r.data);
}
async function stLoadBiz(){
  const el=document.getElementById('stBiz'); if(!el)return;
  stShowBiz(await stBiz());
}
async function stSubmitBiz(){
  const msg=document.getElementById('stBizMsg'); if(msg)msg.textContent='Saving…';
  const f={};
  ST_BIZ_FIELDS.forEach(([k])=>{ const e=document.getElementById('stBiz_'+k); if(e)f[k]=e.value });
  const r=await stSaveBiz(f);
  if(!r.ok){ if(msg)msg.textContent=r.error; return r }
  const el=document.getElementById('stBiz'); if(el)el.innerHTML=stRenderBiz(r.data);
  const again=document.getElementById('stBizMsg'); if(again)again.textContent='Saved.';
  /* This card is the business details — the legal name, the address, the signer,
     the kickoff link. The card BELOW it is the payment details. Both used to
     say "The payment details are saved", so a save on either one read as a save
     on the other. */
  if(typeof toast==='function')toast('Your business details are saved.');
  return r;
}

async function stLoadMe(){
  const el=document.getElementById('stMe'); if(!el)return;
  const r=await stMe();
  if(!r.ok){ el.innerHTML=`<p class="st-err">${esc(r.error)}</p>`; return }
  const m=r.data||{};
  el.innerHTML=stRow('Name',`<input id="stName" value="${esc(m.name||'')}">`)
    +stRow('Title',`<input id="stTitle" value="${esc(m.title||'')}">`)
    +stRow('Where you are',`<input id="stLoc" value="${esc(m.loc||'')}">`)
    +stRow('Phone',`<input id="stPhone" value="${esc(m.phone||'')}">`)
    +stRow('Email',`<span class="st-ro">${esc(m.email||'—')}</span>`,'Set when you signed up')
    +stRow('What you can do',`<span class="st-ro">${esc(stRoleWord(m.role))}</span>`,'Only the owner can change this')
    +`<div class="st-act"><button class="btn" onclick="stSubmitMe()">Save</button><span id="stMeMsg" class="st-msg"></span></div>`;
}
async function stSubmitMe(){
  const msg=document.getElementById('stMeMsg'); if(msg)msg.textContent='Saving…';
  const r=await stSaveMe({name:val('stName'),title:val('stTitle'),loc:val('stLoc'),phone:val('stPhone')});
  if(msg)msg.textContent=r.ok?'Saved.':r.error;
  if(r.ok&&typeof toast==='function')toast('Your details are saved.');
}

const ST_DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
async function stLoadCal(){
  const el=document.getElementById('stCal'); if(!el)return;
  const r=await stCalendar();
  if(!r.ok){ el.innerHTML=`<p class="st-err">${esc(r.error)}</p>`; return }
  const c=r.data, on=d=>(c.days||[]).map(Number).includes(d)?' checked':'';
  const slot=s=>`<option value="${s}"${Number(c.slot_minutes)===s?' selected':''}>${s} minutes</option>`;
  el.innerHTML=stRow('Opens',`<input id="stOpen" value="${esc(c.open_time)}" placeholder="07:00">`,'In the prospect’s time zone, below')
    +stRow('Closes',`<input id="stClose" value="${esc(c.close_time)}" placeholder="21:00">`)
    +stRow('Days',`<div class="st-days">${ST_DAYS.map((n,i)=>`<label><input type="checkbox" class="stDay" value="${i}"${on(i)}> ${n.slice(0,3)}</label>`).join('')}</div>`)
    +stRow('A slot is',`<select id="stSlot">${[15,20,30,45,60].map(slot).join('')}</select>`)
    +stRow('Shortest notice',`<input id="stNotice" type="number" min="0" value="${esc(c.min_notice_h)}"> hours`)
    +stRow('Bookable up to',`<input id="stAhead" type="number" min="1" value="${esc(c.days_ahead)}"> days ahead`)
    +stRow('Their time zone',`<input id="stUsZone" value="${esc(c.us_zone)}">`,'The hours above are read in this zone')
    +stRow('Your time zone',`<input id="stOwnZone" value="${esc(c.owner_zone)}">`,'Every time is also shown in this one')
    +stRow('Meeting link',`<input id="stLink" value="${esc(c.meeting_link||'')}" placeholder="https://…">`)
    +`<div class="st-act"><button class="btn" onclick="stSubmitCal()">Save</button><span id="stCalMsg" class="st-msg"></span></div>`;
}
async function stSubmitCal(){
  const msg=document.getElementById('stCalMsg'); if(msg)msg.textContent='Saving…';
  const days=Array.prototype.slice.call(document.querySelectorAll('.stDay')).filter(b=>b.checked).map(b=>Number(b.value));
  const r=await stSaveCalendar({open_time:val('stOpen'),close_time:val('stClose'),days,
    slot_minutes:val('stSlot'),min_notice_h:val('stNotice'),days_ahead:val('stAhead'),
    us_zone:val('stUsZone'),owner_zone:val('stOwnZone'),meeting_link:val('stLink')});
  if(msg)msg.textContent=r.ok?'Saved.':r.error;
  if(r.ok&&typeof toast==='function')toast('The calendar is saved.');
}

/* Pure render. Everything escaped, and the only thing said about the key is its NAME. */
/* `clientsErr` is the difference between "you have no clients yet" and "your
   clients did not load". The picker used to say the first when it meant the
   second, and the owner would have gone looking for his missing clients. */
function stRenderOut(rows,clients,clientsErr){
  const list=Array.isArray(rows)?rows:[];
  const cl=Array.isArray(clients)?clients:[];
  const noClients=clientsErr?'Your clients did not load':'No clients yet';
  const table=!list.length
    ? `<div class="empty"><h3>Nothing connected yet</h3><p>Connect a client's Instantly or Smartlead account below. Until one is connected their campaign screens have nothing to show.</p></div>`
    : `<table class="st-tab"><thead><tr><th>Client</th><th>Tool</th><th>Label</th><th>Their id</th><th>Key secret</th><th>State</th><th>Last read</th></tr></thead><tbody>`
      +list.map(a=>{ const st=stOutState(a); return `<tr><td>${esc((a.clients&&a.clients.company)||'—')}</td>
        <td>${esc(stOutProviderName(a.provider))}</td><td>${esc(a.label||'')}</td>
        <td>${esc(a.external_id||'—')}</td>
        <td><code>${esc(a.key_ref||stKeyRef(a.provider,a.label))}</code></td>
        <td><span class="${esc(st.cls)}">${esc(st.word)}</span>${a.last_error?`<small class="st-err">${esc(a.last_error)}</small>`:''}</td>
        <td>${esc(stWhen(a.last_synced_at))}
          <div class="st-act"><button class="btn" onclick="stTogglePause('${esc(a.id)}',${a.status==='paused'?'false':'true'})">${a.status==='paused'?'Resume':'Pause'}</button></div></td></tr>` }).join('')
      +`</tbody></table>`;
  const form=stRow('Client',`<select id="stOutClient">${cl.length?cl.map(c=>`<option value="${esc(c.id)}">${esc(c.company||c.id)}</option>`).join(''):`<option value="">${esc(noClients)}</option>`}</select>`
    +(clientsErr?`<p class="st-err">${esc(clientsErr)}</p>`:''))
    +stRow('Tool',`<select id="stOutProvider">${ST_OUT_PROVIDERS.map(p=>`<option value="${esc(p[0])}">${esc(p[1])}</option>`).join('')}</select>`)
    +stRow('Label',`<input id="stOutLabel" placeholder="Main">`,'Short. It becomes part of the secret name, so keep it the same once it is set.')
    +stRow('Their account id',`<input id="stOutExt" placeholder="optional">`,'The id the tool itself shows for this workspace, if it shows one. Not required.')
    +`<div class="st-act"><button class="btn" onclick="stSubmitOut()">Connect</button><span id="stOutMsg" class="st-msg"></span></div>`;
  return table
    +`<h4>Connect an account</h4>${form}
      <p class="st-note">The API key is <b>not</b> entered here and is not stored in Aviance OS. Connect the account, then put the key into
      <b>Supabase &rsaquo; Edge Functions &rsaquo; Secrets</b> under the name shown in the <b>Key secret</b> column above. The sync reads it from there,
      every fifteen minutes. Until the secret exists the account sits at “Waiting for its key” and no other client's sync is affected.</p>`;
}
async function stLoadOut(){
  const el=document.getElementById('stOut'); if(!el)return;
  const [r,c]=await Promise.all([stOutreachAccounts(),stOutreachClients()]);
  if(!r.ok){ el.innerHTML=`<p class="st-err">${esc(r.error)}</p>`; return }
  el.innerHTML=stRenderOut(r.data||[],c.ok?(c.data||[]):[],c.ok?'':c.error);
}
async function stSubmitOut(){
  const msg=document.getElementById('stOutMsg'); if(msg)msg.textContent='Connecting…';
  const r=await stConnectOutreach({client_id:val('stOutClient'),provider:val('stOutProvider'),
    label:val('stOutLabel'),external_id:val('stOutExt')});
  if(msg)msg.textContent=r.ok?('Connected. Now set the secret '+stKeyRef(val('stOutProvider'),val('stOutLabel'))+' in Supabase.'):r.error;
  if(r.ok){ if(typeof toast==='function')toast('Account connected. Set its key in Supabase.'); stLoadOut() }
}
async function stTogglePause(id,paused){
  const r=await stPauseOutreach(id,paused===true||paused==='true');
  if(!r.ok&&typeof toast==='function')toast(r.error);
  stLoadOut();
}
