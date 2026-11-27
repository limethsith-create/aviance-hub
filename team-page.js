/* ===================== AVIANCE — the staff channel (aviance.store/team) =====
   One employee, one screen: her private line to Limethsith. Her browser gets
   ONLY this file, team-page.css, theme.css + polish.css and supabase-js — no
   hub module is loaded here, so nothing about the rest of the hub can leak
   into the page even by accident.

   What this page may touch is decided by the database, not by this file:
   it only ever calls the three staff-callable functions (`staff_me`,
   `staff_send`, `staff_seen`) and the private `chat-files` bucket under her
   own channel's folder. A one-click invite link is swapped for a
   session through Supabase's own sign-in and nothing else. It never reads a table directly, so a mistake here
   cannot widen what she can see.

   Rules this file keeps (house style):
     - Every data function returns {ok, data, error} and never throws.
       `error` is plain words, safe to put in front of her.
     - Every *Html builder is pure: data in, finished and escaped HTML out,
       so the tests can check them without a browser.
     - Everything from a person or the database goes through tmcEsc.
     - The access code is a code to her, never a "password", even though
       Supabase treats it as one.

   Prefix `tmc` (team chat): `tm` already belongs to the hub's own team.js.
   =========================================================================== */

const TMC_URL = 'https://zjbxnkpktbghhudjbxhk.supabase.co';
const TMC_KEY = 'sb_publishable_WV4FANV2hNsmbzK3DbiLFg_9bjiB8Z1';
const TMC_LOGO = 'https://www.aviance.online/logo-180.png';
const TMC_OWNER = 'Limethsith';
const TMC_MAX_BODY = 4000;
const TMC_POLL_MS = 8000;          /* only while the tab is visible */
const TMC_BUCKET = 'chat-files';
const TMC_MAX_FILE = CORE_FILE_MAX;       /* one copy, in core.js, shared with the owner's screen */
const TMC_SIGN_SECONDS = 600;
const TMC_HISTORY_NOTE = 'This is your private line to ' + TMC_OWNER + '. Anything you need, write it here.';
const TMC_OFFLINE = 'We could not reach Aviance. Check your connection and try again.';
const TMC_BAD_CODE = "That code didn't work. Check it with " + TMC_OWNER + '.';
const TMC_NO_ACCOUNT = 'This login is not set up for the Aviance team. Check it with ' + TMC_OWNER + '.';
const TMC_NOT_READY = 'Your channel is not ready yet. ' + TMC_OWNER + ' will let you know when it is.';
const TMC_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TMC_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* What may go in the bucket. Kept in the browser as well as in the database
   policy so she hears "that kind of file" before a 10 MB upload, not after. */
const TMC_EXTS = CORE_FILE_EXTS;
const TMC_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'];

/* ---- pure helpers --------------------------------------------------- */

/* The one escape, from core.js. Use it on everything that did not come from this file. */
const tmcEsc = coreEsc;

/* What she typed -> what is stored. The database trims to the same length. */
function tmcCleanBody(text){
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim().slice(0, TMC_MAX_BODY);
}

/* '' when the email looks usable, otherwise what to fix. Deliberately loose:
   the database decides who exists, this only catches obvious typos. */
function tmcEmailProblem(email){
  const e = String(email == null ? '' : email).trim();
  if (!e) return 'Enter your email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'That email address does not look right.';
  return '';
}

/* '' when the code is worth sending. Never says how a code is built, so a
   changed code format does not lock her out of her own screen. */
function tmcCodeProblem(code){
  const c = String(code == null ? '' : code).trim();
  if (!c) return 'Enter your access code.';
  if (c.length < 6) return 'That code looks too short. Check it with ' + TMC_OWNER + '.';
  return '';
}

/* What stays in the box after `sent` has gone: whatever she typed after it while it was on its way.
   Without this, a fast typist loses the start of her next message when the first one lands. */
function tmcLeftover(sent, now){
  const a = String(sent == null ? '' : sent), b = String(now == null ? '' : now);
  if (b === a) return '';
  return b.indexOf(a) === 0 ? b.slice(a.length).replace(/^\s+/, '') : b;
}

/* She types a code with spaces or in lower case; Supabase wants it exactly. */
function tmcCleanCode(code){
  return String(code == null ? '' : code).trim().replace(/\s+/g, '').toUpperCase();
}

