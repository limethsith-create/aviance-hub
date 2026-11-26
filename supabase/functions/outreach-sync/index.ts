// Aviance OS — outreach-sync. Every fifteen minutes this reads each client's sending tool and
// writes what it finds into the outreach_* tables, so the portal can draw a client's campaign
// from our own database in one query and keeps drawing it when the provider's API is down.
//
//   for each row in outreach_accounts:
//     1. find the account's API key in Deno.env, by the name in key_ref
//     2. campaigns + their totals            -> outreach_campaigns
//     3. per-day numbers for the window      -> outreach_daily
//     4. sending inboxes and their health    -> outreach_inboxes
//     5. prospect conversations              -> outreach_threads + outreach_messages
//     6. link a thread to a real call        -> outreach_threads.meeting_id
//     7. stamp last_synced_at, clear last_error
//
// Both providers land on the same tables. Every mapping lives in ./map.mjs, which is pure and is
// unit-tested against recorded fixtures in ./fixtures, so the whole shape of this job is proven
// without a live key: the day the keys are set it simply starts returning real numbers.
//
// One account can never hurt another. Every account is wrapped: a missing key, a 401, a 429, a
// timeout or a renamed field is written to outreach_accounts.last_error and the loop carries on.
// Nothing here throws out of the handler and nothing here is ever retried in a tight loop.
//
// Secrets (Supabase > Edge Functions > Secrets), never in this repo:
//   OUTREACH_INSTANTLY_<LABEL>   an Instantly API v2 key  (Settings shows the exact name)
//   OUTREACH_SMARTLEAD_<LABEL>   a Smartlead API key
// outreach_accounts.key_ref holds that NAME. With the secret missing the account is marked
// needs_key, its last_error says which name to set, and every other account still syncs.
//
// Who may call it: verify_jwt is on, so the gateway wants the project's public key — that is what
// the pg_cron job sends. The key is public, so the detailed report only goes back to a caller that
// also sends the header x-aviance-secret (the same one the other jobs send). Anyone else gets
// { ok: true } and nothing more.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  oxEnvCandidates, oxWindow,
  oxInstantlyCampaign, oxInstantlyDaily, oxInstantlyInbox, oxInstantlyThreads,
  oxSmartleadCampaign, oxSmartleadDaily, oxSmartleadInbox, oxSmartleadCategories,
  oxSmartleadThread, oxSmartleadMessages,
  oxLinkMeetings, oxBookedFromThreads, oxPositiveFromThreads,
} from "./map.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PAGE = 100;              // the biggest page both providers allow
const MAX_PAGES = 20;          // 2000 rows of anything in one tick, then wait for the next
const MAX_THREAD_FETCH = 40;   // Smartlead message histories per account per tick (it rate-limits)
const BUDGET_MS = 110_000;     // stop starting new work after this; the next tick carries on
const HTTP_TIMEOUT_MS = 20_000;
const GAP_MS = 250;            // a breath between calls, so we never trip a per-minute limit

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

let secretCache: string | null = null;
/** True when the caller sent the webhook secret, the same check mail-tick and bot-draft make.
    Never throws; an unknown caller is simply not trusted and gets no report. */
async function trustedCaller(req: Request): Promise<boolean> {
  const given = req.headers.get("x-aviance-secret") ?? "";
  if (!given) return false;
  if (secretCache == null) {
    const { data, error } = await sb.rpc("aviance_webhook_secret");
    if (error || !data) return false;
    secretCache = String(data);
  }
  return given === secretCache;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** The only way out of this file. A thrown error becomes a message, never a 500. */
function reason(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e ?? "something went wrong");
  return String(m).slice(0, 500);
}

/** One GET, with a time limit. 429 and 5xx are reported, never hammered. */
async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = String(j.message ?? j.error ?? msg) } catch { /* plain text */ }
      if (res.status === 401 || res.status === 403) throw new Error(`the key was refused (${res.status}): ${msg}`);
      if (res.status === 402) throw new Error(`the provider says the plan does not cover this: ${msg}`);
      if (res.status === 429) throw new Error(`rate limited by the provider; the next tick will carry on: ${msg}`);
      throw new Error(`${res.status} from the provider: ${msg}`);
    }
    try { return JSON.parse(text) } catch { throw new Error("the provider answered with something that is not JSON") }
  } finally { clearTimeout(t) }
}

