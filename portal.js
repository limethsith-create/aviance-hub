/* ===================== AVIANCE OS — The client portal =====================
   The client's own people, their way in, and what they have asked for.
   (The conversation itself lives on the Channels screen: channels.js.)

   Tables (SCHEMA.md): client_people  portal_invites  client_requests

   Nothing here calls another server. Everything goes through the shell's `sb`
   client. Every data function returns {ok, data, error} and NEVER throws — the
   same plumbing as finance.js. `error` is a plain sentence, safe to show.

   The money rules are not duplicated here. A request of kind 'dispute' is only
   recorded; the call it is about is settled in finance.js (fnDisputeCall).

   View functions return HTML and touch nothing else. Every screen renders with
   zero rows. Every global in this file is prefixed `pt`.
   ========================================================================== */

/* ---- plumbing (finance.js) --------------------------------------- */

/* The {ok,data,error} result, from core.js: one implementation, aliased to this
   file's own name for it. See core.js for why. */
const ptOk = coreOk;
const ptErr = coreErr;
const ptWrap = coreWrap;
async function ptRun(fn, whenEmpty){
  try { return ptWrap(await fn(), whenEmpty); }
  catch (e) { return ptErr(e); }
}

/* ---- small helpers ----------------------------------------------- */

const PT_INVITE_DAYS = 14;          // portal_invites.expires_at default, said on the screen
const PT_BODY_MAX = 4000;

function ptSb(){
  let s = null;
  try { if (typeof sb !== 'undefined' && sb) s = sb; } catch (e) { s = null; }
  if (!s && typeof window !== 'undefined') s = window.sb || null;
  if (!s) throw new Error('The portal is not ready yet. Please reload the page.');
  return s;
}
function ptUser(){
  try { return (typeof authUser !== 'undefined' && authUser) || null; } catch (e) { return null; }
}
/* The one escape, from core.js: strict, five characters, the single quote among them. */
const ptEsc = coreEsc;
function ptText(v, max){
  const s = String(v == null ? '' : v).trim();
  return s.slice(0, max || 200);
}
function ptIsEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()); }
function ptNow(){ return Date.now(); }
function ptIso(ms){ return new Date(ms).toISOString(); }
function ptDenied(){ return ptErr('You do not have access to that client.'); }

/* Who is answering: the signed-in member of our team. Clients never enter the hub. */
function ptMe(){
  const u = ptUser() || {};
  const staff = u.role === 'admin' || u.role === 'employee';
  return { userId: staff ? (u.uid || u.id || null) : null, staff: staff };
}

/* ---- who may see what -------------------------------------------- */

/* Clients sign in at portal.html and never enter the hub, so this stays off.
   ptCanSee is the only place here that decides what a viewer may see. */
const ptFlags = { clientSignIn: false };

function ptCanSee(clientId){
  const u = ptUser();
  if (!u || !clientId) return false;
  if (u.role === 'admin' || u.role === 'employee') return u.approved !== false;   // our team sees every client
  if (u.role === 'client') return !!(ptFlags.clientSignIn && u.clientId && u.clientId === String(clientId));
  return false;
}

/* ===================== 1. THEIR PEOPLE ===================== */

async function ptPeople(clientId){
  if (!ptCanSee(clientId)) return ptDenied();
  return ptRun(() => ptSb().from('client_people').select('*').eq('client_id', clientId)
    .order('is_primary', {ascending:false}).order('full_name'), []);
}

/* Add one of their people. `fields.isPrimary` makes them the primary, which
   takes the primary off whoever had it (see ptSetPrimary). */
