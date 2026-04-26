// Tiger Drywall Service Worker v3
// PURPOSE: Long-term caching for static assets on GitHub Pages, which cannot
//          set Cache-Control headers server-side (GitHub forces max-age=600).
//          This SW intercepts requests client-side and serves cached assets
//          with effectively infinite TTL after the first visit.
//
// DEPLOY TO: /Website/sw.js  (same directory as index.html)
//
// CHANGES IN v3:
//   - FIX: response.clone() is now done BEFORE the body is consumed (the v2
//          bug "Response body is already used" was caused by cloning inside
//          an unawaited promise that ran after `return response`).
//   - PERF: install no longer pre-caches off-screen images on first visit.
//          Pre-caching ~1MB of images during install was competing with the
//          LCP image for CPU/bandwidth on throttled mobile devices, adding
//          ~2.5s to TBT. Images now cache lazily as the user scrolls and
//          the runtime fetch handler stores them.
//   - PERF: install only seeds the document and logo (the truly critical
//          repeat-visit assets). Everything else is cached on-demand.
//
// HOW IT WORKS — plain English:
//   1. INSTALL: Pre-cache only the bare minimum (HTML + logo).
//   2. ACTIVATE: Old SW versions (from previous deploys) are cleaned up.
//   3. FETCH:
//      - Images → cache-first (instant from cache, network as fallback).
//        On network success, the response is cloned BEFORE returning so
//        the cache write doesn't race with the consumer.
//      - HTML   → stale-while-revalidate (serve cache instantly if present,
//        update cache in background). Falls back to network on cold cache.
//      - Other  → pass-through (no interference).
//
// UPDATING CONTENT: bump CACHE_NAME (v4, v5...). Old caches auto-delete.

const CACHE_NAME = 'tigerdrywall-v3';
const BASE = self.location.pathname.replace(/\/sw\.js$/, '');

// Minimal install set — only what's truly critical for repeat visits.
// All other assets are cached lazily on first request via the fetch handler.
const STATIC_ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/images/logo.svg',
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // allSettled so a single 404 doesn't abort install
      return Promise.allSettled(
        STATIC_ASSETS.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('[SW] Could not cache:', url, err);
          });
        })
      );
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) { return caches.delete(name); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

// Helper: stash a response in the cache. The clone MUST happen synchronously
// (before the response body is read by the page), so we do it up-front.
function stashInCache(request, response) {
  // Only cache successful, basic (same-origin) responses.
  if (!response || response.status !== 200 || response.type !== 'basic') return;
  var copy = response.clone();
  caches.open(CACHE_NAME).then(function(cache) { cache.put(request, copy); });
}

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  var path = url.pathname;
  var isImage = /\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(path);
  var isHTML = path.endsWith('.html') || path.endsWith('/');

  if (isImage) {
    // Cache-first for images — they don't change often, and a cache hit
    // costs ~0ms vs. ~100-500ms for network on a throttled mobile.
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        return fetch(event.request).then(function(response) {
          stashInCache(event.request, response);
          return response;
        });
      })
    );
  } else if (isHTML) {
    // Stale-while-revalidate for HTML: instant render from cache, fresh copy
    // fetched in background for the next visit.
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        var networkPromise = fetch(event.request).then(function(response) {
          stashInCache(event.request, response);
          return response;
        }).catch(function() { return cached; });
        return cached || networkPromise;
      })
    );
  }
  // For everything else, fall through to the default network fetch.
});
