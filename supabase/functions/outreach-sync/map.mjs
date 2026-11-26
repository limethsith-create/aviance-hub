/* outreach-sync — the mapping, and nothing else.
   Instantly and Smartlead describe the same work in two different shapes. Everything in this
   file turns one of those shapes into a row for the outreach_* tables the portal reads, so the
   portal never has to know which tool sent the email.

   This file is pure: no network, no Deno, no database. index.ts does the fetching and the
   upserting; tests/outreach.test.mjs runs every function here against the recorded fixtures in
   ./fixtures, which is how the whole mapping is proven before a single API key exists.

   Nothing here ever throws on bad input: a missing or odd field becomes null, 0 or 'unknown'.
   A provider that quietly renames a field must not take the portal down with it.

   Prefix: ox. */

/* ---- small, boring helpers ---- */

export const oxNum = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 };
export const oxStr = (v) => (v == null ? null : (String(v).trim() || null));
/** health is 0..100 in the database (there is a CHECK), so anything else becomes null. */
export const oxHealth = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null };
/** A sending limit, or null when the provider did not give one. Not 0: 0 means "sends nothing". */
export const oxLimit = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null };
export const oxDomain = (email) => { const s = String(email || ''); const i = s.lastIndexOf('@'); return i > 0 ? s.slice(i + 1).toLowerCase() : null };
export const oxDay = (v) => { const s = String(v || ''); const m = s.match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null };
export const oxWhen = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString() };
/** An email body may arrive as HTML. The portal shows text, so strip it here, once. */
export function oxText(html) {
  const s = String(html == null ? '' : html);
  if (!s) return null;
  const out = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_, d) => { try { return String.fromCodePoint(Number(d)) } catch (e) { return ' ' } })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch (e) { return ' ' } })
    .replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–').replace(/&hellip;/gi, '…')
    .replace(/&[a-z]{2,10};/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out || null;
}
/** A body big enough to bloat the table is no use on screen either. */
export const oxClip = (s, n = 20000) => { const v = oxStr(s); return v == null ? null : (v.length > n ? v.slice(0, n) + '…' : v) };

/* ---- which secret holds this account's key ----
   key_ref NAMES a secret; it never holds one. The name the owner is told to set is
   OUTREACH_<PROVIDER>_<LABEL>, and that is what settings.js writes into key_ref. An older or
   hand-typed key_ref still works: we try it as written, then upper-snaked, then prefixed. */
export function oxEnvName(provider, label) {
  const p = String(provider || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const l = String(label || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `OUTREACH_${p}${l ? '_' + l : ''}`;
}
export function oxEnvCandidates(keyRef) {
  const raw = String(keyRef == null ? '' : keyRef).trim();
  if (!raw) return [];
  const snake = raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const out = [raw];
  if (snake && snake !== raw) out.push(snake);
  if (snake && !snake.startsWith('OUTREACH_')) out.push('OUTREACH_' + snake);
  return out.filter((n, i) => n && out.indexOf(n) === i);
}

/* ---- Instantly (api.instantly.ai, /api/v2, Authorization: Bearer <key>) ---- */

/* campaign_status: 0 draft · 1 active · 2 paused · 3 completed · 4 running subsequences
   · -99 account suspended · -1 accounts unhealthy · -2 bounce protect */
export function oxInstantlyCampaignStatus(v) {
  const n = Number(v);
  if (n === 1 || n === 4) return 'running';
  if (n === 2) return 'paused';
  if (n === 3) return 'finished';
  if (n < 0) return 'error';
  return 'draft';
}

/** One row for outreach_campaigns. `c` is a /campaigns item, `a` the matching /campaigns/analytics item. */
export function oxInstantlyCampaign(c, a) {
  const an = a || {};
  const cm = c || {};
  return {
    external_id: oxStr(cm.id ?? an.campaign_id),
    name: oxStr(cm.name ?? an.campaign_name) || 'Untitled campaign',
    status: oxInstantlyCampaignStatus(cm.status ?? an.campaign_status),
    started_on: oxDay(cm.timestamp_created),
    sent: oxNum(an.emails_sent_count),
    // the unique counts, not the raw ones: a client counts people reached, not pixel loads
    opened: oxNum(an.open_count_unique ?? an.open_count),
    replied: oxNum(an.reply_count_unique ?? an.reply_count),
    positive: oxNum(an.total_opportunities),
    booked: 0,                                  // filled from our own meetings, see oxBookedFromThreads
    bounced: oxNum(an.bounced_count),
    unsubscribed: oxNum(an.unsubscribed_count),
  };
}

/** Rows for outreach_daily from /campaigns/analytics/daily. */
export function oxInstantlyDaily(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    on_day: oxDay(r && r.date),
    sent: oxNum(r && r.sent),
    opened: oxNum(r && (r.unique_opened ?? r.opened)),
    replied: oxNum(r && (r.unique_replies ?? r.replies)),
    positive: oxNum(r && (r.unique_opportunities ?? r.opportunities)),
    booked: 0,
    bounced: 0,            // Instantly's daily feed carries no per-day bounce or unsubscribe
    unsubscribed: 0,
  })).filter((r) => r.on_day);
}

