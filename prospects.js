/* ===================== AVIANCE OS — the prospect window =====================
   Every business Aviance is emailing for a client, and everything about it: the
   company, the person, every mail we sent, every reply with its sentiment, how
   far through the sequence they are, and the call booked off the back of it.

   Two screens, one file:
     viewProspects()  the list — searchable, filterable, paged, never loading
                      everything. This is the screen the owner lives in.
     viewProspect()   one prospect, whole.

   The tables are the ones the schema already has (SCHEMA.md): outreach_threads
   is one prospect company's thread, outreach_messages hangs off it,
   outreach_campaigns is the campaign it belongs to. Nothing here invents a
   column and nothing here writes: this screen reads.

   WHO MAY SEE WHAT IS NOT DECIDED HERE. It is decided by row level security in
   the database (supabase/migrations/20261207_prospect_access.sql): reading any
   outreach row asks can_see_prospects(client_id) — the owner, or a live row in
   `prospect_grants` for that person and that client. So a staff member who has
   been given one client gets one client's rows out of the same query the owner
   runs, and a staff member who has been given nothing gets an empty list. The
   two things this screen needs but a grant-holder may not read straight off a
   table (a client's name, which sits beside its monthly fee; and the booked
   meeting) come through two definer functions, prospect_clients() and
   prospect_window(), which ask the same question again.

   Conventions (SCHEMA.md): every function returns {ok, data, error} and never
   throws; `error` is a plain sentence; every render is a pure function of state
   and escapes everything; the screen draws correctly with zero rows.
   ========================================================================= */

const PR_PAGE = 25;                      /* rows per page — never the whole table */

/* The words the schema allows, with the labels a person reads. */
const PR_SENTIMENTS = ['positive','neutral','negative','out_of_office','unsubscribe','unknown'];
const PR_SENTIMENT_LABEL = {
  positive:'Positive', neutral:'Neutral', negative:'Negative',
  out_of_office:'Out of office', unsubscribe:'Unsubscribed', unknown:'No reply yet'
};
const PR_STATUSES = ['open','answered','booked','closed'];
const PR_STATUS_LABEL = {open:'Sequence running', answered:'They replied', booked:'Call booked', closed:'Closed'};
const PR_DELIVERY_LABEL = {synced:'Sent', queued:'Queued', sending:'Sending', sent:'Sent', failed:'Failed'};
const PR_BOOKED = {any:'Either way', yes:'Call booked', no:'No call yet'};
/* A meeting's own words (meetings.js owns the table; these are only labels). */
const PR_CALL_STATUS = {booked:'Booked', held:'Held', no_show:'They did not show', cancelled:'Cancelled', rescheduled:'Moved'};

/* What the two screens are holding. null means "not read yet". */
const prS = {
  clients:null,            /* [{id, company}] — only the ones this person may see */
  campaigns:null,          /* [{id, name, status, client_id}] */
  rows:null, total:0, page:0,
  f:{client:'', campaign:'', sentiment:'', booked:'any', q:''},
  err:'', clientsErr:'', campaignsErr:'', seq:0, busy:false,
  thread:null, threadId:'', threadErr:''
};

/* ---- plumbing (the same shape as finance.js) ----------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const prOk = coreOk;
const prErr = coreErr;
const prWrap = coreWrap;
async function prRun(fn, whenEmpty){
  try { return prWrap(await fn(), whenEmpty); }
  catch (e) { return prErr(e); }
}

/* ---- small helpers ------------------------------------------------- */

/* The one escape, from core.js: strict, five characters, the single quote among them. */
const prX = coreEsc;
/* A value safe to drop inside onclick="…" as a JavaScript string, from core.js:
   JSON first, so a quote inside it cannot end the string, then escaped so it
   cannot end the attribute. prX alone is NOT enough here — it turns ' into
   &#39;, the browser hands the attribute back to JavaScript decoded, and the
   quote lands back inside the string. A prospect id carrying one then either
   kills the button silently or runs whatever follows it. */
