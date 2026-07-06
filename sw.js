const CACHE_NAME = 'litalk-admin-cache-v2';
const DYNAMIC_CACHE_NAME = 'litalk-admin-dynamic-v2';

// Assets to precache immediately on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/booking.html',
  '/404.html',
  '/manifest.json',
  '/img/LITALK-Black.png',
  '/img/LITALK-White.png',
  '/img/icon-192.png',
  '/img/icon-512.png',
  '/img/icon-192-maskable.png'
];

// Install event - Precache core shell assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] Pre-caching offline page shell');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - Clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME && key !== DYNAMIC_CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - Serve from cache, fall back to network, or fetch and cache dynamically
self.addEventListener('fetch', event => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);

  // Skip browser extensions and non-HTTP protocols
  if (!requestUrl.protocol.startsWith('http')) return;

  // Skip Auth0 requests (auth0-spa-js handles token exchanges, logs, etc.)
  if (requestUrl.hostname.includes('auth0.com') || requestUrl.pathname.includes('/oauth/')) {
    return;
  }

  const acceptHeader = event.request.headers.get('accept') || '';

  // 1. Pages (HTML): Network-First (we want the latest admin dashboard data, but offline fallback)
  if (acceptHeader.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // If response is valid, cache it
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // If network fails, try cache
          return caches.match(event.request)
            .then(cachedResponse => {
              if (cachedResponse) {
                return cachedResponse;
              }
              // If request is for a route we haven't cached, try fallback to root
              if (requestUrl.pathname === '/' || requestUrl.pathname.endsWith('index') || requestUrl.pathname.endsWith('index.html')) {
                return caches.match('/index.html');
              }
              if (requestUrl.pathname.endsWith('booking') || requestUrl.pathname.endsWith('booking.html')) {
                return caches.match('/booking.html');
              }
              return caches.match('/404.html');
            });
        })
    );
    return;
  }

  // 2. Static Assets (fonts, images, CSS, libraries): Cache-First, then network and cache
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(event.request).then(response => {
          // Don't cache invalid responses
          if (!response || response.status !== 200) {
            return response;
          }

          // Cache local assets and key external CDNs
          const isLocal = requestUrl.origin === self.location.origin;
          const isCDN = requestUrl.hostname.includes('cdnjs.cloudflare.com') ||
                        requestUrl.hostname.includes('fonts.googleapis.com') ||
                        requestUrl.hostname.includes('fonts.gstatic.com') ||
                        requestUrl.hostname.includes('cdn.jsdelivr.net') ||
                        requestUrl.hostname.includes('cdn.auth0.com');

          if (isLocal || isCDN) {
            const responseClone = response.clone();
            caches.open(DYNAMIC_CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        }).catch(() => {
          // Offline fallback for images
          if (event.request.destination === 'image') {
            return caches.match('/img/LITALK-White.png') || caches.match('/img/LITALK-Black.png');
          }
        });
      })
  );
});
