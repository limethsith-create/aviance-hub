// Aviance OS — calendar-connect
// The client connects their own calendar in one click, so booked calls land on
// it and we can see their free time.
//
// Three routes:
//   POST /calendar-connect/start     {client_id, provider, return_to}
//        with the caller's own Supabase JWT. Answers {ok:true, url} to send the
//        browser to, or {ok:true, needs_token:true} for Calendly.
//   GET  /calendar-connect/callback  ?code=&state=
//        the provider sends them back here. Swaps the code for tokens, saves
//        them, and sends the person back where they started.
//   POST /calendar-connect/calendly  {client_id, token}
//        Calendly has no OAuth app to review for a single-account integration,
//        so the client pastes a personal access token. It is checked against
//        Calendly before it is stored.
//
// THIS FUNCTION IS THE ONLY THING THAT EVER SEES AN OAUTH CREDENTIAL. They are
// Supabase secrets, read by name. Nothing is defaulted, invented or committed:
//
//   GOOGLE_CALENDAR_CLIENT_ID        GOOGLE_CALENDAR_CLIENT_SECRET
//   MICROSOFT_CALENDAR_CLIENT_ID     MICROSOFT_CALENDAR_CLIENT_SECRET
//   MICROSOFT_CALENDAR_TENANT        (optional; 'common' when unset)
//   CALENDAR_CONNECT_REDIRECT        (optional; this function's own /callback)
//
// A missing secret is said in plain English ("Google Calendar is not set up
// yet"), never as a stack trace, and never by guessing a value.
//
// The client's own tokens are per-client and minted at runtime, so they cannot
// be Supabase secrets. They go to public.calendar_tokens, which has RLS on and
// no policy at all: only this function's service role can read them.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const svc = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ALLOWED = /^https:\/\/([a-z0-9-]+\.)*(aviance\.store|aviance\.online|vercel\.app)$/i;
const cors = (req: Request) => {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.test(o) ? o : "https://aviance.store",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  };
};
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const no = (req: Request, error: string, status = 400) => json(req, { ok: false, error }, status);

const SITE = "https://aviance.store";
const redirectUri = () =>
  Deno.env.get("CALENDAR_CONNECT_REDIRECT") ?? `${SB_URL}/functions/v1/calendar-connect/callback`;

