/* ===================== AVIANCE OS — Money (money.js) =====================
   The two sides of the money, on one screen, because they are the two
   questions the owner actually asks at 2am:

     1. WHO OWES US, AND FOR HOW LONG.  Every unpaid invoice, aged. Before this
        screen a late invoice did nothing at all: `invoices.status` has
        'overdue' in its CHECK constraint and nothing in the database ever
        writes it (checked live 2026-11-27 — every unpaid invoice is 'draft' or
        'sent'), there is no dunning job, and the only sign of lateness was a
        "· 10 days late" fragment at the end of one line on Invoices. Nobody
        could see the TOTAL owed, how old the oldest was, or that ten invoices
        had been raised and never sent to anybody.

     2. WHAT WE OWE THEM, AND WHETHER IT WENT.  lock_month() writes a `refunds`
        row at status 'owed' and stops. `fnMarkRefundPaid` has existed since the
        money was built and until today was called by NOTHING. Four live rows
        had sat at 'owed' since the day the guarantee raised them. The guarantee
        is the product; the part where the client gets their money back cannot
        be a row nobody can close.

   And a third block that is not a question but an alarm: does it add up —
   a client we are promising back more than they ever paid, a locked month whose
   refund row never got written, and a 3-month term whose next term nobody has
   decided about.

   NO MONEY RULE LIVES HERE. Every figure comes from the database through
   finance.js (fnOwed, fnRefundsForScreen, fnMoneyBack, fnMarkRefundPaid).
   This file reads, sorts and draws. Data functions return
   {ok,data,error} and never throw; render functions are pure.

   Loaded after finance.js. Every global is prefixed `mo`, except viewMoney,
   which index.html mounts.
   ========================================================================= */

/* ---- plumbing (the house shape, from core.js) --------------------- */
const moOk = coreOk;
const moErr = coreErr;
const moEsc = coreEsc;
const moAttr = coreAttr;
const moUsd = coreUsd;
const moNum = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 };

const MO_NOT_LOADED = 'The money side of Aviance OS did not load. Reload the page, and if it keeps happening tell whoever looks after it.';

const mo = {owed: null, refunds: null, back: null, gaps: null, err: '', loading: false, seq: 0, payErr: ''};

function moHas(name){ return typeof globalThis[name] === 'function' }

/* ---- reading ------------------------------------------------------ */

async function moLoad(){
  mo.err = ''; mo.loading = true;
  const seq = ++mo.seq;
  if (!moHas('fnOwed') || !moHas('fnRefundsForScreen')) {
    mo.loading = false; mo.err = MO_NOT_LOADED; return moErr(MO_NOT_LOADED);
  }
  const [owed, refunds, back, months] = await Promise.all([
    fnOwed(), fnRefundsForScreen(), moHas('fnMoneyBack') ? fnMoneyBack() : moOk({rows: [], over: []}),
    moHas('fnStanding') ? fnStanding() : moOk([]),
  ]);
  if (seq !== mo.seq) return moOk(null);
  mo.loading = false;
  mo.owed = owed.ok ? owed.data : null;
  mo.refunds = refunds.ok ? refunds.data : null;
  mo.back = back.ok ? back.data : null;
  mo.gaps = (months.ok && refunds.ok && moHas('fnRefundGaps'))
    ? fnRefundGaps(months.data || [], (refunds.data && refunds.data.rows) || []) : [];
  const bad = [owed.ok ? '' : owed.error, refunds.ok ? '' : refunds.error].filter(Boolean);
  mo.err = bad.join(' ');
  return mo.err ? moErr(mo.err) : moOk(true);
}

/* ---- the badge the sidebar shows ---------------------------------- */

/* How many things on this screen need the owner: every late invoice, every
   invoice raised and never sent, and every refund still owed. '' when nothing
   does, because a grey zero in the sidebar is noise. */
