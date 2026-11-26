/* Tests for journey.js — the payment-to-launch tracker in the hub.
   A fake `sb` answers rpc calls from a table of canned answers. No network, no DOM.
   Run with:  node --test tests/journey.test.mjs   (or npm test) */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;

let rpcs = [], answers = {};
const fakeSb = { rpc: async (name, args) => {
  rpcs.push({name, args});
  const h = answers[name];
  if (h instanceof Error) throw h;
  return typeof h === 'function' ? h(args) : (h || {data:null, error:null});
}};
globalThis.sb = fakeSb;
const fields = {}, toasts = [];
globalThis.esc = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
globalThis.val = (id) => String(fields[id] == null ? '' : fields[id]).trim();
globalThis.toast = (m) => { toasts.push(m) };
globalThis.openModal = (h) => { fields.modal = h };
globalThis.closeModal = () => { fields.modal = null };

vm.runInThisContext(fs.readFileSync(path.join(root, 'journey.js'), 'utf8'), {filename:'journey.js'});

const TODAY = '2026-11-24';
const steps = (over={}) => [
  ['kickoff','Kickoff call','2026-11-20','done'],
  ['research','Research: your market, ICP, angles','2026-11-22','doing'],
  ['testing','Market testing (message-market fit)','2026-11-29','todo'],
  ['build','Build the real campaign','2026-12-01','todo'],
  ['onboarding','Onboarding call','2026-12-01','todo'],
  ['launch','Launch — month one starts','2026-12-02','todo'],
].map(([step,title,planned_on,status],i) => ({step,title,position:i+1,planned_on,status,done_at:status==='done'?'2026-11-20T15:00:00Z':null,note:null,...(over[step]||{})}));
const journey = (o={}) => ({client_id:'c1', company:'Stone Roofing', paid_on:'2026-11-18', launch_on:'2026-12-02', days_to_launch:8,
  steps: steps(o.over), next_step:'research', ...o});
const shape = (r) => { assert.deepEqual(Object.keys(r).sort(), ['data','error','ok']); return r };
const text = (h) => String(h).replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#?[a-z0-9]+;/gi,' ').replace(/\s+/g,' ').trim();

beforeEach(() => {
  rpcs = []; answers = {}; toasts.length = 0;
  Object.keys(fields).forEach(k => delete fields[k]);
  globalThis.sb = fakeSb;
  jyForget();
});

test('the six steps, in order', () => {
  assert.deepEqual(JY_KEYS, ['kickoff','research','testing','build','onboarding','launch']);
  assert.deepEqual(JY_STEPS.map(s => s[2]), [2,4,11,13,13,14]);
});

test('late is worked out, never trusted blindly to be stored', () => {
  assert.equal(jyIsLate({status:'todo', planned_on:'2026-11-23'}, TODAY), true);
  assert.equal(jyIsLate({status:'doing', planned_on:'2026-11-24'}, TODAY), false, 'today is not late yet');
  assert.equal(jyIsLate({status:'done', planned_on:'2026-11-01', late:true}, TODAY), false, 'done is never late');
  assert.equal(jyIsLate({status:'todo', planned_on:'2026-11-01', late:false}, TODAY), false, 'the database wins when it says');
  const n = jyNorm(journey(), TODAY);
  assert.equal(n.late, 1);
  assert.equal(n.next.step, 'research');
  assert.equal(n.done, 1);
  assert.equal(n.days_to_launch, 8);
});

test('jyNorm copes with nothing and with junk', () => {
  for (const j of [null, undefined, {}, {steps:null}, {steps:[null]}, 'x']) {
    const n = jyNorm(j, TODAY);
    assert.equal(n.steps.length, 0); assert.equal(n.late, 0); assert.equal(n.next, null);
  }
  const n = jyNorm({steps:[{step:'launch', status:'weird', planned_on:'2026-12-02'}]}, TODAY);
  assert.equal(n.steps[0].status, 'todo');
  assert.equal(n.days_to_launch, 8, 'worked out from the launch step when not given');
});

