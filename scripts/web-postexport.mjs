#!/usr/bin/env node
// Post-export step of the web build (`npm run build:web` = `expo export -p web` + this script).
// docs/WEB_DOCKER_PLAN.md D19 (PWA) and P1.
//
// 1. index.html: French, dark first paint, boot skeleton, PWA manifest, iOS home-screen tags,
//    service-worker registration (with the "Nouvelle version disponible" handshake read by
//    src/web/pwa.ts).
// 2. sw.js: a small hand-written service worker (no Workbox: one file, no dependency):
//    · precache of the app shell (index.html, JS/CSS bundles, icon font, icons, manifest),
//      versioned by a hash of their contents;
//    · hashed static files (/_expo/static/, /assets/): cache-first, they never change;
//    · navigations: the precached shell at once (SPA: instant repeat visits, works offline), the
//      network only when it is missing; a deploy ships a new worker and its shell (update prompt);
//    · posters and other cross-origin images: cache first, misses fetched with CORS and stored in
//      the background, LRU cache of ~50 MB (AniList GraphQL is POST: cached by the app itself, in
//      IndexedDB, see src/data/swr.ts);
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

// Boot skeleton: the shape of the home (shell rail + top bar from 768 px, hero, a row of cards)
// while the JS bundle downloads and starts. It only fades in after 350 ms, so a repeat visit
// (shell and bundles from the service worker) goes straight to the content without a flash; the
// app paints over it (it comes first in the DOM, at the same stacking level as the app's
// positioned views) and removes it once its first screen is ready
// (src/app/_layout.web.tsx). No sweep with prefers-reduced-motion.
const BOOT_STYLE = `
    <style id="huwa-boot-skel-css">
      #huwa-boot-skel{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:0;animation:huwa-boot-in .25s ease-out .35s forwards}
      @keyframes huwa-boot-in{to{opacity:1}}
      @keyframes huwa-boot-sweep{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
      #huwa-boot-skel .b{position:absolute;background:#0C111C;border-radius:12px;overflow:hidden}
      #huwa-boot-skel .b::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.055),rgba(255,255,255,0));animation:huwa-boot-sweep 1.4s cubic-bezier(.4,0,.2,1) infinite}
      #huwa-boot-skel .hero{left:0;right:0;top:0;height:clamp(520px,142vw,760px);border-radius:0}
      #huwa-boot-skel .rail,#huwa-boot-skel .bar{display:none}
      #huwa-boot-skel .row{position:absolute;left:16px;right:0;top:calc(clamp(520px,142vw,760px) + 72px);height:122px;display:flex;gap:16px;overflow:hidden}
      #huwa-boot-skel .row .b{position:relative;flex:0 0 216px;height:122px}
      @media (min-width:768px){
        #huwa-boot-skel .rail{display:block;left:0;top:0;bottom:0;width:84px;border-radius:0;background:#05070D}
        #huwa-boot-skel .bar{display:block;left:calc(84px + (100vw - 84px - 560px) / 2);top:10px;width:560px;max-width:calc(100vw - 340px);height:44px;border-radius:999px}
        #huwa-boot-skel .hero{left:84px;top:64px;height:clamp(380px,40vw,560px)}
        #huwa-boot-skel .row{left:132px;top:calc(64px + clamp(380px,40vw,560px) + 56px);height:148px}
        #huwa-boot-skel .row .b{flex-basis:264px;height:148px}
      }
      @media (prefers-reduced-motion:reduce){#huwa-boot-skel .b::after{animation:none;display:none}}
    </style>`;
const BOOT_HTML = `
    <div id="huwa-boot-skel" aria-hidden="true">
      <div class="b rail"></div><div class="b bar"></div><div class="b hero"></div>
      <div class="row"><div class="b"></div><div class="b"></div><div class="b"></div><div class="b"></div><div class="b"></div><div class="b"></div></div>
    </div>`;

