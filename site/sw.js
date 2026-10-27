// huwa.mciut.fr no longer serves the web app (site/index.html only asks to install the app). This
// worker replaces the app's one (scripts/web-postexport.mjs) in browsers that installed it: it
// takes over at once, drops the app caches, unregisters itself and reloads the open tabs, which
// then get the site from the network.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('huwa-')) await caches.delete(k);
      await self.registration.unregister();
      for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url).catch(() => {});
    })(),
  );
});