function tmcExt(name){
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name == null ? '' : name).trim());
  return m ? m[1].toLowerCase() : '';
}
function tmcIsImage(name){
  return TMC_IMAGE_EXTS.indexOf(tmcExt(name)) !== -1;
}

/* Whole megabytes read as 10 MB; a part reads as 1.4 MB. */
function tmcSize(bytes){
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  const mb = n / (1024 * 1024);
  return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB';
}

/* '' when the file can go, otherwise a plain sentence. */
function tmcFileProblem(file){
  const f = file || {};
  const name = String(f.name == null ? '' : f.name);
  if (!name) return 'Choose a file first.';
  if (Number(f.size) > TMC_MAX_FILE) return 'That file is too big. The limit is 10 MB — this one is ' + tmcSize(f.size) + '.';
  if (Number(f.size) === 0) return 'That file is empty.';
  if (TMC_EXTS.indexOf(tmcExt(name)) === -1) return 'You can send an image, a PDF, a Word file or a CSV.';
  return '';
}

/* Where a file lives: `<channel_id>/<uuid>.<ext>`, exactly as the bucket's
   policy expects. Nothing of her file name goes into the path, so a name with
   a slash or an accent in it cannot reach another folder. */
function tmcFilePath(channelId, name, uuid){
  const id = String(channelId == null ? '' : channelId).trim();
  if (!id) return '';
  const ext = tmcExt(name);
  let u = String(uuid == null ? '' : uuid).trim();
  if (!/^[0-9a-f-]{8,64}$/i.test(u)) u = tmcUuid();
  return id + '/' + u + (ext ? '.' + ext : '');
}
function tmcUuid(){
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* fall through */ }
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/* The last part of a stored path, for the chip under a message. */
function tmcFileLabel(path){
  const p = String(path == null ? '' : path).trim();
  if (!p) return '';
  const last = p.split('?')[0].split('/').pop() || p;
  return last;
}

/* A value -> a Date, from core.js. A date-only value is a calendar day and does
   not slide with the reader's zone; a timestamp is a moment.
   This file used to read a date-only value with new Date(), which is UTC
   midnight, so anywhere behind UTC it showed the day BEFORE. Only timestamps
   reach it today, so nothing on her page was ever wrong — but the next field
   someone shows here would have been. core.js has the right one. */
const tmcToDate = coreToDate;
/* A clock reading in the reader's own style, from core.js. */
const tmcTime = coreTime;
/* A day key, from core.js: 'YYYY-MM-DD' zero-padded in the reader's own calendar.
   One implementation, because a day key one day out is a refund. */
const tmcDayKey = coreDayKey;
function tmcDayLabel(v, now){
  const d = tmcToDate(v);
  if (!d) return '';
  const n = tmcToDate(now) || new Date();
  const key = tmcDayKey(d);
  if (key === tmcDayKey(n)) return 'Today';
  if (key === tmcDayKey(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1))) return 'Yesterday';
  return TMC_DAYS[d.getDay()] + ', ' + TMC_MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() === n.getFullYear() ? '' : ', ' + d.getFullYear());
}

/* What `staff_me` sent -> days of messages ready to draw. A message is hers
   when its author is her own id; everything else in her channel is his. */
function tmcGroupMessages(me, now){
  const m = me || {};
  const myId = (m.staff && m.staff.id) || '';
  const ownerName = (m.owner && m.owner.name) || TMC_OWNER;
  const myName = (m.staff && m.staff.name) || 'You';
  const list = (Array.isArray(m.messages) ? m.messages : [])
    .filter((r) => r && r.id != null && !r.deleted_at)
    .slice()
    .sort((a, b) => (tmcToDate(a.created_at) || 0) - (tmcToDate(b.created_at) || 0));
  const days = [];
  const seen = {};
  let prev = null;
  for (const r of list) {
    if (seen[r.id]) continue;
    seen[r.id] = true;
    const mine = !!myId && String(r.author_user || '') === String(myId);
    const at = tmcToDate(r.created_at);
    const key = tmcDayKey(at);
    let day = days[days.length - 1];
    if (!day || day.key !== key) { day = { key, label: tmcDayLabel(at, now), items: [] }; days.push(day); prev = null; }
    /* a new head only when the writer changes or after a five minute gap */
    const lead = !prev || prev.mine !== mine || (at - prev.at) > 5 * 60 * 1000;
    day.items.push({
      id: r.id, mine, name: mine ? myName : ownerName,
      time: tmcTime(at), iso: at ? at.toISOString() : '',
      body: String(r.body == null ? '' : r.body),
      attachment: String(r.attachment_url == null ? '' : r.attachment_url),
      lead,
    });
    prev = { mine, at };
  }
  return days;
}