/* ---------------------------------------------------------------- Instantly */

const IN_BASE = "https://api.instantly.ai/api/v2";
const inHeaders = (key: string) => ({ Authorization: `Bearer ${key}`, Accept: "application/json" });

/** Instantly pages with a cursor: items + next_starting_after. */
async function inPaged(path: string, key: string, params: Record<string, string> = {}): Promise<Row[]> {
  const out: Row[] = [];
  let after: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({ ...params, limit: String(PAGE) });
    if (after) q.set("starting_after", after);
    const body = await getJson(`${IN_BASE}${path}?${q}`, inHeaders(key)) as Row;
    const items: Row[] = Array.isArray(body?.items) ? body.items : (Array.isArray(body) ? body as Row[] : []);
    out.push(...items);
    after = (body?.next_starting_after ?? null) as string | null;
    if (!after || items.length === 0) break;
    await sleep(GAP_MS);
  }
  return out;
}

/* ---------------------------------------------------------------- Smartlead */

const SL_BASE = "https://server.smartlead.ai/api/v1";
/** Smartlead takes the key as a query parameter, so it is built in here and never logged. */
const slUrl = (path: string, key: string, params: Record<string, string> = {}) =>
  `${SL_BASE}${path}?${new URLSearchParams({ ...params, api_key: key })}`;
const slGet = (path: string, key: string, params: Record<string, string> = {}) =>
  getJson(slUrl(path, key, params), { Accept: "application/json" });

/** Smartlead pages with offset/limit. */
async function slPaged(path: string, key: string, params: Record<string, string> = {}): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = await slGet(path, key, { ...params, offset: String(i * PAGE), limit: String(PAGE) });
    const items: Row[] = Array.isArray(body) ? body as Row[]
      : Array.isArray((body as Row)?.data) ? (body as Row).data : [];
    out.push(...items);
    if (items.length < PAGE) break;
    await sleep(GAP_MS);
  }
  return out;
}

/* ------------------------------------------------------------- the database */

/** Upsert on the unique index the schema already carries, so a second tick changes rows, never adds them. */
async function upsert(table: string, rows: Row[], onConflict: string) {
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb.from(table).upsert(chunk, { onConflict, ignoreDuplicates: false });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  return rows.length;
}

/* ------------------------------------------------------------- one account */

type Tally = { campaigns: number; days: number; inboxes: number; threads: number; messages: number; booked: number };