async function ptAddPerson(clientId, fields){
  if (!ptCanSee(clientId)) return ptDenied();
  const f = fields || {};
  const name = ptText(f.fullName || f.full_name, 120);
  if (!name) return ptErr('Give the person a name.');
  const email = ptText(f.email, 200).toLowerCase();
  if (email && !ptIsEmail(email)) return ptErr('That email address does not look right.');

  const made = await ptRun(() => ptSb().from('client_people').insert({
    client_id:  clientId,
    full_name:  name,
    email:      email || null,
    phone:      ptText(f.phone, 40) || null,
    role:       ptText(f.role, 80) || null,
    timezone:   ptText(f.timezone || f.timeZone, 60) || null,
    notes:      ptText(f.notes, 600) || null,
    is_primary: false
  }).select().single(), null);
  if (!made.ok) return made;

  if (f.isPrimary || f.is_primary) {
    const p = await ptSetPrimary(clientId, made.data && made.data.id);
    if (!p.ok) return p;
    return ptOk(Object.assign({}, made.data, {is_primary:true}));
  }
  return made;
}

/* Exactly one primary person per client. Enforced here, in this one function:
   everyone else is taken off first, then this person is set. */
async function ptSetPrimary(clientId, personId){
  if (!ptCanSee(clientId)) return ptDenied();
  if (!personId) return ptErr('Pick a person first.');

  const off = await ptRun(() => ptSb().from('client_people').update({is_primary:false})
    .eq('client_id', clientId).neq('id', personId).select('id'), []);
  if (!off.ok) return off;

  const on = await ptRun(() => ptSb().from('client_people').update({is_primary:true})
    .eq('client_id', clientId).eq('id', personId).select(), []);
  if (!on.ok) return on;
  const rows = Array.isArray(on.data) ? on.data : (on.data ? [on.data] : []);
  if (!rows.length) return ptErr('That person is not on this client.');
  return ptOk(rows[0]);
}

/* ===================== 2. THEIR WAY IN (invites) ===================== */

/* The link is made ONCE, by the database: `portal_invite_create` hands back the
   raw token a single time and keeps only its hash. So a link can be shown at the
   moment an invite is made and never again — nothing here reads a token off a
   row, because there is none to read. To get a new link, send the invite again:
   that makes a new one and the old one stops working. */

/* The columns a screen needs. The hash is never asked for. */
const PT_INVITE_COLS = 'id,client_id,person_id,email,portal_role,status,expires_at,accepted_at,accepted_user,created_at';

/* The link we give them. The token rides after the #, so it never reaches a
   server log. */
function ptInviteLink(token){
  const t = String(token || '').trim();
  if (!t) return '';
  let origin = 'https://aviance.store';
  try { if (typeof location !== 'undefined' && location.origin) origin = location.origin; } catch (e) {}
  return `${origin}/join.html#${t}`;
}

/* The real state of an invite. An invite past its expires_at reads as expired
   even while its row still says pending, so a stale row never looks live. */
function ptInviteState(row){
  if (!row) return 'expired';
  if (row.status === 'accepted' || row.accepted_at) return 'accepted';
  if (row.status === 'revoked') return 'revoked';
  const t = Date.parse(row.expires_at || '');
  if (!Number.isFinite(t) || t <= ptNow()) return 'expired';
  return 'pending';
}
function ptInviteWords(state){
  if (state === 'accepted') return 'Accepted';
  if (state === 'revoked')  return 'Revoked';
  if (state === 'expired')  return 'Expired — send a new one';
  return 'Waiting for them';
}
/* An invite row plus its real state, in words. No link: a listed invite has none. */
function ptInviteShape(row){
  if (!row) return null;
  const state = ptInviteState(row);
  const out = {};
  PT_INVITE_COLS.split(',').forEach(k => { if (row[k] !== undefined) out[k] = row[k]; });
  return Object.assign(out, {state, stateWords: ptInviteWords(state)});
}

async function ptInvites(clientId){
  if (!ptCanSee(clientId)) return ptDenied();
  const r = await ptRun(() => ptSb().from('portal_invites').select(PT_INVITE_COLS).eq('client_id', clientId)
    .order('created_at', {ascending:false}), []);
  if (!r.ok) return r;
  return ptOk((r.data || []).map(ptInviteShape));
}

/* Invite one of their people in. The database makes the link's secret and the
   14-day expiry, and revokes any earlier invite still waiting for the same
   address — nothing random is made in JavaScript here.
   -> {client_id, person_id, email, portal_role, state, stateWords, link}
   `link` is the only copy there will ever be: show it once, for copying. */
