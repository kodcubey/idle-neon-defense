/* Minimal Service Worker to enable installability (PWA). */
const CACHE = 'neon-grid-pwa-v4'

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll([
          '/',
          '/index.html',
          '/game',
          '/game/',
          '/game/index.html',
          '/manifest.webmanifest',
          '/manifest.json',
          '/favicon.svg',
          '/icons/icon-192.png',
          '/icons/icon-512.png',
        ])
      )
      .catch(() => {})
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.resolve()
      .then(() => caches.keys())
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (!req || req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Navigations: network-first, fallback to cached shell.
  if (req.mode === 'navigate') {
    const fallback = url.pathname.startsWith('/game') ? '/game/index.html' : '/index.html'
    event.respondWith(fetch(req).catch(() => caches.match(fallback)))
    return
  }

  // Assets: cache-first, then network.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached
      return fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {})
          return res
        })
        .catch(() => cached)
    })
  )
})
