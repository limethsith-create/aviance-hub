/* Tests for channels-api.js (the Channels data layer, CONTRACT.md "Hub data layer").
   A fake `sb` stands in for Supabase: a query builder, rpc, storage, realtime channels and auth.
   Run with:  node --test tests/channels-api.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;

/* ───────────── fake Supabase ───────────── */
let calls, rpcs, tables, uploads, removed, chans, removedChans, signed, state;
function reset() {
  calls = []; uploads = []; removed = []; chans = []; removedChans = []; signed = [];
  state = { user: 'u-me', uploadError: null, signError: null, sendResult: 'ok' };
  rpcs = {
    // team logins are u-*, client people are c-* (a client_people id), as the real channel_people answers
    channel_people: ({ p_ids }) => ({ data: p_ids.filter((i) => i !== 'u-ghost').map((id) => id.startsWith('c-')
      ? { id, name: 'Person ' + id, role: 'client', kind: 'client', company: id === 'c-nocompany' ? null : 'Stone Roofing' }
      : { id, name: id === 'u-me' ? 'Me Myself' : 'Person ' + id, role: 'admin', kind: 'team', company: null }), error: null }),
  };
  tables = {};
}
function builder(table) {
  const call = { table, op: 'select', filters: [], order: null, limit: null, payload: null, single: false, cols: null };
  calls.push(call);
  const b = {
    select(c) { call.cols = c; if (call.op === 'select') call.op = 'select'; return b; },
    insert(p) { call.op = 'insert'; call.payload = p; return b; },
    update(p) { call.op = 'update'; call.payload = p; return b; },
    delete() { call.op = 'delete'; return b; },
    eq(k, v) { call.filters.push(['eq', k, v]); return b; },
    is(k, v) { call.filters.push(['is', k, v]); return b; },
    lt(k, v) { call.filters.push(['lt', k, v]); return b; },
    ilike(k, v) { call.filters.push(['ilike', k, v]); return b; },
    order(k, o) { call.order = [k, o]; return b; },
    limit(n) { call.limit = n; return b; },
    single() { call.single = true; return b; },
    then(res, rej) {
      const h = tables[table + '.' + call.op];
      let out = typeof h === 'function' ? h(call) : (h || { data: [], error: null });
      if (call.single && out && Array.isArray(out.data)) out = out.data.length ? { data: out.data[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}
function fakeChan(name, cfg) {
  const c = { name, cfg, ons: [], subscribed: false, sent: [],
    on(type, filter, cb) { c.ons.push({ type, filter, cb }); return c; },
    subscribe() { c.subscribed = true; return c; },
    async send(m) { c.sent.push(m); return state.sendResult; } };
  chans.push(c); return c;
}
const fakeSb = {
  from: builder,
  rpc: async (name, args) => { calls.push({ rpc: name, args }); const h = rpcs[name]; return h ? h(args) : { data: null, error: null }; },
  auth: { getSession: async () => ({ data: { session: state.user ? { user: { id: state.user } } : null } }), getUser: async () => ({ data: { user: state.user ? { id: state.user } : null } }) },
  storage: { from: (bucket) => ({
    upload: async (p, f, o) => { uploads.push({ bucket, path: p, file: f, opts: o }); return state.uploadError && uploads.length >= state.uploadError.at ? { data: null, error: state.uploadError.err } : { data: { path: p }, error: null }; },
    remove: async (paths) => { removed.push(...paths); return { data: [], error: null }; },
    createSignedUrl: async (p, secs) => { signed.push({ p, secs }); return state.signError ? { data: null, error: state.signError } : { data: { signedUrl: 'https://files.test/' + p + '?t=' + signed.length }, error: null }; },
  }) },
  channel: (name, cfg) => fakeChan(name, cfg),
  removeChannel: (c) => { removedChans.push(c.name); },
};
globalThis.sb = fakeSb;
vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'channels-api.js'), 'utf8'), { filename: 'channels-api.js' });
beforeEach(() => { reset(); chTestReset(); globalThis.sb = fakeSb; });
reset();

const file = (name, size, type = 'text/plain') => ({ name, size, type });
// a channel_messages row; a client's message is crow() (author_person set, author_user null)
const row = (o = {}) => ({ id: 'm1', channel_id: 'ch1', author_user: 'u-me', author_person: null, body: 'hi', attachment_url: null, created_at: '2026-11-20T10:00:00Z', edited_at: null, deleted_at: null, ...o });
const crow = (person, o = {}) => row({ author_user: null, author_person: person, ...o });
const T = 'channel_messages';
const shape = (r) => { assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']); return r; };

/* ───────────── reading ───────────── */
test('chListChannels maps the rpc rows to the contract shape', async () => {
  rpcs.my_channels = () => ({ data: [{ id: 'a', name: 'Stone Roofing', purpose: 'Your direct line to the Aviance team', kind: 'client', client_id: 'stone-roofing', company: 'Stone Roofing', archived_at: null, created_at: '2026-11-19T09:00:00Z', last_message_at: '2026-11-20T09:00:00Z', last_body: 'hello', unread: 3 }, { id: 'b', name: 'Team', kind: 'team', client_id: null, archived_at: '2026-01-01T00:00:00Z', last_message_at: null, unread: 0 }], error: null });
  const r = shape(await chListChannels());
  assert.equal(r.ok, true); assert.equal(r.error, null);
  assert.deepEqual(r.data[0], { id: 'a', name: 'Stone Roofing', kind: 'client', clientId: 'stone-roofing', archived: false, lastMessageAt: '2026-11-20T09:00:00Z', unread: 3, company: 'Stone Roofing', purpose: 'Your direct line to the Aviance team', lastBody: 'hello' });
  assert.equal(r.data[1].archived, true); assert.equal(r.data[1].clientId, null); assert.equal(r.data[1].lastMessageAt, null); assert.equal(r.data[1].company, null);
  assert.deepEqual(calls.find((x) => x.rpc).rpc, 'my_channels');
});
test('chListChannels: a client channel made by close_won (no messages yet) is listed as a client channel', async () => {
  rpcs.my_channels = () => ({ data: [{ id: 'won', name: 'Blue Sky', kind: 'client', client_id: 'cl-1', company: 'Blue Sky', archived_at: null, last_message_at: null, last_body: null, unread: 0 }], error: null });
  const r = await chListChannels();
  assert.equal(r.data.length, 1); assert.equal(r.data[0].kind, 'client'); assert.equal(r.data[0].clientId, 'cl-1'); assert.equal(r.data[0].company, 'Blue Sky');
});
test('chListChannels: a database error comes back as plain words', async () => {
  rpcs.my_channels = () => ({ data: null, error: { code: '42P01', message: 'relation "channels" does not exist' } });
  const r = await chListChannels();
  assert.equal(r.ok, false); assert.equal(r.data, null); assert.equal(r.error, "Couldn't load your channels.");
  assert.ok(!/relation/.test(r.error));
});
test('chUnreadTotal adds up unread but skips archived channels', async () => {
  rpcs.my_channels = () => ({ data: [{ id: 'a', name: 'A', kind: 'client', unread: 2 }, { id: 'b', name: 'B', kind: 'team', unread: 5 }, { id: 'c', name: 'C', kind: 'team', unread: 9, archived_at: 'x' }], error: null });
  const r = await chUnreadTotal(); assert.equal(r.ok, true); assert.equal(r.data, 7);
});
test('chMessages reads channel_messages oldest to newest; team and client authors are named, the client marked', async () => {
  tables[T + '.select'] = () => ({ data: [crow('c-1', { id: 'm3', created_at: '2026-11-20T12:00:00Z', body: 'new' }), row({ id: 'm2', created_at: '2026-11-20T11:00:00Z', body: 'secret', attachment_url: 'https://x.test/a.pdf', deleted_at: '2026-11-20T11:05:00Z' }), row({ id: 'm1', edited_at: '2026-11-20T10:30:00Z' })], error: null });
  const r = await chMessages('ch1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.map((m) => m.id), ['m1', 'm2', 'm3']);
  assert.equal(r.data[0].name, 'Me Myself'); assert.equal(r.data[0].userId, 'u-me'); assert.equal(r.data[0].isClient, false); assert.equal(r.data[0].authorKind, 'team');
  assert.equal(r.data[2].name, 'Person c-1 (Stone Roofing)'); assert.equal(r.data[2].userId, 'c-1');
  assert.equal(r.data[2].isClient, true); assert.equal(r.data[2].authorKind, 'client'); assert.equal(r.data[2].company, 'Stone Roofing');
  assert.equal(r.data[0].editedAt, '2026-11-20T10:30:00Z');
  assert.equal(r.data[1].deleted, true); assert.equal(r.data[1].body, ''); assert.deepEqual(r.data[1].attachments, []);
  const c = calls.find((x) => x.table === T);
  assert.equal(c.cols, 'id,channel_id,author_user,author_person,body,attachment_url,created_at,edited_at,deleted_at');
  assert.deepEqual(c.filters, [['eq', 'channel_id', 'ch1']]); assert.deepEqual(c.order, ['created_at', { ascending: false }]); assert.equal(c.limit, 50);
  assert.deepEqual(calls.find((x) => x.rpc === 'channel_people').args.p_ids.sort(), ['c-1', 'u-me']);
  assert.equal(calls.filter((x) => x.table === 'messages').length, 0, 'the old messages table is never touched');
});
test('chMessages: a client without a company still reads as a client; attachment_url web links become one attachment', async () => {
  tables[T + '.select'] = () => ({ data: [crow('c-nocompany', { id: 'a' }), row({ id: 'b', attachment_url: 'https://files.test/folder/Quote%20v2.pdf' }), row({ id: 'c', attachment_url: 'chat-files/x.pdf' })], error: null });
  const r = await chMessages('ch1');
  assert.deepEqual(r.data.map((m) => m.id), ['c', 'b', 'a']);
  assert.equal(r.data[2].name, 'Person c-nocompany (client)');
  assert.deepEqual(r.data[1].attachments, [{ path: 'https://files.test/folder/Quote%20v2.pdf', url: 'https://files.test/folder/Quote%20v2.pdf', name: 'Quote v2.pdf', size: 0, type: '' }]);
  assert.deepEqual(r.data[0].attachments, [], 'a storage path with no bucket is dropped');
});
test('chMessages: before + limit are applied (limit capped), names are fetched once and cached', async () => {
  tables[T + '.select'] = () => ({ data: [row()], error: null });
  await chMessages('ch1', { before: '2026-11-20T10:00:00Z', limit: 10 });
  await chMessages('ch1', { limit: 9999 });
  const m = calls.filter((x) => x.table === T);
  assert.deepEqual(m[0].filters.at(-1), ['lt', 'created_at', '2026-11-20T10:00:00Z']); assert.equal(m[0].limit, 10); assert.equal(m[1].limit, 200);
  assert.equal(calls.filter((x) => x.rpc === 'channel_people').length, 1);
});
test('chMessages: an unknown author shows as "Someone"; a failing names lookup does not fail the load', async () => {
  tables[T + '.select'] = () => ({ data: [row({ author_user: 'u-ghost' })], error: null });
  assert.equal((await chMessages('ch1')).data[0].name, 'Someone');
  chTestReset(); rpcs.channel_people = () => { throw new Error('boom'); };
  const r = await chMessages('ch1'); assert.equal(r.ok, true); assert.equal(r.data[0].name, 'Someone');
});
test('chMessages without a channel or on a database error', async () => {
  assert.match((await chMessages('')).error, /Pick a channel/);
  tables[T + '.select'] = () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } });
  const r = await chMessages('ch1'); assert.equal(r.ok, false); assert.equal(r.error, "You don't have access to do that.");
});
test('chSearch escapes % and _, skips deleted, adds channel names; empty text gives nothing', async () => {
  rpcs.my_channels = () => ({ data: [{ id: 'ch1', name: 'Stone Roofing', kind: 'client', unread: 0 }], error: null });
  tables[T + '.select'] = () => ({ data: [row({ body: '100% sure' })], error: null });
  const r = await chSearch('  100%_x '); assert.equal(r.ok, true);
  const c = calls.find((x) => x.table === T);
  assert.deepEqual(c.filters, [['ilike', 'body', '%100\\%\\_x%'], ['is', 'deleted_at', null]]);
  assert.equal(r.data[0].channelName, 'Stone Roofing');
  const e = await chSearch('   '); assert.deepEqual(e.data, []); assert.equal(e.ok, true);
  tables[T + '.select'] = () => ({ data: null, error: { message: 'Failed to fetch' } });
  assert.match((await chSearch('x')).error, /Can't reach Aviance/);
});

/* ───────────── sending ───────────── */
test('chSend: writes channel_messages with author_user = you and author_person null', async () => {
  tables[T + '.insert'] = (c) => ({ data: [row({ body: c.payload.body, id: 'new1' })], error: null });
  const r = await chSend('ch1', '  hello there  ', []);
  assert.equal(r.ok, true); assert.equal(r.data.body, 'hello there'); assert.equal(r.data.id, 'new1'); assert.equal(r.data.name, 'Me Myself'); assert.equal(r.data.userId, 'u-me'); assert.equal(r.data.isClient, false);
  const c = calls.find((x) => x.op === 'insert');
  assert.equal(c.table, T);
  assert.deepEqual(c.payload, { channel_id: 'ch1', author_user: 'u-me', author_person: null, body: 'hello there' });
  assert.equal(uploads.length, 0);
});
test('chSend: files are refused in plain words (no storage bucket yet) and nothing is sent or uploaded', async () => {
  tables[T + '.insert'] = () => ({ data: [row()], error: null });
  const r = await chSend('ch1', 'see attached', [file('plan.pdf', 1234, 'application/pdf')]);
  assert.equal(r.ok, false); assert.match(r.error, /Sending files isn't switched on yet/);
  assert.equal(uploads.length, 0); assert.equal(calls.filter((c) => c.op === 'insert').length, 0);
});
test('chSend: limits', async () => {
  assert.match((await chSend('ch1', '   ', [])).error, /Write a message first/);
  assert.match((await chSend('ch1', 'a'.repeat(8001), [])).error, /too long/);
  assert.match((await chSend('', 'x', [])).error, /Pick a channel/);
  tables[T + '.insert'] = () => ({ data: null, error: { code: '42501', message: 'row-level security' } });
  assert.equal((await chSend('ch1', 'x')).error, "You don't have access to do that.");
});
test('chSend: signed out gives a plain message; no sb gives a plain message; never throws', async () => {
  state.user = null; assert.match((await chSend('ch1', 'x')).error, /sign in again/);
  state.user = 'u-me'; globalThis.sb = undefined; delete globalThis.sb;
  const r = await chSend('ch1', 'x'); assert.equal(r.ok, false); assert.match(r.error, /reload the page/);
  assert.equal((await chListChannels()).ok, false);
});

/* ───────────── edit / delete / read / file links ───────────── */
test('chEdit updates the body and stamps edited_at; nothing updated means not yours', async () => {
  tables[T + '.update'] = (c) => ({ data: [row({ body: c.payload.body, edited_at: c.payload.edited_at })], error: null });
  const r = await chEdit('m1', ' fixed ');
  assert.equal(r.ok, true); assert.equal(r.data.body, 'fixed'); assert.ok(r.data.editedAt);
  const c = calls.find((x) => x.op === 'update'); assert.equal(c.table, T);
  assert.deepEqual(c.filters, [['eq', 'id', 'm1'], ['eq', 'author_user', 'u-me'], ['is', 'deleted_at', null]]);   // only your own
  tables[T + '.update'] = () => ({ data: [], error: null });
  assert.match((await chEdit('m1', 'x')).error, /only edit your own/);
  assert.match((await chEdit('m1', '  ')).error, /can't be empty/);
  assert.match((await chEdit('m1', 'a'.repeat(8001))).error, /too long/);
  assert.match((await chEdit('', 'x')).error, /Pick a message/);
});
test('chDelete is a soft delete and only works on your own messages', async () => {
  tables[T + '.update'] = (c) => ({ data: [row({ deleted_at: c.payload.deleted_at })], error: null });
  const r = await chDelete('m1');
  assert.equal(r.ok, true); assert.equal(r.data.deleted, true); assert.equal(r.data.body, '');
  const u = calls.find((x) => x.op === 'update');
  assert.deepEqual(Object.keys(u.payload), ['deleted_at']); assert.equal(u.table, T);
  assert.deepEqual(u.filters, [['eq', 'id', 'm1'], ['eq', 'author_user', 'u-me'], ['is', 'deleted_at', null]]);
  assert.equal(calls.filter((c) => c.op === 'delete').length, 0);
  tables[T + '.update'] = () => ({ data: [], error: null });
  assert.match((await chDelete('m1')).error, /only delete your own/);
  tables[T + '.update'] = () => ({ data: null, error: { message: 'Failed to fetch' } });
  assert.match((await chDelete('m1')).error, /Can't reach Aviance/);
});
test('chMarkRead calls the database function; failures are plain words', async () => {
  rpcs.mark_channel_read = () => ({ data: null, error: null });
  assert.equal((await chMarkRead('ch1')).ok, true);
  assert.deepEqual(calls.find((x) => x.rpc === 'mark_channel_read').args, { c: 'ch1' });
  rpcs.mark_channel_read = () => ({ data: null, error: { code: 'P0001', message: 'You do not have access to that channel.' } });
  assert.equal((await chMarkRead('ch1')).error, 'You do not have access to that channel.');
  assert.match((await chMarkRead('')).error, /Pick a channel/);
});
test('chFileUrl: hands back a web link as it is (no bucket to sign from); refuses anything else', async () => {
  const a = await chFileUrl('https://files.test/a.pdf'); assert.equal(a.ok, true); assert.equal(a.data, 'https://files.test/a.pdf');
  const b = await chFileUrl({ path: 'https://files.test/a.pdf', url: 'https://files.test/a.pdf' }); assert.equal(b.data, 'https://files.test/a.pdf');
  assert.equal(signed.length, 0);
  assert.match((await chFileUrl('../secret')).error, /isn't valid/); assert.match((await chFileUrl('')).error, /isn't valid/); assert.match((await chFileUrl('ch1/abc-doc.pdf')).error, /isn't valid/);
  assert.match((await chFileUrl('javascript:alert(1)')).error, /isn't valid/);
});

/* ───────────── live updates ───────────── */
test('chSubscribe: new messages, updates and typing reach the callbacks; unsubscribe closes everything', async () => {
  const got = { msg: [], upd: [], typ: [] };
  const unsub = chSubscribe('ch1', { onMessage: (m) => got.msg.push(m), onUpdate: (m) => got.upd.push(m), onTyping: (t) => got.typ.push(t) });
  assert.equal(typeof unsub, 'function'); assert.equal(unsub.ok, true); assert.equal(unsub.error, null);
  const live = chans.find((c) => c.name === 'chat:ch1'), typing = chans.find((c) => c.name === 'typing:ch1');
  assert.ok(live.subscribed && typing.subscribed);
  const ins = live.ons.find((o) => o.filter.event === 'INSERT'), upd = live.ons.find((o) => o.filter.event === 'UPDATE');
  assert.equal(ins.filter.table, 'channel_messages'); assert.equal(upd.filter.table, 'channel_messages'); assert.equal(ins.filter.filter, 'channel_id=eq.ch1');
  ins.cb({ new: crow('c-9', { id: 'n1', body: 'ping' }) });
  upd.cb({ new: row({ id: 'n1', deleted_at: '2026-11-20T13:00:00Z' }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got.msg[0].name, 'Person c-9 (Stone Roofing)'); assert.equal(got.msg[0].isClient, true); assert.equal(got.msg[0].body, 'ping');
  assert.equal(got.upd[0].deleted, true);
  typing.ons.find((o) => o.type === 'broadcast').cb({ payload: { user_id: 'c-9', name: 'Pat' } });
  assert.deepEqual(got.typ, [{ userId: 'c-9', name: 'Pat' }]);
  assert.equal(typing.ons[0].filter.event, 'typing');
  unsub(); unsub();
  assert.deepEqual(removedChans.sort(), ['chat:ch1', 'typing:ch1']);
  ins.cb({ new: row() }); await new Promise((r) => setTimeout(r, 5));
  assert.equal(got.msg.length, 1, 'nothing is delivered after unsubscribe');
});
test('chSubscribe: a callback that throws does not break anything; no channel gives a harmless unsubscribe', async () => {
  const unsub = chSubscribe('ch1', { onMessage: () => { throw new Error('screen bug'); } });
  chans.find((c) => c.name === 'chat:ch1').ons[0].cb({ new: row() });
  await new Promise((r) => setTimeout(r, 5));
  unsub();
  const bad = chSubscribe('', {}); assert.equal(typeof bad, 'function'); assert.equal(bad.ok, false); assert.match(bad.error, /Pick a channel/); bad();
});
test('chTyping: sends {user_id, name} on typing:{channel}, at most once every 3 seconds per channel', async () => {
  const a = await chTyping('ch1'); assert.equal(a.ok, true); assert.equal(a.data.sent, true);
  const ch = chans.find((c) => c.name === 'typing:ch1');
  assert.deepEqual(ch.sent[0], { type: 'broadcast', event: 'typing', payload: { user_id: 'u-me', name: 'Me Myself' } });
  const b = await chTyping('ch1'); assert.equal(b.data.sent, false); assert.equal(ch.sent.length, 1);
  await chTyping('ch2'); assert.equal(chans.find((c) => c.name === 'typing:ch2').sent.length, 1);
  const realNow = Date.now; Date.now = () => realNow() + 3100;
  try { await chTyping('ch1'); } finally { Date.now = realNow; }
  assert.equal(ch.sent.length, 2);
  assert.match((await chTyping('')).error, /Pick a channel/);
});
test('chTyping shares the open channel with chSubscribe instead of opening a second one', async () => {
  const unsub = chSubscribe('ch1', {});
  await chTyping('ch1');
  assert.equal(chans.filter((c) => c.name === 'typing:ch1').length, 1);
  unsub();
});

/* ───────────── channels and people ───────────── */
test('chCreateChannel makes a team channel and adds you plus the chosen people once', async () => {
  tables['channels.insert'] = (c) => ({ data: [{ id: 'new', name: c.payload.name, kind: 'team', client_id: null, archived_at: null }], error: null });
  const r = await chCreateChannel('  Planning  ', ['u-2', 'u-me', 'u-2', 'u-3']);
  assert.equal(r.ok, true); assert.equal(r.data.id, 'new'); assert.equal(r.data.name, 'Planning'); assert.equal(r.data.kind, 'team');
  assert.deepEqual(calls.find((c) => c.table === 'channels').payload, { name: 'Planning', kind: 'team', created_by: 'u-me' });
  const mem = calls.find((c) => c.table === 'channel_members').payload;
  assert.deepEqual(mem.map((m) => m.user_id), ['u-me', 'u-2', 'u-3']); assert.equal(mem[0].member_role, 'owner'); assert.equal(mem[1].member_role, undefined);
  assert.match((await chCreateChannel('   ', [])).error, /Give the channel a name/);
  assert.match((await chCreateChannel('x'.repeat(81), [])).error, /under 80/);
});
test('chCreateChannel: if people could not be added you still get the new channel back with a plain warning', async () => {
  tables['channels.insert'] = () => ({ data: [{ id: 'new', name: 'P', kind: 'team', client_id: null }], error: null });
  tables['channel_members.insert'] = () => ({ data: null, error: { code: '42501', message: 'rls' } });
  const r = await chCreateChannel('P', ['u-2']);
  assert.equal(r.ok, false); assert.match(r.error, /created, but some people couldn't be added/); assert.equal(r.data.id, 'new');
  tables['channels.insert'] = () => ({ data: null, error: { code: '42501', message: 'rls' } });
  const d = await chCreateChannel('P', []); assert.equal(d.ok, false); assert.equal(d.data, null); assert.equal(d.error, "You don't have access to do that.");
});
test('chRename and chArchive (and un-archive)', async () => {
  tables['channels.update'] = (c) => ({ data: [{ id: 'ch1', name: c.payload.name || 'Old', archived_at: c.payload.archived_at || null }], error: null });
  const r = await chRename('ch1', ' New name '); assert.equal(r.ok, true); assert.equal(r.data.name, 'New name');
  assert.deepEqual(Object.keys(calls.find((c) => c.op === 'update').payload), ['name']);
  assert.match((await chRename('ch1', '')).error, /Give the channel a name/);
  const a = await chArchive('ch1'); assert.equal(a.data.archived, true);
  const u = await chArchive('ch1', false); assert.equal(u.data.archived, false);
  tables['channels.update'] = () => ({ data: [], error: null });
  assert.match((await chArchive('ch1')).error, /Only Aviance staff/); assert.match((await chRename('ch1', 'x')).error, /Only Aviance staff/);
});
test('chAddMember (already a member is fine), chRemoveMember', async () => {
  assert.equal((await chAddMember('ch1', 'u-2')).ok, true);
  assert.deepEqual(calls.find((c) => c.op === 'insert').payload, { channel_id: 'ch1', user_id: 'u-2' });
  tables['channel_members.insert'] = () => ({ data: null, error: { code: '23505', message: 'duplicate key' } });
  assert.equal((await chAddMember('ch1', 'u-2')).ok, true);
  tables['channel_members.insert'] = () => ({ data: null, error: { code: '42501', message: 'rls' } });
  assert.equal((await chAddMember('ch1', 'u-2')).error, "You don't have access to do that.");
  assert.match((await chAddMember('ch1', '')).error, /Pick a channel and a person/);
  assert.equal((await chRemoveMember('ch1', 'u-2')).ok, true);
  assert.deepEqual(calls.find((c) => c.op === 'delete').filters, [['eq', 'channel_id', 'ch1'], ['eq', 'user_id', 'u-2']]);
  tables['channel_members.delete'] = () => ({ data: null, error: { message: 'Failed to fetch' } });
  assert.match((await chRemoveMember('ch1', 'u-2')).error, /Can't reach/);
});
test('chMembers lists team logins and client people (marked), team first, by name', async () => {
  tables['channel_members.select'] = () => ({ data: [{ user_id: null, person_id: 'c-1', member_role: 'member', added_at: 'a', last_read_at: null }, { user_id: 'u-zed', person_id: null, member_role: 'member', added_at: 'a', last_read_at: 'b' }, { user_id: 'u-me', person_id: null, member_role: 'owner', added_at: 'a', last_read_at: 'b' }], error: null });
  const r = await chMembers('ch1');
  assert.deepEqual(r.data.map((m) => m.name), ['Me Myself', 'Person u-zed', 'Person c-1 (Stone Roofing)']);
  assert.equal(r.data[0].role, 'owner'); assert.equal(r.data[0].kind, 'team'); assert.equal(r.data[0].profileRole, 'admin');
  assert.equal(r.data[2].userId, 'c-1'); assert.equal(r.data[2].isClient, true); assert.equal(r.data[2].kind, 'client'); assert.equal(r.data[2].profileRole, 'client');
  assert.equal(calls.find((c) => c.table === 'channel_members').cols, 'user_id,person_id,member_role,added_at,last_read_at');
  assert.match((await chMembers('')).error, /Pick a channel/);
});
test('chEnsureClientChannel returns the channel id; errors from the database are plain', async () => {
  rpcs.ensure_client_channel = () => ({ data: 'chan-uuid', error: null });
  const r = await chEnsureClientChannel('stone-roofing', 'Stone Roofing'); assert.equal(r.ok, true); assert.equal(r.data, 'chan-uuid');
  assert.deepEqual(calls.find((x) => x.rpc === 'ensure_client_channel').args, { p_client_id: 'stone-roofing', p_name: 'Stone Roofing' });
  rpcs.ensure_client_channel = () => ({ data: null, error: { code: 'P0001', message: 'Only Aviance staff can set up a client channel.' } });
  assert.equal((await chEnsureClientChannel('x', 'X')).error, 'Only Aviance staff can set up a client channel.');
  rpcs.ensure_client_channel = () => ({ data: null, error: { code: 'XX000', message: 'internal pg detail' } });
  assert.equal((await chEnsureClientChannel('x', 'X')).error, "Couldn't set up that client's channel.");
  assert.match((await chEnsureClientChannel(' ', 'X')).error, /Pick a client/);
});

/* ───────────── contract: every function exists, always answers {ok,data,error}, never throws ───────────── */
test('every contract function exists and answers in the {ok,data,error} shape even when the network is down', async () => {
  const names = ['chListChannels', 'chMessages', 'chSend', 'chEdit', 'chDelete', 'chMarkRead', 'chTyping', 'chCreateChannel', 'chRename', 'chArchive', 'chAddMember', 'chRemoveMember', 'chMembers', 'chEnsureClientChannel', 'chFileUrl', 'chUnreadTotal', 'chSearch'];
  for (const n of names) assert.equal(typeof globalThis[n], 'function', n);
  assert.equal(typeof chSubscribe, 'function');
  const down = () => { throw new TypeError('Failed to fetch'); };
  fakeSb.from = down; const rpc0 = fakeSb.rpc; fakeSb.rpc = down;
  try {
    for (const n of names) {
      const r = shape(await globalThis[n]('ch1', 'x', 'y'));
      assert.equal(typeof r.ok, 'boolean'); assert.ok(r.ok || (typeof r.error === 'string' && r.error.length > 0), n);
      assert.ok(r.ok || !/TypeError|Failed to fetch|undefined/.test(r.error), n + ': ' + r.error);
    }
  } finally { fakeSb.from = builder; fakeSb.rpc = rpc0; }
});
test('files: channels-api.js is loaded first and syntax-checked by npm run check; it renders nothing and keeps no secrets', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="channels-api.js"></script>') > 0);
  assert.ok(html.indexOf('<script src="channels-api.js"></script>') < html.indexOf('<script src="finance.js"></script>'));
  assert.match(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.check, /node --check channels-api\.js/);
  const src = fs.readFileSync(path.join(root, 'channels-api.js'), 'utf8');
  assert.ok(!/innerHTML|document\./.test(src));
});

/* ───────────── the bot's drafts for one channel ───────────── */
test('chBotDrafts / chBotSend / chBotDiscard: filter to the channel, send the edited text, plain errors', async () => {
  reset();
  rpcs.drafts_pending = () => ({ data: [
    { id: 'd2', channel_id: 'ch1', kind: 'reply', body: 'second', reason: 'r', msg_kind: 'bot', created_at: '2026-11-24T10:05:00Z' },
    { id: 'd1', channel_id: 'ch1', kind: 'welcome', body: 'first', reason: null, msg_kind: 'bot', created_at: '2026-11-24T10:00:00Z' },
    { id: 'd3', channel_id: 'ch2', kind: 'reply', body: 'elsewhere', created_at: '2026-11-24T10:01:00Z' },
  ], error: null });
  const r = await chBotDrafts('ch1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.map((d) => d.id), ['d1', 'd2']);
  assert.equal(r.data[0].kind, 'welcome'); assert.equal(r.data[1].reason, 'r');
  assert.deepEqual((await chBotDrafts('')).data, []);
  rpcs.draft_send = () => ({ data: { message_id: 'm77' }, error: null });
  const s = await chBotSend('d1', '  hey Sam  ');
  assert.deepEqual(s, { ok: true, data: { messageId: 'm77' }, error: null });
  assert.deepEqual(calls.find((c) => c.rpc === 'draft_send').args, { p_draft: 'd1', p_body: 'hey Sam' });
  const empty = await chBotSend('d1', '   ');
  assert.equal(empty.ok, false); assert.match(empty.error, /empty/);
  rpcs.draft_send = () => ({ data: null, error: { code: 'P0001', message: 'That draft was already sent.' } });
  assert.equal((await chBotSend('d1', 'x')).error, 'That draft was already sent.');
  rpcs.draft_discard = () => ({ data: null, error: null });
  assert.deepEqual(await chBotDiscard('d2'), { ok: true, data: { id: 'd2' }, error: null });
  assert.deepEqual(calls.filter((c) => c.rpc === 'draft_discard').map((c) => c.args), [{ p_draft: 'd2' }]);
  rpcs.drafts_pending = () => ({ data: null, error: { code: '42501', message: 'permission denied' } });
  const denied = await chBotDrafts('ch1');
  assert.equal(denied.ok, false); assert.equal(denied.error, "You don't have access to do that.");
});

/* ───────────── perfection pass ───────────── */
test('names: a lookup that failed is asked again next time, instead of "Someone" sticking for the whole visit', async () => {
  tables[T + '.select'] = () => ({ data: [row({ id: 'm1', author_user: 'u-sam' })], error: null });
  const real = rpcs.channel_people;
  rpcs.channel_people = () => ({ data: null, error: { message: 'Failed to fetch' } });
  const first = await chMessages('ch1');
  assert.equal(first.ok, true, 'the thread still loads');
  assert.equal(first.data[0].name, 'Someone');
  rpcs.channel_people = real;
  const again = await chMessages('ch1');
  assert.equal(again.data[0].name, 'Person u-sam', 'the name is fetched once the lookup works again');
  // a lookup that answered but did not know the id IS remembered, so it is not asked for on every message
  tables[T + '.select'] = () => ({ data: [row({ id: 'm2', author_user: 'u-ghost' })], error: null });
  await chMessages('ch1');
  const before = calls.filter((c) => c.rpc === 'channel_people').length;
  await chMessages('ch1');
  assert.equal(calls.filter((c) => c.rpc === 'channel_people').length, before);
});

test('chSearch asks for the messages and the channel names at the same time', async () => {
  let open = 0, most = 0;
  const slow = (out) => new Promise((r) => { open++; most = Math.max(most, open); setTimeout(() => { open--; r(out); }, 15); });
  tables[T + '.select'] = () => slow({ data: [row({ id: 'm1', body: 'the quote' })], error: null });
  rpcs.my_channels = () => slow({ data: [{ id: 'ch1', name: 'General', kind: 'team' }], error: null });
  const r = await chSearch('quote');
  assert.equal(r.ok, true);
  assert.equal(r.data[0].channelName, 'General');
  assert.equal(most, 2, 'both lookups were in flight together');
  // and the channel names stay optional
  rpcs.my_channels = () => ({ data: null, error: { message: 'down' } });
  const r2 = await chSearch('quote');
  assert.equal(r2.ok, true); assert.equal(r2.data[0].channelName, '');
});
