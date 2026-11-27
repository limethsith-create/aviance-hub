/* ===================== AVIANCE — portal: picking a call time =====================
   Loaded by portal.html after portal-client.js. Draws two journey cards inside
   the client's channel and handles one click:

     PC.cards.offer(item)   -> three big buttons, one per offered time (the
                               client's own time, with ET beside it). Disabled
                               once the call is booked or the times have gone.
     PC.cards.system(item)  -> a "Join the call" button under the message that
                               carries a meeting link. Nothing for other system
                               messages (approvals, forms).
     PC.actions.pick(el,ctx)-> rpc portal_offer_pick(p_offer, p_index) and refresh.

   Rules this file keeps (same as portal-client.js):
     - Every piece of text from the database goes through pcEsc; a link only
       becomes an href through pcSafeUrl.
     - Renders are pure: psOfferHtml / psSystemHtml take the message (and the
       viewer's zone and "now") and return HTML. The only state is psUi, the
       per-offer busy / error / just-booked marks between a click and a refresh.
     - Nothing here throws; the rpc answers {ok, data, error}.
   Option numbers are 1-based, matching "just reply 1, 2 or 3".
   Contract: rpc portal_offer_pick; message meta written by offer_times / the
   booking ({offer_id, kind, options:[{starts_at, minutes}], zone, status, picked})
   and by the Meet-link trigger ({meeting_id, url, starts_at}).
   ======================================================================= */

const PS_ET = 'America/New_York';
const PS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PS_LINK_HOURS = 3;            /* a Join button stays this long after the start */
const psUi = {};                    /* offer id -> {busy, error, picked} */

/* ---- pure helpers -------------------------------------------------- */

/* meta.options -> [{i:1, iso, minutes, main:'Thu, Nov 26 · 9:00 AM', et:'12:00 PM ET', past}] */
function psOptions(meta, viewerZone, now){
  const vz = viewerZone || pcViewerZone();
  const n = pcToDate(now) || new Date();
  const same = pcZoneAbbr(vz) === pcZoneAbbr(PS_ET);
  const list = meta && Array.isArray(meta.options) ? meta.options : [];
  const out = [];
  list.slice(0, 3).forEach((o, k) => {
    const d = o && pcToDate(o.starts_at);
    if (!d) return;
    const w = pcWhenParts(d, vz);
    if (!w) return;
    const e = same ? null : pcWhenParts(d, PS_ET);
    out.push({
      i: k + 1, iso: d.toISOString(), minutes: Number(o.minutes) || 0,
      main: w.day + ' · ' + w.time + (same ? ' ' + pcZoneAbbr(vz) : ''),
      et: e ? (e.key === w.key ? '' : e.day + ' · ') + e.time + ' ET' : '',
      past: d <= n,
    });
  });
  return out;
}

/* 'booked' | 'expired' | 'open' — what the card should look like. */
function psOfferState(meta, ui, opts){
  if ((ui && ui.picked) || (meta && meta.status === 'booked')) return 'booked';
  if (meta && meta.status === 'expired') return 'expired';
  if (!opts.length || opts.every((o) => o.past)) return 'expired';
  return 'open';
}