/* When he has read her. The time comes from whichever field `staff_me`
   carries; with no field at all we say "Sent" rather than claim he has read
   it. '' when the last word in the channel is his. */
function tmcSeenLine(me, now){
  const m = me || {};
  const myId = (m.staff && m.staff.id) || '';
  const mine = (Array.isArray(m.messages) ? m.messages : [])
    .filter((r) => r && !r.deleted_at && !!myId && String(r.author_user || '') === String(myId))
    .sort((a, b) => (tmcToDate(a.created_at) || 0) - (tmcToDate(b.created_at) || 0));
  const last = mine[mine.length - 1];
  if (!last) return '';
  const readRaw = (m.owner && (m.owner.last_read_at || m.owner.read_at)) ||
    (m.channel && m.channel.owner_last_read_at) || m.owner_last_read_at || '';
  const read = tmcToDate(readRaw);
  const at = tmcToDate(last.created_at);
  if (!read || !at || read < at) return 'Sent';
  return 'Seen ' + tmcTime(read) + (tmcDayKey(read) === tmcDayKey(tmcToDate(now) || new Date()) ? '' : ' on ' + tmcDayLabel(read, now));
}

/* ---- HTML builders (pure, everything escaped) ----------------------- */

function tmcLogoHtml(){
  return `<img class="tmc-logo" src="${TMC_LOGO}" width="36" height="36" alt="Aviance">`;
}

function tmcNoticeHtml(title, text, extra){
  return `<main class="tmc-notice">${tmcLogoHtml()}
    <h1 class="tmc-h1" tabindex="-1">${tmcEsc(title)}</h1>
    <p class="tmc-lede">${tmcEsc(text)}</p>${extra || ''}</main>`;
}
function tmcLoadingHtml(){
  return `<main class="tmc-notice" aria-busy="true">${tmcLogoHtml()}<p class="tmc-tag">Loading</p></main>`;
}
function tmcOfflineHtml(){
  return tmcNoticeHtml('We could not load your channel.', TMC_OFFLINE,
    '<p class="tmc-row"><button type="button" class="tmc-btn" data-tmc-retry>Try again</button></p>');
}

/* The sign-in screen. No sign-up, no forgotten-code link, no mention of
   anything else in the hub: the only way in is a code he gave her. */
function tmcSignInHtml(state){
  const s = state || {};
  return `<main class="tmc-notice tmc-signin">${tmcLogoHtml()}
    <h1 class="tmc-h1" tabindex="-1">Sign in.</h1>
    <p class="tmc-lede">Your private line to ${tmcEsc(TMC_OWNER)} at Aviance.</p>
    <form class="tmc-form" id="tmcInForm" novalidate>
      <div class="tmc-field">
        <label class="tmc-label" for="tmcInEmail">Email</label>
        <input class="tmc-input" id="tmcInEmail" name="email" type="email" autocomplete="username"
          inputmode="email" autocapitalize="none" spellcheck="false" required value="${tmcEsc(s.email || '')}">
      </div>
      <div class="tmc-field">
        <label class="tmc-label" for="tmcInCode">Access code</label>
        <input class="tmc-input tmc-code" id="tmcInCode" name="code" type="password" autocomplete="one-time-code"
          autocapitalize="characters" spellcheck="false" required aria-describedby="tmcInErr">
        <p class="tmc-help">The code ${tmcEsc(TMC_OWNER)} sent you. It stays the same until he changes it.</p>
      </div>
      <p class="tmc-err" id="tmcInErr" role="alert" aria-live="assertive">${tmcEsc(s.error || '')}</p>
      <button type="submit" class="tmc-btn tmc-wide" id="tmcInBtn"${s.busy ? ' disabled' : ''}>${s.busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <p class="tmc-small tmc-under">No code yet, or it has stopped working? Ask ${tmcEsc(TMC_OWNER)}.</p>
  </main>`;
}

