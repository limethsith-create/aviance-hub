/* ===================== AVIANCE OS — Callers (the owner's cold-calling screen) =====================
   Three cold callers, paid by the hour through an agency, plus a bonus per meeting that shows and
   2% of any deal that closes. He needs one screen that answers three questions in seconds:

     1. Who is producing?      The scoreboard — per caller, dials, conversations, meetings booked,
                               meetings that showed, deals closed and the money he owes her — over a
                               "Today / This week" switch. Both ranges are fetched, so the switch is
                               instant and the strip at the top can show today beside the week.
     2. Where do the leads     The CSV upload — he picks a file, we parse it in the browser (headers in
        come from?             any order, extra columns, blank rows, quoted commas, a BOM, CRLF), show
                               him what we read and who the leads go to, and
                               nothing is sent until he presses Import.
     3. How does a caller      "Add a caller" then the access code, exactly as the Employees screen does
        get in?                it: caller_add, then the staff-code edge function with his session token.
                               The code is shown once, big, with a copy button; it is never logged and
                               is dropped from state the moment the panel closes.

   Plus the live feed: the last calls logged, newest first, so he can watch the dialling happen.

   Data (database functions in 20261126_callers.sql, owner only; see /home/claude/callers/SPEC.md):
     callers_list()                              -> [{id,name,email,status,code_set,last_seen_at,created_at}]
     callers_board(p_days)                       -> {bonus, callers:[{caller_id,name,dials,conversations,
                                                     booked,showed,closed,closed_value,owed}], feed:[...]}
     caller_add(p_name,p_email)                  -> {staff_id}
     caller_set_status(p_staff,p_status)
     leads_import(p_rows jsonb, p_batch text)    -> {added, skipped, assigned}
   The access code comes from the `staff-code` edge function, never from the database: it is returned
   once, held in cal.code only while that panel is open, never written to storage and never logged.
   (That function also emails the person her invite, so he is told so in one line.)

   Nothing here is applied yet — agent A's migration lands at the end — so every data function says
   "not switched on yet" in plain English instead of throwing when an RPC is missing.

   House rules: data functions (cal*) resolve to {ok, data, error, missing} and never throw; render
   functions are pure (data in, HTML string out) so the tests can call them; every string goes through
   esc(); ids reach handlers through calA(); nothing runs at load. */

/* ===================== 0. STATE ===================== */
const CAL_BOARD_MS = 30000;                // the scoreboard and the feed, while the tab is in front
const CAL_WEEK_DAYS = 7;
const CAL_MAX_ROWS = 5000;                 // "a few thousand" — past this he is told what was kept
const CAL_MAX_CSV = 8 * 1024 * 1024;       // 8 MB of text is far more than a few thousand rows
const CAL_FEED_MAX = 50;
/* The one-click invite link. /go is rewritten to the caller-link function (vercel.json),
   so what she receives is an aviance.store address and not a Supabase one. */
const CAL_LINK_BASE = 'https://aviance.store/go?k=';
const CAL_BONUS_DEFAULT = 25;              // mirrors biz_settings.caller_bonus, until the board says otherwise
const CAL_DEAL_CUT = 0.02;                 // 2% of a closed deal's first-month fee
const CAL_CELL_MAX = 500;                  // one CSV cell: longer than this is somebody's essay, not a lead
const CAL_NOT_READY = "The Callers area isn't switched on yet. Once the database update is applied, your callers will show here.";
const CAL_CODE_NOT_READY = "The access-code function isn't deployed yet, so there is no code to show. Try again once it is.";
const CAL_IMPORT_NOT_READY = "Importing leads isn't switched on yet. Once the database update is applied, this upload will work.";

/* The seven outcomes, in the order they read best on a feed. Fixed by the spec — do not add to these. */
const CAL_OUTCOMES = {
  no_answer: 'No answer', voicemail: 'Voicemail', not_interested: 'Not interested',
  callback: 'Call back', wrong_number: 'Wrong number', booked: 'Booked a meeting', bad_fit: 'Not a fit',
};
/* A "conversation" is a call where a human actually spoke to her. The board counts these; we keep the
   same list here so the hint under the column matches what the database did. */
const CAL_TALKED = ['not_interested', 'callback', 'booked', 'bad_fit'];

/* The CSV headers we understand. Anything else in the file is ignored, not an error. */
const CAL_FIELDS = {
  company: ['company', 'companyname', 'business', 'businessname', 'organisation', 'organization', 'org', 'account'],
  name: ['name', 'contact', 'contactname', 'fullname', 'firstname', 'person', 'prospect'],
  phone: ['phone', 'phonenumber', 'phoneno', 'mobile', 'mobilenumber', 'tel', 'telephone', 'number', 'cell'],
  email: ['email', 'emailaddress', 'mail', 'workemail'],
  timezone: ['timezone', 'timezones', 'tz', 'zone', 'localtime'],
  notes: ['notes', 'note', 'comment', 'comments', 'remark', 'remarks', 'detail', 'details'],
};

const cal = {
  list: [], loaded: false, loading: false, err: null, missing: false,
  range: 'day',                      // 'day' | 'week'
  day: null, week: null,             // the two boards, each {bonus, callers, feed}
  boardErr: null, boardMissing: false, boardLoading: false,
  adding: false, addErr: null, addBusy: false, addName: '', addEmail: '',
  code: null,                        // {staffId, code} — lives only while the panel is open
  link: null,                        // {staffId, url} — the one-click invite, also on screen only
  codeErr: null, busy: {},
  ask: '',                           // inline "are you sure": 'revoke:<id>' | 'reset:<id>' | 'import'
  up: false,                         // the CSV panel is open
  parsed: null,                      // what calParseCsv() made of the file he picked
  fileName: '', fileErr: null, parsing: false,
  batch: '', importBusy: false, importErr: null, importDone: null,
  timer: null, seq: 0, bseq: 0,
};

/* ===================== 1. DATA ===================== */
function calSb() { try { if (typeof sb !== 'undefined' && sb) return sb; } catch (e) { } return (typeof window !== 'undefined' && window.sb) || null; }
function calUrl() { try { if (typeof SUPA_URL === 'string' && SUPA_URL) return SUPA_URL; } catch (e) { } return 'https://zjbxnkpktbghhudjbxhk.supabase.co'; }
function calKey() { try { if (typeof SUPA_KEY === 'string' && SUPA_KEY) return SUPA_KEY; } catch (e) { } return ''; }

/* Is this "the database update has not been applied yet" rather than a real failure? */
function calMissing(err) {
  if (!err) return false;
  const msg = String(err.message || err), code = String(err.code || '');
  return code === 'PGRST202' || code === '42883' || code === '42P01' ||
    /could not find the function|does not exist|schema cache/i.test(msg);
}
function calPlain(err, fallback) {
  if (!err) return fallback;
  const msg = String(err.message || err), code = String(err.code || '');
  if (calMissing(err)) return CAL_NOT_READY;
  if (/failed to fetch|networkerror|network request|load failed|fetch failed/i.test(msg)) return "Can't reach Aviance right now. Check your connection and try again.";
  if (code === 'PGRST301' || /jwt|not authenticated|session/i.test(msg)) return 'Your sign-in has run out. Please sign in again.';
  if (code === '42501' || /permission denied|not authorized|row-level security/i.test(msg)) return "You don't have access to do that.";
  if (code === 'P0001' && msg) return msg;
  return fallback;
}
async function calRpc(name, args, fallback) {
  const s = calSb();
  if (!s) return { ok: false, data: null, error: 'Aviance is not ready yet. Please reload the page.', missing: false };
  try {
    const r = await s.rpc(name, args || {});
    if (r && r.error) return { ok: false, data: null, error: calPlain(r.error, fallback), missing: calMissing(r.error) };
    return { ok: true, data: r ? r.data : null, error: null, missing: false };
  } catch (e) { return { ok: false, data: null, error: calPlain(e, fallback), missing: calMissing(e) }; }
}

function calNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function calCallerRow(r) {
  return {
    id: r.id || r.staff_id || '', name: r.name || '', email: r.email || '',
    status: r.status || 'invited', codeSet: !!(r.code_set || r.codeSet),
    lastSeenAt: r.last_seen_at || null, createdAt: r.created_at || null,
  };
}
/* One line of the scoreboard. `owed` is the database's figure and is what he is shown; we only work it
   out ourselves when an older board does not send it, so his money never depends on our arithmetic. */
function calStatRow(r, bonus) {
  const showed = Math.max(0, calNum(r.showed));
  const value = Math.max(0, calNum(r.closed_value != null ? r.closed_value : r.closedValue));
  const b = calNum(bonus) || CAL_BONUS_DEFAULT;
  const owed = (r.owed == null && r.owed_cents == null)
    ? (showed * b) + (value * CAL_DEAL_CUT)
    : (r.owed != null ? calNum(r.owed) : calNum(r.owed_cents) / 100);
  return {
    id: r.caller_id || r.id || r.staff_id || '', name: r.name || 'No name',
    status: r.status || '',
    dials: Math.max(0, calNum(r.dials)),
    conversations: Math.max(0, calNum(r.conversations != null ? r.conversations : r.talked)),
    booked: Math.max(0, calNum(r.booked)),
    showed, closed: Math.max(0, calNum(r.closed)),
    closedValue: value, owed: Math.max(0, owed),
  };
}
function calFeedRow(r) {
  return {
    id: r.id || '', callerName: r.caller_name || r.callerName || r.name || '',
    company: r.company || '', lead: r.lead_name || r.leadName || '',
    outcome: String(r.outcome || ''), note: r.note || '', at: r.created_at || r.at || null,
  };
}
/* The board comes back as one jsonb object. Be generous about its shape: an object with `callers`
   (or `rows`/`board`), or a bare array of caller rows with the feed somewhere alongside. */
function calBoardShape(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const bonus = calNum(d.bonus != null ? d.bonus : d.caller_bonus) || CAL_BONUS_DEFAULT;
  let rows = Array.isArray(raw) ? raw
    : (Array.isArray(d.callers) ? d.callers : (Array.isArray(d.rows) ? d.rows : (Array.isArray(d.board) ? d.board : [])));
  const feed = Array.isArray(d.feed) ? d.feed : [];
  const callers = rows.filter(x => x && typeof x === 'object').map(x => calStatRow(x, bonus));
  callers.sort((a, b) => (b.dials - a.dials) || String(a.name).localeCompare(String(b.name)));
  return {
    bonus,
    callers,
    feed: feed.filter(x => x && typeof x === 'object').map(calFeedRow).slice(0, CAL_FEED_MAX),
  };
}

async function calFetchList() {
  const r = await calRpc('callers_list', {}, "The caller list didn't load. Try again.");
  if (!r.ok) return r;
  const rows = (Array.isArray(r.data) ? r.data : []).filter(x => x && (x.id || x.staff_id)).map(calCallerRow);
  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return { ok: true, data: rows, error: null, missing: false };
}
async function calFetchBoard(days) {
  const d = Math.max(1, Math.min(365, Math.floor(calNum(days)) || 1));
  const r = await calRpc('callers_board', { p_days: d }, "The scoreboard didn't load. Try again.");
  if (!r.ok) return r;
  return { ok: true, data: calBoardShape(r.data), error: null, missing: false };
}

/* The two checks the Add form runs before anything reaches the database. Pure. */
function calNameProblem(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return 'Type her name.';
  if (n.length < 2) return 'That name looks too short.';
  if (n.length > 80) return 'Keep the name under 80 characters.';
  return '';
}
function calEmailProblem(email) {
  const e = String(email == null ? '' : email).trim();
  if (!e) return 'Type her email address.';
  if (e.length > 160) return 'That email address is too long.';
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(e)) return "That doesn't look like an email address.";
  return '';
}
async function calAdd(name, email) {
  const n = String(name == null ? '' : name).trim(), e = String(email == null ? '' : email).trim();
  const bad = calNameProblem(n) || calEmailProblem(e);
  if (bad) return { ok: false, data: null, error: bad, missing: false };
  return calRpc('caller_add', { p_name: n, p_email: e.toLowerCase() }, "She wasn't added. Try again.");
}
async function calSetStatus(staffId, status) {
  if (!staffId) return { ok: false, data: null, error: 'Pick a caller first.', missing: false };
  if (['active', 'invited', 'revoked'].indexOf(String(status)) < 0) return { ok: false, data: null, error: 'That is not a status.', missing: false };
  return calRpc('caller_set_status', { p_staff: staffId, p_status: String(status) }, "That didn't change. Try again.");
}

/* The access code. The edge function makes it, sets it as her password, emails her the invite and
   hands the code back once. It is never logged and never kept anywhere but cal.code, which is
   dropped by calForgetCode() when the panel closes, on sign-out and when the screen is left. */
/* The one-click invite link. staff_link_new stores only a hash of the token and
   hands the token back once, so this is the only moment the real URL exists. */
async function calLinkNew(staffId) {
  if (!staffId) return { ok: false, data: null, error: 'Pick a caller first.', missing: false };
  const r = await calRpc('staff_link_new', { p_staff: staffId, p_days: 14 },
    'Aviance could not make a link. Try again in a moment.');
  if (!r.ok) return r;
  const token = r.data && r.data.token ? String(r.data.token) : '';
  if (!token) return { ok: false, data: null, error: 'Aviance could not make a link. Try again in a moment.', missing: false };
  return { ok: true, data: { url: CAL_LINK_BASE + encodeURIComponent(token), expires: (r.data && r.data.expires_at) || null }, error: null, missing: false };
}

async function calCode(staffId) {
  if (!staffId) return { ok: false, data: null, error: 'Pick a caller first.', missing: false };
  const s = calSb();
  if (!s || !s.auth || typeof fetch !== 'function') return { ok: false, data: null, error: 'Aviance is not ready yet. Please reload the page.', missing: false };
  let token = '';
  try { const g = await s.auth.getSession(); token = (g && g.data && g.data.session && g.data.session.access_token) || ''; } catch (e) { token = ''; }
  if (!token) return { ok: false, data: null, error: 'Your sign-in has run out. Please sign in again.', missing: false };
  try {
    const res = await fetch(calUrl() + '/functions/v1/staff-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: calKey() },
      body: JSON.stringify({ staff_id: staffId }),
    });
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (res && res.ok && j && j.ok && typeof j.code === 'string' && j.code) return { ok: true, data: j.code, error: null, missing: false };
    if (res && (res.status === 404 || res.status === 501)) return { ok: false, data: null, error: CAL_CODE_NOT_READY, missing: true };
    if (res && res.status === 401) return { ok: false, data: null, error: 'Your sign-in has run out. Please sign in again.', missing: false };
    if (res && res.status === 403) return { ok: false, data: null, error: "You don't have access to do that.", missing: false };
    const said = j && typeof j.error === 'string' && j.error ? j.error : '';
    return { ok: false, data: null, error: said || "The code didn't come back. Try again.", missing: false };
  } catch (e) { return { ok: false, data: null, error: calPlain(e, "The code didn't come back. Try again."), missing: false }; }
}

