/* ===================== AVIANCE OS — The client portal =====================
   The client's own people, their way in, and the conversation with them.

   Tables (SCHEMA.md): client_people  portal_invites  client_requests
                       channels / channel_members / channel_messages  (the client side)

   Nothing here calls another server. Everything goes through the shell's `sb`
   client. Every data function returns {ok, data, error} and NEVER throws — the
   same plumbing as finance.js. `error` is a plain sentence, safe to show.

   The money rules are not duplicated here. A request of kind 'dispute' is only
   recorded; the call it is about is settled in finance.js (fnDisputeCall).

   View functions return HTML and touch nothing else. Every screen renders with
   zero rows. Every global in this file is prefixed `pt`.
   ========================================================================== */

/* ---- plumbing (finance.js) --------------------------------------- */

function ptOk(data){ return {ok:true, data, error:''} }
function ptErr(e){
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong.');
  return {ok:false, data:null, error:m};
}
function ptWrap(res, whenEmpty){
  if (!res) return ptErr('No answer from the database.');
  if (res.error) return ptErr(res.error);
  return ptOk(res.data === null || res.data === undefined ? whenEmpty : res.data);
}
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
function ptEsc(s){
  if (typeof esc === 'function') return esc(s);
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function ptText(v, max){
  const s = String(v == null ? '' : v).trim();
  return s.slice(0, max || 200);
}
function ptIsEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()); }
function ptNow(){ return Date.now(); }
function ptIso(ms){ return new Date(ms).toISOString(); }
function ptDenied(){ return ptErr('You do not have access to that client.'); }

/* Who is writing. A staff user writes as a user; one of the client's own people
   writes as a person (the other half of channel_members / channel_messages). */
function ptMe(){
  const u = ptUser() || {};
  const staff = u.role === 'admin' || u.role === 'employee';
  return {
    userId:   staff ? (u.uid || u.id || null) : null,
    personId: staff ? null : (u.personId || u.person_id || null),
    staff: staff
  };
}

/* ---- who may see what -------------------------------------------- */

/* Client sign-in is not switched on yet. When it is, flip this flag: this
   function is the only place in the portal that decides what a viewer may see. */
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

/* ===================== 4. THE CONVERSATION ===================== */

/* One client channel per client. Finds it, or makes it and puts our team and
   their people in it. Safe to call twice: the second call finds the first one. */
async function ptChannelFor(clientId){
  if (!ptCanSee(clientId)) return ptDenied();

  const found = await ptRun(() => ptSb().from('channels').select('*')
    .eq('kind', 'client').eq('client_id', clientId).limit(1), []);
  if (!found.ok) return found;
  const have = Array.isArray(found.data) ? found.data[0] : found.data;
  if (have && have.id) { await ptSyncMembers(have.id, clientId); return ptOk(have); }

  const name = await ptClientName(clientId);
  const made = await ptRun(() => ptSb().from('channels').insert({
    name:       name,
    purpose:    'Aviance and ' + name,
    kind:       'client',
    client_id:  clientId,
    created_by: ptMe().userId || null
  }).select().single(), null);
  if (!made.ok) return made;
  await ptSyncMembers(made.data && made.data.id, clientId);
  return ptOk(made.data);
}

async function ptClientName(clientId){
  const r = await ptRun(() => ptSb().from('clients').select('company').eq('id', clientId).maybeSingle(), null);
  const n = r.ok && r.data && r.data.company ? String(r.data.company) : '';
  return ptText(n, 80) || String(clientId);
}

/* Our team and their people are members. Already a member is fine (23505). */
async function ptSyncMembers(channelId, clientId){
  if (!channelId) return ptOk([]);
  const rows = [];
  const staff = await ptRun(() => ptSb().from('profiles').select('id,role,approved'), []);
  if (staff.ok) (staff.data || []).forEach(p => {
    if (p && p.approved && (p.role === 'admin' || p.role === 'employee'))
      rows.push({channel_id: channelId, user_id: p.id, member_role: p.role === 'admin' ? 'owner' : 'member'});
  });
  const people = await ptRun(() => ptSb().from('client_people').select('id').eq('client_id', clientId), []);
  if (people.ok) (people.data || []).forEach(p => {
    if (p && p.id) rows.push({channel_id: channelId, person_id: p.id, member_role: 'member'});
  });
  if (!rows.length) return ptOk([]);

  const added = [];
  for (const row of rows) {
    const r = await ptRun(() => ptSb().from('channel_members').insert(row).select(), []);
    if (r.ok) added.push(row);
    else if (!/duplicate|already exists|23505/i.test(r.error || '')) return r;
  }
  return ptOk(added);
}

