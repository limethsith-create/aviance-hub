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
    channel_people: ({ p_ids }) => ({ data: p_ids.filter((i) => i !== 'u-ghost').map((id) => ({ id, name: id === 'u-me' ? 'Me Myself' : 'Person ' + id, role: id.startsWith('c-') ? 'client' : 'admin' })), error: null }),
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
vm.runInThisContext(fs.readFileSync(path.join(root, 'channels-api.js'), 'utf8'), { filename: 'channels-api.js' });
beforeEach(() => { reset(); chTestReset(); globalThis.sb = fakeSb; });
reset();

const file = (name, size, type = 'text/plain') => ({ name, size, type });
const row = (o = {}) => ({ id: 'm1', channel_id: 'ch1', user_id: 'u-me', body: 'hi', attachments: [], created_at: '2026-11-20T10:00:00Z', edited_at: null, deleted_at: null, ...o });
const shape = (r) => { assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']); return r; };

/* ───────────── reading ───────────── */
test('chListChannels maps the rpc rows to the contract shape', async () => {
  rpcs.my_channels = () => ({ data: [{ id: 'a', name: 'Stone Roofing', kind: 'client', client_id: 'stone-roofing', archived_at: null, last_message_at: '2026-11-20T09:00:00Z', unread: 3 }, { id: 'b', name: 'Team', kind: 'team', client_id: null, archived_at: '2026-01-01T00:00:00Z', last_message_at: null, unread: 0 }], error: null });
  const r = shape(await chListChannels());
  assert.equal(r.ok, true); assert.equal(r.error, null);
  assert.deepEqual(r.data[0], { id: 'a', name: 'Stone Roofing', kind: 'client', clientId: 'stone-roofing', archived: false, lastMessageAt: '2026-11-20T09:00:00Z', unread: 3 });
  assert.equal(r.data[1].archived, true); assert.equal(r.data[1].clientId, null); assert.equal(r.data[1].lastMessageAt, null);
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
test('chMessages returns oldest to newest, with names, edits and deleted messages blanked', async () => {
  tables['messages.select'] = () => ({ data: [row({ id: 'm3', created_at: '2026-11-20T12:00:00Z', user_id: 'c-1', body: 'new' }), row({ id: 'm2', created_at: '2026-11-20T11:00:00Z', body: 'secret', attachments: [{ path: 'p', name: 'n', size: 1, type: 't' }], deleted_at: '2026-11-20T11:05:00Z' }), row({ id: 'm1', edited_at: '2026-11-20T10:30:00Z' })], error: null });
  const r = await chMessages('ch1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.map((m) => m.id), ['m1', 'm2', 'm3']);
  assert.equal(r.data[0].name, 'Me Myself'); assert.equal(r.data[2].name, 'Person c-1');
  assert.equal(r.data[0].editedAt, '2026-11-20T10:30:00Z');
  assert.equal(r.data[1].deleted, true); assert.equal(r.data[1].body, ''); assert.deepEqual(r.data[1].attachments, []);
  const c = calls.find((x) => x.table === 'messages');
  assert.deepEqual(c.filters, [['eq', 'channel_id', 'ch1']]); assert.deepEqual(c.order, ['created_at', { ascending: false }]); assert.equal(c.limit, 50);
});
test('chMessages: before + limit are applied (limit capped), names are fetched once and cached', async () => {
  tables['messages.select'] = () => ({ data: [row()], error: null });
  await chMessages('ch1', { before: '2026-11-20T10:00:00Z', limit: 10 });
  await chMessages('ch1', { limit: 9999 });
  const m = calls.filter((x) => x.table === 'messages');
  assert.deepEqual(m[0].filters.at(-1), ['lt', 'created_at', '2026-11-20T10:00:00Z']); assert.equal(m[0].limit, 10); assert.equal(m[1].limit, 200);
  assert.equal(calls.filter((x) => x.rpc === 'channel_people').length, 1);
});
test('chMessages: an unknown author shows as "Someone"; a failing names lookup does not fail the load', async () => {
  tables['messages.select'] = () => ({ data: [row({ user_id: 'u-ghost' })], error: null });
  assert.equal((await chMessages('ch1')).data[0].name, 'Someone');
  chTestReset(); rpcs.channel_people = () => { throw new Error('boom'); };
  const r = await chMessages('ch1'); assert.equal(r.ok, true); assert.equal(r.data[0].name, 'Someone');
});
test('chMessages without a channel or on a database error', async () => {
  assert.match((await chMessages('')).error, /Pick a channel/);
  tables['messages.select'] = () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } });
  const r = await chMessages('ch1'); assert.equal(r.ok, false); assert.equal(r.error, "You don't have access to do that.");
});
test('chSearch escapes % and _, skips deleted, adds channel names; empty text gives nothing', async () => {
  rpcs.my_channels = () => ({ data: [{ id: 'ch1', name: 'Stone Roofing', kind: 'client', unread: 0 }], error: null });
  tables['messages.select'] = () => ({ data: [row({ body: '100% sure' })], error: null });
  const r = await chSearch('  100%_x '); assert.equal(r.ok, true);
  const c = calls.find((x) => x.table === 'messages');
  assert.deepEqual(c.filters, [['ilike', 'body', '%100\\%\\_x%'], ['is', 'deleted_at', null]]);
  assert.equal(r.data[0].channelName, 'Stone Roofing');
  const e = await chSearch('   '); assert.deepEqual(e.data, []); assert.equal(e.ok, true);
  tables['messages.select'] = () => ({ data: null, error: { message: 'Failed to fetch' } });
  assert.match((await chSearch('x')).error, /Can't reach Aviance/);
});

/* ───────────── sending ───────────── */
test('chSend: text only', async () => {
  tables['messages.insert'] = (c) => ({ data: [row({ body: c.payload.body, id: 'new1' })], error: null });
  const r = await chSend('ch1', '  hello there  ', []);
  assert.equal(r.ok, true); assert.equal(r.data.body, 'hello there'); assert.equal(r.data.id, 'new1'); assert.equal(r.data.name, 'Me Myself');
  const c = calls.find((x) => x.op === 'insert');
  assert.deepEqual(c.payload, { channel_id: 'ch1', user_id: 'u-me', body: 'hello there', attachments: [] });
  assert.equal(uploads.length, 0);
});
test('chSend: files go to chat-files/{channel}/{uuid}-{safe-name} and are listed on the message', async () => {
  tables['messages.insert'] = (c) => ({ data: [row({ attachments: c.payload.attachments })], error: null });
  const r = await chSend('ch1', '', [file('../../My Plan (v2).pdf', 1234, 'application/pdf'), file('', 10, '')]);
  assert.equal(r.ok, true); assert.equal(uploads.length, 2);
  assert.equal(uploads[0].bucket, 'chat-files');
  assert.match(uploads[0].path, /^ch1\/[0-9a-f-]{36}-My_Plan_v2_.pdf$/);
  assert.match(uploads[1].path, /^ch1\/[0-9a-f-]{36}-file$/);
  assert.equal(uploads[0].opts.upsert, false); assert.equal(uploads[1].opts.contentType, 'application/octet-stream');
  assert.deepEqual(r.data.attachments[0], { path: uploads[0].path, name: '../../My Plan (v2).pdf', size: 1234, type: 'application/pdf' });
});
test('chSend: limits, before anything is uploaded', async () => {
  const many = Array.from({ length: 6 }, (_, i) => file('f' + i, 1));
  assert.match((await chSend('ch1', 'x', many)).error, /up to 5 files/);
  assert.match((await chSend('ch1', 'x', [file('big.zip', 10 * 1024 * 1024 + 1)])).error, /big\.zip is too big.*10 MB/);
  assert.match((await chSend('ch1', 'x', [file('empty.txt', 0)])).error, /empty/);
  assert.match((await chSend('ch1', '   ', [])).error, /Write a message or add a file/);
  assert.match((await chSend('ch1', 'a'.repeat(8001), [])).error, /too long/);
  assert.match((await chSend('', 'x', [])).error, /Pick a channel/);
  const exactly5 = Array.from({ length: 5 }, (_, i) => file('f' + i, 1));
  tables['messages.insert'] = () => ({ data: [row()], error: null });
  assert.equal((await chSend('ch1', 'x', exactly5)).ok, true);
});
test('chSend: a failed upload removes the files already uploaded and sends nothing', async () => {
  state.uploadError = { at: 2, err: { message: 'The object exceeded the maximum allowed size' } };
  const r = await chSend('ch1', 'x', [file('a.txt', 5), file('b.txt', 5)]);
  assert.equal(r.ok, false); assert.match(r.error, /10 MB/);
  assert.equal(removed.length, 1); assert.equal(removed[0], uploads[0].path);
  assert.equal(calls.filter((c) => c.op === 'insert').length, 0);
});
test('chSend: if saving the message fails the uploaded files are cleaned up', async () => {
  tables['messages.insert'] = () => ({ data: null, error: { code: '42501', message: 'row-level security' } });
  const r = await chSend('ch1', 'x', [file('a.txt', 5)]);
  assert.equal(r.ok, false); assert.equal(r.error, "You don't have access to do that.");
  assert.deepEqual(removed, [uploads[0].path]);
});
test('chSend: signed out gives a plain message; no sb gives a plain message; never throws', async () => {
  state.user = null; assert.match((await chSend('ch1', 'x')).error, /sign in again/);
  state.user = 'u-me'; globalThis.sb = undefined; delete globalThis.sb;
  const r = await chSend('ch1', 'x'); assert.equal(r.ok, false); assert.match(r.error, /reload the page/);
  assert.equal((await chListChannels()).ok, false);
});

/* ───────────── edit / delete / read / file links ───────────── */
test('chEdit updates the body and stamps edited_at; nothing updated means not yours', async () => {
  tables['messages.update'] = (c) => ({ data: [row({ body: c.payload.body, edited_at: c.payload.edited_at })], error: null });
  const r = await chEdit('m1', ' fixed ');
  assert.equal(r.ok, true); assert.equal(r.data.body, 'fixed'); assert.ok(r.data.editedAt);
  const c = calls.find((x) => x.op === 'update'); assert.deepEqual(c.filters, [['eq', 'id', 'm1'], ['is', 'deleted_at', null]]);
  tables['messages.update'] = () => ({ data: [], error: null });
  assert.match((await chEdit('m1', 'x')).error, /only edit your own/);
  assert.match((await chEdit('m1', '  ')).error, /can't be empty/);
  assert.match((await chEdit('m1', 'a'.repeat(8001))).error, /too long/);
  assert.match((await chEdit('', 'x')).error, /Pick a message/);
});
test('chDelete is a soft delete and only works on your own messages', async () => {
  tables['messages.update'] = (c) => ({ data: [row({ deleted_at: c.payload.deleted_at })], error: null });
  const r = await chDelete('m1');
  assert.equal(r.ok, true); assert.equal(r.data.deleted, true); assert.equal(r.data.body, '');
  assert.deepEqual(Object.keys(calls.find((x) => x.op === 'update').payload), ['deleted_at']);
  assert.equal(calls.filter((c) => c.op === 'delete').length, 0);
  tables['messages.update'] = () => ({ data: [], error: null });
  assert.match((await chDelete('m1')).error, /only delete your own/);
  tables['messages.update'] = () => ({ data: null, error: { message: 'Failed to fetch' } });
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
test('chFileUrl: signed for 1 hour, reused while fresh, refuses odd paths, accepts an attachment object', async () => {
  const a = await chFileUrl('ch1/abc-doc.pdf'); assert.equal(a.ok, true); assert.match(a.data, /^https:\/\/files\.test\/ch1\/abc-doc\.pdf/);
  assert.equal(signed[0].secs, 3600);
  const b = await chFileUrl({ path: 'ch1/abc-doc.pdf' }); assert.equal(b.data, a.data); assert.equal(signed.length, 1);
  assert.match((await chFileUrl('../secret')).error, /isn't valid/); assert.match((await chFileUrl('')).error, /isn't valid/); assert.match((await chFileUrl('/abs')).error, /isn't valid/);
  state.signError = { message: 'Object not found' };
  assert.equal((await chFileUrl('ch1/other.pdf')).error, "Couldn't open that file.");
});

/* ───────────── live updates ───────────── */
test('chSubscribe: new messages, updates and typing reach the callbacks; unsubscribe closes everything', async () => {
  const got = { msg: [], upd: [], typ: [] };
  const unsub = chSubscribe('ch1', { onMessage: (m) => got.msg.push(m), onUpdate: (m) => got.upd.push(m), onTyping: (t) => got.typ.push(t) });
  assert.equal(typeof unsub, 'function'); assert.equal(unsub.ok, true); assert.equal(unsub.error, null);
  const live = chans.find((c) => c.name === 'chat:ch1'), typing = chans.find((c) => c.name === 'typing:ch1');
  assert.ok(live.subscribed && typing.subscribed);
  const ins = live.ons.find((o) => o.filter.event === 'INSERT'), upd = live.ons.find((o) => o.filter.event === 'UPDATE');
  assert.equal(ins.filter.table, 'messages'); assert.equal(ins.filter.filter, 'channel_id=eq.ch1');
  ins.cb({ new: row({ id: 'n1', user_id: 'c-9', body: 'ping' }) });
  upd.cb({ new: row({ id: 'n1', deleted_at: '2026-11-20T13:00:00Z' }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(got.msg[0].name, 'Person c-9'); assert.equal(got.msg[0].body, 'ping');
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
  assert.deepEqual(calls.find((c) => c.table === 'channel_members').payload.map((m) => m.user_id), ['u-me', 'u-2', 'u-3']);
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
test('chMembers lists names and roles, sorted by name', async () => {
  tables['channel_members.select'] = () => ({ data: [{ user_id: 'c-1', role: 'member', added_at: 'a', last_read_at: 'b' }, { user_id: 'u-me', role: 'owner', added_at: 'a', last_read_at: 'b' }], error: null });
  const r = await chMembers('ch1');
  assert.deepEqual(r.data.map((m) => m.name), ['Me Myself', 'Person c-1']);
  assert.equal(r.data[1].profileRole, 'client'); assert.equal(r.data[0].role, 'owner');
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
