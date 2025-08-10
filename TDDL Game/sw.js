const CACHE_NAME = 'doom-game-v1.0.0';
const urlsToCache = [
    './',
    './doom-game-improved.html',
    './styles.css',
    './constants.js',
    './classes.js',
    './game-engine.js',
    './mobile-controls.js',
    './error-handler.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(urlsToCache))
            .catch((error) => console.error('Cache installation failed:', error))
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                // Return cached version or fetch from network
                return response || fetch(event.request);
            })
            .catch((error) => {
                console.error('Fetch failed:', error);
                // Return a fallback response if needed
            })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});