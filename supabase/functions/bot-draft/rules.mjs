// bot-draft/rules.mjs — the pure part of the reply bot (no network, no Deno, no DOM).
// index.ts loads the data and calls these; tests/drafts.test.mjs tests them with node.
//
// Style: warm, plain and professional. These are paying B2B clients, so proper sentences and
// capitalisation, normal punctuation, contractions fine; never text-speak ("u", "ur", "thx", "tmrw"),
// at most one emoji and usually none, first names only, "target profile" and never "ICP" to a client,
// and never promise money, refunds or dates that are not in the data.
// Every reply here is a DRAFT the owner approves; nothing is sent from here.
//
//   classify(text)            -> 'call' | 'invoice' | 'receipt' | 'next' | 'testing' | 'thanks' | 'other'
//   draftReply(ctx)           -> { body, reason, intent }
//   buildPrompt(ctx)          -> { system, user } for the Groq model (when GROQ_API_KEY is set)
//   cleanModelText(text)      -> the model's reply trimmed to one safe casual message (or '' if unusable)
//   journeySummary(steps, today) -> { next_step, launch_on, days_to_launch, steps:[…late] }
//
// ctx = { text, firstName, timezone, now (Date|ms|iso),
//         meetings:[{kind,title,starts_at,minutes,status,meet_link}], invoices:[{number,amount,currency,status,due_on,paid_at,issued_on}],
//         journey:{steps:[{step,title,planned_on,status}], next_step, launch_on, days_to_launch},
//         testing:[{on_date,sent,replies,leading_angle}], offers:[{status,kind}], approvals:[{status,title,kind}],
//         company, history:[{who:'client'|'us', body}] }

export const FALLBACK = 'let me look into this and come back to you shortly.';

const STEP_WORDS = {
  kickoff: 'your kickoff call',
  research: 'research (your market, your target profile and a few angles)',
  testing: 'market testing on our warmed inboxes',
  build: 'building the real campaign',
  onboarding: 'your onboarding call',
  launch: 'launch, when month one starts',
};