async function ptInvite(clientId, opts){
  if (!ptCanSee(clientId)) return ptDenied();
  const o = opts || {};
  const email = ptText(o.email, 200).toLowerCase();
  if (!ptIsEmail(email)) return ptErr('Enter the email address to invite.');
  const person = o.personId || o.person_id || null;

  const r = await ptRun(() => ptSb().rpc('portal_invite_create',
    {p_client: clientId, p_email: email, p_person: person}), null);
  if (!r.ok) return r;
  const link = ptInviteLink(typeof r.data === 'string' ? r.data : '');
  if (!link) return ptErr('The invite was not made. Please try again.');

  /* The database makes every invite a viewer. A manager is set on the row it
     just made; if that does not take, they are a viewer and we say so. */
  let role = 'viewer';
  if (o.portalRole === 'manager') {
    const up = await ptRun(() => ptSb().from('portal_invites').update({portal_role:'manager'})
      .eq('client_id', clientId).eq('email', email).eq('status', 'pending').select('id'), []);
    if (up.ok && Array.isArray(up.data) && up.data.length) role = 'manager';
  }
  return ptOk({client_id: clientId, person_id: person, email: email, portal_role: role,
    state: 'pending', stateWords: ptInviteWords('pending'), link: link});
}

async function ptRevokeInvite(id){
  if (!id) return ptErr('Pick an invite first.');
  const r = await ptRun(() => ptSb().from('portal_invites')
    .update({status:'revoked'}).eq('id', id).select(PT_INVITE_COLS).single(), null);
  if (!r.ok) return r;
  return ptOk(ptInviteShape(r.data));
}

/* Send it again: a NEW invite for the same person, made the same way. The old
   link stops working (the database revokes it) and the new one is shown once. */
async function ptResendInvite(id){
  if (!id) return ptErr('Pick an invite first.');
  const old = await ptRun(() => ptSb().from('portal_invites').select(PT_INVITE_COLS).eq('id', id).maybeSingle(), null);
  if (!old.ok) return old;
  if (!old.data) return ptErr('That invite is not here any more.');
  if (ptInviteState(old.data) === 'accepted') return ptErr('They have already joined, so there is nothing to send again.');
  return ptInvite(old.data.client_id, {email: old.data.email, personId: old.data.person_id, portalRole: old.data.portal_role});
}

/* ===================== 3. WHAT THEY ASK FOR (requests) ===================== */

const PT_REQUEST_KINDS = ['question','change','complaint','dispute','pause','cancel','other'];
const PT_OPEN_STATUSES = ['open','in_progress'];

async function ptRequests(clientId, opts){
  if (!ptCanSee(clientId)) return ptDenied();
  const o = opts || {};
  return ptRun(() => {
    let q = ptSb().from('client_requests').select('*').eq('client_id', clientId);
    if (o.status) q = q.eq('status', o.status);
    return q.order('created_at', {ascending:false});
  }, []);
}

/* They raise something. A dispute is recorded here and settled in the money. */
async function ptRaiseRequest(clientId, fields){
  if (!ptCanSee(clientId)) return ptDenied();
  const f = fields || {};
  const kind = PT_REQUEST_KINDS.indexOf(f.kind) >= 0 ? f.kind : 'question';
  const subject = ptText(f.subject, 200);
  if (!subject) return ptErr('Say in a line what this is about.');

  // TODO: a request of kind 'dispute' is only the client's word that a call
  // should not count. The call itself is set aside by finance.js fnDisputeCall
  // (qualified_calls.dispute_status), which is the only place that may touch
  // the money. Do not call it from here and do not copy its rules: open the
  // call on the client's money screen and raise the dispute there.
  return ptRun(() => ptSb().from('client_requests').insert({
    client_id: clientId,
    person_id: f.personId || f.person_id || null,
    kind:      kind,
    subject:   subject,
    body:      ptText(f.body, PT_BODY_MAX) || null,
    owner:     f.owner || null,
    status:    'open'
  }).select().single(), null);
}

