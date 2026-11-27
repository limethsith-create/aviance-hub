/* ===================== AVIANCE OS — Pipeline (our own sales pipeline) =====================
   The data behind every sales call booked from the website: the booking itself, the
   research we did on it before the call, and whether we won or lost. Supabase only: no
   other server, nothing to call out to.

   There is no Bookings screen any more. Every booking is drawn on the Calendar
   (meetings.js), and clicking one opens a panel there. This file is what that panel
   stands on: it reads the booking, lays out the brief, draws the outcome buttons and
   writes the outcome. The one screen left in here is the Funnel, opened from the
   Calendar's toolbar.

   Tables (SCHEMA.md "Already there, untouched" + the money tables):
     discovery_bookings   what they filled in on the website, the booked call, the score
     research_briefs      one row per booking, `brief` jsonb  — WRITTEN BY THE RESEARCH ENGINE
     research_log         what the research engine did, newest last
     plan_prices          the only place a price ever comes from
     clients              where a won booking lands

   Won goes through the database: plCloseWon calls the `close_won` rule, which makes the
   client, their channel, the agreement and the first invoice, and queues the email that
   carries both. The panel's Won button opens a small plan picker first.

   The research engine stays. Nothing here writes to research_briefs or research_log; we
   read what it produced and lay it out. A brief is someone else's jsonb, so every
   renderer here copes with a shape it did not expect.

   Every function returns {ok, data, error} and never throws (the plumbing is finance.js's).
   `error` is plain words, safe to show a person. Every screen draws with zero rows.
   ================================================================================= */

/* A booking's status: the pill colour and the words for it. */
const PL_STATUS_WORDS = {
  new: ['blue', 'Call booked'], booked: ['blue', 'Call booked'], brief_sent: ['blue', 'Call booked'],
  cancelled: ['grey', 'Cancelled'], held: ['amber', 'Call done'], no_show: ['red', 'No-show'],
  contacted: ['amber', 'Following up'], agreement_sent: ['amber', 'Agreement sent'],
  won: ['green', 'Won'], lost: ['grey', 'Lost'],
};
/* Finished, one way or another. Everything else is still in play.
   The website writes 'booked' and the research engine moves it on to words of
   its own ('brief_sent', ...), so a booking is open unless it is one of these —
   a fixed list of open words once hid every real booking. */
const PL_CLOSED = ['won', 'lost', 'cancelled'];
/* A call we can honestly say was held. */
const PL_HELD = ['held', 'contacted', 'agreement_sent', 'won', 'lost'];
/* Why we lost — the only answers accepted. */
const PL_LOSS_REASONS = ['price', 'timing', 'no_budget', 'went_elsewhere', 'not_a_fit', 'no_show', 'ghosted', 'other'];
const PL_LOSS_WORDS = {
  price: 'Too expensive', timing: 'Wrong time', no_budget: 'No budget',
  went_elsewhere: 'Went somewhere else', not_a_fit: 'Not a fit for us',
  no_show: 'Never came to the call', ghosted: 'Went quiet', other: 'Something else',
};
/* A loss that means the call never happened: it must not flatter the show rate. */
const PL_NEVER_HELD = ['no_show', 'ghosted'];
/* How long a brief may be "running" before we stop calling it that. */
const PL_RUNNING_MS = 30 * 60000;
/* How long after its start a call may sit with nothing recorded about it before
   the hub starts asking. ONE copy of this number: meetings.js's MT_GRACE_MIN is
   an alias of it (pipeline.js loads first). It used to be written down twice,
   as 20 here and 20 there, and the two answer the same question — "has this
   call been and gone long enough to need an outcome?" — for the booking panel
   and for the Calendar's badge. Drifting apart means a call the badge counts
   and the panel does not, or the other way round. */
const PL_GRACE_MIN = 20;
const PL_BRIEF_DEPTH = 3;

/* The plans a sale may be put on: the three on offer (FN_PLANS, finance.js). A plan
   code left on an old row is refused by plCloseWon and read as "Retired plan". */
const PL_PLANS = FN_PLANS;

const pl = { one: null, oneId: null, oneErr: null, funnel: null, funnelErr: null, days: 30, winning: false };

/* ---- plumbing (finance.js) ---------------------------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const plOk = coreOk;
const plErr = coreErr;
const plWrap = coreWrap;
async function plRun(fn, whenEmpty) {
  try { return plWrap(await fn(), whenEmpty); } catch (e) { return plErr(e); }
}

/* ---- small helpers ------------------------------------------------ */

