/* Service worker: cache the app shell so Atlas opens with no network.
   Cache-first for the shell, and NEVER for api.anthropic.com — request and
   response bodies must not end up sitting in the Cache API. */
const VERSION = 'atlas-v1';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './app.js', './crypto.js', './store.js', './model.js',
  './routes.js', './ics.js', './tools.js', './ai.js', './ui.js',
  './icon-192.png', './apple-touch-icon.png',
  './test.html', './test.css', './selftest.js',
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
