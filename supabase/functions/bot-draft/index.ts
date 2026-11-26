// Aviance OS — bot-draft. Called by the trigger on channel_messages (supabase/migrations/20261124_bot.sql)
// when a CLIENT writes a plain chat message. It drafts ONE reply and queues it with draft_write (kind 'reply').
// It never sends anything: the owner approves every draft in the hub (Replies, or inline in Channels).
//
// verify_jwt: false — it checks the header x-aviance-secret against public.aviance_webhook_secret() instead.
// Body: { message_id }.
// It answers 202 straight away and does the work in the background: the trigger's request gives up after
// 5 seconds, and a draft that takes longer than that (the model can) must not be lost with it.
//
// Data it reads (service role): the message, the channel -> client, the client person who wrote it (first name,
// time zone), the website booking answers (clients.booking_id -> discovery_bookings) and its research brief,
// the plan, the journey steps, the last 12 messages, invoices, meetings, testing days, open approvals / offers.
// With GROQ_API_KEY set it drafts with Groq (llama-3.3-70b-versatile) under the style rules; otherwise, or if the
// model fails, it uses the rules in rules.mjs (also unit-tested in tests/drafts.test.mjs).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildPrompt, cleanModelText, draftReply, journeySummary } from "./rules.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GROQ_KEY = (Deno.env.get("GROQ_API_KEY") ?? "").trim();
const GROQ_MODEL = "llama-3.3-70b-versatile";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let secretCache: string | null = null;
async function secretOk(given: string | null): Promise<boolean> {
  if (!given) return false;
  if (secretCache == null) {
    const { data, error } = await sb.rpc("aviance_webhook_secret");
    if (error || !data) return false;
    secretCache = String(data);
  }
  return given === secretCache;
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
async function rows(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  try { const r = await q; return r.error ? [] : ((r.data as Row[]) ?? []); } catch { return []; }
}
async function one(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row | null> {
  try { const r = await q; return r.error ? null : ((r.data as Row) ?? null); } catch { return null; }
}

async function groqDraft(ctx: Row): Promise<string> {
  if (!GROQ_KEY) return "";
  const { system, user } = buildPrompt(ctx);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + GROQ_KEY },
      body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.4, max_tokens: 200, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return "";
    const out = await res.json();
    return cleanModelText(out?.choices?.[0]?.message?.content ?? "");
  } catch { return ""; }
}

async function queueDraft(clientId: string, channelId: string, body: string, reason: string, messageId: string, meta: Row) {
  // the one helper every builder uses; it fills channel_id from the client's channel
  const r = await sb.rpc("draft_write", { p_client: clientId, p_kind: "reply", p_body: body, p_msg_kind: "bot", p_meta: meta, p_reason: reason });
  if (!r.error && r.data) {
    // tie the draft to the message it answers (and to this channel)
    const tie = await sb.from("bot_drafts").update({ source_message_id: messageId, channel_id: channelId }).eq("id", r.data);
    if (tie.error) {
      // Another run answered this message first (one reply per message is enforced by the table).
      // Take this copy away again so the owner does not see the same reply twice.
      await sb.from("bot_drafts").delete().eq("id", r.data).is("source_message_id", null);
      const first = await rows(sb.from("bot_drafts").select("id").eq("source_message_id", messageId).limit(1));
      if (first.length) return String(first[0].id);
      throw new Error("draft not saved: " + tie.error.message);
    }
    return String(r.data);
  }
  // draft_write refused (e.g. it checks for a team login): write the row directly with the service role
  const ins = await sb.from("bot_drafts").insert({ client_id: clientId, channel_id: channelId, kind: "reply", body, msg_kind: "bot", meta, reason, source_message_id: messageId }).select("id").single();
  if (ins.error) throw new Error("draft not saved: " + ins.error.message);
  return String(ins.data.id);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!(await secretOk(req.headers.get("x-aviance-secret")))) return json(401, { ok: false, error: "bad secret" });

  let messageId = "";
  try { messageId = String((await req.json())?.message_id ?? ""); } catch { /* empty */ }
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) return json(400, { ok: false, error: "message_id missing" });

  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") {
    rt.waitUntil(draftFor(messageId).then(async (res) => {
      if (res.status >= 500) console.error("bot-draft failed for message " + messageId + ": " + (await res.text()));
    }).catch((e) => console.error("bot-draft failed for message " + messageId + ": " + String((e as Error)?.message ?? e))));
    return json(202, { ok: true, started: true });
  }
  return await draftFor(messageId);      // no background runner (a local test): do it in line
});

