const CACHE_NAME = 'bandtrack-cache-v1';
const API_CACHE_NAME = 'bandtrack-api-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/Logobt.png',
  '/logobt220.png',
  '/manifest.json',
  '/offline.html'
];
const API_ENDPOINTS = [
  '/api/rehearsals',
  '/api/suggestions',
  '/api/performances',
  '/api/agenda'
];
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => ![CACHE_NAME, API_CACHE_NAME].includes(k))
          .map(k => caches.delete(k))
      )
    )
  );
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  const isApi = API_ENDPOINTS.some(ep => url.pathname.startsWith(ep));

  if (isApi) {
    if (event.request.method === 'GET') {
      event.respondWith(
        (async () => {
          const cache = await caches.open(API_CACHE_NAME);
          const cached = await cache.match(event.request);
          const fetchPromise = fetch(event.request)
            .then(resp => {
              if (resp && resp.ok) cache.put(event.request, resp.clone());
              return resp;
            })
            .catch(() => cached);
          event.waitUntil(fetchPromise);
          return cached || fetchPromise;
        })()
      );
    } else {
      event.waitUntil(caches.delete(API_CACHE_NAME));
    }
    return;
  }

  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(resp => {
      return resp || fetch(event.request).catch(() => caches.match('/offline.html'));
    })
  );
});
