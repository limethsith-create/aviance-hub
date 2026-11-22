/* ===================== AVIANCE HUB — Outreach =====================
   Our own front end over whatever is actually sending the email. Three screens:

     viewOutreach()                 every client in one list (v_outreach_summary), a Sync button
                                    per row and Sync all. Our team only.
     viewOutreachClient(clientId)   one client — the numbers, a 30-day sent/replies chart from
                                    outreach_daily, the campaigns, inbox health and the reply
                                    inbox. This is the same screen a client will see of themselves.
     viewOutreachThread(threadId)   one conversation, oldest message first, and a reply box.

   Where the data comes from
   -------------------------
   Rows come straight from Supabase through the shell's `sb` client:
     outreach_accounts  outreach_campaigns  outreach_daily  outreach_threads
     outreach_messages  outreach_inboxes    view v_outreach_summary
   The provider behind a client is reached through the adapter in outreach-adapter.js:
     oaFor(clientId) -> {ok,data:{provider,account,impl}}   oaSync(clientId)   oaFlushOutbox()
     impl: getCampaigns, getStats, getReplies, sendReply, getInboxHealth
   Every one of those is optional at runtime. If the adapter has not loaded, or an impl is
   missing a method, the screen says so in plain words and falls back to the tables. Nothing
   here throws and nothing runs at load time.

   A reply never goes out from the screen. It is written as an outreach_messages row with
   direction 'out' and delivery 'queued', and the outbox is flushed on the next sync. That way
   a reply survives a closed tab and the provider only ever hears from one place.

   Every function returns {ok, data, error} (the finance.js plumbing) and never throws.
   `error` is a plain sentence, safe to put on a screen.
   Everything in this file is prefixed `ou`.
   ================================================================= */

/* ===================== 0. STATE ===================== */

const OU_DAYS = 30;                 // the chart window
const OU_BODY_MAX = 8000;           // a reply body, trimmed before it reaches the database

const ou = {
  /* the list */
  sum: [], accounts: [], sumErr: '', sumLoading: false, syncing: {}, syncingAll: false,
  /* one client */
  clientId: '', client: null, campaigns: [], days: [], threads: [], inboxes: [],
  clientErr: '', clientLoading: false, replyFilter: 'open',
  /* one thread */
  threadId: '', thread: null, msgs: [], threadErr: '', threadLoading: false,
  sending: false, sendErr: '', queuedNote: '',
  /* who is looking */
  viewer: null, viewerAsked: false,
  seq: 0,
};

/* ===================== 1. PLUMBING (copied from finance.js) ===================== */

