/* Sample data shaped exactly like email-distributor/docs/HUB-API.md.
   Used by tests/trials.test.mjs and handy as a fake machine while developing. */
export const NOW = new Date('2026-10-17T12:00:00Z');
export const systems = (overrides) => [
  ['intake', 'Intake', 'ok', 'Applied 2026-09-20 · onboarding done'],
  ['market', 'Market count', 'ok', '1,240 matching companies'],
  ['purchase', 'Purchase', 'ok', 'acme-team.com bought'],
  ['setup', 'Setup check', 'ok', 'All 11 checks passed'],
  ['warmup', 'Warm-up', 'working', 'Day 9 of 14 · inbox rate 91% · 2 inboxes'],
  ['list', 'Lead list', 'working', '412 found of 400'],
  ['copy', 'Copy', 'waiting', 'Approval link sent, no click yet'],
  ['canary', 'Canary test', 'ok', 'Placement 90%'],
  ['sending', 'Sending', 'working', '230 sent · 12 today'],
  ['replies', 'Replies', 'working', '9 replies · 4 positive'],
  ['calls', 'Calls', 'blocked', '1 dispute waiting for you'],
  ['reports', 'Reports', 'off', 'First Friday update on 2026-10-10'],
  ['closing', 'Closing', 'off', ''],
].map(([key, label, status, line]) => ({ key, label, status: (overrides && overrides[key]) || status, line, detail: key === 'warmup' ? ['inbox ann@acme-team.com 92%', 'inbox hello@acme-team.com 90%'] : [] }));

export const acme = {
  id: 'acme-plumbing', name: 'Acme Plumbing', state: 'sending', stateLabel: 'Sending — Day 12 of 30', plan: 'trial', trialDay: 12,
  day1Date: '2026-10-06', day30Date: '2026-11-04', contactName: 'Ann Lee', contactEmail: 'ann@acme.com', website: 'https://acme.com',
  health: 'yellow', healthReasons: ['1 hot lead unanswered 26 h'], five: { sent: 230, replies: 9, positive: 4, booked: 2, qualified: 1 }, inboxRate: 0.91,
  openAlerts: 1, urgentAlerts: 0,
  todo: [{ id: 'dispute:acme-plumbing:b1', text: 'Decide the dispute on the call with bob@example.com', detail: 'Client tapped Doesn\'t count · reason: wrong fit', urgent: false, since: '2026-10-16T09:00:00Z', action: { type: 'view', view: 'detail', clientId: 'acme-plumbing' } }],
  systems: systems(), nextUp: { date: '2026-10-17', what: 'Friday update' },
};
export const bright = {
  id: 'bright-dental', name: 'Bright Dental', state: 'awaiting_purchase', stateLabel: 'Waiting for you to buy', plan: 'trial', trialDay: null,
  day1Date: null, day30Date: null, contactName: 'Raj Patel', contactEmail: 'raj@brightdental.com', website: 'https://brightdental.com',
  health: 'red', healthReasons: ['shopping list unanswered 14 h'], five: null, inboxRate: null, openAlerts: 1, urgentAlerts: 1,
  todo: [{ id: 'buy:bright-dental', text: 'Buy bright-team.com and 2 inboxes, then paste the logins', detail: 'Shopping list sent 14 h ago · Porkbun $9.13 + Premium Inboxes 2 × $3.50', urgent: true, since: '2026-10-16T22:00:00Z', action: { type: 'view', view: 'purchase', clientId: 'bright-dental' } }],
  systems: systems({ purchase: 'waiting', setup: 'off', warmup: 'off', list: 'off', copy: 'off', canary: 'off', sending: 'off', replies: 'off', calls: 'off' }), nextUp: null,
};
export const cobalt = {
  id: 'cobalt-hvac', name: 'Cobalt HVAC', state: 'converted', stateLabel: 'Converted', plan: 'starter', trialDay: 34,
  day1Date: '2026-09-01', day30Date: '2026-09-30', contactName: 'Dee Cole', contactEmail: 'dee@cobalthvac.com', website: 'https://cobalthvac.com',
  health: 'green', healthReasons: [], five: { sent: 812, replies: 31, positive: 12, booked: 5, qualified: 3 }, inboxRate: 0.95, openAlerts: 0, urgentAlerts: 0,
  todo: [{ id: 'paid:cobalt-hvac', text: 'Mark the month-one invoice paid once the money lands', detail: 'INV-0007 · $1,500 · due 2026-10-05', urgent: false, since: '2026-10-05T00:00:00Z', action: { type: 'api', method: 'POST', path: '/api/mc/clients/cobalt-hvac', body: { action: 'markPaid' }, confirm: 'Mark INV-0007 as paid?' } }],
  systems: systems({ closing: 'ok' }), nextUp: null,
};
// A website application held for the owner's review (state `applied`).
export const fern = {
  id: 'fern-it', name: 'Fern IT', state: 'applied', stateLabel: 'Applied — waiting for your review', plan: 'trial', trialDay: null,
  day1Date: null, day30Date: null, contactName: 'Lee Park', contactEmail: 'lee@fernit.com', website: 'https://fernit.com',
  health: 'yellow', healthReasons: ['application waiting 2 h'], five: null, inboxRate: null, openAlerts: 0, urgentAlerts: 0,
  todo: [{ id: 'review:fern-it', clientId: 'fern-it', clientName: 'Fern IT', text: "Review Fern IT's trial application", detail: 'From the website 2 h ago · looks like a fit (3 checks unknown)', urgent: false, since: '2026-10-17T10:00:00Z', action: { type: 'view', view: 'detail', clientId: 'fern-it', section: 'application' } }],
  systems: systems({ intake: 'waiting', market: 'off', purchase: 'off', setup: 'off', warmup: 'off', list: 'off', copy: 'off', canary: 'off', sending: 'off', replies: 'off', calls: 'off', reports: 'off', closing: 'off' }), nextUp: null,
};
export const fernApplication = {
  receivedAt: '2026-10-17T10:00:00Z', source: 'website', review: 'pending', decidedAt: null, decision: null, declineReason: null,
  answers: [
    { q: 'What do you sell, and who to?', a: 'Managed IT for dental and medical practices in Texas.' },
    { q: 'How many people work at the company?', a: '12' },
    { q: 'What is a new customer worth in their first year?', a: '$5,000–$20,000' },
    { q: 'Have you sold to people who did not know you (not referrals)?', a: 'Yes' },
    { q: 'Name three dream customers', a: 'Smile Dental Austin\nNorth Clinic\nLakeview Ortho' },
    { q: 'Can you meet a lead within 5 business days?', a: 'Yes' },
    { q: 'How many sales calls a week can you take?', a: '6' },
    { q: 'Is anyone else cold-emailing for you?', a: 'Not sure' },
    { q: 'Will you leave a short review if the trial works?', a: '' },
  ],
  fit: {
    verdict: 'unknown', summary: 'Looks like a fit — 3 checks unknown',
    lines: [
      { rule: 'employees', label: '5–50 people at the company', status: 'pass', note: 'They said 12' },
      { rule: 'deal_value', label: 'Customer worth ≥ $2,000 in year one', status: 'pass', note: 'They said $5,000–$20,000' },
      { rule: 'strangers', label: 'Has sold to strangers before', status: 'pass', note: 'They said yes' },
      { rule: 'no_other_sender', label: 'Nobody else cold-emailing for them', status: 'unknown', note: 'They said "Not sure"' },
      { rule: 'review_ask', label: 'Agrees to the review ask', status: 'unknown', note: 'Not answered' },
      { rule: 'agency', label: 'Not a lead-gen or outbound agency', status: 'unknown', note: 'Website not checked yet' },
    ],
  },
};
export const fernDetail = { row: fern, application: fernApplication, holds: {}, links: {}, events: [{ at: '2026-10-17T10:00:00Z', system: 'gatekeeper', event: 'application_received', detail: 'source website' }] };

export const stagesWith = (map) => [
  ['intake', 'Applied & queued', ['applied', 'queued']], ['onboard', 'Onboarding', ['onboarding']], ['setup', 'Buying & setup', ['awaiting_purchase', 'setup_check']],
  ['build', 'Warm-up & build', ['warming', 'ready']], ['live', 'Sending', ['sending', 'paused', 'extension']], ['decide', 'Deciding', ['deciding']],
  ['won', 'Converted', ['converted']], ['closing', 'Not now & closing', ['not_now', 'retired']], ['ended', 'Ended', ['declined', 'closed_silent', 'deleted']],
].map(([key, label, states]) => ({ key, label, states, clients: map[key] || [] }));

