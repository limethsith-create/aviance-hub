/* ===================== AVIANCE OS — Outreach adapter =====================
   The single seam between the hub and whatever tool actually sends the email.

   WHAT AN ADAPTER IS (read this before you plug in a real key)
   -----------------------------------------------------------
   An adapter is one plain object with exactly five methods. The hub never
   knows which tool is behind it. If you are wiring up a real provider, copy
   outreach-smartlead.js, fill in the five methods, and register it:

       oaRegister('smartlead', myImplementation);

   The five methods, and what each must give back:

     getCampaigns(clientId)
       -> {ok, data:[campaign], error}
       campaign = {externalId, name, status, startedOn,
                   sent, opened, replied, positive, booked,
                   bounced, unsubscribed}
       status is one of: draft | running | paused | finished | error

     getStats(clientId, {from, to})
       -> {ok, data:{totals, daily}, error}
       from/to are 'YYYY-MM-DD' strings, both ends included.
       totals = {sent, opened, replied, positive, booked, bounced, unsubscribed}
       daily  = [{campaignExternalId, onDay, sent, opened, replied,
                  positive, booked, bounced, unsubscribed}]
       onDay is 'YYYY-MM-DD'. One row per campaign per day.

     getReplies(clientId, {status})
       -> {ok, data:[thread], error}
       thread = {externalId, campaignExternalId, leadName, leadEmail,
                 leadCompany, leadTitle, sentiment, status,
                 lastMessageAt, subject, body}
       sentiment: unknown | positive | neutral | negative | out_of_office | unsubscribe
       status:    open | answered | booked | closed
       A falsy `status` filter means "all of them".

     sendReply(threadId, {subject, body})
       -> {ok, data:{externalId, sentAt}, error}
       threadId is the hub's own outreach_threads id (or the provider's
       external id — your adapter decides, but be consistent with getReplies).

     getInboxHealth(clientId)
       -> {ok, data:{inboxes:[inbox]}, error}
       inbox = {externalId, email, domain, warmed, health, dailyLimit,
                sentToday, status}
       health is 0-100. status: ok | warming | warning | blocked | paused

   THE RULES, ALL OF THEM
   ----------------------
   - Every method returns {ok, data, error} and NEVER throws. oaRegister wraps
     your methods so a thrown error still comes back as {ok:false}, but write
     them as if it did not.
   - `error` is a plain sentence a non-technical person can read. No codes,
     no stack traces, no provider jargon.
   - NEVER put an API key in this repo. Keys live outside the browser. The
     `key_ref` column on outreach_accounts holds the NAME of a key, never a key.
   - A provider that is not connected yet returns {ok:false} with a clear
     sentence. It does not pretend, and it does not touch the network.

   Schema: SCHEMA.md "Outreach (the custom tool)".
   The upserts below use the natural keys of those tables:
     outreach_campaigns  (account_id, external_id)
     outreach_daily      (campaign_id, on_day)
     outreach_inboxes    (account_id, email)

   Every function returns {ok, data, error} and never throws (same plumbing as
   finance.js).
   ========================================================================= */

const OA_INTERFACE = ['getCampaigns', 'getStats', 'getReplies', 'sendReply', 'getInboxHealth'];
const OA_DEFAULT_PROVIDER = 'demo';
const OA_SYNC_DAYS = 60;          // how far back a sync pulls daily numbers
const OA_OUTBOX_BATCH = 50;       // queued messages flushed in one pass

/* ---- plumbing ---------------------------------------------------- */

