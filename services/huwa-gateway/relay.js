#!/usr/bin/env node
// Spike S2 entry point, kept for packages/rocksdb-idb/spike/: same as index.js.
// The dht-relay workarounds that lived here are now in the fork (packages/dht-relay).
const gateway = require('./index.js')
module.exports = gateway
if (require.main === module) gateway.main()
