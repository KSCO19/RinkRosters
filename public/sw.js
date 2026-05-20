// RinkRosters service worker — makes the app installable + usable offline.
// Strategy: network-first for navigations (so deploys are picked up), and
// stale-while-revalidate for same-origin static assets (Vite hashes filenames,
// so cached assets never go stale incorrectly). Bump CACHE to invalidate.
const CACHE = 'rinkrosters-v1'
const SHELL = ['/', '/index.html', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/site.webmanifest']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { caches.open(CACHE).then((c) => c.put('/', res.clone())); return res })
        .catch(() => caches.match('/').then((r) => r || caches.match('/index.html')))
    )
    return
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => { caches.open(CACHE).then((c) => c.put(req, res.clone())); return res })
        .catch(() => cached)
      return cached || network
    })
  )
})