export const fullHub = {
  machine: {
    ok: true, baseUrl: 'https://machine.test',
    heartbeat: { lastTickAt: '2026-10-17T11:59:18Z', ageSec: 42, source: 'cronjob', lastSendAt: '2026-10-17T11:45:00Z' },
    activeTrials: 2, maxActiveTrials: 3, extensions: 0, openAlerts: 2,
    usage: { redis: { used: 123, limit: 500000, pct: 0 }, places: { used: 120, limit: 1000, pct: 12 }, reoon: { used: 8, limit: 20, pct: 40, remaining: 12 } },
    setup: { migrated: true, encKey: true, cronSecret: true, telegram: false, healthchecks: false, ownerInbox: true },
    queue: [{ id: 'delta-roofing', name: 'Delta Roofing', position: 1, expectedDate: '2026-10-20' }],
    others: [{ id: 'aviance', name: 'Aviance', state: 'sending', stateLabel: 'Sending', health: 'green', five: { sent: 5000, replies: 80, positive: 20, booked: 6, qualified: 4 }, todo: [], systems: [] }],
  },
  stages: stagesWith({ intake: [fern], setup: [bright], live: [acme], won: [cobalt] }),
  todos: [
    Object.assign({ clientId: 'bright-dental', clientName: 'Bright Dental' }, bright.todo[0]),
    Object.assign({ clientId: 'acme-plumbing', clientName: 'Acme Plumbing' }, acme.todo[0]),
    Object.assign({ clientId: 'cobalt-hvac', clientName: 'Cobalt HVAC' }, cobalt.todo[0]),
    fern.todo[0],
  ],
  alerts: [
    { id: 'a1', at: '2026-10-17T10:00:00Z', key: 'purchase_reminder', clientId: 'bright-dental', title: 'Shopping list unanswered for 14 h', urgent: true, delivered: true },
    { id: 'a2', at: '2026-10-16T08:00:00Z', key: 'dispute', clientId: 'acme-plumbing', title: 'Dispute on a booked call', urgent: false, delivered: false },
  ],
};
export const emptyHub = { machine: { ok: true, heartbeat: { lastTickAt: null, ageSec: null, source: null, lastSendAt: null }, activeTrials: 0, maxActiveTrials: 3, extensions: 0, openAlerts: 0, usage: {}, setup: { migrated: true, encKey: true, cronSecret: true, telegram: true, healthchecks: true, ownerInbox: true }, queue: [], others: [] }, stages: stagesWith({}), todos: [], alerts: [] };

export const detail = {
  row: acme,
  profile: { senderName: 'Ann Lee', calendarUrl: 'https://calendly.com/ann' },
  trial: { signedDay: '2026-09-22' },
  domain: { name: 'acme-team.com', setupPhase: 'passed', checks: { spf: { status: 'pass', detail: 'v=spf1 include:_spf.google.com ~all' }, dkim: { status: 'pass', detail: '' }, dmarc: { status: 'warn', detail: 'p=none' }, redirect: { status: 'fail', detail: 'no redirect to acme.com' }, blacklist: { status: 'pending', detail: '' } }, dmarcPassRate7d: 0.98, blacklist: 'clean', retiredAt: null },
  shopping: { chosenDomain: 'acme-team.com', backups: ['getacme.com'], registrarQuotes: [{ registrar: 'porkbun', name: 'Porkbun', price: 9.13, unconfirmed: false }], inboxQuotes: [{ provider: 'premiuminboxes', name: 'Premium Inboxes', price: 3.5, minOrder: 1 }], total: 16.13, sentAt: '2026-09-21T10:00:00Z', boughtAt: '2026-09-22T09:00:00Z', unconfirmed: [] },
  inboxes: [
    { email: 'ann@acme-team.com', displayName: 'Ann Lee', provider: 'google', enabled: '1', dailyCap: '12', warmupStartedAt: '2026-09-22T09:10:00Z', inboxRate7d: 0.92, canaryPlacement: 0.9, health: 'ok', disabledReason: null, hasPassword: true },
    { email: 'hello@acme-team.com', displayName: 'Ann at Acme', provider: 'google', enabled: '0', dailyCap: '0', warmupStartedAt: '2026-09-22T09:10:00Z', inboxRate7d: 0.71, canaryPlacement: 0.8, health: 'warning', disabledReason: 'inbox rate under 80%', hasPassword: true },
  ],
  leadsByStatus: { unsent: 380, in_sequence: 120, replied: 9, bounced: 3, suppressed: 2, notnow: 1, done: 30 },
  leadfinder: { status: 'done', lastRunAt: '2026-10-01T02:00:00Z', found: 412, need: 400 },
  sequence: { active: 'both', version: 1, approvedAt: '2026-10-02T15:00:00Z', approvalMode: 'click', round: 0, changes: [] },
  counters: { sent: 230, replies: 9, positive: 4, booked: 2, held: 1, qualified: 1, bounces: 3, companiesContacted: 210 },
  repliesByKind: { interested: 4, question: 2, no: 2, ooo: 1 },
  replies: [{ id: 'r1', kind: 'interested', leadEmail: 'bob@example.com', receivedAt: '2026-10-15T14:00:00Z', snippet: 'Sure, tell me more about the pricing' }],
  bookings: [{ id: 'b1', leadEmail: 'bob@example.com', scheduledAt: '2026-10-14T15:00:00Z', status: 'disputed', qualified: false, tapped: 'wrongfit', disputeReason: 'wrong fit' }],
  pacelog: [{ at: '2026-10-08T22:00:00Z', day: 3, test: 'bounce 1.3% of first 50', fix: 'none needed' }],
  reports: [{ name: 'friday:2026-10-10', renderedAt: '2026-10-10T13:00:00Z', blockedReason: null }, { name: 'friday:2026-10-17', renderedAt: null, blockedReason: 'counters.held missing' }],
  invoice: null,
  promises: [{ id: 'p1', text: 'Answer Ann about the calendar', dueAt: '2026-10-18', doneAt: null }],
  upcoming: [{ date: '2026-10-17', time: '09:00 ET', what: 'Friday update' }, { date: '2026-11-03', time: '09:00 ET', what: 'Day 29 report' }],
  events: [{ at: '2026-10-16T09:00:00Z', system: 'scorekeeper', event: 'dispute_opened', detail: { bookingId: 'b1' } }, { at: '2026-10-17T11:00:00Z', system: 'sender', event: 'sent', detail: 'd0 to bob@example.com' }],
  jobs: { send: { at: '2026-10-17T11:58:00Z', ms: 812, ok: true, error: null }, replies: { at: '2026-10-17T11:57:00Z', ms: 1200, ok: false, error: 'IMAP timeout' } },
  holds: { legalHoldAt: '2026-10-15T10:00:00Z', sendHold: null, emergencyActive: false, emergencyHalved: false, pausedReason: null },
  links: { onboarding: 'https://machine.test/c/tok1/onboard', approval: 'https://machine.test/c/tok2/approve' },
  application: { receivedAt: '2026-09-20T14:00:00Z', source: 'website', review: 'approved', decidedAt: '2026-09-20T18:00:00Z', decision: 'approve', declineReason: null,
    answers: [{ q: 'What do you sell, and who to?', a: 'Plumbing maintenance for restaurants in Ohio.' }],
    fit: { verdict: 'fit', summary: 'Looks like a fit', lines: [{ rule: 'deal_value', label: 'Customer worth ≥ $2,000 in year one', status: 'pass', note: 'They said $8,000' }] } },
};

/* ───────────── v2 additions — shapes as shipped in email-distributor 48dd467 ─────────────
   growth.js growthFor · research.js researchView · pricescout.js shoppingView (domains.js) ·
   deliverability.js deliverabilityView · grader.js leadQualityView                         */

/* Tiny growth payload for exact mapping tests. The machine sends 0 for a counter that did not
   move on a recorded day and null only when nothing was recorded:
   day 0 and day 4: nothing recorded (gap) · day 1: a warm-up-only day (email counters 0)
   day 3: only a reply came in · warm-up day 3: outage (gap). */
export const tinyGrowth = {
  days: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'],
  email: { sent: [null, 0, 38, 0, null, 45], sentD0: [null, 0, 0, 0, null, 20], replies: [null, 0, 0, 1, null, 3], positive: [null, 0, 0, 0, null, 2], booked: [null, 0, 0, 0, null, 1], held: [null, 0, 0, 0, null, 0], qualified: [null, 0, 0, 0, null, 1], bounces: [null, 0, 1, 0, null, 0] },
  warmup: { sent: [null, 30, 30, null, 30, 31], inbox: [null, 27, 28, null, 29, 30], spam: [null, 3, 2, null, 1, 1], rate: [null, 0.9, 0.92, null, 0.94, 0.95] },
  inboxes: [{ email: 'ann@acme-team.com', dailyCap: 12, warmupStartedAt: '2026-09-22T09:10:00Z', sent: [null, 15, 15, null, 15, 16], rate: [null, 0.9, 0.93, null, 0.95, 0.96] }],
  placement: [
    { day: '2026-10-13', at: '2026-10-13T11:30:00Z', tool: 'seed', inboxRate: 0.9, score: null, min: 0.8, perProvider: { gmail: 1, outlook: 0.67 } },
    { day: '2026-10-14', at: '2026-10-14T13:00:00Z', tool: 'dkimvalidator', inboxRate: null, score: null, spamAssassin: 3.2, min: null, perProvider: null, perInbox: { 'ann@acme-team.com': 3.2, 'hello@acme-team.com': 1.1 } },
    { day: '2026-10-15', at: '2026-10-15T13:00:00Z', tool: 'dkimvalidator', inboxRate: null, score: null, spamAssassin: 1.4, min: null, perProvider: null, perInbox: { 'ann@acme-team.com': 1.4, 'hello@acme-team.com': 0.9 } },
    { day: '2026-10-16', at: '2026-10-16T12:00:00Z', tool: 'mail-tester', inboxRate: null, score: 9.1, spamAssassin: null, min: null, perProvider: null, perInbox: { 'ann@acme-team.com': 9.1 } },
    { day: '2026-10-17', at: '2026-10-17T13:00:00Z', tool: 'dkimvalidator', inboxRate: null, score: null, spamAssassin: 5.6, min: null, perProvider: null, perInbox: { 'ann@acme-team.com': 5.6 } },
  ],
};

