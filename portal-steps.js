/* ===================== AVIANCE — portal-steps.js (the client's step cards) =====================
   Loaded by portal.html after portal-client.js. Adds three cards drawn under journey messages:
     PC.cards.approval  an ICP / angles / copy to approve: the text, a name, Approve or Ask for changes
     PC.cards.form      the 4-question pre-call form; reads "done" once it is in
     PC.cards.update    a small stat row for a testing day (sent · replies · rate · leading angle)
   Rules this file keeps (same as portal-client.js):
     - Data functions return {ok, data, error} and never throw. Errors are plain words.
     - Everything from the database or a person goes through pcEsc. The *Html builders are pure.
     - Prefix pst. Buttons and fields are at least 44px tall and work at 360px wide.
   Contract (supabase/migrations/20261124_steps.sql): rpc portal_approvals, portal_approve,
   portal_precall_get, portal_precall_submit. Message meta: approval {approval_id, kind, title, body},
   form {form:'precall'}, update {sent, replies, leading, day}.
   ============================================================================================= */

const PST_FIELDS = [
  { key: 'offer', arg: 'p_offer', label: 'What do you sell, in one line?', hint: 'e.g. bookkeeping for dental clinics' },
  { key: 'best_customers', arg: 'p_best', label: 'Who are your best customers right now?', hint: 'the kind of company and the person you talk to' },
  { key: 'deal_size', arg: 'p_deal', label: 'What is a typical deal worth?', hint: 'a rough number is fine' },
  { key: 'avoid', arg: 'p_avoid', label: 'Anyone we should never email?', hint: 'competitors, current clients, industries. "none" is fine' },
];
const PST_KINDS = { icp: 'Target profile', angles: 'Angles', copy: 'Email copy' };   /* a client does not say "ICP" */
const PST_RELOAD_MS = 60000;        /* the cards' state is asked for again at most this often, unless the cards changed */
const PST_MAX_NOTE = 4000;
const PST_MAX_ANSWER = 2000;

/* what the cards draw from: the database's answers and what the person has typed.
   `loaded` is "we have asked AND been answered"; `failed` is the sentence from an
   ask that did not answer. The two are kept apart from "nothing there yet" on
   purpose — see pstLook below. */
const pstState = { approvals: {}, form: null, loaded: false, failed: '', home: null, ui: {}, items: {}, busy: false, who: '', at: 0, seen: '' };

/* What a card is allowed to claim. A card is drawn from a message in the thread,
   which arrives before the card's own state does, so for the first moment (and
   for ever, if the ask fails) this file knows a card exists but not what has
   happened to it. Presenting that as "waiting for you" is the same lie the
   Campaign tab was taught not to tell: it offers a live Approve button on
   something already approved, and a blank pre-call form to someone who filled it
   in a week ago — and a second submit overwrites the answers they gave.
   So: loaded -> draw it; failed -> say so, with a way to try again; neither ->
   say we are still reading it.
   The default is `loaded`, so a caller that hands in nothing (and every pure
   render test) gets exactly today's behaviour. */
function pstLook(load){
  const l = load && typeof load === 'object' ? load : null;
  if (!l) return { loaded: true, failed: '' };
  return { loaded: l.loaded !== false, failed: String(l.failed || '') };
}
/* The honest line in place of a card's controls. `waiting` is the whole sentence
   to show while the ask is still out; `failed` replaces it once the ask has come
   back empty-handed. Pure. */
function pstWaitHtml(waiting, failed){
  if (!failed) return '<p class="pc-tag pst-wait" aria-busy="true">' + pcEsc(waiting) + '</p>';
  return '<p class="pc-err" role="alert">' + pcEsc(failed) + '</p>' +
    '<p class="pc-small">' + pcEsc('Nothing here has changed. We try again every minute.') + '</p>' +
    '<div class="pst-row"><button type="button" class="pc-btn pc-btn-line" data-pc-act="pstRetry">Try again</button></div>';
}

/* Who the state belongs to. A different person signing in on the same browser must never be shown the
   last person's answers, approvals or half-typed notes, so everything is dropped when this changes. */
function pstWho(home){
  const h = home || {};
  return String((h.person && h.person.id) || '') + '|' + String((h.channel && h.channel.id) || '');
}
function pstReset(){
  pstState.approvals = {}; pstState.form = null; pstState.loaded = false; pstState.failed = ''; pstState.ui = {}; pstState.items = {};
  pstState.at = 0; pstState.seen = '';
}
function pstUse(home){
  if (!home) return;
  const who = pstWho(home);
  if (who !== pstState.who) { pstReset(); pstState.who = who; }
  pstState.home = home;
}

