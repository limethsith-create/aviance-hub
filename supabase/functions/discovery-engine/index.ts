// Aviance discovery-call engine — one function, two jobs:
//   POST /discovery-engine            ← database trigger when a booking is saved
//   POST /discovery-engine/day-before ← pg_cron every hour
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleBooking, dayBefore } from "./pipeline.js";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let secret: string | null = null;
const getSecret = async () => secret ??= (await sb.rpc("aviance_webhook_secret")).data as string;

const db = {
  update: async (id: string, patch: Record<string, unknown>) => { await sb.from("discovery_bookings").update(patch).eq("id", id); },
  saveBrief: async (id: string, doc: any) => {
    const { error } = await sb.from("research_briefs").upsert({ booking_id: id, brief: doc.brief, raw: doc.raw, agents: doc.agents, writer: doc.writer, ms: doc.ms });
    if (error) throw new Error(error.message);
  },
  callsBetween: async (a: Date, b: Date) => (await sb.from("discovery_bookings").select("*").gte("call_at", a.toISOString()).lt("call_at", b.toISOString()).is("day_before_sent_at", null).neq("status", "cancelled")).data ?? [],
  getBrief: async (id: string) => (await sb.from("research_briefs").select("brief, raw").eq("booking_id", id).maybeSingle()).data,
};
const log = (booking_id: string | null) => (event: Record<string, unknown>) => { sb.from("research_log").insert({ booking_id, event }).then(() => {}); };

Deno.serve(async (req) => {
  const s = await getSecret();
  if (!s || req.headers.get("x-aviance-secret") !== s) return new Response("forbidden", { status: 403 });
  if (new URL(req.url).pathname.endsWith("/day-before")) {
    try { return Response.json({ ok: true, refreshed: await dayBefore(db, new Date(), log(null)) }); }
    catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
  }
  const body = await req.json().catch(() => ({}));
  const booking = body.record ?? body;
  if (!booking?.id || !booking?.company || !booking?.email || !booking?.call_at) return new Response("missing id/company/email/call_at", { status: 400 });
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(handleBooking(booking, db, log(booking.id)).catch((e) => log(booking.id)({ step: "fatal", error: String(e) })));
  return Response.json({ ok: true, booking: booking.id, status: "research started" });
});
