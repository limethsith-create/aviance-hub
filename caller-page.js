/* ===================== AVIANCE — the caller's page (aviance.store/callers) ===
   One cold caller, one screen: the lead she is ringing now, a big number to
   tap, and seven buttons that each log what happened and pull up the next
   lead. Her browser gets ONLY this file, caller-page.css, theme.css +
   polish.css and supabase-js — no hub module is loaded here, so nothing about
   the rest of the hub can reach this page even by accident.

   What this page may touch is decided by the database, not by this file: it
   only ever calls the five caller-callable functions (`caller_me`,
   `caller_next`, `caller_log`, `caller_slots`, `caller_book`). It never reads
   a table directly, so a mistake here cannot widen what she can see.

   Rules this file keeps (house style):
     - Every data function returns {ok, data, error} and never throws. `error`
       is plain words, safe to put in front of her.
     - Every *Html builder is pure: data in, finished and escaped HTML out, so
       the tests can check them without a browser.
     - Everything from a person or the database goes through clEsc.
     - The access code is a code to her, never a "password", even though
       Supabase treats it as one.
     - The RPCs may not be applied yet. Anything missing turns into one calm
       "not switched on yet" sentence and a Try again button — never a blank
       screen and never a raw database message.

   Prefix `cl` (caller). `cal` belongs to the owner's Callers screen.
   =========================================================================== */

const CL_URL = 'https://zjbxnkpktbghhudjbxhk.supabase.co';
const CL_KEY = 'sb_publishable_WV4FANV2hNsmbzK3DbiLFg_9bjiB8Z1';
const CL_LOGO = 'https://www.aviance.online/logo-180.png';
const CL_OWNER = 'Limethsith';
const CL_POLL_MS = 60000;         /* only while the tab is visible: the lead on screen is hers until she logs it */
const CL_CLOCK_MS = 30000;        /* how often the prospect's local time is redrawn */
const CL_SLOT_DAYS = 14;
const CL_MAX_NOTE = 1000;

const CL_OFFLINE = 'We could not reach Aviance. Check your connection and try again.';
const CL_BAD_CODE = "That code didn't work. Check it with " + CL_OWNER + '.';
const CL_NO_ACCOUNT = 'This login is not set up for calling. Check it with ' + CL_OWNER + '.';
const CL_NOT_READY = 'Your calling list is not switched on yet. ' + CL_OWNER + ' will let you know when it is.';
const CL_NO_LEADS = 'No one left to ring just now. Take a breather and check again in a few minutes.';
const CL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* The seven outcomes, exactly as the database will accept them. `asks` marks
   the two that need something from her before they can be logged. The number
   is also the keyboard shortcut, so her hand can stay off the screen. */
const CL_OUTCOMES = [
  { key: 'no_answer', label: 'No answer', tone: 'plain', shortcut: '1' },
  { key: 'voicemail', label: 'Voicemail', tone: 'plain', shortcut: '2' },
  { key: 'not_interested', label: 'Not interested', tone: 'cold', shortcut: '3' },
  { key: 'wrong_number', label: 'Wrong number', tone: 'cold', shortcut: '4' },
  { key: 'bad_fit', label: 'Bad fit', tone: 'cold', shortcut: '5' },
  { key: 'callback', label: 'Call back', tone: 'warm', shortcut: '6', asks: 'callback' },
  { key: 'booked', label: 'Booked', tone: 'win', shortcut: '7', asks: 'book' },
];

/* The cold-calling script, word for word from the brief. The guarantee is
   open by default because it is the pitch. */