function moNavCount(){
  const o = mo.owed, r = mo.refunds;
  if (!o && !r) return '';
  const late = o ? moNum(o.lateCount) : 0;
  const unsent = o ? (o.bands || []).reduce((s, b) => s + b.rows.filter(x => x.unsent).length, 0) : 0;
  const refunds = r ? (r.owed || []).length : 0;
  const n = late + unsent + refunds;
  return n ? String(n) : '';
}

/* ---- render: who owes us ------------------------------------------ */

function moTotalsHtml(o){
  const tiles = [
    ['Owed to us', moUsd(o.total), (o.count || 0) + ' unpaid ' + ((o.count === 1) ? 'invoice' : 'invoices')],
    ['Late', moUsd(o.lateTotal), o.lateCount ? o.lateCount + ' past its due date' : 'nothing past due'],
    ['Oldest', o.oldest ? o.oldest + (o.oldest === 1 ? ' day' : ' days') : '—', o.oldest ? 'late' : 'nothing late'],
    ['Never sent', moUsd(o.unsentTotal), o.unsentTotal ? 'raised, but nobody has been asked' : 'all of them went out'],
  ];
  return `<div class="mo-tiles">${tiles.map(t => `<div class="mo-tile"><p class="mo-tile-t">${moEsc(t[0])}</p>
    <p class="mo-tile-n fig">${moEsc(t[1])}</p><p class="mo-tile-s">${moEsc(t[2])}</p></div>`).join('')}</div>`;
}

function moOwedRowHtml(r){
  const btns = [];
  if (r.unsent && moHas('fnMarkInvoiceSent')) btns.push(`<button type="button" class="btn" onclick="moSendGo(${moAttr(r.id)})">Mark sent</button>`);
  if (moHas('fnMarkInvoicePaid')) btns.push(`<button type="button" class="btn ghost" onclick="moPaidGo(${moAttr(r.id)})">Mark paid</button>`);
  /* Money arrives in pieces more often than anyone plans for. "Part paid" is
     not a status, it is a number: how much has come in. The invoice settles
     itself the moment that number reaches the total. */
  if (moHas('fnRecordPayment')) btns.push(`<button type="button" class="btn ghost" onclick="moPartGo(${moAttr(r.id)})">Part paid…</button>`);
  const part = moHas('fnPartPaidWords') ? fnPartPaidWords(r) : '';
  const late = r.daysLate;
  const word = r.unsent ? 'never sent'
    : late == null ? 'no due date'
    : late > 0 ? late + (late === 1 ? ' day late' : ' days late')
    : late === 0 ? 'due today' : 'due in ' + (-late) + (late === -1 ? ' day' : ' days');
  return `<li class="mo-row">
    <span class="mo-who"><b>${moEsc(r.company || 'A client')}</b><span class="mo-sub">${moEsc(r.number || '')}</span></span>
    <span class="mo-amt fig">${moEsc(moUsd(r.amount))}${part ? `<span class="mo-sub">${moEsc(part)}</span>` : ''}</span>
    <span class="mo-when">${moEsc(word)}${r.due_on ? `<span class="mo-sub">due ${moEsc(String(r.due_on).slice(0,10))}</span>` : ''}</span>
    <span class="mo-acts">${btns.join('')}</span></li>`;
}

function moOwedHtml(){
  if (!mo.owed) return mo.loading ? `<p class="muted">Reading the invoices…</p>` : `<p class="muted">The invoices could not be read.</p>`;
  const o = mo.owed;
  if (!o.bands.length) return `${moTotalsHtml(o)}<p class="muted">Nothing is owed to us. Every invoice raised has been paid.</p>`;
  return moTotalsHtml(o) + o.bands.map(b => `<div class="mo-band mo-${moEsc(b.tone)}">
    <div class="mo-band-head"><h4>${moEsc(b.label)}</h4><span class="fig">${moEsc(moUsd(b.total))}</span><span class="count">${b.rows.length}</span></div>
    <ul class="mo-list">${b.rows.map(moOwedRowHtml).join('')}</ul></div>`).join('');
}

/* ---- render: what we owe them ------------------------------------- */

