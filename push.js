/* ===================== AVIANCE HUB — phone alerts (Web Push) =====================
   Every machine alert pops up on the owner's phone as a normal notification.
   iPhone/iPad: only for the hub added to the Home Screen (iOS 16.4+) and opened from there.
   Machine contract (all Supabase-bearer authed, like the rest of /api/mc/*):
     GET  /api/mc/push/key                    → {publicKey}            (503 = no keys yet)
     POST /api/mc/push/subscribe {subscription, device} → {ok, count}
     POST /api/mc/push/unsubscribe {endpoint} → {ok}
     GET  /api/mc/push/status?endpoint=…      → {subscribed, count}
     POST /api/mc/push/test {endpoint?}       → {ok, sent, failed}
   sw.js shows the notifications; tapping one opens /#trial/{id}, /#alerts or /#trials. */

const PA_SW = '/sw.js';
const pa = { checked: false, on: false, sub: null, count: null, key: null, keyStatus: 0, busy: '', error: '', note: '' };

/* VAPID public key (base64url) → the bytes pushManager.subscribe wants. */
function urlBase64ToUint8Array(s) {
  s = String(s || '').trim();
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* What this device and browser can do. Pure: pass fake navigator/window objects in tests. */
function paEnv(nav, win) {
  nav = nav || (typeof navigator !== 'undefined' ? navigator : {});
  win = win || (typeof window !== 'undefined' ? window : {});
  const ua = String(nav.userAgent || '');
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1); // iPadOS asks for desktop sites
  const ios = ipad || /iPhone|iPod/.test(ua);
  let standalone = nav.standalone === true;
  try { if (!standalone && typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) standalone = true; } catch (e) { /* no matchMedia */ }
  const notif = !!win.Notification;
  const secure = win.isSecureContext !== false;
  const supported = !!(nav.serviceWorker && win.PushManager && notif && secure);
  const device = ipad ? 'iPad' : ios ? 'iPhone' : /Android/.test(ua) ? 'Android phone' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux|CrOS/.test(ua) ? 'computer' : 'device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) || ios ? 'Safari' : 'browser';
  return { ios, standalone, supported, secure, permission: notif ? win.Notification.permission : 'unsupported', device, browser };
}
/* The name the machine keeps for this subscription, e.g. "iPhone · Safari". */
function paDeviceName(env) { env = env || paEnv(); const d = /^i(Phone|Pad)$/.test(env.device) ? env.device : env.device.charAt(0).toUpperCase() + env.device.slice(1); return d + ' · ' + env.browser; }

/* Which screen the panel shows. Pure. */
function paModeFor(env, st) {
  st = st || {};
  if (env.ios && !env.standalone) return 'install';
  if (!env.supported) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  if (st.busy === 'on') return 'busy';
  if (st.on) return 'on';
  if (!st.checked) return 'checking';
  if (st.keyStatus === 503) return 'nokeys';
  if (st.error) return 'error';
  return 'off';
}

