/* ===================== AVIANCE HUB — the stage strip (stages.js) =====================
   Seven stages along the top of Clients, each with how many people are in it. A tap opens that stage's people.
     renderStageStrip(hub, bookings) -> HTML      openStage(key) -> a panel listing the people in that stage
   Bookings come from the inquiries list (status new/held/no_show/contacted = discovery, agreement_sent = waiting to pay);
   clients come from the board (row.simple.step / row.state). Loaded after trials.js and inquiries.js. */

const STG_STAGES = [
  ['discovery', 'Discovery calls'], ['waiting_pay', 'Waiting to pay'], ['onboarding', 'Onboarding'],
  ['setting_up', 'Setting up'], ['warming', 'Warming up'], ['sending', 'Sending'], ['paused', 'Paused'],
];
const STG_DISCOVERY = ['new', 'held', 'contacted', 'no_show'];
const STG_PAUSED_STATES = ['paused', 'stopped', 'retired'];

function stgKey(s) { return s === 'proposal' || s === 'proposal_sent' ? 'agreement_sent' : s; }
/* Which stage a booking sits in (null = not in the strip: won, lost). */
function stageOfBooking(q) {
  const s = stgKey(q && q.status);
  if (STG_DISCOVERY.includes(s)) return 'discovery';
  if (s === 'agreement_sent') return 'waiting_pay';
  return null;
}
/* Which stage a client sits in (null = nobody to show: still a booking, or not taken). */
function stageOfClient(row) {
  if (!row) return null;
  const sp = typeof tkSimple === 'function' ? tkSimple(row) : { step: row.state };
  const st = String(sp.step || '');
  const state = String(row.state || '');
  if (state === 'deleted' || st === 'declined' || st === 'new') return null;
  if (st === 'finished' || STG_PAUSED_STATES.includes(state)) return 'paused';
  if (st === 'accepted' || st === 'call_booked' || st === 'onboarding') return 'onboarding';
  if (st === 'setting_up') return 'setting_up';
  if (st === 'warming_up') return 'warming';
  if (st === 'sending') return 'sending';
  return null;
}
function stgBookings(bookings) {
  if (Array.isArray(bookings)) return bookings;
  if (typeof iq !== 'undefined' && iq.list) return iq.list;
  if (typeof tk !== 'undefined' && tk.hub && tk.hub.inquiries && Array.isArray(tk.hub.inquiries.latest)) return tk.hub.inquiries.latest;
  return [];
}
function stgRows(hub) { return typeof tkAllRows === 'function' ? tkAllRows(hub || null) : []; }
/* The people in each stage: {key: [{kind:'booking'|'client', id, name, sub}]} */
function stagePeople(hub, bookings) {
  const out = {}; STG_STAGES.forEach(([k]) => { out[k] = []; });
  const seen = {};
  stgRows(hub).forEach((r) => {
    if (!r || !r.id || seen[r.id]) return; seen[r.id] = 1;
    const k = stageOfClient(r); if (!k) return;
    const sp = typeof tkSimple === 'function' ? tkSimple(r) : {};
    out[k].push({ kind: 'client', id: String(r.id), name: String(sp.company || r.name || r.id), sub: String(sp.person || r.contactName || '') });
  });
  stgBookings(bookings).forEach((q) => {
    if (!q || !q.id) return; const k = stageOfBooking(q); if (!k) return;
    out[k].push({ kind: 'booking', id: String(q.id), name: String(q.company || q.name || q.id), sub: String(q.name && q.company ? q.name : q.email || '') });
  });
  return out;
}
function stageCounts(hub, bookings) {
  const p = stagePeople(hub, bookings); const c = {}; STG_STAGES.forEach(([k]) => { c[k] = p[k].length; }); return c;
}
function renderStageStrip(hub, bookings) {
  const c = stageCounts(hub, bookings);
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s));
  return `<div class="stg-strip" role="group" aria-label="Where everyone is">${STG_STAGES.map(([k, label]) => {
    const n = c[k];
    return `<button type="button" class="stg-tile${n ? '' : ' zero'}" data-stage="${e(k)}" onclick="openStage('${e(k)}')" aria-label="${e(label)}: ${n}"><b>${n}</b><span>${e(label)}</span></button>`;
  }).join('')}</div>`;
}
function renderStageList(key, hub, bookings) {
  const st = STG_STAGES.find((x) => x[0] === key); if (!st) return '';
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s));
  const list = stagePeople(hub, bookings)[key];
  const a = (v) => e(JSON.stringify(String(v)));
  const body = list.length
    ? `<ul class="stg-list">${list.map((p) => `<li><button type="button" class="stg-row" onclick="stageGo(${a(p.kind)},${a(p.id)})"><b>${e(p.name)}</b>${p.sub ? `<span>${e(p.sub)}</span>` : ''}<em>${p.kind === 'booking' ? 'Booking' : 'Client'}</em></button></li>`).join('')}</ul>`
    : `<div class="stg-empty"><b>Nobody here</b><span>People appear here as they reach this stage.</span></div>`;
  return `<div class="stg-panel"><div class="stg-head"><h3>${e(st[1])} <small>${list.length}</small></h3><button type="button" class="btn ghost" onclick="closeModal()">Close</button></div>${body}</div>`;
}
function openStage(key) {
  const hub = typeof tk !== 'undefined' ? tk.hub : null;
  if (typeof openModal === 'function') openModal(renderStageList(key, hub));
}
function stageGo(kind, id) {
  if (typeof closeModal === 'function') closeModal();
  if (kind === 'booking') { if (typeof openInquiry === 'function') openInquiry(id); }
  else if (typeof openTrial === 'function') openTrial(id);
}