function moRefundRowHtml(r){
  const state = r.state || 'owed';
  const pill = state === 'paid' ? 'green' : state === 'waived' ? 'grey' : 'red';
  const owedNow = moNum(r.still_owed);
  const btn = owedNow > 0 && moHas('fnMarkRefundPaid')
    ? `<button type="button" class="btn" onclick="moOpenPay(${moAttr(r.id)})">Record the payment</button>` : '';
  return `<li class="mo-row mo-refund">
    <span class="mo-who"><b>${moEsc(r.company || 'A client')}</b><span class="mo-sub">${moEsc(r.month_no == null ? '' : 'Month ' + r.month_no)}${r.client_ended_on ? ' · they have left' : ''}</span></span>
    <span class="mo-amt fig">${moEsc(moUsd(r.amount))}</span>
    <span class="mo-when"><span class="pill ${pill}">${moEsc((typeof FN_REFUND_WORDS === 'object' && FN_REFUND_WORDS[state]) || 'Owed')}</span>
      <span class="mo-sub">${moEsc(moHas('fnRefundLine') ? fnRefundLine(r) : '')}</span>${
        /* a part payment noted on a row that is still owed, or a payment recorded
           before the database could hold its reference (see fnMarkRefundPaid):
           the notes are the only place that fact lives, so they are shown here */
        (state === 'owed' || (state === 'paid' && !r.paid_reference)) && String(r.notes || '').trim() ? `<span class="mo-sub">${moEsc(String(r.notes).trim())}</span>` : ''}</span>
    <span class="mo-acts">${btn}</span></li>`;
}

function moRefundsHtml(){
  if (!mo.refunds) return mo.loading ? `<p class="muted">Reading the refunds…</p>` : `<p class="muted">The refunds could not be read.</p>`;
  const d = mo.refunds;
  const owed = d.owed || [], all = d.rows || [];
  const done = all.filter(r => owed.indexOf(r) < 0);
  if (!all.length) return `<p class="muted">Nothing has been refunded and nothing is owed. A refund appears here the moment a short month is locked.</p>`;
  return `<div class="mo-tiles">
      <div class="mo-tile"><p class="mo-tile-t">We owe</p><p class="mo-tile-n fig">${moEsc(moUsd(d.owedTotal))}</p>
        <p class="mo-tile-s">${moEsc(owed.length + (owed.length === 1 ? ' refund not sent' : ' refunds not sent'))}</p></div>
      <div class="mo-tile"><p class="mo-tile-t">Sent back</p><p class="mo-tile-n fig">${moEsc(moUsd(d.paidTotal))}</p>
        <p class="mo-tile-s">all time</p></div>
      ${(d.gone || []).length ? `<div class="mo-tile mo-red"><p class="mo-tile-t">Owed to clients who have left</p>
        <p class="mo-tile-n fig">${moEsc(String(d.gone.length))}</p><p class="mo-tile-s">they are off every live list</p></div>` : ''}
    </div>
    ${owed.length ? `<div class="mo-band mo-red"><div class="mo-band-head"><h4>Not sent yet</h4><span class="fig">${moEsc(moUsd(d.owedTotal))}</span><span class="count">${owed.length}</span></div>
      <ul class="mo-list">${owed.map(moRefundRowHtml).join('')}</ul></div>` : `<p class="muted">Every refund the guarantee has raised has been sent.</p>`}
    ${done.length ? `<div class="mo-band mo-grey"><div class="mo-band-head"><h4>Settled</h4><span class="count">${done.length}</span></div>
      <ul class="mo-list">${done.map(moRefundRowHtml).join('')}</ul></div>` : ''}`;
}

/* ---- render: does it add up --------------------------------------- */

/* The arithmetic that nothing checked. A prepaid 3-month term can honestly
   promise back more than it ever took in: twice the month in month one plus the
   month in full in each of months two and three is four months against the
   three that were paid. The guarantee is settled and is not changed here — this
   only says, per client, the day it happens. */
