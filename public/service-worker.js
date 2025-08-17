// Service worker for BandTrack PWA
// Cache assets for offline use and provide a fallback page when offline.

const CACHE_NAME = 'bandtrack-cache-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/abstract-bg.png',
  '/avatar.png',
  '/offline.html'
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
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    )
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/offline.html'))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(resp => {
      return resp || fetch(event.request).catch(() => caches.match('/offline.html'));
    })
  );
});