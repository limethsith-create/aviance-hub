/* Tests for "Book a call" (calendar.js §8). Same set-up as calendar.test.mjs; the machine is a fake fetch. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAL_NOW, calSettingsFixture, calWeek } from './fixtures.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const elements = {};
function fakeEl(id) {
  const el = { id, tagName: 'DIV', value: '', defaultValue: '', checked: false, innerHTML: '', outerHTML: '', textContent: '', style: {}, type: '', disabled: false, _classes: new Set(),
    querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; }, focus() {}, select() {}, submit() {}, addEventListener() {}, scrollIntoView() {}, closest() { return null; } };
  el.classList = { add: (c) => el._classes.add(c), remove: (c) => el._classes.delete(c), contains: (c) => el._classes.has(c), toggle(c, f) { const on = f === undefined ? !el._classes.has(c) : !!f; on ? el._classes.add(c) : el._classes.delete(c); return on; } };
  return el;
}
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, body: fakeEl('body'), getElementById: el, createElement: () => fakeEl(''), querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.location = { hash: '', origin: 'https://aviance.store', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
globalThis.confirm = () => true; globalThis.prompt = () => 'a reason';
globalThis.addEventListener = () => {};
const supa = { session: { access_token: 'test-token' }, user: null, profile: null };
const fakeSb = { auth: { getSession: async () => ({ data: { session: supa.session } }), getUser: async () => ({ data: { user: supa.user } }), signInWithPassword: async () => ({ error: null }), signOut: async () => {}, resetPasswordForEmail: async () => ({ error: null }) },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: supa.profile }) }) }) }) };
globalThis.supabase = { createClient: () => fakeSb };

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const shell = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="trials.js">'));
vm.runInThisContext(shell, { filename: 'index.html (inline script)' });
for (const f of ['trials.js', 'inquiries.js', 'calendar.js', 'messages.js', 'autobuy.js']) vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
after(() => { trialsStopTimer(); calendarStopTimer(); });

const fresh = () => { calendarForget(); trialsForget(); authUser = { uid: 'u1', name: 'Owner', role: 'admin', email: 'owner@example.com' }; cal.now = CAL_NOW.toISOString(); cal.settings = calSettingsFixture; };
const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const PREVIEW = { ok: true, theirTz: 'America/Chicago', tzFrom: 'phone', website: 'acme.com', websiteFrom: 'email', whenHost: 'Wednesday at 9:00 AM EST', whenTheirs: 'Tuesday at 8:00 PM CST', warnings: [{ code: 'clash', message: 'That overlaps another meeting at 9 am.' }] };
function machine(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); const body = init && init.body ? JSON.parse(init.body) : null;
    if (u.pathname === '/api/mc/inquiries') { calls.push(body); return handler(body); }
    if (u.pathname === '/api/mc/calendar') return reply(200, calWeek);
    return reply(200, { ok: true });
  };
  return calls;
}
const fill = (o) => { Object.keys(elements).forEach((k) => { if (/^cb/.test(k)) elements[k].value = ''; }); Object.entries(o).forEach(([k, v]) => { el(k).value = v; }); };
const GOOD = { cbName: 'Dana Smith', cbEmail: 'dana@acme.com', cbDate: '2026-09-30', cbTime: '19:00', cbCompany: '<b>Acme</b>' };
const toasts = []; const realToast = globalThis.toast;
globalThis.toast = (m) => { toasts.push(m); };
let opened = null; globalThis.openInquiry = (id) => { opened = id; };

test('the Calendar shows a clear "Book a call" button', () => {
  fresh();
  const h = renderCalendar(calWeek, { now: CAL_NOW });
  assert.match(h, /<button class="btn cal-bookbtn" onclick="calOpenBook\(\)">Book a call<\/button>/);
  const form = renderCalBook({ date: '2026-09-30', time: '19:00' }, calSettingsNow());
  for (const id of ['cbName', 'cbEmail', 'cbDate', 'cbTime', 'cbCompany', 'cbWebsite', 'cbTz', 'cbState', 'cbPhone', 'cbSells', 'cbPlan', 'cbNotes']) assert.ok(form.includes('id="' + id + '"'), id);
  assert.match(form, /Starter/); assert.match(form, /Sri Lanka/);
});

test('required fields are checked before anything is posted', async () => {
  fresh(); openModal(renderCalBook({ date: '', time: '' }, calSettingsNow()));
  const calls = machine(() => reply(200, { ok: true, id: 'i1' }));
  fill({}); let r = await calBookSave(); assert.match(el('cbErr').textContent, /their name/);
  fill({ cbName: 'Dana' }); await calBookSave(); assert.match(el('cbErr').textContent, /their email/);
  fill({ cbName: 'Dana', cbEmail: 'dana@' }); await calBookSave(); assert.match(el('cbErr').textContent, /email/);
  fill({ cbName: 'Dana', cbEmail: 'dana@acme.com' }); await calBookSave(); assert.match(el('cbErr').textContent, /date and the time/);
  assert.equal(calls.length, 0);
});

test('bookCheck sends the booking in UTC and the preview shows both times, sources and warnings (escaped)', async () => {
  fresh(); openModal(renderCalBook({ date: '', time: '' }, calSettingsNow()));
  const calls = machine(() => reply(200, PREVIEW));
  fill(Object.assign({ cbPhone: '512-555-0100', cbPlan: 'growth' }, GOOD));
  await calBookCheckNow();
  assert.equal(calls[0].action, 'bookCheck');
  assert.deepEqual(calls[0].booking, { name: 'Dana Smith', email: 'dana@acme.com', start: '2026-09-30T13:30:00.000Z', company: '<b>Acme</b>', phone: '512-555-0100', plan: 'growth' });
  const prev = el('cbPrev').innerHTML;
  assert.match(prev, /Your time:<\/b> Wednesday at 9:00 AM EST · <b>Their time:<\/b> Tuesday at 8:00 PM CST/);
  assert.match(prev, /guessed from the phone number/); assert.match(prev, /acme\.com \(from their email\)/);
  assert.match(el('cbWarn').innerHTML, /overlaps another meeting/);
  assert.ok(!/class="cal-book-line"[^>]*><b>Acme/.test(prev));
  assert.match(renderCalBookPreview({ theirTz: 'America/New_York', tzFrom: 'default', website: null, websiteFrom: null, whenHost: 'a', whenTheirs: 'b' }), /US Eastern, as nothing was given/);
  assert.ok(!renderCalBookPreview({ whenHost: '<img src=x>', whenTheirs: 'b' }).includes('<img'));
});

test('409 shows the warnings and "Book it anyway", which resends with force:true; success toasts and opens the booking', async () => {
  fresh(); openModal(renderCalBook({ date: '', time: '' }, calSettingsNow())); toasts.length = 0; opened = null;
  const calls = machine((b) => b.force ? reply(200, { ok: true, id: 'inq-7', emailed: true }) : reply(409, { warnings: [{ code: 'outside_hours', message: 'That is outside your call hours.' }] }));
  fill(GOOD);
  let r = await calBookSave();
  assert.equal(r.status, 409); assert.equal(calls[0].force, undefined);
  assert.match(el('cbWarn').innerHTML, /outside your call hours/); assert.match(el('cbAnyway').innerHTML, /Book it anyway/);
  assert.equal(opened, null);
  r = await calBookSave(true);
  assert.equal(calls[1].force, true); assert.equal(calls[1].action, 'book');
  assert.deepEqual(toasts, ['Booked — the confirmation email is on its way']);
  assert.equal(opened, 'inq-7');
});

test('a 400 shows the machine\'s error and books nothing', async () => {
  fresh(); openModal(renderCalBook({ date: '', time: '' }, calSettingsNow())); toasts.length = 0; opened = null;
  machine(() => reply(400, { error: "That email address doesn't look right." }));
  fill(GOOD);
  const r = await calBookSave();
  assert.equal(r.status, 400); assert.equal(el('cbErr').textContent, "That email address doesn't look right.");
  assert.equal(opened, null); assert.deepEqual(toasts, []);
});
