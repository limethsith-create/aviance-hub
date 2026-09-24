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
  stages: stagesWith({ setup: [bright], live: [acme], won: [cobalt] }),
  todos: [
    Object.assign({ clientId: 'bright-dental', clientName: 'Bright Dental' }, bright.todo[0]),
    Object.assign({ clientId: 'acme-plumbing', clientName: 'Acme Plumbing' }, acme.todo[0]),
    Object.assign({ clientId: 'cobalt-hvac', clientName: 'Cobalt HVAC' }, cobalt.todo[0]),
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
};