/* Realistic growth history, deterministic, shaped like growthFor(): warm-up from warmStart (one outage
   day = null everywhere), warm-up days also record the email counters as 0 (same daily record),
   sending on weekdays from day1, Saturday replies, two inboxes, seed + DKIM Validator + one mail-tester test. */
export function makeGrowth(days = 45, { end = '2026-10-17', warmStart = '2026-09-22', day1 = '2026-10-06', outage = '2026-10-01', inboxes = [['ann@acme-team.com', 12], ['hello@acme-team.com', 8]] } = {}) {
  let seed = 11; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const endMs = Date.parse(end + 'T12:00:00Z'); const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(new Date(endMs - i * 864e5).toISOString().slice(0, 10));
  const age = (k, from) => Math.round((Date.parse(k) - Date.parse(from)) / 864e5);
  const F = ['sent', 'sentD0', 'replies', 'positive', 'booked', 'held', 'qualified', 'bounces'];
  const email = Object.fromEntries(F.map((f) => [f, []]));
  const per = inboxes.map(() => ({ sent: [], inbox: [], spam: [] }));
  keys.forEach((k) => {
    const dow = new Date(k + 'T12:00:00Z').getUTCDay(); const weekend = dow === 0 || dow === 6;
    const warming = k >= warmStart && k !== outage;
    per.forEach((ib, j) => {
      if (!warming) { ib.sent.push(null); ib.inbox.push(null); ib.spam.push(null); return; }
      const a = age(k, warmStart); const q = a < 3 ? 3 : a < 7 ? 8 : a < 14 ? 15 : 8;
      const spam = Math.round(q * (a < 6 ? 0.22 : a < 12 ? 0.1 : 0.05) * (0.5 + rnd()) * (1 + j * 0.9));
      ib.sent.push(q); ib.spam.push(spam); ib.inbox.push(Math.max(0, q - spam));
    });
    const row = Object.fromEntries(F.map((f) => [f, warming ? 0 : null])); // the day's record exists once warm-up ran
    if (k >= day1 && !weekend) {
      const d = age(k, day1); const s = Math.min(50, 16 + d * 3);
      const r = rnd() < 0.55 ? 1 + Math.floor(rnd() * 3) : 0;
      Object.assign(row, { sent: s, sentD0: Math.round(s * (d < 3 ? 1 : 0.5)), replies: r, positive: r && rnd() < 0.6 ? 1 : 0, booked: r && rnd() < 0.35 ? 1 : 0, held: 0, qualified: 0, bounces: rnd() < 0.3 ? 1 : 0 });
    } else if (k >= day1 && dow === 6) { F.forEach((f) => { if (row[f] == null) row[f] = 0; }); row.replies = 1; }
    F.forEach((f) => email[f].push(row[f]));
  });
  const sumAt = (f, i) => { let any = false, t = 0; per.forEach((ib) => { if (ib[f][i] != null) { any = true; t += ib[f][i]; } }); return any ? t : null; };
  const rolling = (inbox, spam, i) => { let a = 0, b = 0, seen = false; for (let j = Math.max(0, i - 6); j <= i; j++) { if (inbox[j] != null || spam[j] != null) seen = true; a += inbox[j] || 0; b += spam[j] || 0; } return seen && a + b > 0 ? Math.round((a / (a + b)) * 1000) / 1000 : null; };
  const wInbox = keys.map((_, i) => sumAt('inbox', i)), wSpam = keys.map((_, i) => sumAt('spam', i));
  const addrs = inboxes.map(([a]) => a);
  const placement = [];
  keys.forEach((k) => {
    const a = age(k, warmStart);
    if (k >= warmStart && a >= 10 && a % 3 === 1) placement.push({ day: k, at: k + 'T11:30:00Z', tool: 'seed', inboxRate: Math.round((0.8 + rnd() * 0.18) * 100) / 100, score: null, min: 0.67, perProvider: { gmail: 1, outlook: 0.67, yahoo: 1 } });
    // Spam test (DKIM Validator, the default tool) from Day −3: fails once, then passes; weekly while sending.
    const b = age(k, day1);
    if (b === -3 || b === -2 || (b >= 0 && b % 7 === 0)) {
      const pts = b === -3 ? 3.1 : Math.round((0.4 + rnd() * 1.2) * 10) / 10;
      placement.push({ day: k, at: k + 'T13:00:00Z', tool: 'dkimvalidator', inboxRate: null, score: null, spamAssassin: pts, min: null, perProvider: null, perInbox: Object.fromEntries(addrs.map((e, j) => [e, Math.round((pts - j * 0.3) * 10) / 10])) });
    }
    if (b === 1) placement.push({ day: k, at: k + 'T12:00:00Z', tool: 'mail-tester', inboxRate: null, score: 9.2, spamAssassin: null, min: null, perProvider: null, perInbox: { [addrs[0]]: 9.2 } });
  });
  placement.sort((x, y) => (x.day === y.day ? x.at.localeCompare(y.at) : x.day.localeCompare(y.day)));
  return {
    days: keys, email,
    warmup: { sent: keys.map((_, i) => sumAt('sent', i)), inbox: wInbox, spam: wSpam, rate: keys.map((_, i) => rolling(wInbox, wSpam, i)) },
    inboxes: inboxes.map(([addr, cap], j) => ({ email: addr, dailyCap: cap, warmupStartedAt: warmStart + 'T09:10:00Z', sent: per[j].sent, rate: keys.map((_, i) => rolling(per[j].inbox, per[j].spam, i)) })),
    placement,
  };
}

/* researchView() */
export const research = {
  status: 'done', at: '2026-10-17T10:05:00Z', error: null,
  summary: 'Fern IT is a managed IT company in Austin, TX (4.8★, 57 Google reviews) that looks after dental and medical practices; about 12 people on the team.',
  website: { url: 'https://fernit.com', title: 'Fern IT — Managed IT for clinics', description: 'Managed IT, cybersecurity and HIPAA compliance for dental and medical practices across Texas.', headline: 'IT that keeps your practice running', services: ['Managed IT', 'Cybersecurity', 'HIPAA compliance', 'Cloud backup'], locations: ['Austin, TX', 'San Antonio, TX'], phones: ['(512) 555-0142'], emails: ['hello@fernit.com'], socials: { linkedin: 'https://www.linkedin.com/company/fernit', facebook: 'https://facebook.com/fernit', x: 'javascript:alert(1)' }, teamHint: '12 people on the team page', yearsHint: 'Since 2011', pagesRead: 4 },
  business: { name: 'Fern IT', address: '1200 Congress Ave, Austin, TX 78701', category: 'Computer support and services', rating: 4.8, reviews: 57, mapsUrl: 'https://maps.google.com/?cid=123456', phone: '(512) 555-0142' },
  market: { query: 'dental practices in Texas', estimate: 4820, source: 'places' },
  flags: [{ level: 'warn', text: "Website or application mentions 'lead generation' — could be an agency" }, { level: 'info', text: 'Website title “Fern IT — Managed IT for clinics” does not mention Fern IT LLC' }],
};
fernApplication.research = research;

/* shoppingView() — domains.js priceRows / pickBest / inboxPlan / totalsOf */
const priceRow = (registrar, firstYear, renewal, url, source, promo = null) => ({ registrar, firstYear, renewal, promo, url, confirmedAt: source === 'live' ? '2026-10-16T21:00:00Z' : '2026-09-01T00:00:00.000Z', source });
export const shoppingV2 = {
  chosenDomain: 'getbrightdental.com', backups: ['brightdentalhq.com'], domainCandidates: [], registrarQuotes: [], inboxQuotes: [], senderAddresses: ['raj@getbrightdental.com', 'hello@getbrightdental.com'], total: 16.73, sentAt: '2026-10-16T22:00:00Z', boughtAt: null, unconfirmed: [], autoBought: {},
  offers: [
    { domain: 'getbrightdental.com', tld: 'com', available: true, score: 92, why: "Short, brand + 'get', .com",
      prices: [priceRow('Porkbun', 9.73, 11.08, 'https://porkbun.com/checkout/search?q=getbrightdental.com', 'live'), priceRow('Cloudflare', 10.44, 10.44, 'https://domains.cloudflare.com/?domain=getbrightdental.com', 'table'), priceRow('Namecheap', 11.28, 15.88, 'https://www.namecheap.com/domains/registration/results/?domain=getbrightdental.com', 'table', { code: 'NEWCOM598', firstYear: 5.98, note: 'new customers' })],
      best: { registrar: 'Porkbun', firstYear: 9.73, renewal: 11.08, url: 'https://porkbun.com/checkout/search?q=getbrightdental.com' } },
    { domain: 'brightdentalhq.com', tld: 'com', available: true, score: 85, why: "Brand + 'hq', .com",
      prices: [priceRow('Spaceship', 9.98, 11.18, 'https://www.spaceship.com/domain-search/?query=brightdentalhq.com', 'table', { code: 'SPACE10', firstYear: 6.98, note: null }), priceRow('Porkbun', 11.06, 11.08, 'https://porkbun.com/checkout/search?q=brightdentalhq.com', 'live')],
      best: { registrar: 'Spaceship', firstYear: 9.98, renewal: 11.18, url: 'https://www.spaceship.com/domain-search/?query=brightdentalhq.com', promo: { code: 'SPACE10', firstYear: 6.98, note: null } } },
    { domain: 'usebrightdental.co', tld: 'co', available: null, score: 64, why: '.co is cheap in year one but renews high', prices: [priceRow('Porkbun', 8.64, 26.48, 'javascript:alert(2)', 'live')], best: { registrar: 'Porkbun', firstYear: 8.64, renewal: 26.48, url: 'javascript:alert(2)' } },
  ],
  registrars: [{ name: 'Porkbun', why: 'Cheapest .com, free WHOIS privacy', url: 'https://porkbun.com' }, { name: 'Spaceship', why: 'Low first year', url: 'https://www.spaceship.com' }, { name: 'Cloudflare', why: 'At-cost renewals', url: 'https://www.cloudflare.com/products/registrar/' }, { name: 'Namecheap', why: 'Frequent promo codes', url: 'https://www.namecheap.com' }, { name: 'Dynadot', why: 'Simple checkout', url: 'https://www.dynadot.com' }],
  inboxes: { provider: 'CheapInboxes', url: 'https://cheapinboxes.com', perInbox: 3.5, count: 2, monthly: 7, notes: 'Google Workspace inboxes with app passwords; cancel any time from their dashboard.', steps: ['Create an account at cheapinboxes.com', 'Add the domain getbrightdental.com and set the DNS records they show', 'Create 2 users: Raj Patel → raj@getbrightdental.com; Raj Patel → hello@getbrightdental.com', 'Turn on 2-step verification and make an app password for each inbox', 'Paste both logins below'] },
  totals: { domainFirstYear: 9.73, inboxesMonthly: 7, firstMonth: 16.73 },
  domain: { name: null },
};
export const brightPurchase = { client: { id: 'bright-dental', name: 'Bright Dental', state: 'awaiting_purchase', mainDomain: 'brightdental.com' }, shopping: shoppingV2, setup: { domain: { name: null, setupPhase: null, loopbackSentAt: null }, checks: {}, senderName: 'Raj Patel' }, inboxes: [], encKey: true };

