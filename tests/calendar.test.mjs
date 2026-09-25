/* Tests for the Calendar tab (calendar.js) — email-distributor/docs/CALENDAR.md.
   Run with:  npm test   (= node --test tests/*.test.mjs)

   Same set-up as trials.test.mjs: the shell's inline script, then trials.js, inquiries.js,
   calendar.js and push.js, exactly like the browser, with a tiny fake DOM and a fake Supabase
   client. The machine is a fake fetch that answers like the contract. No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleHub, ecreekDetail, CAL_NOW, calSettingsFixture, calMeetings, calWeek, calWinterWeek, calHostile } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake DOM (as in trials.test.mjs) ───────────── */
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() {}, select() {}, submit() {}, addEventListener() {}, scrollIntoView() {}, closest() { return null; }, getAttribute() { return null; } };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.location = { hash: '', origin: 'https://aviance.store', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
globalThis.confirm = () => true; globalThis.prompt = () => 'a reason';
globalThis.addEventListener = () => {};

const supa = { session: null, user: null, profile: null };
const fakeSb = {
  auth: { getSession: async () => ({ data: { session: supa.session } }), getUser: async () => ({ data: { user: supa.user } }), signInWithPassword: async () => ({ error: null }), signOut: async () => { supa.session = null; }, resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }) },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: supa.profile }) }) }) }),
};
globalThis.supabase = { createClient: () => fakeSb };

