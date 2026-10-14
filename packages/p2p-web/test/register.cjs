// Lets src/p2p/web/** resolve the browser-only packages installed here (sodium-javascript,
// blake2b-wasm, buffer, events), as the esbuild bundle does with `nodePaths`.
const path = require('path')
const Module = require('module')
process.env.NODE_PATH = [path.join(__dirname, '..', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
Module._initPaths()
