// Gateway configuration: environment variables (docs/server-api.md, "Gateway"), overridable from
// the command line for tests and the spike harness (--port, --host, --testnet N, --static dir,
// --audit dir, --bootstrap host:port,...).

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8081,
  publicUrl: null,
  allowedOrigins: ['self', 'https://huwa.mciut.fr'],
  maxWs: 200,
  wsPerIp: 8,
  wsBytesPerSec: 2 * 1024 * 1024,
  wsIdleMs: 90_000,
  wsMaxConnections: 64,
  wsMaxQueries: 32,
  wsMutablePerMinute: 60,
  // 0 = random. HUWA_DHT_PORT belongs to the blind-peer relay (docs/server-api.md §14).
  dhtPort: 0,
  dhtHost: '0.0.0.0',
  bootstrap: null,
  rendezvousTtlMs: 120_000,
  rendezvousFrameBytes: 8192,
  rendezvousFramesPerTopic: 8,
  rendezvousMaxTopics: 4096,
  rendezvousPostsPerMinute: 30,
  rendezvousMaxWaitMs: 30_000,
  log: 'info',
  testnet: 0,
  staticDir: null,
  auditDir: null,
  lifeline: false
}

function int(v, def) {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def
}

function list(v, def) {
  if (v === undefined || v === null || v === '') return def
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function parseBootstrap(items) {
  if (!items) return null
  return items.map((s) => {
    const i = s.lastIndexOf(':')
    if (i <= 0) throw new Error('HUWA_BOOTSTRAP: host:port expected, got ' + s)
    return { host: s.slice(0, i), port: Number(s.slice(i + 1)) }
  })
}

function fromEnv(env = process.env, argv = process.argv.slice(2)) {
  const arg = (name) => {
    const i = argv.indexOf('--' + name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const c = { ...DEFAULTS }
  c.host = arg('host') || env.HUWA_GATEWAY_HOST || c.host
  c.port = int(arg('port') ?? env.HUWA_GATEWAY_PORT, c.port)
  c.publicUrl = env.HUWA_PUBLIC_URL || null
  c.allowedOrigins = list(env.HUWA_ALLOWED_ORIGINS, c.allowedOrigins)
  c.maxWs = int(env.HUWA_MAX_WS, c.maxWs)
  c.wsPerIp = int(env.HUWA_WS_PER_IP, c.wsPerIp)
  c.wsBytesPerSec = int(env.HUWA_WS_BYTES_PER_SEC, c.wsBytesPerSec)
  c.wsIdleMs = int(env.HUWA_WS_IDLE_MS, c.wsIdleMs)
  c.wsMaxConnections = int(env.HUWA_WS_MAX_PEERS, c.wsMaxConnections)
  c.wsMaxQueries = int(env.HUWA_WS_MAX_QUERIES, c.wsMaxQueries)
  c.dhtPort = int(arg('dht-port') ?? env.HUWA_GATEWAY_DHT_PORT, c.dhtPort)
  c.dhtHost = env.HUWA_DHT_HOST || c.dhtHost
  c.bootstrap = parseBootstrap(list(arg('bootstrap') ?? env.HUWA_BOOTSTRAP, null))
  c.rendezvousTtlMs = int(env.HUWA_RENDEZVOUS_TTL_MS, c.rendezvousTtlMs)
  c.rendezvousMaxTopics = int(env.HUWA_RENDEZVOUS_MAX_TOPICS, c.rendezvousMaxTopics)
  c.log = env.HUWA_LOG || c.log
  c.testnet = int(arg('testnet'), 0)
  c.staticDir = arg('static') || null
  c.auditDir = arg('audit') || env.HUWA_GATEWAY_AUDIT_DIR || null
  c.lifeline = argv.includes('--lifeline') || env.HUWA_GATEWAY_LIFELINE === '1'
  return c
}

module.exports = { DEFAULTS, fromEnv, parseBootstrap }