function ouOk(data) { return { ok: true, data, error: '' } }
function ouErr(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return { ok: false, data: null, error: m };
}
function ouWrap(res, whenEmpty) {
  if (!res) return ouErr('No answer from the database.');
  if (res.error) return ouErr(res.error);
  return ouOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
async function ouRun(fn, whenEmpty) {
  try { return ouWrap(await fn(), whenEmpty) }
  catch (e) { return ouErr(e) }
}
/* The database is not there (a screen opened before the shell finished). */
function ouNoDb() { return ouErr('The outreach numbers are not available right now.') }
function ouHasDb() { return typeof sb !== 'undefined' && sb && typeof sb.from === 'function' }

/* ===================== 2. WHO IS LOOKING ===================== */
/* ONE place decides whether the viewer is our team or a client. Client sign-in is not switched
   on yet, so today every signed-in person is our team and sees every client. When it is switched
   on, the only change is the line marked below: a client's profiles row carries their client_id,
   ouIsClientView() turns true, and every screen in this file narrows to that one id by itself. */

function ouProfile() {
  if (typeof authUser === 'undefined' || !authUser) return null;
  return authUser.profile || authUser;          // the shell keeps the profiles row on authUser
}
/* {isClient, clientId} — never null. */
function ouViewer() {
  const p = ouProfile() || {};
  const role = String(p.role || '').toLowerCase();
  const isClient = role === 'client';           // <-- the one line that switches client sign-in on
  const clientId = String(p.client_id || p.clientId || '') || '';
  return { isClient: isClient, clientId: isClient ? clientId : '' };
}
/* True when the person looking is a client looking at themselves. */
function ouIsClientView() { return ouViewer().isClient }
/* The one client a viewer is held to, or '' when they may see everyone. */
function ouClientScope() { const v = ouViewer(); return v.isClient ? v.clientId : '' }
/* May this viewer see this client? */
function ouMaySee(clientId) {
  const scope = ouClientScope();
  if (!scope) return true;
  return !!clientId && String(clientId) === scope;
}
/* Narrow a list of rows carrying client_id to what the viewer may see. */
function ouScopeRows(rows) {
  const list = Array.isArray(rows) ? rows.filter(r => r) : [];
  const scope = ouClientScope();
  if (!scope) return list;
  return list.filter(r => String(r.client_id || r.clientId || '') === scope);
}

/* ===================== 3. THE ADAPTER (may not be loaded) ===================== */

function ouFn(name) { return typeof globalThis[name] === 'function' ? globalThis[name] : null }
const OU_NO_ADAPTER = 'The sending tool is not connected yet. These are the numbers we have saved.';

/* Call a global that returns {ok,data,error}. Never throws. */
async function ouCall(name, ...args) {
  const f = ouFn(name);
  if (!f) return ouErr(OU_NO_ADAPTER);
  try {
    const r = await f(...args);
    if (r && typeof r === 'object' && 'ok' in r) return r.ok ? ouOk(r.data) : ouErr(r.error || 'That did not go through.');
    return ouOk(r == null ? null : r);
  } catch (e) { return ouErr(e) }
}
/* {provider, account, impl} for a client, or a plain message. */
async function ouAdapter(clientId) {
  if (!clientId) return ouErr('No client was chosen.');
  const r = await ouCall('oaFor', clientId);
  if (!r.ok) return r;
  const d = r.data || {};
  return ouOk({ provider: d.provider || '', account: d.account || null, impl: d.impl || null });
}
/* Ask the impl for something; `null` means "no impl, use the tables". */
async function ouAsk(clientId, method, ...args) {
  const a = await ouAdapter(clientId);
  if (!a.ok) return null;
  const impl = a.data.impl;
  if (!impl || typeof impl[method] !== 'function') return null;
  try {
    const r = await impl[method](clientId, ...args);
    if (r && typeof r === 'object' && 'ok' in r) return r.ok ? ouOk(r.data) : ouErr(r.error || 'That did not go through.');
    return ouOk(r == null ? [] : r);
  } catch (e) { return ouErr(e) }
}

/* ===================== 4. DATA ===================== */

/* Every client, one row each. The view already counts campaigns, sent, replies and booked. */
async function ouSummary() {
  if (!ouHasDb()) return ouNoDb();
  const r = await ouRun(() => sb.from('v_outreach_summary').select('*'), []);
  if (!r.ok) return r;
  const rows = ouScopeRows(r.data).slice()
    .sort((a, b) => String(a.client_name || '').localeCompare(String(b.client_name || '')));
  return ouOk(rows);
}
/* Which provider is behind each client. One row per account; we show the first per client. */
async function ouAccounts() {
  if (!ouHasDb()) return ouNoDb();
  const r = await ouRun(() => sb.from('outreach_accounts').select('*').order('created_at'), []);
  if (!r.ok) return r;
  return ouOk(ouScopeRows(r.data));
}
async function ouCampaigns(clientId) {
  if (!ouMaySee(clientId)) return ouErr('That client is not yours to open.');
  const viaTool = await ouAsk(clientId, 'getCampaigns');
  if (viaTool && viaTool.ok && Array.isArray(viaTool.data)) return ouOk(viaTool.data);
  if (!ouHasDb()) return ouNoDb();
  return ouRun(() => sb.from('outreach_campaigns').select('*')
    .eq('client_id', clientId).order('started_on', { ascending: false }), []);
}
/* The last 30 days, one row per campaign per day. */
async function ouDaily(clientId, fromDay, toDay) {
  if (!ouMaySee(clientId)) return ouErr('That client is not yours to open.');
  if (!ouHasDb()) return ouNoDb();
  return ouRun(() => {
    let q = sb.from('outreach_daily').select('*').eq('client_id', clientId);
    if (fromDay) q = q.gte('on_day', fromDay);
    if (toDay) q = q.lte('on_day', toDay);
    return q.order('on_day');
  }, []);
}
/* The reply inbox. `status` is one of open|answered|booked|closed, or '' for all. */
async function ouThreads(clientId, status) {
  if (!ouMaySee(clientId)) return ouErr('That client is not yours to open.');
  const viaTool = await ouAsk(clientId, 'getReplies', { status: status || '' });
  if (viaTool && viaTool.ok && Array.isArray(viaTool.data)) return ouOk(viaTool.data);
  if (!ouHasDb()) return ouNoDb();
  return ouRun(() => {
    let q = sb.from('outreach_threads').select('*').eq('client_id', clientId);
    if (status) q = q.eq('status', status);
    return q.order('last_message_at', { ascending: false });
  }, []);
}
async function ouInboxes(clientId) {
  if (!ouMaySee(clientId)) return ouErr('That client is not yours to open.');
  const viaTool = await ouAsk(clientId, 'getInboxHealth');
  if (viaTool && viaTool.ok && Array.isArray(viaTool.data)) return ouOk(viaTool.data);
  if (!ouHasDb()) return ouNoDb();
  return ouRun(() => sb.from('outreach_inboxes').select('*').eq('client_id', clientId).order('email'), []);
}
async function ouThreadRow(threadId) {
  if (!ouHasDb()) return ouNoDb();
  const r = await ouRun(() => sb.from('outreach_threads').select('*').eq('id', threadId).maybeSingle(), null);
  if (!r.ok) return r;
  if (r.data && !ouMaySee(r.data.client_id)) return ouErr('That conversation is not yours to open.');
  return r;
}
async function ouMessages(threadId) {
  if (!ouHasDb()) return ouNoDb();
  return ouRun(() => sb.from('outreach_messages').select('*')
    .eq('thread_id', threadId).order('sent_at'), []);
}

/* ---- writing ---- */

/* A reply. It is written as a queued row and goes out on the next sync — never from here. */
async function ouQueueReply(threadId, opts) {
  const o = opts || {};
  const body = String(o.body == null ? '' : o.body).trim();
  if (!threadId) return ouErr('That conversation could not be found.');
  if (!body) return ouErr('Write something first.');
  if (!ouHasDb()) return ouNoDb();
  const t = await ouThreadRow(threadId);
  if (!t.ok) return t;
  if (!t.data) return ouErr('That conversation could not be found.');
  const row = {
    thread_id:   threadId,
    client_id:   t.data.client_id,
    direction:   'out',
    subject:     o.subject ? String(o.subject).slice(0, 300) : null,
    body:        body.slice(0, OU_BODY_MAX),
    sent_at:     new Date().toISOString(),
    delivery:    'queued',
    author_user: (typeof authUser !== 'undefined' && authUser && (authUser.uid || authUser.id)) || null,
  };
  const ins = await ouRun(() => sb.from('outreach_messages').insert(row).select().single(), null);
  if (!ins.ok) return ins;
  /* The thread has been answered by us; the provider still has to hear about it. */
  await ouRun(() => sb.from('outreach_threads')
    .update({ status: 'answered', last_message_at: row.sent_at }).eq('id', threadId), null);
  /* Hand the outbox to the sending tool. A tool that is not there yet is not an error:
     the row is saved and the next sync picks it up. */
  await ouCall('oaFlushOutbox');
  return ouOk(ins.data || row);
}

/* They want to meet. The thread is marked booked here; the meeting itself is somebody else's. */
async function ouBookThread(threadId) {
  if (!threadId) return ouErr('That conversation could not be found.');
  if (!ouHasDb()) return ouNoDb();
  const t = await ouThreadRow(threadId);
  if (!t.ok) return t;
  if (!t.data) return ouErr('That conversation could not be found.');
  const up = await ouRun(() => sb.from('outreach_threads')
    .update({ status: 'booked' }).eq('id', threadId).select().single(), null);
  if (!up.ok) return up;
  // TODO: create the meetings row here (kind, starts_at, minutes, time_zone, client_id) and put
  // its id on outreach_threads.meeting_id. Meetings are another area's; this screen only marks
  // the conversation booked so nothing is written twice.
  return up;
}

/* Ask the provider for fresh numbers. */
async function ouSync(clientId) {
  if (!ouMaySee(clientId)) return ouErr('That client is not yours to sync.');
  return ouCall('oaSync', clientId);
}

/* ===================== 5. WORDS AND NUMBERS ===================== */

function ouE(s) { return typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
function ouArg(v) { return ouE(JSON.stringify(v == null ? '' : String(v))) }
function ouInt(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0 }
function ouNum(v) { return ouInt(v).toLocaleString('en-US') }
/* A reply rate. The view gives a percentage already; we work one out when it does not. */
function ouPct(sent, replied, given) {
  const g = Number(given);
  if (Number.isFinite(g) && g > 0) return (Math.round(g * 10) / 10) + '%';
  const s = ouInt(sent); if (!s) return '0%';
  return (Math.round((ouInt(replied) / s) * 1000) / 10) + '%';
}
function ouDayKey(d) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
function ouDayLabel(key) {
  const t = Date.parse(String(key) + 'T12:00:00Z');
  if (!Number.isFinite(t)) return String(key || '');
  try { return new Date(t).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) }
  catch (e) { return String(key) }
}
/* "synced 4 min ago" / "never synced" */
function ouAgo(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 'Never synced';
  const s = Math.max(0, Math.round(((now == null ? Date.now() : now) - t) / 1000));
  if (s < 60) return 'Synced just now';
  const m = Math.round(s / 60); if (m < 60) return 'Synced ' + m + ' min ago';
  const h = Math.round(m / 60); if (h < 24) return 'Synced ' + h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24); return 'Synced ' + d + (d === 1 ? ' day ago' : ' days ago');
}
const OU_PROVIDERS = { demo: 'Demo', smartlead: 'Smartlead', instantly: 'Instantly' };
function ouProviderName(p) { return OU_PROVIDERS[String(p || '')] || (p ? String(p) : 'Not set up') }
const OU_CAMPAIGN_TONE = { running: 'green', paused: 'amber', draft: 'grey', finished: 'grey', error: 'red' };
const OU_INBOX_TONE = { ok: 'green', warming: 'amber', warning: 'amber', blocked: 'red', paused: 'grey' };
const OU_INBOX_WORDS = { ok: 'Healthy', warming: 'Warming up', warning: 'Needs a look', blocked: 'Blocked', paused: 'Paused' };
const OU_ACCOUNT_TONE = { ok: 'green', needs_key: 'amber', error: 'red', paused: 'grey' };
const OU_ACCOUNT_WORDS = { ok: 'Connected', needs_key: 'Waiting for a key', error: 'Something is wrong', paused: 'Paused' };
const OU_SENTIMENT_TONE = { positive: 'green', neutral: 'grey', negative: 'red', out_of_office: 'grey', unsubscribe: 'red', unknown: 'grey' };
const OU_SENTIMENT_WORDS = { positive: 'Interested', neutral: 'Neutral', negative: 'Not interested', out_of_office: 'Away', unsubscribe: 'Unsubscribed', unknown: 'Not read yet' };
const OU_THREAD_WORDS = { open: 'Waiting on us', answered: 'We replied', booked: 'Booked', closed: 'Closed' };
const OU_THREAD_TONE = { open: 'amber', answered: 'blue', booked: 'green', closed: 'grey' };
const OU_DELIVERY_WORDS = { synced: '', queued: 'Queued — it goes out on the next sync', sending: 'Going out now', sent: 'Sent', failed: "It didn't go out" };

