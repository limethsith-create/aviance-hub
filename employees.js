/* ===================== AVIANCE OS — Employees (the owner's staff screen) =====================
   Who works here, how she gets in, and the 1-to-1 chat with each person.
   Left: the staff list (name, email, status, last seen, unread). Right: the person who is open —
   her access code, her welcome page, and the chat (newest at the bottom, text + one file at a time).

   Data (database functions in 20261125_staff.sql, owner only; see /home/claude/staff/SPEC.md):
     staff_list()                        -> [{id,name,email,status,last_seen_at,channel_id,unread,code_set,created_at}]
     staff_add(p_name,p_email)           -> {staff_id, channel_id}
     staff_set_status(p_staff,p_status)   staff_mark_read(p_channel)   staff_doc_token(p_staff) -> token
   plus plain channel_messages / channel_members reads and writes (the owner is team, so normal RLS applies)
   and the `chat-files` bucket for attachments.
   The access code comes from the `staff-code` edge function, never from the database: it is returned once,
   held in emp.code only while that panel is open, never written to storage and never logged.

   Nothing here is applied yet — agent A's migration and agent D's function land at the end — so every data
   function says "not set up yet" in plain English instead of throwing when an RPC or the bucket is missing.

   House rules: data functions (emp*) resolve to {ok, data, error} and never throw; render functions are pure
   (data in, HTML string out) so the tests can call them; every string goes through esc(); ids reach handlers
   through empA(); nothing runs at load. */

/* ===================== 0. STATE ===================== */
const EMP_LIST_MS = 60000;                 // background refresh of the list + the sidebar badge
const EMP_CHAT_MS = 10000;                 // the open chat, while the tab is in front
const EMP_MAX_FILE = 10 * 1024 * 1024;     // 10 MB a file, as the bucket allows
const EMP_OK_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'pdf', 'docx', 'csv'];
const EMP_BUCKET = 'chat-files';
const EMP_BODY_MAX = 4000;
const EMP_NOT_READY = "The Employees area isn't switched on yet. Once the database update is applied, your staff will show here.";
const EMP_CODE_NOT_READY = "The access-code function isn't deployed yet, so there is no code to show. Try again once it is.";
const EMP_FILES_NOT_READY = "File uploads aren't switched on yet. Send the message as text for now.";

const emp = {
  list: [], loaded: false, loading: false, err: null, missing: false, count: 0,
  open: null,                      // the staff id whose panel is open
  msgs: [], msgsLoaded: false, msgsErr: null, herReadAt: null,
  draft: '', sending: false, file: null, fileErr: null,
  adding: false, addErr: null, addBusy: false, addName: '', addEmail: '',
  code: null,                      // {staffId, code} — lives only while the panel is open
  codeBusy: '', codeErr: null,
  ask: '',                         // inline "are you sure" for reset / revoke: '<what>:<id>'
  busy: {}, timer: null, chatTimer: null, seq: 0, mseq: 0,
};

/* ===================== 1. DATA ===================== */
function empSb() { try { if (typeof sb !== 'undefined' && sb) return sb; } catch (e) { } return (typeof window !== 'undefined' && window.sb) || null; }
function empUrl() { try { if (typeof SUPA_URL === 'string' && SUPA_URL) return SUPA_URL; } catch (e) { } return 'https://zjbxnkpktbghhudjbxhk.supabase.co'; }
function empKey() { try { if (typeof SUPA_KEY === 'string' && SUPA_KEY) return SUPA_KEY; } catch (e) { } return ''; }
function empOwnerId() { try { return (typeof authUser !== 'undefined' && authUser && authUser.uid) || null; } catch (e) { return null; } }

/* Is this "the database update has not been applied yet" rather than a real failure? */
function empMissing(err) {
  if (!err) return false;
  const msg = String(err.message || err), code = String(err.code || '');
  return code === 'PGRST202' || code === '42883' || code === '42P01' ||
    /could not find the function|does not exist|schema cache|bucket not found/i.test(msg);
}
function empPlain(err, fallback) {
  if (!err) return fallback;
  const msg = String(err.message || err), code = String(err.code || '');
  if (empMissing(err)) return EMP_NOT_READY;
  if (/failed to fetch|networkerror|network request|load failed|fetch failed/i.test(msg)) return "Can't reach Aviance right now. Check your connection and try again.";
  if (code === 'PGRST301' || /jwt|not authenticated|session/i.test(msg)) return 'Your sign-in has run out. Please sign in again.';
  if (code === '42501' || /permission denied|not authorized|row-level security/i.test(msg)) return "You don't have access to do that.";
  if (code === 'P0001' && msg) return msg;
  return fallback;
}
async function empRpc(name, args, fallback) {
  const s = empSb();
  if (!s) return { ok: false, data: null, error: 'Aviance is not ready yet. Please reload the page.', missing: false };
  try {
    const r = await s.rpc(name, args || {});
    if (r && r.error) return { ok: false, data: null, error: empPlain(r.error, fallback), missing: empMissing(r.error) };
    return { ok: true, data: r ? r.data : null, error: null, missing: false };
  } catch (e) { return { ok: false, data: null, error: empPlain(e, fallback), missing: empMissing(e) }; }
}

