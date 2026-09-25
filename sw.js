const CACHE = 'soundstitch-v2026.09.25.1';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './audio-core.mjs', './manifest.webmanifest',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('soundstitch-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok && (event.request.destination === 'document' || SHELL.some(p => url.pathname.endsWith(p.replace('./',''))))) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
      }
      return response;
    } catch (error) {
      if (event.request.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
      throw error;
    }
  })());
});