async function ptMembers(channelId){
  if (!channelId) return ptErr('Pick a channel first.');
  return ptRun(() => ptSb().from('channel_members').select('*').eq('channel_id', channelId), []);
}

async function ptMessages(channelId, opts){
  if (!channelId) return ptErr('Pick a channel first.');
  const o = opts || {};
  const limit = Math.max(1, Math.min(200, Number(o.limit) || 50));
  const r = await ptRun(() => ptSb().from('channel_messages').select('*')
    .eq('channel_id', channelId).is('deleted_at', null)
    .order('created_at', {ascending:false}).limit(limit), []);
  if (!r.ok) return r;
  return ptOk((r.data || []).slice().reverse());
}

/* Write a message as the signed-in person. */
async function ptPost(channelId, body){
  if (!channelId) return ptErr('Pick a channel first.');
  const text = ptText(body, PT_BODY_MAX);
  if (!text) return ptErr('Write a message first.');
  const me = ptMe();
  if (!me.userId && !me.personId) return ptErr('Your sign-in has run out. Please sign in again.');
  return ptRun(() => ptSb().from('channel_messages').insert({
    channel_id:    channelId,
    author_user:   me.userId || null,
    author_person: me.personId || null,
    body:          text
  }).select().single(), null);
}

function ptMemberFilter(q){
  const me = ptMe();
  return me.userId ? q.eq('user_id', me.userId) : q.eq('person_id', me.personId);
}

/* Read up to here. */
async function ptMarkRead(channelId){
  if (!channelId) return ptErr('Pick a channel first.');
  const me = ptMe();
  if (!me.userId && !me.personId) return ptErr('Your sign-in has run out. Please sign in again.');
  const at = ptIso(ptNow());
  const r = await ptRun(() => ptMemberFilter(ptSb().from('channel_members')
    .update({last_read_at: at}).eq('channel_id', channelId)).select(), []);
  if (!r.ok) return r;
  return ptOk({channelId: channelId, lastReadAt: at});
}

async function ptLastRead(channelId){
  const r = await ptRun(() => ptMemberFilter(ptSb().from('channel_members')
    .select('last_read_at').eq('channel_id', channelId)).maybeSingle(), null);
  if (!r.ok) return r;
  return ptOk((r.data && r.data.last_read_at) || null);
}

/* How many messages came in after last_read_at. Your own do not count. */
async function ptUnread(channelId){
  if (!channelId) return ptErr('Pick a channel first.');
  const me = ptMe();
  if (!me.userId && !me.personId) return ptOk(0);
  const since = await ptLastRead(channelId);
  if (!since.ok) return since;
  const r = await ptRun(() => {
    let q = ptSb().from('channel_messages').select('id,author_user,author_person')
      .eq('channel_id', channelId).is('deleted_at', null);
    if (since.data) q = q.gt('created_at', since.data);
    return q;
  }, []);
  if (!r.ok) return r;
  const mine = m => (me.userId && m.author_user === me.userId) || (me.personId && m.author_person === me.personId);
  return ptOk((r.data || []).filter(m => m && !mine(m)).length);
}

