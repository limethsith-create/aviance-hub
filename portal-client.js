/* ===================== AVIANCE — the client's pages =====================
   Shared by doc.html (agreement + invoice), join.html (set a password) and
   portal.html (the client's one channel). A client's browser gets ONLY this
   file, portal-client.css and supabase-js: no hub module is loaded here.

   Security lives in the database (link tokens, row level security). Nothing
   here hides anything; it only shows what the database chose to hand over.

   Rules this file keeps:
     - Every data function returns {ok, data, error} and never throws.
       `error` is plain words, safe to show a person.
     - Every piece of text from a person or the database goes through pcEsc
       before it becomes HTML. The *Html builders return finished, safe HTML.
     - A link token is read from the URL #fragment, kept in memory, and never
       written to storage or a query string.

   Contract: rpc doc_get / doc_sign / invite_peek / portal_home, the
   portal-accept edge function, and the channel_messages table.
   ======================================================================= */

const PC_URL = 'https://zjbxnkpktbghhudjbxhk.supabase.co';
const PC_KEY = 'sb_publishable_WV4FANV2hNsmbzK3DbiLFg_9bjiB8Z1';
const PC_LOGO = 'https://www.aviance.online/logo-180.png';
const PC_MAX_BODY = 4000;
const PC_MIN_PASSWORD = 8;
const PC_MAX_PASSWORD = 72;
const PC_POLL_MS = 20000;
const PC_HISTORY = 300;
const PC_DEAD_LINK = 'This link is not valid any more. Reply to our email and we will send a new one.';
const PC_OFFLINE = 'We could not reach Aviance. Check your connection and try again.';
const PC_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PC_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ---- pure helpers -------------------------------------------------- */

/* The one escape. Use it on everything that did not come from this file. */
function pcEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* '#abc123' -> 'abc123'. Anything that cannot be a token -> ''. */
function pcTokenFromHash(hash){
  let t = String(hash == null ? '' : hash).trim();
  if (t.charAt(0) === '#') t = t.slice(1);
  if (t.charAt(0) === '/') t = t.slice(1);
  if (/^(token|t)=/i.test(t)) t = t.slice(t.indexOf('=') + 1);
  try { t = decodeURIComponent(t); } catch (e) { return ''; }
  t = t.trim();
  return /^[A-Za-z0-9._~-]{8,512}$/.test(t) ? t : '';
}

