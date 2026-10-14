// Browser stand-in for `fs`: there is no file system, every path is missing. hypercore-storage only
// touches files for legacy migrations / crash recovery markers, which never exist in IndexedDB.
function enoent(p) {
  const err = new Error('ENOENT: no such file or directory, ' + p)
  err.code = 'ENOENT'
  return err
}
const reject = (p) => Promise.reject(enoent(p))

module.exports = {
  existsSync: () => false,
  readdirSync: () => [],
  statSync: (p) => {
    throw enoent(p)
  },
  mkdirSync: () => {},
  renameSync: () => {},
  writeFileSync: () => {},
  unlinkSync: () => {},
  readFile: (p, cb) => queueMicrotask(() => cb(enoent(p))),
  open: (p, flags, cb) => queueMicrotask(() => cb(enoent(p))),
  createReadStream: (p) => {
    throw enoent(p)
  },
  promises: { stat: reject, readdir: reject, readFile: reject, rm: reject, rmdir: reject, unlink: reject, mkdir: reject }
}