/* ===================== 5. SCREENS ===================== */
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
      ${p.is_primary ? '' : `<button type="button" class="pt-link" onclick="ptSetPrimary(${ptA(clientId)},${ptA(p.id)})">Make primary</button>`}
    </li>`).join('') + `</ul>`;

  let inviteHtml;
  if (!invites.ok) inviteHtml = ptAlert(invites.error);
  else if (!invites.data.length) inviteHtml = ptEmpty('No invites yet', 'An invite makes a link to their own portal. It is shown once, for you to copy and send.');
  else inviteHtml = `<ul class="pt-list">` + invites.data.map(i => `<li class="pt-row">
      <span class="pt-name">${ptEsc(i.email || '')}${ptTag(PT_INVITE_TONE[i.state] || 'grey', i.stateWords)}</span>
      <span class="pt-sub">${ptEsc((i.portal_role === 'manager' ? 'Manager' : 'Viewer') + ' · ' + (i.state === 'accepted' ? 'joined ' + ptWhen(i.accepted_at) : 'expires ' + ptWhen(i.expires_at)))}</span>
      <span class="pt-acts">
        ${i.state === 'pending' ? `<button type="button" class="pt-link" onclick="ptRevokeInvite(${ptA(i.id)})">Revoke</button>` : ''}
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

  const rows = await ptRun(() => ptSb().from('client_requests').select('*')
    .in('status', PT_OPEN_STATUSES).order('created_at', {ascending:true}), []);
  if (!rows.ok) return `<div class="pt-wrap">${ptCard('Open requests', '', ptAlert(rows.error))}</div>`;
  if (!rows.data.length) return `<div class="pt-wrap">${ptCard('Open requests', '', ptEmpty('Nothing open', 'Every request from every client has been answered.'))}</div>`;

  const names = {};
  const clients = await ptRun(() => ptSb().from('clients').select('id,company'), []);
  if (clients.ok) (clients.data || []).forEach(c => { if (c && c.id) names[c.id] = c.company || c.id; });
  const owners = {};
  const profiles = await ptRun(() => ptSb().from('profiles').select('id,name,email'), []);
  if (profiles.ok) (profiles.data || []).forEach(p => { if (p && p.id) owners[p.id] = p.name || p.email || 'Someone'; });

  const inner = `<ul class="pt-list">` + rows.data.map(r => `<li class="pt-row">
      <span class="pt-name">${ptEsc(r.subject || 'A request')}${ptTag(r.kind === 'dispute' ? 'amber' : 'blue', r.kind || 'question')}</span>
      <span class="pt-sub">${ptEsc((names[r.client_id] || r.client_id || 'A client') + ' · ' + ptDaysOld(r.created_at) + ' · ' + (r.owner ? (owners[r.owner] || 'Someone') : 'No one yet'))}</span>
      <span class="pt-acts"><button type="button" class="pt-link" onclick="ptCloseRequest(${ptA(r.id)})">Close</button></span>
    </li>`).join('') + `</ul>`;
  return `<div class="pt-wrap">${ptCard('Open requests', 'Oldest first — the one at the top has waited longest.', inner)}</div>`;
}

/* The conversation with that client: the messages, a box to write, the unread mark. */
async function viewClientChannel(clientId){
  if (!ptCanSee(clientId)) return ptNoAccess();
  const ch = await ptChannelFor(clientId);
  if (!ch.ok) return `<div class="pt-wrap">${ptCard('The conversation', '', ptAlert(ch.error))}</div>`;
  const channelId = ch.data && ch.data.id;

  const [msgs, unread, since] = await Promise.all([ptMessages(channelId), ptUnread(channelId), ptLastRead(channelId)]);
  const cut = since.ok && since.data ? Date.parse(since.data) : NaN;
  const n = unread.ok ? Number(unread.data) || 0 : 0;

  let thread;
  if (!msgs.ok) thread = ptAlert(msgs.error);
  else if (!msgs.data.length) thread = ptEmpty('No messages yet', 'Write the first one below.');
  else {
    let marked = false;
    thread = `<div class="pt-thread">` + msgs.data.map(m => {
      const t = Date.parse(m.created_at || '');
      let div = '';
      if (!marked && n > 0 && (!Number.isFinite(cut) || (Number.isFinite(t) && t > cut))) { div = `<div class="pt-newline" role="separator"><span>New messages</span></div>`; marked = true; }
      return div + `<div class="pt-msg">
        <span class="pt-mwho">${ptEsc(m.author_person ? 'Them' : 'Aviance')}</span>
        <time>${ptEsc(ptWhen(m.created_at))}</time>
        <p>${ptEsc(m.body || '')}</p></div>`;
    }).join('') + `</div>`;
  }

  const box = `<div class="pt-form">
    <label class="pt-sr" for="ptPostBody">Your message</label>
    <textarea id="ptPostBody" rows="3" placeholder="Write to them"></textarea>
    <button type="button" class="pt-btn primary" onclick="ptPostFromForm(${ptA(channelId)})">Send</button>
  </div>`;

  const head = n > 0 ? n + (n === 1 ? ' new message' : ' new messages') : 'Everything read';
  return `<div class="pt-wrap">${ptCard('The conversation', head, thread + box)}</div>`;
}

/* ---- the screens' own handlers ----------------------------------- */

function ptEl(id){ return typeof document !== 'undefined' ? document.getElementById(id) : null; }
function ptSay(msg){ try { if (typeof toast === 'function') toast(msg); } catch (e) {} }

async function ptInviteFromForm(clientId){
  const e = ptEl('ptInviteEmail'), r = ptEl('ptInviteRole');
  const out = await ptInvite(clientId, {email: e ? e.value : '', portalRole: r ? r.value : 'viewer'});
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

async function ptPostFromForm(channelId){
  const b = ptEl('ptPostBody');
  const out = await ptPost(channelId, b ? b.value : '');
  if (!out.ok) { ptSay(out.error); return out; }
  if (b) b.value = '';
  await ptMarkRead(channelId);
  return out;
}
