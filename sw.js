// Service worker: cache versionado do app inteiro (shell + libs vendorizadas), pra rodar
// 100% offline depois do primeiro load, com um fluxo de atualização que não troca a versão
// no meio de uma sessão em uso (só depois que o usuário toca em "Atualizar").
const CACHE_VERSION = 'livro-de-gastos-v13';

const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/storage.js',
  './src/pdf-parser.js',
  './src/reconcile.js',
  './vendor/xlsx.full.min.js',
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // deixa passar (não intercepta CDNs externos, se houver)

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