/* ---- the CSV, parsed here in the browser: nothing leaves the page until he presses Import ---- */

/* RFC-4180-ish, one pass. Handles a BOM, CRLF, a bare CR, quoted commas and doubled quotes inside
   a quoted cell. Everything else is a character in a cell. */
function calCsvCells(text) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);     // Excel writes a BOM on "CSV UTF-8"
  const rows = [];
  let row = [], cell = '', quoted = false, any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
      any = true;
      continue;
    }
    if (ch === '"') { quoted = true; any = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; any = true; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;        // CRLF is one line ending, not two
      row.push(cell); rows.push(row); row = []; cell = ''; any = false;
      continue;
    }
    cell += ch; any = true;
  }
  if (any || cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function calNorm(h) { return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, ''); }
/* Headers in any order; the first column that claims a field wins; extra columns are ignored. */
function calHeaderMap(cells) {
  const map = {}, extra = [];
  (Array.isArray(cells) ? cells : []).forEach((h, i) => {
    const n = calNorm(h);
    if (!n) return;
    let hit = '';
    Object.keys(CAL_FIELDS).forEach(f => { if (!hit && CAL_FIELDS[f].indexOf(n) >= 0) hit = f; });
    if (hit && map[hit] == null) map[hit] = i;
    else if (!hit) extra.push(String(h).trim().slice(0, 40));
  });
  return { map, extra };
}
function calCell(row, i) {
  if (i == null || !Array.isArray(row)) return '';
  return String(row[i] == null ? '' : row[i]).trim().slice(0, CAL_CELL_MAX);
}
function calDigits(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }
/* What is wrong with one lead, in his words. Empty string means it is fine. */
function calRowProblem(r) {
  const row = r || {};
  const phone = String(row.phone || '').trim(), email = String(row.email || '').trim();
  if (!phone && !email) return 'No phone number and no email';
  if (phone && calDigits(phone).length < 7) return 'That phone number is too short to dial';
  if (email && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) return 'That email address looks wrong';
  /* A phone or an email is the whole bar: a list with no company names still dials fine, and
     leads_import is what decides whether the lead is a duplicate. */
  return '';
}
/* The whole file, in one pure call: {rows, bad, blank, total, extra, over, headers}.
   `rows` are the leads we would send; `bad` are the ones we would not, each with its reason. */
function calParseCsv(text, limit) {
  const max = Math.max(1, Math.floor(calNum(limit)) || CAL_MAX_ROWS);
  const cells = calCsvCells(text);
  const nonBlank = cells.filter(r => Array.isArray(r) && r.some(c => String(c == null ? '' : c).trim() !== ''));
  if (!nonBlank.length) return { ok: false, data: null, error: 'That file is empty.', missing: false };
  const head = calHeaderMap(nonBlank[0]);
  const fields = Object.keys(head.map);
  if (!fields.length) {
    return {
      ok: false, data: null, missing: false,
      error: 'The first line of that file has none of the headings I know. Name the columns company, name, phone, email, timezone and notes — in any order.',
    };
  }
  if (head.map.phone == null && head.map.email == null) {
    return { ok: false, data: null, missing: false, error: 'That file has no phone column and no email column, so there is nobody to ring.' };
  }
  const body = nonBlank.slice(1);
  const rows = [], bad = [];
  let over = 0;
  for (let i = 0; i < body.length; i++) {
    if (rows.length + bad.length >= max) { over = body.length - i; break; }
    const src = body[i];
    const lead = {
      company: calCell(src, head.map.company), name: calCell(src, head.map.name),
      phone: calCell(src, head.map.phone), email: calCell(src, head.map.email),
      timezone: calCell(src, head.map.timezone), notes: calCell(src, head.map.notes),
    };
    const problem = calRowProblem(lead);
    if (problem) bad.push({ line: i + 2, why: problem, company: lead.company, name: lead.name, phone: lead.phone, email: lead.email });
    else rows.push(lead);
  }
  return {
    ok: true, error: null, missing: false,
    data: {
      rows, bad, over,
      total: body.length,
      blank: cells.length - nonBlank.length,
      headers: fields,
      extra: head.extra.slice(0, 12),
    },
  };
}
/* How leads_import will split them: evenly across the callers who can be given work, the
   remainder to the first few. The statuses here must match leads_import in the database
   ('new','invited','active'): a caller who has her code but has not signed in yet is still
   'invited', and the server does give her leads. Filtering to 'active' alone told the owner
   his leads would land unassigned while the server quietly assigned them.
   Shown before he presses Import so the split is never a surprise. */
const CAL_TAKES_LEADS = ['new', 'invited', 'active'];
function calSplitPlan(count, callers) {
  const list = (Array.isArray(callers) ? callers : [])
    .filter(c => c && c.id && CAL_TAKES_LEADS.indexOf(String(c.status)) >= 0);
  const n = Math.max(0, Math.floor(calNum(count)));
  if (!list.length) return [];
  const base = Math.floor(n / list.length), extra = n % list.length;
  return list.map((c, i) => ({ id: c.id, name: c.name || 'No name', share: base + (i < extra ? 1 : 0) }));
}
function calFileProblem(file) {
  if (!file) return 'Pick a file first.';
  const name = String((file && file.name) || '');
  const size = calNum(file && file.size);
  if (!name) return 'Pick a file first.';
  if (!/\.(csv|txt|tsv)$/i.test(name)) return 'Pick a CSV file — the kind a spreadsheet saves as "CSV".';
  if (size > CAL_MAX_CSV) return 'That file is bigger than 8 MB. Split it and import the parts.';
  return '';
}
/* A sensible label so he can find this batch again: the file name and today's date. Pure. */
function calBatchName(fileName, now) {
  const base = String(fileName == null ? '' : fileName).replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[_]+/g, ' ').trim().slice(0, 48);
  const d = now instanceof Date ? now : new Date(calNum(now) || Date.now());
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return (base ? base + ' — ' : 'Leads ') + stamp;
}
async function calReadFile(file) {
  const bad = calFileProblem(file);
  if (bad) return { ok: false, data: null, error: bad, missing: false };
  try {
    if (typeof file.text === 'function') return { ok: true, data: String(await file.text()), error: null, missing: false };
  } catch (e) { return { ok: false, data: null, error: "That file didn't open. Try saving it again as CSV.", missing: false }; }
  if (typeof FileReader !== 'function') return { ok: false, data: null, error: "This browser can't read the file. Try a different one.", missing: false };
  return new Promise(resolve => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve({ ok: true, data: String(fr.result || ''), error: null, missing: false });
      fr.onerror = () => resolve({ ok: false, data: null, error: "That file didn't open. Try saving it again as CSV.", missing: false });
      fr.readAsText(file);
    } catch (e) { resolve({ ok: false, data: null, error: "That file didn't open. Try saving it again as CSV.", missing: false }); }
  });
}
async function calImport(rows, batch) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: false, data: null, error: 'There are no good rows to import.', missing: false };
  if (list.length > CAL_MAX_ROWS) return { ok: false, data: null, error: 'That is more than ' + CAL_MAX_ROWS + ' rows. Split the file and import the parts.', missing: false };
  const label = String(batch == null ? '' : batch).trim().slice(0, 120) || calBatchName('', Date.now());
  const r = await calRpc('leads_import', { p_rows: list, p_batch: label }, "The leads weren't imported. Try again.");
  if (!r.ok) return r.missing ? { ok: false, data: null, error: CAL_IMPORT_NOT_READY, missing: true } : r;
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  return {
    ok: true, error: null, missing: false,
    data: { added: Math.max(0, calNum(d.added)), skipped: Math.max(0, calNum(d.skipped)), assigned: Math.max(0, calNum(d.assigned)) },
  };
}