/* Our answer goes on the request itself and it reads as answered. */
async function ptAnswerRequest(id, body){
  if (!id) return ptErr('Pick a request first.');
  const text = ptText(body, PT_BODY_MAX);
  if (!text) return ptErr('Write the answer first.');

  const cur = await ptRun(() => ptSb().from('client_requests').select('body').eq('id', id).maybeSingle(), null);
  if (!cur.ok) return cur;
  const had = (cur.data && cur.data.body) ? String(cur.data.body).trim() + '\n\n' : '';
  const me = ptMe();
  return ptRun(() => ptSb().from('client_requests').update({
    body:   (had + 'Aviance: ' + text).slice(0, PT_BODY_MAX),
    status: 'answered',
    owner:  me.userId || null
  }).eq('id', id).select().single(), null);
}

async function ptCloseRequest(id){
  if (!id) return ptErr('Pick a request first.');
  return ptRun(() => ptSb().from('client_requests')
    .update({status:'closed', closed_at: ptIso(ptNow())})
    .eq('id', id).select().single(), null);
}

/* ===================== 4. SCREENS ===================== */
/* Each one returns HTML and nothing else. They are async because they read the
   database first; the HTML they hand back is complete, zero rows included. */

function ptCard(title, sub, inner){
  return `<section class="pt-card"><div class="pt-card-head"><h3>${ptEsc(title)}</h3>${sub?`<p>${ptEsc(sub)}</p>`:''}</div>${inner}</section>`;
}
function ptEmpty(title, sub){
  return `<div class="pt-empty"><b>${ptEsc(title)}</b><span>${ptEsc(sub)}</span></div>`;
}
function ptAlert(msg){
  return `<div class="pt-err" role="alert">${ptEsc(msg || 'Something went wrong.')}</div>`;
}
function ptNoAccess(){
  return `<div class="pt-wrap">${ptAlert('You do not have access to that client.')}</div>`;
}
function ptTag(tone, words){
  return `<span class="pt-tag ${ptEsc(tone)}">${ptEsc(words)}</span>`;
}
function ptA(v){ return ptEsc(JSON.stringify(v == null ? '' : String(v))); }
function ptWhen(v){
  const t = Date.parse(v || '');
  if (!Number.isFinite(t)) return '';
  try { return new Date(t).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}); }
  catch (e) { return new Date(t).toDateString(); }
}
function ptDaysOld(v, now){
  const t = Date.parse(v || '');
  if (!Number.isFinite(t)) return '';
  const d = Math.floor(((now == null ? ptNow() : now) - t) / 86400000);
  if (d <= 0) return 'today';
  return d === 1 ? '1 day old' : d + ' days old';
}
const PT_INVITE_TONE = {pending:'blue', accepted:'green', expired:'amber', revoked:'grey'};

