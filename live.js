/* ===================== AVIANCE OS — Live (live.js) =======================
   Who is on aviance.online right now.

   The website sends a beacon every twenty seconds while a tab is in front of
   somebody. This screen reads v_site_live, which counts a person as here if
   their browser checked in within the last two minutes. The owner's own
   browser is excluded: visiting the site once with ?me=1 marks it, for good,
   on that device.

   The phone is told separately, by the edge function, twice per session at
   most: once when somebody arrives, once if they start booking. This screen
   is for looking; the phone is for being interrupted.

   Nothing here identifies anybody. There is no name, no email and no IP
   address until somebody actually books, at which point they appear on the
   Calendar like any other booking. A session key is a random string the
   browser invents and forgets when the tab closes.

   Every global is prefixed `lv`, except viewLive, which index.html mounts.
   ========================================================================= */

/* ---- plumbing (the house shape, from core.js) --------------------- */
const lvOk = coreOk;
const lvErr = coreErr;
const lvEsc = coreEsc;
const lvAgo = coreAgo;

const LV_EVERY = 15000;   /* the screen re-reads this often while it is open */

const lv = {rows: null, err: '', loading: false, seq: 0, timer: null};

/* ---- reading ------------------------------------------------------ */

/* Everybody on the website now. Never throws; an empty list and a failure are
   different things, and the screen says which. */
async function lvLoad(){
  lv.err = ''; lv.loading = true;
  const seq = ++lv.seq;
  const r = await lvRun(() => sb.from('v_site_live').select('*').limit(50));
  if (seq !== lv.seq) return lvOk(null);
  lv.loading = false;
  lv.rows = r.ok ? (r.data || []) : null;
  lv.err = r.ok ? '' : r.error;
  return r;
}

async function lvRun(fn){
  try {
    const {data, error} = await fn();
    if (error) return lvErr(lvWords(error));
    return lvOk(data);
  } catch (e) {
    return lvErr(lvWords(e));
  }
}

/* A database complaint, in a sentence. */
function lvWords(e){
  const m = String((e && e.message) || e || '');
  if (/relation .*site_visits|v_site_live/i.test(m) || /does not exist/i.test(m)) {
    return 'The live view is not set up yet. Run 20261128_site_presence.sql in Supabase and this screen fills itself in.';
  }
  if (/permission|rls|policy/i.test(m)) {
    return 'This account cannot read the live view. Only the owner can.';
  }
  return m || 'Could not read who is on the site. Try again in a moment.';
}

/* ---- the badge the sidebar shows ---------------------------------- */

/* How many people are on the site. Shown amber for anyone browsing and red
   the moment one of them is booking, because that is the one worth looking
   up for. '' when nobody is there: a grey zero is noise. */
function lvNavCount(){
  const rows = lv.rows;
  if (!rows || !rows.length) return '';
  return String(rows.length);
}
function lvNavTone(){
  const rows = lv.rows || [];
  return rows.some(r => r && r.stage === 'booking') ? 'red' : 'amber';
}

/* ---- words -------------------------------------------------------- */

const LV_STAGE = {
  browsing: 'Reading',
  booking:  'Booking a call',
  booked:   'Booked',
};

/* Where they came from, as a person would say it. */
function lvSource(ref){
  const s = String(ref || '');
  if (!s) return 'came straight here';
  try {
    const h = new URL(s).hostname.replace(/^www\./, '');
    if (h.indexOf('aviance.online') >= 0) return '';
    const named = [['google.','Google'],['bing.','Bing'],['chatgpt.com','ChatGPT'],
      ['openai.','ChatGPT'],['perplexity.','Perplexity'],['claude.ai','Claude'],
      ['gemini.google','Gemini'],['linkedin.','LinkedIn'],['reddit.','Reddit']];
    for (const [needle, word] of named) if (h.indexOf(needle) >= 0) return 'from ' + word;
    return 'from ' + h;
  } catch (e) { return 'came straight here'; }
}

