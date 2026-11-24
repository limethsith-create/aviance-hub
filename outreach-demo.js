/* ===================== AVIANCE OS — Outreach: demo tool =====================
   A complete fake outreach tool, so every outreach screen works today with no
   key, no account and no network. Nothing here reaches outside the browser.

   The numbers are made up but they are STABLE: everything is seeded off the
   client's own id and the day in question, so a screen shows the same numbers
   on every render and the shape looks like real cold email — a 2-4% reply
   rate, a few bounces, weekends quiet, inboxes at different stages of warmup.

   Interface: outreach-adapter.js (the five methods, {ok,data,error}, no throw).
   ============================================================================ */

/* ---- stable randomness ------------------------------------------- */

/* A string -> a 32-bit seed. Same string, same seed, every time. */
function oaDemoSeed(str){
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/* A seed -> a 0..1 number. No state, so the same seed always gives the same
   number however many times a screen asks. */
function oaDemoRnd(seed){
  let t = (oaDemoSeed(seed) + 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const oaDemoPick = (seed, list) => list[Math.floor(oaDemoRnd(seed) * list.length) % list.length];
const oaDemoBetween = (seed, lo, hi) => lo + oaDemoRnd(seed) * (hi - lo);
const oaDemoIntBetween = (seed, lo, hi) => Math.round(oaDemoBetween(seed, lo, hi));

const OA_DEMO_OK = (data) => ({ok:true, data, error:''});

const OA_DEMO_CAMPAIGN_NAMES = [
  'Roofers — Texas', 'HVAC — Midwest', 'Dental — Florida', 'Solar installers — AZ',
  'Law firms — NY', 'Med spas — California', 'Accountants — UK'
];
const OA_DEMO_COMPANIES = [
  'Stone Roofing', 'Harbor Dental', 'Cobalt HVAC', 'Bright Path Solar', 'Reed & Finch',
  'Lakeside Med Spa', 'Pinewood Accounting', 'Granite Build', 'Clearview Windows',
  'Northgate Plumbing', 'Ember Electrical', 'Silverline Legal'
];
const OA_DEMO_FIRST = ['Dana','Marcus','Priya','Tom','Elena','Chris','Aisha','Ben','Noor','Ray','Lucy','Omar'];
const OA_DEMO_LAST  = ['Whitfield','Reyes','Nair','Brady','Costa','Doyle','Khan','Mercer','Haddad','Olsen','Grant','Vance'];
const OA_DEMO_TITLES = ['Owner','Operations Manager','Managing Director','Founder','General Manager','Practice Manager'];
const OA_DEMO_DOMAINS = ['outreach-aviance.com','mail-aviance.com','go-aviance.com'];

/* ---- campaigns ---------------------------------------------------- */

/* Three or four campaigns per client, with lifetime totals that match the
   daily rows below (the totals are the sum of the last 60 days). */
function oaDemoCampaigns(clientId){
  const n = 3 + Math.floor(oaDemoRnd(clientId + ':count') * 2);   // 3 or 4
  const out = [];
  for (let i = 0; i < n; i++) {
    const key = clientId + ':camp:' + i;
    const status = i === 0 ? 'running'
      : i === 1 ? 'running'
      : oaDemoRnd(key + ':status') < 0.5 ? 'paused' : 'finished';
    const startedDaysAgo = oaDemoIntBetween(key + ':start', 40, 120);
    const camp = {
      externalId: 'demo-camp-' + i + '-' + oaDemoSeed(clientId).toString(36).slice(0, 6),
      name:       oaDemoPick(key + ':name', OA_DEMO_CAMPAIGN_NAMES),
      status,
      startedOn:  oaDemoShift(oaDemoToday(), -startedDaysAgo),
      sent: 0, opened: 0, replied: 0, positive: 0, booked: 0, bounced: 0, unsubscribed: 0
    };
    const days = oaDemoDaily(clientId, camp, i, oaDemoShift(oaDemoToday(), -59), oaDemoToday());
    days.forEach(d => {
      camp.sent += d.sent; camp.opened += d.opened; camp.replied += d.replied;
      camp.positive += d.positive; camp.booked += d.booked;
      camp.bounced += d.bounced; camp.unsubscribed += d.unsubscribed;
    });
    out.push(camp);
  }
  return out;
}

const oaDemoToday = () => new Date().toISOString().slice(0, 10);
function oaDemoShift(day, by){
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}
function oaDemoDays(from, to){
  const out = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard++ < 400) { out.push(d); d = oaDemoShift(d, 1); }
  return out;
}

/* One campaign's numbers for one day. Seeded off the client, the campaign and
   the date, so the same day always reads the same. */
function oaDemoDayRow(clientId, camp, index, day){
  const key = clientId + '|' + camp.externalId + '|' + day;
  const dow = new Date(day + 'T00:00:00Z').getUTCDay();
  const weekend = dow === 0 || dow === 6;
  const live = camp.status === 'running' || camp.status === 'finished'
    || (camp.status === 'paused' && day < oaDemoShift(oaDemoToday(), -14));

  let sent = 0;
  if (live && !weekend && day >= camp.startedOn) {
    const base = oaDemoIntBetween(clientId + ':vol:' + index, 90, 220);
    sent = Math.max(0, Math.round(base * oaDemoBetween(key + ':v', 0.75, 1.2)));
  }

  const openRate  = oaDemoBetween(key + ':o', 0.34, 0.58);
  const replyRate = oaDemoBetween(key + ':r', 0.020, 0.040);   // 2-4%, the real shape
  const bounceRate = oaDemoBetween(key + ':b', 0.002, 0.018);
  const unsubRate  = oaDemoBetween(key + ':u', 0.000, 0.006);

  const opened  = Math.round(sent * openRate);
  const replied = Math.round(sent * replyRate);
  const positive = Math.round(replied * oaDemoBetween(key + ':p', 0.25, 0.5));
  const booked   = Math.round(positive * oaDemoBetween(key + ':k', 0.3, 0.7));

  return {
    campaignExternalId: camp.externalId,
    onDay: day,
    sent, opened, replied, positive, booked,
    bounced: Math.round(sent * bounceRate),
    unsubscribed: Math.round(sent * unsubRate)
  };
}
function oaDemoDaily(clientId, camp, index, from, to){
  return oaDemoDays(from, to).map(day => oaDemoDayRow(clientId, camp, index, day));
}

/* ---- reply threads ------------------------------------------------ */

const OA_DEMO_SENTIMENTS = [
  'positive','positive','positive','neutral','neutral','negative',
  'negative','out_of_office','unsubscribe','neutral','positive','negative'
];
const OA_DEMO_BODIES = {
  positive: "Yes, this is relevant for us — we're hiring two more installers next quarter. Can you do Thursday afternoon?",
  neutral: "Thanks for reaching out. Send me a bit more detail and I'll take a look when things calm down here.",
  negative: "We already have an agency handling this. Not looking to change right now.",
  out_of_office: "I'm out of the office until the 3rd with limited access to email. For anything urgent please contact the main line.",
  unsubscribe: "Please take me off your list.",
  unknown: "Who is this?"
};

function oaDemoThreads(clientId){
  const camps = oaDemoCampaigns(clientId);
  const out = [];
  for (let i = 0; i < 12; i++) {
    const key = clientId + ':thread:' + i;
    const camp = camps[Math.floor(oaDemoRnd(key + ':c') * camps.length) % camps.length];
    const sentiment = OA_DEMO_SENTIMENTS[i];
    const company = OA_DEMO_COMPANIES[i % OA_DEMO_COMPANIES.length];
    const first = oaDemoPick(key + ':f', OA_DEMO_FIRST);
    const last  = oaDemoPick(key + ':l', OA_DEMO_LAST);
    const status = sentiment === 'positive'
      ? (oaDemoRnd(key + ':s') < 0.45 ? 'booked' : 'answered')
      : sentiment === 'unsubscribe' || sentiment === 'negative' ? 'closed'
      : oaDemoRnd(key + ':s') < 0.5 ? 'open' : 'answered';
    const agoHours = oaDemoIntBetween(key + ':when', 2, 28 * 24);

    out.push({
      externalId: 'demo-thread-' + i + '-' + oaDemoSeed(clientId).toString(36).slice(0, 6),
      campaignExternalId: camp.externalId,
      leadName:    first + ' ' + last,
      leadEmail:   (first + '.' + last).toLowerCase() + '@' + company.toLowerCase().replace(/[^a-z]+/g, '') + '.com',
      leadCompany: company,
      leadTitle:   oaDemoPick(key + ':t', OA_DEMO_TITLES),
      sentiment,
      status,
      lastMessageAt: new Date(Date.parse(oaDemoToday() + 'T09:00:00Z') - agoHours * 3600000).toISOString(),
      subject: 'Re: ' + camp.name.split(' — ')[0] + ' — quick question',
      body: OA_DEMO_BODIES[sentiment] || OA_DEMO_BODIES.unknown
    });
  }
  return out;
}

/* ---- inboxes ------------------------------------------------------ */

function oaDemoInboxes(clientId){
  const out = [];
  for (let i = 0; i < 6; i++) {
    const key = clientId + ':inbox:' + i;
    const domain = OA_DEMO_DOMAINS[i % OA_DEMO_DOMAINS.length];
    const warming = i >= 4;
    const health = warming ? oaDemoIntBetween(key + ':h', 48, 72)
      : i === 3 ? oaDemoIntBetween(key + ':h', 62, 78)
      : oaDemoIntBetween(key + ':h', 84, 99);
    const status = warming ? 'warming' : health < 70 ? 'warning' : 'ok';
    const dailyLimit = warming ? 20 : 50;
    out.push({
      externalId: 'demo-inbox-' + i + '-' + oaDemoSeed(clientId).toString(36).slice(0, 6),
      email: oaDemoPick(key + ':n', OA_DEMO_FIRST).toLowerCase() + '.' + (i + 1) + '@' + domain,
      domain,
      warmed: !warming,
      health,
      dailyLimit,
      sentToday: Math.min(dailyLimit, oaDemoIntBetween(key + ':s', warming ? 4 : 18, dailyLimit)),
      status
    });
  }
  return out;
}

/* ---- the five methods --------------------------------------------- */

const oaDemoImpl = {
  async getCampaigns(clientId){
    if (!clientId) return {ok:false, data:null, error:'Pick a client first.'};
    return OA_DEMO_OK(oaDemoCampaigns(clientId));
  },

  async getStats(clientId, range){
    if (!clientId) return {ok:false, data:null, error:'Pick a client first.'};
    const r = range || {};
    const to = r.to || oaDemoToday();
    const from = r.from || oaDemoShift(to, -59);

    const camps = oaDemoCampaigns(clientId);
    const daily = [];
    camps.forEach((camp, i) => { oaDemoDaily(clientId, camp, i, from, to).forEach(d => daily.push(d)); });

    const totals = {sent:0, opened:0, replied:0, positive:0, booked:0, bounced:0, unsubscribed:0};
    daily.forEach(d => Object.keys(totals).forEach(k => { totals[k] += d[k]; }));

    return OA_DEMO_OK({from, to, totals, daily});
  },

  async getReplies(clientId, opts){
    if (!clientId) return {ok:false, data:null, error:'Pick a client first.'};
    const want = (opts && opts.status) || '';
    const all = oaDemoThreads(clientId);
    return OA_DEMO_OK(want ? all.filter(t => t.status === want) : all);
  },

  /* The demo tool always accepts a reply. It sends nothing anywhere. */
  async sendReply(threadId, msg){
    if (!threadId) return {ok:false, data:null, error:'Pick the conversation to reply to first.'};
    const m = msg || {};
    if (!String(m.body || '').trim()) return {ok:false, data:null, error:'Write something before you send it.'};
    return OA_DEMO_OK({
      externalId: 'demo-msg-' + oaDemoSeed(String(threadId) + (m.subject || '')).toString(36),
      sentAt: new Date().toISOString()
    });
  },

  async getInboxHealth(clientId){
    if (!clientId) return {ok:false, data:null, error:'Pick a client first.'};
    return OA_DEMO_OK({inboxes: oaDemoInboxes(clientId)});
  }
};

if (typeof oaRegister === 'function') oaRegister('demo', oaDemoImpl);