const RX = {
  call: /\b(call|meeting|kick ?off|onboarding call|zoom|meet link|google meet|link for the call|when (do|are) we (talk|speak|meet)|catch up)\b/i,
  receipt: /\b(receipt|proof of payment|paid invoice copy)\b/i,
  invoice: /\b(invoice|bill|billing|payment|pay|paid|owe|amount due|how much)\b/i,
  testing: /\b(testing|test results?|numbers|stats|replies so far|how('?s| is) (it|the campaign|testing) going|any replies|results?)\b/i,
  next: /\b(what('?s| is) next|next steps?|what now|what happens (now|next)|where are we|status|update|timeline|when (do|will) (we|u|you) (launch|go live|start)|launch)\b/i,
  thanks: /^\s*(thx|thanks|thank (you|u)|ty|cheers|great|perfect|awesome|amazing|nice|cool|ok(ay)?|sounds good|got it|love it|appreciate (it|that))\b[\s!.👍🙏🙌😊]*$/i,
};

export function classify(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'other';
  if (RX.thanks.test(t)) return 'thanks';
  if (RX.receipt.test(t)) return 'receipt';
  if (RX.call.test(t)) return 'call';
  if (RX.invoice.test(t)) return 'invoice';
  if (RX.testing.test(t)) return 'testing';
  if (RX.next.test(t)) return 'next';
  return 'other';
}

/* ---------- dates, in the client's zone ---------- */
function toDate(v) { if (v instanceof Date) return v; const d = new Date(v); return isNaN(d.getTime()) ? null : d; }
function zoneOf(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'America/New_York'; } }
function zoneAbbr(d, tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName');
    return p ? p.value : '';
  } catch (e) { return ''; }
}
function ymdIn(d, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p; // YYYY-MM-DD
}
/** "Tue Nov 26, 10am ET" / "tomorrow, 2:30pm GMT+1" / "today, 4pm ET" */
export function whenText(v, tz, now) {
  const d = toDate(v); if (!d) return '';
  tz = zoneOf(tz || 'America/New_York');
  const n = toDate(now) || new Date();
  const day = ymdIn(d, tz), today = ymdIn(n, tz), tmrw = ymdIn(new Date(n.getTime() + 86400000), tz);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const g = (t) => (parts.find((x) => x.type === t) || {}).value || '';
  const mins = g('minute');
  const time = g('hour') + (mins && mins !== '00' ? ':' + mins : '') + g('dayPeriod').toLowerCase();
  const label = day === today ? 'today' : day === tmrw ? 'tomorrow' : g('weekday') + ' ' + g('month') + ' ' + g('day');
  const abbr = zoneAbbr(d, tz).replace(/^E[SD]T$/, 'ET').replace(/^C[SD]T$/, 'CT').replace(/^M[SD]T$/, 'MT').replace(/^P[SD]T$/, 'PT');
  return label + ', ' + time + (abbr ? ' ' + abbr : '');
}
/** a plain date "Nov 26" (date-only values like '2026-11-26' are read as that calendar day) */
export function dayText(v) {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : toDate(s);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(d);
}
export function money(amount, currency) {
  const n = Math.round(Number(amount) || 0);
  const c = String(currency || 'USD').toUpperCase();
  const sym = { USD: '$', GBP: '£', EUR: '€', AUD: 'A$', CAD: 'C$' }[c];
  return sym ? sym + n.toLocaleString('en-US') : n.toLocaleString('en-US') + ' ' + c;
}
function isoDay(v) { const d = toDate(v) || new Date(); return d.toISOString().slice(0, 10); }

/* ---------- journey ---------- */
export function journeySummary(steps, today) {
  const t = isoDay(today);
  const list = (Array.isArray(steps) ? steps : []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((s) => ({ ...s, late: !!(s.planned_on && String(s.planned_on) < t && s.status !== 'done') }));
  const next = list.find((s) => s.status !== 'done') || null;
  const launch = list.find((s) => s.step === 'launch');
  let days = null;
  if (launch && launch.planned_on) days = Math.round((Date.parse(launch.planned_on + 'T00:00:00Z') - Date.parse(t + 'T00:00:00Z')) / 86400000);
  return { steps: list, next_step: next ? next.step : null, launch_on: launch ? launch.planned_on : null, days_to_launch: days };
}

/* ---------- the rules ---------- */
export function firstName(name) { const f = String(name || '').trim().split(/\s+/)[0] || ''; return f ? f.charAt(0).toUpperCase() + f.slice(1).toLowerCase() : ''; }
function hey(first) { const f = firstName(first); return f ? 'Hi ' + f + ', ' : 'Hi there, '; }
function upcomingCall(ctx) {
  const now = (toDate(ctx.now) || new Date()).getTime();
  return (ctx.meetings || [])
    .filter((m) => m && m.starts_at && m.status !== 'cancelled' && m.status !== 'canceled' && toDate(m.starts_at) && toDate(m.starts_at).getTime() > now - 60 * 60000)
    .sort((a, b) => toDate(a.starts_at) - toDate(b.starts_at))[0] || null;
}
function callName(m) {
  const t = String((m && (m.title || m.kind)) || '').toLowerCase();
  if (/kick ?off/.test(t)) return 'kickoff';
  if (/onboarding/.test(t)) return 'onboarding call';
  return 'call';
}
function latestInvoice(ctx, paidOnly) {
  return (ctx.invoices || []).filter((i) => i && i.status !== 'void' && i.status !== 'draft' && (!paidOnly || i.status === 'paid'))
    .sort((a, b) => String(b.issued_on || b.created_at || '').localeCompare(String(a.issued_on || a.created_at || '')))[0] || null;
}

const RULES = {
  call(ctx) {
    const m = upcomingCall(ctx);
    if (m) {
      /* the link goes last: a full stop after a URL gets clicked along with it */
      const link = m.meet_link && /^https:\/\/meet\.google\.com\//.test(m.meet_link)
        ? '. Here is the link: ' + m.meet_link
        : '. The meeting link will appear here before the call.';
      return { body: hey(ctx.firstName) + 'your ' + callName(m) + ' is ' + whenText(m.starts_at, ctx.timezone, ctx.now) + link, reason: 'asked about the call · next one is booked' };
    }
    const open = (ctx.offers || []).find((o) => o && o.status === 'open');
    if (open) return { body: hey(ctx.firstName) + 'it is not booked yet — just pick one of the times above and reply with 1, 2 or 3.', reason: 'asked about the call · an offer is open' };
    return { body: hey(ctx.firstName) + "it is not booked yet. I'll send you a few times for it shortly.", reason: 'asked about the call · nothing booked' };
  },
  invoice(ctx) {
    const inv = latestInvoice(ctx, false);
    if (!inv) return { body: hey(ctx.firstName) + 'let me check on that and come back to you shortly.', reason: 'asked about an invoice · none on file' };
    const amt = money(inv.amount, inv.currency);
    if (inv.status === 'paid') return { body: hey(ctx.firstName) + 'invoice ' + inv.number + ' (' + amt + ') is paid — thank you. There is nothing outstanding on your side.', reason: 'asked about the invoice · latest is paid' };
    const due = inv.due_on ? ', due ' + dayText(inv.due_on) : '';
    return { body: hey(ctx.firstName) + 'invoice ' + inv.number + ' is ' + amt + due + '. The payment details are on the invoice itself — just let me know if you can\'t find it.', reason: 'asked about the invoice · ' + inv.status };
  },
  receipt(ctx) {
    const inv = latestInvoice(ctx, true);
    if (!inv) return { body: hey(ctx.firstName) + "I don't see a payment on our side yet. Let me check and come back to you shortly.", reason: 'asked for a receipt · no paid invoice' };
    return { body: hey(ctx.firstName) + 'of course — your receipt for invoice ' + inv.number + ' (' + money(inv.amount, inv.currency) + ', paid ' + dayText(inv.paid_at) + ') is on its way.', reason: 'asked for a receipt · latest paid invoice' };
  },
  next(ctx) {
    const j = ctx.journey || {};
    const steps = j.steps || [];
    const next = steps.find((s) => s.step === j.next_step) || null;
    if (!next) {
      if (steps.length && steps.every((s) => s.status === 'done')) return { body: hey(ctx.firstName) + "you're live and month one is running. I'll keep you posted here with the numbers.", reason: 'asked what is next · all steps done' };
      return { body: hey(ctx.firstName) + FALLBACK, reason: 'asked what is next · no journey yet' };
    }
    const words = STEP_WORDS[next.step] || String(next.title || next.step).toLowerCase();
    const doing = next.status === 'doing';
    const day = next.planned_on && !next.late ? dayText(next.planned_on) : '';
    let body = hey(ctx.firstName) + (doing ? "we're on " + words + ' now' + (day ? ', due to wrap up ' + day : '') : 'next up is ' + words + (day ? ', planned for ' + day : '')) + '.';
    if (j.days_to_launch != null && j.days_to_launch > 0 && next.step !== 'launch') body += ' Launch is in ' + j.days_to_launch + (j.days_to_launch === 1 ? ' day.' : ' days.');
    return { body, reason: 'asked what is next · ' + next.step + (next.late ? ' (late)' : '') };
  },
  testing(ctx) {
    const days = (ctx.testing || []).filter(Boolean).slice().sort((a, b) => String(a.on_date).localeCompare(String(b.on_date)));
    if (!days.length) {
      const st = ((ctx.journey && ctx.journey.steps) || []).find((s) => s.step === 'testing');
      if (st && st.status === 'todo' && st.planned_on) return { body: hey(ctx.firstName) + "testing hasn't started yet. I'll post the daily numbers here as soon as it does.", reason: 'asked about testing · not started' };
      return { body: hey(ctx.firstName) + FALLBACK, reason: 'asked about testing · no numbers logged' };
    }
    const sent = days.reduce((n, d) => n + (Number(d.sent) || 0), 0);
    const replies = days.reduce((n, d) => n + (Number(d.replies) || 0), 0);
    const last = days[days.length - 1];
    const lead = last.leading_angle ? ' The strongest angle so far is ' + String(last.leading_angle).trim() + '.' : '';
    return { body: hey(ctx.firstName) + 'day ' + days.length + ' of testing: ' + sent + ' sent, ' + replies + (replies === 1 ? ' reply' : ' replies') + '.' + lead, reason: 'asked about testing · ' + days.length + ' day(s) logged' };
  },
  thanks(ctx) {
    const f = firstName(ctx.firstName);
    return { body: "You're welcome" + (f ? ', ' + f : '') + ' — just let me know if you need anything else.', reason: 'said thanks' };
  },
  other(ctx) {
    return { body: hey(ctx.firstName) + FALLBACK, reason: 'no rule matched · holding reply' };
  },
};

export function draftReply(ctx) {
  ctx = ctx || {};
  const intent = classify(ctx.text);
  const out = (RULES[intent] || RULES.other)(ctx);
  return { body: tidy(out.body), reason: out.reason, intent };
}

/* one line, single spaces (names, links and invoice numbers are kept as they are) */
function tidy(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

/* ---------- the model (Groq) ---------- */
export const STYLE = [
  'You are drafting a chat reply from Aviance (a business-to-business cold-email agency) to a paying client, for the owner to approve before it is sent.',
  'Style: warm, plain and professional — one to three short sentences, written the way one person writes to another at work.',
  'Use proper sentences, capital letters and normal punctuation. Contractions are fine.',
  'Never use text-speak or abbreviations: write "you", "your", "thank you", "tomorrow" and "with" in full, never "u", "ur", "thx", "tmrw" or "w/".',
  'At most one emoji, and usually none. Use the first name only.',
  'Say "target profile", never "ICP", when you are writing to a client.',
  'No spelling mistakes.',
  'Only state facts that are in the data below (times, invoice numbers and amounts, step dates, testing numbers).',
  'Never promise money, refunds, discounts or dates that are not in the data. If you are unsure, say you will check and come back to them shortly.',
  'Output only the message text, nothing else.',
].join('\n');

export function buildPrompt(ctx) {
  const facts = {
    company: ctx.company || null,
    client_first_name: ctx.firstName || null,
    client_time_zone: ctx.timezone || 'America/New_York',
    now: (toDate(ctx.now) || new Date()).toISOString(),
    upcoming_call: (() => { const m = upcomingCall(ctx); return m ? { what: callName(m), when: whenText(m.starts_at, ctx.timezone, ctx.now), meet_link: m.meet_link || null } : null; })(),
    open_time_offer: (ctx.offers || []).some((o) => o && o.status === 'open'),
    invoices: (ctx.invoices || []).slice(0, 3).map((i) => ({ number: i.number, amount: money(i.amount, i.currency), status: i.status, due: i.due_on ? dayText(i.due_on) : null, paid: i.paid_at ? dayText(i.paid_at) : null })),
    journey: ctx.journey ? { next_step: ctx.journey.next_step, days_to_launch: ctx.journey.days_to_launch, steps: (ctx.journey.steps || []).map((s) => ({ step: s.step, planned: s.planned_on ? dayText(s.planned_on) : null, status: s.status, late: !!s.late })) } : null,
    testing_days: (ctx.testing || []).map((d) => ({ date: dayText(d.on_date), sent: d.sent, replies: d.replies, leading: d.leading_angle })),
    pending_approvals: (ctx.approvals || []).filter((a) => a && a.status === 'pending').map((a) => a.title),
    brief: ctx.brief || null,
    booking_answers: ctx.booking || null,
  };
  const hist = (ctx.history || []).slice(-12).map((h) => (h.who === 'client' ? 'client: ' : 'aviance: ') + String(h.body || '').slice(0, 400)).join('\n');
  const user = 'data:\n' + JSON.stringify(facts) + '\n\nrecent messages:\n' + hist + '\n\nthe client just wrote:\n' + String(ctx.text || '').slice(0, 1500) + '\n\nwrite the reply.';
  return { system: STYLE, user };
}

const MONEY_PROMISE = /\b(refund|discount|money back|free month|credit (u|you)|compensat)/i;
/* Text-speak from the model is thrown away rather than patched up: the rules in this file
   already write the same message properly, and a half-fixed sentence reads worse than a
   plain one. "u." is left alone so "U.S." is not mistaken for it. */
const TXT_SPEAK = /\b(ur|thx|thnx|tmrw|tmw|pls|plz|ty|w\/)\b|\bu\b(?!\.)/i;
export function cleanModelText(text) {
  let s = String(text ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^(aviance|reply)\s*:\s*/i, '').trim();
  if (!s || s.length > 600) return '';
  if (MONEY_PROMISE.test(s)) return '';
  if (TXT_SPEAK.test(s)) return '';
  // at most one emoji
  let seen = 0;
  s = s.replace(/\p{Extended_Pictographic}️?/gu, (m) => (++seen > 1 ? '' : m)).replace(/\s{2,}/g, ' ').trim();
  return s;
}
