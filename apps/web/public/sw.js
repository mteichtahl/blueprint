/* global self, fetch, URL */
/*
 * Blueprint service worker: web push (design 7.4), plus a cache of the app's
 * own built files so it opens quickly on a return visit.
 *
 * Only /assets/* is cached: Vite names those files by their content, so a
 * file never changes under the same name. The page itself, config.json and
 * every API call always go to the network, so there is still no offline mode
 * and no personal data in the cache.
 */
const ASSET_CACHE = 'bmg-assets-v1';
/** About three releases' worth of files; the oldest go first. */
const MAX_ASSETS = 180;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    self.caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith('bmg-assets-') && n !== ASSET_CACHE)
            .map((n) => self.caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(
    keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((k) => cache.delete(k)),
  );
}

async function asset(request) {
  const cache = await self.caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  const type = response.headers.get('content-type') || '';
  // Keep only a real, complete file from this site (never an error or a page).
  if (response.status === 200 && response.type === 'basic' && !type.includes('text/html')) {
    await cache.put(request, response.clone());
    await trim(cache);
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/assets/')) return;
  // If the cache itself fails (private browsing, full storage), use the network.
  event.respondWith(asset(request).catch(() => fetch(request)));
});

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'Blueprint';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || undefined,
      data: { link: data.link || '' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '';
  const url = '/' + (link ? '?go=' + encodeURIComponent(link) : '');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.postMessage({ type: 'bmg-go', link });
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