async function syncAccount(acc: Row, key: string, deadline: number): Promise<Tally> {
  const tally: Tally = { campaigns: 0, days: 0, inboxes: 0, threads: 0, messages: 0, booked: 0 };
  const now = new Date();
  const win = oxWindow(acc.last_synced_at, now);
  const client_id = acc.client_id;
  const instantly = acc.provider === "instantly";

  /* --- inboxes --- */
  const rawInboxes = instantly
    ? await inPaged("/accounts", key)
    : await slPaged("/email-accounts/", key);
  const inboxRows = rawInboxes
    .map((a) => (instantly ? oxInstantlyInbox(a) : oxSmartleadInbox(a)))
    .filter((r) => r.email)
    .map((r) => ({ ...r, account_id: acc.id, client_id, last_synced_at: now.toISOString() }));
  tally.inboxes = await upsert("outreach_inboxes", inboxRows, "account_id,email");

  /* --- campaigns + their totals --- */
  const rawCampaigns = instantly
    ? await inPaged("/campaigns", key)
    : await slPaged("/campaigns/", key);

  // Instantly gives every campaign's totals in one call; Smartlead gives one campaign at a time.
  const inTotals = new Map<string, Row>();
  if (instantly) {
    const list = await getJson(`${IN_BASE}/campaigns/analytics?exclude_total_leads_count=true`, inHeaders(key));
    for (const a of (Array.isArray(list) ? list as Row[] : [])) inTotals.set(String(a.campaign_id), a);
  }

  const campaignRows: Row[] = [];
  for (const c of rawCampaigns) {
    let mapped: Row;
    if (instantly) {
      mapped = oxInstantlyCampaign(c, inTotals.get(String(c.id)));
    } else {
      let an: Row | null = null;
      try {
        an = await slGet(`/campaigns/${c.id}/analytics-by-date`, key,
          { start_date: win.start_date, end_date: win.end_date }) as Row;
      } catch (_e) { /* a campaign with no numbers yet is still a campaign */ }
      mapped = oxSmartleadCampaign(c, an);
      await sleep(GAP_MS);
    }
    if (!mapped.external_id) continue;
    campaignRows.push({ ...mapped, account_id: acc.id, client_id, last_synced_at: now.toISOString() });
    if (Date.now() > deadline) break;
  }
  tally.campaigns = await upsert("outreach_campaigns", campaignRows, "account_id,external_id");

  // the ids the rest of this run needs: external id -> our uuid
  const { data: saved, error: savedErr } = await sb.from("outreach_campaigns")
    .select("id,external_id").eq("account_id", acc.id);
  if (savedErr) throw new Error(`outreach_campaigns read back: ${savedErr.message}`);
  const idOf = new Map<string, string>((saved ?? []).map((r: Row) => [String(r.external_id), r.id]));

  /* --- per-day numbers --- */
  const dailyRows: Row[] = [];
  for (const c of campaignRows) {
    const cid = idOf.get(String(c.external_id));
    if (!cid) continue;
    try {
      const rows = instantly
        ? oxInstantlyDaily(await getJson(
            `${IN_BASE}/campaigns/analytics/daily?${new URLSearchParams({ campaign_id: String(c.external_id), start_date: win.start_date, end_date: win.end_date })}`,
            inHeaders(key)) as Row[])
        : oxSmartleadDaily(await slGet("/analytics/day-wise-overall-stats", key,
            { campaign_ids: String(c.external_id), start_date: win.start_date, end_date: win.end_date }));
      for (const r of rows) dailyRows.push({ ...r, campaign_id: cid, client_id });
    } catch (_e) { /* one campaign's chart is not worth the whole sync */ }
    await sleep(GAP_MS);
    if (Date.now() > deadline) break;
  }
  tally.days = await upsert("outreach_daily", dailyRows, "campaign_id,on_day");

  /* --- conversations --- */
  // Only what changed since the last run: the portal's inbox grows, it is never re-read whole.
  const since = acc.last_synced_at ? new Date(new Date(acc.last_synced_at).getTime() - 3600_000).toISOString() : null;
  const threadsByCampaign = new Map<string, Row[]>();
  const threadRows: Row[] = [];
  const messagesFor: { ext: string; campaign_id: string; messages: Row[] }[] = [];

  if (instantly) {
    // One feed carries both the threads and their messages.
    const emails = await inPaged("/emails", key, since ? { min_timestamp_created: since } : {});
    for (const { thread, messages } of oxInstantlyThreads(emails)) {
      const cid = thread.campaign_external_id ? idOf.get(String(thread.campaign_external_id)) : null;
      if (!cid) continue;                      // a thread with no campaign has nowhere to hang
      const { campaign_external_id: _drop, ...t } = thread;
      threadRows.push({ ...t, campaign_id: cid, client_id });
      messagesFor.push({ ext: String(thread.external_id), campaign_id: cid, messages });
    }
  } else {
    const cats = oxSmartleadCategories(await slGet("/leads/fetch-categories", key) as Row[]);
    let fetched = 0;
    for (const c of campaignRows) {
      const cid = idOf.get(String(c.external_id));
      if (!cid) continue;
      // only leads that answered: those are the conversations a client wants to read
      const leads = await slPaged(`/campaigns/${c.external_id}/leads`, key,
        { emailStatus: "is_replied", ...(since ? { event_time_gt: since.slice(0, 10) } : {}) });
      for (const item of leads) {
        const t = oxSmartleadThread(item, cats);
        if (!t.external_id) continue;
        const { lead_id, ...row } = t;
        threadRows.push({ ...row, campaign_id: cid, client_id });
        if (fetched < MAX_THREAD_FETCH && lead_id && Date.now() < deadline) {
          fetched++;
          try {
            const hist = await slGet(`/campaigns/${c.external_id}/leads/${lead_id}/message-history`, key,
              since ? { event_time_gt: since } : {});
            messagesFor.push({ ext: String(t.external_id), campaign_id: cid, messages: oxSmartleadMessages(hist) });
          } catch (_e) { /* one conversation's body is not worth the whole sync */ }
          await sleep(GAP_MS);
        }
      }
      if (Date.now() > deadline) break;
    }
  }

  // a thread that belongs to a call we really held gets that call's id, and reads as booked
  const { data: mtgs } = await sb.from("meetings").select("id,guest_email,held_at").eq("client_id", client_id);
  const linked = oxLinkMeetings(threadRows, (mtgs ?? []) as Row[]);
  tally.threads = await upsert("outreach_threads", linked, "campaign_id,external_id");
  tally.booked = linked.filter((t) => t.meeting_id).length;

  for (const t of linked) {
    const list = threadsByCampaign.get(String(t.campaign_id)) ?? [];
    list.push(t);
    threadsByCampaign.set(String(t.campaign_id), list);
  }

  /* --- messages, once their threads have ids --- */
  if (messagesFor.length) {
    const { data: savedThreads, error: stErr } = await sb.from("outreach_threads")
      .select("id,external_id,campaign_id").eq("client_id", client_id);
    if (stErr) throw new Error(`outreach_threads read back: ${stErr.message}`);
    const threadId = new Map<string, string>((savedThreads ?? [])
      .map((r: Row) => [`${r.campaign_id}|${r.external_id}`, r.id]));
    const messageRows: Row[] = [];
    for (const m of messagesFor) {
      const tid = threadId.get(`${m.campaign_id}|${m.ext}`);
      if (!tid) continue;
      for (const row of m.messages) messageRows.push({ ...row, thread_id: tid, client_id });
    }
    tally.messages = await upsert("outreach_messages", messageRows, "thread_id,external_id");
  }

  /* --- what the portal shows as booked and positive comes from our own threads --- */
  for (const [cid, list] of threadsByCampaign) {
    const booked = oxBookedFromThreads(list);
    const patch: Row = { booked };
    if (!instantly) patch.positive = oxPositiveFromThreads(list);   // Smartlead reports no total
    const { error } = await sb.from("outreach_campaigns").update(patch).eq("id", cid);
    if (error) throw new Error(`outreach_campaigns booked: ${error.message}`);
  }

  return tally;
}

