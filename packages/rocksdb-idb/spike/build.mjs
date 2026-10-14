// Bundles spike/worker.js for browsers with esbuild and reports its size.
// Usage: node spike/build.mjs [--no-minify]   -> spike/dist/worker.js, spike/dist/meta.json
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.join(here, '..')
const require = createRequire(path.join(pkg, 'package.json'))
const dist = path.join(here, 'dist')
const bip39Dir = path.dirname(require.resolve('bip39-mnemonic'))

// bip39-mnemonic requires './wordlist' (12 languages + lookup table, ~1 MB): English only.
const bip39English = {
  name: 'bip39-english',
  setup(b) {
    b.onResolve({ filter: /^\.\/wordlist$/ }, (args) => (args.importer.includes('bip39-mnemonic') ? { path: path.join(here, 'shims', 'bip39-wordlist.js') } : undefined))
  }
}

export async function bundle({ minify = true, slimBip39 = true } = {}) {
  fs.mkdirSync(dist, { recursive: true })
  const outfile = path.join(dist, 'worker.js')
  const result = await build({
    entryPoints: [path.join(here, 'worker.js')],
    bundle: true,
    outfile,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify,
    metafile: true,
    sourcemap: false,
    logLevel: 'warning',
    banner: { js: '/* eslint-disable */' },
    plugins: slimBip39 ? [bip39English] : [],
    inject: [path.join(here, 'shims', 'globals.js')],
    define: { 'process.env.NODE_DEBUG': 'undefined' },
    // "browser" fields first (hyperdht -> its stub, sodium-universal -> sodium-javascript).
    mainFields: ['browser', 'module', 'main'],
    conditions: ['browser'],
    alias: {
      'rocksdb-idb': pkg,
      'rocksdb-native': pkg,
      // One b4a, in its Node flavour over the Buffer polyfill installed by shims/globals.js.
      b4a: path.join(path.dirname(require.resolve('b4a')), 'index.js'),
      buffer: path.dirname(require.resolve('buffer/package.json')),
      'sodium-native': path.join(here, 'shims', 'sodium.js'),
      events: path.dirname(require.resolve('events/package.json')),
      fs: path.join(here, 'shims', 'fs.js'),
      'fs/promises': path.join(here, 'shims', 'fs.js'),
      path: path.join(here, 'shims', 'path.js'),
      os: path.join(here, 'shims', 'os.js'),
      'device-file': path.join(here, 'shims', 'device-file.js'),
      'bip39-english-wordlist': path.join(bip39Dir, 'wordlist', 'english.json')
    }
  })
  fs.writeFileSync(path.join(dist, 'meta.json'), JSON.stringify(result.metafile))
  const buf = fs.readFileSync(outfile)
  const sizes = {
    bytes: buf.byteLength,
    gzip: zlib.gzipSync(buf, { level: 9 }).byteLength,
    brotli: zlib.brotliCompressSync(buf).byteLength
  }
  // Heaviest packages, for the write-up.
  const byPkg = new Map()
  for (const [file, info] of Object.entries(result.metafile.outputs[path.relative(process.cwd(), outfile)]?.inputs || {})) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file)
    const k = m ? m[1] : file.includes('src/p2p') ? 'src/p2p (Huwa)' : file.includes('rocksdb-idb') && !file.includes('node_modules') ? 'rocksdb-idb' : 'other'
    byPkg.set(k, (byPkg.get(k) || 0) + info.bytesInOutput)
  }
  sizes.top = [...byPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, Math.round(v / 1024) + ' KiB'])
  return { outfile, sizes }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { sizes } = await bundle({ minify: !process.argv.includes('--no-minify'), slimBip39: !process.argv.includes('--all-wordlists') })
  console.log(JSON.stringify(sizes, null, 2))
}