function oaOk(data){ return {ok:true, data, error:''} }
function oaErr(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return {ok:false, data:null, error:m};
}
/* A supabase result -> {ok,data,error}. Never throws. */
function oaWrap(res, whenEmpty){
  if (!res) return oaErr('No answer from the database.');
  if (res.error) return oaErr(res.error);
  return oaOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
async function oaRun(fn, whenEmpty){
  try { return oaWrap(await fn(), whenEmpty); }
  catch (e) { return oaErr(e); }
}
/* Anything an adapter hands back, forced into the contract. */
function oaSafe(res){
  if (!res) return oaErr('That outreach tool gave no answer.');
  if (res.ok === true) return oaOk(res.data === undefined ? null : res.data);
  return oaErr(res.error || 'That outreach tool could not do it.');
}

const oaInt = n => { const v = Math.round(Number(n)); return Number.isFinite(v) ? v : 0 };
const oaDay = d => String(d || '').slice(0, 10);

/* ---- the registry ------------------------------------------------- */

const oaProviders = Object.create(null);

/* Register an implementation under a name. Each method is wrapped so a
   throw, a missing method or a wrong-shaped answer still comes back as
   {ok,data,error}. Returns {ok,data:{name},error}. */
function oaRegister(name, impl){
  const key = String(name || '').trim();
  if (!key) return oaErr('An outreach tool needs a name.');
  if (!impl || typeof impl !== 'object') return oaErr('That outreach tool is not set up properly.');

  const missing = OA_INTERFACE.filter(m => typeof impl[m] !== 'function');
  if (missing.length) return oaErr('That outreach tool is missing: ' + missing.join(', ') + '.');

  const safe = {name: key};
  OA_INTERFACE.forEach(m => {
    safe[m] = async function(){
      try { return oaSafe(await impl[m].apply(impl, arguments)); }
      catch (e) { return oaErr(e); }
    };
  });
  oaProviders[key] = safe;
  return oaOk({name: key});
}

/* The implementation registered under that name, or null. */
function oaGet(name){
  const key = String(name || '').trim();
  return oaProviders[key] || null;
}

/* The names of every registered tool, in alphabetical order. */
function oaList(){
  return Object.keys(oaProviders).sort();
}

/* ---- which tool is this client on? -------------------------------- */

/* The client's outreach account row, and the tool that goes with it.
   A client with no account row yet falls back to the demo tool, so every
   screen still has something true to show.
   -> {ok, data:{provider, account, impl}, error} */
async function oaFor(clientId){
  if (!clientId) return oaErr('Pick a client first.');

  const got = await oaRun(() => sb.from('outreach_accounts').select('*')
    .eq('client_id', clientId).order('created_at', {ascending:false}).limit(1), []);
  if (!got.ok) return got;

  const rows = Array.isArray(got.data) ? got.data : (got.data ? [got.data] : []);
  const account = rows[0] || null;
  const provider = (account && account.provider) || OA_DEFAULT_PROVIDER;

  const impl = oaGet(provider);
  if (!impl) return oaErr('This client is set up on a tool Aviance OS does not know about yet.');
  return oaOk({provider, account, impl});
}

/* A client must have an account row before we can store anything against it.
   Nothing here needs a key: the demo row is what a new client starts on. */
async function oaEnsureAccount(clientId){
  const f = await oaFor(clientId);
  if (!f.ok) return f;
  if (f.data.account) return f;

  const made = await oaRun(() => sb.from('outreach_accounts').insert({
    client_id: clientId,
    provider:  OA_DEFAULT_PROVIDER,
    label:     'Demo data',
    status:    'ok'
  }).select().single(), null);
  if (!made.ok) return made;
  return oaOk({provider: OA_DEFAULT_PROVIDER, account: made.data, impl: f.data.impl});
}

/* ---- sync: the tool's numbers into our tables --------------------- */

function oaRange(days){
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return {from: to_iso(from), to: to_iso(to)};
  function to_iso(d){ return d.toISOString().slice(0, 10) }
}

/* Ask the tool for campaigns, daily numbers and inbox health, then write
   them in. Stamps last_synced_at when it works; records last_error when it
   does not. Never throws.
   -> {ok, data:{provider, campaigns, days, inboxes}, error} */
async function oaSync(clientId){
  try {
    const f = await oaEnsureAccount(clientId);
    if (!f.ok) return f;
    const {provider, account, impl} = f.data;
    const accountId = account.id;

    const camps = await impl.getCampaigns(clientId);
    if (!camps.ok) return oaSyncFailed(accountId, camps.error);

    const list = Array.isArray(camps.data) ? camps.data : [];
    const now = new Date().toISOString();

    /* campaigns first — their ids are what the daily rows hang off */
    let byExternal = new Map();
    if (list.length) {
      const rows = list.map(c => ({
        account_id:   accountId,
        client_id:    clientId,
        external_id:  String(c.externalId || c.external_id || ''),
        name:         c.name || 'Untitled campaign',
        status:       c.status || 'draft',
        started_on:   c.startedOn || c.started_on || null,
        sent:         oaInt(c.sent),
        opened:       oaInt(c.opened),
        replied:      oaInt(c.replied),
        positive:     oaInt(c.positive),
        booked:       oaInt(c.booked),
        bounced:      oaInt(c.bounced),
        unsubscribed: oaInt(c.unsubscribed),
        last_synced_at: now
      }));
      const up = await oaRun(() => sb.from('outreach_campaigns')
        .upsert(rows, {onConflict: 'account_id,external_id'}).select(), []);
      if (!up.ok) return oaSyncFailed(accountId, up.error);
      (up.data || []).forEach(r => byExternal.set(String(r.external_id), r.id));
    }

    /* daily numbers */
    const span = oaRange(OA_SYNC_DAYS);
    const stats = await impl.getStats(clientId, span);
    if (!stats.ok) return oaSyncFailed(accountId, stats.error);

    const daily = (stats.data && Array.isArray(stats.data.daily)) ? stats.data.daily : [];
    const dayRows = daily.map(d => ({
      campaign_id:  byExternal.get(String(d.campaignExternalId || d.campaign_external_id || '')) || null,
      client_id:    clientId,
      on_day:       oaDay(d.onDay || d.on_day),
      sent:         oaInt(d.sent),
      opened:       oaInt(d.opened),
      replied:      oaInt(d.replied),
      positive:     oaInt(d.positive),
      booked:       oaInt(d.booked),
      bounced:      oaInt(d.bounced),
      unsubscribed: oaInt(d.unsubscribed)
    })).filter(r => r.campaign_id && r.on_day);

    if (dayRows.length) {
      const up = await oaRun(() => sb.from('outreach_daily')
        .upsert(dayRows, {onConflict: 'campaign_id,on_day'}).select(), []);
      if (!up.ok) return oaSyncFailed(accountId, up.error);
    }

    /* inboxes */
    const health = await impl.getInboxHealth(clientId);
    if (!health.ok) return oaSyncFailed(accountId, health.error);

    const inboxes = (health.data && Array.isArray(health.data.inboxes)) ? health.data.inboxes
      : (Array.isArray(health.data) ? health.data : []);
    const boxRows = inboxes.map(b => ({
      account_id:  accountId,
      client_id:   clientId,
      external_id: String(b.externalId || b.external_id || ''),
      email:       b.email || '',
      domain:      b.domain || null,
      warmed:      !!b.warmed,
      health:      oaInt(b.health),
      daily_limit: b.dailyLimit == null && b.daily_limit == null ? null : oaInt(b.dailyLimit != null ? b.dailyLimit : b.daily_limit),
      sent_today:  oaInt(b.sentToday != null ? b.sentToday : b.sent_today),
      status:      b.status || 'ok',
      last_synced_at: now
    })).filter(r => r.email);

    if (boxRows.length) {
      const up = await oaRun(() => sb.from('outreach_inboxes')
        .upsert(boxRows, {onConflict: 'account_id,email'}).select(), []);
      if (!up.ok) return oaSyncFailed(accountId, up.error);
    }

    await oaRun(() => sb.from('outreach_accounts')
      .update({status:'ok', last_synced_at: now, last_error: null})
      .eq('id', accountId), null);

    return oaOk({provider, campaigns: list.length, days: dayRows.length, inboxes: boxRows.length});
  } catch (e) {
    return oaErr(e);
  }
}

/* Remember why a sync did not work, then hand the plain sentence back. */
async function oaSyncFailed(accountId, message){
  const m = message || 'That outreach tool could not be reached.';
  await oaRun(() => sb.from('outreach_accounts')
    .update({status:'error', last_error: String(m).slice(0, 600)})
    .eq('id', accountId), null);
  return oaErr(m);
}

/* ---- the outbox --------------------------------------------------- */

/* Replies we wrote in the hub sit in outreach_messages with delivery
   'queued'. This hands each one to its client's tool and moves it to 'sent'
   or 'failed'. A message that fails keeps the reason in delivery_error and
   is never silently dropped. Never throws.
   -> {ok, data:{tried, sent, failed}, error} */
async function oaFlushOutbox(){
  try {
    const got = await oaRun(() => sb.from('outreach_messages').select('*')
      .eq('delivery', 'queued').order('sent_at').limit(OA_OUTBOX_BATCH), []);
    if (!got.ok) return got;

    const queued = Array.isArray(got.data) ? got.data : [];
    const impls = new Map();
    let sent = 0, failed = 0;

    for (const msg of queued) {
      let impl = impls.get(msg.client_id);
      if (impl === undefined) {
        const f = await oaFor(msg.client_id);
        impl = f.ok ? f.data.impl : null;
        impls.set(msg.client_id, impl);
      }

      let res;
      if (!impl) res = oaErr('This client is not connected to an outreach tool yet.');
      else res = await impl.sendReply(msg.thread_id, {subject: msg.subject, body: msg.body});

      if (res.ok) {
        sent++;
        await oaRun(() => sb.from('outreach_messages').update({
          delivery: 'sent',
          delivery_error: null,
          external_id: (res.data && (res.data.externalId || res.data.external_id)) || msg.external_id || null,
          sent_at: (res.data && (res.data.sentAt || res.data.sent_at)) || msg.sent_at
        }).eq('id', msg.id), null);
      } else {
        failed++;
        await oaRun(() => sb.from('outreach_messages').update({
          delivery: 'failed',
          delivery_error: String(res.error || 'It did not send.').slice(0, 600)
        }).eq('id', msg.id), null);
      }
    }

    return oaOk({tried: queued.length, sent, failed});
  } catch (e) {
    return oaErr(e);
  }
}

/* ---- writing a reply ---------------------------------------------- */

/* Put a reply in the outbox. It is queued, not sent: oaFlushOutbox() is what
   hands it to the tool, so a tool that is down never loses what you wrote. */
async function oaQueueReply(clientId, threadId, msg){
  const m = msg || {};
  if (!clientId || !threadId) return oaErr('Pick the conversation to reply to first.');
  if (!String(m.body || '').trim()) return oaErr('Write something before you send it.');

  return oaRun(() => sb.from('outreach_messages').insert({
    thread_id:  threadId,
    client_id:  clientId,
    direction:  'out',
    subject:    (m.subject || '').slice(0, 300) || null,
    body:       m.body,
    sent_at:    new Date().toISOString(),
    delivery:   'queued',
    author_user: m.authorUser || null
  }).select().single(), null);
}
