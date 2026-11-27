/* ===================== AVIANCE — the client's dashboard =====================
   portal.html only. Everything the client sees above and beside their chat:

     1. THE STANDING LINE (#pcStanding) — where this month stands against the
        guarantee: "7 of 10 booked calls · 12 days left", and whether that is
        on track or behind. It is the first thing on the page because it is the
        thing the client pays for and the thing a refund turns on.
     2. THE LAUNCH PLAN (#pcTracker) — the six steps from payment to launch,
        inside the Chat tab. (pctRender, unchanged.)
     3. THE CAMPAIGN TAB (#pcCampaign) — sent, opened, replied, positive,
        calls booked: the totals, the same five by day as hand-drawn SVG, and
        the same five by angle.
     4. THE CALLS TAB (#pcCalls) — every booked call: who, what company, when,
        and whether they turned up.

   Where the numbers come from
   ---------------------------
   A client's browser is not trusted with anything, so nothing here decides what
   may be read: the database does. Three security-definer RPCs are asked first,
   each scoped to the signed-in client the same way portal_journey is:

     portal_month()     -> {month_no, starts_on, ends_on, calls_promised,
                            calls_delivered, plan, plan_label, client_id}
     portal_campaign()  -> {client_id,
                            campaigns:[{client_id, id, name, status, started_on,
                                        sent, opened, replied, positive, booked}],
                            daily:[{client_id, on_day, sent, opened, replied,
                                    positive, booked}]}
     portal_calls()     -> {client_id,
                            calls:[{client_id, id, who, title, company,
                                    booked_for, happened, happened_at,
                                    matched_icp, counts}]}

   EVERY ROW MUST CARRY client_id. This file drops any row whose client_id is
   missing or is not the signed-in client's (pctMine): fail closed, never leak.
   That is belt and braces — row level security is the real boundary — but it
   means a mistake in a policy or a join shows as an empty tab, not as another
   client's prospect list.

   Until those RPCs exist the same shapes are read straight from the tables
   (outreach_campaigns, outreach_daily, qualified_calls, meetings,
   outreach_threads, client_months), filtered by client_id and by whatever RLS
   allows. A client who is allowed nothing simply sees the empty state, which is
   written to be worth reading on its own.

   Nothing internal is ever drawn: no key_ref, no last_error, no dispute note,
   no staff note, no prospect email address.

   Rules kept from portal-client.js: data comes through ctx.rpc / ctx.sb, which
   never throw; every value goes through pcEsc; every render function is pure
   (data in, HTML out). Its own stylesheet is added once, so portal-client.css
   stays as it is. Prefix: pct.
   ======================================================================= */

const PCT_ASK_MS = 30000;
const PCT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PCT_DAY_MS = 86400000;
const PCT_CHART_DAYS = 30;          /* the most days drawn in one chart */
const PCT_MAX_ROWS = 400;           /* the most rows asked for, of anything */
const pct = {
  open: false, drawn: '', at: 0, data: null, busy: false, who: '',
  tab: 'chat',
  standing: '', campaignDrawn: '', callsDrawn: '',
  month: null, monthAt: 0, monthBusy: false, monthFailed: false,
  campaign: null, campaignAt: 0, campaignBusy: false, campaignFailed: false,
  calls: null, callsAt: 0, callsBusy: false, callsFailed: false,
  gone: {}, readMs: 0,          /* a test may shorten the limit on a read */
  /* "blind": the database has no rule yet that lets a client read this, so an
     empty answer means "we cannot see", not "there is nothing". See pctBlind. */
  monthBlind: false, callsBlind: false,
};