/* Her channel: a bar, the thread, a send box. Nothing else is on this page. */
function tmcChannelHtml(me){
  const m = me || {};
  const who = (m.owner && m.owner.name) || TMC_OWNER;
  const mine = (m.staff && m.staff.name) || '';
  return `<div class="tmc-app">
    <header class="tmc-bar"><div class="tmc-bar-in">${tmcLogoHtml()}
      <div class="tmc-bar-t">
        <h1>${tmcEsc(who)}</h1>
        <p class="tmc-tag">Aviance${mine ? ' · ' + tmcEsc(mine) : ''}</p>
      </div>
      <button type="button" class="tmc-btn tmc-btn-quiet" id="tmcOut">Sign out</button>
    </div></header>
    <div class="tmc-scroll" id="tmcScroll" tabindex="0" aria-label="Messages">
      <div class="tmc-thread" id="tmcThread" role="log" aria-live="polite" aria-relevant="additions">
        <p class="tmc-tag tmc-mid">Loading</p>
      </div>
    </div>
    <form class="tmc-compose" id="tmcCompose"><div class="tmc-compose-in">
      <p class="tmc-err" id="tmcSendErr" role="alert" aria-live="assertive"></p>
      <p class="tmc-pending" id="tmcPending" aria-live="polite"></p>
      <div class="tmc-compose-row">
        <label class="tmc-sr" for="tmcFile">Attach a file or image</label>
        <input class="tmc-sr" type="file" id="tmcFile" accept="image/*,.pdf,.docx,.csv">
        <button type="button" class="tmc-clip" id="tmcClip" aria-label="Attach a file or image" title="Attach a file or image">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7"/></svg>
        </button>
        <label class="tmc-sr" for="tmcText">Message ${tmcEsc(who)}</label>
        <textarea id="tmcText" rows="1" maxlength="${TMC_MAX_BODY}" placeholder="Write a message"
          enterkeyhint="send" aria-describedby="tmcCount"></textarea>
        <button type="submit" class="tmc-btn" id="tmcSendBtn">Send</button>
      </div>
      <p class="tmc-tag tmc-count" id="tmcCount" aria-live="polite"></p>
    </div></form>
  </div>`;
}

/* The thread. `opts.urls` maps a stored path to a short-lived signed link
   (an image with a link becomes a picture); `opts.seen` is the line under her
   last message. Both optional, so the first paint can draw without them. */
function tmcThreadHtml(days, opts){
  const o = opts || {};
  const list = Array.isArray(days) ? days : [];
  if (!list.length) return `<p class="tmc-empty">${tmcEsc(TMC_HISTORY_NOTE)}</p>`;
  const lastDay = list[list.length - 1] || { items: [] };
  const lastItem = lastDay.items[lastDay.items.length - 1];
  return list.map((day) => `<div class="tmc-day" role="separator"><span class="tmc-tag">${tmcEsc(day.label)}</span></div>` +
    day.items.map((it) => {
      const seen = o.seen && it === lastItem && it.mine
        ? `<p class="tmc-seen">${tmcEsc(o.seen)}</p>` : '';
      return `<article class="tmc-msg tmc-msg-${it.mine ? 'mine' : 'them'}${it.lead ? ' tmc-msg-lead' : ''}">
        ${it.lead ? `<p class="tmc-msg-head"><span class="tmc-msg-name">${tmcEsc(it.name)}</span><time class="tmc-msg-time" datetime="${tmcEsc(it.iso)}">${tmcEsc(it.time)}</time></p>` : ''}
        ${it.body ? `<p class="tmc-msg-body">${tmcEsc(it.body)}</p>` : ''}
        ${tmcAttachmentHtml(it.attachment, o.urls)}
      </article>${seen}`;
    }).join('')).join('');
}

/* One attachment: a picture when we have a link to an image, otherwise a
   chip that asks for a link when she taps it. */