/* ───────────── load the shell, then the section scripts ───────────── */
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="trials.js">'));
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
for (const f of ['trials.js', 'inquiries.js', 'calendar.js', 'push.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
supa.session = { access_token: 'test-token' };
after(() => { trialsStopTimer(); calendarStopTimer(); });

const asOwner = () => { authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const tick = () => new Promise((r) => setTimeout(r, 5));
const ST = calSettings(calSettingsFixture);
const model = (week, meetings, opts) => calWeekModel(week, meetings, ST, Object.assign({ now: CAL_NOW }, opts));
const where = (m, id) => { for (const d of m.days) { const x = d.items.find((i) => i.m.id === id); if (x) return [d.key, x.s, x.mins]; } return null; };
const fresh = () => { calendarForget(); trialsForget(); asOwner(); cal.now = CAL_NOW.toISOString(); };

/* A fake machine: GET answers the week; POST applies the action to a copy and answers {ok, meeting}. */
function fakeMachine(week = calWeek) {
  const calls = []; const state = { week: clone(week), reply: null };
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push([init.method, u.pathname, u.searchParams, body]);
    if (u.pathname === '/api/mc/calendar') {
      if (init.method === 'GET') return ok(state.week)();
      if (state.reply) return { ok: state.reply.status < 400, status: state.reply.status, text: async () => JSON.stringify(state.reply.body) };
      const cur = state.week.meetings.find((m) => m.id === body.id);
      const m = clone(cur || {});
      switch (body.action) {
        case 'confirm': m.status = 'confirmed'; break;
        case 'suggest': m.proposed = body.start; break;
        case 'decline': m.status = 'declined'; m.declineReason = body.reason; break;
        case 'move': m.start = body.start; break;
        case 'held': m.status = 'held'; break;
        case 'noShow': m.status = 'no_show'; break;
        case 'cancel': m.status = 'cancelled'; m.declineReason = body.reason; break;
        case 'unblock': m.status = 'cancelled'; break;
        case 'add': Object.assign(m, { id: 'madd', status: 'confirmed', clientId: body.clientId, title: body.title, start: body.start, minutes: body.minutes, source: 'owner' }); break;
        case 'block': Object.assign(m, { id: 'mblk', status: 'blocked', title: 'Busy', start: body.start, minutes: body.minutes, source: 'owner' }); break;
      }
      state.week.meetings = state.week.meetings.filter((x) => x.id !== m.id).concat([m]);
      state.week.requests = state.week.requests.filter((x) => x.id !== m.id).concat(m.status === 'requested' ? [m] : []);
      return ok({ ok: true, meeting: m })();
    }
    if (u.pathname === '/api/mc/hub') return ok(simpleHub)();
    if (u.pathname.startsWith('/api/mc/hub/')) return ok(ecreekDetail)();
    return ok({ ok: true, checked: 0, newReplies: 0, booked: 0, remindersSent: 0 })();
  };
  const gets = () => calls.filter((c) => c[0] === 'GET' && c[1] === '/api/mc/calendar');
  const posts = () => calls.filter((c) => c[0] === 'POST' && c[1] === '/api/mc/calendar').map((c) => c[3]);
  return { calls, state, gets, posts, last: () => posts().pop() };
}
const offline = () => { globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; globalThis.confirm = () => true; };

/* ───────────── time: Intl only ───────────── */
test('time: Sri Lanka ↔ US Eastern through Intl — summer (EDT), winter (EST), both clock-change days, and the Colombo midnight crossover', () => {
  // a wall-clock time in a zone → the instant
  assert.equal(calZoneToUtc('2026-09-29', '09:00', 'America/New_York').toISOString(), '2026-09-29T13:00:00.000Z', '9 am EDT');
  assert.equal(calZoneToUtc('2026-11-03', '09:00', 'America/New_York').toISOString(), '2026-11-03T14:00:00.000Z', '9 am EST');
  assert.equal(calZoneToUtc('2026-11-01', '09:00', 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z', 'the Sunday US clocks go back');
  assert.equal(calZoneToUtc('2027-03-14', '09:00', 'America/New_York').toISOString(), '2027-03-14T13:00:00.000Z', 'the Sunday US clocks go forward');
  assert.equal(calZoneToUtc('2026-09-29', '18:30', 'Asia/Colombo').toISOString(), '2026-09-29T13:00:00.000Z', 'Colombo is UTC+5:30 all year');
  assert.equal(calZoneToUtc('2026-12-31', '00:00', 'Asia/Colombo').toISOString(), '2026-12-30T18:30:00.000Z');
  // the instant → a Sri Lanka date and time
  const tue9 = new Date('2026-09-29T13:00:00Z'), tue4 = new Date('2026-09-29T20:00:00Z'), winter4 = new Date('2026-11-03T21:00:00Z');
  assert.deepEqual([calDayKey(tue9, 'Asia/Colombo'), calTime(tue9, 'Asia/Colombo'), calTime(tue9, 'America/New_York')], ['2026-09-29', '6:30 pm', '9:00 am']);
  assert.deepEqual([calDayKey(tue4, 'Asia/Colombo'), calTime(tue4, 'Asia/Colombo'), calDayKey(tue4, 'America/New_York')], ['2026-09-30', '1:30 am', '2026-09-29'], 'a 4 pm ET Tuesday call is Wednesday 1:30 am in Colombo');
  assert.deepEqual([calDayKey(winter4, 'Asia/Colombo'), calTime(winter4, 'Asia/Colombo')], ['2026-11-04', '2:30 am'], 'in US winter it is 2:30 am');
  assert.equal(calTimeShort(tue9, 'America/New_York'), '9 am');
  assert.equal(calDay(tue4, 'Asia/Colombo'), 'Wed 30 Sep');
  // one meeting, three ways
  const w = calWhen('2026-09-29T20:00:00Z', ST, 'America/Denver');
  assert.equal(w.big, 'Wed 30 Sep · 1:30 am');
  assert.equal(w.us, 'Tue 4:00 pm US Eastern', 'the US day is the day before');
  assert.equal(w.their, 'Tue 2:00 pm their time (US Mountain)');
  assert.equal(calWhen('2026-09-29T20:00:00Z', ST, 'America/New_York').their, '', 'their zone = Eastern: not said twice');
  assert.equal(calWhen('2026-09-29T20:00:00Z', ST, 'Not/AZone').their, '', 'an unknown zone is ignored');
  assert.equal(calWhen('nonsense', ST, null), null);
  // calendar arithmetic
  assert.equal(calMonday('2026-10-04'), '2026-09-28'); assert.equal(calMonday('2026-09-28'), '2026-09-28'); assert.equal(calAddDays('2026-12-31', 1), '2027-01-01');
  assert.equal(calWeekLabel('2026-09-28'), '28 Sep – 4 Oct 2026'); assert.equal(calWeekLabel('2026-12-28'), '28 Dec 2026 – 3 Jan 2027');
  assert.equal(calDaysText([1, 2, 3, 4, 5]), 'Mon–Fri'); assert.equal(calDaysText([1, 3]), 'Mon, Wed');
  // no fixed offsets anywhere in the file: every conversion is Intl
  const src = fs.readFileSync(path.join(root, 'calendar.js'), 'utf8');
  assert.ok(!/getTimezoneOffset|\+05:30|5\.5\s*\*|330\s*\*|UTC[+-]\d/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hand-rolled offsets');
});

test('settings: the machine\'s settings are used; anything missing or odd falls back to the contract defaults', () => {
  assert.deepEqual(calSettings(null), { hours: ['09:00', '17:00'], days: [1, 2, 3, 4, 5], slotMinutes: 30, ownerZone: 'Asia/Colombo', usZone: 'America/New_York', meetingLink: null });
  const s = calSettings({ hours: ['10:00', '16:00'], days: [2, 4, 9, 'x'], slotMinutes: 15, ownerZone: 'Mars/Base', usZone: 'America/Chicago', meetingLink: '' });
  assert.deepEqual(s, { hours: ['10:00', '16:00'], days: [2, 4], slotMinutes: 15, ownerZone: 'Asia/Colombo', usZone: 'America/Chicago', meetingLink: null });
  assert.deepEqual(calSettings({ hours: ['17:00', '09:00'] }).hours, ['09:00', '17:00'], 'end before start → default');
});

/* ───────────── the week grid ───────────── */
test('week grid: Mon–Sun columns are Sri Lanka dates; a 9 am ET Tuesday call is Tuesday evening, a 4 pm ET Thursday call is early Friday; declined/cancelled are hidden unless asked', () => {
  const m = model('2026-09-28', calWeek.meetings);
  assert.deepEqual(m.days.map((d) => d.key), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(m.days.map((d) => d.label), ['Mon 28 Sep', 'Tue 29 Sep', 'Wed 30 Sep', 'Thu 1 Oct', 'Fri 2 Oct', 'Sat 3 Oct', 'Sun 4 Oct']);
  assert.equal(m.range.from, '2026-09-27T18:30:00.000Z', 'Monday 00:00 in Colombo');
  assert.equal(m.range.to, '2026-10-04T18:30:00.000Z', 'next Monday 00:00 in Colombo');
  assert.deepEqual(where(m, 'mconf'), ['2026-09-29', 18 * 60 + 30, 30], 'Tue 9 am ET → Tue 6:30 pm');
  assert.deepEqual(where(m, 'mnoshow'), ['2026-09-29', 30, 15], 'Mon 3 pm ET → Tue 12:30 am');
  assert.deepEqual(where(m, 'mreq2'), ['2026-10-02', 90, 15], 'Thu 4 pm ET → Fri 1:30 am');
  assert.deepEqual(where(m, 'mreq1'), ['2026-09-30', 23 * 60 + 30, 30]);
  assert.deepEqual(where(m, 'mblocked'), ['2026-10-01', 20 * 60 + 30, 60]);
  assert.deepEqual(where(m, 'mown'), ['2026-10-03', 11 * 60, 30], 'the owner\'s own daytime meeting');
  assert.equal(where(m, 'mcancelled'), null); assert.equal(where(m, 'mdeclined'), null);
  const all = model('2026-09-28', calWeek.meetings, { showGone: true });
  assert.deepEqual(where(all, 'mcancelled'), ['2026-09-30', 19 * 60 + 30, 30]); assert.ok(where(all, 'mdeclined'));
  // the call hours on each Sri Lanka day: Monday has only its evening (Sunday in the US is closed), Saturday only its small hours (Friday afternoon in the US)
  assert.deepEqual(m.days.map((d) => d.open), [[[1110, 1440]], [[0, 150], [1110, 1440]], [[0, 150], [1110, 1440]], [[0, 150], [1110, 1440]], [[0, 150], [1110, 1440]], [[0, 150]], []]);
  // rows shown: after midnight, the owner's own 11 am meeting, the evening — everything else folded
  assert.deepEqual(m.layout.map((L) => [L.from, L.to, L.top]), [[0, 150, 0], [660, 690, 280], [1110, 1440, 368]]);
  assert.equal(m.gaps.length, 2); assert.equal(m.height, 368 + 330 * 1.6);
  // one label per hour in Sri Lanka time, on the whole US Eastern hours, "day before" after midnight
  assert.deepEqual(m.rows.map((r) => [r.owner, r.us, r.usRel]), [
    ['12:30 am', '3 pm', 'day before'], ['1:30 am', '4 pm', 'day before'], ['11:00 am', '1:30 am', ''],
    ['6:30 pm', '9 am', ''], ['7:30 pm', '10 am', ''], ['8:30 pm', '11 am', ''], ['9:30 pm', '12 pm', ''], ['10:30 pm', '1 pm', ''], ['11:30 pm', '2 pm', '']]);
  assert.equal(m.dst, '', 'no US clock change this week');
  assert.equal(m.nowY, null, '1:30 pm in Colombo is outside the rows: no "now" line');
  assert.equal(model('2026-09-28', calWeek.meetings, { now: new Date('2026-09-29T14:15:00Z') }).nowY, 368 + 75 * 1.6, '7:45 pm → the red now line');
});

test('week grid across US daylight saving: winter hours move one hour later in Colombo; a clock change inside the week is said in words; Friday 4 pm ET lands on Saturday', () => {
  const w = model('2026-11-02', calWinterWeek.meetings);
  assert.deepEqual(where(w, 'mw1'), ['2026-11-03', 19 * 60 + 30, 30], 'Tue 9 am EST → Tue 7:30 pm');
  assert.deepEqual(where(w, 'mw2'), ['2026-11-04', 150, 30], 'Tue 4 pm EST → Wed 2:30 am');
  assert.deepEqual(w.days[1].open, [[0, 210], [1170, 1440]]);
  assert.deepEqual(w.rows.map((r) => [r.owner, r.us]), [['12:30 am', '2 pm'], ['1:30 am', '3 pm'], ['2:30 am', '4 pm'], ['7:30 pm', '9 am'], ['8:30 pm', '10 am'], ['9:30 pm', '11 am'], ['10:30 pm', '12 pm'], ['11:30 pm', '1 pm']]);
  // the week the US clocks go back (Sun 1 Nov 2026): Friday's 4 pm ET call is Saturday 1:30 am in Colombo
  const fri = calWeekModel('2026-10-26', [{ id: 'f', start: '2026-10-30T20:00:00Z', minutes: 30, status: 'confirmed', company: 'X' }], ST, { now: CAL_NOW });
  assert.deepEqual(where(fri, 'f'), ['2026-10-31', 90, 30]);
  assert.equal(fri.dst, '', 'Mon–Fri call hours: every open hour that week is still on summer time');
  // with weekend hours the Sunday evening is already on winter time → said in words
  const every = calWeekModel('2026-10-26', [], calSettings(Object.assign({}, calSettingsFixture, { days: [0, 1, 2, 3, 4, 5, 6] })), { now: CAL_NOW });
  assert.match(every.dst, /^US clocks change this week\. From Sun 1 Nov, the US Eastern times beside the hours are one hour earlier than shown\./);
  assert.deepEqual(every.days[6].open, [[0, 150], [1170, 1440]], 'Sunday: Saturday afternoon on summer time, Sunday morning on winter time');
});

test('the Calendar screen: explainer, meeting link, call hours, "Waiting for your yes" (Sri Lanka time big, US Eastern and their zone small, the note, Yes / Suggest / Decline)', () => {
  const out = renderCalendar(calWeek, { week: '2026-09-28', now: CAL_NOW });
  assert.ok(out.includes('Clients pick a time on your booking page; you say yes here; they get an invite.'));
  assert.ok(out.includes('Calls happen on: <a href="https://meet.google.com/abc-defg-hij" target="_blank" rel="noopener noreferrer">meet.google.com/abc-defg-hij</a>'));
  assert.ok(out.includes('Your call hours: Mon–Fri, 9:00 am – 5:00 pm US Eastern = 6:30 pm – 2:30 am the next morning in Sri Lanka.'));
  assert.ok(renderCalendar(calWinterWeek, { week: '2026-11-02', now: CAL_NOW }).includes('= 7:30 pm – 3:30 am the next morning in Sri Lanka.'), 'US winter');
  assert.ok(renderCalendar(Object.assign({}, calWeek, { settings: Object.assign({}, calSettingsFixture, { meetingLink: null }) }), { week: '2026-09-28', now: CAL_NOW }).includes("no meeting link set yet, so the email says you'll send the link before the call"));
  // requests: waiting for the owner first (oldest first), then the one where he suggested a time
  assert.ok(out.includes('<h3>Waiting for your yes</h3><span class="count">2</span>'));
  const a = out.indexOf('eCreek IT</b>'), b = out.indexOf('Gale Roofing</b>'), c = out.indexOf('Delta Roofing</b>');
  assert.ok(a > 0 && a < b && b < c, 'eCreek, Gale, then Delta (already suggested)');
  assert.ok(out.includes('<div class="cal-req-when">Wed 30 Sep · 11:30 pm <small>your time</small></div><div class="cal-req-us">Wed 2:00 pm US Eastern · Wed 12:00 pm their time (US Mountain) · 30 min</div>'));
  assert.ok(out.includes('<div class="cal-req-when">Fri 2 Oct · 1:30 am <small>your time</small></div><div class="cal-req-us">Thu 4:00 pm US Eastern · Thu 1:00 pm their time (US Pacific) · 15 min</div>'), 'the midnight crossover, said plainly');
  assert.ok(out.includes('<h4 class="cal-req-sub">You suggested another time — waiting for them</h4>') && out.indexOf('cal-req-sub') < out.indexOf('Delta Roofing</b>'), 'the ones waiting for them sit apart, under their own heading');
  assert.ok(out.includes('You suggested Mon 5 Oct · 7:00 pm (your time; Mon 9:30 am US Eastern) — waiting for them to say yes.'));
  const delta = out.slice(out.indexOf('Delta Roofing</b>'), out.indexOf('Your week'));
  assert.ok(!delta.includes('calConfirm(') && delta.includes('>Suggest a different time</button>') && delta.includes('>Say no…</button>'), 'waiting for them: no "Say yes" button to press by mistake');
  assert.ok(out.includes('<div class="cal-note">Can we do a bit earlier?\nThanks! &lt;b&gt;really&lt;/b&gt;</div>'), 'the note: escaped, line breaks kept');
  assert.ok(out.includes('Asked 5 h ago · They picked it on your booking page'));
  assert.ok(out.includes('<button class="btn" onclick="calConfirm(&quot;mreq1&quot;)">Say yes and email them</button><button class="btn ghost" onclick="calOpenSuggest(&quot;mreq1&quot;)">Suggest another time</button><button class="btn ghost" onclick="calOpenDecline(&quot;mreq1&quot;)">Say no…</button>'));
  // a request whose time has passed: no Yes, "Suggest another time" becomes the main button
  const late = renderCalRequest(Object.assign({}, calMeetings.req1, { start: '2026-09-28T13:00:00Z' }), ST, { now: CAL_NOW });
  assert.ok(late.includes('This time has already passed. Suggest another time.') && !late.includes('calConfirm(') && late.includes('<button class="btn" onclick="calOpenSuggest('));
  // the week: toolbar, legend in words, the grid and the phone list are both there (CSS shows one)
  for (const s of ['<b class="cal-range">28 Sep – 4 Oct 2026</b>', 'onclick="calWeekMove(-1)"', 'onclick="calGoToday()">Today</button>', 'onclick="calWeekMove(1)"', '>Add a meeting</button>', '>Block time</button>', 'onchange="calToggleGone(this.checked)">Show cancelled',
    '<i class="cal-sw confirmed"></i>Confirmed', '<i class="cal-sw requested"></i>Waiting for your yes', '<i class="cal-sw suggested"></i>Waiting for them', '<i class="cal-sw held"></i>Call done', '<i class="cal-sw blocked"></i>Busy', '<i class="cal-sw noshow"></i>No-show', 'class="cal-grid-wrap"', 'class="cal-agenda"'])
    assert.ok(out.includes(s), s);
});

test('the grid draws each call sized by its minutes, coloured by status (green / amber / grey / red), in its Sri Lanka column; hours in Sri Lanka time with ET beside them', () => {
  const m = model('2026-09-28', calWeek.meetings);
  const g = renderCalGrid(m);
  assert.ok(g.includes('<div class="cal-corner"><b>Sri Lanka time</b><small>US Eastern (ET) beside it</small></div>'));
  assert.ok(g.includes('<div class="cal-dayhead today">Tue 29 Sep<span class="cal-today-tag">Today</span></div>'));
  assert.ok(g.includes('<div class="cal-hour" style="top:368px"><b>6:30 pm</b><small>9 am ET</small></div>'));
  assert.ok(g.includes('<div class="cal-hour" style="top:48px"><b>12:30 am</b><small>3 pm ET, day before</small></div>'));
  assert.ok(g.includes('<div class="cal-gapnote" style="top:240px;height:40px">No calls</div>'));
  const block = (id) => { const i = g.indexOf(`calOpenMeeting(&quot;${id}&quot;)`); return i < 0 ? '' : g.slice(g.lastIndexOf('<button', i), g.indexOf('</button>', i)); };
  assert.match(block('mconf'), /class="cal-ev confirmed" style="top:368px;height:46px;left:calc\(0% \+ 2px\);width:calc\(100% - 4px\)"/, '30 min = 46 px, green');
  assert.ok(block('mconf').includes('<span class="cal-ev-t">Acme Plumbing</span><span class="cal-ev-s">6:30 pm · Confirmed</span>'), 'who first, then the time and the status in words');
  assert.match(block('mreq2'), /class="cal-ev requested short" style="top:144px;height:22px;/, '15 min = 22 px, amber, 1:30 am');
  assert.ok(!block('mreq2').includes('cal-ev-s') && block('mreq2').includes('<span class="cal-ev-t">Gale Roofing</span>'), 'a 15-minute block has one line: who');
  assert.match(block('mheld'), /class="cal-ev held"/); assert.match(block('mblocked'), /class="cal-ev blocked" style="top:\d+(\.\d)?px;height:94px;/); assert.ok(block('mblocked').includes('<span class="cal-ev-t">Busy</span><span class="cal-ev-s">8:30 pm · Busy</span>'));
  assert.match(block('mnoshow'), /class="cal-ev noshow short"/);
  assert.ok(block('mconf').includes('aria-label="Onboarding call — Acme Plumbing with Ann Lee. Tue 29 Sep, 6:30 pm Sri Lanka time (Tue 9:00 am US Eastern). 30 minutes. Confirmed."'));
  assert.equal(block('mcancelled'), '', 'cancelled is hidden'); assert.equal(block('mdeclined'), '');
  const gone = renderCalGrid(model('2026-09-28', calWeek.meetings, { showGone: true }));
  assert.ok(/class="cal-ev gone"[^>]*onclick="calOpenMeeting\(&quot;mcancelled&quot;\)"/.test(gone), '"Show cancelled" shows them, struck through');
  // columns: the call hours are white (cal-open), the rest grey; Sunday has none
  const cols = g.split('<div class="cal-col');
  assert.equal(cols.length, 8);
  assert.equal((cols[7].match(/cal-open/g) || []).length, 0, 'Sunday: no call hours');
  assert.equal((cols[2].match(/class="cal-open"/g) || []).length, 2, 'Tuesday: after midnight + evening');
  // overlapping calls sit side by side
  const two = calWeekModel('2026-09-28', [{ id: 'a', start: '2026-09-29T13:00:00Z', minutes: 30, status: 'confirmed' }, { id: 'b', start: '2026-09-29T13:15:00Z', minutes: 30, status: 'requested' }], ST, { now: CAL_NOW });
  assert.deepEqual(two.days[1].items.map((x) => [x.m.id, x.lane, x.lanes]), [['a', 0, 2], ['b', 1, 2]]);
});

test('phone: a day-by-day list instead of the grid — every day, calls in time order with ET, big tap targets; the CSS swaps them under 700 px', () => {
  const a = renderCalAgenda(model('2026-09-28', calWeek.meetings));
  const days = [...a.matchAll(/<h4>([^<]+)/g)].map((x) => x[1]);
  assert.deepEqual(days, ['Mon 28 Sep', 'Tue 29 Sep', 'Wed 30 Sep', 'Thu 1 Oct', 'Fri 2 Oct', 'Sat 3 Oct', 'Sun 4 Oct']);
  assert.ok(a.includes('<section class="cal-aday today"><h4>Tue 29 Sep<span class="cal-today-tag">Today</span></h4>'));
  const tue = a.slice(a.indexOf('Tue 29 Sep'), a.indexOf('Wed 30 Sep'));
  assert.ok(tue.indexOf('12:30 am') < tue.indexOf('6:30 pm'), 'in time order');
  assert.ok(tue.includes('<button type="button" class="cal-aitem noshow" onclick="calOpenMeeting(&quot;mnoshow&quot;)"><span class="cal-atime"><b>12:30 am</b><small>Mon 3:00 pm ET</small></span><span class="cal-amain"><b>Fern IT</b><small>Lee Park</small><span class="cal-astatus">No-show · 15 min</span>'));
  assert.ok(a.slice(a.indexOf('Sun 4 Oct')).includes('Nothing booked'));
  assert.equal(renderCalAgenda(model('2026-09-28', [])), '<div class="cal-agenda"><p class="cal-anone">Nothing booked this week.</p></div>');
  const css = fs.readFileSync(path.join(root, 'calendar.css'), 'utf8');
  assert.match(css, /@media\(max-width:700px\)\{\s*\.cal-grid-wrap\{display:none\}\s*\.cal-agenda\{display:block\}/);
  assert.match(css, /\.cal-aitem\{[^}]*min-height:60px/); assert.match(css, /\.cal-req-acts \.btn,[^{]*\{min-height:44px/);
});

test('empty states: nobody waiting, nothing booked, and the machine not answering', async () => {
  const out = renderCalendar({ meetings: [], requests: [], settings: calSettingsFixture, free: [] }, { week: '2026-09-28', now: CAL_NOW });
  assert.ok(out.includes('<div class="tk-allclear">Nobody is waiting for your yes.</div>'));
  assert.ok(out.includes('Nothing booked this week. When a client picks a time on your booking page, it shows up here for your yes.'));
  assert.ok(out.includes('class="cal-grid-wrap"'), 'the empty week still shows the call hours');
  fresh(); offline();
  render('calendar'); await tick();
  assert.equal(el('ptitle').textContent, 'Calendar'); assert.equal(el('psub').textContent, 'Every call, in Sri Lanka time');
  assert.ok(el('calHost').innerHTML.includes("We can't reach the system right now") && el('calHost').innerHTML.includes('onclick="calRetry()"'));
  calendarStopTimer();
});

test('escaping: every machine value is escaped, links only when safe, ids reach handlers only as JSON strings', () => {
  const week = { meetings: [calHostile], requests: [calHostile], settings: Object.assign({}, calSettingsFixture, { meetingLink: 'javascript:alert(5)' }), free: [] };
  const outs = [renderCalendar(week, { week: '2026-09-28', now: CAL_NOW }), renderCalMeeting(calHostile, calSettings(week.settings), { now: CAL_NOW }), renderCalReason('decline', calHostile, ST), renderCalPicker({ mode: 'suggest', id: calHostile.id, week: '2026-09-28', sel: null }, calHostile, week, null, ST, CAL_NOW)];
  for (const o of outs) {
    for (const bad of ['<img', '<script', '<svg onload', '<i>odd', '<u>who', '<b>src', 'href="javascript']) assert.ok(!o.includes(bad), bad);
  }
  assert.ok(outs[0].includes('&lt;img src=x onerror=alert(1)&gt;') && outs[0].includes('&lt;/div&gt;&lt;script&gt;alert(6)&lt;/script&gt;'));
  assert.ok(outs[0].includes('Calls happen on: javascript:alert(5)'), 'an unsafe link is plain text');
  assert.ok(outs[0].includes('onclick="calConfirm(&quot;x\\&quot;\');alert(4);//&quot;)"'), 'the id is a JSON string inside the handler');
  assert.ok(outs[1].includes('openTrial(&quot;ev\\&quot;il&quot;)'));
  assert.ok(!outs[1].includes('mailto:'), 'a broken email is not a link');
  assert.ok(outs[0].includes('<div class="cal-req-us">Wed 9:00 am US Eastern · 30 min</div>'), 'an unknown zone is left out, nothing breaks');
});

test('the panel: who (with a link to their trial), when in Sri Lanka · Eastern · their zone, status in words, the note, history, and the buttons its status allows', () => {
  const req = renderCalMeeting(calMeetings.req1, ST, { now: CAL_NOW });
  assert.ok(req.includes('<h3>Onboarding call — eCreek IT</h3><p>They asked for this time — waiting for your yes</p>'));
  assert.ok(req.includes('<div class="cal-when-big">Wed 30 Sep · 11:30 pm <small>Sri Lanka</small></div><div class="cal-when-small">Wed 2:00 pm US Eastern<br>Wed 12:00 pm their time (US Mountain)</div>'));
  assert.ok(req.includes('<b>eCreek IT</b> — Sam Test <button type="button" class="tk-textbtn cal-trial-link" onclick="closeModal();openTrial(&quot;ecreek-it&quot;)">Open their trial</button>'));
  assert.ok(req.includes('<a href="mailto:sam@ecreek.io">sam@ecreek.io</a>'));
  assert.ok(req.includes('<small>Their note</small><span><span class="cal-note">Can we do a bit earlier?\nThanks! &lt;b&gt;really&lt;/b&gt;</span></span>'));
  assert.ok(req.includes('<li><span>Asked for this time by them</span>'));
  assert.ok(req.includes('<small>Calls happen on</small><span><a href="https://meet.google.com/abc-defg-hij"'));
  const btns = (h) => [...h.matchAll(/<button class="btn[^"]*" onclick="(\w+)\(/g)].map((x) => x[1]).filter((f) => f !== 'closeModal');
  assert.ok(req.includes('<button class="btn ghost" onclick="closeModal()">Close</button></div>'), 'every panel can be closed');
  assert.deepEqual(btns(req), ['calConfirm', 'calOpenSuggest', 'calOpenDecline']);
  const future = renderCalMeeting(Object.assign({}, calMeetings.conf, { start: '2026-10-01T13:00:00Z' }), ST, { now: CAL_NOW });
  assert.deepEqual(btns(future), ['calOpenMove', 'calHeld', 'calNoShow', 'calOpenCancel'], 'confirmed, still ahead: Move first');
  const past = renderCalMeeting(Object.assign({}, calMeetings.conf, { start: '2026-09-28T13:00:00Z' }), ST, { now: CAL_NOW });
  assert.deepEqual(btns(past), ['calHeld', 'calNoShow', 'calOpenMove', 'calOpenCancel'], 'confirmed, time passed: Call done first');
  assert.ok(past.includes('Confirmed — did the call happen? Mark it below'));
  assert.ok(future.includes('<li><span>Asked for this time by them</span>') && future.includes('<li><span>Confirmed by you</span>'));
  assert.deepEqual(btns(renderCalMeeting(calMeetings.blocked, ST, { now: CAL_NOW })), ['calUnblock']);
  const held = renderCalMeeting(calMeetings.held, ST, { now: CAL_NOW });
  assert.deepEqual(btns(held), []); assert.ok(held.includes('<span class="pill grey">Call done</span>') && held.includes('Marked booked on the onboarding card'));
  assert.ok(renderCalMeeting(calMeetings.noshow, ST, { now: CAL_NOW }).includes("<span class=\"pill red\">No-show</span> They didn't show"));
  const gone = renderCalMeeting(calMeetings.cancelled, ST, { now: CAL_NOW });
  assert.ok(gone.includes('<small>Reason</small><span><span class="cal-note">They moved it</span></span>'));
  assert.deepEqual(btns(gone), []);
  const sug = renderCalMeeting(calMeetings.req3, ST, { now: CAL_NOW });
  assert.ok(sug.includes('<p>You suggested this time — waiting for them to say yes</p>') && sug.includes('<div class="cal-when-big">Mon 5 Oct · 7:00 pm <small>Sri Lanka</small></div>'), 'the panel shows the time the meeting holds: the suggested one');
  assert.ok(sug.includes('<small>They first asked for</small><span>Fri 2 Oct · 7:30 pm (Fri 10:00 am US Eastern)</span>') && sug.includes('<span class="pill amber">Waiting for them</span>') && sug.includes('<li><span>Another time suggested by you</span>'));
});

/* ───────────── actions: each posts the contract body ───────────── */
test('Yes / Suggest another time / Decline post {confirm} / {suggest, start from free[]} / {decline, reason} and say what happened in plain words', async () => {
  fresh(); const mc = fakeMachine(); let asked = null; globalThis.confirm = (q) => { asked = q; return true; };
  try {
    render('calendar'); await tick();
    const host = () => el('calHost').innerHTML;
    assert.ok(host().includes('Wed 30 Sep · 11:30 pm'), 'the week loaded');
    const q = mc.gets()[0][2];
    assert.deepEqual([q.get('from'), q.get('to'), q.get('all')], ['2026-09-27T18:30:00.000Z', '2026-10-04T18:30:00.000Z', '1'], 'GET for the visible week, cancelled ones too (for "Show cancelled")');
    // Yes
    await calConfirm('mreq1');
    assert.equal(asked, 'Say yes to Sam Test (eCreek IT) for Wed 30 Sep · 11:30 pm (your time)? They get an email with the time and a calendar invite.');
    assert.deepEqual(mc.last(), { action: 'confirm', id: 'mreq1' });
    assert.ok(el('toast').innerHTML.includes('Confirmed. Sam gets an email with the time and a calendar invite'));
    assert.ok(!cal.reqs.some((m) => m.id === 'mreq1'), 'no longer waiting'); assert.equal(tk.detailAt['ecreek-it'], 0, 'their trial page fetches the booked call next time');
    await tick();
    globalThis.confirm = () => false; const n = mc.posts().length; await calConfirm('mreq2'); assert.equal(mc.posts().length, n, 'cancel sends nothing'); globalThis.confirm = () => true;
    // Suggest another time: the picker opens on the week of their time, shows only open times still ahead
    await calOpenSuggest('mreq2'); await tick();
    let modal = el('modal').innerHTML;
    assert.ok(modal.includes('<h3>Suggest another time</h3><p>Mia Gale (Gale Roofing) asked for Fri 2 Oct · 1:30 am (your time).'));
    assert.ok(modal.includes('<b>28 Sep – 4 Oct 2026</b>') && modal.includes('<h4>Tue 29 Sep</h4>') && modal.includes('<b>7:30 pm</b><small>Tue 10:00 am ET</small>'));
    assert.ok(!modal.includes('<h4>Mon 28 Sep</h4>'), 'a slot already past is not offered');
    assert.ok(modal.includes('<h4>Fri 2 Oct</h4>') && modal.includes('<b>1:00 am</b><small>Thu 3:30 pm ET</small>'), 'after midnight in Colombo, the day before in the US');
    assert.ok(modal.includes('onclick="calSendPick()" disabled>Suggest this time</button>'));
    const before = mc.posts().length; await calSendPick(); assert.equal(mc.posts().length, before); assert.ok(el('toast').innerHTML.includes('Pick a time first'));
    calPickSlot('2026-09-30T13:00:00Z'); modal = el('modal').innerHTML;
    assert.ok(modal.includes('class="cal-slot sel" aria-pressed="true"') && modal.includes('Chosen: <b>Wed 30 Sep · 6:30 pm</b> (Wed 9:00 am US Eastern · Wed 6:00 am their time (US Pacific))'));
    await calSendPick();
    assert.deepEqual(mc.last(), { action: 'suggest', id: 'mreq2', start: '2026-09-30T13:00:00Z' });
    assert.ok(el('toast').innerHTML.includes('Sent. Mia can say yes to Wed 30 Sep · 6:30 pm (Wed 9:00 am US Eastern) with one click'));
    assert.ok(!el('modalWrap').classList.contains('open'), 'the picker closes');
    assert.ok(cal.reqs.some((m) => m.id === 'mreq2' && m.proposed === '2026-09-30T13:00:00Z'), 'still a request, now waiting for them');
    // the picker walks weeks
    await calOpenSuggest('mreq1'); const g = mc.gets().length; await calPickWeek(1);
    assert.equal(mc.gets().length, g + 1); assert.equal(mc.gets().pop()[2].get('from'), '2026-10-04T18:30:00.000Z');
    assert.ok(el('modal').innerHTML.includes('<b>5 Oct – 11 Oct 2026</b>'));
    closeModal();
    // Say no: a reason is optional (the machine has a kind default); ready-made ones fill the box
    calOpenDecline('mreq1');
    assert.ok(el('modal').innerHTML.includes('<h3>Say no to Sam Test (eCreek IT)</h3>') && el('modal').innerHTML.includes('A short reason, if you like') && el('modal').innerHTML.includes('>Say no and email them</button>'));
    el('calReason').value = '   '; await calSendReason('decline', 'mreq1');
    assert.deepEqual(mc.last(), { action: 'decline', id: 'mreq1' }, 'no reason typed: none is sent');
    assert.ok(el('toast').innerHTML.includes('Done. You said no'));
    el('calReason').value = 'x'.repeat(301); const d0 = mc.posts().length; await calSendReason('decline', 'mreq1');
    assert.equal(mc.posts().length, d0); assert.ok(el('calReasonErr').textContent.startsWith('Keep it short'));
    calReasonUse("That time doesn't work for me. Please pick another time on the booking page.");
    await calSendReason('decline', 'mreq1');
    assert.deepEqual(mc.last(), { action: 'decline', id: 'mreq1', reason: "That time doesn't work for me. Please pick another time on the booking page." });
    await calSendReason('delete', 'mreq1'); assert.equal(mc.last().action, 'decline', 'only decline / cancel are ever posted');
    // the slot was just taken (409): the machine's words, the open times fetched again, the picker stays
    await calOpenSuggest('mreq2'); calPickSlot('2026-09-30T13:30:00Z');
    mc.state.reply = { status: 409, body: { ok: false, error: 'That time was just taken' } };
    const g2 = mc.gets().length; await calSendPick(); await tick();
    assert.ok(el('toast').innerHTML.includes('Not sent: That time was just taken'));
    assert.ok(mc.gets().length > g2, 'open times fetched again'); assert.ok(el('modalWrap').classList.contains('open'));
    mc.state.reply = null; closeModal();
  } finally { offline(); calendarStopTimer(); trialsStopTimer(); }
});

test('Move / Call done / No-show / Cancel / Unblock post the contract bodies', async () => {
  fresh(); const mc = fakeMachine(); let asked = null; globalThis.confirm = (q) => { asked = q; return true; };
  try {
    render('calendar'); await tick();
    calOpenMeeting('mconf');
    assert.ok(el('modal').innerHTML.includes('<h3>Onboarding call — Acme Plumbing</h3>'));
    await calOpenMove('mconf'); await tick();
    assert.ok(el('modal').innerHTML.includes('<h3>Move the call</h3><p>With Ann Lee (Acme Plumbing), now Tue 29 Sep · 6:30 pm (your time).'));
    calPickSlot('2026-09-30T13:30:00Z'); await calSendPick();
    assert.deepEqual(mc.last(), { action: 'move', id: 'mconf', start: '2026-09-30T13:30:00Z' });
    assert.ok(el('toast').innerHTML.includes('Moved to Wed 30 Sep · 7:00 pm (Wed 9:30 am US Eastern). Ann gets an email with the new time'));
    assert.deepEqual(where(model('2026-09-28', cal.weeks['2026-09-28'].meetings), 'mconf'), ['2026-09-30', 19 * 60, 30], 'the grid shows the new time at once');
    asked = null; await calHeld('mconf');
    assert.deepEqual(mc.last(), { action: 'held', id: 'mconf' }); assert.equal(asked, null, 'no question for Call done'); assert.ok(el('toast').innerHTML.includes('Marked: the call happened'));
    await calNoShow('mconf');
    assert.deepEqual(mc.last(), { action: 'noShow', id: 'mconf' }); assert.equal(asked, "Mark that Ann Lee (Acme Plumbing) didn't show up?");
    calOpenCancel('mconf'); assert.ok(el('modal').innerHTML.includes('<h3>Cancel the call with Ann Lee (Acme Plumbing)</h3>'));
    el('calReason').value = 'Something came up. Please pick a new time on the booking page.'; await calSendReason('cancel', 'mconf');
    assert.deepEqual(mc.last(), { action: 'cancel', id: 'mconf', reason: 'Something came up. Please pick a new time on the booking page.' });
    assert.ok(el('toast').innerHTML.includes('Call cancelled'));
    await calUnblock('mblocked');
    assert.deepEqual(mc.last(), { action: 'unblock', id: 'mblocked' }); assert.ok(el('toast').innerHTML.includes('Unblocked. That time is open again'));
  } finally { offline(); calendarStopTimer(); trialsStopTimer(); }
});

test('Add a meeting (client from the trials list or none, Sri Lanka date + time → UTC) and Block time post the contract bodies', async () => {
  fresh(); const mc = fakeMachine();
  try {
    trialsIngestHub(simpleHub); render('calendar'); await tick();
    calOpenAdd();
    const modal = el('modal').innerHTML;
    assert.ok(modal.includes('<option value="">No client (my own meeting)</option>') && modal.includes('<option value="ecreek-it">eCreek IT — Sam Test</option>'));
    assert.ok(modal.includes('id="calAddDate" type="date" value="2026-09-29"') && modal.includes('id="calAddTime" type="time" step="300" value="19:30"'), 'starts on the next open time');
    assert.ok(modal.includes('<label for="calAddDate">Date (Sri Lanka)</label>') && modal.includes('<option value="30" selected>30 minutes</option><option value="15">15 minutes</option>'));
    el('calAddDate').value = ''; el('calAddTime').value = ''; const n = mc.posts().length; await calSubmitAdd();
    assert.equal(mc.posts().length, n); assert.equal(el('calAddErr').textContent, 'Pick the date and the time first.');
    el('calAddDate').value = '2026-09-30'; el('calAddTime').value = '19:30'; calPreview('calAdd');
    assert.equal(el('calAddPrev').textContent, 'That is Wed 10:00 am US Eastern (Wed 30 Sep, 7:30 pm in Sri Lanka).');
    el('calAddClient').value = ''; el('calAddTitle').value = ''; await calSubmitAdd();
    assert.equal(mc.posts().length, n); assert.equal(el('calAddErr').textContent, 'Write what it is, e.g. "Call with my accountant".');
    el('calAddClient').value = 'ecreek-it'; el('calAddMin').value = '15'; await calSubmitAdd();
    assert.deepEqual(mc.last(), { action: 'add', clientId: 'ecreek-it', title: 'Call — eCreek IT', start: '2026-09-30T14:00:00.000Z', minutes: 15 });
    assert.ok(el('toast').innerHTML.includes('Added: Wed 30 Sep, 7:30 pm'));
    calOpenAdd(); el('calAddClient').value = ''; el('calAddTitle').value = 'Call with my accountant'; el('calAddDate').value = '2026-10-03'; el('calAddTime').value = '00:30'; el('calAddMin').value = '30';
    await calSubmitAdd();
    assert.deepEqual(mc.last(), { action: 'add', clientId: null, title: 'Call with my accountant', start: '2026-10-02T19:00:00.000Z', minutes: 30 }, 'Sat 12:30 am in Colombo is Friday 19:00 UTC');
    calOpenBlock();
    assert.ok(el('modal').innerHTML.includes('<h3>Block time</h3>') && el('modal').innerHTML.includes('<option value="120">2 hours</option>'));
    el('calBlkDate').value = '2026-10-01'; el('calBlkTime').value = '20:30'; el('calBlkMin').value = '120';
    await calSubmitBlock();
    assert.deepEqual(mc.last(), { action: 'block', start: '2026-10-01T15:00:00.000Z', minutes: 120 });
    assert.ok(el('toast').innerHTML.includes('Blocked: Thu 1 Oct, 8:30 pm'));
    el('calBlkMin').value = '999'; await calSubmitBlock(); assert.equal(mc.last().minutes, 30, 'an odd length falls back to 30 minutes');
  } finally { offline(); calendarStopTimer(); trialsStopTimer(); }
});

/* ───────────── navigation + shell ───────────── */
test('week buttons: ◀ ▶ and Today ask the machine for that week; while a new week loads the requests stay on screen', async () => {
  fresh(); const mc = fakeMachine();
  try {
    render('calendar'); await tick();
    const p = calWeekMove(1);
    assert.ok(el('calHost').innerHTML.includes('Loading this week…') && el('calHost').innerHTML.includes('Waiting for your yes'), 'the requests stay while the next week loads');
    assert.ok(el('calHost').innerHTML.includes('<b class="cal-range">5 Oct – 11 Oct 2026</b>'));
    await p;
    assert.equal(mc.gets().pop()[2].get('from'), '2026-10-04T18:30:00.000Z');
    await calWeekMove(-1); await calWeekMove(-1);
    assert.equal(cal.week, '2026-09-21'); assert.equal(mc.gets().pop()[2].get('from'), '2026-09-20T18:30:00.000Z');
    await calGoToday(); assert.equal(cal.week, '2026-09-28');
    calToggleGone(true); assert.ok(el('calHost').innerHTML.includes('Iris Dental')); calToggleGone(false);
  } finally { offline(); calendarStopTimer(); trialsStopTimer(); }
});

test('shell: Calendar is the second of the four places, with an amber badge for the requests waiting; #calendar deep links; ⌘K; the bell', async () => {
  fresh(); const mc = fakeMachine();
  try {
    assert.equal(views.calendar.title, 'Calendar');
    assert.deepEqual(navItems().map((i) => i.view), ['trials', 'calendar', 'inquiries', 'settings']);
    render('calendar'); await tick();
    const item = navItems()[1];
    assert.equal(item.label, 'Calendar'); assert.equal(item.icon, I.calendar); assert.equal(item.badge, 2); assert.equal(item.badgeTitle, '2 waiting for your yes'); assert.equal(item.tone, 'amber');
    for (const id of ['navArea', 'tabBar']) assert.ok(el(id).innerHTML.includes(`onclick="render('calendar')" aria-label="Calendar — 2 waiting for your yes" aria-current="page">`) && el(id).innerHTML.includes('<span class="badge amber" title="2 waiting for your yes" aria-hidden="true">2</span>'), id);
    assert.deepEqual(parseDeepLink('#calendar'), { view: 'calendar' });
    assert.deepEqual(parseDeepLink('/#calendar/mreq1'), { view: 'calendar', id: 'mreq1' });
    assert.equal(parseDeepLink('#calendar/<x>'), null);
    render('trials'); goDeepLink({ view: 'calendar', id: 'mreq2' }); await tick();
    assert.equal(currentView, 'calendar'); assert.equal(cal.focus, 'mreq2');
    assert.ok(el('calHost').innerHTML.includes('class="card cal-req focus" id="calReq-mreq2"'), 'that request is highlighted');
    goDeepLink({ view: 'calendar', id: 'mconf' }); await tick();
    assert.ok(el('modalWrap').classList.contains('open') && el('modal').innerHTML.includes('<h3>Onboarding call — Acme Plumbing</h3>'), 'any other meeting opens in its panel');
    closeModal();
    renderCmdk('');
    for (const s of ['<b>Calendar</b>', '<b>Add a meeting</b>', '<b>Block time</b>']) assert.ok(el('cmdkList').innerHTML.includes(s), s);
    const bell = computeNotifs().filter((x) => /asked for a time/.test(x.t));
    assert.deepEqual(bell.map((x) => [x.t, x.s]), [['Sam Test (eCreek IT) asked for a time', 'Wed 30 Sep · 11:30 pm your time · say yes in the Calendar'], ['Mia Gale (Gale Roofing) asked for a time', 'Fri 2 Oct · 1:30 am your time · say yes in the Calendar']]);
    // signing out forgets it all
    await logout();
    assert.deepEqual([cal.reqs.length, Object.keys(cal.weeks).length, cal.timer], [0, 0, null]);
    supa.session = { access_token: 'test-token' };
  } finally { offline(); calendarStopTimer(); trialsStopTimer(); }
});

test('refresh: the Calendar refreshes itself every minute (never with a panel open); other screens ask for the requests at most once a minute', async () => {
  fresh(); const mc = fakeMachine();
  try {
    render('trials'); await tick();
    assert.equal(mc.gets().length, 1, 'the Trials list asks once (for the sidebar badge and the rows)');
    render('trialAlerts'); render('trials'); await tick();
    assert.equal(mc.gets().length, 1, 'not again within the minute');
    render('calendar'); await tick();
    assert.ok(cal.timer, 'the Calendar\'s own refresh runs');
    const n = mc.gets().length; openModal('<p>panel</p>'); await calTick(); assert.equal(mc.gets().length, n, 'not while a panel is open');
    closeModal(); await calTick(); assert.equal(mc.gets().length, n + 1);
    render('trials'); assert.equal(cal.timer, null, 'leaving the Calendar stops it');
  } finally { offline(); calendarStopTimer(); trialsStopTimer(); }
});

test('Trials list + trial page: a client who asked for a time says "They asked for … — say yes in the Calendar" with a link there', async () => {
  fresh(); const mc = fakeMachine();
  try {
    await calLoad('2026-09-28');
    const list = renderTrialList(simpleHub, {});
    assert.ok(list.includes('<div class="cal-ask-wrap"><button type="button" class="tk-person needs" onclick="openTrial(&quot;ecreek-it&quot;)">'));
    assert.ok(list.includes('<button type="button" class="cal-rowask" onclick="openCalendar(&quot;mreq1&quot;)"><span>They asked for Wed 30 Sep · 11:30 pm (your time) — say yes in the Calendar</span>'));
    assert.ok(list.includes('onclick="openCalendar(&quot;mreq2&quot;)"'), 'Gale Roofing too');
    assert.ok(!list.includes('openCalendar(&quot;mreq3&quot;)'), 'Delta: the owner already suggested a time — nothing to do');
    assert.equal((list.match(/cal-ask-wrap/g) || []).length, 2, 'only the rows with a request');
    const said = calRowAsk('ecreek-it', { label: 'They asked for Tue 2 pm ET — say yes in the Calendar', next: '' });
    assert.ok(said.includes('<span>Open the Calendar to say yes</span>'), 'the machine already said it: just the link');
    // the trial page: saying yes to the time is the big button at the top — said once, not a second card
    const page = renderTrialDetail(ecreekDetail, 'overview', { now: CAL_NOW });
    assert.ok(page.includes('<p class="tk-q-say">Sam asked for a call on Wed 30 Sep · 11:30 pm (your time). Say yes, or suggest another time.</p><button type="button" class="btn tk-primary" onclick="openCalendar(&quot;mreq1&quot;)">Say yes to their call time</button>'));
    assert.ok(!page.includes('cal-trial-ask'));
    // a new application outranks it: then the time they asked for still shows, as its own card above the call
    const both = Object.assign({}, ecreekDetail, { application: Object.assign({}, ecreekDetail.application, { review: 'pending' }) });
    const p2 = renderTrialDetail(both, 'overview', { now: CAL_NOW });
    assert.ok(p2.includes('>Read the application and say yes or no</button>'));
    assert.ok(p2.includes('<div class="card cal-trial-ask"><div class="cal-trial-ask-main"><b>Sam asked for a call: Wed 30 Sep · 11:30 pm (your time)</b><small>Wed 2:00 pm US Eastern · 30 min · say yes in the Calendar</small></div><button class="btn" onclick="openCalendar(&quot;mreq1&quot;)">Open the Calendar</button></div>'));
    assert.ok(p2.indexOf('cal-trial-ask') < p2.indexOf('tkOcHost'), 'above the onboarding call card');
    calendarForget();
    assert.ok(!renderTrialList(simpleHub, {}).includes('cal-ask'), 'no calendar data → the list is unchanged');
  } finally { offline(); calendarStopTimer(); trialsStopTimer(); }
});

test('files: calendar.js + calendar.css are loaded by index.html (after trials.js, before push.js) and syntax-checked by npm run check', () => {
  assert.ok(html.includes('<link rel="stylesheet" href="trials.css">\n<link rel="stylesheet" href="calendar.css">'));
  assert.ok(html.indexOf('<script src="inquiries.js"></script>') < html.indexOf('<script src="calendar.js"></script>') && html.indexOf('<script src="calendar.js"></script>') < html.indexOf('<script src="push.js"></script>'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.check.includes('node --check calendar.js'));
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.ok(/script-src 'self'/.test(vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value), 'same-origin scripts are allowed by the CSP');
});