/* deliverabilityView() incl. the additive fields (stage-b assumption 69) */
detail.deliverability = {
  warmup: { pool: 14, helpers: 8, trialInboxes: 4, avianceInboxes: 2, families: 5, providers: { gmail: 4, outlook: 3, yahoo: 2, zoho: 2, workspace: 3 }, todayPairs: 11, at: '2026-10-17T11:50:00Z', external: { name: 'Outside warm-up network', status: 'connected', perDay: 10 } },
  placement: [
    { at: '2026-10-17T13:00:00Z', tool: 'dkimvalidator', inbox: 'ann@acme-team.com', score: null, spamAssassin: 1.4, inboxRate: null, pass: true, detail: ['SpamAssassin 1.4 points', 'DKIM pass', 'SPF pass'], reportUrl: null, error: null },
    { at: '2026-10-17T13:01:00Z', tool: 'dkimvalidator', inbox: 'hello@acme-team.com', score: null, spamAssassin: 3.2, inboxRate: null, pass: false, detail: ['SpamAssassin 3.2 points', 'URIBL_BLOCKED', 'DKIM pass', 'SPF pass'], reportUrl: 'javascript:alert(3)', error: null },
    { at: '2026-10-16T12:00:00Z', tool: 'mail-tester', inbox: 'ann@acme-team.com', score: 9.1, spamAssassin: null, inboxRate: null, pass: true, detail: ['SPF pass', 'DKIM pass', 'DMARC pass'], reportUrl: 'https://www.mail-tester.com/test-abc123', error: null },
    { at: '2026-10-15T11:30:00Z', tool: 'seed', inbox: null, score: null, spamAssassin: null, inboxRate: 0.9, pass: true, detail: ['gmail 3/3', 'outlook 2/3', 'yahoo 2/2'], reportUrl: null, error: null },
    { at: '2026-10-14T13:05:00Z', tool: 'dkimvalidator', inbox: 'hello@acme-team.com', score: null, spamAssassin: null, inboxRate: null, pass: null, detail: [], reportUrl: null, error: 'dkimvalidator did not answer in 20 minutes' },
  ],
  blacklists: { checkedAt: '2026-10-17T06:10:00Z', status: 'clean', listed: [], warnings: ['bl.spamcop.net: 192.0.2.10 (A record)'], clean: 5, unknown: ['dnsbl.sorbs.net', 'b.barracudacentral.org'], lists: ['multi.surbl.org', 'dbl.spamhaus.org', 'bl.spamcop.net', 'psbl.surriel.com', 'bl.mailspike.net', 'dnsbl.sorbs.net', 'b.barracudacentral.org'] },
  bounce: { rate7d: 0.012, sent7d: 1240, at: '2026-10-17T04:05:00Z', pauseAt: 0.015, stopAt: 0.02, halved: false },
};
/* leadQualityView() incl. sendableUnsent + builtAt */
detail.leadQuality = {
  graded: 812, grades: { A: 140, B: 210, C: 90, rejected: 372 }, sendable: 350, sendableUnsent: 212, builtAt: '2026-10-17T02:15:00Z',
  verification: { valid: 330, risky: 40, catchall: 25, invalid: 60, unknown: 12, pending: 30, budgetLeftToday: 45 },
  rejectReasons: [{ reason: 'Role address (info@)', count: 120 }, { reason: 'No website', count: 88 }, { reason: 'Chain or franchise', count: 64 }, { reason: 'Outside the service area', count: 52 }, { reason: 'Email did not verify', count: 48 }],
  sources: [{ source: 'google-places', count: 600 }, { source: 'website crawl', count: 180 }, { source: 'referral', count: 32 }],
  sample: [
    { email: 'jim@rivertonbistro.com', name: 'Jim Reyes', title: 'Owner', company: 'Riverton Bistro', city: 'Columbus, OH', grade: 'A', score: 91, reasons: ['Owner title', 'Verified email', 'Matches a dream customer'] },
    { email: 'sara@elmstreetcafe.com', name: 'Sara Kim', title: 'General manager', company: 'Elm Street Cafe', city: 'Dayton, OH', grade: 'B', score: 74, reasons: ['Manager title', 'Verified email'] },
    { email: 'info@oakgrill.com', name: '', title: '', company: 'Oak Grill', city: 'Toledo, OH', grade: 'C', score: 41, reasons: ['Role address', 'Verified email'] },
  ],
};
detail.shopping = shoppingV2;
detail.links = {};

/* ───── Plan inquiries (HUB-API "## Plan inquiries"; email-distributor src/lib/systems/inquiries.js) ─────
   NOW is Sat 17 Oct 2026 12:00 UTC = 5:30 PM in Sri Lanka (the owner's time). */