function tmcAttachmentHtml(path, urls){
  const p = String(path == null ? '' : path).trim();
  if (!p) return '';
  const name = tmcFileLabel(p);
  const url = urls && typeof urls === 'object' ? String(urls[p] || '') : '';
  const safe = /^https:\/\/[^\s"'<>\\]+$/i.test(url) ? url : '';
  if (safe && tmcIsImage(name)) {
    return `<a class="tmc-shot" href="${tmcEsc(safe)}" target="_blank" rel="noopener noreferrer">
      <img src="${tmcEsc(safe)}" alt="${tmcEsc(name)}" loading="lazy"></a>`;
  }
  if (safe) {
    return `<a class="tmc-file" href="${tmcEsc(safe)}" target="_blank" rel="noopener noreferrer">${tmcFileIcon()}<span>${tmcEsc(name)}</span></a>`;
  }
  return `<button type="button" class="tmc-file" data-tmc-open="${tmcEsc(p)}">${tmcFileIcon()}<span>${tmcEsc(name)}</span></button>`;
}
function tmcFileIcon(){
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
}

/* The line above the send box while a file is waiting to go with the message. */
function tmcPendingHtml(file){
  const f = file || null;
  if (!f || !f.name) return '';
  return `<span class="tmc-chip">${tmcFileIcon()}<span>${tmcEsc(f.name)}</span>${f.size ? `<span class="tmc-chip-size">${tmcEsc(tmcSize(f.size))}</span>` : ''}
    <button type="button" class="tmc-chip-x" data-tmc-drop aria-label="Remove ${tmcEsc(f.name)}">×</button></span>`;
}

/* ---- plumbing ------------------------------------------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const tmcOk = coreOk;
function tmcErr(e){
  let m = (e && (e.message || e.error_description || e.msg || e.error)) || (typeof e === 'string' ? e : '');
  m = String(m || 'Something went wrong. Please try again.');
  const offline = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(m);
  if (offline) m = TMC_OFFLINE;
  return { ok: false, data: null, error: m, offline };
}

/* A raw database or auth message is never shown. This turns the ones we can
   expect into something she can act on, and anything unknown into one calm
   sentence. */
function tmcSay(raw, fallback){
  const m = String((raw && (raw.message || raw.error)) || raw || '');
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(m)) return TMC_OFFLINE;
  if (/invalid login|invalid credentials|credentials|invalid_grant/i.test(m)) return TMC_BAD_CODE;
  if (/email not confirmed|user not found|no user/i.test(m)) return TMC_NO_ACCOUNT;
  if (/too many|rate limit/i.test(m)) return 'Too many tries. Wait a minute and try again.';
  /* a function that is not there yet, or a policy that says no */
  if (/could not find the function|does not exist|schema cache|42883|pgrst202/i.test(m)) return TMC_NOT_READY;
  if (/permission denied|row-level security|not authorized|jwt/i.test(m)) return TMC_NOT_READY;
  if (/exceeded the maximum|payload too large|too large/i.test(m)) return 'That file is too big. The limit is 10 MB.';
  return fallback || 'Something went wrong. Please try again.';
}

/* One client, her own storage key, so her login and the owner's hub login (and
   a client's portal login) never tread on each other. detectSessionInUrl is
   off: nothing about a login belongs in the address bar of this page. */
let tmcTheClient = null;
function tmcClient(){
  if (tmcTheClient) return tmcTheClient;
  if (typeof window === 'undefined' || !window.supabase || !window.supabase.createClient) return null;
  try {
    tmcTheClient = window.supabase.createClient(TMC_URL, TMC_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'aviance-team-auth' },
    });
  } catch (e) { return null; }
  return tmcTheClient;
}
/* Tests (and nothing else) hand in a fake client. */
function tmcUseClient(client){ tmcTheClient = client; }

async function tmcRpc(name, args){
  const sb = tmcClient();
  if (!sb) return tmcErr(TMC_OFFLINE);
  try {
    const res = await sb.rpc(name, args || {});
    if (!res) return tmcErr('No answer from Aviance.');
    if (res.error) { const r = tmcErr(res.error); r.error = tmcSay(res.error, r.error); return r; }
    return tmcOk(res.data === undefined ? null : res.data);
  } catch (e) {
    // An unexpected throw has no sentence of its own, so don't pass its raw text on as the fallback.
    const r = tmcErr(e); r.error = tmcSay(e, ''); return r;
  }
}

/* ---- the login ------------------------------------------------------ */

/* The code IS the Supabase password. She never hears that word. */
async function tmcSignIn(email, code){
  const sb = tmcClient();
  if (!sb) return tmcErr(TMC_OFFLINE);
  const e = String(email == null ? '' : email).trim();
  const bad = tmcEmailProblem(e) || tmcCodeProblem(code);
  if (bad) return tmcErr(bad);
  try {
    const res = await sb.auth.signInWithPassword({ email: e, password: tmcCleanCode(code) });
    if (res && res.error) { const r = tmcErr(res.error); r.error = tmcSay(res.error, TMC_BAD_CODE); return r; }
    return tmcOk((res && res.data && res.data.session) || null);
  } catch (err) { const r = tmcErr(err); r.error = tmcSay(err, TMC_BAD_CODE); return r; }
}

