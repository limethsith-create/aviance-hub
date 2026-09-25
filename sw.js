/* Aviance Hub — service worker: phone alerts only.
   It shows the machine's push messages as notifications and opens the hub on a tap.
   It does NOT cache anything (no fetch handler), so the hub itself is never stale.
   Bump SW_VERSION whenever this file changes. */
const SW_VERSION = 'aviance-sw-1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/* Only hub paths ("/#trial/…", "/#alerts", "/#trials") — anything else opens the board. */
function hubUrl(url) {
  return typeof url === 'string' && url.charAt(0) === '/' && url.charAt(1) !== '/' && url.charAt(1) !== '\\' ? url : '/';
}

/* Machine payload: { title, body, url, tag, urgent, at } — plain text still shows. */
function notificationFrom(data) {
  let d = null;
  if (data) {
    try { d = data.json(); } catch (e) { d = null; }
    if (!d || typeof d !== 'object') { let t = ''; try { t = data.text(); } catch (e) { t = ''; } d = { body: t }; }
  }
  d = d || {};
  const urgent = d.urgent === true;
  const opts = {
    body: String(d.body || 'Something needs you. Open the hub to see it.'),
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    data: { url: hubUrl(d.url) },
    requireInteraction: urgent,
  };
  if (d.tag) { opts.tag = String(d.tag); opts.renotify = urgent; } // renotify without a tag is an error
  const at = d.at ? Date.parse(d.at) : NaN;
  if (!Number.isNaN(at)) opts.timestamp = at;
  return { title: String(d.title || 'Aviance Hub'), options: opts };
}

self.addEventListener('push', (event) => {
  const n = notificationFrom(event.data);
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

/* Tap: bring an open hub forward and send it to the alert's page, or open the hub there. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = hubUrl(event.notification.data && event.notification.data.url);
  const url = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hub = wins.find((w) => { try { return new URL(w.url).origin === self.location.origin; } catch (e) { return false; } });
    if (hub) {
      try { await hub.focus(); } catch (e) { /* focus can be refused; the message still lands */ }
      hub.postMessage({ type: 'aviance:open', url: path, v: SW_VERSION });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
