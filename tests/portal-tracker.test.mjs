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

vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-client.js'), 'utf8'), {filename:'portal-client.js'});
vm.runInThisContext(fs.readFileSync(path.join(root, 'portal-tracker.js'), 'utf8'), {filename:'portal-tracker.js'});

const NOW = new Date(2026, 10, 24, 10, 0, 0);   /* Nov 24 2026, local */
const journey = (o={}) => ({client_id:'c1', company:'Stone', paid_on:'2026-11-18', launch_on:'2026-12-02', days_to_launch:8, next_step:'research',
  steps:[
    {step:'kickoff', title:'Kickoff call', position:1, planned_on:'2026-11-20', status:'done'},
    {step:'research', title:'Research: your market, ICP, angles', position:2, planned_on:'2026-11-22', status:'doing'},
    {step:'testing', title:'Market testing', position:3, planned_on:'2026-11-29', status:'todo'},
    {step:'build', title:'Build the real campaign', position:4, planned_on:'2026-12-01', status:'todo'},
    {step:'onboarding', title:'Onboarding call', position:5, planned_on:'2026-12-01', status:'todo'},
    {step:'launch', title:'Launch — month one starts', position:6, planned_on:'2026-12-02', status:'todo'},
  ], ...o});
const text = (h) => String(h).replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#?[a-z0-9]+;/gi,' ').replace(/\s+/g,' ').trim();

beforeEach(() => {
  pct.open = false; pct.drawn = ''; pct.at = 0; pct.data = null; pct.busy = false; pct.who = "|";
  pct.tab = 'chat'; pct.gone = {}; pct.standing = ''; pct.campaignDrawn = ''; pct.callsDrawn = '';
  pct.month = null; pct.monthAt = 0; pct.monthBusy = false;
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
  const short = pctMonthNorm(month({calls_delivered:6}), journey(), NOWD(2027, 1, 8));
  assert.equal(short.state, 'short');
  const h = pctStandingHtml(short);
  assert.match(text(h), /Refund due/);
  assert.match(text(h), /refund/i);
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
  /* and once it is live but today has no numbers yet, it says so instead */
  const live = pctMonthNorm(month({calls_delivered:0}), journey(), NOWD(2026, 12, 10));
  assert.match(text(pctCampaignHtml(null, live)), /first numbers land this evening/i);
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
  ['id="pcTracker"', 'id="pcKick"', 'id="pcScroll"', 'id="pcCompose"'].forEach(id => assert.ok(html.includes(id)));
  assert.ok(html.indexOf('id="pcPanel-chat"') < html.indexOf('id="pcScroll"'));
  assert.ok(html.indexOf('id="pcScroll"') < html.indexOf('id="pcPanel-campaign"'));
  /* and the tracker is told which tab is open, so a closed tab is never asked for */
  assert.ok(html.includes('PC.tab'));
  assert.ok(html.includes('ArrowRight') && html.includes('aria-selected'));
});