async function tmcSignOut(){
  const sb = tmcClient();
  if (!sb) return tmcOk(null);
  try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* signed out here either way */ }
  return tmcOk(null);
}

async function tmcSession(){
  const sb = tmcClient();
  if (!sb) return tmcErr(TMC_OFFLINE);
  try {
    const res = await sb.auth.getSession();
    if (res && res.error) return tmcErr(res.error);
    return tmcOk(res && res.data ? res.data.session : null);
  } catch (e) { return tmcErr(e); }
}

/* ---- the one-click invite link --------------------------------------
   The owner sends her one URL. The link checker (the caller-link function)
   makes sure the invite is real and unexpired, then bounces her here with a
   one-time sign-in token in the fragment: #k=...

   A fragment, never a query string, because fragments are not sent to any
   server or written into server logs. We swap it for a session and wipe it
   from the address bar in the same breath. The token is good for one use. */
/* ---8<--- link-claim: the only place this page touches the address bar ---8<---
   It reads the fragment, swaps it for a session and clears it. Nothing here
   navigates anywhere. The test in tests/team-page.test.mjs cuts this block
   out and then checks that the rest of the file cannot read or change where
   the browser is. */
const TMC_LINK_BAD = 'That link has already been used or has run out. Ask ' + TMC_OWNER + ' for a new one, or sign in with your code below.';
const TMC_LINK_SAY = {
  expired: 'That link has run out. Ask ' + TMC_OWNER + ' for a new one, or sign in with your code below.',
  bad: TMC_LINK_BAD,
  team: 'That link cannot be used for this page. Ask ' + TMC_OWNER + ' for a new one.',
  email: 'There is no email address on your record yet. Ask ' + TMC_OWNER + ' to add one.',
  again: 'Something went wrong opening that link. Try it once more, or sign in with your code below.',
  method: TMC_LINK_BAD,
};

function tmcLinkToken(){
  if (typeof window === 'undefined' || !window.location) return '';
  const m = /[#&]k=([^&]+)/.exec(String(window.location.hash || ''));
  if (!m) return '';
  let t = m[1];
  try { t = decodeURIComponent(m[1]); } catch (e) { /* take it as it came */ }
  return String(t).trim();
}

/* Take the token out of the address bar without reloading the page. */
function tmcForgetLinkToken(){
  if (typeof window === 'undefined' || !window.location) return;
  try {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', String(window.location.pathname || '/') + String(window.location.search || ''));
    } else {
      window.location.hash = '';
    }
  } catch (e) { /* it stays in the bar; the token is one-use, so little is lost */ }
}

/* What the link checker said when it would not let her in. */
function tmcLinkProblem(){
  if (typeof window === 'undefined' || !window.location) return '';
  const m = /[?&]link=([^&]+)/.exec(String(window.location.search || ''));
  if (!m) return '';
  let why = m[1];
  try { why = decodeURIComponent(m[1]); } catch (e) { /* as it came */ }
  return Object.prototype.hasOwnProperty.call(TMC_LINK_SAY, String(why)) ? TMC_LINK_SAY[String(why)] : TMC_LINK_BAD;
}

/* Returns a session when the link worked, null when there was no link at all. */
async function tmcClaimLink(){
  const token = tmcLinkToken();
  if (!token) return tmcOk(null);
  tmcForgetLinkToken();
  const sb = tmcClient();
  if (!sb) return tmcErr(TMC_OFFLINE);
  if (!sb.auth || typeof sb.auth.verifyOtp !== 'function') return tmcErr(TMC_LINK_BAD);
  try {
    const res = await sb.auth.verifyOtp({ token_hash: token, type: 'email' });
    if (res && res.error) {
      const r = tmcErr(res.error);
      if (!r.offline) r.error = TMC_LINK_BAD;      /* whatever the reason, the fix is the same: a new link or her code */
      return r;
    }
    const session = (res && res.data && res.data.session) || null;
    if (!session) return tmcErr(TMC_LINK_BAD);
    return tmcOk(session);
  } catch (e) { const r = tmcErr(e); if (!r.offline) r.error = TMC_LINK_BAD; return r; }
}
/* ---8<--- end link-claim ---8<--- */

