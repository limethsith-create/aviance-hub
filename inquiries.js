/* ===================== AVIANCE HUB — Inquiries (the website's bookings) =====================
   People who want Starter / Growth / Scale book a sales call from the website's
   "Book a call" form — the only way in. The machine saves each one, puts the call in the Calendar, emails them
   the confirmation and the reminders, and pops it up on the owner's phone (push url
   /#inquiry/{id}); here he sees every person's stage and moves them along: Booked → Call done
   (or No-show) → Following up → Agreement and invoice sent (the yes: both are emailed at once) → Won (paid:
   they become a paying client and the onboarding email goes out) / Lost, and adds notes. Lost closes the record held for the call. Contract: email-distributor/docs/HUB-API.md
   "Changes on 2026-11-20" and "## Plan inquiries".
     GET  /api/mc/hub        → inquiries: {counts, open, latest:[…]} + a to-do per new one
     GET  /api/mc/inquiries  → {inquiries:[record…] newest first, counts}
     POST /api/mc/inquiries  {action:'status', id, status, note?} · {action:'note', id, text}
   Loaded after trials.js: it reuses the machine client, the host/repaint plumbing and trialPost. */

const IQ_HOST_TZ = 'Asia/Colombo';   // the owner's time (the website books calls in it; whenHost is written in it)
/* The stages, in pipeline order (the machine's `status`), and the owner's word for each. */
const IQ_STATUSES = ['new', 'held', 'no_show', 'contacted', 'agreement_sent', 'won', 'lost'];
const IQ_STATUS = { new: ['blue', 'Booked'], held: ['amber', 'Call done'], no_show: ['red', 'No-show'], contacted: ['amber', 'Following up'], agreement_sent: ['amber', 'Agreement and invoice sent'], won: ['green', 'Won'], lost: ['grey', 'Lost'] };
const IQ_OPEN = ['new', 'held', 'no_show', 'contacted', 'agreement_sent'];
/* Older records say 'proposal' / 'proposal_sent': the same stage as agreement_sent. */
function iqKey(s) { return s === 'proposal' || s === 'proposal_sent' ? 'agreement_sent' : s; }
function iqFixList(list) { return (list || []).map((q) => (q && iqKey(q.status) !== q.status ? Object.assign({}, q, { status: iqKey(q.status) }) : q)); }
function iqFixCounts(c) { if (!c || (c.proposal == null && c.proposal_sent == null)) return c; const o = Object.assign({}, c); o.agreement_sent = (Number(o.agreement_sent) || 0) + (Number(o.proposal) || 0) + (Number(o.proposal_sent) || 0); delete o.proposal; delete o.proposal_sent; return o; }
/* What usually comes next from each stage (the first is the big button). */
const IQ_NEXT = { new: ['held', 'no_show'], held: ['agreement_sent', 'contacted'], no_show: ['contacted', 'lost'], contacted: ['agreement_sent', 'lost'], agreement_sent: ['won', 'lost'], won: [], lost: ['contacted'] };
const IQ_FILTERS = [['open', 'Open'], ['all', 'All']].concat(IQ_STATUSES.map((s) => [s, IQ_STATUS[s][1]]));
const IQ_CHIPS = ['open', 'all'];   // the chips; each stage is a tile on the pipeline above them
const iq = { list: null, counts: null, at: 0, err: null, filter: 'open' };
let currentInquiryId = null;