function empRow(r) {
  return {
    id: r.id, name: r.name || '', email: r.email || '', status: r.status || 'invited',
    lastSeenAt: r.last_seen_at || null, channelId: r.channel_id || null,
    unread: Math.max(0, Number(r.unread) || 0), codeSet: !!r.code_set, createdAt: r.created_at || null,
  };
}
function empMsgRow(r) {
  return {
    id: r.id, authorUser: r.author_user || null, authorPerson: r.author_person || null,
    body: r.body || '', attachment: r.attachment_url || null,
    createdAt: r.created_at || null, kind: r.msg_kind || 'chat',
  };
}

async function empFetchList() {
  const r = await empRpc('staff_list', {}, "The staff list didn't load. Try again.");
  if (!r.ok) return r;
  const rows = (Array.isArray(r.data) ? r.data : []).filter(x => x && x.id).map(empRow);
  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return { ok: true, data: rows, error: null, missing: false };
}

/* The two checks the Add form runs before anything reaches the database. Pure. */
function empNameProblem(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return 'Type her name.';
  if (n.length < 2) return 'That name looks too short.';
  if (n.length > 80) return 'Keep the name under 80 characters.';
  return '';
}
function empEmailProblem(email) {
  const e = String(email == null ? '' : email).trim();
  if (!e) return 'Type her email address.';
  if (e.length > 160) return 'That email address is too long.';
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(e)) return "That doesn't look like an email address.";
  return '';
}
function empFileProblem(file) {
  if (!file) return '';
  const name = String((file && file.name) || '');
  const size = Number((file && file.size) || 0);
  const ext = empExt(name);
  if (!name) return 'Pick a file first.';
  if (!ext || EMP_OK_EXT.indexOf(ext) < 0) return 'You can send an image, a PDF, a Word file or a CSV.';
  if (size > EMP_MAX_FILE) return 'That file is bigger than 10 MB. Send a smaller one.';
  return '';
}
function empExt(name) {
  const m = String(name == null ? '' : name).toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

async function empAdd(name, email) {
  const n = String(name == null ? '' : name).trim(), e = String(email == null ? '' : email).trim();
  const bad = empNameProblem(n) || empEmailProblem(e);
  if (bad) return { ok: false, data: null, error: bad, missing: false };
  return empRpc('staff_add', { p_name: n, p_email: e.toLowerCase() }, "She wasn't added. Try again.");
}
async function empSetStatus(staffId, status) {
  if (!staffId) return { ok: false, data: null, error: 'Pick a person first.', missing: false };
  if (['active', 'invited', 'revoked'].indexOf(String(status)) < 0) return { ok: false, data: null, error: 'That is not a status.', missing: false };
  return empRpc('staff_set_status', { p_staff: staffId, p_status: String(status) }, "That didn't change. Try again.");
}
async function empMarkRead(channelId) {
  if (!channelId) return { ok: false, data: null, error: 'There is no channel to mark read.', missing: false };
  return empRpc('staff_mark_read', { p_channel: channelId }, '');
}
/* The welcome one-pager: a signed token, opened in a new tab as doc.html#<token>. */
async function empDocLink(staffId) {
  if (!staffId) return { ok: false, data: null, error: 'Pick a person first.', missing: false };
  const r = await empRpc('staff_doc_token', { p_staff: staffId }, "The welcome page link didn't come back. Try again.");
  if (!r.ok) return r;
  const url = empDocUrl(r.data);
  if (!url) return { ok: false, data: null, error: "The welcome page isn't ready yet.", missing: true };
  return { ok: true, data: url, error: null, missing: false };
}
function empDocUrl(token) {
  const t = String(token == null ? '' : token).trim();
  return /^[A-Za-z0-9._~-]{8,512}$/.test(t) ? ('doc.html#' + t) : '';
}

const EMP_MSG_COLS = 'id,channel_id,author_user,author_person,body,attachment_url,created_at,msg_kind';
const EMP_MSG_COLS_OLD = 'id,channel_id,author_user,author_person,body,attachment_url,created_at';
let empMsgCols = EMP_MSG_COLS;
async function empMessages(channelId) {
  const s = empSb();
  if (!s) return { ok: false, data: null, error: 'Aviance is not ready yet. Please reload the page.', missing: false };
  if (!channelId) return { ok: false, data: null, error: 'There is no channel to open yet.', missing: false };
  try {
    const ask = () => s.from('channel_messages').select(empMsgCols).eq('channel_id', channelId)
      .is('deleted_at', null).order('created_at', { ascending: true }).limit(300);
    let r = await ask();
    /* An older database without msg_kind: ask for the columns it does have. */
    if (r && r.error && /msg_kind/.test(String(r.error.message || ''))) { empMsgCols = EMP_MSG_COLS_OLD; r = await ask(); }
    if (!r) return { ok: false, data: null, error: 'No answer from Aviance.', missing: false };
    if (r.error) return { ok: false, data: null, error: empPlain(r.error, "The messages didn't load. Try again."), missing: empMissing(r.error) };
    return { ok: true, data: (r.data || []).map(empMsgRow), error: null, missing: false };
  } catch (e) { return { ok: false, data: null, error: empPlain(e, "The messages didn't load. Try again."), missing: empMissing(e) }; }
}
/* Her last_read_at on the channel: that is what "Seen" means. */
async function empHerReadAt(channelId) {
  const s = empSb();
  if (!s || !channelId) return { ok: true, data: null, error: null, missing: false };
  try {
    const r = await s.from('channel_members').select('user_id,last_read_at').eq('channel_id', channelId);
    if (r && r.error) return { ok: false, data: null, error: empPlain(r.error, ''), missing: empMissing(r.error) };
    const me = empOwnerId();
    const hers = (r && r.data || []).filter(x => x && x.user_id && x.user_id !== me);
    let best = null;
    hers.forEach(x => { const t = Date.parse(x.last_read_at || ''); if (t && (!best || t > Date.parse(best))) best = x.last_read_at; });
    return { ok: true, data: best, error: null, missing: false };
  } catch (e) { return { ok: false, data: null, error: empPlain(e, ''), missing: empMissing(e) }; }
}
async function empSendMessage(channelId, body, attachment) {
  const s = empSb();
  if (!s) return { ok: false, data: null, error: 'Aviance is not ready yet. Please reload the page.', missing: false };
  if (!channelId) return { ok: false, data: null, error: 'There is no channel to write to yet.', missing: false };
  const text = String(body == null ? '' : body).trim().slice(0, EMP_BODY_MAX);
  const file = attachment ? String(attachment) : null;
  if (!text && !file) return { ok: false, data: null, error: 'Write a message first.', missing: false };
  const me = empOwnerId();
  if (!me) return { ok: false, data: null, error: 'Your sign-in has run out. Please sign in again.', missing: false };
  try {
    const row = { channel_id: channelId, author_user: me, body: text, msg_kind: 'chat' };
    if (file) row.attachment_url = file;
    const r = await s.from('channel_messages').insert(row).select(empMsgCols).single();
    if (!r) return { ok: false, data: null, error: 'No answer from Aviance.', missing: false };
    if (r.error) return { ok: false, data: null, error: empPlain(r.error, "That didn't send. Try again."), missing: empMissing(r.error) };
    return { ok: true, data: r.data ? empMsgRow(r.data) : null, error: null, missing: false };
  } catch (e) { return { ok: false, data: null, error: empPlain(e, "That didn't send. Try again."), missing: empMissing(e) }; }
}
function empUuid() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { }
  return 'f' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}
