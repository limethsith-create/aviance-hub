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

/* ───────────── v2 additions (HUB-API.md "v2 additions") ───────────── */

/* Tiny growth payload with every kind of null, for exact mapping tests:
   day 0 and day 4: nothing recorded (gap) · day 2: sent but no sentD0/replies field (a recorded day → 0)
   day 3: only a reply came in (a recorded day → sent 0) · warm-up day 3: outage (gap). */
export const tinyGrowth = {
  days: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'],
  email: { sent: [null, 40, 38, null, null, 45], sentD0: [null, 22, null, null, null, 20], replies: [null, 2, null, 1, null, 3], positive: [null, 1, null, null, null, 2], booked: [null, null, null, null, null, 1], held: [null, null, null, null, null, null], qualified: [null, null, null, null, null, 1], bounces: [null, 1, null, null, null, null] },
  warmup: { sent: [null, 30, 30, null, 30, 31], inbox: [null, 27, 28, null, 29, 30], spam: [null, 3, 2, null, 1, 1], rate: [null, 0.9, 0.92, null, 0.94, 0.95] },
  inboxes: [{ email: 'ann@acme-team.com', dailyCap: 12, warmupStartedAt: '2026-09-22T09:10:00Z', sent: [null, 15, 15, null, 15, 16], rate: [null, 0.9, 0.93, null, 0.95, 0.96] }],
  placement: [{ day: '2026-10-13', at: '2026-10-13T11:30:00Z', tool: 'seed', inboxRate: 0.9, score: null, min: 0.8, perProvider: { gmail: 1, outlook: 0.67 } }, { day: '2026-10-16', at: '2026-10-16T12:00:00Z', tool: 'mail-tester', inboxRate: null, score: 9.1, min: null, perProvider: null }],
};

/* Realistic growth history, deterministic. Warm-up from warmStart (one outage day = null),
   sending on weekdays from day1 (weekends = null, one weekend reply), two inboxes. */
export function makeGrowth(days = 45, { end = '2026-10-17', warmStart = '2026-09-22', day1 = '2026-10-06', outage = '2026-10-01', inboxes = [['ann@acme-team.com', 12], ['hello@acme-team.com', 8]] } = {}) {
  let seed = 11; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const endMs = Date.parse(end + 'T12:00:00Z'); const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(new Date(endMs - i * 864e5).toISOString().slice(0, 10));
  const age = (k, from) => Math.round((Date.parse(k) - Date.parse(from)) / 864e5);
  const email = { sent: [], sentD0: [], replies: [], positive: [], booked: [], held: [], qualified: [], bounces: [] };
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
    const sending = k >= day1 && !weekend;
    if (sending) {
      const d = age(k, day1); const s = Math.min(50, 16 + d * 3); const d0 = Math.round(s * (d < 3 ? 1 : 0.5));
      const r = rnd() < 0.55 ? 1 + Math.floor(rnd() * 3) : null;
      email.sent.push(s); email.sentD0.push(d0); email.replies.push(r); email.positive.push(r && rnd() < 0.6 ? 1 : null);
      email.booked.push(r && rnd() < 0.35 ? 1 : null); email.held.push(null); email.qualified.push(null); email.bounces.push(rnd() < 0.3 ? 1 : null);
    } else if (k >= day1 && weekend && dow === 6) {
      email.sent.push(null); email.sentD0.push(null); email.replies.push(1); email.positive.push(null); email.booked.push(null); email.held.push(null); email.qualified.push(null); email.bounces.push(null);
    } else { Object.keys(email).forEach((f) => email[f].push(null)); }
  });
  const sumAt = (f, i) => { let any = false, t = 0; per.forEach((ib) => { if (ib[f][i] != null) { any = true; t += ib[f][i]; } }); return any ? t : null; };
  const rolling = (inbox, spam, i) => { let a = 0, b = 0, seen = false; for (let j = Math.max(0, i - 6); j <= i; j++) { if (inbox[j] != null || spam[j] != null) seen = true; a += inbox[j] || 0; b += spam[j] || 0; } return seen && a + b > 0 ? Math.round((a / (a + b)) * 1000) / 1000 : null; };
  const wInbox = keys.map((_, i) => sumAt('inbox', i)), wSpam = keys.map((_, i) => sumAt('spam', i));
  const placement = [];
  keys.forEach((k, i) => {
    if (k >= warmStart && age(k, warmStart) >= 10 && age(k, warmStart) % 3 === 1) placement.push({ day: k, at: k + 'T11:30:00Z', tool: 'seed', inboxRate: Math.round((0.8 + rnd() * 0.18) * 100) / 100, score: null, min: 0.67, perProvider: null });
    if (k === day1 || (k > day1 && age(k, day1) === 7)) placement.push({ day: k, at: k + 'T12:00:00Z', tool: 'mail-tester', inboxRate: null, score: Math.round((8.6 + rnd()) * 10) / 10, min: null, perProvider: null });
  });
  return {
    days: keys, email,
    warmup: { sent: keys.map((_, i) => sumAt('sent', i)), inbox: wInbox, spam: wSpam, rate: keys.map((_, i) => rolling(wInbox, wSpam, i)) },
    inboxes: inboxes.map(([addr, cap], j) => ({ email: addr, dailyCap: cap, warmupStartedAt: warmStart + 'T09:10:00Z', sent: per[j].sent, rate: keys.map((_, i) => rolling(per[j].inbox, per[j].spam, i)) })),
    placement,
  };
}