/* ---- pure helpers -------------------------------------------------------------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const pstOk = coreOk;
/* This file is read by a CLIENT, so a failure goes through the client's own
   edge, pcPlain in portal-client.js — the same sentences the rest of the portal
   uses, and stricter than the owner's: a paying client is never shown a Postgres
   message, a code or a stack, and anything unknown becomes one calm sentence.
   core.js's corePlain stands in if this file is ever loaded on its own; it does
   the same job, a little more generously, for the owner's screens. */
function pstErr(e){
  const m = (e && (e.message || e.error)) || (typeof e === 'string' ? e : '') || 'Something went wrong. Please try again.';
  const code = e && e.code;
  const say = typeof pcPlain === 'function' ? pcPlain : (typeof corePlain === 'function' ? corePlain : String);
  return { ok: false, data: null, error: String(say(String(m), code)) };
}
function pstUi(key){ return pstState.ui[key] || (pstState.ui[key] = {}); }
function pstCleanName(name){ return String(name == null ? '' : name).trim().replace(/\s+/g, ' '); }

/* '' when the name is fine, otherwise what to fix */
function pstNameProblem(name){
  const n = pstCleanName(name);
  if (n.length < 2 || !/[A-Za-zÀ-￿]/.test(n)) return 'Type your name first.';
  if (n.length > 120) return 'That name is too long. Use 120 characters or fewer.';
  return '';
}
function pstNoteProblem(note){
  const t = String(note == null ? '' : note).trim();
  if (!t) return 'Tell us what to change.';
  if (t.length > PST_MAX_NOTE) return 'That note is too long. Use ' + PST_MAX_NOTE.toLocaleString('en-US') + ' characters or fewer.';
  return '';
}
function pstFormProblem(values){
  const v = values || {};
  for (const f of PST_FIELDS) {
    const t = String(v[f.key] == null ? '' : v[f.key]).trim();
    if (!t) return 'Answer all four questions (a word or two is fine).';
    if (t.length > PST_MAX_ANSWER) return 'Keep each answer under 2,000 characters.';
  }
  return '';
}

/* 'Nov 24, 4:02 PM' in the viewer's own zone */
function pstWhen(v){
  const d = pcToDate(v);
  if (!d) return '';
  return PC_MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate() + ', ' + pcTime(d);
}
function pstNum(v){
  const n = Number(v);
  return v == null || v === '' || !isFinite(n) ? null : Math.max(0, Math.round(n));
}

/* ---- cards (pure) ------------------------------------------------------------------------ */

/* m: the message item from pcGroupMessages; rec: the row from portal_approvals (or undefined);
   ui: {name, note, open, busy, error}; home: portal_home;
   load: {loaded, failed} from pstState — left out, the card behaves as it always
   has and assumes the state is in. See pstLook. */