const prA = coreAttr;
function prIc(name){ return (typeof I !== 'undefined' && I && I[name]) || '' }
function prEmpty(icon, title, sub, btn, action){
  if (typeof emptyState === 'function') return emptyState(icon, title, sub, btn, action);
  return `<div class="card"><div class="empty"><h3>${prX(title)}</h3><p>${prX(sub)}</p></div></div>`;
}
function prSentimentLabel(s){ return PR_SENTIMENT_LABEL[s] || (s ? String(s) : 'No reply yet') }
function prStatusLabel(s){ return PR_STATUS_LABEL[s] || (s ? String(s) : '—') }
function prDeliveryLabel(d){ return PR_DELIVERY_LABEL[d] || (d ? String(d) : '') }
function prCallStatus(s){ return PR_CALL_STATUS[s] || (s ? String(s).replace(/_/g,' ') : '') }
/* Thousands, so a campaign's totals read at a glance. */
function prFig(n){ return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') }

/* A date-stamp, in mono wherever it is shown. Day only, or day and time. */
function prDay(v){
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v).slice(0,10);
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return String(d.getDate()).padStart(2,'0') + ' ' + m + ' ' + d.getFullYear();
}
function prWhen(v){
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
  return prDay(v) + ' · ' + hh + ':' + mm;
}
/* "3 days ago", for the last-reply column. */
function prAgo(v, now){
  if (!v) return '';
  const then = new Date(v).getTime();
  if (isNaN(then)) return '';
  const days = Math.floor(((now || Date.now()) - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  const months = Math.round(days / 30);
  return months <= 1 ? 'a month ago' : months + ' months ago';
}
function prClientName(id){
  const list = prS.clients || [];
  for (let i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i].company || '';
  return '';
}
function prCampaignName(id){
  const list = prS.campaigns || [];
  for (let i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i].name || '';
  return '';
}
/* A search box is typed into by a person, and the database's `or` filter is a
   comma-separated list: anything that could break the filter comes out first. */
function prSafeSearch(q){
  return String(q == null ? '' : q).replace(/[,()*%"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function prPaint(hostId, html){
  if (typeof document === 'undefined' || !document.getElementById) return;
  const el = document.getElementById(hostId);
  if (el) el.innerHTML = html;
}
function prLoading(what){ return `<div class="card pr-pad" role="status">Loading ${prX(what)}…</div>` }
function prErrorCard(msg, retry){
  return `<div class="card pr-pad pr-err" role="alert">${prX(msg)} <button class="btn ghost" type="button" onclick="${retry}">Try again</button></div>`;
}

/* ================= reading =========================================
   Every read below is the same query for the owner and for a staff member who
   has been given one client. The database decides how many rows come back. */

/* The clients whose prospects this person may see, by name. Two columns, out of
   a definer function, because `clients` also carries the monthly fee. */
async function prClients(){
  const r = await prRun(() => sb.rpc('prospect_clients'), []);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data) ? r.data : [];
  return prOk(rows.map(c => ({id:c.id, company:c.company || 'A client'})));
}

/* The campaigns, for the campaign filter. RLS keeps this to the same clients. */
async function prCampaigns(clientId){
  return prRun(() => {
    let q = sb.from('outreach_campaigns').select('id,name,status,client_id,started_on');
    if (clientId) q = q.eq('client_id', clientId);
    return q.order('name');
  }, []);
}

/* One page of prospects. Filters: client, campaign, sentiment, whether a call
   was booked, and a search across the company, the person and their email.
   Returns {rows, total, page, pages} — the count comes back with the page, so
   the owner can see "26–50 of 2,184" without a second read. */
async function prThreads(opts){
  const o = opts || {};
  const page = Math.max(0, parseInt(o.page, 10) || 0);
  const from = page * PR_PAGE;
  const q = prSafeSearch(o.q);
  /* Not through prRun(): the count comes back beside the rows and prRun keeps
     only the rows. Same promise, same {ok,data,error} out. */
  const ask = () => {
    let b = sb.from('outreach_threads')
      .select('id,client_id,campaign_id,lead_name,lead_email,lead_company,lead_title,sentiment,status,owner,meeting_id,last_message_at,created_at',
              {count:'exact'});
    if (o.client)   b = b.eq('client_id', o.client);
    if (o.campaign) b = b.eq('campaign_id', o.campaign);
    if (o.sentiment) b = b.eq('sentiment', o.sentiment);
    if (o.booked === 'yes') b = b.not('meeting_id', 'is', null);
    if (o.booked === 'no')  b = b.is('meeting_id', null);
    if (q) b = b.or('lead_company.ilike.%' + q + '%,lead_name.ilike.%' + q + '%,lead_email.ilike.%' + q + '%');
    return b.order('last_message_at', {ascending:false, nullsFirst:false})
            .order('created_at', {ascending:false})
            .range(from, from + PR_PAGE - 1);
  };
  let res;
  try { res = await ask(); } catch (e) { return prErr(e) }
  if (!res) return prErr('No answer from the database.');
  if (res.error) return prErr(res.error);
  const rows = Array.isArray(res.data) ? res.data : [];
  const total = typeof res.count === 'number' ? res.count : rows.length + from;
  return prOk({rows, total, page, pages: Math.max(1, Math.ceil(total / PR_PAGE))});
}

/* One prospect, whole: the thread, its campaign, every message both ways, and
   the call booked off it. The function refuses a client this person has not
   been given, so a guessed id is an error and not a row. */
async function prWindow(threadId){
  if (!threadId) return prErr('Pick a prospect first.');
  const r = await prRun(() => sb.rpc('prospect_window', {p_thread:threadId}), null);
  if (!r.ok) return r;
  if (!r.data) return prErr('That prospect is not there any more.');
  const d = r.data;
  return prOk({
    thread: d.thread || {}, client: d.client || null, campaign: d.campaign || null,
    messages: Array.isArray(d.messages) ? d.messages : [], call: d.call || null
  });
}

/* ---- what the list derives ---------------------------------------- */

/* Where this prospect is in the sequence: how many we have sent, and whether
   the last word was theirs. Counted from the messages, so it is always the
   truth rather than a number somebody has to keep up to date. */
function prSequence(messages){
  const rows = Array.isArray(messages) ? messages : [];
  const out = rows.filter(m => m && m.direction === 'out');
  const inn = rows.filter(m => m && m.direction === 'in');
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    sent: out.length, replies: inn.length,
    step: out.length, theirTurn: !!(last && last.direction === 'out'),
    waiting: !!(last && last.direction === 'in'),
    failed: out.filter(m => m && m.delivery === 'failed').length
  };
}

/* ================= the list ======================================== */

async function prLoadList(){
  const mine = ++prS.seq;
  /* Three reads, and only one of them used to be able to say it failed. A read
     that did not answer and a read that answered with nothing both arrived here
     as [], and the line below then wiped prS.err with the rows' own result — so
     the names and the filter could quietly disappear while the table loaded
     fine. The two side reads keep their own failure and the screen says so. */
  if (prS.clients === null) {
    const c = await prClients();
    if (prS.seq !== mine) return;
    prS.clients = c.ok ? c.data : [];
    prS.clientsErr = c.ok ? '' : c.error;
  }
  if (prS.campaigns === null) {
    const g = await prCampaigns('');
    if (prS.seq !== mine) return;
    prS.campaigns = g.ok ? g.data : [];
    prS.campaignsErr = g.ok ? '' : g.error;
  }
  const r = await prThreads({page:prS.page, client:prS.f.client, campaign:prS.f.campaign,
                             sentiment:prS.f.sentiment, booked:prS.f.booked, q:prS.f.q});
  if (prS.seq !== mine) return;          /* a newer filter has already been asked for */
  prS.err = r.ok ? '' : r.error;
  prS.rows = r.ok ? r.data.rows : [];
  prS.total = r.ok ? r.data.total : 0;
  prPaint('prListHost', prRenderList());
}

/* The filter bar: client, campaign, sentiment, call booked, and a search box.
   Every one of them is a plain form control, because this screen is worked and
   not admired. */
function prRenderFilters(){
  const clients = prS.clients || [];
  const camps = (prS.campaigns || []).filter(c => !prS.f.client || String(c.client_id) === String(prS.f.client));
  const opt = (v, label, on) => `<option value="${prX(v)}"${on ? ' selected' : ''}>${prX(label)}</option>`;
  /* The client names come out of their own read. When that read failed there is
     no filter to show and no name to put beside a row, so say it rather than
     let the column quietly read "—" for everybody. */
  const client = clients.length > 1 ? `<label class="pr-field"><span>Client</span>
    <select onchange="prSetClient(this.value)">${opt('', 'Every client', !prS.f.client)}
      ${clients.map(c => opt(c.id, c.company, String(prS.f.client) === String(c.id))).join('')}</select></label>`
    : (prS.clientsErr ? `<p class="pr-field pr-err" role="status">${prX(prS.clientsErr)} Client names and the client filter are missing.</p>` : '');
  return `<div class="card pr-filters">
    <div class="pr-filter-row">
      <label class="pr-field pr-search"><span>Search</span>
        <input type="search" value="${prX(prS.f.q)}" placeholder="Company, person or email"
               oninput="prSetSearch(this.value)" aria-label="Search prospects"></label>
      ${client}
      ${!camps.length && prS.campaignsErr ? `<p class="pr-field pr-err" role="status">${prX(prS.campaignsErr)} The campaign filter is missing.</p>` : ''}
      <label class="pr-field"><span>Campaign</span>
        <select onchange="prSetCampaign(this.value)">${opt('', 'Every campaign', !prS.f.campaign)}
          ${camps.map(c => opt(c.id, c.name, String(prS.f.campaign) === String(c.id))).join('')}</select></label>
      <label class="pr-field"><span>Sentiment</span>
        <select onchange="prSetSentiment(this.value)">${opt('', 'Any sentiment', !prS.f.sentiment)}
          ${PR_SENTIMENTS.map(s => opt(s, prSentimentLabel(s), prS.f.sentiment === s)).join('')}</select></label>
      <label class="pr-field"><span>Call</span>
        <select onchange="prSetBooked(this.value)">
          ${Object.keys(PR_BOOKED).map(k => opt(k, PR_BOOKED[k], prS.f.booked === k)).join('')}</select></label>
      ${prFiltered() ? `<button class="btn ghost pr-clear" type="button" onclick="prClearFilters()">Clear</button>` : ''}
    </div>
  </div>`;
}
/* The owner with no clients yet is not the same as somebody who has been given
   nothing: the two empty screens say different things. */
function prIsOwner(){
  return !!(typeof authUser !== 'undefined' && authUser && authUser.role === 'admin');
}
function prFiltered(){
  return !!(prS.f.client || prS.f.campaign || prS.f.sentiment || prS.f.q || (prS.f.booked && prS.f.booked !== 'any'));
}

/* "1–25 of 2,184", and the two buttons. Mono figures, as every figure is. */
function prRenderPager(){
  const total = prS.total || 0, page = prS.page;
  const shown = (prS.rows || []).length;
  const first = total ? page * PR_PAGE + 1 : 0;
  const last = page * PR_PAGE + shown;
  const pages = Math.max(1, Math.ceil(total / PR_PAGE));
  const fig = prFig;
  return `<div class="pr-pager">
    <p class="pr-count"><span class="pr-fig">${fig(first)}–${fig(last)}</span> of <span class="pr-fig">${fig(total)}</span></p>
    <div class="pr-pagebtns">
      <button class="btn ghost" type="button" onclick="prGoPage(${page - 1})"${page <= 0 ? ' disabled' : ''}>Back</button>
      <span class="pr-pageno">Page <span class="pr-fig">${fig(page + 1)}</span> of <span class="pr-fig">${fig(pages)}</span></span>
      <button class="btn ghost" type="button" onclick="prGoPage(${page + 1})"${page + 1 >= pages ? ' disabled' : ''}>Next</button>
    </div>
  </div>`;
}

function prSentimentTag(s){
  const key = PR_SENTIMENTS.indexOf(String(s)) >= 0 ? String(s) : 'unknown';
  return `<span class="pr-tag pr-s-${prX(key)}">${prX(prSentimentLabel(key))}</span>`;
}
function prRow(t, now){
  const company = t.lead_company || t.lead_name || 'A business';
  const who = [t.lead_name, t.lead_title].filter(Boolean).join(' · ');
  const client = prClientName(t.client_id);
  const camp = prCampaignName(t.campaign_id);
  return `<tr tabindex="0" class="pr-row" onclick="openProspect(${prA(t.id)})"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openProspect(${prA(t.id)})}">
    <td><span class="pr-co"><b>${prX(company)}</b>${who ? `<small>${prX(who)}</small>` : ''}</span></td>
    ${prS.f.client ? '' : `<td class="pr-dim">${client ? prX(client) : '—'}</td>`}
    <td class="pr-dim">${camp ? prX(camp) : '—'}</td>
    <td>${prSentimentTag(t.sentiment)}</td>
    <td class="pr-dim">${prX(prStatusLabel(t.status))}</td>
    <td class="pr-when">${t.last_message_at ? `<span class="pr-fig">${prX(prDay(t.last_message_at))}</span><small>${prX(prAgo(t.last_message_at, now))}</small>` : '<span class="pr-dim">—</span>'}</td>
    <td class="pr-booked">${t.meeting_id ? '<span class="pr-stamp">Booked</span>' : '<span class="pr-dim">—</span>'}</td>
  </tr>`;
}

function prRenderList(now){
  if (prS.rows === null) return prRenderFilters() + prLoading('the prospects');
  const rows = prS.rows || [];
  const err = prS.err ? prErrorCard(prS.err, 'prLoadList()') : '';
  /* No heading of its own: the shell's page title already says what this is, and
     this screen is worked rather than admired. The filter bar leads. */
  const head = '';
  if (!rows.length) {
    /* A read that did not answer is NOT an empty table. The screen used to put
       "No prospects yet" (or, worse, "Nothing has been shared with you" —
       a diagnosis nobody made) directly under the red card, so a page that had
       failed to load read as a page with nothing on it. When the last read
       failed, the error is the whole screen and there is no empty state. */
    if (prS.err) return head + prRenderFilters() + err;
    const none = prFiltered()
      ? `<div class="card pr-pad pr-none"><p>Nothing matches that. <button class="btn ghost" type="button" onclick="prClearFilters()">Clear the filters</button></p></div>`
      : ((prS.clients || []).length || prIsOwner()
          ? prEmpty(prIc('inquiry'), 'No prospects yet',
              'When the outreach tool next syncs, every business we are emailing for your clients shows up here — with every reply.')
          : prEmpty(prIc('inquiry'), 'Nothing has been shared with you',
              'You have not been given a client’s prospects yet. The owner can give you one from the Team screen.'));
    return head + prRenderFilters() + err + none;
  }
  const table = `<div class="card pr-tablecard"><div class="pr-scroll"><table class="pr-table">
    <thead><tr><th>Business</th>${prS.f.client ? '' : '<th>Client</th>'}<th>Campaign</th><th>Sentiment</th>
      <th>Where they are</th><th>Last message</th><th>Call</th></tr></thead>
    <tbody>${rows.map(t => prRow(t, now || Date.now())).join('')}</tbody>
  </table></div>${prRenderPager()}</div>`;
  return head + prRenderFilters() + err + table;
}

function viewProspects(){
  prLoadList();
  return `<div id="prListHost" class="pr">${prRenderList()}</div>`;
}

/* Each filter change starts a fresh read, and only the newest read paints (prS.seq),
   so a slow answer for the filter he has just left cannot land under the new one. */
function prAfterFilter(){
  prS.rows = null; prS.page = 0;
  prPaint('prListHost', prRenderList());
  return prLoadList();
}
function prSetClient(id){
  prS.f.client = id ? String(id) : '';
  prS.f.campaign = '';                   /* a campaign belongs to one client */
  return prAfterFilter();
}
function prSetCampaign(id){ prS.f.campaign = id ? String(id) : ''; return prAfterFilter() }
function prSetSentiment(s){ prS.f.sentiment = PR_SENTIMENTS.indexOf(String(s)) >= 0 ? String(s) : ''; return prAfterFilter() }
function prSetBooked(v){ prS.f.booked = PR_BOOKED[String(v)] ? String(v) : 'any'; return prAfterFilter() }
function prSetSearch(q){
  prS.f.q = String(q == null ? '' : q).slice(0, 80);
  prS.page = 0;
  if (typeof clearTimeout === 'function') clearTimeout(prS._typing);
  if (typeof setTimeout !== 'function') return prLoadList();
  prS._typing = setTimeout(() => prLoadList(), 250);   /* he is still typing */
  return prS._typing;
}
function prClearFilters(){
  prS.f = {client:'', campaign:'', sentiment:'', booked:'any', q:''};
  return prAfterFilter();
}
function prGoPage(n){
  const pages = Math.max(1, Math.ceil((prS.total || 0) / PR_PAGE));
  const page = Math.min(Math.max(0, parseInt(n, 10) || 0), pages - 1);
  if (page === prS.page) return;
  prS.page = page; prS.rows = null;
  prPaint('prListHost', prRenderList());
  return prLoadList();
}

/* ================= one prospect ==================================== */

async function prLoadOne(id){
  const mine = ++prS.seq;
  if (prS.clients === null) { const c = await prClients(); if (prS.seq === mine) prS.clients = c.ok ? c.data : [] }
  const r = await prWindow(id);
  if (prS.seq !== mine) return;
  prS.threadErr = r.ok ? '' : r.error;
  prS.thread = r.ok ? r.data : null;
  prPaint('prOneHost', prRenderOne());
}

/* A labelled figure, mono, the way every figure in the house is set. */
function prFigure(caption, value, red){
  return `<div class="pr-figure${red ? ' pr-figure-red' : ''}"><p class="pr-cap">${prX(caption)}</p>
    <b class="pr-fig">${prX(value)}</b></div>`;
}
function prKv(label, value, mono){
  if (!value) return '';
  return `<div class="pr-kv-row"><span class="pr-cap">${prX(label)}</span>
    <span class="${mono ? 'pr-fig' : ''}">${prX(value)}</span></div>`;
}

/* One message, both directions. The body is theirs, so it is escaped and shown
   as it came — never parsed, never rendered as HTML. */
function prMessage(m){
  const out = m && m.direction === 'out';
  const failed = m && m.delivery === 'failed';
  return `<article class="pr-msg pr-msg-${out ? 'out' : 'in'}">
    <header>
      <span class="pr-msg-dir">${out ? 'We sent' : 'They replied'}</span>
      <span class="pr-fig pr-msg-when">${prX(prWhen(m && m.sent_at))}</span>
      ${out && m.delivery ? `<span class="pr-msg-del${failed ? ' pr-msg-failed' : ''}">${prX(prDeliveryLabel(m.delivery))}</span>` : ''}
    </header>
    ${m && m.subject ? `<h5>${prX(m.subject)}</h5>` : ''}
    ${failed && m.delivery_error ? `<p class="pr-msg-err">${prX(m.delivery_error)}</p>` : ''}
    <pre class="pr-body">${prX((m && m.body) || '')}</pre>
  </article>`;
}

function prRenderOne(){
  if (prS.threadErr) return prErrorCard(prS.threadErr, `prLoadOne(${prA(prS.threadId)})`);
  if (!prS.thread) return prLoading('this prospect');
  const d = prS.thread, t = d.thread || {}, seq = prSequence(d.messages);
  const company = t.lead_company || t.lead_name || 'A business';
  const client = (d.client && d.client.company) || prClientName(t.client_id);
  const camp = d.campaign || null;
  const call = d.call || null;

  const head = `<div class="card pr-pad pr-one-head">
    <p class="pr-eyebrow">${prX(client || 'Prospect')}</p>
    <h3 class="pr-one-co">${prX(company)}</h3>
    <div class="pr-one-tags">${prSentimentTag(t.sentiment)}
      <span class="pr-tag pr-plain">${prX(prStatusLabel(t.status))}</span></div>
    <div class="pr-kv">
      ${prKv('Person', [t.lead_name, t.lead_title].filter(Boolean).join(' · '))}
      ${prKv('Email', t.lead_email, true)}
      ${prKv('Campaign', camp ? camp.name : '')}
      ${prKv('First contacted', prDay(t.created_at), true)}
      ${prKv('Last message', prWhen(t.last_message_at), true)}
      ${prKv('Reference', t.external_id, true)}
    </div>
  </div>`;

  const figures = `<div class="card pr-pad pr-figures">
    ${prFigure('Mails sent', seq.sent)}
    ${prFigure('Replies', seq.replies)}
    ${prFigure('Sequence step', seq.step)}
    ${prFigure(call ? 'Call booked' : 'Call', call ? prDay(call.starts_at) : 'None', !!call)}
  </div>`;

  const callBlock = call ? `<section class="card pr-pad pr-call">
    <p class="pr-eyebrow">The call this won</p>
    <div class="pr-kv">
      ${prKv('When', prWhen(call.starts_at), true)}
      ${prKv('Length', call.minutes ? call.minutes + ' minutes' : '', true)}
      ${prKv('Time zone', call.time_zone, true)}
      ${prKv('Guest', [call.guest_name, call.guest_email].filter(Boolean).join(' · '))}
      ${prKv('Status', prCallStatus(call.status))}
      ${prKv('Held', call.held_at ? prWhen(call.held_at) : '', true)}
    </div>
  </section>` : '';

  const campBlock = camp ? `<section class="card pr-pad pr-camp">
    <p class="pr-eyebrow">The campaign</p>
    <div class="pr-kv">
      ${prKv('Name', camp.name)}
      ${prKv('Status', camp.status)}
      ${prKv('Started', camp.started_on ? prDay(camp.started_on) : '', true)}
      ${prKv('Sent, all leads', camp.sent == null ? '' : prFig(camp.sent), true)}
      ${prKv('Replied, all leads', camp.replied == null ? '' : prFig(camp.replied), true)}
      ${prKv('Booked, all leads', camp.booked == null ? '' : prFig(camp.booked), true)}
    </div>
  </section>` : '';

  const thread = `<section class="card pr-pad pr-thread">
    <p class="pr-eyebrow">Every mail, both ways</p>
    ${seq.failed ? `<p class="pr-note">${prX(String(seq.failed))} of these did not get through.</p>` : ''}
    ${d.messages.length
      ? `<div class="pr-msgs">${d.messages.map(prMessage).join('')}</div>`
      : '<p class="pr-note">Nothing has been sent on this thread yet.</p>'}
  </section>`;

  return head + figures + callBlock + campBlock + thread;
}

function viewProspect(id){
  prS.threadId = id ? String(id) : '';
  if (prS.threadId) prLoadOne(prS.threadId);
  return `<div id="prOneHost" class="pr pr-one">${prS.threadId ? prRenderOne() : prEmpty(prIc('inquiry'), 'No prospect chosen', 'Go back to the list and pick one.')}</div>`;
}

/* Forget everything on sign-out: the next person on this device starts clean. */
function prForget(){
  prS.clients = null; prS.campaigns = null; prS.rows = null; prS.total = 0; prS.page = 0;
  prS.f = {client:'', campaign:'', sentiment:'', booked:'any', q:''};
  prS.err = ''; prS.clientsErr = ''; prS.campaignsErr = '';
  prS.thread = null; prS.threadId = ''; prS.threadErr = '';
  prS.seq = prS.seq + 1;
}