export const inquiryRecords = [
  { id: 'qmgv1stone', at: '2026-10-17T10:00:00Z', source: 'website', status: 'new', statusAt: '2026-10-17T10:00:00Z', notes: [],
    name: 'Dana Stone', email: 'dana@stoneroofing.com', company: 'Stone Roofing', website: 'stoneroofing.com',
    sells: 'Roof replacement and storm-damage repair for homeowners around Dallas–Fort Worth.', plan: 'growth',
    slotStart: '2026-10-20T14:00:00Z', slotEnd: '2026-10-20T14:15:00Z', theirTz: 'America/Chicago',
    whenTheirs: 'Tuesday, October 20, 2026 at 9:00 AM', whenHost: 'Tuesday, October 20, 2026 at 7:30 PM', page: '/' },
  { id: 'qmgu9birch', at: '2026-10-16T09:30:00Z', source: 'website', status: 'new', statusAt: '2026-10-16T09:30:00Z', notes: [],
    name: 'Omar Birch', email: 'omar@birchlegal.co.uk', company: 'Birch Legal', website: 'https://birchlegal.co.uk',
    sells: 'Employment law for small UK businesses', plan: null,
    slotStart: '2026-10-17T15:00:00Z', slotEnd: '2026-10-17T15:15:00Z', theirTz: 'Europe/London',
    whenTheirs: 'Saturday, October 17, 2026 at 4:00 PM', whenHost: 'Saturday, October 17, 2026 at 8:30 PM', page: '/' },
  { id: 'qmgp2cedar', at: '2026-10-14T08:00:00Z', source: 'website', status: 'contacted', statusAt: '2026-10-15T11:00:00Z',
    notes: [{ at: '2026-10-15T11:00:00Z', text: 'Good call. Not ready to pay yet, so I offered a trial.' }],
    name: 'Priya Nair', email: 'priya@cedarhvac.com', company: 'Cedar HVAC', website: 'cedarhvac.com',
    sells: 'Commercial HVAC maintenance contracts', plan: 'starter',
    slotStart: '2026-10-15T10:30:00Z', slotEnd: '2026-10-15T10:45:00Z', theirTz: 'Asia/Dubai',
    whenTheirs: 'Thursday, October 15, 2026 at 2:30 PM', whenHost: 'Thursday, October 15, 2026 at 4:00 PM', clientId: 'cedar-hvac', trialOutcome: 'queued' },
  { id: 'qmgn1harbor', at: '2026-10-12T07:00:00Z', source: 'website', status: 'contacted', statusAt: '2026-10-15T09:00:00Z',
    notes: [{ at: '2026-10-15T09:00:00Z', text: 'Called. They want a proposal for 3 clinics — send by Monday.' }, { at: '2026-10-16T08:00:00Z', text: 'Proposal drafted.' }],
    name: 'Grace Lee', email: 'grace@harbordental.com', company: 'Harbor Dental Group', website: 'https://harbordental.com',
    sells: 'Dental implants and Invisalign across three clinics in San Diego', plan: 'scale',
    slotStart: '2026-10-15T16:00:00Z', slotEnd: '2026-10-15T16:15:00Z', theirTz: 'America/Los_Angeles',
    whenTheirs: 'Thursday, October 15, 2026 at 9:00 AM', whenHost: 'Thursday, October 15, 2026 at 9:30 PM' },
  { id: 'qmgk4north', at: '2026-10-08T12:00:00Z', source: 'website', status: 'won', statusAt: '2026-10-10T12:00:00Z',
    notes: [{ at: '2026-10-10T12:00:00Z', text: 'Signed Starter. First invoice sent.' }],
    name: 'Tom Reed', email: 'tom@northwind.io', company: 'Northwind Logistics', website: 'northwind.io',
    sells: 'Freight brokerage for mid-size manufacturers', plan: 'starter',
    slotStart: '2026-10-09T13:00:00Z', slotEnd: '2026-10-09T13:15:00Z', theirTz: 'America/New_York',
    whenTheirs: 'Friday, October 9, 2026 at 9:00 AM', whenHost: 'Friday, October 9, 2026 at 6:30 PM' },
  { id: 'qmgj2pixel', at: '2026-10-05T12:00:00Z', source: 'website', status: 'lost', statusAt: '2026-10-07T12:00:00Z',
    notes: [{ at: '2026-10-07T12:00:00Z', text: 'Went with an agency <script>x</script>' }],
    name: 'Sam Ortiz', email: 'sam@pixelandco.com', company: 'Pixel & Co', website: 'javascript:alert(1)',
    sells: '<b>Brand design</b> for startups', plan: 'growth',
    slotStart: null, slotEnd: null, theirTz: null, whenTheirs: null, whenHost: null },
];
export const inquiryCounts = { new: 2, contacted: 2, won: 1, lost: 1 };
/* Mirrors inquirySummary() + the to-dos hubBoard() adds for each new one. */
export function inquirySummaryOf(list) {
  const counts = { new: 0, contacted: 0, won: 0, lost: 0 }; for (const q of list) counts[q.status]++;
  const open = list.filter((q) => q.status === 'new' || q.status === 'contacted');
  return { counts, open: open.length, latest: open.slice(0, 5).map((q) => ({ id: q.id, at: q.at, name: q.name, company: q.company, plan: q.plan, status: q.status, slotStart: q.slotStart, whenHost: q.whenHost })) };
}
export function inquiryTodosOf(summary) {
  return (summary.latest || []).filter((x) => x.status === 'new').map((q) => ({ id: `inquiry:${q.id}`, clientId: null, clientName: q.company, text: `New plan inquiry from ${q.company} — call them back`,
    detail: `${q.name}${q.plan ? ` · ${q.plan[0].toUpperCase()}${q.plan.slice(1)}` : ''}${q.whenHost ? ` · booked for ${q.whenHost}` : ''}`,
    urgent: true, since: q.at, action: { type: 'view', view: 'inquiry', inquiryId: q.id } }));
}
const inquiryHubSummary = inquirySummaryOf(inquiryRecords);
export const hubWithInquiries = Object.assign({}, fullHub, { inquiries: inquiryHubSummary, todos: inquiryTodosOf(inquiryHubSummary).concat(fullHub.todos) });
export const noInquiries = { inquiries: [], counts: { new: 0, contacted: 0, won: 0, lost: 0 } };

/* ───── Onboarding call + the simple Trials list (email-distributor docs/ONBOARD-CALL.md) ─────
   `simple` on every board row, `onboardCall` on the trial detail. NOW is Sat 17 Oct 2026 12:00 UTC. */
const withSimple = (row, simple) => Object.assign({}, row, { simple: Object.assign({ person: row.contactName, company: row.name, dayOf30: null }, simple) });
export const ecreek = {
  id: 'ecreek-it', name: 'eCreek IT', state: 'onboarding', stateLabel: 'Onboarding', plan: 'trial', trialDay: null,
  day1Date: null, day30Date: null, contactName: 'Sam Test', contactEmail: 'sam@ecreek.io', website: 'https://ecreek.io',
  health: 'yellow', healthReasons: ['reply waiting 3 h'], five: null, inboxRate: null, openAlerts: 0, urgentAlerts: 0,
  todo: [{ id: 'onboard-reply:ecreek-it', text: 'Answer Sam about the onboarding call', detail: 'They replied 3 h ago', urgent: true, since: '2026-10-16T09:00:00Z', action: { type: 'view', view: 'detail', clientId: 'ecreek-it' } }],
  systems: systems({ market: 'off', purchase: 'off', setup: 'off', warmup: 'off', list: 'off', copy: 'off', canary: 'off', sending: 'off', replies: 'off', calls: 'off', reports: 'off', closing: 'off' }), nextUp: null,
};
export const gale = {
  id: 'gale-roofing', name: 'Gale Roofing', state: 'warming', stateLabel: 'Warming up — day 5 of 14', plan: 'trial', trialDay: null,
  day1Date: '2026-10-26', day30Date: '2026-11-24', contactName: 'Mia Gale', contactEmail: 'mia@galeroofing.com', website: 'https://galeroofing.com',
  health: 'green', healthReasons: [], five: null, inboxRate: 0.88, openAlerts: 0, urgentAlerts: 0, todo: [], systems: systems({ sending: 'off', replies: 'off', calls: 'off', reports: 'off', closing: 'off' }), nextUp: { date: '2026-10-26', what: 'Day 1' },
};
export const delta = { id: 'delta-roofing', name: 'Delta Roofing', state: 'queued', stateLabel: 'In the queue — expected 2026-10-20', plan: 'trial', contactName: 'Sam Ito', contactEmail: 'sam@delta.com', health: 'green', healthReasons: [], five: null, todo: [], systems: [], nextUp: null };
export const iris = { id: 'iris-dental', name: 'Iris Dental', state: 'declined', stateLabel: 'Declined', plan: 'trial', contactName: 'Ivy Ross', contactEmail: 'ivy@irisdental.com', health: 'grey', healthReasons: [], five: null, todo: [], systems: [], nextUp: null };
export const simpleRows = {
  fern: withSimple(fern, { step: 'new', label: 'New application — read it and say yes or no', next: 'Read their application and press Approve or Decline', needsYou: true, since: '2026-10-17T10:00:00Z' }),
  ecreek: withSimple(ecreek, { step: 'accepted', label: 'Accepted — they replied about the call, answer them', next: 'Answer Sam in the onboarding call box', needsYou: true, since: '2026-10-16T09:00:00Z' }),
  bright: withSimple(bright, { step: 'setting_up', label: 'Setting up their emails (about 2 weeks)', next: 'Buy the domain and 2 inboxes, then paste the logins', needsYou: true, since: '2026-10-16T22:00:00Z' }),
  delta: withSimple(delta, { step: 'queued', label: 'Accepted — waiting for a free trial slot (first in line)', next: 'Nothing for you: they start when a slot frees up', needsYou: false, since: '2026-10-14T08:00:00Z' }),
  gale: withSimple(gale, { step: 'warming_up', label: 'Setting up their emails (about 2 weeks)', next: 'Nothing for you: the first emails go out on Mon 26 Oct', needsYou: false, since: '2026-10-12T09:00:00Z' }),
  acme: withSimple(acme, { step: 'sending', label: 'Sending — day 12 of 30, 2 calls booked', next: 'Nothing for you: the Friday update goes out today', needsYou: false, since: '2026-10-06T13:00:00Z', dayOf30: 12 }),
  cobalt: withSimple(cobalt, { step: 'finished', label: 'Finished — became a client', next: '', needsYou: false, since: '2026-10-05T00:00:00Z' }),
  iris: withSimple(iris, { step: 'declined', label: 'Declined', next: '', needsYou: false, since: '2026-10-02T12:00:00Z' }),
};
const S = simpleRows;
export const simpleHub = Object.assign({}, fullHub, {
  stages: stagesWith({ intake: [S.fern, S.delta], onboard: [S.ecreek], setup: [S.bright], build: [S.gale], live: [S.acme], won: [S.cobalt], ended: [S.iris] }),
  todos: [Object.assign({ clientId: 'ecreek-it', clientName: 'eCreek IT' }, ecreek.todo[0])].concat(fullHub.todos),
});
/* The card's data, deliberately out of order (the hub shows the conversation oldest first). */
export const onboardCall = {
  status: 'replied', label: 'They replied — answer them below', sentAt: '2026-10-15T10:00:00Z', openedAt: '2026-10-15T10:20:00Z', lastReplyAt: '2026-10-16T09:00:00Z',
  bookedFor: null, bookedAt: null, bookedBy: null, heldAt: null, dueBy: '2026-10-20T10:00:00Z', overdue: false,
  remindersSent: 1, nextReminderAt: '2026-10-18T14:00:00Z', stopped: false,
  bookingUrl: 'https://cal.com/aviance/onboarding', fromInbox: 'hello@aviance.store',
  steps: [
    { key: 'sent', label: 'Acceptance email sent', done: true, at: '2026-10-15T10:00:00Z' },
    { key: 'opened', label: 'They opened it', done: true, at: '2026-10-15T10:20:00Z' },
    { key: 'replied', label: 'They replied', done: true, at: '2026-10-16T09:00:00Z' },
    { key: 'booked', label: 'Call booked', done: false, at: null },
    { key: 'held', label: 'Call done', done: false, at: null },
  ],
  thread: [
    { id: 'm3', dir: 'in', at: '2026-10-16T09:00:00Z', from: 'sam@ecreek.io', to: 'hello@aviance.store', subject: "Re: You're in — let's book your onboarding call", text: 'Hi!\nTuesday 3 pm works for us.\n<script>alert(1)</script>', kind: 'reply' },
    { id: 'm1', dir: 'out', at: '2026-10-15T10:00:00Z', from: 'hello@aviance.store', to: 'sam@ecreek.io', subject: "You're in — let's book your onboarding call", text: 'Hi Sam, good news: we would like to run your free 30-day trial for eCreek IT.', kind: 'acceptance' },
    { id: 'm2', dir: 'out', at: '2026-10-16T08:00:00Z', from: 'hello@aviance.store', to: 'sam@ecreek.io', subject: "Re: You're in — let's book your onboarding call", text: 'Just checking you saw this.', kind: 'reminder' },
  ],
};
export const ecreekDetail = {
  row: S.ecreek, onboardCall, holds: {}, links: {}, events: [{ at: '2026-10-15T10:00:00Z', system: 'onboardcall', event: 'accepted_call_sent', detail: '' }],
  application: { receivedAt: '2026-10-14T09:00:00Z', source: 'website', review: 'approved', decidedAt: '2026-10-15T09:55:00Z', decision: 'approve', declineReason: null, answers: [], fit: { verdict: 'fit', summary: 'Looks like a fit', lines: [] } },
};

