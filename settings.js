/* Settings — you, the calendar, and which tool is doing the sending.
   There are no API keys in the hub. The outreach tool is reached through
   outreach-adapter.js, and a key, when there is one, lives outside this repo. */

function stOk(data){ return {ok:true, data, error:''} }
function stErr(e){ const m=(e&&(e.message||e.error_description||e.msg))||String(e||'Something went wrong.'); return {ok:false,data:null,error:m} }
function stWrap(res,whenEmpty){ if(!res)return stErr('No answer from the database.'); if(res.error)return stErr(res.error); return stOk(res.data==null?whenEmpty:res.data) }
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

/* ---- The outreach tool behind the hub ---- */
async function stOutreachAccounts(){
  return stRun(()=>sb.from('outreach_accounts')
    .select('id,client_id,provider,label,status,last_synced_at,last_error,clients(company)')
    .order('created_at',{ascending:false}),[]);
}
function stProviders(){
  const names=(typeof oaList==='function')?oaList():[];
  return names.length?names:['demo'];
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
  <div id="stOut" class="st-wrap">Loading…</div></div>`;
}

async function stLoad(){ stLoadMe(); stLoadCal(); stLoadOut(); }

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
    +stRow('What you can do',`<span class="st-ro">${esc(m.role||'staff')}</span>`,'Only an admin can change this, on the Team screen')
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

async function stLoadOut(){
  const el=document.getElementById('stOut'); if(!el)return;
  const r=await stOutreachAccounts();
  if(!r.ok){ el.innerHTML=`<p class="st-err">${esc(r.error)}</p>`; return }
  const rows=r.data||[];
  const known=stProviders().join(', ');
  if(!rows.length){
    el.innerHTML=`<div class="empty"><h3>Nothing connected</h3>
      <p>Every client is on the demo data until a real tool is plugged in. Adapters ready to take a key: ${esc(known)}.</p></div>`;
    return;
  }
  el.innerHTML=`<table class="st-tab"><thead><tr><th>Client</th><th>Tool</th><th>Label</th><th>State</th><th>Last read</th></tr></thead><tbody>`
    +rows.map(a=>`<tr><td>${esc((a.clients&&a.clients.company)||'—')}</td><td>${esc(a.provider)}</td><td>${esc(a.label||'')}</td>
      <td>${esc(a.status)}${a.last_error?`<small class="st-err">${esc(a.last_error)}</small>`:''}</td>
      <td>${a.last_synced_at?esc(String(a.last_synced_at).slice(0,16).replace('T',' ')):'never'}</td></tr>`).join('')
    +`</tbody></table><p class="st-note">Adapters available: ${esc(known)}. A tool with no key reads as <b>needs_key</b> and its screens stay on the demo data.</p>`;
}
