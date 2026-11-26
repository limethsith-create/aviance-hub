/* Tests for caller-page.js + callers.html — the cold caller's own screen at
   aviance.store/callers.

   Run with: npm test. No browser and no network: caller-page.js runs in a vm
   and is handed a fake Supabase client (clUseClient) that records every rpc
   and answers what the test says. The HTML builders are pure, so most of this
   file is plain string checks.

   What is checked hardest:
     1. the seven outcome buttons — each logs its own value, nothing else can
        be logged, and the next lead comes back in the same answer;
     2. "call back" cannot be logged without a time, and "booked" cannot be
        sent without an email;
     3. every lead field (company, name, notes, phone, timezone) escaped — a
        lead comes from a CSV a stranger made, by way of the owner's upload;
     4. callers.html carries no link, script or word pointing at the rest of
        the hub, and loads only its own files;
     5. it degrades politely before the migration is applied. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(root, 'callers.html'), 'utf8');

/* ───────────── a fake Supabase: one rpc log, answers the test sets ───────────── */

let calls;                 // every rpc and every auth call, in order
let rpcs;                  // name -> (args) => {data, error}  (or an Error to throw)
let authAnswer;            // what signInWithPassword says
let sessionAnswer;
let otpAnswer;             // what verifyOtp says when a one-click link is spent

const fakeSb = {
  from() { throw new Error('the caller page must never touch a table directly'); },
  async rpc(name, args) {
    calls.push({ rpc: name, args });
    const h = rpcs[name];
    if (h instanceof Error) throw h;
    return h ? h(args) : { data: null, error: null };
  },
  auth: {
    async signInWithPassword(p) { calls.push({ signIn: p }); if (authAnswer instanceof Error) throw authAnswer; return authAnswer; },
    async signOut(o) { calls.push({ signOut: o }); return {}; },
    async getSession() { calls.push({ getSession: 1 }); return sessionAnswer; },
    async verifyOtp(p) { calls.push({ verifyOtp: p }); if (otpAnswer instanceof Error) throw otpAnswer; return otpAnswer; },
    onAuthStateChange(fn) { calls.push({ listen: 1 }); return { data: { subscription: { unsubscribe() {} } } }; },
  },
};

const sandbox = {
  console, Date, Number, Math, Promise, Array, String, Boolean, Object, JSON, RegExp, Error, isFinite, Intl,
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: { hidden: false, getElementById: () => null, addEventListener() {} },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const SRC = fs.readFileSync(path.join(root, 'caller-page.js'), 'utf8');
vm.runInContext(SRC + `
;globalThis.api={clEsc,clEmailProblem,clCodeProblem,clCleanCode,clCleanNote,clToDate,clDayKey,
  clTime,clDayLabel,clDateValue,clZoneNow,clZoneLine,clTelHref,clPhoneLabel,clFirstName,clLead,
  clTally,clSlotGroups,clCallbackAt,clBookProblem,clOutcome,clOutcomeLabel,clLogoHtml,
  clNoticeHtml,clLoadingHtml,clRetryHtml,clOfflineHtml,clNotReadyHtml,clSignInHtml,clDiallerHtml,
  clTallyHtml,clLeadHtml,clActionsHtml,clCallbackHtml,clBookHtml,clBookedHtml,clScriptHtml,
  clScriptItemHtml,clOk,clErr,clSay,clIsNotReady,clUseClient,clRpc,clSignIn,clSignOut,clSession,
  clOnSignedOut,clMe,clNext,clLog,clSlots,clBook,
  clLinkToken,clForgetLinkToken,clLinkProblem,clClaimLink,CL_LINK_BAD,clTheirTime,
  CL_OUTCOMES,CL_SCRIPT,CL_OWNER,CL_URL,CL_KEY,CL_OFFLINE,CL_BAD_CODE,CL_NO_ACCOUNT,
  CL_NOT_READY,CL_NO_LEADS,CL_MAX_NOTE,CL_SLOT_DAYS};`,
  sandbox, { filename: 'caller-page.js' });
const A = sandbox.api;

const plain = (x) => JSON.parse(JSON.stringify(x));
const KEYS = ['no_answer', 'voicemail', 'not_interested', 'wrong_number', 'bad_fit', 'callback', 'booked'];

function reset() {
  calls = []; rpcs = {};
  authAnswer = { data: { session: { access_token: 'hers' } }, error: null };
  sessionAnswer = { data: { session: null }, error: null };
  otpAnswer = { data: { session: { access_token: 'fromlink', user: { email: 'nour@example.com' } } }, error: null };
  delete sandbox.location; delete sandbox.history;
  A.clUseClient(fakeSb);
}

/* The address bar, as the browser would hand it to her. */
function atUrl(hash, search) {
  sandbox.location = { pathname: '/callers', search: search || '', hash: hash || '' };
  sandbox.history = { replaceState(a, b, url) { calls.push({ replaced: url }); sandbox.location.hash = ''; } };
}

/* a lead as a stranger's CSV would really write it */
const NASTY_CO = 'Stone "Steve" <b>Roofing</b> & Sons';
const LEAD = (over) => Object.assign({
  id: 'l1', company: NASTY_CO, name: 'Steve <img src=x onerror=alert(1)>',
  phone: '+20 100 555 0101', email: 'steve@stone.example', timezone: 'Africa/Cairo',
  notes: '<script>alert(1)</script> rang twice, "ask for Steve"',
  callback_at: '', outcome: '', batch: 'Egypt list <b>1</b>',
}, over || {});
const NEXT = (over) => Object.assign({ id: 'l2', company: 'Birch Legal', name: 'Hana', phone: '0100 555 0102' }, over || {});

/* ═════════════════════════ 0. THE ONE-CLICK INVITE LINK ═════════════════════════
   The owner sends her one URL. The caller-link function checks the invite and bounces
   her here with a one-time sign-in token in the fragment. These pin the three things
   that must hold: the token is read, it is spent, and it leaves the address bar. */

test('a one-click link signs her in and is wiped from the address bar', async () => {
  reset();
  atUrl('#k=one-time-token-abc');
  assert.equal(A.clLinkToken(), 'one-time-token-abc', 'the token is read out of the fragment');

  const r = await A.clClaimLink();
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.data.access_token, 'fromlink', 'she comes back with a session, not a code prompt');

  const otp = calls.find((c) => c.verifyOtp);
  assert.deepEqual(plain(otp.verifyOtp), { token_hash: 'one-time-token-abc', type: 'email' });
  assert.ok(calls.some((c) => c.replaced === '/callers'), 'the token is taken out of the address bar at once');
  assert.equal(sandbox.location.hash, '', 'and the fragment is empty afterwards');
});