function ouPill(tone, words) { return '<span class="pill ' + ouE(tone || 'grey') + '">' + ouE(words) + '</span>' }
function ouEmpty(title, sub, btn, action) {
  if (typeof emptyState === 'function') {
    const icon = typeof I !== 'undefined' && I ? (I.inbox || I.chart || '') : '';
    return emptyState(icon, ouE(title), ouE(sub), btn ? ouE(btn) : '', action || '');
  }
  return '<div class="card"><div class="empty"><h3>' + ouE(title) + '</h3><p>' + ouE(sub) + '</p></div></div>';
}
function ouErrCard(msg, retry) {
  return '<div class="card ou-err" role="alert"><span>' + ouE(msg || "That didn't load. Try again.") + '</span>' +
    (retry ? '<button type="button" class="btn ghost" onclick="' + ouE(retry) + '">Try again</button>' : '') + '</div>';
}
function ouSkeleton() {
  return '<div class="ou-skel"></div><div class="ou-skel wide"></div><div class="ou-skel wide"></div>';
}
function ouTiles(pairs) {
  return '<div class="ou-tiles">' + pairs.map(p =>
    '<div class="card ou-tile"><small>' + ouE(p[0]) + '</small><b>' + p[1] + '</b></div>').join('') + '</div>';
}

/* ===================== 6. SCREEN ONE — every client ===================== */

