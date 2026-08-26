/* رادار خبر — سرویس‌ورکر */
const V = 'radar-v7';
const SHELL = ['./', './index.html', './manifest.webmanifest',
               './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* داده: اول شبکه، اگر نبود آخرین نسخه‌ی ذخیره‌شده
   صفحه و آیکن‌ها: اول کش، ولی در پس‌زمینه تازه می‌شود */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isData = url.pathname.endsWith('calendar.json') || url.pathname.endsWith('updated.json');

  if (isData || req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(r => {
          const copy = r.clone();
          caches.open(V).then(c => c.put(req, copy));
          return r;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(r => {
        const copy = r.clone();
        caches.open(V).then(c => c.put(req, copy));
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