/* ---------- the panel (pure: state → HTML) ---------- */
function renderPhoneAlerts(v) {
  v = v || {};
  const dev = esc(v.device || 'device');
  const head = `<div class="modal-head"><div class="pj-ic pa-ic">${(typeof I !== 'undefined' && I.bellRing) || ''}</div><div><h3>Phone alerts</h3><p>When something needs you, your phone shows a message, like a text.</p></div></div>`;
  const close = `<button class="btn ghost" onclick="closeModal()">Close</button>`;
  const note = v.note ? `<p class="pa-note">${esc(v.note)}</p>` : '';
  const steps = (list) => `<ol class="pa-steps">${list.map((x) => `<li><span>${x}</span></li>`).join('')}</ol>`;
  let body = '', foot = close;
  switch (v.mode) {
    case 'install':
      body = `<p class="pa-lead">First add the hub to your Home Screen. Your ${dev} only shows alerts from apps on the Home Screen.</p>
        ${steps([
          '<b>Tap the Share button</b> in Safari. It is the square with an arrow pointing up. On newer iPhones it is inside the ••• menu at the bottom.',
          '<b>Add to Home Screen</b>: scroll down the list, tap it, then tap Add.',
          '<b>Open Aviance Hub from your home screen</b> and sign in once.',
          '<b>Come back here</b> (Settings → Phone alerts) <b>and tap Turn on</b>.',
        ])}
        <p class="pa-small">Needs iOS 16.4 or later.</p>`;
      break;
    case 'unsupported':
      body = v.ios
        ? `<p class="pa-lead">This ${dev} can't show alerts from Home Screen apps yet.</p><p class="pa-small">It needs iOS 16.4 or later. Update in Settings → General → Software Update, then open Aviance Hub from your home screen again.</p>`
        : v.secure === false
          ? `<p class="pa-lead">Alerts only work on the real hub address (https://aviance.store).</p>`
          : `<p class="pa-lead">This browser can't show alerts.</p><p class="pa-small">On your iPhone: add the hub to the Home Screen and open it from there. On a computer or Android phone: use Chrome, Edge, Firefox or Safari.</p>`;
      break;
    case 'denied':
      body = `<p class="pa-lead">Alerts are blocked on this ${dev}.</p>` + (v.ios
        ? steps(['Open the <b>Settings</b> app.', 'Tap <b>Notifications</b>, then <b>Aviance</b>.', 'Turn on <b>Allow Notifications</b>.', 'Come back here and tap <b>Check again</b>.'])
        : `<p class="pa-small">Open the site settings (the icon left of the address bar), set Notifications to Allow, then tap Check again.</p>`);
      foot = `${close}<button class="btn" onclick="phoneAlertsCheck()">Check again</button>`;
      break;
    case 'checking':
      body = `<p class="pa-lead">Checking this ${dev}…</p>`;
      break;
    case 'busy':
      body = `<p class="pa-lead">Turning on… If your ${dev} asks, tap <b>Allow</b>.</p>`;
      foot = `${close}<button class="btn" disabled>Turning on…</button>`;
      break;
    case 'nokeys':
      body = `<p class="pa-lead">Phone alerts aren't switched on at our end yet.</p><p class="pa-small">There's nothing to do on this ${dev}. Your developer needs to finish one setting (the alert keys). Try again after that.</p>`;
      foot = `${close}<button class="btn" onclick="phoneAlertsCheck()">Check again</button>`;
      break;
    case 'error':
      body = `<p class="pa-lead">That didn't work.</p><p class="pa-err">${esc(v.error || 'No answer. Check your internet and try again.')}</p>`;
      foot = `${close}<button class="btn" onclick="phoneAlertsOn()">Try again</button>`;
      break;
    case 'on': {
      const others = v.count > 1 ? `<p class="pa-small">Alerts go to ${esc(v.count)} devices in total.</p>` : '';
      body = `<p class="pa-state"><span class="pill green">On for this ${dev}</span></p>${others}
        <p class="pa-small">Urgent alerts stay on screen until you tap them. Tapping an alert opens the trial it's about.</p>`;
      foot = `<button class="btn ghost" onclick="phoneAlertsOff()"${v.busy ? ' disabled' : ''}>${v.busy === 'off' ? 'Turning off…' : 'Turn off'}</button><button class="btn" onclick="phoneAlertsTest()"${v.busy ? ' disabled' : ''}>${v.busy === 'test' ? 'Sending…' : 'Send a test'}</button>`;
      break;
    }
    default: // off
      body = `<p class="pa-lead">Off on this ${dev}.</p><p class="pa-small">When you tap Turn on, your ${dev} asks to allow notifications. Tap <b>Allow</b>.</p>`;
      foot = `${close}<button class="btn" onclick="phoneAlertsOn()">Turn on phone alerts</button>`;
  }
  return `${head}<div class="modal-body pa-body" data-mode="${esc(v.mode || 'off')}">${note}${body}</div><div class="modal-foot">${foot}</div>`;
}
function paView() {
  const env = paEnv();
  return { mode: paModeFor(env, pa), device: env.device, ios: env.ios, secure: env.secure, count: pa.count, busy: pa.busy, error: pa.error, note: pa.note };
}
function paRender() {
  const p = document.getElementById('paPanel');
  if (p && document.getElementById('modalWrap').classList.contains('open')) p.innerHTML = renderPhoneAlerts(paView());
  try { renderNav(); if (currentView === 'settings') trialsRepaint('settings', { soft: true }); } catch (e) { /* signed out */ }
}
function phoneAlertsNavNote() { return pa.on ? 'On' : ''; }