/* Add the rows up so the bottom line of the table is the whole book of business. */
function ouSummaryTotals(rows) {
  const list = Array.isArray(rows) ? rows.filter(r => r) : [];
  const t = { clients: list.length, campaigns: 0, running: 0, sent: 0, replied: 0, positive: 0, booked: 0 };
  list.forEach(r => {
    t.campaigns += ouInt(r.campaigns); t.running += ouInt(r.running);
    t.sent += ouInt(r.sent); t.replied += ouInt(r.replied);
    t.positive += ouInt(r.positive); t.booked += ouInt(r.booked);
  });
  t.replyPct = ouPct(t.sent, t.replied);
  return t;
}
/* client_id -> the account row we show as "the provider behind it". */
function ouAccountMap(accounts) {
  const m = {};
  (Array.isArray(accounts) ? accounts : []).forEach(a => {
    if (!a || !a.client_id) return;
    if (!m[a.client_id]) m[a.client_id] = a;
  });
  return m;
}
function ouSummaryRowHTML(r, accounts, now) {
  const acc = (accounts || {})[r.client_id] || null;
  const prov = ouProviderName(acc ? acc.provider : '');
  const accTone = acc ? (OU_ACCOUNT_TONE[acc.status] || 'grey') : 'grey';
  const accWords = acc ? (OU_ACCOUNT_WORDS[acc.status] || acc.status || '') : 'Not set up';
  const busy = !!ou.syncing[r.client_id];
  return '<tr>' +
    '<td class="wrap" data-label="Client"><button type="button" class="ou-link" onclick="ouOpenClient(' + ouArg(r.client_id) + ')">' + ouE(r.client_name || 'This client') + '</button></td>' +
    '<td class="num" data-label="Campaigns running">' + ouNum(r.running) + '<span class="ou-of"> of ' + ouNum(r.campaigns) + '</span></td>' +
    '<td class="num" data-label="Sent">' + ouNum(r.sent) + '</td>' +
    '<td class="num" data-label="Replies">' + ouNum(r.replied) + '</td>' +
    '<td class="num" data-label="Reply rate">' + ouE(ouPct(r.sent, r.replied, r.reply_pct)) + '</td>' +
    '<td class="num" data-label="Booked">' + ouNum(r.booked) + '</td>' +
    '<td class="wrap" data-label="Last synced">' + ouE(ouAgo(r.last_synced_at, now)) + '</td>' +
    '<td class="wrap" data-label="Sending tool">' + ouE(prov) + ' ' + ouPill(accTone, accWords) + '</td>' +
    '<td data-label=""><button type="button" class="btn ghost ou-sync" onclick="ouSyncOne(' + ouArg(r.client_id) + ')"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Syncing…' : 'Sync') + '</button></td>' +
    '</tr>';
}
function ouSummaryHTML(rows, accounts, now) {
  const list = Array.isArray(rows) ? rows.filter(r => r) : [];
  const accMap = ouAccountMap(accounts);
  const t = ouSummaryTotals(list);
  const head = '<div class="ou-head"><div class="section-head ou-section"><h3>Outreach</h3>' +
    (list.length ? '<span class="count">' + ouNum(list.length) + '</span>' : '') + '</div>' +
    '<button type="button" class="btn" onclick="ouSyncAll()"' + (ou.syncingAll ? ' disabled' : '') + '>' +
    (ou.syncingAll ? 'Syncing…' : 'Sync all') + '</button></div>';
  if (!list.length) {
    return head + ouEmpty('No outreach yet',
      'Every client who is sending appears here with their campaigns, replies and booked calls. Nobody is sending yet.',
      'Sync all', 'ouSyncAll()');
  }
  const tiles = ouTiles([
    ['Clients sending', ouNum(t.clients)],
    ['Campaigns running', ouNum(t.running)],
    ['Sent', ouNum(t.sent)],
    ['Replies', ouNum(t.replied)],
    ['Reply rate', ouE(t.replyPct)],
    ['Booked', ouNum(t.booked)],
  ]);
  const table = '<div class="card ou-scroll"><table class="ou-table"><thead><tr>' +
    '<th>Client</th><th class="num">Campaigns running</th><th class="num">Sent</th><th class="num">Replies</th>' +
    '<th class="num">Reply rate</th><th class="num">Booked</th><th>Last synced</th><th>Sending tool</th><th></th>' +
    '</tr></thead><tbody>' + list.map(r => ouSummaryRowHTML(r, accMap, now)).join('') +
    '</tbody><tfoot><tr><td>All clients</td><td class="num">' + ouNum(t.running) + '</td><td class="num">' + ouNum(t.sent) +
    '</td><td class="num">' + ouNum(t.replied) + '</td><td class="num">' + ouE(t.replyPct) + '</td><td class="num">' +
    ouNum(t.booked) + '</td><td colspan="3"></td></tr></tfoot></table></div>';
  return head + tiles + table;
}