const CL_SCRIPT = [
  {
    id: 'opener', title: '1. Opener', open: false, items: [
      { kind: 'say', text: '"Hi, is that [NAME]?" — wait.' },
      { kind: 'say', text: '"[NAME], I\'ll be straight with you: this is a cold call. Give me thirty seconds and then tell me to get lost if you want. Fair?"' },
      { kind: 'note', text: 'If "I\'m busy": "No problem. Better time today or tomorrow?" Get a time, or get off the phone.' },
    ],
  },
  {
    id: 'what', title: '2. What we do (twenty seconds)', open: false, items: [
      { kind: 'say', text: '"We book sales calls for businesses that sell to other businesses. We write the cold email, test it on our own inboxes until we find the message your market answers, and the meetings land on your calendar. You don\'t send anything or manage anything — you just turn up."' },
    ],
  },
  {
    id: 'guarantee', title: '3. The guarantee (say it every call)', open: true, items: [
      { kind: 'say', text: '"Here\'s the part that matters. Before we start, we agree a number of calls for the month. If we miss that number in your first month, you don\'t get an apology, you get double your money back. Not the calls — double the fee. Every month after that, if we miss it, that month is free, refunded in full. So the only person taking a risk here is me."' },
      { kind: 'note', text: 'The numbers, exactly:' },
      { kind: 'num', text: 'Starter $1,500/month → 5 calls → $3,000 back in month one.' },
      { kind: 'num', text: 'Growth $3,000/month → 10 calls → $6,000 back.' },
      { kind: 'num', text: 'Scale $4,500/month → 15 calls → $9,000 back.' },
      { kind: 'note', text: 'On a 3-month term the monthly price drops — Starter $1,200, Growth $2,400, Scale $3,600 a month — and double-back means double that month\'s fee.' },
    ],
  },
  {
    id: 'questions', title: '4. Three questions', open: false, items: [
      { kind: 'num', text: '"Who\'s a good customer for you — the kind you want more of?"' },
      { kind: 'num', text: '"Roughly what\'s one new customer worth to you over a year?"' },
      { kind: 'num', text: '"How do meetings come in today?"' },
    ],
  },
  {
    id: 'close', title: '5. The close', open: false, items: [
      { kind: 'say', text: '"Here\'s what I\'d do. Thirty minutes with ' + CL_OWNER + ' — he\'ll tell you honestly whether cold email suits what you sell. He says no to people a lot. If it does fit, you\'ll agree the number and the guarantee right there on that call. Does Thursday morning work, or is Friday better?"' },
      { kind: 'note', text: 'Two options, never "would you like to book a call?" Then take their email, read it back, and tell them the invite is on its way.' },
    ],
  },
  {
    id: 'objections', title: '6. Objections', open: false, items: [
      { kind: 'ask', term: '"Not interested."', text: '"Fair enough. One thing before I go — is it that you\'re full right now, or that you\'ve been burned by this before?"' },
      { kind: 'ask', term: '"We tried cold email, it didn\'t work."', text: '"Most of it doesn\'t, because people guess the message and blast it. We test angles on our own warmed inboxes first, and we carry the risk. Miss the number, you get double back. Did the last lot offer you that?"' },
      { kind: 'ask', term: '"Just send me an email."', text: '"I will. What\'s the best address? And so it isn\'t another email in the pile — if I put thirty minutes in next week and it\'s useless, you cancel it and you\'ve lost nothing."' },
      { kind: 'ask', term: '"Sounds too good to be true."', text: '"It would be if we took everyone. We don\'t. And it isn\'t a sales promise, it\'s written into the agreement you sign."' },
      { kind: 'ask', term: '"How much?"', text: '"Depends on the number you want. Most start on Starter: five qualified calls a month, $1,500 a month, or $1,200 a month if you take the three-month term. Miss five in your first month and you get $3,000 back. From there it\'s ten calls at $3,000 and fifteen at $4,500."' },
      { kind: 'ask', term: '"We have someone doing this."', text: '"Good. What\'s it booking a month? We\'re not replacing them — we\'re the version with a number attached and money behind it."' },
      { kind: 'ask', term: '"I don\'t have time."', text: '"That\'s exactly why this exists. Thirty seconds are up, by the way. Shall I take thirty minutes off your hands next week instead?"' },
      { kind: 'ask', term: '"How do you get the calls?"', text: '"Pre-warmed inboxes, a list built for your market, and copy you approve before a single email goes out."' },
      { kind: 'ask', term: '"What if the calls are rubbish?"', text: '"We agree what counts as qualified before we start, and it\'s in the agreement. If it doesn\'t meet that, it doesn\'t count towards your number — so a bad call costs you nothing and costs us."' },
    ],
  },
  {
    id: 'rules', title: '7. Rules', open: false, items: [
      { kind: 'rule', text: 'We guarantee booked calls, never revenue, clients or sales.' },
      { kind: 'rule', text: 'Never invent a number, a date or a discount. "I\'ll find out and come back to you" is always allowed.' },
      { kind: 'rule', text: 'Never argue. Rude? "No problem, have a good one," and ring the next one.' },
      { kind: 'rule', text: 'Log every call honestly. A junk booking costs everyone the bonus.' },
    ],
  },
];

/* ---- pure helpers --------------------------------------------------- */

/* The one escape. Use it on everything that did not come from this file. */
function clEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* '' when the email looks usable, otherwise what to fix. Deliberately loose:
   the database decides who exists, this only catches obvious typos. */
function clEmailProblem(email){
  const e = String(email == null ? '' : email).trim();
  if (!e) return 'Enter your email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'That email address does not look right.';
  return '';
}

/* '' when the code is worth sending. Never says how a code is built, so a
   changed code format does not lock her out of her own screen. */
function clCodeProblem(code){
  const c = String(code == null ? '' : code).trim();
  if (!c) return 'Enter your access code.';
  if (c.length < 6) return 'That code looks too short. Check it with ' + CL_OWNER + '.';
  return '';
}

/* She types a code with spaces or in lower case; Supabase wants it exactly. */
function clCleanCode(code){
  return String(code == null ? '' : code).trim().replace(/\s+/g, '').toUpperCase();
}

function clCleanNote(text){
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim().slice(0, CL_MAX_NOTE);
}

function clToDate(v){
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function clDayKey(v){
  const d = clToDate(v);
  return d ? d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) : '';
}

function clTime(v){
  const d = clToDate(v);
  if (!d) return '';
  try { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
}

/* "Today", "Tomorrow", else "Thursday, 27 November". Used for slot headings
   and for the callback she picks. */
function clDayLabel(v, now){
  const d = clToDate(v);
  if (!d) return '';
  const n = clToDate(now) || new Date();
  const key = clDayKey(d);
  if (key === clDayKey(n)) return 'Today';
  if (key === clDayKey(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1))) return 'Tomorrow';
  return CL_DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + CL_MONTHS[d.getMonth()];
}

/* A date input wants 2026-11-27 in her own local days, not UTC. */
function clDateValue(v){
  const d = clToDate(v);
  return d ? clDayKey(d) : '';
}

/* What the prospect's clock says. An unknown or misspelt timezone is not an
   error: we simply say we do not know, rather than guess and have her ring
   somebody at three in the morning. `risky` is true outside 08:00–20:00. */
