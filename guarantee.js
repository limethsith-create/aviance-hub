/* ===================== AVIANCE OS — the commitment board =====================
   The one question this hub could not answer: CAN I DELIVER WHAT I HAVE
   ALREADY SOLD, AND WHAT IS ABOUT TO GO WRONG?

   Every other screen is per-client. You could open twelve clients one after
   another and still not know what the book owes this month, and you found out
   that a month had gone short when the month ended — which is the one moment
   at which nothing can be done about it. This file is the opposite of a
   month-end report. It sits at the top of Today, and it answers:

     what is promised across every running month
     what has been delivered against it
     what is still owed
     how long is left
     what it costs if nothing changes
     which clients can still be saved, hardest first

   WHERE THE FIGURES COME FROM
   One read: v_month_standing, through finance.js's fnStanding(). Every figure
   on a row is the database's own: calls_promised, calls_delivered, calls_short,
   days_left and at_risk are all computed in the view, by the same SQL that
   settles the refund. Nothing here re-derives money. The only arithmetic this
   file does is adding up rows the database already decided, and the pace sum in
   core.js — which the client's own portal reads too, so the two screens cannot
   tell different stories about the same month.

   ONE READ, ON PURPOSE. The owner's named failure mode is a screen that answers
   with a confident zero when it could not read something. A total built from
   twelve per-client reads goes quietly DOWN when one of them fails, and looks
   like good news. So there is one read for the whole book: either it answered,
   and the totals are whole, or it did not, and every figure on this block is a
   dash with a sentence saying so. A total here is never partial without saying
   it is partial.

   WHAT v_exposure ACTUALLY COUNTS, AND WHY IT IS NOT THE HEADLINE
   v_exposure.at_risk_total sums at_risk over every month whose verdict is
   'open'. Checked against the live database on 2026-11-26: that included ten
   months of one client that had not begun, the last of them ending in September
   2027, and two months that had ENDED weeks earlier and were never locked. It
   is a true number and it answers a different question — "every dollar this
   book could ever owe" — so it is shown here under that name, at the bottom,
   reconciled against the headline. The headline is money on months that are
   RUNNING NOW, because that is the only money a decision today can move.

   THREE KINDS OF OPEN MONTH, KEPT APART
     running    started, not finished. The headline. Still actionable.
     to close   ended, still open. The money is already spent; it needs
                lock_month, not effort. Lives in its own line.
     not begun  bought, not started. No pace, no risk yet. Counted, not totalled
                into what today costs.

   House rules kept: data functions return {ok,data,error} and never throw;
   render functions are pure; every value goes through coreEsc; prefix gu.
   ============================================================================ */

/* The {ok,data,error} result, from core.js. */
const guOk = coreOk;
const guErr = coreErr;
const guEsc = coreEsc;
const guUsd = coreUsd;
const guDay = coreDayKey;
/* A figure the source could not answer reads as a dash, never as '$0'. */
const GU_DASH = '—';
function guUsdOr(v){ return v === null || v === undefined ? GU_DASH : guUsd(v) }
function guNumOr(v){ return v === null || v === undefined ? GU_DASH : String(Math.round(Number(v) || 0)) }

/* finance.js owns the views. This file asks it rather than opening a second
   path to the same table — one place decides what a month's standing is. */
async function guAsk(name, arg){
  const f = typeof window !== 'undefined' ? window[name] : null;
  if (typeof f !== 'function') return guErr('The money side of Aviance OS did not load. Reload the page.');
  try { const r = await f(arg); return r && typeof r.ok === 'boolean' ? r : guOk(r); }
  catch (e) { return guErr(e); }
}

/* ---- the sums ------------------------------------------------------ */

/* A row of v_month_standing, read with its own column names. No guessing at
   spellings: a view column that is not there reads as null and shows as a dash,
   because a figure we cannot read is not a zero. */