function moAddUpHtml(){
  const over = (mo.back && mo.back.over) || [];
  const gaps = mo.gaps || [];
  if (!over.length && !gaps.length) return `<p class="muted">Every refund we owe is inside what that client has paid us, and every locked month that owes a refund has one.</p>`;
  return `${over.length ? `<div class="mo-band mo-red"><div class="mo-band-head"><h4>We are promising back more than they paid</h4><span class="count">${over.length}</span></div>
      <ul class="mo-list">${over.map(r => `<li class="mo-row"><span class="mo-who"><b>${moEsc(r.company || 'A client')}</b>
        <span class="mo-sub">${moEsc((r.plan || '') + (r.term === '3month' ? ' · 3-month term' : ''))}</span></span>
        <span class="mo-amt fig">${moEsc(moUsd(r.paidIn))} in</span>
        <span class="mo-when"><b class="fig">${moEsc(moUsd(r.refundsTotal))}</b> back<span class="mo-sub">${moEsc(moUsd(r.overBy))} more than they ever paid</span></span>
        <span class="mo-acts"></span></li>`).join('')}</ul></div>` : ''}
    ${gaps.length ? `<div class="mo-band mo-amber"><div class="mo-band-head"><h4>A locked month that owes a refund, with no refund row</h4><span class="count">${gaps.length}</span></div>
      <ul class="mo-list">${gaps.map(g => `<li class="mo-row"><span class="mo-who"><b>${moEsc(g.company || 'A client')}</b>
        <span class="mo-sub">Month ${moEsc(String(g.monthNo))}</span></span>
        <span class="mo-amt fig">${moEsc(moUsd(g.amount))}</span>
        <span class="mo-when">the month says it owes this and nothing was raised<span class="mo-sub">the month was locked by a direct write, not by lock_month</span></span>
        <span class="mo-acts"></span></li>`).join('')}</ul></div>` : ''}`;
}

/* ---- the screen --------------------------------------------------- */

function moBodyHtml(){
  if (mo.err && !mo.owed && !mo.refunds) return `<div class="card"><div class="empty"><h3>The money could not be read</h3><p>${moEsc(mo.err)}</p>
    <button type="button" class="btn" onclick="moReload()">Try again</button></div></div>`;
  return `${mo.err ? `<div class="mo-warn" role="alert">${moEsc(mo.err)}</div>` : ''}
    <div class="section-head"><h3>Who owes us</h3><button type="button" class="btn ghost" onclick="moReload()"${mo.loading ? ' disabled' : ''}>${mo.loading ? 'Reading…' : 'Refresh'}</button></div>
    <div class="card mo-card">${moOwedHtml()}</div>
    <div class="section-head"><h3>What we owe them</h3></div>
    <div class="card mo-card">${moRefundsHtml()}</div>
    <div class="section-head"><h3>Does it add up</h3></div>
    <div class="card mo-card">${moAddUpHtml()}</div>
    ${moElsewhereHtml()}`;
}

/* The three pages that live under Money. They used to sit under Invoices; the
   place in the sidebar is Money now, so this is how they are reached. */
const MO_PAGES = [
  ['billing',  'Invoices',   'Raise an invoice for a month, send it, mark it paid.'],
  ['monthEnd', 'Month end',  'Lock the months that have ended. A short month raises its refund here.'],
  ['ending',   'Ending',     'Clients on their way out, and the final figure both ways.'],
];
function moElsewhereHtml(){
  return `<div class="section-head"><h3>The rest of the money</h3></div>
    <div class="card mo-card"><ul class="mo-list">${MO_PAGES.map(p => `<li class="mo-row mo-page">
      <span class="mo-who"><b>${moEsc(p[1])}</b><span class="mo-sub">${moEsc(p[2])}</span></span>
      <span class="mo-amt"></span><span class="mo-when"></span>
      <span class="mo-acts"><button type="button" class="btn ghost" onclick="moGo(${moAttr(p[0])})">Open</button></span></li>`).join('')}</ul></div>`;
}
function moGo(view){
  if (!MO_PAGES.some(p => p[0] === view)) return false;
  if (moHas('render')) { render(view); return true; }
  return false;
}