function lvWhere(r){
  const bits = [r && r.city, r && r.country].filter(Boolean);
  return bits.join(', ');
}

/* How long they have been here, in the shortest true form. */
function lvFor(seconds){
  const n = Math.max(Math.round(Number(seconds) || 0), 0);
  if (n < 60) return n + 's';
  const m = Math.round(n / 60);
  if (m < 60) return m + 'm';
  return Math.round(m / 60) + 'h';
}

/* The page they are on, readable. */
function lvPage(path){
  const p = String(path || '/');
  if (p === '/' || p === '/index.html') return 'the home page';
  if (/^\/book/.test(p)) return 'the booking page';
  if (p === '/compare') return 'the comparisons';
  if (/^\/compare\//.test(p)) return p.replace('/compare/', '').replace(/-/g, ' ');
  return p;
}

/* ---- drawing (pure) ----------------------------------------------- */

function lvRow(r){
  const stage = LV_STAGE[r && r.stage] || 'Reading';
  const hot = r && r.stage === 'booking';
  const done = r && r.stage === 'booked';
  const where = lvWhere(r);
  const src = lvSource(r && r.referrer);
  return `<li class="lv-row${hot ? ' lv-hot' : ''}">
    <span class="lv-dot" aria-hidden="true"></span>
    <span class="lv-who">
      <b>${lvEsc(where || 'Somebody')}</b>
      <span class="lv-sub">on ${lvEsc(lvPage(r && r.path))}${src ? ' · ' + lvEsc(src) : ''}</span>
    </span>
    <span class="lv-stage"><span class="pill ${hot ? 'red' : (done ? 'green' : '')}">${lvEsc(stage)}</span></span>
    <span class="lv-when fig">${lvEsc(lvFor(r && r.seconds_here))}</span>
  </li>`;
}

function lvEmpty(){
  return `<div class="card lv-none">
    <b>Nobody is on the site right now.</b>
    <p>When somebody lands on aviance.online they appear here within a few seconds, and your phone gets one message. If they start booking, it gets a second one.</p>
  </div>`;
}

function lvBody(){
  if (lv.err) return `<div class="card lv-none" role="alert"><b>${lvEsc(lv.err)}</b></div>`;
  if (lv.rows === null) return `<div class="card view-loading" role="status">Looking…</div>`;
  if (!lv.rows.length) return lvEmpty();
  const booking = lv.rows.filter(r => r && r.stage === 'booking').length;
  return `<div class="section-head"><b>On the site now</b>
      <span class="count">${lv.rows.length}</span>${
      booking ? `<span class="count red">${booking} booking</span>` : ''}</div>
    <ul class="lv-list">${lv.rows.map(lvRow).join('')}</ul>
    <p class="lv-foot">Counted as here if their browser checked in within the last two minutes. Your own browser is left out once you have opened the site with <span class="fig">?me=1</span>. Nothing here names anybody — a booking does that, and it lands on the Calendar.</p>`;
}

/* index.html mounts this. It hands back its own host and fills it in, so the
   screen draws at once rather than sitting on "Loading". */
function viewLive(){
  lvKick();
  return `<div id="lvHost">${lvBody()}</div>`;
}

/* ---- keeping it live ---------------------------------------------- */

function lvPaint(){
  const host = typeof document !== 'undefined' && document.getElementById('lvHost');
  if (host) host.innerHTML = lvBody();
}

function lvKick(){
  lvLoad().then(() => { lvPaint(); try { renderNav(); } catch (e) {} });
}

/* While the screen is open it re-reads every fifteen seconds. It stops the
   moment the owner goes somewhere else, because a timer left running behind
   another screen is a request every fifteen seconds for nothing. */
function lvOnRender(v){
  if (lv.timer) { clearInterval(lv.timer); lv.timer = null; }
  if (v !== 'live') return;
  lv.rows = null;
  lvKick();
  if (typeof setInterval === 'function') {
    lv.timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      lvKick();
    }, LV_EVERY);
  }
}