let html = readFileSync(indexPath, 'utf8');
if (!html.includes('id="huwa-boot"')) {
  html = html
    .replace('<html lang="en">', '<html lang="fr">')
    .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />')
    .replace(/<meta httpEquiv="X-UA-Compatible"[^>]*>\s*/, '')
    .replace('</title>', `</title>${HEAD}${BOOT_STYLE}`)
    .replace('<div id="root">', `${BOOT_HTML}\n    <div id="root">`)
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
      // Navigations are answered from the shell: a preload request would be wasted.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.disable().catch(() => {});
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

// App shell first: the precached index.html answers at once (instant repeat visits, offline). It
// can only be as old as this worker, whose bundles are precached with it; a deploy installs a new
// worker with its own shell (update prompt). No cached shell (evicted): the network.
async function navigation(event) {
  const u = new URL(event.request.url);
  // A real file opened in a tab (/huwa-config.json, /p2p-worker.js…): never the shell.
  if (/\\.[a-z0-9]+$/i.test(u.pathname) && u.pathname !== '/index.html') return fetch(event.request);
  const cached = await caches.open(SHELL).then((c) => c.match('/index.html'));
  if (cached) return cached;
  try {
    return await Promise.race([fetch(event.request), timeout(8000)]);
  } catch {
    return Response.error();
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

// ---------- posters: cache first, LRU by bytes ----------
// Cross-origin images (AniList covers and banners on s4.anilist.co, add-on posters…). A hit is
// answered from the cache without touching the network. A miss is fetched with CORS (AniList's CDN
// allows it), handed to the page right away and stored in the background. Hosts without CORS are
// fetched as is and not stored (an opaque response has no size to budget), and remembered so they
// are not tried twice. The index (url → size, stored at / last used) is rebuilt from the stored
// headers when the worker wakes up; least recently used posters go once over the budget.

let index = null; // Map url -> { size, at }
let indexing = null;
const noCors = new Set();

function posterIndex(cache) {
  if (index) return Promise.resolve(index);
  if (!indexing) {
    indexing = (async () => {
      const map = new Map();
      let t = 0;
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        const at = Number(res && res.headers.get('x-huwa-at')) || t++;
        map.set(req.url, { size: Number(res && res.headers.get('x-huwa-size')) || 0, at });
      }
      index = map;
      return map;
    })();
  }
  return indexing;
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

async function storePoster(cache, url, res) {
  const blob = await res.blob();
  if (!blob.size || blob.size > 5 * 1024 * 1024) return;
  // Only what an image needs: a decoded body must not keep content-encoding / content-length.
  const headers = new Headers();
  for (const h of ['content-type', 'last-modified', 'etag']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  const now = Date.now();
  headers.set('x-huwa-size', String(blob.size));
  headers.set('x-huwa-at', String(now));
  await cache.put(url, new Response(blob, { status: 200, headers }));
  const idx = await posterIndex(cache);
  idx.set(url, { size: blob.size, at: now });
  await trimPosters(cache);
}

async function poster(event) {
  const url = event.request.url;
  const cache = await caches.open(POSTERS);
  const hit = await cache.match(url);
  if (hit) {
    const e = index && index.get(url);
    if (e) e.at = Date.now();
    return hit;
  }
  const host = new URL(url).host;
  if (noCors.has(host)) return fetch(event.request);
  let res;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  } catch {
    noCors.add(host);
    return fetch(event.request);
  }
  if (res.ok && res.type === 'cors') event.waitUntil(storePoster(cache, url, res.clone()).catch(() => {}));
  return res;
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
  if (req.destination === 'image' && (u.protocol === 'https:' || u.protocol === 'http:')) event.respondWith(poster(event));
});
`;

writeFileSync(join(dist, 'sw.js'), SW);

const size = (bytes) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`);
const total = files.reduce((n, f) => n + statSync(f).size, 0);
const precached = shell.reduce((n, u) => n + statSync(join(dist, u.slice(1))).size, 0);
console.log(`web-postexport: index.html PWA, sw.js ${version} (${shell.length} fichiers précachés, ${size(precached)}), dist ${size(total)}`);