function clZoneNow(timezone, now){
  const zone = String(timezone == null ? '' : timezone).trim();
  const at = clToDate(now) || new Date();
  const none = { ok: false, zone, time: '', day: '', hour: -1, risky: false };
  if (!zone) return none;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at);
    const grab = (k) => { const p = parts.filter((x) => x.type === k)[0]; return p ? p.value : ''; };
    let hour = Number(grab('hour'));
    if (!isFinite(hour)) return none;
    if (hour === 24) hour = 0;                           /* some engines say 24 for midnight */
    const minute = grab('minute') || '00';
    return {
      ok: true, zone, day: grab('weekday'),
      time: ('0' + hour).slice(-2) + ':' + minute, hour,
      risky: hour < 8 || hour >= 20,
    };
  } catch (e) { return none; }                            /* an unknown zone throws: say nothing */
}

/* A slot as the PROSPECT'S clock will show it: "Thu 10:00". She rings other countries, and the time she
   must read out is theirs, not hers. '' when their zone is not known or is the same as hers at that moment. */
function clTheirTime(v, timezone){
  const d = clToDate(v);
  if (!d) return '';
  const z = clZoneNow(timezone, d);
  if (!z.ok) return '';
  const mine = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  if (z.time === mine && (!z.day || z.day === CL_DAYS[d.getDay()].slice(0, 3))) return '';
  return (z.day ? z.day + ' ' : '') + z.time;
}

/* The line under the phone number. Short, because she reads it mid-dial. */
function clZoneLine(timezone, now){
  const z = clZoneNow(timezone, now);
  if (!z.ok) return z.zone ? z.zone + ' · local time unknown' : 'Timezone not known';
  return (z.day ? z.day + ' ' : '') + z.time + ' where they are · ' + z.zone;
}

/* Only digits, a leading + and nothing else can go in a tel: link, so a
   "phone" that is really text cannot turn into another kind of URL. */
function clTelHref(phone){
  const raw = String(phone == null ? '' : phone).trim();
  const plus = /^\s*\+/.test(raw);
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 5) return '';
  return 'tel:' + (plus ? '+' : '') + digits;
}

/* What she sees: her own list's spacing, kept as typed, because she may need
   to read it out. */
function clPhoneLabel(phone){
  const raw = String(phone == null ? '' : phone).trim();
  return raw.replace(/\s+/g, ' ');
}

function clFirstName(name){
  const w = String(name == null ? '' : name).trim().split(/\s+/)[0];
  return w || '';
}

/* The lead `caller_me`/`caller_next` handed over -> what the screen draws.
   Returns null when there is nothing to ring, so one check covers both the
   "list is empty" and the "not switched on" cases. */
function clLead(raw){
  const r = raw && typeof raw === 'object' ? raw : null;
  if (!r || !r.id) return null;
  return {
    id: String(r.id),
    name: String(r.name == null ? '' : r.name).trim(),
    company: String(r.company == null ? '' : r.company).trim(),
    phone: String(r.phone == null ? '' : r.phone).trim(),
    email: String(r.email == null ? '' : r.email).trim(),
    timezone: String(r.timezone == null ? '' : r.timezone).trim(),
    notes: String(r.notes == null ? '' : r.notes).trim(),
    callback_at: r.callback_at || '',
    outcome: String(r.outcome == null ? '' : r.outcome).trim(),
    batch: String(r.batch == null ? '' : r.batch).trim(),
  };
}

/* Her tally for today. Numbers only, never a stray string on the screen. */
function clTally(today){
  const t = today && typeof today === 'object' ? today : {};
  const n = (v) => { const x = Number(v); return isFinite(x) && x > 0 ? Math.round(x) : 0; };
  return { dials: n(t.dials), booked: n(t.booked) };
}

/* `caller_slots` gives a flat list of free times; she thinks in days. Each
   slot may be a bare timestamp or {starts_at}/{start}/{slot}. */
function clSlotGroups(slots, now){
  const list = Array.isArray(slots) ? slots : [];
  const days = [];
  const seen = {};
  list.map((s) => {
    if (s == null) return null;
    if (typeof s === 'string' || s instanceof Date) return clToDate(s);
    return clToDate(s.starts_at || s.start || s.slot || s.call_at || s.at);
  }).filter((d) => !!d)
    .sort((a, b) => a - b)
    .forEach((d) => {
      const iso = d.toISOString();
      if (seen[iso]) return;                            /* the same minute twice is one slot */
      seen[iso] = true;
      const key = clDayKey(d);
      let day = days[days.length - 1];
      if (!day || day.key !== key) { day = { key, label: clDayLabel(d, now), slots: [] }; days.push(day); }
      day.slots.push({ iso, time: clTime(d) });
    });
  return days;
}

/* A day and a time from two inputs -> one ISO instant, or '' with the reason.
   Her own clock is the right one here: she agreed the time with the prospect
   in their words, and the database stores the instant. */
function clCallbackAt(day, time, now){
  const d = String(day == null ? '' : day).trim();
  const t = String(time == null ? '' : time).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, iso: '', error: 'Pick a day.' };
  if (!/^\d{2}:\d{2}$/.test(t)) return { ok: false, iso: '', error: 'Pick a time.' };
  const parts = d.split('-').map(Number);
  const hm = t.split(':').map(Number);
  const at = new Date(parts[0], parts[1] - 1, parts[2], hm[0], hm[1], 0, 0);
  if (isNaN(at)) return { ok: false, iso: '', error: 'That day and time did not make sense.' };
  const n = clToDate(now) || new Date();
  if (at - n < -60 * 1000) return { ok: false, iso: '', error: 'That is in the past. Pick a later time.' };
  return { ok: true, iso: at.toISOString(), error: '' };
}

