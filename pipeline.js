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

   The research engine stays. Nothing here writes to research_briefs or research_log; we
   read what it produced and lay it out. A brief is someone else's jsonb, so every
   renderer here copes with a shape it did not expect.

   Every function returns {ok, data, error} and never throws (the plumbing is finance.js's).
   `error` is plain words, safe to show a person. Every screen draws with zero rows.
   ================================================================================= */

/* The booking's stage, in pipeline order. */
const PL_STATUSES = ['new', 'held', 'no_show', 'contacted', 'agreement_sent', 'won', 'lost'];
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
const PL_BRIEF_DEPTH = 3;

const PL_PLANS = ['pilot', 'starter', 'growth', 'scale'];
const PL_PLAN_WORDS = { pilot: 'Pilot', starter: 'Starter', growth: 'Growth', scale: 'Scale' };

const pl = { one: null, oneId: null, oneErr: null, funnel: null, funnelErr: null, days: 30 };

/* ---- plumbing (finance.js) ---------------------------------------- */

function plOk(data) { return { ok: true, data, error: '' }; }
function plErr(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return { ok: false, data: null, error: m };
}
function plWrap(res, whenEmpty) {
  if (!res) return plErr('No answer from the database.');
  if (res.error) return plErr(res.error);
  return plOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
async function plRun(fn, whenEmpty) {
  try { return plWrap(await fn(), whenEmpty); } catch (e) { return plErr(e); }
}

/* ---- small helpers ------------------------------------------------ */

function plAttr(v) { return esc(JSON.stringify(v == null ? '' : String(v))); }
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
function plStatusWord(s) { const m = PL_STATUS_WORDS[s] || ['grey', String(s || '—')]; return m[1]; }
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

/* ---- the bookings ------------------------------------------------- */

/* The bookings: soonest call first, each with its score and whether a brief exists.
   {status} is one stage, 'open' for everything still in play, or nothing for all.
   {from, to} keeps only the calls starting in that span — what the Calendar asks for. */
async function plBookings(opts) {
  const o = opts || {};
  const got = await plRun(() => {
    let q = sb.from('discovery_bookings').select('*');
    if (o.status && o.status !== 'all' && o.status !== 'open') q = q.eq('status', o.status);
    if (o.from) q = q.gte('call_at', o.from);
    if (o.to) q = q.lt('call_at', o.to);
    return q.order('call_at', { ascending: true });
  }, []);
  if (!got.ok) return got;
  let rows = Array.isArray(got.data) ? got.data.filter((r) => r && r.id != null) : [];
  if (o.status === 'open') rows = rows.filter(plIsOpen);
  if (!rows.length) return plOk([]);

  /* which of them the research engine has already written a brief for */
  const briefs = await plRun(() => sb.from('research_briefs').select('booking_id')
    .in('booking_id', rows.map((r) => r.id)), []);
  const have = {};
  if (briefs.ok) (briefs.data || []).forEach((r) => { if (r && r.booking_id != null) have[String(r.booking_id)] = true; });

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

  const brief = await plBrief(id);
  const state = await plResearchState(id);
  const client = await plRun(() => sb.from('clients').select('*').eq('booking_id', id).limit(1), []);

  return plOk({
    booking: b,
    score: plScore(b),
    answers: plAnswers(b),
    brief: brief.ok ? brief.data : null,
    briefError: brief.ok ? '' : brief.error,
    sections: plBriefSections(brief.ok ? brief.data : null),
    research: state.ok ? state.data : { state: 'unknown', since: null, note: state.error },
    client: client.ok && Array.isArray(client.data) && client.data.length ? client.data[0] : null,
  });
}

/* What they filled in on the website, in the order it is worth reading. */
function plAnswers(b) {
  b = b || {};
  const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : v);
  return [
    ['Name', b.name], ['Email', b.email], ['Phone', b.phone], ['Their role', b.role], ['Company', b.company],
    ['Website', b.website], ['Where they are', [b.city, b.country].filter(Boolean).join(', ')],
    ['Industry', b.industry], ['What they sell', b.sells], ['Deal size', b.budget],
    ['How they win customers today', b.current_lead_gen], ['Capacity for new calls', b.capacity],
    ['Tried outbound before', yesNo(b.tried_outbound)],
    ['Can they decide', yesNo(b.decision_maker)],
    ['What they want', b.goal], ['When they want it', b.timeline], ['Came from', b.source],
  ].filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => ({ label: k, value: String(v) }));
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
  const brief = await plBrief(bookingId);
  if (!brief.ok) return brief;
  const log = await plResearchLog(bookingId, 20);
  const rows = log.ok && Array.isArray(log.data) ? log.data.slice().sort((a, b) => plMs(b && b.at) - plMs(a && a.at)) : [];
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
    if (value == null || value === '') return;
    if (typeof value !== 'object') { out.push({ title: '', lines: [{ label: title, value: plFlat(value, max) }], text: '' }); return; }
    if (Array.isArray(value)) {
      const simple = value.every((v) => v == null || typeof v !== 'object');
      if (simple) { out.push({ title, lines: value.filter((v) => v != null && v !== '').map((v) => ({ label: '', value: String(v) })), text: '' }); return; }
      out.push({ title, lines: value.map((v, i) => ({ label: typeof v === 'object' && v && (v.title || v.label || v.name) ? String(v.title || v.label || v.name) : String(i + 1), value: plFlat(v, max - 1) })), text: '' });
      return;
    }
    const keys = Object.keys(value);
    out.push({ title, lines: keys.filter((k) => value[k] != null && value[k] !== '').map((k) => ({ label: plTitle(k), value: plFlat(value[k], max - 1) })), text: '' });
  });
  /* loose one-liners are nicer as one block */
  const loose = out.filter((s) => !s.title && s.lines.length === 1 && !s.text);
  if (loose.length > 1) {
    const rest = out.filter((s) => loose.indexOf(s) < 0);
    return [{ title: 'In short', lines: loose.map((s) => s.lines[0]), text: '' }].concat(rest);
  }
  return out;
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