test('a percent-encoded token is decoded, and junk around it is ignored', async () => {
  reset();
  atUrl('#k=a%2Bb%2Fc%3D%3D&other=1');
  assert.equal(A.clLinkToken(), 'a+b/c==');
  reset();
  atUrl('#nothing=here');
  assert.equal(A.clLinkToken(), '', 'no token means no token');
  const none = await A.clClaimLink();
  assert.equal(none.ok, true);
  assert.equal(none.data, null, 'with no link in the bar she just sees the normal sign-in');
  assert.equal(calls.filter((c) => c.verifyOtp).length, 0, 'and nothing is spent');
});

test('a used or expired link says so in her words, and never shows the plumbing', async () => {
  reset();
  atUrl('#k=stale-token');
  otpAnswer = { data: { session: null }, error: { message: 'Token has expired or is invalid' } };
  const r = await A.clClaimLink();
  assert.equal(r.ok, false);
  assert.match(r.error, /already been used or has run out/);
  assert.match(r.error, /sign in with your code below/, 'she is always told what to do instead');
  assert.equal(r.error.toLowerCase().indexOf('token'), -1, 'no word of tokens or otp');
  assert.ok(calls.some((c) => c.replaced === '/callers'), 'a bad token is wiped too');

  // a session that comes back empty is a failure, not a silent pass
  reset(); atUrl('#k=empty-token');
  otpAnswer = { data: { session: null }, error: null };
  assert.equal((await A.clClaimLink()).ok, false);
});

test('the link checker can also turn her away before she gets here', () => {
  reset();
  atUrl('', '?link=expired');
  assert.match(A.clLinkProblem(), /run out/);
  reset(); atUrl('', '?link=team');
  assert.match(A.clLinkProblem(), /Aviance account/);
  reset(); atUrl('', '?link=made-up-reason');
  assert.equal(A.clLinkProblem(), A.CL_LINK_BAD, 'anything we do not recognise reads as a dead link');
  reset(); atUrl('', '');
  assert.equal(A.clLinkProblem(), '', 'and nothing is said when she simply opened the page');
  // a reason that happens to be the name of something built in is still just an unknown reason
  for (const odd of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    reset(); atUrl('', '?link=' + odd);
    assert.equal(A.clLinkProblem(), A.CL_LINK_BAD, odd + ' must read as a dead link, not as code');
  }
});

test('without a browser around, the link code stays quiet instead of throwing', async () => {
  reset();                                  // no location, no history in the sandbox
  assert.equal(A.clLinkToken(), '');
  assert.equal(A.clLinkProblem(), '');
  A.clForgetLinkToken();                    // must not throw
  const r = await A.clClaimLink();
  assert.equal(r.ok, true);
  assert.equal(r.data, null);
});

/* ═════════════════════════ 1. THE SEVEN OUTCOME BUTTONS ═════════════════════════ */