/* Their people: who is primary, their invites and each invite's real state. */
async function viewClientPeople(clientId){
  if (!ptCanSee(clientId)) return ptNoAccess();
  const [people, invites] = await Promise.all([ptPeople(clientId), ptInvites(clientId)]);

  let peopleHtml;
  if (!people.ok) peopleHtml = ptAlert(people.error);
  else if (!people.data.length) peopleHtml = ptEmpty('No people yet', 'Add the person we deal with, so the portal and the channel know who they are.');
  else peopleHtml = `<ul class="pt-list">` + people.data.map(p => `<li class="pt-row">
      <span class="pt-name">${ptEsc(p.full_name || 'Someone')}${p.is_primary ? ptTag('green', 'Primary') : ''}</span>
      <span class="pt-sub">${ptEsc([p.role, p.email, p.phone].filter(Boolean).join(' · '))}</span>
      ${p.is_primary ? '' : `<button type="button" class="pt-link" onclick="ptPrimaryFromRow(${ptA(clientId)},${ptA(p.id)})">Make primary</button>`}
    </li>`).join('') + `</ul>`;

  let inviteHtml;
  if (!invites.ok) inviteHtml = ptAlert(invites.error);
  else if (!invites.data.length) inviteHtml = ptEmpty('No invites yet', 'An invite makes a link to their own portal. It is shown once, for you to copy and send.');
  else inviteHtml = `<ul class="pt-list">` + invites.data.map(i => `<li class="pt-row">
      <span class="pt-name">${ptEsc(i.email || '')}${ptTag(PT_INVITE_TONE[i.state] || 'grey', i.stateWords)}</span>
      <span class="pt-sub">${ptEsc((i.portal_role === 'manager' ? 'Manager' : 'Viewer') + ' · ' + (i.state === 'accepted' ? 'joined ' + ptWhen(i.accepted_at) : 'expires ' + ptWhen(i.expires_at)))}</span>
      <span class="pt-acts">
        ${i.state === 'pending' ? `<button type="button" class="pt-link" onclick="ptRevokeFromRow(${ptA(i.id)})">Revoke</button>` : ''}
        ${i.state === 'expired' || i.state === 'revoked' ? `<button type="button" class="pt-link" onclick="ptResendFromRow(${ptA(i.id)})">Send again</button>` : ''}
      </span>
    </li>`).join('') + `</ul>`;

  const form = `<div class="pt-form">
    <div class="pt-field"><label for="ptInviteEmail">Email address</label><input id="ptInviteEmail" type="email" autocomplete="off" placeholder="name@theircompany.com"></div>
    <div class="pt-field"><label for="ptInviteRole">They can</label><select id="ptInviteRole"><option value="viewer">Look at their numbers</option><option value="manager">Look and ask for changes</option></select></div>
    <button type="button" class="pt-btn primary" onclick="ptInviteFromForm(${ptA(clientId)})">Make the invite</button>
  </div><div id="ptInviteOnce" aria-live="polite"></div>`;

  return `<div class="pt-wrap">
    ${ptCard('Their people', 'Exactly one of them is the primary contact.', peopleHtml)}
    ${ptCard('Their way in', 'An invite lasts ' + PT_INVITE_DAYS + ' days, then it reads as expired.', inviteHtml + form)}
  </div>`;
}

/* Every open request across all clients, oldest first, with who owns it. */
async function viewRequests(){
  const u = ptUser();
  const staff = !!u && (u.role === 'admin' || u.role === 'employee') && u.approved !== false;
  if (!staff) return `<div class="pt-wrap">${ptAlert('Only Aviance staff can see every client\'s requests.')}</div>`;

  /* the requests, the client names and the owners' names are asked for together, not one after another */
  const [rows, clients, profiles] = await Promise.all([
    ptRun(() => ptSb().from('client_requests').select('*').in('status', PT_OPEN_STATUSES).order('created_at', {ascending:true}), []),
    ptRun(() => ptSb().from('clients').select('id,company'), []),
    ptRun(() => ptSb().from('profiles').select('id,name,email'), []),
  ]);
  if (!rows.ok) return `<div class="pt-wrap">${ptCard('Open requests', '', ptAlert(rows.error))}</div>`;
  if (!rows.data.length) return `<div class="pt-wrap">${ptCard('Open requests', '', ptEmpty('Nothing open', 'Every request from every client has been answered.'))}</div>`;

  const names = {};
  if (clients.ok) (clients.data || []).forEach(c => { if (c && c.id) names[c.id] = c.company || c.id; });
  const owners = {};
  if (profiles.ok) (profiles.data || []).forEach(p => { if (p && p.id) owners[p.id] = p.name || p.email || 'Someone'; });

  const inner = `<ul class="pt-list">` + rows.data.map(r => `<li class="pt-row">
      <span class="pt-name">${ptEsc(r.subject || 'A request')}${ptTag(r.kind === 'dispute' ? 'amber' : 'blue', r.kind || 'question')}</span>
      <span class="pt-sub">${ptEsc((names[r.client_id] || r.client_id || 'A client') + ' · ' + ptDaysOld(r.created_at) + ' · ' + (r.owner ? (owners[r.owner] || 'Someone') : 'No one yet'))}</span>
      <span class="pt-acts"><button type="button" class="pt-link" onclick="ptCloseFromRow(${ptA(r.id)})">Close</button></span>
    </li>`).join('') + `</ul>`;
  return `<div class="pt-wrap">${ptCard('Open requests', 'Oldest first — the one at the top has waited longest.', inner)}</div>`;
}

