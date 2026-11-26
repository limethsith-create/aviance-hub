/* Tests for portal.js — the client's people, their way in, and the conversation.
   A fake `sb` stands in for Supabase: a small in-memory database behind the same query builder
   (select / insert / update / eq / neq / is / in / gt / order / limit / single / maybeSingle),
   with the table defaults the real schema has (portal_invites.status, .expires_at), and the
   portal_invite_create rule: it hands back the raw token once and keeps only a hash.
   Same stubbing style as tests/channels-api.test.mjs. No network.
   Run with:  node --test tests/portal-people.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;

/* ───────────── a tiny fake DOM (the screens only read inputs) ───────────── */
const elements = {};
function fakeEl(id) { return { id, value: '', textContent: '', innerHTML: '', focus() {} }; }
const el = (id) => (elements[id] ||= fakeEl(id));
globalThis.document = { getElementById: el };
globalThis.location = { origin: 'https://aviance.store', hash: '', pathname: '/' };
globalThis.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let toasts = [];
globalThis.toast = (m) => toasts.push(m);

/* ───────────── fake Supabase: an in-memory database ───────────── */
const DAY = 86400000;
let db, calls, fails, seq;
function reset() {
  db = { clients: [], client_people: [], portal_invites: [], client_requests: [], channels: [], channel_members: [], channel_messages: [], profiles: [] };
  calls = []; fails = {}; seq = 0; toasts = []; rpcs = []; rpcFails = {};
}
const rows = (t) => (db[t] ||= []);
const id = (p) => p + '-' + (++seq);
const iso = (ms) => new Date(ms).toISOString();