function viewMoney(){
  mo.owed = null; mo.refunds = null; mo.back = null; mo.gaps = null; mo.err = '';
  Promise.resolve(moLoad()).then(() => moPaint()).catch(() => {});
  return `<div id="moHost" tabindex="-1">${moBodyHtml()}</div>`;
}
function moPaint(){
  const h = typeof document !== 'undefined' && document.getElementById ? document.getElementById('moHost') : null;
  /* The button that was pressed is about to be thrown away with the rest of the
     screen. Without this the keyboard's focus fell to the top of the document
     after every Mark paid, and the next Tab started from the sidebar. */
  const held = !!(h && typeof h.contains === 'function' && h.contains(document.activeElement));
  if (h) h.innerHTML = moBodyHtml();
  if (held && typeof h.focus === 'function' && !h.contains(document.activeElement)) { try { h.focus({preventScroll: true}); } catch (e) { /* not focusable here */ } }
  /* The sidebar badge is counted from what this screen just read. The sidebar
     was drawn BEFORE the read came back, so it showed no number while the owner
     was looking at five things that needed him, and went on showing the old
     number after he had cleared them. */
  if (h && moHas('renderNav')) { try { renderNav(); } catch (e) { /* signed out */ } }
}
async function moReload(){ await moLoad(); moPaint(); }
function moSay(msg){ if (msg && moHas('toast')) toast(msg); }

/* ---- the buttons -------------------------------------------------- */

/* ONE PRESS AT A TIME, PER THING. The database refuses a second mark_paid, so
   nothing was paid twice — but the refusal arrived after the success and its
   toast replaced it: the owner clicked Paid, it worked, and the screen told him
   "That invoice is already marked paid." A refund recorded without the database
   rule had no such refusal and wrote its note twice. A press while the same
   thing is still going is dropped, and says nothing. */
const moBusy = {};
async function moOnce(key, fn){
  if (moBusy[key]) return moErr('Still working on it.');
  moBusy[key] = true;
  try { return await fn(); } finally { delete moBusy[key]; }
}
/* The clients screen keeps its own copy of invoices and months. Tell it. */
function moChanged(){ if (moHas('cbStale')) { try { cbStale(); } catch (e) { /* not loaded */ } } }

function moSendGo(invoiceId){
  return moOnce('sent:' + invoiceId, async () => {
    if (!moHas('fnMarkInvoiceSent')) return moSay(MO_NOT_LOADED);
    const r = await fnMarkInvoiceSent(invoiceId);
    moSay(r.ok ? 'Marked as sent.' : r.error);
    if (r.ok) moChanged();
    await moReload();
    return r;
  });
}
function moPaidGo(invoiceId){
  return moOnce('paid:' + invoiceId, async () => {
    if (!moHas('fnMarkInvoicePaid')) return moSay(MO_NOT_LOADED);
    const r = await fnMarkInvoicePaid(invoiceId, 'bank transfer');
    moSay(r.ok ? (moHas('fnPaidWords') ? fnPaidWords(r.data) : 'Marked paid.') : r.error);
    if (r.ok) moChanged();
    await moReload();
    return r;
  });
}

/* Part of an invoice has arrived. One number is asked for, in the same place
   the rest of the money is handled, and the database refuses more than is
   still due rather than this screen guessing. */
function moPartGo(invoiceId){
  return moOnce('part:' + invoiceId, async () => {
    if (!moHas('fnRecordPayment')) return moSay(MO_NOT_LOADED);
    const typed = typeof prompt === 'function'
      ? prompt('How much arrived? Dollars, numbers only.') : null;
    if (typed == null || String(typed).trim() === '') return moSay('Left alone.');
    const amount = Number(String(typed).replace(/[^0-9.]/g, ''));
    const r = await fnRecordPayment(invoiceId, amount, 'bank transfer');
    moSay(r.ok
      ? (r.data && r.data.still_due > 0
          ? moUsd(r.data.paid_so_far) + ' in — ' + moUsd(r.data.still_due) + ' still due.'
          : (moHas('fnPaidWords') ? fnPaidWords(r.data) : 'Paid in full.'))
      : r.error);
    if (r.ok) moChanged();
    await moReload();
    return r;
  });
}