/* A value safe inside onclick="…" as a JavaScript string, from core.js. */
const plAttr = coreAttr;
function plDate(v) { if (!v) return null; if (v instanceof Date) return isNaN(v) ? null : v; const d = new Date(String(v)); return isNaN(d) ? null : d; }
function plMs(v) { const d = plDate(v); return d ? d.getTime() : 0; }
function plWhen(v) {
  const d = plDate(v); if (!d) return '';
  try { return new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d); }
  catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
}
function plRel(v, now) {
  const d = plDate(v); if (!d) return '';
  const diff = ((now || new Date()) - d) / 1000, a = Math.abs(diff);
  const n = a < 90 ? '1 min' : a < 3600 ? Math.round(a / 60) + ' min' : a < 36 * 3600 ? Math.round(a / 3600) + ' h' : Math.round(a / 86400) + (Math.round(a / 86400) === 1 ? ' day' : ' days');
  return diff >= 0 ? n + ' ago' : 'in ' + n;
}
function plStatusPill(s) { const m = PL_STATUS_WORDS[s] || ['grey', String(s || '—')]; return `<span class="pill ${m[0]}">${esc(m[1])}</span>`; }
function plLossWord(r) { return PL_LOSS_WORDS[r] || String(r || ''); }
function plIsOpen(b) { return Boolean(b) && !PL_CLOSED.includes(String(b.status)); }
function plWho(b) { return String((b && (b.company || b.name)) || 'Someone'); }
/* 0–100 if that is what it is; '' when the research engine has not scored them. */
function plScore(b) { const n = Number(b && b.score); return Number.isFinite(n) ? n : ''; }
function plPct(part, whole) { const w = Number(whole) || 0; if (!w) return 0; return Math.round((Number(part) || 0) * 1000 / w) / 10; }
function plSafeUrl(u) {
  let s = String(u == null ? '' : u).trim(); if (!s) return '';
  if (!/^https?:\/\//i.test(s)) { if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return ''; s = 'https://' + s; }
  try { const p = new URL(s); return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : ''; } catch (e) { return ''; }
}

/* ---- reading every row, not just the first page --------------------
   A query with no range in it is answered out of ONE page, and that page has a
   ceiling this code cannot see. Today there are five bookings, so every count
   below is right. At a thousand it would quietly stop being right: the funnel
   would report fewer enquiries than came in, the show rate and the win rate
   worked out from them would both be wrong, and nothing on the screen would
   hint at it. A number that is wrong and looks right is worse than no number.

   So the reads that COUNT ask page by page until a short page comes back.
   `build(from, to)` is handed the page's bounds and returns the query; it must
   order by something unique, or a row can be read twice or skipped. */
const PL_PAGE = 1000;
const PL_MAX_PAGES = 50;        /* 50,000 rows. Past that a screen is the wrong tool, not a bigger page. */
async function plPages(build) {
  const all = [];
  for (let page = 0; page < PL_MAX_PAGES; page++) {
    const from = page * PL_PAGE;
    const got = await plRun(() => build(from, from + PL_PAGE - 1), []);
    if (!got.ok) return got;
    const rows = Array.isArray(got.data) ? got.data : [];
    for (const row of rows) all.push(row);
    if (rows.length < PL_PAGE) return plOk(all);
  }
  return plOk(all);
}
/* How many ids go into one `in(...)`. A uuid is 36 characters and each one is
   comma-separated inside the URL, so a thousand of them is a 40 KB request line
   and the server answers 414 rather than the list. */
const PL_IN_CHUNK = 150;
/* The five columns the funnel counts. `discovery_bookings` has over thirty, and
   the funnel needs none of the rest to add up. */
const PL_FUNNEL_COLS = 'id,status,lost_reason,call_at,created_at';

/* ---- the bookings ------------------------------------------------- */

/* The bookings: soonest call first, each with its score and whether a brief exists.
   {status} is one stage, 'open' for everything still in play, or nothing for all.
   {from, to} keeps only the calls starting in that span — what the Calendar asks for. */
async function plBookings(opts) {
  const o = opts || {};
  const got = await plPages((from, to) => {
    let q = sb.from('discovery_bookings').select('*');
    if (o.status && o.status !== 'all' && o.status !== 'open') q = q.eq('status', o.status);
    if (o.from) q = q.gte('call_at', o.from);
    if (o.to) q = q.lt('call_at', o.to);
    /* ordered by id, which is unique, so paging cannot read a row twice or miss
       one. The list is sorted by call time below, where it is wanted. */
    return q.order('id', { ascending: true }).range(from, to);
  });
  if (!got.ok) return got;
  let rows = Array.isArray(got.data) ? got.data.filter((r) => r && r.id != null) : [];
  if (o.status === 'open') rows = rows.filter(plIsOpen);
  if (!rows.length) return plOk([]);

  /* which of them the research engine has already written a brief for. Asked a
     chunk of ids at a time: one `in(...)` of every booking's id is a request
     line long enough for the server to refuse the whole thing. A chunk that
     fails leaves its bookings reading "no brief yet", which is what they read
     before this lookup existed. */
  const have = {};
  for (let i = 0; i < rows.length; i += PL_IN_CHUNK) {
    const ids = rows.slice(i, i + PL_IN_CHUNK).map((r) => r.id);
    const briefs = await plRun(() => sb.from('research_briefs').select('booking_id')
      .in('booking_id', ids), []);
    if (briefs.ok) (briefs.data || []).forEach((r) => { if (r && r.booking_id != null) have[String(r.booking_id)] = true; });
  }

  return plOk(rows.map((r) => Object.assign({}, r, {
    score: plScore(r),
    has_brief: Boolean(have[String(r.id)]),
    /* when the brief is missing we only know that much from this list */
    research_state: have[String(r.id)] ? 'done' : 'unknown',
  })).sort((a, b) => {
    const x = plMs(a.call_at), y = plMs(b.call_at);
    if (x && y) return x - y;
    if (x) return -1; if (y) return 1;
    return plMs(b.created_at) - plMs(a.created_at);
  }));
}

/* One booking with everything known about it: their answers, the score, the brief laid
   out readably, where the research stands, and the client if they became one. */
async function plBooking(id) {
  if (!id) return plErr('No booking was asked for.');
  const got = await plRun(() => sb.from('discovery_bookings').select('*').eq('id', id).maybeSingle(), null);
  if (!got.ok) return got;
  if (!got.data) return plErr('That booking is not here any more.');
  const b = got.data;

  /* The brief, the research log, the client and the price list do not depend on
     one another, so they are asked for together: this screen used to wait for
     six round trips end to end, which on a slow connection is most of a second
     of nothing. The brief is read ONCE and handed to plResearchState, which
     used to read it a second time by itself. */
  const [brief, log, client, prices] = await Promise.all([
    plBrief(id),
    plResearchLog(id, 20),
    plRun(() => sb.from('clients').select('*').eq('booking_id', id).limit(1), []),
    plRun(() => sb.from('plan_prices').select('*'), []),
  ]);
  const state = plResearchFrom(brief, log);
  const theClient = client.ok && Array.isArray(client.data) && client.data.length ? client.data[0] : null;
  /* their first invoice once they are a client. Only an admin can read invoices, so
     anyone else simply sees no invoice line. */
  let invoice = null;
  if (theClient && theClient.id != null) {
    const inv = await plRun(() => sb.from('invoices').select('*').eq('client_id', theClient.id).order('created_at', { ascending: true }).limit(1), []);
    if (inv.ok && Array.isArray(inv.data) && inv.data.length) invoice = inv.data[0];
  }

  return plOk({
    booking: b,
    score: plScore(b),
    answers: plAnswers(b),
    brief: brief.ok ? brief.data : null,
    briefError: brief.ok ? '' : brief.error,
    sections: plBriefSections(brief.ok ? brief.data : null),
    research: state.ok ? state.data : { state: 'unknown', since: null, note: state.error },
    client: theClient,
    prices: prices.ok && Array.isArray(prices.data) ? prices.data.filter(Boolean) : [],
    invoice,
  });
}

/* What they filled in on the website, in the order it is worth reading. */
function plAnswers(b) {
  b = b || {};
  const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : v);
  return [
    ['Name', b.name], ['Email', b.email], ['Phone', b.phone], ['Their role', b.role], ['Company', b.company],
    ['Website', b.website], ['Where they are', [b.city, plCountry(b.country)].filter(Boolean).join(', ')],
    ['Industry', b.industry], ['What they sell', b.sells], ['Deal size', b.budget],
    ['How they win customers today', b.current_lead_gen], ['Capacity for new calls', b.capacity],
    ['Tried outbound before', yesNo(b.tried_outbound)],
    ['Can they decide', yesNo(b.decision_maker)],
    ['What they want', b.goal], ['When they want it', b.timeline], ['Came from', b.source],
  ].filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => ({ label: k, value: String(v) }));
}