export const research = {
  status: 'done', at: '2026-10-17T10:05:00Z', error: null,
  summary: 'Fern IT is a managed IT company in Austin, TX (4.8★, 57 Google reviews) that looks after dental and medical practices; about 12 people on the team.',
  website: { url: 'https://fernit.com', title: 'Fern IT — Managed IT for clinics', description: 'Managed IT, cybersecurity and HIPAA compliance for dental and medical practices across Texas.', headline: 'IT that keeps your practice running', services: ['Managed IT', 'Cybersecurity', 'HIPAA compliance', 'Cloud backup'], locations: ['Austin, TX', 'San Antonio, TX'], phones: ['(512) 555-0142'], emails: ['hello@fernit.com'], socials: { linkedin: 'https://www.linkedin.com/company/fernit', facebook: 'https://facebook.com/fernit', x: 'javascript:alert(1)' }, teamHint: '12 people on the team page', yearsHint: 'Since 2011', pagesRead: 4 },
  business: { name: 'Fern IT', address: '1200 Congress Ave, Austin, TX 78701', category: 'Computer support and services', rating: 4.8, reviews: 57, mapsUrl: 'https://maps.google.com/?cid=123456', phone: '(512) 555-0142' },
  market: { query: 'dental practices in Texas', estimate: 4820, source: 'places' },
  flags: [{ level: 'warn', text: "Website mentions 'lead generation' once — could be an agency" }, { level: 'info', text: 'Two office locations listed' }],
};
fernApplication.research = research;

