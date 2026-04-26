// Tiger Drywall Service Worker v2
// PURPOSE: Long-term caching for static assets on GitHub Pages, which cannot
//          set Cache-Control headers server-side (GitHub forces max-age=600).
//          This SW intercepts requests client-side and serves cached assets
//          with effectively infinite TTL after the first visit.
//
// DEPLOY TO: /Website/sw.js  (same directory as index.html)
//
// HOW IT WORKS — plain English:
//   1. INSTALL: When a visitor first loads the page, the SW installs and
//      pre-caches all listed assets into a named Cache Storage bucket.
//   2. ACTIVATE: Old SW versions (from previous deploys) are cleaned up.
//   3. FETCH: Every subsequent request is intercepted:
//      - Images → cache-first (serve from cache instantly, refresh in bg)
//      - HTML   → network-first (always try fresh, fall back to cache)
//      - Other  → pass-through (no interference)
//
// IS IT SAFE? Yes. The SW only runs on same-origin requests (your own domain).
// It never touches third-party requests. It uses the standard Cache API
// which is sandboxed per-origin. No eval(), no dynamic code execution,
// no data exfiltration. Standard pattern used by millions of production sites.
//
// UPDATING CONTENT: When you deploy new images, bump CACHE_NAME to v3, v4...
// The activate handler will delete the old cache automatically.

const CACHE_NAME = 'tigerdrywall-v2';
const BASE = self.location.pathname.replace(/\/sw\.js$/, '');

const STATIC_ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/images/logo.svg',
  BASE + '/images/drywall-repair-columbia-mo.jpg',
  BASE + '/images/plumbing-hole-before-repair.jpg',
  BASE + '/images/plumbing-hole-after-repair.jpg',
  BASE + '/images/ceiling-water-damage-before.jpg',
  BASE + '/images/ceiling-water-damage-after.jpg',
  BASE + '/images/hole-repair-drywall-patch.jpg',
  BASE + '/images/water-damage-drywall-repair.jpg',
  BASE + '/images/texture-matching-drywall.jpg',
  BASE + '/images/ceiling-repair-drywall.jpg',
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Could not cache:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', function(event) {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  const path = url.pathname;
  const isImage = /\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(path);
  const isHTML = path.endsWith('.html') || path.endsWith('/');

  if (isImage) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        const networkFetch = fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
          }
          return response;
        }).catch(() => null);
        return cached || networkFetch;
      })
    );
  } else if (isHTML) {
    event.respondWith(
      fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          caches.open(CACHE_NAME).then(c => c.put(event.request, response.clone()));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
  }
});