/* Only a plain https link may become an href. */
function pcSafeUrl(u){
  const s = String(u == null ? '' : u).trim();
  if (!/^https:\/\/[^\s"'<>\\]+$/i.test(s)) return '';
  return s;
}

/* Whole dollars in, '$2,497.00' out. Credits read '−$300.00'. */
function pcMoney(amount, currency){
  const n = Number(amount);
  if (amount == null || amount === '' || !isFinite(n)) return '';
  const cur = String(currency || 'USD').toUpperCase();
  const sym = { USD: '$', GBP: '£', EUR: '€', AUD: 'A$', CAD: 'C$' }[cur];
  const parts = Math.abs(n).toFixed(2).split('.');
  const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const num = whole + '.' + parts[1];
  return (n < 0 ? '−' : '') + (sym ? sym + num : num + ' ' + cur);
}

/* A date-only value ('2026-11-24') is a calendar day and must not slide with
   the viewer's time zone; a timestamp is shown in the viewer's own zone. */
function pcToDate(v){
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return isNaN(d) ? null : d;
}
function pcDate(v){
  const d = pcToDate(v);
  return d ? d.getDate() + ' ' + PC_MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '';
}
function pcTime(v){
  const d = pcToDate(v);
  if (!d) return '';
  try { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
}
function pcDayKey(v){
  const d = pcToDate(v);
  return d ? d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) : '';
}
function pcDayLabel(v, now){
  const d = pcToDate(v);
  if (!d) return '';
  const n = pcToDate(now) || new Date();
  const key = pcDayKey(d);
  if (key === pcDayKey(n)) return 'Today';
  const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (key === pcDayKey(y)) return 'Yesterday';
  return PC_DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + PC_MONTHS[d.getMonth()] + (d.getFullYear() === n.getFullYear() ? '' : ' ' + d.getFullYear());
}

function pcFirstName(name){
  const w = String(name == null ? '' : name).trim().split(/\s+/)[0];
  return w || 'there';
}

/* '' when the password is fine, otherwise what to fix. */
function pcPasswordProblem(password, confirm){
  const p = String(password == null ? '' : password);
  if (p.length < PC_MIN_PASSWORD) return 'Use at least ' + PC_MIN_PASSWORD + ' characters.';
  if (p.length > PC_MAX_PASSWORD) return 'Use ' + PC_MAX_PASSWORD + ' characters or fewer.';
  if (confirm !== undefined && p !== String(confirm == null ? '' : confirm)) return 'The two passwords do not match.';
  return '';
}

/* '' when the signature is fine, otherwise what to fix. */
function pcSignProblem(name, agreed){
  const n = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  if (n.length < 2 || !/[A-Za-zÀ-￿]/.test(n)) return 'Type your full name to sign.';
  if (n.length > 120) return 'That name is too long. Use 120 characters or fewer.';
  if (!agreed) return 'Tick the box to confirm you have read the agreement.';
  return '';
}

/* What a person typed -> what is stored. */
function pcCleanBody(text){
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim().slice(0, PC_MAX_BODY);
}

/* The invoice's lines, with the pilot credit always its own negative line, and
   a check that they add up to what the database says is owed. The database's
   `amount` is the total shown; `matches` says whether the lines agree. */
function pcInvoiceLines(inv){
  const d = inv || {};
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  let lines = (Array.isArray(d.lines) ? d.lines : [])
    .filter((l) => l && isFinite(Number(l.amount)))
    .map((l) => ({ label: String(l.label == null ? '' : l.label), amount: Number(l.amount), credit: Number(l.amount) < 0 }));
  const credit = Math.abs(num(d.pilot_credit));
  if (!lines.length && d.gross != null) lines = [{ label: 'Services', amount: num(d.gross), credit: false }];
  if (credit > 0 && !lines.some((l) => l.credit)) lines.push({ label: 'Pilot credit', amount: -credit, credit: true });
  const sum = lines.reduce((t, l) => t + l.amount, 0);
  const total = d.amount == null || !isFinite(Number(d.amount)) ? sum : Number(d.amount);
  return { lines, sum, total, matches: sum === total };
}

/* Rows of channel_messages -> days of messages ready to draw.
   home is what portal_home returned. A message is 'team' when a team member
   wrote it (author_user) and 'client' when someone at the client did. */
function pcGroupMessages(rows, home, now){
  const h = home || {};
  const names = {};
  (Array.isArray(h.members) ? h.members : []).forEach((m) => { if (m && m.id) names[m.kind + ':' + m.id] = m.name; });
  const meId = h.person && h.person.id;
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.id != null && !r.deleted_at)
    .slice()
    .sort((a, b) => (pcToDate(a.created_at) || 0) - (pcToDate(b.created_at) || 0));
  const days = [];
  const seen = {};
  let prev = null;
  for (const r of list) {
    if (seen[r.id]) continue;
    seen[r.id] = true;
    const kind = r.author_user ? 'team' : 'client';
    const who = r.author_user || r.author_person || '';
    const name = names[kind + ':' + who] || (kind === 'team' ? 'Aviance' : (h.company || 'Client'));
    const at = pcToDate(r.created_at);
    const key = pcDayKey(at);
    let day = days[days.length - 1];
    if (!day || day.key !== key) { day = { key, label: pcDayLabel(at, now), items: [] }; days.push(day); prev = null; }
    const lead = !prev || prev.kind !== kind || prev.who !== who || (at - prev.at) > 5 * 60 * 1000;
    day.items.push({ id: r.id, kind, mine: kind === 'client' && !!meId && r.author_person === meId, name, time: pcTime(at), iso: at ? at.toISOString() : '', body: String(r.body == null ? '' : r.body), lead });
    prev = { kind, who, at };
  }
  return days;
}

/* ---- HTML builders (everything escaped) ----------------------------- */

function pcLogoHtml(){
  return `<img class="pc-logo" src="${PC_LOGO}" width="44" height="44" alt="Aviance">`;
}
function pcNoticeHtml(title, text, extra){
  return `<main class="pc-wrap pc-notice">${pcLogoHtml()}<h1 class="pc-h1" tabindex="-1">${pcEsc(title)}</h1><p class="pc-lede">${pcEsc(text)}</p>${extra || ''}</main>`;
}
function pcDeadLinkHtml(){
  return pcNoticeHtml('This link has closed.', PC_DEAD_LINK);
}
function pcOfflineHtml(){
  return pcNoticeHtml('We could not load this page.', PC_OFFLINE, '<p><button type="button" class="pc-btn" data-pc-retry>Try again</button></p>');
}
function pcLoadingHtml(){
  return `<main class="pc-wrap pc-notice" aria-busy="true">${pcLogoHtml()}<p class="pc-tag">Loading</p></main>`;
}
function pcParasHtml(body){
  const list = Array.isArray(body) ? body : (body == null || body === '' ? [] : [body]);
  return list.map((p) => `<p>${pcEsc(p)}</p>`).join('');
}

function pcAgreementHtml(doc){
  const d = doc || {};
  const t = d.terms || {};
  const company = d.company || 'your company';
  const parties = (Array.isArray(t.parties) ? t.parties : [])
    .map((p) => `<div class="pc-party"><dt class="pc-tag">${pcEsc(p && p.label)}</dt><dd>${pcEsc(p && p.value)}</dd></div>`).join('');
  const sections = (Array.isArray(t.sections) ? t.sections : [])
    .map((s, i) => `<section class="pc-sec"><h2><span class="pc-num">${i + 1}</span>${pcEsc(s && s.h)}</h2>${pcParasHtml(s && s.body)}</section>`).join('');
  let foot;
  if (d.status === 'signed') {
    foot = `<section class="pc-signed" id="pcSigned" tabindex="-1" aria-label="Signature">
      <p class="pc-tag pc-red">Signed</p>
      <p class="pc-signature">${pcEsc(d.signed_name)}</p>
      <p class="pc-signed-line">Signed by ${pcEsc(d.signed_name)} on ${pcEsc(pcDate(d.signed_at))}</p>
      <p class="pc-noprint"><button type="button" class="pc-btn pc-btn-line" data-pc-print>Print or save as PDF</button></p>
    </section>`;
  } else if (d.status === 'void') {
    foot = `<section class="pc-signed"><p class="pc-tag">Withdrawn</p><p class="pc-signed-line">This agreement has been withdrawn and can no longer be signed. Reply to our email if you were expecting to sign it.</p></section>`;
  } else {
    foot = `<form class="pc-sign pc-noprint" id="pcSignForm" novalidate>
      <p class="pc-tag pc-red">Sign</p>
      <label class="pc-label" for="pcSignName">Type your full name to sign</label>
      <input class="pc-input pc-input-sign" id="pcSignName" name="name" type="text" autocomplete="name" maxlength="120" required aria-describedby="pcSignErr">
      <label class="pc-check" for="pcSignAgree"><input id="pcSignAgree" name="agree" type="checkbox" required><span>I have read this agreement and I am authorised to sign for ${pcEsc(company)}</span></label>
      <p class="pc-err" id="pcSignErr" role="alert" aria-live="assertive"></p>
      <button type="submit" class="pc-btn" id="pcSignBtn">Sign agreement</button>
      <p class="pc-small">Typing your name and pressing the button signs this agreement on behalf of ${pcEsc(company)}. We record the time and the device used.</p>
    </form>`;
  }
  return `<main class="pc-wrap pc-doc">
    <header class="pc-dochead">${pcLogoHtml()}<p class="pc-tag">Agreement</p></header>
    <h1 class="pc-h1" tabindex="-1">${pcEsc(t.title || 'Service agreement')}</h1>
    ${t.intro ? `<p class="pc-lede">${pcEsc(t.intro)}</p>` : ''}
    ${parties ? `<dl class="pc-parties">${parties}</dl>` : ''}
    <div class="pc-terms">${sections}</div>
    ${foot}
  </main>`;
}

function pcInvoiceHtml(doc){
  const d = doc || {};
  const from = d.from || {};
  const to = d.bill_to || {};
  const pay = d.pay || {};
  const cur = d.currency || 'USD';
  const built = pcInvoiceLines(d);
  const paid = d.status === 'paid';
  const dead = d.status === 'void';
  const rows = built.lines.map((l) => `<tr${l.credit ? ' class="pc-credit"' : ''}><td>${pcEsc(l.label)}</td><td class="pc-amt">${pcEsc(pcMoney(l.amount, cur))}</td></tr>`).join('');
  let stamp = '';
  if (paid) stamp = `<p class="pc-stamp pc-stamp-paid"><strong>Paid</strong>${d.paid_at ? `<span>${pcEsc(pcDate(d.paid_at))}</span>` : ''}</p>`;
  else if (dead) stamp = '<p class="pc-stamp"><strong>Void</strong></p>';
  else if (d.status === 'overdue') stamp = '<p class="pc-stamp"><strong>Overdue</strong></p>';
  else if (d.status === 'draft') stamp = '<p class="pc-stamp"><strong>Draft</strong></p>';
  const link = pcSafeUrl(pay.payoneer_link);
  const meta = [
    ['Number', d.number],
    ['Issued', pcDate(d.issued_on)],
    [paid ? 'Paid' : 'Due', paid ? pcDate(d.paid_at) : pcDate(d.due_on)],
  ].filter((m) => m[1]).map((m) => `<div><dt class="pc-tag">${m[0]}</dt><dd>${pcEsc(m[1])}</dd></div>`).join('');
  const addr = (o, keys) => keys.map((k) => o[k]).filter(Boolean).map((v, i) => `<p${i ? '' : ' class="pc-strong"'}>${pcEsc(v)}</p>`).join('');
  const how = paid || dead ? '' : `<section class="pc-pay" aria-labelledby="pcPayH">
      <h2 class="pc-tag pc-red" id="pcPayH">How to pay</h2>
      <p class="pc-pay-lede">Pay by bank transfer with the details below${d.number ? `, and put <strong>${pcEsc(d.number)}</strong> as the reference` : ''}.</p>
      <pre class="pc-pre">${pcEsc(pay.wise_details)}</pre>
      ${link ? `<p class="pc-noprint"><a class="pc-btn" href="${pcEsc(link)}" target="_blank" rel="noopener noreferrer">Pay by card</a></p>` : ''}
    </section>`;
  return `<main class="pc-wrap pc-doc pc-invoice">
    <header class="pc-dochead">${pcLogoHtml()}<p class="pc-tag">${paid ? 'Receipt' : 'Invoice'}</p></header>
    <div class="pc-invtop"><h1 class="pc-h1" tabindex="-1">${paid ? 'Receipt' : 'Invoice'}</h1>${stamp}</div>
    <dl class="pc-meta">${meta}</dl>
    <div class="pc-two">
      <div><p class="pc-tag">From</p>${addr(from, ['legal_name', 'address', 'email'])}</div>
      <div><p class="pc-tag">Bill to</p>${addr(to, ['company', 'contact_name', 'contact_email'])}</div>
    </div>
    <table class="pc-lines"><thead><tr><th scope="col" class="pc-tag">Description</th><th scope="col" class="pc-tag pc-amt">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="pc-total"><p class="pc-tag">${paid ? 'Total paid' : 'Total due'}${cur ? ' · ' + pcEsc(String(cur).toUpperCase()) : ''}</p><p class="pc-total-n">${pcEsc(pcMoney(built.total, cur))}</p></div>
    ${how}
    <p class="pc-noprint pc-docfoot"><button type="button" class="pc-btn pc-btn-line" data-pc-print>Print or save as PDF</button></p>
  </main>`;
}

function pcThreadHtml(days){
  const list = Array.isArray(days) ? days : [];
  if (!list.length) return '<p class="pc-empty">This is your direct line to the Aviance team. Say hello.</p>';
  return list.map((day) => `<div class="pc-day" role="separator"><span class="pc-tag">${pcEsc(day.label)}</span></div>` +
    day.items.map((m) => `<article class="pc-msg pc-msg-${m.kind === 'team' ? 'team' : 'client'}${m.mine ? ' pc-msg-mine' : ''}${m.lead ? ' pc-msg-lead' : ''}">
      ${m.lead ? `<p class="pc-msg-head"><span class="pc-msg-name">${pcEsc(m.name)}</span>${m.kind === 'team' ? '<span class="pc-tag pc-red">Aviance</span>' : ''}<time class="pc-msg-time" datetime="${pcEsc(m.iso)}">${pcEsc(m.time)}</time></p>` : ''}
      <p class="pc-msg-body">${pcEsc(m.body)}</p>
    </article>`).join('')).join('');
}

/* ---- plumbing ------------------------------------------------------- */

function pcOk(data){ return { ok: true, data, error: '' }; }
function pcErr(e){
  let m = (e && (e.message || e.error_description || e.msg || e.error)) || (typeof e === 'string' ? e : '');
  m = String(m || 'Something went wrong. Please try again.');
  const offline = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(m);
  if (offline) m = PC_OFFLINE;
  return { ok: false, data: null, error: m, offline };
}

/* Two clients, on purpose. 'anon' is for the link pages: it never looks at or
   keeps a login, so a link works the same for everyone. 'portal' keeps the
   client's login under its own storage key, apart from the team hub's. */
const pcClients = {};
function pcClient(kind){
  const k = kind === 'anon' ? 'anon' : 'portal';
  if (pcClients[k]) return pcClients[k];
  if (typeof window === 'undefined' || !window.supabase || !window.supabase.createClient) return null;
  const auth = k === 'anon'
    ? { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'aviance-link' }
    : { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'aviance-portal-auth' };
  try { pcClients[k] = window.supabase.createClient(PC_URL, PC_KEY, { auth }); } catch (e) { return null; }
  return pcClients[k];
}
/* Tests (and nothing else) hand in a fake client. */
function pcUseClient(kind, client){ pcClients[kind === 'anon' ? 'anon' : 'portal'] = client; }

async function pcRpc(kind, name, args){
  const sb = pcClient(kind);
  if (!sb) return pcErr(PC_OFFLINE);
  try {
    const res = await sb.rpc(name, args || {});
    if (!res) return pcErr('No answer from Aviance.');
    if (res.error) return pcErr(res.error);
    return pcOk(res.data === undefined ? null : res.data);
  } catch (e) { return pcErr(e); }
}

/* ---- data: documents ------------------------------------------------ */

async function pcDocGet(token){
  if (!token) return pcErr(PC_DEAD_LINK);
  const r = await pcRpc('anon', 'doc_get', { p_token: token });
  if (r.ok && !(r.data && (r.data.kind === 'agreement' || r.data.kind === 'invoice'))) return pcErr(PC_DEAD_LINK);
  return r;
}
async function pcDocSign(token, name, agent){
  if (!token) return pcErr(PC_DEAD_LINK);
  const clean = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  const bad = pcSignProblem(clean, true);
  if (bad) return pcErr(bad);
  const r = await pcRpc('anon', 'doc_sign', { p_token: token, p_name: clean, p_agent: String(agent || '').slice(0, 400) });
  if (r.ok && !(r.data && r.data.kind === 'agreement')) return pcErr('We could not confirm the signature. Refresh the page to check.');
  return r;
}

/* ---- data: joining -------------------------------------------------- */

/* Always answers with the peek shape: {ok:true,email,company,name} or {ok:false,reason}. */
async function pcInvitePeek(token){
  if (!token) return pcOk({ ok: false, reason: 'invalid' });
  const r = await pcRpc('anon', 'invite_peek', { p_token: token });
  if (!r.ok) return r;
  if (!r.data || typeof r.data !== 'object') return pcOk({ ok: false, reason: 'invalid' });
  return r;
}
function pcInviteMessage(reason){
  if (reason === 'used') return 'This link has already been used. Sign in instead.';
  if (reason === 'expired') return 'This link has expired. Reply to our email and we will send a new one.';
  return PC_DEAD_LINK;
}
async function pcAccept(token, password){
  const bad = pcPasswordProblem(password);
  if (bad) return pcErr(bad);
  if (!token) return pcErr(PC_DEAD_LINK);
  try {
    const res = await fetch(PC_URL + '/functions/v1/portal-accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (res.ok && j && j.ok && j.email) return pcOk({ email: j.email });
    return pcErr((j && typeof j.error === 'string' && j.error) || 'We could not set your password. Please try again.');
  } catch (e) { return pcErr(e); }
}

/* ---- data: the login ------------------------------------------------ */

async function pcSignIn(email, password){
  const sb = pcClient('portal');
  if (!sb) return pcErr(PC_OFFLINE);
  const e = String(email == null ? '' : email).trim();
  if (!e || !password) return pcErr('Enter your email and password.');
  try {
    const res = await sb.auth.signInWithPassword({ email: e, password });
    if (res.error) {
      const r = pcErr(res.error);
      if (!r.offline) r.error = /invalid login|credentials/i.test(r.error) ? 'That email and password do not match.' : r.error;
      return r;
    }
    return pcOk(res.data && res.data.session ? res.data.session : null);
  } catch (err) { return pcErr(err); }
}
async function pcSignOut(){
  const sb = pcClient('portal');
  if (!sb) return pcOk(null);
  try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { /* signed out here either way */ }
  return pcOk(null);
}
async function pcSession(){
  const sb = pcClient('portal');
  if (!sb) return pcErr(PC_OFFLINE);
  try {
    const res = await sb.auth.getSession();
    if (res.error) return pcErr(res.error);
    return pcOk(res.data ? res.data.session : null);
  } catch (e) { return pcErr(e); }
}
/* Tells the page when the login ends (signed out elsewhere, or it ran out). */
function pcOnSignedOut(fn){
  const sb = pcClient('portal');
  if (!sb || !sb.auth || !sb.auth.onAuthStateChange) return;
  try { sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { try { fn(); } catch (e) { /* the page's problem */ } } }); } catch (e) { /* no listener, the poll still works */ }
}