test('there are exactly seven outcomes, with the seven names the database accepts', () => {
  reset();
  assert.equal(A.CL_OUTCOMES.length, 7);
  assert.deepEqual(plain(A.CL_OUTCOMES).map((o) => o.key).slice().sort(),
    ['bad_fit', 'booked', 'callback', 'no_answer', 'not_interested', 'voicemail', 'wrong_number']);
  // every one has its own word and its own key on the keyboard
  const labels = plain(A.CL_OUTCOMES).map((o) => o.label);
  assert.equal(new Set(labels).size, 7, 'no two buttons say the same thing');
  assert.deepEqual(plain(A.CL_OUTCOMES).map((o) => o.shortcut), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(A.clOutcome('made_up'), null, 'an outcome outside the seven does not exist here');
  assert.equal(A.clOutcomeLabel('made_up'), '');

  // and all seven are on the screen, each with its label and its shortcut
  const html = A.clActionsHtml(LEAD());
  KEYS.forEach((k) => {
    assert.match(html, new RegExp('data-cl-out="' + k + '"'), k + ' has a button');
    assert.match(html, new RegExp('>' + A.clOutcomeLabel(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<'), k + ' says what it is');
  });
  assert.match(html, /Keys 1–7 do the same as the buttons/);
  assert.match(html, /id="clNote"/, 'and there is one note box beside them');
  assert.equal(A.clActionsHtml(null), '', 'no lead, no buttons to press by mistake');
});

test('each of the seven logs its own value, and nothing else can be logged', async () => {
  for (const key of KEYS) {
    reset();
    rpcs.caller_log = () => ({ data: { ok: true, next: NEXT() }, error: null });
    const r = await A.clLog('l1', key, 'she said no', key === 'callback' ? '2026-11-27T10:00:00.000Z' : null);
    assert.equal(r.ok, true, key + ' logged: ' + r.error);
    const sent = calls.filter((c) => c.rpc === 'caller_log');
    assert.equal(sent.length, 1, key + ' is one call, not two');
    assert.equal(sent[0].args.p_lead, 'l1');
    assert.equal(sent[0].args.p_outcome, key, 'the value sent is the outcome she tapped');
    assert.equal(sent[0].args.p_note, 'she said no');
    // the callback time travels with 'callback' and with nothing else
    assert.equal(sent[0].args.p_callback, key === 'callback' ? '2026-11-27T10:00:00.000Z' : null,
      key + ' carries a callback time only if it is a callback');
    // and the next lead comes back in the same answer, so one tap is one round trip
    assert.equal(r.data.next.id, 'l2', key + ' brings up the next lead');
  }

  // an outcome the database would refuse never leaves the page
  reset();
  for (const bad of ['', 'answered', 'BOOKED', 'no-answer', 'callback;drop table', null, undefined, 'drop table', 0, {}]) {
    const r = await A.clLog('l1', bad, '', null);
    assert.equal(r.ok, false, JSON.stringify(bad) + ' is refused');
    assert.match(r.error, /not one of the seven outcomes/);
  }
  assert.equal(calls.length, 0, 'not one of them reached the database');

  // a stray space is tidied up rather than refused, and the canonical word is what is sent
  reset();
  rpcs.caller_log = () => ({ data: { next: null }, error: null });
  assert.equal((await A.clLog('l1', ' booked ', '', null)).ok, true);
  assert.equal(calls[0].args.p_outcome, 'booked', 'the database only ever sees one of the seven exactly');

  // and neither does a log with no lead
  reset();
  const noLead = await A.clLog('', 'no_answer', '', null);
  assert.equal(noLead.ok, false);
  assert.match(noLead.error, /no call to log/);
  assert.equal(calls.length, 0, 'no lead, no call');
});

test('the next lead appears after each outcome, and an empty list is a calm screen', async () => {
  reset();
  rpcs.caller_log = () => ({ data: { ok: true, next: NEXT() }, error: null });
  let r = await A.clLog('l1', 'no_answer', '', null);
  assert.equal(r.data.next.company, 'Birch Legal');
  assert.match(A.clLeadHtml(r.data.next, new Date()), /Birch Legal/);

  // the list has run dry: next is null, which is not an error
  rpcs.caller_log = () => ({ data: { ok: true, next: null }, error: null });
  r = await A.clLog('l1', 'voicemail', '', null);
  assert.equal(r.ok, true);
  assert.equal(r.data.next, null);
  const empty = A.clLeadHtml(null, new Date());
  assert.match(empty, /Nothing to ring/);
  assert.match(empty, /data-cl-again/, 'with one button to look again');
  assert.doesNotMatch(empty, /error|failed/i, 'an empty list is not dressed up as a failure');

  // caller_next on its own, however the database wraps it
  reset();
  rpcs.caller_next = () => ({ data: { lead: NEXT() }, error: null });
  assert.equal((await A.clNext()).data.id, 'l2');
  rpcs.caller_next = () => ({ data: NEXT({ id: 'l3' }), error: null });
  assert.equal((await A.clNext()).data.id, 'l3', 'a bare lead works too');
  rpcs.caller_next = () => ({ data: null, error: null });
  const none = await A.clNext();
  assert.equal(none.ok, true);
  assert.equal(none.data, null);
});

test('a failed log says so and does not pretend the call was saved', async () => {
  reset();
  rpcs.caller_log = () => ({ data: null, error: { message: 'That lead is not yours.' } });
  const r = await A.clLog('l1', 'no_answer', '', null);
  assert.equal(r.ok, false);
  assert.match(r.error, /did not save/);
  assert.equal(r.data, null, 'and no next lead is invented');

  rpcs.caller_log = new Error('Failed to fetch');
  const off = await A.clLog('l1', 'no_answer', '', null);
  assert.equal(off.ok, false);
  assert.match(off.error, /Check your connection/);
});

test('the note is trimmed and capped before it is sent, and empty means null', async () => {
  reset();
  rpcs.caller_log = () => ({ data: { next: null }, error: null });
  await A.clLog('l1', 'no_answer', '   \r\n  ', null);
  assert.equal(calls[0].args.p_note, null, 'a blank note is null, not an empty string');

  reset();
  rpcs.caller_log = () => ({ data: { next: null }, error: null });
  await A.clLog('l1', 'no_answer', 'x'.repeat(A.CL_MAX_NOTE + 500), null);
  assert.equal(calls[0].args.p_note.length, A.CL_MAX_NOTE, 'an essay is cut to the length the database takes');
  assert.equal(A.clCleanNote('  hello\r\nthere  '), 'hello\nthere');
});

/* ═════════════════════════ 2. CALL BACK NEEDS A TIME ═════════════════════════ */

test('"call back" cannot be logged without a day and a time', () => {
  reset();
  // nothing picked
  assert.deepEqual(plain(A.clCallbackAt('', '', new Date())), { ok: false, iso: '', error: 'Pick a day.' });
  assert.deepEqual(plain(A.clCallbackAt('2026-11-27', '', new Date())), { ok: false, iso: '', error: 'Pick a time.' });
  // a half-typed or nonsense day
  ['27/11/2026', '2026-11', 'tomorrow', '26-11-2026', '2026/11/27'].forEach((d) => {
    const r = A.clCallbackAt(d, '10:00', new Date('2026-11-25T09:00:00Z'));
    assert.equal(r.ok, false, d + ' is not a day we would send');
    assert.equal(r.iso, '');
  });
  assert.equal(A.clCallbackAt('2026-11-27', '9am', new Date()).ok, false);
  assert.equal(A.clCallbackAt('2026-11-27', '10:00:00', new Date()).ok, false, 'only hh:mm, as the time input gives');

  /* A month of 13 or a day of 40 cannot come from a <input type="date">, and Date rolls it over
     rather than refusing. Whatever it becomes must still be a real instant in the future — never
     an Invalid Date, and never something the database would read as a past callback. */
  const rolled = A.clCallbackAt('2026-13-40', '10:00', new Date('2026-11-25T09:00:00Z'));
  if (rolled.ok) {
    const at = new Date(rolled.iso);
    assert.ok(!Number.isNaN(at.getTime()), 'what is sent is always a real instant');
    assert.ok(at > new Date('2026-11-25T09:00:00Z'), 'and always in the future');
  }

  // a time already gone is refused, so she cannot promise a call back into the past
  const now = new Date(2026, 10, 25, 14, 0, 0);
  const past = A.clCallbackAt('2026-11-25', '09:00', now);
  assert.equal(past.ok, false);
  assert.match(past.error, /in the past/);

  // a real pick becomes one instant
  const good = A.clCallbackAt('2026-11-27', '10:30', now);
  assert.equal(good.ok, true);
  assert.equal(good.error, '');
  const at = new Date(good.iso);
  assert.equal(at.getFullYear(), 2026);
  assert.equal(at.getMonth(), 10);
  assert.equal(at.getDate(), 27);
  assert.equal(at.getHours(), 10);
  assert.equal(at.getMinutes(), 30);
});

test('the page only reaches caller_log for a callback once clCallbackAt has agreed', () => {
  // The one path from the button to the database, read out of the page itself:
  // saveCallback() works out the instant and gives up before log() if it is bad.
  const fn = HTML.match(/function saveCallback\(form\)\{[\s\S]*?\n  \}/);
  assert.ok(fn, 'callers.html still has saveCallback');
  const body = fn[0];
  assert.match(body, /clCallbackAt\(/, 'it goes through the checked helper');
  assert.match(body, /if \(!at\.ok\)[\s\S]*return;/, 'and returns before logging when it says no');
  assert.ok(body.indexOf('if (!at.ok)') < body.indexOf("log('callback'"),
    'the guard comes before the only log call in it');
  assert.match(body, /log\('callback', at\.iso\)/, 'and the instant it agreed is what is sent');
  // the button itself opens the panel; it never logs straight away
  assert.match(HTML, /if \(key === 'callback'\) \{ openCallback\(\); return; \}/);
});

test('the callback panel offers the obvious times and shows the reason it refused', () => {
  reset();
  const now = new Date(2026, 10, 25, 14, 0, 0);
  const html = A.clCallbackHtml({ now });
  assert.match(html, /When should you ring back\?/);
  assert.match(html, /id="clBackDay"[^>]*type="date"[^>]*required/);
  assert.match(html, /id="clBackTime"[^>]*type="time"[^>]*required/);
  assert.match(html, /min="2026-11-25"/, 'she cannot pick a day before today');
  ['Later today', 'Tomorrow morning', 'Tomorrow afternoon', 'In a week'].forEach((q) =>
    assert.match(html, new RegExp(q), q + ' is one tap'));
  assert.match(html, /data-cl-quick="2026-11-26\|10:00"/, 'tomorrow morning is a real date, not a word');

  const refused = A.clCallbackHtml({ now, day: '2026-11-25', time: '09:00', error: 'That is in the past. Pick a later time.' });
  assert.match(refused, /That is in the past/, 'the reason is on screen beside the inputs');
  assert.match(A.clCallbackHtml({ now, busy: true }), /disabled/, 'and the button cannot be pressed twice');
  assert.doesNotMatch(A.clCallbackHtml({ now, error: '<script>x</script>' }), /<script>/);
});

/* ═════════════════════════ 3. BOOKED NEEDS AN EMAIL ═════════════════════════ */

test('"booked" cannot be sent without an email, a time and a name', async () => {
  reset();
  const base = { lead_id: 'l1', start: '2026-11-27T10:00:00.000Z', name: 'Steve', email: 'steve@stone.example' };

  // no email at all: she is told to take it, in her words
  assert.equal(A.clBookProblem(Object.assign({}, base, { email: '' })), 'Take their email address.');
  assert.equal(A.clBookProblem(Object.assign({}, base, { email: '   ' })), 'Take their email address.');
  // an email that cannot be right
  ['steve', 'steve@', '@stone.example', 'steve@stone', 'a b@c.example'].forEach((e) =>
    assert.match(A.clBookProblem(Object.assign({}, base, { email: e })), /does not look right/, e + ' is refused'));
  // no slot chosen, and no name
  assert.equal(A.clBookProblem(Object.assign({}, base, { start: '' })), 'Pick a time for the call.');
  assert.equal(A.clBookProblem(Object.assign({}, base, { name: '' })), 'Enter their name.');
  assert.equal(A.clBookProblem(base), '', 'everything there: nothing to fix');

  // and not one of those ever reaches the database
  for (const over of [{ email: '' }, { email: 'steve@' }, { start: '' }, { name: '' }]) {
    const r = await A.clBook(Object.assign({}, base, over));
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.data, null);
  }
  assert.equal(calls.filter((c) => c.rpc === 'caller_book').length, 0, 'caller_book was never called');

  // the booking that is complete sends exactly what the database asked for
  rpcs.caller_book = () => ({ data: { booking_id: 'b1', starts_at: '2026-11-27T10:00:00.000Z' }, error: null });
  const ok = await A.clBook(Object.assign({}, base, { company: ' Stone Roofing ', phone: '+20 100 555 0101', timezone: 'Africa/Cairo' }));
  assert.equal(ok.ok, true);
  const sent = calls.filter((c) => c.rpc === 'caller_book')[0];
  assert.deepEqual(plain(sent.args), {
    p_lead: 'l1', p_start: '2026-11-27T10:00:00.000Z', p_name: 'Steve',
    p_email: 'steve@stone.example', p_company: 'Stone Roofing', p_phone: '+20 100 555 0101', p_timezone: 'Africa/Cairo',
  });
  assert.equal(ok.data.booking_id, 'b1');
  assert.equal(ok.data.starts_at, '2026-11-27T10:00:00.000Z');
  // an empty optional is null, not an empty string the database has to clean up
  reset();
  rpcs.caller_book = () => ({ data: { booking_id: 'b2' }, error: null });
  await A.clBook(base);
  assert.equal(calls[0].args.p_company, null);
  assert.equal(calls[0].args.p_phone, null);
});

test('a booking the database refuses is never shown as booked', async () => {
  reset();
  // the slot went while she was talking
  rpcs.caller_book = () => ({ data: null, error: { message: 'That slot is already booked.' } });
  let r = await A.clBook({ lead_id: 'l1', start: '2026-11-27T10:00:00Z', name: 'Steve', email: 's@x.example' });
  assert.equal(r.ok, false);
  assert.match(r.error, /just gone|another one/i, 'she is told to pick another time');
  assert.equal(r.data, null);

  // the lead is not hers, or the policy says no
  rpcs.caller_book = () => ({ data: null, error: { message: 'permission denied for table discovery_bookings' } });
  r = await A.clBook({ lead_id: 'lX', start: '2026-11-27T10:00:00Z', name: 'Steve', email: 's@x.example' });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /permission denied|discovery_bookings/, 'the raw database words are never put in front of her');

  // an answer with nothing in it is not a booking
  rpcs.caller_book = () => ({ data: {}, error: null });
  r = await A.clBook({ lead_id: 'l1', start: '2026-11-27T10:00:00Z', name: 'Steve', email: 's@x.example' });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not book/);
});

test('the booking panel shows the free times by day, the chosen one marked', async () => {
  reset();
  const now = new Date(2026, 10, 25, 9, 0, 0);
  const slots = [
    '2026-11-26T12:00:00.000Z',
    { starts_at: '2026-11-26T13:00:00.000Z' },
    { start: '2026-11-27T12:00:00.000Z' },
    '2026-11-26T12:00:00.000Z',        // the same minute twice is one slot
    null, 'not a date',
  ];
  const groups = A.clSlotGroups(slots, now);
  assert.equal(groups.length, 2, 'two days');
  assert.equal(groups[0].slots.length, 2, 'the duplicate and the junk are gone');
  assert.equal(groups[0].label, 'Tomorrow');
  assert.ok(groups[0].slots[0].iso < groups[0].slots[1].iso, 'in time order');
  assert.deepEqual(plain(A.clSlotGroups(null, now)), [], 'no slots is an empty list, never a throw');

  const chosen = groups[0].slots[1].iso;
  const html = A.clBookHtml({ lead: LEAD(), slots, now, form: { start: chosen } });
  assert.match(html, /Book the call/);
  assert.match(html, /Read the time back to them/);
  assert.match(html, new RegExp('data-cl-slot="' + chosen + '"[^>]*aria-pressed="true"'), 'the time she picked is marked');
  assert.match(html, /id="clBookEmail"[^>]*required/, 'the email is required');
  assert.match(html, /id="clBookName"[^>]*required/);
  // the lead's details are offered but correctable, and escaped
  assert.match(html, /value="steve@stone\.example"/);
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /Stone &quot;Steve&quot; &lt;b&gt;Roofing&lt;\/b&gt; &amp;amp; Sons|&amp; Sons/);

  // no free times at all, and a failure getting them
  assert.match(A.clBookHtml({ lead: LEAD(), slots: [], now }), /no free times in the next two weeks/);
  assert.match(A.clBookHtml({ lead: LEAD(), now, loading: true }), /Loading the free times/);
  assert.match(A.clBookHtml({ lead: LEAD(), now, slotError: A.CL_NOT_READY }), /data-cl-retry/);
  assert.match(A.clBookHtml({ lead: LEAD(), slots, now, busy: true }), /id="clBookBtn" disabled/);
});

test('caller_slots always hands back a list, whatever shape it arrives in', async () => {
  reset();
  rpcs.caller_slots = (args) => { assert.equal(args.p_days, A.CL_SLOT_DAYS); return { data: ['2026-11-26T12:00:00Z'], error: null }; };
  let r = await A.clSlots();
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 1);
  rpcs.caller_slots = () => ({ data: { slots: ['2026-11-26T12:00:00Z'] }, error: null });
  assert.equal((await A.clSlots(14)).data.length, 1, 'wrapped in an object works too');
  rpcs.caller_slots = () => ({ data: null, error: null });
  assert.deepEqual(plain((await A.clSlots(14)).data), [], 'nothing at all is an empty list');
});

