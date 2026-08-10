const CACHE = 'farm-tools-v14';
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
  './grain-bin-designer.html',
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

// Same-origin static files only: network-first so updates show up, cache
// fallback so the tools still open offline. Cross-origin requests (live
// market data from Supabase, etc.) are never intercepted or cached —
// caching those froze the carry monitor at stale data.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