/* ===================== 2. FORGET ===================== */
function calIsOwner() { try { return !!(typeof authUser !== 'undefined' && authUser && authUser.role === 'admin'); } catch (e) { return false; } }
function calStart() {
  if (cal.timer || cal.missing || typeof setInterval !== 'function') return;
  cal.timer = setInterval(calTick, CAL_BOARD_MS);
  if (cal.timer && cal.timer.unref) cal.timer.unref();
}
function calStop() { if (cal.timer) { clearInterval(cal.timer); cal.timer = null; } }
function calTick() {
  if (!calIsOwner() || cal.missing || (typeof currentView !== 'undefined' && currentView !== 'callers')) { calStop(); return; }
  if (typeof document !== 'undefined' && document.hidden) return;
  calLoadBoard(true);
}
/* The code never outlives its panel. */
function calForgetCode() { cal.code = null; cal.codeErr = null; }
function calForgetLink() { cal.link = null; }
/* Sign-out: drop the list, the boards, the file he picked and — above all — any code still on screen. */
function callersForget() {
  calStop();
  calForgetLink();
  Object.assign(cal, {
    list: [], loaded: false, loading: false, err: null, missing: false,
    range: 'day', day: null, week: null, boardErr: null, boardMissing: false, boardLoading: false,
    adding: false, addErr: null, addBusy: false, addName: '', addEmail: '',
    code: null, codeErr: null, busy: {}, ask: '',
    up: false, parsed: null, fileName: '', fileErr: null, parsing: false,
    batch: '', importBusy: false, importErr: null, importDone: null,
    seq: cal.seq + 1, bseq: cal.bseq + 1,
  });
}

/* ===================== 3. RENDER (pure: data in, HTML string out) ===================== */
function calA(v) { return esc(JSON.stringify(v == null ? '' : String(v))); }
function calEl(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }

function calStatusLabel(status) {
  return ({ active: 'Dialling', invited: 'Code sent', revoked: 'No access' })[String(status || '')] || 'Not set up';
}
function calStatusTone(status) {
  return ({ active: 'ok', invited: 'wait', revoked: 'off' })[String(status || '')] || 'wait';
}
/* A colour alone says nothing to a screen reader, so the pill always carries the word too. */
function calOutcomeLabel(code) { return CAL_OUTCOMES[String(code || '')] || 'Logged'; }
function calIsTalk(code) { return CAL_TALKED.indexOf(String(code || '')) >= 0; }
/* $1,240 — and $1,240.50 only when the pennies matter, because a round figure reads faster. */
function calMoney(n) {
  const v = Math.round(calNum(n) * 100) / 100;
  const neg = v < 0, a = Math.abs(v);
  const whole = Math.floor(a), pence = Math.round((a - whole) * 100);
  const s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + s + (pence ? '.' + String(pence).padStart(2, '0') : '');
}
function calCount(n, one, many) {
  const v = Math.max(0, Math.floor(calNum(n)));
  return v + ' ' + (v === 1 ? one : (many || one + 's'));
}
function calTime(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function calAgo(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}
function calRangeWord(range) { return String(range) === 'week' ? 'this week' : 'today'; }

/* ---- the scoreboard ---- */
function calTotals(board) {
  const rows = (board && Array.isArray(board.callers)) ? board.callers : [];
  const t = { dials: 0, conversations: 0, booked: 0, showed: 0, closed: 0, owed: 0, callers: rows.length };
  rows.forEach(r => {
    t.dials += calNum(r.dials); t.conversations += calNum(r.conversations); t.booked += calNum(r.booked);
    t.showed += calNum(r.showed); t.closed += calNum(r.closed); t.owed += calNum(r.owed);
  });
  return t;
}
/* Booked per 100 dials: the one ratio that tells him whether a caller is working or just dialling. */
function calRate(booked, dials) {
  const d = calNum(dials);
  if (!d) return '—';
  return (Math.round((calNum(booked) / d) * 1000) / 10) + '%';
}
function calSwitchHTML(ctx) {
  const c = ctx || {}, on = String(c.range) === 'week' ? 'week' : 'day';
  const b = (k, label) => `<button type="button" class="cal-seg${on === k ? ' on' : ''}" onclick="calSetRange(${calA(k)})"${on === k ? ' aria-current="true"' : ''}>${esc(label)}</button>`;
  return `<div class="cal-switch" role="group" aria-label="Which period the scoreboard shows">${b('day', 'Today')}${b('week', 'This week')}</div>`;
}
/* The strip above the table: today beside the week, so he never has to flick the switch to compare. */
function calStripHTML(day, week) {
  const d = calTotals(day), w = calTotals(week);
  const tile = (label, a, b) => `<div class="cal-tile"><span class="cal-tl">${esc(label)}</span>
    <span class="cal-tv">${esc(a)}</span><span class="cal-tw">${esc(b)} this week</span></div>`;
  return `<div class="cal-strip" aria-label="Today beside this week">
    ${tile('Dials today', String(d.dials), String(w.dials))}
    ${tile('Conversations', String(d.conversations), String(w.conversations))}
    ${tile('Meetings booked', String(d.booked), String(w.booked))}
    ${tile('Showed up', String(d.showed), String(w.showed))}
    ${tile('Deals closed', String(d.closed), String(w.closed))}
    ${tile('Bonus owed', calMoney(d.owed), calMoney(w.owed))}
  </div>`;
}
function calBoardRowHTML(r, ctx) {
  const c = ctx || {}, busy = (c.busy && c.busy[r.id]) || '';
  const quiet = !r.dials;                       // nothing dialled in this period: say it, don't hide it
  return `<tr class="cal-r${quiet ? ' quiet' : ''}">
    <th scope="row" class="cal-who"><span class="cal-name">${esc(r.name || 'No name')}</span>
      ${r.status ? `<span class="cal-pill ${esc(calStatusTone(r.status))}">${esc(calStatusLabel(r.status))}</span>` : ''}</th>
    <td class="num">${esc(String(r.dials))}</td>
    <td class="num">${esc(String(r.conversations))}</td>
    <td class="num">${esc(String(r.booked))}</td>
    <td class="num">${esc(String(r.showed))}</td>
    <td class="num">${esc(String(r.closed))}</td>
    <td class="num cal-rate">${esc(calRate(r.booked, r.dials))}</td>
    <td class="num cal-owed">${esc(calMoney(r.owed))}</td>
    <td class="cal-acts-cell">
      <button type="button" class="cal-link" onclick="${r.codeSet ? `calAskYes('reset',${calA(r.id)})` : `calCodeGo(${calA(r.id)})`}"${busy ? ' disabled' : ''}>${busy === 'code' ? 'Making a code…' : (r.codeSet ? 'Reset code' : 'Access code')}</button>
      <button type="button" class="cal-link" onclick="calLinkGo(${calA(r.id)})"${busy || r.status === 'revoked' ? ' disabled' : ''}>${busy === 'link' ? 'Making a link…' : 'Invite link'}</button>
      <button type="button" class="cal-link" onclick="${r.status === 'revoked' ? `calStatusGo(${calA(r.id)},'active')` : `calAskYes('revoke',${calA(r.id)})`}"${busy ? ' disabled' : ''}>${busy === 'status' ? 'Changing…' : (r.status === 'revoked' ? 'Let her back in' : 'Revoke')}</button>
    </td>
  </tr>`;
}
function calBoardHTML(board, ctx) {
  const c = ctx || {};
  const rows = (board && Array.isArray(board.callers)) ? board.callers : [];
  if (c.boardErr && !rows.length) {
    return `<div class="card cal-blank" role="alert"><h3>${esc(c.boardMissing ? 'Not switched on yet' : "The scoreboard didn't load")}</h3>
      <p>${esc(c.boardErr)}</p>${c.boardMissing ? '' : `<button type="button" class="btn" onclick="calLoadBoard(true)">Try again</button>`}</div>`;
  }
  if (!rows.length) {
    return `<div class="card cal-blank"><h3>No calls ${esc(calRangeWord(c.range))}</h3>
      <p>Add a caller, give her an access code and upload some leads. Her dials show here the moment she starts.</p>
      <button type="button" class="btn" onclick="calAddOpen()">Add a caller</button></div>`;
  }
  const t = calTotals(board);
  const bonus = calNum(board && board.bonus) || CAL_BONUS_DEFAULT;
  return `<div class="card cal-card">
    <div class="cal-ch"><h3>Who is producing — ${esc(calRangeWord(c.range))}</h3>${calSwitchHTML(c)}</div>
    <div class="cal-scroll"><table class="cal-table">
      <caption class="cal-sr">${esc('Each caller’s dials, conversations, meetings and bonus for ' + calRangeWord(c.range))}</caption>
      <thead><tr>
        <th scope="col">Caller</th><th scope="col" class="num">Dials</th><th scope="col" class="num">Talked</th>
        <th scope="col" class="num">Booked</th><th scope="col" class="num">Showed</th><th scope="col" class="num">Closed</th>
        <th scope="col" class="num">Booked per dial</th><th scope="col" class="num">Bonus owed</th><th scope="col">Access</th>
      </tr></thead>
      <tbody>${rows.map(r => calBoardRowHTML(r, c)).join('')}</tbody>
      <tfoot><tr>
        <th scope="row">All ${esc(calCount(t.callers, 'caller'))}</th>
        <td class="num">${esc(String(t.dials))}</td><td class="num">${esc(String(t.conversations))}</td>
        <td class="num">${esc(String(t.booked))}</td><td class="num">${esc(String(t.showed))}</td>
        <td class="num">${esc(String(t.closed))}</td><td class="num">${esc(calRate(t.booked, t.dials))}</td>
        <td class="num cal-owed">${esc(calMoney(t.owed))}</td><td></td>
      </tr></tfoot>
    </table></div>
    <p class="cal-note">“Talked” is a call where somebody actually spoke to her. Bonus owed is ${esc(calMoney(bonus))}
      a meeting that showed up, plus 2% of a closed deal’s first month. The $7 an hour is the agency’s, not ours.</p>
    ${c.ask && /^(revoke|reset):/.test(String(c.ask)) ? calAskHTML(c.ask, rows.find(r => r.id && String(c.ask).endsWith(r.id)) || null) : ''}
  </div>`;
}

/* ---- adding a caller, and the code shown once ---- */
function calAddFormHTML(ctx) {
  const c = ctx || {};
  return `<form class="card cal-add" onsubmit="calAddSave(event);return false;" aria-label="Add a caller">
    <h3>Add a caller</h3>
    <label class="cal-lab" for="calAddName">Her name</label>
    <input id="calAddName" type="text" autocomplete="off" maxlength="80" value="${esc(c.addName || '')}" placeholder="Nour Hassan">
    <label class="cal-lab" for="calAddEmail">Her email (the one she will sign in with)</label>
    <input id="calAddEmail" type="email" autocomplete="off" maxlength="160" value="${esc(c.addEmail || '')}" placeholder="nour@example.com">
    ${c.addErr ? `<p class="cal-bad" role="alert">${esc(c.addErr)}</p>` : ''}
    <p class="cal-note">This adds her as a caller. She still needs an access code — you generate that next, and she gets
      nothing but her own list of leads.</p>
    <div class="cal-acts">
      <button type="submit" class="btn"${c.addBusy ? ' disabled' : ''}>${c.addBusy ? 'Adding…' : 'Add her'}</button>
      <button type="button" class="btn ghost" onclick="calAddCancel()"${c.addBusy ? ' disabled' : ''}>Cancel</button>
    </div>
  </form>`;
}
/* The one-click invite link, shown once. Sending this is all she needs: it signs her
   in and lands her on her own calling screen, so there is no email address to type and
   no code to copy. It is a key in an inbox, which is why it runs out on its own. */
function calLinkHTML(url, caller) {
  const v = String(url == null ? '' : url);
  const who = (caller && caller.name) || 'her';
  if (!v) return '';
  return `<div class="card cal-code" role="alert" aria-live="assertive">
    <h3>${esc(who)}’s one-click link</h3>
    <p class="cal-code-val cal-code-url" id="calLinkVal">${esc(v)}</p>
    <div class="cal-acts">
      <button type="button" class="btn" onclick="calCopyLink()">Copy link</button>
      <button type="button" class="btn ghost" onclick="calLinkHide()">Done — I’ve copied it</button>
    </div>
    <p class="cal-code-warn"><b>This link is shown once and will not be shown again.</b> Send it to ${esc(who)} on
      WhatsApp or by email. She taps it and lands on her calling screen, already signed in.</p>
    <p class="cal-note">It works for 14 days and anyone holding it can open her screen, so send it to her and nobody
      else. Press “Invite link” again to make a new one, which switches the old one off.</p>
  </div>`;
}

/* The code, shown once. No copy of it is kept once this panel closes, and it is never logged. */
function calCodeHTML(code, caller) {
  const v = String(code == null ? '' : code);
  const who = (caller && caller.name) || 'her';
  if (!v) return '';
  return `<div class="card cal-code" role="alert" aria-live="assertive">
    <h3>${esc(who)}’s access code</h3>
    <p class="cal-code-val" id="calCodeVal">${esc(v)}</p>
    <div class="cal-acts">
      <button type="button" class="btn" onclick="calCopyCode()">Copy code</button>
      <button type="button" class="btn ghost" onclick="calCodeHide()">Done — I’ve copied it</button>
    </div>
    <p class="cal-code-warn"><b>This code is shown once and will not be shown again.</b> She signs in at
      aviance.store/callers with her email address and this code.</p>
    <p class="cal-note">Aviance has also emailed ${esc(who)} her invite, so she has the link already — you only need to
      send her the code. If it gets lost, press “Reset code” and send her the new one.</p>
  </div>`;
}
/* Every destructive step asks here first, inline. confirm() is never used. */
function calAskHTML(what, caller) {
  const w = String(what || ''), who = (caller && caller.name) || 'her';
  const id = (caller && caller.id) || '';
  if (/^import/.test(w)) {
    const n = Number(String(w).split(':')[1]) || 0;
    return `<div class="cal-ask" role="alert">
      <p>Import ${esc(calCount(n, 'lead'))}? The split is shown above, and leads already in Aviance are skipped.</p>
      <div class="cal-acts">
        <button type="button" class="btn" onclick="calImportGo()">Yes, import them</button>
        <button type="button" class="btn ghost" onclick="calAskNo()">No, not yet</button>
      </div>
    </div>`;
  }
  const reset = /^reset/.test(w);
  return `<div class="cal-ask" role="alert">
    <p>${reset ? `Make a new code for ${esc(who)}? Her old code stops working straight away.`
      : `Take away ${esc(who)}’s access? She won’t be able to sign in and her leads stay where they are. You can let her back in later.`}</p>
    <div class="cal-acts">
      <button type="button" class="btn" onclick="${reset ? `calCodeGo(${calA(id)})` : `calStatusGo(${calA(id)},'revoked')`}">${reset ? 'Yes, new code' : 'Yes, take it away'}</button>
      <button type="button" class="btn ghost" onclick="calAskNo()">No, leave it</button>
    </div>
  </div>`;
}

/* ---- the CSV upload ---- */
function calPreviewRowHTML(r) {
  return `<tr><td>${esc(r.company || '—')}</td><td>${esc(r.name || '—')}</td><td>${esc(r.phone || '—')}</td>
    <td>${esc(r.email || '—')}</td><td>${esc(r.timezone || '—')}</td></tr>`;
}
function calBadRowHTML(b) {
  return `<li>Line ${esc(String(b.line))}: ${esc(b.why)}${b.company || b.name ? ' — ' + esc(b.company || b.name) : ''}</li>`;
}
function calSplitHTML(plan, count) {
  const rows = Array.isArray(plan) ? plan : [];
  if (!rows.length) {
    return `<p class="cal-warn" role="alert">No caller has been added yet, so these ${esc(calCount(count, 'lead'))} would land
      unassigned. That is safe: add a caller and the first one to open her list picks them up.</p>`;
  }
  /* One caller is the normal case at the start, and "split" reads strangely for one person. */
  if (rows.length === 1) {
    return `<p class="cal-split">All ${esc(calCount(count, 'lead'))} go to ${esc(rows[0].name)}.</p>`;
  }
  return `<p class="cal-split">How they will split: ${rows.map(p => esc(p.name) + ' <b>' + esc(String(p.share)) + '</b>').join(' · ')}</p>`;
}
/* What he sees before anything is sent: the count, the duds, the first few rows and the split. Pure. */
function calPreviewHTML(parsed, ctx) {
  const c = ctx || {}, p = parsed || {};
  const rows = Array.isArray(p.rows) ? p.rows : [], bad = Array.isArray(p.bad) ? p.bad : [];
  const shown = rows.slice(0, 5);
  const asking = String(c.ask || '').indexOf('import') === 0;
  return `<div class="cal-prev">
    <p class="cal-sum"><b>${esc(calCount(rows.length, 'lead'))}</b> ready to import${bad.length ? ', ' + esc(String(bad.length)) + ' that look wrong' : ''}${p.blank ? ', ' + esc(calCount(p.blank, 'blank line')) + ' ignored' : ''}.
      ${p.over ? esc('The first ' + (rows.length + bad.length) + ' rows were read; ' + p.over + ' more are past the limit — import them as a second file.') : ''}</p>
    ${p.headers && p.headers.length ? `<p class="cal-note">Columns used: ${esc(p.headers.join(', '))}${p.extra && p.extra.length ? '. Ignored: ' + esc(p.extra.join(', ')) : ''}.</p>` : ''}
    ${shown.length ? `<div class="cal-scroll"><table class="cal-table cal-small">
      <caption class="cal-sr">The first few leads read from the file</caption>
      <thead><tr><th scope="col">Company</th><th scope="col">Name</th><th scope="col">Phone</th><th scope="col">Email</th><th scope="col">Time zone</th></tr></thead>
      <tbody>${shown.map(calPreviewRowHTML).join('')}</tbody></table></div>
      ${rows.length > shown.length ? `<p class="cal-note">…and ${esc(calCount(rows.length - shown.length, 'more'))}.</p>` : ''}` : ''}
    ${bad.length ? `<details class="cal-bads"><summary>${esc(calCount(bad.length, 'row'))} I would skip</summary>
      <ul>${bad.slice(0, 20).map(calBadRowHTML).join('')}</ul>
      ${bad.length > 20 ? `<p class="cal-note">…and ${esc(String(bad.length - 20))} more.</p>` : ''}</details>` : ''}
    ${calSplitHTML(calSplitPlan(rows.length, c.list), rows.length)}
    <label class="cal-lab" for="calBatch">What to call this batch</label>
    <input id="calBatch" type="text" maxlength="120" value="${esc(c.batch || '')}" oninput="calBatchIn(this.value)" placeholder="Egypt list — October">
    ${c.importErr ? `<p class="cal-bad" role="alert">${esc(c.importErr)}</p>` : ''}
    ${asking ? calAskHTML(c.ask, null) : `<div class="cal-acts">
      <button type="button" class="btn" onclick="calAskImport()"${rows.length && !c.importBusy ? '' : ' disabled'}>${c.importBusy ? 'Importing…' : 'Import ' + esc(calCount(rows.length, 'lead'))}</button>
      <button type="button" class="btn ghost" onclick="calUploadReset()"${c.importBusy ? ' disabled' : ''}>Pick a different file</button>
    </div>`}
  </div>`;
}
function calImportDoneHTML(done, ctx) {
  const d = done || {}, c = ctx || {};
  return `<div class="cal-done" role="status">
    <p><b>${esc(calCount(d.added, 'lead'))} imported</b>${d.assigned ? ', ' + esc(String(d.assigned)) + ' handed to your callers' : ''}${d.skipped ? ', ' + esc(String(d.skipped)) + ' skipped as already in Aviance' : ''}.</p>
    ${!d.added ? `<p class="cal-note">Nothing new went in — every row was already there.</p>` : ''}
    ${d.added && !d.assigned ? `<p class="cal-note">They are waiting unassigned because no caller is active yet. Give one an access code and they will be handed out.</p>` : ''}
    <div class="cal-acts"><button type="button" class="btn ghost" onclick="calUploadReset()">Import another file</button>
      ${c.batch ? `<span class="cal-note">Batch: ${esc(c.batch)}</span>` : ''}</div>
  </div>`;
}
function calUploadHTML(ctx) {
  const c = ctx || {};
  if (!c.up) {
    return `<div class="card cal-upbar">
      <div><h3>Leads</h3><p class="cal-note">Upload a CSV and Aviance splits it evenly across whoever is dialling.</p></div>
      <button type="button" class="btn" onclick="calUploadOpen()">Upload leads</button>
    </div>`;
  }
  return `<section class="card cal-up" aria-label="Upload leads">
    <div class="cal-ch"><h3>Upload leads</h3>
      <button type="button" class="cal-link" onclick="calUploadClose()">Close</button></div>
    <p class="cal-note">A CSV with the headings <b>company, name, phone, email, timezone, notes</b> — in any order.
      Extra columns and blank lines are ignored. Nothing is sent until you press Import.</p>
    <div class="cal-acts">
      <button type="button" class="btn ghost" onclick="calPick()"${c.parsing || c.importBusy ? ' disabled' : ''}>${c.parsing ? 'Reading…' : 'Choose a CSV file'}</button>
      <input type="file" id="calFile" accept=".csv,.txt,.tsv,text/csv" hidden onchange="calFileIn(this)">
      ${c.fileName ? `<span class="cal-note">${esc(c.fileName)}</span>` : ''}
    </div>
    ${c.fileErr ? `<p class="cal-bad" role="alert">${esc(c.fileErr)}</p>` : ''}
    ${c.importDone ? calImportDoneHTML(c.importDone, c) : (c.parsed ? calPreviewHTML(c.parsed, c) : '')}
  </section>`;
}

/* ---- the live feed ---- */
function calFeedRowHTML(f) {
  const who = f.callerName || 'A caller';
  const what = f.company || f.lead || 'a lead';
  return `<li class="cal-f${calIsTalk(f.outcome) ? ' talk' : ''}${f.outcome === 'booked' ? ' win' : ''}">
    <span class="cal-fo">${esc(calOutcomeLabel(f.outcome))}</span>
    <span class="cal-fw">${esc(who)} → ${esc(what)}</span>
    ${f.note ? `<span class="cal-fn">${esc(f.note)}</span>` : ''}
    <time class="cal-ft" title="${esc(calAgo(f.at))}">${esc(calTime(f.at))}</time>
  </li>`;
}
function calFeedHTML(feed, ctx) {
  const c = ctx || {}, rows = (Array.isArray(feed) ? feed : []).filter(f => f);
  if (!rows.length) {
    return `<section class="card cal-feed" aria-label="Calls as they happen">
      <h3>Calls as they happen</h3>
      <p class="cal-note">${esc(c.boardMissing ? CAL_NOT_READY : 'Nothing logged yet. Every call a caller taps shows here within half a minute.')}</p>
    </section>`;
  }
  return `<section class="card cal-feed" aria-label="Calls as they happen">
    <h3>Calls as they happen</h3>
    <ul class="cal-flist">${rows.map(calFeedRowHTML).join('')}</ul>
    <p class="cal-note">The last ${esc(calCount(rows.length, 'call'))}, newest first. This refreshes itself.</p>
  </section>`;
}

/* ---- the whole screen ---- */
function calScreenHTML(ctx) {
  const c = ctx || {};
  const board = String(c.range) === 'week' ? c.week : c.day;
  const feed = (board && board.feed && board.feed.length) ? board.feed
    : (((c.week && c.week.feed) || []).length ? c.week.feed : ((c.day && c.day.feed) || []));
  const find = (id) => (((board && board.callers) || []).find(r => r.id === id)
    || (c.list || []).find(r => r.id === id) || null);
  const openCaller = c.code ? find(c.code.staffId) : null;
  const openLinkCaller = c.link ? find(c.link.staffId) : null;
  /* The strip would read as a row of honest zeros before the migration lands, so it waits for a board. */
  return `${c.err ? `<div class="cal-bad cal-top" role="alert">${esc(c.err)}</div>` : ''}
    ${(c.day || c.week) ? calStripHTML(c.day, c.week) : ''}
    ${c.codeErr ? `<p class="cal-bad" role="alert">${esc(c.codeErr)}</p>` : ''}
    ${c.code && c.code.code ? calCodeHTML(c.code.code, openCaller) : ''}
    ${c.link && c.link.url ? calLinkHTML(c.link.url, openLinkCaller) : ''}
    ${c.adding ? calAddFormHTML(c) : ''}
    ${calBoardHTML(board, c)}
    <div class="cal-acts cal-main-acts">
      <button type="button" class="btn ghost" onclick="calAddOpen()">Add a caller</button>
      <button type="button" class="btn ghost" onclick="calLoadAll(true)">Refresh</button>
    </div>
    ${calUploadHTML(c)}
    ${calFeedHTML(feed, c)}`;
}

/* ===================== 4. THE SCREEN ===================== */
function calCtx() {
  return {
    range: cal.range, day: cal.day, week: cal.week, list: cal.list, link: cal.link,
    err: cal.err, missing: cal.missing, boardErr: cal.boardErr, boardMissing: cal.boardMissing,
    adding: cal.adding, addErr: cal.addErr, addBusy: cal.addBusy, addName: cal.addName, addEmail: cal.addEmail,
    code: cal.code, codeErr: cal.codeErr, busy: cal.busy, ask: cal.ask,
    up: cal.up, parsed: cal.parsed, fileName: cal.fileName, fileErr: cal.fileErr, parsing: cal.parsing,
    batch: cal.batch, importBusy: cal.importBusy, importErr: cal.importErr, importDone: cal.importDone,
  };
}
function viewCallers() {
  calLoadAll(false);
  calStart();
  return `<div class="cal" id="calRoot">${calBodyHTML()}</div>`;
}
function calBodyHTML() {
  if (!cal.loaded && cal.missing) {
    return `<div class="card cal-blank" role="alert"><h3>Not switched on yet</h3>
      <p>${esc(cal.err || CAL_NOT_READY)}</p></div>`;
  }
  if (!cal.loaded && cal.err) {
    return `<div class="card cal-blank" role="alert"><h3>The Callers screen didn’t load</h3>
      <p>${esc(cal.err)}</p><button type="button" class="btn" onclick="calLoadAll(true)">Try again</button></div>`;
  }
  if (!cal.loaded) return `<div class="card cal-blank" role="status">Loading your callers…</div>`;
  return calScreenHTML(calCtx());
}
function calPaint() {
  const r = calEl('calRoot');
  if (!r) return;
  /* Don't wipe what he is typing: a repaint while a box has focus would lose the caret. */
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (a && a.id && (a.id === 'calAddName' || a.id === 'calAddEmail' || a.id === 'calBatch')) return;
  r.innerHTML = calBodyHTML();
}
/* A repaint the focus guard must not skip (the form itself changed). */
function calForcePaint() { const r = calEl('calRoot'); if (r) r.innerHTML = calBodyHTML(); }

async function calLoad(force) {
  if (cal.loading && !force) return;
  cal.loading = true;
  const seq = ++cal.seq;
  const r = await calFetchList();
  if (seq !== cal.seq) return;
  cal.loading = false;
  if (r.ok) { cal.list = r.data; cal.loaded = true; cal.err = null; cal.missing = false; }
  else {
    cal.err = r.error; cal.missing = !!r.missing;
    if (cal.missing) { cal.loaded = false; calStop(); }
  }
  calPaint();
}
/* Both ranges at once: the switch is then instant, and the strip can show today beside the week. */
async function calLoadBoard(force) {
  if (cal.boardLoading && !force) return;
  cal.boardLoading = true;
  const seq = ++cal.bseq;
  const [d, w] = await Promise.all([calFetchBoard(1), calFetchBoard(CAL_WEEK_DAYS)]);
  if (seq !== cal.bseq) return;
  cal.boardLoading = false;
  if (d.ok) cal.day = d.data;
  if (w.ok) cal.week = w.data;
  if (d.ok || w.ok) { cal.boardErr = null; cal.boardMissing = false; }
  else {
    cal.boardErr = d.error || w.error; cal.boardMissing = !!(d.missing || w.missing);
    if (cal.boardMissing) calStop();
  }
  calPaint();
}
function calLoadAll(force) { calLoad(force); calLoadBoard(force); }
function calSetRange(range) { cal.range = String(range) === 'week' ? 'week' : 'day'; calForcePaint(); }

/* ---- the Add form ---- */
function calAddOpen() { cal.adding = true; cal.ask = ''; cal.addErr = null; cal.addName = ''; cal.addEmail = ''; calForcePaint(); setTimeout(() => { const e = calEl('calAddName'); if (e && e.focus) e.focus(); }, 0); }
function calAddCancel() { cal.adding = false; cal.addErr = null; cal.addName = ''; cal.addEmail = ''; calForcePaint(); }
async function calAddSave(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  if (cal.addBusy) return;
  const name = (calEl('calAddName') || {}).value || '', email = (calEl('calAddEmail') || {}).value || '';
  cal.addName = name; cal.addEmail = email;
  const bad = calNameProblem(name) || calEmailProblem(email);
  if (bad) { cal.addErr = bad; cal.adding = true; cal.addBusy = false; calForcePaint(); return; }
  cal.addBusy = true; cal.addErr = null; calForcePaint();
  const r = await calAdd(name, email);
  cal.addBusy = false;
  if (!r.ok) { cal.addErr = r.error; calForcePaint(); return; }
  cal.adding = false; cal.addName = ''; cal.addEmail = '';
  const id = (r.data && (r.data.staff_id || r.data.staffId)) || null;
  if (typeof toast === 'function') toast(String(name).trim() + ' is added. Now generate her access code.');
  await calLoad(true);
  calLoadBoard(true);
  if (id) calCodeGo(id);                   // the next thing he needs is the code, so go straight there
}

/* ---- the inline "are you sure" ---- */
function calAskYes(what, id) { cal.ask = String(what || '') + ':' + String(id || ''); calForcePaint(); }
function calAskNo() { cal.ask = ''; calForcePaint(); }
function calAskImport() {
  const n = (cal.parsed && Array.isArray(cal.parsed.rows) ? cal.parsed.rows.length : 0);
  if (!n) return;
  cal.ask = 'import:' + n; cal.importErr = null; calForcePaint();
}

/* ---- the code ---- */
async function calCodeGo(id) {
  if (!id || cal.busy[id]) return;
  cal.ask = ''; cal.busy[id] = 'code'; cal.codeErr = null; calForcePaint();
  const r = await calCode(id);
  delete cal.busy[id];
  if (!r.ok) { cal.codeErr = r.error; calForcePaint(); if (typeof toast === 'function') toast(r.error); return; }
  cal.code = { staffId: String(id), code: r.data };     // on screen only, until calForgetCode()
  calForcePaint();
  const v = calEl('calCodeVal'); if (v && v.focus) { try { v.setAttribute('tabindex', '-1'); v.focus(); } catch (e) { } }
  calLoad(true);                                        // her status is 'invited' now
}
function calCodeHide() { calForgetCode(); calForcePaint(); }

async function calLinkGo(id) {
  if (!id || cal.busy[id]) return;
  cal.ask = ''; cal.busy[id] = 'link'; cal.codeErr = null; calForcePaint();
  const r = await calLinkNew(id);
  delete cal.busy[id];
  if (!r.ok) { cal.codeErr = r.error; calForcePaint(); if (typeof toast === 'function') toast(r.error); return; }
  cal.link = { staffId: String(id), url: r.data.url };   // on screen only, until calForgetLink()
  calForcePaint();
  const v = calEl('calLinkVal'); if (v && v.focus) { try { v.setAttribute('tabindex', '-1'); v.focus(); } catch (e) { } }
  calLoad(true);
}
function calLinkHide() { calForgetLink(); calForcePaint(); }
function calCopyLink() {
  const url = cal.link && cal.link.url;
  if (!url) return;
  const done = () => { if (typeof toast === 'function') toast('Link copied. Send it to her and nobody else.'); };
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(done, () => calCopyFallback('calLinkVal')); return; }
  } catch (e) { }
  calCopyFallback('calLinkVal');
}
function calCopyCode() {
  const code = cal.code && cal.code.code;
  if (!code) return;
  const done = () => { if (typeof toast === 'function') toast('Code copied. Send it to her yourself.'); };
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(code).then(done, calCopyFallback); return; }
  } catch (e) { }
  calCopyFallback();
}
function calCopyFallback(which) {
  const id = String(which || 'calCodeVal');
  const what = id === 'calLinkVal' ? 'link' : 'code';
  const v = calEl(id);
  if (v && typeof document !== 'undefined' && document.createRange && typeof window !== 'undefined' && window.getSelection) {
    try {
      const r = document.createRange(); r.selectNodeContents(v);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      if (typeof toast === 'function') toast('The ' + what + ' is selected — press Ctrl+C to copy it.');
      return;
    } catch (e) { }
  }
  if (typeof toast === 'function') toast('Copying did not work here. Select the ' + what + ' and copy it by hand.');
}
async function calStatusGo(id, to) {
  if (!id || cal.busy[id]) return;
  const next = to === 'active' ? 'active' : 'revoked';
  cal.ask = ''; cal.busy[id] = 'status'; calForcePaint();
  const r = await calSetStatus(id, next);
  delete cal.busy[id];
  if (!r.ok) { cal.err = r.error; calForcePaint(); if (typeof toast === 'function') toast(r.error); return; }
  cal.err = null;
  if (typeof toast === 'function') toast(next === 'revoked' ? 'She can no longer sign in.' : 'She can sign in again.');
  await calLoad(true);
  calLoadBoard(true);
}