/* The one escape, from core.js: strict, five characters, the single quote among them. */
const pctEsc = coreEsc;
function pctDay(v){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
/* A day key, from core.js: 'YYYY-MM-DD' zero-padded in the reader's own calendar.
   One implementation, because a day key one day out is a refund. */
const pctKey = coreDayKey;
/* "Nov 26", in the reader's own style where the browser knows it. */
function pctDate(v){
  const d = pctDay(v);
  if (!d) return '';
  try {
    const s = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (s && !/invalid/i.test(s)) return s;
  } catch (e) { /* fall through */ }
  return PCT_MON[d.getMonth()] + ' ' + d.getDate();
}
/* A number, or 0. Never NaN in the page. */
function pctNum(v){
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
/* 1234 -> '1,234'. Figures are mono and tabular everywhere they are drawn. */
function pctFig(v){
  const n = Math.round(pctNum(v));
  return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/* A rate as the client would say it: 11 of 260 -> '4.2%'. '' when there is no base. */
function pctRate(part, whole){
  const w = pctNum(whole);
  if (w <= 0) return '';
  const r = (pctNum(part) / w) * 100;
  return (r >= 10 ? Math.round(r) : Math.round(r * 10) / 10) + '%';
}

/* ---- the launch plan (the six steps, inside the Chat tab) ------------ */

/* portal_journey's answer -> what is drawn. Never throws. */
function pctNorm(j, now){
  const x = j && typeof j === 'object' ? j : {};
  const today = pctKey(now instanceof Date ? now : new Date());
  const steps = (Array.isArray(x.steps) ? x.steps : []).filter(Boolean).slice()
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    .map(s => {
      const status = s.status === 'done' || s.status === 'doing' ? s.status : 'todo';
      const planned = pctDay(s.planned_on) ? String(s.planned_on).slice(0, 10) : '';
      const late = status !== 'done' && (typeof s.late === 'boolean' ? s.late : !!planned && planned < today);
      return { step: String(s.step || ''), title: String(s.title || s.step || 'Step'), planned, status, late };
    });
  const nextKey = String(x.next_step || '') || ((steps.find(s => s.status !== 'done') || {}).step || '');
  const idx = steps.findIndex(s => s.step === nextKey);
  const launch = pctDay(x.launch_on) ? String(x.launch_on).slice(0, 10) : ((steps.find(s => s.step === 'launch') || {}).planned || '');
  let days = x.days_to_launch != null && isFinite(Number(x.days_to_launch)) ? Math.round(Number(x.days_to_launch)) : null;
  if (days == null && launch) days = Math.round((pctDay(launch) - pctDay(today)) / PCT_DAY_MS);
  const done = steps.filter(s => s.status === 'done').length;
  return { steps, nextIndex: idx, days, launch, done, live: steps.length > 0 && done === steps.length };
}

function pctCountdown(n){
  if (n.live) return { big: 'Live', small: 'month one is running' };
  if (n.days == null) return { big: '', small: '' };
  if (n.days > 1) return { big: String(n.days), small: 'days to launch' };
  if (n.days === 1) return { big: '1', small: 'day to launch' };
  if (n.days === 0) return { big: 'Today', small: 'launch day' };
  return { big: 'Soon', small: 'launch is being rescheduled' };
}

/* The tracker. Pure. j = portal_journey's answer; opts = {open, now}. '' when there is nothing to show. */
function pctRender(j, opts){
  const o = opts || {};
  const n = pctNorm(j, o.now);
  if (!n.steps.length) return '';
  const next = n.nextIndex >= 0 ? n.steps[n.nextIndex] : null;
  const c = pctCountdown(n);
  const line = n.live ? 'All six steps done'
    : next ? 'Step ' + (n.nextIndex + 1) + ' of ' + n.steps.length + ' · ' + next.title : '';
  const items = n.steps.map((s, i) => {
    const isNext = i === n.nextIndex && !n.live;
    const cls = s.status === 'done' ? 'done' : s.late ? 'late' : isNext ? 'next' : s.status === 'doing' ? 'next' : 'todo';
    const word = s.status === 'done' ? 'Done' : s.late ? 'Running late' : isNext ? 'Up next' : s.status === 'doing' ? 'In progress' : 'Coming up';
    return '<li class="pct-step pct-' + cls + '"' + (isNext ? ' aria-current="step"' : '') + '>' +
      '<span class="pct-mark" aria-hidden="true">' + (s.status === 'done' ? '✓' : isNext ? '●' : String(i + 1)) + '</span>' +
      '<span class="pct-t">' + pctEsc(s.title) + '</span>' +
      '<span class="pct-d">' + pctEsc([s.late ? 'Late' : '', pctDate(s.planned)].filter(Boolean).join(' · ')) + '</span>' +
      '<span class="pct-sr">' + pctEsc(word) + '</span>' +
    '</li>';
  }).join('');
  const pctDone = Math.round(n.done / n.steps.length * 100);
  return '<section class="pct' + (o.open ? ' pct-open' : '') + (n.live ? ' pct-live' : '') + '" aria-label="Your launch plan">' +
    '<div class="pct-in">' +
      '<div class="pct-top">' +
        '<div class="pct-head">' +
          '<p class="pc-tag pct-kicker">Your launch plan' + (n.launch ? '<span class="pct-kd"> · ' + pctEsc(pctDate(n.launch)) + '</span>' : '') + '</p>' +
          '<p class="pct-line">' + pctEsc(line) + '</p>' +
        '</div>' +
        (c.big ? '<p class="pct-count" aria-label="' + pctEsc(c.big + ' ' + c.small) + '"><b>' + pctEsc(c.big) + '</b><span>' + pctEsc(c.small) + '</span></p>' : '') +
        '<button type="button" class="pct-toggle" data-pc-act="trackerToggle" aria-expanded="' + (o.open ? 'true' : 'false') + '" aria-controls="pctSteps">' +
          (o.open ? 'Hide steps' : 'All steps') + '</button>' +
      '</div>' +
      '<div class="pct-bar" aria-hidden="true"><span style="width:' + pctDone + '%"></span></div>' +
      '<ol class="pct-steps" id="pctSteps">' + items + '</ol>' +
    '</div>' +
  '</section>';
}

/* ---- the standing line: this month against the guarantee ------------ */

/* Only the signed-in client's rows, and only rows that say whose they are.
   A row with no client_id is dropped: a scoped answer always carries one. */
function pctMine(rows, clientId){
  const me = String(clientId == null ? '' : clientId);
  if (!me) return [];
  return (Array.isArray(rows) ? rows : []).filter(r => r && r.client_id != null && String(r.client_id) === me);
}

/* portal_month's answer (or a client_months row) -> the standing line's state.
   j is portal_journey's answer, used before month one starts. Pure. */
function pctMonthNorm(m, j, now){
  const x = m && typeof m === 'object' ? m : null;
  const today = pctDay(pctKey(now instanceof Date ? now : new Date()));
  const jn = pctNorm(j, now);
  const starts = x ? pctDay(x.starts_on) : null;
  const ends = x ? pctDay(x.ends_on) : null;
  const promised = x ? Math.round(pctNum(x.calls_promised)) : 0;
  const delivered = x ? Math.round(pctNum(x.calls_delivered)) : 0;
  const out = {
    have: false, state: 'before', monthNo: x ? Math.round(pctNum(x.month_no)) || 1 : 1,
    promised, delivered, left: Math.max(0, promised - delivered),
    daysLeft: null, total: 0, elapsed: 0, expected: 0, share: 0, pace: 0,
    band: 'none', rate: null,
    starts: starts ? pctKey(starts) : '', ends: ends ? pctKey(ends) : '',
    launch: jn.launch, toLaunch: jn.days, live: jn.live, label: x ? String(x.plan_label || '') : '',
  };
  if (!x || !starts || !ends || promised <= 0) return out;
  if (today < starts) {                       /* bought, not started */
    out.daysLeft = Math.round((starts - today) / PCT_DAY_MS);
    out.state = 'before';
    return out;
  }
  out.have = true;
  out.total = Math.max(1, Math.round((ends - starts) / PCT_DAY_MS) + 1);
  out.elapsed = Math.min(out.total, Math.max(1, Math.round((today - starts) / PCT_DAY_MS) + 1));
  /* 0 means "today IS the last day", not "the month is over": ends_on is the
     last day INSIDE the window, which is how recount_month counts a call
     (`between starts_on and ends_on`). A call booked at four o'clock on the
     last day still counts, so the month is only closed once the day is past. */
  const over = today > ends;
  out.over = over;
  out.daysLeft = Math.max(0, Math.round((ends - today) / PCT_DAY_MS));
  /* THE ONE SUM. corePace in core.js does this arithmetic for both sides of the
     business: this line, which the client reads about their own month, and the
     owner's commitment board (guarantee.js), which reads the same months across
     every client. They used to each have their own test and the two did not
     agree — the owner's was "short, and ten days or less to go", this one was
     "behind the straight line" — so a client could be told "Behind" here while
     the owner's screen left them off the list of clients who are behind.
     Checked live on 2026-11-26: that is exactly what one $9,000 Scale month was
     doing. One sum now, read twice.
     `onLine` is the gentle test and it is what decides what the CLIENT is told,
     unchanged. `band` is the harsher one and is for the owner; it is carried
     here so the client's screen and the owner's screen are provably reading the
     same numbers, and because corePace guarantees band 'ontrack' only when
     onLine is true — the owner is never more optimistic than the client. */
  out.rate = corePace(promised, delivered, out.elapsed, out.total, out.daysLeft);
  out.band = out.rate.band;
  out.expected = out.rate.expected;
  out.share = Math.max(0, Math.min(1, delivered / promised));
  /* how often a call has to land from here to finish the month on the number */
  out.pace = out.left > 0 && out.daysLeft > 0 ? out.daysLeft / out.left : 0;
  if (delivered >= promised) out.state = 'met';
  /* "Refund due" is a promise of money. It is said once the month is genuinely
     over and short — never on the last day, while a call can still land. */
  else if (over) out.state = 'short';
  /* "behind" only once a whole call behind the straight line: a client should
     never be told they are behind on a rounding error. */
  else if (!out.rate.onLine) out.state = 'behind';
  else out.state = 'ontrack';
  return out;
}

const PCT_STAMP = { met: 'Guarantee met', ontrack: 'On track', behind: 'Behind', short: 'Refund due', before: '' };

function pctStandingNote(n){
  if (n.state === 'met') return 'Your guarantee for this month is met. Every call after this is yours on top.';
  if (n.state === 'short') return 'This month closed under the number. Your refund is being worked out and we will write to you about it — you do not have to ask.';
  if (n.state === 'behind') return n.left + (n.left === 1 ? ' more call' : ' more calls') + ' to go and ' +
    (n.daysLeft === 0 ? 'today is the last day' : n.daysLeft + (n.daysLeft === 1 ? ' day' : ' days') + ' left') + '. We are behind our own pace and are pushing volume on the angles that are replying.';
  if (n.state === 'ontrack') return n.left + (n.left === 1 ? ' more call' : ' more calls') + ' to go, about one every ' + Math.max(1, Math.round(n.pace)) + (Math.round(n.pace) === 1 ? ' day' : ' days') + ' from here.';
  return '';
}

/* The standing line. Pure. '' when there is nothing honest to say yet. */
function pctStandingHtml(month, opts){
  const o = opts || {};
  const n = month && month.state ? month : pctMonthNorm(null, null, o.now);
  if (n.have) {
    const red = n.state === 'behind' || n.state === 'short';
    const stamp = PCT_STAMP[n.state] || '';
    const tick = Math.max(0, Math.min(100, Math.round((n.elapsed / Math.max(1, n.total)) * 100)));
    return '<section class="pcg' + (red ? ' pcg-off' : '') + (n.state === 'met' ? ' pcg-met' : '') + '" aria-label="This month against your guarantee">' +
      '<div class="pcg-in">' +
        '<p class="pc-tag pcg-eyebrow">Month ' + pctEsc(n.monthNo) + (n.starts ? ' · ' + pctEsc(pctDate(n.starts)) + '–' + pctEsc(pctDate(n.ends)) : '') + '</p>' +
        '<p class="pcg-rule" aria-hidden="true"></p>' +
        '<div class="pcg-row">' +
          '<p class="pcg-fig"><b><em>' + pctEsc(pctFig(n.delivered)) + '</em> <i>of</i> ' + pctEsc(pctFig(n.promised)) + '</b>' +
            '<span>booked calls</span></p>' +
          /* a month that is over does not have "0 days left": it ended, on a date */
          (n.over ? '<p class="pcg-fig pcg-days pcg-fig-words"><b>Ended</b><span>' + pctEsc(pctDate(n.ends)) + '</span></p>'
            : '<p class="pcg-fig pcg-days"><b>' + pctEsc(pctFig(n.daysLeft)) + '</b><span>' + (n.daysLeft === 1 ? 'day left' : 'days left') + '</span></p>') +
          (stamp ? '<p class="pcg-stamp">' + pctEsc(stamp) + '</p>' : '') +
        '</div>' +
        '<div class="pcg-bar"><span style="width:' + Math.round(n.share * 100) + '%"></span>' +
          '<i style="left:' + tick + '%" aria-hidden="true"></i></div>' +
        '<p class="pcg-note">' + pctEsc(pctStandingNote(n)) + '</p>' +
      '</div></section>';
  }
  const big = n.promised > 0 ? pctFig(n.promised) : '';
  /* A LATER month that has been opened but has not begun (month one ended
     yesterday, month two starts tomorrow). This used to fall into the launch
     panel below and told a client a month into the work "1 day to launch", gave
     a launch day in the past, and quoted month one's refund for month two. */
  if (n.monthNo > 1 && n.starts && n.daysLeft != null) {
    return '<section class="pcg pcg-soon" aria-label="Your guarantee">' +
      '<div class="pcg-in">' +
        '<p class="pc-tag pcg-eyebrow">Month ' + pctEsc(n.monthNo) + ' · starts ' + pctEsc(pctDate(n.starts)) + '</p>' +
        '<p class="pcg-rule" aria-hidden="true"></p>' +
        '<div class="pcg-row">' +
          (big ? '<p class="pcg-fig"><b>' + pctEsc(big) + '</b><span>booked calls promised</span></p>' : '') +
          '<p class="pcg-fig pcg-days"><b>' + pctEsc(pctFig(n.daysLeft)) + '</b><span>' + (n.daysLeft === 1 ? 'day until it starts' : 'days until it starts') + '</span></p>' +
        '</div>' +
        '<p class="pcg-note">' + pctEsc('Month ' + n.monthNo + ' starts on ' + pctDate(n.starts) + '. Miss the number in it and we refund that month in full — money back, not credit.') + '</p>' +
      '</div></section>';
  }
  /* Launched, and this page cannot see the month (pctBlind). "Not started ·
     month one" would be the opposite of the truth, and so would any number, so
     it says the one thing it knows and where to get the rest. */
  if (o.blind && (n.live || (n.toLaunch != null && n.toLaunch < 0))) {
    return '<section class="pcg pcg-soon" aria-label="Your guarantee">' +
      '<div class="pcg-in">' +
        '<p class="pc-tag pcg-eyebrow">Your guarantee</p>' +
        '<p class="pcg-rule" aria-hidden="true"></p>' +
        '<div class="pcg-row"><p class="pcg-fig pcg-fig-words"><b>Live</b><span>' + pctEsc(n.launch ? 'since ' + pctDate(n.launch) : 'your campaign is running') + '</span></p></div>' +
        '<p class="pcg-note">' + pctEsc('Your campaign is running. This page cannot show your running call count yet, so it shows no number rather than a wrong one. Ask us in Chat and we will tell you exactly where the month stands.') + '</p>' +
      '</div></section>';
  }
  /* month one has not started: say what is promised and when the clock starts */
  const when = n.launch ? pctDate(n.launch) : '';
  const days = n.daysLeft != null ? n.daysLeft : (n.toLaunch != null && n.toLaunch >= 0 ? n.toLaunch : null);
  if (!big && !when && days == null) return '';
  return '<section class="pcg pcg-soon pcg-pre" aria-label="Your guarantee">' +
    '<div class="pcg-in">' +
      '<p class="pc-tag pcg-eyebrow">Your guarantee</p>' +
      '<p class="pcg-rule" aria-hidden="true"></p>' +
      '<div class="pcg-row">' +
        (big ? '<p class="pcg-fig"><b>' + pctEsc(big) + '</b><span>booked calls a month</span></p>'
             : '<p class="pcg-fig pcg-fig-words"><b>Not started</b><span>month one</span></p>') +
        (days != null ? '<p class="pcg-fig pcg-days"><b>' + pctEsc(pctFig(days)) + '</b><span>' + (days === 1 ? 'day to launch' : 'days to launch') + '</span></p>' : '') +
      '</div>' +
      '<p class="pcg-note">' + pctEsc('The clock starts on launch day' + (when ? ', ' + when : '') + '. Miss the number in month one and we refund twice that month’s fee — money back, not credit.') + '</p>' +
    '</div></section>';
}

/* ---- the campaign tab ----------------------------------------------- */

const PCT_STEPS = ['sent', 'opened', 'replied', 'positive', 'booked'];
const PCT_STEP_LABEL = { sent: 'Emails sent', opened: 'Opened', replied: 'Replied', positive: 'Positive replies', booked: 'Calls booked' };
const PCT_STEP_SHORT = { sent: 'Sent', opened: 'Opened', replied: 'Replied', positive: 'Positive', booked: 'Calls' };

/* portal_campaign's answer -> totals, days and angles. Pure, and scoped: a row
   that does not say it is this client's is dropped. */
function pctCampaignNorm(data, clientId){
  const d = data && typeof data === 'object' ? data : {};
  const campaigns = pctMine(d.campaigns, clientId).map(c => {
    const o = { id: String(c.id == null ? '' : c.id), name: String(c.name || 'Campaign'),
      status: String(c.status || ''), started: pctDay(c.started_on) ? String(c.started_on).slice(0, 10) : '' };
    PCT_STEPS.forEach(k => { o[k] = Math.round(pctNum(c[k])) });
    return o;
  });
  const byDay = {};
  pctMine(d.daily, clientId).forEach(r => {
    const key = pctDay(r.on_day) ? String(r.on_day).slice(0, 10) : '';
    if (!key) return;
    const row = byDay[key] || (byDay[key] = { day: key, sent: 0, opened: 0, replied: 0, positive: 0, booked: 0 });
    PCT_STEPS.forEach(k => { row[k] += Math.round(pctNum(r[k])) });
  });
  const days = Object.keys(byDay).sort().map(k => byDay[k]);
  const totals = { sent: 0, opened: 0, replied: 0, positive: 0, booked: 0 };
  /* the campaign rows are the running totals the provider keeps; the daily rows
     are what we have collected. Trust the larger of the two, so a day we have
     not pulled yet never makes the headline figure go backwards. */
  const fromDays = { sent: 0, opened: 0, replied: 0, positive: 0, booked: 0 };
  days.forEach(r => PCT_STEPS.forEach(k => { fromDays[k] += r[k] }));
  const fromCamp = { sent: 0, opened: 0, replied: 0, positive: 0, booked: 0 };
  campaigns.forEach(c => PCT_STEPS.forEach(k => { fromCamp[k] += c[k] }));
  PCT_STEPS.forEach(k => { totals[k] = Math.max(fromDays[k], fromCamp[k]) });
  const angles = campaigns.slice().sort((a, b) => b.booked - a.booked || b.positive - a.positive || b.sent - a.sent);
  const live = campaigns.filter(c => /active|running|live/i.test(c.status)).length;
  const started = campaigns.map(c => c.started).filter(Boolean).sort()[0] || '';
  /* when the sending platform was last read successfully, across this client's
     campaigns. '' when we were not told — never a guess. */
  const synced = pctMine(d.campaigns, clientId)
    .map(c => { const t = Date.parse(c && c.last_synced_at); return isFinite(t) ? t : 0; })
    .reduce((a, b) => Math.max(a, b), 0);
  return { campaigns, angles, days, totals, live, started, synced: synced ? new Date(synced).toISOString() : '',
    any: totals.sent > 0 || days.length > 0 || campaigns.length > 0 };
}

/* The five figures across the top of the Campaign tab. Pure. */
function pctFunnelHtml(t){
  const o = t || {};
  const items = PCT_STEPS.map(k => {
    const base = k === 'sent' ? 0 : pctNum(o.sent);
    const rate = k === 'sent' ? '' : pctRate(o[k], base);
    return '<div class="pcf-cell' + (k === 'booked' ? ' pcf-cell-key' : '') + '">' +
      '<p class="pc-tag pcf-k">' + pctEsc(PCT_STEP_SHORT[k]) + '</p>' +
      '<p class="pcf-v">' + pctEsc(pctFig(o[k])) + '</p>' +
      '<p class="pcf-r">' + (rate ? pctEsc(rate + ' of sent') : '&#160;') + '</p>' +
    '</div>';
  }).join('');
  return '<div class="pcf" role="group" aria-label="Campaign totals">' + items + '</div>';
}

/* One hand-drawn column chart, inline SVG, no library and no remote script.
   rows: [{day:'2026-12-03', ...}]. key: which figure to draw. mark: an extra
   key drawn as a red tick above the column (the day a call was booked).
   Readable at 320px first: one viewBox, scaled by the browser. Pure. */
function pctChartHtml(rows, key, opts){
  const o = opts || {};
  const list = (Array.isArray(rows) ? rows : []).slice(-PCT_CHART_DAYS);
  if (!list.length) return '';
  const W = 360, H = o.height || 96, PAD = 16, BASE = H - 18, TOP = 14;
  const max = list.reduce((m, r) => Math.max(m, pctNum(r[key])), 0);
  const span = W - PAD * 2;
  const step = span / list.length;
  const bw = Math.max(1.5, Math.min(14, step - Math.min(3, step * 0.25)));
  const bars = list.map((r, i) => {
    const v = pctNum(r[key]);
    const x = PAD + step * i + (step - bw) / 2;
    const h = max > 0 && v > 0 ? Math.max(1.5, (v / max) * (BASE - TOP)) : 0;
    const cell = '<rect class="pctc-bar" x="' + (Math.round(x * 10) / 10) + '" y="' + (Math.round((BASE - h) * 10) / 10) + '" width="' + (Math.round(bw * 10) / 10) + '" height="' + (Math.round(h * 10) / 10) + '"></rect>';
    const m = o.mark && pctNum(r[o.mark]) > 0
      ? '<rect class="pctc-mark" x="' + (Math.round(x * 10) / 10) + '" y="' + (BASE + 2) + '" width="' + (Math.round(bw * 10) / 10) + '" height="3"></rect>' : '';
    return (h > 0 ? cell : '') + m;
  }).join('');
  const first = pctDate(list[0].day), last = pctDate(list[list.length - 1].day);
  const total = list.reduce((t, r) => t + pctNum(r[key]), 0);
  return '<figure class="pctc">' +
    '<figcaption class="pctc-cap"><span class="pc-tag">' + pctEsc(o.label || PCT_STEP_LABEL[key] || key) + '</span>' +
      '<span class="pctc-max">' + pctEsc(pctFig(max)) + ' on the best day</span></figcaption>' +
    '<svg class="pctc-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' +
      pctEsc((o.label || key) + ' by day: ' + pctFig(total) + ' in all, ' + pctFig(max) + ' at most in one day, from ' + first + ' to ' + last) + '">' +
      '<line class="pctc-axis" x1="' + PAD + '" y1="' + BASE + '" x2="' + (W - PAD) + '" y2="' + BASE + '"></line>' +
      bars +
    '</svg>' +
    '<p class="pctc-days"><span>' + pctEsc(first) + '</span><span>' + pctEsc(last) + '</span></p>' +
  '</figure>';
}

/* The by-angle table: the rule stack, one row per angle, figures right and mono. */
function pctAnglesHtml(angles){
  const list = Array.isArray(angles) ? angles : [];
  if (!list.length) return '';
  const rows = list.map(a => '<tr>' +
    '<th scope="row"><span class="pcta-n">' + pctEsc(a.name) + '</span>' +
      '<span class="pcta-s">' + pctEsc([/pause|stop/i.test(a.status) ? 'Paused' : '', a.started ? 'from ' + pctDate(a.started) : ''].filter(Boolean).join(' · ')) + '</span></th>' +
    '<td>' + pctEsc(pctFig(a.sent)) + '</td>' +
    '<td>' + pctEsc(pctFig(a.replied)) + '<span class="pcta-r">' + pctEsc(pctRate(a.replied, a.sent)) + '</span></td>' +
    '<td>' + pctEsc(pctFig(a.positive)) + '</td>' +
    '<td class="pcta-key">' + pctEsc(pctFig(a.booked)) + '</td>' +
  '</tr>').join('');
  return '<div class="pcta-wrap"><table class="pcta">' +
    '<caption class="pc-tag">By angle</caption>' +
    '<thead><tr><th scope="col">Angle</th><th scope="col">Sent</th><th scope="col">Replied</th><th scope="col">Positive</th><th scope="col">Calls</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
}

/* The numbered steps of the empty state. The one place a numeral goes red. */
function pctStepsHtml(items){
  return '<ol class="pcte-steps">' + (items || []).map((t, i) =>
    '<li><span class="pcte-no" aria-hidden="true">' + ('0' + (i + 1)).slice(-2) + '</span><span>' + pctEsc(t) + '</span></li>').join('') + '</ol>';
}

/* We asked, and the answer did not come. This is NOT the empty state: telling a
   client "nothing has been sent yet" when we simply could not read their figures
   is the one lie they would remember, and a 0 beside their guarantee reads as
   bad news about their campaign rather than about our page. So it says plainly
   that this is our end, that their numbers are safe, and how to get them back.
   Same motifs as every other panel: eyebrow, red rule, headline, lede. Pure. */
function pctFailHtml(what, eyebrow){
  const thing = String(what || 'this');
  return '<section class="pcte" aria-label="Could not load ' + pctEsc(thing) + '" role="status">' +
    '<p class="pc-tag">' + pctEsc(eyebrow || (thing === 'your booked calls' ? 'Booked calls' : 'Campaign')) + '</p>' +
    '<p class="pcte-rule" aria-hidden="true"></p>' +
    '<h2 class="pcte-h">' + pctEsc('We could not load ' + thing + ' just now.') + '</h2>' +
    /* It used to say "we try again every half minute, so this usually fixes itself".
       That is true of a dropped connection and false of a refusal: a rule that says no
       says no again every thirty seconds, for ever, while the client sits watching a
       panel that has promised to heal. This page cannot currently tell the two apart —
       see the note on pctAsk — so it promises neither, and gives a next step that works
       in both cases. Nothing here should ever put a clock on something we do not control. */
    '<p class="pcte-lede">' + pctEsc('This is our page, not your campaign — nothing has been lost and no figure has changed. '
      + 'We keep trying in the background. If it is still here after a reload, tell us in Chat and we will fix it.') + '</p>' +
    '<p class="pcte-steps pctf"><button type="button" class="pctf-btn" data-pc-act="trackerRetry">Try again</button></p>' +
  '</section>';
}

/* Day one, and no data at all. This is when a client is most anxious, so it
   says what is happening, in what order, and when the first numbers land. */
function pctCampaignEmptyHtml(month, opts){
  const o = opts || {};
  const n = month && month.state ? month : pctMonthNorm(null, null, o.now);
  const launched = n.have || n.live;
  const when = n.launch ? pctDate(n.launch) : '';
  const head = launched ? 'Sending has started. The numbers follow.'
    : when ? 'Your campaign goes live on ' + when + '.' : 'Your campaign is being built.';
  const lede = launched
    ? 'Your campaign is sending. This page fills in as the sending tool reports back to us. If it is still empty a day after your first batch, tell us in Chat and we will chase it.'
    : 'Nothing has been sent yet, so there is nothing to count. Here is the order it happens in.';
  const steps = launched
    ? ['Emails go out from our warmed inboxes, in small batches, so they land in the inbox and not the promotions tab.',
       'Opens and replies appear here once the sending tool has reported them to us.',
       'A positive reply becomes a booked call, and that call appears on the Calls tab and in your email.',
       'Every figure on this page is the provider’s own, not ours. Nothing is rounded up.']
    : ['We warm the inboxes and domains we will send from. This is quiet and takes days, not minutes.',
       'You approve the target profile, the angles and the copy in Chat. Nothing is sent before you do.',
       'Launch day: the first batch goes out, and this page starts filling in as the sending tool reports back.',
       'Your first calls usually land in the second week, and every one of them appears on the Calls tab.'];
  return '<section class="pcte" aria-label="Your campaign">' +
    '<p class="pc-tag">Campaign</p><p class="pcte-rule" aria-hidden="true"></p>' +
    '<h2 class="pcte-h">' + pctEsc(head) + '</h2>' +
    '<p class="pcte-lede">' + pctEsc(lede) + '</p>' +
    pctStepsHtml(steps) +
    '<p class="pcte-guar">' + pctEsc('Miss your agreed number of calls in month one and we refund twice that month’s fee. Miss it in any later month and we refund that month in full. Money back, not credit.') + '</p>' +
  '</section>';
}

/* "As of". The numbers on this tab are copied from a third party a few times a day,
   and a third party can be down for three days. Without a date on them a client
   reads Tuesday's figures on Friday as today's, on the tab the guarantee is argued
   over. So the tab says when it was last read — and says so more plainly once that
   is more than a day ago. When we were not told, it claims nothing about freshness.
   Pure: `now` is passed in. */
function pctAsOf(syncedIso, now){
  const t = Date.parse(syncedIso || '');
  if (!isFinite(t)) return 'Every figure here comes from the sending platform itself.';
  const mins = Math.max(0, Math.round(((now instanceof Date ? now.getTime() : Date.now()) - t) / 60000));
  const when = mins < 90 ? 'within the last hour or so'
    : mins < 60 * 20 ? 'about ' + Math.round(mins / 60) + ' hours ago'
    : mins < 60 * 36 ? 'yesterday'
    : Math.round(mins / 1440) + ' days ago';
  const base = 'Every figure here comes from the sending platform itself, last read ' + when + '.';
  return mins >= 60 * 36
    ? base + ' That is longer than usual, so these numbers may be behind. We are looking at it.'
    : base;
}

/* The Campaign tab. Pure. data = portal_campaign's answer (already scoped). */
function pctCampaignHtml(data, month, opts){
  const o = opts || {};
  const c = data && data.totals ? data : null;
  if (!c || !c.any || c.totals.sent <= 0) return pctCampaignEmptyHtml(month, o);
  return '<section class="pctp" aria-label="Your campaign">' +
    '<header class="pctp-head"><p class="pc-tag">Campaign' + (c.started ? ' · since ' + pctEsc(pctDate(c.started)) : '') + '</p>' +
      '<p class="pctp-rule" aria-hidden="true"></p>' +
      '<h2 class="pctp-h">' + pctEsc(c.live === 1 ? 'One angle sending' : c.live > 1 ? c.live + ' angles sending' : 'Sending is paused') + '</h2>' +
      '<p class="pctp-lede">' + pctEsc(pctAsOf(c.synced, o.now)) + '</p>' +
    '</header>' +
    pctFunnelHtml(c.totals) +
    '<p class="pctp-foot">' + pctEsc('“Calls” here is what the sending platform recorded. The number your guarantee is measured on is the one at the top of this page: it counts only calls that matched the profile you approved. Every one of them is on the Calls tab.') + '</p>' +
    '<div class="pctp-charts">' +
      pctChartHtml(c.days, 'sent', { label: 'Emails sent, by day', mark: 'booked' }) +
      pctChartHtml(c.days, 'replied', { label: 'Replies, by day', height: 84 }) +
      pctChartHtml(c.days, 'positive', { label: 'Positive replies, by day', height: 72 }) +
    '</div>' +
    '<p class="pctc-legend"><span class="pctc-key" aria-hidden="true"></span>' + pctEsc('A red tick under a day means a call was booked that day.') + '</p>' +
    pctAnglesHtml(c.angles) +
  '</section>';
}

/* ---- the calls tab --------------------------------------------------- */

/* portal_calls' answer -> the list. Scoped, sorted soonest first for what is
   still to come and most recent first for what has been. Pure.
   Nothing internal travels: no email address, no dispute note. */
function pctCallsNorm(data, clientId, now){
  const d = data && typeof data === 'object' ? data : {};
  const at = now instanceof Date ? now : new Date();
  const rows = pctMine(Array.isArray(d) ? d : d.calls, clientId).map(r => {
    const when = r.booked_for ? new Date(r.booked_for) : null;
    const good = when && !isNaN(when) ? when : null;
    const past = good ? good.getTime() < at.getTime() : false;
    const happened = r.happened === true ? true : r.happened === false ? false : null;
    const state = happened === true ? 'held' : !past ? 'soon' : happened === false ? 'noshow' : 'unknown';
    return {
      id: String(r.id == null ? '' : r.id),
      who: String(r.who || r.prospect_name || r.guest_name || 'A prospect'),
      title: String(r.title || r.lead_title || ''),
      company: String(r.company || r.prospect_company || r.lead_company || ''),
      at: good ? good.toISOString() : '',
      sort: good ? good.getTime() : 0,
      state, counts: r.counts !== false, icp: r.matched_icp === true,
    };
  }).filter(r => r.sort > 0);
  const soon = rows.filter(r => r.state === 'soon').sort((a, b) => a.sort - b.sort);
  const been = rows.filter(r => r.state !== 'soon').sort((a, b) => b.sort - a.sort);
  const held = been.filter(r => r.state === 'held').length;
  const noshow = been.filter(r => r.state === 'noshow').length;
  return { soon, been, all: rows, held, noshow, total: rows.length, any: rows.length > 0 };
}

const PCT_CALL_STAMP = { held: 'Turned up', noshow: 'No show', soon: 'Booked', unknown: 'Awaiting' };

function pctCallRowHtml(r){
  const when = typeof pcWhen === 'function' ? pcWhen(r.at) : '';
  return '<li class="pctl-row pctl-' + r.state + '">' +
    '<p class="pctl-when">' + pctEsc(when || '') + '</p>' +
    '<p class="pctl-who">' + pctEsc(r.who) + '</p>' +
    '<p class="pctl-co">' + pctEsc([r.title, r.company].filter(Boolean).join(' · ')) + '</p>' +
    '<p class="pctl-stamp">' + pctEsc(PCT_CALL_STAMP[r.state] || '') + '</p>' +
  '</li>';
}

function pctCallsEmptyHtml(month, opts){
  const o = opts || {};
  const n = month && month.state ? month : pctMonthNorm(null, null, o.now);
  const promised = n.promised > 0 ? n.promised : 0;
  /* Launched, and this page cannot see their calls (pctBlind). "Your first call
     has not been booked yet" to a client who took six of them is the confident
     zero this file exists to avoid. */
  if (o.blind && (n.have || n.live || (n.toLaunch != null && n.toLaunch < 0))) {
    return '<section class="pcte" aria-label="Your booked calls">' +
      '<p class="pc-tag">Booked calls</p><p class="pcte-rule" aria-hidden="true"></p>' +
      '<h2 class="pcte-h">' + pctEsc('Your booked calls are not listed on this page yet.') + '</h2>' +
      '<p class="pcte-lede">' + pctEsc('That is about this page, not about your calls. Every call we book is emailed to you with the name, the company and the time, and goes into your calendar. For the full list or the count so far, ask us in Chat.') + '</p>' +
    '</section>';
  }
  const head = n.have ? 'No calls booked yet this month.' : 'Your first call has not been booked yet.';
  const lede = n.have
    ? 'Sending has started. A prospect who replies and is a fit books straight into your calendar, and lands here the moment they do.'
    : 'Nothing is booked before your campaign goes live and your copy is approved. When the first prospect books, this page fills in by itself.';
  const steps = ['A prospect replies, and we answer within the hour in working time.',
    'If they are a fit against the profile you approved, we put a time in your calendar.',
    'You get an email with the name, the company and the time. It appears here at the same moment.',
    'After the call we mark whether they turned up. Only a call that matches your profile counts towards the guarantee.'];
  return '<section class="pcte" aria-label="Your booked calls">' +
    '<p class="pc-tag">Booked calls</p><p class="pcte-rule" aria-hidden="true"></p>' +
    '<h2 class="pcte-h">' + pctEsc(head) + '</h2>' +
    '<p class="pcte-lede">' + pctEsc(lede) + '</p>' +
    pctStepsHtml(steps) +
    (promised ? '<p class="pcte-guar">' + pctEsc('Your plan promises ' + promised + ' booked calls a month. Miss it in month one and we refund twice that month’s fee — money back, not credit.') + '</p>' : '') +
  '</section>';
}

/* The Calls tab. Pure. */
function pctCallsHtml(data, month, opts){
  const o = opts || {};
  const c = data && data.all ? data : null;
  if (!c || !c.any) return pctCallsEmptyHtml(month, o);
  const head = c.soon.length
    ? (c.soon.length === 1 ? 'One call coming up' : c.soon.length + ' calls coming up')
    : 'No calls on the books right now';
  return '<section class="pctp" aria-label="Your booked calls">' +
    '<header class="pctp-head"><p class="pc-tag">Booked calls</p>' +
      '<p class="pctp-rule" aria-hidden="true"></p>' +
      '<h2 class="pctp-h">' + pctEsc(head) + '</h2>' +
      '<p class="pctp-lede">' + pctEsc(c.held + (c.held === 1 ? ' call has' : ' calls have') + ' been held' + (c.noshow ? ', ' + c.noshow + ' did not turn up' : '') + '. A no-show does not count against your guarantee.') + '</p>' +
    '</header>' +
    (c.soon.length ? '<h3 class="pctl-h pc-tag">Coming up</h3><ul class="pctl">' + c.soon.map(pctCallRowHtml).join('') + '</ul>' : '') +
    (c.been.length ? '<h3 class="pctl-h pc-tag">Been and gone</h3><ul class="pctl">' + c.been.map(pctCallRowHtml).join('') + '</ul>' : '') +
  '</section>';
}

/* ---- the stylesheet, added once ------------------------------------- */

const PCT_CSS = `
.pct-box,.pc-tracker-box{flex:0 0 auto}
.pct{border-bottom:1px solid var(--pc-line,#DCDCE0);background:#fff}
.pct-in{max-width:820px;margin:0 auto;padding:14px 24px 16px}
.pct-top{display:flex;align-items:center;gap:16px}
.pct-head{flex:1 1 auto;min-width:0}
.pct-kicker{font-size:11px;margin:0}
.pct-line{font-size:17px;line-height:1.3;font-weight:800;letter-spacing:-.02em;margin:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pct-count{display:flex;align-items:baseline;gap:8px;margin:0;flex:0 0 auto}
.pct-count b{font-size:34px;line-height:1;font-weight:800;letter-spacing:-.04em;color:#0A0A0C;font-family:var(--pc-mono,monospace);font-variant-numeric:tabular-nums}
.pct-count span{font-family:var(--pc-mono,monospace);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--pc-grey,#63636A);max-width:7.5em;line-height:1.3}
.pct-live .pct-count b{color:#000}
.pct-toggle{display:none;min-height:44px;padding:0 14px;border:2px solid #000;border-radius:0;background:#fff;color:#000;font:400 11px var(--pc-mono,monospace);letter-spacing:.14em;text-transform:uppercase;cursor:pointer;flex:0 0 auto}
.pct-toggle:hover{background:#000;color:#fff}
.pct-bar{height:3px;background:var(--pc-line,#DCDCE0);margin:14px 0 0}
.pct-bar span{display:block;height:100%;background:#000}
.pct-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr))}
.pct-step{position:relative;display:flex;flex-direction:column;gap:2px;padding:12px 10px 0 0;min-width:0;border-top:3px solid transparent;margin-top:-3px}
.pct-done{border-top-color:#000}
.pct-next{border-top-color:var(--pc-red,#E0290F)}
.pct-late{border-top-color:var(--pc-red,#E0290F)}
.pct-mark{display:inline-grid;place-items:center;width:24px;height:24px;margin-bottom:6px;border:2px solid #000;font:700 12px/1 var(--pc-mono,monospace);color:#000;background:#fff}
.pct-done .pct-mark{background:#000;color:#fff}
.pct-next .pct-mark{background:var(--pc-red,#E0290F);border-color:var(--pc-red,#E0290F);color:#fff;font-size:10px}
.pct-late .pct-mark{border-color:var(--pc-red,#E0290F);color:var(--pc-red,#E0290F)}
.pct-todo .pct-mark{border-color:var(--pc-line,#DCDCE0);color:var(--pc-grey,#63636A)}
.pct-t{font-size:14px;line-height:1.25;font-weight:700;letter-spacing:-.01em;overflow-wrap:break-word}
.pct-todo .pct-t{color:var(--pc-grey,#63636A);font-weight:600}
.pct-d{font-family:var(--pc-mono,monospace);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--pc-grey,#63636A)}
.pct-late .pct-d{color:var(--pc-red,#E0290F);font-weight:700}
.pct-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* ---- the standing line ---- */
.pc-standing{flex:0 0 auto}
.pcg{background:var(--pc-sand,#F4EFE9);border-bottom:1px solid var(--pc-line,#DCDCE0)}
.pcg-in{max-width:820px;margin:0 auto;padding:16px 24px 18px}
.pcg-eyebrow{margin:0;font-size:11px}
.pcg-rule{width:24px;height:2px;background:#0A0A0C;margin:7px 0 10px}
.pcg-row{display:flex;align-items:flex-end;gap:22px;flex-wrap:wrap}
.pcg-fig{margin:0;min-width:0}
.pcg-fig b{display:block;font-family:var(--pc-mono,monospace);font-variant-numeric:tabular-nums;font-size:40px;line-height:1;font-weight:700;letter-spacing:-.03em;color:#0A0A0C}
.pcg-fig b i{font-style:normal;font-size:22px;font-weight:400;color:var(--pc-grey,#63636A);padding:0 2px}
.pcg-fig span{display:block;margin-top:7px;font-family:var(--pc-mono,monospace);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--pc-grey,#63636A)}
.pcg-fig-words b{font-family:var(--pc-sans,sans-serif);font-size:30px;font-weight:800}
.pcg-days{padding-left:22px;border-left:1px solid var(--pc-line,#DCDCE0)}
.pcg-days b{font-size:30px}
.pcg-fig b em{font-style:normal}
.pcg-off .pcg-fig b em{color:var(--pc-red-text,#C42408)}
.pcg-stamp{margin:0 0 4px auto;padding:7px 12px;border:2px solid #0A0A0C;font:400 11px/1 var(--pc-mono,monospace);letter-spacing:.14em;text-transform:uppercase;color:#0A0A0C;white-space:nowrap}
.pcg-off .pcg-stamp{border-color:var(--pc-red-text,#C42408);color:var(--pc-red-text,#C42408)}
.pcg-bar{position:relative;height:6px;background:#fff;border:1px solid var(--pc-line,#DCDCE0);margin:16px 0 0}
.pcg-bar span{display:block;height:100%;background:#0A0A0C}
.pcg-bar i{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--pc-grey,#63636A)}
.pcg-note{margin:10px 0 0;font-size:15px;line-height:1.5;color:#0A0A0C;max-width:52ch}

/* ---- the tabs ---- */
.pc-tabs{flex:0 0 auto;background:#fff;border-bottom:2px solid #0A0A0C}
.pc-tabs-in{max-width:820px;margin:0 auto;padding:0 24px;display:flex;gap:4px}
.pc-tab{appearance:none;-webkit-appearance:none;background:transparent;border:0;border-bottom:3px solid transparent;margin-bottom:-2px;padding:14px 14px 12px;min-height:48px;font:400 12px/1 var(--pc-mono,monospace);letter-spacing:.14em;text-transform:uppercase;color:var(--pc-grey,#63636A);cursor:pointer;white-space:nowrap}
.pc-tab:hover{color:#0A0A0C}
.pc-tab[aria-selected="true"]{color:#0A0A0C;border-bottom-color:#0A0A0C;font-weight:700}
.pc-tab b{font-weight:700;font-variant-numeric:tabular-nums}
.pc-panels{flex:1 1 auto;min-height:0;display:flex}
.pc-panel{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column}
.pc-panel[hidden]{display:none}
.pc-sheet{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch}
.pc-sheet-in{max-width:820px;margin:0 auto;padding:28px 24px 64px}

/* ---- a data tab ---- */
.pctp-head{margin:0 0 26px}
.pctp-rule{width:24px;height:2px;background:#0A0A0C;margin:7px 0 12px}
.pctp-h{font-size:clamp(28px,7vw,38px);line-height:1.04;font-weight:800;letter-spacing:-.035em;margin:0}
.pctp-lede{margin:10px 0 0;font-size:16px;line-height:1.5;color:var(--pc-grey,#63636A);max-width:48ch}
.pcf{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-top:2px solid #0A0A0C;border-bottom:1px solid var(--pc-line,#DCDCE0)}
.pcf-cell{padding:14px 10px 16px 0;min-width:0}
.pcf-k{margin:0;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pcf-v{margin:6px 0 0;font-family:var(--pc-mono,monospace);font-variant-numeric:tabular-nums;font-size:clamp(20px,5vw,30px);line-height:1;font-weight:700;letter-spacing:-.03em}
.pcf-r{margin:6px 0 0;font-family:var(--pc-mono,monospace);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--pc-grey,#63636A)}
.pcf-cell-key .pcf-v{color:var(--pc-red-text,#C42408)}
.pctp-wait{margin:0}
.pctp-foot{margin:12px 0 0;font-size:13px;line-height:1.55;color:var(--pc-grey,#63636A);max-width:54ch}
.pctp-charts{margin:30px 0 0}
.pctc{margin:0 0 26px}
.pctc-cap{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 8px}
.pctc-cap .pc-tag{font-size:11px}
.pctc-max{font-family:var(--pc-mono,monospace);font-size:11px;letter-spacing:.06em;color:var(--pc-grey,#63636A);font-variant-numeric:tabular-nums}
.pctc-svg{display:block;width:100%;height:96px}
.pctc-bar{fill:#0A0A0C}
.pctc-mark{fill:var(--pc-red-text,#C42408)}
.pctc-axis{stroke:var(--pc-line,#DCDCE0);stroke-width:1}
.pctc-days{display:flex;justify-content:space-between;margin:4px 0 0;font-family:var(--pc-mono,monospace);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--pc-grey,#63636A)}
.pctc-legend{display:flex;align-items:center;gap:8px;margin:0 0 30px;font-size:13px;line-height:1.5;color:var(--pc-grey,#63636A)}
.pctc-key{flex:0 0 auto;width:14px;height:3px;background:var(--pc-red-text,#C42408)}
.pcta-wrap{overflow-x:auto}
.pcta{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.pcta caption{text-align:left;padding:0 0 8px}
.pcta th,.pcta td{text-align:right;padding:11px 0 11px 12px;font-family:var(--pc-mono,monospace);font-size:13px;font-weight:400;border-bottom:1px solid var(--pc-line,#DCDCE0)}
.pcta thead th{border-top:2px solid #0A0A0C;border-bottom:1px solid var(--pc-line,#DCDCE0);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--pc-grey,#63636A);white-space:nowrap}
.pcta tbody th{text-align:left;padding-left:0}
.pcta-n{display:block;font-family:var(--pc-sans,sans-serif);font-size:15px;font-weight:700;letter-spacing:-.01em;overflow-wrap:anywhere}
.pcta-s{display:block;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--pc-grey,#63636A)}
.pcta-r{display:block;font-size:10px;color:var(--pc-grey,#63636A)}
.pcta-key{font-weight:700;font-size:15px}

/* ---- the calls list ---- */
.pctl-h{margin:26px 0 0;padding-top:14px;border-top:2px solid #0A0A0C;font-size:11px}
.pctl{list-style:none;margin:10px 0 0;padding:0}
.pctl-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 14px;padding:14px 0;border-bottom:1px solid var(--pc-line,#DCDCE0)}
.pctl-when{grid-column:1;margin:0;font-family:var(--pc-mono,monospace);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--pc-grey,#63636A);font-variant-numeric:tabular-nums}
.pctl-who{grid-column:1;margin:2px 0 0;font-size:17px;line-height:1.25;font-weight:800;letter-spacing:-.02em;overflow-wrap:anywhere}
.pctl-co{grid-column:1;margin:2px 0 0;font-size:14px;line-height:1.4;color:var(--pc-grey,#63636A);overflow-wrap:anywhere}
.pctl-stamp{grid-column:2;grid-row:1 / span 3;align-self:start;margin:0;padding:6px 10px;border:2px solid var(--pc-line,#DCDCE0);font:400 10px/1 var(--pc-mono,monospace);letter-spacing:.14em;text-transform:uppercase;color:var(--pc-grey,#63636A);white-space:nowrap}
.pctl-held .pctl-stamp{border-color:#0A0A0C;color:#0A0A0C}
.pctl-soon .pctl-stamp{border-color:#0A0A0C;color:#0A0A0C}
.pctl-noshow .pctl-stamp{border-color:var(--pc-red-text,#C42408);color:var(--pc-red-text,#C42408)}
.pctl-noshow .pctl-who{color:var(--pc-grey,#63636A)}

/* ---- an empty tab: the one that matters most ---- */
.pcte{max-width:46ch}
.pcte-rule{width:24px;height:2px;background:var(--pc-red-text,#C42408);margin:7px 0 14px}
.pcte-h{font-size:clamp(30px,8vw,44px);line-height:1.02;font-weight:800;letter-spacing:-.04em;margin:0}
.pcte-lede{margin:14px 0 0;font-size:17px;line-height:1.55;color:var(--pc-grey,#63636A)}
.pcte-steps{list-style:none;margin:28px 0 0;padding:16px 0 0;border-top:2px solid #0A0A0C}
.pcte-steps li{display:grid;grid-template-columns:40px minmax(0,1fr);gap:0 10px;padding:13px 0;border-bottom:1px solid var(--pc-line,#DCDCE0);font-size:15px;line-height:1.5}
.pcte-steps.pctf{padding:20px 0 0;border-bottom:0}
.pctf-btn{min-height:44px;padding:0 18px;border:2px solid #0A0A0C;border-radius:0;background:#fff;color:#0A0A0C;font:400 11px var(--pc-mono,monospace);letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
.pctf-btn:hover{background:#0A0A0C;color:#fff}
.pcte-no{font-family:var(--pc-mono,monospace);font-size:13px;font-weight:700;letter-spacing:.04em;color:#0A0A0C}
.pcte-guar{margin:30px 0 0;padding:18px 20px;background:var(--pc-sand,#F4EFE9);border-left:3px solid var(--pc-red-text,#C42408);font-size:17px;line-height:1.55}

@media (max-width:640px){
  .pct-in{padding:10px 14px 12px}
  .pct-top{gap:12px}
  .pct-line{font-size:15px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .pct-kd{display:none}
  .pct-toggle{padding:0 10px}
  .pct-count{flex-direction:column;align-items:flex-end;gap:0}
  .pct-count b{font-size:26px}
  .pct-count span{font-size:9px;text-align:right}
  .pct-toggle{display:inline-block}
  .pct-bar{margin-top:10px}
  .pct-steps{display:none}
  .pct-open .pct-steps{display:block;margin-top:6px}
  .pct-open .pct-step{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:0 8px;padding:9px 0;margin:0;border-top:1px solid var(--pc-line,#DCDCE0)}
  .pct-open .pct-step:first-child{border-top:0}
  .pct-open .pct-mark{margin:0}
  .pct-open .pct-d{text-align:right}
  .pcg-in{padding:13px 14px 15px}
  .pcg-row{gap:0 16px}
  .pcg-days{padding-left:16px}
  .pcg-fig b{font-size:34px}
  .pcg-days b{font-size:24px}
  .pcg-stamp{margin-left:auto;padding:6px 9px;font-size:10px}
  .pcg-note{font-size:14px;margin-top:9px}
  /* Before launch, on a phone, this panel and the launch plan under it took half
     the screen between them and left the chat — where the kickoff times, the form
     and the approvals all are — a strip a few lines tall. The plan already gives
     the countdown, so here the panel keeps its figures and drops its paragraph;
     the same sentence is on the Campaign tab. */
  .pcg-pre .pcg-note{display:none}
  .pcg-pre .pcg-fig-words b{font-size:24px}
  .pcg-pre .pcg-fig b{font-size:26px}
  .pc-tabs-in{padding:0 8px}
  .pc-tab{padding:13px 10px 11px;font-size:11px;letter-spacing:.1em}
  .pc-sheet-in{padding:22px 14px 56px}
  .pcf{grid-template-columns:repeat(3,minmax(0,1fr))}
  .pcf-cell{border-bottom:1px solid var(--pc-line,#DCDCE0);padding-right:8px}
  .pcf-cell:nth-child(4),.pcf-cell:nth-child(5){border-bottom:0}
  .pcf-cell:nth-last-child(-n+2){padding-bottom:12px}
  .pctc-svg{height:84px}
  .pcta th,.pcta td{padding-left:9px;font-size:12px}
  .pcte-guar{font-size:16px;padding:16px 16px}
}
@media (prefers-reduced-motion:no-preference){.pc-panel{scroll-behavior:smooth}}`;

function pctStyle(){
  if (typeof document === 'undefined' || !document.getElementById || document.getElementById('pctCss')) return;
  try {
    const s = document.createElement('style');
    s.id = 'pctCss';
    s.textContent = PCT_CSS;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* a page without a head: unstyled but working */ }
}

/* ---- drawing -------------------------------------------------------- */

function pctBox(id){
  return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
}
function pctPut(id, html, was){
  const el = pctBox(id);
  if (!el) return was;
  if (el.innerHTML === html) return html;
  el.innerHTML = html;
  return html;
}

/* What a tab shows between being opened and being answered. */
function pctWaitHtml(){
  return '<p class="pc-tag pctp-wait" aria-busy="true">Loading</p>';
}

function pctPaint(el){
  if (!el) return;
  const html = pctRender(pct.data, { open: pct.open });
  if (html === pct.drawn) return;   /* nothing changed: no flicker on every refresh */
  pct.drawn = html;
  el.innerHTML = html;
}

/* The month the standing line is drawn from, whichever way it arrived. */
function pctMonth(){
  return pctMonthNorm(pct.month, pct.data);
}

function pctPaintAll(){
  const m = pctMonth();
  /* Once month one is running the six steps are history, and the standing line
     above the tabs says everything the launch plan used to. Two countdowns on
     one screen is one too many, so the plan steps down. */
  const box = pctBox('pcTracker');
  if (m.have) { if (box && box.innerHTML !== '') { box.innerHTML = ''; } pct.drawn = ''; }
  else pctPaint(box);
  /* The standing line is the one figure a refund turns on, so it is the last
     place that may guess. If the month could not be read, "Not started · month
     one" is not a smaller version of the truth, it is the opposite of it: a
     client fifteen days into a running month, with calls already booked, read
     that their clock had not started yet. So a failed read says so, in the same
     words the other two panels use, and the retry button is right there. */
  const standing = pct.monthFailed ? pctFailHtml('where this month stands', 'Your guarantee')
    : pctStandingHtml(m, { blind: pct.monthBlind });
  if (standing !== pct.standing) pct.standing = pctPut('pcStanding', standing, pct.standing);
  /* A tab is drawn only once it has been asked AND answered. Before that it
     waits: telling a client "no calls yet" while their calls are still loading
     would be a lie, and the one they would remember. And an ask that failed
     says so — it never falls through to the empty state, which would put a 0
     next to their guarantee and read as bad news about their campaign. */
  const campaign = pct.campaignFailed ? pctFailHtml('your campaign numbers')
    : pct.campaignAt ? pctCampaignHtml(pct.campaign, m) : (pct.tab === 'campaign' ? pctWaitHtml() : '');
  if (campaign !== pct.campaignDrawn) pct.campaignDrawn = pctPut('pcCampaign', campaign, pct.campaignDrawn);
  const calls = pct.callsFailed ? pctFailHtml('your booked calls')
    : pct.callsAt ? pctCallsHtml(pct.calls, m, { blind: pct.callsBlind }) : (pct.tab === 'calls' ? pctWaitHtml() : '');
  if (calls !== pct.callsDrawn) pct.callsDrawn = pctPut('pcCalls', calls, pct.callsDrawn);
}

/* ---- asking ---------------------------------------------------------- */

/* "We asked and the asking itself failed." Returned instead of null so that a
   caller can tell it apart from "we asked and there is genuinely nothing yet" —
   the two look identical to a client and mean opposite things. */
const PCT_FAIL = { pctFail: true };
function pctFailed(v){ return v === PCT_FAIL }

/* ONE retry, and only here. Everything this file asks for is a read — a SELECT
   or a read-only RPC — so asking twice cannot book, send, charge or mark
   anything. A client on hotel wifi should not be told their campaign numbers
   are gone because one request dropped. Nothing that writes is retried
   anywhere: the client's own Send and Book go once and once only, because a
   repeated write is a second message or a second call in the diary. */
const PCT_RETRY_MS = 300;
function pctPause(ms){
  if (typeof setTimeout !== 'function') return Promise.resolve();
  return new Promise(r => setTimeout(r, ms));
}
/* Worth a second ask: it dropped, timed out, or came back as nothing at all.
   "Permission denied" and "no such function" are answers, not blips, and are
   never asked twice. */
function pctBlip(r, threw){
  if (threw) return true;
  if (!r || typeof r !== 'object') return true;
  if (r.ok) return false;
  return /failed to fetch|networkerror|network request|load failed|fetch failed|timeout|timed out|aborted|socket|502|503|504/i.test(String(r.error || ''));
}
/* A request that never answers is the worst of the lot: no error is thrown, no
   promise settles, and the tab reads "Loading" until the client gives up and
   closes the page. Every read here is given a limit — past it, it counts as a
   drop, which means one retry and then an honest failure panel. */
const PCT_READ_MS = 10000;
async function pctOnce(fn){
  const limit = Number(pct.readMs) > 0 ? Number(pct.readMs) : PCT_READ_MS;
  let timer = null;
  try {
    const run = Promise.resolve().then(fn);
    if (typeof setTimeout !== 'function') return { r: await run, threw: false };
    const capped = new Promise((_, no) => { timer = setTimeout(() => no(new Error('That took too long.')), limit); });
    return { r: await Promise.race([run, capped]), threw: false };
  }
  catch (e) { return { r: null, threw: true } }
  finally { if (timer && typeof clearTimeout === 'function') clearTimeout(timer) }
}
/* -> {r, threw}: the answer, and whether the asking itself blew up both times. */
async function pctReadTwice(fn, isBlip){
  const blip = typeof isBlip === 'function' ? isBlip : pctBlip;
  let out = await pctOnce(fn);
  if (!blip(out.r, out.threw)) return out;
  await pctPause(PCT_RETRY_MS);
  return await pctOnce(fn);
}

/* One RPC, with a fallback for the day it does not exist yet. A missing
   function is remembered so it is asked for only once a session; a real error
   (offline, not allowed) is NOT papered over with a guess.

   KNOWN GAP, deliberately left rather than guessed at during integration: this
   returns one PCT_FAIL for every kind of failure, so the panel cannot tell a
   dropped connection (trying again IS the fix) from a refusal by row level
   security (trying again is never the fix, and the half-minute retry runs for
   ever). core.js already makes exactly this distinction in coreFamily() —
   'offline' versus 'no-access' — and the right fix is a second marker here that
   carries the family through, so the panel can say "we are retrying" or "this is
   not open to your login" as appropriate. Until then pctFailHtml() promises
   neither. This is live-reachable today: portal_client_id() and the outreach_*
   client-read policies are not in the database, so a client on the Campaign tab
   can land on the refusal branch. */
async function pctAsk(ctx, name, args, fallback){
  if (!pct.gone[name] && ctx && typeof ctx.rpc === 'function') {
    const r = (await pctReadTwice(() => ctx.rpc(name, args || {}))).r;
    if (r && r.ok) return r.data == null ? null : r.data;
    /* `missing` is set by pcErr in portal-client.js. The words themselves never
       arrive here: pcPlain replaces the database's message before a client can
       read it, so a test on the sentence (which is what this used to be) could
       not match, the fallback below never ran, and every client was shown three
       "We could not load…" panels for as long as these functions did not exist —
       which is the live database today. The sentence is still tested, for a
       caller that hands the raw message straight through. */
    const msg = String((r && r.error) || '');
    if (!(r && r.missing) && !/could not find the function|does not exist|schema cache|not found/i.test(msg)) return PCT_FAIL;
    pct.gone[name] = true;
  }
  if (typeof fallback !== 'function') return PCT_FAIL;
  /* the fallback reads tables and throws on a real error; a null answer from it
     means "nothing there yet", which is not a failure */
  const out = await pctReadTwice(fallback, (r, threw) => threw);
  return out.threw ? PCT_FAIL : out.r;
}

/* Rows from one table, this client's only. Whatever row level security does
   not allow simply comes back empty, and the tab shows its empty state — but a
   database that answers with an error, or does not answer at all, is a failure
   and throws, so pctAsk() reports it instead of passing an empty list on as if
   the client had no campaign. */
async function pctRows(sb, table, cols, clientId, shape){
  /* No client id means portal_journey did not answer, so we do not know WHOSE rows to
     ask for. Returning [] here was the worst kind of wrong: every fallback read came
     back empty without a query ever going out, and the tabs drew "nothing yet" — a
     client whose month was running read "Not started" beside the guarantee it is
     settled on. An unknown client is a failure to report, never an empty answer. */
  if (!clientId) throw new Error('We do not know which account to look up yet.');
  if (!sb || typeof sb.from !== 'function') return [];
  let q = sb.from(table).select(cols).eq('client_id', clientId);
  if (typeof shape === 'function') q = shape(q) || q;
  const res = await q.limit(PCT_MAX_ROWS);
  if (!res || res.error || !Array.isArray(res.data)) throw new Error('That table could not be read.');
  return res.data;
}

/* True when an empty answer cannot be trusted. The scoped function is missing, so
   the answer came from reading the table directly — and in a database without
   that function, row level security has no rule for a client either (both come
   from the same update): the table answers with no rows and no error whether the
   client has ten calls or none. Empty then means "we cannot see". An answer WITH
   rows is believed either way. */
function pctBlind(name, empty){
  return !!(pct.gone[name] && empty);
}

function pctClientId(){
  const d = pct.data && typeof pct.data === 'object' ? pct.data : {};
  const m = pct.month && typeof pct.month === 'object' ? pct.month : {};
  return String(d.client_id || m.client_id || '') || '';
}

async function pctLoadMonth(ctx, clientId){
  return pctAsk(ctx, 'portal_month', {}, async () => {
    const rows = await pctRows(ctx && ctx.sb, 'client_months',
      'client_id,month_no,starts_on,ends_on,calls_promised,calls_delivered', clientId,
      (q) => q.order('month_no', { ascending: false }));
    const mine = pctMine(rows, clientId);
    if (!mine.length) return null;
    const today = pctKey(new Date());
    return mine.find(r => String(r.starts_on || '').slice(0, 10) <= today && today <= String(r.ends_on || '').slice(0, 10)) || mine[0];
  });
}

async function pctLoadCampaign(ctx, clientId){
  return pctAsk(ctx, 'portal_campaign', {}, async () => {
    const sb = ctx && ctx.sb;
    /* The campaigns and the day-by-day numbers do not depend on each other, so
       the client waits for one read rather than two. If either throws, pctAsk
       still reports it — Promise.all passes the first rejection straight on. */
    const [campaigns, daily] = await Promise.all([
      pctRows(sb, 'outreach_campaigns',
        'id,client_id,name,status,started_on,sent,opened,replied,positive,booked,last_synced_at', clientId),
      pctRows(sb, 'outreach_daily',
        'client_id,on_day,sent,opened,replied,positive,booked', clientId,
        /* newest first. This used to ask for the oldest rows first, so once a client
           had more days than the row ceiling the chart silently stopped at a date in
           the past and the recent days — the ones they came to see — were the ones
           dropped. pctCampaignNorm sorts by day itself, so the order here only
           decides which rows survive the limit. */
        (q) => q.order('on_day', { ascending: false })),
    ]);
    return { client_id: clientId, campaigns, daily };
  });
}

async function pctLoadCalls(ctx, clientId){
  return pctAsk(ctx, 'portal_calls', {}, async () => {
    const sb = ctx && ctx.sb;
    /* The calls and the titles that go beside them are two reads of two
       different tables; neither waits on the other. */
    const [calls, threads] = await Promise.all([
      pctRows(sb, 'qualified_calls',
        'id,client_id,prospect_name,prospect_company,booked_for,happened,happened_at,matched_icp,counts', clientId,
        (q) => q.order('booked_for', { ascending: false })),
      /* a prospect's title, where the thread that booked the call carries one */
      pctRows(sb, 'outreach_threads', 'client_id,lead_name,lead_company,lead_title', clientId),
    ]);
    const title = {};
    pctMine(threads, clientId).forEach(t => {
      const k = String(t.lead_name || '').trim().toLowerCase();
      if (k && t.lead_title) title[k] = t.lead_title;
    });
    return { client_id: clientId, calls: pctMine(calls, clientId).map(c => Object.assign({}, c, {
      who: c.prospect_name, company: c.prospect_company,
      title: title[String(c.prospect_name || '').trim().toLowerCase()] || '',
    })) };
  });
}

/* Called when the chat opens, when a tab is shown, and after every refresh.
   Each thing is asked for at most every 30 seconds, and the tabs that have not
   been opened are not asked for at all. */
async function pctMount(ctx){
  const el = pctBox('pcTracker');
  if (!ctx || typeof ctx.rpc !== 'function') return;
  pctStyle();
  /* A different client signing in on the same browser must not be shown the last client's
     anything, not even for the moment before theirs loads. */
  const h = ctx.home || {};
  const who = String((h.person && h.person.id) || '') + '|' + String((h.channel && h.channel.id) || '');
  if (who !== pct.who) {
    pct.who = who;
    pct.data = null; pct.at = 0; pct.drawn = ''; pct.open = false;
    pct.month = null; pct.monthAt = 0; pct.monthFailed = false; pct.monthBlind = false; pct.callsBlind = false;
    pct.campaign = null; pct.campaignAt = 0; pct.campaignFailed = false; pct.campaignDrawn = '';
    pct.calls = null; pct.callsAt = 0; pct.callsFailed = false; pct.callsDrawn = '';
    pct.standing = '';
    ['pcTracker', 'pcStanding', 'pcCampaign', 'pcCalls'].forEach(id => { const b = pctBox(id); if (b) b.innerHTML = '' });
  }
  if (el && !el.firstChild) pct.drawn = '';   /* the chat was drawn again from scratch */
  /* …and so were the other three boxes. Signing out and back in as the same
     person rebuilds the page with them empty, while this file still remembered
     what it had last put in each — so it saw "nothing changed" and drew nothing:
     no guarantee line, and two blank tabs, until a figure happened to move. */
  [['pcStanding', 'standing'], ['pcCampaign', 'campaignDrawn'], ['pcCalls', 'callsDrawn']].forEach(function(p){
    const b = pctBox(p[0]);
    if (b && !b.firstChild && pct[p[1]]) pct[p[1]] = '';
  });
  if (typeof PC !== 'undefined' && PC && PC.tab) pct.tab = String(PC.tab);
  pctPaintAll();

  const now = Date.now();
  if (!pct.busy && !(pct.at && now - pct.at < PCT_ASK_MS)) {
    pct.busy = true;
    let r;
    /* a read like any other: one retry on a drop, and a limit so it cannot hang */
    try { r = (await pctReadTwice(() => ctx.rpc('portal_journey', {}))).r; }
    catch (e) { r = { ok: false }; }
    finally { pct.busy = false }
    if (who !== pct.who) return;          /* someone else signed in while this was on its way */
    pct.at = Date.now();
    if (r && r.ok) pct.data = r.data || null;
    pctPaintAll();
  }
  const clientId = pctClientId();
  /* The page calls this twice as it opens: once straight away and once when the
     first messages arrive. If the second call got here while the first was still
     waiting for portal_journey, it had no client id, the table read refused to
     guess whose rows to ask for, and the guarantee line opened on "We could not
     load where this month stands" and stayed there for half a minute. The call
     that is waiting carries on down to here by itself once it knows, so this one
     has nothing to add. */
  if (!clientId && pct.busy) return;
  if (!pct.monthBusy && !(pct.monthAt && Date.now() - pct.monthAt < PCT_ASK_MS)) {
    pct.monthBusy = true;
    let m;
    try { m = await pctLoadMonth(ctx, clientId); }
    finally { pct.monthBusy = false }   /* a flag left true never asks again, and the page never recovers */
    if (who !== pct.who) return;
    /* The stamp is set either way, so a database that is down is asked again in
       half a minute rather than on every single refresh. */
    pct.monthAt = Date.now();
    pct.monthFailed = pctFailed(m);
    if (pct.monthFailed) m = null;
    pct.month = m || null;
    pct.monthBlind = !pct.monthFailed && pctBlind('portal_month', !m);
    pctPaintAll();
  }
  if (pct.tab === 'campaign' && !pct.campaignBusy && !(pct.campaignAt && Date.now() - pct.campaignAt < PCT_ASK_MS)) {
    pct.campaignBusy = true;
    let c;
    try { c = await pctLoadCampaign(ctx, clientId); }
    finally { pct.campaignBusy = false }
    if (who !== pct.who) return;
    pct.campaignAt = Date.now();
    pct.campaignFailed = pctFailed(c);
    pct.campaign = c && !pct.campaignFailed ? pctCampaignNorm(c, clientId) : null;
    pctPaintAll();
  }
  if (pct.tab === 'calls' && !pct.callsBusy && !(pct.callsAt && Date.now() - pct.callsAt < PCT_ASK_MS)) {
    pct.callsBusy = true;
    let c;
    try { c = await pctLoadCalls(ctx, clientId); }
    finally { pct.callsBusy = false }
    if (who !== pct.who) return;
    pct.callsAt = Date.now();
    pct.callsFailed = pctFailed(c);
    pct.calls = c && !pct.callsFailed ? pctCallsNorm(c, clientId) : null;
    pct.callsBlind = !pct.callsFailed && pctBlind('portal_calls', !(pct.calls && pct.calls.any));
    pctPaintAll();
  }
}

if (typeof window !== 'undefined') {
  const P = window.PC || (window.PC = { cards: {}, actions: {}, mounts: [] });
  P.mounts = P.mounts || []; P.actions = P.actions || {};
  P.mounts.push(pctMount);
  P.actions.trackerToggle = function(el){
    pct.open = !pct.open;
    const box = pctBox('pcTracker');
    pctPaint(box);
    const b = box && box.querySelector ? box.querySelector('.pct-toggle') : null;
    if (b && b.focus) b.focus();
  };
  /* "Try again" on a panel that could not load: forget the back-off and ask now,
     so a client who is looking at the failure has a way out other than reloading. */
  P.actions.trackerRetry = function(el, ctx){
    pct.campaignAt = 0; pct.callsAt = 0; pct.monthAt = 0;
    pct.campaignFailed = false; pct.callsFailed = false; pct.monthFailed = false;
    pctPaintAll();
    return pctMount(ctx);
  };
}
