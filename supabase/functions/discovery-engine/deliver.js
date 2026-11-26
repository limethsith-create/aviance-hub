// Delivery: Google Calendar (+ Meet link), Gmail (brief to closer, intro to prospect), optional Slack.
// Uses one Google account (the closer's) via OAuth refresh token — set up once, then runs by itself.
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN   (scopes: calendar.events, gmail.send)
//   CLOSER_EMAIL, CLOSER_NAME, CLOSER_PROOF, CLOSER_TZ, HUB_URL, SLACK_WEBHOOK_URL (optional)
import { renderBriefHtml, renderBriefText } from './research.js';

const env = (k, d = '') => (globalThis.Deno ? Deno.env.get(k) : process.env[k]) ?? d;
const G = () => ({ api: env('GOOGLE_API_BASE', 'https://www.googleapis.com'), gmail: env('GMAIL_API_BASE', 'https://gmail.googleapis.com'), token: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token') });

let cached = { token: null, exp: 0 };
export async function googleToken() {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  if (!env('GOOGLE_REFRESH_TOKEN')) throw new Error('Google not connected yet (GOOGLE_REFRESH_TOKEN missing)');
  const r = await fetch(G().token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), refresh_token: env('GOOGLE_REFRESH_TOKEN'), grant_type: 'refresh_token' }) });
  if (!r.ok) throw new Error(`google token → ${r.status} ${await r.text()}`);
  const j = await r.json();
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}
async function gfetch(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { Authorization: `Bearer ${await googleToken()}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(`${opt.method || 'GET'} ${url.split('?')[0]} → ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? {} : r.json();
}

/* ---------- Google Calendar ---------- */
export async function createCallEvent(b) {
  const start = new Date(b.call_at), end = new Date(start.getTime() + (b.minutes || 30) * 60000);
  const ev = await gfetch(`${G().api}/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, {
    method: 'POST',
    body: JSON.stringify({
      summary: `Aviance × ${b.company} — discovery call`,
      description: `${b.name} (${b.role || 'role not given'}) booked via ${b.source || 'aviance.store'}.\n\nResearch brief: being prepared — it lands in your inbox in about a minute.`,
      start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() },
      attendees: [{ email: b.email, displayName: b.name }, { email: env('CLOSER_EMAIL') }].filter((a) => a.email),
      conferenceData: { createRequest: { requestId: 'av-' + (b.id || Date.now()), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 24 * 60 }, { method: 'popup', minutes: 15 }] },
      extendedProperties: { private: { aviance_booking: String(b.id || '') } },
    }),
  });
  const meet = ev.hangoutLink || ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || null;
  return { eventId: ev.id, meet, htmlLink: ev.htmlLink };
}
export async function attachBriefToEvent(eventId, doc, hubUrl) {
  // Only the closer's copy matters; the prospect sees the event too, so keep the description short and neutral.
  const privateNote = `Research brief sent to ${env('CLOSER_EMAIL')}${hubUrl ? ' · ' + hubUrl : ''}`;
  return gfetch(`${G().api}/calendar/v3/calendars/primary/events/${eventId}?sendUpdates=none`, {
    method: 'PATCH',
    body: JSON.stringify({ extendedProperties: { private: { aviance_brief: 'ready', aviance_score: String(doc.brief.bant.score) } }, description: `Discovery call with Aviance.\n\nAgenda: your goals, what you've tried, and whether booked-call outreach fits ${doc.booking.company}.` }),
  }).then(() => privateNote);
}

/* ---------- Gmail ---------- */
const b64url = (str) => { const bytes = new TextEncoder().encode(str); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const hdr = (s) => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=` : s;
export async function sendMail({ to, subject, html, text, replyTo }) {
  const boundary = 'av' + Math.random().toString(36).slice(2);
  const mime = [`To: ${to}`, `Subject: ${hdr(subject)}`, 'MIME-Version: 1.0', replyTo ? `Reply-To: ${replyTo}` : '', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', '', text || html.replace(/<[^>]+>/g, ' '), `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', '', html, `--${boundary}--`].filter((l, i) => l !== '' || i > 4).join('\r\n');
  const j = await gfetch(`${G().gmail}/gmail/v1/users/me/messages/send`, { method: 'POST', body: JSON.stringify({ raw: b64url(mime) }) });
  return j.id;
}

export async function sendBriefToCloser(doc, hubUrl) {
  const b = doc.brief;
  return sendMail({ to: env('CLOSER_EMAIL'), subject: `🔎 ${doc.booking.company} — ${b.bant.score}/100 · call brief`, html: renderBriefHtml(doc, { hubUrl }), text: renderBriefText(doc) });
}

// "Edify the closer" — the prospect hears who they're meeting and why it's worth showing up
export async function sendProspectIntro(doc, meet) {
  const k = doc.booking, first = (k.name || '').split(' ')[0] || 'there', closer = env('CLOSER_NAME', 'Limethsith');
  const when = new Date(k.call_at).toLocaleString('en-US', { timeZone: k.timezone || 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const html = `<div style="font:15px/1.6 Arial,sans-serif;color:#141414;max-width:560px">
  <p>Hi ${first},</p><p>You're booked for <b>${when}</b>.${meet ? ` Here's the Google Meet link: <a href="${meet}">${meet}</a>` : ''}</p>
  <p>${doc.brief.edify_line}</p>
  <p>Before the call he'll have looked at ${k.company}'s market, so the 30 minutes go on your goals rather than background. Three things worth thinking about:</p>
  <ol><li>How many new clients a month would make this a great year?</li><li>What have you tried so far to get them?</li><li>Who else should be on the call?</li></ol>
  <p>Talk soon,<br>The Aviance team</p></div>`;
  return sendMail({ to: k.email, subject: `You're booked — meeting ${closer} on ${when.split(',').slice(0, 2).join(',')}`, html, replyTo: env('CLOSER_EMAIL') });
}

export async function slack(text) {
  const u = env('SLACK_WEBHOOK_URL');
  if (!u) return null;
  await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  return true;
}

/* ---------- day-before: what changed since the first brief ---------- */
export function diffResearch(before, after) {
  const out = [];
  const r0 = before?.reviews?.data, r1 = after?.reviews?.data;
  if (r0 && r1 && r1.count !== r0.count) out.push(`${r1.count - r0.count > 0 ? '+' : ''}${r1.count - r0.count} new Google reviews (now ${r1.rating}★ from ${r1.count}).`);
  const lows = (r1?.reviews || []).filter((x) => x.rating <= 2 && !(r0?.reviews || []).some((y) => y.text === x.text));
  if (lows.length) out.push(`New low review: "${lows[0].text.slice(0, 140)}"`);
  const n0 = new Set((before?.news?.data?.articles || []).map((a) => a.link));
  (after?.news?.data?.articles || []).filter((a) => !n0.has(a.link)).slice(0, 2).forEach((a) => out.push(`New article: ${a.title} (${a.source})`));
  const h0 = before?.hiring?.data?.roles?.length || 0, h1 = after?.hiring?.data?.roles?.length || 0;
  if (h1 > h0) out.push(`${h1 - h0} new job posts since they booked.`);
  return out.length ? out : ['Nothing new since the first brief.'];
}
