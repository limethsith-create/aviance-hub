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

   Contract: rpc doc_get / doc_sign / invite_peek / portal_home /
   portal_kickoff_slots / portal_book_kickoff, the
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

/* The one escape, from core.js. Use it on everything that did not come from this file. */
const pcEsc = coreEsc;

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

/* Whole dollars in, '$3,000.00' out. A negative amount reads '−$300.00'.
   NOT coreUsd, and not a copy of it that drifted: the two differ on purpose.
   coreUsd is for the owner's screens, which show whole dollars in one currency
   because that reads faster. This is a figure on an invoice a client is being
   asked to pay, so it shows the cents and the invoice's own currency. Keep both. */
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

/* A value -> a Date, from core.js. A date-only value is a calendar day and does
   not slide with the reader's zone; a timestamp is a moment. */
const pcToDate = coreToDate;
function pcDate(v){
  const d = pcToDate(v);
  return d ? PC_MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() : '';
}
/* A clock reading in the reader's own style, from core.js. */
const pcTime = coreTime;
/* A day key, from core.js: 'YYYY-MM-DD' zero-padded in the reader's own calendar.
   One implementation, because a day key one day out is a refund. */
const pcDayKey = coreDayKey;
function pcDayLabel(v, now){
  const d = pcToDate(v);
  if (!d) return '';
  const n = pcToDate(now) || new Date();
  const key = pcDayKey(d);
  if (key === pcDayKey(n)) return 'Today';
  const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (key === pcDayKey(y)) return 'Yesterday';
  return PC_DAYS[d.getDay()] + ', ' + PC_MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() === n.getFullYear() ? '' : ', ' + d.getFullYear());
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

/* The guarantee in one line, for the foot of every invoice and receipt. */
const PC_GUARANTEE = 'Miss your agreed number of calls in month one and we refund twice that month’s fee. Miss it in any later month and we refund that month in full. Money back, not credit.';

/* The two halves of a term line, for the invoice table, which sets them on
   their own rows so the term and the saving each read at a glance:
   {term:'3 months × $1,200.00 a month', off:'20% off the $1,500.00 monthly price'}.
   Both are '' when the line is not priced by the month. A one-month line says
   nothing: its amount is already the month's price. */
function pcLineParts(line, currency){
  const l = line || {};
  const months = Number(l.months);
  const unit = Number(l.unit);
  if (!Number.isInteger(months) || months < 2 || !isFinite(unit) || unit <= 0) return { term: '', off: '' };
  const list = Number(l.list_unit);
  return {
    term: months + ' months × ' + pcMoney(unit, currency) + ' a month',
    off: isFinite(list) && list > unit ? Math.round((1 - unit / list) * 100) + '% off the ' + pcMoney(list, currency) + ' monthly price' : '',
  };
}

/* The same thing in one sentence: '3 months × $1,200.00 a month · 20% off the
   $1,500.00 monthly price', or ''. Kept because older callers read one string. */
function pcLineDetail(line, currency){
  const p = pcLineParts(line, currency);
  return p.term ? (p.off ? p.term + ' · ' + p.off : p.term) : '';
}

/* The invoice's lines, and a check that they add up to what the database says
   is owed. The database's `amount` is the total shown; `matches` says whether
   the lines agree. A document made before the one-off trial plan was retired
   may still carry its credit: that field and that line are ignored. */
function pcInvoiceLines(inv){
  const d = inv || {};
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  let lines = (Array.isArray(d.lines) ? d.lines : [])
    .filter((l) => l && l.amount != null && l.amount !== '' && isFinite(Number(l.amount)))
    .map((l) => {
      const p = pcLineParts(l, d.currency);
      return { label: String(l.label == null ? '' : l.label), amount: Number(l.amount), credit: Number(l.amount) < 0,
        detail: pcLineDetail(l, d.currency), term: p.term, off: p.off };
    })
    .filter((l) => !(l.credit && /pilot/i.test(l.label)));
  if (!lines.length && d.gross != null) lines = [{ label: 'Services', amount: num(d.gross), credit: false, detail: '', term: '', off: '' }];
  const sum = lines.reduce((t, l) => t + l.amount, 0);
  const total = d.amount == null || d.amount === '' || !isFinite(Number(d.amount)) ? sum : Number(d.amount);
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
    day.items.push({ id: r.id, kind, mine: kind === 'client' && !!meId && r.author_person === meId, name, time: pcTime(at), iso: at ? at.toISOString() : '', body: String(r.body == null ? '' : r.body), lead, msgKind: r.msg_kind || 'chat', meta: r.meta || null });
    prev = { kind, who, at };
  }
  return days;
}

/* ---- times for the kickoff and documents --------------------------- */

const PC_ZONE_ABBR = [
  ['ET', /^(America\/(New_York|Detroit|Indianapolis|Louisville|Kentucky\/.+|Indiana\/(?!Knox$|Tell_City$).+)|US\/(Eastern|Michigan)|EST5EDT|EST)$/],
  ['CT', /^(America\/(Chicago|Menominee|Indiana\/(Knox|Tell_City)|North_Dakota\/.+)|US\/Central|CST6CDT)$/],
  ['MT', /^(America\/(Denver|Boise|Phoenix)|US\/(Mountain|Arizona)|MST7MDT|MST)$/],
  ['PT', /^(America\/Los_Angeles|US\/Pacific|PST8PDT)$/],
  ['AKT', /^(America\/(Anchorage|Juneau|Sitka|Nome|Yakutat|Metlakatla)|US\/Alaska)$/],
  ['HT', /^(Pacific\/Honolulu|US\/Hawaii|HST)$/],
  ['UTC', /^(UTC|Etc\/UTC|GMT|Etc\/GMT|Z)$/],
];

