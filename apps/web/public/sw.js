const CACHE = 'group-archive-v1'

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
            )
            .then(() => self.clients.claim())
    )
})

self.addEventListener('fetch', (event) => {
    const request = event.request
    if (request.method !== 'GET') return

    const url = new URL(request.url)
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request))
        return
    }

    if (url.pathname.startsWith('/assets/')) {
        event.respondWith(cacheFirst(request))
    }
})

async function networkFirst(request) {
    const cache = await caches.open(CACHE)
    try {
        const response = await fetch(request)
        if (response.ok) {
            await cache.put('/', response.clone())
        }
        return response
    } catch {
        return (await cache.match('/')) || Response.error()
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(request)
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok) {
        await cache.put(request, response.clone())
    }
    return response
}
