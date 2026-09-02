// Minimaler Service Worker: erlaubt "Zum Homescreen hinzufuegen" und cached die App-Huelle,
// damit die Tracker-Seite auch bei kurzzeitig schlechtem Netz sofort startet.
// Die Positions-Uebertragung selbst braucht natuerlich trotzdem eine aktive Verbindung.

const CACHE = 'regatta-tracker-shell-v1';
const SHELL_FILES = ['tracker.html', 'css/style.css', 'js/tracker.js', 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Nie die API/WebSocket-Aufrufe aus dem Cache bedienen - immer live.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