/* account status: 1 active · 2 paused · 3 paused for maintenance · -1/-2/-3 errors
   warmup_status: 0 paused · 1 active · -1 banned · -2 spam folder · -3 suspended */
export function oxInstantlyInbox(a) {
  const x = a || {};
  const st = Number(x.status), w = Number(x.warmup_status);
  const health = oxHealth(x.stat_warmup_score);
  let status = 'ok';
  if (st < 0 || w === -1 || w === -3) status = 'blocked';
  else if (st === 2 || st === 3) status = 'paused';
  else if (x.setup_pending === true) status = 'warming';
  else if (health != null && health < 70) status = 'warning';
  return {
    external_id: oxStr(x.email),            // Instantly identifies a sending account by its address
    email: oxStr(x.email),
    domain: oxDomain(x.email),
    warmed: w === 1,
    health,
    // null is "no limit of its own", which is not the same as a limit of zero
    daily_limit: oxLimit(x.daily_limit) ?? oxLimit(x.warmup && x.warmup.limit),
    sent_today: 0,                          // not in Instantly's account feed; see the report
    status,
  };
}

/** i_status is Instantly's interest flag. Positive means interest, negative means none. */
export function oxInstantlySentiment(v) {
  if (v == null || v === '') return 'unknown';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 'unknown';
  return n > 0 ? 'positive' : 'negative';
}

const oxDisplayName = (json) => {
  const arr = Array.isArray(json) ? json : [];
  for (const a of arr) {
    const n = oxStr(a && (a.name || a.display_name));
    if (n && !n.includes('@')) return n;
  }
  return null;
};

/** ue_type: 1 sent from campaign · 2 received · 3 sent by hand · 4 scheduled */
export const oxInstantlyDirection = (ue) => (Number(ue) === 2 ? 'in' : 'out');

/** /emails items -> one {thread, messages} per thread_id, newest message last. */
export function oxInstantlyThreads(emails) {
  const byThread = new Map();
  for (const e of (Array.isArray(emails) ? emails : [])) {
    if (!e) continue;
    const tid = oxStr(e.thread_id) || oxStr(e.id);
    if (!tid) continue;
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid).push(e);
  }
  const out = [];
  for (const [tid, list] of byThread) {
    list.sort((a, b) => String(a.timestamp_email || '').localeCompare(String(b.timestamp_email || '')));
    const inbound = list.filter((e) => oxInstantlyDirection(e.ue_type) === 'in');
    const lead = oxStr(list.map((e) => e.lead).find(Boolean))
      || oxStr((inbound[0] || {}).from_address_email)
      || oxStr(String((list[0] || {}).to_address_email_list || '').split(',')[0]);
    const iStatus = list.map((e) => e.i_status).find((v) => v != null && v !== 0);
    const last = list[list.length - 1] || {};
    out.push({
      thread: {
        external_id: tid,
        lead_name: oxDisplayName((inbound[0] || {}).from_address_json),
        lead_email: lead,
        lead_company: null,              // Instantly's email feed carries no company or title
        lead_title: null,
        sentiment: oxInstantlySentiment(iStatus),
        status: inbound.length ? 'answered' : 'open',
        last_message_at: oxWhen(last.timestamp_email),
        campaign_external_id: oxStr(list.map((e) => e.campaign_id).find(Boolean)),
      },
      messages: list.map((e) => ({
        external_id: oxStr(e.id) || oxStr(e.message_id),
        direction: oxInstantlyDirection(e.ue_type),
        subject: oxStr(e.subject),
        body: oxClip((e.body && oxStr(e.body.text)) || oxText(e.body && e.body.html) || oxStr(e.content_preview)),
        sent_at: oxWhen(e.timestamp_email) || oxWhen(e.timestamp_created),
        delivery: 'synced',
        delivery_error: null,
      })).filter((m) => m.external_id),
    });
  }
  return out;
}