/* Tells the page when the login ends (he revoked it, or it ran out). */
function tmcOnSignedOut(fn){
  const sb = tmcClient();
  if (!sb || !sb.auth || !sb.auth.onAuthStateChange) return;
  try {
    sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { try { fn(); } catch (e) { /* the page's problem */ } } });
  } catch (e) { /* no listener: the poll still notices */ }
}

/* ---- her channel ---------------------------------------------------- */

/* Everything her screen needs, in one call. A reply without a channel means
   this login is not a staff login, which is not an error to shout about. */
async function tmcMe(){
  const r = await tmcRpc('staff_me', {});
  if (!r.ok) return r;
  const d = r.data;
  if (!d || typeof d !== 'object' || !(d.channel && d.channel.id) || !(d.staff && d.staff.id)) return tmcOk(null);
  if (!Array.isArray(d.messages)) d.messages = [];
  return tmcOk(d);
}

async function tmcSend(body, attachment){
  const text = tmcCleanBody(body);
  const file = String(attachment == null ? '' : attachment).trim();
  if (!text && !file) return tmcErr('Write a message first.');
  const r = await tmcRpc('staff_send', { p_body: text || (file ? tmcFileLabel(file) : ''), p_attachment: file || null });
  if (!r.ok) { r.error = 'That message did not go. ' + r.error; return r; }
  return r;
}

/* Marks her channel read and touches her last seen. Nothing on screen depends
   on it, so a failure is swallowed. */
async function tmcSeen(){
  const r = await tmcRpc('staff_seen', {});
  return r.ok ? r : tmcOk(null);
}

/* ---- files ---------------------------------------------------------- */

/* Up into her own channel's folder and nowhere else. Returns the stored path,
   which is what goes in the message. */
async function tmcUpload(channelId, file){
  const sb = tmcClient();
  if (!sb || !sb.storage) return tmcErr(TMC_OFFLINE);
  const bad = tmcFileProblem(file);
  if (bad) return tmcErr(bad);
  const path = tmcFilePath(channelId, file.name);
  if (!path) return tmcErr('There is no channel to send to.');
  try {
    const res = await sb.storage.from(TMC_BUCKET).upload(path, file, {
      cacheControl: '3600', upsert: false, contentType: file.type || undefined,
    });
    if (res && res.error) { const r = tmcErr(res.error); r.error = tmcSay(res.error, 'We could not send that file. Please try again.'); return r; }
    return tmcOk(path);
  } catch (e) { const r = tmcErr(e); r.error = tmcSay(e, 'We could not send that file. Please try again.'); return r; }
}

/* A short-lived link to one file in her folder. The bucket is private, so a
   link is the only way to look at a file, and it goes stale on its own. */
async function tmcFileUrl(path){
  const sb = tmcClient();
  if (!sb || !sb.storage) return tmcErr(TMC_OFFLINE);
  const p = String(path == null ? '' : path).trim();
  if (!p) return tmcErr('That file is not there any more.');
  try {
    const res = await sb.storage.from(TMC_BUCKET).createSignedUrl(p, TMC_SIGN_SECONDS);
    if (res && res.error) { const r = tmcErr(res.error); r.error = tmcSay(res.error, 'We could not open that file.'); return r; }
    const url = res && res.data && (res.data.signedUrl || res.data.signedURL);
    if (!url) return tmcErr('We could not open that file.');
    return tmcOk(String(url));
  } catch (e) { const r = tmcErr(e); r.error = tmcSay(e, 'We could not open that file.'); return r; }
}

/* The paths in a set of days that still need a link, newest first so the
   pictures she is looking at are signed before the ones far up the thread. */
function tmcPathsToSign(days, urls, limit){
  const have = urls && typeof urls === 'object' ? urls : {};
  const out = [];
  const list = Array.isArray(days) ? days : [];
  for (let d = list.length - 1; d >= 0; d--) {
    const items = (list[d] && list[d].items) || [];
    for (let i = items.length - 1; i >= 0; i--) {
      const p = items[i] && items[i].attachment;
      if (p && !have[p] && out.indexOf(p) === -1) out.push(p);
    }
  }
  const max = Number(limit) > 0 ? Number(limit) : 12;
  return out.slice(0, max);
}
