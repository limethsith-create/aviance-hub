/* Tests for the client's own calendar — connecting it, and keeping its tokens
   where nobody can read them.

   The two things that matter most here:

   1. NO CREDENTIAL IS IN THIS REPO. The OAuth client id and secret are Supabase
      secrets, read by NAME inside the edge function, with no default and no
      fallback value. The client's own access and refresh tokens are per-client
      and are minted at runtime, so they live in public.calendar_tokens — which
      has RLS on and NO POLICY, so only the service role reaches them.

   2. RLS. A signed-in client sees their OWN company's connections and busy
      times and nobody else's, and never a token of any kind.

   Run with:  node --test tests/calendar-connect.test.mjs */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = fs.readFileSync(path.join(root, 'supabase/migrations/20261207_calendar_connect.sql'), 'utf8');
const bare = SQL.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const FN = fs.readFileSync(path.join(root, 'supabase/functions/calendar-connect/index.ts'), 'utf8');
const sqlFn = (name) => {
  const i = bare.indexOf('function public.' + name);
  assert.ok(i > 0, name + ' is in the migration');
  return bare.slice(i, (bare.indexOf('$$;', i) + 1) || bare.length);
};

const SECRETS = [
  'GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET',
  'MICROSOFT_CALENDAR_CLIENT_ID', 'MICROSOFT_CALENDAR_CLIENT_SECRET',
];

/* ───────────── 1. no credential is in this repo ───────────── */

