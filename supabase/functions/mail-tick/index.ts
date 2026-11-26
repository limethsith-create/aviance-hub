// Aviance OS — the mail room. Runs every minute on a schedule, and that is the only thing that
// starts it: a queued email goes out on the next cron minute, not the moment it is written.
// (A mail_outbox_kick trigger that would poke this function straight away is written up in
// supabase/migrations/20261202_mail_instant_send_NOT_APPLIED.sql, but it is deliberately NOT
// applied to the live database, so do not count on it.)
//
// Nothing in the browser sends mail. Everything that needs an email writes a
// row to mail_outbox; this job picks the rows up and hands them to the Apps
// Script that lives inside aviancelk@gmail.com, which is the only thing that
// can send as that address or make a Google Meet link.
//
//   1. queue_due_reminders()  -> anything due a day / hour / five-minute nudge; it also drops
//      reminders that are now too late to be useful and puts back a send that was cut off
//   2. for a booking confirmation with no Google Meet yet (a website booking, or a
//      meeting booked in Aviance OS such as a client's kickoff):
//        the script makes the calendar event + Meet link, Google sends the
//        invite, the script sends our email, and the link is saved on the row
//   3. for everything else: the script just sends the email, with the
//        booking's own Meet link put in place of {{MEET_LINK}}
//
// Order and speed: the most urgent mail goes first (a five-minute reminder never waits behind a
// welcome email), up to PARALLEL at once, every call to the script has a time limit, and a tick
// stops picking up new rows after BUDGET_MS so two ticks do not pile up.
//
// Secrets (Supabase > Edge Functions > Secrets), never in this file:
//   APPS_SCRIPT_URL     the script's web app address
//   APPS_SCRIPT_SECRET  the same phrase as SHARED_SECRET in the script's properties
//
// With either missing it runs as a rehearsal: everything except the send,
// and it reports what would have gone out.
//
// Who may call it: verify_jwt is on, so the gateway wants the project's public key. That key is
// public, so the report (addresses, subjects, errors) only goes back to a caller that also sends
// the header x-aviance-secret. Anyone else gets { ok: true } and nothing more.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SCRIPT_URL    = (Deno.env.get("APPS_SCRIPT_URL") ?? "").trim();
const SCRIPT_SECRET = (Deno.env.get("APPS_SCRIPT_SECRET") ?? "").trim();

const MAX_ATTEMPTS = 5;
const BATCH = 20;            // rows sent per tick
const FETCH = 60;            // rows looked at per tick, so an urgent one is never out of sight
const PARALLEL = 4;          // sends in flight at once
const BUDGET_MS = 45_000;    // stop starting new sends after this; the next tick carries on
const MAIL_TIMEOUT_MS = 25_000;
const MEETING_TIMEOUT_MS = 40_000;   // making a calendar event and a Meet link takes longer
const live = () => !!(SCRIPT_URL && SCRIPT_SECRET);

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const fill = (s: string | null, link: string) => String(s ?? "").replaceAll("{{MEET_LINK}}", link);
const isGoogleMeet = (l: string) => /(^|\/\/)meet\.google\.com\//.test(l);

/** Lower goes first. The same order as the `priority` column of v_mail_to_send. */
const PRIORITY: Record<string, number> = {
  reminder_5min: 0, reminder_1h: 1, booking_confirmation: 2,
  staff_invite: 3, portal_invite: 3, agreement: 3, reminder_24h: 4,
};
const priorityOf = (kind: string) => PRIORITY[kind] ?? 5;

/** How long to wait before the next try. A reminder that has minutes to live is retried fast. */
function retryAfterMs(kind: string, attempts: number): number {
  if (kind === "reminder_5min") return 45_000;
  if (kind === "reminder_1h") return 2 * 60_000;
  if (kind === "booking_confirmation" || kind === "staff_invite" || kind === "portal_invite" || kind === "agreement") {
    return Math.min(attempts * 2, 10) * 60_000;
  }
  return attempts * 5 * 60_000;
}

type ScriptAnswer = { ok: boolean; error?: string; meetLink?: string; eventId?: string };
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function callScript(payload: Record<string, unknown>, timeoutMs: number): Promise<ScriptAnswer> {
  // Apps Script answers a POST with a redirect to the real response; fetch follows it.
  // The time limit matters: without one a hung script held the whole queue until the function was killed.
  let r: Response;
  try {
    r = await fetch(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: SCRIPT_SECRET, ...payload }),
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    return { ok: false, error: name === "TimeoutError" || name === "AbortError"
      ? "The mail script took longer than " + Math.round(timeoutMs / 1000) + " seconds to answer."
      : "The mail script could not be reached: " + String((e as Error)?.message ?? e).slice(0, 160) };
  }
  const text = await r.text().catch(() => "");
  try {
    return JSON.parse(text) as ScriptAnswer;
  } catch {
    return { ok: false, error: "The mail script did not answer properly (" + r.status + "): " + text.slice(0, 160) };
  }
}

let secretCache: string | null = null;
/** True when the caller sent the webhook secret. Never throws; an unknown caller is just not trusted. */
async function trusted(req: Request): Promise<boolean> {
  const given = req.headers.get("x-aviance-secret") ?? "";
  if (!given) return false;
  if (secretCache == null) {
    const { data, error } = await sb.rpc("aviance_webhook_secret");
    if (error || !data) return false;
    secretCache = String(data);
  }
  return given === secretCache;
}

type Tally = { sent: number; failed: number; held: number; would_send: unknown[] };