// ---- what we ask each provider for, and nothing more ----
// Google: freebusy to see when they are busy, calendar.events to put a booked
// call on their calendar. Not calendar.readonly: we do not need their titles.
const GOOGLE = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  scopes: [
    "openid", "email", "profile",
    "https://www.googleapis.com/auth/calendar.freebusy",
    "https://www.googleapis.com/auth/calendar.events",
  ].join(" "),
};
// Microsoft: Calendars.ReadWrite covers both reading free/busy and writing an
// event. offline_access is what makes a refresh token come back.
const MS_TENANT = () => Deno.env.get("MICROSOFT_CALENDAR_TENANT") ?? "common";
const MICROSOFT = () => ({
  auth: `https://login.microsoftonline.com/${MS_TENANT()}/oauth2/v2.0/authorize`,
  token: `https://login.microsoftonline.com/${MS_TENANT()}/oauth2/v2.0/token`,
  scopes: ["openid", "email", "profile", "offline_access", "https://graph.microsoft.com/Calendars.ReadWrite"].join(" "),
});

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}
const creds = (provider: string) => {
  const id = Deno.env.get(provider === "google" ? "GOOGLE_CALENDAR_CLIENT_ID" : "MICROSOFT_CALENDAR_CLIENT_ID") ?? "";
  const secret = Deno.env.get(provider === "google" ? "GOOGLE_CALENDAR_CLIENT_SECRET" : "MICROSOFT_CALENDAR_CLIENT_SECRET") ?? "";
  return { id: id.trim(), secret: secret.trim() };
};
const notSetUp = (provider: string) =>
  provider === "google"
    ? "Google Calendar is not set up yet. The owner has to add the Google OAuth credentials first."
    : "Outlook is not set up yet. The owner has to add the Microsoft OAuth credentials first.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/calendar-connect\/?/, "").replace(/\/+$/, "");

  /* ---------- start ---------- */
  if (route === "start" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const clientId = String(body?.client_id ?? "").trim();
    const provider = String(body?.provider ?? "").trim().toLowerCase();
    const returnTo = String(body?.return_to ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) return no(req, "We could not tell which client that is.");
    if (!["google", "microsoft", "calendly"].includes(provider)) return no(req, "Pick Google, Outlook or Calendly.");

    // The caller's own JWT decides whether they may connect this client's
    // calendar: calendar_state_new refuses anybody who is not the Aviance team
    // or one of that client's own signed-in people.
    const auth = req.headers.get("authorization") ?? "";
    if (!/^bearer\s+\S+/i.test(auth)) return no(req, "Sign in again and then connect the calendar.", 401);
    const asCaller = createClient(SB_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: auth } },
    });

    if (provider === "calendly") {
      const may = await asCaller.rpc("calendar_may_connect", { p_client: clientId });
      if (may.error || may.data !== true) return no(req, "That is not your calendar to connect.", 403);
      return json(req, {
        ok: true, needs_token: true,
        said: "Calendly does not use a sign-in window. In Calendly, go to Integrations, then API and webhooks, then Generate new token, and paste the token here.",
      });
    }

    const { id, secret } = creds(provider);
    if (!id || !secret) return no(req, notSetUp(provider), 503);

    const { verifier, challenge } = await pkce();
    const made = await asCaller.rpc("calendar_state_new", {
      p_client: clientId, p_provider: provider, p_verifier: verifier,
      p_return_to: ALLOWED.test(new URL(returnTo || SITE).origin) ? returnTo : "",
    });
    if (made.error) return no(req, made.error.message || "We could not start that. Try again in a moment.", 403);

    const cfg = provider === "google" ? GOOGLE : MICROSOFT();
    const q = new URLSearchParams({
      client_id: id,
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: cfg.scopes,
      state: String(made.data),
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (provider === "google") {
      // access_type=offline is what makes a refresh token come back, and
      // prompt=consent makes it come back EVERY time, not only the first.
      q.set("access_type", "offline");
      q.set("prompt", "consent");
      q.set("include_granted_scopes", "true");
    } else {
      q.set("response_mode", "query");
    }
    return json(req, { ok: true, url: `${cfg.auth}?${q.toString()}` });
  }

  /* ---------- calendly: a pasted personal access token ---------- */
  if (route === "calendly" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const clientId = String(body?.client_id ?? "").trim();
    const token = String(body?.token ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) return no(req, "We could not tell which client that is.");
    if (token.length < 20) return no(req, "That does not look like a Calendly token. Copy the whole thing.");
    const auth = req.headers.get("authorization") ?? "";
    if (!/^bearer\s+\S+/i.test(auth)) return no(req, "Sign in again and then connect the calendar.", 401);
    const asCaller = createClient(SB_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: auth } },
    });
    const may = await asCaller.rpc("calendar_may_connect", { p_client: clientId });
    if (may.error || may.data !== true) return no(req, "That is not your calendar to connect.", 403);

    // Checked against Calendly before it is stored, so a typo is caught here
    // and not weeks later when a slot is offered.
    const me = await fetch("https://api.calendly.com/users/me", { headers: { Authorization: `Bearer ${token}` } });
    if (!me.ok) return no(req, me.status === 401
      ? "Calendly would not accept that token. Generate a new one and paste it again."
      : "Calendly did not answer just now. Try again in a moment.", 400);
    const who = await me.json().catch(() => ({}));
    const res = who?.resource ?? {};
    const saved = await svc.rpc("calendar_connection_save", {
      p_client: clientId, p_provider: "calendly",
      p_email: res.email ?? null, p_name: res.name ?? null,
      p_calendar_id: res.uri ?? null, p_scopes: "calendly:user_busy_times",
      p_access: token, p_refresh: null, p_expires: null, p_by: null,
    });
    if (saved.error) return no(req, "We could not save that connection. Try again in a moment.", 500);
    return json(req, { ok: true, said: `Connected to Calendly as ${res.email ?? "that account"}.` });
  }

  /* ---------- callback ---------- */
  if (route === "callback" && req.method === "GET") {
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const denied = url.searchParams.get("error") ?? "";
    const taken = state ? await svc.rpc("calendar_state_take", { p_state: state }) : { data: null, error: null };
    const st = (taken.data ?? null) as { ok?: boolean; client_id?: string; provider?: string; code_verifier?: string; return_to?: string; started_by?: string } | null;
    const back = (said: string, ok: boolean) => {
      const to = st?.return_to && ALLOWED.test(new URL(st.return_to).origin) ? st.return_to : SITE;
      const u = new URL(to);
      u.searchParams.set("calendar", ok ? "connected" : "failed");
      u.searchParams.set("said", said);
      return new Response(null, { status: 302, headers: { ...cors(req), Location: u.toString() } });
    };
    if (denied) return back("That window was closed before the calendar was connected. Nothing has changed.", false);
    if (!st?.ok) return back("That connection attempt has expired. Start again.", false);
    if (!code) return back("The calendar sent us back without a code. Start again.", false);

    const provider = String(st.provider);
    const { id, secret } = creds(provider);
    if (!id || !secret) return back(notSetUp(provider), false);
    const cfg = provider === "google" ? GOOGLE : MICROSOFT();

    const form = new URLSearchParams({
      client_id: id,
      client_secret: secret,
      code,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    });
    if (st.code_verifier) form.set("code_verifier", st.code_verifier);
    if (provider === "microsoft") form.set("scope", cfg.scopes);

    const res = await fetch(cfg.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const tok = await res.json().catch(() => ({}));
    if (!res.ok || !tok?.access_token) {
      return back("That calendar would not finish connecting. Try again, and if it keeps happening tell us.", false);
    }
    const expires = tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000).toISOString() : null;

    // Who did we just connect? Only the account's name and email are kept.
    let email: string | null = null, name: string | null = null;
    try {
      if (provider === "google") {
        const u = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
        const d = await u.json(); email = d?.email ?? null; name = d?.name ?? null;
      } else {
        const u = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${tok.access_token}` } });
        const d = await u.json(); email = d?.mail ?? d?.userPrincipalName ?? null; name = d?.displayName ?? null;
      }
    } catch { /* a name is nice to have, not worth losing the connection over */ }

    const saved = await svc.rpc("calendar_connection_save", {
      p_client: st.client_id, p_provider: provider,
      p_email: email, p_name: name,
      p_calendar_id: provider === "google" ? "primary" : null,
      p_scopes: tok.scope ?? cfg.scopes,
      p_access: tok.access_token,
      // Google sends a refresh token once; the database never overwrites a
      // stored one with null, so a re-consent that omits it is harmless.
      p_refresh: tok.refresh_token ?? null,
      p_expires: expires, p_by: st.started_by ?? null,
    });
    if (saved.error) return back("We could not save that connection. Try connecting it again.", false);
    return back(`Connected${email ? ` as ${email}` : ""}. Booked calls will land on that calendar.`, true);
  }

  return no(req, "There is nothing at that address.", 404);
});