/* What the booking form will send, and what is still missing. The name and
   company come from the lead but she can correct them while she is on the
   phone — the prospect is the one person who knows. */
function clBookProblem(form){
  const f = form || {};
  if (!String(f.start || '').trim()) return 'Pick a time for the call.';
  const bad = clEmailProblem(f.email);
  if (bad) return bad === 'Enter your email address.' ? 'Take their email address.' : 'That email address does not look right.';
  if (!String(f.name || '').trim()) return 'Enter their name.';
  return '';
}

function clOutcome(key){
  const k = String(key == null ? '' : key).trim();
  return CL_OUTCOMES.filter((o) => o.key === k)[0] || null;
}
function clOutcomeLabel(key){
  const o = clOutcome(key);
  return o ? o.label : '';
}

/* ---- HTML builders (pure, everything escaped) ----------------------- */

function clLogoHtml(){
  return `<img class="cl-logo" src="${CL_LOGO}" width="36" height="36" alt="Aviance">`;
}

function clNoticeHtml(title, text, extra){
  return `<main class="cl-notice">${clLogoHtml()}
    <h1 class="cl-h1" tabindex="-1">${clEsc(title)}</h1>
    <p class="cl-lede">${clEsc(text)}</p>${extra || ''}</main>`;
}
function clLoadingHtml(){
  return `<main class="cl-notice" aria-busy="true">${clLogoHtml()}<p class="cl-tag">Loading</p></main>`;
}
function clRetryHtml(){
  return '<p class="cl-row"><button type="button" class="cl-btn" data-cl-retry>Try again</button></p>';
}
function clOfflineHtml(){
  return clNoticeHtml('We could not load your list.', CL_OFFLINE, clRetryHtml());
}
function clNotReadyHtml(message){
  return clNoticeHtml('Not quite ready.', message || CL_NOT_READY, clRetryHtml());
}

/* The sign-in screen. No sign-up, no forgotten-code link, no mention of
   anything else in the hub: the only way in is a code he gave her. */
function clSignInHtml(state){
  const s = state || {};
  return `<main class="cl-notice cl-signin">${clLogoHtml()}
    <h1 class="cl-h1" tabindex="-1">Sign in.</h1>
    <p class="cl-lede">Your calling list for Aviance.</p>
    <form class="cl-form" id="clInForm" novalidate>
      <div class="cl-field">
        <label class="cl-label" for="clInEmail">Email</label>
        <input class="cl-input" id="clInEmail" name="email" type="email" autocomplete="username"
          inputmode="email" autocapitalize="none" spellcheck="false" required value="${clEsc(s.email || '')}">
      </div>
      <div class="cl-field">
        <label class="cl-label" for="clInCode">Access code</label>
        <input class="cl-input cl-code" id="clInCode" name="code" type="password" autocomplete="one-time-code"
          autocapitalize="characters" spellcheck="false" required aria-describedby="clInErr">
        <p class="cl-help">The code ${clEsc(CL_OWNER)} sent you. It stays the same until he changes it.</p>
      </div>
      <p class="cl-err" id="clInErr" role="alert" aria-live="assertive">${clEsc(s.error || '')}</p>
      <button type="submit" class="cl-btn cl-wide" id="clInBtn"${s.busy ? ' disabled' : ''}>${s.busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <p class="cl-small cl-under">No code yet, or it has stopped working? Ask ${clEsc(CL_OWNER)}.</p>
  </main>`;
}

/* The frame: a bar with her tally, the lead, the buttons, the script. Drawn
   once; the parts inside are redrawn on their own as she works. */
function clDiallerHtml(state){
  const s = state || {};
  const name = (s.caller && s.caller.name) || '';
  return `<div class="cl-app">
    <header class="cl-bar"><div class="cl-bar-in">${clLogoHtml()}
      <div class="cl-bar-t">
        <h1>${clEsc(clFirstName(name) || 'Calling')}</h1>
        <p class="cl-tag">Aviance</p>
      </div>
      <div class="cl-tally" id="clTally">${clTallyHtml(s.today)}</div>
      <button type="button" class="cl-btn cl-btn-quiet" id="clOut">Sign out</button>
    </div></header>
    <main class="cl-main">
      <div class="cl-col cl-col-lead">
        <section class="cl-card" id="clLead" aria-live="polite">${clLeadHtml(s.lead, s.now)}</section>
        <p class="cl-err" id="clErr" role="alert" aria-live="assertive">${clEsc(s.error || '')}</p>
        <p class="cl-flash" id="clFlash" aria-live="polite"></p>
        <section id="clActions">${clActionsHtml(s.lead)}</section>
        <div id="clSheet"></div>
      </div>
      <div class="cl-col cl-col-script">${clScriptHtml(CL_SCRIPT)}</div>
    </main>
  </div>`;
}

/* Her own numbers for today, where she can see them without leaving the lead. */
function clTallyHtml(today){
  const t = clTally(today);
  return `<span class="cl-stat"><b>${t.dials}</b><span>dials</span></span>
    <span class="cl-stat cl-stat-win"><b>${t.booked}</b><span>booked</span></span>`;
}

