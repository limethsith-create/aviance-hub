/* The commitment board (guarantee.js) and the pace sum under it (corePace in
   core.js) — the one screen that looks across the whole book and answers "can I
   deliver what I have already sold, and what is about to go wrong?"
 *
 * Three things are pinned here, and they are the three ways this screen could
 * lie to the owner at two in the morning.
 *
 * 1. IT NEVER STATES A FIGURE IT DOES NOT HAVE. A source that did not answer
 *    is a dash with a sentence, not a zero. A total built from rows where one
 *    row is missing its money says it is partial, out loud, rather than quietly
 *    coming out lower — which is the owner's own named failure mode, applied to
 *    the number he would trust most.
 * 2. IT KEEPS THE THREE KINDS OF OPEN MONTH APART. Running, ended-and-never-
 *    closed, and bought-but-not-started are three different problems with three
 *    different answers, and v_exposure adds all three into one figure. The
 *    headline is the running ones, because they are the only money a decision
 *    today can still move.
 * 3. IT CANNOT CONTRADICT THE CLIENT'S OWN PORTAL. Both read corePace. The
 *    relationship is asserted as a one-way invariant over a sweep of months:
 *    the owner is never more optimistic than the client. The other way round is
 *    fine and deliberate — the person who can act is warned first.
 *
 * Run with:  node --test tests/commitment.test.mjs   (or npm test)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
globalThis.window = globalThis;
globalThis.sb = { from(){ throw new Error('this file must not open its own path to the database') } };
for (const f of ['core.js', 'guarantee.js']) vm.runInThisContext(read(f), { filename: f });

/* portal-tracker.js, loaded the way portal.html loads it, so the client's own
   standing line can be compared with the owner's board row by row. */
const trackerCtx = (() => {
  const nodes = {};
  const mk = (id) => ({ id, innerHTML: '', get firstChild(){ return this.innerHTML ? {} : null }, querySelector(){ return null } });
  const boxes = { pcTracker: mk('pcTracker'), pcStanding: mk('pcStanding'), pcCampaign: mk('pcCampaign'), pcCalls: mk('pcCalls') };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Intl, Date, Math, JSON, Number, String, Object, Array, RegExp, isNaN, parseInt, parseFloat, Infinity, NaN,
    document: { head: { appendChild(n){ nodes[n.id] = n } }, getElementById(id){ return boxes[id] || nodes[id] || null }, createElement(){ return {} } },
  });
  ctx.window = ctx;
  for (const f of ['core.js', 'portal-client.js', 'portal-tracker.js']) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
})();
const portalNorm = (row, now) => vm.runInContext('pctMonthNorm', trackerCtx)(row, null, now);

const NOW = new Date(2026, 10, 26, 12, 0, 0);     /* Thu 26 Nov 2026, local */
const text = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/* one v_month_standing row, with the view's own column names */
let seq = 0;
function month(o = {}) {
  seq++;
  const promised = o.calls_promised === undefined ? 10 : o.calls_promised;
  const delivered = o.calls_delivered === undefined ? 0 : o.calls_delivered;
  return {
    month_id: 'm' + seq, client_id: o.client_id || ('c' + seq),
    company: o.company || ('Co ' + seq), plan: o.plan || 'growth',
    month_no: o.month_no === undefined ? 1 : o.month_no,
    starts_on: o.starts_on || '2026-11-12', ends_on: o.ends_on || '2026-12-11',
    calls_promised: promised, calls_delivered: delivered,
    calls_short: Math.max(0, promised - delivered),
    days_left: o.days_left === undefined ? 15 : o.days_left,
    verdict: o.verdict || 'open', locked_at: o.locked_at || null,
    at_risk: o.at_risk === undefined ? 6000 : o.at_risk,
    warn_now: !!o.warn_now, ...o,
  };
}
const ok = (rows) => ({ ok: true, data: rows, error: '' });
const fail = (msg) => ({ ok: false, data: null, error: msg });
const expo = (o) => ok({ open_months: 22, at_risk_total: 69300, at_risk_month_one: 40800, ...(o || {}) });

/* ═════════════════ 1. the pace sum ═════════════════ */