/* "us" → "US": a country code is written in capitals; a country's name is left as it is. */
function plCountry(c) {
  const s = String(c == null ? '' : c).trim();
  return /^[a-z]{2,3}$/i.test(s) ? s.toUpperCase() : s;
}

/* ---- the research engine's work (read only) ----------------------- */

/* The brief the research engine wrote for this booking, or null when there isn't one. */
async function plBrief(bookingId) {
  if (!bookingId) return plErr('No booking was asked for.');
  const got = await plRun(() => sb.from('research_briefs').select('*')
    .eq('booking_id', bookingId).maybeSingle(), null);
  if (!got.ok) return got;
  return plOk(got.data || null);
}

/* What the research engine did, newest first. */
async function plResearchLog(bookingId, limit) {
  if (!bookingId) return plErr('No booking was asked for.');
  return plRun(() => sb.from('research_log').select('*').eq('booking_id', bookingId)
    .order('at', { ascending: false }).limit(Number(limit) > 0 ? Number(limit) : 20), []);
}

/* Any words we can find in a log row, whatever shape the event is. */
function plLogWords(row) {
  const e = row && row.event;
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (typeof e !== 'object') return String(e);
  const bits = [];
  ['event', 'type', 'status', 'state', 'name', 'step', 'stage', 'message', 'error', 'detail'].forEach((k) => {
    const v = e[k];
    if (typeof v === 'string' || typeof v === 'number') bits.push(String(v));
    else if (v && typeof v === 'object') bits.push(plLogWords({ event: v }));
  });
  if (!bits.length) { try { bits.push(JSON.stringify(e)); } catch (x) { /* circular */ } }
  return bits.join(' ');
}
/* none · running · done · failed — worked out from research_briefs and research_log. */
async function plResearchState(bookingId) {
  const [brief, log] = await Promise.all([plBrief(bookingId), plResearchLog(bookingId, 20)]);
  return plResearchFrom(brief, log);
}

/* The same answer, worked out from a brief and a log already in hand. PURE, so a
   screen that has read them for another reason does not read them again. */
function plResearchFrom(brief, log) {
  if (!brief || !brief.ok) return brief || plErr('The research could not be read.');
  const rows = log && log.ok && Array.isArray(log.data) ? log.data.slice().sort((a, b) => plMs(b && b.at) - plMs(a && a.at)) : [];
  const latest = rows[0] || null;

  if (brief.data) return plOk({ state: 'done', since: brief.data.updated_at || (latest && latest.at) || null, writer: brief.data.writer || '', log: rows });

  for (let i = 0; i < rows.length; i++) {
    const w = plLogWords(rows[i]).toLowerCase();
    if (/fail|error|crash|gave up|timed out|timeout/.test(w)) return plOk({ state: 'failed', since: rows[i].at || null, log: rows });
    if (/start|running|queued|working|began|begin|researching/.test(w)) {
      const stale = plMs(rows[i].at) && Date.now() - plMs(rows[i].at) > PL_RUNNING_MS;
      return plOk({ state: stale ? 'failed' : 'running', since: rows[i].at || null, stale, log: rows });
    }
  }
  return plOk({ state: 'none', since: null, log: rows });
}

/* ---- the brief, laid out readably -------------------------------- */

/* The brief jsonb was written by something else, so take nothing on trust: turn whatever
   is there into [{title, lines:[{label, value}], text}] and never throw. */