/* ───── The Calendar (email-distributor docs/CALENDAR.md) ─────
   GET /api/mc/calendar?from=&to= for the week Mon 28 Sep – Sun 4 Oct 2026 (Sri Lanka dates).
   US Eastern is on summer time (EDT, UTC−4) that week: 9 am ET = 6:30 pm Colombo; 4 pm ET = 1:30 am the
   next Colombo day. CAL_NOW is Tue 29 Sep 2026, 1:30 pm in Colombo (4:00 am ET) — outside the call hours. */
export const CAL_NOW = new Date('2026-09-29T08:00:00Z');
export const calSettingsFixture = { hours: ['09:00', '17:00'], days: [1, 2, 3, 4, 5], slotMinutes: 30, bufferMinutes: 15, maxPerDay: 6, minNoticeHours: 12, daysAhead: 14, meetingLink: 'https://meet.google.com/abc-defg-hij', ownerZone: 'Asia/Colombo', usZone: 'America/New_York' };
const calM = (o) => Object.assign({ clientId: null, company: null, person: null, email: null, kind: 'other', title: null, minutes: 30, source: 'booking_page', theirZone: 'America/New_York', note: '', declineReason: null, proposed: null, createdAt: '2026-09-27T10:00:00Z', confirmedAt: null, history: [] }, o);
export const calMeetings = {
  // Wed 30 Sep 2:00 pm ET (Wed 11:30 pm Colombo) — asked for on the booking page, from Denver
  req1: calM({ id: 'mreq1', clientId: 'ecreek-it', company: 'eCreek IT', person: 'Sam Test', email: 'sam@ecreek.io', kind: 'onboarding', title: 'Onboarding call — eCreek IT', start: '2026-09-30T18:00:00Z', minutes: 30, status: 'requested', theirZone: 'America/Denver', note: 'Can we do a bit earlier?\nThanks! <b>really</b>', createdAt: '2026-09-29T03:10:00Z', history: [{ at: '2026-09-29T03:10:00Z', what: 'requested', by: 'them' }] }),
  // Thu 1 Oct 4:00 pm ET = Fri 2 Oct 1:30 am Colombo — the midnight crossover; 15 minutes; from Los Angeles
  req2: calM({ id: 'mreq2', clientId: 'gale-roofing', company: 'Gale Roofing', person: 'Mia Gale', email: 'mia@galeroofing.com', kind: 'onboarding', title: 'Onboarding call — Gale Roofing', start: '2026-10-01T20:00:00Z', minutes: 15, status: 'requested', theirZone: 'America/Los_Angeles', createdAt: '2026-09-29T04:00:00Z', history: [{ at: '2026-09-29T04:00:00Z', what: 'requested', by: 'them' }] }),
  // the owner already suggested another time (Mon 5 Oct 9:30 am ET) — waiting for them, not for him
  req3: calM({ id: 'mreq3', clientId: 'delta-roofing', company: 'Delta Roofing', person: 'Sam Ito', start: '2026-10-02T14:00:00Z', status: 'requested', proposed: '2026-10-05T13:30:00Z', createdAt: '2026-09-28T10:00:00Z', history: [{ at: '2026-09-28T10:00:00Z', what: 'requested', by: 'them' }, { at: '2026-09-28T12:00:00Z', what: 'suggested', by: 'owner' }] }),
  // Tue 29 Sep 9:00 am ET = Tue 6:30 pm Colombo
  conf: calM({ id: 'mconf', clientId: 'acme-plumbing', company: 'Acme Plumbing', person: 'Ann Lee', email: 'ann@acme.com', title: 'Onboarding call — Acme Plumbing', start: '2026-09-29T13:00:00Z', status: 'confirmed', confirmedAt: '2026-09-27T11:00:00Z', history: [{ at: '2026-09-27T10:00:00Z', what: 'requested', by: 'them' }, { at: '2026-09-27T11:00:00Z', what: 'confirmed', by: 'owner' }] }),
  // Mon 28 Sep 10:00 am ET = Mon 7:30 pm Colombo — done
  held: calM({ id: 'mheld', clientId: 'bright-dental', company: 'Bright Dental', person: 'Raj Patel', start: '2026-09-28T14:00:00Z', status: 'held', source: 'onboard_card' }),
  // Mon 28 Sep 3:00 pm ET = Tue 29 Sep 12:30 am Colombo — they didn't show
  noshow: calM({ id: 'mnoshow', clientId: 'fern-it', company: 'Fern IT', person: 'Lee Park', start: '2026-09-28T19:00:00Z', minutes: 15, status: 'no_show', source: 'inbox' }),
  // Thu 1 Oct 11:00 am ET = Thu 8:30 pm Colombo — the owner blocked an hour
  blocked: calM({ id: 'mblocked', title: 'Busy', start: '2026-10-01T15:00:00Z', minutes: 60, status: 'blocked', source: 'owner' }),
  cancelled: calM({ id: 'mcancelled', clientId: 'iris-dental', company: 'Iris Dental', person: 'Ivy Ross', start: '2026-09-30T14:00:00Z', status: 'cancelled', declineReason: 'They moved it' }),
  declined: calM({ id: 'mdeclined', clientId: 'cobalt-hvac', company: 'Cobalt HVAC', person: 'Dee Cole', start: '2026-10-02T15:00:00Z', status: 'declined', declineReason: 'Not a fit' }),
  // Sat 3 Oct 11:00 am Colombo — the owner's own meeting, outside the call hours
  own: calM({ id: 'mown', title: 'Call with my accountant', start: '2026-10-03T05:30:00Z', status: 'confirmed', source: 'owner', theirZone: null }),
};
const CM = calMeetings;
export const calWeek = {
  meetings: [CM.held, CM.noshow, CM.conf, CM.req1, CM.cancelled, CM.blocked, CM.req2, CM.req3, CM.declined, CM.own],
  requests: [CM.req3, CM.req1, CM.req2],   // the machine sends them oldest first
  settings: calSettingsFixture,
  free: [
    { start: '2026-09-28T13:00:00Z', minutes: 30 },   // Mon 6:30 pm — already past at CAL_NOW
    { start: '2026-09-29T14:00:00Z', minutes: 30 },   // Tue 7:30 pm
    { start: '2026-09-30T13:00:00Z', minutes: 30 },   // Wed 6:30 pm
    { start: '2026-09-30T13:30:00Z', minutes: 30 },   // Wed 7:00 pm
    { start: '2026-10-01T19:30:00Z', minutes: 30 },   // Fri 2 Oct 1:00 am (Thu 3:30 pm ET)
  ],
};
/* Mon 2 – Sun 8 Nov 2026: US Eastern is back on winter time (EST, UTC−5) — 9 am ET = 7:30 pm Colombo. */
export const calWinterWeek = {
  meetings: [
    calM({ id: 'mw1', clientId: 'acme-plumbing', company: 'Acme Plumbing', person: 'Ann Lee', start: '2026-11-03T14:00:00Z', status: 'confirmed' }),   // Tue 9 am ET = Tue 7:30 pm Colombo
    calM({ id: 'mw2', clientId: 'gale-roofing', company: 'Gale Roofing', person: 'Mia Gale', start: '2026-11-03T21:00:00Z', status: 'confirmed' }),    // Tue 4 pm ET = Wed 2:30 am Colombo
  ],
  requests: [], settings: calSettingsFixture, free: [],
};
/* Everything a hostile machine answer could carry. */
export const calHostile = calM({ id: 'x"\');alert(4);//', clientId: 'ev"il', company: '<img src=x onerror=alert(1)>', person: '"><script>alert(2)</script>', title: '<svg onload=alert(3)>', email: '"><script>@x.com', start: '2026-09-30T13:00:00Z', status: 'requested', note: '</div><script>alert(6)</script>', theirZone: 'Not/AZone', source: '<b>src</b>', history: [{ at: '2026-09-29T03:00:00Z', what: '<i>odd</i>', by: '<u>who</u>' }] });