async function sendOne(r: Row, out: Tally): Promise<void> {
  const link = String(r.meet_link ?? "").trim();
  const makeMeeting = r.kind === "booking_confirmation" && (!!r.booking_id || !!r.meeting_id) && !isGoogleMeet(link);

  // A reminder with no link at all is held, never sent broken.
  if (!makeMeeting && r.needs_meet_link && !link) {
    await sb.from("mail_outbox").update({
      last_error: "Waiting for a meeting link on the booking.",
      send_after: new Date(Date.now() + (r.kind === "reminder_5min" ? 1 : 5) * 60_000).toISOString(),
    }).eq("id", r.id).in("status", ["pending", "failed"]);
    out.held++;
    return;
  }

  if (!live()) {
    out.would_send.push({ to: r.to_email, subject: r.subject, kind: r.kind,
      meet_link: makeMeeting ? "(a new Google Meet would be made)" : link });
    return;
  }

  // Claim it first, so two ticks can never both send it. send_after is stamped with the claim time:
  // queue_due_reminders() uses it to spot a send that was cut off and puts the row back.
  const attempts = (r.attempts ?? 0) + 1;
  const claim = await sb.from("mail_outbox")
    .update({ status: "sending", attempts, send_after: new Date().toISOString() })
    .eq("id", r.id).in("status", ["pending", "failed"]).select("id");
  if (claim.error || !claim.data?.length) return;

  try {
    let usedLink = link;
    let answer: ScriptAnswer;

    if (makeMeeting) {
      answer = await callScript({
        mode: "meeting",
        ref: r.booking_id || r.meeting_id,
        toEmail: r.guest_email || r.to_email,
        toName: r.guest_name || r.to_name || "",
        startsAt: r.starts_at,
        minutes: r.minutes || 30,
        subject: r.subject,
        bodyText: r.body_text,          // the script swaps {{MEET_LINK}} for the link it just made
        bodyHtml: r.body_html || "",
      }, MEETING_TIMEOUT_MS);
      if (answer.ok && !answer.meetLink) answer = { ok: false, error: "Google made the event but gave no Meet link." };
      if (answer.ok) {
        usedLink = String(answer.meetLink);
        // a website booking, or a meeting booked in Aviance OS (a client's kickoff, one added by hand)
        await sb.from(r.booking_id ? "discovery_bookings" : "meetings")
          .update({ meet_link: usedLink, calendar_event_id: answer.eventId ?? null })
          .eq("id", r.booking_id || r.meeting_id);
      }
    } else {
      answer = await callScript({
        mode: "mail",
        toEmail: r.to_email,
        toName: r.to_name || "",
        subject: r.subject,
        bodyText: fill(r.body_text, usedLink),
        bodyHtml: r.body_html ? fill(r.body_html, usedLink) : "",
      }, MAIL_TIMEOUT_MS);
    }

    if (!answer.ok) throw new Error(answer.error || "The mail script said no.");

    const done = await sb.from("mail_outbox").update({
      status: "sent", sent_at: new Date().toISOString(), last_error: null,
      gmail_message_id: answer.eventId ?? null,
      body_text: fill(r.body_text, usedLink),
      body_html: r.body_html ? fill(r.body_html, usedLink) : null,
      ics: null,                         // Google's own invite carries the calendar file
    }).eq("id", r.id);
    if (done.error) {
      // The email went, but the full update was refused. Mark it sent anyway, with nothing else in
      // the update that could be refused, so it is never sent a second time.
      await sb.from("mail_outbox").update({ status: "sent", sent_at: new Date().toISOString(),
        last_error: "Sent, but the record could not be tidied: " + String(done.error.message).slice(0, 300) }).eq("id", r.id);
    }
    out.sent++;
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 500);
    await sb.from("mail_outbox").update({
      status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      last_error: msg,
      send_after: new Date(Date.now() + retryAfterMs(String(r.kind), attempts)).toISOString(),
    }).eq("id", r.id);
    out.failed++;
  }
}

Deno.serve(async (req) => {
  const started = Date.now();
  const tell = await trusted(req);
  const out = { mode: live() ? "live" : "rehearsal", queued: null as unknown, sent: 0, failed: 0, held: 0, left: 0, would_send: [] as unknown[] };
  // Only a caller with the secret is told what happened; the public key alone gets a bare ok.
  const answer = (body: Record<string, unknown>, status = 200) => json(tell ? body : { ok: body.ok }, status);

  const q = await sb.rpc("queue_due_reminders");
  if (q.error) return answer({ ok: false, error: q.error.message, ...out }, 500);
  out.queued = q.data;

  const { data, error } = await sb.from("v_mail_to_send").select("*").limit(FETCH);
  if (error) return answer({ ok: false, error: error.message, ...out }, 500);
  if (!data?.length) return answer({ ok: true, nothing_to_do: true, ...out });

  // Most urgent first. Sorted here as well as in the view, so this works whichever is deployed first.
  const rows = (data as Row[]).slice()
    .sort((a, b) => priorityOf(String(a.kind)) - priorityOf(String(b.kind)));
  const todo = rows.slice(0, BATCH);
  out.left = rows.length - todo.length;

  // A few at a time: one slow send no longer holds up the rest of the queue.
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      if (Date.now() - started > BUDGET_MS) return;
      const r = todo[next++];
      try { await sendOne(r, out); } catch { out.failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
  out.left += todo.length - next;

  return answer({ ok: true, ...out });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