function pstApprovalHtml(m, rec, ui, home, load){
  const meta = (m && m.meta) || {};
  const id = String(meta.approval_id || (rec && rec.id) || '');
  if (!id) return '';
  const r = rec || {};
  const u = ui || {};
  const kind = r.kind || meta.kind;
  const title = r.title || meta.title || 'For your approval';
  const body = r.body != null ? r.body : meta.body;
  const status = r.status || 'pending';
  const head = `<p class="pc-tag pc-red">${pcEsc(PST_KINDS[kind] ? 'For your approval · ' + PST_KINDS[kind] : 'For your approval')}</p>
    <h3 class="pst-h">${pcEsc(title)}</h3>
    ${body ? `<div class="pst-pre">${pcEsc(body)}</div>` : ''}`;
  const look = pstLook(load);
  let foot;
  /* We know a card is here but not what has happened to it. Never offer Approve
     on that guess: the person may have approved it days ago, and the only thing
     pressing it can do is come back with "This one has already been answered." */
  if (!look.loaded && !rec) {
    foot = pstWaitHtml('Checking where this is up to', look.failed);
  } else if (status === 'approved') {
    foot = `<p class="pst-stamp pst-stamp-ok">Approved by ${pcEsc(r.decided_name || 'you')}${r.decided_at ? ' · ' + pcEsc(pstWhen(r.decided_at)) : ''}</p>`;
  } else if (status === 'changes') {
    foot = `<p class="pst-stamp">Changes asked by ${pcEsc(r.decided_name || 'you')}${r.decided_at ? ' · ' + pcEsc(pstWhen(r.decided_at)) : ''}</p>
      ${r.client_note ? `<p class="pst-note">${pcEsc(r.client_note)}</p>` : ''}
      <p class="pc-small">Thanks — we’re on it and will send a new version here.</p>`;
  } else {
    const name = u.name != null ? u.name : ((home && home.person && home.person.name) || '');
    const fid = 'pst-' + id.replace(/[^A-Za-z0-9-]/g, '');
    foot = `<div class="pst-field"><label class="pc-label" for="${fid}-name">Your name</label>
        <input class="pc-input" id="${fid}-name" type="text" autocomplete="name" maxlength="120" data-pst-in="name" value="${pcEsc(name)}"></div>
      ${u.open ? `<div class="pst-field"><label class="pc-label" for="${fid}-note">What should we change?</label>
        <textarea class="pc-input pst-area" id="${fid}-note" maxlength="${PST_MAX_NOTE}" data-pst-in="note">${pcEsc(u.note || '')}</textarea></div>` : ''}
      <p class="pc-err" role="alert">${pcEsc(u.error || '')}</p>
      <div class="pst-row">${u.open
        ? `<button type="button" class="pc-btn" data-pc-act="pstSendChanges" data-pst-id="${pcEsc(id)}"${u.busy ? ' disabled' : ''}>${u.busy ? 'Sending…' : 'Send changes'}</button>
           <button type="button" class="pc-btn pc-btn-quiet" data-pc-act="pstCancel" data-pst-id="${pcEsc(id)}">Cancel</button>`
        : `<button type="button" class="pc-btn" data-pc-act="pstApprove" data-pst-id="${pcEsc(id)}"${u.busy ? ' disabled' : ''}>${u.busy ? 'Approving…' : 'Approve'}</button>
           <button type="button" class="pc-btn pc-btn-line" data-pc-act="pstAskChanges" data-pst-id="${pcEsc(id)}"${u.busy ? ' disabled' : ''}>Ask for changes</button>`}</div>`;
  }
  return `<section class="pst-card" data-pst-card="a:${pcEsc(id)}" aria-label="${pcEsc(title)}">${head}${foot}</section>`;
}

/* form: what portal_precall_get returned (null/undefined = not asked, or the ask
   failed); ui: {values, busy, error}; load: {loaded, failed} from pstState. */
function pstFormHtml(m, form, ui, load){
  const f = form || {};
  const u = ui || {};
  const look = pstLook(load);
  const key = 'f:' + String((m && m.id) || 'precall').replace(/[^A-Za-z0-9-]/g, '');
  /* No answers in hand yet. A blank form here is not neutral: portal_precall_submit
     overwrites, so someone who answered last week and is shown four empty boxes
     can wipe what they wrote. Say we are still reading it instead. */
  if (!form && !look.loaded) {
    return `<section class="pst-card" data-pst-card="${pcEsc(key)}" aria-label="Pre-call form">
      <p class="pc-tag pc-red">Pre-call form</p>
      ${pstWaitHtml('Checking your answers', look.failed)}
    </section>`;
  }
  if (f.submitted_at) {
    return `<section class="pst-card" data-pst-card="${pcEsc(key)}" aria-label="Pre-call form">
      <p class="pc-tag pc-red">Pre-call form</p>
      <p class="pst-stamp pst-stamp-ok">Done ✓ thanks</p>
      <dl class="pst-answers">${PST_FIELDS.map((q) => `<dt>${pcEsc(q.label)}</dt><dd>${pcEsc(f[q.key] || '')}</dd>`).join('')}</dl>
    </section>`;
  }
  const vals = u.values || {};
  const fid = 'pst-' + key.replace(':', '-');
  return `<section class="pst-card" data-pst-card="${pcEsc(key)}" aria-label="Pre-call form">
    <p class="pc-tag pc-red">Pre-call form · 4 questions</p>
    ${PST_FIELDS.map((q, i) => `<div class="pst-field"><label class="pc-label" for="${fid}-${i}">${i + 1}. ${pcEsc(q.label)}</label>
      <textarea class="pc-input pst-area pst-area-s" id="${fid}-${i}" maxlength="${PST_MAX_ANSWER}" data-pst-in="${pcEsc(q.key)}" placeholder="${pcEsc(q.hint)}">${pcEsc(vals[q.key] != null ? vals[q.key] : (f[q.key] || ''))}</textarea></div>`).join('')}
    <p class="pc-err" role="alert">${pcEsc(u.error || '')}</p>
    <div class="pst-row"><button type="button" class="pc-btn" data-pc-act="pstPrecall"${u.busy ? ' disabled' : ''}>${u.busy ? 'Sending…' : 'Send answers'}</button></div>
  </section>`;
}

