/* Tests for portal-tracker.js — the client's dashboard: the standing line
   against the guarantee, the launch plan, the Campaign tab and the Calls tab.
   portal-client.js is loaded first, as in portal.html, for pcEsc and the PC hook.
   A tiny fake document holds the four boxes the file draws into. No network.
   Run with:  node --test tests/portal-tracker.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;

/* just enough document for the mount: the four boxes, one <style> */
const nodes = {};
const mk = (id) => ({id, innerHTML:'', get firstChild(){ return this.innerHTML ? {} : null }, querySelector(){ return null }});
const boxes = {pcTracker: mk('pcTracker'), pcStanding: mk('pcStanding'), pcCampaign: mk('pcCampaign'), pcCalls: mk('pcCalls')};
const box = boxes.pcTracker;
globalThis.document = {
  head: {appendChild(n){ nodes[n.id] = n }},
  getElementById(id){ return boxes[id] || nodes[id] || null },
  createElement(){ return {} },
};

vm.runInThisContext(fs.readFileSync(path.join(root, 'core.js'), 'utf8'), { filename: 'core.js' });
vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-client.js'), 'utf8'), {filename:'portal-client.js'});
vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-tracker.js'), 'utf8'), {filename:'portal-tracker.js'});

const NOW = new Date(2026, 10, 24, 10, 0, 0);   /* Nov 24 2026, local */
const journey = (o={}) => ({client_id:'c1', company:'Stone', paid_on:'2026-11-18', launch_on:'2026-12-02', days_to_launch:8, next_step:'research',
  steps:[
    {step:'kickoff', title:'Kickoff call', position:1, planned_on:'2026-11-20', status:'done'},
    {step:'research', title:'Research: your market, ICP, angles', position:2, planned_on:'2026-11-22', status:'doing'},
    {step:'testing', title:'Market testing', position:3, planned_on:'2026-11-29', status:'todo'},
    {step:'build', title:'Build the real campaign', position:4, planned_on:'2026-12-01', status:'todo'},
    {step:'onboarding', title:'Launch call', position:5, planned_on:'2026-12-01', status:'todo'},
    {step:'launch', title:'Launch — month one starts', position:6, planned_on:'2026-12-02', status:'todo'},
  ], ...o});
const text = (h) => String(h).replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#?[a-z0-9]+;/gi,' ').replace(/\s+/g,' ').trim();

beforeEach(() => {
  pct.open = false; pct.drawn = ''; pct.at = 0; pct.data = null; pct.busy = false; pct.who = "|";
  pct.tab = 'chat'; pct.gone = {}; pct.standing = ''; pct.campaignDrawn = ''; pct.callsDrawn = '';
  pct.month = null; pct.monthAt = 0; pct.monthBusy = false; pct.monthFailed = false;
  pct.campaign = null; pct.campaignAt = 0; pct.campaignBusy = false; pct.campaignFailed = false;
  pct.calls = null; pct.callsAt = 0; pct.callsBusy = false; pct.callsFailed = false;
  PC.tab = 'chat';
  Object.keys(boxes).forEach(k => { boxes[k].innerHTML = "" });
});

test('it hooks into the portal: one mount and the toggle action', () => {
  assert.ok(PC.mounts.includes(pctMount));
  assert.equal(typeof PC.actions.trackerToggle, 'function');
});

test('nothing to show draws nothing', () => {
  for (const j of [null, undefined, {}, {steps:[]}, {steps:null}, 'x']) assert.equal(pctRender(j, {now:NOW}), '');
});

