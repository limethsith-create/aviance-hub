/* Tests for the reply bot: the drafting rules (supabase/functions/bot-draft/rules.mjs, the pure part the edge
   function imports) and the Replies screen (drafts.js) with a fake `sb`. Run with:  npm test   No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../supabase/functions/bot-draft/rules.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── the rules ───────────── */
const NOW = new Date('2026-11-24T15:00:00Z');   // a Tuesday
const STEPS = [
  { step: 'kickoff', title: 'Kickoff call', position: 1, planned_on: '2026-11-26', status: 'done' },
  { step: 'research', title: 'Research', position: 2, planned_on: '2026-11-28', status: 'doing' },
  { step: 'testing', title: 'Market testing', position: 3, planned_on: '2026-12-05', status: 'todo' },
  { step: 'build', title: 'Build', position: 4, planned_on: '2026-12-07', status: 'todo' },
  { step: 'onboarding', title: 'Onboarding call', position: 5, planned_on: '2026-12-07', status: 'todo' },
  { step: 'launch', title: 'Launch', position: 6, planned_on: '2026-12-08', status: 'todo' },
];
const base = (over = {}) => ({
  firstName: 'sam lee', timezone: 'America/New_York', now: NOW,
  meetings: [{ kind: 'onboarding', title: 'Kickoff — Stone Roofing', starts_at: '2026-11-26T15:00:00Z', minutes: 45, status: 'booked', meet_link: 'https://meet.google.com/abc-defg-hij' }],
  invoices: [{ number: 'AV-0012', amount: 2500, currency: 'USD', status: 'paid', issued_on: '2026-11-20', due_on: '2026-11-27', paid_at: '2026-11-22T10:00:00Z' }],
  journey: R.journeySummary(STEPS, '2026-11-24'),
  testing: [], offers: [], approvals: [],
  ...over,
});
const reply = (text, over) => R.draftReply({ ...base(over), text });
/* the style rules, checked on every draft */
function casual(body) {
  assert.ok(body.length > 0 && body.length < 220, 'short: ' + body);
  const letters = body.replace(/https?:\/\/\S+/g, '').replace(/\bAV-\d+\b/g, '').replace(/\b(Sam|Dana)\b/g, '').replace(/\bangle [A-Z]\b/g, '').replace(/\b(ET|CT|MT|PT|GMT[+-]?\d*)\b/g, '');
  assert.equal(letters, letters.toLowerCase(), 'lowercase apart from names, links, invoice numbers, zones: ' + body);
  assert.ok(((body.match(/\p{Extended_Pictographic}/gu)) || []).length <= 1, 'at most one emoji');
  assert.doesNotMatch(body, /refund|discount|money back|guarantee/i, 'no money promises');
  assert.doesNotMatch(body, /\bLee\b/, 'first name only');
}

test('classify: the common intents', () => {
  const cases = {
    call: ["when's my call?", 'what time is the kickoff', 'can u send the meet link', 'when do we meet'],
    invoice: ['is the invoice paid?', 'how much do i owe', 'did my payment go through'],
    receipt: ['can u send me a receipt', 'i need a receipt for my accountant'],
    next: ["what's next?", 'next steps?', 'when do we launch', 'where are we at'],
    testing: ["how's testing going", 'any replies yet?', 'can i see the numbers'],
    thanks: ['thanks!', 'thx', 'thank you 🙏', 'perfect', 'sounds good'],
    other: ['can we change the logo on the site', '', 'my dog ate my homework'],
  };
  for (const [intent, texts] of Object.entries(cases)) for (const t of texts) assert.equal(R.classify(t), intent, t);
});