test('the arithmetic the owner is paying for: the same gap is not the same trouble', () => {
  /* The owner's own example. A Growth client (10 calls, 30-day month) at 2 of 10:
     with six days to go it needs eight calls in seven days, nearly three and a
     half times the pace the whole month was sold at — there is no version of the
     next week that finishes on the number. */
  const late = corePace(10, 2, 24, 30, 6);
  assert.equal(late.band, 'gone');
  assert.equal(late.savable, false);
  assert.ok(late.ratio > 3, 'needs more than three times the sold pace, got ' + late.ratio);

  /* The same 2 of 10 on day ten is eight calls in twenty-one days — a sixth
     more than the sold pace. That is a week's work, not a lost month. */
  const early = corePace(10, 2, 10, 30, 20);
  assert.equal(early.band, 'behind');
  assert.equal(early.savable, true);
});

test('nothing delivered on the first morning is not a crisis', () => {
  const d1 = corePace(15, 0, 1, 30, 29);
  assert.equal(d1.band, 'ontrack');
  /* and it does not become one until two thirds of the month has gone with
     nothing in it */
  assert.equal(corePace(15, 0, 15, 30, 15).band, 'atrisk');
  assert.equal(corePace(15, 0, 20, 30, 10).band, 'gone');
});

test('today still counts: the last day is a day a call can land on', () => {
  /* left 0 means today IS the last day, which is how recount_month counts
     (between starts_on and ends_on, inclusive). One day out here settles a
     month on the wrong number. */
  const p = corePace(10, 9, 30, 30, 0);
  assert.equal(p.remaining, 1);
  assert.equal(p.perDayNeed, 1);
});

test('met, and nothing promised, are not the same as behind', () => {
  assert.equal(corePace(10, 10, 15, 30, 15).band, 'met');
  assert.equal(corePace(10, 14, 15, 30, 15).band, 'met');
  assert.equal(corePace(0, 0, 15, 30, 15).band, 'none');
});

test('garbage in gives numbers out, never NaN on a screen', () => {
  for (const args of [[], [null, null, null, null, null], ['x', 'y', 'z', 'w', 'v'],
                      [undefined, NaN, Infinity, -5, -5], [10, 3, 0, 0, 0]]) {
    const p = corePace(...args);
    for (const k of ['target', 'done', 'gap', 'total', 'elapsed', 'remaining', 'expected',
                     'perDayTarget', 'perDayNeed', 'perDayDone', 'ratio']) {
      assert.ok(!Number.isNaN(p[k]), k + ' came out NaN for ' + JSON.stringify(args));
    }
    assert.ok(typeof p.band === 'string' && p.band.length, 'no band for ' + JSON.stringify(args));
  }
});

test('a rate reads as a rate, and an impossible one reads as words', () => {
  assert.equal(coreRate(1.5), '1.5');
  assert.equal(coreRate(2), '2');
  assert.equal(coreRate(0.26), '0.3');
  assert.equal(coreRate(Infinity, 'out of nothing'), 'out of nothing');
  assert.equal(coreRate('nonsense', 'unknown'), 'unknown');
});

/* ═════════════════ 2. the owner never sees past the client ═════════════════ */

test('the owner is warned no later than the client: band ontrack implies on the line', () => {
  /* The invariant that makes one screen true. Swept over every shape of month
     this business can sell, every day of a 28 to 31 day month, and every count
     from nothing to over the number. If this ever fails, the owner's board is
     calm about a month the client has already been told they are behind on —
     which is worse than having no board at all. */
  let checked = 0;
  for (const target of [5, 10, 15]) {
    for (const total of [28, 29, 30, 31]) {
      for (let elapsed = 1; elapsed <= total; elapsed++) {
        for (let done = 0; done <= target; done++) {
          const p = corePace(target, done, elapsed, total, total - elapsed);
          checked++;
          if (p.band === 'ontrack') assert.ok(p.onLine,
            'board says on course while the client is told behind: ' + done + ' of ' + target + ' on day ' + elapsed + ' of ' + total);
        }
      }
    }
  }
  assert.ok(checked > 3000, 'swept ' + checked + ' months');
});

