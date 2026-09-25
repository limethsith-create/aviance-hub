/* ===================== AVIANCE HUB — Inquiries (paid plans, no trial) =====================
   People who want Starter / Growth / Scale without a trial book a call from the website's
   "Book a call" form. The machine saves each one and pops it up on the owner's phone
   (push url /#inquiry/{id}); here he moves it along: new → contacted → won / lost, adds notes,
   or turns it into a trial. Contract: email-distributor/docs/HUB-API.md "## Plan inquiries".
     GET  /api/mc/hub        → inquiries: {counts, open, latest:[…]} + a to-do per new one
     GET  /api/mc/inquiries  → {inquiries:[record…] newest first, counts}
     POST /api/mc/inquiries  {action:'status', id, status, note?} · {action:'note', id, text} · {action:'toTrial', id}
   Loaded after trials.js: it reuses the machine client, the host/repaint plumbing and trialPost. */

const IQ_HOST_TZ = 'Asia/Colombo';   // the owner's time (the website books calls in it; whenHost is written in it)
const IQ_STATUSES = ['new', 'contacted', 'won', 'lost'];
const IQ_STATUS = { new: ['red', 'New'], contacted: ['amber', 'Contacted'], won: ['green', 'Won'], lost: ['grey', 'Lost'] };
const IQ_FILTERS = [['open', 'Open'], ['all', 'All'], ['new', 'New'], ['contacted', 'Contacted'], ['won', 'Won'], ['lost', 'Lost']];
const iq = { list: null, counts: null, at: 0, err: null, filter: 'open' };
let currentInquiryId = null;

