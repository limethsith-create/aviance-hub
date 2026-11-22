/* Tests for outreach.js (the outreach tool screens: the client list, one client, one
   conversation). Same set-up as numbers.test.mjs: the script runs in a vm with only the
   globals the shell gives it — esc(), val(), emptyState(), toast(), I, authUser and a fake
   `sb`. No browser, no network, no adapter (outreach-adapter.js is another agent's file, so
   these tests also prove the screens hold up when it is not loaded).
   Run with:  node --test tests/outreach.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────── fake Supabase: a thenable query builder ───────────── */
let tables, calls;
function reset() { calls = []; tables = {}; }
function builder(table) {
  const call = { table, op: 'select', filters: [], order: null, payload: null, single: false };
  calls.push(call);
  const b = {
    select() { return b },
    insert(p) { call.op = 'insert'; call.payload = p; return b },
    update(p) { call.op = 'update'; call.payload = p; return b },
    eq(k, v) { call.filters.push(['eq', k, v]); return b },
    gte(k, v) { call.filters.push(['gte', k, v]); return b },
    lte(k, v) { call.filters.push(['lte', k, v]); return b },
    order(k, o) { call.order = [k, o]; return b },
    single() { call.single = 'one'; return b },
    maybeSingle() { call.single = 'maybe'; return b },
    then(res, rej) {
      const h = tables[table + '.' + call.op];
      let out = typeof h === 'function' ? h(call) : (h === undefined ? { data: [], error: null } : h);
      if (call.single && out && Array.isArray(out.data)) out = { data: out.data.length ? out.data[0] : null, error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}

/* ───────────── the sandbox the browser would give outreach.js ───────────── */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const el = { id: 'ouRoot', innerHTML: '', value: '' };
const fields = { ouReplySubject: { value: '' }, ouReplyBody: { value: '' } };
const sandbox = {
  console, setTimeout, clearTimeout, Date, Number, Math, Promise, Array, String, Object, JSON, isNaN,
  esc,
  val: (id) => (fields[id] ? String(fields[id].value || '').trim() : ''),
  emptyState: (icon, title, sub, btn, action) =>
    `<div class="card"><div class="empty"><div class="empty-ic">${icon}</div><h3>${title}</h3><p>${sub}</p>${btn ? `<button class="btn" onclick="${action}">${btn}</button>` : ''}</div></div>`,
  toast: (m) => { sandbox.toasts.push(m) },
  I: { inbox: '<svg></svg>', chart: '<svg></svg>' },
  document: { getElementById: (id) => (id === 'ouRoot' ? el : fields[id] || null) },
  sb: { from: builder },
  authUser: null,
  toasts: [],
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(root, 'outreach.js'), 'utf8');
vm.runInContext(src + '\n;globalThis.api={ou,ouSummaryHTML,ouSummaryTotals,ouClientHTML,ouThreadHTML,ouDays,ouDaysTotals,' +
  'ouIsClientView,ouClientScope,ouMaySee,ouScopeRows,ouSummary,ouQueueReply,ouBookThread,ouSendReply,' +
  'viewOutreach,viewOutreachClient,viewOutreachThread,ouPct};', sandbox, { filename: 'outreach.js' });
const A = sandbox.api;

const tick = () => new Promise((r) => setTimeout(r, 5));
const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
const asTeam = () => { sandbox.authUser = { uid: 'u1', role: 'admin', name: 'Owner' } };
const asClient = (id) => { sandbox.authUser = { uid: 'u2', role: 'client', client_id: id } };
const NOW = Date.parse('2026-11-22T12:00:00Z');

beforeEach(() => {
  reset(); asTeam(); el.innerHTML = ''; sandbox.toasts.length = 0;
  fields.ouReplySubject.value = ''; fields.ouReplyBody.value = '';
  Object.assign(A.ou, {
    sum: [], accounts: [], sumErr: '', syncing: {}, syncingAll: false,
    clientId: '', client: null, campaigns: [], days: [], threads: [], inboxes: [], clientErr: '',
    replyFilter: 'open', threadId: '', thread: null, msgs: [], threadErr: '',
    sending: false, sendErr: '', queuedNote: '', seq: 0,
  });
});

/* ───────────── fixtures ───────────── */
const summaryRows = [
  { client_id: 'oak', client_name: 'Oak Legal', campaigns: 3, running: 2, sent: 1000, replied: 40, positive: 12, booked: 5, reply_pct: 4, last_synced_at: '2026-11-22T11:58:00Z' },
  { client_id: 'stone', client_name: 'Stone Roofing', campaigns: 1, running: 1, sent: 500, replied: 10, positive: 3, booked: 2, reply_pct: 2, last_synced_at: null },
];
const accountRows = [
  { client_id: 'oak', provider: 'smartlead', label: 'Oak sending', status: 'ok', last_synced_at: '2026-11-22T11:58:00Z' },
  { client_id: 'stone', provider: 'demo', label: 'Stone demo', status: 'needs_key', last_synced_at: null },
];
const dailyRows = [
  /* two campaigns, same day — they have to add up to one bar */
  { client_id: 'oak', campaign_id: 'c1', on_day: '2026-11-21', sent: 60, replied: 3, positive: 1, booked: 1 },
  { client_id: 'oak', campaign_id: 'c2', on_day: '2026-11-21', sent: 40, replied: 1, positive: 0, booked: 0 },
  { client_id: 'oak', campaign_id: 'c1', on_day: '2026-11-22', sent: 25, replied: 2, positive: 1, booked: 0 },
  /* older than the window, must be left out of the chart */
  { client_id: 'oak', campaign_id: 'c1', on_day: '2026-09-01', sent: 999, replied: 99, positive: 9, booked: 9 },
];
const campaignRows = [
  { id: 'c1', client_id: 'oak', name: 'Partners <b>Q4</b>', status: 'running', started_on: '2026-11-01', sent: 700, opened: 300, replied: 30, positive: 9, booked: 4, bounced: 2, unsubscribed: 1 },
  { id: 'c2', client_id: 'oak', name: 'Founders', status: 'paused', started_on: '2026-10-01', sent: 300, opened: 100, replied: 10, positive: 3, booked: 1, bounced: 1, unsubscribed: 0 },
];
const inboxRows = [
  { id: 'i1', client_id: 'oak', email: 'hello@oak-mail.com', warmed: true, health: 92, daily_limit: 40, sent_today: 18, status: 'ok' },
  { id: 'i2', client_id: 'oak', email: 'team@oak-mail.com', warmed: false, health: 60, daily_limit: 8, sent_today: 3, status: 'warming' },
];
const threadRows = [
  { id: 't1', client_id: 'oak', campaign_id: 'c1', lead_name: 'Dana Reed', lead_email: 'dana@acme.com', lead_company: 'Acme', lead_title: 'Ops lead', sentiment: 'positive', status: 'open', last_message_at: '2026-11-22T09:00:00Z' },
  { id: 't2', client_id: 'oak', campaign_id: 'c1', lead_name: 'Sam Ash', lead_email: 'sam@beta.com', lead_company: 'Beta', sentiment: 'neutral', status: 'open', last_message_at: '2026-11-21T09:00:00Z' },
];
const messageRows = [
  { id: 'm1', thread_id: 't1', client_id: 'oak', direction: 'out', subject: 'Quick question', body: 'First one.', sent_at: '2026-11-20T09:00:00Z', delivery: 'synced' },
  { id: 'm2', thread_id: 't1', client_id: 'oak', direction: 'in', subject: 'Re: Quick question', body: 'Sounds good — send times.', sent_at: '2026-11-22T09:00:00Z', delivery: 'synced' },
];
const fullDb = () => {
  tables['v_outreach_summary.select'] = { data: summaryRows, error: null };
  tables['outreach_accounts.select'] = { data: accountRows, error: null };
  tables['outreach_campaigns.select'] = { data: campaignRows, error: null };
  tables['outreach_daily.select'] = { data: dailyRows, error: null };
  tables['outreach_threads.select'] = { data: threadRows, error: null };
  tables['outreach_inboxes.select'] = { data: inboxRows, error: null };
  tables['outreach_messages.select'] = { data: messageRows, error: null };
};

/* ═════════════ 1. every screen with no rows at all ═════════════ */

test('the client list renders with zero rows and says so in plain words', async () => {
  const shell = A.viewOutreach();
  assert.ok(shell.includes('id="ouRoot"'));
  await tick();
  const t = text(el.innerHTML);
  assert.ok(t.includes('No outreach yet'), t);
  assert.ok(t.includes('Sync all'));
  assert.ok(el.innerHTML.includes('class="empty"'), 'uses the house empty state');
  assert.ok(!el.innerHTML.includes('<table'), 'no empty table');
});

test('one client renders with zero rows: a real empty state in every card', async () => {
  A.viewOutreachClient('oak');
  await tick();
  const t = text(el.innerHTML);
  for (const w of ['Nothing sent in the last 30 days', 'No campaigns yet', 'No inboxes yet', 'No replies here']) {
    assert.ok(t.includes(w), w + ' — got: ' + t.slice(0, 400));
  }
  assert.ok(!el.innerHTML.includes('<svg class="ou-chart"'), 'no chart until something was sent');
  assert.ok(t.includes('Never synced'));
});

test('one conversation renders with zero rows, and with no such conversation', async () => {
  tables['outreach_threads.select'] = { data: [threadRows[0]], error: null };
  tables['outreach_messages.select'] = { data: [], error: null };
  A.viewOutreachThread('t1');
  await tick();
  let t = text(el.innerHTML);
  assert.ok(t.includes('No messages yet'), t);
  assert.ok(t.includes('Queue reply'));
  /* the thread itself is gone */
  tables['outreach_threads.select'] = { data: [], error: null };
  A.ou.seq = 0; A.viewOutreachThread('t9');
  await tick();
  t = text(el.innerHTML);
  assert.ok(t.includes('That conversation is gone'), t);
});

test('with no screen at all the builders still return an empty state', () => {
  assert.ok(text(A.ouSummaryHTML([], [])).includes('No outreach yet'));
  assert.ok(text(A.ouClientHTML({ days: A.ouDays([], NOW) })).includes('No campaigns yet'));
  assert.ok(text(A.ouThreadHTML({})).includes('That conversation is gone'));
  assert.ok(text(A.ouThreadHTML(null)).includes('That conversation is gone'));
});

/* ═════════════ 2. the numbers add up from the rows ═════════════ */

test('the client list adds the rows up into one bottom line', () => {
  const t = A.ouSummaryTotals(summaryRows);
  assert.deepEqual(
    { clients: t.clients, campaigns: t.campaigns, running: t.running, sent: t.sent, replied: t.replied, positive: t.positive, booked: t.booked, replyPct: t.replyPct },
    { clients: 2, campaigns: 4, running: 3, sent: 1500, replied: 50, positive: 15, booked: 7, replyPct: '3.3%' },
  );
  const h = A.ouSummaryHTML(summaryRows, accountRows, NOW);
  assert.ok(h.includes('<tfoot>'));
  const foot = h.slice(h.indexOf('<tfoot>'));
  assert.ok(text(foot).includes('All clients 3 1,500 50 3.3% 7'), text(foot));
  /* each row shows its own reply rate, when it last synced and the tool behind it */
  assert.ok(text(h).includes('Oak Legal'), 'client name');
  assert.ok(text(h).includes('Synced 2 min ago'));
  assert.ok(text(h).includes('Never synced'));
  assert.ok(text(h).includes('Smartlead'), 'the provider behind it');
  assert.ok(text(h).includes('Waiting for a key'), 'an account with no key says so');
  assert.equal((h.match(/ou-sync/g) || []).length, 2, 'one sync button per row');
  assert.ok(h.includes('ouSyncAll()'), 'and Sync all');
  /* nothing from the database reaches the page unescaped */
  assert.ok(!A.ouSummaryHTML([{ client_id: 'x', client_name: '<img src=x>', sent: 1 }], []).includes('<img'));
});

test('the chart adds the campaigns of one day together and keeps to 30 days', () => {
  const days = A.ouDays(dailyRows, NOW);
  assert.equal(days.length, 30);
  assert.equal(days[29].day, '2026-11-22');
  assert.equal(days[0].day, '2026-10-24');
  const d21 = days.find((d) => d.day === '2026-11-21');
  assert.equal(d21.sent, 100, 'two campaigns on the same day are one bar');
  assert.equal(d21.replied, 4);
  const t = A.ouDaysTotals(days);
  assert.deepEqual({ sent: t.sent, replied: t.replied, positive: t.positive, booked: t.booked, replyPct: t.replyPct },
    { sent: 125, replied: 6, positive: 2, booked: 1, replyPct: '4.8%' });
  assert.ok(!days.some((d) => d.sent === 999), 'anything older than the window is left out');
});

test("one client's screen shows the numbers, the chart, the campaigns, the inboxes and the replies", async () => {
  fullDb();
  A.viewOutreachClient('oak');
  await tick();
  const h = el.innerHTML, t = text(h);
  assert.ok(t.includes('Oak Legal'));
  assert.ok(t.includes('1,000'), 'sent');
  assert.ok(t.includes('4%'), 'reply rate from the view');
  assert.ok(h.includes('<svg class="ou-chart"'), 'an inline svg chart, no library');
  assert.equal((h.match(/class="ou-bar"/g) || []).length, 30, 'one bar a day');
  assert.ok(h.includes('<polyline'), 'the replies line');
  assert.ok(h.includes('Partners &lt;b&gt;Q4&lt;/b&gt;'), 'the campaign name, escaped');
  assert.ok(t.includes('Founders'), 'the campaigns');
  assert.ok(!h.includes('<b>Q4</b>'), 'a campaign name is never raw html');
  assert.ok(t.includes('hello@oak-mail.com') && t.includes('Warming up'), 'inbox health');
  assert.ok(t.includes('Dana Reed') && t.includes('Interested'), 'the reply inbox');
  assert.ok(t.includes('The sending tool is not connected yet'), 'no adapter: calm words, not a crash');
});

/* ═════════════ 3. a reply is queued, never sent from the screen ═════════════ */

test("a reply writes an outreach_messages row with direction 'out' and delivery 'queued'", async () => {
  fullDb();
  let inserted = null;
  tables['outreach_messages.insert'] = (c) => { inserted = c.payload; return { data: [{ id: 'm3', ...c.payload }], error: null } };
  let updated = null;
  tables['outreach_threads.update'] = (c) => { updated = c; return { data: [{ id: 't1' }], error: null } };
  const r = await A.ouQueueReply('t1', { subject: 'Re: Quick question', body: '  Tuesday at 10 works.  ' });
  assert.equal(r.ok, true, r.error);
  assert.equal(inserted.direction, 'out');
  assert.equal(inserted.delivery, 'queued');
  assert.equal(inserted.thread_id, 't1');
  assert.equal(inserted.client_id, 'oak');
  assert.equal(inserted.body, 'Tuesday at 10 works.', 'trimmed');
  assert.equal(inserted.subject, 'Re: Quick question');
  assert.ok(inserted.sent_at, 'a time it was written');
  assert.equal(updated.payload.status, 'answered');
  /* no adapter loaded: the row is still saved and nothing throws */
  assert.equal(r.data.delivery, 'queued');
});

test('the screen says it is queued, and an empty reply is refused in plain words', async () => {
  fullDb();
  tables['outreach_messages.insert'] = (c) => ({ data: [{ id: 'm3', ...c.payload }], error: null });
  A.viewOutreachThread('t1');
  await tick();
  fields.ouReplyBody.value = 'Tuesday at 10 works.';
  await A.ouSendReply('t1');
  await tick();
  assert.ok(text(el.innerHTML).includes('Queued — it goes out on the next sync'), text(el.innerHTML));
  assert.ok(sandbox.toasts.includes('Queued — it goes out on the next sync'));
  fields.ouReplyBody.value = '   ';
  const r = await A.ouSendReply('t1');
  assert.equal(r, undefined);
  assert.equal(A.ou.sendErr, 'Write something first.');
  assert.ok(text(el.innerHTML).includes('Write something first.'));
});

test('a queued message is marked as queued where the conversation is read', () => {
  const h = A.ouThreadHTML({
    thread: threadRows[0],
    msgs: messageRows.concat([{ id: 'm3', direction: 'out', body: 'Tuesday at 10 works.', sent_at: '2026-11-22T10:00:00Z', delivery: 'queued' }]),
  });
  const t = text(h);
  assert.ok(t.indexOf('First one.') < t.indexOf('Sounds good'), 'oldest first');
  assert.ok(t.includes('Queued — it goes out on the next sync'));
  assert.ok(h.includes('ouBookThis('), 'a positive conversation offers Book this one');
});

test("Book this one marks the conversation 'booked' and leaves the meeting to someone else", async () => {
  fullDb();
  let up = null;
  tables['outreach_threads.update'] = (c) => { up = c; return { data: [{ id: 't1', status: 'booked' }], error: null } };
  const r = await A.ouBookThread('t1');
  assert.equal(r.ok, true, r.error);
  assert.equal(up.payload.status, 'booked');
  assert.deepEqual(Object.keys(up.payload), ['status'], 'it does not touch meeting_id');
  assert.ok(/TODO:/.test(src) && /meetings row/.test(src), 'the meetings row is left as a TODO');
  /* a conversation that is already booked does not offer the button again */
  assert.ok(!A.ouThreadHTML({ thread: { ...threadRows[0], status: 'booked' }, msgs: [] }).includes('ouBookThis('));
});

/* ═════════════ 4. who is looking ═════════════ */

test('our team sees everyone; a client is held to its own client_id', async () => {
  fullDb();
  asTeam();
  assert.equal(A.ouIsClientView(), false);
  assert.equal(A.ouClientScope(), '');
  assert.equal(A.ouMaySee('oak'), true);
  assert.equal(A.ouMaySee('stone'), true);
  assert.equal((await A.ouSummary()).data.length, 2);

  asClient('oak');
  assert.equal(A.ouIsClientView(), true);
  assert.equal(A.ouClientScope(), 'oak');
  assert.equal(A.ouMaySee('oak'), true);
  assert.equal(A.ouMaySee('stone'), false);
  assert.equal(A.ouMaySee(''), false);
  const mine = await A.ouSummary();
  assert.equal(mine.data.length, 1);
  assert.equal(mine.data[0].client_id, 'oak');
  assert.deepEqual(A.ouScopeRows(summaryRows).map((r) => r.client_id), ['oak']);
});

test("a client opening someone else's client gets a calm no, and their own screen instead", async () => {
  fullDb();
  asClient('oak');
  assert.ok(text(A.viewOutreachClient('stone')).includes('Not your client'));
  assert.equal((await A.ouQueueReply('t1', { body: 'x' })).ok !== false, true, 'their own thread is fine');
  tables['outreach_threads.select'] = { data: [{ ...threadRows[0], client_id: 'stone' }], error: null };
  const no = await A.ouQueueReply('t1', { body: 'x' });
  assert.equal(no.ok, false);
  assert.equal(no.error, 'That conversation is not yours to open.');
  /* the whole-list screen never opens for a client: they get their own numbers */
  A.ou.seq = 0; fullDb();
  const own = A.viewOutreachClient('oak');
  assert.ok(own.includes('id="ouRoot"'));
  await tick();
  assert.ok(text(el.innerHTML).includes('Your emails'), text(el.innerHTML).slice(0, 200));
});

test('a client never gets the whole-business list', async () => {
  fullDb();
  asClient('oak');
  A.viewOutreach();
  await tick();
  const t = text(el.innerHTML);
  assert.ok(t.includes('Your emails'), t.slice(0, 200));
  assert.ok(!t.includes('Stone Roofing'), 'no other client is on their screen');
  assert.ok(!t.includes('All clients'), 'and no business-wide bottom line');
});

/* ═════════════ 5. nothing is forbidden, nothing throws ═════════════ */

test('the database saying no comes back as a plain sentence, not a code', async () => {
  tables['v_outreach_summary.select'] = { data: null, error: { message: 'permission denied for view v_outreach_summary' } };
  const r = await A.ouSummary();
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.equal(typeof r.error, 'string');
  A.ou.seq = 0; A.viewOutreach();
  await tick();
  assert.ok(el.innerHTML.includes('role="alert"'));
  assert.ok(el.innerHTML.includes('Try again'));
});

test('no machine, no keys, no email-distributor anywhere in the two files', () => {
  const css = fs.readFileSync(path.join(root, 'outreach.css'), 'utf8');
  for (const bad of ['machineFetch', 'MACHINE_URL', 'email-distributor']) {
    assert.ok(!src.includes(bad), 'outreach.js must not mention ' + bad);
    assert.ok(!css.includes(bad), 'outreach.css must not mention ' + bad);
  }
  /* every function this file puts on the page is prefixed ou / viewOutreach / outreachOnRender */
  for (const m of src.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)/gm)) {
    assert.ok(/^(ou|viewOutreach|outreachOnRender)/.test(m[1]), m[1] + ' is not prefixed');
  }
});