test('six steps: done, next, late, dates and the countdown', () => {
  const h = pctRender(journey(), {now:NOW});
  assert.equal((h.match(/class="pct-step /g) || []).length, 6);
  assert.match(h, /pct-step pct-done/);
  assert.match(h, /pct-step pct-late" aria-current="step"/);
  assert.match(h, />✓</);
  assert.match(text(h), /Step 2 of 6 · Research: your market, ICP, angles/);
  assert.match(h, /<b>8<\/b><span>days to launch<\/span>/);
  assert.match(text(h), /Nov 29/);
  assert.match(text(h), /Late · Nov 22/);
  assert.match(h, /data-pc-act="trackerToggle"/);
  assert.match(h, /aria-expanded="false"/);
  assert.match(pctRender(journey(), {now:NOW, open:true}), /pct-open/);
});

test('a step that is next and on time gets the dot', () => {
  const j = journey({next_step:'testing'});
  j.steps[1].status = 'done';
  const h = pctRender(j, {now:NOW});
  assert.match(h, /pct-step pct-next" aria-current="step"><span class="pct-mark" aria-hidden="true">●/);
  assert.ok(!/pct-late/.test(h));
});

test('countdown words: one day, today, live', () => {
  assert.match(pctRender(journey({days_to_launch:1}), {now:NOW}), /<b>1<\/b><span>day to launch/);
  assert.match(pctRender(journey({days_to_launch:0}), {now:NOW}), /<b>Today<\/b>/);
  const live = journey(); live.steps.forEach(s => { s.status = 'done' });
  const h = pctRender(live, {now:NOW});
  assert.match(h, /<b>Live<\/b>/);
  assert.match(text(h), /All six steps done/);
  /* no days given: worked out from the launch date */
  assert.match(pctRender(journey({days_to_launch:null}), {now:NOW}), /<b>8<\/b>/);
});

test('a late step with no date on it says "Late", not "Late ·" with nothing after it', () => {
  const j = journey();
  j.steps[1].planned_on = null;            // the date was never set, so late comes from the server
  j.steps[1].late = true;
  const h = pctRender(j, {now:NOW});
  assert.match(h, /<span class="pct-d">Late<\/span>/);
  assert.doesNotMatch(text(h), /Late ·\s*(<|$|[A-Z]?\s*Step)/);
  assert.doesNotMatch(h, /Late · <\/span>/);
});

test('everything from the database is escaped', () => {
  const j = journey(); j.steps[2].title = '<img src=x onerror=alert(1)>';
  const h = pctRender(j, {now:NOW});
  assert.ok(!/<img/.test(h));
  assert.match(h, /&lt;img/);
});

test('dates are calendar days: they do not slide with the time zone', () => {
  assert.equal(pctDay('2026-11-26').getDate(), 26);
  assert.match(pctDate('2026-11-26'), /26/);
  assert.equal(pctDate(''), '');
  assert.equal(pctDate(null), '');
});

test('mount: asks portal_journey, draws, and does not ask again within 30s', async () => {
  const asked = [];
  const ctx = {rpc: async (n, a) => { asked.push(n); return {ok:true, data: n === 'portal_journey' ? journey() : null, error:''} }};
  await pctMount(ctx);
  assert.deepEqual(asked, ['portal_journey', 'portal_month']);
  assert.match(box.innerHTML, /Your launch plan/);
  assert.ok(nodes.pctCss, 'its stylesheet is added once');
  await pctMount(ctx);
  assert.equal(asked.length, 2);
  /* the toggle redraws open */
  PC.actions.trackerToggle({});
  assert.match(box.innerHTML, /pct-open/);
});

test('mount: a failed answer leaves the box empty and does not throw', async () => {
  await pctMount({rpc: async () => ({ok:false, data:null, error:'offline'})});
  assert.equal(box.innerHTML, '');
  await pctMount({rpc: async () => { throw new Error('boom') }});
  await pctMount(null);
  assert.equal(box.innerHTML, '');
});

/* ───────────── perfection pass ───────────── */
test('a different client signing in on the same browser is never shown the last client\'s plan', async () => {
  const home = (id) => ({person:{id}, channel:{id:'ch-'+id}});
  const j = journey(); j.steps[0].title = 'Kickoff for CLIENT A';
  await pctMount({home: home('a'), rpc: async () => ({ok:true, data:j, error:''})});
  assert.match(box.innerHTML, /CLIENT A/);
  /* A signs out, B signs in at once (well inside the 30 seconds): B's plan is slow to arrive */
  let finish;
  const slow = new Promise((r) => { finish = r });
  const p = pctMount({home: home('b'), rpc: () => slow});
  assert.equal(box.innerHTML, '', 'nothing of A is on B\'s screen while B\'s plan loads');
  finish({ok:true, data:journey(), error:''});
  await p;
  assert.match(box.innerHTML, /Your launch plan/);
  assert.doesNotMatch(box.innerHTML, /CLIENT A/);
  /* and the same client still is not asked twice within 30s */
  let n = 0;
  await pctMount({home: home('b'), rpc: async () => { n++; return {ok:true, data:journey(), error:''} }});
  assert.equal(n, 0);
});

/* ───────────── the standing line: this month against the guarantee ───────────── */

const NOWD = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);
const month = (o={}) => ({client_id:'c1', month_no:1, starts_on:'2026-12-10', ends_on:'2027-01-08',
  calls_promised:10, calls_delivered:7, plan:'growth', plan_label:'Growth', ...o});

test('the standing line is the first thing, and it says the number and the days', () => {
  const n = pctMonthNorm(month(), journey(), NOWD(2026, 12, 20));
  assert.equal(n.have, true);
  assert.equal(n.state, 'ontrack');
  assert.equal(n.daysLeft, 19);
  const h = pctStandingHtml(n);
  assert.match(text(h), /7 of 10 booked calls/);
  assert.match(text(h), /19 days left/);
  assert.match(text(h), /On track/);
  assert.match(text(h), /Month 1 · Dec 10–Jan 8/);
});

test('behind is unmistakable, and on track is not dressed up as behind', () => {
  const behind = pctMonthNorm(month({calls_delivered:4}), journey(), NOWD(2027, 1, 4));
  assert.equal(behind.state, 'behind');
  const h = pctStandingHtml(behind);
  assert.match(h, /pcg-off/);
  assert.match(text(h), /Behind/);
  assert.match(text(h), /6 more calls to go and 4 days left/);
  /* one call short of the straight line on day two is not "behind" */
  const early = pctMonthNorm(month({calls_delivered:0}), journey(), NOWD(2026, 12, 11));
  assert.equal(early.state, 'ontrack');
  assert.doesNotMatch(pctStandingHtml(early), /pcg-off/);
});

test('met, and closed under the number, both say so plainly', () => {
  const met = pctMonthNorm(month({calls_delivered:11}), journey(), NOWD(2026, 12, 28));
  assert.equal(met.state, 'met');
  assert.match(text(pctStandingHtml(met)), /Guarantee met/);
  /* ends_on is 2027-01-08, so the month is closed on the 9th, not on the 8th */
  const short = pctMonthNorm(month({calls_delivered:6}), journey(), NOWD(2027, 1, 9));
  assert.equal(short.state, 'short');
  const h = pctStandingHtml(short);
  assert.match(text(h), /Refund due/);
  assert.match(text(h), /refund/i);
});

/* ends_on is the last day INSIDE the month's window — recount_month counts a
   call `between starts_on and ends_on` — so a call can still land on it. The
   standing line used to say "Refund due · This month closed under the number"
   on that day, which promises the client money that may not be owed and tells
   them to stop expecting calls while we are still booking them. */
test('the last day of the month is not called closed, and no refund is promised on it', () => {
  const lastDay = pctMonthNorm(month({calls_delivered:6}), journey(), NOWD(2027, 1, 8));
  assert.equal(lastDay.daysLeft, 0);
  assert.equal(lastDay.state, 'behind', 'behind, not short: the day is not over');
  const h = text(pctStandingHtml(lastDay));
  assert.doesNotMatch(h, /Refund due/);
  assert.doesNotMatch(h, /closed under the number/);
  assert.match(h, /4 more calls to go and today is the last day/);
  /* hit on the last day is still met */
  assert.equal(pctMonthNorm(month({calls_delivered:10}), journey(), NOWD(2027, 1, 8)).state, 'met');
  /* and the day after, it is closed */
  assert.equal(pctMonthNorm(month({calls_delivered:6}), journey(), NOWD(2027, 1, 9)).state, 'short');
});

test('before launch it counts down to launch and still names the promise', () => {
  const n = pctMonthNorm(month({calls_delivered:0}), journey({launch_on:'2026-12-10'}), NOWD(2026, 12, 4));
  assert.equal(n.have, false);
  assert.equal(n.state, 'before');
  assert.equal(n.daysLeft, 6);
  const h = pctStandingHtml(n);
  assert.match(text(h), /10 booked calls a month/);
  assert.match(text(h), /6 days to launch/);
  assert.match(text(h), /money back, not credit/);
});

test('with nothing to go on the standing line draws nothing rather than a guess', () => {
  assert.equal(pctStandingHtml(pctMonthNorm(null, null, NOWD(2026, 12, 4))), '');
  assert.equal(pctStandingHtml(pctMonthNorm({}, {}, NOWD(2026, 12, 4))), '');
});

/* ───────────── the campaign tab ───────────── */

const camp = (clientId='c1') => ({client_id: clientId,
  campaigns: [
    {id:'a', client_id: clientId, name:'Dispatch delays', status:'active', started_on:'2026-12-10', sent:2000, opened:800, replied:80, positive:30, booked:5},
    {id:'b', client_id: clientId, name:'Fuel cost', status:'paused', started_on:'2026-12-10', sent:500, opened:180, replied:10, positive:2, booked:0},
  ],
  daily: [
    {client_id: clientId, on_day:'2026-12-10', sent:1200, opened:500, replied:50, positive:20, booked:2},
    {client_id: clientId, on_day:'2026-12-11', sent:1300, opened:480, replied:40, positive:12, booked:3},
  ]});

test('the campaign tab: the five figures, the days, and the angles', () => {
  const c = pctCampaignNorm(camp(), 'c1');
  assert.equal(c.totals.sent, 2500);
  assert.equal(c.totals.booked, 5);
  assert.equal(c.days.length, 2);
  assert.equal(c.angles[0].name, 'Dispatch delays');
  const h = pctCampaignHtml(c, pctMonthNorm(month(), journey(), NOWD(2026, 12, 20)));
  const t = text(h);
  ['Sent', 'Opened', 'Replied', 'Positive', 'Calls'].forEach(w => assert.match(t, new RegExp(w)));
  assert.match(t, /2,500/);
  assert.match(t, /Dispatch delays/);
  assert.match(t, /Paused · from Dec 10/);
  assert.match(t, /By angle/);
});

test('the charts are drawn here, in svg, with no script and no remote anything', () => {
  const c = pctCampaignNorm(camp(), 'c1');
  const h = pctCampaignHtml(c, null);
  assert.match(h, /<svg /);
  assert.match(h, /viewBox="0 0 360 /);
  assert.ok(!/<script|https?:\/\/|<img|url\(/i.test(h), 'nothing is fetched to draw a chart');
  assert.match(h, /role="img" aria-label="[^"]+by day/);
  /* a day with nothing sent draws no bar, and nothing is NaN */
  const quiet = pctChartHtml([{day:'2026-12-10', sent:0}, {day:'2026-12-11', sent:0}], 'sent', {});
  assert.ok(!/NaN|undefined/.test(quiet));
  assert.equal(pctChartHtml([], 'sent', {}), '');
});

test('the campaign tab with no data at all explains what is coming and when', () => {
  const before = pctMonthNorm(month({calls_delivered:0}), journey({launch_on:'2026-12-10'}), NOWD(2026, 12, 4));
  const h = pctCampaignHtml(pctCampaignNorm({campaigns:[], daily:[]}, 'c1'), before);
  const t = text(h);
  assert.match(t, /Your campaign goes live on Dec 10/);
  assert.match(t, /01/);                      /* the numbered steps */
  assert.match(t, /warm the inboxes/);
  assert.match(t, /money back, not credit/i);  /* the guarantee block */
  assert.ok(!/\b0\b\s*(SENT|Sent)/.test(t), 'no zeroed figures and no empty chart');
  assert.ok(!/<svg/.test(h));
  /* and once it is live but today has no numbers yet, it says so instead — without
     putting a clock on it. The copy used to promise "the first numbers land this
     evening"; nothing we control guarantees that. The provider reports when it
     reports, and on a client with no provider key configured at all the numbers
     never arrive, so the promise was simply false. It must say that sending has
     started and that the page fills in as the tool reports back, and it must not
     name an hour, an evening or a day. */
  const live = pctMonthNorm(month({calls_delivered:0}), journey(), NOWD(2026, 12, 10));
  const liveText = text(pctCampaignHtml(null, live));
  assert.match(liveText, /sending has started/i);
  assert.match(liveText, /as the sending tool reports back/i);
  assert.doesNotMatch(liveText, /this evening|within a few hours|the same evening/i,
    'the campaign card must not promise numbers by a time we do not control');
});

/* ───────────── the calls tab ───────────── */

const callRows = (clientId='c1') => ({client_id: clientId, calls: [
  {id:'1', client_id: clientId, who:'Marcus Hale', company:'Keystone Freight', title:'VP Operations', booked_for:'2026-12-11T16:00:00Z', happened:true, matched_icp:true, counts:true},
  {id:'2', client_id: clientId, who:'Peter Osei', company:'Northline', title:'COO', booked_for:'2026-12-15T17:00:00Z', happened:false, matched_icp:true, counts:true},
  {id:'3', client_id: clientId, who:'Yvonne Clarke', company:'Harbourline', title:'Operations Lead', booked_for:'2026-12-29T16:00:00Z', happened:null, matched_icp:true, counts:true},
]});

test('the calls tab: who, what company, when, and whether they turned up', () => {
  const c = pctCallsNorm(callRows(), 'c1', NOWD(2026, 12, 20));
  assert.equal(c.total, 3);
  assert.equal(c.held, 1);
  assert.equal(c.noshow, 1);
  assert.equal(c.soon.length, 1);
  assert.equal(c.soon[0].who, 'Yvonne Clarke');
  const h = pctCallsHtml(c, null);
  const t = text(h);
  assert.match(t, /Marcus Hale/);
  assert.match(t, /VP Operations · Keystone Freight/);
  assert.match(t, /Turned up/);
  assert.match(t, /No show/);
  assert.match(t, /Booked/);
  assert.match(t, /Coming up/);
});

test('a prospect’s email address is never drawn, nor any internal note', () => {
  const rows = callRows();
  rows.calls[0].prospect_email = 'marcus@keystone.example';
  rows.calls[0].dispute_reason = 'STAFF ONLY: client argued this one';
  rows.calls[0].notes = 'STAFF ONLY note';
  const h = pctCallsHtml(pctCallsNorm(rows, 'c1', NOWD(2026, 12, 20)), null);
  assert.ok(!/keystone\.example|STAFF ONLY/i.test(h));
});

test('the calls tab before the first booking explains how a call gets here', () => {
  const before = pctMonthNorm(month({calls_delivered:0}), journey({launch_on:'2026-12-10'}), NOWD(2026, 12, 4));
  const h = pctCallsHtml(pctCallsNorm({calls:[]}, 'c1', NOWD(2026, 12, 4)), before);
  const t = text(h);
  assert.match(t, /first call has not been booked yet/i);
  assert.match(t, /we put a time in your calendar/);
  assert.match(t, /10 booked calls a month/);
  assert.ok(!/Turned up|No show/.test(t), 'no empty table and no zero row');
});

/* ───────────── everything escaped, nothing of another client’s ───────────── */

test('everything from the database is escaped on every tab', () => {
  const bad = '<img src=x onerror=alert(1)>';
  const c = camp(); c.campaigns[0].name = bad; c.campaigns[0].status = bad;
  const h1 = pctCampaignHtml(pctCampaignNorm(c, 'c1'), null);
  assert.ok(!/<img/.test(h1));
  assert.match(h1, /&lt;img/);
  const r = callRows(); r.calls[0].who = bad; r.calls[0].company = bad; r.calls[0].title = bad;
  const h2 = pctCallsHtml(pctCallsNorm(r, 'c1', NOWD(2026, 12, 20)), null);
  assert.ok(!/<img/.test(h2));
  assert.match(h2, /&lt;img/);
});

test('ONE CLIENT CAN NEVER SEE ANOTHER CLIENT’S ROWS THROUGH ANYTHING DRAWN HERE', () => {
  /* a mixed answer: the other client's rows are dropped before anything is drawn */
  const mixed = camp('c1');
  mixed.campaigns.push({id:'x', client_id:'OTHER', name:'SOMEONE ELSE ANGLE', status:'active', started_on:'2026-12-10', sent:9999, opened:9999, replied:999, positive:99, booked:9});
  mixed.daily.push({client_id:'OTHER', on_day:'2026-12-12', sent:9999, opened:9999, replied:999, positive:99, booked:9});
  const c = pctCampaignNorm(mixed, 'c1');
  assert.equal(c.campaigns.length, 2);
  assert.equal(c.totals.sent, 2500);
  const h = pctCampaignHtml(c, null);
  assert.ok(!/SOMEONE ELSE|9,999/.test(h));

  const calls = callRows('c1');
  calls.calls.push({id:'x', client_id:'OTHER', who:'SOMEONE ELSE PROSPECT', company:'OTHER LTD', booked_for:'2026-12-12T16:00:00Z', happened:true});
  const cc = pctCallsNorm(calls, 'c1', NOWD(2026, 12, 20));
  assert.equal(cc.total, 3);
  assert.ok(!/SOMEONE ELSE|OTHER LTD/.test(pctCallsHtml(cc, null)));

  /* a row that does not say whose it is is dropped too: fail closed, never guess */
  assert.deepEqual(pctMine([{id:'1'}, {id:'2', client_id:null}], 'c1'), []);
  /* and with no client to compare against, nothing at all is drawn */
  assert.deepEqual(pctMine([{id:'1', client_id:'c1'}], ''), []);
  assert.equal(pctCampaignNorm(camp('c1'), '').totals.sent, 0);
  assert.equal(pctCallsNorm(callRows('c1'), '', NOWD(2026, 12, 20)).total, 0);
});

test('a different client signing in on the same browser sees none of the last one’s campaign or calls', async () => {
  const home = (id) => ({person:{id}, channel:{id:'ch-' + id}});
  PC.tab = 'calls'; pct.tab = 'calls';
  const ctxA = {home: home('a'), rpc: async (n) => ({ok:true, error:'', data:
    n === 'portal_journey' ? journey() : n === 'portal_month' ? month() : n === 'portal_calls' ? callRows('c1') : null})};
  await pctMount(ctxA);
  assert.match(boxes.pcCalls.innerHTML, /Marcus Hale/);
  assert.match(boxes.pcStanding.innerHTML, /booked calls/);
  /* B signs in at once, well inside the 30 seconds, and B's rows are slow */
  let finish; const slow = new Promise(r => { finish = r });
  const p = pctMount({home: home('b'), rpc: (n) => n === 'portal_calls' ? slow : Promise.resolve({ok:true, data:null, error:''})});
  assert.ok(!/Marcus Hale/.test(boxes.pcCalls.innerHTML) && !/not been booked/.test(boxes.pcCalls.innerHTML),
    'while B\'s rows load, B is shown neither A\'s calls nor a false "no calls yet"');
  assert.equal(boxes.pcStanding.innerHTML, '');
  finish({ok:true, data:{client_id:'c2', calls:[]}, error:''});
  await p;
  assert.ok(!/Marcus Hale/.test(boxes.pcCalls.innerHTML));
});

test('a tab nobody has opened is never asked for', async () => {
  const asked = [];
  PC.tab = 'chat'; pct.tab = 'chat';
  const ctx = {rpc: async (n) => { asked.push(n); return {ok:true, data: n === 'portal_journey' ? journey() : null, error:''} }};
  await pctMount(ctx);
  assert.deepEqual(asked, ['portal_journey', 'portal_month']);
  PC.tab = 'campaign';
  await pctMount(ctx);
  assert.deepEqual(asked, ['portal_journey', 'portal_month', 'portal_campaign']);
});

test('when an rpc does not exist yet the tables are read instead, and only this client’s rows', async () => {
  const read = [];
  const data = {outreach_campaigns: camp('c1').campaigns.concat([{id:'x', client_id:'OTHER', name:'SOMEONE ELSE', sent:9999}]),
    outreach_daily: camp('c1').daily, qualified_calls: [], outreach_threads: [], client_months: [month()]};
  const sb = {from(table){
    const st = {table, filters:[]};
    const q = {select(){ return q }, eq(k, v){ st.filters.push([k, v]); return q },
      order(){ return q }, limit(){ return Promise.resolve({data: (data[table] || []), error:null}) }};
    read.push(st);
    return q;
  }};
  PC.tab = 'campaign'; pct.tab = 'campaign';
  const ctx = {sb, rpc: async (n) => n === 'portal_journey' ? {ok:true, data:journey(), error:''}
    : {ok:false, data:null, error:'Could not find the function public.' + n + ' in the schema cache'}};
  await pctMount(ctx);
  assert.ok(read.some(r => r.table === 'outreach_campaigns'), 'it fell back to the table');
  assert.ok(read.every(r => r.filters.some(([k, v]) => k === 'client_id' && v === 'c1')), 'every read is filtered to this client');
  assert.ok(!/SOMEONE ELSE|9,999/.test(boxes.pcCampaign.innerHTML), 'and a stray row of another client\'s is still dropped');
  /* a missing function is only asked for once */
  assert.equal(pct.gone.portal_campaign, true);
});

test('an error that is not a missing function is never papered over with a guess', async () => {
  const sb = {from(){ throw new Error('should not be read') }};
  PC.tab = 'calls'; pct.tab = 'calls';
  await pctMount({sb, rpc: async (n) => n === 'portal_journey' ? {ok:true, data:journey(), error:''} : {ok:false, data:null, error:'offline'}});
  assert.equal(pct.calls, null);
  assert.ok(!pct.gone.portal_calls);
});

test('once month one is running the launch plan steps aside for the standing line', async () => {
  PC.tab = 'chat'; pct.tab = 'chat';
  const live = journey(); live.steps.forEach(s => { s.status = 'done' });
  const iso = (d) => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  const t0 = new Date(), from = new Date(t0.getTime() - 5 * 86400000), to = new Date(t0.getTime() + 20 * 86400000);
  const running = month({starts_on: iso(from), ends_on: iso(to)});   /* a month that contains today */
  await pctMount({rpc: async (n) => ({ok:true, error:'', data: n === 'portal_journey' ? live : n === 'portal_month' ? running : null})});
  assert.equal(boxes.pcTracker.innerHTML, '', 'two countdowns on one screen is one too many');
  assert.match(boxes.pcStanding.innerHTML, /booked calls/);
});

/* ───────────── the shell portal.html puts around all this ───────────── */

test('portal.html is three tabs with the standing line above them', () => {
  const html = fs.readFileSync(path.join(root, 'portal.html'), 'utf8');
  ['chat', 'campaign', 'calls'].forEach(k => {
    assert.ok(html.includes("id=\"pcPanel-" + k + "\""), k + ' has a panel');
    assert.ok(html.includes("{ key: '" + k + "'"), k + ' is in the tab list');
  });
  assert.ok(html.includes('role="tablist"') && html.includes('role="tabpanel"'));
  assert.ok(html.includes('data-pc-tab'));
  /* the standing line comes before the tabs, and the tabs before the panels */
  assert.ok(html.indexOf('id="pcStanding"') < html.indexOf('role="tablist"'));
  assert.ok(html.indexOf('role="tablist"') < html.indexOf('id="pcPanel-chat"'));
  /* the chat keeps everything it had, inside its own panel */
  ['id="pcTracker"', 'id="pcScroll"', 'id="pcCompose"'].forEach(id => assert.ok(html.includes(id)));
  assert.ok(html.indexOf('id="pcPanel-chat"') < html.indexOf('id="pcScroll"'));
  assert.ok(html.indexOf('id="pcScroll"') < html.indexOf('id="pcPanel-campaign"'));
  /* and the tracker is told which tab is open, so a closed tab is never asked for */
  assert.ok(html.includes('PC.tab'));
  assert.ok(html.includes('ArrowRight') && html.includes('aria-selected'));
});

/* ───────────── when the asking fails: what a paying client sees ─────────────
   The worst outcome on this page is not an error. It is a confident zero: a
   "nothing has been sent yet" or an empty calls list drawn because we could not
   READ their figures, sitting next to the guarantee those figures are measured
   against. These tests make the reading fail on purpose and check that the page
   says so instead. */

test('a campaign read that fails says so — it never falls through to "nothing has been sent yet"', async () => {
  PC.tab = 'campaign'; pct.tab = 'campaign';
  /* the rpc is there and refuses: not a missing function, so no guessing from tables */
  await pctMount({rpc: async (n) => n === 'portal_journey'
    ? {ok:true, data:journey(), error:''}
    : {ok:false, data:null, error:'permission denied for table outreach_campaigns'}});
  const h = boxes.pcCampaign.innerHTML;
  assert.match(text(h), /could not load your campaign numbers/i);
  assert.doesNotMatch(text(h), /Nothing has been sent yet/i, 'a lie a client would remember');
  assert.doesNotMatch(text(h), /goes live on|being built/i);
  assert.equal(pct.campaignFailed, true);
  assert.equal(pct.campaign, null);
  /* and it leaks none of the machine room */
  assert.doesNotMatch(h, /permission denied|outreach_campaigns|42501|PGRST/i);
  /* it is honest about whose fault it is, and says what to do */
  assert.match(text(h), /not your campaign/i);
  assert.match(h, /data-pc-act="trackerRetry"/);
});

test('a calls read that fails never shows an empty calls list', async () => {
  PC.tab = 'calls'; pct.tab = 'calls';
  await pctMount({rpc: async (n) => n === 'portal_journey'
    ? {ok:true, data:journey(), error:''}
    : {ok:false, data:null, error:'offline'}});
  const h = boxes.pcCalls.innerHTML;
  assert.match(text(h), /could not load your booked calls/i);
  assert.doesNotMatch(text(h), /No calls booked yet|first call has not been booked/i);
  assert.equal(pct.callsFailed, true);
});

test('a thrown error, a timeout and a denied table read all read the same way', async () => {
  PC.tab = 'campaign'; pct.tab = 'campaign';
  const cases = [
    ['a rejected promise', {rpc: (n) => n === 'portal_journey'
      ? Promise.resolve({ok:true, data:journey(), error:''}) : Promise.reject(new Error('boom'))}],
    ['a thrown error', {rpc: (n) => { if (n === 'portal_journey') return {ok:true, data:journey(), error:''}; throw new Error('boom') }}],
    /* the rpc is not deployed, so it falls back to the tables — and the table refuses */
    ['a denied table read', {
      sb: {from(){ const q = {select(){ return q }, eq(){ return q }, order(){ return q },
        limit(){ return Promise.resolve({data:null, error:{code:'42501', message:'permission denied for table outreach_daily'}}) }}; return q }},
      rpc: async (n) => n === 'portal_journey' ? {ok:true, data:journey(), error:''}
        : {ok:false, data:null, error:'Could not find the function public.' + n + ' in the schema cache'}}],
    ['a table that never answers', {
      sb: {from(){ const q = {select(){ return q }, eq(){ return q }, order(){ return q },
        limit(){ return Promise.resolve(null) }}; return q }},
      rpc: async (n) => n === 'portal_journey' ? {ok:true, data:journey(), error:''}
        : {ok:false, data:null, error:'Could not find the function public.' + n + ' in the schema cache'}}],
  ];
  for (const [what, ctx] of cases) {
    pct.who = '|'; pct.at = 0; pct.gone = {};
    pct.campaign = null; pct.campaignAt = 0; pct.campaignBusy = false;
    pct.campaignFailed = false; pct.campaignDrawn = '';
    await pctMount(ctx);
    assert.match(text(boxes.pcCampaign.innerHTML), /could not load your campaign numbers/i, what);
    assert.doesNotMatch(text(boxes.pcCampaign.innerHTML), /Nothing has been sent yet/i, what);
    assert.equal(pct.campaignBusy, false, what + ': the guard flag is clear, so the page can ask again');
  }
});

/* The standing line is the figure a refund turns on. A month that could not be
   read used to be turned into "no month" — and the pre-launch panel then told a
   client fifteen days into a running month "Not started · month one · the clock
   starts on launch day", which is the opposite of the truth and identical to
   what a client who has genuinely not launched sees. Live there is no
   portal_month RPC yet, so every client goes down the table-read path, which is
   the path that throws. */
test('a month that could not be read says so, and never reads as "not started"', async () => {
  const dead = (rpcOk) => ({
    home: {person:{id:'p1'}, channel:{id:'ch1'}},
    sb: {from(){ const q = {select(){ return q }, eq(){ return q }, order(){ return q },
      limit(){ return Promise.resolve({data:null, error:{message:'canceling statement due to statement timeout'}}) }}; return q }},
    rpc: async (n) => n === 'portal_journey'
      ? (rpcOk ? {ok:true, data:journey(), error:''} : {ok:false, data:null, error:'Something went wrong at our end.'})
      : {ok:false, data:null, error:'Could not find the function public.' + n + ' in the schema cache'},
  });
  for (const [what, rpcOk] of [['the month read failed', true], ['portal_journey failed too', false]]) {
    pct.who = '|'; pct.at = 0; pct.gone = {}; pct.data = null;
    pct.month = null; pct.monthAt = 0; pct.monthFailed = false; pct.standing = '';
    boxes.pcStanding.innerHTML = '';
    await pctMount(dead(rpcOk));
    const h = text(boxes.pcStanding.innerHTML);
    assert.equal(pct.monthFailed, true, what);
    assert.match(h, /could not load where this month stands/i, what);
    assert.doesNotMatch(h, /Not started/i, what);
    assert.doesNotMatch(h, /clock starts on launch day/i, what);
    assert.match(boxes.pcStanding.innerHTML, /data-pc-act="trackerRetry"/, what + ': a way out');
    assert.equal(pct.monthBusy, false, what + ': the guard flag is clear');
  }
  /* and "Try again" clears it, so a client who taps it is not stuck on the panel */
  PC.actions.trackerRetry(null, {rpc: async () => ({ok:true, data:journey(), error:''}),
    sb: {from(){ const q = {select(){ return q }, eq(){ return q }, order(){ return q },
      limit(){ return Promise.resolve({data:[], error:null}) }}; return q }}});
  assert.equal(pct.monthFailed, false);
});

/* A month that answered with nothing is NOT a failure: a client who has paid
   and not launched still gets the pre-launch panel. */
test('no month rows yet is still the honest pre-launch panel, not a failure', async () => {
  pct.who = '|'; pct.at = 0; pct.gone = {};
  await pctMount({
    home: {person:{id:'p1'}, channel:{id:'ch1'}},
    sb: {from(){ const q = {select(){ return q }, eq(){ return q }, order(){ return q },
      limit(){ return Promise.resolve({data:[], error:null}) }}; return q }},
    rpc: async (n) => n === 'portal_journey' ? {ok:true, data:journey(), error:''}
      : {ok:false, data:null, error:'Could not find the function public.' + n + ' in the schema cache'},
  });
  assert.equal(pct.monthFailed, false);
  const h = text(boxes.pcStanding.innerHTML);
  assert.doesNotMatch(h, /could not load/i);
  assert.match(h, /clock starts on launch day/i);
});

test('a guard flag is never left true by a failure — the page can always ask again', async () => {
  PC.tab = 'campaign'; pct.tab = 'campaign';
  const dead = {rpc: () => Promise.reject(new Error('boom'))};
  await pctMount(dead);
  assert.equal(pct.busy, false, 'the journey ask');
  assert.equal(pct.monthBusy, false, 'the month ask');
  assert.equal(pct.campaignBusy, false, 'the campaign ask');
  PC.tab = 'calls'; pct.tab = 'calls'; pct.callsAt = 0;
  await pctMount(dead);
  assert.equal(pct.callsBusy, false, 'the calls ask');
  /* and because none of them is stuck, a second mount really does ask again */
  let asked = 0;
  pct.at = 0; pct.monthAt = 0; pct.callsAt = 0;
  await pctMount({rpc: async (n) => { asked++; return {ok:true, data: n === 'portal_journey' ? journey() : null, error:''} }});
  assert.ok(asked >= 2, 'it asked again rather than sitting on a flag');
});

test('"Try again" on a failed panel forgets the back-off and asks at once', async () => {
  PC.tab = 'campaign'; pct.tab = 'campaign';
  await pctMount({rpc: async (n) => n === 'portal_journey'
    ? {ok:true, data:journey(), error:''} : {ok:false, data:null, error:'offline'}});
  assert.equal(pct.campaignFailed, true);
  /* within the 30 seconds, so without the retry nothing would be asked */
  let asked = [];
  await PC.actions.trackerRetry({}, {rpc: async (n) => { asked.push(n);
    return {ok:true, error:'', data: n === 'portal_journey' ? journey() : n === 'portal_campaign' ? camp('c1') : null} }});
  assert.ok(asked.includes('portal_campaign'), 'it asked again: ' + asked.join(','));
  assert.equal(pct.campaignFailed, false);
  assert.doesNotMatch(text(boxes.pcCampaign.innerHTML), /could not load/i);
});

test('an empty answer is still the empty state — a failure state is not shown for "nothing yet"', async () => {
  PC.tab = 'campaign'; pct.tab = 'campaign';
  /* the rpc answers, and the answer is genuinely "no campaign rows yet" */
  await pctMount({rpc: async (n) => ({ok:true, error:'', data: n === 'portal_journey' ? journey()
    : n === 'portal_campaign' ? {client_id:'c1', campaigns:[], daily:[]} : null})});
  assert.equal(pct.campaignFailed, false);
  assert.doesNotMatch(text(boxes.pcCampaign.innerHTML), /could not load/i);
  assert.match(text(boxes.pcCampaign.innerHTML), /Nothing has been sent yet|goes live on|being built/i);
});

test('the failure panel is built from the same motifs as every other panel, and escapes what it is given', () => {
  const h = pctFailHtml('<img src=x onerror=alert(1)>');
  assert.ok(!/<img/.test(h));
  assert.match(h, /&lt;img/);
  /* eyebrow, red rule, headline, lede — DESIGN.md, not a dump of red text */
  assert.match(h, /class="pc-tag"/);
  assert.match(h, /class="pcte-rule"/);
  assert.match(h, /class="pcte-h"/);
  assert.match(h, /class="pcte-lede"/);
  assert.match(h, /role="status"/);
  /* and it is spoken, not just coloured */
  assert.match(h, /aria-label="Could not load/);
});

/* ───────────── one retry, on reads only ─────────────
   Everything this file asks for is a read, so a dropped request is worth asking
   twice. Nothing a client can press — Send, Book, Approve — is ever asked twice,
   because a repeated write is a second message or a second call in the diary. */

test('a dropped read is asked once more, and then it works', async () => {
  PC.tab = 'campaign'; pct.tab = 'campaign';
  let n = 0;
  await pctMount({rpc: async (name) => {
    if (name === 'portal_journey') return {ok:true, data:journey(), error:''};
    if (name === 'portal_campaign') {
      n++;
      if (n === 1) throw new TypeError('Failed to fetch');     /* the blip */
      return {ok:true, data:camp('c1'), error:''};
    }
    return {ok:true, data:null, error:''};
  }});
  assert.equal(n, 2, 'it asked a second time');
  assert.equal(pct.campaignFailed, false, 'so the client never saw the failure at all');
  assert.doesNotMatch(text(boxes.pcCampaign.innerHTML), /could not load/i);
});

test('an answer is never asked twice — only a blip is', async () => {
  for (const [why, error] of [['permission denied', 'permission denied for table outreach_campaigns'],
                              ['a refusal', 'not allowed']]) {
    PC.tab = 'campaign'; pct.tab = 'campaign';
    pct.who = '|'; pct.at = 0; pct.gone = {}; pct.campaignAt = 0; pct.campaignFailed = false; pct.campaignDrawn = '';
    let n = 0;
    await pctMount({rpc: async (name) => {
      if (name === 'portal_journey') return {ok:true, data:journey(), error:''};
      if (name === 'portal_campaign') { n++; return {ok:false, data:null, error}; }
      return {ok:true, data:null, error:''};
    }});
    assert.equal(n, 1, why + ' is an answer, not a blip: asked once');
    assert.equal(pct.campaignFailed, true);
  }
});

test('two drops in a row is a failure said out loud, not a third try', async () => {
  PC.tab = 'calls'; pct.tab = 'calls';
  let n = 0;
  await pctMount({rpc: async (name) => {
    if (name === 'portal_journey') return {ok:true, data:journey(), error:''};
    if (name === 'portal_calls') { n++; throw new TypeError('Failed to fetch'); }
    return {ok:true, data:null, error:''};
  }});
  assert.equal(n, 2, 'one retry, not a loop');
  assert.equal(pct.callsFailed, true);
  assert.match(text(boxes.pcCalls.innerHTML), /could not load your booked calls/i);
});

test('a read that genuinely finds nothing is not retried and not a failure', async () => {
  PC.tab = 'chat'; pct.tab = 'chat';
  let n = 0;
  await pctMount({rpc: async (name) => {
    if (name === 'portal_journey') return {ok:true, data:journey(), error:''};
    n++; return {ok:true, data:null, error:''};     /* no month yet: a real answer */
  }});
  assert.equal(n, 1, '"nothing yet" is an answer');
  assert.equal(pct.month, null);
});

test('nothing a client presses is ever retried for them', () => {
  const send = fs.readFileSync(path.join(root, 'portal.html'), 'utf8');
  const steps = fs.readFileSync(path.join(root, 'portal-steps.js'), 'utf8');
  const sched = fs.readFileSync(path.join(root, 'portal-schedule.js'), 'utf8');
  /* every write a client can trigger is awaited from exactly one place: there is
     no second attempt anywhere, so a dropped Send cannot become two messages */
  /* pcWrite / pstCapped put a time limit on each; like psCapped, they do not ask twice */
  for (const [what, src, call] of [['Send', send, 'pcSend('],
                                   ['Approve', steps, 'pstCapped(() => pstDecide('], ['Send answers', steps, 'pstCapped(() => pstSubmitForm('],
                                   /* psCapped puts a time limit on this one ask; it does not ask twice */
                                   ['Pick a time', sched, "ctx.rpc('portal_offer_pick'"]]) {
    assert.equal((src.split(call).length - 1), 1, what + ' is attempted from exactly one place');
  }
  /* and the retry helper exists only in this file, which only ever reads */
  const tracker = fs.readFileSync(path.join(root, 'portal-tracker.js'), 'utf8');
  assert.match(tracker, /pctReadTwice/);
  for (const src of [send, steps, sched]) assert.doesNotMatch(src, /ReadTwice/);
  /* the reads it retries are selects and read-only rpcs, nothing else */
  for (const name of ['portal_journey', 'portal_month', 'portal_campaign', 'portal_calls']) {
    assert.ok(tracker.includes(name), name + ' is one of the reads');
  }
  assert.doesNotMatch(tracker, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/, 'this file never writes');
});

/* ───────────── how much a portal tab costs ─────────────
   When the database has no portal_campaign / portal_calls function the tabs
   fall back to reading the tables. Each tab needs two tables, and neither
   needs the other, so the client should wait for one read and not two. */

function countingSb(rows) {
  const log = [];
  let open = 0, mostAtOnce = 0;
  return {
    log, most: () => mostAtOnce,
    sb: {
      from(table) {
        const q = {
          select(cols) { q._cols = cols; return q },
          eq() { return q }, order() { return q },
          limit(n) {
            log.push({ table, cols: q._cols, limit: n });
            open++; mostAtOnce = Math.max(mostAtOnce, open);
            /* answers on a later turn, so two reads really can overlap */
            return new Promise((res) => setTimeout(() => { open--; res({ data: rows[table] || [], error: null }) }, 1));
          },
        };
        return q;
      },
    },
  };
}
const noRpc = async (n) => ({ ok: false, data: null, error: 'Could not find the function public.' + n + ' in the schema cache' });

test('the Campaign tab reads its two tables together, each with a row limit and named columns', async () => {
  const c = countingSb({ outreach_campaigns: [{ id: 'cp1', client_id: 'c1', name: 'Autumn', status: 'running', sent: 10, replied: 2 }], outreach_daily: [] });
  const got = await pctLoadCampaign({ sb: c.sb, rpc: noRpc }, 'c1');
  assert.equal(got.client_id, 'c1');
  assert.equal(got.campaigns.length, 1);
  assert.deepEqual(c.log.map((r) => r.table).sort(), ['outreach_campaigns', 'outreach_daily']);
  assert.equal(c.log.length, 2, 'two reads, no more');
  assert.equal(c.most(), 2, 'and both in flight at once, not one after the other');
  for (const r of c.log) {
    assert.ok(r.limit > 0, r.table + ' is read with a row limit, so one client cannot ask for everything');
    assert.notEqual(r.cols, '*', r.table + ' is read by column');
  }
});

test('the Calls tab reads its two tables together, each with a row limit and named columns', async () => {
  const c = countingSb({
    qualified_calls: [{ id: 'q1', client_id: 'c1', prospect_name: 'Nina', prospect_company: 'Nina Roofing', booked_for: '2026-11-20T14:00:00Z', happened: true, counts: true }],
    outreach_threads: [{ client_id: 'c1', lead_name: 'Nina', lead_company: 'Nina Roofing', lead_title: 'Owner' }],
  });
  const got = await pctLoadCalls({ sb: c.sb, rpc: noRpc }, 'c1');
  assert.equal(got.calls.length, 1);
  assert.equal(got.calls[0].who, 'Nina');
  assert.equal(got.calls[0].title, 'Owner', 'the title from the thread is still joined on');
  assert.deepEqual(c.log.map((r) => r.table).sort(), ['outreach_threads', 'qualified_calls']);
  assert.equal(c.most(), 2, 'both in flight at once');
  for (const r of c.log) {
    assert.ok(r.limit > 0, r.table + ' is read with a row limit');
    assert.notEqual(r.cols, '*', r.table + ' is read by column');
  }
});

test('one of a tab’s two tables refusing is still reported, not shown as an empty tab', async () => {
  const half = {
    sb: {
      from(table) {
        const q = { select() { return q }, eq() { return q }, order() { return q },
          limit() { return Promise.resolve(table === 'outreach_daily' ? { data: null, error: { message: 'permission denied' } } : { data: [], error: null }) } };
        return q;
      },
    },
    rpc: noRpc,
  };
  const got = await pctLoadCampaign(half, 'c1');
  assert.equal(pctFailed(got), true, 'a table that refused is a failure, not an empty campaign');
});

test('a request that never answers is given up on, not waited on for ever', async () => {
  PC.tab = 'campaign'; pct.tab = 'campaign';
  pct.readMs = 20;                      /* the real limit is ten seconds */
  let n = 0;
  try {
    await pctMount({rpc: (name) => {
      if (name === 'portal_journey') return Promise.resolve({ok:true, data:journey(), error:''});
      if (name === 'portal_campaign') { n++; return new Promise(() => {}); }   /* never settles */
      return Promise.resolve({ok:true, data:null, error:''});
    }});
  } finally { pct.readMs = 0; }
  assert.equal(n, 2, 'it timed out, tried once more, and timed out again');
  assert.equal(pct.campaignBusy, false, 'and did not leave the guard flag set');
  assert.equal(pct.campaignFailed, true);
  assert.match(text(boxes.pcCampaign.innerHTML), /could not load your campaign numbers/i);
  assert.doesNotMatch(text(boxes.pcCampaign.innerHTML), /^Loading$/i);
});

test('a slow answer that does arrive is still used', async () => {
  PC.tab = 'calls'; pct.tab = 'calls';
  pct.readMs = 400;
  try {
    await pctMount({rpc: (name) => new Promise(r => setTimeout(() => r(
      {ok:true, error:'', data: name === 'portal_journey' ? journey() : name === 'portal_calls' ? callRows('c1') : null}), 30))});
  } finally { pct.readMs = 0; }
  assert.equal(pct.callsFailed, false);
  assert.match(boxes.pcCalls.innerHTML, /Marcus Hale/);
});

/* ------------------------------------------------------------------
   An unknown client is a failure, never an empty answer.

   portal_journey is where the client id comes from. When it does not answer,
   the fallback reads used to return [] without a query going out, so every tab
   drew its empty state: "Nothing has been sent yet", "Not started", a zeroed
   funnel — sitting next to the guarantee those figures settle. The client was
   told a confident, specific lie about their own campaign.
   ------------------------------------------------------------------ */
test('with no client id, a fallback read reports a failure instead of an empty answer', async () => {
  let queried = 0;
  const sb = { from(){ queried++; return { select(){ return this }, eq(){ return this }, order(){ return this }, limit: async () => ({ data: [], error: null }) }; } };

  await assert.rejects(
    () => pctRows(sb, 'client_months', 'client_id', '', null),
    /which account/i,
    'an unknown client must throw, so pctAsk turns it into the failure panel');

  assert.equal(queried, 0, 'it must not pretend to have asked the database');
});

test('a known client still reads normally', async () => {
  let asked = null;
  const sb = { from(t){ asked = t; return { select(){ return this }, eq(){ return this }, order(){ return this }, limit: async () => ({ data: [{ client_id: 'c1', month_no: 1 }], error: null }) }; } };
  const rows = await pctRows(sb, 'client_months', 'client_id,month_no', 'c1', null);
  assert.equal(asked, 'client_months');
  assert.equal(rows.length, 1);
});

/* ───────────── "as of": the numbers come from a third party, so they carry a date ─────────────
   Instantly or Smartlead can be down for days. Without a date on the Campaign tab a
   client reads Tuesday's figures on Friday as today's, on the tab the guarantee is
   argued over. */
test('the campaign tab says when the sending platform was last read', () => {
  const now = new Date('2026-12-10T12:00:00Z');
  assert.match(pctAsOf('2026-12-10T11:40:00Z', now), /last read within the last hour or so\.$/);
  assert.match(pctAsOf('2026-12-10T05:00:00Z', now), /last read about 7 hours ago\.$/);
  assert.match(pctAsOf('2026-12-09T10:00:00Z', now), /last read yesterday\.$/);
});
test('numbers more than a day and a half old say they may be behind', () => {
  const now = new Date('2026-12-10T12:00:00Z');
  const t = pctAsOf('2026-12-07T12:00:00Z', now);
  assert.match(t, /last read 3 days ago/);
  assert.match(t, /may be behind/);
});
test('when we were not told when it was read, the tab claims nothing about freshness', () => {
  for (const v of ['', null, undefined, 'not a date']) {
    const t = pctAsOf(v, new Date('2026-12-10T12:00:00Z'));
    assert.doesNotMatch(t, /last read|fresh|a few times a day/i, 'no freshness claim for ' + JSON.stringify(v));
  }
});
test('the newest sync across a client\'s campaigns is the one shown, and only their own', () => {
  const d = {campaigns: [
    {id:'a', client_id:'c1', name:'A', status:'active', sent:10, last_synced_at:'2026-12-08T00:00:00Z'},
    {id:'b', client_id:'c1', name:'B', status:'active', sent:10, last_synced_at:'2026-12-09T06:00:00Z'},
    {id:'x', client_id:'OTHER', name:'X', status:'active', sent:10, last_synced_at:'2026-12-10T11:59:00Z'},
  ], daily: []};
  assert.equal(pctCampaignNorm(d, 'c1').synced, '2026-12-09T06:00:00.000Z');
  assert.equal(pctCampaignNorm({campaigns:[{id:'a', client_id:'c1', sent:1}], daily:[]}, 'c1').synced, '');
});
test('the daily read keeps the NEWEST days when there are more than the ceiling', () => {
  /* it used to order oldest first, so past the row limit the recent days were dropped */
  const src = fs.readFileSync(path.join(root, 'portal-tracker.js'), 'utf8');
  const body = src.slice(src.indexOf('async function pctLoadCampaign'), src.indexOf('async function pctLoadCalls'));
  assert.match(body, /order\('on_day', \{ ascending: false \}\)/);
  assert.doesNotMatch(body, /ascending: true/);
});
