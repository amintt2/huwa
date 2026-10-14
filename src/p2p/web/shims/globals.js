// Injected at the top of the worker bundle: Node globals the Holepunch stack (and pow.js) expect.
// setImmediate over MessageChannel (setTimeout(0) is clamped to 4 ms once nested).
if (typeof globalThis.setImmediate !== 'function') {
  const ch = new MessageChannel()
  const queue = []
  ch.port1.onmessage = () => {
    const fn = queue.shift()
    if (fn) fn()
  }
  // Node (tests): do not keep the process alive for this port (after onmessage, which refs it).
  if (typeof ch.port1.unref === 'function') ch.port1.unref()
  globalThis.setImmediate = (fn, ...args) => {
    queue.push(() => fn(...args))
    ch.port2.postMessage(0)
  }
  globalThis.clearImmediate = () => {}
}
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: {}, nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)), platform: 'browser', version: '', versions: {}, browser: true }
}
if (typeof globalThis.global === 'undefined') globalThis.global = globalThis
// Node's Buffer (feross/buffer): some modules call Buffer methods on b4a buffers (e.g.
// keet-identity-key's writeUInt32BE), so b4a is bundled in its Node flavour over this polyfill.
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = require('buffer').Buffer
