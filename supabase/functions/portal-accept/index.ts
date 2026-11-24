// Aviance OS — portal-accept
// The server half of "set a password and you are in".
//   POST { token, password }
// The link in the welcome email proves the person owns that inbox, so this
// makes (or re-keys) their login, then burns the invite. One link, one use.
// Nothing here trusts the browser: the invite is looked up by the hash of the
// token, and a team member's login can never be turned into a client's.
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ALLOWED = /^https:\/\/([a-z0-9-]+\.)*(aviance\.store|aviance\.online|vercel\.app)$/i;
const cors = (req: Request) => {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.test(o) ? o : "https://aviance.store",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const no = (req: Request, error: string, status = 400) => json(req, { ok: false, error }, status);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return no(req, "Send this as a POST.", 405);

  const body = await req.json().catch(() => ({}));
  const token = String(body?.token ?? "").trim();
  const password = String(body?.password ?? "");
  if (!/^[0-9a-f]{48}$/.test(token)) return no(req, "This link is not valid.");
  if (password.length < 8) return no(req, "Use a password of at least 8 characters.");
  if (password.length > 200) return no(req, "That password is too long.");

  // Is the link still good? (asks by hash; the token itself is stored nowhere)
  const peek = await sb.rpc("invite_peek", { p_token: token });
  if (peek.error) return no(req, "We could not check that link. Try again in a moment.", 500);
  const p = peek.data as { ok: boolean; reason?: string; email?: string; name?: string };
  if (!p?.ok) {
    return no(req, p?.reason === "used" ? "This link has already been used. Sign in instead."
      : p?.reason === "expired" ? "This link has expired. Reply to our email and we will send a new one."
      : "This link is not valid.", 410);
  }
  const email = String(p.email);

  // Their login: new, or (if this inbox signed up before) the same one with this password.
  let userId = "";
  let created = false;
  const existing = await sb.rpc("auth_user_by_email", { p_email: email });
  if (existing.error) return no(req, "We could not set up your login. Try again in a moment.", 500);
  const ex = existing.data as { id: string; team: boolean } | null;
  if (ex?.team) return no(req, "That email belongs to the Aviance team.", 409);
  if (ex?.id) {
    const up = await sb.auth.admin.updateUserById(ex.id, { password, email_confirm: true });
    if (up.error) return no(req, "We could not set that password. Try a different one.", 400);
    userId = ex.id;
  } else {
    const mk = await sb.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: p.name ?? "" } });
    if (mk.error || !mk.data?.user) return no(req, "We could not set up your login. Try a different password.", 400);
    userId = mk.data.user.id;
    created = true;
  }

  // Burn the invite and put them in their channel — one statement, so two clicks cannot both win.
  const used = await sb.rpc("portal_invite_consume", { p_token: token, p_user: userId });
  if (used.error) {
    if (created) await sb.auth.admin.deleteUser(userId).catch(() => {});
    return no(req, used.error.message || "This link has already been used or has expired.", 410);
  }
  return json(req, { ok: true, email });
});
