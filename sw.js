// Service worker network-first.
// Siempre intenta traer el código fresco del servidor; usa el caché solo como
// respaldo si no hay conexión. Elimina el problema de ver código viejo en
// GitHub Pages por el caché del navegador (cubre TODOS los módulos, presentes
// y futuros, sin listas que mantener).
const CACHE = 'estim-cache-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const sameOrigin = req.url.startsWith(self.location.origin);
  event.respondWith(
    // Para recursos propios forzamos cache:'no-store' → así el fetch ignora la
    // caché HTTP de GitHub Pages y SIEMPRE trae el código recién publicado
    // (antes, fetch normal podía servir hasta ~10 min de código viejo).
    fetch(req, sameOrigin ? { cache: 'no-store' } : undefined)
      .then((res) => {
        if (res && res.ok && sameOrigin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req)) // sin conexión → último código cacheado
  );
});
