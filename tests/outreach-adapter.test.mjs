/* Tests for the outreach adapter layer: outreach-adapter.js (interface + registry + sync +
   outbox), outreach-demo.js (the fake tool every screen runs on today) and the two empty
   adapters outreach-smartlead.js / outreach-instantly.js.

   A fake `sb` stands in for Supabase (a tiny query builder with upsert). No network, no DOM.
   Run with:  node --test tests/outreach-adapter.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;

/* ───────────── fake Supabase ───────────── */
let calls, tables;
function reset() { calls = []; tables = {}; }
function builder(table) {
  const call = { table, op: 'select', filters: [], order: null, limit: null, payload: null, opts: null, single: false };
  calls.push(call);
  const b = {
    select() { return b; },
    insert(p) { call.op = 'insert'; call.payload = p; return b; },
    update(p) { call.op = 'update'; call.payload = p; return b; },
    upsert(p, o) { call.op = 'upsert'; call.payload = p; call.opts = o; return b; },
    eq(k, v) { call.filters.push(['eq', k, v]); return b; },
    order(k, o) { call.order = [k, o]; return b; },
    limit(n) { call.limit = n; return b; },
    single() { call.single = true; return b; },
    maybeSingle() { call.single = true; return b; },
    then(res, rej) {
      const h = tables[table + '.' + call.op];
      let out = typeof h === 'function' ? h(call) : (h === undefined ? { data: [], error: null } : h);
      if (call.single && out && Array.isArray(out.data)) out = { data: out.data[0] ?? null, error: out.error ?? null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}
const fakeSb = { from: builder };
globalThis.sb = fakeSb;

for (const f of ['outreach-adapter.js', 'outreach-demo.js', 'outreach-smartlead.js', 'outreach-instantly.js'])
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });

reset();
beforeEach(() => { reset(); globalThis.sb = fakeSb; });

const CLIENT = 'stone-roofing';
const shape = (r) => { assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']); return r; };
const find = (table, op) => calls.filter((c) => c.table === table && c.op === op);
const FIVE = ['getCampaigns', 'getStats', 'getReplies', 'sendReply', 'getInboxHealth'];
/* dates relative to today, so these tests read the same in a year as they do now */
const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
const TODAY = day(0), DAY_59 = day(59), DAY_6 = day(6), DAY_2 = day(2);
const stubImpl = (over = {}) => Object.assign(
  Object.fromEntries(FIVE.map((m) => [m, async () => ({ ok: true, data: null, error: '' })])), over);

/* ───────────── the registry ───────────── */
test('the three shipped tools register themselves', () => {
  assert.deepEqual(oaList(), ['demo', 'instantly', 'smartlead']);
  for (const name of ['demo', 'instantly', 'smartlead']) {
    const impl = oaGet(name);
    assert.ok(impl, name + ' should be registered');
    for (const m of FIVE) assert.equal(typeof impl[m], 'function', name + '.' + m);
  }
});
test('oaGet gives null for a tool nobody registered', () => {
  assert.equal(oaGet('mailshake'), null);
  assert.equal(oaGet(''), null);
  assert.equal(oaGet(undefined), null);
});
test('oaRegister refuses a nameless or half-built tool, in plain words', () => {
  const noName = shape(oaRegister('', stubImpl()));
  assert.equal(noName.ok, false);
  assert.equal(noName.error, 'An outreach tool needs a name.');

  const notAnObject = shape(oaRegister('nope', null));
  assert.equal(notAnObject.ok, false);
  assert.match(notAnObject.error, /not set up properly/);

  const half = { ...stubImpl() };
  delete half.sendReply;
  delete half.getInboxHealth;
  const r = shape(oaRegister('half', half));
  assert.equal(r.ok, false);
  assert.match(r.error, /missing: sendReply, getInboxHealth/);
  assert.equal(oaGet('half'), null);
  assert.ok(!oaList().includes('half'));
});
test('oaRegister wraps a method that throws, so the caller still gets {ok,data,error}', async () => {
  const added = oaRegister('throwy', stubImpl({ getCampaigns: async () => { throw new Error('socket hung up'); } }));
  assert.equal(added.ok, true);
  const r = shape(await oaGet('throwy').getCampaigns(CLIENT));
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.equal(r.error, 'socket hung up');
});
test('oaRegister turns a wrong-shaped answer into an error instead of passing it on', async () => {
  oaRegister('junky', stubImpl({ getStats: async () => undefined }));
  const r = shape(await oaGet('junky').getStats(CLIENT, {}));
  assert.equal(r.ok, false);
  assert.match(r.error, /gave no answer/);
});

/* ───────────── oaFor ───────────── */
test('oaFor falls back to the demo tool when the client has no account row yet', async () => {
  tables['outreach_accounts.select'] = { data: [], error: null };
  const r = shape(await oaFor(CLIENT));
  assert.equal(r.ok, true);
  assert.equal(r.data.provider, 'demo');
  assert.equal(r.data.account, null);
  assert.equal(r.data.impl, oaGet('demo'));
  assert.deepEqual(find('outreach_accounts', 'select')[0].filters, [['eq', 'client_id', CLIENT]]);
});
test('oaFor uses the provider on the account row', async () => {
  tables['outreach_accounts.select'] = { data: [{ id: 'acc1', client_id: CLIENT, provider: 'smartlead', label: 'Main' }], error: null };
  const r = await oaFor(CLIENT);
  assert.equal(r.ok, true);
  assert.equal(r.data.provider, 'smartlead');
  assert.equal(r.data.account.id, 'acc1');
  assert.equal(r.data.impl, oaGet('smartlead'));
});
test('oaFor says so plainly for a provider the hub does not know', async () => {
  tables['outreach_accounts.select'] = { data: [{ id: 'acc1', provider: 'lemlist' }], error: null };
  const r = await oaFor(CLIENT);
  assert.equal(r.ok, false);
  assert.match(r.error, /does not know about yet/);
});
test('oaFor needs a client, and passes a database error back as plain words', async () => {
  const none = shape(await oaFor(''));
  assert.equal(none.ok, false);
  assert.equal(none.error, 'Pick a client first.');

  tables['outreach_accounts.select'] = { data: null, error: { message: 'The outreach list could not be loaded.' } };
  const bad = await oaFor(CLIENT);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'The outreach list could not be loaded.');
});

/* ───────────── the demo tool ───────────── */
const demo = () => oaGet('demo');

test('demo getCampaigns: a few campaigns, every field the schema wants', async () => {
  const r = shape(await demo().getCampaigns(CLIENT));
  assert.equal(r.ok, true);
  assert.ok(r.data.length >= 3 && r.data.length <= 4, 'a few campaigns, got ' + r.data.length);
  for (const c of r.data) {
    assert.equal(typeof c.externalId, 'string');
    assert.ok(c.externalId.length > 0);
    assert.equal(typeof c.name, 'string');
    assert.ok(['draft', 'running', 'paused', 'finished', 'error'].includes(c.status), c.status);
    assert.match(c.startedOn, /^\d{4}-\d{2}-\d{2}$/);
    for (const k of ['sent', 'opened', 'replied', 'positive', 'booked', 'bounced', 'unsubscribed']) {
      assert.ok(Number.isInteger(c[k]) && c[k] >= 0, k + ' = ' + c[k]);
    }
    assert.ok(c.replied <= c.sent && c.opened <= c.sent);
    assert.ok(c.positive <= c.replied && c.booked <= c.positive);
  }
  assert.ok(r.data.some((c) => c.status === 'running'), 'at least one running campaign');
});
test('demo getStats: 60 days, a 2-4% reply rate and some bounces', async () => {
  const r = shape(await demo().getStats(CLIENT, { from: DAY_59, to: TODAY }));
  assert.equal(r.ok, true);
  const { totals, daily } = r.data;
  const days = new Set(daily.map((d) => d.onDay));
  assert.equal(days.size, 60, 'one row per day for 60 days');
  for (const d of daily) {
    assert.match(d.onDay, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof d.campaignExternalId, 'string');
    for (const k of ['sent', 'opened', 'replied', 'positive', 'booked', 'bounced', 'unsubscribed']) {
      assert.ok(Number.isInteger(d[k]) && d[k] >= 0, k + ' = ' + d[k]);
    }
  }
  assert.ok(totals.sent > 1000, 'a real amount of sending, got ' + totals.sent);
  const replyPct = (totals.replied / totals.sent) * 100;
  assert.ok(replyPct >= 1.8 && replyPct <= 4.2, 'reply rate should look real, got ' + replyPct.toFixed(2) + '%');
  assert.ok(totals.bounced > 0, 'some bounces');
  assert.ok(totals.bounced < totals.sent * 0.05, 'but not a flood of them');
  assert.ok(totals.opened > totals.replied);
  assert.ok(totals.booked <= totals.positive && totals.positive <= totals.replied);
});
test('demo getStats honours the window it is given', async () => {
  const r = await demo().getStats(CLIENT, { from: DAY_6, to: TODAY });
  const days = [...new Set(r.data.daily.map((d) => d.onDay))].sort();
  assert.equal(days.length, 7);
  assert.equal(days[0], DAY_6);
  assert.equal(days[6], TODAY);
});
test('demo getReplies: a dozen threads with mixed sentiment, and the status filter works', async () => {
  const r = shape(await demo().getReplies(CLIENT, {}));
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 12);
  const SENT = ['unknown', 'positive', 'neutral', 'negative', 'out_of_office', 'unsubscribe'];
  const STAT = ['open', 'answered', 'booked', 'closed'];
  for (const t of r.data) {
    assert.ok(SENT.includes(t.sentiment), t.sentiment);
    assert.ok(STAT.includes(t.status), t.status);
    assert.match(t.leadEmail, /^[^@\s]+@[^@\s]+\.[a-z]+$/);
    assert.ok(t.leadName && t.leadCompany && t.leadTitle);
    assert.ok(t.body && t.subject);
    assert.ok(!Number.isNaN(Date.parse(t.lastMessageAt)), t.lastMessageAt);
  }
  const kinds = new Set(r.data.map((t) => t.sentiment));
  assert.ok(kinds.size >= 4, 'mixed sentiment, got ' + [...kinds].join(', '));
  assert.ok(kinds.has('positive') && kinds.has('negative'));

  const booked = await demo().getReplies(CLIENT, { status: 'booked' });
  assert.ok(booked.data.length > 0);
  assert.ok(booked.data.every((t) => t.status === 'booked'));
  assert.ok(booked.data.length < 12);
});
test('demo getInboxHealth: 6 inboxes with health scores', async () => {
  const r = shape(await demo().getInboxHealth(CLIENT));
  assert.equal(r.ok, true);
  assert.equal(r.data.inboxes.length, 6);
  for (const b of r.data.inboxes) {
    assert.match(b.email, /^[^@\s]+@[^@\s]+$/);
    assert.ok(b.domain);
    assert.equal(typeof b.warmed, 'boolean');
    assert.ok(Number.isInteger(b.health) && b.health >= 0 && b.health <= 100, 'health ' + b.health);
    assert.ok(['ok', 'warming', 'warning', 'blocked', 'paused'].includes(b.status), b.status);
    assert.ok(b.sentToday <= b.dailyLimit, b.sentToday + ' sent of ' + b.dailyLimit);
  }
  assert.ok(r.data.inboxes.some((b) => b.status === 'warming'), 'some still warming up');
  assert.ok(r.data.inboxes.some((b) => b.status === 'ok'), 'some healthy');
});
test('demo sendReply just succeeds, and still refuses an empty reply', async () => {
  const r = shape(await demo().sendReply('t1', { subject: 'Re: hi', body: 'Thursday works.' }));
  assert.equal(r.ok, true);
  assert.ok(r.data.externalId);
  assert.ok(!Number.isNaN(Date.parse(r.data.sentAt)));

  const empty = await demo().sendReply('t1', { body: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'Write something before you send it.');

  const noThread = await demo().sendReply('', { body: 'hello' });
  assert.equal(noThread.ok, false);
  assert.match(noThread.error, /conversation/);
});

/* ───────────── the demo data holds still ───────────── */
test('demo data is stable across two calls (the screen must not jump)', async () => {
  const a = await Promise.all([
    demo().getCampaigns(CLIENT),
    demo().getStats(CLIENT, { from: DAY_59, to: TODAY }),
    demo().getReplies(CLIENT, {}),
    demo().getInboxHealth(CLIENT),
  ]);
  const b = await Promise.all([
    demo().getCampaigns(CLIENT),
    demo().getStats(CLIENT, { from: DAY_59, to: TODAY }),
    demo().getReplies(CLIENT, {}),
    demo().getInboxHealth(CLIENT),
  ]);
  assert.deepEqual(b[0].data, a[0].data);
  assert.deepEqual(b[1].data.totals, a[1].data.totals);
  assert.deepEqual(b[1].data.daily, a[1].data.daily);
  assert.deepEqual(b[2].data, a[2].data);
  assert.deepEqual(b[3].data, a[3].data);
});
test('a different client gets different numbers (seeded off the client id)', async () => {
  const mine = await demo().getCampaigns(CLIENT);
  const theirs = await demo().getCampaigns('harbor-dental');
  assert.notDeepEqual(theirs.data, mine.data);
  assert.notEqual(theirs.data[0].externalId, mine.data[0].externalId);
});
test('the same day of the same window reads the same whichever window asked for it', async () => {
  const wide = await demo().getStats(CLIENT, { from: DAY_59, to: TODAY });
  const narrow = await demo().getStats(CLIENT, { from: DAY_2, to: TODAY });
  for (const n of narrow.data.daily) {
    const w = wide.data.daily.find((d) => d.onDay === n.onDay && d.campaignExternalId === n.campaignExternalId);
    assert.deepEqual(n, w, 'the row for ' + n.onDay + ' changed between windows');
  }
});

/* ───────────── the two empty adapters ───────────── */
for (const [name, sentence] of [['smartlead', 'Smartlead is not connected yet.'], ['instantly', 'Instantly is not connected yet.']]) {
  test(name + ': all five methods answer ok:false with one clear sentence', async () => {
    const impl = oaGet(name);
    for (const m of FIVE) {
      const r = shape(await impl[m](CLIENT, {}));
      assert.equal(r.ok, false, name + '.' + m + ' must not claim success');
      assert.equal(r.data, null);
      assert.equal(r.error, sentence);
      assert.ok(!/[{}<>]|http|api|key|token/i.test(r.error), 'no jargon in: ' + r.error);
    }
  });
}
test('the empty adapters carry no keys and no live URLs', () => {
  for (const f of ['outreach-smartlead.js', 'outreach-instantly.js', 'outreach-adapter.js', 'outreach-demo.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/machineFetch|MACHINE_URL|email-distributor/.test(src), f + ' must not reach for the machine');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(src), f + ' must not touch the network');
    assert.ok(!/https?:\/\/[^\s'")]*(smartlead|instantly)/i.test(src), f + ' must not carry a live provider URL');
    assert.ok(!/api[_-]?key\s*[:=]\s*['"][^'"]+/i.test(src), f + ' must not carry a key');
  }
});

/* ───────────── sync ───────────── */
function wireSyncTables() {
  tables['outreach_accounts.select'] = { data: [{ id: 'acc1', client_id: CLIENT, provider: 'demo', label: 'Demo data' }], error: null };
  tables['outreach_accounts.insert'] = (c) => ({ data: [{ id: 'acc-new', ...c.payload }], error: null });
  tables['outreach_accounts.update'] = { data: [], error: null };
  tables['outreach_campaigns.upsert'] = (c) => ({ data: c.payload.map((r, i) => ({ id: 'c' + i, external_id: r.external_id })), error: null });
  tables['outreach_daily.upsert'] = (c) => ({ data: c.payload, error: null });
  tables['outreach_inboxes.upsert'] = (c) => ({ data: c.payload, error: null });
}

test('oaSync writes campaigns, daily rows and inboxes, upserting on the schema keys', async () => {
  wireSyncTables();
  const r = shape(await oaSync(CLIENT));
  assert.equal(r.ok, true);
  assert.equal(r.data.provider, 'demo');
  assert.ok(r.data.campaigns >= 3);
  assert.equal(r.data.days, r.data.campaigns * 60);
  assert.equal(r.data.inboxes, 6);

  const camp = find('outreach_campaigns', 'upsert')[0];
  assert.equal(camp.opts.onConflict, 'account_id,external_id');
  assert.ok(camp.payload.every((row) => row.account_id === 'acc1' && row.client_id === CLIENT && row.external_id && row.last_synced_at));

  const day = find('outreach_daily', 'upsert')[0];
  assert.equal(day.opts.onConflict, 'campaign_id,on_day');
  assert.ok(day.payload.every((row) => row.campaign_id && /^\d{4}-\d{2}-\d{2}$/.test(row.on_day) && row.client_id === CLIENT));
  assert.ok(day.payload.some((row) => row.campaign_id === 'c0'), 'daily rows hang off the campaign ids that came back');

  const box = find('outreach_inboxes', 'upsert')[0];
  assert.equal(box.opts.onConflict, 'account_id,email');
  assert.ok(box.payload.every((row) => row.account_id === 'acc1' && row.email && row.health >= 0));

  const stamp = find('outreach_accounts', 'update')[0];
  assert.equal(stamp.payload.status, 'ok');
  assert.equal(stamp.payload.last_error, null);
  assert.ok(!Number.isNaN(Date.parse(stamp.payload.last_synced_at)));
  assert.deepEqual(stamp.filters, [['eq', 'id', 'acc1']]);
});
test('oaSync makes a demo account row for a client that has none yet', async () => {
  wireSyncTables();
  tables['outreach_accounts.select'] = { data: [], error: null };
  const r = await oaSync(CLIENT);
  assert.equal(r.ok, true);
  const made = find('outreach_accounts', 'insert')[0];
  assert.equal(made.payload.client_id, CLIENT);
  assert.equal(made.payload.provider, 'demo');
  assert.equal(made.payload.status, 'ok');
  assert.ok(!('key_ref' in made.payload), 'never a key');
  assert.ok(find('outreach_campaigns', 'upsert')[0].payload.every((row) => row.account_id === 'acc-new'));
});
test('oaSync records last_error and never throws when the tool is not connected', async () => {
  wireSyncTables();
  tables['outreach_accounts.select'] = { data: [{ id: 'acc9', client_id: CLIENT, provider: 'smartlead' }], error: null };
  const r = shape(await oaSync(CLIENT));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Smartlead is not connected yet.');
  assert.equal(find('outreach_campaigns', 'upsert').length, 0, 'nothing written');

  const noted = find('outreach_accounts', 'update')[0];
  assert.equal(noted.payload.status, 'error');
  assert.equal(noted.payload.last_error, 'Smartlead is not connected yet.');
  assert.deepEqual(noted.filters, [['eq', 'id', 'acc9']]);
});
test('oaSync survives a database that is refusing writes', async () => {
  wireSyncTables();
  tables['outreach_campaigns.upsert'] = { data: null, error: { message: 'The outreach numbers could not be saved.' } };
  const r = await oaSync(CLIENT);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'The outreach numbers could not be saved.');
  assert.equal(find('outreach_accounts', 'update')[0].payload.status, 'error');
});
test('oaSync does not throw when sb itself blows up', async () => {
  globalThis.sb = { from() { throw new Error('sb is gone'); } };
  const r = shape(await oaSync(CLIENT));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'sb is gone');
});

/* ───────────── the outbox ───────────── */
const queued = (o = {}) => ({ id: 'm1', thread_id: 't1', client_id: CLIENT, direction: 'out', subject: 'Re: hi', body: 'Thursday works.', sent_at: '2026-11-22T09:00:00Z', delivery: 'queued', external_id: null, ...o });

test('oaQueueReply puts a reply in the outbox as queued, never sent on the spot', async () => {
  tables['outreach_messages.insert'] = (c) => ({ data: [{ id: 'm-new', ...c.payload }], error: null });
  const r = shape(await oaQueueReply(CLIENT, 't1', { subject: 'Re: hi', body: 'Thursday works.', authorUser: 'u1' }));
  assert.equal(r.ok, true);
  const ins = find('outreach_messages', 'insert')[0];
  assert.equal(ins.payload.delivery, 'queued');
  assert.equal(ins.payload.direction, 'out');
  assert.equal(ins.payload.thread_id, 't1');
  assert.equal(ins.payload.client_id, CLIENT);

  const empty = await oaQueueReply(CLIENT, 't1', { body: '  ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'Write something before you send it.');
});
test('oaFlushOutbox hands each queued message to the tool and marks it sent', async () => {
  tables['outreach_accounts.select'] = { data: [{ id: 'acc1', client_id: CLIENT, provider: 'demo' }], error: null };
  tables['outreach_messages.select'] = { data: [queued(), queued({ id: 'm2', thread_id: 't2' })], error: null };
  tables['outreach_messages.update'] = { data: [], error: null };

  const r = shape(await oaFlushOutbox());
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { tried: 2, sent: 2, failed: 0 });

  const picked = find('outreach_messages', 'select')[0];
  assert.deepEqual(picked.filters, [['eq', 'delivery', 'queued']]);

  const ups = find('outreach_messages', 'update');
  assert.equal(ups.length, 2);
  for (const u of ups) {
    assert.equal(u.payload.delivery, 'sent');
    assert.equal(u.payload.delivery_error, null);
    assert.ok(u.payload.external_id);
  }
  assert.deepEqual(ups[0].filters, [['eq', 'id', 'm1']]);
  assert.deepEqual(ups[1].filters, [['eq', 'id', 'm2']]);
});
test('oaFlushOutbox: a message stays queued in the table until it is tried, and fails without throwing when the tool cannot send', async () => {
  tables['outreach_accounts.select'] = { data: [{ id: 'acc9', client_id: CLIENT, provider: 'instantly' }], error: null };
  tables['outreach_messages.select'] = { data: [queued()], error: null };
  tables['outreach_messages.update'] = { data: [], error: null };

  const r = shape(await oaFlushOutbox());
  assert.equal(r.ok, true, 'the flush itself still reports back');
  assert.deepEqual(r.data, { tried: 1, sent: 0, failed: 1 });

  const u = find('outreach_messages', 'update')[0];
  assert.equal(u.payload.delivery, 'failed');
  assert.equal(u.payload.delivery_error, 'Instantly is not connected yet.');
  assert.ok(!('body' in u.payload), 'what we wrote is left alone, so it can be sent again later');
});
test('oaFlushOutbox: a tool that throws mid-send is caught and the message is marked failed', async () => {
  oaRegister('blowup', stubImpl({ sendReply: async () => { throw new Error('The reply did not go out.'); } }));
  tables['outreach_accounts.select'] = { data: [{ id: 'acc8', client_id: CLIENT, provider: 'blowup' }], error: null };
  tables['outreach_messages.select'] = { data: [queued()], error: null };
  tables['outreach_messages.update'] = { data: [], error: null };

  const r = await oaFlushOutbox();
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { tried: 1, sent: 0, failed: 1 });
  assert.equal(find('outreach_messages', 'update')[0].payload.delivery_error, 'The reply did not go out.');
});
test('oaFlushOutbox with nothing queued does nothing at all', async () => {
  tables['outreach_messages.select'] = { data: [], error: null };
  const r = await oaFlushOutbox();
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { tried: 0, sent: 0, failed: 0 });
  assert.equal(find('outreach_messages', 'update').length, 0);
});
test('oaFlushOutbox marks a message failed when its client is on a tool the hub cannot find', async () => {
  tables['outreach_accounts.select'] = { data: [{ id: 'acc7', client_id: CLIENT, provider: 'lemlist' }], error: null };
  tables['outreach_messages.select'] = { data: [queued()], error: null };
  tables['outreach_messages.update'] = { data: [], error: null };
  const r = await oaFlushOutbox();
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { tried: 1, sent: 0, failed: 1 });
  assert.match(find('outreach_messages', 'update')[0].payload.delivery_error, /not connected to an outreach tool/);
});
test('oaFlushOutbox hands a plain sentence back when the outbox cannot be read', async () => {
  tables['outreach_messages.select'] = { data: null, error: { message: 'The outbox could not be loaded.' } };
  const r = shape(await oaFlushOutbox());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'The outbox could not be loaded.');
});
test('oaFlushOutbox does not throw when sb itself blows up', async () => {
  globalThis.sb = { from() { throw new Error('sb is gone'); } };
  const r = shape(await oaFlushOutbox());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'sb is gone');
});
