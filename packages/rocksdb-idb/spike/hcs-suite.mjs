// Runs hypercore-storage's own brittle suite against rocksdb-idb (fake-indexeddb), in Node.
// The npm package ships no tests: check out the matching tag first, e.g.
//   git clone --depth 1 --branch v3.3.1 https://github.com/holepunchto/hypercore-storage /tmp/hcs
//   node spike/hcs-suite.mjs /tmp/hcs          (ROCKSDB_IDB_MEMORY=1: memory only, no IndexedDB)
// migration.js is skipped: it opens an on-disk RocksDB fixture from hypercore-storage 2.x, which a
// browser never has.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.join(here, '..')
const repo = path.join(pkg, '..', '..')
const dir = process.argv[2]
if (!dir) {
  console.error('usage: node spike/hcs-suite.mjs <hypercore-storage checkout>')
  process.exit(2)
}
const files = ['atomic', 'basic', 'core', 'groups', 'snapshot', 'streams', 'tree-cache']
let failed = 0
for (const f of files) {
  const r = spawnSync('node', ['-r', path.join(pkg, 'test', 'register.cjs'), path.join('test', f + '.js')], {
    cwd: dir,
    encoding: 'utf8',
    // the app's hypercore-storage dependencies first, then brittle / test-tmp from this package
    env: { ...process.env, NODE_PATH: [path.join(repo, 'node_modules'), path.join(pkg, 'node_modules')].join(path.delimiter) }
  })
  const summary = (r.stdout.match(/# tests = .*/) || ['# no summary'])[0]
  const ok = r.status === 0 && /# ok/.test(r.stdout)
  if (!ok) failed++
  console.log((ok ? 'ok   ' : 'FAIL ') + f.padEnd(11) + summary.replace('# ', ''))
}
process.exitCode = failed ? 1 : 0
