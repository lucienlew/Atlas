/* Service worker: cache the app shell so Atlas opens with no network.
   Cache-first for the shell, and NEVER for api.anthropic.com — request and
   response bodies must not end up sitting in the Cache API. */
const VERSION = 'atlas-v2';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/app.js', './js/crypto.js', './js/store.js', './js/model.js',
  './js/routes.js', './js/ics.js', './js/tools.js', './js/ai.js', './js/ui.js',
  './icons/icon-192.png', './icons/apple-touch-icon.png',
  './test.html', './test.css', './js/selftest.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)
    .then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    })
    .catch(() => caches.match('./index.html'))));
});