/* ---- the CSV upload ---- */
function calUploadOpen() { cal.up = true; cal.fileErr = null; calForcePaint(); }
function calUploadClose() { cal.up = false; calUploadReset(); }
function calUploadReset() {
  cal.parsed = null; cal.fileName = ''; cal.fileErr = null; cal.parsing = false;
  cal.batch = ''; cal.importErr = null; cal.importDone = null;
  if (String(cal.ask || '').indexOf('import') === 0) cal.ask = '';
  const f = calEl('calFile'); if (f) { try { f.value = ''; } catch (e) { } }
  calForcePaint();
}
function calPick() { const f = calEl('calFile'); if (f && f.click) f.click(); }
function calBatchIn(v) { cal.batch = String(v == null ? '' : v).slice(0, 120); }
async function calFileIn(input) {
  const f = input && input.files && input.files[0];
  cal.fileErr = null; cal.parsed = null; cal.importDone = null; cal.importErr = null; cal.ask = '';
  if (!f) { cal.fileName = ''; calForcePaint(); return; }
  cal.fileName = String(f.name || 'the file'); cal.parsing = true; calForcePaint();
  const read = await calReadFile(f);
  if (!read.ok) { cal.parsing = false; cal.fileErr = read.error; calForcePaint(); return; }
  const p = calParseCsv(read.data, CAL_MAX_ROWS);
  cal.parsing = false;
  if (!p.ok) { cal.fileErr = p.error; calForcePaint(); return; }
  cal.parsed = p.data;
  cal.batch = calBatchName(cal.fileName, Date.now());
  calForcePaint();
}
async function calImportGo() {
  const rows = (cal.parsed && Array.isArray(cal.parsed.rows)) ? cal.parsed.rows : [];
  if (!rows.length || cal.importBusy) return;
  cal.importBusy = true; cal.importErr = null; cal.ask = ''; calForcePaint();
  const batch = (calEl('calBatch') || {}).value || cal.batch;
  cal.batch = String(batch || '').slice(0, 120);
  const r = await calImport(rows, cal.batch);
  cal.importBusy = false;
  if (!r.ok) { cal.importErr = r.error; calForcePaint(); if (typeof toast === 'function') toast(r.error); return; }
  cal.importDone = r.data; cal.parsed = null;
  if (typeof toast === 'function') toast(calCount(r.data.added, 'lead') + ' imported.');
  calForcePaint();
  calLoadBoard(true);
}

/* render() calls this after every screen change: the code and the picked file never outlive the screen. */
function calOnRender(view) {
  if (view === 'callers') { calStart(); return; }
  calStop(); calForgetCode(); cal.ask = ''; cal.adding = false;
}