test('the moment it is booked she has the words to say out loud', () => {
  reset();
  const now = new Date(2026, 10, 25, 9, 0, 0);
  const html = A.clBookedHtml({ booking_id: 'b1', starts_at: new Date(2026, 10, 26, 14, 0, 0).toISOString(), name: 'Steve' }, now);
  assert.match(html, /Booked\./);
  assert.match(html, /Tomorrow/);
  assert.match(html, /Steve/);
  assert.match(html, /invite and the reminders go out on their own/);
  assert.match(html, /data-cl-onwards/, 'and one button on to the next call');
  assert.doesNotMatch(A.clBookedHtml({ name: '<script>x</script>' }, now), /<script>/);
  // the booking is saved before the call is logged, so a failed log cannot lose it
  assert.ok(HTML.indexOf('booked = r.data;') < HTML.indexOf("log('booked', null);"),
    'callers.html shows the confirmation first and logs after');
});

/* ═════════════════════════ 4. ESCAPING EVERY LEAD FIELD ═════════════════════════ */

test('company, name, notes, phone, timezone and batch are all escaped on the lead card', () => {
  reset();
  const html = A.clLeadHtml(LEAD(), new Date());
  assert.doesNotMatch(html, /<script>/, 'the notes cannot run');
  assert.doesNotMatch(html, /<img /, 'nor can the name');
  assert.doesNotMatch(html, /<b>Roofing<\/b>/);
  assert.doesNotMatch(html, /<b>1<\/b>/, 'nor the batch label');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Stone &quot;Steve&quot; &lt;b&gt;Roofing&lt;\/b&gt;/);
  assert.match(html, /&#39;|&quot;ask for Steve&quot;/, 'quotes in the notes are escaped, not closing an attribute');

  // the same fields again through the whole screen and the booking panel
  const screen = A.clDiallerHtml({ caller: { id: 'c1', name: '<script>me</script>' }, today: { dials: 3, booked: 1 }, lead: LEAD(), now: new Date() });
  assert.doesNotMatch(screen, /<script>/, 'neither her own name nor the lead can open a script tag');
  assert.doesNotMatch(screen, /<img src=x/, 'nor an image with a handler on it');
  assert.match(screen, /&lt;script&gt;me&lt;\/script&gt;/, 'her name is escaped in the bar');
  const book = A.clBookHtml({ lead: LEAD(), slots: [], now: new Date(), form: {} });
  assert.doesNotMatch(book, /<script>/);
  assert.doesNotMatch(book, /<img src=x/);
  // and a value she typed back into the form
  const typed = A.clBookHtml({ lead: LEAD(), slots: [], now: new Date(), form: { name: '"><script>x</script>', email: '" onfocus="alert(1)', company: '</textarea>' } });
  assert.doesNotMatch(typed, /<script>/, 'what she typed back into the form cannot run either');
  assert.doesNotMatch(typed, /value="[^"]*"\s+onfocus=/, 'and cannot break out of the value attribute');
  assert.match(typed, /value="&quot; onfocus=&quot;alert\(1\)"/, 'it is sitting inside the attribute, escaped');
});

