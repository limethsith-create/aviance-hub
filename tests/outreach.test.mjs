/* Tests for outreach-sync — the mapping, and the owner's "connect an account" section of
   settings.js.

   The point of this file: the API keys do not exist yet, so the mapping is proven against the
   recorded response shapes in supabase/functions/outreach-sync/fixtures/ instead of a live key.
   Every field the portal reads is checked against the fixture it came from, so the day the keys
   are set there is nothing left to discover.

   It also holds the RLS proof: another client's outreach rows are invisible. That part runs
   against the real database through the Supabase REST API when OUTREACH_RLS_URL and the two keys
   are given, and is skipped (loudly) otherwise — a test that silently passes without checking
   anything is worse than no test.

   No network, no Deno. Run with:  node --test tests/outreach.test.mjs   (or npm test) */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (name) => JSON.parse(fs.readFileSync(path.join(root, 'supabase/functions/outreach-sync/fixtures', name), 'utf8'));

const M = await import(path.join(root, 'supabase/functions/outreach-sync/map.mjs'));

/* ------------------------------------------------------------------ the fixtures themselves */

test('every fixture is valid JSON and named in the fixtures README', () => {
  const dir = path.join(root, 'supabase/functions/outreach-sync/fixtures');
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 10, 'both providers are recorded, not just one');
  for (const f of files) {
    JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(readme.includes(f), f + ' is recorded but the README does not say which call it came from');
  }
});

test('no fixture carries anything that looks like a real key, password or address', () => {
  const dir = path.join(root, 'supabase/functions/outreach-sync/fixtures');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/"password"/.test(raw), f + ' must not carry a password field at all');
    assert.ok(!/api_key|Bearer\s+\S|eyJ[A-Za-z0-9_-]{10}/.test(raw), f + ' looks like it holds a key');
    for (const m of raw.match(/[\w.+-]+@[\w.-]+/g) || []) {
      assert.match(m, /\.test$/, f + ': ' + m + ' is not a .test address');
    }
  }
});

/* ------------------------------------------------------------------ which secret holds the key */

test('oxEnvName gives the one name the owner has to set in Supabase', () => {
  assert.equal(M.oxEnvName('instantly', 'Main'), 'OUTREACH_INSTANTLY_MAIN');
  assert.equal(M.oxEnvName('smartlead', 'Acme Co.'), 'OUTREACH_SMARTLEAD_ACME_CO');
  assert.equal(M.oxEnvName('instantly', ''), 'OUTREACH_INSTANTLY');
  assert.equal(M.oxEnvName('smartlead', 'north-east #2'), 'OUTREACH_SMARTLEAD_NORTH_EAST_2');
});

test('oxEnvCandidates reads a key_ref as written, then tidied, then prefixed', () => {
  assert.deepEqual(M.oxEnvCandidates('OUTREACH_INSTANTLY_MAIN'), ['OUTREACH_INSTANTLY_MAIN']);
  assert.deepEqual(M.oxEnvCandidates('instantly main'), ['instantly main', 'INSTANTLY_MAIN', 'OUTREACH_INSTANTLY_MAIN']);
  assert.deepEqual(M.oxEnvCandidates(''), []);
  assert.deepEqual(M.oxEnvCandidates(null), []);
});

test('the settings screen and the sync agree on the secret name', async () => {
  const st = await loadSettings();
  for (const [p, l] of [['instantly', 'Main'], ['smartlead', 'Acme Co.'], ['instantly', 'north-east #2']]) {
    assert.equal(st.stKeyRef(p, l), M.oxEnvName(p, l),
      'settings.js would tell the owner a secret name the sync does not look for');
  }
});

/* ------------------------------------------------------------------ Instantly */

test('Instantly: campaigns and their totals become outreach_campaigns rows', () => {
  const list = fx('instantly-campaigns.json').items;
  const totals = new Map(fx('instantly-analytics.json').map((a) => [a.campaign_id, a]));
  const rows = list.map((c) => M.oxInstantlyCampaign(c, totals.get(c.id)));

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    external_id: '01a18395-0ad6-7e17-beab-fae7b41bc39e',
    name: 'US founders — Q4',
    status: 'running',
    started_on: '2026-10-06',
    sent: 4812,
    opened: 1044,            // the unique count, not the 2210 raw pixel loads
    replied: 81,
    positive: 12,
    booked: 0,               // booked comes from our own meetings, never from the provider
    bounced: 37,
    unsubscribed: 9,
  });
  assert.equal(rows[1].status, 'paused');
  // a campaign with no analytics row at all still maps, with zeroes, and does not throw
  assert.deepEqual(
    { s: rows[2].status, sent: rows[2].sent, name: rows[2].name },
    { s: 'draft', sent: 0, name: 'Draft, never started' });
});

