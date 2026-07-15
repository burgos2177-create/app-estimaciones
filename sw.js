// Service worker network-first, a prueba de señal intermitente.
// Intenta traer código fresco de la red; si la red falla (típico en obra),
// cae al caché; si es una navegación sin caché, sirve el shell para que la app
// igual arranque. NUNCA devuelve vacío → nunca el error "Load failed" en blanco.
const CACHE = 'estim-cache-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Limpia cachés viejas y toma control de las pestañas abiertas.
  for (const k of await caches.keys()) { if (k !== CACHE) await caches.delete(k); }
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const sameOrigin = req.url.startsWith(self.location.origin);
  event.respondWith((async () => {
    try {
      const res = await fetch(req);            // network-first (con caché HTTP como respaldo natural)
      if (res && res.ok && sameOrigin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (e) {
      // Red caída o señal intermitente → servir de caché.
      const cached = await caches.match(req);
      if (cached) return cached;
      // Navegación sin caché → servir el shell para que la SPA arranque igual.
      if (req.mode === 'navigate') {
        const shell = (await caches.match('./index.html')) || (await caches.match('index.html')) || (await caches.match('./'));
        if (shell) return shell;
      }
      // Último recurso: una respuesta válida (nunca undefined → nunca pantalla en blanco).
      return new Response('Sin conexión. Reintenta cuando tengas señal.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