function guRowNum(row, key){
  if (!row) return null;
  const v = row[key];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Which kind of open month this is, against today. Pure. */
function guKind(row, todayKey){
  const starts = String((row && row.starts_on) || '').slice(0, 10);
  const ends = String((row && row.ends_on) || '').slice(0, 10);
  if (!starts || !ends) return 'unknown';
  if (starts > todayKey) return 'before';
  if (ends < todayKey) return 'toclose';
  return 'running';
}

/* Days between two 'YYYY-MM-DD' keys, b - a. Pure, and it does not care what
   zone the reader is in because both sides are calendar days. */
function guDaysBetween(a, b){
  const pa = coreToDate(a), pb = coreToDate(b);
  if (!pa || !pb) return null;
  return Math.round((pb.getTime() - pa.getTime()) / 86400000);
}

const GU_BAND_WORD = {
  met: 'Met', ontrack: 'On course', behind: 'Behind',
  atrisk: 'At risk', gone: 'Past saving', none: 'Nothing promised'
};
/* worst first: this is the order the owner's attention should go in */
const GU_BAND_ORDER = ['gone', 'atrisk', 'behind', 'ontrack', 'met', 'none'];
function guBandRank(b){ const i = GU_BAND_ORDER.indexOf(b); return i < 0 ? GU_BAND_ORDER.length : i }

/* One running month, judged. Pure.
   `days_left` in the view is ends_on - CURRENT_DATE, worked out by the database
   in UTC. It is recomputed here from the reader's own calendar day so that the
   figure on the screen and the figure in the sentence beside it are the same
   number — see the note in the findings about the database's zone. */
function guMonth(row, todayKey){
  const promised = guRowNum(row, 'calls_promised');
  const delivered = guRowNum(row, 'calls_delivered');
  const starts = String((row && row.starts_on) || '').slice(0, 10);
  const ends = String((row && row.ends_on) || '').slice(0, 10);
  const total = guDaysBetween(starts, ends);
  const left = guDaysBetween(todayKey, ends);
  const elapsed = guDaysBetween(starts, todayKey);
  const pace = corePace(promised, delivered, (elapsed === null ? 0 : elapsed) + 1,
                        (total === null ? 0 : total) + 1, left === null ? 0 : Math.max(0, left));
  return {
    monthId: (row && row.month_id) || null,
    clientId: (row && row.client_id) || null,
    company: String((row && row.company) || 'This client'),
    plan: String((row && row.plan) || ''),
    monthNo: guRowNum(row, 'month_no'),
    promised, delivered,
    /* the database's own figures, not re-derived here */
    short: guRowNum(row, 'calls_short'),
    atRisk: guRowNum(row, 'at_risk'),
    warnNow: !!(row && row.warn_now),
    startsOn: starts, endsOn: ends,
    daysLeft: left, total, elapsed,
    kind: guKind(row, todayKey),
    pace,
    band: promised === null || delivered === null ? 'none' : pace.band
  };
}

/* The whole board. Pure: standing and exposure are whole {ok,data,error}
   results, so a source that did not answer shows as a dash and never as a
   zero. `now` is injectable for the tests. */
function guBoard(standing, exposure, now){
  const todayKey = guDay(now == null ? new Date() : now);
  const got = !!(standing && standing.ok);
  const rows = got && Array.isArray(standing.data) ? standing.data : [];
  const missing = [];
  if (!got) missing.push(standing && standing.error ? standing.error : 'The month standings did not come through.');

  const open = rows.filter(r => r && String(r.verdict || '') === 'open');
  const months = open.map(r => guMonth(r, todayKey));
  const running = months.filter(m => m.kind === 'running');
  const toClose = months.filter(m => m.kind === 'toclose');
  const before = months.filter(m => m.kind === 'before');

  /* the headline. null the moment the read failed — not 0. */
  const sum = (list, pick) => {
    let total = 0, unknown = 0;
    list.forEach(m => { const v = pick(m); if (v === null || v === undefined) unknown++; else total += v; });
    /* If NO row carried the figure there is nothing to add up, and 0 would be a
       number nobody computed. That is a dash, not a zero. */
    if (list.length && unknown === list.length) return {total: null, unknown};
    return {total, unknown};
  };
  const promised = got ? sum(running, m => m.promised) : {total: null, unknown: 0};
  const delivered = got ? sum(running, m => m.delivered) : {total: null, unknown: 0};
  const owed = got ? sum(running, m => m.short) : {total: null, unknown: 0};
  /* what it costs if nothing changes: the at_risk the database worked out, on
     the months that are running and short. A month already on its number is
     not at risk and its at_risk is 0 in the view anyway. */
  /* A month whose shortfall did not arrive is NOT a month that is on its number: it
     stays in the sum as an unknown, so the tile says a figure is missing instead of
     quietly leaving that month's money out. */
  const cost = got ? sum(running.filter(m => m.short === null || m.short === undefined || m.short > 0),
    m => (m.short === null || m.short === undefined) ? null : m.atRisk) : {total: null, unknown: 0};
  const closeCost = got ? sum(toClose, m => m.atRisk) : {total: null, unknown: 0};

  /* the soonest end: how long the owner actually has before the first of these
     months settles */
  let soonest = null;
  running.forEach(m => { if (m.daysLeft !== null && (soonest === null || m.daysLeft < soonest)) soonest = m.daysLeft; });

  const byRisk = running.slice().sort((a, b) =>
    guBandRank(a.band) - guBandRank(b.band) ||
    (b.atRisk || 0) - (a.atRisk || 0) ||
    (a.daysLeft === null ? 1e9 : a.daysLeft) - (b.daysLeft === null ? 1e9 : b.daysLeft));

  const exp = exposure && exposure.ok ? exposure.data : null;
  return {
    today: todayKey,
    got,
    missing,
    promised, delivered, owed, cost, closeCost,
    soonest,
    running: byRisk,
    /* off course and the arithmetic still closes: where an hour of work pays */
    savable: byRisk.filter(m => m.pace && m.pace.savable),
    /* off course and it does not: these need the truth told early, not effort */
    lost: byRisk.filter(m => m.band === 'gone'),
    toClose, before,
    /* the database's own all-months total, under its own name */
    dbOpenMonths: guRowNum(exp, 'open_months'),
    dbAtRiskTotal: guRowNum(exp, 'at_risk_total'),
    dbAtRiskMonthOne: guRowNum(exp, 'at_risk_month_one'),
    dbGot: !!(exposure && exposure.ok)
  };
}

/* The first day of a month at nothing delivered from which no plan can finish
   on its number. Pure, and it answers the question the old day-20 warning was
   guessing at: with nothing delivered the pace ratio is total/remaining, which
   does not depend on the plan at all — so the day is the same for Starter,
   Growth and Scale, and it is not day 20. For a 30-day month it is day 21. */
function guLostFromDay(total){
  const tot = Math.max(1, Math.round(Number(total) || 0));
  for (let el = 1; el <= tot; el++) {
    if (corePace(1, 0, el, tot, tot - el).band === 'gone') return el;
  }
  return tot;
}

/* ---- the words ----------------------------------------------------- */

/* The one line under a month that says what has to happen. Pure. */
function guPaceLine(m){
  const p = m && m.pace ? m.pace : null;
  if (!p) return '';
  if (m.band === 'met') return 'On its number. Everything after this is on top.';
  const need = coreRate(p.perDayNeed);
  const done = coreRate(p.perDayDone);
  const left = m.daysLeft === null ? null : m.daysLeft;
  const when = left === null ? '' : (left === 0 ? 'today is the last day' : left + (left === 1 ? ' day left' : ' days left'));
  const rate = 'needs ' + need + ' a day from here; has managed ' + done + ' a day so far';
  if (m.band === 'gone') return 'Cannot be finished: ' + rate + '. Tell them now and work out the refund — do not spend the month hoping.';
  if (m.band === 'atrisk') return 'Savable, but only with a real push: ' + rate + (when ? ', ' + when : '') + '.';
  if (m.band === 'behind') return 'Behind, and recoverable: ' + rate + (when ? ', ' + when : '') + '.';
  return 'On course: ' + rate + (when ? ', ' + when : '') + '.';
}

function guTile(label, value, note, warn){
  return '<div class="gu-tile' + (warn ? ' gu-warn' : '') + '">' +
    '<span class="gu-tile-l">' + guEsc(label) + '</span>' +
    '<b class="gu-tile-v fig">' + guEsc(value) + '</b>' +
    (note ? '<span class="gu-tile-n">' + guEsc(note) + '</span>' : '') + '</div>';
}

function guRowHtml(m){
  const name = m.monthNo === null ? m.company : m.company + ' · month ' + m.monthNo;
  return '<li class="gu-row gu-' + guEsc(m.band) + '">' +
    '<div class="gu-row-main">' +
      '<b>' + guEsc(name) + '</b>' +
      '<span class="gu-row-sub">' + guEsc(guPaceLine(m)) + '</span>' +
    '</div>' +
    '<div class="gu-row-figs">' +
      '<span class="fig gu-count">' + guEsc(guNumOr(m.delivered) + ' of ' + guNumOr(m.promised)) + '</span>' +
      '<span class="gu-row-sub">' + guEsc(m.daysLeft === null ? GU_DASH : (m.daysLeft === 0 ? 'last day' : m.daysLeft + ' days left')) + '</span>' +
    '</div>' +
    '<div class="gu-row-side">' +
      '<span class="gu-stamp">' + guEsc(GU_BAND_WORD[m.band] || '') + '</span>' +
      '<span class="fig gu-money">' + guEsc(guUsdOr(m.atRisk)) + '</span>' +
    '</div>' +
    '<div class="gu-row-act"><button type="button" class="btn ghost" onclick="guOpen(' + coreAttr(String(m.clientId || '')) + ')">Open</button></div>' +
  '</li>';
}

/* The block. Pure: data in, HTML out. */
function guBoardHtml(b){
  const d = b || {};
  if (!d.got) {
    return '<section class="gu" aria-label="What is promised this month">' +
      '<div class="gu-head"><h3>What is promised this month</h3></div>' +
      '<p class="gu-fail">' + guEsc((d.missing && d.missing[0]) || 'The month standings did not come through.') +
      ' Nothing on this block is a figure you can act on until it does — these are dashes, not zeros.</p>' +
      '<div class="gu-tiles">' +
        guTile('Calls promised', GU_DASH) + guTile('Delivered', GU_DASH) +
        guTile('Still owed', GU_DASH) + guTile('If nothing changes', GU_DASH) +
      '</div></section>';
  }
  const running = Array.isArray(d.running) ? d.running : [];
  const partial = (x) => x && x.unknown ? ' (' + x.unknown + ' month' + (x.unknown === 1 ? '' : 's') + ' did not carry a figure)' : '';
  const costWarn = d.cost && d.cost.total > 0;

  const tiles =
    guTile('Calls promised', running.length ? guNumOr(d.promised.total) : '0',
      running.length === 1 ? 'across 1 running month' : 'across ' + running.length + ' running months') +
    guTile('Delivered', guNumOr(d.delivered.total), 'counted by the database, not by this page') +
    guTile('Still owed', guNumOr(d.owed.total), (d.soonest === null ? '' :
      (d.soonest === 0 ? 'the first of these months ends today' : 'the first of these months ends in ' + d.soonest + ' days')) + partial(d.owed)) +
    guTile('If nothing changes', guUsdOr(d.cost.total),
      'refunds on the months running now' + partial(d.cost), costWarn);

  const section = (title, list, blurb) => !list.length ? '' :
    '<div class="gu-group"><h4>' + guEsc(title) + '</h4>' +
    (blurb ? '<p class="gu-blurb">' + guEsc(blurb) + '</p>' : '') +
    '<ul class="gu-list">' + list.map(guRowHtml).join('') + '</ul></div>';

  const lost = Array.isArray(d.lost) ? d.lost : [];
  const savable = Array.isArray(d.savable) ? d.savable : [];
  const fine = running.filter(m => m.band === 'ontrack' || m.band === 'met');

  let body = '';
  if (!running.length) {
    body = '<p class="gu-none">' + guEsc(d.before.length
      ? 'No month is running yet. ' + d.before.length + (d.before.length === 1 ? ' month has' : ' months have') + ' been bought and not started.'
      : 'No month is running. Nothing is promised and nothing is at risk.') + '</p>';
  } else {
    body =
      section('Past saving — tell them now', lost,
        'The arithmetic does not close on these any more. Every day one of them stays unsaid is a day the refund gets harder to have a conversation about.') +
      section('Still savable — this is where an hour pays', savable,
        'Ranked by how far off the pace they are, then by what they cost. The rate beside each one is what has to land every day from today.') +
      (fine.length ? '<p class="gu-fine">' + guEsc(fine.length + (fine.length === 1 ? ' running month is' : ' running months are') +
        ' on course and needs nothing from you.') + '</p>' : '');
  }

  const extras = [];
  if (d.toClose.length) extras.push(d.toClose.length + (d.toClose.length === 1 ? ' month has' : ' months have') +
    ' ended and ' + (d.toClose.length === 1 ? 'is' : 'are') + ' still open' + (d.closeCost.total ? ', holding ' + guUsd(d.closeCost.total) + ' that is already spent' : '') +
    '. That money cannot be saved, only settled.');
  if (d.before.length) extras.push(d.before.length + (d.before.length === 1 ? ' month has' : ' months have') +
    ' been bought and ' + (d.before.length === 1 ? 'has' : 'have') + ' not started. Not counted above: there is no pace to be behind yet.');

  const recon = !d.dbGot
    ? '<p class="gu-fail">' + guEsc('The all-months exposure total did not come through, so the reconciliation below is a dash rather than a zero.') + '</p>'
    : '<p class="gu-recon">' + guEsc('For comparison, the database’s own all-months total: ' + guUsdOr(d.dbAtRiskTotal) +
        ' across ' + guNumOr(d.dbOpenMonths) + (d.dbOpenMonths === 1 ? ' open month' : ' open months') + ', of which ' + guUsdOr(d.dbAtRiskMonthOne) +
        ' is month one at double the fee. That figure counts every open month on the book — including months that have not started and months that ended and were never closed — so it is bigger than the headline on purpose. The headline is only the money a decision today can still move.') + '</p>';

  return '<section class="gu" aria-label="What is promised this month">' +
    '<div class="gu-head"><h3>What is promised this month</h3>' +
      '<span class="gu-sub">' + guEsc('Every running month across the whole book, as at ' + d.today +
        '. Promised, delivered, days left and money are the database’s own figures; the pace is the same sum the client’s own portal shows them.') + '</span></div>' +
    '<div class="gu-tiles">' + tiles + '</div>' +
    body +
    (extras.length ? '<ul class="gu-extras">' + extras.map(x => '<li>' + guEsc(x) + '</li>').join('') + '</ul>' : '') +
    /* The line above tells the owner money is waiting to be settled; this is the way
       to the screen that settles it. A sentence that names a screen and does not lead
       there is a dead end. Month end holds a month back while a call is unanswered or
       the month is unpaid, and says why, so locking from here would skip that. */
    (d.toClose.length ? '<p class="gu-go"><button type="button" class="btn ghost" onclick="render(\'monthEnd\')">' +
      guEsc(d.toClose.length === 1 ? 'Close it on Month end' : 'Close them on Month end') + '</button></p>' : '') +
    recon +
  '</section>';
}

/* ---- the screen ---------------------------------------------------- */

const gu = {at: 0, busy: false};

function guOpen(id){
  if (!id) return;
  if (typeof openClient === 'function') openClient(id);
}

/* index.html draws this above Today. A view must hand back HTML at once, so it
   hands back its host and fills it in. */
function guBoardHost(){
  if (typeof document !== 'undefined' && document.getElementById) setTimeout(guMount, 0);
  return '<div class="gu-host" id="guHost"><section class="gu" aria-busy="true"><p class="gu-none">Adding up what is promised…</p></section></div>';
}

async function guMount(){
  if (gu.busy) return;
  gu.busy = true;
  try {
    const [standing, exposure] = await Promise.all([guAsk('fnStanding'), guAsk('fnExposure')]);
    const html = guBoardHtml(guBoard(standing, exposure));
    if (typeof document === 'undefined' || !document.getElementById) return;
    const host = document.getElementById('guHost');
    if (host) host.innerHTML = html;
  } finally { gu.busy = false; }
}