/* Recording a refund payment. Four facts, because "status = paid" on its own is
   not a record of anything: how much went, how, the reference, and when. */
function moFindRefund(id){
  const rows = (mo.refunds && mo.refunds.rows) || [];
  return rows.find(r => String(r.id) === String(id)) || null;
}
function moPayFormHtml(r){
  const today = coreTodayKey();
  const methods = (typeof FN_REFUND_METHODS !== 'undefined' ? FN_REFUND_METHODS : ['bank transfer']);
  return `<div class="modal-head"><div><h3>Record the refund</h3>
      <p>${moEsc((r.company || 'This client') + ' — the guarantee raised ' + moUsd(r.amount)
        + (r.month_no == null ? '' : ' for month ' + r.month_no) + '.'
        + (moNum(r.still_owed) > 0 && moNum(r.still_owed) < moNum(r.amount) ? ' ' + moUsd(moNum(r.amount) - moNum(r.still_owed)) + ' of it has gone already; ' + moUsd(r.still_owed) + ' is left.' : '')
        + ' Nothing is sent from here; this records the transfer you made.')}</p></div></div>
    <div class="modal-body">
      <div class="field row2">
        <div><label for="moPayAmt">How much you sent</label><input id="moPayAmt" type="number" min="1" step="1" value="${moEsc(String(Math.round(moNum(r.still_owed == null ? r.amount : r.still_owed))))}" inputmode="numeric"></div>
        <div><label for="moPayOn">When</label><input id="moPayOn" type="date" value="${moEsc(today)}" max="${moEsc(today)}"></div>
      </div>
      <div class="field"><label for="moPayVia">How you sent it</label>
        <input id="moPayVia" list="moPayVias" maxlength="60" autocomplete="off" value="${moEsc(methods[0])}">
        <datalist id="moPayVias">${methods.map(m => `<option value="${moEsc(m)}"></option>`).join('')}</datalist></div>
      <div class="field"><label for="moPayRef">Reference</label>
        <input id="moPayRef" maxlength="120" autocomplete="off" placeholder="The transfer reference you can quote back to them">
        <p class="mo-hint">Leave it empty if there is not one. It is what you quote when a client says the money never arrived.</p></div>
      <div id="moPayErr" class="login-err">${moEsc(mo.payErr || '')}</div>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn ghost" onclick="closeModal()">Close</button>
      <button type="button" class="btn" onclick="moPayGo(${moAttr(r.id)})">Record it</button></div>`;
}
function moOpenPay(refundId){
  const r = moFindRefund(refundId);
  if (!r) return moSay('That refund is not on this screen any more. Refresh and try again.');
  mo.payErr = '';
  if (moHas('openModal')) openModal(moPayFormHtml(r));
  return moPayFormHtml(r);
}
function moPayEntry(){
  const v = id => (moHas('val') ? val(id) : '');
  return {amount: v('moPayAmt'), via: v('moPayVia'), reference: v('moPayRef'), on: v('moPayOn')};
}
function moPayGo(refundId){ return moOnce('refund:' + refundId, () => moPayGoOnce(refundId)); }
async function moPayGoOnce(refundId){
  const r = moFindRefund(refundId);
  if (!r) return moSay('That refund is not on this screen any more. Refresh and try again.');
  const entry = moPayEntry();
  const bad = moHas('fnRefundProblem') ? fnRefundProblem(r, entry) : '';
  if (bad) { mo.payErr = bad; if (moHas('errEl')) errEl('moPayErr', bad); return moErr(bad); }
  const out = await fnMarkRefundPaid(refundId, entry);
  if (!out.ok) { mo.payErr = out.error; if (moHas('errEl')) errEl('moPayErr', out.error); return out; }
  mo.payErr = '';
  if (moHas('closeModal')) closeModal();
  moSay(moHas('fnRefundPaidWords') ? fnRefundPaidWords(out.data) : 'Recorded.');
  await moReload();
  return out;
}
