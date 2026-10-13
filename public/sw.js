// Network first, so a new version shows up on the next load; the cache is only the offline fallback.
const CACHE = 'haniacart-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icons/icon-192.png', '/manifest.webmanifest']))); });
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('/'))));
});

// A reminder arrives without content; the message waits on the server for this phone.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let m = null;
    try {
      const sub = await self.registration.pushManager.getSubscription();
      const r = await fetch('/api/push/msg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub && sub.endpoint }) });
      m = r.ok ? await r.json() : null;
    } catch { m = null; }
    if (!m || !m.title) m = { title: 'HaniaCart', body: 'יש עדכון במלאי של הבית.', url: '/' };
    await self.registration.showNotification(m.title, { body: m.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', lang: 'he', dir: 'rtl', data: { url: m.url || '/' } });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    for (const w of ws) if (w.url.startsWith(self.location.origin) && 'focus' in w) return w.navigate(url).then((x) => (x || w).focus());
    return self.clients.openWindow(url);
  }));
});
