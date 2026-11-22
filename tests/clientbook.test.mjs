/* Tests for clientbook.js — the clients and the journey.
   A fake `sb` stands in for Supabase: a chainable query builder over a table of
   canned answers (the set-up in tests/channels-api.test.mjs). No network, no DOM
   beyond the few things the screens touch.
   Run with:  node --test tests/clientbook.test.mjs   (or npm test) */
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
function builder(table){
  const call = {table, op:'select', filters:[], order:null, limit:null, payload:null, single:false, maybe:false, cols:null, opts:null};
  calls.push(call);
  const b = {
    select(c){ call.cols = c; return b },
    insert(p){ call.op='insert'; call.payload=p; return b },
    update(p){ call.op='update'; call.payload=p; return b },
    upsert(p,o){ call.op='upsert'; call.payload=p; call.opts=o; return b },
    delete(){ call.op='delete'; return b },
    eq(k,v){ call.filters.push(['eq',k,v]); return b },
    in(k,v){ call.filters.push(['in',k,v]); return b },
    is(k,v){ call.filters.push(['is',k,v]); return b },
    order(k,o){ call.order=[k,o]; return b },
    limit(n){ call.limit=n; return b },
    single(){ call.single=true; return b },
    maybeSingle(){ call.maybe=true; return b },
    then(res,rej){
      const h = tables[table + '.' + call.op];
      let out = typeof h === 'function' ? h(call) : (h || {data:[], error:null});
      if ((call.single || call.maybe) && out && Array.isArray(out.data)) {
        out = out.data.length ? {data:out.data[0], error:null}
            : call.maybe ? {data:null, error:null}
            : {data:null, error:{message:'no rows'}};
      }
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}
const fakeSb = {from: builder, rpc: async () => ({data:null, error:null})};
globalThis.sb = fakeSb;

/* the few shell globals the screens reach for */
const fields = {};
const toasts = [];
globalThis.esc = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
globalThis.val = (id) => String(fields[id] == null ? '' : fields[id]).trim();
globalThis.errEl = (id,msg) => { fields['err:'+id] = msg; return false };
globalThis.emptyState = (icon,title,sub,btn,action) =>
  `<div class="card"><div class="empty"><h3>${title}</h3><p>${sub}</p>${btn?`<button class="btn" onclick="${action}">${btn}</button>`:''}</div></div>`;
globalThis.toast = (m) => { toasts.push(m) };
globalThis.openModal = (h) => { fields.modal = h };
globalThis.closeModal = () => { fields.modal = null };

vm.runInThisContext(fs.readFileSync(path.join(root, 'clientbook.js'), 'utf8'), {filename:'clientbook.js'});

/* ───────────── fixtures ───────────── */
const PLANS = [
  {plan:'pilot',   label:'Pilot',   calls_promised:2,  monthly_fee:300,  three_month_fee:null, is_recurring:false},
  {plan:'starter', label:'Starter', calls_promised:5,  monthly_fee:1500, three_month_fee:1200, is_recurring:true},
  {plan:'growth',  label:'Growth',  calls_promised:10, monthly_fee:3000, three_month_fee:2400, is_recurring:true},
  {plan:'scale',   label:'Scale',   calls_promised:15, monthly_fee:4500, three_month_fee:3600, is_recurring:true},
];
const client = (o={}) => ({
  id:'c1', company:'Stone Roofing', contact_name:'Sam Stone', contact_email:'sam@stone.test',
  website:'stone.test', plan:'growth', term:'monthly', calls_promised:10, monthly_fee:3000,
  stage:'live', pilot_credit:0, pilot_credit_used:false, owner_id:'u1',
  created_at:'2026-09-01T10:00:00Z', updated_at:'2026-11-01T10:00:00Z', ...o,
});
const month = (o={}) => ({
  client_id:'c1', month_id:'m1', month_no:2, starts_on:'2026-11-01', ends_on:'2026-11-30',
  calls_promised:10, calls_delivered:4, days_left:6, verdict:'open', refund_due:0, ...o,
});
const shape = (r) => { assert.deepEqual(Object.keys(r).sort(), ['data','error','ok']); return r };
const seen = (table, op) => calls.filter(c => c.table === table && c.op === op);
const writes = () => calls.filter(c => c.op !== 'select');
const text = (h) => String(h).replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#?[a-z0-9]+;/gi,' ').replace(/\s+/g,' ').trim();

beforeEach(() => {
  calls = []; tables = {}; toasts.length = 0;
  Object.keys(fields).forEach(k => delete fields[k]);
  globalThis.sb = fakeSb;
  globalThis.authUser = {uid:'u1', name:'Owner', role:'admin'};
  cbForget();
  cbOpenId = null;
});

/* ═════════════ 1. the stages, in order, one at a time ═════════════ */

test('the stages are the journey, in order', () => {
  assert.deepEqual(CB_STAGE_KEYS, ['enquiry','booked','won','onboarding','live','at_risk','ended']);
  assert.equal(cbStageIndex('enquiry'), 0);
  assert.equal(cbStageIndex('ended'), 6);
  assert.equal(cbStageIndex('sending'), -1, 'a stage the hub does not know');
  /* every stage has a label and a plain meaning */
  CB_STAGES.forEach(([k,label,meaning]) => {
    assert.ok(label && /^[A-Z]/.test(label), k + ' has a label');
    assert.ok(meaning && /\.$/.test(meaning), k + ' says what it means');
  });
  /* one step either way, and nowhere past the ends */
  assert.equal(cbStageAfter('won'), 'onboarding');
  assert.equal(cbStageBefore('won'), 'booked');
  assert.equal(cbStageAfter('ended'), null);
  assert.equal(cbStageBefore('enquiry'), null);
});

test('cbMoveStage moves one stage and writes all three rows', async () => {
  tables['clients.select'] = () => ({data:[client({stage:'won'})], error:null});
  tables['clients.update'] = (c) => ({data:[{...client({stage:'onboarding'}), ...c.payload}], error:null});
  tables['client_stage_history.insert'] = (c) => ({data:[{id:7, ...c.payload}], error:null});
  tables['client_events.insert'] = (c) => ({data:[{id:11, ...c.payload}], error:null});

  const r = shape(await cbMoveStage('c1', 'onboarding', 'Inputs agreed on the call'));
  assert.equal(r.ok, true);
  assert.equal(r.error, '');
  assert.equal(r.data.warning, '', 'the whole trail saved');

  /* the clients row */
  const up = seen('clients','update');
  assert.equal(up.length, 1);
  assert.equal(up[0].payload.stage, 'onboarding');
  assert.deepEqual(up[0].filters, [['eq','id','c1']]);

  /* the stage history, with where it came from */
  const hist = seen('client_stage_history','insert');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].payload.client_id, 'c1');
  assert.equal(hist[0].payload.from_stage, 'won');
  assert.equal(hist[0].payload.to_stage, 'onboarding');
  assert.equal(hist[0].payload.by_profile, 'u1');
  assert.equal(hist[0].payload.note, 'Inputs agreed on the call');

  /* and the line in their history */
  const ev = seen('client_events','insert');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.area, 'stage');
  assert.equal(ev[0].payload.event, 'moved');
  assert.deepEqual(ev[0].payload.detail, {from:'won', to:'onboarding', note:'Inputs agreed on the call'});
});

