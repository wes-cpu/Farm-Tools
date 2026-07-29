const CACHE = 'farm-tools-v2';
const FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './farm-profit-calculator.html',
  './grain-cost-of-carry-calculator.html',
  './commodity-carry-monitor.html',
  './commodity-options-analyzer.html',
  './elevator-compare.html',
  './grain-drying-calculator.html',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // cache each file independently so one missing file can't fail the install
      Promise.allSettled(FILES.map(f => c.add(f)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first, then network; newly fetched pages are cached for offline use.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => cached)
    )
  );
});