test('a phone that is really text cannot become another kind of link', () => {
  reset();
  assert.equal(A.clTelHref('+20 100 555 0101'), 'tel:+201005550101');
  assert.equal(A.clTelHref('(0100) 555-0101'), 'tel:01005550101');
  assert.equal(A.clTelHref('javascript:alert(1)'), '', 'no digits, no link');
  assert.equal(A.clTelHref('tel:1 or javascript:alert(1)'), '', 'two digits is not a phone number');
  assert.equal(A.clTelHref('javascript:alert(123456)'), 'tel:123456', 'and if there are digits, ONLY the digits survive');
  assert.equal(A.clTelHref('ext 12'), '', 'too few digits to dial');
  assert.equal(A.clTelHref(''), '');
  assert.equal(A.clTelHref(null), '');
  // the href on the card is built from that, so nothing else can get in
  const dodgy = A.clLeadHtml(LEAD({ phone: '" onclick="alert(1)" x="' }), new Date());
  assert.doesNotMatch(dodgy, /onclick=/);
  assert.match(A.clLeadHtml(LEAD({ phone: 'no number' }), new Date()), /No usable number/,
    'an unusable number says so rather than offering a dead link');
  // she still sees it as it was typed, so she can read it out
  assert.equal(A.clPhoneLabel('+20  100   555 0101'), '+20 100 555 0101');
});

test('a misspelt or missing timezone never guesses, and a bad hour is flagged', () => {
  reset();
  const at = new Date('2026-11-25T23:30:00Z');
  const none = A.clZoneNow('', at);
  assert.equal(none.ok, false);
  assert.equal(A.clZoneLine('', at), 'Timezone not known');
  const junk = A.clZoneNow('Mars/Olympus', at);
  assert.equal(junk.ok, false, 'a zone that does not exist does not throw');
  assert.match(A.clZoneLine('Mars/Olympus', at), /local time unknown/);
  assert.doesNotMatch(A.clLeadHtml(LEAD({ timezone: '<script>x</script>' }), at), /<script>/);

  const cairo = A.clZoneNow('Africa/Cairo', at);
  assert.equal(cairo.ok, true);
  assert.equal(cairo.risky, true, 'half past one in the morning is not a time to ring anybody');
  assert.match(A.clLeadHtml(LEAD(), at), /Careful: /);
  const day = A.clZoneNow('Africa/Cairo', new Date('2026-11-25T12:00:00Z'));
  assert.equal(day.risky, false);
  assert.doesNotMatch(A.clLeadHtml(LEAD(), new Date('2026-11-25T12:00:00Z')), /Careful: /);
});