/* Paths are <channel_id>/<uuid>.<ext>, as the bucket's policies expect. */
function empFilePath(channelId, name) {
  const ext = empExt(name);
  return String(channelId || '') + '/' + empUuid() + (ext ? '.' + ext : '');
}
async function empUpload(channelId, file) {
  const s = empSb();
  if (!s || !s.storage) return { ok: false, data: null, error: EMP_FILES_NOT_READY, missing: true };
  const bad = empFileProblem(file);
  if (bad) return { ok: false, data: null, error: bad, missing: false };
  if (!channelId) return { ok: false, data: null, error: 'There is no channel to send a file to yet.', missing: false };
  const path = empFilePath(channelId, file.name);
  try {
    const r = await s.storage.from(EMP_BUCKET).upload(path, file, { upsert: false, contentType: (file && file.type) || undefined });
    if (r && r.error) {
      const m = String(r.error.message || '');
      if (/bucket not found|not found/i.test(m)) return { ok: false, data: null, error: EMP_FILES_NOT_READY, missing: true };
      return { ok: false, data: null, error: empPlain(r.error, "That file didn't upload. Try again."), missing: false };
    }
    return { ok: true, data: path, error: null, missing: false };
  } catch (e) { return { ok: false, data: null, error: empPlain(e, "That file didn't upload. Try again."), missing: empMissing(e) }; }
}
async function empFileUrl(pathOrLink) {
  const p = String(pathOrLink == null ? '' : pathOrLink).trim();
  if (!p) return { ok: false, data: null, error: 'There is no file here.', missing: false };
  if (/^https?:\/\//i.test(p)) return { ok: true, data: p, error: null, missing: false };
  const s = empSb();
  if (!s || !s.storage) return { ok: false, data: null, error: EMP_FILES_NOT_READY, missing: true };
  try {
    const r = await s.storage.from(EMP_BUCKET).createSignedUrl(p, 120);
    if (r && r.error) return { ok: false, data: null, error: empPlain(r.error, "That file didn't open. Try again."), missing: empMissing(r.error) };
    const url = (r && r.data && (r.data.signedUrl || r.data.signedURL)) || '';
    if (!url) return { ok: false, data: null, error: "That file didn't open. Try again.", missing: false };
    return { ok: true, data: url, error: null, missing: false };
  } catch (e) { return { ok: false, data: null, error: empPlain(e, "That file didn't open. Try again."), missing: empMissing(e) }; }
}

/* The access code. The edge function makes it, sets it as her password and hands it back once.
   It is never logged and never kept anywhere but emp.code, which is dropped when the panel closes. */
async function empCode(staffId) {
  if (!staffId) return { ok: false, data: null, error: 'Pick a person first.', missing: false };
  const s = empSb();
  if (!s || !s.auth || typeof fetch !== 'function') return { ok: false, data: null, error: 'Aviance is not ready yet. Please reload the page.', missing: false };
  let token = '';
  try { const g = await s.auth.getSession(); token = (g && g.data && g.data.session && g.data.session.access_token) || ''; } catch (e) { token = ''; }
  if (!token) return { ok: false, data: null, error: 'Your sign-in has run out. Please sign in again.', missing: false };
  try {
    const res = await fetch(empUrl() + '/functions/v1/staff-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: empKey() },
      body: JSON.stringify({ staff_id: staffId }),
    });
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (res && res.ok && j && j.ok && typeof j.code === 'string' && j.code) return { ok: true, data: j.code, error: null, missing: false };
    if (res && (res.status === 404 || res.status === 501)) return { ok: false, data: null, error: EMP_CODE_NOT_READY, missing: true };
    if (res && res.status === 401) return { ok: false, data: null, error: 'Your sign-in has run out. Please sign in again.', missing: false };
    if (res && res.status === 403) return { ok: false, data: null, error: "You don't have access to do that.", missing: false };
    const said = j && typeof j.error === 'string' && j.error ? j.error : '';
    return { ok: false, data: null, error: said || "The code didn't come back. Try again.", missing: false };
  } catch (e) { return { ok: false, data: null, error: empPlain(e, "The code didn't come back. Try again."), missing: false }; }
}