function psOfferHtml(item, viewerZone, now){
  const meta = item && item.meta;
  const id = meta && PS_UUID.test(String(meta.offer_id || '')) ? String(meta.offer_id) : '';
  if (!id) return '';
  const opts = psOptions(meta, viewerZone, now);
  const ui = psUi[id] || {};
  const state = psOfferState(meta, ui, opts);
  const picked = Number(ui.picked || meta.picked) || 0;
  const what = meta.kind === 'onboarding' ? 'launch call' : 'kickoff';
  const mins = opts.length && opts[0].minutes ? ' · ' + opts[0].minutes + ' min' : '';
  const head = state === 'booked' ? 'Booked' : state === 'expired' ? 'These times have gone' : 'Pick a time';
  const btns = opts.map((o) => {
    const mine = state === 'booked' && o.i === picked;
    const off = state !== 'open' || o.past || ui.busy;
    return `<button type="button" class="ps-opt${mine ? ' ps-opt-on' : ''}" data-pc-act="pick" data-offer="${pcEsc(id)}" data-i="${o.i}"${off ? ' disabled' : ''} aria-pressed="${mine ? 'true' : 'false'}">
      <span class="ps-n">${mine ? '✓' : o.i}</span>
      <span class="ps-t"><strong>${pcEsc(o.main)}</strong>${o.et ? `<span class="ps-et">${pcEsc(o.et)}</span>` : ''}</span>
      ${mine ? '<span class="ps-tag">Booked</span>' : ''}
    </button>`;
  }).join('');
  const note = state === 'expired' ? '<p class="ps-note">We’ll send new times. Or message us below.</p>'
    : state === 'open' ? '<p class="ps-note">Tap one, or reply 1, 2 or 3. Times are in your time.</p>' : '';
  return `<div class="ps-card" role="group" aria-label="${pcEsc('Times for your ' + what)}">
    <p class="ps-head"><span class="pc-tag${state === 'open' ? ' pc-red' : ''}">${pcEsc(head)}</span><span class="pc-tag">${pcEsc(what + mins)}</span></p>
    <div class="ps-opts">${btns}</div>${note}
    <p class="ps-err" role="alert" aria-live="assertive">${pcEsc(ui.error || '')}</p>
  </div>`;
}

/* A system message with a meeting link -> a Join button. Anything else -> ''. */
function psSystemHtml(item, viewerZone, now){
  const meta = item && item.meta;
  const url = meta ? pcSafeUrl(meta.url) : '';
  if (!url || !meta.meeting_id) return '';
  const at = pcToDate(meta.starts_at);
  const n = pcToDate(now) || new Date();
  if (at && n - at > PS_LINK_HOURS * 3600000) return '';
  const when = at ? pcWhen(at, viewerZone || pcViewerZone()) : '';
  return `<div class="ps-join">
    <a class="pc-btn ps-join-btn" href="${pcEsc(url)}" target="_blank" rel="noopener noreferrer">Join the call</a>
    ${when ? `<span class="pc-tag">${pcEsc(when)}</span>` : ''}
  </div>`;
}

/* ---- the click ------------------------------------------------------ */

/* A booking that never answers used to leave the tapped button showing "…" and
   psUi[offer].busy true for ever: the client could not pick that time, could
   not pick another, and was told nothing. Past this limit the ask counts as no
   answer. It is deliberately long — this is a write, so waiting is better than
   worrying them — and it is never retried, because a repeated booking is a
   second call in the diary. A test may shorten it with psOpts.pickMs. */