/* ───── Messages, the reply bot and Google Meet (email-distributor docs/REPLYBOT-MEET.md) ─────
   `conversation` on the trial detail: every email with the client, deliberately out of order (the hub
   shows it oldest first). NOW is Sat 17 Oct 2026 12:00 UTC. Times: 2026-10-15T02:00Z = Thu 15 Oct 7:30 am
   in Sri Lanka = Wed 10:00 pm US Eastern (the day before); 2026-10-16T09:00Z = Fri 2:30 pm = Fri 5:00 am ET. */
const SUBJ = "You're in — let's book your onboarding call";
export const conversation = {
  thread: [
    { id: 'c5', dir: 'in', at: '2026-10-16T14:00:00Z', from: 'sam@ecreek.io', to: 'hello@aviance.store', subject: 'Re: ' + SUBJ, text: 'How much is it after the trial?', kind: 'reply', auto: false, rule: null },
    { id: 'c1', dir: 'out', at: '2026-10-15T02:00:00Z', from: 'hello@aviance.store', to: 'sam@ecreek.io', subject: SUBJ, text: 'Hi Sam, good news: we would like to run your free 30-day trial for eCreek IT.', kind: 'acceptance', auto: false, rule: null },
    { id: 'c2', dir: 'out', at: '2026-10-15T02:01:00Z', from: 'hello@aviance.store', to: 'sam@ecreek.io', subject: 'Your trial dates', text: 'Day 1 is Monday 26 October.\nDay 30 is Tuesday 24 November.', kind: 'system', template: 'welcome_dates', auto: false, rule: null },
    { id: 'c3', dir: 'in', at: '2026-10-16T09:00:00Z', from: 'Sam Test <sam@ecreek.io>', to: 'hello@aviance.store', subject: 'Re: ' + SUBJ, text: 'Hi!\nWhat times work for you?\n<script>alert(1)</script>', kind: 'reply', auto: false, rule: null },
    { id: 'c4', dir: 'out', at: '2026-10-16T09:03:00Z', from: 'hello@aviance.store', to: 'sam@ecreek.io', subject: 'Re: ' + SUBJ, text: 'Here is my booking page: https://aviance.store/book\nOr one of these: Tue 20 Oct 10:00 am your time', kind: 'auto_reply', auto: true, rule: 'wants_time' },
    { id: 'c6', dir: 'out', at: '2026-10-16T14:03:00Z', from: 'hello@aviance.store', to: 'sam@ecreek.io', subject: 'Re: ' + SUBJ, text: 'The 30-day trial is free, with no card.', kind: 'auto_reply', auto: true, rule: 'price' },
    { id: 'c7', dir: 'out', at: '2026-10-16T15:00:00Z', from: 'hello@aviance.store', to: 'sam@ecreek.io', subject: 'Re: ' + SUBJ, text: 'Happy to go through the plans on the call.', kind: 'owner_reply', auto: false, rule: null },
    { id: 'c8', dir: 'in', at: '2026-10-17T08:30:00Z', from: 'Ops <ops@ecreek.io>', to: 'hello@aviance.store', subject: 'Re: ' + SUBJ, text: 'Sam is out today — can we do Wednesday instead?', kind: 'reply', auto: false, rule: null },
  ],
  needsReply: true, lastInAt: '2026-10-17T08:30:00Z', lastOutAt: '2026-10-16T15:00:00Z',
  bot: { enabled: true, sentToday: 1, maxPerDay: 3 },
  canReply: true, fromInbox: 'hello@aviance.store',
};
/* eCreek's page with the conversation (the onboarding call card keeps its steps; its thread is the same list). */
export const ecreekConvDetail = Object.assign({}, ecreekDetail, { conversation });
/* Every reply-bot rule, for the label test. */
export const botRuleWords = {
  wants_time: 'sent your booking link and free times',
  proposes_time: 'pencilled in the time they asked for',
  reschedule: 'sent the booking page to pick another time',
  price: 'explained the trial is free',
  what_needed: 'sent the one-page form',
  not_interested: 'said goodbye and stopped reminders',
};
/* GET /api/mc/google in each of its four states (as built: + clientFrom, brokenAt, problem, encKey). */
const G_REDIRECT = 'https://email-distributor.vercel.app/api/google/callback';
const gs = (o) => Object.assign({ account: null, redirectUri: G_REDIRECT, hasClient: true, clientFrom: 'saved', connectedAt: null, brokenAt: null, problem: null, encKey: true }, o);
export const googleStates = {
  not_set_up: gs({ status: 'not_set_up', hasClient: false, clientFrom: null }),
  ready_to_connect: gs({ status: 'ready_to_connect' }),
  connected: gs({ status: 'connected', account: 'owner@gmail.com', connectedAt: '2026-10-16T08:00:00Z' }),
  broken: gs({ status: 'broken', account: 'owner@gmail.com', connectedAt: '2026-10-01T08:00:00Z', brokenAt: '2026-10-15T08:00:00Z', problem: 'the connection was removed or has expired' }),
};
/* The callback's ?error= codes (REPLYBOT-MEET §3 as built). */
export const googleErrorCodes = ['state', 'denied', 'calendar_permission', 'exchange', 'not_set_up', 'no_refresh_token', 'google_down', 'google', 'no_code', 'server'];
/* Calendar meetings with Google Meet (hub meetings gain meetLink, googleEventId; meetError when Google couldn't make one). */
export const calMeet = {
  // Tue 29 Sep 9:00 am ET — confirmed, with its Meet
  linked: calM({ id: 'mmeet', clientId: 'acme-plumbing', company: 'Acme Plumbing', person: 'Ann Lee', email: 'ann@acme.com', title: 'Onboarding call — Acme Plumbing', start: '2026-09-29T13:00:00Z', status: 'confirmed', confirmedAt: '2026-09-27T11:00:00Z', meetLink: 'https://meet.google.com/xyz-abcd-efg', googleEventId: 'ev123' }),
  // confirmed, Google not connected (meetError is plain words — HUB-API "Google Meet")
  noGoogle: calM({ id: 'mnog', clientId: 'gale-roofing', company: 'Gale Roofing', person: 'Mia Gale', start: '2026-10-01T13:00:00Z', status: 'confirmed', meetLink: null, meetError: "Google isn't connected" }),
  // confirmed, a hostile link and a hostile reason
  hostile: calM({ id: 'mbad', company: 'Bad Co', person: 'Eve', start: '2026-10-01T14:00:00Z', status: 'confirmed', meetLink: 'javascript:alert(1)', meetError: '<img src=x onerror=alert(2)> went wrong' }),
};

/* ───────────── Their domain and inboxes through CheapInboxes (email-distributor docs/AUTO-BUY.md) ─────────────
   The owner buys in his own CheapInboxes account; the system finds the purchase and sets up the rest — it never
   buys anything. `autobuy` on the trial detail in each status, and GET /api/mc/cheapinboxes in each state. */
const AB_STEPS = [['bought', 'You bought it'], ['domain', 'Domain live + spam protection set'], ['inboxes', '2 inboxes created'], ['connected', 'Connected to our system'], ['warmup', 'Warm-up started']];
const AB_AT = ['2026-10-16T10:00:00Z', '2026-10-16T14:00:00Z', '2026-10-17T02:00:00Z', '2026-10-17T03:00:00Z', '2026-10-17T03:30:00Z'];
const abSteps = (n) => AB_STEPS.map(([key, label], i) => ({ key, label, done: i < n, at: i < n ? AB_AT[i] : null }));
/* What to buy (autobuy.buy): the listed alternatives include the chosen name again and a fourth one — the hub shows 3 others. */
export const autobuyBuy = {
  domain: 'getbrightdental.com', price: 9.99, provider: 'google',
  alternatives: [{ domain: 'brightdentalhq.com', price: 9.99 }, { domain: 'getbrightdental.com', price: 9.99 }, { domain: 'trybrightdental.com', price: 10.49 }, { domain: 'brightdental.co', price: 8.99 }, { domain: 'fourth-name.com', price: 11.99 }],
  mailboxes: [{ firstName: 'Raj', lastName: 'Patel', prefix: 'raj', email: 'raj@getbrightdental.com' }, { firstName: 'Raj', lastName: 'Patel', prefix: 'raj.patel', email: 'raj.patel@getbrightdental.com' }],
  orderUrl: 'https://www.cheapinboxes.com/order?domain=getbrightdental.com&mailboxes=2',
};
const abOf = (o) => Object.assign({ status: 'not_set_up', buy: null, label: '', domain: null, steps: [], mailboxes: [], problem: null }, o);
const abBoxes = (a, b) => [{ email: 'raj@getbrightdental.com', status: a }, { email: 'raj.patel@getbrightdental.com', status: b }];
export const autobuyStates = {
  not_set_up: abOf({}),
  ready_to_buy: abOf({ status: 'ready_to_buy', buy: autobuyBuy, label: 'Buy getbrightdental.com and 2 inboxes on CheapInboxes', domain: 'getbrightdental.com', steps: abSteps(0) }),
  provisioning: abOf({ status: 'provisioning', label: 'Setting up getbrightdental.com — about 48 hours', domain: 'getbrightdental.com', steps: abSteps(1), mailboxes: abBoxes('provisioning', 'provisioning') }),
  connecting: abOf({ status: 'connecting', label: 'Connecting getbrightdental.com — nearly there', domain: 'getbrightdental.com', steps: abSteps(3), mailboxes: abBoxes('connected', 'active') }),
  done: abOf({ status: 'done', label: 'getbrightdental.com and 2 inboxes are ready — warm-up has started', domain: 'getbrightdental.com', steps: abSteps(5), mailboxes: abBoxes('connected', 'connected') }),
  failed: abOf({ status: 'failed', label: 'Setting up getbrightdental.com stopped', domain: 'getbrightdental.com', steps: abSteps(2), mailboxes: abBoxes('provisioning', 'provisioning'), problem: 'CheapInboxes could not create the inboxes because the card was declined. Update the card in your CheapInboxes account under Billing, then press Check now' }),
};
/* Bright Dental (state awaiting_purchase, its old "buy and paste" to-do still on the row) with CheapInboxes in one status;
   the row's plain sentence is the machine's for that status. */