function viewOutreach() {
  if (ouIsClientView()) {           // a client only ever has their own screen
    const mine = ouClientScope();
    return mine ? viewOutreachClient(mine)
      : ouEmpty('Nothing to show yet', 'Your emails appear here once your campaigns start.');
  }
  ou.sumLoading = true; ou.sumErr = '';
  ouLoadSummary();
  return '<div class="ou" id="ouRoot">' + ouSkeleton() + '</div>';
}
function ouPaint(html) {
  const el = typeof document !== 'undefined' && document.getElementById ? document.getElementById('ouRoot') : null;
  if (el) el.innerHTML = html;
}
async function ouLoadSummary() {
  const seq = ++ou.seq;
  const [s, a] = await Promise.all([ouSummary(), ouAccounts()]);
  if (seq !== ou.seq) return;
  ou.sumLoading = false;
  ou.sum = s.ok ? (s.data || []) : [];
  ou.accounts = a.ok ? (a.data || []) : [];
  ou.sumErr = s.ok ? '' : s.error;
  ouPaint(ou.sumErr ? ouErrCard(ou.sumErr, 'ouLoadSummary()') : ouSummaryHTML(ou.sum, ou.accounts));
}
async function ouSyncOne(clientId) {
  if (ou.syncing[clientId]) return;
  ou.syncing[clientId] = true;
  ouPaint(ouSummaryHTML(ou.sum, ou.accounts));
  const r = await ouSync(clientId);
  delete ou.syncing[clientId];
  if (typeof toast === 'function') toast(r.ok ? 'Synced.' : r.error);
  await ouLoadSummary();
}
async function ouSyncAll() {
  if (ou.syncingAll) return;
  ou.syncingAll = true;
  ouPaint(ouSummaryHTML(ou.sum, ou.accounts));
  const ids = (ou.sum || []).map(r => r && r.client_id).filter(Boolean);
  let bad = '';
  for (const id of ids) { const r = await ouSync(id); if (!r.ok && !bad) bad = r.error }
  await ouCall('oaFlushOutbox');
  ou.syncingAll = false;
  if (typeof toast === 'function') toast(bad || (ids.length ? 'Everyone is synced.' : 'Nothing to sync yet.'));
  await ouLoadSummary();
}

/* ===================== 7. SCREEN TWO — one client ===================== */

/* The last 30 days, one entry per day, campaigns added together, gaps filled with zeroes.
   Always exactly OU_DAYS long, so the chart looks right with no rows at all. */
