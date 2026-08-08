const CACHE = 'pm-v2.2.1';
const SHELL = ['/', '/index.html', '/favicon.svg', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  // Never intercept WebSocket upgrades, API calls, or cross-origin requests
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/audio/')) return;

  // Network-first for navigation (always get fresh HTML)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, images)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push notifications ────────────────────────────────────────────────────────

self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { return; }

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const isTest = data.tag === 'pm-test';

      // For normal messages: skip push if the app is currently visible in any window
      // — the in-page WebSocket notification will handle it, avoiding duplicates on PC.
      // Use visibilityState so minimised/background tabs still receive the push.
      // Always show test pushes so the user can confirm push works on each device.
      if (!isTest && clients.some(c => c.visibilityState === 'visible')) return;

      return self.registration.showNotification(data.title || 'PagerMonitor', {
        body:     data.body  || '',
        icon:     '/icon-192.png',
        badge:    '/badge-96.png',
        tag:      data.tag   || 'pm-message',
        renotify: true,   // always ring/vibrate even if same capcode replaces previous notification
        data:     data.data  || {},
        silent:   false,
      });
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.startsWith(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    })
  );
});
