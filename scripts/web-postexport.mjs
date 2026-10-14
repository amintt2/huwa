#!/usr/bin/env node
// Post-export step of the web build (`npm run build:web` = `expo export -p web` + this script).
// docs/WEB_DOCKER_PLAN.md D19 (PWA) and P1.
//
// 1. index.html: French, dark first paint, PWA manifest, iOS home-screen tags, service-worker
//    registration (with the "Nouvelle version disponible" handshake read by src/web/pwa.ts).
// 2. sw.js: a small hand-written service worker (no Workbox: one file, no dependency):
//    · precache of the app shell (index.html, JS/CSS bundles, icon font, icons, manifest),
//      versioned by a hash of their contents;
//    · hashed static files (/_expo/static/, /assets/): cache-first, they never change;
//    · navigations: network first (3 s), then the cached shell (SPA, works offline);
//    · posters and other cross-origin images: fetched with CORS, kept in an LRU cache of ~50 MB;
//    · /huwa-config.json, the manifest: network first, cached copy offline;
//    · the legacy site pages (/get, /privacy.html, /.well-known/…) are never touched.
//    A new version waits until the page says SKIP_WAITING (the update prompt).
//
//   node scripts/web-postexport.mjs [dist]
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`web-postexport: ${indexPath} introuvable (lancer d'abord expo export -p web)`);
  process.exit(1);
}

const BG = '#05070D';

// ---------- 1. index.html ----------

const HEAD = `
    <meta name="description" content="L’anime et le manhwa au même endroit : catalogue, calendrier des sorties, lecture avec tes extensions. Sans serveur central." />
    <meta name="theme-color" content="${BG}" />
    <meta name="color-scheme" content="dark" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Huwa" />
    <meta name="format-detection" content="telephone=no" />
    <style id="huwa-boot">html,body{background:${BG};color:#F2F5FA}</style>`;

// Registration: publishes { state, registration } on window.__huwaSW and fires `huwa:sw`.
// Service workers need a secure context (https, or localhost).
const REGISTER = `
  <script>
    (function () {
      if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
      var publish = function (state, reg) {
        window.__huwaSW = { state: state, registration: reg };
        window.dispatchEvent(new Event('huwa:sw'));
      };
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        // Only after the user chose "Recharger" (src/web/pwa.ts), never on the first install.
        if (window.__huwaSWReload) { window.__huwaSWReload = false; location.reload(); }
      });
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (reg) {
          if (reg.waiting && navigator.serviceWorker.controller) publish('update', reg);
          reg.addEventListener('updatefound', function () {
            var sw = reg.installing;
            if (!sw) return;
            sw.addEventListener('statechange', function () {
              if (sw.state === 'installed') publish(navigator.serviceWorker.controller ? 'update' : 'ready', reg);
            });
          });
          var check = function () { reg.update().catch(function () {}); };
          setInterval(check, 60 * 60 * 1000);
          document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
        }).catch(function (e) { console.warn('[huwa] service worker', e); });
      });
    })();
  </script>`;

let html = readFileSync(indexPath, 'utf8');
if (!html.includes('id="huwa-boot"')) {
  html = html
    .replace('<html lang="en">', '<html lang="fr">')
    .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />')
    .replace(/<meta httpEquiv="X-UA-Compatible"[^>]*>\s*/, '')
    .replace('</title>', `</title>${HEAD}`)
    .replace(/You need to enable JavaScript to run this app\./, 'Huwa a besoin de JavaScript.')
    .replace('</body>', `${REGISTER}\n</body>`);
  writeFileSync(indexPath, html);
}

// ---------- 2. sw.js ----------

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const url = (file) => '/' + relative(dist, file).split(sep).join('/');
const files = walk(dist);
const shell = files
  .map(url)
  .filter(
    (u) =>
      u === '/index.html' ||
      u === '/manifest.webmanifest' ||
      u === '/favicon.ico' ||
      u.startsWith('/icons/') ||
      /^\/_expo\/static\/(js|css)\/.+\.(js|css)$/.test(u) ||
      /^\/assets\/.*Ionicons\.[0-9a-f]+\.(woff2|ttf)$/.test(u),
  )
  .sort();

const hash = createHash('sha256');
for (const u of shell) hash.update(u).update(readFileSync(join(dist, u.slice(1))));
const version = hash.digest('hex').slice(0, 12);