test("the client's own standing line and the owner's board read the same sum", () => {
  /* portal-tracker.js and guarantee.js both go through corePace. Pinned by
     comparing their answers for the same month, not by reading the code. */
  const cases = [
    { calls_promised: 10, calls_delivered: 7, starts_on: '2026-11-12', ends_on: '2026-12-11' },
    { calls_promised: 15, calls_delivered: 0, starts_on: '2026-11-12', ends_on: '2026-12-11' },
    { calls_promised: 5, calls_delivered: 4, starts_on: '2026-11-01', ends_on: '2026-11-30' },
    { calls_promised: 10, calls_delivered: 2, starts_on: '2026-11-03', ends_on: '2026-12-02' },
  ];
  for (const c of cases) {
    const mine = guMonth(month(c), coreDayKey(NOW));
    const theirs = portalNorm(c, NOW);
    assert.equal(mine.pace.band, theirs.band, 'different band for ' + JSON.stringify(c));
    assert.equal(Math.round(mine.pace.expected * 1000), Math.round(theirs.expected * 1000),
      'different straight line for ' + JSON.stringify(c));
    /* and never the forbidden combination */
    assert.ok(!(mine.pace.band === 'ontrack' && theirs.state === 'behind'));
  }
});

/* ═════════════════ 3. the board ═════════════════ */

test('the three kinds of open month are kept apart, and only the running ones are the headline', () => {
  const rows = [
    /* running: started, not finished */
    month({ company: 'Running', starts_on: '2026-11-12', ends_on: '2026-12-11', calls_promised: 10, calls_delivered: 7, at_risk: 6000 }),
    /* ended weeks ago and never locked: the money is spent, not at risk */
    month({ company: 'Never closed', starts_on: '2026-09-10', ends_on: '2026-10-09', calls_promised: 5, calls_delivered: 0, at_risk: 3000, warn_now: true }),
    /* bought, not started: no pace to be behind yet */
    month({ company: 'Not begun', starts_on: '2027-01-10', ends_on: '2027-02-09', calls_promised: 5, calls_delivered: 0, at_risk: 1500 }),
    /* not open at all: already settled */
    month({ company: 'Settled', verdict: 'missed', locked_at: '2026-11-01', at_risk: 9000 }),
  ];
  const b = guBoard(ok(rows), expo(), NOW);
  assert.equal(b.running.length, 1);
  assert.equal(b.toClose.length, 1);
  assert.equal(b.before.length, 1);
  assert.equal(b.promised.total, 10, 'only the running month is promised now');
  assert.equal(b.delivered.total, 7);
  assert.equal(b.owed.total, 3);
  assert.equal(b.cost.total, 6000, 'the headline is the running month only');
  assert.equal(b.closeCost.total, 3000, 'the ended month is money already spent, on its own line');

  const h = guBoardHtml(b);
  assert.match(text(h), /1 month has ended and is still open/);
  assert.match(text(h), /holding \$3,000 that is already spent/);
  assert.match(text(h), /1 month has been bought and has not started/);
});

test("v_exposure is read by its real column names, and shown under what it actually counts", () => {
  /* The view's columns are open_months, at_risk_total and at_risk_month_one.
     Reading it for a column called 'at_risk' finds nothing — which is exactly
     how the Today screen came to show $0 next to a live total of $69,300. */
  const b = guBoard(ok([month()]), expo(), NOW);
  assert.equal(b.dbAtRiskTotal, 69300);
  assert.equal(b.dbOpenMonths, 22);
  assert.equal(b.dbAtRiskMonthOne, 40800);
  const t = text(guBoardHtml(b));
  assert.match(t, /\$69,300 across 22 open months/);
  assert.match(t, /including months that have not started and months that ended and were never closed/);
  assert.ok(!/at risk .*\$69,300/i.test(t.split('For comparison')[0]), 'the all-months figure is not the headline');
});

test('a source that did not answer is a dash and a sentence, never a zero', () => {
  const b = guBoard(fail('Your sign-in has run out. Please sign in again.'), expo(), NOW);
  assert.equal(b.got, false);
  assert.equal(b.promised.total, null);
  assert.equal(b.cost.total, null);
  const t = text(guBoardHtml(b));
  assert.match(t, /Your sign-in has run out/);
  assert.match(t, /dashes, not zeros/);
  assert.ok(!/\$0\b/.test(t), 'a screen that cannot read the book must not say $0');
  assert.equal((t.match(/—/g) || []).length >= 4, true, 'every tile is a dash');
});

