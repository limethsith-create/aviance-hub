// Aviance OS — staff-code
// The owner presses "Generate access code" in the Employees screen; this makes it.
//   POST { staff_id }  ->  { ok: true, code: "AVX-4K7M-Q2ZP" }
//
// The code IS her Supabase password, set here with the service role, so she can
// sign in at /team with nothing but her Gmail and the code, and the session then
// keeps her signed in on that device.
//
// Deploy with verify_jwt TRUE. The gateway checks that a JWT is present; this
// file checks WHOSE it is, because only the owner may hand out an access code.
//
// Nothing secret ever comes back in a response but the code itself, and the code
// is never written down: only a one-way hash of it is stored, which answers
// "has a code been set?" and nothing else.
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// No O, 0, I, 1, L or 5/S lookalikes read wrongly over a phone. 29 characters;
// makeCode() throws away the top of the byte range so each one stays equally likely.
const ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
const PICKABLE = ALPHABET.length; // 29

/** AVX-4K7M-Q2ZP — short enough to read out, long enough to be unguessable. */
function makeCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const out: string[] = [];
  for (let i = 0; out.length < 8 && i < bytes.length; i++) {
    // Reject the top of the byte range instead of folding it, so every
    // character stays equally likely.
    const b = bytes[i];
    if (b >= Math.floor(256 / PICKABLE) * PICKABLE) continue;
    out.push(ALPHABET[b % PICKABLE]);
  }
  while (out.length < 8) {                         // vanishingly rare; top up
    const extra = new Uint8Array(1);
    crypto.getRandomValues(extra);
    if (extra[0] < Math.floor(256 / PICKABLE) * PICKABLE) out.push(ALPHABET[extra[0] % PICKABLE]);
  }
  return "AVX-" + out.slice(0, 4).join("") + "-" + out.slice(4, 8).join("");
}

/** One-way, and tied to the person, so two identical codes do not look alike. */
async function hashCode(staffId: string, code: string): Promise<string> {
  const data = new TextEncoder().encode("aviance-staff-code:" + staffId + ":" + code);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return no(req, "Send this as a POST.", 405);

  // ── 1. Who is asking? Only the owner may do this. ──────────────────────
  const auth = req.headers.get("authorization") ?? "";
  const jwt = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim() ?? "";
  if (!jwt) return no(req, "Sign in again and try once more.", 401);

  const who = await sb.auth.getUser(jwt);
  const caller = who.data?.user;
  if (who.error || !caller) return no(req, "Sign in again and try once more.", 401);

  const me = await sb.from("profiles").select("role, approved").eq("id", caller.id).maybeSingle();
  if (me.error) return no(req, "We could not check your account. Try again in a moment.", 500);
  if (!me.data || me.data.role !== "admin" || me.data.approved !== true) {
    return no(req, "Only the owner can hand out an access code.", 403);
  }

  // ── 2. Which member of staff? ─────────────────────────────────────────
  const body = await req.json().catch(() => ({}));
  const staffId = String(body?.staff_id ?? "").trim();
  if (!UUID.test(staffId)) return no(req, "We need the employee to set a code for.");

  // Employees live in their own table (public.staff), not in profiles: a profiles row needs an auth user to
  // exist first, and she has none until this function makes one.
  const row = await sb.from("staff").select("id, email, name, status").eq("id", staffId).maybeSingle();
  if (row.error) return no(req, "We could not find that employee. Try again in a moment.", 500);
  if (!row.data) return no(req, "That employee is not on the list any more.", 404);
  if (row.data.status === "revoked") return no(req, "Her access is switched off. Let her back in first.", 409);

  const email = String(row.data.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return no(req, "That employee has no usable email address.", 409);

  // ── 3. Her login: make it, or re-key the one that is already there. ───
  const code = makeCode();
  let userId = "";
  let created = false;

  const existing = await sb.rpc("auth_user_by_email", { p_email: email });
  if (existing.error) return no(req, "We could not set up her login. Try again in a moment.", 500);
  const ex = existing.data as { id: string; team: boolean } | null;
  if (ex?.team) return no(req, "That email belongs to the Aviance team, so it cannot be an employee login.", 409);

  if (ex?.id) {
    const up = await sb.auth.admin.updateUserById(ex.id, { password: code, email_confirm: true });
    if (up.error) return no(req, "We could not set her access code. Try again in a moment.", 500);
    userId = ex.id;
  } else {
    const mk = await sb.auth.admin.createUser({
      email,
      password: code,
      email_confirm: true,
      user_metadata: { name: String(row.data.name ?? "") },
    });
    if (mk.error || !mk.data?.user) return no(req, "We could not set up her login. Try again in a moment.", 500);
    userId = mk.data.user.id;
    created = true;
  }

  // ── 4. Point her profile at that login and mark the code as set. ──────
  const codeHash = await hashCode(staffId, code);
  const linked = await link(staffId, userId, codeHash);
  if (!linked.ok) {
    // A login nobody can reach is worse than no login, so undo what we made.
    if (created) await sb.auth.admin.deleteUser(userId).catch(() => {});
    return no(req, linked.error, 500);
  }

  // 5. The invite email: one branded message with the button and her code (optional, on by default).
  //    If the mail cannot be queued we still hand the code back, so he can send it himself.
  let mailed = false;
  if (body?.send_email !== false) {
    const mail = await sb.rpc("staff_invite_mail", { p_staff: staffId, p_code: code });
    mailed = !mail.error;
  }

  return json(req, { ok: true, code, mailed });
});

/** One statement in the database does the whole link: her login, her seat in her channel, and the role fix. */
async function link(staffId: string, userId: string, codeHash: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const rpc = await sb.rpc("staff_link_auth", { p_staff: staffId, p_user: userId, p_code_hash: codeHash });
  if (!rpc.error) return { ok: true };
  // No fallback on purpose: doing this in pieces could leave her half set up, which is worse than a clean refusal.
  return { ok: false, error: "We could not finish setting her up. Try again in a moment." };
}