const PS_PICK_MS = 25000;
const psOpts = { pickMs: 0 };
const PS_NO_ANSWER = { psNoAnswer: true };
function psCapped(work, ms){
  const limit = Number(ms || psOpts.pickMs) > 0 ? Number(ms || psOpts.pickMs) : PS_PICK_MS;
  if (typeof setTimeout !== 'function') return Promise.resolve(work);
  return new Promise((done, no) => {
    let over = false;
    const end = (fn) => (v) => { if (!over) { over = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(end(done), limit, PS_NO_ANSWER);
    try { Promise.resolve(work).then(end(done), end(no)); }
    catch (e) { end(no)(e); }
  });
}

function psCardEl(el){ return el && el.closest ? el.closest('.ps-card') : null; }
function psMark(card, offer, label){
  if (!card || !card.querySelectorAll) return;
  card.querySelectorAll('[data-pc-act="pick"]').forEach((b) => {
    b.disabled = !!(psUi[offer] && (psUi[offer].busy || psUi[offer].picked));
    if (label && b.getAttribute('data-i') === label.i) { const t = b.querySelector('.ps-n'); if (t) t.textContent = label.text; }
  });
  const err = card.querySelector('.ps-err');
  if (err) err.textContent = (psUi[offer] && psUi[offer].error) || '';
}

async function psPick(el, ctx){
  const offer = el && el.getAttribute ? String(el.getAttribute('data-offer') || '') : '';
  const i = el && el.getAttribute ? parseInt(el.getAttribute('data-i'), 10) : NaN;
  if (!PS_UUID.test(offer) || !(i >= 1 && i <= 3)) return { ok: false, data: null, error: 'Pick one of the times.' };
  const ui = psUi[offer] = psUi[offer] || {};
  if (ui.busy || ui.picked) return { ok: false, data: null, error: '' };
  ui.busy = true; ui.error = '';
  const card = psCardEl(el);
  psMark(card, offer, { i: String(i), text: '…' });
  let r, quiet = false;
  try { r = await psCapped(ctx.rpc('portal_offer_pick', { p_offer: offer, p_index: i })); }
  catch (e) { r = { ok: false, data: null, error: 'Something went wrong. Please try again.' }; }
  if (r === PS_NO_ANSWER) {
    /* It may have booked and it may not. The one thing we must not do is guess,
       and the one thing we must not do twice is send the booking again — that
       is a second call in their diary. So the card says exactly what we know,
       and the refresh below brings the answer back from the database. */
    quiet = true;
    r = { ok: false, data: null, error: 'We did not hear back from Aviance. Refresh the page to see whether it booked before you tap again.' };
  }
  if (!r || typeof r !== 'object') r = { ok: false, data: null, error: 'No answer from Aviance.' };
  ui.busy = false;
  if (!r.ok) {
    ui.error = quiet ? r.error : 'That did not book. ' + (r.error || 'Please try again.');
    psMark(card, offer, { i: String(i), text: String(i) });
  } else {
    ui.picked = i;
    psMark(card, offer, { i: String(i), text: '✓' });
  }
  try { if (ctx && typeof ctx.refresh === 'function') ctx.refresh(); } catch (e) { /* the next poll will catch up */ }
  return r;
}

/* ---- look (prefix ps; same tokens as portal-client.css) ------------- */

const PS_CSS = `
.ps-card{margin-top:8px;padding:12px;border:1px solid #000;background:#fff;max-width:520px}
.ps-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:0 0 10px}
.ps-head .pc-tag{font-size:11px}
.ps-opts{display:flex;flex-direction:column;gap:8px}
.ps-opt{display:flex;align-items:center;gap:12px;width:100%;min-height:56px;padding:10px 12px;border:2px solid #000;border-radius:0;background:#fff;color:#000;font:600 16px/1.25 var(--pc-sans);text-align:left;cursor:pointer;-webkit-appearance:none;appearance:none}
.ps-opt:hover:not([disabled]){background:#000;color:#fff}
.ps-opt:hover:not([disabled]) .ps-et{color:#ddd}
.ps-opt[disabled]{cursor:default;opacity:.5}
.ps-opt.ps-opt-on{opacity:1;background:#000;color:#fff;border-color:#000}
.ps-opt.ps-opt-on .ps-et{color:#ddd}
.ps-n{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid currentColor;font:400 14px var(--pc-mono)}
.ps-t{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow-wrap:anywhere}
.ps-t strong{font-weight:800}
.ps-et{font:400 12px/1.4 var(--pc-mono);letter-spacing:.04em;color:var(--pc-grey)}
.ps-tag{flex:0 0 auto;font:400 11px var(--pc-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--pc-red)}
.ps-note{margin:8px 0 0;font-size:14px;color:var(--pc-grey)}
.ps-err{margin:0;color:var(--pc-red);font-size:14px}
.ps-err:not(:empty){margin-top:8px}
.ps-join{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px}
.ps-join-btn{min-height:44px;padding:10px 20px}
@media (max-width:480px){.ps-card{padding:10px}.ps-opt{font-size:15px;gap:10px}.ps-join-btn{width:100%}}
`;
function psStyle(doc){
  if (!doc || !doc.head || doc.getElementById('psStyle')) return;
  const s = doc.createElement('style');
  s.id = 'psStyle';
  s.textContent = PS_CSS;
  doc.head.appendChild(s);
}

/* ---- hook in -------------------------------------------------------- */

if (typeof PC !== 'undefined' && PC) {
  PC.cards = PC.cards || {};
  PC.actions = PC.actions || {};
  PC.cards.offer = function(item){ return psOfferHtml(item); };
  const prevSystem = PC.cards.system;
  PC.cards.system = function(item, home){
    const mine = psSystemHtml(item);
    if (mine) return mine;
    return typeof prevSystem === 'function' ? prevSystem(item, home) : '';
  };
  PC.actions.pick = psPick;
}
if (typeof document !== 'undefined') { try { psStyle(document); } catch (e) { /* no styles, still works */ } }
