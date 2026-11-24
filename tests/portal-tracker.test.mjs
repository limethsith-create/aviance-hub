/* Tests for portal-tracker.js — the client's launch plan above their channel.
   portal-client.js is loaded first, as in portal.html, for pcEsc and the PC hook.
   A tiny fake document holds #pcTracker. No network.
   Run with:  node --test tests/portal-tracker.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;

/* just enough document for the mount: one box, one <style> */
const nodes = {};
const box = {id:'pcTracker', innerHTML:'', get firstChild(){ return this.innerHTML ? {} : null }, querySelector(){ return null }};
globalThis.document = {
  head: {appendChild(n){ nodes[n.id] = n }},
  getElementById(id){ return id === 'pcTracker' ? box : (nodes[id] || null) },
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

beforeEach(() => { pct.open = false; pct.drawn = ''; pct.at = 0; pct.data = null; pct.busy = false; box.innerHTML = ''; });

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
  const ctx = {rpc: async (n, a) => { asked.push(n); return {ok:true, data:journey(), error:''} }};
  await pctMount(ctx);
  assert.deepEqual(asked, ['portal_journey']);
  assert.match(box.innerHTML, /Your launch plan/);
  assert.ok(nodes.pctCss, 'its stylesheet is added once');
  await pctMount(ctx);
  assert.equal(asked.length, 1);
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