function plBriefSections(briefRow, depth) {
  const raw = briefRow && typeof briefRow === 'object' && 'brief' in briefRow ? briefRow.brief : briefRow;
  if (raw == null) return [];
  if (typeof raw === 'string') return raw.trim() ? [{ title: '', text: raw.trim(), lines: [] }] : [];
  if (typeof raw !== 'object') return [{ title: '', text: String(raw), lines: [] }];

  const max = Number.isFinite(depth) ? depth : PL_BRIEF_DEPTH;
  const out = [];
  const entries = Array.isArray(raw) ? raw.map((v, i) => ['Point ' + (i + 1), v]) : Object.keys(raw).map((k) => [k, raw[k]]);
  entries.forEach(([key, value]) => {
    const title = plTitle(key);
    if (plEmpty(value) || String(key).charAt(0) === '_') return;
    if (typeof value !== 'object') { out.push({ title: '', lines: [{ label: title, value: plFlat(value, max) }], text: '' }); return; }
    if (Array.isArray(value)) {
      const simple = value.every((v) => v == null || typeof v !== 'object');
      if (simple) { out.push({ title, lines: value.filter((v) => !plEmpty(v)).map((v) => ({ label: '', value: String(v) })), text: '' }); return; }
      out.push({ title, lines: value.filter((v) => !plEmpty(v)).map((v, i) => ({ label: typeof v === 'object' && v && (v.title || v.label || v.name) ? String(v.title || v.label || v.name) : String(i + 1), value: plFlat(v, max - 1) })).filter((l) => l.value !== ''), text: '' });
      return;
    }
    const keys = Object.keys(value);
    out.push({ title, lines: keys.filter((k) => !plEmpty(value[k])).map((k) => ({ label: plTitle(k), value: plFlat(value[k], max - 1) })).filter((l) => l.value !== ''), text: '' });
  });
  /* a heading with nothing under it is not drawn */
  for (let i = out.length - 1; i >= 0; i--) if (!out[i].text && !out[i].lines.length) out.splice(i, 1);
  /* loose one-liners are nicer as one block */
  const loose = out.filter((s) => !s.title && s.lines.length === 1 && !s.text);
  if (loose.length > 1) {
    const rest = out.filter((s) => loose.indexOf(s) < 0);
    return [{ title: 'In short', lines: loose.map((s) => s.lines[0]), text: '' }].concat(rest);
  }
  return out;
}
/* Says nothing: missing, blank, an empty list or an empty object. */
function plEmpty(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.every(plEmpty);
  if (typeof v === 'object') return Object.keys(v).every((k) => plEmpty(v[k]));
  return false;
}
/* "icp_notes" / "icpNotes" -> "Icp notes" */
function plTitle(k) {
  const s = String(k == null ? '' : k).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
/* Anything at all -> one readable line. Depth-limited, so a deep or odd brief is safe. */
function plFlat(v, depth) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v !== 'object') return String(v);
  if (!Number.isFinite(depth) || depth <= 0) { try { return JSON.stringify(v).slice(0, 400); } catch (e) { return 'Something we could not read'; } }
  if (Array.isArray(v)) return v.map((x) => plFlat(x, depth - 1)).filter((s) => s !== '').join(' · ');
  const keys = Object.keys(v);
  if (!keys.length) return '';
  return keys.map((k) => { const s = plFlat(v[k], depth - 1); return s === '' ? '' : plTitle(k) + ': ' + s; }).filter(Boolean).join(' · ');
}

/* "Research this one". The research engine is triggered outside the hub today. */
function plResearchNow(bookingId) {
  // TODO: trigger the research engine for this booking. It writes research_briefs /
  // research_log itself; the hub only reads them. Until there is a way to ask it from
  // here (a Supabase function it listens on, or a row it picks up), this button only
  // says so — it must never write a brief itself.
  if (typeof toast === 'function') toast('Noted. The research engine is still started outside Aviance OS, so ask it there.');
  return plOk({ bookingId: bookingId == null ? '' : String(bookingId), triggered: false });
}

/* ---- the outcome: won --------------------------------------------- */

/* Won, the whole way: one database rule makes the client, their channel, the agreement
   and the first invoice, and queues the email with both links in it. Its refusals are
   already plain words ('That call is already a client.'), so they are passed on as they are.
   -> {client_id, invoice_id, agreement_id, invoice_number} */
async function plCloseWon(bookingId, plan, term) {
  if (!bookingId) return plErr('No booking was asked for.');
  const p = String(plan || '');
  if (!p) return plErr('Pick the plan they bought first.');
  /* a plan code from before the three plans: refused in words, never mapped to another */
  if (fnPlanRetired(p)) return plErr(FN_RETIRED_SAYS);
  if (!PL_PLANS.includes(p)) return plErr('That plan is not in the price list.');
  const t = term === '3month' ? '3month' : 'monthly';
  return plRun(() => sb.rpc('close_won', { p_booking: bookingId, p_plan: p, p_term: t }), null);
}

/* ---- the outcome: lost, held, and nobody came -------------------- */

function plIsLossReason(r) { return PL_LOSS_REASONS.includes(String(r || '')); }

/* Lost, with a reason from the short list. Anything else is turned down, so the funnel
   keeps meaning something. */
async function plLost(bookingId, reason) {
  if (!bookingId) return plErr('No booking was asked for.');
  if (!plIsLossReason(reason)) {
    return plErr('Pick why we lost them: ' + PL_LOSS_REASONS.map((r) => plLossWord(r).toLowerCase()).join(', ') + '.');
  }
  return plRun(() => sb.from('discovery_bookings').update({
    status: 'lost', lost_reason: String(reason), lost_at: new Date().toISOString(),
  }).eq('id', bookingId).select().single(), null);
}

/* The call happened. Whether we won it is a separate answer (plCloseWon / plLost). */
async function plHeld(bookingId) {
  if (!bookingId) return plErr('No booking was asked for.');
  return plRun(() => sb.from('discovery_bookings').update({ status: 'held' })
    .eq('id', bookingId).select().single(), null);
}

/* A discovery call nobody turned up to. */
async function plNoShow(bookingId) {
  if (!bookingId) return plErr('No booking was asked for.');
  return plRun(() => sb.from('discovery_bookings').update({ status: 'no_show' })
    .eq('id', bookingId).select().single(), null);
}

/* ---- the funnel --------------------------------------------------- */

/* Counted from the rows themselves, every time. Nothing here reads a stored total. */
async function plFunnel(range) {
  const r = range || {};
  const got = await plPages((from, to) => {
    let q = sb.from('discovery_bookings').select(PL_FUNNEL_COLS);
    if (r.from) q = q.gte('created_at', r.from);
    if (r.to) q = q.lte('created_at', r.to);
    return q.order('id', { ascending: true }).range(from, to);
  });
  if (!got.ok) return got;
  const rows = (Array.isArray(got.data) ? got.data : []).filter(Boolean);

  const enquiries = rows.length;
  const booked = rows.filter((b) => b.call_at).length;
  const held = rows.filter((b) => b.call_at && PL_HELD.includes(String(b.status))
    && !(String(b.status) === 'lost' && PL_NEVER_HELD.includes(String(b.lost_reason)))).length;
  const noShows = rows.filter((b) => String(b.status) === 'no_show'
    || (String(b.status) === 'lost' && PL_NEVER_HELD.includes(String(b.lost_reason)))).length;
  const won = rows.filter((b) => String(b.status) === 'won').length;
  const lost = rows.filter((b) => String(b.status) === 'lost').length;
  const open = rows.filter(plIsOpen).length;
  const decided = won + lost;

  const reasons = {};
  rows.forEach((b) => {
    if (String(b.status) !== 'lost') return;
    const k = plIsLossReason(b.lost_reason) ? String(b.lost_reason) : 'other';
    reasons[k] = (reasons[k] || 0) + 1;
  });

  return plOk({
    from: r.from || null, to: r.to || null,
    enquiries, booked, held, no_shows: noShows, won, lost, open, decided,
    show_rate: plPct(held, booked),      /* of the calls booked, how many were held */
    win_rate: plPct(won, decided),       /* of the ones that were decided, how many we won */
    reasons,
  });
}