/* ---- data: the channel ---------------------------------------------- */

/* null means: signed in, but not a client. */
async function pcHome(){
  const r = await pcRpc('portal', 'portal_home', {});
  if (r.ok && r.data && !(r.data.channel && r.data.channel.id && r.data.person && r.data.person.id)) return pcOk(null);
  return r;
}
const PC_MSG_COLS = 'id,channel_id,author_user,author_person,body,created_at';
async function pcMessages(channelId){
  const sb = pcClient('portal');
  if (!sb) return pcErr(PC_OFFLINE);
  if (!channelId) return pcErr('There is no channel to open.');
  try {
    /* Row level security already leaves removed messages out; asking again
       costs nothing. If the removed-marker is not ours to read, ask without it. */
    const ask = (live) => {
      let q = sb.from('channel_messages').select(PC_MSG_COLS).eq('channel_id', channelId);
      if (live) q = q.is('deleted_at', null);
      return q.order('created_at', { ascending: false }).limit(PC_HISTORY);
    };
    let res = await ask(true);
    if (res && res.error && !pcErr(res.error).offline) res = await ask(false);
    if (!res) return pcErr('No answer from Aviance.');
    if (res.error) return pcErr(res.error);
    return pcOk((res.data || []).slice().reverse());
  } catch (e) { return pcErr(e); }
}
async function pcSend(channelId, personId, text){
  const sb = pcClient('portal');
  if (!sb) return pcErr(PC_OFFLINE);
  const body = pcCleanBody(text);
  if (!body) return pcErr('Write a message first.');
  if (!channelId || !personId) return pcErr('There is no channel to write to.');
  try {
    const res = await sb.from('channel_messages')
      .insert({ channel_id: channelId, author_person: personId, body }).select(PC_MSG_COLS).single();
    if (!res) return pcErr('No answer from Aviance.');
    if (res.error) return pcErr(res.error);
    return pcOk(res.data || null);
  } catch (e) { return pcErr(e); }
}
/* Live updates. Calls onChange whenever anything in the channel changes;
   returns a function that stops listening. Never throws. */
function pcSubscribe(channelId, onChange){
  const sb = pcClient('portal');
  if (!sb || !channelId || !sb.channel) return function(){};
  try {
    const ch = sb.channel('pc-' + channelId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'channel_messages', filter: 'channel_id=eq.' + channelId },
        (p) => { try { onChange(p); } catch (e) { /* the page's problem, not the socket's */ } })
      .subscribe();
    return function(){ try { sb.removeChannel(ch); } catch (e) { /* already gone */ } };
  } catch (e) { return function(){}; }
}