/* ---------- the service worker + the machine ---------- */
let paRegP = null;
function paRegister() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return Promise.resolve(null);
  if (!paRegP) {
    paRegP = navigator.serviceWorker.register(PA_SW, { scope: '/', updateViaCache: 'none' })
      .catch((e) => { paRegP = null; pa.swError = (e && e.message) || String(e); return null; });
  }
  return paRegP;
}
async function paActiveReg() {
  const reg = await paRegister();
  if (!reg) return null;
  return reg.active ? reg : navigator.serviceWorker.ready; // subscribe needs an active worker
}
/* Reading state never registers anything: only "Turn on" does (the browser then keeps it and checks sw.js for updates itself). */
async function paExistingReg() { try { return (navigator.serviceWorker && (await navigator.serviceWorker.getRegistration('/'))) || null; } catch (e) { return null; } }
async function paSubscription() { try { const reg = await paExistingReg(); return reg && reg.pushManager ? await reg.pushManager.getSubscription() : null; } catch (e) { return null; } }
async function paKey() {
  const r = await machineFetch('/api/mc/push/key');
  pa.keyStatus = r.status;
  if (r.ok && r.data && r.data.publicKey) { pa.key = r.data.publicKey; return pa.key; }
  if (r.status !== 503) pa.error = r.ok ? "Phone alerts aren't ready at our end yet." : paPlain(r);
  return null;
}
function paSend(sub) { return machineFetch('/api/mc/push/subscribe', { body: { subscription: sub.toJSON(), device: paDeviceName() } }); }
function paPlain(r) { return r.status === 0 ? "Couldn't reach the system. Check the phone's internet and try again." : r.error || 'That did not go through.'; }
function paSameKey(sub, key) {
  try {
    const have = sub.options && sub.options.applicationServerKey; if (!have) return true;
    const a = new Uint8Array(have), b = urlBase64ToUint8Array(key);
    return a.length === b.length && a.every((x, i) => x === b[i]);
  } catch (e) { return true; }
}

/* Settings › Phone alerts / ⌘K: open the panel and look at this device's real state. */
function openPhoneAlerts() {
  try { closeSidebar(); } catch (e) { /* no sidebar */ }
  pa.error = ''; pa.note = '';
  openModal(`<div id="paPanel">${renderPhoneAlerts(paView())}</div>`);
  phoneAlertsCheck();
}
async function phoneAlertsCheck() {
  const env = paEnv();
  pa.error = ''; pa.keyStatus = 0;
  if ((env.ios && !env.standalone) || !env.supported) { pa.checked = true; paRender(); return; }
  const sub = await paSubscription();
  if (sub && env.permission === 'granted') {
    pa.sub = sub; pa.on = true;
    const r = await machineFetch('/api/mc/push/status?endpoint=' + encodeURIComponent(sub.endpoint));
    if (r.ok && r.data) {
      pa.count = r.data.count;
      if (!r.data.subscribed) { const s = await paSend(sub); if (s.ok && s.data) pa.count = s.data.count; }
    }
  } else {
    pa.on = false; pa.sub = null;
    if (env.permission !== 'denied') await paKey(); // is the machine ready? (so the tap goes straight to subscribe)
  }
  pa.checked = true; paRender();
}