/* The last N days, so a screen does not have to work out dates. */
function plRangeDays(days, now) {
  const to = now ? new Date(now) : new Date();
  const n = Number(days) > 0 ? Number(days) : 30;
  const from = new Date(to.getTime() - n * 86400000);
  return { from: from.toISOString(), to: to.toISOString(), days: n };
}

/* ---- what the Calendar asks about a booking ---------------------- */

/* "growth" → "Growth"; a plan code no longer on offer → "Retired plan" (finance.js). */
function plPlanWord(p) { return fnPlanWord(p); }
/* A booking whose call has been and gone with nothing recorded about it. It is "open"
   by plIsOpen — never by a list of open words, which once hid every real booking — and
   nobody has yet said the call was held or that no one came. */
function plNeedsOutcome(b, now) {
  const t = plMs(b && b.call_at); if (!t || !plIsOpen(b)) return false;
  const s = String(b.status);
  if (PL_HELD.includes(s) || s === 'no_show') return false;
  return (now || new Date()).getTime() - t > PL_GRACE_MIN * 60000;
}

/* ---- one booking, laid out (the Calendar's panel draws this) ------ */

function renderPlBrief(sections, state, bookingId) {
  const st = (state && state.state) || 'none';
  if (st !== 'done' || !sections || !sections.length) {
    const words = {
      none: ['No brief yet', 'The research engine has not looked at this one. You can read their answers below and run it when you want.'],
      running: ['Research is running', 'The research engine is working on this one. The brief shows up here when it is written.'],
      failed: ['The research did not finish', 'The research engine started and did not get there. You can ask it to try again.'],
      done: ['The brief is empty', 'The research engine wrote a brief with nothing in it.'],
      unknown: ['No brief to show', "We could not tell where the research got to."],
    }[st] || ['No brief yet', 'Nothing from the research engine on this one.'];
    return `<div class="card pl-pad pl-nobrief"><b>${esc(words[0])}</b><p class="muted">${esc(words[1])}</p>
      ${state && state.since ? `<p class="muted pl-small">Last heard ${esc(plWhen(state.since))}</p>` : ''}
      <div class="pl-acts"><button class="btn ghost" onclick="plResearchNow(${plAttr(bookingId)})">Research this one</button></div></div>`;
  }
  return `<div class="card pl-pad pl-brief">${sections.map((s) => `<div class="pl-brief-sec">
    ${s.title ? `<h4>${esc(s.title)}</h4>` : ''}
    ${s.text ? `<p class="pl-pre">${esc(s.text)}</p>` : ''}
    ${s.lines && s.lines.length ? `<div class="pl-kv">${s.lines.map((l) => (l.label
      ? `<small>${esc(l.label)}</small><span>${esc(l.value)}</span>`
      : `<small aria-hidden="true">·</small><span>${esc(l.value)}</span>`)).join('')}</div>` : ''}
  </div>`).join('')}</div>`;
}

/* The outcome buttons, or what was decided. Every button here writes through the data
   functions above; nothing is written from the Calendar itself. */
function renderPlOutcome(d) {
  const b = d.booking, id = b.id, s = String(b.status);
  if (d.client) {
    const c = d.client, inv = d.invoice;
    /* an old client on a plan no longer on offer: said so, with none of its old terms */
    const on = fnPlanRetired(c.plan)
      ? 'a retired plan'
      : (plPlanWord(c.plan) || 'a plan') + (String(c.term) === '3month' ? ' · 3 months' : '') + ', ' + String(c.calls_promised || 0) + ' calls a month';
    return `<div class="card pl-pad pl-outcome"><b>Won — they are a client</b><p class="muted">${esc(c.company || '')} is on ${esc(on)}. This booking cannot make a second client.</p>
      ${inv ? `<p class="pl-small">${esc('Invoice ' + (inv.number || '') + ' · ' + plUsd(inv.amount) + ' ' + plInvoiceWord(inv))}</p>` : ''}
      <div class="pl-acts"><button type="button" class="btn" onclick="plOpenClient(${plAttr(c.id)})">Open client →</button></div></div>`;
  }
  if (s === 'won') {
    return `<div class="card pl-pad pl-outcome"><b>Won</b><p class="muted">This call is already marked won, so there is nothing more to record here.</p></div>`;
  }
  if (s === 'lost') {
    return `<div class="card pl-pad pl-outcome"><b>Lost</b><p class="muted">${esc(b.lost_reason ? plLossWord(b.lost_reason) : 'No reason was recorded.')}</p></div>`;
  }
  if (s === 'cancelled') {
    return `<div class="card pl-pad pl-outcome"><b>Cancelled</b><p class="muted">This call was cancelled, so there is nothing to record.</p></div>`;
  }
  const picked = PL_PLANS.includes(String(b.plan)) ? String(b.plan) : '';
  const said = s === 'held' ? 'The call is marked as done. Did they buy?'
    : s === 'no_show' ? 'Marked as nobody came. If that was the end of it, mark it lost below.' : '';
  return `<div class="card pl-pad pl-outcome"><b>How did it go?</b>
    ${said ? `<p class="muted">${esc(said)}</p>` : ''}
    <div class="pl-acts">${s === 'held' ? '' : `<button class="btn ghost" onclick="plMarkHeld(${plAttr(id)})">Call done</button>`}
      ${s === 'no_show' ? '' : `<button class="btn ghost" onclick="plMarkNoShow(${plAttr(id)})">Nobody came</button>`}</div>
    <div class="pl-acts"><button class="btn" onclick="plOpenWon()" aria-controls="plWonPick">Won</button></div>
    ${renderPlWonPicker(b, { open: false, prices: d.prices, recommended: plRecommendedPlan(d.brief) })}
    <div class="field"><label for="plLossReason">If we lost them, why</label><select id="plLossReason" data-tk-form><option value="">Pick a reason</option>${PL_LOSS_REASONS.map((r) => `<option value="${esc(r)}">${esc(plLossWord(r))}</option>`).join('')}</select></div>
    <div class="pl-acts"><button class="btn ghost" onclick="plMarkLost(${plAttr(id)})">Lost</button></div>
    </div>`;
}