/* The viewer's own zone, e.g. 'Asia/Colombo'. */
function pcViewerZone(){
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}

/* 'America/New_York' -> 'ET'; 'Asia/Colombo' -> 'Colombo time'. Same rule as the emails. */
function pcZoneAbbr(zone){
  const z = String(zone == null || zone === '' ? 'UTC' : zone).trim();
  for (const [abbr, re] of PC_ZONE_ABBR) if (re.test(z)) return abbr;
  return z.replace(/^.*\//, '').replace(/_/g, ' ') + ' time';
}

/* A moment, read in a zone: {key:'2026-11-27', day:'Fri, Nov 27', time:'10:00 AM'} or null. */
function pcWhenParts(v, zone){
  const d = pcToDate(v);
  if (!d) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: zone || pcViewerZone(), weekday: 'short', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  } catch (e) { return null; }
  const p = {};
  parts.forEach((x) => { p[x.type] = x.value; });
  const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  const key = p.year + '-' + ('0' + months[p.month]).slice(-2) + '-' + ('0' + p.day).slice(-2);
  return { key, day: p.weekday + ', ' + p.month + ' ' + p.day, time: p.hour + ':' + p.minute + ' ' + String(p.dayPeriod || '').toUpperCase() };
}

/* 'Fri, Nov 27 · 10:00 AM ET' — the same words the emails use. */
function pcWhen(v, zone){
  const z = zone || pcViewerZone();
  const w = pcWhenParts(v, z);
  return w ? w.day + ' · ' + w.time + ' ' + pcZoneAbbr(z) : '';
}

/* 'Fri, Nov 27 · 8:30 PM' with no zone name, for 'your time'. */
function pcLocalWhen(v, zone){
  const w = pcWhenParts(v, zone || pcViewerZone());
  return w ? w.day + ' · ' + w.time : '';
}

/* Free slots -> days in the viewer's own time, each slot with its ET time too.
   [{key, label:'Fri, Nov 27', slots:[{iso, time:'3:30 PM', other:'10:00 AM ET'}]}] */
function pcKickoffDays(slots, viewerZone, homeZone){
  const vz = viewerZone || pcViewerZone();
  const hz = homeZone || 'America/New_York';
  const same = pcZoneAbbr(vz) === pcZoneAbbr(hz);
  const days = [];
  const seen = {};
  (Array.isArray(slots) ? slots : [])
    .map((s) => s && pcToDate(s.starts_at))
    .filter(Boolean)
    .sort((a, b) => a - b)
    .forEach((d) => {
      const iso = d.toISOString();
      if (seen[iso]) return;
      seen[iso] = true;
      const w = pcWhenParts(d, vz);
      if (!w) return;
      let day = days[days.length - 1];
      if (!day || day.key !== w.key) { day = { key: w.key, label: w.day, slots: [] }; days.push(day); }
      const o = same ? null : pcWhenParts(d, hz);
      day.slots.push({ iso, time: w.time, other: o ? o.time + ' ' + pcZoneAbbr(hz) : '' });
    });
  return days;
}

/* Escape. The agreement's [bracketed] defaults are real terms (e.g. [5 business days]), so the client reads them as
   plain text. Only a true gap, [YOUR NAME] or [ALL CAPS], stays marked so it is noticed. */