/* a testing day: {sent, replies, leading, day} */
function pstUpdateHtml(m){
  const meta = (m && m.meta) || {};
  const sent = pstNum(meta.sent), replies = pstNum(meta.replies), day = pstNum(meta.day);
  if (sent == null && replies == null) return '';
  const rate = sent && replies != null ? (Math.round((replies / sent) * 1000) / 10) + '%' : '';
  const cell = (label, value) => `<div class="pst-stat"><span class="pc-tag">${pcEsc(label)}</span><strong>${pcEsc(value)}</strong></div>`;
  return `<section class="pst-card pst-update" aria-label="Testing numbers">
    <p class="pc-tag pc-red">${pcEsc(day ? 'Testing · day ' + day : 'Testing')}</p>
    <div class="pst-stats">
      ${cell('Sent', sent == null ? '—' : sent.toLocaleString('en-US'))}
      ${cell('Replies', replies == null ? '—' : replies.toLocaleString('en-US'))}
      ${rate ? cell('Reply rate', rate) : ''}
      ${meta.leading ? cell('Leading', String(meta.leading)) : ''}
    </div>
  </section>`;
}

/* ---- data ------------------------------------------------------------------------------------ */

async function pstCall(ctx, name, args){
  try {
    if (!ctx || typeof ctx.rpc !== 'function') return pstErr('We could not reach Aviance. Check your connection and try again.');
    const r = await ctx.rpc(name, args || {});
    if (!r) return pstErr('No answer from Aviance.');
    return r.ok ? pstOk(r.data) : pstErr(r.error);
  } catch (e) { return pstErr(e); }
}
async function pstLoad(ctx, want){
  const w = want || { approvals: true, form: true };
  const out = { approvals: null, form: null };
  /* asked together, not one after the other: this runs every time the thread refreshes */
  const [a, f] = await Promise.all([
    w.approvals ? pstCall(ctx, 'portal_approvals', {}) : null,
    w.form ? pstCall(ctx, 'portal_precall_get', {}) : null,
  ]);
  if (a && !a.ok) return a;
  if (f && !f.ok) return f;
  if (a) out.approvals = Array.isArray(a.data) ? a.data : [];
  if (f) out.form = f.data && typeof f.data === 'object' ? f.data : {};
  return pstOk(out);
}
async function pstDecide(ctx, id, name, decision, note){
  if (!id) return pstErr('We could not find that. Refresh the page and try again.');
  if (decision !== 'approve' && decision !== 'changes') return pstErr('Choose approve or ask for changes.');
  const bad = pstNameProblem(name) || (decision === 'changes' ? pstNoteProblem(note) : '');
  if (bad) return pstErr(bad);
  const r = await pstCall(ctx, 'portal_approve', {
    p_approval: id, p_name: pstCleanName(name), p_decision: decision,
    p_note: decision === 'changes' ? String(note).trim() : null,
  });
  if (r.ok && !(r.data && r.data.status)) return pstErr('We could not confirm that. Refresh the page to check.');
  return r;
}
async function pstSubmitForm(ctx, values){
  const bad = pstFormProblem(values);
  if (bad) return pstErr(bad);
  const args = {};
  PST_FIELDS.forEach((q) => { args[q.arg] = String(values[q.key]).trim(); });
  const r = await pstCall(ctx, 'portal_precall_submit', args);
  if (r.ok && !(r.data && r.data.submitted_at)) return pstErr('We could not confirm your answers. Refresh the page to check.');
  return r;
}

/* ---- wiring into the portal (PC from portal-client.js) --------------------------------------- */

function pstCardFor(key){
  const m = pstState.items[key];
  if (!m) return '';
  if (key.indexOf('a:') === 0) return pstApprovalHtml(m, pstState.approvals[key.slice(2)], pstState.ui[key], pstState.home, pstState);
  if (key.indexOf('f:') === 0) return pstFormHtml(m, pstState.form, pstState.ui.f, pstState);
  return '';
}
/* redraw one card (or all of them) in place, keeping focus where it was when we can */
function pstRedraw(key){
  if (typeof document === 'undefined') return;
  const els = document.querySelectorAll(key ? '[data-pst-card="' + key + '"]' : '[data-pst-card]');
  els.forEach((el) => {
    const k = el.getAttribute('data-pst-card');
    const html = pstCardFor(k);
    if (!html) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild);
  });
}