/* The one lead on screen. Nothing else competes with the phone number. */
function clLeadHtml(lead, now){
  const l = clLead(lead);
  if (!l) {
    return `<div class="cl-empty">
      <h2 class="cl-h2">Nothing to ring.</h2>
      <p class="cl-lede">${clEsc(CL_NO_LEADS)}</p>
      <p class="cl-row"><button type="button" class="cl-btn" data-cl-again>Check again</button></p>
    </div>`;
  }
  const tel = clTelHref(l.phone);
  const z = clZoneNow(l.timezone, now);
  const back = clToDate(l.callback_at);
  return `<div class="cl-lead">
    <p class="cl-tag">${l.batch ? clEsc(l.batch) : 'Next call'}</p>
    <h2 class="cl-name">${clEsc(l.name || 'No name on this one')}</h2>
    <p class="cl-company">${clEsc(l.company || '—')}</p>
    ${back ? `<p class="cl-due">Promised a call back: ${clEsc(clDayLabel(back, now))} at ${clEsc(clTime(back))}</p>` : ''}
    ${tel
      ? `<a class="cl-phone" href="${clEsc(tel)}" id="clPhone">${clEsc(clPhoneLabel(l.phone))}</a>`
      : `<p class="cl-phone cl-phone-bad">No usable number</p>`}
    <p class="cl-zone${z.risky ? ' cl-zone-risky' : ''}" id="clZone">${z.risky ? 'Careful: ' : ''}${clEsc(clZoneLine(l.timezone, now))}</p>
    ${l.email ? `<p class="cl-small">${clEsc(l.email)}</p>` : ''}
    ${l.notes ? `<div class="cl-notes"><p class="cl-label">Notes</p><p class="cl-notes-body">${clEsc(l.notes)}</p></div>` : ''}
  </div>`;
}

/* The seven buttons. Five log in one tap; "Call back" and "Booked" open a
   panel first, because they carry something the database needs. */
function clActionsHtml(lead){
  const l = clLead(lead);
  if (!l) return '';
  return `<div class="cl-grid" role="group" aria-label="What happened on the call">
    ${CL_OUTCOMES.map((o) => `<button type="button" class="cl-out cl-out-${o.tone}" data-cl-out="${clEsc(o.key)}"
      aria-keyshortcuts="${clEsc(o.shortcut)}" title="${clEsc(o.label)} (${clEsc(o.shortcut)})">
      <span class="cl-out-k" aria-hidden="true">${clEsc(o.shortcut)}</span>
      <span class="cl-out-l">${clEsc(o.label)}</span></button>`).join('')}
  </div>
  <div class="cl-note-row">
    <label class="cl-label" for="clNote">A note (optional)</label>
    <input class="cl-input" id="clNote" maxlength="${CL_MAX_NOTE}" autocomplete="off"
      placeholder="Anything worth remembering">
  </div>
  <p class="cl-small cl-keys">Keys 1–7 do the same as the buttons.</p>`;
}

/* The callback panel: a day and a time, with the obvious answers one tap away. */
function clCallbackHtml(state){
  const s = state || {};
  const now = clToDate(s.now) || new Date();
  const day = s.day || clDateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const time = s.time || '10:00';
  const quick = [
    { label: 'Later today', day: clDateValue(now), time: ('0' + Math.min(19, now.getHours() + 3)).slice(-2) + ':00' },
    { label: 'Tomorrow morning', day: clDateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)), time: '10:00' },
    { label: 'Tomorrow afternoon', day: clDateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)), time: '15:00' },
    { label: 'In a week', day: clDateValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)), time: '10:00' },
  ];
  return `<section class="cl-sheet" aria-label="When should she ring back">
    <h3 class="cl-h3">When should you ring back?</h3>
    <div class="cl-chips">${quick.map((q) => `<button type="button" class="cl-chip"
      data-cl-quick="${clEsc(q.day)}|${clEsc(q.time)}">${clEsc(q.label)}</button>`).join('')}</div>
    <form class="cl-two" id="clBackForm" novalidate>
      <div class="cl-field">
        <label class="cl-label" for="clBackDay">Day</label>
        <input class="cl-input" id="clBackDay" type="date" required value="${clEsc(day)}" min="${clEsc(clDateValue(now))}">
      </div>
      <div class="cl-field">
        <label class="cl-label" for="clBackTime">Time</label>
        <input class="cl-input" id="clBackTime" type="time" required value="${clEsc(time)}" step="300">
      </div>
      <p class="cl-err" id="clBackErr" role="alert" aria-live="assertive">${clEsc(s.error || '')}</p>
      <div class="cl-sheet-row">
        <button type="button" class="cl-btn cl-btn-quiet" data-cl-close>Back</button>
        <button type="submit" class="cl-btn" id="clBackBtn"${s.busy ? ' disabled' : ''}>${s.busy ? 'Saving…' : 'Save and ring the next one'}</button>
      </div>
    </form>
  </section>`;
}

/* The booking panel: the free times first, then the three things the booking
   needs. She can correct the name and the company; the email is the one thing
   only the prospect can give her. */