export const brightAb = (status, simple) => ({
  row: withSimple(bright, Object.assign({ step: 'setting_up', label: 'Setting up their inboxes (about 2 days)', next: 'Nothing for you: we connect the inboxes by ourselves', needsYou: false, since: '2026-10-16T22:00:00Z' },
    status === 'ready_to_buy' ? { label: 'Setting up their emails (about 2 weeks)', next: 'Buy their domain and 2 inboxes on CheapInboxes', needsYou: true }
      : status === 'failed' ? { label: 'Setting up their inboxes stopped', next: 'Update the card on CheapInboxes, then check again', needsYou: true }
      : status === 'not_set_up' ? { label: 'Setting up their emails (about 2 weeks)', next: 'Buy the domain and 2 inboxes, then paste the logins', needsYou: true } : {}, simple)),
  autobuy: autobuyStates[status],
});
const ciOf = (o) => Object.assign({ status: 'connected', account: 'Aviance Ltd', hasPaymentMethod: true, webhook: 'registered', unmatched: [] }, o);
export const cheapStates = {
  not_set_up: ciOf({ status: 'not_set_up', account: null, hasPaymentMethod: null, webhook: 'missing' }),
  connected: ciOf({}),
  noCard: ciOf({ hasPaymentMethod: false }),
  noUpdates: ciOf({ webhook: 'missing' }),
  broken: ciOf({ status: 'broken', problem: 'CheapInboxes turned the key down — it may have been deleted.' }),
  unmatched: ciOf({ unmatched: [{ domain: 'brightdental-mail.com', mailboxes: 2, boughtAt: '2026-10-16T10:00:00Z' }, { domain: 'odd-name.io', mailboxes: 1, boughtAt: null }] }),
};

/* ───── Warm-up (email-distributor docs/WARMUP-HUB.md) ─────
   GET /api/mc/warmup (the circle, the helpers, the kinds of helper account with their steps) and `warmup` on a trial.
   The system never creates accounts: the owner makes each helper once; the circle needs 8 members. */
export const warmupProviders = [
  { key: 'google', label: 'Gmail', steps: ['Make a new Gmail account.', 'Turn on 2-Step Verification in its Google account.', 'Open myaccount.google.com/apppasswords and make an app password.', 'Paste the address and the 16-letter app password below.'], note: 'Use the app password, not the normal Gmail password.', passwordLabel: '16-letter app password' },
  { key: 'yahoo', label: 'Yahoo', steps: ['Make a new Yahoo account.', 'Open Account security and press Generate app password.', 'Paste the address and the app password below.'], note: 'Yahoo no longer lets apps use the normal password.', passwordLabel: 'app password' },
  { key: 'aol', label: 'AOL', steps: ['Make a new AOL account.', 'Open Account security and press Generate app password.', 'Paste the address and the app password below.'], note: '', passwordLabel: 'app password' },
  { key: 'icloud', label: 'iCloud', steps: ['Make an Apple Account with an @icloud.com address.', 'Turn on two-factor authentication.', 'Open account.apple.com › Sign-In and Security › App-Specific Passwords and make one.', 'Paste the address and the app-specific password below.'], note: '', passwordLabel: 'app-specific password' },
  { key: 'gmx', label: 'GMX', steps: ['Make a gmx.com account.', 'In GMX open Settings › POP3 & IMAP and switch access on.', 'Paste the address and the password below.'], note: 'GMX switches that setting off after a long quiet spell; the circle checks in every 30 minutes, which keeps it on.', passwordLabel: 'password' },
  { key: 'webde', label: 'WEB.DE', steps: ['Make a web.de account.', 'Open Settings › POP3/IMAP and switch it on.', 'Paste the address and the password below.'], note: '', passwordLabel: 'password' },
  { key: 'yandex', label: 'Yandex', steps: ['Make a Yandex account (it asks for a phone number).', 'Open Settings › Email clients and switch on both options.', 'Open id.yandex.com › Security › App passwords and make one for Mail.', 'Paste the address and the app password below.'], note: '', passwordLabel: 'app password' },
];
const wuHelper = (email, provider, providerLabel, health, problem) => ({ email, provider, providerLabel, health, lastOkAt: health === 'ok' ? '2026-10-17T10:00:00Z' : null, problem: problem || null, sentToday: health === 'ok' ? 3 : 0 });
export const warmupHelpersList = [
  wuHelper('mia.helper@gmail.com', 'google', 'Gmail', 'ok'),
  wuHelper('sun.helper@yahoo.com', 'yahoo', 'Yahoo Mail', 'new'),
  wuHelper('old.helper@aol.com', 'aol', 'AOL Mail', 'failing', 'AOL said the app password is wrong — make a new one under Account security.'),
  wuHelper('rest.helper@gmx.com', 'gmx', 'GMX', 'disabled'),
];
const wuCircleOf = (o) => Object.assign({ members: 6, helpers: 3, clientInboxes: 1, avianceInboxes: 2, min: 8, ready: false, missing: 2, label: '6 of 8 in the warm-up circle — add 2 more helpers' }, o);
export const warmupStates = {
  short: { circle: wuCircleOf({}), helpers: warmupHelpersList, providers: warmupProviders },
  ready: { circle: wuCircleOf({ members: 9, helpers: 6, ready: true, missing: 0, label: '9 in the warm-up circle — enough for new inboxes' }), helpers: warmupHelpersList, providers: warmupProviders },
  empty: { circle: wuCircleOf({ members: 3, helpers: 0, missing: 5, label: '3 of 8 in the warm-up circle — add 5 more helpers' }), helpers: [], providers: warmupProviders },
  oneShort: { circle: wuCircleOf({ members: 7, helpers: 4, missing: 1, label: null }), helpers: warmupHelpersList, providers: warmupProviders },
  // an older system: no `circle` and no `providers` — its members list, minPool and its own health words
  older: { members: [1, 2, 3, 4, 5].map((i) => ({ email: 'm' + i + '@x.com' })), minPool: 8, helpers: [{ email: 'a@yahoo.com', provider: 'yahoo', health: 'auth_failed', enabled: '1' }, { email: 'b@gmail.com', provider: 'google', health: 'ok', enabled: '0' }], presets: [] },
};
/* `warmup` on the trial detail, in each status (Gale Roofing's two inboxes). */
const galeBox = (email, day, rate, ready) => ({ email, day, sentToday: day ? 8 : 0, inboxRate7d: rate, ready: !!ready });
export const galeWarmup = {
  warming: { status: 'warming', label: 'Warming up — day 5 of about 14 · 96% reach the inbox', day: 5, of: 14, readyBy: '2026-10-26', inboxRate: 0.96, inboxes: [galeBox('mia@galeroofing-mail.com', 5, 0.96), galeBox('hello@galeroofing-mail.com', 4, null)], problem: null },
  waiting: { status: 'waiting_for_helpers', label: 'Waiting for warm-up helpers — 6 of 8 in the circle', day: 0, of: 14, readyBy: null, inboxRate: null, inboxes: [galeBox('mia@galeroofing-mail.com', 0, null), galeBox('hello@galeroofing-mail.com', 0, null)], problem: null },
  ready: { status: 'ready', label: 'Warm-up done — ready for Day 1', day: 14, of: 14, readyBy: null, inboxRate: 0.95, inboxes: [galeBox('mia@galeroofing-mail.com', 14, 0.95, true), galeBox('hello@galeroofing-mail.com', 14, 0.94, true)], problem: null },
  paused: { status: 'paused', label: 'Warm-up paused on day 7', day: 7, of: 14, readyBy: null, inboxRate: 0.78, inboxes: [galeBox('mia@galeroofing-mail.com', 7, 0.78)], problem: 'Fewer than 8 in 10 warm-up emails reached the inbox, so it slowed down to recover' },
};
export const galeWarmupTodo = { id: 'warmup-helpers:gale-roofing', text: 'Add 2 warm-up helpers — Settings › Warm-up', detail: 'The circle has 6 of the 8 it needs', urgent: true, since: '2026-10-17T08:00:00Z', action: { type: 'view', view: 'settings', section: 'warmup' } };
/* Gale Roofing with its warm-up in one status. The machine's plain sentence for the warming step is the warm-up label;
   while it waits for helpers the row needs the owner and carries the "Add 2 warm-up helpers" to-do. */
export const galeWu = (status, simple, rowExtra) => ({
  row: withSimple(Object.assign({}, gale, status === 'waiting' ? { todo: [galeWarmupTodo] } : {}, rowExtra), Object.assign({ step: 'warming_up', label: galeWarmup[status].label, next: 'Nothing for you: the first emails go out on Mon 26 Oct', needsYou: false, since: '2026-10-12T09:00:00Z' },
    status === 'waiting' ? { next: 'Add 2 warm-up helpers — Settings › Warm-up', needsYou: true } : {}, simple)),
  warmup: galeWarmup[status],
});