test('the board with zero rows says so, and an error is said out loud', () => {
  const empty = jyRenderBoard([], {});
  assert.match(text(empty), /Nobody is onboarding/);
  const bad = jyRenderBoard([], {error:'The database is down <b>'});
  assert.match(bad, /The database is down &lt;b&gt;/);
  assert.match(bad, /jyReload\(\)/);
  assert.match(jyRenderBoard(null, {}), /Nobody is onboarding/);
});

test('a board row: six pills, the late one, days to launch, next step and its action', () => {
  const h = jyRenderBoard([journey()], {today: TODAY});
  assert.equal((h.match(/class="jy-pill /g) || []).length, 6);
  assert.match(h, /jy-pill done/);
  assert.match(h, /jy-pill late next/);
  assert.match(h, /<b>8<\/b><small>days to launch<\/small>/);
  assert.match(text(h), /Next Research: your market, ICP, angles was due 22 Nov/);
  assert.match(h, /jyAskApproval\(&quot;c1&quot;,&quot;icp&quot;\)/);
  assert.match(text(h), /Steps late 1 across 1 client/);
  assert.match(h, /jy-row is-late/);
});

test('everything from the database is escaped', () => {
  const j = journey({company:'<img src=x onerror=alert(1)>', client_id:'c"1', over:{research:{title:'<script>x</script>', note:'<i>n</i>'}}});
  const board = jyRenderBoard([j], {today: TODAY});
  const one = jyRenderTracker('c"1', j, {today: TODAY});
  for (const h of [board, one]) {
    assert.ok(!/<img|<script|<i>/.test(h), 'no raw tags');
    assert.match(h, /&lt;script&gt;/);
  }
  assert.match(one, /&lt;i&gt;n&lt;\/i&gt;/);
  assert.ok(!one.includes('"c"1"'), 'ids are quoted safely inside onclick');
});

test('the board puts late clients first, then the soonest launch', () => {
  const a = journey({client_id:'a', company:'Alpha', days_to_launch:3, over:{research:{planned_on:'2026-11-30'}}});
  const b = journey({client_id:'b', company:'Bravo', days_to_launch:9});
  const c = journey({client_id:'c', company:'Charlie', days_to_launch:1, over:{research:{planned_on:'2026-11-30'}}});
  const h = jyRenderBoard([a, b, c], {today: TODAY});
  const order = [...h.matchAll(/class="jy-co"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(order, ['Bravo', 'Charlie', 'Alpha']);
});

test('launch words', () => {
  assert.equal(jyLaunchWords({days_to_launch:1}), 'Launch in 1 day');
  assert.equal(jyLaunchWords({days_to_launch:0}), 'Launches today');
  assert.equal(jyLaunchWords({days_to_launch:-2}), 'Launch 2 days overdue');
  assert.equal(jyLaunchWords({live:true, days_to_launch:-5}), 'Live');
  assert.equal(jyLaunchWords({days_to_launch:null}), 'No launch date');
});

test('the client tracker: per-step controls and the right action per step', () => {
  const h = jyRenderTracker('c1', journey(), {today: TODAY});
  assert.equal((h.match(/class="jy-step /g) || []).length, 6);
  assert.ok(!/jyOffer\(&quot;c1&quot;,&quot;kickoff&quot;\)/.test(h), 'kickoff is done, so no times are offered for it');
  assert.match(h, /jyOffer\(&quot;c1&quot;,&quot;onboarding&quot;\)/);
  assert.match(h, /Offer onboarding call times/);
  assert.match(h, /Send ICP \+ angles for approval/);
  assert.match(h, /Log today.s numbers/);
  assert.match(h, /Send copy for approval/);
  assert.match(h, /jyAskMove\(&quot;c1&quot;,&quot;testing&quot;\)/);
  assert.match(h, /Reopen/);
  assert.match(text(h), /Done 20 Nov · planned 20 Nov/);
  /* zero steps */
  const none = jyRenderTracker('c1', {steps:[]}, {admin:true});
  assert.match(text(none), /start when their first invoice is paid/);
  assert.match(none, /jyStart\(&quot;c1&quot;\)/);
  assert.ok(!/jyStart/.test(jyRenderTracker('c1', null, {})), 'only an admin can start it');
  assert.match(jyRenderTracker('c1', null, {error:'nope'}), /nope/);
});

test('jyActionFor names the other builders’ actions', () => {
  assert.deepEqual(jyActionFor('kickoff'), ['Offer kickoff times', 'jyOffer', 'kickoff']);
  assert.deepEqual(jyActionFor('onboarding'), ['Offer onboarding call times', 'jyOffer', 'onboarding']);
  assert.equal(jyActionFor('research')[2], 'icp');
  assert.equal(jyActionFor('build')[2], 'copy');
  assert.equal(jyActionFor('launch'), null);
});

test('data calls use the spec names and shapes, and never throw', async () => {
  answers.journey_board = {data:[journey()], error:null};
  shape(await jyBoard());
  assert.deepEqual(rpcs.at(-1), {name:'journey_board', args:{}});
  answers.journey_get = {data:journey(), error:null};
  assert.equal((await jyGet('c1')).data.company, 'Stone Roofing');
  assert.deepEqual(rpcs.at(-1).args, {p_client:'c1'});
  await jySet('c1', 'testing', 'doing');
  assert.deepEqual(rpcs.at(-1), {name:'journey_set', args:{p_client:'c1', p_step:'testing', p_status:'doing'}});
  await jySet('c1', 'testing', 'done', ' a note ');
  assert.equal(rpcs.at(-1).args.p_note, 'a note');
  await jyMoveStep('c1', 'build', '2026-12-03');
  assert.deepEqual(rpcs.at(-1), {name:'journey_move', args:{p_client:'c1', p_step:'build', p_planned:'2026-12-03'}});
  await jyOfferTimes('c1', 'kickoff');
  assert.deepEqual(rpcs.at(-1), {name:'offer_times', args:{p_client:'c1', p_kind:'kickoff'}});
  await jyApprovalRequest('c1', 'icp', ' ICP ', ' body ');
  assert.deepEqual(rpcs.at(-1), {name:'approval_request', args:{p_client:'c1', p_kind:'icp', p_title:'ICP', p_body:'body'}});
  await jyTestingDay('c1', 180, 7, 'angle B');
  assert.deepEqual(rpcs.at(-1), {name:'testing_day', args:{p_client:'c1', p_sent:180, p_replies:7, p_leading:'angle B'}});
  /* refusals before the database is asked */
  const n = rpcs.length;
  for (const r of [await jySet('c1','nope','done'), await jySet('c1','build','finished'), await jyMoveStep('c1','build','soon'),
                   await jyOfferTimes('c1','lunch'), await jyApprovalRequest('c1','icp','',''), await jyApprovalRequest('c1','bad','t','b'),
                   await jyTestingDay('c1', -1, 0, ''), await jyTestingDay('c1', 5, 9, ''), await jyGet('')]) {
    shape(r); assert.equal(r.ok, false); assert.ok(r.error);
  }
  assert.equal(rpcs.length, n);
  /* a thrown error and a database error both come back as words */
  answers.journey_board = new Error('socket closed');
  const t = shape(await jyBoard());
  /* changed on purpose in the perfection pass: the plumbing's own wording ("socket closed",
     "permission denied") is no longer shown to the owner; he gets a sentence he can act on. */
  assert.equal(t.ok, false); assert.equal(t.error, "Can't reach Aviance right now. Check your connection and try again.");
  answers.journey_get = {data:null, error:{message:'permission denied'}};
  assert.equal((await jyGet('c1')).error, "You don't have access to do that.");
  globalThis.sb = undefined;
  assert.equal((await jyBoard()).ok, false);
});

test('the late badge counts late steps from the cached board', async () => {
  assert.equal(jyLateOf([journey(), journey()], TODAY), 2);
  assert.equal(jyLateOf(null), 0);
  answers.journey_board = {data:[journey({over:{testing:{planned_on:'2020-01-01'}}})], error:null};
  assert.equal(jyLateCount(), 0, 'nothing cached yet');
  await jyLoadBoard(true);
  assert.equal(jyLateCount(), 2);
  const n = rpcs.length;
  jyLateCount();
  assert.equal(rpcs.length, n, 'a fresh count does not ask again');
});

test('viewJourneyBoard: loading, then the board', async () => {
  answers.journey_board = {data:[journey()], error:null};
  assert.match(viewJourneyBoard(), /Loading/);
  await jyLoadBoard();
  assert.match(viewJourneyBoard(), /Stone Roofing/);
  jyForget();
  answers.journey_board = {data:null, error:{message:'down'}};
  viewJourneyBoard();
  await jyLoadBoard(true);
  assert.match(viewJourneyBoard(), /down/);
});

test('mounting on a client page draws the tracker; a live client without one is hidden', async () => {
  const el = {innerHTML:'', attrs:{'data-cb-stage':'onboarding'}, getAttribute(k){ return this.attrs[k] || null }};
  answers.journey_get = {data:journey(), error:null};
  const r = await jyMountClient('c1', el);
  assert.equal(r.ok, true);
  assert.match(el.innerHTML, /Journey to launch/);
  const live = {innerHTML:'', getAttribute(){ return 'live' }};
  answers.journey_get = {data:{steps:[]}, error:null};
  await jyMountClient('c2', live);
  assert.equal(live.innerHTML, '');
  assert.equal((await jyMountClient('c1', null)).ok, false);
});

test('the buttons: mark, offer, approval, testing — each says what happened', async () => {
  answers.journey_set = {data:journey(), error:null};
  answers.journey_board = {data:[], error:null};
  answers.journey_get = {data:journey(), error:null};
  await jyMark('c1', 'research', 'done');
  assert.equal(toasts.at(-1), 'Research done');
  answers.offer_times = {data:'draft-1', error:null};
  await jyOffer('c1', 'kickoff');
  assert.equal(toasts.at(-1), 'Draft ready — approve it in Replies');
  jyAskApproval('c1', 'copy');
  assert.match(fields.modal, /Send copy for approval/);
  fields.jyApTitle = 'Your copy'; fields.jyApBody = 'Email 1 …';
  answers.approval_request = {data:'d2', error:null};
  await jySendApproval('c1', 'copy');
  assert.equal(fields.modal, null, 'the form closes');
  assert.equal(rpcs.find(x => x.name === 'approval_request').args.p_kind, 'copy');
  jyAskTesting('c1');
  fields.jyTdSent = '180'; fields.jyTdReplies = '7'; fields.jyTdLead = 'angle B';
  answers.testing_day = {data:'d3', error:null};
  const t = await jySendTesting('c1');
  assert.equal(t.ok, true);
  answers.offer_times = {data:null, error:{message:'no free slots'}};
  await jyOffer('c1', 'onboarding');
  assert.equal(toasts.at(-1), 'no free slots');
});

/* ───────────── perfection pass ───────────── */

test('errors read as plain sentences: the plumbing is translated, our own database messages pass through', async () => {
  assert.equal(jyPlain('TypeError: Failed to fetch'), "Can't reach Aviance right now. Check your connection and try again.");
  assert.equal(jyPlain('JWT expired'), 'Your sign-in has run out. Please sign in again.');
  assert.equal(jyPlain('new row violates row-level security policy for table "client_journey"'), "You don't have access to do that.");
  assert.match(jyPlain('Could not find the function public.journey_board in the schema cache'), /isn't switched on yet/);
  assert.equal(jyPlain('That step is already done.'), 'That step is already done.', 'a raise exception from the database is already plain');
  for (const raw of ['Failed to fetch', 'JWT expired', 'permission denied for table x', 'function journey_get(uuid) does not exist']) {
    answers.journey_get = {data:null, error:{message:raw}};
    const r = await jyGet('c1');
    assert.doesNotMatch(r.error, /jwt|function|permission denied|fetch|schema|table/i, raw);
  }
  globalThis.sb = undefined;
  assert.doesNotMatch((await jyBoard()).error, /database/i, 'and "the database" is not a thing he is told about');
  globalThis.sb = fakeSb;
});

test('a double click never queues two drafts for the client', async () => {
  let open = 0;
  const slow = (out) => () => new Promise((r) => { open++; setTimeout(() => r(out), 10); });
  answers.journey_board = {data:[], error:null}; answers.journey_get = {data:journey(), error:null};
  fields.jyApTitle = 'Your copy'; fields.jyApBody = 'Email 1';
  answers.approval_request = slow({data:'d1', error:null});
  const [a, b] = await Promise.all([jySendApproval('c1', 'copy'), jySendApproval('c1', 'copy')]);
  assert.equal(rpcs.filter(x => x.name === 'approval_request').length, 1, 'one approval, not two');
  assert.equal([a, b].filter(r => r.ok).length, 1);
  fields.jyTdSent = '100'; fields.jyTdReplies = '3'; fields.jyTdLead = ''; fields.jyTdNote = '';
  answers.testing_day = slow({data:'d2', error:null});
  await Promise.all([jySendTesting('c1'), jySendTesting('c1')]);
  assert.equal(rpcs.filter(x => x.name === 'testing_day').length, 1);
  fields.jyMvDay = '2026-12-05';
  answers.journey_move = slow({data:journey(), error:null});
  await Promise.all([jyDoMove('c1', 'research'), jyDoMove('c1', 'research')]);
  assert.equal(rpcs.filter(x => x.name === 'journey_move').length, 1);
  answers.journey_start = slow({data:journey(), error:null});
  await Promise.all([jyStart('c1'), jyStart('c1')]);
  assert.equal(rpcs.filter(x => x.name === 'journey_start').length, 1);
  /* and once it is done, the next press works */
  answers.approval_request = {data:'d3', error:null};
  assert.equal((await jySendApproval('c1', 'copy')).ok, true);
});

test('the board stops refreshing, and forgets what it had, once nobody is signed in', async () => {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  let tickFn = null, cleared = 0;
  globalThis.setInterval = (fn) => { tickFn = fn; return {unref(){}}; };
  globalThis.clearInterval = () => { cleared++; };
  globalThis.document = {hidden:false, getElementById: () => null};
  globalThis.authUser = {role:'admin'};
  try {
    jyForget();
    answers.journey_board = {data:[journey()], error:null};
    jyLateCount();
    await jyLoadBoard(true);
    assert.equal(typeof tickFn, 'function', 'the minute timer is running');
    assert.ok(jy.board);
    const n = rpcs.length;
    tickFn(); await new Promise(r => setTimeout(r, 5));
    assert.ok(rpcs.length > n, 'signed in: it asks');
    globalThis.authUser = null;                       /* he signs out */
    const m = rpcs.length;
    tickFn(); await new Promise(r => setTimeout(r, 5));
    assert.equal(rpcs.length, m, 'signed out: nothing is asked');
    assert.equal(jy.board, null, 'and the last login\'s board is gone');
    assert.equal(jy.timer, null);
    assert.ok(cleared >= 1);
  } finally {
    globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
    delete globalThis.document; delete globalThis.authUser; jyForget();
  }
});

test('the title a client sees by default does not say "ICP"', () => {
  const form = jyRenderApprovalForm('c1', 'icp');
  assert.match(form, /value="Your target profile \+ 3 angles"/);
});
