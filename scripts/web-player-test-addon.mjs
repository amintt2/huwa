// Local Stremio addon for testing the web player ("lecteur web") by hand:
//   node scripts/web-player-test-addon.mjs [port]      (default 7010)
// then install http://localhost:7010/manifest.json in Huwa (Profil → Extensions, or
// `xcrun simctl openurl <sim> "huwa://addon?url=http%3A%2F%2Flocalhost%3A7010%2Fmanifest.json"`).
// Every episode gets four hosted players around the Sintel trailer (Blender Foundation, CC-BY 3.0):
//   A  externalUrl → page with a <video> (bridge in the main frame)
//   B  externalUrl → page embedding A from another origin (127.0.0.1): cross-origin iframe
//   C  externalUrl → page embedding the video in a script-less, cross-origin sandboxed iframe (out of reach)
//   D  url without extension → HTML page (found by the Content-Type probe)
// The pages also try a pop-up and, after a few seconds, an ad-style redirect of the whole page.
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 7010);
const VIDEO = 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4';

const manifest = {
  id: 'huwa.test.webplayer',
  version: '1.0.0',
  name: 'Test lecteur web',
  description: 'Lecteurs hébergés de test (bande-annonce de Sintel, Blender, CC-BY).',
  resources: ['stream'],
  types: ['series', 'anime', 'movie'],
  catalogs: [],
};

const page = (body, script = '') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000;color:#ccc;font:13px -apple-system,sans-serif}
video,iframe{position:fixed;inset:0;width:100%;height:100%;border:0}
.ad{position:fixed;left:8px;top:8px;z-index:9;display:flex;gap:6px}
.ad a,.ad button{background:#e33;color:#fff;border:0;border-radius:6px;padding:4px 8px;font:12px sans-serif;text-decoration:none}</style>
</head><body>${body}
<div class="ad"><button onclick="window.open('https://example.com/?popup')">Pub (pop-up)</button><a href="https://example.org/?blank" target="_blank">Pub (lien)</a></div>
<script>${script}</script></body></html>`;

const videoTag = `<video src="${VIDEO}" controls autoplay playsinline></video>`;
// Ad-style behaviour: a pop-up at once, then the whole page sent elsewhere.
const adScript = `setTimeout(function(){ try { window.open('https://example.com/?auto'); } catch (e) {} }, 1500);
setTimeout(function(){ try { (window.top || window).location.href = 'https://example.net/?redirect'; } catch (e) {} }, 6000);`;

const players = {
  a: () => page(videoTag, adScript),
  b: () => page(`<iframe src="http://127.0.0.1:${PORT}/player/a" allow="autoplay; fullscreen" allowfullscreen></iframe>`),
  // Script-less frame of another origin: neither the page nor an injected script can reach it.
  c: () => page(`<iframe sandbox="allow-presentation" src="http://127.0.0.1:${PORT}/video" allow="autoplay; fullscreen"></iframe>`),
};

const streams = (id) => [
  { name: 'Lecteur A 1080p', title: 'Page avec <video>', externalUrl: `http://localhost:${PORT}/player/a?id=${encodeURIComponent(id)}` },
  { name: 'Lecteur B 720p', title: 'Iframe d’un autre domaine', externalUrl: `http://localhost:${PORT}/player/b?id=${encodeURIComponent(id)}` },
  { name: 'Lecteur C 480p', title: 'Vidéo hors de portée (iframe isolé)', externalUrl: `http://localhost:${PORT}/player/c?id=${encodeURIComponent(id)}` },
  { name: 'Serveur D 1080p', title: 'Lien sans extension (page HTML)', url: `http://localhost:${PORT}/watch/${encodeURIComponent(id)}` },
];

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  console.log(new Date().toISOString().slice(11, 19), req.method, url.pathname + url.search);
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (url.pathname === '/manifest.json') return send(200, 'application/json', JSON.stringify(manifest));
  const s = /^\/stream\/[^/]+\/(.+)\.json$/.exec(url.pathname);
  if (s) return send(200, 'application/json', JSON.stringify({ streams: streams(decodeURIComponent(s[1])) }));
  const p = /^\/player\/([abc])$/.exec(url.pathname);
  if (p) return send(200, 'text/html; charset=utf-8', players[p[1]]());
  if (url.pathname === '/video') return send(200, 'text/html; charset=utf-8', `<!doctype html><body style="margin:0;background:#000">${videoTag.replace('<video', '<video style="width:100%;height:100vh"')}</body>`);
  if (url.pathname.startsWith('/watch/')) return send(200, 'text/html; charset=utf-8', players.a());
  send(404, 'text/plain', 'not found');
}).listen(PORT, () => console.log(`Test addon: http://localhost:${PORT}/manifest.json`));