test('her own tally is numbers only, whatever the database sends', () => {
  reset();
  assert.deepEqual(plain(A.clTally({ dials: 12, booked: 2 })), { dials: 12, booked: 2 });
  assert.deepEqual(plain(A.clTally({ dials: '12', booked: null })), { dials: 12, booked: 0 });
  assert.deepEqual(plain(A.clTally({ dials: -5, booked: 'lots' })), { dials: 0, booked: 0 });
  assert.deepEqual(plain(A.clTally(null)), { dials: 0, booked: 0 });
  const html = A.clTallyHtml({ dials: '<script>x</script>', booked: 2 });
  assert.doesNotMatch(html, /<script>/, 'a string where a number should be cannot reach the page');
  assert.match(html, /<b>0<\/b><span>dials<\/span>/);
  assert.match(A.clTallyHtml({ dials: 12, booked: 2 }), /<b>2<\/b><span>booked<\/span>/);
});

test('caller_me is read defensively: a login that is not a caller is not an error', async () => {
  reset();
  rpcs.caller_me = () => ({ data: { caller: { id: 'c1', name: 'Nour' }, today: { dials: 3, booked: 1 }, lead: LEAD(), script_url: '' }, error: null });
  const r = await A.clMe();
  assert.equal(r.ok, true);
  assert.equal(r.data.caller.name, 'Nour');
  assert.equal(r.data.lead.id, 'l1');
  assert.equal(r.data.today.dials, 3);

  for (const d of [null, {}, { caller: {} }, { caller: { name: 'Nour' } }, 'nonsense']) {
    reset();
    rpcs.caller_me = () => ({ data: d, error: null });
    const bad = await A.clMe();
    assert.equal(bad.ok, true, 'it is not shouted about');
    assert.equal(bad.data, null, JSON.stringify(d) + ' is "not a caller", not a half-drawn screen');
  }
  // a lead that is missing or has no id is simply no lead
  reset();
  rpcs.caller_me = () => ({ data: { caller: { id: 'c1', name: 'Nour' }, lead: { company: 'no id' } }, error: null });
  assert.equal((await A.clMe()).data.lead, null);
  assert.equal(A.clLead(null), null);
  assert.equal(A.clLead({ company: 'x' }), null);
});

test('the sign-in screen asks for an email and a code, and offers no other way in', () => {
  reset();
  const html = A.clSignInHtml({});
  assert.match(html, /id="clInEmail"[^>]*type="email"/);
  assert.match(html, /id="clInCode"[^>]*type="password"/, 'the code is not left on screen');
  assert.doesNotMatch(html, /password/i.source ? /the password|your password/i : /x/, 'she is never told it is a password');
  assert.match(html, /Access code/);
  assert.match(html, /Limethsith/, 'and who to ask if it does not work');
  assert.doesNotMatch(html, /sign ?up|create an account|forgot/i, 'no sign-up and no self-service reset');
  assert.doesNotMatch(html, /magic link|google|github/i);

  assert.match(A.clEmailProblem(''), /Enter your email/);
  assert.match(A.clEmailProblem('nour@'), /does not look right/);
  assert.equal(A.clEmailProblem('nour@example.com'), '');
  assert.match(A.clCodeProblem(''), /Enter your access code/);
  assert.match(A.clCodeProblem('AVX'), /too short/);
  assert.equal(A.clCodeProblem('AVX-4K7M-Q2ZP'), '');
  assert.equal(A.clCleanCode(' avx-4k7m q2zp '), 'AVX-4K7MQ2ZP', 'she can type it as she likes');
  assert.doesNotMatch(A.clSignInHtml({ email: '"><script>x</script>', error: '<b>no</b>' }), /<script>|<b>no<\/b>/);
});

test('a bad code is one calm sentence, and the code never comes back in an error', async () => {
  reset();
  authAnswer = { data: null, error: { message: 'Invalid login credentials' } };
  const r = await A.clSignIn('nour@example.com', 'AVX-WRONG-0000');
  assert.equal(r.ok, false);
  assert.equal(r.error, A.CL_BAD_CODE);
  assert.doesNotMatch(r.error, /AVX-WRONG-0000|password|credential/i, 'her code is not echoed back at her');

  reset();
  authAnswer = { data: null, error: { message: 'User not found' } };
  assert.equal((await A.clSignIn('nobody@example.com', 'AVX-1234-5678')).error, A.CL_NO_ACCOUNT);
  reset();
  authAnswer = new Error('Failed to fetch');
  assert.equal((await A.clSignIn('nour@example.com', 'AVX-1234-5678')).error, A.CL_OFFLINE);
  // a form that is not filled in never reaches Supabase
  reset();
  assert.equal((await A.clSignIn('', '')).ok, false);
  assert.equal((await A.clSignIn('nour@example.com', 'AVX')).ok, false);
  assert.equal(calls.filter((c) => c.signIn).length, 0);
  // the client is her own, with her own storage key, so no other login is touched
  assert.match(SRC, /storageKey: 'aviance-caller-auth'/);
  assert.match(SRC, /detectSessionInUrl: false/);
  assert.match(SRC, /persistSession: true/);
});

/* ═════════════════════════ 5. THE PAGE IS SEALED OFF FROM THE HUB ═════════════════════════ */