/* ---------- pure helpers ---------- */
function iqCountsOf(list) { const c = {}; IQ_STATUSES.forEach((k) => { c[k] = 0; }); (list || []).forEach((q) => { const k = iqKey(q.status); if (c[k] != null) c[k]++; }); return c; }
/* The freshest counts we have: the full list if it came after the board, else the board's summary. */
function iqCounts() {
  const hq = typeof tk !== 'undefined' && tk.hub && tk.hub.inquiries;
  if (iq.counts && (!hq || iq.at >= tk.hubAt)) return iqFixCounts(iq.counts);
  return iqFixCounts((hq && hq.counts) || null);
}
function inquiriesNavCount() { const c = iqCounts(); const n = c ? Number(c.new) || 0 : 0; return n > 0 ? n : ''; }
function iqIsOpen(q) { return Boolean(q) && IQ_OPEN.includes(iqKey(q.status)); }
/* Booked, and the call's time has passed: the owner should say how it went. */
function iqNeedsOutcome(q, now) { const s = tkParseDate(q && q.slotStart); return Boolean(q && q.status === 'new' && s && (now || new Date()) - s > 20 * 60000); }
function iqMatches(q, f) { return f === 'all' ? true : f === 'open' ? iqIsOpen(q) : iqKey(q.status) === f; }
function iqFind(id) { return (iq.list || []).find((q) => q.id === id) || null; }
function iqPlanName(p) { return { starter: 'Starter', growth: 'Growth', scale: 'Scale' }[String(p || '').toLowerCase()] || ''; }
function iqPlanChip(p) { const n = iqPlanName(p); return n ? `<span class="pill blue">${esc(n)} plan</span>` : '<span class="pill grey">No plan picked</span>'; }
function iqStatusPill(s) { s = iqKey(s); const m = IQ_STATUS[s] || ['grey', s || '—']; return `<span class="pill ${m[0]}">${esc(m[1])}</span>`; }
function iqClip(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
function iqEmail(e) { e = String(e || '').trim(); return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(e) ? e : ''; }
/* The website stores what they typed ("stoneroofing.com" or a full URL) — link only http(s). */
function iqSiteUrl(w) { w = String(w || '').trim(); if (!w) return ''; if (!/^https?:\/\//i.test(w) && /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(w)) w = 'https://' + w; return tkSafeUrl(w); }
/* Where they came from (the booking link's ?utm_source=cold_call or ?ref=…). The machine sends `cameFrom`
   ("Cold call (campaign: nov)"); older records only have utm/ref, so the same friendly words are worked out here. */
const IQ_SOURCE_WORDS = { cold_call: 'Cold call', coldcall: 'Cold call', call: 'Cold call', phone: 'Cold call', linkedin: 'LinkedIn', li: 'LinkedIn', email: 'Email', cold_email: 'Email', newsletter: 'Email', google: 'Google', facebook: 'Facebook', fb: 'Facebook', instagram: 'Instagram', ig: 'Instagram', x: 'X (Twitter)', twitter: 'X (Twitter)', referral: 'Referral', website: 'Website' };
function iqSourceWord(v) { v = String(v == null ? '' : v).trim().slice(0, 100); if (!v) return ''; return IQ_SOURCE_WORDS[v.toLowerCase().replace(/[\s-]+/g, '_')] || v; }
/* The short tag for the list row: "Cold call", "LinkedIn" (no campaign detail). */
function iqSourceTag(q) { const u = (q && q.utm && typeof q.utm === 'object') ? q.utm : {}; return iqSourceWord(u.source) || iqSourceWord(q && q.ref) || iqSourceWord(u.medium); }
/* The full line for "About them": the machine's own words, else the tag plus any campaign / ref. */
function iqCameFrom(q) {
  if (!q) return '';
  if (q.cameFrom) return String(q.cameFrom).slice(0, 300);
  const main = iqSourceTag(q); if (!main) return '';
  const u = (q.utm && typeof q.utm === 'object') ? q.utm : {};
  const bits = [u.campaign ? 'campaign: ' + u.campaign : '', u.content ? 'content: ' + u.content : '', q.ref && iqSourceWord(q.ref) !== main ? 'ref: ' + q.ref : ''].filter(Boolean);
  return bits.length ? main + ' (' + bits.join(', ') + ')' : main;
}
/* A phone number made safe for a tel: link (digits, + and an ext only); '' when it isn't one. */
function iqTel(p) { const t = String(p || '').trim(); if (!/^[+\d\s().\-]+((\s*(ext|x)\.?\s*)\d{1,6})?$/i.test(t)) return ''; const m = t.match(/^(.*?)(?:\s*(?:ext|x)\.?\s*(\d{1,6}))?$/i); const main = m[1].replace(/[^\d+]/g, ''); return main.replace(/\D/g, '').length >= 7 ? main + (m[2] ? ',' + m[2] : '') : ''; }
function iqMailto(q) { const e = iqEmail(q && q.email); return e ? 'mailto:' + e + '?subject=' + encodeURIComponent('Your Aviance call') : ''; }
function iqDur(sec) { sec = Math.abs(sec); if (sec < 90) return '1 min'; if (sec < 3600) return Math.round(sec / 60) + ' min'; if (sec < 36 * 3600) return Math.round(sec / 3600) + ' h'; const d = Math.round(sec / 86400); return d + (d === 1 ? ' day' : ' days'); }
/* "call in 3 h" · "call is now" · "was 2 days ago" */
function iqCallRel(start, end, now) {
  const s = tkParseDate(start); if (!s) return '';
  now = now || new Date(); const e = tkParseDate(end) || new Date(s.getTime() + 15 * 60000);
  if (now >= s && now <= e) return 'call is now';
  const diff = (s - now) / 1000;
  return diff > 0 ? 'call in ' + iqDur(diff) : 'was ' + iqDur(diff) + ' ago';
}
/* Short owner-time label for the board: "Tue 7:30 PM" this week, else "Oct 30, 7:30 PM". */
function iqHostShort(start, now) {
  const d = tkParseDate(start); if (!d) return '';
  const soon = Math.abs(d - (now || new Date())) < 6 * 86400000;
  try { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: IQ_HOST_TZ, hour: 'numeric', minute: '2-digit' }, soon ? { weekday: 'short' } : { month: 'short', day: 'numeric' })).format(d).replace(/^(\w{3}),? /, '$1 '); } catch (e) { return tkDateTime(d); }
}
/* The booked call in the owner's time: the website's own text first. */
function iqWhenHost(q) {
  if (q.whenHost) return q.whenHost;
  const d = tkParseDate(q.slotStart); if (!d) return '';
  try { return new Intl.DateTimeFormat('en-US', { timeZone: IQ_HOST_TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d); } catch (e) { return tkDateTime(d); }
}
/* ---------- renderers (pure: data → HTML) ---------- */
function renderInquiryCall(q, now, cls) {
  const when = iqWhenHost(q);
  if (!when) return `<div class="${cls || 'iq-call'} muted">No call booked</div>`;
  const rel = iqCallRel(q.slotStart, q.slotEnd, now);
  const future = /^call/.test(rel);
  return `<div class="${cls || 'iq-call'}"><b>${esc(when)}</b> <span class="muted">your time</span>${rel ? ` · <span class="iq-rel${future ? ' soon' : ''}">${esc(rel)}</span>` : ''}</div>`;
}
/* Their quick answers in one short line: "Founder / CEO · $5,000 – $25,000 deals · Around 10 calls a month". */
function iqAnswersLine(q) {
  const bits = [q.role, q.dealSize ? q.dealSize + ' deals' : '', q.capacity ? q.capacity + ' calls a month' : ''].filter(Boolean);
  return bits.join(' · ');
}
/* What the machine sent them: "✓ Confirmation · ✓ Day before · ✓ 1 hour before" (or why the confirmation failed). */
function iqMailLine(q) {
  if (!q || !q.slotStart) return '';
  if (q.confirmationError) return `<span class="iq-mail bad">Confirmation email failed — write to them</span>`;
  if (!q.confirmationSentAt) return '';
  const tick = (on, w) => `<span class="iq-mail${on ? ' on' : ''}">${on ? '✓' : '·'} ${w}</span>`;
  return tick(true, 'Confirmation') + tick(Boolean(q.reminded_tomorrow), 'Day before') + tick(Boolean(q.reminded_soon), '1 hour before') + tick(Boolean(q.reminded_now), '5 min before');
}
function renderInquiryCard(q, now) {
  const needs = iqNeedsOutcome(q, now);
  const go = `openInquiry(${tkAttr(q.id)})`;
  const ans = iqAnswersLine(q), mail = iqMailLine(q), src = iqSourceTag(q);
  return `<div class="card iq-card${needs ? ' iq-new' : ''}" role="button" tabindex="0" onclick="${go}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${go}}">
    <div class="iq-card-head"><b class="iq-company">${esc(q.company || '—')}</b>${iqStatusPill(q.status)}${iqPlanChip(q.plan)}${src ? `<span class="pill grey iq-src" title="Came from">${esc(iqClip(src, 40))}</span>` : ''}</div>
    ${needs ? '<div class="iq-needs">How did the call go? Move them on</div>' : ''}
    <div class="iq-who">${esc(q.name || '')}${q.at ? `<span class="muted"> · asked <span title="${esc(tkFull(q.at))}">${esc(tkRel(q.at, now))}</span></span>` : ''}</div>
    ${renderInquiryCall(q, now)}
    ${q.sells ? `<p class="iq-sells">${esc(iqClip(q.sells, 160))}</p>` : ''}
    ${ans ? `<div class="iq-ans">${esc(ans)}</div>` : ''}
    ${mail ? `<div class="iq-mails">${mail}</div>` : ''}
    ${q.clientId && q.status === 'won' ? '<div class="iq-trial-tag">Now a client</div>' : ''}
  </div>`;
}
/* The pipeline: one tile per stage with how many are in it; a tile filters the list. */
function renderInquiryPipeline(list, filter) {
  const c = iqCountsOf(list);
  return `<div class="iq-pipe" role="group" aria-label="Stages">${IQ_STATUSES.map((k, i) => `<button type="button" class="iq-stage ${IQ_STATUS[k][0]}${filter === k ? ' active' : ''}${c[k] ? '' : ' zero'}" aria-pressed="${filter === k}" onclick="inquiriesSetFilter('${k}')"><b>${c[k]}</b><span>${esc(IQ_STATUS[k][1])}</span>${i < 4 ? '<i aria-hidden="true">›</i>' : ''}</button>`).join('')}</div>`;
}
function renderInquiries(list, counts, filter, meta) {
  list = iqFixList(list); counts = iqFixCounts(counts); filter = iqKey(filter);
  list = list || []; meta = meta || {}; filter = IQ_FILTERS.some(([k]) => k === filter) ? filter : 'open';
  counts = counts || iqCountsOf(list);
  const nOf = (f) => list.filter((q) => iqMatches(q, f)).length;
  // the chips: Open (every stage still in play) and All; each stage is a tile on the pipeline
  const chips = IQ_FILTERS.filter(([k]) => IQ_CHIPS.includes(k));
  const toolbar = `<div class="toolbar iq-toolbar"><div class="seg iq-filters" role="group" aria-label="Which inquiries">${chips.map(([k, l]) => `<button class="${filter === k ? 'active' : ''}" aria-pressed="${filter === k}" onclick="inquiriesSetFilter('${k}')">${l} · ${nOf(k)}</button>`).join('')}</div><div class="tk-inline iq-refresh">${tkUpdatedStamp(meta.at)}</div></div>` + renderInquiryPipeline(list, filter);
  if (!list.length) return emptyState((typeof I !== 'undefined' && I.inquiry) || '', 'No inquiries yet', "When someone books a call from your website's Book a call form, it shows up here.", '', null);
  // Calls still ahead first (soonest first), then everything else newest first.
  const nowMs = (meta.now || new Date()).getTime();
  const ahead = (q) => { const d = tkParseDate(q.slotStart); return d && d.getTime() >= nowMs - 20 * 60000 ? d.getTime() : null; };
  const shown = list.filter((q) => iqMatches(q, filter)).slice().sort((a, b) => {
    const x = ahead(a), y = ahead(b);
    if (x != null && y != null) return x - y;
    if (x != null) return -1; if (y != null) return 1;
    return String(b.at || '').localeCompare(String(a.at || ''));
  });
  const body = shown.length ? `<div class="iq-list">${shown.map((q) => renderInquiryCard(q, meta.now)).join('')}</div>`
    : `<div class="card"><div class="tk-todo-empty">${filter === 'open' ? 'Nothing open. Every inquiry has been answered.' : 'Nobody at ' + esc(IQ_STATUS[filter] ? IQ_STATUS[filter][1] : '') + ' right now.'} <span class="tk-linkish" onclick="inquiriesSetFilter('all')">Show all</span></div></div>`;
  return toolbar + body;
}
function renderInquiry(q, meta) {
  q = iqFixList([q])[0];
  meta = meta || {}; const now = meta.now;
  if (!q) return emptyState((typeof I !== 'undefined' && I.inquiry) || '', 'Inquiry not found', 'It may have been removed.', 'All inquiries', "render('inquiries')");
  const id = q.id, mail = iqMailto(q), email = iqEmail(q.email), site = iqSiteUrl(q.website);
  const tel = iqTel(q.phone);
  const needs = iqNeedsOutcome(q, now);
  const join = q.meetLink ? tkSafeUrl(q.meetLink) : '';
  const head = `<div class="card tk-pad iq-head${needs ? ' iq-new' : ''}">
    <div class="iq-card-head">${iqStatusPill(q.status)}${iqPlanChip(q.plan)}</div>
    <div class="iq-who">${esc(q.name || '')}${q.at ? `<span class="muted"> · asked <span title="${esc(tkFull(q.at))}">${esc(tkRel(q.at, now))}</span>${q.source ? ' from ' + esc(q.source === 'website' ? 'the website' : q.source) : ''}</span>` : ''}</div>
    ${renderInquiryCall(q, now, 'iq-call iq-call-big')}
    ${mail || join || q.meetingId ? `<div class="tk-inline iq-head-act">${join ? `<a class="btn" href="${esc(join)}" target="_blank" rel="noopener">Join the call</a>` : ''}${mail ? `<a class="btn${join ? ' ghost' : ''}" href="${esc(mail)}">Reply by email</a>` : ''}${q.meetingId ? `<button class="btn ghost" onclick="inquiryOpenCalendar(${tkAttr(id)})">See it in the Calendar</button>` : ''}</div>` : ''}
  </div>`;
  const came = iqCameFrom(q);
  const theirs = q.whenTheirs ? esc(q.whenTheirs) + (q.theirTz ? ` <span class="muted">(${esc(q.theirTz)})</span>` : '') : q.theirTz ? `<span class="muted">${esc(q.theirTz)}</span>` : '—';
  const facts = `<div class="section-head tk-section"><h3>About them</h3></div><div class="card tk-pad"><div class="tk-kv">
    <small>Their time</small><span>${theirs}</span>
    <small>Email</small><span>${email ? `<a href="${esc(mail)}">${esc(email)}</a>` : esc(q.email || '—')}</span>
    ${tel ? `<small>Phone</small><span><a href="tel:${esc(tel)}">${esc(q.phone)}</a></span>` : q.phone ? `<small>Phone</small><span>${esc(q.phone)}</span>` : ''}
    <small>Website</small><span>${site ? tkLink(site, q.website) : q.website ? esc(q.website) : q.noWebsite ? '<span class="muted">Doesn\'t have one yet</span>' : '—'}</span>
    <small>What they sell</small><span class="iq-pre">${esc(q.sells || '—')}</span>
    <small>Plan</small><span>${esc(iqPlanName(q.plan) || 'Not picked')}</span>
    ${came ? `<small>Came from</small><span>${esc(came)}</span>` : ''}
  </div></div>`;
  const answers = [['Their role', q.role], ['Average deal size', q.dealSize], ['How they win customers today', q.channel], ['Sales calls a month they can take', q.capacity], ['When they want calls', q.timing], ['Tried cold email or an agency before', q.tried], ['What they want from the call', q.goal]].filter(([, v]) => v);
  const answersHtml = answers.length ? `<div class="section-head tk-section"><h3>Their answers</h3></div><div class="card tk-pad"><div class="tk-kv">${answers.map(([k, v]) => `<small>${esc(k)}</small><span>${esc(v)}</span>`).join('')}</div></div>` : '';
  const mails = !q.slotStart ? '' : `<div class="section-head tk-section"><h3>Emails to them</h3></div><div class="card tk-pad"><div class="tk-kv">
    <small>Confirmation</small><span>${q.confirmationSentAt ? `Sent ${esc(tkRel(q.confirmationSentAt, now))}, with a calendar invite` : q.confirmationError ? `<b class="iq-bad">Did not send</b> — ${esc(q.confirmationError)}. Write to them.` : 'Not sent'}</span>
    <small>Day-before reminder</small><span>${q.reminded_tomorrow ? 'Sent ' + esc(tkRel(q.reminded_tomorrow, now)) : q.status === 'new' ? 'Goes the day before (if they booked more than a day ahead)' : 'Stopped — they moved on'}</span>
    <small>1-hour reminder</small><span>${q.reminded_soon ? 'Sent ' + esc(tkRel(q.reminded_soon, now)) : q.status === 'new' ? 'Goes an hour before the call' : 'Stopped — they moved on'}</span>
    <small>5-minute reminder</small><span>${q.reminded_now ? 'Sent ' + esc(tkRel(q.reminded_now, now)) : q.status === 'new' ? 'Goes 5 minutes before the call' : 'Stopped — they moved on'}</span>
  </div></div>`;
  // Won makes them a paying client: the record held for the call (with what we found) when they gave a website
  const trial = q.clientId && q.status === 'won'
    ? `<div class="iq-trial-done"><b>Now a client</b> — they were emailed to book the onboarding call. <span class="tk-linkish" onclick="openTrial(${tkAttr(q.clientId)})">Open their page →</span></div>`
    : q.clientId || q.website
      ? `<p class="tk-small muted">They said yes on the call? Press <b>Send the agreement and invoice</b>: both are emailed to them straight away. Once they've paid, press <b>Won</b> and the onboarding email goes out. Or <b>Lost</b> (nothing is emailed).${q.clientId ? ` <span class="tk-linkish" onclick="openTrial(${tkAttr(q.clientId)})">What we found before the call →</span>` : ''}</p>`
      : `<p class="tk-small muted">No website on this booking, so Won can't make them a client from here. Add them with their website instead.</p><div class="tk-inline"><button class="btn ghost" onclick="inquiryAddClient(${tkAttr(id)})">Add them as a paying client</button></div>`;
  const next = IQ_NEXT[q.status] || [];
  const moveBtn = (s, main) => `<button class="btn${main ? '' : ' ghost'}" onclick="inquirySetStatus(${tkAttr(id)},'${s}')">${esc(s === 'agreement_sent' ? 'Send the agreement and invoice' : IQ_STATUS[s][1])}</button>`;
  const others = IQ_STATUSES.filter((s) => s !== q.status && !next.includes(s));
  const path = ['new', 'held', 'contacted', 'agreement_sent', 'won'];
  const at = path.indexOf(q.status);
  const stepper = `<ol class="iq-steps" aria-label="Their stage">${path.map((s, i) => `<li class="${s === q.status ? 'cur' : at > i ? 'done' : ''}">${esc(IQ_STATUS[s][1])}</li>`).join('')}</ol>${['no_show', 'lost'].includes(q.status) ? `<p class="tk-small iq-side">${q.status === 'no_show' ? "They didn't show up for the call." : 'Marked lost.'}</p>` : ''}`;
  const status = `<div class="section-head tk-section"><h3>Where it stands</h3>${iqStatusPill(q.status)}${q.statusAt ? `<span class="tk-updated" title="${esc(tkFull(q.statusAt))}">since ${esc(tkRel(q.statusAt, now))}</span>` : ''}</div>
    <div class="card tk-pad iq-moves">${stepper}
    ${next.length ? `<p class="tk-small muted iq-move-q">Move them to:</p><div class="tk-inline">${next.map((s, i) => moveBtn(s, i === 0)).join('')}</div>` : ''}
    <details class="iq-other"><summary>Another stage</summary><div class="tk-inline">${others.map((s) => moveBtn(s, false)).join('')}</div></details>
    <div class="field"><label for="iqStatusNote">Note with the change (optional)</label><input id="iqStatusNote" data-tk-form placeholder="e.g. Said yes to Growth on the call"></div>
    <div class="iq-trial">${trial}</div></div>`;
  const notes = (q.notes || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const notesHtml = `<div class="section-head tk-section"><h3>Notes</h3><span class="count">${notes.length}</span></div><div class="card tk-pad">
    ${notes.length ? `<ul class="iq-notes">${notes.map((n) => `<li><span class="iq-note-at" title="${esc(tkFull(n.at))}">${esc(tkDateTime(n.at))}</span><span class="iq-pre">${esc(n.text || '')}</span></li>`).join('')}</ul>` : '<p class="tk-small muted">No notes yet.</p>'}
    <div class="field iq-add-note"><label for="iqNoteText">Add a note</label><textarea id="iqNoteText" data-tk-form rows="2" placeholder="What happened on the call, what you promised…"></textarea></div>
    <div class="tk-inline"><button class="btn ghost" onclick="inquiryAddNote(${tkAttr(id)})">Add note</button></div></div>`;
  return head + status + answersHtml + mails + facts + notesHtml;
}
/* The small line on Behind the scenes: "2 new inquiries — Stone Roofing, call Tue 7:30 PM". */
function renderInquiryStrip(summary, meta) {
  meta = meta || {};
  if (!summary || !summary.counts) return '';
  const c = summary.counts, latest = summary.latest || [];
  const nNew = Number(c.new) || 0, nOpen = Number(summary.open) || 0;
  if (!nNew && !nOpen) return '';
  const pool = latest.filter((q) => (nNew ? q.status === 'new' : iqIsOpen(q)));
  const now = meta.now || new Date();
  const upcoming = pool.filter((q) => { const d = tkParseDate(q.slotStart); return d && d >= now; }).sort((a, b) => String(a.slotStart).localeCompare(String(b.slotStart)));
  const pick = upcoming[0] || pool[0] || null;
  const head = nNew ? `${nNew} booked call${nNew === 1 ? '' : 's'}` : `${nOpen} open inquir${nOpen === 1 ? 'y' : 'ies'}`;
  const when = pick ? (pick.slotStart ? iqHostShort(pick.slotStart, now) : '') : '';
  const who = pick ? ` — ${esc(pick.company || pick.name || '')}${when ? ', call ' + esc(when) : ''}` : '';
  return `<div class="card iq-strip${nNew ? ' iq-new' : ''}" role="button" tabindex="0" onclick="render('inquiries')" onkeydown="if(event.key==='Enter'){render('inquiries')}">
    <span class="iq-strip-ic">${(typeof I !== 'undefined' && I.inquiry) || ''}</span><div class="iq-strip-main"><b>${head}${who}</b><small>Paid-plan calls booked from the website${nNew && nOpen > nNew ? ` · ${nOpen - nNew} more in progress` : ''}</small></div>
    <span class="btn ghost iq-strip-go">Open inquiries</span></div>`;
}
function inquiriesHostHTML(view) {
  if (view === 'inquiries') return iq.list ? renderStaleNote(iq.err, iq.at) + renderInquiries(iq.list, iq.counts, iq.filter, { at: iq.at }) : iq.err ? renderMachineError(iq.err) : renderLoading();
  const id = currentInquiryId;
  if (!id) return emptyState((typeof I !== 'undefined' && I.inquiry) || '', 'Pick an inquiry', 'Open one from the list.', 'All inquiries', "render('inquiries')");
  if (!iq.list) return iq.err ? renderMachineError(iq.err) : renderLoading();
  return renderStaleNote(iq.err, iq.at) + renderInquiry(iqFind(id), { at: iq.at });
}
function inquiryTitle() {
  if (currentView !== 'inquiry') return;
  const q = iqFind(currentInquiryId); if (!q) return;
  const t = document.getElementById('ptitle'), s = document.getElementById('psub');
  if (t) t.textContent = q.company || 'Inquiry';
  if (s) s.textContent = 'Plan inquiry · ' + (IQ_STATUS[q.status] ? IQ_STATUS[q.status][1] : q.status || '');
}

/* ---------- machine ---------- */
async function loadInquiries(force) {
  if (!force && iq.list && Date.now() - iq.at < TK_FRESH_MS) return { ok: true, data: { inquiries: iq.list, counts: iq.counts } };
  const r = await machineFetch('/api/mc/inquiries');
  if (r.ok && r.data && Array.isArray(r.data.inquiries)) { iq.list = iqFixList(r.data.inquiries); iq.counts = iqFixCounts(r.data.counts) || iqCountsOf(iq.list); iq.at = Date.now(); iq.err = null; }
  else { iq.err = r.error || "The inquiries didn't load. Try again."; if (r.ok) r.ok = false; }
  return r;
}

/* ---------- views (called by the shell router) + actions ---------- */
function viewInquiries() { if (!trialsIsAdmin()) return trialsNotAdminHTML(); trialsKick('inquiries'); loadHub(false).then(() => { try { renderNav(); } catch (e) { /* signed out */ } }); return `<div id="tkHost">${trialsHostHTML('inquiries')}</div>`; }
function viewInquiry() { if (!trialsIsAdmin()) return trialsNotAdminHTML(); trialsKick('inquiry'); loadHub(false).then(() => { try { renderNav(); } catch (e) { /* signed out */ } }); return `<div id="tkHost">${trialsHostHTML('inquiry')}</div>`; }
function openInquiry(id) { if (!id) return; currentInquiryId = String(id); render('inquiry'); }
function inquiriesSetFilter(f) { iq.filter = f; trialsRepaint('inquiries'); }
/* The Calendar at this call's week, with the meeting open. */
function inquiryOpenCalendar(id) {
  const q = iqFind(id); if (!q || !q.meetingId) return;
  const d = tkParseDate(q.slotStart);
  try { if (d && typeof cal !== 'undefined') cal.week = calMonday(calDayKey(d, calSettingsNow().ownerZone)); } catch (e) { /* the Calendar works it out */ }
  openCalendar(q.meetingId);
}
function inquirySetStatus(id, status) {
  const n = document.getElementById('iqStatusNote'); const note = n && n.value ? n.value.trim() : '';
  const label = IQ_STATUS[status] ? IQ_STATUS[status][1].toLowerCase() : status;
  const q = iqFind(id); const name = (q && (q.company || q.name)) || 'them';
  // Won makes them a paying client and emails them; the machine says why when it can't (no website, say)
  const opts = status === 'agreement_sent'
    ? { confirm: 'Send ' + name + ' the agreement and the invoice now? Both are emailed to them straight away.', done: 'Agreement and invoice sent to ' + name, fail: 'Not sent' }
    : status === 'won'
    ? { confirm: 'Mark ' + name + ' as Won? Only once they have paid: they become a paying client and get an email asking them to book the onboarding call.', done: 'Won — ' + name + ' is a client now and was emailed', fail: 'Not marked Won' }
    : status === 'lost' && q && q.clientId ? { confirm: 'Mark ' + name + ' as Lost? Nothing is emailed to them.', done: 'Moved to Lost', fail: 'Not changed' }
      : { done: 'Moved to ' + (IQ_STATUS[status] ? IQ_STATUS[status][1] : label), fail: 'Not changed' };
  return trialPost('/api/mc/inquiries', Object.assign({ action: 'status', id, status }, note ? { note } : {}), opts);
}
function inquiryAddNote(id) {
  const t = document.getElementById('iqNoteText'); const text = t && t.value ? t.value.trim() : '';
  if (!text) { toast('Write the note first'); return Promise.resolve({ ok: false }); }
  return trialPost('/api/mc/inquiries', { action: 'note', id, text }, { done: 'Note added', fail: 'Note not saved' });
}
/* A booking without a website: the "Add a paying client" form, filled in from the booking (they add the website). */
function inquiryAddClient(id) {
  const q = iqFind(id) || {};
  if (typeof openNewPayingClient === 'function') openNewPayingClient({ companyName: q.company || '', contactName: q.name || '', contactEmail: q.email || '', website: q.website || '', plan: q.plan || 'starter' });
}
function inquiriesForget() { Object.assign(iq, { list: null, counts: null, at: 0, err: null, filter: 'open' }); currentInquiryId = null; }

/* ⌘K: every inquiry we know (the full list, or the board's newest open ones). */
function inquiriesCmdkEntities() {
  const rows = iq.list || (typeof tk !== 'undefined' && tk.hub && tk.hub.inquiries && tk.hub.inquiries.latest) || [];
  return rows.map((q) => ({ type: 'Inquiry', label: q.company || q.name || q.id, icon: (typeof I !== 'undefined' && I.inquiry) || '', sub: (IQ_STATUS[q.status] ? IQ_STATUS[q.status][1] : q.status || '') + ' · ' + (q.name || '') + (iqPlanName(q.plan) ? ' · ' + iqPlanName(q.plan) : ''), kw: 'inquiry plan ' + [q.company, q.name, q.email, q.plan, q.status].filter(Boolean).join(' '), run: () => { closeCmdk(); openInquiry(q.id); } }));
}