/* ---- the screens' own handlers ----------------------------------- */

function ptEl(id){ return typeof document !== 'undefined' ? document.getElementById(id) : null; }
function ptSay(msg){ try { if (typeof toast === 'function') toast(msg); } catch (e) {} }
/* Draw the screen again so a change shows at once. */
function ptRedraw(){
  try { if (typeof render === 'function' && typeof currentView !== 'undefined' && currentView) render(currentView); } catch (e) {}
}
/* The row buttons. Each says what happened and redraws; before, a press changed the database and the screen
   stayed exactly as it was, so nobody could tell whether it had worked. One press at a time. */
const ptBusy = {};
async function ptRowDo(key, fn, done){
  if (ptBusy[key]) return ptErr('Still working on it.');
  ptBusy[key] = true;
  let out;
  try { out = await fn(); } finally { delete ptBusy[key]; }
  ptSay(out.ok ? done : out.error);
  if (out.ok) ptRedraw();
  return out;
}
function ptPrimaryFromRow(clientId, personId){ return ptRowDo('primary:' + personId, () => ptSetPrimary(clientId, personId), 'They are the primary contact now.'); }
function ptRevokeFromRow(id){ return ptRowDo('revoke:' + id, () => ptRevokeInvite(id), 'Invite revoked. That link no longer works.'); }
function ptCloseFromRow(id){ return ptRowDo('close:' + id, () => ptCloseRequest(id), 'Request closed.'); }

async function ptInviteFromForm(clientId){
  const e = ptEl('ptInviteEmail'), r = ptEl('ptInviteRole');
  if (ptBusy.invite) return ptErr('Still working on it.');     // a double click must not make (and revoke) two invites
  ptBusy.invite = true;
  let out;
  try { out = await ptInvite(clientId, {email: e ? e.value : '', portalRole: r ? r.value : 'viewer'}); }
  finally { delete ptBusy.invite; }
  if (!out.ok) { ptSay(out.error); return out; }
  if (e) e.value = '';
  ptShowInviteOnce(out.data);
  ptSay('Invite made. Copy the link now — it is only shown this once.');
  return out;
}
async function ptResendFromRow(id){
  const out = await ptResendInvite(id);
  if (!out.ok) { ptSay(out.error); return out; }
  ptShowInviteOnce(out.data);
  ptSay('A new invite is made and the old link no longer works. Copy the new link now.');
  return out;
}

/* The link, once. Pure: the invite in, HTML out. */
function ptRenderInviteOnce(inv){
  if (!inv || !inv.link) return '';
  return `<div class="pt-form" role="status">
    <div class="pt-field"><label for="ptInviteLinkOut">Their link — shown once, copy it now</label>
      <input id="ptInviteLinkOut" type="text" readonly value="${ptEsc(inv.link)}" onfocus="this.select()"></div>
    <button type="button" class="pt-btn primary" onclick="ptCopyInviteLink()">Copy the link</button>
    <p class="pt-sub">For ${ptEsc(inv.email || 'them')}. It lasts ${PT_INVITE_DAYS} days. We do not keep a copy: if it is lost, send the invite again to make a new one.</p>
  </div>`;
}
function ptShowInviteOnce(inv){
  const box = ptEl('ptInviteOnce');
  if (box) box.innerHTML = ptRenderInviteOnce(inv);
}
async function ptCopyInviteLink(){
  const i = ptEl('ptInviteLinkOut');
  const link = i ? String(i.value || '') : '';
  if (!link) { ptSay('There is no link to copy. Make the invite again.'); return false; }
  let ok = false;
  try { await navigator.clipboard.writeText(link); ok = true; } catch (e) { ok = false; }
  if (!ok && i && typeof i.select === 'function') { try { i.select(); } catch (e) {} }
  ptSay(ok ? 'Copied. Send it to them.' : 'Could not copy by itself. The link is selected — copy it by hand.');
  return ok;
}
