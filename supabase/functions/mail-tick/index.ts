// Aviance OS — the mail room. Runs every minute on a schedule.
//
// Nothing in the browser sends mail. Everything that needs an email writes a
// row to mail_outbox; this job picks the rows up and hands them to the Apps
// Script that lives inside aviancelk@gmail.com, which is the only thing that
// can send as that address or make a Google Meet link.
//
//   1. queue_due_reminders()  -> anything due a day / hour / five-minute nudge
//   2. for a booking confirmation with no Google Meet yet:
//        the script makes the calendar event + Meet link, Google sends the
//        invite, the script sends our email, and the link is saved on the booking
//   3. for everything else: the script just sends the email, with the
//        booking's own Meet link put in place of {{MEET_LINK}}
//
// Secrets (Supabase > Edge Functions > Secrets), never in this file:
//   APPS_SCRIPT_URL     the script's web app address
//   APPS_SCRIPT_SECRET  the same phrase as SHARED_SECRET in the script's properties
//
// With either missing it runs as a rehearsal: everything except the send,
// and it reports what would have gone out.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SCRIPT_URL    = (Deno.env.get("APPS_SCRIPT_URL") ?? "").trim();
const SCRIPT_SECRET = (Deno.env.get("APPS_SCRIPT_SECRET") ?? "").trim();

const MAX_ATTEMPTS = 5;
const BATCH = 20;
const live = () => !!(SCRIPT_URL && SCRIPT_SECRET);

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const fill = (s: string | null, link: string) => String(s ?? "").replaceAll("{{MEET_LINK}}", link);
const isGoogleMeet = (l: string) => /(^|\/\/)meet\.google\.com\//.test(l);

type ScriptAnswer = { ok: boolean; error?: string; meetLink?: string; eventId?: string };

async function callScript(payload: Record<string, unknown>): Promise<ScriptAnswer> {
  // Apps Script answers a POST with a redirect to the real response; fetch follows it.
  const r = await fetch(SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret: SCRIPT_SECRET, ...payload }),
    redirect: "follow",
  });
  const text = await r.text();
  try {
    return JSON.parse(text) as ScriptAnswer;
  } catch {
    return { ok: false, error: "The mail script did not answer properly (" + r.status + "): " + text.slice(0, 160) };
  }
}

Deno.serve(async () => {
  const out = { mode: live() ? "live" : "rehearsal", queued: null as unknown, sent: 0, failed: 0, held: 0, would_send: [] as unknown[] };

  const q = await sb.rpc("queue_due_reminders");
  if (q.error) return json({ ok: false, error: q.error.message, ...out }, 500);
  out.queued = q.data;

  const { data: rows, error } = await sb.from("v_mail_to_send").select("*").limit(BATCH);
  if (error) return json({ ok: false, error: error.message, ...out }, 500);
  if (!rows?.length) return json({ ok: true, nothing_to_do: true, ...out });

  for (const r of rows) {
    const link = String(r.meet_link ?? "").trim();
    const makeMeeting = r.kind === "booking_confirmation" && !!r.booking_id && !isGoogleMeet(link);

    // A reminder with no link at all is held, never sent broken.
    if (!makeMeeting && r.needs_meet_link && !link) {
      await sb.from("mail_outbox").update({
        last_error: "Waiting for a meeting link on the booking.",
        send_after: new Date(Date.now() + 10 * 60_000).toISOString(),
      }).eq("id", r.id);
      out.held++;
      continue;
    }

    if (!live()) {
      out.would_send.push({ to: r.to_email, subject: r.subject, kind: r.kind,
        meet_link: makeMeeting ? "(a new Google Meet would be made)" : link });
      continue;
    }

    // Claim it first. A row left at 'sending' is never picked up again, so a
    // crash here can cost one email but can never send the same one twice.
    const attempts = (r.attempts ?? 0) + 1;
    const claim = await sb.from("mail_outbox").update({ status: "sending", attempts })
      .eq("id", r.id).in("status", ["pending", "failed"]).select("id");
    if (claim.error || !claim.data?.length) continue;

    try {
      let usedLink = link;
      let answer: ScriptAnswer;

      if (makeMeeting) {
        answer = await callScript({
          mode: "meeting",
          ref: r.booking_id,
          toEmail: r.guest_email || r.to_email,
          toName: r.guest_name || r.to_name || "",
          startsAt: r.starts_at,
          minutes: r.minutes || 30,
          subject: r.subject,
          bodyText: r.body_text,          // the script swaps {{MEET_LINK}} for the link it just made
          bodyHtml: r.body_html || "",
        });
        if (answer.ok && !answer.meetLink) answer = { ok: false, error: "Google made the event but gave no Meet link." };
        if (answer.ok) {
          usedLink = String(answer.meetLink);
          await sb.from("discovery_bookings")
            .update({ meet_link: usedLink, calendar_event_id: answer.eventId ?? null })
            .eq("id", r.booking_id);
        }
      } else {
        answer = await callScript({
          mode: "mail",
          toEmail: r.to_email,
          toName: r.to_name || "",
          subject: r.subject,
          bodyText: fill(r.body_text, usedLink),
          bodyHtml: r.body_html ? fill(r.body_html, usedLink) : "",
        });
      }

      if (!answer.ok) throw new Error(answer.error || "The mail script said no.");

      await sb.from("mail_outbox").update({
        status: "sent", sent_at: new Date().toISOString(), last_error: null,
        gmail_message_id: answer.eventId ?? null,
        body_text: fill(r.body_text, usedLink),
        body_html: r.body_html ? fill(r.body_html, usedLink) : null,
        ics: null,                         // Google's own invite carries the calendar file
      }).eq("id", r.id);
      out.sent++;
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      await sb.from("mail_outbox").update({
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        last_error: msg,
        send_after: new Date(Date.now() + attempts * 5 * 60_000).toISOString(),
      }).eq("id", r.id);
      out.failed++;
    }
  }

  return json({ ok: true, ...out });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