test('call: the real booked time in their zone + the meet link; not booked -> no invented date', () => {
  const a = reply("when's my call?");
  assert.equal(a.intent, 'call');
  assert.equal(a.body, 'hey Sam, ur kickoff is thu nov 26, 10am ET — link: https://meet.google.com/abc-defg-hij');
  casual(a.body);
  const london = reply("when's my call?", { timezone: 'Europe/London' });
  assert.match(london.body, /thu nov 26, 3pm GMT/);
  const tmrw = reply('what time is the call', { meetings: [{ title: 'Onboarding call — Stone Roofing', starts_at: '2026-11-25T19:30:00Z', status: 'booked', meet_link: null }] });
  assert.equal(tmrw.body, 'hey Sam, ur onboarding call is tmrw, 2:30pm ET — the meet link lands here before the call');
  const open = reply("when's the call", { meetings: [], offers: [{ status: 'open', kind: 'kickoff' }] });
  assert.match(open.body, /pick one of the times i sent above \(reply 1, 2 or 3\)/);
  const none = reply("when's the call", { meetings: [] });
  assert.equal(none.body, "hey Sam, not booked yet, i'll send u a few times for it shortly");
  assert.doesNotMatch(none.body, /\d/);
  // a past or cancelled call is not "the" call
  const past = reply("when's the call", { meetings: [{ title: 'Kickoff', starts_at: '2026-11-20T15:00:00Z', status: 'held' }, { title: 'Kickoff', starts_at: '2026-11-30T15:00:00Z', status: 'cancelled' }] });
  assert.match(past.body, /not booked yet/);
  [a, london, tmrw, open, none].forEach((x) => casual(x.body));
});