test('a move that skips a stage is refused, in a plain sentence, and writes nothing', async () => {
  tables['clients.select'] = () => ({data:[client({stage:'won'})], error:null});

  const r = shape(await cbMoveStage('c1', 'live', 'they are ready'));
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
  assert.equal(r.error, 'Stone Roofing is at Won. Moving them to Live would skip Onboarding. Move them one stage at a time.');
  /* a plain sentence: no codes, no jargon, no stage keys */
  assert.ok(!/at_risk|[{}]|PGRST|undefined/.test(r.error));
  assert.deepEqual(writes(), [], 'nothing was written');

  /* two stages at once, and the far end */
  tables['clients.select'] = () => ({data:[client({stage:'enquiry'})], error:null});
  const far = await cbMoveStage('c1','onboarding');
  assert.equal(far.ok, false);
  assert.match(far.error, /would skip Call booked and Won\. Move them one stage at a time\.$/);
  assert.deepEqual(writes(), []);
});

test('going back one stage is fine; skipping backwards is not', async () => {
  tables['clients.select'] = () => ({data:[client({stage:'live'})], error:null});
  tables['clients.update'] = (c) => ({data:[{...client(), ...c.payload}], error:null});
  tables['client_stage_history.insert'] = (c) => ({data:[c.payload], error:null});
  tables['client_events.insert'] = (c) => ({data:[c.payload], error:null});

  assert.equal((await cbMoveStage('c1','onboarding','inputs were wrong')).ok, true, 'one step back');

  calls = [];
  const back = await cbMoveStage('c1','booked');
  assert.equal(back.ok, false);
  assert.match(back.error, /back to Call booked would skip Won and Onboarding/);
  assert.deepEqual(writes(), []);
});

test('cbMoveStage refuses a stage that does not exist, a stage they are already at, and no client', async () => {
  tables['clients.select'] = () => ({data:[client({stage:'live'})], error:null});

  const bad = await cbMoveStage('c1','sending');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^There is no stage called "sending"\./);
  assert.match(bad.error, /Enquiry, Call booked, Won, Onboarding, Live, At risk and Ended/);

  const same = await cbMoveStage('c1','live');
  assert.equal(same.ok, false);
  assert.equal(same.error, 'Stone Roofing is already at Live.');

  assert.match((await cbMoveStage('', 'live')).error, /Which client/);
  assert.deepEqual(writes(), []);

  tables['clients.select'] = () => ({data:[], error:null});
  assert.equal((await cbMoveStage('c1','live')).error, 'That client is not in the book.');
});

