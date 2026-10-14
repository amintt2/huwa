// Minimal posix `path` for the browser bundle (hypercore-storage joins names, nothing else).
function normalize(p) {
  const abs = p.startsWith('/')
  const out = []
  for (const s of p.split('/')) {
    if (!s || s === '.') continue
    if (s === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
    } else out.push(s)
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.')
}
const join = (...parts) => normalize(parts.filter(Boolean).join('/'))
const dirname = (p) => {
  const n = normalize(p)
  const i = n.lastIndexOf('/')
  return i <= 0 ? (i === 0 ? '/' : '.') : n.slice(0, i)
}
const basename = (p) => normalize(p).split('/').pop()
module.exports = { sep: '/', join, normalize, dirname, basename, resolve: (...p) => join('/', ...p), posix: null }
module.exports.posix = module.exports