/* ---------- pure helpers ---------- */
function iqCountsOf(list) { const c = { new: 0, contacted: 0, won: 0, lost: 0 }; (list || []).forEach((q) => { if (c[q.status] != null) c[q.status]++; }); return c; }
/* The freshest counts we have: the full list if it came after the board, else the board's summary. */
function iqCounts() {
  const hq = typeof tk !== 'undefined' && tk.hub && tk.hub.inquiries;
  if (iq.counts && (!hq || iq.at >= tk.hubAt)) return iq.counts;
  return (hq && hq.counts) || null;
}
function inquiriesNavCount() { const c = iqCounts(); const n = c ? Number(c.new) || 0 : 0; return n > 0 ? n : ''; }
function iqIsOpen(q) { return q && (q.status === 'new' || q.status === 'contacted'); }
function iqMatches(q, f) { return f === 'all' ? true : f === 'open' ? iqIsOpen(q) : q.status === f; }
function iqFind(id) { return (iq.list || []).find((q) => q.id === id) || null; }
function iqPlanName(p) { return { starter: 'Starter', growth: 'Growth', scale: 'Scale' }[String(p || '').toLowerCase()] || ''; }
function iqPlanChip(p) { const n = iqPlanName(p); return n ? `<span class="pill blue">${esc(n)} plan</span>` : '<span class="pill grey">No plan picked</span>'; }
function iqStatusPill(s) { const m = IQ_STATUS[s] || ['grey', s || '—']; return `<span class="pill ${m[0]}">${esc(m[1])}</span>`; }
function iqClip(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
function iqEmail(e) { e = String(e || '').trim(); return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(e) ? e : ''; }
/* The website stores what they typed ("stoneroofing.com" or a full URL) — link only http(s). */
function iqSiteUrl(w) { w = String(w || '').trim(); if (!w) return ''; if (!/^https?:\/\//i.test(w) && /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(w)) w = 'https://' + w; return tkSafeUrl(w); }
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
function iqTrialOutcomeText(o) {
  return { onboarding: 'onboarding link emailed', queued: 'waiting in the queue', declined: 'the machine declined it', manual: 'needs you to finish it by hand', review: 'waiting for your review', received: 'already applied' }[String(o || '').toLowerCase()] || '';
}
/* What to tell the owner after "Start a trial instead". */
function iqTrialToast(d, name) {
  d = d || {}; const o = String(d.outcome || '').toLowerCase(); name = name || 'them';
  if (d.already) return 'This inquiry is already a trial';
  if (d.duplicate || o === 'received') return name + ' already applied for a trial moments ago. Nothing new was sent';
  if (o === 'onboarding') return 'Trial started. ' + name + ' was emailed the onboarding link';
  if (o === 'queued') { const pos = d.position != null ? d.position : null; return 'Trial started. In the queue' + (pos != null ? ' at position ' + pos : '') + '; the onboarding link goes out when a spot opens'; }
  if (o === 'declined') return 'The machine declined the trial' + (d.reason ? ' (' + String(d.reason).replace(/_/g, ' ') + ')' : '');
  if (o === 'review') return 'Trial saved and waiting for your review';
  if (o === 'manual') return 'Trial saved, but the machine hit a problem. Open the trial to finish it';
  return 'Trial started';
}

/* ---------- renderers (pure: data → HTML) ---------- */
function renderInquiryCall(q, now, cls) {
  const when = iqWhenHost(q);
  if (!when) return `<div class="${cls || 'iq-call'} muted">No call booked</div>`;
  const rel = iqCallRel(q.slotStart, q.slotEnd, now);
  const future = /^call/.test(rel);
  return `<div class="${cls || 'iq-call'}"><b>${esc(when)}</b> <span class="muted">your time</span>${rel ? ` · <span class="iq-rel${future ? ' soon' : ''}">${esc(rel)}</span>` : ''}</div>`;
}
function renderInquiryCard(q, now) {
  const isNew = q.status === 'new';
  const go = `openInquiry(${tkAttr(q.id)})`;
  return `<div class="card iq-card${isNew ? ' iq-new' : ''}" role="button" tabindex="0" onclick="${go}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${go}}">
    <div class="iq-card-head"><b class="iq-company">${esc(q.company || '—')}</b>${isNew ? '<span class="pill red">New</span>' : iqStatusPill(q.status)}${iqPlanChip(q.plan)}</div>
    <div class="iq-who">${esc(q.name || '')}${q.at ? `<span class="muted"> · asked <span title="${esc(tkFull(q.at))}">${esc(tkRel(q.at, now))}</span></span>` : ''}</div>
    ${renderInquiryCall(q, now)}
    ${q.sells ? `<p class="iq-sells">${esc(iqClip(q.sells, 160))}</p>` : ''}
    ${q.clientId ? '<div class="iq-trial-tag">Now a trial</div>' : ''}
  </div>`;
}
function renderInquiries(list, counts, filter, meta) {
  list = list || []; meta = meta || {}; filter = IQ_FILTERS.some(([k]) => k === filter) ? filter : 'open';
  counts = counts || iqCountsOf(list);
  const tiles = `<div class="iq-counts">${IQ_STATUSES.map((s) => `<button class="iq-count ${s}${(Number(counts[s]) || 0) > 0 ? ' has' : ''}${filter === s ? ' active' : ''}" onclick="inquiriesSetFilter('${s}')" aria-pressed="${filter === s}"><small>${IQ_STATUS[s][1]}</small><b>${tkNum(counts[s] || 0)}</b></button>`).join('')}</div>`;
  const nOf = (f) => list.filter((q) => iqMatches(q, f)).length;
  const toolbar = `<div class="toolbar iq-toolbar"><div class="seg iq-filters">${IQ_FILTERS.map(([k, l]) => `<button class="${filter === k ? 'active' : ''}" onclick="inquiriesSetFilter('${k}')">${l} · ${nOf(k)}</button>`).join('')}</div><div class="tk-inline iq-refresh">${tkUpdatedStamp(meta.at)}<button class="btn ghost" onclick="trialsRefresh()">Refresh</button></div></div>`;
  if (!list.length) return tiles + emptyState((typeof I !== 'undefined' && I.inquiry) || '', 'No inquiries yet', "When someone books a call from the website's Book a call form, it lands here and pops up on your phone.", '', null);
  const shown = list.filter((q) => iqMatches(q, filter)).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const body = shown.length ? `<div class="iq-list">${shown.map((q) => renderInquiryCard(q, meta.now)).join('')}</div>`
    : `<div class="card"><div class="tk-todo-empty">${filter === 'open' ? 'Nothing open. Every inquiry has been answered.' : 'No ' + esc(IQ_STATUS[filter] ? IQ_STATUS[filter][1].toLowerCase() : '') + ' inquiries.'} <span class="tk-linkish" onclick="inquiriesSetFilter('all')">Show all</span></div></div>`;
  return tiles + toolbar + body;
}
function renderInquiry(q, meta) {
  meta = meta || {}; const now = meta.now;
  if (!q) return emptyState((typeof I !== 'undefined' && I.inquiry) || '', 'Inquiry not found', "It isn't on the machine any more.", 'All inquiries', "render('inquiries')");
  const id = q.id, mail = iqMailto(q), email = iqEmail(q.email), site = iqSiteUrl(q.website);
  const isNew = q.status === 'new';
  const head = `<div class="card tk-pad iq-head${isNew ? ' iq-new' : ''}">
    <div class="iq-card-head"><h3 class="iq-company">${esc(q.company || '—')}</h3>${isNew ? '<span class="pill red">New</span>' : iqStatusPill(q.status)}${iqPlanChip(q.plan)}</div>
    <div class="iq-who">${esc(q.name || '')}${q.at ? `<span class="muted"> · asked <span title="${esc(tkFull(q.at))}">${esc(tkRel(q.at, now))}</span>${q.source ? ' from ' + esc(q.source === 'website' ? 'the website' : q.source) : ''}</span>` : ''}</div>
    ${renderInquiryCall(q, now, 'iq-call iq-call-big')}
    <div class="tk-inline iq-head-act">${mail ? `<a class="btn" href="${esc(mail)}">Reply by email</a>` : ''}<button class="btn ghost" onclick="render('inquiries')">← All inquiries</button></div>
  </div>`;
  const theirs = q.whenTheirs ? esc(q.whenTheirs) + (q.theirTz ? ` <span class="muted">(${esc(q.theirTz)})</span>` : '') : q.theirTz ? `<span class="muted">${esc(q.theirTz)}</span>` : '—';
  const facts = `<div class="section-head tk-section"><h3>About them</h3></div><div class="card tk-pad"><div class="tk-kv">
    <small>Their time</small><span>${theirs}</span>
    <small>Email</small><span>${email ? `<a href="${esc(mail)}">${esc(email)}</a>` : esc(q.email || '—')}</span>
    <small>Website</small><span>${site ? tkLink(site, q.website) : esc(q.website || '—')}</span>
    <small>What they sell</small><span class="iq-pre">${esc(q.sells || '—')}</span>
    <small>Plan</small><span>${esc(iqPlanName(q.plan) || 'Not picked')}</span>
  </div></div>`;
  const trial = q.clientId
    ? `<div class="iq-trial-done"><b>Now a trial</b>${q.trialOutcome && iqTrialOutcomeText(q.trialOutcome) ? ' — ' + esc(iqTrialOutcomeText(q.trialOutcome)) : ''}. <span class="tk-linkish" onclick="openTrial(${tkAttr(q.clientId)})">Open the trial →</span></div>`
    : `<p class="tk-small muted">Not ready for a paid plan? The machine emails them the trial onboarding link, or puts them in the queue if three trials are running.</p><div class="tk-inline"><button class="btn ghost" onclick="inquiryToTrial(${tkAttr(id)})">Start a trial instead</button></div>`;
  const moves = IQ_STATUSES.filter((s) => s !== q.status).map((s) => `<button class="btn${s === 'contacted' && isNew ? '' : ' ghost'}" onclick="inquirySetStatus(${tkAttr(id)},'${s}')">${s === 'new' ? 'Back to New' : 'Mark ' + IQ_STATUS[s][1].toLowerCase()}</button>`).join('');
  const status = `<div class="section-head tk-section"><h3>Where it stands</h3>${iqStatusPill(q.status)}${q.statusAt ? `<span class="tk-updated" title="${esc(tkFull(q.statusAt))}">since ${esc(tkRel(q.statusAt, now))}</span>` : ''}</div>
    <div class="card tk-pad iq-moves"><div class="field"><label for="iqStatusNote">Note with the change (optional)</label><input id="iqStatusNote" data-tk-form placeholder="e.g. Called, sending a proposal on Monday"></div>
    <div class="tk-inline">${moves}</div><div class="iq-trial">${trial}</div></div>`;
  const notes = (q.notes || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const notesHtml = `<div class="section-head tk-section"><h3>Notes</h3><span class="count">${notes.length}</span></div><div class="card tk-pad">
    ${notes.length ? `<ul class="iq-notes">${notes.map((n) => `<li><span class="iq-note-at" title="${esc(tkFull(n.at))}">${esc(tkDateTime(n.at))}</span><span class="iq-pre">${esc(n.text || '')}</span></li>`).join('')}</ul>` : '<p class="tk-small muted">No notes yet.</p>'}
    <div class="field iq-add-note"><label for="iqNoteText">Add a note</label><textarea id="iqNoteText" data-tk-form rows="2" placeholder="What happened on the call, what you promised…"></textarea></div>
    <div class="tk-inline"><button class="btn ghost" onclick="inquiryAddNote(${tkAttr(id)})">Add note</button></div></div>`;
  return head + status + facts + notesHtml;
}
/* The small line on the Trials board: "2 new inquiries — Stone Roofing, call Tue 7:30 PM". */
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
  const head = nNew ? `${nNew} new inquir${nNew === 1 ? 'y' : 'ies'}` : `${nOpen} open inquir${nOpen === 1 ? 'y' : 'ies'}`;
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
  if (r.ok && r.data && Array.isArray(r.data.inquiries)) { iq.list = r.data.inquiries; iq.counts = r.data.counts || iqCountsOf(iq.list); iq.at = Date.now(); iq.err = null; }
  else { iq.err = r.error || 'The machine answered without an "inquiries" list.'; if (r.ok) r.ok = false; }
  return r;
}

/* ---------- views (called by the shell router) + actions ---------- */
function viewInquiries() { if (!trialsIsAdmin()) return trialsNotAdminHTML(); trialsKick('inquiries'); loadHub(false).then(() => { try { renderNav(); } catch (e) { /* signed out */ } }); return `<div id="tkHost">${trialsHostHTML('inquiries')}</div>`; }
function viewInquiry() { if (!trialsIsAdmin()) return trialsNotAdminHTML(); trialsKick('inquiry'); loadHub(false).then(() => { try { renderNav(); } catch (e) { /* signed out */ } }); return `<div id="tkHost">${trialsHostHTML('inquiry')}</div>`; }
function openInquiry(id) { if (!id) return; currentInquiryId = String(id); render('inquiry'); }
function inquiriesSetFilter(f) { iq.filter = f; trialsRepaint('inquiries'); }
function inquirySetStatus(id, status) {
  const n = document.getElementById('iqStatusNote'); const note = n && n.value ? n.value.trim() : '';
  const label = IQ_STATUS[status] ? IQ_STATUS[status][1].toLowerCase() : status;
  return trialPost('/api/mc/inquiries', Object.assign({ action: 'status', id, status }, note ? { note } : {}), { done: status === 'new' ? 'Back to new' : 'Marked ' + label, fail: 'Not changed' });
}
function inquiryAddNote(id) {
  const t = document.getElementById('iqNoteText'); const text = t && t.value ? t.value.trim() : '';
  if (!text) { toast('Write the note first'); return Promise.resolve({ ok: false }); }
  return trialPost('/api/mc/inquiries', { action: 'note', id, text }, { done: 'Note added', fail: 'Note not saved' });
}
function inquiryToTrial(id) {
  const q = iqFind(id); const name = (q && (q.name || q.company)) || 'them';
  return trialPost('/api/mc/inquiries', { action: 'toTrial', id }, {
    confirm: 'Email ' + name + ' the trial onboarding link now?',
    done: (data) => { if (q && data && data.clientId) Object.assign(q, { clientId: data.clientId, trialOutcome: data.outcome || q.trialOutcome || null }); return iqTrialToast(data, name); },
    fail: 'Trial not started',
  });
}
function inquiriesForget() { Object.assign(iq, { list: null, counts: null, at: 0, err: null, filter: 'open' }); currentInquiryId = null; }

/* ⌘K: every inquiry we know (the full list, or the board's newest open ones). */
function inquiriesCmdkEntities() {
  const rows = iq.list || (typeof tk !== 'undefined' && tk.hub && tk.hub.inquiries && tk.hub.inquiries.latest) || [];
  return rows.map((q) => ({ type: 'Inquiry', label: q.company || q.name || q.id, icon: (typeof I !== 'undefined' && I.inquiry) || '', sub: (IQ_STATUS[q.status] ? IQ_STATUS[q.status][1] : q.status || '') + ' · ' + (q.name || '') + (iqPlanName(q.plan) ? ' · ' + iqPlanName(q.plan) : ''), kw: 'inquiry plan ' + [q.company, q.name, q.email, q.plan, q.status].filter(Boolean).join(' '), run: () => { closeCmdk(); openInquiry(q.id); } }));
}