const DEFAULTS = {
  client_people: () => ({ is_primary: false }),
  portal_invites: () => ({ status: 'pending', portal_role: 'viewer', expires_at: iso(Date.now() + 14 * DAY), accepted_at: null, accepted_user: null }),
  client_requests: () => ({ status: 'open', closed_at: null }),
  channel_members: () => ({ member_role: 'member', last_read_at: null, added_at: iso(Date.now()) }),
  channel_messages: () => ({ deleted_at: null, edited_at: null }),
};
function hit(row, f) {
  const [op, k, v] = f, cur = row[k];
  if (op === 'eq') return cur === v || String(cur) === String(v);
  if (op === 'neq') return !(cur === v || String(cur) === String(v));
  if (op === 'is') return v === null ? cur === null || cur === undefined : cur === v;
  if (op === 'in') return (v || []).some((x) => String(cur) === String(x));
  if (op === 'gt') return String(cur || '') > String(v);
  return true;
}
function run(c) {
  const bad = fails[c.table + '.' + c.op];
  if (bad) return { data: null, error: bad };
  const all = rows(c.table);
  let out;
  if (c.op === 'insert') {
    const list = (Array.isArray(c.payload) ? c.payload : [c.payload]).map((p) => {
      const base = DEFAULTS[c.table] ? DEFAULTS[c.table]() : {};
      return Object.assign({ id: id(c.table), created_at: iso(Date.now()) }, base, p);
    });
    for (const r of list) {
      if (c.table === 'channel_members' && all.some((x) => x.channel_id === r.channel_id && ((r.user_id && x.user_id === r.user_id) || (r.person_id && x.person_id === r.person_id)))) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      all.push(r);
    }
    out = list;
  } else if (c.op === 'update') {
    out = all.filter((r) => c.filters.every((f) => hit(r, f)));
    out.forEach((r) => Object.assign(r, c.payload));
    out = out.slice();
  } else if (c.op === 'delete') {
    out = all.filter((r) => c.filters.every((f) => hit(r, f)));
    out.forEach((r) => all.splice(all.indexOf(r), 1));
  } else {
    out = all.filter((r) => c.filters.every((f) => hit(r, f)));
    c.order.forEach(([k, o]) => {
      const asc = !o || o.ascending !== false;
      out = out.slice().sort((a, b) => {
        const x = a[k], y = b[k];
        const n = x === y ? 0 : (x === null || x === undefined) ? -1 : (y === null || y === undefined) ? 1 : x > y ? 1 : -1;
        return asc ? n : -n;
      });
    });
    if (c.limit != null) out = out.slice(0, c.limit);
  }
  out = out.map((r) => ({ ...r }));
  if (c.single) return out.length ? { data: out[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
  if (c.maybeSingle) return { data: out.length ? out[0] : null, error: null };
  return { data: out, error: null };
}
function builder(table) {
  const c = { table, op: 'select', cols: null, payload: null, filters: [], order: [], limit: null, single: false, maybeSingle: false };
  calls.push(c);
  const b = {
    select(cols) { c.cols = cols; return b; },
    insert(p) { c.op = 'insert'; c.payload = p; return b; },
    update(p) { c.op = 'update'; c.payload = p; return b; },
    delete() { c.op = 'delete'; return b; },
    eq(k, v) { c.filters.push(['eq', k, v]); return b; },
    neq(k, v) { c.filters.push(['neq', k, v]); return b; },
    is(k, v) { c.filters.push(['is', k, v]); return b; },
    in(k, v) { c.filters.push(['in', k, v]); return b; },
    gt(k, v) { c.filters.push(['gt', k, v]); return b; },
    order(k, o) { c.order.push([k, o]); return b; },
    limit(n) { c.limit = n; return b; },
    single() { c.single = true; return b; },
    maybeSingle() { c.maybeSingle = true; return b; },
    then(res, rej) { return Promise.resolve(run(c)).then(res, rej); },
  };
  return b;
}
/* portal_invite_create, as the database does it: earlier invites still waiting for the same
   address on the same client are revoked, a new row is made holding only a HASH, and the raw
   token comes back this once. There is no token column to read afterwards. */
let rpcs = [], rpcFails = {};
const fakeSb = {
  from: builder,
  async rpc(name, args) {
    rpcs.push({ name, args });
    if (rpcFails[name]) return { data: null, error: rpcFails[name] };
    if (name !== 'portal_invite_create') return { data: null, error: null };
    const all = rows('portal_invites');
    all.filter((i) => i.client_id === args.p_client && i.email === args.p_email && i.status === 'pending').forEach((i) => { i.status = 'revoked'; });
    const raw = 'raw' + (++seq) + 'Zm9vYmFyYmF6cXV4';
    all.push(Object.assign({ id: id('portal_invites'), created_at: iso(Date.now() + seq) }, DEFAULTS.portal_invites(),
      { client_id: args.p_client, person_id: args.p_person || null, email: args.p_email, token_hash: 'sha256:' + raw.split('').reverse().join('') }));
    return { data: raw, error: null };
  },
};
globalThis.sb = fakeSb;

const SRC = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(SRC, { filename: 'portal.js' });

const OWNER = { uid: 'u-owner', name: 'Owner', role: 'admin', approved: true, email: 'o@aviance.test' };
reset();
beforeEach(() => { reset(); globalThis.sb = fakeSb; globalThis.authUser = { ...OWNER }; ptFlags.clientSignIn = false; });

const shape = (r) => { assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']); return r; };
function seedClient(cid = 'stone-roofing', company = 'Stone Roofing') {
  rows('clients').push({ id: cid, company, created_at: iso(Date.now()) });
  return cid;
}

/* ───────────── their people: exactly one primary ───────────── */
test('ptPeople and ptAddPerson: the first person is added, the primary is theirs alone', async () => {
  const cid = seedClient();
  const empty = shape(await ptPeople(cid));
  assert.equal(empty.ok, true); assert.deepEqual(empty.data, []);

  const a = await ptAddPerson(cid, { fullName: ' Dana Stone ', email: 'Dana@Stone.test', role: 'Owner', isPrimary: true });
  assert.equal(a.ok, true); assert.equal(a.data.full_name, 'Dana Stone'); assert.equal(a.data.email, 'dana@stone.test');
  assert.equal(a.data.is_primary, true, 'asked to be primary');

  assert.match((await ptAddPerson(cid, { fullName: '  ' })).error, /name/);
  assert.match((await ptAddPerson(cid, { fullName: 'Sam', email: 'nope' })).error, /email address/);
  assert.equal((await ptPeople(cid)).data.length, 1, 'the refused people were not written');
});

test('exactly one primary survives two ptSetPrimary calls', async () => {
  const cid = seedClient();
  const dana = (await ptAddPerson(cid, { fullName: 'Dana', isPrimary: true })).data;
  const sam = (await ptAddPerson(cid, { fullName: 'Sam' })).data;
  const other = seedClient('other-co', 'Other Co');
  const theirs = (await ptAddPerson(other, { fullName: 'Someone else', isPrimary: true })).data;

  const one = await ptSetPrimary(cid, sam.id);
  assert.equal(one.ok, true); assert.equal(one.data.is_primary, true);
  const two = await ptSetPrimary(cid, dana.id);
  assert.equal(two.ok, true);

  const after = (await ptPeople(cid)).data;
  const primaries = after.filter((p) => p.is_primary);
  assert.equal(primaries.length, 1, 'exactly one primary: ' + JSON.stringify(primaries.map((p) => p.full_name)));
  assert.equal(primaries[0].id, dana.id, 'the last one asked for is the primary');
  assert.equal(after[0].is_primary, true, 'the primary is listed first');

  const otherRows = (await ptPeople(other)).data;
  assert.equal(otherRows.filter((p) => p.is_primary).length, 1, "another client's primary is untouched");
  assert.equal(otherRows[0].id, theirs.id);

  assert.match((await ptSetPrimary(cid, '')).error, /Pick a person/);
  assert.match((await ptSetPrimary(cid, theirs.id)).error, /not on this client/, "a person of another client can't be made primary here");
});

/* ───────────── their way in: invites ───────────── */
test('ptInvite goes through portal_invite_create and comes back with the link, once', async () => {
  const cid = seedClient();
  const person = (await ptAddPerson(cid, { fullName: 'Dana', email: 'dana@stone.test' })).data;
  const r = shape(await ptInvite(cid, { email: ' Dana@Stone.test ', personId: person.id, portalRole: 'manager' }));
  assert.equal(r.ok, true);
  assert.deepEqual(rpcs, [{ name: 'portal_invite_create', args: { p_client: cid, p_email: 'dana@stone.test', p_person: person.id } }]);
  assert.equal(calls.filter((c) => c.table === 'portal_invites' && c.op === 'insert').length, 0, 'the row is never inserted from JavaScript');
  assert.equal(r.data.email, 'dana@stone.test');
  assert.equal(r.data.portal_role, 'manager');
  assert.equal(r.data.person_id, person.id);
  assert.equal(r.data.state, 'pending'); assert.equal(r.data.stateWords, 'Waiting for them');

  // the link: join.html, the token after the #, never in the query string
  const raw = r.data.link.split('#')[1];
  assert.match(raw, /^raw\d+Zm9vYmFyYmF6cXV4$/, 'exactly what the database handed back');
  assert.equal(r.data.link, 'https://aviance.store/join.html#' + raw, 'the link shape');
  assert.equal(ptInviteLink(raw), 'https://aviance.store/join.html#' + raw);
  assert.equal(ptInviteLink(''), '', 'no token, no link');
  assert.ok(!r.data.link.includes('?'));
  // the token is handed over inside the link and nowhere else, and is not kept
  assert.ok(!('token' in r.data) && !('token_hash' in r.data));
  assert.ok(!JSON.stringify(rows('portal_invites')).includes(raw), 'the raw token is stored nowhere');
  assert.ok(!/\.token\b/.test(SRC), 'portal.js reads no .token off anything');
  assert.ok(!/localStorage|sessionStorage/.test(SRC), 'and keeps nothing in the browser');
  assert.ok(!/randomUUID|getRandomValues|Math\.random/.test(SRC), 'portal.js never makes a token itself');
  assert.equal(rows('portal_invites')[0].portal_role, 'manager', 'the manager role is set on the row the database made');

  assert.match((await ptInvite(cid, { email: 'not-an-email' })).error, /email address/);
  assert.equal(rpcs.length, 1, 'a bad address never reaches the database');
  assert.equal(rows('portal_invites').length, 1);
  const sam = await ptInvite(cid, { email: 'sam@stone.test' });
  assert.equal(sam.data.portal_role, 'viewer', 'viewer unless manager is asked for');
  assert.equal(rpcs.at(-1).args.p_person, null);

  // the database's own words, and an answer with no token in it
  rpcFails.portal_invite_create = { message: 'Only the owner can invite a client.' };
  assert.deepEqual(await ptInvite(cid, { email: 'x@stone.test' }), { ok: false, data: null, error: 'Only the owner can invite a client.' });
  rpcFails = {};
  const real = fakeSb.rpc; fakeSb.rpc = async () => ({ data: null, error: null });
  try { const none = await ptInvite(cid, { email: 'y@stone.test' }); assert.equal(none.ok, false); assert.match(none.error, /not made/); }
  finally { fakeSb.rpc = real; }
});

test('listed invites carry their status only: no token, no hash, no link', async () => {
  const cid = seedClient();
  await ptInvite(cid, { email: 'dana@stone.test' });
  const list = shape(await ptInvites(cid));
  assert.equal(list.ok, true); assert.equal(list.data.length, 1);
  const row = list.data[0];
  assert.deepEqual(Object.keys(row).sort(), ['accepted_at', 'accepted_user', 'client_id', 'created_at', 'email', 'expires_at', 'id', 'person_id', 'portal_role', 'state', 'stateWords', 'status']);
  const asked = calls.filter((c) => c.table === 'portal_invites' && c.op === 'select').map((c) => c.cols);
  assert.ok(asked.length && asked.every((c) => typeof c === 'string' && c !== '*' && !/token/.test(c)), 'the hash is never asked for: ' + asked.join(' | '));
  const html = await viewClientPeople(cid);
  assert.ok(!/join\.html|raw\d|sha256/.test(html), 'the list shows no link');
  assert.match(html, /Waiting for them/);
});

test('an invite past its expires_at reads as expired, not pending', async () => {
  const cid = seedClient();
  await ptInvite(cid, { email: 'live@stone.test' });
  await ptInvite(cid, { email: 'stale@stone.test' });
  const live = rows('portal_invites').find((i) => i.email === 'live@stone.test');
  const stale = rows('portal_invites').find((i) => i.email === 'stale@stone.test');
  // the row still says pending; only the date has gone by
  rows('portal_invites').find((i) => i.id === stale.id).expires_at = iso(Date.now() - 60000);
  assert.equal(rows('portal_invites').find((i) => i.id === stale.id).status, 'pending', 'the status column is untouched');

  const list = await ptInvites(cid);
  assert.equal(list.ok, true);
  const byId = {}; list.data.forEach((i) => { byId[i.id] = i; });
  assert.equal(byId[stale.id].state, 'expired');
  assert.equal(byId[stale.id].stateWords, 'Expired — send a new one');
  assert.equal(byId[live.id].state, 'pending');

  // the state is read from the date, whatever the status says
  assert.equal(ptInviteState({ status: 'pending', expires_at: iso(Date.now() - 1) }), 'expired');
  assert.equal(ptInviteState({ status: 'pending', expires_at: '' }), 'expired');
  assert.equal(ptInviteState({ status: 'pending', expires_at: iso(Date.now() + DAY) }), 'pending');
  assert.equal(ptInviteState({ status: 'accepted', expires_at: iso(Date.now() - DAY) }), 'accepted', 'an accepted invite stays accepted');
  assert.equal(ptInviteState({ status: 'revoked', expires_at: iso(Date.now() + DAY) }), 'revoked');
  assert.equal(ptInviteState(null), 'expired');
});

test('ptRevokeInvite revokes; ptResendInvite makes a NEW invite the same way and the old link dies', async () => {
  const cid = seedClient();
  const first = (await ptInvite(cid, { email: 'dana@stone.test', portalRole: 'manager' })).data;
  const inv = (await ptInvites(cid)).data[0];

  const gone = await ptRevokeInvite(inv.id);
  assert.equal(gone.ok, true); assert.equal(gone.data.state, 'revoked'); assert.equal(gone.data.stateWords, 'Revoked');
  assert.ok(!('link' in gone.data) && !('token_hash' in gone.data));

  const again = shape(await ptResendInvite(inv.id));
  assert.equal(again.ok, true);
  assert.deepEqual(rpcs.at(-1), { name: 'portal_invite_create', args: { p_client: cid, p_email: 'dana@stone.test', p_person: null } });
  assert.equal(rows('portal_invites').length, 2, 'a new invite, not the old row woken up');
  assert.equal(rows('portal_invites')[0].status, 'revoked', 'the old one stays dead');
  assert.equal(again.data.state, 'pending');
  assert.equal(again.data.portal_role, 'manager', 'they keep what they could do');
  assert.match(again.data.link, /^https:\/\/aviance\.store\/join\.html#raw\d+/);
  assert.notEqual(again.data.link, first.link, 'a new link every time');

  // an expired invite can be sent again: the stale row is revoked by the database, a fresh one waits
  const live = (await ptInvites(cid)).data.find((i) => i.state === 'pending');
  rows('portal_invites').find((i) => i.id === live.id).expires_at = iso(Date.now() - DAY);
  assert.equal((await ptInvites(cid)).data.find((i) => i.id === live.id).state, 'expired');
  assert.equal((await ptResendInvite(live.id)).data.state, 'pending');
  assert.equal(rows('portal_invites').filter((i) => i.status === 'pending').length, 1, 'only ever one live invite per address');

  // someone who has joined is not invited again
  const joined = rows('portal_invites').find((i) => i.status === 'pending');
  joined.status = 'accepted'; joined.accepted_at = iso(Date.now());
  const n = rpcs.length;
  assert.match((await ptResendInvite(joined.id)).error, /already joined/);
  assert.equal(rpcs.length, n);

  assert.match((await ptRevokeInvite('')).error, /Pick an invite/);
  assert.match((await ptResendInvite('')).error, /Pick an invite/);
  assert.match((await ptResendInvite('ghost')).error, /not here any more/);
  fails['portal_invites.update'] = { message: 'permission denied' };
  const r = shape(await ptRevokeInvite(inv.id)); assert.equal(r.ok, false); assert.equal(r.data, null);
});

/* ───────────── requests ───────────── */
test('ptRaiseRequest, ptAnswerRequest, ptCloseRequest, and a dispute points at finance.js', async () => {
  const cid = seedClient();
  assert.deepEqual((await ptRequests(cid, {})).data, []);

  const q = await ptRaiseRequest(cid, { kind: 'question', subject: ' Can we pause in August? ', body: 'Holidays.' });
  assert.equal(q.ok, true); assert.equal(q.data.subject, 'Can we pause in August?'); assert.equal(q.data.status, 'open');
  assert.match((await ptRaiseRequest(cid, { subject: '' })).error, /what this is about/);
  assert.equal((await ptRaiseRequest(cid, { kind: 'nonsense', subject: 'Hm' })).data.kind, 'question', 'an unknown kind falls back');

  const d = await ptRaiseRequest(cid, { kind: 'dispute', subject: 'That call did not match' });
  assert.equal(d.data.kind, 'dispute');
  const money = SRC.slice(SRC.indexOf('ptRaiseRequest'));
  assert.match(money, /\/\/ TODO:[\s\S]{0,600}fnDisputeCall/, 'a clearly-marked TODO pointing at finance.js');
  assert.ok(!/\bfnDisputeCall\s*\(/.test(SRC), 'portal.js never calls fnDisputeCall itself');
  assert.ok(!/qualified_calls/.test(SRC.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'and never touches the money tables');

  const ans = await ptAnswerRequest(q.data.id, ' Yes, we can. ');
  assert.equal(ans.ok, true); assert.equal(ans.data.status, 'answered');
  assert.match(ans.data.body, /^Holidays\.\n\nAviance: Yes, we can\.$/);
  assert.equal(ans.data.owner, 'u-owner');
  assert.match((await ptAnswerRequest(q.data.id, '  ')).error, /Write the answer/);
  assert.match((await ptAnswerRequest('', 'x')).error, /Pick a request/);

  const shut = await ptCloseRequest(q.data.id);
  assert.equal(shut.data.status, 'closed'); assert.ok(shut.data.closed_at);
  assert.match((await ptCloseRequest('')).error, /Pick a request/);

  const open = await ptRequests(cid, { status: 'open' });
  assert.deepEqual(open.data.map((r) => r.subject).sort(), ['Hm', 'That call did not match']);
});

/* ───────────── who may see what ───────────── */
test('ptCanSee: our team sees every client; a client is refused another client\'s data', async () => {
  globalThis.authUser = { ...OWNER };
  assert.equal(ptCanSee('stone-roofing'), true);
  assert.equal(ptCanSee('other-co'), true);
  globalThis.authUser = { uid: 'u-emp', role: 'employee', approved: true };
  assert.equal(ptCanSee('stone-roofing'), true);
  globalThis.authUser = { uid: 'u-new', role: 'employee', approved: false };
  assert.equal(ptCanSee('stone-roofing'), false, 'a staff user still waiting for approval sees nothing');
  globalThis.authUser = null;
  assert.equal(ptCanSee('stone-roofing'), false);

  // client sign-in is not switched on yet
  globalThis.authUser = { uid: 'c-1', role: 'client', approved: true, clientId: 'stone-roofing' };
  assert.equal(ptCanSee('stone-roofing'), false, 'off until client sign-in is built');
  assert.equal(ptCanSee('other-co'), false);

  // turning it on is a change to this one function
  ptFlags.clientSignIn = true;
  assert.equal(ptCanSee('stone-roofing'), true, 'their own client id');
  assert.equal(ptCanSee('other-co'), false, "and never another client's");
  globalThis.authUser = { uid: 'c-2', role: 'client', approved: true, clientId: null };
  assert.equal(ptCanSee('stone-roofing'), false);
});

test('every data function refuses a client another client\'s data in plain words', async () => {
  seedClient(); seedClient('other-co', 'Other Co');
  ptFlags.clientSignIn = true;
  globalThis.authUser = { uid: 'c-1', role: 'client', approved: true, clientId: 'stone-roofing', personId: 'p-1' };
  for (const r of [await ptPeople('other-co'), await ptAddPerson('other-co', { fullName: 'X' }), await ptSetPrimary('other-co', 'p-9'),
    await ptInvite('other-co', { email: 'x@y.test' }), await ptInvites('other-co'), await ptRequests('other-co', {}),
    await ptRaiseRequest('other-co', { subject: 'Hi' })]) {
    shape(r);
    assert.equal(r.ok, false); assert.equal(r.data, null);
    assert.equal(r.error, 'You do not have access to that client.');
  }
  assert.equal(rows('client_people').length, 0); assert.equal(rows('portal_invites').length, 0);
  assert.equal(rows('client_requests').length, 0); assert.equal(rows('channels').length, 0);
  assert.match(await viewClientPeople('other-co'), /do not have access/);
  assert.equal((await ptPeople('stone-roofing')).ok, true, 'their own client is fine');
});

/* ───────────── the screens, with zero rows ───────────── */
test('every screen renders with zero rows in the database', async () => {
  const cid = seedClient();
  const people = await viewClientPeople(cid);
  assert.equal(typeof people, 'string');
  assert.match(people, /No people yet/); assert.match(people, /No invites yet/);
  assert.match(people, /id="ptInviteEmail"/, 'the invite box is there with nothing to list');

  const reqs = await viewRequests();
  assert.match(reqs, /Nothing open/);

  for (const h of [people, reqs]) assert.ok(!/undefined|NaN|\[object/.test(h), h.slice(0, 200));

  // and with rows
  rows('profiles').push({ id: 'u-owner', name: 'Owner', role: 'admin', approved: true });
  const dana = (await ptAddPerson(cid, { fullName: 'Dana <b>Stone</b>', email: 'dana@stone.test', isPrimary: true })).data;
  const inv = (await ptInvite(cid, { email: 'dana@stone.test' })).data;
  rows('portal_invites')[0].expires_at = iso(Date.now() - DAY);
  assert.match(inv.link, /join\.html#/);
  const full = await viewClientPeople(cid);
  assert.match(full, /Dana &lt;b&gt;Stone&lt;\/b&gt;/, 'every name goes through esc()');
  assert.match(full, /Primary/); assert.match(full, /Expired/); assert.match(full, /Send again/);
  assert.ok(!full.includes(inv.link) && !full.includes('join.html'), 'the list never shows a link');
  assert.match(full, /ptResendFromRow\(/, 'Send again makes a new invite');

  await ptRaiseRequest(cid, { kind: 'dispute', subject: 'A call that did not match', owner: 'u-owner' });
  const open = await viewRequests();
  assert.match(open, /A call that did not match/); assert.match(open, /Stone Roofing/);
  assert.match(open, /dispute/); assert.match(open, /Owner/);


  // the screens' own handlers
  el('ptInviteEmail').value = 'sam@stone.test'; el('ptInviteRole').value = 'manager';
  const sent = await ptInviteFromForm(cid);
  assert.equal(sent.ok, true); assert.equal(sent.data.portal_role, 'manager'); assert.equal(el('ptInviteEmail').value, '');
  // the link is put on the screen once, for copying
  assert.ok(el('ptInviteOnce').innerHTML.includes('value="' + sent.data.link + '"'), el('ptInviteOnce').innerHTML);
  assert.match(el('ptInviteOnce').innerHTML, /Copy the link/);
  assert.ok(toasts.some((t) => /only shown this once/.test(t)));
  assert.equal(ptRenderInviteOnce(null), ''); assert.equal(ptRenderInviteOnce({ email: 'a@b.test' }), '');
  const resent = await ptResendFromRow(rows('portal_invites')[0].id);
  assert.equal(resent.ok, true);
  assert.ok(el('ptInviteOnce').innerHTML.includes(resent.data.link) && !el('ptInviteOnce').innerHTML.includes(sent.data.link), 'only the newest link is on the screen');
  el('ptInviteEmail').value = 'bad';
  assert.equal((await ptInviteFromForm(cid)).ok, false);
  assert.ok(toasts.some((t) => /email address/.test(t)), 'the person is told in plain words');
});

test('a screen whose database is down still renders, in plain words', async () => {
  const cid = seedClient();
  fails['client_people.select'] = { message: 'relation "client_people" does not exist' };
  fails['portal_invites.select'] = { message: 'relation "portal_invites" does not exist' };
  fails['client_requests.select'] = { message: 'permission denied' };
  fails['channels.select'] = { message: 'permission denied' };
  const people = await viewClientPeople(cid);
  assert.match(people, /role="alert"/); assert.equal(typeof people, 'string');
  assert.match(await viewRequests(), /role="alert"/);
  shape(await ptPeople(cid)); assert.equal((await ptPeople(cid)).ok, false);
});

/* ───────────── the house rules ───────────── */
test('portal.js: {ok,data,error} from every data function even with no database, and no machine anywhere', async () => {
  const names = ['ptPeople', 'ptAddPerson', 'ptSetPrimary', 'ptInvite', 'ptInvites', 'ptRevokeInvite', 'ptResendInvite',
    'ptRequests', 'ptRaiseRequest', 'ptAnswerRequest', 'ptCloseRequest'];
  for (const n of names) assert.equal(typeof globalThis[n], 'function', n);
  for (const n of ['viewClientPeople', 'viewRequests', 'ptCanSee', 'ptInviteState', 'ptInviteLink']) assert.equal(typeof globalThis[n], 'function', n);

  globalThis.sb = undefined; delete globalThis.sb;
  try {
    for (const n of names) {
      const r = shape(await globalThis[n]('stone-roofing', { email: 'a@b.test', fullName: 'X', subject: 'X' }));
      assert.equal(r.ok, false, n + ' should not claim success without a database');
      assert.ok(typeof r.error === 'string' && r.error.length > 0, n);
      assert.ok(!/TypeError|undefined|null|\[object/.test(r.error), n + ': ' + r.error);
    }
    assert.equal(typeof await viewClientPeople('stone-roofing'), 'string');
    assert.equal(typeof await viewRequests(), 'string');
  } finally { globalThis.sb = fakeSb; }

  assert.ok(!/machineFetch|MACHINE_URL|email-distributor/.test(SRC), 'no machine, no distributor');
  assert.ok(!/\bimport\b|\brequire\(/.test(SRC), 'plain browser JavaScript, no build step');
  for (const m of SRC.match(/^\s*(?:async\s+)?function\s+[A-Za-z0-9_]+\s*\(/gm) || []) {
    const name = m.trim().replace(/^(async\s+)?function\s+/, '').replace('(', '').trim();
    assert.ok(/^pt/.test(name) || /^view(ClientPeople|Requests)$/.test(name), 'prefixed with pt: ' + name);
  }
  assert.ok(fs.existsSync(path.join(root, 'portal.css')));
  const css = fs.readFileSync(path.join(root, 'portal.css'), 'utf8');
  assert.ok(!/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])(?![^(]*\))/.test(css.replace(/var\([^)]*\)/g, '')), 'no new colours: every colour is a theme.css token');
});

/* ───────────── perfection pass ───────────── */

test('the second chat is gone: the conversation with a client lives on Channels and nowhere else', () => {
  for (const gone of ['viewClientChannel', 'ptChannelFor', 'ptSyncMembers', 'ptPost', 'ptMessages', 'ptMarkRead', 'ptUnread', 'ptPostFromForm'])
    assert.equal(typeof globalThis[gone], 'undefined', gone + ' was dead code and is removed');
  assert.ok(!/channel_members|channel_messages/.test(SRC), 'portal.js no longer writes to the chat tables');
});

test('the row buttons say what happened and redraw the screen, instead of changing the database in silence', async () => {
  const cid = seedClient();
  const drawn = [];
  globalThis.render = (v) => drawn.push(v); globalThis.currentView = 'requests';
  try {
    const q = (await ptRaiseRequest(cid, { subject: 'Can we pause?' })).data;
    const open = await viewRequests();
    assert.match(open, /onclick="ptCloseFromRow\(/, 'the button goes through the handler that answers back');
    assert.doesNotMatch(open, /onclick="ptCloseRequest\(/);
    const r = await ptCloseFromRow(q.id);
    assert.equal(r.ok, true);
    assert.deepEqual(toasts, ['Request closed.']);
    assert.deepEqual(drawn, ['requests'], 'and the list is drawn again without it');
    assert.match(await viewRequests(), /Nothing open/);

    // a failure is said out loud and nothing is redrawn
    toasts = []; drawn.length = 0;
    fails['client_requests.update'] = { message: 'That request is already closed.' };
    assert.equal((await ptCloseFromRow(q.id)).ok, false);
    assert.deepEqual(toasts, ['That request is already closed.']);
    assert.deepEqual(drawn, []);
    delete fails['client_requests.update'];

    // people and invites: the same
    globalThis.currentView = 'clientPeople';
    const a = (await ptAddPerson(cid, { fullName: 'Dana', isPrimary: true })).data;
    const b = (await ptAddPerson(cid, { fullName: 'Sam' })).data;
    const page = await viewClientPeople(cid);
    assert.match(page, /onclick="ptPrimaryFromRow\(/); assert.doesNotMatch(page, /onclick="ptSetPrimary\(/);
    toasts = []; drawn.length = 0;
    await ptPrimaryFromRow(cid, b.id);
    assert.deepEqual(toasts, ['They are the primary contact now.']); assert.deepEqual(drawn, ['clientPeople']);
    assert.equal((await ptPeople(cid)).data.filter((p) => p.is_primary).length, 1);
    await ptInvite(cid, { email: 'dana@stone.test' });
    assert.match(await viewClientPeople(cid), /onclick="ptRevokeFromRow\(/);
    toasts = [];
    await ptRevokeFromRow(rows('portal_invites')[0].id);
    assert.match(toasts[0], /Invite revoked/);
  } finally { delete globalThis.render; delete globalThis.currentView; }
});

test('a double click makes one invite, and closes a request once', async () => {
  const cid = seedClient();
  el('ptInviteEmail').value = 'dana@stone.test'; el('ptInviteRole').value = 'viewer';
  const [a, b] = await Promise.all([ptInviteFromForm(cid), ptInviteFromForm(cid)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(rpcs.filter((c) => c.name === 'portal_invite_create').length, 1);
  const q = (await ptRaiseRequest(cid, { subject: 'Hi' })).data;
  const before = calls.filter((c) => c.table === 'client_requests' && c.op === 'update').length;
  await Promise.all([ptCloseFromRow(q.id), ptCloseFromRow(q.id)]);
  assert.equal(calls.filter((c) => c.table === 'client_requests' && c.op === 'update').length, before + 1);
});

test('the Requests screen asks its three questions together', async () => {
  const cid = seedClient();
  await ptRaiseRequest(cid, { subject: 'One' });
  const at = calls.length;
  await viewRequests();
  const asked = calls.slice(at).filter((c) => c.op === 'select' || c.op == null).map((c) => c.table);
  assert.deepEqual(asked.sort(), ['client_requests', 'clients', 'profiles']);
  // with nothing open it still answers "Nothing open"
  rows('client_requests').length = 0;
  assert.match(await viewRequests(), /Nothing open/);
});