function pcFillHtml(text){
  return pcEsc(text).replace(/\[([^\[\]]{1,400})\]/g, (m, t) => /^[A-Z][A-Z0-9 ._'-]*$/.test(t) ? '<mark class="pc-fill">[' + t + ']</mark>' : t);
}

/* Print without holding up the click that asked for it. */
function pcPrint(){
  if (typeof window === 'undefined' || typeof window.print !== 'function') return false;
  setTimeout(function(){ try { window.print(); } catch (e) { /* the browser said no */ } }, 60);
  return true;
}

/* Bank details a client may see: never an admin reminder in [brackets]. */
function pcPayDetails(pay){
  const p = pay || {};
  const wise = typeof p.wise_details === 'string' && p.wise_details.trim() && p.wise_details.trim().charAt(0) !== '[' ? p.wise_details : '';
  const link = pcSafeUrl(p.payoneer_link);
  const ready = p.ready === false ? false : !!(wise || link);
  return { ready, wise: ready ? wise : '', link: ready ? link : '' };
}

/* ---- how to pay ----------------------------------------------------
   The owner switches rails on in Settings; the database hands this file a list.
   Everything a rail needs is here, so turning one on needs no new code:

     bank_wire  an international USD wire: beneficiary, account, IBAN, bank, SWIFT/BIC,
                branch address, and the correspondent bank the sending bank routes through
     wise       a historic key. To a client, simply a second bank account, same fields
     payoneer   a payment-request link, or the receiving account details
     paypal     a paypal.me link, or the email a goods-and-services payment goes to
     card_link  a hosted checkout page (anything https)

   Several may be on at once. The preferred one is shown large; the rest read as "or", in the
   order above, so the wire leads and PayPal comes last.
   Nothing here is a real account: every value comes from Settings at read time. */
const PC_PAY_ORDER = ['bank_wire', 'wise', 'payoneer', 'card_link', 'paypal'];
/* The order a US bank's wire form asks for them, so a finance person reads straight down.
   These are the fields for a wire FROM a US company TO a bank abroad: there is no ABA on a
   Sri Lankan account, and the correspondent bank is the line that is both most often missing
   and most expensive to miss — without it the wire takes an extra hop and an extra cut. */
const PC_PAY_BANK_FIELDS = ['account_holder', 'beneficiary_address', 'account_number', 'iban',
  'bank_name', 'swift', 'bank_address', 'intermediary_bank', 'intermediary_swift', 'routing_number'];
const PC_PAY_FIELD_LABELS = {
  account_holder: 'Beneficiary name', beneficiary_address: 'Beneficiary address',
  account_number: 'Account number', iban: 'IBAN', bank_name: 'Beneficiary bank',
  swift: 'SWIFT / BIC', bank_address: 'Bank address',
  intermediary_bank: 'Correspondent bank', intermediary_swift: 'Correspondent SWIFT / BIC',
  routing_number: 'Routing number (ABA)', email: 'Email',
};
/* the ones a US finance person copies character for character */
const PC_PAY_MONO_FIELDS = { account_number: true, iban: true, swift: true, intermediary_swift: true, routing_number: true };
/* `wise` is a historic key, kept because older invoices and the wise_details setting use it.
   To a client it is simply a second bank account: Wise cannot be held in Sri Lanka at all. */
const PC_PAY_KINDS = {
  bank_wire: { label: 'Bank transfer', fields: PC_PAY_BANK_FIELDS,
    hint: 'An international USD wire. Your bank will charge its own fee for sending it — please send the full invoice amount so it arrives whole.' },
  wise: { label: 'Bank transfer (second account)', fields: PC_PAY_BANK_FIELDS,
    hint: 'An international USD wire. Your bank will charge its own fee for sending it — please send the full invoice amount so it arrives whole.' },
  payoneer: { label: 'Payoneer', action: 'Pay with Payoneer', fields: PC_PAY_BANK_FIELDS,
    hint: 'Payoneer. Open the link and pay by US bank debit or card — no Payoneer account needed. Or send to the account below.' },
  card_link: { label: 'Card or online checkout', action: 'Pay by card', fields: [],
    hint: 'Pay by card on a secure checkout page.' },
  paypal: { label: 'PayPal', action: 'Pay with PayPal', fields: ['email'],
    hint: 'PayPal. Send a goods-and-services payment to the email below — please do not mark it as a payment to a friend.' },
};

/* One rail, cleaned: only the fields the owner really filled in, never an admin
   reminder in [brackets], and a link only if it is a plain https one. */
function pcPayMethod(kind, fields, note, text){
  const def = PC_PAY_KINDS[String(kind || '')];
  if (!def) return null;
  const f = (fields && typeof fields === 'object') ? fields : {};
  const real = (v) => (typeof v === 'string' && v.trim() && v.trim().charAt(0) !== '[' ? v.trim() : '');
  const rows = def.fields.map((k) => {
    const v = real(f[k]);
    return v ? { key: k, label: PC_PAY_FIELD_LABELS[k] || k, value: v, mono: !!PC_PAY_MONO_FIELDS[k] } : null;
  }).filter(Boolean);
  const url = pcSafeUrl(f.link);
  const free = real(text);
  if (!rows.length && !url && !free) return null;   /* switched on, nothing filled in */
  return { kind: String(kind), label: def.label, hint: def.hint || '', action: def.action || 'Pay online',
    rows, url, free, note: real(note), reference: real(f.reference) };
}

/* The whole "how to pay" picture: {ready, preferred, others, currency, terms}.
   `pay.methods` is what Settings holds today; an invoice built before Settings had a
   list of rails still carries wise_details / payoneer_link, and those still work. */
function pcPayPlan(pay){
  const p = (pay && typeof pay === 'object') ? pay : {};
  const cur = String(p.currency || '').trim().toUpperCase();
  const terms = typeof p.terms === 'string' ? p.terms.trim() : '';
  const off = { ready: false, preferred: null, others: [], currency: cur, terms };
  if (p.ready === false) return off;
  const raw = Array.isArray(p.methods) ? p.methods : [];
  let list = raw.map((m) => {
    if (!m || typeof m !== 'object') return null;
    const f = (m.fields && typeof m.fields === 'object') ? m.fields : {};
    return pcPayMethod(m.kind, f, m.note || f.note, m.text || f.text);
  }).filter(Boolean);
  if (!list.length) {
    const legacy = pcPayDetails(p);
    list = [legacy.wise ? pcPayMethod('bank_wire', {}, '', legacy.wise) : null,
      legacy.link ? pcPayMethod('card_link', { link: legacy.link }, '', '') : null].filter(Boolean);
  }
  const seen = {};
  list = list.filter((m) => (seen[m.kind] ? false : (seen[m.kind] = true)));
  list.sort((a, b) => PC_PAY_ORDER.indexOf(a.kind) - PC_PAY_ORDER.indexOf(b.kind));
  if (!list.length) return off;
  const want = String(p.preferred || '');
  const first = list.find((m) => m.kind === want) || list[0];
  return { ready: true, preferred: first, others: list.filter((m) => m !== first), currency: cur, terms };
}

/* One rail as HTML. `big` is the preferred one: its values are set to select in one
   click (see .pc-pay-v in portal-client.css), so nothing has to be typed out by hand. */
function pcPayMethodHtml(m, big){
  if (!m) return '';
  const fields = m.rows.length
    ? `<dl class="pc-pay-fields">${m.rows.map((r) => `<div class="pc-pay-f${r.mono ? ' pc-pay-f-num' : ''}"><dt class="pc-tag">${pcEsc(r.label)}</dt><dd class="pc-pay-v${r.mono ? ' pc-pay-num' : ''}">${pcEsc(r.value)}</dd></div>`).join('')}</dl>`
    : '';
  const btn = m.url ? `<p class="pc-noprint"><a class="pc-btn${big ? '' : ' pc-btn-line'}" href="${pcEsc(m.url)}" target="_blank" rel="noopener noreferrer">${pcEsc(m.action)}</a></p>
      <p class="pc-pay-url pc-pay-v">${pcEsc(m.url)}</p>` : '';
  return `<p class="pc-pay-kind">${pcEsc(m.label)}</p>
    ${big && m.hint ? `<p class="pc-small pc-pay-hint">${pcEsc(m.hint)}</p>` : ''}
    ${big && m.rows.length ? '<p class="pc-small pc-noprint pc-pay-copy">Click or tap any value below and it selects whole, ready to copy.</p>' : ''}
    ${fields}
    ${m.free ? `<pre class="pc-pre pc-pay-v">${pcEsc(m.free)}</pre>` : ''}
    ${btn}
    ${m.note ? `<p class="pc-small pc-pay-note">${pcEsc(m.note)}</p>` : ''}`;
}

/* The block on an unpaid invoice. o = {amount, currency, due_on, number, terms}.
   With no rail configured it keeps today's honest sentence instead of inventing details. */
function pcPayHtml(plan, o){
  const p = plan || {};
  const q = o || {};
  if (!p.ready || !p.preferred) {
    return `<section class="pc-pay pc-pay-later" aria-labelledby="pcPayH">
      <h2 class="pc-tag" id="pcPayH">Payment details</h2>
      <p class="pc-pay-lede">We’ll send these to you directly. Reply to our email if you need them now.</p>
    </section>`;
  }
  const cur = String(q.currency || p.currency || '').trim().toUpperCase();
  const money = pcMoney(q.amount, cur);
  const due = pcDate(q.due_on);
  const num = typeof q.number === 'string' ? q.number.trim() : '';
  const terms = (typeof q.terms === 'string' ? q.terms.trim() : '') || p.terms || '';
  let lede = 'Pay' + (money ? ` <strong class="pc-pay-amt">${pcEsc(money)}${cur ? ' ' + pcEsc(cur) : ''}</strong>` : ' this invoice');
  lede += due ? ` by <strong>${pcEsc(due)}</strong>` : '';
  lede += terms && !due ? ` · ${pcEsc(terms)}` : '';
  lede += '.';
  /* the invoice number unless the owner told his bank to expect something else */
  const refText = p.preferred.reference || num;
  const ref = refText
    ? `<p class="pc-pay-ref"><span class="pc-tag">Reference to quote</span> <span class="pc-pay-v pc-pay-num">${pcEsc(refText)}</span></p>`
    : '';
  const alts = p.others.length
    ? `<div class="pc-pay-alts"><p class="pc-tag">Or pay this way instead</p>
      ${p.others.map((m) => `<div class="pc-pay-alt">${pcPayMethodHtml(m, false)}</div>`).join('')}</div>`
    : '';
  return `<section class="pc-pay" aria-labelledby="pcPayH">
    <h2 class="pc-tag" id="pcPayH">How to pay</h2>
    <p class="pc-pay-lede">${lede}</p>
    ${ref}
    <div class="pc-pay-main">${pcPayMethodHtml(p.preferred, true)}</div>
    ${alts}
    <p class="pc-small pc-pay-foot">Put the reference on the payment so it is matched to this invoice at once. Any question about it: reply to our email.</p>
  </section>`;
}

/* The block on a receipt: what was paid and how, never how to pay.
   The rail is only named when the database recorded one — a receipt never guesses. */
function pcPaidHtml(d, plan){
  const o = d || {};
  const when = pcDate(o.paid_at);
  const num = typeof o.number === 'string' ? o.number.trim() : '';
  const kind = String((o.pay && o.pay.paid_method) || o.paid_method || '');
  const def = PC_PAY_KINDS[kind];
  const how = def ? `<p class="pc-pay-kind">Paid by ${pcEsc(def.label)}</p>` : '';
  return `<section class="pc-pay pc-paidnote" aria-label="Payment received">
    <p class="pc-tag">Payment received</p>
    <p class="pc-pay-lede">Paid in full${when ? ' on ' + pcEsc(when) : ''}. Nothing more is owed on this invoice. Thank you.</p>
    ${how}
    ${num ? `<p class="pc-pay-ref"><span class="pc-tag">Reference</span> <span class="pc-pay-v pc-pay-num">${pcEsc(num)}</span></p>` : ''}
    <p class="pc-small pc-pay-foot">Keep this receipt for your records.</p>
  </section>`;
}

/* ---- HTML builders (everything escaped) ----------------------------- */

function pcLogoHtml(){
  return `<img class="pc-logo" src="${PC_LOGO}" width="44" height="44" alt="Aviance">`;
}

/* The mark and the wordmark beside it. The <img> carries the name for a screen
   reader, so the wordmark itself is decoration and is hidden from one. */
function pcMarkHtml(){
  return `<span class="pc-mark">${pcLogoHtml()}<span class="pc-wordmark" aria-hidden="true">Aviance</span></span>`;
}

/* The letterhead on every document: the mark on the left, what the document is
   on the right as an eyebrow, with its reference under it in mono. */
function pcLetterheadHtml(kind, ref){
  const r = String(ref == null ? '' : ref).trim();
  return `<header class="pc-dochead">${pcMarkHtml()}
    <div class="pc-dockind"><p class="pc-tag">${pcEsc(kind)}</p>${r ? `<p class="pc-docref">${pcEsc(r)}</p>` : ''}</div>
  </header>`;
}

/* The foot of every document: who it is from and which document it is. It
   prints, so a page that has been forwarded on paper still says both. */
function pcDocFootHtml(kind, ref){
  const r = String(ref == null ? '' : ref).trim();
  return `<footer class="pc-docend"><p class="pc-tag">Aviance · ${pcEsc(kind)}</p>${r ? `<p class="pc-docref">${pcEsc(r)}</p>` : ''}</footer>`;
}

function pcNoticeHtml(title, text, extra){
  return `<main class="pc-wrap pc-notice">${pcMarkHtml()}<h1 class="pc-h1" tabindex="-1">${pcEsc(title)}</h1><p class="pc-lede">${pcEsc(text)}</p>${extra || ''}</main>`;
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
  return list.map((p) => `<p>${pcFillHtml(p)}</p>`).join('');
}

const PC_PDF_NOTE = '<p class="pc-small pc-noprint pc-pdf-note">To download a PDF, press the button and choose “Save as PDF” as the printer.</p>';
function pcPrintHtml(){
  return `<p class="pc-noprint pc-docfoot"><button type="button" class="pc-btn pc-btn-line" data-pc-print>Print or save as PDF</button></p>${PC_PDF_NOTE}`;
}

/* The two signature lines: the client's (signed, or still to sign) opposite Aviance's. */
function pcSignaturesHtml(doc){
  const d = doc || {};
  const t = d.terms || {};
  const company = d.company || 'your company';
  const ours = (Array.isArray(t.signatures) ? t.signatures : []).filter((x) => x && typeof x === 'object');
  const a = ours[0] || { label: 'For Aviance', name: '[YOUR NAME]', role: 'Founder', org: 'Aviance' };
  const signed = d.status === 'signed';
  const dated = (v) => `<p class="pc-sig-date"><span class="pc-tag">Date</span><span class="pc-sig-dv">${v}</span></p>`;
  const theirs = signed
    ? `<p class="pc-signature">${pcEsc(d.signed_name)}</p><p class="pc-sig-who">${pcEsc(d.signed_name)}</p><p class="pc-sig-org">${pcEsc(company)}</p>${dated(pcEsc(pcDate(d.signed_at)) || '—')}`
    : `<p class="pc-signature pc-signature-empty" aria-hidden="true">&nbsp;</p><p class="pc-sig-who">Signs below</p><p class="pc-sig-org">${pcEsc(company)}</p>${dated('&nbsp;')}`;
  return `<section class="pc-sigs" aria-label="Signatures">
    <div class="pc-sig"><p class="pc-tag">For ${pcEsc(company)}</p>${theirs}</div>
    <div class="pc-sig"><p class="pc-tag">${pcEsc(a.label || 'For Aviance')}</p><p class="pc-signature pc-signature-ours">${pcFillHtml(a.name || '[YOUR NAME]')}</p><p class="pc-sig-who">${pcFillHtml(a.name || '[YOUR NAME]')}, ${pcEsc(a.role || 'Founder')}</p><p class="pc-sig-org">${pcEsc(a.org || 'Aviance')}</p>${dated(signed && d.signed_at ? pcEsc(pcDate(d.signed_at)) : '&nbsp;')}</div>
  </section>`;
}

function pcAgreementHtml(doc){
  const d = doc || {};
  const t = d.terms || {};
  const company = d.company || 'your company';
  const parties = (Array.isArray(t.parties) ? t.parties : [])
    .map((p) => `<div class="pc-party"><dt class="pc-tag">${pcEsc(p && p.label)}</dt><dd>${pcFillHtml(p && p.value)}</dd></div>`).join('');
  /* the guarantee is the clause the client is really buying: it gets the one
     warm block in the system, found by what it is called, not by its number */
  const sections = (Array.isArray(t.sections) ? t.sections : [])
    .map((s, i) => {
      const h = pcEsc(String((s && s.h) || '').replace(/^\s*\d+[.)]\s*/, ''));
      const warm = /guarantee/i.test(h) ? ' pc-sec-warm' : '';
      return `<section class="pc-sec${warm}"><h2><span class="pc-num">${i + 1}</span>${h}</h2>${pcParasHtml(s && s.body)}</section>`;
    }).join('');
  let foot;
  if (d.status === 'signed') {
    foot = `${pcSignaturesHtml(d)}<section class="pc-signed" id="pcSigned" tabindex="-1" aria-label="Signed">
      <p class="pc-tag pc-red">Signed</p>
      <p class="pc-signed-line">Signed by ${pcEsc(d.signed_name)} on ${pcEsc(pcDate(d.signed_at))}</p>
      ${pcPrintHtml()}
    </section>`;
  } else if (d.status === 'void') {
    foot = `<section class="pc-signed"><p class="pc-tag">Withdrawn</p><p class="pc-signed-line">This agreement has been withdrawn and can no longer be signed. Reply to our email if you were expecting to sign it.</p></section>`;
  } else {
    foot = `${pcSignaturesHtml(d)}<form class="pc-sign pc-noprint" id="pcSignForm" novalidate>
      <p class="pc-tag">Sign</p>
      <label class="pc-label" for="pcSignName">Type your full name to sign</label>
      <input class="pc-input pc-input-sign" id="pcSignName" name="name" type="text" autocomplete="name" maxlength="120" required aria-describedby="pcSignErr">
      <label class="pc-check" for="pcSignAgree"><input id="pcSignAgree" name="agree" type="checkbox" required><span>I have read this agreement and I am authorised to sign for ${pcEsc(company)}</span></label>
      <p class="pc-err" id="pcSignErr" role="alert" aria-live="assertive"></p>
      <button type="submit" class="pc-btn" id="pcSignBtn">Sign agreement</button>
      <p class="pc-small">Typing your name and pressing the button signs this agreement on behalf of ${pcEsc(company)}. We record the time and the device used.</p>
    </form>`;
  }
  const title = pcEsc(t.title || 'Service agreement');
  return `<main class="pc-wrap pc-doc pc-agreement">
    ${pcLetterheadHtml('Agreement', company)}
    <div class="pc-title">
      <h1 class="pc-h1" tabindex="-1">${title}</h1>
      ${t.intro ? `<p class="pc-lede">${pcFillHtml(t.intro)}</p>` : ''}
    </div>
    ${parties ? `<dl class="pc-parties">${parties}</dl>` : ''}
    <div class="pc-terms">${sections}</div>
    ${foot}
    ${pcDocFootHtml('Agreement', company)}
  </main>`;
}

/* 'Unpaid' | 'Paid' | 'Overdue' | 'Void' | 'Draft' — the database's word wins. */
function pcStatusWord(inv){
  const d = inv || {};
  if (typeof d.status_word === 'string' && d.status_word.trim()) return d.status_word.trim();
  return { paid: 'Paid', void: 'Void', draft: 'Draft', overdue: 'Overdue' }[d.status] || 'Unpaid';
}

/* One page, two documents. Unpaid it is an invoice: what is owed, by when, and
   how to pay. Once paid it is a receipt: what was paid and when, nothing to do. */
function pcInvoiceHtml(doc){
  const d = doc || {};
  const from = d.from || {};
  const to = d.bill_to || {};
  const cur = String(d.currency || 'USD').toUpperCase();
  const built = pcInvoiceLines(d);
  const paid = d.status === 'paid';
  const dead = d.status === 'void';
  const word = pcStatusWord(d);
  const plan = pcPayPlan(d.pay);   /* pcPayDetails still reads the two keys an older invoice carried */
  const kind = paid ? 'Receipt' : 'Invoice';
  const period = typeof d.period === 'string' ? d.period.trim() : '';
  /* the term on its own row and the saving on its own, each in mono, so a
     finance person reads what was bought and what it saved without parsing a
     sentence. `detail` is the same two halves joined, kept for anything else. */
  const rows = built.lines.map((l, i) => `<tr${l.credit ? ' class="pc-credit"' : ''}><td><span class="pc-line-t">${pcEsc(l.label)}</span>${l.term ? `<span class="pc-line-d pc-line-term">${pcEsc(l.term)}</span>` : ''}${l.off ? `<span class="pc-line-d pc-line-off">${pcEsc(l.off)}</span>` : ''}${!i && period ? `<span class="pc-line-d">${pcEsc(period)}</span>` : ''}</td><td class="pc-amt">${pcEsc(pcMoney(l.amount, cur))}</td></tr>`).join('');
  let stamp = '';
  if (paid) stamp = `<p class="pc-stamp pc-stamp-paid"><strong>Paid</strong>${d.paid_at ? `<span>${pcEsc(pcDate(d.paid_at))}</span>` : ''}</p>`;
  else if (word === 'Void' || word === 'Overdue' || word === 'Draft') stamp = `<p class="pc-stamp"><strong>${pcEsc(word)}</strong></p>`;
  /* the reference strip: every value mono, the due date marked so the eye
     finds it. A row is left out entirely rather than shown empty. */
  const meta = [
    ['Invoice no.', d.number, 'pc-meta-ref'],
    ['Issued', pcDate(d.issued_on), ''],
    [paid ? 'Paid on' : 'Due', paid ? pcDate(d.paid_at) : pcDate(d.due_on), paid || dead ? '' : 'pc-meta-due'],
    ['Status', paid ? '' : word, ''],   /* a receipt carries the red Paid stamp instead */
    ['Terms', paid || dead ? '' : d.terms, ''],
  ].filter((m) => m[1]).map((m) => `<div class="pc-meta-r${m[2] ? ' ' + m[2] : ''}"><dt class="pc-tag">${m[0]}</dt><dd>${pcEsc(m[1])}</dd></div>`).join('');
  /* until the owner fills in the company details, a client sees just 'Aviance' */
  const fromKeys = from.ready === false ? ['legal_name', 'email', 'phone'] : ['legal_name', 'address', 'email', 'phone'];
  const fromVals = Object.assign({}, from, from.ready === false ? { legal_name: 'Aviance' } : {});
  const addr = (o, keys) => keys.map((k) => o[k]).filter(Boolean).map((v, i) => `<p${i ? '' : ' class="pc-strong"'}>${pcFillHtml(v)}</p>`).join('');
  const fromHtml = addr(fromVals, fromKeys) || '<p class="pc-strong">Aviance</p>';
  const toHtml = addr(to, ['company', 'contact_name', 'contact_email']);
  /* the service line is only said twice when it adds something the table does not already say */
  const service = typeof d.service === 'string' && d.service.trim() && !built.lines.some((l) => l.label === d.service) ? d.service : '';
  let how = '';
  if (paid) {
    how = pcPaidHtml(d, plan);
  } else if (dead) {
    how = `<section class="pc-pay" aria-label="Cancelled">
      <p class="pc-tag">Cancelled</p>
      <p class="pc-pay-lede">This invoice has been cancelled. Nothing is owed on it.</p>
    </section>`;
  } else {
    how = pcPayHtml(plan, { amount: built.total, currency: cur, due_on: d.due_on, number: d.number, terms: d.terms });
  }
  const totalLabel = paid ? 'Total paid' : (dead ? 'Total' : 'Total due');
  const money = pcEsc(pcMoney(built.total, cur));
  const number = typeof d.number === 'string' ? d.number.trim() : '';
  return `<main class="pc-wrap pc-doc pc-invoice${paid ? ' pc-receipt' : ''}">
    ${pcLetterheadHtml(kind, number)}
    <div class="pc-invtop"><h1 class="pc-h1" tabindex="-1">${kind}</h1>${stamp}</div>
    <div class="pc-headline">
      <div class="pc-total"><p class="pc-tag">${totalLabel} · ${pcEsc(cur)}</p><p class="pc-total-n">${money}</p></div>
      <dl class="pc-meta">${meta}</dl>
    </div>
    <div class="pc-two">
      <div><p class="pc-tag">From</p>${fromHtml}</div>
      ${toHtml ? `<div><p class="pc-tag">${paid ? 'Received from' : 'Bill to'}</p>${toHtml}</div>` : ''}
    </div>
    ${service ? `<p class="pc-service"><span class="pc-tag">Service</span><span class="pc-service-t">${pcEsc(service)}</span></p>` : ''}
    <table class="pc-lines"><thead><tr><th scope="col" class="pc-tag">Description</th><th scope="col" class="pc-tag pc-amt">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th scope="row">${totalLabel} · ${pcEsc(cur)}</th><td class="pc-amt">${money}</td></tr></tfoot></table>
    ${how}
    ${dead ? '' : `<p class="pc-guarantee"><span class="pc-tag">Our guarantee</span> ${pcEsc(PC_GUARANTEE)}</p>`}
    ${pcPrintHtml()}
    ${pcDocFootHtml(kind, number)}
  </main>`;
}

/* The portal's top card: book the kickoff, or what was booked.
   k is what portal_kickoff_slots returned; ui = {viewerZone, day, pick, busy, error}. */
function pcKickoffHtml(k, ui){
  const s = k || {};
  const o = ui || {};
  const home = s.zone || 'America/New_York';
  const vz = o.viewerZone || pcViewerZone();
  if (s.booked && s.booked.starts_at) {
    const b = s.booked;
    const start = pcToDate(b.starts_at);
    const end = start ? new Date(start.getTime() + (Number(b.minutes) || 45) * 60000) : null;
    if (b.status === 'held' || (end && end < (pcToDate(o.now) || new Date()))) return '';
    const link = pcSafeUrl(b.meet_link);
    const local = pcZoneAbbr(vz) === pcZoneAbbr(home) ? '' : pcLocalWhen(b.starts_at, vz) + ' your time';
    return `<section class="pc-kick pc-kick-done" aria-label="Your kickoff">
      <div><p class="pc-tag pc-red">Kickoff booked</p>
      <p class="pc-kick-when">Kickoff: ${pcEsc(pcWhen(b.starts_at, home))}</p>
      ${local ? `<p class="pc-small">${pcEsc(local)}</p>` : ''}</div>
      ${link ? `<a class="pc-btn" href="${pcEsc(link)}" target="_blank" rel="noopener noreferrer">Join the call</a>` : ''}
    </section>`;
  }
  const days = pcKickoffDays(s.slots, vz, home);
  if (!days.length) {
    return `<section class="pc-kick" aria-labelledby="pcKickH"><h2 class="pc-kick-h" id="pcKickH">Book your kickoff</h2>
      <p class="pc-small">There are no free times in the next few days. Message us below and we’ll find one.</p></section>`;
  }
  const day = days.find((x) => x.key === o.day) || days[0];
  const pick = o.pick ? days.reduce((all, x) => all.concat(x.slots), []).find((x) => x.iso === o.pick) : null;
  const tabs = days.map((x) => `<button type="button" class="pc-day-btn" data-pc-day="${pcEsc(x.key)}" aria-pressed="${x.key === day.key ? 'true' : 'false'}">${pcEsc(x.label)}</button>`).join('');
  const times = day.slots.map((x) => `<button type="button" class="pc-slot" data-pc-slot="${pcEsc(x.iso)}" aria-pressed="${pick && pick.iso === x.iso ? 'true' : 'false'}">${pcEsc(x.time)}${x.other ? `<span>${pcEsc(x.other)}</span>` : ''}</button>`).join('');
  const sameZone = pcZoneAbbr(vz) === pcZoneAbbr(home);
  const confirm = pick ? `<div class="pc-kick-confirm" role="group" aria-label="Confirm your kickoff">
      <p><strong>Book ${pcEsc(pcWhen(pick.iso, home))}?</strong>${sameZone ? '' : ` <span class="pc-small">(${pcEsc(pcLocalWhen(pick.iso, vz))} your time)</span>`}</p>
      <button type="button" class="pc-btn" data-pc-book="${pcEsc(pick.iso)}"${o.busy ? ' disabled' : ''}>${o.busy ? 'Booking…' : 'Book it'}</button>
      <button type="button" class="pc-btn pc-btn-quiet" data-pc-unpick>Change</button>
    </div>` : '';
  return `<section class="pc-kick" aria-labelledby="pcKickH">
    <h2 class="pc-kick-h" id="pcKickH">Book your kickoff</h2>
    <p class="pc-small">45 minutes with the Aviance team to agree your ideal customer profile. Times are in your time${sameZone ? '' : ', with ' + pcEsc(pcZoneAbbr(home)) + ' beside them'}.</p>
    <div class="pc-days" role="group" aria-label="Day">${tabs}</div>
    <div class="pc-slots" role="group" aria-label="Time on ${pcEsc(day.label)}">${times}</div>
    ${confirm}
    <p class="pc-err" role="alert" aria-live="assertive">${pcEsc(o.error || '')}</p>
  </section>`;
}

function pcThreadHtml(days){
  const list = Array.isArray(days) ? days : [];
  if (!list.length) return '<p class="pc-empty">This is your direct line to the Aviance team. Say hello.</p>';
  return list.map((day) => `<div class="pc-day" role="separator"><span class="pc-tag">${pcEsc(day.label)}</span></div>` +
    day.items.map((m) => `<article class="pc-msg pc-msg-${m.kind === 'team' ? 'team' : 'client'}${m.mine ? ' pc-msg-mine' : ''}${m.lead ? ' pc-msg-lead' : ''}">
      ${m.lead ? `<p class="pc-msg-head"><span class="pc-msg-name">${pcEsc(m.name)}</span>${m.kind === 'team' ? '<span class="pc-tag pc-red">Aviance</span>' : ''}<time class="pc-msg-time" datetime="${pcEsc(m.iso)}">${pcEsc(m.time)}</time></p>` : ''}
      <p class="pc-msg-body">${pcEsc(m.body)}</p>${pcCardHtml(m)}
    </article>`).join('')).join('');
}
/* the extra part a journey message carries (time choices, an approval, a form) */
function pcCardHtml(m){
  const f = m && m.msgKind && m.msgKind !== 'chat' && PC.cards && PC.cards[m.msgKind];
  if (typeof f !== 'function') return '';
  try { return String(f(m) || ''); } catch (e) { return ''; }
}

/* ---- plumbing ------------------------------------------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const pcOk = coreOk;

/* What went wrong, in words a CLIENT can read and act on. This is the strictest
   edge in the system: the person on the other side of it is paying us, so they
   must never be shown a Postgres message, a table or column name, an error code,
   a stack, or the bare word "undefined". Our own database messages (a plpgsql
   `raise exception`, code P0001) are written for them and pass through; so do the
   sentences this file writes itself. Everything else becomes a sentence that says
   what failed and what to do next. */
const PC_WAIT = 'Something went wrong at our end. Nothing you have done has been lost. Please try again in a moment, or tell us in Chat.';
const PC_SIGNED_OUT = 'Your sign-in has run out. Please sign in again.';
function pcPlain(m, code){
  const s = String(m == null ? '' : m), c = String(code == null ? '' : code);
  if (!s.trim() || /^(undefined|null|\[object object\]|error)$/i.test(s.trim())) return PC_WAIT;
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed|timeout|timed out/i.test(s)) return PC_OFFLINE;
  if (c === 'PGRST301' || /jwt|not authenticated|invalid.*session|session.*expired|refresh token/i.test(s)) return PC_SIGNED_OUT;
  if (c === '42501' || /permission denied|row-level security|not authorized|unauthorized/i.test(s)) return PC_SIGNED_OUT;
  if (c === 'P0001') return s;                   /* written for the client already */
  /* anything that smells of the machine room: a code, a relation, a constraint, a
     stack, a bare HTTP status, or a sentence too long to be ours */
  if (/^\s*\d{3}\s*$|\bPGRST\d+|\b\d{5}\b|relation |column |constraint|duplicate key|violates|schema cache|does not exist|could not find the function|syntax error|pg_|select |insert |update |delete from|\n\s+at |function public\./i.test(s)) return PC_WAIT;
  if (s.length > 180) return PC_WAIT;
  return s;
}
function pcErr(e){
  const m = (e && (e.message || e.error_description || e.msg || e.error)) || (typeof e === 'string' ? e : '');
  const raw = String(m == null ? '' : m);
  const offline = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(raw);
  return { ok: false, data: null, error: offline ? PC_OFFLINE : pcPlain(raw, e && e.code), offline };
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

/* ---- data: the kickoff ---------------------------------------------- */

async function pcKickoff(days){
  const r = await pcRpc('portal', 'portal_kickoff_slots', { p_days: Number(days) > 0 ? Math.min(Number(days), 21) : 10 });
  if (r.ok && !(r.data && typeof r.data === 'object' && (Array.isArray(r.data.slots) || r.data.booked))) return pcErr('We could not load the free times. Please try again.');
  return r;
}
async function pcBookKickoff(iso){
  const d = pcToDate(iso);
  if (!d) return pcErr('Pick a time first.');
  const r = await pcRpc('portal', 'portal_book_kickoff', { p_start: d.toISOString() });
  if (r.ok && !(r.data && r.data.starts_at)) return pcErr('We could not confirm the booking. Refresh the page to check.');
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
  if (reason === 'expired') return 'This link has expired. Reply to our email and we\'ll send a fresh link.';
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
const PC_MSG_COLS = 'id,channel_id,author_user,author_person,body,created_at,msg_kind,meta';
const PC_MSG_COLS_OLD = 'id,channel_id,author_user,author_person,body,created_at';

/* Extension points for the journey files (portal-tracker.js, portal-schedule.js, portal-steps.js).
   PC.cards[msg_kind](item, home) -> extra HTML drawn under a message of that kind (escape everything).
   PC.actions[name](el, ctx)      -> a click on any [data-pc-act="name"] inside the page.
   PC.mounts.push(fn(ctx))        -> called when the chat opens and after every refresh.
   ctx = { home, sb, refresh(), rpc(name,args) } */
var PC = (typeof window !== 'undefined' && window.PC) || { cards: {}, actions: {}, mounts: [] };
if (typeof window !== 'undefined') window.PC = PC;
let pcMsgCols = PC_MSG_COLS;
async function pcMessages(channelId){
  const sb = pcClient('portal');
  if (!sb) return pcErr(PC_OFFLINE);
  if (!channelId) return pcErr('There is no channel to open.');
  try {
    /* Row level security already leaves removed messages out; asking again
       costs nothing. If the removed-marker is not ours to read, ask without it. */
    const ask = (live) => {
      let q = sb.from('channel_messages').select(pcMsgCols).eq('channel_id', channelId);
      if (live) q = q.is('deleted_at', null);
      return q.order('created_at', { ascending: false }).limit(PC_HISTORY);
    };
    let res = await ask(true);
    if (res && res.error && /msg_kind|meta/.test(String(res.error.message || ''))) { pcMsgCols = PC_MSG_COLS_OLD; res = await ask(true); }
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
