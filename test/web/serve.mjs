// Static server for the web export, with the rules of site/nginx.conf that matter to the app:
// SPA fallback to index.html, hashed assets immutable, sw.js / index.html / manifest revalidated.
// Used by `.claude/launch.json` (built-in browser) and test/web/*.spec.ts.
//   node test/web/serve.mjs [dir=dist] [port=8130]
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Starts the server; resolves with the node http.Server. */
export function serve(dir = 'dist', port = 8130) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const rel = normalize(decodeURIComponent(url.pathname));
    let file = join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    let st;
    try {
      st = statSync(file);
      if (st.isDirectory()) {
        file = join(file, 'index.html');
        st = statSync(file);
      }
    } catch {
      // Unknown path without an extension = client-side route: SPA fallback.
      if (extname(rel)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      file = join(root, 'index.html');
      st = statSync(file);
    }
    const name = file.slice(root.length);
    const immutable = name.startsWith('/_expo/') || name.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir = 'dist', port = '8130'] = process.argv.slice(2);
  serve(dir, Number(port)).then(() => console.log(`huwa web: http://localhost:${port} (${dir})`));
}
