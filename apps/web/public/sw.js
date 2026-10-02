const CACHE = 'group-archive-v2'

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

    // A hard reload already fetches this URL outside the worker and writes the
    // HTTP cache. Handling it here too makes Chrome wait 20s on that cache lock.
    if (request.mode === 'navigate' && request.cache === 'reload') return

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(event))
        return
    }

    if (url.pathname.startsWith('/assets/')) {
        event.respondWith(cacheFirst(request))
    }
})

async function networkFirst(event) {
    const cache = await caches.open(CACHE)
    try {
        // A new no-store request, not event.request. Reusing the navigation
        // request joins its HTTP cache entry and deadlocks a hard reload.
        const response = await fetch(event.request.url, {
            cache: 'no-store',
            credentials: 'same-origin',
            redirect: 'follow',
        })
        if (response.ok) event.waitUntil(cache.put('/', response.clone()))
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