test('one month missing its money makes the total say it is partial, not say a smaller number', () => {
  /* The owner's named failure mode, on the figure he would trust most: a total
     that quietly goes DOWN when part of it fails to load looks like good news. */
  const whole = guBoard(ok([
    month({ company: 'A', calls_delivered: 0, at_risk: 6000 }),
    month({ company: 'B', calls_delivered: 0, at_risk: 9000 }),
  ]), expo(), NOW);
  assert.equal(whole.cost.total, 15000);
  assert.equal(whole.cost.unknown, 0);

  const holed = guBoard(ok([
    month({ company: 'A', calls_delivered: 0, at_risk: 6000 }),
    month({ company: 'B', calls_delivered: 0, at_risk: null }),
  ]), expo(), NOW);
  assert.equal(holed.cost.total, 6000);
  assert.equal(holed.cost.unknown, 1);
  assert.match(text(guBoardHtml(holed)), /1 month did not carry a figure/);
});

test('the all-months total failing does not blank the headline, and says so', () => {
  const b = guBoard(ok([month({ calls_delivered: 0, at_risk: 6000 })]), fail('offline'), NOW);
  assert.equal(b.cost.total, 6000, 'the headline has its own source and still stands');
  assert.equal(b.dbAtRiskTotal, null);
  assert.match(text(guBoardHtml(b)), /did not come through, so the reconciliation below is a dash rather than a zero/);
});

test('no clients, and no running month, each say so in their own words', () => {
  const none = guBoardHtml(guBoard(ok([]), expo({ open_months: 0, at_risk_total: 0, at_risk_month_one: 0 }), NOW));
  assert.match(text(none), /No month is running\. Nothing is promised and nothing is at risk/);

  const onlyFuture = guBoardHtml(guBoard(ok([month({ starts_on: '2027-01-10', ends_on: '2027-02-09' })]), expo(), NOW));
  assert.match(text(onlyFuture), /No month is running yet\. 1 month has been bought and not started/);
});

test('a month that promised nothing is not a divide by zero', () => {
  const b = guBoard(ok([month({ calls_promised: 0, calls_delivered: 0, at_risk: 0 })]), expo(), NOW);
  assert.equal(b.running.length, 1);
  assert.equal(b.running[0].band, 'none');
  assert.equal(b.promised.total, 0);
  assert.equal(b.cost.total, 0);
  const t = text(guBoardHtml(b));
  assert.ok(!/NaN|Infinity/.test(t), t.slice(0, 200));
});

test('fifty clients: everything is classified and the worst money is first', () => {
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push(month({
      company: 'Client ' + i, client_id: 'c' + i,
      calls_promised: [5, 10, 15][i % 3],
      calls_delivered: i % 4 === 0 ? 0 : (i % 7),
      starts_on: '2026-11-12', ends_on: '2026-12-11',
      at_risk: 1000 * (i % 9 + 1),
    }));
  }
  const b = guBoard(ok(rows), expo(), NOW);
  assert.equal(b.running.length, 50);
  /* worst band first, then the most money inside a band */
  const ranks = b.running.map(m => ['gone', 'atrisk', 'behind', 'ontrack', 'met', 'none'].indexOf(m.band));
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] >= ranks[i - 1], 'ranking is not worst-first');
  for (let i = 1; i < b.running.length; i++) {
    if (b.running[i].band === b.running[i - 1].band) {
      assert.ok((b.running[i].atRisk || 0) <= (b.running[i - 1].atRisk || 0), 'inside a band, the money is not biggest-first');
    }
  }
  /* and the whole thing is one list the owner can read, not fifty screens */
  assert.equal(b.savable.every(m => m.pace.savable), true);
  assert.equal(b.lost.every(m => m.band === 'gone'), true);
});

test("a client's name cannot put markup on the owner's screen", () => {
  const b = guBoard(ok([month({ company: '<script>x</script>" onload="y', calls_delivered: 0, at_risk: 6000 })]), expo(), NOW);
  const h = guBoardHtml(b);
  assert.ok(!h.includes('<script>'), 'a company name reached the page as markup');
  assert.ok(!h.includes('onload="y'), 'a company name reached an attribute');
  assert.match(h, /&lt;script&gt;/);
});

test('the day the old day-20 warning was aiming at, and the day it actually needed to be', () => {
  /* v_month_standing.warn_now is "open, short, and ten days or less to go",
     which on a 30-day month is day 21. guLostFromDay says a month at nothing
     delivered is already past saving from day 20 — so the warning fired one day
     AFTER the last day on which it could have been acted on, for the worst case
     it exists to catch. */
  assert.equal(guLostFromDay(30), 20);
  assert.equal(guLostFromDay(31), 21);
  assert.equal(guLostFromDay(28), 19);

  /* and from nothing delivered the day is the same for all three plans, because
     the needed pace and the sold pace both scale with the plan. That is the
     answer to "is day 20 right for Starter, Growth and Scale": the DAY is the
     same, the RATE is not — 0.5 a day for a Starter and 1.5 for a Scale with
     ten days left — which is why this screen prints the rate. */
  const at = (target) => corePace(target, 0, 20, 30, 10);
  assert.equal(at(5).band, at(15).band);
  assert.equal(coreRate(at(5).perDayNeed), '0.5');
  assert.equal(coreRate(at(15).perDayNeed), '1.4');
});

