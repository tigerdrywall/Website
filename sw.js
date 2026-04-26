// Tiger Drywall Service Worker v4
// PURPOSE: Long-term caching for static assets on GitHub Pages, which cannot
//          set Cache-Control headers server-side (GitHub forces max-age=600).
//          This SW intercepts requests client-side and serves cached assets
//          with effectively infinite TTL after the first visit.
//
// DEPLOY TO: /Website/sw.js  (same directory as index.html)
//
// ─────────────────────────────────────────────────────────────────────
// HOW TO BYPASS THE CACHE FOR TESTING (e.g. measuring real load speed):
// ─────────────────────────────────────────────────────────────────────
//   Option A — One-off bypass (any device, any browser):
//     Add ?nocache=1 to the URL. Example:
//       https://tigerdrywall.github.io/Website/?nocache=1
//     The SW will go straight to the network for every request on that
//     load. The cache is NOT cleared — your normal visits stay fast.
//
//   Option B — Kill the SW entirely on a device (e.g. your phone):
//     Visit:  https://tigerdrywall.github.io/Website/?killsw=1
//     This tells the SW to unregister itself and delete all caches.
//     After it runs once, refresh the page. The site now behaves like a
//     normal cache-less site on that device until the SW reinstalls
//     (which it will on the next visit without the killsw flag, unless
//     you keep using ?nocache=1).
//
//   On iPhone, private browsing does NOT prevent SW caching once the SW
//   is registered, because the SW lives in the regular profile. To do a
//   true cold-cache test on iOS:
//     1. Visit ?killsw=1 once
//     2. Settings → Safari → Clear History & Website Data
//     3. Reopen the site — first visit will be cold.
// ─────────────────────────────────────────────────────────────────────
//
// CHANGES IN v4:
//   - Added ?nocache=1 query bypass for testing
//   - Added ?killsw=1 self-uninstall flow for clean device wipes
//
// CHANGES IN v3 (preserved):
//   - FIX: response.clone() done synchronously before body consumption
//   - PERF: install pre-caches only HTML + logo (not 1MB of images)
//   - HTML: stale-while-revalidate; Images: cache-first

const CACHE_NAME = 'tigerdrywall-v4';
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

// Listen for the kill-switch from the page. When ?killsw=1 is loaded,
// the page posts this message, and the SW deletes all caches and
// unregisters itself.
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'KILLSW') {
    event.waitUntil(
      caches.keys()
        .then(function(names) { return Promise.all(names.map(function(n){ return caches.delete(n); })); })
        .then(function() { return self.registration.unregister(); })
        .then(function() {
          // Force-reload all open clients so they're no longer SW-controlled
          return self.clients.matchAll().then(function(clients) {
            clients.forEach(function(c) { c.navigate(c.url); });
          });
        })
    );
  }
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

  // BYPASS: if the navigating page has ?nocache=1, skip the cache entirely.
  // We detect this by checking the referrer URL (for sub-resources) and the
  // request URL itself (for the navigation request).
  var clientUrl;
  try {
    clientUrl = new URL(event.request.referrer || event.request.url);
  } catch (e) {
    clientUrl = url;
  }
  if (clientUrl.searchParams.has('nocache') || url.searchParams.has('nocache')) {
    // Don't call respondWith — let the browser do its default network fetch.
    return;
  }

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