export const shoppingV2 = {
  chosenDomain: 'getbrightdental.com', backups: ['brightdentalhq.com'], registrarQuotes: [], inboxQuotes: [], senderAddresses: ['raj@getbrightdental.com', 'hello@getbrightdental.com'], total: 16.73, sentAt: '2026-10-16T22:00:00Z', boughtAt: null, unconfirmed: [],
  offers: [
    { domain: 'getbrightdental.com', tld: 'com', available: true, score: 92, why: "Short, brand + 'get', .com", best: { registrar: 'Porkbun', firstYear: 9.73, renewal: 11.08 },
      prices: [{ registrar: 'Porkbun', firstYear: 9.73, renewal: 11.08, promo: null, url: 'https://porkbun.com/checkout/search?q=getbrightdental.com', confirmedAt: '2026-10-16T21:00:00Z', source: 'live' }, { registrar: 'Cloudflare', firstYear: 10.44, renewal: 10.44, promo: null, url: 'https://www.cloudflare.com/products/registrar/', confirmedAt: null, source: 'table' }, { registrar: 'Namecheap', firstYear: 11.28, renewal: 15.88, promo: 'NEWCOM598', url: 'https://www.namecheap.com', confirmedAt: null, source: 'table' }] },
    { domain: 'brightdentalhq.com', tld: 'com', available: true, score: 85, why: "Brand + 'hq', .com", best: { registrar: 'Cloudflare', firstYear: 10.44, renewal: 10.44 },
      prices: [{ registrar: 'Cloudflare', firstYear: 10.44, renewal: 10.44, promo: null, url: 'https://www.cloudflare.com/products/registrar/', confirmedAt: null, source: 'table' }, { registrar: 'Porkbun', firstYear: 11.06, renewal: 11.08, promo: null, url: 'https://porkbun.com', confirmedAt: '2026-10-16T21:00:00Z', source: 'live' }] },
    { domain: 'bright-dental.co', tld: 'co', available: true, score: 71, why: '.co is cheap in year one but renews high', best: { registrar: 'Porkbun', firstYear: 8.64, renewal: 26.48 }, prices: [{ registrar: 'Porkbun', firstYear: 8.64, renewal: 26.48, promo: null, url: 'javascript:alert(2)', confirmedAt: null, source: 'live' }] },
    { domain: 'trybrightdental.com', tld: 'com', available: false, score: 60, why: 'Taken', best: null, prices: [] },
  ],
  registrars: [{ name: 'Porkbun', why: 'Cheapest .com, free WHOIS privacy', url: 'https://porkbun.com' }, { name: 'Cloudflare', why: 'At-cost renewals', url: 'https://www.cloudflare.com/products/registrar/' }, { name: 'Namecheap', why: 'Frequent promo codes', url: 'https://www.namecheap.com' }, { name: 'Spaceship', why: 'Low first year', url: 'https://www.spaceship.com' }, { name: 'Dynadot', why: 'Simple checkout', url: 'https://www.dynadot.com' }],
  inboxes: { provider: 'CheapInboxes', url: 'https://cheapinboxes.com', perInbox: 3.5, count: 2, monthly: 7, notes: 'Google Workspace inboxes with app passwords; cancel any time from their dashboard.', steps: ['Create an account at cheapinboxes.com', 'Add the domain getbrightdental.com and set the DNS records they show', 'Create raj@getbrightdental.com — display name "Raj Patel"', 'Create hello@getbrightdental.com — display name "Raj Patel"', 'Turn on 2-step verification and make an app password for each inbox', 'Paste both logins below'] },
  totals: { domainFirstYear: 9.73, inboxesMonthly: 7, firstMonth: 16.73 },
};
export const brightPurchase = { client: { id: 'bright-dental', name: 'Bright Dental', state: 'awaiting_purchase', mainDomain: 'brightdental.com' }, shopping: shoppingV2, setup: { domain: { name: null, setupPhase: null }, checks: {}, senderName: 'Raj Patel' }, inboxes: [], encKey: true };

detail.deliverability = {
  warmup: { pool: 14, helpers: 10, providers: { gmail: 4, outlook: 3, yahoo: 2, zoho: 2, workspace: 3 }, todayPairs: 11, external: { name: 'Outside warm-up network', status: 'not connected' } },
  placement: [
    { at: '2026-10-16T12:00:00Z', tool: 'mail-tester', score: 9.1, inboxRate: null, detail: ['SPF pass', 'DKIM pass', 'DMARC pass', 'No broken links'], reportUrl: 'https://www.mail-tester.com/test-abc123' },
    { at: '2026-10-15T11:30:00Z', tool: 'seed', score: null, inboxRate: 0.9, detail: ['gmail 3/3', 'outlook 2/3', 'yahoo 2/2'], reportUrl: 'javascript:alert(3)' },
  ],
  blacklists: { checkedAt: '2026-10-17T06:10:00Z', listed: [], clean: 7, lists: ['bl.spamcop.net', 'b.barracudacentral.org', 'dnsbl.sorbs.net', 'spam.dnsbl.sorbs.net', 'psbl.surriel.com', 'dnsbl-1.uceprotect.net', 'bl.mailspike.net'] },
  bounce: { rate7d: 0.012, pauseAt: 0.015, stopAt: 0.02 },
};
detail.leadQuality = {
  graded: 812, grades: { A: 140, B: 210, C: 90, rejected: 372 }, sendable: 350,
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
