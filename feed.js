/* ===================== AVIANCE HUB — the live list (Clients page, under the stage strip) =====================
   Two lists, one page:
     Needs you      — everything the owner must do, each with its button right there:
                      a booked call whose time passed (Call done / No-show / Lost / Send the agreement and invoice),
                      an agreement sent (They paid / Not yet), a follow-up older than 2 days, a call to mark Won or Lost,
                      call times a client asked for, and every client row that needs him (they wrote, buy & paste, warm-up helpers…).
     Just happened  — the last 7 days, newest first: booked, call done, agreement sent, paid, reminders sent,
                      client news, alerts, and new messages in Channels.
   Pure renderers read what the hub already loaded (tk.hub, iq.list, feed.channels). feedStart() refreshes every 15 s
   while the page is visible and repaints only #feedHost. Loaded after trials.js and inquiries.js. */

const FEED_REFRESH_MS = 15000;
const FEED_WEEK_MS = 7 * 86400000;
const FEED_MAX_EVENTS = 30;
const FEED_FOLLOWUP_MS = 2 * 86400000;
const FEED_SNOOZE_MS = 86400000;
const FEED_SNOOZE_KEY = 'aviance.feed.snooze';
const feed = { channels: null, chAt: 0, chErr: null, timer: null, snooze: null, hooked: false };

function feedSnoozeMap() {
  if (feed.snooze) return feed.snooze;
  let m = {}; try { m = JSON.parse(localStorage.getItem(FEED_SNOOZE_KEY) || '{}') || {}; } catch (e) { m = {}; }
  feed.snooze = m && typeof m === 'object' ? m : {};
  return feed.snooze;
}
function feedSnoozed(id, now) { const t = Number(feedSnoozeMap()[id]); return Boolean(t) && t > (now || new Date()).getTime(); }
/* "Not yet": hide this question for a day (it comes back if they still have not paid). */
function feedNotYet(id) {
  const m = feedSnoozeMap(); m[id] = Date.now() + FEED_SNOOZE_MS;
  try { localStorage.setItem(FEED_SNOOZE_KEY, JSON.stringify(m)); } catch (e) { /* private mode */ }
  feedRepaint();
}

/* ---------- reading what the hub has ---------- */
function feedBookings(hub) {
  const full = typeof iq !== 'undefined' && iq.list;
  const list = full || (hub && hub.inquiries && hub.inquiries.latest) || [];
  return iqFixList(list).filter((q) => q && typeof q === 'object' && q.id != null);
}
function feedMs(v) { const d = tkParseDate(v); return d ? d.getTime() : 0; }
/* When the booking reached its current stage (the last stageHistory step, else statusAt). */
function feedStageAt(q) {
  const h = Array.isArray(q.stageHistory) ? q.stageHistory : [];
  const key = iqKey(q.status);
  for (let i = h.length - 1; i >= 0; i--) { if (h[i] && iqKey(h[i].to) === key && h[i].at) return h[i].at; }
  return q.statusAt || null;
}
function feedWho(q) { return String(q.company || q.name || 'Someone'); }
function feedBtn(label, onclick, main) { return { label, onclick, main: Boolean(main) }; }