function clBookHtml(state){
  const s = state || {};
  const l = clLead(s.lead) || { name: '', company: '', phone: '', email: '', timezone: '' };
  const f = s.form || {};
  const groups = clSlotGroups(s.slots, s.now);
  const chosen = String(f.start || '');
  const their = (iso) => { const t = clTheirTime(iso, l.timezone); return t ? `<span class="cl-chip-their">${clEsc(t)} for them</span>` : ''; };
  const anyTheirs = groups.some((g) => g.slots.some((sl) => !!clTheirTime(sl.iso, l.timezone)));
  let body;
  if (s.loading) {
    body = '<p class="cl-tag">Loading the free times…</p>';
  } else if (s.slotError) {
    body = `<p class="cl-err cl-err-shown">${clEsc(s.slotError)}</p>${clRetryHtml()}`;
  } else if (!groups.length) {
    body = '<p class="cl-lede">There are no free times in the next two weeks. Agree a call back instead and tell ' + clEsc(CL_OWNER) + '.</p>';
  } else {
    body = `<div class="cl-slots">${groups.map((g) => `<div class="cl-slot-day">
      <p class="cl-label">${clEsc(g.label)}</p>
      <div class="cl-chips">${g.slots.map((sl) => `<button type="button"
        class="cl-chip${sl.iso === chosen ? ' cl-chip-on' : ''}" data-cl-slot="${clEsc(sl.iso)}"
        aria-pressed="${sl.iso === chosen ? 'true' : 'false'}">${clEsc(sl.time)}${their(sl.iso)}</button>`).join('')}</div>
    </div>`).join('')}</div>`;
  }
  return `<section class="cl-sheet" aria-label="Book the discovery call">
    <h3 class="cl-h3">Book the call.</h3>
    <p class="cl-small">Read the time back to them before you tap Book.${anyTheirs
      ? ' The small time under each one is the time on their clock, so read them that one.' : ''}</p>
    ${body}
    <form class="cl-two" id="clBookForm" novalidate>
      <div class="cl-field">
        <label class="cl-label" for="clBookEmail">Their email</label>
        <input class="cl-input" id="clBookEmail" type="email" inputmode="email" autocapitalize="none"
          spellcheck="false" autocomplete="off" required value="${clEsc(f.email == null ? l.email : f.email)}">
      </div>
      <div class="cl-field">
        <label class="cl-label" for="clBookName">Their name</label>
        <input class="cl-input" id="clBookName" type="text" autocomplete="off" required
          value="${clEsc(f.name == null ? l.name : f.name)}">
      </div>
      <div class="cl-field">
        <label class="cl-label" for="clBookCompany">Company</label>
        <input class="cl-input" id="clBookCompany" type="text" autocomplete="off"
          value="${clEsc(f.company == null ? l.company : f.company)}">
      </div>
      <p class="cl-err" id="clBookErr" role="alert" aria-live="assertive">${clEsc(s.error || '')}</p>
      <div class="cl-sheet-row">
        <button type="button" class="cl-btn cl-btn-quiet" data-cl-close>Back</button>
        <button type="submit" class="cl-btn cl-btn-win" id="clBookBtn"${s.busy ? ' disabled' : ''}>${s.busy ? 'Booking…' : 'Book it'}</button>
      </div>
    </form>
  </section>`;
}

/* What she sees the moment it is booked, so she can say it out loud. */
function clBookedHtml(booked, now){
  const b = booked || {};
  const at = clToDate(b.starts_at || b.start);
  const who = String(b.name == null ? '' : b.name).trim();
  const theirs = at ? clTheirTime(at, b.timezone) : '';
  return `<section class="cl-sheet cl-sheet-win" aria-label="Booked">
    <h3 class="cl-h3">Booked.</h3>
    <p class="cl-lede">${at ? clEsc(clDayLabel(at, now) + ' at ' + clTime(at)) : 'The time is saved.'}${who ? clEsc(' · ' + who) : ''}</p>
    ${theirs ? `<p class="cl-lede cl-their">${clEsc('On their clock: ' + theirs)}</p>` : ''}
    <p class="cl-small">The invite and the reminders go out on their own. Tell them to look out for it.</p>
    <div class="cl-sheet-row">
      <button type="button" class="cl-btn cl-btn-win cl-wide" data-cl-onwards>Next call</button>
    </div>
  </section>`;
}

/* The script, beside the lead on a wide screen and under it on a phone. Each
   section is a native <details>, so it opens with no JavaScript at all. */
function clScriptHtml(sections){
  const list = Array.isArray(sections) ? sections : [];
  return `<aside class="cl-script" aria-label="The calling script">
    <p class="cl-label">The script</p>
    ${list.map((sec) => `<details class="cl-sec"${sec.open ? ' open' : ''} data-cl-sec="${clEsc(sec.id)}">
      <summary class="cl-sec-h">${clEsc(sec.title)}</summary>
      <div class="cl-sec-b">${(Array.isArray(sec.items) ? sec.items : []).map(clScriptItemHtml).join('')}</div>
    </details>`).join('')}
  </aside>`;
}

function clScriptItemHtml(item){
  const it = item || {};
  const text = clEsc(it.text == null ? '' : it.text);
  if (it.kind === 'note') return `<p class="cl-say-note">${text}</p>`;
  if (it.kind === 'num') return `<p class="cl-say-num">${text}</p>`;
  if (it.kind === 'rule') return `<p class="cl-say-rule">${text}</p>`;
  if (it.kind === 'ask') return `<p class="cl-say-ask"><b>${clEsc(it.term == null ? '' : it.term)}</b> ${text}</p>`;
  return `<p class="cl-say">${text}</p>`;
}

/* ---- plumbing ------------------------------------------------------- */

function clOk(data){ return { ok: true, data, error: '' }; }
function clErr(e){
  let m = (e && (e.message || e.error_description || e.msg || e.error)) || (typeof e === 'string' ? e : '');
  m = String(m || 'Something went wrong. Please try again.');
  const offline = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(m);
  if (offline) m = CL_OFFLINE;
  return { ok: false, data: null, error: m, offline };
}