test('moving to Ended dates it and keeps the reason; moving back off Ended clears both', async () => {
  tables['clients.update'] = (c) => ({data:[{...client(), ...c.payload}], error:null});
  tables['client_stage_history.insert'] = (c) => ({data:[c.payload], error:null});
  tables['client_events.insert'] = (c) => ({data:[c.payload], error:null});

  tables['clients.select'] = () => ({data:[client({stage:'at_risk'})], error:null});
  assert.equal((await cbMoveStage('c1','ended','They sold the business')).ok, true);
  let p = seen('clients','update')[0].payload;
  assert.match(p.ended_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(p.end_reason, 'They sold the business');

  calls = [];
  tables['clients.select'] = () => ({data:[client({stage:'ended', ended_on:'2026-11-01'})], error:null});
  assert.equal((await cbMoveStage('c1','at_risk','they came back')).ok, true);
  p = seen('clients','update')[0].payload;
  assert.equal(p.ended_on, null);
  assert.equal(p.end_reason, null);
});

test('a move still counts when the trail cannot be written, and says so', async () => {
  tables['clients.select'] = () => ({data:[client({stage:'won'})], error:null});
  tables['clients.update'] = (c) => ({data:[{...client(), ...c.payload}], error:null});
  tables['client_stage_history.insert'] = () => ({data:null, error:{message:'history is full'}});
  tables['client_events.insert'] = () => ({data:null, error:{message:'nope'}});

  const r = await cbMoveStage('c1','onboarding');
  assert.equal(r.ok, true);
  assert.equal(r.data.history, null);
  assert.equal(r.data.warning, 'Moved to Onboarding, but the stage history and their history could not be written down.');
});

test('a database error on the move comes back as its own words, and nothing else is written', async () => {
  tables['clients.select'] = () => ({data:[client({stage:'won'})], error:null});
  tables['clients.update'] = () => ({data:null, error:{message:'Only approved staff can change a client.'}});
  const r = await cbMoveStage('c1','onboarding');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Only approved staff can change a client.');
  assert.equal(seen('client_stage_history','insert').length, 0);
});

/* ═════════════ 2. cbAddClient takes its price from plan_prices ═════════════ */

test('cbAddClient takes the fee and the promise from plan_prices — never from the form', async () => {
  tables['plan_prices.select'] = () => ({data:PLANS, error:null});
  tables['clients.insert'] = (c) => ({data:[{id:'new1', ...c.payload}], error:null});
  tables['client_stage_history.insert'] = (c) => ({data:[c.payload], error:null});
  tables['client_events.insert'] = (c) => ({data:[c.payload], error:null});

  const r = shape(await cbAddClient({
    company:'Harbor Co', contactName:'Pat Lee', contactEmail:'pat@harbor.test',
    plan:'growth', term:'monthly',
    /* a price pushed in by hand must be ignored */
    monthly_fee: 99999, monthlyFee: 99999, calls_promised: 1,
  }));
  assert.equal(r.ok, true);
  const p = seen('clients','insert')[0].payload;
  assert.equal(p.monthly_fee, 3000, 'Growth monthly, straight from plan_prices');
  assert.equal(p.calls_promised, 10);
  assert.equal(p.plan, 'growth');
  assert.equal(p.term, 'monthly');
  assert.equal(p.stage, 'won', 'a new client starts at Won');
  /* nothing from the form leaked into the money */
  assert.ok(!JSON.stringify(p).includes('99999'));

  /* the 3-month term takes the 3-month price from the same row */
  calls = [];
  await cbAddClient({company:'Harbor Co', contactName:'Pat Lee', contactEmail:'pat@harbor.test', plan:'growth', term:'3month'});
  assert.equal(seen('clients','insert')[0].payload.monthly_fee, 2400);
  assert.equal(seen('clients','insert')[0].payload.term, '3month');

  /* a plan with no 3-month price falls back to its monthly one */
  calls = [];
  await cbAddClient({company:'Solo', contactName:'A B', contactEmail:'a@b.test', plan:'pilot', term:'3month'});
  assert.equal(seen('clients','insert')[0].payload.monthly_fee, 300);
  assert.equal(seen('clients','insert')[0].payload.calls_promised, 2);

  /* every plan prices itself */
  for (const plan of PLANS) {
    calls = [];
    await cbAddClient({company:'X', contactName:'A B', contactEmail:'a@b.test', plan:plan.plan, term:'monthly'});
    assert.equal(seen('clients','insert')[0].payload.monthly_fee, plan.monthly_fee, plan.plan);
  }
});

test('cbAddClient writes the first stage line and a line in their history', async () => {
  tables['plan_prices.select'] = () => ({data:PLANS, error:null});
  tables['clients.insert'] = (c) => ({data:[{id:'new1', ...c.payload}], error:null});
  tables['client_stage_history.insert'] = (c) => ({data:[c.payload], error:null});
  tables['client_events.insert'] = (c) => ({data:[c.payload], error:null});

  await cbAddClient({company:'Harbor Co', contactName:'Pat Lee', contactEmail:'pat@harbor.test', plan:'starter'});
  const h = seen('client_stage_history','insert')[0].payload;
  assert.equal(h.client_id, 'new1');
  assert.equal(h.from_stage, null);
  assert.equal(h.to_stage, 'won');
  const ev = seen('client_events','insert')[0].payload;
  assert.equal(ev.area, 'client');
  assert.equal(ev.event, 'added');
  assert.equal(ev.detail.monthly_fee, 1500);
  assert.equal(ev.detail.from_booking, null);
});

test('cbAddClient can start from a discovery_bookings row and fill the gaps', async () => {
  tables['plan_prices.select'] = () => ({data:PLANS, error:null});
  tables['discovery_bookings.select'] = () => ({data:[{id:'b9', company:'Ridgeline IT', name:'Dana Whitfield', email:'dana@ridgeline.test', website:'ridgeline.test'}], error:null});
  tables['clients.insert'] = (c) => ({data:[{id:'new2', ...c.payload}], error:null});
  tables['client_stage_history.insert'] = (c) => ({data:[c.payload], error:null});
  tables['client_events.insert'] = (c) => ({data:[c.payload], error:null});

  const r = await cbAddClient({bookingId:'b9', plan:'scale'});
  assert.equal(r.ok, true);
  const p = seen('clients','insert')[0].payload;
  assert.equal(p.company, 'Ridgeline IT');
  assert.equal(p.contact_name, 'Dana Whitfield');
  assert.equal(p.contact_email, 'dana@ridgeline.test');
  assert.equal(p.website, 'ridgeline.test');
  assert.equal(p.booking_id, 'b9');
  assert.equal(p.monthly_fee, 4500, 'still priced from plan_prices');
  assert.equal(seen('client_stage_history','insert')[0].payload.note, 'Added from their discovery call.');

  /* a booking that is gone */
  tables['discovery_bookings.select'] = () => ({data:[], error:null});
  assert.equal((await cbAddClient({bookingId:'gone', plan:'scale'})).error, 'That booking is not there any more.');
});

test('cbAddClient asks plainly for what is missing, and never guesses a price', async () => {
  tables['plan_prices.select'] = () => ({data:PLANS, error:null});
  assert.equal((await cbAddClient({})).error, 'A client needs a company name.');
  assert.equal((await cbAddClient({company:'X'})).error, 'A client needs someone to talk to — add their name.');
  assert.equal((await cbAddClient({company:'X', contactName:'A B'})).error, 'That email address does not look right.');
  assert.equal((await cbAddClient({company:'X', contactName:'A B', contactEmail:'nope@'})).error, 'That email address does not look right.');

  const noPlan = await cbAddClient({company:'X', contactName:'A B', contactEmail:'a@b.test'});
  assert.equal(noPlan.ok, false);
  assert.equal(noPlan.error, 'Pick a plan: Pilot, Starter, Growth and Scale.');
  assert.equal(seen('clients','insert').length, 0, 'no client without a price');

  /* no plans at all: say so rather than invent a number */
  tables['plan_prices.select'] = () => ({data:[], error:null});
  const none = await cbAddClient({company:'X', contactName:'A B', contactEmail:'a@b.test', plan:'growth'});
  assert.equal(none.error, 'There are no plans set up yet, so there is no price to put on this client.');
  assert.equal(seen('clients','insert').length, 0);

  /* and if plan_prices itself will not read, nothing is written */
  tables['plan_prices.select'] = () => ({data:null, error:{message:'plan_prices is unreachable.'}});
  assert.equal((await cbAddClient({company:'X', contactName:'A B', contactEmail:'a@b.test', plan:'growth'})).error, 'plan_prices is unreachable.');
  assert.equal(seen('clients','insert').length, 0);
});

/* ═════════════ 3. cbEvent writes one row ═════════════ */

test('cbEvent writes exactly one client_events row', async () => {
  tables['client_events.insert'] = (c) => ({data:[{id:1, at:'2026-11-22T10:00:00Z', ...c.payload}], error:null});

  const r = shape(await cbEvent('c1', 'meeting', 'held', {meetingId:'m7', minutes:30}));
  assert.equal(r.ok, true);
  const ins = seen('client_events','insert');
  assert.equal(ins.length, 1, 'one row, once');
  assert.deepEqual(ins[0].payload, {client_id:'c1', area:'meeting', event:'held', detail:{meetingId:'m7', minutes:30}});
  assert.equal(calls.length, 1, 'and it reads nothing first');
});

test('cbEvent never leaves detail null, whatever it is given', async () => {
  tables['client_events.insert'] = (c) => ({data:[c.payload], error:null});
  const detail = async (d) => { calls = []; await cbEvent('c1','x','y',d); return seen('client_events','insert')[0].payload.detail };
  assert.deepEqual(await detail(undefined), {});
  assert.deepEqual(await detail(null), {});
  assert.deepEqual(await detail(''), {});
  assert.deepEqual(await detail('a note'), {note:'a note'});
  assert.deepEqual(await detail(['a']), {note:'a'});
  assert.deepEqual(await detail({a:1}), {a:1});
});

test('cbEvent says what is missing and writes nothing', async () => {
  tables['client_events.insert'] = (c) => ({data:[c.payload], error:null});
  assert.match((await cbEvent('', 'a', 'b')).error, /Which client/);
  assert.equal((await cbEvent('c1','','b')).error, 'An event needs to say which part of the hub it came from.');
  assert.equal((await cbEvent('c1','a','')).error, 'An event needs a name.');
  assert.deepEqual(writes(), []);
  /* a database error comes back whole, and never throws */
  tables['client_events.insert'] = () => { throw new Error('the table is gone') };
  const r = await cbEvent('c1','a','b');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'the table is gone');
});