test('every OAuth credential is read from a Supabase secret by name, with no default', () => {
  for (const name of SECRETS) {
    assert.ok(FN.includes(`"${name}"`), name + ' is named in the function');
    /* Deno.env.get(NAME) ?? "" is the only fallback allowed: an empty string,
       which the function turns into "not set up yet". Never a real value. */
    const withDefault = new RegExp('Deno\\.env\\.get\\("' + name + '"\\)\\s*\\?\\?\\s*"(?!")', 'g');
    assert.ok(!withDefault.test(FN), name + ' has no default value');
  }
  /* and the migration that documents them holds no value either */
  for (const name of SECRETS) assert.ok(SQL.includes(name), name + ' is documented in the migration');
  assert.ok(!/client_secret\s*[:=]\s*['"][^'"]{8,}/i.test(SQL + FN), 'no secret is assigned anywhere');
});

test('nothing that looks like a real key, token or secret is anywhere in what this adds', () => {
  const mine = [
    'supabase/migrations/20261207_calendar_connect.sql',
    'supabase/migrations/20261207_seats.sql',
    'supabase/migrations/20261207_showup.sql',
    'supabase/functions/calendar-connect/index.ts',
    'clientbook.js', 'meetings.js', 'join.html',
  ].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  /* the shapes a real credential comes in */
  for (const shape of [
    /AIza[0-9A-Za-z_-]{30,}/,              // a Google API key
    /sk-[A-Za-z0-9]{20,}/,                 // an OpenAI-style key
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, // a JWT
    /GOCSPX-[A-Za-z0-9_-]{10,}/,           // a Google client secret
    /\b[0-9a-f]{32,}\b/,                   // a long hex secret
  ]) assert.ok(!shape.test(mine), 'no credential shaped like ' + shape);
});

test('the tokens table has RLS on and deliberately no policy at all', () => {
  assert.match(bare, /create table if not exists public\.calendar_tokens/);
  assert.match(bare, /alter table public\.calendar_tokens enable row level security/);
  /* the whole point: there is no policy, so nothing but the service role reads it */
  assert.ok(!/create policy[^;]*on public\.calendar_tokens/.test(bare), 'calendar_tokens has no policy');
  assert.match(SQL, /RLS is on and there is deliberately NO policy/);
  /* the same for the handshake table */
  assert.match(bare, /alter table public\.calendar_oauth_states enable row level security/);
  assert.ok(!/create policy[^;]*on public\.calendar_oauth_states/.test(bare));
});

test('only the service role can save a token or take a handshake state', () => {
  for (const f of ['calendar_connection_save', 'calendar_state_take'])
    assert.match(sqlFn(f), /auth\.jwt\(\)->>'role',''\) <> 'service_role' then raise exception|<> 'service_role' then raise exception/,
      f + ' is service role only');
  /* and they are not callable by a signed-in browser at all */
  assert.match(bare, /revoke all on function public\.calendar_state_take\(text\)\s+from public, anon, authenticated/);
  assert.match(bare, /revoke all on function public\.calendar_connection_save[^\n]*from public, anon, authenticated/);
  assert.ok(!/grant execute on function public\.calendar_connection_save/.test(bare));
});

/* ───────────── 2. RLS ───────────── */

test('a client sees their OWN connections and busy times, and no other client\'s', () => {
  for (const table of ['calendar_connections', 'calendar_busy']) {
    assert.match(bare, new RegExp('alter table public\\.' + table + ' enable row level security'));
    assert.match(bare, new RegExp('create policy "team reads ' + table.replace('calendar_', 'calendar ') + '"[\\s\\S]{0,120}is_approved\\(\\)'));
    /* the client's own rows only, matched through their own client_people row */
    const own = bare.slice(bare.indexOf('their own people read ' + table.replace('calendar_', 'calendar ')));
    assert.match(own, /select 1 from public\.client_people p\s+where p\.user_id = auth\.uid\(\)/);
    assert.match(own, new RegExp('p\\.client_id = ' + table + '\\.client_id'));
    assert.match(own, /for select using/, 'read only: a client never writes these');
  }
});

test('what a browser can read back never includes a token', () => {
  const body = sqlFn('calendar_connections_for');
  for (const col of ['access_token', 'refresh_token', 'calendar_tokens'])
    assert.ok(!body.includes(col), 'calendar_connections_for must not expose ' + col);
  assert.match(body, /if not public\.calendar_may_connect\(p_client\) then/, 'and it checks who is asking');
  assert.match(body, /That is not your calendar to look at\./);
  /* the connections table itself has no token column to leak */
  const table = bare.slice(bare.indexOf('create table if not exists public.calendar_connections'), bare.indexOf('comment on table public.calendar_connections'));
  assert.ok(!/token/.test(table), 'the table a browser can select holds no token');
});

test('the busy cache keeps times only, so a cached row says nothing about their business', () => {
  const table = bare.slice(bare.indexOf('create table if not exists public.calendar_busy'), bare.indexOf('comment on table public.calendar_busy'));
  for (const col of ['title', 'summary', 'subject', 'attendee', 'body', 'description'])
    assert.ok(!table.includes(col), 'calendar_busy must not hold ' + col);
  assert.match(table, /starts_at\s+timestamptz not null/);
  assert.match(table, /check \(ends_at > starts_at\)/);
});

test('disconnecting takes the tokens and the cached times with it', () => {
  const body = sqlFn('calendar_disconnect');
  assert.match(body, /delete from public\.calendar_tokens where connection_id = c\.id/);
  assert.match(body, /delete from public\.calendar_busy    where connection_id = c\.id|delete from public\.calendar_busy\s+where connection_id = c\.id/);
  assert.match(body, /if not public\.calendar_may_connect\(c\.client_id\) then/);
});

/* ───────────── the flow the research said to build ───────────── */

test('the Google flow asks for a refresh token, and only the scopes it needs', () => {
  assert.match(FN, /auth: "https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth"/);
  assert.match(FN, /token: "https:\/\/oauth2\.googleapis\.com\/token"/);
  assert.match(FN, /q\.set\("access_type", "offline"\)/, 'offline is what makes a refresh token come back');
  assert.match(FN, /q\.set\("prompt", "consent"\)/);
  assert.match(FN, /calendar\.freebusy/, 'to see when they are busy');
  assert.match(FN, /calendar\.events/, 'to put a booked call on their calendar');
  assert.ok(!/auth\/calendar\.readonly|auth\/calendar["\s]/.test(FN), 'we do not ask to read their event titles');
});

test('the Microsoft flow uses the v2.0 endpoints and offline_access', () => {
  assert.match(FN, /login\.microsoftonline\.com\/\$\{MS_TENANT\(\)\}\/oauth2\/v2\.0\/authorize/);
  assert.match(FN, /login\.microsoftonline\.com\/\$\{MS_TENANT\(\)\}\/oauth2\/v2\.0\/token/);
  assert.match(FN, /"offline_access"/, 'or no refresh token comes back');
  assert.match(FN, /Calendars\.ReadWrite/);
  assert.match(FN, /q\.set\("response_mode", "query"\)/);
});

test('both flows use PKCE, and the handshake state is one use only', () => {
  assert.match(FN, /code_challenge_method: "S256"/);
  assert.match(FN, /if \(st\.code_verifier\) form\.set\("code_verifier", st\.code_verifier\)/);
  /* taking a state deletes it, so a replayed callback finds nothing */
  assert.match(sqlFn('calendar_state_take'), /delete from public\.calendar_oauth_states where state = p_state and expires_at > now\(\) returning \* into s/);
  assert.match(bare, /expires_at\s+timestamptz not null default \(now\(\) \+ interval '15 minutes'\)/);
});

test('a missing credential is said in plain English, never as a crash', () => {
  assert.match(FN, /Google Calendar is not set up yet\. The owner has to add the Google OAuth credentials first\./);
  assert.match(FN, /Outlook is not set up yet\. The owner has to add the Microsoft OAuth credentials first\./);
  assert.match(FN, /if \(!id \|\| !secret\) return no\(req, notSetUp\(provider\), 503\)/);
});

test('Calendly is a pasted token, checked against Calendly before it is stored', () => {
  assert.match(FN, /https:\/\/api\.calendly\.com\/users\/me/);
  assert.match(FN, /Calendly would not accept that token\. Generate a new one and paste it again\./);
  assert.match(FN, /may\.data !== true\) return no\(req, "That is not your calendar to connect\."/);
});

/* ───────────── the owner's panel ───────────── */

let calls, tables, rpcs;
function builder(table) {
  const call = { table, op: 'select', filters: [] };
  calls.push(call);
  const b = { select() { return b }, insert() { call.op = 'insert'; return b }, update() { call.op = 'update'; return b },
    delete() { call.op = 'delete'; return b }, eq() { return b }, order() { return b }, limit() { return b },
    maybeSingle() { call.maybe = true; return b }, single() { call.single = true; return b },
    then(res, rej) {
      const h = tables[table + '.' + call.op];
      let out = typeof h === 'function' ? h(call) : (h || { data: [], error: null });
      if ((call.single || call.maybe) && out && Array.isArray(out.data))
        out = out.data.length ? { data: out.data[0], error: null } : { data: null, error: call.maybe ? null : { message: 'no rows' } };
      return Promise.resolve(out).then(res, rej);
    } };
  return b;
}
globalThis.window = globalThis;
let fetched = [];
globalThis.fetch = async (u, o) => { fetched.push({ url: String(u), opts: o }); return { ok: true, json: async () => ({ ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' }) } };
globalThis.sb = {
  from: builder,
  rpc: async (name, args) => { rpcs.push({ name, args }); const h = tables['rpc.' + name]; return typeof h === 'function' ? h(args) : (h || { data: null, error: null }) },
  supabaseUrl: 'https://zjbxnkpktbghhudjbxhk.supabase.co',
  auth: { getSession: async () => ({ data: { session: { access_token: 'the-callers-own-jwt' } } }) },
};
const fields = {}, toasts = [];
globalThis.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
globalThis.val = (id) => String(fields[id] == null ? '' : fields[id]).trim();
globalThis.errEl = (id, m) => { fields['err:' + id] = m; return false };
globalThis.emptyState = (i, t, s) => `<div>${t} ${s}</div>`;
globalThis.toast = (m) => { toasts.push(m) };
globalThis.openModal = (h) => { fields.modal = h }; globalThis.closeModal = () => { fields.modal = null };
vm.runInThisContext(fs.readFileSync(path.join(root, 'finance.js'), 'utf8'), { filename: 'finance.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'clientbook.js'), 'utf8'), { filename: 'clientbook.js' });
const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

beforeEach(() => { calls = []; tables = {}; rpcs = []; toasts.length = 0; fetched = []; cbForget() });

test('the panel offers all three, and draws nothing it was not told', () => {
  const t = text(cbRenderCalendar('c1', [], {}));
  assert.match(t, /Their calendar/);
  assert.match(t, /Connect Google Calendar/);
  assert.match(t, /Connect Outlook/);
  assert.match(t, /Connect Calendly/);
  assert.match(t, /booked calls land on it, and we stop offering times they cannot do/);
  assert.ok(!/undefined|NaN|\[object/.test(cbRenderCalendar('c1', null, {})));
});

test('a connected calendar shows whose it is, when it was last read, and a way out', () => {
  const h = cbRenderCalendar('c1', [{ id: 'k1', provider: 'google', status: 'connected',
    account_email: 'sam@stone.test', connected_at: '2026-11-01T10:00:00Z', last_synced_at: '2026-11-26T08:00:00Z' }], {});
  const t = text(h);
  assert.match(t, /Google Calendar Connected/);
  assert.match(t, /sam@stone\.test/);
  assert.match(t, /free time last read/);
  assert.match(h, /cbAskDisconnectCal\(&quot;c1&quot;,&quot;k1&quot;,&quot;google&quot;\)/);
  assert.ok(!/Connect Google Calendar/.test(t), 'not offered twice');
  /* a calendar in trouble says so, in the words the database kept */
  assert.match(text(cbRenderCalendar('c1', [{ id: 'k1', provider: 'microsoft', status: 'needs_reconnect',
    last_error: 'Outlook stopped accepting our key.' }], {})), /Needs reconnecting[\s\S]*Outlook stopped accepting our key\./);
});

test('an account name with a tag in it cannot write HTML into the panel', () => {
  const h = cbRenderCalendar('c1', [{ id: '"><img src=x>', provider: 'google', status: 'connected',
    account_email: '<script>alert(1)</script>', last_error: '<b>x' }], {});
  assert.ok(!/<script|<img src=x|<b>x/.test(h));
});

test('not switched on yet says so, and offers nothing it cannot do', () => {
  const t = text(cbRenderCalendar('c1', [], { error: CB_CAL_NOT_READY }));
  assert.match(t, /not switched on yet/);
  assert.ok(!/Connect Google Calendar/.test(t));
});

test('starting a connection asks the edge function, with the caller\'s own JWT and no credential', async () => {
  const r = await cbCalStartUrl('c1', 'google');
  assert.equal(r.ok, true);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, 'https://zjbxnkpktbghhudjbxhk.supabase.co/functions/v1/calendar-connect/start');
  assert.equal(fetched[0].opts.headers.Authorization, 'Bearer the-callers-own-jwt');
  const sent = JSON.parse(fetched[0].opts.body);
  assert.deepEqual(Object.keys(sent).sort(), ['client_id', 'provider', 'return_to']);
  assert.equal(sent.client_id, 'c1');
  /* the browser never holds, sends or receives a client secret */
  assert.ok(!/secret/i.test(fetched[0].opts.body));
  assert.equal((await cbCalStartUrl('c1', 'dropbox')).ok, false);
});

test('disconnecting goes through the database rule and writes no table itself', async () => {
  tables['rpc.calendar_disconnect'] = () => ({ data: { ok: true, provider: 'google', said: 'Disconnected. We will stop reading their free time and stop putting calls on that calendar.' }, error: null });
  tables['rpc.calendar_connections_for'] = () => ({ data: [], error: null });
  const r = await cbDisconnectCalGo('c1', 'k1');
  assert.equal(r.ok, true);
  assert.deepEqual(rpcs[0], { name: 'calendar_disconnect', args: { p_connection: 'k1' } });
  assert.equal(calls.filter((c) => c.op !== 'select').length, 0);
  assert.match(toasts.at(-1), /Disconnected\./);
});

test('a calendar rule that is not deployed yet reads as "not switched on"', async () => {
  tables['rpc.calendar_connections_for'] = () => ({ data: null, error: { message: 'Could not find the function public.calendar_connections_for in the schema cache' } });
  const r = await cbCalendars('c1');
  assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']);
  assert.equal(r.error, CB_CAL_NOT_READY);
  assert.ok(!/schema cache/.test(r.error));
});