test('the board opens a client, and nothing else', () => {
  /* the only action on the block: it hands the owner to the client it is warning
     about. No locking, no writing, no refunding from a summary screen. */
  const h = guBoardHtml(guBoard(ok([month({ calls_delivered: 0 })]), expo(), NOW));
  assert.match(h, /guOpen\(/);
  /* and it only ever reads. Comments stripped first: the prose explains what
     lock_month is for, the code never calls it. */
  const code = read('guarantee.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['lock_month', 'fnLockMonth', 'raise_invoice', '.insert(', '.update(', '.rpc(', '.delete(']) {
    assert.ok(!code.includes(bad), 'guarantee.js must only read: found ' + bad);
  }
});

test('it reads the views through finance.js and opens no second path of its own', () => {
  const src = read('guarantee.js');
  assert.ok(!/\bsb\s*\./.test(src), 'guarantee.js must not touch sb directly; finance.js owns the views');
  assert.match(src, /guAsk\('fnStanding'\)/);
  assert.match(src, /guAsk\('fnExposure'\)/);
  /* one read for the whole book, so a total can never be quietly partial */
  assert.equal((src.match(/guAsk\(/g) || []).length, 3, 'two asks, and the helper that makes them');
});

test('the shell draws it above Today, and says so if its file did not load', () => {
  const html = read('index.html');
  assert.match(html, /<script src="guarantee\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="guarantee\.css">/);
  /* routed through V(), which is the shell's "this screen's file did not load" card */
  assert.match(html, /home:\{fn:\(\)=>V\('guBoardHost'\)\+V\('viewHome'\)/);
});

/* ═════════════════ 4. the confident zero on Today ═════════════════ */

test("Today's own exposure tile reads v_exposure by its real column name", () => {
  /* digest.js guessed at the column spelling and had a fallback that turned
     "not found" into 0. v_exposure has no column called at_risk, so the tile
     said $0 for as long as it has existed. Checked live on 2026-11-26: the view
     said $69,300 and Today said $0 — the one figure the owner would most trust,
     confidently wrong, which is the failure mode he named himself. */
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, Intl, Date, Math, JSON, Number, String, Object, Array, RegExp, isNaN, parseInt, parseFloat, Infinity, NaN });
  ctx.window = ctx;
  ctx.sb = { from(){ throw new Error('no database in this test') } };
  for (const f of ['core.js', 'digest.js']) vm.runInContext(read(f), ctx, { filename: f });
  const pickNum = vm.runInContext('dgPickNum', ctx);
  const renderHome = vm.runInContext('dgRenderHome', ctx);

  const live = { open_months: 22, at_risk_total: 69300, at_risk_month_one: 40800 };
  assert.equal(pickNum(live, ['at_risk_total', 'at_risk', 'exposure', 'refund_at_risk', 'would_owe', 'amount', 'total']), 69300);

  /* and the figure reaches the tile */
  assert.match(text(renderHome({ refundsExposed: 69300 })), /Refunds exposed \$69,300/);
  /* a view that answered without the column is a dash, not a zero */
  assert.match(text(renderHome({ refundsExposed: null })), /Refunds exposed —/);
  /* the tile's note says what it counts: every open month, not "this month" */
  assert.match(text(renderHome({ refundsExposed: 0 })), /every open month, started or not/);
});

test("v_money's own column names are the ones Today asks for", () => {
  /* unpaid_invoiced and paid_all_time were missing from the lists too, so both
     tiles were being added up in the browser off the invoice rows while the
     view sat there with the answer. */
  const src = read('digest.js');
  for (const col of ['unpaid_invoiced', 'paid_all_time', 'paid_this_month', 'refunds_owed']) {
    assert.ok(src.includes("'" + col + "'"), 'digest.js never asks v_money for ' + col);
  }
});

/* ═════════════════ 5. my_channels, 33 times in one walk ═════════════════ */

test('the unread count is only forced when the owner leaves the Channels screen', () => {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Intl, Date, Math, JSON, Number, String, Object, Array, RegExp, isNaN, parseInt, parseFloat, Infinity, NaN,
    location: { hash: '', pathname: '/', search: '' }, history: {},
    document: { hidden: false, addEventListener(){}, getElementById(){ return null }, createElement(){ return {} }, head: { appendChild(){} } } });
  ctx.window = ctx;
  ctx.authUser = { id: 'u1', role: 'admin' };
  ctx.renderNav = () => {};
  for (const f of ['core.js', 'channels-api.js', 'channels.js']) vm.runInContext(read(f), ctx, { filename: f });
  /* the only thing that reaches my_channels() from here, put in after
     channels-api.js has installed the real one */
  let calls = 0;
  ctx.chUnreadTotal = async () => { calls++; return { ok: true, data: 0, error: '' } };
  const onRender = vm.runInContext('channelsOnRender', ctx);
  const chv = vm.runInContext('chv', ctx);
  const settle = () => new Promise(r => setTimeout(r, 0));

  return (async () => {
    /* a walk of the hub: eleven screens, none of them Channels */
    for (const v of ['home', 'clients', 'client', 'calendar', 'meeting', 'billing', 'drafts',
                     'prospects', 'team', 'documents', 'settings']) { onRender(v); await settle(); }
    assert.equal(calls, 1, 'eleven screens asked my_channels ' + calls + ' times; one is the throttle working');

    /* open Channels, then leave it: the badge must be right at once, because the
       owner has just read messages */
    onRender('channels'); await settle();
    assert.equal(calls, 1, 'the Channels screen has its own reload; it does not peek');
    chv.peekAt = Date.now();          /* inside the throttle, so only a force gets through */
    onRender('home'); await settle();
    assert.equal(calls, 2, 'leaving Channels did not refresh the badge');

    /* and the next ten screens go quiet again */
    for (const v of ['clients', 'calendar', 'billing', 'drafts', 'team', 'home', 'clients', 'calendar', 'billing', 'team']) { onRender(v); await settle(); }
    assert.equal(calls, 2, 'the throttle let ' + (calls - 2) + ' extra reads through');
  })();
});

/* ═════════════════ 6. a screen nothing could reach ═════════════════ */

/* The inline shell from index.html, in its own context with a fake page —
   the same trick tests/app.test.mjs uses. */
function shell(role = 'admin') {
  const html = read('index.html');
  const src = html.slice(html.indexOf('<script>\n') + 9, html.indexOf('</script>\n<script src="finance.js">'));
  const els = {};
  const fake = (id) => {
    const e = { id, value: '', innerHTML: '', textContent: '', style: {}, _c: new Set(), scrollTop: 0,
      addEventListener(){}, focus(){}, setAttribute(){}, querySelectorAll: () => [], closest: () => null };
    e.classList = { add: c => e._c.add(c), remove: c => e._c.delete(c), contains: c => e._c.has(c), toggle(){ return false } };
    return e;
  };
  const el = (id) => (els[id] ||= fake(id));
  const ctx = { console, setTimeout, clearTimeout, Promise, URLSearchParams,
    document: { body: fake('body'), documentElement: fake('html'), getElementById: el, querySelectorAll: () => [], addEventListener(){} },
    localStorage: { getItem: () => null, setItem(){} }, sessionStorage: { removeItem(){} },
    navigator: {}, location: { hash: '', origin: 'https://aviance.store', pathname: '/', search: '', replace(){} },
    history: { replaceState(){} },
    supabase: { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }), signOut: async () => {} } }) } };
  ctx.window = ctx; ctx.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(read('core.js'), ctx, { filename: 'core.js' });
  vm.runInContext(src, ctx, { filename: 'index.html (inline script)' });
  const run = (code) => vm.runInContext(code, ctx);
  if (role) run(`authUser={uid:'u1',name:'Owner',role:${JSON.stringify(role)},email:'o@example.com'}`);
  return run;
}