test('invoice and receipt: the real number and amount, never a promise about money', () => {
  const paid = reply('is the invoice paid?');
  assert.equal(paid.body, 'hey Sam, invoice AV-0012 ($2,500) is paid, all good on ur side thx');
  const due = reply('how much do i owe', { invoices: [{ number: 'AV-0013', amount: 1800, currency: 'USD', status: 'sent', issued_on: '2026-11-23', due_on: '2026-11-30' }, { number: 'AV-0012', amount: 2500, status: 'paid', issued_on: '2026-11-20' }] });
  assert.match(due.body, /^hey Sam, invoice AV-0013 is \$1,800, due nov 30\. the pay details are on the invoice link/);
  const gbp = reply('invoice?', { invoices: [{ number: 'AV-0020', amount: 900, currency: 'GBP', status: 'sent', issued_on: '2026-11-23' }] });
  assert.match(gbp.body, /£900/);
  const rec = reply('can u send me a receipt');
  assert.equal(rec.body, 'hey Sam, sure — ur receipt for invoice AV-0012 ($2,500, paid nov 22) is coming over shortly');
  const noPay = reply('can u send me a receipt', { invoices: [{ number: 'AV-0013', amount: 1800, status: 'sent' }] });
  assert.match(noPay.body, /i don't see a payment on our side yet/);
  const none = reply('is the invoice paid', { invoices: [] });
  assert.doesNotMatch(none.body, /\$|\d/);
  [paid, due, gbp, rec, noPay, none].forEach((x) => casual(x.body));
});

test("what's next: the journey's next step, its planned day and the launch countdown", () => {
  const a = reply("what's next?");
  assert.equal(a.body, "hey Sam, we're on research (ur market, icp + a few angles) now, planned to wrap nov 28 · launch in 14 days");
  const steps2 = STEPS.map((s) => (s.step === 'research' ? { ...s, status: 'done' } : s));
  const b = reply('next steps?', { journey: R.journeySummary(steps2, '2026-11-24') });
  assert.equal(b.body, 'hey Sam, next up is market testing on our warmed inboxes, planned for dec 5 · launch in 14 days');
  // a late step: no date that has already gone by
  const c = reply("what's next", { journey: R.journeySummary(STEPS, '2026-11-30') });
  assert.equal(c.body, "hey Sam, we're on research (ur market, icp + a few angles) now · launch in 8 days");
  assert.match(c.reason, /late/);
  const live = reply("what's next", { journey: R.journeySummary(STEPS.map((s) => ({ ...s, status: 'done' })), '2026-12-09') });
  assert.match(live.body, /ur live, month one is running/);
  const noJ = reply("what's next", { journey: null });
  assert.equal(noJ.body, 'hey Sam, ' + R.FALLBACK);
  [a, b, c, live, noJ].forEach((x) => casual(x.body));
});

test('testing: the logged numbers, added up, with the leading angle', () => {
  const t = reply("how's testing going", { testing: [{ on_date: '2026-12-01', sent: 60, replies: 2, leading_angle: 'angle A' }, { on_date: '2026-12-02', sent: 60, replies: 2 }, { on_date: '2026-12-03', sent: 60, replies: 3, leading_angle: 'angle B' }] });
  assert.equal(t.body, 'hey Sam, day 3 of testing: 180 sent · 7 replies · angle B leading');
  const one = reply('any replies yet?', { testing: [{ on_date: '2026-12-01', sent: 40, replies: 1 }] });
  assert.equal(one.body, 'hey Sam, day 1 of testing: 40 sent · 1 reply');
  const notYet = reply("how's testing going");
  assert.match(notYet.body, /testing hasn't started yet/);
  [t, one, notYet].forEach((x) => casual(x.body));
});

test('thanks and anything else: short, casual, first name only', () => {
  assert.equal(reply('thanks!').body, 'anytime Sam! shout if u need anything');
  assert.equal(reply('thx', { firstName: '' }).body, 'anytime! shout if u need anything');
  const o = reply('can we change the logo on the site');
  assert.equal(o.body, 'hey Sam, got it, will get back to u on this shortly');
  assert.equal(o.intent, 'other'); assert.ok(o.reason);
  assert.equal(reply('hmm', { firstName: null }).body, 'hey, ' + R.FALLBACK);
  casual(o.body);
});

test('journeySummary: late is computed, next step and days to launch', () => {
  const j = R.journeySummary(STEPS, '2026-11-29');
  assert.equal(j.next_step, 'research');
  assert.equal(j.launch_on, '2026-12-08');
  assert.equal(j.days_to_launch, 9);
  assert.deepEqual(j.steps.filter((s) => s.late).map((s) => s.step), ['research']);
  assert.equal(R.journeySummary([], '2026-11-29').next_step, null);
});

test('the model: prompt carries the style rules and only real data; its text is cleaned', () => {
  const p = R.buildPrompt({ ...base(), text: 'when is my call', history: [{ who: 'client', body: 'hi' }, { who: 'us', body: 'hey!' }], company: 'Stone Roofing' });
  assert.match(p.system, /lowercase/); assert.match(p.system, /never promise money, refunds/); assert.match(p.system, /at most one emoji/);
  assert.match(p.user, /thu nov 26, 10am ET/); assert.match(p.user, /AV-0012/); assert.match(p.user, /client: hi\naviance: hey!/);
  assert.equal(R.cleanModelText('"hey Sam, ur call is thu 🎉🎉 at 10am ET"'), 'hey Sam, ur call is thu 🎉 at 10am ET');
  assert.equal(R.cleanModelText('Reply: sure thing'), 'sure thing');
  assert.equal(R.cleanModelText("we'll refund u for the delay"), '', 'a money promise falls back to the rules');
  assert.equal(R.cleanModelText(''), '');
  assert.equal(R.cleanModelText('x'.repeat(700)), '');
});

test('the edge function and the SQL are wired the way the spec says', () => {
  const ts = fs.readFileSync(path.join(root, 'supabase/functions/bot-draft/index.ts'), 'utf8');
  assert.match(ts, /from "\.\/rules\.mjs"/);
  assert.match(ts, /x-aviance-secret/);
  assert.match(ts, /rpc\("draft_write"/);
  assert.match(ts, /p_kind: "reply"/);
  assert.match(ts, /llama-3\.3-70b-versatile/);
  assert.doesNotMatch(ts, /channel_messages"\)\.insert/, 'never sends: no message insert');
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261124_bot.sql'), 'utf8');
  assert.match(sql, /after insert on public\.channel_messages/);
  assert.match(sql, /new\.author_person is not null and new\.msg_kind = 'chat'/);
  assert.match(sql, /public\.offer_match\(\$1\)/);
  assert.match(sql, /functions\/v1\/bot-draft/);
  assert.match(sql, /'x-aviance-secret', v_secret/);
  assert.ok(sql.indexOf('offer_match') < sql.indexOf('net.http_post'), 'offer_match is tried first');
});

/* ───────────── the Replies screen (drafts.js) ───────────── */
const elements = {};
function fakeEl(id) { return elements[id] ||= { id, innerHTML: '', value: '', focus() { this._focus = (this._focus || 0) + 1; } }; }
globalThis.window = globalThis;
globalThis.document = { hidden: false, activeElement: null, getElementById: fakeEl };
globalThis.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const toasts = []; globalThis.toast = (m) => toasts.push(m);
let navs = 0; globalThis.renderNav = () => { navs++; };
let rendered = []; globalThis.render = (v) => rendered.push(v);
let rpcCalls = [], rpcs = {};
globalThis.sb = { rpc: async (n, a) => { rpcCalls.push([n, a]); const h = rpcs[n]; return h ? h(a) : { data: null, error: null }; } };
vm.runInThisContext('var authUser=null, currentView="drafts";');
vm.runInThisContext(fs.readFileSync(path.join(root, 'drafts.js'), 'utf8'), { filename: 'drafts.js' });
const dr = vm.runInThisContext('dr');
after(() => { draftsForget(); });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const ROWS = () => [
  { id: 'd1', client_id: 'k1', company: 'Stone Roofing', channel_id: 'ch1', kind: 'reply', body: 'hey Sam, ur kickoff is thu nov 26, 10am ET', msg_kind: 'bot', reason: 'asked about the call', created_at: new Date(Date.now() - 5 * 60000).toISOString(), last_client_message: "when's my call? <b>" },
  { id: 'd2', client_id: 'k2', company: 'Acme <Ltd>', channel_id: 'ch2', kind: 'welcome', body: 'hey Dana! welcome in 👋', msg_kind: 'bot', reason: null, created_at: new Date().toISOString(), last_client_message: null },
];
function setup() {
  draftsForget(); rpcCalls = []; toasts.length = 0; rendered = []; navs = 0;
  for (const k of Object.keys(elements)) delete elements[k];
  vm.runInThisContext('authUser={uid:"u1",role:"admin"}; currentView="drafts";');
  let live = ROWS();   // the fake database: a sent or discarded draft is no longer pending
  rpcs = { drafts_pending: () => ({ data: live.slice(), error: null }), drafts_count: () => ({ data: 4, error: null }),
    draft_send: ({ p_draft }) => { live = live.filter((d) => d.id !== p_draft); return { data: { message_id: 'm1' }, error: null }; },
    draft_discard: ({ p_draft }) => { live = live.filter((d) => d.id !== p_draft); return { data: null, error: null }; } };
}

test('viewDrafts: every pending draft with the client, their last message, an editable box, Send / Discard — escaped', async () => {
  setup();
  fakeEl('drRoot').innerHTML = viewDrafts();
  assert.match(fakeEl('drRoot').innerHTML, /Loading the drafts/);
  await tick();
  const h = fakeEl('drRoot').innerHTML;
  assert.match(h, /2 waiting/);
  assert.match(h, /Stone Roofing/); assert.match(h, /Acme &lt;Ltd&gt;/); assert.doesNotMatch(h, /<Ltd>/);
  assert.match(h, /They said<\/span>when&#39;s my call\? &lt;b&gt;|They said<\/span>when's my call\? &lt;b&gt;/);
  assert.match(h, /<textarea class="dr-box" id="drBody-d1"[^>]*>hey Sam, ur kickoff is thu nov 26, 10am ET<\/textarea>/);
  assert.match(h, /asked about the call/);
  assert.match(h, />Welcome</); assert.match(h, />Send</); assert.match(h, />Discard</);
  assert.match(h, /onkeydown="drKey\(event,&quot;d1&quot;\)"/);
  assert.equal(drCount(), 2, 'the badge follows the list');
});

test('Send: the edited text goes out, the card goes, the count drops, a toast says where', async () => {
  setup();
  fakeEl('drRoot').innerHTML = viewDrafts(); await tick();
  drEdit('d1', '  hey Sam, ur kickoff is thu at 10am ET  ');
  await drSendClick('d1');
  assert.deepEqual(rpcCalls.find((c) => c[0] === 'draft_send')[1], { p_draft: 'd1', p_body: 'hey Sam, ur kickoff is thu at 10am ET' });
  assert.deepEqual(dr.list.map((d) => d.id), ['d2']);
  assert.equal(drCount(), 1);
  assert.deepEqual(toasts, ['Sent to Stone Roofing']);
  assert.doesNotMatch(fakeEl('drRoot').innerHTML, /drBody-d1/);
  assert.ok(fakeEl('drBody-d2')._focus >= 1, 'focus moves to the next draft');
  // Ctrl+Enter sends the untouched draft as written
  let prevented = 0;
  drKey({ key: 'Enter', metaKey: true, preventDefault() { prevented++; } }, 'd2'); await tick();
  assert.equal(prevented, 1);
  assert.deepEqual(rpcCalls.filter((c) => c[0] === 'draft_send')[1][1], { p_draft: 'd2', p_body: 'hey Dana! welcome in 👋' });
  assert.match(fakeEl('drRoot').innerHTML, /Nothing to approve/);
});

test('Send refuses an empty box; a database refusal keeps the card and says so in plain words', async () => {
  setup();
  fakeEl('drRoot').innerHTML = viewDrafts(); await tick();
  drEdit('d1', '   ');
  await drSendClick('d1');
  assert.equal(rpcCalls.filter((c) => c[0] === 'draft_send').length, 0);
  assert.match(toasts[0], /empty/);
  drEdit('d1', 'ok');
  rpcs.draft_send = () => ({ data: null, error: { code: 'P0001', message: 'That draft was already sent.' } });
  await drSendClick('d1');
  assert.equal(dr.list.length, 2);
  assert.match(fakeEl('drRoot').innerHTML, /That draft was already sent\./);
  rpcs.draft_send = () => { throw new TypeError('Failed to fetch'); };
  await drSendClick('d1');
  assert.match(toasts.at(-1), /Can't reach Aviance/);
});

test('Discard, an empty list, a failed load, and Open channel', async () => {
  setup();
  fakeEl('drRoot').innerHTML = viewDrafts(); await tick();
  await drDiscardClick('d2');
  assert.deepEqual(rpcCalls.find((c) => c[0] === 'draft_discard')[1], { p_draft: 'd2' });
  assert.deepEqual(toasts, ['Draft discarded']);
  drOpenChannel('ch1');
  assert.deepEqual(rendered, ['channels']);
  setup(); rpcs.drafts_pending = () => ({ data: null, error: { code: '42501', message: 'permission denied' } });
  fakeEl('drRoot').innerHTML = viewDrafts(); await tick();
  assert.match(fakeEl('drRoot').innerHTML, /You don&#39;t have access|You don't have access/);
  assert.match(fakeEl('drRoot').innerHTML, /Try again/);
});

test('drCount: 0 for a client or signed out; for staff it polls drafts_count and redraws the nav', async () => {
  setup();
  vm.runInThisContext('authUser={uid:"c",role:"client"};');
  assert.equal(drCount(), 0); assert.equal(dr.timer, null);
  vm.runInThisContext('authUser=null;');
  assert.equal(drCount(), 0);
  vm.runInThisContext('authUser={uid:"u1",role:"employee"}; currentView="home";');
  assert.equal(drCount(), 0);
  assert.ok(dr.timer, 'the 30s timer runs');
  await tick(10);
  assert.ok(rpcCalls.some((c) => c[0] === 'drafts_count'));
  assert.equal(drCount(), 4);
  assert.ok(navs >= 1, 'the nav was redrawn with the new count');
  dr.count = 250; assert.equal(drCount(), '99+');
  draftsForget(); assert.equal(dr.timer, null);
});