/* ---- what a plan costs, said once, from plan_prices -------------- */

/* Whole dollars, grouped, with a dollar sign — from core.js. */
const plUsd = coreUsd;
/* "sent", "paid", "overdue": where an invoice stands, in a word. */
function plInvoiceWord(inv) {
  const s = String((inv && inv.status) || 'sent');
  return s === 'paid' ? 'paid' : s === 'void' ? 'cancelled' : s === 'draft' ? 'not sent yet' : s === 'overdue' ? 'sent, overdue' : 'sent';
}
/* Only a plan on offer has a price to say: anything else gets no words and no amount. */
function plPrice(plan, prices) {
  const k = String(plan || '');
  if (!PL_PLANS.includes(k)) return null;
  return (Array.isArray(prices) ? prices : []).find((p) => p && String(p.plan) === k) || null;
}
/* A plan without a 3-month price in the list is monthly whatever was picked. */
function plTermOf(plan, term, prices) {
  const p = plPrice(plan, prices);
  if (p && !Number(p.three_month_fee)) return 'monthly';
  return term === '3month' ? '3month' : 'monthly';
}
/* What the first invoice comes to: one month, or the three months billed up front. */
function plFirstInvoice(plan, term, prices) {
  const p = plPrice(plan, prices); if (!p) return null;
  return plTermOf(plan, term, prices) === '3month' ? Number(p.three_month_fee) * 3 : Number(p.monthly_fee);
}
/* "Growth · monthly — 10 calls a month, $3,000 a month". '' when the price list is not loaded. */
function plPriceWords(plan, term, prices) {
  const p = plPrice(plan, prices); if (!p) return '';
  const name = plPlanWord(plan);
  const calls = Number(p.calls_promised) || 0;
  if (plTermOf(plan, term, prices) === '3month') {
    return name + ' · 3 months — ' + calls + ' calls a month, ' + plUsd(p.three_month_fee) + ' a month (' + plUsd(Number(p.three_month_fee) * 3) + ' billed up front)';
  }
  return name + ' · monthly — ' + calls + ' calls a month, ' + plUsd(p.monthly_fee) + ' a month';
}
/* The one line asked before anything is sent. */
function plWonConfirmWords(b, plan, term, prices) {
  const to = String((b && b.email) || '').trim() || 'them';
  const amt = plFirstInvoice(plan, term, prices);
  return 'Send the agreement and the ' + (amt == null ? '' : plUsd(amt) + ' ') + 'invoice to ' + to + '?';
}
/* The plan the research engine recommends: "Growth — budget fits" → 'growth'. */
function plRecommendedPlan(briefRow) {
  const raw = briefRow && typeof briefRow === 'object' && 'brief' in briefRow ? briefRow.brief : null;
  const r = raw && typeof raw === 'object' ? raw.recommended_plan : null;
  const m = /^\s*(?:the\s+\$?\d*\s*)?([a-z]+)/i.exec(String(r == null ? '' : (typeof r === 'object' ? (r.plan || r.name || '') : r)));
  const k = m ? m[1].toLowerCase() : '';
  return PL_PLANS.includes(k) ? k : '';
}
/* A call still in the future: Won is allowed, but it is said. */
function plNotHappened(b, now) { const t = plMs(b && b.call_at); return Boolean(t) && t > (now || new Date()).getTime(); }

/* The small plan picker the Won button opens: which plan and which term, with what
   that costs beside the button. Every plan on offer is monthly or 3-month.
   The plan they chose on the website is already picked; failing that, the one the
   brief recommends. The button asks once ("Send the agreement and the $3,000
   invoice to …?") before anything is sent. Pure: data in, HTML out.
   meta = {open, prices, recommended, now} */
function renderPlWonPicker(b, meta) {
  b = b || {}; meta = meta || {};
  const id = b.id;
  const rec = PL_PLANS.includes(String(meta.recommended)) ? String(meta.recommended) : '';
  const picked = PL_PLANS.includes(String(b.plan)) ? String(b.plan) : rec;
  const to = String(b.email || '').trim();
  const price = picked ? plPriceWords(picked, 'monthly', meta.prices) : '';
  return `<div id="plWonPick" class="pl-won-pick pl-outcome"${meta.open ? '' : ' style="display:none"'}>
    ${plNotHappened(b, meta.now) ? '<p class="pl-small pl-warn">This call hasn’t happened yet.</p>' : ''}
    <div class="field"><label for="plPlan">Which plan did they buy</label><select id="plPlan" data-tk-form onchange="plWonTermShow()"><option value="">Pick the plan</option>${PL_PLANS.map((p) => `<option value="${esc(p)}"${p === picked ? ' selected' : ''}>${esc(plPlanWord(p))}</option>`).join('')}</select>${picked === rec && rec && String(b.plan) !== rec ? '<p class="muted pl-small">The brief recommends ' + esc(plPlanWord(rec)) + '.</p>' : ''}</div>
    <div class="field" id="plTermField"><label for="plTerm">Term</label><select id="plTerm" data-tk-form onchange="plWonTermShow()"><option value="monthly">Monthly</option><option value="3month">3 months</option></select></div>
    <p class="pl-small" id="plWonPrice">${esc(price)}</p>
    <div class="pl-acts" id="plWonAskRow"><button class="btn" id="plWonGo" onclick="plWonAsk(${plAttr(id)})">Mark won and send the pack</button></div>
    <div id="plWonConfirm" class="pl-won-confirm" style="display:none"><p id="plWonConfirmText">${esc(plWonConfirmWords(b, picked, 'monthly', meta.prices))}</p>
      <div class="pl-acts"><button class="btn" onclick="plMarkWon(${plAttr(id)})">Yes, send it</button><button class="btn ghost" onclick="plWonBack()">Back</button></div></div>
    <p class="muted pl-small">This makes them a client and emails the agreement and the first invoice${to ? ' to ' + esc(to) : ''}. The plan sets the number of calls and the fee — both come from the price list, never typed in here.</p></div>`;
}