/* Won on the discovery call. The plan decides the number of calls and the fee — they come
   from plan_prices and from nowhere else. One booking can only ever make one client. */
async function plWon(bookingId, opts) {
  const o = opts || {};
  if (!bookingId) return plErr('No booking was asked for.');
  if (!o.plan) return plErr('Pick the plan they bought first.');

  const got = await plRun(() => sb.from('discovery_bookings').select('*').eq('id', bookingId).maybeSingle(), null);
  if (!got.ok) return got;
  const b = got.data;
  if (!b) return plErr('That booking is not here any more.');

  /* already a client? never make a second one from the same booking */
  const seen = await plRun(() => sb.from('clients').select('*').eq('booking_id', bookingId).limit(1), []);
  if (!seen.ok) return seen;
  if (Array.isArray(seen.data) && seen.data.length) {
    return plErr(plWho(b) + ' is already a client from this booking, so nothing was changed.');
  }

  /* the price comes from plan_prices */
  const price = await plRun(() => sb.from('plan_prices').select('*').eq('plan', o.plan).maybeSingle(), null);
  if (!price.ok) return price;
  const p = price.data;
  if (!p) return plErr('That plan is not in the price list.');
  const term = o.term === '3month' ? '3month' : 'monthly';
  const fee = term === '3month' && p.three_month_fee ? p.three_month_fee : p.monthly_fee;

  const made = await plRun(() => sb.from('clients').insert({
    booking_id: bookingId,
    company: b.company || plWho(b),
    contact_name: b.name || '',
    contact_email: b.email || '',
    website: b.website || null,
    plan: p.plan,
    term,
    calls_promised: p.calls_promised,
    monthly_fee: fee,
    stage: 'won',
    owner_id: o.owner || o.ownerId || null,
  }).select().single(), null);
  if (!made.ok) return made;

  const moved = await plRun(() => sb.from('discovery_bookings')
    .update({ status: 'won' }).eq('id', bookingId).select().single(), null);
  if (!moved.ok) return moved;

  return plOk({ client: made.data, booking: moved.data });
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
  // TODO: discovery_bookings needs `lost_reason text` and `lost_at timestamptz` for this
  // (the loss reason has nowhere else to live). Until the migration is applied the
  // database will refuse the write and the error below is shown as it is.
  return plRun(() => sb.from('discovery_bookings').update({
    status: 'lost', lost_reason: String(reason), lost_at: new Date().toISOString(),
  }).eq('id', bookingId).select().single(), null);
}

/* The call happened. Whether we won it is a separate answer (plWon / plLost). */
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
  const got = await plRun(() => {
    let q = sb.from('discovery_bookings').select('*');
    if (r.from) q = q.gte('created_at', r.from);
    if (r.to) q = q.lte('created_at', r.to);
    return q;
  }, []);
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

function plResearchPill(row) {
  if (row && row.has_brief) return '<span class="pill green">Brief ready</span>';
  return '<span class="pill grey">No brief yet</span>';
}
function plPlanWord(p) { return PL_PLAN_WORDS[String(p || '')] || ''; }
/* A booking whose call has been and gone with nothing recorded about it. It is "open"
   by plIsOpen — never by a list of open words, which once hid every real booking — and
   nobody has yet said the call was held or that no one came. */