/* A raw database or auth message is never shown. This turns the ones we can
   expect into something she can act on, and anything unknown into one calm
   sentence. `notReady` marks the ones that mean "the database update is not applied
   yet" or "the database said no", so the page can offer Try again. */
function clSay(raw, fallback){
  const m = String((raw && (raw.message || raw.error)) || raw || '');
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(m)) return CL_OFFLINE;
  if (/invalid login|invalid credentials|credentials|invalid_grant/i.test(m)) return CL_BAD_CODE;
  if (/email not confirmed|user not found|no user/i.test(m)) return CL_NO_ACCOUNT;
  if (/too many|rate limit/i.test(m)) return 'Too many tries. Wait a minute and try again.';
  /* a function that is not there yet, or a policy that says no */
  if (/could not find the function|does not exist|schema cache|42883|pgrst202|pgrst/i.test(m)) return CL_NOT_READY;
  if (/permission denied|row-level security|not authorized|jwt/i.test(m)) return CL_NOT_READY;
  if (/slot|already booked|taken|lock/i.test(m)) return 'That time has just gone. Pick another one.';
  return fallback || 'Something went wrong. Please try again.';
}

/* True when the trouble is "this is not switched on yet" rather than something
   she typed. The page shows a notice with Try again for these. */
function clIsNotReady(message){
  return String(message || '') === CL_NOT_READY;
}

/* One client, her own storage key, so her login and the owner's hub login (and
   an employee's /team login) never tread on each other. detectSessionInUrl is
   off: nothing about a login belongs in the address bar of this page. */
let clTheClient = null;
function clClient(){
  if (clTheClient) return clTheClient;
  if (typeof window === 'undefined' || !window.supabase || !window.supabase.createClient) return null;
  try {
    clTheClient = window.supabase.createClient(CL_URL, CL_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'aviance-caller-auth' },
    });
  } catch (e) { return null; }
  return clTheClient;
}
/* Tests (and nothing else) hand in a fake client. */
function clUseClient(client){ clTheClient = client; }

async function clRpc(name, args){
  const sb = clClient();
  if (!sb) return clErr(CL_OFFLINE);
  try {
    const res = await sb.rpc(name, args || {});
    if (!res) return clErr('No answer from Aviance.');
    if (res.error) { const r = clErr(res.error); r.error = clSay(res.error, r.error); return r; }
    return clOk(res.data === undefined ? null : res.data);
  } catch (e) {
    // An unexpected throw has no sentence of its own, so don't pass its raw text on as the fallback.
    const r = clErr(e); r.error = clSay(e, ''); return r;
  }
}

/* ---- the login ------------------------------------------------------ */

/* The code IS the Supabase password. She never hears that word. */
async function clSignIn(email, code){
  const sb = clClient();
  if (!sb) return clErr(CL_OFFLINE);
  const e = String(email == null ? '' : email).trim();
  const bad = clEmailProblem(e) || clCodeProblem(code);
  if (bad) return clErr(bad);
  try {
    const res = await sb.auth.signInWithPassword({ email: e, password: clCleanCode(code) });
    if (res && res.error) { const r = clErr(res.error); r.error = clSay(res.error, CL_BAD_CODE); return r; }
    return clOk((res && res.data && res.data.session) || null);
  } catch (err) { const r = clErr(err); r.error = clSay(err, CL_BAD_CODE); return r; }
}

async function clSignOut(){
  const sb = clClient();
  if (!sb) return clOk(null);
  try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* signed out here either way */ }
  return clOk(null);
}

async function clSession(){
  const sb = clClient();
  if (!sb) return clErr(CL_OFFLINE);
  try {
    const res = await sb.auth.getSession();
    if (res && res.error) return clErr(res.error);
    return clOk(res && res.data ? res.data.session : null);
  } catch (e) { return clErr(e); }
}

/* ---- the one-click invite link --------------------------------------
   The owner sends her one URL. The link checker (the caller-link function)
   makes sure the invite is real and unexpired, then bounces her here with a
   one-time sign-in token in the fragment: #k=...

   A fragment, never a query string, because fragments are not sent to any
   server or written into server logs. We swap it for a session and wipe it
   from the address bar in the same breath, so a screenshot of her screen or a
   glance at her history gives nothing away. The token is good for one use. */
/* ---8<--- link-claim: the only place this page touches the address bar ---8<---
   It reads the fragment, swaps it for a session and clears it. Nothing here
   navigates anywhere: there is still no way off this page. The test in
   tests/caller-page.test.mjs cuts this block out and then checks that the rest
   of the file cannot read or change where the browser is. */
const CL_LINK_BAD = 'That link has already been used or has run out. Ask Aviance for a new one, or sign in with your code below.';
const CL_LINK_SAY = {
  expired: 'That link has run out. Ask Aviance for a new one, or sign in with your code below.',
  bad: CL_LINK_BAD,
  team: 'That link belongs to an Aviance account, not a caller login.',
  email: 'There is no email address on your record yet. Ask Aviance to add one.',
  again: 'Something went wrong opening that link. Try it once more, or sign in with your code below.',
  method: CL_LINK_BAD,
};