/* ---------- Needs you ---------- */
function feedNeedsYou(hub, now) {
  now = now || new Date(); const items = []; const nowMs = now.getTime();
  const bookings = feedBookings(hub); const open = {};
  bookings.forEach((q) => {
    if (!iqIsOpen(q)) return;
    if (q.clientId) open[q.clientId] = true;
    const id = tkAttr(q.id); const who = feedWho(q); const st = iqKey(q.status);
    const set = (s) => `inquirySetStatus(${id},'${s}')`;
    const go = `openInquiry(${id})`;
    if (st === 'new' && iqNeedsOutcome(q, now)) {
      items.push({ key: 'call:' + q.id, at: feedMs(q.slotStart), kind: 'Call to mark', who, go, text: 'Your call with ' + who + ' was ' + iqDur((nowMs - feedMs(q.slotStart)) / 1000) + ' ago. How did it go?',
        buttons: [feedBtn('Call done', set('held'), true), feedBtn('No-show', set('no_show')), feedBtn('Send the agreement and invoice', set('agreement_sent')), feedBtn('Lost', set('lost'))] });
    } else if (st === 'held') {
      items.push({ key: 'held:' + q.id, at: feedMs(feedStageAt(q)) || feedMs(q.slotStart), kind: 'Call done', who, go, text: 'You spoke to ' + who + '. Did they say yes?',
        buttons: [feedBtn('Send the agreement and invoice', set('agreement_sent'), true), feedBtn('Following up', set('contacted')), feedBtn('Lost', set('lost'))] });
    } else if (st === 'no_show') {
      items.push({ key: 'noshow:' + q.id, at: feedMs(feedStageAt(q)) || feedMs(q.slotStart), kind: 'No-show', who, go, text: who + ' did not come to the call. Write to them.',
        buttons: [feedBtn('Following up', set('contacted'), true), feedBtn('Lost', set('lost'))] });
    } else if (st === 'agreement_sent' && !feedSnoozed('pay:' + q.id, now)) {
      items.push({ key: 'pay:' + q.id, at: feedMs(feedStageAt(q)), kind: 'Waiting to pay', who, go, text: who + ' got the agreement and invoice' + (feedStageAt(q) ? ' ' + tkRel(feedStageAt(q), now) : '') + '. Have they paid?',
        buttons: [feedBtn('They paid', set('won'), true), feedBtn('Not yet', `feedNotYet(${tkAttr('pay:' + q.id)})`)] });
    } else if (st === 'contacted' && feedStageAt(q) && nowMs - feedMs(feedStageAt(q)) > FEED_FOLLOWUP_MS) {
      items.push({ key: 'follow:' + q.id, at: feedMs(feedStageAt(q)), kind: 'Follow up', who, go, text: 'You have been following up with ' + who + ' for ' + iqDur((nowMs - feedMs(feedStageAt(q))) / 1000) + '.',
        buttons: [feedBtn('Send the agreement and invoice', set('agreement_sent'), true), feedBtn('Lost', set('lost'))] });
    }
  });
  // clients: a booking held for its call (Won / Lost), and every row that needs him
  const rows = tkListRows(hub);
  rows.forEach((r) => {
    const s = tkSimple(r); const id = tkAttr(r.id);
    const review = tkIsUnderReview(r);
    const ask = typeof calReqFor === 'function' ? calReqFor(r.id) : null;
    if (review) {
      if (open[r.id]) return;   // the same person is already above as a booking
      items.push({ key: 'app:' + r.id, at: feedMs(s.since), kind: 'Call to mark', who: s.company, go: `openTrial(${id},null,'application')`,
        text: s.company + ' booked a sales call. Read what we found, then mark it Won or Lost after the call.',
        buttons: [feedBtn('Won', `trialApproveApplication(${id})`, true), feedBtn('Lost', `openDeclineApplication(${id})`), feedBtn('What we found', `openTrial(${id},null,'application')`)] });
      return;
    }
    if (s.needsYou) {
      const first = tkTodoAsk(tkTodosSorted(r)[0], tkFirstName(s.person));
      const next = /^nothing\b/i.test(s.next) ? '' : s.next;
      const text = s.needsReply ? (tkFirstName(s.person) || 'They') + ' wrote — answer them' : (tkYouNeedTo(next || first) || 'Something here needs you. Open it to see what.');
      const t = tkTodosSorted(r).find((x) => x && x.id && tkTodoLabel(x) && !(x.action && x.action.type === 'view' && x.action.view === 'inquiry'));
      const btns = [];
      if (t && !s.needsReply) btns.push(feedBtn(tkTodoLabel(t), `trialsTodoAction(${tkAttr(t.id)})`, true));
      btns.push(feedBtn(s.needsReply ? 'Answer them' : 'Open', `openTrial(${id})`, !btns.length));
      items.push({ key: 'client:' + r.id, at: feedMs(s.since), kind: s.company, who: s.company, go: `openTrial(${id})`, text, cls: 'tk-person-you', buttons: btns });
    }
    if (ask) {   // they asked for a call time and he has not said yes
      items.push({ key: 'time:' + r.id, at: feedMs(ask.at || ask.start), kind: 'Call time', who: s.company, go: `openCalendar(${tkAttr(ask.id)})`,
        text: s.company + ' asked for a call time. Say yes in the Calendar.', buttons: [feedBtn('Open the Calendar', `openCalendar(${tkAttr(ask.id)})`, true)] });
    }
  });
  // newest first, like the old list
  return items.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/* ---------- Just happened ---------- */
const FEED_STAGE_LINE = {
  held: (w) => 'Call with ' + w + ' done', no_show: (w) => w + ' did not come to the call', contacted: (w) => 'Following up with ' + w,
  agreement_sent: (w) => 'Agreement and invoice sent to ' + w, won: (w) => w + ' paid', lost: (w) => w + ' marked Lost',
};
function feedJustHappened(hub, now) {
  now = now || new Date(); const since = now.getTime() - FEED_WEEK_MS; const ev = [];
  const add = (at, text, go, key) => { const t = feedMs(at); if (t && t >= since && t <= now.getTime() + 60000) ev.push({ at: t, text, go, key }); };
  feedBookings(hub).forEach((q) => {
    const who = feedWho(q); const go = `openInquiry(${tkAttr(q.id)})`;
    add(q.at, who + ' booked a call' + (q.slotStart ? ' for ' + iqHostShort(q.slotStart, now) : ''), go, 'book:' + q.id);
    (Array.isArray(q.stageHistory) ? q.stageHistory : []).forEach((h, i) => { const f = h && FEED_STAGE_LINE[iqKey(h.to)]; if (f) add(h.at, f(who), go, 'st:' + q.id + ':' + i); });
    if (q.reminded_tomorrow) add(q.reminded_tomorrow, 'Day-before reminder sent to ' + who, go, 'r1:' + q.id);
    if (q.reminded_soon) add(q.reminded_soon, '1-hour reminder sent to ' + who, go, 'r2:' + q.id);
    if (q.reminded_now) add(q.reminded_now, '5-minute reminder sent to ' + who, go, 'r3:' + q.id);
  });
  tkListRows(hub).forEach((r) => {
    const s = tkSimple(r); if (!s.since || tkIsUnderReview(r)) return;
    const word = { accepted: 'Won — waiting for them to book the onboarding call', call_booked: 'Onboarding call booked', setting_up: 'Setting up', warming_up: 'Warming up', sending: 'Started sending', finished: 'Finished' }[s.step];
    if (word) add(s.since, s.company + ': ' + word, `openTrial(${tkAttr(r.id)})`, 'row:' + r.id);
  });
  ((hub && hub.alerts) || []).forEach((a) => { if (a && a.at && a.title) add(a.at, ((tkFindRow(a.clientId) || {}).name ? tkFindRow(a.clientId).name + ': ' : '') + a.title, a.clientId ? `openTrial(${tkAttr(a.clientId)})` : "openSettings('alerts')", 'al:' + a.id); });
  (feed.channels || []).forEach((c) => {
    if (!c || c.archived || !c.lastMessageAt) return;
    add(c.lastMessageAt, (c.unread ? 'New message' : 'Message') + ' in ' + (c.kind === 'dm' ? '' : '#') + (c.name || 'a channel'), `feedOpenChannel(${tkAttr(c.id)})`, 'ch:' + c.id);
  });
  return ev.sort((a, b) => b.at - a.at).slice(0, FEED_MAX_EVENTS);
}
function feedOpenChannel(id) { try { location.hash = '#channels/' + encodeURIComponent(id); } catch (e) { /* no hash */ } if (typeof render === 'function') render('channels'); }

/* ---------- rendering ---------- */
function renderFeedNeeds(items) {
  if (!items.length) return `<div class="card feed-card"><b>Nothing to do</b><p class="muted">When something needs you, it shows up here with its button.</p></div>`;
  return `<ul class="feed-needs">${items.map((i) => `<li class="feed-need"><button type="button" class="feed-need-main" onclick="${i.go}"><span class="feed-kind">${esc(i.kind)}</span><span class="${i.cls || 'feed-text'}">${esc(i.text)}</span></button>
    <span class="feed-btns">${i.buttons.map((b) => `<button type="button" class="btn${b.main ? '' : ' ghost'}" onclick="${b.onclick}">${esc(b.label)}</button>`).join('')}</span></li>`).join('')}</ul>`;
}
function renderFeedEvents(events, now) {
  if (!events.length) return `<div class="card feed-card"><b>Nothing yet</b><p class="muted">Bookings, payments and messages from the last 7 days show up here.</p></div>`;
  return `<ul class="feed-events">${events.map((e) => `<li><button type="button" class="feed-event" onclick="${e.go}"><span class="feed-when" title="${esc(tkFull(new Date(e.at)))}">${esc(tkRel(new Date(e.at), now))}</span><span class="feed-text">${esc(e.text)}</span></button></li>`).join('')}</ul>`;
}
function renderFeedBody(hub, now) {
  const needs = feedNeedsYou(hub, now);
  return `<div class="section-head tk-section"><h3>Needs you</h3>${needs.length ? `<span class="count feed-count">${needs.length}</span>` : ''}</div>${renderFeedNeeds(needs)}
    <div class="section-head tk-section"><h3>Just happened</h3><span class="muted tk-small">Last 7 days</span></div>${renderFeedEvents(feedJustHappened(hub, now), now)}`;
}
function renderFeed(hub, meta) {
  meta = meta || {};
  return `<div class="feed" id="feedHost">${renderFeedBody(hub || {}, meta.now || new Date())}</div>`;
}

/* ---------- live ---------- */
async function feedLoadExtras(force) {
  const jobs = [];
  if (typeof loadInquiries === 'function') jobs.push(loadInquiries(force).catch(() => null));
  if (typeof chListChannels === 'function' && (typeof window === 'undefined' || window.sb || typeof supabase !== 'undefined')) {
    jobs.push(Promise.resolve(chListChannels()).then((r) => { const list = r && r.ok !== false ? (r.data || r) : null; if (Array.isArray(list)) { feed.channels = list; feed.chAt = Date.now(); feed.chErr = null; } }).catch((e) => { feed.chErr = e; }));
  }
  await Promise.all(jobs);
}
/* Repaint only the list — never the strip, never something the owner is in the middle of. */
function feedRepaint() {
  if (currentView !== 'paying' || !tk.hub) return false;
  const h = document.getElementById('feedHost'); if (!h) return false;
  h.innerHTML = renderFeedBody(tk.hub, new Date());
  try { renderNav(); } catch (e) { /* signed out */ }
  return true;
}
async function feedTick() {
  if (currentView !== 'paying') { feedStop(); return; }
  if (typeof document !== 'undefined' && document.hidden) return;
  if (tk.busy) return;
  try { await Promise.all([loadHub(true), feedLoadExtras(true)]); } catch (e) { return; }
  feedRepaint();
}
function feedStart() {
  if (!feed.timer) { feed.timer = setInterval(feedTick, FEED_REFRESH_MS); if (feed.timer && feed.timer.unref) feed.timer.unref(); }
  if (!feed.hooked && typeof document !== 'undefined' && document.addEventListener) {
    feed.hooked = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden && currentView === 'paying') feedTick(); });
  }
}
function feedStop() { if (feed.timer) { clearInterval(feed.timer); feed.timer = null; } }
function feedForget() { feedStop(); feed.channels = null; feed.chAt = 0; feed.chErr = null; }