function plNeedsOutcome(b, now) {
  const t = plMs(b && b.call_at); if (!t || !plIsOpen(b)) return false;
  const s = String(b.status);
  if (PL_HELD.includes(s) || s === 'no_show') return false;
  return (now || new Date()).getTime() - t > 20 * 60000;
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
    return `<div class="card pl-pad pl-outcome"><b>Won — they are a client</b><p class="muted">${esc(d.client.company || '')} is on ${esc(String(d.client.plan || ''))}, ${esc(String(d.client.calls_promised || 0))} calls a month. This booking cannot make a second client.</p></div>`;
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
    <div class="field"><label for="plPlan">If they bought, which plan</label><select id="plPlan" data-tk-form><option value="">Pick the plan</option>${PL_PLANS.map((p) => `<option value="${esc(p)}"${p === picked ? ' selected' : ''}>${esc(plPlanWord(p))}</option>`).join('')}</select></div>
    <div class="field"><label for="plTerm">Term</label><select id="plTerm" data-tk-form><option value="monthly">Month by month</option><option value="3month">Three months up front</option></select></div>
    <div class="pl-acts"><button class="btn" onclick="plMarkWon(${plAttr(id)})">Won</button></div>
    <div class="field"><label for="plLossReason">If we lost them, why</label><select id="plLossReason" data-tk-form><option value="">Pick a reason</option>${PL_LOSS_REASONS.map((r) => `<option value="${esc(r)}">${esc(plLossWord(r))}</option>`).join('')}</select></div>
    <div class="pl-acts"><button class="btn ghost" onclick="plMarkLost(${plAttr(id)})">Lost</button></div>
    <p class="muted pl-small">The plan sets the number of calls and the fee — both come from the price list, never typed in here.</p></div>`;
}

/* One booking: where it stands, the brief, and their answers. `meta.head` is the top of
   the panel when the caller has its own (the Calendar does, with both clocks on it). */
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
    ${b.meet_link && plSafeUrl(b.meet_link) ? `<div class="pl-acts"><a class="btn" href="${esc(plSafeUrl(b.meet_link))}" target="_blank" rel="noopener noreferrer">Join the call</a></div>` : ''}
  </div>`;

  const answers = (d.answers || []).length
    ? `<div class="card pl-pad"><div class="pl-kv">${d.answers.map((a) => `<small>${esc(a.label)}</small><span>${a.label === 'Website' && site ? `<a href="${esc(site)}" target="_blank" rel="noopener noreferrer">${esc(a.value)}</a>` : esc(a.value)}</span>`).join('')}</div></div>`
    : `<div class="card pl-pad"><p class="muted">They did not fill in anything beyond their name and email.</p></div>`;

  return head
    + `<div class="section-head pl-section"><h3>Where it stands</h3></div>` + renderPlOutcome(d)
    + `<div class="section-head pl-section"><h3>What we found out</h3>${d.research && d.research.state === 'done' ? '<span class="pill green">Brief ready</span>' : ''}</div>`
    + renderPlBrief(d.sections, d.research, id)
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
      <b class="pl-bar-num">${esc(String(v))}</b></div>`;
  }).join('');
  const rate = (label, pct, of) => `<div class="pl-rate"><b>${esc(String(pct))}%</b><small>${esc(label)}</small><span class="muted pl-small">${esc(of)}</span></div>`;
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
  if (pl.funnelErr) return `<div class="card pl-pad"><p class="muted">${esc(pl.funnelErr)}</p></div>`;
  return pl.funnel ? renderPlFunnel(pl.funnel, {}) : plLoadingHTML();
}
function plLoadingHTML() { return '<div class="card pl-pad" role="status"><p class="muted">Loading…</p></div>'; }
function plRepaint() {
  const h = typeof document !== 'undefined' ? document.getElementById('plHost') : null;
  if (!h) return false;
  h.innerHTML = plHostHTML();
  return true;
}
function viewFunnel() {
  plLoadFunnel(pl.days).then(() => plRepaint());
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

function plOpenFunnel() { if (typeof render === 'function') render('funnel'); }
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
async function plMarkWon(id) {
  const plan = plPick('plPlan');
  if (!plan) return plSay(plErr('Pick the plan they bought first.'), '');
  const r = await plWon(id, { plan, term: plPick('plTerm') || 'monthly', owner: (typeof authUser !== 'undefined' && authUser && authUser.uid) || null });
  plSay(r, 'Won — they are a client now.');
  if (r.ok) await plChanged(id);
  return r;
}
async function plMarkLost(id) {
  const reason = plPick('plLossReason');
  const r = await plLost(id, reason);
  plSay(r, 'Marked lost.');
  if (r.ok) await plChanged(id);
  return r;
}
async function plMarkNoShow(id) {
  const r = await plNoShow(id);
  plSay(r, 'Marked as nobody came.');
  if (r.ok) await plChanged(id);
  return r;
}
async function plMarkHeld(id) {
  const r = await plHeld(id);
  plSay(r, 'Marked: the call happened.');
  if (r.ok) await plChanged(id);
  return r;
}
function plForget() { Object.assign(pl, { one: null, oneId: null, oneErr: null, funnel: null, funnelErr: null, days: 30 }); }