/* "Turn on phone alerts" — the permission prompt must come straight from the tap. */
async function phoneAlertsOn() {
  const env = paEnv();
  if ((env.ios && !env.standalone) || !env.supported || pa.busy) return;
  let permP;
  try { permP = Promise.resolve(Notification.requestPermission()); } catch (e) { permP = Promise.resolve(Notification.permission); }
  pa.busy = 'on'; pa.error = ''; pa.note = ''; paRender();
  const perm = await permP.catch(() => Notification.permission);
  if (perm !== 'granted') {
    pa.busy = '';
    if (perm !== 'denied') pa.note = "You didn't allow notifications. Tap Turn on and choose Allow.";
    paRender(); return;
  }
  try {
    if (!pa.key && !(await paKey())) { pa.busy = ''; paRender(); return; }
    const reg = await paActiveReg();
    if (!reg || !reg.pushManager) { pa.busy = ''; pa.error = "This phone couldn't start the alert helper" + (pa.swError ? ' (' + pa.swError + ').' : '.'); paRender(); return; }
    let sub = await reg.pushManager.getSubscription();
    if (sub && !paSameKey(sub, pa.key)) { try { await sub.unsubscribe(); } catch (e) { /* replaced below */ } sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(pa.key) });
    const r = await paSend(sub);
    pa.busy = '';
    if (r.ok) { pa.on = true; pa.sub = sub; pa.count = r.data && r.data.count; toast('Phone alerts are on for this ' + env.device); }
    else if (r.status === 503) { pa.keyStatus = 503; }
    else pa.error = paPlain(r);
  } catch (e) {
    pa.busy = ''; pa.error = 'This ' + env.device + " couldn't sign up for alerts (" + ((e && e.message) || e) + ').';
  }
  paRender();
}
async function phoneAlertsOff() {
  if (pa.busy) return;
  pa.busy = 'off'; paRender();
  const sub = pa.sub || (await paSubscription());
  let err = '';
  if (sub) {
    const r = await machineFetch('/api/mc/push/unsubscribe', { body: { endpoint: sub.endpoint } });
    if (!r.ok) err = paPlain(r);
    try { await sub.unsubscribe(); } catch (e) { /* already gone */ }
  }
  Object.assign(pa, { busy: '', on: false, sub: null, count: null });
  toast(err ? 'Off on this phone.' : 'Phone alerts are off for this ' + paEnv().device);
  paRender();
}
async function phoneAlertsTest() {
  if (pa.busy) return;
  pa.busy = 'test'; paRender();
  const ep = pa.sub && pa.sub.endpoint;
  const r = await machineFetch('/api/mc/push/test', { body: ep ? { endpoint: ep } : {} });
  pa.busy = ''; paRender();
  const d = r.data || {};
  if (d.sent > 0) toast('Test sent. It should pop up in a few seconds.');
  else if (r.ok || d.failed != null) toast("The test didn't reach this phone" + (d.failed ? ' (' + d.failed + ' failed)' : '') + '. Try Turn off, then Turn on.');
  else toast('Test not sent: ' + paPlain(r));
}

/* After sign-in: if this device already has alerts on, hand the (maybe rotated) subscription to the machine again, quietly. */
async function phoneAlertsBoot() {
  const env = paEnv();
  if (!env.supported || (env.ios && !env.standalone)) return;
  const sub = await paSubscription();
  if (!sub || env.permission !== 'granted') { pa.on = false; return; }
  pa.sub = sub; pa.on = true;
  const r = await paSend(sub);
  if (r.ok && r.data) pa.count = r.data.count;
  try { renderNav(); } catch (e) { /* signed out meanwhile */ }
}

/* A tap on a notification while the hub is open: sw.js posts the hub path here. */
function paOnMessage(e) {
  const m = e && e.data;
  if (!m || m.type !== 'aviance:open') return;
  const d = parseDeepLink(String(m.url || '/#trials').replace(/^[^#]*/, '')) || { view: 'trials' };
  goDeepLink(d);
}
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', paOnMessage);
  try { navigator.serviceWorker.startMessages && navigator.serviceWorker.startMessages(); } catch (e) { /* older browsers start on load */ }
}
