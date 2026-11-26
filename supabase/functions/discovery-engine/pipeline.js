// The whole flow, in order. Storage is passed in (Supabase in production, memory in tests).
import { runResearch, AGENT_LABELS } from './research.js';
import { createCallEvent, attachBriefToEvent, sendBriefToCloser, sendProspectIntro, slack, diffResearch, sendMail } from './deliver.js';

const env = (k, d = '') => (globalThis.Deno ? Deno.env.get(k) : process.env[k]) ?? d;

// 1) Someone books on the website → this runs straight away
export async function handleBooking(booking, db, log = () => {}) {
  const step = async (name, fn) => { const t = Date.now(); try { const r = await fn(); log({ step: name, ok: true, ms: Date.now() - t }); return r; } catch (e) { log({ step: name, ok: false, error: String(e.message || e) }); return null; } };
  await db.update(booking.id, { status: 'researching' });

  // Calendar invite and research start at the same time — the prospect gets their invite instantly.
  const [cal, doc] = await Promise.all([
    step('calendar_event', () => createCallEvent(booking)),
    step('research', () => runResearch(booking, { onEvent: (ev) => log({ step: 'agent', ...ev }) })),
  ]);
  if (cal) await db.update(booking.id, { calendar_event_id: cal.eventId, meet_link: cal.meet });
  if (!doc) { await db.update(booking.id, { status: 'research_failed' }); return { cal, doc: null }; }

  const hubUrl = `${env('HUB_URL', 'https://aviance.store')}/#brief/${booking.id}`;
  await step('save_brief', () => db.saveBrief(booking.id, doc));
  await Promise.all([
    step('email_closer', () => sendBriefToCloser(doc, hubUrl)),
    step('email_prospect_intro', () => sendProspectIntro(doc, cal?.meet)),
    cal && step('calendar_attach', () => attachBriefToEvent(cal.eventId, doc, hubUrl)),
    step('slack', () => slack(`🔎 *${booking.company}* booked a call — lead score ${doc.brief.bant.score}/100. ${doc.brief.one_liner} ${hubUrl}`)),
  ]);
  await db.update(booking.id, { status: 'brief_sent', score: doc.brief.bant.score });
  return { cal, doc };
}

// 2) Runs every hour; picks calls starting in 20–28h and refreshes the research
export async function dayBefore(db, now = new Date(), log = () => {}) {
  if (!env('GOOGLE_REFRESH_TOKEN') || !env('CLOSER_EMAIL')) { log({ step: 'day_before', skipped: 'Google/CLOSER_EMAIL not set — skip until connected' }); return 0; }
  const due = await db.callsBetween(new Date(now.getTime() + 20 * 3600e3), new Date(now.getTime() + 28 * 3600e3));
  for (const bk of due) {
    const old = await db.getBrief(bk.id);
    const fresh = await runResearch(bk, { only: ['reviews', 'news', 'hiring', 'google'] });
    const changes = diffResearch(old?.raw, fresh.raw);
    const b = old?.brief || fresh.brief;
    const when = new Date(bk.call_at).toLocaleString('en-GB', { timeZone: env('CLOSER_TZ', 'Asia/Colombo'), weekday: 'short', hour: '2-digit', minute: '2-digit' });
    await sendMail({
      to: env('CLOSER_EMAIL'), subject: `Tomorrow ${when}: ${bk.company} (${b.bant?.score ?? '–'}/100)`,
      html: `<div style="font:14px/1.6 Arial;max-width:600px"><p><b>${bk.company}</b> — ${bk.name}, ${when} Sri Lanka time${bk.meet_link ? ` · <a href="${bk.meet_link}">Meet</a>` : ''}</p><p><b>What changed since they booked</b></p><ul>${changes.map((c) => `<li>${c}</li>`).join('')}</ul><p><b>Open with</b></p><ul>${(b.closer_plan?.clarify || []).map((q) => `<li>${q}</li>`).join('')}</ul><p><b>Watch for</b>: ${(b.red_flags || []).join('; ') || 'nothing flagged'}</p><p><a href="${env('HUB_URL', 'https://aviance.store')}/#brief/${bk.id}">Full brief in the hub</a></p></div>`,
    });
    await db.update(bk.id, { day_before_sent_at: new Date().toISOString() });
    log({ step: 'day_before', company: bk.company, changes });
  }
  return due.length;
}
export { AGENT_LABELS };