/* One booking: where it stands, the brief, and their answers. `meta.head` is the top of
   the panel when the caller has its own (the Calendar does, with both clocks on it), and
   `meta.brief` is the brief already laid out when the caller draws that too. */
function renderPlEnquiry(d, meta) {
  meta = meta || {};
  const now = meta.now || new Date();
  if (!d || !d.booking) {
    return emptyState((typeof I !== 'undefined' && I.inquiry) || '', 'Booking not found',
      'It may have been removed.', '', null);
  }
  const b = d.booking, id = b.id, score = d.score;
  const site = plSafeUrl(b.website);
  const head = typeof meta.head === 'string' ? meta.head : `<div class="card pl-pad pl-head">
    <div class="pl-card-head"><b class="pl-who">${esc(plWho(b))}</b>${plStatusPill(b.status)}${score === '' ? '' : `<span class="pill blue">Score ${esc(String(score))}</span>`}</div>
    <div class="pl-when">${b.call_at ? `<b>${esc(plWhen(b.call_at))}</b> <span class="muted">· ${esc(plRel(b.call_at, now))}${b.timezone ? ' · ' + esc(b.timezone) : ''}</span>` : '<span class="muted">No call booked</span>'}</div>
    ${b.meet_link && plSafeUrl(b.meet_link) && !d.client && String(b.status) !== 'won' ? `<div class="pl-acts"><a class="btn" href="${esc(plSafeUrl(b.meet_link))}" target="_blank" rel="noopener noreferrer">Join the call</a></div>` : ''}
  </div>`;

  const answers = (d.answers || []).length
    ? `<div class="card pl-pad"><div class="pl-kv">${d.answers.map((a) => `<small>${esc(a.label)}</small><span>${a.label === 'Website' && site ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(a.value)}</a>` : esc(a.value)}</span>`).join('')}</div></div>`
    : `<div class="card pl-pad"><p class="muted">They did not fill in anything beyond their name and email.</p></div>`;

  return head
    + `<div class="section-head pl-section"><h3>Where it stands</h3></div>` + renderPlOutcome(d)
    + `<div class="section-head pl-section"><h3>What we found out</h3>${d.research && d.research.state === 'done' ? '<span class="pill green">Brief ready</span>' : ''}</div>`
    + (typeof meta.brief === 'string' ? meta.brief : renderPlBrief(d.sections, d.research, id))
    + `<div class="section-head pl-section"><h3>What they told us</h3></div>` + answers;
}

/* ---- the funnel screen ------------------------------------------- */

function renderPlFunnel(f, meta) {
  meta = meta || {};
  if (!f) {
    return emptyState((typeof I !== 'undefined' && I.chart) || '', 'No funnel yet',
      'Once enquiries come in, this counts them.', '', null);
  }
  const steps = [['Enquiries', f.enquiries], ['Calls booked', f.booked], ['Calls held', f.held], ['Won', f.won], ['Lost', f.lost]];
  const top = Math.max.apply(null, steps.map(([, n]) => Number(n) || 0).concat([1]));
  const bars = steps.map(([label, n]) => {
    const v = Number(n) || 0;
    return `<div class="pl-bar-row"><span class="pl-bar-label">${esc(label)}</span>
      <span class="pl-bar-track"><span class="pl-bar-fill" style="width:${plPct(v, top)}%"></span></span>
      <b class="pl-bar-num fig">${esc(String(v))}</b></div>`;
  }).join('');
  const rate = (label, pct, of) => `<div class="pl-rate"><b class="fig">${esc(String(pct))}%</b><small>${esc(label)}</small><span class="muted pl-small">${esc(of)}</span></div>`;
  const reasons = Object.keys(f.reasons || {}).sort((a, b) => f.reasons[b] - f.reasons[a]);

  return `<div class="pl-funnel">
    <div class="card pl-pad"><div class="pl-bars">${bars}</div>
      ${f.enquiries ? '' : '<p class="muted">No enquiries in this period yet — every number is zero because there is nothing to count.</p>'}</div>
    <div class="pl-rates">${rate('Show rate', f.show_rate, `${f.held} of ${f.booked} booked calls were held`)}
      ${rate('Win rate', f.win_rate, `${f.won} of ${f.decided} decided`)}</div>
    ${f.open ? `<p class="muted pl-small">${esc(String(f.open))} still in play, so they count in neither rate.</p>` : ''}
    ${reasons.length ? `<div class="section-head pl-section"><h3>Why we lost</h3></div><div class="card pl-pad"><div class="pl-kv">${reasons.map((r) => `<small>${esc(plLossWord(r))}</small><span>${esc(String(f.reasons[r]))}</span>`).join('')}</div></div>` : ''}
  </div>`;
}

/* ---- the one screen left here: the funnel -------------------------- */

function plHostHTML() {
  /* A failure a person can act on: the reason, and a button that asks again
     without reloading the whole app. */
  if (pl.funnelErr) return `<div class="card pl-pad" role="alert"><p class="muted">${esc(pl.funnelErr)}</p>
    <button type="button" class="btn ghost" onclick="plRetryFunnel()">Try again</button></div>`;
  return pl.funnel ? renderPlFunnel(pl.funnel, {}) : plLoadingHTML();
}
function plLoadingHTML() { return '<div class="card pl-pad" role="status"><p class="muted">Loading…</p></div>'; }
/* Ask for the funnel again: the last reason has to go first, or the screen would
   draw the failure straight back instead of saying it is loading. */
function plRetryFunnel() {
  pl.funnelErr = null;
  plRepaint();
  return plLoadFunnel(pl.days).then(() => plRepaint(), () => {
    pl.funnelErr = 'Aviance could not read the funnel just now. Try again in a moment.';
    plRepaint();
  });
}
function plRepaint() {
  const h = typeof document !== 'undefined' ? document.getElementById('plHost') : null;
  if (!h) return false;
  h.innerHTML = plHostHTML();
  return true;
}
function viewFunnel() {
  /* Without the second handler a rejection left this screen reading "Loading…"
     with nothing on its way and no way to ask again short of reloading the app. */
  plLoadFunnel(pl.days).then(() => plRepaint(), () => {
    pl.funnelErr = 'Aviance could not read the funnel just now. Try again in a moment.';
    plRepaint();
  });
  return `<div id="plHost" class="pl">${plHostHTML()}</div>`;
}

/* One booking, read fresh and kept in pl.one — the Calendar's panel draws from it. */
async function plLoadEnquiry(id) {
  if (!id) { pl.oneErr = 'No booking was asked for.'; return plErr(pl.oneErr); }
  pl.oneId = String(id);
  const r = await plBooking(id);
  if (r.ok) { pl.one = r.data; pl.oneErr = null; } else { pl.one = null; pl.oneErr = r.error; }
  return r;
}
async function plLoadFunnel(days) {
  pl.days = Number(days) > 0 ? Number(days) : pl.days;
  const r = await plFunnel(plRangeDays(pl.days));
  if (r.ok) { pl.funnel = r.data; pl.funnelErr = null; } else { pl.funnelErr = r.error; }
  return r;
}

/* ---- the buttons -------------------------------------------------- */

/* After any outcome is written: read the booking again, then let the Calendar redraw
   itself and its panel (mtBookingChanged, meetings.js). */
async function plChanged(id) {
  await plLoadEnquiry(id);
  if (typeof mtBookingChanged === 'function') { try { await mtBookingChanged(id); } catch (e) { /* the write itself went through */ } }
}
function plPick(id) { const e = typeof document !== 'undefined' ? document.getElementById(id) : null; return e && e.value ? String(e.value).trim() : ''; }
function plSay(r, good) {
  if (typeof toast === 'function') toast(r && r.ok ? good : (r && r.error) || 'Nothing was changed.');
  return r;
}
/* The Won button: show the plan picker (or tuck it away again). */
function plOpenWon() {
  const box = typeof document !== 'undefined' ? document.getElementById('plWonPick') : null;
  if (!box) return false;
  const show = box.style.display === 'none';
  box.style.display = show ? '' : 'none';
  plWonTermShow();
  return show;
}
/* The plan or the term was changed: the price beside the button follows it, and a
   confirmation already on show goes back a step. */
function plWonTermShow() {
  const w = typeof document !== 'undefined' ? document.getElementById('plWonPrice') : null;
  const plan = plPick('plPlan');
  if (w) w.textContent = plan ? plPriceWords(plan, plPick('plTerm'), pl.one && pl.one.prices) : '';
  plWonBack();
}
/* "Mark won and send the pack" asks once, in one line, before anything is sent. */
function plWonAsk(id) {
  const plan = plPick('plPlan');
  if (!plan) return plSay(plErr('Pick the plan they bought first.'), '');
  const doc = typeof document !== 'undefined' ? document : null;
  const b = pl.one && pl.one.booking && String(pl.one.booking.id) === String(id) ? pl.one.booking : { id };
  const words = plWonConfirmWords(b, plan, plPick('plTerm'), pl.one && pl.one.prices);
  const box = doc ? doc.getElementById('plWonConfirm') : null, ask = doc ? doc.getElementById('plWonAskRow') : null;
  const t = doc ? doc.getElementById('plWonConfirmText') : null;
  if (t) t.textContent = words;
  if (box) box.style.display = '';
  if (ask) ask.style.display = 'none';
  return plOk({ asked: words });
}
function plWonBack() {
  const doc = typeof document !== 'undefined' ? document : null;
  const box = doc ? doc.getElementById('plWonConfirm') : null, ask = doc ? doc.getElementById('plWonAskRow') : null;
  if (box) box.style.display = 'none';
  if (ask) ask.style.display = '';
  return true;
}
/* "Open client →" once they are won. */
function plOpenClient(clientId) {
  if (!clientId) return false;
  try { if (typeof closeModal === 'function') closeModal(); } catch (e) { /* nothing open */ }
  if (typeof mt !== 'undefined' && mt) mt.open = null;
  if (typeof openClient === 'function') { openClient(clientId); return true; }
  return false;
}
/* "Mark won and send the pack". One at a time: a second click while the first is still
   on its way does nothing, so the pack is never asked for twice. */
async function plMarkWon(id) {
  const plan = plPick('plPlan');
  if (!plan) return plSay(plErr('Pick the plan they bought first.'), '');
  if (pl.winning) return plErr('Still working on it.');
  pl.winning = true;
  let r;
  try { r = await plCloseWon(id, plan, plPick('plTerm') || 'monthly'); }
  finally { pl.winning = false; }
  const b = pl.one && pl.one.booking && String(pl.one.booking.id) === String(id) ? pl.one.booking : null;
  const to = String((b && b.email) || '').trim() || 'them';
  plSay(r, 'Won. The agreement and invoice are on their way to ' + to + '.');
  if (r.ok) await plChanged(id);
  return r;
}
function plMarkLost(id){ return coreOnce('pl:mark:'+id, async () => {
  const reason = plPick('plLossReason');
  const r = await plLost(id, reason);
  plSay(r, 'Marked lost.');
  if (r.ok) await plChanged(id);
  return r;
}, typeof document !== 'undefined' ? document.activeElement : null) }
function plMarkNoShow(id){ return coreOnce('pl:mark:'+id, async () => {
  const r = await plNoShow(id);
  plSay(r, 'Marked as nobody came.');
  if (r.ok) await plChanged(id);
  return r;
}, typeof document !== 'undefined' ? document.activeElement : null) }
function plMarkHeld(id){ return coreOnce('pl:mark:'+id, async () => {
  const r = await plHeld(id);
  plSay(r, 'Marked: the call happened.');
  if (r.ok) await plChanged(id);
  return r;
}, typeof document !== 'undefined' ? document.activeElement : null) }
function plForget() { Object.assign(pl, { one: null, oneId: null, oneErr: null, funnel: null, funnelErr: null, days: 30, winning: false }); }