test("'Their people' can be reached: it is the only way to make a second portal login", () => {
  /* portal_invite_create is called from exactly one place in the browser,
     viewClientPeople, and until now nothing could get to that screen:
     openClientPeople had no callers, it was not in the command palette and it
     was not a deep link. A Growth client has four portal logins on their plan;
     the welcome email makes the first one. The other three needed the SQL
     editor. Verified by grep on 2026-11-27 before this was changed. */
  const invites = read('portal.js').match(/portal_invite_create/g) || [];
  assert.ok(invites.length >= 1, 'portal_invite_create moved; this test is pointing at the wrong screen');

  const run = shell('admin');
  run("hubClients=[{id:'c1',company:'Stone Ltd',stage:'live'}]");
  /* with no client open it is not offered — 'Their people' with nobody chosen
     could only say "you don't have access" */
  run('currentClientId=null');
  const none = JSON.parse(run('JSON.stringify(cmdkEntities().filter(x=>x.type==="Screens").map(x=>x.label))'));
  assert.ok(!none.includes('Their people'), 'offered with no client chosen');

  /* with one open, it is in the palette */
  run("currentClientId='c1'");
  const some = JSON.parse(run('JSON.stringify(cmdkEntities().filter(x=>x.type==="Screens").map(x=>x.label))'));
  assert.ok(some.includes('Their people'), 'still unreachable from the command palette');

  /* and a link to it can be sent */
  assert.deepEqual(JSON.parse(run("JSON.stringify(parseDeepLink('#people/abc-123'))")), { view: 'people', id: 'abc-123' });
  assert.equal(run("String(goDeepLink).includes(\"openClientPeople(d.id)\")"), true);

  /* the screen itself is still routed, and the sidebar still lights Clients for it */
  assert.ok(run("!!views.clientPeople"));
  assert.equal(run("navItems().find(i=>i.view==='clients').also.includes('clientPeople')"), true);
});

