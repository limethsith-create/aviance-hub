/* core.js — the handful of helpers every screen shares.
 *
 * WHY THIS FILE EXISTS
 * Every screen file used to carry its own copy of the same six or seven
 * helpers: the {ok,data,error} result, the HTML escape, "$3,000", a day key.
 * Fifteen copies of one function means a fix in one is not a fix in the other
 * fourteen, and they had already drifted apart — three escapers protected the
 * single quote and three did not, and two day keys disagreed about what day a
 * date-only value falls on, which on a month boundary is a refund.
 *
 * So: ONE implementation of each lives here, and every file's own name for it
 * (fnOk, cbEsc, mtWrap …) is a one-line alias to the one below. The house
 * convention of one prefix per file is untouched; only the body moved.
 *
 * RULES FOR THIS FILE
 * - It loads FIRST on every page (index.html, portal.html, team.html,
 *   doc.html, join.html). Nothing here may read a hub global, touch the
 *   database, or know what a client is. Leaf code only.
 * - Everything is a `function` declaration or a `var`, never `const`, so that
 *   a test can run this file into a context twice without a redeclaration
 *   error.
 * - Nothing here throws. A bad argument comes back as '' or null, never an
 *   exception on a screen.
 */

/* ===================== 1. THE RESULT ({ok, data, error}) =====================
   Every data function in the hub returns {ok, data, error} and never throws;
   `error` is plain words a person can read. These three build that shape. */

/* A good answer. */
function coreOk(data){ return {ok:true, data, error:''} }

/* The raw sentence inside whatever a failure arrived as — a thrown Error, a
   Supabase error object, or a bare string. RAW: this is the database's own
   words, so nothing shows this to a person. Two files (journey.js, settings.js)
   want the raw text because they reword it themselves, in wording specific to
   their screen; everything else goes through coreErrText below. */
function coreRawText(e){
  var m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  /* A failure must always say something. Every copy of this helper had one gap:
     a truthy value whose String() is empty (an empty array is the one that can
     actually arrive, from a rejected batch) came out as '', and a screen then
     showed a blank where the reason should be. */
  return String(m).trim() ? String(m) : 'Something went wrong.';
}

/* ---- what a failure says to the OWNER -----------------------------------
   The house rule is that `error` is plain words a person can read. Twelve
   screens used to hand the owner whatever Postgres said — `relation "x" does
   not exist`, a constraint name, `[object Object]`, a bare `404` — so the one
   line he actually needed ("you are signed out", "free a seat") was buried in
   plumbing. corePlain is the one place that decides, and coreErrText routes
   every screen's xxErr through it.

   This is the OWNER's edge, and it is deliberately more generous than the
   client's (pcPlain in portal-client.js). The owner runs the business and can
   act on the difference between "the database update has not been applied" and
   "the rule said no", so those stay two sentences here where the client gets
   one. He still never sees a code, a relation, a constraint or a stack: those
   tell him nothing he can use and they are how another client's table name or
   a SQL fragment would reach a screen.

   What always survives, untouched:
   - code P0001. That is our own plpgsql `raise exception` — written for a
     person on purpose. The seat limit ("…comes with 2 portal logins, and they
     are all taken. Free one under 'Who can sign in'…"), the locked month and
     the retired plan all speak to the owner through it, and they are the most
     useful sentences in the system. Flattening them would be a real loss.
   - a refusal that already reads as a sentence, whatever code it carries. Some
     of our rules raise plain words under errcode 42501 ("You have not been
     given this client's prospects.") — better than any generic we could write,
     so permission is matched on the WORDS Postgres uses, never on the code. */
var CORE_OFFLINE    = "Can't reach the server right now. Check your connection and try again.";
var CORE_SIGNED_OUT = 'Your sign-in has run out. Please sign in again.';
var CORE_NO_ACCESS  = "You don't have access to do that.";
var CORE_NOT_READY  = "That part isn't switched on yet. Try again once the database update is applied.";
var CORE_ALREADY    = 'That is already there, so nothing was added.';
var CORE_WAIT       = 'Something went wrong at our end. Nothing has been lost. Try again in a moment.';
var CORE_SAY = { offline: CORE_OFFLINE, 'signed-out': CORE_SIGNED_OUT, 'no-access': CORE_NO_ACCESS,
                 'not-ready': CORE_NOT_READY, already: CORE_ALREADY, wait: CORE_WAIT };
