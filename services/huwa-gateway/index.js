#!/usr/bin/env node
// Huwa P2P gateway entry point: `node services/huwa-gateway/index.js`.
// Configuration: environment (lib/config.js, docs/server-api.md "Gateway"); tests and the spike
// harness may override with --port, --host, --bootstrap, --dht-port, --testnet N, --static dir,
// --audit dir (never in production: exposes a heap snapshot route), --lifeline.
//
// Prints one JSON line {"ready":true,"port":...} on stdout once listening; exits 0 on SIGTERM /
// SIGINT and, with --lifeline (HUWA_GATEWAY_LIFELINE=1), when its stdin closes (parent gone).
const path = require('path')
const { startGateway } = require('./lib/gateway')
const { fromEnv } = require('./lib/config')

function main() {
  const config = fromEnv()
  if (config.staticDir) config.staticDir = path.resolve(config.staticDir)
  if (config.auditDir) config.auditDir = path.resolve(config.auditDir)
  startGateway(config).then(
    (g) => {
      console.log(JSON.stringify({ ready: true, port: g.port, bootstrap: g.bootstrap, dhtPort: g.dht.port, pid: process.pid }))
      let stopping = false
      const stop = () => {
        if (stopping) return
        stopping = true
        g.close().then(
          () => process.exit(0),
          () => process.exit(1)
        )
        setTimeout(() => process.exit(0), 5000).unref()
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      if (config.lifeline) {
        process.stdin.on('end', stop)
        process.stdin.on('close', stop)
        process.stdin.resume()
      }
    },
    (err) => {
      console.error(JSON.stringify({ lvl: 'error', msg: 'gateway failed to start', error: err.message }))
      process.exit(1)
    }
  )
}

module.exports = { startGateway, main }

if (require.main === module) main()