/* ===================== 2. NAV BADGE ===================== */
function empIsOwner() { try { return !!(typeof authUser !== 'undefined' && authUser && authUser.role === 'admin'); } catch (e) { return false; } }
function empUnreadTotal(list) {
  return (Array.isArray(list) ? list : []).reduce((n, s) => n + (Math.max(0, Number(s && s.unread) || 0)), 0);
}
function empCount() {
  if (!empIsOwner()) { empStop(); return 0; }
  empStart();
  const n = Number(emp.count) || 0;
  return n > 99 ? '99+' : n;
}
function empStart() {
  if (emp.timer || emp.missing || typeof setInterval !== 'function') return;
  emp.timer = setInterval(empTick, EMP_LIST_MS);
  if (emp.timer && emp.timer.unref) emp.timer.unref();
  setTimeout(empTick, 0);
}
function empStop() { if (emp.timer) { clearInterval(emp.timer); emp.timer = null; } }
async function empTick() {
  if (!empIsOwner() || emp.missing) { empStop(); return; }
  if (typeof document !== 'undefined' && document.hidden) return;
  await empLoad(true);
}
function empSetCount(n) {
  const changed = n !== emp.count; emp.count = n;
  if (changed) { try { if (typeof renderNav === 'function') renderNav(); } catch (e) { } }
}
/* Sign-out: drop the list, the messages and — above all — any code still on screen. */
function employeesForget() {
  empStop(); empChatStop();
  Object.assign(emp, {
    list: [], loaded: false, loading: false, err: null, missing: false, count: 0,
    open: null, msgs: [], msgsLoaded: false, msgsErr: null, herReadAt: null,
    draft: '', sending: false, file: null, fileErr: null,
    adding: false, addErr: null, addBusy: false, code: null, codeBusy: '', codeErr: null,
    ask: '', busy: {}, seq: emp.seq + 1, mseq: emp.mseq + 1,
  });
}

/* ===================== 3. RENDER (pure: data in, HTML out) ===================== */
function empA(v) { return esc(JSON.stringify(v == null ? '' : String(v))); }
function empEl(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }

function empStatusLabel(status) {
  return ({ active: 'Active', invited: 'Code sent', revoked: 'No access' })[String(status || '')] || 'Not set up';
}
function empStatusTone(status) {
  return ({ active: 'ok', invited: 'wait', revoked: 'off' })[String(status || '')] || 'wait';
}
function empTime(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function empAgo(iso) {
  const t = Date.parse(iso || '');
  if (!t) return 'never';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}
function empLastSeenText(iso) {
  const s = empAgo(iso);
  return s === 'never' ? 'Not signed in yet' : 'Last seen ' + s;
}
function empAttachName(url) {
  let s = String(url == null ? '' : url).split('?')[0].split('#')[0];
  s = s.slice(s.lastIndexOf('/') + 1);
  try { s = decodeURIComponent(s); } catch (e) { /* keep it as it came */ }
  return s || 'Attachment';
}
/* "Seen 14:32" under the last message the owner sent, or "Sent" when she has not read it yet. */
function empSeenText(msgs, ctx) {
  const c = ctx || {};
  const mine = (Array.isArray(msgs) ? msgs : []).filter(m => m && c.ownerId && m.authorUser === c.ownerId);
  const last = mine[mine.length - 1];
  if (!last) return '';
  const read = Date.parse(c.herReadAt || '');
  const sent = Date.parse(last.createdAt || '');
  if (read && sent && read >= sent) return 'Seen ' + empTime(c.herReadAt);
  return 'Sent';
}

function empEmptyHTML(list) {
  const any = (Array.isArray(list) ? list : []).length;
  return `<div class="card emp-blank">
    <h3>${any ? 'Pick someone' : 'No one works here yet'}</h3>
    <p>${any ? 'Choose a person on the left to see her access code, her welcome page and your chat with her.'
      : 'Press “Add employee”, type her name and her Gmail address, and she gets her own private channel with you — and nothing else in Aviance.'}</p>
  </div>`;
}
function empAddFormHTML(ctx) {
  const c = ctx || {};
  return `<form class="card emp-add" onsubmit="empAddSave(event);return false;" aria-label="Add an employee">
    <h3>Add an employee</h3>
    <label class="emp-lab" for="empAddName">Her name</label>
    <input id="empAddName" type="text" autocomplete="off" maxlength="80" value="${esc(c.addName || '')}" placeholder="Jane Perera">
    <label class="emp-lab" for="empAddEmail">Her email (the Gmail she will sign in with)</label>
    <input id="empAddEmail" type="email" autocomplete="off" maxlength="160" value="${esc(c.addEmail || '')}" placeholder="jane@gmail.com">
    ${c.addErr ? `<p class="emp-bad" role="alert">${esc(c.addErr)}</p>` : ''}
    <p class="emp-note">This makes her channel. She still needs an access code — you generate that next, and send it to her yourself.</p>
    <div class="emp-acts">
      <button type="submit" class="btn"${c.addBusy ? ' disabled' : ''}>${c.addBusy ? 'Adding…' : 'Add her'}</button>
      <button type="button" class="btn ghost" onclick="empAddCancel()"${c.addBusy ? ' disabled' : ''}>Cancel</button>
    </div>
  </form>`;
}
function empRowHTML(s, ctx) {
  const c = ctx || {}, on = c.openId && s && s.id === c.openId;
  const unread = Math.max(0, Number(s && s.unread) || 0);
  return `<button type="button" class="emp-row${on ? ' on' : ''}" onclick="empOpen(${empA(s.id)})"${on ? ' aria-current="true"' : ''}
      aria-label="${esc((s.name || 'Employee') + ' — ' + empStatusLabel(s.status) + (unread ? ', ' + unread + ' unread' : ''))}">
    <span class="emp-rtop"><span class="emp-rname">${esc(s.name || 'No name')}</span>
      ${unread ? `<span class="badge red" aria-hidden="true">${esc(unread > 99 ? '99+' : unread)}</span>` : ''}</span>
    <span class="emp-remail">${esc(s.email || '')}</span>
    <span class="emp-rmeta"><span class="emp-tag ${empStatusTone(s.status)}">${esc(empStatusLabel(s.status))}</span>
      <span class="emp-rseen">${esc(empLastSeenText(s.lastSeenAt))}</span></span>
  </button>`;
}
function empListHTML(list, ctx) {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return `<div class="card emp-none">Nobody is set up yet.</div>`;
  return `<div class="emp-list" role="list">${rows.map(s => empRowHTML(s, ctx)).join('')}</div>`;
}
/* The code, shown once. No copy of it is kept once this panel closes. */
function empCodeHTML(code, staff) {
  const c = String(code == null ? '' : code);
  const who = (staff && staff.name) || 'her';
  if (!c) return '';
  return `<div class="card emp-code" role="alert" aria-live="assertive">
    <h3>${esc(who)}’s access code</h3>
    <p class="emp-code-val" id="empCodeVal">${esc(c)}</p>
    <div class="emp-acts">
      <button type="button" class="btn" onclick="empCopyCode()">Copy code</button>
      <button type="button" class="btn ghost" onclick="empCodeHide()">Done — I’ve copied it</button>
    </div>
    <p class="emp-code-warn"><b>This code is shown once and will not be shown again.</b> Send it to ${esc(who)} yourself —
      she signs in at aviance.store/team with her email address and this code. If it gets lost, press “Reset code” and send her the new one.</p>
  </div>`;
}
function empAskHTML(what, s) {
  const reset = what === 'reset';
  return `<div class="emp-ask" role="alert">
    <p>${reset ? `Make a new code for ${esc(s.name || 'her')}? Her old code stops working straight away.`
      : `Take away ${esc(s.name || 'her')}’s access? She won’t be able to sign in. Nothing is deleted — you can let her back in later.`}</p>
    <div class="emp-acts">
      <button type="button" class="btn" onclick="${reset ? `empCodeGo(${empA(s.id)})` : `empRevokeGo(${empA(s.id)})`}">${reset ? 'Yes, new code' : 'Yes, take it away'}</button>
      <button type="button" class="btn ghost" onclick="empAskNo()">No, leave it</button>
    </div>
  </div>`;
}
function empMsgHTML(m, ctx) {
  const c = ctx || {};
  const mine = !!(c.ownerId && m && m.authorUser === c.ownerId);
  const sys = m && m.kind && m.kind !== 'chat';
  return `<div class="emp-msg${mine ? ' mine' : ''}${sys ? ' sys' : ''}">
    <div class="emp-bub">
      ${m.body ? `<p class="emp-btext">${esc(m.body)}</p>` : ''}
      ${m.attachment ? `<button type="button" class="emp-file" onclick="empOpenFile(${empA(m.attachment)})">${esc(empAttachName(m.attachment))}</button>` : ''}
      ${!m.body && !m.attachment ? `<p class="emp-btext emp-muted">(empty message)</p>` : ''}
    </div>
    <time class="emp-mtime">${esc(empTime(m.createdAt))}</time>
  </div>`;
}
function empChatHTML(msgs, ctx) {
  const c = ctx || {}, rows = Array.isArray(msgs) ? msgs : [];
  if (!c.msgsLoaded && c.msgsErr) return `<div class="emp-thread"><p class="emp-bad" role="alert">${esc(c.msgsErr)}</p>
    <button type="button" class="btn ghost" onclick="empLoadMessages(true)">Try again</button></div>`;
  if (!c.msgsLoaded) return `<div class="emp-thread"><p class="emp-muted" role="status">Loading the messages…</p></div>`;
  if (!rows.length) return `<div class="emp-thread"><p class="emp-muted">No messages yet. Say hello — she sees this the moment she signs in.</p></div>`;
  const seen = empSeenText(rows, c);
  return `<div class="emp-thread" id="empThread">${rows.map(m => empMsgHTML(m, c)).join('')}
    ${seen ? `<p class="emp-seen" aria-live="polite">${esc(seen)}</p>` : ''}</div>`;
}
function empComposerHTML(ctx) {
  const c = ctx || {};
  return `<div class="emp-comp">
    ${c.msgsErr && c.msgsLoaded ? `<p class="emp-bad" role="alert">${esc(c.msgsErr)}</p>` : ''}
    ${c.fileErr ? `<p class="emp-bad" role="alert">${esc(c.fileErr)}</p>` : ''}
    ${c.fileName ? `<p class="emp-pick">Attaching <b>${esc(c.fileName)}</b> <button type="button" class="emp-x" onclick="empDropFile()">Remove</button></p>` : ''}
    <textarea id="empDraft" class="emp-box" rows="2" maxlength="${EMP_BODY_MAX}" placeholder="Write to her…"
      oninput="empDraftIn(this.value)" onkeydown="empKey(event)"${c.sending ? ' disabled' : ''}>${esc(c.draft || '')}</textarea>
    <div class="emp-acts">
      <button type="button" class="btn" onclick="empSendClick()"${c.sending ? ' disabled' : ''}>${c.sending ? 'Sending…' : 'Send'}</button>
      <button type="button" class="btn ghost" onclick="empPick()"${c.sending ? ' disabled' : ''}>Attach a file</button>
      <input type="file" id="empFile" hidden onchange="empFileIn(this)">
      <span class="emp-muted emp-tip">Ctrl+Enter sends</span>
    </div>
  </div>`;
}
function empPanelHTML(s, ctx) {
  const c = ctx || {};
  const busy = c.busy && c.busy[s.id] || '';
  const codeOn = !!(c.code && c.code.staffId === s.id && c.code.code);
  const revoked = s.status === 'revoked';
  return `<div class="emp-panel">
    <header class="card emp-phead">
      <div class="emp-pwho"><h2 class="emp-pname">${esc(s.name || 'No name')}</h2>
        <p class="emp-pmail">${esc(s.email || '')}</p>
        <p class="emp-pmeta"><span class="emp-tag ${empStatusTone(s.status)}">${esc(empStatusLabel(s.status))}</span>
          <span class="emp-rseen">${esc(empLastSeenText(s.lastSeenAt))}</span></p></div>
      <div class="emp-pacts">
        <button type="button" class="btn" onclick="${s.codeSet ? `empAskYes('reset',${empA(s.id)})` : `empCodeGo(${empA(s.id)})`}"${busy ? ' disabled' : ''}>
          ${busy === 'code' ? 'Making a code…' : (s.codeSet ? 'Reset code' : 'Generate access code')}</button>
        <button type="button" class="btn ghost" onclick="${revoked ? `empRevokeGo(${empA(s.id)},'active')` : `empAskYes('revoke',${empA(s.id)})`}"${busy ? ' disabled' : ''}>
          ${busy === 'status' ? 'Changing…' : (revoked ? 'Let her back in' : 'Revoke access')}</button>
        <button type="button" class="btn ghost" onclick="empWelcome(${empA(s.id)})"${busy ? ' disabled' : ''}>${busy === 'doc' ? 'Opening…' : 'Welcome page'}</button>
      </div>
    </header>
    ${c.ask === 'reset:' + s.id ? empAskHTML('reset', s) : ''}
    ${c.ask === 'revoke:' + s.id ? empAskHTML('revoke', s) : ''}
    ${c.codeErr ? `<p class="card emp-bad" role="alert">${esc(c.codeErr)}</p>` : ''}
    ${codeOn ? empCodeHTML(c.code.code, s) : ''}
    <section class="card emp-chat" aria-label="${esc('Chat with ' + (s.name || 'her'))}">
      ${empChatHTML(c.msgs, c)}
      ${empComposerHTML(c)}
    </section>
  </div>`;
}
function empScreenHTML(list, ctx) {
  const c = ctx || {}, rows = Array.isArray(list) ? list : [];
  const open = rows.find(s => s && s.id === c.openId) || null;
  const n = rows.length;
  return `${c.err ? `<div class="emp-bad emp-top" role="alert">${esc(c.err)}</div>` : ''}
    <div class="emp-grid">
      <section class="emp-side" aria-label="Your staff">
        <div class="emp-bar"><p class="emp-hint">${esc(n ? n + (n === 1 ? ' person' : ' people') : 'Nobody yet')}</p>
          <button type="button" class="btn" onclick="empAddOpen()"${c.adding ? ' disabled' : ''}>Add employee</button></div>
        ${c.adding ? empAddFormHTML(c) : ''}
        ${empListHTML(rows, c)}
      </section>
      <section class="emp-main">${open ? empPanelHTML(open, c) : empEmptyHTML(rows)}</section>
    </div>`;
}

/* ===================== 4. THE SCREEN ===================== */
function empCtx() {
  return {
    openId: emp.open, ownerId: empOwnerId(), err: emp.err,
    adding: emp.adding, addErr: emp.addErr, addBusy: emp.addBusy,
    addName: emp.addName, addEmail: emp.addEmail,
    busy: emp.busy, code: emp.code, codeErr: emp.codeErr, ask: emp.ask,
    msgs: emp.msgs, msgsLoaded: emp.msgsLoaded, msgsErr: emp.msgsErr, herReadAt: emp.herReadAt,
    draft: emp.draft, sending: emp.sending, fileName: emp.file ? emp.file.name : '', fileErr: emp.fileErr,
  };
}
function viewEmployees() {
  empLoad(false);
  return `<div class="emp" id="empRoot">${empBodyHTML()}</div>`;
}
function empBodyHTML() {
  if (!emp.loaded && emp.err) {
    return `<div class="card emp-blank" role="alert"><h3>${esc(emp.missing ? 'Not switched on yet' : "The staff list didn't load")}</h3>
      <p>${esc(emp.err)}</p>${emp.missing ? '' : `<button type="button" class="btn" onclick="empLoad(true)">Try again</button>`}</div>`;
  }
  if (!emp.loaded) return `<div class="card emp-blank" role="status">Loading your staff…</div>`;
  return empScreenHTML(emp.list, empCtx());
}
function empPaint() {
  const r = empEl('empRoot');
  if (!r) return;
  /* Don't wipe what he is typing: a repaint while a box has focus would lose the caret. */
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (a && a.id && (a.id === 'empDraft' || a.id === 'empAddName' || a.id === 'empAddEmail')) return;
  r.innerHTML = empBodyHTML();
  empScrollChat();
}
function empScrollChat() {
  const t = empEl('empThread');
  if (t && typeof t.scrollHeight === 'number') t.scrollTop = t.scrollHeight;
}
async function empLoad(force) {
  if (emp.loading && !force) return;
  emp.loading = true;
  const seq = ++emp.seq;
  const r = await empFetchList();
  if (seq !== emp.seq) return;
  emp.loading = false;
  if (r.ok) {
    emp.list = r.data; emp.loaded = true; emp.err = null; emp.missing = false;
    if (emp.open && !emp.list.some(s => s.id === emp.open)) empCloseOpen();
    empSetCount(empUnreadTotal(emp.list));
  } else {
    emp.err = r.error; emp.missing = !!r.missing;
    if (emp.missing) { emp.loaded = false; empStop(); empSetCount(0); }
  }
  empPaint();
}

/* ---- the Add form ---- */
function empAddOpen() { emp.adding = true; emp.addErr = null; emp.addName = ''; emp.addEmail = ''; empPaint(); setTimeout(() => { const e = empEl('empAddName'); if (e && e.focus) e.focus(); }, 0); }
function empAddCancel() { emp.adding = false; emp.addErr = null; emp.addName = ''; emp.addEmail = ''; empPaint(); }
async function empAddSave(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  if (emp.addBusy) return;
  const name = (empEl('empAddName') || {}).value || '', email = (empEl('empAddEmail') || {}).value || '';
  emp.addName = name; emp.addEmail = email;
  const bad = empNameProblem(name) || empEmailProblem(email);
  if (bad) { emp.addErr = bad; emp.adding = true; emp.addBusy = false; empForcePaint(); return; }
  emp.addBusy = true; emp.addErr = null; empForcePaint();
  const r = await empAdd(name, email);
  emp.addBusy = false;
  if (!r.ok) { emp.addErr = r.error; empForcePaint(); return; }
  emp.adding = false; emp.addName = ''; emp.addEmail = '';
  const id = r.data && (r.data.staff_id || r.data.staffId) || null;
  if (typeof toast === 'function') toast(String(name).trim() + ' is added. Now generate her access code.');
  await empLoad(true);
  if (id) empOpen(id);
}
/* A repaint the focus guard must not skip (the form itself changed). */
function empForcePaint() { const r = empEl('empRoot'); if (r) { r.innerHTML = empBodyHTML(); empScrollChat(); } }

/* ---- one person ---- */
function empOpen(id) {
  if (!id) return;
  if (emp.open !== id) empForgetCode();
  emp.open = id; emp.ask = ''; emp.codeErr = null;
  emp.msgs = []; emp.msgsLoaded = false; emp.msgsErr = null; emp.herReadAt = null;
  emp.draft = ''; emp.file = null; emp.fileErr = null;
  empForcePaint();
  empChatStart();
  empLoadMessages(true);
}
function empCloseOpen() { emp.open = null; empForgetCode(); empChatStop(); }
/* The code never outlives its panel. */
function empForgetCode() { emp.code = null; emp.codeErr = null; emp.codeBusy = ''; }
function empCodeHide() { empForgetCode(); empForcePaint(); }
function empFind(id) { return emp.list.find(s => s.id === id) || null; }
function empOpenRow() { return empFind(emp.open); }

function empAskYes(what, id) { emp.ask = what + ':' + id; empForcePaint(); }
function empAskNo() { emp.ask = ''; empForcePaint(); }

async function empCodeGo(id) {
  const s = empFind(id); if (!s || emp.busy[id]) return;
  emp.ask = ''; emp.busy[id] = 'code'; emp.codeErr = null; empForcePaint();
  const r = await empCode(id);
  delete emp.busy[id];
  if (!r.ok) { emp.codeErr = r.error; empForcePaint(); if (typeof toast === 'function') toast(r.error); return; }
  emp.code = { staffId: id, code: r.data };          // on screen only, until empForgetCode()
  empForcePaint();
  const v = empEl('empCodeVal'); if (v && v.focus) { try { v.setAttribute('tabindex', '-1'); v.focus(); } catch (e) { } }
  empLoad(true);                                     // status is 'invited' now
}
function empCopyCode() {
  const code = emp.code && emp.code.code;
  if (!code) return;
  const done = () => { if (typeof toast === 'function') toast('Code copied. Paste it into your message to her.'); };
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(code).then(done, empCopyFallback); return; }
  } catch (e) { }
  empCopyFallback();
}
function empCopyFallback() {
  const v = empEl('empCodeVal');
  if (v && typeof document !== 'undefined' && document.createRange && typeof window !== 'undefined' && window.getSelection) {
    try {
      const r = document.createRange(); r.selectNodeContents(v);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      if (typeof toast === 'function') toast('The code is selected — press Ctrl+C to copy it.');
      return;
    } catch (e) { }
  }
  if (typeof toast === 'function') toast('Copying did not work here. Select the code and copy it by hand.');
}
async function empRevokeGo(id, to) {
  const s = empFind(id); if (!s || emp.busy[id]) return;
  const next = to === 'active' ? 'active' : 'revoked';
  emp.ask = ''; emp.busy[id] = 'status'; empForcePaint();
  const r = await empSetStatus(id, next);
  delete emp.busy[id];
  if (!r.ok) { emp.err = r.error; empForcePaint(); if (typeof toast === 'function') toast(r.error); return; }
  emp.err = null;
  if (typeof toast === 'function') toast(next === 'revoked' ? (s.name || 'She') + ' can no longer sign in.' : (s.name || 'She') + ' can sign in again.');
  await empLoad(true);
}
async function empWelcome(id) {
  const s = empFind(id); if (!s || emp.busy[id]) return;
  emp.busy[id] = 'doc'; empForcePaint();
  const r = await empDocLink(id);
  delete emp.busy[id];
  empForcePaint();
  if (!r.ok) { if (typeof toast === 'function') toast(r.error); return; }
  try { if (typeof window !== 'undefined' && window.open) window.open(r.data, '_blank', 'noopener'); } catch (e) { }
}