/* The longest sentence we write ourselves is the seat-limit one, at 194
   characters. Past 400 it is not a sentence, it is a dump. */
var CORE_MAX_SAY = 400;

/* Which KIND of failure this is — one of:
     'offline'   the connection, not us
     'signed-out' the login has run out
     'no-access' a rule said no
     'not-ready' a function or table this database does not have yet
     'already'   it was there before this tried to add it
     'wait'      something in the machine room, which tells a person nothing
     'said'      words already written for a person; show them as they are
   A few screens have a better sentence of their own for one kind ("They already
   have that client", "Calendar connecting is not switched on yet"), so the
   deciding happens here, once, and they ask this rather than re-reading the
   database's wording themselves. It answers the same for the raw text and for
   the sentence corePlain returns, so it does not matter which one a caller is
   holding by the time it asks. */
function coreFamily(m, code){
  var s = String(m == null ? '' : m).trim(), c = String(code == null ? '' : code);
  /* nothing, or the shape of a value that was never a message */
  if (!s || /^(undefined|null|nan|error|\[object [a-z]+\]|\{\}|\[\])$/i.test(s)) return 'wait';
  /* the connection, first: it is the one failure where trying again is the fix */
  if (s === CORE_OFFLINE ||
      /failed to fetch|networkerror|network request|load failed|fetch failed|failed to send a request|socket|timeout|timed out|err_internet|offline|could not connect|connection (error|refused|reset|closed|terminated)/i.test(s)) return 'offline';
  /* ours, written for a person already */
  if (c === 'P0001') return 'said';
  if (s === CORE_SIGNED_OUT || c === 'PGRST301' ||
      /jwt|not authenticated|invalid.*session|session.*expired|refresh token|token (has )?(expired|is invalid)/i.test(s)) return 'signed-out';
  if (s === CORE_NOT_READY || c === 'PGRST202' || c === '42883' || c === '42P01' ||
      /could not find the (function|table)|schema cache|does not exist|undefined function|bucket not found/i.test(s)) return 'not-ready';
  /* a rule said no — matched on Postgres's own words, never on the code, because
     some of our own rules raise plain words under errcode 42501 and those are
     better than any generic we could write */
  if (s === CORE_NO_ACCESS ||
      /permission denied|row-level security|not authorized|unauthorized|insufficient privilege/i.test(s)) return 'no-access';
  if (s === CORE_ALREADY || /duplicate key|unique constraint|already exists/i.test(s)) return 'already';
  if (s === CORE_WAIT) return 'wait';
  /* anything that smells of the machine room: a relation or constraint name, a
     stack, a bare HTTP status, a SQL fragment */
  if (/^\s*\d{3}\s*$|\bPGRST\d+\b|relation "|column "|constraint|violates|syntax error|invalid input syntax|rows? returned|results contain \d+ rows|application\/|api key|value too long|character varying|out of range for type|cannot be cast|resource was not found|^no rows$|\bpg_|\n\s*at |function public\.|::(text|uuid|jsonb|int)|\b(select |insert into |update .* set |delete from )/i.test(s)) return 'wait';
  /* a bare SQLSTATE (23505, 42P01 …) with no code field beside it. Case matters
     here: /i on a five-character class would swallow any five-letter word, and
     "Write something first." is not a database code. */
  if (/\b(?:\d\d[\dA-Z]{3}|P\d{4})\b/.test(s)) return 'wait';
  if (s.length > CORE_MAX_SAY) return 'wait';
  return 'said';
}

function corePlain(m, code){
  var f = coreFamily(m, code);
  return f === 'said' ? String(m == null ? '' : m).trim() : CORE_SAY[f];
}

/* The sentence a screen may show: the raw text, said in plain words. */
function coreErrText(e){ return corePlain(coreRawText(e), e && e.code) }

/* A failure, said in words. */
function coreErr(e){ return {ok:false, data:null, error:coreErrText(e)} }

/* A Supabase answer turned into a result. `whenEmpty` is what stands in for a
   query that found nothing, so a screen gets [] or null rather than undefined.
   `errFn` lets a file that rewords database messages for the owner (journey.js,
   settings.js) keep doing that; `noAnswer` lets it keep its own wording for a
   query that came back with nothing at all. */
function coreWrap(res, whenEmpty, errFn, noAnswer){
  var fail = typeof errFn === 'function' ? errFn : coreErr;
  if (!res) return fail(noAnswer || 'No answer from the database.');
  if (res.error) return fail(res.error);
  return coreOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}