/* ═════════════ 4. the screens, with zero rows ═════════════ */

test('viewClients renders with zero rows and offers the one thing to do', async () => {
  tables['clients.select'] = () => ({data:[], error:null});
  await cbLoadAll(true);
  const h = viewClients();
  assert.ok(h && typeof h === 'string');
  assert.match(text(h), /No clients yet/);
  assert.match(text(h), /the journey starts at Won/);
  assert.match(h, /onclick="cbOpenAdd\(\)"/);
  /* nothing broken, no stray undefined / NaN anywhere */
  assert.ok(!/undefined|NaN|\[object/.test(h), h.slice(0,400));
});

test('viewClient renders with zero rows: no months, no inputs, no history', async () => {
  tables['clients.select'] = () => ({data:[client()], error:null});
  tables['client_profiles.select'] = () => ({data:[], error:null});
  tables['v_month_standing.select'] = () => ({data:[], error:null});
  tables['client_events.select'] = () => ({data:[], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});

  await cbLoadOne('c1', true);
  cbOpenId = 'c1';
  const h = viewClient();
  assert.ok(!/undefined|NaN|\[object/.test(h), 'nothing missing shows as a hole');
  const t = text(h);
  assert.match(t, /Stone Roofing/);
  assert.match(t, /No month has opened yet/);
  assert.match(t, /Nothing has happened yet/);
  assert.match(t, /Nothing yet\./, 'their ICP and inputs');
  assert.match(t, /Where are they\?/, 'the stage mover is there');
  /* one stage either way from Live, and no way to skip */
  assert.match(h, /onclick="cbDoMove\(&quot;c1&quot;,&quot;at_risk&quot;\)"/);
  assert.match(h, /onclick="cbDoMove\(&quot;c1&quot;,&quot;onboarding&quot;\)"/);
  assert.ok(!/cbDoMove\(&quot;c1&quot;,&quot;ended&quot;\)/.test(h), 'Ended is two stages away');

  /* the anchors other screens will hang off, and nothing written for them */
  for (const id of ['cbMeetings','cbOutreach','cbInvoices','cbPeople','cbHandover']) {
    assert.ok(h.includes('id="' + id + '"'), id + ' anchor');
    assert.ok(h.includes('<section class="card cb-slot" id="' + id + '" data-cb-client="c1"></section>'), id + ' is left empty');
  }
});

test('viewClient on a client that is not there says so instead of breaking', async () => {
  tables['clients.select'] = () => ({data:[], error:null});
  tables['client_profiles.select'] = () => ({data:[], error:null});
  tables['v_month_standing.select'] = () => ({data:[], error:null});
  tables['client_events.select'] = () => ({data:[], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});
  await cbLoadOne('ghost', true);
  cbOpenId = 'ghost';
  assert.match(text(viewClient()), /That client is not here/);
  cbOpenId = null;
  assert.match(text(viewClient()), /No client chosen/);
});

test('viewNeedsYou renders with zero rows', async () => {
  tables['clients.select'] = () => ({data:[], error:null});
  await cbLoadAll(true);
  assert.match(text(viewNeedsYou()), /Nothing to do/);
});

test('every screen escapes what a client typed', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  tables['clients.select'] = () => ({data:[client({company:nasty, contact_name:nasty, notes:nasty})], error:null});
  tables['client_profiles.select'] = () => ({data:[], error:null});
  tables['v_month_standing.select'] = () => ({data:[month({calls_delivered:0})], error:null});
  tables['client_events.select'] = () => ({data:[], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});
  await cbLoadAll(true);
  await cbLoadOne('c1', true);
  cbOpenId = 'c1';
  for (const h of [viewClients(), viewNeedsYou(), viewClient()]) {
    assert.ok(!h.includes('<img'), 'no raw tag got through');
    assert.ok(h.includes('&lt;img'), 'it is shown as words');
  }
});

test('the screens are pure view functions: given an id they draw, and never navigate', async () => {
  tables['clients.select'] = () => ({data:[client()], error:null});
  tables['client_profiles.select'] = () => ({data:[], error:null});
  tables['v_month_standing.select'] = () => ({data:[], error:null});
  tables['client_events.select'] = () => ({data:[], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});
  await cbLoadOne('c1', true);

  /* the shell calls viewClient(currentClientId) as a view fn. It must draw that
     client and call nothing back, or the view would draw itself for ever. */
  const rendered = [];
  globalThis.render = (v) => { rendered.push(v) };
  globalThis.views = {clients:{}, client:{}, needsYou:{}};
  try {
    cbOpenId = null;
    const h = viewClient('c1');
    assert.match(text(h), /Stone Roofing/, 'it drew the client it was handed');
    assert.deepEqual(rendered, [], 'and navigated nowhere');
    /* the shell may also hand it nothing but currentClientId */
    cbOpenId = null;
    globalThis.currentClientId = 'c1';
    assert.match(text(viewClient()), /Stone Roofing/);
    assert.deepEqual(rendered, []);
    /* and the lists do not navigate when they are merely drawn */
    await cbLoadAll(true);
    viewClients(); viewNeedsYou();
    assert.deepEqual(rendered, []);
  } finally {
    delete globalThis.render; delete globalThis.views; delete globalThis.currentClientId;
  }
});

test('a row opens its client through the shell, not by drawing a view', async () => {
  tables['clients.select'] = () => ({data:[client()], error:null});
  tables['v_month_standing.select'] = () => ({data:[], error:null});
  tables['client_profiles.select'] = () => ({data:[], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});
  await cbLoadAll(true);

  const h = viewClients();
  assert.match(h, /onclick="cbGo\(&quot;c1&quot;\)"/, 'rows go through cbGo');
  assert.ok(!/onclick="viewClient\(/.test(h), 'a row never calls a view function');

  /* cbGo hands the id to the shell when the shell is there */
  const opened = [];
  globalThis.openClient = (id) => { opened.push(id) };
  try { cbGo('c1'); assert.deepEqual(opened, ['c1']); assert.equal(cbOpenId, 'c1'); }
  finally { delete globalThis.openClient }

  /* and on its own it remembers the id and asks for the page */
  const rendered = [];
  globalThis.render = (v) => { rendered.push(v) };
  try { cbGo('c2'); assert.equal(cbOpenId, 'c2'); assert.deepEqual(rendered, ['client']); }
  finally { delete globalThis.render }
});

/* ═════════════ 5. viewNeedsYou picks up a short month ═════════════ */

test('viewNeedsYou picks up a month running short, with the shortfall and the money', async () => {
  tables['clients.select'] = () => ({data:[client()], error:null});
  tables['v_month_standing.select'] = () => ({data:[month()], error:null});  // 4 of 10, 6 days left
  tables['client_profiles.select'] = () => ({data:[{client_id:'c1', signed_off_at:'2026-10-01T00:00:00Z'}], error:null});
  tables['client_stage_history.select'] = () => ({data:[{client_id:'c1', to_stage:'live', at:'2026-11-01T10:00:00Z'}], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[{id:'u1', name:'Nimal Perera'}], error:null});

  await cbLoadAll(true);
  const t = text(viewNeedsYou());
  assert.match(t, /1 thing needs a person, across 1 client/);
  assert.match(t, /Stone Roofing/);
  assert.match(t, /Month 2 is 6 calls short with 6 days left/);
  assert.match(t, /\$3,000 at stake/, 'month two is one month of the fee');

  /* the same client shows up on the main screen, marked and sorted to the front */
  const h = viewClients();
  assert.match(h, /class="cb-row urgent"/);
  assert.match(text(h), /Need a person 1/);
  assert.match(text(h), /At stake \$3,000/);
  assert.match(text(h), /4 of 10/);
  assert.match(text(h), /6 calls short/);
  assert.match(text(h), /6 days left/);
  assert.match(text(h), /Nimal Perera/, 'who looks after them');
});

test('month one at stake is double the fee; a month on track is nothing at stake', () => {
  const c = client();
  assert.equal(cbStake(c, month({month_no:1, calls_delivered:4})), 6000, 'month one: double');
  assert.equal(cbStake(c, month({month_no:2, calls_delivered:4})), 3000, 'later: that month');
  assert.equal(cbStake(c, month({calls_delivered:10})), 0, 'promise met');
  assert.equal(cbStake(c, month({calls_delivered:12})), 0, 'over the promise');
  assert.equal(cbStake(c, null), 0, 'no month open');
  /* a settled month carries its own refund, and the view's own number always wins */
  assert.equal(cbStake(c, month({verdict:'missed', refund_due:6000})), 6000);
  assert.equal(cbStake(c, month({verdict:'hit', calls_delivered:10, refund_due:0})), 0);
  assert.equal(cbStake(c, month({at_risk:1234})), 1234);
});

test('a month only shouts when it is both short and nearly over', () => {
  assert.equal(cbMonthWarns(month({days_left:6, calls_delivered:4})), true);
  assert.equal(cbMonthWarns(month({days_left:25, calls_delivered:4})), false, 'plenty of time');
  assert.equal(cbMonthWarns(month({days_left:2, calls_delivered:10})), false, 'promise already met');
  assert.equal(cbMonthWarns(month({days_left:2, verdict:'missed'})), false, 'settled, finance owns it');
  assert.equal(cbMonthWarns(month({days_left:25, calls_delivered:4, warn_now:true})), true, 'the view may say so itself');
  assert.equal(cbMonthWarns(null), false);
});

test('viewNeedsYou picks up inputs not signed off, a stage sitting too long and an unanswered request', async () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  tables['clients.select'] = () => ({data:[
    client({id:'a', company:'A Co', stage:'onboarding'}),
    client({id:'b', company:'B Co', stage:'live'}),
  ], error:null});
  tables['v_month_standing.select'] = () => ({data:[], error:null});
  tables['client_profiles.select'] = () => ({data:[{client_id:'b', signed_off_at:'2026-01-01T00:00:00Z'}], error:null});
  /* A Co moved into Onboarding 40 days ago — 14 is the usual */
  tables['client_stage_history.select'] = () => ({data:[
    {client_id:'a', to_stage:'onboarding', at:'2026-10-13T10:00:00Z'},
    {client_id:'b', to_stage:'live', at:'2026-11-20T10:00:00Z'},
  ], error:null});
  tables['client_requests.select'] = () => ({data:[{id:'r1', client_id:'b', subject:'Can we change the ICP?', status:'open'}], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});

  await cbLoadAll(true);
  const rows = cbRows(cb.clients, {standing:cb.standing, owners:cb.owners, history:cb.history, requests:cb.requests, profiles:cb.profiles, now});
  const a = rows.find(r => r.id === 'a'), b = rows.find(r => r.id === 'b');

  assert.deepEqual(a.flags.map(f => f.code), ['inputs','stuck']);
  assert.match(a.flags[0].text, /no ICP or inputs yet/);
  assert.match(a.flags[1].text, /Sitting at Onboarding for 40 days — 14 days is the usual\./);
  assert.deepEqual(b.flags.map(f => f.code), ['request']);
  assert.match(b.flags[0].text, /An unanswered request: Can we change the ICP\?\./);

  /* the one request filter the portal cares about */
  const req = seen('client_requests','select')[0];
  assert.deepEqual(req.filters, [['in','status',['open','in_progress']]]);

  const t = text(cbRenderNeeds(rows));
  assert.match(t, /3 things need a person, across 2 clients/);
  /* Live has no sitting limit — nobody is ever "stuck" at Live */
  assert.equal(cbStageLimit('live'), 0);
});

test('a client with nothing wrong is not on the needs list, and says so on their page', async () => {
  tables['clients.select'] = () => ({data:[client()], error:null});
  tables['v_month_standing.select'] = () => ({data:[month({calls_delivered:10})], error:null});
  tables['client_profiles.select'] = () => ({data:[{client_id:'c1', signed_off_at:'2026-10-01T00:00:00Z'}], error:null});
  tables['client_stage_history.select'] = () => ({data:[{client_id:'c1', to_stage:'live', at:new Date().toISOString()}], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});

  await cbLoadAll(true);
  const rows = cbRows(cb.clients, {standing:cb.standing, owners:cb.owners, history:cb.history, requests:cb.requests, profiles:cb.profiles});
  assert.equal(rows[0].needs, 0);
  assert.match(text(cbRenderNeeds(rows)), /Nothing is behind/);
  assert.match(text(cbRenderFlags(rows[0])), /Nothing here needs you today/);
});

test('a load that lands redraws whichever of the three screens is open — and nothing else', async () => {
  tables['clients.select'] = () => ({data:[client()], error:null});
  tables['v_month_standing.select'] = () => ({data:[], error:null});
  tables['client_profiles.select'] = () => ({data:[], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});

  assert.deepEqual(CB_VIEWS, ['clients','client','needsYou'], 'the shell names these three');
  const rendered = [];
  globalThis.render = (v) => { rendered.push(v) };
  try {
    for (const v of CB_VIEWS) {
      rendered.length = 0;
      globalThis.currentView = v;
      cbPaint();
      assert.deepEqual(rendered, [v], v + ' is redrawn');
    }
    /* somebody else's screen is left alone */
    rendered.length = 0;
    globalThis.currentView = 'outreach';
    cbPaint();
    assert.deepEqual(rendered, []);
  } finally { delete globalThis.render; delete globalThis.currentView }
});

/* ═════════════ 6. the list, grouped by stage ═════════════ */

test('the main screen groups by stage in journey order, trouble first inside each group', async () => {
  tables['clients.select'] = () => ({data:[
    client({id:'1', company:'Zed Live Fine',  stage:'live'}),
    client({id:'2', company:'Acme Live Short', stage:'live'}),
    client({id:'3', company:'Won Co',          stage:'won'}),
    client({id:'4', company:'Old Co',          stage:'ended'}),
    client({id:'5', company:'Legacy Co',       stage:'sending'}),
  ], error:null});
  tables['v_month_standing.select'] = () => ({data:[month({client_id:'2'})], error:null});
  tables['client_profiles.select'] = () => ({data:[
    {client_id:'1', signed_off_at:'2026-01-01T00:00:00Z'}, {client_id:'2', signed_off_at:'2026-01-01T00:00:00Z'},
  ], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});
  await cbLoadAll(true);
  const rows = cbRows(cb.clients, {standing:cb.standing, owners:cb.owners, history:cb.history, requests:cb.requests, profiles:cb.profiles});

  const g = cbGroups(rows);
  assert.deepEqual(g.map(x => x.label), ['Won','Live','Ended','Stage not set'], 'journey order, empty stages left out');
  assert.deepEqual(g.find(x => x.key === 'live').rows.map(r => r.company), ['Acme Live Short','Zed Live Fine'], 'the short month first');

  const h = viewClients();
  assert.ok(text(h).indexOf('Won Co') < text(h).indexOf('Zed Live Fine'), 'Won before Live');
  assert.match(text(h), /Clients 5/);
  assert.match(text(h), /Stage not set 1/, 'an unknown stage is still shown');
});

test('the main screen says when only part of it could be read, and still draws', async () => {
  tables['clients.select'] = () => ({data:[client()], error:null});
  tables['v_month_standing.select'] = () => ({data:null, error:{message:'the view is gone'}});
  tables['client_profiles.select'] = () => ({data:[], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:null, error:{message:'nope'}});
  tables['profiles.select'] = () => ({data:[], error:null});
  await cbLoadAll(true);
  const t = text(viewClients());
  assert.match(t, /Showing the clients, but their months and their requests could not be read just now\./);
  assert.match(t, /Stone Roofing/, 'the list is still there');
});

test('when the clients themselves will not read, the screen says so in plain words', async () => {
  tables['clients.select'] = () => ({data:null, error:{message:'You are not approved yet.'}});
  const r = await cbLoadAll(true);
  assert.equal(r.ok, false);
  assert.match(text(viewClients()), /You are not approved yet\./);
});

/* ═════════════ 7. the buttons ═════════════ */

test('cbDoMove shows the refusal where the person is looking and leaves the page alone', async () => {
  tables['clients.select'] = () => ({data:[client({stage:'won'})], error:null});
  fields.cbMoveNote = 'they are ready';
  const r = await cbDoMove('c1','live');
  assert.equal(r.ok, false);
  assert.match(fields['err:cbMoveErr'], /would skip Onboarding/);
  assert.deepEqual(toasts, [], 'nothing is announced that did not happen');
  assert.deepEqual(writes(), []);
});

test('cbDoMove passes the note along and toasts the move', async () => {
  tables['clients.select'] = () => ({data:[client({stage:'won'})], error:null});
  tables['clients.update'] = (c) => ({data:[{...client(), ...c.payload}], error:null});
  tables['client_stage_history.insert'] = (c) => ({data:[c.payload], error:null});
  tables['client_events.insert'] = (c) => ({data:[c.payload], error:null});
  tables['client_profiles.select'] = () => ({data:[], error:null});
  tables['v_month_standing.select'] = () => ({data:[], error:null});
  tables['client_events.select'] = () => ({data:[], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});

  fields.cbMoveNote = 'Inputs agreed on the call';
  const r = await cbDoMove('c1','onboarding');
  assert.equal(r.ok, true);
  assert.equal(seen('client_stage_history','insert')[0].payload.note, 'Inputs agreed on the call');
  assert.deepEqual(toasts, ['Moved to Onboarding']);
});

test('the add form offers the real plans and their real prices, and saves what was typed', async () => {
  tables['plan_prices.select'] = () => ({data:PLANS, error:null});
  tables['clients.insert'] = (c) => ({data:[{id:'new3', ...c.payload}], error:null});
  tables['client_stage_history.insert'] = (c) => ({data:[c.payload], error:null});
  tables['client_events.insert'] = (c) => ({data:[c.payload], error:null});
  tables['clients.select'] = () => ({data:[], error:null});
  tables['v_month_standing.select'] = () => ({data:[], error:null});
  tables['client_profiles.select'] = () => ({data:[], error:null});
  tables['client_stage_history.select'] = () => ({data:[], error:null});
  tables['client_requests.select'] = () => ({data:[], error:null});
  tables['profiles.select'] = () => ({data:[], error:null});

  const form = await cbOpenAdd();
  assert.match(text(form), /Growth — 10 calls, \$3,000 a month/);
  assert.match(text(form), /Pilot — 2 calls, \$300 a month/);
  assert.ok(!/99|hard/.test(form.replace(/\$[\d,]+/g,'')), 'no price typed into the markup');

  Object.assign(fields, {cbAddCo:'Harbor Co', cbAddName:'Pat Lee', cbAddEmail:'pat@harbor.test', cbAddSite:'harbor.test', cbAddPlan:'growth', cbAddTerm:'3month'});
  const r = await cbSaveAdd();
  assert.equal(r.ok, true);
  const p = seen('clients','insert')[0].payload;
  assert.equal(p.company, 'Harbor Co');
  assert.equal(p.monthly_fee, 2400);
  assert.equal(fields.modal, null, 'the form closed');
  assert.deepEqual(toasts, ['Harbor Co is in the book']);

  /* a refusal stays on the form */
  toasts.length = 0; fields.cbAddEmail = 'nope';
  assert.equal((await cbSaveAdd()).ok, false);
  assert.match(fields['err:cbAddErr'], /email address does not look right/);
  assert.deepEqual(toasts, []);
});

/* ═════════════ 8. the plumbing, and the history in words ═════════════ */

test('every data function answers {ok,data,error} and never throws', async () => {
  const boom = () => { throw new Error('the database fell over') };
  ['clients.select','client_events.insert','client_events.select','plan_prices.select','v_month_standing.select','client_profiles.select','client_stage_history.select','v_exposure.select','profiles.select','client_requests.select']
    .forEach(k => { tables[k] = boom });
  for (const fn of [
    () => cbClients(), () => cbClient('c1'), () => cbProfile('c1'), () => cbStageHistory('c1'),
    () => cbEvents('c1'), () => cbStanding({}), () => cbExposure(), () => cbPlans(),
    () => cbOwners(), () => cbOpenRequests('c1'), () => cbEvent('c1','a','b'),
    () => cbMoveStage('c1','live'), () => cbAddClient({company:'X', contactName:'A B', contactEmail:'a@b.test', plan:'growth'}),
  ]) {
    const r = shape(await fn());
    assert.equal(r.ok, false);
    assert.ok(r.error && !/\[object|undefined/.test(r.error), r.error);
  }
  /* and an empty read is empty, not an error */
  tables['clients.select'] = () => ({data:null, error:null});
  const empty = await cbClients();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.data, []);
});

test('the history reads as dated sentences, whoever wrote the line', () => {
  assert.equal(cbEventWords({area:'stage', event:'moved', detail:{from:'won', to:'onboarding', note:'Inputs agreed'}}),
    'Moved from Won to Onboarding — Inputs agreed');
  assert.equal(cbEventWords({area:'stage', event:'moved', detail:{to:'won'}}), 'Moved to Won');
  assert.equal(cbEventWords({area:'client', event:'added', detail:{plan:'growth'}}), 'Added as a client on the growth plan.');
  /* another module's line: its own words when it gave any */
  assert.equal(cbEventWords({area:'invoice', event:'sent', detail:{words:'Invoice AV-2026-11 sent for $3,000.'}}), 'Invoice AV-2026-11 sent for $3,000.');
  assert.equal(cbEventWords({area:'meeting', event:'no_show', detail:{note:'Sam did not join'}}), 'no show — Sam did not join');
  assert.equal(cbEventWords({area:'outreach', event:'campaign_started', detail:{}}), 'campaign started');
  const h = cbRenderHistory([{at:'2026-11-20T10:00:00Z', area:'stage', event:'moved', detail:{to:'live'}}]);
  assert.match(text(h), /20 Nov stage Moved to Live/);
});

test('the small words a person reads', () => {
  assert.equal(cbUsd(3000), '$3,000');
  assert.equal(cbUsd(null), '$0');
  assert.equal(cbDays(1), '1 day');
  assert.equal(cbDays(6), '6 days');
  assert.equal(cbDays(0), 'today');
  assert.equal(cbList(['Won']), 'Won');
  assert.equal(cbList(['Won','Onboarding']), 'Won and Onboarding');
  assert.equal(cbList(['A','B','C']), 'A, B and C');
  assert.equal(cbDate('2026-11-20'), '20 Nov');
  assert.equal(cbDate(null), '—');
  assert.equal(cbDate('not a date'), '—');
  assert.equal(cbStageLabel('at_risk'), 'At risk');
  assert.equal(cbStageLabel('sending'), 'sending', 'an unknown stage still reads as something');
  assert.equal(cbPossessive('Stone Roofing'), "Stone Roofing's");
  assert.equal(cbPossessive('Jones'), "Jones'");
});