function clLinkToken(){
  if (typeof window === 'undefined' || !window.location) return '';
  const m = /[#&]k=([^&]+)/.exec(String(window.location.hash || ''));
  if (!m) return '';
  let t = m[1];
  try { t = decodeURIComponent(m[1]); } catch (e) { /* take it as it came */ }
  return String(t).trim();
}

/* Take the token out of the address bar without reloading the page. */
function clForgetLinkToken(){
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
function clLinkProblem(){
  if (typeof window === 'undefined' || !window.location) return '';
  const m = /[?&]link=([^&]+)/.exec(String(window.location.search || ''));
  if (!m) return '';
  let why = m[1];
  try { why = decodeURIComponent(m[1]); } catch (e) { /* as it came */ }
  return Object.prototype.hasOwnProperty.call(CL_LINK_SAY, String(why)) ? CL_LINK_SAY[String(why)] : CL_LINK_BAD;
}

/* Returns a session when the link worked, null when there was no link at all. */
async function clClaimLink(){
  const token = clLinkToken();
  if (!token) return clOk(null);
  clForgetLinkToken();
  const sb = clClient();
  if (!sb) return clErr(CL_OFFLINE);
  if (!sb.auth || typeof sb.auth.verifyOtp !== 'function') return clErr(CL_LINK_BAD);
  try {
    const res = await sb.auth.verifyOtp({ token_hash: token, type: 'email' });
    if (res && res.error) { const r = clErr(res.error); r.error = clSay(res.error, CL_LINK_BAD); return r; }
    const session = (res && res.data && res.data.session) || null;
    if (!session) return clErr(CL_LINK_BAD);
    return clOk(session);
  } catch (e) { const r = clErr(e); r.error = clSay(e, CL_LINK_BAD); return r; }
}
/* ---8<--- end link-claim ---8<--- */

/* Tells the page when the login ends (he revoked it, or it ran out). */
function clOnSignedOut(fn){
  const sb = clClient();
  if (!sb || !sb.auth || !sb.auth.onAuthStateChange) return;
  try {
    sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { try { fn(); } catch (e) { /* the page's problem */ } } });
  } catch (e) { /* no listener: the poll still notices */ }
}

/* ---- her calling list ----------------------------------------------- */

/* Everything her screen needs, in one call. A reply without a caller means
   this login is not a caller's, which is not an error to shout about. */
async function clMe(){
  const r = await clRpc('caller_me', {});
  if (!r.ok) return r;
  const d = r.data;
  if (!d || typeof d !== 'object' || !(d.caller && d.caller.id)) return clOk(null);
  return clOk({
    caller: { id: String(d.caller.id), name: String(d.caller.name == null ? '' : d.caller.name) },
    today: clTally(d.today),
    lead: clLead(d.lead),
    script_url: String(d.script_url == null ? '' : d.script_url),
  });
}

/* The next lead on its own, for the "Check again" button. null means the list
   is empty right now, not that something broke. */
async function clNext(){
  const r = await clRpc('caller_next', {});
  if (!r.ok) return r;
  return clOk(clLead(r.data && r.data.lead ? r.data.lead : r.data));
}

/* One outcome, one note, and the next lead in the same answer — the whole
   point of the screen. `callback` only travels with the callback outcome. */
async function clLog(leadId, outcome, note, callbackAt){
  const id = String(leadId == null ? '' : leadId).trim();
  const o = clOutcome(outcome);
  if (!id) return clErr('There is no call to log.');
  if (!o) return clErr('That is not one of the seven outcomes.');
  const r = await clRpc('caller_log', {
    p_lead: id,
    p_outcome: o.key,
    p_note: clCleanNote(note) || null,
    p_callback: o.key === 'callback' ? (String(callbackAt || '').trim() || null) : null,
  });
  if (!r.ok) { if (!clIsNotReady(r.error)) r.error = 'That did not save. ' + r.error; return r; }
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  return clOk({ next: clLead(d.next != null ? d.next : d.lead) });
}

/* The free discovery-call times. Always an array, so the picker never has to
   wonder. */
async function clSlots(days){
  const n = Number(days) > 0 ? Math.round(Number(days)) : CL_SLOT_DAYS;
  const r = await clRpc('caller_slots', { p_days: n });
  if (!r.ok) return r;
  const d = r.data;
  const list = Array.isArray(d) ? d : (d && Array.isArray(d.slots) ? d.slots : []);
  return clOk(list);
}

/* The real booking path: the database inserts the row the website would, so
   the confirmation email and the reminders go out by themselves. */
async function clBook(form){
  const f = form || {};
  const bad = clBookProblem(f);
  if (bad) return clErr(bad);
  const r = await clRpc('caller_book', {
    p_lead: String(f.lead_id == null ? '' : f.lead_id).trim(),
    p_start: String(f.start).trim(),
    p_name: String(f.name).trim(),
    p_email: String(f.email).trim(),
    p_company: String(f.company == null ? '' : f.company).trim() || null,
    p_phone: String(f.phone == null ? '' : f.phone).trim() || null,
    p_timezone: String(f.timezone == null ? '' : f.timezone).trim() || null,
  });
  if (!r.ok) { if (!clIsNotReady(r.error)) r.error = 'That did not book. ' + r.error; return r; }
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  if (!d.booking_id && !d.starts_at) return clErr('That did not book. Try the next free time.');
  return clOk({
    booking_id: String(d.booking_id == null ? '' : d.booking_id),
    starts_at: d.starts_at || d.start || String(f.start),
    name: String(f.name).trim(),
    timezone: String(f.timezone == null ? '' : f.timezone).trim(),
  });
}