/* ---- Smartlead (server.smartlead.ai, /api/v1, ?api_key=<key>) ---- */

export function oxSmartleadCampaignStatus(v) {
  switch (String(v || '').toUpperCase()) {
    case 'ACTIVE': return 'running';
    case 'PAUSED': case 'STOPPED': return 'paused';
    case 'COMPLETED': case 'ARCHIVED': return 'finished';
    case 'DRAFTED': return 'draft';
    default: return 'draft';
  }
}

/** `c` is a /campaigns item, `a` the matching /campaigns/{id}/analytics-by-date body. */
export function oxSmartleadCampaign(c, a) {
  const an = a || {}, cm = c || {};
  return {
    external_id: oxStr(cm.id ?? an.id),
    name: oxStr(cm.name ?? an.name) || 'Untitled campaign',
    status: oxSmartleadCampaignStatus(cm.status ?? an.status),
    started_on: oxDay(an.start_date) || oxDay(cm.schedule_start_time) || oxDay(cm.created_at),
    sent: oxNum(an.unique_sent_count ?? an.sent_count),
    opened: oxNum(an.unique_open_count ?? an.open_count),
    replied: oxNum(an.unique_reply_count ?? an.reply_count),
    positive: 0,                                 // Smartlead has no "positive" total; see oxPositiveFromThreads
    booked: 0,
    bounced: oxNum(an.bounce_count),
    unsubscribed: oxNum(an.unsubscribed_count),
  };
}

/** Rows for outreach_daily from /analytics/day-wise-overall-stats. */
export function oxSmartleadDaily(body) {
  const rows = Array.isArray(body) ? body
    : (body && body.data && Array.isArray(body.data.day_wise_stats)) ? body.data.day_wise_stats
    : (body && Array.isArray(body.day_wise_stats)) ? body.day_wise_stats : [];
  return rows.map((r) => ({
    on_day: oxDay(r && (r.date || r.day)),
    sent: oxNum(r && r.sent),
    opened: oxNum(r && r.opened),
    replied: oxNum(r && r.replied),
    positive: 0,
    booked: 0,
    bounced: oxNum(r && r.bounced),
    unsubscribed: 0,       // Smartlead's day-wise feed carries no per-day unsubscribe
  })).filter((r) => r.on_day);
}

export function oxSmartleadInbox(a) {
  const x = a || {}, w = (x.warmup_details || {});
  const health = oxHealth(w.warmup_reputation);
  const wst = String(w.status || '').toUpperCase();
  let status = 'ok';
  if (w.is_warmup_blocked === true || x.is_smtp_success === false) status = 'blocked';
  else if (wst === 'PAUSED' || wst === 'INACTIVE') status = 'paused';
  else if (health != null && health < 70) status = 'warning';
  return {
    external_id: oxStr(x.id),
    email: oxStr(x.from_email ?? x.username),
    domain: oxDomain(x.from_email ?? x.username),
    warmed: wst === 'ACTIVE',
    health,
    daily_limit: oxLimit(x.message_per_day),
    sent_today: oxNum(x.daily_sent_count),
    status,
  };
}

/** /leads/fetch-categories -> { '<id>': {name, sentiment} } so a lead's category becomes a sentiment. */
export function oxSmartleadCategories(rows) {
  const map = {};
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || r.id == null) continue;
    const name = String(r.name || '');
    let s = r.sentiment_type === 'positive' ? 'positive' : r.sentiment_type === 'negative' ? 'negative' : 'neutral';
    if (/out\s*of\s*office|\booo\b/i.test(name)) s = 'out_of_office';
    else if (/unsubscrib|do not contact|opt\s*out/i.test(name)) s = 'unsubscribe';
    map[String(r.id)] = { name: name || null, sentiment: s };
  }
  return map;
}