/* ===================== 2. ESCAPING =====================
   ONE escape, the strict one, everywhere — including the global `esc` in
   index.html, which is an alias of this.

   It protects five characters, the single quote among them. Six copies of this
   used to exist and three of them left `'` alone, which is fine right up until
   somebody writes attr='${…}' in a template and nothing warns them. Protecting
   the quote costs nothing and closes that door for good.

   This is for TEXT and for a double-quoted attribute. It is not a way to put a
   value inside a JavaScript string — for that use coreAttr below, which turns
   the value into a JSON literal first. */
function coreEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* A value safe to drop inside onclick="…" as a JavaScript string: JSON first,
   so quotes and backslashes inside it cannot end the string, then escaped so
   they cannot end the attribute. */
function coreAttr(v){ return coreEsc(JSON.stringify(v == null ? '' : String(v))) }

/* ===================== 3. MONEY =====================
   '$3,000'. Whole dollars, grouped, en-US — the owner's screens never show
   cents, because every price the owner sets is a whole number of dollars and a
   trailing '.00' on every figure is noise he has to read past.

   A figure that is not a number at all reads '$0' rather than '$NaN' or
   '$Infinity': a screen that cannot say what something costs must not say
   something impossible.

   This is NOT the money on a client's invoice. That one (pcMoney in
   portal-client.js) shows cents and the invoice's own currency, on purpose —
   see the note there. */
function coreUsd(v){
  var n = Number(v);
  return '$' + (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US');
}

/* ===================== 4. DAYS, DATES AND TIMES =====================
   The careful part of this file.

   This system books calls across time zones and settles its guarantee on month
   boundaries, so a day key that is one day out is a refund paid that should not
   have been, or not paid when it should. Two copies of the day key had already
   drifted: one read a date-only value as a local calendar day, the other handed
   it to `new Date()`, which reads it as UTC midnight and so shows the day before
   it anywhere behind UTC. The first is right, and is what is here.

   The rule: a value with no time in it ('2026-11-24') is a CALENDAR DAY and must
   mean that day wherever the reader is sitting. A value with a time in it is a
   MOMENT, and is shown in the reader's own zone. Nothing here guesses a zone. */

/* A value -> a Date, or null. Never an Invalid Date, which renders as 'NaN'. */
function coreToDate(v){
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  /* date-only: built in the local calendar, so the day cannot slide */
  var d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/* A Date or a value -> 'YYYY-MM-DD' in the reader's own calendar, or ''.
   Zero-padded, so the keys of a year sort as text in calendar order: an unpadded
   key still compares equal to itself, but sorting a list of them puts '2026-9-1'
   after '2026-10-1', which is how "the latest day" lands on the wrong day. */
function corePad2(n){ return (n < 10 ? '0' : '') + n }
function coreDayKey(v){
  var d = coreToDate(v);
  return d ? d.getFullYear() + '-' + corePad2(d.getMonth() + 1) + '-' + corePad2(d.getDate()) : '';
}

/* Today's key, or the key of a moment handed in. For the files that ask "what is
   today, as the database writes a date". */
function coreTodayKey(now){ return coreDayKey(now == null ? new Date() : now) }

/* '09:05' — a 24-hour clock reading in the reader's own zone, or ''. */
function coreHm(v){
  var d = coreToDate(v);
  return d ? corePad2(d.getHours()) + ':' + corePad2(d.getMinutes()) : '';
}

/* A clock reading in the reader's own style ('2:05 PM', '14:05') where the
   browser knows it, and the 24-hour one where it does not. */
function coreTime(v){
  var d = coreToDate(v);
  if (!d) return '';
  try {
    var s = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (s && !/invalid/i.test(s)) return s;
  } catch (e) { /* fall through */ }
  return coreHm(d);
}

/* 'just now' / '5 min ago' / '3 hours ago' / '2 days ago'.
   `whenUnknown` is the caller's own word for a time we do not have — '' in a chat
   row, 'never' under a team member's name — because those read very differently.
   A time in the future reads 'just now': two clocks disagreeing by a minute is
   not something to show a person as 'in -1 minutes'. */
function coreAgo(v, whenUnknown, now){
  var d = coreToDate(v);
  if (!d) return whenUnknown == null ? '' : whenUnknown;
  var m = Math.max(0, Math.round(((now == null ? Date.now() : now) - d.getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  var h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  var day = Math.round(h / 24);
  return day + (day === 1 ? ' day ago' : ' days ago');
}
