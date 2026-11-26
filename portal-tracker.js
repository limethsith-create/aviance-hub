/* ===================== AVIANCE — the client's journey tracker =====================
   portal.html only. Draws the six steps from payment to launch into #pcTracker,
   from rpc portal_journey (the same shape as journey_get, for the signed-in
   client only). Compact and horizontal on a wide screen; on a phone it folds to
   one line ("Step 3 of 6 · Market testing") with a button to see every step.

   Rules kept from portal-client.js: data comes through ctx.rpc, which returns
   {ok, data, error} and never throws; every value goes through pcEsc; the
   render function is pure (data in, HTML out). Its own small stylesheet is
   added once, so portal-client.css stays as it is. Prefix: pct.
   ======================================================================= */

const PCT_ASK_MS = 30000;
const PCT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pct = { open: false, drawn: '', at: 0, data: null, busy: false, who: '' };

function pctEsc(s){
  if (typeof pcEsc === 'function') return pcEsc(s);
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pctDay(v){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function pctKey(d){ return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) }
/* "Nov 26", in the reader's own style where the browser knows it. */
function pctDate(v){
  const d = pctDay(v);
  if (!d) return '';
  try {
    const s = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (s && !/invalid/i.test(s)) return s;
  } catch (e) { /* fall through */ }
  return PCT_MON[d.getMonth()] + ' ' + d.getDate();
}

/* portal_journey's answer -> what is drawn. Never throws. */
function pctNorm(j, now){
  const x = j && typeof j === 'object' ? j : {};
  const today = pctKey(now instanceof Date ? now : new Date());
  const steps = (Array.isArray(x.steps) ? x.steps : []).filter(Boolean).slice()
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    .map(s => {
      const status = s.status === 'done' || s.status === 'doing' ? s.status : 'todo';
      const planned = pctDay(s.planned_on) ? String(s.planned_on).slice(0, 10) : '';
      const late = status !== 'done' && (typeof s.late === 'boolean' ? s.late : !!planned && planned < today);
      return { step: String(s.step || ''), title: String(s.title || s.step || 'Step'), planned, status, late };
    });
  const nextKey = String(x.next_step || '') || ((steps.find(s => s.status !== 'done') || {}).step || '');
  const idx = steps.findIndex(s => s.step === nextKey);
  const launch = pctDay(x.launch_on) ? String(x.launch_on).slice(0, 10) : ((steps.find(s => s.step === 'launch') || {}).planned || '');
  let days = x.days_to_launch != null && isFinite(Number(x.days_to_launch)) ? Math.round(Number(x.days_to_launch)) : null;
  if (days == null && launch) days = Math.round((pctDay(launch) - pctDay(today)) / 86400000);
  const done = steps.filter(s => s.status === 'done').length;
  return { steps, nextIndex: idx, days, launch, done, live: steps.length > 0 && done === steps.length };
}

function pctCountdown(n){
  if (n.live) return { big: 'Live', small: 'month one is running' };
  if (n.days == null) return { big: '', small: '' };
  if (n.days > 1) return { big: String(n.days), small: 'days to launch' };
  if (n.days === 1) return { big: '1', small: 'day to launch' };
  if (n.days === 0) return { big: 'Today', small: 'launch day' };
  return { big: 'Soon', small: 'launch is being rescheduled' };
}

/* The tracker. Pure. j = portal_journey's answer; opts = {open, now}. '' when there is nothing to show. */
function pctRender(j, opts){
  const o = opts || {};
  const n = pctNorm(j, o.now);
  if (!n.steps.length) return '';
  const next = n.nextIndex >= 0 ? n.steps[n.nextIndex] : null;
  const c = pctCountdown(n);
  const line = n.live ? 'All six steps done'
    : next ? 'Step ' + (n.nextIndex + 1) + ' of ' + n.steps.length + ' · ' + next.title : '';
  const items = n.steps.map((s, i) => {
    const isNext = i === n.nextIndex && !n.live;
    const cls = s.status === 'done' ? 'done' : s.late ? 'late' : isNext ? 'next' : s.status === 'doing' ? 'next' : 'todo';
    const word = s.status === 'done' ? 'Done' : s.late ? 'Running late' : isNext ? 'Up next' : s.status === 'doing' ? 'In progress' : 'Coming up';
    return '<li class="pct-step pct-' + cls + '"' + (isNext ? ' aria-current="step"' : '') + '>' +
      '<span class="pct-mark" aria-hidden="true">' + (s.status === 'done' ? '✓' : isNext ? '●' : String(i + 1)) + '</span>' +
      '<span class="pct-t">' + pctEsc(s.title) + '</span>' +
      '<span class="pct-d">' + pctEsc(s.late ? 'Late · ' + pctDate(s.planned) : pctDate(s.planned)) + '</span>' +
      '<span class="pct-sr">' + pctEsc(word) + '</span>' +
    '</li>';
  }).join('');
  const pctDone = Math.round(n.done / n.steps.length * 100);
  return '<section class="pct' + (o.open ? ' pct-open' : '') + (n.live ? ' pct-live' : '') + '" aria-label="Your launch plan">' +
    '<div class="pct-in">' +
      '<div class="pct-top">' +
        '<div class="pct-head">' +
          '<p class="pc-tag pct-kicker">Your launch plan' + (n.launch ? '<span class="pct-kd"> · ' + pctEsc(pctDate(n.launch)) + '</span>' : '') + '</p>' +
          '<p class="pct-line">' + pctEsc(line) + '</p>' +
        '</div>' +
        (c.big ? '<p class="pct-count" aria-label="' + pctEsc(c.big + ' ' + c.small) + '"><b>' + pctEsc(c.big) + '</b><span>' + pctEsc(c.small) + '</span></p>' : '') +
        '<button type="button" class="pct-toggle" data-pc-act="trackerToggle" aria-expanded="' + (o.open ? 'true' : 'false') + '" aria-controls="pctSteps">' +
          (o.open ? 'Hide steps' : 'All steps') + '</button>' +
      '</div>' +
      '<div class="pct-bar" aria-hidden="true"><span style="width:' + pctDone + '%"></span></div>' +
      '<ol class="pct-steps" id="pctSteps">' + items + '</ol>' +
    '</div>' +
  '</section>';
}

const PCT_CSS = `
.pct-box,.pc-tracker-box{flex:0 0 auto}
.pct{border-bottom:1px solid var(--pc-line,#E4E4E4);background:#fff}
.pct-in{max-width:820px;margin:0 auto;padding:14px 24px 16px}
.pct-top{display:flex;align-items:center;gap:16px}
.pct-head{flex:1 1 auto;min-width:0}
.pct-kicker{font-size:11px;margin:0}
.pct-line{font-size:17px;line-height:1.3;font-weight:800;letter-spacing:-.02em;margin:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pct-count{display:flex;align-items:baseline;gap:8px;margin:0;flex:0 0 auto}
.pct-count b{font-size:34px;line-height:1;font-weight:800;letter-spacing:-.04em;color:var(--pc-red,#E0290F);font-variant-numeric:tabular-nums}
.pct-count span{font-family:var(--pc-mono,monospace);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--pc-grey,#5C5C5C);max-width:7.5em;line-height:1.3}
.pct-live .pct-count b{color:#000}
.pct-toggle{display:none;min-height:44px;padding:0 14px;border:2px solid #000;border-radius:0;background:#fff;color:#000;font:400 11px var(--pc-mono,monospace);letter-spacing:.14em;text-transform:uppercase;cursor:pointer;flex:0 0 auto}
.pct-toggle:hover{background:#000;color:#fff}
.pct-bar{height:3px;background:var(--pc-line,#E4E4E4);margin:14px 0 0}
.pct-bar span{display:block;height:100%;background:#000}
.pct-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr))}
.pct-step{position:relative;display:flex;flex-direction:column;gap:2px;padding:12px 10px 0 0;min-width:0;border-top:3px solid transparent;margin-top:-3px}
.pct-done{border-top-color:#000}
.pct-next{border-top-color:var(--pc-red,#E0290F)}
.pct-late{border-top-color:var(--pc-red,#E0290F)}
.pct-mark{display:inline-grid;place-items:center;width:24px;height:24px;margin-bottom:6px;border:2px solid #000;font:700 12px/1 var(--pc-mono,monospace);color:#000;background:#fff}
.pct-done .pct-mark{background:#000;color:#fff}
.pct-next .pct-mark{background:var(--pc-red,#E0290F);border-color:var(--pc-red,#E0290F);color:#fff;font-size:10px}
.pct-late .pct-mark{border-color:var(--pc-red,#E0290F);color:var(--pc-red,#E0290F)}
.pct-todo .pct-mark{border-color:var(--pc-line,#E4E4E4);color:var(--pc-grey,#5C5C5C)}
.pct-t{font-size:14px;line-height:1.25;font-weight:700;letter-spacing:-.01em;overflow-wrap:break-word}
.pct-todo .pct-t{color:var(--pc-grey,#5C5C5C);font-weight:600}
.pct-d{font-family:var(--pc-mono,monospace);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--pc-grey,#5C5C5C)}
.pct-late .pct-d{color:var(--pc-red,#E0290F);font-weight:700}
.pct-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:640px){
  .pct-in{padding:10px 14px 12px}
  .pct-top{gap:12px}
  .pct-line{font-size:15px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .pct-kd{display:none}
  .pct-toggle{padding:0 10px}
  .pct-count{flex-direction:column;align-items:flex-end;gap:0}
  .pct-count b{font-size:26px}
  .pct-count span{font-size:9px;text-align:right}
  .pct-toggle{display:inline-block}
  .pct-bar{margin-top:10px}
  .pct-steps{display:none}
  .pct-open .pct-steps{display:block;margin-top:6px}
  .pct-open .pct-step{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:0 8px;padding:9px 0;margin:0;border-top:1px solid var(--pc-line,#E4E4E4)}
  .pct-open .pct-step:first-child{border-top:0}
  .pct-open .pct-mark{margin:0}
  .pct-open .pct-d{text-align:right}
}`;
function pctStyle(){
  if (typeof document === 'undefined' || !document.getElementById || document.getElementById('pctCss')) return;
  try {
    const s = document.createElement('style');
    s.id = 'pctCss';
    s.textContent = PCT_CSS;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* a page without a head: unstyled but working */ }
}

function pctPaint(el){
  if (!el) return;
  const html = pctRender(pct.data, { open: pct.open });
  if (html === pct.drawn) return;   /* nothing changed: no flicker on every refresh */
  pct.drawn = html;
  el.innerHTML = html;
}

/* Called when the chat opens and after every refresh; asks again at most every 30s. */
async function pctMount(ctx){
  const el = typeof document !== 'undefined' && document.getElementById ? document.getElementById('pcTracker') : null;
  if (!el || !ctx || typeof ctx.rpc !== 'function') return;
  pctStyle();
  /* A different client signing in on the same browser must not be shown the last client's launch plan,
     not even for the moment before theirs loads. */
  const h = ctx.home || {};
  const who = String((h.person && h.person.id) || '') + '|' + String((h.channel && h.channel.id) || '');
  if (who !== pct.who) { pct.who = who; pct.data = null; pct.at = 0; pct.drawn = ''; pct.open = false; el.innerHTML = ''; }
  if (!el.firstChild) pct.drawn = '';   /* the chat was drawn again from scratch */
  if (pct.data) pctPaint(el);
  if (pct.busy || (pct.at && Date.now() - pct.at < PCT_ASK_MS)) return;
  pct.busy = true;
  let r;
  try { r = await ctx.rpc('portal_journey', {}); } catch (e) { r = { ok: false }; }
  pct.busy = false;
  if (who !== pct.who) return;          /* someone else signed in while this was on its way */
  pct.at = Date.now();
  if (r && r.ok) pct.data = r.data || null;
  pctPaint(document.getElementById('pcTracker') || el);
}

if (typeof window !== 'undefined') {
  const P = window.PC || (window.PC = { cards: {}, actions: {}, mounts: [] });
  P.mounts = P.mounts || []; P.actions = P.actions || {};
  P.mounts.push(pctMount);
  P.actions.trackerToggle = function(el){
    pct.open = !pct.open;
    const box = typeof document !== 'undefined' && document.getElementById ? document.getElementById('pcTracker') : null;
    pctPaint(box);
    const b = box && box.querySelector ? box.querySelector('.pct-toggle') : null;
    if (b && b.focus) b.focus();
  };
}
