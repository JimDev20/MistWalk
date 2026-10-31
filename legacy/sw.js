/* MistWalk service worker — caches the app shell, never your exploration data. */

const VERSION = 'mistwalk-v1.0.4';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/style.css',
  './assets/app.js',
  './assets/core.js',
  './assets/storage.js',
  './assets/fog.js',
  './assets/map-osm.js',
  './assets/map-google.js',
  './assets/fonts/archivo-latin.woff2',
  './assets/vendor/leaflet.js',
  './assets/vendor/leaflet.css',
  './assets/vendor/images/marker-icon.png',
  './assets/vendor/images/marker-icon-2x.png',
  './assets/vendor/images/marker-shadow.png',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .catch((err) => console.warn('MistWalk shell cache incomplete', err))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return response;
        })
        .catch(async () => (await caches.match('./index.html')) || Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => null);
      return cached || fresh.then((response) => response || Response.error());
    }),
  );
});