test('no screen in the shell is orphaned: every route can be reached by a person', () => {
  /* The rule that stops this happening again. A route is reachable if it is a
     sidebar place, a page with a Back button that something links to, in the
     command palette, or a deep link. 'clientPeople' broke it; nothing else may. */
  const run = shell('admin');
  run("hubClients=[{id:'c1',company:'Stone Ltd',stage:'live'}];currentClientId='c1';currentMeetingId='m1';currentThreadId='t1'");
  const routes = JSON.parse(run('JSON.stringify(Object.keys(views))'));
  const inNav = JSON.parse(run("JSON.stringify(navItems().reduce((a,i)=>a.concat([i.view],i.also||[]),[]))"));
  const inPalette = JSON.parse(run('JSON.stringify(CMDK_SCREENS.map(s=>s[0]))'));
  const linked = read('index.html') + read('clientbook.js') + read('digest.js') + read('meetings.js') + read('portal.js');
  for (const v of routes) {
    const reachable = inNav.includes(v) || inPalette.includes(v) ||
      new RegExp("render\\('" + v + "'\\)").test(linked);
    assert.ok(reachable, 'nothing in the hub can reach the ' + v + ' screen');
  }
});

/* A line that says "close them on Month end" has to lead there. */
test('ended-and-open months come with a way to the screen that closes them', () => {
  const src = fs.readFileSync(new URL('../guarantee.js', import.meta.url), 'utf8');
  assert.match(src, /d\.toClose\.length \? '<p class="gu-go"><button[^>]*onclick="render\(\\'monthEnd\\'\)"/);
});

/* Found by rendering the board against rows that lacked calls_short: it showed
   "Still owed 0" beside 25 promised and 7 delivered, and "$0 if nothing changes".
   A figure nobody computed is a dash, and a month whose shortfall is missing is
   not a month that is on its number. */
test('rows that do not carry a shortfall give a dash, never a zero', () => {
  const rows = [month(), month()].map((m) => { const o = { ...m }; delete o.calls_short; return o; });
  const b = guBoard(ok(rows), expo(), NOW);
  assert.equal(b.owed.total, null, 'still owed is unknown, not 0');
  assert.equal(b.cost.total, null, 'the cost is unknown, not $0');
  const t = text(guBoardHtml(b));
  assert.doesNotMatch(t, /Still owed 0\b/);
  assert.doesNotMatch(t, /If nothing changes \$0\b/);
  assert.match(t, /did not carry a figure/);
});
test('one row without a shortfall is said out loud beside the total of the rest', () => {
  const a = month(); const bad = { ...month() }; delete bad.calls_short;
  const b = guBoard(ok([a, bad]), expo(), NOW);
  assert.equal(b.owed.unknown, 1);
  assert.match(text(guBoardHtml(b)), /1 month did not carry a figure/);
});