/* ---- the chat ---- */
function empChatStart() {
  empChatStop();
  if (typeof setInterval !== 'function') return;
  emp.chatTimer = setInterval(empChatTick, EMP_CHAT_MS);
  if (emp.chatTimer && emp.chatTimer.unref) emp.chatTimer.unref();
}
function empChatStop() { if (emp.chatTimer) { clearInterval(emp.chatTimer); emp.chatTimer = null; } }
function empChatTick() {
  if (!emp.open || (typeof currentView !== 'undefined' && currentView !== 'employees')) { empChatStop(); return; }
  if (typeof document !== 'undefined' && document.hidden) return;
  empLoadMessages(true);
}
async function empLoadMessages(force) {
  const s = empOpenRow();
  if (!s) return;
  if (!s.channelId) { emp.msgsLoaded = true; emp.msgs = []; emp.msgsErr = 'Her channel is not ready yet.'; empPaint(); return; }
  const mseq = ++emp.mseq;
  const r = await empMessages(s.channelId);
  if (mseq !== emp.mseq || emp.open !== s.id) return;
  if (r.ok) {
    emp.msgs = r.data; emp.msgsLoaded = true; emp.msgsErr = null;
    const h = await empHerReadAt(s.channelId);
    if (mseq === emp.mseq && h.ok) emp.herReadAt = h.data;
    if (s.unread) { await empMarkRead(s.channelId); empLoad(true); }
  } else {
    emp.msgsErr = r.error;
    if (r.missing) emp.msgsLoaded = true;   // nothing to wait for: say so instead of spinning
  }
  empPaint();
}
function empDraftIn(v) { emp.draft = String(v == null ? '' : v); }
function empKey(e) {
  if (e && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { if (e.preventDefault) e.preventDefault(); empSendClick(); }
}
function empPick() { const f = empEl('empFile'); if (f && f.click) f.click(); }
function empFileIn(input) {
  const f = input && input.files && input.files[0];
  emp.fileErr = null;
  if (!f) { emp.file = null; empForcePaint(); return; }
  const bad = empFileProblem(f);
  if (bad) { emp.file = null; emp.fileErr = bad; empForcePaint(); return; }
  emp.file = f; empForcePaint();
}
function empDropFile() { emp.file = null; emp.fileErr = null; empForcePaint(); }
async function empSendClick() {
  const s = empOpenRow();
  if (!s || emp.sending) return;
  const box = empEl('empDraft');
  if (box && typeof box.value === 'string') emp.draft = box.value;
  const text = String(emp.draft || '').trim();
  const file = emp.file;
  if (!text && !file) { emp.msgsErr = 'Write a message first.'; empForcePaint(); return; }
  emp.sending = true; emp.msgsErr = null; empForcePaint();
  let path = null;
  if (file) {
    const up = await empUpload(s.channelId, file);
    if (!up.ok) { emp.sending = false; emp.fileErr = up.error; empForcePaint(); if (typeof toast === 'function') toast(up.error); return; }
    path = up.data;
  }
  const r = await empSendMessage(s.channelId, text, path);
  emp.sending = false;
  if (!r.ok) { emp.msgsErr = r.error; empForcePaint(); if (typeof toast === 'function') toast(r.error); return; }
  emp.draft = ''; emp.file = null; emp.fileErr = null;
  if (r.data) emp.msgs = emp.msgs.concat([r.data]);
  empForcePaint();
  empLoadMessages(true);
}
async function empOpenFile(path) {
  const r = await empFileUrl(path);
  if (!r.ok) { if (typeof toast === 'function') toast(r.error); return; }
  try { if (typeof window !== 'undefined' && window.open) window.open(r.data, '_blank', 'noopener'); } catch (e) { }
}
/* render() calls this after every screen change: leave the chat alone unless we are on it. */
function empOnRender(view) {
  if (view === 'employees') { if (emp.open) empChatStart(); empScrollChat(); return; }
  empChatStop(); empForgetCode();
}