test('Instantly: campaign_status maps onto the five words the column allows', () => {
  const allowed = ['draft', 'running', 'paused', 'finished', 'error'];
  for (const v of [0, 1, 2, 3, 4, -1, -2, -99, null, 'x']) {
    assert.ok(allowed.includes(M.oxInstantlyCampaignStatus(v)), v + ' -> ' + M.oxInstantlyCampaignStatus(v));
  }
  assert.equal(M.oxInstantlyCampaignStatus(4), 'running');
  assert.equal(M.oxInstantlyCampaignStatus(-99), 'error');
});

test('Instantly: the daily feed becomes one outreach_daily row a day', () => {
  const rows = M.oxInstantlyDaily(fx('instantly-analytics-daily.json'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { on_day: '2026-11-24', sent: 118, opened: 29, replied: 3, positive: 1, booked: 0, bounced: 0, unsubscribed: 0 });
  assert.deepEqual(rows.map((r) => r.on_day), ['2026-11-24', '2026-11-25', '2026-11-26']);
  // a junk day is dropped rather than written as null, which the NOT NULL column would refuse
  assert.deepEqual(M.oxInstantlyDaily([{ date: null, sent: 5 }, { sent: 1 }]), []);
});

test('Instantly: accounts become inboxes, and health never breaks the 0..100 CHECK', () => {
  const rows = fx('instantly-accounts.json').items.map(M.oxInstantlyInbox);
  assert.deepEqual(rows[0], {
    external_id: 'ab@sendingdomain.test', email: 'ab@sendingdomain.test', domain: 'sendingdomain.test',
    warmed: true, health: 97, daily_limit: 40, sent_today: 0, status: 'ok',
  });
  // no daily_limit of its own, so the warm-up limit stands in; a 58 score is a warning
  assert.equal(rows[1].daily_limit, 15);
  assert.equal(rows[1].status, 'warning');
  // a connection error is 'blocked', and a null score is null, not 0
  assert.equal(rows[2].status, 'blocked');
  assert.equal(rows[2].health, null);
  assert.equal(rows[2].warmed, false);

  for (const v of [-5, 0, 50, 100, 1000, 'x', null, undefined, NaN]) {
    const h = M.oxHealth(v);
    assert.ok(h === null || (h >= 0 && h <= 100), v + ' -> ' + h);
  }
});

test('Instantly: the email feed becomes threads with their messages', () => {
  const got = M.oxInstantlyThreads(fx('instantly-emails.json').items);
  assert.equal(got.length, 2, 'two thread_ids in the fixture');

  const conv = got.find((g) => g.thread.external_id === '01a18700-0000-7000-8000-00000000000a');
  assert.deepEqual(conv.thread, {
    external_id: '01a18700-0000-7000-8000-00000000000a',
    lead_name: 'Dana Whitfield',          // taken from the reply's from_address_json
    lead_email: 'dana@leadco.test',
    lead_company: null,
    lead_title: null,
    sentiment: 'positive',                // i_status 2
    status: 'answered',                   // there is an inbound message
    last_message_at: '2026-11-25T14:30:00.000Z',
    campaign_external_id: '01a18395-0ad6-7e17-beab-fae7b41bc39e',
  });
  assert.equal(conv.messages.length, 2);
  assert.deepEqual(conv.messages.map((m) => m.direction), ['out', 'in']);
  assert.equal(conv.messages[0].body, 'Hi Dana — noticed you are hiring. Worth a word?');
  // the reply had no plain text, so the HTML was turned into text, entities and all
  assert.equal(conv.messages[1].body, 'Yes — send me a time.\n\nDana');
  assert.equal(conv.messages[1].sent_at, '2026-11-25T14:30:00.000Z');
  assert.ok(conv.messages.every((m) => m.delivery === 'synced' && m.external_id));

  const cold = got.find((g) => g.thread.external_id === '01a18700-0000-7000-8000-00000000000b');
  assert.equal(cold.thread.status, 'open', 'nobody answered');
  assert.equal(cold.thread.sentiment, 'negative', 'i_status -1');
  // the body was too large to send, so the preview is used rather than nothing
  assert.equal(cold.messages[0].body, 'worth a look?');
});

test('Instantly: direction comes from ue_type, and nothing else', () => {
  assert.equal(M.oxInstantlyDirection(1), 'out');
  assert.equal(M.oxInstantlyDirection(2), 'in');
  assert.equal(M.oxInstantlyDirection(3), 'out');
  assert.equal(M.oxInstantlyDirection(null), 'out');
});

/* ------------------------------------------------------------------ Smartlead */

test('Smartlead: campaigns and analytics-by-date become outreach_campaigns rows', () => {
  const list = fx('smartlead-campaigns.json');
  const an = fx('smartlead-analytics.json');
  const row = M.oxSmartleadCampaign(list[0], an);
  assert.deepEqual(row, {
    external_id: '12345',
    name: 'SaaS COOs — November',
    status: 'running',
    started_on: '2026-10-29',
    sent: 2980,              // Smartlead returns these as strings; they land as numbers
    opened: 844,
    replied: 72,
    positive: 0,
    booked: 0,
    bounced: 28,
    unsubscribed: 6,
  });
  const done = M.oxSmartleadCampaign(list[1], null);
  assert.equal(done.status, 'finished');
  assert.equal(done.started_on, '2026-08-04');
  assert.equal(done.sent, 0, 'no analytics is zero, not a crash');
});

test('Smartlead: status words map onto the five the column allows', () => {
  const allowed = ['draft', 'running', 'paused', 'finished', 'error'];
  for (const v of ['ACTIVE', 'PAUSED', 'DRAFTED', 'COMPLETED', 'STOPPED', 'ARCHIVED', '', null, 'NEW_WORD']) {
    assert.ok(allowed.includes(M.oxSmartleadCampaignStatus(v)), v + ' -> ' + M.oxSmartleadCampaignStatus(v));
  }
  assert.equal(M.oxSmartleadCampaignStatus('ACTIVE'), 'running');
  assert.equal(M.oxSmartleadCampaignStatus('COMPLETED'), 'finished');
});

test('Smartlead: day-wise stats become outreach_daily rows', () => {
  const rows = M.oxSmartleadDaily(fx('smartlead-daywise.json'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[2], { on_day: '2026-11-26', sent: 31, opened: 9, replied: 1, positive: 0, booked: 0, bounced: 2, unsubscribed: 0 });
  // the same reader copes if Smartlead ever hands the array back bare
  assert.equal(M.oxSmartleadDaily([{ date: '2026-11-01', sent: 1 }]).length, 1);
  assert.deepEqual(M.oxSmartleadDaily(null), []);
});

test('Smartlead: email accounts become inboxes', () => {
  const rows = fx('smartlead-email-accounts.json').map(M.oxSmartleadInbox);
  assert.deepEqual(rows[0], {
    external_id: '77001', email: 'priya@outbounddomain.test', domain: 'outbounddomain.test',
    warmed: true, health: 95, daily_limit: 45, sent_today: 31, status: 'ok',
  });
  assert.equal(rows[1].status, 'warning', 'a 61 reputation is a warning');
  assert.equal(rows[2].status, 'blocked', 'warm-up blocked and SMTP failing');
  assert.equal(rows[2].warmed, false);
});

test('Smartlead: a lead category becomes a sentiment the column allows', () => {
  const cats = M.oxSmartleadCategories(fx('smartlead-categories.json'));
  assert.equal(cats['1'].sentiment, 'positive');
  assert.equal(cats['2'].sentiment, 'negative');
  assert.equal(cats['3'].sentiment, 'positive');
  assert.equal(cats['4'].sentiment, 'out_of_office', 'read off the name, not the null sentiment_type');
  assert.equal(cats['5'].sentiment, 'unsubscribe', '"Do Not Contact"');
  assert.equal(cats['789'].sentiment, 'neutral');
  const allowed = ['unknown', 'positive', 'neutral', 'negative', 'out_of_office', 'unsubscribe'];
  for (const k of Object.keys(cats)) assert.ok(allowed.includes(cats[k].sentiment));
});

test('Smartlead: leads become threads', () => {
  const cats = M.oxSmartleadCategories(fx('smartlead-categories.json'));
  const rows = fx('smartlead-leads.json').data.map((it) => M.oxSmartleadThread(it, cats));
  assert.deepEqual(rows[0], {
    external_id: '2995276770', lead_name: 'Dana Whitfield', lead_email: 'dana@leadco.test',
    lead_company: 'Leadco', lead_title: 'COO', sentiment: 'positive', status: 'open',
    last_message_at: '2026-11-21T09:14:00.000Z', lead_id: '2995276770',
  });
  assert.equal(rows[1].sentiment, 'negative');
  assert.equal(rows[1].lead_title, null, 'no custom field, so no title invented');
  assert.equal(rows[2].sentiment, 'unsubscribe', 'is_unsubscribed beats the empty category');
  assert.equal(rows[2].lead_name, 'Lee', 'a missing surname is not rendered as "Lee null"');
  assert.equal(rows[2].lead_title, 'Head of Ops', 'the other spelling of the custom field');
});

test('Smartlead: a lead message history becomes messages, in BOTH shapes the docs show', () => {
  const a = M.oxSmartleadMessages(fx('smartlead-history.json'));
  assert.equal(a.length, 3);
  assert.deepEqual(a.map((m) => m.direction), ['out', 'in', 'out']);
  assert.equal(a[0].external_id, '9f1c7a40-0000-4000-8000-000000000001');
  assert.equal(a[0].subject, 'Leadco + a second pair of hands');
  assert.equal(a[0].body, 'Hi Dana,\n\nSaw you were scaling ops. Worth 15 minutes?\n\nPriya');
  assert.equal(a[1].body, 'Sure — Thursday works. Dana');
  assert.equal(a[1].sent_at, '2026-11-05T08:41:00.000Z');

  const b = M.oxSmartleadMessages(fx('smartlead-history-alt.json'));
  assert.deepEqual(b.map((m) => m.direction), ['out', 'in']);
  assert.equal(b[1].sent_at, '2026-11-20T14:00:00.000Z', 'received_at stands in for time');
  assert.deepEqual(M.oxSmartleadMessages(null), []);
});

/* ------------------------------------------------------------------ both providers, same tables */

test('both providers produce rows the outreach_* CHECK constraints accept', () => {
  const inThreads = M.oxInstantlyThreads(fx('instantly-emails.json').items);
  const cats = M.oxSmartleadCategories(fx('smartlead-categories.json'));
  const slThreads = fx('smartlead-leads.json').data.map((it) => M.oxSmartleadThread(it, cats));
  const threads = inThreads.map((t) => t.thread).concat(slThreads);
  const messages = inThreads.flatMap((t) => t.messages).concat(M.oxSmartleadMessages(fx('smartlead-history.json')));
  const inboxes = fx('instantly-accounts.json').items.map(M.oxInstantlyInbox)
    .concat(fx('smartlead-email-accounts.json').map(M.oxSmartleadInbox));

  for (const t of threads) {
    assert.ok(['unknown', 'positive', 'neutral', 'negative', 'out_of_office', 'unsubscribe'].includes(t.sentiment));
    assert.ok(['open', 'answered', 'booked', 'closed'].includes(t.status));
    assert.ok(t.external_id, 'a thread with no external id could never be upserted without duplicating');
  }
  for (const m of messages) {
    assert.ok(['out', 'in'].includes(m.direction));
    assert.ok(['synced', 'queued', 'sending', 'sent', 'failed'].includes(m.delivery));
    assert.ok(m.external_id);
  }
  for (const i of inboxes) {
    assert.ok(['ok', 'warming', 'warning', 'blocked', 'paused'].includes(i.status));
    assert.ok(i.health === null || (i.health >= 0 && i.health <= 100));
    assert.equal(typeof i.warmed, 'boolean');
    assert.ok(i.email && i.email.includes('@'));
  }
});

test('the two providers land on the same keys, so the portal cannot tell them apart', () => {
  const inRow = M.oxInstantlyCampaign(fx('instantly-campaigns.json').items[0], fx('instantly-analytics.json')[0]);
  const slRow = M.oxSmartleadCampaign(fx('smartlead-campaigns.json')[0], fx('smartlead-analytics.json'));
  assert.deepEqual(Object.keys(inRow).sort(), Object.keys(slRow).sort());

  const inT = M.oxInstantlyThreads(fx('instantly-emails.json').items)[0].thread;
  const slT = M.oxSmartleadThread(fx('smartlead-leads.json').data[0], {});
  const drop = (o, k) => { const c = { ...o }; delete c[k]; return c };
  assert.deepEqual(Object.keys(drop(inT, 'campaign_external_id')).sort(), Object.keys(drop(slT, 'lead_id')).sort());

  const inM = M.oxInstantlyThreads(fx('instantly-emails.json').items)[0].messages[0];
  const slM = M.oxSmartleadMessages(fx('smartlead-history.json'))[0];
  assert.deepEqual(Object.keys(inM).sort(), Object.keys(slM).sort());
});

test('nothing in the mapping throws on rubbish, because a provider is allowed to change', () => {
  const junk = [null, undefined, {}, [], 0, '', { items: null }, { data: 'nope' }, { lead: null }];
  for (const j of junk) {
    assert.doesNotThrow(() => M.oxInstantlyCampaign(j, j));
    assert.doesNotThrow(() => M.oxInstantlyDaily(j));
    assert.doesNotThrow(() => M.oxInstantlyInbox(j));
    assert.doesNotThrow(() => M.oxInstantlyThreads(j));
    assert.doesNotThrow(() => M.oxSmartleadCampaign(j, j));
    assert.doesNotThrow(() => M.oxSmartleadDaily(j));
    assert.doesNotThrow(() => M.oxSmartleadInbox(j));
    assert.doesNotThrow(() => M.oxSmartleadCategories(j));
    assert.doesNotThrow(() => M.oxSmartleadThread(j, j));
    assert.doesNotThrow(() => M.oxSmartleadMessages(j));
    assert.doesNotThrow(() => M.oxLinkMeetings(j, j));
  }
  assert.equal(M.oxInstantlyThreads(null).length, 0);
});

/* ------------------------------------------------------------------ the meeting link */

test('a thread whose lead really sat down with us carries that meeting and reads as booked', () => {
  const threads = [
    { external_id: 't1', lead_email: 'Dana@Leadco.TEST', sentiment: 'unknown', status: 'answered' },
    { external_id: 't2', lead_email: 'sam@notinterested.test', sentiment: 'negative', status: 'open' },
    { external_id: 't3', lead_email: null, sentiment: 'unknown', status: 'open' },
  ];
  const meetings = [
    { id: 'm-old', guest_email: 'dana@leadco.test', held_at: '2026-10-01T10:00:00Z' },
    { id: 'm-new', guest_email: 'dana@leadco.test', held_at: '2026-11-21T10:00:00Z' },
  ];
  const out = M.oxLinkMeetings(threads, meetings);
  assert.equal(out[0].meeting_id, 'm-new', 'the latest call, and matched whatever the letter case');
  assert.equal(out[0].status, 'booked');
  assert.equal(out[0].sentiment, 'positive', 'someone who met us is not "unknown"');
  assert.equal(out[1].meeting_id, undefined);
  assert.equal(out[1].sentiment, 'negative', 'a real negative is not overwritten');
  assert.equal(out[2].status, 'open');

  assert.equal(M.oxBookedFromThreads(out), 1);
  assert.equal(M.oxPositiveFromThreads(out), 1);
});

/* ------------------------------------------------------------------ paging and the window */

test('oxWindow asks for a few days back, and never a range a provider will refuse', () => {
  const now = '2026-11-26T12:00:00Z';
  assert.deepEqual(M.oxWindow('2026-11-25T11:00:00Z', now), { start_date: '2026-11-22', end_date: '2026-11-26' });
  // a first ever run asks for the full 30 days and no more
  assert.deepEqual(M.oxWindow(null, now), { start_date: '2026-10-27', end_date: '2026-11-26' });
  // an account that has not synced since August still only asks for 30 days
  assert.deepEqual(M.oxWindow('2026-08-01T00:00:00Z', now), { start_date: '2026-10-27', end_date: '2026-11-26' });
  // junk in last_synced_at does not produce an Invalid Date in a URL
  const w = M.oxWindow('not a date', now);
  assert.match(w.start_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(w.end_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(w.start_date <= w.end_date);
});

/* ------------------------------------------------------------------ the edge function's own promises */

test('the edge function never writes a key into the repo, and skips an account without one', () => {
  const src = fs.readFileSync(path.join(root, 'supabase/functions/outreach-sync/index.ts'), 'utf8');
  assert.ok(!/eyJ[A-Za-z0-9_-]{20}/.test(src), 'that looks like a JWT');
  assert.ok(!/sk-|api_key\s*[:=]\s*["'][^"'$]{12}/.test(src), 'that looks like a hard-coded key');
  // the key is only ever read from the environment, by the name key_ref gives
  assert.match(src, /oxEnvCandidates\(acc\.key_ref\)/);
  assert.match(src, /status: "needs_key"/);
  assert.match(src, /continue;\s*\/\/ every other account still syncs/);
  // and the handler cannot throw: every account is wrapped and the response is always 200
  // the handler always answers 200: every account is wrapped, and so is the whole loop
  const handler = src.split('Deno.serve')[1] || '';
  assert.equal((handler.match(/\} catch \(e\) \{/g) || []).length, 2, 'one catch per account, one around the lot');
  assert.equal((handler.match(/new Response\(/g) || []).length, 1, 'one way out, and it is a 200');
  assert.ok(!/return new Response\([^)]*status:\s*[45]/.test(handler), 'this job never answers with an error status');
});

test('only the three tables the portal reads are client-readable, and no secret is written', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261207_outreach_sync.sql'), 'utf8');

  // RLS is on for all six, whoever may read them.
  for (const t of ['outreach_accounts', 'outreach_campaigns', 'outreach_daily', 'outreach_inboxes', 'outreach_threads', 'outreach_messages']) {
    assert.match(sql, new RegExp('alter table public\\.' + t + ' +enable row level security'), t + ' does not have RLS turned on');
  }

  // The client reads exactly what portal-tracker.js reads, and nothing else. The other three
  // each leak something internal: outreach_accounts carries key_ref and our own last_error
  // wording, outreach_inboxes is the domains we send from, outreach_messages is our copy.
  for (const t of ['outreach_campaigns', 'outreach_daily', 'outreach_threads']) {
    assert.match(sql, new RegExp('create policy ' + t + '_client_read on public\\.' + t), t + ' has no client policy');
  }
  for (const t of ['outreach_accounts', 'outreach_inboxes', 'outreach_messages']) {
    assert.ok(!new RegExp('create policy ' + t + '_client_read').test(sql),
      t + ' must not be readable by a client — nothing shown to them needs it');
    assert.match(sql, new RegExp('drop policy if exists ' + t + '_client_read'),
      t + ' should drop the policy by name, so an earlier run of this migration is undone');
  }

  // the policy is read-only and scoped to the signed-in person's own client
  assert.equal((sql.match(/for select using \(client_id = public\.portal_client_id\(\)\)/g) || []).length, 3);
  assert.ok(!/for (insert|update|delete|all)[\s\S]*client_read/.test(sql), 'a client must never write an outreach row');
  // and no key is pasted in: the cron command lifts the gateway key out of the job that has it
  assert.ok(!/eyJ[A-Za-z0-9_-]{20}/.test(sql), 'that looks like a JWT in a migration');
  assert.match(sql, /from cron\.job j\s*\n?\s*where j\.jobname = 'aviance-mail-tick'/);
  assert.match(sql, /cron\.schedule\('aviance-outreach-sync'/);
});

/* ------------------------------------------------------------------ settings.js: connect an account */

async function loadSettings() {
  const elements = {};
  const ctx = {
    console, setTimeout: () => 0, clearTimeout: () => {}, Promise, Date, Math, JSON, Intl, Number, String, Array, Object, RegExp, Error, isNaN,
    document: { getElementById: (id) => (id in elements ? elements[id] : null), querySelectorAll: () => [] },
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    val: (id) => String((elements[id] && elements[id].value) || '').trim(),
    toast: () => {},
    authUser: { id: 'u1', role: 'admin' },
    sb: { from: () => { const b = { select: () => b, eq: () => b, order: () => b, upsert: () => b, update: () => b, maybeSingle: async () => ({ data: null, error: null }), then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return b }, rpc: async () => ({ data: null, error: null }) },
    _elements: elements,
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'settings.js'), 'utf8'), ctx, { filename: 'settings.js' });
  return ctx;
}

test('settings.js: the outreach card shows the secret NAME and says the key goes in Supabase', async () => {
  const st = await loadSettings();
  const rows = [{ id: 'a1', client_id: 'c1', provider: 'instantly', label: 'Main', external_id: 'org-7',
    key_ref: 'OUTREACH_INSTANTLY_MAIN', status: 'needs_key', last_synced_at: null,
    last_error: 'No API key yet. Set the Supabase secret OUTREACH_INSTANTLY_MAIN and this account syncs on the next tick.',
    clients: { company: 'Acme' } }];
  const h = st.stRenderOut(rows, [{ id: 'c1', company: 'Acme' }]);

  assert.match(h, /OUTREACH_INSTANTLY_MAIN/, 'the owner is told exactly which secret to set');
  assert.match(h, /Waiting for its key/);
  assert.match(h, /never/, 'last sync reads "never", not a blank');
  assert.match(h, /Edge Functions/, 'it says where the key really goes');
  assert.match(h, /not.{0,12}entered here/i);
  assert.match(h, /Instantly/);
  assert.match(h, /Acme/);
  assert.ok(h.includes('id="stOutClient"') && h.includes('id="stOutProvider"') && h.includes('id="stOutLabel"') && h.includes('id="stOutExt"'),
    'the owner can pick the provider and type a label and an id');
  // there is nowhere on this screen to paste a key: these four fields are the whole form
  assert.ok(!/type="password"/.test(h));
  const ids = (h.match(/id="st[A-Za-z]+"/g) || []).sort();
  assert.deepEqual(ids, ['id="stOutClient"', 'id="stOutExt"', 'id="stOutLabel"', 'id="stOutMsg"', 'id="stOutProvider"']);
  assert.ok(!/<(input|textarea)(?![^>]*id="st(OutClient|OutExt|OutLabel|OutProvider)")/.test(h),
    'an input appeared that is not one of the four named fields');
});

test('settings.js: a stored value is never rendered raw, however nasty', async () => {
  const st = await loadSettings();
  const nasty = '<img src=x onerror=alert(1)>';
  const h = st.stRenderOut(
    [{ id: nasty, client_id: 'c1', provider: nasty, label: nasty, external_id: nasty, key_ref: nasty,
       status: 'error', last_error: nasty, last_synced_at: '2026-11-26T10:00:00Z', clients: { company: nasty } }],
    [{ id: nasty, company: nasty }]);
  assert.ok(!h.includes('<img'), 'an outreach row is a provider-supplied string; it must be escaped');
  assert.ok(h.includes('&lt;img'));
});

test('settings.js: an account cannot be connected without a client, a provider and a label', async () => {
  const st = await loadSettings();
  for (const bad of [
    {},
    { client_id: 'c1' },
    { client_id: 'c1', provider: 'mailchimp', label: 'Main' },
    { client_id: 'c1', provider: 'instantly', label: 'M' },
    { client_id: 'c1', provider: 'instantly', label: 'x'.repeat(61) },
  ]) assert.ok(st.stValidOutreach(bad), JSON.stringify(bad) + ' should have been refused');
  assert.equal(st.stValidOutreach({ client_id: 'c1', provider: 'smartlead', label: 'Main' }), '');
});

test('settings.js: connecting an account writes key_ref, never a key, and starts at needs_key', async () => {
  const st = await loadSettings();
  let written = null;
  st.sb = { from: () => ({ upsert: (row, opts) => { written = { row, opts }; return { select: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) } } }) };
  const r = await st.stConnectOutreach({ client_id: 'c1', provider: 'instantly', label: 'Main', external_id: ' org-7 ' });
  assert.equal(r.ok, true);
  assert.equal(written.row.key_ref, 'OUTREACH_INSTANTLY_MAIN');
  assert.equal(written.row.status, 'needs_key');
  assert.equal(written.row.external_id, 'org-7', 'trimmed');
  assert.equal(written.opts.onConflict, 'client_id,provider,label', 'connecting twice updates, it does not duplicate');
  assert.ok(!('key' in written.row) && !('api_key' in written.row) && !('secret' in written.row),
    'no column anywhere near a key value');
  for (const v of Object.values(written.row)) {
    if (typeof v === 'string') assert.ok(!/eyJ[A-Za-z0-9_-]{20}|sk-[A-Za-z0-9]{10}/.test(v));
  }
});

test('settings.js: every outreach helper answers {ok,data,error} and never throws', async () => {
  const st = await loadSettings();
  st.sb = { from: () => { throw new Error('the database fell over') } };
  for (const call of [
    () => st.stOutreachAccounts(),
    () => st.stOutreachClients(),
    () => st.stConnectOutreach({ client_id: 'c1', provider: 'instantly', label: 'Main' }),
    () => st.stPauseOutreach('a1', true),
  ]) {
    const r = await call();
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length, 'an error the owner can read');
    assert.deepEqual(Object.keys(r).sort(), ['data', 'error', 'ok']);
  }
  assert.equal((await st.stPauseOutreach('', true)).ok, false);
});

/* ------------------------------------------------------------------ RLS: another client is invisible
   This is the rule that matters most: a client's prospect list is on the internet, so it has to be
   proved, not assumed. The check runs against the live database with two real portal sign-ins. It
   needs, in the environment:
     OUTREACH_RLS_URL        the project URL
     OUTREACH_RLS_ANON       the anon key
     OUTREACH_RLS_JWT_A      a signed-in portal user of client A
     OUTREACH_RLS_JWT_B      a signed-in portal user of client B
   With those missing the test is skipped and says so, so a green run is never mistaken for proof. */
const RLS = {
  url: process.env.OUTREACH_RLS_URL, anon: process.env.OUTREACH_RLS_ANON,
  a: process.env.OUTREACH_RLS_JWT_A, b: process.env.OUTREACH_RLS_JWT_B,
};
const TABLES = ['outreach_accounts', 'outreach_campaigns', 'outreach_daily', 'outreach_inboxes', 'outreach_threads', 'outreach_messages'];

test('RLS: one client can read only their own outreach rows', { skip: !(RLS.url && RLS.anon && RLS.a && RLS.b) && 'set OUTREACH_RLS_URL, OUTREACH_RLS_ANON, OUTREACH_RLS_JWT_A and OUTREACH_RLS_JWT_B to run this against the live database' }, async () => {
  const read = async (table, jwt) => {
    const res = await fetch(`${RLS.url}/rest/v1/${table}?select=id,client_id`, {
      headers: { apikey: RLS.anon, Authorization: `Bearer ${jwt}` },
    });
    assert.equal(res.status, 200, `${table}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  for (const t of TABLES) {
    const [rowsA, rowsB] = await Promise.all([read(t, RLS.a), read(t, RLS.b)]);
    const clientsA = new Set(rowsA.map((r) => r.client_id));
    const clientsB = new Set(rowsB.map((r) => r.client_id));
    assert.ok(clientsA.size <= 1, `${t}: client A saw rows from ${clientsA.size} clients`);
    assert.ok(clientsB.size <= 1, `${t}: client B saw rows from ${clientsB.size} clients`);
    for (const c of clientsA) assert.ok(!clientsB.has(c), `${t}: both clients can see client ${c}'s rows`);
    const idsB = new Set(rowsB.map((r) => r.id));
    for (const r of rowsA) assert.ok(!idsB.has(r.id), `${t}: row ${r.id} is visible to two different clients`);
  }
});

test('RLS: a client may not write an outreach row, even their own', { skip: !(RLS.url && RLS.anon && RLS.a) && 'set OUTREACH_RLS_URL, OUTREACH_RLS_ANON and OUTREACH_RLS_JWT_A to run this against the live database' }, async () => {
  const res = await fetch(`${RLS.url}/rest/v1/outreach_threads`, {
    method: 'POST',
    headers: { apikey: RLS.anon, Authorization: `Bearer ${RLS.a}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: '00000000-0000-0000-0000-000000000000', external_id: 'rls-probe', lead_email: 'probe@nowhere.test' }),
  });
  assert.ok(res.status >= 400, 'a client inserted an outreach row; the client policies must be SELECT only');
});

test('RLS: a signed-out visitor sees nothing at all', { skip: !(RLS.url && RLS.anon) && 'set OUTREACH_RLS_URL and OUTREACH_RLS_ANON to run this against the live database' }, async () => {
  for (const t of TABLES) {
    const res = await fetch(`${RLS.url}/rest/v1/${t}?select=id`, { headers: { apikey: RLS.anon } });
    if (res.status === 200) assert.deepEqual(await res.json(), [], `${t} is readable without signing in`);
    else assert.ok(res.status >= 400);
  }
});
