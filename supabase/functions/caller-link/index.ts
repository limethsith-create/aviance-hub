// Aviance OS — caller-link (the staff invite link; the name is kept because /go in
// vercel.json and the Employees screen both point at this path).
// The one-click invite link. The owner sends her one URL; she taps it and lands on
// her own page already signed in, with no Gmail to type and no access code to copy.
//
//   GET /caller-link?k=TOKEN  ->  302 to https://aviance.store/team#k=<one-time>
//
// Reached in production as https://aviance.store/go?k=TOKEN: /go is rewritten to this
// function in vercel.json, so what she receives is an aviance.store address.
//
// Deployed with verify_jwt FALSE on purpose: the person clicking has no session yet,
// that is the whole point. The token in the URL is the only credential, it is checked
// against a stored sha256 by staff_link_claim, and it expires on its own.
//
// What goes back in the redirect is NOT the invite token: it is a fresh one-time
// Supabase sign-in token, good for one use, that the page immediately exchanges for a
// session. It travels in the fragment, which browsers never send to a server.
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SITE = "https://aviance.store";
// Every staff member lands on the staff channel. There is only one staff page now.
const PAGE = "/team";

/** Every exit from this function is a redirect: she clicked a link, she should land on a page. */
function go(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
const bad = (why: string, page = PAGE) => go(`${SITE}${page}?link=${encodeURIComponent(why)}`);

/** A password nobody is ever told, for a login that is only ever reached by link. */
function randomSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return bad("method");   // a HEAD (a link preview) must not make a login or count as a use

  const token = (new URL(req.url).searchParams.get("k") ?? "").trim();
  // 24 random bytes in base64 is 32 characters; be generous but refuse junk.
  if (!/^[A-Za-z0-9xyz_-]{20,64}$/.test(token)) return bad("bad");

  // 1. Is the link real, unexpired, and whose is it?
  const claim = await sb.rpc("staff_link_claim", { p_token: token });
  if (claim.error) return bad("again");
  const who = claim.data as
    | { ok: boolean; error?: string; id?: string; email?: string; name?: string; user_id?: string | null }
    | null;
  if (!who?.ok) return bad(who?.error === "expired" ? "expired" : "bad");

  const page = PAGE;
  const email = String(who.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return bad("email", page);

  // 2. She may never have had an access code, so her login may not exist yet. Make it.
  const found = await sb.rpc("auth_user_by_email", { p_email: email });
  if (found.error) return bad("again", page);
  const ex = found.data as { id: string; team: boolean } | null;
  if (ex?.team) return bad("team", page);

  if (ex?.id && "user_id" in who && who.user_id !== ex.id) {
    // A login for this address already exists but her staff row is not tied to it (it was made
    // another way, or her row was added again). Without this she lands signed in and is told to
    // "sign in again" for ever. An empty code hash means "no access code issued".
    const linked = await sb.rpc("staff_link_auth", { p_staff: who.id, p_user: ex.id, p_code_hash: "" });
    if (linked.error) return bad("again", page);
  }

  if (!ex?.id) {
    const mk = await sb.auth.admin.createUser({
      email,
      password: randomSecret(),          // never shown to anyone: this login is link-only
      email_confirm: true,
      user_metadata: { name: String(who.name ?? "") },
    });
    if (mk.error || !mk.data?.user) return bad("again", page);
    // Tie the new login to her row, her channel seat and her role. No access code has been issued,
    // so the code hash stays empty: the Employees screen reads it to say whether she has a code, and a
    // random value here made it say "yes" when she had none. (Her password is the random one above.)
    const linked = await sb.rpc("staff_link_auth", {
      p_staff: who.id, p_user: mk.data.user.id, p_code_hash: "",
    });
    if (linked.error) {
      await sb.auth.admin.deleteUser(mk.data.user.id).catch(() => {});
      return bad("again", page);
    }
  }

  // 3. Mint a one-time sign-in for that address and hand it to the page.
  const link = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const hashed = link.data?.properties?.hashed_token ?? "";
  if (link.error || !hashed) return bad("again", page);

  return go(`${SITE}${page}#k=${encodeURIComponent(hashed)}`);
});