/** One thread row from a /campaigns/{id}/leads item. */
export function oxSmartleadThread(item, categories) {
  const it = item || {}, lead = it.lead || {};
  const cat = (categories || {})[String(it.lead_category_id)] || null;
  const name = [oxStr(lead.first_name), oxStr(lead.last_name)].filter(Boolean).join(' ') || null;
  const cf = lead.custom_fields || {};
  return {
    // a Smartlead lead is only a lead *within* a campaign, so the campaign's own id is the thread
    external_id: lead.id != null ? String(lead.id) : (it.campaign_lead_map_id != null ? String(it.campaign_lead_map_id) : null),
    lead_name: name,
    lead_email: oxStr(lead.email),
    lead_company: oxStr(lead.company_name),
    lead_title: oxStr(cf.job_title ?? cf.title ?? cf.Title ?? lead.title),
    sentiment: lead.is_unsubscribed === true ? 'unsubscribe' : (cat ? cat.sentiment : 'unknown'),
    status: 'open',
    last_message_at: oxWhen(it.last_sent_time ?? it.created_at),
    lead_id: lead.id != null ? String(lead.id) : null,
  };
}

/** Message rows from /campaigns/{id}/leads/{lead}/message-history.
    Smartlead has shipped two shapes for this (a `history` array of SENT/REPLY rows, and a
    `messages` array of inbound/outbound rows). Both are read here, so neither breaks us. */
export function oxSmartleadMessages(body) {
  const rows = Array.isArray(body) ? body
    : (body && Array.isArray(body.history)) ? body.history
    : (body && Array.isArray(body.messages)) ? body.messages : [];
  return rows.map((r) => {
    const m = r || {};
    const type = String(m.type || m.direction || '').toUpperCase();
    const inbound = type === 'REPLY' || type === 'RECEIVED' || type === 'INBOUND' || !!m.received_at;
    return {
      external_id: oxStr(m.stats_id ?? m.message_id ?? m.id),
      direction: inbound ? 'in' : 'out',
      subject: oxStr(m.subject),
      body: oxClip(oxStr(m.email_body_text ?? m.text) || oxText(m.email_body ?? m.body ?? m.email_body_html)),
      sent_at: oxWhen(m.time ?? m.sent_at ?? m.received_at ?? m.event_timestamp),
      delivery: 'synced',
      delivery_error: null,
    };
  }).filter((m) => m.external_id);
}

/* ---- things both providers get the same way ---- */

/** A thread whose lead sat down with us is 'booked', and carries the meeting it became.
    meeting_id is the link the schema already has between a prospect thread and a real call. */
export function oxLinkMeetings(threads, meetings) {
  const byEmail = new Map();
  for (const m of (Array.isArray(meetings) ? meetings : [])) {
    const e = String((m && m.guest_email) || '').trim().toLowerCase();
    if (!e || !m.id) continue;
    const prev = byEmail.get(e);
    if (!prev || String(m.held_at || '') > String(prev.held_at || '')) byEmail.set(e, m);
  }
  return (Array.isArray(threads) ? threads : []).map((t) => {
    const hit = byEmail.get(String((t && t.lead_email) || '').trim().toLowerCase());
    if (!hit) return t;
    return { ...t, meeting_id: hit.id, status: 'booked', sentiment: t.sentiment === 'unknown' ? 'positive' : t.sentiment };
  });
}

/** What the portal should show as "booked" and "positive" for a campaign: our own threads. */
export const oxBookedFromThreads = (threads) =>
  (Array.isArray(threads) ? threads : []).filter((t) => t && (t.status === 'booked' || t.meeting_id)).length;
export const oxPositiveFromThreads = (threads) =>
  (Array.isArray(threads) ? threads : []).filter((t) => t && t.sentiment === 'positive').length;

/** The window to re-read. A provider restates yesterday's numbers, so always go back a few days,
    and never ask for more than `maxDays` at once (Smartlead refuses a range over 30 days). */
export function oxWindow(lastSyncedAt, now, backDays = 3, maxDays = 30) {
  const end = new Date(now || Date.now());
  const from = lastSyncedAt ? new Date(lastSyncedAt) : null;
  let start = (from && !Number.isNaN(from.getTime()))
    ? new Date(from.getTime() - backDays * 86400000)
    : new Date(end.getTime() - maxDays * 86400000);
  const floor = new Date(end.getTime() - maxDays * 86400000);
  if (start < floor) start = floor;
  if (start > end) start = end;
  return { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) };
}
