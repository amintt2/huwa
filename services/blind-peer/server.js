#!/usr/bin/env node
// Huwa relay: an always-on Holepunch blind peer (library `blind-peer`) + the Huwa storage policy
// (policy.js: quota per group, expiry of forgotten cores) + an HTTP health endpoint.
//
// Configuration (environment, see .env.example):
//   STORAGE=/data                 persistent directory: RocksDB of the blind peer (its key pair
//                                 lives there: losing it changes the public key the apps know)
//   PORT=49738                    UDP port of the DHT node (open it in the firewall)
//   MAX_STORAGE_MB=20000          total budget (library GC beyond it)
//   GROUP_QUOTA_MB=50             per account / per base (policy.js)
//   MAX_IDLE_DAYS=120             cores neither requested nor replicated for that long are deleted
//   SWEEP_MINUTES=60              policy pass interval
//   REFERRER_RATE_CAPACITY=60, REFERRER_RATE_INTERVAL_MS=1000   add-cores requests per base (library)
//   TRUSTED_PEERS, PUSH_GATEWAY_KEYS   optional, comma separated z32/hex keys
//   HEALTH_PORT=8080              HTTP GET /health (keep it private: not published by compose)
//   BOOTSTRAP=host:port,...       custom DHT bootstrap (tests / private DHT)
const fs = require('fs')
const path = require('path')
const http = require('http')
const IdEnc = require('hypercore-id-encoding')
const BlindPeer = require('blind-peer')
const { HuwaPolicy } = require('./policy')

const MB = 1e6

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function int(v, def) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : def
}

function configFromEnv(env = process.env) {
  return {
    storage: env.STORAGE || './data',
    port: int(env.PORT, 49738),
    maxStorageMb: int(env.MAX_STORAGE_MB, 20000),
    groupQuotaMb: int(env.GROUP_QUOTA_MB, 50),
    maxIdleDays: int(env.MAX_IDLE_DAYS, 120),
    sweepMinutes: int(env.SWEEP_MINUTES, 60),
    referrerRate: { capacity: int(env.REFERRER_RATE_CAPACITY, 60), intervalMs: int(env.REFERRER_RATE_INTERVAL_MS, 1000) },
    trustedPeers: list(env.TRUSTED_PEERS),
    pushGatewayKeys: list(env.PUSH_GATEWAY_KEYS),
    healthPort: env.HEALTH_PORT === '' ? null : int(env.HEALTH_PORT, 8080),
    bootstrap: list(env.BOOTSTRAP).map((s) => {
      const [host, port] = s.split(':')
      return { host, port: int(port, 49737) }
    })
  }
}

function makeLogger(out = process.stdout) {
  return (level, msg, extra) => out.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }) + '\n')
}

/** Starts the relay. Returns handles for tests and for the CLI shutdown. */
async function start(config, { log = makeLogger() } = {}) {
  fs.mkdirSync(config.storage, { recursive: true })
  const bp = new BlindPeer(path.join(config.storage, 'blind-peer'), {
    maxBytes: config.maxStorageMb * MB,
    port: config.port || undefined,
    bootstrap: config.bootstrap && config.bootstrap.length ? config.bootstrap : null,
    trustedPubKeys: config.trustedPeers.map((k) => IdEnc.decode(k)),
    pushGatewayKeys: config.pushGatewayKeys.map((k) => IdEnc.decode(k)),
    perReferrerRateLimitParams: config.referrerRate && config.referrerRate.capacity ? config.referrerRate : undefined
  })
  bp.on('flush-error', (err) => log('warn', 'flush error', { err: err.message }))
  bp.on('gc-start', ({ bytesToClear }) => log('info', 'gc start', { bytesToClear }))
  bp.on('gc-done', ({ bytesCleared }) => log('info', 'gc done', { bytesCleared }))
  bp.on('per-referrer-rate-limited', (referrer) => log('info', 'rate limited', { referrer }))
  bp.on('warn', (err) => log('warn', 'warn', { err: err && err.message }))

  const policy = new HuwaPolicy(bp, {
    groupQuotaBytes: config.groupQuotaMb * MB,
    maxIdleMs: config.maxIdleDays * 24 * 3600 * 1000,
    sweepIntervalMs: config.sweepMinutes * 60 * 1000,
    log: (msg, extra) => log('info', 'policy ' + msg, typeof extra === 'object' ? extra : { detail: extra })
  })

  await bp.listen()
  policy.start()
  // First pass soon after start (restarted relays catch up on expiry and quotas).
  const first = setTimeout(() => policy.sweep().catch((err) => log('warn', 'sweep failed', { err: err.message })), 60_000)
  first.unref()

  const publicKey = IdEnc.normalize(bp.publicKey)
  try {
    fs.writeFileSync(path.join(config.storage, 'public-key.txt'), publicKey + '\n')
  } catch (err) {
    log('warn', 'could not write public-key.txt', { err: err.message })
  }

  let health = null
  if (config.healthPort !== null && config.healthPort !== undefined) {
    health = http.createServer((req, res) => {
      if (req.url !== '/health') {
        res.writeHead(404).end()
        return
      }
      const ok = bp.opened && !bp.closing
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok,
          publicKey,
          cores: bp.digest ? bp.digest.cores : 0,
          bytesAllocated: bp.digest ? bp.digest.bytesAllocated : 0,
          maxBytes: bp.maxBytes,
          connections: bp.swarm ? bp.swarm.connections.size : 0,
          policy: policy.stats
        })
      )
    })
    await new Promise((resolve) => health.listen(config.healthPort, resolve))
  }

  const address = bp.swarm.dht.localAddress()
  log('info', 'Listening', {
    publicKey,
    encryptionPublicKey: IdEnc.normalize(bp.encryptionPublicKey),
    host: address && address.host,
    port: address && address.port,
    maxBytes: bp.maxBytes,
    groupQuotaBytes: policy.groupQuotaBytes,
    maxIdleDays: config.maxIdleDays
  })

  return {
    bp,
    policy,
    publicKey,
    async close() {
      clearTimeout(first)
      if (health) await new Promise((resolve) => health.close(resolve))
      await policy.stop()
      await bp.close()
    }
  }
}

module.exports = { start, configFromEnv }

if (require.main === module) {
  const log = makeLogger()
  const config = configFromEnv()
  start(config, { log }).then(
    (relay) => {
      let stopping = false
      const stop = async (signal) => {
        if (stopping) return
        stopping = true
        log('info', 'shutting down', { signal })
        await relay.close().catch((err) => log('error', 'close failed', { err: err.message }))
        process.exit(0)
      }
      process.on('SIGTERM', () => stop('SIGTERM'))
      process.on('SIGINT', () => stop('SIGINT'))
    },
    (err) => {
      log('fatal', 'start failed', { err: err.stack || err.message })
      process.exit(1)
    }
  )
  process.on('unhandledRejection', (err) => log('error', 'unhandledRejection', { err: (err && err.stack) || String(err) }))
}