function ouDays(rows, now, span) {
  const n = ouInt(span) || OU_DAYS;
  const end = new Date(now == null ? Date.now() : now);
  const by = {};
  (Array.isArray(rows) ? rows : []).forEach(r => {
    if (!r || !r.on_day) return;
    const k = String(r.on_day).slice(0, 10);
    const d = by[k] || (by[k] = { day: k, sent: 0, replied: 0, positive: 0, booked: 0 });
    d.sent += ouInt(r.sent); d.replied += ouInt(r.replied);
    d.positive += ouInt(r.positive); d.booked += ouInt(r.booked);
  });
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - i);
    const k = ouDayKey(d);
    out.push(by[k] || { day: k, sent: 0, replied: 0, positive: 0, booked: 0 });
  }
  return out;
}
function ouDaysTotals(days) {
  const t = { sent: 0, replied: 0, positive: 0, booked: 0 };
  (Array.isArray(days) ? days : []).forEach(d => {
    t.sent += ouInt(d.sent); t.replied += ouInt(d.replied);
    t.positive += ouInt(d.positive); t.booked += ouInt(d.booked);
  });
  t.replyPct = ouPct(t.sent, t.replied);
  return t;
}
/* Bars = sent, line = replies. Plain inline SVG — no chart library anywhere in the hub. */
function ouChart(days) {
  const W = 720, H = 200, L = 36, R = 8, T = 10, B = 24;
  const list = Array.isArray(days) && days.length ? days : [];
  const n = list.length || 1, iw = W - L - R, ih = H - T - B;
  const max = Math.max(1, ...list.map(d => Math.max(ouInt(d.sent), ouInt(d.replied))));
  const top = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const y = v => T + ih - (v / top) * ih, step = iw / n, bw = Math.max(2, step * 0.62);
  let s = '<svg class="ou-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" preserveAspectRatio="none" aria-label="Emails sent each day for the last ' + n + ' days, with replies as a line">';
  for (let i = 0; i <= 4; i++) {
    const v = top * i / 4, yy = y(v).toFixed(1);
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" class="ou-grid"/>' +
      '<text x="' + (L - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end" class="ou-ax">' + ouNum(v) + '</text>';
  }
  const pts = [];
  list.forEach((d, i) => {
    const x = L + i * step + (step - bw) / 2, h = (ouInt(d.sent) / top) * ih;
    s += '<rect x="' + x.toFixed(1) + '" y="' + (T + ih - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" class="ou-bar"/>';
    pts.push((L + i * step + step / 2).toFixed(1) + ',' + y(ouInt(d.replied)).toFixed(1));
  });
  if (list.some(d => ouInt(d.replied) > 0)) s += '<polyline points="' + pts.join(' ') + '" class="ou-line"/>';
  list.forEach((d, i) => {
    s += '<rect x="' + (L + i * step).toFixed(1) + '" y="' + T + '" width="' + step.toFixed(1) + '" height="' + ih + '" class="ou-hit"><title>' +
      ouE(ouDayLabel(d.day) + ': ' + ouNum(d.sent) + ' sent, ' + ouNum(d.replied) + ' replies') + '</title></rect>';
  });
  [0, Math.floor((n - 1) / 2), n - 1].forEach((i, k) => {
    if (!list[i]) return;
    s += '<text x="' + (L + i * step + step / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (k === 0 ? 'start' : k === 2 ? 'end' : 'middle') + '" class="ou-ax">' + ouE(ouDayLabel(list[i].day)) + '</text>';
  });
  return s + '</svg>';
}
function ouChartCard(days) {
  const t = ouDaysTotals(days);
  const head = '<div class="ou-card-h"><b>Emails sent, last ' + OU_DAYS + ' days</b><span class="ou-muted">Reply rate ' + ouE(t.replyPct) + '</span></div>';
  const body = t.sent
    ? ouChart(days) + '<div class="ou-legend"><span><i class="ou-k-bar"></i>Sent</span><span><i class="ou-k-line"></i>Replies</span></div>'
    : '<div class="ou-blank"><b>Nothing sent in the last ' + OU_DAYS + ' days</b><span class="ou-muted">The chart fills in as the first emails go out.</span></div>';
  return '<section class="card ou-card">' + head + body + '</section>';
}
function ouCampaignsCard(list) {
  const rows = Array.isArray(list) ? list.filter(c => c) : [];
  const head = '<div class="ou-card-h"><b>Campaigns</b>' + (rows.length ? '<span class="ou-muted">' + ouNum(rows.length) + '</span>' : '') + '</div>';
  if (!rows.length) {
    return '<section class="card ou-card">' + head +
      '<div class="ou-blank"><b>No campaigns yet</b><span class="ou-muted">A campaign appears here as soon as one is set up and sending.</span></div></section>';
  }
  const body = '<div class="ou-scroll"><table class="ou-table"><thead><tr><th>Campaign</th><th>Status</th>' +
    '<th class="num">Sent</th><th class="num">Replies</th><th class="num">Interested</th><th class="num">Booked</th><th class="num">Bounced</th></tr></thead><tbody>' +
    rows.map(c => '<tr><td class="wrap" data-label="Campaign"><b>' + ouE(c.name || 'Campaign') + '</b>' +
      (c.started_on ? '<div class="ou-sub">Started ' + ouE(ouDayLabel(String(c.started_on).slice(0, 10))) + '</div>' : '') + '</td>' +
      '<td data-label="Status">' + ouPill(OU_CAMPAIGN_TONE[c.status] || 'grey', String(c.status || 'draft').replace(/_/g, ' ')) + '</td>' +
      '<td class="num" data-label="Sent">' + ouNum(c.sent) + '</td>' +
      '<td class="num" data-label="Replies">' + ouNum(c.replied) + '</td>' +
      '<td class="num" data-label="Interested">' + ouNum(c.positive) + '</td>' +
      '<td class="num" data-label="Booked">' + ouNum(c.booked) + '</td>' +
      '<td class="num" data-label="Bounced">' + ouNum(c.bounced) + '</td></tr>').join('') +
    '</tbody></table></div>';
  return '<section class="card ou-card">' + head + body + '</section>';
}
function ouInboxesCard(list) {
  const rows = Array.isArray(list) ? list.filter(i => i) : [];
  const head = '<div class="ou-card-h"><b>Inbox health</b></div>';
  if (!rows.length) {
    return '<section class="card ou-card">' + head +
      '<div class="ou-blank"><b>No inboxes yet</b><span class="ou-muted">Inboxes appear here once they are connected and warming up.</span></div></section>';
  }
  const body = '<div class="ou-scroll"><table class="ou-table"><thead><tr><th>Inbox</th><th>Status</th>' +
    '<th class="num">Health</th><th class="num">Sent today</th><th class="num">Daily limit</th></tr></thead><tbody>' +
    rows.map(i => '<tr><td class="wrap" data-label="Inbox">' + ouE(i.email || '—') + (i.warmed ? '' : '<div class="ou-sub">Still warming up</div>') + '</td>' +
      '<td data-label="Status">' + ouPill(OU_INBOX_TONE[i.status] || 'grey', OU_INBOX_WORDS[i.status] || i.status || '—') + '</td>' +
      '<td class="num" data-label="Health">' + (i.health == null ? '—' : ouNum(i.health) + '%') + '</td>' +
      '<td class="num" data-label="Sent today">' + ouNum(i.sent_today) + '</td>' +
      '<td class="num" data-label="Daily limit">' + (ouInt(i.daily_limit) ? ouNum(i.daily_limit) : '—') + '</td></tr>').join('') +
    '</tbody></table></div>';
  return '<section class="card ou-card">' + head + body + '</section>';
}
function ouRepliesCard(list, filter) {
  const rows = Array.isArray(list) ? list.filter(t => t) : [];
  const tabs = [['open', 'Waiting on us'], ['positive', 'Interested'], ['booked', 'Booked'], ['', 'Everything']];
  const head = '<div class="ou-card-h"><b>Replies</b><span class="ou-tabs">' + tabs.map(t =>
    '<button type="button" class="ou-tab' + ((filter || '') === t[0] ? ' on' : '') + '" onclick="ouSetReplyFilter(' + ouArg(t[0]) + ')">' + ouE(t[1]) + '</button>').join('') + '</span></div>';
  if (!rows.length) {
    return '<section class="card ou-card">' + head +
      '<div class="ou-blank"><b>No replies here</b><span class="ou-muted">Every reply lands in this inbox. Nothing is waiting right now.</span></div></section>';
  }
  const body = '<ul class="ou-threads">' + rows.map(t =>
    '<li><button type="button" class="ou-thread-row" onclick="ouOpenThread(' + ouArg(t.id) + ')">' +
      '<span class="ou-thread-who"><b>' + ouE(t.lead_name || t.lead_email || 'Someone') + '</b>' +
        (t.lead_company ? '<span class="ou-sub">' + ouE(t.lead_company) + (t.lead_title ? ' · ' + ouE(t.lead_title) : '') + '</span>' : '') + '</span>' +
      '<span class="ou-thread-pills">' + ouPill(OU_SENTIMENT_TONE[t.sentiment] || 'grey', OU_SENTIMENT_WORDS[t.sentiment] || 'Not read yet') +
        ouPill(OU_THREAD_TONE[t.status] || 'grey', OU_THREAD_WORDS[t.status] || t.status || '') + '</span>' +
      '<span class="ou-thread-when">' + ouE(t.last_message_at ? ouDayLabel(String(t.last_message_at).slice(0, 10)) : '') + '</span>' +
    '</button></li>').join('') + '</ul>';
  return '<section class="card ou-card">' + head + body + '</section>';
}
/* The whole client screen from rows already in hand. Pure: it only returns HTML. */
function ouClientHTML(d) {
  d = d || {};
  const name = d.client && (d.client.client_name || d.client.company) ? (d.client.client_name || d.client.company) : 'This client';
  const days = Array.isArray(d.days) ? d.days : [];
  const dt = ouDaysTotals(days);
  const s = d.client || {};
  const prov = ouProviderName(d.account ? d.account.provider : '');
  const mine = ouIsClientView();
  const head = '<div class="ou-head"><div class="section-head ou-section"><h3>' + ouE(mine ? 'Your emails' : name) + '</h3>' +
    '<span class="ou-muted">' + ouE(ouAgo(s.last_synced_at || (d.account && d.account.last_synced_at))) + (mine ? '' : ' · ' + ouE(prov)) + '</span></div>' +
    (mine ? '' : '<button type="button" class="btn ghost" onclick="ouSyncOne(' + ouArg(d.clientId || '') + ')">Sync</button>') + '</div>';
  const tiles = ouTiles([
    ['Campaigns running', ouNum(s.running)],
    ['Sent', ouNum(s.sent != null ? s.sent : dt.sent)],
    ['Replies', ouNum(s.replied != null ? s.replied : dt.replied)],
    ['Reply rate', ouE(ouPct(s.sent != null ? s.sent : dt.sent, s.replied != null ? s.replied : dt.replied, s.reply_pct))],
    ['Interested', ouNum(s.positive != null ? s.positive : dt.positive)],
    ['Booked', ouNum(s.booked != null ? s.booked : dt.booked)],
  ]);
  const note = d.note ? '<p class="ou-note">' + ouE(d.note) + '</p>' : '';
  return head + note + tiles + ouChartCard(days) + ouCampaignsCard(d.campaigns) +
    ouInboxesCard(d.inboxes) + ouRepliesCard(d.threads, d.replyFilter);
}

function viewOutreachClient(clientId) {
  const id = String(clientId || ou.clientId || ouClientScope() || '');
  if (!id) return ouEmpty('No client chosen', 'Open a client from the outreach list to see their emails.');
  if (!ouMaySee(id)) return ouEmpty('Not your client', 'You can only see your own emails here.');
  ou.clientId = id; ou.clientLoading = true; ou.clientErr = '';
  ouLoadClient(id);
  return '<div class="ou" id="ouRoot">' + ouSkeleton() + '</div>';
}
async function ouLoadClient(clientId) {
  const seq = ++ou.seq;
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  from.setUTCDate(from.getUTCDate() - (OU_DAYS - 1));
  const status = ou.replyFilter === 'positive' ? '' : ou.replyFilter;
  const [sum, acc, camps, daily, threads, inboxes] = await Promise.all([
    ouSummary(), ouAccounts(), ouCampaigns(clientId),
    ouDaily(clientId, ouDayKey(from)), ouThreads(clientId, status), ouInboxes(clientId),
  ]);
  if (seq !== ou.seq) return;
  ou.clientLoading = false;
  const first = [camps, daily, threads, inboxes].find(r => r && !r.ok);
  ou.clientErr = first ? first.error : '';
  if (ou.clientErr) { ouPaint(ouErrCard(ou.clientErr, 'ouLoadClient(' + ouArg(clientId) + ')')); return }
  ou.campaigns = camps.data || [];
  ou.days = ouDays(daily.data || [], now);
  ou.inboxes = inboxes.data || [];
  let list = threads.data || [];
  if (ou.replyFilter === 'positive') list = list.filter(t => t && t.sentiment === 'positive');
  ou.threads = list;
  const client = (sum.ok ? (sum.data || []) : []).find(r => r && r.client_id === clientId) || null;
  const account = (acc.ok ? (acc.data || []) : []).find(a => a && a.client_id === clientId) || null;
  ou.client = client;
  ouPaint(ouClientHTML({
    clientId: clientId, client: client, account: account, campaigns: ou.campaigns,
    days: ou.days, threads: ou.threads, inboxes: ou.inboxes, replyFilter: ou.replyFilter,
    note: ouFn('oaFor') ? '' : OU_NO_ADAPTER,
  }));
}
function ouSetReplyFilter(f) {
  ou.replyFilter = String(f || '');          // '' = everything, 'positive' = read from the sentiment
  if (ou.clientId) ouLoadClient(ou.clientId);
}
function ouOpenClient(clientId) {
  ou.clientId = String(clientId || ''); ou.threadId = '';
  if (typeof render === 'function') render('outreachClient');
  else ouPaint(viewOutreachClient(ou.clientId));
}

/* ===================== 8. SCREEN THREE — one conversation ===================== */

function ouMessageHTML(m) {
  const out = String(m.direction || '') === 'out';
  const del = String(m.delivery || '');
  const words = OU_DELIVERY_WORDS[del] || '';
  const tone = del === 'failed' ? 'red' : del === 'queued' || del === 'sending' ? 'amber' : 'grey';
  return '<li class="ou-msg' + (out ? ' out' : ' in') + '">' +
    '<div class="ou-msg-h"><b>' + ouE(out ? 'Us' : 'Them') + '</b>' +
      '<time>' + ouE(m.sent_at ? ouDayLabel(String(m.sent_at).slice(0, 10)) : '') + '</time>' +
      (out && words ? ouPill(tone, words) : '') + '</div>' +
    (m.subject ? '<div class="ou-msg-s">' + ouE(m.subject) + '</div>' : '') +
    '<div class="ou-msg-b">' + ouE(m.body || '').replace(/\r?\n/g, '<br>') + '</div>' +
    (m.delivery_error ? '<div class="ou-msg-e">' + ouE(m.delivery_error) + '</div>' : '') +
    '</li>';
}
/* One conversation. Pure: it only returns HTML. */
function ouThreadHTML(d) {
  d = d || {};
  const t = d.thread || null;
  const msgs = Array.isArray(d.msgs) ? d.msgs.filter(m => m) : [];
  if (!t) {
    return ouEmpty('That conversation is gone',
      'It may have been closed, or it was never there. Go back to the replies and pick another one.',
      'Back to the client', 'ouBackToClient()');
  }
  const head = '<div class="ou-head"><div class="section-head ou-section"><h3>' +
    ouE(t.lead_name || t.lead_email || 'Someone') + '</h3>' +
    ouPill(OU_SENTIMENT_TONE[t.sentiment] || 'grey', OU_SENTIMENT_WORDS[t.sentiment] || 'Not read yet') +
    ouPill(OU_THREAD_TONE[t.status] || 'grey', OU_THREAD_WORDS[t.status] || t.status || '') + '</div>' +
    (t.sentiment === 'positive' && t.status !== 'booked'
      ? '<button type="button" class="btn" onclick="ouBookThis(' + ouArg(t.id) + ')">Book this one</button>' : '') + '</div>';
  const who = '<p class="ou-who">' + ouE([t.lead_email, t.lead_company, t.lead_title].filter(Boolean).join(' · ')) + '</p>';
  const list = msgs.length
    ? '<ul class="ou-msgs">' + msgs.map(ouMessageHTML).join('') + '</ul>'
    : '<div class="ou-blank"><b>No messages yet</b><span class="ou-muted">The conversation appears here as soon as it is synced.</span></div>';
  const note = d.queuedNote ? '<p class="ou-queued" role="status">' + ouE(d.queuedNote) + '</p>' : '';
  const err = d.sendErr ? '<p class="ou-send-err" role="alert">' + ouE(d.sendErr) + '</p>' : '';
  const box = '<section class="card ou-card ou-reply">' +
    '<div class="ou-card-h"><b>Reply</b><span class="ou-muted">It goes out on the next sync</span></div>' +
    '<input id="ouReplySubject" class="ou-input" type="text" placeholder="Subject (optional)" value="' +
      ouE(d.subject || '') + '" autocomplete="off">' +
    '<textarea id="ouReplyBody" class="ou-input ou-textarea" rows="6" placeholder="Write your reply"></textarea>' +
    err + note +
    '<div class="ou-reply-acts"><button type="button" class="btn" onclick="ouSendReply(' + ouArg(t.id) + ')"' +
      (d.sending ? ' disabled' : '') + '>' + (d.sending ? 'Queueing…' : 'Queue reply') + '</button>' +
      '<button type="button" class="btn ghost" onclick="ouBackToClient()">Back to replies</button></div></section>';
  return head + who + '<section class="card ou-card">' + list + '</section>' + box;
}

function viewOutreachThread(threadId) {
  const id = String(threadId || ou.threadId || '');
  if (!id) return ouEmpty('No conversation chosen', 'Open a reply from the client screen to read it.');
  ou.threadId = id; ou.threadLoading = true; ou.threadErr = ''; ou.sendErr = ''; ou.queuedNote = '';
  ouLoadThread(id);
  return '<div class="ou" id="ouRoot">' + ouSkeleton() + '</div>';
}
async function ouLoadThread(threadId) {
  const seq = ++ou.seq;
  const [t, m] = await Promise.all([ouThreadRow(threadId), ouMessages(threadId)]);
  if (seq !== ou.seq) return;
  ou.threadLoading = false;
  if (!t.ok) { ou.threadErr = t.error; ouPaint(ouErrCard(t.error, 'ouLoadThread(' + ouArg(threadId) + ')')); return }
  ou.thread = t.data || null;
  ou.msgs = m.ok ? (m.data || []) : [];
  if (ou.thread && ou.thread.client_id) ou.clientId = ou.thread.client_id;
  ouPaintThread();
}
function ouPaintThread() {
  ouPaint(ouThreadHTML({
    thread: ou.thread, msgs: ou.msgs, sending: ou.sending,
    sendErr: ou.sendErr, queuedNote: ou.queuedNote,
  }));
}
function ouOpenThread(threadId) {
  ou.threadId = String(threadId || '');
  if (typeof render === 'function') render('outreachThread');
  else ouPaint(viewOutreachThread(ou.threadId));
}
function ouBackToClient() {
  ou.threadId = ''; ou.thread = null; ou.msgs = [];
  if (ou.clientId) ouOpenClient(ou.clientId);
  else if (typeof render === 'function') render('outreach');
}
/* Queue the reply, say so on the screen, then hand the outbox over. */
async function ouSendReply(threadId) {
  if (ou.sending) return;
  const subject = typeof val === 'function' ? val('ouReplySubject') : '';
  const bodyEl = typeof document !== 'undefined' && document.getElementById ? document.getElementById('ouReplyBody') : null;
  const body = bodyEl ? String(bodyEl.value || '').trim() : '';
  ou.sending = true; ou.sendErr = ''; ou.queuedNote = '';
  ouPaintThread();
  const r = await ouQueueReply(threadId || ou.threadId, { subject: subject, body: body });
  ou.sending = false;
  if (!r.ok) { ou.sendErr = r.error; ouPaintThread(); return }
  ou.queuedNote = 'Queued — it goes out on the next sync';
  if (typeof toast === 'function') toast(ou.queuedNote);
  await ouLoadThread(threadId || ou.threadId);
  ou.queuedNote = 'Queued — it goes out on the next sync';
  ouPaintThread();
  return r;
}
async function ouBookThis(threadId) {
  const r = await ouBookThread(threadId || ou.threadId);
  if (typeof toast === 'function') toast(r.ok ? 'Marked as booked.' : r.error);
  if (r.ok) await ouLoadThread(threadId || ou.threadId);
  return r;
}

/* ===================== 9. HOOK FOR THE SHELL ===================== */
/* The router calls this after it draws a view (same shape as numbersOnRender). Nothing here
   runs at load time, and an unknown view is left alone. */
function outreachOnRender(v) {
  if (v === 'outreach') { if (ou.sum.length) ouPaint(ouSummaryHTML(ou.sum, ou.accounts)) }
}