/* ------------------------------------------------------------------ handler */

Deno.serve(async (req: Request) => {
  const trusted = await trustedCaller(req);
  const report: Row[] = [];
  const started = Date.now();
  const deadline = started + BUDGET_MS;

  try {
    const { data: accounts, error } = await sb.from("outreach_accounts")
      .select("id,client_id,provider,label,external_id,key_ref,status,last_synced_at")
      .in("provider", ["instantly", "smartlead"])
      .neq("status", "paused")
      .order("last_synced_at", { ascending: true, nullsFirst: true });
    if (error) throw new Error(error.message);

    for (const acc of (accounts ?? [])) {
      const line: Row = { account: acc.id, label: acc.label, provider: acc.provider };
      try {
        if (Date.now() > deadline) { line.skipped = "out of time this tick"; report.push(line); continue }

        const names = oxEnvCandidates(acc.key_ref);
        const name = names.find((n) => (Deno.env.get(n) ?? "").trim());
        const key = name ? (Deno.env.get(name) ?? "").trim() : "";
        if (!key) {
          // No key is not an error in this job; it is a thing the owner has not done yet.
          const want = acc.key_ref ? String(acc.key_ref) : `OUTREACH_${String(acc.provider).toUpperCase()}_<LABEL>`;
          await sb.from("outreach_accounts").update({
            status: "needs_key",
            last_error: `No API key yet. Set the Supabase secret ${want} and this account syncs on the next tick.`,
          }).eq("id", acc.id);
          line.skipped = "needs_key";
          line.secret_expected = want;
          report.push(line);
          continue;                                  // every other account still syncs
        }

        const tally = await syncAccount(acc, key, deadline);
        await sb.from("outreach_accounts").update({
          status: "ok", last_error: null, last_synced_at: new Date().toISOString(),
        }).eq("id", acc.id);
        Object.assign(line, tally, { ok: true });
      } catch (e) {
        // the provider is down, the key was refused, a field moved: write it down and carry on
        line.ok = false;
        line.error = reason(e);
        try {
          await sb.from("outreach_accounts").update({ status: "error", last_error: line.error }).eq("id", acc.id);
        } catch (_inner) { /* if even this fails, the next tick tries again */ }
      }
      report.push(line);
    }
  } catch (e) {
    report.push({ ok: false, error: reason(e) });
  }

  const body = trusted
    ? { ok: true, ms: Date.now() - started, accounts: report }
    : { ok: true };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", Connection: "keep-alive" },
  });
});