test('callers.html loads only its own files and nothing from the hub', () => {
  const scripts = [...HTML.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  const styles = [...HTML.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts.filter((s) => !/^https:/.test(s)), ['caller-page.js'],
    'the only local script is her own: ' + scripts.join(', '));
  assert.deepEqual(styles, ['theme.css', 'polish.css', 'brand.css', 'caller-page.css'],
    'and the only stylesheets are the two shared ones plus her own');
  // every remote script is pinned with an integrity hash
  [...HTML.matchAll(/<script[^>]*src="(https:[^"]+)"[^>]*>/g)].forEach((m) => {
    assert.match(m[0], /integrity="sha384-/, m[1] + ' is pinned');
    assert.match(m[1], /@supabase\/supabase-js@\d+\.\d+\.\d+\//, 'and is supabase-js at one exact version');
  });
  // no hub module is named anywhere in the file, in a tag or in a comment
  const HUB = ['clientbook', 'meetings.js', 'pipeline', 'invoices.js', 'settings.js', 'channels.js',
    'employees.js', 'documents.js', 'journey', 'onboarding', 'outreach', 'wrapup', 'digest',
    'finance.js', 'drafts.js', 'calling.js', 'team-page.js', 'portal', 'index.html', 'app.js'];
  HUB.forEach((m) => assert.equal(HTML.indexOf(m), -1, 'callers.html must not mention ' + m));
  assert.equal(HTML.indexOf('callers.js'), -1, "nor the owner's own Callers screen");
});

test('callers.html carries no link and no word pointing at the rest of the hub', () => {
  const hrefs = [...HTML.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  const allowed = /^(\/icon-192\.png|\/apple-touch-icon\.png|\/fonts\/inter-latin\.woff2|theme\.css|polish\.css|brand\.css|caller-page\.css)$/;
  hrefs.forEach((h) => assert.match(h, allowed, 'an unexpected link: ' + h));
  assert.equal(hrefs.filter((h) => /^(https?:)?\/\//.test(h)).length, 0, 'no link off this page at all');
  assert.equal([...HTML.matchAll(/<a\s/g)].length, 0, 'and not one anchor in the page');
  /* The words that would tell her there is more to Aviance than her list. Checked on what the
     page really draws: the markup with its <script> blocks and comments taken out, plus every
     screen caller-page.js can build. The selling script is left out on purpose — it is about
     winning the prospect, and words like "contract" belong in it. */
  const markup = HTML.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const now = new Date(2026, 10, 25, 9, 0, 0);
  const drawn = [
    markup,
    A.clSignInHtml({ email: 'nour@example.com', error: 'x' }),
    A.clLoadingHtml(), A.clOfflineHtml(), A.clNotReadyHtml(A.CL_NOT_READY),
    A.clLeadHtml(null, now), A.clLeadHtml(LEAD(), now), A.clActionsHtml(LEAD()),
    A.clTallyHtml({ dials: 1, booked: 1 }),
    A.clCallbackHtml({ now }), A.clBookHtml({ lead: LEAD(), slots: ['2026-11-26T12:00:00Z'], now, form: {} }),
    A.clBookHtml({ lead: LEAD(), slots: [], now }), A.clBookedHtml({ starts_at: now.toISOString(), name: 'Steve' }, now),
    /* the dialler frame without the script column */
    A.clDiallerHtml({ caller: { id: 'c1', name: 'Nour' }, today: { dials: 1, booked: 0 }, lead: LEAD(), now })
      .replace(/<aside class="cl-script"[\s\S]*<\/aside>/, ' '),
  ].join('\n').toLowerCase();
  const WORDS = ['client', 'invoice', 'agreement', 'settings', 'channel', 'employee', 'document',
    'pipeline', 'dashboard', 'revenue', 'onboarding', 'proposal', 'contract', 'payment',
    'admin', 'sidebar', 'navigation', 'menu', 'hub'];
  WORDS.forEach((w) => assert.equal(drawn.indexOf(w), -1, 'nothing on her screen may say "' + w + '"'));
  // she is never TOLD her code is a password: the word appears only inside the markup's attributes
  const words = drawn.replace(/<[^>]*>/g, ' ');
  assert.equal(words.indexOf('password'), -1, 'the word "password" is never shown to her');
  assert.equal(words.indexOf('supabase'), -1, 'and she is never shown the plumbing');
  // nor any sign of a sidebar, a route or a way out
  /* One block in caller-page.js is allowed to touch the address bar: the one that spends a
     one-click invite link (#k=...) and then wipes it. It is fenced off with ---8<--- markers.
     Cut it out, and nothing in either file may read or change where the browser is. */
  const fenced = SRC.match(/---8<--- link-claim[\s\S]*?---8<--- end link-claim ---8<--- \*\//g) || [];
  assert.equal(fenced.length, 1, 'exactly one fenced block may touch the address bar');
  ['location.href', 'window.open', 'history.push', '<a ', '<nav'].forEach((x) =>
    assert.equal(fenced[0].indexOf(x), -1, 'even the fenced block never navigates: ' + x));
  const code = HTML.replace(/clClaimLink\(\)|clLinkProblem\(\)/g, ' ')
    + SRC.replace(fenced[0], ' ');
  ['<nav', 'location.href', 'location.hash', 'window.open', 'window.location', 'history.push', '#clients']
    .forEach((x) => assert.equal(code.indexOf(x), -1, 'no ' + x + ' anywhere'));
  assert.match(HTML, /robots" content="noindex,nofollow/, 'and the page is not indexed');
  assert.match(HTML, /referrer" content="no-referrer/);
});

test('caller-page.js reaches the database only through the six caller functions', () => {
  // every rpc name in the file, and nothing else
  const names = [...SRC.matchAll(/clRpc\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names.slice().sort(), ['caller_book', 'caller_log', 'caller_me', 'caller_next', 'caller_slots'].sort(),
    'the only functions it calls: ' + names.join(', '));
  // it never touches a table, a view or the storage API
  assert.equal(SRC.indexOf('.from('), -1, 'no .from() — a mistake here cannot widen what she can see');
  assert.equal(SRC.indexOf('.storage'), -1);
  assert.equal(SRC.indexOf('free_slots'), -1, 'it wraps caller_slots, not the raw function');
  // and the fake client above proves it: any .from() would have thrown in every test in this file
  reset();
  assert.throws(() => fakeSb.from('leads'), /never touch a table/);
});

test('the script she reads is beside the lead, is all escaped, and is not an afterthought', () => {
  reset();
  const html = A.clScriptHtml(A.CL_SCRIPT);
  assert.match(html, /aria-label="The calling script"/);
  // the sections the spec asked for
  ['Opener', 'What we do', 'guarantee', 'Three questions', 'close', 'Objections']
    .forEach((s) => assert.match(html, new RegExp(s, 'i'), 'the script has a ' + s + ' section'));
  assert.match(html, /double your money back/i, 'the guarantee is in it');
  assert.match(html, /\$1,500/, 'with the plan numbers');
  assert.match(html, /<details class="cl-sec" open/, 'the guarantee is open by default');
  assert.match(html, /<summary/, 'and each section opens with no JavaScript at all');
  // text with a quote or a bracket in it does not break the markup
  assert.doesNotMatch(A.clScriptHtml([{ id: 'x', title: '<script>t</script>', items: [{ kind: 'ask', term: '"<b>q</b>"', text: '<img src=x>' }] }]), /<script>t|<b>q<\/b>|<img /);
  assert.deepEqual(A.clScriptHtml(null), '<aside class="cl-script" aria-label="The calling script">\n    <p class="cl-label">The script</p>\n    \n  </aside>');
});

/* ═════════════════════════ 6. DEGRADING BEFORE THE MIGRATION ═════════════════════════ */

test('before the migration she gets one calm notice and a Try again, not a stack trace', async () => {
  reset();
  const notThere = { message: 'Could not find the function public.caller_me in the schema cache', code: 'PGRST202' };
  rpcs.caller_me = () => ({ data: null, error: notThere });
  const r = await A.clMe();
  assert.equal(r.ok, false);
  assert.equal(r.error, A.CL_NOT_READY);
  assert.equal(A.clIsNotReady(r.error), true);
  const html = A.clNotReadyHtml(r.error);
  assert.match(html, /Not quite ready/);
  assert.match(html, /Limethsith will let you know/);
  assert.match(html, /data-cl-retry/, 'with a button to try again when it is');
  assert.doesNotMatch(html, /PGRST202|schema cache|public\.caller_me/, 'and not a word of the real error');

  // a policy that says no reads the same way to her: it is not her fault and not her problem
  assert.equal(A.clSay({ message: 'permission denied for table leads' }, 'f'), A.CL_NOT_READY);
  assert.equal(A.clSay({ message: 'new row violates row-level security policy' }, 'f'), A.CL_NOT_READY);
  // the ones she can act on
  assert.equal(A.clSay({ message: 'Failed to fetch' }, 'f'), A.CL_OFFLINE);
  assert.match(A.clSay({ message: 'rate limit exceeded' }, 'f'), /Too many tries/);
  assert.match(A.clSay({ message: 'That slot is already booked' }, 'f'), /just gone/);
  assert.equal(A.clSay({ message: 'something nobody has seen before' }, ''), 'Something went wrong. Please try again.',
    'and anything unknown is one calm sentence, never the raw text');
  assert.equal(A.clIsNotReady('Something went wrong. Please try again.'), false);

  // offline, before she is even signed in
  reset();
  A.clUseClient(null);
  const off = await A.clRpc('caller_me', {});
  assert.equal(off.ok, false);
  assert.equal(off.error, A.CL_OFFLINE);
  assert.match(A.clOfflineHtml(), /data-cl-retry/);
  assert.equal((await A.clSignOut()).ok, true, 'and signing out still works with no client at all');
  A.clUseClient(fakeSb);
});

test('an rpc that throws, or answers nothing at all, is still {ok,data,error}', async () => {
  reset();
  rpcs.caller_me = new Error('kaboom');
  const r = await A.clRpc('caller_me', {});
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.ok(r.error && !/kaboom/.test(r.error), 'the throw\'s own words are not shown');
  // every public function of the data layer keeps the shape, even with nonsense in
  reset();
  for (const fn of ['clMe', 'clNext']) {
    rpcs.caller_me = () => undefined; rpcs.caller_next = () => undefined;
    const out = await A[fn]();
    assert.equal(typeof out.ok, 'boolean', fn + ' answers {ok,...}');
    assert.ok('data' in out && 'error' in out, fn + ' answers {data,error}');
  }
});

/* ───────────── perfection pass ───────────── */

/* She rings other countries. The slot she taps is drawn on HER clock; the time she must say out loud
   is the PROSPECT'S. Both are on the chip, so she never reads a Cairo time to someone in New York. */
test('each free time also shows the time on the prospect\'s clock', () => {
  reset();
  const at = new Date(Date.UTC(2026, 10, 26, 15, 0, 0));           // 15:00 UTC = 10:00 in New York (EST)
  const hers = ('0' + at.getHours()).slice(-2) + ':' + ('0' + at.getMinutes()).slice(-2);
  const theirs = A.clTheirTime(at, 'America/New_York');
  if (hers !== '10:00') assert.equal(theirs, 'Thu 10:00');
  assert.equal(A.clTheirTime(at, 'Asia/Tokyo'), 'Fri 00:00', 'the day is named, because it can be a different day for them');
  assert.equal(A.clTheirTime(at, ''), '', 'no zone on the lead: nothing is guessed');
  assert.equal(A.clTheirTime(at, 'Mars/Phobos'), '', 'a zone nobody knows: nothing is guessed');
  assert.equal(A.clTheirTime('not a date', 'America/New_York'), '');
  // her own zone: no second time, because it would only repeat the first
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(A.clTheirTime(at, mine), '');

  const now = new Date(Date.UTC(2026, 10, 25, 9, 0, 0));
  const html = A.clBookHtml({ lead: LEAD({ timezone: 'Asia/Tokyo' }), slots: [at.toISOString()], now });
  assert.match(html, /<span class="cl-chip-their">Fri 00:00 for them<\/span>/);
  assert.match(html, /time on their clock/, 'and she is told which one to read out');
  const plainHtml = A.clBookHtml({ lead: LEAD({ timezone: '' }), slots: [at.toISOString()], now });
  assert.doesNotMatch(plainHtml, /cl-chip-their|their clock/);
  // and it is on the confirmation she reads back
  const done = A.clBookedHtml({ starts_at: at.toISOString(), name: 'Steve', timezone: 'Asia/Tokyo' }, now);
  assert.match(done, /On their clock: Fri 00:00/);
  assert.doesNotMatch(A.clBookedHtml({ starts_at: at.toISOString(), name: 'Steve' }, now), /their clock/);
  // a lead's timezone comes from a stranger's CSV: it is never put on the page raw
  assert.doesNotMatch(A.clBookHtml({ lead: LEAD({ timezone: '<img src=x>' }), slots: [at.toISOString()], now }), /<img/);
});

test('clBook hands the prospect\'s zone on to the confirmation', async () => {
  reset();
  rpcs.caller_book = () => ({ data: { booking_id: 'b1', starts_at: '2026-11-26T15:00:00Z' }, error: null });
  const r = await A.clBook({ lead_id: 'l1', start: '2026-11-26T15:00:00Z', name: 'Steve', email: 'steve@stone.example', timezone: 'Asia/Tokyo' });
  assert.equal(r.ok, true);
  assert.equal(r.data.timezone, 'Asia/Tokyo');
});

test('callers.html: the "Booked." panel stays until she taps Next call', () => {
  // logging the booking brings up the next lead, but must not wipe the words she is reading out
  const log = HTML.slice(HTML.indexOf('async function log('), HTML.indexOf('/* "Check again"'));
  assert.match(log, /const keep = sheet === 'booked';/);
  assert.match(log, /if \(!keep\) \{ sheet = ''; book = null; \}/);
  assert.doesNotMatch(log, /lead = r\.data\.next;\s*sheet = '';/, 'the old unconditional clear is gone');
  assert.match(HTML, /data-cl-onwards'\)\) \{ sheet = ''; booked = null; book = null; drawSheet\(\); return; \}/, 'Next call is what closes it');
});