const SW = `// Huwa service worker, generated by scripts/web-postexport.mjs. Version ${version}.
'use strict';
const VERSION = ${JSON.stringify(version)};
const SHELL = 'huwa-shell-' + VERSION;
const STATIC = 'huwa-static-v1';
const DATA = 'huwa-data-v1';
const POSTERS = 'huwa-posters-v1';
const POSTER_BUDGET = 50 * 1024 * 1024;
const PRECACHE = ${JSON.stringify(shell, null, 2)};
// Real files of the legacy site (site/nginx.conf): never answered with the app shell.
const PASSTHROUGH = /^\\/(get|privacy|terms|pack|extensions|addon|install|altstore|\\.well-known|sideload-source|altstore-source)(\\/|\\.|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, STATIC, DATA, POSTERS]);
      for (const k of await caches.keys()) if (k.startsWith('huwa-') && !keep.has(k)) await caches.delete(k);
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function navigation(event) {
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    if (preload) return preload;
    return await Promise.race([fetch(event.request), timeout(3000)]);
  } catch {
    const shell = await caches.open(SHELL);
    return (await shell.match('/index.html')) || Response.error();
  }
}

async function cacheFirst(request, name) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(name).then((c) => c.put(request, copy));
  }
  return res;
}

async function networkFirst(request, name) {
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.ok) {
      const copy = res.clone();
      caches.open(name).then((c) => c.put(request, copy));
    }
    return res;
  } catch {
    return (await caches.match(request)) || Response.error();
  }
}

// ---------- posters: LRU by bytes ----------

let index = null; // Map url -> { size, at }
async function posterIndex(cache) {
  if (index) return index;
  index = new Map();
  let t = 0;
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    index.set(req.url, { size: Number(res && res.headers.get('x-huwa-size')) || 0, at: t++ });
  }
  return index;
}

async function trimPosters(cache) {
  const idx = await posterIndex(cache);
  let total = 0;
  for (const v of idx.values()) total += v.size;
  if (total <= POSTER_BUDGET) return;
  const oldest = [...idx.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [u, v] of oldest) {
    if (total <= POSTER_BUDGET * 0.9) break;
    await cache.delete(u);
    idx.delete(u);
    total -= v.size;
  }
}

async function poster(request) {
  const cache = await caches.open(POSTERS);
  const hit = await cache.match(request.url);
  if (hit) {
    posterIndex(cache).then((idx) => {
      const e = idx.get(request.url);
      if (e) e.at = Date.now();
    });
    return hit;
  }
  let res;
  try {
    res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
  } catch {
    return fetch(request); // no CORS on that host: plain request, not cached
  }
  if (!res.ok) return res;
  const blob = await res.blob();
  if (blob.size > 0 && blob.size < 5 * 1024 * 1024) {
    const headers = new Headers(res.headers);
    headers.set('x-huwa-size', String(blob.size));
    await cache.put(request.url, new Response(blob, { status: 200, headers }));
    const idx = await posterIndex(cache);
    idx.set(request.url, { size: blob.size, at: Date.now() });
    trimPosters(cache);
  }
  return new Response(blob, { status: res.status, headers: res.headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  const same = u.origin === self.location.origin;
  if (same) {
    if (PASSTHROUGH.test(u.pathname)) return;
    if (req.mode === 'navigate') return event.respondWith(navigation(event));
    if (u.pathname.startsWith('/_expo/static/') || u.pathname.startsWith('/assets/')) return event.respondWith(cacheFirst(req, STATIC));
    if (u.pathname === '/huwa-config.json' || u.pathname === '/manifest.webmanifest') return event.respondWith(networkFirst(req, DATA));
    if (PRECACHE.includes(u.pathname)) return event.respondWith(caches.match(u.pathname).then((r) => r || fetch(req)));
    return;
  }
  if (req.destination === 'image' && (u.protocol === 'https:' || u.protocol === 'http:')) event.respondWith(poster(req));
});
`;

writeFileSync(join(dist, 'sw.js'), SW);

const size = (bytes) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`);
const total = files.reduce((n, f) => n + statSync(f).size, 0);
const precached = shell.reduce((n, u) => n + statSync(join(dist, u.slice(1))).size, 0);
console.log(`web-postexport: index.html PWA, sw.js ${version} (${shell.length} fichiers précachés, ${size(precached)}), dist ${size(total)}`);
