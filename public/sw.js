// JamLock Production Service Worker (App Shell & Cold-Start Accelerator)
const CACHE_NAME = 'jamlock-v17';
const PRECACHE_ASSETS = [
  '/',
  '/style.css?v=2.4',
  '/app.js?v=2.4',
  '/logo.webp',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Resilient precaching: fetch all assets, never reject install on one missing optional item
      await Promise.allSettled(
        PRECACHE_ASSETS.map((asset) => cache.add(asset).catch((err) => console.warn('[SW] Precache skip:', asset, err)))
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Network-Only Bypass for Realtime & Dynamic API Endpoints
  if (
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/r/') // Per-room URLs handled with dynamic network fallback below
  ) {
    if (url.pathname.startsWith('/r/')) {
      // For /r/:roomId navigations, try network with 3s timeout, then fall back to cached shell
      event.respondWith(
        fetch(req).catch(() => caches.match('/'))
      );
    }
    return;
  }

  // Navigation Requests: Network-First with quick Cache Fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/'))
    );
    return;
  }

  // Static Assets: Stale-While-Revalidate
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => null);

      return cachedResponse || fetchPromise;
    })
  );
});