if (typeof PC !== 'undefined' && PC) {
  PC.cards = PC.cards || {}; PC.actions = PC.actions || {}; PC.mounts = PC.mounts || [];

  PC.cards.approval = function(m){
    const id = m && m.meta && m.meta.approval_id;
    if (!id) return '';
    pstState.items['a:' + id] = m;
    return pstApprovalHtml(m, pstState.approvals[id], pstState.ui['a:' + id], pstState.home, pstState);
  };
  PC.cards.form = function(m){
    const key = 'f:' + String((m && m.id) || 'precall').replace(/[^A-Za-z0-9-]/g, '');
    pstState.items[key] = m;
    return pstFormHtml(m, pstState.form, pstState.ui.f, pstState);
  };
  PC.cards.update = function(m){ return pstUpdateHtml(m); };

  const idOf = (el) => String((el && el.getAttribute && el.getAttribute('data-pst-id')) || '');
  const decide = async function(el, ctx, decision){
    const id = idOf(el), key = 'a:' + id, u = pstUi(key);
    if (u.busy) return;
    pstUse(ctx && ctx.home);
    if (u.name == null) u.name = (pstState.home && pstState.home.person && pstState.home.person.name) || '';
    u.busy = true; u.error = ''; pstRedraw(key);
    let r;
    /* An approval is a write: never sent twice. The card always becomes usable
       again, or a client could not approve anything without reloading. */
    try { r = await pstDecide(ctx, id, u.name, decision, u.note); }
    catch (e) { r = pstErr(e); }
    finally { u.busy = false }
    if (!r.ok) { u.error = r.error; pstRedraw(key); return; }
    pstState.approvals[id] = Object.assign({}, pstState.approvals[id] || {}, r.data);
    u.open = false; pstRedraw(key);
    if (ctx && typeof ctx.refresh === 'function') ctx.refresh();
  };
  PC.actions.pstApprove = (el, ctx) => decide(el, ctx, 'approve');
  PC.actions.pstSendChanges = (el, ctx) => decide(el, ctx, 'changes');
  PC.actions.pstAskChanges = function(el){
    const key = 'a:' + idOf(el), u = pstUi(key);
    u.open = true; u.error = ''; pstRedraw(key);
    const t = typeof document !== 'undefined' && document.querySelector('[data-pst-card="' + key + '"] [data-pst-in="note"]');
    if (t) t.focus();
  };
  PC.actions.pstCancel = function(el){ const key = 'a:' + idOf(el), u = pstUi(key); u.open = false; u.error = ''; pstRedraw(key); };
  /* "Try again" on a card that could not be read: forget the back-off and ask
     now, so someone looking at the failure has a way out other than reloading. */
  PC.actions.pstRetry = function(el, ctx){
    pstState.at = 0; pstState.seen = '';
    return pstMount(ctx);
  };
  PC.actions.pstPrecall = async function(el, ctx){
    const u = pstUi('f');
    if (u.busy) return;
    const vals = Object.assign({}, pstState.form || {}, u.values || {});
    u.busy = true; u.error = ''; pstRedraw();
    let r;
    try { r = await pstSubmitForm(ctx, vals); }
    catch (e) { r = pstErr(e); }
    u.busy = false;
    if (!r.ok) { u.error = r.error; pstRedraw(); return; }
    pstState.form = r.data; u.values = {};
    pstRedraw();
    if (ctx && typeof ctx.refresh === 'function') ctx.refresh();
  };

  /* after every refresh: learn who is signed in, then load the state the cards on screen need */
  async function pstMount(ctx){
    pstUse(ctx && ctx.home);
    if (typeof document === 'undefined' || pstState.busy) return;
    const want = { approvals: !!document.querySelector('[data-pst-card^="a:"]'), form: !!document.querySelector('[data-pst-card^="f:"]') };
    if (!want.approvals && !want.form) return;
    /* The thread refreshes every few seconds. The cards' state only changes when a new card arrives or
       this person presses a button (which updates it here), so do not ask the database on every refresh. */
    const seen = Object.keys(pstState.items).sort().join(',');
    if (pstState.loaded && seen === pstState.seen && Date.now() - pstState.at < PST_RELOAD_MS) return;
    const who = pstState.who;
    pstState.busy = true;
    let r;
    /* Left true, the cards would never be read again for the rest of the visit. */
    try { r = await pstLoad(ctx, want); }
    catch (e) { r = pstErr(e); }
    finally { pstState.busy = false }
    if (who !== pstState.who) return; /* someone else signed in while this was on its way */
    /* An ask that did not answer is written down, not swallowed. The stamp is set
       either way, so a database that is down is asked again in a minute rather
       than on every refresh; and the cards say what happened instead of guessing
       that nothing has been approved and no form has been filled in. */
    pstState.at = Date.now(); pstState.seen = seen;
    if (!r.ok) {
      if (pstState.failed !== r.error) { pstState.failed = r.error; pstRedraw(); }
      return;
    }
    const before = JSON.stringify([pstState.approvals, pstState.form, pstState.failed]);
    pstState.failed = '';
    if (r.data.approvals) { const map = {}; r.data.approvals.forEach((a) => { if (a && a.id) map[a.id] = a; }); pstState.approvals = map; }
    if (r.data.form) pstState.form = r.data.form;
    pstState.loaded = true;
    if (JSON.stringify([pstState.approvals, pstState.form, pstState.failed]) !== before) pstRedraw();
  }
  PC.mounts.push(pstMount);

  /* keep what the person types, so a redraw of the thread never loses it */
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('input', function(e){
      const t = e.target;
      const field = t && t.getAttribute && t.getAttribute('data-pst-in');
      if (!field) return;
      const card = t.closest('[data-pst-card]');
      const key = card && card.getAttribute('data-pst-card');
      if (!key) return;
      if (key.indexOf('a:') === 0) pstUi(key)[field] = t.value;
      else { const u = pstUi('f'); u.values = u.values || {}; u.values[field] = t.value; }
    });
    if (!document.getElementById('pstStyle') && document.head) {
      const s = document.createElement('style');
      s.id = 'pstStyle';
      s.textContent = [
        '.pst-card{margin-top:8px;padding:16px;border:2px solid #000;background:#fff;max-width:100%}',
        '.pst-card>.pc-tag{margin:0 0 8px}',
        '.pst-h{font-size:19px;line-height:1.25;font-weight:800;letter-spacing:-.02em;margin:6px 0 10px}',
        '.pst-pre{font:400 14px/1.65 var(--pc-mono);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--pc-wash);border-left:4px solid #000;padding:14px 16px;margin:0 0 16px;max-height:360px;overflow-y:auto}',
        '.pst-field{margin:0 0 14px}',
        '.pst-card .pc-input{min-height:48px;font-size:16px}',
        '.pst-area{min-height:96px;resize:vertical}',
        '.pst-area-s{min-height:64px}',
        '.pst-row{display:flex;flex-wrap:wrap;gap:10px}',
        '.pst-row .pc-btn{min-height:48px;padding:10px 20px;font-size:16px}',
        '.pst-card .pc-err:not(:empty){margin:0 0 12px}',
        '.pst-wait{margin:4px 0 0}',
        '.pst-stamp{display:inline-block;margin:4px 0 8px;padding:8px 12px;border:2px solid #000;font:400 12px/1.4 var(--pc-mono);letter-spacing:.12em;text-transform:uppercase}',
        '.pst-stamp-ok{border-color:var(--pc-red);color:var(--pc-red)}',
        '.pst-note{white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid #000;padding:4px 0 4px 12px;margin:0 0 8px}',
        '.pst-answers{margin:8px 0 0}',
        '.pst-answers dt{font:400 11px var(--pc-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--pc-grey);margin-top:10px}',
        '.pst-answers dd{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.pst-update{padding:12px 16px}',
        '.pst-stats{display:flex;flex-wrap:wrap;gap:10px 24px;margin-top:6px}',
        '.pst-stat{display:flex;flex-direction:column;min-width:64px}',
        '.pst-stat strong{font-size:20px;line-height:1.2;font-weight:800;letter-spacing:-.02em;overflow-wrap:anywhere}',
        '@media (max-width:560px){.pst-card{padding:12px}.pst-row .pc-btn{width:100%}.pst-row .pc-btn-quiet{width:100%}}',
      ].join('\n');
      document.head.appendChild(s);
    }
  }
}