async function draftFor(messageId: string): Promise<Response> {
  const msg = await one(sb.from("channel_messages").select("*").eq("id", messageId).maybeSingle());
  if (!msg) return json(404, { ok: false, error: "message not found" });
  if (!msg.author_person || (msg.msg_kind && msg.msg_kind !== "chat") || msg.deleted_at) return json(200, { ok: true, skipped: "not a client chat message" });

  const channel = await one(sb.from("channels").select("id,client_id,kind").eq("id", msg.channel_id).maybeSingle());
  if (!channel?.client_id) return json(200, { ok: true, skipped: "not a client channel" });
  const clientId = String(channel.client_id);

  // one pending reply per message: a retried webhook must not queue a second
  const dup = await rows(sb.from("bot_drafts").select("id").eq("source_message_id", messageId).limit(1));
  if (dup.length) return json(200, { ok: true, skipped: "already drafted", draft_id: dup[0].id });

  const today = new Date().toISOString().slice(0, 10);
  const [client, person, history, invoices, meetings, steps, testing, approvals, offers] = await Promise.all([
    one(sb.from("clients").select("id,company,contact_name,plan,term,stage,booking_id,day1_on").eq("id", clientId).maybeSingle()),
    one(sb.from("client_people").select("full_name,timezone").eq("id", msg.author_person).maybeSingle()),
    rows(sb.from("channel_messages").select("author_person,body,created_at,msg_kind").eq("channel_id", msg.channel_id).is("deleted_at", null).order("created_at", { ascending: false }).limit(12)),
    rows(sb.from("invoices").select("number,amount,currency,status,issued_on,due_on,paid_at,created_at").eq("client_id", clientId).order("issued_on", { ascending: false }).limit(5)),
    rows(sb.from("meetings").select("kind,title,starts_at,minutes,status,meet_link").eq("client_id", clientId).order("starts_at", { ascending: true })),
    rows(sb.from("journey_steps").select("step,title,position,planned_on,status,done_at").eq("client_id", clientId).order("position")),
    rows(sb.from("testing_days").select("on_date,sent,replies,leading_angle").eq("client_id", clientId).order("on_date")),
    rows(sb.from("approvals").select("kind,title,status").eq("client_id", clientId).eq("status", "pending")),
    rows(sb.from("schedule_offers").select("kind,status").eq("client_id", clientId).eq("status", "open")),
  ]);

  let booking: Row | null = null, brief: unknown = null;
  if (client?.booking_id) {
    booking = await one(sb.from("discovery_bookings").select("company,industry,goal,timeline,current_lead_gen,sells,capacity,tried_outbound,budget,timezone").eq("id", client.booking_id).maybeSingle());
    const rb = await one(sb.from("research_briefs").select("brief").eq("booking_id", client.booking_id).maybeSingle());
    brief = rb?.brief ?? null;
  }

  const ctx: Row = {
    text: msg.body ?? "",
    firstName: String(person?.full_name ?? client?.contact_name ?? "").trim().split(/\s+/)[0] || "",
    timezone: person?.timezone || booking?.timezone || "America/New_York",
    now: new Date(),
    company: client?.company ?? null,
    plan: client?.plan ?? null,
    booking, brief,
    meetings, invoices, testing, approvals, offers,
    journey: steps.length ? journeySummary(steps, today) : null,
    history: history.reverse().map((h) => ({ who: h.author_person ? "client" : "us", body: h.body })),
  };

  const rules = draftReply(ctx);
  const model = await groqDraft(ctx);
  const body = model || rules.body;
  const reason = (model ? "ai draft · " : "") + rules.reason;
  try {
    const id = await queueDraft(clientId, String(msg.channel_id), body, reason, messageId, { intent: rules.intent, source: model ? "groq" : "rules" });
    return json(200, { ok: true, draft_id: id, source: model ? "groq" : "rules" });
  } catch (e) {
    return json(500, { ok: false, error: String((e as Error).message ?? e) });
  }
}
