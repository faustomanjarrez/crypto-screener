/* Crypto Value Screener — service worker (offline-first, actualizaciones atómicas) */
const CACHE = 'crypto-v4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './i18n.js',
  './data.js',
  './manifest.json',
  './privacidad.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  // cache:'reload' salta el caché HTTP — garantiza que la instalación
  // trae todos los archivos frescos y consistentes del servidor
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Estrategia:
// - data.js SIN query (arranque): caché primero para abrir rápido + revalidación
//   en segundo plano que actualiza la copia canónica './data.js'.
// - data.js CON query (?t=..., botón/auto-refresh): SIEMPRE red primero — nunca
//   responder con caché a una petición explícita de datos frescos. Caché solo si
//   no hay conexión.
// - Resto del app-shell: SOLO lo cacheado en la instalación. Así una versión nueva
//   de la app llega completa (nuevo sw.js → reinstalación atómica) y nunca a medias.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  const isData = url.pathname.endsWith('/data.js');

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (isData) {
        const fetched = fetch(e.request)
          .then((resp) => {
            if (resp.ok) {
              const clone = resp.clone();
              // guardar bajo la clave canónica para que el arranque offline
              // use siempre la última versión descargada
              caches.open(CACHE).then((c) => c.put('./data.js', clone));
            }
            return resp;
          })
          .catch(() => cached || caches.match('./data.js'));
        // sin query (arranque): sirve caché ya, revalida atrás
        // con query (refresh explícito): va a la red
        return cached || fetched;
      }
      return cached || fetch(e.request);
    })
  );
});
